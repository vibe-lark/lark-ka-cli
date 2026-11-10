import { CliError } from "../errors.mjs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
export const commandSpecs = {
  apps: {
    "+create": {},
    "+update": {},
    "+list": {},
    "+access-scope-get": {},
    "+access-scope-set": {},
    "+html-publish": {},
  },
};
const requireFlag = (f, k) => {
  if (!f[k]) throw new CliError("validation", `--${k} is required`);
  return f[k];
};
async function archive(root, allowSensitive) {
  const stat = await lstat(root),
    base = stat.isDirectory() ? root : path.dirname(root),
    files = [];
  async function walk(p) {
    const s = await lstat(p);
    if (s.isSymbolicLink())
      throw new CliError(
        "validation",
        "HTML publish does not follow symbolic links",
      );
    if (s.isDirectory()) {
      for (const n of (await readdir(p)).sort())
        if (!["node_modules", ".git"].includes(n)) await walk(path.join(p, n));
    } else if (s.isFile())
      files.push({
        name: stat.isFile()
          ? "index.html"
          : path.relative(base, p).replaceAll(path.sep, "/"),
        bytes: await readFile(p),
      });
  }
  await walk(root);
  if (!files.some((f) => f.name === "index.html"))
    throw new CliError(
      "validation",
      "Publish directory must contain index.html",
    );
  const chunks = [];
  let total = 0;
  for (const file of files) {
    total += file.bytes.length;
    if (total > 50 * 1024 * 1024)
      throw new CliError("validation", "HTML publish payload exceeds 50 MiB");
    if (
      !allowSensitive &&
      /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|credentials|id_rsa|id_ed25519)(?:$|\/)/i.test(
        file.name,
      )
    )
      throw new CliError(
        "validation",
        `Sensitive file in publish directory: ${file.name}`,
      );
    if (Buffer.byteLength(file.name) > 100)
      throw new CliError(
        "validation",
        "Publish paths must fit the tar name field (100 bytes)",
      );
    const header = Buffer.alloc(512);
    header.write(file.name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(file.bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(
      header,
      file.bytes,
      Buffer.alloc((512 - (file.bytes.length % 512)) % 512),
    );
  }
  chunks.push(Buffer.alloc(1024));
  return {
    files: files.map((f) => f.name),
    body: gzipSync(Buffer.concat(chunks)),
  };
}
export async function executeApps(ctx, service, command, f) {
  if (service !== "apps" || !Object.hasOwn(commandSpecs.apps, command))
    return undefined;
  if (ctx.config.brand && !["feishu"].includes(ctx.config.brand))
    throw new CliError(
      "permission",
      "apps is available for Feishu SaaS deployments only",
      { code: 3 },
    );
  if (ctx.identity !== "user")
    throw new CliError("permission", "apps requires user identity", {
      code: 3,
    });
  const base = "/open-apis/spark/v1/apps",
    route = f["app-id"] ? `${base}/${encodeURIComponent(f["app-id"])}` : base;
  if (command === "+list")
    return ctx.request("GET", base, {
      query: {
        page_size: Number(f["page-size"] || 20),
        page_token: f["page-token"],
      },
    });
  if (command === "+create") {
    if (f["app-type"] !== "HTML")
      throw new CliError("validation", "--app-type must be HTML");
    return ctx.request("POST", base, {
      body: {
        name: requireFlag(f, "name"),
        app_type: "HTML",
        ...(f.description ? { description: f.description } : {}),
        ...(f["icon-url"] ? { icon_url: f["icon-url"] } : {}),
      },
    });
  }
  requireFlag(f, "app-id");
  if (command === "+update") {
    const body = Object.fromEntries(
      ["name", "description"]
        .filter((k) => f[k] !== undefined)
        .map((k) => [k, f[k]]),
    );
    if (!Object.keys(body).length)
      throw new CliError("validation", "Provide --name or --description");
    return ctx.request("PATCH", route, { body });
  }
  if (command === "+access-scope-get")
    return ctx.request("GET", route + "/access-scope");
  if (command === "+access-scope-set") {
    const scopes = { specific: "Range", public: "All", tenant: "Tenant" },
      scope = requireFlag(f, "scope");
    if (!scopes[scope])
      throw new CliError(
        "validation",
        "--scope must be specific, public, or tenant",
      );
    const body = { scope: scopes[scope] };
    if (scope === "specific") {
      const targets = JSON.parse(await ctx.input(requireFlag(f, "targets")));
      if (!Array.isArray(targets) || !targets.length)
        throw new CliError(
          "validation",
          "--targets must be a nonempty JSON array",
        );
      for (const t of targets) {
        const key = { user: "users", department: "departments", chat: "chats" }[
          t.type
        ];
        if (!key || !String(t.id || "").trim())
          throw new CliError(
            "validation",
            "Target requires type user/department/chat and id",
          );
        (body[key] ||= []).push(t.id);
      }
      if (f["require-login"])
        throw new CliError(
          "validation",
          "--require-login is only valid for public scope",
        );
      if (f.approver && !f["apply-enabled"])
        throw new CliError("validation", "--approver requires --apply-enabled");
      if (f["apply-enabled"])
        body.apply_config = {
          enabled: true,
          ...(f.approver ? { approvers: [f.approver] } : {}),
        };
    } else {
      if (f.targets || f.approver || f["apply-enabled"])
        throw new CliError(
          "validation",
          "Targets/apply flags require specific scope",
        );
      if (scope === "public") body.require_login = !!f["require-login"];
    }
    return ctx.request("PUT", route + "/access-scope", { body });
  }
  const data = await archive(
    path.resolve(requireFlag(f, "path")),
    !!f["allow-sensitive"],
  );
  const form = new FormData();
  form.set(
    "file",
    new Blob([data.body], { type: "application/gzip" }),
    "site.tar.gz",
  );
  return ctx.request("POST", route + "/upload_and_release_html_code", {
    body: form,
  });
}
