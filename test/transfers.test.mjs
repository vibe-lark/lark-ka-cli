import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestWithTransfers } from "../src/transfers.mjs";
const mock = (response) => ({
  identity: "user",
  requests: [],
  request: async (method, route, opts) => {
    response.calls.push({ method, route, ...opts });
    return response.value;
  },
});
test("generic API writes actual binary bytes to --output and does not truncate without --force", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lark-transfer-"));
  const output = path.join(dir, "result.bin"),
    response = { calls: [], value: Buffer.from([0, 255, 1, 2]) },
    ctx = mock(response);
  const result = await requestWithTransfers(
    ctx,
    "GET",
    "/open-apis/test",
    {},
    { output },
  );
  assert.equal(result.size_bytes, 4);
  assert.deepEqual(await readFile(output), response.value);
  assert.equal(response.calls[0].responseType, "buffer");
  await assert.rejects(
    () => requestWithTransfers(ctx, "GET", "/open-apis/test", {}, { output }),
    /exists/,
  );
  assert.equal(response.calls.length, 1);
});
test("generic API multipart supports a named field and JSON companion fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lark-transfer-")),
    file = path.join(dir, "image.bin");
  await writeFile(file, Buffer.from([0, 255, 4]));
  const response = { calls: [], value: { file_key: "file_test" } },
    ctx = mock(response);
  await requestWithTransfers(
    ctx,
    "POST",
    "/open-apis/test",
    { body: { image_type: "message", metadata: { x: 1 } } },
    { file: `image=${file}` },
    { fileFields: ["image"] },
  );
  const form = response.calls[0].body;
  assert.equal(form.get("image_type"), "message");
  assert.equal(form.get("metadata"), '{"x":1}');
  assert.deepEqual(
    Buffer.from(await form.get("image").arrayBuffer()),
    Buffer.from([0, 255, 4]),
  );
});
test("API transfer validation blocks conflicting modes, undeclared fields, and symlink output", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lark-transfer-"));
  const ctx = mock({ calls: [], value: Buffer.from("x") });
  await assert.rejects(
    () =>
      requestWithTransfers(
        ctx,
        "POST",
        "/open-apis/test",
        {},
        { file: "f=x", output: "x" },
      ),
    /cannot be combined/,
  );
  await assert.rejects(
    () =>
      requestWithTransfers(
        ctx,
        "POST",
        "/open-apis/test",
        {},
        { file: "f=x" },
        { fileFields: ["image"] },
      ),
    /not declared/,
  );
  const target = path.join(dir, "target"),
    link = path.join(dir, "link");
  await writeFile(target, "keep");
  await symlink(target, link);
  await assert.rejects(
    () =>
      requestWithTransfers(
        ctx,
        "GET",
        "/open-apis/test",
        {},
        { output: link, force: true },
      ),
    /symbolic/,
  );
  assert.equal(await readFile(target, "utf8"), "keep");
});
test("HTTP-200 API errors are not saved as successful downloaded files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lark-transfer-"));
  const ctx = mock({
    calls: [],
    value: Buffer.from('{"code":99991663,"msg":"No permission"}'),
  });
  await assert.rejects(
    () =>
      requestWithTransfers(
        ctx,
        "GET",
        "/open-apis/test",
        {},
        { output: path.join(dir, "error.bin") },
      ),
    /No permission/,
  );
});
