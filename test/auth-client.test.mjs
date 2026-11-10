import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  endpoints,
  readStore,
  writeStore,
  loadConfig,
  redactConfig,
} from "../src/config.mjs";
import {
  getUserToken,
  getBotToken,
  saveSession,
  authLogout,
  authStatus,
  authURL,
  profileSessions,
  sessionArchiveKey,
} from "../src/auth.mjs";
import { createContext } from "../src/context.mjs";
import { apiURL, fetchJSON } from "../src/http.mjs";

async function isolated(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lark-auth-client-"));
  process.env.LARK_KA_CONFIG_DIR = dir;
  for (const key of [
    "LARKSUITE_CLI_USER_ACCESS_TOKEN",
    "LARKSUITE_CLI_TENANT_ACCESS_TOKEN",
    "LARKSUITE_CLI_APP_ID",
    "LARKSUITE_CLI_APP_SECRET",
    "LARK_KA_DEPLOYMENT",
    "LARK_KA_PROFILE",
  ])
    delete process.env[key];
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function server(t, handler) {
  const service = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      await handler(req, res, raw);
    } catch {
      if (!res.headersSent)
        res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"code":1,"msg":"mock handler error"}');
    }
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    service.closeAllConnections();
    return new Promise((resolve) => service.close(resolve));
  });
  return `http://127.0.0.1:${service.address().port}`;
}
const respond = (res, body, status = 200) =>
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(body));
const config = (base, key = "profile") =>
  endpoints(base, {
    appId: `cli_${key}`,
    appSecret: "test-secret",
    storageKey: key,
    profileName: key,
    tokenPath: "/token",
    userInfoPath: "/user",
    tenantTokenPath: "/tenant",
    defaultAs: "user",
    strictMode: "off",
  });
async function expired(c, extra = {}) {
  const store = await readStore("sessions.json", {});
  store[c.storageKey] = {
    generation: "initial",
    accessToken: "expired-access",
    refreshToken: "refresh-old",
    expiresAt: Date.now() - 1000,
    refreshExpiresAt: Date.now() + 3600000,
    user: { open_id: "ou_old" },
    ...extra,
  };
  await writeStore("sessions.json", store);
}

test("simultaneous sessions for different profiles retain every profile", async (t) => {
  await isolated(t);
  const configs = Array.from({ length: 6 }, (_, i) =>
    config("https://api.example", `profile${i}`),
  );
  await Promise.all(
    configs.map((c, i) =>
      saveSession(
        c,
        { access_token: `access-${i}`, expires_in: 7200 },
        { open_id: `ou_${i}` },
      ),
    ),
  );
  const sessions = await readStore("sessions.json");
  assert.equal(
    Object.keys(sessions).filter((key) => !key.includes(":user:")).length,
    6,
  );
  assert.equal(
    Object.keys(sessions).filter((key) => key.includes(":user:")).length,
    6,
  );
  for (let i = 0; i < configs.length; i++)
    assert.equal(sessions[configs[i].storageKey].accessToken, `access-${i}`);
});

test("concurrent expired-token readers refresh only once", async (t) => {
  await isolated(t);
  let count = 0;
  const base = await server(t, async (req, res) => {
    count++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    respond(res, {
      access_token: "refreshed",
      refresh_token: "refresh-new",
      expires_in: 7200,
      refresh_token_expires_in: 36000,
    });
  });
  const c = config(base);
  await expired(c);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => getUserToken(c)),
  );
  assert.deepEqual(results, Array(5).fill("refreshed"));
  assert.equal(count, 1);
});

test("an in-flight refresh cannot resurrect a logged-out session", async (t) => {
  await isolated(t);
  let release, started;
  const received = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const base = await server(t, async (req, res) => {
    started();
    await gate;
    respond(res, { access_token: "stale-refresh-result", expires_in: 7200 });
  });
  const c = config(base);
  await expired(c);
  const refreshing = getUserToken(c);
  const rejection = assert.rejects(refreshing, /changed or was logged out/);
  await received;
  await authLogout(c);
  release();
  await rejection;
  assert.equal((await readStore("sessions.json"))[c.storageKey], undefined);
  assert.deepEqual(
    profileSessions(await readStore("sessions.json"), c.storageKey),
    [],
  );
});

