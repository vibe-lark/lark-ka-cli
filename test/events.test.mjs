import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  eventSink,
  eventStatus,
  eventStop,
  eventSubscriptionPlan,
  consumeEvents,
  STREAM_DONE,
} from "../src/events.mjs";
test("events await domain transform, skip filtered entries and write only valid NDJSON", async () => {
  let text = "";
  const output = new Writable({
    write(b, e, cb) {
      text += b;
      cb();
    },
  });
  const sink = await eventSink(
    {
      filter: "^mail\\.",
      transformEvent: async (d) => (d.skip ? undefined : { id: d.id }),
      match: "one",
    },
    output,
  );
  assert.equal(await sink({ id: "one" }, "im.message"), false);
  assert.equal(await sink({ id: "one", skip: true }, "mail.message"), false);
  assert.equal(await sink({ id: "two" }, "mail.message"), false);
  assert.equal(await sink({ id: "one" }, "mail.message"), true);
  assert.deepEqual(JSON.parse(text), { id: "one" });
});
test("event routes save an individual event to selected directory without stdout noise", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lark-events-"));
  const sink = await eventSink(
    { route: `^im\\.=dir:${root}` },
    {
      write() {
        assert.fail("should route to a file");
      },
    },
  );
  await sink({ id: "one" }, "im.message.receive_v1");
  const files = await readdir(root);
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, files[0]))).id, "one");
});
test("event status and stop do not signal arbitrary saved PIDs", async () => {
  const old = process.env.LARK_KA_CONFIG_DIR;
  process.env.LARK_KA_CONFIG_DIR = await mkdtemp(
    path.join(os.tmpdir(), "lark-events-"),
  );
  try {
    const ctx = { config: { storageKey: "none" } };
    assert.deepEqual(await eventStatus(ctx), { running: false });
    assert.deepEqual(await eventStop(ctx), { stopped: false, running: false });
  } finally {
    if (old === undefined) delete process.env.LARK_KA_CONFIG_DIR;
    else process.env.LARK_KA_CONFIG_DIR = old;
  }
});

async function eventFixture(
  t,
  frames = [],
  identity = "user",
  handler = async () => ({}),
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lark-event-policy-"));
  process.env.LARK_KA_CONFIG_DIR = path.join(root, "config");
  const output = path.join(root, "output");
  await mkdir(output);
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [],
    lifecycle = [];
  const ctx = {
    identity,
    requests: [],
    user: { open_id: "ou_me", union_id: "on_me", user_id: "user_me" },
    config: {
      appId: "cli_event_test",
      appSecret: "dummy-secret",
      storageKey: "event-test",
      openBaseUrl: "https://private.invalid",
      strictMode: "off",
    },
  };
  ctx.request = async (method, route, options = {}) => {
    calls.push({ method, route, ...options });
    return handler(method, route, options);
  };
  ctx.cleanupRequest = ctx.request;
  ctx.eventSDK = {
    LoggerLevel: { error: "error" },
    EventDispatcher: class {
      register(handlers) {
        this.handlers = handlers;
        return this;
      }
    },
    WSClient: class {
      constructor() {
        lifecycle.push("construct");
      }
      async start({ eventDispatcher }) {
        lifecycle.push("start");
        for (const frame of frames)
          await eventDispatcher.handlers[frame.key](frame.data);
      }
      close() {
        lifecycle.push("close");
      }
    },
  };
  return {
    ctx,
    calls,
    lifecycle,
    flags: { quiet: true, "max-events": 1, "output-dir": output, timeout: 2 },
    async outputs() {
      const names = await readdir(output);
      return Promise.all(
        names.map((name) =>
          readFile(path.join(output, name), "utf8").then(JSON.parse),
        ),
      );
    },
  };
}

test("event metadata preserves real Go identity whitelists instead of inventing user access", async () => {
  const definitions = JSON.parse(
    await readFile(new URL("../data/events.json", import.meta.url), "utf8"),
  );
  assert.equal(definitions.filter((d) => d.registered).length, 17);
  assert.deepEqual(
    definitions.find((d) => d.key === "im.message.receive_v1").authTypes,
    ["bot"],
  );
  assert.deepEqual(
    definitions.find((d) => d.key === "minutes.minute.generated_v1").authTypes,
    ["user"],
  );
  assert.deepEqual(
    definitions.find((d) => d.key === "vc.note.generated_v1").authTypes,
    ["user"],
  );
  assert.deepEqual(
    definitions.find((d) => d.key === "board.whiteboard.updated_v1").authTypes,
    ["user", "bot"],
  );
});

