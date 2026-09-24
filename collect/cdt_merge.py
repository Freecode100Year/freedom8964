#!/usr/bin/env python3
"""把存档解析出的中国数字时代历史文章并入 assets/auto.json 的 cdt（标记 added=archive），然后构建、部署、提交。"""
import json, subprocess
from pathlib import Path
SITE = Path(__file__).parent.parent
auto = json.loads((SITE / 'assets/auto.json').read_text())
have = {x['url'] for x in auto['cdt']}
new = [dict(x, outlet='中国数字时代', added='archive') for x in json.load(open('/tmp/cdt-parsed.json')) if x['url'] not in have]
auto['cdt'] += new
(SITE / 'assets/auto.json').write_text(json.dumps(auto, ensure_ascii=False, indent=1))
print('merged', len(new), 'total', len(auto['cdt']))
for cmd in (['python3', 'build.py'], ['npx', '-y', 'wrangler', 'deploy'], ['git', 'add', '-A'],
            ['git', '-c', 'user.name=freedom8964', '-c', 'user.email=noreply@freedom8964.com', 'commit', '-qm', f'中国数字时代历史文章 {len(new)} 篇（整理自互联网档案馆存档）']):
    subprocess.run(cmd, cwd=SITE, check=True)
years = sorted({x['date'][:4] for x in auto['cdt'] if x.get('date')})
subprocess.run([str(Path.home() / 'bin/tg-send'), f"🕯️ 中国数字时代历史文章整理完成：新增 {len(new)} 篇，共 {len(auto['cdt'])} 篇（{years[0]}–{years[-1]}）\nhttps://freedom8964.com/cdt"])
