import {
  readFile,
  writeFile,
  mkdir,
  rename,
  open,
  unlink,
  chmod,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CliError, redact } from "./errors.mjs";
import { CONFIG_PARAMETERS } from "./config-options.mjs";
export const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
export function configDir(env = process.env) {
  return path.resolve(
    env.LARK_KA_CONFIG_DIR ||
      env.LARKSUITE_CLI_CONFIG_DIR ||
      path.join(os.homedir(), ".lark-ka-cli"),
  );
}
export async function readStore(name, fallback = {}, env = process.env) {
  try {
    return JSON.parse(await readFile(path.join(configDir(env), name), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return structuredClone(fallback);
    throw new CliError(
      "config",
      `Cannot read ${name}: ${e instanceof SyntaxError ? "invalid JSON" : (e.code ?? "read error")}`,
    );
  }
}
export async function writeStore(name, value, env = process.env) {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, name),
    temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function withLock(key, action, env = process.env) {
  await mkdir(configDir(env), { recursive: true, mode: 0o700 });
  const lock = path.join(
    configDir(env),
    `${createHash("sha256").update(key).digest("hex")}.lock`,
  );
  const end = Date.now() + 30000;
  let file;
  for (;;) {
    try {
      file = await open(lock, "wx", 0o600);
      await file.writeFile(String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > end)
        throw new CliError(
          "config",
          "Timed out waiting for configuration lock",
          {
            hint: "Check that no other login or configuration command is stuck.",
          },
        );
      await delay(100);
    }
  }
  try {
    return await action();
  } finally {
    await file.close();
    await unlink(lock).catch(() => {});
  }
}
export function validURL(value, label = "URL") {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f\\]/.test(value))
    throw new CliError(
      "validation",
      `${label} must be a URL without whitespace, control characters, or backslashes`,
    );
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new CliError("validation", `${label} must be an absolute URL`);
  }
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.hash
  )
    throw new CliError(
      "validation",
      `${label} must be an HTTP(S) URL without credentials or fragment`,
    );
  if (
    u.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
  )
    throw new CliError("validation", `${label} requires HTTPS`);
  return u.pathname === "/" && !u.search ? u.origin : u.href;
}
export function endpoints(brand = "feishu", overrides = {}) {
  let defaults;
  if (brand === "feishu" || brand === "lark") {
    const suffix = brand === "lark" ? "larksuite.com" : "feishu.cn";
    defaults = {
      openBaseUrl: `https://open.${suffix}`,
      accountsBaseUrl: `https://accounts.${suffix}`,
      webBaseUrl: `https://www.${suffix}`,
      mcpUrl: `https://mcp.${suffix}/mcp`,
      docsBackend: "mcp",
      authFlow: "device",
    };
  } else if (brand === "gjgw") {
    defaults = {
      authFlow: "authorization-code",
      authorizePath: "/open-apis/authen/v1/authorize",
      clientIdParam: "client_id",
    };
  } else if (/^https?:/.test(brand))
    defaults = {
      openBaseUrl: brand,
      accountsBaseUrl: brand,
      webBaseUrl: brand,
      authFlow: "authorization-code",
    };
  else defaults = { authFlow: "authorization-code" };
  const c = {
    tokenPath: "/open-apis/authen/v2/oauth/token",
    userInfoPath: "/open-apis/authen/v1/user_info",
    authorizePath: "/open-apis/authen/v1/index",
    devicePath: "/oauth/v1/device_authorization",
    tenantTokenPath: "/open-apis/auth/v3/tenant_access_token/internal",
    clientIdParam: "app_id",
    ...defaults,
    ...overrides,
  };
  for (const key of [
    "openBaseUrl",
    "accountsBaseUrl",
    "webBaseUrl",
    "mcpUrl",
    "authorizeUrl",
    "tokenUrl",
    "refreshTokenUrl",
    "tenantTokenUrl",
    "userInfoUrl",
    "deviceUrl",
    "authServerUrl",
  ])
    if (c[key]) c[key] = validURL(c[key], key);
  for (const key of ["openBaseUrl", "accountsBaseUrl", "webBaseUrl"])
    if (c[key] && new URL(c[key]).search)
      throw new CliError(
        "validation",
        `${key} must not contain a query string`,
      );
  for (const key of [
    "tokenPath",
    "refreshTokenPath",
    "userInfoPath",
    "authorizePath",
    "devicePath",
    "tenantTokenPath",
  ]) {
    const value = c[key];
    if (value === undefined) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      throw new CliError(
        "validation",
        `${key} contains invalid percent encoding`,
      );
    }
    if (
      typeof value !== "string" ||
      !value.startsWith("/") ||
      value.startsWith("//") ||
      /[\\\u0000-\u0020#]/.test(decoded) ||
      /(?:^|\/)\.\.?(?:\/|$)/.test(decoded)
    )
      throw new CliError(
        "validation",
        `${key} must be an absolute endpoint path without traversal`,
      );
  }
  if (
    !["device", "authorization-code", "authorization_code"].includes(c.authFlow)
  )
    throw new CliError(
      "validation",
      "authFlow must be device or authorization-code",
    );
  if (
    c.docsBackend !== undefined &&
    !["native", "mcp", "docs-ai"].includes(c.docsBackend)
  )
    throw new CliError(
      "validation",
      "docsBackend must be native, mcp, or docs-ai",
    );
  if (
    c.contactSearchVersion !== undefined &&
    !["v1", "v3"].includes(c.contactSearchVersion)
  )
    throw new CliError("validation", "contactSearchVersion must be v1 or v3");
  if (c.contactSearchVersion)
    c.capabilities = {
      ...c.capabilities,
      contactSearch: c.contactSearchVersion,
    };
  if (c.redirectUri) validURL(c.redirectUri, "redirectUri");
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(c.clientIdParam))
    throw new CliError(
      "validation",
      "clientIdParam must be a valid OAuth parameter name",
    );
  if (
    c.appId !== undefined &&
    (typeof c.appId !== "string" ||
      !c.appId ||
      /\s|[\u0000-\u001f]/.test(c.appId))
  )
    throw new CliError(
      "validation",
      "appId must be a nonempty identifier without whitespace",
    );
  if (c.appSecret !== undefined && typeof c.appSecret !== "string")
    throw new CliError(
      "validation",
      "appSecret must be a string; use appSecretEnv for an environment reference",
    );
  if (
    c.appSecretEnv !== undefined &&
    (typeof c.appSecretEnv !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.appSecretEnv))
  )
    throw new CliError(
      "validation",
      "appSecretEnv must name an environment variable",
    );
  if (
    c.scope !== undefined &&
    typeof c.scope !== "string" &&
    !(Array.isArray(c.scope) && c.scope.every((s) => typeof s === "string"))
  )
    throw new CliError(
      "validation",
      "scope must be a string or an array of strings",
    );
  return c;
}
export async function loadConfig(
  flags = {},
  env = process.env,
  { optional = false } = {},
) {
  const store = await readStore("config.json", { apps: [] }, env);
  if (
    !store ||
    typeof store !== "object" ||
    !Array.isArray(store.apps) ||
    store.apps.some(
      (app) => !app || typeof app !== "object" || Array.isArray(app),
    )
  )
    throw new CliError(
      "config",
      "config.json must contain an apps array of configuration objects",
    );
  const profile = flags.profile || env.LARK_KA_PROFILE || store.currentApp;
  const app =
    store.apps?.find((a) => (a.name || a.appId) === profile) ||
    (!profile ? store.apps?.[0] : undefined);
  if (profile && !app && !env.LARKSUITE_CLI_APP_ID)
    throw new CliError("config", `Profile ${profile} does not exist`);
  let raw = { ...(app || {}) };
  if (env.LARKSUITE_CLI_APP_ID) raw.appId = env.LARKSUITE_CLI_APP_ID;
  if (env.LARKSUITE_CLI_APP_SECRET)
    raw.appSecret = env.LARKSUITE_CLI_APP_SECRET;
  if (env.LARKSUITE_CLI_BRAND) raw.brand = env.LARKSUITE_CLI_BRAND;
  if (env.LARKSUITE_CLI_DEFAULT_AS)
    raw.defaultAs = env.LARKSUITE_CLI_DEFAULT_AS;
  if (env.LARKSUITE_CLI_STRICT_MODE)
    raw.strictMode = env.LARKSUITE_CLI_STRICT_MODE;
  if (env.LARK_KA_DEPLOYMENT) {
    let deployment;
    try {
      deployment = JSON.parse(await readFile(env.LARK_KA_DEPLOYMENT, "utf8"));
    } catch {
      throw new CliError(
        "config",
        "Cannot read the configured deployment JSON file",
      );
    }
    if (
      !deployment ||
      typeof deployment !== "object" ||
      Array.isArray(deployment)
    )
      throw new CliError(
        "config",
        "Deployment configuration must be a JSON object",
      );
    raw = { ...raw, ...deployment };
  }
  const c = endpoints(raw.brand || "feishu", raw);
  const credentials = await readStore("credentials.json", {}, env);
  c.profileName = raw.name || raw.appId || "default";
  c.storageKey = createHash("sha256")
    .update(
      JSON.stringify([
        c.appId,
        c.openBaseUrl,
        c.accountsBaseUrl,
        c.tokenUrl,
        c.tokenPath,
      ]),
    )
    .digest("hex");
  if (!c.appSecret)
    c.appSecret = c.appSecretEnv
      ? Object.hasOwn(env, c.appSecretEnv)
        ? env[c.appSecretEnv]
        : undefined
      : credentials[c.storageKey]?.appSecret;
  c.defaultAs ||= "user";
  c.strictMode ||= store.strictMode || "off";
  if (c.appSecret && typeof c.appSecret !== "string")
    throw new CliError(
      "config",
      "This configuration contains a non-string credential reference",
      {
        hint: "Supply the application secret through LARKSUITE_CLI_APP_SECRET or a configured appSecretEnv.",
      },
    );
  if (!["auto", "user", "bot"].includes(c.defaultAs))
    throw new CliError("config", "defaultAs must be auto, user, or bot");
  if (!["off", "user", "bot"].includes(c.strictMode))
    throw new CliError("config", "strictMode must be off, user, or bot");
  if ((!c.appId || !c.openBaseUrl) && !optional)
    throw new CliError(
      "config",
      "Application and deployment are not configured",
      {
        hint: "Run lark-ka config init --help. Private deployments must supply their actual endpoints.",
      },
    );
  return c;
}
export function redactConfig(c) {
  const clone = redact(c);
  if (clone.storageKey) clone.storageKey = "****";
  return clone;
}
export async function configure(flags, input) {
  const name = flags.name || flags.profile || "default";
  if (!/^[a-zA-Z0-9][\w.-]{0,63}$/.test(name))
    throw new CliError(
      "validation",
      "Profile name must contain only letters, digits, _, ., or -",
    );
  let deployment = {};
  if (flags.deployment) {
    try {
      deployment = JSON.parse(
        await input(
          flags.deployment.startsWith("@")
            ? flags.deployment
            : "@" + flags.deployment,
        ),
      );
    } catch {
      throw new CliError(
        "validation",
        "Deployment file must contain valid JSON",
      );
    }
    if (
      !deployment ||
      typeof deployment !== "object" ||
      Array.isArray(deployment)
    )
      throw new CliError(
        "validation",
        "Deployment file must contain a JSON object",
      );
  }
  if (flags["app-secret-stdin"] && flags["app-secret-env"] !== undefined)
    throw new CliError(
      "validation",
      "--app-secret-stdin and --app-secret-env are mutually exclusive",
    );
  for (const flag of Object.keys(CONFIG_PARAMETERS))
    if (Array.isArray(flags[flag]) && flag !== "scope")
      throw new CliError("validation", `--${flag} must be specified once`);
  return withLock("config", async () => {
    const store = await readStore("config.json", { apps: [] });
    if (!store || !Array.isArray(store.apps))
      throw new CliError("config", "config.json must contain an apps array");
    let app = store.apps.find((a) => a.name === name);
    const next = { ...(app || {}), ...deployment, name };
    for (const [flag, spec] of Object.entries(CONFIG_PARAMETERS))
      if (flags[flag] !== undefined) next[spec.key] = flags[flag];
    if (flags["app-secret-stdin"]) {
      delete next.appSecretEnv;
      delete next.appSecret;
    }
    if (flags["app-secret-env"] !== undefined) delete next.appSecret;
    if (flags.scope !== undefined && Array.isArray(flags.scope))
      next.scope = flags.scope.join(" ");
    // An explicitly supplied path overrides a URL saved by a previous setup.
    for (const [pathFlag, urlFlag] of [
      ["authorize-path", "authorize-url"],
      ["token-path", "token-url"],
      ["refresh-token-path", "refresh-token-url"],
      ["user-info-path", "user-info-url"],
      ["device-path", "device-url"],
      ["tenant-token-path", "tenant-token-url"],
    ]) {
      if (flags[pathFlag] !== undefined && flags[urlFlag] === undefined)
        delete next[CONFIG_PARAMETERS[urlFlag].key];
    }
    const resolved = endpoints(next.brand || "feishu", next);
    if (!resolved.appId || !resolved.openBaseUrl)
      throw new CliError(
        "validation",
        "--app-id and an OpenAPI base URL are required",
      );
    const storageKey = createHash("sha256")
      .update(
        JSON.stringify([
          resolved.appId,
          resolved.openBaseUrl,
          resolved.accountsBaseUrl,
          resolved.tokenUrl,
          resolved.tokenPath,
        ]),
      )
      .digest("hex");
    if (flags["app-secret-env"] !== undefined) {
      const credentials = await readStore("credentials.json", {});
      delete credentials[storageKey];
      await writeStore("credentials.json", credentials);
    }
    if (flags["app-secret-stdin"]) {
      const secret = (await input("-")).trim();
      if (!secret)
        throw new CliError("validation", "App Secret stdin is empty");
      const credentials = await readStore("credentials.json", {});
      credentials[storageKey] = { appSecret: secret };
      await writeStore("credentials.json", credentials);
    }
    if (next.appSecret) {
      const credentials = await readStore("credentials.json", {});
      credentials[storageKey] = { appSecret: next.appSecret };
      await writeStore("credentials.json", credentials);
      delete next.appSecret;
    }
    if (app) store.apps[store.apps.indexOf(app)] = next;
    else store.apps.push(next);
    store.currentApp ||= name;
    await writeStore("config.json", store);
    return { profile: name, ...redactConfig(next) };
  });
}
