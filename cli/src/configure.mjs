import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

function parseBoolean(value, label) {
  if ([true, "true", "1", "yes"].includes(value)) return true;
  if ([false, "false", "0", "no"].includes(value)) return false;
  throw new Error(`${label} must be true or false`);
}

export function updateConfiguration(file, options = {}) {
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, "")) : {};
  const next = { ...current };
  if (options.profile) next.profile = String(options.profile).toLowerCase();
  if (options.vaultPath) next.vaultPath = path.resolve(options.vaultPath);
  if (options.vaultFolder) next.vaultFolder = String(options.vaultFolder);
  if (options.whisperModel) next.whisperModel = String(options.whisperModel);
  if (options.whisperModelLabel) next.whisperModelLabel = String(options.whisperModelLabel);
  if (options.extractorProvider) {
    const provider = String(options.extractorProvider).toLowerCase();
    if (!["local", "openai"].includes(provider)) throw new Error("extractor must be local or openai");
    next.extractorProvider = provider;
  }
  if (options.cloudTranscriptOptIn !== undefined && options.cloudTranscriptOptIn !== "") {
    next.cloudTranscriptOptIn = parseBoolean(options.cloudTranscriptOptIn, "cloud transcript opt-in");
  }
  if (options.scheduleMinutes) {
    const minutes = Number(options.scheduleMinutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw new Error("schedule minutes must be between 5 and 1440");
    next.scheduleMinutes = minutes;
  }
  if (options.startDate !== undefined) {
    if (options.startDate === "") {
      next.startDate = "";
    } else {
      const match = String(options.startDate).match(/^\d{4}-\d{2}-\d{2}$/u);
      if (!match) throw new Error("startDate must be YYYY-MM-DD or empty");
      next.startDate = String(options.startDate);
    }
  }
  if (options.countWindow !== undefined) {
    // 按数量窗口：{limit, sinceIso, untilIso}；null/空 = 清除（回到按时间/全部模式）
    if (!options.countWindow || options.countWindow === "" || options.countWindow === "null") {
      delete next.countWindow;
    } else {
      const w = options.countWindow;
      const limit = Number(w.limit);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error("countWindow.limit must be a positive integer");
      if (!w.sinceIso || !w.untilIso) throw new Error("countWindow requires sinceIso and untilIso");
      next.countWindow = { limit, sinceIso: String(w.sinceIso), untilIso: String(w.untilIso) };
    }
  }
  atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function publicConfiguration(config) {
  return {
    configFile: config.configFile,
    stateDir: config.stateDir,
    profile: config.profile,
    vaultPath: config.vaultPath,
    vaultFolder: config.vaultFolder,
    discoveryLimit: config.discoveryLimit,
    pythonCommand: config.pythonCommand,
    mediaProbeScript: config.mediaProbeScript,
    whisperModel: config.whisperModel,
    whisperModelLock: config.whisperModelLock,
    whisperModelLabel: config.whisperModelLabel,
    hfEndpointConfigured: Boolean(config.hfEndpoint),
    extractorProvider: config.extractorProvider,
    cloudTranscriptOptIn: config.cloudTranscriptOptIn,
    llmBaseUrlConfigured: Boolean(config.llmBaseUrl),
    llmApiKeyConfigured: Boolean(config.llmApiKey),
    llmModelConfigured: Boolean(config.llmModel),
    schedulerTaskName: config.schedulerTaskName,
    scheduleMinutes: config.scheduleMinutes,
    startDate: config.startDate,
    countWindow: config.countWindow || null,
  };
}
