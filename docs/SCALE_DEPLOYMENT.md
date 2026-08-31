# Running this for a team: 5–20 concurrent portal sessions

Target from the owner (2026-08-31): **employees work in the dashboard** from their own
machines; the **server** does all portal automation headless; **5–20 portal runs at once**;
and every learned recipe and KB row must stay correct across all of it.

`docs/SERVER_SETUP.md` covers the single-operator box and states the rule this document
revises: *"ONE instance only (SQLite)."* That rule stays — but it turns out not to be the
limit you'd assume. Read this before sizing a server.

---

## The headline: you do NOT need a second process, Postgres, or a cluster

Every serious concurrency hazard in this codebase is a **cross-process** hazard. A six-part
audit of the repo (2026-08-31) found ~30 blockers, and essentially all of them require a
second Node process to fire. With employees on the dashboard rather than running the bot
locally, all automation executes inside the one server process — so those blockers never
arm.

What actually limits you today is much smaller and much dumber:

> **The job queue runs ONE job at a time.**
> `drainPendingJobs` (backend/src/jobQueue.ts) loops `while (processed < MAX_JOBS_PER_TICK
> && await processNextJob(db))` behind a `drainBusy` flag. It is a serial drain. Ten queued
> submissions run one after another, however much RAM the box has.

So the path to 5–20 concurrent is: **parallelise inside the single process, and add the few
guards that parallelism arms even without a second process.** That is a days-of-work change,
not a re-architecture. Postgres is a Phase 3 concern and probably never.

---

## Status: Phases 1 and 2 are IMPLEMENTED (2026-08-31)

Everything in Phases 1 and 2 below is built, tested and committed. Verified live against
real portals with two simultaneous users: two runs on the SAME client+portal serialised
(hold windows did not overlap; both logged in; no "profile is still locked" failure), and
two runs on DIFFERENT portals overlapped by 7.7s, finishing in 9s wall clock instead of ~18s
serially.

**Turn concurrency on for the server** — it ships defaulted to today's serial behaviour:

| Env var | Default | Set it to |
|---|---|---|
| `JOB_CONCURRENCY` | `1` (serial, unchanged) | what RAM affords: ~400MB per browser, so 8 on a 16GB box |
| `MAX_JOBS_PER_TICK` | `5` | raise with concurrency (e.g. `20`) |
| `PORTAL_PROFILE_WAIT_MS` | `900000` (15 min) | how long a run waits for a busy portal before failing cleanly |
| `PORTAL_RUN_MAX_MS` | `1500000` (25 min) | hard ceiling on one portal run before its browser is force-closed |
| `SCREENSHOT_KEEP` / `REPLAY_RUN_KEEP` / `PORTAL_DEBUG_KEEP` | `400` / `20` / `20` | artifact retention |
| `AUTH_SECRET` | falls back to `SESSION_ENCRYPTION_KEY` | **set it separately** (see §1.6) |

Rotating the credential key is now possible: `npm run rekey:credentials -- --old=… --new=…`
(dry-run first; it backs up, and refuses to write if anything fails to decrypt).

## Phase 1 — before you deploy for a team (required)

### 1.1 Make the queue concurrent (small)
Replace the serial `while` drain with a bounded worker pool (`p-limit`, already a
dependency) sized by `MAX_CONCURRENT_PORTAL_RUNS`. Keep `drainBusy` for the tick, not for
the jobs.

### 1.2 Lock the portal profile — this is the one parallelism breaks (medium)
A Chromium persistent profile is a **single-holder OS lock**, and the profile path is keyed
by `(clientId, portalType)`, never by run. Serial execution is the only reason this has
never bitten. The moment two runs for the same client and portal overlap, the second dies at
launch with an error that blames a dead run and advises killing Chrome — advice that, under
concurrency, would kill a live submission.

Two options, in order of preference:
- **Queue per profile.** Serialise runs that share a `(clientId, portalType)` key while
  letting different keys run in parallel. Simplest correct thing, and it matches how portals
  behave anyway (one session per login).
- **Run-scoped profile clones.** Copy the profile per run, merge the session back on clean
  exit. More parallelism, more moving parts, and a merge conflict story you have to own.

Start with the queue. Most of your concurrency is across *different* AHJs anyway.

### 1.3 Reap orphaned browsers (small — this bit me twice in one session)
A killed or crashed run leaves `chrome-headless-shell.exe` holding the profile, wedging every
future run for that client+portal until a human kills it. Add a startup + periodic reaper
that kills browser processes whose command line names a profile no live run owns.
**Note the process name**: matching only `chrome.exe` misses it — Playwright's is
`chrome-headless-shell.exe`.

### 1.4 Add a run-level watchdog (small)
A learn run can hang **indefinitely**. Observed live on 2026-08-31: an Accela run went silent
for 13+ minutes mid-wizard with no output and no timeout, holding a browser and a portal
session. On a workstation you notice; on an unattended server that is a wedged worker.
Give every portal run a hard wall-clock ceiling, and make the ceiling fail the job loudly.

