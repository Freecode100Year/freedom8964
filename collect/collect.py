#!/usr/bin/env python3
"""每日自动采集中国数字时代“六四”标签的新文章标题和网址（新闻、YouTube 已改由 Cloudflare Worker 采集）（不读正文），写入 assets/auto.json；
X #你没看过的六四 系列新帖（x_series.py）写入 assets/articles.json；Cloudflare 采集结果（KV）备份到 collect/kv-backup/。
然后构建、部署、提交（提交后 .git/hooks/post-commit 自动推送 GitHub），并用 Telegram 汇报。

来源（全部是白名单）：
  - 中国数字时代“六四”标签第一页（用浏览器打开，cdt.js）
  - 影像栏目已收录的 YouTube 官方频道的最新视频（频道 RSS，channels.json），视频再经 oEmbed 核实
  - 主流媒体订阅源（FEEDS）
只收标题含关键词的条目；已收录过的网址（含人工整理的 videos.json / articles.json）不重复收。
用法：collect.py [--dry-run] [--no-deploy]
"""
import html
import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import x_series

HERE = Path(__file__).parent
SITE = HERE.parent
AUTO = SITE / "assets/auto.json"
LOG = HERE / "collect.log"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"}

KEYWORDS = re.compile(
    r"六四|6\.?4|天安门|天安門|8964|八九|坦克人|天安门母亲|天安門母親|支联会|支聯會|维园|維園|黄雀行动|黃雀行動|"
    r"邹幸彤|鄒幸彤|李卓人|何俊仁|丁子霖|国殇之柱|國殤之柱|"
    r"tiananmen|june 4(th)?\b|june fourth|tank man|hong kong alliance|victoria park vigil|"
    r"chow hang[- ]tung|lee cheuk[- ]yan|ding zilin|pillar of shame",
    re.I)
# “6.4”（6.4 级地震）、“维园”（维园网球场）这类容易误伤，只有它们时还要求同时出现其他关键词
WEAK = re.compile(r"^(6\.?4|八九|维园|維園|june 4)$")

FEEDS = json.loads((HERE / "feeds.json").read_text())  # 与 worker.js 共用


def get(url, timeout=30):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read().decode("utf-8", "ignore")


def excluded():
    f = HERE / "exclude.txt"
    return [l.strip() for l in f.read_text().splitlines() if l.strip() and not l.startswith("#")] if f.exists() else []


def normalize(url):
    """去掉 utm_*、at_* 之类的跟踪参数。"""
    u = urllib.parse.urlparse(url)
    q = [(k, v) for k, v in urllib.parse.parse_qsl(u.query) if not re.match(r"(utm_|at_|fbclid|gclid)", k)]
    return urllib.parse.urlunparse(u._replace(query=urllib.parse.urlencode(q)))


def relevant(title):
    hits = {m.group(0).lower() for m in KEYWORDS.finditer(title)}
    return bool(hits) and not all(WEAK.match(h) for h in hits)


def clean(t):
    return html.unescape(re.sub(r"<!\[CDATA\[|\]\]>|<[^>]+>", "", t)).strip()


def parse_feed(xml):
    """RSS <item> 或 Atom <entry> → [(标题, 网址, 日期)]"""
    out = []
    for it in re.findall(r"<item\b.*?</item>|<entry\b.*?</entry>", xml, re.S):
        t = re.search(r"<title[^>]*>(.*?)</title>", it, re.S)
        l = re.search(r"<link>(.*?)</link>", it, re.S) or re.search(r'<link[^>]+href="([^"]+)"', it)
        d = re.search(r"<pubDate>(.*?)</pubDate>|<published>(.*?)</published>|<dc:date>(.*?)</dc:date>", it, re.S)
        if not (t and l):
            continue
        date = ""
        if d:
            raw = next(g for g in d.groups() if g).strip()
            try:
                date = parsedate_to_datetime(raw).strftime("%Y-%m-%d")
            except Exception:
                date = raw[:10]
        out.append((clean(t.group(1)), normalize(clean(l.group(1))), date))
    return out


def known_urls():
    urls = set()
    for s in json.loads((SITE / "assets/videos.json").read_text()):
        urls |= {f"https://www.youtube.com/watch?v={v['id']}" for v in s["videos"]}
    for s in json.loads((SITE / "assets/articles.json").read_text()):
        urls |= {a["url"] for a in s["items"]}
    return urls


