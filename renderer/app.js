/* 抖音知识库桌面版 - 渲染进程 */
let settings = null;
let vipState = { active: false };   // 会员状态：启动时由主进程验票后写入，界面只信它，不直接读 settings.vip.active
let treeCache = null;
let currentNote = null;   // { path, parts, title }
let editing = false;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ================= 页面路由 ================= */
const PAGES = ["dashboard", "new", "knowledge", "search", "pipeline", "skills", "blueprint", "failures", "distill", "settings"];

let lastPage = null;
function switchPage(name) {
  closeMenu();
  for (const p of PAGES) {
    $(`page-${p}`).hidden = p !== name;
    document.querySelector(`.nav-item[data-page="${p}"]`).classList.toggle("active", p === name);
  }
  try { localStorage.setItem("dok-page", name); } catch {}
  // 页面切换过渡：淡入 + 轻微上移（彩蛋页面动效，随开关与成就门控）
  if (pageFxOn("pageFxTransition") && lastPage && name !== lastPage) {
    const t = $(`page-${name}`);
    t.classList.remove("page-enter");
    void t.offsetWidth;
    t.classList.add("page-enter");
  }
  lastPage = name;
  if (name === "knowledge") renderFolders();
  if (name === "distill") loadDistillPicker();
  if (name === "dashboard") loadOverview();
  if (name === "new") loadNewArrivals();
  if (name === "settings") { loadScheduleStatus(); renderSkins(); renderMaterials(); renderMotions(); renderSkinFx(); renderMotionPanel(); }
  if (name === "search") loadGlobalSearch();
  if (name === "pipeline") loadPipelinePage();
  if (name === "skills") loadSkillsPage();
  if (name === "blueprint") renderBlueprint();
  if (name === "failures") loadFailures();
  if (name !== "knowledge") closeReader();
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => switchPage(btn.dataset.page));
});

/* ================= 日志 ================= */
let logBuf = "";
function appendLog(chunk) {
  logBuf += chunk;
  if (logBuf.length > 60000) logBuf = logBuf.slice(-60000);
  const pipe = $("pipe-log");
  if (pipe && !pipe.hidden) { pipe.textContent = logBuf; pipe.scrollTop = pipe.scrollHeight; }
  const body = $("log-body");
  body.textContent = logBuf;
  body.scrollTop = body.scrollHeight;
}
window.api.onLog(appendLog);

function openLogPanel() { $("log-panel").hidden = false; }
$("btn-log-close").addEventListener("click", () => { $("log-panel").hidden = true; });

/* ================= 界面材质（毛玻璃/亚克力/云母/3D 立体） ================= */
const MATERIALS = [
  { key: "acrylic", icon: "💎", name: "亚克力",   desc: "厚实通透，带高光质感" },
  { key: "glass",   icon: "🪟", name: "毛玻璃",   desc: "轻透模糊，壁纸若隐若现" },
  { key: "mica",    icon: "🪞", name: "云母",     desc: "细腻珠光，柔和染色" },
  { key: "3d",      icon: "🧊", name: "3D 立体",  desc: "凸起悬浮，光影分明" },
];
function applyMaterial(key) {
  // 界面材质属于彩蛋：非会员或未集齐全部成就时锁定默认亚克力
  if (!eggUnlocked()) key = "acrylic";
  const m = MATERIALS.find((x) => x.key === key);
  document.body.setAttribute("data-material", m ? m.key : "acrylic");
  document.querySelectorAll(".material-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.material === key);
  });
}
function renderMaterials() {
  const panel = $("material-panel");
  if (!panel) return;
  panel.hidden = !eggUnlocked(); // 非会员或未集齐成就时整块隐藏，与动效彩蛋一致
  const grid = $("material-grid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const m of MATERIALS) {
    const card = document.createElement("div");
    card.className = "material-card";
    card.dataset.material = m.key;
    card.innerHTML = `<div class="material-icon">${m.icon}</div>
      <div class="material-name">${esc(m.name)}</div>
      <div class="material-desc">${esc(m.desc)}</div>`;
    card.addEventListener("click", async () => {
      settings = await window.api.saveSettings({ cardMaterial: m.key });
      applyMaterial(m.key);
    });
    grid.appendChild(card);
  }
  const cur = settings.cardMaterial || "acrylic";
  grid.querySelectorAll(".material-card").forEach((c) => c.classList.toggle("active", c.dataset.material === cur));
}

/* ================= 彩蛋页面动效（切换过渡/数字跳动/交错入场/成功庆祝） ================= */
const PAGE_FX_OPTS = [
  { key: "pageFxTransition", icon: "🔄", title: "页面切换过渡", desc: "切页时淡入 + 轻微上移" },
  { key: "pageFxNumbers",    icon: "🔢", title: "数字跳动",     desc: "总览统计数字依次弹跳涨起" },
  { key: "pageFxStagger",    icon: "🃏", title: "卡片交错入场", desc: "知识库卡片错开依次浮入" },
  { key: "pageFxCelebrate",  icon: "🎉", title: "成功庆祝",     desc: "处理 / 蒸馏完成时轻量脉冲" },
];
function pageFxOn(key) {
  return eggUnlocked() && settings[key] !== false;
}
// 成功庆祝：对目标元素做一次轻量弹跳脉冲
function celebrate(el) {
  if (!el || !pageFxOn("pageFxCelebrate")) return;
  el.classList.remove("celebrate");
  void el.offsetWidth;
  el.classList.add("celebrate");
}

/* ================= 总览 ================= */
async function loadOverview() {
  const grid = $("stat-grid");
  grid.innerHTML = "<div class='panel' style='grid-column:1/-1;color:var(--text-2)'>加载中…</div>";
  const [stats, tree] = await Promise.all([
    window.api.statsOverview(settings),
    window.api.vaultTree(settings.vaultPath),
  ]);
  const counts = stats.ok ? stats.counts : {};
  const catCount = tree.categories.length;
  const notes = tree.categories.reduce((n, c) => n + c.groups.reduce((m, g) => m + g.subs.reduce((k, s) => k + s.files.length, 0), 0), 0);
  const items = [
    { cls: "blue", num: counts.written ?? 0, label: "已完成总结", note: "已生成笔记" },
    { cls: "green", num: counts.discovered ?? 0, label: "待处理", note: "尚未转录" },
    { cls: "amber", num: counts.failed ?? 0, label: "失败重试", note: "可再次尝试" },
    { cls: "red", num: counts.skipped ?? 0, label: "已跳过", note: "广告/短剧/娱乐类" },
    { cls: "purple", num: catCount, label: "知识库分类", note: "大类数量" },
    { cls: "slate", num: notes, label: "笔记总数", note: "Obsidian 笔记" },
  ];
  grid.innerHTML = "";
  for (const it of items) {
    const c = document.createElement("div");
    c.className = `stat-card ${it.cls}`;
    c.innerHTML = `<div class="stat-num">${it.num}</div>
      <div class="stat-label">${esc(it.label)}</div>
      <div class="stat-note">${esc(it.note)}</div>`;
    grid.appendChild(c);
  }
  // 数字跳动：统计数字依次弹跳涨起（彩蛋页面动效）
  if (pageFxOn("pageFxNumbers")) {
    grid.querySelectorAll(".stat-num").forEach((el, i) => {
      el.style.animationDelay = (i * 60).toFixed(0) + "ms";
      el.classList.add("num-pop");
    });
  }
  if (stats.ok && stats.total > 0) {
    $("side-foot").textContent = `共 ${stats.total} 条收藏 · 处理率 ${Math.round(((counts.written || 0) / stats.total) * 100)}%`;
  }
  // 首次处理收藏进度条（非每日任务）：窗口内已处理 vs 剩余未处理
  // 两种窗口：按时间 = 起始日期之后新增收藏的视频（discovered_at 口径）；按数量 = 设置时固定的"最近 N 条"快照（后续新收藏不计入）
  const firstBar = $("first-bar");
  const firstLabel = $("first-bar-label");
  const firstMeta = $("first-run-meta");
  if (firstBar && firstMeta) {
    const remaining = stats.ok ? (stats.remaining ?? 0) : 0;
    const done = stats.ok ? (stats.done ?? 0) : 0;
    const total = done + remaining;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    firstBar.style.width = pct + "%";
    if (firstLabel) firstLabel.textContent = pct + "%";
    const countMode = stats.countMode && stats.countLimit > 0;
    firstMeta.innerHTML = total > 0
      ? countMode
        ? `按数量（最近 ${stats.countLimit} 条快照）：已完成 <b>${done}</b> 条 · 还剩 <b>${remaining}</b> 条未处理（快照在设置保存时定好，之后新收藏不计入这 ${stats.countLimit} 条）`
        : (stats.windowStart ? `起始日期 ${stats.windowStart} 之后新增收藏的视频：` : "全部收藏：") + `已完成 <b>${done}</b> 条 · 还剩 <b>${remaining}</b> 条未处理${stats.windowStart ? "（改日期会自动联动重算并继续处理更早新增收藏的视频）" : ""}`
      : "还没有收藏数据，点击「开始处理收藏」启动首次处理。";
  }
  loadScheduleStatus();
}

/* ================= 定时任务 ================= */
async function loadScheduleStatus() {
  const meta = $("schedule-meta");
  const bar = $("sched-bar");
  const barLabel = $("sched-bar-label");
  const alert = $("schedule-alert");
  const inst = $("sched-installed");
  const logPre = $("sched-log");
  const res = await window.api.scheduleStatus(settings);
  if (!res || !res.ok) {
    if (meta) meta.textContent = "无法读取定时任务状态：" + ((res && res.error) || "未知错误");
    if (inst) inst.textContent = "读取失败";
    return;
  }
  const task = res.task || {};
  const counts = res.counts || {};
  // 定时任务面板进度条 = 【今日定时任务/手动同步运行】的实时进度（读 var\sync-progress.json），
  // 与总览"首次处理收藏"的窗口进度条（first-bar）完全分离：今天这次任务跑完 = 100%。
  //   运行中 → 显示 done/total 实时百分比；
  //   已结束（含空窗口 0/0）→ 100%（今日任务已完成）；
  //   无进度文件但上次运行失败 → 失败提示（0%，不冒充 100%）；
  //   从未运行 → "尚未运行过"。
  const progress = res.progress;
  let barPct = 0;
  let barText = "";
  const wasSkipped = !!(progress && progress.skipped);
  if (progress && progress.running) {
    const t = (progress.total || 0);
    barPct = t > 0 ? Math.round(((progress.done || 0) / t) * 100) : 0;
    barText = `今日任务运行中 ${progress.done || 0}/${t}（${barPct}%）${progress.stage ? " · " + progress.stage : ""}`;
  } else if (progress && progress.skipped) {
    barPct = 0;
    barText = `今日任务被跳过（存在同步锁/上次同步未结束）· 0%`;
  } else if (progress && progress.finishedAt) {
    barPct = 100;
    barText = `今日任务已完成（${progress.done || 0}/${progress.total || 0}）· 100%`;
  } else if (progress && progress.error) {
    barPct = 0;
    barText = `今日任务失败：${String(progress.error).slice(0, 60)}`;
  } else if (task.lastRun) {
    if (task.lastResult === 0) {
      barPct = 100;
      barText = `今日任务已完成 · 100%`;
    } else {
      barPct = 0;
      barText = `今日任务失败（返回码 ${task.lastResult}）· 0%`;
    }
  } else {
    barPct = 0;
    barText = `定时任务尚未运行过`;
  }
  if (bar) {
    bar.style.width = barPct + "%";
    if (barPct >= 100) bar.classList.add("bar-done");
    else bar.classList.remove("bar-done");
  }
  if (barLabel) barLabel.textContent = barText;

  if (meta) {
    let html = "";
    if (!task.exists) {
      html = '<b class="bad">未安装定时任务</b> · 可在「设置 → 定时任务」里更新时间（会同时安装）';
    } else {
      const stateCls = task.enabled ? "ok" : "warn";
      const stateTxt = task.enabled ? "已启用" : "已停用";
      html = `任务状态：<b class="${stateCls}">${stateTxt}</b> · 下次运行：<b>${esc(task.nextRun || "—")}</b>`;
      if (task.lastRun) {
        const resCls = task.lastResult === 0 ? "ok" : "bad";
        const resTxt = wasSkipped ? "上次运行被跳过（同步锁）" : (task.lastResult === 0 ? "上次运行成功 ✓" : `上次运行失败（代码 ${task.lastResult}）`);
        html += ` · <span class="${resCls}">${resTxt}</span>（${esc(task.lastRun)}）`;
      }
    }
    const pending = (counts.discovered || 0) + (counts.media_frozen || 0) + (counts.transcribed || 0) + (counts.extracted || 0) + (counts.failed || 0);
    const countMode = res.countMode && res.countLimit > 0;
    const windowDesc = countMode ? `按数量（最近 ${res.countLimit} 条快照）` : (res.windowStart ? `起始日期 ${res.windowStart} 之后新增收藏的视频` : "全部收藏");
    // 待处理口径：按数量/按时间窗口 → 窗口内待处理总数；全库模式 → 每日任务今日候选（昨日新增 + 失败重试，随日期变化）
    const dailyTaskPending = !countMode && !res.windowStart && res.dailyWindow ? res.dailyWindow.total : null;
    const pendingShown = dailyTaskPending !== null ? dailyTaskPending : pending;
    const pendingNote = dailyTaskPending !== null ? "（每日任务范围 = 昨日新增 + 失败重试，随日期变化）" : "";
    html += `<div class="sched-hint" style="margin-top:8px">定时任务进度条 = <b>今天这次任务</b>的实时进度（跑完=100%，与总览下方「首次处理收藏」的整体进度条是分开的：那个进度条按处理窗口计算——未设置起始日期或条数时默认处理<b>全部收藏</b>，设置了起始日期则只处理其后的收藏、设置了条数则只处理最近 N 条快照）。当前窗口（${windowDesc}）：已生成 <b>${counts.written || 0}</b> · 已跳过 <b>${counts.skipped || 0}</b> · 待处理 <b>${pendingShown}</b>${pendingNote}</div>`;
    meta.innerHTML = html;
  }

  if (alert) {
    alert.hidden = true;
    const notes = [];
    if (res.selfHeal && res.selfHeal.length) {
      notes.push(`<b>🛠 系统已自动修复：</b>${res.selfHeal.map((s) => esc(s)).join("<br>")}`);
    }
    if (task.exists && task.lastRun && task.lastResult !== 0) {
      notes.push(`上次定时运行失败（返回码 ${task.lastResult}，${task.lastRun}）`);
    }
    if (res.lock) {
      const ageMin = Math.round((Date.now() - new Date(res.lock.mtime).getTime()) / 60000);
      if (ageMin < 120) notes.push(`正在同步中（锁于 ${ageMin} 分钟前创建）…`);
      else notes.push(`检测到同步残留锁（${ageMin} 分钟前创建）：多半是上次同步异常退出。<button class="reset-stuck-btn">一键复位进度</button>`);
    }
    if (res.aiDiagnosis) {
      notes.push(`<b>AI 诊断：</b>` + esc(res.aiDiagnosis).split(" | ").join("<br>"));
    } else if (task.exists && task.lastRun && task.lastResult !== 0) {
      notes.push(`详细失败日志见「流水线」页运行日志窗口，或「设置 → 定时任务 → 调度日志」。`);
    }
    if (notes.length) {
      alert.hidden = false;
      alert.innerHTML = notes.join("<br>");
      const resetBtn = alert.querySelector(".reset-stuck-btn");
      if (resetBtn) resetBtn.addEventListener("click", doResetStuck);
    }
  }

  if (inst) {
    if (!task.exists) {
      inst.innerHTML = '定时任务未安装 · 点击「更新时间」即会安装为每日任务并生效。';
    } else {
      inst.innerHTML =
        `任务：<b>已安装</b> · 状态：<b class="${task.enabled ? "ok" : "bad"}">${task.enabled ? "启用" : "停用"}</b> · 下次运行 <b>${esc(task.nextRun || "—")}</b>` +
        (task.lastRun
          ? ` · 上次 <b class="${task.lastResult === 0 ? "ok" : "bad"}">${task.lastResult === 0 ? "成功" : "失败(" + task.lastResult + ")"}</b>（${esc(task.lastRun)}）`
          : "");
      if (task.startBoundary) {
        const m = /T(\d{2}:\d{2})/.exec(task.startBoundary);
        if (m && $("sched-time")) $("sched-time").value = m[1];
      }
    }
  }
  if (logPre) logPre.textContent = res.logTail || "（暂无调度日志）";
}

$("btn-sched-set").addEventListener("click", async () => {
  const t = $("sched-time").value;
  if (!/^\d{1,2}:\d{2}$/.test(t)) return;
  $("sched-installed").textContent = "正在更新定时任务…";
  const res = await window.api.scheduleSet({ time: t });
  $("sched-installed").textContent = res.ok ? "已更新 ✓ 每天 " + t + " 自动同步" : ("更新失败：" + (res.error || "未知错误"));
  loadScheduleStatus();
});

$("btn-sched-enable").addEventListener("click", async () => {
  const res = await window.api.scheduleSet({ enable: true });
  $("sched-installed").textContent = res.ok ? "已启用 ✓" : ("启用失败：" + (res.error || "未知错误"));
  loadScheduleStatus();
});

$("btn-sched-disable").addEventListener("click", async () => {
  const res = await window.api.scheduleSet({ enable: false });
  $("sched-installed").textContent = res.ok ? "已停用（不再自动同步，随时可重新启用）" : ("停用失败：" + (res.error || "未知错误"));
  loadScheduleStatus();
});

$("dash-refresh").addEventListener("click", loadOverview);
$("dash-process-one").addEventListener("click", async () => {
  openLogPanel();
  appendLog("\n==== 开始处理 1 条 ====\n");
  await window.api.runPipeline(settings, ["sync"]);
  appendLog("\n==== 完成 ====\n");
  loadOverview();
});
$("dash-batch").addEventListener("click", async () => {
  openLogPanel();
  appendLog("\n==== 批量处理 20 条（断网自动续跑）====\n");
  await window.api.runPipeline(settings, ["sync", "--newest", "20"]);
  appendLog("\n==== 完成 ====\n");
  loadOverview();
});

/* ================= 首次处理收藏（总览） ================= */
// 模式切换：全部收藏 vs 指定收藏夹
document.querySelectorAll('input[name="collect-mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    $("collect-folder-row").hidden = !$("cm-folder").checked;
  });
});

// 更新收藏夹列表（folders 采集器）
async function refreshCollectFolders(silent = false) {
  const select = $("collect-folder-select");
  const status = $("collect-status");
  if (!silent) status.textContent = "正在加载收藏夹…";
  const res = await window.api.collectsList(settings);
  if (!res.ok) {
    if (!silent) status.textContent = "加载失败：" + (res.error || "未知错误");
    return [];
  }
  const folders = res.folders || [];
  select.innerHTML = "";
  if (!folders.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "（没有找到收藏夹，请先在抖音创建收藏夹）";
    select.appendChild(o);
  } else {
    for (const f of folders) {
      const o = document.createElement("option");
      o.value = f.collects_id;
      o.dataset.name = f.name;
      o.textContent = `${f.name}（${f.total} 条）`;
      select.appendChild(o);
    }
  }
  if (!silent) status.textContent = `已加载 ${folders.length} 个收藏夹`;
  return folders;
}
$("collect-folders-refresh").addEventListener("click", () => refreshCollectFolders(false));

