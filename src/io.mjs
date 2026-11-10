import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.mjs";

const MAX_INPUT = 64 * 1024 * 1024;

async function readStdin(stdin) {
  if (typeof stdin === "string") return stdin;
  if (stdin instanceof Uint8Array) return Buffer.from(stdin).toString("utf8");
  if (!stdin || typeof stdin[Symbol.asyncIterator] !== "function") {
    throw new CliError(
      "validation",
      "stdin must be a readable stream, string, or byte buffer.",
    );
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT)
      throw new CliError("validation", "stdin exceeds the 64 MiB input limit.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function resolveInput(value, { stdin = process.stdin } = {}) {
  if (typeof value !== "string")
    throw new CliError("validation", "Input must be a string.");
  if (value.includes("\0"))
    throw new CliError("validation", "Input contains a NUL byte.");
  if (value === "-") {
    const text = await readStdin(stdin);
    if (text.includes("\0"))
      throw new CliError("validation", "stdin contains a NUL byte.");
    return text.replace(/^\uFEFF/, "");
  }
  if (!value.startsWith("@")) return value;
  const filename = value.slice(1);
  if (
    !filename ||
    filename.includes("\0") ||
    filename.split(/[\\/]/).includes("..")
  ) {
    throw new CliError(
      "validation",
      "File input requires a path without NUL bytes or parent-directory traversal.",
      { hint: "Use @./file.json or an explicit absolute file path." },
    );
  }
  const absolute = path.resolve(filename);
  let handle;
  try {
    if (!path.isAbsolute(filename)) {
      const [base, resolved] = await Promise.all([
        realpath(process.cwd()),
        realpath(absolute),
      ]);
      const relative = path.relative(base, resolved);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new CliError(
          "validation",
          "Relative file input resolves outside the working directory.",
          {
            hint: "Use an explicit absolute path for a file outside the working directory.",
          },
        );
      }
    }
    handle = await open(
      absolute,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new CliError(
        "validation",
        "File input must point to a regular file.",
      );
    if (stat.size > MAX_INPUT)
      throw new CliError("validation", "File exceeds the 64 MiB input limit.");
    const text = await handle.readFile({ encoding: "utf8" });
    if (text.includes("\0"))
      throw new CliError("validation", "File input contains a NUL byte.");
    return text.replace(/^\uFEFF/, "");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("validation", `Cannot read input file: ${filename}`, {
      hint:
        error.code === "ELOOP"
          ? "Use a regular file instead of a symbolic link."
          : `Check the path and read permissions (${error.code ?? "read error"}).`,
    });
  } finally {
    await handle?.close();
  }
}

export async function readJSONInput(value, options) {
  if (value !== null && typeof value === "object") return value;
  const text = await resolveInput(value, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError("validation", "Input is not valid JSON.", {
      hint: "Pass a JSON object as a string, @file.json, or - to read stdin.",
    });
  }
}

function lookup(values, expression) {
  if (expression === ".") return values;
  if (!expression.startsWith("."))
    throw new CliError("validation", "Unsupported jq expression.", {
      hint: "Supported selectors include .data.items, .items[], .[0], and pipes between path selectors.",
    });
  const source = expression.slice(1);
  const token =
    /(?:^|\.)([A-Za-z_$][\w$-]*)|\[(\d+|"(?:[^"\\]|\\.)*"|'[^']*')?\]/g;
  let offset = 0;
  let match;
  let current = values;
  while ((match = token.exec(source)) !== null) {
    if (match.index !== offset)
      throw new CliError("validation", "Unsupported jq expression.");
    offset = token.lastIndex;
    if (match[1]) current = current.map((v) => v?.[match[1]] ?? null);
    else if (match[2] === undefined)
      current = current.flatMap((v) =>
        Array.isArray(v)
          ? v
          : v && typeof v === "object"
            ? Object.values(v)
            : [],
      );
    else {
      const key = match[2].startsWith('"')
        ? JSON.parse(match[2])
        : match[2].startsWith("'")
          ? match[2].slice(1, -1)
          : Number(match[2]);
      current = current.map((v) => v?.[key] ?? null);
    }
  }
  if (offset !== source.length)
    throw new CliError("validation", "Unsupported jq expression.", {
      hint: "Use path selectors; full jq programs are not supported by the built-in formatter.",
    });
  return current;
}

function jqValues(data, expression) {
  return expression
    .split("|")
    .reduce((values, step) => lookup(values, step.trim()), [data]);
}

function printable(value) {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function asRows(value) {
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(value?.items)
      ? value.items
      : [value];
  return rows.map((row) =>
    row !== null && typeof row === "object" && !Array.isArray(row)
      ? row
      : { value: row },
  );
}

function displayWidth(value) {
  return Array.from(value).reduce(
    (sum, char) =>
      sum +
      (/\p{Extended_Pictographic}|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(
        char,
      )
        ? 2
        : /\p{Mark}/u.test(char)
          ? 0
          : 1),
    0,
  );
}

export function formatOutput(data, { format = "json", jq } = {}) {
  const values = jq ? jqValues(data, jq) : [data];
  if (format === "json" || format === "pretty")
    return (
      values.map((v) => JSON.stringify(v, null, 2)).join("\n") +
      (values.length ? "\n" : "")
    );
  if (format === "ndjson")
    return (
      values
        .flatMap((v) => (Array.isArray(v) ? v : [v]))
        .map((v) => JSON.stringify(v))
        .join("\n") + (values.length ? "\n" : "")
    );
  if (format !== "table" && format !== "csv")
    throw new CliError("validation", `Unknown output format: ${format}`, {
      hint: "Use json, pretty, table, csv, or ndjson.",
    });
  const rows = values.flatMap(asRows);
  if (!rows.length) return "";
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const cells = rows.map((row) => columns.map((key) => printable(row[key])));
  if (format === "csv") {
    const quote = (value) =>
      /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    return (
      [columns, ...cells].map((row) => row.map(quote).join(",")).join("\n") +
      "\n"
    );
  }
  const normalized = [columns, ...cells].map((row) =>
    row.map((c) => c.replace(/\r?\n/g, " ")),
  );
  const widths = columns.map((_, i) =>
    Math.max(...normalized.map((row) => displayWidth(row[i]))),
  );
  const render = (row) =>
    row
      .map((value, i) => value + " ".repeat(widths[i] - displayWidth(value)))
      .join("  ")
      .trimEnd();
  return (
    [
      render(normalized[0]),
      widths.map((width) => "-".repeat(width)).join("  "),
      ...normalized.slice(1).map(render),
    ].join("\n") + "\n"
  );
}
