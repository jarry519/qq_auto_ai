#!/usr/bin/env bash
# 只重启反应模块(AI),不影响 NapCat 登录态和网关。
# 改代码/配置后运行本脚本即可生效,无需重新登录 QQ。
set -e
cd "$(dirname "$0")"

echo "[restart] 停止旧反应模块..."
pkill -f "src/index[.]mjs" || true
sleep 1

echo "[restart] 启动新反应模块..."
cd "$PWD/bot"
if [ "$1" = "-b" ]; then
  nohup node src/index.mjs > reactor.log 2>&1 &
  echo "[restart] 后台运行,日志: bot/reactor.log"
else
  exec node src/index.mjs
fi
