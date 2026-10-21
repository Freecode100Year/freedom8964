// 采集核心：网站 Worker（worker.js，Cloudflare）和 GitHub Actions（collect/github_collect.mjs）共用。
// 来源白名单、关键词过滤、订阅源解析、核实规则都在这里，两边采集结果一致。
import channels from "./channels.json" with { type: "json" };
import playlists from "./playlists.json" with { type: "json" }; // 官方频道的六四专题播放列表（本身就是六四内容，不做关键词过滤）
import FEEDS from "./feeds.json" with { type: "json" }; // 新闻订阅源白名单：[名称, 网址]
import TOPIC_SOURCES from "./topic_sources.json" with { type: "json" }; // 媒体专题存档的来源（由 sync_known.py 从 assets/topics.json 生成）
import WIKI_SOURCES from "./wiki_sources.json" with { type: "json" }; // 维基资料的分类（由 sync_known.py 从 assets/articles.json 生成）

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
export { TOPIC_SOURCES, WIKI_SOURCES, SOURCES, UA, CDT_RE, BATCH, BUDGET, MAX_TRIES, decode, esc, normalize, nyNow, parseFeed, verify, collectStep };
