import { writeFile, mkdir, readFile } from "node:fs/promises";
const url =
  "https://open.feishu.cn/api/tools/open/api_definition?protocol=meta&client_version=1.0.48";
const response = await fetch(url, {
  signal: AbortSignal.timeout(30000),
  redirect: "error",
});
if (!response.ok) throw new Error(`Metadata HTTP ${response.status}`);
const envelope = await response.json();
const data = envelope.data;
if (!Array.isArray(data?.services) || !data.services.length)
  throw new Error("Empty metadata registry");
const overlay = JSON.parse(
  await readFile(
    new URL("../data/im-chats-delete.overlay.json", import.meta.url),
    "utf8",
  ),
);
for (const [name, patch] of Object.entries(overlay.services)) {
  const service = data.services.find((s) => s.name === name);
  if (service)
    for (const [resource, r] of Object.entries(patch.resources)) {
      service.resources[resource] ||= { methods: {} };
      Object.assign(service.resources[resource].methods, r.methods);
    }
}
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../data/api-metadata.json", import.meta.url),
  JSON.stringify(data),
);
console.error(`Saved ${data.services.length} API services`);
