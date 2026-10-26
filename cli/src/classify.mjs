import fs from "node:fs";
import path from "node:path";

/**
 * 动态分类树：16 个固定大类下，先按"主题父类（group）"分，再按"具体子类（subcategory）"分，自由生成并持久化。
 * 结构：{ [大类]: { [父类]: { [子类]: { created_at, updated_at, video_ids: string[], sample_texts: string[] } } } }
 */

export const MAJOR_CATEGORIES = [
  "AI与科技", "编程开发", "工具软件", "自媒体与运营", "职场与成长",
  "财经与投资", "生活技巧", "美食", "健身与健康", "穿搭与时尚",
  "教育学习", "影视娱乐", "游戏", "旅游出行", "情感心理", "其他",
];

const MAJOR_ALIASES = {
  "旅行与户外": "旅游出行", "户外与旅行": "旅游出行", "旅行与出行": "旅游出行", "户外与运动": "旅游出行", "运动与户外": "旅游出行", "旅行出游": "旅游出行", "旅游": "旅游出行",
  "美食与生活": "美食", "美食与饮品": "美食", "美食探店": "美食", "吃喝玩乐": "美食",
  "影视与娱乐": "影视娱乐", "影视剧": "影视娱乐", "电影": "影视娱乐",
  "健康与健身": "健身与健康", "健身运动": "健身与健康", "运动健身": "健身与健康", "养生": "健身与健康",
  "生活与科普": "生活技巧", "生活与手工": "生活技巧", "生活窍门": "生活技巧", "手工DIY": "生活技巧",
  "汽车与驾驶": "生活技巧", "汽车": "生活技巧",
  "情感心理": "情感心理", "职场成长": "职场与成长", "个人成长": "职场与成长",
  "学习": "教育学习", "校园": "教育学习",
  "投资": "财经与投资", "理财": "财经与投资", "金融": "财经与投资",
  "编程": "编程开发", "开发": "编程开发", "程序": "编程开发",
};

export function normalizeMajorCategory(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "其他";
  for (const major of MAJOR_CATEGORIES) {
    if (candidate === major) return major;
  }
  if (MAJOR_ALIASES[candidate]) return MAJOR_ALIASES[candidate];
  for (const major of MAJOR_CATEGORIES) {
    if (candidate.includes(major) || major.includes(candidate)) return major;
  }
  return "其他";
}

export function categoryTreeFile(config) {
  return path.join(config.stateDir, "categories.json");
}

export function loadCategoryTree(config) {
  const file = categoryTreeFile(config);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function saveCategoryTree(config, tree) {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(categoryTreeFile(config), `${JSON.stringify(tree, null, 2)}\n`, "utf8");
}

/** 把一条视频登记进分类树（大类/父类/子类），返回规范化后的 {major, group, sub}。
 *  forcedMajor：非空时大类直接用该值（不归一化、不校验是否在 16 大类），用于"收藏夹标题=最大父类"模式。 */
export function registerVideo(config, tree, { major: majorInput, group: groupInput = "", sub: subInput, awemeId, sampleText = "", forcedMajor = "" }) {
  const forced = String(forcedMajor || "").trim();
  let major = forced || normalizeMajorCategory(majorInput || "其他");
  // 用户自定义大类（不在 16 大映射内但已存在于分类树）保留原名，避免被吞进"其他"
  if (major === "其他" && majorInput && tree[String(majorInput).trim()]) major = String(majorInput).trim();
  const groupCandidate = String(groupInput || "").trim();
  const group = groupCandidate && groupCandidate !== "未分类" ? groupCandidate.slice(0, 40) : "";
  const subCandidate = String(subInput || "").trim();
  const sub = subCandidate && subCandidate !== "未分类" ? subCandidate.slice(0, 40) : "未分类";
  if (!tree[major]) tree[major] = {};
  const holder = group ? (tree[major][group] ||= {}) : tree[major];
  if (!holder[sub]) {
    holder[sub] = {
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      video_ids: [],
      sample_texts: [],
    };
  }
  const entry = holder[sub];
  entry.updated_at = new Date().toISOString();
  if (awemeId && !entry.video_ids.includes(String(awemeId))) entry.video_ids.push(String(awemeId));
  const cleanSample = String(sampleText || "").trim().slice(0, 120);
  if (cleanSample && entry.sample_texts.length < 5 && !entry.sample_texts.includes(cleanSample)) {
    entry.sample_texts.push(cleanSample);
  }
  return { major, group, sub };
}

/** 列出某大类下现有父类，供提取模型决定"归入 or 新建"（仅 group 层）。 */
export function listGroupCandidates(tree, major) {
  const subs = tree[normalizeMajorCategory(major)] || {};
  const lines = [];
  for (const [group, holder] of Object.entries(subs)) {
    if (!holder || typeof holder !== "object" || Array.isArray(holder)) {
      // 旧两级结构或叶子节点：作为父类处理
      lines.push(group);
      continue;
    }
    const childCount = Object.keys(holder).length;
    lines.push(`${group}（${childCount} 个子类）`);
  }
  return lines;
}

/** 列出某大类下现有子类及代表文本，供提取模型决定"归入 or 新建"。 */
export function listSubcategoryCandidates(tree, major) {
  const subs = tree[normalizeMajorCategory(major)] || {};
  const lines = [];
  for (const [group, holder] of Object.entries(subs)) {
    if (!holder || typeof holder !== "object" || Array.isArray(holder)) {
      const entry = holder;
      const samples = (entry?.sample_texts || []).slice(0, 3).map(text => `「${text.slice(0, 60)}」`).join(" ");
      lines.push(`${group}${samples ? `（示例：${samples}）` : ""}`);
      continue;
    }
    for (const [sub, entry] of Object.entries(holder)) {
      const samples = (entry?.sample_texts || []).slice(0, 3).map(text => `「${text.slice(0, 60)}」`).join(" ");
      lines.push(`${group}/${sub}${samples ? `（示例：${samples}）` : ""}`);
    }
  }
  return lines;
}

/** 列出全部分类树（大类/父类/子类，带示例），供提取模型沿用或新建。 */
export function listAllSubcategoryCandidates(tree, { maxPerMajor = 6, totalLimit = 80 } = {}) {
  const lines = [];
  for (const [major, groups] of Object.entries(tree || {})) {
    const groupEntries = Object.entries(groups || {});
    const picked = groupEntries.slice(-maxPerMajor);
    for (const [group, holder] of picked) {
      if (lines.length >= totalLimit) return lines;
      if (!holder || typeof holder !== "object" || Array.isArray(holder)) {
        const samples = (holder?.sample_texts || []).slice(0, 2).map(text => `「${text.slice(0, 48)}」`).join(" ");
        lines.push(`${major}/${group}${samples ? `（示例：${samples}）` : ""}`);
        continue;
      }
      const subs = Object.entries(holder);
      if (subs.length > 4) {
        const samples = subs.slice(0, 3).map(([sub, entry]) => (entry?.sample_texts || [])[0] ? `${sub}「${entry.sample_texts[0].slice(0, 40)}」` : sub).join("；");
        lines.push(`${major}/${group}/…（${subs.length} 个子类，如 ${samples}）`);
        continue;
      }
      for (const [sub, entry] of subs) {
        if (lines.length >= totalLimit) return lines;
        const samples = (entry?.sample_texts || []).slice(0, 2).map(text => `「${text.slice(0, 48)}」`).join(" ");
        lines.push(`${major}/${group}/${sub}${samples ? `（示例：${samples}）` : ""}`);
      }
    }
  }
  return lines;
}
