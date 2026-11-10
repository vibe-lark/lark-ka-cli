import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const bin = fileURLToPath(new URL("../bin/lark-ka.mjs", import.meta.url));
async function run(argv, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...argv], {
      env: {
        ...process.env,
        LARKSUITE_CLI_APP_ID: "",
        LARKSUITE_CLI_APP_SECRET: "",
        LARKSUITE_CLI_USER_ACCESS_TOKEN: "",
        LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
async function mockServer(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const result = await handler(req, raw);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(result));
    } catch (e) {
      res
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ code: 1, msg: e.message }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
test("version/help/schema run without configuration or a Go binary", async () => {
  const env = {
    LARK_KA_CONFIG_DIR: await mkdtemp(path.join(os.tmpdir(), "lark-node-")),
  };
  const version = await run(["--version"], env);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /Node.js/);
  const help = await run(["--help"], env);
  assert.match(help.stdout, /metadata API/);
  const schema = await run(["schema", "calendar.calendars.list"], env);
  assert.equal(schema.code, 0, schema.stderr);
  assert.equal(JSON.parse(schema.stdout).ok, true);
});
test("real CLI handles config, tenant token, generic API, profile and logout", async (t) => {
  const requests = [];
  const { server, base } = await mockServer((req, raw) => {
    requests.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      raw,
    });
    if (req.url.includes("tenant_access_token"))
      return {
        code: 0,
        tenant_access_token: "tenant-test-token",
        expire: 7200,
      };
    return { code: 0, data: { items: [{ id: "one" }], has_more: false } };
  });
  t.after(() => server.close());
  const dir = await mkdtemp(path.join(os.tmpdir(), "lark-node-")),
    env = { LARK_KA_CONFIG_DIR: dir };
  const init = await run(
    [
      "config",
      "init",
      "--name",
      "test",
      "--app-id",
      "cli_test",
      "--brand",
      base,
      "--default-as",
      "bot",
      "--app-secret-stdin",
    ],
    env,
    "super-secret\n",
  );
  assert.equal(init.code, 0, init.stderr);
  assert.ok(!init.stdout.includes("super-secret"));
  assert.equal(
    (await stat(path.join(dir, "credentials.json"))).mode & 0o777,
    0o600,
  );
  const data = await run(
    ["api", "GET", "/open-apis/test/v1/items", "--params", '{"q":"a&b"}'],
    env,
  );
  assert.equal(data.code, 0, data.stderr);
  assert.equal(JSON.parse(data.stdout).data.items[0].id, "one");
  assert.equal(
    requests.at(-1).headers.authorization,
    "Bearer tenant-test-token",
  );
  assert.match(requests.at(-1).url, /q=a%26b/);
  const status = await run(["auth", "status"], env);
  assert.equal(
    JSON.parse(status.stdout).loggedIn,
    false,
    "bot availability must not mark the user as logged in",
  );
  const list = await run(["profile", "list"], env);
  assert.equal(JSON.parse(list.stdout).data.profiles[0].name, "test");
  const logout = await run(["auth", "logout"], env);
  assert.equal(logout.code, 0, logout.stderr);
  const attack = await run(
    ["api", "GET", "https://untrusted.example/open-apis/test"],
    env,
  );
  assert.notEqual(attack.code, 0);
  assert.equal(requests.length, 2, "no credentials sent to another origin");
});
test("dry-run performs no authentication or network request and preserves JSON body", async () => {
  const env = {
    LARK_KA_CONFIG_DIR: await mkdtemp(path.join(os.tmpdir(), "lark-node-")),
  };
  const result = await run(
    [
      "im",
      "+messages-send",
      "--chat-id",
      "oc_test",
      "--text",
      "hello\n中文",
      "--dry-run",
    ],
    env,
  );
  assert.equal(result.code, 0, result.stderr);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.dry_run, true);
  assert.equal(data.requests[0].method, "POST");
  assert.equal(JSON.parse(data.requests[0].data.content).text, "hello\n中文");
});
test("MCP handshake and curated schemas are pure JSON and do not need auth", async () => {
  const env = {
    LARK_KA_CONFIG_DIR: await mkdtemp(path.join(os.tmpdir(), "lark-node-")),
  };
  const frames = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "ping" },
  ];
  const result = await run(
    ["mcp", "serve"],
    env,
    frames.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  assert.equal(result.code, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(replies.length, 3);
  assert.equal(
    replies.find((x) => x.id === 1).result.protocolVersion,
    "2025-11-25",
  );
  assert.equal(replies.find((x) => x.id === 2).result.tools.length, 14);
});
test("OAuth code login validates state, exchanges code, stores session, status verifies user", async (t) => {
  let configBase;
  const { server, base } = await mockServer((req, raw) => {
    if (req.url === "/token") {
      const f = new URLSearchParams(raw);
      assert.equal(f.get("client_secret"), "secret");
      assert.equal(f.get("code"), "test-code");
      return {
        access_token: "user-token",
        refresh_token: "refresh-token",
        expires_in: 7200,
        scope: "docx:document",
      };
    }
    if (req.url === "/user") {
      assert.equal(req.headers.authorization, "Bearer user-token");
      return {
        code: 0,
        data: { open_id: "ou_test", name: "Test", union_id: "on_test" },
      };
    }
    throw new Error("Unexpected route");
  });
  t.after(() => server.close());
  const dir = await mkdtemp(path.join(os.tmpdir(), "lark-node-")),
    env = {
      ...process.env,
      LARK_KA_CONFIG_DIR: dir,
      LARKSUITE_CLI_APP_ID: "",
      LARKSUITE_CLI_APP_SECRET: "",
      LARKSUITE_CLI_USER_ACCESS_TOKEN: "",
    };
  const init = await run(
    [
      "config",
      "init",
      "--app-id",
      "cli_test",
      "--brand",
      base,
      "--authorize-url",
      base + "/authorize",
      "--token-url",
      base + "/token",
      "--user-info-url",
      base + "/user",
      "--app-secret-stdin",
    ],
    env,
    "secret",
  );
  assert.equal(init.code, 0, init.stderr);
  const login = spawn(
    process.execPath,
    [
      bin,
      "auth",
      "login",
      "--scope",
      "docx:document",
      "--callback-port",
      "0",
      "--no-open",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "",
    triggered = false;
  login.stdout.on("data", (b) => (stdout += b));
  login.stderr.on("data", async (b) => {
    stderr += b;
    if (triggered) return;
    for (const line of stderr.trim().split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.verification_url) {
          triggered = true;
          const url = new URL(event.verification_url);
          const callback = new URL(url.searchParams.get("redirect_uri"));
          callback.searchParams.set("state", "bad");
          callback.searchParams.set("code", "bad");
          assert.equal((await fetch(callback)).status, 400);
          callback.searchParams.set("state", url.searchParams.get("state"));
          callback.searchParams.set("code", "test-code");
          assert.equal((await fetch(callback)).status, 200);
        }
      } catch {}
    }
  });
  const result = await new Promise((resolve, reject) => {
    login.on("exit", (code) => resolve(code));
    login.on("error", reject);
    setTimeout(() => {
      login.kill();
      reject(new Error("OAuth test timed out: " + stderr));
    }, 8000).unref();
  });
  assert.equal(result, 0, stderr);
  assert.equal(JSON.parse(stdout).data.loggedIn, true);
  const state = await run(["auth", "status", "--connector"], env);
  assert.equal(state.code, 0, state.stderr);
  assert.equal(JSON.parse(state.stdout).loggedIn, true);
  assert.equal(JSON.parse(state.stdout).identity, "user");
  assert.ok(!state.stdout.includes("user-token"));
});
