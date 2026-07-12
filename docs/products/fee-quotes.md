# Permit Fee Quote API — onboarding packet

**What it is:** what a residential solar permit/interconnection will actually
cost in a jurisdiction. Resolution: (1) real portal-calculated fee when known,
(2) median of REAL fees previously observed there (`permit_fee_history` —
fuzzy AHJ matching), (3) transparent valuation-based estimate (labeled rough).

## Use (current internal endpoints)

- Quote: `GET /api/projects/:id/payment-quote?track=permit|nem` →
  `{ quote: { permitFeeUsd, permitFeeSource, permitFeeBasis, serviceFeeUsd, totalUsd } }`
- True-up with the real fee (teaches the history): `POST
  /api/projects/:id/payment/record-fee {track, actualPermitFeeUsd}`.
- Env knobs: PERMIT_FEE_ESTIMATE_RATE/MIN/MAX, NEM_FEE_ESTIMATE_USD,
  SUBMISSION_SERVICE_FEE_USD.

## Sellable shape

`GET /fee-quote?state&ahj&valuation` for installers/lenders. Accuracy compounds
as history rows accumulate — quote the source honestly (`actual`/
`learned_history`/`valuation_estimate`) so customers can price risk.
