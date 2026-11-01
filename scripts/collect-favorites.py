#!/usr/bin/env python3
"""API 直连收藏采集器（移植自 douyin-favorites-to-knowledge 的采集思路）。

不模拟点击 UI，而是用 Playwright 持久化浏览器 profile（独立于日常 Chrome）
保存抖音登录态，然后在页面上下文里直接调用抖音网页版私有 API
(/aweme/v1/web/aweme/listcollection/) 游标翻页，可一次拉取远超 200 条的收藏。

命令：
  login   -- 打开浏览器让用户扫码登录（登录态保存在独立 profile）
  status  -- 检查登录态
  collect -- 拉取收藏列表，输出 JSON 到 --output（默认 var/api-collection.json）
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# 环境注入了其他 Python 包路径（豆包运行时、用户级 site-packages），
# 必须把仓库 .venv 的 site-packages 提到最前，确保导入 .venv 自己的 playwright。
_REPO_ROOT = Path(__file__).resolve().parent.parent
_VENV_SP = _REPO_ROOT / ".venv" / "Lib" / "site-packages"
if not _VENV_SP.exists():
    _candidates = sorted((_REPO_ROOT / ".venv" / "lib").glob("python*/site-packages")) if (_REPO_ROOT / ".venv" / "lib").exists() else []
    if _candidates:
        _VENV_SP = _candidates[0]
if _VENV_SP.exists():
    sys.path.insert(0, str(_VENV_SP))

try:
    from playwright.async_api import async_playwright
except ImportError:
    print(json.dumps({"error": "playwright is not installed in the project venv"}, ensure_ascii=False))
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent
# 登录态存在用户目录下，不要放安装目录（升级重装会丢）
import os
_profile_env = os.environ.get("DOK_PROFILE_DIR", "").strip()
if _profile_env:
    DEFAULT_PROFILE_DIR = Path(_profile_env).expanduser().resolve()
else:
    DEFAULT_PROFILE_DIR = Path.home() / ".douyin-knowledge" / "browser-profile"
DEFAULT_OUTPUT = REPO_ROOT / "var" / "api-collection.json"


def log(message: str) -> None:
    """诊断日志统一走 stderr：stdout 要留给 JSON 结果，否则会污染上层解析。"""
    print(str(message), file=sys.stderr, flush=True)


def _read_config_browser_mode() -> str:
    """读 config.json 里的 browserMode，保证定时任务（不注入环境变量）也能拿到同一个口径。"""
    try:
        raw = (REPO_ROOT / "config.json").read_text(encoding="utf-8-sig")
        return str(json.loads(raw).get("browserMode") or "").strip()
    except Exception:
        return ""


def resolve_browser_mode(cli_mode: str | None = None) -> str:
    """auto=内置优先、失败自动回退本机；builtin=只用内置；system=只用本机。"""
    for candidate in (cli_mode, os.environ.get("DOK_BROWSER_MODE"), _read_config_browser_mode()):
        text = str(candidate or "").strip().lower()
        if text in ("auto", "builtin", "system"):
            return text
    return "auto"


def _first_existing(paths) -> str:
    for item in paths:
        if item and os.path.exists(item):
            return item
    return ""


def system_browsers() -> list[dict]:
    """显式枚举本机 Chrome / Edge 的 exe 路径，不依赖 Playwright 的 channel 探测。"""
    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    program_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local_app_data = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    chrome = _first_existing([
        os.path.join(program_files, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(program_files_x86, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(local_app_data, "Google", "Chrome", "Application", "chrome.exe"),
    ])
    edge = _first_existing([
        os.path.join(program_files_x86, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(program_files, "Microsoft", "Edge", "Application", "msedge.exe"),
    ])
    found: list[dict] = []
    if chrome:
        found.append({"id": "chrome", "label": "本机 Chrome", "path": chrome})
    if edge:
        found.append({"id": "edge", "label": "本机 Edge", "path": edge})
    return found


def profile_dir_for(base: Path, browser_id: str) -> Path:
    """每个浏览器用独立 profile：混用会导致登录态互相污染、甚至启动即崩。"""
    if browser_id == "builtin":
        return base
    return base.with_name(f"{base.name}-{browser_id}")


def launch_attempts(mode: str, profile_dir: Path, headless: bool, preferred: str = "") -> list[dict]:
    """按模式生成有序的启动尝试列表，逐个试直到有一个成功。
    preferred=上次登录成功的浏览器 id，优先尝试它：登录态按浏览器分开保存，
    否则 auto 模式总是先用内置浏览器（空 profile）→ 明明本机 Chrome 已登录却报未登录。"""
    proxy_direct = os.environ.get("DOK_BROWSER_PROXY", "").strip().lower() == "direct"
    base_args = ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-gpu"]
    if proxy_direct:
        # 绕过系统代理，专治 ERR_PROXY_CONNECTION_FAILED（用户开着 VPN/加速器）
        base_args.append("--no-proxy-server")
    builtin_chrome = os.environ.get("DOK_CHROME_PATH", "").strip()
    builtin = {"id": "builtin", "label": "内置 Chromium"}
    if builtin_chrome and os.path.exists(builtin_chrome):
        builtin["executable_path"] = builtin_chrome

    def make(item: dict) -> dict:
        kwargs = {
            "user_data_dir": str(profile_dir_for(profile_dir, item["id"])),
            "headless": headless,
            "viewport": {"width": 1280, "height": 800},
            "locale": "zh-CN",
            "args": list(base_args),
        }
        # 必须显式传 executable_path：否则 Playwright 会去找它自带的浏览器
        # （headless 时还会去找 chrome-headless-shell），本地没装就报
        # "Executable doesn't exist"，这正是旧版「no supported browser」的根因
        exe = item.get("executable_path") or item.get("path")
        if exe:
            kwargs["executable_path"] = exe
        return {"id": item["id"], "label": item["label"], "kwargs": kwargs}

    attempts: list[dict] = []
    if mode in ("builtin", "auto"):
        attempts.append(make(builtin))
    if mode in ("system", "auto"):
        for item in system_browsers():
            attempts.append(make(item))
    # 用户选了「只用本机」但机器上确实没有 Chrome/Edge：留一条内置活路，总比直接失败友好
    if not attempts:
        attempts.append(make(builtin))
    # 把"上次登录成功用的浏览器"提到最前：登录态不通用，先试它有登录态的那个
    want = str(preferred or os.environ.get("DOK_PREFERRED_BROWSER", "")).strip().lower()
    if want:
        attempts.sort(key=lambda item: 0 if item["id"] == want else 1)
    return attempts


def explain_launch_error(message: str) -> str:
    """把 Playwright 的英文底层报错翻译成用户能照做的动作。"""
    text = str(message or "")
    lower = text.lower()
    if "processsingleton" in lower or "already in use" in lower or "singletonlock" in lower:
        return "浏览器配置目录被占用（可能有上次残留的浏览器窗口没关），请关掉残留窗口后重试，或在设置页点「重置登录浏览器缓存」"
    if "executable doesn't exist" in lower or "executable does not exist" in lower:
        return "找不到浏览器程序：内置浏览器没随包装上（或被 360/火绒等杀毒软件隔离），本机浏览器路径也可能失效。请把安装目录加入白名单，或在设置页切换浏览器"
    if "access is denied" in lower or "eacces" in lower or "permission denied" in lower:
        return "浏览器文件被拒绝访问（杀毒软件拦截），请把安装目录加入白名单，或在设置页切换本机浏览器"
    if "target page, context or browser has been closed" in lower or "failed to launch" in lower:
        return "浏览器一启动就退出（多为登录配置目录损坏，或被安全软件 / 显卡驱动拦截）"
    return text.replace("\n", " ")[:200] or "未知错误"

COLLECTION_PAGE_URL = "https://www.douyin.com/user/self?showTab=favorite_collection"
COLLECTION_API_URL = "https://www.douyin.com/aweme/v1/web/aweme/listcollection/"
COLLECTS_LIST_API_URL = "https://www.douyin.com/aweme/v1/web/collects/list/"
COLLECTS_VIDEO_API_URL = "https://www.douyin.com/aweme/v1/web/collects/video/list/"
SESSION_COOKIE_NAMES = {"sessionid", "sessionid_ss", "sid_guard"}
AWEME_ID = re.compile(r"^[0-9]{6,30}$")

FETCH_JS = r"""async ({apiUrl, cursor, count, extraParams}) => {
    const params = new URLSearchParams({
        device_platform: 'webapp',
        aid: '6383',
        channel: 'channel_pc_web',
        cookie_enabled: String(navigator.cookieEnabled),
        browser_language: navigator.language || 'zh-CN',
        browser_platform: navigator.platform || '',
        browser_name: 'Chrome',
    });
    if (extraParams) {
        for (const [k, v] of Object.entries(extraParams)) params.set(k, v);
    }
    const response = await fetch(apiUrl + '?' + params.toString(), {
        method: 'POST', credentials: 'include',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({count: String(count), cursor: String(cursor)}).toString(),
    });
    if (!response.ok) return {ok: false, http_status: response.status};
    const data = await response.json();
    return {
        ok: data.status_code === 0,
        status_code: data.status_code,
        cursor: Number(data.cursor || 0),
        has_more: Boolean(data.has_more),
        items: (data.aweme_list || []).map(item => ({
            aweme_id: String(item.aweme_id || ''),
            description: item.desc || '',
            author: item.author ? item.author.nickname || '' : '',
            author_sec_uid: item.author ? item.author.sec_uid || '' : '',
            play_url: item.video && item.video.play_addr && item.video.play_addr.url_list
                ? item.video.play_addr.url_list[0] || '' : '',
            duration_seconds: Number(item.video && item.video.duration || 0) / 1000,
            create_time: Number(item.create_time || 0),
            likes: Number((item.statistics && item.statistics.digg_count) || 0),
            collects: Number((item.statistics && item.statistics.collect_count) || 0),
            comments: Number((item.statistics && item.statistics.comment_count) || 0),
            shares: Number((item.statistics && item.statistics.share_count) || 0),
        })),
    };
}"""

FETCH_COLLECTS_VIDEO_JS = r"""async ({apiUrl, cursor, count, collects_id}) => {
    const params = new URLSearchParams({
        device_platform: 'webapp',
        aid: '6383',
        channel: 'channel_pc_web',
        cookie_enabled: String(navigator.cookieEnabled),
        browser_language: navigator.language || 'zh-CN',
        browser_platform: navigator.platform || '',
        browser_name: 'Chrome',
        collects_id: String(collects_id),
        cursor: String(cursor),
        count: String(count),
    });
    const response = await fetch(apiUrl + '?' + params.toString(), {
        method: 'GET', credentials: 'include',
        headers: {'Content-Type': 'application/json'},
    });
    if (!response.ok) return {ok: false, http_status: response.status};
    const data = await response.json();
    return {
        ok: data.status_code === 0,
        status_code: data.status_code,
        cursor: Number(data.cursor || 0),
        has_more: Boolean(data.has_more),
        items: (data.aweme_list || []).map(item => ({
            aweme_id: String(item.aweme_id || ''),
            description: item.desc || '',
            author: item.author ? item.author.nickname || '' : '',
            author_sec_uid: item.author ? item.author.sec_uid || '' : '',
            play_url: item.video && item.video.play_addr && item.video.play_addr.url_list
                ? item.video.play_addr.url_list[0] || '' : '',
            duration_seconds: Number(item.video && item.video.duration || 0) / 1000,
            create_time: Number(item.create_time || 0),
            likes: Number((item.statistics && item.statistics.digg_count) || 0),
            collects: Number((item.statistics && item.statistics.collect_count) || 0),
            comments: Number((item.statistics && item.statistics.comment_count) || 0),
            shares: Number((item.statistics && item.statistics.share_count) || 0),
        })),
    };
}"""

FETCH_COLLECTS_JS = r"""async ({apiUrl, cursor, count}) => {
    const params = new URLSearchParams({
        device_platform: 'webapp',
        aid: '6383',
        channel: 'channel_pc_web',
        cookie_enabled: String(navigator.cookieEnabled),
        browser_language: navigator.language || 'zh-CN',
        browser_platform: navigator.platform || '',
        browser_name: 'Chrome',
        cursor: String(cursor),
        count: String(count),
    });
    const response = await fetch(apiUrl + '?' + params.toString(), {
        method: 'GET', credentials: 'include',
        headers: {'Content-Type': 'application/json'},
    });
    if (!response.ok) return {ok: false, http_status: response.status};
    const data = await response.json();
    const rawList = data.collects_list || [];
    return {
        ok: data.status_code === 0,
        status_code: data.status_code,
        cursor: Number(data.cursor || 0),
        has_more: Boolean(data.has_more),
        items: rawList.map(c => ({
            collects_id: String(c.collects_id_str || c.collects_id || ''),
            name: String(c.collects_name || '').trim(),
            total_number: Number(c.total_number || 0),
            cover_url: (c.collects_cover && c.collects_cover.url_list && c.collects_cover.url_list[0]) || '',
            create_time: Number(c.create_time || 0),
        })),
    };
}"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def pick_title(description: str, aweme_id: str) -> str:
    title = description.splitlines()[0].strip() if description else ""
    return title or f"Douyin favorite {aweme_id}"


