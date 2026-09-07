# Handoff — state of the tool (July 2026, end of Fable 5 session)

Audience: the next model/dev session (and the operator). Read `CLAUDE.md` first
for the hard rules; this file is the running state.

## What shipped recently (newest first)

| Commit | What it is |
|---|---|
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
