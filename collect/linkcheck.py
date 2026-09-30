#!/usr/bin/env python3
"""每周死链检查：检查报道页、维基资料、影像（oEmbed）和媒体专题存档（抽样）的链接，只报告真正失效的
（404/410、域名解析失败、视频已删除），不理会网站拦截机房服务器造成的 403/429/超时。结果发 Telegram，不自动删除。"""
import json, random, re, subprocess, urllib.error, urllib.parse, urllib.request, concurrent.futures as cf
from pathlib import Path
SITE = Path(__file__).resolve().parent.parent
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36", "Accept": "text/html"}


def check(u):
    try:
        if "youtube.com/watch" in u:
            urllib.request.urlopen("https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(u, safe=""), timeout=25)
        else:
            urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=25)
        return None
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}" if e.code in (404, 410) or ("youtube.com/watch" in u and e.code in (400, 401, 404)) else None
    except urllib.error.URLError as e:
        return "域名失效" if "Name or service not known" in str(e.reason) or "No address" in str(e.reason) else None
    except Exception:
        return None


def main():
    a = json.loads((SITE / "assets/articles.json").read_text())
    v = json.loads((SITE / "assets/videos.json").read_text())
    t = json.loads((SITE / "assets/topics.json").read_text())
    urls = [i["url"] for s in a if not s["key"].startswith("x-") for i in s["items"]]
    urls += [f"https://www.youtube.com/watch?v={x['id']}" for s in v for x in s["videos"]]
    urls += [i["url"] for tp in t for i in random.sample(tp["items"], min(40, len(tp["items"])))]
    urls = list(dict.fromkeys(urls))
    # 维基媒体会限流，慢一点：2 个并发
    with cf.ThreadPoolExecutor(2) as ex:
        bad = [(u, r) for u, r in zip(urls, ex.map(check, urls)) if r]
    # 失效的再确认一次，避免偶发故障
    bad = [(u, r) for u, r in bad if check(u)]
    lines = [f"🔗 freedom8964 每周死链检查：查了 {len(urls)} 个链接，失效 {len(bad)} 个"] + [f"· {r} {u}" for u, r in bad[:30]]
    print("\n".join(lines))
    subprocess.run([str(Path.home() / "bin/tg-send"), "\n".join(lines)])


if __name__ == "__main__":
    main()
