# dsh-compaction-ledger

DeepSeek Harness 的**进程内**上下文压缩引擎。替换宿主默认的 `compaction-basic`，
并补上它没有的三件事：分片摘要、可持久化的台账、有界回取。

> English: An in-process compaction engine for DeepSeek Harness. It replaces the
> bundled `compaction-basic` service and adds chunked summarization, a SQLite
> ledger, and bounded retrieval tools. See 「设计要点」for details.

## 为什么写它

宿主自带的压缩是「一次事务把整段历史发给模型，换回一条摘要」。两个后果：

1. **大区间必然超窗**。历史越长，这一次摘要调用本身就越可能超过模型窗口，
   于是「为了不超窗而压缩」的动作自己先超窗，形成死锁。
2. **压完就没了**。摘要一旦漏掉细节，那个细节就永久丢失，模型无法回查。

本插件针对这两点：摘要按 `chunkTokens` 分片，每片都是一次独立的小请求；
每片的摘要与原文都写进 SQLite，模型可以按块号、按关键词把原文取回来。

## 安装

```bash
cd /root/.dsh/local-plugins/dsh-compaction-ledger
npm pack
dsh plugin --profile web add file:./dsh-compaction-ledger-0.1.0.tgz
```

安装后重启 DSH 会话进程生效。卸载：

```bash
dsh plugin --profile web remove dsh-compaction-ledger
```

## 配置

本包**不引入新的配置键**——基类 `BasicCompactionConfig` 的校验原样保留，
所以 `thresholdRatio`、`retainRatio`、`maxTokens` 等继续按宿主的语义工作。

两个可选项走环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_COMPACTION_LEDGER_DB` | `$DSH_HOME/storages/compaction-ledger/ledger.db` | 台账路径 |
| `DSH_COMPACTION_LEDGER_CHUNK_TOKENS` | `60000` | 单次摘要调用的输入上限 |

## 数据布局

```
ledger.db
├── blocks(id, session_id, start_seq, end_seq, tier, tokens,
│          summary, orig_gz, orig_chars, created_at)
├── sessions(session_id, last_seq, updated_at)
└── ledger_meta(k, v)
```

- `summary` 常驻上下文（折叠后的那条 checkpoint 就是它拼出来的）
- `orig_gz` 是 gzip 后的原文 JSONL，`decompress` 按需解压
- 「写块 + 推进水位」在同一事务内提交（`BEGIN IMMEDIATE`），崩溃不留半条折叠
- 区间重叠直接抛错，绝不静默覆盖

## 两个工具

| 工具 | 作用 | 返回上限 |
|---|---|---|
| `search_context(query, scope?, limit?)` | 检索摘要或原文，返回块号与片段 | 随压力 4K–30K |
| `decompress(block, seqs?, full?)` | 取回块索引 / 指定消息 / 整块 | 随压力 4K–30K |

检索预算随上下文压力收紧，防止「回取」把刚折掉的量又灌回去：

| 上下文使用率 | 上限 | 允许 `full` |
|---|---|---|
| < 50% | 30K | 是 |
| 50–70% | 10K | 否 |
| > 70% | 4K | 否 |

**不写文件。** 超大内容不导出成文件——那只是把爆点从 tool result 挪到 `read`
result，并且污染工作区、无人清理。所有返回都是片段，永远有界。

## 设计要点

- **区间替换复用基类**：`compactSurfaceRegion`、`compaction/start|end` 事件、
  tool-call/result 配平、溢出重试全部走 `BasicCompactionEngine`，
  所以 DSH 的会话投影与持久化语义不受影响。
- **钩子只有一个**：`summarize(input, agent, signal)`。超限就切片，逐片调用
  `super.summarize`，再把各片摘要按顺序合并成一条 checkpoint 摘要。
- **seq 映射**：`compactRegion(start, end)` 被重写，用来记录本次折叠的
  surface seq 区间，`summarize` 再把每片消息映射回真实 seq 写进台账。

## 已知限制（v1）

- 检索是 `LIKE` 子串匹配，没有向量索引；原文检索是逐块扫描（扫描量封顶 8MB）。
- `tier` 字段已预留但尚未做 T1→T3 分级蒸馏。
- 摘要质量直接取决于分片切点；切点不感知工具调用配对（配对由基类在区间层面保证）。

## License

MIT

## 与 billion-context 的关系（重要）

**两者不能同时启用**，冲突是三重的：

1. **工具名撞车**：billion-context 会向模型注入 `compress` / `decompress` /
   `search_context` 三个工具；本包也注册了后两个，同名注册会冲突。
2. **压缩流被拒**：billion-context 有一道保护（#1729），会拒绝
   `purpose: "compaction"` 的宿主原生压缩调用，借口是「bili 拥有这条线路的压缩权」。
   本包的 `summarize` 正是以 `purpose: "compaction"` 发请求，会被它直接挡掉。
3. **双层折叠**：即使打开 `BILI_ALLOW_DSH_COMPACTION=1` 放行，bili 仍会在
   wire 层按自己的阈值再折一次，两层台账互不可见。

所以切换顺序必须是：**先移除 billion-context，再安装本包**。

```bash
dsh plugin --profile web remove billion-context
npm pack
dsh plugin --profile web add file:./dsh-compaction-ledger-0.1.0.tgz
```

移除 bili 不会丢历史：会话原文一直在
`$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd`，
bili 只保存折叠台账。本包的台账从安装后第一次折叠开始积累。

## 升级 dsh 之后必须做的一步

`cordis.patch.yml` 是 `preset-standard` 的**全量快照**（见文件头注释）。dsh 升级后 preset 可能新增或改动插件，而快照不会自动跟随——插件会继续按旧 preset 形状运行。

升级后执行：

```bash
cd /root/.dsh/local-plugins/dsh-compaction-ledger
npm run check:preset      # 退出码 1 表示快照已过期
npm run sync:preset       # 重新生成 cordis.patch.yml
npm pack                  # 升 version 后重新打包含新快照
dsh plugin --profile web add file:./dsh-compaction-ledger-<新版本>.tgz
```

插件启动时也会自检：快照盖章的 dsh 版本与当前运行的 `@deepseek-ai/dsh-base` 版本不一致时，日志里会打一行 `compaction-ledger: preset 快照来自 dsh X，当前运行 Y …`。

## 变更记录

见 [CHANGELOG.md](./CHANGELOG.md)。
