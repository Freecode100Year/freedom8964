#!/usr/bin/env python3
"""维基资料自动更新：按 articles.json 里各维基分类的 wiki_sync 设置（站点、分类、排除名单），
通过维基媒体官方接口读取分类成员，把新条目加进去（只加不删；已删除的条目由每周死链检查报告）。"""
import json, time, urllib.parse, urllib.request
from pathlib import Path
ARTICLES = Path(__file__).resolve().parent.parent / "assets/articles.json"
UA = {"User-Agent": "freedom8964-link-check/1.0 (https://freedom8964.com)"}
OUTLET = {"zh.wikipedia.org": "维基百科 Wikipedia", "en.wikipedia.org": "Wikipedia", "zh.wikisource.org": "维基文库 Wikisource"}


def api(host, params, post=False):
    q = urllib.parse.urlencode({**params, "format": "json"})
    req = urllib.request.Request(f"https://{host}/w/api.php", data=q.encode(), headers=UA) if post else \
        urllib.request.Request(f"https://{host}/w/api.php?{q}", headers=UA)
    time.sleep(1)  # 维基媒体限流，慢一点
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def members(host, cat):
    out, cont = [], {}
    while True:
        d = api(host, {"action": "query", "list": "categorymembers", "cmtitle": cat, "cmlimit": 500, "cmnamespace": 0, **cont})
        out += [m["title"] for m in d["query"]["categorymembers"]]
        if "continue" not in d:
            return out
        cont = {"cmcontinue": d["continue"]["cmcontinue"]}


def sync(log):
    data = json.loads(ARTICLES.read_text())
    added = []
    for sec in data:
        cfg = sec.get("wiki_sync")
        if not cfg:
            continue
        host = cfg["host"]
        have = {urllib.parse.unquote(i["url"].split("/wiki/", 1)[1]).replace("_", " ") for i in sec["items"] if "/wiki/" in i["url"]}
        try:
            titles = [t for c in cfg["cats"] for t in members(host, c)]
        except Exception as e:
            log.append(f"维基 {sec['key']} 读取失败：{e}")
            continue
        new = [t for t in dict.fromkeys(titles) if t not in have and t not in cfg.get("exclude", [])]
        for i in range(0, len(new), 15):
            d = api(host, {"action": "query", "titles": "|".join(new[i:i + 15]), "prop": "info", "inprop": "varianttitles"}, post=True)
            for p in d["query"]["pages"].values():
                if "missing" in p:
                    continue
                title = p.get("varianttitles", {}).get("zh-cn", p["title"]) if host.startswith("zh.") else p["title"]
                x = {"title": title, "outlet": OUTLET.get(host, host), "date": "",
                     "url": f"https://{host}/wiki/" + urllib.parse.quote(p["title"].replace(" ", "_"), safe="()',")}
                sec["items"].append(x)
                added.append(x)
    if added:
        ARTICLES.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    log.append(f"维基资料：新增 {len(added)} 个条目")
    return added


if __name__ == "__main__":
    log = []
    for x in sync(log):
        print("+", x["title"], x["url"])
    print("\n".join(log))
