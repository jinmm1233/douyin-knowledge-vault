import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveVaultLayout } from "./vault.mjs";

export const CREATOR_VIDEO_SCHEMA_VERSION = 1;
export const CREATOR_SYNTHESIS_SCHEMA_VERSION = 1;

const ARGUMENT_TYPES = new Set([
  "cause-effect", "contrast", "example", "analogy", "authority", "definition",
  "problem-solution", "step-by-step", "prediction", "counterargument", "other",
]);
const STRUCTURE_STAGES = new Set([
  "hook", "context", "problem", "thesis", "argument", "example", "counterpoint",
  "method", "action", "summary", "close", "other",
]);

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
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

function clean(value, max = 4000) {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, max);
}

function required(value, label, max = 4000) {
  const normalized = clean(value, max);
  if (!normalized) throw new Error(`${label} is empty`);
  return normalized;
}

function uniqueStrings(values, limit = 30) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = clean(value, 120);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

function timestamp(seconds) {
  const value = Math.max(0, Math.round(Number(seconds || 0)));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function validateCitation(citation, label, duration) {
  const start = Number(citation?.startSeconds);
  const end = Number(citation?.endSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 1) {
    throw new Error(`${label} has an invalid time range`);
  }
  return {
    startSeconds: start,
    endSeconds: end,
    timecode: `${timestamp(start)}-${timestamp(end)}`,
    excerpt: required(citation?.excerpt, `${label}.excerpt`, 600),
  };
}

function validateCitations(citations, label, duration) {
  if (!Array.isArray(citations) || !citations.length) throw new Error(`${label} must contain citations`);
  return citations.slice(0, 8).map((citation, index) => validateCitation(citation, `${label}[${index}]`, duration));
}

export function creatorVaultSlug(nickname, secUid) {
  const readable = clean(nickname, 60)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "-")
    .replace(/[. ]+$/gu, "")
    .replace(/-+/gu, "-") || "creator";
  return `${readable}-${sha256Text(String(secUid)).slice(0, 10)}`;
}

export function createVideoAnalysisRequest(item, creator, config) {
  if (!item.transcript_path || !fs.existsSync(item.transcript_path)) throw new Error("transcript artifact is missing");
  const transcript = JSON.parse(fs.readFileSync(item.transcript_path, "utf8").replace(/^\uFEFF/u, ""));
  const request = {
    schemaVersion: 1,
    task: "analyze-douyin-creator-video",
    creator: {
      secUid: String(creator.sec_uid),
      nickname: String(creator.nickname || item.author || ""),
      profileUrl: String(creator.profile_url),
    },
    video: {
      awemeId: String(item.aweme_id),
      title: String(item.title || ""),
      sourceUrl: String(item.source_url),
      publishedAt: Number(item.create_time || 0) > 0 ? new Date(Number(item.create_time) * 1000).toISOString() : "",
      durationSeconds: Number(transcript.duration || item.media_duration_seconds || item.duration_seconds || 0),
    },
    transcript: {
      sha256: String(item.transcript_sha256 || ""),
      language: String(config.language || "zh"),
      segments: (transcript.segments || []).map(segment => ({
        startSeconds: Number(segment.start || 0),
        endSeconds: Number(segment.end || 0),
        text: clean(segment.text, 1000),
      })).filter(segment => segment.text),
    },
    outputContract: {
      schemaVersion: CREATOR_VIDEO_SCHEMA_VERSION,
      required: ["awemeId", "coreArgument", "viewpoints", "argumentation", "contentStructure", "verificationNeeds", "tags"],
      viewpointKinds: ["explicit", "cross-segment-inference"],
      argumentTypes: [...ARGUMENT_TYPES],
      structureStages: [...STRUCTURE_STAGES],
    },
  };
  const directory = path.join(config.creatorKnowledgeDir, String(creator.sec_uid), "requests");
  const file = path.join(directory, `${item.aweme_id}.analysis-request.json`);
  atomicWrite(file, `${JSON.stringify(request, null, 2)}\n`);
  return { path: file, sha256: sha256Text(`${JSON.stringify(request, null, 2)}\n`) };
}

