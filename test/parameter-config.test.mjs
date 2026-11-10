import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const bin = fileURLToPath(new URL("../bin/lark-ka.mjs", import.meta.url));
const cleanKeys = [
  "LARK_KA_DEPLOYMENT",
  "LARK_KA_PROFILE",
  "LARK_KA_CONFIG_DIR",
  "LARKSUITE_CLI_CONFIG_DIR",
  "LARKSUITE_CLI_APP_ID",
  "LARKSUITE_CLI_APP_SECRET",
  "LARKSUITE_CLI_BRAND",
  "LARKSUITE_CLI_DEFAULT_AS",
  "LARKSUITE_CLI_STRICT_MODE",
  "LARKSUITE_CLI_USER_ACCESS_TOKEN",
  "LARKSUITE_CLI_TENANT_ACCESS_TOKEN",
  "LARKSUITE_CLI_AUTH_PROXY",
];
async function isolated(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lark-parameter-config-"));
  const env = { ...process.env };
  for (const key of cleanKeys) delete env[key];
  env.LARK_KA_CONFIG_DIR = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, env };
}
async function run(args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (part) => (stdout += part));
    child.stderr.on("data", (part) => (stderr += part));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}
async function jsonFile(dir, file) {
  return JSON.parse(await readFile(path.join(dir, file), "utf8"));
}
async function mock(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const call = {
        path: req.url,
        method: req.method,
        headers: req.headers,
        body,
      };
      calls.push(call);
      const response = await handler(call);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(response));
    } catch (error) {
      res
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ code: 1, msg: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}
function parameters(base, suffix = "a") {
  return [
    "config",
    "init",
    "--name",
    `customer-${suffix}`,
    "--brand",
    "custom",
    "--app-id",
    `cli_customer_${suffix}`,
    "--open-base-url",
    base,
    "--accounts-base-url",
    base,
    "--web-base-url",
    `${base}/web-${suffix}`,
    "--authorize-url",
    `${base}/${suffix}/authorize`,
    "--token-url",
    `${base}/${suffix}/token`,
    "--refresh-token-url",
    `${base}/${suffix}/refresh`,
    "--device-url",
    `${base}/${suffix}/device`,
    "--tenant-token-url",
    `${base}/${suffix}/tenant`,
    "--user-info-url",
    `${base}/${suffix}/user`,
    "--mcp-url",
    `${base}/${suffix}/mcp`,
    "--client-id-param",
    "client_id",
    "--docs-backend",
    "native",
    "--auth-flow",
    "authorization-code",
    "--redirect-uri",
    "http://127.0.0.1:8989/lark/oauth/callback",
    "--scope",
    "docx:document:readonly im:message",
    "--default-as",
    "user",
    "--strict-mode",
    "off",
  ];
}
function session(user, token, extra = {}) {
  return {
    generation: `session-${user}`,
    accessToken: token,
    expiresAt: Date.now() + 7200000,
    scope: "docx:document:readonly",
    user: { open_id: user, name: user },
    ...extra,
  };
}

test("config init accepts every customer endpoint as parameters without a deployment file", async (t) => {
  const { dir, env } = await isolated(t);
  const base = "https://customer-a.example.invalid";
  const result = await run(
    [...parameters(base), "--app-secret-env", "CUSTOMER_A_SECRET"],
    { ...env, CUSTOMER_A_SECRET: "never-print-this" },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.includes("never-print-this"), false);
  assert.equal(result.stderr.includes("never-print-this"), false);
  const stored = (await jsonFile(dir, "config.json")).apps[0];
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(stored).filter(([key]) => key !== "lang"),
    ),
    {
      name: "customer-a",
      brand: "custom",
      appId: "cli_customer_a",
      openBaseUrl: base,
      accountsBaseUrl: base,
      webBaseUrl: `${base}/web-a`,
      authorizeUrl: `${base}/a/authorize`,
      tokenUrl: `${base}/a/token`,
      refreshTokenUrl: `${base}/a/refresh`,
      deviceUrl: `${base}/a/device`,
      tenantTokenUrl: `${base}/a/tenant`,
      userInfoUrl: `${base}/a/user`,
      mcpUrl: `${base}/a/mcp`,
      clientIdParam: "client_id",
      docsBackend: "native",
      authFlow: "authorization-code",
      redirectUri: "http://127.0.0.1:8989/lark/oauth/callback",
      scope: "docx:document:readonly im:message",
      defaultAs: "user",
      strictMode: "off",
      appSecretEnv: "CUSTOMER_A_SECRET",
    },
  );
  assert.equal(stored.appSecret, undefined);
  await assert.rejects(access(path.join(dir, "sessions.json")), {
    code: "ENOENT",
  });
});

