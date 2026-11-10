import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { configDir, writeStore, readStore } from "./config.mjs";
import { CliError, redact } from "./errors.mjs";
import { currentUser } from "./auth.mjs";
export const STREAM_DONE = Symbol.for("lark-ka.stream-done");
const eventDefinitions = JSON.parse(
  await readFile(new URL("../data/events.json", import.meta.url), "utf8"),
);
const eventByKey = new Map(
  eventDefinitions.map((definition) => [definition.key, definition]),
);

function eventParams(flags) {
  const params = {};
  for (const raw of Array.isArray(flags.param)
    ? flags.param
    : flags.param
      ? [flags.param]
      : []) {
    if (typeof raw !== "string" || !raw.includes("="))
      throw new CliError("validation", "--param must use key=value");
    const at = raw.indexOf("="),
      key = raw.slice(0, at),
      value = raw.slice(at + 1);
    if (
      !/^[a-z][a-z0-9_]*$/.test(key) ||
      !value ||
      /[\u0000-\u001f]/.test(value) ||
      Object.hasOwn(params, key)
    )
      throw new CliError(
        "validation",
        "Event parameters must have unique names and nonempty values",
      );
    params[key] = value;
  }
  if (flags.whiteboard_id || flags["whiteboard-id"])
    params.whiteboard_id ??= flags.whiteboard_id ?? flags["whiteboard-id"];
  return params;
}

export function eventSubscriptionPlan(ctx, keys, flags = {}) {
  const params = eventParams(flags),
    plans = [];
  if (!["user", "bot"].includes(ctx.identity))
    throw new CliError("validation", "Event identity must be user or bot");
  if (
    ctx.config.strictMode &&
    ctx.config.strictMode !== "off" &&
    ctx.config.strictMode !== ctx.identity
  )
    throw new CliError(
      "permission",
      `Profile only permits ${ctx.config.strictMode} identity`,
      { code: 3 },
    );
  if (flags.rawSubscription && ctx.identity !== "bot")
    throw new CliError(
      "permission",
      "Raw application subscriptions require --as bot; user identity cannot be used as an application-wide event reader",
      { code: 3 },
    );
  for (const key of keys) {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(key))
      throw new CliError("validation", "Invalid event key");
    if (flags.rawSubscription) {
      plans.push({ key, raw: true });
      continue;
    }
    const definition = eventByKey.get(key);
    if (!definition || definition.rawOnly)
      throw new CliError(
        "validation",
        `EventKey ${key} is not registered for event consume`,
        {
          hint: "Use event list for registered keys, or an explicit bot raw event +subscribe.",
        },
      );
    if (!definition.authTypes.includes(ctx.identity))
      throw new CliError(
        "permission",
        `${key} supports ${definition.authTypes.join("/")} identity, not ${ctx.identity}`,
        { code: 3 },
      );
    if (
      definition.userFlow === "mail-watch" &&
      typeof flags.transformEvent !== "function"
    )
      throw new CliError(
        "permission",
        "User mail events require mail +watch, which registers the user mailbox and filters events by its address",
        { code: 3 },
      );
    if (
      ctx.identity === "user" &&
      !definition.preConsume &&
      definition.userFlow !== "mail-watch"
    )
      throw new CliError(
        "unsupported",
        `User-scoped subscription is not implemented for ${key}`,
        { hint: "No application-wide subscription was started." },
      );
    const plan = { key, definition, params };
    if (definition.preConsume) {
      for (const name of definition.requiredParams ?? [])
        if (!params[name])
          throw new CliError(
            "validation",
            `--param ${name}=<value> is required for ${key}`,
          );
      const substitute = (route) =>
        route.replace(/\{([a-z_]+)\}/g, (_, name) =>
          encodeURIComponent(params[name]),
        );
      plan.subscribePath = substitute(definition.preConsume.subscribePath);
      plan.unsubscribePath = substitute(definition.preConsume.unsubscribePath);
      plan.body = definition.preConsume.body;
    }
    plans.push(plan);
  }
  return plans;
}

function subscriberMatches(event, user) {
  if (!Array.isArray(event.subscriber_ids)) return false;
  return event.subscriber_ids.some((subscriber) =>
    ["open_id", "union_id", "user_id"].some(
      (key) =>
        typeof user?.[key] === "string" &&
        user[key] &&
        subscriber?.[key] === user[key],
    ),
  );
}

