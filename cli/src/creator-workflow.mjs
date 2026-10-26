import fs from "node:fs";
import { listCreatorCandidates, listCreatorVideos } from "./opencli.mjs";
import { freezeMedia } from "./media.mjs";
import { transcribeMedia } from "./transcribe.mjs";
import { acquireSyncLock } from "./workflow.mjs";
import {
  createCreatorSynthesisRequest,
  createVideoAnalysisRequest,
  creatorVaultSlug,
  storeCreatorSynthesis,
  storeCreatorVideoAnalysis,
  writeCreatorOverview,
  writeCreatorVideoNote,
} from "./creator-knowledge.mjs";

export async function resolveCreatorInput(input, { limit = 8 } = {}) {
  return listCreatorCandidates({ input, limit });
}

export async function collectCreator(config, store, { secUid, limit = 30, sourceInput = "" } = {}) {
  const fetchLimit = Math.min(100, Math.max(Number(limit), Number(limit) + 20));
  const fetched = await listCreatorVideos({ secUid, limit: fetchLimit, includePlayUrl: true });
  const considered = [];
  let videoCount = 0;
  for (const row of fetched) {
    considered.push(row);
    if (Number(row.duration || 0) > 0) videoCount += 1;
    if (videoCount >= Number(limit)) break;
  }
  const rows = considered.filter(row => Number(row.duration || 0) > 0).slice(0, Number(limit));
  if (!rows.length) throw new Error("creator profile did not return any complete video posts");
  const first = rows[0] || {};
  const creator = {
    sec_uid: String(first.author_sec_uid || secUid),
    nickname: String(first.author || ""),
    profile_url: String(first.profile_url || `https://www.douyin.com/user/${secUid}`),
    source_input: String(sourceInput || ""),
  };
  creator.vault_slug = creatorVaultSlug(creator.nickname, creator.sec_uid);
  store.upsertCreator(creator);
  for (const row of considered) {
    store.upsertDiscovered(row);
    store.associateCreatorItem(creator.sec_uid, row.aweme_id, row.rank);
    if (Number(row.duration || 0) <= 0) {
      store.markCreatorSkipped(creator.sec_uid, row.aweme_id, "non-video or incomplete media post skipped");
    }
  }
  return {
    creator: store.getCreator(creator.sec_uid),
    rows,
    skippedNonVideo: considered.filter(row => Number(row.duration || 0) <= 0).length,
  };
}

export async function prepareCreator(config, store, { secUid, limit = 30, sourceInput = "" } = {}) {
  const release = acquireSyncLock(config.stateDir);
  try {
    const { creator, rows, skippedNonVideo } = await collectCreator(config, store, { secUid, limit, sourceInput });
    const results = [];
    for (const row of rows.slice(0, limit)) {
      let stage = "discovered";
      try {
        let item = store.getCreatorItem(creator.sec_uid, row.aweme_id);
        const hadTranscript = Boolean(item.transcript_path && fs.existsSync(item.transcript_path));
        if (!item.media_path || !fs.existsSync(item.media_path)) {
          const media = await freezeMedia(row, config);
          store.markMediaFrozen(row.aweme_id, media);
        }
        stage = "media_frozen";
        item = store.getCreatorItem(creator.sec_uid, row.aweme_id);
        if (!item.transcript_path || !fs.existsSync(item.transcript_path)) {
          const transcript = await transcribeMedia(item, config);
          store.markTranscribed(row.aweme_id, transcript);
        }
        stage = "transcribed";
        item = store.getCreatorItem(creator.sec_uid, row.aweme_id);
        const request = createVideoAnalysisRequest(item, creator, config);
        store.markCreatorPrepared(creator.sec_uid, row.aweme_id);
        item = store.getCreatorItem(creator.sec_uid, row.aweme_id);
        results.push({
          aweme_id: row.aweme_id,
          status: item.creator_analysis_status === "written" ? "written" : "analysis_pending",
          request_path: request.path,
          resumed: hadTranscript,
        });
      } catch (error) {
        store.markCreatorItemFailed(creator.sec_uid, row.aweme_id, error?.message || error);
        results.push({ aweme_id: row.aweme_id, status: "failed", stage, error: String(error?.message || error) });
      }
    }
    return { creator, skipped_non_video_posts: skippedNonVideo, results, counts: store.creatorCounts(creator.sec_uid) };
  } finally {
    release();
  }
}

export function creatorAnalysisRequests(config, store, { secUid, limit = 100 } = {}) {
  const creator = store.getCreator(secUid);
  if (!creator) throw new Error("creator is not registered; run creator prepare first");
  const items = store.listCreatorItems(secUid, { limit })
    .filter(item => ["pending", "failed"].includes(item.creator_analysis_status))
    .filter(item => item.transcript_path && fs.existsSync(item.transcript_path));
  return items.map(item => {
    const request = createVideoAnalysisRequest(item, creator, config);
    return {
      aweme_id: item.aweme_id,
      status: item.creator_analysis_status,
      request_path: request.path,
      analysis_path: item.creator_analysis_path || "",
      note_path: item.creator_note_path || "",
    };
  });
}

export function ingestCreatorVideoAnalysis(config, store, { secUid, awemeId, analysisFile } = {}) {
  const creator = store.getCreator(secUid);
  const item = store.getCreatorItem(secUid, awemeId);
  if (!creator || !item) throw new Error("creator video is not registered");
  try {
    const analysis = storeCreatorVideoAnalysis(item, creator, analysisFile, config);
    store.markCreatorAnalyzed(secUid, awemeId, analysis);
    const updated = store.getCreatorItem(secUid, awemeId);
    const note = writeCreatorVideoNote(updated, creator, config);
    store.markCreatorVideoWritten(secUid, awemeId, note);
    return { aweme_id: awemeId, status: "written", analysis_path: analysis.path, note_path: note.path, resumed: note.resumed };
  } catch (error) {
    store.markCreatorItemFailed(secUid, awemeId, error?.message || error);
    throw error;
  }
}

export function creatorSynthesisRequest(config, store, { secUid } = {}) {
  const creator = store.getCreator(secUid);
  if (!creator) throw new Error("creator is not registered");
  const items = store.listCreatorItems(secUid, { limit: 200 })
    .filter(item => item.creator_analysis_path && fs.existsSync(item.creator_analysis_path));
  return createCreatorSynthesisRequest(creator, items, config);
}

export function ingestCreatorSynthesis(config, store, { secUid, synthesisFile } = {}) {
  let creator = store.getCreator(secUid);
  if (!creator) throw new Error("creator is not registered");
  const items = store.listCreatorItems(secUid, { limit: 200 })
    .filter(item => item.creator_analysis_path && fs.existsSync(item.creator_analysis_path));
  const synthesis = storeCreatorSynthesis(creator, items, synthesisFile, config);
  store.markCreatorSynthesis(secUid, synthesis);
  creator = store.getCreator(secUid);
  const overview = writeCreatorOverview(creator, items, config);
  store.markCreatorOverview(secUid, overview);
  return { status: "written", synthesis_path: synthesis.path, overview_path: overview.path, resumed: overview.resumed };
}

export function creatorStatus(store, { secUid = "" } = {}) {
  if (!secUid) return { creators: store.listCreators(), items: [] };
  const creator = store.getCreator(secUid);
  return {
    creator: creator || null,
    counts: creator ? store.creatorCounts(secUid) : [],
    items: creator ? store.listCreatorItems(secUid, { limit: 200 }) : [],
  };
}