test("explicit parameters override deployment values without editing the deployment file", async (t) => {
  const { dir, env } = await isolated(t);
  const file = path.join(dir, "deployment.json");
  const original = {
    brand: "custom",
    appId: "cli_old",
    openBaseUrl: "https://old.example.invalid",
    tokenUrl: "https://old.example.invalid/token",
    scope: "old:scope",
    docsBackend: "mcp",
    clientIdParam: "app_id",
    capabilities: { docsAi: false },
  };
  await writeFile(file, JSON.stringify(original));
  const result = await run(
    [...parameters("https://new.example.invalid"), "--deployment", `@${file}`],
    env,
  );
  assert.equal(result.code, 0, result.stderr);
  const stored = (await jsonFile(dir, "config.json")).apps[0];
  assert.equal(stored.appId, "cli_customer_a");
  assert.equal(stored.openBaseUrl, "https://new.example.invalid");
  assert.equal(stored.tokenUrl, "https://new.example.invalid/a/token");
  assert.equal(stored.clientIdParam, "client_id");
  assert.equal(stored.docsBackend, "native");
  assert.equal(stored.scope, "docx:document:readonly im:message");
  assert.deepEqual(stored.capabilities, { docsAi: false });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), original);
});

test("customer profiles retain independent sessions and later commands reuse saved endpoint parameters", async (t) => {
  const { dir, env } = await isolated(t);
  const { base, calls } = await mock(t, (call) => {
    if (call.path === "/a/user") {
      assert.equal(call.headers.authorization, "Bearer token-a");
      return { code: 0, data: { open_id: "ou_a", name: "Customer A" } };
    }
    if (call.path === "/b/user") {
      assert.equal(call.headers.authorization, "Bearer token-b");
      return { code: 0, data: { open_id: "ou_b", name: "Customer B" } };
    }
    throw new Error("Unexpected request");
  });
  for (const name of ["a", "b"]) {
    const init = await run(parameters(base, name), env);
    assert.equal(init.code, 0, init.stderr);
  }
  const a = await loadConfig({ profile: "customer-a" }, env);
  const b = await loadConfig({ profile: "customer-b" }, env);
  assert.notEqual(a.storageKey, b.storageKey);
  const sessions = {
    [a.storageKey]: session("ou_a", "token-a"),
    [b.storageKey]: session("ou_b", "token-b"),
  };
  await writeFile(path.join(dir, "sessions.json"), JSON.stringify(sessions));
  const repeated = await run(parameters(base, "a"), env);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.deepEqual(await jsonFile(dir, "sessions.json"), sessions);
  const statusA = await run(
    ["--profile", "customer-a", "auth", "status", "--connector"],
    env,
  );
  assert.equal(statusA.code, 0, statusA.stderr);
  assert.equal(JSON.parse(statusA.stdout).loggedIn, true);
  assert.equal(JSON.parse(statusA.stdout).user.open_id, "ou_a");
  const whoB = await run(
    ["--profile", "customer-b", "auth", "whoami", "--as", "user", "--json"],
    env,
  );
  assert.equal(whoB.code, 0, whoB.stderr);
  assert.equal(JSON.parse(whoB.stdout).user.open_id, "ou_b");
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/a/user", "/b/user"],
  );
  const changed = await run(
    [
      "config",
      "init",
      "--name",
      "customer-a",
      "--token-url",
      `${base}/a/v2/token`,
    ],
    env,
  );
  assert.equal(changed.code, 0, changed.stderr);
  const changedState = await run(
    ["--profile", "customer-a", "auth", "status"],
    env,
  );
  assert.equal(changedState.code, 0, changedState.stderr);
  assert.equal(JSON.parse(changedState.stdout).loggedIn, false);
  assert.equal(
    (await jsonFile(dir, "sessions.json"))[b.storageKey].accessToken,
    "token-b",
  );
});

test("refresh uses its saved independent URL without resupplying any deployment parameters", async (t) => {
  const { dir, env } = await isolated(t);
  const { base, calls } = await mock(t, (call) => {
    if (call.path === "/a/refresh") {
      const body = new URLSearchParams(call.body);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "old-refresh");
      return {
        access_token: "fresh-a",
        refresh_token: "new-refresh",
        expires_in: 7200,
      };
    }
    if (call.path === "/a/user") {
      assert.equal(call.headers.authorization, "Bearer fresh-a");
      return { code: 0, data: { open_id: "ou_a", name: "A" } };
    }
    throw new Error("Wrong configured endpoint");
  });
  const init = await run(
    [...parameters(base), "--app-secret-stdin"],
    env,
    "test-secret\n",
  );
  assert.equal(init.code, 0, init.stderr);
  const a = await loadConfig({ profile: "customer-a" }, env);
  await writeFile(
    path.join(dir, "sessions.json"),
    JSON.stringify({
      [a.storageKey]: session("ou_a", "expired-a", {
        expiresAt: Date.now() - 1,
        refreshToken: "old-refresh",
        refreshExpiresAt: Date.now() + 7200000,
      }),
    }),
  );
  const status = await run(
    ["--profile", "customer-a", "auth", "status", "--connector"],
    env,
  );
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).loggedIn, true);
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/a/refresh", "/a/user"],
  );
});

