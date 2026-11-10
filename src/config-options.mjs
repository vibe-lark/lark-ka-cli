// Shared by configuration parsing, help, and the CLI flag allowlist.
// Customer-specific values are persisted in profiles, never compiled into code.
export const CONFIG_PARAMETERS = Object.freeze({
  "app-id": { key: "appId", description: "Application App ID" },
  brand: {
    key: "brand",
    description: "feishu | lark | gjgw | custom (private deployment)",
  },
  "open-base-url": { key: "openBaseUrl", description: "OpenAPI base URL" },
  "accounts-base-url": {
    key: "accountsBaseUrl",
    description: "Accounts/login base URL",
  },
  "web-base-url": {
    key: "webBaseUrl",
    description: "Document and Drive web base URL",
  },
  "authorize-url": {
    key: "authorizeUrl",
    description: "Complete OAuth authorization endpoint",
  },
  "token-url": {
    key: "tokenUrl",
    description: "Complete OAuth token exchange endpoint",
  },
  "refresh-token-url": {
    key: "refreshTokenUrl",
    description: "Optional separate refresh endpoint; defaults to --token-url",
  },
  "user-info-url": {
    key: "userInfoUrl",
    description: "Complete current-user endpoint",
  },
  "device-url": {
    key: "deviceUrl",
    description: "Optional device authorization endpoint",
  },
  "tenant-token-url": {
    key: "tenantTokenUrl",
    description: "Optional bot/tenant token endpoint",
  },
  "mcp-url": {
    key: "mcpUrl",
    description: "Optional remote document MCP endpoint",
  },
  "authorize-path": {
    key: "authorizePath",
    description: "Authorization path relative to Accounts base",
  },
  "token-path": {
    key: "tokenPath",
    description: "Token exchange path relative to OpenAPI base",
  },
  "refresh-token-path": {
    key: "refreshTokenPath",
    description: "Optional refresh path relative to OpenAPI base",
  },
  "user-info-path": {
    key: "userInfoPath",
    description: "Current-user path relative to OpenAPI base",
  },
  "device-path": {
    key: "devicePath",
    description: "Device authorization path relative to Accounts base",
  },
  "tenant-token-path": {
    key: "tenantTokenPath",
    description: "Tenant token path relative to OpenAPI base",
  },
  "auth-flow": { key: "authFlow", description: "authorization-code | device" },
  "client-id-param": {
    key: "clientIdParam",
    description: "Authorization query parameter: app_id | client_id",
  },
  "redirect-uri": {
    key: "redirectUri",
    description: "Registered OAuth callback URL",
  },
  scope: {
    key: "scope",
    description: "Approved OAuth scopes, space separated",
  },
  "docs-backend": { key: "docsBackend", description: "native | mcp | docs-ai" },
  "contact-search-version": {
    key: "contactSearchVersion",
    description: "Optional contact search API: v1 | v3",
  },
  "default-as": {
    key: "defaultAs",
    description: "Default identity: user | bot | auto",
  },
  "strict-mode": {
    key: "strictMode",
    description: "Allowed identity: user | bot | off",
  },
  "app-secret-env": {
    key: "appSecretEnv",
    description:
      "Environment variable containing App Secret (runtime reference)",
  },
  lang: { key: "lang", description: "Language preference" },
});

export const CONFIG_FLAGS = Object.freeze([
  ...Object.keys(CONFIG_PARAMETERS),
  "name",
  "deployment",
  "app-secret-stdin",
]);

export function configHelp() {
  return [
    "Usage: lark-ka config init --name CUSTOMER --brand custom --app-id APP_ID [flags]",
    "All customer addresses can be supplied as flags; --deployment @file.json is optional.",
    "Values are saved in a profile. Later commands only need --profile CUSTOMER.",
    "",
    ...Object.entries(CONFIG_PARAMETERS).map(
      ([flag, spec]) => `  --${flag.padEnd(25)} ${spec.description}`,
    ),
    "  --name                       Profile name (default: default)",
    "  --app-secret-stdin           Read App Secret once from stdin and save it locally",
    "  --deployment                Optional JSON input; explicit flags override file values",
    "",
    "--app-secret-stdin and --app-secret-env are mutually exclusive.",
    "config show | default-as user|bot|auto | strict-mode user|bot|off | remove",
    "",
  ].join("\n");
}
