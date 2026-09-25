# Handoff — state of the tool (July 2026, end of Fable 5 session)

Audience: the next model/dev session (and the operator). Read `CLAUDE.md` first
for the hard rules; this file is the running state.

## PRODUCTION RUNS PINNED; POWER-LOSS RECOVERY (2026-09-24)

**Production no longer runs from the dev tree.** Code runs from `.probe/prod-pinned` (a detached git
worktree); the working directory stays the repo root, so the live DB, `.env`, uploads, logs and
`frontend/` are the live ones, and agents editing the dev tree cannot leak into a running server
(lazy imports used to load half-finished edits). Start: double-click `.probe\start-prod-pinned.cmd`
(it also points `CODE_PROFILE_REFERENCE_PATH` at the pinned copy — the one cwd-relative code file).
Re-pin: stop the server window, `git -C .probe\prod-pinned checkout --detach <verified commit>`, start
again. Check nothing is mid-job first (`job_queue` rows not done/failed; no browser under the server
process). Not covered by the pin: the "record a portal session" button launches `npm run
portal:record` from the dev tree, and `frontend/` is served from the dev tree. Pinned at `0c466bb`
(round 3 + battery line, both skeptic-verified). DB backup taken first:
`backend/data/backups/autopilot-2026-09-24-before-pinned-restart.sqlite`.

**Version.** `backend/src/buildInfo.ts` (95b65cc+) names the RUNNING code — date version from the
commit + short sha, "pinned" / "uncommitted changes" — in the banner, `/health`, diagnostics and the
dashboard. The pin at `0c466bb` predates it; the next re-pin shows it.

**Recovery lesson.** The power died with three workflows mid-stage. The tree came back "clean", but a
`Teleport auto-stash` (created at resume) held ~400 lines of uncommitted builder work — `git stash
list` first on any resume. Workflow resume is same-session only; continuation scripts were rebuilt
from the dead journals.

**Operator ruling (2026-09-24): the state minimum ground snow blocks only on a value a plan document
states.** A value only the parser (or a narrative) read stays a warning — the parser's "snow" field does
not say which snow load it is (a roof snow 25 would false-block a correct Pg 36 plan). Live effect with the
36/25 payload on the production copy: all 5 blockers are document-stated; the one parser-only project
(ec5c36d3) is also unknown-path, so a warning under either rule. Kept as built in 641326f.

**Operator rulings on learn/replay (2026-09-24, from the portal-readiness plan `.probe/readiness/PLAN.md`):**
- A replay failure nobody can attribute KEEPS the recipe and flags it for a human (never demotes). Harness aborts, document
  gates and challenges never demote.
- The demoted NEM recipes (PacifiCorp `6282e671`, PGE `481c00f4`/`e9efa4a3`) are RESTORED once that fix lands, then proven
  with one supervised replay each.
- On Oregon's statewide Accela portal a recipe learned for one city MAY replay for another city when the record/permit type
  matches (city fields still bind per project; drift stops the run; every run stops at review).
- Supervised live checks approved once the safety fixes land (learn to the review screen, stop, never submit, operator
  present): PacifiCorp + PGE NEM, Accela Coos Bay then Salem, Happy Valley EnerGov. Tyler login has 2FA — the run parks at
  the code prompt with the window open and the OPERATOR types the code (automation never does MFA). No 54-portal login sweep.
- Research must work for ANY new state: IL/TX are the development set; acceptance runs on held-out states.
- PRESENTATION: Tue 2026-09-29, demo kit only (no production, no live portal in the room). Prospects' jobs are in FL, TX, UT
  and CA. The bar is a supervised pilot we can actually run for them, and a 100-project customer after that.
- FINAL SUBMIT: the operator wants to submit from the dashboard (Approve & Submit -> the bot clicks the portal's submit), so
  PORTAL_ALLOW_FINAL_SUBMIT stays on; it becomes acceptable only with the per-run approval gate (bot round R2 + W1 A2)
  verified. CLAUDE.md hard rule 1 is to be reworded to match — with the operator's OK — once that gate is verified.
- DEMO RECORDING ON PGE (operator ruling 2026-09-24, late): the operator AUTHORISES a supervised run on PGE's live PowerClerk with clearly
  test-labelled homeowner data, recorded on video with PII/account-header masking, for the offline demo; the operator deletes the draft(s)
  afterwards. Still: learn/replay to the REVIEW screen and stop, never submit, PORTAL_ALLOW_FINAL_SUBMIT unset for the session, operator present
  for login/MFA, the test project flagged learning_excluded (demo projects never teach the KB), a human reviews every frame before use.
  Caveat: PowerClerk may validate the PGE account number / service address — fallback is a real unfiled project's values, masked.
- KNOWLEDGE PRE-LOAD SPEND (prospect states): only AFTER the live research-accuracy evals pass
  (`.probe/jurisdiction/`): state layers for FL/TX/UT/CA (~$2) + the top 5 AHJs/utilities per state from
  `.probe/prospects/PREP-PLAN.md` §6 (~20 entities, ~$50), seeded, operator spot-verifies. Everything else is researched
  per customer from their last 90 days of jobs (~$25-80 each). Not all 105 AHJs (~$275) up front.
- Readiness reports (2026-09-24): `.probe/readiness/PLAN.md` (portals), `.probe/presentation/READINESS.md` (claims + demo;
  cut-offs assumed Mon — shift one day), `.probe/volume/DAY1-OF-100.md` (volume, ops, onboarding).

**Operator actions still open (2026-09-24):**
- Oregon 36/25 psf minimum ground snow: the verified write (`PUT /api/code-profiles/verify`, payload in
  `.probe/r3r-criteria-fix/verify-payload.json`) is NO LONGER BLOCKED by the snow-reading work: rounds 4-5 landed
  (blockers only on an unambiguous reading; 0 false blockers on two generators of 595k/416k layouts; production
  byte-identical). Do it AT THE NEXT RE-PIN so the new reader is live. Expected on today's 19 projects: 4 blockers
  (204ff994, 29cd57b5, 720b05f3, 1fb3dc39) + 8 warnings (7 unknown-path + f7d7af7e, whose plan set and letter
  disagree — a conflict, not a minimum blocker). Snow work is DONE unless a REAL document shows a false blocker
  (the multi-state corpus measures that); a last small round closes only the two shapes common in real plan sets
  (em dash / dot-leader separators, the 'Pf = 0.7 Ce Ct Is Pg' calc line). Still open: two documents that both
  read below the minimum but disagree with each other give only warnings (operator decision).
- Confirm Coos Bay's OSSC/OFC edition (row says 2022, plans print 2025) and OESC 2023 vs 2025.
- Battery services/feeders <=200A: record the amount for Salem / Lincoln City (Salem 6a1c2127 is an
  estimate until then); re-map the Coos Bay / Tigard electrical templates; re-learn one electrical recipe
  on a battery job (0 of 804 recipe steps carry the box).
- Recipe e965c645 (Coos Bay) step 47 is a human-patched click on a filed record number, before the final.
- Until the bot round lands its recorder fixes: do not record NEW Accela sessions (the review-page
  "Continue Application" can be captured as a plain click when the page carries an attachments box).
  Stored Coos Bay recipes are safe: their review-page click is the flagged final, refused while disarmed.

## DEMO KIT, LIVE SAFETY, ONE NEXT STEP, AND A PIPELINE THAT LEARNS (2026-09-23, long session)

Operator goal: a replayable, resettable client demo; ensure live isn't messed up; deep-research the
UI (screen space, obvious next steps); evaluate the whole pipeline (linkages, LLM usage, learning).
Every change below came through builder -> independent skeptic -> repair, each fix with a test that
fails with the fix removed. Plan and measurements: `.probe/GOAL-PLAN.md` (git-ignored).

**Demo kit (`demo-kit/`, git-ignored; runbook `docs/DEMO_RUNBOOK.md`).** 8 synthetic projects across all
five columns (4 later-stage ones seeded by `scripts/demo-later-stages.ts` through the mock portal),
`RESET-DEMO.cmd` + `kit-snapshot.mjs` (snapshot/restore of DB + data folders — tested on the real kit),
`sample-docs/` (public blank forms for the live upload beat), `/demo/` page with two recordings:
`scripts/demo-record-portal.ts` (the real RecipeAdapter on a FICTIONAL portal, stops at review) and
`scripts/demo-record-walkthrough.ts` (captioned dashboard tour). Launchers live in `scripts/demo-kit/`.
Kit extras copied from production are shared knowledge only: `fee_schedules` and one form template
(`scripts/demo-copy-form-templates.ts`). Offline switches: `PORTAL_AUTOMATION=off` (staging AND approval
refuse), `DOCUMENT_FETCH=off`, `AHJ_FORM_DOWNLOADS=off`, `CLIENT_NOTIFICATIONS=false`.

**Live safety (would have hurt real filings).** Resume race started 3 parallel live staging runs from one
upload burst (fixed: synchronous dedupe + per-project claim exclusion); new projects auto-started live
staging nobody asked for (now opt-in `AUTOPILOT_AUTO_START=1`); false closeouts on fee-due / one-of-two
permits (`isTrackDone`); QC/edits/verify rewinding filed projects; trackless Prepare Submittal restaging
filed tracks; the upload sweep filing documents twice (and silently dropping >=50 MB files); research
saving model memory as web-grounded knowledge; an orphaned filled PDF counting as an application.

**One next step (`backend/src/nextStep.ts`).** One read-only rule table answers who acts / how urgent /
the one button, on every list row and the project page; Approve and Stage are enabled from the same gate
answer; missing documents are one predicate (`owedMissingDocuments`: a form staging fills is not
"missing"). UI rebuilt around it: next step at y=235 (was below the fold), sticky status rail, one chip
per board card, Needs-me pills, a filing selector for pasted statuses.

**Learning.** `verified_at` replaces "mixed" as the rule-3 lock (`isVerifiedKnowledge`);
`historical_failure_examples.org_id` (v31) and no raw samples in shared rollups; real turnaround samples
(`permit_timeline_samples`); correction learning from the triage result with retract; `\bESS\b` etc.;
corrections close when the project truly finishes; demo/benchmark projects never teach
(`learning_excluded`); paid receipts reconciled against fee schedules; every model call persisted
(`llm_calls`, `GET /api/projects/:id/llm-usage`).

**Tests no longer litter production.** 13 tests wrote into `backend/data`; fixed via
`backend/test/_isolate.ts`. 1.5 GB of existing litter moved (reversibly) to
`backend/data/_quarantine-test-litter-20260923/` (MANIFEST inside) — delete it once you are satisfied.

**Operator decisions / actions (not done automatically):**
- RESTART production to pick up all of this. Old-vs-new on production copies changed no status, QC
  result, review item or fee — only stale "blocked" labels, gates that asked for forms staging fills,
  and Approve refused on 3 staged NEM drafts that left required portal fields blank.
- Production runs straight from this dev working tree: lazily imported modules load whatever is on disk
  at first use. Run production from a separate deploy checkout.
- `.env` has `PORTAL_ALLOW_FINAL_SUBMIT=1`, contrary to hard rule 1's wording. Note: recorded recipes
  can never auto-submit anyway (the recorder's "submit/pay-like" note trips the fee gate first).
- Fee schedules short of Oregon's 12% state surcharge: Tigard and Salem (receipts prove it); Lincoln City
  contradicts its receipt ($172.50 vs $250). Review items raised; schedules are never auto-changed.
- Data fixes available as DRY-RUN scripts (run with `--apply` only after reading the dry run):
  `scripts/scrub-shared-knowledge-names.ts`, `scripts/audit-learned-provenance.ts` (70 benchmark-keyed
  KB profiles), `scripts/reconcile-fee-receipts.ts`, timeline backfill (see the tier-2 repair notes).
- A broken stored template: City of Happy Valley checklist `304d67b7` throws in pdf-lib on fill (e6b3afde).
- ec5c36d3's status is stale (filings made, still `ready_to_stage`) — correct it with the status override.

**Open (not fixed):** ~~91 unit tests still append to `data/logs/backend.log`~~ (fixed later, `497d99f`);
`autoLearnAdapter.test.ts` does NOT hang — its 33 cases take 6–118 s each (~12 min total), longer than
the 300 s per-test budget in `.probe/run-chain.mjs`; `mbox_learning_records` not org-scoped; no UI yet for KB/fee-schedule "Verify" or
correction "retract learning"; the kit's source comments mention real past jobs (strip before handing
the folder to a third party).

## THE CHAIN RAN; THE PAGE SAID IT HADN'T (2026-09-23)

Operator, on the demo kit: "the nem fee, or the auto build not going after qc and verify".

- **The page never loaded the chain's results.** AHJ docs, reviewer gate and historical check
  lived only in browser memory after a button click, so a project the stage-step chain had
  carried to `ready_to_stage` opened with all three reading "not run". New read-only
  `GET /api/projects/:id/stage-results` (writes NOTHING — the plain reviewer-report GET records
  a text-only verdict and would overwrite the vision one) loads on project open; a
  `stage_steps_done` SSE refetches it live.
- **Verify never continued the chain.** `/human-verify` re-runs QC but only `/qc` enqueued the
  stage steps, so the last verified item passed QC and nothing built. Proven on a scratch kit
  server both ways: without the line the project sits at `qc_passed` with no job; with it,
  build_docs → reviewer gate → `ready_to_stage`.
- **Manifest PDF was silently dropped** from every prescriptive package — a "←" in its copy
  threw in pdf-lib's WinAnsi encoder. Non-WinAnsi characters now fold (`generatedDocFiles.ts`).
- **Two refuse-only offline switches**, set in the demo kit's `.env`: `PORTAL_AUTOMATION=off`
  (prepareSubmission 409s after every gate has spoken; `openPortal` refuses too) and
  `DOCUMENT_FETCH=off` (`fetchPublicDocument` refuses before sending — covers blank-form and
  fee-schedule downloads and the headed-browser fallback). Unset in production = no change.

**Verify live after pulling:** open a project whose chain has run (status `ready_to_stage`)
straight from the board — the three Build & Validate panels show results without any click.
Then Run QC with the project open: a "Pipeline ran automatically…" toast, panels refresh.

**Resolved later the same day:** Segment A's `rerunQc` no longer demotes `ready_to_stage` or resets
`stage_detail` on an unchanged pass (`qcMayMoveStatus` + no-demote rule), and the autopilot phase is now
computed live — a stale blocked job result is history, not the current state.

## THE REVIEWER GATE WAS CLEARING WORK IT HAD NEVER CHECKED (2026-09-22)

Commits `da1e40b` … `8c9c3c8` (nine). Session ended cleanly here: tree clean, backend chain
**153 suites / 0 failures**, `npm run smoke` passed, typecheck clean. Branch
`claude/busy-hopper-c2at3x`, **190 commits unpushed to origin** (local only — safe on disk,
but nothing is off this machine).

Trigger: operator asked to "stretch the legs" of the reviewer gate. Twenty distinct defects
found and fixed — my own probes plus a 27-agent adversarial workflow (22 reported, 20 survived
independent verification). Every fix was measured against a COPY of the live 23-project book
before shipping, and every one is revert-proven (disable the fix, watch the named checks fail).

### The five that mattered, all FALSE CLEARS

A false blocker wastes an afternoon; a false clear puts a defective filing in front of an AHJ
with a green report attached. All five are the latter.

1. **The interconnection screen had no final `else`.** `if / else-if / else-if` with nothing at
   the end, so a method matching none of the three vocabularies emitted NOTHING. The 120%
   busbar arithmetic exists in exactly one place and QC only checks the rating FIELDS ARE
   PRESENT, so an unrecognised wording skipped the only NEC 705.12 calculation in the product.
   Trigger is the parser prompt's own first example — `"Net Metering"` (`llm.ts:1070`) — and
   **Daniel Daly's live row carries it verbatim**. Six of eight realistic wordings were silent;
   now zero. Unknowns get `city.elec.interconnection-unclassified`, deliberately NOT routed
   into the load-side branch (that would demand a busbar calc from a possible supply-side tap).
2. **`"Non-prescriptive"` contains `"prescriptive"`.** Bare substring test inverted the
   structural gate: such a project got the PRESCRIPTIVE blockers and was never asked for
   stamped engineering, while `"Engineered"` was handled right. That is the operator's TPO
   ruling exactly — TPO roof ⇒ non-prescriptive ⇒ those are the jobs that needed stamps.
   THREE expressions answered that question three ways; all now read
   `permitPath.pathWordingScope`.
3. **A zoning setback is not a firefighter access pathway.** Fire evidence accepted bare
   `setback`/`ridge`/`eave` then granted HIGH confidence for any dimension anywhere. A set with
   no fire content produced a byte-identical report to one with a dimensioned IFC 1205.2
   pathway. Over-determined, which is why it survived: removing any one word changed nothing.
   Replacement vocabulary is HARVESTED from the operator's corpus (`FIRE PATHWAY`, `FIRE
   ACCESS`, `36" FIRE SETBACK`), not invented — generic words count only near the word "fire".
4. **A field with two numbers was not a number.** `num()` stripped non-digits and parseFloat'd
   the concatenation. Bren Trask's live `pvBreaker` = `"50A (fuses in 60A AC disconnect at
   line-side tap)"` read as **5060 A**. Failed both ways: `"200A (Note 3)"`→2003 silenced a real
   violation; `"175A (2 of 2)"`→17522 blocked a compliant one and printed it to the operator.
5. **A photograph cannot overturn arithmetic.** `topicForFinding` maps
   `city.elec.load-side-over-120` to `sld`, so a "the SLD is on the sheet" verdict downgraded a
   MEASURED 250A-on-240A violation to a green "Vision-verified" callout. Four findings are now
   withheld from vision (`MEASURED_FINDING_IDS`), guarded in two places — `needsVision` skips
   the call, `applyVerdict` re-checks on read so a verdict cached before the gate existed
   cannot still downgrade.

Also: five evidence lists any ordinary drawing could switch off (`/mount/i` cleared the
attachment blocker; `/structural/i` cleared roof framing — including a sentence SAYING framing
was absent; bare `/fire/i` and `/ESS/i` (matches "addrESS") silenced the battery review;
`/truss/i` opened the span exemption for "rafter/truss" and "not truss"); an Enphase BATTERY
reclassifying a string design as MLPE and downgrading its rapid-shutdown blocker; a
low-confidence vision verdict rendering as a green ✓; dedupe ranking specificity above severity.

### THE PATTERN — read this before touching the gate again

Six times, two modules answered ONE question with different vocabularies, and **each fix
unmasked the next**, because the dedupe/precedence layer had been hiding the blind sibling.
Mount → fire → prescriptive path → interconnection side → MLPE. Budget for the chain; the
second failure is usually the pre-existing bug becoming visible, not a regression from your fix.

Detection signal: **the gate contradicting itself** — one rule withholding a finding its
sibling raises. The blind one is the bug.

The MLPE instance was caught ONLY because the full chain re-ran a test that had passed
standalone two commits earlier. **Run the whole chain after each of these, not just your suite.**

Fix shape: export ONE predicate, import it, and give it an entry point that derives its own
inputs (`mountKindForProject`, `isMlpeDesignForProject` take only the project) so a second
caller cannot reach a different answer by feeding it a different text blob. Check import
direction first — this repo has a circular-import precedent.

### New suites (all in `backend:test:unit`, ~100 discriminating checks)

`interconnectionSide` · `groundMountScope` · `ratingParse` · `firePathwayEvidence` ·
`permitPathWording` · `evidenceSpecificity` · `visionRelaxScope` · `reportHonesty`.

`reviewerOregonGolden.json` was regenerated ONCE, deliberately: the fixture's entire plan text
is "one-line diagram rapid shutdown site plan roof plan" — it genuinely has no attachment
detail and only ever cleared that screen via `/mount/i` matching "Roof-mounted". Exactly one
finding added, nothing removed (verified by diffing ids+severities); `baselineOregonGolden.json`
byte-identical, which proves the QC-side engine did not move.

### Live blast radius, measured — ZERO real customer projects gain a false blocker

Book total 15 → 19 blockers. The four additions are the demo rows + `Test Testerson`, all of
which carry no extracted plan text. `Daniel Daly` gains the unclassified-interconnection
warning. Trask's `5060` becomes `null`, which costs nothing today (he is a line-side tap, so
the load-side rule never runs on him) and routes honestly to "ratings not readable".

### WHAT TO DO NEXT, in order

1. **Daniel Daly's interconnection** — his busbar screen has never run. Record the method as
   supply side or load side before that filing goes out.
2. **Demo data gap (new, found here):** the four demo projects have NO extracted plan-set text
   in their snapshots (~451 chars, no plan-text keys) even though `scripts/demo-environment.ts`
   emits a proper attachment detail on its ROOF SECTION sheet. The text is written and not read
   back. That is why they flag on attachment — a demo-data bug, not a rule bug.
3. **Trask's `pvBreaker` field** — the real repair is for the parser to put `50` in the field
   and the note elsewhere. `null` is what makes that visible instead of silently wrong.
4. **Vision cache key (left deliberately):** keyed to the plan-set PDF alone (path, mtime,
   size), so a verdict outlives the project data the finding measured. The dangerous half is now
   closed from the other side; tightening the key invalidates the cache on every snapshot edit
   and buys the vision calls back. A cost decision, not a bug fix.

### Probes kept on disk (`.probe/`, gitignored — not in any commit)

17 scripts. Most reusable: `rulecoverage.ts` (3,840-project matrix; all 18 reviewer rules now
proven reachable, was 16), `liveimpact.ts` / `round2live.ts` / `round3live.ts` (per-project live
verdicts), `firevocab.ts` (harvest real vocabulary from the corpus BEFORE tightening a list),
`numimpact.ts`, `evidencelists.ts`, `dtoguard.ts`. `.probe/from-stress/` holds the 8 probes the
adversarial agents wrote — `__tmp_fireRefute.ts` found the best defect of the session.

Two measurement traps hit here, both worth repeating: a coverage probe that grepped
`codeReviewRules` AND `baselineRules` together reported 14 dead rules, 11 of which belong to QC
(a different pipeline stage) — two subsystems conflated, one scare manufactured. And
`firevocab.ts` printed matched LINES truncated at 160 chars, which made Basson look
evidence-free; she has `36" at ridge and 18" at edges/eaves`. **Print the match, not the line.**


## THE PIPELINE DRIVES ITSELF, AND THE KB'S COLUMNS TELL THE TRUTH (2026-09-21)

Commits `c4f714f` … `ecf571a` (UI density, auto-chain, valuation formula, bot round, KB sweep).
Every operator ruling this stretch is quoted in the relevant commit.

### What is now automatic (and what never will be)

`autoStageSteps.ts`: a parser save/update, a document upload, or a plan-set split enqueues ONE
`stage_step` job that runs QC → form ACQUISITION (the same cooldown-guarded
prepareOfficialDocuments seam staging uses — a brand-new AHJ pulls its forms on first contact)
→ AHJ/NEM doc package → reviewer gate (with vision, cached) + historical check, each step
re-reading live status first. **The chain stops cold at `ready_to_stage`** — zero portal_runs,
zero submissions, imports asserted browser-free (autoStageSteps.test.ts §3). An empty package
writes `stage_auto.docs_unbuildable` instead of stalling silently. Kill switch
`AUTO_STAGE_STEPS=0`. Segment A now also builds the package en route, and the button reads
"Stage portals · Autopilot" — staging and Approve & Submit remain the only human gestures.
Proven live on Basson/Douglas County: parse → ready_to_stage/reviewer_gate_approved with no
clicks once the split supplied the missing sheets.

### The operator's valuation formula (ruling, from their spreadsheet)

valuation = **contract × 0.4 + battery adders** (AP Systems $7,000 / Tesla $8,500 / unknown $0,
qty default 1 when a battery is on file) — `valuation.ts`, factor env-tunable
(PERMIT_VALUATION_CONTRACT_FACTOR), >1 refused as a typo. The per-watt fallback estimates the
CONTRACT then applies the formula, and stays labelled an estimate. jobValue had been placed on
applications unchanged — overstating every valuation 2.5× and every valuation-laddered fee.
Trask $30,000 → $12,000; Connie's real contract $56,156.78 (operator-supplied, audited) →
$22,462.71; Basson $21,917.72 → $8,767.09 with correctly NO adder (DS3-L are microinverters).
Five tests repinned with the ruling cited; the Albany fixture proves it on bracket SELECTION.

### The KB portal-column sweep (operator: "ensure it doesn't happen again")

94 defective rows, three layers of fix (`ecf571a`, kbPortalColumns.test.ts):
- **71 rows** (the Permit Processes workbook import, six states) had the portal URL in
  `portal_name` with `portal_url` empty — the Tigard and Douglas wrong-portal incidents were
  just the two caught live. WRITE: upsertKnowledge (the one funnel) routes a lone URL-shaped
  name into portal_url. READ: mapper falls back for legacy rows. DATA: 26 filled.
- **23 AHJ-side rows** carried the utility's PowerClerk; **Happy Valley was fully inverted**
  (EnerGov in name, PowerClerk in url). The permit exact-key lookup now reads BOTH columns and
  takes the first NON-utility http candidate — the inversion self-heals, both-utility yields
  EMPTY (hard rule 5 at the data seam). Happy Valley swapped, Coos Bay's stray cleared.
- **Ambiguous, left for the operator:** `or|newberg|unknown` and `or|wilsonville|unknown` carry
  TWO urls in one name cell — nothing was guessed.
- Rulings applied same-day: **Tigard → Tyler EnerGov** (tigardor-energovweb.tylerhost.net;
  recipes reset to v2, EnerGov credential still NOT on file) and **Douglas County → iWorQ**
  (douglascounty.portal.iworq.net, 2 credentials on file).

### The bot (portal-bot round, `cfba798`)

- Login-reveal invariant: a control is a login reveal because IT is described as one — attached
  menu text may confirm/veto, never establish (the PowerClerk program-picker popup, killed).
- Replay speed: the 3s post-fill sleep drops to 300ms when the portal's own autosave indicator
  says Saved (absence of the signal ≠ saved); the 15s drift budget early-exits on a page that
  rendered real fields and held them stable across three scans (field-less pages keep the full
  budget — interstitials redirect late).
- **Generated docs are attachable**: `generatedDocFiles.ts` renders the application package
  (transfer sheet, worksheets, prescriptive application) to PDFs at the prepareOfficialDocuments
  seam; precedence generated < filled official < operator upload, proven by displacement test.
- Splitter dialects from the Basson set: "ELECTRICAL LINE DIAGRAM" → sld; "EQUIPMENT
  SPECIFICATION" pages → module_spec + inverter_spec.

### Douglas County / Basson state

Project `3b9ce10c` at ready_to_stage/reviewer_gate_approved; engineered path (PE Pantel
99490PE, sealed letter + stamped drawing); meter 82 031 149 and account 37824571-0017 verified
against the operator's bill + photo; fee schedule researched as SEEDED $79/$94/$156 by kVA
(+$6.25/kVA over 25) — 3.072 kW AC addition prices $79; verify against the county's page before
quoting. Cover cites 2025 OSSC/NEC 2023 while the letter runs ASCE 7-16 — flag if the county
comments. UI density round (`c4f714f`/`992fe4f`): detail page 4,467→1,783px on Connie, parser
5,906→2,359px, readiness collapsed to one line, honesty markers verified inline by an
adversarial pass; Trask/Ann/Ivy remain above target on purpose (open questions may not hide).


## TIGARD FILES THROUGH ENERGOV, AND TRASK'S $1,310.69 IS DERIVED, NOT REMEMBERED (2026-09-20, night)

Commits `3f2b097` → `69b90f4`, plus a live KB correction under an operator ruling.

### OPERATOR RULING: Tigard is Tyler EnerGov, not Accela

The operator, watching a live staging run: *"its trying to submit a tygard permit through
acella, thats not the right place."*

Root cause, measured: the KB held two human-confidence rows for Tigard that DISAGREED.
`or|city of tigard|pge` — the exact profile-key match for Connie's project — carried
**"Oregon ePermitting (Accela)"** written by **AI research whose own notes said "verify against
the official site before relying on it"**. `or|tigard|unknown` carried the right portal —
**Tyler EnerGov CSS, `tigardor-energovweb.tylerhost.net`** — sourced from the operator's own
AHJ process workbook and real historical Tigard filings, but with the URL stored in
`portal_name`, where no resolver reads it. Exact-key beats fuzzy, so the unverified AI claim
outranked the operator's ground truth; two Accela recipes (needs_rerecord) then fed the same
wrong URL into the staging ladder AHEAD of the KB row (`findAnyRecipeForProject` has no status
filter — a needs_rerecord recipe still supplies its portal URL).

Fixed through the production write paths, never raw SQL: `saveVerifiedAhjProfile` on all three
Tigard rows (EnerGov URL + the ruling in notes; confidence `mixed`), and `startPortalRecording`
(the delete-&-re-record path) on both recipes — v2, steps cleared, pointed at EnerGov. Verified
through the exact lookups staging makes: the bare `ahj = 'City Of Tigard'` KB read and
`findAnyRecipeForProject` both return EnerGov; zero Tigard rows still name Accela.

**Open items from this:**
- **No credential exists for `tigardor-energovweb.tylerhost.net`** — the operator must add the
  EnerGov login before Connie's staging can complete. The recipes are empty; first pass is a
  fresh auto-learn on the right portal.
- **The pattern is not a one-off (Round F candidate):** AI research can land a portal claim on
  an exact-key row and outrank workbook-sourced knowledge. An engine-level guard — research may
  not contradict a portal whose sources include the operator reference workbook without
  flagging the conflict — would have caught this before a browser opened.

### The fee round: Trask went $450 → $890.08 → $1,310.69, each step from a published schedule

The operator authorized research spend for the AHJs with no fee rows. What happened, in order:

1. **`3f2b097`** — research calls were dying at a 4,000-token ceiling (3 of 5 truncated:
   Portland structural, Lincoln City, Salem). Raised to 16,000; all three succeeded on retry.
2. **New seeded rows on live:** Happy Valley (prescriptive $157 flat + 12% surcharge + 65%
   conditional plan review), Lincoln City ($250 prescriptive — **row partly garbled**, see
   below), Salem permit (4 kVA rungs $79–$156 + $5 automation surcharge + conditional plan
   reviews). Portland structural re-researched WITH its ancillary charges (65% plan
   review/process unconditional, $114 revision fee, $167 reinspection); Portland electrical
   re-researched with the 12% state surcharge and its overage fees.
3. **`bb57180`** — the valuation-ladder branch RETURNED EARLY and skipped the rest of the
   evaluator: surcharges and ancillary charges (percentages OF the permit fee) were silently
   dropped. Portland's 65% plan review is $384.85 of Trask's filing and his sheet showed
   nothing missing. The ladder now replaces only the bracket AMOUNT; every rule below runs on
   it unchanged. The conflict check deliberately stays on the STORED bracket (its evidence
   names the base rung, not the computed fee).
4. **`e13e906`** — **two kinds of "conditional", split (agent design decision, like the phone
   leg — say the word to change it).** The unpriced-conditional-charge-nulls-the-total rule was
   written for reviews that are mandatory above a threshold; it also caught OVERAGE fees
   (reinspection, plan revision, extra checksheets), and every jurisdiction researched today
   publishes one — so no total could ever resolve. Ground truth: the operator's paid $762.93
   Portland receipt contains ZERO overage charges. `chargeIsFutureContingent` (a tested literal
   regex like FORMULA_LABEL, mustExclude proven — a bare "additional" releases nothing)
   releases only unmistakable overage wording; released charges still render as "IF IT
   HAPPENS", never in unknowns, never nulling. Default is HOLD.
5. **`69b90f4`** — a kVA threshold the schedule prints is answered from the project's own
   size: 7.5 kVA against "Over 25 KVA (Plan Review Required)" resolves NOT-APPLIES by the
   jurisdiction's own words. Exactly 25 is not over 25; no size on file stays an open
   question; recorded facts (electricalReviewRequired) outrank the threshold toward charging.

**Live prices after all of it** (all SEEDED — verify against the published page before quoting):
Trask/Portland **$1,310.69** self-checking ($298 + $35.76 surcharge + $592.08 ladder + $384.85
plan review, five overage fees listed beside and excluded); Connie/Tigard $313.56; Ivy/Coos Bay
$335.00; Daly/Salem **$99.00** ($94 + $5 automation); Abby/Happy Valley $116.48–$175.84.

**Verify-with-a-receipt items (D2 residue):**
- **Lincoln City's row is garbled:** "Renewable energy for electrical systems 15.01–25 kVA |
  $250" is stored as a conditional ANCILLARY CHARGE — that is a bracket rung, not a charge —
  and Randal still prices as an ESTIMATE. Delete-and-re-research or hand-fix from the cited
  PDF (`lincolncityor.gov/home/showdocument?id=1795`).
- **Salem's $99 rests on an `appliesTo` skip:** the 65% building plan review carries
  `appliesTo` scoping and Salem's row is discipline `(any)`, so it was skipped rather than
  answered. Right if Salem prescriptive solar is electrical-only (the brackets are all
  "Renewable Electrical Energy" rungs, so probably); prove it against a real Salem receipt
  before trusting the skip.

## RESTARTED ON THE NEW CODE, AND PORTLAND PRICES PROPERLY NOW (2026-09-20, later)

Four commits after the C.5 section below: `df7191e` (a collapsed word boundary), `9e8292a`
(backup-directory ownership), `1505740` (the Portland valuation ladder), plus the restart.

### The live server was restarted, and it moved port

It had been up 5.6 days on code that predates Rounds A/B/C/C.5 — live `schema_meta` was still at
v28. It is now running detached (`cmd.exe` wrapper, log at `backend/data/server.log`) so it
survives a session ending.

**It answers on `http://localhost:4173` now, not `:4200`.** The old process had `PORT=4200` in
the shell that launched it; nothing in the repo or `.env` says 4200, and `PUBLIC_BASE_URL` and
`.env` both say 4173, so the restart put it where the configuration always pointed.

