FROM node:22-alpine

LABEL org.opencontainers.image.title="math-mistake-coach" \
      org.opencontainers.image.description="六年级数学错题教练（本地 SQLite）" \
      org.opencontainers.image.version="0.18.0"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/app/data/learning.sqlite \
    TZ=Asia/Shanghai

WORKDIR /app

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN apk add --no-cache fontconfig \
    && npm install --global pnpm@11.25.0 --no-audit --no-fund \
    && pnpm install --prod --frozen-lockfile --libc musl \
    && chown -R node:node /app/node_modules

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts

RUN mkdir -p /usr/share/fonts/truetype/eink \
    && cp /app/src/eink/fonts/*.ttf /usr/share/fonts/truetype/eink/ \
    && fc-cache -f \
    && mkdir -p /app/data \
    && chown -R node:node /app/data

USER node
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
