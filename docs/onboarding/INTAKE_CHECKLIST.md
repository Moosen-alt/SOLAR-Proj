# Intake Checklist — what to ask a new solar company for, and what breaks without it

Audience: the operator onboarding an installer. Work top to bottom on a call or a shared
form, then transcribe into a copy of `docs/onboarding/intake-template.json` and run
`scripts/onboard-company.ts`. Read `docs/onboarding/intake-template.json` alongside this
file — it is the same list, laid out to fill in. Where the two ever disagree about a key
name, the script's own `--example` output wins over both (see the note below the markers).

Markers: **REQUIRED** · **REQUIRED-IF (condition)** · **OPTIONAL** · **IGNORED**. "Required"
here means one of two different things and the difference matters, so it is stated per item:

- **A hard gate.** The code refuses. `ccbLicenseNumber` is the only one on the client
  record: `prepareSubmission` throws a 409 `needsCcb` — *Submitting client "X" has no CCB
  license number on file* (`backend/src/repository.ts:5278`).
- **A blank portal field.** Everything else is unenforced. A missing licence number does
  not throw; `clientStagingOverlay` (`backend/src/clients.ts:220`) simply drops the empty
  key, the portal field stays blank, and the filing is REJECTED BY A HUMAN AT THE AHJ days
  later. That is the quiet failure mode this checklist exists to prevent — the run says
  "staged" either way.

**IGNORED** means what it says: the script reads the key and does nothing with it, or never
looks for it. Collect the answer if it is useful to a human, but do not expect the system to
act on it, and never tell a customer a setting exists because a field for it does.

Three fields are **not in the dashboard client form at all** — `docketNumber`,
`standardDisconnectMake`, `standardDisconnectModel` (verified: no reference to any of them
in `frontend/dashboard.js`). They can only be set through the intake JSON, the API, or raw
SQL. If you collect them on a call and then type them into the Clients screen, there is
nowhere to put them and they are silently lost.

**A field name the script does not recognise is a field that does nothing**, so two habits
before a real run. First, `npx tsx scripts/onboard-company.ts --example` prints the exact
shape the script consumes — that output, and the script's bare usage text, are the authority
on key and flag names, not this document. Second, read the dry run's WARNINGS block: it
names every unrecognised key — in the `client` block **and** at the top level of the file, so
a stray top-level key gets named rather than silently ignored (`jurisdictions[]` is warned
about on every run for exactly that reason — §6; it is intelligence, not configuration). The
gap that remains is one level down: a misspelled key **inside** an `org`, `users[]` or
`portalCredentials[]` entry is read by nothing and warned about by nothing. Check those
against `--example` character by character.

---

## 0 · Before the call (your side, not the installer's)

1. `SESSION_ENCRYPTION_KEY` set to a real value in `.env` — not blank, not the literal
   `replace-with-a-long-random-secret`, which is rejected identically to unset
   (`portal-bot/src/cryptoStorage.ts:28`). `createPortalCredential` encrypts
   synchronously, so with no key the first credential write **throws** and the intake run
   dies partway. Generate with `openssl rand -base64 32`.
   **LOSING OR ROTATING THIS KEY LOSES EVERY STORED PORTAL LOGIN** — and it fails
   silently, as "no stored credential for this client", never as a crypto error. Rotate
   only via `npm run rekey:credentials`.
2. `AUTH_SECRET` set to its **own** stable value. It falls back to
   `SESSION_ENCRYPTION_KEY` for signing session cookies (`backend/src/auth.ts:18`), so
   without it a key rotation logs out every user in the fleet.
3. `AUTOPILOT_DB_PATH` pointing at the DB you mean. Run the intake once with `--dry-run`
   first.

---

## 1 · Company identity