test("an old refresh cannot overwrite a newer completed login", async (t) => {
  await isolated(t);
  let release, started;
  const received = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const base = await server(t, async (req, res) => {
    started();
    await gate;
    respond(res, { access_token: "old-refresh-result", expires_in: 7200 });
  });
  const c = config(base);
  await expired(c);
  const refreshing = getUserToken(c);
  await received;
  await saveSession(
    c,
    {
      access_token: "new-login",
      refresh_token: "new-refresh",
      expires_in: 7200,
    },
    { open_id: "ou_new" },
  );
  release();
  assert.equal(await refreshing, "new-login");
  const saved = (await readStore("sessions.json"))[c.storageKey];
  assert.equal(saved.user.open_id, "ou_new");
  assert.equal(saved.refreshToken, "new-refresh");
  const archived = (await readStore("sessions.json"))[
    sessionArchiveKey(c.storageKey, "ou_old")
  ];
  assert.equal(archived.accessToken, "expired-access");
  assert.ok(
    !JSON.stringify(await readStore("sessions.json")).includes(
      "old-refresh-result",
    ),
  );
});

test("tenant-token refresh merges profiles and deduplicates same-profile calls", async (t) => {
  await isolated(t);
  const counts = new Map();
  const base = await server(t, async (req, res, raw) => {
    const { app_id } = JSON.parse(raw);
    counts.set(app_id, (counts.get(app_id) ?? 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    respond(res, {
      code: 0,
      tenant_access_token: `tenant-${app_id}`,
      expire: 7200,
    });
  });
  const a = config(base, "a"),
    b = config(base, "b");
  const results = await Promise.all([
    getBotToken(a),
    getBotToken(a),
    getBotToken(b),
    getBotToken(b),
  ]);
  assert.deepEqual(results, [
    "tenant-cli_a",
    "tenant-cli_a",
    "tenant-cli_b",
    "tenant-cli_b",
  ]);
  assert.equal(counts.get("cli_a"), 1);
  assert.equal(counts.get("cli_b"), 1);
  assert.equal(Object.keys(await readStore("tenant-tokens.json")).length, 2);
});

test("status distinguishes an invalid grant from an unavailable backend", async (t) => {
  await isolated(t);
  let unavailable = true;
  const base = await server(t, (req, res) =>
    unavailable
      ? respond(res, { code: 1, msg: "maintenance" }, 503)
      : respond(
          res,
          {
            error: "invalid_grant",
            error_description: "Refresh is no longer valid",
          },
          400,
        ),
  );
  const c = config(base);
  await expired(c);
  await assert.rejects(
    authStatus(c),
    (e) => e.status === 503 && e.type === "api",
  );
  unavailable = false;
  const status = await authStatus(c);
  assert.equal(status.loggedIn, false);
  assert.equal(status.reason, "expired");
});

test("status recognizes Feishu invalid-token codes without confusing missing scopes", async (t) => {
  await isolated(t);
  let code = 99991668;
  const base = await server(t, (req, res) =>
    respond(res, { code, msg: "upstream diagnostic" }),
  );
  const c = config(base);
  await saveSession(
    c,
    { access_token: "access", expires_in: 7200 },
    { open_id: "ou_test" },
  );
  assert.equal((await authStatus(c, { verify: true })).loggedIn, false);
  code = 99991679;
  await assert.rejects(
    authStatus(c, { verify: true }),
    (e) => e.type === "api" && e.apiCode === 99991679,
  );
});

test("malformed token lifetimes never get persisted as a successful login", async (t) => {
  await isolated(t);
  const c = config("https://api.example");
  await assert.rejects(
    saveSession(c, { access_token: "access", expires_in: "not-a-number" }),
    /invalid expiry/,
  );
  assert.deepEqual(await readStore("sessions.json", {}), {});
});

test("new user login does not inherit a previous user refresh credential", async (t) => {
  await isolated(t);
  const c = config("https://api.example");
  await saveSession(
    c,
    { access_token: "old", refresh_token: "old-refresh", expires_in: 7200 },
    { open_id: "ou_old" },
  );
  await saveSession(
    c,
    { access_token: "new", expires_in: 7200 },
    { open_id: "ou_new" },
  );
  const saved = (await readStore("sessions.json"))[c.storageKey];
  assert.equal(saved.refreshToken, undefined);
  assert.equal(saved.user.open_id, "ou_new");
});

test("one application retains multiple employee logins while requests use the current employee", async (t) => {
  await isolated(t);
  const c = config("https://api.example");
  await saveSession(
    c,
    {
      access_token: "alice-access",
      refresh_token: "alice-refresh",
      expires_in: 7200,
      scope: "docs:read",
    },
    { open_id: "ou_alice", name: "Alice" },
  );
  await saveSession(
    c,
    { access_token: "bob-access", expires_in: 7200, scope: "calendar:read" },
    { open_id: "ou_bob", name: "Bob" },
  );
  let sessions = await readStore("sessions.json");
  assert.deepEqual(
    new Set(profileSessions(sessions, c.storageKey).map((s) => s.user.open_id)),
    new Set(["ou_alice", "ou_bob"]),
  );
  assert.equal(
    sessions[sessionArchiveKey(c.storageKey, "ou_alice")].refreshToken,
    "alice-refresh",
  );
  assert.equal(
    sessions[sessionArchiveKey(c.storageKey, "ou_bob")].refreshToken,
    undefined,
  );
  assert.equal(await getUserToken(c), "bob-access");
  await saveSession(
    c,
    { access_token: "alice-again", expires_in: 7200 },
    { open_id: "ou_alice", name: "Alice" },
  );
  sessions = await readStore("sessions.json");
  assert.equal(profileSessions(sessions, c.storageKey).length, 2);
  assert.equal(await getUserToken(c), "alice-again");
  assert.equal(
    sessions[sessionArchiveKey(c.storageKey, "ou_alice")].accessToken,
    "alice-again",
  );
});

test("concurrent logins to one profile keep every employee archive", async (t) => {
  await isolated(t);
  const c = config("https://api.example");
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      saveSession(
        c,
        { access_token: `employee-${i}`, expires_in: 7200 },
        { open_id: `ou_${i}` },
      ),
    ),
  );
  const sessions = await readStore("sessions.json");
  assert.equal(profileSessions(sessions, c.storageKey).length, 5);
  assert.ok(
    profileSessions(sessions, c.storageKey).some(
      (s) => s.accessToken === sessions[c.storageKey].accessToken,
    ),
  );
});

