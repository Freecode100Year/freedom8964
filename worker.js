// freedom8964.com 的 Cloudflare Worker：
//  1. 网站自己每天定时采集（美东凌晨 3 点开始，由 Durable Object 闹钟驱动，每分钟处理一批来源）：
//     白名单新闻订阅源 + 影像栏目已收录的 YouTube 官方频道，只取标题和网址，关键词过滤，视频经 oEmbed 核实。
//     结果存在 KV（F8964_AUTO），不依赖 VPS。
//  2. “最新收录”页（/latest、/en/latest、/zh-hant/latest）在返回时把 KV 里的条目填进静态页面。
//  其他所有请求直接交给静态资源。
import { DurableObject } from "cloudflare:workers";
import channels from "./collect/channels.json";

const FEEDS = [
  ["BBC News 中文", "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml"],
  ["自由亚洲电台 RFA", "https://www.rfa.org/mandarin/rss2.xml"],
  ["Radio Free Asia", "https://www.rfa.org/english/rss2.xml"],
  ["自由亚洲电台 RFA 粤语", "https://www.rfa.org/cantonese/rss2.xml"],
  ["美国之音 VOA", "https://www.voachinese.com/api/zm_yql-vomx-tpeybti"],
  ["德国之声 DW 中文", "https://rss.dw.com/xml/rss-chi-all"],
  ["Hong Kong Free Press 香港自由新闻", "https://hongkongfp.com/feed/"],
  ["NPR", "https://feeds.npr.org/1004/rss.xml"],
  ["The Guardian 卫报", "https://www.theguardian.com/world/china/rss"],
  ["Human Rights in China 中国人权", "https://news.hrichina.org/feed"],
];
const SOURCES = [
  ...FEEDS.map(([name, url]) => ({ kind: "articles", name, url })),
  ...Object.entries(channels).map(([id, c]) => ({
    kind: "videos", name: c.name, channel_url: c.url, url: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
  })),
];
const BATCH = 5;

const KEYWORDS = /六四|6\.?4|天安门|天安門|8964|八九|坦克人|支联会|支聯會|维园|維園|黄雀行动|黃雀行動|tiananmen|june 4(th)?\b|june fourth|tank man|hong kong alliance|victoria park vigil/gi;
const WEAK = /^(6\.?4|八九)$/;
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
  const [a, v, m, k] = await Promise.all(["articles", "videos", "meta", "known"].map((x) => env.AUTO.get(x, "json")));
  return { articles: a || [], videos: v || [], meta: m || {}, known: k || [] };
}

// 处理一批来源；返回本批新增条目
async function runBatch(env, today) {
  const db = await load(env);
  const meta = db.meta;
  if (meta.day !== today) { meta.day = today; meta.cursor = 0; meta.added = []; }
  if (meta.cursor >= SOURCES.length) return { done: true, added: [] };
  // known：影像、报道栏目人工整理过的链接（由 sync_known.py 同步），不重复收
  const seen = new Set([...db.articles, ...db.videos].map((x) => x.url).concat(db.known));
  const batch = SOURCES.slice(meta.cursor, meta.cursor + BATCH);
  const added = [];
  for (const src of batch) {
    try {
      const r = await fetch(src.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; freedom8964-collector; +https://freedom8964.com/about)" } });
      if (!r.ok) continue;
      for (const it of parseFeed(await r.text())) {
        if (!relevant(it.title) || seen.has(it.url) || EXCLUDE.some((e) => it.url.includes(e) || it.title.includes(e))) continue;
        if (src.kind === "videos") {
          const o = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(it.url));
          if (!o.ok) continue; // 视频不存在或不公开
          const d = await o.json();
          it.title = d.title; it.channel = d.author_name; it.channel_url = d.author_url;
        } else {
          it.outlet = src.name;
        }
        it.added = today;
        seen.add(it.url);
        db[src.kind].unshift(it);
        added.push({ kind: src.kind, title: it.title, url: it.url });
      }
    } catch (e) { /* 单个来源失败不影响其他来源 */ }
  }
  meta.cursor += batch.length;
  meta.added = (meta.added || []).concat(added);
  meta.updated = today;
  await Promise.all([
    env.AUTO.put("articles", JSON.stringify(db.articles)),
    env.AUTO.put("videos", JSON.stringify(db.videos)),
    env.AUTO.put("meta", JSON.stringify(meta)),
  ]);
  if (meta.cursor >= SOURCES.length && env.TG_BOT_TOKEN && env.TG_CHAT_ID) await report(env, meta.added, today);
  return { done: meta.cursor >= SOURCES.length, added };
}

async function report(env, added, today) {
  const lines = added.length
    ? [`🕯️ freedom8964 ${today} 自动收录 ${added.length} 条（Cloudflare）：`, ...added.slice(0, 20).map((x) => `· [${x.kind === "videos" ? "视频" : "报道"}] ${x.title}`), "https://freedom8964.com/latest"]
    : [`freedom8964 ${today} 自动采集完成：没有新条目（Cloudflare）`];
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
    const m = url.pathname.match(/^\/(?:(en|zh-hant)\/)?latest(?:\.html)?$/);
    if (!m || !res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return res;
    const lang = m[1] || "zh";
    ctx.waitUntil(collector(env).ensure());
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
