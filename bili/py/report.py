# 把一天挑出来的视频整理成日报 JSON（给 DSH 里的可视化窗口用）
# 用法：python report.py --home <目录> --day 2026-11-02 --picks picks.json
# picks.json：[{"bvid": "...", "why": "...", "mine": "..."}, ...]
import json
import os
import sys

import requests

sys.stdout.reconfigure(encoding="utf-8")
# 房间目录不写死：--home 指的是 room\B站，上一级就是房间
ROOM = ""
KEEP_DAYS = 7  # 聊天页那扇窗只留最近 7 天的日报 JSON；md 是记忆，永久留


def prune(days=KEEP_DAYS):
    """删掉最老的 <日期>.json（窗口用的），md 一个都不动。"""
    import time
    folder = os.path.join(ROOM, "刷B站")
    if not os.path.isdir(folder):
        return []
    keep_after = time.time() - days * 86400
    removed = []
    for name in os.listdir(folder):
        if not name.endswith(".json"):
            continue
        stem = name[:-5]
        try:
            stamp = time.mktime(time.strptime(stem, "%Y-%m-%d"))
        except Exception:
            continue
        if stamp < keep_after:
            try:
                os.remove(os.path.join(folder, name))
                removed.append(name)
            except Exception:
                pass
    return removed


def say(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main(argv):
    global ROOM
    home = None
    day = None
    picks_path = None
    notes = ""
    total = 0
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--home":
            home = argv[i + 1]; i += 2
        elif a == "--day":
            day = argv[i + 1]; i += 2
        elif a == "--picks":
            picks_path = argv[i + 1]; i += 2
        elif a == "--notes":
            notes = argv[i + 1]; i += 2
        elif a == "--total":
            total = int(argv[i + 1]); i += 2
        else:
            i += 1
    if not home:
        say({"ok": False, "error": "缺 --home"})
        return 2
    ROOM = os.path.dirname(os.path.abspath(home))
    if not day or not picks_path:
        say({"ok": False, "error": "缺 --day 或 --picks"})
        return 2

    picks = json.load(open(picks_path, encoding="utf-8"))
    s = requests.Session()
    s.headers.update({"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"})

    out = []
    for p in picks:
        bv = p.get("bvid")
        info = {}
        try:
            d = s.get("https://api.bilibili.com/x/web-interface/view", params={"bvid": bv}, timeout=20).json()
            info = d.get("data") or {}
        except Exception:
            pass
        stat = info.get("stat") or {}
        out.append({
            "bvid": bv,
            "title": info.get("title") or p.get("title") or bv,
            "up": (info.get("owner") or {}).get("name") or p.get("up") or "",
            "play": stat.get("view"),
            "duration": info.get("duration"),
            "cover": info.get("pic") or "",
            "url": "https://www.bilibili.com/video/" + bv,
            "why": p.get("why", ""),
            "mine": p.get("mine", ""),
        })

    outdir = os.path.join(ROOM, "刷B站")
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, day + ".json")

    # 一天可以刷好几轮：往已有的日报里「加」，不覆盖
    old = {}
    if os.path.exists(path):
        try:
            old = json.load(open(path, encoding="utf-8"))
        except Exception:
            old = {}
    old_picks = old.get("picks") or []
    seen = {p.get("bvid") for p in old_picks}
    merged = old_picks + [p for p in out if p.get("bvid") not in seen]
    rounds = (old.get("rounds") or 0) + 1
    fresh_all = [p for p in out if p.get("bvid") not in seen]
    data = {
        "day": day,
        "total": (old.get("total") or 0) + ((total or len(out)) if fresh_all else 0),
        "count": len(merged),
        "picks": merged,
        "notes": "；".join([n for n in [old.get("notes"), notes] if n]),
        "rounds": rounds,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # md 也按轮追加，不覆盖
    import time as _t
    md = os.path.join(outdir, day + ".md")
    fresh = [p for p in out if p.get("bvid") not in {q.get("bvid") for q in old_picks}]
    if fresh:
        lines = []
        if not os.path.exists(md):
            lines.append(f"# {day} 刷B站\n")
        lines.append(f"\n## 第 {rounds} 轮 · {_t.strftime('%H:%M')}（这轮看了 {total or len(out)} 条，新留 {len(fresh)} 条）\n")
        for p in fresh:
            lines.append(f"### {p['bvid']}　{p.get('title') or p['bvid']}")
            lines.append(f"- **为什么值得**：{p.get('why', '')}")
            if p.get("mine"):
                lines.append(f"- **我的一句话**：{p['mine']}")
            lines.append("")
        if notes:
            lines.append(f"- 这轮的账：{notes}\n")
        with open(md, "a", encoding="utf-8") as f:
            f.write("\n".join(lines))

    say({"ok": True, "file": path, "round": rounds, "new": len(fresh), "count": len(merged), "pruned": prune()})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