test("refresh updates its employee archive and logout clears all employees of only that environment", async (t) => {
  await isolated(t);
  const base = await server(t, (req, res) =>
    respond(res, {
      access_token: "alice-refreshed",
      refresh_token: "alice-rotated",
      expires_in: 7200,
    }),
  );
  const c = config(base, "shared"),
    other = config(base, "other");
  await saveSession(
    c,
    { access_token: "bob-archive", expires_in: 7200 },
    { open_id: "ou_bob" },
  );
  await saveSession(
    c,
    {
      access_token: "alice-expired",
      refresh_token: "alice-refresh",
      expires_in: 0,
      refresh_expires_in: 3600,
    },
    { open_id: "ou_alice" },
  );
  await saveSession(
    other,
    { access_token: "other-environment", expires_in: 7200 },
    { open_id: "ou_alice" },
  );
  assert.equal(await getUserToken(c), "alice-refreshed");
  const refreshed = await readStore("sessions.json");
  assert.equal(
    refreshed[sessionArchiveKey(c.storageKey, "ou_alice")].accessToken,
    "alice-refreshed",
  );
  assert.equal(
    refreshed[sessionArchiveKey(c.storageKey, "ou_bob")].accessToken,
    "bob-archive",
  );
  await authLogout(c);
  const cleared = await readStore("sessions.json");
  assert.equal(cleared[c.storageKey], undefined);
  assert.equal(profileSessions(cleared, c.storageKey).length, 0);
  assert.equal(await getUserToken(other), "other-environment");
  assert.equal(profileSessions(cleared, other.storageKey).length, 1);
});

test("auto identity does not fall back to bot on a refresh transport/API outage", async (t) => {
  await isolated(t);
  let count = 0;
  const base = await server(t, (req, res) => {
    count++;
    respond(res, { code: 1, msg: "maintenance" }, 503);
  });
  const c = { ...config(base), defaultAs: "auto" };
  await expired(c);
  await assert.rejects(
    createContext({}, { config: c }),
    (e) => e.status === 503,
  );
  assert.equal(count, 1);
});

test("dry-run auto identity never refreshes and captures only explicitly supplied flags", async (t) => {
  await isolated(t);
  const c = { ...config("https://unreachable.invalid"), defaultAs: "auto" };
  await expired(c);
  const flags = { "dry-run": true, text: "hello" };
  const ctx = await createContext(flags, { config: c });
  flags.default = "added later";
  assert.equal(ctx.identity, "user");
  assert.equal(ctx.providedFlags.has("default"), false);
  await ctx.request("POST", "/open-apis/im/v1/messages", {
    body: { text: "hello" },
  });
  assert.equal(ctx.requests.length, 1);
});

