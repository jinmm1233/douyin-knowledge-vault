const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFile } = require("child_process");
const { runCangjieDistill } = require("./cangjie-runner");
const { autoUpdater } = require("electron-updater");

const APP_DIR = path.join(os.homedir(), ".douyin-knowledge-app");
const SETTINGS_FILE = path.join(APP_DIR, "settings.json");

// 打包版（app.isPackaged）运行时全部内置在 resources/dok-runtime：node / python venv / whisper 模型 / 仓颉技能 / 采集项目
// 开发版保持原开发机默认路径；全新用户（无 settings.json）自动拿到内置路径，实现开箱即用
function bundledRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, "dok-runtime") : "";
}
const BUNDLED = bundledRoot();

const DEFAULT_SETTINGS = {
  projectPath: BUNDLED ? path.join(BUNDLED, "project") : "C:\\Users\\86159\\douyin-obsidian-knowledge",
  vaultPath: BUNDLED ? "" : "D:\\知识库\\Douyin Knowledge",
  nodePath: BUNDLED ? path.join(BUNDLED, "node", "node.exe") : "C:\\Users\\86159\\AppData\\Local\\Programs\\nodejs\\node-v22.23.1-win-x64\\node.exe",
  llmBaseUrl: "https://api.deepseek.com/v1",
  llmApiKey: "",
  llmModel: "deepseek-chat",
  whisperModel: "Systran/faster-whisper-small",
  startDate: "",
  startDateAcknowledged: false,
  processMode: "time", // time=按起始日期之后的新增收藏；count=按数量快照（从目前往后数 N 条，后续新收藏不计入）
  countLimit: 100,
  pauseAutoResumeMinutes: 0, // 暂停后系统空闲超过该分钟数自动恢复（0=关闭，只手动恢复）
  distillOutputDir: BUNDLED ? path.join(os.homedir(), "douyin-distill") : "C:\\Users\\86159\\AppData\\Local\\Doubao\\User Data\\Default\\.doubao\\agent_mode\\workspace\\.user_skills",
  cangjiePath: BUNDLED ? path.join(BUNDLED, "cangjie") : "C:\\Users\\86159\\cangjie-skill\\cangjie-skill-main",
  pythonPath: BUNDLED ? path.join(BUNDLED, "project", ".venv", "Scripts", "python.exe") : "C:\\Users\\86159\\douyin-obsidian-knowledge\\.venv\\Scripts\\python.exe",
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
  // 会员/字体设置：全新安装时也要有兜底对象，否则渲染层读 settings.vip.font 会抛错
  vip: { active: false, code: "", font: "default", ticket: "" },
  // 登录浏览器策略：auto=内置优先、失败自动回退本机；builtin=只用内置 Chromium；system=只用本机 Chrome/Edge
  browserMode: "auto",
  // 上次成功登录用的是哪个浏览器：登录态按浏览器分开保存，自动回退到别的浏览器时需要提示用户重新扫码
  lastLoginBrowser: "",
  lastLoginBrowserLabel: "",
  // 浏览器代理：system=跟随系统代理；direct=绕过系统代理（专治 ERR_PROXY_CONNECTION_FAILED）
  browserProxy: "system",
  // 转录模型下载源：mirror=国内镜像 hf-mirror.com；official=HuggingFace 官方
  modelEndpoint: "mirror",
  // 软件更新：GitHub 仓库 owner/repo（如 eason/douyin-knowledge-app），或 generic 直链目录（含 latest.yml）
  updateRepo: "jinmm1233/douyin-knowledge-vault",
  updateFeedUrl: "",
  updateAutoCheck: true,
};

// 与 renderer/index.html 的 skip-cat 选项、workflow.mjs 的 typeMap 一一对应
const SKIP_TYPE_KEYS = ["shortdrama", "ad", "music", "dance", "funny", "mukbang", "silent-no-info"];
function sanitizeSkipCategories(value) {
  if (!Array.isArray(value)) return [];
  return SKIP_TYPE_KEYS.filter((key) => value.includes(key));
}

function loadSettings() {
  let s;
  try {
    s = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    s = { ...DEFAULT_SETTINGS };
  }
  // 打包版：强制覆盖运行时路径为内置目录，避免旧 settings.json 指向已卸载的旧安装路径
  if (BUNDLED) {
    s.projectPath = path.join(BUNDLED, "project");
    s.nodePath = path.join(BUNDLED, "node", "node.exe");
  }
  // 旧版 settings.json 里 updateRepo 是空串，会覆盖掉新默认值，这里补回来；
  // 用户若自己填了直链目录（updateFeedUrl）则尊重之，不塞默认仓库。
  if (!String(s.updateRepo || "").trim() && !String(s.updateFeedUrl || "").trim()) {
    s.updateRepo = DEFAULT_SETTINGS.updateRepo;
  }
  return s;
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
      // 全新安装时项目里没有 config.json（安装包已排除，避免把开发者的 Key 一起发出去）。
      // 旧逻辑这里要求文件已存在，于是"先填 Key、后选库"的新用户永远写不进去，
      // 引擎侧没 Key 就静默降级成本地规则提炼 —— 表现和"填了 Key 却不生效"一模一样。
      const cfg = fs.existsSync(configFile)
        ? JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/u, ""))
        : {};
      if (next.llmModel) cfg.llmModel = String(next.llmModel);
      if (next.llmBaseUrl) cfg.llmBaseUrl = String(next.llmBaseUrl);
      if (next.llmApiKey) cfg.llmApiKey = String(next.llmApiKey);
      if (next.vaultPath) cfg.vaultPath = String(next.vaultPath);
      fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
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
  // 登录浏览器策略 / 模型下载源同步写入 CLI config.json：
  // 定时任务（run-sync.ps1）不注入环境变量，只能靠 config.json 读到同一套口径
  if (patch && (Object.prototype.hasOwnProperty.call(patch, "browserMode")
    || Object.prototype.hasOwnProperty.call(patch, "browserProxy")
    || Object.prototype.hasOwnProperty.call(patch, "modelEndpoint"))) {
    try {
      const configFile = path.join(next.projectPath, "config.json");
      if (fs.existsSync(configFile)) {
        const cfg = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/u, ""));
        cfg.browserMode = ["auto", "builtin", "system"].includes(next.browserMode) ? next.browserMode : "auto";
        cfg.browserProxy = next.browserProxy === "direct" ? "direct" : "system";
        cfg.modelEndpoint = next.modelEndpoint === "official" ? "official" : "mirror";
        fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      }
    } catch (err) {
      console.error("sync browser/model config to config.json failed:", err);
    }
  }
  // 跳过内容类型（skipCategories）同步写入 CLI config.json。
  // 之前只存在 settings.json 里，CLI 读的是 config.json，结果界面上勾了「跳过短剧」
  // 引擎那边永远是空数组 —— 一条都不会跳过。
  if (patch && Object.prototype.hasOwnProperty.call(patch, "skipCategories")) {
    const list = sanitizeSkipCategories(next.skipCategories);
    try {
      const configFile = path.join(next.projectPath, "config.json");
      if (fs.existsSync(configFile)) {
        const cfg = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/u, ""));
        cfg.skipCategories = list;
        fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      } else {
        fs.writeFileSync(configFile, JSON.stringify({ skipCategories: list }, null, 2) + "\n", "utf8");
      }
    } catch (err) {
      console.error("sync skipCategories to config.json failed:", err);
    }
  }
  return next;
}

