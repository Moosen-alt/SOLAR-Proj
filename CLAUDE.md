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
6. Tenant data never crosses orgs. New `/api/*` routes are DENY-BY-DEFAULT
   (`entitlementGate`); anything under `/api/projects/:id`, `/api/clients/:id`,
   `/api/customers/:id` inherits a scope guard automatically. A route at a NEW
   top-level path must be scoped or justified in `routeScope.test.ts`, which
   fails until you do. Out-of-scope returns 404, never 403.

## Tenancy model (two grains — don't conflate them)

- **`client`** = the solar company the work is FOR. On `projects`,
  `portal_credentials` (NOT NULL), `customers`, `portal_profiles`. Carries the
  licence/business fields. This is the service-bureau grain.
- **`org`** = the tenant that LOGS IN and holds a licence. On `users`,
  `api_keys`, `review_submissions`, and (migration v11) `projects`, `clients`,
  `customers`, `email_tracking_sources`, `job_queue`, `communications`.
  Child rows (qc_results, submissions, documents, corrections…) reach an org
  through their project — do NOT add `org_id` to them.
- Data-layer convention: an org filter of `string | null`, where `null` means
  "read across every org" (superadmin) and omitting it means the default tenant.
  Never an optional trailing `orgId?` — that fails open when forgotten.
- Enforcement lives at the ROUTE EDGE, not the data layer, so background work
  (scheduler, job queue, permit monitor) can run as system with no principal.

**Products/entitlements**: `orgs.edition` is a legacy display label. What an org
can reach comes from `org_entitlements` rows against the registry in
`entitlements.ts` — which is also the single source of truth for the API-key
allowlist (401) and the licensing gate (403), so they cannot desync.

**Shared knowledge is shared ON PURPOSE**: `permit_utility_knowledge`,
`jurisdiction_code_profiles`, `ahj_form_templates`, `portal_recipes`,
`cec_equipment`. An AHJ's portal quirk learned once should help every tenant —
that pooled knowledge is the product's core asset. Only
`historical_failure_examples` (which carries homeowner names/addresses) is
org-scoped. Do not "fix" the shared tables by scoping them without a decision.

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

Deploying/hosting: `docs/SERVER_SETUP.md`. Dev onboarding: `docs/DEVELOPER_ONBOARDING.md`.
Product packets: `docs/products/`. See `docs/HANDOFF.md` for the running state, open issues, and what to verify
live after each pull.