// 弹窗持久化标记：设定日期后不再询问
function dateAskAcknowledged() {
  return !!(settings.startDateAcknowledged || settings.startDate);
}

// 开始处理收藏：检查登录 → 询问日期 → 采集+导入+处理
async function startCollectFlow() {
  const status = $("collect-status");
  const mode = $("cm-folder").checked ? "folder" : "all";
  if (mode === "folder" && !$("collect-folder-select").value) {
    status.textContent = "请先选择要处理的收藏夹（或点「更新收藏夹」加载）";
    return;
  }
  status.textContent = "正在检查抖音登录状态…";
  const auth = await window.api.authStatus(settings);
  const authOk = auth && auth.ok;
  if (!authOk) {
    status.textContent = "未登录抖音：请先在设置页点击「打开抖音扫码登录」完成扫码。";
    // 弹窗提示 + 去登录
    const overlay = $("login-ask-overlay");
    overlay.hidden = false;
    $("login-ask-go").onclick = () => {
      overlay.hidden = true;
      switchPage("settings");
    };
    return;
  }
  // 询问起始日期（仅首次，设定日期后不再询问）
  if (!dateAskAcknowledged()) {
    const overlay = $("date-ask-overlay");
    overlay.hidden = false;
    await new Promise((resolve) => {
      const yes = () => { overlay.hidden = true; resolve("yes"); };
      const no = async () => {
        overlay.hidden = true;
        // 用户选择"处理所有收藏"：标记已确认，避免下次再问
        settings = await window.api.saveSettings({ startDateAcknowledged: true });
        resolve("no");
      };
      $("date-ask-yes").onclick = yes;
      $("date-ask-no").onclick = no;
    }).then((choice) => {
      if (choice === "yes") {
        status.textContent = "请在设置页设置处理方式与范围：按时间（只处理视频发布时间在起始日期之后的收藏）、按数量（最近 N 条快照）、或处理全部收藏。保存后回来点击「开始处理收藏」。";
        switchPage("settings");
        return;
      }
      runCollectFlow(mode);
    });
    return;
  }
  runCollectFlow(mode);
}

async function runCollectFlow(mode) {
  const status = $("collect-status");
  status.textContent = "开始处理收藏…（进度见流水线日志）";
  openLogPanel();
  const payload = { mode, startDate: (settings.startDate || "").trim(), limit: Math.max(1, Number(settings.dailyLimit) || 100) };
  if (mode === "folder") {
    const select = $("collect-folder-select");
    payload.collectsId = select.value;
    payload.collectsName = select.selectedOptions[0]?.dataset?.name || "";
  }
  appendLog(`\n==== 开始处理收藏（${mode === "folder" ? `收藏夹：${payload.collectsName}` : "全部收藏"}）====\n`);
  const res = await window.api.startCollect(settings, payload);
  appendLog(res && res.cancelled ? "\n==== 已取消 ====\n" : res && res.ok ? "\n==== 本轮完成 ====\n" : `\n==== 处理结束（${(res && res.error) || "部分失败，见日志"}）====\n`);
  status.textContent = res && res.ok ? "本轮处理完成" : ((res && res.error) || "处理结束，详见日志");
  if (res && res.ok) celebrate($("dash-start-collect"));
  loadOverview();
}
$("dash-start-collect").addEventListener("click", startCollectFlow);

/* ================= 知识库（逐层卡片墙 + 全屏阅读） ================= */
const DOT_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6", "#f97316", "#0ea5e9", "#84cc16", "#ec4899", "#6366f1", "#06b6d4"];

function colorFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return DOT_COLORS[h % DOT_COLORS.length];
}

// 浏览层级：[] = 大类墙；[大类] = 父类墙；[大类, 父类] = 子类墙；[大类, 父类, 子类] = 笔记墙
let folderPath = [];
let kbGroup = ""; // 右上角分组下拉当前值

const FOLDER_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const DOC_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v4h4"/></svg>`;

function folderCard(label, meta, { badge, onClick, active = false, empty = false, onManage } = {}) {
  const el = document.createElement("div");
  el.className = "folder-card" + (active ? " active" : "") + (empty ? " empty" : "");
  el.innerHTML = `
    <div class="f-icon">${FOLDER_SVG}</div>
    <div class="f-name">${esc(label)}</div>
    <div class="f-meta">${esc(meta)}</div>
    ${badge ? `<div class="f-badges"><span class="f-badge">${esc(badge)}</span></div>` : ""}
    ${onManage ? `<div class="card-more" title="分类管理">⋯</div>` : ""}`;
  if (onClick && !empty) el.addEventListener("click", onClick);
  if (onManage) {
    el.querySelector(".card-more").addEventListener("click", (ev) => {
      ev.stopPropagation();
      showCardMenu(ev.currentTarget, onManage());
    });
  }
  return el;
}

function noteCard(title, { consensus = false, onManage } = {}) {
  const el = document.createElement("div");
  el.className = "note-card" + (consensus ? " nc-consensus" : "");
  el.innerHTML = `
    <div class="nc-top">
      <div class="nc-ico">${consensus ? "✦" : DOC_SVG}</div>
      <div class="nc-title">${esc(title)}</div>
      ${onManage ? `<div class="card-more" title="笔记操作">⋯</div>` : ""}
    </div>
    ${consensus ? `<span class="nc-badge">✦ 共识观点 · 多视频互相印证</span>` : `<div class="nc-sub">单条视频笔记</div>`}`;
  if (onManage) {
    el.querySelector(".card-more").addEventListener("click", (ev) => {
      ev.stopPropagation();
      showCardMenu(ev.currentTarget, onManage());
    });
  }
  return el;
}

// 右上角分组下拉
function populateGroupSelect() {
  const sel = $("kb-group");
  const cur = sel.value;
  sel.innerHTML = `<option value="">全部分组</option>`;
  if (!treeCache) return;
  for (const c of treeCache.categories) {
    const o = document.createElement("option");
    o.value = c.name;
    o.textContent = c.name;
    sel.appendChild(o);
  }
  sel.value = cur;
}
$("kb-group").addEventListener("change", () => {
  kbGroup = $("kb-group").value;
  folderPath = kbGroup ? [kbGroup] : [];
  closeReader();
  renderFolders();
});
// 知识库手动刷新：重新扫描文件系统（Obsidian 里新增/删除/改名笔记后点一下即可看到）
$("kb-refresh").addEventListener("click", () => { renderFolders(); toast("已刷新知识库 ✓"); });

/* ================= 打赏作者 ================= */
// 说明：弹窗 DOM 位于 <script> 之后，必须等 DOMContentLoaded 再绑定，否则 × 等关闭按钮绑定不到
document.addEventListener("DOMContentLoaded", () => {
  const DONATE_COPY = {
    "3.33": "微信打赏 3.33 元，请作者喝杯可乐，感谢支持「抖音知识库」！",
    "6.66": "微信打赏 6.66 元，请作者喝杯奶茶，感谢支持「抖音知识库」！",
    "8.88": "微信打赏 8.88 元，请作者加个鸡腿，感谢支持「抖音知识库」！",
    "16.88": "微信打赏 16.88 元，请作者吃顿午饭，感谢支持「抖音知识库」！",
  };
  const QR_GENERAL = "../assets/donate/wechat-qr.jpg";
  const donateModal = $("donate-modal");
  function openDonate(amt, label) {
    const img = $("donate-modal-img");
    // 固定金额收款码（assets/donate/donate-<金额>.png）；缺失时回退通用码
    img.onload = null;
    img.onerror = () => { img.src = QR_GENERAL; };
    img.src = `../assets/donate/donate-${amt}.png`;
    $("donate-modal-title").textContent = `微信打赏 ${amt} 元`;
    $("donate-modal-amt").textContent = `${amt} 元 · ${label}，扫码即可付款`;
    donateModal.hidden = false;
    $("donate-hint").textContent = "";
  }
  function closeDonate() { donateModal.hidden = true; }
  document.querySelectorAll(".donate-btn").forEach((btn) =>
    btn.addEventListener("click", () => openDonate(btn.dataset.amt, btn.dataset.label))
  );
  $("donate-modal-x").addEventListener("click", closeDonate);
  donateModal.addEventListener("click", (e) => { if (e.target === donateModal) closeDonate(); });
  $("donate-modal-copy").addEventListener("click", () => {
    const amt = $("donate-modal-amt").textContent.split(" ")[0];
    const text = DONATE_COPY[amt] || `微信打赏 ${amt} 元，感谢支持「抖音知识库」！`;
    window.api.copyText(text);
    toast("打赏提示已复制到剪贴板 ✓");
    closeDonate();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !donateModal.hidden) closeDonate(); });
});

/* ================= 分类管理（重命名 / 新建 / 移动） ================= */
let toastTimer = null;
function toast(msg, isError = false) {
  let t = $("kb-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "kb-toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = isError ? "kb-toast error" : "kb-toast";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

let activeMenu = null;
function closeMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".cat-menu-pop") && !e.target.closest(".card-more")) closeMenu();
});

function showCardMenu(anchor, items) {
  closeMenu();
  const pop = document.createElement("div");
  pop.className = "cat-menu-pop";
  for (const it of items || []) {
    const b = document.createElement("button");
    b.className = "cat-menu-item" + (it.danger ? " danger" : "");
    b.textContent = it.label;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); closeMenu(); it.action(); });
    pop.appendChild(b);
  }
  // 挂到 body 顶层，按视口定位，避免被卡片/滚动容器裁剪；底部放不下时自动向上翻转
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  const W = 168;
  let left = rect.right - W + 10;
  left = Math.max(8, Math.min(left, window.innerWidth - W - 8));
  const menuH = pop.offsetHeight || 140;
  let top = rect.bottom + 6;
  if (top + menuH > window.innerHeight - 8) top = Math.max(8, rect.top - menuH - 6);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  activeMenu = pop;
}

function rebuildSelect(el, options, placeholder) {
  el.innerHTML = `<option value="">${esc(placeholder || "— 请选择 —")}</option>`;
  for (const [v, t] of options || []) {
    const o = document.createElement("option");
    o.value = v; o.textContent = t;
    el.appendChild(o);
  }
  el.value = "";
}

function openCatModal({ title, hint = "", inputs = [], okLabel = "确定", okClass = "" }) {
  return new Promise((resolve) => {
    const m = $("cat-modal");
    $("cat-modal-title").textContent = title;
    $("cat-modal-hint").textContent = hint;
    const form = $("cat-modal-form");
    form.innerHTML = "";
    const els = {};
    for (const inp of inputs || []) {
      const row = document.createElement("div");
      row.className = "cat-modal-field";
      const lab = document.createElement("label");
      lab.textContent = inp.label;
      row.appendChild(lab);
      let el;
      if (inp.type === "select") {
        el = document.createElement("select");
        rebuildSelect(el, inp.options, inp.placeholder);
        if (inp.value) el.value = inp.value;
        if (inp.onChange) el.addEventListener("change", () => inp.onChange(els));
      } else {
        el = document.createElement("input");
        el.type = "text";
        el.value = inp.value || "";
        el.placeholder = inp.placeholder || "";
      }
      row.appendChild(el);
      form.appendChild(row);
      els[inp.key] = el;
    }
    const okBtn = $("cat-modal-ok"), cancelBtn = $("cat-modal-cancel"), xBtn = $("cat-modal-x");
    okBtn.textContent = okLabel;
    okBtn.className = "btn" + (okClass ? " " + okClass : "");
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      m.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      xBtn.removeEventListener("click", onCancel);
      resolve(val);
    };
    const onOk = () => {
      const vals = {};
      for (const k of Object.keys(els)) vals[k] = els[k].value.trim();
      finish(vals);
    };
    const onCancel = () => finish(null);
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    xBtn.addEventListener("click", onCancel);
    m.hidden = false;
    const f = form.querySelector("input,select");
    if (f) f.focus();
  });
}

async function runCatManage(args) {
  try {
    const res = await window.api.categoriesManage(settings, args);
    if (res && res.ok) { toast("操作成功"); renderFolders(); return true; }
    toast((res && res.error) || "操作失败，请查看日志", true);
    return false;
  } catch (err) {
    toast("调用失败：" + String(err && err.message || err), true);
    return false;
  }
}

// 新建分类（level 0=大类 1=父类 2=子类）
async function newCategoryAt(level, path) {
  let title, hint, label, argsBase;
  if (level === 0) {
    title = "新建大类"; label = "大类名称";
    hint = "AI 自动分类时，会把没有现成归属的新收藏归入你命名的大类";
    argsBase = ["add", "major"];
  } else if (level === 1) {
    title = `在「${path[0]}」下新建父类`; label = "父类名称";
    hint = "同主题的视频会自动归入这个父类下的对应子类";
    argsBase = ["add", "group", path[0]];
  } else {
    title = `在「${path[0]} / ${path[1]}」下新建子类`; label = "子类名称";
    hint = "内容相近的新收藏会自动归入这里";
    argsBase = ["add", "sub", path[0], path[1]];
  }
  const vals = await openCatModal({
    title, hint,
    inputs: [{ key: "name", label, placeholder: "输入分类名称" }],
    okLabel: "创建",
  });
  if (!vals || !vals.name) return;
  await runCatManage([...argsBase, vals.name]);
}

// 删除分类（level 1=大类 2=父类 3=子类）：连同该分类下全部笔记一并删除，不可恢复
async function deleteCategoryAt(level, path) {
  const kind = level === 1 ? "大类" : level === 2 ? "父类" : "子类";
  const name = path[path.length - 1];
  const confirm = await openCatModal({
    title: `删除${kind}`,
    hint: `确定删除「${name}」吗？该${kind}下的全部笔记（含共识观点文档）将一并删除，不可恢复。`,
    inputs: [],
    okLabel: "删除",
    okClass: "danger",
  });
  if (!confirm) return;
  const args = level === 1 ? ["delete", "major", name]
    : level === 2 ? ["delete", "group", path[0], name]
      : ["delete", "sub", path[0], path[1], name];
  const ok = await runCatManage(args);
  if (ok) {
    if (level === 1) {
      folderPath = []; kbGroup = ""; const sel = $("kb-group"); if (sel) sel.value = "";
      const arr = settings.pinnedMajors || [];
      if (arr.includes(name)) {
        settings = await window.api.saveSettings({ pinnedMajors: arr.filter((x) => x !== name) });
      }
    }
    else folderPath = folderPath.slice(0, level - 1);
    closeReader();
    renderFolders();
  }
}

async function renameCurrent(type) {
  const oldName = type === "major" ? folderPath[0] : type === "group" ? folderPath[1] : folderPath[2];
  const label = type === "major" ? "大类名称" : type === "group" ? "父类名称" : "子类名称";
  const vals = await openCatModal({
    title: `重命名${label}`,
    hint: "文件夹、全部笔记、数据库与 AI 自动分类都会同步更新",
    inputs: [{ key: "name", label, value: oldName, placeholder: "输入新名称" }],
    okLabel: "重命名",
  });
  if (!vals || !vals.name || vals.name === oldName) return;
  const args = type === "major" ? ["rename", "major", oldName, vals.name]
    : type === "group" ? ["rename", "group", folderPath[0], oldName, vals.name]
      : ["rename", "sub", folderPath[0], folderPath[1], oldName, vals.name];
  await runCatManage(args);
}

async function moveNoteByParts(parts) {
  const notePath = [settings.vaultPath, "Knowledge"].concat(parts).join("\\");
  const cats = (treeCache && treeCache.categories) || [];
  const majorOptions = cats.map((c) => [c.name, c.name]);
  const inputs = [
    {
      key: "major", type: "select", label: "目标大类", placeholder: "— 选择大类 —",
      options: majorOptions,
      onChange: (els) => {
        const c = cats.find((x) => x.name === els.major.value);
        rebuildSelect(els.group, c ? c.groups.map((g) => [g.name, g.name]) : [], "— 选择父类 —");
        rebuildSelect(els.sub, [], "— 选择子类 —");
      },
    },
    {
      key: "group", type: "select", label: "目标父类", placeholder: "— 选择父类 —",
      options: [],
      onChange: (els) => {
        const c = cats.find((x) => x.name === els.major.value);
        const g = c && c.groups.find((x) => x.name === els.group.value);
        rebuildSelect(els.sub, g ? g.subs.map((s) => [s.name, s.name]) : [], "— 选择子类 —");
      },
    },
    { key: "sub", type: "select", label: "目标子类", placeholder: "— 选择子类 —", options: [] },
  ];
  const vals = await openCatModal({
    title: "移动笔记到…",
    hint: "笔记将迁入目标子类，frontmatter / 数据库 / 分类树同步更新",
    inputs, okLabel: "移动",
  });
  if (!vals || !vals.major || !vals.group || !vals.sub) return;
  await runCatManage(["move", notePath, vals.major, vals.group, vals.sub]);
}

$("kb-new-btn").addEventListener("click", () => newCategoryAt(folderPath.length, folderPath));

function closeReader() {
  $("reader-overlay").hidden = true;
  $("reader-content").hidden = true;
  $("reader-editor").hidden = true;
  $("reader-empty").hidden = false;
  $("btn-edit").hidden = false;
  $("btn-save").hidden = true;
  $("btn-cancel").hidden = true;
}
$("btn-reader-back").addEventListener("click", closeReader);

