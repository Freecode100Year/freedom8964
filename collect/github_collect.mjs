// GitHub Actions 的每日自动采集（.github/workflows/backup.yml 调用）：
// 和网站 Worker 用同一套来源、过滤和核实规则（collect/core.js），但完全在 GitHub 上运行，不依赖 Cloudflare 和任何服务器。
// 网站和人工资料里已有的链接不再收；结果写入 collect/github/，由工作流提交到本仓库。
import fs from "node:fs";
import { SOURCES, MAX_TRIES, collectStep, nyNow } from "./core.js";

const SITE = new URL("..", import.meta.url).pathname;
const OUT = SITE + "collect/github/";
const read = (p, d) => { try { return JSON.parse(fs.readFileSync(SITE + p, "utf8")); } catch { return d; } };
const urls = (l) => (l || []).map((x) => x.url);
const flat = (box) => Object.values(box || {}).flat();
// 每个列表最多保留的条数（只是采集记录，避免文件无限变大）
const KEEP = 2000;

// 已收录：人工整理的资料 + 网站（Cloudflare）自动采集的备份
const known = new Set();
for (const s of read("assets/videos.json", [])) for (const v of s.videos) known.add(`https://www.youtube.com/watch?v=${v.id}`);
for (const s of read("assets/articles.json", [])) for (const a of s.items) known.add(a.url);
for (const u of urls(read("assets/auto.json", {}).cdt)) known.add(u);
const site = Object.fromEntries(["articles", "videos", "cdt_new", "x_new", "topics_new", "wiki_new"].map((k) => [k, read(`collect/kv-backup/${k}.json`, null)]));
for (const k of ["articles", "videos", "cdt_new", "x_new"]) for (const u of urls(site[k])) known.add(u);
for (const u of urls(flat(site.wiki_new))) known.add(u);
const knownTopics = read("assets/topics.json", []).flatMap((t) => urls(t.items)).concat(urls(flat(site.topics_new)));

const db = {
  articles: read("collect/github/articles.json", []), videos: read("collect/github/videos.json", []), cdt_new: read("collect/github/cdt_new.json", []),
  topics_new: read("collect/github/topics_new.json", {}), wiki_new: read("collect/github/wiki_new.json", {}),
  x_new: [], x_seen: [], known: [...known], known_topics: knownTopics,
};
const meta = read("collect/github/meta.json", {});
const today = nyNow().date;
if (meta.day !== today || process.argv.includes("--again")) {
  // 新的一天（或手动要求重跑）：从头读来源；昨天打不开的条目放回队列重试（同网站 Worker）
  meta.day = today; meta.cursor = 0; meta.added = []; meta.errors = []; meta.rejected = [];
  meta.pending = (meta.retry || []).filter((c) => (c.tries || 0) < MAX_TRIES);
  meta.retry = []; meta.srcRetry = [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sub = (u, o = {}, ms = 20000) => fetch(u, { ...o, signal: AbortSignal.timeout(ms) });
for (let i = 0; i < 1000; i++) {
  const r = await collectStep(null, db, meta, today, sub, () => 0);
  if (r.done) break;
  // 只剩读取失败、等待重试（10 分钟后）的来源
  if (meta.cursor >= SOURCES.length && !meta.pending.length && meta.srcRetry.length) {
    await sleep(Math.max(0, Math.min(...meta.srcRetry.map((x) => x.at)) - Date.now()));
  }
}
meta.updated = today;

fs.mkdirSync(OUT, { recursive: true });
const write = (k, v) => fs.writeFileSync(OUT + k + ".json", JSON.stringify(v, null, 1) + "\n");
for (const k of ["articles", "videos", "cdt_new"]) write(k, db[k].slice(0, KEEP));
for (const k of ["topics_new", "wiki_new"]) { for (const g in db[k]) db[k][g] = db[k][g].slice(0, KEEP); write(k, db[k]); }
write("meta", meta);

// 便于在 GitHub 上直接浏览：最近 30 天 GitHub 采集到的新链接（只有标题和网址）
const since = new Date(Date.parse(today) - 30 * 86400000).toISOString().slice(0, 10);
const NAME = { articles: "新闻报道", videos: "视频", cdt_new: "中国数字时代", topics_new: "媒体专题存档", wiki_new: "维基资料" };
const md = (s) => String(s).replace(/([\\[\]])/g, "\\$1");
let page = `# GitHub 每日自动采集\n\n由 GitHub Actions 每天运行 \`collect/github_collect.mjs\`，与网站使用同一套来源白名单和核实规则，` +
  `只记录网站和人工资料里还没有的链接（标题和网址）。最后运行：${today}；读取 ${SOURCES.length} 个来源，失败 ${meta.errors.length} 个。\n`;
for (const k of Object.keys(NAME)) {
  const list = (Array.isArray(db[k]) ? db[k] : flat(db[k])).filter((x) => x.added >= since);
  if (!list.length) continue;
  page += `\n## ${NAME[k]}（最近 30 天 ${list.length} 条）\n\n` + list.map((x) => `- ${x.added} [${md(x.title)}](${x.url})`).join("\n") + "\n";
}
fs.writeFileSync(OUT + "README.md", page);

const summary = [`来源 ${SOURCES.length} 个，今天新收 ${meta.added.length} 条，失败来源 ${meta.errors.length} 个，打不开不收 ${meta.rejected.length} 条`,
  ...meta.added.map((a) => `- ${a.title} ${a.url}`), ...meta.errors.map((e) => `- 失败：${e}`)].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
// 一半以上来源读取失败：让工作流失败（GitHub 会发邮件提醒）
if (meta.errors.length > SOURCES.length / 2) process.exit(1);
