# lark-ka-cli

面向飞书 / Lark / 私有化部署的 **Node.js 原生 CLI**。要求 **Node.js >=22**。运行、安装和业务请求均不依赖 Go、Go 二进制或 Go 源码。

命令名为 `lark-ka`，同时提供 `lark-cli` 别名以便迁移现有调用；若本机已经装有官方 `lark-cli`，优先使用 `lark-ka` 避免混淆。

## 本地运行

```bash
npm ci
node bin/lark-ka.mjs --version
node bin/lark-ka.mjs --help
npm test
npm run check
npm run compatibility
```

也可以在该目录执行 `npm link` 后使用 `lark-ka`。本工程没有安装后下载官方内核的脚本。

## 通过参数配置客户环境

所有客户地址、App ID、Scope 和登录方式都可以通过 `config init` 参数传入，保存到独立 Profile。换客户时创建新的 Profile 并替换参数值即可，无需编辑 JSON 文件或修改源码。

下面以 `customer-a` 为例。所有 `.example.invalid` 地址、App ID 和 Scope 都是占位值，执行前替换为客户提供的实际配置。若在源码目录验证，可将 `lark-ka` 换成 `node bin/lark-ka.mjs`。

```bash
# 发布后从实际企业 npm 仓库安装；本地也可以安装生成的 tgz。
npm install -g @lark-ka/cli@0.1.0 --registry="https://npm.customer-a.example.invalid/"

# 只传客户参数，不需要配置文件。
lark-ka config init --name customer-a \
  --brand custom \
  --app-id cli_EXAMPLE_APP_ID \
  --open-base-url "https://open.customer-a.example.invalid" \
  --accounts-base-url "https://accounts.customer-a.example.invalid" \
  --web-base-url "https://docs.customer-a.example.invalid" \
  --authorize-url "https://accounts.customer-a.example.invalid/REPLACE_WITH_AUTHORIZATION_PATH" \
  --token-url "https://open.customer-a.example.invalid/REPLACE_WITH_TOKEN_PATH" \
  --user-info-url "https://open.customer-a.example.invalid/REPLACE_WITH_USER_INFO_PATH" \
  --auth-flow authorization-code \
  --client-id-param client_id \
  --redirect-uri "http://127.0.0.1:8989/lark/oauth/callback" \
  --scope "客户已批准的 Scope" \
  --docs-backend native \
  --default-as user \
  --strict-mode user
```

员工在内网或 VPN 环境使用。回调 URL 需先在客户自建应用后台登记。客户的实际 OAuth 参数名称可能是 `client_id` 或 `app_id`，以对应接口说明为准。

### 配置 App Secret

两种方式任选其一，不能同时指定：

- `--app-secret-stdin`：从标准输入读取并保存到受限的本地凭据文件。预置一次后，后续授权、注销、状态检查不需要重复设置 Secret 环境变量。
- `--app-secret-env CUSTOMER_A_APP_SECRET`：只保存环境变量名称。CLI 每次运行都需由实际执行环境提供该变量。

例如，在实际执行 CLI 的员工电脑或管理终端中，用安全输入流为已有 Profile 配置 Secret：

```bash
# Bash / zsh 交互式终端示例，输入时不回显；不用于后台无交互的安装命令。
read -rs CUSTOMER_A_APP_SECRET
printf '%s' "$CUSTOMER_A_APP_SECRET" | lark-ka config init --name customer-a --app-secret-stdin
unset CUSTOMER_A_APP_SECRET
```

若使用环境变量引用模式，在创建或更新 Profile 时增加 `--app-secret-env CUSTOMER_A_APP_SECRET`。豆包后台不同阶段的命令若不共享该环境变量，应使用一次预置并保存凭据的方式。

### 后续命令与切换客户

地址和 Scope 已保存，后续只需要同一个 Profile 名称：

```bash
lark-ka --profile customer-a auth login --json
lark-ka --profile customer-a auth whoami --as user --json
lark-ka --profile customer-a auth status --connector
lark-ka --profile customer-a auth logout
```

配置第二个客户时，复制初始化命令，将 `--name` 改为 `customer-b`，并替换对应地址、App ID、Scope 和凭据。随后所有业务命令使用 `--profile customer-b`；同一个 npm 包可服务多个客户。

### 可选接口参数

