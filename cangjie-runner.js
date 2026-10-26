/* cangjie-runner.js — 仓颉 RIA-TV++ 七阶段蒸馏流水线执行器
 * 严格按 kangarooking/cangjie-skill 官方 methodology/extractors 执行：
 * 阶段0 Adler 整书理解 → 阶段1 五提取器并行(串行降级) → 阶段1.5 三重验证 →
 * 阶段1.6 晋级门 → 阶段2 RIA++ 能力卡 → 阶段3 Zettelkasten 链接 →
 * 阶段4 压力测试 → 阶段5 DIGEST + scripts/cangjie.py compile 确定性编译。
 * 每个阶段由 DeepSeek（用户 Key）按官方 prompt 文件执行，产物结构与官方一致。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// 蒸馏消耗统计：与桌面端共用 settings.json 的 apiUsage（按自然周累计）
function weekKeyOf(date) {
  const d = new Date(date);
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
function recordUsage(settings, data) {
  try {
    const tokens = Number(data && data.usage && data.usage.total_tokens) || 0;
    if (!tokens) return;
    const file = path.join(os.homedir(), ".douyin-knowledge-app", "settings.json");
    const cur = JSON.parse(fs.readFileSync(file, "utf8"));
    const key = weekKeyOf(new Date());
    const au = cur.apiUsage || {};
    if (au.weekKey !== key) { au.weekKey = key; au.tokens = 0; au.calls = 0; }
    au.tokens += tokens;
    au.calls += 1;
    cur.apiUsage = au;
    fs.writeFileSync(file, JSON.stringify(cur, null, 2), "utf8");
  } catch { /* 统计失败不影响蒸馏主流程 */ }
}

function read(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}
function write(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s, "utf8");
}
function slugify(s) {
  return String(s || "skill").replace(/[\\/:*?"<>|\s#]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/* ---- OpenAI 兼容 LLM 调用（默认 DeepSeek，设置页可改 Base/Key/模型名） ---- */
async function llm(settings, system, user, maxTokens = 6000) {
  const base = (settings.llmBaseUrl || process.env.DOK_LLM_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = settings.llmApiKey || process.env.DOK_LLM_API_KEY || "";
  if (!base || !apiKey) throw new Error("未配置 AI API Key（可在设置页填写，或使用环境变量 DOK_LLM_API_KEY）");
  const model = settings.llmModel || "deepseek-chat";
  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.4,
      max_tokens: maxTokens,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(friendlyAIError(resp.status, body));
  }
  const data = await resp.json();
  recordUsage(settings, data);
  const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  if (!text) throw new Error("AI 返回为空");
  return text;
}

/* 从 LLM 回复里提取 JSON（优先 ```json 代码块，其次第一个 { }） */
function extractJson(text) {
  let t = String(text);
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  if (start === -1) throw new Error("LLM 输出缺少 JSON");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)); }
  }
  throw new Error("LLM 输出 JSON 不完整");
}

function extractArray(text) {
  let t = String(text);
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("[");
  if (start === -1) throw new Error("LLM 输出缺少 JSON 数组");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)); }
  }
  throw new Error("LLM 输出 JSON 数组不完整");
}

