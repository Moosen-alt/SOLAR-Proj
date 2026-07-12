# Server Setup — cloud access for your workers

## Local machine setup (Windows / Mac dev or operator workstation)

1. Install Node 20+ (nodejs.org LTS) and Git.
2. ```
   git clone <repo> SOLAR-Proj && cd SOLAR-Proj
   npm install
   npx playwright install chromium
   ```
3. Create `.env` in the repo root (gitignored):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   SESSION_ENCRYPTION_KEY=<any long random string — keep it; it locks stored portal logins>
   ```
   (Local dev can skip AUTH_ENABLED; NEVER skip it on anything reachable
   from outside the machine.)
4. `npm run dev` → dashboard at http://localhost:4000. `npm run smoke` to
   verify the install.
5. Updating: `git pull && npm install && npm run smoke` — DB migrations
   apply themselves on next start. Your DB lives at backend/data/ (or
   AUTOPILOT_DB_PATH); back it up before big pulls.
6. Windows notes: run commands in PowerShell; if `npx tsx` complains about
   execution policy, `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
   Portal RECORDING (visible browser) always runs on a local machine like
   this — use the "Record this portal" button's generated command/.bat.


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
SESSION_ENCRYPTION_KEY=<openssl rand -hex 32>   # portal credentials at rest — LOSING THIS LOSES STORED LOGINS
ALLOWED_ORIGINS=https://autopilot.yourco.com     # lock CORS to your domain
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

## Stripe — collecting client payments (per-submission billing)

Today (no code needed):
1. Create a Stripe account → Payment Links (or Invoices) for your common
   totals, or create one ad-hoc per quote (the Payment screen shows the
   client total = real permit fees + your service fee).
2. Send the client the link; when Stripe shows it paid, click **Mark paid**
   on the project's Payment panel and paste the Stripe payment/invoice id
   into the reference field — it lands in `submission_payments.payment_reference`
   and the staging gate unlocks. Waive covers comped jobs.

When you want it automatic (small build, ~a day):
- `npm i stripe`; env `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`.
- On quote: create a Checkout Session/Payment Link for `totalUsd`, store its
  id on the payment row, show the URL on the Payment panel.
- Webhook `POST /api/public/stripe/webhook` (public prefix, signature-verified
  with the webhook secret): on `checkout.session.completed`, call
  `markSubmissionPaid` with the session id as the reference. Never trust the
  client side — only the signed webhook marks paid.
- SaaS metering later: Stripe usage records wired into `checkReviewQuota`.
