import {
  readFile,
  realpath,
  mkdir,
  writeFile,
  stat,
  open,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CliError } from "../errors.mjs";

export const services = [
  "calendar",
  "task",
  "mail",
  "okr",
  "vc",
  "minutes",
  "contact",
];
const catalog = {
  calendar: [
    "agenda",
    "create",
    "update",
    "freebusy",
    "room-find",
    "rsvp",
    "suggestion",
  ],
  task: [
    "create",
    "update",
    "set-ancestor",
    "comment",
    "complete",
    "reopen",
    "assign",
    "followers",
    "reminder",
    "get-my-tasks",
    "get-related-tasks",
    "search",
    "subscribe-event",
    "upload-attachment",
    "tasklist-create",
    "tasklist-search",
    "tasklist-task-add",
    "tasklist-members",
  ],
  mail: [
    "message",
    "messages",
    "thread",
    "triage",
    "watch",
    "reply",
    "reply-all",
    "send",
    "draft-create",
    "draft-send",
    "draft-edit",
    "forward",
    "send-receipt",
    "decline-receipt",
    "signature",
    "share-to-chat",
    "template-create",
    "template-update",
    "lint-html",
  ],
  okr: [
    "cycle-list",
    "cycle-detail",
    "progress-list",
    "progress-get",
    "progress-create",
    "progress-update",
    "progress-delete",
    "upload-image",
  ],
  vc: [
    "search",
    "notes",
    "recording",
    "meeting-join",
    "meeting-leave",
    "meeting-events",
  ],
  minutes: ["search", "download", "upload", "update", "speaker-replace"],
  contact: ["get-user", "search-user"],
};
export const commandSpecs = Object.fromEntries(
  Object.entries(catalog).flatMap(([service, commands]) =>
    commands.map((command) => [
      `${service} +${command}`,
      { service, command: `+${command}` },
    ]),
  ),
);

function fail(message, hint) {
  throw new CliError("validation", message, { hint, code: 2 });
}
const has = (f, k) => Object.hasOwn(f, k);
const text = (f, k, fallback = "") =>
  f[k] === undefined ? fallback : String(f[k]);
const yes = (f, k, fallback = false) =>
  f[k] === undefined ? fallback : ![false, "false", "0", 0].includes(f[k]);
const csv = (value) => [
  ...new Set(
    (Array.isArray(value) ? value : String(value ?? "").split(","))
      .map((x) => String(x).trim())
      .filter(Boolean),
  ),
];
const enc = (value) => encodeURIComponent(String(value));
function required(f, key) {
  const v = text(f, key).trim();
  if (!v) fail(`--${key} is required`);
  return v;
}
function count(f, key, fallback, min = 1, max = 100) {
  const n = Number(f[key] ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max)
    fail(`--${key} must be an integer between ${min} and ${max}`);
  return n;
}
const clean = (obj) =>
  Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== ""),
  );
