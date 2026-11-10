# 豆包工作企业后台 CLI 连接器

适用于员工在客户内网或连接 VPN 后使用豆包工作。运行时要求 **Node >=22**。

同一份 CLI 可以供不同客户使用。客户域名、App ID、Scope 等直接写在 `config init` 参数中，保存成独立 Profile；不需要编辑 JSON 或修改源码。

## 安装栏：添加安装与配置两条命令

第一条安装 CLI。包发布后，填写实际版本及仓库地址：

```bash
npm install -g @lark-ka/cli@0.1.0 --registry="https://npm.customer-a.example.invalid/"
```

第二条保存客户的固定配置。下面所有示例地址、App ID 和 Scope 都要替换成客户提供的真实值；在后台输入框内可合并成一行：

```bash
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

客户的刷新接口、设备授权接口、机器人 token 接口或 MCP 地址需要单独指定时，可增加 `--refresh-token-url`、`--device-url`、`--tenant-token-url`、`--mcp-url`。文档接口通过 `--docs-backend native`、`mcp` 或 `docs-ai` 选择。

初始化命令会把配置保存到当前执行电脑的 `customer-a` Profile。相同参数可以重复执行；也可以将这条非敏感固定配置命令放到授权栏，排在登录命令之前。

## App Secret：在实际执行环境预置

任选一种方式，二者不能同时使用：

| 方式         | 配置方法                                                                      | 后续命令要求                               |
| ------------ | ----------------------------------------------------------------------------- | ------------------------------------------ |
| 本地保存     | 通过安全输入流执行 `lark-ka config init --name customer-a --app-secret-stdin` | 预置一次，后续不需要重复提供环境变量       |
| 环境变量引用 | 初始化时增加 `--app-secret-env CUSTOMER_A_APP_SECRET`                         | CLI 每次运行时都需要实际执行环境提供该变量 |

如果后台的安装、授权、状态检查不共享环境变量，使用一次预置并保存凭据的方式。真实 Secret 通过客户认可的渠道配置，不放入面向所有员工的共享命令中。

## 其他后台字段

| 后台配置项   | 填写内容                                               |
| ------------ | ------------------------------------------------------ |
| 连接器类型   | CLI 连接器                                             |
| 网络要求     | 仅内网可用                                             |
| 运行时       | Node >=22                                              |
| CLI 命令名称 | `lark-ka`                                              |
| 授权命令     | `lark-ka --profile customer-a auth login --json`       |
| 取消授权命令 | `lark-ka --profile customer-a auth logout`             |
| 授权状态命令 | `lark-ka --profile customer-a auth status --connector` |
| 授权成功正则 | `"loggedIn"\s*:\s*true`                                |
| 版本检查命令 | `lark-ka --version`                                    |

所有授权、注销、状态及业务命令中的 `--profile` 必须与初始化时的 `--name` 一致。地址和 Scope 已保存，后续命令不用重复填写。

换客户时，将初始化命令改成 `--name customer-b`，替换对应客户的地址、App ID、Scope 和凭据，并将后续命令统一改成 `--profile customer-b`。安装的 CLI 包保持相同。

授权状态中的 `loggedIn` 专指员工会话。`--connector` 会真实校验当前员工身份；网络故障返回错误，不会自动视为授权成功。

JSON 模板方式仍可选：`lark-ka config init --name customer-a --deployment @./config/cnooc.example.json`，命令行显式参数会覆盖模板对应字段。

关联 Skill 可以使用包内的 `skills/` 目录，具体能力范围对照 [兼容性说明](compatibility.md) 确认。