Post-restart, measured: migration **v29 applied**, `projects.stage_detail` column present, row
counts identical to the pre-restart pin (16 projects / 1 client / 91 submissions / 182 documents
/ 2 corrections), `stageCount: 5` on the live API, Ann Marineau rendering `issued` → stage
`track` (3 of 5), and the boot backup wrote a real 16.8 MB live snapshot to E: with 2,581
documents mirrored.

### A word boundary had collapsed into a backspace

`frontend/parser.html` carried `/\s*-\s*\d{3,4}\s*W(?:ATT)?<0x08>/i` where the author wrote `\b`.
Heredoc writing on this machine eats one level of backslash: `\n` collapses loudly into a parse
error, `\b` collapses silently into a literal backspace byte that is invisible in every editor,
in grep and in sed. The regex compiled, required a literal 0x08 after the W, and matched nothing
— so `stripModuleMakeFromModel` stopped stripping wattage suffixes off module models.

**Measured blast radius: zero live rows.** All 16 live parses hold a clean `moduleModel`
(`ZXM7-UHLD108-440/N`, `Q.TRON BLK M-G2.C1+/AC`) because the identical regex 500 lines below it
still reads `\b` and handles the path they went through. A disarmed guard, not an active wrong
answer — which is exactly why it sat there for months.

`backend/test/sourceControlBytes.test.ts` is the durable half: it reads the BYTES of all 529
tracked source files and fails on any control character that is not tab, CR or LF. It proves its
own detector can see a collapsed `\b`, `\f`, `\v`, `\e` and `\0` before it reports a clean tree,
and refuses to report anything until git has listed a plausible number of files including three
named anchors — a scan of zero files must never read as a clean result.

### One backup directory backs up one database

The test suite had been filing snapshots of its own scratch databases onto the operator's real
backup drive: six tests boot the real server, the server starts the backup scheduler, the
scheduler snapshots at startup, and none of them overrode `BACKUP_DIR`. Three 1 MB files per
chain run, sitting among the 30 MB real ones, with rotation unable to tell them apart.

A backup directory now records which database it is FOR (`.backup-source.json`); a different
database is refused, told whose directory it is, and told that re-pointing deliberately means
deleting the marker. Paths compare the Windows way, so `C:\x` vs `c:/x` can never lock the live
server out of its own backups. **The marker on E: was seeded by hand to name the live database**,
so a test run can never claim it first. The six tests also got their own temp `BACKUP_DIR`.
Nine runs afterwards left the drive holding exactly the real pins and nothing else.

### Portland prices properly now — Trask went $450 → $890.08

Bren Trask's real filing was quoted at $450: the 1.5%-of-valuation heuristic, from a method that
has never read Portland's fee table. His structural bracket is a valuation LADDER and the
evaluator refused every ladder outright — right while the rest of the sentence went unread, and
it is all there in the bracket's own label: base, step, per-step rate and the rounding rule.

`parseValuationLadder` / `evaluateValuationLadder` read it out of the quote at evaluation time —
no new column, and no new place for an untrusted writer to put a number. Trask's structural line
is now **$592.08** (`540.78 + ceil(5000/1000) × 10.26`) and his filing **$890.08**, from the
published schedule instead of a guess. `$50,000` on that rung computes to `$797.28`, which is
exactly the next rung's printed base — the ladder agrees with the published table at the seam.

What it still refuses, on purpose: a label whose stated base contradicts the bracket's own fee;
the kVA formulas (Tigard stores the rate, Portland electrical a rate with no base, Coos County
the base — three meanings for one column); and a ladder with no valuation, which now says so
explicitly. A ladder walked on a per-watt ESTIMATE says that too, because every step is $10.26
of real money and a figure accurate to the cent can still be wrong by however far the guess is.

### THE REMAINING PORTLAND GAP — the ancillary charges are not on the live row

The operator's complaint was that PDX fees "can get upward of like $1300 sometimes". $890.08 is
the two PERMIT LINES only. The live `City of Portland` rows carry **zero** `ancillaryCharges` and
**zero** bracket surcharges — so the 12% state surcharge, the 65% plan-review/processing charge,
the fire plan review and the land use review that the $762.93 receipt reconciliation proved the
engine can model are simply absent from the stored schedule. The machinery works
(`feeFilingCharges.test.ts` reconciles that receipt per charge); the DATA is missing. Populating
those on the live Portland rows is the next concrete Round D step, and it is what closes the gap
between $890 and the operator's remembered ~$1300.

### Fee coverage across the active six, priced for real (open projects)

| Project | AHJ | Total |
|---|---|---|
| Connie Rhinesmith | City Of Tigard | $313.56 |
| Christopher Ivy | City of Coos Bay | $335.00 |
| **Bren Trask** | **City of Portland** | **$890.08** |
| Abby Johnson | City of Happy Valley | ≈ $450.00 ESTIMATE |
| Randal Rowland | City of Lincoln City | ≈ $455.40 ESTIMATE |
| Daniel Daly | City Of Salem | ≈ $336.60 ESTIMATE |
| David Simmons / Wynema Wright | City of Coos Bay | ≈ $435.99 / ≈ $277.20 ESTIMATE |

Every remaining ESTIMATE is an AHJ with no permit schedule row: Happy Valley and Lincoln City
have none at all, Salem has a NEM row only. That is Round D2's whole scope.

### The C.5 resolver, measured on every live project

Re-wrapping each stored parse into the shape the `/api/parser/llm-extract` seam actually passes
(`{value, confidence}` — the flat `parser_json` is the post-normalisation artifact, not the seam):

- **2 auto_assign** — Ivy and Ann, exact CCB 223690 on TML.
- **2 preselect** — Trask and Abby, the plan set's company + phone, no CCB, confirmation required.
- **12 none** — older parses that carry no installer fields at all.
- **0 wrong.** Every suggestion agreed with the client actually bound.

One provenance note, because it reads the other way at first glance: Ivy's and Ann's CCB was
filled in from the client record by the intake-requirements flow, not read off the title block —
Ivy's row still carries the literal prompt string "Add the installing contractor's Oregon CCB" in
a neighbouring field. Trask and Abby are the rows that hold what a plan set actually prints, and
neither has a CCB. The claim stands: these plan sets do not print one.


## ROUND C.5 — THE PLAN SET NAMES THE COMPANY, AND BACKUPS HAD BEEN EATING BACKUPS (2026-09-20)

**Commit `183b4aa`. Pre-D verification: typecheck clean, backend chain 142/142 (last banner
`backupRotation: all checks passed`), `npm run smoke` green.**

### The company now comes off the plan set

Round C3 made `clientId` required on project create. Without this round that would have meant a
coordinator picking the company by hand on every parse — the opposite of the operator's note
*"Need to make company locked parse — don't have them select it themselves."* The parser prompt
has read the title-block contractor since long before this (`llm.ts`, the CLIENT ONBOARDING block,
nine `contractor*` keys) and dropped it on the floor. `backend/src/clientMatch.ts` turns that
reading into a client binding, returned on the existing `/api/parser/llm-extract` response as
`clientResolution` — no new route, additive, try/catch-wrapped so a resolution failure can never
take down a parse that otherwise worked.

**The premise this round was planned on was WRONG, and the corpus is what says so.** The plan said
*match on the CCB licence number first, name second — Oregon plan sets print the contractor's CCB
in the title block.* Measured across ten plan sets from `L:/INFINITY SOLAR DOCS/01 - CUSTOMERS`
plus all 23 pages of Bren Trask's set, every one prints

    INFINITY HOME SOLUTIONS / 6405 E MILL PLAIN / VANCOUVER WA 98661 / PHONE: 1-800-818-0598

and **not one prints a CCB**. The printed name scores **0** against both stored names on the only
client on file (`TML INTERNATIONAL LLC`, dba `Infinity Solar USA`) — one shared token out of three
clears no band in `knowledgeNameMatchScore`. A CCB-first/name-second resolver would have matched
nothing on 100% of the real corpus: a shipped no-op.

So the phone became an exact leg, and the decision ladder is now:

| Signal | Decision |
|---|---|
| exact CCB on exactly one client | `auto_assign` — binds with no prompt |
| exact phone, or a strong name (>= 78) | `preselect` — fills the picker, **a human must confirm** |
| weak, or two plausible companies | `candidates` — shows them, assigns nothing |
| nothing | `none` — offers to onboard the extracted company, prefilled |

**A phone number never binds on its own, by design.** A CCB identifies a contractor in a state
registry; a phone number identifies whoever answers it this year. Auto-assigning on a guess files
the job under the wrong contractor's LICENCE, which is worse than asking. **This rule is the
agent's design decision, not an operator ruling — it is live and tested, and it is the thing to
change first if the operator wants it stricter or looser.**

Two further rules worth knowing before touching this file:

- **A contradicted CCB disqualifies a client outright.** Plan-set CCB present, client CCB present,
  and different -> that client is dropped before any scoring, however well the names read. This is
  the second-solar-company-with-a-similar-name case, settled by rule instead of by score.
- **The three licence columns are never interchangeable.** `clients` carries a CCB (223690), a
  company electrical licence (C1556) and a metro/city licence (14838); only plan-set CCB is ever
  compared against `ccb_license_number`. The supervising electrician's personal licence (5787S) is
  a PERSON and is not a matching key at all.

Verified on the LIVE clients table through the production read path (read-only, no migration
applied): the real plan-set identity resolves `preselect` -> `tml-international-llc`,
`requiresConfirmation: true`, on the phone leg (`1-800-818-0598` vs the stored `(800) 818-0598`).
Control: `SUNRUN INC` resolves `none` and binds nothing.

### Backups had been eating backups

An agent starting a throwaway test server set `BACKUP_INTERVAL_HOURS=0` meaning "off".
`Number("0" || 24)` is **0** — `"0"` is a truthy STRING, so the `||` default never fires — and
`setInterval(tick, 0)` then wrote a snapshot roughly every two seconds. `BACKUP_KEEP=14`, so within
a minute the fourteen junk snapshots it had just written **had rotated every real restore point off
the operator's backup drive**. Four survived only because copies happened to exist in a scratch
directory; they are now pinned under `E:/SOLAR-Proj-Backups/restore-points/`.

Two fixes, each proven by reverting it:

1. `backupIntervalMs()` — non-positive or unparseable means **OFF**, as it already did in every
   other scheduler here (`MONITOR_INTERVAL_MINUTES`, `AHJ_FORM_REFRESH_DAYS`, `KB_LINK_CHECK_DAYS`,
   `CEC_SYNC_DAYS`). The startup snapshot still runs, so disabling backups keeps the state you
   disabled at. Reverted, the test writes **six** snapshots in 400ms.
2. `isAutomaticSnapshot()` — rotation retires the automatic series only. `runBackup` is the only
   writer and always names files `autopilot-<ISO stamp>.sqlite`, so an automatic snapshot always
   has a digit right after the prefix; anything else (`autopilot-manual-…`, `autopilot-pre-connie`,
   `autopilot-BEFORE-round2`) was named by a human ahead of something risky and is not rotation
   fodder. Reverted, **0 of 3 pins survive**.

`backend/test/backupRotation.test.ts` covers both, with MUST-PASS controls so that turning either
fix into "always off" / "never prune" fails too.

**Live `.env` confirmed for this phase:** `SEED_TEST_INSTALLER=false`, `CLIENT_NOTIFICATIONS=false`,
`BACKUP_DIR=E:/SOLAR-Proj-Backups`, `BACKUP_INTERVAL_HOURS=24`. Note the fix changed what `0` means
in that last one: it used to mean "every two seconds", it now means backups OFF.

### What the pre-D gate measured on the live data (copy, never written)

Rounds A/B/C all CONFIRMED on real projects — five stages with no dead statuses, the corrections
legs writing `ready_to_resubmit`/`awaiting_human_resubmit` and never `parsed`, the approve seam
writing `approved_awaiting_filing` with the banner rendering in real Chromium, capture creating and
deduping check targets, Salem's six name spellings resolving to one `requiresStructuralStamp=false`
profile, and project-create refusing a client-less payload at 400. Track counting by track and not
by row still bites where it matters (Ivy 5 rows -> 0 outstanding, Daly 9 -> 1).

Two measured numbers corrected an earlier claim in this file and in the plan:

- **Daly `8f4ca8dd` is TRACKS=1, not 0.** Its newest interconnection row genuinely is
  `awaiting_human_submit` and so is the project — 1 is the truthful answer; the expectation was stale.
- **Bren Trask's null building fee is NOT a missing job valuation.** His parse carries
  `jobValue "30000"` and the $25,001–$50,000 valuation bracket resolves fine. The engine refuses
  because that bracket is a **FORMULA** (`bracketDescribesFormula`) and the stored $540.78 is only
  one part of it. **Round D's planned "enter a job valuation" affordance would not clear this null** —
  the real work is either evaluating formula brackets or an operator affordance that records the
  portal's own figure with provenance.

**Fee coverage for the active six, as of this gate:** Coos Bay / Coos County, Portland and Tigard
have permit rows; **Salem has a NEM row only**; **Happy Valley and Lincoln City have no
`fee_schedules` row at all**. All 12 rows are `seeded`; none is `verified`. That is Round D2's real
scope.


## LOCKOUT, SUPERVISED LEARN, INVOICING, AND 26 ROWS POINTING AT THE WRONG PORTAL (2026-09-13)

Operator direction for this stretch: single tenant (their own company), so cross-tenant safety is
not the threat model — get it working reliably and stop there.

**New operator commands**

    npm run learn:supervised -- --project "<name>" [--track nem|electrical]
    npx tsx scripts/invoice.ts --project "<name>"
    npx tsx scripts/fix-ahj-portal-urls.ts [--apply]
    npm run recipe:bind-fee-brackets -- --id <recipeId> [--apply]

**Portal lockout (asked for directly).** We cannot detect a password change — the first sign is a
failed filing — and re-attempting is how an account gets locked, on the operator's own licence. The
`stale` flag had been correct for months but only `runLearnBenchmark` read it, so every real stage
kept knocking; 12 credentials on the live client were in that state. `prepareSubmission` now refuses
at 409 **before a browser opens** (`credentialLockedOut: true`, `PORTAL_CREDENTIAL_LOCKOUT=0` to
disable). Safe in the direction that matters: `stale` is set by `recordLoginOutcome`, which refuses
when `isHarnessAbort(note)` — the guard that exists because a dead browser was once logged as six
credential failures and retired seven working platforms. Tested explicitly.

**Supervised learn.** The machinery existed with no door: `autoLearnPortal` takes `headless:false`
and the adapter arms `armHumanCaptureOnPage` on every page, so a human's clicks and typing become
recipe steps and merge. A supervised run is a lesson, not a manual filing. Two things it surfaced:
resolve the portal the way staging does (recipe URL first, then KB, each through the utility-platform
filter), and with no `--track` the discipline is `""` which must mean "any discipline" rather than
"only an untagged recipe" — otherwise it finds nothing on any jurisdiction learned since the
discipline dimension landed.

**Per-project invoicing.** Two totals kept apart and NO grand total: fees we advanced
(`keelix-pays` only — pass-through) versus our service fee (revenue). Migration v24 stamps
`fee_responsibility` + `fee_recorded_at` on the payment row AT RECORD TIME, so editing a credential
later cannot rewrite an old invoice, and `fee_recorded_at` is the column a monthly statement will cut
on (`paid_at` never fires for monthly clients; `updated_at` moves on any touch). A published
SCHEDULE bills as PROVISIONAL; the 1.5%-of-valuation heuristic never does — on the first live project
it said \$435.99 where the county says \$360. Written as a line-builder over payment rows, so monthly
is the same function plus a WHERE.

**Nothing invoices until `fee_responsibility` is set.** All 83 credentials are unset, and 0 of 90
submissions carry a `portal_profile_id`, so the resolver cannot fire. Data entry, not a bug.

**26 AHJ rows pointed at a utility portal.** `or|city of coos bay|pacific power` held a PacifiCorp
PowerClerk URL. Residue of the benchmark bug fixed earlier (utility picked by STATE, scope hardcoded
"ahj"), and on several rows the real permit URL was stranded in `portal_name`. Production was never
exposed — `permitSafeUrl` drops a utility platform on the permit path — but everything reading the KB
directly was wrong. Repaired preferring recovery: 1 from a recipe, 6 from `portal_name`, 19 blanked
(honest, and the coverage report then names the blocker). Human-verified rows untouched.

**Eight portal logins were in `permit_utility_knowledge.notes` in plaintext**, a shared table, and
those notes go to an LLM (`knowledgeResearchHint` -> `llm.findAhjFormUrl`; `autoLearn`'s KB block).
Redacted, and `noteSegments` now refuses credential-shaped segments — the guard caught that it was
only on `upsertKnowledge`'s UPDATE branch, so a brand-new jurisdiction went through raw. The four
logins involved (Multnomah County, Shoreline WA, Pacific WA, Anne Arundel MD) are worth rotating.

**Also fixed:** status updates went to `business_email` rather than the shared inbox the guide asks
for as REQUIRED; the invoice had no addressee beside a `billing_contact_email` column that names one.

**Verified at the end:** `tsc` clean; `backend:test:unit` 95 steps, last banner matching the last
chain entry, 0 failure markers; `portal:test:unit` green; `npm run smoke` passed. Coverage unchanged
at 1 ready / 11 supervised / 4 cannot-file of 16 — that is the number to move, and supervised learn
is the tool for moving it.

## THE SUITE THAT WAS NOT RUNNING, AND THE SIX DEFECTS IT WAS HIDING (2026-09-12, late)

`portal:test:dom` was 71 real-Chromium smokes joined by `&&`. Two were long-red at positions 9
and 47, so the chain stopped at the 9th and **62 smokes had never been executed**. Six of those
62 were red on first-ever run. None was a regression — all reproduce at `8cbec53`, before this
session.

`scripts/run-dom-smokes.ts` replaces the chain. It DISCOVERS `*.smoke.ts` from disk (a new file
runs without being registered — hand-maintained lists are how this drifted), runs every one
regardless of failures, prints a denominator with named skips, distinguishes TIMEOUT from FAIL
because they need different repairs, and turns the suite RED on a file it cannot classify. An
exit 0 with `FAIL -` lines in the output is its own reported category — that lie has happened
six times this session. One smoke legitimately takes 317s; the first timeout was set to 300 and
called it a hang.

### The six, and what each would have cost a filing

| defect | cost |
|---|---|
| an email step on a label reading `E-mail:` resolved to `""` | blank required field |
| a real battery filed its declaration and make but **not its capacity** | blank required field on an interconnection |
| `Submit an Application/Request` refused as an entry link | a whole jurisdiction with no way in |
| licence expiry had no binding key, so only a literal carried it | blank required field |
| four fixtures froze project data as unbound literals | noise — production was right |
| a bare `Name` label replayed the learn project's person | **wrong value, silent, cross-customer** |

### Two in the cross-project guard, both live

**A box labelled just `Name`.** `looksLikeProjectData` asked for "owner name", "first name",
"customer" — so the bare `Name` that PowerClerk, PGE and Ameren all print beside their contact
fields matched nothing and the recorded person replayed. This is the leak `3e42fec` exists to
close, still open under the label most likely to carry it, and it was visible in checks that
PASSED (`finalPageReassert` filing "ZZTest Replay Benchmark").

Widened on evidence: all 76 recipes were read first. Every person-name step is already bound,
so this costs them nothing, and the only unbound `name` literal in the corpus is
`"Permit Name" = "Solar PV System Installation"` — the portal's word — which is excluded
explicitly. A label naming a THING is not a label naming a person.

**A box labelled `Fax:` could never be told it was the wrong box.** `reanchorIfWrongControl`
filters identity tokens to >3 characters so "Job Category" and "Job Value" cannot agree on
"job". A label that is nothing BUT a short word therefore yielded an empty set — and an empty
set read as "nothing to contradict", i.e. accept. `Fax:`, `ZIP:`, `APN:`, `Tel:`, `Qty:` were
the one class of label no step could be contradicted on. The strict filter now applies wherever
it has anything to work with and short tokens are used only when there are no long ones, so
"job" is still never admitted and `*Type (Required):` — all stopwords — still has nothing to
contradict. Kill-tested: restore the empty set and an email lands in the fax box.

### A learn-side defect nobody had hit yet

    dateFieldForLiteral("Contractor Licence Expiration Date", "2027-04-01") -> "todayDate"

Every date that was not a future estimate fell through to "today", which is right for the
signature dates the function was written for and wrong for a licence: the next learn of an
expiry control would file a licence expiring the day it was submitted. The expiry rule now
requires the label to name WHAT is expiring — "Expiration Date" is also what a payment page
prints beside a card, and rather than duplicate `recipeAdapter.PAYMENT_FIELD` here, an expiry
with no licence context binds to NOTHING and a person sees a blank at review.

### Process notes worth keeping

- **Two assertions proved nothing and were caught by kill tests, not by reading.** A battery
  capacity check asserted only `cap !== "13.5"`; `""` is not "13.5" either, so it printed `ok`
  beside an empty box. An x-sort sabotage in `pdfTables` initially passed because a global
  sort's tiebreak was quietly doing the per-row ordering.
- **`labelFor`'s output is a MATCHING KEY**, not a display string — replay healing, consent
  detection and the battery declaration all match on it. Prefixing yes/no controls with their
  question to make them triageable broke three smokes and was reverted; that metadata needs its
  own field. Two Accela checkboxes are still recorded as the bare word "No" for this reason;
  triage prints where each sits in the walk so they stay decidable.
- **Concurrent agents collided twice in git**: a scoped `git add <path>` still committed another
  agent's already-staged index entries, and a `git commit --amend` rewrote a commit that had
  landed in between. Check `git diff --cached --name-only` before committing; never `--amend`
  in a shared tree.

### Verified state at the end of this session

    backend:test:unit   92 steps, last banner "feeBracketQuantity: all checks passed."
                        matching the last chain entry, 90 passing banners, 0 failure markers
    tsc --noEmit        clean
    npm run smoke       "Smoke test passed: ... and test project deleted cleanly."
                        (a trailing FOREIGN KEY warn is the job worker retrying
                        correction_triage against the project the smoke had just deleted)
    portal:test:dom     74 discovered = 69 passed + 1 failed + 1 timed out + 3 skipped
                        The 1 failed was multiArray, caused by the short-label widening in
                        this same session and fixed after that run (091b1b0) — green solo.
                        The 1 timed out was replica.dom.smoke at 600s; it passes when the
                        machine is not also running other browsers, so the suite's timeout is
                        load-sensitive. Worth confirming on a quiet machine before trusting it.

Still open, and each is somebody's decision rather than a missing line of code:

  - The Coos Bay electrical recipe has a step for ONE bracket box. A job in another bracket now
    correctly files "0" and FLAGS the run, but the sibling boxes have no steps. Closing it needs
    one human completion at the review screen on a job in another bracket, which
    appendHumanPatchSteps captures and auto-binds permanently.
  - Two Accela checkboxes recorded as the bare word "No" stay unclassified. The recorder needs
    to capture a yes/no control under its QUESTION, in its own field — not by changing what
    labelFor returns, which is a matching key.
  - replica.dom.smoke's runtime under load.

## THE FROZEN BRACKET, THE INVISIBLE HALF OF THE TRIAGE QUEUE, AND 63 SMOKES NOBODY WAS RUNNING (2026-09-12)

**The fee-bracket quantity is computed per job now, and it is bound on the live recipe.**
Accela prints one text box per bracket row of the county's fee table; the quantity ticks the row
that applies. The Coos Bay electrical recipe carried a frozen `"1"` against
`"Renewable energy for electrical systems- 5.01kva through 15kva:"` — the learn project's row,
replayed onto every job since. `resolveRecipeFieldValues` now emits one
`feeBracketQuantity:<min>-<max>` key per bracket of the project's schedule (through the
city-to-county hop), matched to the step's label BY NUMBER — `"5.01kva through 15kva"` and
`"5.01 KVA to 15 KVA"` are different strings and identical bounds. Replay needed no change: a
value of `"0"` is a non-empty string and survives its known/bound check, which was verified by
asking the real function rather than asserting it in a comment.

Measured on live projects after binding:

| project | AC kW | 0–5 | 5.01–15 | 15.01–25 | run |
|---|---|---|---|---|---|
| Wynema Wright | 5.376 | 0 | **1** | 0 | covered |
| Ann Marineau | 7.68 | 0 | **1** | 0 | covered |
| Christopher Ivy | 3.072 | **1** | 0 | 0 | **FLAGGED** |

Christopher Ivy is the case that was silently wrong: a 3.07 kW job typed `"1"` into the
5.01–15 box and was billed $160 where the county charges $135. It now types `"0"` — and the run
is FLAGGED, because the 0–5 box has no recorded step. **That flag is the honest half.** The learn
only captured the box its own project needed, so computing the recorded box correctly turns a
wrongly-billed permit into an UNDER-billed one unless somebody is told. It reaches both the review
screen's gap-fill banner and `driftWarnings`, so the run cannot score clean. Closing it properly
needs real steps for the sibling boxes — one human completion at the review screen on a job in
another bracket, captured through `appendHumanPatchSteps`, which auto-binds each new box by label.

Operator command, dry-run by default:
`npm run recipe:bind-fee-brackets -- --id <recipeId> [--apply]`

**A fee conflict no longer rests on a fall-through.** A disputed schedule was safe only because
`basis "other"` with ≥2 brackets happened to fall past every branch of `evaluateSchedule` to its
final `miss()`. Making that shape evaluable — a perfectly reasonable future improvement — would
have started quoting one of two contradictory numbers, silently. It is now an explicit
`conflicted` status checked at the top of the evaluator, with document dates per source (v23), and
it was verified by making basis-"other" genuinely evaluable and confirming no disputed number
escapes.

**Half the triage queue was invisible.** Coos Bay holds TWO complete recipes under one profile key
(city/structural, county/electrical) and `recipeForProfileKey` ended in `LIMIT 1`. `portal:triage`
listed the ELECTRICAL recipe's questions twice and never showed the structural recipe's own — its
record type, its building geometry, its "Plans - Structural" attachment. Both callers now pass the
recipe; an ambiguous key throws rather than resolving, because there is no correct single answer
when two exist. Both callers also wrapped the call in `catch { = [] }`, which turned any failure
into "this portal asks no questions". Queue went 16 → 2 after
`scripts/seed-question-classifications.ts` recorded the operator's calls with their reasons.

The two left are Accela checkboxes whose recorded label is the bare word **"No"** — the recorder
captured the option's text, not the question. Triage now prints where such a control sits in the
walk so it is decidable without opening the portal. **The real fix is NOT to change what `labelFor`
returns**: that label is a matching key for replay healing, consent detection and the battery
declaration, and prefixing it with the question broke three DOM smokes on the first attempt
(reverted). The question belongs in its own field.

**63 DOM smokes had not been running.** `portal:test:dom` is 72 smokes joined by `&&`.
`controlIdentity` (9th) and `batteryDeclaration` (47th) are long-red — confirmed against a
pre-session commit, so neither is new — and the chain stops at the 9th. Both are real filing
defects: an email step whose label reads "E-mail:" resolves to `""` (a blank required field), and
a real battery files its declaration and make but **not its capacity**. Being fixed, along with a
runner that runs every smoke and reports every red.

## ONE JOB, TWO PERMITS: THE FEE A CUSTOMER QUOTE WAS MISSING (2026-09-12)

A Coos Bay rooftop draws TWO permit fees, and the tool knew both and could show only one.

    before:  JURISDICTION FEES  $200.00        after:  electrical  $160.00  Coos County (filed via City of Coos Bay)
             PROJECT TOTAL      $200.00                structural  $200.00  City of Coos Bay
                                                       PROJECT TOTAL       $360.00

Every number in the "before" was correct and sourced. `fee_schedules` was unique on
`(profile_key, track)`, and "permit" is one slot, so the COUNTY's electrical table had nowhere
to be seen from a CITY project. The same key had already forced data loss inbound: the
harvester read Coos County's own structural row ($258, same PDF) and had to abandon it in a
notes paragraph.

**Migration v22** gives fee rows the discipline dimension `portal_recipes` has had since v9,
with the same vocabulary — `recipeDisciplineForTrack` is IMPORTED by `feeSchedules.ts`, not
restated, so a fee row and the recipe that files it cannot drift apart. A submittal track now
names its own permit: an `electrical` stage is quoted the electrical fee and nothing else.

`collected_by_profile_key` is the city-to-county hop, stored as data with its own source and
quoted sentence rather than written as lookup code. Matching "City of Coos Bay" onto "Coos
County" by name similarity would be the wrong-authority filing bug rebuilt one layer down —
the one this same session caught where every number was real and the authority was wrong. It
is followed EXACTLY ONCE, so no chain of pointers can loop, and a hop that lands nowhere reads
as unresolved rather than as $0.

`feeForProject` / `lookupPublishedFee` keep their names, shapes and single answer (submissionFees
loads them BY NAME and a missing export there is silent). That answer is now the TOTAL of the
permits a project owes, itemised in a new `lines` field. **One unreadable line makes the total
unreadable rather than smaller** — an under-quote that looks confident is the failure being fixed.

What is on file now, all `seeded`, all promotable with `markFeeScheduleVerified(db, key, track, who, discipline)`:

| Jurisdiction | Discipline | Fee | Source |
|---|---|---|---|
| City of Coos Bay | structural | $200 flat, prescriptive path | Resolution 26-30, Exhibit A p.8 |
| City of Coos Bay | electrical | *(hop)* → Coos County | the city's own schedule says so |
| Coos County | electrical | $135 / $160 / $265 / $265+$10 per kVA | County schedule eff. 1/1/26 §F |
| Coos County | structural | $258 flat | same schedule, p.3 |
| Ameren Illinois | nem | $50 Level 1, **mailed check** | Ameren DER guide, Table 1 |
| ComEd | nem | $50 Level 1 | ComEd DER guidelines p.7 |
| Pacific Power | nem | $0 Tier 1 | OAR 860-039-0045 |
| Portland General Electric | nem | $0 residential ≤25 kW | PGE net-metering FAQ |

Commands: `npm run harvest:jurisdiction`, `scripts/research-fee-schedules.ts` (against a COPY),
`scripts/apply-fee-findings.ts <findings> --db <path>` (`--db` is required, on purpose),
`scripts/fee-sheet.ts --project <id>`, `scripts/seed-coos-permit-split.ts`.

**Two traps worth remembering.** A web-search summary of the Coos table returned $108/$346/$796
by attaching the WIND rows printed below the solar block — hence coordinate pairing, never
reading order. And `--dry-run` in the first version of the split seed guarded only its own
UPDATE and let `saveFeeSchedule` through, so it wrote two rows and then reported that nothing
had been written; it now copies the database and works on the copy. A flag every call site has
to remember is a flag one of them will not.

**Still open here**: `feeBracketQuantity` (the Accela step that files a frozen "1" against one
bracket row) and the coverage gap behind it — the learn recorded only the box its own project
needed, so the sibling bracket boxes have no steps at all.

## THE QUESTION BANK FOUND WHAT THE CROSS-PROJECT SWEEP STRUCTURALLY COULD NOT (2026-09-12)

Triaging the bank's 51 unclassified questions turned up frozen answers carrying PROJECT A's
own data on every future filing - and the live cross-project runs had scored those same
portals "0 leaks":
```
  County                       = "Sangamon"          A's county (Springfield IL)
  Existing Building Area:      = "1675"              A's house square footage
  Building Height - Feet:      = "15"                A's roof height
  Number of Stories / Units / Buildings               A's house
  Additional Comments:         = "...8.36 kW DC / 7.68 kW AC"   A's system size
  Renewable energy 5.01-15kva: = "1"                 A FEE BRACKET keyed to system size
```
WHY THE SWEEP MISSED THEM, and why both mechanisms are needed: the tripwire sweep compares
filled values against the FIXTURE's value sets (name/address/size/equipment). "1675" is in
neither project's set, so it landed in "unverifiable" - correctly reported, never flagged.
The question bank reads the RECIPE instead of the run, so it sees every frozen answer whether
or not a fixture happens to know about it. The sweep proves substitution works; the bank
proves nothing was left frozen. Neither subsumes the other.
The fee bracket is the worst of them: a 20 kW job files in the 5.01-15kva bracket and is
billed wrong.

TRIAGE DONE (30 of 51 classified, persisted in portal_question_overrides, shared like recipes):
 - 10 per-job with bindings proposed (the table above + county) - the bindings do not exist as
   project columns yet, so these now surface as intake questions instead of filing A's answer.
 - 20 portal-constant: equipment/energy vocabulary (Solar/Photovoltaic/Inverter), customer and
   construction type for a residential rooftop business, Accela entry terms, attachment
   descriptions, PGE policy acknowledgements. Operator-confirmed earlier: installer role is
   ALWAYS "Contractor".
 - 16 left for the operator DELIBERATELY - each needs a business call I should not make:
   Ameren Application Level/Type (size- and history-dependent), pre-application, volt-watt
   pilot, municipal-inspection-before-approval; Accela record-type checkboxes and "Project
   includes any of the following"; PacifiCorp switchgear/parallel-blocking/meter-aggregation/
   multi-customer; PGE export-limit and aggregation defaults.
   Classify with: npm run portal:questions -- --host <h> --classify "<label>" --as per-job|portal-constant [--bind <key>]

THE ONE-TIME SECURE CREDENTIAL LINK now exists (0bc8e37) - the onboarding guide's S4 promise
was the one outright-false product claim. Write-only, single-use, 72h expiry, constrained to
the portals the request named, indistinguishable failures, nothing echoed. /credentials?token=

## PERMIT SIDE JOINS THE SCOREBOARD + THE QUESTION BANK IS LIVE (2026-09-11 evening)

