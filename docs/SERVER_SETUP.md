# Server Setup — cloud access for your workers

## Deploy (one VM, ~$20–40/mo: Hetzner / DigitalOcean / Lightsail; 4GB+ RAM)

```bash
git clone <repo> && cd SOLAR-Proj && npm install
npx playwright install --with-deps chromium
```

Create `/etc/solar-autopilot.env` (chmod 600):
```
AUTH_ENABLED=true
ADMIN_EMAIL=you@company.com
ADMIN_PASSWORD=<strong password>        # first login; change after
ANTHROPIC_API_KEY=sk-ant-...
AUTOPILOT_DB_PATH=/var/lib/solar/autopilot.db   # persistent disk
HEADLESS=true
PORT=4000
```

systemd unit (`/etc/systemd/system/solar.service`):
```
[Service]
WorkingDirectory=/opt/SOLAR-Proj
EnvironmentFile=/etc/solar-autopilot.env
ExecStart=/usr/bin/npx tsx backend/src/server.ts
Restart=always
[Install]
WantedBy=multi-user.target
```

HTTPS front door (Caddy — automatic certificates):
`caddy reverse-proxy --from autopilot.yourco.com --to localhost:4000`

Rules: ONE instance only (SQLite). Backups: the built-in scheduler snapshots
the DB (`POST /api/admin/backup`, `GET /api/admin/backups`); add an off-box
copy (restic → S3) of the data dir nightly. Updates: `git pull && npm install
&& npm run smoke && systemctl restart solar` — migrations self-apply.
NEVER run with AUTH_ENABLED unset on a public interface (the server logs a
warning for a reason).

## Employee logins

- Log in as admin (ADMIN_EMAIL/PASSWORD) at the dashboard → session cookie.
- Create workers: `POST /api/users {"email","name","password"}` (or the
  dashboard Users panel); per-org users for SaaS customers:
  `POST /api/orgs/:id/users`. Passwords hashed; API keys sha256 + shown once.
- Assign projects per user (`projects.assigned_user_id`, dashboard selector).
- `/api/auth/login` / `/api/auth/logout`; everything else 401s without a
  session or `x-api-key`.

## Client-facing links (work without a login — safe to send)

- **Project status page**: dashboard → "Share status link" →
  `https://<host>/status?token=…` backed by `/api/public/status/:token`
  (revocable per project; token-scoped, read-only, no PII beyond status).
- **Review reports**: shareable read-only report links per review submission
  (`/api/public/review/...`) — what an AHJ/applicant sees from the Plan
  Review product.
- Both paths are explicitly exempted in `auth.ts` (`/api/public/`); anything
  new that clients should see belongs under that prefix.

## Recording portals after the move

The human "record this portal" capture runs on an operator's LOCAL machine
(needs a visible browser) and talks to the server API — set the server URL in
the record command the dashboard generates. Learning/staging runs headless on
the server itself.