async function renderFolders() {
  const tree = await window.api.vaultTree(settings.vaultPath);
  treeCache = tree;
  populateGroupSelect();
  const crumb = $("kb-crumb");
  const grid = $("folder-grid");
  crumb.innerHTML = "";
  grid.innerHTML = "";

  const mkCrumb = (label, path) => {
    const s = document.createElement("span");
    s.className = "crumb-item" + (path.length === 0 ? " root" : "");
    s.textContent = label;
    s.addEventListener("click", () => {
      folderPath = path;
      kbGroup = path[0] || "";
      const sel = $("kb-group");
      if (sel) sel.value = kbGroup;
      closeReader();
      renderFolders();
    });
    return s;
  };

  crumb.appendChild(mkCrumb("知识库", []));
  if (folderPath[0]) {
    crumb.appendChild(document.createTextNode(" / "));
    crumb.appendChild(mkCrumb(folderPath[0], [folderPath[0]]));
  }
  if (folderPath[1]) {
    crumb.appendChild(document.createTextNode(" / "));
    crumb.appendChild(mkCrumb(folderPath[1], [folderPath[0], folderPath[1]]));
  }
  if (folderPath[2]) {
    crumb.appendChild(document.createTextNode(" / "));
    crumb.appendChild(mkCrumb(folderPath[2], folderPath));
  }

  const cat = tree.categories.find((c) => c.name === folderPath[0]);

  if (folderPath.length === 0) {
    // 大类墙
    if (!tree.categories.length) {
      grid.innerHTML = '<div class="folder-empty-hint">还没有分类，处理收藏后会在这里生成文件夹</div>';
      return;
    }
    const pinnedMajors = settings.pinnedMajors || [];
    const sorted = [...tree.categories].sort(
      (a, b) => (pinnedMajors.includes(b.name) ? 1 : 0) - (pinnedMajors.includes(a.name) ? 1 : 0)
    );
    for (const c of sorted) {
      const gCount = c.groups.length;
      const nCount = c.groups.reduce((m, g) => m + g.subs.reduce((k, s) => k + s.files.length, 0), 0);
      const empty = gCount === 0 && nCount === 0;
      const isPin = pinnedMajors.includes(c.name);
      grid.appendChild(folderCard(c.name, empty ? "暂无内容" : `${gCount} 个父类 · ${nCount} 篇笔记`, {
        color: colorFor(c.name),
        empty,
        badge: isPin ? "📌 已置顶" : undefined,
        onClick: empty ? null : () => {
          folderPath = [c.name];
          kbGroup = c.name;
          const sel = $("kb-group");
          if (sel) sel.value = c.name;
          renderFolders();
        },
        onManage: () => [
          {
            label: isPin ? "取消置顶" : "置顶大类",
            action: async () => {
              const arr = settings.pinnedMajors || [];
              const next = isPin ? arr.filter((x) => x !== c.name) : arr.concat(c.name);
              settings = await window.api.saveSettings({ pinnedMajors: next });
              renderFolders();
            },
          },
          { label: "重命名大类", action: () => renameCurrent("major") },
          { label: "新建父类", action: () => newCategoryAt(1, [c.name]) },
          { label: "删除大类", danger: true, action: () => deleteCategoryAt(1, [c.name]) },
        ],
      }));
    }
  } else if (folderPath.length === 1 && cat) {
    // 父类墙
    if (!cat.groups.length) {
      grid.innerHTML = '<div class="folder-empty-hint">该大类下还没有父类</div>';
      return;
    }
    for (const g of cat.groups) {
      const sCount = g.subs.length;
      const nCount = g.subs.reduce((k, s) => k + s.files.length, 0);
      const empty = sCount === 0 && nCount === 0;
      grid.appendChild(folderCard(g.name, empty ? "暂无内容" : `${sCount} 个子类 · ${nCount} 篇笔记`, {
        color: colorFor(g.name),
        empty,
        onClick: empty ? null : () => {
          folderPath = [cat.name, g.name];
          renderFolders();
        },
        onManage: () => [
          { label: "重命名父类", action: () => renameCurrent("group") },
          { label: "新建子类", action: () => newCategoryAt(2, [cat.name, g.name]) },
          { label: "删除父类", danger: true, action: () => deleteCategoryAt(2, [cat.name, g.name]) },
        ],
      }));
    }
  } else if (folderPath.length === 2 && cat) {
    // 子类墙
    const g = cat.groups.find((x) => x.name === folderPath[1]);
    if (!g || !g.subs.length) {
      grid.innerHTML = '<div class="folder-empty-hint">该父类下还没有子类</div>';
      return;
    }
    for (const s of g.subs) {
      const hasConsensus = s.files.some((f) => /^00-共识观点\.md$/i.test(f));
      const empty = s.files.length === 0;
      grid.appendChild(folderCard(s.name, empty ? "暂无笔记" : `${s.files.length} 篇笔记`, {
        color: colorFor(s.name),
        badge: hasConsensus ? "✦ 共识观点" : undefined,
        empty,
        onClick: empty ? null : () => {
          folderPath = [cat.name, g.name, s.name];
          renderFolders();
        },
        onManage: () => [
          { label: "重命名子类", action: () => renameCurrent("sub") },
          { label: "删除子类", danger: true, action: () => deleteCategoryAt(3, [cat.name, g.name, s.name]) },
        ],
      }));
    }
  } else if (folderPath.length === 3 && cat) {
    // 笔记墙：共识观点文档置顶，其余笔记卡片
    const g = cat.groups.find((x) => x.name === folderPath[1]);
    const s = g && g.subs.find((x) => x.name === folderPath[2]);
    if (!s) {
      grid.innerHTML = '<div class="folder-empty-hint">该子类下还没有笔记</div>';
      return;
    }
    const files = [...s.files];
    const cons = files.findIndex((f) => /^00-共识观点\.md$/i.test(f));
    if (cons !== -1) {
      const name = files.splice(cons, 1)[0];
      const card = noteCard(name.replace(/\.md$/i, ""), {
        consensus: true,
        onManage: () => [{ label: "移动到…", action: () => moveNoteByParts([cat.name, g.name, s.name, name]) }],
      });
      card.addEventListener("click", () => openNoteByParts([cat.name, g.name, s.name, name]));
      grid.appendChild(card);
    }
    for (const name of files) {
      const card = noteCard(name.replace(/\.md$/i, ""), {
        color: colorFor(s.name),
        onManage: () => [{ label: "移动到…", action: () => moveNoteByParts([cat.name, g.name, s.name, name]) }],
      });
      card.addEventListener("click", () => openNoteByParts([cat.name, g.name, s.name, name]));
      grid.appendChild(card);
    }
  }
  // 列表交错入场：文件夹/笔记卡片错开依次浮入（彩蛋页面动效）
  if (pageFxOn("pageFxStagger")) {
    const cards = grid.querySelectorAll(".folder-card, .note-item");
    cards.forEach((el, i) => {
      el.style.animationDelay = (Math.min(i, 14) * 40).toFixed(0) + "ms";
      el.classList.add("stagger-in");
    });
  }
}

async function openNoteByParts(parts) {
  const filePath = ["Knowledge"].concat(parts).join("\\");
  const res = await window.api.vaultRead(settings.vaultPath, filePath);
  if (!res.ok) return;
  currentNote = { path: res.path, parts, title: parts[parts.length - 1].replace(/\.md$/i, "") };
  enterReadMode(res.content);
}

async function openNoteByPath(absPath) {
  const res = await window.api.vaultRead("", absPath);
  if (!res.ok) return;
  // 相对路径还原 parts
  const vault = settings.vaultPath.replace(/[\\/]+$/, "");
  const rel = absPath.replace(vault + "\\", "").split("\\");
  currentNote = { path: res.path, parts: rel, title: rel[rel.length - 1].replace(/\.md$/i, "") };
  enterReadMode(res.content);
}

function enterReadMode(content) {
  editing = false;
  $("reader-overlay").hidden = false;
  $("reader-empty").hidden = true;
  const toolbar = $("reader-toolbar");
  toolbar.hidden = false;
  $("reader-file").textContent = currentNote.title;
  const contentEl = $("reader-content");
  contentEl.hidden = false;
  contentEl.innerHTML = window.api.renderMarkdown(content);
  $("reader-editor").hidden = true;
  $("btn-edit").hidden = false;
  $("btn-save").hidden = true;
  $("btn-cancel").hidden = true;
  contentEl.querySelectorAll(".note-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = decodeURIComponent(a.dataset.target);
      findNoteByTitle(target);
    });
  });
}

function enterEditMode(content) {
  editing = true;
  $("reader-content").hidden = true;
  $("btn-edit").hidden = true;
  $("btn-save").hidden = false;
  $("btn-cancel").hidden = false;
  const ed = $("reader-editor");
  ed.hidden = false;
  ed.value = content;
  ed.focus();
}

$("btn-edit").addEventListener("click", async () => {
  if (!currentNote) return;
  const res = await window.api.vaultRead("", currentNote.path);
  if (res.ok) enterEditMode(res.content);
});
$("btn-cancel").addEventListener("click", async () => {
  if (!currentNote) return;
  const res = await window.api.vaultRead("", currentNote.path);
  if (res.ok) enterReadMode(res.content);
});
$("btn-save").addEventListener("click", async () => {
  const content = $("reader-editor").value;
  const res = await window.api.vaultWrite(currentNote.path, content);
  if (res.ok) {
    appendLog(`\n已保存笔记：${currentNote.title}\n`);
    enterReadMode(content);
  } else {
    alert(`保存失败：${res.error || "未知错误"}`);
  }
});

async function findNoteByTitle(title) {
  if (!treeCache) await renderFolders();
  for (const cat of treeCache.categories) {
    for (const g of cat.groups) {
      for (const s of g.subs) {
        const hit = s.files.find((f) => f.replace(/\.md$/i, "") === title || f === title);
        if (hit) {
          openNoteByParts([cat.name, g.name, s.name, hit]);
          return;
        }
      }
    }
  }
  appendLog(`未找到笔记：${title}\n`);
}

/* ---- 全文搜索 ---- */
async function doSearch() {
  const q = $("kb-search").value.trim();
  const box = $("search-results");
  if (!q) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = "<div class='panel' style='color:var(--text-2)'>搜索中…</div>";
  const res = await window.api.vaultSearch(settings, q);
  if (!res.results.length) {
    box.innerHTML = "<div class='panel' style='color:var(--text-2)'>没有找到匹配的笔记</div>";
    return;
  }
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "sr-item";
  head.style.cursor = "default";
  head.textContent = `找到 ${res.results.length} 篇匹配笔记（点击打开）`;
  box.appendChild(head);
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  for (const r of res.results) {
    const item = document.createElement("div");
    item.className = "sr-item";
    item.innerHTML = `<div class="sr-title">${esc(r.title)}<span class="sr-count">命中 ${r.count} 处</span></div>
      <div class="sr-snippet">${esc(r.snippet).replace(re, (m) => `<mark>${m}</mark>`)}</div>`;
    item.addEventListener("click", () => {
      openNoteByPath(r.path);
    });
    box.appendChild(item);
  }
}
$("kb-search-btn").addEventListener("click", doSearch);
$("kb-search").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

/* ---- 图谱视图 ---- */
$("kb-graph-btn").addEventListener("click", async () => {
  $("graph-view").hidden = false;
  await renderGraph();
});

let graphAnimId = null;
let graphCleanup = null;
let graphPendingZoom = null;
let graphSvgEl = null;
function closeGraph() {
  if (graphCleanup) graphCleanup();
  graphCleanup = null;
  graphPendingZoom = null;
  graphSvgEl = null;
  const g = $("graph-view");
  g.hidden = true;
  g.innerHTML = "";
}
// 知识库文件变化 → 图谱开着时自动刷新（保留当前视图）
window.api.onVaultChanged(() => {
  if (!$("graph-view") || $("graph-view").hidden || !graphSvgEl) return;
  graphPendingZoom = d3.zoomTransform(graphSvgEl);
  renderGraph();
});

/* ================= 图谱视图（graphify 范式：社区聚类 + 交互导航） ================= */

// 社区检测：以"大类"为先验，双链标签传播修正；返回 节点→社区、社区→名称/大小
function detectGraphCommunities(nodes, edges) {
  const label = new Map();
  nodes.forEach((n, i) => label.set(n.id, n.group || "__root__" + i));
  for (let iter = 0; iter < 40; iter++) {
    let changed = 0;
    for (const n of nodes) {
      const cnt = new Map();
      for (const e of edges) {
        if (e.source === n.id) { const l = label.get(e.target); cnt.set(l, (cnt.get(l) || 0) + 1); }
        if (e.target === n.id) { const l = label.get(e.source); cnt.set(l, (cnt.get(l) || 0) + 1); }
      }
      if (!cnt.size) continue;
      let best = null, bc = 0;
      for (const [l, c] of cnt) if (c > bc) { bc = c; best = l; }
      if (best !== label.get(n.id)) { label.set(n.id, best); changed++; }
    }
    if (!changed) break;
  }
  const size = new Map(), groupCnt = new Map();
  nodes.forEach((n) => {
    const l = label.get(n.id);
    size.set(l, (size.get(l) || 0) + 1);
    const key = l + "::" + (n.group || "未分类");
    groupCnt.set(key, (groupCnt.get(key) || 0) + 1);
  });
  const order = [...size.keys()].sort((a, b) => size.get(b) - size.get(a));
  const cid = new Map();
  order.forEach((l, i) => cid.set(l, i));
  const commSize = new Map(), commName = new Map();
  order.forEach((l, i) => {
    commSize.set(i, size.get(l));
    let best = null, bestC = 0;
    for (const [k, c] of groupCnt) {
      if (k.startsWith(l + "::") && c > bestC) { bestC = c; best = k.slice(l.length + 2); }
    }
    commName.set(i, best || "未分类");
  });
  const nodeComm = new Map();
  nodes.forEach((n) => nodeComm.set(n.id, cid.get(label.get(n.id))));
  return { nodeComm, commName, commSize, nComms: order.length };
}

function graphCommunityColor(cid) {
  const palette = ["#38bdf8", "#818cf8", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#22d3ee", "#fb7185", "#4ade80", "#facc15", "#c084fc", "#2dd4bf", "#f97316", "#60a5fa", "#e879f9", "#94a3b8"];
  return palette[cid % palette.length];
}

function renderGraph() {
  return window.api.vaultGraph(settings).then((g) => {
    const nodes = g.nodes.map((n) => ({ ...n }));
    const edges = g.edges.map((e) => ({ ...e }));
    const wrap = $("graph-view");
    wrap.innerHTML = `
      <div class="gt-topbar">
        <div class="gt-title"><span class="gt-title-mark">◈</span>知识图谱<span class="gt-sub">双链力导向 · 深蓝科技</span></div>
        <div class="gt-stats" id="gt-stats"></div>
        <span class="spacer"></span>
        <button class="btn small ghost" id="gt-refresh" title="重新扫描知识库，读取最新笔记">⟳ 刷新</button>
        <button class="btn small ghost" id="gt-fit">复位视图</button>
        <button class="btn small" id="gt-close">关闭</button>
      </div>
      <div class="gt-body">
        <div class="gt-panel gt-left">
          <div class="gt-panel-title">图谱概览</div>
          <div id="gt-overview"></div>
          <div class="gt-panel-title" style="margin-top:16px">主题社区</div>
          <div id="gt-comm-list" class="gt-comm-list"></div>
        </div>
        <div class="gt-canvas-wrap" id="gt-canvas-wrap">
          <svg id="gt-canvas"></svg>
          <div class="gt-hint">拖拽节点 · 滚轮缩放 · 空白平移 · 悬停高亮 · 单击看详情 · 双击打开笔记</div>
        </div>
        <div class="gt-panel gt-right">
          <div class="gt-panel-title">节点详情</div>
          <div id="gt-detail" class="gt-detail">
            <div class="gt-detail-empty">点击图谱中的节点查看详情<br/>双击节点直接打开笔记</div>
          </div>
        </div>
      </div>`;
    $("gt-close").addEventListener("click", closeGraph);

    const { nodeComm, commName, commSize, nComms } = detectGraphCommunities(nodes, edges);

    // ---- 数据准备 ----
    const cwEl = $("gt-canvas-wrap");
    const W = cwEl.clientWidth || 1080, H = cwEl.clientHeight || 720;
    const degMap = new Map();
    nodes.forEach((n) => degMap.set(n.id, 0));
    edges.forEach((e) => { degMap.set(e.source, degMap.get(e.source) + 1); degMap.set(e.target, degMap.get(e.target) + 1); });
    const adj = new Map();
    nodes.forEach((n) => adj.set(n.id, new Set()));
    edges.forEach((e) => { adj.get(e.source).add(e.target); adj.get(e.target).add(e.source); });
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    nodes.forEach((n) => {
      n.comm = nodeComm.get(n.id);
      n.deg = degMap.get(n.id) || 0;
      n.consensus = n.title.startsWith("00-");
      n.r = (n.consensus ? 7.5 : 5.5) + Math.min(9, n.deg * 1.2);
    });
    const colorOf = (c) => graphCommunityColor(c);
    const centers = [];
    for (let c = 0; c < nComms; c++) {
      const ang = (c / nComms) * Math.PI * 2;
      const rad = Math.min(W, H) * 0.30;
      centers[c] = [W / 2 + Math.cos(ang) * rad, H / 2 + Math.sin(ang) * rad];
    }

    // ---- d3 力导向模拟 ----
    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(edges).id((d) => d.id).distance((d) => 56 + (typeof d.source === "object" ? d.source.r + d.target.r : 12)).strength(0.32))
      .force("charge", d3.forceManyBody().strength((d) => -60 - d.r * 16))
      .force("x", d3.forceX((d) => centers[d.comm][0]).strength(0.05))
      .force("y", d3.forceY((d) => centers[d.comm][1]).strength(0.05))
      .force("collide", d3.forceCollide().radius((d) => d.r + 4).strength(0.85))
      .alphaDecay(0.03);

    const svg = d3.select("#gt-canvas").attr("width", W).attr("height", H);
    svg.selectAll("*").remove();
    graphSvgEl = svg.node();

    // 背景网格 defs
    const defs = svg.append("defs");
    const grid = defs.append("pattern").attr("id", "gt-grid").attr("width", 34).attr("height", 34).attr("patternUnits", "userSpaceOnUse");
    grid.append("path").attr("d", "M 34 0 L 0 0 0 34").attr("fill", "none").attr("stroke", "rgba(56, 130, 220, 0.15)").attr("stroke-width", 1);
    const halo = defs.append("radialGradient").attr("id", "gt-halo").attr("cx", "50%").attr("cy", "50%").attr("r", "50%");
    halo.append("stop").attr("offset", "0%").attr("stop-color", "#38bdf8").attr("stop-opacity", "0.16");
    halo.append("stop").attr("offset", "100%").attr("stop-color", "#38bdf8").attr("stop-opacity", "0");

    const root = svg.append("g");
    root.append("rect").attr("width", W).attr("height", H).attr("fill", "url(#gt-grid)");
    root.append("rect").attr("width", W).attr("height", H).attr("fill", "url(#gt-halo)");

    const zoomG = root.append("g").attr("class", "gt-zoom");
    const zoom = d3.zoom()
      .filter((ev) => !ev.button && !(ev.target && ev.target.closest && ev.target.closest(".gt-node")))
      .scaleExtent([0.15, 4])
      .on("zoom", (ev) => zoomG.attr("transform", ev.transform));
    svg.call(zoom);

    // 连线（流动虚线）
    const link = zoomG.append("g").attr("class", "gt-links").selectAll("line")
      .data(edges).join("line")
      .attr("class", (d) => (nodeComm.get(d.source.id) !== nodeComm.get(d.target.id) ? "gt-link gt-link-cross" : "gt-link"));

    // 节点：光晕 + 主圆 + 高光 + 标签
    const node = zoomG.append("g").attr("class", "gt-nodes").selectAll("g")
      .data(nodes).join("g")
      .attr("class", (d) => "gt-node" + (d.consensus ? " gt-node-diamond" : ""));

    node.append("circle").attr("class", "gt-glow").attr("r", (d) => d.r * 2.4).attr("fill", (d) => colorOf(d.comm)).attr("opacity", 0.26);
    node.append("circle").attr("class", "gt-core").attr("r", (d) => d.r).attr("fill", (d) => colorOf(d.comm)).attr("style", (d) => `filter: drop-shadow(0 0 6px ${colorOf(d.comm)});`);
    node.append("circle").attr("class", "gt-shine").attr("r", (d) => Math.max(1.6, d.r * 0.32)).attr("cx", (d) => -d.r * 0.32).attr("cy", (d) => -d.r * 0.32).attr("fill", "rgba(255,255,255,0.5)");
    node.append("text").attr("class", "gt-label")
      .attr("dx", (d) => d.r + 7).attr("dy", 3.5)
      .text((d) => (d.title.length > 10 ? d.title.slice(0, 10) + "…" : d.title));

    // 共识观点文档：菱形外框
    node.filter((d) => d.consensus).append("rect")
      .attr("width", (d) => d.r * 1.7).attr("height", (d) => d.r * 1.7)
      .attr("x", (d) => -d.r * 0.85).attr("y", (d) => -d.r * 0.85)
      .attr("transform", "rotate(45)")
      .attr("fill", "none").attr("stroke", (d) => colorOf(d.comm)).attr("stroke-width", 1.4)
      .attr("opacity", 0.85);

    sim.on("tick", () => {
      link.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
          .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    // 拖拽（节点拖动实时联动）
    const dragFn = d3.drag()
      .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.28).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; });
    node.call(dragFn);

    // hover 高亮 + 单击详情 + 双击打开
    const detailBox = $("gt-detail");
    const showDetail = (d) => {
      const links = [...adj.get(d.id)];
      const items = links.slice(0, 18).map((id) => {
        const t = nodeById.get(id);
        return t ? `<div class="gt-detail-link" data-id="${esc(t.id)}">${esc(t.title)}</div>` : "";
      }).join("");
      const more = links.length > 18 ? `<div class="gt-detail-more">…还有 ${links.length - 18} 条</div>` : "";
      detailBox.innerHTML = `
        <div class="gt-detail-node" style="--nc:${colorOf(d.comm)}">
          <div class="gt-detail-name">${esc(d.title)}</div>
          <div class="gt-detail-meta">
            <span>分类：${esc(d.group || "未分类")}</span>
            <span>社区：${esc(commName.get(d.comm))}</span>
            <span>${d.deg} 条双链${d.consensus ? " · 共识观点文档" : ""}</span>
          </div>
          <div class="gt-detail-open"><button class="btn primary small" id="gt-open-note">打开笔记</button></div>
          <div class="gt-detail-links-title">双向链接（${links.length}）</div>
          <div class="gt-detail-links">${items}${more}</div>
        </div>`;
      const openBtn = $("gt-open-note");
      if (openBtn) openBtn.addEventListener("click", () => { openNoteByPath(d.path); closeGraph(); });
      detailBox.querySelectorAll(".gt-detail-link").forEach((el) => {
        el.addEventListener("click", () => {
          const t = nodeById.get(el.dataset.id);
          if (t) { openNoteByPath(t.path); closeGraph(); }
        });
      });
    };
    const clearHover = () => {
      node.classed("gt-dim", false);
      link.classed("gt-dim", false);
      node.select(".gt-core").attr("stroke", null).attr("stroke-width", null);
    };
    node.on("mouseenter", (ev, d) => {
      clearHover();
      node.classed("gt-dim", (n) => n.id !== d.id && !adj.get(d.id).has(n.id));
      link.classed("gt-dim", (l) => l.source.id !== d.id && l.target.id !== d.id);
      node.select(".gt-core").filter((n) => n.id === d.id).attr("stroke", "#ffffff").attr("stroke-width", 1.6);
    });
    node.on("mouseleave", clearHover);
    node.on("click", (ev, d) => { ev.stopPropagation(); showDetail(d); });
    node.on("dblclick", (ev, d) => { ev.stopPropagation(); openNoteByPath(d.path); closeGraph(); });
    svg.on("click", () => {
      detailBox.innerHTML = `<div class="gt-detail-empty">点击图谱中的节点查看详情<br/>双击节点直接打开笔记</div>`;
    });

    // 复位视图
    $("gt-fit").addEventListener("click", () => {
      svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
    });
    // 刷新：重新扫描知识库并重建图谱（保留当前缩放/平移视图）
    $("gt-refresh").addEventListener("click", async () => {
      graphPendingZoom = d3.zoomTransform(svg.node());
      await renderGraph();
    });

    // ---- 左面板：概览 + 社区 ----
    const linkedCount = nodes.filter((n) => n.deg > 0).length;
    $("gt-overview").innerHTML = `
      <div class="gt-ov-row"><span>节点</span><b>${nodes.length}</b></div>
      <div class="gt-ov-row"><span>双向链接</span><b>${edges.length}</b></div>
      <div class="gt-ov-row"><span>有链接节点</span><b>${linkedCount}</b></div>
      <div class="gt-ov-row"><span>主题社区</span><b>${nComms}</b></div>`;
    const commList = [...Array(nComms).keys()].map((c) => [c, commSize.get(c)]).sort((a, b) => b[1] - a[1]);
    $("gt-comm-list").innerHTML = commList.map(([c, sz]) => `
      <div class="gt-comm-item" data-c="${c}">
        <span class="gt-comm-dot" style="background:${colorOf(c)}; box-shadow:0 0 8px ${colorOf(c)}"></span>
        <span class="gt-comm-name">${esc(commName.get(c))}</span>
        <span class="gt-comm-count">${sz}</span>
      </div>`).join("");
    $("gt-comm-list").querySelectorAll(".gt-comm-item").forEach((el) => {
      el.addEventListener("click", () => {
        const c = Number(el.dataset.c);
        const active = el.classList.contains("active");
        $("gt-comm-list").querySelectorAll(".gt-comm-item").forEach((o) => o.classList.remove("active"));
        clearHover();
        if (active) return;
        el.classList.add("active");
        node.classed("gt-dim", (n) => n.comm !== c);
        link.classed("gt-dim", (l) => nodeComm.get(l.source.id) !== c && nodeComm.get(l.target.id) !== c);
      });
    });
    $("gt-stats").textContent = `${nodes.length} 节点 · ${edges.length} 双链 · ${nComms} 社区`;
    $("gt-stats").title = "悬停节点高亮邻居，拖拽节点实时联动";
    // 刷新/自动更新后恢复之前视图
    if (graphPendingZoom) {
      svg.call(zoom.transform, graphPendingZoom);
      graphPendingZoom = null;
    }

    // ---- 清理 ----
    graphCleanup = () => {
      sim.stop();
      svg.on(".zoom", null).on("click", null);
      node.on(".drag", null).on("mouseenter", null).on("mouseleave", null).on("click", null).on("dblclick", null);
    };
  }).catch((err) => {
    $("graph-view").innerHTML = `<div class="gt-topbar"><div class="gt-title"><span class="gt-title-mark">◈</span>知识图谱</div><span class="spacer"></span><button class="btn small" id="gt-close">关闭</button></div>`;
    $("gt-close").addEventListener("click", closeGraph);
    appendLog(`图谱加载失败：${err}\n`);
  });
}

