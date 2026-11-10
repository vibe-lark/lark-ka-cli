import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../errors.mjs";
import { setTimeout as delay } from "node:timers/promises";

const defs = JSON.parse(
  readFileSync(new URL("../../data/sheets/flag-defs.json", import.meta.url)),
);
const schemas = JSON.parse(
  readFileSync(new URL("../../data/sheets/flag-schemas.json", import.meta.url)),
).flags;
const catalog = JSON.parse(
  readFileSync(new URL("../../data/shortcuts.json", import.meta.url)),
);
export const commandSpecs = {
  base: Object.fromEntries(
    catalog.filter((x) => x.service === "base").map((x) => [x.command, x]),
  ),
  sheets: {
    ...Object.fromEntries(
      catalog.filter((x) => x.service === "sheets").map((x) => [x.command, x]),
    ),
    ...defs,
  },
};
const has = (o, k) => Object.hasOwn(o, k);
const clean = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const yes = (v) => v === true || v === "true";
const fail = (message, detail) => {
  throw new CliError("validation", message, { detail });
};
const required = (f, k) => {
  const v = f[k];
  if (v === undefined || v === "" || v === true) fail(`--${k} is required`);
  return v;
};
const enc = (v) => encodeURIComponent(String(v));
const ints = (f, k, fallback, min = 0, max = Infinity) => {
  const n = Number(f[k] ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max)
    fail(`--${k} must be an integer between ${min} and ${max}`);
  return n;
};
const list = (v) =>
  (Array.isArray(v) ? v : String(v ?? "").split(","))
    .map((x) => String(x).trim())
    .filter(Boolean);
const pick = (f, names) =>
  clean(
    Object.fromEntries(
      names.filter((k) => has(f, k)).map((k) => [k.replaceAll("-", "_"), f[k]]),
    ),
  );
async function json(ctx, raw, name, type = "object", fallback) {
  if (raw === undefined) {
    if (fallback !== undefined) return structuredClone(fallback);
    fail(`--${name} is required`);
  }
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(await ctx.input(raw));
    } catch (e) {
      if (e instanceof CliError) throw e;
      fail(`--${name} must contain valid JSON`);
    }
  }
  if (
    type === "array"
      ? !Array.isArray(value)
      : !value || typeof value !== "object" || Array.isArray(value)
  )
    fail(`--${name} must be a JSON ${type}`);
  return value;
}
async function req(ctx, method, url, query, body) {
  const result = await ctx.request(method, url, clean({ query, body }));
  if (
    result &&
    typeof result === "object" &&
    has(result, "code") &&
    has(result, "data")
  ) {
    if (Number(result.code) !== 0)
      throw new CliError(
        "api",
        result.msg ?? result.message ?? "Base operation failed",
        { code: 5, detail: { apiCode: result.code } },
      );
    return result.data;
  }
  return result;
}
function basePath(f, ...parts) {
  return (
    "/open-apis/base/v3/bases/" +
    enc(required(f, "base-token")) +
    (parts.length ? "/" + parts.map(enc).join("/") : "")
  );
}
function tablePath(f, ...parts) {
  return basePath(f, "tables", required(f, "table-id"), ...parts);
}
function uniqueStrings(values, name, max) {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.some((x) => typeof x !== "string" || !x.trim())
  )
    fail(`${name} must be a non-empty string array`);
  if (values.length > max || new Set(values).size !== values.length)
    fail(`${name} must contain at most ${max} distinct values`);
  return values.map((x) => x.trim());
}
async function offsetPages(ctx, f, url, key, max = 100, all = false) {
  const query = {
    offset: ints(f, "offset", 0),
    limit: ints(f, "limit", max, 1, max),
  };
  const rows = [];
  let last;
  for (let n = 0; n < 10000; n++) {
    last = await req(ctx, "GET", url, query);
    const batch = last[key] ?? last.items ?? [];
    if (!Array.isArray(batch))
      throw new CliError("api", `${key} response must be an array`, {
        code: 5,
      });
    rows.push(...batch);
    if (
      ctx.dryRun ||
      !all ||
      !batch.length ||
      batch.length < query.limit ||
      (last.total > 0 && query.offset + batch.length >= last.total)
    )
      return { ...last, [key]: rows, total: last.total ?? rows.length };
    query.offset += batch.length;
  }
  throw new CliError("api", "Pagination exceeded 10000 pages", { code: 5 });
}
async function tokenPages(ctx, method, url, options, key) {
  const result = [];
  const seen = new Set();
  let next;
  let last;
  for (let page = 0; page < 10000; page++) {
    const container = method === "GET" ? "query" : "body";
    last = await ctx.request(method, url, {
      ...options,
      [container]: clean({ ...options[container], page_token: next }),
    });
    result.push(...(last[key] ?? []));
    if (ctx.dryRun || !last.has_more)
      return { ...last, [key]: result, total: result.length };
    next = last.page_token;
    if (!next || seen.has(next))
      throw new CliError(
        "api",
        "Pagination returned a missing or repeated page token",
        { code: 5 },
      );
    seen.add(next);
  }
  throw new CliError("api", "Pagination exceeded 10000 pages", { code: 5 });
}
async function safeFile(ctx, filename, output = false) {
  if (
    typeof filename !== "string" ||
    !filename ||
    /[\u0000-\u001f]/u.test(filename) ||
    filename.split(/[\\/]/).includes("..")
  )
    fail("File path must not contain control characters or parent traversal");
  const cwd = path.resolve(ctx.cwd ?? process.cwd());
  const file = path.resolve(cwd, filename.replace(/^@/, ""));
  const physicalRoot = await realpath(cwd);
  const physical = output
    ? path.join(await realpath(path.dirname(file)), path.basename(file))
    : await realpath(file);
  const relative = path.relative(physicalRoot, physical);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    fail("File path must stay within the working directory");
  if (!output && !(await stat(file)).isFile())
    fail("File path must point to a regular file");
  return file;
}
async function upload(
  ctx,
  filename,
  parentNode,
  parentType,
  extra,
  displayName,
) {
  if (ctx.dryRun) {
    if (
      typeof filename !== "string" ||
      !filename ||
      /[\u0000-\u001f]/u.test(filename) ||
      filename.split(/[\\/]/).includes("..") ||
      path.isAbsolute(filename)
    )
      fail("Upload path must be relative without traversal");
    const name = displayName || path.basename(filename);
    let size = "<file_size>";
    try {
      size = (await stat(path.resolve(ctx.cwd ?? process.cwd(), filename)))
        .size;
    } catch {}
    const fields = clean({
      file_name: name,
      parent_type: parentType,
      parent_node: parentNode,
      size,
      extra,
    });
    if (typeof size === "number" && size > 20 * 1024 ** 2) {
      await req(
        ctx,
        "POST",
        "/open-apis/drive/v1/medias/upload_prepare",
        undefined,
        fields,
      );
      await req(
        ctx,
        "POST",
        "/open-apis/drive/v1/medias/upload_part",
        undefined,
        {
          upload_id: "<upload_id>",
          seq: "<part_index>",
          size: "<part_size>",
          file: `@${filename}`,
        },
      );
      await req(
        ctx,
        "POST",
        "/open-apis/drive/v1/medias/upload_finish",
        undefined,
        { upload_id: "<upload_id>", block_num: "<part_count>" },
      );
    } else
      await req(
        ctx,
        "POST",
        "/open-apis/drive/v1/medias/upload_all",
        undefined,
        { ...fields, file: `@${filename}` },
      );
    return { file_token: "<uploaded_file_token>", name, size };
  }
  const file = await safeFile(ctx, filename);
  const info = await stat(file);
  const name = displayName || path.basename(file);
  const fields = clean({
    file_name: name,
    parent_type: parentType,
    parent_node: parentNode,
    size: info.size,
    extra,
  });
  if (info.size > 2 * 1024 ** 3) fail("Attachments must be at most 2 GiB");
  if (info.size <= 20 * 1024 ** 2) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields))
      form.set(key, String(value));
    form.set("file", new Blob([await readFile(file)]), name);
    const result = await req(
      ctx,
      "POST",
      "/open-apis/drive/v1/medias/upload_all",
      undefined,
      form,
    );
    if (!result.file_token)
      throw new CliError("api", "Upload response has no file_token", {
        code: 5,
      });
    return { file_token: result.file_token, name, size: info.size };
  }
  const ready = await req(
    ctx,
    "POST",
    "/open-apis/drive/v1/medias/upload_prepare",
    undefined,
    fields,
  );
  if (!ready.upload_id || !(ready.block_size > 0))
    throw new CliError(
      "api",
      "Multipart upload returned no upload_id/block_size",
      { code: 5 },
    );
  const bytes = await readFile(file);
  const count = Math.ceil(bytes.length / ready.block_size);
  for (let i = 0; i < count; i++) {
    const part = bytes.subarray(
      i * ready.block_size,
      (i + 1) * ready.block_size,
    );
    const form = new FormData();
    for (const [k, v] of Object.entries({
      upload_id: ready.upload_id,
      seq: i,
      size: part.length,
    }))
      form.set(k, String(v));
    form.set("file", new Blob([part]), name);
    await req(
      ctx,
      "POST",
      "/open-apis/drive/v1/medias/upload_part",
      undefined,
      form,
    );
  }
  const done = await req(
    ctx,
    "POST",
    "/open-apis/drive/v1/medias/upload_finish",
    undefined,
    { upload_id: ready.upload_id, block_num: count },
  );
  if (!done.file_token)
    throw new CliError(
      "api",
      "Multipart upload finish response has no file_token",
      { code: 5 },
    );
  return { file_token: done.file_token, name, size: info.size };
}