def collect_cdt(log):
    try:
        r = subprocess.run(["node", str(HERE / "cdt.js"), "1"], capture_output=True, text=True, timeout=300, cwd=HERE)
        items = json.loads(r.stdout or "[]")
    except Exception as e:
        log.append(f"中国数字时代 采集失败：{e}")
        return []
    if not items:
        # 0 条通常是遇到了真人验证或网页改版；只记录，不重试、不绕过
        log.append(f"中国数字时代 0 条（可能遇到验证页）：{(r.stderr or '').strip()[-150:]}")
        subprocess.run([str(Path.home() / "bin/tg-send"), "⚠️ freedom8964：中国数字时代今天没取到文章（可能遇到真人验证），明天会再试一次"])
        return []
    out = []
    for it in items:
        m = re.match(r"(\d{4})年\s*(\d{1,2})\s*月\s*(\d{1,2})日", it.get("date", ""))
        date = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}" if m else ""
        out.append({"title": it["title"], "url": it["url"], "date": date, "outlet": "中国数字时代"})
    log.append(f"中国数字时代：{len(out)} 条")
    return out


def collect_youtube(log):
    chans = json.loads((HERE / "channels.json").read_text())
    out = []
    for cid, c in chans.items():
        try:
            for title, url, date in parse_feed(get(f"https://www.youtube.com/feeds/videos.xml?channel_id={cid}")):
                if relevant(title):
                    out.append({"title": title, "url": url, "date": date, "channel": c["name"], "channel_url": c["url"]})
        except Exception as e:
            log.append(f"YouTube {c['name']} 失败：{e}")
    # oEmbed 核实：视频存在、公开，标题与频道以官方为准
    ok = []
    for v in out:
        try:
            d = json.loads(get("https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(v["url"])))
            v["title"], v["channel"], v["channel_url"] = d["title"], d["author_name"], d["author_url"]
            v["id"] = urllib.parse.parse_qs(urllib.parse.urlparse(v["url"]).query)["v"][0]
            ok.append(v)
        except Exception:
            pass
    log.append(f"YouTube：{len(ok)} 条相关（{len(chans)} 个频道）")
    return ok


def collect_feeds(log):
    out = []
    for outlet, url in FEEDS:
        try:
            n = 0
            for title, link, date in parse_feed(get(url)):
                if relevant(title):
                    out.append({"title": title, "url": link, "date": date, "outlet": outlet})
                    n += 1
        except Exception as e:
            log.append(f"{outlet} 失败：{e}")
    log.append(f"新闻订阅源：{len(out)} 条相关（{len(FEEDS)} 个来源）")
    return out


TOPICS = SITE / "assets/topics.json"


def collect_topics(log, today):
    """媒体专题存档（assets/topics.json）：读取各新闻机构六四专题栏目第一页，把新文章（标题、日期、网址）加进去。"""
    if not TOPICS.exists():
        return []
    topics = json.loads(TOPICS.read_text())
    added = []
    for t in topics:
        if t.get("wp"):  # WordPress 网站：按标签读取最新文章
            have = {x["url"] for x in t["items"]}
            for tag in t["wp"]["tags"]:
                try:
                    posts = json.loads(get(f'{t["wp"]["base"]}/wp-json/wp/v2/posts?tags={tag}&per_page=20&_fields=link,title,date'))
                except Exception as e:
                    log.append(f"{t['name']} 读取失败：{e}")
                    break
                for p in posts:
                    if p["link"] in have:
                        continue
                    x = {"title": clean(p["title"]["rendered"]), "date": p["date"][:10], "url": p["link"]}
                    t["items"].insert(0, x)
                    have.add(p["link"])
                    added.append(x)
            continue
        base = t.get("pangea")  # 美国之音系网站（Pangea 平台）的专题栏目
        if not base:
            continue
        try:
            s = get(t["source"])
        except Exception as e:
            log.append(f"{t['name']} 读取失败：{e}")
            continue
        have = {x["url"] for x in t["items"]}
        for m in re.finditer(r'<a href="(/a/[^"]+\.html)"[^>]*title="([^"]+)"', s):
            url = base + m.group(1)
            if url in have:
                continue
            dm = re.search(r'class="date[^"]*"[^>]*>([^<]+)<', s[m.end():m.end() + 4000])
            dd = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", html.unescape(dm.group(1))) if dm else None
            date = f"{dd.group(1)}-{int(dd.group(2)):02d}-{int(dd.group(3)):02d}" if dd else today
            x = {"title": html.unescape(m.group(2)).strip(), "date": date, "url": url}
            t["items"].insert(0, x)
            have.add(url)
            added.append(x)
    if added:
        TOPICS.write_text(json.dumps(topics, ensure_ascii=False, indent=1))
    log.append(f"媒体专题存档：新增 {len(added)} 篇")
    return added


def backup_kv(log):
    """把 Cloudflare Worker 采集的数据（KV）存一份到 collect/kv-backup/，随仓库推到 GitHub。"""
    out = HERE / "kv-backup"
    out.mkdir(exist_ok=True)
    for k in ("articles", "videos", "meta"):
        data = None
        for _ in range(3):  # wrangler 偶尔第一次读取失败，重试
            r = subprocess.run(["npx", "-y", "wrangler", "kv", "key", "get", "--remote",
                                "--namespace-id=740ce332e0b3484ba516b21b6cb00937", k],
                               cwd=SITE, capture_output=True, text=True, timeout=120)
            try:
                data = json.loads(r.stdout)
                break
            except ValueError:
                pass
        if data is None:
            log.append(f"KV {k} 备份失败")
            continue
        (out / f"{k}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1))


def main():
    dry = "--dry-run" in sys.argv
    today = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d")
    auto = json.loads(AUTO.read_text()) if AUTO.exists() else {"videos": [], "articles": [], "cdt": []}
    seen = known_urls() | {x["url"] for k in auto for x in auto[k]}
    log = []
    # 新闻订阅源和 YouTube 已改由 Cloudflare Worker（worker.js）每天自动采集；这里只采集需要真浏览器打开的中国数字时代
    found = {"cdt": collect_cdt(log)}
    added = {}
    ex = excluded()
    for k, items in found.items():
        new = [dict(x, added=today) for x in items
               if x["url"] not in seen and not any(e in x["url"] or e in x["title"] for e in ex)]
        for x in new:
            seen.add(x["url"])
        auto[k] = new + auto[k]
        added[k] = new
    added["topics"] = [] if dry else collect_topics(log, today)
    try:
        added["x"] = [] if dry else x_series.collect(log)
    except Exception as e:
        log.append(f"X 系列图片展失败：{e}")
    total = sum(len(v) for v in added.values())
    stamp = datetime.now().strftime("%F %T")
    with LOG.open("a") as f:
        f.write(f"[{stamp}] 新增 {total}：" + "；".join(log) + "\n")
        for k, v in added.items():
            for x in v:
                f.write(f"    + [{k}] {x['title']} | {x['url']}\n")
    print("\n".join(log))
    for k, v in added.items():
        for x in v:
            print(f"+ [{k}] {x['title']} | {x['url']}")
    if dry:
        print("dry-run，不写入")
        return
    AUTO.write_text(json.dumps(auto, ensure_ascii=False, indent=1))
    backup_kv(log)
    if "--no-deploy" in sys.argv:
        return
    changed = [l[3:] for l in subprocess.run(["git", "status", "--porcelain"], cwd=SITE, capture_output=True, text=True).stdout.splitlines()]
    if not changed:
        print("没有新条目")
        return
    # 只有 collect/ 下的备份变了就不用重新构建部署网站
    site_changed = any(not f.startswith("collect/") for f in changed)
    steps = ([["python3", "build.py"], ["npx", "-y", "wrangler", "deploy"]] if site_changed else []) + [
             ["git", "add", "-A"], ["git", "-c", "user.name=freedom8964", "-c", "user.email=noreply@freedom8964.com", "commit", "-qm", f"自动采集 {today}：新增 {total} 条" if total else f"备份 Cloudflare 采集数据 {today}"]]  # 提交后由 .git/hooks/post-commit 自动推送 GitHub
    for cmd in steps:
        r = subprocess.run(cmd, cwd=SITE, capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            subprocess.run([str(Path.home() / "bin/tg-send"), f"⚠️ freedom8964 自动采集：{' '.join(cmd[:3])} 失败\n{(r.stderr or r.stdout)[-500:]}"])
            return
    if total == 0:
        return
    names = {"cdt": "中国数字时代", "x": "X #你没看过的六四", "topics": "媒体专题存档"}
    lines = [f"🕯️ freedom8964 今日自动收录 {total} 条："]
    for k, v in added.items():
        for x in v[:15]:
            lines.append(f"· [{names[k]}] {x['title']}")
    if added.get("cdt"):
        lines.append("https://freedom8964.com/latest")
    if added.get("topics"):
        lines.append("https://freedom8964.com/topics")
    if added.get("x"):
        lines.append("https://freedom8964.com/reports#x-unseen64")
    subprocess.run([str(Path.home() / "bin/tg-send"), "\n".join(lines)])


if __name__ == "__main__":
    main()
