# SOLAR-Proj — Solar Submission Autopilot

Node/TypeScript monorepo that automates residential solar permit + NEM
(interconnection) submissions: parse plan sets → QC → reviewer gate → build/fill
AHJ documents → stage the portal application → human verifies + submits.

## Layout

- `backend/src` — Express API + SQLite (better-sqlite3), all business logic.
- `portal-bot/src` — Playwright automation (auto-learn, recipes, human capture).
- `frontend/` — single-page vanilla-JS dashboard (`dashboard.js`, no framework).
- `shared/src/types.ts` — the single shared type surface. Add types here first.
- `backend/test`, `portal-bot/src/**/*.test.ts` — plain tsx test scripts (no runner).

## Commands

- `npm run typecheck` — tsc, no emit. (A pre-existing nodemailer types error may
  appear in some environments; everything else must be clean.)
- `npm run smoke` — full end-to-end on a scratch DB. Must stay green.
- `npm run backend:test:unit` / `npm run portal:test:unit` — unit suites (chained
  `&&`, so the FIRST failure stops the chain — later tests may not have run).
- `npm run portal:test:dom` — real-Chromium extraction smoke.
- `npx tsx portal-bot/src/adapters/powerClerkSpecs.dom.smoke.ts` — real-browser
  PowerClerk specs-page cascade smoke (equipment dropdowns).
- `npm run import:reference -- <files.xlsx> [--dry-run]` — import operator
  reference spreadsheets into the KB.

## Hard safety rules (never regress these)

1. Automation NEVER clicks final submit, NEVER pays portal fees, NEVER solves
   CAPTCHA/MFA. Recorded as steps (`isFinalSubmit:true`), executed by a human.
2. Secrets (passwords, account/meter numbers, SSN) never reach the LLM —
   stripped in `buildPortalPlanner`; sensitive fields bind by name, not literal.
3. Human-verified knowledge is never auto-overwritten: `confidence === "mixed"`
   in `permit_utility_knowledge`, `"verified"` in `jurisdiction_code_profiles`,
   `map.verified` on form templates. Imports/research land as `seeded`.
4. Agent tools are narrow local handlers (no shell/network); agent data-update
   proposals require human approval (`/api/corrections/:id/apply`).
5. A permit track must never resolve/launch a utility portal URL (PowerClerk)
   and vice versa — see `permitSafeUrl` + track-scoped lookups in repository.ts.

## Architecture notes (things that will bite you)

- `openDatabase()` is async, takes NO path — reads `AUTOPILOT_DB_PATH` env.
  Tests must set the env var BEFORE importing `../src/db`.
- `db.ts` migration order matters: `addColumnIfMissing` must come AFTER the
  table's CREATE block. Versioned migrations run from `MAX(version)` — a test
  replaying migration N must delete schema_meta rows `WHERE version >= N`.
- KB notes are `" | "`-joined SEGMENTS. Merge/dedupe by segment
  (`noteSegments`), never by whole blob. Cap is generous (40) on purpose:
  reference imports legitimately carry 16 labeled fields.
- Fuzzy name resolution (`knowledgeNameMatchScore`, `findKnowledgeForLearn`)
  bridges operator short names ("PGE", "APS") to imported legal names. Exact
  profile-key hits always win over fuzzy. State mismatch always loses.
- LLM cost: the planner gets a compact `designNotesDigest`, NOT raw parser
  text (long blobs excluded in `resolveRecipeFieldValues`). Keep it that way —
  regressing this costs ~$10/run.
- `jobQueue` statically imports `repository`; anything in repository that needs
  jobQueue must use a dynamic `import()` (circular-import guard).
- Frontend `esc()` everything interpolated into innerHTML.
- PowerClerk quirks: per-field autosave requires blur after fill; date inputs
  pop a picker that must be Escape-dismissed; equipment certified names differ
  from plan-set names (see `EQUIPMENT_MAKE_ALIASES`); spec-page labels are BARE
  ("Manufacturer"/"Model") — side comes from `field.section`; model selects
  cascade-load ~600ms after manufacturer change.

## Current handoff notes

See `docs/HANDOFF.md` for the running state, open issues, and what to verify
live after each pull.
