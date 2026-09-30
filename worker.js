// freedom8964.com 的 Cloudflare Worker：
//  1. 网站自己每天定时采集（美东凌晨 3 点开始，由 Durable Object 闹钟驱动，每分钟处理一批来源）：
//     白名单新闻订阅源 + 影像栏目已收录的 YouTube 官方频道，只取标题和网址，关键词过滤，视频经 oEmbed 核实。
//     结果存在 KV（F8964_AUTO），不依赖 VPS。
//     另外采集媒体专题栏目（topic_sources.json）和维基分类（wiki_sources.json）的新条目。
//     所有新条目先实际打开核实（网页返回 200、视频经 oEmbed），打不开的次日重试，连续 3 天打不开就不收。
//  2. “最新收录”页（/latest）在返回时把 KV 里的条目填进静态页面；“媒体专题存档”（/topics）和“维基资料”（/wiki）
//     在页面顶部插入尚未并入静态页面的新条目。
//  其他所有请求直接交给静态资源。
import { DurableObject } from "cloudflare:workers";
import channels from "./collect/channels.json";
import playlists from "./collect/playlists.json"; // 官方频道的六四专题播放列表（本身就是六四内容，不做关键词过滤）

import FEEDS from "./collect/feeds.json"; // 新闻订阅源白名单：[名称, 网址]
import TOPIC_SOURCES from "./collect/topic_sources.json"; // 媒体专题存档的来源（由 sync_known.py 从 assets/topics.json 生成）
import WIKI_SOURCES from "./collect/wiki_sources.json"; // 维基资料的分类（由 sync_known.py 从 assets/articles.json 生成）
const UA = { "User-Agent": "Mozilla/5.0 (compatible; freedom8964-collector; +https://freedom8964.com/about)" };
const SOURCES = [
  ...FEEDS.map(([name, url]) => ({ kind: "articles", name, url })),
  ...TOPIC_SOURCES.map((t) => ({ kind: "topics", ...t })),
  ...WIKI_SOURCES.map((w) => ({ kind: "wiki", name: `${w.host} ${w.cat}`, url: `https://${w.host}/w/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent(w.cat)}&cmlimit=500&cmnamespace=0&format=json`, ...w })),
  ...Object.entries(channels).map(([id, c]) => ({
    kind: "videos", name: c.name, channel_url: c.url, url: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
  })),
  ...Object.entries(playlists).map(([id, p]) => ({
    kind: "videos", name: p.name, channel_url: p.url, url: `https://www.youtube.com/feeds/videos.xml?playlist_id=${id}`, trusted: true,
  })),
];
const BATCH = 5;
// 每次闹钟最多发出的子请求数（Workers 免费版每次调用上限 50）
const BUDGET = 40;
// 核实失败（打不开）的条目最多重试几天
const MAX_TRIES = 3;

const KEYWORDS = /六四|6\.?4|天安门|天安門|8964|八九|坦克人|支联会|支聯會|维园|維園|黄雀行动|黃雀行動|邹幸彤|鄒幸彤|李卓人|何俊仁|丁子霖|国殇之柱|國殤之柱|tiananmen|june 4(th)?\b|june fourth|tank man|hong kong alliance|victoria park vigil|chow hang[- ]tung|lee cheuk[- ]yan|ding zilin|pillar of shame/gi;
const WEAK = /^(6\.?4|八九|维园|維園|june 4)$/;
// 不自动收录（误收）：网址或标题包含这些字符串
const EXCLUDE = [
  "https://www.youtube.com/watch?v=MnYREEJgqtE", // 柴静《王洪文》下集：1976 年天安门事件
  "https://www.youtube.com/watch?v=gZ7z5oIOT1s", // 柴静《王洪文》上集
];

const relevant = (t) => {
  const hits = [...t.matchAll(KEYWORDS)].map((m) => m[0].toLowerCase());
  return hits.length > 0 && !hits.every((h) => WEAK.test(h));
};
const decode = (s) => s
  .replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .trim();
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function normalize(u) {
  // YouTube 短视频网址统一成普通观看网址，避免同一视频收两次
  const sh = u.match(/youtube\.com\/shorts\/([\w-]{11})/);
  if (sh) return `https://www.youtube.com/watch?v=${sh[1]}`;
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|at_|fbclid|gclid)/.test(k)) x.searchParams.delete(k);
    return x.toString();
  } catch { return u; }
}
function nyNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}
function parseFeed(xml) {
  const out = [];
  for (const it of xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/g) || []) {
    const t = it.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const l = it.match(/<link>([\s\S]*?)<\/link>/) || it.match(/<link[^>]+href="([^"]+)"/);
    const d = it.match(/<pubDate>([\s\S]*?)<\/pubDate>|<published>([\s\S]*?)<\/published>|<dc:date>([\s\S]*?)<\/dc:date>/);
    if (!t || !l) continue;
    let date = "";
    if (d) { const raw = (d[1] || d[2] || d[3]).trim(); const dt = new Date(raw); date = isNaN(dt) ? raw.slice(0, 10) : dt.toISOString().slice(0, 10); }
    out.push({ title: decode(t[1]), url: normalize(decode(l[1])), date });
  }
  return out;
}