async function json(ctx, value, fallback = {}) {
  if (value === undefined || value === "") return fallback;
  const raw = typeof value === "string" ? await ctx.input(value) : value;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    fail("Invalid JSON input");
  }
}
function guid(value) {
  if (String(value).startsWith("http")) {
    try {
      return new URL(value).searchParams.get("guid") || value;
    } catch {
      fail("Invalid task URL");
    }
  }
  return value;
}
function stamp(input, end = false) {
  if (input === undefined || input === "") {
    const d = new Date();
    d.setHours(end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, 0);
    return Math.floor(d.getTime() / 1000);
  }
  const s = String(input).replace(/^date:/, "");
  const rel = /^([+-]\d+)([mhdw])$/.exec(s);
  if (rel)
    return Math.floor(
      Date.now() / 1000 +
        Number(rel[1]) * { m: 60, h: 3600, d: 86400, w: 604800 }[rel[2]],
    );
  if (/^\d+$/.test(s))
    return s.length > 10 ? Math.floor(Number(s) / 1000) : Number(s);
  const date = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T${end ? "23:59:59" : "00:00:00"}` : s,
  );
  if (!Number.isFinite(date.getTime())) fail(`Invalid time: ${s}`);
  return Math.floor(date.getTime() / 1000);
}
const iso = (v, end) => new Date(stamp(v, end) * 1000).toISOString();
function timeRange(f, defaults = true) {
  const start = f.start !== undefined || defaults ? stamp(f.start) : undefined;
  let end = f.end !== undefined || defaults ? stamp(f.end, true) : undefined;
  if (defaults && f.start && !f.end) {
    const date = new Date(start * 1000);
    date.setHours(23, 59, 59, 0);
    end = Math.floor(date.getTime() / 1000);
  }
  if (start !== undefined && end !== undefined && end <= start)
    fail("--end must be after --start");
  return { start, end };
}
function taskTime(value) {
  return {
    timestamp: String(stamp(value) * 1000),
    is_all_day: /^date:|^\d{4}-\d{2}-\d{2}$|^[+-]\d+[dw]$/.test(String(value)),
  };
}
const taskQuery = { user_id_type: "open_id" };
const taskMember = (id, role) => ({
  id,
  role,
  type: id.startsWith("cli_") ? "app" : "user",
});
const taskSummary = (value) => ({ guid: value?.guid, url: value?.url });
function currentUser(ctx) {
  return (
    ctx.config?.userOpenId ||
    ctx.config?.user_open_id ||
    ctx.config?.user?.open_id ||
    ctx.user?.open_id ||
    ""
  );
}
async function paged(
  ctx,
  method,
  apiPath,
  options = {},
  f = {},
  force = false,
) {
  const limit = ctx.dryRun
    ? 1
    : yes(f, "page-all") || force
      ? count(f, "page-limit", 40, 1, 1000)
      : count(f, "page-limit", 20, 1, 1000);
  const query = { ...(options.query || {}) },
    body = options.body && { ...options.body };
  const items = [];
  const seen = new Set();
  let last = {};
  for (let page = 0; page < limit; page++) {
    last = await ctx.request(method, apiPath, { ...options, query, body });
    if (ctx.dryRun) return last;
    const batch =
      last.items ||
      last.tasks ||
      last.events ||
      last.messages ||
      last.users ||
      [];
    if (Array.isArray(batch)) items.push(...batch);
    const token = last.page_token || last.next_page_token;
    if (!last.has_more || !token) break;
    if (seen.has(token)) fail("Upstream returned a repeated pagination token");
    seen.add(token);
    if (method === "GET" || options.pageTokenInQuery) query.page_token = token;
    else if (body) body.page_token = token;
    else query.page_token = token;
  }
  return { ...last, items };
}
function attendees(value, me = "") {
  return csv([...csv(value), ...(me ? [me] : [])]).map((id) => {
    if (id.startsWith("ou_")) return { type: "user", user_id: id };
    if (id.startsWith("oc_")) return { type: "chat", chat_id: id };
    if (id.startsWith("omm_")) return { type: "resource", room_id: id };
    fail(`Invalid attendee ID: ${id}`);
  });
}

async function calendar(ctx, command, f) {
  const calendarId = text(f, "calendar-id", "primary") || "primary";
  const base = `/open-apis/calendar/v4/calendars/${enc(calendarId)}/events`;
  if (command === "agenda") {
    const { start, end } = timeRange(f);
    const data = await paged(
      ctx,
      "GET",
      `${base}/instance_view`,
      { query: { start_time: String(start), end_time: String(end) } },
      f,
    );
    if (ctx.dryRun) return data;
    return (data.items || [])
      .filter((x) => x.status !== "cancelled")
      .sort(
        (a, b) =>
          Number(a.start_time?.timestamp || 0) -
          Number(b.start_time?.timestamp || 0),
      );
  }
  if (command === "rsvp") {
    const status = required(f, "rsvp-status");
    if (!["accept", "decline", "tentative"].includes(status))
      fail("--rsvp-status must be accept, decline, or tentative");
    const event = required(f, "event-id");
    return ctx.request("POST", `${base}/${enc(event)}/reply`, {
      body: { rsvp_status: status },
    });
  }
  if (command === "create" || command === "update") {
    if (command === "create") {
      required(f, "start");
      required(f, "end");
    }
    if (has(f, "start") !== has(f, "end"))
      fail("--start and --end must be provided together");
    const body = clean({
      summary: f.summary,
      description: f.description,
      recurrence: f.rrule,
    });
    if (f.start !== undefined) {
      const { start, end } = timeRange(f);
      body.start_time = { timestamp: String(start) };
      body.end_time = { timestamp: String(end) };
    }
    if (command === "create") {
      Object.assign(body, {
        attendee_ability: "can_modify_event",
        free_busy_status: "busy",
        vchat: { vc_type: "vc" },
        reminders: [{ minutes: 5 }],
      });
      const invitees = f["attendee-ids"]
        ? attendees(
            f["attendee-ids"],
            ctx.identity === "user" ? currentUser(ctx) : "",
          )
        : [];
      const data = await ctx.request("POST", base, { body });
      const event = data.event || {};
      const id = event.event_id || (ctx.dryRun ? "<event_id>" : "");
      if (!id) fail("Create event response contains no event_id");
      if (invitees.length)
        await ctx.request("POST", `${base}/${enc(id)}/attendees`, {
          query: taskQuery,
          body: { attendees: invitees, need_notification: true },
        });
      return data;
    }
    const event = required(f, "event-id");
    const apiPath = `${base}/${enc(event)}`;
    const add = f["add-attendee-ids"] ? attendees(f["add-attendee-ids"]) : [];
    const remove = f["remove-attendee-ids"]
      ? attendees(f["remove-attendee-ids"])
      : [];
    if (!Object.keys(body).length && !add.length && !remove.length)
      fail("No event fields or attendee changes supplied");
    let data;
    if (Object.keys(body).length) {
      body.need_notification = yes(f, "notify", true);
      data = await ctx.request("PATCH", apiPath, { query: taskQuery, body });
    }
    if (remove.length)
      data = await ctx.request("POST", `${apiPath}/attendees/batch_delete`, {
        query: taskQuery,
        body: { delete_ids: remove, need_notification: yes(f, "notify", true) },
      });
    if (add.length)
      data = await ctx.request("POST", `${apiPath}/attendees`, {
        query: taskQuery,
        body: { attendees: add, need_notification: yes(f, "notify", true) },
      });
    return data;
  }
  if (command === "freebusy") {
    const { start, end } = timeRange(f);
    const userId = f["user-id"] || currentUser(ctx);
    if (!userId) fail("--user-id is required when no current user is known");
    return ctx.request("POST", "/open-apis/calendar/v4/freebusy/list", {
      body: {
        time_min: iso(start),
        time_max: iso(end),
        user_id: userId,
        need_rsvp_status: true,
      },
    });
  }
  if (command === "suggestion" || command === "room-find") {
    const ids = csv(f["attendee-ids"]);
    if (ctx.identity === "user" && currentUser(ctx)) ids.push(currentUser(ctx));
    for (const id of ids)
      if (!/^(ou_|oc_)/.test(id)) fail(`Invalid attendee ID: ${id}`);
    const common = clean({
      attendee_user_ids: [...new Set(ids.filter((x) => x.startsWith("ou_")))],
      attendee_chat_ids: [...new Set(ids.filter((x) => x.startsWith("oc_")))],
      event_rrule: f["event-rrule"],
      timezone: f.timezone,
    });
    if (command === "suggestion") {
      const { start, end } = timeRange(f);
      const body = {
        ...common,
        search_start_time: iso(start),
        search_end_time: iso(end),
      };
      if (f["duration-minutes"] !== undefined)
        body.duration_minutes = count(f, "duration-minutes", 30, 1, 1440);
      if (f.exclude)
        body.excluded_event_times = csv(f.exclude).map((r) => {
          const [a, b, ...extra] = r.split("~");
          if (!a || !b || extra.length)
            fail("--exclude must contain start~end time ranges");
          if (stamp(b, true) <= stamp(a))
            fail("Excluded interval end must follow start");
          return { event_start_time: iso(a), event_end_time: iso(b, true) };
        });
      return ctx.request("POST", "/open-apis/calendar/v4/freebusy/suggestion", {
        body,
      });
    }
    const slots = Array.isArray(f.slot) ? f.slot : f.slot ? [f.slot] : [];
    if (!slots.length) fail("--slot start~end is required");
    const body = {
      ...common,
      ...clean({
        city: f.city,
        building: f.building,
        floor: f.floor,
        room_name: f["room-name"],
        min_capacity:
          f["min-capacity"] === undefined
            ? undefined
            : count(f, "min-capacity", 0, 0, 100000),
        max_capacity:
          f["max-capacity"] === undefined
            ? undefined
            : count(f, "max-capacity", 0, 0, 100000),
      }),
    };
    if (
      body.min_capacity &&
      body.max_capacity &&
      body.min_capacity > body.max_capacity
    )
      fail("--min-capacity must not exceed --max-capacity");
    const results = [];
    for (const slot of slots) {
      const [start, end, ...extra] = String(slot).split("~");
      if (!start || !end || extra.length || stamp(end, true) <= stamp(start))
        fail("--slot must be a valid start~end range");
      const data = await ctx.request(
        "POST",
        "/open-apis/calendar/v4/freebusy/room_find",
        {
          body: {
            ...body,
            event_start_time: iso(start),
            event_end_time: iso(end, true),
          },
        },
      );
      results.push({ start, end, meeting_rooms: data.available_rooms || [] });
    }
    return { time_slots: results };
  }
}

async function task(ctx, command, f) {
  const base = "/open-apis/task/v2";
  const id = f["task-id"] && enc(guid(f["task-id"]));
  const taskPath = `${base}/tasks/${id}`;
  const req = (method, apiPath, body) =>
    ctx.request(method, apiPath, {
      query: taskQuery,
      ...(body === undefined ? {} : { body }),
    });
  if (["create", "update"].includes(command)) {
    const body = await json(ctx, f.data);
    if (!body || Array.isArray(body) || typeof body !== "object")
      fail("--data must be a JSON object");
    for (const key of ["summary", "description"])
      if (has(f, key)) body[key] = f[key];
    if (f.due) body.due = taskTime(f.due);
    if (command === "create") {
      if (!String(body.summary || "").trim())
        fail("--summary or data.summary is required");
      const members = [];
      if (f.assignee) members.push(taskMember(f.assignee, "assignee"));
      if (f.follower) members.push(taskMember(f.follower, "follower"));
      if (members.length) body.members = members;
      if (f["tasklist-id"])
        body.tasklists = [{ tasklist_guid: guid(f["tasklist-id"]) }];
      if (f["idempotency-key"]) body.client_token = f["idempotency-key"];
      const data = await req("POST", `${base}/tasks`, body);
      return ctx.dryRun ? data : taskSummary(data.task);
    }
    const ids = csv(required(f, "task-id"));
    if (!Object.keys(body).length) fail("No task fields to update");
    const tasks = [];
    for (const id of ids) {
      const data = await req("PATCH", `${base}/tasks/${enc(guid(id))}`, {
        task: body,
        update_fields: Object.keys(body),
      });
      tasks.push(ctx.dryRun ? data : taskSummary(data.task));
    }
    return { tasks };
  }
  if (["complete", "reopen"].includes(command)) {
    required(f, "task-id");
    let data;
    if (command === "complete") {
      data = await req("GET", taskPath);
      if (
        !ctx.dryRun &&
        data.task?.completed_at &&
        data.task.completed_at !== "0"
      )
        return taskSummary(data.task);
    }
    data = await req("PATCH", taskPath, {
      task: { completed_at: command === "reopen" ? "0" : String(Date.now()) },
      update_fields: ["completed_at"],
    });
    return ctx.dryRun ? data : taskSummary(data.task);
  }
  if (command === "comment") {
    const data = await req("POST", `${base}/comments`, {
      content: required(f, "content"),
      resource_id: guid(required(f, "task-id")),
      resource_type: "task",
    });
    return ctx.dryRun ? data : { id: data.comment?.id };
  }
  if (command === "set-ancestor") {
    required(f, "task-id");
    return req(
      "POST",
      `${taskPath}/set_ancestor_task`,
      f["ancestor-id"] ? { ancestor_guid: guid(f["ancestor-id"]) } : {},
    );
  }
  if (["assign", "followers"].includes(command)) {
    required(f, "task-id");
    if (!f.add && !f.remove) fail("Specify --add or --remove");
    let data;
    for (const action of ["add", "remove"])
      if (f[action])
        data = await req("POST", `${taskPath}/${action}_members`, {
          members: csv(f[action]).map((x) =>
            taskMember(x, command === "assign" ? "assignee" : "follower"),
          ),
          ...(action === "add" && f["idempotency-key"]
            ? { client_token: f["idempotency-key"] }
            : {}),
        });
    return ctx.dryRun
      ? data
      : { guid: guid(f["task-id"]), url: data?.task?.url };
  }
  if (command === "reminder") {
    required(f, "task-id");
    if (Boolean(f.set) === yes(f, "remove"))
      fail("Specify exactly one of --set or --remove");
    const match = f.set && /^(\d+)(m|h|d)$/.exec(f.set);
    if (f.set && !match)
      fail("--set must be a duration such as 15m, 1h, or 1d");
    const data = await req("GET", taskPath);
    const ids = (data.task?.reminders || []).map((x) => x.id).filter(Boolean);
    if (ids.length)
      await req("POST", `${taskPath}/remove_reminders`, { reminder_ids: ids });
    if (match)
      return req("POST", `${taskPath}/add_reminders`, {
        reminders: [
          {
            relative_fire_minute:
              Number(match[1]) * { m: 1, h: 60, d: 1440 }[match[2]],
          },
        ],
      });
    return ctx.dryRun
      ? data
      : { guid: guid(f["task-id"]), url: data.task?.url };
  }
  if (command === "subscribe-event")
    return req("POST", `${base}/task_v2/task_subscription`);
  if (command === "get-my-tasks" || command === "get-related-tasks") {
    const mine = command === "get-my-tasks";
    const query = {
      ...taskQuery,
      page_size: 50,
      ...(mine ? { type: "my_tasks" } : {}),
      ...clean({ page_token: f["page-token"] }),
    };
    if (mine && has(f, "complete")) query.completed = yes(f, "complete");
    if (!mine && has(f, "include-complete") && !yes(f, "include-complete"))
      query.completed = false;
    const data = await paged(
      ctx,
      "GET",
      mine ? `${base}/tasks` : `${base}/task_v2/list_related_task`,
      { query },
      f,
    );
    if (ctx.dryRun) return data;
    let items = data.items || [];
    if (f.query)
      items = items.filter((x) => String(x.summary || "").includes(f.query));
    if (f.created_at)
      items = items.filter(
        (x) => Number(x.created_at) >= stamp(f.created_at) * 1000,
      );
    if (f["due-start"])
      items = items.filter(
        (x) => Number(x.due?.timestamp) >= stamp(f["due-start"]) * 1000,
      );
    if (f["due-end"])
      items = items.filter(
        (x) => Number(x.due?.timestamp) <= stamp(f["due-end"], true) * 1000,
      );
    if (yes(f, "created-by-me"))
      items = items.filter((x) => x.creator?.id === currentUser(ctx));
    if (yes(f, "followed-by-me"))
      items = items.filter((x) =>
        x.members?.some(
          (m) => m.role === "follower" && m.id === currentUser(ctx),
        ),
      );
    return { ...data, items };
  }
  if (command === "search" || command === "tasklist-search") {
    const lists = command === "tasklist-search";
    const filter = {};
    for (const [flag, key] of Object.entries(
      lists
        ? { creator: "user_id" }
        : {
            creator: "creator_ids",
            assignee: "assignee_ids",
            follower: "follower_ids",
          },
    ))
      if (f[flag]) filter[key] = csv(f[flag]);
    if (has(f, "completed")) filter.is_completed = yes(f, "completed");
    const range = f[lists ? "create-time" : "due"];
    if (range) {
      const [a, b] = String(range).split(",");
      if (!a && !b) fail("Empty time range");
      filter[lists ? "create_time" : "due_time"] = clean({
        start_time: a ? iso(a) : undefined,
        end_time: b ? iso(b, true) : undefined,
      });
    }
    if (!f.query && !Object.keys(filter).length)
      fail("Provide --query or at least one search filter");
    const body = {
      query: f.query || "",
      ...clean({ page_token: f["page-token"] }),
      ...(Object.keys(filter).length ? { filter } : {}),
    };
    const resource = lists ? "tasklists" : "tasks";
    const data = await paged(
      ctx,
      "POST",
      `${base}/${resource}/search`,
      { body },
      f,
    );
    if (ctx.dryRun) return data;
    const items = [];
    for (const hit of data.items || []) {
      if (!hit.id) continue;
      const detail = await req("GET", `${base}/${resource}/${enc(hit.id)}`);
      items.push(detail[lists ? "tasklist" : "task"] || hit);
    }
    return { ...data, items };
  }
  if (command === "tasklist-create") {
    const tasks = await json(ctx, f.data, []);
    if (!Array.isArray(tasks)) fail("--data must be an array of tasks");
    const body = { name: required(f, "name") };
    if (f.member)
      body.members = csv(f.member).map((x) => taskMember(x, "editor"));
    const data = await req("POST", `${base}/tasklists`, body);
    const list = data.tasklist || {};
    const listId = list.guid || (ctx.dryRun ? "<tasklist_guid>" : "");
    if (!listId) fail("Create tasklist response has no guid");
    const created = [];
    for (const definition of tasks) {
      if (
        !definition ||
        typeof definition !== "object" ||
        Array.isArray(definition)
      )
        fail("Each task definition must be an object");
      const task = { ...definition, tasklists: [{ tasklist_guid: listId }] };
      if (typeof task.assignee === "string") {
        task.members = [taskMember(task.assignee, "assignee")];
        delete task.assignee;
      }
      created.push(await req("POST", `${base}/tasks`, task));
    }
    return { tasklist: list, tasks: created };
  }
  if (command === "tasklist-task-add") {
    const body = {
      tasklist_guid: guid(required(f, "tasklist-id")),
      ...clean({ section_guid: f["section-guid"] }),
    };
    const results = [];
    for (const taskId of csv(required(f, "task-id")))
      results.push(
        await req(
          "POST",
          `${base}/tasks/${enc(guid(taskId))}/add_tasklist`,
          body,
        ),
      );
    return { tasks: results };
  }
  if (command === "tasklist-members") {
    const apiPath = `${base}/tasklists/${enc(guid(required(f, "tasklist-id")))}`;
    if (f.set && (f.add || f.remove))
      fail("--set cannot be combined with --add or --remove");
    if (!f.set && !f.add && !f.remove) return req("GET", apiPath);
    let add = csv(f.add),
      remove = csv(f.remove);
    if (f.set) {
      const existing = await req("GET", apiPath);
      const before = (existing.tasklist?.members || []).map((x) => x.id);
      const after = csv(f.set);
      add = after.filter((x) => !before.includes(x));
      remove = before.filter((x) => !after.includes(x));
    }
    let data = {};
    for (const [action, ids] of [
      ["add", add],
      ["remove", remove],
    ])
      if (ids.length)
        data = await req("POST", `${apiPath}/${action}_members`, {
          members: ids.map((x) => taskMember(x, "editor")),
        });
    return data;
  }
  if (command === "upload-attachment") {
    const fields = {
      resource_id: required(f, "resource-id"),
      resource_type: text(f, "resource-type", "task"),
    };
    const query = { user_id_type: text(f, "user-id-type", "open_id") };
    return ctx.multipart("POST", `${base}/attachments/upload`, {
      fields,
      files: [{ field: "file", path: required(f, "file") }],
      query,
    });
  }
}

function positiveId(f, key) {
  const value = required(f, key);
  if (
    !/^\d+$/.test(value) ||
    BigInt(value) <= 0n ||
    BigInt(value) > 9223372036854775807n
  )
    fail(`--${key} must be a positive int64`);
  return value;
}
function contentV1(content) {
  if (!content || !Array.isArray(content.blocks))
    fail("--content must contain a blocks array");
  const style = (s) =>
    s &&
    clean({
      bold: s.bold,
      strikeThrough: s.strike_through,
      backColor: s.back_color,
      textColor: s.text_color,
      link: s.link,
    });
  return {
    blocks: content.blocks.map((b) =>
      clean({
        type: b.block_element_type,
        paragraph:
          b.paragraph &&
          clean({
            style: b.paragraph.style?.list
              ? {
                  list: clean({
                    type: b.paragraph.style.list.list_type,
                    indentLevel: b.paragraph.style.list.indent_level,
                    number: b.paragraph.style.list.number,
                  }),
                }
              : undefined,
            elements: (b.paragraph.elements || []).map((e) =>
              clean({
                type:
                  e.paragraph_element_type === "mention"
                    ? "person"
                    : e.paragraph_element_type || "textRun",
                textRun:
                  e.text_run &&
                  clean({
                    text: e.text_run.text,
                    style: style(e.text_run.style),
                  }),
                docsLink: e.docs_link,
                person: e.mention && { openId: e.mention.user_id },
              }),
            ),
          }),
        gallery: b.gallery && {
          imageList: (b.gallery.images || []).map((i) =>
            clean({
              fileToken: i.file_token,
              src: i.src,
              width: i.width,
              height: i.height,
            }),
          ),
        },
      }),
    ),
  };
}
async function okr(ctx, command, f) {
  const query = { user_id_type: text(f, "user-id-type", "open_id") };
  if (!["open_id", "union_id", "user_id"].includes(query.user_id_type))
    fail("Invalid --user-id-type");
  if (command === "cycle-list") {
    const data = await paged(
      ctx,
      "GET",
      "/open-apis/okr/v2/cycles",
      { query: { ...query, user_id: required(f, "user-id"), page_size: 100 } },
      f,
      true,
    );
    if (!f["time-range"] || ctx.dryRun) return data;
    const m = /^(\d{4})-(\d\d)--(\d{4})-(\d\d)$/.exec(f["time-range"]);
    if (!m) fail("--time-range must be YYYY-MM--YYYY-MM");
    const start = Date.UTC(+m[1], +m[2] - 1, 1);
    const end = Date.UTC(+m[3], +m[4], 1) - 1;
    if (+m[2] < 1 || +m[2] > 12 || +m[4] < 1 || +m[4] > 12 || start > end)
      fail("Invalid --time-range");
    return {
      ...data,
      items: (data.items || []).filter(
        (x) => Number(x.start_time) <= end && Number(x.end_time) >= start,
      ),
    };
  }
  if (command === "cycle-detail") {
    const id = positiveId(f, "cycle-id");
    const data = await paged(
      ctx,
      "GET",
      `/open-apis/okr/v2/cycles/${id}/objectives`,
      { query: { page_size: 100 } },
      f,
      true,
    );
    if (ctx.dryRun) return data;
    const objectives = [];
    for (const objective of data.items || []) {
      const kr = await paged(
        ctx,
        "GET",
        `/open-apis/okr/v2/objectives/${enc(objective.objective_id || objective.id)}/key_results`,
        { query: { page_size: 100 } },
        f,
        true,
      );
      objectives.push({ ...objective, key_results: kr.items || [] });
    }
    return { objectives };
  }
  if (command === "progress-list") {
    const target = positiveId(f, "target-id");
    const kind = required(f, "target-type");
    if (!["objective", "key_result"].includes(kind))
      fail("--target-type must be objective or key_result");
    const dept = text(f, "department-id-type", "open_department_id");
    if (!["open_department_id", "department_id"].includes(dept))
      fail("Invalid --department-id-type");
    return paged(
      ctx,
      "GET",
      `/open-apis/okr/v2/${kind === "objective" ? "objectives" : "key_results"}/${target}/progresses`,
      { query: { ...query, department_id_type: dept, page_size: 100 } },
      f,
      true,
    );
  }
  if (command === "progress-get")
    return ctx.request(
      "GET",
      `/open-apis/okr/v1/progress_records/${positiveId(f, "progress-id")}`,
      { query },
    );
  if (command === "progress-delete") {
    const id = positiveId(f, "progress-id");
    const data = await ctx.request(
      "DELETE",
      `/open-apis/okr/v1/progress_records/${id}`,
    );
    return ctx.dryRun ? data : { deleted: true, progress_id: id };
  }
  if (command === "progress-create" || command === "progress-update") {
    const body = {
      content: contentV1(await json(ctx, required(f, "content"))),
    };
    if (has(f, "progress-percent")) {
      const percent = Number(f["progress-percent"]);
      if (!Number.isFinite(percent) || Math.abs(percent) > 99999999999)
        fail("--progress-percent is out of range");
      body.progress_rate = { percent };
    }
    if (f["progress-status"]) {
      if (!body.progress_rate)
        fail("--progress-status requires --progress-percent");
      const status = { normal: 0, overdue: 1, done: 2 }[f["progress-status"]];
      if (status === undefined)
        fail("--progress-status must be normal, overdue, or done");
      body.progress_rate.status = status;
    }
    if (command === "progress-create") {
      const kind = required(f, "target-type");
      if (!["objective", "key_result"].includes(kind))
        fail("--target-type must be objective or key_result");
      Object.assign(body, {
        target_id: positiveId(f, "target-id"),
        target_type: kind === "objective" ? 2 : 3,
        source_title: text(f, "source-title", "created by lark-cli"),
        source_url: text(f, "source-url", `${ctx.config.openBaseUrl}/app`),
      });
      return ctx.request("POST", "/open-apis/okr/v1/progress_records/", {
        query,
        body,
      });
    }
    return ctx.request(
      "PUT",
      `/open-apis/okr/v1/progress_records/${positiveId(f, "progress-id")}`,
      { query, body },
    );
  }
  if (command === "upload-image") {
    const file = required(f, "file");
    if (!/\.(jpg|jpeg|png|gif|bmp)$/i.test(file))
      fail("--file must be a JPG, PNG, GIF, or BMP image");
    const kind = required(f, "target-type");
    if (!["objective", "key_result"].includes(kind))
      fail("--target-type must be objective or key_result");
    return ctx.multipart("POST", "/open-apis/okr/v1/images/upload", {
      fields: {
        target_id: positiveId(f, "target-id"),
        target_type: kind === "objective" ? 2 : 3,
      },
      files: [{ field: "file", path: file }],
    });
  }
}

function searchTimes(f) {
  const { start, end } = timeRange(f, false);
  return clean({
    start_time: start === undefined ? undefined : iso(start),
    end_time: end === undefined ? undefined : iso(end),
  });
}
async function meetingIdsFromEvents(ctx, events, needNotes = false) {
  const primary = await ctx.request(
    "POST",
    "/open-apis/calendar/v4/calendars/primary",
  );
  const calendarId =
    primary.calendars?.[0]?.calendar?.calendar_id ||
    primary.calendars?.[0]?.calendar_id ||
    primary.calendar?.calendar_id ||
    (ctx.dryRun ? "<calendar_id>" : "primary");
  const result = await ctx.request(
    "POST",
    `/open-apis/calendar/v4/calendars/${enc(calendarId)}/events/mget_instance_relation_info`,
    {
      body: {
        instance_ids: csv(events),
        need_meeting_instance_ids: true,
        ...(needNotes ? { need_meeting_notes: true } : {}),
      },
    },
  );
  if (ctx.dryRun) return ["<meeting_id>"];
  const relations =
    result.items ||
    result.instance_relation_info_list ||
    result.instance_relation_infos ||
    [];
  return [
    ...new Set(
      relations
        .flatMap((x) => [
          x.meeting_id,
          x.vchat?.meeting_id,
          ...(x.meeting_instance_ids || x.meeting_ids || []),
        ])
        .filter(Boolean)
        .map(String),
    ),
  ];
}
async function vc(ctx, command, f) {
  if (command === "meeting-join") {
    const number = required(f, "meeting-number");
    if (!/^\d{9}$/.test(number))
      fail("--meeting-number must contain exactly 9 digits");
    return ctx.request("POST", "/open-apis/vc/v1/bots/join", {
      body: {
        join_type: 1,
        join_identify: { meeting_no: number },
        ...clean({ password: f.password, call_id: f["call-id"] }),
      },
    });
  }
  if (command === "meeting-leave")
    return ctx.request("POST", "/open-apis/vc/v1/bots/leave", {
      body: { meeting_id: required(f, "meeting-id") },
    });
  if (command === "meeting-events") {
    const times = timeRange(f, false);
    return paged(
      ctx,
      "GET",
      "/open-apis/vc/v1/bots/events",
      {
        query: clean({
          meeting_id: required(f, "meeting-id"),
          page_size: count(f, "page-size", 20, 20, 100),
          page_token: f["page-token"],
          start_time:
            times.start === undefined ? undefined : String(times.start),
          end_time: times.end === undefined ? undefined : String(times.end),
        }),
      },
      { ...f, "page-limit": yes(f, "page-all") ? 1000 : 1 },
    );
  }
  if (command === "search") {
    const filter = clean({
      participant_ids: f["participant-ids"]
        ? csv(f["participant-ids"])
        : undefined,
      organizer_ids: f["organizer-ids"] ? csv(f["organizer-ids"]) : undefined,
      open_room_ids: f["room-ids"] ? csv(f["room-ids"]) : undefined,
    });
    const range = searchTimes(f);
    if (Object.keys(range).length) filter.start_time = range;
    return ctx.request("POST", "/open-apis/vc/v1/meetings/search", {
      query: clean({
        page_size: count(f, "page-size", 20, 1, 100),
        page_token: f["page-token"],
      }),
      body: {
        ...clean({ query: f.query }),
        ...(Object.keys(filter).length ? { meeting_filter: filter } : {}),
      },
    });
  }
  if (command === "recording" || command === "notes") {
    const selectors = [
      "meeting-ids",
      "calendar-event-ids",
      ...(command === "notes" ? ["minute-tokens"] : []),
    ].filter((k) => f[k]);
    if (selectors.length !== 1)
      fail(
        "Specify exactly one of --meeting-ids, --calendar-event-ids, or --minute-tokens (notes only)",
      );
    const results = [];
    if (f["minute-tokens"]) {
      for (const token of csv(f["minute-tokens"])) {
        const minute = await ctx.request(
          "GET",
          `/open-apis/minutes/v1/minutes/${enc(token)}`,
        );
        const noteId = minute.minute?.note_id || minute.note_id;
        const note =
          noteId || ctx.dryRun
            ? await ctx.request(
                "GET",
                `/open-apis/vc/v1/notes/${enc(noteId || "<note_id>")}`,
              )
            : undefined;
        const artifacts = await ctx.request(
          "GET",
          `/open-apis/minutes/v1/minutes/${enc(token)}/artifacts`,
        );
        results.push({ minute_token: token, minute, note, artifacts });
      }
    } else {
      const ids = f["meeting-ids"]
        ? csv(f["meeting-ids"])
        : await meetingIdsFromEvents(
            ctx,
            f["calendar-event-ids"],
            command === "notes",
          );
      for (const id of ids) {
        const apiPath = `/open-apis/vc/v1/meetings/${enc(id)}`;
        if (command === "recording") {
          results.push({
            meeting_id: id,
            ...(await ctx.request("GET", `${apiPath}/recording`)),
          });
          continue;
        }
        const meeting = await ctx.request("GET", apiPath, {
          query: { with_participants: true },
        });
        const noteId = meeting.meeting?.note_id || meeting.note_id;
        const note =
          noteId || ctx.dryRun
            ? await ctx.request(
                "GET",
                `/open-apis/vc/v1/notes/${enc(noteId || "<note_id>")}`,
              )
            : undefined;
        const recording = await ctx.request("GET", `${apiPath}/recording`);
        results.push({ meeting_id: id, meeting, note, recording });
      }
    }
    if (f["output-dir"]) {
      if (ctx.dryRun) return { results, output_dir: f["output-dir"] };
      const directory = await safeLocalDirectory(f["output-dir"]);
      for (let i = 0; i < results.length; i++) {
        const file = path.join(directory, `meeting-${i + 1}.json`);
        await writeFile(file, JSON.stringify(results[i], null, 2), {
          flag: yes(f, "overwrite") ? "w" : "wx",
          mode: 0o600,
        });
      }
    }
    return { results };
  }
}

async function minutes(ctx, command, f) {
  const base = "/open-apis/minutes/v1/minutes";
  if (command === "upload")
    return ctx.request("POST", `${base}/upload`, {
      body: { file_token: required(f, "file-token") },
    });
  if (command === "update")
    return ctx.request("PATCH", `${base}/${enc(required(f, "minute-token"))}`, {
      body: { topic: required(f, "topic") },
    });
  if (command === "speaker-replace") {
    const from = required(f, "from-user-id"),
      to = required(f, "to-user-id");
    if (!from.startsWith("ou_") || !to.startsWith("ou_") || from === to)
      fail("Speaker IDs must be different open_ids beginning with ou_");
    const token = required(f, "minute-token");
    return ctx.request("PUT", `${base}/${enc(token)}/transcript/speaker`, {
      body: { minute_token: token, from_user_id: from, to_user_id: to },
    });
  }
  if (command === "search") {
    const filter = {};
    for (const [flag, key] of [
      ["owner-ids", "owner_ids"],
      ["participant-ids", "participant_ids"],
    ])
      if (f[flag])
        filter[key] = csv(f[flag]).map((x) =>
          x === "me" ? currentUser(ctx) || fail("Current user is unknown") : x,
        );
    const range = searchTimes(f);
    if (Object.keys(range).length) filter.create_time = range;
    return ctx.request("POST", `${base}/search`, {
      query: clean({
        page_size: count(f, "page-size", 20, 1, 100),
        page_token: f["page-token"],
      }),
      body: {
        ...clean({ query: f.query }),
        ...(Object.keys(filter).length ? { filter } : {}),
      },
    });
  }
  if (command === "download") {
    const tokens = csv(required(f, "minute-tokens"));
    if (tokens.length > 50) fail("--minute-tokens accepts at most 50 tokens");
    if (tokens.some((token) => !/^[a-z0-9]+$/.test(token)))
      fail("Minute tokens must contain only lowercase alphanumeric characters");
    if (f.output && f["output-dir"])
      fail("--output and --output-dir cannot both be set");
    let outputFile = f.output ? await minuteOutputPath(String(f.output)) : "";
    let outputDirectory = f["output-dir"]
      ? await minuteOutputPath(String(f["output-dir"]))
      : "";
    if (outputFile) {
      let info;
      try {
        info = await stat(outputFile);
      } catch (error) {
        if (error.code !== "ENOENT")
          throw new CliError(
            "io",
            `Cannot access --output: ${error.code || error.message}`,
          );
      }
      if (info?.isDirectory() || tokens.length > 1) {
        if (info && !info.isDirectory())
          fail(
            "--output is a file; batch mode requires a directory (use --output-dir)",
          );
        outputDirectory = outputFile;
        outputFile = "";
      }
    }
    const results = [];
    for (const token of tokens) {
      const data = await ctx.request("GET", `${base}/${enc(token)}/media`);
      if (ctx.dryRun) {
        results.push(data);
        continue;
      }
      const url = data.download_url;
      if (!url) fail(`No download_url returned for minute ${token}`);
      if (yes(f, "url-only")) {
        results.push({ minute_token: token, download_url: url });
        continue;
      }
      const output =
        outputFile ||
        path.join(
          outputDirectory ||
            (await minuteOutputPath(path.join("minutes", token))),
          `${token}.mp4`,
        );
      if (!ctx.download) fail("Binary download is unavailable in this runtime");
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      results.push({
        minute_token: token,
        ...(await ctx.download(url, {
          output,
          overwrite: yes(f, "overwrite"),
          anonymous: true,
        })),
      });
    }
    return tokens.length === 1 ? results[0] : { results };
  }
}

async function minuteOutputPath(value) {
  if (!value || /[\0\r\n]/.test(value) || value.split(/[\\/]/).includes(".."))
    fail("Invalid minute output path");
  const root = await realpath(process.cwd());
  const target = path.resolve(value);
  let existing = target;
  for (;;) {
    try {
      const resolved = await realpath(existing);
      if (resolved !== root && !resolved.startsWith(root + path.sep))
        fail("Minute output path resolves outside the current directory");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  if (target !== root && !target.startsWith(root + path.sep))
    fail("Minute output path must remain within the current directory");
  return target;
}

async function contact(ctx, command, f) {
  if (command === "get-user") {
    if (!f["user-id"]) {
      if (ctx.identity === "bot")
        fail("--user-id is required for bot identity");
      const data = await ctx.request("GET", "/open-apis/authen/v1/user_info");
      return ctx.dryRun ? data : { user: data };
    }
    const query = { user_id_type: text(f, "user-id-type", "open_id") };
    if (ctx.identity === "bot")
      return ctx.request(
        "GET",
        `/open-apis/contact/v3/users/${enc(f["user-id"])}`,
        { query },
      );
    const data = await ctx.request(
      "POST",
      "/open-apis/contact/v3/users/basic_batch",
      { query, body: { user_ids: [f["user-id"]] } },
    );
    return ctx.dryRun ? data : { user: data.users?.[0] || {} };
  }
  if (command === "search-user") {
    const filter = {};
    const map = {
      "has-chatted": "has_contact",
      "exclude-external-users": "exclude_outer_contact",
      "left-organization": "is_resigned",
      "has-enterprise-email": "has_enterprise_email",
    };
    for (const [flag, key] of Object.entries(map))
      if (has(f, flag)) {
        if (!yes(f, flag))
          fail(
            `--${flag}=false is not supported; omit the flag to disable filtering`,
          );
        filter[key] = true;
      }
    if (f.query && f.queries)
      fail("--query and --queries are mutually exclusive");
    if (f.queries && f["user-ids"])
      fail("--queries and --user-ids are mutually exclusive");
    if (f["user-ids"]) {
      filter.user_ids = csv(f["user-ids"]).map((x) =>
        x === "me" ? currentUser(ctx) || fail("Current user is unknown") : x,
      );
      if (filter.user_ids.length > 100)
        fail("--user-ids accepts at most 100 IDs");
    }
    const queries = f.queries ? csv(f.queries) : [text(f, "query")];
    if (queries.length > 20 || queries.some((x) => [...x].length > 50))
      fail("Search accepts at most 20 queries of at most 50 characters");
    if (!queries.some(Boolean) && !Object.keys(filter).length)
      fail("Specify --query, --queries, --user-ids, or a search filter");
    const legacy =
      ctx.config?.brand === "gjgw" ||
      ctx.config?.capabilities?.contactSearch === "v1";
    const pageSize = count(f, "page-size", 20, 1, legacy ? 200 : 30);
    if (
      legacy &&
      (!f.query ||
        f.queries ||
        f["user-ids"] ||
        f.lang ||
        Object.keys(filter).length)
    )
      fail("This deployment supports --query keyword search only");
    const results = [];
    for (const query of queries) {
      const data = legacy
        ? await ctx.request("GET", "/open-apis/search/v1/user", {
            query: { query, page_size: pageSize },
          })
        : await ctx.request("POST", "/open-apis/contact/v3/users/search", {
            query: { page_size: pageSize },
            body: { query, ...(Object.keys(filter).length ? { filter } : {}) },
          });
      if (ctx.dryRun) {
        results.push(data);
        continue;
      }
      const users = data.users || data.items || [];
      results.push({
        ...data,
        users: users.map((user) => {
          const normalized = normalizeContact(user, f.lang, ctx.config?.brand);
          return f.queries
            ? { ...normalized, matched_query: query }
            : normalized;
        }),
      });
    }
    return results.length === 1
      ? results[0]
      : {
          users: results.flatMap((r) => r.users || []),
          queries: queries.map((query, i) => ({
            query,
            has_more: results[i]?.has_more || false,
          })),
        };
  }
}

function normalizeContact(user, lang, brand) {
  if (!user.meta_data)
    return {
      ...user,
      open_id: user.open_id || user.id,
      localized_name: user.localized_name || user.name || user.id,
    };
  const m = user.meta_data;
  const names = m.i18n_names || {};
  const locales = [
    lang && String(lang).toLowerCase().replaceAll("-", "_"),
    ...(brand === "lark" ? ["en_us", "zh_cn"] : ["zh_cn", "en_us"]),
    ...Object.keys(names).sort(),
  ];
  const display = user.display_info || "";
  const lines = display.split("\n");
  const last = lines.filter(Boolean).at(-1) || "";
  return {
    open_id: user.id,
    localized_name: locales.map((k) => names[k]).find(Boolean) || user.id,
    email: m.mail_address || "",
    enterprise_email: m.enterprise_mail_address || "",
    is_activated: Boolean(m.is_registered),
    is_cross_tenant: Boolean(m.is_cross_tenant),
    p2p_chat_id: m.chat_id || "",
    has_chatted: Boolean(m.chat_id),
    department: lines[1] || "",
    signature: m.description || "",
    chat_recency_hint: /^\[(.*)\]$/.exec(last)?.[1] || "",
    match_segments: [...display.matchAll(/<h>(.*?)<\/h>/g)].map((x) => x[1]),
  };
}

async function safeLocalFile(value) {
  if (
    !value ||
    path.isAbsolute(value) ||
    String(value).split(/[\\/]/).includes("..")
  )
    fail("File paths must be relative to the current directory without ..");
  const root = await realpath(process.cwd());
  const target = await realpath(path.resolve(value));
  if (target !== root && !target.startsWith(root + path.sep))
    fail("File path resolves outside the current directory");
  return target;
}
async function safeLocalDirectory(value) {
  if (path.isAbsolute(value) || String(value).split(/[\\/]/).includes(".."))
    fail("Output directory must be relative to the current directory");
  const target = path.resolve(value);
  await mkdir(target, { recursive: true, mode: 0o700 });
  return safeLocalFile(value || ".");
}

const mailboxPath = (mailbox, ...segments) =>
  `/open-apis/mail/v1/user_mailboxes/${[mailbox, ...segments].map(enc).join("/")}`;
const mailFormat = (f) => (yes(f, "html", true) ? "full" : "plain_text_full");
const blockedMailExtensions = new Set(
  "action apk app applescript asp awk bash bat bin cdxml chm cmd coffee com command cpl csh dart dll es exe fish gadget go hta inf1 ins inx ipa isu jar job js jse ksh lnk lua msc msh msh1 msh1xml msh2 msh2xml mshxml msi msp mst msu osx out paf php pif pl plist pls pm prg ps ps1 ps1xml ps2 ps2xml psc1 psc2 psd1 psdm1 psm1 pssc py pyc pyo pyw pyz pyzw rb reg rgs run scf scr sct sh shb shs tcsh terminal ts tsx u3p vb vbe vbs vbscript ws wsc wsf wsh zsh".split(
    " ",
  ),
);
function checkMailAttachmentName(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (blockedMailExtensions.has(ext))
    fail(`File extension .${ext} is not allowed as a mail attachment`);
}
function imageMime(name, buffer) {
  if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(name))
    fail("Inline images must be JPG, PNG, GIF, or WebP");
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return "image/jpeg";
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString())) return "image/gif";
  if (
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  fail("Inline image contents do not match a supported image format");
}
function normalizeMailMessage(msg, html = true) {
  const out = { ...msg };
  for (const key of Object.keys(out))
    if (key.startsWith("body_")) delete out[key];
  const decoded = (value) => {
    if (!value) return "";
    if (typeof value !== "string") return String(value);
    return /^[A-Za-z0-9+/_=-]+$/.test(value) && value.length % 4 !== 1
      ? Buffer.from(value, "base64url").toString("utf8")
      : value;
  };
  out.body_plain_text =
    decoded(msg.body_plain_text) || decoded(msg.body_preview);
  out.body_preview = decoded(msg.body_preview);
  if (html && msg.body_html) out.body_html = decoded(msg.body_html);
  if (msg.body_calendar) out.body_calendar = decoded(msg.body_calendar);
  out.attachments = msg.attachments || [];
  out.message_state_text =
    { 1: "received", 2: "sent", 3: "draft" }[msg.message_state] || "unknown";
  if (msg.internal_date && Number.isFinite(Number(msg.internal_date)))
    out.date_formatted = new Date(Number(msg.internal_date)).toISOString();
  out.priority_type_text =
    { 0: "unknown", 1: "high", 3: "normal", 5: "low" }[msg.priority_type] ||
    "unknown";
  return out;
}
function headerValue(value) {
  if (/[\r\n\0]/.test(String(value)))
    fail("Email header values must not contain CR/LF or NUL");
  return String(value);
}
function mailAddresses(value) {
  if (!value) return [];
  if (typeof value === "object" && !Array.isArray(value))
    return mailAddresses([value]);
  if (Array.isArray(value))
    return value
      .map((v) =>
        typeof v === "string"
          ? { mail_address: v }
          : {
              mail_address: v.mail_address || v.address || v.email,
              ...(v.name ? { name: v.name } : {}),
            },
      )
      .filter((x) => x.mail_address);
  const entries = [];
  let quoted = false,
    angle = false,
    start = 0,
    escaped = false;
  const raw = String(value);
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (!quoted && c === "<") angle = true;
    if (!quoted && c === ">") angle = false;
    if (!quoted && !angle && (c === "," || c === ";")) {
      entries.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(raw.slice(start));
  return entries
    .map((x) => x.trim())
    .filter(Boolean)
    .map((v) => {
      headerValue(v);
      const m = /^(.*?)\s*<([^<>]+)>$/.exec(v);
      const address = m ? m[2] : v;
      if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address))
        fail(`Invalid email address: ${v}`);
      return {
        mail_address: address,
        ...(m?.[1] ? { name: m[1].replace(/^"|"$/g, "").trim() } : {}),
      };
    });
}
const renderAddresses = (list) =>
  mailAddresses(list)
    .map((a) =>
      a.name
        ? `=?UTF-8?B?${Buffer.from(headerValue(a.name)).toString("base64")}?= <${headerValue(a.mail_address)}>`
        : headerValue(a.mail_address),
    )
    .join(", ");
const escapeHtml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const plainHtml = (s) =>
  String(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
function mimeHeaders(raw) {
  const [head, ...body] = raw.split(/\r?\n\r?\n/);
  return {
    headers: head.split(/\r?\n(?=[^ \t])/),
    body: body.join("\r\n\r\n"),
  };
}
function getHeader(headers, name) {
  return (
    headers
      .find(
        (x) => x.slice(0, x.indexOf(":")).toLowerCase() === name.toLowerCase(),
      )
      ?.slice(name.length + 1)
      .trim() || ""
  );
}
function setHeader(headers, name, value) {
  const copy = headers.filter(
    (x) => x.slice(0, x.indexOf(":")).toLowerCase() !== name.toLowerCase(),
  );
  if (value !== undefined && value !== "")
    copy.push(`${name}: ${headerValue(value)}`);
  return copy;
}
function patchMimeBody(raw, value, plainText = false) {
  let { headers, body } = mimeHeaders(raw);
  const type = getHeader(headers, "content-type");
  const boundary = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  if (/attachment/i.test(getHeader(headers, "content-disposition"))) return raw;
  if (boundary) {
    const marker = `--${boundary[1] || boundary[2]}`;
    const pieces = body.split(marker);
    body = pieces
      .map((part, i) =>
        i === 0 || part.startsWith("--")
          ? part
          : `\r\n${patchMimeBody(part.replace(/^\r?\n/, "").replace(/\r?\n$/, ""), value, plainText)}\r\n`,
      )
      .join(marker);
    return `${headers.join("\r\n")}\r\n\r\n${body}`;
  }
  if (type && !/^text\/(plain|html)/i.test(type)) return raw;
  const html = /text\/html/i.test(type);
  const resolved = html
    ? plainText
      ? `<p>${escapeHtml(value).replaceAll("\n", "<br/>")}</p>`
      : value
    : plainHtml(value);
  headers = setHeader(
    headers,
    "Content-Type",
    `${html ? "text/html" : "text/plain"}; charset=UTF-8`,
  );
  headers = setHeader(headers, "Content-Transfer-Encoding", "base64");
  return `${headers.join("\r\n")}\r\n\r\n${
    Buffer.from(resolved)
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") || ""
  }`;
}
function mimeTree(raw, id = "1", depth = 0) {
  if (depth > 40) fail("MIME nesting exceeds 40 levels");
  const { headers, body } = mimeHeaders(raw);
  const contentType = getHeader(headers, "Content-Type") || "text/plain";
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const node = {
    id,
    headers,
    body,
    raw,
    contentType,
    children: null,
    dirty: false,
  };
  if (match && /^multipart\//i.test(contentType)) {
    node.boundary = match[1] || match[2];
    const parts = body.split(`--${node.boundary}`);
    node.preamble = parts[0];
    node.children = [];
    node.epilogue = "";
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].startsWith("--")) {
        node.epilogue = parts[i].slice(2);
        break;
      }
      node.children.push(
        mimeTree(
          parts[i].replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
          `${id}.${node.children.length + 1}`,
          depth + 1,
        ),
      );
    }
  }
  return node;
}
function serializeMime(node) {
  if (!node.dirty && !node.children?.some(dirtyMime)) return node.raw;
  const body = node.children
    ? `${node.preamble || ""}--${node.boundary}\r\n${node.children.map(serializeMime).join(`\r\n--${node.boundary}\r\n`)}\r\n--${node.boundary}--${node.epilogue || "\r\n"}`
    : node.body;
  return `${node.headers.join("\r\n")}\r\n\r\n${body}`;
}
const dirtyMime = (node) =>
  node.dirty || Boolean(node.children?.some(dirtyMime));
const leaves = (node) =>
  node.children ? node.children.flatMap(leaves) : [node];
const bodyLeaves = (node) =>
  leaves(node).filter(
    (n) =>
      /^text\/(plain|html)/i.test(n.contentType) &&
      !/attachment/i.test(getHeader(n.headers, "Content-Disposition")) &&
      !getHeader(n.headers, "Content-ID"),
  );
function decodeMime(node) {
  const encoding = getHeader(
    node.headers,
    "Content-Transfer-Encoding",
  ).toLowerCase();
  let buffer;
  if (encoding === "base64")
    buffer = Buffer.from(node.body.replace(/\s/g, ""), "base64");
  else if (encoding === "quoted-printable")
    buffer = Buffer.from(
      node.body
        .replace(/=\r?\n/g, "")
        .replace(/=([\da-f]{2})/gi, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        ),
      "latin1",
    );
  else buffer = Buffer.from(node.body);
  const charset =
    /charset\s*=\s*"?([^;"\s]+)/i.exec(node.contentType)?.[1] || "utf-8";
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}
function setMimeContent(node, value) {
  const mediaType = node.contentType.split(";")[0];
  node.headers = setHeader(
    node.headers,
    "Content-Type",
    `${mediaType}; charset=UTF-8`,
  );
  node.headers = setHeader(node.headers, "Content-Transfer-Encoding", "base64");
  node.body =
    Buffer.from(value)
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") || "";
  node.dirty = true;
}
function quoteSplit(html) {
  const match =
    /<(?:blockquote|div\b[^>]*(?:class|id)=["'][^"']*(?:quote|original-message)[^"']*["'])/i.exec(
      html,
    );
  return match
    ? [html.slice(0, match.index), html.slice(match.index)]
    : [html, ""];
}
function managedDiv(html, marker) {
  const regex = new RegExp(
    `<div\\b[^>]*(?:class|id)=["'][^"']*${marker}[^"']*["'][^>]*>`,
    "i",
  );
  const match = regex.exec(html);
  if (!match) return "";
  let depth = 1;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = match.index + match[0].length;
  let tag;
  while ((tag = tags.exec(html))) {
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (!depth) return html.slice(match.index, tags.lastIndex);
  }
  return "";
}
function preserveManaged(old, value) {
  let inject = "";
  for (const marker of ["signature", "large-file-area"]) {
    const element = managedDiv(old, marker);
    if (element && !managedDiv(quoteSplit(value)[0], marker)) inject += element;
  }
  const [head, quote] = quoteSplit(value);
  return head + inject + quote;
}
function transformMailBody(tree, operation, value, kind) {
  const candidates = bodyLeaves(tree).filter(
    (n) => !kind || n.contentType.toLowerCase().startsWith(kind.toLowerCase()),
  );
  if (!candidates.length) fail(`Draft contains no ${kind || "text"} body part`);
  for (const node of candidates) {
    const old = decodeMime(node);
    const html = /^text\/html/i.test(node.contentType);
    let next;
    if (operation === "append_body") next = old + value;
    else if (operation === "set_reply_body") {
      const quote = html ? quoteSplit(old)[1] : /\n(?:On .+wrote:|>)/.exec(old);
      next = html
        ? preserveManaged(old, value + quote)
        : value + (quote ? old.slice(quote.index) : "");
    } else if (operation === "remove_signature") {
      const signature = managedDiv(old, "signature");
      next = signature ? old.replace(signature, "") : old;
    } else if (operation === "insert_signature") {
      const previous = managedDiv(old, "signature");
      const clean = previous ? old.replace(previous, "") : old;
      const [head, quote] = quoteSplit(clean);
      next = `${head}<div class="lark-mail-signature">${value}</div>${quote}`;
    } else
      next = html
        ? preserveManaged(old, value)
        : /<[a-z]/i.test(value)
          ? plainHtml(value)
          : value;
    setMimeContent(node, html ? lintHtml(next).cleaned_html : next);
  }
}
function addMimeLeaf(tree, file) {
  const cid = file.cid && headerValue(file.cid).replace(/^<|>$/g, "");
  if (cid && /[\s<>()]/.test(cid)) fail("Invalid inline cid");
  const name = headerValue(file.name).replaceAll('"', "");
  const raw = `Content-Type: ${headerValue(file.mime || "application/octet-stream")}; name="${name}"\r\nContent-Disposition: ${cid ? "inline" : "attachment"}; filename="${name}"\r\n${cid ? `Content-ID: <${cid}>\r\n` : ""}Content-Transfer-Encoding: base64\r\n\r\n${
    file.buffer
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") || ""
  }`;
  if (!tree.children || !/^multipart\/mixed/i.test(tree.contentType)) {
    const bodyHeaders = tree.headers.filter((h) =>
      /^(content-type|content-transfer-encoding|content-disposition|content-id):/i.test(
        h,
      ),
    );
    const previous = mimeTree(
      `${bodyHeaders.join("\r\n")}\r\n\r\n${tree.children ? serializeMime(tree).split("\r\n\r\n").slice(1).join("\r\n\r\n") : tree.body}`,
      `${tree.id}.1`,
    );
    tree.boundary = `lark-ka-${randomUUID()}`;
    tree.contentType = `multipart/mixed; boundary="${tree.boundary}"`;
    tree.headers = tree.headers.filter(
      (h) =>
        !/^(content-type|content-transfer-encoding|content-disposition|content-id):/i.test(
          h,
        ),
    );
    tree.headers.push(`Content-Type: ${tree.contentType}`);
    tree.children = [previous];
    tree.preamble = "";
    tree.epilogue = "\r\n";
  }
  tree.children.push(mimeTree(raw, `${tree.id}.${tree.children.length + 1}`));
  tree.dirty = true;
}
function removeMimeLeaf(tree, target, calendar = false) {
  let removed = false;
  if (tree.children) {
    tree.children = tree.children.filter((node) => {
      const cid = getHeader(node.headers, "Content-ID").replace(/^<|>$/g, "");
      const matches = calendar
        ? /^text\/calendar/i.test(node.contentType)
        : target?.part_id
          ? node.id === target.part_id
          : target?.cid
            ? cid === String(target.cid).replace(/^<|>$/g, "")
            : false;
      if (matches) {
        removed = true;
        return false;
      }
      if (removeMimeLeaf(node, target, calendar)) removed = true;
      return true;
    });
  }
  if (removed) tree.dirty = true;
  return removed;
}
function calendarICS(op) {
  const start = op.event_start || op.start,
    end = op.event_end || op.end,
    summary = op.event_summary || op.summary;
  if (!start || !end || !summary)
    fail("Calendar event requires summary, start, and end");
  if (stamp(end) <= stamp(start)) fail("Calendar event end must follow start");
  const date = (v) =>
    new Date(stamp(v) * 1000)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
  const quoted = (v) =>
    String(v || "")
      .replaceAll("\\", "\\\\")
      .replaceAll("\n", "\\n")
      .replaceAll(",", "\\,")
      .replaceAll(";", "\\;");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:${randomUUID()}\r\nDTSTAMP:${date(Date.now())}\r\nDTSTART:${date(start)}\r\nDTEND:${date(end)}\r\nSUMMARY:${quoted(summary)}\r\nLOCATION:${quoted(op.event_location || op.location)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
}
async function mailBody(ctx, f, bodyKey = "body", fileKey = "body-file") {
  if (has(f, bodyKey) && f[fileKey])
    fail(`--${bodyKey} and --${fileKey} are mutually exclusive`);
  return f[fileKey]
    ? readFile(await safeLocalFile(f[fileKey]), "utf8")
    : await ctx.input(text(f, bodyKey));
}
function lintHtml(body, details = false) {
  const errors = [],
    warnings = [];
  let cleaned = String(body);
  cleaned = cleaned.replace(
    /<(script|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    (full, tag) => {
      errors.push({
        rule_id: "unsafe-element",
        severity: "error",
        tag_or_attr: tag,
        hint: "Remove active content from email HTML",
      });
      return "";
    },
  );
  cleaned = cleaned.replace(
    /\s(on\w+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    (_, attr) => {
      errors.push({
        rule_id: "event-handler",
        severity: "error",
        tag_or_attr: attr,
        hint: "Email event handlers are removed",
      });
      return "";
    },
  );
  cleaned = cleaned.replace(
    /\b(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi,
    (_, attr) => {
      errors.push({
        rule_id: "unsafe-url",
        severity: "error",
        tag_or_attr: attr,
      });
      return `${attr}="#"`;
    },
  );
  if (/display\s*:\s*(flex|grid)/i.test(cleaned))
    warnings.push({
      rule_id: "mail-layout",
      severity: "warning",
      hint: "Use tables for email layouts that must work in all clients",
    });
  return { cleaned_html: cleaned, ...(details ? { warnings, errors } : {}) };
}
function buildRawMail({
  from,
  to,
  cc,
  bcc,
  subject,
  body,
  plainText,
  extraHeaders = {},
  attachments = [],
}) {
  const headers = [
    `From: ${renderAddresses(from)}`,
    `To: ${renderAddresses(to)}`,
    `Subject: =?UTF-8?B?${Buffer.from(headerValue(subject)).toString("base64")}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@lark-ka.local>`,
    "MIME-Version: 1.0",
  ];
  if (cc?.length) headers.push(`Cc: ${renderAddresses(cc)}`);
  if (bcc?.length) headers.push(`Bcc: ${renderAddresses(bcc)}`);
  for (const [key, value] of Object.entries(extraHeaders))
    headers.push(`${headerValue(key)}: ${headerValue(value)}`);
  const type =
    plainText || !/<[a-z][\s\S]*>/i.test(body) ? "text/plain" : "text/html";
  const part = `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${
    Buffer.from(body)
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") || ""
  }`;
  if (!attachments.length) return `${headers.join("\r\n")}\r\n${part}`;
  const boundary = `lark-ka-${randomUUID()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    part,
    ...attachments.map(
      (a) =>
        `Content-Type: ${headerValue(a.mime || "application/octet-stream")}; name="${headerValue(a.name).replaceAll('"', "")}"\r\nContent-Disposition: ${a.cid ? "inline" : "attachment"}; filename="${headerValue(a.name).replaceAll('"', "")}"\r\n${a.cid ? `Content-ID: <${headerValue(a.cid)}>\r\n` : ""}Content-Transfer-Encoding: base64\r\n\r\n${
          a.buffer
            .toString("base64")
            .match(/.{1,76}/g)
            ?.join("\r\n") || ""
        }`,
    ),
  ];
  return `${headers.join("\r\n")}\r\n\r\n--${boundary}\r\n${parts.join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--\r\n`;
}
async function localAttachments(ctx, f) {
  const files = csv(f.attach).map((file) => ({ file }));
  const inline = await json(ctx, f.inline, []);
  if (!Array.isArray(inline)) fail("--inline must be a JSON array");
  if (inline.length && yes(f, "plain-text"))
    fail("--inline cannot be combined with --plain-text");
  files.push(...inline.map((x) => ({ file: x.file_path, cid: x.cid })));
  const result = [];
  for (const file of files) {
    if (file.cid && !/^[\w.@+-]+$/.test(file.cid))
      fail("Invalid inline image cid");
    const name = path.basename(file.file);
    if (!file.cid) checkMailAttachmentName(name);
    const filePath = await safeLocalFile(file.file);
    const info = await stat(filePath);
    if (info.size > 3 * 1024 ** 3)
      fail("Mail attachment exceeds the 3 GiB limit");
    const buffer = file.cid ? await readFile(filePath) : undefined;
    const mime = file.cid ? imageMime(name, buffer) : undefined;
    result.push({
      name,
      path: filePath,
      size: info.size,
      cid: file.cid,
      buffer,
      mime,
    });
  }
  return result;
}

const mimeCost = (size) => Math.ceil(size / 3) * 4 + 200;
async function uploadMailMedia(ctx, file) {
  const parent = currentUser(ctx);
  if (!parent && !ctx.dryRun)
    fail("Attachment upload requires the current employee open_id");
  if (file.size <= 20 * 1024 ** 2) {
    const form = new FormData();
    form.set("file_name", file.name);
    form.set("parent_type", "email");
    form.set("parent_node", parent || "<user_open_id>");
    form.set("size", String(file.size));
    form.set(
      "file",
      new Blob([file.buffer || (await readFile(file.path))]),
      file.name,
    );
    const response = await ctx.request(
      "POST",
      "/open-apis/drive/v1/medias/upload_all",
      { body: form },
    );
    const key =
      response.file_token ||
      response.file_key ||
      (ctx.dryRun ? "<file_token>" : "");
    if (!key) fail("Attachment upload returned no file_token");
    return key;
  }
  const session = await ctx.request(
    "POST",
    "/open-apis/drive/v1/medias/upload_prepare",
    {
      body: {
        file_name: file.name,
        parent_type: "email",
        parent_node: parent || "<user_open_id>",
        size: file.size,
      },
    },
  );
  const uploadId = session.upload_id || (ctx.dryRun ? "<upload_id>" : "");
  const blockSize = Number(
    session.block_size || (ctx.dryRun ? 4 * 1024 ** 2 : 0),
  );
  const blockNum = Number(
    session.block_num || (ctx.dryRun ? Math.ceil(file.size / blockSize) : 0),
  );
  if (
    !uploadId ||
    !Number.isSafeInteger(blockSize) ||
    blockSize < 1 ||
    blockSize > 100 * 1024 ** 2 ||
    !Number.isSafeInteger(blockNum) ||
    blockNum < 1 ||
    Math.ceil(file.size / blockSize) !== blockNum
  )
    fail("Invalid attachment upload block plan");
  let handle;
  if (!file.buffer && !ctx.dryRun) handle = await open(file.path, "r");
  try {
    for (let seq = 0; seq < (ctx.dryRun ? 1 : blockNum); seq++) {
      const offset = seq * blockSize;
      const size = Math.min(blockSize, file.size - offset);
      let chunk = Buffer.alloc(ctx.dryRun ? 0 : size);
      if (!ctx.dryRun) {
        if (file.buffer) chunk = file.buffer.subarray(offset, offset + size);
        else {
          let read = 0;
          while (read < size) {
            const result = await handle.read(
              chunk,
              read,
              size - read,
              offset + read,
            );
            if (!result.bytesRead) fail("Attachment changed during upload");
            read += result.bytesRead;
          }
        }
      }
      const form = new FormData();
      form.set("upload_id", uploadId);
      form.set("seq", String(seq));
      form.set("size", String(size));
      form.set("file", new Blob([chunk]), file.name);
      await ctx.request("POST", "/open-apis/drive/v1/medias/upload_part", {
        body: form,
      });
    }
  } finally {
    await handle?.close();
  }
  const response = await ctx.request(
    "POST",
    "/open-apis/drive/v1/medias/upload_finish",
    { body: { upload_id: uploadId, block_num: blockNum } },
  );
  const token =
    response.file_token ||
    response.file_key ||
    (ctx.dryRun ? "<file_token>" : "");
  if (!token) fail("Attachment upload finish returned no file_token");
  return token;
}
function largeFileBody(ctx, files, html) {
  const web = ctx.config.webBaseUrl || ctx.config.openBaseUrl;
  if (html)
    return `<div id="large-file-area-${Date.now()}"><p>Large attachments</p>${files.map((f) => `<div id="large-file-item"><a href="${escapeHtml(`${web}/mail/page/attachment?token=${encodeURIComponent(f.token)}`)}">${escapeHtml(f.name)}</a> (${f.size || 0} bytes)</div>`).join("")}</div>`;
  return `\n\nLarge attachments\n${files.map((f) => `${f.name}: ${web}/mail/page/attachment?token=${encodeURIComponent(f.token)}`).join("\n")}`;
}
async function prepareMailAttachments(ctx, files, body, priorLarge = []) {
  let size = 2048 + mimeCost(Buffer.byteLength(body));
  const normal = [],
    large = [...priorLarge];
  let overflow = false;
  for (const file of files.filter((f) => f.cid)) {
    size += mimeCost(file.size ?? file.buffer?.length ?? 0);
    if (size > 25 * 1024 ** 2)
      fail("Inline images and email body exceed the 25 MiB MIME limit");
    normal.push({
      ...file,
      buffer: file.buffer || (await readFile(file.path)),
    });
  }
  for (const file of files.filter((f) => !f.cid)) {
    const bytes = file.size ?? file.buffer?.length ?? 0;
    overflow ||= size + mimeCost(bytes) > 25 * 1024 ** 2;
    if (overflow)
      large.push({
        name: file.name,
        size: bytes,
        token: await uploadMailMedia(ctx, { ...file, size: bytes }),
      });
    else {
      normal.push({
        ...file,
        buffer: file.buffer || (await readFile(file.path)),
      });
      size += mimeCost(bytes);
    }
  }
  return { normal, large };
}
async function fetchAttachmentBytes(ctx, url) {
  if (ctx.fetchBinary) return ctx.fetchBinary(url);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    fail("Attachment download URL requires HTTPS without credentials");
  const response = await fetch(parsed, {
    redirect: "error",
    signal: ctx.signal || AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new CliError("api", `Attachment download HTTP ${response.status}`, {
      code: 5,
    });
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 25 * 1024 ** 2)
      fail("Remote normal attachment exceeds MIME size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function remoteMailAttachments(ctx, api, resource, id, attachments = []) {
  const normal = [],
    large = [],
    needsDownload = [];
  for (const a of attachments) {
    const token = a.id || a.attachment_id || a.body;
    if (!token) continue;
    if (a.attachment_type === 2 && !a.is_inline)
      large.push({
        token,
        name: a.filename || token,
        size: Number(a.size || a.file_size || 0),
      });
    else needsDownload.push({ ...a, id: token });
  }
  for (let offset = 0; offset < needsDownload.length; offset += 20) {
    const batch = needsDownload.slice(offset, offset + 20);
    const result = await ctx.request(
      "GET",
      api(resource, id, "attachments", "download_url"),
      { query: { attachment_ids: batch.map((a) => a.id) } },
    );
    for (const a of batch) {
      const url =
        (result.download_urls || []).find((x) => x.attachment_id === a.id)
          ?.download_url || a.download_url;
      if (ctx.dryRun) {
        normal.push({
          name: a.filename || a.id,
          buffer: Buffer.alloc(0),
          size: 0,
          cid: a.is_inline ? a.cid : undefined,
        });
        continue;
      }
      if (!url) fail(`No download URL returned for attachment ${a.id}`);
      const buffer = await fetchAttachmentBytes(ctx, url);
      normal.push({
        name: a.filename || a.id,
        buffer,
        size: buffer.length,
        cid: a.is_inline ? a.cid : undefined,
      });
    }
  }
  return { normal, large };
}
async function mail(ctx, command, f) {
  const mailbox = text(f, "mailbox", text(f, "from", "me")) || "me";
  const api = (...segments) => mailboxPath(mailbox, ...segments);
  const message = async (id) => {
    const data = await ctx.request("GET", api("messages", id), {
      query: { format: mailFormat(f) },
    });
    return data.message || data;
  };
  if (command === "lint-html") {
    if (!f.body && !f["body-file"]) fail("Provide --body or --body-file");
    return lintHtml(await mailBody(ctx, f), yes(f, "show-lint-details"));
  }
  if (yes(f, "print-output-schema"))
    return {
      message_id: "string",
      thread_id: "string",
      subject: "string",
      body_html: "string",
      body_plain_text: "string",
      attachments: "array",
      from: "array",
      to: "array",
      cc: "array",
      labels: "array",
    };
  if (command === "message") {
    const data = await message(required(f, "message-id"));
    return ctx.dryRun ? data : normalizeMailMessage(data, yes(f, "html", true));
  }
  if (command === "messages") {
    const ids = csv(required(f, "message-ids"));
    const messages = [];
    for (let i = 0; i < ids.length; i += 20) {
      const data = await ctx.request("POST", api("messages", "batch_get"), {
        body: { message_ids: ids.slice(i, i + 20), format: mailFormat(f) },
      });
      messages.push(
        ...(data.messages || []).map((m) =>
          normalizeMailMessage(m, yes(f, "html", true)),
        ),
      );
    }
    return {
      messages,
      total: messages.length,
      unavailable_message_ids: ctx.dryRun
        ? []
        : ids.filter((id) => !messages.some((m) => m.message_id === id)),
    };
  }
  if (command === "thread") {
    const id = required(f, "thread-id");
    const data = await ctx.request("GET", api("threads", id), {
      query: {
        format: mailFormat(f),
        ...(yes(f, "include-spam-trash") ? { include_spam_trash: true } : {}),
      },
    });
    if (ctx.dryRun) return data;
    const messages = (data.thread?.messages || data.items || [])
      .map((x) => normalizeMailMessage(x.message || x, yes(f, "html", true)))
      .sort(
        (a, b) => Number(a.internal_date || 0) - Number(b.internal_date || 0),
      );
    return { thread_id: id, message_count: messages.length, messages };
  }
  if (command === "signature") {
    const data = await ctx.request("GET", api("signatures"));
    if (f.detail && !ctx.dryRun) {
      const signature = (data.signatures || data.items || []).find(
        (x) => String(x.signature_id || x.id) === String(f.detail),
      );
      if (!signature) fail(`Signature ${f.detail} not found`);
      return { signature };
    }
    return data;
  }
  if (command === "triage") {
    return mailTriage(ctx, f, api);
  }
  if (command === "watch") {
    return mailWatch(ctx, f, api, mailbox);
  }
  if (command === "decline-receipt") {
    const id = required(f, "message-id");
    const original = await message(id);
    const labels = original.label_ids || original.labels || [];
    if (
      !ctx.dryRun &&
      !labels.includes("READ_RECEIPT_REQUEST") &&
      !labels.includes("-607")
    )
      return { message_id: id, declined: false, already_cleared: true };
    await ctx.request("PUT", api("messages", id, "modify"), {
      body: { remove_label_ids: ["READ_RECEIPT_REQUEST"] },
    });
    return { message_id: id, declined: true };
  }
  if (command === "share-to-chat") {
    if (Boolean(f["message-id"]) === Boolean(f["thread-id"]))
      fail("Specify exactly one of --message-id or --thread-id");
    const id = required(f, "receive-id");
    const data = await ctx.request("POST", api("messages", "share_token"), {
      body: f["message-id"]
        ? { message_id: f["message-id"] }
        : { thread_id: f["thread-id"] },
    });
    const token =
      data.share_token || data.card_id || (ctx.dryRun ? "<card_id>" : "");
    if (!token) fail("Share token response contains no token");
    return ctx.request("POST", api("share_tokens", token, "send"), {
      query: { receive_id_type: text(f, "receive-id-type", "chat_id") },
      body: { receive_id: id },
    });
  }
  if (command === "draft-send") {
    const ids = csv(required(f, "draft-id"));
    const results = [];
    for (const id of ids) {
      try {
        results.push({
          draft_id: id,
          result: await ctx.request("POST", api("drafts", id, "send")),
        });
      } catch (error) {
        if (yes(f, "stop-on-error")) throw error;
        results.push({ draft_id: id, error: error.message });
      }
    }
    const failed = results.filter((x) => x.error).length;
    if (failed)
      throw new CliError(
        "partial_failure",
        `${failed} draft send operation(s) failed`,
        { code: 5, detail: { results, failed } },
      );
    return { results, failed };
  }
  if (command === "template-create" || command === "template-update")
    return mailTemplate(ctx, command, f, api);
  if (command === "draft-edit") return mailDraftEdit(ctx, f, api);
  if (
    [
      "send",
      "draft-create",
      "reply",
      "reply-all",
      "forward",
      "send-receipt",
    ].includes(command)
  )
    return mailCompose(ctx, command, f, api);
}

async function mailWatch(ctx, f, api, mailbox) {
  const mode = text(f, "msg-format", "metadata");
  if (
    !["metadata", "minimal", "plain_text_full", "event", "full"].includes(mode)
  )
    fail("Invalid --msg-format");
  const parseList = async (flag) => {
    const list = await json(ctx, f[flag], []);
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string"))
      fail(`--${flag} must be a JSON string array`);
    return list.map((x) => x.trim()).filter(Boolean);
  };
  const folderIds = new Set(await parseList("folder-ids")),
    labelIds = new Set(await parseList("label-ids"));
  for (const [flag, resource, set, systems] of [
    [
      "folders",
      "folders",
      folderIds,
      ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "ARCHIVE"],
    ],
    ["labels", "labels", labelIds, ["FLAGGED", "IMPORTANT", "UNREAD"]],
  ]) {
    const names = await parseList(flag);
    let items;
    for (const name of names) {
      if (systems.includes(name.toUpperCase())) {
        set.add(name.toUpperCase());
        continue;
      }
      if (ctx.dryRun) {
        set.add(name);
        continue;
      }
      items ||= (await ctx.request("GET", api(resource))).items || [];
      const hits = items.filter(
        (x) =>
          String(x.name).toLowerCase() === name.toLowerCase() || x.id === name,
      );
      if (hits.length !== 1)
        fail(`Mail ${resource} ${name} is missing or ambiguous`);
      set.add(hits[0].id);
    }
  }
  let address = mailbox;
  if (mailbox === "me") {
    const profile = await ctx.request("GET", api("profile"));
    address =
      profile.primary_email_address || profile.mailbox?.primary_email_address;
    if (!address && !ctx.dryRun)
      fail("Mailbox profile contains no primary_email_address");
  }
  const outputDir =
    f["output-dir"] && !ctx.dryRun
      ? await safeLocalDirectory(f["output-dir"])
      : undefined;
  await ctx.request("POST", api("event", "subscribe"), {
    body: { event_type: 1 },
  });
  if (ctx.dryRun)
    return {
      event: "mail.user_mailbox.event.message_received_v1",
      mailbox,
      msg_format: mode,
      folder_ids: [...folderIds],
      label_ids: [...labelIds],
    };
  if (!ctx.eventConsume)
    fail("WebSocket event consumption is unavailable in this runtime");
  const transformEvent = async (envelope) => {
    const event = envelope.event || envelope;
    if (
      !event.message_id ||
      (address &&
        String(event.mail_address).toLowerCase() !==
          String(address).toLowerCase())
    )
      return undefined;
    let message;
    if (mode !== "event" || folderIds.size || labelIds.size || outputDir) {
      const format =
        outputDir || mode === "full"
          ? "full"
          : mode === "plain_text_full"
            ? "plain_text_full"
            : "metadata";
      const data = await ctx.request(
        "GET",
        mailboxPath(
          event.mail_address || address,
          "messages",
          event.message_id,
        ),
        { query: { format } },
      );
      message = normalizeMailMessage(data.message || data, format === "full");
    }
    if (folderIds.size && !folderIds.has(message.folder_id)) return undefined;
    if (
      labelIds.size &&
      !(message.label_ids || []).some((x) => labelIds.has(x))
    )
      return undefined;
    if (outputDir)
      await writeFile(
        path.join(outputDir, `${Date.now()}-${enc(event.message_id)}.json`),
        JSON.stringify({ event, message }, null, 2),
        { mode: 0o600, flag: "wx" },
      );
    const payload =
      mode === "event"
        ? envelope
        : mode === "minimal"
          ? {
              message_id: event.message_id,
              mail_address: event.mail_address,
              folder_id: message.folder_id,
              label_ids: message.label_ids || [],
            }
          : message;
    return text(f, "format", "data") === "json"
      ? { ok: true, data: payload }
      : payload;
  };
  try {
    return await ctx.eventConsume(
      "mail.user_mailbox.event.message_received_v1",
      { ...f, transformEvent },
    );
  } finally {
    await ctx.request("POST", api("event", "unsubscribe"), {
      body: { event_type: 1 },
    });
  }
}

async function mailTriage(ctx, f, api) {
  const schema = {
    folder: "folder name",
    folder_id: "folder ID",
    label: "label name",
    label_id: "label ID",
    is_unread: "boolean",
    from: "email array",
    to: "email array",
    cc: "email array",
    bcc: "email array",
    subject: "string",
    has_attachment: "boolean",
    time_range: { start_time: "ISO time", end_time: "ISO time" },
  };
  if (yes(f, "print-filter-schema")) return schema;
  const filter = await json(ctx, f.filter);
  if (!filter || Array.isArray(filter) || typeof filter !== "object")
    fail("--filter must be an object");
  for (const key of Object.keys(filter))
    if (!Object.hasOwn(schema, key)) fail(`Unknown --filter field: ${key}`);
  const max = count(f, f["page-size"] ? "page-size" : "max", 20, 1, 400);
  if (f.query && [...f.query].length > 50)
    fail("--query must not exceed 50 characters");
  let token = "",
    tokenKind = "";
  if (f["page-token"]) {
    const match = /^(list|search):(.+)$/.exec(f["page-token"]);
    if (!match) fail("--page-token must use the list: or search: prefix");
    tokenKind = match[1];
    token = match[2];
  }
  const requiresSearch = Boolean(
    f.query ||
      [
        "from",
        "to",
        "cc",
        "bcc",
        "subject",
        "has_attachment",
        "time_range",
      ].some((k) => filter[k] !== undefined) ||
      filter.is_unread === false,
  );
  if (tokenKind === "list" && requiresSearch)
    fail("A list: token cannot be used with search filters");
  const search = tokenKind === "search" || requiresSearch;
  const kind = search ? "search" : "list";
  const resolve = async (resource, value, byName) => {
    const systems =
      resource === "folders"
        ? ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "ARCHIVE"]
        : ["FLAGGED", "IMPORTANT", "UNREAD"];
    const normalized = String(value).toUpperCase();
    if (systems.includes(normalized))
      return search ? normalized.toLowerCase() : normalized;
    if (ctx.dryRun) return value;
    const list = await ctx.request("GET", api(resource));
    const items = list.items || list[resource] || [];
    const matched = items.filter(
      (x) =>
        String(x.id) === String(value) ||
        String(x.name).toLowerCase() === String(value).toLowerCase(),
    );
    if (!matched.length) fail(`${resource} ${value} not found`);
    if (matched.length > 1 && byName)
      fail(`${resource} name is ambiguous; provide an explicit ID`);
    return search ? matched[0].name : matched[0].id;
  };
  const folder = filter.folder_id || filter.folder,
    label = filter.label_id || filter.label;
  if (folder && label && !search)
    fail("List filtering cannot use folder and label simultaneously");
  const query = {},
    body = clean({ query: f.query });
  const wireFilter = {};
  if (folder) {
    const resolved = await resolve("folders", folder, !filter.folder_id);
    if (search) wireFilter.folder = [resolved];
    else query.folder_id = resolved;
  }
  if (label) {
    const resolved = await resolve("labels", label, !filter.label_id);
    if (search) wireFilter.label = [resolved];
    else query.label_id = resolved;
  }
  if (!search && !label && !folder) query.folder_id = "INBOX";
  if (!search && filter.is_unread === true) query.only_unread = true;
  for (const key of [
    "from",
    "to",
    "cc",
    "bcc",
    "subject",
    "has_attachment",
    "is_unread",
  ])
    if (has(filter, key)) wireFilter[key] = filter[key];
  if (filter.time_range)
    wireFilter.create_time = clean({
      start_time: filter.time_range.start_time,
      end_time: filter.time_range.end_time,
    });
  if (search && Object.keys(wireFilter).length) body.filter = wireFilter;
  const items = [];
  let last = {},
    seen = new Set();
  do {
    query.page_size = Math.min(max - items.length, search ? 15 : 20);
    if (token) query.page_token = token;
    else delete query.page_token;
    last = await ctx.request(
      search ? "POST" : "GET",
      search ? api("search") : api("messages"),
      { query, ...(search ? { body } : {}) },
    );
    if (ctx.dryRun) break;
    items.push(...(last.items || last.messages || []));
    token = last.page_token || last.next_page_token || "";
    if (last.has_more && token) {
      if (seen.has(token)) fail("Mail pagination did not advance");
      seen.add(token);
    }
  } while (last.has_more && token && items.length < max);
  if (search && !yes(f, "labels"))
    return ctx.dryRun
      ? last
      : {
          ...last,
          items: items.slice(0, max),
          page_token: token ? `${kind}:${token}` : "",
        };
  const ids = items
    .map((x) => (typeof x === "string" ? x : x.message_id || x.id))
    .filter(Boolean);
  if (ctx.dryRun)
    return ctx.request("POST", api("messages", "batch_get"), {
      body: { message_ids: ["<message_id>"], format: "metadata" },
    });
  const messages = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = await ctx.request("POST", api("messages", "batch_get"), {
      body: { message_ids: ids.slice(i, i + 20), format: "metadata" },
    });
    messages.push(...(batch.messages || []));
  }
  return {
    ...last,
    messages,
    total: messages.length,
    page_token: token ? `${kind}:${token}` : "",
  };
}

async function mailCompose(ctx, command, f, api) {
  if (
    f["send-time"] &&
    (!/^\d+$/.test(String(f["send-time"])) ||
      Number(f["send-time"]) < Date.now() / 1000 + 300)
  )
    fail("--send-time must be at least five minutes in the future");
  if (f["send-time"] && !yes(f, "confirm-send"))
    fail("--send-time requires --confirm-send");
  let body = await mailBody(ctx, f),
    subject = text(f, "subject");
  let to = mailAddresses(f.to),
    cc = mailAddresses(f.cc),
    bcc = mailAddresses(f.bcc);
  let original;
  const extraHeaders = {};
  const remoteFiles = [],
    priorLarge = [];
  if (["reply", "reply-all", "forward", "send-receipt"].includes(command)) {
    const data = await ctx.request(
      "GET",
      api("messages", required(f, "message-id")),
      { query: { format: mailFormat(f) } },
    );
    original = normalizeMailMessage(data.message || data);
  }
  if (f["template-id"]) {
    const data = await ctx.request("GET", api("templates", f["template-id"]));
    const template = data.template || data;
    if (template.attachments?.length) {
      const loaded = await remoteMailAttachments(
        ctx,
        api,
        "templates",
        f["template-id"],
        template.attachments,
      );
      remoteFiles.push(...loaded.normal);
      priorLarge.push(...loaded.large);
    }
    subject ||= template.subject || "";
    const templateBody = template.is_plain_text_mode
      ? plainHtml(template.template_content || "")
      : template.template_content || "";
    body = body
      ? body +
        (template.is_plain_text_mode ? "\n\n" : "<br><br>") +
        templateBody
      : templateBody;
    to.push(...mailAddresses(template.tos));
    cc.push(...mailAddresses(template.ccs));
    bcc.push(...mailAddresses(template.bccs));
    if (template.is_plain_text_mode) f = { ...f, "plain-text": true };
  }
  const profile = await ctx.request("GET", api("profile"));
  let from =
    f.from && f.from !== "me"
      ? f.from
      : profile.primary_email_address ||
        profile.mailbox?.primary_email_address ||
        (ctx.dryRun ? "sender@example.invalid" : "");
  if (!from)
    fail("Mailbox profile contains no primary_email_address; specify --from");
  headerValue(from);
  if (original) {
    const sourceSubject = original.subject || "";
    if (!subject)
      subject = `${command === "forward" ? "Fwd:" : command === "send-receipt" ? "Read receipt:" : "Re:"} ${sourceSubject}`;
    const senders = mailAddresses(
      original.reply_to ||
        original.head_from ||
        original.from ||
        original.sender,
    );
    if (["reply", "reply-all", "send-receipt"].includes(command) && !to.length)
      to = senders;
    if (command === "reply-all") {
      to = mailAddresses([...to, ...mailAddresses(original.to)]);
      cc = mailAddresses([...cc, ...mailAddresses(original.cc)]);
      const remove = new Set([...csv(f.remove), from]);
      to = to.filter((x) => !remove.has(x.mail_address));
      cc = cc.filter((x) => !remove.has(x.mail_address));
    }
    const messageId =
      original.reply_to_smtp_message_id ||
      original.smtp_message_id ||
      original.internet_message_id ||
      original.rfc_message_id;
    if (messageId && command !== "forward") {
      extraHeaders["In-Reply-To"] = messageId;
      extraHeaders.References = [
        ...(Array.isArray(original.references)
          ? original.references
          : original.references
            ? [original.references]
            : []),
        messageId,
      ]
        .filter(Boolean)
        .join(" ");
    }
    if (command === "send-receipt") {
      const labels = original.label_ids || original.labels || [];
      if (
        !ctx.dryRun &&
        !labels.includes("READ_RECEIPT_REQUEST") &&
        !labels.includes("-607")
      )
        fail("The original message did not request a read receipt");
      body = `Your message “${sourceSubject}” was read at ${new Date().toISOString()}.`;
      extraHeaders["X-Lark-Read-Receipt-Mail"] = "1";
    } else {
      const quoted =
        original.body_html || original.body_plain_text || original.body || "";
      body += `<br/><blockquote>${/<[a-z]/i.test(quoted) ? quoted : escapeHtml(quoted)}</blockquote>`;
    }
    const inherited =
      command === "forward"
        ? original.attachments || []
        : (original.attachments || []).filter((a) => a.is_inline);
    if (inherited.length) {
      const loaded = await remoteMailAttachments(
        ctx,
        api,
        "messages",
        f["message-id"],
        inherited,
      );
      remoteFiles.push(...loaded.normal);
      priorLarge.push(...loaded.large);
    }
  }
  if (
    has(f, "signature-id") &&
    f["signature-id"] !== "none" &&
    f["signature-id"] !== "0"
  ) {
    const data = await ctx.request("GET", api("signatures"));
    const signature = (data.signatures || data.items || []).find(
      (x) => String(x.id || x.signature_id) === String(f["signature-id"]),
    );
    if (!signature && !ctx.dryRun) fail("Requested signature not found");
    body += signature?.body || signature?.content || "";
  }
  if (!ctx.dryRun && !to.length && !cc.length && !bcc.length)
    fail("At least one recipient is required");
  if (!subject.trim()) fail("--subject or a template subject is required");
  if (!body.trim()) fail("--body or --body-file is required");
  if (to.length + cc.length + bcc.length > 500)
    fail("A message may have at most 500 recipients");
  if (yes(f, "request-receipt"))
    extraHeaders["Disposition-Notification-To"] = from;
  if (f.priority) {
    const p = { high: "1", normal: "", low: "5" }[f.priority];
    if (p === undefined) fail("--priority must be high, normal, or low");
    if (p) extraHeaders["X-Cli-Priority"] = p;
  }
  const lint = lintHtml(body, true);
  body = lint.cleaned_html;
  const inline = await json(ctx, f.inline, []);
  if (!Array.isArray(inline)) fail("--inline must be an array");
  for (const match of body.matchAll(
    /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
  )) {
    if (/^(https?:|cid:|data:)/i.test(match[1])) continue;
    const cid = randomUUID();
    inline.push({ cid, file_path: match[1] });
    body = body.replaceAll(match[1], `cid:${cid}`);
  }
  const files = [
    ...remoteFiles,
    ...(await localAttachments(ctx, { ...f, inline })),
  ];
  const prepared = await prepareMailAttachments(ctx, files, body, priorLarge);
  const attachments = prepared.normal;
  if (prepared.large.length) {
    const html = !yes(f, "plain-text") && /<[a-z]/i.test(body);
    body += largeFileBody(ctx, prepared.large, html);
    extraHeaders["X-Lms-Large-Attachment-Ids"] = Buffer.from(
      JSON.stringify(
        [...new Set(prepared.large.map((x) => x.token))].map((id) => ({ id })),
      ),
    ).toString("base64");
  }
  if (f["event-start"] || f["event-end"] || f["event-summary"]) {
    const summary = required(f, "event-summary");
    required(f, "event-start");
    required(f, "event-end");
    const date = (v) =>
      new Date(stamp(v) * 1000)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
    const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:${randomUUID()}\r\nDTSTAMP:${date(Date.now())}\r\nDTSTART:${date(f["event-start"])}\r\nDTEND:${date(f["event-end"])}\r\nSUMMARY:${headerValue(summary)}\r\nLOCATION:${headerValue(f["event-location"] || "")}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    attachments.push({
      name: "invite.ics",
      mime: "text/calendar; method=REQUEST",
      buffer: Buffer.from(ics),
    });
  }
  const raw = Buffer.from(
    buildRawMail({
      from,
      to,
      cc,
      bcc,
      subject,
      body,
      plainText: yes(f, "plain-text"),
      extraHeaders,
      attachments,
    }),
  ).toString("base64url");
  const created = await ctx.request("POST", api("drafts"), { body: { raw } });
  const draft = created.draft || created;
  const id = draft.draft_id || draft.id || (ctx.dryRun ? "<draft_id>" : "");
  if (!id) fail("Draft create response contains no draft_id");
  const send = command === "send-receipt" || yes(f, "confirm-send");
  if (send) {
    const sendTime = f["send-time"];
    const sent = await ctx.request("POST", api("drafts", id, "send"), {
      ...(sendTime ? { body: { send_time: String(sendTime) } } : {}),
    });
    return {
      ...sent,
      draft_id: id,
      sent: true,
      ...(yes(f, "show-lint-details") ? { lint } : {}),
    };
  }
  return {
    draft_id: id,
    saved_as_draft: true,
    ...created,
    ...(yes(f, "show-lint-details") ? { lint } : {}),
  };
}

async function mailTemplate(ctx, command, f, api) {
  if (yes(f, "print-patch-template"))
    return {
      name: "",
      subject: "",
      template_content: "",
      is_plain_text_mode: false,
      tos: [],
      ccs: [],
      bccs: [],
    };
  const updating = command === "template-update";
  const id = updating ? required(f, "template-id") : "";
  let template = {};
  if (updating) {
    const data = await ctx.request("GET", api("templates", id));
    template = data.template || data;
    if (yes(f, "inspect")) return { template };
  }
  const prefix = updating ? "set-" : "";
  if (!updating) template.name = required(f, "name");
  for (const key of ["name", "subject"])
    if (has(f, prefix + key)) template[key] = f[prefix + key];
  if (
    has(f, prefix + "template-content") ||
    f[prefix + "template-content-file"]
  )
    template.template_content = await mailBody(
      ctx,
      f,
      prefix + "template-content",
      prefix + "template-content-file",
    );
  for (const [flag, key] of [
    ["to", "tos"],
    ["cc", "ccs"],
    ["bcc", "bccs"],
  ])
    if (has(f, prefix + flag)) template[key] = mailAddresses(f[prefix + flag]);
  if (has(f, prefix + "plain-text"))
    template.is_plain_text_mode = yes(f, prefix + "plain-text");
  if (!updating && template.is_plain_text_mode === undefined)
    template.is_plain_text_mode = yes(f, "plain-text");
  if (f["patch-file"])
    Object.assign(template, await json(ctx, `@${f["patch-file"]}`));
  if ([...(template.name || "")].length > 100)
    fail("Template name must not exceed 100 characters");
  const uploads = csv(f.attach).map((file) => ({ file }));
  let body = template.template_content || "";
  for (const match of body.matchAll(
    /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
  ))
    if (!/^(https?:|cid:|data:)/i.test(match[1]))
      uploads.push({ file: match[1], cid: randomUUID() });
  let estimated = 2048 + mimeCost(Buffer.byteLength(body));
  let oversized = false;
  for (const upload of uploads) {
    const filename = path.basename(upload.file);
    if (!upload.cid) checkMailAttachmentName(filename);
    const filePath = await safeLocalFile(upload.file);
    const info = await stat(filePath);
    if (info.size > 3 * 1024 ** 3) fail("Template attachment exceeds 3 GiB");
    if (upload.cid) imageMime(filename, await readFile(filePath));
    const key = await uploadMailMedia(ctx, {
      name: filename,
      path: filePath,
      size: info.size,
    });
    if (!upload.cid)
      oversized ||= estimated + mimeCost(info.size) > 25 * 1024 ** 2;
    const type = !upload.cid && oversized ? 2 : 1;
    if (type === 1) estimated += mimeCost(info.size);
    (template.attachments ||= []).push({
      id: key,
      body: key,
      filename,
      is_inline: Boolean(upload.cid),
      attachment_type: type,
      ...(upload.cid ? { cid: upload.cid } : {}),
    });
    if (upload.cid) body = body.replaceAll(upload.file, `cid:${upload.cid}`);
  }
  template.template_content = body;
  return ctx.request(
    updating ? "PUT" : "POST",
    updating ? api("templates", id) : api("templates"),
    { body: { template } },
  );
}

async function mailDraftEdit(ctx, f, api) {
  if (yes(f, "print-patch-template"))
    return {
      ops: [
        { op: "set_subject", value: "Subject" },
        { op: "set_body", value: "<p>Body</p>" },
        {
          op: "set_recipients",
          field: "to",
          addresses: [{ address: "person@example.com", name: "Person" }],
        },
        { op: "add_attachment", path: "./file.pdf" },
        { op: "set_header", name: "X-Header", value: "value" },
      ],
      supported_ops: [
        "set_subject",
        "set_recipients",
        "add_recipient",
        "remove_recipient",
        "set_reply_to",
        "clear_reply_to",
        "set_body",
        "set_reply_body",
        "replace_body",
        "append_body",
        "set_header",
        "remove_header",
        "add_attachment",
        "remove_attachment",
        "add_inline",
        "replace_inline",
        "remove_inline",
        "insert_signature",
        "remove_signature",
        "set_calendar",
        "remove_calendar",
      ],
    };
  const id = required(f, "draft-id");
  const data = await ctx.request("GET", api("drafts", id), {
    query: { format: "raw" },
  });
  let raw = Buffer.from(
    data.draft?.raw || data.raw || "",
    "base64url",
  ).toString("utf8");
  if (!raw && !ctx.dryRun) fail("Draft response has no raw MIME content");
  if (!raw) raw = "Content-Type: text/html; charset=UTF-8\r\n\r\n";
  const tree = mimeTree(raw);
  if (yes(f, "inspect")) {
    const body = bodyLeaves(tree);
    const attachments = leaves(tree)
      .filter(
        (n) =>
          /attachment|inline/i.test(
            getHeader(n.headers, "Content-Disposition"),
          ) || getHeader(n.headers, "Content-ID"),
      )
      .map((n) => ({
        part_id: n.id,
        cid: getHeader(n.headers, "Content-ID").replace(/^<|>$/g, ""),
        content_type: n.contentType.split(";")[0],
        filename: /filename="?([^;"\r\n]+)/i.exec(
          getHeader(n.headers, "Content-Disposition"),
        )?.[1],
      }));
    return {
      draft_id: id,
      projection: {
        subject: getHeader(tree.headers, "Subject"),
        from: getHeader(tree.headers, "From"),
        to: getHeader(tree.headers, "To"),
        cc: getHeader(tree.headers, "Cc"),
        has_quoted_content: body.some((n) =>
          Boolean(quoteSplit(decodeMime(n))[1]),
        ),
        body_text: body
          .filter((n) => /^text\/plain/i.test(n.contentType))
          .map(decodeMime)
          .join("\n"),
        body_html_summary: body
          .filter((n) => /^text\/html/i.test(n.contentType))
          .map((n) => decodeMime(n).slice(0, 500))
          .join("\n"),
        attachments_summary: attachments.filter((x) => !x.cid),
        inline_summary: attachments.filter((x) => x.cid),
      },
    };
  }
  const patch = f["patch-file"] ? await json(ctx, `@${f["patch-file"]}`) : {};
  if (!Array.isArray(patch.ops || [])) fail("Patch ops must be an array");
  const ops = [...(patch.ops || [])];
  for (const key of ["subject", "to", "cc", "bcc"])
    if (has(f, `set-${key}`))
      ops.push({ op: `set_${key}`, value: f[`set-${key}`] });
  if (f["set-priority"]) {
    const priority = { high: "1", normal: "", low: "5" }[f["set-priority"]];
    if (priority === undefined)
      fail("--set-priority must be high, normal, or low");
    ops.push({ op: "set_header", name: "X-Cli-Priority", value: priority });
  }
  if (yes(f, "request-receipt"))
    ops.push({
      op: "set_header",
      name: "Disposition-Notification-To",
      value: getHeader(tree.headers, "From"),
    });
  if (has(f, "body") || f["body-file"]) {
    if (ops.some((op) => ["set_body", "set_reply_body"].includes(op.op)))
      fail(
        "Direct --body and patch-file body operations are mutually exclusive",
      );
    ops.push({ op: "set_body", value: await mailBody(ctx, f) });
  }
  if (f["set-event-start"] || f["set-event-end"] || f["set-event-summary"])
    ops.push({
      op: "set_calendar",
      event_summary: f["set-event-summary"],
      event_start: f["set-event-start"],
      event_end: f["set-event-end"],
      event_location: f["set-event-location"],
    });
  if (yes(f, "remove-event")) ops.push({ op: "remove_calendar" });
  if (!ops.length) fail("No supported draft edit operations supplied");
  for (const op of ops) {
    if (
      [
        "set_body",
        "set_reply_body",
        "replace_body",
        "append_body",
        "remove_signature",
      ].includes(op.op)
    ) {
      transformMailBody(tree, op.op, String(op.value || ""), op.body_kind);
      continue;
    }
    if (op.op === "insert_signature") {
      let value = op.value;
      if (!value && op.signature_id) {
        const signatures = await ctx.request("GET", api("signatures"));
        const signature = (
          signatures.items ||
          signatures.signatures ||
          []
        ).find(
          (s) => String(s.signature_id || s.id) === String(op.signature_id),
        );
        value = signature?.body || signature?.content || signature?.html;
      }
      if (!value && !ctx.dryRun) fail("Signature not found");
      transformMailBody(tree, op.op, value || "", "text/html");
      continue;
    }
    if (["add_attachment", "add_inline", "replace_inline"].includes(op.op)) {
      const filepath = await safeLocalFile(op.path);
      const info = await stat(filepath);
      const name = op.filename || path.basename(filepath);
      let cid = op.cid;
      if (op.op === "add_attachment") checkMailAttachmentName(name);
      if (op.op === "replace_inline") {
        const found = leaves(tree).find((n) =>
          op.target?.part_id
            ? n.id === op.target.part_id
            : getHeader(n.headers, "Content-ID").replace(/^<|>$/g, "") ===
              String(op.target?.cid || "").replace(/^<|>$/g, ""),
        );
        if (!found || found === tree) fail("Inline target not found");
        cid ||= getHeader(found.headers, "Content-ID").replace(/^<|>$/g, "");
        removeMimeLeaf(tree, { part_id: found.id });
      }
      if (op.op !== "add_attachment" && !cid)
        fail("Inline operation requires a cid");
      if (
        op.op === "add_attachment" &&
        serializeMime(tree).length + mimeCost(info.size) > 25 * 1024 ** 2
      ) {
        const token = await uploadMailMedia(ctx, {
          name,
          size: info.size,
          path: filepath,
        });
        let entries;
        try {
          entries = JSON.parse(
            Buffer.from(
              getHeader(tree.headers, "X-Lms-Large-Attachment-Ids"),
              "base64",
            ).toString() || "[]",
          );
        } catch {
          fail("Existing large-attachment header is malformed");
        }
        entries.push({ id: token });
        tree.headers = setHeader(
          tree.headers,
          "X-Lms-Large-Attachment-Ids",
          Buffer.from(JSON.stringify(entries)).toString("base64"),
        );
        tree.dirty = true;
        transformMailBody(
          tree,
          "append_body",
          largeFileBody(
            ctx,
            [{ token, name, size: info.size }],
            bodyLeaves(tree).some((n) => /^text\/html/i.test(n.contentType)),
          ),
        );
      } else {
        if (info.size > 25 * 1024 ** 2) fail("Inline image exceeds MIME limit");
        const buffer = await readFile(filepath);
        addMimeLeaf(tree, {
          name,
          buffer,
          cid,
          mime: cid ? imageMime(name, buffer) : op.content_type,
        });
      }
      continue;
    }
    if (["remove_attachment", "remove_inline"].includes(op.op)) {
      if (op.target?.token) {
        let entries;
        try {
          entries = JSON.parse(
            Buffer.from(
              getHeader(tree.headers, "X-Lms-Large-Attachment-Ids"),
              "base64",
            ).toString() || "[]",
          );
        } catch {
          fail("Existing large-attachment header is malformed");
        }
        const filtered = entries.filter(
          (x) => (x.id || x.file_token) !== op.target.token,
        );
        if (filtered.length === entries.length)
          fail("Large attachment token not found");
        tree.headers = setHeader(
          tree.headers,
          "X-Lms-Large-Attachment-Ids",
          filtered.length
            ? Buffer.from(JSON.stringify(filtered)).toString("base64")
            : "",
        );
        tree.dirty = true;
        continue;
      }
      if (!op.target?.part_id && !op.target?.cid)
        fail(
          "Attachment removal requires target.part_id, target.cid, or target.token",
        );
      if (!removeMimeLeaf(tree, op.target)) fail("Attachment target not found");
      continue;
    }
    if (op.op === "set_calendar") {
      const ics = calendarICS(op);
      removeMimeLeaf(tree, null, true);
      addMimeLeaf(tree, {
        name: "invite.ics",
        buffer: Buffer.from(ics),
        mime: "text/calendar; method=REQUEST",
      });
      continue;
    }
    if (op.op === "remove_calendar") {
      removeMimeLeaf(tree, null, true);
      continue;
    }
    let headers = tree.headers;
    if (/^set_(subject|to|cc|bcc)$/.test(op.op)) {
      const name = op.op.slice(4);
      const value =
        name === "subject"
          ? `=?UTF-8?B?${Buffer.from(headerValue(op.value || "")).toString("base64")}?=`
          : renderAddresses(op.value);
      headers = setHeader(
        headers,
        name[0].toUpperCase() + name.slice(1),
        value,
      );
    } else if (
      ["set_recipients", "add_recipient", "remove_recipient"].includes(op.op)
    ) {
      const field = String(op.field || "").toLowerCase();
      if (!["to", "cc", "bcc"].includes(field))
        fail("Recipient field must be to, cc, or bcc");
      let addresses = mailAddresses(getHeader(headers, field));
      if (op.op === "set_recipients")
        addresses = mailAddresses(op.addresses || []);
      if (op.op === "add_recipient")
        addresses.push(
          ...mailAddresses({ address: op.address, name: op.name }),
        );
      if (op.op === "remove_recipient")
        addresses = addresses.filter(
          (a) =>
            a.mail_address.toLowerCase() !== String(op.address).toLowerCase(),
        );
      headers = setHeader(headers, field, renderAddresses(addresses));
    } else if (op.op === "set_reply_to")
      headers = setHeader(headers, "Reply-To", renderAddresses(op.addresses));
    else if (op.op === "clear_reply_to")
      headers = setHeader(headers, "Reply-To", "");
    else if (op.op === "set_header" || op.op === "remove_header") {
      const name = String(op.name || "");
      if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name))
        fail("Invalid MIME header name");
      if (
        !patch.options?.allow_protected_header_edits &&
        /^(message-id|mime-version|content-type|content-transfer-encoding|in-reply-to|references|reply-to)$/i.test(
          name,
        )
      )
        fail(`MIME header ${name} is protected`);
      headers = setHeader(
        headers,
        name,
        op.op === "remove_header" ? "" : op.value,
      );
    } else fail(`Unsupported draft patch operation: ${op.op}`);
    tree.headers = headers;
    tree.dirty = true;
  }
  // Resolve local inline-image references only after applying all body edits.
  for (const node of bodyLeaves(tree).filter((n) =>
    /^text\/html/i.test(n.contentType),
  )) {
    let html = decodeMime(node);
    for (const match of html.matchAll(
      /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
    )) {
      if (/^(https?:|cid:|data:)/i.test(match[1])) continue;
      const filepath = await safeLocalFile(match[1]);
      const cid = randomUUID();
      const name = path.basename(filepath),
        buffer = await readFile(filepath);
      addMimeLeaf(tree, { name, buffer, cid, mime: imageMime(name, buffer) });
      html = html.replaceAll(match[1], `cid:${cid}`);
    }
    setMimeContent(node, lintHtml(html).cleaned_html);
  }
  raw = serializeMime(tree);
  if (Buffer.byteLength(raw) > 25 * 1024 ** 2)
    fail("Updated draft exceeds the 25 MiB MIME limit");
  return ctx.request("PUT", api("drafts", id), {
    body: { raw: Buffer.from(raw).toString("base64url") },
  });
}

export async function executeCollaboration(ctx, service, command, flags = {}) {
  command = String(command).replace(/^\+/, "");
  if (!catalog[service]?.includes(command)) return undefined;
  const userOnly =
    service === "vc" ||
    (service === "minutes" && command !== "download") ||
    (service === "contact" && command === "search-user") ||
    (service === "task" &&
      [
        "get-my-tasks",
        "get-related-tasks",
        "search",
        "tasklist-search",
      ].includes(command)) ||
    (service === "mail" &&
      [
        "reply",
        "reply-all",
        "send",
        "draft-create",
        "draft-send",
        "draft-edit",
        "forward",
        "send-receipt",
        "decline-receipt",
        "signature",
        "share-to-chat",
        "watch",
      ].includes(command));
  if (userOnly && ctx.identity === "bot")
    throw new CliError(
      "permission",
      `${service} +${command} requires --as user`,
      { code: 3 },
    );
  if (
    service === "mail" &&
    ctx.identity === "bot" &&
    !["lint-html"].includes(command) &&
    (!flags.mailbox || flags.mailbox === "me")
  )
    fail("--mailbox must be an explicit mailbox address for bot identity");
  return { calendar, task, mail, okr, vc, minutes, contact }[service](
    ctx,
    command,
    flags,
  );
}
