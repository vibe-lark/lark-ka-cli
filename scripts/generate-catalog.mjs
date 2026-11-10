import { readdir, readFile, mkdir, writeFile, cp } from "node:fs/promises";
import path from "node:path";
const source = path.resolve(process.argv[2] || "../lark_-ka_-cli-main");
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((x) =>
      x.isDirectory() ? walk(path.join(dir, x.name)) : [path.join(dir, x.name)],
    ),
  );
  return nested.flat();
}
function blockAt(text, start) {
  let depth = 0,
    quote = "",
    comment = "";
  for (let i = start; i < text.length; i++) {
    const c = text[i],
      n = text[i + 1];
    if (comment === "line") {
      if (c === "\n") comment = "";
      continue;
    }
    if (comment === "block") {
      if (c === "*" && n === "/") {
        comment = "";
        i++;
      }
      continue;
    }
    if (quote) {
      if (quote !== "`" && c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = "";
      continue;
    }
    if (c === "/" && n === "/") {
      comment = "line";
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      comment = "block";
      i++;
      continue;
    }
    if (c === '"' || c === "`" || c === "'") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return "";
}
function value(text, key) {
  const m = text.match(
    new RegExp("\\b" + key + ':\\s*("(?:[^"\\\\]|\\\\.)*"|`[^`]*`)'),
  );
  if (!m) return undefined;
  try {
    return m[1][0] === "`" ? m[1].slice(1, -1) : JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}
const catalog = [];
for (const file of await walk(path.join(source, "shortcuts"))) {
  if (!file.endsWith(".go") || file.endsWith("_test.go")) continue;
  const text = await readFile(file, "utf8");
  const matches = text.matchAll(/common\.Shortcut\s*\{/g);
  for (const m of matches) {
    const block = blockAt(text, text.indexOf("{", m.index));
    const service =
        value(block, "Service") ||
        (/Service:\s*appsService/.test(block) ? "apps" : undefined),
      command = value(block, "Command");
    if (!service || !command) continue;
    const flags = [];
    for (const fm of block.matchAll(/\{\s*Name\s*:/g)) {
      const f = blockAt(block, fm.index);
      const name = value(f, "Name");
      if (name)
        flags.push({
          name,
          description: value(f, "Desc") || "",
          type: value(f, "Type") || "string",
          default: value(f, "Default"),
          required: /Required:\s*true/.test(f),
          enum: [
            ...(f.match(/Enum:\s*\[\]string\{([^}]+)\}/)?.[1] || "").matchAll(
              /"([^"]+)"/g,
            ),
          ].map((x) => x[1]),
        });
    }
    catalog.push({
      service,
      command,
      description: value(block, "Description") || "",
      risk: value(block, "Risk") || "read",
      flags,
      source: path.relative(source, file),
    });
  }
}
const unique = [
  ...new Map(catalog.map((x) => [`${x.service} ${x.command}`, x])).values(),
].sort((a, b) =>
  `${a.service} ${a.command}`.localeCompare(`${b.service} ${b.command}`),
);
await mkdir("data/sheets", { recursive: true });
await writeFile("data/shortcuts.json", JSON.stringify(unique, null, 2) + "\n");
for (const name of ["flag-defs.json", "flag-schemas.json"])
  await cp(
    path.join(source, "shortcuts/sheets/data", name),
    path.join("data/sheets", name),
  );
await cp(path.join(source, "skills"), "skills", {
  recursive: true,
  filter: (p) =>
    !/[\\/]scripts(?:[\\/]|$)/.test(p) && !/[\\/]assets(?:[\\/]|$)/.test(p),
});
console.error(
  `Saved ${unique.length} shortcut definitions; copied declarative skills and sheet schemas.`,
);

const known = new Set(
  JSON.parse(await readFile("data/known-flags.json", "utf8")),
);
for (const file of [
  ...(await walk(path.join(source, "cmd"))),
  ...(await walk(path.join(source, "shortcuts"))),
]) {
  if (!file.endsWith(".go") || file.endsWith("_test.go")) continue;
  const text = await readFile(file, "utf8");
  for (const m of text.matchAll(/\bName:\s*"([a-z][a-z0-9-]*)"/g))
    known.add(m[1]);
}
await writeFile(
  "data/known-flags.json",
  JSON.stringify([...known].sort(), null, 2) + "\n",
);
