import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import {
  executeManagement,
  enforcePolicy,
  readPolicy,
  completionCandidates,
} from "../src/management.mjs";
import {
  readStore,
  writeStore,
  loadConfig,
  endpoints,
} from "../src/config.mjs";
import { sessionArchiveKey } from "../src/auth.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lark-management-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    env: {
      ...process.env,
      LARK_KA_CONFIG_DIR: path.join(dir, "config"),
      HOME: dir,
    },
  };
}

test("updater check reads the customer registry without installing; update executes only its Node package", async (t) => {
  const { dir, env } = await fixture(t);
  await writeFile(
    path.join(dir, "package.json"),
    '{"name":"@customer/cli","version":"1.0.0"}',
  );
  const calls = [];
  const runCommand = async (file, args) => {
    calls.push({ file, args });
    return { stdout: args.includes("view") ? '"1.1.0"' : "installed" };
  };
  const opts = {
    env: { ...env, LARK_KA_NPM_REGISTRY: "https://registry.example.test" },
    packageRoot: dir,
    runCommand,
    npmCommand: { file: "npm-test", prefix: [] },
  };
  const check = await executeManagement(["update"], { check: true }, opts);
  assert.equal(check.data.latest, "1.1.0");
  assert.equal(check.data.updated, false);
  assert.equal(calls.length, 1);
  const updated = await executeManagement(["update"], {}, opts);
  assert.equal(updated.data.updated, true);
  assert.deepEqual(calls.at(-1).args, [
    "install",
    "--global",
    "@customer/cli@1.1.0",
    "--registry=https://registry.example.test",
  ]);
  await assert.rejects(
    executeManagement(
      ["update"],
      {},
      { ...opts, env: { ...env, LARK_KA_NPM_PACKAGE: "@larksuite/cli" } },
    ),
    /customer Node package/,
  );
});

test("unknown management commands fall through instead of returning fake success", async () => {
  assert.equal(await executeManagement(["docs", "+fetch"], {}), undefined);
});

test("OpenClaw binding selects an account, resolves environment secrets and persists a bot-only policy", async (t) => {
  const { dir, env } = await fixture(t);
  const source = path.join(dir, "openclaw.json");
  await writeFile(
    source,
    JSON.stringify({
      channels: {
        feishu: {
          domain: "feishu",
          accounts: {
            primary: { appId: "cli_one", appSecret: "${TEST_BIND_SECRET}" },
            other: { appId: "cli_two", appSecret: "second" },
          },
        },
      },
    }),
  );
  const options = {
    env: {
      ...env,
      OPENCLAW_CONFIG_PATH: source,
      TEST_BIND_SECRET: "sensitive",
    },
  };
  await assert.rejects(
    executeManagement(["config", "bind"], { source: "openclaw" }, options),
    /Multiple/,
  );
  const result = await executeManagement(
    ["config", "bind"],
    { source: "openclaw", "app-id": "cli_one" },
    options,
  );
  assert.equal(result.data.appId, "cli_one");
  assert.equal(result.data.strictMode, "bot");
  assert.ok(!JSON.stringify(result).includes("sensitive"));
  const saved = await readStore("config.json", {}, options.env);
  assert.equal(saved.apps[0].binding.source, "openclaw");
  assert.equal(saved.apps[0].appSecret, undefined);
  const credentials = await readStore("credentials.json", {}, options.env);
  assert.equal(Object.values(credentials)[0].appSecret, "sensitive");
  await assert.rejects(
    executeManagement(
      ["config", "bind"],
      { source: "openclaw", "app-id": "cli_one", identity: "user-default" },
      options,
    ),
    (e) => e.code === 10,
  );
});

