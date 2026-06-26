#!/usr/bin/env bash
# 在锁死容器里用自集成的 Claude Code 解析一个文件（模型走 302）。
# 用法: scripts/parse-in-sandbox.sh <文件路径>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILE="${1:?用法: scripts/parse-in-sandbox.sh <文件路径>}"
ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
NAME="$(basename "$FILE")"
IMAGE="${KB_SANDBOX_IMAGE:-kb-sandbox:latest}"

# 加固：非 root（镜像里已是 app 用户）、丢掉所有 capabilities、禁提权、
# 限 pids/内存/CPU、/tmp 用 tmpfs、输入只读挂载。
exec docker run --rm \
  --env-file "$ROOT/.env" \
  -e ANTHROPIC_API_KEY="" \
  -e HTTPS_PROXY="${SANDBOX_PROXY:-http://host.docker.internal:7897}" \
  -e HTTP_PROXY="${SANDBOX_PROXY:-http://host.docker.internal:7897}" \
  -e NO_PROXY="localhost,127.0.0.1" \
  -v "$ABS:/work/$NAME:ro" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 256 \
  --memory 3g --cpus 2 \
  --tmpfs /tmp:rw,size=512m \
  "$IMAGE" "/work/$NAME"
