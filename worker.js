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
const X_ACCOUNTS = ["whyyoutouzhele", "hrichina", "HChina89"];
const X_NAMES = { whyyoutouzhele: "李老师不是你老师", hrichina: "中国人权", HChina89: "人道中国" };
const X_TAG = "你没看过的六四";
const X_DAYS = 21;
const X_EPOCH = 1288834974657n;
const xTime = (id) => Number((BigInt(id) >> 22n) + X_EPOCH);
const UA = { "User-Agent": "Mozilla/5.0 (compatible; freedom8964-collector; +https://freedom8964.com/about)" };
const SOURCES = [
  ...FEEDS.map(([name, url]) => ({ kind: "articles", name, url })),
  ...TOPIC_SOURCES.map((t) => ({ kind: "topics", ...t })),
  // 中国数字时代：官方订阅源（每页 10 篇），按分类/标题筛出六四相关；白天另有每 2 小时一次的轻量检查
  ...[1, 2, 3].map((n) => ({ kind: "cdt", name: `中国数字时代 订阅源第 ${n} 页`, url: `https://chinadigitaltimes.net/chinese/feed${n > 1 ? "?paged=" + n : ""}` })),

  ...WIKI_SOURCES.map((w) => ({ kind: "wiki", name: `${w.host} ${w.cat}`, url: `https://${w.host}/w/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent(w.cat)}&cmlimit=500&cmnamespace=0&format=json`, ...w })),
  // 用户 2026-10-08 要求：不再采集 X（推特）；已收录的 X 帖文保留展示
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
    const cats = [...it.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/g)].map((c) => decode(c[1]));
    out.push({ title: decode(t[1]), url: normalize(decode(l[1])), date, cats });
  }
  return out;
}

// 页面访问时读 KV 的结果在同一实例里缓存 60 秒（免费版 KV 每天 10 万次读取）
let pageCache = null;
let lastEnsure = 0;
async function loadForPage(env) {
  if (pageCache && Date.now() - pageCache.t < 60000) return pageCache.db;
  const db = await load(env);
  pageCache = { t: Date.now(), db };
  return db;
}

