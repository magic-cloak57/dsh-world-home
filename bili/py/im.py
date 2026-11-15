# B站 私信收发（给 dsh-bili-ximeng 用；走 bilibili-api-python，签名交给它）
#   python im.py --home <目录> --sessions          最近会话
#   python im.py --home <目录> --messages <uid>    和某人的最近 30 条
#   python im.py --home <目录> --send <uid> --text 内容
import asyncio
import json
import sys
import time

import requests

sys.stdout.reconfigure(encoding="utf-8")


def say(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load(home):
    with open(home + r"\cookie.json", encoding="utf-8") as f:
        return json.load(f)


def make_cred(store):
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
    from bilibili_api import Credential
    return Credential(
        sessdata=cookies.get("SESSDATA"),
        bili_jct=cookies.get("bili_jct"),
        buvid3=buvid3,
        dedeuserid=cookies.get("DedeUserID"),
        ac_time_value=store.get("ac_time_value"),
    )


def text_of(msg):
    raw = msg.get("content") or ""
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict) and obj.get("content"):
            return str(obj["content"])
    except Exception:
        pass
    return "[非文字消息]"


def sessions(home):
    store = load(home)
    cred = make_cred(store)

    async def go():
        from bilibili_api import session
        return await session.get_sessions(cred, session_type=4)

    try:
        data = asyncio.run(go())
    except Exception as exc:
        say({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 0
    lst = data.get("session_list") or data.get("data", {}).get("session_list") or []
    out = []
    for it in lst:
        last = it.get("last_msg") or {}
        out.append({
            "uid": it.get("talker_id"),
            "ts": it.get("session_ts") or last.get("timestamp"),
            "unread": it.get("unread_count") or 0,
            "last": text_of(last) if last else "",
            "last_from": last.get("sender_uid"),
        })
    say({"ok": True, "count": len(out), "sessions": out})
    return 0


def messages(home, uid):
    store = load(home)
    cred = make_cred(store)
    me = int(store["cookies"].get("DedeUserID") or 0)

    async def go():
        from bilibili_api import session
        return await session.fetch_session_msgs(talker_id=int(uid), credential=cred)

    try:
        data = asyncio.run(go())
    except Exception as exc:
        say({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 0
    lst = data.get("messages") or []
    msgs = []
    for m in lst:
        msgs.append({
            "from_me": int(m.get("sender_uid") or 0) == me,
            "ts": m.get("timestamp"),
            "text": text_of(m),
        })
    msgs.reverse()  # 老 -> 新
    say({"ok": True, "uid": int(uid), "count": len(msgs), "messages": msgs})
    return 0


def send(home, uid, text):
    store = load(home)
    cred = make_cred(store)

    async def go():
        from bilibili_api import session
        return await session.send_msg(credential=cred, receiver_id=int(uid),
                                      msg_type=session.EventType.TEXT, content=text)

    try:
        res = asyncio.run(go())
    except Exception as exc:
        say({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 0
    say({"ok": True, "msg_key": res.get("msg_key"), "to": int(uid), "ts": int(time.time())})
    return 0


def main(argv):
    home, mode, uid, text = None, None, None, None
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--home":
            home = argv[i + 1]; i += 2
        elif a == "--sessions":
            mode = "sessions"; i += 1
        elif a == "--messages":
            mode = "messages"; uid = argv[i + 1]; i += 2
        elif a == "--send":
            mode = "send"; uid = argv[i + 1]; i += 2
        elif a == "--text":
            text = argv[i + 1]; i += 2
        else:
            i += 1
    if not home or not mode:
        say({"ok": False, "error": "用法: im.py --home <目录> [--sessions|--messages UID|--send UID --text 内容]"})
        return 2
    if mode == "sessions":
        return sessions(home)
    if mode == "messages":
        return messages(home, uid)
    return send(home, uid, text or "")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
