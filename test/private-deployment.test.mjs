import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { endpoints, loadConfig } from "../src/config.mjs";
import { authURL } from "../src/auth.mjs";

const bin = fileURLToPath(new URL("../bin/lark-ka.mjs", import.meta.url));

async function isolated(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lark-private-deployment-"));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(?:LARK_KA_|LARKSUITE_CLI_)/.test(key)) delete env[key];
  env.LARK_KA_CONFIG_DIR = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, env };
}

async function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (part) => (stdout += part));
    child.stderr.on("data", (part) => (stderr += part));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("gjgw presets retain OAuth settings without supplying customer addresses", () => {
  const config = endpoints("gjgw");
  for (const key of ["openBaseUrl", "accountsBaseUrl", "webBaseUrl"])
    assert.equal(
      config[key],
      undefined,
      `${key} must be explicitly configured`,
    );
  assert.equal(
    Object.values(config).some(
      (value) => typeof value === "string" && /^https?:/.test(value),
    ),
    false,
  );
  assert.equal(config.authFlow, "authorization-code");
  assert.equal(config.authorizePath, "/open-apis/authen/v1/authorize");
  assert.equal(config.clientIdParam, "client_id");
});

test("config init rejects a gjgw profile without an OpenAPI address before saving it", async (t) => {
  const { dir, env } = await isolated(t);
  const result = await run(
    [
      "config",
      "init",
      "--name",
      "private",
      "--brand",
      "gjgw",
      "--app-id",
      "cli_private",
      "--accounts-base-url",
      "https://accounts.private.example.invalid",
      "--web-base-url",
      "https://web.private.example.invalid",
    ],
    env,
  );
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    error: {
      type: "validation",
      code: 2,
      message: "--app-id and an OpenAPI base URL are required",
    },
  });
  await assert.rejects(access(path.join(dir, "config.json")), {
    code: "ENOENT",
  });
});

test("explicit private deployment addresses survive gjgw profile creation and reload", async (t) => {
  const { dir, env } = await isolated(t);
  const addresses = {
    openBaseUrl: "https://open.private.example.invalid",
    accountsBaseUrl: "https://accounts.private.example.invalid",
    webBaseUrl: "https://web.private.example.invalid",
  };
  const result = await run(
    [
      "config",
      "init",
      "--name",
      "private",
      "--brand",
      "gjgw",
      "--app-id",
      "cli_private",
      "--open-base-url",
      addresses.openBaseUrl,
      "--accounts-base-url",
      addresses.accountsBaseUrl,
      "--web-base-url",
      addresses.webBaseUrl,
    ],
    env,
  );
  assert.equal(result.code, 0, result.stderr);
  const store = JSON.parse(
    await readFile(path.join(dir, "config.json"), "utf8"),
  );
  assert.equal(store.apps[0].brand, "gjgw");
  for (const [key, value] of Object.entries(addresses))
    assert.equal(store.apps[0][key], value);

  const loaded = await loadConfig({ profile: "private" }, env);
  for (const [key, value] of Object.entries(addresses))
    assert.equal(loaded[key], value);
  assert.equal(loaded.authFlow, "authorization-code");
  assert.equal(loaded.clientIdParam, "client_id");
  assert.equal(
    authURL(loaded, "authorize"),
    `${addresses.accountsBaseUrl}/open-apis/authen/v1/authorize`,
  );
  assert.equal(
    authURL(loaded, "token"),
    `${addresses.openBaseUrl}/open-apis/authen/v2/oauth/token`,
  );

  const shown = await run(["--profile", "private", "config", "show"], env);
  assert.equal(shown.code, 0, shown.stderr);
  const shownConfig = JSON.parse(shown.stdout).data;
  for (const [key, value] of Object.entries(addresses))
    assert.equal(shownConfig[key], value);
});
