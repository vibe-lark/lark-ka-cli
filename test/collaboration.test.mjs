import test from "node:test";
import assert from "node:assert/strict";
import {
  executeCollaboration,
  commandSpecs,
  services,
} from "../src/domains/collaboration.mjs";
import {
  mkdtemp,
  writeFile,
  readFile,
  access,
  rm,
  open,
  rmdir,
} from "node:fs/promises";
import path from "node:path";

function context(handler = () => ({}), options = {}) {
  const calls = [];
  return {
    calls,
    config: {
      openBaseUrl: "https://open.example.invalid",
      userOpenId: "ou_me",
    },
    identity: "user",
    dryRun: false,
    input: async (v) => v,
    request: async (method, apiPath, opts = {}) => {
      const call = { method, path: apiPath, ...opts };
      calls.push(call);
      return handler(call, calls.length);
    },
    multipart: async (method, apiPath, opts = {}) => {
      const call = { method, path: apiPath, multipart: opts };
      calls.push(call);
      return handler(call, calls.length);
    },
    ...options,
  };
}
const run = (ctx, service, command, flags = {}) =>
  executeCollaboration(ctx, service, `+${command}`, flags);

test("all seven collaboration domains and 65 shortcut commands have explicit handlers", () => {
  assert.equal(services.length, 7);
  assert.equal(Object.keys(commandSpecs).length, 65);
});

test("unrecognized commands are delegated without network requests", async () => {
  const ctx = context();
  assert.equal(await run(ctx, "calendar", "not-a-command"), undefined);
  assert.equal(ctx.calls.length, 0);
});

test("calendar create creates event then invites current user and typed attendees", async () => {
  const ctx = context((call) =>
    call.path.endsWith("/events") ? { event: { event_id: "event/one" } } : {},
  );
  await run(ctx, "calendar", "create", {
    summary: "Meeting",
    start: "2026-11-09T12:00:00+08:00",
    end: "2026-11-09T13:00:00+08:00",
    "attendee-ids": "ou_alice,oc_chat,omm_room",
  });
  assert.equal(ctx.calls.length, 2);
  assert.equal(
    ctx.calls[0].path,
    "/open-apis/calendar/v4/calendars/primary/events",
  );
  assert.equal(ctx.calls[0].body.start_time.timestamp, "1794196800");
  assert.ok(ctx.calls[1].path.includes("/event%2Fone/attendees"));
  assert.deepEqual(ctx.calls[1].body.attendees, [
    { type: "user", user_id: "ou_alice" },
    { type: "chat", chat_id: "oc_chat" },
    { type: "resource", room_id: "omm_room" },
    { type: "user", user_id: "ou_me" },
  ]);
});

test("calendar rejects invalid time and attendee changes before any write", async () => {
  const ctx = context();
  await assert.rejects(
    run(ctx, "calendar", "create", {
      start: "2026-11-09T13:00Z",
      end: "2026-11-09T12:00Z",
    }),
    /after/,
  );
  await assert.rejects(
    run(ctx, "calendar", "create", {
      start: "2026-11-09T12:00Z",
      end: "2026-11-09T13:00Z",
      "attendee-ids": "wrong",
    }),
    /Invalid attendee/,
  );
  assert.equal(ctx.calls.length, 0);
});

test("calendar update performs patch, remove, and add in order", async () => {
  const ctx = context();
  await run(ctx, "calendar", "update", {
    "event-id": "event1",
    summary: "Changed",
    "remove-attendee-ids": "ou_old",
    "add-attendee-ids": "ou_new",
    notify: false,
  });
  assert.deepEqual(
    ctx.calls.map((c) => c.method),
    ["PATCH", "POST", "POST"],
  );
  assert.deepEqual(ctx.calls[1].body, {
    delete_ids: [{ type: "user", user_id: "ou_old" }],
    need_notification: false,
  });
});

