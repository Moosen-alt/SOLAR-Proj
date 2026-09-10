# Onboarding — bringing a new solar installer onto the Autopilot

Audience: the person at our company who onboards a new installer. Follow it start to
finish without reading source code. Everything here is a step you perform, a command you
run, or a sentence you say to the customer.

Read first, in this order:

1. `docs/onboarding/INTAKE_CHECKLIST.md` — what to collect from the company, field by field,
   with what breaks when each one is missing.
2. `docs/onboarding/intake-template.json` — the machine-readable shape of that same intake,
   which is what the provisioning script actually consumes.
3. `docs/onboarding/CAPABILITIES.md` — the measured detail behind what we can and cannot do.
4. This file — the runbook that ties them together.

If you only remember one thing, remember this: **we stage, a human files.** Every number,
promise and caveat below follows from that.

---

## 0. The shape of the job

The Autopilot takes a plan set and drives the AHJ or utility portal up to that portal's own
review screen, with the application filled. It stops there. A person looks at the filled
application in the browser and presses submit.

| Step | Who | Notes |
|---|---|---|
| Parse the plan set into fields | Automation | LLM + deterministic parsers |
| QC the design against the AHJ's adopted codes | Automation | produces findings, does not clear them |
| **Clear the reviewer gate** | **Human** | a blocker finding stops the run until a person clears it |
| Build and fill the AHJ's own PDF forms | Automation | from `ahj_form_templates` |
| Log into the portal | Automation | stored encrypted credentials |
| Walk the application and fill every field | Automation | recipe replay, or a learn run for a new portal |
| **Solve a CAPTCHA or MFA challenge** | **Human** | never automated, under any flag |
| **Sign anything (DocuSign / eSign)** | **Human** | we hold no DocuSign integration; automation may type the notification email, never presses `eSign` |
| **Press the portal's final submit** | **Human** | never automated by default |
| **Pay a portal fee** | **Human** | never automated, under any flag, ever |
| Watch for corrections and status changes | Automation | permit monitor |
| Answer a correction / resubmit | Both | automation refills, a human files again |
| **Cancel the draft applications a learn run leaves in the portal** | **Human, on the customer's side** | learning or benchmarking a portal mints real drafts under their account and nothing of ours deletes them — see §2 |

The bolded human rows are not gaps we are closing. They are deliberate. Automation clicking
"Pay $180" or "Submit Application" on a government portal on a customer's licence is the one
mistake that ends the business, so the code refuses in several independent places. Do not
promise a customer that this changes with a setting.

---

## 1. What we need from the company before we start

The full list, with the exact field names and why each one matters, is
`docs/onboarding/INTAKE_CHECKLIST.md`. Send them that. Do not retype it here or in an email —
it drifts, and then two customers get provisioned differently.

Two items on that checklist BLOCK everything else, so chase them first:

- **The contractor licence number** (the `ccbLicenseNumber` field — named for Oregon's CCB, but
  it holds whatever the state calls the contractor licence). Without it, staging refuses with
  a 409 and the message `Submitting client "X" has no CCB license number on file`. You will
  not discover this until the first filing, so get it at intake.
- **The portal logins.** See §5 — there is a safe way to receive these and several unsafe ways.

Everything else on the checklist — legal business name, business address, EIN, bond and
insurance carriers, authorized signer, standard disconnect make/model — is not enforced by
any error. It feeds straight into the portal fields. **A blank there becomes a blank portal
field, which is a rejected filing rather than an error message.** That is the quiet failure
mode of this whole process. Collect the licence/business block completely, not "enough to
get started".

---

## 2. The honest conversation to have up front

Have this conversation before provisioning, not after the first filing stalls. The customer
is buying a staging service with a human in the loop. If they think they are buying a robot
that files permits while they sleep, the first MFA prompt reads as a broken product.

Say these things plainly:

**"We stage the application. One of your people, or one of ours, presses submit."** The run
leaves the filled application on the portal's review screen and the project lands in the
`awaiting_human_submit` state. A person opens it, reads the filled application, and files it.
That is the design, not a limitation of the current version.

**"We never solve CAPTCHA or MFA, and we never pay a fee."** If their portal account
challenges a new device, the run pauses and waits for a human at that browser. If the portal
wants a card, the run stops and says so.

**"Staged is not filed."** When we say a filing is staged, we mean: the fields are in, the
review screen is up, nothing has been submitted to a government body. The customer's permit
clock has not started.

**"Teaching a portal leaves real draft applications in your account, and nothing on our side
deletes them."** Say this one out loud; it is the disclosure most likely to surprise them
later. A learn run drives their live portal account under their licence and gets as far as the
portal's review screen, which on most portals means the portal has already minted a draft
record with a real intake number. It is never submitted — automation does not click final
submit — but it exists, it is visible in their account and on some portals to the authority's
staff as well, and **no code path of ours removes it.** Real examples are on record: the Miami
benchmark runs left drafts
on the live account, one carrying intake number `BD26-021147-001` (`docs/HANDOFF.md`, the
benchmark operator note). It compounds: the replay self-test re-runs the same live portal and
can create a SECOND draft (`backend/src/autoLearn.ts:1155`), so a single
`--repeat 3 --self-test` sweep can leave six. **A human on their side has to cancel the junk
drafts.** Agree up front who that is, and warn them before every learn run on a portal where a
draft is visible to the reviewing authority.

**"When you rotate a portal password, you have to tell us the same day."** Make this an
obligation in writing, because the failure mode is silent and it is theirs, not ours:

- We do not detect a rotation. We find out when a filing hits the login form and fails.
- That refusal marks the credential stale, and the stale flag makes the benchmark **skip that
  portal entirely** until a person fixes it — correct behaviour (repeated attempts lock real
  accounts), but it means the portal quietly leaves the fleet rather than erroring loudly.
- The flag does not clear when they send a new password. It clears only when a login actually
  succeeds. See §6 for the exact sequence, which is not the one the tool's own output prints.
- This is not hypothetical: **12 of our 68 portal hosts are sitting in that state right now**
  (counted 2026-09-09 against the live DB; the number moves with every sweep). Each one is a
  portal we cannot measure or file through until someone re-supplies a login.