| 参数                                  | 用途                                                           |
| ------------------------------------- | -------------------------------------------------------------- |
| `--refresh-token-url`                 | 刷新 token 的完整地址；客户刷新接口与换取 token 接口不同时使用 |
| `--device-url`                        | 使用设备授权流程时的完整授权接口地址                           |
| `--tenant-token-url`                  | 需要机器人身份时，获取 tenant token 的完整地址                 |
| `--mcp-url`                           | 客户实际可用的 MCP 文档服务完整地址                            |
| `--docs-backend native\|mcp\|docs-ai` | 选择原生 docx、MCP 或 docs_ai 文档接口                         |

JSON 配置方式仍然可用，适合统一保存部署模板：

```bash
lark-ka config init --name customer-a --deployment @./config/cnooc.example.json
```

命令行显式参数优先于 JSON 模板。公有版可选择 `--brand feishu` 或 `--brand lark`。`gjgw` 保留为兼容的私有化品牌名称；所有私有化客户均通过参数或 Profile 提供实际地址，公开代码不内置客户域名。原先依赖默认域名的 Profile 需补齐客户地址参数。

默认配置目录是 `~/.lark-ka-cli`；可通过 `LARK_KA_CONFIG_DIR` 覆盖，也支持 `LARKSUITE_CLI_CONFIG_DIR`。凭据和会话使用独立的、权限为 `0600` 的本地 JSON 文件，按应用和接口环境隔离。

## 使用示例

```bash
# 不调用真实 API 的请求预览
node bin/lark-ka.mjs im +messages-send --as user \
  --chat-id oc_EXAMPLE --text "hello" --dry-run

# 通用 API 与元数据 API 命令
node bin/lark-ka.mjs api GET /open-apis/calendar/v4/calendars --as user
node bin/lark-ka.mjs calendar calendars list --as user
node bin/lark-ka.mjs schema calendar.calendars.list

# 文档、表格、多维表格
node bin/lark-ka.mjs docs +fetch --doc DOC_TOKEN --as user
node bin/lark-ka.mjs sheets +workbook-info --spreadsheet-token SHEET_TOKEN
node bin/lark-ka.mjs base +base-get --base-token BASE_TOKEN

# 内置 MCP stdio 服务与事件
node bin/lark-ka.mjs mcp serve
node bin/lark-ka.mjs event consume im.message.receive_v1 --max-events 1 --timeout 30
```

JSON 结果写 stdout，错误写 stderr；支持 `@file` / stdin、分页、dry-run、JSON / table / CSV / NDJSON 输出。`--jq` 当前支持字段路径、数组展开、索引及路径管道，不包含完整 jq 语言。

## 迁移范围与验证边界

`data/shortcuts.json` 根据原项目静态导出快捷命令，`data/api-metadata.json` 保存开放平台元数据和本地覆盖项；运行时不读取原 Go 工程，也不自动从公网刷新客户接口。

`npm run compatibility` 生成 `docs/compatibility.json`，列出每条命令的实现登记与已知差异；可读版见 [兼容性说明](docs/compatibility.md)。**命令入口覆盖不等于 Go 版每个选项、输出归一化及所有边界行为均已等价**。高级文档格式、白板、邮件合成、同步等分支以兼容性报告和测试为准；不支持的输入会明确报错，不会伪装成已成功执行。

测试使用本地 HTTP 服务及 mock API，覆盖授权回调与 state、令牌、身份检查、请求结构、文档及业务工作流等。客户环境尚未提供真实域名和凭据，未执行海油的真实 API 联调。

本版本的本地凭据方案不等同于“真实飞书 token 全部保存在集中认证后端”的方案。

## 分发与豆包工作

```bash
# 公开版本发布至 npm 官方后安装，要求 Node.js >=22。
npm install -g @lark-ka/cli@0.1.0 --registry=https://registry.npmjs.org/

# 国内镜像同步到该版本后也可以安装。
npm install -g @lark-ka/cli@0.1.0 --registry=https://registry.npmmirror.com/
lark-ka --version

# 本地打包与安装。
npm pack
npm install -g /absolute/path/to/lark-ka-cli-0.1.0.tgz
```

镜像同步可能有延迟，可通过 `npm view @lark-ka/cli@0.1.0 version --registry=https://registry.npmmirror.com/` 查询。企业后台配置见 [docs/doubao-connector.md](docs/doubao-connector.md)。

## 更新命令定义

```bash
# 仅开发时从指定参考工程导出声明；不是运行依赖。
node scripts/generate-catalog.mjs /path/to/reference-project
npm run metadata:fetch
```

元数据获取命令显式访问官方开放平台。私有化部署可使用审核过的本地元数据快照，发布运行时不必访问公有开放平台。
