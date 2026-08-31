# Illinois Onboarding Dossier

Deep-research sweep, 2026-08-30 (6 web researchers + 1 verifier, 363 source fetches).
Everything here is **research-grade ("seeded")** — human verification still gates trust.
The same findings were seeded into the shared KB (43 rows,
`sourceLabel: "IL deep research (web, 2026-08-30)"`); this file is the narrative and the
day-one plan. Confidence markers: ✅ confirmed against an official source · 🟡 likely ·
❓ uncertain/open.

## The two-line summary

**Ameren Illinois is PowerClerk — our most battle-tested platform — and ComEd is NOT**
(it's "Intellio Connect", a West Monroe platform at `interconnect.comed.com`). Ameren can
plausibly be at replay-to-review the same day logins + one real project arrive; ComEd
needs one first-encounter learn of a new-but-wizard-shaped portal. The AHJ side is a
platform patchwork with no statewide portal; each municipality is a first-encounter learn
or a PDF-package path, and the KB now carries a 38-jurisdiction head start.

---

## 1 · Utilities

### Ameren Illinois — PowerClerk ✅
- Portal: `https://amerenillinoisinterconnect.powerclerk.com/MvcAccount/Login` — program
  "Ameren Illinois - Interconnection Program" (contact RenewablesIllinois@ameren.com). ✅
- Level 1 flow = 5 PowerClerk tabs: Applicant Info → Contractor/Installer Info →
  Generator & Service Info → Documents → Payment. ✅
- **Quirks that will matter to automation** (all ✅ unless noted):
  - Account number: **10 digits, digits only, no dashes** (parse/bind accordingly).
  - Installer's ICC Part 468 docket number entered **digits-only** (16-0001 → `160001`).
  - Attachments **PDF-only**; signatures via **DocuSign** (a human-capture step class).
  - **The $50 Level 1 fee is paid by MAILED CHECK** within 15 business days of submission
    — no online payment; the application is not reviewed until the check lands. This maps
    perfectly onto our payment gate: automation stages, the operator mails the check.
  - Net-metering "Annual Period Anniversary Month" must be elected (April or October;
    April typical for solar).
  - Required docs (checklist rev 2.0, 6/16/2025): one-line diagram on EVERY install (AC+DC
    kW, protection, panels, meter #, POI, lockable utility-accessible disconnect; ESS
    systems must show ESS connection/disconnect/kWh/kW), inverter spec sheet with
    UL1741/IEEE1547 evidence; ESS Supplemental Form when storage is indicated.
  - Site hardware: lockable outdoor utility-accessible AC disconnect with the red 5"×7"
    engraved placard; second "multiple sources" placard if the disconnect is >10 ft from
    the meter.
  - **Witness test on every interconnection including Level 1** (within 15 business days
    of construction-complete docs; conditional PTO on site when passed).
- Rebate (Rider CGR): $300/kW-DC generator inverters; $300/kWh ESS 🟡; since 1/1/2025 the
  ESS rebate requires charging only from on-site renewables 🟡.
- ❓ Do NOT use the 3.84¢/3.39¢ per-kWh figures on ameren.com/service/renewables/solar —
  those appear to be Ameren MISSOURI avoided-cost rates.

### ComEd — Intellio Connect (NOT PowerClerk) ✅
- Portal: `https://interconnect.comed.com` — login titled **"Intellio Connect"** (West
  Monroe; formerly "ConnectTheGrid" per ICC docket P2022-0486). `comed.powerclerk.com`
  redirects to Clean Power Research's marketing page — no tenant. ✅
- Program brand "My Green Power Connection"; the DER interconnection application INCLUDES
  net metering (no separate NEM application). ✅
- Level 1 fee $50 (fee table also: pre-application report $300, Level 2 $100+$1/kVA…). ✅
- **Level 1 application needs NO one-line or site plan** — it wants applicant/contractor
  info, account number, meter ID, inverter make/model + NRTL spec evidence, nameplate
  ratings, export-control settings, and a battery section (shared/separate inverter,
  grid-charging intent, kW/kWh, operating modes). Insurance: homeowner's/GL proof. ✅
- PTO stage: Certificate of Completion + inverter nameplate photos + **proof of AHJ
  electrical inspection** + as-builts. Operating before PTO ⇒ disconnection. ✅
- Witness test discretionary for lab-certified Level 1 (deemed waived if not performed
  within 10 business days of commissioning). ✅
- Rebate (Rider DG REBATE, 16-107.6): $300/kW DG + $300/kWh storage (residential/small);
  requires smart-inverter interconnection (post-8/11/2022) with ComEd operational control
  per its published smart-inverter settings; filed at ComEd.com/DGRebate with itemized
  invoices, after PTO ✅ (whether installers may file with authorization: ❓).

### Both utilities / statute
- 83 Ill. Adm. Code **Part 466** (renamed 2022: "Electric Interconnection of Distributed
  Energy Resources Facilities"), Levels 1–4; residential rooftop ≈ always Level 1 (export
  ≤25 kW AND nameplate ≤50 kW, inverter-based, lab-certified). Level 1 clock: completeness
  7 business days → screens 15 → agreement windows; applicant signs within 30. ✅
- **Post-2024 netting** ("Smart Solar Billing" is informal branding, mostly ComEd's):
  systems interconnected on/after 1/1/2025 net SUPPLY(+transmission) charges only; the
  customer picks kWh netting vs monetary credits at application (Ameren treats the
  election as irreversible); credits roll forever. Grandfathering (pre-2025 full-retail)
  is forfeited by taking the DG rebate or major expansion. ✅
- Part 466 binds ICC-jurisdictional utilities only — **municipal utilities and co-ops are
  outside it** (note: Naperville runs its own municipal electric with its own
  interconnection rules ✅; SB25's 2026 "Solar Bill of Rights" guarantees co-op/muni
  customers may install rooftop solar 🟡).

---

## 2 · Licensing & program stack (what the installer entity needs)

1. **ICC Distributed Generation Installer Certificate** (83 Ill. Adm. Code Part 468) —
   statewide, mandatory for anyone installing DG (since 2014). $50 application; annual
   recert due April 1. Installs must be performed/supervised by a "qualified person"
   (5 prior installs of the technology, OR journeyman electrician, OR NABCEP/UL/ETA cert,
   OR approved associate degree). Chicago's permit form asks for this number. ✅
2. **Municipal electrical licensing** — Illinois has NO statewide electrician/electrical
   contractor license; every municipality/county licenses or registers locally (Chicago:
   City-licensed electrical contractor + supervising electrician). Budget per-AHJ
   registration into onboarding. ✅
3. **IDFPR Roofing Contractor license** (statewide) — the Act never mentions PV, so
   whether mounting/penetrations are "roofing work" is per-AHJ interpretation; have the
   license or a licensed sub. ✅
4. **Illinois Shines (ABP)**: sell through an IPA **Approved Vendor** — the installer does
   NOT need AV status itself; registering as an **Installer Designee** under an AV
   suffices (requires the active ICC DG cert). 15-year REC term for residential DG. ✅

---

## 3 · Codes (per-AHJ, with a statewide floor)

- No state-enforced building/electrical code for residential retrofits; **NEC editions
  observed range 2011→2023 by jurisdiction**. ✅
- PA 103-0510 (eff. 1/1/2025): every local code must meet an IBC/IEBC/IRC structural
  baseline and AHJs must report adopted title/edition to the **Capital Development
  Board — CDB's registry is a promising data source for per-AHJ code cycles** (open
  item). ✅
- Statewide energy code is now the **2024 IECC** (eff. 11/30/2025 — our seeded profile
  said 2021; corrected). Plumbing + Accessibility codes are also statewide. ✅

---

## 4 · City of Chicago

- **Express Permit Program** worktype "Small-Scale Solar Photovoltaic (PV) System"
  (launched 11/6/2023; replaced Easy Permit/Solar Express — same "EPP" acronym, different
  program). Apply at `ipi.cityofchicago.org`; plan-based jobs go through the Permit
  Portal + **E-Plan = ProjectDox (Avolve)** — the same platform family as Clark Co WA. ✅
- Express limits: inverter output ≤13.44 kW (70A); ESS ≤20 kWh (10 kWh non-Li);
  roof-mount on existing building only; avg roof height ≤40 ft (≤15 ft ballasted, none on
  sloped roofs); mechanical fasteners only; panel output ≤155% of inverter output. ✅
- **IL-licensed architect OR structural engineer drawings + calcs ALWAYS required for new
  installs at any size** (they must confirm roof adequacy; in-person pre-design
  inspection by/under that professional). Same-configuration replacement exempt. ✅
- Electrical: 2018 Chicago Electrical Code (Title 14E, 2017-NEC basis, metallic-conduit
  amendments; PV at 14E-6-690, ESS 14E-7-706) — still current as of this sweep 🟡
  (re-verify per project; 14E takes periodic amendments). Electrical drawing signed by a
  Chicago-licensed supervising electrician or IL arch/PE/SE. ✅
- Loads: minimum **25 psf snow in the field of the roof** + ASCE 7 drift where panel top
  edge >1.5 ft above roof; SEAOC PV2 accepted for tilted flat-roof arrays; ballasted
  always needs arch/SE and can't use Express. ✅
- Contractors on the application: City-licensed GC (Class A–E) + City-licensed electrical
  contractor (general) + ICC DG Installer cert number. ✅
- Fees 🟡: $225 flat under 13.44 kW (with ESS ≤20 kWh); ≥13.44 kW $250/array, $1,000 min.
- Fire setbacks: 3 ft roof edges/ridges/gables; hip-roof eave-to-ridge path; 18 in.
  hips/valleys when panels on both sides. ✅
- ComEd PTO in Chicago requires the DOB electrical inspection form sent to ComEd. ✅

---

## 5 · AHJ platform matrix (seeded to KB; ✅ unless marked)

**Chicagoland:** Naperville — Tyler EnerGov (+ its own municipal utility!) · Arlington
Heights — Tyler EnerGov (solar checklist PDF; ~10-day review) · Evanston — Accela
(`aca-prod.accela.com/Evanston`) · DuPage County — Accela (2020 NEC/2021 I-codes) ·
Bolingbrook — OpenGov (2017 NEC) · Skokie — BS&A · Will County — SmartGov · McHenry
County — SmartGov · Kane County — CityView 🟡 · Aurora — eTRAKiT 🟡 · Orland Park —
self-hosted Accela 🟡 (site refused bots) · Waukegan — MaintStar (arch/SE-stamped
structural assessment required) · **Cook County (unincorporated) — EMAIL intake**
(`intake.bnz@cookcountyil.gov`, ≤25MB; arch/SE report + registered county electrical
contractor; requirements PDF dated 2017 — re-verify) · Cicero — paper/in-person ❓.

**Downstate:** Rockford — Infor Rhythm + Avolve (2020 NEC; sealed drawings for solar) ·
Decatur — OpenGov · Champaign — OpenGov 🟡 (site 403s bots) · Urbana — Citizenserve ·
Bloomington — OpenGov-vs-forms ❓ · Springfield — email/paper (2017 NEC per official list;
ignore aggregator claims of 2023) · Peoria city — email/PDF (2018 I-codes/2017 NEC
harmonized regionally) · Peoria County — dedicated solar application form (6/2024) ·
Belleville/Edwardsville/counties — email/paper; Madison County booklet is 2012-era ❓ ·
**St. Clair County: interconnection approval letter + fire-department letter required
BEFORE the solar permit** — utility step precedes AHJ permit; sequencing matters ·
O'Fallon: new solar+ESS submittal requirements in effect 1/1/2026 incl. Ameren approval
prior to review 🟡.

**Automation note:** several official IL sites 403/500 automated fetches
(champaignil.gov, bloomingtonil.gov, ofallon.org, springfield.il.us…) while their PDFs
fetch fine — the learner should expect real-browser navigation, not raw fetches.

---

## 6 · Corrections applied to our seeded IL profile (verifier pass)

1. Energy code: 2021 IECC → **2024 IECC** (eff. 11/30/2025); IECC was never the "only"
   statewide code (Plumbing + Accessibility too). PA 103-0510 baseline added.
2. Part 466 renamed (DER Facilities, 2022). Confirmed as the interconnection rule.
3. Supply-only netting from 1/1/2025 confirmed (interconnection-complete by 5pm
   12/31/2024 was the grandfather trigger). "Smart Solar Billing" = informal name.
4. NEM individual cap: the seeded "≤2,000 kW AC" is the PRE-CEJA figure; current statute
   text conflicts across sources (5 MW per DSIRE) — ❓ open, practically moot for
   residential.
5. Rebate confirmed at $300/kW + $300/kWh (residential), smart inverter required,
   rebate forfeits legacy netting.
6. Illinois Shines: AV **or Installer Designee under an AV** (seeded row overstated);
   ICC DG cert confirmed mandatory.
7. Chicago: all five seeded claims confirmed, with precision fixes (arch OR SE; 25 psf is
   the minimum roof-field snow load; Express limits quantified).

---

## 7 · Day-one plan when logins arrive

1. Store credentials per client (encrypted, name-bound) for
   `amerenillinoisinterconnect.powerclerk.com` and `interconnect.comed.com`.
2. Read-only look at both portals (confirm login + landing shape; screenshot).
3. **Ameren first** (PowerClerk = proven): one real IL project (plan set + Ameren bill —
   remember 10-digit account) → parser intake → learn → replay → probe-certify. Expect
   the mailed-check payment gate and DocuSign human-capture step to surface as operator
   items — that is correct behavior.
4. **ComEd**: first-encounter learn of Intellio Connect on a real ComEd project — the
   no-drawings Level 1 form is *simpler* than PowerClerk; budget one fix-retry loop for
   a new platform's quirks.
5. AHJ side: start with the customer's actual first municipalities; Evanston/DuPage
   (Accela — proven platform) are the softest AHJ entries; Chicago Express is
   form-shaped and well-documented.
6. Before any REAL submission: ICC DG cert number, municipal electrical
   license/registration for the target AHJ, AV/Designee status — the licensing stack in
   §2.

## 8 · Open questions (carried in the KB rows too)

- ComEd rebate filing by installers-with-authorization; Intellio Connect form internals
  (unlearned until credentials).
- Whether Chicago has amended Title 14E past the 2017-NEC basis (verify manually).
- Current statutory individual NEM cap text (ilga.gov blocked the old URL pattern).
- MidAmerican + municipal utilities + co-ops (Part 466 does not bind munis/co-ops).
- CDB code-registry as a per-AHJ code-cycle data source (PA 103-0510 §10.18).
- Per-AHJ items flagged ❓ in §5 (Normal NEC, Sangamon, Champaign County scope,
  Bloomington system-of-record, Madison/St. Clair code currency, O'Fallon doc fetch,
  Peoria County checklist contents, Belleville fees).
