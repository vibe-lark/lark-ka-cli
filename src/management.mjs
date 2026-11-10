import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { parseDocument } from "yaml";
import { CliError, redact } from "./errors.mjs";
import {
  configDir,
  loadConfig,
  endpoints,
  readStore,
  writeStore,
  withLock,
  PACKAGE_ROOT,
  validURL,
} from "./config.mjs";
import {
  getBotToken,
  currentUser,
  authURL,
  profileSessions,
  isProfileSessionKey,
} from "./auth.mjs";
import { fetchJSON } from "./http.mjs";
import { resolveInput } from "./io.mjs";
import { shortcuts, apiSpecs } from "./metadata.mjs";

const has = (o, k) => Object.hasOwn(o, k);
const yes = (v) => v === true || v === "true";
const ok = (data) => ({ ok: true, data });
const unbox = (r) => r.data ?? r;
const envFor = (options) => options.env ?? process.env;
const getInput = (value, options) =>
  resolveInput(value, { stdin: options.stdin ?? process.stdin });
const required = (value, name) => {
  if (value === undefined || value === "")
    throw new CliError("validation", `${name} is required`);
  return value;
};
const storageKey = (c) =>
  createHash("sha256")
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
const clean = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

async function persistProfile(app, secret, flags, options) {
  const env = envFor(options);
  const name = app.name || flags.name || flags.profile || "default";
  if (!/^[a-zA-Z0-9][\w.-]{0,63}$/.test(name))
    throw new CliError("validation", "Invalid profile name");
  const resolved = endpoints(app.brand || "feishu", app);
  const key = storageKey(resolved);
  return withLock(
    "config",
    async () => {
      const store = await readStore("config.json", { apps: [] }, env);
      const index = store.apps.findIndex((a) => (a.name || a.appId) === name);
      const saved = { ...app, name };
      delete saved.appSecret;
      if (secret) {
        const credentials = await readStore("credentials.json", {}, env);
        credentials[key] = { appSecret: secret };
        await writeStore("credentials.json", credentials, env);
      }
      if (index < 0) store.apps.push(saved);
      else store.apps[index] = saved;
      if (!store.currentApp || yes(flags.use)) {
        store.previousApp = store.currentApp;
        store.currentApp = name;
      }
      await writeStore("config.json", store, env);
      return ok({
        profile: name,
        appId: app.appId,
        brand: app.brand || "feishu",
        defaultAs: app.defaultAs,
        strictMode: app.strictMode,
        source: app.binding?.source,
      });
    },
    env,
  );
}
function expandHome(value, env) {
  return value?.startsWith("~/")
    ? path.join(env.HOME || os.homedir(), value.slice(2))
    : value;
}
async function secretValue(value, env, base) {
  if (typeof value === "string") {
    const replacement = value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_, name) => required(env[name], `Environment variable ${name}`),
    );
    if (!replacement)
      throw new CliError("config", "Source application secret is empty");
    return replacement;
  }
  if (value && typeof value === "object") {
    if (value.env || value.source === "env")
      return required(
        env[value.env || value.id],
        "Referenced secret environment variable",
      );
    if (value.file || value.source === "file") {
      const filename = expandHome(value.file || value.id, env);
      if (typeof filename !== "string" || filename.includes("\0"))
        throw new CliError("config", "Invalid secret file reference");
      return (await readFile(path.resolve(base, filename), "utf8")).trim();
    }
  }
  throw new CliError("config", "Unsupported source secret reference", {
    hint: "Use a literal, ${ENV_NAME}, env reference, or file reference.",
  });
}
async function bindConfig(flags, options) {
  const env = envFor(options);
  const source =
    flags.source ||
    (env.OPENCLAW_CONFIG_PATH || env.OPENCLAW_HOME || env.OPENCLAW_CLI
      ? "openclaw"
      : env.HERMES_HOME
        ? "hermes"
        : env.LARK_CHANNEL
          ? "lark-channel"
          : undefined);
  if (!["openclaw", "hermes", "lark-channel"].includes(source))
    throw new CliError(
      "validation",
      "Specify --source openclaw, hermes, or lark-channel",
    );
  const preset = flags.identity || "bot-only";
  if (!["bot-only", "user-default"].includes(preset))
    throw new CliError(
      "validation",
      "--identity must be bot-only or user-default",
    );
  const home = env.HOME || os.homedir();
  let filename;
  const candidates = [];
  if (source === "hermes") {
    filename = path.join(
      expandHome(env.HERMES_HOME || path.join(home, ".hermes"), env),
      ".env",
    );
    const map = {};
    for (const line of (await readFile(filename, "utf8")).split(/\r?\n/)) {
      const match = line.match(
        /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/,
      );
      if (!match) continue;
      let value = match[2];
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "");
      map[match[1]] = value;
    }
    candidates.push({
      appId: map.FEISHU_APP_ID,
      appSecret: map.FEISHU_APP_SECRET,
      brand: map.FEISHU_DOMAIN || "feishu",
    });
  } else {
    filename =
      source === "openclaw"
        ? env.OPENCLAW_CONFIG_PATH ||
          (env.OPENCLAW_STATE_DIR
            ? path.join(env.OPENCLAW_STATE_DIR, "openclaw.json")
            : path.join(
                env.OPENCLAW_HOME || home,
                ".openclaw",
                "openclaw.json",
              ))
        : env.LARK_CHANNEL_CONFIG ||
          path.join(home, ".lark-channel", "config.json");
    filename = expandHome(filename, env);
    const data = JSON.parse(await readFile(filename, "utf8"));
    if (source === "lark-channel") {
      const a = data.accounts?.app;
      if (a)
        candidates.push({
          appId: a.id,
          appSecret: a.secret,
          brand: a.tenant || "feishu",
        });
    } else {
      const channel = data.channels?.feishu;
      if (!channel || channel.enabled === false)
        throw new CliError(
          "config",
          "No enabled Feishu channel in OpenClaw configuration",
        );
      if (channel.appId)
        candidates.push({
          ...channel,
          appId: channel.appId,
          brand: channel.domain || "feishu",
        });
      for (const [label, item] of Object.entries(channel.accounts || {}))
        if (item.enabled !== false && item.appId)
          candidates.push({
            ...channel,
            ...item,
            label,
            brand: item.domain || channel.domain || "feishu",
          });
    }
  }
  const available = candidates.filter((c) => c.appId);
  const selected = flags["app-id"]
    ? available.find((c) => c.appId === flags["app-id"])
    : available.length === 1
      ? available[0]
      : undefined;
  if (!selected)
    throw new CliError(
      "config",
      available.length
        ? "Multiple source applications exist; specify --app-id"
        : "No application found in source configuration",
      { detail: { appIds: available.map((c) => c.appId) } },
    );
  const name = flags.name || flags.profile || source;
  const store = await readStore("config.json", { apps: [] }, env);
  const existing = store.apps.find((a) => (a.name || a.appId) === name);
  if (
    existing?.strictMode === "bot" &&
    preset === "user-default" &&
    !yes(flags.force)
  )
    throw new CliError(
      "confirmation_required",
      "Changing a bot-only binding to user-default requires --force",
      { code: 10 },
    );
  const secret = await secretValue(
    selected.appSecret,
    env,
    path.dirname(filename),
  );
  return persistProfile(
    {
      name,
      appId: selected.appId,
      brand: selected.brand,
      defaultAs: preset === "bot-only" ? "bot" : "user",
      strictMode: preset === "bot-only" ? "bot" : "off",
      lang: flags.lang,
      binding: { source, path: filename, appId: selected.appId },
    },
    secret,
    flags,
    options,
  );
}

