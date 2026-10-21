/**
 * 折叠区间的选择与分片。
 *
 * 与 billion-context 的两处结构性差异：
 *  1. 一次折叠可以由多次摘要调用组成（分片），单次摘要的输入永远 <= maxChunkTokens；
 *  2. 选段从最老的开始、保留尾部 retainTokens，水位线单调前进，不会重复折同一段。
 */
import { DEFAULTS } from "./budget.js";

/**
 * @param {{seq:number, tokens:number}[]} nodes 全量表面节点（按 seq 升序）
 * @param {number} retainTokens 尾部保留量
 */
export function planRange(nodes, retainTokens) {
  if (nodes.length === 0) return null;
  let retained = 0;
  let cut = nodes.length;
  while (cut > 0 && retained + nodes[cut - 1].tokens <= retainTokens) {
    retained += nodes[cut - 1].tokens;
    cut -= 1;
  }
  if (cut <= 0) return null;
  const head = nodes.slice(0, cut);
  const foldTokens = head.reduce((sum, n) => sum + n.tokens, 0);
  if (foldTokens === 0) return null;
  return {
    startSeq: head[0].seq,
    endSeq: head[head.length - 1].seq,
    foldTokens,
    retainedTokens: retained,
    count: head.length,
    nodes: head,
  };
}

/**
 * 把一段消息切成若干摘要单元，每单元 tokens <= maxChunkTokens。
 * 单条消息本身超限时按行切（不丢内容，只分多次摘要）。
 */
export function planChunks(nodes, { maxChunkTokens = DEFAULTS.maxChunkTokens, minChunkTokens = DEFAULTS.minChunkTokens } = {}) {
  const chunks = [];
  let bucket = [];
  let bucketTokens = 0;

  const flush = () => {
    if (bucket.length === 0) return;
    chunks.push({
      startSeq: bucket[0].seq,
      endSeq: bucket[bucket.length - 1].seq,
      tokens: bucketTokens,
      nodes: bucket,
    });
    bucket = [];
    bucketTokens = 0;
  };

  for (const node of nodes) {
    if (node.tokens > maxChunkTokens) {
      flush();
      const parts = splitLines(node, maxChunkTokens);
      for (const part of parts) {
        chunks.push({ startSeq: node.seq, endSeq: node.seq, tokens: part.tokens, nodes: [part], partial: true });
      }
      continue;
    }
    if (bucketTokens + node.tokens > maxChunkTokens) flush();
    bucket.push(node);
    bucketTokens += node.tokens;
  }
  flush();
  return mergeTiny(chunks, minChunkTokens, maxChunkTokens);
}

function splitLines(node, maxChunkTokens) {
  const text = node.text ?? "";
  const lines = text.split("\n");
  const parts = [];
  let buf = [];
  let tokens = 0;
  const perLine = Math.max(1, Math.ceil(node.tokens / Math.max(1, lines.length)));
  for (const line of lines) {
    if (tokens + perLine > maxChunkTokens && buf.length > 0) {
      parts.push({ ...node, text: buf.join("\n"), tokens });
      buf = [];
      tokens = 0;
    }
    buf.push(line);
    tokens += perLine;
  }
  if (buf.length > 0) parts.push({ ...node, text: buf.join("\n"), tokens });
  return parts;
}

function mergeTiny(chunks, minChunkTokens, maxChunkTokens) {
  const out = [];
  for (const chunk of chunks) {
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      !last.partial &&
      !chunk.partial &&
      last.tokens < minChunkTokens &&
      last.tokens + chunk.tokens <= maxChunkTokens
    ) {
      last.endSeq = chunk.endSeq;
      last.tokens += chunk.tokens;
      last.nodes = [...last.nodes, ...chunk.nodes];
    } else {
      out.push({ ...chunk });
    }
  }
  return out;
}
