# CHANGELOG

## 0.1.4 — 2026-10-21 — 修复分片切断 tool-call/tool-result 配对

**现象**：手动 `/compact` 返回
`Compaction could not produce a useful summary. The attempt is recorded in the session log.`
会话日志里的真实错误是：

```
compaction/end { "error": "DeepSeek Messages tool calls need immediate results" }
```

**根因**：`splitMessages` 只按 token 数切片，切点可能落在
`assistant(tool-call)` 与紧随其后的 `tool(result)` 之间。上游（Anthropic 兼容线）
要求每个 tool_use 必须被**紧邻**的 tool_result 应答，于是每一次摘要调用都 400，
整次压缩被判失败。基类的 `selectCompactableRange` 只在**区间层面**保证配对，
管不到区间内部的分片。

**修复**：切点只允许落在**非 tool 消息**之前；tool 结果一律留在当前片内。
另加兜底——若某片首条仍是 tool 消息（区间起点异常），并入前一片而不是独立成片。

**测试**：新增断言「分片不在 tool 调用与结果之间切断」，共 13 项全过。

## 0.1.3 — 2026-10-21 — 修复构造函数连环崩溃（会导致整个会话层不可用）

**现象**：升级到 0.1.2 后 `dsh web` 启动失败，新建会话与恢复旧会话全部失败。

**根因**：引擎在**每次会话启动时都会被实例化**（`preset-standard` 的 `compaction` 组内），
构造期任何异常都会杀死 compression fiber，进而让 `agent preset standard` 挂载失败——
一处崩，新建/恢复全线崩。

1. `lib/index.js` 访问 `ctx.tools` 时没有在 `static inject` 里声明 `tools`。
   cordis 直接抛 `cannot get property "tools" without inject`。
   **注意**：子类的 `static inject` 会**整体遮蔽**基类的
   `["llm", "tokenMeter", "sessions"]`，必须写全再补上 `tools`。
2. `lib/tools.js` 的输出 schema 用了 JSON Schema 草案的根级 `required: ["text"]` 数组，
   而 `dsh-tools` 的 value-schema DSL 要求把 `required: true` 写进每个属性里。
   并且 `defineTool(...)` 在进入 `safeRegister` 的 `try` 之前就抛了，`safeRegister`
   的防御根本没接住——`safeRegister` 必须接收**工厂函数**，在 `try` 内部再调用 `defineTool`。

**修复**：
- `static inject = ["llm", "tokenMeter", "sessions", "tools"]`
- schema 改成 DSL 写法：`properties: { text: { type: "string", required: true } }`
- `safeRegister(ctx, () => defineTool({...}))`，注册失败只告警跳过，不再炸引擎

**验证**：把 web profile 复制到 `/tmp` 搭隔离环境——未打补丁时**精确复现** preset 崩溃，
打补丁后 compaction 纤维干净挂载、`ledger.db` 正常初始化；插件自测 12 项全过；
`test/replay.mjs` 在真实会话数据（b150e7bd，7,134 条消息）上行为不变。

## 0.1.2 — 2026-10-21 — 改成 preset 全量快照挂载

- 发现 web profile 里真正运行的压缩引擎是 `preset-standard` 内部的嵌套行，
  而顶层 `compaction-basic` 只是被 web-app 禁用的空壳；且补丁层**不允许改 name**
  （stderr：`patch: name mismatch for "compaction-basic" ... skipping`）。
- 改为覆盖 `preset-standard` 的全量 config（billion-context 注释里称的 `#2474` fallback），
  只把嵌套的引擎行换成 `dsh-compaction-ledger`；生成时剔除其它 bundle 注入的 `inject`。
- 新增 `scripts/sync-preset.mjs`（`npm run sync:preset` / `check:preset`）与启动时的版本自检。

## 0.1.1 — 2026-10-21 — 首次挂载尝试（无效）

- 用 `- id: compaction-basic / name: dsh-compaction-ledger` 覆盖，实测被跳过，由 0.1.2 取代。

## 0.1.0 — 2026-10-21 — 初版

- 进程内压缩引擎：分片摘要（单次 ≤ `DSH_COMPACTION_LEDGER_CHUNK_TOKENS`，默认 60K）、
  SQLite 台账（摘要 + gzip 原文 + 单调水位，单事务提交，重叠拒绝）、
  有界回取工具 `search_context` / `decompress`（预算随上下文压力 4K↔30K 收紧，从不写文件）。

---

## 运维要点

- 台账：`$DSH_HOME/storages/compaction-ledger/ledger.db`（WAL；`pragma integrity_check` = ok）
- 触发阈值：`min(窗口 × 0.8, 窗口 − max_tokens)`，1,048,576 窗口 + 256,000 输出时 = **792,576**
- **dsh 升级后必做**：`npm run check:preset` → `npm run sync:preset` → 升版本 → `npm pack`
  → `dsh plugin --profile web add file:./dsh-compaction-ledger-<ver>.tgz` → 重启
- 启动异常先看 `/root/.dsh/logs/startup-*.log`
- 旧会话目录里残留的空 `session.lock` 是内核 flock 锁，进程退出即释放，不挡恢复，无需清理
