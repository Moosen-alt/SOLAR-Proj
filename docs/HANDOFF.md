# Handoff — state of the tool (July 2026, end of Fable 5 session)

Audience: the next model/dev session (and the operator). Read `CLAUDE.md` first
for the hard rules; this file is the running state.

## What shipped recently (newest first)

| Commit | What it is |
|---|---|
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

## Open issues / next work (priority order)

0. **Known low-severity residuals from the specs-fix review** (accepted, documented):
   (a) after the equipment pass fills a dup-labeled PV "Model", a same-labeled
   non-PV field revealed LATER is hidden from the planner's rescan filter
   (alreadyFilledLabels is bare-label keyed at ~line 1965) — fix by keying that
   filter on section+label if it ever bites; (b) on a fully sectionless page, a
   bare unlabeled Manufacturer/Model within 3 fields of PV fields (and not
   matching the negative guard) can still inherit the PV side — the proximity
   bound + guard-reset make this narrow.
1. **Verify the specs-page fix live** on the PGE stage run (Javier project).
   The root cause found: bare labels ("Manufacturer"/"Model") carry no side —
   fixed via `field.section` context; ALSO duplicate labels were permanently
   skipped after the first fill (alreadyFilledLabels dedupe) — the inverter
   section would never fill. Watch debug events `equipment_fill` in the bundle.
   If it still stalls, suspect: (a) PowerClerk renders the model select as a
   custom searchable combobox in some templates (see `fillCustomCombobox`);
   (b) section extraction returning "" on their DOM — check `p00N-plan.json`
   `fieldsSeen[].section` in the bundle.
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