test("room search issues one request per slot and splits user and chat attendees", async () => {
  const ctx = context(() => ({ available_rooms: [{ room_id: "omm_1" }] }));
  const result = await run(ctx, "calendar", "room-find", {
    slot: [
      "2026-11-09T12:00Z~2026-11-09T13:00Z",
      "2026-11-10T12:00Z~2026-11-10T13:00Z",
    ],
    city: "Beijing",
    "attendee-ids": "ou_a,oc_b",
  });
  assert.equal(ctx.calls.length, 2);
  assert.deepEqual(ctx.calls[0].body.attendee_chat_ids, ["oc_b"]);
  assert.equal(result.time_slots.length, 2);
});

test("task create merges JSON with explicit flags and converts relative IDs", async () => {
  const ctx = context(() => ({
    task: { guid: "t1", url: "https://example.invalid/t1" },
  }));
  const result = await run(ctx, "task", "create", {
    data: '{"summary":"old","description":"detail"}',
    summary: "new",
    assignee: "cli_app",
    follower: "ou_a",
    "tasklist-id": "https://example.invalid/tasklist?guid=list1",
    due: "2026-11-10",
  });
  assert.equal(result.guid, "t1");
  assert.equal(ctx.calls[0].body.summary, "new");
  assert.deepEqual(ctx.calls[0].body.members, [
    { id: "cli_app", role: "assignee", type: "app" },
    { id: "ou_a", role: "follower", type: "user" },
  ]);
  assert.deepEqual(ctx.calls[0].body.tasklists, [{ tasklist_guid: "list1" }]);
  assert.equal(ctx.calls[0].body.due.is_all_day, true);
});

test("task completion is idempotent and does not patch an already completed task", async () => {
  const ctx = context(() => ({
    task: { guid: "t1", completed_at: "1790000000000" },
  }));
  await run(ctx, "task", "complete", { "task-id": "t1" });
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].method, "GET");
});

test("task reminder replacement removes existing reminder before adding", async () => {
  const ctx = context((call) =>
    call.method === "GET" ? { task: { reminders: [{ id: "r1" }] } } : {},
  );
  await run(ctx, "task", "reminder", { "task-id": "t1", set: "2h" });
  assert.equal(ctx.calls.length, 3);
  assert.deepEqual(ctx.calls[1].body, { reminder_ids: ["r1"] });
  assert.deepEqual(ctx.calls[2].body, {
    reminders: [{ relative_fire_minute: 120 }],
  });
});

test("tasklist validates task JSON before creating remote tasklist", async () => {
  const ctx = context();
  await assert.rejects(
    run(ctx, "task", "tasklist-create", { name: "List", data: "{}" }),
    /array/,
  );
  assert.equal(ctx.calls.length, 0);
});

test("tasklist exact member replacement computes additions and removals", async () => {
  const ctx = context((call) =>
    call.method === "GET"
      ? { tasklist: { members: [{ id: "ou_keep" }, { id: "ou_old" }] } }
      : {},
  );
  await run(ctx, "task", "tasklist-members", {
    "tasklist-id": "l1",
    set: "ou_keep,ou_new",
  });
  assert.equal(ctx.calls.length, 3);
  assert.deepEqual(
    ctx.calls[1].body.members.map((x) => x.id),
    ["ou_new"],
  );
  assert.deepEqual(
    ctx.calls[2].body.members.map((x) => x.id),
    ["ou_old"],
  );
});

test("task pagination rejects repeated cursors", async () => {
  const ctx = context(() => ({
    items: [],
    has_more: true,
    page_token: "same",
  }));
  await assert.rejects(
    run(ctx, "task", "get-my-tasks", {}),
    /repeated pagination/,
  );
  assert.equal(ctx.calls.length, 2);
});

