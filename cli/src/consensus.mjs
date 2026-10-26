import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function clean(value, max = 400) {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, max);
}

export function friendlyAIError(status, bodyText) {
  const t = String(bodyText || "").toLowerCase();
  if (status === 402 || status === 429 || /insufficient\s*_?\s*balance|insufficient\s*_?\s*quota|余额不足|no balance|payment required/.test(t)) {
    return "API Key 余额不足，请充值后重试";
  }
  return `AI 接口调用失败 ${status}: ${String(bodyText || "").slice(0, 200)}`;
}

function ngrams(text, size) {
  const normalized = String(text || "").replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/gu, "").toLowerCase();
  const grams = new Set();
  for (let index = 0; index < normalized.length - size + 1; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

function jaccard(gramsA, gramsB) {
  if (!gramsA.size || !gramsB.size) return 0;
  let intersection = 0;
  for (const gram of gramsA) {
    if (gramsB.has(gram)) intersection += 1;
  }
  const union = gramsA.size + gramsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function wordSet(words) {
  const set = new Set();
  for (const word of words || []) {
    const key = String(word).toLowerCase();
    if (key.length > 1) set.add(key);
  }
  return set;
}

export function textSimilarity(textA, textB, wordsA = null, wordsB = null) {
  const a = clean(textA, 400);
  const b = clean(textB, 400);
  if (!a || !b || a.length < 8 || b.length < 8) return 0;
  const charScore = Math.max(jaccard(ngrams(a, 2), ngrams(b, 2)), jaccard(ngrams(a, 3), ngrams(b, 3)));
  if (wordsA && wordsB) {
    const wordScore = jaccard(wordSet(wordsA), wordSet(wordsB));
    return Math.max(charScore, wordScore);
  }
  return charScore;
}

async function segmentBatch(config, texts) {
  const unique = [...new Set(texts.map(text => String(text || "")))];
  if (!unique.length) return new Map();
  const segmentScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "segment.py");
  const result = spawnSync(config.pythonCommand, [segmentScript], {
    input: JSON.stringify({ texts: unique }),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300000,
  });
  if (result.error) throw new Error(`segment failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`segment failed (exit ${result.status}): ${String(result.stderr || "").slice(0, 500)}`);
  const payload = JSON.parse(String(result.stdout || "").replace(/^\uFEFF/u, ""));
  if (payload.error) throw new Error(`segment failed: ${payload.error}`);
  const map = new Map();
  for (let index = 0; index < unique.length; index += 1) {
    map.set(unique[index], Array.isArray(payload.words?.[index]) ? payload.words[index] : []);
  }
  return map;
}

function loadKnowledge(item) {
  if (!item?.knowledge_path || !fs.existsSync(item.knowledge_path)) return null;
  try {
    return JSON.parse(fs.readFileSync(item.knowledge_path, "utf8"));
  } catch {
    return null;
  }
}

function knowledgeCategory(item) {
  const knowledge = loadKnowledge(item);
  return String(knowledge?.category || "其他");
}

function ideaKey(idea) {
  return clean(idea?.detail || idea?.title, 400);
}

const MATCH_BLOCK_OPEN = "<!-- consensus:match -->";
const MATCH_BLOCK_CLOSE = "<!-- consensus:match:end -->";

function stripConsensusBlocks(content) {
  const pattern = new RegExp(
    `\\n?${MATCH_BLOCK_OPEN}[\\s\\S]*?${MATCH_BLOCK_CLOSE}\\n?`,
    "gu",
  );
  return content.replace(pattern, "\n");
}

function wrapHighlight(text) {
  const value = String(text || "");
  if (/^==[\s\S]*==$/u.test(value.trim())) return value;
  return `==${value.trim()}==`;
}

function ideaSections(noteLines) {
  // Locate the "## 关键知识" .. "## 可执行步骤" span; inside it, "### " lines are idea headings.
  let start = -1;
  let end = noteLines.length;
  for (let index = 0; index < noteLines.length; index += 1) {
    if (noteLines[index].startsWith("## 关键知识")) start = index;
    if (start >= 0 && noteLines[index].startsWith("## 可执行步骤")) {
      end = index;
      break;
    }
  }
  if (start < 0) return [];
  const headings = [];
  for (let index = start + 1; index < end; index += 1) {
    if (noteLines[index].startsWith("### ")) headings.push(index);
  }
  return headings;
}

function annotateNote(notePath, matchesByIdea) {
  const raw = fs.readFileSync(notePath, "utf8");
  const content = stripConsensusBlocks(raw);
  const lines = content.split("\n");
  const headings = ideaSections(lines);
  const used = new Set();
  const blocks = [];
  for (const [ideaIndex, matches] of Object.entries(matchesByIdea)) {
    const headingLine = headings[Number(ideaIndex)];
    if (headingLine === undefined) continue;
    let blockEnd = -1;
    for (let index = headingLine + 1; index < lines.length; index += 1) {
      if (lines[index].startsWith("### ") || lines[index].startsWith("## ")) {
        blockEnd = index;
        break;
      }
    }
    if (blockEnd < 0) blockEnd = lines.length;
    // Wrap the first non-heading, non-quote paragraph (the detail) in ==...==.
    for (let index = headingLine + 1; index < blockEnd; index += 1) {
      const line = lines[index];
      if (line.trim() && !line.trim().startsWith(">") && !line.trim().startsWith("==")) {
        lines[index] = wrapHighlight(line);
        break;
      }
    }
    // Insert the consensus block right before the block end (after the transcript quote).
    const sorted = matches.sort((x, y) => y.similarity - x.similarity).slice(0, 3);
    const refs = sorted.map(match => {
      const title = String(match.title || match.aweme_id).replace(/\|/gu, "/").slice(0, 30);
      return match.reason ? `《${title}》(${match.reason})` : `《${title}》(${Math.round(match.similarity * 100)}%)`;
    });
    const block = [
      MATCH_BLOCK_OPEN,
      `> 🔗 **共识印证**：${refs.join("、")} 表述基本一致 —— 该观点在多个视频中重复出现，可信度较高。`,
      MATCH_BLOCK_CLOSE,
    ];
    blocks.push({ at: blockEnd, block });
    used.add(Number(ideaIndex));
  }
  if (!blocks.length) {
    fs.writeFileSync(notePath, content, "utf8");
    return { changed: false, sha256: sha256Text(content), matchedIdeas: 0 };
  }
  const sortedBlocks = blocks.sort((x, y) => y.at - x.at);
  for (const { at, block } of sortedBlocks) {
    lines.splice(at, 0, "", ...block, "");
  }
  const updated = `${lines.join("\n")}\n`;
  fs.writeFileSync(notePath, updated, "utf8");
  return { changed: true, sha256: sha256Text(updated), matchedIdeas: used.size };
}

export async function runConsensus(config, store, { awemeId = "" } = {}) {
  const threshold = Number(config.consensusThreshold ?? 0.35);
  const limit = Number(config.consensusMatchLimit ?? 100);

  const target = awemeId ? [store.get(awemeId)].filter(Boolean) : store.list({ limit: 100000 }).filter(row => row.status === "written");
  if (!target.length) return { matched: 0, notesUpdated: 0, pairs: [] };

  const candidates = [];
  if (awemeId) {
    const item = target[0];
    const knowledge = loadKnowledge(item);
    if (!knowledge) return { matched: 0, notesUpdated: 0, pairs: [], error: "knowledge missing" };
    const peers = store.listWrittenByCategory(knowledgeCategory(item), { limit, exclude: awemeId });
    for (const peer of peers) {
      const peerKnowledge = loadKnowledge(peer);
      if (!peerKnowledge) continue;
      candidates.push({ left: item, right: peer, leftKnowledge: knowledge, rightKnowledge: peerKnowledge });
    }
  } else {
    const groups = new Map();
    for (const item of target) {
      const category = knowledgeCategory(item);
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(item);
    }
    for (const group of groups.values()) {
      for (let x = 0; x < group.length; x += 1) {
        for (let y = x + 1; y < group.length; y += 1) {
          const leftKnowledge = loadKnowledge(group[x]);
          const rightKnowledge = loadKnowledge(group[y]);
          if (!leftKnowledge || !rightKnowledge) continue;
          candidates.push({ left: group[x], right: group[y], leftKnowledge, rightKnowledge });
        }
      }
    }
  }

  const ideaTexts = [];
  const seenTexts = new Set();
  for (const { leftKnowledge, rightKnowledge } of candidates) {
    for (const knowledge of [leftKnowledge, rightKnowledge]) {
      for (const idea of knowledge?.keyIdeas || []) {
        const key = ideaKey(idea);
        if (key && !seenTexts.has(key)) {
          seenTexts.add(key);
          ideaTexts.push(key);
        }
      }
    }
  }
  const wordsByText = await segmentBatch(config, ideaTexts);

  const pairs = [];
  const notesToAnnotate = new Map();
  for (const { left, right, leftKnowledge, rightKnowledge } of candidates) {
    const leftIdeas = leftKnowledge?.keyIdeas || [];
    const rightIdeas = rightKnowledge?.keyIdeas || [];
    for (let i = 0; i < leftIdeas.length; i += 1) {
      const a = ideaKey(leftIdeas[i]);
      if (!a) continue;
      for (let j = 0; j < rightIdeas.length; j += 1) {
        const b = ideaKey(rightIdeas[j]);
        if (!b) continue;
        const similarity = textSimilarity(a, b, wordsByText.get(a), wordsByText.get(b));
        if (similarity >= threshold) {
          pairs.push({
            left: left.aweme_id,
            right: right.aweme_id,
            similarity: Math.round(similarity * 100) / 100,
            ideaText: a.slice(0, 120),
          });
          const leftMap = notesToAnnotate.get(left.aweme_id) || new Map();
          const leftEntry = leftMap.get(i) || [];
          leftEntry.push({ aweme_id: right.aweme_id, title: right.title, similarity });
          leftMap.set(i, leftEntry);
          notesToAnnotate.set(left.aweme_id, leftMap);

          const rightMap = notesToAnnotate.get(right.aweme_id) || new Map();
          const rightEntry = rightMap.get(j) || [];
          rightEntry.push({ aweme_id: left.aweme_id, title: left.title, similarity });
          rightMap.set(j, rightEntry);
          notesToAnnotate.set(right.aweme_id, rightMap);
        }
      }
    }
  }

  let notesUpdated = 0;
  let matchedIdeasTotal = 0;
  for (const [aweme, ideaMatches] of notesToAnnotate) {
    const item = store.get(aweme);
    if (!item?.note_path || !fs.existsSync(item.note_path)) continue;
    const entries = {};
    for (const [index, matches] of ideaMatches) {
      entries[index] = matches;
    }
    const result = annotateNote(item.note_path, entries);
    if (result.changed) {
      store.updateNoteSha256(aweme, result.sha256);
      notesUpdated += 1;
    }
    matchedIdeasTotal += result.matchedIdeas;
  }

  return { matched: pairs.length, notesUpdated, matchedIdeasTotal, threshold, pairs: pairs.slice(0, 50) };
}

// 记录本 CLI 每次 AI 调用的真实 token 消耗，追加到 var/api-usage.jsonl（桌面端周报按周统计）
export function recordApiUsage(config, payload) {
  try {
    const tokens = Number(payload?.usage?.total_tokens) || 0;
    if (!tokens || !config?.stateDir) return;
    const file = path.join(config.stateDir, "api-usage.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: Date.now(), tokens })}\n`, "utf8");
  } catch { /* 统计失败不影响主流程 */ }
}

