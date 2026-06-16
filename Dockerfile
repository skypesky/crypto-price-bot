# ============================================================
# Stage 1: server deps（包含 devDeps 用于构建）
# ============================================================
FROM mirror.gcr.io/library/node:22.20-alpine AS deps-server
WORKDIR /app/server
RUN apk add --no-cache python3 make g++ libc6-compat
COPY server/package.json server/package-lock.json* ./
RUN npm install --no-audit --no-fund

# ============================================================
# Stage 2: web deps
# ============================================================
FROM mirror.gcr.io/library/node:22.20-alpine AS deps-web
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund

# ============================================================
# Stage 3: server build (TypeScript → JS)
# ============================================================
FROM deps-server AS build-server
WORKDIR /app/server
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ============================================================
# Stage 4: web build (Vite → 静态文件到 server/src/static)
# ============================================================
FROM deps-web AS build-web
WORKDIR /app/web
COPY web/ ./
RUN npm run build

# ============================================================
# Stage 5: runner（生产镜像）
# ============================================================
FROM mirror.gcr.io/library/node:22.20-alpine AS runner
ENV NODE_ENV=production \
    PORT=8787 \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8

WORKDIR /app

# tini 作为 PID 1，优雅转发信号
RUN apk add --no-cache tini wget

# 后端 dist + node_modules
COPY --from=build-server /app/server/dist ./dist
COPY --from=build-server /app/server/node_modules ./node_modules
COPY --from=build-server /app/server/package.json ./

# 前端静态资源（Vite build 产物）
COPY --from=build-web /app/server/src/static ./src/static

# 数据目录
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8787

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

# OCI labels
LABEL org.opencontainers.image.title="crypto-price-bot" \
      org.opencontainers.image.description="定时拉取加密货币价格并通过 Telegram / 飞书推送的机器人，内置 Web Dashboard" \
      org.opencontainers.image.source="https://github.com/skypesky/crypto-price-bot" \
      org.opencontainers.image.licenses="ISC"