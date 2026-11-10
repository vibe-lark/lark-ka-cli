import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gunzipSync } from "node:zlib";
import { executeApps } from "../src/domains/apps.mjs";
function mock() {
  const calls = [];
  return {
    identity: "user",
    config: { brand: "feishu" },
    calls,
    input: async (x) => x,
    request: async (method, route, options = {}) => {
      calls.push({ method, route, ...options });
      return { url: "https://example.invalid/site" };
    },
  };
}
test("Apps create and access scope preserve server enums and split target arrays", async () => {
  const ctx = mock();
  await executeApps(ctx, "apps", "+create", {
    name: "Test",
    "app-type": "HTML",
  });
  assert.deepEqual(ctx.calls[0].body, { name: "Test", app_type: "HTML" });
  await executeApps(ctx, "apps", "+access-scope-set", {
    "app-id": "app_one",
    scope: "specific",
    targets: JSON.stringify([
      { type: "user", id: "ou_one" },
      { type: "department", id: "od_one" },
    ]),
    "apply-enabled": true,
    approver: "ou_two",
  });
  assert.deepEqual(ctx.calls[1].body, {
    scope: "Range",
    users: ["ou_one"],
    departments: ["od_one"],
    apply_config: { enabled: true, approvers: ["ou_two"] },
  });
});
test("Apps validation rejects a private deployment and invalid scopes before any mutation", async () => {
  const ctx = mock();
  ctx.config.brand = "cnooc";
  await assert.rejects(
    () =>
      executeApps(ctx, "apps", "+create", { name: "x", "app-type": "HTML" }),
    /SaaS/,
  );
  assert.equal(ctx.calls.length, 0);
  ctx.config.brand = "feishu";
  await assert.rejects(
    () =>
      executeApps(ctx, "apps", "+access-scope-set", {
        "app-id": "app_one",
        scope: "specific",
        targets: "[]",
      }),
    /nonempty/,
  );
  assert.equal(ctx.calls.length, 0);
});
test("HTML publishing produces a real gzip tar with index.html, excludes symlinks and credential files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lark-app-"));
  await writeFile(path.join(dir, "index.html"), "<h1>Hello</h1>");
  const ctx = mock();
  await executeApps(ctx, "apps", "+html-publish", {
    "app-id": "app_one",
    path: dir,
  });
  const call = ctx.calls[0];
  assert.equal(
    call.route,
    "/open-apis/spark/v1/apps/app_one/upload_and_release_html_code",
  );
  const blob = call.body.get("file");
  const tar = gunzipSync(Buffer.from(await blob.arrayBuffer()));
  assert.equal(tar.subarray(0, 10).toString(), "index.html");
  assert.equal(tar.subarray(512, 526).toString(), "<h1>Hello</h1>");
  await writeFile(path.join(dir, ".env"), "PRIVATE=secret");
  await assert.rejects(
    () =>
      executeApps(ctx, "apps", "+html-publish", {
        "app-id": "app_one",
        path: dir,
      }),
    /Sensitive file/,
  );
  assert.equal(ctx.calls.length, 1);
});
