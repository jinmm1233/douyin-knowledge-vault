const { contextBridge, ipcRenderer, clipboard } = require("electron");

// ---- 轻量 Markdown 渲染（覆盖 Obsidian 笔记常用语法，无第三方依赖） ----
function renderMarkdown(md) {
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // 保护原始 HTML 标签（如共识文档里的橙色补充 <span style="color:#d35400">…</span>）
  const protect = (text) => {
    const held = [];
    const t = String(text).replace(/<span[^>]*>.*?<\/span>/g, (m) => {
      held.push(m);
      return `\u0000SP${held.length - 1}\u0000`;
    });
    return { text: t, held };
  };
  const restore = (t, held) => t.replace(/\u0000SP(\d+)\u0000/g, (_m, i) => held[Number(i)] || "");

  // Obsidian 双链 [[笔记|别名]] → 可点击跳转（笔记标题可能含 # 话题标签，故不排除 #）
  const linkify = (text) =>
    text.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, target, alias) => {
      const label = alias || target;
      return `<a href="#" class="note-link" data-target="${encodeURIComponent(target)}">${esc(label)}</a>`;
    });

  const inline = (text) => {
    const { text: t, held } = protect(text);
    let out = esc(t);
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/==([^=]+)==/g, "<mark>$1</mark>");
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = linkify(out);
    return restore(out, held);
  };

  const lines = String(md || "").split(/\r?\n/);
  let html = "";
  let inCode = false;
  let codeBuf = [];
  let listType = null;
  const flushList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^```/.test(line)) {
      if (inCode) {
        html += "<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>";
        codeBuf = [];
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushList();
      html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
      continue;
    }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") {
        flushList();
        html += "<ul>";
        listType = "ul";
      }
      html += `<li>${inline(ul[1])}</li>`;
      continue;
    }
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") {
        flushList();
        html += "<ol>";
        listType = "ol";
      }
      html += `<li>${inline(ol[1])}</li>`;
      continue;
    }
    flushList();
    if (line.trim() === "") continue;
    html += `<p>${inline(line)}</p>`;
  }
  flushList();
  if (inCode) html += "<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>";
  return html;
}

contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  vaultTree: (vaultPath) => ipcRenderer.invoke("vault:tree", vaultPath),
  wordTree: () => ipcRenderer.invoke("word:tree"),
  openWord: (p) => ipcRenderer.invoke("word:open", p),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  vaultRead: (vaultPath, filePath) => ipcRenderer.invoke("vault:read", { vaultPath, filePath }),
  openInObsidian: (vaultPath) => ipcRenderer.invoke("vault:openInObsidian", vaultPath),
  runPipeline: (settings, args) => ipcRenderer.invoke("pipeline:run", settings, args),
  loginDouyin: (settings) => ipcRenderer.invoke("pipeline:login", settings),
  authStatus: (settings) => ipcRenderer.invoke("pipeline:authStatus", settings),
  onLog: (cb) => ipcRenderer.on("pipeline:log", (_e, chunk) => cb(chunk)),
  onVaultChanged: (cb) => ipcRenderer.on("vault:changed", () => cb()),
  cancelPipeline: () => ipcRenderer.send("pipeline:cancel"),
  renderMarkdown: (text) => renderMarkdown(text),
  statsOverview: (settings) => ipcRenderer.invoke("stats:overview", settings),
  vaultSearch: (settings, query) => ipcRenderer.invoke("vault:search", { vaultPath: settings.vaultPath, query }),
  vaultWrite: (filePath, content) => ipcRenderer.invoke("vault:write", { path: filePath, content }),
  vaultGraph: (settings) => ipcRenderer.invoke("vault:graph", settings.vaultPath),
  distillEstimate: (settings, sel) => ipcRenderer.invoke("distill:estimate", settings, sel),
  distillRun: (settings, sel) => ipcRenderer.invoke("distill:run", settings, sel),
  distillList: (settings) => ipcRenderer.invoke("distill:list", settings),
  distillDelete: (settings, name) => ipcRenderer.invoke("distill:delete", settings, name),
  chatAsk: (settings, payload) => ipcRenderer.invoke("chat:ask", settings, payload),
  weeklyAiSummary: (settings, data) => ipcRenderer.invoke("weekly:aiSummary", settings, data),
  weeklyAiDirection: (settings, data) => ipcRenderer.invoke("weekly:aiDirection", settings, data),
  weeklyBalance: (settings) => ipcRenderer.invoke("weekly:balance", settings),
  scheduleStatus: (settings) => ipcRenderer.invoke("schedule:status", settings),
  scheduleSet: (payload) => ipcRenderer.invoke("schedule:set", payload),
  collectsList: (settings) => ipcRenderer.invoke("collects:list", settings),
  startCollect: (settings, payload) => ipcRenderer.invoke("collects:start", settings, payload),
  cardsList: (settings) => ipcRenderer.invoke("cards:list", settings),
  cardsRead: (settings, major) => ipcRenderer.invoke("cards:read", settings, major),
  cardsDelete: (settings, major) => ipcRenderer.invoke("cards:delete", settings, major),
  cardsGenerate: (settings, major) => ipcRenderer.invoke("cards:generate", settings, major),
  categoriesManage: (settings, args) => ipcRenderer.invoke("categories:manage", settings, args),
  failuresList: (settings) => ipcRenderer.invoke("failures:list", settings),
  newArrivals: (settings, payload) => ipcRenderer.invoke("newarrivals:list", settings, payload),
  notes: (settings, payload) => ipcRenderer.invoke("notes:list", settings, payload),
  highlight: (payload) => ipcRenderer.invoke("highlight:run", payload),
  addVideos: (settings, payload) => ipcRenderer.invoke("videos:add", settings, payload),
  pauseSync: (settings) => ipcRenderer.invoke("sync:pause", settings),
  resumeSync: (settings) => ipcRenderer.invoke("sync:resume", settings),
  pauseStatus: (settings) => ipcRenderer.invoke("sync:pause-status", settings),
  // 强制终止：杀掉当前所有处理进程（含子进程树），并清理残留锁
  forceStop: (settings) => ipcRenderer.invoke("pipeline:force-stop", settings),
  onPipelineStopped: (cb) => ipcRenderer.on("pipeline:stopped", (_e, payload) => cb(payload)),
  cleanupMedia: (settings) => ipcRenderer.invoke("cleanup:media", settings),
  copyText: (t) => clipboard.writeText(String(t)),
  llmTest: (settings) => ipcRenderer.invoke("llm:test", settings),
  vipRedeem: (url, code, device) => ipcRenderer.invoke("vip:redeem", { url, code, device }),
  vipIssue: (info) => ipcRenderer.invoke("vip:issue", info),
  vipVerify: () => ipcRenderer.invoke("vip:verify"),
  resetStuck: () => ipcRenderer.invoke("sync:reset-stuck"),
  weeklyStats: (settings) => ipcRenderer.invoke("weekly:stats", settings),
  weeklyAck: (payload) => ipcRenderer.invoke("weekly:ack", payload),
  // 登录浏览器：诊断可用浏览器 / 清空浏览器登录缓存
  browserDiagnose: (settings) => ipcRenderer.invoke("browser:diagnose", settings),
  browserResetProfile: () => ipcRenderer.invoke("browser:reset-profile"),
  // 转录模型：状态检测 / 重新下载 / 打开模型目录
  modelStatus: (settings) => ipcRenderer.invoke("model:status", settings),
  modelRepair: (settings) => ipcRenderer.invoke("model:repair", settings),
  modelOpenFolder: (settings) => ipcRenderer.invoke("model:open-folder", settings),
  // 被跳过的视频（内容类型误判 / 无音频等永久失败 / 早于起始日期）：列出 / 补笔记 / 重新处理
  skippedList: (settings) => ipcRenderer.invoke("skipped:list", settings),
  skippedRestore: (settings, awemeIds) => ipcRenderer.invoke("skipped:restore", settings, awemeIds),
  skippedRetry: (settings, awemeIds) => ipcRenderer.invoke("skipped:retry", settings, awemeIds),
  // 内置自动更新：状态 / 检查 / 下载 / 安装 + 事件推送
  updateStatus: (settings) => ipcRenderer.invoke("update:status", settings),
  updateCheck: (settings) => ipcRenderer.invoke("update:check", settings),
  updateDownload: () => ipcRenderer.invoke("update:download"),
  updateInstall: () => ipcRenderer.invoke("update:install"),
  onUpdateEvent: (cb) => ipcRenderer.on("update:event", (_e, payload) => cb(payload)),
});
