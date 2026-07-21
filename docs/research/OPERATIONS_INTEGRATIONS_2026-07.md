# Operations & official-integration research — portal automation (July 2026)

Third deep-research run, targeting the two angles the architecture review left
unverified (bot-detection/compliance posture; official API paths). 106 agents,
full adversarial verification: findings below marked CONFIRMED survived 3-judge
panels against primary sources.

## Headline

**PowerClerk and Accela both have real, documented official API paths** — the
"official-integration routing tier above browser automation" recommended by the
architecture review is buildable today for our two most important platforms.
**No hard ToS blocker was found anywhere**, and our human-in-the-loop
login/MFA/final-submit design matches UiPath's officially recommended
compliance pattern for credentialed automation.

## Ranked API paths (build order)

1. **PowerClerk API V2** (CONFIRMED 3-0,
   [apidocs.powerclerk.com](https://apidocs.powerclerk.com/),
   [support.cleanpower.com](https://support.cleanpower.com/powerclerk/api/)).
   Publicly documented (Postman collection), covers the FULL applicant
   workflow: project creation, data entry/editing, form submission, status
   changes, attachment upload/download. This can replace browser automation of
   PowerClerk outright where enabled. Access is gated, not self-serve: keys
   issued manually by CPR Customer Success (~one limited-throughput key,
   ~60 tx/min), production requires the utility's Program Designer approval
   per program; pricing unpublished. OAuth 2.0 client credentials, 60-min
   bearer tokens; MFA handled at provisioning, not per call. ⚠️ Legacy API is
   removed during 2026 — build V2 only.
   ⚠️ REFUTED (0-3): "the API is positioned only for utilities/program
   administrators, not applicants" — third-party applicant use is plausible,
   but utility-by-utility approval determines real coverage.

2. **Accela Construct/Civic Platform API** (CONFIRMED 3-0,
   [developer.accela.com](https://developer.accela.com/)). Self-serve
   developer registration (App ID/Secret, OAuth2/CivicID, no sales gate) and a
   **Citizen Access API**: apply for permits, schedule inspections, manage
   documents programmatically. Crucially, it supports a **delegate model** —
   an installer's citizen account can grant a delegate permission to view,
   create/renew/amend records, schedule inspections, manage documents, and pay
   (CONFIRMED 3-0) — a documented, compliant structure for us acting on an
   installer's behalf. Practical gate: each AHJ's tenant must enable/authorize
   the app. Commercial gate (CONFIRMED): the Developer ToS forbids
   commercially distributing an app built on Accela's resources without an
   agreement with Accela — selling an Accela integration needs Accela
   authorization first.

3. **Tyler EnerGov** (CONFIRMED 3-0/2-1 mixed): no public API path. Tyler's
   public API catalog covers only Enterprise ERP (Munis); EnerGov API docs
   exist but are distributed privately to client agencies (LA County board
   records list "Deliver and Discuss EnerGov API Documentation" as a Tyler
   deliverable). Third-party access means going through Tyler and/or the
   agency. Keep browser automation for EnerGov.
   ⚠️ REFUTED (1-2): "FOIA can't obtain the docs" — one FOIA attempt didn't
   surface them, but that's not proof it can't work.

4. **Avolve ProjectDox / SolarAPP+ API / UtilityAPI**: nothing survived
   verification. Keep browser automation for ProjectDox; SolarAPP+'s
   installer API remains an open question worth a direct read of
   developers.cleanpower.com when building the routing tier.

## Compliance findings

- **Accela ToS**: no clause prohibiting bots/scraping/automated submission in
  the corporate Terms of Use (CONFIRMED 3-0). ⚠️ REFUTED (0-3): the claim
  that those terms are irrelevant to AHJ portals — but note the inverse also
  holds: each AHJ-hosted Citizen Access portal carries its OWN agency terms,
  and those remain unexamined. Check the agency's portal terms per
  jurisdiction at onboarding.
- **Human-in-the-loop is the vendor-endorsed pattern** (CONFIRMED 3-0,
  [UiPath ICAM guidance](https://assets.ctfassets.net/5965pury2lcm/42wrZZJMZWORVfGGJwSVyT/0e2966a58b8c92ce41adecd9604883be/UiPath_Robot_ICAM_Guidance.pdf)):
  attended robots inherit the human user's credentials — pause, prompt the
  human to perform login/MFA, resume on a post-login trigger. This is exactly
  our portal-pause design; it is established practice, not a workaround.
- **No documented cases** of permit-tech companies being blocked or
  sanctioned survived verification (absence of evidence, not proof of
  absence).

## Compliance/ops checklist (at tens of submissions/day)

1. Route through official APIs where enabled (PowerClerk V2; Accela with
   agency authorization + Accela commercial agreement) before browser
   automation — per jurisdiction/utility, not globally.
2. On Accela portals, use the delegate model rather than sharing installer
   credentials where the AHJ supports it.
3. Keep every login/MFA/final-submit human-attended (already a hard rule).
4. Read the agency-specific portal terms at AHJ onboarding; record in the KB.
5. Persistent authenticated sessions + low steady rates (our volume is well
   under any plausible threshold; PowerClerk's own API key throughput is
   ~60 tx/min — treat that as the ceiling mindset for browser traffic too).
6. Before selling an Accela-integrated product commercially, get the Accela
   developer agreement in place.

## Unfilled gaps (still no verified claims — treat as unknown)

- WAF/bot-management posture of live Accela/EnerGov/ProjectDox/PowerClerk
  deployments (Cloudflare/Akamai presence unconfirmed either way).
- Credential-custody compliance frameworks for holding installer-supplied
  portal credentials (checklist above rests largely on one 2019 UiPath doc).
- Pricing for PowerClerk integration bundles and Accela commercial
  agreements — requires direct vendor contact.
- Which specific utilities/AHJs enable third-party API access — discoverable
  only per program/tenant in practice.