test("switching from an environment reference to stdin removes the stale reference and uses stored secret", async (t) => {
  const { dir, env } = await isolated(t);
  const { base, calls } = await mock(t, (call) => {
    if (call.path === "/a/tenant") {
      assert.equal(JSON.parse(call.body).app_secret, "stdin-secret");
      return { code: 0, tenant_access_token: "bot-token", expire: 7200 };
    }
    if (call.path === "/open-apis/probe") {
      assert.equal(call.headers.authorization, "Bearer bot-token");
      return { code: 0, data: { customer: "a" } };
    }
    throw new Error("Unexpected request");
  });
  const first = await run(
    [...parameters(base), "--app-secret-env", "CUSTOMER_A_SECRET"],
    { ...env, CUSTOMER_A_SECRET: "old-env-secret" },
  );
  assert.equal(first.code, 0, first.stderr);
  const second = await run(
    ["config", "init", "--name", "customer-a", "--app-secret-stdin"],
    env,
    "stdin-secret\n",
  );
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout.includes("stdin-secret"), false);
  const app = (await jsonFile(dir, "config.json")).apps[0];
  assert.equal(app.appSecretEnv, undefined);
  assert.equal(app.appSecret, undefined);
  const loaded = await loadConfig({ profile: "customer-a" }, env);
  assert.equal(
    (await jsonFile(dir, "credentials.json"))[loaded.storageKey].appSecret,
    "stdin-secret",
  );
  const request = await run(
    [
      "--profile",
      "customer-a",
      "api",
      "GET",
      "/open-apis/probe",
      "--as",
      "bot",
    ],
    env,
  );
  assert.equal(request.code, 0, request.stderr);
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/a/tenant", "/open-apis/probe"],
  );
});

test("switching to an environment reference deletes stored secret and never falls back when the variable is absent", async (t) => {
  const { dir, env } = await isolated(t);
  const base = "https://customer-a.example.invalid";
  const first = await run(
    [...parameters(base), "--app-secret-stdin"],
    env,
    "old-stored-secret",
  );
  assert.equal(first.code, 0, first.stderr);
  const loaded = await loadConfig({ profile: "customer-a" }, env);
  const second = await run(
    [
      "config",
      "init",
      "--name",
      "customer-a",
      "--app-secret-env",
      "CUSTOMER_A_SECRET",
    ],
    env,
  );
  assert.equal(second.code, 0, second.stderr);
  assert.equal(
    (await jsonFile(dir, "config.json")).apps[0].appSecretEnv,
    "CUSTOMER_A_SECRET",
  );
  assert.equal(
    (await jsonFile(dir, "credentials.json"))[loaded.storageKey],
    undefined,
  );
  assert.equal(
    (await loadConfig({ profile: "customer-a" }, env)).appSecret,
    undefined,
  );
  assert.equal(
    (
      await loadConfig(
        { profile: "customer-a" },
        { ...env, CUSTOMER_A_SECRET: "new-env-secret" },
      )
    ).appSecret,
    "new-env-secret",
  );
});

test("conflicting secret modes and invalid backend parameters fail without persisting configuration", async (t) => {
  const { dir, env } = await isolated(t);
  const args = parameters("https://customer-a.example.invalid");
  const conflicting = await run(
    [...args, "--app-secret-env", "CUSTOMER_A_SECRET", "--app-secret-stdin"],
    env,
    "secret",
  );
  assert.notEqual(conflicting.code, 0);
  assert.equal(conflicting.stdout, "");
  assert.equal(conflicting.stderr.includes('secret"'), false);
  await assert.rejects(access(path.join(dir, "config.json")), {
    code: "ENOENT",
  });
  await assert.rejects(access(path.join(dir, "credentials.json")), {
    code: "ENOENT",
  });
  const invalid = await run(
    [
      ...args.filter(
        (value, index) => value !== "native" && args[index + 1] !== "native",
      ),
      "--docs-backend",
      "unknown-backend",
    ],
    env,
  );
  assert.notEqual(invalid.code, 0);
  await assert.rejects(access(path.join(dir, "config.json")), {
    code: "ENOENT",
  });
});
