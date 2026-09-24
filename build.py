#!/usr/bin/env python3
"""生成 freedom8964.com 静态网站到 dist/，三种语言：
   简体（根目录，页面正文 pages/zh/）、繁體（/zh-hant/，由简体用 OpenCC 自动转换）、English（/en/，pages/en/）。
   视频、报道的标题保持原文，不做简繁转换。"""
import html
import json
import re
import shutil
from pathlib import Path

import opencc

ROOT = Path(__file__).parent
DIST = ROOT / "dist"
SITE = "https://freedom8964.com"
UPDATED = "2026-09-24"
S2T = opencc.OpenCC("s2t.json")

FILES = ["index.html", "timeline.html", "victims.html", "documents.html", "hongkong.html",
         "museum.html", "videos.html", "reports.html", "cdt.html", "latest.html", "about.html"]

LOCALES = {
    "zh": {"prefix": "", "lang": "zh-Hans", "label": "简体", "src": "zh"},
    "zh-hant": {"prefix": "zh-hant/", "lang": "zh-Hant", "label": "繁體", "src": "zh"},
    "en": {"prefix": "en/", "lang": "en", "label": "English", "src": "en"},
}

# 每种语言的界面文字；繁體由简体自动转换
T = {
    "zh": {
        "nav": ["首页", "大事记", "遇难者", "史料", "香港烛光", "纪念馆", "影像", "报道", "中国数字时代", "最新", "关于"],
        "pages": {
            "index.html": ("自由 · 八九六四", "六四事件相关信息的采集、整理与归档导航。本站不生产内容，每条记录指向原始出处。"),
            "timeline.html": ("大事记", "1989 年 4 月至 6 月的日期记录，附出处。"),
            "victims.html": ("遇难者与天安门母亲", "遇难者名单与家属群体的资料来源。"),
            "documents.html": ("史料与档案", "死亡人数各方说法对照；解密档案与资料库链接。"),
            "hongkong.html": ("香港维园烛光", "支联会与维园悼念的记录。"),
            "museum.html": ("六四纪念馆（美国）", "纪念馆筹建与发展的记录，参观信息。"),
            "videos.html": ("影像", "经核实的六四相关 YouTube 视频链接，按主题分类。"),
            "reports.html": ("报道", "媒体报道与各国政府声明链接，按主题分类，逐一核实。"),
            "cdt.html": ("中国数字时代", "中国数字时代“六四”相关标签下的文章，按年份排列，只收标题和网址。"),
            "latest.html": ("最新收录", "每天自动采集的六四相关报道、视频与中国数字时代文章，只收标题和网址。"),
            "about.html": ("关于本站", "本站定位、收录原则、更正方式与隐私说明。"),
            "404.html": ("找不到页面", "页面不存在"),
        },
        "foot1": "本站不生产内容，只采集、收集、整理、记录、归档六四事件相关信息的链接与出处；文章与视频版权归原作者和原发布方。",
        "foot2": "不使用 Cookie，不做任何访问统计。最后更新：",
        "foot_link": "收录原则与更正",
        "channel": "频道：", "paywall": "需订阅", "count": "（{}）", "navlabel": "主导航", "langlabel": "语言",
        "l_articles": "报道", "l_videos": "视频", "l_cdt": "中国数字时代", "l_more": "全部 {} 篇 →", "l_none": "暂无", "l_added": "收录于",
    },
    "en": {
        "nav": ["Home", "Chronology", "Victims", "Records", "Hong Kong", "Museum", "Video", "Press", "CDT", "Latest", "About"],
        "pages": {
            "index.html": ("Freedom · June Fourth 1989", "A directory for collecting, organising and archiving information about June Fourth 1989. Every record points to its original source."),
            "timeline.html": ("Chronology", "Dated records, April to June 1989, with sources."),
            "victims.html": ("Victims & Tiananmen Mothers", "Sources for the list of victims and the families' group."),
            "documents.html": ("Records & Archives", "Death-toll figures side by side; declassified archives."),
            "hongkong.html": ("Hong Kong Vigil", "Records of the Hong Kong Alliance and the Victoria Park vigil."),
            "museum.html": ("June 4th Memorial Museum (USA)", "Records of the museum; visitor information."),
            "videos.html": ("Video", "Verified YouTube links about June Fourth, by topic."),
            "reports.html": ("Press", "Press reports and government statements, by topic, each verified."),
            "cdt.html": ("China Digital Times", "China Digital Times articles tagged with June Fourth, by year. Titles and links only."),
            "latest.html": ("Latest", "June Fourth reports, videos and China Digital Times articles collected daily. Titles and links only."),
            "about.html": ("About", "What this site is, principles, corrections and privacy."),
            "404.html": ("Page not found", "Page not found"),
        },
        "foot1": "This site does not produce content. It collects, organises, records and archives links and sources about June Fourth; copyright remains with the original authors and publishers.",
        "foot2": "No cookies, no analytics. Last updated: ",
        "foot_link": "Principles and corrections",
        "channel": "Channel: ", "paywall": "Subscription", "count": " ({})", "navlabel": "Main navigation", "langlabel": "Language",
        "l_articles": "Press", "l_videos": "Video", "l_cdt": "China Digital Times", "l_more": "All {} articles →", "l_none": "None yet", "l_added": "added",
    },
}