### 1.5 Back up `portal-profiles/` (small — currently a silent data-loss hole)
The backup covers the database and documents. It does **not** cover `portal-profiles/`, and
those directories *are* the live portal login sessions. Restore the documented way onto a new
box and every portal session is gone; worse, they are not portable between machines and no
key protects them. Either back them up, or accept and document that a restore means
re-logging in to every portal.

### 1.6 Split the two secrets (small)
`SESSION_ENCRYPTION_KEY` doubles as **both** the credential-encryption key and the session
cookie secret. Consequences worth knowing before you deploy:
- Rotating it is **unrecoverable data loss** — every stored portal credential becomes
  undecryptable and there is no rekey tool in the repo.
- Losing it logs out every user *and* bricks every credential at once.
Introduce a separate `AUTH_SECRET` for cookies, keep `SESSION_ENCRYPTION_KEY` for
credentials only, and write a rekey script before you ever need one.

### 1.7 Fix the two races that fire even in ONE process (medium)
Single-process is not blanket-safe: better-sqlite3 is synchronous, so a *single statement* is
atomic, but a read-modify-write that spans an `await` **can** interleave between two
concurrent jobs. Two known spans:
- **Recipe recording** — starting a recording wipes existing steps, and the guard protecting
  a verified recipe is separated from the write by LLM verification and an optional live
  replay (minutes).
- **AHJ form-template refresh** — reads `field_map`, does network + LLM work for minutes,
  writes the whole stale map back, discarding any operator `map.verified` edit made in that
  window. This one loses human work *today*, serially.

The KB upsert itself is safe single-process (no `await` inside the merge) — it becomes unsafe
only with a second process.

---

## Phase 2 — the ops surface for unattended running (do it with Phase 1)

- **Health endpoint worth alerting on**: DB ping, pending/failed job counts, age of the
  oldest pending job, seconds since the last worker tick.
- **Retention**: `AUTOLEARN_RUN_KEEP` prunes learn bundles; `data/replay-runs`,
  `data/screenshots` and `data/portal-debug` have no pruning and will fill the disk.
- **Restore drill**: restore into a scratch VM once, before you need it.

## Phase 3 — only if you outgrow one box

You would know because RAM, not the database, ran out. The cross-process fixes are mostly
small and well-identified; do them **only** when a second process is real:
`AppDb.run()` must return the rowcount so the job claim becomes a true compare-and-swap;
`BEGIN` must become `BEGIN IMMEDIATE`; jobs need an owner + heartbeat so orphan recovery
stops killing a peer's live runs; background loops need a `WORKER_ROLE` gate so only one
process schedules; and the KB upsert needs a transaction.

**Postgres is not what stops you.** `better-sqlite3` is imported in exactly one file behind a
clean `query/get/run/exec/transaction` wrapper, and the SQL is nearly dialect-free. The
expensive part is that `AppDb` is synchronous: going async is ~295 functions and ~500 call
sites. Do not start there.

---

## Sizing and hosting

RAM is the constraint, and it is set by browsers, not by the app.

| Concurrent runs | Chromium RAM (~400MB each) | Recommended VM |
|---|---|---|
| 5 | ~2 GB | 8 GB / 4 vCPU |
| 10 | ~4 GB | 16 GB / 8 vCPU |
| 20 | ~8 GB | 32 GB / 8–16 vCPU |

Leave headroom: the app, SQLite page cache, PDF rendering and the OS want several GB, and a
full-page screenshot spikes.

**Recommendation: one Hetzner CCX-series VM** (dedicated vCPU, ~16–32 GB, roughly
$50–110/mo). Dedicated cores matter because Chromium is CPU-bursty and noisy-neighbour
throttling shows up as portal timeouts, which are indistinguishable from portal flakiness in
the logs. Managed cloud (AWS/GCP) buys you nothing here while the database is a local file,
and costs several times more for the same RAM.

Put Caddy or nginx in front for TLS, run the app under systemd with restart-on-failure, and
set `TRUST_PROXY` to match the proxy hop.

## Does learned progress stay in sync? — the actual question

**Yes, with this topology, and by construction.** Recipes and the knowledge base both live in
the one SQLite file that the one process writes. There is no sync problem to solve because
there is nothing to sync *between*: every employee's dashboard action and every background
learn writes to the same tables through the same process. Backing up that file backs up all
learned progress.

The corollary is the thing to protect: **that file is the product.** The pooled KB is the
asset (`CLAUDE.md`: an AHJ quirk learned once should help every tenant), so treat backups and
the restore drill as a product requirement, not ops hygiene — and remember portal-profiles
sit *outside* it (§1.5).

Where sync genuinely would break is the topology you did **not** pick: employees running the
bot on their own laptops, each against a local SQLite. Avoid that; there is no merge story
for two divergent knowledge bases.
