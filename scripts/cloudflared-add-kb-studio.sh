#!/bin/bash
# 给共享的 Cloudflare Tunnel 加一条 ingress：kb-studio.heartbeat.ren -> localhost:10017
# 需 root 运行：  sudo bash scripts/cloudflared-add-kb-studio.sh
# 幂等：已存在则跳过；会先备份 /etc/cloudflared/config.yml 再改，最后校验+重启守护进程。
set -euo pipefail

CONF="/etc/cloudflared/config.yml"
CFD="/opt/homebrew/bin/cloudflared"
HOST="kb-studio.heartbeat.ren"
PORT="10017"

if [ "$(id -u)" -ne 0 ]; then echo "请用 sudo 运行：sudo bash $0"; exit 1; fi

if grep -q "$HOST" "$CONF"; then
  echo "✓ $HOST 已在 $CONF 中，无需重复添加"
else
  cp "$CONF" "$CONF.bak.$(date +%Y%m%d%H%M%S)"
  echo "✓ 已备份 $CONF"
  # 在 http_status:404 兜底规则之前插入新 ingress
  awk -v host="$HOST" -v port="$PORT" '
    /http_status:404/ && !done {
      print "  - hostname: " host;
      print "    service: http://localhost:" port;
      done=1
    }
    { print }
  ' "$CONF" > "$CONF.new"
  mv "$CONF.new" "$CONF"
  echo "✓ 已写入 ingress: $HOST -> http://localhost:$PORT"
fi

echo "=== 校验配置 ==="
"$CFD" tunnel ingress validate --config "$CONF"

echo "=== 重启 cloudflared 守护进程 ==="
launchctl kickstart -k system/com.cloudflare.cloudflared
sleep 2
echo "=== 新 ingress 生效后的路由表 ==="
grep -A1 "$HOST" "$CONF" || true
echo "✓ 完成。稍等 DNS/边缘生效后访问 https://$HOST"
