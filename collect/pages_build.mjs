// GitHub Pages 镜像（.github/workflows/backup.yml 在每日采集后调用）：
// 把 build.py 生成的 dist/ 复制到 _site/，在构建时插入自动采集结果（网站 Worker 是访问时插入），
// 数据 = 网站采集的备份（collect/kv-backup/）+ GitHub 自己采集的（collect/github/），按网址去重。
// 用法：python3 build.py && node collect/pages_build.mjs <网址前缀，如 /freedom8964.com>
import fs from "node:fs";
import { esc } from "./core.js";
import { renderList, renderNew, newGroups } from "./render.js";

const SITE = new URL("..", import.meta.url).pathname;
const BASE = (process.argv[2] || "").replace(/\/$/, "");
const OUT = SITE + "_site/";
const MAIN = "https://freedom8964.com";
const read = (p, d) => { try { return JSON.parse(fs.readFileSync(SITE + p, "utf8")); } catch { return d; } };

// 合并两份采集结果（同一网址只留一条，网站的优先）
const both = (k, d) => [read(`collect/kv-backup/${k}.json`, d), read(`collect/github/${k}.json`, d)];
const uniq = (lists) => { const seen = new Set(); return lists.flat().filter((x) => !seen.has(x.url) && seen.add(x.url)); };
const db = { meta: read("collect/kv-backup/meta.json", {}), x_new: read("collect/kv-backup/x_new.json", []) };
for (const k of ["articles", "videos", "cdt_new"]) db[k] = uniq(both(k, []));
for (const k of ["topics_new", "wiki_new"]) {
  const [a, b] = both(k, {});
  db[k] = {};
  for (const g of new Set([...Object.keys(a), ...Object.keys(b)])) db[k][g] = uniq([a[g] || [], b[g] || []]);
}
const gm = read("collect/github/meta.json", {});
const updated = [db.meta.updated || "", gm.updated || ""].sort().pop();

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SITE + "dist/", OUT, { recursive: true });
for (const f of ["_headers", "_redirects"]) fs.rmSync(OUT + f, { force: true }); // Cloudflare 专用
fs.writeFileSync(OUT + ".nojekyll", "");

const NOTE = {
  zh: `这是 freedom8964.com 在 GitHub Pages 上的镜像，每天随 GitHub 自动采集更新。主站：<a href="${MAIN}/">freedom8964.com</a>`,
  "zh-hant": `這是 freedom8964.com 在 GitHub Pages 上的鏡像，每天隨 GitHub 自動採集更新。主站：<a href="${MAIN}/zh-hant/">freedom8964.com</a>`,
  en: `This is the GitHub Pages mirror of freedom8964.com, updated daily by GitHub's automatic collection. Main site: <a href="${MAIN}/en/">freedom8964.com</a>`,
};
// 网站用 _headers 下发的安全策略，Pages 不支持自定义响应头，用 meta 代替（frame-ancestors 等只能用响应头，无法设置）
const META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'">\n<meta name="referrer" content="no-referrer">\n`;

let n = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = dir + e.name;
    if (e.isDirectory()) { if (e.name !== "assets") walk(p + "/"); continue; }
    if (!e.name.endsWith(".html")) continue;
    const rel = p.slice(OUT.length);
    const lang = rel.startsWith("en/") ? "en" : rel.startsWith("zh-hant/") ? "zh-hant" : "zh";
    const page = e.name.replace(/\.html$/, "");
    let html = fs.readFileSync(p, "utf8");
    if (page === "latest") {
      html = html.replace("<!--AUTO-ARTICLES-->", renderList(db.articles, "articles", lang))
                 .replace("<!--AUTO-VIDEOS-->", renderList(db.videos, "videos", lang))
                 .replace("<!--AUTO-CDT-->", db.cdt_new.length ? renderList(db.cdt_new, "cdt", lang) : "")
                 .replace("<!--AUTO-UPDATED-->", esc(updated));
    } else if (["topics", "wiki", "cdt", "reports"].includes(page)) {
      html = html.replace('<div id="auto-new"></div>', `<div id="auto-new">${renderNew(newGroups(page, db, lang), lang)}</div>`);
    }
    // 语言切换和自动跳转留在镜像里；规范网址（canonical）仍指向主站
    html = html.replace(/(href|src)="\/(?!\/)/g, `$1="${BASE}/`)
               .replace(/(<link rel="alternate"[^>]*href=")https:\/\/freedom8964\.com\//g, `$1${BASE}/`)
               .replace("<head>", "<head>\n" + META)
               .replace('<footer class="site-foot">\n  <div class="wrap">', `<footer class="site-foot">\n  <div class="wrap">\n    <p>${NOTE[lang]}</p>`);
    fs.writeFileSync(p, html);
    n++;
  }
};
walk(OUT);
console.log(`GitHub Pages 镜像：${n} 个页面 → _site/（采集数据更新于 ${updated}）`);
