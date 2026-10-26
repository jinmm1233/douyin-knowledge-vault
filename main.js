const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFile } = require("child_process");
const { runCangjieDistill } = require("./cangjie-runner");

const APP_DIR = path.join(os.homedir(), ".douyin-knowledge-app");
const SETTINGS_FILE = path.join(APP_DIR, "settings.json");

// 打包版（app.isPackaged）运行时全部内置在 resources/dok-runtime：node / python venv / whisper 模型 / 仓颉技能 / 采集项目
// 开发版保持原开发机默认路径；全新用户（无 settings.json）自动拿到内置路径，实现开箱即用
function bundledRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, "dok-runtime") : "";
}
const BUNDLED = bundledRoot();

const DEFAULT_SETTINGS = {
  projectPath: BUNDLED ? path.join(BUNDLED, "project") : path.join(__dirname, "cli"),
  vaultPath: BUNDLED ? "" : "",
  nodePath: BUNDLED ? path.join(BUNDLED, "node", "node.exe") : "",
  llmBaseUrl: "https://api.deepseek.com/v1",
  llmApiKey: "",
  llmModel: "deepseek-chat",
  whisperModel: "Systran/faster-whisper-small",
  startDate: "",
  startDateAcknowledged: false,
  processMode: "time", // time=按起始日期之后的新增收藏；count=按数量快照（从目前往后数 N 条，后续新收藏不计入）
  countLimit: 100,
  pauseAutoResumeMinutes: 0, // 暂停后系统空闲超过该分钟数自动恢复（0=关闭，只手动恢复）
  distillOutputDir: BUNDLED ? path.join(os.homedir(), "douyin-distill") : path.join(os.homedir(), "douyin-distill"),
  cangjiePath: BUNDLED ? path.join(BUNDLED, "cangjie") : path.join(__dirname, "cangjie"),
  pythonPath: BUNDLED ? path.join(BUNDLED, "project", ".venv", "Scripts", "python.exe") : "",
  // 每周知识周报：enabled=开关；weekday=1(周一)~7(周日)；lastShownDate=上次弹窗日期；streak=连续达成周数
  weeklyReport: { enabled: false, weekday: 2, lastShownDate: "", streak: 0, bestStreak: 0, totalShown: 0, aiSummary: "", aiSummaryWeek: "", aiDirection: "", aiDirectionWeek: "" },
  // 已解锁成就：{ 徽章id: "解锁日期YYYY-MM-DD" }，用于判定"新达成"并触发解锁弹出动画
  unlockedBadges: {},
  // 置顶：知识库大分类 / 知识卡片（大分类名列表，渲染时排最前并显示 📌 角标）
  pinnedMajors: [],
  pinnedCards: [],
  // 本周 AI 消耗统计（按自然周累计桌面端 AI 调用 token）；apiBalance=余额查询缓存
  apiUsage: { weekKey: "", tokens: 0, calls: 0 },
  apiBalance: { time: "", balance: "" },
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(patch) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  const next = { ...loadSettings(), ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  // 起始日期同时写入 CLI 项目 config.json，保证定时任务（run-sync.ps1）读到同一口径
  const isCountMode = next.processMode === "count";
  // count 模式下起始日期无意义，强制按空处理（避免日期打标与数量快照叠加冲突）；切回 time 才恢复使用 startDate
  const effStartDate = isCountMode ? "" : (next.startDate || "");
  const patchHasStart = patch && Object.prototype.hasOwnProperty.call(patch, "startDate");
  const patchHasMode = patch && Object.prototype.hasOwnProperty.call(patch, "processMode");
  // 需要联动日期的三种情况：用户改了日期；切到 count（强制清空）；切回 time 且保存有日期（恢复打标）
  const hasStart = patchHasStart || (patchHasMode && (isCountMode || Boolean(next.startDate)));
  if (hasStart) {
    try {
      const configFile = path.join(next.projectPath, "config.json");
      if (fs.existsSync(configFile)) {
        const cfg = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/u, ""));
        cfg.startDate = effStartDate;
        fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      }
    } catch (err) {
      console.error("sync startDate to config.json failed:", err);
    }
  }
  // 起始日期 + 处理方式合并为单次 configure 调用（避免两次并发 spawn 写 config.json 竞态）：
  // 起始日期 → 恢复旧打标后按新日期重打标（空=清空起始日期，全部收藏重新进入处理）
  // 处理方式 → 按数量 = 锁定"从目前往后数 N 条"快照窗口；按时间 = 清除快照
  if (hasStart || (patch && Object.prototype.hasOwnProperty.call(patch, "processMode"))) {
    try {
      const cwArg = isCountMode && Number(next.countLimit) > 0 ? String(Number(next.countLimit)) : "";
      const args = ["--no-warnings", "src\\cli.mjs", "configure"];
      if (hasStart) args.push("--start-date", effStartDate);
      if (patch && Object.prototype.hasOwnProperty.call(patch, "processMode")) args.push("--count-window", cwArg);
      const child = spawn(next.nodePath, args, {
        cwd: next.projectPath,
        env: envFor(next),
        windowsHide: true,
      });
      child.stdout.on("data", (chunk) => console.log("[configure]", String(chunk).trim()));
      child.stderr.on("data", (chunk) => console.error("[configure]", String(chunk).trim()));
      child.on("error", (err) => console.error("apply configure failed:", String(err.message || err)));
    } catch (err) {
      console.error("apply configure spawn failed:", err);
    }
  }
  // AI 接口配置（Base URL / Key / 模型名）同步写入 CLI config.json，
  // 让定时任务（run-sync.ps1 不注入环境变量）也能读到设置页填写的值
  if (patch && (Object.prototype.hasOwnProperty.call(patch, "llmModel")
    || Object.prototype.hasOwnProperty.call(patch, "llmBaseUrl")
    || Object.prototype.hasOwnProperty.call(patch, "llmApiKey"))) {
    try {
      const configFile = path.join(next.projectPath, "config.json");
      if (fs.existsSync(configFile)) {
        const cfg = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/u, ""));
        if (next.llmModel) cfg.llmModel = String(next.llmModel);
        if (next.llmBaseUrl) cfg.llmBaseUrl = String(next.llmBaseUrl);
        if (next.llmApiKey) cfg.llmApiKey = String(next.llmApiKey);
        fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      }
    } catch (err) {
      console.error("sync llm config to config.json failed:", err);
    }
  }
  // 空闲自动恢复分钟数（0=关闭）同步写入 CLI config.json，让定时任务与手动批处理读取同一设置
  if (patch && Object.prototype.hasOwnProperty.call(patch, "pauseAutoResumeMinutes")) {
    try {
      const configFile = path.join(next.projectPath, "config.json");
      if (fs.existsSync(configFile)) {
        const cfg = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/u, ""));
        cfg.pauseAutoResumeMinutes = Math.max(0, Number(next.pauseAutoResumeMinutes) || 0);
        fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      }
    } catch (err) {
      console.error("sync pauseAutoResumeMinutes to config.json failed:", err);
    }
  }
  // 知识库路径（vaultPath）同步写入 CLI config.json：全新安装时 CLI 需知道笔记写到哪个 Obsidian 库
  if (patch && Object.prototype.hasOwnProperty.call(patch, "vaultPath")) {
    try {
      const configFile = path.join(next.projectPath, "config.json");
      if (fs.existsSync(configFile)) {
        const cfg = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/u, ""));
        cfg.vaultPath = String(next.vaultPath || "");
        fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      } else {
        // 内置运行时首次使用：项目根还没有 config.json，则创建一份（其余字段走 CLI 默认）
        fs.writeFileSync(configFile, JSON.stringify({ vaultPath: String(next.vaultPath || "") }, null, 2) + "\n", "utf8");
      }
    } catch (err) {
      console.error("sync vaultPath to config.json failed:", err);
    }
  }
  return next;
}

