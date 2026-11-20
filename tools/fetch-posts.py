#!/usr/bin/env python3
"""Fetch recent Weibo posts for archived accounts and write data/posts/<uid>.json.

Reuses the logged-in cookie from IdolGallary/backend/utils/weiboutil.py.
Run on the server (or locally if the cookie file exists):
  python3 tools/fetch-posts.py --limit 100
  python3 tools/fetch-posts.py --uid 7984139147 --limit 100
"""

from __future__ import annotations

import argparse
import html
import json
import os
import random
import re
import sys
import time
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = PROJECT_ROOT / "data"
DEFAULT_UTILS_DIR = Path(os.environ.get("WEIBO_UTILS_DIR", "/home/admin/IdolGallary/backend/utils"))

sys.path.insert(0, str(DEFAULT_UTILS_DIR))
import weiboutil  # noqa: E402
import httpx  # noqa: E402

MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"
)


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def html_to_text(value: str) -> str:
    text = str(value or "")
    text = re.sub(r"<img[^>]*alt=\"([^\"]*)\"[^>]*>", r"\1", text)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.strip()


def parse_time(value: str) -> int:
    try:
        return int(datetime.strptime(value, "%a %b %d %H:%M:%S %z %Y").timestamp() * 1000)
    except Exception:
        return 0


def normalize_pics(raw) -> list[dict]:
    pics = []
    for pic in raw or []:
        if not isinstance(pic, dict):
            continue
        large = pic.get("large") or {}
        thumb = pic.get("url") or large.get("url") or ""
        big = large.get("url") or thumb
        geo = large.get("geo") or pic.get("geo") or {}
        if not thumb:
            continue
        pics.append(
            {
                "thumb": thumb,
                "large": big,
                "width": int(geo.get("width") or 0),
                "height": int(geo.get("height") or 0),
            }
        )
    return pics


def normalize_page_info(raw):
    if not isinstance(raw, dict):
        return None
    pic = (raw.get("page_pic") or {}).get("url") if isinstance(raw.get("page_pic"), dict) else ""
    return {
        "type": str(raw.get("type") or ""),
        "url": str(raw.get("page_url") or ""),
        "title": html_to_text(raw.get("page_title") or ""),
        "content1": html_to_text(raw.get("content1") or ""),
        "content2": html_to_text(raw.get("content2") or ""),
        "pic": str(pic or ""),
    }


def normalize_retweet(raw):
    if not isinstance(raw, dict):
        return None
    user = raw.get("user") or {}
    return {
        "id": str(raw.get("id") or ""),
        "userName": str(user.get("screen_name") or ""),
        "uid": str(user.get("id") or ""),
        "text": html_to_text(raw.get("text") or ""),
        "pics": normalize_pics(raw.get("pics")),
    }


def normalize_mblog(mblog: dict, card: dict) -> dict:
    return {
        "id": str(mblog.get("id") or mblog.get("mid") or ""),
        "createdAtMs": parse_time(str(mblog.get("created_at") or "")),
        "source": html_to_text(mblog.get("source") or ""),
        "text": html_to_text(mblog.get("text") or ""),
        "pics": normalize_pics(mblog.get("pics")),
        "pageInfo": normalize_page_info(mblog.get("page_info")),
        "retweeted": normalize_retweet(mblog.get("retweeted_status")),
        "reposts": int(mblog.get("reposts_count") or 0),
        "comments": int(mblog.get("comments_count") or 0),
        "likes": int(mblog.get("attitudes_count") or 0),
        "isTop": bool(mblog.get("isTop") or card.get("isTop")),
    }


def extract_mblogs(cards) -> list[tuple[dict, dict]]:
    out = []
    for card in cards or []:
        if not isinstance(card, dict):
            continue
        if isinstance(card.get("mblog"), dict):
            out.append((card["mblog"], card))
        for group in card.get("card_group") or []:
            if isinstance(group, dict) and isinstance(group.get("mblog"), dict):
                out.append((group["mblog"], group))
    return out


def fetch_page(uid: str, page: int, headers: dict) -> dict:
    url = (
        "https://m.weibo.cn/api/container/getIndex"
        f"?type=uid&value={uid}&containerid=107603{uid}&page={page}"
    )
    last = ""
    for attempt in range(5):
        try:
            response = httpx.get(url, headers=headers, timeout=30, follow_redirects=True)
            if response.status_code in (418, 432):
                last = f"HTTP {response.status_code}"
                time.sleep(2 + attempt * 2)
                continue
            if response.status_code != 200:
                return {"ok": 0, "error": f"HTTP {response.status_code}"}
            doc = response.json()
            if doc.get("ok") != 1:
                last = f"ok={doc.get('ok')} errno={doc.get('errno')}"
                if int(doc.get("errno") or 0) in (403, 414, 418, 432, 100005):
                    time.sleep(2 + attempt * 2)
                    continue
                return {"ok": 0, "error": last}
            return doc
        except Exception as exc:  # noqa: BLE001
            last = str(exc)
            time.sleep(1 + attempt * 2)
    return {"ok": 0, "error": last or "request failed"}


def fetch_user_posts(uid: str, limit: int, headers: dict) -> tuple[list[dict], int]:
    items: list[dict] = []
    seen: set[str] = set()
    total = 0
    for page in range(1, 16):
        doc = fetch_page(uid, page, headers)
        data = doc.get("data") or {}
        if page == 1:
            total = int((data.get("cardlistInfo") or {}).get("total") or 0)
        cards = data.get("cards") or []
        fresh = 0
        for mblog, card in extract_mblogs(cards):
            item = normalize_mblog(mblog, card)
            if not item["id"] or item["id"] in seen:
                continue
            seen.add(item["id"])
            items.append(item)
            fresh += 1
            if len(items) >= limit:
                break
        print(f"  page {page}: +{fresh}, total {len(items)}", flush=True)
        if len(items) >= limit or not cards or fresh == 0:
            break
        time.sleep(0.8 + random.random() * 0.8)
    return items[:limit], total


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--uid", action="append", default=[], help="only fetch these uids")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    users = read_json(data_dir / "users.json", {}).get("users") or []
    profiles = read_json(data_dir / "profiles.json", {}).get("profiles") or {}
    wanted = [str(u) for u in args.uid] if args.uid else [str(u.get("uid")) for u in users]
    headers = weiboutil.get_auth_headers()
    if not headers.get("Cookie"):
        print("missing weibo cookie; check IdolGallary/backend/weibo_cookies.json", file=sys.stderr)
        return 2

    out_dir = data_dir / "posts"
    out_dir.mkdir(parents=True, exist_ok=True)
    for uid in wanted:
        if not re.fullmatch(r"\d{1,20}", uid):
            continue
        name = (
            (profiles.get(uid) or {}).get("screenName")
            or next((u.get("screenName") for u in users if str(u.get("uid")) == uid), "")
            or uid
        )
        print(f"[{uid}] {name}", flush=True)
        items, total = fetch_user_posts(uid, args.limit, headers)
        doc = {
            "version": 1,
            "uid": uid,
            "screenName": name,
            "total": total,
            "fetchedAtMs": int(time.time() * 1000),
            "items": items,
        }
        (out_dir / f"{uid}.json").write_text(
            json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        print(f"[{uid}] saved {len(items)} posts -> {out_dir / (uid + '.json')}\n", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

