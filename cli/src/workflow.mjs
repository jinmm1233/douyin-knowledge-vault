import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listSaved } from "./opencli.mjs";
import { freezeMedia } from "./media.mjs";
import { transcribeMedia } from "./transcribe.mjs";
import { extractKnowledge, suggestSubcategory, EXTRACTOR_VERSION } from "./knowledge.mjs";
import { writeObsidianNote, cleanNoteTitle } from "./obsidian.mjs";
import { runSemanticConsensus, llmJson } from "./consensus.mjs";
import { updateConsensusDoc } from "./consensus-doc.mjs";
import { loadCategoryTree, saveCategoryTree, registerVideo, listAllSubcategoryCandidates, normalizeMajorCategory } from "./classify.mjs";
import { resolveVaultLayout } from "./vault.mjs";
import { root as repoRoot } from "./config.mjs";

const execFileAsync = promisify(execFile);

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export async function discover(config, store, { includePlayUrl = false, limit = config.discoveryLimit } = {}) {
  const rows = await listSaved({ limit, includePlayUrl });
  for (const row of rows) store.upsertDiscovered(row);
  return rows;
}

export async function ingestFavorites(config, store, { file = "", maxItems = 0 } = {}) {
  const limit = Math.max(1, Math.min(maxItems || config.collectorMaxItems, 10000));
  let inputFile = String(file || "").trim();
  if (!inputFile) {
    inputFile = path.join(config.stateDir, "api-collection.json");
    const collector = path.join(repoRoot, "scripts", "collect-favorites.py");
    await execFileAsync(config.pythonCommand, [
      collector, "collect",
      "--max-items", String(limit),
      "--output", inputFile,
    ]);
  }
  if (!fs.existsSync(inputFile)) throw new Error(`collection file not found: ${inputFile}`);
  const payload = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  const items = Array.isArray(payload) ? payload : payload.items;
  if (!Array.isArray(items)) throw new Error("collection payload must be an array or an object containing items");
  // 收藏夹采集输出顶层带 collects_id/collects_name，合并进每条视频以便入库溯源与强制大类
  const folderId = String(payload?.collects_id || "");
  const folderName = String(payload?.collects_name || "").trim();
  let inserted = 0;
  for (const item of items) {
    store.upsertDiscovered({ ...item, collects_id: folderId || item.collects_id, collects_name: folderName || item.collects_name });
    inserted += 1;
  }
  return { inserted, input: inputFile, collects_id: folderId, collects_name: folderName, counts: store.counts() };
}

export function writeDailyReport(config, store, { date = "" } = {}) {
  const day = String(date || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`invalid report date: ${day}`);
  const layout = resolveVaultLayout(config);
  const reportDir = path.join(layout.root, "日报");
  fs.mkdirSync(reportDir, { recursive: true });
  const rows = store.listWrittenOn(day);
  const lines = [
    "---",
    `date: "${day}"`,
    "source: \"collection\"",
    `new_count: ${rows.length}`,
    "---",
    "",
    `# ${day} 抖音收藏日报`,
    "",
    rows.length > 0 ? `今日新增 ${rows.length} 条。` : "今日没有新增条目。",
    "",
  ];
  if (rows.length > 0) {
    lines.push("## 新增笔记", "");
    for (const row of rows) {
      const noteName = row.note_path ? path.basename(row.note_path, path.extname(row.note_path)) : row.aweme_id;
      const author = row.author ? ` - ${row.author}` : "";
      const title = String(row.title || row.aweme_id).replace(/\|/gu, "/");
      lines.push(`- [[${noteName}|${title}]]${author} ([原链接](${row.source_url}))`);
    }
    lines.push("");
  }
  const target = path.join(reportDir, `${day}-收藏日报.md`);
  fs.writeFileSync(target, lines.join("\n"), "utf8");
  return { date: day, count: rows.length, path: target };
}

export async function freeze(config, store, { limit = 1, awemeId = "" } = {}) {
  const candidates = awemeId
    ? [store.get(awemeId)].filter(Boolean)
    : store.list({ limit: 100000 }).filter(row => {
      if (row.status === "written") return false;
      if (!row.play_url) return false;
      return !row.media_path || !fs.existsSync(row.media_path);
    });
  const results = [];
  for (const row of candidates.slice(0, limit)) {
    try {
      const artifact = await freezeMedia(row, config);
      store.markMediaFrozen(row.aweme_id, artifact);
      results.push({ aweme_id: row.aweme_id, status: "media_frozen", ...artifact });
    } catch (error) {
      store.markFailed(row.aweme_id, error?.message || error, "discovered");
      results.push({ aweme_id: row.aweme_id, status: "failed", error: String(error?.message || error) });
    }
  }
  return results;
}

