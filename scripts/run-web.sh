#!/bin/bash
# kb-studio web 生产进程启动脚本（由 launchd 托管，常驻 + 崩溃自拉起）。
# 端口 10017，经 Cloudflare Tunnel 暴露为 https://kb-studio.heartbeat.ren
set -euo pipefail

REPO="/Users/jerry/srv/kb-studio"
# node(nvm) + docker(Docker Desktop) + 系统路径：解析子进程要能调 docker，LLM 要走 Clash
export PATH="/Users/jerry/.nvm/versions/node/v24.15.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$REPO/apps/web"
exec "$REPO/node_modules/.bin/next" start -p 10017
