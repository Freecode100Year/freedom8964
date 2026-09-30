#!/usr/bin/env python3
"""X（推特）#你没看过的六四 系列图片展：找新帖子，核实后写入 assets/articles.json 的 x-unseen64 分类（只取帖子原文前 70 字和网址）。

X 不开放抓取，只能这样找帖子编号：
  - 互联网档案馆 CDX 里最近存档过的帖子网址（x.com / twitter.com）
  - 192 VPS 上的 syndication 时间线（本机 IP 被限流；经常 429，失败就跳过）
每个编号再用 cdn.syndication.twimg.com/tweet-result 核实：作者在 ACCOUNTS 里，原文含 TAG（转推会返回原帖，按原帖编号去重）。
已核实过的编号记在 .xseen.json，不重复查。
用法：x_series.py [--days N]（默认只查最近 N=21 天的帖子；--dry-run 不写入）
"""
import json
import re
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).parent
SITE = HERE.parent
ARTICLES = SITE / "assets/articles.json"
SEEN = HERE / ".xseen.json"
KEY = "x-unseen64"
TAG = "你没看过的六四"
ACCOUNTS = {"whyyoutouzhele": "李老师不是你老师", "hrichina": "中国人权", "HChina89": "人道中国"}
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"}
EPOCH = 1288834974657  # X 帖子编号里的时间起点（毫秒）


def id_time(i):
    return datetime.fromtimestamp(((int(i) >> 22) + EPOCH) / 1000, timezone.utc)


def get(url, timeout=60):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def candidates(since, log):
    frm = since.strftime("%Y%m%d")

    def cdx(acct, host):
        try:
            txt = get(f"https://web.archive.org/cdx/search/cdx?url={host}/{acct}/status/&matchType=prefix"
                      f"&from={frm}&fl=original&collapse=urlkey&limit=5000", timeout=150)
            return set(re.findall(r"/status/(\d{15,})", txt))
        except Exception as e:
            log.append(f"档案馆 {host}/{acct} 失败：{e}")
            return set()

    def timeline(acct):
        try:
            r = subprocess.run(["ssh", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "root@192.210.133.13",
                                f"curl -s -A '{UA['User-Agent']}' https://syndication.twitter.com/srv/timeline-profile/screen-name/{acct}"],
                               capture_output=True, text=True, timeout=60)
            return set(re.findall(r'"id_str":"(\d{15,})"', r.stdout))
        except Exception:
            return set()

    with ThreadPoolExecutor(8) as ex:
        jobs = [ex.submit(cdx, a, h) for a in ACCOUNTS for h in ("x.com", "twitter.com")]
        jobs += [ex.submit(timeline, a) for a in ACCOUNTS]
        ids = set().union(*(j.result() for j in jobs))
    return {i for i in ids if id_time(i) >= since}


def tweet(i):
    for n in range(3):
        try:
            return json.loads(get(f"https://cdn.syndication.twimg.com/tweet-result?id={i}&token=a", timeout=20) or "{}")
        except Exception:
            time.sleep(2 + n * 3)
    return None


def title_of(text):
    t = re.sub(r"https?://t\.co/\S+", "", text)
    t = re.sub(r"\s+", " ", t.replace("​", "")).strip()
    return t if len(t) <= 70 else t[:70] + "…"


def collect(log, days=21, dry=False, budget=600):
    """返回新收录的条目列表（已写入 articles.json，除非 dry）。"""
    since = datetime.now(timezone.utc) - timedelta(days=days)
    seen = set(json.loads(SEEN.read_text())) if SEEN.exists() else set()
    data = json.loads(ARTICLES.read_text())
    sec = next(s for s in data if s["key"] == KEY)
    have = {re.sub(r"\D", "", a["url"].rsplit("/", 1)[-1]) for s in data for a in s["items"] if "/status/" in a["url"]}
    todo = sorted(candidates(since, log) - seen - have, key=int, reverse=True)  # 先查最新的
    new, failed, left = [], 0, 0
    deadline = time.time() + budget
    with ThreadPoolExecutor(4) as ex:
        for k in range(0, len(todo), 40):
            if time.time() > deadline:  # 超时就留到明天接着查（整个采集服务限时 30 分钟）
                left = len(todo) - k
                break
            for i, j in zip(todo[k:k + 40], ex.map(tweet, todo[k:k + 40])):
                if j is None:
                    failed += 1
                    continue
                seen.add(i)
                sn = (j.get("user") or {}).get("screen_name", "")
                acct = next((a for a in ACCOUNTS if a.lower() == sn.lower()), None)
                i = j.get("id_str", i)  # 转推的编号会返回原帖，用原帖编号去重
                if acct and TAG in j.get("text", "") and i not in have:
                    have.add(i)
                    new.append({"title": title_of(j["text"]), "outlet": f"X · {ACCOUNTS[acct]} @{acct}",
                                "date": j["created_at"][:10], "url": f"https://x.com/{acct}/status/{i}"})
    log.append(f"X #{TAG}：查了 {len(todo)} 条帖子，新收 {len(new)} 条" + (f"，{failed} 条暂时查不到" if failed else "")
               + (f"，{left} 条超时留到明天" if left else ""))
    if dry:
        return new
    if new:
        sec["items"] = sorted(sec["items"] + new, key=lambda a: (a["date"], int(a["url"].rsplit("/", 1)[-1])), reverse=True)
        ARTICLES.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    # 只保留查询窗口内的编号，文件不会越来越大
    SEEN.write_text(json.dumps(sorted(i for i in seen if id_time(i) >= since - timedelta(days=7))))
    return new


if __name__ == "__main__":
    days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 21
    log = []
    for x in collect(log, days, "--dry-run" in sys.argv):
        print(f"+ {x['date']} {x['title']} | {x['url']}")
    print("\n".join(log))
