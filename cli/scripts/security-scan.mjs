import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, root } from "../src/config.mjs";
import { resolveVaultLayout } from "../src/vault.mjs";

const secretPatterns = [
  { name: "OpenAI-style key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  { name: "literal bearer token", regex: /\bBearer\s+(?!\$\{)[A-Za-z0-9._-]{20,}\b/giu },
  { name: "long literal cookie", regex: /\bCookie\s*:\s*(?!\[)[A-Za-z0-9%._-]{20,}/giu },
  { name: "private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu },
];
const signedUrlPattern = /https?:\/\/[^\s"'<>]+[?&](?:token|signature|x-signature|a_bogus|x_bogus|verifyFp|expires|x-expires)=[^&\s"'<>]+/giu;

const archiveExcludedDirectories = new Set([
  ".git",
  ".venv",
  ".bootstrap-tools",
  "node_modules",
  "var",
  "dist",
  "coverage",
  "__pycache__",
  "web-articles",
]);

function archiveCandidates(directory = root) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && archiveExcludedDirectories.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...archiveCandidates(file));
      continue;
    }
    if (entry.name === ".env" || entry.name === "config.json" || /\.(?:part|tmp|pyc)$/iu.test(entry.name)) continue;
    files.push(path.relative(root, file));
  }
  return files;
}

function trackedCandidates() {
  if (!fs.existsSync(path.join(root, ".git"))) return archiveCandidates();
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    if (result.error?.code === "ENOENT") return archiveCandidates();
    throw new Error("could not enumerate repository files");
  }
  return result.stdout.split("\0").filter(Boolean);
}

function scanText(label, text, { allowSyntheticSignedUrls = false } = {}) {
  const findings = [];
  for (const pattern of secretPatterns) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) findings.push(`${label}: ${pattern.name}`);
  }
  signedUrlPattern.lastIndex = 0;
  const signedUrls = [...text.matchAll(signedUrlPattern)].map(match => match[0]);
  if (signedUrls.some(url => !allowSyntheticSignedUrls || !/\.(?:example|invalid)(?:\/|$)/iu.test(new URL(url).hostname + "/"))) {
    findings.push(`${label}: signed URL`);
  }
  return findings;
}

function walkTextFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "media" || entry.name === "models" || entry.name === "obsidian-test-profile") continue;
      files.push(...walkTextFiles(file));
    } else if (/\.(?:json|md|log|txt)$/iu.test(entry.name)) {
      files.push(file);
    }
  }
  return files;
}

const findings = [];
const config = loadConfig();
const candidates = trackedCandidates();
for (const relative of candidates) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file) || fs.statSync(file).size > 5 * 1024 * 1024) continue;
  const text = fs.readFileSync(file, "utf8");
  findings.push(...scanText(relative, text, { allowSyntheticSignedUrls: /(?:^|[\\/])tests[\\/]/u.test(relative) }));
}

const runtimeFiles = walkTextFiles(config.stateDir);
for (const file of runtimeFiles) {
  findings.push(...scanText(path.relative(root, file), fs.readFileSync(file, "utf8")));
}

let vaultFiles = [];
if (config.vaultPath) {
  const vault = resolveVaultLayout(config);
  vaultFiles = walkTextFiles(vault.root);
  for (const file of vaultFiles) {
    findings.push(...scanText(`vault:${path.relative(vault.root, file)}`, fs.readFileSync(file, "utf8")));
  }
}

const databaseFile = config.databaseFile;
let databaseRows = 0;
if (fs.existsSync(databaseFile)) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const rows = database.prepare("SELECT * FROM items").all();
    databaseRows = rows.length;
    for (const row of rows) {
      findings.push(...scanText(`state.sqlite3:${row.aweme_id}`, JSON.stringify(row)));
    }
  } finally {
    database.close();
  }
}

const forbiddenTracked = candidates.filter(file => /(?:^|[\\/])(?:config\.json|\.env|state\.sqlite3)(?:$|[\\/])/iu.test(file));
for (const file of forbiddenTracked) findings.push(`${file}: forbidden tracked runtime file`);

if (findings.length) {
  process.stderr.write(`${JSON.stringify({ ok: false, findings }, null, 2)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    repositoryFilesScanned: candidates.length,
    runtimeTextFilesScanned: runtimeFiles.length,
    vaultTextFilesScanned: vaultFiles.length,
    databaseRowsScanned: databaseRows,
    forbiddenRuntimeFilesTracked: 0,
  }, null, 2)}\n`);
}
