import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function now() {
  return new Date().toISOString();
}

export class StateStore {
  constructor(databaseFile) {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
    this.db = new DatabaseSync(databaseFile);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        aweme_id TEXT PRIMARY KEY,
        source_url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        author_sec_uid TEXT NOT NULL DEFAULT '',
        duration_seconds REAL NOT NULL DEFAULT 0,
        create_time INTEGER NOT NULL DEFAULT 0,
        likes INTEGER NOT NULL DEFAULT 0,
        collects INTEGER NOT NULL DEFAULT 0,
        comments INTEGER NOT NULL DEFAULT 0,
        shares INTEGER NOT NULL DEFAULT 0,
        play_url TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'discovered',
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        media_path TEXT,
        media_sha256 TEXT,
        media_bytes INTEGER,
        media_duration_seconds REAL,
        transcript_path TEXT,
        transcript_sha256 TEXT,
        knowledge_path TEXT,
        knowledge_sha256 TEXT,
        extractor_provider TEXT,
        extractor_version TEXT,
        note_path TEXT,
        note_sha256 TEXT,
        resume_status TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS creators (
        sec_uid TEXT PRIMARY KEY,
        nickname TEXT NOT NULL DEFAULT '',
        profile_url TEXT NOT NULL,
        source_input TEXT NOT NULL DEFAULT '',
        vault_slug TEXT NOT NULL DEFAULT '',
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        synthesis_path TEXT,
        synthesis_sha256 TEXT,
        overview_path TEXT,
        overview_sha256 TEXT
      );
      CREATE TABLE IF NOT EXISTS creator_items (
        sec_uid TEXT NOT NULL,
        aweme_id TEXT NOT NULL,
        rank INTEGER NOT NULL DEFAULT 0,
        analysis_status TEXT NOT NULL DEFAULT 'pending',
        analysis_path TEXT,
        analysis_sha256 TEXT,
        note_path TEXT,
        note_sha256 TEXT,
        last_error TEXT,
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (sec_uid, aweme_id),
        FOREIGN KEY (sec_uid) REFERENCES creators(sec_uid) ON DELETE CASCADE,
        FOREIGN KEY (aweme_id) REFERENCES items(aweme_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_creator_items_status ON creator_items(sec_uid, analysis_status);
    `);
    this.ensureColumn("knowledge_path", "TEXT");
    this.ensureColumn("knowledge_sha256", "TEXT");
    this.ensureColumn("extractor_provider", "TEXT");
    this.ensureColumn("extractor_version", "TEXT");
    this.ensureColumn("note_sha256", "TEXT");
    this.ensureColumn("resume_status", "TEXT");
    this.ensureColumn("play_url", "TEXT");
    this.ensureColumn("category", "TEXT");
    this.ensureColumn("subcategory", "TEXT");
    this.ensureColumn("group", "TEXT");
    this.ensureColumn("collects_id", "TEXT");
    this.ensureColumn("collects_name", "TEXT");
    this.upsertStatement = this.db.prepare(`
      INSERT INTO items (
        aweme_id, source_url, title, author, author_sec_uid,
        duration_seconds, create_time, likes, collects, comments, shares,
        play_url, status, discovered_at, updated_at, collects_id, collects_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?)
      ON CONFLICT(aweme_id) DO UPDATE SET
        source_url=excluded.source_url,
        title=excluded.title,
        author=excluded.author,
        author_sec_uid=excluded.author_sec_uid,
        duration_seconds=excluded.duration_seconds,
        create_time=excluded.create_time,
        likes=excluded.likes,
        collects=excluded.collects,
        comments=excluded.comments,
        shares=excluded.shares,
        play_url=excluded.play_url,
        collects_id=excluded.collects_id,
        collects_name=excluded.collects_name,
        updated_at=excluded.updated_at
    `);
  }

  ensureColumn(name, definition) {
    const columns = this.db.prepare("PRAGMA table_info(items)").all();
    if (!columns.some(column => column.name === name)) {
      this.db.exec(`ALTER TABLE items ADD COLUMN "${name}" ${definition}`);
    }
  }

  close() {
    this.db.close();
  }

  upsertDiscovered(item) {
    const timestamp = now();
    this.upsertStatement.run(
      String(item.aweme_id),
      String(item.source_url || `https://www.douyin.com/video/${item.aweme_id}`),
      String(item.title || ""),
      String(item.author || ""),
      String(item.author_sec_uid || ""),
      Number(item.duration || 0),
      Number(item.create_time || 0),
      Number(item.likes || 0),
      Number(item.collects || 0),
      Number(item.comments || 0),
      Number(item.shares || 0),
      String(item.play_url || ""),
      timestamp,
      timestamp,
      String(item.collects_id || ""),
      String(item.collects_name || ""),
    );
  }

  get(awemeId) {
    return this.db.prepare("SELECT * FROM items WHERE aweme_id = ?").get(String(awemeId));
  }

  list({ status = "", limit = 100 } = {}) {
    if (status) {
      return this.db.prepare("SELECT * FROM items WHERE status = ? ORDER BY discovered_at DESC LIMIT ?")
        .all(status, limit);
    }
    return this.db.prepare("SELECT * FROM items ORDER BY discovered_at DESC LIMIT ?").all(limit);
  }

  /** 按收藏时间（create_time）倒序取最新条目，可选按状态过滤。 */
  listNewest({ status = "", limit = 100 } = {}) {
    if (status) {
      return this.db.prepare("SELECT * FROM items WHERE status = ? ORDER BY create_time DESC LIMIT ?")
        .all(status, limit);
    }
    return this.db.prepare("SELECT * FROM items ORDER BY create_time DESC LIMIT ?").all(limit);
  }

  /** 新增收藏列表：首次采集时间（discovered_at ≈ 新增收藏时间）不早于 isoSince 的条目，按首次采集时间倒序。供桌面"新增收藏·核对与补充"页展示。 */
  listNewArrivals(isoSince = "", limit = 100) {
    if (!isoSince) {
      return this.db.prepare("SELECT * FROM items ORDER BY discovered_at DESC LIMIT ?").all(limit);
    }
    return this.db.prepare("SELECT * FROM items WHERE discovered_at >= ? ORDER BY discovered_at DESC LIMIT ?")
      .all(String(isoSince), limit);
  }

  /** 手动补充视频：把抖音链接解析出的 aweme_id 插入库（status='discovered'，discovered_at=现在），已存在则不动状态（不重复处理）。 */
  addManually({ awemeId, sourceUrl, title = "" }) {
    const existing = this.get(String(awemeId));
    if (existing) return { added: false, existed: true, status: existing.status };
    this.upsertDiscovered({
      aweme_id: String(awemeId),
      source_url: String(sourceUrl || `https://www.douyin.com/video/${awemeId}`),
      title: String(title || ""),
    });
    return { added: true, existed: false, status: "discovered" };
  }

  /** 取未处理（非 written / 非 skipped）条目：按收藏时间正序（先进先出）。
   *  可限定采集时间窗口（discovered_at 范围）、起始日期（create_time 秒）、
   *  以及"最近失败的可重试项"（status=failed 且 updated_at >= retryUpdatedSince）与条数。
   *  窗口与 retryUpdatedSince 是 OR 关系：即使入库时间早于窗口，昨天失败的条目也会纳入候选以便次日重试。 */
  listPending({ sinceDiscovered = "", untilDiscovered = "", sinceCreateTime = 0, retryUpdatedSince = "", collectsId = "", limit = 0 } = {}) {
    const conditions = ["status <> 'written'", "status <> 'skipped'"];
    const args = [];
    if (collectsId) {
      conditions.push("collects_id = ?");
      args.push(String(collectsId));
    }
    const windowBits = [];
    if (sinceDiscovered && untilDiscovered) {
      windowBits.push("(discovered_at >= ? AND discovered_at < ?)");
      args.push(String(sinceDiscovered), String(untilDiscovered));
    } else if (sinceDiscovered) {
      windowBits.push("discovered_at >= ?");
      args.push(String(sinceDiscovered));
    } else if (untilDiscovered) {
      windowBits.push("discovered_at < ?");
      args.push(String(untilDiscovered));
    }
    if (retryUpdatedSince) {
      // 昨天及更早失败的条目：即便入库时间早于窗口，也纳入候选以便次日重试
      windowBits.push("(status='failed' AND updated_at >= ?)");
      args.push(String(retryUpdatedSince));
    }
    if (windowBits.length) conditions.push(`(${windowBits.join(" OR ")})`);
    if (sinceCreateTime > 0) { conditions.push("create_time >= ?"); args.push(Number(sinceCreateTime)); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM items ${where} ORDER BY create_time ASC${limit > 0 ? " LIMIT ?" : ""}`;
    if (limit > 0) args.push(limit);
    return this.db.prepare(sql).all(...args);
  }

  counts() {
    return this.db.prepare("SELECT status, COUNT(*) AS count FROM items GROUP BY status ORDER BY status").all();
  }

  /** 按数量快照：取最新 limit 条（按首次采集时间 discovered_at 倒序）中最老一条的时间戳，作为"从目前往后数 N 条"窗口下限。返回 {count, sinceIso}。 */
  latestWindow(limit) {
    const n = Number(limit) > 0 ? Number(limit) : 100;
    const rows = this.db.prepare("SELECT discovered_at FROM items ORDER BY discovered_at DESC LIMIT ?").all(n);
    if (!rows.length) return { count: 0, sinceIso: "" };
    const oldest = rows[rows.length - 1].discovered_at;
    return { count: rows.length, sinceIso: String(oldest || "") };
  }

  /** 窗口 [sinceIso, untilIso) 内各状态计数（供按数量模式的进度条）。 */
  countsBetween(sinceIso, untilIso) {
    if (!sinceIso || !untilIso) return [];
    return this.db.prepare("SELECT status, COUNT(*) AS count FROM items WHERE discovered_at >= ? AND discovered_at < ? GROUP BY status ORDER BY status")
      .all(String(sinceIso), String(untilIso));
  }

  listWrittenOn(date) {
    const day = String(date || "").slice(0, 10);
    if (!day) return [];
    return this.db.prepare(
      "SELECT * FROM items WHERE status = 'written' AND substr(updated_at, 1, 10) = ? ORDER BY updated_at DESC"
    ).all(day);
  }

  upsertCreator(creator) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO creators (sec_uid, nickname, profile_url, source_input, vault_slug, discovered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sec_uid) DO UPDATE SET
        nickname=excluded.nickname,
        profile_url=excluded.profile_url,
        source_input=CASE WHEN excluded.source_input <> '' THEN excluded.source_input ELSE creators.source_input END,
        vault_slug=CASE WHEN creators.vault_slug = '' THEN excluded.vault_slug ELSE creators.vault_slug END,
        updated_at=excluded.updated_at
    `).run(
      String(creator.sec_uid),
      String(creator.nickname || ""),
      String(creator.profile_url || `https://www.douyin.com/user/${creator.sec_uid}`),
      String(creator.source_input || ""),
      String(creator.vault_slug || ""),
      timestamp,
      timestamp,
    );
  }

  getCreator(secUid) {
    return this.db.prepare("SELECT * FROM creators WHERE sec_uid = ?").get(String(secUid));
  }

  listCreators(limit = 50) {
    return this.db.prepare("SELECT * FROM creators ORDER BY updated_at DESC LIMIT ?").all(Number(limit));
  }

  associateCreatorItem(secUid, awemeId, rank = 0) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO creator_items (sec_uid, aweme_id, rank, discovered_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sec_uid, aweme_id) DO UPDATE SET rank=excluded.rank, updated_at=excluded.updated_at
    `).run(String(secUid), String(awemeId), Number(rank || 0), timestamp, timestamp);
  }

  listCreatorItems(secUid, { status = "", limit = 200 } = {}) {
    const columns = `i.*, ci.sec_uid AS creator_sec_uid, ci.rank AS creator_rank,
      ci.analysis_status AS creator_analysis_status, ci.analysis_path AS creator_analysis_path,
      ci.analysis_sha256 AS creator_analysis_sha256, ci.note_path AS creator_note_path,
      ci.note_sha256 AS creator_note_sha256, ci.last_error AS creator_last_error`;
    if (status) {
      return this.db.prepare(`
        SELECT ${columns} FROM creator_items ci
        JOIN items i ON i.aweme_id = ci.aweme_id
        WHERE ci.sec_uid = ? AND ci.analysis_status = ?
        ORDER BY ci.rank ASC LIMIT ?
      `).all(String(secUid), String(status), Number(limit));
    }
    return this.db.prepare(`
      SELECT ${columns} FROM creator_items ci
      JOIN items i ON i.aweme_id = ci.aweme_id
      WHERE ci.sec_uid = ? ORDER BY ci.rank ASC LIMIT ?
    `).all(String(secUid), Number(limit));
  }

  getCreatorItem(secUid, awemeId) {
    return this.db.prepare(`
      SELECT i.*, ci.sec_uid AS creator_sec_uid, ci.rank AS creator_rank,
        ci.analysis_status AS creator_analysis_status, ci.analysis_path AS creator_analysis_path,
        ci.analysis_sha256 AS creator_analysis_sha256, ci.note_path AS creator_note_path,
        ci.note_sha256 AS creator_note_sha256, ci.last_error AS creator_last_error
      FROM creator_items ci
      JOIN items i ON i.aweme_id = ci.aweme_id
      WHERE ci.sec_uid = ? AND ci.aweme_id = ?
    `).get(String(secUid), String(awemeId));
  }

  creatorCounts(secUid) {
    return this.db.prepare(`
      SELECT analysis_status AS status, COUNT(*) AS count
      FROM creator_items WHERE sec_uid = ? GROUP BY analysis_status ORDER BY analysis_status
    `).all(String(secUid));
  }

  markCreatorAnalyzed(secUid, awemeId, artifact) {
    this.db.prepare(`
      UPDATE creator_items SET analysis_status='analyzed', analysis_path=?, analysis_sha256=?,
        last_error=NULL, updated_at=? WHERE sec_uid=? AND aweme_id=?
    `).run(artifact.path, artifact.sha256, now(), String(secUid), String(awemeId));
  }

  markCreatorPrepared(secUid, awemeId) {
    this.db.prepare(`
      UPDATE creator_items SET analysis_status='pending', last_error=NULL, updated_at=?
      WHERE sec_uid=? AND aweme_id=? AND analysis_status IN ('pending', 'failed')
    `).run(now(), String(secUid), String(awemeId));
  }

  markCreatorSkipped(secUid, awemeId, reason) {
    this.db.prepare(`
      UPDATE creator_items SET analysis_status='skipped', last_error=?, updated_at=?
      WHERE sec_uid=? AND aweme_id=? AND analysis_status NOT IN ('analyzed', 'written')
    `).run(String(reason || "not a video post").slice(0, 2000), now(), String(secUid), String(awemeId));
  }

  markCreatorVideoWritten(secUid, awemeId, artifact) {
    this.db.prepare(`
      UPDATE creator_items SET analysis_status='written', note_path=?, note_sha256=?,
        last_error=NULL, updated_at=? WHERE sec_uid=? AND aweme_id=?
    `).run(artifact.path, artifact.sha256, now(), String(secUid), String(awemeId));
  }

  markCreatorItemFailed(secUid, awemeId, message) {
    this.db.prepare(`
      UPDATE creator_items SET analysis_status='failed', last_error=?, updated_at=?
      WHERE sec_uid=? AND aweme_id=?
    `).run(String(message || "unknown error").slice(0, 2000), now(), String(secUid), String(awemeId));
  }

  markCreatorSynthesis(secUid, artifact) {
    this.db.prepare(`
      UPDATE creators SET synthesis_path=?, synthesis_sha256=?, updated_at=? WHERE sec_uid=?
    `).run(artifact.path, artifact.sha256, now(), String(secUid));
  }

  markCreatorOverview(secUid, artifact) {
    this.db.prepare(`
      UPDATE creators SET overview_path=?, overview_sha256=?, updated_at=? WHERE sec_uid=?
    `).run(artifact.path, artifact.sha256, now(), String(secUid));
  }

  markMediaFrozen(awemeId, artifact) {
    this.db.prepare(`
      UPDATE items SET status='media_frozen', media_path=?, media_sha256=?,
        media_bytes=?, media_duration_seconds=?, resume_status=NULL, last_error=NULL, updated_at=?
      WHERE aweme_id=?
    `).run(
      artifact.path,
      artifact.sha256,
      artifact.bytes,
      artifact.durationSeconds,
      now(),
      String(awemeId)
    );
  }

  markTranscribed(awemeId, artifact) {
    this.db.prepare(`
      UPDATE items SET status='transcribed', transcript_path=?, transcript_sha256=?,
        resume_status=NULL, last_error=NULL, updated_at=? WHERE aweme_id=?
    `).run(artifact.path, artifact.sha256, now(), String(awemeId));
  }

  markExtracted(awemeId, artifact) {
    this.db.prepare(`
      UPDATE items SET status='extracted', knowledge_path=?, knowledge_sha256=?,
        extractor_provider=?, extractor_version=?, resume_status=NULL,
        last_error=NULL, updated_at=? WHERE aweme_id=?
    `).run(
      artifact.path,
      artifact.sha256,
      artifact.provider,
      artifact.version,
      now(),
      String(awemeId)
    );
  }

  markWritten(awemeId, artifact, category = "", subcategory = "", group = "") {
    this.db.prepare(`
      UPDATE items SET status='written', note_path=?, note_sha256=?, category=?, subcategory=?, "group"=?,
        resume_status=NULL, last_error=NULL, updated_at=? WHERE aweme_id=?
    `).run(artifact.path, artifact.sha256, String(category || "").slice(0, 60), String(subcategory || "").slice(0, 60), String(group || "").slice(0, 60), now(), String(awemeId));
  }

  listWrittenByCategory(category, { limit = 200, exclude = "" } = {}) {
    const cat = String(category || "").trim();
    const rows = this.db.prepare(
      "SELECT * FROM items WHERE status='written' AND category=? ORDER BY updated_at DESC LIMIT ?"
    ).all(cat, limit);
    return exclude ? rows.filter(row => String(row.aweme_id) !== String(exclude)) : rows;
  }

  /** 按大类统计 written 笔记数（用于知识卡片阈值判断）。 */
  countWrittenByCategory(category) {
    const cat = String(category || "").trim();
    if (!cat) return 0;
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM items WHERE status='written' AND category=?").get(cat);
    return Number(row?.n || 0);
  }

  /** 所有大类及其 written 笔记数（含空大类）。 */
  writtenCountsByCategory() {
    return this.db.prepare(
      "SELECT category, COUNT(*) AS n FROM items WHERE status='written' GROUP BY category ORDER BY n DESC"
    ).all().map(row => ({ category: String(row.category || ""), count: Number(row.n || 0) }));
  }

  updateNoteSha256(awemeId, sha256) {
    this.db.prepare("UPDATE items SET note_sha256=?, updated_at=? WHERE aweme_id=?")
      .run(String(sha256), now(), String(awemeId));
  }

  updateNotePath(awemeId, notePath) {
    this.db.prepare("UPDATE items SET note_path=?, updated_at=? WHERE aweme_id=?")
      .run(String(notePath), now(), String(awemeId));
  }

  markFailed(awemeId, message, resumeStatus = "discovered") {
    this.db.prepare("UPDATE items SET status='failed', resume_status=?, last_error=?, updated_at=? WHERE aweme_id=?")
      .run(String(resumeStatus), String(message || "unknown error").slice(0, 2000), now(), String(awemeId));
  }

  /** 标记为"跳过不总结"（广告/短剧/搞笑类），reason 记录原因；后续处理自动排除。 */
  markSkipped(awemeId, reason = "skipped") {
    this.db.prepare("UPDATE items SET status='skipped', resume_status=NULL, last_error=?, updated_at=? WHERE aweme_id=?")
      .run(String(reason).slice(0, 2000), now(), String(awemeId));
  }

  /** 把 create_time 早于指定秒数（起始日期）且仍未处理的条目永久标记为 skipped（原状态存入 resume_status，便于日后恢复），不再进入候选/重试。 */
  skipBeforeCreateTime(epochSeconds, reason = "before-start-date") {
    return this.db.prepare(`
      UPDATE items SET status='skipped', resume_status=status, last_error=?,
        updated_at=? WHERE status<>'written' AND status<>'skipped' AND create_time>0 AND create_time < ?
    `).run(String(reason).slice(0, 2000), now(), Number(epochSeconds)).changes;
  }

  /** 按收藏时间（discovered_at）打标：discovered_at 早于 isoCutoff 的未处理条目标记 skipped（原状态存入 resume_status 便于恢复）。起始日期语义统一为"该日期（含）之后收藏的视频"。 */
  skipBeforeDiscoveredAt(isoCutoff, reason = "before-start-date") {
    return this.db.prepare(`
      UPDATE items SET status='skipped', resume_status=status, last_error=?,
        updated_at=? WHERE status<>'written' AND status<>'skipped' AND discovered_at IS NOT NULL AND discovered_at < ?
    `).run(String(reason).slice(0, 2000), now(), String(isoCutoff)).changes;
  }

  /** 恢复所有因指定 reason 被跳过/归档的条目（还原到打标前状态），供"改日期/清空日期"后重新进入处理。 */
  /** 按收藏时间（discovered_at）统计状态分布；空值=全库。供桌面端"起始日期窗口进度"使用。 */
  countsSinceDiscovered(isoCutoff = "") {
    if (!isoCutoff) return this.counts();
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) n FROM items WHERE discovered_at IS NOT NULL AND discovered_at >= ?
      GROUP BY status
    `).all(String(isoCutoff));
    const counts = {};
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  }

  /** 按视频发布时间（create_time >= epochSec）统计状态分布；用于"起始日期 = 收藏的视频的发布时间"窗口口径。 */
  countsSinceCreateTime(epochSec) {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) n FROM items WHERE create_time > 0 AND create_time >= ?
      GROUP BY status
    `).all(Number(epochSec));
    const counts = {};
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  }

  restoreByReason(reason) {
    return this.db.prepare(`
      UPDATE items SET status=COALESCE(resume_status, 'discovered'), resume_status=NULL,
        last_error=NULL, updated_at=? WHERE status='skipped' AND last_error=?
    `).run(now(), String(reason)).changes;
  }

  /** 恢复所有因起始日期被跳过的条目（last_error=reason）：还原到打标前的状态，供"清空起始日期/改日期"后重新进入处理。 */
  restoreBeforeStartDate(reason = "before-start-date") {
    return this.db.prepare(`
      UPDATE items SET status=COALESCE(resume_status, 'discovered'), resume_status=NULL,
        last_error=NULL, updated_at=? WHERE status='skipped' AND last_error=?
    `).run(now(), String(reason)).changes;
  }

  retryFailed(awemeId = "", sinceUpdated = "") {
    if (awemeId) {
      return this.db.prepare(`
        UPDATE items SET status=COALESCE(resume_status, 'discovered'), resume_status=NULL,
          last_error=NULL, updated_at=? WHERE aweme_id=? AND status='failed'
      `).run(now(), String(awemeId)).changes;
    }
    if (sinceUpdated) {
      return this.db.prepare(`
        UPDATE items SET status=COALESCE(resume_status, 'discovered'), resume_status=NULL,
          last_error=NULL, updated_at=? WHERE status='failed' AND updated_at >= ?
      `).run(now(), String(sinceUpdated)).changes;
    }
    return this.db.prepare(`
      UPDATE items SET status=COALESCE(resume_status, 'discovered'), resume_status=NULL,
        last_error=NULL, updated_at=? WHERE status='failed'
    `).run(now()).changes;
  }
}