def to_hant(text):
    """简体转繁體，只转标签外的文字，不动网址和属性。"""
    parts = re.split(r"(<[^>]+>)", text)
    text = "".join(p if p.startswith("<") else S2T.convert(p) for p in parts)
    # 按钮点亮后显示的文字存在 data-done 属性里，也要转换
    return re.sub(r'data-done="([^"]*)"', lambda m: f'data-done="{S2T.convert(m.group(1))}"', text)


def strings(loc):
    if loc == "zh-hant":
        z = T["zh"]
        return {
            "nav": [S2T.convert(x) for x in z["nav"]],
            "pages": {k: (S2T.convert(a), S2T.convert(b)) for k, (a, b) in z["pages"].items()},
            **{k: S2T.convert(v) for k, v in z.items() if isinstance(v, str)},
        }
    return T[loc]


def url_of(loc, file):
    """某语言某页面的公开网址（简洁形式）。"""
    p = LOCALES[loc]["prefix"] + file
    p = p.replace("index.html", "").removesuffix(".html")
    return f"{SITE}/{p}"


def layout(loc, file, body):
    s = strings(loc)
    out_path = LOCALES[loc]["prefix"] + file
    up = "../" * out_path.count("/")
    title, desc = s["pages"][file]
    nav = "\n".join(
        f'      <a href="{up}{LOCALES[loc]["prefix"]}{f}"{" aria-current=\"page\"" if f == file else ""}>{label}</a>'
        for f, label in zip(FILES, s["nav"])
    )
    langs = "\n".join(
        f'      <a href="{up}{LOCALES[l]["prefix"]}{file if file != "404.html" else "index.html"}" data-setlang="{l}" hreflang="{LOCALES[l]["lang"]}" lang="{LOCALES[l]["lang"]}"'
        f'{" aria-current=\"true\"" if l == loc else ""}>{LOCALES[l]["label"]}</a>'
        for l in LOCALES
    )
    alternates = "" if file == "404.html" else "\n".join(
        [f'<link rel="alternate" hreflang="{LOCALES[l]["lang"]}" href="{url_of(l, file)}" data-locale="{l}">' for l in LOCALES]
        + [f'<link rel="alternate" hreflang="x-default" href="{url_of("zh", file)}">']
    )
    full_title = title if file == "index.html" else f"{title} — freedom8964"
    return f"""<!doctype html>
<html lang="{LOCALES[loc]["lang"]}" data-locale="{loc}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{html.escape(full_title)}</title>
<meta name="description" content="{html.escape(desc)}">
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="{url_of(loc, file) if file != '404.html' else SITE}">
<meta name="theme-color" content="#000000">
<meta name="color-scheme" content="dark">
{alternates}
<link rel="icon" href="{up}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{up}assets/style.css">
<script src="{up}assets/lang.js"></script>
</head>
<body>
<header class="site-head">
  <div class="wrap">
    <a class="brand" href="{up}{LOCALES[loc]["prefix"]}index.html">freedom<b>8964</b></a>
    <nav class="nav" aria-label="{s["navlabel"]}">
{nav}
    </nav>
    <nav class="langs" aria-label="{s["langlabel"]}">
{langs}
    </nav>
  </div>
</header>
{body}
<footer class="site-foot">
  <div class="wrap">
    <p>{s["foot1"]}</p>
    <p>{s["foot2"]}{UPDATED} · <a href="{up}{LOCALES[loc]["prefix"]}about.html">{s["foot_link"]}</a></p>
  </div>
</footer>
</body>
</html>
"""


