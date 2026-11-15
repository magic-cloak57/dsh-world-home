# 用 bilibili-api-python 发私信（它负责 wbi 签名，比手拼参数稳）
#   python dm_test.py <room\B站> [uid] [内容]
import asyncio
import json
import os
import sys

import requests

sys.stdout.reconfigure(encoding="utf-8")

if len(sys.argv) < 2:
    print(json.dumps({"ok": False, "error": "用法：dm_test.py <room\\B站> [uid] [内容]"}, ensure_ascii=False))
    sys.exit(2)
HOME = os.path.abspath(sys.argv[1])
TO = int(sys.argv[2]) if len(sys.argv) > 2 else 100000001
TEXT = sys.argv[3] if len(sys.argv) > 3 else "测试消息"

with open(os.path.join(HOME, "cookie.json"), encoding="utf-8") as f:
    store = json.load(f)
cookies = store.get("cookies") or {}

buvid3 = cookies.get("buvid3")
if not buvid3:
    try:
        spi = requests.get(
            "https://api.bilibili.com/x/frontend/finger/spi",
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                "Referer": "https://www.bilibili.com/",
            },
            timeout=20,
        ).json()
        buvid3 = (spi.get("data") or {}).get("b_3")
    except Exception:
        buvid3 = None

from bilibili_api import Credential, user  # noqa: E402

cred = Credential(
    sessdata=cookies.get("SESSDATA"),
    bili_jct=cookies.get("bili_jct"),
    buvid3=buvid3,
    dedeuserid=cookies.get("DedeUserID"),
    ac_time_value=store.get("ac_time_value"),
)


async def main():
    from bilibili_api import session
    try:
        res = await session.send_msg(
            credential=cred,
            receiver_id=TO,
            msg_type=session.EventType.TEXT,
            content=TEXT,
        )
        print(json.dumps({"ok": True, "result": res}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))


asyncio.run(main())
