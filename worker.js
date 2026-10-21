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
// 采集核心（来源、过滤、核实）在 collect/core.js，与 GitHub Actions 的每日采集共用
import { SOURCES, UA, CDT_RE, MAX_TRIES, esc, parseFeed, verify, collectStep, nyNow } from "./collect/core.js";
import { renderList, renderNew, newGroups } from "./collect/render.js";
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
