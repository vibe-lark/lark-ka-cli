import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.mjs";
import { configHelp } from "./config-options.mjs";
import {
  configDir,
  loadConfig,
  configure,
  readStore,
  writeStore,
  withLock,
  redactConfig,
  PACKAGE_ROOT,
} from "./config.mjs";
import {
  authLogin,
  authLogout,
  authStatus,
  currentUser,
  getBotToken,
} from "./auth.mjs";
import { requestWithTransfers, validateTransferFlags } from "./transfers.mjs";
import { createContext } from "./context.mjs";
import {
  metadata,
  shortcuts,
  apiSpecs,
  findAPI,
  executeAPI,
} from "./metadata.mjs";
import { executeIM } from "./domains/im.mjs";
import { serveMCP } from "./mcp.mjs";
import {
  consumeEvents,
  eventStatus,
  eventStop,
  STREAM_DONE,
} from "./events.mjs";
import { executeManagement, enforcePolicy } from "./management.mjs";
import { resolveInput } from "./io.mjs";
export const VERSION = "0.1.0";
const envFlags = new Set([
  "help",
  "profile",
  "format",
  "jq",
  "output",
  "as",
  "dry-run",
  "page-all",
  "page-limit",
  "page-delay",
  "yes",
  "force",
  "json",
]);
const top = [
  "api",
  "schema",
  "auth",
  "config",
  "profile",
  "doctor",
  "skills",
  "update",
  "completion",
  "event",
  "mcp",
];
export function help(words = []) {
  if (!words.length)
    return `lark-ka ${VERSION} — native Node.js Feishu/Lark CLI\n\nUsage: lark-ka <command> [subcommand] [flags]\n\nCommands: ${[...top, ...new Set(shortcuts.map((s) => s.service))].join(", ")}\n\n${shortcuts.length} shortcut definitions; ${apiSpecs().length} metadata API methods.\nUse lark-ka <service> --help or lark-ka schema <service.resource.method>.\nGlobal flags: --profile NAME --as user|bot --format json|pretty|table|csv|ndjson --dry-run\n`;
  const [service, command] = words;
  if (service === "config") return configHelp();
  if (service === "auth")
    return 'auth login --scope "approved scopes" [--json] [--no-open] [--redirect-uri URL]\nauth status [--verify] [--connector] | auth whoami --as user --json | logout | scopes | check --scope SCOPES | list\n';
  const spec = shortcuts.find(
    (s) => s.service === service && s.command === command,
  );
  if (spec)
    return `${service} ${command} — ${spec.description}\n${spec.flags.map((f) => `  --${f.name}${f.required ? " (required)" : ""}${f.default !== undefined ? ` [default: ${f.default}]` : ""}  ${f.description}`).join("\n")}\n`;
  if (command && findAPI(words))
    return JSON.stringify(findAPI(words), null, 2) + "\n";
  const list = shortcuts.filter((s) => s.service === service),
    api = metadata.services.find((s) => s.name === service);
  if (list.length || api)
    return (
      [
        ...list.map((s) => `${s.command.padEnd(32)} ${s.description}`),
        ...Object.entries(api?.resources || {}).map(
          ([r, v]) => `${r} ${Object.keys(v.methods || {}).join(" | ")}`,
        ),
      ].join("\n") + "\n"
    );
  return `${service}: ${service === "mcp" ? "serve" : service === "profile" ? "add | list | use | rename | remove" : service === "event" ? "list | schema | consume | status | stop" : service === "skills" ? "list | read | install" : service === "schema" ? "[service.resource.method]" : service === "api" ? "<GET|POST|PUT|PATCH|DELETE> /open-apis/... --params JSON --data JSON" : "--help"}\n`;
}
async function configCommand(action, args, flags) {
  if (action === "init") return configure(flags, resolveInput);
  if (action === "show")
    return redactConfig(
      await loadConfig(flags, process.env, { optional: true }),
    );
  if (action === "plugins" && args[0] === "show")
    return { plugins: [], total: 0 };
  if (action === "policy" && args[0] === "show")
    return await readStore("policy.json", { source: "none", rules: [] });
  if (action === "keychain-downgrade")
    return {
      storage: "private-files",
      directory: configDir(),
      mode: "0600",
      note: "This Node implementation stores credentials in restricted local files; no OS-keychain downgrade is needed.",
    };
  const name =
    flags.profile || (await readStore("config.json", { apps: [] })).currentApp;
  return withLock("config", async () => {
    const store = await readStore("config.json", { apps: [] });
    const app =
      store.apps.find((a) => (a.name || a.appId) === name) || store.apps[0];
    if (!app) throw new CliError("config", "No application configuration");
    if (action === "remove") {
      store.apps = store.apps.filter((a) => a !== app);
      if (store.currentApp === (app.name || app.appId))
        store.currentApp = store.apps[0]?.name;
    } else if (action === "default-as") {
      const value = args[0] || flags.value;
      if (value === undefined) return { defaultAs: app.defaultAs || "auto" };
      if (!["user", "bot", "auto"].includes(value))
        throw new CliError(
          "validation",
          "default-as requires user, bot, or auto",
        );
      app.defaultAs = value;
    } else if (action === "strict-mode") {
      if (flags.reset) {
        delete app.strictMode;
        await writeStore("config.json", store);
        return { strictMode: store.strictMode || "off" };
      }
      const value = args[0] || flags.value;
      if (value === undefined)
        return { strictMode: app.strictMode || store.strictMode || "off" };
      if (!["user", "bot", "off"].includes(value))
        throw new CliError(
          "validation",
          "strict-mode requires user, bot, or off",
        );
      if (flags.global) store.strictMode = value;
      else app.strictMode = value;
    } else throw new CliError("validation", `Unknown config command ${action}`);
    await writeStore("config.json", store);
    return { profile: app.name, ...redactConfig(app) };
  });
}
async function profileCommand(action, args, flags) {
  if (action === "add")
    return configure({ ...flags, name: args[0] || flags.name }, resolveInput);
  return withLock("config", async () => {
    const store = await readStore("config.json", { apps: [] });
    if (action === "list")
      return {
        current: store.currentApp,
        profiles: store.apps.map((a) => ({
          name: a.name || a.appId,
          appId: a.appId,
          brand: a.brand,
        })),
      };
    const name = args[0] || flags.name;
    const app = store.apps.find((a) => (a.name || a.appId) === name);
    if (!app) throw new CliError("validation", `Unknown profile: ${name}`);
    if (action === "use") store.currentApp = name;
    else if (action === "rename") {
      const newName = args[1] || flags["new-name"];
      if (
        !/^[\w.-]+$/.test(newName || "") ||
        store.apps.some((a) => a.name === newName)
      )
        throw new CliError(
          "validation",
          "New profile name must be unique and contain letters, digits, _, ., or -",
        );
      app.name = newName;
      if (store.currentApp === name) store.currentApp = newName;
    } else if (action === "remove") {
      store.apps = store.apps.filter((a) => a !== app);
      if (store.currentApp === name) store.currentApp = store.apps[0]?.name;
    } else
      throw new CliError("validation", `Unknown profile command ${action}`);
    await writeStore("config.json", store);
    return {
      current: store.currentApp,
      profiles: store.apps.map((a) => a.name || a.appId),
    };
  });
}
async function skillsCommand(action, args, flags) {
  const root = path.join(PACKAGE_ROOT, "skills");
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((x) => x.isDirectory())
    .map((x) => x.name);
  if (!action || action === "list") return { skills: names };
  if (action === "read") {
    const value = args[0] || flags.name;
    if (!value || value.includes("..") || path.isAbsolute(value))
      throw new CliError(
        "validation",
        "Provide a skill name or relative reference",
      );
    const file = path.join(
      root,
      value.endsWith(".md") ? value : path.join(value, "SKILL.md"),
    );
    return { __raw: await readFile(file, "utf8") };
  }
  throw new CliError("validation", `Unknown skills command ${action}`, {
    hint: "Bundled skills can be read with skills list/read and installed using your agent’s skill importer.",
  });
}
export async function execute(words, flags = {}, options = {}) {
  const creating =
    (words[0] === "config" && ["init", "bind"].includes(words[1])) ||
    (words[0] === "profile" && words[1] === "add");
  const policyFlags = creating
    ? Object.fromEntries(
        Object.entries(flags).filter(([key]) => key !== "profile"),
      )
    : flags;
  const policyEnv = creating
    ? { ...(options.env || process.env), LARK_KA_PROFILE: "" }
    : options.env || process.env;
  const config =
    options.config ||
    (await loadConfig(policyFlags, policyEnv, { optional: true }));
  await enforcePolicy(words, flags, config, options);
  const managed = await executeManagement(words, flags, options);
  if (managed !== undefined) return managed;
  return executeInternal(words, flags, options);
}
async function executeInternal(words, flags = {}, options = {}) {
  const [service, command, ...args] = words;
  if (service === "config")
    return { ok: true, data: await configCommand(command, args, flags) };
  if (service === "profile")
    return { ok: true, data: await profileCommand(command, args, flags) };
  if (service === "skills" || service === "skill") {
    const data = await skillsCommand(command, args, flags);
    return data.__raw ? data : { ok: true, data };
  }
  if (service === "schema") {
    const key = words.slice(1).join(".");
    if (!key)
      return {
        ok: true,
        data: {
          services: metadata.services.map((s) => ({
            name: s.name,
            resources: Object.keys(s.resources),
          })),
          shortcuts: shortcuts.map((s) => `${s.service}.${s.command}`),
        },
      };
    const spec =
      findAPI(key.split(".")) ||
      shortcuts.find((s) => `${s.service}.${s.command}` === key);
    if (!spec) throw new CliError("validation", `Unknown schema ${key}`);
    return { ok: true, data: spec };
  }
  if (service === "completion") {
    const shell = command || "bash";
    const names = [
      ...new Set([...top, ...shortcuts.map((s) => s.service)]),
    ].join(" ");
    if (shell === "bash")
      return { __raw: `complete -W '${names}' lark-ka lark-cli\n` };
    if (shell === "zsh")
      return {
        __raw: `#compdef lark-ka lark-cli\n_arguments '1:command:(${names})'\n`,
      };
    if (shell === "fish")
      return {
        __raw: `complete -c lark-ka -f -a '${names}'\ncomplete -c lark-cli -f -a '${names}'\n`,
      };
    if (shell === "powershell")
      return {
        __raw: `Register-ArgumentCompleter -Native -CommandName lark-ka,lark-cli -ScriptBlock { param($wordToComplete) '${names}'.Split(' ') | Where-Object { $_ -like "$wordToComplete*" } }\n`,
      };
    throw new CliError("validation", "Unsupported shell");
  }
  if (service === "event" && ["list", "schema"].includes(command))
    return {
      ok: true,
      data: {
        events: JSON.parse(
          await readFile(path.join(PACKAGE_ROOT, "data/events.json"), "utf8"),
        ).filter((e) => !args[0] || e.key === args[0]),
      },
    };
  if (service === "mcp" && command === "serve")
    return serveMCP(execute, {
      profile: flags.profile,
      signal: options.signal,
    });
  if (service === "auth") {
    if (command === "qrcode") {
      const { default: QR } = await import("qrcode");
      const url = flags.url || args[0];
      if (!url)
        throw new CliError("validation", "Provide --url for QR generation");
      const size = Number(flags.size || 256);
      if (!Number.isInteger(size) || size < 32 || size > 1024)
        throw new CliError("validation", "--size must be 32..1024");
      if (flags.output) {
        await QR.toFile(flags.output, url, { width: size });
        return { ok: true, data: { path: path.resolve(flags.output) } };
      }
      if (flags.ascii)
        return {
          __raw: await QR.toString(url, { type: "terminal", small: true }),
        };
      throw new CliError(
        "validation",
        "Provide --output for PNG or --ascii for terminal QR output",
      );
    }
    const c = await loadConfig(flags);
    if (command === "login") {
      if ((flags.recommend || flags.domain) && !flags.scope) {
        const domains = flags.domain
          ? String(flags.domain).split(",")
          : ["contact", "calendar", "task", "drive"];
        const selected = apiSpecs().filter(
          (s) => domains.includes("all") || domains.includes(s.service),
        );
        flags.scope = [
          ...new Set(selected.flatMap((s) => s.scopes || [])),
        ].join(" ");
        if (!flags.scope)
          throw new CliError(
            "validation",
            "No scopes found for selected domains",
          );
      }
      return {
        ok: true,
        identity: "user",
        data: await authLogin(c, flags, { signal: options.signal }),
      };
    }
    if (command === "logout") return { ok: true, data: await authLogout(c) };
    if (command === "status")
      return {
        ok: true,
        ...(await authStatus(c, {
          verify: !!flags.verify || !!flags.connector,
        })),
      };
    if (command === "whoami") {
      if ((flags.as || c.defaultAs) === "bot") {
        const { fetchJSON } = await import("./http.mjs");
        const result = await fetchJSON(
          new URL("/open-apis/bot/v3/info/", c.openBaseUrl),
          { headers: { Authorization: "Bearer " + (await getBotToken(c)) } },
        );
        return {
          ok: true,
          identity: "bot",
          app_id: c.appId,
          brand: c.brand,
          bot: result.bot || result.data || result,
        };
      }
      return {
        ok: true,
        identity: "user",
        app_id: c.appId,
        brand: c.brand,
        user: await currentUser(c),
      };
    }
    if (command === "list") {
      const sessions = await readStore("sessions.json", {});
      return {
        ok: true,
        data: {
          users: Object.values(sessions)
            .map((s) => s.user)
            .filter(Boolean),
        },
      };
    }
    if (command === "check" || command === "scopes") {
      const state = await authStatus(c);
      const granted = String(state.scope || "")
        .split(/[ ,]+/)
        .filter(Boolean);
      const required = String(flags.scope || "")
        .split(/[ ,]+/)
        .filter(Boolean);
      const missing = required.filter((s) => !granted.includes(s));
      if (command === "check" && (!state.loggedIn || missing.length))
        throw new CliError("permission", "Required user scopes are missing", {
          code: 3,
          detail: { missingScopes: missing },
        });
      return { ok: true, data: { scopes: granted, missingScopes: missing } };
    }
    throw new CliError("validation", `Unknown auth command ${command}`);
  }
  if (service === "doctor") {
    const c = await loadConfig(flags, process.env, { optional: true });
    return {
      ok: true,
      data: {
        runtime: process.version,
        implementation: "nodejs",
        configDir: configDir(),
        configuration: !!c.appId,
        auth: c.appId
          ? await authStatus(c, { verify: !!flags.verify })
          : { loggedIn: false },
      },
    };
  }
  if (service === "update") {
    return {
      ok: true,
      data: {
        current: VERSION,
        package: "@lark-ka/cli",
        hint: "Update this customer package from its approved npm registry. No official Go binary is used.",
      },
    };
  }
  const introspection =
    flags["print-schema"] ||
    flags["print-output-schema"] ||
    flags["print-filter-schema"];
  const ctx = await createContext(
    flags,
    introspection
      ? {
          ...options,
          config: await loadConfig(flags, process.env, { optional: true }),
        }
      : options,
  );
  let result;
  if (service === "api") {
    const [method, route] = words.slice(1);
    if (words.length > 3)
      throw new CliError(
        "validation",
        "Unexpected positional arguments after the API path",
      );
    if (
      !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(
        String(method).toUpperCase(),
      ) ||
      !route
    )
      throw new CliError(
        "validation",
        "Usage: api METHOD /open-apis/... [--params JSON] [--data JSON]",
      );
    validateTransferFlags(method.toUpperCase(), flags);
    const query = flags.params ? JSON.parse(await ctx.input(flags.params)) : {};
    const body =
      flags.data || flags.body
        ? JSON.parse(await ctx.input(flags.data || flags.body))
        : undefined;
    result = await requestWithTransfers(
      ctx,
      method.toUpperCase(),
      route,
      { query, body },
      flags,
    );
  } else if (service === "event") {
    if (command === "consume")
      result = await consumeEvents(ctx, args[0] || flags.event, flags);
    else if (command === "status") result = await eventStatus(ctx);
    else if (command === "stop") result = await eventStop(ctx);
    else if (command === "list" || command === "schema")
      result = {
        events: JSON.parse(
          await readFile(path.join(PACKAGE_ROOT, "data/events.json"), "utf8"),
        ).filter((e) => !args[0] || e.key === args[0]),
      };
    else if (command === "+subscribe")
      result = await consumeEvents(
        ctx,
        args[0] || flags.event || flags["event-types"] || flags["event-type"],
        { ...flags, rawSubscription: true },
      );
    else throw new CliError("validation", `Unknown event command ${command}`);
  } else {
    const api = findAPI(words);
    if (api) {
      if (api.risk === "high-risk-write" && !ctx.dryRun && !flags.yes)
        throw new CliError(
          "confirmation_required",
          "This operation requires --yes after reviewing its --dry-run request",
        );
      result = await executeAPI(ctx, api, flags);
    } else {
      const spec = shortcuts.find(
        (s) => s.service === service && s.command === command,
      );
      if (spec && args.length)
        throw new CliError(
          "validation",
          "Shortcut commands accept flags, not positional arguments",
        );
      if (spec?.risk === "high-risk-write" && !ctx.dryRun && !flags.yes)
        throw new CliError(
          "confirmation_required",
          "This operation requires --yes after reviewing its --dry-run request",
        );
      if (spec)
        for (const f of spec.flags) {
          if (flags[f.name] === undefined && f.default !== undefined)
            flags[f.name] =
              f.type === "bool"
                ? f.default === "true"
                : f.type === "int"
                  ? Number(f.default)
                  : f.default;
          if (
            f.required &&
            (flags[f.name] === undefined || flags[f.name] === "")
          )
            throw new CliError("validation", `--${f.name} is required`);
          if (
            f.enum?.length &&
            flags[f.name] !== undefined &&
            !f.enum.includes(String(flags[f.name]))
          )
            throw new CliError(
              "validation",
              `--${f.name} must be ${f.enum.join(", ")}`,
            );
        }
      result = await executeIM(ctx, service, command, flags);
      for (const file of ["collaboration", "content", "tables", "apps"])
        if (result === undefined) {
          const module = await import(`./domains/${file}.mjs`);
          const handler =
            module[`execute${file[0].toUpperCase() + file.slice(1)}`];
          if (handler) result = await handler(ctx, service, command, flags);
        }
      if (result === undefined)
        throw new CliError(
          "validation",
          `Unknown or not yet migrated command: ${words.join(" ")}`,
          { hint: `Run lark-ka ${service} --help and npm run compatibility.` },
        );
    }
  }
  if (result === STREAM_DONE) return STREAM_DONE;
  if (!ctx.dryRun && result?.__raw !== undefined) return result;
  return {
    ok: true,
    identity: ctx.identity,
    data: ctx.dryRun
      ? result?.dry_run && result.requests
        ? result
        : { dry_run: true, requests: ctx.requests }
      : result,
  };
}

export function isCommandGroup(words) {
  if (words.length === 1)
    return [
      "auth",
      "config",
      "profile",
      "mcp",
      "event",
      ...new Set(shortcuts.map((s) => s.service)),
    ].includes(words[0]);
  return apiSpecs().some(
    (s) =>
      words.join(" ") === `${s.service} ${s.resource}` ||
      words.join(" ") === `${s.service} ${s.resource.replaceAll(".", " ")}`,
  );
}