test("user identity cannot open a bot-only IM stream even with an app secret", async (t) => {
  const { ctx, lifecycle, calls } = await eventFixture(t);
  await assert.rejects(
    consumeEvents(ctx, "im.message.receive_v1"),
    (e) => e.type === "permission",
  );
  assert.deepEqual(lifecycle, []);
  assert.deepEqual(calls, []);
});

test("user identity cannot use raw application subscriptions", async (t) => {
  const { ctx, lifecycle, calls } = await eventFixture(t);
  await assert.rejects(
    consumeEvents(ctx, "contact.user.created_v3", { rawSubscription: true }),
    /require --as bot/,
  );
  assert.deepEqual(lifecycle, []);
  assert.deepEqual(calls, []);
});

test("live event commands require explicit keys and never default to all application events", async (t) => {
  const { ctx, lifecycle } = await eventFixture(t, [], "bot");
  await assert.rejects(consumeEvents(ctx, undefined), /explicit event key/);
  assert.deepEqual(lifecycle, []);
});

test("unregistered raw event names cannot be consumed as user EventKeys", () => {
  const ctx = { identity: "user", config: {} };
  assert.throws(
    () => eventSubscriptionPlan(ctx, ["contact.user.created_v3"]),
    /not registered/,
  );
});

test("raw bot dry-run is explicit and does not run user subscription hooks", async (t) => {
  const { ctx } = await eventFixture(t, [], "bot");
  ctx.dryRun = true;
  await consumeEvents(ctx, "vc.note.generated_v1", { rawSubscription: true });
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.requests[0].identity, "bot");
});

test("mail events require the mailbox-scoped mail watch transform", () => {
  assert.throws(
    () =>
      eventSubscriptionPlan({ identity: "user", config: {} }, [
        "mail.user_mailbox.event.message_received_v1",
      ]),
    /require mail \+watch/,
  );
});

test("minutes registers and unregisters with user identity and emits only this subscriber events", async (t) => {
  const key = "minutes.minute.generated_v1";
  const fixture = await eventFixture(
    t,
    [
      {
        key,
        data: {
          event: {
            minute_token: "other",
            subscriber_ids: [{ open_id: "ou_other" }],
          },
        },
      },
      { key, data: { event: { minute_token: "no-recipient" } } },
      {
        key,
        data: {
          header: { event_id: "event-own" },
          event: {
            minute_token: "mine",
            subscriber_ids: [{ open_id: "ou_me" }],
          },
        },
      },
    ],
    "user",
    async (method, route) =>
      route.endsWith("/mine") ? { minute: { title: "My minute" } } : {},
  );
  assert.equal(
    await consumeEvents(fixture.ctx, key, fixture.flags),
    STREAM_DONE,
  );
  const outputs = await fixture.outputs();
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].minute_token, "mine");
  assert.equal(outputs[0].title, "My minute");
  assert.equal(
    fixture.calls[0].route,
    "/open-apis/minutes/v1/minutes/subscription",
  );
  assert.equal(fixture.calls[0].identity, "user");
  assert.equal(
    fixture.calls.at(-1).route,
    "/open-apis/minutes/v1/minutes/unsubscription",
  );
  assert.equal(fixture.calls.at(-1).identity, "user");
  assert.equal(
    fixture.calls.filter((c) => c.route.includes("/other")).length,
    0,
  );
});

