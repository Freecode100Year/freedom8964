#!/usr/bin/env python3
"""解析已缓存的中国数字时代“六四”相关标签页存档（.wbcache），输出文章标题、网址、日期。只取列表，不读正文。"""
import json, re, html, glob, os
from email.utils import parsedate_to_datetime
ART = r'https?://chinadigitaltimes\.net/chinese/(?:\d{4}/\d{2}/[^"\'<>#?\s/]+(?:\.html|/)|\d+\.html)'
def zh_date(t):
    m = re.search(r'(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日', t)
    if m: return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    m = re.search(r'(\d{1,2})\s*月\s*(\d{1,2})\s*,\s*(\d{4})', t)   # “6 月 1, 2016”
    return f'{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}' if m else ''
def url_date(u):
    m = re.search(r'/chinese/(\d{4})/(\d{2})/', u); return f'{m.group(1)}-{m.group(2)}' if m else ''
out = {}
for f in glob.glob('.wbcache/*'):
    s = open(f, errors='ignore').read()
    if '<rss' in s[:600] or '<channel>' in s[:3000]:
        for it in re.findall(r'<item>(.*?)</item>', s, re.S):
            t = re.search(r'<title>(.*?)</title>', it, re.S); l = re.search(r'<link>(.*?)</link>', it, re.S); d = re.search(r'<pubDate>(.*?)</pubDate>', it, re.S)
            if not (t and l): continue
            url = html.unescape(l.group(1).strip()).replace('http://', 'https://')
            if not re.match(ART, url): continue
            try: date = parsedate_to_datetime(d.group(1).strip()).strftime('%Y-%m-%d') if d else url_date(url)
            except Exception: date = url_date(url)
            out.setdefault(url, {'title': html.unescape(re.sub(r'<!\[CDATA\[|\]\]>', '', t.group(1))).strip(), 'url': url, 'date': date})
        continue
    if 'chinadigitaltimes' not in s: continue
    blocks = re.split(r'<article\b', s)[1:] or []
    got = 0
    for b in blocks:
        m = re.search(r'class="[^"]*entry-title[^"]*"[^>]*>\s*<a[^>]+href="(' + ART + r')"[^>]*>(.*?)</a>', b, re.S)
        if not m: continue
        url = m.group(1).replace('http://', 'https://'); title = html.unescape(re.sub(r'<[^>]+>', '', m.group(2))).strip()
        d = re.search(r'class="[^"]*(?:updated|published|entry-date)[^"]*"[^>]*>(.*?)<', b, re.S)
        date = zh_date(d.group(1)) if d else ''
        date = date or zh_date(re.sub(r'<[^>]+>', ' ', b)) or url_date(url)
        if title: out.setdefault(url, {'title': title, 'url': url, 'date': date}); got += 1
    if got == 0:  # 旧版主题：h2/h3 标题链接
        for m in re.finditer(r'<h[123][^>]*>\s*<a[^>]+href="(' + ART + r')"[^>]*>(.*?)</a>\s*</h[123]>', s, re.S):
            url = m.group(1).replace('http://', 'https://'); title = html.unescape(re.sub(r'<[^>]+>', '', m.group(2))).strip()
            if title: out.setdefault(url, {'title': title, 'url': url, 'date': url_date(url) or zh_date(s[m.end():m.end()+600])})
items = [x for x in out.values() if x['title'] and not x['title'].startswith('http')]
json.dump(items, open('/tmp/cdt-parsed.json', 'w'), ensure_ascii=False, indent=1)
print(len(items), 'articles;', sum(1 for x in items if x['date']), 'with date')
