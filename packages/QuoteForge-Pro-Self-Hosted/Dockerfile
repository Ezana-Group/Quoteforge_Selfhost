FROM node:20-alpine

WORKDIR /app

# "mqtt" (live Bambu Lab status) is an optional dependency — installed here by
# default; the app still runs if it's missing. Dev/test packages are skipped.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# Jobs/settings persist here — mount a volume at this path (see
# docker-compose.yml) so data survives container restarts/upgrades.
ENV DATA_DIR=/data
ENV PORT=8080
# A container must listen on all its interfaces to be reachable from outside
# (the app is loopback-only by default when run directly). There is no login,
# so keep it on a private network or behind your own auth.
ENV HOST=0.0.0.0
RUN mkdir -p /data && chown node:node /data

# Run as the unprivileged "node" user, not root.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q --spider http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "server.js"]