function pythonBin(settings) {
  // 打包版：强制用内置 venv 的 python，不依赖 settings 里存的旧路径
  if (BUNDLED) {
    const bundled = path.join(BUNDLED, "project", ".venv", "Scripts", "python.exe");
    if (fs.existsSync(bundled)) return bundled;
  }
  // 开发版或兜底：优先设置里的 pythonPath；其次 projectPath\.venv；最后系统 python
  if (settings && settings.pythonPath && fs.existsSync(settings.pythonPath)) return settings.pythonPath;
  const venv = path.join(settings && settings.projectPath || "", ".venv", "Scripts", "python.exe");
  return fs.existsSync(venv) ? venv : "python";
}

// 内置 Chromium 的目录名带版本号（chromium-1169 / chromium-1148…），不能写死，
// 否则换个 Playwright 版本就找不到浏览器 → 登录窗口拉不起来
function builtinChromiumRoot() {
  // 打包版在 resources/dok-runtime；开发版用仓库里的 build-runtime，保证两边行为一致
  const candidates = [];
  if (BUNDLED) candidates.push(path.join(BUNDLED, "ms-playwright"));
  candidates.push(path.join(__dirname, "build-runtime", "ms-playwright"));
  return candidates.find((dir) => dir && fs.existsSync(dir)) || "";
}

function findBuiltinChrome() {
  const pwPath = builtinChromiumRoot();
  if (!pwPath) return "";
  let best = "";
  let bestVer = -1;
  try {
    for (const entry of fs.readdirSync(pwPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^chromium-\d+$/i.test(entry.name)) continue;
      const exe = path.join(pwPath, entry.name, "chrome-win", "chrome.exe");
      if (!fs.existsSync(exe)) continue;
      const ver = Number(entry.name.split("-")[1]) || 0;
      if (ver > bestVer) { bestVer = ver; best = exe; }
    }
  } catch {}
  return best;
}

// 本机浏览器（Chrome / Edge）真实安装位置：显式探测比 Playwright 的 channel 更可靠
function findSystemBrowsers() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const first = (list) => list.find((p) => p && fs.existsSync(p)) || "";
  const chrome = first([
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
  ]);
  const edge = first([
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]);
  const found = [];
  if (chrome) found.push({ id: "chrome", label: "本机 Chrome", path: chrome });
  if (edge) found.push({ id: "edge", label: "本机 Edge", path: edge });
  return found;
}

function envFor(settings) {
  const env = {
    ...process.env,
    DOK_LLM_BASE_URL: settings.llmBaseUrl || "",
    DOK_LLM_API_KEY: settings.llmApiKey || "",
    DOK_LLM_MODEL: settings.llmModel || "",
    DOK_BROWSER_MODE: settings.browserMode || "auto",
    DOK_BROWSER_PROXY: settings.browserProxy === "direct" ? "direct" : "system",
    // 上次登录成功用的浏览器优先：登录态按浏览器分开保存，不指定就会出现
    // "内置浏览器空 profile 抢位 → 明明本机 Chrome 已登录却报未登录"
    DOK_PREFERRED_BROWSER: settings.lastLoginBrowser || "",
    // 模型下载源：mirror=国内 hf-mirror.com（默认，解决国内直连超时）；official=HuggingFace 官方。
    // 必须传具体地址（不要用空串表示官方），否则 CLI 侧无法区分"用户选了官方"和"没配置"
    DOK_HF_ENDPOINT: settings.modelEndpoint === "official" ? "https://huggingface.co" : "https://hf-mirror.com",
    PYTHONIOENCODING: "utf-8",
  };
  // 内置 Chromium：打包版在 dok-runtime，开发版在仓库 build-runtime，两边都认，
  // 免得开发时登录一直走系统浏览器、和安装版行为不一致
  const pwRoot = builtinChromiumRoot();
  if (pwRoot) env.PLAYWRIGHT_BROWSERS_PATH = pwRoot;
  // 直接指定内置 chrome.exe，绕过 Playwright 版本匹配
  const chromeExe = findBuiltinChrome();
  if (chromeExe) env.DOK_CHROME_PATH = chromeExe;
  // 打包版：node/ffmpeg 等运行时也在 dok-runtime，加到 PATH 前面
  if (BUNDLED) {
    env.PATH = BUNDLED + path.delimiter + env.PATH;
    // 用绝对路径找 powershell.exe，避免打包后 PATH 缺 System32
    const psCandidates = [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe",
    ];
    const psFound = psCandidates.find(p => fs.existsSync(p));
    if (psFound) env.DOK_POWERSHELL = psFound;
  }
  return env;
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

// 正在跑的子进程（采集/同步/转录/蒸馏…）：强制停止要能一次性收掉它们
const runningChildren = new Set();
let lastForceStopAt = 0;
function registerChild(child, label) {
  runningChildren.add(child);
  try { child.__dokLabel = label; } catch {}
  const cleanup = () => runningChildren.delete(child);
  child.on("close", cleanup);
  child.on("exit", cleanup);
  return child;
}

function runCli(settings, args, { onData, onOut, onErr, onDone, onError } = {}) {
  const child = spawn(settings.nodePath, ["--no-warnings", "src\\cli.mjs", ...args], {
    cwd: settings.projectPath,
    env: envFor(settings),
    windowsHide: true,
  });
  bindChildOutput(child, { onData, onOut, onErr });
  child.on("error", (err) => onError && onError(String(err.message || err)));
  child.on("close", (code) => onDone && onDone(code));
  return registerChild(child, `cli ${args[0] || ""}`.trim());
}

function runPython(settings, scriptArgs, { onData, onOut, onErr, onDone, onError } = {}) {
  const child = spawn(pythonBin(settings), scriptArgs, {
    cwd: settings.projectPath,
    env: envFor(settings),
    windowsHide: true,
  });
  bindChildOutput(child, { onData, onOut, onErr });
  child.on("error", (err) => onError && onError(String(err.message || err)));
  child.on("close", (code) => onDone && onDone(code));
  return registerChild(child, String(scriptArgs[0] || "").split(/[\\/]/).pop());
}

// stdout / stderr 分开回调：结果 JSON 只从 stdout 解析，
// 诊断日志走 stderr，避免一条 warning 就把 JSON 解析搞崩
function bindChildOutput(child, { onData, onOut, onErr } = {}) {
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    if (onData) onData(text);
    if (onOut) onOut(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (onData) onData(text);
    if (onErr) onErr(text);
  });
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
ipcMain.handle("word:tree", () => {
  const s = loadSettings();
  const target = path.join(s.vaultPath, s.vaultFolder || "Douyin Knowledge", s.wordFolderName || "纯转录Word文档");
  if (!fs.existsSync(target)) return { folders: [], files: [] };
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const folders = [];
    const files = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const sub = walk(full);
        folders.push({ name: e.name, path: full, subFolders: sub.folders, subFiles: sub.files });
      } else if (e.name.endsWith(".docx")) {
        files.push({ name: e.name, path: full });
      }
    }
    return { folders, files };
  };
  return walk(target);
});
ipcMain.handle("word:open", (_e, filePath) => shell.openPath(filePath));
ipcMain.handle("dialog:pickFolder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? "" : result.filePaths[0];
});
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
  // 硬前提拦截：没选知识库路径时，采集/下载/转录/AI 提炼会全部跑完，
  // 直到写笔记才抛 "vaultPath is not configured" —— 用户白等一场还白花 API 费用。
  // 全新安装的机器默认就是空路径，所以必须在启动子进程之前挡住。
  const isSync = Array.isArray(args) && args[0] === "sync";
  if (isSync && !String((settings && settings.vaultPath) || "").trim()) {
    const msg = "还没有选择知识库路径：请到「设置 → 知识库路径（Vault）」选一个文件夹后再开始处理。";
    try { event.sender.send("pipeline:log", `\n[错误] ${msg}\n`); } catch {}
    return Promise.resolve({ ok: false, needVault: true, stopped: false, error: msg });
  }
  return new Promise((resolve) => {
    const child = runCli(settings, args, {
      onData: (chunk) => event.sender.send("pipeline:log", chunk),
      onDone: (code) => {
        // 用户点了「强制停止」时进程是被杀掉的，返回码非 0，这里标出来避免界面显示"完成"
        const stopped = Date.now() - lastForceStopAt < 15000;
        resolve({ ok: code === 0, code, stopped });
      },
      onError: (err) => resolve({ ok: false, error: err }),
    });
    event.sender.once("pipeline:cancel", () => {
      try { child.kill(); } catch {}
    });
  });
});

