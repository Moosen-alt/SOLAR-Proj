# Go-live ops: WAF/bot posture, credential custody, legal precedent (July 2026)

Fourth deep-research run (universal browser automation is the strategy;
official APIs are opportunistic-only per the operator's PowerClerk
confirmation). **Now FULLY VERIFIED** — the resume completed all 105 agents
(107 claims from 23 sources, top 25 panel-verified → 21 confirmed, 4 refuted,
0 unverified; 11 synthesized findings). Findings below are CONFIRMED by 3-0
adversarial panels against the cited primary sources unless noted. Two WAF
findings (PowerClerk) also rest on **my own live header probe of 2026-07-21**.

## Bottom line

At tens-of-submissions/day, human-attended, with the installer's own
credentials, the realistic block risk is **low** and the legal risk profile is
**fundamentally different from scraping** — but Accela and PowerClerk both sit
behind Cloudflare (incl. bot-management signals), so *how* the browser is run
matters. Run real headed Chromium with persistent sessions from a
residential-grade IP, never headless from a datacenter range, and the
human-does-login/MFA rule already sidesteps the highest-friction gate.

## (a) Per-platform WAF / bot-risk

| Platform | Edge / WAF | Status | Realistic risk at our scale |
|---|---|---|---|
| **Accela Citizen Access** (multi-tenant `aca-prod.accela.com`) | **Two layers: Cloudflare edge → Azure App Gateway/WAF → IIS** | **CONFIRMED 3-0** + live probe | Low if headed + persistent session; `_cfuvid` (Cloudflare) + `ApplicationGatewayAffinity` (Azure) cookies both present |
| **PowerClerk** (Clean Power Research) | **Cloudflare w/ Bot Management** | **My live probe only** (panel did NOT independently confirm) | Low; `__cf_bm` bot-management cookie present — avoid headless/datacenter-IP fingerprints |
| **Tyler EnerGov CSS** | Unknown (Tyler-hosted; unreachable from this env) | **NOT confirmed** | Unknown — probe live from production egress before go-live |
| **Avolve ProjectDox** | Likely Azure or self-hosted; **not** a major CDN edge | **NOT confirmed** + weak live signal | `plancheck.avolvecloud.com` → Rackspace IP `162.209.33.151` (not Cloudflare/Akamai anycast); Avolve markets Microsoft/Azure partnership |

> ⚠️ The verification panel confirmed WAF posture **only for Accela**. PowerClerk
> rests on my single live header check; EnerGov and ProjectDox are unconfirmed.
> A marketing-page claim that Accela "explicitly includes Cloudflare + Azure
> Firewall" was **REFUTED 0-3** — the security page lists Cloudflare among
> *monitoring* tools; it's the **live headers** that prove the edge, not the
> marketing copy. Probe EnerGov/ProjectDox directly before relying on them.

**Empirical detail (live, 2026-07-21):** `aca-prod.accela.com` →
`Server: cloudflare`, `CF-RAY`, `_cfuvid` cookie, Cloudflare anycast
`104.16.44.23/45.23`. `app.powerclerk.com` → redirects into
cleanpower.com behind `Server: cloudflare` with a `__cf_bm` (Bot Management)
cookie. Note (CONFIRMED nuance): some agencies **self-host** Accela ACA on
their own city domain (e.g. `accela-aca.fcgov.com`) — those are outside the
Cloudflare multi-tenant edge and behave per that agency's own stack.

**What triggers blocks** (CITED, blog sources — verification pending):
`navigator.webdriver=true` is the first and easiest automation tell; headless
Chrome has a distinct **JA3/JA4 TLS handshake** (cipher-suite ordering) and
reports zero plugins; server-side analysis flags requests that arrive too
fast, skip intermediate pages, or start every run with a fresh session;
Imperva Incapsula fingerprints TLS before the HTTP request is even processed.

