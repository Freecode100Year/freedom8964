"""merge.py rN.json [新分类定义.json] —— 把核实通过的条目并入 articles.json（去重、排序）"""
import json,re,sys
SITE=str(__import__("pathlib").Path(__file__).resolve().parents[2]/"assets/articles.json")
SUF=[r"\s*[-|]\s*UPI Archives$",r"\s*\|\s*FRONTLINE.*$",r"\s*\|\s*CNN$",r"\s*\|\s*CBC News$",r"\s*\|\s*兩岸\s*\|\s*中央社 CNA$",r"\s*-\s*BBC News 中文$",r"\s*\|\s*聯合新聞網$",r"\s*-\s*United States Department of State$",r"\s*\|\s*PBS News.*$",r"\s*\|\s*轉角國際 udn Global$",r"\s*\|\s*端傳媒.*$",r"\s*[-|]\s*BBC News$",r"\s*\|\s*Reuters$",r"\s*\|\s*AP News$",r"\s*\|\s*The Guardian$",r"\s*-\s*The New York Times$",r"\s*\|\s*Hong Kong Free Press HKFP$"]
d=json.load(open(SITE)); r=json.load(open(sys.argv[1]))
newcats=json.load(open(sys.argv[2])) if len(sys.argv)>2 else []
by={s['key']:s for s in d}
for c in newcats:
    if c['key'] not in by:
        after=c.pop('after'); i=[s['key'] for s in d].index(after)+1
        c['items']=[]; d.insert(i,c); by[c['key']]=c
have={i['url'].rstrip('/') for s in d for i in s['items']}
n=0
for x in r:
    if not x['how'].startswith(('direct','wayback','192','ok')) or not x['title']: continue
    if x['url'].rstrip('/') in have: continue
    t=x['title']
    for p in SUF: t=re.sub(p,'',t)
    have.add(x['url'].rstrip('/'))
    by[x['cat']]['items'].append({"title":t.strip(),"outlet":x['outlet'],"date":x['date'] if x['date']!='1970-01-01' else '',"url":x['url']}); n+=1
for k,s in by.items():
    if k.startswith(('x-','wiki')): continue
    s['items'].sort(key=lambda i:i['date'] or '0000', reverse=(k!='1989'))
open(SITE,'w').write(json.dumps(d,ensure_ascii=False,indent=1))
print("added",n,{s['key']:len(s['items']) for s in d})