def to_store_item(raw: dict, observed_at: str) -> dict | None:
    aweme_id = str(raw.get("aweme_id") or "").strip()
    if not AWEME_ID.fullmatch(aweme_id):
        return None
    description = str(raw.get("description") or "").strip()
    aweme_type = int(raw.get("aweme_type") or 0)
    raw_images = raw.get("images") or []
    image_urls = []
    for img in raw_images:
        url_list = img.get("url_list") or []
        if url_list:
            image_urls.append(str(url_list[-1]).strip())
    is_image_post = bool(image_urls) or aweme_type == 68
    raw_subtitle = raw.get("video", {}).get("subtitle") or raw.get("subtitle") or {}
    subtitle_url = ""
    subtitle_list = raw_subtitle.get("subtitles") or []
    if subtitle_list:
        subtitle_url = str(subtitle_list[0].get("Url") or subtitle_list[0].get("url") or "").strip()
    return {
        "aweme_id": aweme_id,
        "title": pick_title(description, aweme_id),
        "author": str(raw.get("author") or "").strip(),
        "author_sec_uid": str(raw.get("author_sec_uid") or "").strip(),
        "description": description,
        "duration": float(raw.get("duration_seconds") or 0),
        "create_time": int(raw.get("create_time") or 0),
        "likes": int(raw.get("likes") or 0),
        "collects": int(raw.get("collects") or 0),
        "comments": int(raw.get("comments") or 0),
        "shares": int(raw.get("shares") or 0),
        "play_url": str(raw.get("play_url") or "").strip(),
        "builtin_subtitle_url": subtitle_url,
        "aweme_type": aweme_type,
        "is_image_post": is_image_post,
        "image_urls": image_urls,
        "source_url": f"https://www.douyin.com/video/{aweme_id}",
        "observed_at": observed_at,
    }