async function load(env) {
  const keys = ["articles", "videos", "meta", "known", "topics_new", "wiki_new", "known_topics"];
  const [a, v, m, k, tn, wn, kt] = await Promise.all(keys.map((x) => env.AUTO.get(x, "json")));
  return { articles: a || [], videos: v || [], meta: m || {}, known: k || [], topics_new: tn || {}, wiki_new: wn || {}, known_topics: kt || [] };
}

// 各种来源 → 候选条目 [{kind, key, title, url, date, outlet, ...}]
function topicItems(src, body) {
  const out = [];
  if (src.type === "wp") {
    for (const p of JSON.parse(body)) out.push({ title: decode(p.title.rendered), url: p.link, date: p.date.slice(0, 10) });
  } else if (src.type === "pangea") {
    const re = /<a href="(\/a\/[^"]+\.html)"[^>]*title="([^"]+)"/g;
    let m;
    while ((m = re.exec(body))) {
      const dm = body.slice(re.lastIndex, re.lastIndex + 4000).match(/class="date[^"]*"[^>]*>([^<]+)</);
      const dd = dm && decode(dm[1]).match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      out.push({ title: decode(m[2]), url: src.base + m[1], date: dd ? `${dd[1]}-${dd[2].padStart(2, "0")}-${dd[3].padStart(2, "0")}` : "" });
    }
  } else if (src.type === "pts") {
    const re = /href="(https:\/\/news\.pts\.org\.tw\/article\/\d+)">([^<]{4,})</g;
    let m;
    while ((m = re.exec(body))) {
      const title = decode(m[2]);
      if (!title || !new RegExp(src.keywords).test(title)) continue; // 标签页夹带侧栏无关新闻
      const dm = body.slice(re.lastIndex, re.lastIndex + 1500).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
      out.push({ title, url: m[1], date: dm ? `${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}` : "" });
    }
  } else if (src.type === "diplomat") {
    const re = /<a href="(\/(\d{4})\/(\d\d)\/[^"]+\/)" class="td-post"[\s\S]*?<h4>([\s\S]*?)<\/h4>/g;
    let m;
    while ((m = re.exec(body))) out.push({ title: decode(m[4]), url: "https://thediplomat.com" + m[1], date: `${m[2]}-${m[3]}` });
  }
  return out;
}

// 维基网址统一比较（中文/英文维基编码方式不同）
const wikiKey = (u) => { try { return decodeURIComponent(u).replace(/ /g, "_"); } catch { return u; } };

