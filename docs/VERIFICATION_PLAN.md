# Verification Plan — go-live checklist, ranked

Purpose: a systematic pass the operator works top to bottom before scaling to more
companies, states, and volume. Ranked by **what blocks us if wrong**, then by what
protects **accuracy**, then by what buys **universality** (any vendor, any state, any
portal) without diluting the main scope: parse → QC → human gate → documents →
staged portal → human submits.

How to use: each item names WHY it blocks, HOW to verify (a concrete action), and
the PASS bar. Tick them in order; anything that fails stops the pass until fixed.
Automated gates (`npm run backend:test:unit` — 31 suites, `npm run
portal:test:unit`, `npm run typecheck`, `ANTHROPIC_API_KEY="" npm run smoke`)
must be green before starting; this list is what the suites CANNOT prove alone.

---

## Tier 0 — Total-loss risks. Nothing else matters if these fail.

**0.1 Restore drill (DB + documents together).**
- Why: backups now mirror `PROJECT_DOCS_DIR` into `BACKUP_DIR/documents/`, but a
  backup nobody has restored is a hope, not a backup. A DB-only restore looks
  complete and 404s on every file.
- Verify: on a scratch machine/dir — copy the newest `backups/autopilot-*.sqlite`
  and `backups/documents/` into place, boot with `AUTOPILOT_DB_PATH` +
  `PROJECT_DOCS_DIR` pointed at them, open 3 real projects, download the plan set
  and one filled form from each.
- Pass: all files download; the backup log shows `documentsMissingOnDisk: 0` on the
  live box. Repeat quarterly.

**0.2 Secrets that cannot be regenerated.**
- Why: `SESSION_ENCRYPTION_KEY` encrypts every stored portal credential —
  losing it loses every stored login. It is not in any backup by design.
- Verify: the key is stored OUTSIDE the server (password manager), and a restore
  drill (0.1) can decrypt a stored credential (`portal:login` against one portal).
- Pass: credential decrypts on the restored copy.

**0.3 Off-box copy actually runs.**
- Why: `litestream.yml` replicates the DB only; the `backups/` dir (including the
  document mirror) needs its own sync (restic/rclone). If the box dies, local
  backups die with it.
- Verify: check the bucket — is there an object newer than 24h for BOTH the DB
  replica and the backups dir? If litestream/restic is not running, this is the
  single most urgent fix on the list.
- Pass: both newer than 24h; a test-restore from the bucket succeeds once.

**0.4 The human approval gate is uncrossable.**
- Why: the one promise that must never break — automation never final-submits,
  never pays, never solves CAPTCHA/MFA.
- Verify: grep discipline is tested, but verify live once per release: run a
  staging to the review screen on the mock portal and on one real portal in a
  test/sandbox application; confirm the run halts at `awaiting_human_submit` and
  the submit step is recorded `isFinalSubmit:true`, not executed.
- Pass: no run in `portal_runs` history ever shows an executed final-submit step.

## Tier 1 — Blocks the next company (isolation + access)

**1.1 Auth is ON in production.**
- Why: every tenancy guard resolves to `org-default` when `AUTH_ENABLED` is unset —
  correct for local dev, catastrophic on a public interface.
- Verify: on the live box: `.env` has `AUTH_ENABLED=true`, `curl /api/projects`
  without a cookie returns 401, `/login` renders.
- Pass: 401 unauthenticated; the boot log shows no auth warning.

**1.2 Tenancy holds on the REAL database, not just test fixtures.**
- Why: `tenancy.test.ts` proves the mechanism on a fresh DB; the live DB carries
  years of pre-tenancy rows that all back-filled to `org-default`.
- Verify: after pulling, run migrations on a COPY of the live DB first:
  `sqlite3` — `SELECT COUNT(*) FROM projects WHERE org_id != 'org-default';`
  (expect 0 until a second org exists), row counts unchanged, then boot the copy
  and click through 3 projects.
- Verify (second org): create a real second org + user, log in as them in a
  private window: project list empty, a known project id 404s, `/api/clients`
  empty, SSE dashboard shows no toasts for your projects.
- Pass: all four; superadmin still sees everything and the cross-org read appears
  in `audit_logs`.

**1.3 Roles are what you think they are.**
- Verify: `SELECT email, role, org_id FROM users;` — exactly one superadmin (you),
  staff are `operator`, no strays. Try self-promoting via the UI as an operator.
- Pass: self-promotion 403s; the list matches your mental model.

**1.4 Entitlements match what was sold.**
- Verify: `GET /api/orgs` as admin — every org's `products` list is exactly what
  that tenant bought. For any review-gate tenant: their API key still reaches
  `/api/review` and 401s on `/api/projects`.
- Pass: no org holds `autopilot` except yours.

## Tier 2 — Blocks correct filings (accuracy — wrong output is worse than none)