/* ================= 知识蒸馏 ================= */
async function loadDistillPicker() {
  const tree = await window.api.vaultTree(settings.vaultPath);
  treeCache = tree;
  const majorSel = $("dist-major");
  majorSel.innerHTML = '<option value="">选择大类</option>';
  for (const c of tree.categories) {
    const o = document.createElement("option");
    o.value = c.name; o.textContent = c.name;
    majorSel.appendChild(o);
  }
  $("dist-group").innerHTML = '<option value="">选择父类</option>';
  $("dist-sub").innerHTML = '<option value="">选择子类</option>';
  $("dist-group").disabled = true;
  $("dist-sub").disabled = true;
  $("dist-meta").hidden = true;
  await loadChatSkills();
}

/* ---- AI 问答（蒸馏技能对话） ---- */
let chatHistory = [];
let chatBusy = false;

async function loadChatSkills() {
  const sel = $("chat-skill");
  sel.innerHTML = '<option value="">选择已蒸馏的技能…</option>';
  const res = await window.api.distillList(settings);
  const list = res.list || [];
  for (const s of list) {
    const o = document.createElement("option");
    o.value = s.path;
    o.textContent = `${s.name} — ${s.description.slice(0, 40)}`;
    sel.appendChild(o);
  }
  sel.disabled = list.length === 0;
  $("chat-pick-note").textContent = list.length === 0 ? "还没有蒸馏技能，先在 ① 里选子类蒸馏一个" : `${list.length} 个技能可用`;
  if (list.length > 0 && !sel.value) sel.selectedIndex = 1;
}

