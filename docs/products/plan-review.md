# Plan Review API — onboarding packet (for AHJs / plan-review firms)

**What it is:** upload a residential solar plan set (PDF) or a structured
project description; get back a reviewer report — blockers, warnings, passes —
with each finding citing YOUR jurisdiction's adopted code editions and local
amendments (NEC/IRC/IBC/IFC, design criteria: wind, snow, seismic). Built from
the same engine a submission company uses to pre-clear plans before they reach
your counter.

## Quick start

1. You'll receive an API key. Send it as `x-api-key` on every call.
2. Review a plan set PDF:
   ```
   curl -X POST https://<host>/api/review/upload \
     -H "x-api-key: $KEY" \
     -H "Content-Type: application/pdf" \
     -H 'x-review-subject: {"workType":"solar_pv_roof","state":"OR","ahj":"City of Woodburn","systemSizeDcKw":10.1}' \
     --data-binary @planset.pdf
   ```
   → `201 {"submissionId":..., "report":{findings:[{severity,title,codeReference,...}]}, "aiSummary":...}`
3. Or JSON-only (no PDF): `POST /api/review` with the subject fields in the body.
4. List past reviews: `GET /api/review/submissions` (your org's only).
5. Each submission has a shareable read-only report link for applicants.

## What the findings look like

Every finding carries: severity (`blocker|warning|pass`), title, plain-English
requirement, and a `codeReference` — code + edition + section + adoption scope.
If your jurisdiction's profile is human-verified, citations are authoritative;
otherwise they're phrased "verify locally". Ask us to verify your profile
(one-time setup: adopted editions, local amendments, wind/snow criteria).

## Limits & behavior

- Monthly quota per contract; 402/429 past quota.
- PDFs to ~100 MB; average review under a minute.
- The AI layer summarizes and vision-checks sheets; the code findings
  themselves are deterministic rules over your profile — same input, same output.
- Your data is isolated per-org and never trains anyone else's results.
