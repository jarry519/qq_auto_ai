#!/usr/bin/env bash
# 一次性准备脚本:解压 QQ、注入 NapCat 入口
set -e
cd "$(dirname "$0")"

QQROOT="$PWD/qqroot"
NAPCAT_DIR="$PWD/napcat"
QQ_APP="$QQROOT/opt/QQ/resources/app"

if [ ! -f "$QQROOT/linuxqq.deb" ]; then
  echo "[setup] 缺少 $QQROOT/linuxqq.deb,请先下载 QQ Linux 客户端"
  exit 1
fi

if [ ! -f "$QQROOT/opt/QQ/qq" ]; then
  echo "[setup] 解压 QQ 客户端..."
  dpkg-deb -x "$QQROOT/linuxqq.deb" "$QQROOT"
fi

echo "[setup] 注入 NapCat 入口 (loadNapCat.js)..."
cat > "$QQ_APP/loadNapCat.js" <<EOF
(async () => {await import('file://$NAPCAT_DIR/napcat.mjs');})();
EOF

echo "[setup] 修改 package.json main 指向..."
python3 - "$QQ_APP/package.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["main"] = "./loadNapCat.js"
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
print("[setup] package.json main ->", d["main"])
PY

echo "[setup] 完成!下一步: ./start.sh"