async function newApp(flags, options) {
  const env = envFor(options);
  let deployment = {};
  if (flags.deployment)
    deployment = JSON.parse(
      await getInput(
        flags.deployment.startsWith("@")
          ? flags.deployment
          : "@" + flags.deployment,
        options,
      ),
    );
  const brand = flags.brand || deployment.brand || "feishu";
  const config = endpoints(brand, deployment);
  const explicit = flags["app-registration-url"] || deployment.registrationUrl;
  if (!explicit && !["feishu", "lark"].includes(brand))
    throw new CliError(
      "config",
      "Private deployment app registration endpoint is not configured",
      {
        hint: "Create an enterprise application in the customer console and pass --app-id/--app-secret-stdin, or configure registrationUrl.",
      },
    );
  const begin = validURL(
    explicit || "https://accounts.feishu.cn/oauth/v1/app/registration",
  );
  const poll = validURL(
    deployment.registrationPollUrl ||
      explicit ||
      new URL("/oauth/v1/app/registration", config.accountsBaseUrl).href,
  );
  const fetcher = options.fetchJSON ?? fetchJSON;
  const data = unbox(
    await fetcher(begin, {
      method: "POST",
      body: new URLSearchParams({
        action: "begin",
        archetype: "PersonalAgent",
        auth_method: "client_secret",
        request_user_info: "open_id tenant_brand",
      }),
      signal: options.signal,
    }),
  );
  if (!data.device_code)
    throw new CliError("api", "App registration response has no device_code", {
      code: 5,
    });
  const url =
    data.verification_uri_complete ||
    new URL(
      `/page/cli?user_code=${encodeURIComponent(data.user_code || "")}`,
      config.openBaseUrl,
    ).href;
  (
    options.emit ??
    ((value) => process.stderr.write(JSON.stringify(value) + "\n"))
  )({
    event: "app_registration",
    verification_url: url,
    expires_in: data.expires_in || 300,
  });
  const deadline = Date.now() + Number(data.expires_in || 300) * 1000;
  let interval = Math.max(1, Number(data.interval || 5));
  while (Date.now() < deadline) {
    await (options.delay ?? delay)(interval * 1000, undefined, {
      signal: options.signal,
    });
    let result;
    try {
      result = unbox(
        await fetcher(poll, {
          method: "POST",
          body: new URLSearchParams({
            action: "poll",
            device_code: data.device_code,
          }),
          signal: options.signal,
        }),
      );
    } catch (error) {
      if (/authorization_pending/.test(error.message)) continue;
      if (/slow_down/.test(error.message)) {
        interval = Math.min(60, interval + 5);
        continue;
      }
      throw error;
    }
    if (!result.client_id)
      throw new CliError("api", "App registration response has no client_id", {
        code: 5,
      });
    let secret = result.client_secret;
    const resultBrand = result.user_info?.tenant_brand || brand;
    if (!secret && resultBrand === "lark" && !explicit) {
      result = unbox(
        await fetcher(
          "https://accounts.larksuite.com/oauth/v1/app/registration",
          {
            method: "POST",
            body: new URLSearchParams({
              action: "poll",
              device_code: data.device_code,
            }),
            signal: options.signal,
          },
        ),
      );
      secret = result.client_secret;
    }
    required(secret, "Registered app client_secret");
    return persistProfile(
      {
        ...deployment,
        name: flags.name || flags.profile || "default",
        appId: result.client_id,
        brand: resultBrand,
        lang: flags.lang,
      },
      secret,
      flags,
      { ...options, env },
    );
  }
  throw new CliError("auth", "App registration timed out", { code: 3 });
}

