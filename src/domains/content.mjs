import {
  readFile,
  writeFile,
  mkdir,
  stat,
  readdir,
  realpath,
  utimes,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliError } from "../errors.mjs";

const enc = (value) => encodeURIComponent(String(value));
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const val = (f, key, fallback) => f[key] ?? fallback;
const yes = (value) => value === true || value === "true";
const clean = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
const err = (message, type = "validation", detail) =>
  new CliError(type, message, {
    code:
      type === "validation"
        ? 2
        : type === "auth"
          ? 3
          : type === "api" || type === "partial_failure"
            ? 5
            : 1,
    detail,
  });
const required = (f, key) => {
  if (f[key] === undefined || f[key] === "") throw err(`--${key} is required`);
  return f[key];
};
const number = (f, key, fallback, min = 0, max = Infinity) => {
  const n = Number(val(f, key, fallback));
  if (!Number.isInteger(n) || n < min || n > max)
    throw err(`--${key} must be an integer between ${min} and ${max}`);
  return n;
};
const list = (value) =>
  Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
const xml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const bool = (f, key, fallback = false) =>
  has(f, key) ? yes(f[key]) : fallback;
const runFile = promisify(execFile);
const request = (ctx, method, url, query, body, extra = {}) =>
  ctx.request(method, url, clean({ query, body, ...extra }));
const dry = (ctx, requests, extra = {}) =>
  ctx.dryRun ? { dry_run: true, requests, ...extra } : undefined;
const step = (method, url, query, body) =>
  clean({ method, path: url, query, body });
const input = async (ctx, value) =>
  value === undefined ? undefined : ctx.input ? ctx.input(value) : value;
async function json(ctx, value, name = "input", fallback = {}) {
  if (value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(await input(ctx, value));
  } catch {
    throw err(`${name} must contain valid JSON`);
  }
}

export function resourceRef(raw, type) {
  if (!raw || /[\u0000-\u001f\u007f]/u.test(String(raw)))
    throw err("A valid resource URL or token is required");
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    const match = url.pathname.match(
      /\/(docx|doc|sheets|sheet|base|bitable|wiki|file|slides|mindnote)\/([^/]+)/,
    );
    if (!match) throw err("Resource URL has no recognized resource token");
    const token = decodeURIComponent(match[2]);
    if (!/^[A-Za-z0-9_-]+$/.test(token))
      throw err("Resource URL contains an invalid token");
    return {
      token,
      type: { sheets: "sheet", base: "bitable" }[match[1]] ?? match[1],
    };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(raw))
    throw err(
      "Resource token must contain only letters, numbers, underscores, or hyphens",
    );
  return { token: String(raw), type };
}

async function resolveRef(ctx, raw, type = "docx") {
  const ref = resourceRef(raw, type);
  if (ref.type !== "wiki") return ref;
  if (ctx.dryRun)
    return {
      token: "__WIKI_OBJECT_TOKEN__",
      type,
      resolveRequest: step("GET", "/open-apis/wiki/v2/spaces/get_node", {
        token: ref.token,
      }),
    };
  const data = await request(ctx, "GET", "/open-apis/wiki/v2/spaces/get_node", {
    token: ref.token,
  });
  if (!data.node?.obj_token)
    throw err("Wiki lookup returned no obj_token", "api");
  return {
    token: data.node.obj_token,
    type: data.node.obj_type,
    node: data.node,
  };
}

function resourceURL(ctx, type, token) {
  return ctx.config?.webBaseUrl
    ? `${ctx.config.webBaseUrl.replace(/\/$/, "")}/${type}/${enc(token)}`
    : undefined;
}

async function safeLocal(ctx, value, { output = false } = {}) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f]/u.test(value))
    throw err("A valid local path is required");
  const root = path.resolve(ctx.cwd ?? process.cwd());
  const resolved = path.resolve(root, value.replace(/^@/, ""));
  if (path.relative(root, resolved).split(path.sep).includes(".."))
    throw err("File path must stay within the current working directory");
  const physicalRoot = await realpath(root);
  let physical;
  if (output) {
    try {
      physical = await realpath(resolved);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      let parent = path.dirname(resolved);
      for (;;) {
        try {
          physical = path.join(
            await realpath(parent),
            path.relative(parent, resolved),
          );
          break;
        } catch (e) {
          if (e.code !== "ENOENT" || parent === path.dirname(parent)) throw e;
          parent = path.dirname(parent);
        }
      }
    }
  } else {
    physical = await realpath(resolved);
    const info = await stat(physical);
    if (!info.isFile() && !info.isDirectory())
      throw err("Local input must be a regular file or directory");
  }
  if (path.relative(physicalRoot, physical).split(path.sep).includes(".."))
    throw err("Symlink resolves outside the current working directory");
  return resolved;
}

async function writeOutput(ctx, filename, bytes, overwrite = false) {
  const target = await safeLocal(ctx, filename, { output: true });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, {
    flag:
      constants.O_WRONLY |
      constants.O_CREAT |
      (overwrite ? constants.O_TRUNC : constants.O_EXCL) |
      (constants.O_NOFOLLOW ?? 0),
    mode: 0o600,
  });
  return { output: target, size_bytes: bytes.length };
}

async function pages(ctx, method, url, options = {}, key = "items") {
  if (ctx.dryRun)
    return dry(ctx, [step(method, url, options.query, options.body)]);
  const f = ctx.flags ?? {};
  if (!yes(f["page-all"])) return ctx.request(method, url, options);
  const all = [];
  let token = options.query?.page_token ?? options.body?.page_token;
  let last;
  const seen = new Set();
  const limit = number(f, "page-limit", 10, 0);
  for (let n = 0; !limit || n < limit; n++) {
    const next = { ...options };
    const container = method === "GET" ? "query" : "body";
    next[container] = clean({ ...(next[container] ?? {}), page_token: token });
    last = await ctx.request(method, url, next);
    all.push(...(last[key] ?? last.items ?? []));
    token = last.next_page_token ?? last.page_token;
    if (!last.has_more || !token) break;
    if (seen.has(token))
      throw err("Pagination returned a repeated page token", "api");
    seen.add(token);
  }
  return { ...last, [key]: all };
}

async function uploadBytes(ctx, buffer, name, fields = {}, media = false) {
  const base = `/open-apis/drive/v1/${media ? "medias" : "files"}`;
  if (buffer.length <= 20 * 1024 * 1024) {
    const form = new FormData();
    for (const [key, value] of Object.entries({
      file_name: name,
      size: buffer.length,
      ...fields,
    }))
      if (value !== undefined) form.set(key, String(value));
    form.set("file", new Blob([buffer]), name);
    return request(ctx, "POST", `${base}/upload_all`, undefined, form);
  }
  const prepared = await request(
    ctx,
    "POST",
    `${base}/upload_prepare`,
    undefined,
    { file_name: name, size: buffer.length, ...fields },
  );
  if (!prepared.upload_id || !(prepared.block_size > 0))
    throw err("Upload prepare returned no upload_id/block_size", "api");
  const count = Math.ceil(buffer.length / prepared.block_size);
  for (let i = 0; i < count; i++) {
    const form = new FormData();
    const bytes = buffer.subarray(
      i * prepared.block_size,
      (i + 1) * prepared.block_size,
    );
    for (const [key, value] of Object.entries({
      upload_id: prepared.upload_id,
      seq: i,
      size: bytes.length,
    }))
      form.set(key, String(value));
    form.set("file", new Blob([bytes]), name);
    await request(ctx, "POST", `${base}/upload_part`, undefined, form);
  }
  return request(ctx, "POST", `${base}/upload_finish`, undefined, {
    upload_id: prepared.upload_id,
    block_num: count,
  });
}

function uploadPreview(name, size, fields = {}, media = false) {
  const base = `/open-apis/drive/v1/${media ? "medias" : "files"}`;
  if (size <= 20 * 1024 * 1024)
    return [
      step("POST", `${base}/upload_all`, undefined, {
        file_name: name,
        size,
        ...fields,
        file: "<binary>",
      }),
    ];
  return [
    step("POST", `${base}/upload_prepare`, undefined, {
      file_name: name,
      size,
      ...fields,
    }),
    step("POST", `${base}/upload_part`, undefined, {
      upload_id: "<upload_id>",
      seq: "<0..block_num-1>",
      file: "<binary part>",
    }),
    step("POST", `${base}/upload_finish`, undefined, {
      upload_id: "<upload_id>",
      block_num: "<block_num>",
    }),
  ];
}

async function download(ctx, url, f, query = {}, fallback) {
  if (ctx.dryRun)
    return dry(ctx, [step("GET", url, query)], {
      output: f.output ?? fallback,
    });
  const bytes = await request(ctx, "GET", url, query, undefined, {
    responseType: "buffer",
  });
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array))
    throw err("Download response was not binary data", "api");
  let target = f.output ?? fallback;
  if (target) {
    const resolved = await safeLocal(ctx, target, { output: true });
    let isDirectory = /[\\/]$/.test(target);
    try {
      isDirectory ||= (await stat(resolved)).isDirectory();
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (isDirectory)
      target = path.join(target, path.basename(fallback ?? "download.bin"));
  }
  return target
    ? writeOutput(ctx, target, bytes, bool(f, "overwrite"))
    : {
        content: Buffer.from(bytes).toString("utf8"),
        size_bytes: bytes.length,
      };
}

function textBlocks(content, format) {
  if (format === "xml") return xmlBlocks(content).blocks;
  if (format === "markdown") return markdownBlocks(content);
  if (format !== "text" && format !== "plain")
    throw err(
      "Supported content formats: xml, markdown, text, plain",
      "validation",
    );
  return String(content)
    .split(/\r?\n/)
    .map((line) => ({
      block_type: 2,
      text: { elements: [{ text_run: { content: line } }], style: {} },
    }));
}

function decodeXML(text) {
  return text.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, entity) => {
      if (entity[0] === "#") {
        const value =
          entity[1].toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        if (!Number.isInteger(value) || value < 0 || value > 0x10ffff)
          throw err("Invalid XML character entity");
        return String.fromCodePoint(value);
      }
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
        entity.toLowerCase()
      ];
    },
  );
}

