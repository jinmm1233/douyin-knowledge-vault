import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { initializeVault } from "./vault.mjs";

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function isoFromEpoch(seconds) {
  const number = Number(seconds || 0);
  return number > 0 ? new Date(number * 1000).toISOString() : "";
}

function canonicalUrl(awemeId) {
  return `https://www.douyin.com/video/${String(awemeId)}`;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  try {
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

export function safeCategory(value) {
  const cleaned = String(value || "").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "").trim().slice(0, 40);
  return cleaned || "未分类";
}

export function safeSubcategory(value) {
  const cleaned = String(value || "").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "").trim().slice(0, 40);
  return cleaned && cleaned !== "未分类" ? cleaned : "未分类";
}

/** 把视频标题清洗为安全的 Obsidian 笔记文件名（不含扩展名）。 */
export function cleanNoteTitle(value, fallback = "") {
  const cleaned = String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_")
    .replace(/[[\]{}()#^`~!@$%&+,;='"]/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^[_.\s]+|[_.\s]+$/gu, "")
    .slice(0, 35);
  return cleaned || String(fallback || "抖音收藏视频");
}

function readFrontmatterAwemeId(file) {
  try {
    const content = fs.readFileSync(file, "utf8");
    const match = /^aweme_id:\s*"([^"]+)"/mu.exec(content) || /^aweme_id:\s*(\S+)/mu.exec(content);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

export function renderNote(item, knowledge, config) {
  const title = String(item.title || `抖音收藏 ${item.aweme_id}`).replace(/\s+/gu, " ").trim();
  const tags = [...new Set(["douyin-knowledge", ...(knowledge.tags || [])])];
  const lines = [
    "---",
    "schema_version: 1",
    `aweme_id: ${yamlString(item.aweme_id)}`,
    `title: ${yamlString(title)}`,
    `author: ${yamlString(item.author)}`,
    `source_url: ${yamlString(canonicalUrl(item.aweme_id))}`,
    `published_at: ${yamlString(isoFromEpoch(item.create_time))}`,
    `discovered_at: ${yamlString(item.discovered_at)}`,
    `media_sha256: ${yamlString(item.media_sha256)}`,
    `transcript_sha256: ${yamlString(item.transcript_sha256)}`,
    `transcript_model: ${yamlString(config.whisperModelLabel)}`,
    `knowledge_sha256: ${yamlString(item.knowledge_sha256)}`,
    `extractor: ${yamlString(item.extractor_provider)}`,
    `extractor_version: ${yamlString(item.extractor_version)}`,
    `category: ${yamlString(safeCategory(knowledge.category))}`,
    `subcategory: ${yamlString(safeSubcategory(knowledge.subcategory))}`,
    "tags:",
    ...tags.map(tag => `  - ${yamlString(tag)}`),
    "---",
    "",
    `# ${title}`,
    "",
    "## 一句话结论",
    "",
    knowledge.thesis,
    "",
    "## 摘要",
    "",
    knowledge.summary,
    "",
    "## 关键知识",
    "",
    ...knowledge.keyIdeas.flatMap(idea => [
      `### ${idea.timestamp} ${idea.title}`,
      "",
      idea.detail,
      "",
      `> 转录依据：${idea.sourceExcerpt}`,
      "",
    ]),
    "## 可执行步骤",
    "",
    ...knowledge.actions.flatMap((action, index) => [
      `${index + 1}. **${action.timestamp}** ${action.action}`,
      `   - 完成信号：${action.completionSignal}`,
    ]),
    "",
    "## 局限与待核实",
    "",
    ...knowledge.limitations.map(value => `- ${value}`),
    ...knowledge.verificationNeeds.map(value => `- **${value.timestamp}** ${value.claim} — ${value.reason}`),
    "",
    "## 相关概念",
    "",
    knowledge.relatedConcepts.length ? knowledge.relatedConcepts.map(value => `- [[${value}]]`).join("\n") : "- 暂无",
    "",
    "## 来源与溯源",
    "",
    `- 原视频：${canonicalUrl(item.aweme_id)}`,
    `- 作者：${item.author || "未知"}`,
    `- 媒体 SHA-256：\`${item.media_sha256}\``,
    `- 转录 SHA-256：\`${item.transcript_sha256}\``,
    `- 知识 SHA-256：\`${item.knowledge_sha256}\``,
    `- 提取器：\`${item.extractor_provider}@${item.extractor_version}\``,
    "",
  ];
  const content = `${lines.join("\n")}\n`;
  if (/https?:\/\/[^\s)]+[?&](?:token|signature|x-signature|expires)=/iu.test(content)) {
    throw new Error("refusing to write a note containing a signed media URL");
  }
  return content;
}

export function writeObsidianNote(item, config) {
  if (!item.knowledge_path || !fs.existsSync(item.knowledge_path)) throw new Error("knowledge artifact is missing");
  const knowledge = JSON.parse(fs.readFileSync(item.knowledge_path, "utf8"));
  const layout = initializeVault(config);
  const category = safeCategory(knowledge.category);
  const subcategory = safeSubcategory(knowledge.subcategory);
  const group = safeSubcategory(knowledge.group);
  const directory = category === "未分类" || !layout.knowledge
    ? layout.inbox
    : group && group !== "未分类"
      ? path.join(layout.knowledge, category, group, subcategory)
      : subcategory === "未分类"
        ? path.join(layout.knowledge, category)
        : path.join(layout.knowledge, category, subcategory);
  const baseName = cleanNoteTitle(item.title, item.aweme_id);
  let file = path.join(directory, `${baseName}.md`);
  if (fs.existsSync(file)) {
    const existingAweme = readFrontmatterAwemeId(file);
    if (existingAweme && existingAweme !== item.aweme_id) {
      file = path.join(directory, `${baseName}-${String(item.aweme_id).slice(-8)}.md`);
    }
  }
  const content = renderNote(item, knowledge, config);
  const sha256 = sha256Text(content);
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8");
    const existingSha256 = sha256Text(existing);
    if (existingSha256 === sha256) return { path: file, sha256, resumed: true };
    if (item.note_sha256 && existingSha256 !== item.note_sha256) {
      throw new Error("Obsidian note changed outside the workflow; refusing to overwrite it");
    }
  }
  atomicWrite(file, content);
  return { path: file, sha256, resumed: false };
}
