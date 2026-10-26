import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { listSaved, resolveOpencliInvocation } from "./opencli.mjs";
import { initializeVault } from "./vault.mjs";

function commandCheck(command, args = ["-version"]) {
  const result = spawnSync(command, args, { windowsHide: true, shell: false, encoding: "utf8", timeout: 30000 });
  return { ok: result.status === 0, detail: result.status === 0 ? "available" : "not available" };
}

function vaultCheck(config) {
  if (!config.vaultPath) return { ok: false, detail: "vaultPath is not configured" };
  try {
    const directory = initializeVault(config).inbox;
    const probe = path.join(directory, `.dok-write-probe-${process.pid}`);
    fs.writeFileSync(probe, "ok", "utf8");
    fs.rmSync(probe, { force: true });
    return { ok: true, detail: directory };
  } catch (error) {
    return { ok: false, detail: `not writable: ${error.code || error.name}` };
  }
}

function opencliCheck() {
  try {
    const invocation = resolveOpencliInvocation();
    const result = spawnSync(invocation.command, [...invocation.prefix, "doctor"], {
      env: invocation.environment,
      windowsHide: true,
      shell: false,
      encoding: "utf8",
      timeout: 30000,
    });
    return {
      ok: result.status === 0,
      detail: result.status === 0 ? "Browser Bridge connected" : "Browser Bridge not connected; run setup-browser-bridge.ps1",
    };
  } catch (error) {
    return { ok: false, detail: String(error?.message || error) };
  }
}

export async function diagnose(config, store, { live = false } = {}) {
  const bridge = opencliCheck();
  if (!live && bridge.ok === false) bridge.ok = null;
  const checks = {
    config: { ok: fs.existsSync(config.configFile), detail: config.configFile },
    database: { ok: fs.existsSync(config.databaseFile), detail: config.databaseFile },
    python: { ok: fs.existsSync(config.pythonCommand), detail: config.pythonCommand },
    whisperModel: {
      ok: fs.existsSync(config.whisperModelLock) && (!path.isAbsolute(config.whisperModel) || fs.existsSync(config.whisperModel)),
      detail: fs.existsSync(config.whisperModelLock)
        ? (path.isAbsolute(config.whisperModel) ? config.whisperModel : `locked model: ${config.whisperModel}`)
        : `model lock missing: ${config.whisperModelLock}`,
    },
    mediaProbe: commandCheck(config.pythonCommand, [config.mediaProbeScript, "--self-check"]),
    vault: vaultCheck(config),
    extraction: {
      ok: config.extractorProvider === "local" || (config.cloudTranscriptOptIn && Boolean(config.llmApiKey) && Boolean(config.llmModel)),
      detail: config.extractorProvider === "local" ? "local transcript-only extraction" : "OpenAI-compatible transcript upload explicitly enabled",
    },
    opencliBridge: bridge,
  };
  if (live) {
    try {
      const rows = await listSaved({ limit: 1, includePlayUrl: false });
      checks.douyinSession = { ok: rows.length > 0, detail: rows.length ? "authenticated favorites readable" : "no favorites returned" };
    } catch (error) {
      checks.douyinSession = { ok: false, detail: String(error?.message || error) };
    }
  } else {
    checks.douyinSession = { ok: null, detail: "not checked; pass --live true" };
  }
  return { ok: Object.values(checks).every(check => check.ok !== false), checks, counts: store.counts() };
}