test("OKR create translates rich content into v1 wire fields", async () => {
  const ctx = context();
  await run(ctx, "okr", "progress-create", {
    content: JSON.stringify({
      blocks: [
        {
          block_element_type: "paragraph",
          paragraph: {
            elements: [
              {
                paragraph_element_type: "mention",
                mention: { user_id: "ou_a" },
              },
              { text_run: { text: "Done", style: { strike_through: true } } },
            ],
          },
        },
      ],
    }),
    "target-id": "9007199254740993",
    "target-type": "objective",
    "progress-percent": "50",
    "progress-status": "normal",
  });
  assert.equal(ctx.calls[0].body.target_id, "9007199254740993");
  assert.equal(ctx.calls[0].body.target_type, 2);
  assert.deepEqual(ctx.calls[0].body.content.blocks[0].paragraph.elements[0], {
    type: "person",
    person: { openId: "ou_a" },
  });
  assert.equal(
    ctx.calls[0].body.content.blocks[0].paragraph.elements[1].textRun.style
      .strikeThrough,
    true,
  );
});

test("OKR rejects out-of-range numeric IDs without losing int64 precision", async () => {
  const ctx = context();
  await assert.rejects(
    run(ctx, "okr", "progress-get", { "progress-id": "9223372036854775808" }),
    /positive int64/,
  );
  assert.equal(ctx.calls.length, 0);
});

test("meeting bot joins with documented join_identify structure", async () => {
  const ctx = context();
  await run(ctx, "vc", "meeting-join", {
    "meeting-number": "123456789",
    password: "pw",
    "call-id": "call1",
  });
  assert.deepEqual(ctx.calls[0].body, {
    join_type: 1,
    join_identify: { meeting_no: "123456789" },
    password: "pw",
    call_id: "call1",
  });
  await assert.rejects(
    run(ctx, "vc", "meeting-join", { "meeting-number": "123" }),
    /9 digits/,
  );
});

test("meeting search places range under meeting_filter.start_time", async () => {
  const ctx = context();
  await run(ctx, "vc", "search", {
    query: "Review",
    start: "2026-11-01T00:00Z",
    end: "2026-11-02T00:00Z",
    "organizer-ids": "ou_a",
  });
  assert.equal(
    ctx.calls[0].body.meeting_filter.start_time.start_time,
    "2026-11-01T00:00:00.000Z",
  );
  assert.deepEqual(ctx.calls[0].body.meeting_filter.organizer_ids, ["ou_a"]);
});

test("minutes speaker replacement escapes token and validates distinct users", async () => {
  const ctx = context();
  await run(ctx, "minutes", "speaker-replace", {
    "minute-token": "m/1",
    "from-user-id": "ou_a",
    "to-user-id": "ou_b",
  });
  assert.equal(
    ctx.calls[0].path,
    "/open-apis/minutes/v1/minutes/m%2F1/transcript/speaker",
  );
  assert.equal(ctx.calls[0].method, "PUT");
});

test("contact user lookup uses basic_batch for user and detailed GET for bot", async () => {
  const user = context(() => ({ users: [{ name: "Alice" }] }));
  assert.deepEqual(
    await run(user, "contact", "get-user", { "user-id": "ou_a" }),
    { user: { name: "Alice" } },
  );
  assert.equal(user.calls[0].method, "POST");
  const bot = context(() => ({}), { identity: "bot" });
  await run(bot, "contact", "get-user", { "user-id": "ou/a" });
  assert.equal(bot.calls[0].path, "/open-apis/contact/v3/users/ou%2Fa");
});

test("contact fanout reuses filters and rejects explicit false filters", async () => {
  const ctx = context((call) => ({ users: [{ name: call.body.query }] }));
  const result = await run(ctx, "contact", "search-user", {
    queries: "Alice,Bob,Alice",
    "has-chatted": true,
  });
  assert.equal(ctx.calls.length, 2);
  assert.equal(result.users[1].matched_query, "Bob");
  assert.deepEqual(ctx.calls[0].body.filter, { has_contact: true });
  await assert.rejects(
    run(ctx, "contact", "search-user", {
      query: "Alice",
      "has-chatted": false,
    }),
    /=false/,
  );
});