async function serverBridge(flags, options) {
  const text = await getInput("-", options);
  if (Buffer.byteLength(text) > 16384)
    throw new CliError("validation", "Server bridge input exceeds 16 KiB");
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new CliError("validation", "Server bridge input must be JSON");
  }
  if (!["authorize", "exchange"].includes(input.action))
    throw new CliError("validation", "action must be authorize or exchange");
  let redirect;
  try {
    redirect = new URL(input.redirect_uri);
  } catch {
    throw new CliError("validation", "redirect_uri must be a valid URL");
  }
  if (
    !["http:", "https:"].includes(redirect.protocol) ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  )
    throw new CliError(
      "validation",
      "redirect_uri must be HTTP(S) without credentials, query, or fragment",
    );
  const c = options.config ?? (await loadConfig(flags, envFor(options)));
  const result = { ok: true, app_id: c.appId, brand: c.brand };
  if (input.action === "authorize") {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(input.state || ""))
      throw new CliError(
        "validation",
        "state must contain 32–128 random URL-safe characters",
      );
    const url = new URL(
      c.authorizeUrl ||
        new URL(
          c.authorizePath,
          ["feishu", "lark"].includes(c.brand)
            ? c.openBaseUrl
            : c.accountsBaseUrl || c.openBaseUrl,
        ),
    );
    url.searchParams.set(c.clientIdParam || "app_id", c.appId);
    if (c.clientIdParam === "client_id")
      url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirect.href);
    url.searchParams.set("state", input.state);
    if (input.scope) url.searchParams.set("scope", input.scope);
    result.authorize_url = url.href;
    return result;
  }
  required(input.code, "code");
  required(c.appSecret, "Server application secret");
  const fetcher = options.fetchJSON ?? fetchJSON;
  const token = unbox(
    await fetcher(authURL(c, "token"), {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        client_id: c.appId,
        client_secret: c.appSecret,
        redirect_uri: redirect.href,
      }),
      signal: options.signal,
    }),
  );
  if (!token.access_token)
    throw new CliError("auth", "Token exchange response has no access_token", {
      code: 3,
    });
  const user = unbox(
    await fetcher(authURL(c, "userInfo"), {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: options.signal,
    }),
  );
  if (!user.open_id)
    throw new CliError("auth", "User information response has no open_id", {
      code: 3,
    });
  // Hidden command for a trusted auth backend. These credentials never become an MCP tool result.
  return {
    ...result,
    user: { open_id: user.open_id, name: user.name },
    access_token: token.access_token,
    expires_in: token.expires_in,
    scope: token.scope,
  };
}