**"Even the one portal we have proven end to end still needs two human steps."** Do not let
"proven repeatable" be heard as "hands off". On Ameren Illinois NEM (PowerClerk), our only
repeat-measured portal:

- The application pages in our own learn bundle carry the portal's notice
  *"Multi-Factor Authentication Required — Your account must have Multi-Factor Authentication
  enabled in order to perform this operation. You can enable Multi-Factor Authentication from
  the My Account page."* Our runs did not pause on it — the bundle on disk records
  `pauseReason: null` — so it gates an operation past the point where automation stops, which
  means it gates **the human's** step. The person who submits needs MFA enabled on that account
  and their second factor to hand. Confirm that with the customer before promising a filing
  there; a submit-time MFA wall discovered by the person holding the mouse is a bad surprise.
- The $50 Level 1 fee is **a mailed paper check**, within 15 business days of submission, and
  the application is not reviewed until the check lands (`docs/IL_ONBOARDING.md:32`). There is
  no online payment to automate even in principle.

So the best case we can demonstrate today is: automation fills eight pages, then a human with
an MFA-enabled account submits, then someone posts a cheque.

**"You are the first."** This process has never been run against a real company. The live
database holds exactly one client — `tml-international-llc`, the benchmark fixture — and one
org, `org-default`. Say it to the customer in whatever register suits the relationship, but do
not skip it internally: **the first customer is the first execution of this runbook.** Budget
for it. Expect a step in here to be wrong, and fix this document when it is.

**Portal coverage, with the honest denominator.** Do not round these up, and do not quote them
without the denominator — `docs/onboarding/CAPABILITIES.md` carries the per-platform detail
and the exclusions.

| Measurement | Number | What it does NOT mean |
|---|---|---|
| Distinct portal hosts we hold credentials for | 68 | not 68 working portals |
| Hosts actually measured in the last sweep | 54 | 14 excluded: 11 stale-credential hosts, 3 with no benchmark address |
| Stale-credential hosts TODAY (2026-09-09) | 12 of 68 | the exclusion count above is the figure at the last sweep; it moves every run — recount before quoting either |
| Of those measured, log in successfully | 26 of 54 (48%) | **not 26 of 68** |
| Of those, record a recipe that fills real fields | 17 | logging in is not filling |
| Proven repeatably end to end (learn → review → replay → review) | **exactly 1** | Ameren Illinois NEM on PowerClerk, 3/3 attempts, self-test passing |

One portal has a repeat-measured success rate. Every other number above is a single attempt
on one build. Say "one portal is proven repeatable; the rest are measured once" rather than
implying a fleet reliability figure. If the customer asks for an SLA per portal, the answer
is that we can produce one after `--repeat N` runs against their portals, not before.

**The caveat that matters most for a new customer.** If a filing goes to an AHJ we have never
touched, and there is no recorded recipe and no known portal URL for it, the run reports a
successful stage **against a mock portal that never opened a browser**. Nothing was filed and
nothing was staged. §6 and §8 tell you how to spot and fix this. Never forward a "staged"
notification for a brand-new jurisdiction to a customer without checking it first.

**Two questions their security or legal reviewer will ask, answered before they ask.** A
company handing over government-portal logins gets a review, and both of these are in §5 with
the detail: (1) their live portal SESSIONS — cookies and saved logins — sit **unencrypted on
our disk** at `portal-profiles/<clientId>/<portalType>/`, outside `SESSION_ENCRYPTION_KEY`;
(2) **there is no offboarding procedure in the product** — no route deletes a departing
company's credentials, sessions or backups in one action; §5 carries the manual checklist and
names the gaps. Read both before you promise anything about data handling.

---

## 3. Provisioning the company

Standard onboarding creates ONE thing: a `clients` row inside our own org
(`DEFAULT_ORG_ID = "org-default"`). That is the whole service-bureau model — we hold the login,
they are the company the work is for.

Spelled out, because every other combination is a wrong turn:

| Standard onboarding creates | Standard onboarding does NOT create |
|---|---|
| one `clients` row in `org-default`, carrying the licence/business block | **no org** — no new tenant, no `org_entitlements` row, no product grant |
| one `portal_credentials` row per portal login, encrypted | **no login for the customer** — nobody at the customer's company signs in to our tool |
| optionally a `client_portal_identities` row per portal | **no user row for them** — see §3.2; the customer does not need one to be filed for |

**The customer never logs in to our software.** They send us plan sets and logins; we stage;
a human submits. That is the complete path to a filed permit, and it needs exactly the one
client row.

**Do not create an org for them, and do not let a request for "their own dashboard" turn into
one.** An org is the tenant that LOGS IN, and that lane is a documented dead end today — not
"unpolished", dead. Concretely:

- The only org-creation surfaces are `POST /api/orgs` (superadmin-only, curl-only, no UI) and
  an explicit `org.createTenant: true` in an intake file. Nothing else creates an org — in
  particular an `org` block naming a company but omitting `createTenant` is ignored with a
  warning, and the client lands in `org-default`.
- `POST /api/orgs/:id/users` is the only route that creates a user who can actually sign in,
  and it writes the role as a **hardcoded SQL literal `'operator'`** (`backend/src/server.ts`,
  the INSERT at ~line 919). There is no parameter for it.
- There is **no role-elevation route**. `updateUser` is the only writer of `role` anywhere, and
  it requires a signed-in admin actor — which the new org does not have and cannot get. The
  only way up is raw SQL against the database, deliberately, by us.
- There is **no password-reset or set-password route** anywhere in the API. Hand a wrong
  password to a tenant and the only fix is raw SQL.
- `requireAdmin` demands an admin role **and** that the caller's own org holds the `autopilot`
  product, so administration is structurally the operator's org, never a tenant's.
- And a tenant granted only `permit_reviewer` / `form_filler` can never stage at all:
  `autopilot` is the `wildcard` product that unlocks the staging surface, and it is
  `apiKeyAuth: false`, so it is not reachable with an API key either.

Net: an org created for a customer can never get its own admin, so it can never manage its own
users, credentials or products. If a customer genuinely needs their own login, **stop and
escalate** — it is a product decision and engineering work, not a runbook step.

### 3.1 Preconditions

Check both before you run anything.

