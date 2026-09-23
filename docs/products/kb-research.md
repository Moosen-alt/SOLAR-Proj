# AHJ/Utility Knowledge API — onboarding packet

**What it is:** the requirements brain: per AHJ/utility — portal name/URL/
platform, submission method, required documents, timelines, common correction
reasons, NEM specifics (disconnect rules, smart-inverter election, export
limits). Fuzzy name resolution; unknown jurisdictions auto-researched
(web-grounded) and saved seeded for next time.

## Use (current internal endpoints)

- Lookup: `GET /api/knowledge-base` (list) — the sellable wrapper is
  `GET /kb?state&ahj|utility` returning the matched profile via
  `findKnowledgeForLearn`.
- Research an unknown on demand: `POST /api/knowledge-base/research-ahj
  {ahj,state}` / `POST /api/knowledge-base/research-utility {utility,state}` —
  results land seeded + needsHumanVerification.
- Link health: `POST /api/kb/check-links` — portal URLs swept, dead ones
  re-researched; statuses on each row (`ok/unknown/dead/replaced`).

## Trust model

Rows with `verified_at` set (`isVerifiedKnowledge`) are human-verified and never
auto-overwritten — `confidence: "mixed"` is a provenance label, not the lock;
`seeded` rows say so — surface that flag to customers. Data isolation and the
one-time-shown API keys follow the README provisioning runbook.
