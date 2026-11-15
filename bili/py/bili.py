# B站 登录小工具（给 dsh-bili-ximeng 插件用，也能单独跑）
#   python bili.py --home <目录> --qr        出一张二维码，打印 {ok,key,url,png}
#   python bili.py --home <目录> --poll KEY  查一次扫码结果，成功就存登录态
#   python bili.py --home <目录> --check     看登录态还能不能用
#   python bili.py --home <目录> --logout    清掉本地登录态，并尽量让 B站 那边也失效
import base64
import io
import json
import os
import sys

import requests

# Windows 上的 python 默认按控制台代码页（GBK）写 stdout，
# 中文昵称传出去就成乱码了 —— 这里强制 UTF-8，宿主按 UTF-8 读。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE = "https://passport.bilibili.com/x/passport-login/web/qrcode"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def say(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def paths(home):
    os.makedirs(home, exist_ok=True)
    return os.path.join(home, "cookie.json"), os.path.join(home, "登录码.png")


def new_session():
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Referer": "https://www.bilibili.com/"})
    return s


def load_cookies(home):
    cookie_file, _ = paths(home)
    if not os.path.exists(cookie_file):
        return None
    with open(cookie_file, encoding="utf-8") as f:
        data = json.load(f)
    s = new_session()
    for k, v in (data.get("cookies") or {}).items():
        s.cookies.set(k, v, domain=".bilibili.com")
    return s


def check(home):
    s = load_cookies(home)
    if not s:
        say({"ok": False, "logged": False, "reason": "还没登录过"})
        return 0
    try:
        r = s.get("https://api.bilibili.com/x/web-interface/nav", timeout=20).json()
    except Exception as exc:
        say({"ok": False, "logged": False, "reason": f"连不上: {exc}"})
        return 0
    d = r.get("data") or {}
    if r.get("code") == 0 and d.get("isLogin"):
        say({"ok": True, "logged": True, "uname": d.get("uname"), "mid": d.get("mid"),
             "level": (d.get("level_info") or {}).get("current_level")})
    else:
        say({"ok": True, "logged": False, "reason": "登录态失效了，要重新扫"})
    return 0


def qr(home):
    s = new_session()
    try:
        g = s.get(f"{BASE}/generate", timeout=20).json()
    except Exception as exc:
        say({"ok": False, "error": f"出码失败: {exc}"})
        return 0
    if g.get("code") != 0:
        say({"ok": False, "error": "出码失败", "raw": g})
        return 0
    url = g["data"]["url"]
    key = g["data"]["qrcode_key"]
    _, qr_file = paths(home)
    png_b64 = None
    try:
        import qrcode
        img = qrcode.make(url)
        img.save(qr_file)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        png_b64 = base64.b64encode(buf.getvalue()).decode()
    except Exception:
        png_b64 = None
    say({"ok": True, "key": key, "url": url, "png": png_b64, "file": qr_file})
    return 0


def poll(home, key):
    s = load_cookies(home) or new_session()
    try:
        p = s.get(f"{BASE}/poll", params={"qrcode_key": key}, timeout=20).json()
    except Exception as exc:
        say({"ok": False, "state": "error", "error": str(exc)})
        return 0
    data = p.get("data") or {}
    code = data.get("code")
    if code == 86101:
        say({"ok": True, "state": "waiting", "msg": "还没扫"})
        return 0
    if code == 86090:
        say({"ok": True, "state": "scanned", "msg": "扫了，等你点确认"})
        return 0
    if code == 86038:
        say({"ok": True, "state": "expired", "msg": "码过期了"})
        return 0
    if code != 0:
        say({"ok": True, "state": "waiting", "msg": f"未知状态 {code}"})
        return 0

    cookie_file, _ = paths(home)
    payload = {
        "cookies": {c.name: c.value for c in s.cookies},
        "refresh_token": data.get("refresh_token"),
        "ac_time_value": None,
        "saved_at": __import__("time").strftime("%Y-%m-%dT%H:%M:%S%z"),
        "note": "自己的号，不要外传、不要进备份",
    }
    ret_url = data.get("url") or ""
    if "ac_time_value=" in ret_url:
        payload["ac_time_value"] = ret_url.split("ac_time_value=")[-1].split("&")[0]
    with open(cookie_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    say({"ok": True, "state": "ok", "msg": "登录成功"})
    return 0


def logout(home):
    s = load_cookies(home)
    if s:
        try:
            csrf = None
            for c in s.cookies:
                if c.name == "bili_jct":
                    csrf = c.value
            s.post("https://passport.bilibili.com/login/exit/v2",
                   data={"biliCSRF": csrf or "", "gourl": "https://www.bilibili.com/"}, timeout=15)
        except Exception:
            pass
    cookie_file, _ = paths(home)
    if os.path.exists(cookie_file):
        os.remove(cookie_file)
    say({"ok": True, "logged": False, "msg": "登录态已清掉"})
    return 0


def my_mid(s):
    for c in s.cookies:
        if c.name == "DedeUserID":
            return int(c.value)
    return None


def csrf_of(s):
    for c in s.cookies:
        if c.name == "bili_jct":
            return c.value
    return ""


def relation(s, fid):
    try:
        r = s.get("https://api.bilibili.com/x/relation", params={"fid": fid}, timeout=20).json()
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": r.get("code") == 0, "attribute": (r.get("data") or {}).get("attribute"), "raw_code": r.get("code")}


def follow(home, fid):
    s = load_cookies(home)
    if not s:
        say({"ok": False, "error": "还没登录"})
        return 0
    csrf = csrf_of(s)
    if not csrf:
        say({"ok": False, "error": "登录态里没有 bili_jct，得重新扫码"})
        return 0
    try:
        r = s.post("https://api.bilibili.com/x/relation/modify",
                   data={"fid": fid, "act": 1, "re_src": 11, "csrf": csrf}, timeout=20).json()
    except Exception as exc:
        say({"ok": False, "error": f"请求失败: {exc}"})
        return 0
    after = relation(s, fid)
    say({"ok": r.get("code") == 0, "msg": r.get("message"), "code": r.get("code"),
         "after": after, "fid": fid})
    return 0


MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
             29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
             22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]