async function load(env) {
  const keys = ["articles", "videos", "meta", "known", "topics_new", "wiki_new", "known_topics", "cdt_new", "x_new", "x_seen"];
  const [a, v, m, k, tn, wn, kt, cn, xn, xs] = await Promise.all(keys.map((x) => env.AUTO.get(x, "json")));
  return { articles: a || [], videos: v || [], meta: m || {}, known: k || [], topics_new: tn || {}, wiki_new: wn || {}, known_topics: kt || [],
           cdt_new: cn || [], x_new: xn || [], x_seen: xs || [] };
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

const CDT_RE = /六四|八九|天安门|天安門|8964|坦克人|天安门母亲|天安門母親|支联会|支聯會/;
const xTitle = (t) => { t = t.replace(/https?:\/\/t\.co\/\S+/g, "").replace(/​/g, "").replace(/\s+/g, " ").trim(); return t.length <= 70 ? t : t.slice(0, 70) + "…"; };

// 核实网页能打开：返回 true/false（x 类另外返回帖子信息）。
//  视频：YouTube oEmbed；X 帖子：X 官方 tweet-result 接口；维基：官方接口的分类成员（必然存在）；
//  中国数字时代：文章来自它的官方订阅源；网页对机器人显示验证页（403 + “Just a moment”）时视为存在。
async function verify(c, sub) {
  if (c.kind === "wiki") return true;
  if (c.kind === "videos") {
    const o = await sub("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(c.url));
    if (!o.ok) return false;
    const d = await o.json();
    c.title = d.title; c.channel = d.author_name; c.channel_url = d.author_url;
    return true;
  }
  if (c.kind === "x") {
    const r = await sub(`https://cdn.syndication.twimg.com/tweet-result?id=${c.id}&token=a`);
    if (!r.ok) return false;
    const j = JSON.parse((await r.text()) || "{}");
    const acct = X_ACCOUNTS.find((a) => a.toLowerCase() === ((j.user || {}).screen_name || "").toLowerCase());
    c.skip = !(acct && (j.text || "").includes(X_TAG)); // 不是系列帖：记为已查，不收
    if (!c.skip) {
      const id = j.id_str || c.id; // 转推会返回原帖
      Object.assign(c, { url: `https://x.com/${acct}/status/${id}`, title: xTitle(j.text), date: (j.created_at || "").slice(0, 10), outlet: `X · ${X_NAMES[acct]} @${acct}` });
    }
    return true;
  }
  const r = await sub(c.url, { headers: { ...UA, Accept: "text/html,application/pdf" }, redirect: "follow" });
  let head = "";
  try { head = r.status === 403 && c.kind === "cdt" ? (await r.text()).slice(0, 500) : (await r.body?.cancel(), ""); } catch {}
  if (c.kind === "cdt" && r.status === 403 && head.includes("Just a moment")) return true;
  return r.status >= 200 && r.status < 300;
}

// 每周死链检查（周六）与互联网档案馆存档（周日）用到的网页
const SITE_PAGES = ["", "timeline", "victims", "documents", "hongkong", "museum", "videos", "reports", "topics", "wiki", "cdt", "latest", "about"]
  .flatMap((p) => ["", "en/", "zh-hant/"].map((l) => `https://freedom8964.com/${l}${p}`));

// 处理一批：先核实排队的候选条目，再读取新来源；每次闹钟子请求不超过 BUDGET
async function runBatch(env, today) {
  const db = await load(env);
  const meta = db.meta;
  if (meta.day !== today) {
    // 新的一天：从头读来源；昨天打不开的条目放回队列重试
    meta.day = today; meta.cursor = 0; meta.added = []; meta.errors = []; meta.rejected = [];
    meta.pending = (meta.retry || []).filter((c) => (c.tries || 0) < MAX_TRIES);
    meta.retry = [];
    meta.weekly = null;
    meta.finished = false;
    meta.srcRetry = [];
  }
  meta.pending = meta.pending || []; meta.retry = meta.retry || []; meta.rejected = meta.rejected || [];
  let used = 0;
  const sub = (u, o = {}, ms = 15000) => { used++; return fetch(u, { ...o, signal: AbortSignal.timeout(ms) }); };
  const save = () => Promise.all(["articles", "videos", "topics_new", "wiki_new", "cdt_new", "x_new", "x_seen", "meta"]
    .map((k) => env.AUTO.put(k, JSON.stringify(k === "meta" ? meta : db[k]))));

  // 只剩“等待重试”的来源且还没到时间：不读写数据库，告诉闹钟到点再来
  if (meta.cursor >= SOURCES.length && !meta.pending.length && (meta.srcRetry || []).length && meta.srcRetry.every((x) => x.at > Date.now()))
    return { done: false, added: [], used, wait: Math.min(...meta.srcRetry.map((x) => x.at)) };
  if (meta.cursor < SOURCES.length || meta.pending.length || (meta.srcRetry || []).length) {
    const r = await collectStep(env, db, meta, today, sub, () => used);
    meta.updated = today;
    await save();
    if (!r.done) return { done: false, added: r.added, used };
    if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) await report(env, meta, today);
  }
  // 每日采集完成后：周六死链检查、周日提交互联网档案馆
  const dow = new Date(today + "T12:00:00Z").getUTCDay();
  if (dow === 6 || dow === 0) {
    const w = meta.weekly || (meta.weekly = { kind: dow === 6 ? "links" : "archive", cursor: 0, dead: [], list: null });
    if (w.cursor >= 0) {
      if (!w.list) {
        w.list = dow === 6 ? [...new Set([...db.known, ...db.known_topics.filter((_, i) => i % 40 === 0),
          ...db.articles.map((x) => x.url), ...db.videos.map((x) => x.url)])] : SITE_PAGES;
      }
      // 每分钟：死链检查最多 25 个、档案馆存档最多 5 个（单次闹钟有 15 分钟上限，也别给档案馆压力）
      const lim = w.kind === "archive" ? 5 : 25;
      let k = 0;
      while (w.cursor < w.list.length && k++ < lim) {
        const u = w.list[w.cursor++];
        if (w.kind === "archive") { try { await sub("https://web.archive.org/save/" + u, { headers: UA }, 60000); } catch {} continue; }
        const dead = await deadLink(u, sub);
        if (dead) w.dead.push(`${dead} ${u}`);
      }
      if (w.cursor >= w.list.length) {
        if (w.kind === "links" && env.TG_BOT_TOKEN) await tg(env, [`🔗 freedom8964 每周死链检查（Cloudflare）：查了 ${w.list.length} 个链接，失效 ${w.dead.length} 个`, ...w.dead.slice(0, 30).map((d) => "· " + d)]);
        w.cursor = -1; w.list = null;
      }
      await env.AUTO.put("meta", JSON.stringify(meta));
      if (w.cursor >= 0) return { done: false, added: [], used };
    }
  }
  if (!meta.finished) { meta.finished = true; await env.AUTO.put("meta", JSON.stringify(meta)); }
  return { done: true, added: [], used };
}

// 只报告真正失效：404/410、域名不存在、视频已删除；网站拦截机器人造成的 403/429/超时不算
async function deadLink(u, sub) {
  try {
    if (u.includes("youtube.com/watch")) {
      const r = await sub("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(u));
      return [400, 401, 404].includes(r.status) ? `视频不存在(${r.status})` : null;
    }
    const r = await sub(u, { headers: { ...UA, Accept: "text/html" }, redirect: "follow" });
    try { await r.body?.cancel(); } catch {}
    return [404, 410].includes(r.status) ? `HTTP ${r.status}` : null;
  } catch (e) {
    return /dns|resolve|ENOTFOUND/i.test(String(e)) ? "域名失效" : null;
  }
}

async function collectStep(env, db, meta, today, sub, used) {
  // 已收录（人工整理 + 自动收录 + 排队中）的网址，不重复收
  const seen = new Set([...db.articles, ...db.videos, ...db.cdt_new, ...db.x_new].map((x) => x.url).concat(db.known, db.known_topics,
    ...Object.values(db.topics_new).map((l) => l.map((x) => x.url)), meta.pending.map((c) => c.url)));
  const wikiSeen = new Set(db.known.filter((u) => u.includes("/wiki/")).concat(...Object.values(db.wiki_new).map((l) => l.map((x) => x.url))).map(wikiKey));
  const xSeen = new Set(db.x_seen.concat(db.known.concat(db.x_new.map((x) => x.url)).map((u) => (u.match(/\/status\/(\d+)/) || [])[1]).filter(Boolean)));
  const added = [], errors = [];

  const accept = (c) => {
    const item = { title: c.title, url: c.url, date: c.date || "", added: today };
    if (c.kind === "videos") Object.assign(item, { channel: c.channel, channel_url: c.channel_url });
    if (["articles", "wiki", "x"].includes(c.kind)) item.outlet = c.outlet;
    if (c.kind === "articles" || c.kind === "videos") db[c.kind].unshift(item);
    else if (c.kind === "cdt") db.cdt_new.unshift(item);
    else if (c.kind === "x") db.x_new.unshift(item);
    else { const box = c.kind === "topics" ? db.topics_new : db.wiki_new; (box[c.key] = box[c.key] || []).unshift(item); }
    added.push({ kind: c.kind, title: c.title, url: c.url });
  };
  const verifyQueue = async () => {
    while (meta.pending.length && used() < BUDGET) {
      const c = meta.pending.shift();
      let ok = false;
      try { ok = await verify(c, sub); } catch { ok = false; }
      if (c.kind === "x" && ok) { db.x_seen.push(c.id); if (c.skip) continue; }
      if (ok) accept(c);
      else { c.tries = (c.tries || 0) + 1; (c.tries < MAX_TRIES ? meta.retry : meta.rejected).push(c); }
    }
  };

  meta.pending = meta.pending.filter((c) => c.kind !== "x");
  meta.retry = (meta.retry || []).filter((c) => c.kind !== "x");
  await verifyQueue();
  // 读取失败的来源（限流、临时故障）当天隔 10 分钟重试，最多 2 次
  meta.srcRetry = meta.srcRetry || [];
  const fail = (idx, msg) => {
    const r = meta.srcRetry.find((x) => x.i === idx);
    const tries = r ? r.n : 0;
    if (tries < 2) { if (r) { r.n++; r.at = Date.now() + 600000; } else meta.srcRetry.push({ i: idx, n: 1, at: Date.now() + 600000 }); }
    else { meta.srcRetry = meta.srcRetry.filter((x) => x.i !== idx); errors.push(msg); }
  };
  const nextSource = () => {
    if (meta.cursor < SOURCES.length) return meta.cursor++;
    const r = meta.srcRetry.find((x) => x.at <= Date.now());
    return r ? r.i : -1;
  };
  let n = 0;
  while (n < BATCH && used() < BUDGET - 5) {
    const idx = nextSource();
    if (idx < 0) break;
    const src = SOURCES[idx]; n++;
    const ok = () => { meta.srcRetry = meta.srcRetry.filter((x) => x.i !== idx); };
    try {
      let cands = [];
      if (src.kind === "x") {
        // 互联网档案馆查询较慢，给 2 分钟
        const from = new Date(Date.parse(today) - X_DAYS * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
        const r = await sub(`https://web.archive.org/cdx/search/cdx?url=${src.host}/${src.acct}/status/&matchType=prefix&from=${from}&fl=original&collapse=urlkey&limit=5000`, { headers: UA }, 120000);
        if (!r.ok) { fail(idx, `${src.name}: HTTP ${r.status}`); continue; }
        ok();
        const since = Date.parse(today) - X_DAYS * 86400000;
        for (const m of (await r.text()).matchAll(/\/status\/(\d{15,})/g)) {
          const id = m[1];
          if (xSeen.has(id) || xTime(id) < since) continue;
          xSeen.add(id);
          cands.push({ kind: "x", id, url: `https://x.com/${src.acct}/status/${id}`, title: "" });
        }
      } else {
        const r = await sub(src.url, { headers: UA });
        if (!r.ok) { fail(idx, `${src.name}: HTTP ${r.status}`); continue; }
        ok();
        const body = await r.text();
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
        } else if (src.kind === "cdt") {
          const items = parseFeed(body);
          if (!items.length) errors.push(`${src.name}: 0 条`);
          cands = items.filter((it) => it.cats.some((c) => CDT_RE.test(c)) || CDT_RE.test(it.title)).map((it) => ({ ...it, kind: "cdt" }));
        } else {
          const items = parseFeed(body);
          if (!items.length) errors.push(`${src.name}: 0 条`);
          for (const it of items) {
            if ((!src.trusted && !relevant(it.title)) || EXCLUDE.some((e) => it.url.includes(e) || it.title.includes(e))) continue;
            cands.push({ ...it, kind: src.kind, outlet: src.name });
          }
        }
      }
      for (const c of cands) {
        delete c.cats;
        if (!/^https?:\/\//.test(c.url) || (c.kind !== "x" && seen.has(c.url))) continue;
        seen.add(c.url);
        meta.pending.push(c);
      }
    } catch (e) { fail(idx, `${src.name}: ${String(e.message || e).slice(0, 80)}`); }
  }
  await verifyQueue();
  // X 已查编号只留查询窗口内的
  const since = Date.parse(today) - (X_DAYS + 7) * 86400000;
  db.x_seen = [...new Set(db.x_seen)].filter((id) => xTime(id) >= since);
  meta.added = (meta.added || []).concat(added);
  meta.errors = (meta.errors || []).concat(errors);
  return { done: meta.cursor >= SOURCES.length && !meta.pending.length && !meta.srcRetry.length, added };
}

// 白天每 2 小时一次的轻量检查：中国数字时代订阅源第 1 页（一天发文较多，每天一次会漏）
async function runLight(env, today) {
  const db = await load(env);
  const seen = new Set(db.cdt_new.map((x) => x.url).concat(db.known));
  let used = 0;
  const sub = (u, o = {}) => { used++; return fetch(u, { ...o, signal: AbortSignal.timeout(15000) }); };
  const r = await sub("https://chinadigitaltimes.net/chinese/feed", { headers: UA });
  if (!r.ok) return;
  const added = [];
  for (const it of parseFeed(await r.text())) {
    if (seen.has(it.url) || !(it.cats.some((c) => CDT_RE.test(c)) || CDT_RE.test(it.title))) continue;
    const c = { kind: "cdt", title: it.title, url: it.url, date: it.date };
    if (await verify(c, sub)) { db.cdt_new.unshift({ title: c.title, url: c.url, date: c.date, added: today }); added.push(c); }
  }
  if (added.length) {
    await env.AUTO.put("cdt_new", JSON.stringify(db.cdt_new));
    const meta = db.meta; meta.added = (meta.added || []).concat(added.map((c) => ({ kind: "cdt", title: c.title, url: c.url })));
    await env.AUTO.put("meta", JSON.stringify(meta));
    if (env.TG_BOT_TOKEN) await tg(env, [`🕯️ freedom8964 中国数字时代新收 ${added.length} 篇：`, ...added.map((c) => "· " + c.title), "https://freedom8964.com/cdt"]);
  }
}

async function tg(env, lines) {
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: lines.join("\n"), disable_web_page_preview: true }),
  });
}