function chatAdd(role, html) {
  const box = $("chat-box");
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  if (role === "bot" && html.startsWith("<")) div.innerHTML = html;
  else div.textContent = html;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

async function chatSend() {
  const input = $("chat-input");
  const q = input.value.trim();
  const skillPath = $("chat-skill").value;
  if (!q) return;
  if (!skillPath) {
    chatAdd("bot", "请先在上方选择一个已蒸馏的技能。");
    return;
  }
  if (chatBusy) return;
  chatBusy = true;
  input.value = "";
  chatAdd("user", q);
  chatHistory.push({ role: "user", content: q });
  const thinking = chatAdd("bot", "AI 思考中…");
  try {
    const res = await window.api.chatAsk(settings, { skillPath, question: q, history: chatHistory.slice(0, -1) });
    thinking.remove();
    if (res.ok) {
      chatAdd("bot", window.api.renderMarkdown(res.answer));
      chatHistory.push({ role: "assistant", content: res.answer });
    } else {
      chatAdd("bot", `出错了：${res.error || "未知错误"}`);
      chatHistory.pop();
    }
  } catch (err) {
    thinking.remove();
    chatAdd("bot", `出错了：${String(err && err.message || err)}`);
    chatHistory.pop();
  }
  chatBusy = false;
}

$("chat-send").addEventListener("click", chatSend);
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") chatSend(); });

$("dist-major").addEventListener("change", () => {
  const tree = treeCache;
  const cat = tree?.categories.find((c) => c.name === $("dist-major").value);
  const gSel = $("dist-group");
  gSel.innerHTML = '<option value="">选择父类</option>';
  $("dist-sub").innerHTML = '<option value="">选择子类</option>';
  gSel.disabled = !cat;
  $("dist-sub").disabled = true;
  $("dist-meta").hidden = true;
  for (const g of (cat?.groups || [])) {
    const o = document.createElement("option");
    o.value = g.name; o.textContent = g.name;
    gSel.appendChild(o);
  }
});

$("dist-group").addEventListener("change", () => {
  const cat = treeCache?.categories.find((c) => c.name === $("dist-major").value);
  const g = cat?.groups.find((x) => x.name === $("dist-group").value);
  const sSel = $("dist-sub");
  sSel.innerHTML = '<option value="">选择子类</option>';
  sSel.disabled = !g;
  $("dist-meta").hidden = true;
  for (const s of (g?.subs || [])) {
    const o = document.createElement("option");
    o.value = s.name; o.textContent = `${s.name}（${s.files.length}）`;
    sSel.appendChild(o);
  }
});

$("dist-sub").addEventListener("change", async () => {
  const sel = distillSelection();
  if (!sel) return;
  const est = await window.api.distillEstimate(settings, sel);
  if (!est.ok) return;
  $("dist-files").textContent = est.files;
  $("dist-tokens").textContent = est.estTokens.toLocaleString();
  $("dist-meta").hidden = false;
  $("dist-log").textContent = "";
  $("dist-result").hidden = true;
  $("dist-saved").hidden = true;
});

function distillSelection() {
  const major = $("dist-major").value, group = $("dist-group").value, sub = $("dist-sub").value;
  if (!major || !group || !sub) return null;
  return { major, group, sub };
}

$("dist-run").addEventListener("click", async () => {
  const sel = distillSelection();
  if (!sel) return;
  const log = $("dist-log");
  log.textContent = "";
  const sink = (s) => { log.textContent += s; log.scrollTop = log.scrollHeight; };
  sink("开始蒸馏…\n");
  try {
    const res = await window.api.distillRun(settings, sel);
    if (res.ok) {
      sink(`完成。技能包已保存：${res.path}\n`);
      $("dist-result").textContent = res.content;
      $("dist-result").hidden = false;
      celebrate($("dist-result"));
      const saved = $("dist-saved");
      saved.innerHTML = `✅ 已保存到 <code>${esc(res.path)}</code>，可被 AI 助手直接安装调用。`;
      saved.hidden = false;
    } else {
      sink(`失败：${res.error}\n`);
    }
  } catch (err) {
    sink(`运行出错：${String(err && err.message || err)}\n`);
  }
});

/* ================= 设置 ================= */
function fillSettingsForm() {
  $("set-project").value = settings.projectPath || "";
  $("set-vault").value = settings.vaultPath || "";
  const sd = settings.startDate || "";
  $("set-startdate").value = sd;
  $("set-dailylimit").value = settings.dailyLimit ? String(settings.dailyLimit) : "";
  // 处理方式：time=按时间（起始日期），count=按数量（最近 N 条快照），all=处理全部收藏
  const mode = settings.processMode === "count" ? "count" : (settings.processMode === "all" ? "all" : "time");
  $("set-mode-time").checked = mode === "time";
  $("set-mode-count").checked = mode === "count";
  $("set-mode-all").checked = mode === "all";
  $("set-countlimit").value = Number(settings.countLimit) > 0 ? String(Number(settings.countLimit)) : "";
  syncModeUi();
  $("set-node").value = settings.nodePath || "";
  $("set-whisper").value = settings.whisperModel || "";
  $("set-base").value = settings.llmBaseUrl || "";
  $("set-key").value = settings.llmApiKey || "";
  $("set-model").value = settings.llmModel || "deepseek-chat";
  $("set-distill").value = settings.distillOutputDir || "";
  $("set-cangjie").value = settings.cangjiePath || "";
  $("set-python").value = settings.pythonPath || "";
  $("set-pause-auto").value = Number(settings.pauseAutoResumeMinutes || 0) ? String(Number(settings.pauseAutoResumeMinutes)) : "0";
  // 每周知识日报
  const wr = settings.weeklyReport || {};
  $("wr-enable").checked = wr.enabled !== false;
  $("wr-weekday").value = String(wr.weekday || 2);
}

function syncModeUi() {
  const isCount = $("set-mode-count").checked;
  const isAll = $("set-mode-all").checked;
  // 按时间：只显示起始日期区；按数量：只显示确认条数区；处理全部：两者都不显示
  $("mode-time-block").style.display = (isCount || isAll) ? "none" : "";
  $("mode-count-block").style.display = isCount ? "" : "none";
}
$("set-mode-time").addEventListener("change", syncModeUi);
$("set-mode-count").addEventListener("change", syncModeUi);
$("set-mode-all").addEventListener("change", syncModeUi);

$("btn-settings-save").addEventListener("click", async () => {
  const processMode = $("set-mode-all").checked ? "all" : ($("set-mode-count").checked ? "count" : "time");
  // 按数量/全部模式不依赖时间：强制清空起始日期，避免日期打标与数量快照叠加冲突
  const startDate = processMode === "time" ? $("set-startdate").value.trim() : "";
  const countLimit = processMode === "count" ? Math.max(1, Number($("set-countlimit").value) || 100) : Number(settings.countLimit) || 100;
  settings = await window.api.saveSettings({
    projectPath: $("set-project").value.trim(),
    vaultPath: $("set-vault").value.trim(),
    startDate,
    processMode,
    countLimit,
    // 手动「开始处理收藏」的每日条数上限（不含定时任务；留空/非法回退 100）
    dailyLimit: Math.max(1, Number($("set-dailylimit").value) || 100),
    // 用户在设置页明确确认过日期口径（含"处理所有"），总览不再重复询问
    startDateAcknowledged: true,
    nodePath: $("set-node").value.trim(),
    whisperModel: $("set-whisper").value.trim(),
    llmBaseUrl: $("set-base").value.trim(),
    llmApiKey: $("set-key").value.trim(),
    llmModel: $("set-model").value.trim() || "deepseek-chat",
    distillOutputDir: $("set-distill").value.trim(),
    cangjiePath: $("set-cangjie").value.trim(),
    pythonPath: $("set-python").value.trim(),
    pauseAutoResumeMinutes: Math.max(0, Number($("set-pause-auto").value) || 0),
    // 每周知识日报（保留 lastShownDate/streak 等状态字段，只更新开关与星期）
    weeklyReport: { ...(settings.weeklyReport || {}), enabled: $("wr-enable").checked, weekday: Number($("wr-weekday").value) || 2 },
  });
  const st = $("settings-status");
  st.textContent = "已保存 ✓";
  setTimeout(() => { st.textContent = ""; }, 2500);
  loadOverview();
});

$("btn-login").addEventListener("click", async () => {
  const out = $("login-out");
  out.textContent = "正在打开抖音扫码登录窗口…\n";
  const res = await window.api.loginDouyin(settings);
  out.textContent += res.ok ? "登录窗口已打开，请在浏览器里完成扫码，然后点「检查登录状态」。\n" : `失败：${res.error || "未知错误"}\n`;
});

$("btn-test-llm").addEventListener("click", async () => {
  const result = $("llm-test-result");
  result.textContent = "测试中…";
  result.style.color = "#8ab4f8";
  const probe = {
    ...settings,
    llmBaseUrl: $("set-base").value.trim(),
    llmApiKey: $("set-key").value.trim(),
    llmModel: $("set-model").value.trim() || settings.llmModel,
  };
  const r = await window.api.llmTest(probe);
  result.textContent = r.message || (r.ok ? "连接成功" : "失败");
  result.style.color = r.ok ? "#7ee787" : "#ff7b72";
});

$("btn-auth-status").addEventListener("click", async () => {
  const out = $("login-out");
  out.textContent = "正在检查登录状态…\n";
  const res = await window.api.authStatus(settings);
  const raw = (res && res.raw) || "";
  out.textContent += raw ? String(raw).slice(0, 800) : (res && res.error || "检查完成");
  const st = $("login-status");
  const lower = raw.toLowerCase();
  if (res && res.ok) {
    st.textContent = "已登录 ✓";
    st.className = "login-status ok";
  } else if (res && res.error) {
    st.textContent = "登录状态异常";
    st.className = "login-status bad";
  } else {
    st.textContent = "状态未知";
    st.className = "login-status";
  }
});

/* ================= 界面皮肤 ================= */
// light: true = 亮色背景图（文字/边框自动切深色方案），false = 暗色背景图（默认浅色文字）
/* 免费皮肤（前8个），其余保留给后续更新 */
const FREE_SKINS = ["lake", "forest", "dawn", "meadow", "goldenpeak", "caiyun", "goldleaf", "reedlake"];
const SKINS = [
  { key: "lake", name: "暮色山海", file: "../assets/skins/lake.jpg", light: false },
  { key: "forest", name: "林海翠微", file: "../assets/skins/forest.jpg", light: false },
  { key: "dawn", name: "清晨大海", file: "../assets/skins/dawn.jpg", light: true },
  { key: "meadow", name: "明亮草原", file: "../assets/skins/meadow.jpg", light: true },
  { key: "goldenpeak", name: "日照金山", file: "../assets/skins/goldenpeak.jpg", light: true },
  { key: "caiyun", name: "彩云追月", file: "../assets/skins/caiyun.jpg", light: true },
  { key: "goldleaf", name: "金叶夜舟", file: "../assets/skins/goldleaf.jpg", light: false },
  { key: "reedlake", name: "苇影湖山", file: "../assets/skins/reedlake.jpg", light: true },
];
/* 皮肤专属点击特效：每个皮肤一套主/辅/辅2 色 + 四字特效名 + 专属粒子类型（开启专属开关后生效） */
const FX_COLORS = {
  lake:       { name: "山海星澜", type: "star",  c1: "#7dd3fc", c2: "#c4b5fd", c3: "#f9a8d4" },  // 暮色山海：天蓝星光
  forest:     { name: "林海翠萤", type: "leaf",  c1: "#4ade80", c2: "#2dd4bf", c3: "#86efac" },  // 林海翠微：翠叶飘落
  dawn:       { name: "晨海曦光", type: "sun",   c1: "#0ea5e9", c2: "#38bdf8", c3: "#fcd34d" },  // 清晨大海：旭日东升
  meadow:     { name: "草原流光", type: "dust",  c1: "#22c55e", c2: "#84cc16", c3: "#fde047" },  // 明亮草原：草海光点
  goldenpeak: { name: "金山鎏光", type: "sun",   c1: "#f59e0b", c2: "#fbbf24", c3: "#fb923c" },  // 日照金山：小太阳飞出
  caiyun:     { name: "彩云霞光", type: "cloud", c1: "#ec4899", c2: "#a78bfa", c3: "#38bdf8" },  // 彩云追月：云朵飘散
  goldleaf:   { name: "金叶夜辉", type: "leaf",  c1: "#fbbf24", c2: "#f59e0b", c3: "#fde68a" },  // 金叶夜舟：金黄叶落
  reedlake:   { name: "苇湖青漪", type: "leaf",  c1: "#14b8a6", c2: "#84cc16", c3: "#7dd3fc" },  // 苇影湖山：苇叶轻落
  snowlake:   { name: "雪峰冰晶", type: "snow",  c1: "#38bdf8", c2: "#bae6fd", c3: "#818cf8" },  // 雪峰映湖：雪花飘落
  dusksea:    { name: "暮海鎏金", type: "ember", c1: "#f59e0b", c2: "#22d3ee", c3: "#fde68a" },  // 暮海流金：金色碎金
  greenlake:  { name: "碧湖翠光", type: "leaf",  c1: "#22c55e", c2: "#86efac", c3: "#facc15" },  // 碧湖草野：翠叶飘落
  skyroad:    { name: "天路蓝光", type: "snow",  c1: "#0ea5e9", c2: "#a5b4fc", c3: "#7dd3fc" },  // 雪岭天路：蓝雪飘落
  snow:       { name: "晴空雪芒", type: "snow",  c1: "#e0f2fe", c2: "#bae6fd", c3: "#7dd3fc" },  // 雪岭晴空：雪花飘落
  grassland:  { name: "碧野金晖", type: "dust",  c1: "#84cc16", c2: "#fde047", c3: "#4ade80" },  // 碧野连天：草海光点
  volcano:    { name: "熔岩星火", type: "ember", c1: "#fb923c", c2: "#f87171", c3: "#fbbf24" },  // 烈焰熔岩：火星四溅
  starrylake: { name: "星湖紫电", type: "star",  c1: "#a78bfa", c2: "#93c5fd", c3: "#e9d5ff" },  // 雪岭星湖：闪亮星芒
};
function applySkin(key) {
  const s = SKINS.find((x) => x.key === key) || SKINS[0];
  document.body.style.background = `url('${s.file}') center / cover no-repeat fixed`;
  document.body.classList.toggle("skin-light", !!s.light);
  document.body.classList.toggle("skin-dark", !s.light);
  window.__dokSkin = s.key;
  // 皮肤专属特效色：点击星光/涟漪/光点/星芒跟随当前皮肤换色
  const fx = FX_COLORS[s.key] || FX_COLORS.starrylake;
  document.body.style.setProperty("--fx-c1", fx.c1);
  document.body.style.setProperty("--fx-c2", fx.c2);
  document.body.style.setProperty("--fx-c3", fx.c3);
  const cards = document.querySelectorAll(".skin-card");
  cards.forEach((c) => c.classList.toggle("active", c.dataset.skin === s.key));
}
async function renderSkins() {
  const grid = $("skin-grid");
  if (!grid) return;
  const vip = isVipActive();
  // 非会员当前皮肤若是会员专属，回退到默认免费皮肤
  const current = window.__dokSkin || settings.skin || "lake";
  if (!vip && !FREE_SKINS.includes(current) && current !== "lake") {
    applySkin("lake");
    settings = await window.api.saveSettings({ skin: "lake" });
  }
  grid.innerHTML = "";
  for (const s of SKINS) {
    const locked = !vip && !FREE_SKINS.includes(s.key);
    const card = document.createElement("div");
    card.className = "skin-card" + (locked ? " locked" : "");
    card.dataset.skin = s.key;
    card.innerHTML = `<img src="${s.file}" alt="${esc(s.name)}" /><span class="skin-name">${esc(s.name)}</span>${locked ? '<span class="skin-lock">会员专属</span>' : ""}`;
    card.addEventListener("click", async () => {
      if (locked) {
        goVipCenter("该背景为会员专属，开通会员后即可解锁");
        return;
      }
      applySkin(s.key);
      settings = await window.api.saveSettings({ skin: s.key });
    });
    grid.appendChild(card);
  }
  applySkin(window.__dokSkin || settings.skin || "lake");
}
/* ===== 界面动效（隐藏彩蛋：集齐全部成就徽章后解锁；仅点击特效，不改动元素原有样式） ===== */
const MOTIONS = [
  { key: "star",   icon: "🌟", name: "星光", desc: "点击处迸出星光粒子，轻盈飞散" },
  { key: "ripple", icon: "🌊", name: "涟漪", desc: "一圈圈水波向外荡开，层层扩散" },
  { key: "dust",   icon: "✨", name: "光点", desc: "彩色光点向四周飘散，朦胧轻闪" },
  { key: "burst",  icon: "💥", name: "星芒", desc: "十字光芒从点击处炸开，瞬间闪亮" },
  { key: "none",   icon: "🚫", name: "关闭", desc: "不显示点击特效" },
];
// 是否集齐全部 12 枚成就徽章（彩蛋/点击特效的解锁条件）
function allBadgesUnlocked() {
  const map = settings.unlockedBadges || {};
  return WEEKLY_BADGES.every((b) => !!map[b.id]);
}
// 彩蛋统一门控：会员是最高优先级前提，且需集齐全部成就——没有会员即使碰巧集齐成就也看不到
function eggUnlocked() {
  return isVipActive() && allBadgesUnlocked();
}
function applyMotion(key) {
  // 彩蛋未解锁（非会员或成就未集齐）前特效整体禁用；解锁后应用用户选择（默认星光）
  const unlocked = eggUnlocked();
  const k = !unlocked ? "none" : (MOTIONS.some((m) => m.key === key) ? key : "star");
  document.body.setAttribute("data-motion", k);
  const cards = document.querySelectorAll(".motion-card");
  cards.forEach((c) => c.classList.toggle("active", c.dataset.motion === k));
}
function renderMotions() {
  const grid = $("motion-grid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const m of MOTIONS) {
    const card = document.createElement("div");
    card.className = "motion-card";
    card.dataset.motion = m.key;
    card.innerHTML = `<div class="motion-icon">${m.icon}</div><div class="motion-name">${esc(m.name)}</div><div class="motion-desc">${esc(m.desc)}</div>`;
    card.addEventListener("click", async () => {
      applyMotion(m.key);
      settings = await window.api.saveSettings({ uiMotion: m.key });
    });
    grid.appendChild(card);
  }
  applyMotion(settings.uiMotion || "star");
}
// 皮肤专属特效展示区：每种主题的专属特效配色，只展示不可选择，切换主题即自动启用
function renderSkinFx() {
  const grid = $("motion-skinfx");
  if (!grid) return;
  grid.innerHTML = "";
  const current = window.__dokSkin || settings.skin || "lake";
  for (const s of SKINS) {
    const fx = FX_COLORS[s.key] || FX_COLORS.starrylake;
    const card = document.createElement("div");
    card.className = "skinfx-card";
    card.dataset.skin = s.key;
    card.title = `${s.name} 专属特效「${fx.name}」：开启专属开关并切换主题后，点击自动启用`;
    card.innerHTML = `<span class="skinfx-dot" style="background:${fx.c1}"></span>
      <span class="skinfx-name">${esc(s.name)}</span>
      <span class="skinfx-fx">${esc(fx.name)}</span>
      <span class="skinfx-tag">主题专属</span>`;
    if (settings.skinFx && s.key === current) card.classList.add("skinfx-active");
    grid.appendChild(card);
  }
}
// 彩蛋入口：集齐全部 12 枚成就徽章后，设置页才出现「界面动效」面板，点击特效从该刻起生效
function renderMotionPanel() {
  const panel = $("motion-panel");
  if (!panel) return;
  const all = eggUnlocked(); // 会员优先：非会员或未集齐成就都隐藏
  panel.hidden = !all;
  applyMotion(settings.uiMotion || "star"); // 未集齐时强制 none，集齐瞬间自动启用
  // 皮肤专属特效开关：开启后当前主题的专属粒子优先于上面四个全局特效
  const st = $("skin-fx-toggle");
  if (st) {
    st.checked = settings.skinFx === true;
    st.onchange = async () => {
      settings = await window.api.saveSettings({ skinFx: st.checked });
      renderSkinFx();
    };
  }
  // 页面动效：四种效果各自独立开关
  const list = $("motion-toggle-list");
  if (list) {
    list.innerHTML = "";
    for (const o of PAGE_FX_OPTS) {
      const row = document.createElement("div");
      row.className = "motion-toggle-row";
      row.innerHTML = `<div class="motion-toggle-info">
          <span class="motion-toggle-title">${o.icon} ${o.title}</span>
          <span class="motion-toggle-desc">${o.desc}</span>
        </div>
        <label class="switch"><input type="checkbox" data-fxkey="${o.key}"><span class="slider"></span></label>`;
      const input = row.querySelector("input");
      input.checked = settings[o.key] !== false;
      input.onchange = async () => {
        settings = await window.api.saveSettings({ [o.key]: input.checked });
      };
      list.appendChild(row);
    }
  }
}
// 当前生效的点击特效模式：开启皮肤专属 → 当前主题的专属粒子；否则 → 上面选择的全局特效
function activeFxMode() {
  if (eggUnlocked() && settings.skinFx) {
    const skin = window.__dokSkin || settings.skin || "lake";
    const fx = FX_COLORS[skin];
    return { type: fx ? fx.type : "star", skin };
  }
  return { type: document.body.getAttribute("data-motion") || "none", skin: null };
}
// 点击特效：在 fixed 覆盖层上生成星光/涟漪/光点/星芒/主题粒子，不触碰页面元素自身样式
function spawnClickFx(x, y) {
  const mode = activeFxMode();
  const motion = mode.type;
  if (!motion || motion === "none") return;
  const layer = document.createElement("div");
  layer.className = "click-fx";
  layer.style.left = x + "px";
  layer.style.top = y + "px";
  if (motion === "star") {
    const n = 6 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const s = document.createElement("i");
      s.className = "fx-star";
      const ang = (Math.PI * 2 * i) / n + Math.random() * 0.6;
      const dist = 24 + Math.random() * 30;
      s.style.setProperty("--dx", (Math.cos(ang) * dist).toFixed(1) + "px");
      s.style.setProperty("--dy", (Math.sin(ang) * dist).toFixed(1) + "px");
      s.style.setProperty("--rot", (Math.random() * 240 - 120).toFixed(0) + "deg");
      s.style.setProperty("--delay", (Math.random() * 90).toFixed(0) + "ms");
      layer.appendChild(s);
    }
    // 星星闪亮感：中心迸出几点闪光
    for (let i = 0; i < 3; i++) {
      const sp = document.createElement("i");
      sp.className = "fx-spark";
      sp.style.setProperty("--delay", (i * 50).toFixed(0) + "ms");
      layer.appendChild(sp);
    }
  } else if (motion === "ripple") {
    // 三圈同心涟漪依次荡开，层层扩散
    for (let i = 0; i < 3; i++) {
      const r = document.createElement("i");
      r.className = "fx-ripple";
      r.style.setProperty("--delay", (i * 90).toFixed(0) + "ms");
      r.style.setProperty("--size", (46 + i * 30).toFixed(0) + "px");
      layer.appendChild(r);
    }
  } else if (motion === "dust") {
    // 彩色光点向四周飘散（颜色取自当前皮肤的专属色板）
    const cs = getComputedStyle(document.body);
    const c1 = cs.getPropertyValue("--fx-c1").trim() || "#7ee8fa";
    const c2 = cs.getPropertyValue("--fx-c2").trim() || "#ffd76e";
    const c3 = cs.getPropertyValue("--fx-c3").trim() || "#c4b5fd";
    const colors = [c1, c2, c3];
    const n = 10;
    for (let i = 0; i < n; i++) {
      const d = document.createElement("i");
      d.className = "fx-dust";
      const ang = (Math.PI * 2 * i) / n + Math.random() * 0.5;
      const dist = 14 + Math.random() * 34;
      d.style.setProperty("--dx", (Math.cos(ang) * dist).toFixed(1) + "px");
      d.style.setProperty("--dy", (Math.sin(ang) * dist).toFixed(1) + "px");
      d.style.setProperty("--c", colors[i % colors.length]);
      d.style.setProperty("--s", (3 + Math.random() * 4).toFixed(1) + "px");
      d.style.setProperty("--delay", (Math.random() * 60).toFixed(0) + "ms");
      layer.appendChild(d);
    }
  } else if (motion === "burst") {
    // 中心闪光 + 八条光芒向四周炸开
    const b = document.createElement("i");
    b.className = "fx-burst";
    layer.appendChild(b);
    for (let i = 0; i < 8; i++) {
      const ray = document.createElement("i");
      ray.className = "fx-ray";
      ray.style.setProperty("--rot", ((360 / 8) * i).toFixed(0) + "deg");
      layer.appendChild(ray);
    }
  } else if (motion === "sun") {
    // 小太阳飞出：金色圆 + 光芒（日照金山 / 清晨大海）
    const n = 2;
    for (let i = 0; i < n; i++) {
      const sun = document.createElement("i");
      sun.className = "fx-sun";
      const ang = -Math.PI / 2 + Math.random() * 1.4 - 0.7;
      const dist = 36 + Math.random() * 30;
      sun.style.setProperty("--dx", (Math.cos(ang) * dist).toFixed(1) + "px");
      sun.style.setProperty("--dy", (Math.sin(ang) * dist).toFixed(1) + "px");
      sun.style.setProperty("--delay", (i * 130).toFixed(0) + "ms");
      for (let r = 0; r < 8; r++) {
        const ray = document.createElement("i");
        ray.className = "fx-ray-s";
        ray.style.setProperty("--rot", (r * 45).toFixed(0) + "deg");
        sun.appendChild(ray);
      }
      layer.appendChild(sun);
    }
  } else if (motion === "cloud") {
    // 云朵：1-2 朵彩云上浮摇摆
    const n = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const c = document.createElement("i");
      c.className = "fx-cloud";
      c.style.setProperty("--dx", (Math.random() * 34 - 17).toFixed(1) + "px");
      c.style.setProperty("--dy", (-(32 + Math.random() * 24)).toFixed(1) + "px");
      c.style.setProperty("--rot", (Math.random() * 24 - 12).toFixed(0) + "deg");
      c.style.setProperty("--delay", (i * 150).toFixed(0) + "ms");
      c.style.setProperty("--s", (0.8 + Math.random() * 0.5).toFixed(2));
      layer.appendChild(c);
    }
  } else if (motion === "leaf") {
    // 叶片：往下飘落旋转（森林 / 金叶 / 苇影 / 碧湖）
    const n = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const l = document.createElement("i");
      l.className = "fx-leaf";
      l.style.setProperty("--dx", (Math.random() * 46 - 23).toFixed(1) + "px");
      l.style.setProperty("--dy", (34 + Math.random() * 55).toFixed(1) + "px");
      l.style.setProperty("--rot", (Math.random() * 260 - 130).toFixed(0) + "deg");
      l.style.setProperty("--delay", (Math.random() * 160).toFixed(0) + "ms");
      l.style.setProperty("--s", (0.7 + Math.random() * 0.8).toFixed(2));
      layer.appendChild(l);
    }
  } else if (motion === "snow") {
    // 雪花：往下飘落旋转摇摆（雪峰 / 雪岭 / 晴空）
    const n = 5 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const s = document.createElement("i");
      s.className = "fx-snow";
      s.textContent = "❄";
      s.style.setProperty("--dx", (Math.random() * 50 - 25).toFixed(1) + "px");
      s.style.setProperty("--dy", (40 + Math.random() * 60).toFixed(1) + "px");
      s.style.setProperty("--rot", (Math.random() * 220 - 110).toFixed(0) + "deg");
      s.style.setProperty("--delay", (Math.random() * 200).toFixed(0) + "ms");
      s.style.setProperty("--s", (9 + Math.random() * 8).toFixed(0) + "px");
      layer.appendChild(s);
    }
  } else if (motion === "ember") {
    // 火星/碎金：小圆点四散 + 光晕（熔岩 / 暮海）
    const n = 8 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const e = document.createElement("i");
      e.className = "fx-ember";
      const ang = (Math.PI * 2 * i) / n + Math.random() * 0.8;
      const dist = 26 + Math.random() * 44;
      e.style.setProperty("--dx", (Math.cos(ang) * dist).toFixed(1) + "px");
      e.style.setProperty("--dy", (Math.sin(ang) * dist).toFixed(1) + "px");
      e.style.setProperty("--delay", (Math.random() * 120).toFixed(0) + "ms");
      e.style.setProperty("--s", (3 + Math.random() * 3).toFixed(0) + "px");
      layer.appendChild(e);
    }
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1500);
}
function setupClickFx() {
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest(".btn, .nav-item, .f-card, .folder-card, .card-entry, .kb-folder, .note-item, .skin-card, .weekly-badge, .gt-comm-item, .gt-detail-link, .motion-card, .vip-font-opt, .weekly-insight-note, .cat-modal-x, .donate-btn");
    if (!t) return;
    spawnClickFx(ev.clientX, ev.clientY);
  }, true);
}
// 跳转到设置页并定位会员中心（用于锁定皮肤等会员专属功能被点击时）
function goVipCenter(msg) {
  switchPage("settings");
  const panel = $("vip-panel");
  if (panel) {
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
    panel.classList.add("vip-glow");
    setTimeout(() => panel.classList.remove("vip-glow"), 2600);
  }
  const hint = $("vip-hint");
  if (hint) hint.textContent = msg || "该功能为会员专属，开通会员后即可解锁";
}

/* ================= 语义检索 ================= */
async function loadGlobalSearch() {
  const input = $("search-input");
  setTimeout(() => input && input.focus(), 60);
  const q = input && input.value.trim();
  if (q) doGlobalSearch();
}
async function doGlobalSearch() {
  const q = $("search-input").value.trim();
  const box = $("global-results");
  if (!q) { box.innerHTML = ""; return; }
  box.innerHTML = "<div class='panel' style='color:var(--text-2)'>检索中…</div>";
  const res = await window.api.vaultSearch(settings, q);
  if (!res.results.length) {
    box.innerHTML = "<div class='panel' style='color:var(--text-2)'>没有找到匹配的笔记</div>";
    return;
  }
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "sr-item";
  head.style.cursor = "default";
  head.textContent = `找到 ${res.results.length} 篇匹配笔记（点击打开）`;
  box.appendChild(head);
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  for (const r of res.results) {
    const item = document.createElement("div");
    item.className = "sr-item";
    item.innerHTML = `<div class="sr-title">${esc(r.title)}<span class="sr-count">命中 ${r.count} 处</span></div>
      <div class="sr-snippet">${esc(r.snippet).replace(re, (m) => `<mark>${m}</mark>`)}</div>`;
    item.addEventListener("click", () => openNoteByPath(r.path));
    box.appendChild(item);
  }
}
$("search-btn").addEventListener("click", doGlobalSearch);
$("search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") doGlobalSearch(); });
$("search-clear").addEventListener("click", () => { $("search-input").value = ""; $("global-results").innerHTML = ""; });

