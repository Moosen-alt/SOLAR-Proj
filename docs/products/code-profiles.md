# Code Profile API — onboarding packet

**What it is:** per-jurisdiction adopted-code lookup: NEC/IRC/IBC/IFC editions,
local amendments, design criteria (wind mph, ground snow psf, seismic, frost),
prescriptive-path limits, fire setbacks — layered (county/city over state
default), fuzzy name matching ("Elmore County, ID" → "Elmore County"), with a
confidence flag (`verified` = human-confirmed; `seeded` = researched, verify).

## Use

- `GET /api/code-profiles/resolve?state=ID&ahj=Elmore%20County` → `{ profile }`
  (list: `GET /api/code-profiles`; LLM research: `POST /api/code-profiles/research`)
  (today's internal endpoint; the sellable wrapper adds `x-api-key` + org scoping — see
  README provisioning).
- Response fields mirror `JurisdictionCodeProfile` in `shared/src/types.ts`.
- Null profile → caller should treat as "model-code defaults, verify locally".

## Operator notes

- Data sources: reference imports (`npm run import:reference`), LLM research
  (`saveResearchedCodeProfile`, never overwrites verified), human verification
  (`saveVerifiedCodeProfile`, audited).
- Sell as: per-lookup metering or flat per-state licensing. The moat is the
  verified rows — prioritize verifying jurisdictions customers actually query.