function parseXML(content) {
  if (/<!DOCTYPE|<!ENTITY/i.test(content))
    throw err("XML declarations with external entities are not accepted");
  const root = { tag: "root", attrs: {}, children: [] },
    stack = [root];
  const tokens =
    String(content).match(
      /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g,
    ) ?? [];
  if (tokens.join("") !== String(content)) throw err("Malformed XML");
  for (const token of tokens) {
    if (token.startsWith("<!--")) continue;
    if (token.startsWith("<![CDATA[")) {
      stack.at(-1).children.push(token.slice(9, -3));
      continue;
    }
    if (token.startsWith("<?")) continue;
    if (!token.startsWith("<")) {
      stack.at(-1).children.push(decodeXML(token));
      continue;
    }
    const closing = /^<\/([\w:-]+)\s*>$/.exec(token);
    if (closing) {
      if (stack.length === 1 || stack.at(-1).tag !== closing[1])
        throw err(`Mismatched XML closing tag ${closing[1]}`);
      stack.pop();
      continue;
    }
    const opened = /^<([\w:-]+)([\s\S]*?)(\/?)>$/.exec(token);
    if (!opened) throw err("Malformed XML element");
    const attrs = {},
      source = opened[2];
    const attr = /\s+([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
    let consumed = "",
      m;
    while ((m = attr.exec(source))) {
      consumed += m[0];
      attrs[m[1]] = decodeXML(m[3]);
    }
    if (consumed.trim() !== source.trim())
      throw err(`Attributes on <${opened[1]}> must use quoted values`);
    const node = { tag: opened[1], attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!opened[3] && !["br", "hr", "img", "source"].includes(node.tag))
      stack.push(node);
  }
  if (stack.length !== 1) throw err(`Unclosed XML tag <${stack.at(-1).tag}>`);
  return root;
}

const textRun = (content, style = {}) => ({
  text_run: {
    content,
    ...(Object.keys(style).length ? { text_element_style: style } : {}),
  },
});
function inlineElements(children, inherited = {}) {
  const out = [];
  for (const node of children) {
    if (typeof node === "string") {
      if (node) out.push(textRun(node, inherited));
      continue;
    }
    const style = { ...inherited };
    if (node.tag === "br") {
      out.push(textRun("\n", style));
      continue;
    }
    const inline = {
      b: "bold",
      strong: "bold",
      em: "italic",
      i: "italic",
      u: "underline",
      del: "strikethrough",
      s: "strikethrough",
      code: "inline_code",
    }[node.tag];
    if (inline) style[inline] = true;
    else if (node.tag === "a") {
      if (!node.attrs.href) throw err("<a> requires href");
      style.link = { url: node.attrs.href };
    } else if (node.tag === "span") {
      const colors = {
        red: 1,
        orange: 2,
        yellow: 3,
        green: 4,
        blue: 5,
        purple: 6,
        gray: 7,
      };
      for (const [key, value] of Object.entries(node.attrs)) {
        if (!["text-color", "background-color"].includes(key) || !colors[value])
          throw err(
            `Native docx span attribute ${key}=${value} requires docs_ai`,
            "unsupported",
          );
        style[key === "text-color" ? "text_color" : "background_color"] =
          colors[value];
      }
    } else if (node.tag === "cite" && node.attrs.type === "user") {
      out.push({ mention_user: { user_id: node.attrs["user-id"] } });
      continue;
    } else
      throw err(
        `Native docx does not support inline <${node.tag}>; configure docs_ai to retain it`,
        "unsupported",
      );
    for (const key of Object.keys(node.attrs))
      if (
        !(node.tag === "a" && ["href", "type"].includes(key)) &&
        node.tag !== "span"
      )
        throw err(
          `Native docx does not support <${node.tag}> attribute ${key}`,
          "unsupported",
        );
    out.push(...inlineElements(node.children, style));
  }
  return out;
}

function xmlBlocks(content) {
  const tree = parseXML(content);
  let title;
  function convert(nodes, listType) {
    const blocks = [];
    for (const node of nodes) {
      if (typeof node === "string") {
        if (node.trim())
          blocks.push({
            block_type: 2,
            text: { elements: [textRun(node)], style: {} },
          });
        continue;
      }
      if (node.tag === "title") {
        title ??= inlineElements(node.children)
          .map((e) => e.text_run?.content ?? "")
          .join("");
        continue;
      }
      if (node.tag === "ol" || node.tag === "ul") {
        blocks.push(...convert(node.children, node.tag));
        continue;
      }
      if (node.tag === "hr") {
        blocks.push({ block_type: 22, divider: {} });
        continue;
      }
      if (node.tag === "table") {
        if (
          node.children.some(
            (n) => typeof n !== "string" && n.tag === "colgroup",
          )
        )
          throw err(
            "Explicit table column widths require docs_ai; they are not discarded by native conversion",
            "unsupported",
          );
        if (Object.keys(node.attrs).length)
          throw err("Native table attributes require docs_ai", "unsupported");
        const rowNodes = node.children
          .flatMap((n) =>
            typeof n !== "string" && ["thead", "tbody"].includes(n.tag)
              ? n.children
              : [n],
          )
          .filter((n) => typeof n !== "string" && n.tag === "tr");
        const rows = rowNodes.map((row) =>
          row.children
            .filter(
              (n) => typeof n !== "string" && ["th", "td"].includes(n.tag),
            )
            .map((cell) => {
              if (
                Object.entries(cell.attrs).some(
                  ([key, value]) =>
                    ["rowspan", "colspan"].includes(key) && value !== "1",
                )
              )
                throw err(
                  "Merged native table cells require docs_ai",
                  "unsupported",
                );
              if (
                Object.entries(cell.attrs).some(
                  ([key]) => !["rowspan", "colspan"].includes(key),
                )
              )
                throw err(
                  "Styled native table cells require docs_ai",
                  "unsupported",
                );
              return convert(cell.children);
            }),
        );
        if (
          !rows.length ||
          !rows[0].length ||
          rows.some((row) => row.length !== rows[0].length)
        )
          throw err("Table must have equally sized nonempty rows");
        blocks.push({
          block_type: 31,
          table: {
            property: { row_size: rows.length, column_size: rows[0].length },
          },
          $table: rows,
        });
        continue;
      }
      const heading = /^h([1-9])$/.exec(node.tag);
      const type = heading
        ? Number(heading[1]) + 2
        : {
            p: 2,
            li: listType === "ol" ? 13 : 12,
            blockquote: 15,
            pre: 14,
            checkbox: 17,
          }[node.tag];
      if (!type)
        throw err(
          `Native docx does not support <${node.tag}>; configure capabilities.docsAi=true rather than discarding this content`,
          "unsupported",
        );
      const key = heading
        ? `heading${heading[1]}`
        : {
            2: "text",
            12: "bullet",
            13: "ordered",
            14: "code",
            15: "quote",
            17: "todo",
          }[type];
      const style = {};
      for (const [name, value] of Object.entries(node.attrs)) {
        if (name === "align" && ["left", "center", "right"].includes(value))
          style.align = { left: 1, center: 2, right: 3 }[value];
        else if (name === "seq" && type === 13) style.sequence = value;
        else if (name === "done" && type === 17) style.done = value === "true";
        else if (name === "id") {
          /* IDs are assigned by the create API. */
        } else if (name === "seq" && heading)
          throw err(
            "Automatic heading numbering requires docs_ai",
            "unsupported",
          );
        else if (name === "lang" && type === 14)
          throw err(
            "Native code language highlighting requires docs_ai; omit lang to preserve code without a language hint",
            "unsupported",
          );
        else
          throw err(
            `Native docx does not support <${node.tag}> attribute ${name}`,
            "unsupported",
          );
      }
      let children = node.children;
      if (type === 14)
        children = node.children.flatMap((n) =>
          typeof n !== "string" && n.tag === "code" ? n.children : [n],
        );
      const nested = children.filter(
        (n) => typeof n !== "string" && ["ol", "ul"].includes(n.tag),
      );
      const elements = inlineElements(
        children.filter((n) => !nested.includes(n)),
      );
      const block = {
        block_type: type,
        [key]: { elements: elements.length ? elements : [textRun("")], style },
      };
      if (nested.length) block.$children = convert(nested);
      blocks.push(block);
    }
    return blocks;
  }
  return { blocks: convert(tree.children), title };
}

function markdownInline(text, inherited = {}) {
  const result = [];
  const expression =
    /(\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\(([^\s)]+)\)|\*([^*]+)\*|_([^_]+)_)/g;
  let from = 0,
    m;
  while ((m = expression.exec(text))) {
    if (m.index > from)
      result.push(textRun(text.slice(from, m.index), inherited));
    if (m[2] || m[3])
      result.push(
        ...markdownInline(m[2] ?? m[3], { ...inherited, bold: true }),
      );
    else if (m[4])
      result.push(textRun(m[4], { ...inherited, strikethrough: true }));
    else if (m[5])
      result.push(textRun(m[5], { ...inherited, inline_code: true }));
    else if (m[6])
      result.push(textRun(m[6], { ...inherited, link: { url: m[7] } }));
    else result.push(textRun(m[8] ?? m[9], { ...inherited, italic: true }));
    from = expression.lastIndex;
  }
  if (from < text.length || !result.length)
    result.push(textRun(text.slice(from), inherited));
  return result;
}

function markdownBlocks(content) {
  if (/!\[|^\s*</m.test(content))
    throw err(
      "Markdown images and embedded HTML require docs_ai or explicit docs +media-insert; content was not modified",
      "unsupported",
    );
  const lines = String(content).split(/\r?\n/),
    blocks = [],
    listStack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^```/.test(line)) {
      const code = [];
      const language = line.slice(3).trim();
      if (language)
        throw err(
          "Native code language highlighting requires docs_ai; omit the language hint to preserve the code block",
          "unsupported",
        );
      while (++i < lines.length && !/^```\s*$/.test(lines[i]))
        code.push(lines[i]);
      if (i >= lines.length) throw err("Unclosed Markdown code fence");
      blocks.push({
        block_type: 14,
        code: { elements: [textRun(code.join("\n"))], style: {} },
      });
      continue;
    }
    if (
      /^\s*\|/.test(line) &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? "")
    ) {
      const split = (s) =>
        s
          .trim()
          .replace(/^\||\|$/g, "")
          .split(/(?<!\\)\|/)
          .map((x) => x.trim().replaceAll("\\|", "|"));
      const rows = [split(line)];
      i++;
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1]))
        rows.push(split(lines[++i]));
      if (rows.some((row) => row.length !== rows[0].length))
        throw err("Markdown table rows have different column counts");
      blocks.push({
        block_type: 31,
        table: {
          property: { row_size: rows.length, column_size: rows[0].length },
        },
        $table: rows.map((row) =>
          row.map((cell) => [
            {
              block_type: 2,
              text: { elements: markdownInline(cell), style: {} },
            },
          ]),
        ),
      });
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ block_type: 22, divider: {} });
      continue;
    }
    const heading = /^(#{1,9})\s+(.*)$/.exec(line),
      bullet = /^\s*[-*+]\s+(.*)$/.exec(line),
      ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line),
      quote = /^>\s?(.*)$/.exec(line);
    const type = heading
      ? heading[1].length + 2
      : bullet
        ? 12
        : ordered
          ? 13
          : quote
            ? 15
            : 2;
    const key = heading
      ? `heading${heading[1].length}`
      : { 2: "text", 12: "bullet", 13: "ordered", 15: "quote" }[type];
    const text =
      heading?.[2] ?? bullet?.[1] ?? ordered?.[1] ?? quote?.[1] ?? line;
    const block = {
      block_type: type,
      [key]: { elements: markdownInline(text), style: {} },
    };
    if (bullet || ordered) {
      const indent = /^\s*/.exec(line)[0].replaceAll("\t", "    ").length;
      while (listStack.length && listStack.at(-1).indent >= indent)
        listStack.pop();
      if (listStack.length) {
        listStack.at(-1).block.$children ??= [];
        listStack.at(-1).block.$children.push(block);
      } else blocks.push(block);
      listStack.push({ indent, block });
    } else {
      listStack.length = 0;
      blocks.push(block);
    }
  }
  return blocks;
}

function blockText(block) {
  const value =
    block.text ??
    Object.entries(block).find(
      ([key, v]) => key.startsWith("heading") && v?.elements,
    )?.[1] ??
    block.bullet ??
    block.ordered ??
    block.code ??
    block.quote;
  return (value?.elements ?? [])
    .map((e) => e.text_run?.content ?? e.mention_user?.user_id ?? "")
    .join("");
}

