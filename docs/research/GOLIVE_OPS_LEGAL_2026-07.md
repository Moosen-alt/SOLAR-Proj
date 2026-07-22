# Go-live ops: WAF/bot posture, credential custody, legal precedent (July 2026)

Fourth deep-research run (universal browser automation is the strategy;
official APIs are opportunistic-only per the operator's PowerClerk
confirmation). The run's search + extraction completed (117 claims from 24
sources); the adversarial verification phase was cut short by the API credit
wall after ~29 of ~75 votes. This report is built from **(a) the completed
verify votes, (b) live header/DNS probes run directly on 2026-07-21, and
(c) cited-but-not-yet-panel-verified extracted claims**, each labeled with its
status. A full-verification resume can upgrade the CITED items later.

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
| **Accela Citizen Access** (multi-tenant `aca-prod.accela.com`) | **Cloudflare** (Azure App Gateway origin) | **CONFIRMED** — verify votes 3-0 + my live probe | Low if headed + persistent session; `_cfuvid` cookie = Cloudflare visitor/bot signal present |
| **PowerClerk** (Clean Power Research) | **Cloudflare w/ Bot Management** | **CONFIRMED** — my live probe | Low; `__cf_bm` bot-management cookie present — avoid headless/datacenter-IP fingerprints |
| **Tyler EnerGov CSS** | Unknown (Tyler-hosted; not reachable from this env) | CITED only | Unknown — treat like Accela until probed live |
| **Avolve ProjectDox** | Likely Azure or self-hosted; **not** a major CDN edge | CITED + weak live signal | `plancheck.avolvecloud.com` → Rackspace IP `162.209.33.151` (not Cloudflare/Akamai anycast); Avolve markets Microsoft/Azure partnership |

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
utility sites on their behalf. The following pattern is **CONFIRMED** (verify
votes 3-0 against OWASP, AWS, and UiPath primary sources):

- **Envelope encryption / BYOK** (OWASP Secrets Management Cheat Sheet §4.2):
  a data key encrypts each secret; a KMS/customer main key encrypts the data
  key. Don't store plaintext; don't log secrets.
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

**Bottom line (CITED — secondary/primary legal sources, verification pending):
credentialed, account-holder-authorized, low-volume form submission sits on
the safe side of the line that CFAA case law actually draws.**

- **Van Buren / hiQ v. LinkedIn (9th Cir. 2022)**: CFAA authorization is a
  **"gates-up-or-down" inquiry keyed to authentication** — "authorization as
  an authentication process where users input credentials to proceed past a
  'gate'." A party who authenticates with valid credentials (our operator,
  using installer-supplied logins **with the installer's permission**) has the
  gate "up." That is categorically different from gate-bypassing unauthorized
  access.
- **ToS ≠ CFAA**: violating a site's terms of service is "unlikely to
  constitute a violation of the CFAA" — ToS bans on automation are not, by
  themselves, federal computer-crime hooks. (Holding arose in the public-data
  context; the authenticated-portal context is less tested.)
- **Facebook v. Power Ventures — the key limit**: automated access performed
  **with the account holders' consent is initially authorized**, BUT CFAA
  liability attaches the moment the operator gets an **explicit, individualized
  written revocation** (a cease-and-desist). Continued access after that
  written notice is "without authorization."
- **Non-CFAA exposure remains**: hiQ was limited to the CFAA. Portal operators
  retain trespass-to-chattels, breach-of-contract (ToS), and misappropriation
  theories — so our exposure is **primarily contractual/civil, not criminal**.

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

- **CONFIRMED (3-0 cached votes or my live probe):** Accela=Cloudflare,
  PowerClerk=Cloudflare+BotManagement, and the entire credential-custody
  section (OWASP/AWS/UiPath).
- **CITED, verification pending** (extraction completed; panel died on credit
  wall): bot-detection mechanisms + mitigations (blog-sourced), all legal
  precedent (secondary/primary sources), EnerGov/ProjectDox edge posture.
- **Still unknown:** live WAF posture of EnerGov and ProjectDox (unreachable
  from this environment — probe from production egress); documented cases of
  permit-tech firms being blocked/sanctioned (none surfaced); the
  authenticated-portal CFAA context is less litigated than the public-data one.
- **To upgrade:** resume run `wf_61574b62-402` after credit reset — searches
  and fetches replay free; only the remaining verify votes + synthesis re-run.