async function userEventTransform(ctx, plan, envelope, user) {
  if (plan.raw) return envelope;
  const event = envelope.event ?? envelope,
    header = envelope.header ?? envelope;
  if (
    plan.definition.resourceFilter &&
    event[plan.definition.resourceFilter] !==
      plan.params[plan.definition.resourceFilter]
  )
    return undefined;
  if (
    ctx.identity === "user" &&
    plan.definition.recipientField &&
    !subscriberMatches(event, user)
  )
    return undefined;
  const common = {
    type: plan.key,
    event_id: header.event_id,
    timestamp: header.create_time,
  };
  if (plan.key === "minutes.minute.generated_v1") {
    const result = {
      ...common,
      minute_token: event.minute_token,
      minute_source: event.minute_source,
    };
    if (event.minute_token) {
      try {
        const data = await ctx.request(
          "GET",
          `/open-apis/minutes/v1/minutes/${encodeURIComponent(event.minute_token)}`,
          { identity: "user" },
        );
        result.title = data.minute?.title;
      } catch (error) {
        if (error.type === "auth") throw error;
      }
    }
    return result;
  }
  if (plan.key === "vc.note.generated_v1") {
    const result = { ...common, note_id: event.note_id };
    if (event.note_id) {
      try {
        const data = await ctx.request(
          "GET",
          `/open-apis/vc/v1/notes/${encodeURIComponent(event.note_id)}`,
          { identity: "user" },
        );
        const note = data.note ?? data;
        result.note_source = note.note_source;
        for (const artifact of note.artifacts ?? [])
          if (artifact.artifact_type === 1 || artifact.type === 1)
            result.note_token =
              artifact.doc_token ?? artifact.token ?? artifact.obj_token;
          else if (artifact.artifact_type === 2 || artifact.type === 2)
            result.verbatim_token =
              artifact.doc_token ?? artifact.token ?? artifact.obj_token;
      } catch (error) {
        if (error.type === "auth") throw error;
      }
    }
    return result;
  }
  if (plan.key === "vc.meeting.participant_meeting_ended_v1") {
    const meeting = event.meeting ?? {};
    const timestamp = (raw) => {
      const n = Number(raw);
      return raw && Number.isFinite(n) ? new Date(n * 1000).toISOString() : raw;
    };
    return {
      ...common,
      meeting_id: meeting.id,
      topic: meeting.topic,
      meeting_no: meeting.meeting_no,
      start_time: timestamp(meeting.start_time),
      end_time: timestamp(meeting.end_time),
      calendar_event_id: event.calendar_event_id ?? meeting.calendar_event_id,
    };
  }
  return envelope;
}
function regex(value, label) {
  try {
    return value ? new RegExp(value) : undefined;
  } catch {
    throw new CliError(
      "validation",
      `${label} must be a valid regular expression`,
    );
  }
}
export async function eventSink(flags = {}, output = process.stdout) {
  const filter = regex(flags.filter, "--filter"),
    matches = regex(flags.match, "--match");
  const routes = (
    Array.isArray(flags.route) ? flags.route : flags.route ? [flags.route] : []
  ).map((value) => {
    const split = value.indexOf("=");
    if (split < 1)
      throw new CliError("validation", "--route uses regex=dir:PATH");
    const destination = value.slice(split + 1);
    if (!destination.startsWith("dir:"))
      throw new CliError("validation", "Route destination must use dir:");
    return {
      filter: regex(value.slice(0, split), "--route"),
      dir: path.resolve(destination.slice(4)),
    };
  });
  return async (original, key) => {
    if (
      filter &&
      !filter.test(
        key || original.header?.event_type || original.event_type || "",
      )
    )
      return false;
    const data = flags.transformEvent
      ? await flags.transformEvent(original)
      : original;
    if (data === undefined) return false;
    if (matches && !matches.test(JSON.stringify(data))) return false;
    const transformed = flags.compact
      ? {
          event_type: key || data.header?.event_type || data.event_type,
          event: data.event || data,
        }
      : data;
    const dest =
      routes.find((r) => r.filter.test(key || data.header?.event_type || ""))
        ?.dir || flags["output-dir"];
    if (dest) {
      const dir = path.resolve(dest);
      if (/[\0\r\n]/.test(dir))
        throw new CliError("validation", "Invalid output directory");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(dir, `${Date.now()}-${randomUUID()}.json`),
        JSON.stringify(transformed, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    } else
      output.write(
        JSON.stringify(transformed, null, flags.json ? 2 : undefined) + "\n",
      );
    return true;
  };
}
export async function consumeEvents(ctx, key, flags = {}) {
  const keys = [
    ...new Set(
      String(key || flags["event-types"] || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (!keys.length && !flags.stdin)
    throw new CliError(
      "validation",
      "An explicit event key is required; no application-wide default subscription is started",
    );
  const max = Number(flags["max-events"] || 0),
    timeout = Number(flags.timeout || 0);
  if (
    !Number.isInteger(max) ||
    max < 0 ||
    !Number.isFinite(timeout) ||
    timeout < 0
  )
    throw new CliError(
      "validation",
      "Event limits and timeouts must be nonnegative",
    );
  const publish = await eventSink(flags);
  let count = 0;
  if (flags.stdin) {
    const lines = readline.createInterface({ input: process.stdin });
    const timer = timeout
      ? setTimeout(() => lines.close(), timeout * 1000)
      : undefined;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let data;
        try {
          data = JSON.parse(line);
        } catch {
          throw new CliError("validation", "stdin contains invalid event JSON");
        }
        if (
          await publish(
            data,
            data.header?.event_type || data.event_type || keys[0],
          )
        )
          if (max && ++count >= max) break;
      }
    } finally {
      clearTimeout(timer);
      lines.close();
    }
    return STREAM_DONE;
  }
  const plans = eventSubscriptionPlan(ctx, keys, flags);
  if (ctx.signal?.aborted)
    throw new CliError("network", "Event consumption was cancelled", {
      code: 4,
    });
  if (ctx.dryRun) {
    for (const plan of plans)
      if (plan.subscribePath)
        ctx.requests.push({
          method: "POST",
          path: plan.subscribePath,
          data: plan.body,
          identity: ctx.identity,
        });
    ctx.requests.push({
      transport: "websocket",
      path: new URL("/callback/ws/endpoint", ctx.config.openBaseUrl).href,
      events: keys,
      identity: ctx.identity,
      max_events: max,
    });
    for (const plan of [...plans].reverse())
      if (plan.unsubscribePath)
        ctx.requests.push({
          method: "POST",
          path: plan.unsubscribePath,
          data: plan.body,
          identity: ctx.identity,
          phase: "cleanup",
        });
    return {};
  }
  if (!ctx.config.appId || !ctx.config.appSecret)
    throw new CliError(
      "auth",
      "Event WebSocket requires application credentials",
      { code: 3 },
    );
  if (!flags.force && (await eventStatus(ctx)).running)
    throw new CliError(
      "conflict",
      "An event listener is already running for this application",
      { hint: "Use event status/stop before starting another listener." },
    );
  const sdk = ctx.eventSDK ?? (await import("@larksuiteoapi/node-sdk"));
  let resolve, reject;
  const done = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  done.catch(() => {});
  let timer, client;
  const stateKey = `events-${ctx.config.storageKey}.json`,
    controlToken = randomBytes(32).toString("hex");
  const control = http.createServer((req, res) => {
    const received = Buffer.from(req.headers["x-lark-ka-control"] || ""),
      expected = Buffer.from(controlToken);
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.url === "/stop" && req.method === "POST") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('{"stopped":true}');
      resolve();
    } else if (req.url === "/status") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ running: true, pid: process.pid, events: keys }));
    } else res.writeHead(404).end();
  });
  await new Promise((r, j) => {
    control.once("error", j);
    control.listen(0, "127.0.0.1", r);
  });
  const log = {
    debug() {},
    info() {},
    warn(...args) {
      process.stderr.write(JSON.stringify({ warning: redact(args) }) + "\n");
    },
    error(...args) {
      process.stderr.write(JSON.stringify({ error: redact(args) }) + "\n");
    },
    trace() {},
  };
  const stop = () => resolve();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  ctx.signal?.addEventListener("abort", stop, { once: true });
  const cleanups = [];
  let stateWritten = false;
  try {
    let user = ctx.user ?? ctx.config.user;
    if (
      ctx.identity === "user" &&
      plans.some((plan) => plan.definition?.recipientField) &&
      !user?.open_id &&
      !user?.union_id &&
      !user?.user_id
    )
      user = await currentUser(ctx.config);
    for (const plan of plans)
      if (plan.subscribePath) {
        await ctx.request("POST", plan.subscribePath, {
          body: plan.body,
          identity: ctx.identity,
        });
        cleanups.push(plan);
      }
    const handlers = Object.fromEntries(
      plans.map((plan) => [
        plan.key,
        async (data) => {
          try {
            const scoped = await userEventTransform(ctx, plan, data, user);
            if (scoped !== undefined && (await publish(scoped, plan.key)))
              if (max && ++count >= max) resolve();
          } catch (e) {
            reject(e);
          }
          return {};
        },
      ]),
    );
    const dispatcher = new sdk.EventDispatcher({}).register(handlers);
    client = new sdk.WSClient({
      appId: ctx.config.appId,
      appSecret: ctx.config.appSecret,
      domain: ctx.config.openBaseUrl,
      logger: log,
      loggerLevel: sdk.LoggerLevel.error,
      onReady: () => {
        if (!flags.quiet)
          process.stderr.write(
            JSON.stringify({ event: "ready", events: keys }) + "\n",
          );
      },
      onError: (e) =>
        reject(new CliError("network", String(e.message || e), { code: 4 })),
    });
    await writeStore(stateKey, {
      pid: process.pid,
      events: keys,
      identity: ctx.identity,
      startedAt: new Date().toISOString(),
      controlUrl: `http://127.0.0.1:${control.address().port}`,
      controlToken,
    });
    stateWritten = true;
    if (ctx.signal?.aborted) resolve();
    else
      Promise.resolve(client.start({ eventDispatcher: dispatcher })).catch(
        reject,
      );
    if (timeout) timer = setTimeout(resolve, timeout * 1000);
    await done;
  } finally {
    clearTimeout(timer);
    try {
      client?.close({ force: true });
    } catch (e) {
      log.warn("Event transport close failed", e.message);
    }
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    ctx.signal?.removeEventListener("abort", stop);
    if (stateWritten) {
      const state = await readStore(stateKey, null).catch(() => null);
      if (state?.controlToken === controlToken)
        await unlink(path.join(configDir(), stateKey)).catch(() => {});
    }
    for (const plan of cleanups.reverse())
      try {
        if (ctx.cleanupRequest)
          await ctx.cleanupRequest("POST", plan.unsubscribePath, {
            body: plan.body,
            identity: ctx.identity,
            timeout: 5000,
          });
        else {
          const { createContext } = await import("./context.mjs");
          const cleanup = await createContext(
            { as: ctx.identity },
            { config: ctx.config, signal: AbortSignal.timeout(5000) },
          );
          await cleanup.request("POST", plan.unsubscribePath, {
            body: plan.body,
            identity: ctx.identity,
            timeout: 5000,
          });
        }
      } catch (e) {
        log.warn(`Could not unsubscribe ${plan.key}`, e.message);
      }
  }
  return STREAM_DONE;
}
async function controlRequest(ctx, action) {
  const state = await readStore(`events-${ctx.config.storageKey}.json`, null);
  if (!state) return { running: false };
  let url;
  try {
    url = new URL(state.controlUrl);
  } catch {
    return { running: false, orphan: true };
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !state.controlToken
  )
    return { running: false, orphan: true };
  try {
    const response = await fetch(new URL("/" + action, url), {
      method: action === "stop" ? "POST" : "GET",
      redirect: "error",
      headers: { "X-Lark-Ka-Control": state.controlToken },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return { running: false, orphan: true };
    return await response.json();
  } catch {
    return { running: false, orphan: true };
  }
}
export async function eventStatus(ctx) {
  return controlRequest(ctx, "status");
}
export async function eventStop(ctx) {
  const result = await controlRequest(ctx, "stop");
  return result.stopped ? result : { stopped: false, ...result };
}