// 核实网页能打开：返回 true/false。视频用 oEmbed，维基条目来自官方接口（分类成员必然存在）
async function verify(c, sub) {
  if (c.kind === "wiki") return true;
  if (c.kind === "videos") {
    const o = await sub("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(c.url));
    if (!o.ok) return false;
    const d = await o.json();
    c.title = d.title; c.channel = d.author_name; c.channel_url = d.author_url;
    return true;
  }
  const r = await sub(c.url, { headers: { ...UA, Accept: "text/html,application/pdf" }, redirect: "follow" });
  try { await r.body?.cancel(); } catch {}
  return r.status >= 200 && r.status < 300;
}

// 处理一批：先核实排队的候选条目，再读取新来源；每次闹钟子请求不超过 BUDGET
async function runBatch(env, today) {
  const db = await load(env);
  const meta = db.meta;
  if (meta.day !== today) {
    // 新的一天：从头读来源；昨天打不开的条目放回队列重试
    meta.day = today; meta.cursor = 0; meta.added = []; meta.errors = []; meta.rejected = [];
    meta.pending = (meta.retry || []).filter((c) => (c.tries || 0) < MAX_TRIES);
    meta.retry = [];
  }
  meta.pending = meta.pending || []; meta.retry = meta.retry || []; meta.rejected = meta.rejected || [];
  if (meta.cursor >= SOURCES.length && !meta.pending.length) return { done: true, added: [] };
  let used = 0;
  const sub = (u, o = {}) => { used++; return fetch(u, { ...o, signal: AbortSignal.timeout(15000) }); };
  // 已收录（人工整理 + 自动收录 + 排队中）的网址，不重复收
  const seen = new Set([...db.articles, ...db.videos].map((x) => x.url).concat(db.known, db.known_topics,
    ...Object.values(db.topics_new).map((l) => l.map((x) => x.url)), meta.pending.map((c) => c.url)));
  const wikiSeen = new Set(db.known.filter((u) => u.includes("/wiki/")).concat(...Object.values(db.wiki_new).map((l) => l.map((x) => x.url))).map(wikiKey));
  const added = [], errors = [];

  const accept = (c) => {
    const item = { title: c.title, url: c.url, date: c.date || "", added: today };
    if (c.kind === "videos") Object.assign(item, { channel: c.channel, channel_url: c.channel_url });
    if (c.kind === "articles") item.outlet = c.outlet;
    if (c.kind === "wiki") item.outlet = c.outlet;
    if (c.kind === "articles" || c.kind === "videos") db[c.kind].unshift(item);
    else { const box = c.kind === "topics" ? db.topics_new : db.wiki_new; (box[c.key] = box[c.key] || []).unshift(item); }
    added.push({ kind: c.kind, title: c.title, url: c.url });
  };
  const verifyQueue = async () => {
    while (meta.pending.length && used < BUDGET) {
      const c = meta.pending.shift();
      let ok = false;
      try { ok = await verify(c, sub); } catch { ok = false; }
      if (ok) accept(c);
      else { c.tries = (c.tries || 0) + 1; (c.tries < MAX_TRIES ? meta.retry : meta.rejected).push(c); }
    }
  };

  await verifyQueue();
  let n = 0;
  while (meta.cursor < SOURCES.length && n < BATCH && used < BUDGET - 5) {
    const src = SOURCES[meta.cursor++]; n++;
    try {
      const r = await sub(src.url, { headers: UA });
      if (!r.ok) { errors.push(`${src.name}: HTTP ${r.status}`); continue; }
      const body = await r.text();
      let cands = [];
      if (src.kind === "wiki") {
        for (const m of JSON.parse(body).query.categorymembers) {
          if ((src.exclude || []).includes(m.title)) continue;
          const url = `https://${src.host}/wiki/` + encodeURIComponent(m.title.replace(/ /g, "_"));
          if (wikiSeen.has(wikiKey(url))) continue;
          wikiSeen.add(wikiKey(url));
          cands.push({ kind: "wiki", key: src.section, title: m.title, url, outlet: src.outlet });
        }
      } else if (src.kind === "topics") {
        cands = topicItems(src, body).map((x) => ({ ...x, kind: "topics", key: src.key }));
        if (!cands.length) errors.push(`${src.name}: 0 条`);
      } else {
        const items = parseFeed(body);
        if (!items.length) errors.push(`${src.name}: 0 条`);
        for (const it of items) {
          if ((!src.trusted && !relevant(it.title)) || EXCLUDE.some((e) => it.url.includes(e) || it.title.includes(e))) continue;
          cands.push({ ...it, kind: src.kind, outlet: src.name });
        }
      }
      for (const c of cands) {
        if (!/^https?:\/\//.test(c.url) || seen.has(c.url)) continue;
        seen.add(c.url);
        meta.pending.push(c);
      }
    } catch (e) { errors.push(`${src.name}: ${String(e.message || e).slice(0, 80)}`); }
  }
  await verifyQueue();

  meta.added = (meta.added || []).concat(added);
  meta.errors = (meta.errors || []).concat(errors);
  meta.updated = today;
  await Promise.all([
    env.AUTO.put("articles", JSON.stringify(db.articles)),
    env.AUTO.put("videos", JSON.stringify(db.videos)),
    env.AUTO.put("topics_new", JSON.stringify(db.topics_new)),
    env.AUTO.put("wiki_new", JSON.stringify(db.wiki_new)),
    env.AUTO.put("meta", JSON.stringify(meta)),
  ]);
  const done = meta.cursor >= SOURCES.length && !meta.pending.length;
  if (done && env.TG_BOT_TOKEN && env.TG_CHAT_ID) await report(env, meta, today);
  return { done, added, used };
}

const KIND = { videos: "视频", articles: "报道", topics: "专题存档", wiki: "维基" };
async function report(env, meta, today) {
  const added = meta.added || [], errors = meta.errors || [];
  const lines = added.length
    ? [`🕯️ freedom8964 ${today} 自动收录 ${added.length} 条（Cloudflare，均已打开核实）：`, ...added.slice(0, 20).map((x) => `· [${KIND[x.kind] || x.kind}] ${x.title}`),
       ...(added.length > 20 ? [`……另有 ${added.length - 20} 条`] : []), "https://freedom8964.com/latest"]
    : [`freedom8964 ${today} 自动采集完成：没有新条目（Cloudflare）`];
  if ((meta.retry || []).length) lines.push(`⏳ ${meta.retry.length} 条暂时打不开，明天再试`);
  if ((meta.rejected || []).length) lines.push(`🚫 ${meta.rejected.length} 条连续 ${MAX_TRIES} 天打不开，不收录`);
  // 互相监控：VPS 每天采集后会在 KV 里写 vps_heartbeat；两天没写就提醒
  const hb = await env.AUTO.get("vps_heartbeat", "json");
  const days = hb ? Math.round((Date.parse(today) - Date.parse(hb.date)) / 86400000) : 99;
  if (days >= 2) lines.push(`⚠️ VPS 已经 ${days >= 99 ? "很久" : days + " 天"}没有运行（中国数字时代、X 帖子、合并与 GitHub 备份靠它；网站自身的采集不受影响），请检查 VPS`);
  if (errors.length) lines.push(`⚠️ ${errors.length}/${SOURCES.length} 个来源读取失败：`, ...errors.slice(0, 10).map((e) => `· ${e}`));
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: lines.join("\n"), disable_web_page_preview: true }),
  });
}

