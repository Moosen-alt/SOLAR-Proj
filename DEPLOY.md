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
| `SERVER_HOST` | Listen address. Default `127.0.0.1` (this machine only); the Docker image and `fly.toml` set `0.0.0.0`. With `AUTH_ENABLED` off, a non-loopback host refuses to start unless `ALLOW_UNAUTHENTICATED_NETWORK=1` |
| `AUTH_COOKIE_SECURE` / `AUTH_SESSION_HOURS` | Secure-cookie flag (HTTPS) + login lifetime |
| `MONITOR_INTERVAL_MINUTES` | How often permit/NEM checks + email tracker run (0 = off) |
| `SEED_TEST_INSTALLER` | Seed the TML test installer. **Set `false` in production.** |
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
docker build \
  --build-arg BUILD_SHA=$(git rev-parse --short HEAD) \
  --build-arg BUILD_DATE=$(git log -1 --format=%cI) \
  -t solar-submission-autopilot .
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

**Which version is running.** The version is the running code's own commit date plus
its short sha — `2026.09.24 · 0c466bb` — with `· pinned` when the code runs from a
different folder than the working directory, and `· uncommitted changes` when tracked
files differ from that commit. It is in the startup banner, one `INFO [build]` log
line, `/health` → `build`, `/api/diagnostics` → `build`, and the dashboard's
"Connected" label. It is read from git in the folder the code EXECUTES from
(`backend/src/buildInfo.ts`), not the working directory.

Without `.git` (the Docker image) it reads `BUILD_SHA` / `BUILD_DATE` (and an optional
`APP_VERSION`, used verbatim) from the environment — the build-args above set them.
Unstamped, it says `unknown build`, never a guessed number. `docker compose up --build`
does not pass the build-args; export them and add `args:` under `build:` in
`docker-compose.yml`, or set the env vars in `.env`. A set env value always wins over
git, so do not leave a stale `BUILD_SHA` in a bare-Node `.env`.

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
- [ ] `SEED_TEST_INSTALLER=false` so the TML test installer never appears
      alongside real clients.
- [ ] Rotate `SESSION_ENCRYPTION_KEY` and `ANTHROPIC_API_KEY` to fresh,
      production-only values before go-live (don't reuse dev/test secrets).
- [ ] `MONITOR_INTERVAL_MINUTES` set (default 15) so permit/NEM + email
      monitors run hands-off; or 0 to drive them manually.
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

## 6. Daily operating flow

The day-to-day job for a coordinator is **verify + final manual submit**. Everything
up to the portal review screen is automated:

1. **Intake** a project (parser UI or API) — homeowner, address, AHJ, utility,
   system specs. Assign the **submitting client** (installer) — staging is gated on
   a client with a CCB#, so the right contractor identity fills the portal.
2. **Upload documents** in the project detail: the **plan set** (`doc_type=plan_set`)
   and, for NEM, the **meter photo**. These are stored per-project on disk.
3. **QC + application docs** generate automatically.
4. **Build the upload package** (`POST /api/projects/:id/build-utility-package`):
   - `target=nem` → meter photo + SLD + site plan + inverter spec (utility NEM).
   - `target=permit` → full sheet split (ProjectDox AHJs).
   - Standard Accela/EnerGov AHJs take the **full plan set PDF** — no split needed.
5. **Stage the submission.** The bot routes to the right adapter automatically:
   Accela or PowerClerk by learned platform, else a **recorded recipe** for that
   AHJ/utility, else the mock. It logs in (using the client's stored portal
   credential), fills every field with that project's data, uploads the docs, and
   **stops at the review screen**.
6. **Human review + submit.** A coordinator verifies every field/file, handles any
   MFA/fee, and clicks the final Submit. **Automation never submits, pays, or solves
   MFA/CAPTCHA.**

The permit/NEM status monitors and email tracker then run on their own
(`MONITOR_INTERVAL_MINUTES`) — no manual polling. Status checks are
**recipe-first**: any portal the bot has learned gets an authenticated status
scrape with the client's stored login, falling back to the public tracking URL.

7. **Clients stay informed automatically.** When a monitored status CHANGES
   (permit issued, ready for issue, NEM approved, correction), the submitting
   client gets an email (configure `SMTP_*` in `.env`; without SMTP the update
   is recorded as a draft communication instead) including their **read-only
   status link** — a tokenized `/status` page showing address + application
   statuses, nothing sensitive. You can also copy that link any time with
   **Copy client status link** in the project detail.

---

## 7. Teaching the bot a new AHJ or utility portal

When the team hits a jurisdiction or utility that isn't on a known platform
(Accela/PowerClerk), **record it once** and the bot replays it for every future
project in that jurisdiction. This runs on an operator's machine (needs a browser +
the running app).

```bash
npm run portal:record -- \
  --scope ahj --ahj "City of Bend" --state OR \
  --url "https://aca-oregon.accela.com/oregon/" \
  --project <recordingProjectId> --profile ./.portal-profiles/bend
# (use --scope utility --utility "<name>" to teach a utility's NEM portal)
```

A headed browser opens. **Log in and complete the application up to — but not
including — the final Submit/Pay screen.** Every click, field fill, dropdown,
checkbox, and file upload is captured. When done, return to the terminal and type
**`save`**.