// 子进程可能先输出一堆日志再输出结果 JSON：取最后一个能解析的行
function parseLastJson(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return {};
}

ipcMain.handle("pipeline:login", (event, settings) => {
  return new Promise((resolve) => {
    let out = "";
    const child = runPython(settings, ["scripts\\collect-favorites.py", "login"], {
      onData: (chunk) => event.sender.send("pipeline:log", chunk),
      onOut: (chunk) => { out += chunk; },
      onDone: (code) => {
        const parsed = parseLastJson(out);
        if (code === 0 && parsed.status === "authenticated") {
          // 记住这次登录用的浏览器：换浏览器后登录态不通用，后续采集失败时可以据此提示
          try { saveSettings({ lastLoginBrowser: parsed.browser || "", lastLoginBrowserLabel: parsed.browser_label || "" }); } catch {}
        }
        resolve({
          ok: code === 0 && parsed.status === "authenticated",
          code,
          status: parsed.status || "",
          browser: parsed.browser || "",
          browserLabel: parsed.browser_label || "",
          error: parsed.error || parsed.message || "",
        });
      },
      onError: (err) => resolve({ ok: false, error: String(err) }),
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
      onOut: (chunk) => { out += chunk; },
      onDone: (code) => {
        const parsed = parseLastJson(out);
        const status = parsed.status || "";
        resolve({
          ok: code === 0 && status === "authenticated",
          status,
          browser: parsed.browser || "",
          browserLabel: parsed.browser_label || "",
          error: parsed.error || "",
          raw: out,
        });
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
let collectRunning = false;
ipcMain.handle("collects:start", (event, settings, payload) => {
  // 防重入：以前点两下会同时跑两个采集，两个浏览器抢同一个 profile → 一个必崩，
  // 还会互相覆盖 api-collection.json，日志里出现两套 [browser] 输出
  if (collectRunning) {
    return Promise.resolve({ ok: false, error: "已经有一个处理任务在跑：等它结束，或点「强制停止」后再试" });
  }
  if (isSyncRunning(settings)) {
    return Promise.resolve({ ok: false, error: "上一次任务还没收尾（sync.lock 未释放），稍等几秒或点「强制停止」再试" });
  }
  collectRunning = true;
  return new Promise((resolve) => {
    const send = (s) => event.sender.send("pipeline:log", s);
    const opts = payload || {};
    const mode = opts.mode || "all"; // all=收藏视频(全部收藏) folder=指定收藏夹
    const collectsId = String(opts.collectsId || "").trim();
    const collectsName = String(opts.collectsName || "").trim();
    // 要处理多少条：按数量模式下以「确认条数」为准（以前这里只用每日上限，导致"设了 3 条"根本不生效）
    const isCountMode = settings.processMode === "count" && Number(settings.countLimit) > 0;
    const limit = isCountMode
      ? Math.max(1, Number(settings.countLimit))
      : Math.max(1, Number(opts.limit || 0));
    // 采集上限必须和处理条数分开：采集要全量（否则会把"库里只有 3 条"当真，收藏夹永远同步不全）
    const collectLimit = Math.max(limit, Number(settings.collectorMaxItems) || 3000);
    const startDate = String(opts.startDate || "").trim();
    const collectOut = path.join(settings.projectPath, "var",
      mode === "folder" && collectsId ? `api-collection-${collectsId}.json` : "api-collection.json");
    let cancelled = false;
    const onCancel = () => { cancelled = true; };
    event.sender.once("pipeline:cancel", onCancel);
    const cleanup = () => event.sender.removeListener("pipeline:cancel", onCancel);

    const stepCollect = () => new Promise((stepResolve) => {
      const args = ["scripts\\collect-favorites.py", "collect", "--max-items", String(collectLimit), "--output", collectOut];
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

    const stepSync = (scopeWindowOk) => new Promise((stepResolve) => {
      send(`[3/3] 开始处理（最多 ${limit} 条，按最新收藏优先；断网自动续跑）…\n`);
      const args = ["sync", "--pending", String(limit), "--order", "recent"];
      if (mode === "folder" && collectsId) args.push("--collects-id", collectsId);
      if (startDate) args.push("--start-date", startDate);
      // 只在窗口刷新成功时才用它收窄候选，避免用过期窗口把最新收藏挡在外面
      else if (scopeWindowOk && isCountMode) args.push("--count-window");
      runCli(settings, args, {
        onData: (c) => send(c),
        onDone: (code) => stepResolve(code === 0),
        onError: (err) => { send(`处理失败：${err}\n`); stepResolve(false); },
      });
    });

    // 按数量模式：每次开始处理前把"最近 N 条"快照刷新一次（以前是设置那一刻锁死、过期后静默失效）
    const stepRefreshCountWindow = () => new Promise((stepResolve) => {
      if (!isCountMode) return stepResolve(true);
      send(`[·] 刷新处理范围：最近 ${limit} 条收藏…\n`);
      runCli(settings, ["configure", "--count-window", String(limit)], {
        onData: (c) => send(c),
        onDone: (code) => stepResolve(code === 0),
        onError: () => stepResolve(true),
      });
    });

    (async () => {
      const okCollect = await stepCollect();
      if (cancelled) { cleanup(); return resolve({ ok: false, cancelled: true }); }
      if (!okCollect) {
        cleanup();
        const lastBrowser = String(settings.lastLoginBrowserLabel || "").trim();
        const hint = lastBrowser
          ? `（上次登录用的是「${lastBrowser}」，登录状态按浏览器分开保存；如果这次自动换成了别的浏览器，需要重新扫码）`
          : "";
        return resolve({ ok: false, error: `采集失败：多半是未登录，或浏览器被安全软件拦截${hint}。请到「设置 → 打开抖音扫码登录」用同一个浏览器重新扫码；详情见下方日志` });
      }
      const okIngest = await stepIngest();
      if (cancelled) { cleanup(); return resolve({ ok: false, cancelled: true }); }
      if (!okIngest) { cleanup(); return resolve({ ok: false, error: "导入失败，请查看日志" }); }
      const windowOk = await stepRefreshCountWindow();
      if (cancelled) { cleanup(); return resolve({ ok: false, cancelled: true }); }
      const okSync = await stepSync(windowOk);
      cleanup();
      resolve({ ok: okSync, cancelled: cancelled });
    })();
  }).finally(() => { collectRunning = false; });
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

// 知识库「最新生成」视图：按生成时间倒序返回已生成笔记（updated_at DESC），供界面"最新生成"排序使用
ipcMain.handle("notes:list", async (_e, settings, payload) => {
  const { limit = 80 } = payload || {};
  return await new Promise((resolve) => {
    let out = "";
    runCli(settings, ["notes", "--recent", String(limit)], {
      onData: (chunk) => { out += chunk; },
      onDone: (code) => {
        if (code !== 0) return resolve({ ok: false, error: "notes 命令失败" });
        try { resolve({ ok: true, ...JSON.parse(out) }); }
        catch (err) { resolve({ ok: false, error: String(err) }); }
      },
      onError: (err) => resolve({ ok: false, error: String(err) }),
    });
  });
});

// 智能划重点：对指定笔记文件调 LLM 识别重点词加粗并写回（带防改写校验）
ipcMain.handle("highlight:run", async (_e, settings, payload) => {
  const { file = "", awemeId = "" } = payload || {};
  // 划重点全靠大模型：没 Key 时立刻给明确提示，别让用户面对"命令失败"这种无从下手的错误
  if (!String(settings.llmApiKey || process.env.DOK_LLM_API_KEY || "").trim()) {
    return { ok: false, error: "智能划重点需要 AI Key：请到「设置 → AI 接口」填写 API Key 后重试" };
  }
  return await new Promise((resolve) => {
    const args = ["highlight"];
    if (file) args.push("--file", file);
    else if (awemeId) args.push("--aweme-id", awemeId);
    else return resolve({ ok: false, error: "需要 file 或 awemeId" });
    let out = "";
    let errText = "";
    runCli(settings, args, {
      onOut: (chunk) => { out += chunk; },
      onErr: (chunk) => { errText += chunk; },
      onDone: (code) => {
        if (code !== 0) {
          const hint = errText.trim().split("\n").filter((l) => l && !/ExperimentalWarning|trace-warnings/u.test(l)).slice(-1)[0];
          return resolve({ ok: false, error: hint || "智能划重点失败，请稍后重试" });
        }
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

/* ==================== 强制终止任务 ==================== */
function isProcessAlive(pid) {
  const value = Number(pid);
  if (!value) return false;
  try { process.kill(value, 0); return true; } catch { return false; }
}

// Windows 上必须杀整棵进程树：node → python(转录) / playwright(浏览器) / powershell(模型下载)，
// 只 kill 直接子进程会留下孤儿浏览器/ffmpeg，占着文件锁导致下次跑不动
function killProcessTree(pid) {
  return new Promise((resolve) => {
    const value = Number(pid);
    if (!value) return resolve(false);
    if (process.platform === "win32") {
      let settled = false;
      const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      try {
        const killer = spawn("taskkill", ["/PID", String(value), "/T", "/F"], { windowsHide: true });
        killer.on("error", () => {
          try { process.kill(value, "SIGKILL"); } catch {}
          finish(!isProcessAlive(value));
        });
        killer.on("close", (code) => finish(code === 0 || !isProcessAlive(value)));
      } catch {
        try { process.kill(value, "SIGKILL"); } catch {}
        finish(!isProcessAlive(value));
      }
      return;
    }
    try { process.kill(value, "SIGKILL"); } catch {}
    resolve(!isProcessAlive(value));
  });
}

ipcMain.handle("pipeline:force-stop", async (event, settings) => {
  const s = settings || loadSettings();
  const stateDir = projectStateDir(s);
  const lockFile = path.join(stateDir, "sync.lock");
  const targets = new Map(); // pid -> 标签

  for (const child of runningChildren) {
    if (child.pid) targets.set(Number(child.pid), child.__dokLabel || "任务进程");
  }
  // 定时任务/其他入口拉起的 CLI 不在子进程表里，用 sync.lock 里的 pid 兜底
  let lockPid = 0;
  try {
    if (fs.existsSync(lockFile)) lockPid = Number(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid || 0);
  } catch {}
  if (lockPid && isProcessAlive(lockPid)) targets.set(lockPid, "同步任务（sync.lock）");

  if (!targets.size) {
    // 没有活进程，但锁文件可能残留（异常退出），顺手清掉，避免下次报"另一个同步正在运行"
    let clearedLock = false;
    try {
      if (fs.existsSync(lockFile)) { fs.rmSync(lockFile, { force: true }); clearedLock = true; }
    } catch {}
    return { ok: true, killed: 0, clearedLock, message: clearedLock ? "没有在跑的任务，已清理残留锁" : "当前没有正在运行的任务" };
  }

  const details = [];
  lastForceStopAt = Date.now();
  for (const [pid, label] of targets) {
    const ok = await killProcessTree(pid);
    details.push({ pid, label, ok });
    try { event.sender.send("pipeline:log", `\n[停止] 终止「${label}」PID ${pid} ${ok ? "成功" : "（进程可能已自行退出）"}\n`); } catch {}
  }

  // 等进程真正退出（最多 5 秒），再动锁和进度文件
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && [...targets.keys()].some((pid) => isProcessAlive(pid))) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  let clearedLock = false;
  try {
    if (fs.existsSync(lockFile)) {
      let pid = 0;
      try { pid = Number(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid || 0); } catch {}
      if (!pid || !isProcessAlive(pid)) { fs.rmSync(lockFile, { force: true }); clearedLock = true; }
    }
  } catch {
    try { fs.rmSync(lockFile, { force: true }); clearedLock = true; } catch {}
  }

  // 进度条复位成"已停止"，保留已完成的条数，避免用户以为要重头再来
  try {
    const progressFile = path.join(stateDir, "sync-progress.json");
    let progress = { done: 0, total: 0, percent: 0 };
    try { progress = { ...progress, ...JSON.parse(fs.readFileSync(progressFile, "utf8")) }; } catch {}
    fs.writeFileSync(progressFile, JSON.stringify({
      ...progress,
      running: false,
      stage: "stopped-by-user",
      updatedAt: new Date().toISOString(),
    }, null, 2), "utf8");
  } catch {}

  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send("pipeline:stopped", { killed: details.length }); } catch {}
  }
  return { ok: true, killed: details.length, clearedLock, details, message: `已强制终止 ${details.length} 个任务进程` };
});
ipcMain.handle("vip:redeem", async (_e, { url, code, device }) => {
  try {
    const resp = await fetch(String(url).replace(/\/+$/, "") + "/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, device }),
    });
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch (err) {}
    if (data && typeof data.response === "string") { try { data = JSON.parse(data.response); } catch (err) {} }
    return { ok: true, status: resp.status, data };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ---- VIP 票据（HMAC 签名 + 绑设备）：会员状态不再由明文开关决定，改记事本 JSON 无效，配置拷到别的电脑也无效 ----
const crypto = require("crypto");
const VIP_K1 = "dK9xQ2", VIP_K2 = "mZ7wR4", VIP_K3 = "jT8vL1";
const VIP_SECRET = VIP_K1 + VIP_K2 + "-vault-2026-" + VIP_K3;
function b64u(buf) { return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64uDecode(s) { return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64"); }
function issueVipTicket(code, device) {
  const body = b64u(JSON.stringify({ code: String(code || "").slice(0, 32), device: String(device || ""), at: Date.now() }));
  return body + "." + b64u(crypto.createHmac("sha256", VIP_SECRET).update(body).digest());
}
function checkVipTicket(ticket, device) {
  try {
    const parts = String(ticket || "").split(".");
    if (parts.length !== 2) return null;
    const want = b64u(crypto.createHmac("sha256", VIP_SECRET).update(parts[0]).digest());
    const a = Buffer.from(parts[1]), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(b64uDecode(parts[0]).toString("utf8"));
    if (payload.device !== String(device || "")) return null;
    return payload;
  } catch { return null; }
}

// 兑换成功后由界面调用：主进程现场签发绑设备 ticket 并落盘（签名密钥不进渲染进程）
ipcMain.handle("vip:issue", async (_e, { code, activatedAt, nick }) => {
  try {
    const s = loadSettings();
    const ticket = issueVipTicket(code, s.deviceId || "unknown");
    saveSettings({ vip: { ...(s.vip || {}), active: true, code, activatedAt: activatedAt || "", nick: nick || "", ticket } });
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

// 启动时校验会员状态：只认 ticket 签名，不认 vip.active 明文；老版本无 ticket 的自动补签迁移
ipcMain.handle("vip:verify", async () => {
  // 开源版：直接返回已激活，全功能免费开放
  return { ok: true, active: true, code: "opensource", activatedAt: "", nick: "开源用户" };
});

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

// ---- 每周周报 AI 小结（会员专属）：根据本周数据生成 2~3 句鼓励式小结 ----
ipcMain.handle("weekly:aiSummary", async (_e, settings, data) => {
  try {
    if (!data) return { ok: false, error: "缺少周报数据" };
    const envBase = process.env.DOK_LLM_BASE_URL || "";
    const envKey = process.env.DOK_LLM_API_KEY || "";
    const base = (settings.llmBaseUrl || envBase).replace(/\/+$/, "");
    const apiKey = settings.llmApiKey || envKey;
    if (!base || !apiKey) return { ok: false, error: "未配置 AI API Key（可在设置页填写，或使用环境变量 DOK_LLM_API_KEY）" };
    const catText = (data.byCategory || []).map((c) => `${c.name}${c.count}篇`).join("、") || "暂无";
    const user = `本周数据：新增笔记 ${data.weekNewNotes} 篇，新增知识卡片 ${data.weekNewCards} 张，累计笔记 ${data.totalNotes} 篇。本周分类分布：${catText}。上周新增笔记 ${data.lastWeekNewNotes} 篇、新增卡片 ${data.lastWeekNewCards} 张。请写一段 2~3 句的周报小结。`;
    const system = "你是用户个人知识库的周报助手。根据用户本周的学习数据，用中文写一段 2~3 句的周报小结：语气轻松鼓励、自然口语化，突出本周最活跃的分类、新增量与坚持的价值；如果本周比上周进步可以夸一夸，退步则温和打气；不要罗列无意义的客套话，不要使用 Markdown 符号。";
    const model = settings.llmModel || "deepseek-chat";
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.7, max_tokens: 220 }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, error: friendlyAIError(resp.status, body) };
    }
    const data2 = await resp.json();
    recordApiUsage(data2);
    const summary = (data2.choices && data2.choices[0] && data2.choices[0].message && data2.choices[0].message.content) || "";
    if (!summary) return { ok: false, error: "AI 返回为空" };
    return { ok: true, summary: summary.trim() };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ---- 每周周报 下周研究方向（会员专属）：AI 分析本周收藏集中度，推荐一个下周推进方向 ----
ipcMain.handle("weekly:aiDirection", async (_e, settings, data) => {
  try {
    if (!data) return { ok: false, error: "缺少周报数据" };
    const envBase = process.env.DOK_LLM_BASE_URL || "";
    const envKey = process.env.DOK_LLM_API_KEY || "";
    const base = (settings.llmBaseUrl || envBase).replace(/\/+$/, "");
    const apiKey = settings.llmApiKey || envKey;
    if (!base || !apiKey) return { ok: false, error: "未配置 AI API Key（可在设置页填写，或使用环境变量 DOK_LLM_API_KEY）" };
    const catText = (data.byCategory || []).map((c) => `${c.name}${c.count}篇`).join("、") || "暂无";
    const titles = (data.weekNewTitles || []).slice(0, 60).join("、") || "暂无";
    const user = `本周新增笔记 ${data.weekNewNotes} 篇。分类分布：${catText}。本周部分笔记标题：${titles}。请分析本周收藏最集中的方向，并给出 1 个下周最值得推进的研究方向建议，2~3 句话。`;
    const system = "你是用户个人知识库的研究规划助手。根据用户本周收藏的分布和主题，用中文给出分析：先说本周收藏最集中于哪个方面（一句话），再给一个下周推荐的推进方向（具体、可执行、一句话）；语气自然，不要 Markdown 符号，不要客套话。";
    const model = settings.llmModel || "deepseek-chat";
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.7, max_tokens: 220 }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, error: friendlyAIError(resp.status, body) };
    }
    const data2 = await resp.json();
    recordApiUsage(data2);
    const direction = (data2.choices && data2.choices[0] && data2.choices[0].message && data2.choices[0].message.content) || "";
    if (!direction) return { ok: false, error: "AI 返回为空" };
    return { ok: true, direction: direction.trim() };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
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

// ---- 被"内容类型"跳过的条目：列出 / 一键恢复（用已提取的知识补笔记，不重复花 AI） ----
ipcMain.handle("skipped:list", async (_e, settings) => {
  const s = settings || loadSettings();
  return await new Promise((resolve) => {
    let out = "";
    runCli(s, ["skipped", "--list", "--limit", "300"], {
      onOut: (chunk) => { out += chunk; },
      onDone: (code) => {
        const parsed = parseLastJson(out);
        if (code === 0 && parsed && parsed.ok) resolve({ ok: true, items: parsed.items || [], total: parsed.total || 0 });
        else resolve({ ok: false, error: parsed && parsed.error || "读取跳过清单失败", raw: out.slice(-400) });
      },
      onError: (err) => resolve({ ok: false, error: String(err) }),
    });
  });
});

ipcMain.handle("skipped:restore", async (_e, settings, awemeIds) => {
  const s = settings || loadSettings();
  const ids = (Array.isArray(awemeIds) ? awemeIds : [awemeIds]).map((id) => String(id || "").trim()).filter(Boolean);
  if (!ids.length) return { ok: false, error: "没有选中要恢复的视频" };
  return await new Promise((resolve) => {
    let out = "";
    runCli(s, ["skipped", "--restore", ids.join(",")], {
      onOut: (chunk) => { out += chunk; },
      onDone: (code) => {
        const parsed = parseLastJson(out);
        if (code === 0 && parsed && Array.isArray(parsed.restored)) {
          const okCount = parsed.restored.filter((r) => r.ok).length;
          resolve({ ok: true, restored: parsed.restored, okCount, failCount: parsed.restored.length - okCount });
        } else {
          resolve({ ok: false, error: parsed && parsed.error || "恢复失败", raw: out.slice(-400) });
        }
      },
      onError: (err) => resolve({ ok: false, error: String(err) }),
    });
  });
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
  // 提取双链：
  // 1) 指向知识库内笔记 → 笔记与笔记直接连边；
  // 2) 指向不存在的标题（AI 提炼产出的「相关概念」，如 [[爆锅增香]]）→ 建"概念节点"，
  //    多篇笔记共享同一个概念时就会通过这个节点连在一起，图谱不再是一堆孤岛。
  const conceptMap = new Map();
  const conceptEdges = [];
  for (const n of nodes) {
    const content = fs.readFileSync(n.path, "utf8");
    const links = new Set();
    const concepts = new Set();
    const re = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const target = m[1].trim();
      if (!target) continue;
      if (index.has(target)) links.add(index.get(target));
      else concepts.add(target);
    }
    for (const t of links) {
      if (t !== n.id) edges.push({ source: n.id, target: t, kind: "note" });
    }
    for (const c of concepts) {
      const key = c.toLowerCase();
      let rec = conceptMap.get(key);
      if (!rec) {
        rec = { id: `concept::${c}`, title: c, weight: 0 };
        conceptMap.set(key, rec);
      }
      rec.weight += 1;
      conceptEdges.push({ source: n.id, target: rec.id, kind: "concept" });
    }
  }
  for (const rec of conceptMap.values()) {
    nodes.push({ id: rec.id, title: rec.title, path: "", group: "", kind: "concept", weight: rec.weight });
  }
  edges.push(...conceptEdges);
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

// ---- 查询账户余额：DeepSeek 官方 /user/balance，多数中转兼容；兜底尝试 /balance；6 小时缓存 ----
ipcMain.handle("weekly:balance", async (_e, settings) => {
  try {
    const cur = loadSettings();
    const cached = cur.apiBalance || {};
    if (cached.time && cached.balance && Date.now() - new Date(cached.time).getTime() < 6 * 3600000) {
      return { ok: true, balance: cached.balance, cached: true };
    }
    const envBase = process.env.DOK_LLM_BASE_URL || "";
    const envKey = process.env.DOK_LLM_API_KEY || "";
    const base = (settings.llmBaseUrl || envBase).replace(/\/+$/, "");
    const apiKey = settings.llmApiKey || envKey;
    if (!base || !apiKey) return { ok: false, error: "未配置 AI API Key" };
    let resp = null;
    try { resp = await fetch(`${base}/user/balance`, { headers: { Authorization: `Bearer ${apiKey}` } }); }
    catch { resp = null; }
    if (!resp || !resp.ok) {
      try { resp = await fetch(`${base}/balance`, { headers: { Authorization: `Bearer ${apiKey}` } }); }
      catch { resp = null; }
    }
    if (!resp || !resp.ok) return { ok: false, error: "unsupported" };
    const j = await resp.json();
    const bal = j.total_balance ?? (j.data && j.data.total_balance) ?? (j.balance_infos && j.balance_infos[0] && j.balance_infos[0].total_balance) ?? null;
    if (bal === null || bal === undefined) return { ok: false, error: "unsupported" };
    const balance = `¥${Number(bal).toFixed(2)}`;
    saveSettings({ apiBalance: { time: new Date().toISOString(), balance } });
    return { ok: true, balance };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

/* ==================== 登录浏览器：诊断 / 重置 ==================== */
// 每个浏览器用独立 profile 目录（与 Python 侧 profile_dir_for 保持一致）
function profileDirs() {
  const base = path.join(os.homedir(), ".douyin-knowledge", "browser-profile");
  return { builtin: base, chrome: `${base}-chrome`, edge: `${base}-edge` };
}

function dirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.dok-write-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle("browser:diagnose", (_e, settings) => {
  const s = settings || loadSettings();
  const builtinChrome = findBuiltinChrome();
  const system = findSystemBrowsers();
  const dirs = profileDirs();
  const items = [
    { id: "builtin", label: "内置 Chromium", path: builtinChrome, found: Boolean(builtinChrome), profile: dirs.builtin },
    ...["chrome", "edge"].map((id) => {
      const hit = system.find((b) => b.id === id);
      return {
        id,
        label: id === "chrome" ? "本机 Chrome" : "本机 Edge",
        path: hit ? hit.path : "",
        found: Boolean(hit),
        profile: dirs[id],
      };
    }),
  ];
  return {
    ok: true,
    mode: ["auto", "builtin", "system"].includes(s.browserMode) ? s.browserMode : "auto",
    proxy: s.browserProxy === "direct" ? "direct" : "system",
    packaged: Boolean(BUNDLED),
    playwrightRuntime: Boolean(BUNDLED && fs.existsSync(path.join(BUNDLED, "ms-playwright"))),
    items: items.map((it) => ({ ...it, writable: dirWritable(it.profile) })),
    available: items.filter((it) => it.found).length,
  };
});

ipcMain.handle("browser:reset-profile", () => {
  const removed = [];
  for (const [id, dir] of Object.entries(profileDirs())) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(id);
      }
    } catch (err) {
      return {
        ok: false,
        removed,
        error: `清理 ${id} 配置目录失败（多半是还有浏览器窗口没关）：${String(err && err.message || err)}`,
      };
    }
  }
  return { ok: true, removed };
});

/* ==================== 转录模型：状态 / 重新下载 ==================== */
// CLI 的 stateDir 由 config.json 决定（默认 var），模型实际落在 {stateDir}/models/{repoId 斜杠换--}/{revision}/
function projectStateDir(settings) {
  try {
    const cfgFile = path.join(settings.projectPath, "config.json");
    if (fs.existsSync(cfgFile)) {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8").replace(/^\uFEFF/u, ""));
      if (cfg.stateDir) {
        return path.isAbsolute(cfg.stateDir) ? cfg.stateDir : path.join(settings.projectPath, cfg.stateDir);
      }
    }
  } catch {}
  return path.join(settings.projectPath, "var");
}

function resolveModelLock(settings) {
  const modelsDir = path.join(settings.projectPath, "models");
  const tier = ["small", "medium", "large-v3"].includes(settings.whisperModelTier) ? settings.whisperModelTier : "small";
  const preferred = path.join(modelsDir, `faster-whisper-${tier}.lock.json`);
  if (fs.existsSync(preferred)) return preferred;
  try {
    const any = fs.readdirSync(modelsDir).find((f) => f.endsWith(".lock.json"));
    if (any) return path.join(modelsDir, any);
  } catch {}
  return "";
}

function modelStatusInfo(settings) {
  const s = settings || loadSettings();
  // 用户把 whisperModel 填成本地模型目录时，直接判断该目录
  if (s.whisperModel && path.isAbsolute(s.whisperModel)) {
    const exists = fs.existsSync(s.whisperModel);
    return {
      ok: true,
      state: exists ? "custom" : "missing",
      message: exists ? "正在使用自定义本地模型目录" : "自定义模型目录不存在",
      modelDir: s.whisperModel,
      lockPath: "",
      files: [],
      presentBytes: 0,
      expectedBytes: 0,
      endpoint: s.modelEndpoint === "official" ? "official" : "mirror",
    };
  }
  const lockPath = resolveModelLock(s);
  if (!lockPath) {
    return {
      ok: false,
      state: "no-lock",
      message: "安装目录里找不到模型清单（models/*.lock.json），软件可能不完整，建议重新安装",
      modelDir: "",
      lockPath: "",
      files: [],
      presentBytes: 0,
      expectedBytes: 0,
    };
  }
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf8").replace(/^\uFEFF/u, ""));
  } catch (err) {
    return {
      ok: false,
      state: "no-lock",
      message: `模型清单读取失败：${String(err && err.message || err)}`,
      modelDir: "",
      lockPath,
      files: [],
      presentBytes: 0,
      expectedBytes: 0,
    };
  }
  const repoId = String(lock.repoId || "");
  const revision = String(lock.revision || "");
  const modelDir = path.join(projectStateDir(s), "models", repoId.replace(/\//g, "--"), revision);
  const files = [];
  let presentBytes = 0;
  let expectedBytes = 0;
  let missing = 0;
  let badSize = 0;
  for (const [name, meta] of Object.entries(lock.files || {})) {
    const want = Number(meta && meta.bytes || 0);
    expectedBytes += want;
    let size = -1;
    try { size = fs.statSync(path.join(modelDir, name)).size; } catch {}
    const ok = size === want;
    if (size > 0) presentBytes += Math.min(size, want);
    if (size < 0) missing += 1;
    else if (!ok) badSize += 1;
    files.push({ name, ok, size, expected: want });
  }
  const state = missing === 0 && badSize === 0 ? "ok" : (presentBytes === 0 ? "missing" : "partial");
  const message = state === "ok"
    ? "模型文件完整，可以正常转录"
    : state === "missing"
      ? "模型缺失（首次使用需要下载，或被杀毒软件隔离）"
      : `模型不完整：缺 ${missing} 个文件、${badSize} 个大小不符`;
  return {
    ok: true,
    state,
    message,
    modelDir,
    lockPath,
    repoId,
    revision,
    files,
    presentBytes,
    expectedBytes,
    endpoint: s.modelEndpoint === "official" ? "official" : "mirror",
  };
}

let modelRepairing = false;

// 同步任务是否正在跑（var/sync.lock 里存 pid）：正在转录时不能删模型，否则会把任务搞崩
function isSyncRunning(settings) {
  const lockFile = path.join(projectStateDir(settings), "sync.lock");
  if (!fs.existsSync(lockFile)) return false;
  try {
    const pid = Number(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid || 0);
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch {
    return false;
  }
}

ipcMain.handle("model:status", (_e, settings) => modelStatusInfo(settings));

ipcMain.handle("model:repair", (event, settings) => {
  const s = settings || loadSettings();
  if (modelRepairing) return { ok: false, error: "模型正在下载中，请等当前任务结束" };
  if (isSyncRunning(s)) {
    return { ok: false, error: "正在处理视频，暂停或等这一批跑完再重新下载模型，避免把正在用的模型删掉" };
  }
  const send = (text) => {
    try { event.sender.send("pipeline:log", text); } catch {}
  };
  const before = modelStatusInfo(s);
  if (!before.ok && before.state === "no-lock") return { ok: false, error: before.message };
  if (before.state === "ok" || before.state === "custom") {
    return { ok: true, alreadyOk: true, state: before.state, message: before.message, status: before };
  }
  const scriptPath = path.join(s.projectPath, "scripts", "ensure-whisper-model.ps1");
  if (!fs.existsSync(scriptPath)) return { ok: false, error: "缺少模型下载脚本 ensure-whisper-model.ps1，软件可能不完整" };
  const psCandidates = [
    process.env.DOK_POWERSHELL,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe",
  ].filter(Boolean);
  const ps = psCandidates.find((p) => fs.existsSync(p)) || "powershell.exe";
  const stateDir = projectStateDir(s);
  const initEndpoint = s.modelEndpoint === "official" ? "https://huggingface.co" : "https://hf-mirror.com";
  const fallbackEndpoint = initEndpoint.includes("hf-mirror") ? "https://huggingface.co" : "https://hf-mirror.com";

  // 先清掉残缺/被锁死的模型目录：留下半截文件会让下载直接失败
  const modelsRoot = path.join(stateDir, "models");
  let cleaned = false;
  try {
    if (fs.existsSync(modelsRoot)) {
      for (const name of fs.readdirSync(modelsRoot)) {
        const full = path.join(modelsRoot, name);
        try {
          if (fs.statSync(full).isDirectory()) {
            fs.rmSync(full, { recursive: true, force: true });
            cleaned = true;
          }
        } catch {}
      }
    }
  } catch (err) {
    return { ok: false, error: `清理旧模型目录失败（可能被杀毒软件锁住）：${String(err && err.message || err)}` };
  }

  const runAttempt = (endpoint) => new Promise((resolve) => {
    const child = spawn(ps, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-ProjectRoot", s.projectPath,
      "-StateDir", stateDir,
      "-Endpoint", endpoint,
    ], { cwd: s.projectPath, env: envFor(s), windowsHide: true });
    bindChildOutput(child, { onOut: (t) => send(t), onErr: (t) => send(t) });
    child.on("error", (err) => resolve({ ok: false, error: String(err && err.message || err) }));
    child.on("close", (code) => resolve({ ok: code === 0, code }));
  });

  modelRepairing = true;
  return new Promise((resolve) => {
    (async () => {
      const mb = before.expectedBytes ? (before.expectedBytes / 1048576).toFixed(0) : "约 465";
      send(`[model] 开始重新下载转录模型（约 ${mb}MB），请保持网络通畅、不要关闭软件…\n`);
      if (cleaned) send("[model] 已清理旧的残缺模型目录\n");
      let result = await runAttempt(initEndpoint);
      if (!result.ok) {
        send(`[model] 下载源 ${initEndpoint} 失败，自动切换备用源 ${fallbackEndpoint} 重试…\n`);
        result = await runAttempt(fallbackEndpoint);
      }
      const status = modelStatusInfo(s);
      modelRepairing = false;
      if (status.state === "ok") {
        send("[model] 模型下载完成，校验通过 ✅\n");
        resolve({ ok: true, state: status.state, message: status.message, status });
      } else {
        const error = result.error
          || `下载未完成：${status.message}。常见原因：网络中断、代理拦截、杀毒软件把模型文件隔离。可把软件安装目录加入白名单后重试。`;
        send(`[model] 修复失败：${error}\n`);
        resolve({ ok: false, error, state: status.state, status });
      }
    })().catch((err) => {
      modelRepairing = false;
      resolve({ ok: false, error: String(err && err.message || err) });
    });
  });
});

ipcMain.handle("model:open-folder", async (_e, settings) => {
  const info = modelStatusInfo(settings);
  const target = info.modelDir || "";
  if (!target || !fs.existsSync(target)) return { ok: false, error: "模型目录还不存在（尚未下载成功）" };
  const msg = await shell.openPath(target);
  return { ok: msg === "", error: msg };
});

/* ==================== 内置自动更新 ==================== */
// 关键修复：electron-builder 没配 publish 时安装包里没有 app-update.yml，
// 原来直接 checkForUpdates() 必定失败。这里改成运行时写一份配置并 setFeedURL，
// 更新源由设置页填写（GitHub 仓库 owner/repo 或 generic 直链目录）。
const UPDATE_CACHE_DIR = "douyin-knowledge-updater";

let updateState = {
  state: "idle", // idle | unconfigured | checking | available | latest | downloading | downloaded | error
  version: "",
  info: null,
  progress: null,
  error: "",
  checkedAt: "",
};
let updaterInitialized = false;

function updateFeed(settings) {
  const repo = String(settings.updateRepo || "").trim();
  const url = String(settings.updateFeedUrl || "").trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    const [owner, name] = repo.split("/");
    return {
      provider: "github",
      owner,
      repo: name,
      config: `provider: github\nowner: ${owner}\nrepo: ${name}\nupdaterCacheDirName: ${UPDATE_CACHE_DIR}\n`,
    };
  }
  if (/^https?:\/\/\S+$/i.test(url)) {
    return {
      provider: "generic",
      url,
      config: `provider: generic\nurl: ${url}\nupdaterCacheDirName: ${UPDATE_CACHE_DIR}\n`,
    };
  }
  return null;
}

function friendlyUpdateError(err) {
  const text = String(err && (err.message || err) || "");
  if (/app-update\.yml|ENOENT/i.test(text)) return "更新配置缺失，请到设置页填写更新源（GitHub 仓库或直链目录）";
  if (/404|Not Found/i.test(text)) return "更新源里没找到最新版本文件（检查仓库地址 / 是否已上传 latest.yml）";
  if (/ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|net::ERR/i.test(text)) return "连不上更新服务器：网络不通或被代理拦截，请检查网络后重试";
  if (/sha512|checksum|signature/i.test(text)) return "安装包校验失败（可能下载不完整），请重试；反复失败说明发布包有问题";
  return text.replace(/\s+/g, " ").slice(0, 300) || "未知更新错误";
}

function pushUpdateState(patch) {
  // 带上真实版本号：渲染层每次收到事件都会重绘"当前版本"，缺了它会被空串覆盖
  updateState = { ...updateState, version: app.getVersion(), ...patch };
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send("update:event", updateState); } catch {}
  }
}

function applyUpdateFeed(settings) {
  const feed = updateFeed(settings);
  if (!feed) {
    pushUpdateState({ state: "unconfigured", error: "", progress: null });
    return { ok: false, error: "还没有配置更新源：到「设置 → 软件更新」填写 GitHub 仓库（owner/仓库名）或直链目录" };
  }
  try {
    const dir = path.join(app.getPath("userData"), "updater");
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, "app-update.yml");
    fs.writeFileSync(cfgPath, feed.config, "utf8");
    autoUpdater.updateConfigPath = cfgPath;
    if (feed.provider === "github") {
      autoUpdater.setFeedURL({ provider: "github", owner: feed.owner, repo: feed.repo });
    } else {
      autoUpdater.setFeedURL({ provider: "generic", url: feed.url });
    }
    return { ok: true, feed };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function initUpdater() {
  if (updaterInitialized) return;
  updaterInitialized = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (m) => console.log("[update]", m),
    warn: (m) => console.warn("[update]", m),
    error: (m) => console.error("[update]", m),
    debug: () => {},
  };
  autoUpdater.on("checking-for-update", () => pushUpdateState({ state: "checking", error: "", progress: null }));
  autoUpdater.on("update-available", (info) => {
    pushUpdateState({
      state: "available",
      error: "",
      checkedAt: new Date().toISOString(),
      info: {
        version: String(info.version || ""),
        releaseDate: String(info.releaseDate || ""),
        notes: String(info.releaseNotes || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600),
      },
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    pushUpdateState({
      state: "latest",
      error: "",
      progress: null,
      checkedAt: new Date().toISOString(),
      info: { version: String(info && info.version || app.getVersion()) },
    });
  });
  autoUpdater.on("download-progress", (p) => {
    pushUpdateState({
      state: "downloading",
      progress: {
        percent: Math.max(0, Math.min(100, Math.round(Number(p && p.percent) || 0))),
        transferred: Number(p && p.transferred || 0),
        total: Number(p && p.total || 0),
        bytesPerSecond: Number(p && p.bytesPerSecond || 0),
      },
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    pushUpdateState({
      state: "downloaded",
      progress: null,
      error: "",
      info: { version: String(info && info.version || "") },
    });
  });
  autoUpdater.on("error", (err) => pushUpdateState({ state: "error", error: friendlyUpdateError(err) }));
}

function updateStatusPayload(settings) {
  const s = settings || loadSettings();
  // 注意顺序：先铺状态，再用真实版本号覆盖，否则 updateState.version 的空串会盖掉 app.getVersion()
  return {
    ...updateState,
    version: app.getVersion(),
    packaged: app.isPackaged,
    configured: Boolean(updateFeed(s)),
    autoCheck: s.updateAutoCheck !== false,
    repo: String(s.updateRepo || ""),
    feedUrl: String(s.updateFeedUrl || ""),
  };
}

ipcMain.handle("update:status", (_e, settings) => updateStatusPayload(settings));

ipcMain.handle("update:check", async (_e, settings) => {
  const s = settings || loadSettings();
  if (!app.isPackaged) return { ok: false, error: "开发模式下不支持自动更新（请用安装版测试）" };
  initUpdater();
  const applied = applyUpdateFeed(s);
  if (!applied.ok) return { ok: false, error: applied.error };
  try {
    pushUpdateState({ state: "checking", error: "", progress: null });
    const result = await autoUpdater.checkForUpdates();
    const latest = result && result.updateInfo ? String(result.updateInfo.version || "") : "";
    return { ok: true, latest, updateAvailable: Boolean(latest && latest !== app.getVersion()), state: updateState };
  } catch (err) {
    const error = friendlyUpdateError(err);
    pushUpdateState({ state: "error", error });
    return { ok: false, error };
  }
});

ipcMain.handle("update:download", async () => {
  if (!app.isPackaged) return { ok: false, error: "开发模式下不支持自动更新" };
  if (updateState.state !== "available") return { ok: false, error: "当前没有可下载的新版本，请先检查更新" };
  try {
    pushUpdateState({ state: "downloading", error: "", progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } });
    autoUpdater.downloadUpdate().catch((err) => pushUpdateState({ state: "error", error: friendlyUpdateError(err) }));
    return { ok: true };
  } catch (err) {
    const error = friendlyUpdateError(err);
    pushUpdateState({ state: "error", error });
    return { ok: false, error };
  }
});

ipcMain.handle("update:install", () => {
  if (updateState.state !== "downloaded") return { ok: false, error: "更新包还没下载完成" };
  setImmediate(() => {
    try {
      // 第一个参数必须是 true（isSilent）。实测传 false 时，assisted 安装器（oneClick:false）
      // 会拉起「抖音知识库 安装」交互式向导并停在那里等用户点击，自动更新等于卡死；
      // 传 true 才会带 /S 静默覆盖安装。
      autoUpdater.quitAndInstall(true, true);
    } catch (err) { console.error("quitAndInstall failed:", err); }
  });
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  watchVault(loadSettings().vaultPath);
  // 启动时对齐一次 settings.json → project/config.json：
  // 1) 老版本只把 skipCategories 存在 settings.json，config.json 里一直是空的（勾了跳过不生效）；
  // 2) 全新安装的项目目录里没有 config.json（安装包故意排除，防止把 Key 一起发出去），
  //    这里补齐后引擎才能读到 AI 配置与库路径。
  try {
    const boot = loadSettings();
    const configFile = path.join(boot.projectPath, "config.json");
    const existed = fs.existsSync(configFile);
    const cfg = existed ? JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/u, "")) : {};
    const before = JSON.stringify(cfg);
    cfg.skipCategories = sanitizeSkipCategories(boot.skipCategories);
    if (boot.vaultPath) cfg.vaultPath = String(boot.vaultPath);
    if (boot.llmBaseUrl) cfg.llmBaseUrl = String(boot.llmBaseUrl);
    if (boot.llmModel) cfg.llmModel = String(boot.llmModel);
    if (boot.llmApiKey) cfg.llmApiKey = String(boot.llmApiKey);
    if (!existed || JSON.stringify(cfg) !== before) {
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      console.log("[boot] 已同步配置到 config.json：", existed ? "更新" : "新建");
    }
  } catch (err) {
    console.error("sync settings on boot failed:", err);
  }

  // 启动自检：模型状态只静默检测并交给界面（顶部横幅 + 一键重下），不再弹模态框。
  // 旧逻辑把路径写成 var/models/models--Systran--faster-whisper-small/model.bin，
  // 而真实目录是 var/models/Systran--faster-whisper-small/<revision>/model.bin，
  // 于是每次启动都误报"模型损坏"，反而误导用户去点修复。
  try {
    const status = modelStatusInfo(loadSettings());
    if (status.ok && status.state !== "ok" && status.state !== "custom") {
      console.warn("[model] 模型状态异常：", status.state, status.message);
    }
  } catch (err) {
    console.error("model self-check failed:", err);
  }

  // 内置自动更新：安装版 + 已配置更新源 + 用户没关自动检查 → 启动 8 秒后静默检查一次
  if (app.isPackaged) {
    initUpdater();
    const settings = loadSettings();
    if (settings.updateAutoCheck !== false && updateFeed(settings)) {
      setTimeout(() => {
        applyUpdateFeed(loadSettings());
        autoUpdater.checkForUpdates().catch((err) => {
          pushUpdateState({ state: "error", error: friendlyUpdateError(err) });
        });
      }, 8000);
    } else {
      pushUpdateState({ state: updateFeed(settings) ? "idle" : "unconfigured" });
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
