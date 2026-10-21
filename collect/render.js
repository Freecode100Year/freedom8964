// 自动采集结果的网页片段：网站 Worker（访问时插入）和 GitHub Pages 镜像（collect/pages_build.mjs，构建时插入）共用。
import { TOPIC_SOURCES, WIKI_SOURCES, esc } from "./core.js";

const L = {
  zh: { channel: "频道：", articles: "报道", videos: "视频", cdt: "中国数字时代（网站自动采集）", none: "暂无" },
  "zh-hant": { channel: "頻道：", articles: "報道", videos: "視頻", cdt: "中國數字時代（網站自動採集）", none: "暫無" },
  en: { channel: "Channel: ", articles: "Press", videos: "Video", cdt: "China Digital Times (collected by this site)", none: "None yet" },
};
function renderList(items, kind, lang) {
  const l = L[lang];
  const sorted = [...items].sort((a, b) => (b.added + b.date).localeCompare(a.added + a.date)).slice(0, 150);
  const lis = sorted.map((x) => {
    const u = esc(x.url);
    let meta = kind === "videos"
      ? `${l.channel}<a href="${esc(x.channel_url)}" rel="noopener noreferrer" target="_blank">${esc(x.channel)}</a>`
      : esc(x.outlet || (kind === "cdt" ? "中国数字时代" : ""));
    if (x.date) meta += ` · ${esc(x.date)}`;
    return `  <li><div class="t"><a href="${u}" rel="noopener noreferrer" target="_blank">${esc(x.title)}</a></div><div class="c">${meta} · ${u}</div></li>`;
  }).join("\n");
  return `<h2 id="${kind === "cdt" ? "cdt-new" : kind}">${l[kind]} <span class="muted small">${lang === "en" ? ` (${sorted.length})` : `（${sorted.length}）`}</span></h2>\n<ul class="vlist">\n${lis || `  <li class="muted">${l.none}</li>`}\n</ul>`;
}

const NAMES = {};
for (const t of TOPIC_SOURCES) NAMES["topics:" + t.key] = { zh: t.label, en: t.label_en };
for (const w of WIKI_SOURCES) NAMES["wiki:" + w.section] = { zh: w.label, en: w.label_en };
const NEW_HEAD = { zh: "最近自动新增", "zh-hant": "最近自動新增", en: "Recently added automatically" };
const NEW_NOTE = { zh: "网站每天自动采集，每条都打开核实过才加入。", "zh-hant": "網站每天自動採集，每條都打開核實過才加入。", en: "Collected automatically each day; every link was opened and verified before being added." };
const li = (x, src) => {
  const u = esc(x.url);
  return `  <li><div class="t"><a href="${u}" rel="noopener noreferrer" target="_blank">${esc(x.title)}</a></div><div class="c">${esc(src || "")}${x.date ? " · " + esc(x.date) : ""} · ${u}</div></li>`;
};
const GROUP = { cdt: { zh: "中国数字时代", en: "China Digital Times" }, reports: { zh: "X（推特）：#你没看过的六四 系列图片展", en: "X (Twitter): #你没看过的六四" } };
// 页面顶部“最近自动新增”：按来源分组折叠，最新的在前
function renderNew(groups, lang) {
  groups = groups.filter((g) => g.items.length);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (!total) return "";
  const cnt = (n) => (lang === "en" ? ` (${n})` : `（${n}）`);
  const parts = groups.map((g, i) => {
    const items = [...g.items].sort((a, b) => ((b.date || "") + b.added).localeCompare((a.date || "") + a.added));
    return `<details class="year"${i === 0 ? " open" : ""}><summary>${esc(g.label)} <span class="muted small">${cnt(items.length)}</span></summary>\n<ul class="vlist">\n${items.map((x) => li(x, x.outlet || g.label)).join("\n")}\n</ul></details>`;
  });
  return `<h2 id="new">${NEW_HEAD[lang]} <span class="muted small">${cnt(total)}</span></h2>\n<p class="muted small">${NEW_NOTE[lang]}</p>\n${parts.join("\n")}`;
}
function newGroups(page, db, lang) {
  const pick = (n) => (lang === "en" ? n.en : n.zh);
  if (page === "topics" || page === "wiki") {
    const box = page === "topics" ? db.topics_new : db.wiki_new;
    return Object.entries(box).map(([k, items]) => ({ label: pick(NAMES[`${page}:${k}`] || { zh: k, en: k }), items }));
  }
  if (page === "cdt") return [{ label: pick(GROUP.cdt), items: db.cdt_new }];
  if (page === "reports") return [{ label: pick(GROUP.reports), items: db.x_new }];
  return [];
}

export { renderList, renderNew, newGroups };