- **Automatic data binding.** Values you type that match the recording project's
  data are bound to that field on the spot. Anything the exact match misses (e.g. a
  reformatted phone number, the installer company in different casing) is sent to the
  model in **one batch call at save-time**, which identifies which project/client
  field each value is (installer company, address, license numbers, etc.) and binds
  it. So the recipe replays each **future** project's own data, not the literal values
  you typed while recording. (Without an `ANTHROPIC_API_KEY`, only exact matches bind;
  the rest stay literal — fix those in the dashboard.)
- **Uploads** are captured with a blank `docType` — set each one (e.g. `sld`,
  `site_plan`, `meter_photo`) in the dashboard's **Portal Recipes** panel so the bot
  attaches the right file.
- **Admin controls.** In the dashboard you can **delete** and **re-record** a recipe
  (e.g. if a recording wasn't completed properly), and review/adjust the bound fields.
- **Safety.** A recorded recipe always ends with a `stopForReview` marker and a
  final-submit denylist guard — replay stops at review, exactly like the hand-coded
  adapters. A human always submits.

**Patch-by-demonstration (auto-learn).** You usually don't need a full recording:
when an auto-learn reaches the review screen and leaves the headed browser open,
anything you fix by hand right there — a missed dropdown, an unmapped field, an
attachment — is captured and merged into the learned recipe automatically (in
replayable position, values bound to project fields, sensitive values never
stored, submit/pay clicks never captured). First pass learns most of the form;
you demonstrate the remainder once; every future project replays the complete
recipe.

---

## 8. The Review Gate — a sellable standalone tool

The reviewer that gates staging internally is also a standalone product for
AHJs (counties/cities) at **`/review`**: upload a plan set + key facts, get an
intake pre-review against the jurisdiction's **adopted codes** — deterministic
checks for residential solar PV, AI-assisted advisory review (clearly badged,
never blocking) for general building plans (re-roof, ADU, deck, water heater,
anything).

**Onboarding a jurisdiction (e.g. Elmore County, ID):**
1. On `/review` (or `POST /api/code-profiles/research`), research the
   jurisdiction — Claude web-searches the county/state building-department
   pages for adopted code editions, amendments, and design criteria, saved as
   **seeded** with a citation per claim.
2. A human reviews each value against its cited source and clicks
   **Mark verified**. Until then, every finding says "verify locally" and
   seeded thresholds never hard-block.

**Selling it (multi-tenant licensing):** as a full-edition admin, create a
tenant org + login + API key:
```bash
POST /api/orgs               {"name":"Elmore County Building Dept","edition":"review_gate"}
POST /api/orgs/:id/users     {"email":"reviewer@county.gov","password":"…"}
POST /api/orgs/:id/api-keys  {"name":"intake"}   # key shown once
```
`review_gate` tenants reach only the review surface (page + APIs + code-profile
reads); the full autopilot returns a licensing 403. Submissions are org-scoped;
reports can be shared via tokenized public links. `REVIEW_DAILY_LIMIT` caps
per-org daily reviews (LLM cost guard). The same org/edition mechanism is the
seam for licensing other tools later (portal automation, status monitor).

Run the review-gate test suite: `npm run review:test`.

---

## 9. Troubleshooting a learn run — the debug bundle

Every auto-learn run (manual **Learn this portal** or the staging self-seed)
writes a complete forensic bundle to `data/learn-runs/<runId>/` — on by default,
pruned to the newest 20 runs. When a learn fails, gets stuck, or fills something
wrong, **you never need to re-run it blind**; the bundle already has:

| Artifact | What it answers |
| --- | --- |
| `run.json` | What portal/settings the run used, how it ended, how long it took |
| `events.jsonl` | The timeline: login, each page visited, recovery attempts, validation blocks, errors + stacks |
| `pNNN-plan.json` | Per page: every field the bot saw + what the planner decided to fill (sensitive values masked) |
| `pNNN-before/after-*.png` | What each page actually looked like before/after fills |
| `trace.zip` | Playwright trace — open at <https://trace.playwright.dev> to replay the whole session (DOM, actions, network). Started after login, so no credentials |
| `llm-calls.json` | Every Claude call: latency, tokens, cache hits, stop reason (refusals/truncations show here) |
| `verdict.json` | Why the recipe was / wasn't trusted (text vs vision vs deterministic signals) |
| `result.json` / `review.png` | Final outcome + the captured review screen |

To hand a run over for troubleshooting:

```bash
# list runs (newest first)
curl -s localhost:4173/api/learn-runs | jq '.runs[] | {runId, outcome, message}'
# download one as a single zip (or use "latest")
curl -o learn-run.zip localhost:4173/api/learn-runs/latest/bundle.zip
```

Send that zip (plus the terminal output if you have it) — it contains everything
needed to diagnose the run. Also useful: `GET /api/diagnostics` for the overall
service picture. PII note: the PNGs/trace are raw portal renders (same data class
as the review screenshot); bundles live only on local disk (`data/` is gitignored).

Knobs (all default on): `AUTOLEARN_RUN_DEBUG=0` disables bundles,
`AUTOLEARN_DEBUG_SCREENSHOTS=0` skips PNGs, `AUTOLEARN_TRACE=0` skips the trace,
`AUTOLEARN_RUN_KEEP` sets retention. See `.env.example`.

---

## 10. Updating

```bash
git pull
docker compose up -d --build      # or: npm ci && restart the service
```

The SQLite schema self-migrates on boot (new columns/indexes are added
idempotently); your data in the volume is preserved.