export function validateCreatorVideoAnalysis(analysis, { awemeId, duration }) {
  if (Number(analysis?.schemaVersion) !== CREATOR_VIDEO_SCHEMA_VERSION) throw new Error("unsupported creator video schema version");
  if (String(analysis?.awemeId) !== String(awemeId)) throw new Error("creator analysis awemeId does not match request");
  const normalized = {
    schemaVersion: CREATOR_VIDEO_SCHEMA_VERSION,
    awemeId: String(awemeId),
    coreArgument: required(analysis.coreArgument, "coreArgument", 3000),
    viewpoints: [],
    argumentation: [],
    contentStructure: [],
    verificationNeeds: [],
    tags: uniqueStrings(analysis.tags, 20),
  };
  if (!Array.isArray(analysis.viewpoints) || !analysis.viewpoints.length) throw new Error("viewpoints is empty");
  normalized.viewpoints = analysis.viewpoints.slice(0, 20).map((viewpoint, index) => {
    const kind = String(viewpoint?.kind || "explicit");
    if (!["explicit", "cross-segment-inference"].includes(kind)) throw new Error(`viewpoints[${index}].kind is invalid`);
    return {
      claim: required(viewpoint?.claim, `viewpoints[${index}].claim`, 1000),
      kind,
      reasoning: required(viewpoint?.reasoning, `viewpoints[${index}].reasoning`, 1600),
      confidence: ["high", "medium", "low"].includes(String(viewpoint?.confidence)) ? String(viewpoint.confidence) : "medium",
      citations: validateCitations(viewpoint?.citations, `viewpoints[${index}].citations`, duration),
    };
  });
  if (!Array.isArray(analysis.argumentation) || !analysis.argumentation.length) throw new Error("argumentation is empty");
  normalized.argumentation = analysis.argumentation.slice(0, 20).map((argument, index) => {
    const type = ARGUMENT_TYPES.has(String(argument?.type)) ? String(argument.type) : "other";
    return {
      type,
      summary: required(argument?.summary, `argumentation[${index}].summary`, 1600),
      premise: clean(argument?.premise, 1200),
      conclusion: clean(argument?.conclusion, 1200),
      citations: validateCitations(argument?.citations, `argumentation[${index}].citations`, duration),
    };
  });
  if (!Array.isArray(analysis.contentStructure) || !analysis.contentStructure.length) throw new Error("contentStructure is empty");
  normalized.contentStructure = analysis.contentStructure.slice(0, 30).map((section, index) => {
    const start = Number(section?.startSeconds);
    const end = Number(section?.endSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 1) {
      throw new Error(`contentStructure[${index}] has an invalid time range`);
    }
    return {
      stage: STRUCTURE_STAGES.has(String(section?.stage)) ? String(section.stage) : "other",
      startSeconds: start,
      endSeconds: end,
      timecode: `${timestamp(start)}-${timestamp(end)}`,
      purpose: required(section?.purpose, `contentStructure[${index}].purpose`, 800),
      summary: required(section?.summary, `contentStructure[${index}].summary`, 1200),
    };
  });
  normalized.contentStructure.sort((a, b) => a.startSeconds - b.startSeconds);
  normalized.verificationNeeds = (Array.isArray(analysis.verificationNeeds) ? analysis.verificationNeeds : []).slice(0, 20).map((entry, index) => ({
    claim: required(entry?.claim, `verificationNeeds[${index}].claim`, 1000),
    reason: required(entry?.reason, `verificationNeeds[${index}].reason`, 1000),
    citations: validateCitations(entry?.citations, `verificationNeeds[${index}].citations`, duration),
  }));
  return normalized;
}

export function storeCreatorVideoAnalysis(item, creator, analysisFile, config) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(analysisFile), "utf8").replace(/^\uFEFF/u, ""));
  const transcript = JSON.parse(fs.readFileSync(item.transcript_path, "utf8").replace(/^\uFEFF/u, ""));
  const analysis = validateCreatorVideoAnalysis(raw, {
    awemeId: item.aweme_id,
    duration: Number(transcript.duration || item.media_duration_seconds || item.duration_seconds || 0),
  });
  analysis.provenance = {
    creatorSecUid: String(creator.sec_uid),
    sourceUrl: String(item.source_url),
    mediaSha256: String(item.media_sha256 || ""),
    transcriptSha256: String(item.transcript_sha256 || ""),
  };
  const content = `${JSON.stringify(analysis, null, 2)}\n`;
  const file = path.join(config.creatorKnowledgeDir, String(creator.sec_uid), "videos", String(item.aweme_id), "analysis.json");
  atomicWrite(file, content);
  return { path: file, sha256: sha256Text(content) };
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function citationsMarkdown(citations) {
  return citations.map(citation => `  - **${citation.timecode}** ${citation.excerpt}`).join("\n");
}

