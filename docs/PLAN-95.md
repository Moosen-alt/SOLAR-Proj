# SOLAR-Proj: one sequenced plan, measured state → sellable reliability

Verified before writing (not re-derived from the investigations):

- `data/learn-benchmark/latest.json` summary: 59 total / 57 measured / access 23 (40.4%) / usable-given-access 14 (60.9%) / review-given-access 2 (8.7%); blockers MFA-CAPTCHA 10, credential refused 9, login-not-recognised 9, WAF 3, dead host 2, no credential 1.
- `data/replay-runs/2026-09-08T14-13-13-portland-general-electric/step055-*.html`: `#pcInputBase34 aria-label="Model" value="0.3 kW (Model IQ8PLUS-72-2-US {240V} [SI1])"`, `#pcInputBase33 value="Enphase Energy"`. **PGE's equipment landed. The score was wrong, not the recipe.** Investigation 5's headline is confirmed at the byte level.
- `autoLearnAdapter.ts` dismiss list contains `` `${clickable}:has-text("Close")` `` and `:has-text("OK")` — investigation 1's mechanism is live in the code.
- `autoLearn.ts:~1100` `const reproduced = replay.ok === true && !replay.pauseReason;`, and the `stageWithRecipe(...)` call above it passes `{ headless: input.headless }` only — **no credential, no userDataDir**. Investigation 6 is confirmed.
- `runAbort.ts:65` exclusion regex contains the bare token `permission`. Confirmed.
- `learnBenchmark.ts:155` returns rung 6 on `reachedReview` alone, before the `substantive > 0` branch. Confirmed.
- `clickFallbackAdvance` (`autoLearnAdapter.ts:5759`) `const filledHere = steps.some(...)` over the run-level accumulator, while its own doc comment says "only when this page actually took a value". Confirmed.
- `docs/HANDOFF.md:152-159` carries **six** browser-verified URL corrections (investigation 4 listed five — it omits snohomish, which is scored in a different cohort).

---

## 1. The ceiling: what engineering can and cannot move

**Fleet-wide 95% is arithmetically impossible and should not be promised.** Of 57 measured portals:

| Category | Count | Owner | Reachable by engine? |
|---|---|---|---|
| MFA / CAPTCHA | 10 | portal, by design | **Never.** Hard rule 1. |
| WAF / bot block | 3 | portal | No (2 real + 1 misattributed — see below) |
| Dead host | 2 | portal | No |
| Credential refused | 9 | ops | No — credential refresh |
| Login form not recognised | 9 | mixed: 5 wrong stored URL (ops), 1 WAF misattributed (scorer, 1 line), **3 engine** | 3 of 9 |
| No credential stored | 1 | ops | No |
| **Access already reached** | **23** | — | this is where engine work lives |

Hard arithmetic:

- **15 of 57 (26.3%) can never be accessed.** Access therefore tops out at **42/57 = 73.7%**, and that requires every credential and every URL to be fixed.
- **Engine work moves access by ~3 rows (40.4% → ~45%).** Everything else in the access column is ops.
- **Ops work moves access by up to ~15 rows (→ ~66%).** That is the larger number and it is not engineering.

So do not sell "95% of the fleet". Sell this instead:

> **Per-portal replay reliability ≥95% on SUPPORTED portals**, where *supported* = access works **and** the recipe has passed a replay self-test (rung 7, `replay_verified`), measured k-of-N worst-first by the `summarizeReliability()` that already exists at `backend/src/replayBenchmark.ts:430`, fed from production once `portal_runs.recipe_id` exists.

That metric is honest (an outage counts against it, per HANDOFF), it is the operator's actual question ("if I point it at portal X…"), and it grows by *adding supported portals* rather than by averaging failures away. The three numbers engineering owns are: **usable-given-access**, **review-given-access**, and **per-portal reliability**. Access is an ops number with a 73.7% ceiling.

Two numbers **must go down** before they go up, and this must be announced, not discovered:

- review-given-access **2/23 → 1/23** when co-spokane (1 page, 31 fillable controls, 2 substantive fills) stops taking rung 6.
- us.cloudpermit.com drops from `recorded_steps` to `login_failed` — it was never logged in (its own `events.jsonl` line 1 shows `p1 = /gov/login`). HANDOFF's "session lost mid-walk at p7" is wrong.

---

## 2. Three collisions to resolve before any code is written

