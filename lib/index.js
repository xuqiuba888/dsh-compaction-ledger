/**
 * dsh-compaction-ledger
 *
 * 在宿主 CompactionEngine 槽位里替换默认实现，做三件宿主没做的事：
 *  1. 大区间**分片摘要**：一次折叠可以拆成多次 LLM 调用，单次输入永远 <= chunkTokens；
 *  2. **SQLite 台账**：每个折叠块的摘要与原文分别落库（原文 gzip），突破即持久；
 *  3. **有界回取**：search_context / decompress 两个工具，按压力自适应预算返回片段。
 *
 * 区间替换、checkpoint 事件、tool-pair 配平、溢出重试全部复用基类，
 * 因此不会破坏 DSH 的会话投影与持久化语义。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { Ledger } from "./ledger.js";
import { retrievalCap } from "./budget.js";
import { registerRetrievalTools, estimateText } from "./tools.js";

const DEFAULT_CHUNK_TOKENS = 60_000;

function resolveDbPath() {
  if (process.env.DSH_COMPACTION_LEDGER_DB) return process.env.DSH_COMPACTION_LEDGER_DB;
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "storages", "compaction-ledger", "ledger.db");
}

function chunkBudget() {
  const raw = Number(process.env.DSH_COMPACTION_LEDGER_CHUNK_TOKENS);
  return Number.isFinite(raw) && raw >= 4_000 ? Math.floor(raw) : DEFAULT_CHUNK_TOKENS;
}

/** 把消息的内容段压成纯文本（用于台账存档与估算）。 */
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block === "string" ? block : block?.type === "text" ? block.text ?? "" : `[${block?.type ?? "block"}]`))
    .join("\n");
}

function estimateMessages(messages) {
  let total = 0;
  for (const message of messages) total += estimateText(messageText(message)) + 8;
  return total;
}

/** 摘要结果（内容块数组或字符串）→ 纯文本。 */
function summaryToText(summary) {
  if (typeof summary === "string") return summary;
  if (!Array.isArray(summary)) return "";
  return summary.map((block) => (typeof block === "string" ? block : block?.text ?? "")).join("\n");
}

/**
 * 版本自检：cordis.patch.yml 是某个 dsh 版本的 preset 全量快照，
 * dsh 升级后 preset 可能变了，快照不会自动跟随。
 * 这里比对快照里盖章的版本与当前运行的 dsh-base 版本，不一致就警告。
 */
export function snapshotDrift() {
  let snapshot;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const patch = readFileSync(join(here, "..", "cordis.patch.yml"), "utf8");
    snapshot = /^# Snapshot-DSH-Version: (.+)$/m.exec(patch)?.[1]?.trim();
  } catch {
    snapshot = undefined;
  }
  if (snapshot === undefined) return undefined;
  let runtime;
  try {
    const require = createRequire(import.meta.url);
    runtime = require(require.resolve("@deepseek-ai/dsh-base/package.json")).version;
  } catch {
    return undefined;
  }
  if (runtime === undefined || runtime === snapshot) return undefined;
  return { snapshot, runtime };
}

export class CompactionLedgerEngine extends BasicCompactionEngine {
  // 基类 inject 是 ["llm", "tokenMeter", "sessions"]；static 字段会被子类整体遮蔽，
  // 所以这里必须带上基类的全部依赖，再补 "tools"（cordis：未声明 inject 就访问
  // ctx.tools 会抛 "cannot get property without inject"，直接炸掉整个 preset，
  // 所有无新建/恢复会话都会失败）。
  static inject = ["llm", "tokenMeter", "sessions", "tools"];

  ledger;
  span;
  unregisterTools = [];

  constructor(ctx, config = {}) {
    super(ctx, config);
    const drift = snapshotDrift();
    if (drift !== undefined) {
      const line = `compaction-ledger: preset 快照来自 dsh ${drift.snapshot}，当前运行 ${drift.runtime} — 请运行 npm run sync:preset 重新生成并重装插件`;
      this.ctx.logger?.warn?.(line);
      process.stderr.write(`${line}\n`);
    }
    this.ledger = new Ledger(resolveDbPath());
    this.span = undefined;
    this.pending = undefined;
    this.unregisterTools = registerRetrievalTools(ctx, this.ledger, { capFor: (exec) => this._retrievalBudget(exec) });
  }