export async function llmJson(config, systemPrompt, userPrompt, { timeoutMs = 120000 } = {}) {  if (!config.llmApiKey || !config.llmModel || !config.llmBaseUrl) {
    throw new Error("semantic consensus requires DOK_LLM_BASE_URL, DOK_LLM_API_KEY and DOK_LLM_MODEL");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("semantic consensus timed out")), timeoutMs);
  let response;
  try {
    response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(friendlyAIError(response.status, await response.text().catch(() => "")));
  const payload = await response.json();
  recordApiUsage(config, payload);
  const content = String(payload?.choices?.[0]?.message?.content || "").replace(/^```(?:json)?\s*|\s*```$/gu, "");
  return JSON.parse(content);
}

export async function runSemanticConsensus(config, store, item) {
  if (!item) return { matched: 0, notesUpdated: 0, error: "item missing" };
  const historyLimit = Number(config.consensusSemanticHistoryLimit ?? 30);
  const category = knowledgeCategory(item);
  const itemKnowledge = loadKnowledge(item);
  if (!itemKnowledge) return { matched: 0, notesUpdated: 0, error: "knowledge missing" };
  const itemIdeas = itemKnowledge.keyIdeas || [];
  if (!itemIdeas.length) return { matched: 0, notesUpdated: 0, error: "no key ideas" };
  const peers = store.listWrittenByCategory(category, { limit: historyLimit, exclude: item.aweme_id });
  const peerIdeas = [];
  for (const peer of peers) {
    const knowledge = loadKnowledge(peer);
    if (!knowledge?.keyIdeas?.length) continue;
    for (const [index, idea] of knowledge.keyIdeas.entries()) {
      peerIdeas.push({ aweme: peer, ideaIndex: index, text: `${ideaKey(idea)}` });
    }
  }
  if (!peerIdeas.length) return { matched: 0, notesUpdated: 0, error: "no comparable peers" };

  const newLines = itemIdeas.map((idea, index) => `[新${index}] ${ideaKey(idea)}`).join("\n");
  const peerLines = peerIdeas.map((entry, index) => `[史${index}] ${entry.text}`).join("\n");
  const system = [
    "你是严谨的观点印证判断器。判断两条观点文本是否在表达同一个观点或可以互相印证的事实。",
    "同一观点在不同视频中出现即算互相印证；措辞不同但意思相同也算；主题相似但内容不同不算。",
    "只依据给出的文本判断，拿不准就不输出。不要臆造。",
  ].join("\n");
  const user = [
    `新视频观点（编号[新0]起）：\n${newLines}`,
    `同类历史视频观点（编号[史0]起，来自多条视频）：\n${peerLines}`,
    "找出所有互相印证的对：一个[新X]观点与一个[史Y]观点表达同一观点或可互相印证。",
    '返回 JSON：{"pairs":[{"newIndex":0,"historyIndex":0,"reason":"20字以内的印证理由"}]}，无匹配则返回 {"pairs":[]}。',
  ].join("\n\n");

  let payload;
  try {
    payload = await llmJson(config, system, user);
  } catch (error) {
    return { matched: 0, notesUpdated: 0, error: String(error?.message || error) };
  }
  const pairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
  if (!pairs.length) return { matched: 0, notesUpdated: 0, error: "" };

  const newMatches = new Map();
  const peerMatchesByAweme = new Map();
  for (const pair of pairs) {
    const newIndex = Number(pair?.newIndex);
    const historyIndex = Number(pair?.historyIndex);
    if (!Number.isInteger(newIndex) || !Number.isInteger(historyIndex)) continue;
    if (newIndex < 0 || newIndex >= itemIdeas.length) continue;
    if (historyIndex < 0 || historyIndex >= peerIdeas.length) continue;
    const peer = peerIdeas[historyIndex];
    const reason = String(pair?.reason || "表述一致").slice(0, 60);

    const newEntry = newMatches.get(newIndex) || [];
    newEntry.push({ aweme_id: peer.aweme.aweme_id, title: peer.aweme.title, similarity: 1, reason });
    newMatches.set(newIndex, newEntry);

    const peerMap = peerMatchesByAweme.get(peer.aweme.aweme_id) || new Map();
    const peerEntry = peerMap.get(peer.ideaIndex) || [];
    peerEntry.push({ aweme_id: item.aweme_id, title: item.title, similarity: 1, reason });
    peerMap.set(peer.ideaIndex, peerEntry);
    peerMatchesByAweme.set(peer.aweme.aweme_id, peerMap);
  }

  let notesUpdated = 0;
  let matchedIdeasTotal = 0;
  if (item.note_path && fs.existsSync(item.note_path)) {
    const entries = {};
    for (const [index, matches] of newMatches) entries[index] = matches;
    const result = annotateNote(item.note_path, entries);
    if (result.changed) {
      store.updateNoteSha256(item.aweme_id, result.sha256);
      notesUpdated += 1;
    }
    matchedIdeasTotal += result.matchedIdeas;
  }
  for (const [awemeId, peerMap] of peerMatchesByAweme) {
    const peer = store.get(awemeId);
    if (!peer?.note_path || !fs.existsSync(peer.note_path)) continue;
    const entries = {};
    for (const [index, matches] of peerMap) entries[index] = matches;
    const result = annotateNote(peer.note_path, entries);
    if (result.changed) {
      store.updateNoteSha256(awemeId, result.sha256);
      notesUpdated += 1;
    }
    matchedIdeasTotal += result.matchedIdeas;
  }

  return { matched: pairs.length, notesUpdated, matchedIdeasTotal, peersCompared: peerIdeas.length, pairs };
}
