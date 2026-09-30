#!/bin/bash
# 把 freedom8964.com 各页面提交到互联网档案馆（Wayback Machine）存档。每周由 systemd 定时器运行。
for p in "" timeline victims documents hongkong museum videos reports candle about en/ en/timeline en/videos en/reports zh-hant/ zh-hant/timeline zh-hant/videos zh-hant/reports; do
  code=$(curl -s -o /dev/null -m 120 -w '%{http_code}' "https://web.archive.org/save/https://freedom8964.com/$p")
  echo "$(date '+%F %T') /$p → $code"
  sleep 20   # 匿名提交有频率限制
done >> ~/archive-freedom8964.log