Coos Bay electrical (Accela, aca-oregon) PASSES the cross-project contract: 6 distinct
B values confirmed live (name/street/city/zip/email/phone + job value/description landing),
zero leaks, ZERO model calls, rung 3. It took three fixture iterations, each teaching the
harness what a real project carries (in-jurisdiction address - Accela validates against
parcel records; job value + work description - Accela requires them), plus one recipe scrub.

THE SCRUB MATTERED BEYOND THE TEST: the recipe carried a human-patch PAYMENT CAPTURE -
card CVV "520", cardholder name, expiry - recorded when the operator paid the Coos Bay fee
in the left-open capture browser, sitting in the SHARED recipes table since 09-02. The
attribute-only sensitivity predicate missed label-identified card fields. DB scrubbed and
audited clean fleet-wide; capture now REFUSES card fields outright (fc9136d,
paymentCapture.dom.smoke). Treat CVV+expiry+name as exposed for nine days; the PAN never was.

FULL CROSS-PROJECT SCOREBOARD - 5 runs, 4 portals, both tracks, ZERO leaks anywhere:
```
 Ameren    NEM (B)  PASS  11 landed  2 model calls
 Ameren    NEM (C)  PASS  11 landed  2 model calls
 PacifiCorp NEM (B) PASS  15 landed  1 model call   replayed_clean, equipment landed
 PGE       NEM (B)  PASS  13 landed  1 model call   equipment landed
 Coos Bay  PERMIT(B) PASS  6 landed  0 model calls
```

THE QUESTION BANK (operator design: "if PGE detected, ask PGE questions - rigid"):
commits 3250ba3 / 251d932 / 00a1075 / 1f28f65 / c16fa49. The recipes ARE the bank - every
frozen [select] literal is a question in the portal's own words. Rigid keyword classifier
(misses fall to unknown, never guessed), shared portal_question_overrides for one-time
human calls, v17 per-job columns (ownership_model, system_configuration,
disconnect_within_10ft), and TWO ask-surfaces: the tokenized intake link and the PARSER
PAGE (the operator-named intake surface - questions render as rigid selects right after
Save to project, POST /api/projects/:id/portal-questions, scope-guarded).
Fleet audit: 63 findings - 11 frozen per-job answers, 1 per-job blank, 51 to triage
(npm run portal:questions -- --audit).
OPERATOR-CONFIRMED: installer-role is ALWAYS "Contractor" (portal-constant, classifier
already agrees); ownership is GENUINELY per-job (they do lease/PPA/third-party), so
PacifiCorp's frozen "Customer-Owned" was a real silent-wrong-answer for their business.

NOTE: the operator's running server predates these commits - restart it to serve the
portal-questions route and the parser-page panel.

## NEM CROSS-PROJECT SCOREBOARD (2026-09-11) - 3 of 3 reachable utility portals PASS

Every utility portal with a working login and a complete recipe now has a LIVE
cross-project measurement: learn once on project A, stage a materially different project
through the recipe PRODUCTION resolves, sweep every reported fill against both projects.
PowerClerk is one-session-per-account and PacifiCorp/PGE share one login, so these were run
STRICTLY SEQUENTIALLY - concurrent runs are what produced this session's false 67% reading.

```
 portal            verdict  landed  A leaked  model  fields  rung
 Ameren    (B)     PASS     11      0         2      53      3 replayed_with_gaps
 Ameren    (C)     PASS     11      0         2      53      3 replayed_with_gaps
 PacifiCorp(B)     PASS     15      0         1      82      4 replayed_clean
 PGE       (B)     PASS     13      0         1      41      3 replayed_with_gaps
```

EQUIPMENT SUBSTITUTION IS PROVEN on both Oregon portals: inverterModel,
inverterModelCertified and inverterQuantity all landed as project B's (IQ8M-72-2-US
replacing A's IQ8PLUS-72-2-US, CEC-certified string included), and PGE also landed
moduleModel. Ameren shows none of these because its form does NOT ask - it takes equipment
specs as a FILE UPLOAD. Per-portal difference, not an engine gap.

ZERO LEAKS ACROSS ALL FOUR RUNS. Of ~230 portal-confirmed fields swept, not one carried a
value traceable to the learn project and not to the replay project.

KNOWN LIMITS OF THIS SCOREBOARD, so nobody reads it as more than it is:
 - FROZEN SELECT LITERALS ARE INVISIBLE TO THE SWEEP. PacifiCorp's recipe carries 14
   unbound [select] answers ("Customer-Owned", "Residential", "Roof Mounting",
   "No Aggregation"...). They replay because a closed-vocabulary answer is the portal's
   word, not the customer's - but "Customer-Owned vs Third-Party Owned" is a FINANCING fact
   that varies per job and is pinned to whatever project A was. A and B happen to agree, so
   the tripwire sweep cannot see it. These need project bindings, not literals.
 - Reaching review is not a submittable filing. Ameren still leaves 6 required blanks;
   PGE left 2 steps that did not land (Model; a disconnect-distance policy question).
 - dcKw/acKw/wattages read "unseen" on the Oregon portals: they are shown as computed
   read-only text, not typed fields, so the readback cannot confirm them.

Still unmeasured on the NEM side: ComEd (needs_rerecord, 10 steps - the drawer bug the
2026-09-10 activeScope fix targets), PECO (login-ok, never learned), Duquesne (no login).

## THE FIRST CROSS-PROJECT MEASUREMENT (2026-09-11) - the B/C contract holds on Ameren NEM

Learn once on project A, stage materially different projects B and C through the recipe
PRODUCTION resolves (findCompleteRecipeForProject, after the rekey in scripts/rekey-recipe.ts
moved verified v21 onto `il|unknown|ameren illinois`). Live runs, one session each, drafts
ledgered ("ZZTest CrossProject Bravo"/"Charlie" - npx tsx scripts/draft-ledger.ts).

```
            B (5.67 kW, 14 mod)   C (8.91 kW, 22 mod)
 verdict    PASS*                 PASS
 landed     11 distinct values    11 distinct values
 A leaked   0                     0
 model      2 calls (gap-fill)    2 calls (same labels)
 checked    53 confirmed fields   53
```
*B first read LEAKED-3; every hit was the COMPANY's own email in installerEmail-bound
fields - correct on every filing. The sweep now classifies client-scoped values (58baa9a).

Equipment mystery RESOLVED, hypothesis overturned: Ameren has NO make/model dropdowns.
Its Generator page asks equipment TYPE (select, filled "Inverter") and takes specs as a
FILE UPLOAD ("attach manufacturer's technical specifications"). The recipe's zero
equipment steps is CORRECT for this portal; "9 equipment values unseen" was the harness
expecting typed fields where the form never asks. PacifiCorp/PGE recipes carry 6/9
equipment select steps - per-portal difference, not an engine gap.

WHAT STILL SEPARATES THIS FROM A SUBMITTABLE AMEREN FILING (bounded, per the C report):
 1. "Community Solar / Behind the Meter" select - blank; answer is derivable (residential
    rooftop = Behind the Meter) but no project binding exists for it yet.
 2. The map/location pin widget - canvas interaction, likely a human step.
 3. Name/Company in the "Interconnection Application" contact block - the old autosave
    wipe; still blank on replay.
 4. County - the fill did not land.
 5. Document attachments (inverter spec sheet, one-line diagram) - the portal defers them
    behind an acknowledgment checkbox, so the walk never recorded upload steps. The docs
    pipeline exists; the recipe carries no upload steps to drive it.
 6. MFA + $50 mailed check at final submit - human by design (rule 1).

A fresh learn with the 2026-09-10 engine (bundle RETAINED at
data/learn-runs/2026-09-11_07-11-42_ameren-illinois_sjzv/) confirmed the walk sees the
same 7 pages and correctly left the incumbent recipe in place (updated_at unchanged).

## Learn-once engine hardening + restore (2026-09-10)

A run of engine fixes was lost TWICE to the machine sleeping mid-session (uncommitted
work does not survive a Teleport move — it comes back clean at the last commit, in a
`git stash` auto-stash). Everything below is now COMMITTED. If a review references a fix
as "lost", check `git log` first — it was re-applied.

Committed this session (f20a383..HEAD):
- **Cross-project leak** (`3e42fec`): replay filed the LEARN project's homeowner/address on
  the next project. Guarded in resolveValue + a frozen-literal path; crossProjectReplay.test.ts.
- **Gap-fill grounding** (`f20a383`): "999" passed for an 8 kW system, "Yes" for hasBattery:No.
  isGrounded now checks the binding, not just that the field is non-empty; llmGapFill.test.ts.
- **Button labels** (`378f6c8`): a `name`-attributed button read as "submit_form"/"next_page",
  blinding SUBMIT_INTENT and clickFallbackAdvance. Visible text beats name for button-ish els.
- **Pagination guard** (`c86fc08`): ComEd banked a mat-paginator "Next page" as its advance.
  PAGINATION_CONTROL, shape-based; paginationAdvance.test.ts.
- **Replay pay gate** (`6e614bc`, `e105a36`): the live-replay click gate missed "Pay and Submit",
  "Submit Payment", and bare "Pay". Renamed PAY_FEE_REPLAY_GATE; paymentGate.test.ts pins both
  copies in parity. e105a36 also closed a LIVE clickFallbackAdvance path that would have pressed
  "Continue and Pay" on a real portal.
- **Active scope** (`98533a4`, `d4296e3`): the ComEd drawer harvest mixed the dialog's 28 fills
  with the dashboard's 27 buttons. Scope the harvest to the topmost open panel; re-admit an
  outside sticky-footer Next so a wizard's only exit is never filtered away. activeScope.dom.smoke.
- **Terminal-page review** (`d8e950e`, `0e3a426`): a single-page application (no Next, one Submit)
  was DISCARDED, not just unpromoted (autoLearn.ts:934). Now classified as its own review, submit
  recorded isFinalSubmit and never clicked — behind positive-terminality guards (unfinished
  step-of-N, disabled Next present, money wording, draft-save wording) that a prior adversarial
  pass proved were needed. terminalPage.dom.smoke, 98 checks. NOTE: permiteyes still lands
  "recording" not "complete" — its "* Utility Auth. No." is a hard blocker no automation can fill.
- **Trust gate restored** (`04630b5`): a portal outage / stale credential / MFA wall no longer
  demotes a verified recipe; savePortalRecipeSteps no longer defaults to "complete". trustGate.test.
- **Login proof** (`04630b5`): a session is proven by a positive signed-in signal, not the absence
  of a password field (Cloudpermit was stamped "logged in" while never authenticated).
  loginProof.dom.smoke, 18 checks.
- **Benchmark scope** (`07c79eb`): NEM portals were learned as AHJs and banked under a key no real
  project resolves. isUtilityPlatformUrl now picks the scope; benchmarkScope.test.ts.

STILL OPEN (not regressions, named honestly):
- The measurement work — re-run Ameren NEM live to confirm the scope fix banks onto the
  production key, then the cross-project B/C contract on real portals. Every draft to the ledger
  (`npx tsx scripts/draft-ledger.ts`).
- Accept-side misses reported by the prove agent (all fail SAFE — a missed page, never a filing):
  "Submit for Review" / "Send Application" / "Agree and Submit" are refused as terminal submits.

## Measuring replay: what the numbers mean (2026-09-08)

The operator's question is **"if I point this at portal X, how often does it just
work"** — a rate, about a portal, from repeated trials on ONE build. Two earlier
numbers were not that, and both read better than the truth:

- **94.9% was not a measurement.** It assembled each recipe's BEST run across
  DIFFERENT builds. No build ever behaved that way; no operator could experience it.
- **A single frozen-build sweep gave 74.7%** — but that sweep shared one browser
  profile across every utility portal, and PowerClerk allows one session per
  account. Per-host profiles took the same build to 95.2% executed.

`npm run replay:benchmark -- --repeat N` is the honest form: N attempts per
portal, **round-robin** so each portal's attempts spread across the sweep instead
of sampling one four-minute window, and reported per-portal k/N **worst-first**.
An operator does not meet the fleet; they meet one portal, and a 95% average over
five portals is compatible with one of them failing every other run.

A portal outage counts AGAINST the rate. A portal that is down is a portal you
cannot file on today; the `owner` column is what says it was not us.

### Nothing missed, in the operator's sense

"Everything the permit needs is present" now has three parts on every run:

| Reported | Question it answers |
|---|---|
| `fieldsVerified` | of what we wrote, what read back out of the portal |
| `requiredStillEmpty` | what the portal still wants, swept before every advancing click AND on the final page |
| `requiredFieldsSeen` | **how many fields the portal asked for at all** |

The third is the denominator, and without it "0 blanks" is the same sentence
whether thirty required fields were satisfied or the check never reached a page.
`blindClean` on the dashboard counts clean runs that never saw a required field:
not a failure, not a success — a score nothing can falsify. Absent ≠ zero, so
runs staged before the field existed are not flagged.

### Warnings: one list was carrying four meanings

`driftWarnings` held a real defect, a human-must-look, a correct decision
("skipped Energy Storage, this project has no battery"), and a successful
self-heal — and all four blocked a clean score, so a portal with one stale
recorded id could never replay clean however correct the filing was. Split at the
push site into `driftWarnings` (blocking) and `agingNotes` (reported, drives the
re-record signal, does not block). **Blocking is the default**: anything
unclassified still blocks, so a new warning meaning "this filing is wrong" fails
closed. Re-scored over the stored sweep the split moved **zero rows** — right in
principle, empty in effect, and worth knowing before spending a sweep on it.

What it did surface is the real blocker: *"click X left the page unchanged
(in-page action, or an advance that silently did nothing)"* on four of five
portals — a diagnostic whose own text names two opposite outcomes and declines to
choose. The page-identity check ignores values by design; the fix asks a second
question (values, option counts, row counts). A swallowed click still blocks, and
when the snapshot could not be taken the message says so rather than claiming a
comparison that never ran.

## Miami, page by page: what one portal cost, and what it bought (2026-09-08/09)

Driving ONE newly-accessible portal toward a review screen turned up sixteen defects.
Every one is generic, every one is kill-tested, and the walk went from 6 pages / 8 fills
to **29 fills across 18 pages, twelve distinct pages of Miami's intake**. The value is in
the list, not in Miami.

| The wall | What was actually wrong |
|---|---|
| Search found nothing, 7 pages | The planner filled `3500 Pan American`, then `Pan American`, for a parcel the portal holds as `3500 PAN AMERICAN DR`. The value dictionary offers `street` (whole) beside `streetNumber`/`streetNameCore`/`streetNameSearchPortion` - keys written for Accela's SPLIT form - and nothing says which one a single box wants. |
| The portal said why and nobody read it | `.validation-summary-errors` was not in the error selectors, and errors were only read after an advance that did NOTHING. Every Miami advance worked; the page came back saying "Property Address not found." |
| Results row not clickable | The row's only target is a `<td>` the portal underlined. No `<a>`, no `<button>`, no onclick - a grid handler bound in script. The replay-side matcher required a `Select` link (Accela's shape). |
| `tr.textContent` fuses cells | The row reads `3500 PAN AMERICAN DRCITY OF MIAMI`; the street type vanishes and no address can match. Both matchers had it; the `<a>` requirement was hiding it. |
| Planner offered `btnSubmit` | `<input type=submit value="Start New Application">` has no textContent, so the label fell through to `name`. Classic ASP.NET renders every button this way. Also a safety hole: a real "Submit Application" labelled `btnSubmit` matched no SUBMIT_INTENT. |
| The revealed button stayed banned | Two guards remembering what did not work in a page state that no longer exists - the dead-advance ban and the nav re-click guard. A successful row click is proof that state is gone. |
| An advance that never returned | One advance click spent FIFTEEN MINUTES and emitted no event: safeAction retries the action, clickResilient retries four times inside it, each waiting for the element and then the network. Bounded at 90s; the abandoned click is retired by a generation counter, because on this portal it would have come back to life and clicked the very button the row click reveals. |
| The dead-advance skip ended the run | It breaks when its fallbacks fail - but the recovery hint carrying the portal's validation errors is not built until the third visit, so breaking on the second meant the planner was never told why it was stuck. |
| The row pass never got a turn | It hung off the ADVANCE path; told the button's real name, the planner called it a NAVIGATE. Being back on a page with the same controls says the last action failed, whichever branch took it - once per page signature. |
| Job Category never filled | A Telerik dropdown: a visible `<span class="t-input">` and, behind it, `<input style="display:none">` holding the id the form posts. Classified text, the fill throws on a hidden input and the value drops in silence. Telerik predates ARIA, so the existing combobox rule could not see it. |
| ...and it had no options to offer | The widget renders its list only on click, so the planner had to invent a value. `readClosedComboboxOptions` opens it, reads, and shuts it again. |
| ...and the answer went into the site search | The combobox filler fell back to the whole PAGE for a filter box. Miami carries `<input id="acGlobalSearch" role="combobox" aria-autocomplete="list">` on every page. Confined to the widget; the Enter fall-through had the same hole one branch later. |
| ...and the site nav was read as the options | `<ul class="t-menu">` matches the popup list and is permanently visible, so "the last visible popup" answered with "Start Application, Manage Application, Contractor". A popup already on screen is not the one we just opened - and when nothing fresh appears, "no popup" is the complete answer. |
| ...and the fill path threw before any of it ran | `applyFill` refuses invisible controls, rightly (one hidden date input once cost 137 seconds). A dropdown widget's backing input is MEANT to be invisible. Three visits logged `hidden_field_skipped: Job Category` while everything upstream was correct. |
| A binding key nobody defined | The planner names its own keys and invents them. `jobCategory` is not in the value dictionary, and `resolveValue` returns an empty string with no fallback - a blank required field on every replay. The literal is used only when the key is UNKNOWN; a defined-but-empty key stays blank, or a shared recipe files the learn project's homeowner. |
| Two radios, one id | Miami's Yes/No questions are two radios sharing one id and name, with `<label for="Yes">` pointing at an id that does not exist. Six controls, three names, no way to tell Yes from No or one question from another. The choice is the adjacent word; the question is the section. |

**Where Miami stands:** Home -> Legal Agreement -> Property Search -> Job Location ->
Applicant Role -> Contact Information -> Job Category -> Property Type -> Job Description
-> Job Description Details -> Project Totals -> Additional Options. Every stop since the
notice channel landed has been named by the portal in its own words rather than guessed at:

```
portal_notice p18: "You must select one option for City Project Question
                    You must select one option for Affordable Housing Question
                    You must select one option for Private Provider Question"
```

**It has not reached a review screen.** Nothing here is a claim that it has.

**Operator note:** these benchmark runs mint REAL DRAFT APPLICATIONS on the live Miami
account - one carried the intake number `BD26-021147-001`. They are drafts, never
submitted (automation never clicks final submit), but they accumulate under
permit@infinitysolarusa.com and someone should cancel them.

### The test chain could hang, and did - and then it could hide, and did

`portal:test:dom` was smokes joined with `&&`. Two ways that lies. It HANGS: `replica.dom.smoke`
sat for fifty minutes and took the other fifty-nine with it, leaving four orphaned browsers when
it had to be killed - which is where a round of false portal diagnoses came from. And it HIDES:
`controlIdentity` is the 9th of 71 and had been red since before 2026-09-10, so the chain died at
#9 every run and **62 smokes had not executed for an unknown number of weeks**. Nobody knew,
because `&&` reports the first failure and stops.

`npm run portal:test:dom` is now **`scripts/run-dom-smokes.ts`**: every smoke in its own process,
all of them run regardless of failures, with `--only <substr>`, `--concurrency` (default 3) and
`--timeout` (default 600s). A hang is a TIMEOUT row, reported separately from a red check because
they need different repairs. Per-smoke logs land in `.dom-smoke-logs/`.

Three things in it are load-bearing and should not be tidied away:

- **The filesystem is the register.** It discovers `*.smoke.ts` and classifies; it does not read a
  list. The runner it replaced (`portal-bot/src/runDomSmokes.ts`, deleted) parsed the `&&` chain
  out of package.json, so it inherited the very drift it was meant to cure. The chain string is
  gone rather than parked under a second script name - a hand-maintained list is stale the day
  someone adds a file, and a stale list lying around is what this replaced.
- **Unclassified is a failure.** A `*.smoke.ts` that is neither a `*.dom.smoke.ts` nor a named
  exception is NOT run (it might be a live/credentialed one) and turns the suite red until a human
  sorts it. The suite also prints what it skipped and why, every run. A count of passes with no
  denominator is how "62 not running" stayed invisible.
- **Exit 0 with `FAIL -` in the log is its own category.** A smoke that prints failures and still
  exits clean gets reported as EXIT-CODE-LIED, because the repair is the smoke's exit path, not the
  code under test.

First full run on the discovered set (2026-09-12, commit `0688884`, concurrency 3): **65 passed,
5 failed, 1 timed out, 3 skipped as non-DOM (live/stress), 0 unclassified.** `controlIdentity` and
`batteryDeclaration` measured green at that commit.