test("GJGW contact uses private v1 GET endpoint", async () => {
  const ctx = context(() => ({}), { config: { brand: "gjgw" } });
  await run(ctx, "contact", "search-user", {
    query: "Alice",
    "page-size": "100",
  });
  assert.equal(ctx.calls[0].path, "/open-apis/search/v1/user");
  assert.equal(ctx.calls[0].method, "GET");
});

test("mail send defaults to draft and raw MIME contains validated recipients and UTF8 body", async () => {
  const ctx = context((call) =>
    call.path.endsWith("/profile")
      ? { primary_email_address: "sender@example.com" }
      : { draft_id: "d1" },
  );
  const result = await run(ctx, "mail", "send", {
    to: "Alice <alice@example.com>",
    subject: "你好",
    body: "<p>Hello</p>",
  });
  assert.equal(result.saved_as_draft, true);
  assert.equal(ctx.calls.length, 2);
  const raw = Buffer.from(ctx.calls[1].body.raw, "base64url").toString();
  assert.ok(raw.includes("alice@example.com"));
  assert.ok(raw.includes("text/html; charset=UTF-8"));
  assert.ok(!ctx.calls.some((c) => c.path.endsWith("/send")));
});

test("mail only sends after confirm-send and validates schedules before mutation", async () => {
  const ctx = context((call) =>
    call.path.endsWith("/profile")
      ? { primary_email_address: "sender@example.com" }
      : { draft_id: "d1" },
  );
  await run(ctx, "mail", "send", {
    to: "a@example.com",
    subject: "S",
    body: "B",
    "confirm-send": true,
  });
  assert.equal(
    ctx.calls[2].path,
    "/open-apis/mail/v1/user_mailboxes/me/drafts/d1/send",
  );
  const invalid = context();
  await assert.rejects(
    run(invalid, "mail", "send", {
      to: "a@example.com",
      subject: "S",
      body: "B",
      "confirm-send": true,
      "send-time": "1",
    }),
    /five minutes/,
  );
  assert.equal(invalid.calls.length, 0);
});

test("mail rejects header injection without creating a draft", async () => {
  const ctx = context();
  await assert.rejects(
    run(ctx, "mail", "send", {
      to: "a@example.com\r\nBcc: victim@example.com",
      subject: "S",
      body: "B",
    }),
    /CR\/LF/,
  );
  assert.equal(ctx.calls.length, 0);
});

test("mail decline receipt only clears a real outstanding receipt request", async () => {
  const ctx = context(() => ({ message: { label_ids: [] } }));
  const result = await run(ctx, "mail", "decline-receipt", {
    "message-id": "m1",
  });
  assert.equal(result.already_cleared, true);
  assert.equal(ctx.calls.length, 1);
});

test("mail batch send partial errors remain failures with per-draft details", async () => {
  const ctx = context((call) => {
    if (call.path.includes("/bad/")) throw new Error("Rejected");
    return { message_id: "m1" };
  });
  await assert.rejects(
    run(ctx, "mail", "draft-send", { "draft-id": "good,bad" }),
    (error) =>
      error.type === "partial_failure" && error.detail.results.length === 2,
  );
});

test("draft header edit preserves MIME body and attachment bytes", async () => {
  const original =
    'From: sender@example.com\r\nTo: a@example.com\r\nSubject: old\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment\r\n\r\nunchanged-bytes\r\n--x--\r\n';
  const ctx = context((call) =>
    call.method === "GET"
      ? { raw: Buffer.from(original).toString("base64url") }
      : {},
  );
  await run(ctx, "mail", "draft-edit", {
    "draft-id": "d1",
    "set-subject": "new",
  });
  const updated = Buffer.from(ctx.calls[1].body.raw, "base64url").toString();
  assert.ok(updated.includes("unchanged-bytes"));
  assert.ok(updated.includes("Subject: =?UTF-8?B?bmV3?="));
});

