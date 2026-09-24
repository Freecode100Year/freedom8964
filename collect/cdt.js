// 采集中国数字时代“六四”标签下的文章标题、网址、日期（只取列表页，不读正文）。
// 用法：node cdt.js [页数，默认 2]  → 输出 JSON 到 stdout
const { chromium } = require('playwright');
const TAG = 'https://chinadigitaltimes.net/chinese/tag/%E5%85%AD%E5%9B%9B';
const pages = parseInt(process.argv[2] || '1', 10);
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ locale: 'zh-CN', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' });
  const p = await c.newPage();
  const out = [];
  for (let i = 1; i <= pages; i++) {
    const url = i === 1 ? TAG : `${TAG}/page/${i}`;
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForSelector('article h2.entry-title a', { timeout: 30000 });
    } catch (e) { console.error(`page ${i} failed: ${e.message}`); break; }
    const items = await p.$$eval('article', as => as.map(a => {
      const l = a.querySelector('h2.entry-title a'); const d = a.querySelector('.updated');
      return l ? { title: l.textContent.trim(), url: l.href, date: d ? d.textContent.trim() : '' } : null;
    }).filter(Boolean));
    if (!items.length) break;
    out.push(...items);
    console.error(`page ${i}: ${items.length}`);
    await p.waitForTimeout(4000 + Math.random() * 3000);
  }
  await b.close();
  process.stdout.write(JSON.stringify(out));
})();