async function executeBase(ctx, command, f) {
  const action = command.slice(1);
  if (["base-create", "base-copy", "base-get"].includes(action)) {
    const method = action === "base-get" ? "GET" : "POST";
    const url =
      action === "base-create"
        ? "/open-apis/base/v3/bases"
        : basePath(f, ...(action === "base-copy" ? ["copy"] : []));
    const body =
      method === "GET"
        ? undefined
        : pick(f, ["name", "folder-token", "without-content", "time-zone"]);
    if (action === "base-create") required(f, "name");
    const base = await req(ctx, method, url, undefined, body);
    const result = {
      base,
      ...(action === "base-get"
        ? {}
        : { [action === "base-create" ? "created" : "copied"]: true }),
    };
    if (action !== "base-get" && ctx.identity === "bot")
      result.permission_grant = await grantCurrentUser(
        ctx,
        base.base_token ?? base.app_token ?? base.base?.base_token,
        "bitable",
      );
    return result;
  }
  if (action.startsWith("advperm-"))
    return req(ctx, "PUT", basePath(f, "advperm", "enable"), {
      enable: action === "advperm-enable",
    });
  if (action === "data-query") {
    const body = await json(ctx, f.dsl, "dsl");
    if (!has(body, "dimensions") && !has(body, "measures"))
      fail("--dsl must include dimensions or measures");
    return req(ctx, "POST", basePath(f, "data", "query"), undefined, body);
  }
  if (action.startsWith("base-block-")) {
    const op = action.slice(11);
    let body;
    let method = "POST";
    let url;
    if (op === "list") {
      url = basePath(f, "blocks", "list");
      body = pick(f, ["parent-id"]);
    } else if (op === "create") {
      url = basePath(f, "blocks");
      body = {
        type: required(f, "type"),
        name: required(f, "name"),
        ...pick(f, ["parent-id"]),
      };
    } else {
      url = basePath(
        f,
        "blocks",
        required(f, "block-id"),
        ...(op === "delete" ? [] : [op]),
      );
      if (op === "delete") method = "DELETE";
      if (op === "rename") body = { name: required(f, "name") };
      if (op === "move") {
        if (f["before-id"] && f["after-id"])
          fail("--before-id and --after-id are mutually exclusive");
        body = {
          parent_id: f["parent-id"] ?? null,
          ...pick(f, ["before-id", "after-id"]),
        };
      }
    }
    const data = await req(ctx, method, url, undefined, body);
    if (op === "list")
      return f.type && Array.isArray(data.blocks)
        ? {
            ...data,
            blocks: data.blocks.filter((x) => x.type === f.type),
            total: data.blocks.filter((x) => x.type === f.type).length,
          }
        : data;
    return {
      block: data,
      [op === "create"
        ? "created"
        : op === "delete"
          ? "deleted"
          : op === "move"
            ? "moved"
            : "renamed"]: true,
    };
  }
  if (action.startsWith("table-")) {
    const op = action.slice(6);
    if (op === "list")
      return offsetPages(ctx, f, basePath(f, "tables"), "tables", 100);
    if (op === "get") {
      const table = await req(ctx, "GET", tablePath(f));
      const fields = await offsetPages(
        ctx,
        {},
        tablePath(f, "fields"),
        "fields",
        100,
        true,
      );
      const views = await offsetPages(
        ctx,
        {},
        tablePath(f, "views"),
        "views",
        100,
        true,
      );
      return { table, fields: fields.fields, views: views.views };
    }
    if (op === "delete") {
      await req(ctx, "DELETE", tablePath(f));
      return {
        deleted: true,
        table_id: f["table-id"],
        table_name: f["table-id"],
      };
    }
    const name = required(f, "name");
    const fields = f.fields ? await json(ctx, f.fields, "fields", "array") : [];
    const viewsRaw = f.view ? await ctx.input(f.view) : undefined;
    let views = [];
    if (viewsRaw) {
      try {
        const v =
          typeof viewsRaw === "object" ? viewsRaw : JSON.parse(viewsRaw);
        views = Array.isArray(v) ? v : [v];
      } catch {
        fail("--view must be valid JSON");
      }
    }
    const table = await req(
      ctx,
      op === "create" ? "POST" : "PATCH",
      op === "create" ? basePath(f, "tables") : tablePath(f),
      undefined,
      { name },
    );
    const result = { table, ...(op === "update" ? { updated: true } : {}) };
    if (op === "create" && (fields.length || views.length)) {
      const tableId =
        table.table_id ??
        table.id ??
        table.table?.table_id ??
        (ctx.dryRun ? "<created_table_id>" : undefined);
      if (!tableId)
        throw new CliError(
          "partial_success",
          "Table created but response has no table_id for subsequent field/view operations",
          { code: 5, detail: { table } },
        );
      const target = { ...f, "table-id": tableId };
      if (fields.length) {
        const initial = await offsetPages(
          ctx,
          {},
          tablePath(target, "fields"),
          "fields",
          100,
          true,
        );
        result.fields = [];
        for (let i = 0; i < fields.length; i++) {
          const id =
            i === 0
              ? (initial.fields[0]?.field_id ?? initial.fields[0]?.id)
              : undefined;
          result.fields.push(
            await req(
              ctx,
              id ? "PUT" : "POST",
              tablePath(target, "fields", ...(id ? [id] : [])),
              undefined,
              fields[i],
            ),
          );
        }
      }
      if (views.length) {
        result.views = [];
        for (const body of views)
          result.views.push(
            await req(ctx, "POST", tablePath(target, "views"), undefined, body),
          );
      }
    }
    return result;
  }
  if (action.startsWith("field-")) {
    const op = action.slice(6);
    const collection = tablePath(f, "fields");
    if (op === "list") return offsetPages(ctx, f, collection, "fields", 200);
    const url =
      op === "create"
        ? collection
        : tablePath(
            f,
            "fields",
            required(f, "field-id"),
            ...(op === "search-options" ? ["options"] : []),
          );
    if (op === "search-options")
      return req(ctx, "GET", url, {
        offset: ints(f, "offset", 0),
        limit: ints(f, "limit", 30, 1, 200),
        ...clean({ query: f.keyword }),
      });
    let body;
    if (op === "create" || op === "update") {
      body = await json(ctx, f.json, "json");
      if (
        ["formula", "lookup"].includes(body.type) &&
        !yes(f["i-have-read-guide"])
      )
        fail("--i-have-read-guide is required for formula and lookup fields");
    }
    const field = await req(
      ctx,
      { get: "GET", create: "POST", update: "PUT", delete: "DELETE" }[op],
      url,
      undefined,
      body,
    );
    return op === "delete"
      ? { deleted: true, field_id: f["field-id"], field_name: f["field-id"] }
      : {
          field,
          ...(op === "get"
            ? {}
            : { [op === "create" ? "created" : "updated"]: true }),
        };
  }
  if (action.startsWith("view-")) {
    const op = action.slice(5);
    if (op === "list")
      return offsetPages(ctx, f, tablePath(f, "views"), "views", 200);
    if (op === "create") {
      let raw = f.json;
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(await ctx.input(raw));
        } catch {
          fail("--json must be valid JSON");
        }
      }
      const bodies = Array.isArray(raw) ? raw : [raw];
      const views = [];
      for (const body of bodies) {
        if (!body || typeof body !== "object" || !body.name)
          fail("Each view requires a name");
        views.push(
          await req(ctx, "POST", tablePath(f, "views"), undefined, {
            type: "grid",
            ...body,
          }),
        );
      }
      return { views };
    }
    const base = tablePath(f, "views", required(f, "view-id"));
    if (op === "get") return { view: await req(ctx, "GET", base) };
    if (op === "delete") {
      await req(ctx, "DELETE", base);
      return { deleted: true, view_id: f["view-id"] };
    }
    if (op === "rename")
      return req(ctx, "PATCH", base, undefined, { name: required(f, "name") });
    const [mode, ...rest] = op.split("-");
    const segment = rest.join("_");
    const body = mode === "set" ? await json(ctx, f.json, "json") : undefined;
    return {
      [segment]: await req(
        ctx,
        mode === "get" ? "GET" : "PUT",
        `${base}/${segment}`,
        undefined,
        body,
      ),
    };
  }
  if (action.startsWith("record-")) return executeRecords(ctx, action, f);
  if (action === "form-detail")
    return req(
      ctx,
      "POST",
      "/open-apis/base/v3/bases/tables/forms/detail",
      undefined,
      { share_token: required(f, "share-token") },
    );
  if (action === "form-submit") {
    const data = await json(ctx, f.json, "json");
    if (!data.fields && !data.attachments)
      fail("--json must contain fields or attachments");
    const content = data.fields ?? {};
    if (!content || Array.isArray(content) || typeof content !== "object")
      fail("--json.fields must be an object");
    if (data.attachments)
      for (const [field, files] of Object.entries(data.attachments)) {
        if (!Array.isArray(files))
          fail("--json.attachments must map fields to file arrays");
        const items = [];
        for (const filename of files)
          items.push(
            await upload(
              ctx,
              filename,
              required(f, "base-token"),
              "bitable_tmp_point",
              JSON.stringify({ share_token: required(f, "share-token") }),
            ),
          );
        content[field] = [...(content[field] ?? []), ...items];
      }
    return req(
      ctx,
      "POST",
      "/open-apis/base/v3/bases/tables/forms/submit",
      undefined,
      { share_token: required(f, "share-token"), content },
    );
  }
  if (action.startsWith("form-")) {
    const op = action.slice(5);
    const url = tablePath(f, "forms");
    if (op === "list")
      return tokenPages(
        ctx,
        "GET",
        url,
        { query: { page_size: ints(f, "page-size", 100, 1, 100) } },
        "forms",
      );
    if (op === "create")
      return req(ctx, "POST", url, undefined, {
        name: required(f, "name"),
        ...pick(f, ["description"]),
      });
    const form = `${url}/${enc(required(f, "form-id"))}`;
    if (op.startsWith("questions-")) {
      const operation = op.slice(10);
      const method = {
        list: "GET",
        create: "POST",
        update: "PATCH",
        delete: "DELETE",
      }[operation];
      const body =
        operation === "list"
          ? undefined
          : operation === "delete"
            ? {
                question_ids: await json(
                  ctx,
                  f["question-ids"],
                  "question-ids",
                  "array",
                ),
              }
            : { questions: await json(ctx, f.questions, "questions", "array") };
      return req(ctx, method, `${form}/questions`, undefined, body);
    }
    return req(
      ctx,
      { get: "GET", update: "PATCH", delete: "DELETE" }[op],
      form,
      undefined,
      op === "update" ? pick(f, ["name", "description"]) : undefined,
    );
  }
  if (action.startsWith("role-")) {
    const op = action.slice(5);
    const url = basePath(
      f,
      "roles",
      ...(["list", "create"].includes(op) ? [] : [required(f, "role-id")]),
    );
    const body = ["create", "update"].includes(op)
      ? await json(ctx, f.json, "json")
      : undefined;
    return req(
      ctx,
      {
        list: "GET",
        get: "GET",
        create: "POST",
        update: "PUT",
        delete: "DELETE",
      }[op],
      url,
      undefined,
      body,
    );
  }
  if (action.startsWith("workflow-")) {
    const op = action.slice(9);
    if (op === "list")
      return tokenPages(
        ctx,
        "POST",
        basePath(f, "workflows", "list"),
        {
          body: {
            page_size: ints(f, "page-size", 100, 1, 100),
            ...pick(f, ["status"]),
          },
        },
        "items",
      );
    const url = basePath(
      f,
      "workflows",
      ...(op === "create" ? [] : [required(f, "workflow-id")]),
      ...(["enable", "disable"].includes(op) ? [op] : []),
    );
    const body = ["create", "update"].includes(op)
      ? await json(ctx, f.json, "json")
      : undefined;
    return req(
      ctx,
      {
        get: "GET",
        create: "POST",
        update: "PUT",
        enable: "PATCH",
        disable: "PATCH",
      }[op],
      url,
      op === "get" ? pick(f, ["user-id-type"]) : undefined,
      body,
    );
  }
  if (action.startsWith("dashboard-")) {
    if (action === "dashboard-block-get-data")
      return req(
        ctx,
        "GET",
        basePath(f, "dashboards", "blocks", required(f, "block-id"), "data"),
      );
    const block = action.startsWith("dashboard-block-");
    const op = action.slice(block ? 16 : 10);
    const parts = ["dashboards"];
    if (block || !["list", "create"].includes(op))
      parts.push(required(f, "dashboard-id"));
    if (block) {
      parts.push("blocks");
      if (!["list", "create"].includes(op)) parts.push(required(f, "block-id"));
    }
    if (op === "arrange") parts.push("arrange");
    let body;
    if (["create", "update"].includes(op)) {
      if (op === "create" && !block) required(f, "name");
      body = pick(f, ["name", ...(block ? ["type"] : [])]);
      if (f["theme-style"]) body.theme = { theme_style: f["theme-style"] };
      if (f["data-config"])
        body.data_config = await json(ctx, f["data-config"], "data-config");
    }
    if (op === "arrange") body = {};
    const query =
      op === "list"
        ? pick(f, ["page-size", "page-token"])
        : pick(f, ["user-id-type"]);
    return req(
      ctx,
      {
        list: "GET",
        get: "GET",
        create: "POST",
        update: "PATCH",
        delete: "DELETE",
        arrange: "POST",
      }[op],
      basePath(f, ...parts),
      query,
      body,
    );
  }
  return undefined;
}

