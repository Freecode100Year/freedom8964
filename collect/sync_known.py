#!/usr/bin/env python3
"""把人工整理的影像、报道链接同步到 Cloudflare KV 的 known，并清掉 KV 里与之重复的自动条目。改了 videos.json / articles.json 后运行。"""
import json, subprocess, tempfile
from pathlib import Path
SITE = Path(__file__).parent.parent
def kv(*args, **kw): return subprocess.run(["npx", "-y", "wrangler", "kv", "key", *args, "--remote", "--binding", "AUTO"], cwd=SITE, capture_output=True, text=True, **kw)
known = set()
for s in json.loads((SITE / "assets/videos.json").read_text()): known |= {f"https://www.youtube.com/watch?v={v['id']}" for v in s["videos"]}
for s in json.loads((SITE / "assets/articles.json").read_text()): known |= {a["url"] for a in s["items"]}
def put(key, data):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f: json.dump(data, f, ensure_ascii=False)
    kv("put", key, "--path", f.name)
put("known", sorted(known))
for key in ("videos", "articles"):
    items = json.loads(kv("get", key).stdout or "[]")
    keep = [x for x in items if x["url"] not in known]
    if len(keep) != len(items): put(key, keep)
    print(key, len(items), "→", len(keep))
print("known", len(known))