| Precondition | How to check | Why |
|---|---|---|
| `SESSION_ENCRYPTION_KEY` is a real value | `curl -s localhost:4173/health` → `config.sessionKeySet: true`, status not `degraded` | Storing a portal credential THROWS without it. An unedited `.env.example` placeholder counts as missing. |
| `AUTOPILOT_DB_PATH` points at the live DB | it is in `.env`; the scripts default to `backend/data/autopilot.sqlite` | A script with the wrong path silently provisions into a scratch database |

If `/health` reports `SESSION_ENCRYPTION_KEY is unset or default`, stop. Fix the key before
you touch credentials. And if a key already exists, **do not change it** — rotating it without
`npm run rekey:credentials` makes every stored login permanently unreadable, and the failure is
silent (the symptom is "no stored credential for this client", never a crypto error).

### 3.2 Fill the intake file — outside the repo

`scripts/onboard-company.ts` creates the client row, writes the licence/business block, and
attaches the portal credentials. It reads one JSON intake file:
`docs/onboarding/intake-template.json` is the template.

**Copy it out of the repo before you type a real secret into it.** A filled intake file
contains live portal passwords in plaintext, and out of the repo is the rule:

```
cp docs/onboarding/intake-template.json ~/intake/cascade-ridge.json
```

`.gitignore` is the net under that rule, not a substitute for it. It covers `intake/` at any
depth, any filename containing `intake`, every `.json` at the repo root, and every `.json`
under `docs/` — with this one template negated back in so it stays tracked. Verify rather than
trust: `git check-ignore -v <your file>` prints the pattern that caught it, and silence means
nothing did. A copy saved somewhere else entirely (`backend/cascade-ridge.json`) is still
committed by the next `git add -A`.

The script will also print a blank of its own, which is the copy that cannot drift from the
code that reads it:

```
npx tsx scripts/onboard-company.ts --example > ~/intake/cascade-ridge.json
```

Then fill it in. What matters as you do:

- **Omit the whole `org` block.** No `org` block means "a `clients` row in our existing tenant,
  `org-default`" — the service-bureau lane of §3, and the complete path to a staged filing.
  Naming an org is the escalation case above; the template's own comment on that block says the
  same thing. If you are unsure, omit it: adding an org later is a decision, and a client
  created in the wrong tenant is not something this script will move (it never moves a client
  between orgs).
- **Replace every value.** Every string in the template is fake. Nothing should still read
  `EXAMPLE`, `000000`, `.invalid`, or `REPLACE-ME` when you run it.
- **`portalUrl` is the load-bearing field, not `portalType`** — see §5.
- **`notes` is plaintext and LLM-visible.** Operational hints only. No passwords, no security
  answers, no account or meter numbers.
- **Standard onboarding does not need a `users` entry at all — leave the array empty.** The
  customer does not log in (§3). If you do add one, know exactly what you get: `users[].role`
  is **ignored** (the script warns you so), because every user created anywhere in this system
  is an `operator` and `updateUser` — the only writer of `role` — needs a signed-in admin
  actor. Supplying a `password` DOES produce a login that works: the script writes the same
  scrypt `password_hash` that `POST /api/orgs/:id/users` writes, because there is no
  set-password route to fix it with afterwards. So the trap is not "cannot log in", it is
  **"logs in forever as an operator, with no route to change the role and no route to reset the
  password"**. Promotion is raw SQL, by us, deliberately.

### 3.3 Dry run, then the real run

Run the script bare first. Like every CLI here it prints its own usage and exits 1 with no
arguments — **its usage output is the authority on the exact flag names, not this document**:

```
npx tsx scripts/onboard-company.ts
npx tsx scripts/onboard-company.ts ~/intake/cascade-ridge.json --dry-run
```

