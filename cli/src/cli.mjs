#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, root } from "./config.mjs";
import { StateStore } from "./state.mjs";
import { discover, extract, freeze, ingestFavorites, migrateNoteNames, pruneMedia, reclassifyWritten, sync, transcribe, write, writeDailyReport } from "./workflow.mjs";
import { runConsensus, runSemanticConsensus } from "./consensus.mjs";
import { readConsensusDoc, updateConsensusDoc } from "./consensus-doc.mjs";
import { diagnose } from "./diagnose.mjs";
import { publicConfiguration, updateConfiguration } from "./configure.mjs";
import { schedulerAction } from "./scheduler.mjs";
import { initializeVault, resolveVaultLayout } from "./vault.mjs";
import { buildMajorCard, listMajorCards, readMajorCard } from "./knowledge-card.mjs";
import {
  creatorAnalysisRequests,
  creatorStatus,
  creatorSynthesisRequest,
  ingestCreatorSynthesis,
  ingestCreatorVideoAnalysis,
  prepareCreator,
  resolveCreatorInput,
} from "./creator-workflow.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

function has(name) {
  return process.argv.includes(name);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 查询系统空闲秒数（Windows GetLastInputInfo，经 PowerShell 探针），失败返回 -1。 */
async function getIdleSeconds() {
  try {
    const script = path.join(root, "scripts", "get-idle-seconds.ps1");
    const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8", timeout: 15000 });
    if (res.status !== 0) return -1;
    const sec = Number(String(res.stdout || "").trim());
    return Number.isFinite(sec) ? sec : -1;
  } catch {
    return -1;
  }
}

/**
 * 暂停检查（每条视频处理前调用）：var\pause.flag 存在则进入等待，
 * 直到用户 resume 删除标志，或（配置了 pauseAutoResumeMinutes>0）系统空闲超过设定分钟数自动继续。
 */
async function checkPauseBeforeNext(config, writeProgress) {
  const flagFile = path.join(config.stateDir, "pause.flag");
  while (fs.existsSync(flagFile)) {
    writeProgress({ stage: "paused", pausedAt: new Date().toISOString() });
    const autoMin = Number(config.pauseAutoResumeMinutes || 0);
    if (autoMin > 0) {
      const idleSec = await getIdleSeconds();
      if (idleSec >= autoMin * 60) {
        try { fs.rmSync(flagFile, { force: true }); } catch {}
        process.stdout.write(`${JSON.stringify({ notice: `system idle ${idleSec}s >= ${autoMin}min; auto-resumed from pause` })}\n`);
        return;
      }
    }
    await sleep(20000);
  }
}

/** 从抖音链接解析视频 ID：支持 /video/N、/note/N、以及 v.douyin.com 短链（跟随重定向取最终 URL 再提取）。返回 { id, canonical } 或 null。 */
async function resolveDouyinVideoId(rawUrl) {
  let url = String(rawUrl || "").trim();
  if (!url) return null;
  const pick = (u) => {
    const m = u.match(/\/(?:video|note)\/(\d{5,})/);
    if (m) return { id: m[1], canonical: `https://www.douyin.com/video/${m[1]}` };
    const m2 = u.match(/(\d{15,})/);
    if (m2) return { id: m2[1], canonical: `https://www.douyin.com/video/${m2[1]}` };
    return null;
  };
  const direct = pick(url);
  if (direct) return direct;
  // 短链：跟随重定向
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
    const finalUrl = res.url || url;
    const viaRedirect = pick(finalUrl);
    if (viaRedirect) return viaRedirect;
  } catch {}
  return null;
}