test("Hermes and Lark Channel bindings use their native configuration keys", async (t) => {
  const { dir, env } = await fixture(t);
  const hermes = path.join(dir, "hermes");
  await mkdir(hermes);
  await writeFile(
    path.join(hermes, ".env"),
    'FEISHU_APP_ID=cli_hermes\nFEISHU_APP_SECRET="hermes-secret"\nFEISHU_DOMAIN=lark\n',
  );
  const h = await executeManagement(
    ["config", "bind"],
    { source: "hermes", identity: "user-default" },
    { env: { ...env, HERMES_HOME: hermes } },
  );
  assert.equal(h.data.brand, "lark");
  assert.equal(h.data.defaultAs, "user");
  const channel = path.join(dir, "channel.json");
  await writeFile(
    channel,
    JSON.stringify({
      accounts: {
        app: {
          id: "cli_channel",
          secret: { source: "env", id: "CHANNEL_SECRET" },
          tenant: "feishu",
        },
      },
    }),
  );
  const c = await executeManagement(
    ["config", "bind"],
    { source: "lark-channel" },
    {
      env: {
        ...env,
        LARK_CHANNEL_CONFIG: channel,
        CHANNEL_SECRET: "channel-secret",
      },
    },
  );
  assert.equal(c.data.appId, "cli_channel");
});

test("new-app registration performs begin and poll before storing credentials", async (t) => {
  const { dir, env } = await fixture(t);
  const deployment = path.join(dir, "deployment.json");
  await writeFile(
    deployment,
    JSON.stringify({
      brand: "cnooc",
      openBaseUrl: "https://open.example.test",
      registrationUrl: "https://accounts.example.test/register",
    }),
  );
  const calls = [];
  const notices = [];
  const fetchJSON = async (url, options) => {
    calls.push({ url: String(url), action: options.body.get("action") });
    return calls.length === 1
      ? { device_code: "device", user_code: "123", expires_in: 30 }
      : { client_id: "cli_created", client_secret: "generated-secret" };
  };
  const result = await executeManagement(
    ["config", "init"],
    { new: true, name: "newapp", deployment },
    {
      env,
      fetchJSON,
      delay: async () => {},
      emit: (value) => notices.push(value),
    },
  );
  assert.deepEqual(
    calls.map((x) => x.action),
    ["begin", "poll"],
  );
  assert.equal(result.data.appId, "cli_created");
  assert.equal(notices[0].event, "app_registration");
  assert.ok(!JSON.stringify(result).includes("generated-secret"));
  await assert.rejects(
    executeManagement(
      ["config", "init"],
      { new: true, brand: "cnooc" },
      { env },
    ),
    /registration endpoint/,
  );
});

test("hidden server bridge supports authorization and code exchange without writing local sessions", async (t) => {
  const { env } = await fixture(t);
  const config = endpoints("gjgw", {
    appId: "cli_server",
    appSecret: "server-secret",
    openBaseUrl: "https://open.private.example.invalid",
    accountsBaseUrl: "https://accounts.private.example.invalid",
    webBaseUrl: "https://web.private.example.invalid",
  });
  const authorization = await executeManagement(
    ["auth", "_server-bridge"],
    {},
    {
      env,
      config,
      stdin: JSON.stringify({
        action: "authorize",
        redirect_uri: "https://backend.example.test/callback",
        state: "x".repeat(32),
        scope: "docx:document:read",
      }),
    },
  );
  const url = new URL(authorization.authorize_url);
  assert.equal(url.origin, config.accountsBaseUrl);
  assert.equal(url.searchParams.get("client_id"), "cli_server");
  assert.equal(url.searchParams.get("response_type"), "code");
  const calls = [];
  const fetchJSON = async (url, options) => {
    calls.push({ url: String(url), options });
    return calls.length === 1
      ? { access_token: "trusted-token", expires_in: 7200 }
      : { data: { open_id: "ou_member", name: "Member" } };
  };
  const exchanged = await executeManagement(
    ["auth", "_server-bridge"],
    {},
    {
      env,
      config,
      fetchJSON,
      stdin: JSON.stringify({
        action: "exchange",
        redirect_uri: "https://backend.example.test/callback",
        code: "auth-code",
      }),
    },
  );
  assert.equal(exchanged.access_token, "trusted-token");
  assert.equal(exchanged.user.open_id, "ou_member");
  assert.equal(calls[0].url, `${config.openBaseUrl}${config.tokenPath}`);
  assert.equal(calls[1].options.headers.Authorization, "Bearer trusted-token");
  assert.deepEqual(await readStore("sessions.json", {}, env), {});
  await assert.rejects(
    executeManagement(
      ["auth", "_server-bridge"],
      {},
      {
        env,
        config,
        stdin: JSON.stringify({
          action: "authorize",
          redirect_uri: "https://example.test/cb",
          state: "short",
        }),
      },
    ),
    /32–128/,
  );
});