| Field | Marker | Why we need it / what breaks |
| --- | --- | --- |
| `companyName` | **REQUIRED** (hard gate) | `createClient` throws 400 *companyName (or legalBusinessName) is required.* One of these two must be non-blank. |
| `legalBusinessName` | **REQUIRED** | This is what goes on the permit and the interconnection application. It is the first source for `installerCompanyName` in the staging overlay (`legalBusinessName \|\| companyName`), so a blank one silently files under whatever they trade as. Ask for the name exactly as it reads on the contractor licence — an AHJ that cross-checks the licence against the applicant name rejects a DBA. |
| `dba` | **OPTIONAL** | Stored for the record. Reaches no portal fill and no AHJ form today (it is not a key in `clientStagingOverlay`); it is a fallback for the display name at `server.ts:612`. Nothing breaks without it. |
| `contactName` | **REQUIRED** | Fills `installerContactName` on every portal that asks who the applicant contact is. Falls back to `authorizedSignerName` if blank, so with both blank the contact-name field stays empty — and most permit portals treat that as a validation error on the page, which stalls the walk rather than failing loudly. |
| `contactEmail` | **REQUIRED** | Fallback for `installerEmail` behind `businessEmail`. This is the address the AHJ mails corrections to. Wrong address = a suspended filing nobody sees. Note it is **not** a fallback for our own outbound updates — those read `businessEmail` and nothing else (see that row). |
| `phone` | **REQUIRED** | Fallback for `installerPhone` behind `businessPhone`. |
| `businessAddress` | **REQUIRED** | Fills `installerStreet` / `installerAddress`. Blank means a blank contractor-address block, which is a rejected permit application at most AHJs. |
| `businessCity` / `businessState` / `businessZip` | **REQUIRED** | Filled separately AND recombined into `installerCityStateZip`, because some portals want one field and some want three. **Zip must be exactly 5 digits** — Accela's Add-Contact dialog validates `#####` and refuses ZIP+4. |
| `businessPhone` | **REQUIRED** | Primary source for `installerPhone`, and it is also split into per-segment keys (`phoneSegmentKeys`) for portals with three separate area/prefix/line boxes. Give it as a plain 10-digit number; formatting is handled. |
| `businessEmail` | **REQUIRED** | Primary source for `installerEmail`, and — this is the part that gets missed — **the only address we ever send the company anything at.** `notifyClientOfStatusChange` (`backend/src/clientNotifier.ts:118-123`) reads `clients.business_email` and returns silently if it is blank. There is **no** fallback to `contactEmail`. So a blank one means the installer is never told the permit was issued, never told a correction landed, and never gets the read-only status link — with no error anywhere, because in the service-bureau lane those emails are the only thing they receive from us at all (§8). Ask for a shared inbox, not one person's address. |
| `ein` | **OPTIONAL** | Ask for it because AHJ business-licence paperwork wants it, but be clear-eyed: there is no overlay key feeding it, so a portal field labelled EIN or Tax ID is **not** auto-filled — and it never will be recorded as a literal either, because that label is in the sensitive set (`autoLearn.ts:970`, `autoLearnAdapter.ts:335`) and binds at replay or is redacted. An EIN-requiring portal is a human fill. **Write it, never echo it** — no log line, no console output, no support ticket. |
| `notes` | **OPTIONAL** | Internal free text on the client row. Not fed to the LLM (the LLM-visible notes columns are `portal_credentials.notes` and `permit_utility_knowledge.notes`), but keep secrets out on principle. |

## 2 · Licensing

Ask for the *number as printed on the licence*, and ask which state issued it. Every one of
these lands in the staging overlay and is typed into a real application.

| Field | Marker | Why we need it / what breaks |
| --- | --- | --- |
| `ccbLicenseNumber` | **REQUIRED** (hard gate) | The contractor/CCB licence number. This is the **only** client field the code enforces: `prepareSubmission` throws 409 `{needsCcb: true, clientId}` and nothing stages until it is filled (`repository.ts:5278`). Digits only, no state prefix. |
| `ccbExpiration` | **OPTIONAL** (strongly recommended) | Free text, unvalidated, reaches no portal fill. Its whole value is that you can see an expiry coming — an expired licence is not a code failure, it is an AHJ rejection of every filing until renewed. Store ISO `YYYY-MM-DD` so it sorts. |
| `electricalLicenseNumber` | **REQUIRED-IF (they pull electrical or combo permits, i.e. almost always)** | The *company's* electrical contractor licence. Distinct from the two fields below. Many AHJ permit forms require the company licence, the supervising electrician's name, and that electrician's personal licence — all three (`shared/src/types.ts:82-86`). A blank one is a blank required field on the electrical permit. |
| `electricalSupervisorName` | **REQUIRED-IF (electrical/combo permits)** | The supervising electrician's full name, as licensed. |
| `electricianLicenseNumber` | **REQUIRED-IF (electrical/combo permits)** | That individual's **personal** licence, not the company's. Installers routinely give the company number twice; ask explicitly for "the supervisor's own licence number". |
| `metroCityLicenseNumber` | **REQUIRED-IF (they file in a metro/city that licenses contractors separately — e.g. Portland Metro)** | A regional business licence number some AHJs require in addition to the state licence. Blank means a blank required field in exactly those jurisdictions and nowhere else, so it is easy to miss until the first Portland filing bounces. |
| `docketNumber` | **REQUIRED-IF (they file in Illinois)** | The installer's ICC Part 468 Distributed Generation Installer certification docket number (83 Ill. Adm. Code Part 468). **Ameren Illinois' PowerClerk interconnection form has a REQUIRED "Docket Number" field** — before this became a client field, every Illinois learn left it blank (`backend/src/db.ts` migration v15). Enter it **digits-only: `16-0001` becomes `160001`** (`docs/IL_ONBOARDING.md`, confirmed against the source; the same portal wants account numbers digits-only too). It is per-installer, not per-project, so you collect it once. **Not settable from the dashboard** — intake JSON or API only. |
| `authorizedSignerName` | **REQUIRED** | Who signs on behalf of the company. Fills `authorizedSignerName` on every portal with a signature block, and is the fallback for `installerContactName`. |
| `authorizedSignerTitle` | **REQUIRED** | e.g. "Managing Member", "Operations Manager". Portals that ask for a signer title treat it as required; blank stalls the page. |

## 3 · Insurance and bond

| Field | Marker | Why we need it / what breaks |
| --- | --- | --- |
| `bondCarrier` | **OPTIONAL** | Carrier name for the contractor's surety bond. **Reaches no portal fill and no AHJ form today** — it is not a key in `clientStagingOverlay`. Collect it because AHJ business-licence packets ask for it and because you need to know whether they *have* one; nothing automated breaks without it. |
| `insuranceCarrier` | **OPTIONAL** | Same: stored, not filled. |
| Certificates of insurance and the bond document itself | **REQUIRED-IF (an AHJ in their list demands a COI upload)** | These are **not** intake fields — there is nowhere on the client record for a file. Keep the PDFs where the human who does the upload can reach them, because a COI attachment is a human step. Ask now, while you have their attention, which carriers and expiry dates apply. |