def wbi_mixin(s):
    """B站 的 wbi 签名要一个 mixin key，从 nav 接口的 img/sub key 里换出来。"""
    try:
        nav = s.get("https://api.bilibili.com/x/web-interface/nav", timeout=20).json()
        wbi = (nav.get("data") or {}).get("wbi_img") or {}
        img = (wbi.get("img_url") or "").rsplit("/", 1)[-1].split(".")[0]
        sub = (wbi.get("sub_url") or "").rsplit("/", 1)[-1].split(".")[0]
        raw = img + sub
        if len(raw) < 64:
            return None
        return "".join(raw[i] for i in MIXIN_TAB)[:32]
    except Exception:
        return None


def sign_wbi(params, mixin):
    import hashlib
    import time
    from urllib.parse import urlencode

    clean = {k: "".join(ch for ch in str(v) if ch not in "!'()*") for k, v in params.items()}
    clean["wts"] = str(int(time.time()))
    query = urlencode(sorted(clean.items()))
    clean["w_rid"] = hashlib.md5((query + mixin).encode()).hexdigest()
    return clean


def dm(home, fid, text):
    s = load_cookies(home)
    if not s:
        say({"ok": False, "error": "还没登录"})
        return 0
    csrf = csrf_of(s)
    uid = my_mid(s)
    if not csrf or not uid:
        say({"ok": False, "error": "登录态不全（缺 bili_jct 或 DedeUserID）"})
        return 0
    s.headers.update({"Referer": "https://message.bilibili.com/", "Origin": "https://message.bilibili.com"})
    data = {
        "msg[sender_uid]": str(uid),
        "msg[receiver_id]": str(fid),
        "msg[receiver_type]": "1",
        "msg[msg_type]": "1",
        "msg[msg_status]": "0",
        "msg[content]": json.dumps({"content": text}, ensure_ascii=False),
        "msg[timestamp]": str(int(__import__("time").time())),
        "csrf": csrf,
        "csrf_token": csrf,
        "dev_id": "4A1A6A73-1E6B-4B5E-9C0B-6F4F5F2C0D11",
    }
    try:
        mixin = wbi_mixin(s)
        if mixin:
            data = sign_wbi(data, mixin)
        r = s.post("https://api.vc.bilibili.com/web_im/v1/web_im/send_msg", data=data, timeout=20).json()
    except Exception as exc:
        say({"ok": False, "error": f"请求失败: {exc}"})
        return 0
    d = r.get("data") or {}
    say({"ok": r.get("code") == 0, "code": r.get("code"), "msg": r.get("message"),
         "msg_key": d.get("msg_key"), "to": fid})
    return 0


def main(argv):
    home = None
    mode = None
    key = None
    text = None
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--home":
            home = argv[i + 1]
            i += 2
        elif a == "--qr":
            mode = "qr"
            i += 1
        elif a == "--poll":
            mode = "poll"
            key = argv[i + 1]
            i += 2
        elif a == "--check":
            mode = "check"
            i += 1
        elif a == "--logout":
            mode = "logout"
            i += 1
        elif a == "--follow":
            mode = "follow"
            key = argv[i + 1]
            i += 2
        elif a == "--dm":
            mode = "dm"
            key = argv[i + 1]
            i += 2
        elif a == "--text":
            text = argv[i + 1]
            i += 2
        else:
            i += 1
    if not home or not mode:
        say({"ok": False, "error": "用法: bili.py --home <目录> [--qr|--check|--logout|--poll KEY|--follow UID|--dm UID --text 内容]"})
        return 2
    if mode == "qr":
        return qr(home)
    if mode == "poll":
        return poll(home, key or "")
    if mode == "check":
        return check(home)
    if mode == "follow":
        return follow(home, key or "")
    if mode == "dm":
        return dm(home, key or "", text or "")
    return logout(home)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
