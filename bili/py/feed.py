# 刷B站 第一步：搜近几天的视频 + 把字幕抓下来（只做"取料"，不判断）
#   python feed.py --home <目录> [--keywords "a,b"] [--days 3] [--limit 8]
# 产出：<房间>\刷B站\<日期>\候选.json 和 候选.md
import asyncio
import json
import os
import re
import sys
import time

import requests

sys.stdout.reconfigure(encoding="utf-8")

# 房间目录不写死：--home 指的是 room\B站，它的上一级就是房间（换家、换机器都不用改这里）
ROOM = ""
DEFAULT_KEYWORDS = "游戏 新作,独立游戏,二次元,AI 工具"
MAX_SUB_CHARS = 4000  # 一条字幕截到这么多字，够判断值不值得看

VIEW_API = "https://api.bilibili.com/x/web-interface/view"

def fill_stats(rows):
    """搜索接口给的 play 不可信（常是 0 或很久以前的数），逐个补一次真实数据。"""
    for row in rows:
        bvid = row.get("bvid")
        if not bvid:
            continue
        try:
            r = requests.get(VIEW_API, params={"bvid": bvid},
                             headers={"User-Agent": "Mozilla/5.0"}, timeout=6)
            data = (r.json() or {}).get("data") or {}
            stat = data.get("stat") or {}
            if stat.get("view") is not None:
                row["play"] = int(stat["view"])
            if data.get("pic"):
                row["pic"] = data["pic"]
            if data.get("owner", {}).get("name"):
                row["author"] = data["owner"]["name"]
            if data.get("duration"):
                sec = int(data["duration"])
                row["duration"] = f"{sec // 60}:{sec % 60:02d}"
        except Exception:
            continue
        time.sleep(0.15)
    return rows



