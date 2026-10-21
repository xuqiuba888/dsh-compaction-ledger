/**
 * 有界回取工具。
 *
 * 设计约束（见 README「为什么没有文件导出」）：
 *  - 任何一次返回都不写文件、不返回超过预算的正文；
 *  - 摘要检索与原文检索都返回片段，不返回整块；
 *  - 预算随上下文压力收紧，避免回取把刚折掉的量灌回去。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

const OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: { text: { type: "string" } },
  required: ["text"],
};

const renderText = (_args, value) => value.text;

/** 粗略 token 估算：中文约 1.7 字/token，英文约 4 字/token，取 2.6 折中。 */
export function estimateText(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / 2.6);
}

function clip(text, capTokens) {
  const max = Math.max(200, Math.floor(capTokens * 2.6));
  if (text.length <= max) return { text, clipped: false };
  return { text: `${text.slice(0, max)}\n…[已截断，原长 ${text.length} 字符]`, clipped: true };
}

function safeRegister(ctx, tool) {
  try {
    return ctx.tools.register(tool);
  } catch (error) {
    ctx?.logger?.warn?.(`compaction-ledger: 注册 ${tool?.name} 跳过 (${error?.message ?? error})`);
    return undefined;
  }
}

export function registerRetrievalTools(ctx, ledger, options = {}) {
  if (typeof ctx?.tools?.register !== "function") return [];
  const capFor = options.capFor ?? (() => ({ cap: 4_000, allowFull: false, band: "tight" }));
  const sessionOf = (exec) => exec?.agent?.session?.id;

  const unregisterSearch = safeRegister(ctx, defineTool({
    name: "search_context",
    description: "Search folded context blocks. Returns bounded snippets with block ids; use decompress to pull exact messages. scope=orig searches the original text (expensive, still bounded).",
    parameters: {
      query: { type: "string", required: true, description: "Keyword or phrase to find in folded blocks." },
      scope: { type: "string", enum: ["summary", "orig"], description: "summary (default) searches stored summaries; orig searches the original messages." },
      limit: { type: "number", description: "Maximum hits, 1-20. Defaults to 5." },
    },
    output: { schema: OUTPUT, render: renderText },
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      if (sessionId === undefined) return { text: "search_context: no active session" };
      const limit = Math.min(20, Math.max(1, Math.floor(args.limit ?? 5)));
      const budget = capFor(exec);
      if (args.scope === "orig") {
        const hits = ledger.searchOriginals(sessionId, args.query, limit);
        if (hits.length === 0) return { text: `No original-text hits for "${args.query}".` };
        const parts = hits.map((h) => `b${h.blockId} [${h.startSeq}..${h.endSeq}] line ${h.line}\n  ${h.snippet}`);
        return { text: clip(parts.join("\n\n"), budget.cap).text };
      }
      const rows = ledger.searchSummaries(sessionId, args.query, limit);
      if (rows.length === 0) return { text: `No summary hits for "${args.query}". Try scope=orig.` };
      const parts = rows.map((r) => `b${r.id} [${r.startSeq}..${r.endSeq}] ${r.tokens} tok\n  ${snippetAround(r.summary, args.query, 160)}`);
      return { text: clip(parts.join("\n\n"), budget.cap).text };
    },
  }));

  const unregisterDecompress = safeRegister(ctx, defineTool({
    name: "decompress",
    description: "Restore folded content by block id. Without seqs it returns a bounded message index; with seqs it returns those exact messages. full=true is refused when it would exceed the retrieval budget.",
    parameters: {
      block: { type: "number", required: true, description: "Block id, e.g. 12 for b12." },
      seqs: { type: "array", items: { type: "number" }, description: "Exact message seqs to restore." },
      full: { type: "boolean", description: "Return the whole block. Refused above the retrieval budget." },
    },
    output: { schema: OUTPUT, render: renderText },
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      if (sessionId === undefined) return { text: "decompress: no active session" };
      const rows = ledger.listBlocks(sessionId);
      const row = rows.find((r) => r.id === args.block);
      if (row === undefined) return { text: `decompress: block b${args.block} not found in this session` };
      const budget = capFor(exec);
      const records = ledger.readOriginal(sessionId, args.block);
      if (records === null) return { text: `decompress: b${args.block} has no stored original (summary only)` };

      if (Array.isArray(args.seqs) && args.seqs.length > 0) {
        const wanted = new Set(args.seqs.map(Number));
        const picked = records.filter((r) => wanted.has(r.seq));
        if (picked.length === 0) return { text: `decompress: none of ${[...wanted].join(",")} are inside b${args.block}` };
        const body = picked.map((r) => `— seq ${r.seq} (${r.role}) —\n${r.text}`).join("\n\n");
        const out = clip(body, budget.cap);
        return { text: out.clipped ? `${out.text}\n\n共 ${picked.length} 条，已按 ${budget.band} 预算截断；请缩小 seqs 范围。` : out.text };
      }

      if (args.full === true) {
        if (budget.allowFull !== true) return { text: `decompress: full 被拒绝（当前 ${budget.band} 预算，上限约 ${budget.cap} tok）。请用 seqs 精确取条。` };
        const body = records.map((r) => `— seq ${r.seq} (${r.role}) —\n${r.text}`).join("\n\n");
        const out = clip(body, budget.cap);
        if (out.clipped) return { text: `${out.text}\n\ndecompress: 整块仍超预算，请用 seqs。` };
        return { text: out.text };
      }

      const index = records.map((r) => {
        const head = r.text.split("\n")[0]?.slice(0, 80) ?? "";
        return `  seq ${r.seq} (${r.role}) ${head}`;
      });
      const body = `b${row.id} [${row.startSeq}..${row.endSeq}] ${row.tokens} tok, ${records.length} 条\n${index.join("\n")}`;
      return { text: clip(body, budget.cap).text };
    },
  }));

  return [unregisterSearch, unregisterDecompress].filter((fn) => typeof fn === "function");
}

function snippetAround(text, query, radius) {
  const idx = text.toLowerCase().indexOf(String(query).toLowerCase());
  if (idx < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + String(query).length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