test("mail local lint strips active HTML and reports findings", async () => {
  const ctx = context();
  const result = await run(ctx, "mail", "lint-html", {
    body: '<p onclick="bad()">Hello</p><script>bad()</script>',
    "show-lint-details": true,
  });
  assert.equal(result.cleaned_html, "<p>Hello</p>");
  assert.equal(result.errors.length, 2);
  assert.equal(ctx.calls.length, 0);
});

test("dry-run records dependent requests using placeholder IDs", async () => {
  const ctx = context(() => ({}), { dryRun: true });
  await run(ctx, "calendar", "create", {
    start: "2026-11-09T12:00Z",
    end: "2026-11-09T13:00Z",
    "attendee-ids": "ou_a",
  });
  assert.equal(ctx.calls.length, 2);
  assert.ok(ctx.calls[1].path.includes("%3Cevent_id%3E"));
});

test("contact search normalizes stable open_id and translates ID filters", async () => {
  const ctx = context(() => ({
    items: [
      {
        id: "ou_a",
        meta_data: {
          i18n_names: { zh_cn: "张三", en_us: "Alice" },
          mail_address: "a@example.com",
          chat_id: "oc_x",
        },
        display_info: "<h>张</h>三\nEngineering\n[Yesterday]",
      },
    ],
  }));
  const result = await run(ctx, "contact", "search-user", {
    "user-ids": "ou_a",
    lang: "en-US",
  });
  assert.deepEqual(ctx.calls[0].body.filter.user_ids, ["ou_a"]);
  assert.equal(result.users[0].open_id, "ou_a");
  assert.equal(result.users[0].localized_name, "Alice");
  assert.equal(result.users[0].department, "Engineering");
  assert.equal(result.users[0].chat_recency_hint, "Yesterday");
});

test("calendar event relation uses instance_ids and meeting_instance_ids", async () => {
  const ctx = context((call) =>
    call.path.endsWith("/primary")
      ? { calendars: [{ calendar: { calendar_id: "cal1" } }] }
      : call.path.endsWith("/mget_instance_relation_info")
        ? { instance_relation_infos: [{ meeting_instance_ids: ["meeting1"] }] }
        : { recording: { url: "https://example.invalid/recording" } },
  );
  await run(ctx, "vc", "recording", { "calendar-event-ids": "event1" });
  assert.deepEqual(ctx.calls[1].body, {
    instance_ids: ["event1"],
    need_meeting_instance_ids: true,
  });
  assert.equal(
    ctx.calls[2].path,
    "/open-apis/vc/v1/meetings/meeting1/recording",
  );
});

test("mail body fields are decoded and reply uses head_from SMTP identity", async () => {
  const ctx = context((call) =>
    call.path.endsWith("/messages/m1")
      ? {
          message: {
            subject: "Original",
            head_from: { mail_address: "alice@example.com", name: "Alice" },
            smtp_message_id: "<smtp@example.com>",
            body_html: Buffer.from("<p>Quoted</p>").toString("base64url"),
          },
        }
      : call.path.endsWith("/profile")
        ? { primary_email_address: "sender@example.com" }
        : { draft_id: "d1" },
  );
  const fetched = await run(ctx, "mail", "message", { "message-id": "m1" });
  assert.equal(fetched.body_html, "<p>Quoted</p>");
  await run(ctx, "mail", "reply", { "message-id": "m1", body: "Reply" });
  const raw = Buffer.from(ctx.calls.at(-1).body.raw, "base64url").toString();
  assert.match(raw, /alice@example.com/);
  assert.match(raw, /In-Reply-To: <smtp@example.com>/);
});

