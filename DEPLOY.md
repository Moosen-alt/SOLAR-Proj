# Deploying Solar Submission Autopilot (beta)

This is a single Node service: an Express API that also serves the static
dashboard/parser UI, backed by a local SQLite database. There is no separate
frontend build — the `frontend/` files are served directly.

---

## 1. Prerequisites

- **Node 20+** (the image uses Node 22), or **Docker**.
- A long random **`SESSION_ENCRYPTION_KEY`** (required — encrypts stored portal
  login blobs). Generate one: `openssl rand -hex 32`.
- *(Optional, for AI)* an **`ANTHROPIC_API_KEY`** (`sk-ant-...`) **with billing/credits
  enabled** at console.anthropic.com → Settings → Billing. Without it the app runs
  fine in "stub" mode (regex/OCR parsing, no AI extraction or drafting).

---

## 2. Configure

```bash
cp .env.example .env
# edit .env — at minimum set SESSION_ENCRYPTION_KEY; add ANTHROPIC_API_KEY for AI
```

`.env` is gitignored and is **never** committed or baked into the Docker image.
Key variables (see `.env.example` for the full list):

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 4173) |
| `AUTOPILOT_DB_PATH` | SQLite file path (default `backend/data/autopilot.sqlite`) |
| `SESSION_ENCRYPTION_KEY` | **Required.** Encrypts portal storage-state blobs |
| `ANTHROPIC_API_KEY` | Enables Claude AI (vision parsing, extraction, drafting) |
| `AUTH_ENABLED` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Turn on dashboard login |
| `LOG_LEVEL` | `error\|warn\|info\|debug` (default info) |
| `BACKUP_DIR` / `BACKUP_KEEP` / `BACKUP_INTERVAL_HOURS` | Automated DB snapshots |

---

## 3. Run

### Option A — Docker (recommended)

```bash
docker compose up -d --build
```

- Serves on `http://localhost:${PORT:-4173}`.
- The SQLite DB + backups persist in the named volume `solar-data`
  (mounted at `/app/backend/data`).
- Container health is wired to `/health`; `docker ps` shows healthy/unhealthy.

Plain Docker (no compose):

```bash
docker build -t solar-submission-autopilot .
docker run -d --name solar -p 4173:4173 --env-file .env \
  -v solar-data:/app/backend/data solar-submission-autopilot
```

### Option B — bare Node

```bash
npm ci
npm start          # = tsx backend/src/server.ts
```

Run it under a process manager (systemd, pm2) so it restarts on crash/reboot.
`tsx` is a runtime dependency, so `npm ci --omit=dev` is also fine for production.

---

## 4. Verify it's up

```bash
curl localhost:4173/health           # {"ok":true,...}
curl localhost:4173/api/diagnostics  # full JSON: config, data counts, warnings
```

The **startup banner** in the logs summarizes everything (LLM on/off, auth,
DB path/size, data counts) and lists warnings (e.g. missing key, default
session secret). Every request logs one line; 5xx errors print a boxed,
copy-pasteable block. Paste `/api/diagnostics` output when troubleshooting.

---

## 5. Production checklist

- [ ] `SESSION_ENCRYPTION_KEY` set to a real random value (not the placeholder).
- [ ] `ANTHROPIC_API_KEY` set **and the Anthropic account has credit** (else AI is off).
- [ ] `AUTH_ENABLED=true` with admin creds if the dashboard is internet-facing.
- [ ] Terminate TLS in front (reverse proxy: Caddy/nginx/Cloudflare). Set
      `AUTH_COOKIE_SECURE=true` when served over HTTPS.
- [ ] The data volume is backed up (the app also snapshots to `BACKUP_DIR`).
- [ ] Resource note: SQLite is single-writer — run **one** app instance against
      one DB file. Scale vertically; the project list, KB, and job queue are
      indexed for thousands of projects.

### Security model (built in)
- Automation never clicks final submit, pays fees, or solves MFA/CAPTCHA — a
  human does the final submission. LLM output is advisory only.
- The knowledge base stores aggregated AHJ/utility requirements and correction
  patterns — **not** account/meter numbers, passwords, tokens, or portal secrets.
- Account/meter numbers are extracted into the project record (to fill forms)
  but are never logged. Request logging redacts sensitive query keys.

---

## 6. Updating

```bash
git pull
docker compose up -d --build      # or: npm ci && restart the service
```

The SQLite schema self-migrates on boot (new columns/indexes are added
idempotently); your data in the volume is preserved.
