import fs from "node:fs";
import path from "node:path";
import { llmJson } from "./consensus.mjs";
import { resolveVaultLayout } from "./vault.mjs";

export const CONSENSUS_DOC_NAME = "00-共识观点.md";

function safeName(value) {
  return String(value || "").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "").trim().slice(0, 40) || "未分类";
}

function noteLink(item) {
  if (!item?.note_path) return "";
  const base = path.basename(item.note_path, path.extname(item.note_path));
  return base && base !== item.aweme_id ? `[[${base}]]` : `[[${item.aweme_id}]]`;
}

function loadView(item) {
  let thesis = "";
  let ideas = [];
  if (item?.knowledge_path && fs.existsSync(item.knowledge_path)) {
    try {
      const knowledge = JSON.parse(fs.readFileSync(item.knowledge_path, "utf8"));
      thesis = String(knowledge.thesis || "");
      ideas = (knowledge.keyIdeas || []).map(idea => `${idea.title}：${idea.detail}`);
    } catch {}
  }
  return { thesis, ideas };
}

function collectSubcategoryItems(store, category, subcategory, group = "") {
  const rows = store.listWrittenByCategory(category, { limit: 500 });
  return rows.filter(row => String(row.subcategory || "未分类") === subcategory && String(row.group || "") === group);
}

function buildVideoBlock(items) {
  const blocks = [];
  for (const item of items) {
    const { ideas } = loadView(item);
    if (!ideas.length) continue;
    const link = noteLink(item) || item.aweme_id;
    const title = String(item.title || item.aweme_id).replace(/\s+/gu, " ").trim().slice(0, 80);
    const bullets = ideas.slice(0, 12).map(idea => `- ${idea}`).join("\n");
    blocks.push(`视频《${title}》（链接 ${link}）\n${bullets}`);
  }
  return blocks.join("\n\n");
}

function extractEntries(documentText) {
  const lines = String(documentText || "").split("\n");
  const start = lines.findIndex(line => /^##\s*\d/u.test(line));
  if (start < 0) return "";
  return lines.slice(start).join("\n").replace(/```(?:markdown)?/gu, "").trim();
}

function renderDoc(category, subcategory, entries, sourceCount) {
  const day = new Date().toISOString().slice(0, 10);
  return [
    "---",
    "type: consensus-doc",
    `category: "${category}"`,
    `subcategory: "${subcategory}"`,
    `updated_at: "${day}"`,
    `source_count: ${sourceCount}`,
    "---",
    "",
    `# ${subcategory} · 共识观点`,
    "",
    "> 本页汇总同一子类下多个视频**互相印证或补充**的观点，可信度更高。完全一致的观点直接列出印证视频；有补充或不同侧重的内容以 <span style=\"color:#d35400\">（补充：…）</span> 标注。",
    "",
    entries,
    "",
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "你是知识库整理助手。你的任务是把新视频中“与其他视频互相印证或补充”的观点合并进一份共识文档。",
  "该文档按条目（## 序号. 观点标题）组织，每个条目列出印证视频（多个视频都这么说）、核心表述，以及可选的补充说明。",
  "你的合并规则是：意思相同只加印证视频；有补充则在括号中追加并用指定颜色标注；全新观点才新增条目；绝不删除或弱化已有条目。",
].join("\n");

function buildUserPrompt(existingEntries, newItems) {
  const videoBlock = buildVideoBlock(newItems);
  return [
    "【现有共识文档条目区】（空表示首次建立）",
    "```",
    existingEntries || "（暂无条目）",
    "```",
    "",
    "【新视频观点】",
    videoBlock || "（无）",
    "",
    "请把新视频的观点合并进共识文档，输出【新版条目区】，严格遵守：",
    "1. 新观点与某现有条目意思完全相同/基本一致 → 只把该视频加入该条目的“印证视频”列表（用其链接 [[文件名]]），核心表述保留原文或替换为更准确的版本，不新增条目。",
    "2. 新观点对某现有条目有补充或不同侧重 → 在该条目末尾追加 <span style=\"color:#d35400\">（补充：具体补充内容）</span>，并在印证视频列表追加该视频。",
    "3. 全新观点 → 新增条目，印证视频列表为该视频链接。",
    "4. 条目格式固定为：",
    "## 序号. 观点标题",
    "- **印证视频（N）**：[[视频A]]、[[视频B]]",
    "- 核心表述：一句话说清观点",
    "- 补充时：<span style=\"color:#d35400\">（补充：……）</span>",
    "5. 严禁删除、合并或弱化任何已有条目；每个条目的印证视频列表只增不减，准确去重。",
    "6. 最终输出 JSON 对象：{\"document\": \"<新版条目区全文>\"}，条目区从 “## 1. ” 开始，不要包含 frontmatter、标题或任何说明文字。",
  ].join("\n");
}

/** 增量更新指定子类的“共识观点”置顶文档：把新视频观点与现有文档交给 DeepSeek 合并。 */
export async function updateConsensusDoc(config, store, { awemeId = "", category = "", subcategory = "", group = "" } = {}) {
  let cat = category;
  let sub = subcategory;
  let grp = group;
  let newItem = null;
  if (awemeId) {
    const row = store.get(awemeId);
    if (!row) return { error: `aweme ${awemeId} not found` };
    cat = row.category;
    sub = row.subcategory;
    grp = row.group || "";
    newItem = row;
  }
  if (!cat || !sub || sub === "未分类") return { error: `no subcategory resolved for ${awemeId || "(none)"}` };
  const items = collectSubcategoryItems(store, cat, sub, grp);
  if (!items.length) return { error: `no written notes in ${cat}/${grp ? grp + "/" : ""}${sub}` };
  const layout = resolveVaultLayout(config);
  const dir = grp
    ? path.join(layout.knowledge, safeName(cat), safeName(grp), safeName(sub))
    : path.join(layout.knowledge, safeName(cat), safeName(sub));
  const docPath = path.join(dir, CONSENSUS_DOC_NAME);
  const existing = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
  const existingEntries = extractEntries(existing);
  const docExists = Boolean(existingEntries);
  const mergeItems = !docExists ? items : (newItem ? [newItem] : items);
  const payload = await llmJson(config, SYSTEM_PROMPT, buildUserPrompt(existingEntries, mergeItems));
  const entries = String(payload?.document || "").trim();
  if (!entries) throw new Error("consensus doc merge returned empty content");
  const content = renderDoc(safeName(cat), safeName(sub), entries, items.length);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(docPath, content, "utf8");
  return { category: safeName(cat), group: safeName(grp), subcategory: safeName(sub), docPath, sourceCount: items.length, merged: true };
}

/** 读取指定子类的共识观点文档内容（用于验证/展示）。 */
export function readConsensusDoc(config, store, { category = "", subcategory = "", group = "" } = {}) {
  if (!category || !subcategory) return { error: "category and subcategory required" };
  const layout = resolveVaultLayout(config);
  const dir = group
    ? path.join(layout.knowledge, safeName(category), safeName(group), safeName(subcategory))
    : path.join(layout.knowledge, safeName(category), safeName(subcategory));
  const docPath = path.join(dir, CONSENSUS_DOC_NAME);
  if (!fs.existsSync(docPath)) return { docPath, exists: false };
  return { docPath, exists: true, content: fs.readFileSync(docPath, "utf8") };
}