## 4 · Standard equipment

| Field | Marker | Why we need it / what breaks |
| --- | --- | --- |
| `standardDisconnectMake` | **REQUIRED-IF (they file any NEM/interconnection application — so: yes)** | The manufacturer of the AC disconnect they actually install, e.g. `Eaton`. |
| `standardDisconnectModel` | **REQUIRED-IF (same)** | The full part number, e.g. `DG221URB`. **Why this is a per-installer field and not a per-project one:** a plan set's equipment schedule specifies only the RATING — "AC DISCONNECT 1 60A NON-FUSIBLE AC DISCONNECT, 240V" — and leaves the part to the installer, while utility interconnection portals require a manufacturer AND a model. A PacifiCorp learn failed promotion on exactly "Disconnect Switch Manufacturer" / "Model" for want of these two values (`backend/src/db.ts`, `CLIENT_LICENSING_COLUMNS`). **Not settable from the dashboard** — intake JSON or API only. |

Two things to say out loud on the call. First, this is a CONSTANT that will be typed onto
every job while the plan set varies per job, which is exactly where a silent mismatch
hides — so the QC layer cross-checks the part number against the plan set and warns when
they disagree (`backend/src/baselineRules.ts:368`, `xcheck-disconnect-fusing` and
`xcheck-disconnect-rating`). Eaton's DG-series part numbers state their own fusing and
frame: the `U` in `DG221URB` means unfused and the `221` frame is the 30 A / 2-pole / 240 V
switch. Filing a 30 A non-fusible part against a plan set calling for a 60 A FUSIBLE switch
is wrong on the application AND wrong on the roof. Second, that mismatch is real, not
theoretical: on four real plan sets, two called for FUSIBLE while the installer's standard
part was non-fusible. If they use more than one standard part, record the most common one
here and expect the warnings — the per-project value from the parser overrides it.

Module, inverter and battery makes/models are **not** intake fields — they come from each
plan set, and certified-name normalisation comes from the shared `cec_equipment` table, so
a new company inherits it from the first project.

## 5 · Portal logins

One entry per portal account, in `portalCredentials[]`. Read §"Collecting portal passwords
safely" below before you ask for any of this.

| Field | Marker | Why we need it / what breaks |
| --- | --- | --- |
| `portalUrl` | **REQUIRED** — the single most important field in the file | This, not `portalType`, is what finds the credential at run time. `selectCredentialUrlsFor` matches on **hostname AND the first path segment** (`backend/src/portalCredentials.ts`), because Accela serves every city from one host — `aca-prod.accela.com/sandiego` vs `/SACRAMENTO` vs `/lascruces` — and a host-only match would type one city's password into another city's login and lock the account out. A host match with a *different* segment is refused outright rather than used as a near-miss. So: paste the **real login/entry URL including the jurisdiction path segment**, copied from the installer's browser bar while they are logged in. A wrong URL means the credential is simply never found, and the symptom is "still on the login form after submitting" — not an error naming the URL. Must parse as a URL (or be exactly `""`); max 1000 chars. |
| `portalType` | **REQUIRED** (cheap to get wrong) | Display and routing label, canonical form `"<STATE> · <Platform>"` with a space + **U+00B7 MIDDLE DOT** + space — `WA · SmartGov`, `MD · Accela Citizen Access`, `FL · Tyler EnerGov (CSS Self Service)`. Not a bullet `•`, not a slash. Unrecognised platforms fall back to `Unknown (<host>)`. Max 120 chars. Getting it wrong costs almost nothing at run time; getting `portalUrl` wrong costs the whole filing. |
| `username` | **REQUIRED** | 400 if blank. Stored twice: as a plaintext `username_reference` for display and audit, and inside the encrypted envelope. |
| `password` | **REQUIRED-IF (this credential row does not exist yet — so: always, the first time)** | Goes **only** into the AES-256-GCM envelope; the API never returns it and the credential view exposes `hasSecret` only. Max 1024 chars. **On a credential that already exists, a blank `password` means "leave the stored secret alone"** — it is not an error and it does not blank the envelope. That is what makes a secret-stripped intake file re-runnable (§"Collecting portal passwords safely", item 6). It also means a blank password can never *fix* a wrong stored one: to change a password you have to supply the new one. Credential rows are keyed by `portalUrl` within the client, so a typo in the URL creates a second row rather than updating the first. |
| `securityAnswers` | **REQUIRED-IF (the portal challenges security questions on a new device)** | Rides inside the same encrypted envelope, and is carried across a password rotation so re-encrypting cannot silently drop it. **CAVEAT: this key only works on the script path.** `portalCredentialCreateSchema` (`backend/src/validation.ts:25`) does not declare it and zod strips unknown keys, so over the REST API the answers vanish with no error. Without them, a portal that challenges on a new device stalls for human capture even though the installer told you the answers. Format is free text — `question: answer; question: answer`. **On a re-run, treat this differently from `password`:** the answers ride in the same envelope, so before applying a re-run of a file you stripped, read the dry run's PORTAL CREDENTIALS block. If a credential line reports `to update  secret …`, stop — you are about to rewrite an envelope you no longer hold the answers for. The safe move is to delete that credential's entry from the kept file entirely (§"Collecting portal passwords safely", item 6). |
| `notes` | **OPTIONAL** | **PLAINTEXT AND LLM-VISIBLE** — declared so in the column's own comment at `backend/src/portalCredentials.ts:70`; treat it as reaching a prompt. Operational hints only: "login emails a one-time code (human-capture at login)", "account is under the electrician's name". **Never** a password, a security answer, an account number or a meter number. Max 2000 chars. |

