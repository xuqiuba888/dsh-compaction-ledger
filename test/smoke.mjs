import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBudget, resolveSpec, parseLimit, retrievalCap } from "../lib/budget.js";
import { Ledger } from "../lib/ledger.js";
import { planRange, planChunks } from "../lib/fold.js";
import { splitMessages, alignChunks } from "../lib/index.js";

let pass = 0;
const check = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };

console.log("budget");
check("hard = window - maxTokens", () => {
  const b = resolveBudget({ nativeWindow: 1_048_576, maxTokens: 256_000 });
  assert.equal(b.hard, 792_576);
  assert.equal(b.completion, 256_000);
});
check("70% 按 native 缩放后再扣 completion", () => {
  const b = resolveBudget({ nativeWindow: 1_048_576, maxTokens: 256_000, configuredLimit: "70%" });
  assert.equal(b.base, 734_003);
  assert.equal(b.hard, 478_003);
});
check("默认阈值 = hard * 0.8", () => {
  const s = resolveSpec({ nativeWindow: 1_048_576, maxTokens: 256_000 });
  assert.equal(s.thresholdTokens, 634_060);
  assert.equal(s.retainTokens, Math.max(5_000, Math.floor(792_576 * 0.16)));
});
check("绝对值不 clamp 到 native 之上的漏洞已堵", () => {
  assert.equal(parseLimit(2_000_000, 1_048_576), 1_048_576);
  assert.equal(parseLimit(640_000, 1_048_576), 640_000);
});
check("检索上限随压力收紧", () => {
  const s = resolveSpec({ nativeWindow: 1_048_576, maxTokens: 256_000 });
  assert.equal(retrievalCap(200_000, s).cap, 30_000);
  assert.equal(retrievalCap(500_000, s).cap, 10_000);
  assert.equal(retrievalCap(760_000, s).cap, 4_000);
  assert.equal(retrievalCap(760_000, s).allowFull, false);
});

console.log("ledger");
const dir = mkdtempSync(join(tmpdir(), "ledger-"));
const db = new Ledger(join(dir, "t.db"));
const sid = "s1";
check("写入与水位", () => {
  const id = db.appendBlock(sid, { startSeq: 1, endSeq: 10, tokens: 900, summary: "alpha kv cache", origText: "line1\nline2" });
  assert.equal(id, 1);
  assert.equal(db.getWatermark(sid), 10);
});
check("同区间重复拒绝（区间重叠改为允许）", () => {
  assert.throws(() => db.appendBlock(sid, { startSeq: 1, endSeq: 10, tokens: 10, summary: "dup" }), RangeError);
  // 非单调 surface 会让不同片的区间互相包含，这种必须放行
  db.appendBlock(sid, { startSeq: 5, endSeq: 12, tokens: 10, summary: "overlap ok" });
});
check("非单调 seq 分片可落库并保留顺序", () => {
  const unordered = [20, 3, 15];
  db.appendBlock(sid, {
    startSeq: Math.min(...unordered),
    endSeq: Math.max(...unordered),
    seqs: unordered,
    tokens: 7,
    summary: "non-monotonic",
  });
  const row = db.listBlocks(sid).find((b) => b.summary === "non-monotonic");
  assert.equal(row.startSeq, 3);
  assert.equal(row.endSeq, 20);
  assert.deepEqual(JSON.parse(row.seqList), [20, 3, 15]);
});
check("原文往返", () => {
  assert.equal(db.getOriginal(sid, 1), "line1\nline2");
  assert.equal(db.getOriginal(sid, 99), null);
});
check("摘要检索", () => {
  db.appendBlock(sid, { startSeq: 21, endSeq: 30, tokens: 10, summary: "beta overflow retry" });
  const hits = db.searchSummaries(sid, "overflow", 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].summary, "beta overflow retry");
});
db.close();
rmSync(dir, { recursive: true, force: true });

console.log("fold");
check("保留尾部并从头折", () => {
  const nodes = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, tokens: 1_000 }));
  const r = planRange(nodes, 20_000);
  assert.equal(r.startSeq, 1);
  assert.equal(r.endSeq, 80);
  assert.equal(r.foldTokens, 80_000);
  assert.equal(r.retainedTokens, 20_000);
});
check("分片每片 <= 上限", () => {
  const nodes = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, tokens: 1_000, text: "x" }));
  const chunks = planChunks(nodes, { maxChunkTokens: 30_000 });
  assert.ok(chunks.every((c) => c.tokens <= 30_000));
  assert.equal(chunks.at(-1).endSeq, 100);
  assert.equal(chunks.reduce((s, c) => s + c.tokens, 0), 100_000);
});
check("超大单条按行切", () => {
  const big = { seq: 7, tokens: 90_000, text: Array.from({ length: 90 }, () => "y").join("\n") };
  const chunks = planChunks([big], { maxChunkTokens: 30_000 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.tokens <= 30_000));
});

check("分片不在 tool 调用与结果之间切断", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "u".repeat(2000) }] },
    { role: "assistant", content: [{ type: "tool-call", id: "a", name: "bash", arguments: "{}" }] },
    { role: "tool", toolCallId: "a", content: [{ type: "text", text: "r".repeat(80000) }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  const groups = splitMessages(msgs, 20000);
  for (const g of groups) assert.notEqual(g.messages[0]?.role, "tool", "chunk 不能以 tool 消息开头");
  assert.equal(groups.flatMap((g) => g.messages).length, msgs.length);
});

console.log("align");
check("无 system 前置时分片与 seq 一一对应", () => {
  const items = [
    { tokens: 10, summary: "s1", messages: [{ role: "user" }, { role: "assistant" }] },
    { tokens: 10, summary: "s2", messages: [{ role: "user" }] },
  ];
  const chunks = alignChunks(items, [10, 11, 12]);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].seqs, [10, 11]);
  assert.deepEqual(chunks[1].seqs, [12]);
});
check("有 system 前置时跳过它，不错位一格", () => {
  const items = [
    { tokens: 10, summary: "s1", messages: [{ role: "system" }, { role: "user" }, { role: "assistant" }] },
    { tokens: 10, summary: "s2", messages: [{ role: "user" }] },
  ];
  const chunks = alignChunks(items, [10, 11, 12]);
  assert.deepEqual(chunks[0].seqs, [10, 11]);
  assert.equal(chunks[0].messages[0].role, "user", "system head 不参与记账");
  assert.deepEqual(chunks[1].seqs, [12]);
});
check("消息多于 seq 时从头部丢弃多余前缀", () => {
  const items = [{ tokens: 1, summary: "s", messages: [{ role: "system" }, { role: "user" }] }];
  const chunks = alignChunks(items, [5]);
  assert.deepEqual(chunks[0].seqs, [5]);
  assert.deepEqual(chunks[0].messages.map((m) => m.role), ["user"]);
});

console.log(`\n${pass} checks passed`);