/* ================= 流水线页 ================= */
async function loadPipelinePage() {
  const meta = $("pipe-meta");
  const bar = $("pipe-bar");
  const barLabel = $("pipe-bar-label");
  const alert = $("pipe-alert");
  const res = await window.api.scheduleStatus(settings);
  if (!res || !res.ok) {
    meta.textContent = "无法读取状态：" + ((res && res.error) || "未知错误");
    return;
  }
  const task = res.task || {};
  const counts = res.counts || {};
  // 流水线进度条 = 本次定时任务/手动运行的实时进度（var\sync-progress.json）
  // 今日任务跑完 = 100%；运行中显示实时 done/total；无任务记录则提示尚未运行
  const progress = res.progress || null;
  const wasSkipped = !!(progress && progress.skipped);
  let pct = 0;
  let barText = "尚未运行定时任务/处理任务";
  if (progress) {
    if (progress.running) {
      pct = progress.percent ?? 0;
      const stageTxt = progress.stage ? ` · ${progress.stage}` : "";
      barText = `运行中 ${progress.done}/${progress.total || "?"}（${pct}%）${stageTxt}`;
      if (progress.stage === "paused") {
        barText = `已暂停（当前完成 ${progress.done}/${progress.total || "?"}）· 点「继续任务」恢复`;
      }
    } else if (progress.skipped) {
      pct = 0;
      barText = "本次任务被跳过（存在同步锁/上次同步未结束）";
    } else if ((progress.total || 0) > 0) {
      pct = 100;
      const at = progress.finishedAt ? new Date(progress.finishedAt).toLocaleString("zh-CN", { hour12: false }) : "";
      barText = `本次运行已完成（${progress.done}/${progress.total}）${at ? " · " + at : ""}`;
    } else {
      pct = 100;
      barText = "今日无待处理视频（增量窗口为空）";
    }
  }
  bar.style.width = pct + "%";
  barLabel.textContent = barText;
  let html = "";
  if (!task.exists) html = '<b class="bad">未安装定时任务</b> · 可在「设置 → 定时任务」里更新时间（会同时安装）';
  else {
    const stateCls = task.enabled ? "ok" : "warn";
    html = `任务状态：<b class="${stateCls}">${task.enabled ? "已启用" : "已停用"}</b> · 下次运行：<b>${esc(task.nextRun || "—")}</b>`;
    if (task.lastRun) {
      html += ` · <span class="${task.lastResult === 0 ? "ok" : "bad"}">上次${wasSkipped ? "被跳过（同步锁）" : (task.lastResult === 0 ? "成功 ✓" : "失败（代码 " + task.lastResult + "）")}</span>（${esc(task.lastRun)}）`;
    }
  }
  html += ` · ${res.countMode ? `数量窗口（最近 ${res.countLimit} 条）` : (res.windowStart ? `窗口（${res.windowStart} 起）` : "全库")}：待处理 <b>${counts.discovered ?? 0}</b> · 已写 <b>${counts.written ?? 0}</b> · 失败 <b>${counts.failed ?? 0}</b> · 跳过 <b>${counts.skipped ?? 0}</b>`;
  meta.innerHTML = html;
  alert.hidden = true;
  const notes = [];
  if (res.selfHeal && res.selfHeal.length) {
    notes.push(`<b>🛠 系统已自动修复：</b>${res.selfHeal.map((s) => esc(s)).join("<br>")}`);
  }
  if (task.exists && task.lastRun && task.lastResult !== 0) notes.push(`上次定时运行失败（返回码 ${task.lastResult}，${task.lastRun}）`);
  if (res.lock) {
    const ageMin = Math.round((Date.now() - new Date(res.lock.mtime).getTime()) / 60000);
    notes.push(ageMin < 120 ? `正在同步中（锁于 ${ageMin} 分钟前创建）…` : `检测到同步残留锁（${ageMin} 分钟前创建）：多半是上次同步异常退出。<button class="reset-stuck-btn">一键复位进度</button>`);
  }
  if (res.aiDiagnosis) {
    notes.push(`<b>AI 诊断：</b>` + esc(res.aiDiagnosis).split(" | ").join("<br>"));
  } else if (task.exists && task.lastRun && task.lastResult !== 0) {
    notes.push(`详细失败日志见下方「运行日志」窗口。`);
  }
  if (notes.length) {
    alert.hidden = false;
    alert.innerHTML = notes.join("<br>");
    const resetBtn = alert.querySelector(".reset-stuck-btn");
    if (resetBtn) resetBtn.addEventListener("click", doResetStuck);
  }
  // 定时任务失败时，把调度日志（含 AI 诊断结论）追加进下方「运行日志」窗口，就地查看，不去总览堆一坨
  if (res.logTail && (task.lastResult !== 0 || /FAILED|AI-DIAGNOSIS/.test(res.logTail))) {
    const logBox = $("pipe-log");
    if (logBox && logBox.innerText.indexOf("==== 定时任务调度日志 ====") === -1) {
      appendLog("\n==== 定时任务调度日志（最近一次运行）====\n");
      appendLog(res.logTail + "\n");
      if (res.aiDiagnosis) appendLog(`AI 诊断：${res.aiDiagnosis}\n`);
    }
  }
  updatePauseUi();
}
$("pipe-refresh").addEventListener("click", () => { loadPipelinePage(); updatePauseUi(); appendLog("\n==== 已刷新流水线状态 ====\n"); });

/* ================= 暂停 / 继续 / 清理 ================= */
async function updatePauseUi() {
  const st = $("pause-status");
  const btnPause = $("btn-pause");
  const btnResume = $("btn-resume");
  if (!st) return;
  const res = await window.api.pauseStatus(settings);
  if (!res || !res.ok) { st.textContent = "暂停状态读取失败"; return; }
  const autoMin = Number(res.pauseAutoResumeMinutes || 0);
  if (res.paused) {
    btnPause.hidden = true;
    btnResume.hidden = false;
    st.textContent = `已暂停${res.running ? "（任务正在等待，当前视频处理完即停）" : "（当前无任务在跑，下次启动会先停住）"}${autoMin > 0 ? ` · 电脑空闲 ${autoMin} 分钟自动恢复` : ""}`;
  } else {
    btnPause.hidden = false;
    btnResume.hidden = true;
    st.textContent = res.running ? "任务运行中 · 可随时暂停" : "当前没有任务在跑 · 可提前暂停（下次任务会停住）";
  }
}
$("btn-pause").addEventListener("click", async () => {
  const st = $("pause-status");
  st.textContent = "正在暂停…";
  const res = await window.api.pauseSync(settings);
  st.textContent = (res && res.ok) ? "已暂停：任务会在当前视频处理完后停在下一条之前" : ("暂停失败：" + ((res && res.error) || "未知错误"));
  updatePauseUi();
});
$("btn-resume").addEventListener("click", async () => {
  const st = $("pause-status");
  st.textContent = "正在继续…";
  const res = await window.api.resumeSync(settings);
  st.textContent = (res && res.ok) ? "已继续：任务将自动接着跑" : ("继续失败：" + ((res && res.error) || "未知错误"));
  updatePauseUi();
});
$("btn-cleanup-media").addEventListener("click", async () => {
  const st = $("cleanup-status");
  st.textContent = "正在清理…";
  const res = await window.api.cleanupMedia(settings);
  if (!res || !res.ok) {
    st.textContent = "清理未执行：" + ((res && (res.notice || res.error)) || "未知错误");
    return;
  }
  if (res.blocked) { st.textContent = "未清理：" + (res.notice || "同步任务正在运行"); return; }
  const mb = Math.round((res.bytesFreed || 0) / 1024 / 1024);
  st.textContent = `已清理 ${res.removed || 0} 个临时文件 · 释放约 ${mb} MB`;
});

/* ================= 我的技能 ================= */
async function loadSkillsPage() {
  const grid = $("skills-grid");
  const res = await window.api.distillList(settings);
  const list = res.list || [];
  $("skills-note").textContent = list.length ? `共 ${list.length} 个技能 · 仓颉引擎产物可直接被 AI 助手安装调用` : "还没有蒸馏技能，去「知识蒸馏」页蒸馏一个子类";
  grid.innerHTML = "";
  if (!list.length) return;
  for (const s of list) {
    const card = document.createElement("div");
    card.className = "skill-card";
    card.innerHTML = `
      <div class="skill-ico">✎</div>
      <div class="skill-main">
        <div class="skill-name">${esc(s.name)} <span class="engine-tag">${s.engine === "cangjie" ? "仓颉" : "旧版"}</span></div>
        <div class="skill-desc">${esc(s.description)}</div>
        <div class="skill-path">${esc(s.path)}</div>
      </div>
      <div class="skill-del" title="删除技能">🗑</div>`;
    card.querySelector(".skill-del").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const ok = await openCatModal({
        title: "删除技能",
        hint: `确定删除技能「${s.name}」吗？将同时删除其全部蒸馏产物，不可恢复。`,
        inputs: [],
        okLabel: "删除",
      });
      if (!ok) return;
      const r = await window.api.distillDelete(settings, s.name);
      if (!r || !r.ok) { toast("删除失败：" + ((r && r.error) || "未知错误"), true); return; }
      toast("已删除技能「" + s.name + "」");
      loadSkillsPage();
    });
    grid.appendChild(card);
  }
}
$("skills-refresh").addEventListener("click", loadSkillsPage);

/* ================= 知识卡片（原系统蓝图） ================= */
let cardListCache = null;
let cardDetailCache = null;
let cardActiveTab = "summary";

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statusLabel(status, count) {
  if (status === "generated") return `<span class="card-status ok">已整理</span>`;
  if (status === "below-threshold") return `<span class="card-status below">未达阈值</span>`;
  if (status === "no-material") return `<span class="card-status below">无实质内容</span>`;
  if (status === "skipped") return `<span class="card-status below">已跳过</span>`;
  return `<span class="card-status pending">待整理</span>`;
}

// 知识卡片统一图案：所有分类共用同一张书图案（可移植，其他用户拿到软件效果一致；路径相对 renderer/index.html）
function cardIcon() { return "../assets/card-icons/knowledge-book.png"; }

async function renderBlueprint() {
  $("card-note").textContent = "读取分类状态…";
  const res = await window.api.cardsList(settings);
  if (!res.ok) {
    $("card-note").textContent = "读取失败：" + (res.error || "未知错误");
    return;
  }
  cardListCache = res.cards || [];
  const grid = $("card-grid");
  grid.innerHTML = "";
  if (!cardListCache.length) {
    grid.innerHTML = '<div class="hint">还没有分类数据。先处理收藏生成笔记，再回来生成知识卡片。</div>';
    $("card-note").textContent = "";
    return;
  }
  const generatedCount = cardListCache.filter((c) => c.status === "generated").length;
  const thresholdCount = cardListCache.filter((c) => c.count >= (settings.cardMinVideos || 50)).length;
  $("card-note").textContent = `${cardListCache.length} 个大分类 · ${generatedCount} 张已整理 · ${thresholdCount} 个达到阈值（≥${settings.cardMinVideos || 50} 条）`;
  const pinnedCards = settings.pinnedCards || [];
  const list = [...cardListCache].sort(
    (a, b) => (pinnedCards.includes(b.major) ? 1 : 0) - (pinnedCards.includes(a.major) ? 1 : 0)
  );
  for (const c of list) {
    const isPin = pinnedCards.includes(c.major);
    const card = document.createElement("div");
    card.className = "folder-card card-entry" + (c.status === "generated" ? " has-card" : "");
    const sub = c.status === "generated"
      ? `${c.card?.consensus_points?.length || 0} 条印证观点 · ${c.card?.knowledge_points?.length || 0} 条知识 · ${fmtTime(c.generatedAt)} 更新`
      : `${c.count} 条视频笔记`;
    card.innerHTML = `
      <div class="f-icon"><img src="${cardIcon(c.major)}" alt="" loading="lazy"/></div>
      <div class="f-name">${esc(c.major)}</div>
      <div class="f-meta">${esc(sub)}</div>
      <div class="f-badges"><span class="f-badge">${c.count} 条</span>${statusLabel(c.status, c.count)}${isPin ? `<span class="f-badge f-badge-pin">📌 已置顶</span>` : ""}</div>
      <div class="card-more" title="卡片操作">⋯</div>`;
    card.addEventListener("click", () => openCardDetail(c.major));
    card.querySelector(".card-more").addEventListener("click", (ev) => {
      ev.stopPropagation();
      showCardMenu(ev.currentTarget, [
        {
          label: isPin ? "取消置顶" : "置顶卡片",
          action: async () => {
            const arr = settings.pinnedCards || [];
            const next = isPin ? arr.filter((x) => x !== c.major) : arr.concat(c.major);
            settings = await window.api.saveSettings({ pinnedCards: next });
            renderBlueprint();
          },
        },
        {
          label: "删除卡片",
          danger: true,
          action: async () => {
            const ok = await openCatModal({
              title: "删除知识卡片",
              hint: `确定删除「${c.major}」的知识卡片吗？删除后可在达到阈值后重新生成。`,
              inputs: [],
              okLabel: "删除",
            });
            if (!ok) return;
            const r = await window.api.cardsDelete(settings, c.major);
            if (!r || !r.ok) {
              toast("删除失败：" + ((r && r.error) || "未知错误"), true);
              return;
            }
            toast("已删除「" + c.major + "」的知识卡片");
            renderBlueprint();
          },
        },
      ]);
    });
    grid.appendChild(card);
  }
  // 从详情返回列表后：恢复网格与工具条
  $("card-grid").hidden = false;
  const kbTools = document.querySelector("#page-blueprint .kb-tools");
  if (kbTools) kbTools.hidden = false;
  $("card-detail").hidden = true;
}

async function openCardDetail(major) {
  // 新开一页：隐藏分类网格与工具条，只显示详情视图
  $("card-grid").hidden = true;
  const kbTools = document.querySelector("#page-blueprint .kb-tools");
  if (kbTools) kbTools.hidden = true;
  $("card-detail").hidden = false;
  const page = $("page-blueprint");
  if (page) page.scrollTop = 0;
  $("card-detail-title").textContent = major;
  $("card-detail-meta").textContent = "读取卡片…";
  $("card-tab-content").innerHTML = '<div class="hint">加载中…</div>';
  const res = await window.api.cardsRead(settings, major);
  if (!res.ok || !res.exists) {
    $("card-detail-meta").textContent = "还没有生成知识卡片";
    $("card-tab-content").innerHTML = `<div class="hint">该分类尚未整理。点击「重新生成」让 AI 提炼知识（视频数需达到 ${settings.cardMinVideos || 50} 条）。</div>`;
    cardDetailCache = null;
    return;
  }
  cardDetailCache = res.card || null;
  $("card-detail-meta").textContent = `${cardDetailCache?.count || 0} 条视频 · 更新于 ${fmtTime(cardDetailCache?.generatedAt)}`;
  renderCardTab(cardActiveTab);
}

