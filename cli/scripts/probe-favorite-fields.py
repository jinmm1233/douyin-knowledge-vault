"""一次性探测脚本：检查抖音收藏列表 API 原始返回里是否有"收藏时间"字段（探测后删除）。
复用 collect-favorites.py 的 Collector 与登录态，只拉少量条目打印原始字段名与时间字段值。
"""
import asyncio, sys, json
import importlib.util
from pathlib import Path

_script_dir = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("collect_favorites", _script_dir / "collect-favorites.py")
cf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cf)

PROBE_JS = r"""async ({apiUrl, cursor, count}) => {
    const params = new URLSearchParams({
        device_platform: 'webapp',
        aid: '6383',
        channel: 'channel_pc_web',
        cookie_enabled: String(navigator.cookieEnabled),
        browser_language: navigator.language || 'zh-CN',
        browser_platform: navigator.platform || '',
        browser_name: 'Chrome',
    });
    const response = await fetch(apiUrl + '?' + params.toString(), {
        method: 'POST', credentials: 'include',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({count: String(count), cursor: String(cursor)}).toString(),
    });
    if (!response.ok) return {ok: false, http_status: response.status};
    const data = await response.json();
    const items = data.aweme_list || [];
    return {
        ok: data.status_code === 0,
        items: items.slice(0, 5).map(it => ({
            aweme_id: String(it.aweme_id || ''),
            keys: Object.keys(it),
            time_fields: Object.fromEntries(
                Object.entries(it).filter(([k]) => /time|date|favorite|collect/i.test(k))
            ),
        })),
    };
}"""


class ProbeCollector(cf.Collector):
    async def fetch_probe(self, *, cursor: int, count: int) -> dict:
        page = self._page
        await page.wait_for_load_state("domcontentloaded")
        result = await page.evaluate(
            f"async () => {{ const fn = {PROBE_JS}; return await fn({{apiUrl: '{cf.COLLECTION_API_URL}', cursor: {cursor}, count: {count}}}); }}"
        )
        return result

    async def run(self) -> dict:
        await self.open(headless=False)
        try:
            await self.navigate()
            if not await self.authenticated():
                raise ValueError("Douyin login is required")
            return await self.fetch_probe(cursor=0, count=20)
        finally:
            await self.close()


async def main() -> None:
    c = ProbeCollector(cf.DEFAULT_PROFILE_DIR)
    try:
        result = await c.run()
    except Exception as exc:
        print("PROBE_ERROR", exc)
        return
    print(json.dumps(result, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    asyncio.run(main())
