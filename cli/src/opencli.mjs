import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractCreatorSecUid } from "../opencli-plugin/lib/creator-core.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const OPENCLI_MAIN_RELATIVE = path.join(
  "node_modules",
  "@jackwener",
  "opencli",
  "dist",
  "src",
  "main.js"
);

function envValue(environment, key) {
  const matched = Object.keys(environment || {}).find(name => name.toLowerCase() === key.toLowerCase());
  return matched ? environment[matched] : "";
}

function expandWindowsEnvironment(value, environment) {
  return String(value || "").replace(/%([^%]+)%/gu, (match, key) => {
    const resolved = envValue(environment, key);
    return resolved ? String(resolved) : match;
  });
}

function parseWrapperEnvironment(text, baseEnvironment) {
  const environment = { ...baseEnvironment };
  for (const line of String(text || "").split(/\r?\n/u)) {
    const match = line.match(/^\s*set\s+"([^=]+)=(.*)"\s*$/iu);
    if (!match) continue;
    const existing = Object.keys(environment).find(name => name.toLowerCase() === match[1].toLowerCase());
    environment[existing || match[1]] = expandWindowsEnvironment(match[2], environment);
  }
  return environment;
}

function wrapperTargets(text, wrapperDirectory, environment) {
  const targets = [];
  for (const match of String(text || "").matchAll(/"([^"]+opencli\.cmd)"\s+%[*]/giu)) {
    const expanded = expandWindowsEnvironment(match[1], environment)
      .replaceAll("%~dp0", wrapperDirectory + path.sep);
    targets.push(path.resolve(wrapperDirectory, expanded));
  }
  return targets;
}

function pathDirectories(environment) {
  return String(envValue(environment, "PATH") || "")
    .split(path.delimiter)
    .map(value => value.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);
}

function opencliEntry(directory) {
  const entry = path.join(directory, OPENCLI_MAIN_RELATIVE);
  return fs.existsSync(entry) ? entry : "";
}

export function resolveOpencliInvocation({ environment = process.env } = {}) {
  const projectEntry = path.join(PROJECT_ROOT, OPENCLI_MAIN_RELATIVE);
  if (fs.existsSync(projectEntry)) {
    return {
      command: process.execPath,
      prefix: [projectEntry],
      environment: { ...environment },
    };
  }
  if (process.platform !== "win32") {
    return { command: "opencli", prefix: [], environment: { ...environment } };
  }
  const initial = { ...environment };
  const queue = pathDirectories(initial)
    .map(directory => path.join(directory, "opencli.cmd"))
    .filter(file => fs.existsSync(file))
    .map(file => ({ file: path.resolve(file), environment: initial }));
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    const identity = current.file.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    const directory = path.dirname(current.file);
    const direct = opencliEntry(directory);
    if (direct) {
      const localNode = path.join(directory, "node.exe");
      return {
        command: fs.existsSync(localNode) ? localNode : process.execPath,
        prefix: [direct],
        environment: current.environment,
      };
    }
    let text;
    try {
      text = fs.readFileSync(current.file, "utf8").replace(/^\uFEFF/u, "");
    } catch {
      continue;
    }
    const wrapperEnvironment = parseWrapperEnvironment(text, current.environment);
    for (const target of wrapperTargets(text, directory, wrapperEnvironment)) {
      if (fs.existsSync(target)) queue.push({ file: target, environment: wrapperEnvironment });
    }
    for (const searchDirectory of pathDirectories(wrapperEnvironment)) {
      const entry = opencliEntry(searchDirectory);
      if (!entry) continue;
      const localNode = path.join(searchDirectory, "node.exe");
      return {
        command: fs.existsSync(localNode) ? localNode : process.execPath,
        prefix: [entry],
        environment: wrapperEnvironment,
      };
    }
  }
  throw new Error("could not resolve the shell-free OpenCLI Node entry");
}

function run(command, args, { environment, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: environment,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("OpenCLI timed out"));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`OpenCLI exited with ${code}: ${sanitizeError(stderr || stdout)}`));
    });
  });
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function restartDaemon() {
  // Force-stop the existing daemon and start a fresh one to clear stale
  // ephemeral session state (Chrome 155 + extension "Navigation rejected").
  const invocation = resolveOpencliInvocation();
  try {
    await run(invocation.command, [...invocation.prefix, "daemon", "stop"], {
      environment: invocation.environment,
      timeoutMs: 15000,
    });
  } catch { /* daemon may already be stopped */ }
  await delay(2000);
  const helper = path.join(PROJECT_ROOT, "scripts", "restart-opencli-daemon.mjs");
  try {
    await run(process.execPath, [helper], { timeoutMs: 30000 });
  } catch { /* best-effort; retry proceeds regardless */ }
  await delay(2000);
}

