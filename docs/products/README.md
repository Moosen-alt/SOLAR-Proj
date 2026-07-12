# Product Packets — the Autopilot, split into sellable tools

Each packet is a customer-facing onboarding doc plus the operator steps to
provision it. The **Plan Review API is production-multi-tenant today**; the
others share its org/API-key plumbing and are "expose + meter" away from sale.

| Packet | Product | Status |
|---|---|---|
| `plan-review.md` | AI plan review per the AHJ's adopted codes | **Ready now** |
| `code-profiles.md` | Adopted-codes + design-criteria lookup API | Endpoint exists (read-only) |
| `form-fill.md` | Official AHJ form auto-fill service | Internal endpoints; thin wrapper to expose |
| `fee-quotes.md` | Real-fee permit quoting API | Internal endpoints; thin wrapper to expose |
| `kb-research.md` | AHJ/utility requirements + portal knowledge API | Internal endpoints; thin wrapper to expose |

## Provisioning a customer (operator runbook — same for every product)

1. Create the org: `POST /api/orgs {"name":"City of X Building Dept","role":"review_gate"}`
   — the `review_gate` role scopes the org to the review endpoints ONLY (403 on
   the rest of the product; proven by `backend/test/reviewApi.test.ts`).
2. Issue a key: `POST /api/orgs/:id/api-keys {"name":"prod"}` — the key is
   returned ONCE (stored as sha256). Deactivate by flipping `active` in `api_keys`.
3. Customer sends `x-api-key: <key>` on every request.
4. Quotas: `checkReviewQuota` (server.ts) enforces per-org monthly limits —
   set the org's quota column; wire Stripe metered billing there when ready.
5. Load their jurisdiction's code profile and mark it VERIFIED
   (`saveVerifiedCodeProfile` / the dashboard Code Profiles panel) so findings
   cite authoritatively instead of "verify locally".

## Shared platform notes

- Auth: `x-api-key` header → org row; keys hashed at rest; shown once.
- Isolation: all product rows carry `org_id`; cross-org reads are filtered.
- Every packet's API is stub-safe: without ANTHROPIC_API_KEY, deterministic
  layers still run (rules, profiles, templates); only AI summaries degrade.
- SLAs to promise safely: review < 60s/plan set; form-fill < 10s; lookups < 1s.