  /** 记录本次折叠覆盖的 surface seq 区间，供 summarize 把分片映射回真实 seq。 */
  async compactRegion(start, end, agent, signal) {
    const nodes = agent.session.surface.nodes;
    const from = nodes.indexOf(start);
    const to = nodes.indexOf(end);
    const previous = this.span;
    this.span = {
      sessionId: agent.session.id,
      seqs: from >= 0 && to >= from ? nodes.slice(from, to + 1) : [],
    };
    try {
      return await super.compactRegion(start, end, agent, signal);
    } finally {
      this.span = previous;
    }
  }

  /**
   * 手动 `/compact` 走的是基类 `compactNow()`，它直接调模块级的
   * `compactSurfaceRegion()`，**不经过 `this.compactRegion()`**，
   * 所以 `this.span` 在整个过程中都是 undefined——0.1.4 及以前
   * 手动压缩的台账写入因此被静默跳过（2026-10-21 实测 blocks=0）。
   * 这里在基类返回后拿 `result.shadowedSeqs` 补记。
   */
  async compactNow(agent, signal, sourceCommandId) {
    const previous = this.span;
    this.span = undefined;
    this.pending = undefined;
    try {
      const result = await super.compactNow(agent, signal, sourceCommandId);
      if (result !== undefined && result !== null) {
        const pending = this.pending;
        if (pending === undefined) {
          this.ctx.logger?.warn?.(
            `compaction-ledger: 折叠 ${result.shadowedRange?.start}..${result.shadowedRange?.end} 已完成，但 summarize 没有留下分片，本次不落账`,
          );
        } else {
          this._record(pending.items, {
            sessionId: pending.sessionId ?? agent?.session?.id,
            seqs: result.shadowedSeqs,
          });
        }
      }
      return result;
    } finally {
      this.span = previous;
      this.pending = undefined;
    }
  }

  async summarize(input, agent, signal) {
    const limit = chunkBudget();
    const total = estimateMessages(input.messages);
    if (total <= limit) {
      const result = await super.summarize(input, agent, signal);
      const items = [{ tokens: total, summary: summaryToText(result.summary), messages: input.messages }];
      this.pending = { sessionId: this.span?.sessionId ?? agent?.session?.id, items };
      // 自动路径：span 由 compactRegion 设好，这里直接落账；手动路径留给 compactNow。
      this._record(items);
      return result;
    }

    const hasSystem = input.messages[0]?.role === "system";
    const system = hasSystem ? [input.messages[0]] : [];
    const body = hasSystem ? input.messages.slice(1) : input.messages;
    const groups = splitMessages(body, limit);
    const parts = [];

    for (const [index, group] of groups.entries()) {
      signal?.throwIfAborted?.();
      const result = await super.summarize({ ...input, messages: [...system, ...group.messages] }, agent, signal);
      parts.push({ result, group, index });
    }

    const merged = parts
      .map((part) => `### 片段 ${part.index + 1}/${parts.length}（${part.group.messages.length} 条消息）\n${summaryToText(part.result.summary)}`)
      .join("\n\n");

    const items = parts.map((part) => ({
      tokens: part.group.tokens,
      summary: summaryToText(part.result.summary),
      messages: part.group.messages,
    }));
    this.pending = { sessionId: this.span?.sessionId ?? agent?.session?.id, items };
    this._record(items);

    return {
      summary: [{ type: "text", text: merged }],
      rawOutput: parts.flatMap((part) => part.result.rawOutput ?? []),
      llmStreamCall: true,
      provider: parts[0]?.result.provider,
      model: parts[0]?.result.model,
      maxTokens: parts[0]?.result.maxTokens,
      ...(parts[0]?.result.usage === undefined ? {} : { usage: mergeUsage(parts) }),
    };
  }

  /**
   * 把一个折叠区间写进台账；重叠或失败只记录不回滚摘要（摘要已生效，台账是旁路）。
   * @param items - 分片（每条含 tokens / summary / messages）
   * @param options.seqs - 显式给出的 surface seq 列表（手动路径用 result.shadowedSeqs）
   * @param options.sessionId - 显式会话 id
   * @returns 实际写入的块数
   */
  _record(items, options = {}) {
    const seqs = Array.isArray(options.seqs) ? options.seqs : this.span?.seqs;
    const sessionId = options.sessionId ?? this.span?.sessionId;
    if (sessionId === undefined || !Array.isArray(seqs) || seqs.length === 0) return 0;

    let written = 0;
    for (const chunk of alignChunks(items, seqs)) {
      const records = chunk.messages.map((message, index) => ({
        seq: chunk.seqs[index] ?? chunk.seqs[chunk.seqs.length - 1],
        role: message?.role ?? "unknown",
        text: messageText(message),
      }));
      try {
        this.ledger.appendBlock(sessionId, {
          startSeq: chunk.seqs[0],
          endSeq: chunk.seqs[chunk.seqs.length - 1],
          tokens: chunk.item.tokens,
          summary: chunk.item.summary,
          origText: records.map((record) => JSON.stringify(record)).join("\n"),
        });
        written += 1;
      } catch (error) {
        this.ctx.logger?.warn?.(`compaction-ledger: 台账写入跳过 (${error?.message ?? error})`);
      }
    }
    if (written > 0) this.pending = undefined;
    return written;
  }