test("auth scopes queries enabled app scopes instead of returning only a local user grant", async (t) => {
  const { env } = await fixture(t);
  let called;
  const result = await executeManagement(
    ["auth", "scopes"],
    {},
    {
      env,
      config: {
        appId: "cli_app",
        brand: "feishu",
        openBaseUrl: "https://open.example.test",
      },
      getBotToken: async () => "bot-token",
      fetchJSON: async (url, options) => {
        called = { url, options };
        return {
          data: {
            app: {
              scopes: [
                { scope: "user:read", token_types: ["user"] },
                { scope: "bot:read", token_types: ["tenant"] },
              ],
            },
          },
        };
      },
    },
  );
  assert.deepEqual(result.userScopes, ["user:read"]);
  assert.match(String(called.url), /application\/v6\/applications\/cli_app/);
  assert.equal(called.options.headers.Authorization, "Bearer bot-token");
});

test("auth list selects only the configured application session", async (t) => {
  const { env } = await fixture(t);
  await writeStore(
    "sessions.json",
    {
      selected: {
        accessToken: "private",
        expiresAt: Date.now() + 100000,
        user: { open_id: "ou_selected", name: "Selected" },
      },
      other: { user: { open_id: "ou_other" } },
    },
    env,
  );
  const result = await executeManagement(
    ["auth", "list"],
    {},
    { env, config: { appId: "cli_selected", storageKey: "selected" } },
  );
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].userOpenId, "ou_selected");
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("auth list deduplicates archived employees and never crosses application environments", async (t) => {
  const { env } = await fixture(t);
  const sessions = {
    selected: {
      accessToken: "current-private",
      expiresAt: Date.now() + 100000,
      user: { open_id: "ou_alice", name: "Alice Current" },
    },
    [sessionArchiveKey("selected", "ou_alice")]: {
      accessToken: "stale-private",
      expiresAt: 1,
      user: { open_id: "ou_alice", name: "Alice Stale" },
      profileStorageKey: "selected",
    },
    [sessionArchiveKey("selected", "ou_bob")]: {
      accessToken: "archived-private",
      expiresAt: 1,
      refreshToken: "refresh-private",
      refreshExpiresAt: Date.now() + 100000,
      user: { open_id: "ou_bob", name: "Bob" },
      profileStorageKey: "selected",
    },
    [sessionArchiveKey("other", "ou_elsewhere")]: {
      accessToken: "other-private",
      expiresAt: Date.now() + 100000,
      user: { open_id: "ou_elsewhere", name: "Other" },
      profileStorageKey: "other",
    },
  };
  await writeStore("sessions.json", sessions, env);
  const result = await executeManagement(
    ["auth", "list"],
    {},
    { env, config: { appId: "cli_selected", storageKey: "selected" } },
  );
  assert.equal(result.data.length, 2);
  assert.equal(
    result.data.find((x) => x.userOpenId === "ou_alice").userName,
    "Alice Current",
  );
  assert.equal(
    result.data.find((x) => x.userOpenId === "ou_bob").tokenStatus,
    "needs_refresh",
  );
  assert.ok(result.data.every((x) => x.appId === "cli_selected"));
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("bundled skills support directory listing and two-argument reference reads", async (t) => {
  const { dir, env } = await fixture(t);
  const skill = path.join(dir, "skills", "lark-demo");
  await mkdir(path.join(skill, "references"), { recursive: true });
  await writeFile(
    path.join(skill, "SKILL.md"),
    "---\nname: lark-demo\ndescription: Demo skill\nmetadata:\n  version: 1.2.3\n---\n# Demo\n",
  );
  await writeFile(path.join(skill, "references", "guide.md"), "# Guide\n");
  const options = { env, packageRoot: dir };
  const list = await executeManagement(["skills", "list"], {}, options);
  assert.equal(list.skills[0].description, "Demo skill");
  const files = await executeManagement(
    ["skills", "list", "lark-demo/references"],
    {},
    options,
  );
  assert.equal(files.entries[0].name, "guide.md");
  const read = await executeManagement(
    ["skills", "read", "lark-demo", "references/guide.md"],
    {},
    options,
  );
  assert.equal(read.__raw, "# Guide\n");
  const json = await executeManagement(
    ["skills", "read", "lark-demo"],
    { json: true },
    options,
  );
  assert.equal(json.skill, "lark-demo");
  await assert.rejects(
    executeManagement(
      ["skills", "read", "lark-demo", "../package.json"],
      {},
      options,
    ),
    /inside/,
  );
});

test("policy rules enforce allow/deny, risk and actual identity with OR semantics", async (t) => {
  const { dir, env } = await fixture(t);
  await mkdir(env.LARK_KA_CONFIG_DIR, { recursive: true });
  await writeFile(
    path.join(env.LARK_KA_CONFIG_DIR, "policy.yml"),
    'rules:\n  - name: documents\n    allow: ["docs/**"]\n    max_risk: read\n    identities: [user]\n  - name: messaging\n    allow: ["im/**"]\n    deny: ["im/+messages-send"]\n    max_risk: write\n',
  );
  await enforcePolicy(["docs", "+fetch"], {}, { defaultAs: "user" }, { env });
  await assert.rejects(
    enforcePolicy(["docs", "+create"], {}, { defaultAs: "user" }, { env }),
    (e) => e.type === "command_denied",
  );
  await assert.rejects(
    enforcePolicy(["docs", "+fetch"], { as: "bot" }, {}, { env }),
    /denied/,
  );
  await assert.rejects(
    enforcePolicy(["im", "+messages-send"], {}, {}, { env }),
    /denied/,
  );
  await enforcePolicy(["config", "policy", "show"], {}, {}, { env });
  const policy = await executeManagement(
    ["config", "policy", "show"],
    {},
    { env },
  );
  assert.equal(policy.data.rules.length, 2);
  await writeFile(
    path.join(env.LARK_KA_CONFIG_DIR, "policy.yml"),
    "rules: []\n",
  );
  await assert.rejects(readPolicy(env), /non-empty/);
});

test("profile cleanup commits config then removes only unshared credentials", async (t) => {
  const { env } = await fixture(t);
  await executeManagement(
    ["profile", "add"],
    { name: "one", "app-id": "cli_one", use: true, "app-secret-stdin": true },
    { env, stdin: "one-secret" },
  );
  await executeManagement(
    ["profile", "add"],
    { name: "two", "app-id": "cli_two", use: true, "app-secret-stdin": true },
    { env, stdin: "two-secret" },
  );
  const selected = await loadConfig({ profile: "one" }, env);
  await writeStore(
    "sessions.json",
    {
      [selected.storageKey]: { user: { open_id: "ou_one" } },
      [sessionArchiveKey(selected.storageKey, "ou_one")]: {
        user: { open_id: "ou_one" },
        profileStorageKey: selected.storageKey,
      },
      [sessionArchiveKey(selected.storageKey, "ou_two")]: {
        user: { open_id: "ou_two" },
        profileStorageKey: selected.storageKey,
      },
    },
    env,
  );
  await executeManagement(["profile", "remove", "one"], {}, { env });
  assert.equal((await readStore("config.json", {}, env)).apps.length, 1);
  assert.deepEqual(await readStore("sessions.json", {}, env), {});
  await assert.rejects(
    executeManagement(["profile", "remove", "two"], {}, { env }),
    /only profile/,
  );
  await executeManagement(["config", "remove"], {}, { env });
  assert.equal((await readStore("config.json", {}, env)).apps.length, 0);
  assert.deepEqual(await readStore("credentials.json", {}, env), {});
});

test("completion walks subcommands and flags and emits shell-specific scripts", async () => {
  assert.ok(completionCandidates(["auth", "lo"]).includes("login"));
  assert.ok(completionCandidates(["docs", "+fetch", "--do"]).includes("--doc"));
  const response = await executeManagement(["__complete", "auth", "lo"], {});
  assert.match(response.__raw, /login/);
  assert.match(response.__raw, /:4\n$/);
  for (const shell of ["bash", "zsh", "fish", "powershell"])
    assert.ok(
      (await executeManagement(["completion", shell], {})).__raw.includes(
        "lark-ka",
      ),
    );
});