export async function transcribe(config, store, { limit = 1, awemeId = "" } = {}) {
  const candidates = awemeId
    ? [store.get(awemeId)].filter(Boolean)
    : store.list({ status: "media_frozen", limit });
  const results = [];
  for (const item of candidates.slice(0, limit)) {
    try {
      if (!item.media_path || !fs.existsSync(item.media_path)) {
        throw new Error("media artifact is missing; freeze the item first");
      }
      const artifact = await transcribeMedia(item, config);
      store.markTranscribed(item.aweme_id, artifact);
      results.push({ aweme_id: item.aweme_id, status: "transcribed", ...artifact });
    } catch (error) {
      store.markFailed(item.aweme_id, error?.message || error, "media_frozen");
      results.push({ aweme_id: item.aweme_id, status: "failed", error: String(error?.message || error) });
    }
  }
  return results;
}

export async function extract(config, store, { limit = 1, awemeId = "" } = {}) {
  const candidates = awemeId ? [store.get(awemeId)].filter(Boolean) : store.list({ status: "transcribed", limit });
  const results = [];
  for (const item of candidates.slice(0, limit)) {
    try {
      const artifact = await extractKnowledge(item, config);
      store.markExtracted(item.aweme_id, artifact);
      results.push({ aweme_id: item.aweme_id, status: "extracted", ...artifact });
    } catch (error) {
      store.markFailed(item.aweme_id, error?.message || error, "transcribed");
      results.push({ aweme_id: item.aweme_id, status: "failed", error: String(error?.message || error) });
    }
  }
  return results;
}

export async function write(config, store, { limit = 1, awemeId = "" } = {}) {
  const candidates = awemeId ? [store.get(awemeId)].filter(Boolean) : store.list({ status: "extracted", limit });
  const results = [];
  for (const item of candidates.slice(0, limit)) {
    try {
      const artifact = writeObsidianNote(item, config);
      const meta = knowledgeMeta(item);
      store.markWritten(item.aweme_id, artifact, meta.category, meta.subcategory, meta.group);
      registerNoteInTree(config, item, meta);
      const mediaRemoved = deleteMediaIfConfigured(config, item);
      results.push({ aweme_id: item.aweme_id, status: "written", ...artifact, media_removed: mediaRemoved });
    } catch (error) {
      store.markFailed(item.aweme_id, error?.message || error, "extracted");
      results.push({ aweme_id: item.aweme_id, status: "failed", error: String(error?.message || error) });
    }
  }
  return results;
}

function knowledgeMeta(item) {
  try {
    if (!item?.knowledge_path || !fs.existsSync(item.knowledge_path)) return { category: "", group: "", subcategory: "", sampleText: "" };
    const knowledge = JSON.parse(fs.readFileSync(item.knowledge_path, "utf8"));
    return {
      category: String(knowledge.category || ""),
      group: String(knowledge.group || ""),
      subcategory: String(knowledge.subcategory || ""),
      sampleText: String(knowledge.thesis || knowledge.summary || "").slice(0, 120),
    };
  } catch {
    return { category: "", group: "", subcategory: "", sampleText: "" };
  }
}

function registerNoteInTree(config, item, meta = knowledgeMeta(item)) {
  if (!config.classifyDynamicSubcategories) return;
  const tree = loadCategoryTree(config);
  registerVideo(config, tree, { major: meta.category, group: meta.group, sub: meta.subcategory, awemeId: item.aweme_id, sampleText: meta.sampleText, forcedMajor: item.collects_name || "" });
  saveCategoryTree(config, tree);
}

export function deleteMediaIfConfigured(config, item) {
  if (!config.deleteMediaAfterWrite) return false;
  const mediaPath = item?.media_path;
  if (!mediaPath) return false;
  try {
    if (fs.existsSync(mediaPath)) {
      fs.rmSync(mediaPath, { force: true });
      return true;
    }
  } catch {
    // best-effort cleanup; a locked file should not fail the pipeline
  }
  return false;
}