def keep_dates_together(text):
    """中文里“6 月 3 日”“17 岁”这类数字和单位之间换成不换行空格，窄屏上不会被拆到两行。只处理标签外的文字。"""
    def fix(chunk):
        chunk = re.sub(r"(\d) (?=[年月日时時岁歲人位名部个個份])", "\\1\u00a0", chunk)
        return re.sub(r"(?<=[年月]) (?=\d)", "\u00a0", chunk)
    parts = re.split(r"(<[^>]+>)", text)
    return "".join(p if p.startswith("<") else fix(p) for p in parts)


def pretty_links(page):
    """站内相对链接去掉 .html（Workers 静态资源会把 /x.html 307 跳到 /x），index.html 变成目录。"""
    def fix(m):
        target, frag = m.group(1), m.group(2) or ""
        if target.endswith("index.html"):
            target = target[: -len("index.html")] or "./"
        else:
            target = target[: -len(".html")]
        return f'href="{target}{frag}"'
    return re.sub(r'href="(?!https?:|/)([^"#]*?\.html)(#[^"]*)?"', fix, page)


def heading_of(sec, loc):
    if loc == "en":
        return sec["heading_en"], sec["intro_en"]
    if loc == "zh-hant":
        return S2T.convert(sec["heading"]), S2T.convert(sec["intro"])
    return sec["heading"], sec["intro"]


def section_head(sec, loc, n):
    h, intro = heading_of(sec, loc)
    return (f'<h2 id="{sec["key"]}">{h} <span class="muted small">{strings(loc)["count"].format(n)}</span></h2>\n'
            f'<p class="muted">{intro}</p>\n')


def video_section(sec, loc):
    s = strings(loc)
    items = []
    for v in sec["videos"]:
        url = f"https://www.youtube.com/watch?v={v['id']}"
        items.append(
            f'  <li><div class="t"><a href="{url}" rel="noopener noreferrer" target="_blank">{html.escape(v["title"])}</a></div>'
            f'<div class="c">{s["channel"]}<a href="{html.escape(v["channel_url"])}" rel="noopener noreferrer" target="_blank">{html.escape(v["channel"])}</a>'
            f' · {url}</div></li>'
        )
    return section_head(sec, loc, len(items)) + '<ul class="vlist">\n' + "\n".join(items) + "\n</ul>\n"


def article_section(sec, loc):
    s = strings(loc)
    items = []
    for a in sec["items"]:
        meta = html.escape(a["outlet"]) + (f" · {a['date']}" if a["date"] else "")
        if a.get("paywall"):
            meta += f' · <span class="tag">{s["paywall"]}</span>'
        url = html.escape(a["url"])
        items.append(
            f'  <li><div class="t"><a href="{url}" rel="noopener noreferrer" target="_blank">{html.escape(a["title"])}</a></div>'
            f'<div class="c">{meta} · {url}</div></li>'
        )
    return section_head(sec, loc, len(items)) + '<ul class="vlist">\n' + "\n".join(items) + "\n</ul>\n"


def auto_item(x, loc, kind):
    s = strings(loc)
    url = html.escape(x["url"])
    if kind == "videos":
        meta = f'{s["channel"]}<a href="{html.escape(x["channel_url"])}" rel="noopener noreferrer" target="_blank">{html.escape(x["channel"])}</a>'
    else:
        meta = html.escape(x.get("outlet", ""))
    if x.get("date"):
        meta += f" · {x['date']}"
    return (f'  <li><div class="t"><a href="{url}" rel="noopener noreferrer" target="_blank">{html.escape(x["title"])}</a></div>'
            f'<div class="c">{meta} · {url}</div></li>')


def latest_block(auto, loc, n_cdt):
    s = strings(loc)
    out = []
    for kind, label, limit in (("articles", s["l_articles"], 100), ("videos", s["l_videos"], 100), ("cdt", s["l_cdt"], 20)):
        items = sorted(auto.get(kind, []), key=lambda x: (x.get("added", ""), x.get("date", "")), reverse=True)
        if kind == "cdt":
            items = [x for x in items if x.get("added") != "archive"] or sorted(auto.get(kind, []), key=lambda x: x.get("date", ""), reverse=True)
        out.append(f'<h2 id="{kind}">{label} <span class="muted small">{s["count"].format(len(items[:limit]))}</span></h2>')
        out.append('<ul class="vlist">\n' + ("\n".join(auto_item(x, loc, kind) for x in items[:limit]) or f'  <li class="muted">{s["l_none"]}</li>') + "\n</ul>")
        if kind == "cdt":
            out.append(f'<p class="small"><a href="cdt.html">{s["l_more"].format(n_cdt)}</a></p>')
    return "\n".join(out) + "\n"


