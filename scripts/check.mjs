import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
async function walk(dir) {
  return (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
      ),
    )
  ).flat();
}
const files = (await Promise.all(["src", "bin", "scripts", "test"].map(walk)))
  .flat()
  .filter((f) => f.endsWith(".mjs"));
let failures = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (result.status) {
    process.stderr.write(result.stderr);
    failures++;
  }
}
if (failures) process.exit(1);
console.log(`Syntax OK: ${files.length} JavaScript modules`);