export function pruneMedia(config, store) {
  const rows = store.list({ limit: 100000 });
  let removed = 0;
  let bytesFreed = 0;
  for (const row of rows) {
    if (row.status === "written" && row.media_path && fs.existsSync(row.media_path)) {
      try {
        const size = fs.statSync(row.media_path).size;
        fs.rmSync(row.media_path, { force: true });
        removed += 1;
        bytesFreed += size;
      } catch {
        // best-effort cleanup
      }
    }
  }
  return { removed, bytesFreed, counts: store.counts() };
}

/** 存量 written 笔记迁移到 大类/子类 目录：判定子类 → 重写 knowledge.json → 移动笔记 → 登记分类树。 */
/** 三级分类建议：给定知识摘要，判断 大类/主题父类/具体子类。 */
async function suggestGroupedCategory(config, knowledge, candidates) {
  const prompt = [
    "根据下面视频的知识摘要，把它归入最合适的分类（三级：大类/主题父类/具体子类）。",
    "概念：group=主题父类，是宏观的主题领域（4-16 字，如：AI与剪辑、Codex、基金、徒步攻略、AI网页生成）；subcategory=具体子类，是该父类下的具体内容（2-14 字，如：达芬奇AI景深对焦、AI剪辑省Token、纳斯达克、标普500、云南旅游攻略）。group 和 subcategory 必须是不同粒度、不能同名。",
    "归并规则：若候选列表里已有主题相同或相近的父类/子类，必须沿用其名字；同地点/同工具/同标的的不同叫法视为同一类（如“广西戈见山”与“河池戈见”同为“戈见山徒步攻略”）；拿不准时优先归入已有类，不要轻易新建。",
    "预置主题父类规则（用于旧式两级分类的归并，同类必须归入）:",
    "- AI与科技 下：剪辑/生成/编辑/复刻/拉片/景深/省Token/换景换角/PPT生成/视频美学 等视频制作类 → 父类「AI与剪辑」；任何 Codex 相关（安装、代剪、制作网站、自动剪辑工作台、开发）→ 父类「Codex」；AI 生成网页/3D网页 → 父类「AI网页生成」；AI 情感分析/聊天回复/军师 → 父类「AI情感助手」；其他 AI 类按主题自建父类。",
    "- 财经与投资 下：定投/指数/基金/ETF/纳斯达克/标普500/黄金/宽基 → 父类「基金」，具体子类按标的划分（讲纳斯达克 → 纳斯达克，讲标普500 → 标普500，讲黄金 → 黄金）；储蓄/资产配置/经济周期/境外取现 → 按内容自建父类。",
    "候选列表可能是三级（大类/父类/子类）或两级（大类/旧子类）。两级时，“旧子类”是具体内容名，不能直接当父类——你需按上面规则为它找到或新建宏观主题父类。",
    "返回单个 JSON 对象：{ category, group, subcategory, subcategoryReason }。",
    `现有分类（大类/父类/子类）：\n${candidates.join("\n")}`,
    `标题：${String(knowledge?.title || "")}`,
    `摘要：${String(knowledge?.thesis || "").slice(0, 300)}`,
    `要点：${String(knowledge?.summary || "").slice(0, 300)}`,
    `标签：${(knowledge?.tags || []).join("、")}`,
  ].join("\n");
  const payload = await llmJson(config, "你是严谨的知识分类专家。", prompt, { timeoutMs: 90000 });
  return {
    category: String(payload?.category || ""),
    group: String(payload?.group || ""),
    subcategory: String(payload?.subcategory || ""),
    subcategoryReason: String(payload?.subcategoryReason || ""),
  };
}

