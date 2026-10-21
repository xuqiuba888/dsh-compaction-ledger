/**
 * SQLite 台账。三张表：
 *   blocks        折叠块（摘要常驻 + 原文 gzip 按需）
 *   sessions      每个会话的水位线
 *   ledger_meta   版本与迁移标记
 *
 * 依赖 node:sqlite（Node >= 22.5，零原生编译），进程内同步 API。
 * 「折一段 + 推进水位」在同一事务内提交，崩溃不会留下半条折叠。
 */
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  start_seq   INTEGER NOT NULL,
  end_seq     INTEGER NOT NULL,
  tier        INTEGER NOT NULL DEFAULT 1,
  tokens      INTEGER NOT NULL,
  summary     TEXT NOT NULL,
  orig_gz     BLOB,
  orig_chars  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_session ON blocks(session_id, start_seq);
CREATE INDEX IF NOT EXISTS idx_blocks_range   ON blocks(session_id, start_seq, end_seq);
`;

export class Ledger {
  constructor(dbPath) {
    this.path = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    const version = this.db.prepare("SELECT v FROM ledger_meta WHERE k = 'schema'").get();
    if (version === undefined) {
      this.db.prepare("INSERT INTO ledger_meta (k, v) VALUES ('schema', '1')").run();
    }
    this.stmts = {
      overlap: this.db.prepare(
        "SELECT id, start_seq AS startSeq, end_seq AS endSeq FROM blocks WHERE session_id = ? AND start_seq <= ? AND end_seq >= ? LIMIT 1",
      ),
      insert: this.db.prepare(
        "INSERT INTO blocks (session_id, start_seq, end_seq, tier, tokens, summary, orig_gz, orig_chars, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ),
      upsertSession: this.db.prepare(
        `INSERT INTO sessions (session_id, last_seq, updated_at) VALUES (?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
      ),
      list: this.db.prepare(
        "SELECT id, start_seq AS startSeq, end_seq AS endSeq, tier, tokens, summary, orig_chars AS origChars, created_at AS createdAt FROM blocks WHERE session_id = ? ORDER BY start_seq",
      ),
      orig: this.db.prepare("SELECT orig_gz AS origGz FROM blocks WHERE session_id = ? AND id = ?"),
      summarySearch: this.db.prepare(
        "SELECT id, start_seq AS startSeq, end_seq AS endSeq, summary FROM blocks WHERE session_id = ? AND summary LIKE ? ORDER BY start_seq LIMIT ?",
      ),
      watermark: this.db.prepare("SELECT last_seq AS lastSeq FROM sessions WHERE session_id = ?"),
      count: this.db.prepare("SELECT COUNT(*) AS n FROM blocks WHERE session_id = ?"),
    };
  }

  /** 原子提交一个折叠块；与既有块重叠则抛错（绝不静默覆盖）。 */
  appendBlock(sessionId, { startSeq, endSeq, tier = 1, tokens, summary, origText = "", watermark }) {
    if (!(startSeq <= endSeq)) throw new Error(`bad block range ${startSeq}..${endSeq}`);
    const hit = this.stmts.overlap.get(sessionId, endSeq, startSeq);
    if (hit !== undefined) {
      throw new RangeError(`block ${startSeq}..${endSeq} overlaps existing block ${hit.id} (${hit.startSeq}..${hit.endSeq})`);
    }
    const gz = origText === "" ? null : gzipSync(Buffer.from(origText, "utf8"), { level: 6 });
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const info = this.stmts.insert.run(
        sessionId, startSeq, endSeq, tier, tokens, summary, gz, origText.length, now,
      );
      this.stmts.upsertSession.run(sessionId, Math.max(watermark ?? endSeq, endSeq), now);
      this.db.exec("COMMIT");
      return Number(info.lastInsertRowid);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listBlocks(sessionId) {
    return this.stmts.list.all(sessionId);
  }

  getWatermark(sessionId) {
    return this.stmts.watermark.get(sessionId)?.lastSeq ?? 0;
  }

  blockCount(sessionId) {
    return this.stmts.count.get(sessionId)?.n ?? 0;
  }

  /** 取原文（已解压）；不存在返回 null。 */
  getOriginal(sessionId, blockId) {
    const row = this.stmts.orig.get(sessionId, blockId);
    if (row === undefined || row.origGz === null) return null;
    return gunzipSync(Buffer.from(row.origGz)).toString("utf8");
  }

  /** 摘要检索：返回命中块与片段，结果有界。 */
  searchSummaries(sessionId, query, limit) {
    return this.stmts.summarySearch.all(sessionId, `%${escapeLike(query)}%`, limit);
  }

  /** 原文 → 结构化记录（每行一条 JSON）；无原文返回 null。 */
  readOriginal(sessionId, blockId) {
    const text = this.getOriginal(sessionId, blockId);
    if (text === null) return null;
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { seq: 0, role: "unknown", text: line };
        }
      });
  }

  /** 原文检索：行级匹配，命中数与扫描量都有界。 */
  searchOriginals(sessionId, query, limit) {
    const needle = String(query).toLowerCase();
    const hits = [];
    let scanned = 0;
    for (const block of this.stmts.list.all(sessionId)) {
      if (hits.length >= limit || scanned > 8_000_000) break;
      const text = this.getOriginal(sessionId, block.id);
      if (text === null) continue;
      scanned += text.length;
      const lines = text.split("\n");
      for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
        if (!lines[index].toLowerCase().includes(needle)) continue;
        hits.push({
          blockId: block.id,
          startSeq: block.startSeq,
          endSeq: block.endSeq,
          line: index + 1,
          snippet: lines[index].slice(0, 400),
        });
      }
    }
    return hits;
  }

  close() {
    this.db.close();
  }
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}