function pythonBin(settings) {
  // 优先使用设置里保存的 pythonPath（打包版默认指向内置 venv）；其次 projectPath\.venv；最后回退系统 python
  if (settings && settings.pythonPath && fs.existsSync(settings.pythonPath)) return settings.pythonPath;
  const venv = path.join(settings && settings.projectPath || "", ".venv", "Scripts", "python.exe");
  return fs.existsSync(venv) ? venv : "python";
}

function envFor(settings) {
  return {
    ...process.env,
    DOK_LLM_BASE_URL: settings.llmBaseUrl || "",
    DOK_LLM_API_KEY: settings.llmApiKey || "",
    DOK_LLM_MODEL: settings.llmModel || "",
    PYTHONIOENCODING: "utf-8",
  };
}

let mainWindow = null;

function createWindow() {
  const { screen } = require("electron");
  const area = screen.getPrimaryDisplay().workArea;
  mainWindow = new BrowserWindow({
    width: Math.min(1280, area.width - 40),
    height: Math.min(820, area.height - 60),
    x: area.x + Math.max(0, Math.round((area.width - 1280) / 2)),
    y: area.y + Math.max(0, Math.round((area.height - 820) / 2)),
    minWidth: 980,
    minHeight: 640,
    title: "抖音知识库",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.once("ready-to-show", () => {
    const { screen } = require("electron");
    const a = screen.getPrimaryDisplay().workArea;
    const wx = a.x + Math.max(0, Math.round((a.width - 1280) / 2));
    const wy = a.y + Math.max(0, Math.round((a.height - 820) / 2));
    mainWindow.setPosition(wx, wy);
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

function runCli(settings, args, { onData, onDone, onError } = {}) {
  const child = spawn(settings.nodePath, ["--no-warnings", "src\\cli.mjs", ...args], {
    cwd: settings.projectPath,
    env: envFor(settings),
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => onData && onData(String(chunk)));
  child.stderr.on("data", (chunk) => onData && onData(String(chunk)));
  child.on("error", (err) => onError && onError(String(err.message || err)));
  child.on("close", (code) => onDone && onDone(code));
  return child;
}

function runPython(settings, scriptArgs, { onData, onDone, onError } = {}) {
  const child = spawn(pythonBin(settings), scriptArgs, {
    cwd: settings.projectPath,
    env: envFor(settings),
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => onData && onData(String(chunk)));
  child.stderr.on("data", (chunk) => onData && onData(String(chunk)));
  child.on("error", (err) => onError && onError(String(err.message || err)));
  child.on("close", (code) => onDone && onDone(code));
  return child;
}

function vaultTree(vaultPath) {
  const Knowledge = path.join(vaultPath, "Knowledge");
  const tree = { categories: [], files: {} };
  if (!fs.existsSync(Knowledge)) return tree;
  for (const major of fs.readdirSync(Knowledge, { withFileTypes: true })) {
    if (!major.isDirectory()) continue;
    const cat = { name: major.name, groups: [] };
    const majorDir = path.join(Knowledge, major.name);
    for (const group of fs.readdirSync(majorDir, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const g = { name: group.name, subs: [] };
      const groupDir = path.join(majorDir, group.name);
      for (const sub of fs.readdirSync(groupDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        g.subs.push({ name: sub.name, files: listNotes(path.join(groupDir, sub.name)) });
      }
      g.subs.sort((a, b) => a.name.localeCompare(b.name, "zh"));
      cat.groups.push(g);
    }
    cat.groups.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    tree.categories.push(cat);
  }
  tree.categories.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return tree;
}

function listNotes(dir) {
  const files = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.isFile() && f.name.toLowerCase().endsWith(".md")) {
      files.push(f.name);
    }
  }
  files.sort((a, b) => a.localeCompare(b, "zh"));
  return files;
}

function resolveVaultPath(vaultPath, parts) {
  // parts: [major, group?, sub?, filename]（二级/一级目录兼容）
  let p = vaultPath;
  for (const part of parts) {
    if (!part) break;
    p = path.join(p, part);
  }
  return p;
}

ipcMain.handle("settings:get", () => loadSettings());
ipcMain.handle("settings:save", (_e, patch) => {
  const next = saveSettings(patch || {});
  watchVault(next.vaultPath);
  return next;
});

// AI 接口测试连接：主进程发 GET {base}/models 带 Bearer key，不受 CORS 限制
ipcMain.handle("llm:test", async (_e, settings) => {
  try {
    const base = String(settings.llmBaseUrl || "").trim().replace(/\/+$/, "");
    const key = String(settings.llmApiKey || "").trim();
    if (!base) return { ok: false, message: "还没填 Base URL" };
    if (!key) return { ok: false, message: "还没填 API Key" };
    const url = base + "/models";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: "Bearer " + key },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return { ok: true, message: "连接成功，Key 有效" };
    if (res.status === 401) return { ok: false, message: "Key 无效或过期（401），去官网核对一下" };
    if (res.status === 404) return { ok: false, message: "地址不对（404），检查 Base URL 结尾是不是 /v1" };
    return { ok: false, message: `服务器返回 ${res.status}，稍后重试或换个地址` };
  } catch (err) {
    if (err.name === "AbortError") return { ok: false, message: "连接超时（10 秒），检查网络或地址" };
    return { ok: false, message: "网络不通：" + (err.message || String(err)) };
  }
});

// 分类管理（rename / add / move）：调用知识库 CLI 的 manage-categories.mjs
ipcMain.handle("categories:manage", (_e, settings, args) => new Promise((resolve) => {
  const child = spawn(settings.nodePath, ["--no-warnings", "var\\manage-categories.mjs", ...(Array.isArray(args) ? args : [])], {
    cwd: settings.projectPath,
    env: envFor(settings),
    windowsHide: true,
  });
  let out = "";
  child.stdout.on("data", (c) => { out += String(c); });
  child.stderr.on("data", (c) => { out += String(c); });
  child.on("error", (err) => resolve({ ok: false, error: String(err.message || err) }));
  child.on("close", (code) => {
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const last = lines[lines.length - 1] || "";
    try { resolve(JSON.parse(last)); }
    catch { resolve({ ok: code === 0, error: (out || `exit code ${code}`).slice(-600) }); }
  });
}));

ipcMain.handle("vault:tree", (_e, vaultPath) => vaultTree(vaultPath || loadSettings().vaultPath));
ipcMain.handle("vault:read", (_e, { vaultPath, filePath }) => {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(vaultPath, filePath);
  if (!fs.existsSync(abs)) return { ok: false, error: "file not found" };
  return { ok: true, content: fs.readFileSync(abs, "utf8"), path: abs };
});
ipcMain.handle("vault:openInObsidian", async (_e, vaultPath) => {
  const ok = await shell.openPath(vaultPath || loadSettings().vaultPath);
  return { ok: ok === "" };
});

ipcMain.handle("pipeline:status", async (_e, settings) => {
  return await new Promise((resolve) => {
    runCli(settings, ["status"], {
      onData: () => {},
      onDone: (code) => resolve({ ok: code === 0 }),
      onError: (err) => resolve({ ok: false, error: err }),
    });
  });
});

ipcMain.handle("pipeline:run", (event, settings, args) => {
  return new Promise((resolve) => {
    const child = runCli(settings, args, {
      onData: (chunk) => event.sender.send("pipeline:log", chunk),
      onDone: (code) => resolve({ ok: code === 0, code }),
      onError: (err) => resolve({ ok: false, error: err }),
    });
    event.sender.once("pipeline:cancel", () => {
      try { child.kill(); } catch {}
    });
  });
});

ipcMain.handle("pipeline:login", (event, settings) => {
  return new Promise((resolve) => {
    const child = runPython(settings, ["scripts\\collect-favorites.py", "login"], {
      onData: (chunk) => event.sender.send("pipeline:log", chunk),
      onDone: (code) => resolve({ ok: code === 0, code }),
      onError: (err) => resolve({ ok: false, error: err }),
    });
    event.sender.once("pipeline:cancel", () => {
      try { child.kill(); } catch {}
    });
  });
});

ipcMain.handle("pipeline:authStatus", async (_e, settings) => {
  // 采集器 status 无论登录与否都会输出 JSON（authenticated / login_required）：
  // 必须等进程结束按返回码 + status 字段判断，不能一见 stdout 就判定已登录
  return await new Promise((resolve) => {
    let out = "";
    runPython(settings, ["scripts\\collect-favorites.py", "status"], {
      onData: (chunk) => { out += chunk; },
      onDone: (code) => {
        let status = "";
        try { status = (JSON.parse(out) || {}).status || ""; } catch {}
        resolve({ ok: code === 0 && status === "authenticated", status, raw: out });
      },
      onError: (err) => resolve({ ok: false, error: String(err) }),
    });
  });
});

// ---- 收藏夹列表：跑采集器 folders 子命令，返回收藏夹下拉数据 ----
ipcMain.handle("collects:list", async (_e, settings) => {
  const outputFile = path.join(settings.projectPath, "var", "api-collects.json");
  const run = (resolve) => runPython(settings, ["scripts\\collect-favorites.py", "folders", "--max-items", "100", "--output", outputFile], {
    onData: () => {},
    onDone: (code) => {
      if (code !== 0) return resolve({ ok: false, error: "folders 命令失败（可能未登录抖音，请在设置页扫码登录）" });
      try {
        const payload = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        const items = Array.isArray(payload) ? payload : payload.items || [];
        const folders = items.map((f) => ({
          collects_id: String(f.collects_id || ""),
          name: String(f.name || f.collects_name || "").trim(),
          total: Number(f.total_number || 0),
        })).filter((f) => f.collects_id && f.name);
        resolve({ ok: true, folders });
      } catch (err) {
        resolve({ ok: false, error: String(err && err.message || err) });
      }
    },
    onError: (err) => resolve({ ok: false, error: String(err) }),
  });
  return await new Promise(run);
});

// ---- 一键开始处理收藏：采集（全部收藏 or 指定收藏夹）→ ingest → sync --pending ----
ipcMain.handle("collects:start", (event, settings, payload) => {
  return new Promise((resolve) => {
    const send = (s) => event.sender.send("pipeline:log", s);
    const opts = payload || {};
    const mode = opts.mode || "all"; // all=收藏视频(全部收藏) folder=指定收藏夹
    const collectsId = String(opts.collectsId || "").trim();
    const collectsName = String(opts.collectsName || "").trim();
    const limit = Math.max(1, Number(opts.limit || 0));
    const startDate = String(opts.startDate || "").trim();
    const collectOut = path.join(settings.projectPath, "var",
      mode === "folder" && collectsId ? `api-collection-${collectsId}.json` : "api-collection.json");
    let cancelled = false;
    const onCancel = () => { cancelled = true; };
    event.sender.once("pipeline:cancel", onCancel);
    const cleanup = () => event.sender.removeListener("pipeline:cancel", onCancel);

    const stepCollect = () => new Promise((stepResolve) => {
      const args = ["scripts\\collect-favorites.py", "collect", "--max-items", "3000", "--output", collectOut];
      if (mode === "folder" && collectsId) {
        args.push("--collects-id", collectsId, "--collects-name", collectsName);
      }
      send(`[1/3] 正在采集${mode === "folder" ? `收藏夹「${collectsName}」` : "全部收藏"}…\n`);
      runPython(settings, args, {
        onData: (c) => send(c),
        onDone: (code) => {
          if (cancelled) return stepResolve(false);
          if (code !== 0) return stepResolve(false);
          stepResolve(true);
        },
        onError: (err) => { send(`采集失败：${err}\n`); stepResolve(false); },
      });
    });

    const stepIngest = () => new Promise((stepResolve) => {
      send("[2/3] 导入收藏到知识库…\n");
      const args = ["ingest"];
      if (mode === "folder" && collectsId) args.push("--file", collectOut);
      runCli(settings, args, {
        onData: (c) => send(c),
        onDone: (code) => stepResolve(code === 0),
        onError: (err) => { send(`导入失败：${err}\n`); stepResolve(false); },
      });
    });

    const stepSync = () => new Promise((stepResolve) => {
      send(`[3/3] 开始处理（每次 ${limit} 条以内，断网自动续跑）…\n`);
      const args = ["sync", "--pending", String(limit)];
      if (mode === "folder" && collectsId) args.push("--collects-id", collectsId);
      // 按数量模式：候选锁定在设置时固定的"最近 N 条"快照窗口（后续新收藏不计入）
      if (startDate) args.push("--start-date", startDate);
      else if (mode !== "folder" && settings.processMode === "count" && Number(settings.countLimit) > 0) args.push("--count-window");
      runCli(settings, args, {
        onData: (c) => send(c),
        onDone: (code) => stepResolve(code === 0),
        onError: (err) => { send(`处理失败：${err}\n`); stepResolve(false); },
      });
    });

    (async () => {
      const okCollect = await stepCollect();
      if (cancelled) { cleanup(); return resolve({ ok: false, cancelled: true }); }
      if (!okCollect) { cleanup(); return resolve({ ok: false, error: "采集失败：请确认已登录抖音（设置页扫码），稍后重试" }); }
      const okIngest = await stepIngest();
      if (cancelled) { cleanup(); return resolve({ ok: false, cancelled: true }); }
      if (!okIngest) { cleanup(); return resolve({ ok: false, error: "导入失败，请查看日志" }); }
      const okSync = await stepSync();
      cleanup();
      resolve({ ok: okSync, cancelled: cancelled });
    })();
  });
});

// ---- 新增收藏：核对与补充 ----
ipcMain.handle("newarrivals:list", async (_e, settings, payload) => {
  const { days = 7, limit = 100 } = payload || {};
  return await new Promise((resolve) => {
    let out = "";
    runCli(settings, ["newarrivals", "--days", String(days), "--limit", String(limit)], {
      onData: (chunk) => { out += chunk; },
      onDone: (code) => {
        if (code !== 0) return resolve({ ok: false, error: "newarrivals 命令失败" });
        try { resolve({ ok: true, ...JSON.parse(out) }); }
        catch (err) { resolve({ ok: false, error: String(err) }); }
      },
      onError: (err) => resolve({ ok: false, error: String(err) }),
    });
  });
});

// 手动补充抖音视频链接：add 入库（已存在不动状态）；processNow=true 时对新增/未完成的逐条 sync --aweme-id 立即处理
ipcMain.handle("videos:add", async (_e, settings, payload) => {
  const { urls = [], processNow = false } = payload || {};
  const cleaned = (Array.isArray(urls) ? urls : []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!cleaned.length) return { ok: false, error: "没有可解析的链接" };
  return await new Promise((resolve) => {
    let out = "";
    runCli(settings, ["add", "--url", cleaned.join(" ")], {
      onData: (chunk) => { out += chunk; },
      onDone: async (code) => {
        if (code !== 0) return resolve({ ok: false, error: "add 命令失败" });
        let parsed;
        try { parsed = JSON.parse(out); }
        catch (err) { return resolve({ ok: false, error: String(err) }); }
        const results = parsed.results || [];
        if (!processNow) return resolve({ ok: true, results, counts: parsed.counts });
        // 立即处理：只对新增或仍未完成的条目跑 sync --aweme-id（已 written/skipped 跳过）
        const toProcess = results.filter((r) => r.ok && r.status !== "written" && r.status !== "skipped" && r.status !== "media_frozen").map((r) => r.aweme_id);
        const processed = [];
        for (const id of toProcess) {
          const one = await new Promise((res2) => {
            let o2 = "";
            runCli(settings, ["sync", "--aweme-id", String(id)], {
              onData: (c) => { o2 += c; },
              onDone: (c2) => res2({ code: c2, out: o2 }),
              onError: (e2) => res2({ code: -1, error: String(e2) }),
            });
          });
          processed.push({ aweme_id: id, code: one.code, error: one.error || "" });
        }
        resolve({ ok: true, results, processed, counts: parsed.counts });
      },
      onError: (err) => resolve({ ok: false, error: String(err) }),
    });
  });
});

// ---- 暂停 / 继续 / 清理临时媒体 ----
function runCliJson(settings, args) {
  return new Promise((resolve) => {
    let out = "";
    runCli(settings, args, {
      onData: (chunk) => { out += chunk; },
      onDone: (code) => {
        if (code !== 0) return resolve({ ok: false, error: "CLI 命令失败（code " + code + "）", code });
        try { resolve({ ok: true, ...JSON.parse(out) }); }
        catch (err) { resolve({ ok: false, error: String(err), code }); }
      },
      onError: (err) => resolve({ ok: false, error: String(err), code: -1 }),
    });
  });
}
ipcMain.handle("sync:pause", async (_e, settings) => runCliJson(settings, ["pause"]));
ipcMain.handle("sync:resume", async (_e, settings) => runCliJson(settings, ["resume"]));
ipcMain.handle("sync:pause-status", async (_e, settings) => {
  // 返回暂停状态 + 是否有 sync 进程在运行（读 var\sync.lock 判断）
  const stateDir = path.join(settings.projectPath, "var");
  const paused = fs.existsSync(path.join(stateDir, "pause.flag"));
  let running = false;
  try {
    const lockFile = path.join(stateDir, "sync.lock");
    if (fs.existsSync(lockFile)) {
      const lk = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      try { process.kill(Number(lk.pid), 0); running = true; } catch {}
    }
  } catch {}
  return { ok: true, paused, running, pauseAutoResumeMinutes: Number(settings.pauseAutoResumeMinutes || 0) };
});
ipcMain.handle("cleanup:media", async (_e, settings) => runCliJson(settings, ["cleanup"]));
// ---- 一键复位：进度条卡死/残留锁时界面按钮直接调用（pid 仍存活则拒绝，避免误杀正在跑的同步）----
ipcMain.handle("sync:reset-stuck", async () => {
  const fs = require("fs");
  const path = require("path");
  try {
    const proj = loadSettings().projectPath;
    const lockFile = path.join(proj, "var", "sync.lock");
    const progressFile = path.join(proj, "var", "sync-progress.json");
    if (fs.existsSync(lockFile)) {
      let pid = 0;
      try { pid = JSON.parse(fs.readFileSync(lockFile, "utf8")).pid || 0; } catch {}
      if (pid) {
        try { process.kill(pid, 0); return { ok: false, reason: "running", msg: `同步进程（PID ${pid}）似乎仍在运行，无需复位，请等它跑完` }; }
        catch {}
      }
      fs.unlinkSync(lockFile);
    }
    fs.writeFileSync(progressFile, JSON.stringify({ running: false, done: 0, total: 0, percent: 0, updatedAt: new Date().toISOString(), stage: "" }, null, 2), "utf8");
    const logFile = path.join(proj, "var", "logs", "scheduler.log");
    try { fs.appendFileSync(logFile, new Date().toISOString() + " STUCK-RESET user-click: lock cleared, progress reset\n", "utf8"); } catch {}
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

// ---- 总览统计：解析 CLI status JSON ----
ipcMain.handle("stats:overview", async (_e, settings) => {
  return await new Promise((resolve) => {
    let out = "";
    // 按数量模式：进度 = 设置时固定的"最近 N 条"快照窗口（CLI status --count-window，后续新收藏不计入）
    const isCountMode = settings.processMode === "count" && Number(settings.countLimit) > 0;
    const args = isCountMode
      ? ["status", "--count-window"]
      : ["status", ...(settings.startDate ? ["--since-date", String(settings.startDate)] : [])];
    runCli(settings, args, {
      onData: (chunk) => { out += chunk; },
      onDone: (code) => {
        if (code !== 0) return resolve({ ok: false, error: "status 命令失败" });
        try {
          const data = JSON.parse(out);
          const counts = {};
          const raw = data.counts || [];
          if (Array.isArray(raw)) { for (const c of raw) counts[c.status] = c.count || 0; }
          else { Object.assign(counts, raw); }
          // 窗口内待处理：discovered + 各中间态 + failed（可重试项）
          const remaining = (counts.discovered || 0) + (counts.media_frozen || 0) + (counts.transcribed || 0) + (counts.extracted || 0) + (counts.failed || 0);
          const done = (counts.written || 0) + (counts.skipped || 0);
          resolve({
            ok: true,
            counts,
            total: done + remaining,
            remaining,
            done,
            windowStart: settings.startDate || "",
            countMode: isCountMode,
            countLimit: isCountMode ? Number(settings.countLimit) : 0,
            windowInfo: data.windowInfo || null,
          });
        } catch (err) {
          resolve({ ok: false, error: String(err) });
        }
      },
      onError: (err) => resolve({ ok: false, error: String(err) }),
    });
  });
});

// ---- 知识卡片（按大分类 AI 提取，印证观点优先） ----
ipcMain.handle("cards:list", async (_e, settings) => {
  return await new Promise((resolve) => {
    let out = "";
    runCli(settings, ["knowledge-card", "--list"], {
      onData: (chunk) => { out += chunk; },
      onDone: (code) => {
        if (code !== 0) return resolve({ ok: false, error: "knowledge-card --list 失败" });
        try {
          resolve({ ok: true, cards: JSON.parse(out.replace(/^\uFEFF/u, "")) });
        } catch (err) {
          resolve({ ok: false, error: String(err) });
        }
      },
      onError: (err) => resolve({ ok: false, error: String(err) }),
    });
  });
});

ipcMain.handle("cards:read", async (_e, settings, major) => {
  return await new Promise((resolve) => {
    let out = "";
    runCli(settings, ["knowledge-card", "--read", "--major", String(major || "")], {
      onData: (chunk) => { out += chunk; },
      onDone: (code) => {
        if (code !== 0) return resolve({ ok: false, error: "knowledge-card --read 失败" });
        try {
          resolve({ ok: true, ...JSON.parse(out.replace(/^\uFEFF/u, "")) });
        } catch (err) {
          resolve({ ok: false, error: String(err) });
        }
      },
      onError: (err) => resolve({ ok: false, error: String(err) }),
    });
  });
});

// 删除某大分类的知识卡片文件（与 CLI safeName 命名规则保持一致）
function cardSafeName(value) {
  return String(value || "").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "").trim().slice(0, 40) || "未分类";
}
ipcMain.handle("cards:delete", async (_e, settings, major) => {
  try {
    const projectPath = settings.projectPath || DEFAULT_SETTINGS.projectPath;
    const file = path.join(projectPath, "var", "knowledge-cards", `${cardSafeName(major)}.json`);
    if (!fs.existsSync(file)) return { ok: false, error: "卡片文件不存在，可能尚未生成" };
    fs.unlinkSync(file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// 生成/刷新某大分类知识卡片（走 DeepSeek，会消耗 token）；onLog 通过 pipeline:log 回流进度
ipcMain.handle("cards:generate", (event, settings, major) => new Promise((resolve) => {
  let out = "";
  const child = runCli(settings, ["knowledge-card", "--major", String(major || ""), "--min-videos", String(settings.cardMinVideos || 50)], {
    onData: (chunk) => {
      out += chunk;
      event.sender.send("pipeline:log", chunk);
    },
    onDone: (code) => {
      if (code !== 0) return resolve({ ok: false, error: "knowledge-card 生成失败", raw: out.slice(-2000) });
      try {
        resolve({ ok: true, ...JSON.parse(out.replace(/^\uFEFF/u, "")) });
      } catch (err) {
        resolve({ ok: false, error: String(err), raw: out.slice(-2000) });
      }
    },
    onError: (err) => resolve({ ok: false, error: String(err) }),
  });
  event.sender.once("pipeline:cancel", () => { try { child.kill(); } catch {} });
}));

// ---- 定时任务：查询状态（任务信息 + 处理进度 + 锁 + 最近日志） ----
function runPowerShell(script, { onDone, onError } = {}) {
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  let out = "", errOut = "";
  child.stdout.on("data", (c) => (out += String(c)));
  child.stderr.on("data", (c) => (errOut += String(c)));
  child.on("error", (err) => onError && onError(String(err.message || err)));
  child.on("close", (code) => onDone && onDone(code, out, errOut));
  return child;
}

const SCHED_TASK_NAME = "Douyin Obsidian Knowledge";

ipcMain.handle("schedule:status", async (_e, settings) => {
  // 1) 任务计划程序状态
  const taskInfo = await new Promise((resolve) => {
    const script = `
$t = Get-ScheduledTask -TaskName '${SCHED_TASK_NAME}' -ErrorAction SilentlyContinue
if (-not $t) { Write-Output '{"exists":false}'; exit 0 }
$i = $t | Get-ScheduledTaskInfo
$tr = $t.Triggers | Select-Object -First 1
$o = [pscustomobject]@{
  exists = $true
  state = $t.State.ToString()
  enabled = if ($t.State.ToString() -eq 'Ready') { $true } else { $false }
  lastRun = if ($i.LastRunTime -and $i.LastRunTime -ne [datetime]::MinValue) { $i.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
  lastResult = [int]$i.LastTaskResult
  nextRun = if ($i.NextRunTime -and $i.NextRunTime -ne [datetime]::MinValue) { $i.NextRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
  startBoundary = [string]$tr.StartBoundary
}
$o | ConvertTo-Json -Compress`;
    runPowerShell(script, {
      onDone: (_code, out, errOut) => {
        try {
          const idx = out.indexOf("{");
          if (idx === -1) return resolve({ ok: false, error: errOut.trim() || "查询任务失败" });
          resolve({ ok: true, task: JSON.parse(out.slice(idx)) });
        } catch (e) { resolve({ ok: false, error: String(e) }); }
      },
      onError: (err) => resolve({ ok: false, error: err }),
    });
  });

  // 2) 处理进度（复用 status 计数；设了起始日期则按该日之后【新增收藏/首次采集】的视频窗口统计，即 discovered_at 口径）
  const sinceArg = settings.startDate ? ["--since-date", String(settings.startDate)] : [];
  let dailyWindow = null;
  const counts = await new Promise((resolve) => {
    let out = "";
    runCli(settings, ["status", ...sinceArg], {
      onData: (chunk) => { out += chunk; },
      onDone: (code) => {
        if (code !== 0) return resolve(null);
        try {
          const data = JSON.parse(out);
          const c = {};
          const raw = data.counts || [];
          if (Array.isArray(raw)) { for (const x of raw) c[x.status] = x.count || 0; }
          else { Object.assign(c, raw); }
          dailyWindow = data.dailyWindow || null; // 全库模式下：每日任务今日候选（昨日新增+失败重试）
          resolve(c);
        } catch { resolve(null); }
      },
      onError: () => resolve(null),
    });
  });

  // 3) 本次运行实时进度（var\sync-progress.json，由 run-sync.ps1 / CLI sync --progress-file 写入）
  let progress = null;
  try {
    const pf = path.join(settings.projectPath, "var", "sync-progress.json");
    if (fs.existsSync(pf)) {
      progress = JSON.parse(fs.readFileSync(pf, "utf8"));
    }
  } catch { /* ignore */ }

  // 4) 同步锁
  let lock = null;
  try {
    const lockFile = path.join(settings.projectPath, "var", "sync.lock");
    if (fs.existsSync(lockFile)) {
      const raw = fs.readFileSync(lockFile, "utf8").trim();
      lock = { raw, mtime: fs.statSync(lockFile).mtime.toISOString() };
    }
  } catch { /* ignore */ }

  // 5) scheduler.log 尾部 + AI 诊断结论（run-sync.ps1 失败时写入 "AI-DIAGNOSIS: 1)原因 | 2)严重 | 3)建议"）
  let logTail = "";
  let aiDiagnosis = "";
  let diagFailed = false;
  let selfHeal = []; // 脚本自动修复动作（清残留锁/失败自动重试），供界面提示用户
  try {
    const logFile = path.join(settings.projectPath, "var", "logs", "scheduler.log");
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, "utf8");
      const lines = content.split(/\r?\n/).filter((l) => l.trim());
      logTail = lines.slice(-12).join("\n");
      const healLines = lines.filter((l) => /RETRY-1|STALE-LOCK-CLEARED/.test(l));
      selfHeal = healLines.slice(-4).map((l) => l.replace(/^.*?(RETRY-1|STALE-LOCK-CLEARED)/, "$1").slice(0, 140));
      const diagLines = lines.filter((l) => /AI-DIAGNOSIS/.test(l));
      if (diagLines.length) {
        const last = diagLines[diagLines.length - 1];
        if (/AI-DIAGNOSIS FAILED/.test(last)) {
          diagFailed = true;
          aiDiagnosis = "AI 诊断调用失败（可能未配置 API Key）";
        } else {
          aiDiagnosis = last.replace(/^.*?AI-DIAGNOSIS:\s*/, "").trim();
        }
      }
    }
  } catch { /* ignore */ }

  return { ok: true, ...taskInfo, counts, progress, lock, logTail, windowStart: settings.startDate || "", dailyWindow, aiDiagnosis, diagFailed, selfHeal };
});

// ---- 定时任务：设置时间 / 启停（不存在时自动创建） ----
ipcMain.handle("schedule:set", (_e, payload) => {
  return new Promise((resolve) => {
    const { time, enable } = payload || {};
    const hasTime = !!(time && /^\d{1,2}:\d{2}$/.test(time));
    // 计划任务指向项目内 run-sync.ps1（打包版自动指向内置 runtime/project/scripts）
    const st = loadSettings();
    const syncPs1 = path.join(st.projectPath || "", "scripts", "run-sync.ps1").replace(/\\/g, "\\\\");
    const script = `
$tn = '${SCHED_TASK_NAME}'
$exists = Get-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue
if (${hasTime ? "$true" : "$false"}) {
  $at = Get-Date '${time}'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${syncPs1}"'
  $trigger = New-ScheduledTaskTrigger -Daily -At $at
  if (-not $exists) {
    Register-ScheduledTask -TaskName $tn -Action $action -Trigger $trigger -Description 'douyin knowledge daily sync' -Force | Out-Null
  } else {
    Set-ScheduledTask -TaskName $tn -Action $action -Trigger $trigger | Out-Null
  }
}
if (${enable === true ? "$true" : "$false"}) { Enable-ScheduledTask -TaskName $tn | Out-Null }
if (${enable === false ? "$true" : "$false"}) { Disable-ScheduledTask -TaskName $tn | Out-Null }
if ($?) { Write-Output '{"ok":true}' } else { Write-Output '{"ok":false,"error":"update failed"}' }`;
    runPowerShell(script, {
      onDone: (code, out, errOut) => {
        try {
          const idx = out.indexOf("{");
          if (idx === -1) {
            const msg = (errOut || "").trim() || ("设置失败 rc=" + code);
            return resolve({ ok: false, error: msg.slice(0, 200) });
          }
          const parsed = JSON.parse(out.slice(idx).replace(/[^\x00-\x7F]/g, (m) => "?"));
          resolve(parsed);
        } catch (e) { resolve({ ok: false, error: String(e) }); }
      },
      onError: (err) => resolve({ ok: false, error: err }),
    });
  });
});

// ---- 每周知识周报：统计本周（本周一起）新增笔记（按大类）+ 知识卡片，仅保留当前一周数据 ----
ipcMain.handle("weekly:stats", async (_e, settings) => {
  try {
    const vault = settings.vaultPath || DEFAULT_SETTINGS.vaultPath;
    const Knowledge = path.join(vault, "Knowledge");
    const today = new Date();
    const weekStart = new Date(today);
    const dow = today.getDay();
    weekStart.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1)); // 本周一
    weekStart.setHours(0, 0, 0, 0);
    const weekStartMs = weekStart.getTime(); // 自然周窗口：本周一 0 点起，下周自动替换为新周
    const lastWeekStartMs = weekStartMs - 7 * 86400000; // 上周一 0 点，用于环比
    const byCat = new Map();
    const lastCat = new Map();
    let totalNotes = 0;
    let weekNewNotes = 0;
    let lastWeekNewNotes = 0;
    const weekNewTitles = [];
    let weekTopNote = null; // 本周最长笔记（值得回看）
    const walk = (dir, major) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, major); continue; }
        if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
        totalNotes++;
        try {
          const m = fs.statSync(p).mtimeMs;
          if (m >= weekStartMs) {
            weekNewNotes++;
            byCat.set(major, (byCat.get(major) || 0) + 1);
            const title = e.name.replace(/\.md$/i, "").trim();
            weekNewTitles.push(title);
            const size = fs.statSync(p).size;
            if (!weekTopNote || size > weekTopNote.size) weekTopNote = { title, absPath: p, size };
          } else if (m >= lastWeekStartMs) {
            lastWeekNewNotes++;
            lastCat.set(major, (lastCat.get(major) || 0) + 1);
          }
        } catch { /* ignore */ }
      }
    };
    if (fs.existsSync(Knowledge)) {
      for (const major of fs.readdirSync(Knowledge, { withFileTypes: true })) {
        if (!major.isDirectory()) continue;
        walk(path.join(Knowledge, major.name), major.name);
      }
    }
    // 知识卡片（CLI var/knowledge-cards/*.json）
    let weekNewCards = 0;
    let lastWeekNewCards = 0;
    let totalCards = 0;
    const cardDir = path.join(settings.projectPath || DEFAULT_SETTINGS.projectPath, "var", "knowledge-cards");
    if (fs.existsSync(cardDir)) {
      for (const f of fs.readdirSync(cardDir)) {
        if (!f.toLowerCase().endsWith(".json")) continue;
        totalCards++;
        try {
          const m = fs.statSync(path.join(cardDir, f)).mtimeMs;
          if (m >= weekStartMs) weekNewCards++;
          else if (m >= lastWeekStartMs) lastWeekNewCards++;
        } catch { /* ignore */ }
      }
    }
    const byCategory = Array.from(byCat.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    const lastByCategory = Array.from(lastCat.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    // 本周 API 消耗（仅本软件发起的调用，桌面端直调 + CLI 侧知识提取/共识印证）
    const au = (loadSettings().apiUsage || {});
    let desktopTokens = 0, desktopCalls = 0;
    if (au.weekKey === weekKeyOf(today)) { desktopTokens = au.tokens || 0; desktopCalls = au.calls || 0; }
    let cliTokens = 0, cliCalls = 0;
    const cliFile = path.join(settings.projectPath || DEFAULT_SETTINGS.projectPath, "var", "api-usage.jsonl");
    if (fs.existsSync(cliFile)) {
      try {
        for (const line of fs.readFileSync(cliFile, "utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          const row = JSON.parse(line);
          if (row && Number(row.ts) >= weekStartMs) { cliTokens += Number(row.tokens) || 0; cliCalls++; }
        }
      } catch { /* ignore */ }
    }
    return {
      ok: true,
      weekNewNotes,
      lastWeekNewNotes,
      totalNotes,
      weekNewCards,
      lastWeekNewCards,
      totalCards,
      byCategory,
      lastByCategory,
      weekNewTitles,
      weekTopNote,
      weekStart: fmt(weekStart),
      weekEnd: fmt(today),
      apiUsage: { tokens: desktopTokens + cliTokens, calls: desktopCalls + cliCalls },
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---- 每周知识周报确认：记录本次已弹，维护连续坚持周数（游戏成就） ----
ipcMain.handle("weekly:ack", (_e, { dateKey, hasNew }) => {
  const st = loadSettings();
  const wr = st.weeklyReport || {};
  const last = wr.lastShownDate || "";
  let streak = Number(wr.streak || 0);
  if (hasNew) {
    if (last) {
      const diffDays = Math.round((Date.parse(dateKey) - Date.parse(last)) / 86400000);
      streak = diffDays === 7 ? streak + 1 : 1;
    } else {
      streak = 1;
    }
  }
  const next = {
    enabled: wr.enabled !== false,
    weekday: wr.weekday || 2,
    lastShownDate: dateKey,
    streak,
    bestStreak: Math.max(Number(wr.bestStreak || 0), streak),
    totalShown: Number(wr.totalShown || 0) + 1,
  };
  saveSettings({ weeklyReport: next });
  return next;
});

// ---- 止损看板：失败清单文件列表 ----
ipcMain.handle("failures:list", (_e, settings) => {
  const roots = [path.join(settings.projectPath, "var"), settings.projectPath];
  const seen = new Set();
  const out = [];
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/^失败视频清单-\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
      const full = path.join(dir, f);
      if (seen.has(f)) continue;
      seen.add(f);
      try {
        out.push({ name: f, mtime: fs.statSync(full).mtime.toISOString(), content: fs.readFileSync(full, "utf8") });
      } catch { /* ignore */ }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name) * -1);
  return { ok: true, files: out };
});

// ---- 全文搜索 ----
ipcMain.handle("vault:search", (_e, { vaultPath, query }) => {
  const root = path.join(vaultPath, "Knowledge");
  const results = [];
  if (!query || !fs.existsSync(root)) return { results };
  const q = query.toLowerCase();
  const qEsc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) {
        walk(full);
        continue;
      }
      if (!f.name.toLowerCase().endsWith(".md")) continue;
      const content = fs.readFileSync(full, "utf8");
      const lower = content.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 70);
      const snippet = content.slice(start, idx + q.length + 90).replace(/\s*\n+\s*/g, " ");
      results.push({
        title: f.name.replace(/\.md$/i, ""),
        path: full,
        snippet,
        count: (lower.match(new RegExp(qEsc, "g")) || []).length,
      });
      if (results.length >= 60) return;
    }
  };
  walk(root);
  return { results };
});

// ---- 保存笔记（应用内编辑） ----
ipcMain.handle("vault:write", (_e, { path: p, content }) => {
  try {
    if (!fs.existsSync(p)) return { ok: false, error: "文件不存在" };
    fs.writeFileSync(p, content, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ---- 图谱数据：解析全部笔记双链 ----
ipcMain.handle("vault:graph", (_e, vaultPath) => {
  const root = path.join(vaultPath, "Knowledge");
  const nodes = [];
  const edges = [];
  const index = new Map();
  if (!fs.existsSync(root)) return { nodes, edges };
  const walk = (dir, parts) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) {
        walk(full, parts.concat(f.name));
        continue;
      }
      if (!f.name.toLowerCase().endsWith(".md")) continue;
      const title = f.name.replace(/\.md$/i, "");
      const id = `${parts.join("/")}::${title}`;
      index.set(title, id);
      nodes.push({ id, title, path: full, group: parts[0] || "" });
    }
  };
  walk(root, []);
  // 提取双链（指向知识库内笔记）
  for (const n of nodes) {
    const content = fs.readFileSync(n.path, "utf8");
    const links = new Set();
    const re = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const target = m[1].trim();
      if (index.has(target)) links.add(index.get(target));
    }
    for (const t of links) {
      if (t !== n.id) edges.push({ source: n.id, target: t });
    }
  }
  return { nodes, edges };
});

// ---- 知识库文件监听：图谱实时更新（笔记新增/修改/删除时通知渲染进程） ----
let vaultWatchers = [];
let vaultWatchDebounce = null;
function watchVault(vaultPath) {
  clearVaultWatchers();
  const root = path.join(vaultPath, "Knowledge");
  if (!fs.existsSync(root)) return;
  const dirs = [root];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) { dirs.push(path.join(d, f.name)); walk(path.join(d, f.name)); }
    }
  };
  try { walk(root); } catch (e) { return; }
  const notify = () => {
    if (vaultWatchDebounce) clearTimeout(vaultWatchDebounce);
    vaultWatchDebounce = setTimeout(() => {
      vaultWatchDebounce = null;
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send("vault:changed");
    }, 800);
  };
  for (const d of dirs) {
    try {
      const watcher = fs.watch(d, { persistent: true }, notify);
      watcher.on("error", () => {});
      vaultWatchers.push(watcher);
    } catch (e) { /* 个别目录监听失败忽略 */ }
  }
}
function clearVaultWatchers() {
  if (vaultWatchDebounce) { clearTimeout(vaultWatchDebounce); vaultWatchDebounce = null; }
  for (const w of vaultWatchers) { try { w.close(); } catch (e) {} }
  vaultWatchers = [];
}

// ---- 蒸馏：token 预估 ----
function distillInputFor(settings, major, group, sub) {
  const dir = path.join(settings.vaultPath, "Knowledge", major, group, sub);
  if (!fs.existsSync(dir)) return null;
  const parts = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.isFile() && f.name.toLowerCase().endsWith(".md")) {
      parts.push({ name: f.name, content: fs.readFileSync(path.join(dir, f.name), "utf8") });
    }
  }
  const text = parts.map((p) => `# ${p.name}\n\n${p.content}`).join("\n\n---\n\n");
  return { parts, text };
}

