/**
 * 预算解析 —— 本插件的核心不变量。
 *
 * 上游真正接受的是「输入 + 输出 <= 窗口」，所以可用输入预算是：
 *
 *   hard = min(nativeWindow, configuredLimit) - requestedMaxTokens
 *
 * billion-context 0.1.202 的 bug 就是把比较基准写成 min(native, configured)，
 * 漏掉了 requestedMaxTokens。日志证据：
 *   [preflight] round 2/25: payload ~1000163 tok vs window 1000000 (deficit 163)
 *   → 放行 → upstream 400 (1208953 in the messages, 256000 in the completion)
 * 1,000,163 + 256,000 = 1,256,163 > 1,048,576，必然失败。
 */

export const DEFAULTS = Object.freeze({
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  retainMinTokens: 5_000,
  minChunkTokens: 4_000,
  maxChunkTokens: 60_000,
  fallbackWindow: 1_000_000,
  /** 检索预算：随上下文使用率收紧，防止回取把刚折掉的量灌回去。 */
  retrieve: Object.freeze({ relaxed: 30_000, normal: 10_000, tight: 4_000 }),
});

/** 解析 "70%" / "640000" / 640000；字符串百分比按 native 缩放（相对值自适应）。 */
export function parseLimit(raw, nativeWindow) {
  const native = Math.max(1, Math.floor(nativeWindow || DEFAULTS.fallbackWindow));
  if (raw === undefined || raw === null || raw === "") return native;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(native, Math.floor(raw));
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(trimmed);
    if (pct) return Math.max(1, Math.floor((native * Number(pct[1])) / 100));
    const abs = Number(trimmed);
    if (Number.isFinite(abs) && abs > 0) return Math.min(native, Math.floor(abs));
  }
  return native;
}

/**
 * @param {object} input
 * @param {number} input.nativeWindow  模型原生窗口（DSH 侧 contextWindow）
 * @param {number} input.maxTokens     本次请求的 completion 上限
 * @param {number|string} [input.configuredLimit] 用户配置的输入预算（数字或百分比）
 */
export function resolveBudget({ nativeWindow, maxTokens, configuredLimit }) {
  const native = Math.max(1, Math.floor(nativeWindow || DEFAULTS.fallbackWindow));
  const configured = parseLimit(configuredLimit, native);
  const base = Math.min(native, configured);
  const completion = Math.max(0, Math.floor(maxTokens || 0));
  const hard = Math.max(1_000, base - completion);
  return { native, configured, base, completion, hard };
}

/** 折叠阈值与保留量都基于 hard（真实可用输入），不是基于窗口。 */
export function resolveSpec({ nativeWindow, maxTokens, configuredLimit, thresholdRatio, retainRatio }) {
  const budget = resolveBudget({ nativeWindow, maxTokens, configuredLimit });
  const ratio = clampRatio(thresholdRatio ?? DEFAULTS.thresholdRatio);
  const keep = clampRatio(retainRatio ?? DEFAULTS.retainRatio);
  const thresholdTokens = Math.max(1_000, Math.floor(budget.hard * ratio));
  const retainTokens = Math.max(DEFAULTS.retainMinTokens, Math.floor(budget.hard * keep));
  return { ...budget, thresholdRatio: ratio, retainRatio: keep, thresholdTokens, retainTokens };
}

function clampRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.8;
  return Math.min(0.95, Math.max(0.05, n));
}

/** 按当前压力选择检索上限：越接近阈值，回取越抠。 */
export function retrievalCap(usedTokens, spec) {
  const used = Math.max(0, Number(usedTokens) || 0);
  const r = used / Math.max(1, spec.hard);
  if (r < 0.5) return { cap: DEFAULTS.retrieve.relaxed, allowFull: true, band: "relaxed" };
  if (r <= 0.7) return { cap: DEFAULTS.retrieve.normal, allowFull: false, band: "normal" };
  return { cap: DEFAULTS.retrieve.tight, allowFull: false, band: "tight" };
}
