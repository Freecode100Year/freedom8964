const { chromium } = require('playwright');
(async () => { const b = await chromium.launch(); const c = await b.newContext({ locale:'zh-CN', userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' }); const p = await c.newPage();
  await p.goto('https://chinadigitaltimes.net/chinese/tag/%E5%85%AD%E5%9B%9B', { waitUntil:'domcontentloaded', timeout:60000 });
  await p.waitForSelector('article h2.entry-title a', { timeout:40000 });
  const r = await p.evaluate(async () => {
    const t = await (await fetch('/chinese/wp-json/wp/v2/tags/19985')).json().catch(e=>({err:String(e)}));
    const res = await fetch('/chinese/wp-json/wp/v2/posts?tags=19985&per_page=5&page=1&_fields=title,link,date');
    return { tag: t && (t.name+' '+t.count), total: res.headers.get('X-WP-Total'), pages: res.headers.get('X-WP-TotalPages'), first: (await res.json()).map(x=>x.date+' '+x.title.rendered) };
  });
  console.log(JSON.stringify(r,null,1)); await b.close(); })();
