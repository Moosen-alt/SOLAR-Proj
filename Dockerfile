# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Solar Submission Autopilot — production image
# Multi-stage: a builder compiles native deps (better-sqlite3), the runtime
# stage is a slim image that runs the server via tsx.
# ---------------------------------------------------------------------------

# ---- builder: install production deps (incl. native better-sqlite3) -------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
# Toolchain for native modules when no prebuilt binary is available.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY shared ./shared
# Data dir for the SQLite DB + backups — mount a volume here to persist.
RUN mkdir -p backend/data backend/data/backups && chown -R node:node /app
USER node
EXPOSE 4173
# Container health: the app's /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4173)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