function inlineXML(elements) {
  return (elements ?? [])
    .map((e) => {
      if (e.mention_user)
        return `<cite type="user" user-id="${xml(e.mention_user.user_id)}"/>`;
      if (!e.text_run)
        throw err(
          "Document contains unsupported inline entities; use --blocks for lossless native JSON",
          "unsupported",
        );
      let value = xml(e.text_run.content).replaceAll("\n", "<br/>");
      const style = e.text_run.text_element_style ?? {};
      for (const [key, tag] of [
        ["bold", "b"],
        ["italic", "em"],
        ["underline", "u"],
        ["strikethrough", "del"],
        ["inline_code", "code"],
      ])
        if (style[key]) value = `<${tag}>${value}</${tag}>`;
      if (style.link?.url)
        value = `<a href="${xml(style.link.url)}">${value}</a>`;
      const colors = {
        1: "red",
        2: "orange",
        3: "yellow",
        4: "green",
        5: "blue",
        6: "purple",
        7: "gray",
      };
      const attrs = [
        style.text_color
          ? `text-color="${colors[style.text_color] ?? style.text_color}"`
          : "",
        style.background_color
          ? `background-color="${colors[style.background_color] ?? style.background_color}"`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      if (attrs) value = `<span ${attrs}>${value}</span>`;
      return value;
    })
    .join("");
}

function nativeExport(items, token, f) {
  const map = new Map(items.map((b) => [b.block_id, b]));
  const visited = new Set();
  function render(block) {
    if (!block || visited.has(block.block_id)) return "";
    visited.add(block.block_id);
    const type = block.block_type,
      id =
        f.detail === "full" || f.detail === "with-ids"
          ? ` id="${xml(block.block_id)}"`
          : "";
    const childContent = () =>
      (block.children ?? [])
        .map((child) =>
          render(map.get(typeof child === "string" ? child : child.block_id)),
        )
        .join("");
    if (type === 1) return childContent();
    if (type === 22) return "<hr/>";
    if (type === 32) return childContent();
    if (type === 31) {
      const cells = block.children ?? [],
        cols = block.table?.property?.column_size;
      if (!cols)
        throw err(
          "Table has no column_size; use --blocks for native JSON",
          "api",
        );
      const rows = [];
      for (let i = 0; i < cells.length; i += cols)
        rows.push(
          `<tr>${cells
            .slice(i, i + cols)
            .map(
              (cell) =>
                `<td>${render(map.get(typeof cell === "string" ? cell : cell.block_id))}</td>`,
            )
            .join("")}</tr>`,
        );
      return `<table${id}><tbody>${rows.join("")}</tbody></table>`;
    }
    if (type === 27)
      return `<img src="${xml(block.image?.token ?? "")}"${id}${block.image?.width ? ` width="${block.image.width}"` : ""}${block.image?.height ? ` height="${block.image.height}"` : ""}/>`;
    if (type === 23)
      return `<source token="${xml(block.file?.token ?? "")}"${id} name="${xml(block.file?.name ?? "")}"/>`;
    const heading = type >= 3 && type <= 11 ? type - 2 : undefined;
    const key = heading
      ? `heading${heading}`
      : {
          2: "text",
          12: "bullet",
          13: "ordered",
          14: "code",
          15: "quote",
          17: "todo",
        }[type];
    if (!key || !block[key])
      throw err(
        `Native export cannot retain block_type ${type}; use --blocks or configure docs_ai`,
        "unsupported",
        { block_id: block.block_id },
      );
    const children = childContent();
    const value = block[key];
    const content = inlineXML(value.elements);
    const align = { 1: "left", 2: "center", 3: "right" }[value.style?.align];
    const attrs = `${id}${align ? ` align="${align}"` : ""}`;
    if (type === 12 || type === 13)
      return `<${type === 12 ? "ul" : "ol"}><li${attrs}>${content}${children}</li></${type === 12 ? "ul" : "ol"}>`;
    if (type === 14) return `<pre${attrs}><code>${content}</code></pre>`;
    const tag = heading
      ? `h${heading}`
      : type === 15
        ? "blockquote"
        : type === 17
          ? "checkbox"
          : "p";
    return `<${tag}${attrs}${type === 17 ? ` done="${!!value.style?.done}"` : ""}>${content}${children}</${tag}>`;
  }
  let selected = items.filter(
    (b) => b.parent_id === token || (!b.parent_id && b.block_id !== token),
  );
  const root = map.get(token);
  if (root?.children)
    selected = root.children.map((id) => map.get(id)).filter(Boolean);
  const mode = f.scope ?? "full";
  if (mode === "outline")
    selected = items.filter(
      (b) =>
        b.block_type >= 3 &&
        b.block_type <= Math.min(11, number(f, "max-depth", 9, 1, 9) + 2),
    );
  else if (mode === "keyword") {
    required(f, "keyword");
    const terms = String(f.keyword).toLocaleLowerCase().split("|");
    selected = items.filter((b) =>
      terms.some((term) => blockText(b).toLocaleLowerCase().includes(term)),
    );
  } else if (mode === "range" || mode === "section") {
    const start = selected.findIndex(
      (b) => b.block_id === required(f, "start-block-id"),
    );
    if (start < 0)
      throw err("--start-block-id was not found among top-level blocks");
    let end =
      f["end-block-id"] && f["end-block-id"] !== "-1"
        ? selected.findIndex((b) => b.block_id === f["end-block-id"]) + 1
        : selected.length;
    if (mode === "section") {
      const next = selected.findIndex(
        (b, i) =>
          i > start &&
          b.block_type >= 3 &&
          b.block_type <= selected[start].block_type,
      );
      if (next >= 0) end = next;
    }
    if (end <= start) throw err("--end-block-id must follow --start-block-id");
    selected = selected.slice(start, end);
  } else if (mode !== "full")
    throw err("--scope must be full, outline, keyword, section, or range");
  // Render children lazily; visiting them before the table/parent would drop
  // them when its actual container renders them.
  visited.clear();
  const content = selected.map(render).join("");
  if (f["doc-format"] === "markdown")
    return {
      document: { document_id: token, content: nativeMarkdown(selected, map) },
      blocks: items,
    };
  return { document: { document_id: token, content }, blocks: items };
}

function nativeMarkdown(blocks, map) {
  const lines = [];
  for (const block of blocks) {
    const type = block.block_type;
    const heading = type >= 3 && type <= 11 ? type - 2 : undefined;
    const key = heading
      ? `heading${heading}`
      : {
          2: "text",
          12: "bullet",
          13: "ordered",
          14: "code",
          15: "quote",
          17: "todo",
        }[type];
    let text = (block[key]?.elements ?? [])
      .map((e) => {
        if (!e.text_run)
          throw err(
            "Markdown export cannot retain inline entities; use XML or --blocks",
            "unsupported",
          );
        let t = e.text_run.content;
        const s = e.text_run.text_element_style ?? {};
        if (s.text_color || s.background_color || s.underline)
          throw err(
            "Markdown cannot retain text colors/underline; use XML or --blocks",
            "unsupported",
          );
        if (s.inline_code) t = `\`${t}\``;
        if (s.bold) t = `**${t}**`;
        if (s.italic) t = `*${t}*`;
        if (s.strikethrough) t = `~~${t}~~`;
        if (s.link) t = `[${t}](${s.link.url})`;
        return t;
      })
      .join("");
    if (heading) text = `${"#".repeat(heading)} ${text}`;
    else if (type === 12) text = `- ${text}`;
    else if (type === 13) text = `1. ${text}`;
    else if (type === 14) text = `\`\`\`\n${text}\n\`\`\``;
    else if (type === 15) text = `> ${text}`;
    else if (type === 17)
      text = `- [${block.todo?.style?.done ? "x" : " "}] ${text}`;
    else if (type === 22) text = "---";
    else if (type === 31) {
      const cells = block.children ?? [],
        cols = block.table?.property?.column_size;
      if (!cols) throw err("Table column size is unavailable", "api");
      const rows = [];
      for (let i = 0; i < cells.length; i += cols) {
        rows.push(
          "| " +
            cells
              .slice(i, i + cols)
              .map((id) =>
                nativeMarkdown(
                  (map.get(id)?.children ?? [])
                    .map((id) => map.get(id))
                    .filter(Boolean),
                  map,
                )
                  .replaceAll("\n", "<br>")
                  .replaceAll("|", "\\|"),
              )
              .join(" | ") +
            " |",
        );
        if (i === 0)
          rows.push("| " + Array(cols).fill("---").join(" | ") + " |");
      }
      text = rows.join("\n");
    } else if (type === 27)
      text = `![image](lark-media:${block.image?.token ?? ""})`;
    else if (type === 23)
      text = `[${block.file?.name ?? "file"}](lark-media:${block.file?.token ?? ""})`;
    else if (!key)
      throw err(
        `Markdown export cannot retain block_type ${type}; use --blocks`,
        "unsupported",
      );
    lines.push(text);
    if ([12, 13].includes(type) && block.children?.length)
      lines.push(
        nativeMarkdown(
          block.children.map((id) => map.get(id)).filter(Boolean),
          map,
        )
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
      );
  }
  return lines.join("\n\n");
}

async function appendBlocks(ctx, token, blocks, f = {}) {
  const responses = [];
  for (let i = 0; i < blocks.length; i += 50) {
    const part = blocks.slice(i, i + 50);
    const payload = part.map(({ $children, $table, ...block }) => block);
    const insertion =
      f["insert-index"] === undefined || f["insert-index"] < 0
        ? -1
        : Number(f["insert-index"]) + i;
    const response = await request(
      ctx,
      "POST",
      `/open-apis/docx/v1/documents/${enc(token)}/blocks/${enc(f["block-id"] ?? token)}/children`,
      { document_revision_id: i === 0 ? number(f, "revision-id", -1, -1) : -1 },
      { children: payload, index: insertion },
    );
    responses.push(response);
    for (let n = 0; n < part.length; n++) {
      const plan = part[n],
        created = response.children?.[n];
      if (plan.$children?.length) {
        if (!created?.block_id)
          throw err("Nested block creation returned no block_id", "api");
        await appendBlocks(ctx, token, plan.$children, {
          "block-id": created.block_id,
        });
      }
      if (plan.$table) {
        if (
          !created?.children ||
          created.children.length !== plan.$table.flat().length
        )
          throw err("Table creation returned an unexpected cell list", "api");
        for (const [index, cell] of plan.$table.flat().entries()) {
          const cellID =
            typeof created.children[index] === "string"
              ? created.children[index]
              : created.children[index].block_id;
          await appendBlocks(ctx, token, cell, { "block-id": cellID });
        }
      }
    }
  }
  return responses;
}

async function nativeLocation(ctx, token, f, append = false) {
  const base = `/open-apis/docx/v1/documents/${enc(token)}/blocks`;
  const start =
    f["start-block-id"] ?? f["block-id"] ?? (append ? "-1" : undefined);
  if (start === undefined)
    throw err("--block-id or --start-block-id/--end-block-id is required");
  let parent = token,
    first;
  if (!["0", "-1"].includes(String(start))) {
    const block = (await request(ctx, "GET", `${base}/${enc(start)}`)).block;
    if (!block?.parent_id || block.block_id === token)
      throw err("Target must be a non-root document block");
    parent = block.parent_id;
    first = block.block_id;
  }
  const root = (await request(ctx, "GET", `${base}/${enc(parent)}`)).block;
  if (!Array.isArray(root?.children))
    throw err("Parent block returned no children", "api");
  const index = first
    ? root.children.indexOf(first)
    : start === "0"
      ? 0
      : root.children.length;
  if (index < 0)
    throw err("Target block is absent from the parent children list", "api");
  let end = index + 1;
  if (f["end-block-id"]) {
    end =
      f["end-block-id"] === "-1"
        ? root.children.length
        : root.children.indexOf(f["end-block-id"]) + 1;
    if (end <= index)
      throw err("Range must contain consecutive blocks under the same parent");
  }
  return {
    parent,
    index,
    end,
    children: root.children,
    sentinel: ["0", "-1"].includes(String(start)),
  };
}

function replaceElements(elements, pattern, replacement) {
  const original = elements
    .map((e) => e.text_run?.content ?? "\uFFFC")
    .join("");
  if (!original.includes(pattern)) return undefined;
  const spans = [];
  let offset = 0;
  for (const element of elements) {
    const length = element.text_run?.content?.length ?? 1;
    spans.push({ start: offset, end: offset + length, element });
    offset += length;
  }
  const result = [];
  const copy = (start, end) => {
    for (const span of spans) {
      const a = Math.max(start, span.start),
        b = Math.min(end, span.end);
      if (a >= b) continue;
      if (span.element.text_run)
        result.push({
          text_run: {
            ...span.element.text_run,
            content: span.element.text_run.content.slice(
              a - span.start,
              b - span.start,
            ),
          },
        });
      else result.push(structuredClone(span.element));
    }
  };
  let from = 0,
    found;
  while ((found = original.indexOf(pattern, from)) >= 0) {
    if (original.slice(found, found + pattern.length).includes("\uFFFC"))
      throw err(
        "Replacement crosses an inline resource; use docs_ai or an explicit native block edit",
        "unsupported",
      );
    copy(from, found);
    const first = spans.find((span) => span.start <= found && span.end > found);
    if (replacement)
      result.push(
        textRun(replacement, first?.element.text_run?.text_element_style ?? {}),
      );
    from = found + pattern.length;
  }
  copy(from, original.length);
  return result.length ? result : [textRun("")];
}

function nativePreview(token, blocks, f = {}, parent = token) {
  const requests = [];
  for (let i = 0; i < blocks.length; i += 50) {
    const part = blocks.slice(i, i + 50);
    requests.push(
      step(
        "POST",
        `/open-apis/docx/v1/documents/${token}/blocks/${parent}/children`,
        {
          document_revision_id: i === 0 ? number(f, "revision-id", -1, -1) : -1,
        },
        {
          children: part.map(({ $children, $table, ...block }) => block),
          index: f["insert-index"] === undefined ? -1 : f["insert-index"],
        },
      ),
    );
    for (const [index, block] of part.entries()) {
      if (block.$children)
        requests.push(
          ...nativePreview(
            token,
            block.$children,
            {},
            `<created_block_${i + index}>`,
          ),
        );
      if (block.$table)
        for (const [cell, children] of block.$table.flat().entries())
          requests.push(
            ...nativePreview(
              token,
              children,
              {},
              `<table_${i + index}_cell_${cell}>`,
            ),
          );
    }
  }
  return requests;
}

function docBackend(ctx, f) {
  if (ctx.config?.brand === "gjgw" && ctx.config?.docsBackend !== "docs-ai")
    return "native";
  if (f["api-version"] === "v2") return "ai";
  const saas =
    ["feishu", "lark"].includes(ctx.config?.brand) ||
    ctx.config?.docsBackend === "mcp";
  const provided = ctx.providedFlags || new Set(Object.keys(f));
  if (
    saas &&
    (f.content !== undefined ||
      [
        "parent-token",
        "parent-position",
        "command",
        "pattern",
        "block-id",
        "src-block-ids",
        "detail",
        "doc-format",
        "scope",
        "revision-id",
        "start-block-id",
        "end-block-id",
        "keyword",
        "context-before",
        "context-after",
        "max-depth",
      ].some((key) => provided.has(key)))
  )
    return "ai";

  if (
    ctx.config?.capabilities?.docsAi === true ||
    ctx.config?.docsBackend === "docs-ai"
  )
    return "ai";
  if (ctx.config?.docsBackend === "mcp" && f["api-version"] !== "v2")
    return "mcp";
  return "native";
}

async function callMCP(ctx, name, args) {
  if (!ctx.config?.mcpUrl)
    throw err(
      "Configure mcpUrl for the selected MCP document backend",
      "config",
    );
  if (ctx.dryRun)
    return dry(ctx, [
      step("POST", ctx.config.mcpUrl, undefined, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    ]);
  const data = await request(
    ctx,
    "POST",
    ctx.config.mcpUrl,
    undefined,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    { mcp: true },
  );
  if (data.error || data.result?.isError || data.isError)
    throw err(
      `Document MCP tool ${name} failed`,
      "api",
      data.error ?? data.result ?? data,
    );
  const result = data.result ?? data;
  if (result.structuredContent) return result.structuredContent;
  const texts = (result.content ?? [])
    .filter((x) => x.type === "text")
    .map((x) => x.text);
  if (texts.length === 1) {
    try {
      return JSON.parse(texts[0]);
    } catch {
      /* preserve text */
    }
  }
  return result;
}

async function docs(ctx, command, f) {
  if (command === "+whiteboard-update") return board(ctx, "+update", f);
  if (command === "+search") {
    const filter = await json(ctx, f.filter, "--filter");
    const body = {
      query: f.query ?? "",
      page_size: number(f, "page-size", 15, 1, 20),
      doc_filter: {},
      wiki_filter: {},
      ...filter,
    };
    if (f["page-token"]) body.page_token = f["page-token"];
    return pages(
      ctx,
      "POST",
      "/open-apis/search/v2/doc_wiki/search",
      { body },
      "res_units",
    );
  }
  const backend = docBackend(ctx, f);
  if (command === "+create") {
    const content = await input(ctx, f.content ?? f.markdown ?? "");
    if (backend === "mcp")
      return callMCP(
        ctx,
        "create-doc",
        clean({
          markdown: content,
          title: f.title,
          folder_token: f["folder-token"],
          wiki_node: f["wiki-node"],
          wiki_space: f["wiki-space"],
        }),
      );
    if (backend === "ai") {
      if (!content) throw err("--content is required");
      const body = clean({
        format: f["doc-format"] ?? "xml",
        content: f.title ? `<title>${xml(f.title)}</title>${content}` : content,
        parent_token: f["parent-token"] ?? f["folder-token"],
        parent_position: f["parent-position"],
      });
      return ctx.dryRun
        ? dry(ctx, [
            step("POST", "/open-apis/docs_ai/v1/documents", undefined, body),
          ])
        : request(
            ctx,
            "POST",
            "/open-apis/docs_ai/v1/documents",
            undefined,
            body,
          );
    }
    const format =
      f.markdown !== undefined ? "markdown" : (f["doc-format"] ?? "text");
    const title =
      f.title ??
      (format === "xml" && content ? xmlBlocks(content).title : undefined);
    if (!title)
      throw err("--title is required, or include <title> in XML content");
    const blocks = f.blocks
      ? await json(ctx, f.blocks, "--blocks")
      : content
        ? textBlocks(content, format)
        : [];
    if (!Array.isArray(blocks)) throw err("--blocks must contain a JSON array");
    const body = clean({
      title,
      folder_token: f["folder-token"] ?? f["parent-token"],
    });
    const requests = [
      step("POST", "/open-apis/docx/v1/documents", undefined, body),
    ];
    requests.push(...nativePreview("<document_id>", blocks));
    if (ctx.dryRun) return dry(ctx, requests);
    const result = await request(
      ctx,
      "POST",
      "/open-apis/docx/v1/documents",
      undefined,
      body,
    );
    const doc = result.document;
    if (!doc?.document_id)
      throw err("Document create returned no document_id", "api");
    doc.url ??= resourceURL(ctx, "docx", doc.document_id);
    if (blocks.length) {
      try {
        await appendBlocks(ctx, doc.document_id, blocks);
      } catch (e) {
        throw err(
          "Document was created, but body insertion failed. Inspect the returned document before retrying",
          "partial_failure",
          { document: doc, body_insert_error: e.message },
        );
      }
    }
    return result;
  }
  if (command === "+fetch" || command === "+update") {
    const ref = await resolveRef(ctx, required(f, "doc"));
    const token = ref.token;
    if (backend === "mcp") {
      if (command === "+fetch")
        return callMCP(
          ctx,
          "fetch-doc",
          clean({
            doc_id: f.doc,
            skip_task_detail: true,
            offset: f.offset,
            limit: f.limit,
          }),
        );
      const content = await input(ctx, f.markdown ?? f.content ?? "");
      return callMCP(
        ctx,
        "update-doc",
        clean({
          doc_id: f.doc,
          mode: required(f, "mode"),
          markdown: content,
          selection_with_ellipsis: f["selection-with-ellipsis"],
          selection_by_title: f["selection-by-title"],
          new_title: f["new-title"],
        }),
      );
    }
    if (backend === "ai") {
      const body = { format: f["doc-format"] ?? "xml" };
      if (command === "+fetch") {
        const detail = f.detail ?? "simple";
        body.export_option = {
          export_block_id: detail !== "simple",
          export_style_attrs: detail === "full",
          export_cite_extra_data: detail === "full",
        };
        if (f.scope && f.scope !== "full")
          body.read_option = clean({
            read_mode: f.scope,
            start_block_id: f["start-block-id"],
            end_block_id: f["end-block-id"],
            keyword: f.keyword,
            context_before: f["context-before"],
            context_after: f["context-after"],
            max_depth: f["max-depth"],
          });
        if (f["revision-id"] !== undefined)
          body.revision_id = Number(f["revision-id"]);
        const s = step(
          "POST",
          `/open-apis/docs_ai/v1/documents/${enc(token)}/fetch`,
          undefined,
          body,
        );
        if (ctx.dryRun)
          return dry(ctx, [
            ...(ref.resolveRequest ? [ref.resolveRequest] : []),
            s,
          ]);
        return request(ctx, s.method, s.path, s.query, s.body);
      }
      body.command = required(f, "command");
      for (const k of [
        "pattern",
        "block-id",
        "src-block-ids",
        "revision-id",
        "start-block-id",
        "end-block-id",
      ])
        if (has(f, k)) body[k.replaceAll("-", "_")] = f[k];
      if (has(f, "content")) body.content = await input(ctx, f.content);
      if (body.command === "append") {
        body.command = "block_insert_after";
        body.block_id = "-1";
      }
      const s = step(
        "PUT",
        `/open-apis/docs_ai/v1/documents/${enc(token)}`,
        undefined,
        body,
      );
      if (ctx.dryRun)
        return dry(ctx, [
          ...(ref.resolveRequest ? [ref.resolveRequest] : []),
          s,
        ]);
      return request(ctx, s.method, s.path, s.query, s.body);
    }
    const base = `/open-apis/docx/v1/documents/${enc(token)}`;
    if (command === "+fetch") {
      const rich =
        !f.blocks &&
        (["xml", "markdown"].includes(f["doc-format"]) ||
          f.detail === "full" ||
          f.detail === "with-ids" ||
          (f.scope && f.scope !== "full"));
      const url = `${base}/${f.blocks || rich ? "blocks" : "raw_content"}`;
      const query = clean({
        page_size: f["page-size"] ? Number(f["page-size"]) : undefined,
        page_token: f["page-token"],
        document_revision_id: f["revision-id"],
      });
      if (ctx.dryRun)
        return dry(ctx, [
          ...(ref.resolveRequest ? [ref.resolveRequest] : []),
          step("GET", url, query),
        ]);
      const data = await pages(
        rich
          ? {
              ...ctx,
              flags: { ...ctx.flags, "page-all": true, "page-limit": 0 },
            }
          : ctx,
        "GET",
        url,
        { query },
      );
      return rich ? nativeExport(data.items ?? [], token, f) : data;
    }
    const op = f.command ?? f.mode ?? "append";
    if (op === "str_replace" || op === "replace_all") {
      const pattern = required(f, "pattern");
      const replacement = await input(ctx, f.content ?? f.markdown ?? "");
      const url = `${base}/blocks`;
      if (ctx.dryRun)
        return dry(ctx, [
          step("GET", url, { page_size: 500 }),
          step("PATCH", `${base}/blocks/batch_update`, undefined, {
            requests:
              "<matched blocks with formatting-preserving text replacement>",
            pattern,
            replacement,
          }),
        ]);
      const data = await pages(
        { ...ctx, flags: { ...ctx.flags, "page-all": true, "page-limit": 0 } },
        "GET",
        url,
        { query: { page_size: 500 } },
      );
      const updates = [];
      for (const block of data.items ?? []) {
        const value =
          block.text ??
          Object.entries(block).find(
            ([key, v]) => /^heading\d$/.test(key) && v.elements,
          )?.[1] ??
          block.bullet ??
          block.ordered ??
          block.quote;
        if (
          !value?.elements ||
          (f["block-id"] && block.block_id !== f["block-id"])
        )
          continue;
        const elements = replaceElements(
          value.elements,
          String(pattern),
          String(replacement),
        );
        if (elements)
          updates.push({
            block_id: block.block_id,
            update_text_elements: { elements },
          });
      }
      if (!updates.length)
        throw err(
          "Pattern did not match any supported text blocks; no changes were made",
        );
      const results = [];
      for (let i = 0; i < updates.length; i += 200)
        results.push(
          await request(
            ctx,
            "PATCH",
            `${base}/blocks/batch_update`,
            { document_revision_id: i ? -1 : number(f, "revision-id", -1, -1) },
            { requests: updates.slice(i, i + 200) },
          ),
        );
      return {
        document_id: token,
        updated_blocks_count: updates.length,
        results,
      };
    }
    if (
      [
        "append",
        "block_insert_after",
        "block_replace",
        "overwrite",
        "replace_range",
        "insert_before",
        "insert_after",
        "delete_range",
      ].includes(op)
    ) {
      if (op === "block_insert_after" && !f["block-id"])
        throw err("--block-id is required");
      const content = await input(ctx, f.content ?? f.markdown ?? "");
      const blocks = f.blocks
        ? await json(ctx, f.blocks, "--blocks")
        : textBlocks(
            content,
            f.markdown !== undefined ? "markdown" : (f["doc-format"] ?? "text"),
          );
      if (!Array.isArray(blocks)) throw err("--blocks must be a JSON array");
      if (
        [
          "replace_range",
          "insert_before",
          "insert_after",
          "delete_range",
        ].includes(op) &&
        !f["block-id"]
      )
        throw err(
          `${op} on native docx requires --block-id; text locators require docs_ai or MCP`,
          "unsupported",
        );
      if (ctx.dryRun) {
        const previews = [...(ref.resolveRequest ? [ref.resolveRequest] : [])];
        if (op !== "append")
          previews.push(step("GET", `${base}/blocks/<target_or_parent>`));
        if (
          [
            "overwrite",
            "block_replace",
            "replace_range",
            "delete_range",
          ].includes(op)
        )
          previews.push(
            step(
              "DELETE",
              `${base}/blocks/<parent>/children/batch_delete`,
              undefined,
              { start_index: "<resolved_start>", end_index: "<resolved_end>" },
            ),
          );
        if (op !== "delete_range")
          previews.push(
            ...nativePreview(
              token,
              blocks,
              op === "append"
                ? f
                : { ...f, "insert-index": "<resolved_index>" },
              op === "append" ? token : "<resolved_parent>",
            ),
          );
        return dry(ctx, previews);
      }
      const operationFlags =
        op === "overwrite"
          ? { ...f, "start-block-id": "0", "end-block-id": "-1" }
          : f;
      const location =
        op === "append"
          ? { parent: token, index: -1 }
          : await nativeLocation(ctx, token, operationFlags);
      const deleting = [
        "overwrite",
        "block_replace",
        "replace_range",
        "delete_range",
      ].includes(op);
      if (deleting && location.end > location.index)
        await request(
          ctx,
          "DELETE",
          `${base}/blocks/${enc(location.parent)}/children/batch_delete`,
          { document_revision_id: number(f, "revision-id", -1, -1) },
          { start_index: location.index, end_index: location.end },
        );
      const index =
        location.index < 0
          ? -1
          : location.index +
            (!deleting && op !== "insert_before" && !location.sentinel ? 1 : 0);
      if (op === "delete_range")
        return {
          document_id: token,
          deleted_blocks_count: location.end - location.index,
        };
      try {
        return {
          document_id: token,
          responses: await appendBlocks(ctx, token, blocks, {
            "block-id": location.parent,
            "insert-index": index,
            "revision-id": deleting ? -1 : f["revision-id"],
          }),
        };
      } catch (e) {
        throw err(
          "Document update partially failed. Inspect the document before retrying",
          "partial_failure",
          {
            document_id: token,
            previous_blocks_deleted: deleting,
            cause: e.message,
          },
        );
      }
    }
    if (op === "block_delete") {
      if (ctx.dryRun)
        return dry(ctx, [
          step("GET", `${base}/blocks/<target_or_parent>`),
          step(
            "DELETE",
            `${base}/blocks/<parent>/children/batch_delete`,
            undefined,
            { start_index: "<resolved_start>", end_index: "<resolved_end>" },
          ),
        ]);
      const location = await nativeLocation(ctx, token, f);
      return request(
        ctx,
        "DELETE",
        `${base}/blocks/${enc(location.parent)}/children/batch_delete`,
        { document_revision_id: number(f, "revision-id", -1, -1) },
        { start_index: location.index, end_index: location.end },
      );
    }
    throw err(
      `Document operation ${op} requires docs_ai or the MCP backend; it is not approximated using destructive docx/v1 edits`,
      "unsupported",
    );
  }
  if (
    [
      "+media-download",
      "+media-preview",
      "+media-upload",
      "+media-insert",
    ].includes(command)
  ) {
    return documentMedia(ctx, command, f);
  }
  return undefined;
}

async function documentMedia(ctx, command, f) {
  if (command === "+media-download") {
    required(f, "output");
    return download(
      ctx,
      f.type === "whiteboard"
        ? `/open-apis/board/v1/whiteboards/${enc(required(f, "token"))}/download_as_image`
        : `/open-apis/drive/v1/medias/${enc(required(f, "token"))}/download`,
      f,
      {},
      `${f.token}.${f.type === "whiteboard" ? "png" : "bin"}`,
    );
  }
  if (command === "+media-preview") {
    required(f, "output");
    return download(
      ctx,
      `/open-apis/drive/v1/medias/${enc(required(f, "token"))}/preview_download`,
      f,
      { preview_type: "16" },
      `${f.token}.bin`,
    );
  }
  const fromClipboard = bool(f, "from-clipboard");
  if (fromClipboard && f.file)
    throw err("--file and --from-clipboard are mutually exclusive");
  const filename = fromClipboard
    ? "clipboard.png"
    : await safeLocal(ctx, required(f, "file"));
  const bytes = fromClipboard
    ? await (ctx.clipboardImage ? ctx.clipboardImage() : readClipboardImage())
    : await readFile(filename);
  const name = path.basename(filename);
  if (command === "+media-upload") {
    const fields = clean({
      parent_type: required(f, "parent-type"),
      parent_node: required(f, "parent-node"),
      extra: f["doc-id"]
        ? JSON.stringify({ drive_route_token: f["doc-id"] })
        : undefined,
    });
    return ctx.dryRun
      ? dry(ctx, uploadPreview(name, bytes.length, fields, true))
      : uploadBytes(ctx, bytes, name, fields, true);
  }
  const ref = await resolveRef(ctx, required(f, "doc"));
  if (ref.type !== "docx")
    throw err("Media insertion requires a docx document");
  const type = f.type ?? "image";
  if (!["image", "file"].includes(type))
    throw err("--type must be image or file");
  const child =
    type === "image"
      ? { block_type: 27, image: {} }
      : {
          block_type: 23,
          file: {
            view_type: { card: 1, preview: 2, inline: 3 }[
              f["file-view"] ?? "card"
            ],
          },
        };
  if (type === "file" && !child.file.view_type)
    throw err("--file-view must be card, preview, or inline");
  const base = `/open-apis/docx/v1/documents/${enc(ref.token)}`;
  const fields = {
    parent_type: type === "file" ? "docx_file" : "docx_image",
    parent_node: "<new_block_id>",
    extra: JSON.stringify({ drive_route_token: ref.token }),
  };
  const replace =
    type === "file"
      ? { replace_file: { token: "<file_token>" } }
      : {
          replace_image: clean({
            token: "<file_token>",
            align: { left: 1, center: 2, right: 3 }[f.align],
            caption: f.caption ? { content: f.caption } : undefined,
            width: f.width
              ? number(f, "width", undefined, 1, 10000)
              : undefined,
            height: f.height
              ? number(f, "height", undefined, 1, 10000)
              : undefined,
          }),
        };
  if (bool(f, "before") && !f["selection-with-ellipsis"])
    throw err("--before requires --selection-with-ellipsis");
  if (ctx.dryRun)
    return dry(ctx, [
      ...(ref.resolveRequest ? [ref.resolveRequest] : []),
      step("GET", `${base}/blocks/${enc(ref.token)}`),
      ...(f["selection-with-ellipsis"]
        ? [step("GET", `${base}/blocks`, { page_size: 500 })]
        : []),
      step("POST", `${base}/blocks/${enc(ref.token)}/children`, undefined, {
        children: [child],
        index: "<resolved_index>",
      }),
      ...uploadPreview(name, bytes.length, fields, true),
      step("PATCH", `${base}/blocks/batch_update`, undefined, {
        requests: [{ block_id: "<new_block_id>", ...replace }],
      }),
    ]);
  const root = (await request(ctx, "GET", `${base}/blocks/${enc(ref.token)}`))
    .block;
  if (!root?.children)
    throw err("Document root block has no children list", "api");
  let index = root.children.length;
  if (f["selection-with-ellipsis"]) {
    const data = await pages(
      { ...ctx, flags: { ...ctx.flags, "page-all": true, "page-limit": 0 } },
      "GET",
      `${base}/blocks`,
      { query: { page_size: 500 } },
    );
    const blocks = data.items ?? [];
    const map = new Map(blocks.map((b) => [b.block_id, b]));
    const selection = f["selection-with-ellipsis"];
    const match = (text) =>
      selection.includes("...")
        ? text.includes(selection.split("...")[0]) &&
          text.includes(selection.split("...").at(-1))
        : text.includes(selection);
    const matches = blocks.filter((b) => match(blockText(b)));
    if (matches.length !== 1)
      throw err(
        `Selection matched ${matches.length} blocks; provide a unique selection`,
      );
    let anchor = matches[0];
    const visited = new Set();
    while (anchor.parent_id !== ref.token && map.has(anchor.parent_id)) {
      if (visited.has(anchor.block_id))
        throw err("Document block parent cycle", "api");
      visited.add(anchor.block_id);
      anchor = map.get(anchor.parent_id);
    }
    index = root.children.indexOf(anchor.block_id);
    if (index < 0)
      throw err("Could not resolve selection to a top-level block", "api");
    if (!bool(f, "before")) index++;
  }
  const created = await request(
    ctx,
    "POST",
    `${base}/blocks/${enc(ref.token)}/children`,
    undefined,
    { children: [child], index },
  );
  const block = created.children?.[0];
  if (!block?.block_id)
    throw err("Media block creation returned no block_id", "api");
  const target =
    type === "file" ? (block.children?.[0] ?? block.block_id) : block.block_id;
  try {
    fields.parent_node = target;
    const uploaded = await uploadBytes(ctx, bytes, name, fields, true);
    if (!uploaded.file_token)
      throw err("Media upload returned no file_token", "api");
    if (type === "file") replace.replace_file.token = uploaded.file_token;
    else replace.replace_image.token = uploaded.file_token;
    await request(ctx, "PATCH", `${base}/blocks/batch_update`, undefined, {
      requests: [{ block_id: target, ...replace }],
    });
    return {
      document_id: ref.token,
      block_id: block.block_id,
      file_token: uploaded.file_token,
    };
  } catch (e) {
    let rolledBack = false;
    try {
      const current = (
        await request(ctx, "GET", `${base}/blocks/${enc(ref.token)}`)
      ).block;
      const position = current?.children?.indexOf(block.block_id) ?? -1;
      if (position >= 0) {
        await request(
          ctx,
          "DELETE",
          `${base}/blocks/${enc(ref.token)}/children/batch_delete`,
          undefined,
          { start_index: position, end_index: position + 1 },
        );
        rolledBack = true;
      }
    } catch {
      /* Report the failure and remaining block instead of hiding it. */
    }
    throw err("Media insertion failed", "partial_failure", {
      document_id: ref.token,
      block_id: block.block_id,
      rolled_back: rolledBack,
      cause: e.message,
    });
  }
}

function imageBytes(buffer) {
  return (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString()) ||
    (buffer.subarray(0, 4).toString() === "RIFF" &&
      buffer.subarray(8, 12).toString() === "WEBP")
  );
}

export async function readClipboardImage(
  platform = process.platform,
  runner = runFile,
) {
  const run = async (command, args) => {
    const result = await runner(command, args, {
      encoding: "buffer",
      maxBuffer: 48 * 1024 * 1024,
      timeout: 15000,
      windowsHide: true,
    });
    return Buffer.from(result.stdout ?? result);
  };
  if (platform === "darwin") {
    for (const format of ["PNGf", "HTML", "RTF ", "text"]) {
      try {
        let bytes = await run("osascript", [
          "-e",
          format === "text"
            ? "get the clipboard as text"
            : `get the clipboard as «class ${format}»`,
        ]);
        const literal = /^«data .{4}([0-9a-f\s]+)»$/is.exec(
          bytes.toString("utf8").trim(),
        );
        if (literal)
          bytes = Buffer.from(literal[1].replaceAll(/\s/g, ""), "hex");
        if (imageBytes(bytes)) return bytes;
        const uri = /data:image\/[^;]+;base64,([A-Za-z0-9+/_\s=-]+)/i.exec(
          bytes.toString("utf8"),
        );
        if (uri) {
          const decoded = Buffer.from(uri[1].replaceAll(/\s/g, ""), "base64");
          if (imageBytes(decoded)) return decoded;
        }
      } catch {
        /* Try the next available clipboard representation. */
      }
    }
    throw err("Clipboard contains no supported image");
  }
  if (platform === "win32") {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img -eq $null) { exit 1 }; $ms = New-Object System.IO.MemoryStream; $img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray())";
    try {
      const bytes = Buffer.from(
        (
          await run("powershell", [
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-Command",
            script,
          ])
        )
          .toString()
          .trim(),
        "base64",
      );
      if (imageBytes(bytes)) return bytes;
    } catch {
      /* Produce a stable validation error below. */
    }
    throw err(
      "Clipboard contains no supported image, or Windows clipboard access was denied",
    );
  }
  for (const [command, args] of [
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
    ["wl-paste", ["--type", "image/png"]],
    ["xsel", ["--clipboard", "--output"]],
  ]) {
    try {
      const bytes = await run(command, args);
      if (imageBytes(bytes)) return bytes;
    } catch {
      /* Try the next desktop clipboard provider. */
    }
  }
  throw err(
    "Clipboard contains no supported image. Linux requires xclip, wl-paste, or xsel",
  );
}