async function executeRecords(ctx, action, f) {
  if (action === "record-history-list")
    return req(ctx, "GET", basePath(f, "record_history"), {
      table_id: required(f, "table-id"),
      record_id: required(f, "record-id"),
      page_size: ints(f, "page-size", 20, 1, 100),
      ...pick(f, ["max-version"]),
    });
  const records = tablePath(f, "records");
  if (action === "record-list") {
    const query = {
      offset: ints(f, "offset", 0),
      limit: ints(f, "limit", 20, 1, 200),
      ...pick(f, ["view-id"]),
    };
    if (f["field-id"]) query.field_id = list(f["field-id"]);
    if (f["filter-json"])
      query.filter = JSON.stringify(
        await json(ctx, f["filter-json"], "filter-json"),
      );
    if (f["sort-json"]) {
      const v = await json(
        ctx,
        f["sort-json"],
        "sort-json",
        Array.isArray(f["sort-json"]) ||
          String(f["sort-json"]).trim().startsWith("[")
          ? "array"
          : "object",
      );
      query.sort = JSON.stringify(v.sort_config ?? v);
    }
    return req(ctx, "GET", records, query);
  }
  if (["record-get", "record-delete"].includes(action)) {
    if (f.json && f["record-id"])
      fail("--json and --record-id are mutually exclusive");
    const body = f.json
      ? await json(ctx, f.json, "json")
      : { record_id_list: list(required(f, "record-id")) };
    uniqueStrings(body.record_id_list, "record_id_list", 200);
    if (f["field-id"]) {
      if (body.select_fields)
        fail("--field-id and --json.select_fields are mutually exclusive");
      body.select_fields = list(f["field-id"]);
    }
    if (body.select_fields)
      uniqueStrings(body.select_fields, "select_fields", 100);
    return req(
      ctx,
      "POST",
      `${records}/${action === "record-get" ? "batch_get" : "batch_delete"}`,
      undefined,
      action === "record-delete"
        ? { record_id_list: body.record_id_list }
        : body,
    );
  }
  if (action === "record-search") {
    const body = f.json
      ? await json(ctx, f.json, "json")
      : {
          keyword: required(f, "keyword"),
          search_fields: list(required(f, "search-field")),
          offset: ints(f, "offset", 0),
          limit: ints(f, "limit", 10, 1, 200),
          ...pick(f, ["view-id"]),
        };
    uniqueStrings(body.search_fields, "search_fields", 20);
    if (typeof body.keyword !== "string" || !body.keyword)
      fail("Search keyword must not be empty");
    if (f["field-id"]) body.select_fields = list(f["field-id"]);
    if (f["filter-json"])
      body.filter = await json(ctx, f["filter-json"], "filter-json");
    if (f["sort-json"]) {
      const raw = await ctx.input(f["sort-json"]);
      const parsed = typeof raw === "object" ? raw : JSON.parse(raw);
      body.sort = parsed.sort_config ?? parsed;
    }
    return req(ctx, "POST", `${records}/search`, undefined, body);
  }
  if (action === "record-upsert")
    return req(
      ctx,
      f["record-id"] ? "PATCH" : "POST",
      `${records}${f["record-id"] ? "/" + enc(f["record-id"]) : ""}`,
      undefined,
      await json(ctx, f.json, "json"),
    );
  if (action === "record-batch-create" || action === "record-batch-update")
    return req(
      ctx,
      "POST",
      `${records}/${action === "record-batch-create" ? "batch_create" : "batch_update"}`,
      undefined,
      await json(ctx, f.json, "json"),
    );
  if (action === "record-share-link-create") {
    const ids = [...new Set(list(required(f, "record-ids")))];
    if (ids.length > 100) fail("--record-ids supports at most 100 records");
    return req(ctx, "POST", `${records}/share_links/batch`, undefined, {
      record_ids: ids,
    });
  }
  if (
    action === "record-upload-attachment" ||
    action === "record-remove-attachment"
  ) {
    const record = required(f, "record-id"),
      field = required(f, "field-id");
    await req(ctx, "GET", tablePath(f, "fields", field));
    let items;
    if (action === "record-upload-attachment") {
      const files = list(required(f, "file"));
      if (files.length > 50) fail("At most 50 attachments are allowed");
      items = [];
      for (const file of files)
        items.push(
          await upload(ctx, file, required(f, "base-token"), "bitable_file"),
        );
    } else
      items = uniqueStrings(
        list(required(f, "file-token")),
        "file-token",
        50,
      ).map((file_token) => ({ file_token }));
    const body = { attachments: { [record]: { [field]: items } } };
    return req(
      ctx,
      "POST",
      tablePath(
        f,
        action === "record-upload-attachment"
          ? "append_attachments"
          : "remove_attachments",
      ),
      undefined,
      body,
    );
  }
  if (action === "record-download-attachment") {
    const data = await req(
      ctx,
      "POST",
      tablePath(f, "get_attachments"),
      undefined,
      { record_id_list: [required(f, "record-id")] },
    );
    const wanted = list(f["file-token"]);
    const attachments = [];
    const collect = (value) => {
      if (Array.isArray(value)) for (const item of value) collect(item);
      else if (value && typeof value === "object") {
        if (value.file_token) attachments.push(value);
        else for (const item of Object.values(value)) collect(item);
      }
    };
    collect(data.attachments);
    const files = attachments.filter(
      (x) => !wanted.length || wanted.includes(x.file_token),
    );
    const output = required(f, "output");
    if (ctx.dryRun) {
      await req(
        ctx,
        "GET",
        "/open-apis/drive/v1/medias/<file_token>/download",
        { extra: "<attachment_extra_info>" },
      );
      return data;
    }
    let directory = false;
    try {
      directory = (
        await stat(path.resolve(ctx.cwd ?? process.cwd(), output))
      ).isDirectory();
    } catch {}
    if (!directory && files.length !== 1)
      fail(
        "--output must be an existing directory when downloading multiple attachments",
      );
    const downloaded = [];
    for (const item of files) {
      const filename = directory
        ? path.join(output, path.basename(item.name ?? item.file_token))
        : output;
      const target = await safeFile(ctx, filename, true);
      const bytes = await ctx.request(
        "GET",
        `/open-apis/drive/v1/medias/${enc(item.file_token)}/download`,
        { query: clean({ extra: item.extra_info }), responseType: "buffer" },
      );
      await writeFile(target, bytes, {
        flag: yes(f.overwrite) ? "w" : "wx",
        mode: 0o600,
      });
      downloaded.push({ file_token: item.file_token, output: target });
    }
    return { downloaded };
  }
  return undefined;
}

export async function executeTables(ctx, service, command, flags = {}) {
  if (!commandSpecs[service]?.[command]) return undefined;
  if (
    commandSpecs[service][command].risk === "high-risk-write" &&
    !ctx.dryRun &&
    !yes(flags.yes)
  )
    throw new CliError(
      "confirmation_required",
      "This operation requires --yes",
      { code: 10, hint: "Preview with --dry-run, then add --yes to confirm." },
    );
  if (service === "base") {
    const f = { ...flags };
    for (const def of commandSpecs.base[command].flags ?? [])
      if (!has(f, def.name) && def.default !== undefined)
        f[def.name] = /^(?:int|int64|float64)$/.test(def.type)
          ? Number(def.default)
          : def.type === "bool"
            ? def.default === "true"
            : def.default;
    if (["+record-list", "+record-get", "+record-search"].includes(command)) {
      const format = f.format ?? (f.jq ? "json" : "markdown");
      if (!["json", "markdown"].includes(format))
        fail("--format must be json or markdown");
      if (format === "markdown" && f.jq)
        fail("--jq and --format markdown are mutually exclusive");
      const result = await executeBase(ctx, command, f);
      return format === "markdown" && !ctx.dryRun
        ? (recordMarkdown(result, command === "+record-get") ?? result)
        : result;
    }
    return executeBase(ctx, command, f);
  }
  return defs[command]
    ? executeSheets(ctx, command, flags)
    : executeLegacySheets(ctx, command, flags);
}

