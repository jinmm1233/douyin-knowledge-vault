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
        "source_url": f"https://www.douyin.com/video/{aweme_id}",
        "observed_at": observed_at,
    }


class Collector:
    def __init__(self, profile_dir: Path, channel: str | None = None):
        self.profile_dir = Path(profile_dir).expanduser().resolve()
        self.channel = channel
        self._playwright = None
        self._context = None
        self._page = None

    async def open(self, *, headless: bool) -> None:
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self._playwright = await async_playwright().start()
        import os
        # 尝试顺序：系统 Edge → 系统 Chrome → 内置 chromium（兜底）
        channels = [self.channel] if self.channel else ["msedge", "chrome", None]
        bundled_chrome = os.environ.get("DOK_CHROME_PATH")
        for channel in channels:
            kwargs = {
                "user_data_dir": str(self.profile_dir),
                "headless": headless,
                "viewport": {"width": 1280, "height": 800},
                "locale": "zh-CN",
                "args": [
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                ],
            }
            if channel:
                kwargs["channel"] = channel
            elif bundled_chrome and os.path.exists(bundled_chrome):
                kwargs["executable_path"] = bundled_chrome
            try:
                self._context = await self._playwright.chromium.launch_persistent_context(**kwargs)
                break
            except Exception:
                self._context = None
        if self._context is None:
            await self._playwright.stop()
            self._playwright = None
            raise ValueError("no supported browser is available; install Chrome, Edge, or Playwright Chromium")
        self._page = self._context.pages[0] if self._context.pages else await self._context.new_page()
        # 反 webdriver 检测
        await self._context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
            Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN', 'zh', 'en']});
        """)

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
        await self._page.goto(COLLECTION_PAGE_URL, wait_until="domcontentloaded", timeout=45_000)

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
                raise ValueError("Douyin login is required; run 'collect-favorites.py login' first")
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
                raise ValueError("Douyin login is required; run 'collect-favorites.py login' first")
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
                raise ValueError("Douyin login is required; run 'collect-favorites.py login' first")
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
    collector = Collector(Path(args.profile_dir), channel=args.channel)

    if args.action == "login":
        await collector.open(headless=False)
        try:
            await collector.navigate()
            deadline = asyncio.get_running_loop().time() + args.timeout
            while asyncio.get_running_loop().time() < deadline:
                if await collector.authenticated():
                    print(json.dumps({"status": "authenticated"}, ensure_ascii=False))
                    return 0
                await asyncio.sleep(2)
            print(json.dumps({"status": "timeout", "message": "login was not completed before the timeout"}, ensure_ascii=False))
            return 1
        finally:
            await collector.close()

    if args.action == "status":
        await collector.open(headless=True)
        try:
            await collector.navigate()
            ok = await collector.authenticated()
            print(json.dumps({"status": "authenticated" if ok else "login_required"}, ensure_ascii=False))
            return 0 if ok else 1
        finally:
            await collector.close()

    if args.action == "collect":
        if getattr(args, "collects_id", None):
            items = await collector.collect_folder_videos(collects_id=args.collects_id, max_items=args.max_items)
            payload = {"items": items, "collects_id": args.collects_id, "collects_name": getattr(args, "collects_name", None)}
        else:
            items = await collector.collect(max_items=args.max_items)
            payload = {"items": items}
        output = Path(args.output).expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"status": "ok", "count": len(items), "output": str(output)}, ensure_ascii=False))
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

    args = parser.parse_args()
    try:
        sys.exit(asyncio.run(amain(args)))
    except Exception as exc:
        print(json.dumps({"error": str(exc)[:500]}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
