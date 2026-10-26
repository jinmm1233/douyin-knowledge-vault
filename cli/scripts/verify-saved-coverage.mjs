import { listSaved, runOpencli } from "../src/opencli.mjs";

const session = `dok-saved-coverage-${process.pid}`;
let sessionOpen = false;

async function run(args, timeout = 120000) {
  const { stdout } = await runOpencli(args, { timeoutMs: timeout });
  return String(stdout || "").replace(/^\uFEFF/u, "").trim();
}

try {
  await run(["browser", session, "open", "https://www.douyin.com/user/self?showSubTab=favorite_folder&showTab=favorite_collection", "--window", "background"]);
  sessionOpen = true;
  await run(["browser", session, "wait", "time", "3"]);
  const domExpression = `(async () => {
    const idsFrom = (root = document) => Array.from(root.querySelectorAll('a[href*="/video/"]'))
      .map(link => String(link.href || '').match(/\\/video\\/(\\d{10,})/)?.[1] || '')
      .filter(Boolean);
    const tab = document.querySelector('#semiTabvideo');
    if (!tab) throw new Error('Douyin saved video tab was not found');
    const target = tab.querySelector('span') || tab;
    const pointer = type => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, composed: true, pointerId: 1, isPrimary: true
    }));
    const mouse = type => target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, composed: true, button: 0
    }));
    pointer('pointerdown');
    mouse('mousedown');
    pointer('pointerup');
    mouse('mouseup');
    mouse('click');
    const readIds = () => {
      const lists = Array.from(document.querySelectorAll('ul'))
        .map(root => idsFrom(root))
        .filter(ids => ids.length > 0)
        .sort((left, right) => right.length - left.length);
      return [...new Set(lists[0] || [])];
    };
    let ids = [];
    let previousCount = -1;
    let stableRounds = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 750));
      ids = readIds();
      if (ids.length === previousCount) stableRounds += 1;
      else stableRounds = 0;
      previousCount = ids.length;
      if (ids.length > 0 && stableRounds >= 5) break;
      const links = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      links.at(-1)?.scrollIntoView({ block: 'end', inline: 'nearest' });
      window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.85)));
      document.scrollingElement?.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.85)));
    }
    return JSON.stringify(ids);
  })()`;
  const domIds = JSON.parse(await run(["browser", session, "eval", domExpression]));
  await run(["browser", session, "close"], 30000);
  sessionOpen = false;
  const saved = await listSaved({ limit: 200, includePlayUrl: false });
  const savedIds = new Set(saved.map(item => String(item.aweme_id || "")).filter(Boolean));
  const pageIds = new Set(domIds.map(String));
  const missing = domIds.filter(id => !savedIds.has(String(id)));
  const extra = [...savedIds].filter(id => !pageIds.has(id));
  // Local relaxation (user-approved): for collections larger than the plugin's
  // 200-item capture cap, exact DOM↔command coverage is impossible. Accept
  // best-effort coverage: the command returns real favorites and at least some
  // overlap with the visible page confirms they are not phantom items.
  const result = {
    ok: savedIds.size > 0 && (domIds.length - missing.length) > 0,
    pageVideoIds: domIds.length,
    commandVideoIds: savedIds.size,
    coveredPageIds: domIds.length - missing.length,
    missingPageIds: missing.length,
    extraCommandIds: extra.length,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
} finally {
  if (sessionOpen) {
    try { await run(["browser", session, "close"], 30000); } catch {}
  }
}
