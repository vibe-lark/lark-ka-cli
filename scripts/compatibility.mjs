import { readFile, writeFile, mkdir } from "node:fs/promises";
import { shortcuts, apiSpecs } from "../src/metadata.mjs";
import { commands as im } from "../src/domains/im.mjs";
import { commandSpecs as collaboration } from "../src/domains/collaboration.mjs";
import {
  CONTENT_COVERAGE as content,
  CONTENT_LIMITATIONS,
} from "../src/domains/content.mjs";
import { commandSpecs as tables } from "../src/domains/tables.mjs";
import { commandSpecs as apps } from "../src/domains/apps.mjs";
const coverage = {
  ...content,
  base: tables.base,
  sheets: tables.sheets,
  im: Object.fromEntries(im.map((c) => [c, "implemented"])),
  apps: apps.apps,
  event: { "+subscribe": "implemented" },
};
for (const spec of Object.values(collaboration))
  (coverage[spec.service] ||= {})[spec.command] = "implemented";
const commands = shortcuts.map((spec) => ({
  service: spec.service,
  command: spec.command,
  implementation: coverage[spec.service]?.[spec.command]
    ? "native-node"
    : "missing",
  notes:
    typeof coverage[spec.service]?.[spec.command] === "string"
      ? coverage[spec.service][spec.command]
      : undefined,
}));
const missing = commands.filter((c) => c.implementation === "missing");
const report = {
  node: ">=22",
  implementation: "native-nodejs",
  goRuntimeRequired: false,
  shortcutCount: commands.length,
  metadataAPICount: apiSpecs().length,
  missing,
  commands,
  contentLimitations: CONTENT_LIMITATIONS,
  behaviorDifferences: [
    "Optional Go auth-sidecar isolation is rejected explicitly; no direct-credential fallback is allowed.",
    "OS keychain and compiled Go plugins are not reused; this implementation uses separate restricted local credential files.",
    "Some advanced document, MIME, whiteboard and synchronization options are explicitly rejected when unavailable; refer to implementation notes.",
    "jq supports path extraction and array/index pipelines; the entire jq language is not implemented.",
    "Private customer endpoints and live API compatibility require the customer configuration and credentials.",
  ],
};
await mkdir("docs", { recursive: true });
await writeFile(
  "docs/compatibility.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      shortcuts: commands.length,
      metadataAPIs: apiSpecs().length,
      missing: missing.length,
      byService: Object.fromEntries(
        [...new Set(commands.map((x) => x.service))].map((service) => [
          service,
          commands.filter((x) => x.service === service).length,
        ]),
      ),
    },
    null,
    2,
  ),
);
if (missing.length) {
  console.error(JSON.stringify(missing));
  process.exitCode = 1;
}