export function isRetryableOpencliError(error) {
  const message = String(error?.message || error).toLowerCase();
  return message.includes("detached while handling command")
    || message.includes("browser bridge extension not connected")
    || message.includes("requested profile not connected")
    || message.includes("opencli timed out")
    || message.includes("navigation rejected");
}

export async function retryOpencli(operation, { attempts = 3, delayMs = 750, beforeRetry } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableOpencliError(error)) throw error;
      if (beforeRetry) await beforeRetry(error, attempt);
      if (delayMs > 0) await delay(delayMs * attempt);
    }
  }
  throw lastError;
}

export async function runOpencli(args, { timeoutMs = 120000, attempts = 3 } = {}) {
  const invocation = resolveOpencliInvocation();
  return retryOpencli(
    () => run(invocation.command, [...invocation.prefix, ...args], {
      environment: invocation.environment,
      timeoutMs,
    }),
    {
      attempts,
      beforeRetry: async (error) => {
        if (String(error?.message || "").toLowerCase().includes("navigation rejected")) {
          await restartDaemon();
        }
      },
    },
  );
}

export function sanitizeError(value) {
  return String(value || "")
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(
      /((?:cookie|token|signature|a_bogus|x_bogus|verifyFp)\s*[:=]\s*)[^\s,;]+/giu,
      "$1[redacted]"
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-1200);
}

export async function listSaved({ limit = 50, includePlayUrl = false } = {}) {
  const args = [
    "douyin",
    "saved",
    "--limit",
    String(limit),
    "--include_play_url",
    String(includePlayUrl),
    "-f",
    "json",
    "--window",
    "background",
    "--site-session",
    "ephemeral",
    "--keep-tab",
    "false",
  ];
  const { stdout } = await runOpencli(args);
  const rows = JSON.parse(stdout.replace(/^\uFEFF/u, ""));
  if (!Array.isArray(rows)) throw new Error("OpenCLI douyin saved returned non-array JSON");
  return rows;
}

function parseRows(stdout, label) {
  const rows = JSON.parse(String(stdout || "").replace(/^\uFEFF/u, ""));
  if (!Array.isArray(rows)) throw new Error(`${label} returned non-array JSON`);
  return rows;
}

export async function listCreatorVideos({ secUid, limit = 30, includePlayUrl = false } = {}) {
  const normalized = extractCreatorSecUid(secUid);
  if (!normalized) throw new Error("a valid creator sec_uid or profile URL is required");
  const args = [
    "douyin", "creator-videos", normalized,
    "--limit", String(limit),
    "--include_play_url", String(includePlayUrl),
    "-f", "json",
    "--window", "background",
    "--site-session", "ephemeral",
    "--keep-tab", "false",
  ];
  const { stdout } = await runOpencli(args);
  const rows = parseRows(stdout, "OpenCLI douyin creator-videos");
  if (!includePlayUrl && rows.some(row => row?.play_url)) {
    throw new Error("creator video listing unexpectedly exposed a transient media URL");
  }
  return rows;
}

export async function listCreatorCandidates({ input, limit = 8 } = {}) {
  const value = String(input || "").trim();
  if (!value) throw new Error("creator input is required");
  const secUid = extractCreatorSecUid(value);
  if (secUid) {
    const rows = await listCreatorVideos({ secUid, limit: 1, includePlayUrl: false });
    const first = rows[0] || {};
    return [{
      rank: 1,
      sec_uid: secUid,
      nickname: String(first.author || ""),
      profile_url: `https://www.douyin.com/user/${secUid}`,
      sample_title: String(first.title || ""),
    }];
  }
  const { stdout } = await runOpencli([
    "douyin", "creator-search", value,
    "--limit", String(limit),
    "-f", "json",
    "--window", "background",
    "--site-session", "ephemeral",
    "--keep-tab", "false",
  ]);
  return parseRows(stdout, "OpenCLI douyin creator-search");
}
