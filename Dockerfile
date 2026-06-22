# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Solar Submission Autopilot — production image
# Includes Playwright/Chromium for portal automation (headless, cloud-ready).
# ---------------------------------------------------------------------------

# ---- builder: install production deps (incl. native better-sqlite3) -------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production

# System deps for Playwright's Chromium on Debian bookworm.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libnspr4 libnss3 \
      libatk1.0-0 libatk-bridge2.0-0 \
      libcups2 libdrm2 libgbm1 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 \
      libpango-1.0-0 libcairo2 libasound2 \
      procps \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY shared ./shared
COPY portal-bot ./portal-bot

# Playwright Chromium binary — stored at a fixed path outside node_modules
# so it survives volume mounts and is not duplicated per node_modules copy.
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-cache
RUN npx playwright install chromium 2>/dev/null || true

# Data dir for SQLite DB, backups, uploaded docs, portal profiles.
# Mount a persistent volume at /app/backend/data in production.
RUN mkdir -p backend/data backend/data/backups \
 && chown -R node:node /app

USER node

EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4173)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