function renderCardTab(tab) {
  cardActiveTab = tab;
  document.querySelectorAll(".card-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const box = $("card-tab-content");
  const card = cardDetailCache;
  if (!card) { box.innerHTML = '<div class="hint">暂无卡片数据。</div>'; return; }
  if (tab === "summary") {
    box.innerHTML = `
      <div class="card-summary">
        <div class="card-summary-abstract">${esc(card.summary || "（无摘要）")}</div>
        <div class="card-summary-grid">
          <div class="stat-card blue"><div class="stat-num">${card.consensus_points?.length || 0}</div><div class="stat-label">印证观点</div></div>
          <div class="stat-card green"><div class="stat-num">${card.knowledge_points?.length || 0}</div><div class="stat-label">单视频知识</div></div>
          <div class="stat-card amber"><div class="stat-num">${(card.mindmap?.children || []).length}</div><div class="stat-label">思维导图分支</div></div>
          <div class="stat-card slate"><div class="stat-num">${card.table?.rows?.length || 0}</div><div class="stat-label">速查表条目</div></div>
        </div>
        <div class="card-consensus-preview">
          <div class="panel-title" style="margin-bottom:10px">最受印证的观点</div>
          ${renderConsensusList((card.consensus_points || []).slice(0, 5))}
        </div>
      </div>`;
  } else if (tab === "consensus") {
    box.innerHTML = card.consensus_points?.length
      ? renderConsensusList(card.consensus_points)
      : '<div class="hint">暂无互相印证的观点。</div>';
  } else if (tab === "mindmap") {
    box.innerHTML = renderMindmap(card.mindmap || { root: card.major, children: [] });
  } else if (tab === "network") {
    box.innerHTML = renderNetwork(card.network || { nodes: [], links: [] });
  } else if (tab === "table") {
    box.innerHTML = renderCardTable(card.table || { rows: [] });
  } else if (tab === "knowledge") {
    box.innerHTML = card.knowledge_points?.length
      ? `<div class="knowledge-grid">${card.knowledge_points.map((k) => `
        <div class="knowledge-item">
          <div class="knowledge-title">${esc(k.title)}</div>
          <div class="knowledge-detail">${esc(k.detail)}</div>
          ${k.source_video ? `<div class="knowledge-source">来源：${esc(k.source_video)}</div>` : ""}
        </div>`).join("")}</div>`
      : '<div class="hint">暂无单视频知识。</div>';
  }
}

function renderConsensusList(points) {
  return `<div class="consensus-list">${points.map((p, i) => `
    <div class="consensus-item">
      <div class="consensus-title"><span class="consensus-no">${i + 1}</span>${esc(p.title)}</div>
      <div class="consensus-statement">${esc(p.statement)}</div>
      <div class="consensus-meta"><span class="f-badge">${p.confirmed_by} 个视频印证</span></div>
      <div class="consensus-sources">${(p.source_videos || []).map((v) => `<span class="src-chip">${esc(v)}</span>`).join("")}</div>
    </div>`).join("")}</div>`;
}

function renderMindmap(mindmap) {
  const root = esc(mindmap.root || "知识");
  const branches = (mindmap.children || []).map((b, bi) => `
    <div class="mm-branch">
      <div class="mm-branch-name">${esc(b.name || "分支" + (bi + 1))}</div>
      <div class="mm-children">${(b.children || []).map((ch) => `<div class="mm-child">${esc(ch.name || ch)}</div>`).join("") || '<div class="mm-child dim">—</div>'}</div>
    </div>`).join("");
  return `
    <div class="mindmap">
      <div class="mm-root">${root}</div>
      <div class="mm-branches">${branches || '<div class="hint">暂无思维导图数据。</div>'}</div>
    </div>`;
}

function renderNetwork(network) {
  const nodes = network.nodes || [];
  const links = network.links || [];
  if (!nodes.length) return '<div class="hint">暂无印证网络数据。</div>';
  const ideaNodes = nodes.filter((n) => n.type !== "video");
  const videoNodes = nodes.filter((n) => n.type === "video");
  // 画布高度按最长列（观点两列 / 视频一列）估算，避免节点多时被裁掉
  const rowsMax = Math.max(Math.ceil(ideaNodes.length / 2), videoNodes.length);
  const W = 900, H = Math.max(320, rowsMax * 46 + 40);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pos = new Map();
  // 观点节点：左侧两列均匀排布；视频节点：右侧一列
  const colWidth = 300;
  ideaNodes.forEach((n, i) => {
    const perCol = Math.max(1, Math.ceil(ideaNodes.length / 2));
    pos.set(n.id, { x: 60 + Math.floor(i / perCol) * colWidth + (Math.floor(i / perCol) ? 30 : 0), y: 30 + (i % perCol) * Math.max(46, (H - 60) / perCol) });
  });
  videoNodes.forEach((n, i) => {
    pos.set(n.id, { x: W - 220, y: 30 + i * Math.max(40, (H - 60) / Math.max(1, videoNodes.length)) });
  });
  // 统计同一 观点→视频 对上的连线数，用于把曲线错开，避免多条线叠成一条
  const pairCount = new Map();
  for (const link of links) {
    const k = link.source + "::" + link.target;
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
  }
  const pairIdx = new Map();
  const GREEN = "#6ee7b7", YELLOW = "#fcd34d";
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-height:${H}px">`;
  svg += `<defs>
    <marker id="arr2" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="${GREEN}"/></marker>
    <marker id="arr3" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="${YELLOW}"/></marker>
  </defs>`;
  // 先画全部连线（下层），贝塞尔曲线 + 错开弧度 + 带底板的标签
  for (const link of links) {
    const a = pos.get(link.source), b = pos.get(link.target);
    if (!a || !b) continue;
    const isExtra = link.relation === "补充";
    const color = isExtra ? YELLOW : GREEN;
    const k = link.source + "::" + link.target;
    const idx = pairIdx.get(k) || 0;
    pairIdx.set(k, idx + 1);
    const sx = a.x + 150, sy = a.y;
    const tx = b.x, ty = b.y;
    // 控制点：中点先上移 18，再按同对序号左右错开，让并行线各自分开
    const bend = (idx - (pairCount.get(k) - 1) / 2) * 30;
    const cx = (sx + tx) / 2 + bend;
    const cy = (sy + ty) / 2 - 24;
    svg += `<path d="M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}" fill="none" stroke="${color}" stroke-width="1.4" opacity="0.6" marker-end="url(${isExtra ? "#arr3" : "#arr2"})"/>`;
    // 标签：深色底板 + 彩色文字，压在曲线中段上方，和线分离开
    svg += `<g transform="translate(${cx} ${cy - 11})">
      <rect x="-17" y="-9" width="34" height="17" rx="8.5" fill="rgba(15,23,42,0.92)" stroke="${color}" stroke-width="0.9"/>
      <text x="0" y="3.5" text-anchor="middle" font-size="9.5" fill="${color}" style="pointer-events:none">${isExtra ? "补充" : "印证"}</text>
    </g>`;
  }
  // 再画节点（上层，盖在线之上）
  for (const [id, p] of pos) {
    const n = byId.get(id);
    const isIdea = n.type !== "video";
    const raw = n.label || "";
    const maxChars = isIdea ? 14 : 18;
    const label = esc(raw.length > maxChars ? raw.slice(0, maxChars) + "…" : raw);
    svg += `<g>
      <title>${esc(raw)}</title>
      <rect x="${p.x}" y="${p.y - 13}" width="${isIdea ? 150 : 190}" height="26" rx="13"
        fill="${isIdea ? "rgba(110,231,183,0.16)" : "rgba(124,227,255,0.14)"}"
        stroke="${isIdea ? "rgba(110,231,183,0.5)" : "rgba(124,227,255,0.45)"}" stroke-width="1"/>
      <text x="${p.x + (isIdea ? 75 : 95)}" y="${p.y + 4}" text-anchor="middle" font-size="10.5" fill="#eef2f8" style="pointer-events:none">${label}</text>
    </g>`;
  }
  svg += `</svg>`;
  const legend = `
    <div class="network-legend">
      <span><i class="dot idea"></i>观点</span>
      <span><i class="dot video"></i>视频</span>
      <span><i class="line confirm"></i>印证</span>
      <span><i class="line extra"></i>补充</span>
    </div>`;
  return `<div class="network-wrap">${legend}${svg}</div>`;
}

function renderCardTable(table) {
  const rows = table.rows || [];
  if (!rows.length) return '<div class="hint">暂无速查表数据。</div>';
  return `<table class="card-table"><thead><tr><th style="width:22%">主题</th><th>速查口径 / 结论</th></tr></thead><tbody>${rows.map((r) => `
    <tr><td class="table-topic">${esc(r.topic)}</td><td>${esc(r.verdict)}</td></tr>`).join("")}</tbody></table>`;
}

/* 生成/刷新卡片 */
async function generateCard(major, all = false) {
  const note = $("card-note");
  const box = $("card-tab-content");
  if (all) {
    note.textContent = `正在生成全部达到阈值（≥${settings.cardMinVideos || 50} 条）分类的知识卡片…（每个分类一次 AI 调用，需要一些时间）`;
  } else {
    box.innerHTML = '<div class="hint">正在让 AI 提炼知识（一次 DeepSeek 调用，约 1-3 分钟）…</div>';
    note.textContent = `正在生成「${major}」知识卡片…`;
  }
  openLogPanel();
  appendLog(all ? "\n==== 生成全部知识卡片 ====\n" : `\n==== 生成「${major}」知识卡片 ====\n`);
  try {
    if (all) {
      const list = cardListCache || [];
      let generated = 0, skipped = 0;
      for (const c of list) {
        if (c.count < (settings.cardMinVideos || 50)) { skipped += 1; continue; }
        const res = await window.api.cardsGenerate(settings, c.major);
        appendLog(res && res.ok ? `「${c.major}」→ ${res.status}\n` : `「${c.major}」→ 失败：${(res && res.error) || ""}\n`);
        if (res && res.ok && res.status === "generated") generated += 1;
      }
      appendLog(`\n==== 完成：生成 ${generated} 张，跳过 ${skipped} 个未达阈值分类 ====\n`);
      note.textContent = `完成：生成 ${generated} 张知识卡片`;
    } else {
      const res = await window.api.cardsGenerate(settings, major);
      appendLog(res && res.ok ? `「${major}」→ ${res.status}\n` : `「${major}」→ 失败：${(res && res.error) || ""}\n`);
      note.textContent = res && res.ok ? (res.status === "generated" ? "卡片已更新" : "未生成（" + res.status + "）") : ("生成失败：" + (res.error || ""));
    }
  } finally {
    appendLog("\n==== 结束 ====\n");
  }
  await renderBlueprint();
  if (!all && major) await openCardDetail(major);
}

$("card-refresh-all").addEventListener("click", () => generateCard("", true));
$("card-refresh-list").addEventListener("click", renderBlueprint);
$("card-back").addEventListener("click", () => {
  $("card-detail").hidden = true;
  $("card-grid").hidden = false;
  const kbTools = document.querySelector("#page-blueprint .kb-tools");
  if (kbTools) kbTools.hidden = false;
  renderBlueprint();
});
$("card-regen").addEventListener("click", () => {
  const major = $("card-detail-title").textContent;
  if (major) generateCard(major, false);
});
document.querySelectorAll(".card-tab").forEach((b) => {
  b.addEventListener("click", () => renderCardTab(b.dataset.tab));
});

/* ================= 止损看板 ================= */
let failFiles = [];
async function loadFailures() {
  const res = await window.api.failuresList(settings);
  failFiles = res.files || [];
  const sel = $("fail-file");
  sel.innerHTML = "";
  if (!failFiles.length) {
    $("fail-note").textContent = "还没有失败清单文件（处理后会自动生成）";
    $("fail-content").innerHTML = '<div class="hint">暂无数据。</div>';
    return;
  }
  $("fail-note").textContent = `${failFiles.length} 份清单 · 每份汇总当日失败与跳过视频`;
  for (const f of failFiles) {
    const o = document.createElement("option");
    o.value = f.name;
    o.textContent = f.name.replace(/^失败视频清单-/, "").replace(/\.md$/, "");
    sel.appendChild(o);
  }
  renderFailFile(failFiles[0]);
}
function renderFailFile(f) {
  $("fail-content").innerHTML = window.api.renderMarkdown(f.content);
  const links = $("fail-content").querySelectorAll("a");
  links.forEach((a) => a.setAttribute("target", "_blank"));
}
$("fail-file").addEventListener("change", () => {
  const f = failFiles.find((x) => x.name === $("fail-file").value);
  if (f) renderFailFile(f);
});
$("fail-refresh").addEventListener("click", loadFailures);

/* ================= 新增收藏：核对与补充 ================= */
const NEW_STATUS_TEXT = { discovered: "待处理", media_frozen: "待处理", transcribed: "已转录", extracted: "已提取", failed: "失败", written: "已生成", skipped: "已跳过" };
const NEW_STATUS_CLASS = { written: "st-ok", skipped: "st-muted", failed: "st-bad" };

async function loadNewArrivals() {
  const days = Math.max(0, Number($("new-range").value || 7));
  const box = $("new-list");
  try {
    const res = await window.api.newArrivals(settings, { days, limit: 200 });
    if (!res || !res.ok) { box.innerHTML = `<div class="hint">加载失败：${esc(res && res.error || "未知错误")}</div>`; return; }
    const items = (res.items || []).filter((it) => it.status !== "skipped"); // 跳过类（广告/短剧/音乐/舞蹈等娱乐类）不占核对位
    if (!items.length) {
      box.innerHTML = `<div class="hint">${days ? `最近 ${days} 天没有新增收藏` : "还没有收藏记录"}（已跳过的广告/短剧/娱乐类不显示）。</div>`;
      return;
    }
    box.innerHTML = `<table class="new-table">
      <thead><tr><th>标题</th><th>新增时间</th><th>状态</th><th>分类</th><th>抖音链接</th></tr></thead>
      <tbody>${items.map((it) => {
        const t = it.title || `视频 ${it.aweme_id}`;
        const when = String(it.discovered_at || "").slice(0, 10);
        const cls = [(it.category || ""), (it.group || ""), (it.subcategory || "")].filter(Boolean).join(" · ");
        return `<tr>
          <td class="td-title" title="${esc(t)}">${esc(t.length > 60 ? t.slice(0, 60) + "…" : t)}</td>
          <td class="muted">${esc(when)}</td>
          <td><span class="tag ${NEW_STATUS_CLASS[it.status] || ""}">${NEW_STATUS_TEXT[it.status] || esc(it.status)}</span></td>
          <td class="muted">${esc(cls) || "—"}</td>
          <td><a href="${esc(it.source_url || `https://www.douyin.com/video/${it.aweme_id}`)}" target="_blank" rel="noopener">打开 ↗</a></td>
        </tr>`;
      }).join("")}</tbody></table>
      <div class="new-count">共显示 ${items.length} 条 · 已跳过的广告/短剧/娱乐类不列出，可到「止损看板」查看</div>`;
  } catch (e) {
    box.innerHTML = `<div class="hint">加载失败：${esc(e && e.message || e)}</div>`;
  }
}

async function addVideos(processNow) {
  const raw = $("new-urls").value;
  const urls = raw.split(/[\s,;，；]+/).map((s) => s.trim()).filter(Boolean);
  const st = $("new-add-status");
  if (!urls.length) { st.textContent = "请先粘贴至少一条抖音视频链接"; return; }
  st.textContent = processNow ? "正在添加并逐条转录处理（较慢，请稍候）…" : "正在加入待处理…";
  try {
    const res = await window.api.addVideos(settings, { urls, processNow });
    if (!res || !res.ok) { st.textContent = "失败：" + (res && res.error || "未知错误"); return; }
    const summary = (res.results || []).map((r) => r.ok ? (r.added ? "已新增" : `已存在（${r.status || "?"}）`) : ("解析失败")).join("、");
    const done = (res.processed || []).filter((p) => p.code === 0).length;
    st.textContent = `完成：${summary}${processNow ? ` · 已处理 ${done} 条` : " · 等下次定时任务处理"}`;
    $("new-urls").value = "";
    loadNewArrivals();
  } catch (e) {
    st.textContent = "出错：" + (e && e.message || e);
  }
}

$("new-add-now").addEventListener("click", () => addVideos(true));
$("new-add-queue").addEventListener("click", () => addVideos(false));
$("new-refresh").addEventListener("click", loadNewArrivals);
$("new-range").addEventListener("change", loadNewArrivals);

/* ================= 会员兑换 ================= */
// 兑换码规则（与作者生成器 var\gen-vip-codes.mjs 一致）：
//   13 位 [0-9A-Za-z]；第 9 位 = 小写 q；第 1 位 == 第 12 位；第 13 位 = 前 12 位码值和的校验位
// 内置默认兑换服务器：打包分发前把正式网址填在这里（不要带末尾斜杠），
// 所有使用者的软件都会自动带此地址联网查重；设置页填了地址则以设置页为准。
const VIP_DEFAULT_SERVER = ""; // 开源版：不连接兑换服务器，所有功能免费开放
const VIP_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function vipChecksum(s12) {
  let sum = 0;
  for (let i = 0; i < s12.length; i++) sum += s12.charCodeAt(i);
  return VIP_CHARSET[sum % VIP_CHARSET.length];
}
function validVipCode(code) {
  const s = String(code || "").trim();
  if (s.length !== 13 || !/^[0-9A-Za-z]{13}$/.test(s)) return false;
  if (s[8] !== "q" || s[0] !== s[11]) return false;
  return s[12] === vipChecksum(s.slice(0, 12));
}
// VIP 专属字体（fontsource/Google Fonts 开源字体，本地自托管，仅会员可切换）
function isVipActive() {
  return true; // 开源版：所有功能免费开放
}

// 一键复位：残留锁/进度条卡死时由告警区按钮触发，主进程会先确认同步进程真的死了才动手
async function doResetStuck() {
  const r = await window.api.resetStuck();
  if (r.ok) {
    toast("已复位：残留锁已清除，进度已重置");
    setTimeout(() => { loadScheduleStatus().catch(() => {}); loadPipelinePage().catch(() => {}); }, 600);
  } else {
    toast(r.msg || r.error || "复位失败");
  }
}
const VIP_FONTS = {
  default: { name: "默认字体", family: "" },
  qkhy: { name: "清刻黄油体", family: "'ZCOOL QingKe HuangYou', sans-serif" },
  kuaile: { name: "快乐体", family: "'ZCOOL KuaiLe', sans-serif" },
  zhimang: { name: "志莽行书", family: "'Zhi Mang Xing', cursive" },
  xiaowei: { name: "站酷小薇", family: "'ZCOOL XiaoWei', serif" },
  maszheng: { name: "马善政毛笔", family: "'Ma Shan Zheng', cursive" },
  wenkai: { name: "霞鹜文楷", family: "'LXGW WenKai', serif" },
  zhenkai: { name: "霞鹜臻楷", family: "'LXGW ZhenKai', cursive" },
};
function applyVipFont() {
  const vip = settings && settings.vip;
  const active = isVipActive();
  const key = active && VIP_FONTS[vip.font] ? vip.font : "default";
  document.body.style.fontFamily = VIP_FONTS[key].family || "";
  const opts = document.querySelectorAll(".vip-font-opt");
  opts.forEach((o) => o.classList.toggle("active", o.dataset.font === key));
}
// 全局字体大小（12-18px，随设置持久化；基础字号通过 --fs 驱动各文本档位缩放）
function applyFontSize(px) {
  const v = Math.max(12, Math.min(18, Math.round(Number(px) || 14)));
  document.body.style.setProperty("--fs", v + "px");
  const range = $("fs-range");
  if (range) range.value = v;
  const val = $("fs-val");
  if (val) val.textContent = v;
  const st = $("fs-state");
  if (st) st.textContent = v === 14 ? "默认 14" : "当前 " + v;
}
function renderVipStatus() {
  const vip = settings && settings.vip;
  const el = $("vip-status");
  const fontsBox = $("vip-fonts");
  const fontsState = $("vip-fonts-state");
  if (isVipActive()) {
    el.textContent = "会员已开通 ✓";
    el.classList.add("on");
    $("vip-hint").textContent = `开通时间：${vip.activatedAt || ""}${vip.nick ? " · " + vip.nick : ""}。感谢支持，专属权益已解锁。`;
    if (fontsBox) { fontsBox.classList.remove("locked"); }
    if (fontsState) { fontsState.textContent = "已解锁"; }
  } else {
    el.textContent = "未开通";
    el.classList.remove("on");
    $("vip-hint").textContent = "";
    if (fontsBox) { fontsBox.classList.add("locked"); }
    if (fontsState) { fontsState.textContent = "开通会员解锁"; }
  }
  applyVipFont();
}
document.querySelectorAll(".vip-font-opt").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!isVipActive()) { $("vip-font-hint").textContent = "开通会员后即可使用专属字体"; return; }
    const key = btn.dataset.font;
    if (!VIP_FONTS[key]) return;
    settings = await window.api.saveSettings({ vip: { ...(settings.vip || {}), font: key } });
    applyVipFont();
    $("vip-font-hint").textContent = key === "default" ? "已恢复默认字体" : `已切换为「${VIP_FONTS[key].name}」，重启软件后依然生效`;
    toast(`已切换 VIP 字体：${VIP_FONTS[key].name}`);
  });
});
$("fs-range").addEventListener("input", async () => {
  const v = Number($("fs-range").value);
  applyFontSize(v);
  settings = await window.api.saveSettings({ fontSize: v });
  $("fs-hint").textContent = "已设为 " + v + "px，全界面立即生效";
});
$("fs-reset").addEventListener("click", async () => {
  $("fs-range").value = 14;
  applyFontSize(14);
  settings = await window.api.saveSettings({ fontSize: 14 });
  $("fs-hint").textContent = "已恢复默认字号 14px";
});
$("btn-vip-redeem").addEventListener("click", async () => {  const code = $("vip-code").value.trim();
  if (!code) { $("vip-hint").textContent = "请先输入兑换码"; return; }
  if (!validVipCode(code)) { $("vip-hint").textContent = "兑换码无效，请检查后重试"; return; }
  if (isVipActive()) { $("vip-hint").textContent = "当前已是会员，无需重复兑换"; return; }

  // 内置默认兑换服务器（作者打包时填好正式地址）：非空则先联网查重登记，实现一码一用
  const server = VIP_DEFAULT_SERVER.replace(/\/+$/, "");
  if (server) {
    let hint = "";
    try {
      const result = await window.api.vipRedeem(server, code, settings.deviceId || "unknown");
      if (!result.ok) { hint = "无法连接兑换服务器，请检查网络后重试（配置了服务器地址后需联网兑换）"; }
      else {
        const data = result.data;
        if (!data || data.ok !== true) {
          hint = data && data.reason === "used"
            ? "该兑换码已被使用" + (data.device ? "（首次使用设备: " + data.device + "）" : "") + "，请确认是否本人操作"
            : (data && data.msg ? "兑换失败：" + data.msg : "兑换失败，请稍后重试");
        }
      }
    } catch (err) {
      hint = "无法连接兑换服务器，请检查网络后重试（配置了服务器地址后需联网兑换）";
    }
    if (hint) { $("vip-hint").textContent = hint; return; }
  }

  const issued = await window.api.vipIssue({ code, activatedAt: new Date().toLocaleString("zh-CN", { hour12: false }) });
  if (!issued.ok) { $("vip-hint").textContent = "开通状态写入失败，请重试"; return; }
  vipState = { active: true, code };
  settings = await window.api.getSettings();
  renderVipStatus();
  toast("会员开通成功 ✓ 专属权益已解锁");
  $("vip-code").value = "";
});

