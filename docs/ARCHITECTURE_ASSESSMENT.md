# Architecture assessment — production fundamentals (July 2026)

Ground-truth survey of the codebase to decide what, if anything, to change
fundamentally before/around go-live. **Bottom line: the architecture is sound
and durable for its current scale (single operator, tens–low-hundreds of
submissions/day). The work worth doing now is small security/CI hardening plus
one double-submit guard — not a rewrite.** The heavy items (Postgres,
distributed workers, per-tenant KMS, model tiering, metrics stack) are
correctly deferred until a specific trigger fires.

## What's already right — do not change

- **Credential encryption exists**: portal logins are AES-256-GCM at rest
  (`portal-bot/src/cryptoStorage.ts`), plaintext never persisted or logged,
  API never returns the secret (`portalCredentials.ts` — `hasSecret` only).
- **Secrets never reach the LLM**: `buildPortalPlanner` strips
  `password|accountNumber|meterNumber|ssn` before prompting
  (`autoLearn.ts:175-197`); adapter binds real secrets deterministically.
- **Durable job queue with crash recovery**: DB-backed `job_queue`, orphan
  reclaim on restart, exponential-backoff retries (`jobQueue.ts`).
- **SQLite durability done right for single-node**: WAL + `synchronous=FULL` +
  `busy_timeout`, WAL checkpointing, `VACUUM INTO` backup, plus Litestream
  replication (`litestream.yml`).
- **Learn-once/replay** — validated against the state of the art by the
  architecture research (`docs/research/ARCHITECTURE_REVIEW_2026-07.md`).

## Real gaps worth fixing now (small, high-value, pre-launch)

### 1. CI does not run the unit tests
`.github/workflows/deploy.yml` runs only `typecheck` + `smoke` before deploying
to Fly. The 26 `*.test.ts` suites (which caught the CEC parse bug and the drift
edge cases) run only locally, chained with `&&` so the first failure aborts the
rest. Two files aren't even in the local chain (`runTriageDigest.test.ts`,
`rehearsal.simulated.test.ts`). A regression in that logic ships undetected.
→ Add `backend:test:unit` + `portal:test:unit` to CI.

### 2. Credential key derivation is weak, and some PII is plaintext
- The AES key is `SHA-256(SESSION_ENCRYPTION_KEY)` — a plain hash, no salt, no
  KDF (`cryptoStorage.ts:12`). A low-entropy key is brute-forceable if the DB
  leaks. The correct pattern already exists in the repo: `auth.ts` uses
  `scryptSync` for user passwords. Apply it here.
- `projects.account_number` / `projects.meter_number` are **plaintext** TEXT
  columns (`db.ts:166-167`) — only portal login username/password are
  encrypted. Given the CCPA/CPRA exposure from the go-live research, encrypt
  these too.
- Nothing prevents booting with the placeholder key — it only warns and marks
  diagnostics `degraded` (`logger.ts:162-169`). Add a startup gate that refuses
  to serve with the default/placeholder key in production.

### 3. Job watchdog can double-run a live portal submission
A portal run that legitimately exceeds `JOB_MAX_RUNTIME_MS` (30 min default) is
reclaimed to `pending` and re-run *while the original may still be executing*
(`jobQueue.ts:249,256-284`). The DB completion UPDATE is guarded, but the
**side effects run twice** — two live browser sessions could stage the same
application. Automation never clicks final-submit (a human does), so it's
bounded, but a human could approve a duplicate. This is safety-adjacent.
→ Exclude in-flight portal-submission jobs from blind reclaim, or check for a
live/staged session before re-queuing; make the timeout an enforced bound, not
an assumption.

## Structural debt worth paying down (not urgent, but growing)

- **`repository.ts` is a 5,746-line god-module** (295 KB, 51 exports) mixing
  data access, portal orchestration, and LLM calls. It's the hub of the
  dependency graph, which is *why* the pervasive dynamic-`import()` cycle-guards
  exist (`repository.ts`, `jobQueue.ts`, `db.ts:109`). Those guards defer cycle
  errors to runtime and disable static analysis. `server.ts` (2,237),
  `llm.ts` (1,934), `knowledgeBase.ts` (2,082), and `shared/src/types.ts`
  (1,930) are also oversized. Split `repository.ts` by domain first.
- **Layering inversion**: the backend imports its credential crypto from the
  Playwright package (`portalCredentials.ts` → `../../portal-bot/src/cryptoStorage`).
  The security-critical primitive should live in `shared/`, not the bot.

## Cost/reliability lever (defer, but know the trigger)

- **Opus is hardcoded for every LLM call** (`llm.ts:8`) — cheap classification
  and heavy vision/planning alike — with no per-task model tiering, no response
  caching, and no application-level 429/rate-limit handling (only the SDK's
  default 2 retries). Prompt caching is partial (`cachedSystem()` not on every
  path). At hundreds/day with multiple operators this is the main cost and
  reliability exposure. Trigger to act: LLM spend or 429s become material.

## Scaling fundamentals (deliberately deferred — decide at the trigger)

These are **not needed** at single-operator, tens/day. Don't pay their cost now.

- **SQLite single synchronous connection** serializes all DB work on the event
  loop (`db.ts:88`; better-sqlite3 is synchronous). One writer only. Trigger to
  move to Postgres: a second concurrent operator, or write-latency pain.
- **Single in-process job worker with a non-atomic claim**
  (`jobQueue.ts:335-353`: SELECT-then-UPDATE, safe only because one worker
  exists) and an **in-memory login throttle** (`auth.ts:177`) both assume a
  single instance and break if scaled horizontally. Trigger: need for HA or
  horizontal scale → distributed queue + atomic `UPDATE … RETURNING` claim.

## Observability (defer, but cheap to start)

Logging is `console.*` only — no aggregation, metrics, or alerting. A silently
failed job, a 429 storm, or a placeholder key in use is invisible unless
someone polls `/api/diagnostics`. Cheap first step: ship stdout to a log
service and alert on `jobsFailed > 0` and `degraded` status.

## Ranked recommendation

1. **Unit tests into CI** — do today.
2. **Credential hardening** — scrypt key derivation + encrypt account/meter +
   startup key gate. Pre-launch, small, security/compliance-real.
3. **Double-submit guard on the job watchdog** — safety-adjacent, small.
4. **Split `repository.ts`** — before it doubles again.
5. **Selector repository** (from the architecture research) — the real
   strategic leverage for the browser-automation moat: fix a portal's shared
   widget once, propagate to every recipe.

Everything else (Postgres, distributed workers, per-tenant KMS, model tiering,
metrics) stays deferred until its trigger.