def archive_profile(profile_dir: Path) -> str:
    """把疑似损坏的登录配置目录改名备份（只保留最近一份），返回说明文案。

    登录失败头号原因就是 profile 目录损坏（上次被强杀、杀软隔离、浏览器版本变化），
    损坏后每次启动都直接崩溃，用户只会看到"打不开浏览器"。备份后重建即可恢复。
    """
    try:
        if not profile_dir.exists():
            return ""
        backup = profile_dir.with_name(f"{profile_dir.name}.broken")
        if backup.exists():
            import shutil
            shutil.rmtree(backup, ignore_errors=True)
        profile_dir.rename(backup)
        return f"{profile_dir.name}→{backup.name}"
    except Exception:
        return ""


def explain_navigate_error(message: str) -> str:
    """打开抖音页面失败时的可执行提示（代理、DNS、超时是用户端最高频的三类）。"""
    text = str(message or "")
    if "ERR_PROXY_CONNECTION_FAILED" in text or "ERR_TUNNEL_CONNECTION_FAILED" in text:
        return "抖音页面打不开：系统代理（VPN / 加速器）把请求拦掉了。请关掉代理，或到「设置 → 登录与浏览器」勾选「绕过系统代理」后重试。"
    if "ERR_NAME_NOT_RESOLVED" in text or "ERR_INTERNET_DISCONNECTED" in text:
        return "抖音页面打不开：网络没连通或 DNS 解析失败，请检查网络后重试。"
    if "ERR_CONNECTION_TIMED_OUT" in text or "ERR_CONNECTION_RESET" in text or "Timeout" in text:
        return "抖音页面打开超时：网络太慢或被防火墙拦截，请稍后重试。"
    return text.replace("\n", " ")[:300] or "打开抖音页面失败"


