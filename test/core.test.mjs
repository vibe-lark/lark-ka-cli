import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { parseArgs } from "../src/args.mjs";
import { CliError, redact, toErrorEnvelope } from "../src/errors.mjs";
import { resolveInput, readJSONInput, formatOutput } from "../src/io.mjs";

test("parser keeps command paths and supports flags before and after commands", () => {
  assert.deepEqual(
    parseArgs([
      "--dry-run",
      "--profile",
      "customer",
      "docs",
      "+fetch",
      "--doc=https://example.test/docx/a",
      "-q",
      ".data",
      "-oresult.json",
    ]),
    {
      positionals: ["docs", "+fetch"],
      flags: {
        "dry-run": true,
        profile: "customer",
        doc: "https://example.test/docx/a",
        jq: ".data",
        output: "result.json",
      },
    },
  );
});

test("parser preserves no-wait and generic negative flags, repeated values and negatives", () => {
  assert.deepEqual(
    parseArgs([
      "auth",
      "login",
      "--no-wait",
      "--no-open",
      "--scope",
      "docs",
      "--scope=im",
      "--offset",
      "-1",
      "--limit=-2",
      "--verify=false",
    ]),
    {
      positionals: ["auth", "login"],
      flags: {
        "no-wait": true,
        "no-open": true,
        scope: ["docs", "im"],
        offset: "-1",
        limit: "-2",
        verify: false,
      },
    },
  );
});

test("parser handles help/version aliases, explicit booleans, and end of flags", () => {
  assert.deepEqual(
    parseArgs(["-h", "-v", "--json", "false", "--", "--unknown", "-1"]),
    {
      positionals: ["--unknown", "-1"],
      flags: { help: true, version: true, json: false },
    },
  );
  assert.throws(() => parseArgs(["-q"]), /requires a value/);
  assert.throws(() => parseArgs(["--dry-run=maybe"]), /requires true or false/);
});

test("parser rejects unsafe flag keys and NUL in positional and consumed values", () => {
  assert.throws(() => parseArgs(["--constructor=x"]), CliError);
  assert.throws(() => parseArgs(["--__proto__=x"]), CliError);
  assert.throws(() => parseArgs(["--text", "bad\0text"]), CliError);
  assert.throws(() => parseArgs(["--", "bad\0text"]), CliError);
  assert.equal(Object.prototype.polluted, undefined);
});

test("error envelopes redact structured and inline credentials without dumping stacks", () => {
  const original = new CliError(
    "auth",
    "Bearer actualtoken --app-secret clearsecret https://example.test/?code=privatecode",
    {
      code: 3,
      hint: "access_token=secrettoken",
      detail: {
        nested: { appSecret: "secretvalue" },
        items: [{ refresh_token: "refreshvalue" }],
        page_token: "pagination",
      },
    },
  );
  const result = toErrorEnvelope(original);
  const encoded = JSON.stringify(result);
  assert.equal(result.ok, false);
  assert.equal(result.error.type, "auth");
  assert.equal(result.error.code, 3);
  assert.equal(result.error.detail.page_token, "pagination");
  for (const value of [
    "actualtoken",
    "clearsecret",
    "privatecode",
    "secrettoken",
    "secretvalue",
    "refreshvalue",
  ])
    assert.ok(!encoded.includes(value));
  assert.equal(result.error.stack, undefined);
  assert.equal(original.detail.nested.appSecret, "secretvalue");
  assert.equal(toErrorEnvelope(new Error("unexpected")).error.code, 1);
});

test("redaction handles cycles and harmless duplicate references", () => {
  const shared = { name: "alice" };
  const value = { first: shared, second: shared };
  value.self = value;
  const result = redact(value);
  assert.equal(result.first.name, "alice");
  assert.equal(result.second.name, "alice");
  assert.equal(result.self, "[Circular]");
});

test("input supports literal data, buffers, streams, BOM, and JSON parsing", async () => {
  assert.equal(await resolveInput("literal"), "literal");
  assert.equal(await resolveInput("-", { stdin: "\uFEFFhello" }), "hello");
  assert.equal(
    await resolveInput("-", { stdin: Buffer.from("buffer") }),
    "buffer",
  );
  assert.equal(
    await resolveInput("-", { stdin: Readable.from(["a", "b"]) }),
    "ab",
  );
  assert.deepEqual(await readJSONInput("-", { stdin: '{"a":1}' }), { a: 1 });
  await assert.rejects(readJSONInput("broken"), /not valid JSON/);
  await assert.rejects(resolveInput("-", { stdin: "a\0b" }), /NUL/);
});

test("file input accepts explicit absolute regular files and rejects traversal, links, directories", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "lark-node-input-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data.json");
  await writeFile(file, '\uFEFF{"ok":true}');
  assert.deepEqual(await readJSONInput(`@${file}`), { ok: true });
  await assert.rejects(resolveInput("@../outside"), /traversal/);
  await assert.rejects(resolveInput("@"), /requires a path/);
  await assert.rejects(resolveInput(`@${dir}`), /regular file/);
  await writeFile(file, "binary\0data");
  await assert.rejects(resolveInput(`@${file}`), /NUL/);
  if (process.platform !== "win32") {
    const link = path.join(dir, "link");
    await symlink(file, link);
    await assert.rejects(resolveInput(`@${link}`), /Cannot read input file/);
  }
  await mkdir(path.join(dir, "folder"));
});

test("output emits JSON, NDJSON, CSV escaped cells, and tables with sparse columns", () => {
  const value = [
    { name: "张三", note: 'line\n"quote",comma' },
    { name: "Alice", n: 2 },
  ];
  assert.deepEqual(JSON.parse(formatOutput(value)), value);
  assert.equal(formatOutput([1, 2], { format: "ndjson" }), "1\n2\n");
  assert.equal(
    formatOutput(value, { format: "csv" }),
    'name,note,n\n张三,"line\n""quote"",comma",\nAlice,,2\n',
  );
  const table = formatOutput(value, { format: "table" });
  assert.ok(table.includes("张三"));
  assert.ok(table.includes("Alice"));
  assert.equal(table.split("\n").length, 5);
  assert.equal(formatOutput([], { format: "csv" }), "");
  assert.throws(
    () => formatOutput(value, { format: "yaml" }),
    /Unknown output format/,
  );
});

test("jq path selection supports arrays, quoted property names, and pipes without evaluating code", () => {
  const value = { data: { items: [{ name: "a" }, { name: "b" }] }, "a-b": [3] };
  assert.equal(
    formatOutput(value, { jq: ".data.items[] | .name" }),
    '"a"\n"b"\n',
  );
  assert.equal(formatOutput(value, { jq: '.["a-b"][0]' }), "3\n");
  assert.throws(
    () => formatOutput(value, { jq: "process.exit()" }),
    /Unsupported jq/,
  );
});
