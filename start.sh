#!/usr/bin/env bash
# 一键启动:NapCat(QQ 客户端)+ AI 机器人
set -e
cd "$(dirname "$0")"

# 缺失的系统库(非 root 环境,用本地解压的)
export LD_LIBRARY_PATH="$PWD/libs/extract/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export DISPLAY="${DISPLAY:-:0.0}"
# QQ 数据目录重定向到工作区(避免系统分区只读导致无法登录)
export XDG_CONFIG_HOME="$PWD/qqconfig"

# 机器人 QQ 号(已登录过则自动快速登录,无需再扫码)
ACCOUNT="${ACCOUNT:-}"  # 填写你的机器人QQ号(填了可免扫码快速登录)

# 1) 启动 QQ/NapCat(后台)
if ! pgrep -f "qqroot/opt/QQ/qq" >/dev/null; then
  echo "[start] 启动 NapCat(QQ 客户端)..."
  nohup "$PWD/qqroot/opt/QQ/qq" --no-sandbox -q "$ACCOUNT" > "$PWD/napcat-run.log" 2>&1 &
  echo "[start] NapCat 日志: napcat-run.log"
  echo "[start] NapCat WebUI: http://127.0.0.1:6099 (扫码登录)"
else
  echo "[start] NapCat 已在运行"
fi

# 2) 启动 AI 机器人(前台, Ctrl+C 退出)
echo "[start] 启动 AI 机器人..."
cd "$PWD/bot" && exec npm start
