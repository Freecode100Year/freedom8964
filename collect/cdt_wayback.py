#!/usr/bin/env python3
"""从互联网档案馆存档的中国数字时代“六四”相关标签页/订阅源中，提取文章标题、网址、日期（不读正文）。"""
import json, re, html, time, urllib.request, urllib.parse
from email.utils import parsedate_to_datetime
UA = {'User-Agent': 'freedom8964-archive-collector (+https://freedom8964.com)'}
import os, hashlib
CACHE = '/home/claude/sites/freedom8964/collect/.wbcache'; os.makedirs(CACHE, exist_ok=True)
def get(u, t=60, tries=6):
    f = os.path.join(CACHE, hashlib.md5(u.encode()).hexdigest())
    if os.path.exists(f): return open(f).read()
    for k in range(tries):
        try:
            s = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=t).read().decode('utf-8', 'ignore')
            open(f, 'w').write(s); time.sleep(6); return s
        except urllib.error.HTTPError as e:
            if e.code == 404: raise
            time.sleep(30 * (k + 1))
        except Exception:
            time.sleep(30 * (k + 1))
    raise Exception('gave up')
cdx = json.loads(get('https://web.archive.org/cdx/search/cdx?url=chinadigitaltimes.net/chinese/tag/%E5%85%AD%E5%9B%9B*&output=json&fl=timestamp,original&filter=statuscode:200&collapse=urlkey&limit=5000', 120))[1:]
rows = [(ts, u) for ts, u in cdx if '?category=' not in u and 'view=all' not in u]
print('snapshots', len(rows))
ART = re.compile(r'https?://chinadigitaltimes\.net/chinese/(?:\d{4}/\d{2}/[^"\'<>#?\s]+\.html|\d+\.html)')
out = {}
for i, (ts, u) in enumerate(rows):
    try:
        s = get(f'https://web.archive.org/web/{ts}id_/{u}')
    except Exception as e:
        print('fail', u, e); continue
    tag = urllib.parse.unquote(re.search(r'/tag/([^/?]+)', u).group(1))
    n = 0
    if '<rss' in s[:500] or '<channel>' in s:
        for it in re.findall(r'<item>(.*?)</item>', s, re.S):
            t = re.search(r'<title>(.*?)</title>', it, re.S); l = re.search(r'<link>(.*?)</link>', it, re.S); d = re.search(r'<pubDate>(.*?)</pubDate>', it, re.S)
            if t and l:
                url = html.unescape(l.group(1).strip()); title = html.unescape(re.sub(r'<!\[CDATA\[|\]\]>', '', t.group(1))).strip()
                date = parsedate_to_datetime(d.group(1).strip()).strftime('%Y-%m-%d') if d else ''
                out.setdefault(url, {'title': title, 'url': url, 'date': date, 'tag': tag}); n += 1
    else:
        # 只取文章标题位置的链接：h2/h3 标题里的链接
        for m in re.finditer(r'<h[23][^>]*>\s*<a[^>]+href="(' + ART.pattern + r')"[^>]*>(.*?)</a>', s, re.S):
            url = m.group(1).replace('http://', 'https://'); title = html.unescape(re.sub(r'<[^>]+>', '', m.group(2))).strip()
            if title:
                d = re.search(r'/chinese/(\d{4})/(\d{2})/', url)
                out.setdefault(url, {'title': title, 'url': url, 'date': f'{d.group(1)}-{d.group(2)}' if d else '', 'tag': tag}); n += 1
    print(f'{i+1}/{len(rows)} {tag} {n}', flush=True)
json.dump(list(out.values()), open('/tmp/cdt-wayback.json', 'w'), ensure_ascii=False, indent=1)
print('articles', len(out))