async function skillTarget(value, options, directory = false) {
  const root = path.join(options.packageRoot || PACKAGE_ROOT, "skills");
  if (
    !value ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/).includes("..") ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new CliError(
      "validation",
      "Skill paths must stay inside the bundled skills directory",
    );
  const target = path.resolve(root, value);
  const relative = path.relative(await realpath(root), await realpath(target));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new CliError("validation", "Skill symlink points outside the bundle");
  if (!(await stat(target))[directory ? "isDirectory" : "isFile"]())
    throw new CliError(
      "validation",
      directory
        ? "Skill path must be a directory"
        : "Skill path must be a file",
    );
  return target;
}
async function skillsManagement(words, flags, options) {
  const [, action = "list", ...args] = words;
  const root = path.join(options.packageRoot || PACKAGE_ROOT, "skills");
  if (action === "read") {
    if (args.length < 1 || args.length > 2)
      throw new CliError(
        "validation",
        "Usage: skills read <name>[/path] [path]",
      );
    const name = args[0].split("/")[0];
    const relative =
      args[1] || args[0].split("/").slice(1).join("/") || "SKILL.md";
    const content = await readFile(
      await skillTarget(`${name}/${relative}`, options),
      "utf8",
    );
    return yes(flags.json)
      ? { skill: name, path: relative, content }
      : { __raw: content };
  }
  if (action !== "list" || args.length > 1)
    throw new CliError("validation", "Usage: skills list [name[/path]]");
  if (args[0]) {
    const target = await skillTarget(args[0], options, true);
    const entries = (await readdir(target, { withFileTypes: true })).map(
      (entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      }),
    );
    return { ok: true, path: args[0], entries, count: entries.length };
  }
  const skills = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    let front = {};
    try {
      const content = await readFile(
        await skillTarget(`${item.name}/SKILL.md`, options),
        "utf8",
      );
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (match)
        front = parseDocument(match[1]).toJS({ maxAliasCount: 20 }) || {};
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    skills.push({
      name: front.name || item.name,
      description: front.description || "",
      ...(front.metadata?.version || front.version
        ? { version: String(front.metadata?.version || front.version) }
        : {}),
    });
  }
  return { ok: true, skills, count: skills.length };
}

