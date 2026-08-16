#!/usr/bin/env bash
# 一键启动:NapCat(QQ 客户端)+ 网关(常驻)+ 反应模块(AI)
set -e
cd "$(dirname "$0")"

# 缺失的系统库(非 root 环境,用本地解压的)
export LD_LIBRARY_PATH="$PWD/libs/extract/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export DISPLAY="${DISPLAY:-:0.0}"
# QQ 数据目录重定向到工作区(避免系统分区只读导致无法登录)
export XDG_CONFIG_HOME="$PWD/qqconfig"

# 机器人 QQ 号(已登录过则自动快速登录,无需再扫码)
ACCOUNT="${ACCOUNT:-}"  # 填写你的机器人QQ号

# 1) 启动 QQ/NapCat(后台)
if ! pgrep -f "qqroot/opt/QQ/qq" >/dev/null; then
  echo "[start] 启动 NapCat(QQ 客户端)..."
  nohup "$PWD/qqroot/opt/QQ/qq" --no-sandbox -q "$ACCOUNT" > "$PWD/napcat-run.log" 2>&1 &
  echo "[start] NapCat 日志: napcat-run.log"
  echo "[start] NapCat WebUI: http://127.0.0.1:6099 (扫码登录)"
else
  echo "[start] NapCat 已在运行"
fi

# 2) 启动常驻网关(后台,勿重启)
if ! pgrep -f "gateway[.]mjs" >/dev/null; then
  echo "[start] 启动网关(常驻)..."
  cd "$PWD/bot" && nohup node src/gateway.mjs > gateway.log 2>&1 &
  cd "$PWD"
  echo "[start] 网关日志: bot/gateway.log"
else
  echo "[start] 网关已在运行"
fi

# 2.5) 启动本地视觉模型服务(后台,图片识别用)
LLAMA_SERVER="${LLAMA_SERVER:-llama-server}"   # 指向你的 llama.cpp 构建(如 /path/to/llama.cpp/build/bin/llama-server)
if ! pgrep -f "llama-server.*8080" >/dev/null; then
  echo "[start] 启动本地视觉模型(Qwen3-VL)..."
  export LD_LIBRARY_PATH="$PWD/libs/extract/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  nohup "$LLAMA_SERVER" \
    -m "$PWD/vlm/Qwen3VL-4B-Instruct-Q4_K_M.gguf" \
    --mmproj "$PWD/vlm/mmproj-Qwen3VL-4B-Instruct-F16.gguf" \
    --host 127.0.0.1 --port 8080 -ngl 99 --ctx-size 8192 \
    > "$PWD/vlm/server.log" 2>&1 &
  echo "[start] 视觉模型日志: vlm/server.log"
else
  echo "[start] 视觉模型已在运行"
fi

# 2.6) 启动离线告警监控(后台)
if ! pgrep -f "watchdo[g].mjs" >/dev/null; then
  echo "[start] 启动离线告警监控..."
  cd "$PWD/bot" && nohup node src/watchdog.mjs > watchdog.log 2>&1 &
  cd "$PWD"
  echo "[start] 监控日志: bot/watchdog.log"
else
  echo "[start] 离线监控已在运行"
fi

# 3) 启动反应模块(AI,前台, Ctrl+C 退出;重启它不影响登录)
echo "[start] 启动反应模块(AI)..."
cd "$PWD/bot" && exec npm start
