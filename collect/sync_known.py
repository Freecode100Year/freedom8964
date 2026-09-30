#!/usr/bin/env python3
"""同步 Cloudflare 采集用的资料：
  1. 生成 collect/topic_sources.json（媒体专题来源）和 collect/wiki_sources.json（维基分类），供 worker.js 打包（需重新部署）
  2. 把人工整理的影像、报道、维基链接同步到 KV 的 known，专题存档链接同步到 known_topics，并清掉 KV 里与之重复的自动条目
改了 videos.json / articles.json / topics.json 后运行（--no-kv 只生成文件）。"""
import json, re, subprocess, sys, tempfile
from pathlib import Path
SITE = Path(__file__).parent.parent
HERE = SITE / "collect"
PTS_KEYWORDS = r"六四|天安門|天安门|八九|89|支聯會|民運|維園|悼念|坦克|丁子霖|母親|紀念|周年|週年|屠殺|鄒幸彤|李卓人|王丹|吾爾開希|趙紫陽|胡耀邦|何俊仁|國殤"
OUTLET = {"zh.wikipedia.org": "维基百科 Wikipedia", "en.wikipedia.org": "Wikipedia", "zh.wikisource.org": "维基文库 Wikisource"}

articles = json.loads((SITE / "assets/articles.json").read_text())
videos = json.loads((SITE / "assets/videos.json").read_text())
topics = json.loads((SITE / "assets/topics.json").read_text())

ts = []
for t in topics:
    base = {"key": t["key"], "label": t["name"], "label_en": t["name_en"]}
    if t.get("wp"):
        for tag in t["wp"]["tags"]:
            ts.append({**base, "name": f'{t["name"]}（标签 {tag}）', "type": "wp", "url": f'{t["wp"]["base"]}/wp-json/wp/v2/posts?tags={tag}&per_page=20&_fields=link,title,date'})
    elif t.get("pangea"):
        ts.append({**base, "name": t["name"], "type": "pangea", "base": t["pangea"], "url": t["source"]})
    elif t.get("html"):
        ts.append({**base, "name": t["name"], "type": t["html"], "url": t["source"], **({"keywords": PTS_KEYWORDS} if t["html"] == "pts" else {})})
(HERE / "topic_sources.json").write_text(json.dumps(ts, ensure_ascii=False, indent=1))

ws = []
for s in articles:
    c = s.get("wiki_sync")
    if c:
        for cat in c["cats"]:
            ws.append({"section": s["key"], "host": c["host"], "cat": cat, "exclude": c.get("exclude", []), "outlet": OUTLET[c["host"]],
                       "label": s["heading"], "label_en": s["heading_en"]})
(HERE / "wiki_sources.json").write_text(json.dumps(ws, ensure_ascii=False, indent=1))
print("topic_sources", len(ts), "wiki_sources", len(ws))
if "--no-kv" in sys.argv:
    sys.exit()


def kv(*args, **kw): return subprocess.run(["npx", "-y", "wrangler", "kv", "key", *args, "--remote", "--binding", "AUTO"], cwd=SITE, capture_output=True, text=True, **kw)
def put(key, data):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f: json.dump(data, f, ensure_ascii=False)
    r = kv("put", key, "--path", f.name)
    if r.returncode: raise SystemExit(f"KV 写入 {key} 失败：{r.stderr[-300:]}")
def get(key):
    for _ in range(3):
        r = kv("get", key)
        try: return json.loads(r.stdout)
        except ValueError: pass
    return None

known = set()
for s in videos: known |= {f"https://www.youtube.com/watch?v={v['id']}" for v in s["videos"]}
for s in articles: known |= {a["url"] for a in s["items"]}
put("known", sorted(known))
put("known_topics", sorted({x["url"] for t in topics for x in t["items"]}))
for key in ("videos", "articles"):
    items = get(key)
    if items is None: continue
    keep = [x for x in items if x["url"] not in known]
    if len(keep) != len(items): put(key, keep)
    print(key, len(items), "→", len(keep))
print("known", len(known))
