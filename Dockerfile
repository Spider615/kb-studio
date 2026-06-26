# kb-studio 解析沙箱：Node（跑自集成的 Claude Code / Agent SDK）+ Python 解析库。
# 不可信文件在这个容器里解析，碰不到宿主机；模型调用走 302（运行时 --env-file .env 注入）。
FROM node:20-bookworm-slim

# 可选构建代理（VM 内拉 npm/pypi/debian 若被墙，build 时 --build-arg HTTPS_PROXY=... 传入）
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

# 系统 + Python 解析库（venv 避开 Debian PEP668）
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV VENV=/opt/venv
RUN python3 -m venv "$VENV"
ENV PATH="$VENV/bin:$PATH"
RUN pip install --no-cache-dir \
      pdfplumber pypdf python-docx openpyxl pandas pillow

WORKDIR /app

# 先装 npm 依赖（利用层缓存）：workspaces 需要所有 package.json 先就位
COPY package.json package-lock.json* tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json     packages/core/package.json
COPY packages/db/package.json       packages/db/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY apps/worker/package.json       apps/worker/package.json
RUN npm install --no-audit --no-fund

# 源码
COPY packages ./packages
COPY apps ./apps

# 非 root + 可写 HOME（Claude Code 放配置/缓存）+ 输入挂载点 /work
RUN useradd -m -u 10001 app \
    && mkdir -p /home/app/.claude /work \
    && chown -R app:app /app /home/app /work
ENV HOME=/home/app
USER app

# docker run <image> <文件路径> → 解析该文件并把 markdown 打到 stdout
ENTRYPOINT ["npx", "tsx", "apps/worker/src/cli/parse-one.ts"]
