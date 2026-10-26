import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProfile, normalizeVaultFolder } from "./vault.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(configPath = "") {
  const file = path.resolve(configPath || process.env.DOK_CONFIG || path.join(root, "config.json"));
  let input = {};
  if (fs.existsSync(file)) {
    input = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
  }
  const stateDir = resolveFromRoot(input.stateDir || "var");
  return {
    configFile: file,
    stateDir,
    databaseFile: path.join(stateDir, "state.sqlite3"),
    mediaDir: path.join(stateDir, "media"),
    transcriptDir: path.join(stateDir, "transcripts"),
    knowledgeDir: path.join(stateDir, "knowledge"),
    creatorKnowledgeDir: path.join(stateDir, "creator-knowledge"),
    profile: normalizeProfile(input.profile),
    vaultPath: input.vaultPath ? resolveFromRoot(input.vaultPath) : "",
    vaultFolder: normalizeVaultFolder(input.vaultFolder),
    discoveryLimit: normalizeInteger(input.discoveryLimit, 50, 1, 200),
    collectorMaxItems: normalizeInteger(input.collectorMaxItems, 1000, 1, 10000),
    deleteMediaAfterWrite: input.deleteMediaAfterWrite !== false,
    pauseAutoResumeMinutes: normalizeInteger(input.pauseAutoResumeMinutes, 0, 0, 600),
    consensusThreshold: Number.isFinite(Number(input.consensusThreshold)) ? Math.max(0, Math.min(1, Number(input.consensusThreshold))) : 0.35,
    consensusMatchLimit: normalizeInteger(input.consensusMatchLimit, 100, 10, 500),
    consensusSemantic: input.consensusSemantic !== false,
    consensusSemanticHistoryLimit: normalizeInteger(input.consensusSemanticHistoryLimit, 30, 5, 100),
    classifyDynamicSubcategories: input.classifyDynamicSubcategories !== false,
    pythonCommand: path.resolve(root, String(input.pythonCommand || path.join(".venv", "Scripts", "python.exe"))),
    mediaProbeScript: resolveFromRoot(input.mediaProbeScript || path.join("python", "probe_media.py")),
    modelCacheDir: path.join(stateDir, "models"),
    whisperModel: String(input.whisperModel || "Systran/faster-whisper-small"),
    whisperModelLock: resolveFromRoot(input.whisperModelLock || path.join("models", "faster-whisper-small.lock.json")),
    whisperModelLabel: String(input.whisperModelLabel || "faster-whisper/Systran/faster-whisper-small@536b0662742c02347bc0e980a01041f333bce120"),
    hfEndpoint: String(process.env.DOK_HF_ENDPOINT || ""),
    language: String(input.language || "zh"),
    extractorProvider: String(input.extractorProvider || "local").toLowerCase(),
    cloudTranscriptOptIn: input.cloudTranscriptOptIn === true,
    llmBaseUrl: String(process.env.DOK_LLM_BASE_URL || process.env.OPENAI_BASE_URL || input.llmBaseUrl || "https://api.openai.com/v1").replace(/\/+$/u, ""),
    llmApiKey: String(process.env.DOK_LLM_API_KEY || process.env.OPENAI_API_KEY || input.llmApiKey || ""),
    llmModel: String(process.env.DOK_LLM_MODEL || process.env.OPENAI_MODEL || input.llmModel || ""),
    schedulerTaskName: String(input.schedulerTaskName || "Douyin Obsidian Knowledge"),
    scheduleMinutes: normalizeInteger(input.scheduleMinutes, 60, 5, 1440),
    startDate: String(input.startDate || ""),
    countWindow: input.countWindow && typeof input.countWindow === "object" ? input.countWindow : null,
  };
}

function resolveFromRoot(value) {
  const text = String(value);
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(root, text);
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}
