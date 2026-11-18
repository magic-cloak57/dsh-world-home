# B站 发评论：先在 ps1 里过鱼八股检查，再调这个脚本真发。
#   echo "评论正文" | python comment.py --home <B站目录> --bvid BV1xxxx [--dry]
# 输出一行 JSON：{ok, code, message, rpid?}
import argparse
import json
import os
import sys

import requests

sys.stdout.reconfigure(encoding="utf-8")

VIEW_API = "https://api.bilibili.com/x/web-interface/view"
ADD_API = "https://api.bilibili.com/x/v2/reply/add"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def load_cookies(home):
    path = os.path.join(home, "cookie.json")
    store = json.load(open(path, encoding="utf-8"))
    return (store.get("cookies") or {})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", required=True, help="放 cookie.json 的 B站 目录")
    ap.add_argument("--bvid", required=True)
    ap.add_argument("--text", default=None, help="不给就从 stdin 读")
    ap.add_argument("--dry", action="store_true", help="只查 bvid、打印要发的内容，不发")
    args = ap.parse_args()

    text = args.text
    if text is None:
        text = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    text = text.strip()
    if not text:
        print(json.dumps({"ok": False, "code": -1, "message": "评论是空的"}, ensure_ascii=False))
        return 1

    cookies = load_cookies(args.home)
    csrf = cookies.get("bili_jct", "")
    cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items() if v)
    headers = {"User-Agent": UA, "Referer": "https://www.bilibili.com/"}

    try:
        r = requests.get(VIEW_API, params={"bvid": args.bvid}, headers=headers, timeout=10).json()
        data = r.get("data") or {}
        aid = data.get("aid")
        title = data.get("title", "")
    except Exception as e:
        print(json.dumps({"ok": False, "code": -1, "message": f"取视频信息失败：{e}"}, ensure_ascii=False))
        return 1
    if not aid:
        print(json.dumps({"ok": False, "code": r.get("code"), "message": f"拿不到 aid：{r.get('message')}"}, ensure_ascii=False))
        return 1

    if args.dry:
        print(json.dumps({"ok": True, "dry": True, "aid": aid, "title": title, "text": text}, ensure_ascii=False))
        return 0

    if not csrf:
        print(json.dumps({"ok": False, "code": -1, "message": "cookie 里没有 bili_jct，发不了评论"}, ensure_ascii=False))
        return 1

    try:
        resp = requests.post(
            ADD_API,
            data={"oid": aid, "type": 1, "message": text, "csrf": csrf},
            headers={**headers, "Cookie": cookie_str, "Content-Type": "application/x-www-form-urlencoded"},
            timeout=15,
        ).json()
    except Exception as e:
        print(json.dumps({"ok": False, "code": -1, "message": f"发送失败：{e}"}, ensure_ascii=False))
        return 1

    ok = resp.get("code") == 0
    out = {"ok": ok, "code": resp.get("code"), "message": resp.get("message", "")}
    if ok:
        out["rpid"] = ((resp.get("data") or {}).get("rpid"))
    print(json.dumps(out, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
