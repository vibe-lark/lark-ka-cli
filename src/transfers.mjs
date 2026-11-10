import { readFile, lstat, realpath, open } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { CliError } from "./errors.mjs";
export function validateTransferFlags(method, flags) {
  if (flags.output && (flags["page-all"] || flags.jq || flags.file))
    throw new CliError(
      "validation",
      "--output cannot be combined with --page-all, --jq, or --file",
    );
  if (flags.file) {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method))
      throw new CliError(
        "validation",
        "--file requires POST, PUT, PATCH, or DELETE",
      );
    if (flags["page-all"])
      throw new CliError(
        "validation",
        "--file and --page-all are mutually exclusive",
      );
    const file = String(flags.file).replace(/^[A-Za-z_][\w-]*=/, "");
    if (
      file === "-" &&
      (flags.params === "-" || flags.data === "-" || flags.body === "-")
    )
      throw new CliError("validation", "Only one input may read from stdin");
  }
  if (flags.params === "-" && (flags.data === "-" || flags.body === "-"))
    throw new CliError(
      "validation",
      "--params and --data cannot both read stdin",
    );
}
async function inputBytes(file) {
  if (file === "-") {
    const chunks = [];
    for await (const part of process.stdin)
      chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    const data = Buffer.concat(chunks);
    if (!data.length) throw new CliError("validation", "--file stdin is empty");
    return data;
  }
  if (!file || /[\0\r\n]/.test(file) || file.split(/[\\/]/).includes(".."))
    throw new CliError("validation", "Invalid file path");
  const target = path.resolve(file),
    info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink())
    throw new CliError(
      "validation",
      "Upload source must be a regular file without symbolic links",
    );
  return readFile(target);
}
export async function requestWithTransfers(
  ctx,
  method,
  route,
  options,
  flags,
  { fileFields } = {},
) {
  validateTransferFlags(method, flags);
  if (flags.file) {
    let raw = String(flags.file),
      field;
    const match = /^([A-Za-z_][\w-]*)=(.*)$/s.exec(raw);
    if (match) {
      field = match[1];
      raw = match[2];
    }
    if (!field) {
      if (fileFields?.length > 1)
        throw new CliError(
          "validation",
          "--file requires an explicit field=path when the API has multiple file fields",
        );
      field = fileFields?.[0] || "file";
    }
    if (fileFields && (!fileFields.length || !fileFields.includes(field)))
      throw new CliError(
        "validation",
        `File field ${field} is not declared by this API`,
      );
    const fields = options.body || {};
    if (!fields || typeof fields !== "object" || Array.isArray(fields))
      throw new CliError(
        "validation",
        "--data must be a JSON object with --file",
      );
    if (ctx.dryRun) {
      ctx.requests.push({
        method,
        path: route,
        params: options.query,
        data: { multipart: true, file: { field, path: raw }, fields },
        identity: ctx.identity,
      });
      return { dry_run: true };
    }
    const data = await inputBytes(raw),
      form = new FormData();
    for (const [key, value] of Object.entries(fields))
      form.set(
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      );
    form.set(
      field,
      new Blob([data]),
      raw === "-" ? "stdin" : path.basename(raw),
    );
    return ctx.request(method, route, { ...options, body: form });
  }
  if (flags.output) {
    const output = path.resolve(flags.output);
    if (
      /[\0\r\n]/.test(output) ||
      String(flags.output).split(/[\\/]/).includes("..")
    )
      throw new CliError("validation", "Invalid output path");
    if (ctx.dryRun) {
      ctx.requests.push({
        method,
        path: route,
        params: options.query,
        data: options.body,
        output,
        identity: ctx.identity,
      });
      return { dry_run: true };
    }
    let existing;
    try {
      existing = await lstat(output);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
      throw new CliError(
        "validation",
        "Output must not be a symbolic link or directory",
      );
    if (existing && !flags.force && !flags.overwrite)
      throw new CliError(
        "validation",
        "Output already exists; use --force to overwrite",
      );
    await realpath(path.dirname(output));
    const data = await ctx.request(method, route, {
      ...options,
      responseType: "buffer",
    });
    if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array))
      throw new CliError("api", "Download did not return binary content", {
        code: 5,
      });
    try {
      const envelope = JSON.parse(Buffer.from(data).toString("utf8"));
      if (typeof envelope.code === "number" && envelope.code !== 0)
        throw new CliError("api", envelope.msg || "API download failed", {
          code: 5,
          detail: { apiCode: envelope.code },
        });
    } catch (e) {
      if (e instanceof CliError) throw e;
    }
    const handle = await open(
      output,
      constants.O_WRONLY |
        constants.O_CREAT |
        (existing ? constants.O_TRUNC : constants.O_EXCL) |
        (constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    return { saved_path: output, size_bytes: data.length };
  }
  return flags["page-all"]
    ? ctx.paginate(method, route, options)
    : ctx.request(method, route, options);
}