async function wiki(ctx, command, f) {
  const spaces = "/open-apis/wiki/v2/spaces";
  const getNode = async (raw) => {
    const ref = resourceRef(raw, f["obj-type"]);
    return request(
      ctx,
      "GET",
      `${spaces}/get_node`,
      clean({
        token: ref.token,
        obj_type: ref.type === "wiki" ? undefined : ref.type,
      }),
    );
  };
  const resolveSpace = async () => {
    if (f["space-id"] && f["space-id"] !== "my_library") return f["space-id"];
    if (f["parent-node-token"]) {
      if (ctx.dryRun) return "<resolved_space_id>";
      return (await getNode(f["parent-node-token"])).node.space_id;
    }
    if (f["space-id"] === "my_library") {
      if (ctx.dryRun) return "<my_library_space_id>";
      const data = await request(ctx, "GET", `${spaces}/my_library`);
      return data.space?.space_id ?? data.space_id;
    }
    throw err("--space-id or --parent-node-token is required");
  };
  if (command === "+space-list")
    return pages(ctx, "GET", spaces, {
      query: clean({
        page_size: number(f, "page-size", 50, 1, 50),
        page_token: f["page-token"],
      }),
    });
  if (command === "+space-create")
    return request(
      ctx,
      "POST",
      spaces,
      undefined,
      clean({ name: required(f, "name"), description: f.description }),
    );
  if (command === "+node-get") {
    const raw = f["node-token"] ?? required(f, "token");
    const data = await getNode(raw);
    if (!ctx.dryRun && f["space-id"] && data.node?.space_id !== f["space-id"])
      throw err("Resolved node does not belong to --space-id");
    return data;
  }
  if (
    [
      "+node-list",
      "+member-list",
      "+member-add",
      "+member-remove",
      "+node-create",
      "+delete-space",
    ].includes(command)
  ) {
    const s = await resolveSpace();
    const prefix = [];
    if (ctx.dryRun && f["space-id"] === "my_library")
      prefix.push(step("GET", `${spaces}/my_library`));
    if (ctx.dryRun && !f["space-id"] && f["parent-node-token"])
      prefix.push(
        step("GET", `${spaces}/get_node`, { token: f["parent-node-token"] }),
      );
    let method = "GET",
      url = `${spaces}/${enc(s)}`,
      query,
      body;
    if (command === "+node-list" || command === "+member-list") {
      url += command === "+node-list" ? "/nodes" : "/members";
      query = clean({
        page_size: number(f, "page-size", 50, 1, 50),
        page_token: f["page-token"],
        parent_node_token: f["parent-node-token"],
      });
      if (ctx.dryRun) return dry(ctx, [...prefix, step(method, url, query)]);
      return pages(ctx, method, url, { query });
    }
    if (command === "+node-create") {
      method = "POST";
      url += "/nodes";
      body = clean({
        obj_type: f["obj-type"] ?? "docx",
        node_type: f["node-type"] ?? "origin",
        title: f.title,
        parent_node_token: f["parent-node-token"],
        origin_node_token: f["origin-node-token"],
      });
      if (body.node_type === "shortcut" && !body.origin_node_token)
        throw err("--origin-node-token is required for shortcut nodes");
    } else if (command === "+delete-space") method = "DELETE";
    else {
      body = {
        member_type: required(f, "member-type"),
        member_role: required(f, "member-role"),
      };
      if (command === "+member-add") {
        method = "POST";
        url += "/members";
        body.member_id = required(f, "member-id");
        query = { need_notification: bool(f, "need-notification") };
      } else {
        method = "DELETE";
        url += `/members/${enc(required(f, "member-id"))}`;
      }
    }
    if (ctx.dryRun)
      return dry(ctx, [...prefix, step(method, url, query, body)]);
    return request(ctx, method, url, query, body);
  }
  if (command === "+node-copy") {
    if (!f["target-space-id"] && !f["target-parent-node-token"])
      throw err("--target-space-id or --target-parent-node-token is required");
    return request(
      ctx,
      "POST",
      `${spaces}/${enc(required(f, "space-id"))}/nodes/${enc(required(f, "node-token"))}/copy`,
      undefined,
      clean({
        target_space_id: f["target-space-id"],
        target_parent_token: f["target-parent-node-token"],
        title: f.title,
      }),
    );
  }
  if (command === "+node-delete" || command === "+move") {
    const requests = [];
    let s = f["space-id"] ?? f["source-space-id"];
    const raw = f["node-token"];
    let token = raw
      ? resourceRef(raw, f["obj-type"] ?? "wiki").token
      : undefined;
    if (token && !s) {
      if (ctx.dryRun) {
        s = "<resolved_space_id>";
        requests.push(step("GET", `${spaces}/get_node`, { token }));
      } else {
        const node = (await getNode(raw)).node;
        s = node.space_id;
        token = node.node_token;
      }
    }
    let method, url, body;
    if (command === "+node-delete") {
      required(f, "node-token");
      method = "DELETE";
      url = `${spaces}/${enc(s)}/nodes/${enc(token)}`;
      body = { include_children: bool(f, "include-children", true) };
    } else {
      method = "POST";
      if (token) {
        url = `${spaces}/${enc(s)}/nodes/${enc(token)}/move`;
        body = clean({
          target_space_id: f["target-space-id"],
          target_parent_token: f["target-parent-token"],
        });
      } else {
        url = `${spaces}/${enc(required(f, "target-space-id"))}/nodes/move_docs_to_wiki`;
        body = clean({
          obj_type: required(f, "obj-type"),
          obj_token: required(f, "obj-token"),
          parent_wiki_token: f["target-parent-token"],
          apply: bool(f, "apply"),
        });
      }
    }
    if (ctx.dryRun)
      return dry(ctx, [...requests, step(method, url, undefined, body)]);
    return request(ctx, method, url, undefined, body);
  }
  return undefined;
}

