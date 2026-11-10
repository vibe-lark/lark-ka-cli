import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configure, loadConfig, readStore, endpoints } from "../src/config.mjs";
import { authURL, getBotToken } from "../src/auth.mjs";

async function isolated(t) {
  const old = { ...process.env };
  const dir = await mkdtemp(path.join(os.tmpdir(), "lark-config-args-"));
  process.env.LARK_KA_CONFIG_DIR = dir;
  for (const key of [
    "LARKSUITE_CLI_APP_ID",
    "LARKSUITE_CLI_APP_SECRET",
    "LARKSUITE_CLI_BRAND",
    "LARK_KA_PROFILE",
    "LARK_KA_DEPLOYMENT",
    "LARKSUITE_CLI_TENANT_ACCESS_TOKEN",
  ])
    delete process.env[key];
  t.after(async () => {
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("refresh endpoint supports independent full URL, path, and exchange endpoint fallback", () => {
  const c = endpoints("custom", {
    openBaseUrl: "https://open.customer.example",
    tokenUrl: "https://login.customer.example/exchange",
  });
  assert.equal(
    authURL(c, "refresh"),
    "https://login.customer.example/exchange",
  );
  assert.equal(
    authURL({ ...c, refreshTokenPath: "/refresh" }, "refresh"),
    "https://open.customer.example/refresh",
  );
  assert.equal(
    authURL(
      {
        ...c,
        refreshTokenPath: "/refresh",
        refreshTokenUrl: "https://login.customer.example/refresh-v2",
      },
      "refresh",
    ),
    "https://login.customer.example/refresh-v2",
  );
});

test("tenant token requests actually use the independently configured endpoint", async (t) => {
  await isolated(t);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push({ url: req.url, body: JSON.parse(text) });
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        code: 0,
        tenant_access_token: "tenant-custom",
        expire: 7200,
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const c = endpoints("custom", {
    openBaseUrl: "https://unused.customer.example",
    tenantTokenUrl: `http://127.0.0.1:${server.address().port}/tenant-custom`,
    appId: "cli_custom",
    appSecret: "mock-secret",
    storageKey: "tenant-custom",
  });
  assert.equal(await getBotToken(c), "tenant-custom");
  assert.deepEqual(requests, [
    {
      url: "/tenant-custom",
      body: { app_id: "cli_custom", app_secret: "mock-secret" },
    },
  ]);
});

test("explicit path parameters replace a previously stored complete URL", async (t) => {
  await isolated(t);
  await configure(
    {
      name: "a",
      brand: "custom",
      "app-id": "cli_a",
      "open-base-url": "https://open.customer.example",
      "token-url": "https://login.customer.example/old-token",
    },
    async (v) => v,
  );
  await configure({ name: "a", "token-path": "/new-token" }, async (v) => v);
  const c = await loadConfig({ profile: "a" });
  assert.equal(c.tokenUrl, undefined);
  assert.equal(authURL(c, "token"), "https://open.customer.example/new-token");
});

test("stdin credential overrides a legacy secret contained in an optional deployment file", async (t) => {
  await isolated(t);
  await configure(
    { name: "a", deployment: "@mock.json", "app-secret-stdin": true },
    async (input) =>
      input === "-"
        ? "new-secret"
        : JSON.stringify({
            brand: "custom",
            appId: "cli_a",
            openBaseUrl: "https://open.customer.example",
            appSecret: "old-secret",
            appSecretEnv: "OLD_ENV",
          }),
  );
  const c = await loadConfig({ profile: "a" });
  assert.equal(c.appSecret, "new-secret");
  const store = await readStore("config.json");
  assert.equal(store.apps[0].appSecret, undefined);
  assert.equal(store.apps[0].appSecretEnv, undefined);
});