const MANAGEMENT = {
  auth: [
    "login",
    "logout",
    "status",
    "whoami",
    "scopes",
    "check",
    "list",
    "qrcode",
  ],
  config: [
    "init",
    "bind",
    "show",
    "remove",
    "default-as",
    "strict-mode",
    "plugins",
    "policy",
    "keychain-downgrade",
  ],
  profile: ["add", "list", "use", "rename", "remove"],
  skills: ["list", "read"],
  event: ["list", "schema", "consume", "status", "stop"],
  mcp: ["serve"],
  completion: ["bash", "zsh", "fish", "powershell"],
  api: [],
  schema: [],
  doctor: [],
  update: [],
};
function commandTree() {
  const tree = new Map(
    Object.entries(MANAGEMENT).map(([key, value]) => [key, new Set(value)]),
  );
  for (const spec of shortcuts) {
    if (!tree.has(spec.service)) tree.set(spec.service, new Set());
    tree.get(spec.service).add(spec.command);
  }
  for (const spec of apiSpecs()) {
    if (!tree.has(spec.service)) tree.set(spec.service, new Set());
    tree.get(spec.service).add(spec.resource);
    const key = `${spec.service}/${spec.resource}`;
    if (!tree.has(key)) tree.set(key, new Set());
    tree.get(key).add(spec.name || spec.methodName || spec.method);
  }
  return tree;
}
export function completionCandidates(words) {
  const tree = commandTree();
  const parts = [...words];
  const prefix = parts.pop() || "";
  const key = parts.join("/");
  const entries = parts.length
    ? tree.get(key) || []
    : [...tree.keys()].filter((x) => !x.includes("/"));
  if (prefix.startsWith("-")) {
    const spec = shortcuts.find(
      (x) => x.service === parts[0] && x.command === parts[1],
    );
    return [
      ...new Set([
        "--help",
        "--profile",
        "--as",
        "--format",
        "--dry-run",
        "--page-all",
        "--yes",
        ...(spec?.flags || []).map((f) => `--${f.name}`),
      ]),
    ]
      .filter((x) => x.startsWith(prefix))
      .sort();
  }
  return [...entries]
    .filter((x) => typeof x === "string" && x.startsWith(prefix))
    .sort();
}
function shellCompletion(shell) {
  if (shell === "bash")
    return {
      __raw: `_lark_ka_complete() { local IFS=$'\\n'; COMPREPLY=($(lark-ka __complete "\${COMP_WORDS[@]:1}" 2>/dev/null | sed '/^:/d')); }\ncomplete -F _lark_ka_complete lark-ka lark-cli\n`,
    };
  if (shell === "zsh")
    return {
      __raw: `#compdef lark-ka lark-cli\n_lark_ka_complete() { local -a candidates; candidates=(\"\${(@f)$(lark-ka __complete \"\${words[@]:1}\" 2>/dev/null)}\"); compadd -- \${candidates:#:*}; }\ncompdef _lark_ka_complete lark-ka lark-cli\n`,
    };
  if (shell === "fish")
    return {
      __raw: `function __lark_ka_complete\n set -l words (commandline -opc)\n lark-ka __complete $words[2..-1] (commandline -ct) 2>/dev/null | string match -rv '^:'\nend\ncomplete -c lark-ka -f -a '(__lark_ka_complete)'\ncomplete -c lark-cli -f -a '(__lark_ka_complete)'\n`,
    };
  if (shell === "powershell")
    return {
      __raw: `Register-ArgumentCompleter -Native -CommandName lark-ka,lark-cli -ScriptBlock { param($wordToComplete,$commandAst,$cursorPosition) $parts=@($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text }); if (-not $wordToComplete) {$parts += ''}; lark-ka __complete @parts | Where-Object { $_ -notmatch '^:' } }\n`,
    };
  throw new CliError(
    "validation",
    "Unsupported shell; use bash, zsh, fish, or powershell",
  );
}