**`client.portalIdentities[]` — OPTIONAL, and leave it out unless you have a reason.** It
exists for the portal where the login account's display name is not the legal name, or where
the portal has an existing-contact code to reuse (`powerclerkExistingContact` /
`accelaContactCode`). Shape: `{portalType, installerCompanyLabel, installerContactCode,
notes}`, and it is a **full replace** — passing it on an update deletes the rows it does not
re-list. **Omitting the key entirely leaves the stored rows untouched; passing `[]` deletes
them all.** Those are not the same thing, and they matter on the re-run of a kept file: if
this company has identity rows and your file says `"portalIdentities": []`, the re-run wipes
them. Delete the key, don't blank it. (On a brand-new client there are no rows to lose, so
`[]` and absent are the same thing there.)

Two cautions before you fill one in. It is matched against the `portalType` the
staging run resolves, and that is `portalProfile?.portal_type ?? "mock"`
(`repository.ts:5319`) with **nothing in the repo writing `portal_profiles`** — so a row
keyed to a real platform label matches nothing today, and a row keyed `"mock"` matches
*every* run and becomes a global company-name override rather than the per-portal one
intended. With the array empty, `installerCompanyName` falls back to
`legalBusinessName || companyName`, which is the right answer almost always.

Also ask, per portal, and record in `notes`: does login send a one-time code to an email
inbox, and **which** inbox? A portal flagged for emailed codes is a human-capture step at
every login by design (hard rule 1 — automation never solves CAPTCHA or MFA), and if the
code goes to an inbox you cannot reach, that portal can never be driven at all.

**Two commitments to get from them out loud, on the call. Both are theirs to keep, not ours.**

**1. "Tell us the same day you rotate a portal password, and re-supply it."** Not next
week, not at the next filing. **We cannot detect a rotation.** There is no credential
health check that runs on a timer; the first thing that notices is a filing that fails at
the login form, and by then the run is burnt and the filing is late. The engine records the
refusal (`last_login_failed_at` newer than `last_login_ok_at` = stale) and then deliberately
**stops retrying that host**, because repeated attempts against real accounts lock people
out — so the failure is sticky until a human clears it. This is not hypothetical: **12 of
the 68 credentialed hosts in the database are stale right now** (measured 2026-09-09), and
every one of them is a login somebody changed without telling anybody. A rotated password
they tell us about the same day costs one minute of typing; the same rotation discovered at
filing time costs a filing. Ask specifically who at their company changes portal passwords,
and get *that* person's name — it is usually not the person you are onboarding with.

**2. Their MFA policy is our staffing requirement.** If a portal account challenges MFA or
emails a one-time code, **a human has to be at the browser at run time, every session.**
Automation never solves it, under any flag (hard rule 1), and there is no service we can add
that changes it. Fixed security questions we can store and replay (`securityAnswers` above);
a code to somebody's phone we cannot. So ask, per portal: **can they put us on a dedicated
account whose MFA policy they control** — a shared service account, or one with MFA scoped
to a shared inbox we can reach — rather than on a personal login tied to one employee's
phone? Where the portal allows it, that is the difference between "we can file for you" and
"we can file for you when Dave is at his desk". Many portals do not allow it; record which
ones in `notes`, because that is a permanent constraint on their volume, not a bug to chase.

Tell them plainly what we do **not** do: **we do not create portal accounts.** Every AHJ
and utility account must already be registered by a human on that portal's own site, and
many registrations require an emailed one-time code. That is the first genuinely
unautomatable link in the chain and it is upstream of everything else here. If they have no
account for a jurisdiction they file in, the answer to "when can you file there" is "after
you register".

### What handing us a portal login actually means for them — say all four

Consent to store a password is not the whole of what they are agreeing to. Say these out
loud at intake, not after the first one surprises them.

1. **We will leave real, unfinished draft applications inside their portal account, and
   somebody on their side has to cancel them.** This is not a malfunction; it is how the
   thing works. Every learn run and every replay fills a live application under their login
   and stops at the review screen without submitting — and portals with per-field autosave
   (PowerClerk is one) have already persisted a draft by then. A benchmark run says so in
   its own output: *"Each live run WOULD leave a draft application on its portal under the
   name …for the operator to discard"* (`backend/src/runReplayBenchmark.ts:248-254`). A run
   killed mid-flight leaves one too, and the recovery path escalates exactly that — *"Check
   the portal for a partial application before re-staging"* (`jobQueue.ts:337`). So: after a
   learn or a measured sweep against their portals, **their** account holds drafts naming a
   test homeowner or a real one, and no automation deletes them. Agree now who checks for
   stray drafts and how often, and tell them not to submit one by accident.
