import path from "node:path";
import { spawnSync } from "node:child_process";
import { root } from "./config.mjs";

function run(args, allowMissing = false) {
  if (process.platform !== "win32") throw new Error("Windows Task Scheduler is only available on Windows");
  const result = spawnSync("schtasks.exe", args, { windowsHide: true, shell: false, encoding: "utf8", timeout: 60000 });
  if (result.status !== 0 && !allowMissing) {
    throw new Error(`Task Scheduler command failed with ${result.status}: ${String(result.stderr || result.stdout).replace(/\s+/gu, " ").trim().slice(-500)}`);
  }
  return result;
}

function taskOwnership(config) {
  const result = run(["/Query", "/TN", config.schedulerTaskName, "/XML"], true);
  if (result.status !== 0) return { installed: false, owned: false };
  const script = path.join(root, "scripts", "run-sync.ps1");
  return {
    installed: true,
    owned: String(result.stdout || "").replaceAll("\0", "").toLowerCase().includes(script.toLowerCase()),
  };
}

export function schedulerAction(config, action, options = {}) {
  const task = config.schedulerTaskName;
  if (action === "install") {
    const existing = taskOwnership(config);
    if (existing.installed) {
      throw new Error(`Scheduled task already exists: ${task}. Inspect it with schedule status; uninstall it explicitly before reinstalling.`);
    }
    const script = path.join(root, "scripts", "run-sync.ps1");
    const command = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${script}"`;
    const dailyTime = String(options.dailyTime || config.scheduleDaily || "").trim();
    if (dailyTime) {
      const time = /^\d{1,2}:\d{2}$/u.test(dailyTime) ? dailyTime : "08:00";
      run(["/Create", "/TN", task, "/TR", command, "/SC", "DAILY", "/ST", time, "/RL", "LIMITED", "/F"]);
    } else {
      run(["/Create", "/TN", task, "/TR", command, "/SC", "MINUTE", "/MO", String(config.scheduleMinutes), "/RL", "LIMITED", "/F"]);
    }
    return {
      action,
      installed: true,
      enabled: true,
      task,
      schedule: dailyTime ? `daily at ${dailyTime}` : `every ${config.scheduleMinutes} minutes`,
      rollbackCommand: "node .\\src\\cli.mjs schedule uninstall",
    };
  }
  if (action === "status") {
    const ownership = taskOwnership(config);
    return {
      action,
      installed: ownership.installed,
      owned: ownership.owned,
      task,
      everyMinutes: config.scheduleMinutes,
      detail: ownership.installed ? (ownership.owned ? "available" : "name collision: task is not owned by this workflow") : "not installed",
      rollbackCommand: "node .\\src\\cli.mjs schedule uninstall",
    };
  }
  if (action === "run") {
    const ownership = taskOwnership(config);
    if (!ownership.installed || !ownership.owned) throw new Error(`Refusing to run an unowned scheduled task: ${task}`);
    run(["/Run", "/TN", task]);
    return { action, task, started: true };
  }
  if (action === "disable") {
    const ownership = taskOwnership(config);
    if (!ownership.installed || !ownership.owned) throw new Error(`Refusing to disable an unowned scheduled task: ${task}`);
    run(["/Change", "/TN", task, "/DISABLE"]);
    return { action, task, enabled: false };
  }
  if (action === "enable") {
    const ownership = taskOwnership(config);
    if (!ownership.installed || !ownership.owned) throw new Error(`Refusing to enable an unowned scheduled task: ${task}`);
    run(["/Change", "/TN", task, "/ENABLE"]);
    return { action, task, enabled: true };
  }
  if (action === "uninstall") {
    const ownership = taskOwnership(config);
    if (!ownership.installed) return { action, task, removed: false };
    if (!ownership.owned) throw new Error(`Refusing to remove an unowned scheduled task: ${task}`);
    const result = run(["/Delete", "/TN", task, "/F"]);
    return { action, task, removed: result.status === 0 };
  }
  throw new Error("schedule action must be install, status, run, enable, disable, or uninstall");
}
