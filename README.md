# dsh-tauri-acp

DeepSeek Harness 桌面插件：用 ACP（[Agent Client Protocol](https://agentclientprotocol.com)）把外部 Agent（Codex、Claude Code、Gemini CLI 等）注册成 dsh 的模型提供方。在模型选择器里选中它，对话就会交给这个 Agent 处理。

## 工作方式

- 每个配置项是一个 provider 路由，插件按需拉起该 Agent 子进程（stdio JSON-RPC），进程常驻复用。
- 每个 dsh 会话对应一个 ACP 会话，后续轮次只发送新增的用户消息；历史对不上（切过模型、被压缩）时自动新建 ACP 会话，并把历史压平成 `<conversation_history>` 一次性带过去。
- 模型列表来自 Agent 的 `configOptions`（`category: "model"`），兼容旧版 `models` + `session/set_model`；`default` 表示用 Agent 自己的默认模型。
- 模型元数据来自 Agent 本身（需要时会先启动一次 Agent 探测，受 `discoverModels` 控制）：
  - **推理等级**：Agent 的 `thought_level` 选项映射成 dsh 的推理等级，模型选择器里出现「推理等级」菜单；选中的等级经 `session/set_config_option` 设置，Agent 会话初始的等级作为默认等级上报（选择器里打勾的那一项，不再额外出现 dsh 自己的 Default）；Agent 对当前模型不提供的等级会被忽略并记日志。
  - **图片输入**：Agent 在 `initialize` 里声明 `promptCapabilities.image` 且 dsh 挂了附件服务时，模型声明为 文本+图片，图片按 dsh 的请求尺寸（与 pi-ai 默认相同：≤4MP、≤1MB）重新编码后作为 ACP `image` 块发送；否则按文本占位。
  - **上下文窗口**：优先用 `models[].contextWindow`，其次用 Agent 通过 `usage_update.size` 上报的大小（对话一轮后才知道，记在 `$DSH_HOME/cache/dsh-tauri-acp/context-windows.json`，重启后首轮直接可用），再次是模型 id、名称或描述里的 `1m` 标记（如 `claude-fable-5-1[1m]`、`(1M context)`，按 1000000 算），最后是 `contextWindow` 配置。ACP 在一轮对话前不提供窗口大小，所以从没跑过的模型首轮仍按配置值算。
- `agent_message_chunk` 映射为正文，`agent_thought_chunk`、工具调用、计划映射为推理块；`usage` 按会话累计值做差分。
- 工作目录取当前 dsh 会话的 workspace，取不到时回退到 `cwd` 配置或用户主目录。
- Agent 的权限请求默认走 dsh 原生审批框（`ctx.approval`）。
- 标题生成、压缩等辅助调用使用一次性 ACP 会话，不影响主会话。

## 安装到桌面端

插件是标准的 dsh bundle 包（`dsh.bundle.patch` → `cordis.patch.yml`）。先构建：

```bash
git clone https://github.com/Fleey/deepseek-harness-acp.git
cd deepseek-harness-acp
npm install && npm run build
```

然后在 `~/.dsh/profiles/desktop/package.json` 里加上依赖和 bundle，重启桌面端：

```json
{
  "dependencies": {
    "dsh-tauri-acp": "link:/path/to/deepseek-harness-acp"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-tauri-acp"]
    }
  }
}
```

然后在档案目录执行一次安装来建立链接。要用和桌面端相同的 pnpm（看 `node_modules/.modules.yaml` 里的 `packageManager`，当前是 11.8.0，需要 Node ≥ 22.13），否则 pnpm 会要求清空整个 `node_modules`：

```bash
cd ~/.dsh/profiles/desktop && npx -y pnpm@11.8.0 install --prefer-offline --config.minimum-release-age=0
```

link 模式下，插件会从本仓库的 `node_modules` 解析 `@deepseek-ai/dsh-llm`，和宿主不是同一个实例。所以适配器的失败一律以带内 `finish` 返回，不依赖 `instanceof LlmError`。改完代码执行 `npm run build`，再重启桌面端即可生效。

也可以放进 dsh-desktop 仓库的 `packages/`，再加进 `dsh-tauri-bundle` 的依赖里随包内置。

## 设置页

插件带一个客户端设置页：设置 → **ACP Agents**（排在官方「模型」页之后），不用手写 YAML 就能添加、编辑、删除 Agent。

- 表单字段：路由名、显示名、启动命令、参数（每行一个）、环境变量（每行一个 `KEY=VALUE`）、认证方法、权限策略、模型列表。表单不展示的字段（`cwd`、`systemPrompt`、超时等）保存时原样保留。
- **导入 JSON**：粘贴其他 ACP 客户端的配置一次导入多个 Agent，支持 Zed 的 `agent_servers`（也认 `agentServers`）、本插件自己的 `agents` 段，或直接的 `{ "名称": { "command", "args", "env" } }` 映射，其他键（如 `default_mcp_settings`）忽略。名称转成路由名（`CodeBuddy Code` → `codebuddy-code`，没有字母数字的名称用 `agent`，重名加 `-2`），原名作为显示名。先预览：每项标「新增」或「覆盖」，缺 `command`、`args` 不是字符串数组、`env` 不是字符串映射的条目列为跳过。每项前有复选框（默认全选，可一键全选/全不选），只导入勾选的。覆盖已有路由时只替换显示名、命令、参数和环境变量，权限、认证方法、模型等设置保留。勾选的条目一次原子写入。没带 `PATH` 的条目（如 `codebuddy`、`traecli`）用的是桌面端自己的 `PATH`，从 Dock 启动时可能找不到命令，必要时改成绝对路径或在 env 里补 `PATH`。
- **发现模型**：按已保存的命令启动 Agent，读取它公布的模型并追加到列表（已有的行不动）。发现请求只能带路由名、带不了命令行，所以新 Agent 要先保存；编辑中未保存的命令修改也不会参与发现。发现结果不受 `models`、`discoverModels` 影响，总是 Agent 自己公布的列表。
- 保存经 `ctx.configForms.get('dsh-tauri-acp')` 原子写入本插件条目的配置（带 revision 防覆盖），落到档案的 `cordis.patch.yml`。`agents` 字段声明为 `.volatile()`：DSH 0.2 的设置服务只把 volatile 字段做成可编辑表单（没有它设置页不会出现），并在原处提交修改、触发 `loader/volatile-update`，宿主据此重新注册路由，不重启插件，下一次请求即生效。改名会先删旧路由再写新路由。写入被拒（例如别处同时改过）时会重新读取并提示。
- 由 bundle 层声明的 Agent 带 `YAML` 标记：可以在设置页覆盖字段，但不能改名或删除。
- 设置页面向 DSH NEXT（0.2 核心）：设置段按档案条目 id 分段，即 `cordis.patch.yml` 插入的 `dsh-tauri-acp`；条目 id 改了的话设置页不会出现。宿主会关闭这个条目自动生成的通用表单，并把模型页的 provider 目录指向同一个段。0.1 核心（`settings.installSection`，段名 `llm-acp`）宿主仍可用，但没有这个设置页。
- 档案不可写时只读展示。

## 配置

除了设置页，也可以在档案的 `cordis.patch.yml`（`~/.dsh/profiles/desktop/cordis.patch.yml`）里覆盖插件配置：

```yaml
- id: dsh-tauri-acp
  name: dsh-tauri-acp
  config:
    agents:
      codex:
        displayName: Codex (ACP)
        command: /Users/you/.nvm/versions/node/v22.12.0/bin/codex-acp
        authMethod: api-key
        env:
          OPENAI_API_KEY: sk-...
      claude-code:
        displayName: Claude Code (ACP)
        command: /usr/local/bin/npx
        args: [-y, '@agentclientprotocol/claude-agent-acp']
        permission: ask
```

设置页保存的也是这一段配置。0.1 核心上同样的结构也可以写进 dsh 用户设置的 `llm-acp` 段，修改后下一次请求即生效。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `displayName` | 路由名 | 模型选择器里显示的名字 |
| `command` / `args` | 必填 / `[]` | 启动 ACP Agent 的命令 |
| `env` | `{}` | 追加给子进程的环境变量（在继承的环境之上） |
| `cwd` | 会话 workspace | 子进程目录，以及取不到会话 workspace 时的 ACP 会话目录 |
| `authMethod` | 无 | 握手后调用 `authenticate` 的方法 id；出错信息会列出 Agent 支持的方法 |
| `models` | `[]` | 手动声明模型（`id`、`name`、`description`、`contextWindow`）；声明后不再自动发现 |
| `discoverModels` | `true` | 未声明模型时，启动 Agent 读取它公布的模型列表 |
| `permission` | `ask` | `ask` 走 dsh 审批框（无审批服务时降级为 `read-only`）；`allow` 全部允许；`read-only` 只允许 read/search/think/fetch；`reject` 全部拒绝 |
| `systemPrompt` | `drop` | `forward` 会把 dsh 系统提示词包在 `<system_instructions>` 里发给 Agent。dsh 提示词描述的是 dsh 自己的工具，一般不建议转发 |
| `showToolCalls` | `true` | 把 Agent 的工具调用和计划显示在推理块里 |
| `contextWindow` | `200000` | 上报给 dsh 的上下文窗口（用于压缩策略）；Agent 通过 `usage_update` 报告过大小、或模型带 `1m` 标记时以那个值为准 |
| `startupTimeoutMs` | `60000` | 握手超时 |
| `idleTimeoutMs` | `600000` | 流式输出空闲超时，`0` 关闭 |

## 冒烟测试

```bash
npx tsx scripts/smoke.mts "$(command -v codex-acp)"
```

只做握手和模型发现，不消耗额度。末尾加 `-- 你的问题` 会真正发一轮对话（会走 Agent 的计费），`ACP_MODEL`、`ACP_AUTH_METHOD` 环境变量可指定模型和认证方式。

## 限制

- Agent 用的是它自己的工具，dsh 的工具（含 MCP）不会传给它；插件不会产出 `tool-call`，每轮由 Agent 自己跑完。
- 文件按文本占位发送；Agent 不支持图片时图片也按文本占位。
- 推理等级列表取自 Agent 最近一次会话（默认模型下）提供的等级，换模型后等级集合变化的话，以 Agent 实际接受的为准。
- 重试策略固定为不重试，避免 Agent 重复执行有副作用的操作。
- 从 Finder/Dock 启动的桌面端拿不到 shell 的 `PATH`，`command` 建议写绝对路径。
- 官方「模型」页里的 provider 编辑器是为 HTTP 接口设计的，ACP 路由请在「ACP Agents」页或 YAML 里配置；在模型页点开 ACP 路由的「编辑」时，官方编辑器里那行「其余字段在 cordis.patch.yml 中…(dsh-tauri-acp)」会被替换成指向「ACP Agents」页的提示。官方编辑器没有给插件留插槽，这是按 DOM 替换的：只改设置弹窗里以 `(dsh-tauri-acp)` 结尾的那一行，插件卸载时停止。

## 开发

```bash
npm test
npm run typecheck
npm run build
```

`npm run build`（`tsdown.config.ts`）同时产出宿主入口 `dist/index.js`（ESM，Node）和客户端入口 `dist/client.cjs`：一个只向 DSH web 的 `window.__ModuleLoader__` 注册工厂的 CJS 脚本，`react`、`react/jsx-runtime`、`@deepseek-ai/*` 由宿主模块表提供，不打进包里。

- 客户端运行在 DSH 的 web 模块表里，只能 `require` 平台种子词（`react`、`react/jsx-runtime`、`@deepseek-ai/*`）和档案里作为条目加载的包。所以客户端只依赖 `react` 和 `@deepseek-ai/dsh-client-ui-primitives`，设置读写、文案、槽位都走 `ctx.configForms` / `ctx.locale` / `ctx.slots` / `ctx.remote.llm` 服务；不能用 `dsh-tauri` / `dsh-tauri-ui`（DSH NEXT 档案里没有它们，会报 `require("dsh-tauri") missed the module table`）。构建后可以检查：`grep -o 'require(\`[^\`]*\`)' dist/client.cjs`。
- 样式自带（`src/client/styles/agents.ts`，挂成 `<style>`），只用宿主的 `--dsw-*` 设计变量：web 壳不给第三方 bundle 提供工具类 CSS。
- `@deepseek-ai/dsh-client-ui-primitives` 不安装（它的 cordis peer 范围和这里的 alpha 版冲突，运行时也由宿主提供），用到的部分在 `types/dsh-client-ui-primitives.d.ts` 里按 0.2.0-rc.2 的类型声明。
- 客户端测试覆盖设置段投影、表单校验、JSON 导入、写入操作和模型发现；`tests/client-section.test.tsx` 用 `react-dom/server` 渲染设置页，`tests/client-import-view.test.tsx` 在 happy-dom 里点选导入项（primitives 由 vitest 别名指向 `tests/stubs`），表单替身的方法依赖 `this`，和真实 `ConfigForm` 一样。

测试用 `tests/fixtures/mock-agent.mjs` 这个 mock ACP Agent 覆盖：模型发现与切换、增量会话复用、历史重建、四种权限策略、取消、空响应、认证，推理等级、图片输入、上报的上下文窗口，以及在真实 cordis + `LlmRuntime` 下的注册、卸载和 volatile 配置热更新。

## 许可证

[MIT](LICENSE)