These six investigations cannot be concatenated. Naive merge ships regressions none of them predicted.

**A. Investigations 1 and 2 both rewrite `dismissPageModals` (`autoLearnAdapter.ts:6407`) with different strategies.** Inv 1 wants anchored text matches + overlay scoping + a navigation guard; inv 2 wants a `keepApplicationPanel` flag that drops dialog-closing selectors. They are compatible but must be **one** edit to that function, landed once: navigation guard (the invariant) + anchored/scoped text selectors + `keepApplicationPanel` gate + one signature change + **all six call sites** (`autoLearnAdapter.ts:3290`, `:6134` via `dismissModals()`; `recipeAdapter.ts:682, 844, 3107`) + **one** merged smoke covering mustDismiss / mustNotClick / drawer-survives. Two sequential rewrites of the same 60 lines is the regression.

**B. Investigation 1's "turn on `PORTAL_REPLAY_SELFTEST` for the benchmark" is a landmine until investigation 6's credential fix lands.** Verified above: the self-test calls `stageWithRecipe` with no credential, so `RecipeAdapter.login` → `performLogin(page, undefined)` → `fail("...no stored credential...")` on every authenticated portal. Enabling the flag today demotes the entire fleet vacuously. **Sequence rule: the self-test rewrite lands before the flag is enabled anywhere.**

**C. Investigation 3's review over-detection guard and investigation 6's `recipeIsSubstantive` floor + rung 7 each move measured numbers down.** Batch them into **one** scoring change and **one** re-baseline, so the story is "the numbers became true once" rather than two apparent regressions across two sweeps.

---

## 3. The sequence

Ordered by expected movement ÷ effort. Each milestone has one command and one number.

### Phase 0 — Measurement honesty (half a day, no engine-behavior change)

The highest movement-per-effort work in the whole set, because PGE's DOM proves the recipe was right and the scorekeeping was wrong. Nothing here changes what the browser does.

**0.1 — one-line scorer fix.** `backend/src/runAbort.ts:65`: remove the bare `permission` token from the account-refusal exclusion, replace with `insufficient permission|permission to (view|edit) this (page|record|account)|not authorized to`. Leave `BOT_BLOCK` (`:55-56`) alone. Pin both directions in `backend/test/learnBenchmark.test.ts`: the literal Akamai sentence must score `owner: portal`; "you do not have permission to view this record — sign in with an authorised account" must stay `credential`.

**0.2 — replay scoring truth (investigation 5, non-behavioral half).**
- `recipeAdapter.ts:1468` `verifyEquipmentSelectsHeld`: when the post-repair **readback** is non-empty, retract the earlier miss — remove the name from `skipped` (hoist it from the local at `:476` to an instance field) and move the paired `landed nothing` / `how it resolved` lines from `driftWarnings` to `agingNotes`. Follow the `dischargeCoveredWarning` pattern at `:4009`. **Gate on the readback only, never on the retry returning true.**
- `replayBenchmark.ts:254`: add the policy-**not-asked** skip to the `isDeclinedSubmit` filter; give it a distinguishable prefix at `recipeAdapter.ts:2296` (`policy not asked: <question>`). Never the tried-and-failed branch.
- Move `no enabled control ... name containing "Apply"` out of `findEnabledControlByName` (`:3536`) into `resolveLocator`, emitted only when `findEnabledControlByName ?? revealMenuAndPick` both come back empty. This one edit unblocks both Coos Bay recipes.
- Reclassify the record-type messages at `:2079`/`:2086` from `driftWarnings` to `agingNotes` — they fire on the branch that just successfully checked the exactly-named box. The refusal branch three lines below still throws.
- Fold all frames into `pageEffect` (`:3015`) — iterate `this.page.frames()`, cap ~12, same shape `waitForUploadAccepted` already uses at `:3876` — and re-read once after ~800ms settle inside `assertAdvanced` (`:3084`). Accela renders its attachment grid in `ACADialogFrame`; three legitimate actions read as swallowed clicks today.
- Diagnostic honesty, four small edits: drop the `option` escape from the page-wide branch of `visibleOptionSample` (`:1610-1622`); snapshot `resolveTrail` per-step after the primary `resolveLocator` (`:2136`) instead of letting `:4368` overwrite it; move the aging-note pushes out of `resolveByTestHook` (`:3186`) / `resolveBySection` (`:3268`) to the accept sites (`:2174`/`:2177`).