export function renderCreatorVideoNote(item, creator, analysis) {
  const title = clean(item.title || `抖音视频 ${item.aweme_id}`, 300);
  return `${[
    "---",
    "schema_version: 1",
    "knowledge_type: creator-video-analysis",
    `creator_sec_uid: ${yamlString(creator.sec_uid)}`,
    `creator: ${yamlString(creator.nickname)}`,
    `aweme_id: ${yamlString(item.aweme_id)}`,
    `source_url: ${yamlString(item.source_url)}`,
    `transcript_sha256: ${yamlString(item.transcript_sha256)}`,
    `analysis_sha256: ${yamlString(item.creator_analysis_sha256 || "")}`,
    "tags:",
    "  - douyin-creator-distillation",
    ...analysis.tags.map(tag => `  - ${yamlString(tag)}`),
    "---",
    "",
    `# ${title}`,
    "",
    "## 核心论证",
    "",
    analysis.coreArgument,
    "",
    "## 观点",
    "",
    ...analysis.viewpoints.flatMap((viewpoint, index) => [
      `### ${index + 1}. ${viewpoint.claim}`,
      "",
      `- 类型：${viewpoint.kind === "explicit" ? "明确表达" : "跨片段推断"}`,
      `- 置信度：${viewpoint.confidence}`,
      `- 论证说明：${viewpoint.reasoning}`,
      "- 来源：",
      citationsMarkdown(viewpoint.citations),
      "",
    ]),
    "## 论证方式",
    "",
    ...analysis.argumentation.flatMap((argument, index) => [
      `### ${index + 1}. ${argument.type}`,
      "",
      argument.summary,
      argument.premise ? `- 前提：${argument.premise}` : "",
      argument.conclusion ? `- 结论：${argument.conclusion}` : "",
      "- 来源：",
      citationsMarkdown(argument.citations),
      "",
    ]).filter(Boolean),
    "## 内容结构",
    "",
    ...analysis.contentStructure.map(section => `- **${section.timecode} · ${section.stage}**：${section.purpose}；${section.summary}`),
    "",
    "## 待核实",
    "",
    ...(analysis.verificationNeeds.length ? analysis.verificationNeeds.flatMap(entry => [
      `- ${entry.claim} — ${entry.reason}`,
      citationsMarkdown(entry.citations),
    ]) : ["- 暂无单独标记；仍不应把博主经验自动视为事实。"]),
    "",
    "## 溯源",
    "",
    `- 原视频：${item.source_url}`,
    `- 媒体 SHA-256：\`${item.media_sha256}\``,
    `- 转录 SHA-256：\`${item.transcript_sha256}\``,
    `- 分析 SHA-256：\`${item.creator_analysis_sha256 || ""}\``,
    "",
  ].join("\n")}\n`;
}

function creatorDirectory(config, creator) {
  const layout = resolveVaultLayout(config);
  return path.join(layout.root, "Creators", creator.vault_slug || creatorVaultSlug(creator.nickname, creator.sec_uid));
}

function safeWorkflowWrite(file, content, previousSha256 = "") {
  const sha256 = sha256Text(content);
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8");
    const existingSha256 = sha256Text(existing);
    if (existingSha256 === sha256) return { path: file, sha256, resumed: true };
    if (previousSha256 && existingSha256 !== previousSha256) {
      throw new Error("creator knowledge note changed outside the workflow; refusing to overwrite it");
    }
  }
  if (/https?:\/\/[^\s)]+[?&](?:token|signature|x-signature|expires)=/iu.test(content)) {
    throw new Error("refusing to write creator knowledge containing a signed media URL");
  }
  atomicWrite(file, content);
  return { path: file, sha256, resumed: false };
}

export function writeCreatorVideoNote(item, creator, config) {
  if (!item.creator_analysis_path || !fs.existsSync(item.creator_analysis_path)) throw new Error("creator video analysis is missing");
  const analysis = JSON.parse(fs.readFileSync(item.creator_analysis_path, "utf8"));
  const file = path.join(creatorDirectory(config, creator), "Videos", `${item.aweme_id}.md`);
  return safeWorkflowWrite(file, renderCreatorVideoNote(item, creator, analysis), item.creator_note_sha256 || "");
}

export function createCreatorSynthesisRequest(creator, items, config) {
  const compactAnalysis = analysis => ({
    coreArgument: analysis.coreArgument,
    viewpoints: (analysis.viewpoints || []).slice(0, 10).map(viewpoint => ({
      claim: viewpoint.claim,
      kind: viewpoint.kind,
      confidence: viewpoint.confidence,
      reasoning: viewpoint.reasoning,
      citations: (viewpoint.citations || []).slice(0, 2),
    })),
    argumentation: (analysis.argumentation || []).slice(0, 8).map(argument => ({
      type: argument.type,
      summary: argument.summary,
      premise: argument.premise,
      conclusion: argument.conclusion,
      citations: (argument.citations || []).slice(0, 1),
    })),
    contentStructure: (analysis.contentStructure || []).slice(0, 12),
    verificationNeeds: (analysis.verificationNeeds || []).slice(0, 8).map(entry => ({
      claim: entry.claim,
      reason: entry.reason,
    })),
    tags: analysis.tags || [],
  });
  const analyses = items.map(item => {
    if (!item.creator_analysis_path || !fs.existsSync(item.creator_analysis_path)) return null;
    return {
      awemeId: String(item.aweme_id),
      title: String(item.title || ""),
      sourceUrl: String(item.source_url),
      durationSeconds: Number(item.media_duration_seconds || item.duration_seconds || 0),
      analysis: compactAnalysis(JSON.parse(fs.readFileSync(item.creator_analysis_path, "utf8"))),
    };
  }).filter(Boolean);
  if (!analyses.length) throw new Error("no analyzed creator videos are available for synthesis");
  const request = {
    schemaVersion: 1,
    task: "synthesize-douyin-creator-knowledge",
    creator: {
      secUid: String(creator.sec_uid),
      nickname: String(creator.nickname || ""),
      profileUrl: String(creator.profile_url),
    },
    sampleSize: analyses.length,
    videos: analyses,
    outputContract: {
      schemaVersion: CREATOR_SYNTHESIS_SCHEMA_VERSION,
      required: ["creatorSecUid", "summary", "recurringViewpoints", "argumentPatterns", "contentStructurePatterns", "topicMap", "contradictionsAndEvolution", "limitations"],
    },
  };
  const content = `${JSON.stringify(request, null, 2)}\n`;
  const file = path.join(config.creatorKnowledgeDir, String(creator.sec_uid), "creator-synthesis-request.json");
  atomicWrite(file, content);
  return { path: file, sha256: sha256Text(content), sampleSize: analyses.length };
}

function validateVideoRefs(refs, label, itemsById) {
  if (!Array.isArray(refs) || !refs.length) throw new Error(`${label} must contain videoRefs`);
  return refs.slice(0, 30).map((ref, index) => {
    const awemeId = String(ref?.awemeId || "");
    if (!itemsById.has(awemeId)) throw new Error(`${label}[${index}] references an unknown video`);
    return {
      awemeId,
      note: required(ref?.note, `${label}[${index}].note`, 800),
    };
  });
}

export function validateCreatorSynthesis(synthesis, creator, items) {
  if (Number(synthesis?.schemaVersion) !== CREATOR_SYNTHESIS_SCHEMA_VERSION) throw new Error("unsupported creator synthesis schema version");
  if (String(synthesis?.creatorSecUid) !== String(creator.sec_uid)) throw new Error("creator synthesis sec_uid does not match request");
  const itemsById = new Map(items.map(item => [String(item.aweme_id), item]));
  const normalizePatterns = (values, label) => {
    if (!Array.isArray(values) || !values.length) throw new Error(`${label} is empty`);
    return values.slice(0, 30).map((entry, index) => ({
      name: required(entry?.name, `${label}[${index}].name`, 300),
      description: required(entry?.description, `${label}[${index}].description`, 1800),
      confidence: ["high", "medium", "low"].includes(String(entry?.confidence)) ? String(entry.confidence) : "medium",
      videoRefs: validateVideoRefs(entry?.videoRefs, `${label}[${index}].videoRefs`, itemsById),
    }));
  };
  return {
    schemaVersion: CREATOR_SYNTHESIS_SCHEMA_VERSION,
    creatorSecUid: String(creator.sec_uid),
    sampleSize: items.length,
    summary: required(synthesis?.summary, "summary", 5000),
    recurringViewpoints: normalizePatterns(synthesis?.recurringViewpoints, "recurringViewpoints"),
    argumentPatterns: normalizePatterns(synthesis?.argumentPatterns, "argumentPatterns"),
    contentStructurePatterns: normalizePatterns(synthesis?.contentStructurePatterns, "contentStructurePatterns"),
    topicMap: normalizePatterns(synthesis?.topicMap, "topicMap"),
    contradictionsAndEvolution: (Array.isArray(synthesis?.contradictionsAndEvolution) ? synthesis.contradictionsAndEvolution : []).slice(0, 30).map((entry, index) => ({
      description: required(entry?.description, `contradictionsAndEvolution[${index}].description`, 1800),
      videoRefs: validateVideoRefs(entry?.videoRefs, `contradictionsAndEvolution[${index}].videoRefs`, itemsById),
    })),
    limitations: uniqueStrings(synthesis?.limitations, 30),
  };
}

export function storeCreatorSynthesis(creator, items, synthesisFile, config) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(synthesisFile), "utf8").replace(/^\uFEFF/u, ""));
  const synthesis = validateCreatorSynthesis(raw, creator, items);
  synthesis.provenance = {
    profileUrl: String(creator.profile_url),
    videoAnalysisHashes: Object.fromEntries(items.map(item => [String(item.aweme_id), String(item.creator_analysis_sha256 || "")])),
  };
  const content = `${JSON.stringify(synthesis, null, 2)}\n`;
  const file = path.join(config.creatorKnowledgeDir, String(creator.sec_uid), "creator-synthesis.json");
  atomicWrite(file, content);
  return { path: file, sha256: sha256Text(content) };
}

function patternSection(title, patterns) {
  return [
    `## ${title}`,
    "",
    ...patterns.flatMap((pattern, index) => [
      `### ${index + 1}. ${pattern.name}`,
      "",
      pattern.description,
      "",
      `- 置信度：${pattern.confidence}`,
      "- 来源视频：",
      ...pattern.videoRefs.map(ref => `  - [[Videos/${ref.awemeId}|${ref.awemeId}]]：${ref.note}`),
      "",
    ]),
  ];
}

