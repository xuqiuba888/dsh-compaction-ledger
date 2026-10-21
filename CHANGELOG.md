# CHANGELOG

## 0.1.7 — 2026-10-21 — 台账原文保留工具调用参数

**问题**：`messageText()` 只对 `text` 块取值，其余一律写成 `[tool-call]`
这类占位符。结果台账里 agent 的每一条 bash/read 调用**参数全部丢失**，
只剩 `{"seq":24520,"role":"assistant","text":"[reasoning]\n[tool-call]"}`——
恢复历史时看不到"当时到底跑了什么命令"。

**修复**：

- `text` 块原样保留
- `tool-call` 块写成 `[tool-call <name>] <arguments>`
- `reasoning` 块**不入档**（体积大、检索价值低，原始推理仍在会话日志里）
- 其余块保留类型占位

**影响**：`messageText()` 同时用于分片估算，估算值随之更接近真实 payload
（工具参数本来就要占 token），分片只会更保守，不会更激进。

**数据修复**：按新格式重放 `b150e7bd` 的 18 块，覆盖 8,310 个 seq、水位 25,374，
`integrity_check = ok`；样例可看到完整 `bash` 命令与 `description`。

## 0.1.6 — 2026-10-21 — 修非单调 surface seq 导致的丢块与错位

**现象**：`b150e7bd` 在 11:07:45 自动压缩，摘要写了 12 片，台账只进了 **11 块**；
块 1 的 `start_seq=13124` 却小于 `compaction/summary` 的 `shadowedRange.start=13158`。

**根因**：DSH 的 surface seq **不是单调递增的**。一次折叠会用「新生成的替换节点」
（seq 很大）占住旧位置，所以下一次折叠拿到的 `shadowedSeqs` 在数值上会来回跳：

```
shadowedSeqs[0] = 13158
shadowedSeqs[1] = 12451   ← 比前一个小
```

0.1.0–0.1.5 的 `appendBlock()` 靠 `startSeq <= endSeq` 校验区间、靠
「区间重叠就拒绝」保护台账。非单调时：

- 首节点 > 尾节点的那一片直接抛 `bad block range`，被 `logger.warn` 吞掉 → **丢块**（12 片只进 11 块）
- 其余块的 `start/end` 取的是首尾节点，跟真实区间无关 → **错位**

**修复**：

1. `blocks` 新增 `seq_list` 列（TEXT，surface 顺序的 seq 数组），schema 版本 1 → 2，自动 `ALTER TABLE`
2. `start_seq/end_seq` 改为该片的 `min..max`，只用于展示与排序
3. `appendBlock()` 的保护区从「区间重叠」改为「同 `(start,end)` 重复」——非单调区间本来就会互相包含，重叠检查是误报源
4. `_record()` 传 `seqs` 与 `min..max`

**数据修复**：从会话日志重放 `b150e7bd` 的 5 次压缩（含 10-16 的 3 次单发摘要、
10-21 的 12 片与 3 片），共写回 **18 块**，`PRAGMA integrity_check = ok`；
原来的 11 块（区间错位、缺 1 片）已删除，删除前快照留在 `/tmp/ledger-snapshot.db`。

**测试**：新增「非单调 seq 分片可落库并保留顺序」「同区间重复拒绝」两项，共 17 项全过。

## 0.1.5 — 2026-10-21 — 修复手动 `/compact` 台账不落账（静默 no-op）

**现象**：10:07:25 手动 `/compact` 成功（`compaction/end` 无 error，摘要 5 片、
input 411,612 tok、上下文 364,577 → 33,614 tok），但
`ledger.db` 里 `blocks = 0`、`sessions = 0`，WAL 零字节——一次事务都没提交。

**根因**：基类的两条压缩入口不对称：

```js
compactIfNeeded() → this.compactRegion(...)        // 自动路径，命中我们的 override
compactNow()      → compactSurfaceRegion(...)      // 手动路径，直接调模块函数
```

`/compact` 走的是 `compactNow()`，**根本不经过 `this.compactRegion()`**，
因此 `this.span` 始终是 `undefined`，`_record()` 第一行就 `return` 了，
既不抛错也不打日志。0.1.0–0.1.4 的手动压缩从未写过台账（自动压缩也从未触发过）。

**修复**：

1. 新增 `compactNow()` override：`super` 返回后用 `result.shadowedSeqs`
   （`CompactionResult` 的权威字段）补账；
2. `summarize()` 把分片暂存到 `this.pending`，供手动路径复用；
3. `_record(items, { seqs, sessionId })` 支持显式区间，返回实际写入块数；
4. 分片与 seq 的对齐抽成 `alignChunks()` 并导出——`buildSummarizationInput`
   会额外前置 system head，之前会让整段 seq **错位一格**；
5. 手动路径若拿不到分片，打 `logger.warn`，不再静默。

**测试**：新增 3 项对齐断言（含 system 前置、超额前缀丢弃），共 16 项全过；
另用临时库模拟手动路径实测：4 个 seq / 2 片 → 写 2 块，`8..10` + `11..11`，
原文按 `{"seq":..,"role":..,"text":..}` 逐行存档，水位推进到 11。

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
