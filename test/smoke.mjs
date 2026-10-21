import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBudget, resolveSpec, parseLimit, retrievalCap } from "../lib/budget.js";
import { Ledger } from "../lib/ledger.js";
import { planRange, planChunks } from "../lib/fold.js";

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
check("重叠拒绝", () => {
  assert.throws(() => db.appendBlock(sid, { startSeq: 5, endSeq: 12, tokens: 10, summary: "x" }), RangeError);
});
check("原文往返", () => {
  assert.equal(db.getOriginal(sid, 1), "line1\nline2");
  assert.equal(db.getOriginal(sid, 99), null);
});
check("摘要检索", () => {
  db.appendBlock(sid, { startSeq: 11, endSeq: 20, tokens: 10, summary: "beta overflow retry" });
  const hits = db.searchSummaries(sid, "overflow", 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 2);
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

console.log(`\n${pass} checks passed`);