**Legitimate mitigations to implement** (CITED — verification pending, but
low-controversy and matches our existing design):
1. Run **headed real Chromium**, not headless (defeats webdriver flag, plugin,
   and JA3 tells at once). Playwright already avoids Selenium's `cdc_`/CDP
   markers.
2. **Persistent `user-data-dir` / session cookies** — reuse the authenticated
   session instead of a fresh login every run (fresh-session-every-time is
   itself a flagged pattern).
3. **Human solves login + MFA** (already a hard rule) — the highest-friction
   bot gate is handled by a real human.
4. **Respectful rate limiting** — realistic timing, don't skip pages; our
   tens/day volume is trivially under any threshold.
5. **Stable, real declared user-agent + realistic viewport**; avoid
   datacenter IP ranges (prefer residential/office egress).

## (b) Credential-custody design + checklist

We hold installer-supplied portal usernames/passwords to log into government/
utility sites on their behalf. The following pattern is **CONFIRMED 3-0**
against OWASP, AWS, and UiPath primary sources:

- **Authenticated encryption**: encrypt credentials at rest with **AES-256-GCM**
  (or ChaCha20-Poly1305) — one AEAD algorithm for confidentiality + integrity
  (OWASP's explicit recommendation).
- **Envelope encryption / BYOK** (OWASP Secrets Management Cheat Sheet §4.2):
  a data encryption key (DEK) encrypts each secret; a separately-held root/
  master key (KEK) in a KMS/HSM encrypts the DEK; the wrapped DEK may sit
  beside the ciphertext, but the KEK must **never** be stored next to the
  secrets. Don't store plaintext; don't log secrets.
- **Per-tenant key isolation** (AWS Architecture Blog, Aug 2025): one
  customer-managed KMS key per tenant, `alias/customer-<tenant-id>`, enforced
  via IAM/`kms:RequestAlias` conditions. UiPath Orchestrator documents the
  same idea — per-tenant Azure Key Vault encryption key "ensuring better
  segregation of your data between tenants."
- **Credential-vault model** (UiPath Orchestrator credential stores):
  CyberArk, Azure Key Vault, HashiCorp Vault, AWS Secrets Manager, BeyondTrust,
  Thycotic/Delinea — read-write (secrets created through the app) vs read-only
  (provisioned directly in the vault). This is the productized "act on the
  user's behalf with their stored credentials" pattern to mirror.
- **Rotation** (OWASP §2.7.2): rotate API keys/service accounts/encryption
  keys regularly, but **user credentials are excluded from scheduled rotation
  — rotate only on suspected compromise** (per NIST 800-63B). So: don't
  force-rotate installers' portal passwords; rotate on breach signal.
- **Audit trail** (OWASP §2.6): log who requested each secret and for what
  system/role, when it was used and by whom, auth/authz errors, and updates;
  logs must be **tamper-resistant with synced timestamps**.

**Checklist to implement now:**
1. Encrypt every stored portal credential with envelope encryption; key in a
   KMS/Key Vault, never in the app DB alongside the ciphertext.
2. Per-installer (per-tenant) key scoping so one installer's creds can't
   decrypt another's.
3. Never write credentials to logs, debug bundles, or the LLM path (already a
   hard rule — extend the secret-strip guard to cover credential storage/audit
   surfaces).
4. Tamper-resistant audit log of every credential use (which run, which
   portal, success/failure) with synced timestamps.
5. Rotate on compromise only; provide installers a revoke/replace path.
6. Compliance framing: this maps to **SOC 2 Confidentiality + Security**
   criteria; storing credentials + any customer PII implicates state
   data-breach laws and **CCPA/CPRA**. Stand up the audit log and encryption
   now; formal SOC 2 at the first AHJ/utility procurement ask (per the market
   report).

## (c) Legal precedent — credentialed submission vs. scraping

**Bottom line (CONFIRMED 3-0 against SCOTUS + 9th Cir. primary opinions):
credentialed, installer-authorized, low-volume submission is on the favorable
side of CFAA case law — but the EXACT authorized-agent automated-submission
scenario is an unsettled "gray area," not a settled safe harbor.**

- **Van Buren v. United States (SCOTUS 2021)**: the CFAA's "exceeds authorized
  access" clause reaches only accessing areas off-limits to the user, NOT
  misusing access one is entitled to have. Liability is a binary
  **"gates-up-or-down"** question — not purpose or motive. A credentialed bot
  logging into an account the installer legitimately holds, touching only what
  that account can reach, does **not** "exceed authorized access" merely
  because access is automated or commercial.
- **Facebook v. Power Ventures (9th Cir.)**: automated access **with the
  account holder's permission is lawful** — even if it breaches the site's
  ToS. The pivotal event that creates CFAA liability is an **explicit,
  individualized written revocation** (a cease-and-desist). Power was fine
  until Facebook sent written notice and it kept going.
- **hiQ v. LinkedIn (9th Cir. 2022)**: ToS/C&D violations on **public** data
  are unlikely to be CFAA violations ("no gates to lift"). (hiQ later lost on
  a separate breach-of-**contract** theory — which does not disturb the CFAA
  holding, and is exactly the civil exposure that remains.)
- **⚠️ The gray area (finding 10, medium)**: legal commentators characterize
  our precise scenario — automated submission using the user's OWN credentials
  with their explicit permission — as an **unsettled area awaiting future
  cases**, distinct from both "clear violation" logged-in scraping and
  permissible public-data scraping. Not a settled violation; not a settled
  safe harbor.
- **⚠️ Van Buren footnote 8** expressly left open whether a **ToS automation
  ban can itself define a CFAA "gate."** So if any AHJ/utility portal's terms
  *explicitly prohibit automation*, the gates-up analysis is less certain
  there — flag such portals at onboarding.
- **Non-CFAA exposure remains**: the CFAA holdings don't foreclose
  trespass-to-chattels, breach-of-contract (ToS), or misappropriation — so
  exposure is **primarily civil/contractual, not criminal**.
- **Refuted, do not cite**: Meta v. BrandTotal as authority that "hiring an
  authorized agent to extract" is CFAA-safe (REFUTED 1-2). The analysis is
  also **9th-Circuit-weighted**; other circuits read CFAA authorization
  differently.

**Operational implications:**
1. Only ever operate with the installer's explicit authorization to act on
   their account (contract/consent record per installer).
2. If any portal vendor or agency sends a written cease-and-desist for a
   specific account/portal, **stop automating that portal immediately** — that
   is the documented line where CFAA liability begins.
3. Read agency-specific portal terms at AHJ onboarding (the civil/contract
   layer); record in the KB.
4. Keep volume low and human-attended — reinforces "authorized user," not
   "scraper," on all three legal-risk factors (nature of data, where
   collected, how collected).

## Verification status & remaining gaps

- **CONFIRMED 3-0** (full panel verification): Accela two-layer WAF
  (Cloudflare + Azure App Gateway, live-confirmed); TLS/JA3-JA4 + webdriver
  detection mechanisms; the entire credential-custody section (AES-256-GCM,
  envelope encryption, per-tenant KMS, no-plaintext-logs + audit trail, RPA
  vault model — OWASP/AWS/UiPath); and all core legal precedent (Van Buren,
  Power Ventures, hiQ — primary court opinions).
- **My live probe only** (panel did not independently confirm):
  PowerClerk = Cloudflare + `__cf_bm` bot management.
- **Still unknown / must probe before go-live:** live WAF posture of **EnerGov
  and ProjectDox** (unreachable here; probe from production egress); the actual
  challenge/block **rate** at authenticated low volume (no cited figure —
  "low/manageable" is an engineering inference from detection mechanisms, not a
  measurement); documented cases of permit-tech firms blocked/sanctioned (none
  surfaced).
- **Live legal risk to watch:** any AHJ/utility ToS that *explicitly bans
  automation* (Van Buren footnote 8 leaves the gate question open there); the
  authorized-agent submission scenario is an unsettled gray area; analysis is
  9th-Circuit-weighted.