const L = {
  zh: { channel: "频道：", articles: "报道", videos: "视频", none: "暂无" },
  "zh-hant": { channel: "頻道：", articles: "報道", videos: "視頻", none: "暫無" },
  en: { channel: "Channel: ", articles: "Press", videos: "Video", none: "None yet" },
};
function renderList(items, kind, lang) {
  const l = L[lang];
  const sorted = [...items].sort((a, b) => (b.added + b.date).localeCompare(a.added + a.date)).slice(0, 150);
  const lis = sorted.map((x) => {
    const u = esc(x.url);
    let meta = kind === "videos"
      ? `${l.channel}<a href="${esc(x.channel_url)}" rel="noopener noreferrer" target="_blank">${esc(x.channel)}</a>`
      : esc(x.outlet || "");
    if (x.date) meta += ` · ${esc(x.date)}`;
    return `  <li><div class="t"><a href="${u}" rel="noopener noreferrer" target="_blank">${esc(x.title)}</a></div><div class="c">${meta} · ${u}</div></li>`;
  }).join("\n");
  return `<h2 id="${kind}">${l[kind]} <span class="muted small">${lang === "en" ? ` (${sorted.length})` : `（${sorted.length}）`}</span></h2>\n<ul class="vlist">\n${lis || `  <li class="muted">${l.none}</li>`}\n</ul>`;
}

const NAMES = {};
for (const t of TOPIC_SOURCES) NAMES["topics:" + t.key] = { zh: t.label, en: t.label_en };
for (const w of WIKI_SOURCES) NAMES["wiki:" + w.section] = { zh: w.label, en: w.label_en };
const NEW_HEAD = { zh: "最近自动新增", "zh-hant": "最近自動新增", en: "Recently added automatically" };
const NEW_NOTE = { zh: "网站每天自动采集、打开核实后加入，稍后会并入下面的分类。", "zh-hant": "網站每天自動採集、打開核實後加入，稍後會併入下面的分類。", en: "Collected and verified automatically each day; they will be merged into the sections below." };
function renderNew(box, page, lang) {
  const items = Object.entries(box).flatMap(([key, list]) => list.map((x) => ({ ...x, key })))
    .sort((a, b) => (b.added + b.date).localeCompare(a.added + a.date)).slice(0, 300);
  if (!items.length) return "";
  const lis = items.map((x) => {
    const n = NAMES[`${page}:${x.key}`] || {};
    const src = (lang === "en" ? n.en : n.zh) || x.outlet || "";
    const u = esc(x.url);
    return `  <li><div class="t"><a href="${u}" rel="noopener noreferrer" target="_blank">${esc(x.title)}</a></div><div class="c">${esc(src)}${x.date ? " · " + esc(x.date) : ""} · ${u}</div></li>`;
  }).join("\n");
  const count = lang === "en" ? ` (${items.length})` : `（${items.length}）`;
  return `<h2 id="new">${NEW_HEAD[lang]} <span class="muted small">${count}</span></h2>\n<p class="muted small">${NEW_NOTE[lang]}</p>\n<ul class="vlist">\n${lis}\n</ul>`;
}

