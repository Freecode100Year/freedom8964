import json,sys,urllib.request,urllib.parse,re
ids=re.findall(r"(?<![\w-])([\w-]{11})(?![\w-])", sys.stdin.read())
have={x['id'] for s in json.load(open(str(__import__('pathlib').Path(__file__).resolve().parents[2]/'assets/videos.json'))) for x in s['videos']}
out=[]
for i in dict.fromkeys(ids):
    if i in have: print("HAVE",i); continue
    try:
        d=json.loads(urllib.request.urlopen("https://www.youtube.com/oembed?format=json&url="+urllib.parse.quote(f"https://www.youtube.com/watch?v={i}"),timeout=20).read())
        out.append({"id":i,"title":d["title"],"channel":d["author_name"],"channel_url":d["author_url"]}); print("OK  ",i,d["author_name"],"|",d["title"][:70])
    except Exception as e: print("FAIL",i,e)
json.dump(out,open(sys.argv[1],'w'),ensure_ascii=False,indent=1)