class Collector:
    def __init__(self, profile_dir: Path, mode: str | None = None):
        self.profile_dir = Path(profile_dir).expanduser().resolve()
        self.mode = resolve_browser_mode(mode)
        self.preferred_browser = os.environ.get("DOK_PREFERRED_BROWSER", "").strip().lower()
        self.browser_id = ""
        self.browser_label = ""
        self._launch_errors: list[str] = []
        self._playwright = None
        self._context = None
        self._page = None

    async def _try_launch(self, attempts: list[dict]) -> list[str]:
        """按候选顺序逐个尝试，成功即记录实际使用的浏览器；全部失败返回原因列表。"""
        failures: list[str] = []
        self._launch_errors = []
        for attempt in attempts:
            try:
                self._context = await self._playwright.chromium.launch_persistent_context(**attempt["kwargs"])
            except Exception as exc:
                self._context = None
                raw = str(exc)
                self._launch_errors.append(raw)
                reason = explain_launch_error(raw)
                failures.append(f"{attempt['label']}（{reason}）")
                log(f"[browser] {attempt['label']} 启动失败：{reason}")
                continue
            self.browser_id = attempt["id"]
            self.browser_label = attempt["label"]
            log(f"[browser] 已启动：{attempt['label']}（headless={attempt['kwargs']['headless']}）")
            return failures
        return failures

    async def open(self, *, headless: bool) -> None:
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self._playwright = await async_playwright().start()
        attempts = launch_attempts(self.mode, self.profile_dir, headless, self.preferred_browser)
        log(f"[browser] 启动模式={self.mode}，候选={[a['label'] for a in attempts]}")
        failures = await self._try_launch(attempts)
        if self._context is None:
            # 只有"像是配置目录本身坏了"才动用户的登录缓存；
            # 纯粹找不到浏览器程序时不该清登录态（否则用户又要重新扫码）
            profile_suspect = any(
                re.search(r"closed|crash|singleton|already in use|denied|cannot|locked", err, re.I)
                for err in self._launch_errors
            )
            if profile_suspect:
                archived = []
                for attempt in attempts:
                    note = archive_profile(Path(attempt["kwargs"]["user_data_dir"]))
                    if note:
                        archived.append(note)
                if archived:
                    log(f"[browser] 登录配置目录疑似损坏，已备份（{'，'.join(archived)}），用全新目录重试…")
                    failures = await self._try_launch(attempts)
        if self._context is None:
            await self._playwright.stop()
            self._playwright = None
            raise ValueError(
                "浏览器启动失败。已尝试：" + "；".join(failures)
                + "。请到「设置 → 登录与浏览器」把登录浏览器切换为本机 Chrome/Edge 后重试，"
                "或点「重置登录浏览器缓存」清掉损坏的配置目录。"
            )
        self._page = self._context.pages[0] if self._context.pages else await self._context.new_page()
        # 反 webdriver 检测
        await self._context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
            Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN', 'zh', 'en']});
        """)

    def login_required_error(self) -> ValueError:
        """未登录时给出可执行提示：登录态是按浏览器分别保存的，换浏览器就得重新扫码。"""
        label = self.browser_label or "默认浏览器"
        return ValueError(
            f"抖音未登录（本次使用的浏览器：{label}）。"
            "登录状态是按浏览器分开保存的：如果换过浏览器（或刚重置过登录缓存），"
            "请到「设置 → 打开抖音扫码登录」用同一个浏览器重新扫码后再处理。"
        )

    async def close(self) -> None:
        if self._context is not None:
            try:
                await self._context.close()
            except Exception:
                pass
        if self._playwright is not None:
            try:
                await self._playwright.stop()
            except Exception:
                pass
        self._context = None
        self._page = None
        self._playwright = None

    async def navigate(self) -> None:
        if self._page is None:
            raise ValueError("browser is not open")
        try:
            await self._page.goto(COLLECTION_PAGE_URL, wait_until="domcontentloaded", timeout=45_000)
        except Exception as exc:
            raise ValueError(explain_navigate_error(str(exc))) from exc

    async def authenticated(self) -> bool:
        if self._context is None:
            return False
        cookies = await self._context.cookies("https://www.douyin.com")
        return any(cookie.get("name") in SESSION_COOKIE_NAMES and cookie.get("value") for cookie in cookies)

    async def fetch_page(self, *, cursor: int, count: int) -> dict:
        if self._page is None:
            raise ValueError("browser is not open")
        result = await self._page.evaluate(FETCH_JS, {"apiUrl": COLLECTION_API_URL, "cursor": cursor, "count": count})
        if not isinstance(result, dict):
            raise ValueError("Douyin returned an invalid collection response")
        return result

    async def fetch_collects(self, *, cursor: int, count: int) -> dict:
        if self._page is None:
            raise ValueError("browser is not open")
        result = await self._page.evaluate(FETCH_COLLECTS_JS, {"apiUrl": COLLECTS_LIST_API_URL, "cursor": cursor, "count": count})
        if not isinstance(result, dict):
            raise ValueError("Douyin returned an invalid collects response")
        return result

    async def fetch_collects_video(self, *, collects_id: str, cursor: int, count: int) -> dict:
        if self._page is None:
            raise ValueError("browser is not open")
        result = await self._page.evaluate(FETCH_COLLECTS_VIDEO_JS, {
            "apiUrl": COLLECTS_VIDEO_API_URL,
            "cursor": cursor,
            "count": count,
            "collects_id": collects_id,
        })
        if not isinstance(result, dict):
            raise ValueError("Douyin returned an invalid collects video response")
        return result

    async def collect(self, *, max_items: int) -> list[dict]:
        await self.open(headless=False)
        try:
            await self.navigate()
            if not await self.authenticated():
                raise self.login_required_error()
            observed_at = utc_now()
            collected: dict[str, dict] = {}
            cursor = 0
            seen_cursors: set[int] = set()
            while len(collected) < max_items:
                page_size = min(20, max_items - len(collected))
                result = await self.fetch_page(cursor=cursor, count=page_size)
                if not result.get("ok"):
                    raise ValueError(
                        f"Douyin collection access failed (status_code={result.get('status_code')}); login again and retry"
                    )
                items = result.get("items")
                if not isinstance(items, list):
                    raise ValueError("Douyin returned an invalid collection item list")
                for raw in items:
                    item = to_store_item(raw, observed_at)
                    if item is not None:
                        collected[item["aweme_id"]] = item
                        if len(collected) >= max_items:
                            break
                if not result.get("has_more") or not items:
                    break
                next_cursor = int(result.get("cursor") or 0)
                if next_cursor in seen_cursors or next_cursor == cursor:
                    raise ValueError("Douyin collection pagination stopped advancing")
                seen_cursors.add(cursor)
                cursor = next_cursor
                await asyncio.sleep(0.5)
            return list(collected.values())
        finally:
            await self.close()

    async def collect_folders(self, *, max_items: int) -> list[dict]:
        """拉取用户所有收藏夹（collects）列表。"""
        await self.open(headless=False)
        try:
            await self.navigate()
            if not await self.authenticated():
                raise self.login_required_error()
            folders: dict[str, dict] = {}
            cursor = 0
            seen_cursors: set[int] = set()
            while len(folders) < max_items:
                page_size = min(20, max_items - len(folders))
                result = await self.fetch_collects(cursor=cursor, count=page_size)
                if not result.get("ok"):
                    raise ValueError(
                        f"Douyin collects access failed (status_code={result.get('status_code')}); login again and retry"
                    )
                items = result.get("items")
                if not isinstance(items, list):
                    raise ValueError("Douyin returned an invalid collects item list")
                for f in items:
                    if f.get("collects_id") and f.get("name"):
                        folders[f["collects_id"]] = f
                if not result.get("has_more") or not items:
                    break
                next_cursor = int(result.get("cursor") or 0)
                if next_cursor in seen_cursors or next_cursor == cursor:
                    raise ValueError("Douyin collects pagination stopped advancing")
                seen_cursors.add(cursor)
                cursor = next_cursor
                await asyncio.sleep(0.5)
            return list(folders.values())
        finally:
            await self.close()

    async def collect_folder_videos(self, *, collects_id: str, max_items: int) -> list[dict]:
        """拉取指定收藏夹（collects_id）内的视频。"""
        await self.open(headless=False)
        try:
            await self.navigate()
            if not await self.authenticated():
                raise self.login_required_error()
            observed_at = utc_now()
            collected: dict[str, dict] = {}
            cursor = 0
            seen_cursors: set[int] = set()
            while len(collected) < max_items:
                page_size = min(20, max_items - len(collected))
                result = await self.fetch_collects_video(collects_id=collects_id, cursor=cursor, count=page_size)
                if not result.get("ok"):
                    raise ValueError(
                        f"Douyin collects video access failed (status_code={result.get('status_code')}); login again and retry"
                    )
                items = result.get("items")
                if not isinstance(items, list):
                    raise ValueError("Douyin returned an invalid collects video item list")
                for raw in items:
                    item = to_store_item(raw, observed_at)
                    if item is not None:
                        collected[item["aweme_id"]] = item
                        if len(collected) >= max_items:
                            break
                if not result.get("has_more") or not items:
                    break
                next_cursor = int(result.get("cursor") or 0)
                if next_cursor in seen_cursors or next_cursor == cursor:
                    raise ValueError("Douyin collects video pagination stopped advancing")
                seen_cursors.add(cursor)
                cursor = next_cursor
                await asyncio.sleep(0.5)
            return list(collected.values())
        finally:
            await self.close()


async def amain(args: argparse.Namespace) -> int:
    collector = Collector(Path(args.profile_dir), mode=getattr(args, "browser_mode", None))

    if args.action == "login":
        await collector.open(headless=False)
        try:
            await collector.navigate()
            deadline = asyncio.get_running_loop().time() + args.timeout
            while asyncio.get_running_loop().time() < deadline:
                try:
                    logged_in = await collector.authenticated()
                except Exception as exc:
                    # 用户手动把登录窗口关掉了：给明确结论，别让界面一直转圈
                    if "closed" in str(exc).lower():
                        print(json.dumps({
                            "status": "window_closed",
                            "browser": collector.browser_id,
                            "browser_label": collector.browser_label,
                            "message": "登录窗口被关掉了，登录没有完成。请重新点「打开抖音扫码登录」。",
                        }, ensure_ascii=False))
                        return 1
                    raise
                if logged_in:
                    print(json.dumps({"status": "authenticated", "browser": collector.browser_id, "browser_label": collector.browser_label}, ensure_ascii=False))
                    return 0
                await asyncio.sleep(2)
            print(json.dumps({
                "status": "timeout",
                "browser": collector.browser_id,
                "browser_label": collector.browser_label,
                "message": f"等了 {args.timeout} 秒还没检测到登录，请确认已在弹出的浏览器窗口里完成扫码",
            }, ensure_ascii=False))
            return 1
        finally:
            await collector.close()

    if args.action == "status":
        try:
            await collector.open(headless=True)
        except ValueError as exc:
            # 少数机器上无头模式起不来（精简运行库 / 安全软件拦截），但带窗口能起来。
            # 这里退回带窗口再查一次，避免"明明登录了却报未登录"。
            log(f"[browser] 无头模式不可用，改用带窗口模式重试：{str(exc)[:200]}")
            await collector.close()
            await collector.open(headless=False)
        try:
            await collector.navigate()
            ok = await collector.authenticated()
            print(json.dumps({
                "status": "authenticated" if ok else "login_required",
                "browser": collector.browser_id,
                "browser_label": collector.browser_label,
            }, ensure_ascii=False))
            return 0 if ok else 1
        finally:
            await collector.close()

    if args.action == "collect":
        if getattr(args, "collects_id", None):
            items = await collector.collect_folder_videos(collects_id=args.collects_id, max_items=args.max_items)
            payload = {"items": items, "collects_id": args.collects_id, "collects_name": getattr(args, "collects_name", None), "batch_at": utc_now()}
        else:
            items = await collector.collect(max_items=args.max_items)
            payload = {"items": items, "batch_at": utc_now()}
        output = Path(args.output).expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "status": "ok",
            "count": len(items),
            "output": str(output),
            "browser": collector.browser_id,
            "browser_label": collector.browser_label,
        }, ensure_ascii=False))
        return 0

    if args.action == "folders":
        folders = await collector.collect_folders(max_items=args.max_items)
        output = Path(args.output).expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({"items": folders}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"status": "ok", "count": len(folders), "output": str(output)}, ensure_ascii=False))
        return 0

    raise ValueError(f"unknown action: {args.action}")


def main() -> None:
    parser = argparse.ArgumentParser(description="API 直连抖音收藏采集器")
    sub = parser.add_subparsers(dest="action", required=True)

    p_login = sub.add_parser("login", help="打开浏览器扫码登录（登录态保存在独立 profile）")
    p_login.add_argument("--timeout", type=int, default=300)
    p_login.add_argument("--profile-dir", default=str(DEFAULT_PROFILE_DIR))
    p_login.add_argument("--channel", default=None)

    p_status = sub.add_parser("status", help="检查登录态")
    p_status.add_argument("--profile-dir", default=str(DEFAULT_PROFILE_DIR))
    p_status.add_argument("--channel", default=None)

    p_collect = sub.add_parser("collect", help="拉取收藏列表并输出 JSON")
    p_collect.add_argument("--max-items", type=int, default=1000)
    p_collect.add_argument("--output", default=str(DEFAULT_OUTPUT))
    p_collect.add_argument("--profile-dir", default=str(DEFAULT_PROFILE_DIR))
    p_collect.add_argument("--channel", default=None)
    p_collect.add_argument("--collects-id", default=None, help="指定收藏夹 ID，只拉该收藏夹内的视频（先运行 folders 拿到 ID）")
    p_collect.add_argument("--collects-name", default=None, help="收藏夹名称（写入输出便于溯源）")

    p_folders = sub.add_parser("folders", help="拉取用户所有收藏夹（collects）列表并输出 JSON")
    p_folders.add_argument("--max-items", type=int, default=100)
    p_folders.add_argument("--output", default=str(REPO_ROOT / "var" / "api-collects.json"))
    p_folders.add_argument("--profile-dir", default=str(DEFAULT_PROFILE_DIR))
    p_folders.add_argument("--channel", default=None)

    for sub_parser in (p_login, p_status, p_collect, p_folders):
        sub_parser.add_argument(
            "--browser-mode", default=None, choices=["auto", "builtin", "system"],
            help="登录浏览器策略：auto=内置优先、失败自动回退本机；builtin=只用内置；system=只用本机 Chrome/Edge",
        )

    args = parser.parse_args()
    try:
        sys.exit(asyncio.run(amain(args)))
    except Exception as exc:
        print(json.dumps({"error": str(exc)[:500]}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