// 每天采集的时间：美东凌晨 3 点
const RUN_HOUR_NY = 3;
const hourInNY = (t) => +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(t);
// 下一个美东凌晨 RUN_HOUR_NY 点对应的时间戳（自动适应夏令时：美东比 UTC 晚 4 或 5 小时）
function nextRunNY(from = Date.now()) {
  for (let d = 0; d <= 2; d++) {
    for (const h of [RUN_HOUR_NY + 4, RUN_HOUR_NY + 5]) {
      const t = new Date(from);
      t.setUTCDate(t.getUTCDate() + d); t.setUTCHours(h, 0, 30, 0);
      if (hourInNY(t) === RUN_HOUR_NY && t.getTime() > from) return t.getTime();
    }
  }
  return from + 86400000;
}

// 网站自己的“闹钟”：不占用账户的 Cron 名额。每天美东 3:00 响，逐批处理来源（每批间隔 1 分钟），处理完定下一天。
export class Collector extends DurableObject {
  async ensure() {
    const a = await this.ctx.storage.getAlarm();
    // 没有闹钟，或者闹钟定在别的钟点（比如改了采集时间），就重新定到下一个采集时间；正在分批处理中（1 分钟内的闹钟）不动
    if (!a || (a - Date.now() > 120000 && hourInNY(new Date(a)) !== RUN_HOUR_NY)) await this.ctx.storage.setAlarm(nextRunNY());
    return new Date(await this.ctx.storage.getAlarm()).toISOString();
  }
  async alarm() {
    const r = await runBatch(this.env, nyNow().date);
    await this.ctx.storage.setAlarm(r.done ? nextRunNY() : Date.now() + 60000);
  }
  async runNow() {
    const r = await runBatch(this.env, nyNow().date);
    if (!r.done) await this.ctx.storage.setAlarm(Date.now() + 60000);
    return r;
  }
}
const collector = (env) => env.COLLECTOR.get(env.COLLECTOR.idFromName("daily"));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 手动补跑一批：POST /__collect，请求头 X-Collect-Key 必须等于密钥 COLLECT_KEY；?reset=1 从头开始
    if (url.pathname === "/__collect") {
      if (request.method !== "POST" || !env.COLLECT_KEY || request.headers.get("X-Collect-Key") !== env.COLLECT_KEY) return new Response("Not found", { status: 404 });
      const today = nyNow().date;
      if (url.searchParams.get("reset")) { const m = (await env.AUTO.get("meta", "json")) || {}; m.day = ""; await env.AUTO.put("meta", JSON.stringify(m)); }
      const r = await collector(env).runNow();
      return Response.json({ ...r, next_alarm: await collector(env).ensure() });
    }
    const res = await env.ASSETS.fetch(request);
    const m = url.pathname.match(/^\/(?:(en|zh-hant)\/)?(latest|topics|wiki)(?:\.html)?$/);
    if (!m || !res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return res;
    const lang = m[1] || "zh";
    ctx.waitUntil(collector(env).ensure());
    if (m[2] !== "latest") {
      // 媒体专题存档 / 维基资料：在页面顶部的 <div id="auto-new"> 里插入网站自动采集、尚未并入静态页面的新条目（流式改写，不读整页）
      const box = (await env.AUTO.get(m[2] === "topics" ? "topics_new" : "wiki_new", "json")) || {};
      const block = renderNew(box, m[2], lang);
      const headers = new Headers(res.headers);
      headers.set("Cache-Control", "public, max-age=300");
      return new HTMLRewriter().on("div#auto-new", { element(el) { el.setInnerContent(block, { html: true }); } })
        .transform(new Response(res.body, { status: res.status, headers }));
    }
    const db = await load(env);
    let html = await res.text();
    html = html.replace("<!--AUTO-ARTICLES-->", renderList(db.articles, "articles", lang))
               .replace("<!--AUTO-VIDEOS-->", renderList(db.videos, "videos", lang))
               .replace("<!--AUTO-UPDATED-->", esc(db.meta.updated || ""));
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "public, max-age=300");
    return new Response(html, { status: res.status, headers });
  },

};
