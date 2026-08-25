# Developer Onboarding — Solar Submission Autopilot

For a new engineer (or AI session) taking over. Read `CLAUDE.md` (rules +
gotchas) and `docs/HANDOFF.md` (running state) alongside this.

## What the product does

Automates residential solar **permit** (AHJ/city/county) and **NEM/
interconnection** (utility) submissions end-to-end, with a human always making
the final click: parse plan set → QC → reviewer gate (code citations per
jurisdiction) → build + fill AHJ documents → stage the portal application
(learned automation) → human verifies + submits. Everything the system does
once is stored/learned so the next project in that jurisdiction is faster.

## Stack + layout

- Node 20+, TypeScript everywhere, **no build step** (`tsx` runs TS directly).
- `backend/src` — Express API + better-sqlite3. One DB file
  (`AUTOPILOT_DB_PATH`); schema created idempotently in `db.ts` + versioned
  migrations (currently v9).
- `portal-bot/src` — Playwright. `adapters/autoLearnAdapter.ts` is the
  universal learner (extract fields → LLM planner + deterministic passes →
  record replayable recipe). `adapters/recipeAdapter.ts` replays.
  `humanCapture.ts` records human demonstrations as recipe patches.
- `frontend/dashboard.js` — single-file vanilla JS SPA served by the backend.
- `shared/src/types.ts` — the ONLY shared type surface.
- Tests: plain tsx scripts chained in package.json (`backend:test:unit`,
  `portal:test:unit`); `npm run smoke` is the end-to-end gate.

## The five core flows (follow one file each to learn the system)

1. **Intake/parse** → `repository.createProject` / parser payload →
   `qc.ts` rules → `reviewerEngine.ts` (findings cite adopted codes via
   `codeProfiles.ts` `resolveEffectiveCodeContext` — layered state+AHJ, fuzzy
   name matching, "verify locally" phrasing for seeded data).
2. **Docs** → `applicationDocs.ts` (HTML docs), `ahjForms.ts` +
   `ahjFormAuto.ts` (official PDF acquisition: research → download → AcroForm/
   vision-overlay field map → stored template → auto-filled per project;
   `ensureAhjFormsForProject` acquires the AHJ's full form SET).
3. **Staging** → `repository.prepareSubmission`: payment gate (per-submission
   billing) → QC/reviewer/doc gates → portal resolution (recipe → KB → fuzzy →
   statewide OR → cold-start web research) → recipe replay or auto-learn
   self-seed → stops at review screen for the human.
4. **Learning** → `autoLearn.ts` (planner context: secret-stripped project
   fields + design-notes digest + fuzzy KB context) + `portalRecipes.ts`
   (recording, staleness, human patches) + `knowledgeBase.ts` (the KB:
   `permit_utility_knowledge`, fuzzy resolution, research, imports) +
   `noteTopics.ts` (self-teaching digest topics).
5. **Post-submit** → `permitMonitor.ts` (status checks), `corrections.ts` +
   `correctionAgent.ts` (LLM triage, human-approved data updates, lifecycle
   closed by `/api/corrections/:id/apply|resolve`), `runTriage.ts` (reads
   learn-run debug bundles, applies safe fixes), KPI/fee history learning.

## LLM usage (llm.ts)

Single provider class; **stub mode without ANTHROPIC_API_KEY** (deterministic,
CI-safe — every feature must degrade gracefully in stub). Cost disciplines:
prompt caching (`cachedSystem`), compact digests instead of raw parser text,
one planner call per page + deterministic passes for anything answerable from
project data. `runToolAgent` is a bounded tool-loop for the two edge agents;
tools are narrow local handlers only.

## Key tables

`projects` (+parser_json snapshot) · `permit_utility_knowledge` (the KB) ·
`jurisdiction_code_profiles` (adopted codes) · `portal_recipes`/steps ·
`ahj_form_templates` (blank PDFs + field maps) · `submission_payments` +
`permit_fee_history` · `corrections` + `human_review_items` · `jobs` (queue) ·
`orgs`/`api_keys` (SaaS review API) · `learned_note_topics` · `audit_logs`.

## Safety invariants (non-negotiable — see CLAUDE.md)

Never final-submit / pay portal fees / solve MFA-CAPTCHA; secrets never reach
the LLM; human-verified data never auto-overwritten; permit↔NEM portals never
cross; agent writes require human approval.

## SaaS split map (how to sell pieces)

The review gate is ALREADY multi-tenant: migration v7 added `orgs` +
`api_keys`; `POST /api/review` (JSON subject) and `POST /api/review/upload`
(plan-set PDF + `x-review-subject` header) run the full reviewer engine
standalone with per-org quotas (`checkReviewQuota`), row isolation, shareable
report links, and a scoped role that 403s the rest of the product
(`reviewApi.test.ts` proves isolation end-to-end). To sell to an AHJ: issue an
org API key, point them at those two endpoints, load their county's code
profile (verified), done.

Other clean seams, in order of effort:
1. **Plan review for AHJs** (above — ready today; add Stripe metering to
   `checkReviewQuota`).
2. **Code-profile API** — `resolveEffectiveCodeContext` as a per-jurisdiction
   lookup; data moat is `jurisdiction_code_profiles` + verification workflow.
3. **Form-fill service** — `ahj_form_templates` + `buildFilledFormsForProject`:
   POST project fields, get filled official PDFs. Templates are the moat.
4. **Fee quoting** — `submissionFees.ts` + `permit_fee_history` (real observed
   fees per AHJ).
5. **KB/research API** — `knowledgeBase` + research endpoints: requirements,
   portal, timelines per AHJ/utility.
The dependency to watch when splitting: everything imports `db.ts` and
`shared/src/types.ts`; keep modules free of cross-imports into `repository.ts`
(the monolith glue) and extraction stays cheap.

## Dev workflow

`npm run dev` (server on :4000 by default) · scratch DB via
`AUTOPILOT_DB_PATH` env · `SEED_TEST_INSTALLER=true` to pre-seed the TML test
installer in a dev DB (default OFF — production databases start empty) · `npm run typecheck && npm run smoke &&
npm run backend:test:unit && npm run portal:test:unit` before every push ·
every bug fix ships with a regression test in the chain · risky data-path
changes get an adversarial review before merging (this practice has caught
data-destroying bugs twice in one week — keep it).

## Cold-start behavior (new AHJ/utility)

See the table in `docs/HANDOFF.md` — every unknown has a look-up-or-research
path, verified by `backend/test/coldStartReadiness`-style checks and a live
battery run across ID/FL/TX/NJ/CA/WA during handoff. Known data-quality note:
some imported utility rows carry truncated names (the reference sheet's
name column); junk state-name/numeric rows are guarded out of matching.