  _retrievalBudget(exec) {
    try {
      const session = exec?.agent?.session;
      if (session === undefined) return { cap: 4_000, allowFull: false, band: "tight" };
      const measurement = this.ctx.tokenMeter?.measure?.(session);
      const used = Number(measurement?.totalTokens ?? 0);
      const window = Number(measurement?.contextWindow ?? measurement?.limitTokens ?? 0);
      if (window > 0) return retrievalCap(used, { hard: window });
      return { cap: 10_000, allowFull: false, band: "normal" };
    } catch {
      return { cap: 4_000, allowFull: false, band: "tight" };
    }
  }
}

/** 工具结果是「必须紧跟 tool-call」的消息，永远不能成为一片的开头。 */
function isToolMessage(message) {
  if (message?.role === "tool") return true;
  return Array.isArray(message?.content) && message.content.some((block) => block?.type === "tool-result");
}

export function splitMessages(messages, limit) {
  const groups = [];
  let current = [];
  let tokens = 0;
  const flush = () => {
    if (current.length === 0) return;
    groups.push({ messages: current, tokens });
    current = [];
    tokens = 0;
  };

  for (const message of messages) {
    const cost = estimateText(messageText(message)) + 8;
    // 关键不变量：tool-call 之后必须紧跟它的 tool-result，否则上游报
    // "Messages tool calls need immediate results"（实测于 0.1.3）。
    // 因此切点只允许落在非 tool 消息之前，tool 结果一律留在当前片内。
    if (current.length > 0 && tokens + cost > limit && !isToolMessage(message)) flush();
    current.push(message);
    tokens += cost;
  }
  flush();

  // 兜底：万一首条就是 tool 消息（区间起点异常），并入前一片而不是独立成片。
  const merged = [];
  for (const group of groups) {
    const first = group.messages[0];
    if (isToolMessage(first) && merged.length > 0) {
      const previous = merged[merged.length - 1];
      previous.messages = [...previous.messages, ...group.messages];
      previous.tokens += group.tokens;
    } else {
      merged.push(group);
    }
  }
  return merged.length > 0 ? merged : [{ messages: [], tokens: 0 }];
}

/**
 * 把分片里的消息对齐到 surface seq。
 *
 * `buildSummarizationInput()` 会在消息前额外插入 system head（当 surface
 * 首节点是 system 时），因此扁平后的消息数可能比 shadowedSeqs 多 1；
 * 多出来的前缀不参与记账，否则整段 seq 会错位一格。
 * @param items - 分片数组
 * @param seqs - 本次折叠覆盖的 surface seq（surface 顺序）
 * @returns 对齐后的分片，每片带 `messages` 与同序的 `seqs`
 */
export function alignChunks(items, seqs) {
  const flat = [];
  for (const [index, item] of items.entries()) {
    for (const message of item.messages) flat.push({ index, message });
  }
  const skip = Math.max(0, flat.length - seqs.length);
  const chunks = new Map();
  flat.forEach((entry, position) => {
    if (position < skip) return;
    const seq = seqs[position - skip];
    if (seq === undefined) return;
    const chunk = chunks.get(entry.index) ?? { item: items[entry.index], messages: [], seqs: [] };
    chunk.messages.push(entry.message);
    chunk.seqs.push(seq);
    chunks.set(entry.index, chunk);
  });
  return [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, chunk]) => chunk);
}

function mergeUsage(parts) {
  let input = 0;
  let output = 0;
  let known = false;
  for (const part of parts) {
    const usage = part.result.usage;
    if (usage === undefined) continue;
    known = true;
    input += Number(usage.inputTokens ?? usage.input ?? 0);
    output += Number(usage.outputTokens ?? usage.output ?? 0);
  }
  return known ? { inputTokens: input, outputTokens: output } : undefined;
}

export { CompactionLedgerEngine as default };