The five reds - `advanceGuard`, `applicationEntry`, `finalPageReassert`, `identicalSections`,
`paymentBoundary` - ALL REPRODUCE AT `8cbec53` (2026-09-11 23:55, pre-session). Every one sits
downstream of the chain's stop at #9, so none is new and none had been running. Four show the same
symptom, a field that should fill coming out `""`; only `finalPageReassert` names a cause ("carries
a recorded literal that looks like the learn project's own data and is bound to nothing - left
BLANK"). A search for that marker in the other three found nothing, so the shared cause is NOT
established - do not assume one fix closes four.

**IT IS NOW ESTABLISHED, AND IT IS FOUR OF THE FIVE.** (2026-09-12, second sweep, independent
re-run: same tally, banner `RED - 5 problem(s)`.) The marker was absent from the other three
logs only because they never print `agingNotes`; the mechanism is the same one. Measured by
calling `looksLikeProjectData` directly on each red's own label and value:

| red | label + value the fixture carries | `looksLikeProjectData` |
|---|---|---|
| `advanceGuard` | "Meter Number" + "TEST-123" | **true** |
| `identicalSections` | "Address" + "808 SE Chkalov Dr" | **true** |
| `finalPageReassert` | "Phone" + "5035550142" | **true** |
| `paymentBoundary` | "Contractor Licence Expiration Date" + "2027-04-01" | **true** |

Every one is an UNBOUND literal (`field: ""` or no `field`), so `resolveValue` refuses it and
returns `""` - which is `3e42fec` ("A recipe is shared, so the answer it recorded is somebody
else's", 92 commits back) working exactly as designed. Proved rather than inferred: binding
`advanceGuard`'s meter step to `meterNumber` and supplying it takes that smoke from 3 red to
**7/7 green** (diagnostic only, reverted). Same shape as the `controlIdentity` repair.

The split that decides the repair is whether the label has a key in `RECIPE_FIELD_DESCRIPTIONS`:
`meterNumber`, `street`/`projectAddress`, `homeownerPhone` all exist, so those three are STALE
FIXTURES - noisy, not a live blank. **There is no key for a licence expiry** (`/expir/` matches
nothing in the dictionary), which makes `paymentBoundary` the same class battery capacity was:
a required field that comes out empty on a real filing with nothing to substitute.

`applicationEntry` is NOT this cause and must not be swept in with them. Its red is
`matchesEntryLabel("Submit an Application/Request")` returning false, because
`isExcludedEntryLabel` excludes any label carrying "submit" without "new"
(`applicationEntry.ts:102`) - safety rule #1, the last guard before an accidental filing. The
smoke's "good labels" list and that exclusion genuinely contradict each other; picking a winner
is a human decision, not a repair.

Two things found while establishing the above, neither of which any smoke covers:

- **A bare "Name" label still replays the learn project's person.** `PROJECT_DATA_LABEL` requires
  `first name`/`last name`/`full name`/`owner`/`customer`/... - plain "Name" matches nothing, so
  `looksLikeProjectData("Name", "ZZTest Replay Benchmark")` is **false** and the literal replays.
  It is visible in two PASSING smokes' own output: `finalPageReassert` files
  `Name="ZZTest Replay Benchmark"` and `identicalSections` files "Charles"/"Bitton" while their
  addresses correctly blank. Every leak case in `crossProjectReplay.test.ts` uses a label that
  happens to contain a listed word ("Owner Name", "Service Address", "System Size (W)"), so the
  commonest label on a portal is untested. This is the wrong-value direction, and it is silent.
- **A recorded expiration date is rebound to TODAY.** `dateFieldForLiteral` (portalRecipes.ts,
  called from `convertLiteralsToBoundFields` at :1425) sends any date control not matching
  `FUTURE_DATE_LABEL` to `todayDate`, on the assumption it is a signature/application date.
  Measured: `dateFieldForLiteral("Contractor Licence Expiration Date", "2027-04-01")` ->
  `"todayDate"`. A NEW learn of a licence-expiry control would therefore file "expires today".

**The one wrong verdict was the runner's own.** `terminalPage` was reported TIMEOUT at the original
300s default; it passes in **317s**, alone AND at concurrency 3. Nothing hung - the budget was
just under the smoke. The default is now 600s, re-validated on the nine slowest smokes (all green,
slowest `terminalPage` 317s and `multiArray` 292s). Anyone reading an older note should not go
hunting a `terminalPage` hang - there isn't one.

**Corrected standing tally: 66 pass, 5 fail, 0 timeouts, 3 skipped, 0 unclassified.**
## Point-and-shoot, measured on the accessible fleet (2026-09-09, night)

Per the operator: the 12 refused-credential portals are CALLED OUT and excluded from the
denominator (their list prints at the end of every sweep); reliability is measured on the
portals we can log into. Full accessible sweep, one build, single attempt each:

| | |
|---|---|
| accessible (logged in) | **26 of 54** |
| full loop: reached review | **1/26** (Ameren NEM, 70 fields) |
| recorded a filling recipe | 17/26 (65%) |
| walked but filled nothing | 9/26 |
| vs previous run | 2 improved, **0 regressed**, fleet +21 fields deeper |

Pinned repeat on the one full-loop portal: **3/3 non-collided attempts reached review,
self-test PASSED each time** (one attempt excluded as a documented harness collision).

**Where the 95% has to come from, by owner:**
- ENGINE: the 9 zero-fill portals (varied entry-path causes: ConnectTheGrid dashboards,
  Bitco blank page, permittrax/iworq/momentum entry) and the 16 recorded_steps portals'
  remaining walls. Each is the Miami/Ameren treatment: drive, read the portal's own
  notices, fix generically, kill-test.
- OPERATOR: 12 refused credentials (printed each sweep); co-franklin-oh's URL bounces to
  COLUMBUS's Accela (wrong tenant, from the workbook); Miami's Job Sub-Category.
- DESIGN (not gaps): MFA/CAPTCHA portals and final-submit stay human.

## Open, worth doing next: single-page apps should SCORE as review (not just stop safely)

permiteyes.us is a single-page application: fill 176 fields, one "Submit Application", no
Next. The safety guards now make the walk fill everything and STOP without filing - correct,
but it scores rung 4/5, undercounting real success. A single-page portal's terminal state IS
its review: fills complete + only-forward-control-is-final-submit = record that submit
isFinalSubmit:true (never clicked) and classify the page as review, the same treatment
PowerClerk's terms-gate already gets.

Attempted this session and BACKED OUT deliberately: the change is sound but the fixture
harness fought it (fills not applying in the test's second-pass planner) and it is a SCORING
nicety, not safety - not worth forcing at 3am against a finicky test. The reframe matters
for the fleet number: several accessible portals are single-page apps whose correct outcome
the rung ladder currently reads as failure. Do it with a fixture that drives fills cleanly.

## SAFETY: two paths nearly filed a live application, both now guarded (2026-09-09, night)

permiteyes.us/bellingham's landing page IS the application - a 176-field single-page form.
During learns, (1) the entry pass clicked a bare "Submit Application" as if it were the
way in, and (2) the Enter-submit search fallback pressed Enter on the filled form - the
form's own submit. `enter_submit` fired on the live portal tonight and the page navigated.

**Account audited read-only, and the operator confirmed directly: nothing filed.** No benchmark
entries, nothing filed - the 60/176-filled post was rejected server-side and bounced to
about:blank. No application was submitted by automation.

Both guards are in (`a25311d`) and kill-tested together: entry refuses any
submit/file/finish label without "new"; Enter refuses any page with more than a handful
of fillable fields. CORRECTION to that commit's message: "with either alone it does not
submit" was NOT tested - only both-off was. The both-off kill stands; the per-guard claim
is retracted.

## CLEAN PIN: Ameren NEM 3/3, self-test passing (2026-09-09, night)

Re-run with nothing else touching PowerClerk (`--repeat 3 --self-test`):

```
 1/3  reached_review     2/3  reached_review     3/3  reached_review
 100%  review 3/3   usable 3/3   amerenillinoisinterconnect.powerclerk.com
```

This SUPERSEDES the 67% below, which was one attempt colliding with the concurrent fleet
sweep on a one-session-per-account portal. Same build, same fixture, no contention: the
learn -> review -> replay -> review loop reproduces every time on the portal where it is
closed. Scope it honestly: this is ONE portal's repeatability, not a fleet rate.

## The first pinned reliability number (2026-09-09, evening)

`learn:benchmark --host amerenillinoisinterconnect --repeat 3 --self-test`, one build:

```
 1/3  reached_review   [self-test] PASSED
 2/3  recorded_steps   <- collided with the concurrent fleet sweep (see below)
 3/3  reached_review   [self-test] PASSED
  67% raw; 2/2 = 100% excluding the harness collision
```

Attempt 2's miss is OUR harness, documented: the accessible-fleet sweep was running in a
second process and its own Ameren attempt (15/54, scored reached_review) walked the same
one-session-per-account PowerClerk login mid-attempt-2. One session evicted the other.
Counting every same-build attempt today: learn+replay closed the loop on 3/3
non-collided attempts, self-test PASSED each time.

**Measurement rule learned: same-host runs must never overlap across processes.** The
per-recipe lease serialises within one process only. Until a cross-process lease exists,
never run two benchmarks that share a portal account at the same time.

## Reliability is now measured as a rate, not a run (2026-09-09)

Three fixes this session looked right on one portal and degraded another (the equipment
fixture, the exit re-assert, the duplicate-label preference). A single run cannot tell a fix
from a coin flip, and the goal is a 95% RATE. `learn:benchmark --repeat N` now runs each
portal N times round-robin and reports per-portal k/N worst-first with an overall line;
non-measurements (harness aborts) are excluded so they never read as a portal that failed.

Ameren PowerClerk (the closed NEM loop) is the acceptance test: `--repeat 3 --self-test`.

### Miami permit walk: where it stands

The seeded KB path fixed the wrong turn - Job Category now lands on STAND-ALONE (confirmed
on-screen). It stops at Job Sub-Category: the live cascade under STAND-ALONE offers only
BUILDING ROOFING, and the correct electrical/solar sub-category is operator knowledge that
needs a real Miami permit example. Everything up to it works: address search, results-row
click, Start New Application, Job Location, Applicant Role, Contact Information (21 fields,
no longer stalling 16 min), Job Category as a Telerik cascade dropdown.

## THE LOOP CLOSED: learn -> review -> replay -> review (2026-09-09, Ameren PowerClerk)

```
[self-test] ENABLED - replaying the learned recipe
[self-test] PASSED - the recipe reproduced the review in a fresh session
 1/1 6 reached_review       amerenillinoisinterconnect.powerclerk.com
   reached REVIEW : 1/1 = 100%   <- the product's own bar
```

First time the bar has been cleared on any portal, and it is the NEM side. Eight pages,
review screen is **Step 7 Payment (final)** - the correct stopping point, since automation
never pays. Verifier `accurate: true`, confidence medium (Utility/Program = Ameren Illinois,
fee recipient = Installer, $50.00, "Current step: 7 Payment"), so it survived the gate that
demoted Spokane's fiction. Reproduced across four consecutive runs.

### Why it had never closed before

**The self-test passed neither the credential, nor the browser profile, nor the portal's
login URL** - the three things the LEARN is handed a few hundred lines above in the same
function. The replay landed on a login page it could not pass, `runAdapter` returned its
login-failure shape (`ok:false`, no message, no data), and every "replay self-test did NOT
reproduce the review" verdict this project ever recorded was a login failure wearing a
recipe failure's clothes. *Fresh session* means a fresh browser, not a fresh identity -
production replay uses the same per-portal profile, so the self-test must too.

Two diagnosis gaps fixed alongside it, both of which cost runs tonight:

- The login-failure return carried its reason only inside `steps[0]`, which nothing reads.
- **Audit rows for a benchmark project are deleted with the project**, so
  `portal.replay_selftest_passed/failed` could never answer "did it even run". The run now
  prints `[self-test] ENABLED/PASSED/FAILED/ERRORED` on stdout. Three runs were spent on
  that question before the line existed.

### What is still missing, by name

Six required fields are blank on the review screen: **Street, Name, Company, Address,
Inverter Manufacturer, Inverter Model**. So the loop closes but the application is not
complete - "nothing missed" is not met. The first four look like one contact/installer
block; the last two are the PowerClerk equipment cascade. That is the next piece of work,
and the run names it every time.

## Where Miami actually stops, and why it is not an engine problem (2026-09-09)

The walk now reaches **Job Description**, twelve pages in. What stops it:

```
p10  Job Category      -> STAND-ALONE          (the only 6 options: ADDITION AND REMODELING,
                                                DEMOLITION, NEW CONSTRUCTION,
                                                REMODELING/REPAIRS, STAND-ALONE, TREE PERMIT)
p11  Job Sub-Category  -> BUILDING ROOFING     (the ONLY option the cascade offered)
p13  Job Description   -> FLAT ROOF, SHINGLE ROOF, under group ROOF NEW OR REPLACE
     portal_notice: "Please select at least one work item"
```

The planner ticked neither roofing item, which is **correct** - this is a solar PV job. The
mistake was two pages earlier: **Job Category decides which work items the portal will ever
offer**, and STAND-ALONE leads only to roofing.

**Which category a residential solar PV permit files under at Miami is operator knowledge.**
The engine cannot derive it and must not guess - filing under the wrong category is exactly
the class of error the record-type guard exists to prevent. What the engine now does instead
is say what it was offered and that none of it fits:

```
🔀 "Job Description" required a choice and none of what it offered fits this job
   (group: ROOF NEW OR REPLACE): FLAT ROOF, SHINGLE ROOF. A choice made on an EARLIER
   page decides what these pages offer - check that one.
```

**The one fact needed to finish Miami**: which Job Category + Sub-Category a residential
rooftop solar PV permit uses. Supply it as operator knowledge (it belongs in
`permit_utility_knowledge` for this AHJ, seeded from research or marked mixed when a human
confirms it) and the walk should continue into Project Totals, Additional Options and
whatever follows.

Everything upstream of that choice now works end to end: address search, results-row
selection, the reveal of Start New Application, Job Location, Applicant Role, Contact
Information (21 fields), Job Category as a Telerik dropdown with its options read from a
closed widget, Property Type, and the Yes/No eligibility questions.

## Did any of it transfer? Measured (2026-09-09)

A clean fleet sweep against the last clean pre-fix baseline (`2026-09-08T22-37-30.json`).

**By rung, nothing moved.**

| | before | after |
|---|---|---|
| ACCESS | 24/50 (48%) | 22/50 (44%) |
| usable recipes | 14 (28%) | 13 (26%) |
| usable given access | 58.3% | 59.1% |
| mean rung | 2.66 | 2.46 |
| **reached REVIEW** | 2 | **0** |

Five rung regressions, all accounted for: `co-spokane reached_review -> recorded_steps` is
the review gate removing the stranger's-closed-permit fiction (intended);
`apps.miami.gov recorded_steps -> unreachable` is the 660s cap truncating a walk that got
three times LONGER; the other three (Accela, civicgov4, Methuen) are portal availability.

**By depth, six portals moved - and the ladder could not see it.**

| Portal | pages | fields filled |
|---|---|---|
| pdspermitportal.snoco.org | 8 -> 7 | **10 -> 17** |
| onlinepermitsandlicenses.cityofboston.gov | 6 -> 8 | 7 -> 9 |
| ci-edgewood-wa.smartgovcommunity.com | 4 -> 7 | 3 -> 5 |
| planningandpermitting.frederickcountymd.gov | 3 -> 5 | 2 -> 3 |
| www.baltimorecountymd.gov | 6 -> 6 | **0 -> 2** |
| dilp.howardcountymd.gov | 6 -> 7 | 2 -> 2 |
| momentum.princegeorgescountymd.gov | 3 -> 5 | 0 -> 0 |

**+9 pages and +14 fields** across portals that were already accessible, none shallower.
Baltimore County is the cleanest signal - it filled NOTHING before and fills fields now,
and it is Cityworks/ASP.NET, the family the `<input type=submit value>` label fix targets.
Miami in its own uncapped run went 6 pages / 8 fills -> 20 pages / 39 fills.

**Every one of those portals was reported `unchanged` by the rung diff.** `compareDepth`
now prints per-portal and fleet-total page/field movement next to it. Not having that is
why this question needed two scorecards and a hand-written diff to answer.

**The honest reading:** transfer is real but modest, and the fleet number cannot show it.
The engine work moves portals THROUGH forms; the ladder only counts arrival at review, and
22 of 50 portals never get past login - credentials and MFA, which no engine fix touches.

## The machine can fail in a way that looks like the fleet failing (2026-09-09)

A sweep ended with **eleven consecutive portals** scored `unreachable - the portal did not
respond`, all inside **eight seconds**. Every one of those hosts answered a curl a minute
later. Counted as dead hosts it moved ACCESS from 24/50 to 15/51 and produced nine
REGRESSED rows that were nothing of the kind.

**Most likely cause: disk.** This machine sits at ~13 GB free of ~950 GB. Chromium needs
scratch space to launch a profile, and a browser that cannot launch is indistinguishable
from a portal that will not answer. 69 orphaned `%TEMP%\playwright*` profile directories
were cleaned (0.6 GB); the rest of the disk is not ours. **Check free space before trusting
a sweep**, and suspect the runner when failures arrive in a block.

`markUnreachableBursts` now marks four-or-more consecutive no-response rows NOT MEASURED
rather than blaming the portals - run order is the evidence, since portals are attempted in
list order and share nothing else. Three neighbours failing together is still counted as
three dead hosts: the guard has to understate, not hide a real outage. And `the portal did
not respond` now names what the network actually did (`net::ERR_...`, `ETIMEDOUT`,
`ENOTFOUND`), because a verdict about somebody else's server should be checkable.

Two other things that sweep exposed:

- **The per-portal wall clock truncates deep walks.** Miami now needs ~25 minutes for its
  20-page intake and the default 480s cap (+180s slack) cut it off - correctly scored NOT
  MEASURED, but it means a portal that got *better* can read as absent. Use
  `--portal-timeout` when measuring depth.
- **The only signal that survived**: `www.baltimorecountymd.gov` went `reached_form` ->
  `recorded_steps`. Cityworks/ASP.NET - the family the `<input type=submit value>` label fix
  should help. One data point, not a trend.

## The review number was fiction, both times (2026-09-08, late)

**Neither portal that "reached review" reached a review screen.** Read this before
any number below that says otherwise.

- **co-spokane-wa.smartgovcommunity.com** — pages=1, top rung. The page the planner
  called review was an existing permit record: number E-B2402727, created 4/10/2024,
  approved, issued, **closed**, at an address a hundred miles from the project, under
  a different homeowner. The run's own `verification` block said so on the same run —
  `accurate: false, confidence: high`, both site-address lines wrong, module count
  wrong, contractor licence expired 2021. The ladder never asked.
- **gilbertaz.seamlessdocs.com** — pages=1, 8 fills, top rung, on a form titled
  *"Permit Extension Request"*. The stored URL was
  `https://gilbertaz.seamlessdocs.com/f/permitext`, which Gilbert's own permits page
  labels *"Request for Permit Extension"*. `TYPE_EXCLUDE` already refuses "extension"
  and never got a vote, because the URL pointed straight at the form. **Noted as an
  open operator item on 2026-09-04 and left in place for four days, inflating the
  headline the whole time.** Corrected to the One Stop Shop self-service portal
  (`onestopshop.gilbertaz.gov/apps/selfservice/#/home`), browser-verified read-only;
  `last_login_ok_at` cleared, because what was verified was a public form loading.

So the honest reading of every learn sweep before this: **0 portals have reached a
review screen for the project being filed.** `reachedReview` is read off `review=true`
in a page trace — the PLANNER'S CLAIM about a page — and nothing corroborated it. The
ladder now requires the claim to survive the run's own verifier (`accurate === false`
demotes to `recorded_steps` and names why). Absent or passing verdicts leave the rung
alone; a gate that demoted on silence would zero the headline instead of correcting it.

*Calibration, for whoever hits a demotion next:* `accurate === false` conflates "this
is a different record" (Spokane) with "our review screen, some fills wrong". And the
verifier has been wrong before — it called PGE's inverter Model a miss when the value
had landed. Treat a demotion as a reason to read the `matches` array, not as ground
truth. If it starts eating genuine reviews, narrow the trigger to the wrong-record
signals (site address, record number) rather than any inaccuracy.

## Fleet re-measure with honest page counts (2026-09-08, `22-37-30.json`)

54 portals, 50 measured. **Access 24/50 (48%)**, usable-given-access 14/24 (58.3%),
review-given-access reported as 2/24 (8.3%) — **and both of those two are the fiction
above, so the real figure is 0**. `4 improved, 2 REGRESSED, 40 unchanged`; the two
regressions are against a baseline measured with the broken page counts, so they are
weak signal. Expect Spokane and Gilbert to show as REGRESSED on the next diff — that
is the gate removing fiction, not portals falling.

## Fleet re-measure after the fixes (2026-09-08, `16-18-52.json`)

| | first run | after fixes |
|---|---|---|
| ACCESS | 42.1% (24/57) | 40.4% (23/57) — portal-side variance, MFA/CAPTCHA 7 -> 10 |
| usable recipe, given access | 58.3% | **60.9%** |
| **reached REVIEW, given access** | 8.3% | **8.7%** |

`2 improved, 1 REGRESSED, 54 unchanged`. Both improvements are the consent fix
(lakestevens and desmoines, entered_application -> reached_form) — exactly the two it was
written for. The regression is mapsonline (reached_form -> login_failed) and is portal-side:
nothing in this session touches login detection.

**The accept-when-blocking cookie path is NOT in these numbers** — it was committed after the
run started. Untested live.

### Why the review bar does not move: the planner returns no advance

Twelve portals record fills and never reach review, and with the page trace now stored on the
row the cause is the same for all of them — a filled page, and `adv=-`:

```
interconnect.comed  p2 "ConnectTheGrid" /applications  fields=55(fill=28,btn=27) plan:nav=- adv=- fills=7
cityofboston        p12 .../Intake/SiteLocation        (13 pages walked, 24 fills)
baltimorecounty     p8  cityworkspro/PLLPortal/        fields=14(fill=7,btn=7)   plan:nav=- adv=- fills=1
```

The walk stops on a page it has just completed while that page still shows dozens of buttons.
`clickFallbackAdvance` now takes a plain Next/Continue/Proceed as a last resort, and refuses
Accela's "Continue Application" along with every submit — that button is the page advance on
every page but the last, where it FILES. Losing a page we do not learn is recoverable;
clicking a submit is not.

Two other things the traces show, worth knowing before the next attempt:

- **`us.cloudpermit.com` ends on its own login page at p7** — the session is being lost
  mid-walk, which is a different problem from anything above.
- **`gilbertaz.seamlessdocs.com` is filling "Permit Extension Request"** — a permit
  EXTENSION form, not a new permit. It scores 8 fills and is learning the wrong thing.

## Consent-wall pilot (2026-09-08) — moved two portals, and named the residual

`data/learn-benchmark/2026-09-08T15-42-22.json`, three portals.

| portal | before | after |
|---|---|---|
| desmoines-wa.permittrax.com | entered_application (3) | **reached_form (4)** |
| apps.lakestevenswa.gov | entered_application (3) | **reached_form (4)** |
| cantonoh.portal.iworq.net | reached_form (4) | reached_form (4) |

Declining clears the FIRST wall and the walk continues. Both still terminate at a consent
wall later in the flow — most likely an Accept-only banner, which the pass refuses by design
(it clicks Reject / Decline / Necessary-only, or a Close that consents to nothing, and never
Accept). Whether to accept non-essential cookies on the operator's behalf is the operator's
decision, not the engine's; it is the one thing standing between these two and the form.

### What the stored page trace immediately showed

The trace is on the scorecard row now, and the first run with it answered the question that
twelve portals could not be asked before:

```
desmoines  p2 "Citizens Connect by Bitco" [/citizen/Home/DESMON_L/PBPW] dashboard fields=27(fill=0,btn=27) plan:nav=...
desmoines  p3 "Citizens Connect by Bitco" [/citizen/Home/DESMON_L/PBPW] form      fields=29(fill=6,btn=23) plan:nav=17  fills=0
```

Two things worth acting on:

1. **p2 and p3 share a URL.** These are SPAs that swap content in place, so page identity
   cannot be read from the address — anything keyed on URL sees one page where there are two.
2. **The page offers 6 fillable fields and the planner returned 17 navigation candidates and
   ZERO fills.** On a permit-type chooser that may be correct, but it is the signature of the
   whole `reached_form, filled NOTHING` cohort (8 portals in the fleet run) and it is now
   reproducible from a stored row rather than a live re-run.

`maxPages` is 18 and these walked 3-4, so the page budget is NOT the limit. They stop because
of the wall, not because they ran out of room.

## Corrected portal URLs (researched 2026-09-08) — OPS WORK LIST

Several portals score `login_failed: the portal's login form was not recognised`, and the
reason is not login detection: **the stored URL is a city information page, not a portal**.
One resolved to Facebook. Found by reading each jurisdiction's own site for the link it
tells applicants to use.

**Every row below was opened in a real browser (read-only, no credentials) and reports what
the page actually is.** That check earned its keep immediately: the first Akron candidate,
taken from a search result, returned "Page Can Not Be Found".

| stored URL (wrong) | what it actually is | the real portal (VERIFIED) | evidence |
|---|---|---|---|
| `www.cityofsacramento.gov` | department page | `https://aca-prod.accela.com/SACRAMENTO/Default.aspx` | 200, title "Accela Citizen Access", 11 inputs |
| `snohomishcountywa.gov` | **redirects to facebook.com** | `https://pdspermitportal.snoco.org/pdsportal/app/landing` | renders "PDS Permit Portal" with a login — note the SPA answers 404 on the route while serving the app, so a plain fetcher calls it dead |
| `www.akronohio.gov` | plans/permits info page | `https://agis.akronohio.gov/CityworksPA/template/login.aspx` | 200, title "Public App", login form — Cityworks, NOT the iWorQ URL a search suggested |
| `www.sandiego.gov` | solar-permit info page | `https://aca-prod.accela.com/sandiego/Default.aspx` | 200, Accela, login AND apply present — canonical host is aca-prod, not aca |
| `www.lascruces.gov` | directory page | `https://aca-prod.accela.com/lascruces/Default.aspx` | 200, Accela, login |
| `www.miami.gov` | "Get a Permit to Install Solar Panels" | `https://apps.miami.gov/iBuildPortal/` | 200, redirects to its Account/LogOn — host is apps.miami.gov, NOT apps.miamigov.com |

Still unresolved: `www.palmbayfl.gov` (the city points applicants at
`palmbayflorida.org/building`, which fronts an iMS portal whose direct URL is not published),
`business.ct.gov`, `permitwizard.dcra.dc.gov`, `www.miramarfl.gov`.

**These are NOT applied.** Changing a stored credential's portal URL is operator data and
touches the permit/utility scoping rule (CLAUDE.md #5 — a permit track must never resolve a
utility URL). Apply them deliberately, one at a time, and re-run
`npm run learn:benchmark -- --host <host>` after each to confirm the portal is reached.

Note for prioritisation: three of the six are Accela, which is the platform the engine knows
best — those are the cheapest to bring online.

## LEARN measured across 59 live portals (2026-09-08)

`data/learn-benchmark/2026-09-08T14-52-38.json`. The learn half had not been measured since
2026-09-04 (23 portals, 19% usable) and none of this session's engine work had been tested
against it.

**59 portals, 57 measured, 14 usable (24.6%), mean rung 2.42.**

| rung | n | |
|---|---|---|
| login_failed | 28 | the wall |
| recorded_steps | 12 | filled fields, never reached review |
| reached_form | 8 | walked in and filled NOTHING |
| unreachable | 7 | WAF blocks, dead hosts, 2 harness backstops |
| entered_application | 2 | |
| **reached_review** | **2** | permiteyes.us, co-spokane-wa.smartgovcommunity.com — **neither is real**, see "The review number was fiction" above |

### The wall is login, and most of it is not ours to fix

Of the 28 login failures:

| n | cause | owner |
|---|---|---|
| 11 | the stored credential was refused | credential |
| **8** | **the portal's login form was not recognised** | **engine** |
| 7 | MFA/CAPTCHA — automation never solves these | portal (correct refusal) |
| 1 | login ended as "no_submit_control" | engine |
| 1 | no credential stored | credential |

So 9 of 28 are engine-addressable. **And several of the 8 are not login-detection failures at
all** — `sandiego.gov`, `miami.gov`, `lascruces.gov`, `akronohio.gov` are the same
jurisdictions this handoff already records as having a stored URL that points at a city
INFORMATION page rather than a portal. Fixing those is a data correction (the candidate URLs
are recorded above), not engine work.

### Eight portals reached a form and filled nothing

The page traces say why, and it is not the field planner refusing to fill:

```
frederickcountymd  "Lookup Record - CIVICS"      fill=99  plan:nav=11  fills=0
peco.connectthegrid "ConnectTheGrid /applications" fill=27  plan:nav=23  fills=0
app.communitycore  "/app/contractors/.../dashboard" fill=5 plan:nav=12  fills=0
```

The learn is standing on a LOOKUP, LIST or DASHBOARD page and planning more navigation. It
never found the way into a NEW application. That is the applicationEntry problem, and it is
the single biggest engine lever left on the learn side.

### A stored URL that lands on Facebook is not a portal

`snohomishcountywa.gov` redirected to `www.facebook.com/SnohomishCountyWA`, and the learn
walked it as a permit portal: 112 form fields, 42 fillable, a navigation plan, and a recipe
row at the end of it. Nothing about that is recoverable at replay — the recipe would drive a
social network on every future filing for that jurisdiction. The learn now refuses a named
list of social hosts and reports the stored URL as needing correction. Named hosts only: a
city that genuinely runs permitting on an unexpected domain must still be learnable, so it
refuses from a list rather than guessing from shape.

### The first honest reliability measurement (2026-09-08)

One build, three attempts per recipe, interleaved. `data/replay-benchmark/2026-09-08T10-15-50.json`.

| recipe | clean | why not |
|---|---|---|
| PacifiCorp NEM | **3/3 (100%)** | — byte-identical every run, 47 values verified against 31 required |
| PGE NEM | 0/3 | deterministic: "Model" select does not land; one policy-default step |
| Ameren NEM | 0/3 | first-run stop at the Terms checkbox (gone: 73/75 live); 5 blanks the portal CLEARS on re-render — diagnosed, needs a re-record (see below) |
| Coos Bay structural | 0/3 | a step clicks record number `187-26-000309-STR` from its own learn session |
| Coos Bay electrical | 0/3 | attachment upload stalls, so the portal blocks Continue (wait added, NOT live-confirmed — see below) |
| **fleet** | **3/15 = 20%** | |

**Read that 20% as a FLOOR.** Production (`repository.ts`) hands every staging run an LLM
gap-fill planner; the benchmark passed none, so it has been measuring RECIPE-ONLY replay.
Ameren's five blanks are exactly that difference. The run now prints which configuration it
measured; `--gap-fill` measures the production-equivalent one.

### Two live defects the sweep found, and how each was actually diagnosed

**Ameren's Terms checkbox.** The screenshot showed a "What's new?" announcement modal over
the page, and the obvious story was that it swallowed the click. A fixture built around that
story **passed without the fix** — which is the only reason the wrong cause did not ship as
the right one. The failure text had it all along:

```
locator.check: Clicking the checkbox did not change its state
  - forcing action / performing click action / click action done
```

The click was delivered and the box did not move: PowerClerk draws its own checkbox, keeps
the real input concealed for submission, and binds the handler to the LABEL. Fix: click what
a person clicks, read the state back, re-throw the original error if the label route fails
too.

**Coos Bay's attachments.** `setInputFiles` returns when the INPUT holds the file; the
portal's async upload is still in flight while the recipe fills the description, sets the
type and clicks Save. Accela then showed a complete filing with the bar at 0%, Save greyed,
an empty attachment table and "Your documents are not yet saved" — and eleven steps later
the run reported "the portal did not advance". The learn side had waited for this all along
("ACA keeps the Save anchor inside a container it reveals with JS only once the uploads
finish"); replay waited for nothing. Its fixture ALSO had to be slowed to 7.5s before it
could fail without the fix, because the first version finished inside waits the adapter
already performs.

### Ameren's five blanks: diagnosed, and NOT an engine defect

Chased to the end with instruments added for the purpose (the page stamp on every blank, and
the gap-fill report on the scorecard). What is now established, live:

- The blanks are all on ONE page: `Name / Company / Address / Email / Phone
  [Interconnection Application]` — the first page of the form.
- **Gap-fill FILLED Email and Phone** (it targets required-EMPTY controls) and the sweep a
  moment later reported those same controls empty. So it is not a twin contact block that
  nobody filled — it is the block we DO fill, being cleared.
- Sixteen re-assert attempts across two passes, plus gap-fill, all cleared. The run now says
  so in the operator's terms: *"5 required field(s) would not stay filled on this page after
  two passes — the portal clears them on re-render; they need entering by hand before
  submit."*

The remaining question is WHY PowerClerk clears it, and the likely answer is a commit ritual
the recipe never recorded: these blocks are usually driven by a contact-type choice or an
Add/Save that promotes a template into a real contact, and typing into the inline template
is discarded. **That is a re-record, not an engine change.** Do not spend more engine passes
on it — the engine has now said everything it can see.

Cap raised from 3 to `REASSERT_MAX_FIELDS` (8) along the way, because three was chosen when
the case in hand had one field and this block has five: two were never even attempted while
the run reported all five blank.

### The Coos Bay upload wait is fixture-proven, NOT live-proven — next lead

The post-fix pilot still failed (46 of 62) and `waitForUploadAccepted` **fired no warning**,
which means it found no progress indicator and returned. The wait is proven by its fixture
and the live evidence is currently against it having engaged at all. Do not read it as fixed.

**Named next step, not yet checked:** the learn side's own comment records that Accela
renders the attachment grid in a CHILD IFRAME (`iframeAttachmentList` →
`FileUpload/AttachmentsList.aspx`) — and it had to read the grid through
`frameLocator` for exactly that reason. `waitForUploadAccepted` evaluates the MAIN frame
only. If Accela's progress indicator lives in that iframe, the wait can never see it on the
one portal it was written for, which is precisely the silence the pilot showed. Check that
before changing anything else about the upload path.

### Filing defects found by reading the scorecard, not by guessing

Every one of these was sitting in `detail.blankNames` / `detail.message` in a stored
scorecard the whole time.

- **PGE left "Energy Storage" blank.** The no-battery rule skipped the whole storage
  section — including the QUESTION asking whether there is a battery. Not having one is
  the answer, and it is "No". Replaying the recorded "Yes" is worse and has happened
  live: a PacifiCorp filing once declared a 13.5 kWh Powerwall on a job with no storage.
  The split is between the QUESTION and the SPECS, by shape not by portal: a spec asks
  for a number, a make, a model or a rating; a declaration is a bare storage noun, and a
  checkbox is always a declaration.
- **Ameren left Name, Company, Address, Email, Phone blank.** The re-assert that repairs
  re-rendered fields hangs off the ADVANCING click, so the one page it never reached was
  the last one — the page a human is handed. It is now one shared method, and it FILLS
  ONLY: it never clicks, which is what makes it safe there.
- **Coos Bay electrical "failed" at the fee page.** Its recipe carries the card fields of
  the human who learned it. Replay now stops AT the first card field in every mode and
  reports a staged filing awaiting payment — the same handoff the final submit gets, one
  boundary earlier. `PAYMENT_FIELD` is deliberately narrow: its own smoke immediately
  caught "Contractor Licence Expiration Date". A card is the one thing that splits its
  expiry into a MONTH and a YEAR.
- **Coos Bay structural is genuinely broken** and left failing on purpose: a step clicks a
  link named `187-26-000309-STR`, a record number from its own learn session that cannot
  exist in a new filing. It needs re-recording; no code change is the honest answer.

### "The review screen disagrees" when there was no review screen

PacifiCorp ends on the Aggregation page — the last INPUT page. Every check failed to find
its value, the scope fallback dressed those failures in whatever text was on screen, and
the verdict read `homeownerName shows "No; checked"` with DO NOT SUBMIT, against a filing
with zero blanks and 47 verified values.

Two signals now gate it, because the first one alone swallowed the catch that matters
most (a real review screen showing the WRONG name confirms nothing either, and the DOM
smoke caught that within one run). Mismatches are suppressed only when nothing matched
AND every scraped pair came from a control someone could still type into — the scraper's
own founding premise: **a true review page has no fillable inputs.**

Consequence to expect: a portal with no review screen cannot reach rung 5, so SUBMITTABLE
reads 0 for it forever. That is not failure; `fieldsVerified` against `requiredFieldsSeen`
is the substitute evidence.

### The rules this session kept re-learning

- When a failure line does not change across several fixes, **suspect the line**.
- When a fix does not change the outcome, **prove it executes**.
- A diagnostic that names two possible outcomes has not diagnosed anything.
- Never claim a finding the instrument did not make (`measured` flags exist for this).
- A test nobody runs is a comment — eleven smokes were on disk and in no chain.
- Heredoc `\n` / `\b` corrupt silently on this machine; build backslashes with
  `chr(92)` or use the Edit tool.

## What shipped recently (newest first)

| Commit | What it is |
|---|---|
| **Production verification sweep, and the two things it found** (2026-09-14) | **All four suites green**: typecheck clean, backend chain 106 tests / 1538 ok-lines / 0 fail, portal unit 194 ok / 0 fail (ending on the real-Chromium concurrency stress and the three safety rules — final submit never clicked, fee buttons never clicked, MFA stops the run), and `npm run smoke` passed with its full banner. **Auth verified in the production configuration** (`AUTH_ENABLED=true`, which had never been run): every public surface 200s logged-out (`/portal`, `/status`, `/intake`, `/credentials` and their APIs) and every private one 401s or redirects; the client portal renders logged-out with no console errors and no failed requests. **The 26 'failed' background jobs are all CORRECT REFUSALS** — 15 blocked on unresolved QC/review, 3 on missing PE-stamped structural docs, 3 interrupted runs correctly not auto-rerun, 1 duplicate-application guard, 1 concurrent-learn guard. Zero pending, zero running, 235 done. **FIXED — the readiness number was wrong in both directions.** It counted archived TEST fixtures (Springfield/Evanston IL, homeowner "Test Testerson"), and it never saw that a real filing proves a login: `last_login_ok_at` is written by the auto-learn path ONLY, so every portal we have actually replayed a filing through read "we have never presented this company's login" — one credential in the whole table had an accepted login and it was a Sacramento benchmark. Coverage now excludes archived projects and reads a submitted filing as login evidence (writes nothing; refusals and staged applications still outrank it). **READY NOW 1-of-16 → 2-of-10, and both numbers were wrong before.** **OPEN, deliberately not fixed**: the STAGING path still never calls `recordLoginOutcome` — that write feeds the credential lockout gate that 409s `prepareSubmission`, so a misclassified staging failure would lock out a working credential; it wants its own pass. Also open: `PGE` vs `Portland General Electric` splits one jurisdiction into two rows (name normalisation, not attempted). DOM smokes were NOT re-run — zero portal-bot files were touched this session. |
| **The client update channel, turned on end to end** (2026-09-13) | **Three real client emails had been sitting undelivered since 2026-09-01, one of them a CORRECTION REQUEST.** Detection, wording and the status link all worked; `SMTP_HOST`/`SMTP_FROM`/`PUBLIC_BASE_URL` were never set, and delivery state was a PREFIX ON THE SUBJECT LINE, so "what did we fail to send?" was not a query anyone could write. **v25** gives `communications` real `delivery_status`/`delivery_detail`/`recipient` columns (unconfigured SMTP now distinct from a failed send), backfills the three rows, WARNs with a running total on every non-delivery, counts them at boot, and `scripts/undelivered.ts` lists and (with `--send`) re-sends them. **`clients.updates_inbox` could not be written by any code path** — absent from `ClientRecord`/`mapClient`/`FIELD_COLUMNS`, so all five v18 columns were dropped with a warning on every onboarding run; the notifier's own test had hidden it by setting the column with raw SQL. **New per-client portal** `/portal?token=` (v26, stable unrotatable token by operator decision) listing every job for one company, plus PM-voice `client_update` notes written from `clientUpdates.ts` — ONE wording rendered into both the email and the page, carrying the AHJ's own reference and naming the other track when it is still open. **v27 archived_at**: the first live render showed TML 15 cards for ~8 real jobs, so 7 superseded passes and IL test fixtures are hidden from the client view — ARCHIVED, not deleted, because `demoReplay.ts` reads this DB by id and HANDOFF cites those runs; all 15 projects and 90 submissions remain. **Auth fix**: `/credentials` rendered but its API 401'd under `AUTH_ENABLED=true` (page registered before the gate, routes after, no carve-out) — a customer would have typed a portal password into a form that could not save; now covered by `publicSurfaceAuth.test.ts` as an invariant over every public surface. Live sweep re-ran all 7 monitored targets (4 read, 3 NEM unreadable and correctly kept their known status, 0 changes, no spurious re-notify) via the new `scripts/check-permits-now.ts`. **OPERATOR, IN ORDER**: set `SMTP_HOST`/`SMTP_FROM`/`PUBLIC_BASE_URL`; `npx tsx scripts/undelivered.ts --send` (re-sends the 3, link rebuilt at send time); `npx tsx scripts/client-portal-link.ts` and send TML theirs. **OPEN**: `POST /api/projects/:id/permit-checks` without a `targetId` reads previousOutcome as `""` and re-notifies every call — it now also stacks duplicate client notes on the portal, permanently visible. |
| **The correct portal URLs, taken from the pages the wrong ones land on** (2026-09-04, close) | A city page ABOUT permits nearly always LINKS to the actual portal, so the correction was sitting in captures already on disk — no browsing, no guessing. **CANDIDATE URL FIXES, each with the link text that identifies it:** `www.sandiego.gov` stored URL lands on a solar-permit information page whose own "Apply for the permit" link points to **http://aca.accela.com/SANDIEGO**; `www.lascruces.gov` lands on a directory whose "Link to Accela Online Portal" / "City of Las Cruces Citizen Portal" links point to **https://aca-prod.accela.com/lascruces/Default.aspx**; `www.miami.gov` lands on "Get a Permit to Install Solar Panels" whose "iBuild" link points to **http://apps.miamigov.com/iBuildPortal/**. Two remain unresolved: `www.akronohio.gov` (its only portal-shaped link is a Bonfire PROCUREMENT portal, not permits) and `business.ct.gov` (links only to SOTS business-services pages — the stored URL may be wrong at a deeper level). **These are CANDIDATES, not verified**: what is established is that the city's own page presents them as the way to apply. Someone should confirm each before it replaces a stored credential URL. Together with Gilbert's `/f/permitext` (a permit-EXTENSION form) and Miramar's GovDelivery newsletter link, that is five or six jurisdictions whose stored portal URL does not reach a portal — every one of which scored as an ENGINE failure until today. |
| **Corrected three times: what the "login not recognised" failures actually are** (2026-09-04, close) | This was read wrong twice before it was read right, and the corrections matter more than the first answer. **First read:** the login detector is broken on ~10 portals — engine's fault. **Second read:** counted CAPTCHA/consent keywords in the captures and concluded "most are not engine failures at all; the scorer over-attributes." **That was weak evidence and the re-measurement refuted it** — after consolidating the bot-block vocabulary, adding Cloudflare and wrong-URL detection, engine-owned moved only 16 -> 14 and ten portals still reported "login form was not recognised". **Third read, structural rather than keyword-based:** four of those pages were opened and inspected, and they are all the same thing — `sandiego.gov/development-services/permits/solar…` (nav: Home, Parks and Recreation, Book an Event), `miami.gov/…/Get-a-Permit-to-Install-Solar-Panels` , `business.ct.gov`, `akronohio.gov/departments/finance/manage_my_account`. **Zero password fields, zero login controls, municipal site navigation: these are CITY WEB PAGES ABOUT PERMITS, not permit portals.** A conservative audit of every login-failure capture confidently classes 3 that way (sandiego, miami, akronohio) with several more likely (lascruces' directory, business.ct.gov, permitwizard's landing page, Miramar's GovDelivery newsletter). **So a material share of the fleet's stored portal URLs do not point at portals** — the same class as Gilbert's `/f/permitext`, and no engine work reaches any of it. NOTE the guard added earlier (looksNotLikeAPortal) deliberately stays silent on any page mentioning "permit", which is exactly what these pages do; widening it risks accusing real portals, so these are reported rather than auto-detected. **Three predictions were made and missed this session** (8-10 usable -> 4; engine 2-3 -> 16; engine falling to 5-8 -> 14). Treat confident readings of this fleet with suspicion until they survive a re-measurement. |
| **The five engine-owned failures, re-run after the last two fixes** (2026-09-04, close) | Of the six engine-owned failures in the unbiased 24-portal sample, five were re-run against detectErrorPage + the "Logon" vocabulary. **baltimorecountymd went login_failed(1) -> recorded_steps(5)** — four field fills across eight pages — because naming the CloudFront 403 as an error page let looksBotBlocked fire and the headed retry get in; that retry was written earlier the same day and had never once run, for want of the evidence reaching it. **bonney-lake** found its "Logon" link, submitted, and was refused: engine -> CREDENTIAL, the operator's to fix. **hialeahfl** and **lakestevenswa** re-attributed engine -> PORTAL (an MFA challenge, and a cookie-consent wall the new detector named rather than wandered into). Only **cantonoh** remains engine-owned (reached_form, no fills, behind a reCAPTCHA). Owner split on those five: 3 portal, 1 credential, 1 engine — all five had been engine before. Spliced into the 24-portal sample that is **8 usable of 24 (33.3%)** with engine-owned failures down from 6 to about 2; a full re-sweep would confirm the composite, which is the recommended next measurement. |
| **What 95% can actually mean, measured on 24 unseen portals** (2026-09-04, late) | The session had been optimising against a TWELVE-portal sample chosen on day one, out of SIXTY-FOUR eligible. That sample turned out to be adverse — two dead hosts, three CAPTCHA-gated, one consent wall, one SPA-state boundary — so its ceiling was ~3-4 of 10 regardless of engine quality, and "30%" was never measuring what it appeared to. A fresh sweep of **24 portals never previously touched** (SmartGov, OpenGov, iWorq, Tyler, Avolve and municipal sites across WA/MA/OR/PA/MD/FL/NY/ME/MI) put a real number on it: **7 usable of 24 (29.2%), mean rung 2.42** — statistically identical to the biased sample, so 30% is REAL and REPRODUCIBLE rather than an artifact. Two portals reached review outright on first contact (cranberrytownshippa/OpenGov, co-spokane/SmartGov), which is the engine completing portals it had never seen. **The failure breakdown is the actionable part.** Fourteen of 24 stopped at login: SIX because the portal refused the stored credential (everettma, methuenma, salemma, epermits.buffalony, roseburgor, medford-or — the OPERATOR's to refresh), FIVE at MFA/CAPTCHA (capecoral, townofpalmbeach, gloucester-ma, portlandmaine, kentwa — a human by design, never automatable), and only THREE were ours (hialeahfl + baltimorecounty: login form unrecognised; bonney-lake: no submit control). **So the arithmetic on a real fleet is: 7 working + 6 credential-fixable + 5 engine-addressable = 18 of 24, a ~75% CEILING, with 25% (CAPTCHA/MFA and dead hosts) permanently requiring a person.** 95% is not reachable on this portal set and never was; the largest single lever is not engine work but the operator refreshing six passwords. Recommend re-baselining the benchmark on this 24-portal sample — it is unbiased, it exercises six platforms, and every fix from this session met it having had no part in producing it. |
| **The learn benchmark, and what it found** (2026-09-04, 24 commits) | A repeatable measurement now exists (`npm run learn:benchmark`, ladder in `learnBenchmark.ts`, scorecards in `data/learn-benchmark/`), and most of the day's findings came from trusting it and then checking it. **The measurement was wrong more often than the engine was.** Five scoring defects, each of which would have pointed the next day's work at the wrong thing: a killed run's dead browser blamed on the PORTAL for 8 rows (and, worse, written into `portal_credentials` as a refused password, sidelining SIX working logins so a 12-portal sweep silently selected 5 — `runAbort.ts` is now the single answer for "was that us or them"); navigation counted as a usable recipe (momentum 5 steps / 0 fills, permittrax 4/0, iWorq 2/0 — the rung now needs fill/select/check, the same test the trust gate uses); TWO readings of "reached review" (message regex vs page trace) disagreeing and reporting a regression that never happened; a CAPTCHA mid-walk blamed on the engine when it is the engine obeying the rule that automation never solves one; and a `--host` diagnostic run overwriting `latest.json`, which is exactly how one debugs, so the baseline is now reserved for unfiltered runs. **Engine fixes, all from a live artifact:** each auto-learn now gets its own browser profile keyed on the portal host (every AHJ shared ONE 412 MB profile, so the last portal visited was an invisible input to the next); the per-portal cap moved INSIDE the walk (a `Promise.race` stops the waiting, not the run — momentum ran 1220s against a 400s cap, through the next two portals' turns, and all three then "timed out"); `PROGRAM_EXCLUDE` was rejecting *"Renewable Energy Interconnection"* on a bare `renew`, which reads as a portal problem so nobody looks in the filter; legal/consent pages excluded from application entry (PermitTrax found the right door and spent its budget in the cookie policy — and the profile fix made that MORE likely, since every visit is now a first visit); `formPurpose.ts` blocks TRUST when the landed form announces itself as an extension/renewal/inspection/payment (Gilbert reached review, 6 of 6, on a **permit-extension** form); and transient LLM failures now retry — every provider call is a `.stream()`, so an in-stream `overloaded_error` never reaches the SDK's `maxRetries` and one blip cost a whole portal while looking like a regression. **"Present but shut" is now a rule** (`revealHidden.ts`), after a fifth instance: momentum skipped `Licenses & Permits` as hidden on three consecutive pages, clicked advance, and never moved — the field it would not fill was the gate. **Diagnosability is the compounding change**: a failed login now writes its page + screenshot into the run bundle, and the reveal pass records what it tried. Wilsonville took five live runs, and its answer had been in the first capture all along — the modal "blocking" the login was a dialog saying *"You are being redirected to Tyler Identity… **Continue**"*. Three fixes in a row treated the obstruction as the problem (time-box the click, try every visible match, neutralise the cover); all three are real defects on other portals, none was Tyler's. **Open, engine-owned:** momentum/permittrax/iWorq walk pages and fill nothing (momentum's reveal fix is in, unverified live); Tyler now reaches the real identity-provider form and fails at `no_submit_control`. **Open, operator-owned:** Gilbert's stored URL is `/f/permitext` (a permit-extension form — real filings would go there); quincyma and Washington County passwords are refused by their portals. Also: `jobWatchdog.test.ts` never exited, so ~30 tests after it in `backend:test:unit` had not been running at all. |
| **Full pipeline live: parser intake → production staging → portal review** (2026-08-30, evening) | Three FRESH intakes ran through the real UI (parser.html: load PDFs → Parse → pick client → Save to project) and the production staging path — no one-off drivers. **Daly/PGE** (`8f4ca8dd`): parse nailed everything incl. account+meter from the bill; QC all-pass; operator resolved splitPages/locates/homeownerEmail items; staging first FAILED against the stale `or\|unknown\|pge` recipe, which exposed that the stale-flag block was DEAD CODE (stageWithRecipe failures carry their message on the failing STEP, not result.message — fixed in repository.ts); after the fix the whole self-heal chain ran live: fail → flag → auto re-learn → operator deleted the broken row (backup in data/recipe-backups) → re-stage resolved 481c00f4 via the ALIAS BRIDGE → `awaiting_human_submit` at the real PGE review, totals computed, both policy radios answered (the conditional one by the pre-advance retry) — certified from the run's own pre-advance captures. **Rowland/PacifiCorp** (`b0ab5169`) and **Wynema/PacifiCorp** (`29cd57b5`): both staged NEM to `awaiting_human_submit`; their drafts carry ONE blank — the inverter Model — because the blur-commit fix made the make survive the row-add, so the lost-then-repaired path that used to rescue the model never fired; the held-check's cascade-child retry now runs whenever the make is COMMITTED (fixed after these runs; their drafts need the one dropdown or a re-stage). **Permit tracks correctly gated**: Salem learns looped on WorkLocation.aspx (triage findings recorded: planner nav-loop + address post-directional "NE" not decomposed — the next engine arc), and Coos Bay/Lincoln City structural staging refuses without the PE-sealed structural letter (the anti-roof-framing-sheet rule doing its job; no letter exists in any Wynema/Rowland doc set). Recipe shelf curated to exactly three complete rows (PacifiCorp NEM v15-restored, PGE NEM 481c00f4, Coos Bay structural e965c645) — note the sweeper RESTORED 6282e671 to a pre-verification 118-step snapshot at boot; the operator-verify flow uses `fieldValue` (not `value`) on /human-verify; the human-review notes double as exact operator instructions. Job-failure noise: a killed `npm run start` leaves the old node holding :4173 (kill by PID before restart). |
| **All three portals replay to review, fields filled** (2026-08-30, fix-retry campaign on live portals) | Operator goal met and probe-certified against COMMITTED server state (not DOM): **PacifiCorp** (Rowland) — inverter + both arrays + battery + disconnects + uploads + policy answers all committed; remaining blanks are operator data only (account number, Battery Round-trip Efficiency, homeowner's real email — the stored `test.homeowner@example.invalid` is rejected by PowerClerk's server-side validation, which is why it "filled" in the DOM and never persisted). **PGE** (Daly) — inverter + THREE arrays with per-row geometry, uploads, export-capacity No, and the conditional "disconnect within 10 ft" radio answered Yes; that question renders only after totals compute, so a new **pre-advance policy retry** re-attempts skipped policy questions at the page's last moment, and the skip drift now prints the volatile-id group's actual candidates ("(0 candidates — not rendered)" vs labels-that-match-nothing). **Accela structural** (Wynema Wright, Coos Bay) — 57/58, only the recorded-never-clicked final submit skipped; two identity-check false refusals fixed generically: a HYPHEN is not a contradiction ("E-mail:" now matches "email" via compacted comparison, both directions, in the agreement test AND the re-anchor scan), and a label that is ALL MARKERS ("*Type (Required):" — "type" stopped, "required"/"optional" now stopwords too) has nothing to contradict. Earlier in the same campaign: combobox picks now COMMIT (bare blur — the widgets preventDefault option mousedown so focus stays; focus() is an opener and must not be re-fired), the equipment held-check covers the non-row inverter make/model with landed-then-lost vs never-landed distinction plus a cascade-child retry after a make repair, a missed select retries via its LABEL fallback when the volatile `#pcInputBase` id resolves to a different control mid-run, `emptyRequiredControls` reads placeholders-as-empty for selects AND combobox inputs and sees unanswered required RADIO GROUPS, and the policy-radio recovery walks the full accessible-label chain (wrapping labels) with force following !usable. Ops notes: a KILLED replay leaves Chromium holding the portal profile lock (the error says how to clear it; 8 orphans killed by command line match); ~13 stale Unsubmitted Rowland drafts + several Daly/Wright drafts accumulated on the live portals from this campaign — the operator should keep the newest per project and discard the rest; recipe `6282e671` (PacifiCorp) is still status `recording` and both live replays reached it via `--recipe` — the staging path needs it finalized/promoted (human-gated); `probe-draft.ts pacificorp\|pge` is a read-only certification probe (login → newest draft → equipment page dump of committed values), worth keeping; ERR_NO_BUFFER_SPACE on a Chromium smoke after a long day is OS socket exhaustion — re-run, don't debug; unit-test log noise pollutes `data/logs/backend.log` (tests share the default log path) and a post-teardown `correction_triage` FK warning races the E2E smoke's project deletion — both cosmetic, neither chased. |
| **Array rows survive the row-add: commit, address, verify** (2026-08-30, found by re-verifying the session's commits on a live replay) | Run #1 on Rowland ended `ok:true` while BOTH PV-array module selects sat on "Please select…" and array 1 held array 2's qty/tilt — three compounding replay bugs, each now guarded and mutation-checked in `multiArray.dom.smoke.ts` (a new case models PowerClerk exactly: blur-only autosave, row-add re-render from server state with fresh ids, per-row manufacturer→model cascades, bare identical labels, battery below the arrays). (1) **The "array block" bounds sweep in foreign steps.** First..last `array1*` step contains the battery section and a duplicate inverter pair; on pass 2 they re-ran nth-shifted and landed on OTHER sections' controls (labels are identically "Manufacturer", so no re-anchor guard can see it). Repeat passes now run per-array steps only. (2) **The pass-N nth shift never reached the fallbacks.** The primary is a volatile learn-time id (zero matches at any nth) and label fallbacks kept their recorded rank — every pass-2 write landed back on array 1 and array 2 was unaddressable. Fallback nths now shift by pass-1. (3) **Replayed selects never committed.** PowerClerk autosaves per field on blur; `selectOption` fires no focus, so a bare `blur()` is a no-op — the value showed in the DOM, and the row-add re-render restored the placeholder. Landed native selects now focus-then-blur (native ONLY: a combobox commits via its option click, and focus() is an opener on those widgets). Plus a **post-pass held-check**: rows read back by label, lost rows re-run through the normal step path, numbers compared by VALUE (the live incident was non-empty-but-wrong), failures pushed into `requiredStillEmpty`, and a loud warning when the readback can't see the rows it expects (row containers bound by section-level controls — Add Array/Clone/Calculate — or a 1-row page balloons to the whole section and verifies the inverter instead; pinned by a discriminating single-array smoke case). A 3-lens adversarial review hardened all of it; self-heal is fenced off on repeat passes (it would heal array N's value into the inverter AND patch the recipe). Post-fix live run: drift 17→10, skips 7→4, `Model [array 2]` landed in 5.6s, held-check silent-and-armed. Open: step-102 inverter-model match miss (both runs; pre-fix it was rescued BY ACCIDENT by the foreign re-run), Battery Round-trip Efficiency + account number are operator data, recipe `6282e671` still `recording`, the 318s Calculate+Next stall, `probe-pge.ts` (PGE Program Home locator). |
| **Replay fixed on live PowerClerk: section overwrite, overlay, pace** (2026-08-30, watched live runs) | A random never-seen project (**Randal Rowland — Tesla battery + 2 arrays**) now replays PacifiCorp end to end: `ok:true`, **93/100 steps, 0 failures, 366s**, stopped at review, nothing submitted. Getting there found four bugs. (1) **The homeowner overwrote the installer.** PowerClerk's "Preparer Information" and "Customer Information" pages carry byte-identical labels (Name, Last, Address, City, State, Zip, Email, Phone) at the same URL. The guard that skips an advance a jurisdiction does not need decides by LABEL OVERLAP, which on such a portal is ALWAYS true — so it skipped the real Preparer->Customer advance and the homeowner steps wrote over the installer's. Live: Charles Bitton of TML INTERNATIONAL replaced by homeowner Randal Rowland, at the homeowner's own site address, in the PREPARER block. The recipe bindings and the backend resolution were both CORRECT — only replay's idea of which page it stood on was wrong, which is why nothing upstream caught it. Fix: never skip an advance off a page you just wrote to. Steps record `section:""` so there is no heading to disambiguate with, but "we just filled this page" needs nothing recorded. (2) **Announcement overlay ate the first click.** Replay called `dismissPageModals` (which CLICKS "Got it") before a click but never `clearPageOverlays` (which REMOVES the popover). PowerClerk's "What's new?" is a SEQUENCE of "Got it" steps, so clicking one advances a tour and the popover stays over the button. Cost a 30s timeout plus a reload; on PowerClerk a reload returns the wizard to page 1. PGE step 1 went from two 30s timeouts to `ok`. (3) **301 seconds on one absent control.** A conditional question this project's page never renders burned 301s of a 340s run in sleep/reload/settle cycles. A reload cannot conjure a control the page lacks. Now one DOM read settles it. (4) **CEC module names.** Two live projects name `ZXM7-UHLD108-440/N`; the list spells that family `ZXM7-UHLD**D**108-440/N` and NO listing in 24,498 rows uses the single-D form, so resolution returned "" and replay fell back to the plan-set literal — the path that once picked `DS3-LV {120V}` for `DS3-L`. Repaired only under four simultaneous constraints (same make, listed `power_w` equals stated wattage, one-LETTER insert/delete, unique candidate); digit edits and `/M`<->`/N` revision swaps refuse. Also: replay now reports its **slowest steps**, and `healSelectorForStep` records WHY a re-anchor declined — including "the live page offers the SAME selector that just failed", which means overlay/disabled, not drift. New smokes `identicalSections.dom.smoke.ts` and `newFeaturePopover.dom.smoke.ts`, both mutation-checked (the popover one PASSED without its fix until it counted page loads — the retry-path reload was masking it). `portal:test:dom` now runs ten suites. |
| **NEM portals trusted: PGE + PacifiCorp** (2026-08-29, watched live runs) | Both PowerClerk portals now learn clean and auto-promote to **trusted**. PGE 6.4 min / 11 pages / 68 steps / 37 bound fields; PacifiCorp 5.2 min / 10 pages / 99 steps. Every run stopped at the review screen — nothing submitted, no fee paid. Five bugs found and fixed, four of which had been silently blocking trust: (1) **recipe key split** — recipes are keyed on the utility name *as the project spells it*, so the trusted PGE recipe at `or\|unknown\|pge` was unreachable by real projects storing "Portland General Electric"; every NEM stage paid a full learn instead of replaying. Read-side alias fallback now reuses the KB's own scorer (exact key still always wins; never crosses a state; refuses to run with no state). (2) **frozen dates** — a portal date field has no project value to bind to, so the planner-computed value froze into the recipe; the PGE recipe carried a commissioning date that had since gone into the PAST. Date literals now rebind by the control's LABEL to a value recomputed on every replay. (3) **policy "No" self-reported as a miss** — `applyPolicyDefaults` clicks the radio whose label equals the answer but recorded the ANSWER as expected, and the readback reads expected as a boolean, so `"No"` parsed as "should be UNCHECKED" and a correctly-answered question reported itself as a required-field miss. Only the "No" answers tripped it, which disguised it as one stubborn question. This alone kept PGE at draft through twelve learns. (4) **retracted misses** — the premature-atReview guard sweeps before the page's fills and its misses were never reconciled. (5) **coincidental literals** — PacifiCorp asks four separate questions answering "No", which collided with `hasBattery`/`exportLimiting`; a substantive label naming no candidate now marks a portal constant instead of blocking. Also: tilt/azimuth round to whole degrees (a fractional "180.5" was being typed into the live PacifiCorp form). Retired the old 60-step PGE recipe **with the operator's explicit approval** — it was marked `[verified by operator]` but recorded ZERO equipment-specs steps, so replaying it filed a NEM application with no inverter/module make+model and no tilt/azimuth. Row backups in `data/recipe-backups/`. New: `live-nem-learn.ts` (driver, `pge`/`pacificorp`), `policyDefaults.dom.smoke.ts`, `recipeNameAlias.test.ts`, `recipeDateBinding.test.ts`; `portal:test:dom` was only running two of the four real-browser smokes and now runs all four. |
| Demanding-state readiness: seeded code profiles for CA/FL/NY/MA/CO/AZ/TX + IL/Chicago (this + prior commit) | **IL** (added after): no statewide building/electrical code (2021 IECC is the only statewide construction code — confirm each AHJ's cycle); 83 Ill. Adm. Code Part 466 interconnection; Smart Solar Billing for systems interconnected on/after 1/1/2025 (supply-only netting, ComEd ~$300/kW smart-inverter rebate, NEM ≤2,000 kW AC); Illinois Shines/ABP 15-yr SRECs with IPA Approved Vendor + ICC DG installer certification. **Chicago** gets its OWN AHJ profile: 2019 Chicago Construction Codes + Chicago Electrical Code on a 2017-NEC basis with conduit amendments (plan sets citing NEC 2020/2023 get corrected), IL-licensed SE/architect structural certification at ANY size (engineerStampOverKwDc 0), ~25 psf ground snow. | Web-researched (Aug 2026) state-level jurisdiction code profiles for the seven hardest markets, seeded (NEVER verified — human verification still gates trust): **CA** 2025 Title 24 codes eff. 1/1/2026 (AB 130 6-year cycle), CRC R324 fire setbacks (18"/36" ridge + two 36" pathways) as fireSetback rules, Rule 21 + NEM 3.0 net-billing note, PE stamp >10 kW (`engineerStampOverKwDc:10`), NEC-basis edition flagged CONFIRM (sources conflict 2023 vs 2026). **FL** FBC 8th ed 2023 + ASCE 7-22, HVHZ NOA/TAS product-approval amendment (Miami-Dade 175 / Broward 170 mph, Exposure C), `allowedWindExposures B/C/D`. **NY** Uniform Code + PE/RA stamp on all drawings, structural letter >5 psf (`maxPvDeadLoadPsf:5` seeds the screen), SIR/CESIR interconnection note. **MA** 780 CMR 10th + 527 CMR, stamp >10 kW. **CO** 2021 IECC/solar-ready mandate, SB19-077 $500 fee cap, Xcel 12-16wk. **AZ** HB2301 instant permitting (1/1/2026) + SolarAPP+ eligibility, stamp >15 kW. **TX** NEC 2020 baseline, per-city rules, IEEE 1547-2018. These flow into QC baseline screens, the reviewer's code context, and the prescriptive PDF-fill bridge automatically (all data-driven). Verify each profile against official sources before treating citations as authoritative — every entry carries SEEDED/confirm notes and official-source URLs. |
| Intelligence/autonomy upgrade (earlier commit) | Result of a 4-auditor + synthesis review of the whole pipeline against current agent best practice. **Model**: `claude-opus-5` (drop-in from opus-4-8, identical pricing, step-change capability; override with `AUTOPILOT_LLM_MODEL`; NOTE separate rate-limit bucket from Opus 4.x — check tier limits). **LLM transport**: client `maxRetries: 5` (a 529 burst no longer kills maxRetries:0 jobs); prompt caching on the previously-raw call sites (vision extract, verify-vision, web-search research, flat-form mapper) + `reviewPlanSetGeneral` restructured so the system prompt is static (jurisdiction context moved to the user turn — one shared cache entry instead of per-jurisdiction writes). **Autonomy**: `createProject` auto-starts autopilot Segment A (disable with `AUTOPILOT_AUTO_START=0`; every gate preserved; the human approval gate is untouchable — `awaiting_human_submit` is not resumable); the 402 payment gate now surfaces as `blocked` with a `payment_required` blocker instead of `failed`; `maybeResumeAutopilot` re-drives a blocked project the moment a blocker-clearing event lands (human-verify, doc upload, mark-paid/waive, client assign, intake submission). **Self-heal**: stale recipe → auto-enqueues a fresh `auto_learn` (guards: API key, kill-switch, dedupe; off with `AUTO_RELEARN_STALE=0`); failed/paused STAGING runs now enqueue `run_triage` (previously learn-path only). **Job worker**: enqueue self-kicks the worker (no 30s wait), bounded drain per tick (`MAX_JOBS_PER_TICK`, default 5), permanent failures broadcast `job_failed` SSE + open a human-review item (deduped; advisory triage jobs SSE-only; these items are excluded from the staging pending-review gate), autopilot outcome broadcast moved into the job handler so every path announces the ACTUAL result, codeProfiles retry off-by-one fixed. **Hardening from a 13-agent adversarial review**: Segment A re-checks PRE_STAGE_STATUSES at EXECUTION time (a stale queued job can no longer stage a duplicate live application), `/autopilot/start` dedupes against a pending/running autopilot job, autopilot maxRetries stays 0 everywhere (staging is not idempotent portal-side — orphan recovery after a restart must fail+escalate, not silently re-stage), auto-resume fires only on `blocked` runs (never `failed`) and carries the original track, the public intake link triggers a resume only on FIRST completion, the auto-relearn dedupe is portal-wide with a 6h window, and the PV-breaker cross-check has a units plausibility guard (per-unit ≤100 A, minimum ≤400 A) so watt-parsed inverter outputs can't fire false warnings. **Accuracy**: four deterministic QC cross-checks in `baselineRules.ts` (`xcheck-module-math` qty×W vs dcKw with 1.5% tolerance, `xcheck-combined-size` new+existing, `xcheck-dc-ac-ratio`, `xcheck-pv-breaker-125`), tests in `parserCrossChecks.test.ts`. |
| Prescriptive checkbox bridge + existing-system parsing (earlier commit) | (1) Stored AHJ **checklist PDFs now tick their Yes/No checkboxes from parsed data**: `computed.presc<Key>Yes/No/Answer` sources (`prescriptiveComputed` in `ahjForms.ts`, stable keys in `permitPath.ts`) resolve from `evaluatePrescriptiveCriteria`; offered to the LLM field mapper (`AVAILABLE_FIELD_SOURCES` + prompt rules in `llm.ts`). Safety: `[verify]` resolves to "" in every variant — an unverified row ticks NOTHING; sanitizers strip source annotations and rewrite `presc*Answer`-without-`equals` on checkboxes to the Yes-mark variant. Structural value blanks fill from new `snapshot.*` sources. (2) **Existing-system (addition) projects** (e.g. Kristina Anderson, Salem): parser prompt extracts `existingSystem/existingDcKw/existingAcKw/existingModule*/existingInv*/combinedDcKw/combinedAcKw` with a hard rule that `dcKw`/equipment fields describe ONLY the new scope; canonical `hasExistingSystem` flag; NEM 25 kW / Tier-1 screens key off the COMBINED capacity; description-of-work + worksheet + submittal email call out the addition; existing/combined sources offered to the form mapper. ALSO fixes: frontend `LLM_SNAPSHOT_KEYS` allowlist was dropping the six structural fields added last commit (`windSpeed/riskCategory/lightFrame/framingType/roofLayers/moduleHeightAboveRoof`) — the checklist evaluator would have seen `[verify]` on real intakes. An adversarial 15-agent review then hardened the diff: `equals:""` on a checkbox rule would have ticked the box exactly when data was UNVERIFIED (now dropped in the sanitizer AND guarded at fill time via `checkboxRuleChecked`); `hasExistingSystem` is now evidence-only "Yes"/blank (never a definitive "No" from absent data, so it's checkbox-safe under both fill semantics); `updateProject` now recomputes derived flags and persists the CANONICALIZED merged snapshot (an addition discovered on re-parse was permanently frozen out of the flag before); the presc fill bridge screens against the jurisdiction code profile's limits (same as QC), not always Oregon defaults; `existingSystem:"no"` no longer reads as an addition (truthy-string bug in 3 doc sites); the `presc*Answer`-on-checkbox repair resolves Yes/No from the FIELD NAME and drops ambiguous rules instead of guessing Yes; source sanitizer strips single-space annotation echoes. Tests: `prescriptiveFormSources.test.ts`, `existingSystem.test.ts`, `existingSystemReparse.test.ts` (DB-backed re-parse). |
| Standalone form filler (`tools/form-filler/`, this commit) | The AHJ form-fill engine split out as a self-contained batch PDF filler (operator asked for it to fill permitting refund requests). Map a blank once (LLM AcroForm map / vision overlay with `ANTHROPIC_API_KEY`, offline name-matching without), then `fill` one PDF per CSV/JSON row — deterministic, no LLM at fill time, same UNVERIFIED-until-previewed trust model as AHJ maps. `npm run form:fill -- <inspect|map|fill> ...`, tests `npm run form:test`; the folder carries its own package.json so it can be copied out as a separate project. Does NOT touch backend/portal-bot code. |
| Combined-select specs + WA AHJ acquisition fix (earlier commit) | (1) PowerClerk's OTHER spec template — unlabeled "Please select..." combined make+model dropdown per repeater row (Qty + select, no Manufacturer/Model wording) — now filled by the equipment pass: bare selects stay in the pass, side from explicit wording or row order (inverter row first) within a spec section, model-first candidates, verified fills so wrong-side never holds. (2) AHJ form acquisition no longer skipped out-of-state: hand-written Oregon profiles are state-gated (bare names like "Washington County"/"Salem" collide across states), and synthesized process profiles never claim `requiresPortalEntryOnly` (Clark Co WA's "Avolve portal" method was short-circuiting acquisition before research ran — the "no documents pulled" bug). Tests: `testEquipmentCombinedSelectRepeater`, `applicationProfileStateScope.test.ts`. |
| PowerClerk specs fix (earlier commit) | Equipment pass matches by SECTION+label context (bare "Manufacturer"/"Model"), inherits side by proximity, fills quantity/tilt/azimuth/tracking, tolerates duplicate labels. Real-browser cascade smoke: `powerClerkSpecs.dom.smoke.ts`. |
| `cd4042d` | Full AHJ form-set acquisition (application(s) + checklist per process profile + KB required docs; every distinct PDF stored, classified by type) + self-healing links (broken form sources re-researched + re-stored; KB portal URLs swept every 14 days, dead ones re-researched; human-verified rows only flagged). |
| `704fdfb` | AHJ filled-form download 500 fix (queried nonexistent `ahj_forms` table). Regression test boots the real server. |
| `cb5f7a2` | Per-submission payment gate: quote = real permit fees (actual > learned per-AHJ history > valuation estimate) + client service fee; blocks staging (402) until paid/waived; Payment panel at top of project; fee history learns per AHJ. |
| `2937abe` | KB runaway-notes fix (segment-level dedupe + migration v9 repair + bullet rendering). |
| `29b7ac5` | Onboarding research + form finding seeded with imported KB knowledge (`knowledgeResearchHint`); KB `.pdf` links used as download candidates. |
| `ca8e041` | Reviewer gate + learned-profile lookups get fuzzy AHJ fallback (state-pinned). |
| `b889f67` | Fuzzy state-aware KB resolution (`findKnowledgeForLearn`) feeding the auto-learn planner (utility + AHJ rows + code profile). |
| `2d460f0` | Reference spreadsheet importers (~2,915 rows: AHJ codes, utility NEM, municipality process). |
| `dd901a8` | Edge agents: run-triage (reads learn-run debug bundles, auto-applies safe fixes) + correction handling (closes the correction lifecycle; `/apply`, `/resolve`). |
| earlier | LLM cost cut (~10×/run), self-teaching digest topics, deterministic equipment pass v1, credential/portal-scope guards, upload naming, recording sweep. |

## Scale-readiness audit (Aug 2026) — what blocks a SECOND company

A workflow audit of the intake path against "multiple companies, multiple people,
multiple locations, CAD files, conditional SS stamps". Verdict: the system works
well as a **single-operator service bureau** and is not yet a multi-tenant product.

**Fixed in the intake-hardening commit** (the three that were live-data risks):

1. **Uploaded documents were on no backup path at all.** `runBackup` copied only
   the SQLite file and `litestream.yml` replicates only the DB, so a restore
   produced complete-looking projects whose every document 404'd. Backups now
   mirror `PROJECT_DOCS_DIR` into `BACKUP_DIR/documents/` (append-only, not pruned
   with snapshot rotation) and report document rows whose file has gone missing.
2. **CAD and other non-PDFs were accepted as a plan set.** No format validation
   existed anywhere on the upload path: a `.dwg` was stored, extracted to the
   "[no text layer]" marker, satisfied `planSetPresent()`, and then 500'd the
   splitter. Uploads are now sniffed by MAGIC BYTES (`fileTypes.ts`) — a renamed
   `.dwg` doesn't get through either — and refused with a message naming the fix.
   CAD is accepted under the `cad_source` doc type as reference material only.
3. **An uploaded sealed structural letter never reached the AHJ.** `PACKAGE_SETS`
   omitted `structural_letter` entirely, and the portal bot's generic `/structural/`
   label pattern grabbed the roof-framing SHEET for slots labelled "Structural
   engineering letter" — an AHJ rejection that looks like a successful upload.

**Tenancy — DONE (migration v11 + three commits).** `org_id` on the root tables,
entitlements replacing the single `edition` string, superadmin, role lockdown,
route scope guards, and `tenancy.test.ts` proving isolation over real HTTP. See
CLAUDE.md for the model and the conventions. What it fixed, verified in code:

- `matchProjectForEmail` loaded EVERY project when a source had no client set and
  fuzzy-matched inbound email against all of them — a cross-tenant WRITE (status
  checks, corrections, status transitions). Scope now comes from the source row.
- `PUT /api/users/:id` accepted `role` from anyone: any authenticated user could
  make themselves admin. Roles now need an admin actor from the session, nobody
  edits their own role, and only a superadmin grants superadmin.
- `GET /api/clients` returned every client id; `portal_credentials` is keyed only
  on client_id, so that was the route to another company's portal logins.
- `sseBroadcast` fanned every event to every socket, including
  `Permit issued for ${homeownerName}`. Now per-tenant, with unattributable
  events going to superadmins only.
- `getOrg` returned the DEFAULT org for any unknown id — a licence + data-scope
  escalation on a typo'd or stale org id.
- Admin-shaped routes (`/api/admin/*`, `/api/diagnostics`) had no role check.

**Tenancy follow-ups — CLOSED** (migration v12 + a second pass). Every route in
`routeScope.test.ts` is now accounted for with no TODOs left in the map:

- `childScopeGuard` joins through `project_id` for rows that carry no org of their
  own — mounted on `/api/corrections/:id` and `/api/portal-runs/:id`. Child tables
  deliberately have no `org_id`, so the join IS the scope check.
- `assertRefInScope` covers ids that arrive in a request BODY, where no mounted
  guard can reach them (`POST /api/communications`, `POST /api/jobs`).
- **Job queue fairness is fixed.** The claim was a straight global FIFO, so one
  tenant enqueueing a hundred jobs held every slot. It now orders by priority,
  then by the org with the least work IN FLIGHT, then age — a busy tenant can no
  longer starve a quiet one, without needing a worker per org.
- Signatures are per-org (v12), including "default for this role" — promoting one
  tenant's signature no longer demotes another's. Form fill takes the signature
  from the org that owns the PROJECT, since it runs from background jobs with no
  session.
- `/api/ops-actions`, `/api/ops-report`, `/api/jobs`, `/api/signatures` scoped.
- `/api/learn-runs` is admin-gated: portal debug bundles are operator artifacts.
- The startup KB backfill was `SELECT * FROM projects` unbounded on **every**
  boot. It now takes only projects with no backfill event, `KB_BACKFILL_BATCH`
  (default 500) at a time, and logs when it caps out. The work is idempotent, so
  the remainder is picked up on the next restart.
- **Corrected an inherited assumption**: batch import does NOT create projects or
  documents (no `createProject`/`saveProjectDocument` anywhere in
  `batchImport.ts`) — it only learns into the shared KB, so it needs no org stamp.

Still open, deliberately: `runDuePermitChecks` takes a global `LIMIT 50` per
sweep. Unlike the job queue this is a monitoring cadence rather than a work
queue, so a busy tenant delays checks rather than blocking work — worth
revisiting when project volume grows.
- **One `resolveStampRequirement(project, {codeContext, processProfile})`** →
  `{required, source, reason, waivable}` in `permitPath.ts`, read by all four
  consumers instead of each deciding separately, satisfiable only by a real file.
  123 of 381 AHJ rows already carry `requiresStructuralStamp` and nothing reads it.
- **Per-company defaults** (contractor license, CSLB/PE numbers, signature blocks,
  logo, portal accounts) — currently single-installer assumptions in several docs.
- **Document retention/deletion policy** — the backup mirror is append-only by
  design, which is correct for recovery but needs a stated policy before
  someone else's customer data lives in it.

## Production-readiness residuals (swept Aug 2026 — the fixed items are in the commit log)

Confirmed findings NOT yet fixed, in priority order (items fixed by the Aug 2026
outside-in assessment — re-record snapshot/restore, portal-job double-run guard,
correction-flow dead-end, stale pause pinning, SIGTERM drain — are recorded in
`docs/ASSESSMENT_2026-08.md`):

1. **deleteProject hard-deletes the project's audit trail** (`audit_logs` rows in
   the cascade). Consider `UPDATE audit_logs SET project_id = NULL` like
   permit_fee_history so approvals/submit records survive the project.
2. **parser.html / form-filler.html load CDN scripts with no SRI** on pages that
   handle homeowner PII. Vendor them like `frontend/vendor/lucide.min.js`.
3. **Server binds all interfaces with no HOST env** — fine behind the documented
   firewall+Caddy, but add `HOST=127.0.0.1` support for proxy-only deploys.

## Audited autonomy/intelligence backlog (from the 4-auditor review, ranked — full plan in the session workflow output)

DONE since: **scheduler last-run persistence** (migration v13 + `schedulerState.ts` —
the three long sweeps persist their clock, catch up ~60s after boot when overdue,
and a failed tick retries next day instead of waiting out the interval; state
visible in the `scheduler_state` table). **Gmail polling in the monitor tick**
(an authorized Gmail inbox is now watched every tick with a 1-day window; the
tracker's source-signature dedupe makes the overlap harmless). **Stamp authority** consolidated
(`resolveStampRequirement` in permitPath.ts — all four consumers agree; profile
hearsay is advisory, path/threshold block).

Still open, in order:

- **Structured outputs (rank 3, partially blocked)**: bump `@anthropic-ai/sdk` ^0.105 → latest and add `output_config.format json_schema` to parse-critical calls. CAVEAT the audit missed: `extractProjectFields.fields` and `mapAcroFormFields.textFields/checkboxes` are **Record-typed (dynamic keys)** — json_schema requires `additionalProperties:false`, so those need an array-of-entries redesign first. Closed-shape candidates that work today: `planPortalFields` (empty-plan stall killer), `mapFlatFormOverlay`, `verifyPortalFill`, `classifyCorrection`. Exclude every web-search call (citations are incompatible, 400).
- **Effort tuning on ask()** (classifiers to `low`, verify to `medium`) — validate against a learn run on opus-5 first.
- **Parallelize**: reviewer-gate vision verifies (~24 serial roundtrips), auto-learn text+vision verify pair, parser-page vision+text POSTs (apply in TODAY'S order: vision first), AHJ form acquisition passes + downloads (+ reuse field maps by PDF sha256 — never copy `map.verified`).
- **Plan-page vision extraction**: plumbing exists end-to-end (`kind:'plan_page'`) but the frontend never sends plan pages and the vision prompt doesn't describe them — biggest remaining accuracy lever for scanned plan sets.
- **Golden-test the parser→QC contract** (fixture payloads through QC/baseline/codeReview, exact finding IDs).
- **Quiet-failure escalation**: env-inbox poll failures, hung in-flight jobs, silent status-scrape degradation (counter + one-shot SSE/review item).
- **Segment A extras (env-gated)**: auto-acquire AHJ forms + build filled packet pre-gate; draft (never auto-send) client intake email on installer-field blockers.
- **Later/riskier**: Batches API for mbox/folder-scan (50% cost); retry transient prepare_submission (needs double-staging guard); typed RefusalError + server-side refusal fallbacks beta; structured outputs for reviewer vision verdicts.

## Open issues / next work (priority order)

**MEASURED, ONE BUILD, ONE SWEEP, UNCONTAMINATED: 335/352 = 95.2%** (2026-09-08,
`data/replay-benchmark/2026-09-08T05-20-25.json`).

| recipe | executed | values verified in the portal | not verified |
|---|---|---|---|
| PacifiCorp | 97/98 (99.0%) | 47 | 0 |
| Coos Bay structural | 47/49 (95.9%) | 27 | 0 |
| Coos Bay electrical | 53/62 (85.5%) | 30 | 1 (Category of Construction) |
| Ameren | 73/75 (97.3%) | 33 | 0 |
| PGE | 65/68 (95.6%) | 26 | 1 (Model) |

**163 values written and read back from live portals; 2 would not hold, both named.** The
per-portal profile fix below is the ENTIRE difference: the contaminated sweep of the same build
measured 263/352 = 74.7%, because Ameren inherited PacifiCorp's PowerClerk session and scored
2/75 instead of 73/75.

**What this number is and is not.** It is one sweep on one build — an accuracy measurement,
honestly taken. It is NOT a reliability figure: "95% of the time it has no issue with that
portal" needs the same build run N times per portal, which nobody has done yet. And the
verified count proves *what was written, landed* — it does not yet prove *everything the permit
requires is present*, which needs joining this count to the portal's own required-field set.

**THE RELIABILITY BUG, AND IT REACHES PRODUCTION (2026-09-07). READ THIS FIRST.**

Ameren scores **73/75 run alone and 2/75 run in a sweep, on the SAME build.** Identical
inputs, opposite outcomes, decided entirely by what ran before it.

The cause is profile sharing. Every utility portal for a client uses ONE browser profile:

```
backend/src/runReplayBenchmark.ts   profileBase/CLIENT/portalType        (fixed: now per host)
backend/src/repository.ts:4954,4983 profileBase/clientId/portalType      (PRODUCTION — unchanged)
```

PacifiCorp runs first, is also PowerClerk, and Ameren then inherits its session — PowerClerk
allows one session per account — so Ameren's terms checkbox is driven against someone else's
logged-in state and never toggles. **This is the "it just has an issue with that portal
sometimes" symptom, and it is contamination rather than a portal defect.**

**FIXED IN PRODUCTION TOO** (`portalProfileDir` in repository.ts, used at both staging sites).
Profiles are now keyed by HOST — what the session actually belongs to — so a real Ameren filing
that follows a PacifiCorp one no longer inherits its login.

**OPERATOR: THE FIRST RUN AGAINST EACH PORTAL AFTER THIS WILL LOG IN AGAIN.** That is
deliberate. Copying the old shared profile forward would carry exactly the cookies this
separates. A portal with MFA will pause for a human on that first run — the designed behaviour,
not a failure — and every run after it uses that portal's own stored session as before.
Reversible by restoring the old two-segment path if it causes trouble.

Verified against the change: full backend suite (260 checks) and `npm run smoke`.

**Any reliability claim must come from repeated runs of ONE build, and until production
profiles are scoped per portal, sequential runs are not independent measurements.**

**FIXED — the regression, and the fourth place two visibility notions disagreed (2026-09-07).**
Ameren is back to **73/75**. `usable` decides whether `check()` gets `force`, and it asked
PLAYWRIGHT's `isVisible`, which counts an `opacity:0` or 1x1 control as visible. A rounded-pill
switch's real `<input>` is exactly that: `usable` came back true, `force` was switched off, and
`check()` issued a real click that the styled widget swallows — "Clicking the checkbox did not
change its state". Everything else in the file had been moved onto `isTrulyVisible` earlier the
same day for this exact divergence; this one call was missed.

Three wrong guesses came first, all aimed at RESOLUTION, while the instrument said plainly that
the correct control was resolved and the click did not toggle. The rule written at the top of
this file hours earlier is the one I failed to apply to my own regression.

**THE HEADLINE NUMBER STILL STANDS AS MEASURED, NOT ASSEMBLED.**

**The last full frozen-build sweep measured 263/352 = 74.7%**, from a SINGLE sweep on ONE build. Earlier in
this file you will find 94.9% — that figure was assembled from each recipe's BEST run across
different builds and **was never a measurement**. The operator's framing is the right one: "if
I shoot it at a portal, 95% of the time it has no issue with that portal" is a RELIABILITY
rate — same build, same portal, many attempts — and nothing here measures it yet. Any future
claim must come from one frozen build, and ideally from repeated runs.

— taken BEFORE the Ameren fix above, so it understates the current state. **Re-run a full sweep
on one build before quoting any fleet figure.** The 94.9% that appears later in this file was
assembled from each recipe's best run across different builds and was never a measurement.


**"Replayed clean" was not evidence of anything (2026-09-07) — the sweep that finds blanks was blind.**
The first live replay benchmark scored PacifiCorp **`replayed_clean` — "every recorded step ran
and nothing was left blank"** — and the screenshot it saved of that page shows the portal
refusing the filing in red. Two required fields empty: the PV-array module select
("This field is required.") and "Total System Export (kW) *". The verdict was false, and it was
false in the direction that matters — it would have handed a reviewer an incomplete application
carrying a clean bill of health.

Three causes, all now fixed and all *general*, not PacifiCorp's:
- **A complaint in a row holding more than one control was discarded.** Attribution required a
  container with exactly ONE control (a bound added for a real reason: a bare div ancestor is
  the whole page on some layouts). "Qty [18] [Please select…]" is every equipment row there is.
  Now attributed by proximity — and **to the EMPTY control**, because "this field is required"
  cannot refer to a field that has a value. Pure proximity gave it to the filled Qty and the
  message evaporated; that is the bug, exactly.
- **An asterisk outside `<label for>` was invisible.** Requiredness read only `label[for=id]`,
  so a caption rendered as a plain div carried no requirement. Now reads wrapping labels,
  `aria-labelledby`, `aria-label`, and a single-control container's own text.
- **The page the run ENDS on was never swept.** The sweep is attached to *advancing* clicks, so
  the last page — the one handed to a human — was the one page never checked.
- **Floor under all three:** a visible complaint that cannot be attributed is reported anyway.
  Attribution is heuristic; the portal refusing the filing is not.

The logic moved out of `recipeAdapter` (private, untestable — which is why it stayed wrong) into
`portal-bot/src/requiredControlSweep.ts`, with `requiredSweep.dom.smoke.ts` driving that page's
real shapes in both directions. The false-positive cases carry equal weight: a sweep that cries
blank on a filled page teaches the operator to click past the warning.

**CORRECTION — THE DISAMBIGUATOR WAS IN THE RECIPE ALL ALONG (2026-09-07).**
An earlier note below says the information needed to tell PowerClerk's two "Model" selects
apart is not in the recipe. **That was wrong.** The learner records it on every such step:

```
inverterModel  fingerprint: { ariaLabel: "Model", section: "Inverter Clone System" }
moduleModel    fingerprint: { ariaLabel: "Model", section: "PV ArrayDelete Array" }
```

Written every time and read never — the duplicate-label selector rebuild constructs a fresh
object around the element id and drops the section. Replay now consults it when what it
resolved is unusable, using the learner's own section algorithm, and it **fires live**:
`"Model" resolved by SECTION "Inverter Clone System"`, with the array's Model separately
resolved by its own. No re-record needed; the recipes were fine.

**Two diagnostics were lying, and between them they cost most of a day:**
- `looksOutOfReach` asked Playwright, which calls an `opacity:0` control VISIBLE. Every rescue
  hanging off it stayed asleep. The acceptance gate had been corrected for exactly this one
  commit earlier — fixing one and not its sibling moved the blind spot rather than closing it.
- `describeResolved` **re-resolved the selector** instead of reporting the control acted on, so
  a step driven against the right control still printed the stale one. Four fixes were aimed
  at that phantom. A diagnostic that names a different element than the one used is worse than
  none, because it is believed.

**COOS BAY NOW FILES TO ITS OWN JURISDICTION (2026-09-07).** The benchmark hardcoded one
address for every portal, so Accela searched Coos Bay's parcel database for a SALEM address,
found nothing, and never revealed its Continue button. `AHJ_ADDRESSES` now maps a jurisdiction
to a **public civic address** (city halls — public record, and never a customer's home);
unmapped jurisdictions keep the default and report the same dead end honestly. I had put this
to the operator as something only they could supply — that was wrong. What was needed was an
address that EXISTS in the parcel database, not a customer's.

**COOS BAY: 1 -> 16 of 49 IN ONE SESSION.** Every fix a general invariant, none of them a
Coos Bay patch. In order, with what each one actually was:

| # | looked like | actually was |
|---|---|---|
| 1 | the Apply link had drifted | a **closed hover menu** whose trigger is `disabled` by design |
| 4 | a drifted street-number selector | a **strict-mode violation** — 1 match when narrowed, 4 when used; Accela paints that panel late |
| 7 | the address step failed | the **grid was scanned once** before the postback painted it, then returned false in silence |
| 13 | three later steps broke | **my own legend regex** — `"* indicates a required field"` read as a blank, so `pageIsPassThrough` refused a page needing only Continue |
| 16 | the advance was refused | **no job value** — `contractAmount` unset in the fixture, reported three steps after the field that caused it. Fixing it took the recipe to **46/49** |

**VERIFIED, AND IT WAS THE LAST BLOCKER ON THAT RECIPE: 16 -> 46 of 49 (93.9%), nothing
skipped.** The job value was the whole of it; the recipe then walked almost the entire
application. It stops on the **ATTACHMENTS page**: the upload, description, document type and Save all
execute, and the final Continue is refused with one required field still blank. That page
carries two selects — `ddlDocType` and `ddlAlsoAttachTo` — and the recipe's document-type step
is recorded as bare `{css: "select"}`, which matches both. Today's narrowing picks the first
visible one; whether that is the right one, and which of the two ACA is still waiting on, is
readable from `data/replay-runs/2026-09-08T01-17-24-pacific-power/step046-advance-Continue-Application-.html`.
A `data-test-role`-style selector here would end the ambiguity outright, which is what the
learn-side change now records for newly-learned recipes.

**AND THE PRECISE REASON IT IS STILL AMBIGUOUS, measured rather than guessed.** `narrowToOne`
now prefers the candidate whose own id/name matches the step's words — "attachment: document
type" against `ddlDocType`, bridging abbreviations like doc/document — but on this step it
never runs. The resolution trail says why:

```
level 0 css:select -> count 2, visible=true, enabled=true, ACCEPTED     <- two matches
(no narrowing line at all)                                             <- so it saw ONE
```

Between them sits `reanchorIfWrongControl`, which the identity check runs for select and fill
steps: it re-anchors to a SINGLE control — the first — so narrowing arrives with nothing left
to choose. **The word preference has to move into the re-anchor's own pick**, not sit after it. An attempt
at that did not land and IS REVERTED; what follows is what was actually established, kept
separate from what was merely inferred, because a confident wrong diagnosis is what cost this
session most of its hours.

**VERIFIED:**
- `reanchorIfWrongControl` judges `scoped.first()` and no other candidate, so a selector
  matching several controls is assessed on whichever comes first.
- Its whole-word comparison has a COMPACTED substring fallback, and recorded "attachment:
  document type" compacts to `attachmentdocumenttype` while the first control's label yields
  `attach` — a substring. That fallback exists for a real reason (ACA's "E-mail:" tokenizes to
  `mail` against a recorded `email`), so it cannot simply be deleted.
- `IDENTITY_STOPWORDS` contains **"type"**, with a comment naming THIS control: ACA labels the
  attachment-type select `*Type (Required):`. So the words available to any scan here are
  `{attachment, document}` — and every id on that page contains `Attachment_24Edit`, which
  means "attachment" agrees with everything and only "document" discriminates.

**FIXED, on the third attempt, and the way it was found is the point.** Two attempts fixed the
identity check and then the narrowing. Both run AFTER `resolveLocator`, and both were reasoned
about from their own source. A `console.error` at the CALL SITE settled it in one run:

```
[probe] identity check entered for "attachment: document type", count=1
```

**One.** `preferVisible` had already collapsed the two matches inside `resolveLocator`, so
every later stage saw a single control and neither fix could ever have run. The answer was on
the page the whole time — the step says "document type", the portal names its control
`ddlDocType` — and simply could not reach the place that chose.

`resolveLocator` and `preferVisible` now take the step's note, and when several visible
candidates match they are SCORED by how many of its words each answers, not taken in order:
every id on that page contains `Attachment_24Edit`, so "attachment" agrees with everything and
only "document" discriminates. ("type" is stopped by IDENTITY_STOPWORDS, with a comment naming
this very control — ACA labels it `*Type (Required):`.) A tie leaves the old positional answer
alone, and a note agreeing with nothing still skips rather than guessing.

`bareSelector.dom.smoke.ts` holds the shape. Verified: 35/35 recipe-adapter, multiArray (15),
fillHeld, requiredBlank, sectionDisambiguation.

**AND IT DID NOT MOVE COOS BAY.** Measured immediately after landing: still 46/49, one blank,
nothing skipped, same refused advance — and the "took #N" line never fired, so the document-type
step **is not ambiguous on the live page**. The two-select shape came from a saved page at a
different moment; at the moment that step runs there is evidently one. The fix is a correct
general invariant and it is not this portal's blocker.

**Third wrong cause inferred for this one step** (compaction fallback, then the identity check,
then the bare selector). The one blank on that page is the thing to identify — read
`data/replay-runs/<latest>/step046-advance-Continue-Application-.html` and find which required
control is empty, rather than reasoning forward from the selector again.

**The lesson, third time today:** when a fix does not change the outcome, do not read its
source again — prove it executes. Two attempts debugged a body that never ran.

A working fix therefore needs the candidate scan to run BEFORE the compaction fallback and to
score by how many recorded words each candidate answers, not by first agreement — every id on
that page contains `Attachment_24Edit`, so weak agreement is universal there. Scenario for the
smoke: two selects, `ddlAlsoAttachTo` first and `ddlDocType` second, step noted "attachment:
document type"; correct outcome is the SECOND selected and the first untouched, with the
existing skip-rather-than-guess behaviour preserved when a note agrees with nothing.
A smoke written against the post-narrowing path passes its behavioural assertions and never
exercises the code, which is why it is not in the tree: the scenario is here instead. Two
selects, `ddlAlsoAttachTo` first and `ddlDocType` second, a step noted "attachment: document
type", and the correct outcome is the SECOND one selected and the first untouched.

**The 62-step Coos Bay recipe is now 9/62** (was 4), and fails somewhere genuinely different:
`Record type "Residential - Electrical" is not offered`. That is the record-type guard working
as designed — it refuses to check a type the portal does not list rather than guessing one —
so the question is which record type this recipe should be filing under, not a defect.

**THE 49-STEP RECIPE'S REMAINING BLOCKER, established from the saved page.** It reaches the
attachments page with ZERO blanks and the Continue is refused. The reason is visible in the
markup: `ctl00_PlaceHolderMain_Attachment_24Edit_btnSave` is **DISABLED**, while a second,
enabled `ctl00_PlaceHolderMain_actionBarBottom_btnSave` sits on the same page. ACA enables the
dialog's Save only once the attachment's metadata is complete, so the upload is never
committed and Continue is correctly refused.

**Narrowed further, from the same page.** The document-type control is NOT an editable
`<select>` there: 14 `ddlDocType` id references and **no `<select>` element at all**, where an
earlier capture of that step showed a real `<select name="...ddlDocType" onchange=...>`. So at
the moment Continue is clicked the attachment's editor row is **not in an editable state** —
which is exactly why its Save is disabled, and why filling the document type cannot be the
missing action.

The file IS uploaded ("ZZTEST"/".pdf" appear), so the upload succeeded and the row never
entered — or has already left — edit mode. The question is therefore about SEQUENCE, not about
any one control: what puts that row into edit mode, and did the recipe's steps run before it
was ready or after it closed? Compare the earlier capture (editor open, real select present)
with this one (closed) to find which step moves between the two.

Ruled out: "the document type is unset so Save stays disabled" — there is no control to set.
Still open: whether the recipe's Save step resolves to the page-level Save rather than the
dialog's, since the enabled-control preference added today would steer a `name:"Save"` lookup
away from the disabled dialog button. Correct in general; worth confirming here.

**COOS BAY REACHES 47 of 49 — 95.9% — AND IS FUNCTIONALLY COMPLETE.** The last false blank was
mine: Oregon ePermitting's attachment page says "Please note: Plan review is required for some
services", which matched `is required` and was counted as an empty required field — and
because `pageIsPassThrough` shares that sweep, it also jammed the click-through (five separate
"left the page unchanged" warnings in the run before). Excluded now as advisory prose.

The two steps that remain unexecuted are **not defects**:

| step | what it is |
|---|---|
| 47 `human-patch: 187-26-000309-STR` | a link recorded against a LITERAL record number from the learn session. It cannot exist on a new application — an un-replayable artifact, and arguably should never have been recorded. |
| 48 `final submit: Continue Application »` | the final submit. Automation never clicks it; that is the system's first hard rule. |

So the recipe files everything it can: **47/48 = 97.9%** of the steps a replay is permitted to
execute. The `human-patch` step is the one thing worth removing — a learn-side guard against
recording a control whose name is a record identifier would prevent the whole class.

**THE FIFTH RECIPE WAS FILING IN THE WRONG JURISDICTION.** Oregon ePermitting lists an address
under several VERSIONS — City Applications, County Applications — and which record types are
offered depends on the one chosen. Coos Bay's structural recipe ranks to City and finds
"Residential - Structural"; its electrical sibling wants "Residential - Electrical", which the
City version does not list at all (verified from the saved record-type page: seven types
offered, none electrical). Oregon issues electrical permits at COUNTY level.

Both ranked identically because the ranker's electrical test read `fieldValues.permitType`
(unset on the benchmark project) and the step note (which says only "address version") —
never `recipe.discipline`, the field the learn stored for exactly this purpose:

```
49-step  discipline "structural"  -> address version: City Applications
62-step  discipline "electrical"  -> address version: COUNTY APPLICATIONS
```

**9/62 -> 15/62**, past the record-type wall. Then the two blanks it reported turned out to be
the fixture's own: the structural recipe binds `contractAmount` and a literal scope of work,
the electrical one binds `jobValue` and `description`. **A learn records whatever the planner
chose that day, so the benchmark project has to answer to every spelling or it measures its
own omissions.** Supplying both: **15/62 -> 46/62.**

Both Coos Bay recipes now execute 46 steps with nothing skipped and stop at the same wall — an
advance the portal refuses. The 62-step still shows one blank, `*Other Category of
Construction:`, a conditional field whose own step (index 39) ran earlier and reported success
— so it was filled and then went blank, which is a re-render rather than a missing value.

A re-assert pass now runs before each advancing click: any blank required control the recipe
holds a step for is re-run once (bounded to three, re-entry guarded). **It works:**

```
"Category of Construction:"        was filled earlier and had gone blank — re-asserted
"*Other Category of Construction:" was filled earlier and had gone blank — re-asserted
```

**46/62 -> 53/62, and BOTH Coos Bay recipes now carry ZERO blank required fields.**

**AND THE 62-STEP RECIPE HAS REACHED THE FEE GATE.** Its failure is now
`page drift: only 0 of 5 recorded fields for this section ("CVV:", ...)` — **CVV**. It is on
the PAYMENT page. The remaining nine steps are a credit-card form and the submit, the two
things automation must never do (hard safety rule #1). That recipe is FUNCTIONALLY COMPLETE at
53 of 62: it files everything a machine is permitted to file and stops exactly where a human
has to take over.

This is the structural ceiling, measured rather than asserted. The fleet's remaining gap is not
defects — it is card forms, MFA and CAPTCHA, which is why 95% "across random portals" is a
property of the portal set and not of this code.

**FLEET AFTER THE DAY'S WORK:** PacifiCorp 97/98 (99.0%), Ameren 73/75 (97.3%), PGE 65/68
(95.6%), Coos Bay 46/49 (93.9%) and **53/62 (85.5%)** — a fleet mean of **334/352 = 94.9%**,
from two recipes dead at step one this morning. Both Coos Bay recipes carry zero blanks, and
the 62-step one stops at a credit-card form. Four of five recipes at or about 95%; the fifth
moved from dead-at-step-1 to a third of the way through, and its remaining blocker is an
advance the portal refuses with two named blanks — read them from the saved page.

**THE RULE THIS SESSION PAID FOR, FIVE TIMES OVER.** Today produced five silent
`return false` paths and four diagnostics that described something other than the thing being
acted on (`looksOutOfReach` asking Playwright, `describeResolved` re-resolving the selector,
`visibleOptionSample` scraping the page, the address grid saying nothing). **Every one made a
working component look broken, and every fix aimed at the apparent failure was aimed at a
phantom.** When a failure line does not change across several fixes, suspect the line. When a
step is skipped, suspect the step BEFORE the one that failed.

**Superseded — Coos Bay was at 7 of 49** (from 1 at the start of the session), and the next blocker is
characterised. Two fixes got it past step 4:

- **A strict-mode violation is a timing artefact, not a dead recipe.** The street number
  resolved to ONE element when the step narrowed it and FOUR by the time the fill ran —
  Accela renders that address panel asynchronously. Every narrowing branch reported nothing
  because none of them was wrong. Ambiguity is now retryable (settling, not reloading).
- **Four matches is proof the control is there.** The retry then died on the absence guard,
  which stops retrying when the step's label is not on the page — sound in general, exactly
  wrong straight after a violation that can only occur when several of the thing matched.

**Next:** step 8 waits for "Continue Application". With a valid in-jurisdiction parcel the
`divContinueButton` container **no longer carries `display:none`** — real progress — but it is
still empty, and "Available Service Group" beside it is empty too. Accela populates both once
an address search RESULT is selected, so the flow likely needs the result row picked before
Continue exists. The page is saved at `data/replay-failures/step008-work-location-continue.html`;
answer it there rather than with another run.

**Superseded — was failing at step 4** on a strict-mode violation: `input[id*='StreetNo4Search']` matches
four elements (the box, its hidden watermark state, and a range's "To"), and `narrowToOne`
should have reduced that. It reported nothing, and the one branch through that function which
returns silently is the "nothing was visible and enabled" fallback — now instrumented, along
with the count-failure path. **The next run says which branch it took instead of costing
another guess.** Note the learner fills this box with `.first()` (autoLearnAdapter:2317) and
RECORDS it without one (:2382), so the ambiguity is baked into the step; recording `.first()`
semantics, or the `data-test-role`, would remove it at the source.

**POWERCLERK NAMES ITS CONTROLS — USE THAT (2026-09-07).** The page a select-miss saves
carries 91 `data-test-role` attributes, including exactly the disambiguators a day was spent
inventing substitutes for:

```
inverter-model-select          pv-array-model-select
inverter-manufacturer-select   pv-array-manufacturer-select
inverter-quantity              pv-array-quantity
add-array-btn  add-inverter-btn  delete-array  inverter-div  pv-array-div
```

Stable across renders and unambiguous about side — everything `#pcInputBase34` and a bare
label of "Model" are not. Replay now tries them first when a control is out of reach, matching
the tokens of the step's FIELD name against `data-test-role`/`data-testid`/`data-test-id`, so
any portal shipping such hooks benefits: `inverterModel` becomes `["inverter","model"]`, which
matches `inverter-model-select` and cannot match `pv-array-model-select`. **Confirmed live.**

**DONE on the LEARN side too.** When a label is duplicated, the recorder used to pin the step
to the first css fallback — the element id. Those are per-render tokens: `#pcInputBase34`
pointed at a different, concealed control on the next project, and the replayed step spent
months resolving it. It now prefers a `data-test*` hook whenever the element carries one, and
drops the occurrence pin with it, because an ordinal recorded against one render is a guess
about the next. **New recipes will record `[data-test-role="inverter-model-select"]` where the
old ones recorded `#pcInputBase34`** — the volatile-id rot behind most of this session's replay
failures cannot recur. Existing recipes are unchanged and do not need re-recording: replay
finds the hook at run time. Verified: 32/32 auto-learn, including the PowerClerk bare-label
case.

**PGE's `Schedule` was a fixture guess.** Its own dropdown offers exactly `"Select..."` and
`"7"` — PGE's residential rate schedule is Schedule 7, so `"Residential"` could never land.
Visible only once the option sample was scoped to the control instead of the whole page.
PGE is now **65/68, one blank** (Energy Storage, correctly skipped — no battery).

**Still open on PGE:** the inverter `Model` resolves correctly by test hook and still lands
nothing, because the markup shows its container carrying `style="display: none;"` — the block
is not rendered at that moment. That is a page-flow question (does it need the Add Inverter
step first?), not a resolution one, and the saved page is the place to answer it.

**A THIRD DIAGNOSTIC WAS LYING, in the very layer named as next to investigate.**
`visibleOptionSample()` queried the WHOLE DOCUMENT — every `[role=option]`, every
`select option`, anywhere on the page. So a miss on PGE's inverter Model reported
`13 option(s) were showing, list offers "a. Solar", "b. Wind", "c. Hydro"`, which are Energy
Source values from a different widget entirely, and read as though the Model dropdown held
them. It now samples the control's OWN options — a native select's, or the listbox a combobox
owns via `aria-controls`/`aria-owns` — and when it cannot tie a list to the control it says
so in those words rather than quietly showing the page's.

Three diagnostics, all describing something other than the thing being acted on:
`looksOutOfReach` (asked Playwright), `describeResolved` (re-resolved the selector), and this
one (sampled the page). Between them they cost most of a day and four fixes aimed at a
phantom. **When a failure line will not change across several fixes, suspect the line.**

**Still open on PGE:** `Model` resolves correctly by section now and the select still lands
nothing against 13 options. That is the option-matching layer, not resolution — a different
question, and the next one to instrument. `Schedule` remains bare-label ambiguity with no
section recorded.

**STOP RULE OBSERVED ON THE `Model` STEP (2026-09-07).** Four fixes were shipped at PGE's
inverter `Model` — an enabled check, a no-fallback fall-through, an unpinned ordinal twin, and
a corrected visibility gate — and the diagnostic never moved once:
`resolved <input id="pcInputBase34" label="Model" visible=false>`, 64/68 every time.

The fourth found a REAL bug worth keeping: Playwright counts `opacity:0` and `1x1` controls as
visible while our own diagnostic calls them hidden, so the acceptance gate had been saying yes
to controls its own report called concealed — which made the three earlier rescues unreachable
code in general. `visibilityAgreement.dom.smoke.ts` proves the divergence and now locks it.
It was not this step's cause.

**An identical failure signature after four different fixes means the fixes are not on the
executed path.** Do not ship a fifth variant. Instrument the decision instead: add a per-level
line to `resolveLocator` — `level N <selector> -> count, visible, enabled, accepted/rejected` —
and read it from one scorecard. That converts the question from a guess into a sentence, and
it is the move that cracked Coos Bay in one run after six of guessing.

The likeliest answer remains the one below: `#pcInputBase34` is a volatile per-render id whose
label is the BARE, repeated "Model", and the step carries no `section`. The information needed
to choose correctly is not in the recipe.

**THE LAST REPLAY DEFECT IS RECIPE QUALITY, NOT THE ENGINE (2026-09-07).** PGE and PacifiCorp
both fail their inverter `Model` step, and PGE also fails `Schedule`. The warnings name the
cause exactly, and it is the same on both:

```
select "Schedule" -> resolved <select label="Schedule" options=2 visible=true>
                     list offers "New Contact", "Preparer", "Applicant (PGE Customer)"...
select "Model"    -> resolved <input  label="Model"    visible=false>
                     list offers "Select...", "a. Solar", "b. Wind", "c. Hydro"...
```

Neither resolved the control it wanted: one landed on a contact-role dropdown, the other on
an invisible node while an Energy Source list was open. These are PowerClerk spec-page
controls whose labels are BARE and repeated — "Manufacturer", "Model", "Schedule" appear
several times per page — and CLAUDE.md already records that the side comes from
`field.section`. **These recorded steps carry no section**, so no amount of resolution
cleverness can pick correctly among identical labels; the information simply is not in the
recipe.

The fix is on the LEARN side — capture `section` when recording a spec-page control — plus a
re-record of the affected recipes. Everything reachable without that has now been done:
resolution rejects hidden and disabled matches, narrows multi-matches, opens closed menus,
strips icon ligatures, and dismisses stale popups. Do not re-record blindly to chase this:
the rest of these recipes is demonstrably healthy (PacifiCorp 97/98, nothing blank).

**REPLAY FLEET — measured after the day's fixes (2026-09-07, second full sweep).**

| portal | rung | executed | blanks | owner | what is left |
|---|---|---|---|---|---|
| PacifiCorp (PowerClerk) | 3 | **97/98** | **0** | recipe | only warnings: an upload slot re-anchored, a popup that would not close, `Calculate` inert |
| Ameren (PowerClerk) | 3 | 73/75 | 7 | **data** | project has no Email/Phone/Street for this filing |
| PGE (PowerClerk) | 3 | 63/68 | 3 | recipe | `Model` and one policy default do not land |
| Coos Bay ×2 (Accela) | 2 | 4/49, 4/62 | 0 | recipe | blocked on the FIXTURE's address — see below |

PacifiCorp files essentially completely: 97 of 98 steps, nothing required left blank, the
one unexecuted step being the final submit automation must never click. It is held at rung 3
by warnings it is right to raise, and it cannot reach rung 5 while the review screen reads
4 fields and confirms 0 — the run is not reaching a summary page.

**A regression this session, found and fixed:** the multi-match narrowing took Ameren from
73 steps to 2. Its terms control is `<input role="switch">`, a styled toggle whose real input
is hidden behind a span, and the check branch already handled that with `force`. Narrowing to
the first VISIBLE match defeated it. `check`/`uncheck` now keep the locator they were given.
A general fix walking into the one place that was specific for a reason.

**COOS BAY: 1 → 4 → 7 of 49 steps in one session, every fix an engine invariant (2026-09-07).**
Six live runs to find the first blocker; after that a failing step keeps the page HTML and
each further blocker was diagnosed offline in seconds. In order:

1. **The entry was a closed menu.** Fixed — see below.
2. **A selector that names four things.** `input[id*='StreetNo4Search']` matches the street
   box, its hidden watermark state, and a range's "Street Number To". Playwright refuses a
   multi-match action as a "strict mode violation", which reads like drift and is not. Replay
   now picks the first visible+enabled itself, at the action site.
3. **NEXT, and it is the FIXTURE, not the engine.** Step 8 waits for "Continue Application";
   the captured page shows `<div id="divContinueButton" style="display: none;"></div>` and an
   empty "Available Service Group". Accela only reveals Continue once the address search
   returns a match — and the benchmark files **1847 Liberty St SE, Salem** into **Coos Bay's**
   portal. A Salem address has no parcel there, so the search returns nothing and the flow
   cannot proceed. The AHJ recipes need an address inside their own jurisdiction; the fixture
   currently hardcodes one for every portal. Needs a real Coos Bay address from the operator —
   do not invent one, an unmatched address fails identically.

**FIXED — Coos Bay's "Apply" was behind a closed menu (2026-09-07).**
Both Coos Bay recipes die on step 1, a 30s timeout on `click — application entry: Apply`.
Five live runs narrowed it; the sixth captured the page, and the answer is a grep:

```html
<a href="/OREGON/Cap/CapApplyDisclaimer.aspx?module=Building">Apply for Building Permit</a>
```

The recipe records a click on **"Apply"**. The real control reads **"Apply for Building
Permit"** and sits inside a dropdown whose trigger is `<button disabled class="dropbtn1">`
carrying the bare word "Apply" — so every selector level lands on the disabled trigger, and
the name-based recovery correctly reports "no enabled control … containing Apply" because the
menu item is hidden until the menu opens. **Present but shut**, exactly as
`revealHidden.ts` was built for, one level up: the container is a menu rather than a field.

The fix is to let the recovery consider hidden candidates and reveal them — open the menu
whose trigger matches, then click the item — rather than requiring visibility up front. It
needs no live run to build: `data/replay-failures/step001-application-entry-Apply.html` is the
page. Do NOT re-record these recipes; the rest of both is untested but unimplicated.

Landed on the way, all verified and all general:
- **Visible is not enough to accept a selector level — it must be ENABLED.** One match plus
  visible was accepted, so replay spent 30s on a button that can never be clicked.
- **Icon ligatures pollute accessible names.** Material Icons render as text, so this portal's
  links read "check_circleApply", "searchSearch", "eventSchedule". Name matching now strips a
  lowercase ligature run glued to a capitalised label.
- **A failing step now keeps the page HTML**, not just a screenshot and a label list. That is
  what turned this from live runs into a grep.

**FIXED — a popup left open by one step shadowed the next (2026-09-07).** Replay contained no
`Escape` at all; the learner contains nine. The Model select below resolved an *invisible*
control and read the Energy Source list because an earlier widget's list was still open over
it. `dismissStaleOverlays()` now fires when a control is out of reach **or** an open popup does
not CONTAIN the target — containment, not visibility, because an occluded input is still
visible by CSS, and because a recipe may legitimately record "open the dropdown" then "choose
the option" with the option inside the list. `staleOverlay.dom.smoke.ts` drives both
directions and was confirmed to fail without the guard.

**PREVIOUS DIAGNOSIS (kept — the section gap is real, but was not the whole story).**
After the fixture was filled out, the live run reached 92 of 98 steps with zero healed
selectors and zero steps that failed to land except one, and the drift warning names it
exactly:

```
select "Model" landed nothing though 49 option(s) were showing
  wanted   "IQ8PLUS-72-2-US {240V}"
  resolved <input id="pcInputBase55" label="Model" visible=false>
  list offers "Select...", "Solar PV", "Solar PV and Battery", "Wind", "Hydro", "Battery Only"
```

It resolved an **invisible** control and read the **Energy Source** list. This is the hazard
CLAUDE.md already documents — PowerClerk's spec-page labels are bare "Manufacturer"/"Model"
and the side comes from `field.section` — and steps 85/86/88/89 on this recipe carry **no
section at all**, so the bare label resolves ambiguously. Fixing it means either re-recording
with section captured, or inferring the section at replay from the surrounding block. Do not
re-record blindly: the rest of the recipe is demonstrably healthy.

Also still open on this portal: `click "compute totals: Calculate" left the page unchanged`,
which is downstream of the array rows the Model miss leaves incomplete.

**Automation quality is now a KPI, computed from runs that already happened (2026-09-07).**
Every existing KPI is a business outcome — cycle days, corrections, SLA. None of them notices
a filing staged with three required boxes empty, because a person quietly fills them in and
the permit still lands on time. That cost was invisible: PacifiCorp's missing meter photo was
found by an operator looking at the live portal, not by anything the run reported.

No new instrumentation was needed. `portal_runs.result_json` has always stored the whole run
result, and the replay report lives in `steps[].data` inside it, so `getStagingQuality()` reads
history. On the current database, over 94 staging runs:

| | |
|---|---|
| staged clean | **22.6%** (7 of 31 readable runs) |
| verified against the portal's review screen | 0% — the check only landed today, so no historical run carries it |
| runs that left work for a person | 18 |
| avg required fields left blank | 1.4 |
| most frequent gaps | Name ×6, Address ×6, Email ×6, AC-disconnect question ×4, Battery fields ×3 |
| drifting recipes | Pacific Power ×13, Coos Bay ×4, PGE ×5 |

63 of the 94 runs carry no readable report and are **excluded rather than counted as clean** —
the same rule as the replay ladder, for the same reason. `mergeStepReport` is shared with the
benchmark so a lab score and a production score cannot come to mean different things, and a
filing the review screen CONTRADICTS is not clean here either: the benchmark says DO NOT SUBMIT
about that run, and a headline calling it clean would contradict it about the same filing.

**Read the adapter's report off the STEP, not the result (2026-09-07) — harness trap #5.**
`ok(message, data)` returns `{ok, message, data}`, and `runAdapter` hands back
`{ok, …, steps}`. So `executed`, `skipped`, `requiredStillEmpty`, `driftWarnings`,
`reviewFieldsSeen` and `reviewMismatches` all live in **`steps[].data`**. `runReplayBenchmark`
read them off the top-level result and got zero for every one — a live run that filled eight
pages of PacifiCorp scored "executed: 0, no blanks, no warnings, review unreadable" and the
benchmark called it clean. Same mistake as the already-documented "failure message lives on
the failing step", one field over.

That makes five harness bugs in this one runner (raw DB row instead of `getPortalRecipe`;
re-queried project instead of `createProject().project`; bare `{headless}` with no credential
or userDataDir; message read off the result; report read off the result). **Every one
presented as a portal or recipe defect, and every one was ours.** When a replay verdict looks
like the recipe has rotted, suspect the harness first — the recipe has been fine all along.

The scorer now refuses that shape too: `ok:true` with `executed: 0` against a recipe that has
steps is `measured: false`, the mirror of the existing silent-failure guard. "Nothing happened"
and "everything happened correctly" were both scoring 4.

**Typing was not saving, and a fill could not tell the difference (2026-09-07).**
`case "fill"` returned `true` the moment `.fill()` resolved — success meant "we typed", never
"it stuck" — and it walked away from the autosave its own blur had just started. Two lines
below, `case "select"` does the opposite: it waits for that autosave and returns its honest
result, with a comment explaining that skipping the wait lets a server re-render restore the
old value. Same file, same page, opposite discipline. That asymmetry is why replay reported
success on PacifiCorp's "Total System Export (kW)" while the portal's own screenshot shows the
box empty with a required error beneath it.

Fills now wait for the autosave, read the value back, retry once, and return **false** on a
genuine miss — which lands the step in `skipped`, visible to the operator and a gap to the
benchmark, instead of a clean run over a lost value. `fillHeld` is deliberately lenient,
because the false-miss direction is the expensive one: a phone becoming "(503) 555-0142", a
decimal padded 7.2 → 7.20, and a date reordered 2026-10-01 → 10/01/2026 are all rewrites, not
losses. `fillHeld.dom.smoke.ts` drives one wiped field against three reformatting ones and
asserts **exactly one** report.

**Instructional text is not a validation error.** The complaint floor above initially matched
`please (select|enter|choose)`, which is as often the caption above a checkbox group as it is a
refusal — and a false entry there both demotes a benchmark run and blocks `pageIsPassThrough`,
stopping a working replay. Soft phrasings now need an error signal (alert role, error-ish
class, or red text); hard ones ("required", "cannot be blank") stand alone. The negative case
failed before the fix, so the risk was live rather than theoretical.

**Replay verification writes its evidence down.** A review screen the scraper cannot read now
saves page HTML, text and a full-page screenshot to `data/replay-review-misses/` — the first
unreadable one cost a live run to diagnose and told us nothing about the markup.


**Illinois live status (2026-09-01) — measured, not inferred.**
Verify with `npm run portal:audit -- <login-url> --app=<application-url>`; a learn writes the
application URL onto the recipe as `[application:...]`, because auditing "the newest matching
row" twice opened the WRONG draft and reported a stale application as the run's.

*Ameren Illinois (PowerClerk)* — audited state of the learned application:
**35 fields filled, 4 documents attached, and only 3 genuinely-blank required fields**
(Email, Phone, Street). The audit now separates the three kinds of empty-but-required control,
because lumping them together cried wolf — it reported "6 required blank" when half were
correct as they stood:
- **binds at replay (2)**: Account Number from Bill, Meter Number. Blank ON PURPOSE. Sensitive
  fields are never stored in a recipe; `applyFill` types nothing and records a bound step that
  resolves at replay. Confirm these at replay, never in a learn audit.
- **unticked is the answer (1)**: "This is a public school project" is a CHECKBOX, not a radio
  (which is also why POLICY_RADIO_DEFAULTS never fired on it). We are not a public school, so
  leaving it off is the right answer. Only acknowledgment/certification boxes must be ticked.
- **really blank (3)**: Email and Phone had no source — the `projects` table has no email or
  phone column and the parser snapshot carried neither, so `homeownerEmail`/`homeownerPhone`
  resolved to "". Test values are now in both IL test projects' `parser_json`. Do NOT "fix"
  this by falling back to the installer's contact: the APPLICANT is the customer, and
  substituting the solar company there would file real applications under the wrong person.
- **Street is the one real engine gap left.** `street` resolves fine ("800 E Monroe St"), yet
  Ameren's step-1 applicant address (`address-line1-element`) stays empty — a second address
  block beyond the Distributed Generation Facility Address that was already fixed. Start here.

Docket Number is FIXED (client field, migration v15) and the Electrical Contractor
name/company/address now fill. Recipe stays `recording`; do not promote it — the gate refuses
a recipe carrying a blank-required finding, and overriding it once produced a replay that
faithfully reproduced an incomplete application.

The 5 remaining empty upload slots are all correctly empty: Volt Var Settings Picture,
Installation Invoice and Proof of Insurance are documents we do not hold (and
`uploadForbidsSubstitute` refuses to put a substitute in them), and "Additional
Documents"/"Additional Attachment Field" are generic catch-alls.

*ComEd (Intellio Connect / ConnectTheGrid)* — **still creates nothing.** The list reads "No
applications were found" after every run, confirming the operator's observation that no draft
is being saved. Measured cause: the "+" FAB opens a New Application drawer that contains ZERO
input fields — it is purely a type picker (Distributed Generation / Distributed Generation
Rebates) whose only forward control is labelled **Submit**. The planner will never nominate a
submit-shaped control (rule 1), so the run reaches the drawer and stops with no advance.
- `clickCreateDialogAdvance` now supplies that advance under a five-part conjunction (overlay
  only, entry-originated, create-intent heading, no filing/certification language, never
  pay/fee), recorded as a plain advance and never `isFinalSubmit`. Pinned by
  `createDialog.dom.smoke.ts`, and it fires correctly on the REAL drawer (verified: the
  detector returns `Submit`).
- **NOT yet proven end-to-end**: clicking that Submit on the live portal was blocked as an
  outward-facing action, so nobody has yet observed what it produces. A drawer with no inputs
  cannot file an application, but the confirming evidence is one click away: run
  `npx tsx probe-comed-drawer.tmp.ts --submit` (needs operator approval) and check whether the
  list gains a row and the real application form opens. Do that before trusting a ComEd learn.
- Separately, the ComEd planner is unreliable on the list page — across two runs it chose to
  navigate rather than fill, returning `fills=0`, and once "produced no actionable plan". The
  drawer fix does not address that.

*Three naming fixes came out of this and generalise beyond Illinois*: an icon ligature
("add"), a hover tooltip ("New Application"), and a framework-generated id
("mat-button-toggle-group-2") each hid a control's human meaning.

*Upload counting was wrong and is now fixed*: PowerClerk removes the file input once a file is
attached, so counting `input[type=file]` counted only the slots still waiting and reported
"0/6 attached" on a form holding 3 documents. `attachmentScan.ts` finds the attachment itself,
keyed on the REMOVE control (a blank-template download link also sits inside upload UI, so
proximity to upload UI proves nothing). That, in turn, exposed a real miss: Ameren reveals the
PV-module data sheet slot only after the equipment selects cascade, so the single upload pass
ran too early. The learn now re-runs the pass whenever new slot LABELS appear — new labels,
not a bigger count, since attaching a file removes its input.

*Still untested*: a BATTERY project (energy-storage fields never appear on a non-battery
job) and multi-array NEM.


**Illinois is LIVE: Ameren records AND replays (2026-08-31).** Credentials for both IL
utilities are stored encrypted under `tml-international-llc`. Ameren Illinois (PowerClerk)
was learned end-to-end — a 61-step recipe covering terms, application level/type, applicant,
account number, installer, generator specs (AC/DC size, inverter make/model/count,
commissioning date), acknowledgements and the DocuSign email — and it **replays 60/61 steps
in 149s with zero failures, stopping at review**; the skipped step is the recorded final
submit, never clicked. Verified against the PORTAL, not the log: the account holds two
complete Level 1 applications (Testerson/Test, 7.68 kW AC, TML INTERNATIONAL LLC, $50 fee),
one from the learn and one from the replay.
- The learn's own verifier could not promote the recipe because it looks for a review screen
  to scrape and PowerClerk's project list is not shaped like one. Promotion was done only
  after reading the portal back, recorded in the audit as such. **If a portal never yields a
  scrapeable review screen, expect this every time** — the recipe is fine, the verifier just
  cannot see it.
- **ComEd (Intellio Connect) logs in but is not yet learned.** Its dashboard is icon-only
  (Material icons, no text labels), so the text-based entry finder finds nothing — that is
  the documented limit for an icon-only UI, and the first ComEd learn will need the planner
  to find the way in.
- **CLEANUP OWED on the Ameren account: 7 projects, all Unsubmitted.** Two are the real
  learn/replay applications; the rest are empty shells, because every click of "New
  Interconnection Application" creates a project and each diagnostic run clicked it. Worth
  clearing by hand.


**Scaling to a team (5-20 concurrent portal runs) — plan in `docs/SCALE_DEPLOYMENT.md`.**
A six-part audit (2026-08-31) found the concurrency hazards are almost all CROSS-PROCESS, so
with employees on the dashboard and all automation in the one server process they never arm.
The real limit is much smaller: `drainPendingJobs` is a SERIAL drain (one job at a time), so
step one is a bounded worker pool inside the single process. Parallelism then arms four
things that must ship with it: a per-`(clientId, portalType)` queue (the Chromium profile is
a single-holder OS lock), an orphan-browser reaper (match `chrome-headless-shell.exe`, not
just `chrome.exe`), a run-level watchdog (a learn hung 13+ min silently on 2026-08-31), and
backups of `portal-profiles/` (NOT currently backed up — those directories are the live
portal logins). Two races fire even single-process because they span an `await`: recipe
recording's wipe/verify window, and the AHJ form-template refresh discarding an operator's
`map.verified` edit. `SESSION_ENCRYPTION_KEY` doubles as the cookie secret and has no rekey
tool — rotating it is unrecoverable. Postgres is NOT the blocker (better-sqlite3 sits behind
one wrapper file, SQL is near-dialect-free); the expensive part would be going async.


**Multi-state operator portal logins imported 2026-08-31 (`import:portal-processes`).**
A solar company hands over one "Permit Processes" workbook per engagement: a sheet per
state listing every AHJ permit portal, its software, the login, security-question
answers, and whether the portal emails a one-time code. Built `npm run
import:portal-processes -- <file.xlsx> [--client=<id>] [--dry-run]`
(`backend/src/portalProcessImport.ts` = the pure extractor, unit-tested; the CLI loads
`dotenv` because credential storage needs `SESSION_ENCRYPTION_KEY`). It scans every row
(the sheets have NO consistent schema), pulls URL + platform (inferred from host) +
login + password + security answers + an MFA-email-code marker, and emits two things,
kept strictly apart: (1) an **encrypted credential** via `createPortalCredential` —
extended so security answers ride in the encrypted envelope, never the LLM-visible
`notes`; (2) a **seeded AHJ knowledge row** (platform, MFA marker, contact — NO secrets).
First real import of Infinity Solar USA's workbook: **81 credentials under
`tml-international-llc`** (dba now set to "Infinity Solar USA") across Accela (12),
OpenGov (8), SmartGov (6), EnerGov (5), Citizenserve/BS&A (3 each), eTRAKiT, DC Access,
Momentum, Cloudpermit… and **87 AHJ knowledge rows across 20 states** (MD/FL/WA/OR
heaviest). Verified: creds decrypt and resolve via `getDecryptedCredentialByUrl`,
security answers round-trip. `UTILITY_PLATFORM_HOSTS` gained the PA/NY/NJ utility
domains + ConnectTheGrid/customerapplication.com interconnection platforms found in the
workbook (pinned in `portalUrlScope.test.ts`).
- **9 portals are email-code MFA** ("they send a code") — flagged HUMAN-CAPTURE in the
  KB. We can't read `permit@infinitysolarusa.com` during automation *yet*: a Gmail OAuth
  pipeline (`gmail.ts`) and an IMAP poller (`emailPoller.ts`, "central TML inbox") exist
  but aren't wired to this address — wiring one would let the bot fetch login codes and
  unblock those portals. Until then they stop at the code prompt.
- **6 credentials defaulted the username** to `permit@infinitysolarusa.com` (password
  present in the sheet, no explicit user) — correct for this operator but re-verify if a
  login fails.
- These are AHJ **permit** portals on platform families we mostly have NOT learned yet
  (EnerGov CSS, ViewPoint/OpenGov, SmartGov, Citizenserve, BS&A, eTRAKiT…). Reaching a
  review page on each needs a learn on a real in-jurisdiction project.

**Reachability sweep (live, 2026-08-31) → a universal login fix.** Pointed the bot's OWN
login path (`performLogin` in `loginFlow.ts`) at real portals to find where it fails on
unfamiliar platforms. Two results:
- **Anne Arundel County (Accela, real credential): logged in cleanly** → reached the
  authenticated navigator with "Create an Application" per module. Proves the whole path
  (resolve stored cred → universal engine login → application entry) end-to-end on a real
  portal, no planset required. A true pre-submit REVIEW page still needs a synthetic
  in-jurisdiction project (address that passes parcel validation) — that's the next step.
- **eTRAKiT (Shoreline): exposed a silent false-success bug, now fixed.** The engine used
  to treat "no `type=password` field found" as `already_authenticated` and would "learn" a
  page it was never signed in to. eTRAKiT's password box is a Telerik `type=text` RadTextBox
  labelled only by a sibling "Password:" cell. Fixed generically (commit "Make the universal
  login flow honest…"): password detection by attribute/label/placeholder + an adjacent-label
  scan for table-layout ASP.NET portals; `already_authenticated` now requires a POSITIVE
  logout signal; otherwise the new `login_form_unrecognized` status tells the caller to
  record/learn the portal instead of proceeding. Pinned by `loginForm.dom.smoke.ts`.
- **Do NOT bulk-drive all ~11 families' logins unattended** — they're a real company's
  production gov accounts (lockout risk), and first login from a new machine often triggers
  a device-verification email we can't read yet. One attempt per portal; drive the rest
  when the operator can watch or when the inbox-code path is wired.

**Stress sweep across nine platform families (2026-08-31) — `npm run portal:reach`.**
New command: `npm run portal:reach -- <url> [--enter] [--headed]`. It drives the ENGINE'S
own paths (`performLogin` + `findApplicationEntryDeep`) and holds no portal-specific logic,
so what it exercises is what production uses. Point it at any portal to see how far the bot
gets. Results after the fixes below:

| Portal (family) | Login | Application entry |
|---|---|---|
| Anne Arundel (Accela) | logged in | **found "Create an Application" one hop via Permits, and `--enter` lands on `CapApplyDisclaimer.aspx?module=Permits` — the real application start** |
| Prince George's (Momentum) | logged in *(was: form not found)* | none on the dashboard (reported honestly) |
| Gainesville (Citizenserve) | logged in *(was: no_submit_control)* | none found |
| Lynn (SmartGov) | logged in | none on landing |
| Quincy (OpenGov) | reaches + submits the form *(was: form not found)*; credential rejected | — |
| Hialeah (EnerGov CSS) | SSO hand-off, unresolved | — |
| Sterling Heights (BS&A) | reCAPTCHA — correctly stops for a human | — |
| Shoreline (eTRAKiT) | form detected, credential rejected (no real account) | — |
| Tukwila (eTRAKiT) | ERR_CONNECTION_RESET (host blocks us) | — |

Five GENERIC login gaps found live and fixed (`loginFlow.ts`, pinned by
`loginForm.dom.smoke.ts`, 11 shapes): a hidden responsive DUPLICATE field masking the real
one (`firstVisible` tested only `.first()` — the widest-reaching fix); identifier-first
two-step logins; an SSO hand-off behind a stale "Login" link that reveal kept re-clicking;
an unrecognisable submit control (Enter-key fallback); and a form painted after networkidle.
`applicationEntry.ts` (pinned by `applicationEntry.dom.smoke.ts`, 13 shapes) finds the
"start an application" control across vendors, follows one module hop, opens a collapsed
hamburger nav — and REFUSES to click anything touching the operator's real filings (Resume,
Pay Fees, Search, Renew, Upload), returning nothing rather than a least-bad click.
- **Importer correctness caught by the same sweep**: credentials had been stored under the
  JURISDICTION'S address (building@gainesvillefl.gov) because the first email on a row won.
  The operator's own domain now wins, `.gov`/`.us` is a contact never a login, and
  re-import is an UPSERT keyed by portal URL (re-ran: 81 credentials, no duplicates, zero
  .gov logins). `updatePortalCredential` no longer discards security answers on rotation.
- **Acting on a transitional page was its own bug.** Called straight after login, the entry
  search ran mid-redirect: a transitional page has almost no links, which read as "sparse
  home with a collapsed menu", and the recovery then navigated a logged-in session BACK to
  Login.aspx and dead-ended on a blank page. `findApplicationEntryDeep` now settles first
  and never returns to a login URL — that made the Accela hop reproducible (it had worked
  once, then stopped). Watch for this shape anywhere the engine acts right after a nav.
- **Still open**: EnerGov's Tyler-Identity SSO hand-off; Quincy OpenGov credential looks
  wrong/unregistered; Momentum + SmartGov + Citizenserve post-login homes surface no apply
  control (may need an account with apply rights, or a direct apply URL per tenant). AACO's
  own account only offers "Create an Application" under Complaints/Violations — permits may
  not be filable online for this account, which is a real operator question.

**Illinois market entry — researched + KB-seeded 2026-08-30, waiting on logins.**
Deep research (7 agents, verifier-checked) is written up in `docs/IL_ONBOARDING.md`;
41 KB rows seeded through the sanctioned import helpers (all `seeded`, sourceLabel
"IL deep research (web, 2026-08-30)"; source of record: workflow journal
`wf_cf106f03-b45/journal.jsonl` in the session dir). Verified ready for the bot:
operator short names resolve through `findKnowledgeForLearn` ("Ameren"→Ameren Illinois
PowerClerk URL, "ComEd"→interconnect.comed.com, "Chicago"→ipi.cityofchicago.org, 12/12
AHJ spot-checks; Ameren@MO correctly no-match), and `UTILITY_PLATFORM_HOSTS` now knows
comed.com/ameren.com/exeloncorp.com (+ rockymountainpower.net for Utah) so a permit
track can never launch an IL utility portal (`portalUrlScope.test.ts` extended).
Headline: **Ameren Illinois = PowerClerk** (our proven platform — expect same-day
learn+replay once logins + one real IL project exist); **ComEd = Intellio Connect,
NOT PowerClerk** (new platform, first-encounter learn; simpler Level 1 form, no
drawings). When logins arrive: store credentials per client for both portal URLs, do a
read-only landing-shape look first, Ameren first, then ComEd. Licensing gates before
any REAL submission: ICC DG Installer cert, municipal electrical license/registration
(no statewide IL electrical license), Illinois Shines AV/Designee. Ameren pays the $50
Level 1 fee by MAILED CHECK (no online payment — operator step), uses DocuSign
(human-capture), 10-digit account number digits-only.

**Multi-array: FIXED 2026-08-30, needs a live confirmation.** Replay now repeats the
recorded array block once per roof plane, adding a row and verifying the page gained one
before filling it. Two guards make it safe: the add must be CONFIRMED (each PV Array
carries its own "Delete Array", so rows are countable) and repeat passes target the Nth
rendered control, because the recorded selector points at array 1. When no row can be
added the run says "filed array 1 only (10 of 24 modules). REVIEW BEFORE SUBMIT." instead
of understating in silence. Covered by `multiArray.dom.smoke.ts` (mutation-checked).
Still to do: watch one live PGE run on Bren Trask (4 arrays) and confirm four rows.

**PGE's option text formatting is NOT the cause of the model skip (checked 2026-08-30).**
PGE lists options as `430W (Model Q.TRON BLK M-G2.C1+/AC)` while the certified name is
`Q.TRON BLK M-G2.C1+/AC 430`, and neither contains the other — so this looked like the
cause. It is not: `bestOptionMatch`'s digit-signature fallback (written for
`UHLD108`/`UHLDD108`) already requires the alpha token plus every digit group, which this
shape satisfies. Proven by `optionFormat.dom.smoke.ts`, which picks the right option and
rejects both a wrong-wattage sibling and a same-wattage different-series decoy. The skip
has some other cause; `048e940` added a diagnostic that reports, on a miss, whether any
option list was open and what it offered. Get that from the next live run before touching
any matcher.

**A killed run wedges that portal profile.** Stopping a replay leaves its Chromium
holding the persistent profile, and the next run dies instantly with "profile is already
in use by another instance of Chromium". Matters for the 200-project capacity plan: any
crashed job blocks that portal until something clears the lock.

**The session drivers bypass the demotion path.** `live-nem-replay.ts` calls the adapter
directly, so a failed replay does NOT mark the recipe `needs_rerecord` or queue a
re-learn — that lives in `repository.ts`. Verified: `de2ebb91` stayed `complete` through
two hard failures. Do not read "the system notices a broken recipe on its own" as tested.


0d. **THREE-PORTAL LEARN + CROSS-HOMEOWNER REPLAY (2026-08-29, live).** Each
   portal learned on one homeowner, then replayed against a DIFFERENT one.

   | Portal | Learn | Replay | Result |
   |---|---|---|---|
   | PacifiCorp | Edgar Miner, Lincoln City | Kristi Hofer, Hood River | ok=true, 93/100 steps, skips all explained |
   | PGE | Bren Trask, Portland | Abby Johnson, Happy Valley | 0 failures, 65 steps, 2 explained skips |
   | Accela | Wynema Wright, Coos Bay (trusted, HIGH conf) | Kristi Hofer, Hood River | BLOCKED at step 1 |

   **Both NEM portals now replay onto a homeowner they have never seen.** The
   remaining skips are a conditional question the portal did not ask, missing
   meter/account data that comes off a bill, and the intentional final-submit
   stop.

   **ACCELA IS BLOCKED BY AN ENTRY-NAVIGATION ASYMMETRY — not staleness, and not
   the cross-jurisdiction question.** A FRESH v7 learn records
   "navigate to application: Building Dept Application" as its first nav and
   reaches it fine. Replay lands on `Dashboard.aspx` instead, whose nav is
   Apply / Building / Licensing / Planning, and that link is not there. The
   difference is SESSION STATE: replay reuses the persistent authenticated
   profile and gets the logged-in dashboard; the learner reaches the entry page
   that lists the applications. Do not chase this as portal drift — two live runs
   (stale v6 and fresh v7) fail identically, which rules drift out.

   **THE CROSS-JURISDICTION QUESTION IS STILL OPEN**, and it is the one with real
   money attached. Oregon ePermitting is ONE portal serving ~100 jurisdictions,
   and the Coos Bay recipe does NOT hardcode its city — it types the project's own
   `streetNumber` and `streetNameSearchPortion` into the portal's address search
   and picks the matching row. If that generalises, one learn covers every
   ePermitting city; if not, each city needs its own ~6-minute learn. Every AHJ
   except Coos Bay currently resolves to "NONE — would need its own learn". The
   run never reached the address search, so this remains untested. The risk to
   watch when it does run: `click work location: select city/structural address
   row` is positional, and a city whose search returns several rows could file
   against the wrong parcel.

   Drivers: `live-nem-learn.ts`, `live-nem-replay.ts` (both take a projectId and
   `--recipe <id>`), `live-accela-learn.ts`, `live-accela-replay.ts`,
   `verify-recipe.ts` (preconditions before trusting a replay result).

0c. **REPLAY DESYNC — diagnosed, guarded (2026-08-29). Read this before touching
   replay.** Everything below 0b that reads like a selector problem was a
   NAVIGATION problem. Root cause, from live PacifiCorp runs:

   A blocked "Next" is not a failed click. The button is there, the click lands,
   and the portal refuses because a required field is blank. Replay took that as
   success, ran the NEXT page's steps against the page it was still on, and every
   recorded id resolved onto whatever unrelated control happened to occupy it —
   59 steps executed and 6 skipped past the desync before anything noticed.
   `waitForInteractiveControls` cannot catch it: it is page-global and
   identity-free, so a page that never moved satisfies it instantly.

   **Two guards now exist, in this order.** (a) `assertAdvanced` in
   `recipeAdapter.ts` — compares page IDENTITY (heading + on-screen control ids)
   before/after a click and, when the page did not move AND the portal is showing
   inline validation errors, fails with the portal's own words. (b)
   `precheckPageDrift` stops below 15% label overlap (was: only at zero, so two
   incidental "Name"/"Email" hits suppressed it). (a) catches it at the click;
   (b) is the backstop.

   **Do NOT "fix" these by making them stricter.** Requiring every click to move
   the page broke the Accela replay smoke instantly — "Calculate", "Add Array",
   "Add New" contact and saves all legitimately leave the page unchanged. A block
   requires positive evidence (the portal complaining). And do not use the
   learner's `pageFingerprint` here: it includes body text length, so a
   validation message appearing reads as "the page changed".

   **Known hole:** `expectedLabelsForSegment` counts only fill/select steps, so an
   upload-only segment has zero expected labels and `precheckPageDrift` skips
   entirely (`expected.length < 3`). Guard (a) is independent of label count and
   covers it, but be aware when reading an upload-page failure.

   **Standing rule this session earned twice:** verify a navigation actually
   happened. A diagnostic probe hit the identical bug from the other side — an
   announcement modal ate every click and it sat on one page for 14 iterations.
   Anything that clicks to advance must confirm the page moved.

   **The `__name` trap, third occurrence:** a function declared INSIDE
   `page.evaluate` is wrapped by esbuild's keepNames as `__name(fn,…)`, throws in
   the page, and the surrounding `.catch` turns it into "found nothing". Declare
   no functions inside an evaluate. `openPortal` installs the shim
   (`browser.ts` ~51); a raw `chromium.launch()` harness must add it itself.

0b. **FIRST LIVE REPLAYS RUN (2026-08-29). READ THE CAVEATS — an earlier version
   of this entry overstated the result.** PacifiCorp reached review once
   (ok=true, 4.2 min, nothing submitted) — the deterministic path, no planner
   calls, on a real portal. It has NOT reproduced since across four attempts
   (later runs fail at the uploads with 4 skipped steps, and take 15 min rather
   than 4). The "0 skipped" originally reported for that run was a DRIVER BUG,
   not a measurement: the adapter returns its counters on the step result that
   carries them, which on a clean run is an ok step, and the driver only read
   failing ones. So that run reached review with an UNKNOWN number of blank
   fields. Fixed in live-nem-replay.ts; any future claim must come from a run
   after that fix.

   **Two recipe defects behind the PacifiCorp skips, both deterministic (not
   timing).** Steps 53 and 59 of 6282e671 are `select` steps recorded with an
   EMPTY value: 53 binds `field: descriptionOfService`, which is not a key
   resolveRecipeFieldValues produces, so it resolves to ""; 59 carries neither a
   field nor a value. resolveValue returns "" and the step returns false, so
   they can NEVER fill, on any run. Worth a guard at LEARN time: a select
   recorded with no value and no resolvable field binding is not a replayable
   step and should either be dropped or block promotion. Gap-fill was ruled out
   as a cause by an isolation run (`--no-gapfill`): identical 4 skips without it.

   **PGE does NOT yet replay.** It reaches step 47 of 68 and one skipped step
   cascades into a failure at 55. Root cause is identified with page evidence
   (`data/screenshots/replay-fail-step047-*.png`): the recorded inverter Model
   step resolves to `<input id="pcInputBase34" label="Model" visible=false>` —
   the right control by label, but the HIDDEN half of the widget. This project
   renders PowerClerk's COMBINED make+model spec template (one "Please
   select..." per repeater row, flagged "This field is required"), while the
   recipe records the SEPARATE Manufacturer/Model template. Both exist in the
   DOM, so the recipe drives the hidden one — which is also why the manufacturer
   selects report success while the visible dropdowns stay empty, every capacity
   reads 0.00 kW, and the wizard then branches away from the recorded path.

   Ruled out, each by a live run: re-learning (produces the same steps and
   promotes to trusted/HIGH confidence, so the learner does not see the
   problem); waiting for the cascade; re-resolving the locator after the wait;
   preferring a visible fallback over a hidden primary; and enabling the
   production LLM gap-fill planner (`buildPortalPlanner`), which the replay
   driver now supplies exactly as `repository.ts` does.

   **The bounded next step**: the learner fills that page with
   `fillEquipmentSelects` (autoLearnAdapter.ts:1145) — a DETERMINISTIC pass that
   matches by section+label context, inherits side by proximity and tolerates
   duplicate/bare labels. It is learner-only, and what it does is not expressible
   as the recorded steps it produces, so replay cannot reproduce it. Expose it to
   RecipeAdapter as a fallback when an equipment step is skipped (the same shape
   as the `dismissPageModals` extraction in this session). It couples to five
   instance members — `applyFill`, `currentControlValue`, `debug`,
   `equipmentFillFailed`, `equipmentValueFor` — so it is an extraction, not a
   move. `powerClerkSpecs.dom.smoke.ts` already covers the pass.

   **Confirmed downstream**: the step-55 disconnect radio is not drift. At LEARN
   time that page reads Total Inverter Capacity 7.80 kW and renders a "Disconnect
   Requirements" section (a disconnect is only required above 7.2 kW for 240V
   single phase); on REPLAY the capacities are 0.00 kW because the equipment page
   never filled, PGE renders no Disconnect section, and the recorded radio
   genuinely does not exist. ONE root cause, everything else is consequence.

   **What a live PGE stage does TODAY (this is a regression, own it).** Recipe
   replay is FIRST-LINE (repository.ts ~5190); hand-coded adapters are the
   fallback only when NO recipe exists. 481c00f4 is complete+trusted, so a real
   PGE stage now routes into the replay that fails. It is not a dead end — a
   "recipe step failed" result marks the recipe needs_rerecord and queues a
   relearn, so the NEXT stage self-seeds through the learner and reaches review —
   but that relearn re-promotes the same recipe to trusted/high-confidence, so it
   OSCILLATES: fail, demote, learn, promote, fail. Before today the legal-name
   key had no complete recipe at all and every stage self-seeded, which worked.
   Interim options: (a) demote 481c00f4 AND set PORTAL_REPLAY_SELFTEST=1 so the
   next learn cannot re-promote a recipe whose replay is broken (costs one extra
   deletable draft per learn) — demoting alone just restarts the oscillation; or
   (b) do the fillEquipmentSelects extraction. PacifiCorp replays either way.

   **Policy question this raises**: the trust gate promotes on LEARN-time
   verification alone. PGE is proof a recipe can be trusted at high confidence
   and still never replay. PORTAL_REPLAY_SELFTEST=1 exists and would have caught
   it — worth making it the default for a newly learned portal.

   Drivers: `live-nem-replay.ts <pge|pacificorp>` (deterministic replay, no
   bookkeeping) and `live-nem-learn.ts <pge|pacificorp>`.

0a. **NEM portal caveats the operator must know (2026-08-29).**
   (a) The trusted **PacifiCorp** recipe FREEZES answers that are only constant
   for a standard OWNED, ROOFTOP residential system: `Wattsmart Battery Program
   → No`, `Customer-Owned` (not third-party), `Roof Mounting`, `Tracking →
   Fixed`, plus the switchgear / parallel-blocking / multi-customer questions.
   A **battery**, **TPO/lease**, or **ground-mount** project will replay those
   WRONG. The human at the review screen is the backstop, but they only catch it
   if they know to look — the learner now lists these as "Kept as portal
   constant(s)" in the recipe's issues, so read that list before the first
   non-standard project. PGE's five frozen literals are genuinely universal
   (Residential / a. Solar / Photovoltaic / Static Inverter / Fixed).
   (b) **No live REPLAY has been run yet** on either recipe. The four
   real-browser smokes verify replay mechanics on synthetic recipes, not these
   68/99-step recipes against the live portals. Either run one watched replay
   (it files another draft with real data), or treat the first production NEM
   stage as the watched replay — it is guided-manual with a human at review
   either way.
   (c) **Cleanup owed on real utility accounts**: the watched runs left roughly
   two draft PGE applications (Daniel Daly) and two draft PacifiCorp
   applications (Wynema Wright), plus the browsers parked at the review screen.
   Delete the drafts in each portal when convenient — nothing was submitted and
   no fee was paid.
   (d) `live-nem-learn.ts` and `live-accela-learn.ts` are session drivers kept on
   purpose (they are how a watched live run is launched). They hard-code project
   ids; update them before reuse.

0. **Known low-severity residuals from the specs-fix review** (accepted, documented):
   (a) after the equipment pass fills a dup-labeled PV "Model", a same-labeled
   non-PV field revealed LATER is hidden from the planner's rescan filter
   (alreadyFilledLabels is bare-label keyed at ~line 1965) — fix by keying that
   filter on section+label if it ever bites; (b) on a fully sectionless page, a
   bare unlabeled Manufacturer/Model within 3 fields of PV fields (and not
   matching the negative guard) can still inherit the PV side — the proximity
   bound + guard-reset make this narrow.
1. **✅ VERIFIED + FIXED LIVE (2026-08-26/27, operator's machine)** — the
   specs-page stall was reproduced and fixed against the REAL PGE + PacifiCorp
   portals. Both utilities now stage end-to-end through the app path (learner):
   PGE all 4 equipment picks held (Altenergy Power System / DS3-L / Znshine
   PV-Tech / 440W ZXM7), PacifiCorp both picks held first pass on its different
   layout. Root causes, all fixed in PRODUCTION code:
   (a) live make/model are READONLY `input[role=combobox]` Vue filtered-selects —
       classified as text, `.fill()` threw, value silently dropped → classifier
       upgrade in `autoLearnAdapter.ts` (inputs only) + `selectWithFallback` tag
       gate;
   (b) the open-click is a TOGGLE and Escape doesn't close the popper — a second
       open closed it → `aria-expanded`-aware open (stale-attribute tolerant);
   (c) `optionScope`'s last-visible-popup heuristic read a SIBLING widget's
       lingering popper → own-popup scoping via `aria-controls`;
   (d) the Enter fallback committed the highlighted first row when nothing
       matched (picked "AblyTek"/"Solar Long PV-Tech" wrongly) → Enter is
       suppressed whenever visible option rows exist; trailing-token fallback
       now requires a digit-bearing token;
   (e) certified lists respell models (plan "ZXM7-UHLD108-440/N" vs certified
       "ZXM7-UHLDD108-440/N") → digit-signature matching (all digit groups +
       alpha prefix) in BOTH `bestOptionMatch` and the learner's
       `equipmentValueMatches` verify;
   (f) typed search filters that match nothing empty the list (popper shows a
       "no results" row) → clear-search retry after a best-match miss;
   (g) `bestOptionMatch` scanned only 40 rows; certified lists run to 225+ →
       single-`evaluateAll` full-list scan.
   Regression net: `portal:test:specs:combobox`
   (`powerClerkSpecsCombobox.dom.smoke.ts`) recreates the LIVE readonly-combobox
   widget (captured DOM) and runs the learner's real fill path against it.
   Also fixed: `PowerClerkAdapter` login (pathname-based success check; form
   selectors), intro-page acknowledgment checkbox, preparer/applicant
   placeholder-named fills with per-field blur-commit + held verification,
   portal-aware login URL threading (`StageOptions.loginUrl` → `startUrl`) so
   PacifiCorp never lands on the hardcoded PGE URL.
   **Remaining on this front:**
   (i) MULTI-ARRAY: the learner fills array 1 only — `pvArrays` per-array data
       never reaches it (autoLearn.ts seeds flat equipment only). Feature: pass
       pvArrays through, click "Add Array" per missing block, fill by ordinal.
       Until then the human completes arrays 2/3 at review.
   (ii) RECIPE KEY MISS: recipes match by exact profile key; a project with
        utility "Portland General Electric" missed the complete `or|unknown|pge`
        recipe (key uses the short name) and re-learned instead of replaying.
        Consider normalizing utility names into profile keys.
   (iii) The old read-only probe (`portal:probe:specs`) remains for future
        portal-shape checks; run headed from the operator's machine only, per
        `docs/research/GOLIVE_OPS_LEGAL_2026-07.md`.
   (iv) CLEANUP OWED: several unsubmitted PGE test drafts + one PacifiCorp
        test draft under the operator account (never submitted — delete from
        the portals); Daniel Daly test project cf1c56aa in the app DB; the
        operator planned a PowerClerk password rotation.
   (v) ACCELA (Oregon ePermitting) — CORRECTED READING of the 2026-08-27 bundles,
        then fixed (2026-08-26 session). What the earlier note called "reaches
        CapDetail" was actually DRIFT: no Salem run ever legitimately passed
        WorkLocation. Screenshot p003-after (run yq98) shows the planner left
        Street Number EMPTY (the control is an unlabeled from/to range pair named
        ctl00$PlaceHolderMain$WorkLocationEdit$txtStreetNo4Search$ChildControl0/1
        — that string is the NAME attr; the extractor's label falls back to it)
        and its "Search" click resolved to the HEADER-NAV Search tab, landing in
        the records/search module: CapHome.aspx = "Applications & Permits" list +
        General Search (with live "Resume Application"/"Pay Fees Due" links on the
        operator's real account), CapDetail.aspx = an EXISTING record's detail.
        The record-type selection page has NEVER been captured live.
        FIXED THIS SESSION (autoLearnAdapter.ts, all unit-tested):
        - accelaWorkLocationPass rewritten on the live-verified hooks from the
          hand-coded adapter: StreetNo4Search/txtStreetName id selectors, the
          PANEL search button only (id$='_btnSearch' under ctl00_PlaceHolderMain —
          never a bare role "Search"), core-street-name parsing reused from
          oregonEPermitting.ts (now exported), a 3-char retry on "Address Not
          Found", jurisdiction row Select links (COUNTY=electrical, CITY=
          structural, narrowed by city), and Continue only if still on
          WorkLocation (row select can auto-advance).
        - NEW accelaDisclaimerPass (termAccept + Continue, no LLM call) and
          accelaRecordTypePass (solar/PV type preferred, else the discipline's
          "Residential - Electrical/Structural"; triggers only when a
          residential-discipline checkbox/radio exists).
        - NEW wrong-module guard: on CapHome/CapDetail with the module's own
          control names (generalSearchForm/gdvPermitList/addForDetailPage/
          attachmentEdit), goto the derived …/Cap/CapApplyDisclaimer.aspx?module=
          Building (bounded at 2 re-entries) BEFORE the planner can touch real
          records. "Resume Application"/"Pay Fees Due" are now off-limits
          everywhere (isOffLimitsButton).
        - Deterministic ACA revisits no longer consume the stuck/cycle recovery
          budget (acaDeterministicAhead exemption).
        STILL OPEN: the record-type page and everything past it are UNSEEN live —
        the deterministic record-type pass is built from the hand-coded adapter's
        codegen, so the next live Salem learn run must verify: (a) address search
        returns rows and the Select-link shape matches; (b) the record-type page
        triggers the pass (check aca_record_type_pass in events.jsonl); (c) the
        wizard pages after it (project info → contacts → construction details)
        are within the planner's reach — the hand-coded fillApplication encodes
        the full field knowledge if a deterministic pass is needed there too.
        DISPATCH (previous "deep finding") — RESOLVED as designed: isRealPortal
        already falls back to hasLaunchablePortal (KB/recipe entry URL) and the
        platform is sniffed from portal_url, so the learner launches for Salem;
        the hand-coded adapters remain the PORTAL_AUTOSEED=0 legacy fallback.
        ALSO FIXED EARLIER (production): entry-disclaimer never review (structural
        + planner overrides); no-revisit navigate guard; trust-gate promotion
        floor (min 3 pages / 5 fills — a 2-page "review" promoted an EMPTY Salem
        recipe, since demoted to needs_rerecord); checkbox scrape reported "on"
        for unchecked boxes (phantom verifier contradictions); alt-billing
        checkbox deterministic refusal; derived exportLimiting answer; platform
        sniffed from KB portal_url when portal_platform is empty (Salem rows
        backfilled). Segment A reporting is now honest: runAutopilotSegmentA
        checks the portal_runs row after prepareSubmission (segmentAOutcomeFromRun,
        backend/test/autopilotStageOutcome.test.ts) and reports failed/paused
        stages as blocked instead of "complete". CRITICAL COMPANION FIX (caught
        by adversarial review of that change): maybeResumeAutopilot resumes on
        ANY blocked result, so the new stage_failed/paused_for_human outcomes
        would have let every clearing event (client assign, doc upload, payment,
        public intake) silently relaunch live browser runs — those two codes are
        now excluded from auto-resume (gates still resume; test-pinned), and the
        jobQueue SSE keeps MFA pauses as warning-severity run_paused, not
        run_failed.
        REPLAY HARDENING (same review round): the work-location fills are now
        BOUND (field: streetNumber/streetNameCore, resolved by the new shared
        portal-bot/src/addressParse.ts in backend resolveRecipeFieldValues) so a
        shared recipe replays THAT project's address, never the learn project's
        literals; the recorded Select step bakes in the CITY/COUNTY row context
        (a bare role "Select" replays as .first() = wrong jurisdiction); recorded
        selectors keep the full learn-time union breadth; iframe ACA builds get
        selector.frame stamped and frame-scoped results/continue handling; the
        disclaimer pass records steps only on a VERIFIED advance (no duplicate
        accept/continue pairs); and the entry-disclaimer review-guard exclusion
        is now run-scoped (any recorded mutation this RUN re-arms the structural
        review guard — it was vacuously true on every terms-bearing page,
        including true review screens).
        WINDOWS DEV BOX: backend tests now pass on Windows — AppDb.close() +
        close-before-delete in scratch-DB tests, spawn node+tsx directly (npx is
        not spawnable on win32), await server exit before temp cleanup, and
        fileURLToPath for the golden fixtures path (C:\C:\ ENOENT).
        SECOND REVIEW ROUND (post-fix verify, all five confirmed + fixed): the
        entry-disclaimer exclusion ignores terms-acknowledgment checks (the agree
        box recorded ON the disclaimer armed the "something filled" signal after
        one blocked advance, flipping the T&C page into a forced review stop);
        c2a' converts the planner's bogus disclaimer "final submit" into the
        page's ADVANCE (it used to leave an isFinalSubmit step pointing at the
        entry Continue — a poisoned auto-submit allowlist entry); every ACA pass
        now records steps only on VERIFIED actions (no duplicate pairs when the
        planner retakes a page); a learn that needed the 3-char street-name
        retry binds streetNameSearchPortion instead of streetNameCore (replay
        has no retry of its own); and a DISCIPLINE GATE in prepareSubmission
        (recipeDisciplineFromSteps/disciplineConflictsWithTrack in
        portalChannel.ts) refuses to replay an electrical-learned recipe for a
        building track and vice versa — the baked COUNTY/CITY row + record-type
        clicks would file under the wrong authority SILENTLY.
        RESOLVED (migration v14, `recipe_discipline`): AHJ recipes are now keyed
        state|ahj|utility PER DISCIPLINE. `portal_recipes` gained a `discipline`
        column ('' | structural | electrical | combo) and the UNIQUE index moved
        from `profile_key` to `(profile_key, discipline)` — the old single-column
        index was a standalone INDEX, not a table constraint, so no rebuild was
        needed. v14 backfills existing rows from the deterministic passes' own
        recorded notes (`county/electrical` / `city/structural` / the record-type
        note) before swapping the index. Track → discipline lives in ONE place:
        `recipeDisciplineForTrack` (portalChannel.ts) — building→structural,
        electrical→electrical, mpu→electrical (a service upgrade files as an
        electrical permit), combo→combo, nem/untracked→''.
        Lookups (`findCompleteRecipeForProject` / `findAnyRecipeForProject`) take
        a discipline, prefer an exact match, and still accept a LEGACY '' row so
        existing recipes keep replaying. `startPortalRecording` claims this
        discipline's own row (adopting a legacy row in place), so an electrical
        learn no longer resets the structural recipe — and the learn path's
        protect-complete lookup is discipline-scoped too, which was the other
        half of the ceiling (unscoped, an electrical learn saw the structural
        recipe, "preserved" it, and silently discarded its own pass).
        THE ACTUAL UNLOCK: when a legacy '' recipe turns out to have been learned
        for the OTHER discipline, prepareSubmission now DROPS it (recipe = null)
        instead of refusing the stage, so the dispatch falls through to the
        universal learner and this discipline seeds its own recipe. Refusing left
        the second discipline able to neither replay nor self-seed. The old
        conflict gate stays as defence-in-depth. Pinned by
        backend/test/recipeDiscipline.test.ts (7 checks incl. the v14 replay).
        STILL OPEN for the electrical track end-to-end: autopilot itself only
        drives ONE track (the UI sends no track and the pre-stage status guard
        refuses the project once the first track stages), the county filing
        AUTHORITY exists only inside the two Playwright passes (tracking and
        labelling still attribute the electrical record to the city), and an
        untracked stage on a separate-permit AHJ records permit_type='permit'
        and shows on no track.
        LIVE RUN SESSION (2026-08-27, ten runs against Coos Bay — a REAL Oregon
        ePermitting jurisdiction; **Salem is NOT on Accela**, it runs its own
        portal, so the earlier Salem runs were never going to resolve an address.
        The Salem KB rows had their Accela URL cleared; Coos Bay's AHJ row now
        carries the verified aca-oregon URL instead of the Pacific Power NEM one).
        The learner now drives login → disclaimer → work location → record type →
        applicant contact → project detail → attachments, all deterministically.
        Each fix below came from a live failure the operator saw on screen:
        - ADDRESS SEARCH: portion-FIRST (the portal's own hint and the live
          watermark say "First 3 characters only"), with polling for the results
          grid — a fixed-delay read saw the PREVIOUS attempt's stale "Address Not
          Found" banner and bailed.
        - CONTACTS: the account picker is never used. It attaches an arbitrary
          contact from the account (15 of them on the operator's), which is wrong
          data on a legal filing even on a per-client login, and a genuine
          cross-company leak on any shared account. The pass clicks "Add New" and
          fills the filing party's own identity, cancelling the picker if the
          planner opened it. SECTION-AWARE: section 0 (Applicant) = the filing
          CONTRACTOR, section 1 (Site Contact) = the PROPERTY OWNER — filling
          installer identity into both produced a mixed contact live (owner name
          + contractor address). Recorded steps bind to installer*/homeowner*
          keys accordingly. The "Add New" button is chosen as the first VISIBLE
          one, not by index: a saved section re-renders with Edit/Remove and the
          indices shift between passes.
        - MASKED INPUTS (the big one, portal-agnostic): ACA's phone and zip
          controls validate on KEYSTROKES. Playwright's fill() assigns .value and
          fires input+change, so the box showed the right text and the portal
          still said "Required Invalid". Masked fields are now TYPED (with blur);
          zip is trimmed to exactly ##### (ZIP+4 is rejected); and PHONE is three
          segmented boxes (…$ChildControl0/1/2) — the mask auto-advances focus, so
          the fix is to focus the first box and type all ten digits straight
          through, then READ THE SEGMENTS BACK to confirm (fallback: per-segment).
          A "partial" segmented fill must never fall back to writing the whole
          number into one box — that IS the rejected state.
        - ATTACHMENTS: Accela commits them only via the section's own Save;
          Continue Application leaves them pending. Adversarial review caught
          (with real-Chromium proof against the captured trace) that the Save
          control is an ANCHOR — `<a id="…btnSave"><span>Save</span></a>` — so a
          button-role locator and `a:text-is("Save")` both count ZERO and the pass
          bailed silently. Now role=link (matching the hand-coded adapter), and
          the commit check reads the AttachmentsList IFRAME, since "No records
          found" never appears in the main-frame body (it was reporting success
          unconditionally). Uploads are deduped RUN-wide (pathname::control::file):
          ACA serves every wizard step from CapEdit.aspx and the loop revisits it
          ~10x, so a per-visit set still produced 3 pending rows of one PDF, two
          with empty required Description/Type, blocking the page. Uploads are
          also skipped entirely on review screens, and the upload phase has a
          150s ceiling (a live run sat in it 10+ minutes and only died when the
          browser was closed).
        STILL OPEN: no run has reached the review screen yet — the remaining
        frontier is the wizard steps AFTER attachments. Re-run
        `npx tsx live-accela-learn.ts` (delete after the session) and read the
        bundle's events.jsonl: aca_contact_add_pass / phone_segments /
        aca_attachment_save_pass / attachment_save carry the per-pass verdicts.
        CLEANUP OWED: several TMP draft applications on the Coos Bay account from
        these runs (never submitted — delete from the portal).
2. **Stripe checkout** for the payment screen (operator said "later"): a
   Payment Link per quote; `submission_payments.payment_reference` is ready.
3. **HOA list import** (`HOA_List.xlsx`) — needs an `hoa_library` table + an
   address→HOA pre-submission check. Files re-shared by the operator, in
   `/root/.claude/uploads/...` during sessions; ask for them again if needed.
4. **KB link sweep tuning** after first real run: watch for false "dead" from
   aggressive bot-blockers; 403/405/429/503 already map to `unknown`.
5. **Learn-run triage agent + correction agent**: shipped but lightly used —
   confirm findings quality on the next few real bundles.

## Reusable form-fill engine (built for the standalone tool — apply to the main filler)

A deterministic, no-LLM form-fill engine now lives in the backend and powers the
standalone **Form Filler** tool (`/tools/form-filler`, `frontend/form-filler.html`).
It was built while filling AHJ **refund** forms but is general. The operator is
done with that specific tool, but the ENGINE is the keeper — it directly fixes
the two problems reported against the autopilot's AHJ document filler ("off a
bit" placement, and checkboxes not filled).

**Modules (tested, browser-free):**
- `backend/src/formFiller.ts` — `autoFillByFieldName(bytes, data)`: fills an
  AcroForm by matching data keys (name/street/mailingAddress/city/state/zip/
  phone/email/permitNumber/date/reason/installer) to field NAMES via
  `FIELD_SYNONYMS`; also ticks reason/permitType checkboxes via keyword overlap
  against the field name OR the descriptive text beside a generically-named box.
  Never flattens (stays editable). `overlayText`, `listAcroFields`,
  `convertDocxToPdf` (LibreOffice, cross-platform), `isPdf`.
- `backend/src/formTextLayer.ts` — `extractLabels` (pdfjs), `anchorPlacement`
  (right/above/below, on the label's REAL baseline — no float), `sideForLabel`
  ("LABEL:"/"#" → right; bare caption → above), `autoPlaceFromData` (auto-place
  a data bag on a flat form), `checkboxLabels` (recover the text beside a
  generically-named box). Tests: `backend/test/formFiller.test.ts`,
  `formTextLayer.test.ts`.

**Verified on real AHJ forms:** Bellingham (AcroForm) fills every field by name;
Jackson County (FLAT, no fields) fills 9/10 by text-layer anchoring with correct
above/right placement.

**Main AHJ filler — "off a bit" FIX SHIPPED (label-anchored overlay):**
The vision mapper's LLM output already carried a `label` per placement; it was
being dropped (`ahjFormAuto.ts:204-214`). Now `OverlayField.label` is persisted,
and `fillLoadedForm`'s overlay branch anchors each labeled field to its real
text-layer baseline via `formTextLayer.anchorPlacement` (falls back to stored
x/y when no label / no text layer / label-not-found). Gated so hand-tuned
registry forms (unlabeled overlayFields) are byte-identical — proven by
`backend/test/ahjFormFill.test.ts` (labeled→anchored, unlabeled→exact x/y,
not-found→fallback). Existing stored templates gain labels on their next re-map
(`POST /api/projects/:id/find-ahj-form`); until then they use current x/y (no
regression). ⚠️ **Operator step:** re-map old flat-form templates once to get
accurate placement.
- **Still open — checkboxes on flat structural checklists:** placement is now
  fixed for any checkbox mark the LLM detects, but WHICH structural Yes/No box
  to tick (Risk Category, snow load, …) needs answers the project record does
  not hold — a parser-extraction effort, not a placement one. Separate follow-up.

## Cold-start readiness (deploying on a NEW utility/AHJ)

Every "unknown" the learner can hit now has a look-it-up-or-figure-it-out path:

| Encounter | What happens |
|---|---|
| No portal URL anywhere | Auto-researched (web-grounded, KB-hinted), saved as a seeded KB profile, run continues. `PORTAL_URL_RESEARCH=off` disables. Audit: `portal.url_researched`. |
| No credential | Human-only by design (portals need real accounts) — error guides to Manage Logins. |
| Unknown page questions | LLM planner (vision) + fuzzy KB context (imported notes) + design digest + self-taught topics (activate after 2 missed-required runs). |
| Certified equipment names | Expanded `EQUIPMENT_MAKE_ALIASES` (CEC naming for ~30 mainstream makes) + distinctive-token fallback + verified fills. Unmatched make on a run → add its certified name to the table. |
| Cascading/custom dropdowns | option-wait with contains matching, native→combobox fallback, post-fill verification, cascade-safe rescans. |
| Required docs/forms | Full form-set research + download + auto-map (PDF filler); checklists included; everything stored per AHJ. |
| Permit fees | Valuation estimate → learned per-AHJ real-fee history → operator true-up from the portal's fee screen. |
| Adopted codes | Fuzzy jurisdiction profiles + model-code defaults phrased "verify locally". |
| Link rot | Form-source + KB portal link sweeps with auto re-research. |
| Failed runs | run-triage agent reads the debug bundle, applies safe fixes, files the rest for review. |
| MFA/CAPTCHA/final submit/fees | Always paused for a human — hard rule, never regress. |

## Research takeaways (deep-research, July 2026 — VERIFIED: both runs completed adversarial 3-judge verification; full cited reports in docs/research/)

ARCHITECTURE VERDICT (see docs/research/ARCHITECTURE_REVIEW_2026-07.md): KEEP
learn-once/replay — CONFIRMED 3-0 across Stagehand/Healenium/UiPath primary
sources plus the WAREX fault-injection study. Agent-per-run collapses 70-95%
under realistic network faults and 86-98% of tested agents click injected
malicious popups. Per-step repair-on-failure (not full re-record) is the
industry-standard drift answer — SHIPPED: self-heal `20efa7e`, fingerprints
`f38f733`, drift precheck `b46ae1d`. ⚠️ REFUTED in verification (do not quote):
fault-free agent baseline rates (12.4/17/42%) and the "~50% cost/97% accuracy"
plan-caching figures (use the 76.42% GAIA cost-cut figure instead). Next-up
upgrades: centralized per-portal selector repository for shared widgets,
anchor-label targeting, official-integration routing tier per AHJ.

BUSINESS (see docs/research/MARKET_STRATEGY_2026-07.md): Symbium $50/plan-check
(CONFIRMED — pricing anchor); SolarAPP+ free to AHJs, weekly CEC sync, and
CONFIRMED to have NO utility interconnection/NEM capability with adoption still
jurisdiction-by-jurisdiction — the NEM side + long-tail AHJs remain the
verified white space. ⚠️ REFUTED (0-3): "GreenLancer's interconnection is
limited to line diagrams" — do not cite GreenLancer's site as evidence of NEM
white space; the SolarAPP+ scope gap is the solid evidence. Market: 2026
residential contraction 19-21% (25D ITC eliminated end-2025), recovery 2027+
at ~6%/yr, >60 GWdc 2026-2036; installer base fragmented (Sunrun 12.7%) — the
long tail is the buyer. CEC lists update 3x/month and are freely downloadable:
data itself is NOT a moat, integration is (weekly sync SHIPPED `a995bd5`).
Invest LATER: Stripe metering (Stripe now steers usage billing to Metronome —
recheck when building), Postgres+queue at ~50 jobs/day, managed browsers at
multi-team scale, SOC 2 at first AHJ/utility RFP.

OPERATIONS & OFFICIAL APIs (third run, see
docs/research/OPERATIONS_INTEGRATIONS_2026-07.md): PowerClerk has a full
public applicant API (V2) and Accela a Citizen Access API + delegate model —
BUT both gate access behind per-utility/per-agency application + approval.
STRATEGIC DECISION (operator, July 2026): USE the API whenever it's open, an
account already exists, or onboarding can be standardized — APIs are the
faster, more reliable path when available. But they are NOT the universal
go-live path, because there is no shortcut around per-installer onboarding
with each utility/agency. CONFIRMED by the operator directly with PowerClerk
(Clean Power Research): they have NO offering where we hold one API access and
apply on other installers' behalf — each installer must still be onboarded
with PowerClerk first (Accela assumed the same: the delegate model still needs
the AHJ tenant + account enabled per installer). So: prefer API where the
account is already onboarded or onboarding is cheap; fall back to universal
browser automation everywhere else. Browser-automation universality IS the
moat for the long tail. What matters for go-live is that UNIVERSAL browser
automation can run legitimately.

GO-LIVE OPS / WAF / LEGAL (fourth run, FULLY VERIFIED, see
docs/research/GOLIVE_OPS_LEGAL_2026-07.md). WAF: Accela Citizen Access
(aca-prod.accela.com) sits behind TWO layers — Cloudflare edge + Azure App
Gateway/WAF (CONFIRMED 3-0 + live headers). PowerClerk = Cloudflare with a
__cf_bm bot-management cookie (my own live probe; panel didn't independently
confirm). EnerGov + ProjectDox WAF posture NOT confirmed — probe live from
prod egress before relying on them (ProjectDox/Avolve resolved to a plain
Rackspace IP, likely no CDN edge). So HOW the browser runs matters: headed
real Chromium (not headless — defeats navigator.webdriver + JA3/JA4 TLS
fingerprint + plugin tells at once), persistent session cookies (fresh login
each run is itself flagged), human-solved MFA (already a rule), respectful
rate limits, non-datacenter/residential IP. At tens/day human-attended the
block risk is LOW (engineering inference — no measured rate). Some agencies
self-host Accela ACA on their own domain (outside the Cloudflare edge).
CREDENTIAL CUSTODY (CONFIRMED 3-0, OWASP/AWS/UiPath): AES-256-GCM authenticated
encryption; envelope encryption (DEK encrypts secret, separately-held KEK in
KMS encrypts DEK — never store KEK beside ciphertext); per-installer KMS key
scoping; never log secrets; tamper-resistant audit log of every credential
use; rotate portal passwords ONLY on suspected compromise (not scheduled —
NIST). Maps to SOC 2 Confidentiality+Security and CCPA/CPRA. LEGAL (CONFIRMED
3-0, SCOTUS+9th Cir primary opinions): CFAA is "gates-up-or-down" (Van Buren)
— credentialed, installer-authorized access has the gate UP, not "exceeding
access" just because it's automated/commercial; ToS violation alone ≠ CFAA;
BUT (Power Ventures) a written cease-and-desist for a specific account/portal
is where CFAA liability begins → if we ever get one, STOP automating that
portal immediately. TWO CAVEATS the operator must hold: (1) our exact
authorized-agent automated-SUBMISSION scenario is an UNSETTLED "gray area,"
not a settled safe harbor; (2) Van Buren footnote 8 left open whether a ToS
automation BAN can itself be a CFAA "gate" — so flag any AHJ/utility whose
terms explicitly prohibit automation. Exposure is otherwise civil/contractual
(trespass-to-chattels, breach-of-contract), not criminal. Analysis is
9th-Circuit-weighted.

## Next automations worth building (ranked, for future sessions)

1. **Auto-verify assist**: when the operator opens a seeded KB/code row, fetch
   the cited source URL and show it side-by-side with a one-click verify —
   turns fact verification from research into confirmation.
2. **Stripe checkout webhook** (specced in SERVER_SETUP.md) — removes the
   manual Mark-paid step.
3. **Correction → auto-redline**: when a correction names a document, attach
   the run-triage finding + the exact sheet to the designer notification.
4. **Nightly self-test cron**: `SMOKE_*` lifecycle for the operator's active
   territories + link sweep + form refresh, results to the dashboard — the
   tool proves ITSELF healthy every morning.
5. **Alias self-learning**: when an equipment fill succeeds via a non-first
   candidate, record plan-name→certified-name into the KB automatically.

## What to verify after each `git pull` on the operator's machine

1. `npm run smoke` green; server starts (migrations v9+ run; KB notes repair
   is idempotent).
2. Learn/stage run on PGE: specs page fills (make/model/qty/tilt/azimuth/
   tracking), uploads named cleanly, docs land in right slots.
3. Payment gate: set a client to `per_submission`, confirm staging blocks
   with a quote and unblocks on Mark paid.
4. `POST /api/kb/check-links {limit: 10}` once, review statuses.
5. Checklist checkboxes: re-acquire an AHJ with a checkbox checklist
   (`POST /api/projects/:id/find-ahj-form`) so the mapper re-runs with the new
   presc sources; preview the filled checklist — Yes boxes ticked only on rows
   the parsed data affirms, unverified rows blank. Verify before real use.
6. Existing-system project: intake the Kristina Anderson (Salem) plan set —
   parser must put the NEW 5.28 kW in dcKw (not 10.44 combined), existing
   Silfab/Tesla gear only in existing* fields, and the description-of-work
   should read "addition … existing 5.16 kW DC … combined 10.44 kW DC".

## Environment variables added recently

- `SUBMISSION_SERVICE_FEE_USD` — default top fee when client has none.
- `PERMIT_FEE_ESTIMATE_RATE` / `_MIN_USD` / `_MAX_USD` — valuation-estimate knobs.
- `NEM_FEE_ESTIMATE_USD` — NEM-track fee estimate (default 0).
- `AHJ_FORM_RECOVER_MAX` — broken-form re-research cap per refresh run (5).
- `KB_LINK_CHECK_DAYS` / `KB_LINK_CHECK_MAX` / `KB_LINK_RESEARCH_MAX` — link sweep.
- `OVERLAY_NUDGE_X` / `OVERLAY_NUDGE_Y` — global PDF-points shift for overlay form fills ("prints a smidgen low" → +2).
- `PORTAL_VISION_RESCAN=1` — re-enable screenshots on rescan planner calls.
- `RUN_TRIAGE=off`, `CORRECTION_AGENT=off` — agent kill-switches.
- Existing: `AHJ_FORM_REFRESH_DAYS`, `PERMIT_VALUATION_PER_WATT`,
  `PORTAL_POLICY_DEFAULTS`, `PORTAL_UPLOAD_MAX_MB`, `AUTOPILOT_DB_PATH`.

## Working agreements observed this far (keep them)

- Every bug fix ships with a regression test added to the unit chain.
- Adversarial review before pushing risky data-path changes (a review caught
  a data-destroying cap in the notes migration before it shipped — assume your
  first version of any migration is wrong until proven otherwise).
- The KB only grows: downloads stored as templates, real fees recorded,
  research learned, links healed. Anything the tool does once, it should not
  need a human (or an LLM call) for twice.