function globRegex(pattern) {
  if (
    typeof pattern !== "string" ||
    pattern.length > 1000 ||
    /[\u0000-\u001f]/.test(pattern)
  )
    throw new CliError("config", "Invalid policy glob");
  let result = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        result += "(?:.*/)?";
      } else result += ".*";
    } else if (c === "*") result += "[^/]*";
    else if (c === "?") result += "[^/]";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0)
        throw new CliError("config", "Unclosed character class in policy glob");
      const body = pattern.slice(i + 1, end);
      result += "[" + (body.startsWith("!") ? "^" + body.slice(1) : body) + "]";
      i = end;
    } else result += c.replace(/[\\^$+?.()|{}]/g, "\\$&");
  }
  try {
    return new RegExp(result + "$");
  } catch {
    throw new CliError("config", "Invalid policy glob");
  }
}
export async function readPolicy(env = process.env) {
  const filename =
    env.LARK_KA_POLICY || path.join(configDir(env), "policy.yml");
  let text;
  try {
    text = await readFile(filename, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { source: "none", rules: [] };
    throw e;
  }
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new CliError("config", "Policy file exceeds 1 MiB");
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length)
    throw new CliError(
      "config",
      `Invalid policy YAML: ${document.errors[0].message}`,
    );
  const parsed = document.toJS({ maxAliasCount: 20 }) || {};
  const fields = new Set([
    "name",
    "description",
    "allow",
    "deny",
    "max_risk",
    "identities",
    "allow_unannotated",
  ]);
  if (Object.keys(parsed).some((k) => !fields.has(k) && k !== "rules"))
    throw new CliError("config", "Unknown field in policy YAML");
  if (parsed.rules && Object.keys(parsed).some((k) => k !== "rules"))
    throw new CliError(
      "config",
      "Policy cannot mix flat rule fields with rules list",
    );
  const rules = has(parsed, "rules") ? parsed.rules : [parsed];
  if (!Array.isArray(rules) || !rules.length)
    throw new CliError("config", "Policy rules must be a non-empty list");
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule !== "object" ||
      Object.keys(rule).some((k) => !fields.has(k))
    )
      throw new CliError("config", "Invalid policy rule");
    if (
      rule.max_risk &&
      !["read", "write", "high-risk-write"].includes(rule.max_risk)
    )
      throw new CliError("config", "Invalid policy max_risk");
    for (const key of ["allow", "deny", "identities"])
      if (
        rule[key] !== undefined &&
        (!Array.isArray(rule[key]) ||
          rule[key].some((x) => typeof x !== "string"))
      )
        throw new CliError("config", `Policy ${key} must be a string array`);
    if (rule.identities?.some((x) => !["user", "bot"].includes(x)))
      throw new CliError("config", "Policy identities must be user or bot");
    if (
      rule.allow_unannotated !== undefined &&
      typeof rule.allow_unannotated !== "boolean"
    )
      throw new CliError("config", "Policy allow_unannotated must be boolean");
    for (const glob of [...(rule.allow || []), ...(rule.deny || [])])
      globRegex(glob);
  }
  return { source: "yaml", path: filename, rules };
}
export async function enforcePolicy(
  words,
  flags = {},
  config = {},
  options = {},
) {
  if (
    yes(flags.help) ||
    ["__complete", "__completeNoDesc", "completion"].includes(words[0])
  )
    return;
  const rawKey = words.join("/");
  if (["config/policy/show", "config/plugins/show"].includes(rawKey)) return;
  const policy = await readPolicy(options.env || process.env);
  if (!policy.rules.length) return;
  const shortcut = shortcuts.find(
    (s) => s.service === words[0] && s.command === words[1],
  );
  const api = apiSpecs().find(
    (s) =>
      s.service === words[0] &&
      s.resource === words[1] &&
      (s.name || s.methodName || s.method) === words[2],
  );
  const key =
    words[0] === "api"
      ? "api"
      : shortcut
        ? `${words[0]}/${words[1]}`
        : api
          ? `${api.service}/${api.resource.replaceAll(".", "/")}/${api.method}`
          : words.slice(0, 2).join("/");
  const managementRisk =
    words[0] === "auth"
      ? ["login", "logout"].includes(words[1])
        ? "write"
        : "read"
      : ["config", "profile"].includes(words[0])
        ? ["show", "list"].includes(words[1])
          ? "read"
          : "write"
        : ["doctor", "schema", "skills", "skill"].includes(words[0])
          ? "read"
          : words[0] === "update"
            ? "write"
            : undefined;
  const apiRisk = api
    ? ["GET", "HEAD"].includes(api.httpMethod)
      ? "read"
      : api.httpMethod === "DELETE"
        ? "high-risk-write"
        : "write"
    : undefined;
  const risk =
    shortcut?.risk ||
    api?.risk ||
    apiRisk ||
    (words[0] === "api"
      ? ["GET", "HEAD"].includes(String(words[1]).toUpperCase())
        ? "read"
        : "high-risk-write"
      : managementRisk);
  const rank = { read: 0, write: 1, "high-risk-write": 2 };
  const identity = flags.as || config.defaultAs || "user";
  const reasons = [];
  if (risk && rank[risk] === undefined)
    throw new CliError(
      "command_denied",
      "Command has an invalid risk annotation",
      { code: 3, detail: { layer: "policy", reason_code: "risk_invalid" } },
    );
  for (const rule of policy.rules) {
    const rejected = rule.deny?.some((x) => globRegex(x).test(key))
      ? "command_denylisted"
      : rule.allow?.length && !rule.allow.some((x) => globRegex(x).test(key))
        ? "domain_not_allowed"
        : !risk && !rule.allow_unannotated
          ? "risk_not_annotated"
          : rule.max_risk && rank[risk] > rank[rule.max_risk]
            ? "write_not_allowed"
            : rule.identities?.length && !rule.identities.includes(identity)
              ? "identity_mismatch"
              : undefined;
    if (!rejected) return;
    reasons.push(rejected);
  }
  throw new CliError(
    "command_denied",
    `Command ${words.join(" ")} is denied by policy`,
    {
      code: 3,
      detail: {
        layer: "policy",
        reason_code: reasons.length === 1 ? reasons[0] : "no_matching_rule",
        reasons,
      },
    },
  );
}

