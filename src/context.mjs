import { readFile, writeFile, access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { CliError } from "./errors.mjs";
import { loadConfig, readStore } from "./config.mjs";
import { fetchJSON, apiURL } from "./http.mjs";
import { getUserToken, getBotToken } from "./auth.mjs";
import { resolveInput } from "./io.mjs";
const safeFile = (value) => {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value))
    throw new CliError("validation", "Invalid file path");
  return path.resolve(value);
};
export async function createContext(flags = {}, options = {}) {
  const introspection = !!(
    flags["dry-run"] ||
    flags["print-schema"] ||
    flags["print-output-schema"] ||
    flags["print-filter-schema"]
  );
  const config =
    options.config ||
    (await loadConfig(flags, process.env, {
      optional: introspection || !!flags.stdin,
    }));
  let identity = flags.as || config.defaultAs || "user";
  if (identity === "auto") {
    if (introspection || flags.stdin)
      identity =
        config.strictMode && config.strictMode !== "off"
          ? config.strictMode
          : "user";
    else {
      try {
        await getUserToken(config, { signal: options.signal });
        identity = "user";
      } catch (e) {
        if (e.type !== "auth") throw e;
        identity = "bot";
      }
    }
  }
  if (!["user", "bot"].includes(identity))
    throw new CliError("validation", "--as must be user or bot");
  if (
    config.strictMode &&
    config.strictMode !== "off" &&
    config.strictMode !== identity
  )
    throw new CliError(
      "permission",
      `Profile only permits ${config.strictMode} identity`,
      { code: 3 },
    );
  const requests = [];
  const session = (await readStore("sessions.json", {}))[config.storageKey];
  if (session?.user) {
    config.userOpenId = session.user.open_id;
    config.user = session.user;
  }
  const ctx = {
    config,
    identity,
    flags,
    providedFlags: new Set(Object.keys(flags)),
    requests,
    dryRun: !!flags["dry-run"],
    input: resolveInput,
    user: session?.user,
    signal: options.signal,
  };
  ctx.request = async (
    method,
    apiPath,
    {
      query = {},
      body,
      identity: as = identity,
      responseType,
      headers = {},
      timeout,
      mcp = false,
    } = {},
  ) => {
    if (!["user", "bot"].includes(as))
      throw new CliError("validation", "Request identity must be user or bot");
    if (
      typeof method !== "string" ||
      !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
        method.toUpperCase(),
      )
    )
      throw new CliError("validation", "Unsupported HTTP method");
    method = method.toUpperCase();
    if (
      config.strictMode &&
      config.strictMode !== "off" &&
      config.strictMode !== as
    )
      throw new CliError(
        "permission",
        `Profile only permits ${config.strictMode} identity`,
        { code: 3 },
      );
    if (ctx.dryRun) {
      requests.push({
        method,
        path: apiPath,
        params: query,
        data: body instanceof FormData ? { multipart: [...body.keys()] } : body,
        identity: as,
      });
      return {
        dry_run: true,
        document: { document_id: "<document_id>" },
        document_id: "<document_id>",
        file_token: "<file_token>",
        sheet_id: "<sheet_id>",
        event: { event_id: "<event_id>" },
        task: { guid: "<task_guid>" },
        items: [],
        has_more: false,
      };
    }
    const url = apiURL(config, apiPath, query, { mcp });
    if (mcp && (!body?.params?.name || typeof body.params.name !== "string"))
      throw new CliError("validation", "MCP calls require a tool name");
    const token =
      as === "bot"
        ? await getBotToken(config, { signal: ctx.signal })
        : await getUserToken(config, { signal: ctx.signal });
    let authHeaders;
    try {
      authHeaders = new Headers(headers);
    } catch {
      throw new CliError("validation", "Request headers are invalid");
    }
    for (const key of [
      "Authorization",
      "X-Lark-MCP-UAT",
      "X-Lark-MCP-TAT",
      "X-Lark-MCP-Allowed-Tools",
    ])
      authHeaders.delete(key);
    if (mcp) {
      authHeaders.set(
        as === "bot" ? "X-Lark-MCP-TAT" : "X-Lark-MCP-UAT",
        token,
      );
      authHeaders.set("X-Lark-MCP-Allowed-Tools", body.params.name);
    } else authHeaders.set("Authorization", `Bearer ${token}`);
    const result = await fetchJSON(url, {
      method,
      body,
      headers: authHeaders,
      responseType,
      signal: ctx.signal,
      timeout,
    });
    if (responseType === "buffer") return result;
    return result.data === undefined ? result : result.data;
  };
  ctx.paginate = async (method, apiPath, opts = {}) => {
    if (ctx.dryRun) return ctx.request(method, apiPath, opts);
    const query = { ...(opts.query || {}) },
      body = opts.body
        ? structuredClone(opts.body)
        : opts.pageTokenInBody
          ? {}
          : undefined,
      all = [];
    let last,
      itemsKey = opts.itemsKey;
    const seen = new Set();
    const limit = Number(flags["page-limit"] ?? 100);
    if (!Number.isInteger(limit) || limit < 0 || limit > 10000)
      throw new CliError(
        "validation",
        "--page-limit must be 0..10000 (0 means unlimited)",
      );
    for (let page = 0; limit === 0 || page < limit; page++) {
      last = await ctx.request(method, apiPath, { ...opts, query, body });
      const key =
        opts.itemsKey ||
        ["items", "records", "users", "tables", "fields", "views", "data"].find(
          (k) => Array.isArray(last[k]),
        );
      itemsKey ||= key;
      if (key) all.push(...last[key]);
      if (!(last.has_more || last.hasMore))
        return { ...last, [key || "items"]: all, has_more: false };
      const next = last.page_token || last.pageToken || last.next_page_token;
      if (!next || seen.has(next))
        throw new CliError(
          "api",
          "Pagination did not advance; refusing an infinite loop",
          { code: 5 },
        );
      seen.add(next);
      if (opts.pageTokenInBody) body.page_token = next;
      else query.page_token = next;
    }
    return {
      ...last,
      [itemsKey || "items"]: all,
      has_more: true,
      truncated: true,
    };
  };
  ctx.multipart = async (
    method,
    apiPath,
    { fields = {}, files = [], query, identity: as } = {},
  ) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields))
      form.set(key, String(value));
    for (const f of files) {
      const file = safeFile(f.path);
      await access(file);
      if (!(await stat(file)).isFile())
        throw new CliError("validation", "Upload input must be a regular file");
      const buffer = await readFile(file);
      form.set(
        f.field || "file",
        new Blob([buffer]),
        f.name || path.basename(file),
      );
    }
    return ctx.request(method, apiPath, { body: form, query, identity: as });
  };
  ctx.download = async (
    apiPath,
    { query, output, identity: as = identity } = {},
  ) => {
    if (!output)
      throw new CliError("validation", "--output is required for a download");
    const target = safeFile(output);
    if (ctx.dryRun) {
      requests.push({
        method: "GET",
        path: apiPath,
        params: query,
        output: target,
      });
      return { path: target, dry_run: true };
    }
    let data;
    if (
      /^https?:/.test(apiPath) &&
      new URL(apiPath).origin !== new URL(config.openBaseUrl).origin
    ) {
      const url = new URL(apiPath);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new CliError(
          "validation",
          "Download URL requires HTTPS without credentials",
        );
      // Pre-signed external media URLs never receive Feishu credentials.
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok)
        throw new CliError("api", `Download HTTP ${response.status}`, {
          code: 5,
        });
      data = Buffer.from(await response.arrayBuffer());
    } else
      data = await ctx.request("GET", apiPath, {
        query,
        identity: as,
        responseType: "buffer",
      });
    await writeFile(target, data, {
      flag:
        constants.O_WRONLY |
        constants.O_CREAT |
        (flags.force || flags.overwrite
          ? constants.O_TRUNC
          : constants.O_EXCL) |
        (constants.O_NOFOLLOW ?? 0),
      mode: 0o600,
    });
    return { path: target, bytes: data.length };
  };
  ctx.eventConsume = async (key, eventFlags = flags) => {
    const { consumeEvents } = await import("./events.mjs");
    return consumeEvents(ctx, key, eventFlags);
  };
  return ctx;
}