2. **Stray drafts are not only untidy, they corrupt what a learn run records.** A stale
   abandoned draft is one of the two named reasons a learn walks a partial form, and the
   automatic-promotion guard exists specifically to stop such a pass being saved as a
   replayable recipe (`portalRecipes.ts:284-289`). Their housekeeping is upstream of our
   recipe quality, so it is worth asking for rather than assuming.
3. **Their live portal session sits unencrypted on our disk.** Cookies and session storage
   for their logins live in plaintext under `portal-profiles/<clientId>/<portalType>/`
   (`repository.ts:5516`, `autoLearn.ts:475`), and **`SESSION_ENCRYPTION_KEY` does not cover
   it** — it protects the stored password, not the live session. It is per-client so
   sessions never bleed between companies, and it is gitignored, but it is filesystem
   security only: anyone with the box has their portal session. See item 9 of "Collecting
   portal passwords safely" for the handling rules. If their security team asks where their
   credentials live, this directory is part of the honest answer, not just the encrypted
   column.
4. **Their portal's audit log will show these sessions under whatever account they gave us.**
   That is the reason for preferring an account created for us, named so the log reads
   truthfully (item 3 of "Collecting portal passwords safely"). A shared personal login makes
   every one of our runs look like that employee.

## 6 · Jurisdictions they file in

`jurisdictions[]`, one entry per `{state, ahj, utility}` combination they actually submit
into. Give the AHJ name as the portal spells it ("City of Woodburn", not "Woodburn"), and
the utility as its operating name.

**Marker: REQUIRED — but as intelligence, not as configuration, and `scripts/onboard-company.ts`
does not read the key at all.** It parses `org`, `client`, `users`, `portalCredentials` and
`entitlements`, so a `jurisdictions[]` block writes no row — the run names it in WARNINGS
("a top-level key this script does not consume") and carries on. Collect it anyway: it is
the input to the readiness check, which takes the same list as
`--jurisdictions "STATE|AHJ|UTILITY, …"` and otherwise infers it from the client's existing
projects. These rows are not a per-tenant setup step, because the knowledge tables are
shared on purpose:
`permit_utility_knowledge`, `portal_recipes`, `jurisdiction_code_profiles`,
`ahj_form_templates` and `cec_equipment` carry no `org_id`, so a brand-new company inherits
every AHJ, portal URL, required-document list, form map and portal quirk already learned.
What the list buys you is knowing, before you promise anything, which of their jurisdictions
we have actually driven.

**What breaks without it** is the worst failure mode in the system, and it is silent: for a
jurisdiction with no recipe and no known portal URL, staging routes to `MockPortalAdapter`
and reports **a successful stage that never opened a browser**
(`repository.ts:5629`, and `portal_profiles` has zero INSERT sites in the repo). "Staged"
is not proof of anything for a jurisdiction nobody has pointed the recorder at.

**"It has a recipe" is not readiness, and this is the trap that reads as a lie to a
customer.** A `portal_recipes` row exists in one of three statuses and only ONE of them
replays. `findCompleteRecipeForProject` matches `status = 'complete'` and nothing else
(`backend/src/portalRecipes.ts:114-126`), so a row in either other state delivers **zero
recorded fills** at run time. In this database, as measured 2026-09-09: **6 complete, 15
recording, 55 `needs_rerecord`.** A row lands in `needs_rerecord` when a replay step failed
against the live portal (`repository.ts:5724`), when a learn could not complete
(`autoLearn.ts:920,951`), or when the stale-recording sweep found an abandoned recording
with no snapshot to restore (`jobQueue.ts:377-384`) — i.e. it is the record of a learn or a
replay that **failed against the live portal**, which includes recipes that once worked and
were demoted as well as passes that never worked at all. Which of those a given row is, the
status alone does not tell you; either way there are nine times more of them than there are
working recipes.

So classify each jurisdiction into **five** states, not four, before you promise a date:

| State | What actually happens on their first filing |
| --- | --- |
| **Complete recipe** | Replays deterministically. The only state that means "we have driven this". Six of them exist. |
| **Recording (draft)** | Does not replay. Carries an entry URL, so the run drives the portal — as a fresh learn. Seven of the fifteen hold no steps at all. |
| **`needs_rerecord`** | **Does not replay, and reads as "we have that portal" in every list that only shows the AHJ name.** Every one of the 55 carries a portal URL, so this is *not* the mock trap — the run opens a real browser and re-learns from scratch: roughly 11 minutes, live LLM cost, and it can pause for MFA or fail the same way it failed last time. Plan it as "a supervised learn run", never as "covered". |
| **KB portal URL only, no recipe row** | Same as above: a real browser, a from-scratch learn, supervised. |
| **Nothing — no recipe, no KB portal URL** | Staging routes to `MockPortalAdapter` and reports **success without opening a browser.** Cannot be filed into. Never forward that "staged". |

`npx tsx scripts/onboarding-readiness.ts --client <id>` prints this per jurisdiction and
distinguishes `complete` from `draft only (status "…")`, which is the fastest way to get the
classification right instead of guessing from an AHJ list.