async function grantCurrentUser(ctx, token, type) {
  const user = ctx.config?.userOpenId ?? ctx.user?.open_id;
  if (!user || !token)
    return {
      status: "skipped",
      perm: "full_access",
      message: !user
        ? "No current user open_id is configured; continue using bot identity or grant permission manually."
        : "Created resource returned no permission target.",
    };
  try {
    await req(
      ctx,
      "POST",
      `/open-apis/drive/v1/permissions/${enc(token)}/members`,
      { type, need_notification: false },
      {
        member_type: "openid",
        member_id: user,
        perm: "full_access",
        type: "user",
      },
    );
    return {
      status: "granted",
      perm: "full_access",
      member_type: "openid",
      user_open_id: user,
      message: "Granted the current CLI user full_access on the new resource.",
    };
  } catch (error) {
    return {
      status: "failed",
      perm: "full_access",
      member_type: "openid",
      user_open_id: user,
      message: `Resource was created, but granting permission failed: ${error.message}`,
      hint: "Retry the permission grant or continue using bot identity; do not create the resource again.",
    };
  }
}
function recordMarkdown(data, single) {
  if (
    !Array.isArray(data?.fields) ||
    !data.fields.length ||
    !Array.isArray(data.data)
  )
    return undefined;
  const fields = data.fields.filter((x) => typeof x === "string");
  const ids = data.record_id_list ?? [];
  const value = (x) =>
    x === null || x === undefined
      ? ""
      : typeof x === "object"
        ? JSON.stringify(x)
        : String(x);
  const cell = (x) =>
    value(x)
      .replaceAll("\\", "\\\\")
      .replaceAll("|", "\\|")
      .replace(/\r?\n/g, "<br>");
  const sequence = (x) =>
    x === undefined || x === null
      ? []
      : Array.isArray(x)
        ? x.map(value)
        : [value(x)];
  const missing = sequence(data.record_not_found);
  const ignored = sequence(data.ignored_fields);
  let text =
    "`_record_id` is metadata for record operations, not a table field.\n\n";
  if (single && ids.length === 1 && data.data.length === 1) {
    if (missing.includes(ids[0])) text = "Record not found.\n\n";
    text += `- \`_record_id\`: ${value(ids[0])}\n`;
    if (!missing.includes(ids[0]))
      fields.forEach((name, i) => {
        text += `- \`${name}\`: ${value(data.data[0]?.[i])}\n`;
      });
  } else {
    text += `| ${["_record_id", ...fields].map(cell).join(" | ")} |\n| ${["_record_id", ...fields].map(() => "---").join(" | ")} |\n`;
    data.data.forEach((row, i) => {
      text += `| ${[ids[i] ?? "", ...fields.map((_, j) => row?.[j])].map(cell).join(" | ")} |\n`;
    });
  }
  const meta = [`count=${ids.length}`];
  if (has(data, "has_more")) meta.push(`has_more=${value(data.has_more)}`);
  for (const name of ["record_scope", "field_scope", "search_scope"])
    if (has(data.query_context ?? {}, name))
      meta.push(`${name}=${value(data.query_context[name])}`);
  if (ignored.length) meta.push(`ignored_fields=${ignored.length}`);
  if (missing.length) meta.push(`record_not_found=${missing.length}`);
  text += "\nMeta: " + meta.join("; ") + "\n";
  if (ignored.length)
    text += `Ignored fields: ${ignored.slice(0, 20).join(", ")}${ignored.length > 20 ? `, ...(${ignored.length} total)` : ""}\n`;
  if (missing.length) text += `Missing records: ${missing.join(", ")}\n`;
  return { __raw: text };
}

