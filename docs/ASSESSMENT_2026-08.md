# Outside-in Technical Assessment — August 2026

An independent pass over the codebase, run the way an incoming contractor would run
it: set the app up cold, drive every harness the repo ships, deep-dive the autopilot
state transitions / background jobs / portal navigation, and rank what actually needs
repair. Companion to `docs/HANDOFF.md` (running state) and
`docs/ARCHITECTURE_ASSESSMENT.md` (scaling posture) — this document is the
point-in-time verdict and the record of what was fixed on the spot.

## 1. What was run, and what happened

All on scratch DBs with the mock portal — nothing live was touched.

| Harness | Result |
| --- | --- |
| `npm run typecheck` | Clean (no errors, including nodemailer). |
| `npm run backend:test:unit` (32 suites at the time of the baseline) | All green. |
| `npm run portal:test:unit` (7 suites) | All green. |
| `npm run smoke` (full e2e on scratch DB) | Green — parse → KB → QC → reviewer → docs → mock stage → permit outcomes → mbox/email → clean delete. |
| `npm run rehearse:sim` | Green — fixture project ran intake → autopilot → approval → submitted, stopping at the human gate. |
| `backend/test/runTriageDigest.test.ts` (was orphaned from the chain) | Green. |

So the roadblocks are not "the tests are red." Every documented live failure
(the PowerClerk specs-page stall, WAF posture, portal drift) needs a real portal
session to reproduce and stays on the operator's live checklist
(`docs/HANDOFF.md` §"verify live"). What the deep-dive DID reproduce, from the
code itself, is a set of state-machine and job-system landmines that produce
exactly the symptom reported — a submission that stalls with no path forward.

## 2. Findings

### 2.1 The correction flow was a dead end (FIXED here)

`ProjectStatus` declares a full resubmit leg — `waiting_on_designer`,
`ready_to_resubmit`, `resubmit_staging`, `awaiting_human_resubmit` — and **none of
it is implemented**: zero references anywhere in `backend/src`. The statuses that
ARE reachable, `correction_received` / `correction_triaged`, are not in
`PRE_STAGE_STATUSES`, so `maybeResumeAutopilot` refuses to resume and
`runAutopilotSegmentA`'s execution-time guard refuses to re-stage. Closing a
correction (`resolveCorrection`, `applyCorrectionProposals`) never moved the
project status back. Net effect: **every project that ever received an AHJ
correction was stranded permanently** — the flagship "submission roadblock".

**Fix applied**: resolving the *last* open correction returns the project to
`parsed` (the normal QC → gates → stage path re-runs from there; deliberately NOT
a jump straight to staging), and the resolve route now kicks
`maybeResumeAutopilot`. The unimplemented resubmit statuses remain declared but
unused — implementing the full designer round-trip is future product work, not a
repair. Regression: `backend/test/correctionResubmit.test.ts`.

### 2.2 An abandoned re-record destroyed the working recipe (FIXED here)

`startPortalRecording` wiped a complete recipe's `steps_json` the moment a
re-record started. Abandon the re-record (browser crash, operator walks away) and
the portal has **no working recipe at all** — the next staging falls through the
adapter precedence to auto-learn or the mock. This was HANDOFF residual #1.

**Fix applied**: the outgoing steps are snapshotted (`prev_steps_json`) when a
re-record starts; the 2-hour stale-recording sweep restores the snapshot (recipe
back to `complete`) instead of stranding the portal at `needs_rerecord`; a
finished re-record clears the snapshot. A proven recipe now survives any
abandoned re-record. Regression: `backend/test/recipeRerecordSnapshot.test.ts`.

### 2.3 The watchdog could re-run a live portal job (FIXED here)