export async function reclassifyWritten(config, store, { limit = 100, grouped = false, awemeId = "" } = {}) {
  const rows = awemeId
    ? [store.get(awemeId)].filter(Boolean)
    : store.list({ limit: 100000 }).filter(row => row.status === "written");
  const tree = loadCategoryTree(config);
  const candidates = listAllSubcategoryCandidates(tree);
  const results = [];
  for (const item of rows.slice(0, limit)) {
    try {
      if (!item.knowledge_path || !fs.existsSync(item.knowledge_path)) throw new Error("knowledge missing");
      const knowledge = JSON.parse(fs.readFileSync(item.knowledge_path, "utf8"));
      if (grouped) {
        const suggestion = await suggestGroupedCategory(config, { ...knowledge, title: item.title }, candidates);
        if (!suggestion.category && !suggestion.subcategory) throw new Error("empty classification suggestion");
        knowledge.category = normalizeMajorCategory(suggestion.category) || knowledge.category;
        knowledge.group = suggestion.group;
        knowledge.subcategory = suggestion.subcategory || knowledge.subcategory;
        knowledge.subcategoryReason = suggestion.subcategoryReason;
      } else if (!knowledge.subcategory || knowledge.subcategory === "未分类") {
        const suggestion = await suggestSubcategory(config, knowledge);
        knowledge.category = suggestion.category;
        knowledge.group = "";
        knowledge.subcategory = suggestion.subcategory;
        knowledge.subcategoryReason = suggestion.subcategoryReason;
      }
      const content = `${JSON.stringify(knowledge, null, 2)}\n`;
      const sha256 = sha256Text(content);
      fs.writeFileSync(item.knowledge_path, content, "utf8");
      const manifestFile = item.knowledge_path.replace(/knowledge\.json$/u, "knowledge-manifest.json");
      if (fs.existsSync(manifestFile)) {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        manifest.version = EXTRACTOR_VERSION;
        manifest.knowledgeSha256 = sha256;
        fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      }
      const note = writeObsidianNote(item, config);
      if (path.normalize(note.path).toLowerCase() !== path.normalize(item.note_path || "").toLowerCase()) {
        // migrate: remove the old note file after the new one is written
        // Windows 大小写不敏感：必须规范化后比较，否则"旧名与新名只有大小写差异"时会误删新文件
        try { if (item.note_path && fs.existsSync(item.note_path)) fs.rmSync(item.note_path, { force: true }); } catch {}
      }
      store.markWritten(item.aweme_id, note, knowledge.category, knowledge.subcategory, knowledge.group || "");
      registerNoteInTree(config, item, { category: knowledge.category, group: knowledge.group || "", subcategory: knowledge.subcategory, sampleText: String(knowledge.thesis || knowledge.summary || "").slice(0, 120) });
      results.push({ aweme_id: item.aweme_id, status: "written", note_path: note.path, category: knowledge.category, group: knowledge.group || "", subcategory: knowledge.subcategory, migrated: note.path !== item.note_path });
    } catch (error) {
      results.push({ aweme_id: item.aweme_id, status: "failed", error: String(error?.message || error) });
    }
  }
  return results;
}

function noteFrontmatterAwemeId(file) {
  try {
    const content = fs.readFileSync(file, "utf8");
    const match = /^aweme_id:\s*"([^"]+)"/mu.exec(content) || /^aweme_id:\s*(\S+)/mu.exec(content);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