async function updatePackage(flags, options) {
  const root = options.packageRoot || PACKAGE_ROOT;
  const pkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const env = envFor(options);
  const name = env.LARK_KA_NPM_PACKAGE || pkg.name;
  if (
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) ||
    name === "@larksuite/cli"
  )
    throw new CliError(
      "config",
      "Updater must target this customer Node package",
    );
  const registry = env.LARK_KA_NPM_REGISTRY || env.npm_config_registry;
  if (registry) {
    const url = new URL(validURL(registry));
    if (url.search)
      throw new CliError(
        "config",
        "Npm registry URL must not contain query credentials",
      );
  }
  const registryArgs = registry ? [`--registry=${registry}`] : [];
  const command =
    options.npmCommand ||
    (env.npm_execpath?.endsWith(".js")
      ? { file: process.execPath, prefix: [env.npm_execpath] }
      : process.platform === "win32"
        ? {
            file: process.execPath,
            prefix: [
              path.join(
                path.dirname(process.execPath),
                "node_modules",
                "npm",
                "bin",
                "npm-cli.js",
              ),
            ],
          }
        : { file: "npm", prefix: [] });
  const runner = options.runCommand || promisify(execFile);
  const result = await runner(
    command.file,
    [...command.prefix, "view", name, "version", "--json", ...registryArgs],
    { timeout: 30000, maxBuffer: 1024 * 1024, env, signal: options.signal },
  );
  let latest;
  try {
    latest = JSON.parse(result.stdout).trim();
  } catch {
    throw new CliError(
      "network",
      "Npm registry returned an invalid version response",
      { code: 4 },
    );
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(latest))
    throw new CliError(
      "network",
      "Npm registry returned an invalid semantic version",
      { code: 4 },
    );
  const output = {
    current: pkg.version,
    latest,
    package: name,
    updateAvailable: compareVersions(latest, pkg.version) > 0,
  };
  if (yes(flags.check) || (!yes(flags.force) && !output.updateAvailable))
    return ok({ ...output, updated: false });
  const installed = await runner(
    command.file,
    [
      ...command.prefix,
      "install",
      "--global",
      `${name}@${latest}`,
      ...registryArgs,
    ],
    {
      timeout: 600000,
      maxBuffer: 4 * 1024 * 1024,
      env,
      signal: options.signal,
    },
  );
  return ok({
    ...output,
    updated: true,
    output: redact(installed.stdout || "").trim(),
  });
}

function compareVersions(a, b) {
  const parse = (v) => {
    const match = String(v).match(/^(\d+\.\d+\.\d+)(?:-([^+]+))?/);
    return { core: match[1].split(".").map(Number), pre: match[2]?.split(".") };
  };
  const left = parse(a),
    right = parse(b);
  for (let i = 0; i < 3; i++)
    if (left.core[i] !== right.core[i])
      return left.core[i] > right.core[i] ? 1 : -1;
  if (!left.pre || !right.pre) return left.pre ? -1 : right.pre ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i],
      y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export async function cleanupProfile(
  name,
  { all = false, env = process.env } = {},
) {
  return withLock(
    "config",
    async () => {
      const store = await readStore("config.json", { apps: [] }, env);
      const selected = all
        ? store.apps
        : store.apps.filter((a) => (a.name || a.appId) === name);
      if (!selected.length) throw new CliError("config", "Profile not found");
      if (!all && store.apps.length === 1)
        throw new CliError(
          "validation",
          "Cannot remove the only profile; use config remove to clear all configuration",
        );
      const keys = new Set(
        selected.map((a) => storageKey(endpoints(a.brand, a))),
      );
      const remaining = all
        ? []
        : store.apps.filter((a) => !selected.includes(a));
      const retainedKeys = new Set(
        remaining.map((a) => storageKey(endpoints(a.brand, a))),
      );
      store.apps = remaining;
      if (
        all ||
        !remaining.some((a) => (a.name || a.appId) === store.currentApp)
      )
        store.currentApp = remaining[0]?.name || remaining[0]?.appId;
      if (!remaining.some((a) => (a.name || a.appId) === store.previousApp))
        delete store.previousApp;
      await writeStore("config.json", store, env);
      for (const filename of [
        "credentials.json",
        "sessions.json",
        "tenant-tokens.json",
      ]) {
        const remove = async () => {
          const values = await readStore(filename, {}, env);
          for (const key of keys)
            if (!retainedKeys.has(key)) {
              if (filename === "sessions.json") {
                for (const item of Object.keys(values))
                  if (isProfileSessionKey(item, key)) delete values[item];
              } else delete values[key];
            }
          await writeStore(filename, values, env);
        };
        if (filename === "sessions.json")
          await withLock("sessions-write", remove, env);
        else if (filename === "tenant-tokens.json")
          await withLock("tenant-tokens-write", remove, env);
        else await remove();
      }
      return ok({
        removed: selected.map((a) => a.name || a.appId),
        current: store.currentApp,
      });
    },
    env,
  );
}

