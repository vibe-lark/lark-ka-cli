import { CliError } from "./errors.mjs";
const AUTH_CODES = new Set([99991661, 99991671, 99991668, 99991663, 99991677]);
const AUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_token",
  "expired_token",
  "access_denied",
]);

function networkError(error) {
  return new CliError(
    "network",
    `Request failed: ${error?.cause?.code || error?.name || "transport error"}`,
    { code: 4, hint: "Check the configured endpoint and network connection." },
  );
}

async function eventStreamJSON(response, wantedID) {
  if (!response.body)
    throw new CliError("api", "MCP event stream has no response body", {
      code: 5,
    });
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  const parseFrames = () => {
    let end;
    while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const separator = /^\r?\n\r?\n/.exec(buffer.slice(end))[0];
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + separator.length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data || data === "[DONE]") continue;
      let item;
      try {
        item = JSON.parse(data);
      } catch {
        throw new CliError("api", "MCP event stream contains invalid JSON", {
          code: 5,
        });
      }
      if (
        !item ||
        typeof item !== "object" ||
        (!Object.hasOwn(item, "result") && !Object.hasOwn(item, "error"))
      )
        continue;
      if (wantedID !== undefined && item.id !== wantedID) continue;
      return item;
    }
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), {
        stream: !chunk.done,
      });
      if (buffer.length > 32 * 1024 * 1024)
        throw new CliError("api", "MCP event frame exceeds 32 MiB", {
          code: 5,
        });
      if (chunk.done && buffer.trim()) buffer += "\n\n";
      const item = parseFrames();
      if (item !== undefined) return item;
      if (chunk.done) break;
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw networkError(error);
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new CliError(
    "api",
    "MCP event stream ended without a matching JSON-RPC response",
    { code: 5 },
  );
}

export async function fetchJSON(
  url,
  {
    method = "GET",
    headers = {},
    body,
    timeout = 30000,
    responseType,
    signal,
  } = {},
) {
  if (
    !Number.isInteger(Number(timeout)) ||
    Number(timeout) <= 0 ||
    Number(timeout) > 3600000
  )
    throw new CliError(
      "validation",
      "Request timeout must be an integer from 1 to 3600000 milliseconds",
    );
  timeout = Number(timeout);
  let requestHeaders;
  try {
    requestHeaders = new Headers(headers);
  } catch {
    throw new CliError("validation", "Request headers are invalid");
  }
  const init = {
    method,
    headers: requestHeaders,
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout),
  };
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    if (
      body instanceof FormData ||
      body instanceof URLSearchParams ||
      body instanceof Uint8Array ||
      typeof body === "string"
    )
      init.body = body;
    else {
      init.body = JSON.stringify(body);
      if (!requestHeaders.has("Content-Type"))
        requestHeaders.set("Content-Type", "application/json");
    }
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (e) {
    throw networkError(e);
  }
  let json;
  if (response.headers.get("content-type")?.includes("text/event-stream"))
    json = await eventStreamJSON(response, body?.id);
  else {
    let bytes;
    try {
      bytes = await response.arrayBuffer();
    } catch (e) {
      throw networkError(e);
    }
    if (responseType === "buffer" && response.ok) return Buffer.from(bytes);
    try {
      const text = Buffer.from(bytes).toString("utf8");
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new CliError(
        "api",
        `HTTP ${response.status}: response is not JSON`,
        { code: 5 },
      );
    }
  }
  if (json === null || typeof json !== "object")
    throw new CliError("api", "API response must be a JSON object", {
      code: 5,
    });
  if (
    !response.ok ||
    (json.code !== undefined && Number(json.code) !== 0) ||
    json.error
  ) {
    const raw =
      json.msg ||
      json.message ||
      json.error_description ||
      (typeof json.error === "string"
        ? json.error
        : json.error?.message || "API request failed");
    const authentication =
      response.status === 401 ||
      AUTH_CODES.has(Number(json.code)) ||
      AUTH_ERRORS.has(json.error);
    const e = new CliError(authentication ? "auth" : "api", `${raw}`, {
      code: authentication ? 3 : 5,
      detail: {
        status: response.status,
        apiCode: json.code,
        oauthError: typeof json.error === "string" ? json.error : undefined,
        logId: response.headers.get("x-tt-logid") || undefined,
      },
    });
    e.status = response.status;
    e.apiCode = json.code;
    e.oauthError = typeof json.error === "string" ? json.error : undefined;
    throw e;
  }
  return json;
}
export function apiURL(config, apiPath, query = {}, { mcp = false } = {}) {
  if (typeof apiPath !== "string" || /[\\\u0000-\u0020\u007f]/.test(apiPath))
    throw new CliError(
      "validation",
      "API path/URL contains whitespace, backslashes, or control characters",
    );
  const rawPath = /^https?:\/\//i.test(apiPath)
    ? (/^https?:\/\/[^/?#]+([^?#]*)/i.exec(apiPath)?.[1] ?? "")
    : apiPath.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new CliError(
      "validation",
      "API path contains invalid percent encoding",
    );
  }
  if (
    /[\\\u0000-\u001f]/.test(decoded) ||
    /(?:^|\/)\.\.?(?:\/|$)/.test(decoded)
  )
    throw new CliError(
      "validation",
      "API path must not contain traversal or encoded control characters",
    );
  let url;
  if (/^https?:\/\//i.test(apiPath)) {
    try {
      url = new URL(apiPath);
    } catch {
      throw new CliError("validation", "Invalid absolute API URL");
    }
  } else {
    if (!apiPath.startsWith("/") || apiPath.startsWith("//"))
      throw new CliError(
        "validation",
        "API path must be an absolute path without traversal",
      );
    url = new URL(apiPath, config.openBaseUrl);
  }
  if (url.username || url.password || url.hash)
    throw new CliError(
      "validation",
      "URL credentials and fragments are not allowed",
    );
  if (
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new CliError(
      "validation",
      "Authenticated requests require HTTPS, except for loopback testing",
    );
  const expected = mcp ? config.mcpUrl : config.openBaseUrl;
  if (!expected || url.origin !== new URL(expected).origin)
    throw new CliError(
      "validation",
      `Authenticated requests may only target the configured ${mcp ? "MCP" : "API"} origin`,
    );
  if (mcp && url.pathname !== new URL(expected).pathname)
    throw new CliError(
      "validation",
      "MCP credentials may only be sent to the configured MCP endpoint path",
    );
  for (const [key, value] of Object.entries(query || {}))
    if (value !== undefined && value !== null) {
      if (Array.isArray(value))
        for (const item of value)
          url.searchParams.append(
            key,
            typeof item === "object" ? JSON.stringify(item) : String(item),
          );
      else
        url.searchParams.set(
          key,
          typeof value === "object" ? JSON.stringify(value) : String(value),
        );
    }
  return url;
}
