# dsh-coding-agents

**在 DeepSeek Harness 里统一控制本机 Codex 与 Claude Code：会话、配置、运行状态，都在设置页和 Agent 工具里。**

[![npm version](https://img.shields.io/npm/v/dsh-coding-agents?logo=npm&label=npm)](https://www.npmjs.com/package/dsh-coding-agents)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22.19%20%7C%2024-339933?logo=node.js&logoColor=white)](#环境要求)

[English](README.md) | 中文

插件只调用 Codex / Claude Code 公开且稳定的本地接口，不解析也不改写它们的私有数据库；所有写操作要么走厂商官方配置协议，要么备份加原子替换。

## 环境要求

| 项 | 值 |
| --- | --- |
| DSH | 0.2.1-rc.5（Cordis `4.0.5`，`@deepseek-ai/*` 0.2.1-rc.5） |
| Node.js | `^22.19.0 \|\| ^24.0.0` |
| 宿主注入 | `webServer`、`subprocess`、`tools` |
| 客户端注入 | `slots`（在「设置 → 编程助手」注册一个 section） |
| 随包依赖 | `@openai/codex`、`@anthropic-ai/claude-agent-sdk` 及其本机原生程序（安装体积较大） |

## 安装

包内附带 `cordis.patch.yml` 与 `dsh.bundle.patch`，可作 bundle 安装：

```bash
dsh plugin --profile <profile> add dsh-coding-agents
```

也可以只在 profile 的 `cordis.patch.yml` 里插入一条 loader entry：

```yaml
- insert:
    - id: dsh-coding-agents
      name: 'dsh-coding-agents'
```

重启该 profile 后打开**设置 → 编程助手**。

## 能做什么

- 跨 Codex 和 Claude Code 搜索本机历史会话，分页读取超长记录。
- 新建、继续或分叉原生会话，实时展示文本、工具调用与运行状态，支持取消。
- 重命名、打标签、归档/取消归档、回滚、删除会话；对某个引擎不适用的操作会明确拒绝而不是静默失败。
- 查看配置的当前值、生效值与来源；Codex 走官方配置协议写入，Claude Code 用备份 + 原子替换。
- 图形界面操作之外，DSH Agent 也可以直接调用 6 个 `coding_agent_*` 工具完成同样的事。

## 自然语言示例

- 「列出 Codex 和 Claude Code 最近的会话。」
- 「查一下包含登录故障的历史记录。」
- 「继续这个 Codex 会话并跑测试。」
- 「用 Claude Code 在当前工作区新建任务，修复构建错误。」
- 「读取 Codex 当前配置。」

插件只控制**当前用户已安装且可用**的产品；运行任务默认使用工作区可写权限。完全访问不能从网页或模型工具获得，只有在 DSH 界面里由用户自己启动任务时才可能启用。

## 安全边界

- **HTTP 只服务本机回环与同源请求。** `/coding-agents-api` 会拒绝：TCP 对端不是本机的请求（403）、`Origin` 不等于 `http://<Host 头>` 的浏览器请求（403）、`Sec-Fetch-Site: cross-site` 的请求（403）、没有 `content-type: application/json` 的 POST（415），以及 CORS 预检 `OPTIONS`（405）。因此任意网页都无法驱动本机的 Codex / Claude Code —— 包括用「简单请求」绕过预检的那条路。
- **HTTP 不提供完全访问。** 该接口只接受 `read-only` 与 `workspace-write`；`full-access`（Claude Code 的 `bypassPermissions`、Codex 的 `danger-full-access`）只能在 DSH 界面中由用户确认。模型工具同样封顶：`coding_agent_run` 会拒绝 `full-access` 并给出可执行的提示。
- **`cwd` 限定在已注册工作区内。** 只有解析后落在 DSH 已注册 workspace 内的路径才被接受；路径会规范化，越界（含兄弟目录前缀）一律拒绝。宿主没有 workspace 注册表时，带 `cwd` 的请求直接被拒绝，而不是相信调用方。
- **配置写入白名单。** HTTP 只允许写 Codex 的 `model` / `model_reasoning_effort` 与 Claude Code 的 `permissions.defaultMode`；MCP server、hooks、权限预设等其它键只能走 DSH 界面或手工编辑。两个引擎写入前都会备份（Claude Code：备份 + 原子替换；Codex：先写 `config.toml.backup-dsh-<时间戳>` 再走官方配置协议）。
- 不读取厂商私有数据库；只用公开的本地接口。
- 进程由宿主的 `subprocess` 服务托管，环境变量经过清洗（`scrubbedParentEnv`）。
- 会话操作按会话所属工作区隔离。

## 开发

```bash
npm install
npm run typecheck   # 源码 + 客户端 + 测试
npm run build       # tsc → lib/，esbuild → lib/client.js
npm test            # vitest
npm run smoke:host  # 真实 cordis Context + 桩宿主服务里加载 lib/index.js
```

`lib/client.js` 是 `window.__ModuleLoader__.load({ id, factory })` 闭包工厂形态，由 `scripts/verify-client.mjs` 静态校验并在沙箱执行；宿主导出契约由 `scripts/verify-host.mjs` 校验（真实 `@deepseek-ai/cordis` 加载、路由与工具注册、卸载清理）。

## 已知限制

- 需要本机已安装并登录对应的 Codex / Claude Code；未安装时对应引擎不可用，插件会给出明确状态。
- 原生可执行文件在模块加载期解析，缺失时整个插件 import 失败（与 0.1.5 行为一致，后续版本会惰性化）。
- 安装依赖较大（随包原生程序），首次安装耗时取决于网络。
- HTTP API 按设计只接受回环 `http://`；TLS 或非回环的 DSH Web 部署会被拒绝，而不是降级放行。

## License

MIT © WilShi
