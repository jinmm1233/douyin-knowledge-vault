import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { sha256File } from "./media.mjs";
import { root } from "./config.mjs";

function run(command, args, timeoutMs = 3600000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("transcription timed out")); }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`transcription exited with ${code}: ${stderr.replace(/\s+/gu, " ").trim().slice(-1000)}`));
    });
  });
}

export function validateTranscript(transcript, mediaDurationSeconds) {
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  if (!segments.length || !String(transcript?.text || "").trim()) {
    throw new Error("transcription produced no usable text segments");
  }
  const duration = Number(transcript?.duration || 0);
  if (!(duration > 0)) throw new Error("transcription duration is missing");
  if (mediaDurationSeconds > 0 && Math.abs(duration - mediaDurationSeconds) > Math.max(3, mediaDurationSeconds * 0.05)) {
    throw new Error("transcription duration differs from the frozen media");
  }
  const lastEnd = Math.max(...segments.map(segment => Number(segment.end || 0)));
  if (lastEnd < Math.min(duration, mediaDurationSeconds || duration) * 0.5) {
    throw new Error("transcription does not cover enough of the media timeline");
  }
}

async function ensureModel(config) {
  if (path.isAbsolute(config.whisperModel) && fs.existsSync(config.whisperModel)) {
    return config.whisperModel;
  }
  if (process.platform !== "win32") return config.whisperModel;
  const script = path.join(root, "scripts", "ensure-whisper-model.ps1");
  const modelBundleDirectory = String(process.env.DOK_MODEL_BUNDLE_DIR || "").trim();
  const stdout = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-ProjectRoot", root,
    "-StateDir", config.stateDir,
    ...(modelBundleDirectory ? ["-BundleDirectory", modelBundleDirectory] : []),
  ], 6 * 60 * 60 * 1000);
  const modelPath = stdout.trim().split(/\r?\n/u).at(-1);
  if (!modelPath || !fs.existsSync(modelPath)) throw new Error("locked Whisper model download created no model directory");
  return modelPath;
}

export async function transcribeMedia(item, config) {
  if (!fs.existsSync(config.pythonCommand)) {
    throw new Error(`project Python environment is missing: ${config.pythonCommand}`);
  }
  const outputDir = path.join(config.transcriptDir, String(item.aweme_id));
  fs.mkdirSync(outputDir, { recursive: true });
  const modelPath = await ensureModel(config);
  const stdout = await run(config.pythonCommand, [
    path.join(root, "python", "transcribe.py"),
    "--input", item.media_path,
    "--output-dir", outputDir,
    "--model", modelPath,
    "--model-lock", config.whisperModelLock,
    "--language", config.language,
    "--model-cache", config.modelCacheDir,
    ...(config.hfEndpoint ? ["--hf-endpoint", config.hfEndpoint] : []),
  ]);
  const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
  const transcriptFile = path.join(outputDir, "transcript.json");
  if (!fs.existsSync(transcriptFile)) throw new Error("transcription created no transcript file");
  const transcript = JSON.parse(fs.readFileSync(transcriptFile, "utf8").replace(/^\uFEFF/u, ""));
  validateTranscript(transcript, Number(item.media_duration_seconds || item.duration_seconds || 0));
  const sha256 = sha256File(transcriptFile);
  if (result.transcriptSha256 && result.transcriptSha256 !== sha256) {
    throw new Error("transcript hash does not match its manifest");
  }
  return {
    path: transcriptFile,
    sha256,
    durationSeconds: Number(transcript.duration || 0),
    segmentCount: transcript.segments.length,
    wordCount: Array.isArray(transcript.words) ? transcript.words.length : 0,
    resumed: result.resumed === true,
  };
}