const KIND = { videos: "视频", articles: "报道", topics: "专题存档", wiki: "维基", cdt: "中国数字时代", x: "X 帖子" };
async function report(env, meta, today) {
  const added = meta.added || [], errors = meta.errors || [];
  const lines = added.length
    ? [`🕯️ freedom8964 ${today} 自动收录 ${added.length} 条（均已打开核实）：`, ...added.slice(0, 20).map((x) => `· [${KIND[x.kind] || x.kind}] ${x.title}`),
       ...(added.length > 20 ? [`……另有 ${added.length - 20} 条`] : []), "https://freedom8964.com/latest"]
    : [`freedom8964 ${today} 自动采集完成：没有新条目`];
  if ((meta.retry || []).length) lines.push(`⏳ ${meta.retry.length} 条暂时打不开，明天再试`);
  if ((meta.rejected || []).length) lines.push(`🚫 ${meta.rejected.length} 条连续 ${MAX_TRIES} 天打不开，不收录`);
  if (errors.length) lines.push(`⚠️ ${errors.length}/${SOURCES.length} 个来源读取失败：`, ...errors.slice(0, 10).map((e) => `· ${e}`));
  await tg(env, lines);
}

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
    // （白天的 2 小时轻量检查闹钟不超过 2 小时，不会被改掉）
    if (!a || (a - Date.now() > 3 * 3600000 && hourInNY(new Date(a)) !== RUN_HOUR_NY)) await this.ctx.storage.setAlarm(nextRunNY());
    return new Date(await this.ctx.storage.getAlarm()).toISOString();
  }
  async alarm() {
    const { date, hour } = nyNow();
    const meta = (await this.env.AUTO.get("meta", "json")) || {};
    let done = true;
    // 新的一天到了采集钟点，或今天的采集还没做完 → 继续每日采集；否则做轻量检查
    let wait = 0;
    if (meta.day !== date ? hour >= RUN_HOUR_NY : !meta.finished) { const r = await runBatch(this.env, date); done = r.done; wait = r.wait || 0; }
    else { try { await runLight(this.env, date); } catch {} }
    await this.ctx.storage.setAlarm(done ? Math.min(nextRunNY(), Date.now() + 2 * 3600000) : Math.max(wait, Date.now() + 60000));
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
    // 公开导出网站自动采集的数据（全是公开链接），供 GitHub 每日备份
    if (url.pathname === "/__export.json") {
      const db = await loadForPage(env);
      const { pending, retry, rejected, weekly, ...m } = db.meta;
      return Response.json({ meta: m, articles: db.articles, videos: db.videos, topics_new: db.topics_new, wiki_new: db.wiki_new, cdt_new: db.cdt_new, x_new: db.x_new },
        { headers: { "Cache-Control": "no-store" } });
    }
    // 诊断：POST /__probe?url=...（需密钥），从 Cloudflare 网络取一个网址，返回状态码和开头内容
    if (url.pathname === "/__probe") {
      if (request.method !== "POST" || !env.COLLECT_KEY || request.headers.get("X-Collect-Key") !== env.COLLECT_KEY) return new Response("Not found", { status: 404 });
      const t = url.searchParams.get("url");
      try {
        const r = await fetch(t, { headers: { ...UA, Accept: "*/*" }, signal: AbortSignal.timeout(25000) });
        const body = await r.text();
        const at = url.searchParams.get("find");
        const i = at ? body.indexOf(at) : 0;
        return Response.json({ status: r.status, length: body.length, head: body.slice(Math.max(0, i), Math.max(0, i) + (at ? 1500 : 300)) });
      } catch (e) { return Response.json({ error: String(e) }); }
    }
    const res = await env.ASSETS.fetch(request);
    const m = url.pathname.match(/^\/(?:(en|zh-hant)\/)?(latest|topics|wiki|cdt|reports)(?:\.html)?$/);
    if (!m || !res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return res;
    const lang = m[1] || "zh";
    // 顺带确保闹钟在走（同一实例 10 分钟最多查一次，节省 Durable Object 请求额度）
    if (Date.now() - lastEnsure > 600000) { lastEnsure = Date.now(); ctx.waitUntil(collector(env).ensure()); }
    if (m[2] !== "latest") {
      // 媒体专题存档 / 维基资料：在页面顶部的 <div id="auto-new"> 里插入网站自动采集、尚未并入静态页面的新条目（流式改写，不读整页）
      const db = await loadForPage(env);
      const block = renderNew(newGroups(m[2], db, lang), lang);
      const headers = new Headers(res.headers);
      headers.set("Cache-Control", "public, max-age=300");
      return new HTMLRewriter().on("div#auto-new", { element(el) { el.setInnerContent(block, { html: true }); } })
        .transform(new Response(res.body, { status: res.status, headers }));
    }
    const db = await loadForPage(env);
    let html = await res.text();
    html = html.replace("<!--AUTO-ARTICLES-->", renderList(db.articles, "articles", lang))
               .replace("<!--AUTO-VIDEOS-->", renderList(db.videos, "videos", lang))
               .replace("<!--AUTO-CDT-->", db.cdt_new.length ? renderList(db.cdt_new, "cdt", lang) : "")
               .replace("<!--AUTO-UPDATED-->", esc(db.meta.updated || ""));
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "public, max-age=300");
    return new Response(html, { status: res.status, headers });
  },

};
