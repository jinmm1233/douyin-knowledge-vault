import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { llmJson } from "./consensus.mjs";
import { resolveVaultLayout } from "./vault.mjs";
import { loadCategoryTree } from "./classify.mjs";
import { CONSENSUS_DOC_NAME } from "./consensus-doc.mjs";

export const CARD_DIR = "knowledge-cards";
export const CARD_SCHEMA_VERSION = 1;

function safeName(value) {
  return String(value || "").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "").trim().slice(0, 40) || "未分类";
}

function clean(value, max = 500) {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, max);
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

function loadKnowledgeJson(item) {
  if (!item?.knowledge_path || !fs.existsSync(item.knowledge_path)) return null;
  try {
    return JSON.parse(fs.readFileSync(item.knowledge_path, "utf8"));
  } catch {
    return null;
  }
}

function knowledgeBrief(item) {
  const knowledge = loadKnowledgeJson(item);
  if (!knowledge) return null;
  const ideas = (knowledge.keyIdeas || [])
    .map(idea => `${clean(idea.title, 80)}：${clean(idea.detail, 200)}`)
    .filter(Boolean)
    .slice(0, 8);
  return {
    title: clean(item.title, 80) || String(item.aweme_id),
    thesis: clean(knowledge.thesis, 200),
    ideas,
  };
}

/** 读取某大分类下所有子类目录里的共识观点文档全文（用于优先整理互相印证的观点）。 */
function collectConsensusDocs(config, major) {
  const layout = resolveVaultLayout(config);
  const majorDir = path.join(layout.knowledge, safeName(major));
  if (!fs.existsSync(majorDir)) return [];
  const docs = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === CONSENSUS_DOC_NAME) {
        try {
          docs.push({ path: full, content: fs.readFileSync(full, "utf8").slice(0, 6000) });
        } catch { /* 忽略读不了的文档 */ }
      }
    }
  };
  walk(majorDir);
  return docs;
}

/** 聚合某大分类的所有素材：单视频知识（thesis/keyIdeas）+ 子类共识文档。 */
function collectMajorMaterial(config, store, major, { limit = 400 } = {}) {
  const items = store.listWrittenByCategory(major, { limit });
  const briefs = [];
  for (const item of items) {
    const brief = knowledgeBrief(item);
    if (brief && (brief.thesis || brief.ideas.length)) briefs.push(brief);
  }
  const consensusDocs = collectConsensusDocs(config, major);
  return { items, briefs, consensusDocs, count: items.length };
}

/** 把素材压缩成发给模型的中文素材块。 */
function buildMaterialText(material) {
  const parts = [];
  const videoLines = material.briefs
    .map((b, index) => {
      const lines = [];
      lines.push(`[视频${index}]《${b.title}》`);
      if (b.thesis) lines.push(`  一句话结论：${b.thesis}`);
      for (const idea of b.ideas) lines.push(`  · ${idea}`);
      return lines.join("\n");
    })
    .join("\n");
  if (videoLines) parts.push(`【单视频知识素材】\n${videoLines}`);
  if (material.consensusDocs.length) {
    const docBlock = material.consensusDocs
      .map(doc => doc.content)
      .join("\n\n---\n\n");
    parts.push(`【子类共识文档（多视频互相印证/补充的观点，优先采信）】\n${docBlock.slice(0, 12000)}`);
  }
  return parts.join("\n\n");
}

const SYSTEM_PROMPT = [
  "你是知识整理专家。把用户提供的同一大分类下的多篇视频知识素材，整理成一份结构化知识卡片 JSON。",
  "原则：",
  "1. 优先整理「互相印证的观点」：多个视频共同表达、互相补充或验证的观点，可信度最高，放在 consensus_points；每条标注被几个视频印证。",
  "2. 其次整理「单视频独有知识」：只有单个视频讲、但确实有价值的知识点，放在 knowledge_points。",
  "3. 如果素材太少、缺乏实质性知识点，输出 {\"skip\": true} 表示该分类不值得做卡片（不要硬凑）。",
  "4. 内容必须基于素材，严禁编造；观点用简洁清楚的中文一句话概括。",
  "5. 同时生成三类可视化数据：",
  "   - mindmap：思维导图（树形层级，root 为分类名，children 为分支知识点，最多 8 个一级分支）",
  "   - network：观点-视频印证网络（nodes 为 {id,label,type:'idea'|'video'}，links 为 {source,target,relation:'印证'|'补充'}）",
  "   - table：分类速查表（rows 为 {topic, verdict}，把同类知识点归并成对照表，最多 10 行）",
  "6. summary：用 2-3 句话总结这个分类讲了什么。",
  "输出严格 JSON 对象：",
  '{"skip":false,"summary":"...","consensus_points":[{"title":"观点标题","statement":"一句话核心表述","confirmed_by":2,"source_videos":["视频标题",...]}],"knowledge_points":[{"title":"知识点标题","detail":"具体内容","source_video":"视频标题"}],"mindmap":{"root":"分类名","children":[{"name":"分支","children":[{"name":"子项"}]}]},"network":{"nodes":[{"id":"i1","label":"观点1","type":"idea"},{"id":"v1","label":"视频标题","type":"video"}],"links":[{"source":"i1","target":"v1","relation":"印证"}]},"table":{"rows":[{"topic":"主题","verdict":"结论/速查口径"}]}}',
].join("\n");