def say(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def cred_from(home):
    store = json.load(open(os.path.join(home, "cookie.json"), encoding="utf-8"))
    cookies = store.get("cookies") or {}
    buvid3 = cookies.get("buvid3")
    if not buvid3:
        try:
            spi = requests.get("https://api.bilibili.com/x/frontend/finger/spi",
                               headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"},
                               timeout=20).json()
            buvid3 = (spi.get("data") or {}).get("b_3")
        except Exception:
            buvid3 = None
    from bilibili_api import Credential
    return Credential(sessdata=cookies.get("SESSDATA"), bili_jct=cookies.get("bili_jct"),
                      buvid3=buvid3, dedeuserid=cookies.get("DedeUserID"),
                      ac_time_value=store.get("ac_time_value"))


async def search_one(keyword, cred, days, min_play=0, order=None):
    from bilibili_api import search
    res = await search.search_by_type(keyword, search_type=search.SearchObjectType.VIDEO,
                                      order_type=order if order is not None else search.OrderVideo.PUBDATE, page=1)
    out = []
    now = time.time()
    for item in (res.get("result") or []):
        try:
            pubdate = int(item.get("pubdate") or 0)
        except Exception:
            pubdate = 0
        if days and pubdate and now - pubdate > days * 86400:
            continue
        try:
            play = int(item.get("play") or 0)
        except Exception:
            play = 0
        if play < min_play:
            continue
        title = (item.get("title") or "").replace('<em class="keyword">', "").replace("</em>", "")
        out.append({
            "bvid": item.get("bvid"),
            "title": title,
            "author": item.get("author"),
            "play": item.get("play"),
            "pic": item.get("pic"),
            "duration": item.get("duration"),
            "pubdate": pubdate,
            "keyword": keyword,
            "subtitle": "",
            "has_subtitle": False,
        })
    return out


async def grab_subtitle(v, cred):
    """拿到第一条中文字幕的纯文本；没有字幕就返回空。"""
    try:
        pages = await v.get_pages()
        cid = pages[0]["cid"]
        info = await v.get_subtitle(cid)
    except Exception:
        return "", False
    subs = (info or {}).get("subtitles") or []
    if not subs:
        return "", False
    url = None
    for s in subs:
        if str(s.get("lan", "")).startswith("zh"):
            url = s.get("subtitle_url")
            break
    url = url or subs[0].get("subtitle_url")
    if not url:
        return "", False
    if url.startswith("//"):
        url = "https:" + url
    try:
        data = requests.get(url, timeout=25).json()
    except Exception:
        return "", False
    body = data.get("body") or []
    text = "".join(str(line.get("content") or "") for line in body)
    # 有的"字幕"其实是歌词：满屏音符，判断不出内容，当没字幕处理
    if text.count("♪") > 20:
        return "", False
    return text[:MAX_SUB_CHARS], bool(text)


# ── 评论的两层筛法 ────────────────────────────────────────────────
# 第一层：硬信号，命中即丢（只抓"确定是机器"的，宁可漏不错杀）
BATCH_NAME = re.compile(r"^bili_\d{10,}$", re.IGNORECASE)
BOT_NAME = re.compile(r"(自动回复|机器人|助手|观察员|日报|播报|\bbot\b)", re.IGNORECASE)
SELF_AI = re.compile(r"(作为(一个)?(AI|人工智能|语言模型|助手)|我(是|作为)(一个)?(AI|人工智能)|"
                     r"希望(这|我的)回答|以上(就)?是(我的)?(回答|分析))", re.IGNORECASE)
# 第二层：正向给分（有人在场的证据）
HUMAN_PLUS = [
    (re.compile(r"\d{1,2}:\d{2}"), 2),          # 报时间点
    (re.compile(r"@[\w\u4e00-\u9fa5_-]{1,16}"), 2),  # 对着人说话
    (re.compile(r"\[.{1,14}\]"), 1),            # 用表情包
    (re.compile(r"(草|233|hhhh|awsl|yyds|绷|离谱|蚌埠|笑死|真的|我不|我也|谁懂|致敬)"), 1),
    (re.compile(r"\d+"), 1),
]
# 反向扣分（像在交作业）
TEMPLATE_MINUS = re.compile(r"(首先|其次|总之|总而言之|总的来说|值得一提的是|希望对.{0,8}帮助|"
                            r"感谢(你的)?分享|不得不说|综上|第一[，,].{0,20}第二[，,])")


def looks_like_bot(uname, text):
    if BATCH_NAME.match(uname) or BOT_NAME.search(uname):
        return True
    return bool(SELF_AI.search(text))


def human_score(text):
    """给一条评论打分：越高越像人。只用来排序和标记，不决定生死。"""
    s = 0
    for pattern, weight in HUMAN_PLUS:
        if pattern.search(text):
            s += weight
    if len(text) <= 8:
        s += 1                       # 短促、随意
    if TEMPLATE_MINUS.search(text):
        s -= 2
    if len(text) > 120 and not re.search(r"\d", text):
        s -= 1                       # 长、工整、没有半点具体信息
    if text.count("。") >= 3 and not re.search(r"[!?！？~]", text):
        s -= 1
    return s


def grab_comments(bvid, limit=4):
    """取几条高赞评论，硬信号直接丢，其余按"像不像人"排序并标可疑。
    真正的判断留给读候选那一轮（那一轮本来就要花 token，不额外调用模型）。"""
    try:
        s = requests.Session()
        s.headers.update({"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"})
        view = s.get("https://api.bilibili.com/x/web-interface/view", params={"bvid": bvid}, timeout=20).json()
        aid = ((view.get("data") or {}).get("aid"))
        if not aid:
            return []
        rep = s.get("https://api.bilibili.com/x/v2/reply",
                    params={"type": 1, "oid": aid, "sort": 2, "ps": 20, "pn": 1}, timeout=20).json()
        replies = ((rep.get("data") or {}).get("replies")) or []
        rows = []
        for r in replies:
            member = r.get("member") or {}
            uname = str(member.get("uname") or "")
            msg = str((r.get("content") or {}).get("message") or "").replace("\n", " ")
            if not msg or len(msg) < 4:
                continue
            if looks_like_bot(uname, msg):
                continue
            rows.append({"uname": uname, "like": r.get("like") or 0,
                         "text": msg[:140], "score": human_score(msg)})
        # 先按"像人"的分排，同分看赞
        rows.sort(key=lambda x: (x["score"], x["like"]), reverse=True)
        return rows[:limit]
    except Exception:
        return []


def hot_rows(days, limit=6):
    """热门里挑新的：搜索接口给的播放量全是 0，用热门补一批真有人看的。"""
    try:
        s = requests.Session()
        s.headers.update({"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"})
        data = s.get("https://api.bilibili.com/x/web-interface/popular",
                     params={"ps": 20, "pn": 1}, timeout=20).json()
        now = time.time()
        out = []
        for it in (data.get("data") or {}).get("list") or []:
            try:
                pubdate = int(it.get("pubdate") or 0)
            except Exception:
                pubdate = 0
            if days and pubdate and now - pubdate > days * 86400:
                continue
            out.append({
                "bvid": it.get("bvid"),
                "title": (it.get("title") or "")[:60],
                "author": (it.get("owner") or {}).get("name"),
                "play": (it.get("stat") or {}).get("view"),
                "duration": it.get("duration"),
                "pubdate": pubdate,
                "keyword": "热门",
                "pic": it.get("pic"),
                "subtitle": "",
                "has_subtitle": False,
            })
            if len(out) >= limit:
                break
        return out
    except Exception:
        return []


async def main_async(args):
    from bilibili_api import video

    home = args["home"]
    keywords = [k.strip() for k in re.split(r"[,，、;；]", args["keywords"]) if k.strip()]
    days = int(args["days"])
    limit = int(args["limit"])
    hot_ratio = float(args.get("hot_ratio") or 0.8)
    cred = cred_from(home)

    picked = []
    seen = set()
    errors = []

    async def take(row):
        """抓到一条就补字幕、记账；重复或没 bvid 的跳过。"""
        if not row.get("bvid") or row["bvid"] in seen:
            return False
        seen.add(row["bvid"])
        try:
            v = video.Video(bvid=row["bvid"], credential=cred)
            text, has = await grab_subtitle(v, cred)
            row["subtitle"], row["has_subtitle"] = text, has
        except Exception:
            row["subtitle"], row["has_subtitle"] = "", False
        picked.append(row)
        return True

    def next_from(q):
        """取这个关键词队列里的下一条没见过的。"""
        rows = q["rows"]
        while q["i"] < len(rows):
            row = rows[q["i"]]
            q["i"] += 1
            if row.get("bvid") and row["bvid"] not in seen:
                return row
        return None

    # 每个关键词各抓两批：按点击（热门）和按最新（冷门）各一页，先别往池子里放
    from bilibili_api import search
    hot_days = max(days, 7)
    hot_queues, cold_queues = [], []
    for kw in keywords:
        try:
            hot = await search_one(kw, cred, hot_days, order=search.OrderVideo.TOTALRANK)
        except Exception as exc:
            errors.append(f"{kw}: {type(exc).__name__}: {exc}")
            hot = []
        try:
            cold = await search_one(kw, cred, days)
        except Exception:
            cold = []
        hot_queues.append({"kw": kw, "rows": hot, "i": 0})
        cold_queues.append({"kw": kw, "rows": cold, "i": 0})

    # 热门和冷门的比例：limit=5 时就是 3 热门 + 2 冷门
    hot_target = min(limit, max(1, int(round(limit * hot_ratio))))
    cold_target = limit - hot_target

    async def fill(pool, target, hot):
        """在关键词间轮转，把池子里的视频补到 target 条；全局 seen 去重。"""
        got = 0
        while got < target:
            added = False
            for q in pool:
                if got >= target:
                    break
                while q["i"] < len(q["rows"]):
                    row = q["rows"][q["i"]]
                    q["i"] += 1
                    if row.get("bvid") and row["bvid"] not in seen:
                        row["hot"] = hot
                        if await take(row):
                            got += 1
                            added = True
                        break
            if not added:
                break
        return got

    # 先取热门，取不满再拿全站热门榜兜底
    await fill(hot_queues, hot_target, True)
    if len(picked) < hot_target:
        for row in hot_rows(days, limit=hot_target - len(picked)):
            row["hot"] = True
            await take(row)
    # 再取冷门
    await fill(cold_queues, cold_target, False)

    picked.extend({"error": e} for e in errors)

    rows = [r for r in picked if not r.get("error")]
    # 兜底：不管中间怎么拼，最后总数不许超过 limit
    if len(rows) > limit:
        rows = rows[:limit]
    day = time.strftime("%Y-%m-%d")

    # 每条抓几条高赞评论：看观众为什么来、为什么回（AI 评论已过滤）
    for r in rows:
        r["comments"] = grab_comments(r["bvid"], limit=4)

    fill_stats(rows)

    outdir = os.path.join(ROOM, "刷B站", day)
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "候选.json"), "w", encoding="utf-8") as f:
        json.dump({"day": day, "keywords": keywords, "rows": rows}, f, ensure_ascii=False, indent=2)

    lines = [f"# {day} 候选（{len(rows)} 条，有字幕 {sum(1 for r in rows if r['has_subtitle'])} 条）", ""]
    for r in rows:
        lines.append(f"## {r['bvid']}　{r['title']}")
        tag = "热门" if r.get("hot") else "冷门"
        lines.append(f"- {tag}｜UP：{r['author']}　播放：{r['play']}　时长：{r['duration']}　关键词：{r['keyword']}")
        if r["has_subtitle"]:
            lines.append(f"- 字幕（{len(r['subtitle'])} 字）：{r['subtitle'][:600]}……")
        else:
            lines.append("- 没有字幕")
        for c in (r.get("comments") or []):
            score = c.get("score", 0)
            mark = "　←像机器，别学" if score <= 0 else ""
            lines.append(f"- 评论（{c['uname']}，赞{c['like']}，像人{score}）：{c['text']}{mark}")
        lines.append("")
    with open(os.path.join(outdir, "候选.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    say({"ok": True, "day": day, "count": len(rows),
         "with_subtitle": sum(1 for r in rows if r["has_subtitle"]),
         "with_comments": sum(1 for r in rows if r.get("comments")),
         "dir": outdir, "errors": [r["error"] for r in picked if r.get("error")]})


