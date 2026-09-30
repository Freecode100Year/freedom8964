"""用法：verify.py in.tsv out.json   in.tsv：每行 分类\t媒体\t日期\t网址[\t备用标题]
取网页 og:title / <title> 核实链接有效；直连不行就看互联网档案馆有没有存档（有则取存档标题）。"""
import sys,json,re,html,urllib.request,urllib.parse,subprocess,concurrent.futures as cf
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
def get(u,t=30):
    r=urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":UA,"Accept-Language":"zh-CN,zh;q=0.9,en;q=0.8","Accept":"text/html"}),timeout=t)
    return r.geturl(),r.read(600000).decode(r.headers.get_content_charset() or "utf-8","replace")
def title(s):
    for p in [r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)',r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title',r'<title[^>]*>(.*?)</title>']:
        m=re.search(p,s,re.S|re.I)
        if m: return re.sub(r'\s+',' ',html.unescape(m.group(1))).strip()
    return ""
def pubdate(s):
    m=re.search(r'(?:article:published_time|datePublished|pubdate|publish-date)["\']?\s*(?:content=|:)\s*["\']([0-9]{4}-[0-9]{2}-[0-9]{2})',s)
    return m.group(1) if m else ""
def chk(row):
    cat,outlet,date,url=row[:4]; alt=row[4] if len(row)>4 else ""
    how=""
    try:
        fu,s=get(url); t=title(s); how="direct"
        if re.search(r"just a moment|access denied|attention required|403 forbidden|are you a robot|page not found|404",t,re.I): raise Exception("blocked:"+t)
    except Exception as e:
        err=str(e)[:60]; t=""
        try:
            j=json.loads(get("https://archive.org/wayback/available?url="+urllib.parse.quote(url,safe=''),60)[1])
            snap=j.get("archived_snapshots",{}).get("closest",{})
            if snap.get("available") and snap.get("status","200")=="200":
                fu,s=get(snap["url"],90); t=title(s); how="wayback "+snap["timestamp"][:8]
            else: how="FAIL "+err
        except Exception as e2: how="FAIL "+err+" / wb "+str(e2)[:40]
    if not date and how.startswith("direct"): date=pubdate(s)
    return {"cat":cat,"outlet":outlet,"date":date,"url":url,"title":t or alt,"how":how,"alt":alt}
rows=[l.rstrip("\n").split("\t") for l in open(sys.argv[1]) if l.strip() and not l.startswith("#")]
res=list(cf.ThreadPoolExecutor(6).map(chk,rows))
json.dump(res,open(sys.argv[2],"w"),ensure_ascii=False,indent=1)
for r in res: print(f"{r['how'][:16]:16} | {r['cat']} | {r['date']} | {r['title'][:70]} | {r['url'][:80]}")
