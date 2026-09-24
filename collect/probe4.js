const { chromium } = require('playwright');
(async () => { const b = await chromium.launch(); const c = await b.newContext({ locale:'zh-CN', userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' }); const p = await c.newPage();
  await p.goto('https://chinadigitaltimes.net/chinese/tag/%E5%85%AD%E5%9B%9B', { waitUntil:'domcontentloaded', timeout:60000 }); await p.waitForSelector('article h2.entry-title a', { timeout:40000 });
  for (const u of ['/chinese/tag/%E5%85%AD%E5%9B%9B/page/2/', '/chinese/tag/%E5%85%AD%E5%9B%9B/?paged=2', '/chinese/?tag=%E5%85%AD%E5%9B%9B&paged=3']) {
    const r = await p.goto('https://chinadigitaltimes.net'+u, { waitUntil:'domcontentloaded', timeout:60000 }).catch(e=>null);
    await p.waitForTimeout(5000);
    const t = await p.$$eval('article h2.entry-title a', as=>as.map(a=>a.textContent.slice(0,18))).catch(()=>[]);
    console.log(u, r && r.status(), await p.title(), '|', t.length, t.slice(0,2).join(' / '));
  } await b.close(); })();
