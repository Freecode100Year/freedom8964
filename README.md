# freedom8964.com

六四事件相关信息的采集、整理与归档导航站。本站不生产内容，每条记录都指向原始出处。
A directory for collecting, organising and archiving information about the 1989 Tiananmen Square protests and massacre. Every record points to its original source.

网站：https://freedom8964.com （简体 / 繁體 / English）

## 结构

| 路径 | 作用 |
|---|---|
| `pages/zh/`、`pages/en/` | 页面正文（简体、英文）；繁體在构建时由简体自动转换（OpenCC） |
| `assets/videos.json` | 影像栏目：经 YouTube oEmbed 核实的视频链接 |
| `assets/articles.json` | 报道栏目：媒体报道与政府声明（只收标题和网址） |
| `assets/auto.json` | 自动采集的中国数字时代文章 |
| `build.py` | 生成静态网站到 `dist/` |
| `worker.js` | Cloudflare Worker，网站的全部自动化都在这里，不依赖任何服务器：每天美东 3:00 采集（Durable Object 闹钟）新闻订阅源、YouTube 官方频道与六四播放列表、媒体专题栏目（`collect/topic_sources.json`）、维基分类（`collect/wiki_sources.json`）、中国数字时代官方订阅源（白天另每 2 小时检查）；X（推特）已于 2026-10-08 停止采集，已收录帖文保留；每条新链接先实际打开核实，打不开次日重试，连续 3 天打不开不收；结果存 KV，访问时插入“最新收录”“媒体专题存档”“维基资料”“中国数字时代”“报道”页；每周六死链检查、每周日提交互联网档案馆；Telegram 日报 |
| `.github/workflows/backup.yml` | GitHub Actions：每天把网站自动采集的数据（`/__export.json`）备份到 `collect/kv-backup/`，网站超过 2 天没采集则运行失败（GitHub 发邮件提醒） |
| `collect/` | 人工整理与旧版工具：`sync_known.py`（改了资料后同步已收录名单并生成来源配置，需重新部署）、`manual/`（核实与并入工具）、`collect.py` 等（旧的服务器端采集，已停用） |

## 构建与部署

```bash
sudo apt install python3-opencc      # 繁體转换
python3 build.py                     # 生成 dist/
npx wrangler deploy                  # 部署到 Cloudflare（静态资源 + Worker）
```

Worker 需要的密钥：`TG_BOT_TOKEN`、`TG_CHAT_ID`（采集完成通知，可选）、`COLLECT_KEY`（手动触发采集，可选）。KV 命名空间和 Durable Object 见 `wrangler.jsonc`。

## 收录原则

- 每条记录都有出处；存在分歧时并列各方说法，不做取舍。
- 报道和视频只收录标题和链接，不转载正文和影像，版权归原作者和原发布方。
- 自动采集只从白名单来源、按关键词收录；尊重来源网站的访问限制，不绕过人机验证。
- 网站不使用 Cookie，不做访问统计，不加载第三方脚本。

## 许可

代码以 MIT 许可发布（见 `LICENSE`）。所收录的标题、链接指向的内容，版权归原作者和原发布方。