**0.3 — cascade-parent gate (the one behavioral change in this phase, land it second and alone).** In the select branch of `executeStep`, when `isModelStep(step)`, read the manufacturer's committed value first; if empty, re-run the manufacturer step, poll ~2s until the model control has no `display:none` ancestor, then proceed. If the ancestor chain is still `display:none`, refuse the rescue chain and report `"Model" is not on the page: the portal hides it until "Manufacturer" is answered`. **PacifiCorp is the regression sentinel** — it is the only recipe at 3/3 and it runs this exact path.

> **MILESTONE 0.** `npm run replay:benchmark -- --repeat 3`
> **Clean recipes 1/5 → 3/5** (PGE and Coos Bay ELECTRICAL). **PacifiCorp must still be 3/3 byte-identical.** Fleet attempts 3/15 → ~9/15.
> Coos Bay STRUCTURAL and Ameren stay at 0/3 — both need re-records, which is operator work.
> Fails if: PacifiCorp drops (revert 0.3 first, it is the only change touching its happy path); or PGE reports `Model ... did not hold even after repair`, which means the retraction gate is correctly refusing and the combobox theory reopens.
> Also run `npx tsx portal-bot/src/adapters/multiArray.dom.smoke.ts` and `clickEffect.dom.smoke.ts` with the new cases; each must fail with the fix commented out.

### Phase 1 — The dismisser and the recorded-path invariant (1 day)

This is the headline finding's root cause. `dismissPageModals`' `:has-text("Close")` matched "Abandoned / Fore**close**d Property" on PermitEyes' type menu, clicked it, navigated, and recorded nothing — so the learn filled an *Abandoned/Foreclosed Property* application and scored itself 6/6.

Land as **one** edit to `dismissPageModals` (collision A):

1. **Navigation guard (the invariant, the most important line in the plan).** Capture pathname + fingerprint before each candidate click; if the pathname changed after the click, that was not a dismissal — `goBack()`, break, and return `{ navigated: { from, to, via } }`. Signature becomes `Promise<{navigated?: …}>`. A dismissal must never move the page. No wordlist can close this class; this does.
2. **Anchored + scoped text selectors.** Every `:has-text("…")` becomes `:text-matches("^\\s*(close|dismiss|got it|ok|accept|accept all)\\s*$","i")` prefixed with an overlay scope (`.modal, .popover, [role=dialog], [class*=backdrop], [class*=cookie], [class*=consent], [class*=banner], [class*=x-window], [id*=cpr-banner]`). Keep the CSS-anchored entries (`#cpr-banner-dimiss-btn`, `.btn-close`, `[aria-label="Close"]`, `.x-tool-close`) untouched and **ahead** of the text ones — they are what actually clears PowerClerk's banner and Accela's ExtJS windows.
3. **`keepApplicationPanel` gate.** New instance field `applicationPanelOpen` beside `entryLabelsClicked` (`:1106`), set true after a successful entry click (`:3581-3587`) or `chooseApplicationProgram` (`:3053`), cleared on the first recorded fill/select/check or on a pathname change. `dismissModals()` (`:6061`) passes it — one edit covers both the per-page call (`:3290`) and the pre-click call inside `clickResilient` (`:6134`). When set, drop the dialog-closing selectors and skip the Escape fallback; keep the cookie/onboarding ones. This is what stops the dismisser shutting the drawer the entry pass just opened (peco: 17 application fields sat hidden; communitycore: p001 and p002 pixel-identical).
4. **All six call sites updated in the same change.** Replay's three (`recipeAdapter.ts:682, 844, 3107`) mirror the flag and, on `navigated`, push a **blocking** `driftWarning` — a replay that wandered means the filing is wrong, and blocking is the default.

Then the detector that makes the class measurable:

