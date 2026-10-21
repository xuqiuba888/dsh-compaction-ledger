/**
 * 离线演练：把真实会话的历史喂给分片逻辑，检查
 *  - 每片是否 <= 上限
 *  - 一共会切成几片（= 几次摘要请求）
 *  - 有没有单条消息本身就超限（需要按行再切）
 * 只读，不改任何数据。
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createZstdDecompress } from "node:zlib";

const SRC = process.env.REPLAY_SRC ?? "/tmp/b150.jsonl";
const LIMIT = Number(process.env.REPLAY_CHUNK_TOKENS ?? 60_000);
const MESSAGE_TYPES = new Set(["user/message", "assistant/message", "tool/result", "system/message"]);

if (!existsSync(SRC)) {
  console.error(`missing ${SRC}`);
  process.exit(1);
}

function textOf(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (value.content !== undefined) return textOf(value.content);
    if (value.message !== undefined) return textOf(value.message);
    if (value.result !== undefined) return textOf(value.result);
    if (value.output !== undefined) return textOf(value.output);
    return "";
  }
  return String(value);
}

const estimate = (text) => Math.ceil(text.length / 2.6);

const source = SRC.endsWith(".zstd")
  ? createReadStream(SRC).pipe(createZstdDecompress())
  : createReadStream(SRC);

const rl = createInterface({ input: source, crlfDelay: Infinity });
let events = 0;
let kept = 0;
const messages = [];
for await (const line of rl) {
  if (line.length === 0) continue;
  events += 1;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (!MESSAGE_TYPES.has(event?.type)) continue;
  const text = textOf(event.data);
  if (text.length === 0) continue;
  kept += 1;
  messages.push({ seq: event.seq, type: event.type, chars: text.length, tokens: estimate(text) });
}

let total = 0;
let largest = { chars: 0 };
let oversized = 0;
for (const m of messages) {
  total += m.tokens + 8;
  if (m.chars > largest.chars) largest = m;
  if (m.tokens > LIMIT) oversized += 1;
}

let chunks = 0;
let bucket = 0;
let maxChunk = 0;
for (const m of messages) {
  const cost = m.tokens + 8;
  if (bucket > 0 && bucket + cost > LIMIT) { chunks += 1; maxChunk = Math.max(maxChunk, bucket); bucket = 0; }
  bucket += cost;
}
if (bucket > 0) { chunks += 1; maxChunk = Math.max(maxChunk, bucket); }

console.log(`source        ${SRC}`);
console.log(`events        ${events}`);
console.log(`messages      ${kept}`);
console.log(`est tokens    ${total.toLocaleString()}`);
console.log(`largest msg   seq ${largest.seq} ${largest.chars.toLocaleString()} chars (~${largest.tokens.toLocaleString()} tok)`);
console.log(`oversized     ${oversized} (单条 > ${LIMIT.toLocaleString()} tok，需按行切)`);
console.log(`chunks        ${chunks} × <= ${LIMIT.toLocaleString()} tok (max ${maxChunk.toLocaleString()})`);
console.log(`old behavior  1 次摘要请求 ≈ ${total.toLocaleString()} tok`);
console.log(`new behavior  ${chunks} 次摘要请求，单次 ≤ ${LIMIT.toLocaleString()} tok`);
