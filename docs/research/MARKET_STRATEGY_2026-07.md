# Market & strategy research — solar permitting/NEM automation (July 2026)

Deep-research run with adversarial verification: 24 sources fetched, 106 claims
extracted, top 25 verified by independent 3-judge panels → **23 confirmed,
2 refuted**. The harness's final synthesis step hit an API limit, so the
synthesis below was written by the operator's agent from the verified claims;
each bullet's verification status is marked. Claims labeled *(unverified)*
come from extraction only and did not get a panel.

## Competitive landscape (all CONFIRMED 3-0 unless noted)

- **Symbium**: $50 per plan check, single STANDARD tier — the per-transaction
  pricing anchor. Go-to-market is organized around state instant-permitting
  mandates (CA SB 379, Colorado, Maryland BTA). ([pricing](https://symbium.com/pricing/))
- **SolarAPP+**: instant permit issuance ("minutes, not weeks"); free for AHJs
  to pilot/adopt (installer fees fund it); automated plan review with
  compliance checks; scope limited to Solar / Solar+Storage / MPU / Main
  Breaker Derate — **no utility interconnection/NEM capability**. Adoption is
  jurisdiction-by-jurisdiction ("new jurisdictions join each week"), so most US
  AHJs are uncovered. Syncs its equipment DB with the CEC list weekly (Sundays).
- **Lyra Solar**: design tool generating downloadable permit packages —
  not submission/tracking/interconnection automation.
  ⚠️ REFUTED (1-2): "Lyra competes as an embeddable API/design engine."
- **GreenLancer**: human design-services marketplace (outsourced plan sets),
  1–2 business day turnaround (2-1 vote) — the incumbent speed benchmark.
  ⚠️ REFUTED (0-3): "GreenLancer's interconnection support is limited to line
  diagrams / no NEM-portal claim" — do NOT cite interconnection as
  white space on the basis of GreenLancer's site.
- **PermitFlow** *(unverified)*: opaque subscription pricing, minimum monthly
  fee, no free trial; general construction permitting, not solar-specialized.

**White space that survived verification**: the utility interconnection/NEM
side (SolarAPP+ explicitly does not touch it) and the long tail of AHJs that
SolarAPP+/Symbium haven't reached. That is exactly where this platform sits.

## Market sizing (all CONFIRMED 3-0, SEIA/Wood Mackenzie primary sources)

- 2025 residential: 4,647 MWdc, −2% vs 2024 — permit volume roughly flat
  despite the 25D expiration rush. Distributed solar overall: 8.4 GWdc, −5%.
- The One Big Beautiful Bill Act killed the Section 25D customer-ownership ITC
  at end of 2025, pulling demand forward — the main 2026 headwind.
- 2026 forecast: **19–21% residential contraction** (both SEIA report vintages
  confirmed), cushioned by TPO ITC eligibility; Q1 2026 actuals 1,179 MWdc
  (+6% YoY, −15% QoQ).
- Recovery from 2027 at ~6%/yr through 2031; >60 GWdc added 2026–2036.
- Fragmentation: Sunrun, the largest installer, holds only 12.7% share (10.8%
  in Q4 2025); Freedom Forever 6.1%. The long tail of small/mid installers is
  the buyer. *(unverified: ~11,054 US solar installation businesses in 2026,
  +2% YoY — IBISWorld; a record 45% of Q1-2026 residential installs paired
  with batteries — taiyangnews.)*

## Data moat: CEC equipment lists (CONFIRMED 3-0)

- The CEC lists cover PV modules, inverters (incl. smart), meters,
  batteries/ESS, and PCS — the categories a permitting/interconnection
  platform must validate against.
- Updated **three times per month** (~1st, 11th, 21st) — a sync must run on
  ~10-day cadence to stay current. → Our `CEC_SYNC_DAYS` default of 7 is
  correct; SolarAPP+ itself syncs weekly.
- The raw lists are freely downloadable (2-0) — the data itself is NOT a moat;
  value comes from integration and normalization (certified-name aliasing into
  portal dropdowns, offline spec lookup, QC validation — shipped in `a995bd5`).

## Regulatory & infrastructure (extraction-only, *unverified* — treat as leads)

- CA SB 379 mandates automated permitting platforms for cities >50k
  (real-time permits up to 38.4 kW AC); Symbium's whole GTM rides such
  mandates — mandates are a channel, and also a threat where they route
  volume into government-side platforms.
- Managed browsers: Browserbase ~$20/mo per 100 browser-hours ($99/500hrs,
  $0.10/hr overage); Browserless $140–350/mo tiers. Self-hosted Playwright
  remains cheapest at current volume.
- SOC 2: ~$30k–150k total in 2026 (small SaaS at the $30–50k end); Type 1
  audit alone $5k–25k. Defer until the first AHJ/utility RFP requires it.
- Stripe's legacy advanced usage-billing docs are gone; Stripe now steers new
  usage-based integrations to Metronome — factor into the (deferred) metering
  build.

## Strategy implications

1. **Lead commercially with the interconnection/NEM side + long-tail AHJ
   automation** — the only verified white space; nobody automates
   applicant-side portal submission there.
2. **Price against $50/plan-check (Symbium) and free-to-AHJ (SolarAPP+)**:
   AHJ-side products must be free-ish or fee-funded; installer-side
   per-submission pricing has a confirmed anchor.
3. **2026 is a contraction year (−19–21%)** — sell efficiency ("do the same
   permits with less back-office"), plan revenue growth against the 2027+
   recovery and rising battery attach.
4. Infrastructure order stands: CEC sync (done) → self-heal durability (done)
   → Stripe/Metronome metering later → Postgres/queue + managed browsers at
   multi-team scale → SOC 2 at first procurement ask.
