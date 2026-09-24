#!/usr/bin/env python3
"""生成 freedom8964.com 静态网站到 dist/。页面正文在 pages/*.html，这里统一套上头尾。"""
import html
import re
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).parent
DIST = ROOT / "dist"
SITE = "https://freedom8964.com"
UPDATED = "2026-09-24"

NAV = [
    ("index.html", "首页"),
    ("timeline.html", "时间线"),
    ("victims.html", "遇难者"),
    ("documents.html", "史料"),
    ("hongkong.html", "香港烛光"),
    ("videos.html", "影像"),
    ("candle.html", "点一支蜡烛"),
    ("about.html", "关于"),
    ("en/index.html", "English"),
]

# (文件名, 标题, 描述)
PAGES = [
    ("index.html", "自由 · 八九六四", "记住 1989 年春天的北京：时间线、遇难者、史料与影像。每一条都注明出处。"),
    ("timeline.html", "时间线：1989 年春夏", "从胡耀邦逝世到六四清场与通缉，逐日记录，附来源。"),
    ("victims.html", "遇难者与天安门母亲", "他们有名字。天安门母亲群体三十多年的寻访与记录。"),
    ("documents.html", "史料与解密档案", "死亡人数的各方说法、解密外交电报与可查阅的原始资料。"),
    ("hongkong.html", "香港维园烛光：1990–2019", "三十年的烛光，以及它如何被禁止。"),
    ("videos.html", "影像：经核实的 YouTube 视频", "来自新闻机构、公共媒体与人权组织官方频道的视频，按六四事件、亲历者、黄雀行动、天安门母亲、香港、各地纪念分类，逐一核实标题、频道与链接。"),
    ("candle.html", "点一支蜡烛", "为 1989 年的遇难者点一支蜡烛。不收集任何数据。"),
    ("about.html", "关于本站", "编辑原则、来源标准、更正方式与隐私说明。"),
    ("en/index.html", "Freedom · June Fourth 1989", "Remembering Beijing, spring 1989: timeline, victims, sources and verified video."),
]


def layout(path, title, desc, body):
    depth = path.count("/")
    up = "../" * depth
    nav = "\n".join(
        f'      <a href="{up}{href}"{" aria-current=\"page\"" if href == path else ""}>{label}</a>'
        for href, label in NAV
    )
    lang = "en" if path.startswith("en/") else "zh-Hans"
    full_title = title if path == "index.html" else f"{title} — freedom8964"
    return f"""<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(full_title)}</title>
<meta name="description" content="{html.escape(desc)}">
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="{SITE}/{path.replace('index.html', '').removesuffix('.html')}">
<meta name="theme-color" content="#0e0d0c">
<link rel="icon" href="{up}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{up}assets/style.css">
</head>
<body>
<header class="site-head">
  <div class="wrap">
    <a class="brand" href="{up}index.html">freedom<b>8964</b></a>
    <nav class="nav" aria-label="主导航">
{nav}
    </nav>
  </div>
</header>
{body}
<footer class="site-foot">
  <div class="wrap">
    <p>本站为非营利的历史记忆档案。所有史实均注明公开来源；视频仅提供链接，版权归原发布方。</p>
    <p>不使用 Cookie，不做任何访问统计。最后更新：{UPDATED} · <a href="{up}about.html">编辑原则与更正</a></p>
  </div>
</footer>
</body>
</html>
"""


def keep_dates_together(text):
    """中文里“6 月 3 日”“17 岁”这类数字和单位之间换成不换行空格，手机上不会被拆到两行。只处理标签外的文字。"""
    def fix(chunk):
        chunk = re.sub(r"(\d) (?=[年月日时岁人位名部个份])", "\\1\u00a0", chunk)
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


def video_section(sec):
    items = []
    for v in sec["videos"]:
        url = f"https://www.youtube.com/watch?v={v['id']}"
        items.append(
            f'  <li><div class="t"><a href="{url}" rel="noopener noreferrer" target="_blank">{html.escape(v["title"])}</a></div>'
            f'<div class="c">频道：<a href="{html.escape(v["channel_url"])}" rel="noopener noreferrer" target="_blank">{html.escape(v["channel"])}</a>'
            f' · <span class="muted">{url}</span></div></li>'
        )
    return (f'<h2 id="{sec["key"]}">{sec["heading"]} <span class="muted small">（{len(sec["videos"])}）</span></h2>\n'
            f'<p class="muted">{sec["intro"]}</p>\n<ul class="vlist">\n' + "\n".join(items) + "\n</ul>\n")


def video_toc(sections):
    links = " · ".join(f'<a href="#{s["key"]}">{s["heading"]}</a>' for s in sections)
    return f'<p class="toc">{links}</p>\n'


def main():
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()
    shutil.copytree(ROOT / "assets", DIST / "assets", ignore=shutil.ignore_patterns("videos.json"))
    for f in ("_headers", "robots.txt"):
        shutil.copy(ROOT / f, DIST / f)

    videos = json.loads((ROOT / "assets/videos.json").read_text())
    total = sum(len(sec["videos"]) for sec in videos)
    extra = {"videos.html": video_toc(videos) + "\n".join(video_section(sec) for sec in videos)}

    for path, title, desc in PAGES:
        body = (ROOT / "pages" / path).read_text()
        body = body.replace("{{VIDEOS}}", extra.get(path, "")).replace("{{VIDEO_COUNT}}", str(total))
        if not path.startswith("en/"):
            body = keep_dates_together(body)
        out = DIST / path
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(pretty_links(layout(path, title, desc, body)))

    # 404 页可能出现在任意深度的路径下，所以站内链接全部改成绝对路径
    page404 = pretty_links(layout("404.html", "找不到页面", "页面不存在", (ROOT / "pages/404.html").read_text()))
    page404 = re.sub(r'(href|src)="(?!https?:|/)(?:\./)?', r'\1="/', page404)
    (DIST / "404.html").write_text(page404)
    urls = "\n".join(f"  <url><loc>{SITE}/{p.replace('index.html', '').removesuffix('.html')}</loc><lastmod>{UPDATED}</lastmod></url>" for p, _, _ in PAGES)
    (DIST / "sitemap.xml").write_text(f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}\n</urlset>\n')
    print(f"built {len(PAGES) + 1} pages, {total} videos → {DIST}")


if __name__ == "__main__":
    main()
