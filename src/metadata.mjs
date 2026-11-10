import { readFile } from "node:fs/promises";
import { requestWithTransfers, validateTransferFlags } from "./transfers.mjs";
import { CliError } from "./errors.mjs";
import { CONFIG_FLAGS } from "./config-options.mjs";
export const metadata = JSON.parse(
  await readFile(new URL("../data/api-metadata.json", import.meta.url), "utf8"),
);
export const shortcuts = JSON.parse(
  await readFile(new URL("../data/shortcuts.json", import.meta.url), "utf8"),
);
export function apiSpecs() {
  return metadata.services.flatMap((service) =>
    Object.entries(service.resources || {}).flatMap(([resource, r]) =>
      Object.entries(r.methods || {}).map(([method, spec]) => ({
        service: service.name,
        resource,
        method,
        ...spec,
        servicePath: service.servicePath,
      })),
    ),
  );
}
export function findAPI(words) {
  return apiSpecs().find(
    (s) =>
      words.join(" ") === `${s.service} ${s.resource} ${s.method}` ||
      words.join(".") === s.id ||
      words.join(" ") ===
        `${s.service} ${s.resource.replaceAll(".", " ")} ${s.method}`,
  );
}
export async function executeAPI(ctx, spec, flags) {
  validateTransferFlags(spec.httpMethod, flags);
  let params = flags.params ? JSON.parse(await ctx.input(flags.params)) : {};
  let body = flags.data
    ? JSON.parse(await ctx.input(flags.data))
    : flags.body
      ? JSON.parse(await ctx.input(flags.body))
      : undefined;
  let route = spec.path;
  const query = {};
  for (const [key, definition] of Object.entries(spec.parameters || {})) {
    const value =
      params[key] ?? flags[key.replaceAll("_", "-")] ?? definition.default;
    if (definition.required && (value === undefined || value === ""))
      throw new CliError("validation", `Missing parameter: ${key}`);
    if (value === undefined || value === "") continue;
    if (definition.location === "path")
      route = route
        .replaceAll(`{${key}}`, encodeURIComponent(String(value)))
        .replaceAll(`:${key}`, encodeURIComponent(String(value)));
    else query[key] = value;
  }
  for (const [key, value] of Object.entries(params))
    if (!(spec.parameters?.[key]?.location === "path")) query[key] = value;
  if (/\{\w+\}/.test(route))
    throw new CliError("validation", `Unresolved path parameters: ${route}`);
  const apiPath = route.startsWith("/open-apis/")
    ? route
    : `${spec.servicePath.replace(/\/$/, "")}/${route.replace(/^\//, "")}`;
  const fileFields = Object.entries(spec.requestBody || {})
    .filter(([, value]) => value.type === "file")
    .map(([key]) => key);
  return requestWithTransfers(
    ctx,
    spec.httpMethod,
    apiPath,
    { query, body },
    flags,
    { fileFields },
  );
}

export const knownFlags = new Set([
  ...CONFIG_FLAGS,
  ...JSON.parse(
    await readFile(
      new URL("../data/known-flags.json", import.meta.url),
      "utf8",
    ),
  ),
]);