function buildUserPrompt(material) {
  return [
    `大分类名称：${material.major}`,
    `该分类下已整理的视频数：${material.count}`,
    "",
    buildMaterialText(material),
    "",
    "请按 system 指令输出知识卡片 JSON。若素材中几乎无实质知识点（比如全是废话、闲聊、带货），输出 {\"skip\": true}。",
  ].join("\n");
}

function normalizeCard(payload, major, material) {
  if (payload?.skip) {
    return { skip: true, major, count: material.count };
  }
  const nodes = [];
  const links = [];
  const seen = new Set();
  const net = payload?.network || { nodes: [], links: [] };
  for (const node of net.nodes || []) {
    const id = String(node.id || "").slice(0, 40);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, label: clean(node.label, 60), type: node.type === "video" ? "video" : "idea" });
  }
  for (const link of net.links || []) {
    const source = String(link.source || "").slice(0, 40);
    const target = String(link.target || "").slice(0, 40);
    if (!source || !target) continue;
    links.push({ source, target, relation: link.relation === "补充" ? "补充" : "印证" });
  }
  const consensus = (payload?.consensus_points || []).slice(0, 15).map(point => ({
    title: clean(point.title, 80),
    statement: clean(point.statement, 240),
    confirmed_by: Math.max(1, Number(point.confirmed_by || 1)),
    source_videos: (point.source_videos || []).slice(0, 12).map(v => clean(v, 80)),
  }));
  const knowledge = (payload?.knowledge_points || []).slice(0, 30).map(point => ({
    title: clean(point.title, 80),
    detail: clean(point.detail, 300),
    source_video: clean(point.source_video, 80),
  }));
  return {
    skip: false,
    major,
    count: material.count,
    summary: clean(payload?.summary, 400),
    consensus_points: consensus,
    knowledge_points: knowledge,
    mindmap: payload?.mindmap && typeof payload.mindmap === "object" ? payload.mindmap : { root: major, children: [] },
    network: { nodes: nodes.slice(0, 40), links: links.slice(0, 60) },
    table: { rows: (payload?.table?.rows || []).slice(0, 12).map(row => ({ topic: clean(row.topic, 60), verdict: clean(row.verdict, 200) })) },
  };
}

/** 生成（或刷新）某大分类的知识卡片。minVideos 为该分类 written 笔记数阈值，低于则跳过。 */
export async function buildMajorCard(config, store, major, { minVideos = 50, force = false } = {}) {
  const material = collectMajorMaterial(config, store, major);
  if (material.count < minVideos) {
    return { major, status: "below-threshold", count: material.count, threshold: minVideos, card: null };
  }
  if (!material.briefs.length && !material.consensusDocs.length) {
    return { major, status: "no-material", count: material.count, threshold: minVideos, card: null };
  }
  const userPrompt = buildUserPrompt({ ...material, major });
  const payload = await llmJson(config, SYSTEM_PROMPT, userPrompt, { timeoutMs: 180000 });
  const card = normalizeCard(payload, major, material);
  if (card.skip) {
    return { major, status: "skipped", count: material.count, threshold: minVideos, card: null };
  }
  const outputDir = path.join(config.stateDir, CARD_DIR);
  const outputFile = path.join(outputDir, `${safeName(major)}.json`);
  const document = {
    schemaVersion: CARD_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    ...card,
  };
  atomicWrite(outputFile, `${JSON.stringify(document, null, 2)}\n`);
  return { major, status: "generated", count: material.count, threshold: minVideos, card: document, outputFile };
}

/** 列出所有大分类的知识卡片状态（已生成/低于阈值/未生成），供桌面端展示。 */
export function listMajorCards(config, store) {
  const tree = loadCategoryTree(config);
  const majors = Object.keys(tree || {});
  const cardDir = path.join(config.stateDir, CARD_DIR);
  const counts = new Map((store.writtenCountsByCategory() || []).map(row => [row.category, row.count]));
  const output = [];
  const allMajors = new Set(majors);
  for (const [category, count] of counts) {
    if (count > 0) allMajors.add(category);
  }
  for (const major of allMajors) {
    const file = path.join(cardDir, `${safeName(major)}.json`);
    let card = null;
    let generatedAt = "";
    let status = "pending";
    if (fs.existsSync(file)) {
      try {
        card = JSON.parse(fs.readFileSync(file, "utf8"));
        generatedAt = card.generatedAt || "";
        status = card.skip ? "skipped" : "generated";
      } catch {
        status = "broken";
      }
    } else {
      status = "pending";
    }
    output.push({ major, count: counts.get(major) || 0, status, generatedAt, hasCard: Boolean(card && !card.skip) });
  }
  output.sort((a, b) => (b.count - a.count) || String(a.major).localeCompare(String(b.major), "zh"));
  return output;
}

/** 读取某大分类已生成的知识卡片内容。 */
export function readMajorCard(config, major) {
  const file = path.join(config.stateDir, CARD_DIR, `${safeName(major)}.json`);
  if (!fs.existsSync(file)) return { major, exists: false };
  try {
    return { major, exists: true, card: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { major, exists: false, error: "broken json" };
  }
}