/** 把已有笔记的文件名从 aweme_id 改成视频标题（重名时加短 ID 后缀），并同步更新日报里的双链引用。 */
export function migrateNoteNames(config, store, { limit = 500 } = {}) {
  const rows = store.list({ limit: 100000 }).filter(row => row.status === "written");
  const layout = resolveVaultLayout(config);
  const results = [];
  const linkRenames = [];
  for (const item of rows.slice(0, limit)) {
    try {
      if (!item.note_path || !fs.existsSync(item.note_path)) throw new Error("note file missing");
      const knowledge = item.knowledge_path && fs.existsSync(item.knowledge_path)
        ? JSON.parse(fs.readFileSync(item.knowledge_path, "utf8"))
        : {};
      const category = safeCategoryName(knowledge.category);
      const subcategory = safeCategoryName(knowledge.subcategory);
      const directory = category === "未分类" || !layout.knowledge
        ? layout.inbox
        : subcategory === "未分类"
          ? path.join(layout.knowledge, category)
          : path.join(layout.knowledge, category, subcategory);
      const baseName = cleanNoteTitle(item.title, item.aweme_id);
      let target = path.join(directory, `${baseName}.md`);
      if (target !== item.note_path && fs.existsSync(target)) {
        const existingAweme = noteFrontmatterAwemeId(target);
        if (existingAweme && existingAweme !== item.aweme_id) {
          target = path.join(directory, `${baseName}-${String(item.aweme_id).slice(-8)}.md`);
        }
      }
      if (target === item.note_path) {
        results.push({ aweme_id: item.aweme_id, status: "unchanged", note_path: target });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(item.note_path, target);
      fs.rmSync(item.note_path, { force: true });
      store.updateNotePath(item.aweme_id, target);
      const oldBase = path.basename(item.note_path, path.extname(item.note_path));
      const newBase = path.basename(target, path.extname(target));
      if (oldBase !== newBase) linkRenames.push({ oldBase, newBase });
      results.push({ aweme_id: item.aweme_id, status: "renamed", note_path: target });
    } catch (error) {
      results.push({ aweme_id: item.aweme_id, status: "failed", error: String(error?.message || error) });
    }
  }
  let reportsUpdated = 0;
  if (linkRenames.length && layout.root) {
    const reportDir = path.join(layout.root, "日报");
    if (fs.existsSync(reportDir)) {
      for (const file of fs.readdirSync(reportDir)) {
        if (!file.endsWith(".md")) continue;
        const reportPath = path.join(reportDir, file);
        let content = fs.readFileSync(reportPath, "utf8");
        let changed = false;
        for (const { oldBase, newBase } of linkRenames) {
          const pattern = new RegExp(`\\[\\[\\s*${escapeRegExp(oldBase)}\\b`, "gu");
          if (pattern.test(content)) {
            content = content.replace(pattern, `[[${newBase}`);
            changed = true;
          }
        }
        if (changed) {
          fs.writeFileSync(reportPath, content, "utf8");
          reportsUpdated += 1;
        }
      }
    }
  }
  return { results, reportsUpdated, renamed: results.filter(r => r.status === "renamed").length };
}

function safeCategoryName(value) {
  return String(value || "").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "").trim().slice(0, 40) || "未分类";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** 网络类失败（断网/超时/连接重置）：不视为永久失败，保留重试机会。 */
export function isNetworkFailure(message) {
  const text = String(message || "");
  return ["fetch failed", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH",
    "timed out", "timeout", "network", "socket hang up", "SIGTERM"].some(hint => text.includes(hint));
}

/** 视频本身无料导致的永久失败：转录覆盖不足、无可用字幕、知识提取为空。重试结果不变，首次失败即放弃。 */
export function isPermanentFailure(message) {
  const text = String(message || "");
  return /transcription does not cover enough of the media timeline/.test(text)
    || /transcription produced no usable text segments/.test(text)
    || /knowledge field \S+ is empty/.test(text);
}

/** 转录文本"无重点"预筛：整段极短，或去除闲聊/招呼词后没有实质内容 → 直接跳过，不调云端模型。 */
export function transcriptHasSubstance(transcriptPath) {
  let text = "";
  try {
    const t = JSON.parse(fs.readFileSync(transcriptPath, "utf8").replace(/^\uFEFF/u, ""));
    text = Array.isArray(t.segments) ? t.segments.map(s => s.text || "").join(" ") : String(t.text || "");
  } catch {
    return true; // 读不到按有料处理，交给下游报错
  }
  const compact = String(text).replace(/\s+/gu, "");
  if (compact.length < 60) return false;
  const stripped = compact.replace(/(哈+|嘿+|嘻+|呵+|吼+|嗯+|啊+|哦+|呢+|呀+|吧+|嘛+|哟+|啦+|哈喽|你好|美女|帅哥|早安|晚安|再见)+/gu, "");
  return stripped.length >= 30;
}

export async function sync(config, store, { limit = 1, awemeId = "", skipConsensusDoc = false } = {}) {
  const release = acquireSyncLock(config.stateDir);
  try {
    let rows = [];
    if (awemeId) {
      const item = store.get(awemeId);
      if (item) rows = [item];
    } else {
      rows = await discover(config, store, { includePlayUrl: true, limit: config.discoveryLimit });
      rows = rows.filter(row => !["written", "skipped"].includes(store.get(row.aweme_id)?.status)).slice(0, limit);
    }
    const results = [];
    for (const row of rows) {
      let stage = "discovered";
      try {
        let item = store.get(row.aweme_id);
        if (!item.media_path || !fs.existsSync(item.media_path)) {
          const artifact = await freezeMedia(row, config);
          store.markMediaFrozen(row.aweme_id, artifact);
        }
        stage = "media_frozen";
        item = store.get(row.aweme_id);
        const transcriptArtifact = await transcribeMedia(item, config);
        store.markTranscribed(item.aweme_id, transcriptArtifact);
        stage = "transcribed";
        item = store.get(row.aweme_id);
        // 字幕无重点预筛：整段极短或全为闲聊招呼词 → 直接跳过，不调云端模型、不写笔记
        if (!transcriptHasSubstance(transcriptArtifact.path)) {
          store.markSkipped(item.aweme_id, "transcript-no-substance");
          if (item.media_path && fs.existsSync(item.media_path)) {
            try { fs.rmSync(item.media_path, { force: true }); } catch {}
          }
          results.push({ aweme_id: item.aweme_id, status: "skipped", transcriptNoSubstance: true });
          continue;
        }
        const knowledgeArtifact = await extractKnowledge(item, config);
        store.markExtracted(item.aweme_id, knowledgeArtifact);
        stage = "extracted";
        item = store.get(row.aweme_id);
        const knowledgeData = JSON.parse(fs.readFileSync(knowledgeArtifact.path, "utf8"));
        const contentType = String(knowledgeData.contentType || "normal");
        if (["ad", "shortdrama", "funny", "music", "dance", "performance", "visual", "food-show"].includes(contentType)) {
          store.markSkipped(item.aweme_id, `contentType=${contentType}`);
          if (item.media_path && fs.existsSync(item.media_path)) {
            try { fs.rmSync(item.media_path, { force: true }); } catch {}
          }
          results.push({ aweme_id: item.aweme_id, status: "skipped", contentType });
          continue;
        }
        const note = writeObsidianNote(item, config);
        const meta = knowledgeMeta(item);
        store.markWritten(item.aweme_id, note, meta.category, meta.subcategory, meta.group);
        registerNoteInTree(config, item, meta);
        const mediaRemoved = deleteMediaIfConfigured(config, item);
        const consensusResult = config.consensusSemantic
          ? await runSemanticConsensus(config, store, store.get(row.aweme_id)).catch(error => ({ matched: 0, notesUpdated: 0, error: String(error?.message || error) }))
          : null;
        const consensusDoc = !skipConsensusDoc
          ? await updateConsensusDoc(config, store, { awemeId: item.aweme_id }).catch(error => ({ error: String(error?.message || error) }))
          : null;
        results.push({ aweme_id: item.aweme_id, status: "written", note_path: note.path, resumed: note.resumed, media_removed: mediaRemoved, consensus: consensusResult, consensusDoc });
      } catch (error) {
        const message = error?.message || String(error);
        const wasFailed = store.get(row.aweme_id)?.status === "failed";
        const permanent = isPermanentFailure(message);
        if (permanent || (wasFailed && !isNetworkFailure(message))) {
          // 视频本身无料（覆盖不足/无字幕/提取为空）首次即放弃；或上次已失败、本次重试仍失败（且非网络类）放弃。
          // 两类都不再进入后续任何自动候选，避免无效重试循环。
          store.markSkipped(row.aweme_id, `${permanent ? "permanent-failed" : "retry-failed"}:${stage}: ${message.slice(0, 120)}`);
          results.push({ aweme_id: row.aweme_id, status: "skipped", retryFailed: !permanent, stage, error: message });
        } else {
          // 首次失败，或网络类失败（断网续跑 / 次日网络恢复后仍可重试）
          store.markFailed(row.aweme_id, message, stage);
          results.push({ aweme_id: row.aweme_id, status: "failed", stage, error: message });
        }
      }
    }
    return results;
  } finally {
    release();
  }
}

export function acquireSyncLock(stateDir, staleAfterMs = 6 * 60 * 60 * 1000) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "sync.lock");
  try {
    const existing = JSON.parse(fs.readFileSync(file, "utf8"));
    const age = Date.now() - Date.parse(existing.startedAt || 0);
    let processAlive = false;
    try {
      process.kill(Number(existing.pid), 0);
      processAlive = true;
    } catch {}
    if (!processAlive || age > staleAfterMs) fs.rmSync(file, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") fs.rmSync(file, { force: true });
  }
  let descriptor;
  try {
    descriptor = fs.openSync(file, "wx");
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("another sync is already running");
    throw error;
  }
  return () => {
    try { fs.closeSync(descriptor); } catch {}
    fs.rmSync(file, { force: true });
  };
}