Scope the promise honestly — `docs/onboarding/CAPABILITIES.md` is the dated, cited version
to read to them; the short form is this. Of 54 credentialed portals measured
on one build (68 hold credentials at all), 26 log in, 17 record a recipe that actually fills
fields, and exactly one — Ameren Illinois NEM on PowerClerk — completes the full
learn → review → replay → review loop repeatably (3/3 attempts, self-test passing, 8 pages,
~70 fills, stopping at the portal's own Step 7 Payment). That 26 is 26 of 54 measured, NOT
26 of 68. OpenGov (4 hosts), Tyler EnerGov (5), Citizenserve and BS&A Online have never got
past login in a measured sweep; eTRAKiT was never measured at all (the host did not
respond). Every other portal stops earlier for a reason the run names, and final submit, fee
payment and CAPTCHA/MFA are always a human's job by design.

Reconcile those two paragraphs before you quote either: **"17 recorded a recipe that fills
fields" was true of that sweep; "6 are `complete` today" is true of the database now.** They
do not contradict each other, because a recipe is demoted the moment a replay step fails
against the live portal (`repository.ts:5724`) — portals change, and a recipe recorded in a
sweep three months ago is not an asset you still hold. Do not read a historical sweep number
as current coverage in either direction; the recipe-status count is the current number, and
`npm run ops` prints it.

Do **not** write anything client-specific or homeowner-specific into these shared KB rows
while onboarding. `permit_utility_knowledge.notes` is pooled across every tenant and up to
700 characters of it are fed verbatim into the research prompt.

## 7 · Billing

| Field | Marker | Why we need it / what breaks |
| --- | --- | --- |
| `billingMode` | **REQUIRED** (get it right on purpose) | `"per_submission"` **gates staging** behind a paid or waived `submission_payments` row; `""` or `"monthly"` applies no gate (`backend/src/db.ts:1520`). Set `per_submission` before a payment flow exists for this client and every filing is blocked with what looks like an unexplained refusal. When in doubt, `""`. |
| `serviceFeeUsd` | **OPTIONAL** | Your per-submission service fee for this client, in USD. The only non-string field: `$` and commas are stripped, negatives rejected, rounded to cents. `null` or `""` clears it and falls back to the `SUBMISSION_SERVICE_FEE_USD` env default — which is usually what you want, so leave it null unless this client has a negotiated rate. |
| `billingStatus` | **OPTIONAL** | Free-text label (`"active"`, `"trial"`, `"suspended"`). Display only; nothing gates on it. |
| Who pays AHJ and utility fees, and how | **REQUIRED** (a conversation, not a field) | There is no field for this because **automation never pays a portal fee, under any flag** — a pay/checkout control is refused at the click gate before anything else is even consulted, and a payment dialog after submit aborts the run. So establish now: does the installer pay by card in the portal, or by mailed check (Ameren Illinois' $50 Level 1 fee is a mailed check within 15 business days, and the application is not reviewed until it lands)? Whoever pays has to be a human who knows it is their job. |

## 8 · Logins — why the company gets none, and what they use instead

**In the standard service-bureau lane the installer gets no login at all, and that is the
design, not a shortcut.** Omit the whole `org` block and the whole `users` array: the company
becomes a `clients` row in your existing tenant (`org-default`) and that is the complete and
sufficient path to a staged filing. `users` is required **only** when the intake creates a
new tenant. Creating a login inside your own org is possible but deliberately awkward — it
needs an explicit opt-in flag on the command line, so read the script's bare usage output for
its exact name rather than trusting this document. Everyone who signs in is *your* staff.

**What the customer gets instead of a login — say this, because "no login" sounds like less
than it is.** Four things, all no-auth and all already built:

- **A tokenized read-only status page** for each project, `/status?token=…`, created on the
  first notification and **emailed to `businessEmail`** when the permit is issued, is ready
  for issue, the NEM application is approved, or a correction lands
  (`backend/src/clientNotifier.ts`). It needs `SMTP_HOST` + `SMTP_FROM` to actually send;
  with SMTP unconfigured the same message is recorded as a **draft** communication on the
  project for a human to send by hand, so it degrades to "someone must remember" rather than
  vanishing. It also needs `PUBLIC_BASE_URL`, or every link in it points at `localhost` and
  is dead on arrival. Check both before you promise them updates.
- **An intake link** — `POST /api/projects/:id/intake-request` returns a shareable URL where
  they type the job valuation and the homeowner's email/phone themselves. No login.
- **A shareable read-only review report** — `POST /api/review/submissions/:id/share` returns
  a `/api/public/review/<token>` URL.
- **Their own portal account** for the one step that is legally theirs: reading the staged
  application and pressing submit, on the portal, under their licence.

**The own-tenant lane is a documented DEAD END today. Do not start down it during an
onboarding call.** An org created this way can never get its own administrator through any
API path, and the reasons are structural, not a missing setting:

- `POST /api/orgs/:id/users` — the only route in the API that writes a password — **hardcodes
  the role to `operator`** in the INSERT itself (`backend/src/server.ts:919`), and so does
  `createUser` (`backend/src/users.ts:52-59`: *"A caller can only ever create an operator
  here"*). It is also `requireAdmin`-gated, so the new tenant cannot even call it for itself:
  every login it will ever have is minted by one of *your* admins.
- There is **no role-elevation route**. Promotion requires a signed-in admin acting through
  `updateUser`, and the new org has no admin to do it. In practice: raw SQL
  (`UPDATE users SET role='admin' …`).
- There is **no set-password and no password-reset route** anywhere. A login created by any
  other path has no `password_hash` and can never sign in — with `AUTH_ENABLED=true` that is
  simply a dead account.
- And an org holding only `permit_reviewer` / `form_filler` **can never stage anything**:
  `autopilot` is the wildcard product, and it is deliberately `apiKeyAuth:false`, so staging
  demands a human session that lands in the audit trail.

If a customer genuinely needs to log in themselves, that is an escalation and a product
decision — not a field in this file.

| Field | Marker | Why we need it / what breaks |
| --- | --- | --- |
| `org` (the whole block) | **OMIT** for the service-bureau lane | Absent = the client lands in `org-default`. Present = you are joining or creating a tenant, which is the dead end above. An `org` block with only a `name` does **not** create anything: it is ignored with a loud WARNING and the client still lands in `org-default`. |
| `org.createTenant` | **REQUIRED (`true`) to create a tenant at all** | The explicit opt-in. **Nothing in this script creates an org without it** — that is deliberate, because a template carrying `{"id": "", "name": "<company>"}` used to mint a separate, invisible tenant on ordinary onboarding. `true` with a blank `org.name` is refused rather than creating an unnamed org. |
| `org.id` | **REQUIRED-IF (joining an org that already exists)** | Must already exist, or the run refuses rather than minting a junk tenant — unless `org.createTenant` is also `true`, in which case that exact id is created. If the id exists but its stored name disagrees with the `org.name` you gave, the run refuses: a one-character typo would otherwise hand this company's clients and logins to an unrelated live tenant and report it as "already exists, unchanged". |
| `org.name` | **REQUIRED-IF (creating a tenant)** — and only alongside `createTenant: true` | Matched case-insensitively against existing org names first; two orgs already sharing the name is a refusal, because name is the only stable key the script has. With no `org.id`, a new id is generated server-side as `org-<8 hex>` — you cannot choose it, and a dry run deliberately does not print one. |
| `org.edition` | **OPTIONAL** | `"full"` or `"review_gate"` (anything else is discarded). A legacy display label that nothing gates on — **except** in the script's create path, where it seeds the default product set via `productsForEdition` when `org.products` is absent, and **defaults to `review_gate` — which grants `permit_reviewer` and nothing else** (`entitlements.ts:98-100`). So a new org created with no `org.products` and no `org.edition` comes up unable to stage anything, and the symptom is a 403 on every staging route rather than a message about products. Display-only on an existing org, load-bearing on a new one; name `org.products` explicitly and do not rely on it. |
| `org.products` | **REQUIRED-IF (a new org)** | The entitlement list, `org.products` inside the `org` block. A top-level `entitlements` array is an accepted alias for it; naming **both**, differently, is a refusal rather than a guess. Either spelling is granted **only** in the tenant lane — in the service-bureau lane the target org is your own, and a customer's intake file must not be able to widen your own licence, so both are ignored with a warning. Values are exactly `"autopilot"`, `"permit_reviewer"`, `"form_filler"`; an unknown one is a refusal. **An org with no entitlement rows can reach nothing** — the gate fails closed with *This account has no active product licence.* on every `/api/*` path. `autopilot` is the wildcard and is deliberately **never** API-key-authenticated, because staging reads portal credentials and files real applications. Do not hand a customer an `x-api-key` and tell them it drives the autopilot. The script grants and never revokes. |
| `users` (the whole array) | **REQUIRED-IF (creating a tenant)** — otherwise **OMIT** | Required only on the tenant-creating path. In the service-bureau lane the company has no login and needs none; a `users` entry there creates an account in *your* org, which is why it takes an explicit flag rather than happening because a template had a `users` block in it. |
| `users[].email` | **REQUIRED-IF (a `users` entry exists)** | Lowercased. `users.email` is **globally** unique, not per-org, so an address already present in another org is a refusal, not a match. |
| `users[].name` | **OPTIONAL** | Blank falls back to the email as the display name (warned). |
| `users[].password` | **OPTIONAL — and unlike `role`, this one is genuinely consumed** | The script hashes it exactly as `POST /api/orgs/:id/users` does (scrypt, `salthex:hashhex`) and this is **the only scripted path to a login that can actually sign in** — `createUser` and `POST /api/users` write no `password_hash` at all. Two consequences. It **never rotates a password already on the row**, because a silent lockout on a re-run could not be undone (there is no reset route). And a real password in the intake file is one more live secret in a plaintext file, so if you use it, treat the file exactly like the portal passwords in §"Collecting portal passwords safely" — and remember that stripping it before a re-run is safe, since a blank leaves the stored hash alone. |
| `users[].color` | **OPTIONAL** | A UI avatar colour, default `#6366f1`. Consumed by the script; harmless. |
| `users[].role` | **IGNORED — do not bother filling it in** | Every user created anywhere in this system is an `operator`, and the script warns that the key is ignored. Recording an intended role here does not create it, and nothing later reads the intent. Ask who needs to log in, then create those accounts deliberately; the intake file is not where roles happen. |

---

## Collecting portal passwords safely

The filled intake file is the weakest link in this whole process. It is a plaintext list of
live portal logins with no encryption and no access control, and it exists only until the
script has run.

1. **Never let the filled file be born inside the repo.** Copy the template out first:
   `cp docs/onboarding/intake-template.json ~/intake/<company>.json`. `.gitignore` does now
   cover the accident cases — `intake/` at any depth, any name containing `intake`, every
   `.json` at the repo root, and every `.json` under `docs/`, with the template itself negated
   back in — but check with `git check-ignore -v <your file>` rather than assuming, and know
   that an ignored file is an invisible one: it sits there with live passwords until you delete
   it. A copy saved anywhere else in the tree is still committed by the next `git add -A`.
2. **Never accept passwords by email, Slack, or a ticket.** Those copies outlive the
   onboarding and you cannot delete them. Use a one-time secret link the installer opens
   themselves, or take them verbally on the call and type them straight into your local
   file.
3. **Prefer accounts the installer created for us**, named so a portal audit log shows who
   acted. Shared personal logins mean their MFA device gates our runs and their password
   change breaks us with no notice.
4. **Never paste a secret onto a command line.** Shell history is a file. Credentials come
   from the JSON file or from a workbook import, never from argv — the same reason
   `rekey:credentials` takes `--old`/`--new` with a shell-history warning attached.
5. **Answers to security questions go in `securityAnswers`, never in `notes`.** `notes` is
   plaintext, and it is fed to the research LLM. `securityAnswers` rides inside the
   AES-256-GCM envelope. Remember it only works on the script path, not over REST.
6. **Delete the filled file when the run reports success**, and empty the trash. The
   passwords now live encrypted in `portal_credentials.encrypted_secret`; the intake file is
   a redundant plaintext copy of them. **If you keep it for the record, strip every
   `password` and `securityAnswers` value first — and the stripped file is still
   re-runnable**, which is what makes this safe rather than a trade-off. The rule that
   reconciles the two is one sentence: **a blank `password` on a credential row that already
   exists leaves the stored secret exactly as it is** (§5), so re-running a stripped file
   still corrects the licence and business fields, still fixes a `portalType` or a `notes`
   line, and does not touch a single envelope. A blank `password` is only an error when the
   row is being **created**, because there would be nothing to keep.

   Three things to know before you re-run a stripped file, all of them checkable in the dry
   run rather than by trust:

   - **Read the PORTAL CREDENTIALS block first.** Every line should say *already exists,
     unchanged*. If one says `to update  secret (username/password/securityAnswers)`, stop:
     that envelope is about to be rewritten from a file that no longer holds the answers.
   - **The safest form of a kept file has no `portalCredentials` entries at all.** The script
     never deletes a credential it was not handed — it only creates and updates — so removing
     those entries removes the risk entirely and loses nothing but a re-typing shortcut.
   - **`portalIdentities` is the one key where blank ≠ absent.** Omitting it leaves the stored
     rows alone; `[]` deletes them. Delete the key when you strip, don't empty it.

   And the same rule applies to `users[].password` if you used one (§8): blank leaves the
   stored hash alone, and the script never rotates a password that is already set.
7. **Verify by status, never by value.** A credential is confirmed by `hasSecret: true`,
   by `set`/`missing` in a script's output, or by `GET /health` reporting
   `sessionKeySet` — never by printing what was stored. The API cannot return a password
   and no script here should either.
8. **Expect refusals and treat them as data.** A stored login the portal rejects is marked
   stale and the benchmark **will not retry it**, on purpose: seventy retries against real
   accounts locks people out. **12 of the 68 credentialed hosts are on that list today**
   (measured 2026-09-09 — the sweep quoted in `CAPABILITIES.md` excluded 11 for this reason
   at the time it ran; the count only goes up between sweeps, because nothing clears it on its
   own). Almost every entry is a password somebody rotated without telling us, which is why
   §5 asks the installer for a same-day notification as an explicit commitment. When the
   installer fixes a credential, clear the flag with
   `npm run learn:benchmark -- --host <host>` rather than re-running the sweep.
9. **`portal-profiles/<clientId>/<portalType>/` holds live portal session cookies in
   plaintext on disk** (`PORTAL_PROFILES_DIR`, defaulting to `./portal-profiles`) and is
   *not* covered by `SESSION_ENCRYPTION_KEY`. It is per-client so sessions never bleed
   between companies. It is gitignored; protect it with filesystem permissions and never
   copy it between clients or machines.

---

## Before you tell them it is done

- `ccbLicenseNumber` non-blank, or nothing will stage at all.
- No value in the file still reads `EXAMPLE`, `000000`, `.invalid`, or `REPLACE-ME`.
- Every `portalUrl` includes the jurisdiction path segment and was copied from a browser
  where that login worked.
- `businessEmail` non-blank — it is the only address any update we send ever reaches, and a
  blank one fails silently.
- Each jurisdiction classified into one of the **five** states in §6 — complete recipe,
  recording draft, `needs_rerecord`, KB portal URL only, or nothing. Only *complete* means
  "we have driven this": there are 6 of those against 55 `needs_rerecord`, and a
  `needs_rerecord` jurisdiction is a supervised learn run, not coverage. The last category
  cannot be filed into at all, and a "successful stage" there is a mock.
- The filled intake file deleted, or its secrets stripped — and if you kept it, you know it
  is still re-runnable (a blank `password` keeps the stored secret) and you deleted rather
  than emptied `portalIdentities`.
- No `users` entry and no `org` block, unless you are deliberately creating a tenant and have
  read §8's dead end.
- The installer has named the person who rotates portal passwords, and agreed to tell us the
  same day (§5).
- `GET /health` reports `sessionKeySet` true and status not `degraded`.