function applySheetDefaults(command, flags) {
  const f = { ...flags };
  for (const def of defs[command].flags) {
    if (def.kind === "system") continue;
    if (!has(f, def.name) && def.default !== undefined) {
      f[def.name] = ["int", "int64", "float64"].includes(def.type)
        ? Number(def.default)
        : def.type === "bool"
          ? def.default === "true"
          : def.default;
    }
    if (
      def.required === "required" &&
      (f[def.name] === undefined ||
        (f[def.name] === "" && !["replacement", "color"].includes(def.name)))
    )
      fail(`--${def.name} is required`);
    if (!has(f, def.name)) continue;
    if (["int", "int64", "float64"].includes(def.type)) {
      const value = Number(f[def.name]);
      if (
        !Number.isFinite(value) ||
        (def.type !== "float64" && !Number.isInteger(value))
      )
        fail(
          `--${def.name} must be ${def.type === "float64" ? "a number" : "an integer"}`,
        );
      f[def.name] = value;
    }
    if (def.type === "bool") {
      if (![true, false, "true", "false"].includes(f[def.name]))
        fail(`--${def.name} must be true or false`);
      f[def.name] = yes(f[def.name]);
    }
    if (def.enum?.length) {
      const entries = ["string_slice", "string_array"].includes(def.type)
        ? list(f[def.name])
        : [f[def.name]];
      if (entries.some((x) => !def.enum.includes(String(x))))
        fail(`--${def.name} must be one of: ${def.enum.join(", ")}`);
    }
  }
  return f;
}
function sheetToken(f) {
  if (Boolean(f.url) === Boolean(f["spreadsheet-token"]))
    fail("Specify exactly one of --url or --spreadsheet-token");
  if (f["spreadsheet-token"]) return String(f["spreadsheet-token"]);
  let url;
  try {
    url = new URL(f.url);
  } catch {
    fail("--url must be a spreadsheet URL");
  }
  const match = url.pathname.match(/\/(?:sheets|spreadsheets)\/([^/]+)/);
  if (!match) fail("--url must contain /sheets/<token>");
  return decodeURIComponent(match[1]);
}
function validateSchema(value, schema, label) {
  if (!schema || (value === null && schema.nullable)) return;
  const matches = (candidate) => {
    try {
      validateSchema(value, candidate, label);
      return true;
    } catch {
      return false;
    }
  };
  if (schema.oneOf && schema.oneOf.filter(matches).length !== 1)
    fail(`${label} does not match exactly one supported shape`);
  if (schema.anyOf && !schema.anyOf.some(matches))
    fail(`${label} does not match a supported shape`);
  for (const item of schema.allOf ?? []) validateSchema(value, item, label);
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  const correct = (type) =>
    type === "array"
      ? Array.isArray(value)
      : type === "object"
        ? value !== null && typeof value === "object" && !Array.isArray(value)
        : type === "integer"
          ? Number.isInteger(value)
          : type === "null"
            ? value === null
            : typeof value === type;
  if (types.length && !types.some(correct))
    fail(`${label} must be ${types.join(" or ")}`);
  if (
    schema.enum &&
    !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
  )
    fail(`${label} has an unsupported value`);
  if (
    typeof value === "number" &&
    ((schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  )
    fail(`${label} is outside the supported numeric range`);
  if (
    typeof value === "string" &&
    ((schema.minLength !== undefined && value.length < schema.minLength) ||
      (schema.maxLength !== undefined && value.length > schema.maxLength))
  )
    fail(`${label} has an invalid length`);
  if (Array.isArray(value)) {
    if (
      (schema.minItems !== undefined && value.length < schema.minItems) ||
      (schema.maxItems !== undefined && value.length > schema.maxItems)
    )
      fail(`${label} has an invalid number of entries`);
    if (schema.items)
      value.forEach((item, index) =>
        validateSchema(item, schema.items, `${label}[${index}]`),
      );
  } else if (value && typeof value === "object") {
    for (const key of schema.required ?? [])
      if (!has(value, key)) fail(`${label}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key])
        validateSchema(item, schema.properties[key], `${label}.${key}`);
      else if (schema.additionalProperties === false)
        fail(`${label}.${key} is not supported`);
    }
  }
}
function validateToolInput(command, built) {
  for (const field of ["properties", "cells"])
    if (built?.input[field] !== undefined && schemas[command]?.[field])
      validateSchema(built.input[field], schemas[command][field], `--${field}`);
}
function selector(f, optional = false, prefix = "") {
  const id = f[`${prefix}sheet-id`],
    name = f[`${prefix}sheet-name`];
  if (id && name)
    fail(
      `--${prefix}sheet-id and --${prefix}sheet-name are mutually exclusive`,
    );
  if (!id && !name && !optional)
    fail(`Specify --${prefix}sheet-id or --${prefix}sheet-name`);
  return clean({ sheet_id: id || undefined, sheet_name: name || undefined });
}
const toolPath = (token, read = false) =>
  `/open-apis/sheet_ai/v2/spreadsheets/${enc(token)}/tools/invoke_${read ? "read" : "write"}`;
async function sheetCall(ctx, token, tool, input, read = false) {
  const data = await req(ctx, "POST", toolPath(token, read), undefined, {
    tool_name: tool,
    input: JSON.stringify(input),
  });
  if (ctx.dryRun) return data;
  if (!data?.output) return null;
  if (typeof data.output !== "string")
    throw new CliError("api", `Tool ${tool} returned a non-string output`, {
      code: 5,
    });
  try {
    return JSON.parse(data.output);
  } catch {
    throw new CliError("api", `Tool ${tool} returned invalid JSON output`, {
      code: 5,
    });
  }
}
function rectangle(range) {
  const m = String(range).match(
    /^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/,
  );
  if (!m) fail("A finite A1 cell range is required, such as A1:C5");
  const col = (s) =>
    Array.from(s.toUpperCase()).reduce(
      (n, c) => n * 26 + c.charCodeAt(0) - 64,
      0,
    );
  const rows = Number(m[4] ?? m[2]) - Number(m[2]) + 1,
    cols = col(m[3] ?? m[1]) - col(m[1]) + 1;
  if (rows < 1 || cols < 1 || rows * cols > 50000)
    fail("Range must contain 1 to 50000 cells in ascending order");
  return { rows, cols };
}
const matrix = (range, cell) => {
  const { rows, cols } = rectangle(range);
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => structuredClone(cell)),
  );
};
function imageSize(bytes) {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (
    bytes.length >= 10 &&
    /GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"))
  )
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 26 && bytes.subarray(0, 2).toString("ascii") === "BM")
    return {
      width: Math.abs(bytes.readInt32LE(18)),
      height: Math.abs(bytes.readInt32LE(22)),
    };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (
        [0xd8, 0xd9, 0x01].includes(marker) ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        offset += 2;
        continue;
      }
      const size = bytes.readUInt16BE(offset + 2);
      if (size < 2 || offset + size + 2 > bytes.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      )
        return {
          width: bytes.readUInt16BE(offset + 7),
          height: bytes.readUInt16BE(offset + 5),
        };
      offset += size + 2;
    }
  }
  fail(
    "Cannot read image dimensions; use a valid PNG, JPEG, GIF, or BMP image",
  );
}
function colName(index) {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
async function style(ctx, f) {
  const result = pick(f, [
    "background-color",
    "font-color",
    "font-size",
    "font-style",
    "font-weight",
    "font-line",
    "horizontal-alignment",
    "vertical-alignment",
    "word-wrap",
    "number-format",
  ]);
  const cell = {};
  if (Object.keys(result).length) cell.cell_styles = result;
  if (f["border-styles"])
    cell.border_styles = await json(ctx, f["border-styles"], "border-styles");
  if (!Object.keys(cell).length) fail("At least one style flag is required");
  return cell;
}
async function dropdown(ctx, f) {
  if (Boolean(f.options) === Boolean(f["source-range"]))
    fail("Specify exactly one of --options or --source-range");
  const result = f.options
    ? { type: "list", items: await json(ctx, f.options, "options", "array") }
    : { type: "listFromRange", range: f["source-range"] };
  if (f.colors)
    result.highlight_colors = await json(ctx, f.colors, "colors", "array");
  if (result.items && result.highlight_colors?.length > result.items.length)
    fail("--colors cannot have more entries than --options");
  if (yes(f.multiple)) result.support_multiple_values = true;
  if (has(f, "highlight")) result.enable_highlight = yes(f.highlight);
  return { data_validation: result };
}
const OBJECTS = {
  chart: ["chart", "chart-id", "chart_id"],
  pivot: ["pivot_table", "pivot-table-id", "pivot_table_id"],
  "cond-format": ["conditional_format", "rule-id", "conditional_format_id"],
  filter: ["filter", "", "filter_id"],
  "filter-view": ["filter_view", "view-id", "view_id"],
  sparkline: ["sparkline", "group-id", "group_id"],
  "float-image": ["float_image", "float-image-id", "float_image_id"],
};
function searchOptions(f) {
  return clean(
    Object.fromEntries(
      [
        ["match-case", "match_case"],
        ["match-entire-cell", "match_entire_cell"],
        ["regex", "use_regex"],
        ["include-formulas", "match_formulas"],
      ]
        .filter(([key]) => yes(f[key]))
        .map(([, key]) => [key, true]),
    ),
  );
}

async function buildSheetTool(ctx, command, f, token, changed = f) {
  const input = { excel_id: token };
  if (command === "+workbook-info")
    return { tool: "get_workbook_structure", input, read: true };
  const noSelector = command === "+sheet-create";
  const pivotCreate = command === "+pivot-create";
  Object.assign(
    input,
    selector(f, noSelector || pivotCreate, pivotCreate ? "target-" : ""),
  );
  if (command.startsWith("+sheet-") && command !== "+sheet-info") {
    const op = command.slice(7);
    input.operation =
      { copy: "duplicate", "set-tab-color": "set_tab_color" }[op] ?? op;
    if (op === "create") {
      input.sheet_name = f.title;
      input.rows = f["row-count"];
      input.columns = f["col-count"];
    }
    if (op === "rename") input.new_name = f.title;
    if (op === "copy" && f.title) input.new_name = f.title;
    if (has(changed, "index")) input.target_index = ints(f, "index", 0);
    if (op === "set-tab-color") input.tab_color = f.color;
    if (op === "move") {
      let id = f["sheet-id"],
        source = changed["source-index"];
      if (!id || source === undefined) {
        const info = await sheetCall(
          ctx,
          token,
          "get_workbook_structure",
          { excel_id: token },
          true,
        );
        const sheets = Array.isArray(info)
          ? info
          : (info?.sheets ?? info?.sheet_list ?? []);
        const item = sheets.find((x) =>
          id
            ? (x.sheet_id ?? x.reference_id) === id
            : (x.title ?? x.name) === f["sheet-name"],
        );
        if (!item && !ctx.dryRun)
          throw new CliError("api", "Sheet lookup returned no matching sheet", {
            code: 5,
          });
        id =
          item?.sheet_id ??
          item?.reference_id ??
          (ctx.dryRun ? "<resolved_sheet_id>" : undefined);
        source = source ?? item?.index ?? "<resolved_source_index>";
      }
      delete input.sheet_name;
      input.sheet_id = id;
      input.source_index = source;
    }
    return { tool: "modify_workbook_structure", input };
  }
  if (command === "+sheet-info") {
    if (f.range) input.range = f.range;
    const include = list(f.include);
    if (include.length) {
      const mapping = {
        row_heights: "row_heights_column_widths",
        col_widths: "row_heights_column_widths",
        hidden_rows: "hidden_infos",
        hidden_cols: "hidden_infos",
        groups: "group_infos",
        merges: "merged_cells_infos",
      };
      const groups = [...new Set(include.map((x) => mapping[x] ?? "all"))];
      input.info_type = groups.length === 1 ? groups[0] : "all";
    }
    return { tool: "get_sheet_structure", input, read: true };
  }
  if (command.startsWith("+dim-")) {
    const op = command.slice(5);
    input.operation = op;
    if (op === "insert") {
      input.position = f.position;
      input.count = ints(f, "count", 1, 1);
      if (f["inherit-style"] !== "none") input.side = f["inherit-style"];
    } else if (op === "freeze") {
      const count = ints(f, "count", 0);
      input.operation = count ? "freeze" : "unfreeze";
      if (count)
        input[f.dimension === "row" ? "freeze_rows" : "freeze_columns"] = count;
    } else {
      input.range = f.range;
      if (op === "group") input.group_state = f["group-state"];
    }
    return { tool: "modify_sheet_structure", input };
  }
  if (command === "+cells-get" || command === "+dropdown-get") {
    input.ranges = [f.range];
    if (command === "+dropdown-get") {
      input.include_styles = false;
      input.value_render_option = "formatted_value";
    } else {
      input.cell_limit = 1000000000;
      input.max_chars = f["max-chars"];
      const include = list(f.include);
      if (include.length) {
        input.include_styles = include.includes("style");
        if (include.includes("formula")) input.value_render_option = "formula";
      }
      if (yes(f["skip-hidden"])) input.skip_hidden = true;
    }
    return { tool: "get_cell_ranges", input, read: true };
  }
  if (command === "+csv-get") {
    input.range = f.range;
    input.max_rows = 1000000000;
    input.max_chars = f["max-chars"];
    if (yes(f["skip-hidden"])) input.skip_hidden = true;
    return { tool: "get_range_as_csv", input, read: true };
  }
  if (command === "+cells-search" || command === "+cells-replace") {
    input.search_term = f.find;
    if (f.range) input.range = f.range;
    const options = searchOptions(f);
    if (Object.keys(options).length) input.options = options;
    if (command === "+cells-search") {
      if (f.offset > 0) input.offset = f.offset;
      input.max_matches = f["max-matches"];
    } else input.replace_term = f.replacement;
    return {
      tool: command === "+cells-search" ? "search_data" : "replace_data",
      input,
      read: command === "+cells-search",
    };
  }
  if (
    [
      "+cells-set",
      "+cells-set-style",
      "+dropdown-set",
      "+cells-set-image",
    ].includes(command)
  ) {
    input.range = f.range;
    let uploaded;
    if (command === "+cells-set") {
      input.cells = await json(ctx, f.cells, "cells", "array");
      if (!yes(f["allow-overwrite"])) input.allow_overwrite = false;
      if (f["copy-to-range"]) input.copy_to_range = f["copy-to-range"];
    } else if (command === "+cells-set-style")
      input.cells = matrix(f.range, await style(ctx, f));
    else if (command === "+dropdown-set")
      input.cells = matrix(f.range, await dropdown(ctx, f));
    else {
      const size = rectangle(f.range);
      if (size.rows !== 1 || size.cols !== 1)
        fail("--range must select exactly one cell for an embedded image");
      const dimensions = ctx.dryRun
        ? { width: "<image_width>", height: "<image_height>" }
        : imageSize(await readFile(await safeFile(ctx, f.image)));
      uploaded = await upload(
        ctx,
        f.image,
        token,
        "sheet_image",
        undefined,
        f.name,
      );
      input.cells = [
        [
          {
            rich_text: [
              {
                type: "embed-image",
                text: "",
                image_token: uploaded.file_token,
                image_width: dimensions.width,
                image_height: dimensions.height,
              },
            ],
          },
        ],
      ];
    }
    return { tool: "set_cell_range", input, uploaded };
  }
  if (command === "+csv-put") {
    input.csv = await ctx.input(f.csv);
    input.start_cell = has(changed, "start-cell")
      ? f["start-cell"]
      : (f.range?.split(":")[0] ?? f["start-cell"]);
    if (!/^\$?[A-Za-z]+\$?[1-9]\d*$/.test(input.start_cell))
      fail("--start-cell must be an A1 cell");
    if (!yes(f["allow-overwrite"])) input.allow_overwrite = false;
    return { tool: "set_range_from_csv", input };
  }
  if (command === "+cells-clear") {
    input.range = f.range;
    input.clear_type = f.scope === "content" ? "contents" : f.scope;
    return { tool: "clear_cell_range", input };
  }
  if (command === "+cells-merge" || command === "+cells-unmerge") {
    input.range = f.range;
    input.operation = command === "+cells-merge" ? "merge" : "unmerge";
    if (input.operation === "merge") input.merge_type = f["merge-type"];
    return { tool: "merge_cells", input };
  }
  if (command === "+rows-resize" || command === "+cols-resize") {
    input.range = f.range.includes(":") ? f.range : `${f.range}:${f.range}`;
    if (f.type === "pixel" && !(f.size > 0))
      fail("--size must be positive for --type pixel");
    input[command === "+rows-resize" ? "resize_height" : "resize_width"] =
      f.type === "pixel" ? { type: f.type, value: f.size } : { type: f.type };
    return { tool: "resize_range", input };
  }
  if (command.startsWith("+range-")) {
    input.operation = command.slice(7);
    input.range = f["source-range"] ?? f.range;
    if (input.operation === "sort") {
      input.sort_conditions = await json(
        ctx,
        f["sort-keys"],
        "sort-keys",
        "array",
      );
      if (yes(f["has-header"])) input.has_header = true;
    } else {
      input.destination_range = f["target-range"];
      if (f["target-sheet-id"])
        input.destination_sheet_id = f["target-sheet-id"];
    }
    if (input.operation === "fill")
      input.fill_type =
        f["series-type"] === "copy" ? "copyCells" : "fillSeries";
    if (input.operation === "copy" && f["paste-type"] !== "all")
      input.paste_type = {
        values: "value_only",
        formulas: "formula_only",
        formats: "format_only",
      }[f["paste-type"]];
    return { tool: "transform_range", input };
  }
  for (const [prefix, [object, idFlag, idField]] of Object.entries(
    OBJECTS,
  ).sort((a, b) => b[0].length - a[0].length))
    if (command.startsWith(`+${prefix}-`)) {
      const op = command.slice(prefix.length + 2);
      if (op === "list") {
        if (idFlag && f[idFlag]) input[idField] = f[idFlag];
        return { tool: `get_${object}_objects`, input, read: true };
      }
      input.operation = op;
      if (idFlag && op !== "create") input[idField] = required(f, idFlag);
      if (prefix === "filter" && op !== "create") {
        if (!f["sheet-id"]) fail("Filter update/delete requires --sheet-id");
        input.filter_id = f["sheet-id"];
      }
      if (op !== "delete") {
        input.properties =
          prefix === "float-image"
            ? {}
            : await json(
                ctx,
                f.properties,
                "properties",
                "object",
                prefix === "filter" ? {} : undefined,
              );
        if (prefix === "pivot" && op === "create") {
          input.properties.source = f.source;
          if (f.range) input.properties.range = f.range;
          if (f["target-position"] !== "A1")
            input.target_position = f["target-position"];
        }
        if (prefix === "cond-format") {
          input.properties.rule_type = f["rule-type"];
          input.properties.ranges = await json(
            ctx,
            f.ranges,
            "ranges",
            "array",
          );
        }
        if (prefix === "filter" || prefix === "filter-view") {
          if (f.range) input.properties.range = f.range;
          if (f["view-name"]) input.properties.view_name = f["view-name"];
        }
        if (
          prefix === "sparkline" &&
          op === "update" &&
          input.properties.sparklines?.some((x) => !x.sparkline_id)
        )
          fail(
            "Every updated sparkline needs sparkline_id; read +sparkline-list first",
          );
        if (prefix === "float-image") {
          const count = [f.image, f["image-token"], f["image-uri"]].filter(
            Boolean,
          ).length;
          if (count !== 1)
            fail(
              "Specify exactly one of --image, --image-token, or --image-uri",
            );
          const imageToken = f.image
            ? (await upload(ctx, f.image, token, "sheet_image")).file_token
            : f["image-token"];
          input.properties = {
            image_name: f["image-name"],
            position: { row: f["position-row"], col: f["position-col"] },
            size: { width: f["size-width"], height: f["size-height"] },
            ...clean({ image_token: imageToken, image_uri: f["image-uri"] }),
          };
          if (has(f, "offset-row") || has(f, "offset-col"))
            input.properties.offset = clean({
              row_offset: f["offset-row"],
              col_offset: f["offset-col"],
            });
          if (has(f, "z-index")) input.properties.z_index = f["z-index"];
        }
      }
      return { tool: `manage_${object}_object`, input };
    }
  return undefined;
}

async function executeSheets(ctx, command, original) {
  if (yes(original["print-schema"])) {
    const flags = schemas[command];
    if (!flags) fail(`No composite flag schema exists for ${command}`);
    if (original["flag-name"]) {
      const schema = flags[original["flag-name"]];
      if (!schema) fail(`No schema for --${original["flag-name"]}`);
      return { command, flag: original["flag-name"], schema };
    }
    return { command, flags };
  }
  const f = applySheetDefaults(command, original);
  if (command === "+workbook-create") {
    const headers = f.headers
      ? await json(ctx, f.headers, "headers", "array")
      : [];
    const values = f.values ? await json(ctx, f.values, "values", "array") : [];
    const created = await req(
      ctx,
      "POST",
      "/open-apis/sheets/v3/spreadsheets",
      undefined,
      { title: f.title, ...pick(f, ["folder-token"]) },
    );
    const spreadsheet = created.spreadsheet ?? created;
    const token =
      spreadsheet.spreadsheet_token ??
      spreadsheet.token ??
      (ctx.dryRun ? "<created_spreadsheet_token>" : undefined);
    if (!token)
      throw new CliError(
        "api",
        "Spreadsheet created but response has no token",
        { code: 5 },
      );
    if (!headers.length && !values.length) return { spreadsheet };
    const rows = [...(headers.length ? [headers] : []), ...values];
    if (rows.some((x) => !Array.isArray(x)))
      fail("--values must be a two-dimensional array");
    const width = Math.max(...rows.map((x) => x.length));
    if (!width) return { spreadsheet };
    try {
      const info = await sheetCall(
        ctx,
        token,
        "get_workbook_structure",
        { excel_id: token },
        true,
      );
      const sheets = Array.isArray(info)
        ? info
        : (info?.sheets ?? info?.sheet_list ?? []);
      const sheetId =
        sheets[0]?.sheet_id ??
        sheets[0]?.reference_id ??
        (ctx.dryRun ? "<first_sheet_id>" : undefined);
      if (!sheetId)
        throw new CliError(
          "api",
          "No initial sheet returned for new spreadsheet",
          { code: 5 },
        );
      const cells = rows.map((row) =>
        Array.from({ length: width }, (_, i) =>
          row[i] === undefined
            ? {}
            : typeof row[i] === "object" && row[i] !== null
              ? row[i]
              : { value: row[i] },
        ),
      );
      const initial_fill = await sheetCall(ctx, token, "set_cell_range", {
        excel_id: token,
        sheet_id: sheetId,
        range: `A1:${colName(width - 1)}${rows.length}`,
        cells,
      });
      return { spreadsheet, initial_fill };
    } catch (e) {
      throw new CliError(
        "partial_success",
        `Spreadsheet created but initial fill failed: ${e.message}`,
        { code: 5, detail: { spreadsheet, spreadsheet_token: token } },
      );
    }
  }
  const token = sheetToken(f);
  if (command === "+workbook-export") {
    if (f["file-extension"] === "csv" && !f["sheet-id"])
      fail("--sheet-id is required for CSV export");
    const task = await req(
      ctx,
      "POST",
      "/open-apis/drive/v1/export_tasks",
      undefined,
      {
        token,
        type: "sheet",
        file_extension: f["file-extension"],
        ...clean({ sub_id: f["sheet-id"] }),
      },
    );
    const ticket = task.ticket ?? (ctx.dryRun ? "<ticket>" : undefined);
    if (!ticket)
      throw new CliError("api", "Export response has no ticket", { code: 5 });
    let result;
    for (let i = 0; i < 15; i++) {
      const data = await req(
        ctx,
        "GET",
        `/open-apis/drive/v1/export_tasks/${enc(ticket)}`,
        { token },
      );
      result = data.result;
      if (ctx.dryRun || result?.job_status === 0) break;
      if (![1, 2].includes(result?.job_status))
        throw new CliError(
          "api",
          result?.job_error_msg ?? "Export task failed",
          { code: 5 },
        );
      await delay(2000);
    }
    if (ctx.dryRun && f["output-path"])
      await req(
        ctx,
        "GET",
        "/open-apis/drive/v1/export_tasks/file/<file_token>/download",
      );
    if (ctx.dryRun) return task;
    if (!result?.file_token) return { ticket, status: "polling_timeout" };
    if (f["output-path"]) {
      let target = f["output-path"];
      try {
        if (
          (
            await stat(path.resolve(ctx.cwd ?? process.cwd(), target))
          ).isDirectory()
        )
          target = path.join(target, path.basename(result.file_name));
      } catch {}
      target = await safeFile(ctx, target, true);
      const bytes = await ctx.request(
        "GET",
        `/open-apis/drive/v1/export_tasks/file/${enc(result.file_token)}/download`,
        { responseType: "buffer" },
      );
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      return { ticket, ...result, saved_path: target };
    }
    return { ticket, ...result };
  }
  if (command === "+dim-move") {
    const sel = selector(f);
    let sid = sel.sheet_id;
    if (!sid) {
      const info = await sheetCall(
        ctx,
        token,
        "get_workbook_structure",
        { excel_id: token },
        true,
      );
      const entries = info?.sheets ?? info?.sheet_list ?? [];
      sid =
        entries.find((x) => (x.title ?? x.name) === sel.sheet_name)?.sheet_id ??
        (ctx.dryRun ? "<resolved_sheet_id>" : undefined);
      if (!sid) fail("Sheet name could not be resolved to an ID");
    }
    const range = String(f["source-range"]);
    const isRows = /^\d+:\d+$/.test(range),
      isCols = /^[A-Za-z]+:[A-Za-z]+$/.test(range);
    if (!isRows && !isCols) fail("--source-range must be a row or column span");
    const index = (s) =>
      isRows
        ? Number(s) - 1
        : Array.from(s.toUpperCase()).reduce(
            (n, c) => n * 26 + c.charCodeAt(0) - 64,
            0,
          ) - 1;
    const [a, b] = range.split(":");
    const target = index(String(f.target));
    return req(
      ctx,
      "POST",
      `/open-apis/sheets/v3/spreadsheets/${enc(token)}/sheets/${enc(sid)}/move_dimension`,
      undefined,
      {
        source: {
          major_dimension: isRows ? "ROWS" : "COLUMNS",
          start_index: index(a),
          end_index: index(b) + 1,
        },
        destination_index: target,
      },
    );
  }
  if (command === "+batch-update") {
    let raw = f.operations;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(await ctx.input(raw));
      } catch {
        fail("--operations must be valid JSON");
      }
    }
    const operations = Array.isArray(raw) ? raw : raw?.operations;
    if (!Array.isArray(operations) || !operations.length)
      fail("--operations must contain at least one operation");
    const translated = [];
    for (const [index, op] of operations.entries()) {
      if (!op?.shortcut || !op.input || typeof op.input !== "object")
        fail(`operations[${index}] requires shortcut and input`);
      if (
        !defs[op.shortcut] ||
        defs[op.shortcut].risk === "read" ||
        [
          "+batch-update",
          "+dim-move",
          "+cells-set-image",
          "+workbook-create",
          "+workbook-export",
          "+cells-batch-set-style",
          "+cells-batch-clear",
          "+dropdown-update",
          "+dropdown-delete",
        ].includes(op.shortcut)
      )
        fail(
          `operations[${index}] shortcut cannot participate in an atomic batch`,
        );
      const sub = Object.fromEntries(
        Object.entries(op.input).map(([key, value]) => [
          key.replaceAll("_", "-"),
          value,
        ]),
      );
      if (sub["spreadsheet-token"] || sub.url || has(sub, "operation"))
        fail(`operations[${index}] must not override workbook or operation`);
      const flags = applySheetDefaults(op.shortcut, sub);
      const built = await buildSheetTool(ctx, op.shortcut, flags, token, sub);
      if (!built || built.read)
        fail(`operations[${index}] has no supported write mapping`);
      validateToolInput(op.shortcut, built);
      translated.push({ tool_name: built.tool, input: built.input });
    }
    return sheetCall(
      ctx,
      token,
      "batch_update",
      clean({
        excel_id: token,
        operations: translated,
        continue_on_error: has(original, "continue-on-error")
          ? yes(f["continue-on-error"]) || undefined
          : raw.continue_on_error || undefined,
      }),
    );
  }
  if (
    [
      "+cells-batch-set-style",
      "+cells-batch-clear",
      "+dropdown-update",
      "+dropdown-delete",
    ].includes(command)
  ) {
    const ranges = await json(ctx, f.ranges, "ranges", "array");
    if (!ranges.length) fail("--ranges must not be empty");
    const operations = [];
    for (const range of ranges) {
      const match = String(range).match(/^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/);
      if (!match) fail("Every --ranges item must contain a sheet name prefix");
      const sheet = match[1]?.replaceAll("''", "'") ?? match[2];
      const cellsRange = match[3];
      const input = { excel_id: token, sheet_name: sheet, range: cellsRange };
      if (command === "+cells-batch-clear") {
        input.clear_type = f.scope === "content" ? "contents" : f.scope;
        operations.push({ tool_name: "clear_cell_range", input });
      } else {
        const cell =
          command === "+cells-batch-set-style"
            ? await style(ctx, f)
            : command === "+dropdown-delete"
              ? { data_validation: null }
              : await dropdown(ctx, f);
        input.cells = matrix(cellsRange, cell);
        operations.push({ tool_name: "set_cell_range", input });
      }
    }
    return sheetCall(ctx, token, "batch_update", {
      excel_id: token,
      operations,
    });
  }
  const tool = await buildSheetTool(ctx, command, f, token, original);
  if (!tool) return undefined;
  validateToolInput(command, tool);
  const result = await sheetCall(ctx, token, tool.tool, tool.input, tool.read);
  if (tool.uploaded && !ctx.dryRun)
    return {
      file_token: tool.uploaded.file_token,
      file_name: tool.uploaded.name,
      set_cell_range: result,
    };
  if (command === "+csv-get" && !ctx.dryRun) return csvOutput(result, f);
  return result;
}

function parseCsvRecord(text) {
  const fields = [];
  let value = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      fields.push(value);
      value = "";
    } else value += c;
  }
  if (quoted) return text.split(",");
  fields.push(value.replace(/\r?\n$/, ""));
  return fields;
}
function csvOutput(result, f) {
  if (!result || typeof result.annotated_csv !== "string") return result;
  if (!yes(f["rows-json"]))
    return yes(f["include-row-prefix"])
      ? result
      : {
          ...result,
          annotated_csv: result.annotated_csv.replace(
            /^\[row=\d+\][ ,]?/gm,
            "",
          ),
        };
  const groups = [];
  for (const line of result.annotated_csv.split("\n")) {
    const match = line.match(/^\[row=(\d+)\][ ,]?/);
    if (match)
      groups.push({
        number: Number(match[1]),
        text: line.slice(match[0].length),
      });
    else if (groups.length) groups.at(-1).text += "\n" + line;
  }
  if (!groups.length) return result;
  const parsed = groups.map((g) => parseCsvRecord(g.text));
  const max = Math.max(...parsed.map((x) => x.length));
  const start = (
    String(f.range).match(/^\$?([A-Za-z]+)/)?.[1] || "A"
  ).toUpperCase();
  const index =
    Array.from(start).reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const letters =
    result.col_indices?.length >= max
      ? result.col_indices
      : Array.from({ length: max }, (_, i) => colName(index + i));
  const output = {
    ...result,
    range: f.range,
    rows: groups.map((g, i) => ({
      row_number: g.number,
      values: Object.fromEntries(
        letters.map((column, j) => [column, parsed[i][j] ?? ""]),
      ),
    })),
  };
  const endRow = (range) =>
    Number(
      String(range ?? "")
        .split("!")
        .at(-1)
        .split(":")
        .at(-1)
        .match(/\d+$/)?.[0] || 0,
    );
  const dataEnd = endRow(result.current_region),
    readEnd = endRow(result.actual_range);
  if (dataEnd && readEnd && dataEnd > readEnd)
    output.data_not_fully_read = {
      read_through_row: readEnd,
      data_extends_through_row: dataEnd,
      unread_rows: dataEnd - readEnd,
      reread_range: result.current_region,
    };
  for (const key of [
    "annotated_csv",
    "row_indices",
    "col_indices",
    "warning_message",
  ])
    delete output[key];
  return output;
}

async function firstLegacySheet(ctx, token) {
  const data = await req(
    ctx,
    "GET",
    `/open-apis/sheets/v3/spreadsheets/${enc(token)}/sheets/query`,
  );
  const id = data.sheets?.[0]?.sheet_id;
  if (!id && !ctx.dryRun)
    throw new CliError("api", "Spreadsheet has no sheets", { code: 5 });
  return id ?? "<first_sheet_id>";
}
function legacyRange(f, values, point = false) {
  let range = f.range
    ? String(f.range).replaceAll("！", "!").replaceAll("：", ":")
    : f["sheet-id"]
      ? `${f["sheet-id"]}!A1`
      : "";
  if (range && !range.includes("!")) {
    if (!f["sheet-id"])
      fail("--sheet-id is required for a range without a sheet prefix");
    range = `${f["sheet-id"]}!${range}`;
  }
  if (values && !range.includes(":")) {
    const match = range.match(/^(.*!)([A-Za-z]+)(\d+)$/);
    if (!match) fail("Write range must be a cell or rectangle");
    const col =
      Array.from(match[2].toUpperCase()).reduce(
        (n, c) => n * 26 + c.charCodeAt(0) - 64,
        0,
      ) - 1;
    const width = Math.max(
      ...values.map((x) => (Array.isArray(x) ? x.length : 0)),
    );
    range = `${range}:${colName(col + Math.max(width, 1) - 1)}${Number(match[3]) + values.length - 1}`;
  } else if (point && /![A-Za-z]+\d+$/.test(range))
    range += ":" + range.split("!")[1];
  return range;
}
async function executeLegacySheets(ctx, command, original) {
  const f = { ...original };
  for (const flag of commandSpecs.sheets[command].flags ?? []) {
    if (flag.required && !has(f, flag.name)) fail(`--${flag.name} is required`);
    if (!has(f, flag.name) && flag.default !== undefined)
      f[flag.name] = flag.default;
    if (has(f, flag.name) && ["int", "int64", "float64"].includes(flag.type))
      f[flag.name] = Number(f[flag.name]);
  }
  if (command === "+create") {
    const rows = [
      ...(f.headers ? [await json(ctx, f.headers, "headers", "array")] : []),
      ...(f.data ? await json(ctx, f.data, "data", "array") : []),
    ];
    if (rows.some((x) => !Array.isArray(x)))
      fail("--data must be a two-dimensional array");
    const data = await req(
      ctx,
      "POST",
      "/open-apis/sheets/v3/spreadsheets",
      undefined,
      { title: required(f, "title"), ...pick(f, ["folder-token"]) },
    );
    const ss = data.spreadsheet ?? data;
    const token =
      ss.spreadsheet_token ??
      ss.token ??
      (ctx.dryRun ? "<created_spreadsheet_token>" : undefined);
    if (!token)
      throw new CliError("api", "Spreadsheet created without a token", {
        code: 5,
      });
    if (rows.length) {
      try {
        const sid = await firstLegacySheet(ctx, token);
        await req(
          ctx,
          "POST",
          `/open-apis/sheets/v2/spreadsheets/${enc(token)}/values_append`,
          undefined,
          { valueRange: { range: sid, values: rows } },
        );
      } catch (e) {
        throw new CliError(
          "partial_success",
          `Spreadsheet created but initial fill failed: ${e.message}`,
          { code: 5, detail: { spreadsheet_token: token } },
        );
      }
    }
    return {
      spreadsheet_token: token,
      title: f.title,
      url:
        ss.url ??
        (ctx.config.webBaseUrl
          ? `${ctx.config.webBaseUrl}/sheets/${enc(token)}`
          : undefined),
    };
  }
  const token = sheetToken(f);
  const v2 = `/open-apis/sheets/v2/spreadsheets/${enc(token)}`;
  const v3 = `/open-apis/sheets/v3/spreadsheets/${enc(token)}`;
  if (command === "+export") return executeSheets(ctx, "+workbook-export", f);
  if (command === "+info") {
    const spreadsheet = await req(ctx, "GET", v3);
    const sheets = await req(ctx, "GET", `${v3}/sheets/query`);
    return { spreadsheet, sheets };
  }
  if (["+read", "+write", "+append", "+write-image"].includes(command)) {
    if (!f["sheet-id"] && !String(f.range ?? "").includes("!"))
      f["sheet-id"] = await firstLegacySheet(ctx, token);
    if (command === "+read")
      return req(
        ctx,
        "GET",
        `${v2}/values/${enc(legacyRange(f, undefined, true))}`,
        clean({ valueRenderOption: f["value-render-option"] }),
      );
    if (command === "+write-image") {
      const image = ctx.dryRun
        ? "<base64_image_bytes>"
        : (await readFile(await safeFile(ctx, required(f, "image")))).toString(
            "base64",
          );
      return req(ctx, "POST", `${v2}/values_image`, undefined, {
        range: legacyRange(f, undefined, true),
        image,
        name: f.name ?? path.basename(required(f, "image")),
      });
    }
    const values = await json(ctx, f.values, "values", "array");
    if (!values.length || values.some((x) => !Array.isArray(x)))
      fail("--values must be a non-empty two-dimensional array");
    return req(
      ctx,
      command === "+write" ? "PUT" : "POST",
      `${v2}/${command === "+write" ? "values" : "values_append"}`,
      undefined,
      { valueRange: { range: legacyRange(f, values), values } },
    );
  }
  if (command === "+find" || command === "+replace") {
    const sid = required(f, "sheet-id");
    const find_condition = {
      range: f.range ? legacyRange(f, undefined, command === "+find") : sid,
      match_case:
        command === "+find" ? !yes(f["ignore-case"]) : yes(f["match-case"]),
      match_entire_cell: yes(f["match-entire-cell"]),
      search_by_regex: yes(f["search-by-regex"]),
      include_formulas: yes(f["include-formulas"]),
    };
    return req(
      ctx,
      "POST",
      `${v3}/sheets/${enc(sid)}/${command === "+find" ? "find" : "replace"}`,
      undefined,
      {
        find_condition,
        find: required(f, "find"),
        ...(command === "+replace" ? { replacement: f.replacement ?? "" } : {}),
      },
    );
  }
  if (
    [
      "+set-style",
      "+batch-set-style",
      "+merge-cells",
      "+unmerge-cells",
    ].includes(command)
  ) {
    if (command === "+batch-set-style")
      return req(ctx, "PUT", `${v2}/styles_batch_update`, undefined, {
        data: await json(ctx, f.data, "data", "array"),
      });
    const range = legacyRange({ ...f, range: required(f, "range") });
    if (command === "+set-style")
      return req(ctx, "PUT", `${v2}/style`, undefined, {
        appendStyle: { range, style: await json(ctx, f.style, "style") },
      });
    return req(
      ctx,
      "POST",
      `${v2}/${command === "+merge-cells" ? "merge_cells" : "unmerge_cells"}`,
      undefined,
      {
        range,
        ...(command === "+merge-cells"
          ? { mergeType: required(f, "merge-type") }
          : {}),
      },
    );
  }
  if (command.includes("dropdown")) {
    const op = command.slice(1).split("-")[0];
    const url = `${v2}/dataValidation`;
    if (op === "get")
      return req(ctx, "GET", url, {
        range: required(f, "range"),
        dataValidationType: "list",
      });
    if (op === "delete")
      return req(ctx, "DELETE", url, undefined, {
        dataValidationRanges: (
          await json(ctx, f.ranges, "ranges", "array")
        ).map((range) => ({ range })),
      });
    const conditionValues = await json(
      ctx,
      f["condition-values"],
      "condition-values",
      "array",
    );
    const options = {};
    if (has(f, "multiple")) options.multipleValues = yes(f.multiple);
    if (has(f, "highlight")) options.highlightValidData = yes(f.highlight);
    if (f.colors) {
      options.colors = await json(ctx, f.colors, "colors", "array");
      if (options.colors.length !== conditionValues.length)
        fail("--colors length must match --condition-values");
    }
    const dataValidation = {
      conditionValues,
      ...(Object.keys(options).length ? { options } : {}),
    };
    return req(
      ctx,
      op === "set" ? "POST" : "PUT",
      op === "set" ? url : `${url}/${enc(required(f, "sheet-id"))}`,
      undefined,
      {
        ...(op === "set"
          ? { range: required(f, "range") }
          : { ranges: await json(ctx, f.ranges, "ranges", "array") }),
        dataValidationType: "list",
        dataValidation,
      },
    );
  }
  if (command.endsWith("-dimension")) {
    const op = command.slice(1).split("-")[0];
    const sid = required(f, "sheet-id");
    const dimension = required(f, "dimension");
    if (!["ROWS", "COLUMNS"].includes(dimension))
      fail("--dimension must be ROWS or COLUMNS");
    if (op === "move")
      return req(
        ctx,
        "POST",
        `${v3}/sheets/${enc(sid)}/move_dimension`,
        undefined,
        {
          source: {
            major_dimension: dimension,
            start_index: ints(f, "start-index", 0),
            end_index: ints(f, "end-index", 0),
          },
          destination_index: ints(f, "destination-index", 0),
        },
      );
    const range = {
      sheetId: sid,
      majorDimension: dimension,
      ...(op === "add"
        ? { length: ints(f, "length", 1, 1, 5000) }
        : {
            startIndex: ints(f, "start-index", 0),
            endIndex: ints(f, "end-index", 1),
          }),
    };
    const body = { dimension: range };
    if (op === "insert" && f["inherit-style"])
      body.inheritStyle = f["inherit-style"];
    if (op === "update")
      body.dimensionProperties = clean({
        visible: has(f, "visible") ? yes(f.visible) : undefined,
        fixedSize: has(f, "fixed-size")
          ? ints(f, "fixed-size", 1, 1)
          : undefined,
      });
    return req(
      ctx,
      op === "update" ? "PUT" : op === "delete" ? "DELETE" : "POST",
      `${v2}/${op === "insert" ? "insert_dimension_range" : "dimension_range"}`,
      undefined,
      body,
    );
  }
  if (
    ["+create-sheet", "+copy-sheet", "+delete-sheet", "+update-sheet"].includes(
      command,
    )
  ) {
    const url = `${v2}/sheets_batch_update`;
    let operation;
    if (command === "+create-sheet")
      operation = {
        addSheet: {
          properties: clean({
            title: f.title,
            index: has(f, "index") ? ints(f, "index", 0) : undefined,
          }),
        },
      };
    else if (command === "+copy-sheet")
      operation = {
        copySheet: {
          source: { sheetId: required(f, "sheet-id") },
          ...(f.title ? { destination: { title: f.title } } : {}),
        },
      };
    else if (command === "+delete-sheet")
      operation = { deleteSheet: { sheetId: required(f, "sheet-id") } };
    else {
      const properties = {
        sheetId: required(f, "sheet-id"),
        ...clean({
          title: f.title,
          index: has(f, "index") ? ints(f, "index", 0) : undefined,
          hidden: has(f, "hidden") ? yes(f.hidden) : undefined,
          frozenRowCount: f["frozen-row-count"],
          frozenColCount: f["frozen-col-count"],
        }),
      };
      if (f.lock || f["lock-info"] || f["user-ids"])
        properties.protect = {
          lock: f.lock ?? "",
          ...clean({
            lockInfo: f["lock-info"],
            userIDs: f["user-ids"]
              ? await json(ctx, f["user-ids"], "user-ids", "array")
              : undefined,
          }),
        };
      operation = { updateSheet: { properties } };
    }
    const result = await req(ctx, "POST", url, pick(f, ["user-id-type"]), {
      requests: [operation],
    });
    if (command === "+copy-sheet" && has(f, "index")) {
      const sid =
        result.replies?.[0]?.copySheet?.properties?.sheetId ??
        (ctx.dryRun ? "<copied_sheet_id>" : undefined);
      if (!sid)
        throw new CliError(
          "partial_success",
          "Sheet copied but response has no copied sheet ID for movement",
          { code: 5, detail: result },
        );
      await req(ctx, "POST", url, undefined, {
        requests: [
          {
            updateSheet: {
              properties: { sheetId: sid, index: ints(f, "index", 0) },
            },
          },
        ],
      });
    }
    return result;
  }
  if (command === "+media-upload")
    return upload(ctx, required(f, "file"), token, "sheet_image");
  if (command.includes("filter-view") || command.includes("float-image")) {
    const condition = command.includes("condition");
    const floating = command.includes("float-image");
    const op = command.slice(1).split("-")[0];
    const sid = required(f, "sheet-id");
    let url = `${v3}/sheets/${enc(sid)}/${floating ? "float_images" : "filter_views"}`;
    if (condition || !["create", "list"].includes(op))
      url +=
        "/" + enc(required(f, floating ? "float-image-id" : "filter-view-id"));
    if (condition) url += "/conditions";
    if (condition && !["create", "list"].includes(op))
      url += "/" + enc(required(f, "condition-id"));
    if (op === "list") url += "/query";
    let body;
    if (op === "create" || op === "update") {
      if (condition) {
        body = pick(f, ["filter-type", "compare-type"]);
        if (op === "create") body.condition_id = required(f, "condition-id");
        if (f.expected)
          body.expected = await json(ctx, f.expected, "expected", "array");
      } else if (floating)
        body = pick(f, [
          "float-image-token",
          "range",
          "width",
          "height",
          "offset-x",
          "offset-y",
          ...(op === "create" ? ["float-image-id"] : []),
        ]);
      else
        body = pick(f, [
          "range",
          "filter-view-name",
          ...(op === "create" ? ["filter-view-id"] : []),
        ]);
    }
    return req(
      ctx,
      {
        create: "POST",
        update: condition ? "PUT" : "PATCH",
        get: "GET",
        list: "GET",
        delete: "DELETE",
      }[op],
      url,
      undefined,
      body,
    );
  }
  return undefined;
}