5. **Unrecorded-navigation detector** in `learnImpl`. Keep `lastRecordedIdentity = pathname + pageFingerprintOf()`; set it after the entry click (`:3591`), the navigate click (`:3904`), the advance click (`:4505`); recompute immediately before the next `steps.push`. On a pathname change, record a verification issue naming both URLs and set `pathIncomplete` on `LearnResult`. **Compare pathname + fingerprint, never full URL** (session tokens and SPA query changes would fire constantly).
6. **Trust gate**: `backend/src/autoLearn.ts:~1058` add `&& !learn.pathIncomplete` to `trusted`; push the issue text into `verification.issues`. A recipe with a hole in its recorded path is not replayable by definition.
7. **Record the module hop.** `applicationEntry.ts` `findApplicationEntryDeep` returns `path: Array<{label, kind}>` (push in `openCollapsedNav()` and per module-tab click); thread it through `enterApplicationFlow`; in the b9 entry pass (`:3571-3597`) push one click step per path entry before the `application entry:` step, with `optional: true` on the nav toggle (a desktop-width replay may have no collapsed nav — an absent toggle must not fail the run). Today `viaModule` is a diagnostic string that `grep` proves `autoLearnAdapter.ts` never reads, so every Accela recipe entered via a "Permits" hop is unreplayable from clean.
8. **Feed `formPurposeMismatch` the form's own title.** Capture the review page's `document.title`/first H1 in `reviewScreenScraper.ts`; change the call at `backend/src/autoLearn.ts:1051-1055` to `formPurposeMismatch([reviewScreen.formTitle, learn.portalName, …])`. Its own comment says titles are the honest signal, but `texts[0]` is currently `"Benchmark permiteyes.us"`, so it never saw the form announce itself as ABANDONED/FORECLOSED PROPERTY.
9. **One merged smoke**, `portal-bot/src/adapters/modalDismissScope.dom.smoke.ts`: mustDismiss (Bootstrap popover "Got it" + cookie banner "Close", URL unchanged), mustNotClick (the PermitEyes anchor list — "Abandoned / Foreclosed Property", "Smoke Detector Permit", "Look Up Record", "Solar Permit" — plus a hidden `.modal` shell so the walk runs; URL must not change), drawer-survives (a `[role=dialog]` with an `[aria-label="Close"]` and four inputs survives with the flag set, while the banner and popover are still dismissed). Filter lists fail both ways; mustExclude is not optional.

> **MILESTONE 1a (hour one — this is the kill test, see §4).** `npm run learn:benchmark -- --host permiteyes.us` after change 2 only.
> **The stored recipe must contain a step naming a permit type between `application entry: New Application` and `OwnerName`, and the learned form's title must not be ABANDONED/FORECLOSED PROPERTY.**
>
> **MILESTONE 1b.** `npx tsx portal-bot/src/adapters/modalDismissScope.dom.smoke.ts` (must fail before the fix with `first = "Abandoned / Foreclosed Property"`), then each of `newFeaturePopover`, `consentBanner`, `modalOverCheckbox`, `staleOverlay`, `applicationEntry` `.dom.smoke.ts` **run individually — read the last banner, not the exit code**. Then `npm run learn:benchmark -- --host peco.connectthegrid.com,app.communitycore.com --portal-timeout 480` with `AUTOLEARN_DEBUG=1`: peco's `p002-before-*.png` must show the drawer **open** (today it shows the bare grid) and the row must have **fills > 0**.
> **usable-given-access 14/23 → 15-16/23.** Do not claim more than +2 rows.

### Phase 2 — Forward motion and the three real login gaps (1-1.5 days)

Twelve portals fill and never reach review. They are five different failures, and `clickFallbackAdvance` reaches only the smallest.

**2.1 Non-moving named advance** (boston 8×, momentum 3×, baltimore 4× — the largest cohort, currently handled by nothing):
- New `advanceSignatureOf(page)` beside `pageFingerprintOf` (`:6595`): pathname | sorted visible fillable labels | active step heading | enabled button count. **Excludes `document.body.innerText.length`** — an inline validation banner changes it, which is why a blocked "Next" currently reads as a successful advance. Leave `pageFingerprintOf` alone; `waitAfterClick`'s poll wants the sensitive detector.
- Rewrite the post-advance guard (`:4528-4544`): call `collectValidationErrors()` **unconditionally**, force `movedForward = false` when blockers exist, and `steps.pop()` the bogus `advance:` step on every not-moved verdict.
- Per-page dead-control set keyed by advance signature (max 2 per signature), and at `:4483` ignore a planner `advanceSelectorIndex` that resolves to a banned control so the fallback becomes reachable.