**Pass the intake path positionally, as above.** `--intake=<path>` also works if you prefer it
(the script's usage lists it), but the positional form is what every example here uses. If you
see usage text and exit 1 when you did pass a path, the path is the thing to check — a
non-existent file is reported by name, and a path you forgot to quote loses everything after
the first space.

A dry run writes nothing and ends with a `DRY RUN — nothing written.` summary. Read it before
proceeding. What you are checking:

- the company name and licence number are exactly right — a typo in the licence number is a
  rejected filing weeks later, not an error now;
- the row count is what you expect: one client, plus one row per portal credential;
- no placeholder strings survived;
- every credential line reports `set` or `missing`, **never a password value**. If a password
  value appears in that output, stop and report it — printing secrets is a bug, not a feature.

Then the real run — the same command with the flag removed. **A real run is the ABSENCE of
`--dry-run`**, so re-read the line before you press enter:

```
npx tsx scripts/onboard-company.ts ~/intake/cascade-ridge.json
```

Two flags worth knowing, both from the script's own usage: `--db <path>` writes to a specific
SQLite file (it overrides `AUTOPILOT_DB_PATH` — useful for a rehearsal against a scratch DB,
dangerous if you forget it), and `--actor=<email>` names you in the audit log instead of the
default `onboard-company script`. Use `--actor` on every real run; a provisioning write with no
attributable human is a bad row to find later.

Move straight to §4. Do not assume it worked because it exited 0 — exit codes in this repo have
lied before; read the output.

Running it twice is safe by design: it re-lands the same rows and will not overwrite anything a
human has verified. To correct a value, fix the intake file and re-run rather than editing the
database by hand.

**Then delete your filled intake file.** The passwords now live encrypted in the database; that
file is a second plaintext copy with no encryption and no access control.

---

## 4. Verifying with `onboarding-readiness.ts`

```
npx tsx scripts/onboarding-readiness.ts
npx tsx scripts/onboarding-readiness.ts --client=<clientId>
```

**This one has no usage-only mode — do not run it bare to see its flags.** Unlike
`onboard-company.ts`, running it with no arguments opens the default database (`AUTOPILOT_DB_PATH`,
else `backend/data/autopilot.sqlite` — i.e. the LIVE one) and performs the full check against
whichever single client it finds, naming them and exiting 1 if there is more than one. Read the
flags at the top of `scripts/onboarding-readiness.ts`, and pass `--db <copy>` if you want to
poke at it without opening the live file. It writes nothing of its own — no INSERT, UPDATE or DELETE
anywhere in it, and it never repairs what it finds. It is **not** true that a run leaves the
database untouched, though, and the difference is worth knowing before you quote it to anyone:
`openDatabase()` re-seeds the baseline knowledge base unversioned on every open
(`backend/src/db.ts:1005`), which bumps `permit_utility_knowledge.updated_at` on a few hundred
rows. Measured: 385 rows' timestamps moved, no content and no row count changed. Every process
that opens this database does that, the backend server included, so the live file's mtime and
checksum prove nothing either way. Pass `--db <copy>` if the timestamps matter. It checks the
things that block a first filing,
and prints a verdict.

What it is checking, and what a failure means:

| Check | If it fails |
|---|---|
| The client row exists and sits in the right org | Provisioning landed in the wrong tenant — escalate, do not patch |
| Contractor licence number is present and non-blank | Staging will 409 `needsCcb`. Go back to §1 |
| Licence/business block is complete | Blank portal fields → rejected filing. Go back to §1 |
| At least one portal credential attached, each reporting `set` | The company has not sent logins yet, or the encryption key was missing when they were stored. §5 |
| `SESSION_ENCRYPTION_KEY` is set (reported as `set`/`missing`, never its value) | Nothing can decrypt a login. §3.1 |
| Each credential's stored portal URL is a real entry URL with its jurisdiction path segment | The credential will never be found at run time. §5 |
| The jurisdictions on their first projects have a recipe or a known portal URL | Not a blocker — it means a learn run is needed first. §6. Read the wording: it separates `complete` (replays) from `draft only (status "needs_rerecord")` (does NOT replay — the next filing re-learns), and it FAILS the jurisdiction when there is neither a recipe nor a portal URL, which is the mock trap |

Two things to know about its output. It also flags credentials the portal has refused
(`STALE`) — that is operator work, not a bot defect, and it is a warning rather than a blocker.
But **its printed remedy for a stale credential is wrong**: it tells you to clear the flag with
`npm run learn:benchmark -- --host <host>`, which will silently skip that host. Use the sequence
in §6 (`--include-stale`, and a successful login is what clears it).

**How to read the verdict.** A READY verdict means the configuration is complete: nothing in
our own data will block a first filing. It does **not** mean any portal works. Readiness is a
config check, not a portal test. The only thing that proves a portal is a learn run against
the real URL (§6) or a live filing. Treat READY as "cleared to attempt", not "cleared to
promise".

A NOT-READY verdict names the failing check. Every one of them maps to a section above; fix
it and re-run. Do not proceed with a NOT-READY client on the theory that the first filing
will reveal the problem — it will, at the customer's expense.

---

## 5. Portal credential intake — how the company hands us logins

The company's portal logins are the most sensitive thing we hold. They are the credentials to
a government system, filing under that company's licence. Treat them accordingly.

### What we actually do

1. **Ask for them over a channel that is not email or chat.** Send them a one-time secret link
   (a self-destructing secret service) or take them by phone. If a customer has already
   emailed you a password, tell them so, get the password rotated on the portal, and take the
   new one properly.
2. **Never paste a password into Slack, email, a ticket, a commit, or a shell command that
   lands in your history.** If you have, the password is burned — rotate it.
3. **Type them into your intake file — the copy you made OUTSIDE the repo (§3.2)** — and load
   them with `scripts/onboard-company.ts` (or, for a bulk load,
   `npm run import:portal-processes -- <file.xlsx>`). They go straight into an AES-256-GCM
   encrypted envelope keyed by `SESSION_ENCRYPTION_KEY`. The API never returns a password; the
   only thing anyone can read back is `hasSecret` and a username reference.
4. **Delete every plaintext copy afterwards.** The filled intake file, the one-time link, the
   note you took on the phone, the workbook. The encrypted database column is the only place a
   portal password should live. `.gitignore` stops a filled intake at the repo root, under
   `docs/`, or in any `intake/` folder from being committed — but an ignored file is an
   invisible one, so it will sit there with live passwords in it until you delete it. Deleting
   it is the step; the ignore rule only stops the worse outcome.

### Three specific traps

**Security-question answers must go through the script, NOT the REST API.** The
`POST /api/clients/:id/portal-credentials` route silently DISCARDS a `securityAnswers` field —
the request validator strips unknown keys, so there is no error and no warning, and the answers
never reach storage. Portals that challenge security questions on a new device then stall for a
human even though the customer gave us the answers. Use the script or the workbook import;
those call the storage function directly and the answers ride inside the encrypted envelope.

**Never put a secret in the `notes` field.** That column is plaintext AND it is fed to the LLM
as research context. Operational hints only ("account is shared with the electrician",
"login emails a one-time code"). Security answers belong in `securityAnswers`, passwords
nowhere but the encrypted envelope.

**The portal URL is the load-bearing field, not the portal type.** At run time we find a
credential by matching the target URL's hostname AND its first path segment. Accela serves
dozens of cities from one host and distinguishes them only by `/sandiego`, `/SACRAMENTO`,
`/lascruces`. So store the real login/entry URL **including the jurisdiction path segment**. A
host match with the wrong segment is refused outright rather than guessed at — which is
correct, because the alternative is typing one city's password into another city's login form
and locking the account. Getting the portal type label wrong costs almost nothing; getting the
URL wrong means the credential is never found at all.

### Where the credential material actually lives — including the part that is NOT encrypted

Their security review will ask this, and the honest answer has two halves. Give them both;
finding the second half themselves is much worse.

| What | Where | Protected by |
|---|---|---|
| Portal username, password, security answers | `portal_credentials.encrypted_secret` in the SQLite DB | AES-256-GCM under `SESSION_ENCRYPTION_KEY`. The API never returns a password — only `hasSecret` and a username reference |
| `portal_credentials.notes` | same table, **plaintext column** | nothing. It is also fed to the LLM as research context. Operational hints only |
| **Live portal SESSION state — cookies, `Login Data`, local storage** | `portal-profiles/<clientId>/<portalType>/` on the server's disk (`repository.ts:5516-5518`; base overridable with `PORTAL_PROFILES_DIR`) | **nothing. It is a plain Chrome profile directory.** Gitignored, so it never reaches the repo, but it is NOT encrypted and it is outside `SESSION_ENCRYPTION_KEY` entirely |
| Mirrored copies of that session state | `backups/portal-profiles/<clientId>/…`, written beside the DB snapshots by **every** `runBackup` (`backend/src/backup.ts`) | nothing. The backup deliberately mirrors `Cookies`, `Login Data`, `Local/Session Storage`, `Preferences` and friends, because a DB-only restore came back with every portal session dead. Note this contradicts `docs/SCALE_DEPLOYMENT.md` §1.5, which predates the mirror — the code is the authority |
| Raw screenshots and Playwright traces of their portal | `data/learn-runs/<runId>/` | nothing (gitignored). JSON artifacts mask sensitive values; **the PNGs and the trace are raw renders and can show customer and homeowner data.** Self-pruned to the newest `AUTOLEARN_RUN_KEEP` (default 20) run folders — and only when a new run happens |

What this means in plain terms: **those profile directories ARE the portal logins.** Anyone with
filesystem access to the server, or to a backup archive, holds a live session to their
government portal account without needing the password or the encryption key. That is the
sentence to put in front of whoever owns server access. Nothing in the product protects those
directories, so on a real deployment the protection has to come from the host — encrypted
storage and restricted filesystem permissions on `PORTAL_PROFILES_DIR` and on `backups/`. That
is a deployment decision nobody has recorded yet; do not tell a customer it is done without
checking the box it runs on. And do not describe our credential handling as "encrypted at rest"
full stop — the passwords are; the sessions are not.

### Offboarding a company — no procedure exists in the product; here is the manual one

**Say this plainly when asked: there is no one-action offboarding.** No route, script or job
removes a departing company's data. Every step below is a person doing it by hand, and the gaps
are named as gaps because a company handing over government-portal logins will ask, and a vague
answer is worse than an ugly one.

Do these in order. The first two are the ones that actually matter, because they are the ones
that leave live access behind.

1. **Have THEM rotate every portal password, on their side.** This is the only step that
   revokes access with certainty, and it does not depend on our cleanup being complete. Do it
   first, not last.
2. **Delete the session profiles from disk — both copies.** `rm -rf portal-profiles/<clientId>/`
   **and** `rm -rf backups/portal-profiles/<clientId>/`. Deleting only the live directory leaves
   a working session in the backup mirror, and the next backup would re-copy a live directory
   you had not deleted. Nothing does this for you. A deleted client row with its profile
   directory still on disk is a live portal session belonging to a company we no longer serve.
3. **Delete each portal credential row, one at a time.**
   `DELETE /api/clients/:id/portal-credentials/:credId` per credential. **Deleting the client
   does NOT delete its credentials** — `deleteClient` removes `client_portal_identities`,
   `portal_profiles` and the `clients` row only, so credentials survive as orphans keyed to a
   client that no longer exists, still holding the encrypted password. Enumerate them with
   `GET /api/clients/:id/portal-credentials` first and check the list is empty afterwards.
4. **Delete or reassign their projects.** `DELETE /api/clients/:id` refuses with a 409 while any
   project still points at the client, naming the count. `DELETE /api/projects/:id` cascades
   properly — it removes the child rows (QC results, submissions, corrections, human review
   items, audit rows, `historical_failure_examples`, fingerprints) **and unlinks the stored
   document files from disk.** Note the retention consequence: the backup document mirror keeps
   its copy on purpose, so plan sets and stamped letters survive in `backups/documents/`.
5. **Delete the client row.** `DELETE /api/clients/:id`, once step 4 has cleared the 409.
6. **Delete their homeowner records if they ask.** `customers` rows are client-scoped and are
   **not** touched by `deleteClient`; `DELETE /api/customers/:id` removes one at a time.
7. **Prune the learn-run bundles.** `data/learn-runs/` holds raw screenshots of their portal
   account. Retention is "newest 20 folders, pruned when a new run happens", so after they leave
   nothing prunes them at all. Delete the folders for their runs by hand.
8. **Leave the pooled knowledge alone.** Portal recipes, AHJ and utility knowledge, code
   profiles, form templates and CEC equipment rows carry **no `org_id` and no `client_id`** —
   they are shared across every tenant on purpose (see CLAUDE.md, "Shared knowledge is shared
   ON PURPOSE"), and they hold jurisdiction facts, not customer data. **They stay.** Tell the
   customer this at intake rather than at exit: what we learn about a city's portal is not their
   data and does not leave with them. What DOES carry their data —
   `historical_failure_examples`, which holds homeowner names and addresses — is org-scoped and
   goes with their projects in step 4.
9. **Write down what you did.** Until this is a script, the audit trail is your note.

Known gaps in that list, to state rather than hide: nothing verifies completion, nothing removes
their data from historical backup snapshots (short of deleting the snapshots), and steps 2, 7
and the backup mirrors have no API surface at all — they are filesystem work on the server. If a
customer's contract requires provable deletion, that is engineering work to quote, not a
checkbox to promise.

### What MFA on their portal account means for us

Say this to the customer explicitly, because it changes what they have to staff:

- **If the portal challenges MFA or a CAPTCHA, the run stops and waits.** The project lands in
  `paused_for_human` with a message naming the challenge. Nothing was staged.
- **A human completes the challenge in the open browser, then we re-stage.** That human has to
  be at the machine running the browser. On an operator desktop (`PORTAL_HEADLESS=false`) the
  browser is visible and this works. On a headless server there is no browser to sit at — the
  paused filing has to be finished from a desktop or a supervised remote session.
- **Automation never solves it.** Not with a flag, not with a service, not "for now". Portals
  that email a one-time code at every login are flagged as human-capture-at-login and will need
  a person present for each session.
- **Stored security answers help; a one-time code does not.** Answers to fixed security
  questions we can store and replay. A code sent to their phone or inbox, we cannot.
- Ask whether they can put us on an account whose MFA is not tied to one person's phone. Some
  portals allow a service account; many do not, and that is a real constraint on how fast we
  can file for them.

---

## 6. Jurisdiction warm-up — the first time we see an AHJ or utility

### Most jurisdictions are already partly known

Portal knowledge is pooled on purpose and shared across every customer. A new company inherits,
on day one: every portal recipe we have recorded, every AHJ and utility profile
(portal URL, required documents, known quirks), every mapped AHJ form, every verified code
profile, and the CEC equipment name normalisation. A quirk learned once for one installer helps
every installer afterwards. This is the core asset of the product; it is why the second customer
in a state is much cheaper to onboard than the first.

So the warm-up question is never "does this company work" — it is "have we ever touched THIS
jurisdiction's portal".

### What happens the first time we have not

There are two outcomes, and only one of them is visible without looking:

- **We have a recipe or a known portal URL for it.** The run opens a real browser, replays or
  drives the portal, and stages for review. Normal.
- **We have neither.** The run reports a successful stage **against a mock portal that never
  opened a browser**. It looks identical to a success in the project status. Nothing was filed;
  nothing was staged. This is the single most important thing to check on a new customer's first
  filing into a new jurisdiction.

Spot it by checking whether the run produced any real artifacts — a learn-run bundle under
`data/learn-runs/`, a review screenshot, a recipe row. `npm run ops` lists the recent portal
recipes and the latest run artifacts; a "staged" project with nothing in either is a mock.

### A recipe row is NOT readiness — read its status

This is the trap that follows on from the mock: you check for a recipe, you find one, and you
conclude the jurisdiction is covered. Most recipe rows do not replay. The live counts today:

| `portal_recipes.status` | Count (2026-09-09) | What it does at run time |
|---|---|---|
| `complete` | **6** | replays. This is the only status that reuses recorded steps |
| `recording` | 15 | does not replay — a learn was in progress or died mid-walk |
| `needs_rerecord` | **55** | does not replay. The next stage RE-LEARNS from scratch |

Only `complete` recipes are selected for replay (`findCompleteRecipeForProject`). **The largest
bucket, `needs_rerecord`, behaves exactly like "no recipe at all" at run time** — it means a
learn failed, or did not stage cleanly, or a replay step broke against a changed portal and the
row was invalidated. So:

- **A recipe row for the jurisdiction proves nothing.** Read the status. `npm run ops` prints
  it per row.
- A `needs_rerecord` row means the next filing there triggers a live LLM-driven learn — minutes,
  cost, a real browser, and a fresh draft application in the customer's account. It is not the
  mock case: a recipe row of any status carries its own `portal_url`, so there is somewhere to
  go. The mock case is having **no recipe row at all and no portal URL in the knowledge base**,
  which is exactly the combination the readiness script fails on.
- Six complete recipes against 68 portal hosts is the honest shape of coverage. Do not quote a
  recipe count to a customer as if it were a supported-jurisdiction count.

### The learn run

To teach the system a portal, point it at the real entry URL for a real project. This is the
operator-facing path:

```
curl -X POST localhost:4173/api/projects/<projectId>/auto-learn \
  -H 'content-type: application/json' \
  -d '{"portalUrl":"https://aca-oregon.accela.com/oregon/","scope":"ahj"}'
→ 202 { "jobId": "..." }
```

`scope` is `ahj` for a permit portal or `utility` for a NEM/interconnection portal — **never
cross them.** A permit filing must never be pointed at a utility portal (PowerClerk) or the
reverse; the code guards this, and so should you. For an Accela-style portal where one address
falls under both a city and a county authority, add
`"permitType":"structural"` or `"electrical"` to say which discipline this pass files.

It runs as a background job because a live LLM-driven browser pass takes minutes. Poll
`/api/jobs/<jobId>`; the verdict lands in `job.result`. Progress streams over SSE.

**Before you fire one: this writes to the customer's real portal account.** A learn walks the
application to the review screen, which on most portals means the portal has created a draft
record — real, numbered, visible to their staff, and never cleaned up by us (§2). It is also a
live session on that account, so nothing else may touch that account while it runs (see the
concurrency rule below; the lease is in-process only and will not protect you across two
terminals). Tell the customer a learn is happening on their account, and agree who cancels the
draft afterwards.

**What to expect.** On the one portal we have measured repeatedly (Ameren Illinois, PowerClerk
NEM): 8 pages, 63-70 field fills, 79 recorded steps, **about 11 minutes per attempt**. A
shallower permit portal is faster; a deep one with uploads is slower. A learn that fails or
pauses does NOT retry on a timer, by design — you read the verdict and decide.

**The result and what it means:**

| `status` in the verdict | Meaning |
|---|---|
| `trusted` | learned, verified, and (with `--self-test`) replayed. The recipe will be reused for future projects in this jurisdiction |
| `paused_for_human` with `pauseReason` `mfa_captcha` | a challenge stopped it. A human clears it in the browser, then re-run. A partial draft recipe was saved |
| a recorded but incomplete draft | it walked but did not reach review. Read the bundle (§8) |

`finalSubmitRecorded: true` in the verdict means the final submit button was **recorded and not
clicked**. That is the correct, expected outcome.

### Measuring a portal deliberately

`npm run learn:benchmark` drives portals we hold credentials for and writes a scorecard. It is
the tool for answering "does this customer's portal work" before promising anything:

```
npm run learn:benchmark -- --host amerenillinoisinterconnect
npm run learn:benchmark -- --host <host> --repeat 3 --self-test
npm run learn:benchmark -- --limit 6 --portal-timeout 420
```

Read the warnings before you run it:

- **It drives LIVE government portals** with real stored credentials, and it logs in under the
  customer's licence.
- **It leaves real draft applications behind in the customer's portal account.** The benchmark
  deletes the throwaway project it created **in OUR database** — that is a `projects` row, and
  nothing more. The draft the PORTAL minted while the run walked the application stays in the
  customer's account, visible to their staff and on some portals to the reviewing authority, and
  no code of ours removes it (§2, and the Miami note in `docs/HANDOFF.md`). With `--self-test` a single attempt
  can mint two, so `--repeat 3 --self-test` can leave six. **Warn the customer before you sweep
  their portals, and agree who cancels the drafts.**
- **Never run two jobs against the same portal account at once. Ever — not two benchmarks, not
  a benchmark and a live filing, not two learns.** The rule is simple because the enforcement is
  not: a learn takes a lease keyed on the recipe, but it is an **in-process** lease
  (`activeLearnKeys`, `backend/src/autoLearn.ts`), so it separates nothing between two terminals
  or two servers. Most portals allow one session per account, so the second run evicts the first
  and both results read as portal failures. This has already happened and produced a false 67%
  reliability figure that was believed for a while. Serialise by hand: one sweep at a time, and
  no filings for that client while it runs.
- **It refuses to retry a login the portal already rejected**, so real accounts do not get
  locked out — and that refusal is stickier than it looks. `--host <host>` alone will NOT get a
  stale host measured and will NOT clear the flag: the stale filter is applied AFTER the host
  filter, so the host you named is simply skipped and you get an empty sweep. **Two tools print
  exactly this wrong advice — the benchmark's own closing "CREDENTIALS NEEDING A HUMAN" line and
  the remedy line in `scripts/onboarding-readiness.ts`. Both omit `--include-stale`. Ignore
  them and use the sequence below** (and if you fix either script, fix this bullet too). What
  actually works:
  1. Get a working credential from the customer and store it (§5). Storing it does **not** clear
     the flag — nothing resets `last_login_failed_at`.
  2. Re-run with the flag that overrides the skip:
     `npm run learn:benchmark -- --host <host> --include-stale`.
  3. The flag clears **only when a login actually succeeds** — `recordLoginOutcome` writes
     `last_login_ok_at`, and `stale` is just "failed more recently than it succeeded". So the
     successful run is the thing that clears it, not the edit and not the flag.
  A harness abort (a killed run, a dead browser) is deliberately NOT recorded as a refusal —
  that mistake once retired six working credentials from every later sweep.
- `--repeat N` is what turns a single attempt into a rate. Without it, one row is one attempt.
- `--self-test` replays the freshly learned recipe in a clean session and refuses to call it
  trusted unless it reproduces. It roughly doubles the time, and it re-drives the live portal —
  which is where the second draft application comes from. It is also the only thing that answers
  "can the bot re-run what it just learned" — the first time it was run by hand, the answer
  was no.
- **The per-portal budget is 8 minutes by default** (`--portal-timeout`, in seconds), and a
  portal that runs out of budget is scored on what it reached rather than failed. So a deep
  application can TRUNCATE and report a partial walk that looks like an engine limit. Ameren
  alone takes ~11 minutes per attempt, which is over the default: raise `--portal-timeout` when
  you are measuring a deep portal, and read the page trace before believing a low score. (An
  operator-triggered learn over the API has no budget at all unless one is passed — the cap is a
  benchmark thing.)
- **Check free disk before trusting a sweep.** A low-disk machine once produced eleven
  consecutive false `unreachable` verdicts in eight seconds.

### Reuse

Once a recipe is complete, later projects in that jurisdiction replay it instead of learning
again — for this customer and for every other. Final submit stays manual on a replay unless a
human has explicitly marked that specific recipe as trusted for auto-submit, which is a
separate deliberate decision and not part of onboarding.

---

## 7. The first real filing, end to end

Do the first one yourself, watching, with the customer told it is a supervised first run.

1. **Intake.** Create the project from the parsed plan set, then bind the client:
   `POST /api/projects/:id/client {"clientId":"..."}`. Until a client is bound, staging refuses
   with `needsClient`. If you need the installer to supply the job valuation or the homeowner's
   contact details, `POST /api/projects/:id/intake-request` returns a shareable link you can
   paste into an email; they fill it in and the project updates.
2. **Parse.** The plan set becomes structured fields — equipment, counts, addresses, electrical
   values. Check the parsed equipment against the plan set on this first project. Certified
   equipment names differ from plan-set names, and a wrong inverter model is a rejected filing.
3. **QC.** Automatic checks against the AHJ's adopted codes. Failures surface as QC results and
   human review items.
4. **Reviewer gate.** `GET /api/projects/:id/reviewer-report` lists findings; any finding at
   `blocker` severity stops the run. This gate exists to catch the design problem before a
   government reviewer catches it. Clear blockers before staging, not after.
5. **Stage.** Creating the project normally enqueues this automatically (Segment A:
   QC → build → reviewer gate → stage). To drive it by hand:
   `POST /api/projects/:id/prepare-submission {"track":"nem"}` (or `building`, `electrical`,
   `combo`, `permit`, `mpu`). It refuses, each as a 409 naming the reason, if: required
   documents are missing (`missingDocuments`), the permit path is unconfirmed for a non-NEM
   track (`permitPathUnknown`), no client is bound (`needsClient`), the client has no licence
   number (`needsCcb`), or a required per-portal project field is blank
   (`missingPortalFields`). Each of those is a fixable data problem, not a failure.
6. **Staged.** The project lands in `awaiting_human_submit`. The message is "Portal staged —
   verify and submit manually." **Before telling the customer, confirm it is a real stage**: a
   review screenshot and a learn or portal run artifact exist. For a brand-new jurisdiction,
   see §6 — a mock stage looks exactly like this one.
7. **A human submits.** A person opens the staged application on the portal, reads the filled
   fields, and presses submit. Fees are paid there, by them. If they use our Approve & Submit
   button, that action is auth-gated and audit-logged with their name, because a filing must
   always be attributable to a person — and for most portals it still hands off to the human
   for the final click rather than clicking it itself.
8. **After.** The permit monitor watches for status changes and corrections. A correction
   reopens the filing through a named form; the automation refills and a human files again.

---

## 8. Troubleshooting the first week

Start with `npm run ops` for anything vague. It prints the job queue, recent failures, every
project that cannot stage **and why**, recent portal recipes, and the latest run artifacts —
all of which used to have to be reconstructed by hand from four places while an operator was
blocked. Add `--errors` for the tail of the backend log.

| Symptom | Most likely cause | Diagnose with |
|---|---|---|
| "Can't submit yet" / the project will not stage | One of the five 409 gates in §7.5 — usually a missing document or a blank licence number | `npm run ops` — it names the blocker per project. Then `npx tsx scripts/onboarding-readiness.ts --client=<id>` if it is a client-data blocker |
| The run says there is no stored credential, or it sits on the login form after submitting | Either `SESSION_ENCRYPTION_KEY` changed (decrypt fails SILENTLY and returns "no credential"), or the stored portal URL's host/path segment does not match the target | `curl -s localhost:4173/health` → `config.sessionKeySet`; then `npx tsx scripts/onboarding-readiness.ts --client=<id>` for the credential and URL checks. **Do not retry the login repeatedly — that is how accounts get locked** |
| A learn or a stage failed, and the status message is not enough | Anything from a portal notice to an engine gap | The bundle at `data/learn-runs/<runId>/` — `result.json` for the verdict, `events.jsonl` for the timeline, `pNNN-before/after-*.png` for what the page actually looked like, `pNNN-plan.json` for what the planner decided. `GET /api/learn-runs` lists runs; `GET /api/learn-runs/<runId>/bundle.zip` downloads one to attach to a bug report |
| The project is stuck, message mentions a challenge | `paused_for_human`, `pauseReason: mfa_captcha`. Expected behaviour, not a bug | `npm run ops`. A human clears the challenge in the open browser on the desktop running it, then re-stage. If the run happened on a headless server there is no browser to clear — re-run it somewhere with a visible browser |
| A "staged" filing for a jurisdiction we have never touched, with no screenshot and no recipe | The mock adapter staged nothing (§6) | `npm run ops` — look for a recipe row and a run artifact for that jurisdiction. If both are absent, run the learn (§6) against the real portal URL and re-stage. **Do not tell the customer it was staged** |
| A jurisdiction "has a recipe" but every filing re-learns from scratch | The recipe's status is `recording` or `needs_rerecord`, which do not replay — only `complete` does. 55 of our 76 rows are `needs_rerecord` | `npm run ops` prints the status per recipe row. Treat anything but `complete` as no recipe (§6) |
| A benchmark sweep returns nothing for the host you named | The credential is flagged stale, and the stale skip is applied after `--host` | Re-run with `--include-stale` once the credential is fixed; a SUCCESSFUL login is what clears the flag (§6). Do not keep re-running a refused login |
| Two runs against one portal both "failed" at or after login | Session eviction — the portal allows one session per account and the learn lease is in-process only | Nothing to fix in the engine. Re-run them ONE at a time and compare. Assume the pair of results is void, not the portal (§6) |
| A deep portal reports a partial walk that looks like an engine limit | The 8-minute default per-portal budget truncated it | Re-run that host with a larger `--portal-timeout` and read the page trace before concluding anything (§6) |

Two habits that save the week:

- **Read the last banner, not the exit code.** The test chains are `&&`-joined and the exit
  status has misreported three times. Same discipline for scripts: read the output.
- **Suspect the measurement before the portal.** Wrong verdicts in this system have come from
  the harness far more often than from the recipe — low disk, a stale credential flag, two runs
  sharing one portal account, a benchmark address in the wrong city.

---

## 9. What to tell the customer when a portal is not yet supported

Be specific and own the timeline. "Not supported yet" with no reason and no date reads as "this
product does not work". Every one of our stopping points has a named reason and a named owner.

Find the reason first (`npm run ops`, the learn bundle, or the last benchmark row), then use the
matching line:

| What is actually true | What to say | Who unblocks it |
|---|---|---|
| We hold no login for that portal | "We need an account on that portal before we can file there. Portal accounts have to be registered by a person on the portal's own site — several require an emailed code — so that first step is yours; send us the login the safe way and we will take it from there." | Customer |
| The stored login is rejected | "The credentials we have for that portal are being refused — usually because the password was rotated and we were not told. We deliberately do not retry, because repeated attempts lock the account, so that portal is paused until we have a working login. Send us one the safe way and we will re-verify the same day. Standing request: tell us the day you rotate a portal password, because we cannot detect it — we find out when a filing fails." | Customer |
| The portal requires MFA or a CAPTCHA at login | "That portal challenges every new session. We can fill the whole application, but a person has to clear the challenge at the browser. That is a permanent design choice on our side — we do not solve CAPTCHA or MFA — so filings there need someone available, not just a queue." | Human, by design |
| The portal blocks automated browsers | "That portal actively blocks automation at the network level. We can't drive it, and working around a bot block is not something we will do. Those filings stay manual." | Nobody — it stays manual |
| We log in but the application form is not filling yet | "We can reach the application but not yet fill it reliably. We don't want to hand you a half-filled filing, so that jurisdiction is manual until we have driven it properly. Each of these takes a focused engineering pass; tell us your volume there and we will prioritise accordingly." | Engineering |
| We have never seen the jurisdiction | "This is a new jurisdiction for us. The first filing there needs a learn run against the live portal — roughly a quarter-hour of supervised driving, once. After that it replays, for you and for everyone. We would rather do that before your first filing than during it." | Us, before their first filing |
| A required choice is operator knowledge we do not have | "The portal asks which permit category residential rooftop solar files under in that city. We will not guess — guessing files the wrong record type, which is worse than waiting. Tell us what your team files it as, and it is a one-time answer that then applies to every filing there." | Customer's knowledge, our data |

Five things never to say: that the fee, the final submit, or the CAPTCHA will be automated in
a future version; that a jurisdiction works because a filing showed as "staged" (check for the
artifacts first); a per-portal success rate we have not measured with `--repeat`; that teaching
a portal leaves no trace in their account (it leaves drafts they have to cancel — §2); or that
their credentials are "encrypted at rest" full stop, when their live portal sessions sit
unencrypted in `portal-profiles/` (§5).

---

## Appendix — environment this runbook depends on

| Variable | Onboarding meaning |
|---|---|
| `SESSION_ENCRYPTION_KEY` | Encrypts every stored portal login. Must be a real value — the `.env.example` placeholder counts as missing. **Rotating it without `npm run rekey:credentials` destroys every stored login, silently.** |
| `AUTH_SECRET` | Set it to its OWN stable value. It defaults to falling back to `SESSION_ENCRYPTION_KEY`, which means a key rotation logs every user out. |
| `AUTOPILOT_DB_PATH` | Which database the scripts write to. Wrong value = silently provisioning into a scratch DB. |
| `PORTAL_HEADLESS` | `false` on an operator desktop, so a human can clear a challenge in the visible browser. A headless server cannot complete a paused filing at all. |
| `PORTAL_ALLOW_FINAL_SUBMIT` | Leave it unset. It is one half of the double gate on operator-delegated final submit and has no place in onboarding. |

Related reading: `docs/onboarding/INTAKE_CHECKLIST.md` (what to collect),
`docs/onboarding/CAPABILITIES.md` (measured capability per platform),
`docs/HANDOFF.md` (current state, open issues, what to verify after each pull),
`docs/SERVER_SETUP.md` (hosting), `docs/products/README.md` (the split-out products).