export async function executeManagement(words, flags = {}, options = {}) {
  const [service, command, ...args] = words;
  const env = envFor(options);
  if (service === "update") return updatePackage(flags, options);
  if (service === "completion") return shellCompletion(command || "bash");
  if (service === "__complete" || service === "__completeNoDesc")
    return {
      __raw: completionCandidates(words.slice(1)).join("\n") + "\n:4\n",
    };
  if (service === "skills" || service === "skill")
    return skillsManagement(words, flags, options);
  if (service === "config" && command === "bind")
    return bindConfig(flags, options);
  if (
    service === "config" &&
    command === "init" &&
    yes(flags.new) &&
    !flags["app-id"]
  )
    return newApp(flags, options);
  if (service === "config" && command === "remove")
    return cleanupProfile(undefined, { all: true, env });
  if (service === "profile" && command === "remove")
    return cleanupProfile(required(args[0] || flags.name, "Profile name"), {
      env,
    });
  if (service === "config" && command === "policy" && args[0] === "show")
    return ok(await readPolicy(env));
  if (service === "config" && command === "plugins" && args[0] === "show")
    return ok({
      plugins: [],
      total: 0,
      implementation: "nodejs",
      note: "Go in-process plugins cannot be loaded by the Node.js implementation.",
    });
  if (service === "auth" && command === "_server-bridge")
    return serverBridge(flags, options);
  if (service === "auth" && command === "scopes") {
    const c = options.config ?? (await loadConfig(flags, env));
    const token = await (options.getBotToken ?? getBotToken)(c);
    const data = unbox(
      await (options.fetchJSON ?? fetchJSON)(
        new URL(
          `/open-apis/application/v6/applications/${encodeURIComponent(c.appId)}?lang=zh_cn`,
          c.openBaseUrl,
        ),
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: options.signal,
        },
      ),
    );
    const app = data.app ?? data;
    const userScopes = [
      ...new Set(
        (app.scopes || [])
          .filter((s) => (s.token_types || s.tokenTypes || []).includes("user"))
          .map((s) => s.scope)
          .filter(Boolean),
      ),
    ];
    return {
      appId: c.appId,
      brand: c.brand,
      tokenType: "user",
      userScopes,
      count: userScopes.length,
    };
  }
  if (service === "auth" && command === "list") {
    const c =
      options.config ?? (await loadConfig(flags, env, { optional: true }));
    const sessions = profileSessions(
      await readStore("sessions.json", {}, env),
      c.storageKey,
    );
    const users = sessions.map((session) => ({
      userName: session.user.name,
      userOpenId: session.user.open_id,
      appId: c.appId,
      tokenStatus: !session.accessToken
        ? "no_token"
        : session.expiresAt > Date.now()
          ? "valid"
          : session.refreshToken &&
              (!session.refreshExpiresAt ||
                session.refreshExpiresAt > Date.now())
            ? "needs_refresh"
            : "expired",
    }));
    return ok(users);
  }
  if (service === "profile" && command === "add" && (flags.use || flags.lang)) {
    const appId = required(flags["app-id"], "--app-id");
    const name = required(flags.name || args[0], "--name");
    const secret = yes(flags["app-secret-stdin"])
      ? (await getInput("-", options)).trim()
      : undefined;
    return persistProfile(
      { name, appId, brand: flags.brand || "feishu", lang: flags.lang },
      secret,
      flags,
      options,
    );
  }
  return undefined;
}
