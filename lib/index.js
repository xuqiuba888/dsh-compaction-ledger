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

  async summarize(input, agent, signal) {
    const limit = chunkBudget();
    const total = estimateMessages(input.messages);
    if (total <= limit) {
      const result = await super.summarize(input, agent, signal);
      this._record([{ tokens: total, summary: summaryToText(result.summary), messages: input.messages }]);
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

    this._record(
      parts.map((part) => ({
        tokens: part.group.tokens,
        summary: summaryToText(part.result.summary),
        messages: part.group.messages,
      })),
    );

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

  /** 把一个折叠区间写进台账；重叠或失败只记录不回滚摘要（摘要已生效，台账是旁路）。 */
  _record(items) {
    const span = this.span;
    if (span === undefined) return;
    let cursor = 0;
    const seqs = span.seqs;
    for (const item of items) {
      const take = Math.min(item.messages.length, Math.max(0, seqs.length - cursor));
      const slice = seqs.slice(cursor, cursor + take);
      cursor += take;
      if (slice.length === 0) continue;
      const records = item.messages.map((message, index) => ({
        seq: slice[index] ?? slice[slice.length - 1],
        role: message?.role ?? "unknown",
        text: messageText(message),
      }));
      try {
        this.ledger.appendBlock(span.sessionId, {
          startSeq: slice[0],
          endSeq: slice[slice.length - 1],
          tokens: item.tokens,
          summary: item.summary,
          origText: records.map((record) => JSON.stringify(record)).join("\n"),
        });
      } catch (error) {
        this.ctx.logger?.warn?.(`compaction-ledger: 台账写入跳过 (${error?.message ?? error})`);
      }
    }
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

function splitMessages(messages, limit) {
  const groups = [];
  let current = [];
  let tokens = 0;
  for (const message of messages) {
    const cost = estimateText(messageText(message)) + 8;
    if (current.length > 0 && tokens + cost > limit) {
      groups.push({ messages: current, tokens });
      current = [];
      tokens = 0;
    }
    current.push(message);
    tokens += cost;
  }
  if (current.length > 0) groups.push({ messages: current, tokens });
  return groups.length > 0 ? groups : [{ messages: [], tokens: 0 }];
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