test("mail templates download normal attachments without forwarding credentials", async () => {
  const ctx = context(
    (call) => {
      if (call.path.endsWith("/templates/t1"))
        return {
          template: {
            subject: "Template",
            template_content: "<p>Template body</p>",
            attachments: [
              {
                id: "a1",
                filename: "a.txt",
                attachment_type: 1,
                is_inline: false,
              },
            ],
          },
        };
      if (call.path.endsWith("/attachments/download_url"))
        return {
          download_urls: [
            {
              attachment_id: "a1",
              download_url: "https://download.example.invalid/a1",
            },
          ],
        };
      if (call.path.endsWith("/profile"))
        return { primary_email_address: "sender@example.com" };
      return { draft_id: "d1" };
    },
    {
      fetchBinary: async (url) => {
        assert.equal(url, "https://download.example.invalid/a1");
        return Buffer.from("file-content");
      },
    },
  );
  await run(ctx, "mail", "send", { to: "a@example.com", "template-id": "t1" });
  const raw = Buffer.from(ctx.calls.at(-1).body.raw, "base64url").toString();
  assert.ok(raw.includes(Buffer.from("file-content").toString("base64")));
  assert.match(raw, /filename="a.txt"/);
  assert.deepEqual(ctx.calls[1].query, { attachment_ids: ["a1"] });
});

test("mail LARGE template attachments reuse server tokens", async () => {
  const ctx = context((call) =>
    call.path.endsWith("/templates/t1")
      ? {
          template: {
            subject: "S",
            template_content: "Body",
            attachments: [
              { id: "large1", filename: "large.zip", attachment_type: 2 },
            ],
          },
        }
      : call.path.endsWith("/profile")
        ? { primary_email_address: "sender@example.com" }
        : { draft_id: "d1" },
  );
  await run(ctx, "mail", "send", { to: "a@example.com", "template-id": "t1" });
  const raw = Buffer.from(ctx.calls.at(-1).body.raw, "base64url").toString();
  const header = /X-Lms-Large-Attachment-Ids: ([^\r]+)/.exec(raw)[1];
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64").toString()), [
    { id: "large1" },
  ]);
  assert.ok(
    !ctx.calls.some((c) => c.path.endsWith("/attachments/download_url")),
  );
});