async function drive(ctx, command, f) {
  const files = "/open-apis/drive/v1/files";
  if (command === "+create-folder")
    return request(ctx, "POST", `${files}/create_folder`, undefined, {
      name: required(f, "name"),
      folder_token: f["folder-token"] ?? "",
    });
  if (command === "+create-shortcut")
    return request(ctx, "POST", `${files}/create_shortcut`, undefined, {
      parent_token: required(f, "folder-token"),
      refer_entity: {
        refer_token: required(f, "file-token"),
        refer_type: required(f, "type"),
      },
    });
  if (command === "+move")
    return request(
      ctx,
      "POST",
      `${files}/${enc(required(f, "file-token"))}/move`,
      undefined,
      { type: required(f, "type"), folder_token: f["folder-token"] ?? "" },
    );
  if (command === "+delete")
    return request(
      ctx,
      "DELETE",
      `${files}/${enc(required(f, "file-token"))}`,
      { type: required(f, "type") },
    );
  if (["+upload", "+import"].includes(command)) {
    const filename = await safeLocal(ctx, required(f, "file"));
    const bytes = await readFile(filename);
    const name = f.name ?? path.basename(filename);
    if (f["folder-token"] && f["wiki-token"])
      throw err("--folder-token and --wiki-token are mutually exclusive");
    const importing = command === "+import";
    const fields = importing
      ? {
          parent_type: "ccm_import_open",
          extra: JSON.stringify({
            obj_type: required(f, "type"),
            file_extension: path.extname(filename).slice(1),
          }),
        }
      : clean({
          parent_type: f["wiki-token"] ? "wiki" : "explorer",
          parent_node: f["wiki-token"] ?? f["folder-token"] ?? "",
          file_token: f["file-token"],
        });
    const body = importing
      ? clean({
          file_extension: path.extname(filename).slice(1),
          file_token: "<uploaded_file_token>",
          type: f.type,
          file_name: f.name ?? path.parse(filename).name,
          point: { mount_type: 1, mount_key: f["folder-token"] ?? "" },
          token: f["target-token"],
        })
      : undefined;
    if (ctx.dryRun)
      return dry(ctx, [
        ...uploadPreview(name, bytes.length, fields, importing),
        ...(importing
          ? [
              step("POST", "/open-apis/drive/v1/import_tasks", undefined, body),
              step("GET", "/open-apis/drive/v1/import_tasks/<ticket>"),
            ]
          : []),
      ]);
    const uploaded = await uploadBytes(ctx, bytes, name, fields, importing);
    if (!importing)
      return { ...uploaded, file_name: name, size_bytes: bytes.length };
    if (!uploaded.file_token)
      throw err("Import upload returned no file_token", "api");
    body.file_token = uploaded.file_token;
    const created = await request(
      ctx,
      "POST",
      "/open-apis/drive/v1/import_tasks",
      undefined,
      body,
    );
    if (!created.ticket) throw err("Import task returned no ticket", "api");
    return pollTask(
      ctx,
      `/open-apis/drive/v1/import_tasks/${enc(created.ticket)}`,
      {},
      created,
    );
  }
  if (command === "+download" || command === "+version-get")
    return download(
      ctx,
      `${files}/${enc(required(f, "file-token"))}/download`,
      f,
      clean({
        version:
          command === "+version-get" ? required(f, "version") : f.version,
      }),
      f.output ?? f["file-token"],
    );
  if (command === "+version-history")
    return request(
      ctx,
      "GET",
      `${files}/${enc(required(f, "file-token"))}/history`,
      clean({
        page_size: number(f, "limit", 20, 1, 200),
        page_token: f.cursor,
      }),
    );
  if (command === "+version-revert" || command === "+version-delete")
    return request(
      ctx,
      "POST",
      `${files}/${enc(required(f, "file-token"))}/${command === "+version-revert" ? "revert" : "version_del"}`,
      undefined,
      { version: required(f, "version") },
    );
  if (command === "+secure-label-list")
    return pages(ctx, "GET", "/open-apis/drive/v2/my_secure_labels", {
      query: clean({
        page_size: number(f, "page-size", 10, 1, 10),
        page_token: f["page-token"],
        lang: f.lang,
      }),
    });
  if (command === "+secure-label-update" || command === "+apply-permission") {
    const ref = await resolveRef(ctx, required(f, "token"), f.type);
    const url =
      command === "+secure-label-update"
        ? `/open-apis/drive/v2/files/${enc(ref.token)}/secure_label`
        : `/open-apis/drive/v1/permissions/${enc(ref.token)}/members/apply`;
    const body =
      command === "+secure-label-update"
        ? { id: required(f, "label-id") }
        : clean({ perm: required(f, "perm"), remark: f.remark });
    if (!ref.type) throw err("--type is required when using a raw token");
    if (ctx.dryRun)
      return dry(ctx, [
        ...(ref.resolveRequest ? [ref.resolveRequest] : []),
        step(
          command === "+secure-label-update" ? "PATCH" : "POST",
          url,
          { type: ref.type },
          body,
        ),
      ]);
    return request(
      ctx,
      command === "+secure-label-update" ? "PATCH" : "POST",
      url,
      { type: ref.type },
      body,
    );
  }
  if (command === "+inspect") {
    const ref = await resolveRef(ctx, required(f, "url"), f.type);
    if (!ref.type) throw err("--type is required for raw tokens");
    const body = {
      request_docs: [{ doc_token: ref.token, doc_type: ref.type }],
      with_url: true,
    };
    if (ctx.dryRun)
      return dry(ctx, [
        ...(ref.resolveRequest ? [ref.resolveRequest] : []),
        step("POST", "/open-apis/drive/v1/metas/batch_query", undefined, body),
      ]);
    return request(
      ctx,
      "POST",
      "/open-apis/drive/v1/metas/batch_query",
      undefined,
      body,
    );
  }
  if (command === "+search") {
    if (bool(f, "mine") && f["creator-ids"])
      throw err("--mine and --creator-ids are mutually exclusive");
    if (f["folder-tokens"] && f["space-ids"])
      throw err("--folder-tokens and --space-ids are mutually exclusive");
    const filter = {};
    for (const k of ["creator-ids", "doc-types", "chat-ids", "sharer-ids"])
      if (f[k]) filter[k.replaceAll("-", "_")] = list(f[k]);
    if (bool(f, "mine")) {
      const user = ctx.config?.userOpenId ?? ctx.session?.user?.open_id;
      if (!user)
        throw err("--mine requires a known logged-in user open_id", "auth");
      filter.creator_ids = [user];
    }
    if (f["doc-types"])
      filter.doc_types = list(f["doc-types"]).map((x) => x.toUpperCase());
    for (const [prefix, name] of [
      ["edited", "my_edit_time"],
      ["commented", "my_comment_time"],
      ["opened", "my_open_time"],
      ["created", "create_time"],
    ]) {
      if (f[`${prefix}-since`] || f[`${prefix}-until`])
        filter[name] = clean({
          start_time: f[`${prefix}-since`]
            ? parseTime(f[`${prefix}-since`])
            : undefined,
          end_time: f[`${prefix}-until`]
            ? parseTime(f[`${prefix}-until`])
            : undefined,
        });
    }
    const body = {
      query: f.query ?? "",
      page_size: number(f, "page-size", 15, 1, 20),
      doc_filter: { ...filter },
      wiki_filter: { ...filter },
    };
    if (f["folder-tokens"])
      body.doc_filter.folder_tokens = list(f["folder-tokens"]);
    if (f["space-ids"]) body.wiki_filter.space_ids = list(f["space-ids"]);
    for (const side of ["doc_filter", "wiki_filter"]) {
      if (f["only-title"]) body[side].only_title = true;
      if (f["only-comment"]) body[side].only_comment = true;
      if (f.sort)
        body[side].sort_type =
          f.sort === "default" ? "DEFAULT_TYPE" : String(f.sort).toUpperCase();
    }
    if (f["folder-tokens"]) delete body.wiki_filter;
    if (f["space-ids"]) delete body.doc_filter;
    if (f["page-token"]) body.page_token = f["page-token"];
    return pages(
      ctx,
      "POST",
      "/open-apis/search/v2/doc_wiki/search",
      { body },
      "res_units",
    );
  }
  if (command === "+add-comment") {
    const ref = await resolveRef(ctx, required(f, "doc"), f.type);
    if (!ref.type) throw err("--type is required with a raw document token");
    if (f["selection-with-ellipsis"])
      throw err(
        "Text-located comments require the locate-doc backend; use --block-id from docs +fetch --blocks or a full-document comment",
        "unsupported",
      );
    const elements = await json(ctx, required(f, "content"), "--content");
    const body = {
      file_type: ref.type,
      reply_elements: Array.isArray(elements)
        ? elements
        : (elements.elements ?? elements.reply_elements),
    };
    if (!Array.isArray(body.reply_elements))
      throw err("--content must be an array of reply elements");
    if (f["block-id"]) {
      if (ref.type === "sheet") {
        const match = /^([^!]+)!([A-Z]+)([1-9]\d*)$/i.exec(f["block-id"]);
        if (!match)
          throw err("--block-id must be sheetId!A1 for sheet comments");
        let col = 0;
        for (const ch of match[2].toUpperCase())
          col = col * 26 + ch.charCodeAt(0) - 64;
        body.anchor = {
          block_id: match[1],
          sheet_col: col - 1,
          sheet_row: Number(match[3]) - 1,
        };
      } else if (ref.type === "slides") {
        const match = /^([^!]+)!(.+)$/.exec(f["block-id"]);
        if (!match)
          throw err(
            "--block-id must be slide-block-type!xml-id for slide comments",
          );
        body.anchor = { block_id: match[2], slide_block_type: match[1] };
      } else body.anchor = { block_id: f["block-id"] };
    } else if (ref.type === "sheet" || ref.type === "slides")
      throw err(`--block-id is required for ${ref.type} comments`);
    else if (ref.type === "file") body.anchor = { block_id: "test" };
    return request(
      ctx,
      "POST",
      `/open-apis/drive/v1/files/${enc(ref.token)}/new_comments`,
      undefined,
      body,
    );
  }
  if (command === "+task_result") {
    const scenario = required(f, "scenario");
    if (scenario === "import")
      return request(
        ctx,
        "GET",
        `/open-apis/drive/v1/import_tasks/${enc(required(f, "ticket"))}`,
      );
    if (scenario === "export")
      return request(
        ctx,
        "GET",
        `/open-apis/drive/v1/export_tasks/${enc(required(f, "ticket"))}`,
        { token: required(f, "file-token") },
      );
    if (scenario === "task_check")
      return request(ctx, "GET", `${files}/task_check`, {
        task_id: required(f, "task-id"),
      });
    const types = {
      wiki_move: "move",
      wiki_delete_space: "delete_space",
      wiki_delete_node: "delete_node",
    };
    if (!types[scenario]) throw err("Unknown task scenario");
    return request(
      ctx,
      "GET",
      `/open-apis/wiki/v2/tasks/${enc(required(f, "task-id"))}`,
      { task_type: types[scenario] },
    );
  }
  if (command === "+export-download")
    return download(
      ctx,
      `/open-apis/drive/v1/export_tasks/file/${enc(required(f, "file-token"))}/download`,
      {
        ...f,
        output: path.join(
          f["output-dir"] ?? ".",
          f["file-name"] ?? f["file-token"],
        ),
      },
    );
  if (command === "+export") {
    const body = clean({
      token: required(f, "token"),
      type: required(f, "doc-type"),
      file_extension: required(f, "file-extension"),
      sub_id: f["sub-id"],
    });
    if (body.file_extension === "markdown")
      throw err(
        "Markdown document export requires docs_ai fetch; use docs +fetch --doc-format markdown with capabilities.docsAi=true",
        "unsupported",
      );
    const requests = [
      step("POST", "/open-apis/drive/v1/export_tasks", undefined, body),
      step("GET", "/open-apis/drive/v1/export_tasks/<ticket>", {
        token: body.token,
      }),
      step(
        "GET",
        "/open-apis/drive/v1/export_tasks/file/<file_token>/download",
      ),
    ];
    if (ctx.dryRun) return dry(ctx, requests);
    const created = await request(
      ctx,
      "POST",
      "/open-apis/drive/v1/export_tasks",
      undefined,
      body,
    );
    if (!created.ticket) throw err("Export task returned no ticket", "api");
    const completed = await pollTask(
      ctx,
      `/open-apis/drive/v1/export_tasks/${enc(created.ticket)}`,
      { token: body.token },
      created,
    );
    const result = completed.result ?? completed;
    if (!result.file_token) return { ...completed, ticket: created.ticket };
    return download(
      ctx,
      `/open-apis/drive/v1/export_tasks/file/${enc(result.file_token)}/download`,
      {
        ...f,
        output: path.join(
          f["output-dir"] ?? ".",
          f["file-name"] ??
            result.file_name ??
            `${body.token}.${body.file_extension}`,
        ),
      },
    );
  }
  if (command === "+preview" || command === "+cover") {
    const token = required(f, "file-token");
    if (command === "+cover") {
      const specs = {
        default: { bus_type: "cover", platform: "pc" },
        icon: { bus_type: "icon" },
        grid: { bus_type: "grid" },
        small: { bus_type: "small_graph", platform: "pc" },
        middle: { bus_type: "middle" },
        big: { bus_type: "big", platform: "mobile" },
        square: { width: 360, height: 360, policy: "near" },
      };
      if (bool(f, "list-only"))
        return {
          file_token: token,
          candidates: Object.keys(specs).map((spec) => ({ spec })),
        };
      if (!specs[f.spec ?? "default"])
        throw err(
          "--spec must be default, icon, grid, small, middle, big, or square",
        );
      return download(
        ctx,
        `/open-apis/drive/v1/medias/${enc(token)}/preview_download`,
        { ...f, overwrite: f["if-exists"] === "overwrite" },
        clean({
          preview_type: "1",
          ...specs[f.spec ?? "default"],
          version: f.version,
        }),
        f.output ?? `${token}.png`,
      );
    }
    const base = `/open-apis/drive/v1/medias/${enc(token)}`;
    const body = clean({ version: f.version });
    if (ctx.dryRun)
      return dry(ctx, [
        step("POST", `${base}/preview_result`, undefined, body),
        ...(bool(f, "list-only")
          ? []
          : [
              step(
                "GET",
                `${base}/preview_download`,
                clean({
                  preview_type: f.type ?? "<selected_preview_type>",
                  version: f.version,
                }),
              ),
            ]),
      ]);
    const previews = await request(
      ctx,
      "POST",
      `${base}/preview_result`,
      undefined,
      body,
    );
    if (bool(f, "list-only")) return previews;
    if (!f.type)
      throw err(
        "Specify --type after inspecting --list-only; available previews depend on the file",
      );
    const types = {
      pdf: "0",
      image: "1",
      png: "1",
      jpg: "7",
      html: "8",
      text: "14",
      source: "16",
    };
    if (!types[f.type])
      throw err(
        "Supported preview types: pdf, image, png, jpg, html, text, source",
      );
    return download(
      ctx,
      `${base}/preview_download`,
      { ...f, overwrite: f["if-exists"] === "overwrite" },
      clean({
        preview_type: types[f.type],
        version: f.version ?? previews.version,
      }),
      f.output ?? `${token}.${f.type}`,
    );
  }
  if (["+pull", "+push", "+sync", "+status"].includes(command))
    return syncDrive(ctx, command, f);
  return undefined;
}