ipcMain.handle("distill:estimate", (_e, settings, sel) => {
  const input = distillInputFor(settings, sel.major, sel.group, sel.sub);
  if (!input) return { ok: false, error: "子类目录不存在或为空" };
  const chars = input.text.length;
  return { ok: true, files: input.parts.length, chars, estTokens: Math.ceil(chars * 0.75), text: input.text };
});

ipcMain.handle("distill:run", async (event, settings, sel) => {
  const input = distillInputFor(settings, sel.major, sel.group, sel.sub);
  if (!input) return { ok: false, error: "子类目录不存在或为空" };
  const send = (s) => event.sender.send("pipeline:log", s);
  try {
    send(`仓颉蒸馏开始（RIA-TV++ 七阶段）：${input.parts.length} 篇笔记，合并约 ${Math.ceil(input.text.length * 0.75)} tokens，全程约 10-16 次 AI 调用。\n`);
    const res = await runCangjieDistill(settings, sel, send);
    send(`蒸馏完成。技能包：${res.path}\n`);
    return { ok: true, path: res.path, root: res.root, content: res.content };
  } catch (err) {
    send(`蒸馏失败：${String(err && err.message || err)}\n`);
    return { ok: false, error: String(err && err.message || err) };
  }
});

function slugify(s) {
  return String(s || "skill").replace(/[\\/:*?"<>|\s#]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

// ---- 列出已蒸馏的技能（兼容仓颉产物 dist/<skill>/SKILL.md 与旧版根 SKILL.md） ----
ipcMain.handle("distill:list", (_e, settings) => {
  const root = settings.distillOutputDir || DEFAULT_SETTINGS.distillOutputDir;
  const list = [];
  if (!root || !fs.existsSync(root)) return { ok: true, list };
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || !d.name.startsWith("douyin-distill-")) continue;
    const dir = path.join(root, d.name);
    // 仓颉编译产物：dist/ 下递归找 SKILL.md
    const distDir = path.join(dir, "dist");
    let skillFile = path.join(dir, "SKILL.md");
    if (fs.existsSync(distDir)) {
      const found = [];
      const walk = (p, depth) => {
        if (found.length || depth > 3) return;
        for (const f of fs.readdirSync(p, { withFileTypes: true })) {
          const full = path.join(p, f.name);
          if (f.isDirectory()) walk(full, depth + 1);
          else if (f.isFile() && f.name.toLowerCase() === "skill.md") { found.push(full); return; }
        }
      };
      walk(distDir, 0);
      if (found.length) skillFile = found[0];
    }
    if (!fs.existsSync(skillFile)) continue;
    const content = fs.readFileSync(skillFile, "utf8");
    const descMatch = content.match(/description:\s*(.+)/);
    const desc = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : d.name;
    list.push({ name: d.name, path: skillFile, description: desc, engine: fs.existsSync(path.join(dir, "PIPELINE_STATE.md")) ? "cangjie" : "legacy" });
  }
  return { ok: true, list };
});

// 删除蒸馏技能（仅允许删除 douyin-distill-* 目录，避免误删其他内容）
ipcMain.handle("distill:delete", (_e, settings, name) => {
  try {
    const root = settings.distillOutputDir || DEFAULT_SETTINGS.distillOutputDir;
    const safe = String(name || "").trim();
    if (!safe || !safe.startsWith("douyin-distill-")) return { ok: false, error: "非法技能目录名" };
    const dir = path.join(root, safe);
    if (!dir.startsWith(path.resolve(root))) return { ok: false, error: "非法路径" };
    if (!fs.existsSync(dir)) return { ok: false, error: "技能目录不存在" };
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ---- 基于蒸馏技能向 AI 提问 ----
ipcMain.handle("chat:ask", async (_e, settings, payload) => {
  try {
    if (!payload || !payload.skillPath || !payload.question) return { ok: false, error: "缺少技能或问题" };
    const skillText = fs.readFileSync(payload.skillPath, "utf8");
    const envBase = process.env.DOK_LLM_BASE_URL || "";
    const envKey = process.env.DOK_LLM_API_KEY || "";
    const base = (settings.llmBaseUrl || envBase).replace(/\/+$/, "");
    const apiKey = settings.llmApiKey || envKey;
    if (!base || !apiKey) return { ok: false, error: "未配置 AI API Key（可在设置页填写，或使用环境变量 DOK_LLM_API_KEY）" };
    const system = `你是基于专属知识技能的 AI 助手。以下是你的知识技能（SKILL.md 全文），请严格基于其中的知识回答用户问题；技能没有覆盖的问题，先说明"该问题超出当前技能范围"，再结合通用知识简要回答。回答用中文，简洁、要点式。\n\n--- 技能内容开始 ---\n${skillText}\n--- 技能内容结束 ---`;
    const messages = [{ role: "system", content: system }];
    for (const m of (payload.history || []).slice(-12)) {
      if (m && (m.role === "user" || m.role === "assistant") && m.content) messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: "user", content: payload.question });
    const model = settings.llmModel || "deepseek-chat";
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.5 }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, error: friendlyAIError(resp.status, body) };
    }
    const data = await resp.json();
    recordApiUsage(data);
    const answer = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    if (!answer) return { ok: false, error: "AI 返回为空" };
    return { ok: true, answer };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

function friendlyAIError(status, bodyText) {
  const t = String(bodyText || "").toLowerCase();
  if (status === 402 || status === 429 || /insufficient\s*_?\s*balance|insufficient\s*_?\s*quota|余额不足|no balance|payment required/.test(t)) {
    return "API Key 余额不足，请充值后重试";
  }
  return `AI 接口调用失败 ${status}: ${String(bodyText || "").slice(0, 200)}`;
}

// ---- 本软件 API 消耗统计：每次 AI 调用成功后按 usage 累加（仅统计本软件发起的调用，按自然周） ----
function weekKeyOf(date) {
  const d = new Date(date);
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
function recordApiUsage(respJson) {
  try {
    const usage = respJson && respJson.usage;
    const tokens = Number(usage && usage.total_tokens) || 0;
    if (!tokens) return;
    const key = weekKeyOf(new Date());
    const cur = loadSettings();
    const au = cur.apiUsage || {};
    if (au.weekKey !== key) { au.weekKey = key; au.tokens = 0; au.calls = 0; }
    au.tokens += tokens;
    au.calls += 1;
    saveSettings({ apiUsage: au });
  } catch { /* 统计失败不影响主流程 */ }
}

app.whenReady().then(() => {
  createWindow();
  watchVault(loadSettings().vaultPath);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