**2.2 Fix `clickFallbackAdvance`'s contract** (`:5759`): capture `stepsAtPageStart` after `pageCount++` and pass `steps.slice(stepsAtPageStart)` so `filledHere` means what its comment says (today one login-email fill on p1 makes every later page look filled); replace the no-move test with `advanceSignatureOf` + tab count; add the negative guard `\b(later|draft|exit|sign ?out|log ?out)\b` so "Save and Continue Later" can never match; prefer `fieldType === 'button'`, links only as last resort; skip the dead set. **This is the headline finding in miniature** — advancing past an unanswered chooser with nothing recorded is exactly the permiteyes shape.

**2.3 Recovery hints from evidence already computed.** `collectUnfilledRequired()` runs at `:4394` eleven lines before the advance and its answer is thrown away. Hoist it into a loop-scoped variable and append to the recovery directive at `:3401`. Zero new scraping, zero new LLM cost. Also give the four silent refusal branches in c3 (`:3855-3884`) the `pendingHint` the navLoop branch already writes, and add a bounded (`< 2`) `continue` so a nav-only refused plan re-plans instead of falling to a terminal `break` — the hint at `:3866` is currently a dead write read by an iteration that never runs.

**2.4 Tell the planner an application is already open.** `applicationStartedVia?: string` on `PortalFieldPlanInput` (`shared/src/types.ts:1629`) and `LearnPlanRequest` (`:95`), threaded through `autoLearn.ts:275-288` into `llm.planPortalFields`, with one prompt paragraph after the DASHBOARD block. Button labels are UI text, not project data — no conflict with hard rule 2. Prompt language deliberately, **not** a code guard: frederick's `/lookup-record` has 99 fillable fields where navigating away is legitimate.

**2.5 Per-page cost and exit legibility.** Gate the upload phase (`:4021-4060`) on `fields.some(f => f.fieldType === 'file')`; skip the 6s networkidle race in `waitAfterClick` when the URL already changed; **emit a `stop_reason` event at every exit from the walk**. Today a row's exit has to be reconstructed from `pages` minus `pageTrace.length`, which is how cloudpermit was recorded as a mid-walk session loss when it was never logged in.