def cdt_block(auto, loc):
    s = strings(loc)
    by_year = {}
    for x in sorted(auto.get("cdt", []), key=lambda x: x.get("date", ""), reverse=True):
        by_year.setdefault((x.get("date") or "????")[:4], []).append(x)
    toc_ = '<p class="toc">' + " · ".join(f'<a href="#y{y}">{y}</a>' for y in by_year) + "</p>\n"
    parts = [toc_]
    for y, items in by_year.items():
        parts.append(f'<h2 id="y{y}">{y} <span class="muted small">{s["count"].format(len(items))}</span></h2>')
        parts.append('<ul class="vlist">\n' + "\n".join(
            f'  <li><div class="t"><a href="{html.escape(x["url"])}" rel="noopener noreferrer" target="_blank">{html.escape(x["title"])}</a></div>'
            f'<div class="c">{x.get("date", "")} · {html.escape(x["url"])}</div></li>' for x in items) + "\n</ul>")
    return "\n".join(parts) + "\n"


def toc(sections, loc):
    return '<p class="toc">' + " · ".join(f'<a href="#{s["key"]}">{heading_of(s, loc)[0]}</a>' for s in sections) + "</p>\n"


def main():
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()
    shutil.copytree(ROOT / "assets", DIST / "assets", ignore=shutil.ignore_patterns("videos.json", "articles.json", "auto.json"))
    for f in ("_headers", "_redirects", "robots.txt"):
        shutil.copy(ROOT / f, DIST / f)

    videos = json.loads((ROOT / "assets/videos.json").read_text())
    articles = json.loads((ROOT / "assets/articles.json").read_text())
    n_videos = sum(len(sec["videos"]) for sec in videos)
    n_articles = sum(len(sec["items"]) for sec in articles)
    auto_path = ROOT / "assets/auto.json"
    auto = json.loads(auto_path.read_text()) if auto_path.exists() else {"videos": [], "articles": [], "cdt": []}
    n_cdt = len(auto.get("cdt", []))
    auto_updated = max([x.get("added", "") for k in auto for x in auto[k] if x.get("added") != "archive"] or [UPDATED])

    count = 0
    for loc, conf in LOCALES.items():
        lists = {
            "{{VIDEOS}}": toc(videos, loc) + "\n".join(video_section(sec, loc) for sec in videos),
            "{{ARTICLES}}": toc(articles, loc) + "\n".join(article_section(sec, loc) for sec in articles),
            "{{LATEST}}": latest_block(auto, loc, n_cdt),
            "{{CDT_ALL}}": cdt_block(auto, loc),
        }
        for file in FILES + ["404.html"]:
            body = (ROOT / "pages" / conf["src"] / file).read_text()
            body = (body.replace("{{VIDEO_COUNT}}", str(n_videos)).replace("{{ARTICLE_COUNT}}", str(n_articles))
                    .replace("{{CDT_COUNT}}", str(n_cdt)).replace("{{AUTO_UPDATED}}", auto_updated))
            if loc == "zh-hant":
                body = to_hant(body)
            if loc != "en":
                body = keep_dates_together(body)
            # 视频和报道列表最后插入：标题保持原文
            for k, v in lists.items():
                body = body.replace(k, v)
            page = pretty_links(layout(loc, file, body))
            if file == "404.html":
                # 404 页可能出现在任意深度的路径下，站内链接全部改成绝对路径
                page = re.sub(r'(href|src)="(?:\.\./)*(?!https?:|/|#)(?:\./)?', r'\1="/', page)
            out = DIST / conf["prefix"] / file
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(page)
            count += 1

    urls = "\n".join(
        f"  <url><loc>{url_of(loc, f)}</loc><lastmod>{UPDATED}</lastmod>"
        + "".join(f'<xhtml:link rel="alternate" hreflang="{LOCALES[l]["lang"]}" href="{url_of(l, f)}"/>' for l in LOCALES)
        + "</url>"
        for loc in LOCALES for f in FILES
    )
    (DIST / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
        f'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n{urls}\n</urlset>\n')
    print(f"built {count} pages ({len(LOCALES)} languages), {n_videos} videos, {n_articles} articles → {DIST}")


if __name__ == "__main__":
    main()