/* ================= 每周知识周报 ================= */
const WEEKLY_COLORS = ["#38bdf8", "#818cf8", "#34d399", "#fbbf24", "#f472b6", "#f87171", "#2dd4bf", "#a78bfa"];
function weeklyDonutSvg(byCategory) {
  const total = byCategory.reduce((s, c) => s + c.count, 0);
  if (total <= 0) return "";
  const top = byCategory.slice(0, 7);
  const restCount = byCategory.slice(7).reduce((s, c) => s + c.count, 0);
  const slices = top.slice();
  if (restCount > 0) slices.push({ name: "其他", count: restCount });
  const size = 136, cx = 68, cy = 68, r = 52, sw = 24;
  let acc = 0;
  let paths = "";
  slices.forEach((s, i) => {
    const a0 = (acc / total) * 2 * Math.PI - Math.PI / 2;
    const a1 = ((acc + s.count) / total) * 2 * Math.PI - Math.PI / 2;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const large = s.count / total > 0.5 ? 1 : 0;
    paths += `<path d="M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}" fill="none" stroke="${WEEKLY_COLORS[i % WEEKLY_COLORS.length]}" stroke-width="${sw}"/>`;
    acc += s.count;
  });
  return `<svg class="weekly-donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths}
    <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="22" font-weight="700" fill="var(--primary)">${total}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="9.5" fill="var(--text-2)">本周新增</text></svg>`;
}
function weeklyLegendHtml(byCategory) {
  const total = byCategory.reduce((s, c) => s + c.count, 0);
  if (total <= 0) return "";
  const slices = byCategory.slice(0, 7);
  const restCount = byCategory.slice(7).reduce((s, c) => s + c.count, 0);
  if (restCount > 0) slices.push({ name: "其他", count: restCount });
  return slices.map((r, i) =>
    `<div class="weekly-legend-row">
      <span class="weekly-legend-dot" style="background:${WEEKLY_COLORS[i % WEEKLY_COLORS.length]}"></span>
      <span class="weekly-legend-name">${esc(r.name)}</span>
      <span class="weekly-legend-count">${r.count} 篇</span>
    </div>`).join("");
}
/* 成就徽章定义：hidden=true 的成就达成条件保密（显示 ？？？），解锁瞬间揭晓并弹出 */
const WEEKLY_BADGES = [
  { id: "first",    emoji: "🌱", name: "迈出第一步", desc: "开启你的第一份每周周报",     hidden: false, check: (s, st) => st.totalShown >= 1 },
  { id: "weekly",   emoji: "📚", name: "周周有余",   desc: "本周新增至少 1 篇笔记",       hidden: false, check: (s) => s.weekNewNotes >= 1 },
  { id: "both",     emoji: "🎉", name: "双喜临门",   desc: "本周笔记与知识卡片都有新增", hidden: false, check: (s) => s.weekNewNotes >= 1 && s.weekNewCards >= 1 },
  { id: "cats",     emoji: "🗂️", name: "分类大师",   desc: "本周新增覆盖 5 个大类",       hidden: false, check: (s) => s.byCategory.length >= 5 },
  { id: "ten",      emoji: "🔥", name: "高产达人",   desc: "单周新增 ≥ 10 篇笔记",       hidden: false, check: (s) => s.weekNewNotes >= 10 },
  { id: "bronze",   emoji: "🥉", name: "渐入佳境",   desc: "连续 2 周达成周报",           hidden: false, check: (s, st) => st.streak >= 2 },
  { id: "silver",   emoji: "🥈", name: "持之以恒",   desc: "连续 4 周达成周报",           hidden: false, check: (s, st) => st.streak >= 4 },
  { id: "hundred",  emoji: "📈", name: "知识博主",   desc: "累计笔记达到 100 篇",         hidden: false, check: (s) => s.totalNotes >= 100 },
  { id: "storm",    emoji: "⚡", name: "知识喷涌",   desc: "单周新增 ≥ 30 篇笔记",        hidden: true,  check: (s) => s.weekNewNotes >= 30 },
  { id: "card5",    emoji: "💎", name: "卡片收藏家", desc: "累计生成 ≥ 5 张知识卡片",     hidden: true,  check: (s) => s.totalCards >= 5 },
  { id: "peak",     emoji: "🏔️", name: "登峰造极",  desc: "单周新增 ≥ 50 篇笔记",        hidden: true,  check: (s) => s.weekNewNotes >= 50 },
  { id: "grand",    emoji: "🏛️", name: "博学大师",  desc: "累计笔记达到 300 篇",        hidden: true,  check: (s) => s.totalNotes >= 300 },
];
// 由 weeklyStats 结果 + 设置计算周报状态（连续周数等）
function weeklyState(res, wr) {
  const todayKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`;
  const lastDate = (wr && wr.lastShownDate) || "";
  let streak = (wr && wr.streak) || 0;
  if (res.weekNewNotes > 0) {
    streak = (lastDate && Math.round((Date.parse(todayKey) - Date.parse(lastDate)) / 86400000) === 7) ? streak + 1 : 1;
  }
  return { ...res, totalShown: (wr && wr.totalShown) || 0, streak, todayKey };
}
// 渲染并展示本周周报；onClose 可选（自动弹窗时传 ack，按钮查看不传）
// 分级：非会员看基础版（饼图+统计+连续周数），会员解锁完整版（词云/本周洞察/本周小结/成就徽章）
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const CLOUD_STOP = new Set(["视频", "抖音", "知识", "怎么", "如何", "什么", "这个", "那个", "一个", "就是", "还是", "不是", "可以", "我们", "你们", "他们", "自己", "今天", "真的", "知道", "没有", "进行", "相关", "内容", "分享", "教程", "方法", "技巧", "干货", "学会", "实用", "新手", "讲解", "分钟", "收藏", "记录", "看完", "共识", "观点", "共识观点", "知识卡片", "知识卡"]);
function buildWordCloud(titles, top = 10) {
  const freq = new Map();
  for (const t of titles) {
    const segs = String(t || "").match(/[\u4e00-\u9fa5]{2,}/g) || [];
    for (const seg of segs) {
      const n = seg.length;
      if (n < 2 || n > 12) continue;
      for (let w = 2; w <= 4; w++) {
        for (let i = 0; i + w <= n; i++) {
          const g = seg.slice(i, i + w);
          if (CLOUD_STOP.has(g)) continue;
          freq.set(g, (freq.get(g) || 0) + w);
        }
      }
    }
  }
  return Array.from(freq.entries())
    .map(([word, w]) => ({ word, w }))
    .sort((a, b) => b.w - a.w)
    .slice(0, top);
}
async function renderWeeklyReport(onClose) {
  const res = await window.api.weeklyStats(settings);
  if (!res || !res.ok) { toast("周报数据读取失败" + (res && res.error ? "：" + res.error : "")); return; }
  const st = weeklyState(res, settings.weeklyReport || {});
  const body = $("weekly-modal-body");
  // —— 基础版（所有用户可见）：统计卡 + 本周 AI 消耗 + 饼图 + 连续周数 ——
  const dN = res.weekNewNotes - res.lastWeekNewNotes;
  const dNText = dN > 0 ? `较上周 +${dN}` : dN < 0 ? `较上周 ${dN}` : "与上周持平";
  const dNCls = dN > 0 ? "up" : dN < 0 ? "down" : "flat";
  let html = `
    <div class="weekly-range">📅 ${res.weekStart} ~ ${res.weekEnd} · 本周知识周报</div>
    <div class="weekly-stats">
      <div class="weekly-stat"><b>${res.weekNewNotes}</b><span>本周新增笔记</span><em class="stat-delta ${dNCls}">${dNText}</em></div>
      <div class="weekly-stat"><b>${res.weekNewCards}</b><span>本周新增卡片</span></div>
      <div class="weekly-stat"><b>${res.totalNotes}</b><span>累计笔记</span></div>
    </div>
    <div class="weekly-usage" id="weekly-usage">⚡ 正在统计本周 AI 消耗…</div>
    ${res.byCategory.length
      ? `<div class="weekly-chart-row">${weeklyDonutSvg(res.byCategory)}<div class="weekly-legend">${weeklyLegendHtml(res.byCategory)}</div></div>`
      : `<div class="weekly-empty">本周还没有新增笔记 📭<br>定时任务每天会自动整理你的新收藏，下周记得来看成果～</div>`}
    ${res.weekNewNotes > 0 ? `<div class="weekly-streak-line">🏆 连续坚持 <b>${st.streak}</b> 周，知识库正在长成你的第二大脑</div>` : ""}`;
  // 开源版：只保留基础周报，不显示词云/洞察/AI小结/成就徽章
  body.innerHTML = html;
  renderApiUsage(res);
  const modal = $("weekly-modal");
  modal.hidden = false;
  const close = () => {
    modal.hidden = true;
    $("weekly-modal-x").removeEventListener("click", close);
    $("weekly-modal-ok").removeEventListener("click", close);
    if (onClose) onClose();
  };
  $("weekly-modal-x").addEventListener("click", close);
  $("weekly-modal-ok").addEventListener("click", close);
  const topEl = $("weekly-top-note");
  if (topEl) {
    topEl.addEventListener("click", async () => {
      const p = topEl.dataset.path;
      if (!p) return;
      modal.hidden = true;
      switchPage("knowledge");
      await openNoteByPath(p);
    });
  }
}
// 本周 API 消耗（仅统计本软件发起的 AI 调用）+ 账户余额参考（余额为账户级，可能被其他项目共用）
async function renderApiUsage(res) {
  const box = $("weekly-usage");
  if (!box) return;
  const au = res.apiUsage || {};
  const calls = au.calls || 0;
  const tokens = au.tokens || 0;
  let txt = calls > 0
    ? `⚡ 本周 AI 调用 <b>${calls}</b> 次 · 消耗 <b>${tokens >= 1000 ? (tokens / 1000).toFixed(1) + "k" : tokens}</b> tokens`
    : "⚡ 本周暂无 AI 调用记录";
  const r = await window.api.weeklyBalance(settings);
  if (r && r.ok && r.balance) txt += ` · 💰 账户余额 <b>${r.balance}</b>`;
  box.innerHTML = txt;
}
// 会员周报 AI 小结：每周只生成一次并缓存（避免反复消耗 API）
async function renderAiSummary(res) {
  const box = $("weekly-ai");
  if (!box) return;
  const wr = settings.weeklyReport || {};
  if (wr.aiSummaryWeek === res.weekStart && wr.aiSummary) {
    box.innerHTML = `<div class="weekly-ai-title">✨ 本周小结</div><div class="weekly-ai-text">${escapeHtml(wr.aiSummary)}</div>`;
    return;
  }
  const r = await window.api.weeklyAiSummary(settings, res);
  if (r && r.ok && r.summary) {
    box.innerHTML = `<div class="weekly-ai-title">✨ 本周小结</div><div class="weekly-ai-text">${escapeHtml(r.summary)}</div>`;
    const next = { ...wr, aiSummary: r.summary, aiSummaryWeek: res.weekStart };
    const saved = await window.api.saveSettings({ weeklyReport: next });
    if (saved) settings = saved;
  } else {
    box.innerHTML = `<div class="weekly-ai-title">✨ 本周小结</div><div class="weekly-ai-text weekly-ai-err">${escapeHtml((r && r.error) || "AI 小结生成失败，可稍后重试")}</div>`;
  }
}
// 会员周报 可研究方向：AI 分析本周收藏集中度并推荐下周推进方向，每周只生成一次并缓存
async function renderAiDirection(res) {
  const box = $("weekly-direction");
  if (!box) return;
  const wr = settings.weeklyReport || {};
  if (wr.aiDirectionWeek === res.weekStart && wr.aiDirection) {
    box.innerHTML = `🧭 <b>可研究方向</b><span class="weekly-insight-line">${escapeHtml(wr.aiDirection)}</span><span class="weekly-insight-sub">AI 分析本周收藏集中度后给出的下周推进建议（每周生成一次）</span>`;
    return;
  }
  const r = await window.api.weeklyAiDirection(settings, res);
  if (r && r.ok && r.direction) {
    box.innerHTML = `🧭 <b>可研究方向</b><span class="weekly-insight-line">${escapeHtml(r.direction)}</span><span class="weekly-insight-sub">AI 分析本周收藏集中度后给出的下周推进建议（每周生成一次）</span>`;
    const next = { ...wr, aiDirection: r.direction, aiDirectionWeek: res.weekStart };
    const saved = await window.api.saveSettings({ weeklyReport: next });
    if (saved) settings = saved;
  } else {
    box.innerHTML = `🧭 <b>可研究方向</b><span class="weekly-insight-line weekly-ai-err">${escapeHtml((r && r.error) || "分析失败，可稍后重试")}</span>`;
  }
}
// 成就解锁检测：开源版已移除成就系统
async function checkNewBadges() {
  return;
}
    const res = await window.api.weeklyStats(settings);
    if (!res || !res.ok) return;
    const st = weeklyState(res, settings.weeklyReport || {});
    const unlockedMap = settings.unlockedBadges || {};
    const newly = WEEKLY_BADGES.filter((b) => b.check(st, st) && !unlockedMap[b.id]);
    if (!newly.length) return;
    const next = { ...unlockedMap };
    newly.forEach((b) => { next[b.id] = st.todayKey; });
    const saved = await window.api.saveSettings({ unlockedBadges: next });
    if (saved) settings = saved;
    showAchievementToast(newly);
    // 集齐全部成就：弹出专属庆祝提示（仅首次集齐时弹一次）
    if (WEEKLY_BADGES.every((b) => !!next[b.id]) && !unlockedMap.allShown) {
      const next2 = { ...next, allShown: "1" };
      await window.api.saveSettings({ unlockedBadges: next2 });
      if (settings) settings = { ...settings, unlockedBadges: next2 };
      showAllBadgesToast();
    }
    renderMotionPanel(); // 若刚好集齐全部成就，立即解锁设置页的动效彩蛋
    renderMaterials();  // 同步解锁界面材质彩蛋
  } catch (e) { /* 静默，不影响主流程 */ }
}
// 页面右上角成就解锁动画横幅
function showAchievementToast(newly) {
  let box = $("ach-toast");
  if (!box) {
    box = document.createElement("div");
    box.id = "ach-toast";
    box.className = "ach-toast";
    document.body.appendChild(box);
  }
  const cards = newly.map((b, i) => `<div class="badge-pop ach-pop" style="animation-delay:${i * 0.4}s">
    <span class="bd-emoji">${b.emoji}</span>
    <span><span class="bd-name">${b.name}</span><span class="bd-desc">${b.desc}</span></span>
  </div>`).join("");
  box.innerHTML = `<div class="ach-toast-head">✨ 新成就解锁<span class="ach-toast-x" id="ach-toast-x">✕</span></div>
    <div class="ach-toast-cards">${cards}</div>`;
  box.hidden = false;
  const close = () => { box.hidden = true; };
  $("ach-toast-x").addEventListener("click", close);
  setTimeout(close, 10000);
}
// 集齐全部成就的庆祝横幅：提示隐藏彩蛋已解锁
function showAllBadgesToast() {
  if (document.getElementById("all-badges-toast")) return;
  const box = document.createElement("div");
  box.id = "all-badges-toast";
  box.className = "all-badges-toast";
  box.innerHTML = `<div class="all-badges-inner">
    <div class="all-badges-glow"></div>
    <div class="all-badges-title">🎉 恭喜完成所有成就！</div>
    <div class="all-badges-sub">12 枚成就徽章全部集齐 · 隐藏彩蛋已解锁</div>
    <div class="all-badges-hint">设置页的「界面动效」「界面材质」面板已经出现——快去挑选你的专属彩蛋吧！</div>
    <button class="all-badges-btn" id="all-badges-ok">去探索 →</button>
  </div>`;
  document.body.appendChild(box);
  const close = () => { box.classList.add("out"); setTimeout(() => box.remove(), 500); };
  $("all-badges-ok").addEventListener("click", close);
  setTimeout(close, 15000);
}
// 设置页「每周知识周报」面板：基础周报所有用户可用；成就徽章为会员专属（非会员显示解锁提示）
async function renderWeeklyPanel() {
  const vip = isVipActive();
  const tag = $("weekly-vip-tag");
  if (tag) tag.textContent = vip ? "" : "完整版会员专属";
  const lockedBox = $("wr-badges-locked");
  const grid = $("wr-badges");
  const count = $("wr-badges-count");
  if (!vip) {
    if (grid) grid.innerHTML = "";
    if (count) count.textContent = "";
    if (lockedBox) lockedBox.hidden = false;
    return;
  }
  if (lockedBox) lockedBox.hidden = true;
  const res = await window.api.weeklyStats(settings);
  if (!res || !res.ok) return;
  const st = weeklyState(res, settings.weeklyReport || {});
  const unlockedMap = settings.unlockedBadges || {};
  grid.innerHTML = WEEKLY_BADGES.map((b) => {
    const unlocked = !!b.check(st, st) || !!unlockedMap[b.id];
    const cls = unlocked ? "bd-unlocked" : "bd-locked";
    const name = b.name;
    const desc = unlocked ? b.desc : (b.hidden ? "达成条件：？？？" : b.desc);
    return `<div class="weekly-badge ${cls}">
      <span class="bd-emoji">${unlocked ? b.emoji : "🔒"}</span>
      <span><span class="bd-name">${name}</span><span class="bd-desc">${desc}</span></span>
    </div>`;
  }).join("");
  count.textContent = `（${WEEKLY_BADGES.filter((b) => b.check(st, st) || unlockedMap[b.id]).length}/${WEEKLY_BADGES.length}）`;
}
// 自动弹出：启用 + 设置星期当天首次打开且今天未弹过时触发（基础版所有用户可看，关闭时记录推进连续周）
async function maybeShowWeeklyReport() {
  const wr = settings.weeklyReport || {};
  if (!wr.enabled) return;
  const now = new Date();
  const jsDay = now.getDay(); // 0=周日
  if (jsDay !== (Number(wr.weekday || 2) % 7)) return;
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (wr.lastShownDate === todayKey) return; // 今天已弹过
  const res = await window.api.weeklyStats(settings);
  if (!res || !res.ok) return;
  renderWeeklyReport(() => {
    window.api.weeklyAck({ dateKey: todayKey, hasNew: res.weekNewNotes > 0 }).then((next) => {
      if (next) settings.weeklyReport = next;
    });
  });
}
// 设置页「查看本周周报」按钮：所有用户可查看（非会员为基础版，会员为完整版），不推进 ack/连续周
$("btn-weekly-view").addEventListener("click", () => {
  renderWeeklyReport();
});

/* ================= 启动 ================= */
(async function boot() {
  settings = await window.api.getSettings();
  if (!settings.deviceId) {
    const bytes = [];
    for (let i = 0; i < 8; i++) bytes.push(Math.floor(Math.random() * 65536).toString(16).padStart(4, "0"));
    settings = await window.api.saveSettings({ deviceId: bytes.join("-") });
  }
  // 主进程验票：会员状态以 ticket 签名为准（老数据无 ticket 会在此自动补签）
  try { vipState = await window.api.vipVerify() || { active: false }; } catch { vipState = { active: false }; }
  fillSettingsForm();
  renderVipStatus();
  applyFontSize(settings.fontSize || 14);
  applySkin(settings.skin || "lake");
  applyMaterial(settings.cardMaterial || "acrylic");
  applyMotion(settings.uiMotion || "star");
  renderMotionPanel();
  setupClickFx();
  const saved = (() => { try { return localStorage.getItem("dok-page"); } catch { return null; } })();
  switchPage(PAGES.includes(saved) ? saved : "dashboard");
  // 每周知识周报：基础版所有用户可用（饼图+统计），会员解锁完整版（词云/本周洞察/本周小结/成就徽章）；设置面板渲染徽章进度；启动时检测新达成成就并在页面弹出解锁动画；满足条件（已启用+今天是对应星期+今天未弹过）时自动展示周报
  renderWeeklyPanel();
  checkNewBadges();
  maybeShowWeeklyReport();
  maybeShowFirstRunWelcome();
})();

// 首次打开欢迎引导：没看过就弹一次，提醒先去设置处理范围 + 填 API Key，点哪个按钮都标记已看过，不再打扰
async function maybeShowFirstRunWelcome() {
  if (settings.firstRunWelcomeShown) return;
  const overlay = $("first-run-overlay");
  if (!overlay) return;
  overlay.hidden = false;
  const done = async () => {
    overlay.hidden = true;
    settings = await window.api.saveSettings({ firstRunWelcomeShown: true });
  };
  $("first-run-go").onclick = async () => { await done(); switchPage("settings"); };
  $("first-run-skip").onclick = async () => { await done(); };
}
