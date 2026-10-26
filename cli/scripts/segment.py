#!/usr/bin/env python3
"""批量中文分词（jieba），供 consensus 观点匹配使用。

从 stdin 读 JSON：{"texts": ["句1", "句2", ...]}
输出 JSON：{"words": [["词1","词2"], ...]}（顺序与输入一致）
"""
from __future__ import annotations

import json
import re
import sys

try:
    import jieba
except ImportError:
    print(json.dumps({"error": "jieba is not installed in the project venv"}, ensure_ascii=False))
    sys.exit(1)

STOP_WORDS = {
    "的", "了", "是", "在", "就", "都", "要", "和", "与", "及", "或",
    "把", "被", "对", "从", "到", "这", "那", "也", "很", "但", "而",
    "之", "为", "以", "于", "一个", "就是", "然后", "可以", "这个",
    "那个", "因为", "所以", "如果", "但是", "自己", "我们", "你们",
    "他们", "没有", "什么", "怎么", "怎样", "时候", "东西", "一些",
    "有点", "一下", "这些", "那些", "不是", "不会", "不能", "不要",
}

_PUNCT = re.compile(r"[^\u4e00-\u9fa5a-zA-Z0-9]+")


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
    except Exception as exc:
        print(json.dumps({"error": f"invalid input: {exc}"}, ensure_ascii=False))
        sys.exit(1)
    texts = payload.get("texts") if isinstance(payload, dict) else payload
    if not isinstance(texts, list):
        print(json.dumps({"error": "texts must be a list"}, ensure_ascii=False))
        sys.exit(1)
    output = []
    for text in texts:
        normalized = _PUNCT.sub(" ", str(text or "")).strip()
        words = [w.strip() for w in jieba.lcut(normalized) if w.strip() and w.strip() not in STOP_WORDS]
        output.append(words)
    print(json.dumps({"words": output}, ensure_ascii=False))


if __name__ == "__main__":
    main()