export function renderCreatorOverview(creator, synthesis, items) {
  return `${[
    "---",
    "schema_version: 1",
    "knowledge_type: creator-distillation",
    `creator_sec_uid: ${yamlString(creator.sec_uid)}`,
    `creator: ${yamlString(creator.nickname)}`,
    `profile_url: ${yamlString(creator.profile_url)}`,
    `sample_size: ${items.length}`,
    `synthesis_sha256: ${yamlString(creator.synthesis_sha256 || "")}`,
    "tags:",
    "  - douyin-creator-distillation",
    "---",
    "",
    `# ${creator.nickname || "抖音博主"}：内容知识蒸馏`,
    "",
    "> 本知识库只归纳公开作品中的观点、论证方式和内容结构，不代表事实背书，也不用于复制原句、案例、人设或个人风格。",
    "",
    "## 概览",
    "",
    synthesis.summary,
    "",
    ...patternSection("观点综合（跨视频）", synthesis.recurringViewpoints),
    ...patternSection("常用论证方式", synthesis.argumentPatterns),
    ...patternSection("常用内容结构", synthesis.contentStructurePatterns),
    ...patternSection("主题地图", synthesis.topicMap),
    "## 矛盾、变化与例外",
    "",
    ...(synthesis.contradictionsAndEvolution.length ? synthesis.contradictionsAndEvolution.flatMap(entry => [
      `- ${entry.description}`,
      ...entry.videoRefs.map(ref => `  - [[Videos/${ref.awemeId}|${ref.awemeId}]]：${ref.note}`),
    ]) : ["- 当前样本中未识别出足够可靠的变化或矛盾。"]),
    "",
    "## 局限",
    "",
    ...synthesis.limitations.map(value => `- ${value}`),
    "",
    "## 视频索引",
    "",
    ...items.map(item => `- [[Videos/${item.aweme_id}|${clean(item.title || item.aweme_id, 160)}]]`),
    "",
    "## 溯源",
    "",
    `- 博主主页：${creator.profile_url}`,
    `- 样本数量：${items.length}`,
    `- 综合蒸馏 SHA-256：\`${creator.synthesis_sha256 || ""}\``,
    "",
  ].join("\n")}\n`;
}

export function writeCreatorOverview(creator, items, config) {
  if (!creator.synthesis_path || !fs.existsSync(creator.synthesis_path)) throw new Error("creator synthesis is missing");
  const synthesis = JSON.parse(fs.readFileSync(creator.synthesis_path, "utf8"));
  const file = path.join(creatorDirectory(config, creator), "README.md");
  return safeWorkflowWrite(file, renderCreatorOverview(creator, synthesis, items), creator.overview_sha256 || "");
}
