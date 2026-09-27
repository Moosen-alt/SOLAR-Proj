# Solar Submission Autopilot

Automates residential solar **permit** (AHJ) and **NEM/interconnection**
(utility) submissions end-to-end — parse plan set → QC → code-cited reviewer
gate → build/fill official AHJ forms → stage the portal application via
learned automation — with a human always making the final submit. Everything
it does once (portals, forms, fees, requirements) is learned and reused.

## Quick start (local)

```bash
npm install
npx playwright install chromium
npm run dev          # dashboard + API on :4000
npm run smoke        # end-to-end check on a scratch DB
```

## Deploy for your team (cloud)

Follow **`docs/SERVER_SETUP.md`** — single VM, systemd + Caddy HTTPS,
`AUTH_ENABLED=true`, employee logins, client-safe share links, backups,
update runbook, and the Stripe how-to for collecting per-submission client
payments.

## Documentation map

| Doc | What it covers |
|---|---|
| `CLAUDE.md` | Hard safety rules, architecture gotchas, commands |
| `docs/SERVER_SETUP.md` | Hosting, logins, client links, Stripe payments |
| `docs/DEVELOPER_ONBOARDING.md` | Full dev handoff: flows, tables, SaaS split map |
| `docs/HANDOFF.md` | Running state, open issues, verify-after-pull checklist |
| `docs/products/` | Sellable-product packets (Plan Review API is live-ready) |

## Safety (never regress)

Automation never pays portal fees and never solves CAPTCHA/MFA. The portal's
final submit is clicked by a human, or by automation only under the one gate
(`mayClickFinalSubmit`: a named person's approval of exactly that run, plus
`PORTAL_ALLOW_FINAL_SUBMIT=1` on the process, plus a valid recipe shape);
secrets never reach the LLM; human-verified knowledge is never
auto-overwritten. See `CLAUDE.md`.

## Test suites

`npm run typecheck` · `npm run smoke` · `npm run backend:test:unit` ·
`npm run portal:test:unit` · `npm run portal:test:specs` (real-browser
PowerClerk cascade) · `npm run import:reference -- <files.xlsx>` (KB imports)