function parseTime(value) {
  if (/^\d+$/.test(value)) return value;
  const relative = /^(\d+)([dhmy])$/.exec(value);
  if (relative) {
    const duration = { d: 86400, h: 3600, m: 30 * 86400, y: 365 * 86400 }[
      relative[2]
    ];
    return String(
      Math.floor(Date.now() / 1000 - Number(relative[1]) * duration),
    );
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw err(`Invalid date/time: ${value}`);
  return String(Math.floor(ms / 1000));
}

async function pollTask(ctx, url, query, initial) {
  const attempts = Math.max(1, Number(ctx.config?.taskPollAttempts ?? 30));
  for (let i = 0; i < attempts; i++) {
    const result = await request(ctx, "GET", url, query);
    const status =
      result.result?.job_status ?? result.job_status ?? result.status;
    const artifact = result.result ?? result;
    if (
      (status === 0 && (artifact.token || artifact.file_token)) ||
      status === "success" ||
      status === "completed"
    )
      return result;
    if (
      status !== undefined &&
      ![0, 1, 2, "pending", "processing", "running"].includes(status)
    )
      throw err(`Async task failed with status ${status}`, "api", result);
    if (i < attempts - 1)
      await new Promise((resolve) =>
        setTimeout(resolve, Number(ctx.config?.taskPollIntervalMs ?? 1000)),
      );
  }
  return {
    ...initial,
    pending: true,
    status_url: url,
    hint: "Task remains pending; query drive +task_result before retrying the creation command",
  };
}

async function markdown(ctx, command, f) {
  const base = "/open-apis/drive/v1/files";
  if (command === "+fetch")
    return download(
      ctx,
      `${base}/${enc(required(f, "file-token"))}/download`,
      f,
    );
  if (["+create", "+overwrite", "+patch"].includes(command)) {
    let content, name;
    if (command === "+patch") {
      const token = required(f, "file-token");
      const pattern = await input(ctx, required(f, "pattern"));
      const replacement = await input(ctx, val(f, "content", ""));
      if (ctx.dryRun)
        return dry(ctx, [
          step("GET", `${base}/${enc(token)}/download`),
          step("POST", `${base}/upload_all`, undefined, {
            file_token: token,
            file: "<patched Markdown>",
            pattern,
            replacement,
          }),
        ]);
      const bytes = await request(
        ctx,
        "GET",
        `${base}/${enc(token)}/download`,
        undefined,
        undefined,
        { responseType: "buffer" },
      );
      const original = Buffer.from(bytes).toString("utf8");
      if (bool(f, "regex")) {
        if (/\(\?[=!<]|\\[1-9]/.test(pattern))
          throw err(
            "--regex must be RE2-compatible; lookaround and backreferences are not supported",
          );
        let expression;
        try {
          expression = new RegExp(pattern, "gu");
        } catch {
          throw err("Invalid regular expression");
        }
        if (!expression.test(original))
          throw err("Pattern did not match; no upload performed");
        content = original.replace(expression, replacement);
      } else {
        if (!pattern || !original.includes(pattern))
          throw err("Pattern did not match; no upload performed");
        content = original.split(pattern).join(replacement);
      }
      name = f.name ?? "document.md";
    } else {
      if (has(f, "content") === has(f, "file"))
        throw err("Specify exactly one of --content or --file");
      if (f.file) {
        const filename = await safeLocal(ctx, f.file);
        content = await readFile(filename, "utf8");
        name = f.name ?? path.basename(filename);
      } else {
        content = await input(ctx, f.content);
        name =
          command === "+create"
            ? required(f, "name")
            : (f.name ?? "document.md");
      }
    }
    if (!name.toLowerCase().endsWith(".md"))
      throw err("Markdown file name must end with .md");
    if (!content) throw err("Empty Markdown content is not supported");
    if (f["folder-token"] && f["wiki-token"])
      throw err("--folder-token and --wiki-token are mutually exclusive");
    const fields = clean({
      parent_type: f["wiki-token"] ? "wiki" : "explorer",
      parent_node: f["wiki-token"] ?? f["folder-token"] ?? "",
      file_token: command !== "+create" ? required(f, "file-token") : undefined,
    });
    const bytes = Buffer.from(content);
    if (ctx.dryRun) return dry(ctx, uploadPreview(name, bytes.length, fields));
    const data = await uploadBytes(ctx, bytes, name, fields);
    return { ...data, file_name: name, size_bytes: bytes.length };
  }
  if (command === "+diff") {
    const token = required(f, "file-token");
    if (f["to-version"] && !f["from-version"])
      throw err("--to-version requires --from-version");
    if (f.file && f["to-version"])
      throw err("--file and --to-version are mutually exclusive");
    const url = `${base}/${enc(token)}/download`;
    const requests = [step("GET", url, clean({ version: f["from-version"] }))];
    if (!f.file)
      requests.push(step("GET", url, clean({ version: f["to-version"] })));
    if (ctx.dryRun) return dry(ctx, requests, { local_file: f.file });
    const before = Buffer.from(
      await request(
        ctx,
        "GET",
        url,
        clean({ version: f["from-version"] }),
        undefined,
        { responseType: "buffer" },
      ),
    ).toString("utf8");
    const after = f.file
      ? await readFile(await safeLocal(ctx, f.file), "utf8")
      : Buffer.from(
          await request(
            ctx,
            "GET",
            url,
            clean({ version: f["to-version"] }),
            undefined,
            { responseType: "buffer" },
          ),
        ).toString("utf8");
    const changed = before !== after;
    return {
      file_token: token,
      changed,
      diff: changed
        ? unifiedDiff(
            before,
            after,
            f.file ?? f["to-version"] ?? "latest",
            number(f, "context-lines", 3, 0, 1000),
          )
        : "",
    };
  }
  return undefined;
}

function unifiedDiff(before, after, target, context = 3) {
  const a = before.split("\n"),
    b = after.split("\n");
  let commonStart = 0;
  while (
    commonStart < a.length &&
    commonStart < b.length &&
    a[commonStart] === b[commonStart]
  )
    commonStart++;
  let commonEnd = 0;
  while (
    commonEnd < a.length - commonStart &&
    commonEnd < b.length - commonStart &&
    a.at(-1 - commonEnd) === b.at(-1 - commonEnd)
  )
    commonEnd++;
  const start = Math.max(0, commonStart - context),
    ae = Math.min(a.length, a.length - commonEnd + context),
    be = Math.min(b.length, b.length - commonEnd + context);
  return [
    `--- remote`,
    `+++ ${target}`,
    `@@ -${start + 1},${ae - start} +${start + 1},${be - start} @@`,
    ...a.slice(start, commonStart).map((x) => ` ${x}`),
    ...a.slice(commonStart, a.length - commonEnd).map((x) => `-${x}`),
    ...b.slice(commonStart, b.length - commonEnd).map((x) => `+${x}`),
    ...a.slice(a.length - commonEnd, ae).map((x) => ` ${x}`),
  ].join("\n");
}

async function slides(ctx, command, f) {
  const base = "/open-apis/slides_ai/v1/xml_presentations";
  if (command === "+create") {
    const slideXML = await json(ctx, f.slides, "--slides", []);
    if (!Array.isArray(slideXML) || slideXML.some((s) => typeof s !== "string"))
      throw err("--slides must be an array of XML strings");
    if (slideXML.length > 10)
      throw err("--slides accepts at most 10 slides per create");
    const assets = new Map();
    for (const slide of slideXML)
      for (const match of slide.matchAll(
        /<img\b[^>]*\bsrc\s*=\s*(["'])@([^"']+)\1/gi,
      )) {
        const filename = await safeLocal(ctx, match[2]);
        const bytes = await readFile(filename);
        if (bytes.length > 20 * 1024 * 1024)
          throw err("Slides image uploads must not exceed 20 MiB");
        assets.set(match[2], { filename, bytes });
      }
    const body = {
      xml_presentation: {
        content: `<presentation width="960" height="540"><title>${xml(f.title ?? "Untitled")}</title></presentation>`,
      },
    };
    if (ctx.dryRun)
      return dry(ctx, [
        step("POST", base, undefined, body),
        ...[...assets.values()].flatMap((a) =>
          uploadPreview(
            path.basename(a.filename),
            a.bytes.length,
            { parent_type: "slide_file", parent_node: "<xml_presentation_id>" },
            true,
          ),
        ),
        ...slideXML.map((content) =>
          step(
            "POST",
            `${base}/<xml_presentation_id>/slide`,
            { revision_id: -1 },
            { slide: { content } },
          ),
        ),
      ]);
    const created = await request(ctx, "POST", base, undefined, body);
    const id = created.xml_presentation_id;
    if (!id) throw err("Slides create returned no xml_presentation_id", "api");
    const completed = [];
    try {
      for (const [placeholder, a] of assets) {
        const uploaded = await uploadBytes(
          ctx,
          a.bytes,
          path.basename(a.filename),
          { parent_type: "slide_file", parent_node: id },
          true,
        );
        if (!uploaded.file_token)
          throw err("Slides image upload returned no file_token", "api");
        assets.set(placeholder, { ...a, token: uploaded.file_token });
      }
      for (const original of slideXML) {
        const content = original.replace(
          /(<img\b[^>]*\bsrc\s*=\s*)(["'])@([^"']+)\2/gi,
          (_, prefix, quote, filename) =>
            `${prefix}${quote}${assets.get(filename).token}${quote}`,
        );
        completed.push(
          await request(
            ctx,
            "POST",
            `${base}/${enc(id)}/slide`,
            { revision_id: -1 },
            { slide: { content } },
          ),
        );
      }
    } catch (e) {
      throw err(
        "Presentation was created, but adding content failed. Inspect it before retrying",
        "partial_failure",
        {
          xml_presentation_id: id,
          completed_slides: completed.length,
          cause: e.message,
        },
      );
    }
    return {
      ...created,
      slides: completed,
      url: resourceURL(ctx, "slides", id),
    };
  }
  if (command === "+replace-slide") {
    const ref = await resolveRef(ctx, required(f, "presentation"), "slides");
    const parts = await json(ctx, required(f, "parts"), "--parts");
    if (!Array.isArray(parts) || !parts.length || parts.length > 200)
      throw err("--parts must contain 1–200 operations");
    for (const part of parts) {
      if (part.action === "block_replace") {
        if (!part.block_id || !part.replacement)
          throw err("block_replace requires block_id and replacement");
        if (!/^\s*<[A-Za-z]/.test(part.replacement))
          throw err("replacement must contain XML");
        part.replacement = part.replacement.replace(
          /^(\s*<[\w:-]+)(\s[^>]*|)(>)/,
          (whole, name, attrs, end) =>
            `${name}${attrs.replace(/\s+id\s*=\s*(["']).*?\1/, "")} id="${xml(part.block_id)}"${end}`,
        );
      } else if (part.action === "block_insert") {
        if (!part.insertion) throw err("block_insert requires insertion");
      } else throw err("Supported slide actions: block_replace, block_insert");
    }
    const query = clean({
      slide_id: required(f, "slide-id"),
      revision_id: number(f, "revision-id", -1, -1),
      tid: f.tid,
    });
    const url = `${base}/${enc(ref.token)}/slide/replace`;
    if (ctx.dryRun)
      return dry(ctx, [
        ...(ref.resolveRequest ? [ref.resolveRequest] : []),
        step("POST", url, query, { parts }),
      ]);
    return request(ctx, "POST", url, query, { parts });
  }
  if (command === "+media-upload") {
    const ref = await resolveRef(ctx, required(f, "presentation"), "slides");
    const filename = await safeLocal(ctx, required(f, "file"));
    const bytes = await readFile(filename);
    if (bytes.length > 20 * 1024 * 1024)
      throw err("Slides image uploads must not exceed 20 MiB");
    const fields = { parent_type: "slide_file", parent_node: ref.token };
    if (ctx.dryRun)
      return dry(ctx, [
        ...(ref.resolveRequest ? [ref.resolveRequest] : []),
        ...uploadPreview(path.basename(filename), bytes.length, fields, true),
      ]);
    return uploadBytes(ctx, bytes, path.basename(filename), fields, true);
  }
  return undefined;
}

async function board(ctx, command, f) {
  if (!["+update", "+query"].includes(command)) return undefined;
  const token = required(f, "whiteboard-token");
  const base = `/open-apis/board/v1/whiteboards/${enc(token)}`;
  if (command === "+query") {
    const format = required(f, "output_as");
    if (format === "image") {
      required(f, "output");
      return download(ctx, `${base}/download_as_image`, f, {}, `${token}.png`);
    }
    if (!["raw", "code"].includes(format))
      throw err("--output_as must be image, raw, or code");
    const data = await request(ctx, "GET", `${base}/nodes`);
    if (ctx.dryRun) return data;
    if (format === "raw")
      return f.output
        ? writeOutput(
            ctx,
            path.join(f.output, `${token}.json`),
            Buffer.from(JSON.stringify(data, null, 2)),
            bool(f, "overwrite"),
          )
        : data;
    const nodes = data.nodes ?? data.items ?? [];
    const codes = nodes
      .map(
        (n) =>
          n.syntax ??
          (n.plant_uml_code || n.code
            ? { code: n.plant_uml_code ?? n.code, syntax_type: n.syntax_type }
            : undefined),
      )
      .filter((n) => n?.code);
    if (!codes.length) return { msg: "no code blocks found in whiteboard" };
    if (codes.length > 1)
      return {
        msg: "multiple code blocks found, cannot export directly",
        code_blocks: codes,
      };
    const content = codes[0].code,
      syntax = { 1: "plantuml", 2: "mermaid" }[codes[0].syntax_type];
    if (!syntax)
      throw err("Whiteboard syntax type is not Mermaid or PlantUML", "api");
    return f.output
      ? writeOutput(
          ctx,
          path.join(
            f.output,
            `${token}.${syntax === "mermaid" ? "mmd" : "puml"}`,
          ),
          Buffer.from(content),
          bool(f, "overwrite"),
        )
      : { code: content, syntax_type: syntax };
  }
  const source = await input(ctx, required(f, "source"));
  const format = f.input_format ?? "raw";
  if (f["idempotent-token"] && f["idempotent-token"].length < 10)
    throw err("--idempotent-token must be at least 10 characters");
  const query = clean({ client_token: f["idempotent-token"] });
  if (format === "raw") {
    const data = await json(ctx, source, "--source");
    const nodes = Array.isArray(data)
      ? data
      : (data.raw_nodes ?? data.nodes ?? data.data?.result?.nodes);
    if (!Array.isArray(nodes))
      throw err("Raw whiteboard source must contain a nodes/raw_nodes array");
    const result = await request(ctx, "POST", `${base}/nodes`, query, {
      nodes,
      overwrite: bool(f, "overwrite"),
    });
    if (ctx.dryRun) return result;
    if (
      !Array.isArray(result.ids) ||
      result.ids.some((id) => typeof id !== "string")
    )
      throw err("Whiteboard update returned no valid ids array", "api");
    return { created_node_ids: result.ids.join(",") };
  }
  if (!["mermaid", "plantuml"].includes(format))
    throw err("--input_format must be raw, mermaid, or plantuml");
  const result = await request(ctx, "POST", `${base}/nodes/plantuml`, query, {
    plant_uml_code: source,
    syntax_type: format === "mermaid" ? 2 : 1,
    parse_mode: 1,
    overwrite: bool(f, "overwrite"),
  });
  if (ctx.dryRun) return result;
  if (!result.node_id)
    throw err("Whiteboard code update returned no node_id", "api");
  return { created_node_id: result.node_id };
}

async function syncDrive(ctx, command, f) {
  const root = await safeLocal(ctx, required(f, "local-dir"), { output: true });
  const folder = required(f, "folder-token");
  if (ctx.dryRun)
    return dry(
      ctx,
      [
        step("GET", "/open-apis/drive/v1/files", {
          folder_token: folder,
          page_size: 200,
        }),
      ],
      {
        operation: command.slice(1),
        local_dir: root,
        note: "Remote children and hashes must be read before computing the transfer plan; dry-run performs no local or remote mutations",
      },
    );
  if (bool(f, "delete-local") && !bool(f, "yes"))
    throw err("--delete-local requires --yes");
  if (bool(f, "delete-remote") && !bool(f, "yes"))
    throw err("--delete-remote requires --yes");
  const local = new Map(),
    remote = new Map(),
    folders = new Map([["", folder]]),
    walkedFolders = new Set();
  async function walkLocal(directory, prefix = "") {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink())
        throw err(`Sync refuses symlinks: ${entry.name}`);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        await walkLocal(path.join(directory, entry.name), rel);
      else if (entry.isFile())
        local.set(rel, {
          filename: path.join(directory, entry.name),
          ...(await stat(path.join(directory, entry.name))),
        });
    }
  }
  async function walkRemote(token, prefix = "") {
    if (walkedFolders.has(token))
      throw err("Remote directory contains a repeated folder token", "api");
    walkedFolders.add(token);
    let next;
    const seen = new Set();
    do {
      const page = await request(
        ctx,
        "GET",
        "/open-apis/drive/v1/files",
        clean({ folder_token: token, page_size: 200, page_token: next }),
      );
      for (const item of page.files ?? page.items ?? []) {
        if (
          !item.name ||
          item.name.includes("/") ||
          item.name.includes("\\") ||
          [".", ".."].includes(item.name)
        )
          throw err("Remote file contains an unsafe name", "api");
        const rel = prefix ? `${prefix}/${item.name}` : item.name;
        if (remote.has(rel) || folders.has(rel)) {
          const policy = f["on-duplicate-remote"] ?? "fail";
          if (
            remote.has(rel) &&
            item.type === "file" &&
            ["newest", "oldest"].includes(policy)
          ) {
            const existing = remote.get(rel),
              comparison =
                Number(item.modified_time) - Number(existing.modified_time);
            if (
              (policy === "newest" && comparison > 0) ||
              (policy === "oldest" && comparison < 0)
            )
              remote.set(rel, item);
            continue;
          }
          if (remote.has(rel) && item.type === "file" && policy === "rename") {
            const existing = remote.get(rel),
              parsed = path.posix.parse(rel);
            remote.delete(rel);
            remote.set(
              path.posix.join(
                parsed.dir,
                `${parsed.name}-${existing.token}${parsed.ext}`,
              ),
              existing,
            );
            remote.set(
              path.posix.join(
                parsed.dir,
                `${parsed.name}-${item.token}${parsed.ext}`,
              ),
              item,
            );
            continue;
          }
          throw err(
            `Duplicate remote path: ${rel}; resolve duplicate names or use --on-duplicate-remote newest/oldest/rename`,
          );
        }
        if (item.type === "folder") {
          folders.set(rel, item.token);
          await walkRemote(item.token, rel);
        } else if (item.type === "file") remote.set(rel, item);
      }
      next = page.has_more
        ? (page.next_page_token ?? page.page_token)
        : undefined;
      if (next && seen.has(next))
        throw err("Remote folder pagination repeated a token", "api");
      seen.add(next);
    } while (next);
  }
  await walkLocal(root);
  await walkRemote(folder);
  const changes = [],
    same = [];
  for (const rel of new Set([...local.keys(), ...remote.keys()])) {
    const l = local.get(rel),
      r = remote.get(rel);
    if (!l || !r) {
      changes.push({ path: rel, status: l ? "local_only" : "remote_only" });
      continue;
    }
    let equal;
    if (bool(f, "quick"))
      equal = Math.floor(l.mtimeMs / 1000) === Number(r.modified_time);
    else {
      const remoteBytes = await request(
        ctx,
        "GET",
        `/open-apis/drive/v1/files/${enc(r.token)}/download`,
        undefined,
        undefined,
        { responseType: "buffer" },
      );
      const localBytes = await readFile(l.filename);
      equal =
        createHash("sha256").update(localBytes).digest("hex") ===
        createHash("sha256").update(remoteBytes).digest("hex");
    }
    (equal ? same : changes).push(
      equal ? rel : { path: rel, status: "different" },
    );
  }
  if (command === "+status")
    return {
      local_dir: root,
      folder_token: folder,
      changes,
      unchanged: same.length,
    };
  const results = [];
  async function ensureFolder(rel) {
    if (rel === "." || !rel) return folder;
    if (folders.has(rel)) return folders.get(rel);
    const parent = await ensureFolder(path.posix.dirname(rel));
    const result = await request(
      ctx,
      "POST",
      "/open-apis/drive/v1/files/create_folder",
      undefined,
      { name: path.posix.basename(rel), folder_token: parent },
    );
    if (!result.token) throw err("Create folder returned no token", "api");
    folders.set(rel, result.token);
    return result.token;
  }
  for (const change of changes) {
    const rel = change.path,
      l = local.get(rel),
      r = remote.get(rel);
    let direction;
    if (command === "+push")
      direction = l
        ? "upload"
        : bool(f, "delete-remote")
          ? "delete_remote"
          : "skip";
    else if (command === "+pull")
      direction = r
        ? "download"
        : bool(f, "delete-local")
          ? "delete_local"
          : "skip";
    else if (!l) direction = "download";
    else if (!r) direction = "upload";
    else {
      const policy = f["on-conflict"] ?? "remote-wins";
      if (policy === "ask")
        throw err(
          `Conflict at ${rel}; set --on-conflict local-wins, remote-wins, or keep-both`,
        );
      direction = policy === "local-wins" ? "upload" : "download";
      if (policy === "keep-both") {
        const backup = `${l.filename}.local-${Date.now()}`;
        await writeFile(backup, await readFile(l.filename), { flag: "wx" });
      }
    }
    try {
      if (direction === "upload") {
        const policy =
          f["if-exists"] ?? (command === "+push" ? "skip" : "overwrite");
        if (r && policy === "skip") {
          results.push({ path: rel, action: "skipped" });
          continue;
        }
        if (
          r &&
          policy === "smart" &&
          Number.isFinite(Number(r.modified_time)) &&
          Number(r.modified_time) >= Math.floor(l.mtimeMs / 1000)
        ) {
          results.push({ path: rel, action: "skipped" });
          continue;
        }
        const bytes = await readFile(l.filename);
        const parent = await ensureFolder(path.posix.dirname(rel));
        const uploaded = await uploadBytes(
          ctx,
          bytes,
          path.posix.basename(rel),
          clean({
            parent_type: "explorer",
            parent_node: parent,
            file_token: r?.token,
          }),
        );
        results.push({ path: rel, action: "uploaded", ...uploaded });
      } else if (direction === "download") {
        if (l && f["if-exists"] === "skip") {
          results.push({ path: rel, action: "skipped" });
          continue;
        }
        if (
          l &&
          f["if-exists"] === "smart" &&
          Math.floor(l.mtimeMs / 1000) >= Number(r.modified_time)
        ) {
          results.push({ path: rel, action: "skipped" });
          continue;
        }
        const bytes = await request(
          ctx,
          "GET",
          `/open-apis/drive/v1/files/${enc(r.token)}/download`,
          undefined,
          undefined,
          { responseType: "buffer" },
        );
        const target = path.join(root, ...rel.split("/"));
        const result = await writeOutput(ctx, target, bytes, true);
        if (Number(r.modified_time) > 0)
          await utimes(
            target,
            new Date(),
            new Date(Number(r.modified_time) * 1000),
          );
        results.push({ path: rel, action: "downloaded", ...result });
      } else if (direction === "delete_local") {
        await unlink(l.filename);
        results.push({ path: rel, action: "deleted_local" });
      } else if (direction === "delete_remote") {
        await request(
          ctx,
          "DELETE",
          `/open-apis/drive/v1/files/${enc(r.token)}`,
          { type: "file" },
        );
        results.push({ path: rel, action: "deleted_remote" });
      }
    } catch (e) {
      throw err(
        "Drive transfer stopped after a failure; completed operations are listed",
        "partial_failure",
        { results, failed_path: rel, cause: e.message },
      );
    }
  }
  return {
    local_dir: root,
    folder_token: folder,
    results,
    unchanged: same.length,
  };
}

export async function executeContent(ctx, service, command, flags = {}) {
  const active = { ...ctx, flags: { ...(ctx.flags ?? {}), ...flags } };
  if (service === "docs") return docs(active, command, flags);
  if (service === "drive") return drive(active, command, flags);
  if (service === "wiki") return wiki(active, command, flags);
  if (service === "markdown") return markdown(active, command, flags);
  if (service === "slides") return slides(active, command, flags);
  if (service === "whiteboard") return board(active, command, flags);
  return undefined;
}

// Capabilities are intentionally explicit: recognizing a command is not a
// claim that every advanced format or locator in the Go implementation exists.
export const CONTENT_COVERAGE = {
  docs: {
    "+create": "native-xml-markdown-text-tables-or-docs-ai-or-mcp",
    "+fetch": "native-xml-markdown-raw-partial-or-docs-ai-or-mcp",
    "+update": "native-append-replace-delete-literal-edit-or-docs-ai-or-mcp",
    "+search": "implemented",
    "+media-upload": "implemented",
    "+media-download": "implemented",
    "+media-preview": "implemented",
    "+media-insert": "implemented-with-selection-clipboard-and-rollback",
    "+whiteboard-update": "raw-nodes-mermaid-plantuml",
  },
  drive: Object.fromEntries(
    [
      "create-folder",
      "create-shortcut",
      "move",
      "delete",
      "upload",
      "download",
      "import",
      "export",
      "export-download",
      "search",
      "inspect",
      "preview",
      "cover",
      "version-history",
      "version-get",
      "version-revert",
      "version-delete",
      "secure-label-list",
      "secure-label-update",
      "apply-permission",
      "task_result",
      "add-comment",
      "pull",
      "push",
      "sync",
      "status",
    ].map((x) => [
      `+${x}`,
      ["add-comment", "preview", "cover", "pull", "push", "sync"].includes(x)
        ? "partial-see-source-validation"
        : "implemented",
    ]),
  ),
  wiki: Object.fromEntries(
    [
      "space-list",
      "space-create",
      "delete-space",
      "node-get",
      "node-create",
      "node-copy",
      "node-list",
      "node-delete",
      "move",
      "member-list",
      "member-add",
      "member-remove",
    ].map((x) => [`+${x}`, "implemented-async-tasks-returned-for-followup"]),
  ),
  markdown: {
    "+create": "implemented",
    "+fetch": "implemented",
    "+overwrite": "implemented",
    "+patch": "implemented-re2-subset",
    "+diff": "implemented-unified-diff",
  },
  slides: {
    "+create": "implemented-with-local-image-upload",
    "+replace-slide": "implemented",
    "+media-upload": "implemented",
  },
  whiteboard: {
    "+update": "raw-nodes-mermaid-plantuml",
    "+query": "image-raw-or-preserved-source-only",
  },
};

export const CONTENT_LIMITATIONS = [
  "Native docx rich conversion supports paragraphs, headings, inline styles, links, nested lists, code without language hints, and unmerged tables. Explicit column widths, styled/merged table cells, callouts, grids, charts, and advanced resource blocks require a deployed docs_ai/MCP backend; unsupported inputs fail before document creation.",
  "Native docx move/copy block operations and legacy text locators require a deployed docs_ai/MCP backend; native string replacement is literal and preserves surrounding text runs.",
  "Clipboard capture uses built-in macOS/Windows desktop utilities, or xclip/wl-paste/xsel on Linux. Remote URL media embedding is not automatically downloaded during native document conversion.",
  "Drive text-located comments require the locate-doc backend; explicit block, sheet cell, slide element, and whole-document comments are implemented.",
  "Drive sync uses content hashes or requested timestamp comparison. Interactive conflict prompts are unavailable; choose an explicit policy. The duplicate rename policy supports file duplicates, not duplicate folders.",
  "Markdown diff returns a unified changed region with configurable context; its hunk grouping is not byte-for-byte identical to the Go diff library.",
  "Whiteboard source-code export requires preserved Mermaid/PlantUML syntax nodes; it does not reverse-engineer arbitrary shapes into source code.",
];
