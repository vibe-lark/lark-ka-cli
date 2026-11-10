import { CliError } from "../errors.mjs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
const enc = encodeURIComponent;
const csv = (v) => [
  ...new Set(
    (Array.isArray(v)
      ? v.flatMap((x) => String(x).split(","))
      : String(v || "").split(",")
    )
      .map((x) => String(x).trim())
      .filter(Boolean),
  ),
];
const requireFlag = (f, k) => {
  if (!f[k]) throw new CliError("validation", `--${k} is required`);
  return f[k];
};
const json = async (ctx, value, fallback = {}) =>
  value === undefined
    ? fallback
    : typeof value === "object"
      ? value
      : JSON.parse(await ctx.input(String(value)));
const yes = (f, k, fallback = false) =>
  f[k] === undefined ? fallback : ![false, "false", 0, "0"].includes(f[k]);
const limit = (f, key, fallback, min, max) => {
  const n = Number(f[key] ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new CliError("validation", `--${key} must be ${min}..${max}`);
  return n;
};
const validID = (value, prefix, label) => {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    /[\s\0<>/\\]/.test(value)
  )
    throw new CliError(
      "validation",
      `${label} must start with ${prefix} and contain no whitespace or path separators`,
    );
  return value;
};
const timestamp = (value) => {
  const s = String(value);
  const n = /^\d+$/.test(s)
    ? Number(s) * (s.length > 10 ? 1 : 1000)
    : Date.parse(s);
  if (!Number.isFinite(n))
    throw new CliError("validation", `Invalid time: ${value}`);
  return String(Math.floor(n / 1000));
};
const rawJSON = (value) => {
  try {
    return typeof value === "object" ? value : JSON.parse(value);
  } catch {
    throw new CliError("validation", "--content must be valid JSON");
  }
};
function query(f, keys) {
  return Object.fromEntries(
    keys
      .filter((k) => f[k] !== undefined)
      .map((k) => [k.replaceAll("-", "_"), f[k]]),
  );
}
function feedQuery(f, emptyToken = false) {
  const params = {
    page_size: limit(f, "page-size", 50, 1, 50),
    ...query(f, ["page-token", "start-time", "end-time"]),
  };
  if (emptyToken && params.page_token === undefined) params.page_token = "";
  for (const k of ["start_time", "end_time"])
    if (params[k] !== undefined && !/^\d+$/.test(String(params[k])))
      throw new CliError("validation", `${k} must be Unix milliseconds`);
  return params;
}
async function paginateDual(
  ctx,
  method,
  route,
  params,
  body,
  arrays,
  maxPages,
) {
  const query = { ...params };
  let data = {};
  const collected = Object.fromEntries(arrays.map((k) => [k, []])),
    seen = new Set();
  for (let page = 0; page < (ctx.dryRun ? 1 : maxPages); page++) {
    data = await ctx.request(method, route, {
      query,
      ...(body === undefined ? {} : { body }),
    });
    if (ctx.dryRun) return data;
    for (const key of arrays)
      if (Array.isArray(data[key])) collected[key].push(...data[key]);
    if (!data.has_more || !data.page_token) break;
    if (seen.has(data.page_token))
      throw new CliError("api", "Pagination token did not advance", {
        code: 5,
      });
    seen.add(data.page_token);
    query.page_token = data.page_token;
  }
  return { ...data, ...collected };
}
async function chatContexts(ctx, ids) {
  const result = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const data = await ctx.request(
      "POST",
      "/open-apis/im/v1/chats/batch_query",
      {
        query: { user_id_type: "open_id" },
        body: { chat_ids: ids.slice(i, i + 50) },
      },
    );
    for (const chat of data.items || []) result.set(chat.chat_id, chat);
  }
  return result;
}
async function muteFilter(ctx, data, f, nonMember = false) {
  if (ctx.dryRun) return data;
  const chats = data.items || data.chats || [];
  let filtered = chats;
  const out = { ...data };
  delete out.items;
  out.chats = chats;
  if (yes(f, "exclude-muted")) {
    const meta = {
      applied: "exclude_muted",
      fetched_count: chats.length,
      returned_count: chats.length,
      filtered_count: 0,
      hint: "",
    };
    if (ctx.identity === "bot")
      meta.hint =
        "Mute filtering is unavailable for bot identity; returned unfiltered chats.";
    else if (nonMember)
      meta.hint =
        "Mute filtering does not apply to public groups the user has not joined.";
    else {
      const ids = csv(chats.map((x) => x.chat_id));
      const muted = new Map();
      for (let i = 0; i < ids.length; i += 100) {
        const result = await ctx.request(
          "POST",
          "/open-apis/im/v1/chat_user_setting/batch_get_mute_status",
          { body: { chat_ids: ids.slice(i, i + 100) } },
        );
        for (const entry of result.items || [])
          muted.set(entry.chat_id, entry.is_muted);
      }
      filtered = chats.filter((x) => muted.get(x.chat_id) !== true);
      meta.returned_count = filtered.length;
      meta.filtered_count = chats.length - filtered.length;
    }
    out.filter = meta;
    out.chats = filtered;
  }
  return out;
}
async function autoFlagType(ctx, messageId) {
  if (ctx.dryRun) return "<auto:thread|msg_thread>";
  const response = await ctx.request(
    "GET",
    `/open-apis/im/v1/messages/${enc(messageId)}`,
  );
  const chatId = response.items?.[0]?.chat_id;
  if (!chatId)
    throw new CliError("api", "Message response has no chat_id", { code: 5 });
  const chat = await ctx.request(
    "GET",
    `/open-apis/im/v1/chats/${enc(chatId)}`,
  );
  return chat.chat_mode === "topic" ? "4" : "11";
}
async function flagsCommand(ctx, command, f) {
  if (command === "+flag-list") {
    const data = await paginateDual(
      ctx,
      "GET",
      "/open-apis/im/v1/flags",
      {
        page_size: limit(f, "page-size", 50, 1, 50),
        page_token: f["page-token"] || "",
      },
      undefined,
      ["flag_items", "delete_flag_items", "messages"],
      yes(f, "page-all") && !f["page-token"]
        ? limit(f, "page-limit", 20, 1, 1000)
        : 1,
    );
    if (!ctx.dryRun && yes(f, "enrich-feed-thread", true)) {
      const byId = new Map((data.messages || []).map((m) => [m.message_id, m]));
      const ids = csv(
        (data.flag_items || [])
          .filter(
            (x) =>
              String(x.flag_type) === "1" &&
              ["4", "11"].includes(String(x.item_type)) &&
              !byId.has(x.item_id),
          )
          .map((x) => x.item_id),
      );
      for (let i = 0; i < ids.length; i += 50) {
        try {
          const messages = await ctx.request(
            "GET",
            "/open-apis/im/v1/messages/mget",
            { query: { message_ids: ids.slice(i, i + 50) } },
          );
          for (const message of messages.items || [])
            byId.set(message.message_id, message);
        } catch {
          data._notice = "Some feed-thread message details could not be loaded";
        }
      }
      for (const item of data.flag_items || [])
        if (byId.has(item.item_id)) item.message = byId.get(item.item_id);
    }
    return data;
  }
  const id = validID(requireFlag(f, "message-id"), "om_", "--message-id");
  const explicitItem =
      f["item-type"] && String(f["item-type"]).trim().toLowerCase(),
    explicitFlag =
      f["flag-type"] && String(f["flag-type"]).trim().toLowerCase();
  const items = { default: "0", thread: "4", msg_thread: "11" },
    types = { message: "2", feed: "1" };
  if (explicitItem && !Object.hasOwn(items, explicitItem))
    throw new CliError("validation", "Invalid --item-type");
  if (explicitFlag && !Object.hasOwn(types, explicitFlag))
    throw new CliError("validation", "Invalid --flag-type");
  const valid = (item, flag) =>
    flag === "2"
      ? item === "0"
      : ["4", "11", "<auto:thread|msg_thread>"].includes(item);
  if (command === "+flag-create") {
    if (explicitItem && !explicitFlag)
      throw new CliError(
        "validation",
        "--item-type requires an explicit --flag-type",
      );
    const flag = types[explicitFlag || "message"];
    const item = explicitItem
      ? items[explicitItem]
      : flag === "2"
        ? "0"
        : await autoFlagType(ctx, id);
    if (!valid(item, flag))
      throw new CliError(
        "validation",
        "Invalid item-type and flag-type combination",
      );
    return ctx.request("POST", "/open-apis/im/v1/flags", {
      body: { flag_items: [{ item_id: id, item_type: item, flag_type: flag }] },
    });
  }
  let requested = [];
  if (explicitItem || explicitFlag) {
    const item = items[explicitItem || "default"],
      flag = types[explicitFlag || "message"];
    if (!valid(item, flag))
      throw new CliError(
        "validation",
        "Explicit feed cancellation requires --item-type thread or msg_thread",
      );
    requested = [{ item_id: id, item_type: item, flag_type: flag }];
  } else {
    requested = [{ item_id: id, item_type: "0", flag_type: "2" }];
    try {
      requested.push({
        item_id: id,
        item_type: await autoFlagType(ctx, id),
        flag_type: "1",
      });
    } catch {
      /* Best effort: known message-layer cancellation remains possible. */
    }
  }
  if (ctx.dryRun)
    return ctx.request("POST", "/open-apis/im/v1/flags/cancel", {
      body: { flag_items: requested },
    });
  const results = [];
  for (const item of requested) {
    try {
      results.push({
        ...item,
        status: "ok",
        response: await ctx.request("POST", "/open-apis/im/v1/flags/cancel", {
          body: { flag_items: [item] },
        }),
      });
    } catch (error) {
      results.push({ ...item, status: "failed", error: error.message });
    }
  }
  if (results.some((x) => x.status === "failed"))
    throw new CliError(
      "partial_failure",
      "Some bookmark layers could not be cancelled",
      { code: 5, detail: { results } },
    );
  return { results };
}
export const commands = [
  "+chat-create",
  "+chat-list",
  "+chat-messages-list",
  "+chat-search",
  "+chat-update",
  "+feed-group-list",
  "+feed-group-list-item",
  "+feed-group-query-item",
  "+feed-shortcut-create",
  "+feed-shortcut-list",
  "+feed-shortcut-remove",
  "+flag-cancel",
  "+flag-create",
  "+flag-list",
  "+messages-mget",
  "+messages-reply",
  "+messages-resources-download",
  "+messages-search",
  "+messages-send",
  "+threads-messages-list",
];
async function enrich(ctx, data, f, expandThreads = true) {
  const items = data.items || data.messages || [];
  if (ctx.dryRun) return data;
  const messages = [];
  for (const item of items) messages.push(await formatMessage(ctx, item, 0));
  if (expandThreads) {
    let budget = 500;
    const seen = new Set();
    for (const item of messages) {
      if (!item.thread_id || seen.has(item.thread_id) || budget <= 0) continue;
      seen.add(item.thread_id);
      try {
        const result = await ctx.request("GET", "/open-apis/im/v1/messages", {
          query: {
            container_id_type: "thread",
            container_id: item.thread_id,
            sort_type: "ByCreateTimeAsc",
            page_size: 50,
            card_msg_content_type: "raw_card_content",
          },
        });
        const replies = (result.items || [])
          .filter((x) => x.message_id !== item.message_id)
          .slice(0, budget);
        item.thread_replies = [];
        for (const reply of replies)
          item.thread_replies.push(await formatMessage(ctx, reply, 0));
        budget -= replies.length;
        item.thread_has_more = Boolean(
          result.has_more || (result.items || []).length > replies.length + 1,
        );
        if (result.page_token) item.thread_page_token = result.page_token;
      } catch {
        item.thread_replies_error = true;
      }
    }
  }
  const all = [];
  const collect = (ms) => {
    for (const m of ms) {
      all.push(m);
      if (m.thread_replies) collect(m.thread_replies);
      if (m.sub_messages) collect(m.sub_messages);
    }
  };
  collect(messages);
  await resolveNames(ctx, all);
  if (!yes(f, "no-reactions") && all.length) {
    const ids = csv(all.map((x) => x.message_id));
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      try {
        const reactions = await ctx.request(
          "POST",
          "/open-apis/im/v1/messages/reactions/batch_query",
          { body: { queries: batch.map((message_id) => ({ message_id })) } },
        );
        for (const id of batch) {
          const counts = (reactions.success_msg_reaction_counts || [])
            .filter((x) => x.message_id === id)
            .flatMap((x) => x.reaction_count || []);
          const details = (reactions.success_msg_reaction_details || [])
            .filter((x) => x.message_id === id)
            .flatMap((x) => x.message_reaction_items || []);
          const failed = (reactions.fail_msg_reaction_details || []).some(
            (x) => x.message_id === id,
          );
          for (const item of all.filter((x) => x.message_id === id)) {
            if (counts.length || details.length)
              item.reactions = {
                ...(counts.length ? { counts } : {}),
                ...(details.length ? { details } : {}),
              };
            if (failed) item.reactions_error = true;
          }
        }
      } catch {
        for (const item of all.filter((x) => batch.includes(x.message_id)))
          item.reactions_error = true;
      }
    }
  }
  const out = { ...data, messages, total: messages.length };
  delete out.items;
  return out;
}
function postText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(postText).join("\n");
  const tag = value.tag;
  if (tag === "img") return `[image: ${value.image_key || ""}]`;
  if (tag === "at")
    return `@${value.user_name || value.name || value.user_id || "all"}`;
  if (tag === "a")
    return `[${value.text || value.href || ""}](${value.href || ""})`;
  if (value.text !== undefined) return String(value.text);
  if (value.content !== undefined) return postText(value.content);
  if (value.elements) return postText(value.elements);
  if (value.title) return postText(value.title);
  return Object.entries(value)
    .filter(
      ([key]) =>
        ![
          "config",
          "schema",
          "tag",
          "header",
          "i18n_header",
          "i18n_elements",
        ].includes(key),
    )
    .map(([, x]) => (typeof x === "object" ? postText(x) : ""))
    .filter(Boolean)
    .join("\n");
}
async function formatMessage(ctx, item, depth) {
  let content;
  try {
    content =
      typeof item.body?.content === "string"
        ? JSON.parse(item.body.content)
        : item.body?.content || {};
  } catch {
    content = { text: item.body?.content || "" };
  }
  let rendered = "";
  const kind = item.msg_type || item.message_type || "text";
  if (kind === "text") rendered = content.text || "";
  else if (kind === "post") {
    const selected = content.zh_cn || content.en_us || content.ja_jp || content;
    rendered = [selected.title, postText(selected.content)]
      .filter(Boolean)
      .join("\n");
  } else if (kind === "interactive") rendered = postText(content);
  else if (kind === "image") rendered = `[image: ${content.image_key || ""}]`;
  else if (["file", "audio", "video", "media", "sticker"].includes(kind))
    rendered = `[${kind}: ${content.file_name || content.file_key || content.image_key || ""}]`;
  else if (kind === "share_chat")
    rendered = `[shared chat: ${content.chat_id || ""}]`;
  else if (kind === "share_user")
    rendered = `[shared user: ${content.user_id || ""}]`;
  else rendered = postText(content) || `[${kind}]`;
  for (const mention of item.mentions || [])
    if (mention.key)
      rendered = rendered
        .split(mention.key)
        .join(
          "@" + (mention.name || mention.id?.open_id || mention.id || "user"),
        );
  const result = {
    message_id: item.message_id,
    msg_type: kind,
    content: rendered,
    sender: item.sender ? { ...item.sender } : undefined,
    create_time:
      item.create_time && /^\d+$/.test(String(item.create_time))
        ? new Date(Number(item.create_time)).toISOString()
        : item.create_time,
  };
  for (const key of [
    "chat_id",
    "root_id",
    "parent_id",
    "thread_id",
    "deleted",
    "updated",
    "mentions",
  ])
    if (item[key] !== undefined) result[key] = item[key];
  if (kind === "merge_forward" && depth < 5 && item.message_id) {
    try {
      const data = await ctx.request(
        "GET",
        `/open-apis/im/v1/messages/${enc(item.message_id)}`,
      );
      result.sub_messages = [];
      for (const child of data.items || [])
        if (child.message_id !== item.message_id)
          result.sub_messages.push(await formatMessage(ctx, child, depth + 1));
      result.content = result.sub_messages.map((x) => x.content).join("\n");
    } catch {
      result.merge_forward_error = true;
    }
  }
  return result;
}
async function resolveNames(ctx, messages) {
  const ids = csv(
    messages
      .map((x) => x.sender?.id || x.sender?.sender_id?.open_id)
      .filter((x) => typeof x === "string" && x.startsWith("ou_")),
  );
  const names = new Map();
  const size = ctx.identity === "bot" ? 50 : 10;
  for (let i = 0; i < ids.length; i += size) {
    try {
      const batch = ids.slice(i, i + size);
      const data =
        ctx.identity === "bot"
          ? await ctx.request("GET", "/open-apis/contact/v3/users/batch", {
              query: { user_id_type: "open_id", user_ids: batch },
            })
          : await ctx.request(
              "POST",
              "/open-apis/contact/v3/users/basic_batch",
              { query: { user_id_type: "open_id" }, body: { user_ids: batch } },
            );
      for (const user of data.users || data.items || [])
        names.set(user.open_id || user.user_id, user.name || user.en_name);
    } catch {
      /* Names are optional enrichment; preserve stable sender IDs. */
    }
  }
  for (const item of messages) {
    const id = item.sender?.id || item.sender?.sender_id?.open_id;
    if (names.has(id)) item.sender.name = names.get(id);
  }
}
async function uploadMedia(ctx, kind, value) {
  const image = kind === "image";
  if ((image ? /^img_/ : /^file_/).test(value)) return value;
  const fields = image
    ? { image_type: "message" }
    : {
        file_type:
          kind === "audio" ? "opus" : kind === "video" ? "mp4" : "stream",
        file_name: path.basename(value),
      };
  let response;
  if (/^https?:/.test(value)) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new CliError(
        "validation",
        "Media URL must use HTTPS without credentials",
      );
    if (ctx.dryRun) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      form.set(
        image ? "image" : "file",
        new Blob([]),
        path.basename(url.pathname) || "media",
      );
      response = await ctx.request(
        "POST",
        image ? "/open-apis/im/v1/images" : "/open-apis/im/v1/files",
        { body: form },
      );
    } else {
      const remote = await fetch(url, {
        redirect: "error",
        signal: ctx.signal || AbortSignal.timeout(30000),
      });
      if (!remote.ok)
        throw new CliError("network", `Media download HTTP ${remote.status}`, {
          code: 4,
        });
      const chunks = [];
      let total = 0;
      for await (const chunk of remote.body) {
        total += chunk.length;
        if (total > (image ? 10 : 30) * 1024 ** 2)
          throw new CliError(
            "validation",
            "Media exceeds the upload size limit",
          );
        chunks.push(chunk);
      }
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      form.set(
        image ? "image" : "file",
        new Blob(chunks),
        path.basename(url.pathname) || "media",
      );
      response = await ctx.request(
        "POST",
        image ? "/open-apis/im/v1/images" : "/open-apis/im/v1/files",
        { body: form },
      );
    }
  } else {
    if (path.isAbsolute(value) || value.split(/[\\/]/).includes(".."))
      throw new CliError(
        "validation",
        "Media file must be a relative path without ..",
      );
    const root = await realpath(process.cwd()),
      file = await realpath(value);
    if (!file.startsWith(root + path.sep))
      throw new CliError(
        "validation",
        "Media path resolves outside current directory",
      );
    const info = await stat(file);
    if (!info.isFile() || info.size > (image ? 10 : 30) * 1024 ** 2)
      throw new CliError(
        "validation",
        "Media is not a regular file or exceeds the upload limit",
      );
    response = await ctx.multipart(
      "POST",
      image ? "/open-apis/im/v1/images" : "/open-apis/im/v1/files",
      { fields, files: [{ field: image ? "image" : "file", path: value }] },
    );
  }
  const key =
    response.image_key ||
    response.file_key ||
    (ctx.dryRun ? "<media_key>" : undefined);
  if (!key)
    throw new CliError("api", "Media upload returned no key", { code: 5 });
  return key;
}
async function messageContent(ctx, f) {
  const keys = [
    "text",
    "markdown",
    "content",
    "image",
    "file",
    "audio",
    "video",
  ].filter((k) => f[k] !== undefined);
  if (keys.length !== 1)
    throw new CliError(
      "validation",
      "Specify exactly one message content flag: --text, --markdown, --content, --image, --file, --audio, --video",
    );
  const k = keys[0];
  let type = f["msg-type"] || "text",
    content;
  if (k === "video" && !f["video-cover"])
    throw new CliError("validation", "--video requires --video-cover");
  if (k !== "video" && f["video-cover"])
    throw new CliError("validation", "--video-cover requires --video");
  const inferred = {
    text: "text",
    markdown: "post",
    image: "image",
    file: "file",
    audio: "audio",
    video: "media",
  }[k];
  if (
    ctx.providedFlags?.has("msg-type") &&
    inferred &&
    f["msg-type"] !== inferred
  )
    throw new CliError("validation", `--${k} requires --msg-type ${inferred}`);
  if (k === "text") content = { text: String(f.text) };
  else if (k === "markdown") {
    type = "post";
    const source = String(f.markdown);
    const rows = [];
    let offset = 0;
    for (const match of source.matchAll(/!\[([^\]]*)\]\(([^\s)]+)\)/g)) {
      if (match.index > offset)
        rows.push([{ tag: "md", text: source.slice(offset, match.index) }]);
      try {
        rows.push([
          { tag: "img", image_key: await uploadMedia(ctx, "image", match[2]) },
        ]);
      } catch {
        rows.push([{ tag: "a", text: match[1] || "image", href: match[2] }]);
      }
      offset = match.index + match[0].length;
    }
    if (offset < source.length || !rows.length)
      rows.push([{ tag: "md", text: source.slice(offset) }]);
    content = { zh_cn: { title: "", content: rows } };
  } else if (k === "content") content = rawJSON(f.content);
  else {
    let key = String(f[k]);
    try {
      key = await uploadMedia(ctx, k, key);
    } catch (error) {
      if (!/^https?:/.test(String(f[k]))) throw error;
      return {
        msg_type: "text",
        content: JSON.stringify({
          text: `[${k} upload failed, sending link] ${f[k]}`,
        }),
      };
    }
    type = k === "video" ? "media" : k;
    content =
      k === "image"
        ? { image_key: key }
        : k === "video"
          ? {
              file_key: key,
              image_key: await uploadMedia(
                ctx,
                "image",
                requireFlag(f, "video-cover"),
              ),
            }
          : { file_key: key };
  }
  return { msg_type: type, content: JSON.stringify(content) };
}
export async function executeIM(ctx, service, command, f) {
  if (service !== "im" || !commands.includes(command)) return undefined;
  if (
    ["+messages-search", "+flag-list", "+flag-create", "+flag-cancel"].includes(
      command,
    ) ||
    command.startsWith("+feed-")
  ) {
    if (ctx.identity !== "user")
      throw new CliError("permission", `${command} requires --as user`, {
        code: 3,
      });
  }
  if (command === "+messages-send") {
    if (!!f["chat-id"] === !!f["user-id"])
      throw new CliError(
        "validation",
        "Specify exactly one of --chat-id or --user-id",
      );
    validID(
      f["chat-id"] || f["user-id"],
      f["chat-id"] ? "oc_" : "ou_",
      f["chat-id"] ? "--chat-id" : "--user-id",
    );
    const body = {
      receive_id: f["chat-id"] || f["user-id"],
      ...(await messageContent(ctx, f)),
    };
    if (f["idempotency-key"]) body.uuid = f["idempotency-key"];
    return ctx.request("POST", "/open-apis/im/v1/messages", {
      query: { receive_id_type: f["chat-id"] ? "chat_id" : "open_id" },
      body,
    });
  }
  if (command === "+messages-reply")
    return ctx.request(
      "POST",
      `/open-apis/im/v1/messages/${enc(validID(requireFlag(f, "message-id"), "om_", "--message-id"))}/reply`,
      {
        body: {
          ...(await messageContent(ctx, f)),
          reply_in_thread: yes(f, "reply-in-thread"),
          ...(f["idempotency-key"] ? { uuid: f["idempotency-key"] } : {}),
        },
      },
    );
  if (command === "+messages-mget") {
    const ids = csv(requireFlag(f, "message-ids"));
    if (ids.length > 50)
      throw new CliError("validation", "At most 50 message IDs per call");
    for (const id of ids) validID(id, "om_", "--message-ids");
    return enrich(
      ctx,
      await ctx.request("GET", "/open-apis/im/v1/messages/mget", {
        query: { message_ids: ids },
      }),
      f,
    );
  }
  if (command === "+messages-resources-download") {
    const key = requireFlag(f, "file-key");
    if (/[\\/]/.test(key))
      throw new CliError(
        "validation",
        "--file-key must not contain path separators",
      );
    const output = f.output || key;
    if (path.isAbsolute(output) || String(output).split(/[\\/]/).includes(".."))
      throw new CliError(
        "validation",
        "--output must be a relative path without ..",
      );
    const result = await ctx.download(
      `/open-apis/im/v1/messages/${enc(validID(requireFlag(f, "message-id"), "om_", "--message-id"))}/resources/${enc(key)}`,
      { query: { type: requireFlag(f, "type") }, output },
    );
    return { saved_path: result.path, size_bytes: result.bytes };
  }
  if (
    command === "+chat-messages-list" ||
    command === "+threads-messages-list"
  ) {
    const thread = command === "+threads-messages-list";
    let id = thread ? requireFlag(f, "thread") : f["chat-id"];
    if (!thread) {
      if (Boolean(f["chat-id"]) === Boolean(f["user-id"]))
        throw new CliError(
          "validation",
          "Specify exactly one of --chat-id or --user-id",
        );
      if (f["user-id"]) {
        if (ctx.identity !== "user")
          throw new CliError("permission", "--user-id requires --as user", {
            code: 3,
          });
        const user = validID(f["user-id"], "ou_", "--user-id");
        if (ctx.dryRun) id = "<resolved_chat_id>";
        else {
          const data = await ctx.request(
            "POST",
            "/open-apis/im/v1/chat_p2p/batch_query",
            {
              query: { chatter_id_type: "open_id" },
              body: { chatter_ids: [user] },
            },
          );
          id = data.p2p_chats?.[0]?.chat_id;
          if (!id) throw new CliError("api", "P2P chat not found", { code: 5 });
        }
      } else validID(id, "oc_", "--chat-id");
    } else if (!/^omt?_/.test(id))
      throw new CliError("validation", "--thread must start with om_ or omt_");
    if (command === "+threads-messages-list" && id.startsWith("om_")) {
      const message = await ctx.request(
        "GET",
        `/open-apis/im/v1/messages/${enc(id)}`,
      );
      id =
        message.items?.[0]?.thread_id ||
        (ctx.dryRun ? "<thread_id>" : undefined);
      if (!id)
        throw new CliError("api", "Message has no thread_id", { code: 5 });
    }
    const sort = f.sort || (thread ? "asc" : "desc");
    if (!["asc", "desc"].includes(sort))
      throw new CliError("validation", "--sort must be asc or desc");
    const params = {
      container_id_type: thread ? "thread" : "chat",
      container_id: id,
      sort_type: sort === "desc" ? "ByCreateTimeDesc" : "ByCreateTimeAsc",
      page_size: limit(f, "page-size", 50, 1, thread ? 500 : 50),
      card_msg_content_type: "raw_card_content",
      ...query(f, ["page-token"]),
    };
    if (f.start) params.start_time = timestamp(f.start);
    if (f.end) params.end_time = timestamp(f.end);
    if (
      params.start_time &&
      params.end_time &&
      Number(params.start_time) > Number(params.end_time)
    )
      throw new CliError("validation", "--start cannot be after --end");
    const data = await (f["page-all"] ? ctx.paginate : ctx.request)(
      "GET",
      "/open-apis/im/v1/messages",
      { query: params },
    );
    const result = await enrich(ctx, data, f, !thread);
    if (thread && !ctx.dryRun) result.thread_id = id;
    return result;
  }
  if (command === "+messages-search") {
    const body = { query: f.query || "" },
      filter = {};
    for (const [flag, key, prefix] of [
      ["chat-id", "chat_ids", "oc_"],
      ["sender", "from_ids", "ou_"],
      ["at-chatter-ids", "at_chatter_ids", "ou_"],
    ])
      if (f[flag]) {
        filter[key] = csv(f[flag]);
        for (const id of filter[key]) validID(id, prefix, `--${flag}`);
      }
    if (f.start || f.end) {
      filter.time_range = {};
      if (f.start) {
        timestamp(f.start);
        filter.time_range.start_time = f.start;
      }
      if (f.end) {
        timestamp(f.end);
        filter.time_range.end_time = f.end;
      }
      if (
        f.start &&
        f.end &&
        Number(timestamp(f.start)) > Number(timestamp(f.end))
      )
        throw new CliError("validation", "--start cannot be later than --end");
    }
    for (const [flag, key, values] of [
      [
        "include-attachment-type",
        "include_attachment_types",
        ["file", "image", "video", "link"],
      ],
      ["sender-type", "from_types", ["user", "bot"]],
      ["exclude-sender-type", "exclude_from_types", ["user", "bot"]],
    ])
      if (f[flag]) {
        if (!values.includes(f[flag]))
          throw new CliError("validation", `Invalid --${flag}`);
        filter[key] = [f[flag]];
      }
    if (f["sender-type"] && f["sender-type"] === f["exclude-sender-type"])
      throw new CliError(
        "validation",
        "Sender type cannot be both included and excluded",
      );
    if (f["chat-type"]) {
      if (!["group", "p2p"].includes(f["chat-type"]))
        throw new CliError("validation", "Invalid --chat-type");
      filter.chat_type = f["chat-type"];
    }
    if (yes(f, "is-at-me")) filter.is_at_me = true;
    if (Object.keys(filter).length) body.filter = filter;
    const pageSize = limit(f, "page-size", 20, 1, 50);
    const pageLimit = limit(
      f,
      "page-limit",
      yes(f, "page-all") ? 40 : 20,
      1,
      40,
    );
    const explicitLimit = ctx.providedFlags
      ? ctx.providedFlags.has("page-limit")
      : f["page-limit"] !== undefined;
    const result = await paginateDual(
      ctx,
      "POST",
      "/open-apis/im/v1/messages/search",
      { page_size: pageSize, ...query(f, ["page-token"]) },
      body,
      ["items"],
      yes(f, "page-all") || explicitLimit ? pageLimit : 1,
    );
    if (ctx.dryRun) return result;
    const ids = csv(
      (result.items || result.message_ids || [])
        .map((x) =>
          typeof x === "string" ? x : x.meta_data?.message_id || x.message_id,
        )
        .filter(Boolean),
    );
    if (!ids.length) return { ...result, messages: [], total: 0 };
    const items = [];
    for (let i = 0; i < ids.length; i += 50) {
      const d = await ctx.request("GET", "/open-apis/im/v1/messages/mget", {
        query: { message_ids: ids.slice(i, i + 50) },
      });
      items.push(...(d.items || []));
    }
    const contexts = await chatContexts(
      ctx,
      csv(items.map((x) => x.chat_id).filter(Boolean)),
    );
    for (const item of items) {
      const chat = contexts.get(item.chat_id);
      if (chat) {
        item.chat_name = chat.name;
        item.chat_type = chat.chat_mode || chat.chat_type;
      }
    }
    const enriched = await enrich(ctx, { ...result, items }, f);
    for (const m of enriched.messages || []) {
      const chat = contexts.get(m.chat_id);
      if (chat) {
        if (chat.name) m.chat_name = chat.name;
        m.chat_type = chat.chat_mode || chat.chat_type;
      }
    }
    return enriched;
  }
  if (command === "+chat-list") {
    let types = csv(f.types || "group");
    if (types.some((x) => !["group", "p2p"].includes(x)))
      throw new CliError("validation", "--types must contain group or p2p");
    let stripped = false;
    if (ctx.identity === "bot" && types.includes("p2p")) {
      if (types.length === 1)
        throw new CliError("permission", "p2p chats require user identity", {
          code: 3,
        });
      types = types.filter((x) => x !== "p2p");
      stripped = true;
    }
    const params = {
      user_id_type: f["user-id-type"] || "open_id",
      sort_type: f["sort-type"] || "ByCreateTimeAsc",
      page_size: limit(f, "page-size", 20, 1, 100),
      ...query(f, ["page-token"]),
      ...(f.types ? { types: types.join(",") } : {}),
    };
    const data = await (f["page-all"] ? ctx.paginate : ctx.request)(
      "GET",
      "/open-apis/im/v1/chats",
      { query: params },
    );
    const result = await muteFilter(ctx, data, f);
    if (stripped)
      result.notices = [
        ...(result.notices || []),
        {
          code: "bot_strip_p2p",
          message:
            "Bot identity does not expose p2p chats; requested group chats only.",
        },
      ];
    return result;
  }
  if (command === "+chat-search") {
    if (!f.query && !f["member-ids"])
      throw new CliError("validation", "Provide --query or --member-ids");
    if ([...String(f.query || "")].length > 64)
      throw new CliError("validation", "--query must not exceed 64 characters");
    const body = {},
      filter = {};
    if (f.query)
      body.query =
        String(f.query).includes("-") && !String(f.query).startsWith('"')
          ? `"${f.query}"`
          : f.query;
    if (f["search-types"]) {
      filter.search_types = csv(f["search-types"]);
      for (const type of filter.search_types)
        if (
          ![
            "private",
            "external",
            "public_joined",
            "public_not_joined",
          ].includes(type)
        )
          throw new CliError("validation", "Invalid --search-types");
    }
    if (f["member-ids"]) {
      filter.member_ids = csv(f["member-ids"]);
      if (filter.member_ids.length > 50)
        throw new CliError("validation", "At most 50 member IDs");
      for (const id of filter.member_ids) validID(id, "ou_", "--member-ids");
    }
    if (yes(f, "is-manager")) filter.is_manager = true;
    if (yes(f, "disable-search-by-user")) filter.disable_search_by_user = true;
    if (Object.keys(filter).length) body.filter = filter;
    if (f["sort-by"]) {
      if (
        !["create_time_desc", "update_time_desc", "member_count_desc"].includes(
          f["sort-by"],
        )
      )
        throw new CliError("validation", "Invalid --sort-by");
      body.sorter = f["sort-by"];
    }
    const data = await ctx.request("POST", "/open-apis/im/v2/chats/search", {
      query: {
        page_size: limit(f, "page-size", 20, 1, 100),
        ...query(f, ["page-token"]),
      },
      body,
    });
    if (ctx.dryRun) return data;
    const chats = (data.items || []).map((x) => x.meta_data || x);
    return muteFilter(
      ctx,
      { ...data, items: chats },
      f,
      csv(f["search-types"]).length === 1 &&
        f["search-types"] === "public_not_joined",
    );
  }
  if (command === "+chat-create" || command === "+chat-update") {
    if (
      [...String(f.name || "")].length > 60 ||
      [...String(f.description || "")].length > 100
    )
      throw new CliError(
        "validation",
        "Chat name exceeds 60 or description exceeds 100 characters",
      );
    const body = query(f, ["name", "description"]);
    const params = { user_id_type: "open_id" };
    if (command === "+chat-create") {
      body.chat_type = f.type || "private";
      body.chat_mode = f["chat-mode"] || "group";
      if (
        !["private", "public"].includes(body.chat_type) ||
        !["group", "topic"].includes(body.chat_mode)
      )
        throw new CliError("validation", "Invalid chat type or mode");
      if (body.chat_type === "public" && [...String(f.name || "")].length < 2)
        throw new CliError(
          "validation",
          "Public chat requires a name with at least two characters",
        );
      if (f.users) {
        body.user_id_list = csv(f.users);
        if (body.user_id_list.length > 50)
          throw new CliError("validation", "At most 50 users may be invited");
        for (const id of body.user_id_list) validID(id, "ou_", "--users");
      }
      if (f.bots) {
        body.bot_id_list = csv(f.bots);
        if (body.bot_id_list.length > 5)
          throw new CliError("validation", "At most 5 bots may be invited");
        for (const id of body.bot_id_list) validID(id, "cli_", "--bots");
      }
      if (f.owner) body.owner_id = validID(f.owner, "ou_", "--owner");
      if (yes(f, "set-bot-manager")) {
        if (ctx.identity !== "bot")
          throw new CliError(
            "validation",
            "--set-bot-manager requires bot identity",
          );
        params.set_bot_manager = true;
      }
    } else {
      validID(requireFlag(f, "chat-id"), "oc_", "--chat-id");
      if (!Object.keys(body).length)
        throw new CliError(
          "validation",
          "Provide --name or --description to update",
        );
    }
    return ctx.request(
      command === "+chat-create" ? "POST" : "PUT",
      `/open-apis/im/v1/chats${command === "+chat-update" ? "/" + enc(f["chat-id"]) : ""}`,
      { query: params, body },
    );
  }
  if (command.startsWith("+feed-shortcut-")) {
    const route = "/open-apis/im/v2/feed_shortcuts";
    if (command.endsWith("-list")) {
      const data = await ctx.request("GET", route, {
        query: query(f, ["page-token"]),
      });
      if (!ctx.dryRun && !yes(f, "no-detail")) {
        try {
          const contexts = await chatContexts(
            ctx,
            csv(
              (data.shortcuts || [])
                .filter((x) => Number(x.type) === 1)
                .map((x) => x.feed_card_id),
            ),
          );
          for (const item of data.shortcuts || [])
            if (contexts.has(item.feed_card_id))
              item.detail = contexts.get(item.feed_card_id);
        } catch (error) {
          data._notice = `detail enrichment skipped: ${error.message}`;
        }
      }
      return data;
    }
    const ids = csv(requireFlag(f, "chat-id"));
    if (ids.length > 10)
      throw new CliError("validation", "At most 10 chat IDs");
    for (const id of ids) validID(id, "oc_", "--chat-id");
    if (yes(f, "head") && yes(f, "tail"))
      throw new CliError(
        "validation",
        "--head and --tail are mutually exclusive",
      );
    const shortcuts = ids.map((id) => ({ feed_card_id: id, type: 1 }));
    const result = await ctx.request(
      "POST",
      command.endsWith("-remove") ? route + "/remove" : route,
      {
        body: {
          shortcuts,
          ...(command.endsWith("-create")
            ? { is_header: !yes(f, "tail") }
            : {}),
        },
      },
    );
    if (ctx.dryRun) return result;
    const failedIDs = new Set(
      (result.failed_shortcuts || []).map((x) => x.shortcut?.feed_card_id),
    );
    result.total = ids.length;
    result.succeeded_shortcuts = shortcuts.filter(
      (x) => !failedIDs.has(x.feed_card_id),
    );
    result.success_count = result.succeeded_shortcuts.length;
    result.failure_count = ids.length - result.success_count;
    if (result.failed_shortcuts?.length)
      throw new CliError(
        "partial_failure",
        "Some feed shortcuts could not be changed",
        { code: 5, detail: result },
      );
    return result;
  }
  if (command === "+feed-group-list")
    return paginateDual(
      ctx,
      "GET",
      "/open-apis/im/v1/groups",
      feedQuery(f, true),
      undefined,
      ["groups", "deleted_groups"],
      yes(f, "page-all") && !f["page-token"]
        ? limit(f, "page-limit", 20, 1, 1000)
        : 1,
    );
  if (command.startsWith("+feed-group-")) {
    const id = enc(requireFlag(f, "feed-group-id"));
    let data;
    if (command === "+feed-group-query-item")
      data = await ctx.request(
        "POST",
        `/open-apis/im/v1/groups/${id}/batch_query_item`,
        {
          body: {
            items: csv(requireFlag(f, "feed-id")).map((feed_id) => ({
              feed_id,
              feed_type: "chat",
            })),
          },
        },
      );
    else
      data = await paginateDual(
        ctx,
        "GET",
        `/open-apis/im/v1/groups/${id}/list_item`,
        feedQuery(f),
        undefined,
        ["items", "deleted_items"],
        yes(f, "page-all") && !f["page-token"]
          ? limit(f, "page-limit", 20, 1, 1000)
          : 1,
      );
    const lists = [...(data.items || []), ...(data.deleted_items || [])];
    const ids = csv(lists.map((x) => x.feed_id).filter(Boolean));
    if (ids.length && !ctx.dryRun) {
      try {
        const contexts = await chatContexts(ctx, ids);
        for (const item of lists)
          if (contexts.has(item.feed_id))
            item.chat_name = contexts.get(item.feed_id).name;
      } catch (error) {
        data._notice = `Chat name enrichment skipped: ${error.message}`;
      }
    }
    return data;
  }
  if (command.startsWith("+flag-")) {
    return flagsCommand(ctx, command, f);
  }
}