test("MCP uses dedicated identity headers only and preserves the configured endpoint", async (t) => {
  await isolated(t);
  let captured;
  const base = await server(t, (req, res) => {
    captured = req.headers;
    respond(res, { jsonrpc: "2.0", id: 1, result: { content: [] } });
  });
  const c = { ...config(base), mcpUrl: base + "/mcp" };
  await saveSession(
    c,
    { access_token: "user-mcp", expires_in: 7200 },
    { open_id: "ou_test" },
  );
  const ctx = await createContext({}, { config: c });
  await ctx.request("POST", c.mcpUrl, {
    mcp: true,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "fetch-doc" },
    },
    headers: { authorization: "Bearer attacker", "X-Lark-MCP-TAT": "attacker" },
  });
  assert.equal(captured["x-lark-mcp-uat"], "user-mcp");
  assert.equal(captured["x-lark-mcp-allowed-tools"], "fetch-doc");
  assert.equal(captured.authorization, undefined);
  assert.equal(captured["x-lark-mcp-tat"], undefined);
  await assert.rejects(
    ctx.request("POST", base + "/other", {
      mcp: true,
      body: { params: { name: "fetch-doc" } },
    }),
    /configured MCP endpoint path/,
  );
});

test("authenticated absolute requests cannot cross the API origin or use MCP without opt-in", () => {
  const c = {
    openBaseUrl: "https://api.example",
    mcpUrl: "https://mcp.example/mcp",
  };
  assert.throws(
    () => apiURL(c, "https://other.example/open-apis/test"),
    /configured API origin/,
  );
  assert.throws(
    () => apiURL(c, "https://mcp.example/mcp"),
    /configured API origin/,
  );
  assert.throws(() => apiURL(c, "https://api.example/../secret"), /traversal/);
  assert.throws(() => apiURL(c, "/%2e%2e/secret"), /traversal/);
  assert.throws(
    () => apiURL(c, "/%5c%5cother.example/secret"),
    /encoded control/,
  );
  assert.throws(() => apiURL(c, "/invalid%zz"), /percent encoding/);
});

test("explicitly empty pagination tokens survive URL serialization", () => {
  const url = apiURL({ openBaseUrl: "https://api.example" }, "/items", {
    page_token: "",
    missing: undefined,
  });
  assert.equal(url.search, "?page_token=");
});

test("SSE parser returns matching RPC data without waiting for the stream to close", async (t) => {
  const base = await server(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      ': keepalive\n\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',
    );
    res.write('data: {"jsonrpc":"2.0","id":99,"result":{"wrong":true}}\n\n');
    res.write(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"ok":true}}\n\n',
    );
    // The stream deliberately remains open.
  });
  const value = await fetchJSON(base, {
    method: "POST",
    body: { id: 1 },
    timeout: 1000,
  });
  assert.deepEqual(value.result, { ok: true });
});

test("an SSE stream with no matching result is an error, never a fake empty success", async (t) => {
  const base = await server(t, (req, res) =>
    res
      .writeHead(200, { "Content-Type": "text/event-stream" })
      .end('data: {"method":"notifications/progress"}\n\n'),
  );
  await assert.rejects(
    fetchJSON(base, { method: "POST", body: { id: 1 } }),
    /without a matching/,
  );
});

test("OAuth pending code survives a human-readable error description", async (t) => {
  const base = await server(t, (req, res) =>
    respond(
      res,
      {
        error: "authorization_pending",
        error_description: "Please finish signing in",
      },
      400,
    ),
  );
  await assert.rejects(
    fetchJSON(base),
    (e) =>
      e.oauthError === "authorization_pending" &&
      e.message === "Please finish signing in",
  );
});

test("endpoint paths cannot override the configured token origin", () => {
  assert.throws(
    () =>
      endpoints("https://api.example", {
        tokenPath: "https://evil.example/token",
      }),
    /absolute endpoint path/,
  );
  assert.throws(
    () =>
      authURL(
        {
          openBaseUrl: "https://api.example",
          tokenPath: "//evil.example/token",
        },
        "token",
      ),
    /safe absolute endpoint path/,
  );
});

test("malformed deployment/config stores return structured errors without raw secrets", async (t) => {
  const dir = await isolated(t);
  await writeFile(
    path.join(dir, "config.json"),
    '{"appSecret":"do-not-echo-this-secret" broken',
  );
  await assert.rejects(
    loadConfig(),
    (e) => e.type === "config" && !e.message.includes("do-not-echo"),
  );
  await writeStore("config.json", { apps: {} });
  await assert.rejects(
    loadConfig(),
    (e) => e.type === "config" && /apps array/.test(e.message),
  );
  assert.equal(
    redactConfig({ nested: { appSecret: "secret" } }).nested.appSecret,
    "[REDACTED]",
  );
});