**2.1 Jurisdiction code profiles: verify before trusting citations.**
- Why: 14 of 15 seeded profiles are `seeded`, NOT `verified`. They gate QC screens,
  the stamp threshold, and checklist Yes/No boxes. A wrong seeded value produces a
  confidently wrong filing.
- Verify: for each state you actually file in NEXT (not all 15): open the profile,
  check code editions + `engineerStampOverKwDc` + snow/wind against the official
  source URL stored on the row, then verify it: the KB tab's **Review / verify** on the row (or
  /review), which confirms and calls `PUT /api/code-profiles/verify`. The PUT names a person: with
  sign-in on it records the signed-in user (a body name is ignored; no session, e.g. an API key, is
  a 401); with sign-in off the body must carry `verifiedBy` (your name), or it is a 400 that
  verifies nothing.
- Pass: every jurisdiction you file in this quarter is `verified`. Never bulk-verify.

**2.2 Parser accuracy on each NEW design vendor.**
- Why: the multi-vendor prompt hardening (glued labels, watts vs kW, slashed
  azimuths, APN-glued ZIPs) was built from three vendors. The next vendor will
  have a new quirk.
- Verify: first plan set from any new vendor — parse, then manually compare 8
  fields against the PDF: dcKw, acKw, module qty×wattage (cross-check should be
  silent), inverter model, address/ZIP, mounting, existing-system flag, structural
  block presence. File any mismatch as a prompt-quirk addition, not a one-off edit.
- Pass: 8/8, and the QC cross-checks (`xcheck-*`) raise nothing.

**2.3 Structural path end-to-end for one stamped-letter job.**
- Why: newest pipeline: letter upload slot → conditional requirement → packaged →
  correct portal slot (not the framing sheet).
- Verify: on a real CA/PA job with a sealed letter: requiredDocuments shows the
  letter only when the path/threshold demands it; build the permit package and
  open the ZIP — `structural_letter` present and it IS the letter.
- Pass: letter in package; a clean prescriptive OR job is NOT nagged for one.

**2.4 Checklist checkbox fills stay honest.**
- Why: `[verify]` must tick NOTHING. A pre-ticked "Yes" on unverified structural
  data is a misrepresentation to an AHJ.
- Verify: fill a checklist for a project missing one structural field — that row's
  boxes must be blank; human-verify the field, refill, box ticks.
- Pass: blank-until-verified, per row.

**2.5 First staging against each portal after any pull.**
- Why: recipes drift when portals change; the suite can't see a portal's live DOM.
- Verify: per `docs/HANDOFF.md` "verify after each pull": stage one job to the
  review screen per active portal (PowerClerk, Oregon ePermitting, Accela) and eyeball
  the review screen against the project record before approving.
- Pass: every field on the review screen matches; equipment dropdowns resolved to
  certified names.

## Tier 3 — Blocks scale (universality without scope creep)

**3.1 Intake rejects what it cannot process — loudly.**
- Verify: throw garbage at the upload path: a `.dwg`, a DWG renamed `.pdf`, a
  photo in the plan-set slot, a 200MB scan, a 0-byte file. Each must be refused
  with a message that says what to send instead; CAD accepted only as `cad_source`.
- Pass: no silent acceptance; no 500s.

**3.2 New-AHJ cold start (the universality claim).**
- Verify: run one project in a jurisdiction the KB has never seen: knowledge
  research fires, forms are found/acquired, the process profile lands as `seeded`,
  the reviewer gate flags what it can't know rather than guessing.
- Pass: the pipeline degrades to "human decides" — never to invented data.

**3.3 Queue fairness under load.**
- Verify: enqueue ~20 jobs for org A, then 2 for org B; watch `/api/jobs` — B's
  jobs must start before A's backlog drains.
- Pass: least-in-flight ordering observable.

**3.4 Volume smoke.**
- Verify: with the live DB copy (1.2), time the dashboard list, ops board, and
  KPI report. Watch startup: KB backfill logs a bounded batch, not a full-table
  walk.
- Pass: dashboard < 2s at current volume; no unbounded scans in the log.

## Tier 4 — Operational hygiene (won't block a filing this week; will bite later)

- **4.1 Scheduler last-run persistence** — link sweep/form refresh/CEC sync reset
  on every restart (known open item). Verify each has run within its window after
  a week of normal restarts; if not, prioritize the `scheduler_state` migration.
- **4.2 Monitoring the monitors** — env-inbox poll failures and hung jobs escalate
  (job watchdog + review items exist); once a month, kill the poller mid-run and
  confirm something told you.
- **4.3 PII encryption of `parser_json`** (deferred task #8) — account/meter
  numbers at rest. Do before any org whose data you don't own lives in the DB.
- **4.4 Docs match reality** — SERVER_SETUP backup section, CLAUDE.md tenancy
  section: skim after each pull; they are the next session's ground truth.

---

## Standing rule

When any check fails: fix → add the failure as a test in the chain → re-run the
tier from the top. The suites grow one honest test per incident; that is how this
list shrinks instead of growing.