test("large local mail attachment uses bounded multipart blocks and registers token", async (t) => {
  const dir = await mkdtemp(path.join(process.cwd(), ".collab-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "large.dat");
  const handle = await open(file, "w");
  await handle.truncate(26 * 1024 ** 2);
  await handle.close();
  let parts = 0;
  const ctx = context((call) => {
    if (call.path.endsWith("/profile"))
      return { primary_email_address: "sender@example.com" };
    if (call.path.endsWith("/upload_prepare"))
      return { upload_id: "u1", block_size: 4 * 1024 ** 2, block_num: 7 };
    if (call.path.endsWith("/upload_part")) {
      assert.ok(call.body instanceof FormData);
      assert.ok(Number(call.body.get("size")) <= 4 * 1024 ** 2);
      parts++;
      return {};
    }
    if (call.path.endsWith("/upload_finish"))
      return { file_token: "large-file-token" };
    return { draft_id: "d1" };
  });
  await run(ctx, "mail", "send", {
    to: "a@example.com",
    subject: "S",
    body: "B",
    attach: path.relative(process.cwd(), file),
  });
  assert.equal(parts, 7);
  const raw = Buffer.from(ctx.calls.at(-1).body.raw, "base64url").toString();
  assert.ok(raw.length < 10000);
  assert.match(raw, /X-Lms-Large-Attachment-Ids:/);
  assert.deepEqual(
    ctx.calls.find((c) => c.path.endsWith("/upload_prepare")).body,
    {
      file_name: "large.dat",
      parent_type: "email",
      parent_node: "ou_me",
      size: 26 * 1024 ** 2,
    },
  );
});

test("draft typed patch changes author body and recipients while preserving quotes and attachments", async () => {
  const html = "<p>Old body</p><blockquote><p>Keep quote</p></blockquote>";
  const original = `From: sender@example.com\r\nTo: old@example.com\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(html).toString("base64")}\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="keep.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\na2VlcA==\r\n--x--\r\n`;
  const ctx = context(
    (call) =>
      call.method === "GET"
        ? { raw: Buffer.from(original).toString("base64url") }
        : {},
    {
      input: async (value) =>
        value.startsWith("@")
          ? JSON.stringify({
              ops: [
                { op: "set_reply_body", value: "<p>New body</p>" },
                {
                  op: "set_recipients",
                  field: "to",
                  addresses: [{ address: "new@example.com" }],
                },
              ],
            })
          : value,
    },
  );
  await run(ctx, "mail", "draft-edit", {
    "draft-id": "d1",
    "patch-file": "patch.json",
  });
  const raw = Buffer.from(ctx.calls.at(-1).body.raw, "base64url").toString();
  assert.match(raw, /new@example.com/);
  assert.match(raw, /a2VlcA==/);
  assert.ok(
    raw.includes(
      Buffer.from("<p>New body</p><blockquote><p>Keep quote</p></blockquote>")
        .toString("base64")
        .slice(0, 40),
    ),
  );
});

test("draft header patch refuses protected MIME headers", async () => {
  const ctx = context(
    () => ({
      raw: Buffer.from(
        "From: a@example.com\r\nContent-Type: text/plain\r\n\r\nBody",
      ).toString("base64url"),
    }),
    {
      input: async () =>
        JSON.stringify({
          ops: [{ op: "set_header", name: "Content-Type", value: "text/html" }],
        }),
    },
  );
  await assert.rejects(
    run(ctx, "mail", "draft-edit", {
      "draft-id": "d1",
      "patch-file": "patch.json",
    }),
    /protected/,
  );
  assert.equal(ctx.calls.length, 1);
});

test("mail triage includes INBOX, uses max 20 IDs per page, and prefixes cursors", async () => {
  const ctx = context((call) =>
    call.method === "GET"
      ? { items: ["m1"], has_more: true, page_token: "next" }
      : { messages: [{ message_id: "m1" }] },
  );
  const result = await run(ctx, "mail", "triage", { max: "1" });
  assert.equal(ctx.calls[0].query.folder_id, "INBOX");
  assert.equal(ctx.calls[0].query.page_size, 1);
  assert.equal(result.page_token, "list:next");
  await assert.rejects(
    run(ctx, "mail", "triage", { "page-token": "next" }),
    /prefix/,
  );
});

test("mail watch unsubscribes after event stream ends", async () => {
  const ctx = context(() => ({}), {
    eventConsume: async (key) => {
      assert.equal(key, "mail.user_mailbox.event.message_received_v1");
      return { count: 1 };
    },
  });
  await run(ctx, "mail", "watch", { mailbox: "sender@example.com" });
  assert.deepEqual(
    ctx.calls.map((c) => c.path.split("/").at(-1)),
    ["subscribe", "unsubscribe"],
  );
  assert.deepEqual(ctx.calls[0].body, { event_type: 1 });
});

function minuteDownloadContext(options = {}) {
  return context(
    () => ({ download_url: "https://media.example.invalid/media" }),
    {
      download: async (url, { output }) => {
        assert.equal(url, "https://media.example.invalid/media");
        await writeFile(output, "media", { flag: "wx" });
        return { path: output, bytes: 5 };
      },
      ...options,
    },
  );
}

test("minute download creates the default per-token artifact directory", async (t) => {
  const token = `nodetest${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const directory = path.join(process.cwd(), "minutes", token);
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rmdir(path.dirname(directory)).catch(() => {});
  });
  const result = await run(minuteDownloadContext(), "minutes", "download", {
    "minute-tokens": token,
  });
  assert.equal(result.path, path.join(directory, `${token}.mp4`));
  assert.equal(await readFile(result.path, "utf8"), "media");
});

test("minute download creates explicit directories and nested file parents", async (t) => {
  const directory = await mkdtemp(path.join(process.cwd(), ".collab-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputDirectory = path.join(directory, "new", "media");
  const first = await run(minuteDownloadContext(), "minutes", "download", {
    "minute-tokens": "minute1",
    "output-dir": outputDirectory,
  });
  assert.equal(first.path, path.join(outputDirectory, "minute1.mp4"));
  const output = path.join(directory, "another", "chosen.mp4");
  const second = await run(minuteDownloadContext(), "minutes", "download", {
    "minute-tokens": "minute2",
    output,
  });
  assert.equal(second.path, output);
  assert.equal(await readFile(second.path, "utf8"), "media");
});

test("minute download treats existing single-token output directories like cp", async (t) => {
  const directory = await mkdtemp(path.join(process.cwd(), ".collab-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await run(minuteDownloadContext(), "minutes", "download", {
    "minute-tokens": "minute1",
    output: directory,
  });
  assert.equal(result.path, path.join(directory, "minute1.mp4"));
});

test("minute batch download treats output as a directory and creates it", async (t) => {
  const directory = await mkdtemp(path.join(process.cwd(), ".collab-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "batch");
  const result = await run(minuteDownloadContext(), "minutes", "download", {
    "minute-tokens": "minute1,minute2",
    output,
  });
  assert.deepEqual(
    result.results.map((item) => item.path),
    [path.join(output, "minute1.mp4"), path.join(output, "minute2.mp4")],
  );
  const file = path.join(directory, "file.mp4");
  await writeFile(file, "existing");
  const invalid = minuteDownloadContext();
  await assert.rejects(
    run(invalid, "minutes", "download", {
      "minute-tokens": "minute1,minute2",
      output: file,
    }),
    /batch mode requires a directory/,
  );
  assert.equal(invalid.calls.length, 0);
});

test("minute download validates conflicting flags, tokens, and unsafe paths before requests", async (t) => {
  const directory = await mkdtemp(path.join(process.cwd(), ".collab-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ctx = minuteDownloadContext();
  await assert.rejects(
    run(ctx, "minutes", "download", {
      "minute-tokens": "minute1",
      output: directory,
      "output-dir": directory,
    }),
    /cannot both/,
  );
  await assert.rejects(
    run(ctx, "minutes", "download", { "minute-tokens": "bad/token" }),
    /lowercase alphanumeric/,
  );
  await assert.rejects(
    run(ctx, "minutes", "download", {
      "minute-tokens": Array.from(
        { length: 51 },
        (_, index) => `token${index}`,
      ).join(","),
    }),
    /at most 50/,
  );
  await assert.rejects(
    run(ctx, "minutes", "download", {
      "minute-tokens": "minute1",
      output: "../outside.mp4",
    }),
    /Invalid minute output path/,
  );
  assert.equal(ctx.calls.length, 0);
});

test("minute URL-only and dry-run downloads do not create output directories", async (t) => {
  const directory = await mkdtemp(path.join(process.cwd(), ".collab-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "not-created");
  const ctx = minuteDownloadContext({
    download: async () => assert.fail("must not download"),
  });
  const result = await run(ctx, "minutes", "download", {
    "minute-tokens": "minute1",
    "output-dir": output,
    "url-only": true,
  });
  assert.equal(result.download_url, "https://media.example.invalid/media");
  await assert.rejects(access(output), { code: "ENOENT" });
  await run(
    minuteDownloadContext({
      dryRun: true,
      download: async () => assert.fail("must not download"),
    }),
    "minutes",
    "download",
    { "minute-tokens": "minute1,minute2", output },
  );
  await assert.rejects(access(output), { code: "ENOENT" });
});