**2.6 The three real login gaps (investigation 4's engine third):**
- `loginFlow.ts:762-767`: `formGone` alone must not mean success. Require an authenticated signal, or (URL off the login regex AND no `input[type=password]` AND no visible identifier+next pair), re-tested after ~1.5s and holding twice. This is cloudpermit: `performLogin` clicked the two-step login's step-1 "Next", the pane swapped, and the engine reported success.
- New `markLoginControlByWording(page)` modelled on `markDescribedLoginControl` (`:920`), with the punctuation-tolerant vocabulary `\b(log|sign)[\s\-_]?(in|on)\b|\blogin\b|\bsignin\b|\blogon\b|\bmy account\b`, excluding logout, **no "register" token**. All 17 `REVEAL_TRIGGERS` return 0 on `<button id="sign_in_btn_21860">Sign-In Using Access DC</button>`; `getByRole("button",{name:/sign[\s-]?in/i})` returns 1. `publicApplicationEntry` and `markDescribedLoginControl` already use the hyphen-tolerant form — this removes an internal disagreement, it does not invent a rule.
- Popup follow in `revealLoginForm` (`:386`): after a trigger click, if `page.context().pages()` grew, `waitForLoadState("domcontentloaded")`, **require `loginFormPresent(popup) === true`**, then `page.goto(popup.url())`, close the popup, `tried.clear()`, return false. business.ct.gov's `<a target="_blank" href="https://login.ct.gov/...">Sign In</a>` puts the password field one tab away and nothing in `loginFlow.ts` ever looks. Gating on `loginFormPresent` avoids hijacking opener-dependent OAuth.
- Also: make `revealTrail` **append** across passes (`:387-388`) instead of replacing — the settle loop destroys the one informative pass, which is why this cohort took three readings to split.
- Defence in depth in `autoLearnAdapter.ts:~3350`: if `!applicationStarted` **and** the page is login-shaped (login URL, **or** a visible password input together with sign-in wording), stop honestly rather than planning. Require both; a bare password field is not enough.

**2.7 The batched scoring change (collision C — land with 2.1-2.6, one re-baseline):**
- Export `recipeIsSubstantive({pages, fills})` from `learnBenchmark.ts` (`fills >= 5 && (pages >= 3 || fills >= 10)`) and import it into `autoLearn.ts` to replace the inline `tooThin` at `:1033`. One repo, one definition of a recipe.
- Guard the top-rung branch at `:155` with it; a thin `reachedReview` falls to `recorded_steps` with a reason naming the fill count.
- Inverse guard at `:3705`: also reject `plan.atReview` on the first planned page with a large unfilled count and no review signals.
- **Append** `replay_verified` at index 7 to `LEARN_RUNGS`. Never renumber — `compareRuns` compares by index against every scorecard on disk.
- New classification-only `REVIEW_SUBMIT_HINT` used **only** in `isReviewPage` (`:3663`). **Do not widen `SUBMIT_INTENT` (`:196`)** — it gates what automation may click.

> **MILESTONE 2.** Per host, reading logs not exit codes:
> - `npm run learn:benchmark -- --host onlinepermitsandlicenses.cityofboston.gov` → **at most 2 `SiteLocation.aspx` trace lines** (today 8), plus an `advance_did_nothing` event naming index 17's control.
> - `npm run learn:benchmark -- --host us.cloudpermit.com` → row **drops to `login_failed`** with a reason naming the two-step login, and `events.jsonl` carries **no `page` events**. That drop is the correct answer.
> - `npm run learn:benchmark -- --host amerenillinoisinterconnect.powerclerk.com --portal-timeout 900` → **pages > 5** with a `stop_reason` that is not `budget_exhausted`.
> - `npx tsx portal-bot/src/adapters/fallbackAdvance.dom.smoke.ts` (rewritten to import the real regexes and drive the real function) must refuse: zero-fills-this-page, "Save and Continue Later", a control in the dead set.
> - `npx tsx reproprobe.tmp.ts "https://permitwizard.dcra.dc.gov/landing-21860" 2 --fresh` → `no_credential`, not `login_form_unrecognized`. Same for business.ct.gov. mapsonline **6/6** (one pass proves nothing; it already passed 4/4 without the fix).
> **review-given-access 1/23 (post-correction baseline) → 5-8/23 (22-35%)**, and **login-not-recognised 9 → 3** on the engine third alone.

### Phase 3 — Trust and promotion (2-3 days)

Today "trusted" means "the learn pass looked fine". Two honest measurement modules exist and the promotion gate consults neither.

**3.1 Self-test rewrite — must land before the flag is enabled anywhere (collision B).** `backend/src/autoLearn.ts:1090-1113`: pass `credential` (in scope at `:442`) and `userDataDir: ${userDataDir}-selftest` (`:449`); score with `mergeStepReport(replay)` → `scoreReplayOutcome()` instead of `replay.ok === true` (the exact bar `replayBenchmark.ts:9-12` was written to reject); **three** outcomes — `measured === false` → inconclusive (neither promotes nor demotes; PowerClerk's one-session-per-account is real and already classified at `:170`), `index < 4` → fail with `rScore.reason` (which carries the actual step message, unlike `replay.message`, which does not exist at top level), `index >= 4` → pass. Keep the rule that the self-test may only ever lower trust.

**3.2 Default on, headless only.** Run unless `PORTAL_REPLAY_SELFTEST === "0"`, and only when `resolveHeadless(input.headless)` is true. A headed learn leaves the review browser parked for patch-by-demonstration; a self-test would steal the profile lock or kill the session. Headed learns end `pending_selftest` / not trusted, and earn trust via `promoteOnHumanSubmit` (`:495`) or a manual button. **Do not flip the default in `.env.example`.**

**3.3 `trust_json`.** `addColumnIfMissing(db, "portal_recipes", "trust_json", "TEXT NOT NULL DEFAULT '{}'")` **after** the CREATE block (`db.ts:885-907`, per the migration-order rule). Shape: `{source, selfTest:{verdict,rung,index,reason,at}, coverage:{pages,fills,requiredSeen,requiredMissed}, lastReplayFailedAt, lastReplayFailReason, replays:{attempts,clean}}`. Parse in `mapRecipe` (`portalRecipes.ts:16`), write in `savePortalRecipeSteps` (`:251`), add `PortalRecipe.trust` to `shared/src/types.ts:1902`.

**3.4 Rewrite `promoteRecordingIfEligible` (`portalRecipes.ts:292-333`).** Replace the free-text regex `/required field\(s\) left blank/i.test(recipe.notes)` (`:315`) with `trust.coverage.requiredMissed`, falling back to the regex for legacy rows. Apply `recipeIsSubstantive` so a 2-fill recording cannot be promoted by an unrelated mark-submitted. **Add the oscillation guard:** if `trust.lastReplayFailedAt` is set, refuse promotion unless a passing self-test is newer. This is the loop HANDOFF documents for PGE — fail, demote, relearn, re-promote on learn-time verification alone, fail. Stamp `trust.source` on every path.

**3.5 Carry the verdict into the scorecard.** `selfTest`/`trusted` on `AutoLearnResult` and the benchmark row (`runLearnBenchmark.ts:171-188`); print a fourth headline line: `sellable (replayed back) : N/M = X%`. Keep `--self-test` as the force flag.

**3.6 Operator visibility.** `frontend/dashboard.js renderPortalRecipes` (`:319-360`): trust chip (replay-verified / verified-at-learn-time / replay FAILED / pending), coverage line, auto-submit checkbox gated on `trust.selfTest.index >= 5`, and a "Run replay self-test" button posting to `POST /api/portal-recipes/:id/self-test` (entitlement-gated and rate-limited — it drives a live browser from an HTTP request; `routeScope.test.ts` will fail until it is scoped, and that failure is the check working). `esc()` everything.

**3.7 Production ledger — shippable separately, last.** `portal_runs.recipe_id` (`db.ts:~830`, set in the INSERT at `repository.ts:5935`), merge each production run's `scoreReplayOutcome` into the recipe's `trust` in the RecipeAdapter branch (`~:5705-5760`), and `recipeReliability(db)` grouping `portal_runs` by `recipe_id` into the existing `summarizeReliability`. **This is what turns the 95% target from a lab artifact into a number the running system reports**, and it makes the oscillation guard load-bearing on real filings, not just self-tests.

> **MILESTONE 3 — the discriminating pair, both from already-measured facts:**
> - `npx tsx backend/src/runLearnBenchmark.ts --host permiteyes --self-test` → recipe stays **draft**, `trust.selfTest.verdict === "failed"`, and the reason carries the **actual step message**, not the generic fallback. Fails if the reason is "no stored credential was found" — that means the credential is still not being passed and the test is failing everything vacuously.
> - `npm run replay:benchmark -- --key "pacific power" --limit 1` → still `verified_accurate`, and a unit test feeding that run's `mergeStepReport` to `scoreReplayOutcome` asserts `index >= 4`, i.e. **the new gate would have promoted the one recipe known to work**. Fails if PacifiCorp scores below 4 — the gate is too strict.
> - New `backend/test/promotionGate.test.ts`: refuses a recipe whose `lastReplayFailedAt` is newer than its last pass; accepts once a passing self-test is stamped; refuses a 2-fill recording arriving via the mark-submitted route.
> **New "sellable" number starts near zero and is the one to grow.** Expect PacifiCorp to pass; expect PGE to fail, which is the point.

### Phase 4 — Re-baseline (ops wall-clock, budget separately)

**Re-learn, not re-replay.** permiteyes v1-v4 are contaminated — their field bindings are against an Abandoned/Foreclosed Property form. Any recipe learned through the dismisser bug or a module hop is in the same state. `npm run learn:benchmark` full sweep, then compare `accessBlockers` against `latest.json` rather than the headline percentage. Note in HANDOFF that `meanIndex`'s ceiling moved 6 → 7 and is not comparable across the boundary, while per-portal `compareRuns` stays valid.

---

## Ops track — parallel, not blocked on engine, and larger than the engine track on access

Apply HANDOFF's **six** verified URL corrections (`docs/HANDOFF.md:152-159` — includes snohomish, which investigation 4's five-row list omits) to `portal_credentials.portal_url`, **one at a time**, with `npm run learn:benchmark -- --host <host>` between each. Re-check CLAUDE.md rule 5 per row: all six are AHJ permit-track credentials and all six replacements are permit portals. Do not batch — a wrong replacement that silently learns the wrong portal is exactly the gilbertaz "Permit Extension Request" failure already on record.

Then: refresh the 9 refused credentials and the 1 missing one. That is worth ~10 access rows, more than every engine change in this plan combined.

> **MILESTONE OPS.** `login form not recognised` **9 → ≤2** (dcra behind Access DC may present MFA, which is a correct refusal; palmbay reclassifies to `owner: portal` on the 0.1 one-liner). **Access 40.4% → ~55-66%**, ceiling 73.7%.
> Do not count "reached a login form" as access. Access means authenticated.

---

## 4. The single highest-risk assumption, and how to kill it in hour one

**The permiteyes chain: "once the dismisser stops eating the type menu, the planner will see the menu and record a navigate step."**

Everything in Phase 1 rests on it, and it may be false. The type-menu page classifies as `isDashboard` and goes through `isOffLimitsDashboardTarget`. If the planner **refuses** the menu, the root cause is correctly fixed, the recipe still has no type step, and the headline replay number does not move — the walk would simply stop honestly instead of silently learning the wrong form.

**Kill it before building anything on top.** Apply change 2 only (the anchored selector), then:

```
AUTOLEARN_DEBUG=1 npm run learn:benchmark -- --host permiteyes.us
```

Read the stored recipe and the debug bundle. Pass = a step naming a permit type between `application entry: New Application` and `OwnerName`. Fail = no type step plus `navigate_offlimits_rejected` in the bundle — in which case the next change is in the planner's dashboard classification (a permit-type chooser is not a dashboard), and Phase 1's ordering changes before a day is spent on the detector and the module-hop recording.

Second-order risk, worth one sentence: the module-hop recording (Phase 1, item 7) makes Accela recipes longer and adds steps that can fail at replay. A nav toggle absent at desktop width must be `optional: true`, or a working Accela replay becomes a step-1 failure — the filter-lists-fail-both-ways shape again.

---

## 5. What should NOT be done

- **Do not widen `SUBMIT_INTENT` (`autoLearnAdapter.ts:196`).** It gates `clickFallbackAdvance`'s refusal, `isOffLimitsButton`, and final-submit promotion — widening it changes what automation may **click**, not what it may classify. Use a separate `REVIEW_SUBMIT_HINT` for `isReviewPage` only.
- **Do not enable `PORTAL_REPLAY_SELFTEST` anywhere before Phase 3.1.** It demotes the fleet vacuously on missing credentials, and it creates a second draft filing per portal per learn on real utility accounts (HANDOFF already logs cleanup owed on PGE and PacifiCorp). Never flip the default in `.env.example`.
- **Do not auto-apply the URL corrections from the engine.** Operator data, one at a time, rule-5 re-checked per row.
- **Do not chase the 10 MFA/CAPTCHA or 3 reCAPTCHA rows.** Hard rule 1. Counting them in any target sends the next session at four rows that cannot move.
- **Do not "fix" gilbertaz.seamlessdocs.com in the engine.** It is filling a *Permit Extension Request* because the stored URL is `.../f/permitext`. Ops. `formPurpose.ts`'s own comment says so.
- **Do not renumber the learn rungs.** Append `replay_verified` at 7; `compareRuns` reads by index against every scorecard on disk.
- **Do not scope the shared knowledge tables** (`permit_utility_knowledge`, `portal_recipes`, `ahj_form_templates`, `jurisdiction_code_profiles`, `cec_equipment`). Shared on purpose — that pooled knowledge is the product.
- **Do not report the fleet mean.** Per-portal, worst-first, k-of-N. A 95% average over five portals is compatible with one of them failing every other run, and the operator meets one portal.
- **Do not trust a passing exit code.** `backend:test:unit` and `portal:test:unit` are `&&`-chained; that chain's exit status has lied three times. Read the last banner. And per the same record: when a benchmark verdict looks wrong, suspect the harness first — six wrong verdicts in one session were all measuring code, and PGE's step055 DOM is number seven.

---

## Expected end state

| Metric | Today | After Phases 0-3 (engine) | + Ops track | Ceiling |
|---|---|---|---|---|
| Access | 40.4% (23/57) | ~45% (+3 engine rows) | ~55-66% | **73.7%** (26% is MFA/WAF/dead by design) |
| Usable recipe, given access | 60.9% | 65-70% | — | — |
| Reached review, given access | 8.7% (2/23) | **1/23 first** (co-spokane retracts), then 22-35% | — | — |
| Replay clean, 5 production recipes | 1/5 | **3/5** (2 need re-records — operator work) | — | — |
| **Sellable: per-portal k-of-N ≥95% on supported portals** | not measured | measurable, starts ~1 (PacifiCorp) | grows with ops | this is the number to sell |

The honest sentence for the next HANDOFF: *engineering does not raise fleet access — 26% of it is refused by design and most of the rest is credentials and URLs. What engineering delivers is a recipe that is trustworthy when it exists, a path that is complete when it is recorded, and a per-portal reliability number that cannot flatter itself.*