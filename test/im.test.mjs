import test from "node:test";
import assert from "node:assert/strict";
import { executeIM, commands } from "../src/domains/im.mjs";

function context(handler = () => ({}), options = {}) {
  const calls = [];
  return {
    calls,
    identity: "user",
    dryRun: false,
    config: {},
    input: async (value) => value,
    request: async (method, apiPath, opts = {}) => {
      const call = { method, path: apiPath, ...structuredClone(opts) };
      calls.push(call);
      return handler(call, calls.length);
    },
    download: async (apiPath, options) => {
      calls.push({ method: "DOWNLOAD", path: apiPath, ...options });
      return { path: options.output, bytes: 123 };
    },
    ...options,
  };
}
const run = (ctx, command, flags = {}) =>
  executeIM(ctx, "im", `+${command}`, flags);

test("IM exposes all 20 shortcut handlers", () =>
  assert.equal(commands.length, 20));
test("plain text starting with @ remains literal and cannot cause a file read", async () => {
  const ctx = context(() => ({}), {
    input: async () => {
      throw new Error("Unexpected file access");
    },
  });
  await run(ctx, "messages-send", {
    "chat-id": "oc_group",
    text: "@./private-file",
  });
  assert.deepEqual(ctx.calls[0], {
    method: "POST",
    path: "/open-apis/im/v1/messages",
    query: { receive_id_type: "chat_id" },
    body: {
      receive_id: "oc_group",
      msg_type: "text",
      content: '{"text":"@./private-file"}',
    },
  });
});
test("message reply keeps thread and idempotency arguments", async () => {
  const ctx = context();
  await run(ctx, "messages-reply", {
    "message-id": "om_a",
    text: "reply",
    "reply-in-thread": true,
    "idempotency-key": "u1",
  });
  assert.equal(ctx.calls[0].path, "/open-apis/im/v1/messages/om_a/reply");
  assert.equal(ctx.calls[0].body.reply_in_thread, true);
  assert.equal(ctx.calls[0].body.uuid, "u1");
});
test("message IDs and recipient exclusivity are validated before writing", async () => {
  const ctx = context();
  await assert.rejects(
    run(ctx, "messages-send", {
      "chat-id": "oc_a",
      "user-id": "ou_a",
      text: "x",
    }),
    /exactly one/,
  );
  await assert.rejects(
    run(ctx, "messages-reply", { "message-id": "om_x/../secret", text: "x" }),
    /separators/,
  );
  await assert.rejects(
    run(ctx, "messages-send", { "chat-id": "oc_a", video: "file_video" }),
    /video-cover/,
  );
  assert.equal(ctx.calls.length, 0);
});
test("search filter preserves original ISO values and documented nested keys", async () => {
  const ctx = context(() => ({ items: [], has_more: false }));
  await run(ctx, "messages-search", {
    query: "roadmap",
    "chat-id": "oc_a,oc_b",
    sender: "ou_sender",
    start: "2026-11-01T00:00:00+08:00",
    end: "2026-11-02T00:00:00+08:00",
    "include-attachment-type": "file",
    "sender-type": "user",
    "exclude-sender-type": "bot",
    "chat-type": "group",
    "is-at-me": true,
    "at-chatter-ids": "ou_a",
  });
  assert.deepEqual(ctx.calls[0].body, {
    query: "roadmap",
    filter: {
      chat_ids: ["oc_a", "oc_b"],
      from_ids: ["ou_sender"],
      at_chatter_ids: ["ou_a"],
      time_range: {
        start_time: "2026-11-01T00:00:00+08:00",
        end_time: "2026-11-02T00:00:00+08:00",
      },
      include_attachment_types: ["file"],
      from_types: ["user"],
      exclude_from_types: ["bot"],
      chat_type: "group",
      is_at_me: true,
    },
  });
});
test("search extracts meta_data.message_id and loads message details with chat context", async () => {
  const ctx = context((call) => {
    if (call.path.endsWith("/search"))
      return {
        items: [{ meta_data: { message_id: "om_a" } }],
        has_more: false,
      };
    if (call.path.endsWith("/mget"))
      return {
        items: [
          {
            message_id: "om_a",
            chat_id: "oc_a",
            msg_type: "text",
            body: { content: '{"text":"Hello"}' },
          },
        ],
      };
    if (call.path.endsWith("/batch_query"))
      return { items: [{ chat_id: "oc_a", name: "Team", chat_mode: "group" }] };
    return {};
  });
  const result = await run(ctx, "messages-search", {
    query: "Hello",
    "no-reactions": true,
  });
  assert.equal(ctx.calls[1].query.message_ids[0], "om_a");
  assert.equal(result.messages[0].content, "Hello");
  assert.equal(result.messages[0].chat_name, "Team");
});
test("search only auto-paginates when page-all or explicitly provided page-limit requests it", async () => {
  const ctx = context(
    () => ({ items: [], has_more: true, page_token: "next" }),
    { providedFlags: new Set(["query"]) },
  );
  await run(ctx, "messages-search", { query: "x", "page-limit": 20 });
  assert.equal(ctx.calls.length, 1);
});
test("P2P conversation lookup uses chatter IDs before message list", async () => {
  const ctx = context((call) =>
    call.path.includes("chat_p2p")
      ? { p2p_chats: [{ chat_id: "oc_p2p" }] }
      : { items: [] },
  );
  await run(ctx, "chat-messages-list", {
    "user-id": "ou_a",
    start: "2026-11-01T00:00:00+08:00",
    "no-reactions": true,
  });
  assert.deepEqual(ctx.calls[0].body, { chatter_ids: ["ou_a"] });
  assert.equal(ctx.calls[0].query.chatter_id_type, "open_id");
  assert.equal(ctx.calls[1].query.container_id, "oc_p2p");
  assert.equal(ctx.calls[1].query.sort_type, "ByCreateTimeDesc");
  assert.equal(ctx.calls[1].query.start_time, "1793462400");
});
test("thread message input resolves thread ID and uses default ascending sort", async () => {
  const ctx = context((call) =>
    call.path.endsWith("/om_a")
      ? { items: [{ thread_id: "omt_t" }] }
      : { items: [] },
  );
  const result = await run(ctx, "threads-messages-list", {
    thread: "om_a",
    "no-reactions": true,
  });
  assert.equal(ctx.calls[1].query.container_id, "omt_t");
  assert.equal(ctx.calls[1].query.sort_type, "ByCreateTimeAsc");
  assert.equal(result.thread_id, "omt_t");
});
test("reaction enrichment uses queries objects and combines counts and details", async () => {
  const ctx = context((call) =>
    call.path.endsWith("/mget")
      ? {
          items: [
            {
              message_id: "om_a",
              msg_type: "text",
              body: { content: '{"text":"Hello"}' },
            },
          ],
        }
      : {
          success_msg_reaction_counts: [
            {
              message_id: "om_a",
              reaction_count: [{ reaction_type: "SMILE", count: 2 }],
            },
          ],
          success_msg_reaction_details: [
            {
              message_id: "om_a",
              message_reaction_items: [
                { reaction_id: "r1", emoji_type: "SMILE" },
              ],
            },
          ],
        },
  );
  const result = await run(ctx, "messages-mget", { "message-ids": "om_a" });
  assert.deepEqual(ctx.calls[1].body, { queries: [{ message_id: "om_a" }] });
  assert.equal(result.messages[0].reactions.counts[0].count, 2);
  assert.equal(result.messages[0].reactions.details[0].reaction_id, "r1");
});
test("reaction failure marks enrichment error while preserving messages", async () => {
  const ctx = context((call) => {
    if (call.path.endsWith("/mget"))
      return {
        items: [
          {
            message_id: "om_a",
            msg_type: "text",
            body: { content: '{"text":"Hello"}' },
          },
        ],
      };
    throw new Error("missing reaction scope");
  });
  const result = await run(ctx, "messages-mget", { "message-ids": "om_a" });
  assert.equal(result.messages[0].content, "Hello");
  assert.equal(result.messages[0].reactions_error, true);
});
test("sender-name batches respect ten-user API limit and enrich all messages", async () => {
  const items = Array.from({ length: 21 }, (_, i) => ({
    message_id: `om_${i}`,
    sender: { id: `ou_${i}` },
    msg_type: "text",
    body: { content: '{"text":"x"}' },
  }));
  const ctx = context((call) =>
    call.path.endsWith("/mget")
      ? { items }
      : {
          users: call.body.user_ids.map((id) => ({
            user_id: id,
            name: id + "-name",
          })),
        },
  );
  const result = await run(ctx, "messages-mget", {
    "message-ids": items.map((x) => x.message_id).join(","),
    "no-reactions": true,
  });
  assert.deepEqual(
    ctx.calls.slice(1).map((x) => x.body.user_ids.length),
    [10, 10, 1],
  );
  assert.equal(result.messages[20].sender.name, "ou_20-name");
});
test("chat create maps original users, bots, owner, type and manager options", async () => {
  const ctx = context(() => ({}), { identity: "bot" });
  await run(ctx, "chat-create", {
    name: "Public group",
    users: "ou_a,ou_b",
    bots: "cli_a",
    owner: "ou_owner",
    type: "public",
    "chat-mode": "topic",
    "set-bot-manager": true,
  });
  assert.deepEqual(ctx.calls[0].body, {
    name: "Public group",
    chat_type: "public",
    chat_mode: "topic",
    user_id_list: ["ou_a", "ou_b"],
    bot_id_list: ["cli_a"],
    owner_id: "ou_owner",
  });
  assert.equal(ctx.calls[0].query.set_bot_manager, true);
});
test("chat search is POST v2 and remains available to bot identity", async () => {
  const ctx = context(
    () => ({ items: [{ meta_data: { chat_id: "oc_a", name: "Team" } }] }),
    { identity: "bot" },
  );
  const result = await run(ctx, "chat-search", {
    query: "my-team",
    "member-ids": "ou_a",
    "is-manager": true,
    "sort-by": "member_count_desc",
  });
  assert.equal(ctx.calls[0].method, "POST");
  assert.equal(ctx.calls[0].path, "/open-apis/im/v2/chats/search");
  assert.equal(ctx.calls[0].body.query, '"my-team"');
  assert.deepEqual(ctx.calls[0].body.filter, {
    member_ids: ["ou_a"],
    is_manager: true,
  });
  assert.equal(result.chats[0].chat_id, "oc_a");
});
test("chat mute filtering removes only known muted chats and retains unknown entries", async () => {
  const ctx = context((call) =>
    call.path.endsWith("/chats")
      ? {
          items: [
            { chat_id: "oc_muted" },
            { chat_id: "oc_live" },
            { chat_id: "oc_unknown" },
          ],
        }
      : {
          items: [
            { chat_id: "oc_muted", is_muted: true },
            { chat_id: "oc_live", is_muted: false },
          ],
          invalid_id_list: [{ id: "oc_unknown" }],
        },
  );
  const result = await run(ctx, "chat-list", { "exclude-muted": true });
  assert.deepEqual(
    result.chats.map((x) => x.chat_id),
    ["oc_live", "oc_unknown"],
  );
  assert.equal(result.filter.filtered_count, 1);
});
test("bot mixed p2p/group listing strips p2p and records the adjustment", async () => {
  const ctx = context(() => ({ items: [] }), { identity: "bot" });
  const result = await run(ctx, "chat-list", {
    types: "p2p,group",
    "exclude-muted": true,
  });
  assert.equal(ctx.calls[0].query.types, "group");
  assert.equal(result.notices[0].code, "bot_strip_p2p");
  assert.equal(ctx.calls.length, 1);
});
test("feed shortcut remove uses POST remove endpoint and numeric CHAT type", async () => {
  const ctx = context();
  const result = await run(ctx, "feed-shortcut-remove", {
    "chat-id": ["oc_a,oc_b", "oc_a"],
  });
  assert.equal(ctx.calls[0].method, "POST");
  assert.equal(ctx.calls[0].path, "/open-apis/im/v2/feed_shortcuts/remove");
  assert.deepEqual(ctx.calls[0].body, {
    shortcuts: [
      { feed_card_id: "oc_a", type: 1 },
      { feed_card_id: "oc_b", type: 1 },
    ],
  });
  assert.equal(result.success_count, 2);
});
test("feed shortcut partial failure exposes requested-item ledger and nonzero error", async () => {
  const ctx = context(() => ({
    failed_shortcuts: [{ shortcut: { feed_card_id: "oc_b" }, reason: 1 }],
  }));
  await assert.rejects(
    run(ctx, "feed-shortcut-create", { "chat-id": "oc_a,oc_b" }),
    (error) =>
      error.type === "partial_failure" &&
      error.detail.success_count === 1 &&
      error.detail.failure_count === 1,
  );
});
test("feed shortcut list enriches full chat detail", async () => {
  const ctx = context((call) =>
    call.method === "GET"
      ? { shortcuts: [{ feed_card_id: "oc_a", type: 1 }] }
      : { items: [{ chat_id: "oc_a", name: "Team", chat_mode: "group" }] },
  );
  const result = await run(ctx, "feed-shortcut-list");
  assert.equal(result.shortcuts[0].detail.name, "Team");
});
test("feed groups pagination merges active and deleted arrays independently", async () => {
  const ctx = context((call, n) =>
    n === 1
      ? {
          groups: [{ id: "g1" }],
          deleted_groups: [{ id: "d1" }],
          has_more: true,
          page_token: "next",
        }
      : {
          groups: [{ id: "g2" }],
          deleted_groups: [{ id: "d2" }],
          has_more: false,
        },
  );
  const result = await run(ctx, "feed-group-list", { "page-all": true });
  assert.equal(ctx.calls[0].query.page_token, "");
  assert.deepEqual(
    result.groups.map((x) => x.id),
    ["g1", "g2"],
  );
  assert.deepEqual(
    result.deleted_groups.map((x) => x.id),
    ["d1", "d2"],
  );
});
test("flag message enums serialize as strings and do not need lookup calls", async () => {
  const ctx = context();
  await run(ctx, "flag-create", { "message-id": "om_a" });
  assert.deepEqual(ctx.calls[0].body, {
    flag_items: [{ item_id: "om_a", item_type: "0", flag_type: "2" }],
  });
  assert.equal(ctx.calls.length, 1);
});
test("feed flag infers topic item_type from the message chat", async () => {
  const ctx = context((call) =>
    call.path.includes("/messages/om_a")
      ? { items: [{ chat_id: "oc_a" }] }
      : call.path.endsWith("/chats/oc_a")
        ? { chat_mode: "topic" }
        : {},
  );
  await run(ctx, "flag-create", { "message-id": "om_a", "flag-type": "feed" });
  assert.deepEqual(ctx.calls[2].body, {
    flag_items: [{ item_id: "om_a", item_type: "4", flag_type: "1" }],
  });
});
test("default flag cancel independently removes message and feed layers using POST", async () => {
  const ctx = context((call) =>
    call.path.endsWith("/messages/om_a")
      ? { items: [{ chat_id: "oc_a" }] }
      : call.path.endsWith("/chats/oc_a")
        ? { chat_mode: "group" }
        : {},
  );
  const result = await run(ctx, "flag-cancel", { "message-id": "om_a" });
  assert.equal(result.results.length, 2);
  assert.deepEqual(
    ctx.calls
      .slice(2)
      .map((c) => [c.method, c.path, c.body.flag_items[0].item_type]),
    [
      ["POST", "/open-apis/im/v1/flags/cancel", "0"],
      ["POST", "/open-apis/im/v1/flags/cancel", "11"],
    ],
  );
});
test("flag cancel rejects unsupported explicit feed combination before writing", async () => {
  const ctx = context();
  await assert.rejects(
    run(ctx, "flag-cancel", { "message-id": "om_a", "flag-type": "feed" }),
    /requires --item-type/,
  );
  assert.equal(ctx.calls.length, 0);
});
test("resource download defaults to file key and preserves safe relative output", async () => {
  const ctx = context();
  const result = await run(ctx, "messages-resources-download", {
    "message-id": "om_a",
    "file-key": "file_abc",
    type: "file",
  });
  assert.equal(ctx.calls[0].output, "file_abc");
  assert.deepEqual(result, { saved_path: "file_abc", size_bytes: 123 });
});