/** 新增收藏列表（discovered_at ≈ 新增收藏时间）倒序输出，供桌面"新增收藏·核对与补充"页展示。 */
async function listNewArrivals(store, { since = "", days = 0, limit = 100 } = {}) {
  let isoSince = "";
  if (since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`invalid --since: ${since}`);
    isoSince = new Date(Date.parse(`${since}T00:00:00+08:00`)).toISOString();
  } else if (days > 0) {
    isoSince = new Date(Date.now() - days * 86400 * 1000).toISOString();
  }
  const rows = store.listNewArrivals(isoSince, limit);
  return {
    since: isoSince || null,
    count: rows.length,
    items: rows.map((r) => ({
      aweme_id: r.aweme_id,
      title: String(r.title || ""),
      status: r.status,
      discovered_at: r.discovered_at,
      source_url: r.source_url,
      category: r.category || "",
      group: r.group || "",
      subcategory: r.subcategory || "",
      note_path: r.note_path || "",
      last_error: r.last_error || "",
    })),
  };
}

/** 批量模式下自动"地址保鲜"：运行超时或连续 403 快失败时，重新采集并导入刷新 play_url。 */
async function refreshPlayUrls(config, store, { reason = "" } = {}) {
  const start = Date.now();
  process.stdout.write(`${JSON.stringify({ notice: "refreshing play_urls", reason })}\n`);
  let ok = false;
  try {
    const collect = spawnSync(config.pythonCommand, ["scripts/collect-favorites.py", "collect"], {
      cwd: root,
      encoding: "utf8",
      timeout: 180000,
    });
    const out = String(collect.stdout || "");
    const parsed = JSON.parse(out);
    ok = parsed?.status === "ok" && (parsed?.count || 0) > 0;
    if (!ok) throw new Error(`collect not ok: ${out.slice(0, 200)}`);
    const file = path.join(config.stateDir, "api-collection.json");
    await ingestFavorites(config, store, { file });
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ notice: "play_url refresh FAILED", error: String(error?.message || error).slice(0, 300) })}\n`);
    return { ok: false, elapsedSec: Math.round((Date.now() - start) / 1000), error: String(error?.message || error).slice(0, 300) };
  }
  return { ok: true, elapsedSec: Math.round((Date.now() - start) / 1000), reason };
}

const command = process.argv[2] || "status";
const config = loadConfig(option("--config"));
const store = new StateStore(config.databaseFile);

/** 网络类失败（断网/超时/连接重置）：等待网络恢复后重试，可无限等。 */
function isNetworkError(message) {
  const text = String(message || "");
  const hints = [
    "fetch failed", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH",
    "timed out", "timeout", "network", "socket hang up", "SIGTERM",
  ];
  return hints.some(hint => text.includes(hint));
}

/** 服务端类失败（地址过期 403、限流 429/5xx、风控 Blocked）：短等重试，次数超限则跳过本轮，等下次采集刷新后自然补上。 */
function isServerError(message) {
  const text = String(message || "");
  const hints = [
    "Blocked", "HTTP 403", "HTTP 404", "HTTP 429", "HTTP 500", "HTTP 502", "HTTP 503",
    "play_url", "precondition", "stream download", "download failed",
  ];
  return hints.some(hint => text.includes(hint));
}

try {
  if (command === "creator") {
    const action = process.argv[3] || "status";
    if (action === "resolve") {
      const candidates = await resolveCreatorInput(option("--input"), { limit: Number(option("--limit", "8")) });
      process.stdout.write(`${JSON.stringify({ candidates, requires_confirmation: candidates.length !== 1 }, null, 2)}\n`);
    } else if (action === "prepare") {
      const result = await prepareCreator(config, store, {
        secUid: option("--sec-uid"),
        limit: Number(option("--limit", "30")),
        sourceInput: option("--source-input"),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (action === "requests") {
      const requests = creatorAnalysisRequests(config, store, {
        secUid: option("--sec-uid"),
        limit: Number(option("--limit", "100")),
      });
      process.stdout.write(`${JSON.stringify({ requests }, null, 2)}\n`);
    } else if (action === "ingest-video") {
      const result = ingestCreatorVideoAnalysis(config, store, {
        secUid: option("--sec-uid"),
        awemeId: option("--aweme-id"),
        analysisFile: option("--file"),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (action === "synthesis-request") {
      const result = creatorSynthesisRequest(config, store, { secUid: option("--sec-uid") });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (action === "ingest-synthesis") {
      const result = ingestCreatorSynthesis(config, store, {
        secUid: option("--sec-uid"),
        synthesisFile: option("--file"),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (action === "status") {
      process.stdout.write(`${JSON.stringify(creatorStatus(store, { secUid: option("--sec-uid") }), null, 2)}\n`);
    } else {
      throw new Error(`unknown creator action: ${action}`);
    }
  } else if (command === "consensus") {
    if (option("--semantic") === "true") {
      const item = store.get(option("--aweme-id"));
      const result = await runSemanticConsensus(config, store, item);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const result = await runConsensus(config, store, { awemeId: option("--aweme-id") });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } else if (command === "consensus-doc") {
    const result = has("--read")
      ? readConsensusDoc(config, store, { category: option("--category"), subcategory: option("--subcategory"), group: option("--group") })
      : await updateConsensusDoc(config, store, { awemeId: option("--aweme-id"), category: option("--category"), subcategory: option("--subcategory"), group: option("--group") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "prune") {
    const result = pruneMedia(config, store);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "reclassify") {
    const result = await reclassifyWritten(config, store, {
      limit: Number(option("--limit", "100")),
      grouped: has("--grouped"),
      awemeId: option("--aweme-id"),
    });
    process.stdout.write(`${JSON.stringify({ processed: result, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "rename") {
    const result = migrateNoteNames(config, store, { limit: Number(option("--limit", "500")) });
    process.stdout.write(`${JSON.stringify({ ...result, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "ingest") {
    const result = await ingestFavorites(config, store, {
      file: option("--file"),
      maxItems: Number(option("--max-items", "0")),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "report") {
    const result = writeDailyReport(config, store, { date: option("--date") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "discover") {
    const rows = await discover(config, store, { limit: Number(option("--limit", config.discoveryLimit)) });
    process.stdout.write(`${JSON.stringify({ discovered: rows.length, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "freeze") {
    const rows = await freeze(config, store, {
      limit: Number(option("--limit", "1")),
      awemeId: option("--aweme-id"),
    });
    process.stdout.write(`${JSON.stringify({ processed: rows, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "transcribe") {
    const rows = await transcribe(config, store, {
      limit: Number(option("--limit", "1")),
      awemeId: option("--aweme-id"),
    });
    process.stdout.write(`${JSON.stringify({ processed: rows, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "extract") {
    const rows = await extract(config, store, {
      limit: Number(option("--limit", "1")),
      awemeId: option("--aweme-id"),
    });
    process.stdout.write(`${JSON.stringify({ processed: rows, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "write") {
    const rows = await write(config, store, {
      limit: Number(option("--limit", "1")),
      awemeId: option("--aweme-id"),
    });
    process.stdout.write(`${JSON.stringify({ processed: rows, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "sync") {
    const newest = Number(option("--newest", "0"));
    const pending = Number(option("--pending", "0"));
    if (newest > 0 || pending > 0) {
      const stopAt = Number(option("--stop-at", "0"));
      const scopeLimit = newest > 0 ? newest : pending;
      const targetWritten = stopAt > 0 ? stopAt : 0;
      const processed = [];
      const affectedSubcategories = new Set();
      const waitMs = Number(option("--wait", "90000"));
      const retryCap = Number(option("--retries", "0"));
      const skipped = new Set();
      const refreshIntervalMs = Number(option("--refresh-minutes", "90")) * 60 * 1000;
      let batchStartedAt = Date.now();
      let fastFailStreak = 0;
      let attempts = 0;
      // 实时进度文件（供桌面应用流水线页显示"本次运行进度"）：{running, done, total, percent}
      const progressFile = option("--progress-file", "");
      let plannedTotal = 0;
      let progressDone = 0;
      const writeProgress = (extra = {}) => {
        if (!progressFile) return;
        const percent = plannedTotal > 0 ? Math.min(100, Math.round((progressDone / plannedTotal) * 100)) : 100;
        try {
          fs.writeFileSync(progressFile, JSON.stringify({ running: true, done: progressDone, total: plannedTotal, percent, updatedAt: new Date().toISOString(), ...extra }));
        } catch {}
      };
      while (true) {
        const elapsedMs = Date.now() - batchStartedAt;
        if (elapsedMs >= refreshIntervalMs || fastFailStreak >= 5) {
          const refresh = await refreshPlayUrls(config, store, {
            reason: elapsedMs >= refreshIntervalMs ? `elapsed ${Math.round(elapsedMs / 60000)}min` : `fast-fail streak ${fastFailStreak}`,
          });
          batchStartedAt = Date.now();
          fastFailStreak = 0;
        }
        let candidates;
        if (pending > 0) {
          const sinceDays = Number(option("--since-days", "0"));
          const sinceDate = option("--since-date", ""); // YYYY-MM-DD：discovered_at >= 该日 00:00（本地，自然日窗口）
          const untilDate = option("--until-date", ""); // YYYY-MM-DD：discovered_at < 该日 00:00（本地）
          const startDate = option("--start-date", ""); // YYYY-MM-DD：只处理【新增收藏/首次采集（discovered_at）在该日（含）之后】的视频，更早的永久跳过（抖音不提供精确收藏时刻，以首次采集时间近似）
          const retrySince = option("--retry-since", ""); // YYYY-MM-DD：把该日 00:00（本地）之后失败的条目纳入候选（次日重试）
          const collectsId = option("--collects-id", ""); // 只处理指定抖音收藏夹（collects_id）内的视频；空=全部收藏视频
          let untilIso = "";
          if (untilDate) {
            untilIso = new Date(Date.parse(`${untilDate}T00:00:00+08:00`)).toISOString();
          } else {
            const nextDay = new Date(Date.now() + 24 * 3600 * 1000);
            untilIso = new Date(`${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, "0")}-${String(nextDay.getDate()).padStart(2, "0")}T00:00:00+08:00`).toISOString();
          }
          let sinceIso = "";
          if (sinceDate) {
            sinceIso = new Date(Date.parse(`${sinceDate}T00:00:00+08:00`)).toISOString();
          } else if (sinceDays > 0) {
            sinceIso = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
          }
          // 按数量快照窗口（--count-window 且已配置）：候选严格锁定在设置时固定的 [sinceIso, untilIso)，后续新收藏不计入
          if (has("--count-window") && config.countWindow) {
            sinceIso = config.countWindow.sinceIso;
            untilIso = config.countWindow.untilIso;
          }
          const retryUpdatedSinceIso = retrySince
            ? new Date(Date.parse(`${retrySince}T00:00:00+08:00`)).toISOString()
            : "";
          // 起始日期语义 = 按新增收藏/首次采集时间（discovered_at）永久打标，由 configure --start-date 完成（此处防御性兜底）
          if (startDate) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error(`invalid --start-date: ${startDate}`);
            const startIso = new Date(Date.parse(`${startDate}T00:00:00+08:00`)).toISOString();
            const marked = store.skipBeforeDiscoveredAt(startIso, "before-start-date");
            if (marked > 0) process.stdout.write(`${JSON.stringify({ notice: `marked ${marked} items collected before start-date as skipped`, startDate })}\n`);
          }
          candidates = store.listPending({ sinceDiscovered: sinceIso, untilDiscovered: untilIso, retryUpdatedSince: retryUpdatedSinceIso, collectsId, limit: scopeLimit });
        } else {
          candidates = store.listNewest({ limit: scopeLimit }).filter(row => row.status !== "written" && row.status !== "skipped");
        }
        candidates = candidates.filter(row => !skipped.has(row.aweme_id));
        if (!candidates.length) {
          // 按数量快照窗口处理完后自动清除，回到按时间/全部模式，避免新收藏永远不进窗口
          if (has("--count-window") && config.countWindow) {
            updateConfiguration(config.configFile, { countWindow: null });
            process.stdout.write(`${JSON.stringify({ notice: "count-window finished: snapshot cleared, back to normal mode" })}\n`);
          }
          writeProgress({ stage: "done" });
          break;
        }
        if (!plannedTotal) { plannedTotal = candidates.length; writeProgress({ stage: "sync" }); }
        if (targetWritten > 0) {
          const scopeWritten = store.listNewest({ limit: scopeLimit }).filter(row => row.status === "written").length;
          if (scopeWritten >= targetWritten) break;
        }
        const batch = candidates.slice(0, 10);
        const batchResults = [];
        let batchSuccess = 0;
        let retryableFailed = 0;
        const serverTries = new Map();
        for (const row of batch) {
          // 暂停检查：每处理完一条、下一条开始前检查暂停标志（当前条一旦开始会跑完，暂停约延迟一条视频的时长）
          await checkPauseBeforeNext(config, writeProgress);
          const startedAt = new Date().toISOString();
          process.stdout.write(`${JSON.stringify({ event: "start", aweme_id: row.aweme_id, title: String(row.title || "").slice(0, 40), t: startedAt })}\n`);
          const rows = await sync(config, store, { awemeId: row.aweme_id, skipConsensusDoc: true });
          const endAt = new Date().toISOString();
          const statuses = rows.map(r => r.status);
          process.stdout.write(`${JSON.stringify({ event: "done", aweme_id: row.aweme_id, statuses, durationSec: Math.round((new Date(endAt) - new Date(startedAt)) / 1000), t: endAt })}\n`);
          batchResults.push(...rows);
          const item = store.get(row.aweme_id);
          if (item?.category && item?.subcategory && item.subcategory !== "未分类") {
            affectedSubcategories.add(`${item.category}\u241F${item.group || ""}\u241F${item.subcategory}`);
          }
          batchSuccess += rows.filter(r => r.status === "written").length;
          for (const r of rows) {
            if (r.status !== "failed") continue;
            const expiredLike = /403|expired|forbidden/i.test(String(r.error || ""));
            fastFailStreak = expiredLike ? fastFailStreak + 1 : 0;
            if (isNetworkError(r.error)) {
              retryableFailed += 1;
            } else if (isServerError(r.error)) {
              const tries = (serverTries.get(row.aweme_id) || 0) + 1;
              serverTries.set(row.aweme_id, tries);
              if (tries >= 3) skipped.add(row.aweme_id);
              else retryableFailed += 1;
            } else {
              skipped.add(row.aweme_id);
            }
          }
        }
        processed.push(...batchResults);
        progressDone += batchResults.length;
        writeProgress({ stage: "sync" });
        if (retryableFailed > 0 && retryableFailed >= batchSuccess && batch.length > 0) {
          attempts += 1;
          const capHit = retryCap > 0 && attempts >= retryCap;
          const notice = capHit ? "retry cap reached; pausing batch" : "network/risk likely; waiting before retry";
          process.stdout.write(`${JSON.stringify({ notice, attempts, retryableFailed, batchSuccess, skippedNow: skipped.size })}\n`);
          if (capHit) break;
          await new Promise(resolve => setTimeout(resolve, waitMs));
        } else {
          attempts = 0;
        }
      }
      const docs = [];
      for (const key of affectedSubcategories) {
        const [cat, group, sub] = key.split("\u241F");
        docs.push(await updateConsensusDoc(config, store, { category: cat, group, subcategory: sub }).catch(error => ({ category: cat, group, subcategory: sub, error: String(error?.message || error) })));
      }
      if (progressFile) {
        try {
          fs.writeFileSync(progressFile, JSON.stringify({ running: false, done: progressDone, total: plannedTotal, percent: 100, finishedAt: new Date().toISOString() }));
        } catch {}
      }
      process.stdout.write(`${JSON.stringify({ processed, consensusDocs: docs, counts: store.counts() }, null, 2)}\n`);
    } else {
      const rows = await sync(config, store, {
        limit: Number(option("--limit", "1")),
        awemeId: option("--aweme-id"),
      });
      process.stdout.write(`${JSON.stringify({ processed: rows, counts: store.counts() }, null, 2)}\n`);
    }
  } else if (command === "retry") {
    const sinceUpdated = option("--since-updated", ""); // YYYY-MM-DD：只重试该日 00:00（本地）之后失败的条目
    const sinceIso = sinceUpdated
      ? new Date(Date.parse(`${sinceUpdated}T00:00:00+08:00`)).toISOString()
      : "";
    const retried = store.retryFailed(option("--aweme-id"), sinceIso);
    process.stdout.write(`${JSON.stringify({ retried, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "diagnose") {
    const result = await diagnose(config, store, { live: option("--live", "false") === "true" });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 2;
  } else if (command === "configure") {
    if (!has("--show")) {
      updateConfiguration(config.configFile, {
        profile: option("--profile"),
        vaultPath: option("--vault"),
        vaultFolder: option("--folder"),
        whisperModel: option("--whisper-model"),
        whisperModelLabel: option("--whisper-model-label"),
        extractorProvider: option("--extractor"),
        cloudTranscriptOptIn: option("--cloud-transcript"),
        scheduleMinutes: option("--schedule-minutes"),
        startDate: has("--start-date") ? option("--start-date") : undefined,
      });
      // 按数量快照窗口：--count-window <正整数> = 从目前往后数 N 条（最新 N 条收藏），后续新收藏不计入；--count-window "" 清除（回到按时间/全部模式）
      if (has("--count-window")) {
        const raw = option("--count-window", "");
        if (raw === "") {
          updateConfiguration(config.configFile, { countWindow: null });
          process.stdout.write(`${JSON.stringify({ notice: "count-window cleared（回到按时间/全部模式）" })}\n`);
        } else {
          const n = Number(raw);
          if (!Number.isInteger(n) || n <= 0) throw new Error(`--count-window 需要正整数条数，或空字符串清除，收到：${raw}`);
          const { count, sinceIso } = store.latestWindow(n);
          if (!sinceIso) throw new Error("知识库还没有视频，无法设置按数量窗口");
          const untilIso = new Date().toISOString();
          updateConfiguration(config.configFile, { countWindow: { limit: n, sinceIso, untilIso } });
          process.stdout.write(`${JSON.stringify({ notice: "count-window applied（按数量快照：从目前往后数 N 条，后续新收藏不计入）", limit: n, snapshotCount: count, sinceIso, untilIso })}\n`);
        }
      }
      // 起始日期改动联动处理：先恢复所有旧打标（before-start-date / before-incremental-window），再按新日期重新打标。
      // 口径：起始日期 = 只处理【首次采集/新增收藏（discovered_at）在该日期（含）之后】的视频；更早的永久跳过。
      // 抖音接口不提供精确"收藏时刻"，以本机首次采集时间（discovered_at，即收藏列表中新出现该视频的时刻）近似收藏时间。
      if (has("--start-date")) {
        const newStart = option("--start-date", "");
        const restored = store.restoreByReason("before-start-date") + store.restoreByReason("before-incremental-window");
        let marked = 0;
        if (newStart) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(newStart)) throw new Error(`invalid start-date: ${newStart}`);
          const isoCutoff = new Date(Date.parse(`${newStart}T00:00:00+08:00`)).toISOString();
          marked = store.skipBeforeDiscoveredAt(isoCutoff, "before-start-date");
        }
        process.stdout.write(`${JSON.stringify({ notice: "start-date applied（按新增收藏/首次采集时间 discovered_at）", startDate: newStart, restored, marked })}\n`);
      }
    }
    const configured = loadConfig(config.configFile);
    const vault = configured.vaultPath
      ? (has("--show") ? resolveVaultLayout(configured) : initializeVault(configured))
      : null;
    process.stdout.write(`${JSON.stringify({ ...publicConfiguration(configured), vault }, null, 2)}\n`);
  } else if (command === "schedule") {
    const action = process.argv[3] || "status";
    const options = { dailyTime: option("--daily") };
    process.stdout.write(`${JSON.stringify(schedulerAction(config, action, options), null, 2)}\n`);
  } else if (command === "status") {
    const awemeId = option("--aweme-id");
    const sinceDate = option("--since-date", ""); // YYYY-MM-DD：只统计该日（含）之后【新增收藏/首次采集（discovered_at）】的视频，供总览窗口进度（抖音不提供精确收藏时刻，以首次采集时间近似）
    let counts = store.counts();
    let windowInfo = null;
    if (has("--count-window") && config.countWindow) {
      // 按数量快照窗口进度：窗口 = 设置时固定 [sinceIso, untilIso)，后续新收藏不计入
      counts = store.countsBetween(config.countWindow.sinceIso, config.countWindow.untilIso);
      windowInfo = { mode: "count", limit: config.countWindow.limit, sinceIso: config.countWindow.sinceIso, untilIso: config.countWindow.untilIso };
    } else if (sinceDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) throw new Error(`invalid --since-date: ${sinceDate}`);
      const isoCutoff = new Date(Date.parse(`${sinceDate}T00:00:00+08:00`)).toISOString();
      counts = store.countsSinceDiscovered(isoCutoff);
      windowInfo = { mode: "time", sinceDate };
    }
    const items = awemeId
      ? [store.get(awemeId)].filter(Boolean)
      : store.list({ limit: Number(option("--limit", "20")) });
    // 每日定时任务今日候选（口径与 run-sync.ps1 一致）：昨日新增（discovered_at 窗口 [昨天00:00, 明天00:00)） + 3 天内失败重试
    // 仅在全库模式（无 --count-window / --since-date）下计算，供桌面"每日任务待处理"显示，数值随日期变化
    let dailyWindow = null;
    if (!has("--count-window") && !sinceDate) {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const dayStart = (offset) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, 0, 0, 0);
      const dailyCands = store.listPending({
        sinceDiscovered: dayStart(-1).toISOString(),
        untilDiscovered: dayStart(1).toISOString(),
        retryUpdatedSince: dayStart(-3).toISOString(),
        limit: 100000,
      });
      dailyWindow = {
        mode: "daily-incremental",
        sinceDate: `${dayStart(-1).getFullYear()}-${pad(dayStart(-1).getMonth() + 1)}-${pad(dayStart(-1).getDate())}`,
        retrySinceDate: `${dayStart(-3).getFullYear()}-${pad(dayStart(-3).getMonth() + 1)}-${pad(dayStart(-3).getDate())}`,
        total: dailyCands.length,
      };
    }
    const paused = fs.existsSync(path.join(config.stateDir, "pause.flag"));
    process.stdout.write(`${JSON.stringify({ counts, sinceDate, windowInfo, dailyWindow, paused, pauseAutoResumeMinutes: Number(config.pauseAutoResumeMinutes || 0), items }, null, 2)}\n`);
  } else if (command === "newarrivals") {
    const result = await listNewArrivals(store, {
      since: option("--since", ""),
      days: Number(option("--days", "0")),
      limit: Number(option("--limit", "100")),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "add") {
    const urls = String(option("--url", "")).split(/[\s,;，；]+/).map(s => s.trim()).filter(Boolean);
    const title = option("--title", "");
    if (!urls.length) throw new Error("add 需要 --url <抖音视频链接>（可多个，空格/逗号/分号分隔）");
    const results = [];
    for (const raw of urls) {
      const info = await resolveDouyinVideoId(raw);
      if (!info) {
        results.push({ url: raw, ok: false, error: "无法解析抖音视频链接（支持 /video/N、/note/N、v.douyin.com 短链）" });
        continue;
      }
      const inserted = store.addManually({ awemeId: info.id, sourceUrl: info.canonical, title });
      results.push({ aweme_id: info.id, ok: true, url: info.canonical, ...inserted });
    }
    process.stdout.write(`${JSON.stringify({ results, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "knowledge-card") {
    const major = option("--major");
    const minVideos = Number(option("--min-videos", "50"));
    if (has("--list")) {
      process.stdout.write(`${JSON.stringify(listMajorCards(config, store), null, 2)}\n`);
    } else if (has("--read")) {
      const target = option("--major");
      process.stdout.write(`${JSON.stringify(readMajorCard(config, target), null, 2)}\n`);
    } else if (major) {
      const result = await buildMajorCard(config, store, major, { minVideos });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const items = listMajorCards(config, store);
      const results = [];
      for (const entry of items) {
        const result = await buildMajorCard(config, store, entry.major, { minVideos });
        results.push(result);
      }
      process.stdout.write(`${JSON.stringify({ processed: results.length, results }, null, 2)}\n`);
    }
  } else if (command === "pause") {
    // 写入暂停标志：正在/将要运行的 sync 批量循环会在每条视频处理完、下一条开始前停下等待
    const flagFile = path.join(config.stateDir, "pause.flag");
    const already = fs.existsSync(flagFile);
    if (!already) {
      fs.writeFileSync(flagFile, JSON.stringify({ reason: option("--reason", "user"), requestedAt: new Date().toISOString() }));
    }
    process.stdout.write(`${JSON.stringify({ paused: true, notice: already ? "already paused（已处于暂停状态）" : "paused（已写入暂停标志；任务会在当前视频处理完后停在下一条之前，resume 后自动继续）", flagFile })}\n`);
  } else if (command === "resume") {
    // 删除暂停标志：等待中的 sync 循环在下次检查时自动继续
    const flagFile = path.join(config.stateDir, "pause.flag");
    const existed = fs.existsSync(flagFile);
    if (existed) fs.rmSync(flagFile, { force: true });
    process.stdout.write(`${JSON.stringify({ paused: false, notice: existed ? "resumed（已清除暂停标志，任务将自动继续）" : "not paused（当前没有暂停标志）", flagFile })}\n`);
  } else if (command === "cleanup") {
    // 清理临时媒体：删除 var\media 下的残留 mp4（下载过但未删除的文件）
    // 若 sync 正在运行则拒绝，避免删到正在使用的文件
    const mediaDir = config.mediaDir;
    const lockFile = path.join(config.stateDir, "sync.lock");
    let running = false;
    try {
      if (fs.existsSync(lockFile)) {
        const lk = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        try { process.kill(Number(lk.pid), 0); running = true; } catch {}
      }
    } catch {}
    if (running) {
      process.stdout.write(`${JSON.stringify({ blocked: true, notice: "检测到同步任务正在运行，请先暂停（pause）或等任务结束后再清理，避免删到正在使用的视频文件" })}\n`);
    } else {
      let removed = 0;
      let bytesFreed = 0;
      if (fs.existsSync(mediaDir)) {
        for (const name of fs.readdirSync(mediaDir)) {
          const p = path.join(mediaDir, name);
          try {
            const st = fs.statSync(p);
            if (st.isFile()) { bytesFreed += st.size; fs.rmSync(p, { force: true }); removed += 1; }
          } catch {}
        }
      }
      process.stdout.write(`${JSON.stringify({ ok: true, removed, bytesFreed, mediaDir })}\n`);
    }
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} finally {
  store.close();
}