test("VC note user flow uses its own subscription and extracts user-visible artifacts", async (t) => {
  const key = "vc.note.generated_v1";
  const fixture = await eventFixture(
    t,
    [
      {
        key,
        data: { note_id: "note1", subscriber_ids: [{ union_id: "on_me" }] },
      },
    ],
    "user",
    async (method, route) =>
      route.endsWith("/note1")
        ? {
            note: {
              artifacts: [
                { artifact_type: 1, doc_token: "doc-note" },
                { artifact_type: 2, doc_token: "doc-verbatim" },
              ],
            },
          }
        : {},
  );
  await consumeEvents(fixture.ctx, key, fixture.flags);
  const [result] = await fixture.outputs();
  assert.equal(result.note_token, "doc-note");
  assert.equal(result.verbatim_token, "doc-verbatim");
  assert.equal(fixture.calls[0].route, "/open-apis/vc/v1/notes/subscription");
  assert.equal(
    fixture.calls.at(-1).route,
    "/open-apis/vc/v1/notes/unsubscription",
  );
});

test("VC participant meeting events reject other subscribers before output", async (t) => {
  const key = "vc.meeting.participant_meeting_ended_v1";
  const fixture = await eventFixture(t, [
    {
      key,
      data: {
        meeting: { id: "other" },
        subscriber_ids: [{ user_id: "other" }],
      },
    },
    {
      key,
      data: {
        meeting: { id: "mine", topic: "My meeting", start_time: "100" },
        subscriber_ids: [{ user_id: "user_me" }],
      },
    },
  ]);
  await consumeEvents(fixture.ctx, key, fixture.flags);
  const [result] = await fixture.outputs();
  assert.equal(result.meeting_id, "mine");
  assert.equal(result.topic, "My meeting");
  assert.equal(
    fixture.calls[0].route,
    "/open-apis/vc/v1/meetings/subscription",
  );
  assert.equal(
    fixture.calls.at(-1).route,
    "/open-apis/vc/v1/meetings/unsubscription",
  );
});

test("whiteboard requires a resource parameter and filters unrelated resources", async (t) => {
  const key = "board.whiteboard.updated_v1";
  const fixture = await eventFixture(t, [
    { key, data: { whiteboard_id: "other" } },
    { key, data: { whiteboard_id: "mine" } },
  ]);
  await assert.rejects(
    consumeEvents(fixture.ctx, key, fixture.flags),
    /whiteboard_id/,
  );
  assert.equal(fixture.calls.length, 0);
  await consumeEvents(fixture.ctx, key, {
    ...fixture.flags,
    param: ["whiteboard_id=mine"],
  });
  const [result] = await fixture.outputs();
  assert.equal(result.whiteboard_id, "mine");
  assert.equal(
    fixture.calls[0].route,
    "/open-apis/board/v1/whiteboards/mine/subscribe",
  );
  assert.equal(
    fixture.calls.at(-1).route,
    "/open-apis/board/v1/whiteboards/mine/unsubscribe",
  );
});

test("partial subscription setup failure cleans previous user subscriptions without starting a socket", async (t) => {
  const fixture = await eventFixture(t, [], "user", async (method, route) => {
    if (route === "/open-apis/vc/v1/notes/subscription")
      throw new Error("registration failed");
    return {};
  });
  await assert.rejects(
    consumeEvents(
      fixture.ctx,
      "minutes.minute.generated_v1,vc.note.generated_v1",
      fixture.flags,
    ),
    /registration failed/,
  );
  assert.deepEqual(fixture.lifecycle, []);
  assert.equal(
    fixture.calls.at(-1).route,
    "/open-apis/minutes/v1/minutes/unsubscription",
  );
});

test("subscription rejection never falls back to bot or opens an application socket", async (t) => {
  const fixture = await eventFixture(t, [], "user", async () => {
    throw Object.assign(new Error("missing user scope"), {
      type: "permission",
    });
  });
  await assert.rejects(
    consumeEvents(fixture.ctx, "minutes.minute.generated_v1", fixture.flags),
    /missing user scope/,
  );
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].identity, "user");
  assert.deepEqual(fixture.lifecycle, []);
});

test("user dry-run includes user-bound setup and cleanup instead of just an app socket", async (t) => {
  const { ctx } = await eventFixture(t);
  ctx.dryRun = true;
  await consumeEvents(ctx, "minutes.minute.generated_v1");
  assert.deepEqual(
    ctx.requests.map((r) => r.identity),
    ["user", "user", "user"],
  );
  assert.equal(
    ctx.requests[0].path,
    "/open-apis/minutes/v1/minutes/subscription",
  );
  assert.equal(ctx.requests[2].phase, "cleanup");
});