`recoverOrphanedJobs` re-queued any interrupted `running` job with retry budget
left. The autopilot enqueue sites all pass `maxRetries: 0` on purpose — but the
generic `POST /api/jobs` route accepted `prepare_submission` / `auto_learn` with
the **default budget of 3**, and an interrupted run would then be silently
replayed: two browser sessions staging the same application to a real portal
(ARCHITECTURE_ASSESSMENT's "one double-submit guard worth doing").

**Fix applied**: portal-effecting job types (`prepare_submission`, `auto_learn`,
`autopilot`) are pinned to `maxRetries 0` at enqueue regardless of caller input,
and the orphan watchdog now **fails them to a human review item** ("check the
portal for a partial application before re-staging") instead of re-queuing — on
both startup and mid-run reclaim. Ordinary jobs keep their retry semantics.
Regression: `backend/test/jobWatchdog.test.ts` (extended).

### 2.4 The autopilot panel could pin "paused for MFA" forever (FIXED here)

`getAutopilotState` reported `paused_for_human` whenever the *latest* portal run
carried a `pause_reason` — even after that run had failed/finished or the project
had moved on (manual track submit updates the project, not the old run row). The
dashboard then showed a permanent, wrong "paused" state — indistinguishable from a
real stall. **Fix applied**: the pause surfaces only while the run itself is still
`paused_for_human` and the project hasn't advanced. Regression in
`correctionResubmit.test.ts`.

### 2.5 A deploy restart could kill a browser mid-staging (FIXED here)

SIGTERM force-exited after 5s regardless of live portal runs (HANDOFF residual
#4). **Fix applied**: shutdown now drains — while this process has jobs in
flight, exit waits (bounded by `SHUTDOWN_DRAIN_MS`, default 5 min; a second
signal forces). Combined with 2.3, a run that still gets killed now escalates to
a human instead of silently re-running.

### 2.6 Test/CI hygiene (FIXED here)

`runTriageDigest.test.ts` and `rehearsal.simulated.test.ts` were not in the
`backend:test:unit` chain (CI itself *does* run both unit chains + smoke —
ARCHITECTURE_ASSESSMENT.md §"CI does not run unit tests" is stale). Both are now
chained, along with the two new regression suites (36 suites total).

### 2.7 The sensitive-capture safety boundary was untested (FIXED here)

Running the real-Chromium DOM smoke (`portal:test:dom` — not in CI, needs a
browser) surfaced a failing check: it asserted the human-capture callback never
carries a typed account number, while the shipped design deliberately carries the
secret **in memory only** so `appendHumanPatchSteps` can bind it to a project
field key and then strip the literal before anything persists. The smoke's
assertion was stale — but the *actual* boundary (the merge-time strip) had **no
test at all**. **Fix applied**: `backend/test/humanPatch.test.ts` now proves a
matched secret binds to its field key and that matched AND unmatched secrets
never land in `steps_json`; the DOM smoke now asserts the capture-side contract
(every step carrying the secret is `sensitive:true`-flagged for the strip, and
the secret never rides an unflagged step).

### 2.8 Confirmed, deliberately NOT fixed here

Ranked for the next engagement phase; none is a quick fix and several are
explicit product decisions:

1. **Live verification of the specs-page fill** (HANDOFF #1) — needs the
   operator's PGE credentials and a real PowerClerk session; the code fix is in,
   the live confirmation is not. Watch `equipment_fill` events in the learn-run
   bundle.
2. **Plan-page vision extraction unwired** — biggest accuracy lever for scanned
   plan sets; frontend never sends `kind:'plan_page'`.
3. **Stripe checkout** — the payment gate works but is manual ("Mark paid").
4. **Credential hygiene** — SHA-256-as-KDF, plaintext `account_number` /
   `meter_number` (+ duplicated in `parser_json`). A scoped re-encryption project.
5. **`repository.ts` at ~5.8k lines** and the SQLite/single-worker scale ceiling —
   fine for the current service-bureau shape; a decomposition target before any
   multi-operator scale-out.
6. **14 of 15 seeded code profiles unverified** — data trust, not code; the
   verification workflow exists (`docs/VERIFICATION_PLAN.md` §2.1).
7. **Doc drift** — ARCHITECTURE_ASSESSMENT on CI (stale, see 2.6),
   DEVELOPER_ONBOARDING "migrations v9" (now v13), VERIFICATION_PLAN Tier 4
   scheduler item (shipped as migration v13 + `schedulerState.ts`).
8. **Server-booting test suites can leak their child server** — tenancy /
   reviewApi / filledFormDownload `server.kill("SIGTERM")` signals the `npx tsx`
   wrapper, which (at least on some Linux setups) does not forward it to the real
   node child; orphaned servers then squat on the test port bands and make a
   later chained run flake with `fetch failed`. Repro'd here at baseline (before
   any changes). Fix candidates: spawn the server via the node binary directly,
   or `kill` the process group (`detached: true` + negative pid).

## 3. Verification

After the fixes: `npm run typecheck` clean; `npm run backend:test:unit` (36
suites, now including the simulated rehearsal end-to-end), `npm run
portal:test:unit`, and `npm run smoke` all green. Safety invariants re-verified by
the existing suites: adapter precedence, portal URL track-scoping, tenancy over
real HTTP, route-scope fail-closed registry, portal pause kill-switch, and the
human approval gate (rehearsal asserts the run stops at `awaiting_human_submit`
with the final-submit step recorded, never executed).