def main(argv):
    global ROOM
    args = {"home": None, "keywords": DEFAULT_KEYWORDS, "days": "3", "limit": "8", "hot_ratio": "0.8"}
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--home":
            args["home"] = argv[i + 1]; i += 2
        elif a == "--keywords":
            args["keywords"] = argv[i + 1]; i += 2
        elif a == "--days":
            args["days"] = argv[i + 1]; i += 2
        elif a == "--limit":
            args["limit"] = argv[i + 1]; i += 2
        elif a == "--hot-ratio":
            args["hot_ratio"] = argv[i + 1]; i += 2
        else:
            i += 1
    if not args["home"]:
        say({"ok": False, "error": "缺 --home"})
        return 2
    ROOM = os.path.dirname(os.path.abspath(args["home"]))
    asyncio.run(main_async(args))
    # 候选目录只留最近 7 天（日报 md 是记忆，不在这里删）
    import shutil
    root = os.path.join(ROOM, "刷B站")
    if os.path.isdir(root):
        cutoff = time.time() - 7 * 86400
        for name in os.listdir(root):
            p = os.path.join(root, name)
            if os.path.isdir(p) and name.count("-") == 2:
                try:
                    stamp = time.mktime(time.strptime(name, "%Y-%m-%d"))
                except Exception:
                    continue
                if stamp < cutoff:
                    shutil.rmtree(p, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