/* 大文档输出：直接取 markdown 正文（去掉开场白/代码块标记） */
function extractMarkdown(text) {
  let t = String(text).trim();
  t = t.replace(/^(好的|好的，|好的！|没问题|以下(是|为)|根据(要求|以上|大纲)|OK|Sure|当然可以|已生成|这是|下面是|为你生成|我将)?[^\n]{0,40}[:：]?\s*/m, "");
  const fence = t.match(/```(?:markdown|md)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  if (/^#|^---/.test(t)) return t;
  return t;
}

function friendlyAIError(status, bodyText) {
  const t = String(bodyText || "").toLowerCase();
  if (status === 402 || status === 429 || /insufficient\s*_?\s*balance|insufficient\s*_?\s*quota|余额不足|no balance|payment required/.test(t)) {
    return "API Key 余额不足，请充值后重试";
  }
  return `AI 接口 ${status}: ${String(bodyText || "").slice(0, 300)}`;
}

/* LLM 调用 + JSON 解析（失败自动重试一次） */
async function llmJson(settings, system, user, maxTokens, parser) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const out = await llm(settings, system, user, maxTokens);
      return parser(out);
    } catch (e) {
      lastErr = e;
      if (i === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

/* ---- 阶段状态（断点续跑） ---- */
function markState(root, stage) {
  const f = path.join(root, "PIPELINE_STATE.md");
  const cur = read(f) || "# 流水线状态\n\n";
  write(f, cur + `done: ${stage}\n`);
}
function doneSet(root) {
  const cur = read(path.join(root, "PIPELINE_STATE.md")) || "";
  const set = new Set();
  const re = /^done:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(cur)) !== null) set.add(m[1].trim());
  return set;
}

/* ---- 主入口 ---- */
async function runCangjieDistill(settings, sel, send) {
  const cangjie = settings.cangjiePath;
  const mdir = path.join(cangjie, "methodology");
  const edir = path.join(cangjie, "extractors");
  const tdir = path.join(cangjie, "templates");
  if (!fs.existsSync(path.join(cangjie, "SKILL.md"))) {
    throw new Error(`仓颉路径无效：${cangjie}（请在设置页确认）`);
  }

  // 合并输入
  const vault = path.join(settings.vaultPath, "Knowledge", sel.major, sel.group, sel.sub);
  if (!fs.existsSync(vault)) throw new Error("子类目录不存在或为空");
  const parts = [];
  for (const f of fs.readdirSync(vault, { withFileTypes: true })) {
    if (f.isFile() && f.name.toLowerCase().endsWith(".md")) {
      parts.push({ name: f.name, content: fs.readFileSync(path.join(vault, f.name), "utf8") });
    }
  }
  const fullText = parts.map((p) => `# ${p.name}\n\n${p.content}`).join("\n\n---\n\n");
  if (!fullText.trim()) throw new Error("子类目录为空");

  const root = path.join(settings.distillOutputDir, `douyin-distill-${slugify(sel.sub)}`);
  fs.mkdirSync(root, { recursive: true });
  const capDir = path.join(root, ".cangjie", "capabilities");
  const done = doneSet(root);
  const meta = {
    title: sel.sub,
    author: "抖音收藏合集",
    source_pack: `Douyin Knowledge 子类：${sel.major} / ${sel.group} / ${sel.sub}`,
    purpose: "learning",
  };
  const brief = `内容标题：${sel.sub}\n来源：抖音收藏知识库子类（${sel.major} / ${sel.group} / ${sel.sub}）\n共 ${parts.length} 篇视频笔记。`;

  // ===== 阶段 0 — Adler 整书理解 =====
  if (!done.has("stage0")) {
    send(`[阶段 0/6] Adler 整书理解…\n`);
    const p0 = read(path.join(mdir, "01-stage0-adler.md"));
    const tpl = read(path.join(tdir, "BOOK_OVERVIEW.md.template"));
    const out = await llm(settings,
      `${p0}\n\n产出模板（严格按其结构填充）：\n${tpl}\n\n直接输出 BOOK_OVERVIEW.md 的完整 markdown 正文（以 # 开头），不要 JSON 包裹、不要代码块标记、不要任何说明文字。`,
      `${brief}\n\n=== 内容全文 ===\n\n${fullText.slice(0, 50000)}`, 10000);
    write(path.join(root, "BOOK_OVERVIEW.md"), extractMarkdown(out));
    markState(root, "stage0");
    send(`  ✓ BOOK_OVERVIEW.md 已生成\n`);
  }

  // ===== 阶段 1 — 五提取器（串行降级，官方允许） =====
  if (!done.has("stage1")) {
    const overview = read(path.join(root, "BOOK_OVERVIEW.md")) || "";
    const extractors = [
      ["framework-extractor.md", "frameworks.md"],
      ["principle-extractor.md", "principles.md"],
      ["case-extractor.md", "cases.md"],
      ["counter-example-extractor.md", "counter-examples.md"],
      ["glossary-extractor.md", "glossary.md"],
    ];
    for (const [pfx, outName] of extractors) {
      send(`[阶段 1/6] 提取器：${outName.replace(".md", "")}…\n`);
      const px = read(path.join(edir, pfx));
      const out = await llm(settings,
        `${px}\n\n只输出该提取器的候选条目内容（YAML 候选列表本身，不要任何说明文字、不要代码块标记），直接输出 YAML。`,
        `${brief}\n\n=== BOOK_OVERVIEW ===\n${overview.slice(0, 12000)}\n\n=== 内容全文 ===\n\n${fullText.slice(0, 50000)}`, 8000);
      write(path.join(root, "candidates", outName), out.replace(/```ya?ml\s*/gi, "").replace(/```/g, "").trim() + "\n");
    }
    markState(root, "stage1");
    send("  ✓ 5 个候选池已生成（candidates/）\n");
  }

  // ===== 阶段 1.5 — 三重验证 =====
  if (!done.has("stage1.5")) {
    send(`[阶段 1.5/6] 三重验证筛选…\n`);
    const p15 = read(path.join(mdir, "03-stage1.5-triple-verify.md"));
    let allCandidates = "";
    for (const outName of ["frameworks.md", "principles.md", "cases.md", "counter-examples.md", "glossary.md"]) {
      const c = read(path.join(root, "candidates", outName));
      if (c) allCandidates += `--- ${outName} ---\n${c}\n`;
    }
    const out = await llmJson(settings,
      `${p15}\n\n对全部候选执行三重验证。最后只输出 JSON：{"verified":[{"id":"f01","title":"...","type":"framework","source_location":"...","rationale":"V1/V2/V3 依据与演练摘要"}],"references":[{"id":"...","title":"...","why":"..."}],"needs_review":[{"id":"...","title":"...","gaps":"..."}],"rejected":[{"id":"...","title":"...","why":"..."}]}`,
      `${brief}\n\n=== BOOK_OVERVIEW（含原书关键任务清单）===\n${(read(path.join(root, "BOOK_OVERVIEW.md")) || "").slice(0, 12000)}\n\n=== 全部候选 ===\n${allCandidates.slice(0, 30000)}`, 8000, extractJson);
    const vm = ["# 验证结果（三重验证）\n"];
    vm.push(`verified: ${j.verified.length} | reference: ${j.references.length} | needs_review: ${j.needs_review.length} | rejected: ${j.rejected.length}\n`);
    for (const v of j.verified) vm.push(`## ${v.id} — ${v.title}\n- 类型：${v.type}\n- 出处：${v.source_location}\n- 依据：${v.rationale}\n`);
    write(path.join(root, "verified.md"), vm.join("\n"));
    write(path.join(root, "verified.json"), JSON.stringify(j, null, 2));
    // 简化 coverage-audit.md
    const audit = [`# 覆盖审计\n\n原书关键任务 → 候选 → 去向。\n`];
    audit.push(`\n## 通过（${j.verified.length}）\n`);
    for (const v of j.verified) audit.push(`- ${v.id} ${v.title} → 能力卡\n`);
    audit.push(`\n## 参考（${j.references.length}）\n`);
    for (const r of j.references) audit.push(`- ${r.id} ${r.title}：${r.why}\n`);
    audit.push(`\n## 待核查（${j.needs_review.length}）\n`);
    for (const r of j.needs_review) audit.push(`- ${r.id} ${r.title}：${r.gaps}\n`);
    audit.push(`\n## 淘汰（${j.rejected.length}）\n`);
    for (const r of j.rejected) audit.push(`- ${r.id} ${r.title}：${r.why}\n`);
    write(path.join(root, "coverage-audit.md"), audit.join("\n"));
    markState(root, "stage1.5");
    send(`  ✓ 验证通过 ${j.verified.length} 个能力（参考 ${j.references.length} / 待核查 ${j.needs_review.length} / 淘汰 ${j.rejected.length}）\n`);
  }

  // ===== 阶段 1.6 + 2a — 晋级门 + Bundle 元数据（与 2b 合并原子标记，保证 meta 与卡片一致） =====
  if (!done.has("stage2")) {
    send(`[阶段 1.6+2/6] 晋级门评审 + 能力元数据构造…\n`);
    const p16 = read(path.join(mdir, "03b-stage1.6-promotion-gate.md"));
    const p2 = read(path.join(mdir, "04-stage2-ria-plus.md"));
    const verifiedJson = JSON.parse(read(path.join(root, "verified.json")));
    const vlist = JSON.stringify(verifiedJson.verified || []);
    const out = await llmJson(settings,
      `${p16}\n\n${p2}\n\n对每个 verified 能力执行晋级门评审并构造能力元数据。最后只输出 JSON：\n{"entry":{"name":"kebab-case 主入口名","description":"何时调用+何时不调用（≥40字）","core_principles":["3-7条核心原则"],"out_of_scope":["至少1条"],"stop_conditions":["至少1条"]},"router_entry":{"name":"kebab-case","description":"来源路由入口描述（≥40字）"},"promotion_budget":8,"capabilities":[{"capability_id":"cap.<book-slug>.<cap-slug>","revision":1,"slug":"kebab-case","title":"中文标题","importance":"critical|high|medium|low","importance_rationale":"依据（任务映射/遗漏后果，≥8字）","one_liner":"一句话决策规则","intents":["用户意图"],"keywords":["中英关键词"],"frontmatter":{"description":"何时用+何时不用+trigger（≤300字）","tags":["tag"]},"source_evidence":[{"source_id":"src-douyin-collection","location":"笔记名"}],"promotion":{"destination":"promoted|router","gate":{"independent_intent":true,"independent_contract":true,"independent_run":true,"independent_reuse":true,"independent_eval":true},"notes":"评审说明"}}]}`,
      `${brief}\n\n=== BOOK_OVERVIEW ===\n${(read(path.join(root, "BOOK_OVERVIEW.md")) || "").slice(0, 12000)}\n\n=== 验证通过的单元 ===\n${vlist}`, 10000, extractJson);
    write(path.join(root, "bundle-meta.json"), JSON.stringify(j, null, 2));
    send(`  ✓ Bundle 元数据就绪（${j.capabilities.length} 个能力，入口 ${j.entry.name}）\n`);
  }

  // ===== 阶段 2b — RIA++ 能力卡 =====
  if (!done.has("stage2")) {
    const p2 = read(path.join(mdir, "04-stage2-ria-plus.md"));
    const bundleMeta = JSON.parse(read(path.join(root, "bundle-meta.json")));
    const overview = read(path.join(root, "BOOK_OVERVIEW.md")) || "";
    const cardsDir = path.join(capDir, "cards");
    let idx = 0;
    for (const cap of bundleMeta.capabilities) {
      const cardFile = path.join(cardsDir, `${cap.slug}.md`);
      if (read(cardFile)) { idx++; continue; }
      send(`  [能力卡 ${idx + 1}/${bundleMeta.capabilities.length}] ${cap.title}…\n`);
      const out = await llm(settings,
        `${p2}\n\n为该能力构造 RIA++ 六段能力卡。只输出卡片正文 markdown（R/I/A1/A2/E/B 六段，严格按 methodology 要求，不要 frontmatter），用代码块包裹。`,
        `${brief}\n\n=== BOOK_OVERVIEW（批判/应用参考）===\n${overview.slice(0, 12000)}\n\n=== 内容全文 ===\n${fullText.slice(0, 30000)}\n\n=== 该能力元数据 ===\n${JSON.stringify(cap, null, 2)}`, 8000);
      const body = out.match(/```(?:markdown|md)?\s*([\s\S]*?)```/);
      write(cardFile, (body ? body[1] : out).trim() + "\n");
      idx++;
    }
    markState(root, "stage2");
    send(`  ✓ 能力卡已生成（${bundleMeta.capabilities.length} 张）\n`);
  }

  // ===== 阶段 3 — Zettelkasten 链接 + GLOSSARY =====
  if (!done.has("stage3")) {
    send(`[阶段 3/6] Zettelkasten 能力链接…\n`);
    const p3 = read(path.join(mdir, "05-stage3-zettelkasten.md"));
    const bundleMeta = JSON.parse(read(path.join(root, "bundle-meta.json")));
    const capSummary = bundleMeta.capabilities.map((c) => `${c.capability_id}|${c.title}|${c.one_liner}`).join("\n");
    const glossaryCandidates = read(path.join(root, "candidates", "glossary.md")) || "";
    const out = await llmJson(settings,
      `${p3}\n\n基于能力清单建立引用关系并整理术语表。最后只输出 JSON：{"also_read":{"cap.<book>.<slug>":["cap.<book>.<other-slug>"]},"glossary_md":"术语表 markdown 正文（GLOSSARY.md 完整内容）"}`,
      `${brief}\n\n=== 能力清单（capability_id|标题|一句话）===\n${capSummary}\n\n=== 术语候选 ===\n${glossaryCandidates.slice(0, 10000)}`, 10000, extractJson);
    write(path.join(root, "GLOSSARY.md"), extractMarkdown(j.glossary_md || ""));
    write(path.join(root, "also-read.json"), JSON.stringify(j.also_read, null, 2));
    markState(root, "stage3");
    send("  ✓ GLOSSARY.md 与 also_read 关系已生成\n");
  }

  // ===== 阶段 4 — 压力测试 =====
  if (!done.has("stage4")) {
    send(`[阶段 4/6] 压力测试用例生成…\n`);
    const p4 = read(path.join(mdir, "06-stage4-pressure-test.md"));
    const bundleMeta = JSON.parse(read(path.join(root, "bundle-meta.json")));
    const capSummary = bundleMeta.capabilities.map((c) => `${c.title}（${c.slug}）`).join("、");
    const out = await llmJson(settings,
      `${p4}\n\n为每个能力设计触发评测用例（darwin 兼容 test-prompts.json 格式）。最后只输出 JSON 数组（test-prompts.json 的数组内容本身）：[{"prompt":"代表用户提问","expected":"期望输出要点","capability":"cap_id"}]`,
      `${brief}\n\n能力列表：${capSummary}\n\n=== 能力卡摘要 ===\n${(read(path.join(capDir, "cards", bundleMeta.capabilities[0] && bundleMeta.capabilities[0].slug + ".md")) || "").slice(0, 6000)}`, 8000, extractArray);
    write(path.join(root, "test-prompts.json"), JSON.stringify(arr, null, 2));
    markState(root, "stage4");
    send(`  ✓ test-prompts.json 已生成（${arr.length} 个用例）\n`);
  }

  // ===== 阶段 5 — DIGEST + Bundle 组装 + 编译 =====
  if (!done.has("stage5")) {
    send(`[阶段 5/6] 生成 DIGEST + 编译技能包…\n`);
    const p5 = read(path.join(mdir, "07-stage5-deliver.md"));
    const tplDigest = read(path.join(tdir, "DIGEST.md.template"));
    const overview = read(path.join(root, "BOOK_OVERVIEW.md")) || "";
    const verifiedJson = JSON.parse(read(path.join(root, "verified.json")));
    const out = await llm(settings,
      `${p5}\n\n模板（按结构填充）：\n${tplDigest || ""}\n\n直接输出 DIGEST.md 的完整 markdown 正文（以 # 开头），不要 JSON 包裹、不要代码块标记、不要任何说明文字。`,
      `${brief}\n\n=== BOOK_OVERVIEW ===\n${overview.slice(0, 12000)}\n\n=== 验证单元 ===\n${JSON.stringify(verifiedJson.verified || []).slice(0, 15000)}`, 10000);
    write(path.join(root, "DIGEST.md"), extractMarkdown(out));

    // 组装 .cangjie/capabilities
    const bundleMeta = JSON.parse(read(path.join(root, "bundle-meta.json")));
    const alsoRead = JSON.parse(read(path.join(root, "also-read.json")) || "{}");
    for (const cap of bundleMeta.capabilities) {
      cap.also_read = alsoRead[cap.capability_id] || [];
      cap.status = "active";
      cap.card = `cards/${cap.slug}.md`;
      cap.resources = cap.resources || [];
      if (cap.promotion && cap.promotion.destination === "promoted" && !cap.frontmatter) cap.frontmatter = { description: cap.one_liner, tags: [] };
    }
    const bundle = {
      schema_version: 1,
      bundle_id: `bundle.${slugify(sel.sub)}`,
      book: { title: meta.title, author: meta.author, source_pack: meta.source_pack },
      entry: bundleMeta.entry,
      router_entry: bundleMeta.router_entry,
      promotion_budget: bundleMeta.promotion_budget || 8,
      capabilities: bundleMeta.capabilities,
    };
    write(path.join(root, "bundle-meta.json"), JSON.stringify(bundleMeta, null, 2));
    write(path.join(capDir, "book", "overview.md"), overview);
    write(path.join(capDir, "book", "glossary.md"), read(path.join(root, "GLOSSARY.md")) || "");
    const destMap = {};
    for (const cap of bundleMeta.capabilities) destMap[cap.capability_id] = cap.promotion && cap.promotion.destination === "promoted" ? { promoted_to: `skills/${cap.slug}` } : { served_by: bundleMeta.router_entry.name };
    write(path.join(capDir, "destinations.json"), JSON.stringify(destMap, null, 2));

    // 用 venv Python + PyYAML 写 verified.yaml（保证 schema 合规）
    const tmpJson = path.join(root, ".cangjie", "_bundle.json");
    write(tmpJson, JSON.stringify(bundle, null, 2));
    const py = settings.pythonPath;
    const pyScript = "import json,sys;d=json.load(open(r'" + tmpJson.replace(/\\/g, "\\\\") + "',encoding='utf-8'));open(r'" + path.join(capDir, "verified.yaml").replace(/\\/g, "\\\\") + "','w',encoding='utf-8').write(__import__('yaml').safe_dump(d,allow_unicode=True,sort_keys=False))";
    await new Promise((resolve, reject) => {
      const child = spawn(py, ["-c", pyScript], { windowsHide: true });
      let err = "";
      child.stderr.on("data", (c) => (err += String(c)));
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("verified.yaml 生成失败：" + err))));
    });
    fs.unlinkSync(tmpJson);

    // 编译
    const outDir = path.join(root, "dist");
    send("  ▶ cangjie.py compile（single 模式）…\n");
    const comp = await new Promise((resolve) => {
      const child = spawn(py, ["scripts\\cangjie.py", "compile", "--bundle", capDir, "--out", outDir, "--output", "single", "--purpose", "learning", "--yes"], {
        cwd: cangjie,
        windowsHide: true,
      });
      let log = "";
      child.stdout.on("data", (c) => (log += String(c)));
      child.stderr.on("data", (c) => (log += String(c)));
      child.on("close", (code) => resolve({ code, log }));
    });
    if (comp.code !== 0) {
      throw new Error(`cangjie.py compile 失败：\n${comp.log.slice(0, 1200)}`);
    }
    send("  ✓ 编译完成\n");
    markState(root, "stage5");
    send(comp.log.slice(0, 1500) + "\n");
  }

  // 定位最终 SKILL.md（single 入口）
  const distRoot = path.join(root, "dist");
  let skillFile = null;
  if (fs.existsSync(distRoot)) {
    const walk = (dir, depth) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skillFile) return;
        const full = path.join(dir, f.name);
        if (f.isDirectory() && depth < 2) walk(full, depth + 1);
        else if (f.isFile() && f.name.toLowerCase() === "skill.md") skillFile = full;
      }
    };
    walk(distRoot, 0);
  }
  if (!skillFile) skillFile = path.join(distRoot, "SKILL.md");
  const content = read(skillFile) || "";
  return {
    ok: true,
    path: skillFile,
    root,
    content,
    meta: { files: parts.length, chars: fullText.length, stages: ["stage0", "stage1", "stage1.5", "stage2", "stage3", "stage4", "stage5"] },
  };
}

module.exports = { runCangjieDistill };
