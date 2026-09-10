# Capabilities & Limits — what the Autopilot does today

Audience: a solar company evaluating this service, and the operator answering their
questions in a sales call. Every number on this page is measured, dated, and carries its
denominator. Where something is unproven, it says so in those words. There are no
projected numbers here and no numbers from a build other than the one named.

Measurement date for everything below: **2026-09-09** (one build). Source files are cited
so any claim can be re-checked.

If you read only one section, read **"Read this before you sign"**. It collects the eight
facts most likely to change your decision — including what this service does with knowledge
learned from your jurisdictions, what it leaves behind in your portal accounts, and the fact
that it has never onboarded a real company.

## What the service does, end to end

You send us a plan set. The system parses it into structured fields (equipment, string
design, addresses, AHJ and utility), runs automated QC against the jurisdiction's adopted
code cycle, and holds the result at a reviewer gate that a human must clear. Once cleared,
it builds and fills the AHJ's own permit documents from your licence and business details,
resolves the correct portal for that jurisdiction and track (permit portals and utility
interconnection portals are kept strictly separate), logs into that portal with your stored
credentials, and walks the application forward — typing addresses, contacts, equipment
makes and models, and the answers the portal demands — until it reaches the portal's review
or payment screen. There it stops, leaves the filing staged with everything filled in, and
tells you it is ready. Then **a human reviews and submits**.

## What is automated, and what a human always does

| Automated | Always a human |
|---|---|
| Plan-set parsing into structured project fields | **The reviewer gate** — QC findings must be cleared by a person before anything is staged |
| QC against the AHJ's adopted code cycle | **Final submit** — the portal's Submit / Continue Application click |
| Building and filling the AHJ's permit documents | **Portal fees and payment** — never automated under any flag |
| Pre-placing your stored signature PNG on prepared permit forms, at the operator's direction | **MFA and CAPTCHA** — never solved, never bypassed |
| Portal login with your stored credentials | **DocuSign / eSign envelopes** — see below |
| Walking the portal's pages and filling its fields | Registering the portal account itself (portals require this on their own site, often with an emailed code) |
| Recording the final-submit step so a human can execute it | Confirming an AHJ's correct permit type the first time (see Known limits) |
| Attaching required documents to the filing | Fixing a refused or expired portal credential |

**On DocuSign specifically:** signing is always a human's job, and we hold no DocuSign
integration and no DocuSign credentials. Where a portal routes signatures through DocuSign
— Ameren Illinois' PowerClerk interconnection page is a live example, carrying an `eSign`
button, a `Sign and Upload` button and a field reading "Enter email where you want Docusign
notification sent" — the automation may type the notification email address so the envelope
reaches the right person. It never presses `eSign` or `Sign and Upload`. The envelope is
signed by a person, in DocuSign, outside this system.

The stored signature feature is not an e-signature service: it is a PNG you upload once,
which the system stamps onto a prepared PDF permit form at your direction. It does not
substitute for a signature a portal or agency requires you to execute yourself.

## Measured reliability (2026-09-09)

### Method, stated plainly

These are **our own portal accounts** driven against **our own benchmark project fixture**
(the `tml-international-llc` installer fixture, with synthetic addresses). They are not a
customer SLA, not a guarantee, and not a measurement of your portals or your jurisdictions.
Nothing here was measured against a live customer filing.

The measure is a rung ladder: did the run reach the portal, log in, enter the application,
reach a form, record steps that actually fill fields, and reach the review screen. Source:
`data/learn-benchmark/latest.json` (== `2026-09-09T22-07-55.json`).

### The one portal measured as a rate, not a run

**Ameren Illinois NEM / interconnection (PowerClerk),
`amerenillinoisinterconnect.powerclerk.com`: 3 of 3 attempts reached the review screen,
and the self-test replay PASSED all three times.** The learned recipe was replayed in a
fresh browser session and reproduced the review screen on each attempt. All three run
directories record `status=trusted`, `pageCount=8`, `recipeStatus=complete`,
`verification.accurate=true` (medium confidence), and `finalSubmitRecorded=true` — the
final-submit step was recorded and never clicked. The self-test verdict is read off that
`trusted` status rather than asserted separately: all three runs carry
`PORTAL_REPLAY_SELFTEST=1` in `run.json`, and the code downgrades a recipe from trusted to
draft whenever the replay fails to reproduce the review screen.

Shape of one attempt: 8 pages, 79 recorded steps, 63-65 recorded field fills, and 10.7 to
11.0 minutes wall clock (`durationMs` 643081 / 644950 / 661668 across the three runs). The
earlier fleet-sweep run of this same portal recorded 70 fills, so 63-70 is the measured
range across all four runs. The review screen is the portal's own Step 7 Payment page
(application fee $50.00, invoice recipient Installer, and a Submit button the automation
records and never presses).

Command: `learn:benchmark --host amerenillinoisinterconnect --repeat 3 --self-test`, one
build, with nothing else touching PowerClerk. Evidence:

- `data/learn-runs/2026-09-09_23-51-36_benchmark-amerenillinoisinterconnect-pow_t3q9/result.json`
- `data/learn-runs/2026-09-10_00-30-24_benchmark-amerenillinoisinterconnect-pow_nx97/result.json`
- `data/learn-runs/2026-09-10_01-09-03_benchmark-amerenillinoisinterconnect-pow_vgmg/result.json`

**Four caveats, all material.**

1. **An earlier pinned run of this same portal reported 67% (2/3), and that number is
   superseded, not hidden.** The missing attempt collided with a fleet-wide sweep running
   in a second process, which opened its own session on this one-session-per-account
   portal and evicted the first. It is excluded as a documented harness collision — our
   measuring code, not the portal. The 3/3 above is the clean re-run with no contention.
   The rule learned from it: same-host runs must never overlap across processes, and there
   is still no cross-process lease to enforce that automatically.
2. **This is ONE portal's repeatability, not a fleet rate.** No other portal has a
   repeat-measured number. Do not read 3/3 as anything beyond this host on this build.
3. **Completeness is NOT pinned.** Reaching the review screen is not the same as a
   complete application. Six required fields were recorded blank at review — Street, Name,
   Company, Address, Inverter Manufacturer, Inverter Model. That note predates this
   session's contact-source and equipment fixes, and neither the 3/3 pin nor the Step 7
   screenshot asserts completeness either way (the Payment page shows the fee, not a field
   summary). So: the loop closes repeatably; "nothing missed" is not yet demonstrated.
4. **3 of 3 means "reached the review screen", not "filed". Even this portal ends in two
   human steps.** The application pages in our own learn bundle carry the portal's notice
   *"Multi-Factor Authentication Required — Your account must have Multi-Factor
   Authentication enabled in order to perform this operation."* Our three runs never paused
   on it (`pauseReason: null`), so it gates an operation past the point where we stop —
   which means it gates **the human's** step: whoever submits needs MFA enabled on that
   Ameren account and their second factor to hand. And the $50 Level 1 fee is **a mailed
   paper check**, within 15 business days of submission, with the application not reviewed
   until the check lands (`docs/IL_ONBOARDING.md:32`). There is no online payment to
   automate even in principle. So on our single best-proven portal, the last two steps —
   an MFA-gated submit and a mailed paper check — are yours.

### First-contact snapshot across the credentialed fleet

This is a **first-contact snapshot, one attempt per portal, on one build. It is not a
success rate and we do not promise it.**

| | |
|---|---|
| Distinct portal hosts holding stored credentials | 68 (across 83 credential rows) |
| Hosts measured in this sweep | 54 |
| Logged in successfully | **26 of 54** (48.1%) |
| Of those, recorded a recipe that actually fills fields | 17 of 26 (65.4%) |
| Of those, reached a review screen | 1 of 26 (3.8%) — Ameren, above |

The table above says 17 and the rung table below says 16 for the same idea; both are right.
17 counts
every run that recorded field-filling steps, which includes the one run that went further
and reached review. The rung table puts each run on its highest rung only, so that one run
appears as `reached review` instead.

Rung distribution across the 54 measured (totals to 54):

| Rung | Count |
|---|---|
| reached review | 1 |
| recorded steps that fill fields | 16 |
| reached a form but filled nothing | 9 |
| login failed | 23 |
| host unreachable | 5 |

Why the 28 inaccessible ones stopped: credential refused 10; login form not recognised by
the engine, or the stored URL is not a login page 5; MFA/CAPTCHA 7 (never solved, by
design); portal blocks automation at a WAF 3; no credential stored 1; host did not respond
2.

Those are the sweep's own labels, and one of them is looser than it sounds: the single "no
credential stored" row (`www.miramarfl.gov`) does have a stored credential with its secret
set. Its stored URL points at the city's solar-permitting information page rather than a
login page, so the credential lookup found nothing to use. Read that row as "the engine
could not match a credential to what it landed on", not as "no credential exists".

**Excluded from the 54, and why it matters:** 68 hosts minus 54 measured leaves 14
excluded. 11 of those were skipped because the portal had already refused those credentials
— the benchmark deliberately will not retry a refused login, because dozens of retries
against real accounts locks people out. Each of those 11 hosts carries exactly one
credential row, so that is 11 hosts and 11 rows. The remaining 3 were skipped for having no
synthetic benchmark address: `pgenm.powerclerk.com` and `pacificorpnetmetering.powerclerk.com`
— PowerClerk utility NEM portals for **Portland General Electric** and **PacifiCorp**, the
same platform as our single best result — plus `aca-oregon.accela.com`. **So the snapshot's
denominator undercounts the platform we have taken furthest.** 26/54 is 26 of the 54
measured, never 26 of 68.

(`pgenm.powerclerk.com` is **Portland General Electric**, an Oregon utility — not Pacific
Gas & Electric. Its stored profile key is `or|unknown|portland general electric`. The
abbreviation "PGE" in this system means Portland General Electric throughout.)

### One earlier number, dated so it is not mistaken for current

A replay sweep on **2026-09-08** (`data/replay-benchmark/2026-09-08T14-22-07.json`, 5
recipes) scored one row `replayed_clean` (PacifiCorp), three `replayed_with_gaps`, one
`steps_failed`, and `submittable` 0 of 5. Two of the three `replayed_with_gaps` rows are
Ameren Illinois and Portland General Electric (`pgenm.powerclerk.com`); the third is an
`aca-oregon.accela.com` row for the City of Coos Bay. The one `steps_failed` row is also
Coos Bay. That sweep predates the 2026-09-09 fixes and **has not been re-run**.
Do not quote it as the current state, and do not quote the 3/3 pin as having replaced it —
they measure different things.

## How a new portal gets supported

The loop is **learn -> recipe -> replay**:

1. **Learn.** The engine opens the portal with your credentials and drives the application
   forward, reading the portal's own validation messages when it gets stuck rather than
   guessing. It fills fields, records every step, and stops at the review screen without
   filing.
2. **Recipe.** A successful walk is saved as a recipe: the ordered steps, the fields, and
   the final-submit step flagged as something only a human executes.
3. **Replay.** The recipe is replayed in a fresh browser session against the same fixture.
   If it reproduces the review screen, it is promoted to trusted. If it does not, it stays
   a draft and the run names what broke.

**What a first encounter costs, honestly.** On a platform already supported, a learn
attempt is minutes: Ameren's is 10.7 to 11.0 minutes for 8 pages and 63-70 fills. On a platform
the engine has never seen, the first encounter has cost **two days of engineering**. Miami's
permit portal (`apps.miami.gov`) turned up sixteen distinct defects on the way in — a
Telerik dropdown whose real input is deliberately invisible, an ASP.NET submit button with
no text label, a results row with no clickable element, two radios sharing one id. Every
one of those fixes was made generic and kill-tested, so the next portal with the same shape
is already handled. But the Miami walk **has not reached a review screen**, and nothing here
claims it has. That two-day figure is the realistic cost of a genuinely new platform, and it
buys fleet-wide improvements rather than one portal.

**Pooled knowledge is why this compounds.** Portal recipes, AHJ and utility profiles,
required-document lists, adopted code cycles, AHJ form field maps, and CEC equipment name
normalisation are shared across all customers on purpose. A quirk learned once for one
company's filing helps every company afterwards. **So a new customer inherits, on day one,
every AHJ and utility already covered** — for those jurisdictions the first filing replays
an existing recipe instead of learning from scratch. A jurisdiction nobody has covered yet
starts from zero.

**Read the pooling clause both ways before you sign it.** Inheritance is the same mechanism
as contribution: what we learn driving *your* jurisdictions goes into the same shared tables
and is then available to every other customer, including your direct competitors. This is
spelled out in full under "What is shared, and with whom" below. If your AHJ know-how is
something you consider a competitive asset, decide about that clause before you sign, not
after your first filing.

## Known limits today

Named concretely, with who unblocks each.

- **A brand-new AHJ with no knowledge-base entry has no real portal URL, and "staged" is
  not proof of anything until one exists.** With no recipe and no known portal URL, a run
  resolves to a mock adapter that reports a successful stage without ever opening a
  browser. The fix is operational, not automated: a human points the recorder at the real
  portal first. Never trust a stage for a jurisdiction whose portal URL has not been
  confirmed.
- **Some AHJ permit taxonomies need a human to confirm the correct permit type once.**
  Miami is the live example: the walk gets as far as Job Description — the recorded trace
  runs to `p13`, and the sweep row for `apps.miami.gov` in `latest.json` measured 11 pages
  and 25 field fills — and can then tick no work item, because Job Category decides which
  work items the portal will ever offer, and the only option beneath the category it reached
  was BUILDING ROOFING. Which
  Job Category and Sub-Category a residential rooftop PV permit files under is operator
  knowledge the engine cannot derive and **must not guess** — guessing is exactly the
  wrong-record-type error the guard exists to prevent. One human answer, recorded once,
  unblocks it for everyone.
- **Refused or expired portal credentials are operator work, not an automation failure —
  and nothing warns you before a filing needs them.** As of 2026-09-09, **12 of the 68
  credentialed hosts are stale** (a refused login more recent than the last accepted one).
  11 of those were skipped by the sweep entirely; the 12th, `aca-prod.accela.com` — which
  carries 12 credential rows — was measured and refused again. A
  further 10 hosts were refused during the sweep itself. The benchmark will not retry a
  refused login by design, to avoid locking real accounts. Every sweep prints the offenders;
  each needs a corrected credential and a re-run. See "Credential rotation is silent" below
  for why this list grows on its own.
- **Nine accessible portals walk pages but fill zero fields.** A recipe that fills nothing
  replays to a blank application, so these count as reached-a-form, not usable. Causes are
  entry-path-specific: ConnectTheGrid dashboards (PECO), a Bitco blank page (Lake Stevens
  WA), an iWorq reCAPTCHA after two pages (Star ID, Canton OH), permittrax and Momentum
  entry paths, a Kent WA reCAPTCHA on page one, a CommunityCore contractor dashboard, and
  Franklin County OH.
- **ComEd (Intellio Connect) logs in and fills but creates no draft application.** Its "+"
  New Application drawer contains zero input fields and its only forward control is
  labelled Submit, which the planner will never nominate. A guarded advance now exists but
  has never been observed clicking on the live portal, so what it produces is unknown.
  Separately, the planner is unreliable on ComEd's list page.
- **One stored URL walks into the wrong jurisdiction.**
  `co-franklin-oh.smartgovcommunity.com` bounces to the City of Columbus Accela portal — a
  different agency — which is why its seven-page walk ends on a Columbus login page. The
  wrong URL came from an operator workbook and is an operator fix.
- **Several platforms have never been past login at all.** OpenGov (4 measured hosts, all
  credential-refused, 4 more on the stale list), Tyler EnerGov / CSS Self Service (5 hosts:
  3 refused, 2 stopped at MFA/CAPTCHA), Citizenserve (refused), BS&A Online (MFA/CAPTCHA),
  DC Access / PermitWizard (login form not recognised), eTRAKiT (host did not respond). We
  have no evidence about how these behave inside the application.
- **Single-page-application portals score as failures even when they behave correctly.**
  `permiteyes.us` is one page with 176 fields and one Submit; the safety guards make the
  walk fill everything it can (60 fills on the measured run) and stop without filing. The
  run scored it one rung below review, for the stated reason "recorded 60 field fill(s)
  across 3 page(s) but never reached review" — a single-page form has no "next" to reach a
  review screen through. (The application itself is one page carrying 176 fillable fields;
  the page count includes the login step and a trailing blank page.) This is a measurement flaw on our side, not a portal problem. Worth knowing: two paths on that portal nearly filed a live application
  before those guards landed. Both are now guarded and kill-tested together, the account
  was audited read-only, and the operator confirmed directly that nothing was filed.
- **7 portals stop at MFA/CAPTCHA and 3 at a WAF bot block. These are design, not gaps.**
  A human clears the challenge. Ameren's own Step 7 additionally requires MFA and an
  automated pre-review before payment, so a human closes out the last step there too.
- **The fleet number is a single-attempt snapshot and is sensitive to the machine it ran
  on.** Only Ameren has a repeat-measured number. A run on a machine low on disk once
  produced eleven consecutive false "unreachable" verdicts in eight seconds, and a deep
  walk can be truncated by the per-portal time budget. Mitigations exist but do not remove
  this. Any per-portal claim needs `--repeat N` to become a rate.

## Read this before you sign

Eight things you would not otherwise find on this page, each of which changes the decision
for at least some companies. All verified against the same build and date as everything
above.

### 1. This service has never onboarded a real company

There is no first customer yet. Every number on this page comes from the operator's own
portal accounts driven against a synthetic benchmark fixture. Nothing has been measured
against a live customer's jurisdictions, credentials, or filings. **The first customer is
also the first execution of the onboarding process itself** — the intake, the credential
import, the readiness report, the inheritance check. Those steps exist as scripts and have
never been run for a company that was paying for the outcome. Price and plan accordingly.

### 2. Learn and benchmark runs create real draft applications in your live portal accounts

This is not a sandbox. When the engine learns a portal, it logs into **your** account and
walks a real application forward, which means the portal creates a **real draft record**
under your account. One Miami walk produced intake number `BD26-021147-001`. These drafts
are never submitted — automation never clicks final submit — but **nothing in this system
deletes or cancels them.** They accumulate under the account whose credentials we hold, and
a person has to go and cancel them.

The replay self-test compounds this: when it is enabled it re-runs the live portal to prove
the recipe reproduces, and that pass **can create a second draft per run**. It was enabled
for all three of the pinned Ameren runs above (`PORTAL_REPLAY_SELFTEST=1`).

So plan for it: your portal accounts will collect abandoned drafts during onboarding, and
clearing them is manual work by someone with access to the account. We have not surveyed how
each agency treats an account that accumulates abandoned drafts, so we are not going to tell
you it is harmless. Agree up front who cleans them up and how often.

### 3. What is shared, and with whom

Pooled knowledge is the product's core asset and it is shared **on purpose**. Stated in your
terms rather than ours: the portal recipes, portal quirks, AHJ and utility profiles,
required-document lists, adopted code cycles, AHJ form field maps and equipment-name
normalisation that we derive **from your jurisdictions, driving your accounts, on your
filings** go into shared tables (`portal_recipes`, `permit_utility_knowledge`,
`jurisdiction_code_profiles`, `ahj_form_templates`, `cec_equipment`) and become available to
**every other customer of this service, including your direct competitors** — including a
competitor who signs after you and inherits, on day one, the jurisdictions you paid us to
figure out.

**Exactly one table is kept private to you: `historical_failure_examples`**, which carries
homeowner names and addresses. Everything else in the list above is pooled.

Your own project data, customer records, documents and credentials are not pooled — those are
scoped to you. What is pooled is the *procedural* knowledge: how a given portal behaves, what
a given AHJ requires, which field maps to which box. Some installers treat exactly that as
proprietary and a real competitive edge. If you are one of them, this is a term to negotiate
**before** you sign, not a surprise to discover after your first filing has already taught
the shared tables something.

### 4. Live portal session state is stored unencrypted on disk

Portal *passwords* are AES-256-GCM encrypted (see "What we do not do"). Portal *sessions* are
not. To avoid re-triggering MFA on every run, the automation keeps a full Chrome profile per
client and portal on the machine's filesystem at
`portal-profiles/<clientId>/<portalType>/`. Those directories hold live cookies and session
tokens in Chrome's own on-disk format, **not encrypted by us**, and a valid session cookie is
functionally a login. Anyone with filesystem access to that host, or to an unencrypted backup
of it, can resume your portal sessions. Protecting them is host security — disk encryption,
access control, backup handling — not application security, and this page is not claiming
otherwise.

### 5. Credential rotation is silent

Nothing detects that a portal password has changed. There is no proactive credential health
check, no expiry warning, and no notification. A rotated or revoked credential stays in the
database looking fine, and the failure surfaces only when a run tries to use it — that is, at
the moment a filing was supposed to happen. Twelve of the 68 credentialed hosts are stale
right now. If your company rotates portal passwords on a schedule,
or if staff turnover changes portal logins, **you must tell us each time**; we will not find
out on our own until something fails.

### 6. There is no throughput guarantee, and two jobs on one portal account corrupt each other

Nothing on this page is a capacity claim. We have never measured filings per hour, per day,
or per week, and we are not going to invent one.

Worse than unmeasured: **concurrency on a single portal account is actively unsafe today.**
PowerClerk allows one session per account, and the collision described above shows what that
costs: two runs against the same account from two processes evicted each other
mid-application, and the run that got evicted did not know it — it reported a portal failure.
That is not theoretical, it is what produced the **false 67% reliability reading** on Ameren
that this page supersedes above. We have not surveyed how many other portals enforce one
session per account, so treat the hazard as present until a given portal is shown otherwise.
The clean
3/3 came from re-running with nothing else touching PowerClerk. There is still **no
cross-process lease** preventing an overlap, so avoiding it is currently an operational
discipline, not an enforced guarantee.

### 7. A recipe existing is not readiness

`portal_recipes` currently holds **76 rows: 6 `complete`, 15 `recording`, 55
`needs_rerecord`.** Only the `complete` ones represent a walk that finished. `recording` is a
capture still in progress. `needs_rerecord` is set when auto-learn could not complete, did not
stage cleanly, or failed a replay step — it means the stored recipe is known not to be
replayable as-is and the next attempt has to re-learn the portal from scratch. So if you are
told "we have a recipe for your portal", ask which of the three it is.
Across the whole knowledge base, six recipes are complete and exactly one portal has ever
been repeat-measured to a review screen.

### 8. You do not get your own login to this software

Today this is run **for** you, not **by** you. The operator's team holds the accounts, runs
the filings and hands you the staged application to verify and submit; there is no
self-service tenant login, no customer-facing password reset, and no customer admin account
for your company inside this system. If what you are buying is a portal you log into and
operate yourself, that is not what exists today, and you should not sign expecting it.
Everything on this page describes the service-bureau arrangement.

One consequence worth stating plainly, because it constrains scheduling: the person who
verifies and submits has to be at the machine running the browser, or on a supervised remote
session to it. A staged or paused filing cannot be finished from somewhere else.

## What we do not do

- **We do not solve CAPTCHA, and we do not complete MFA.** Not with a solving service, not
  by any workaround. The run pauses, tells you a challenge is waiting, and a human clears
  it in the open browser.
- **We do not bypass portal terms or defeat bot protection.** We log in as you, with
  credentials you supply, to portals you are entitled to use. Where a portal blocks
  automation at a WAF, the answer is that the portal becomes a manual filing — not that we
  route around the block. Operators can pause automation for a jurisdiction or an entire
  platform with a kill switch, and while paused every run hands off to a human instead of
  opening a browser.
- **We do not file anything without human review.** The reviewer gate precedes staging, and
  the portal's final submit is executed by a person. Past the review screen the automation
  works from an allowlist: only a step a human explicitly marked as the final submit is even
  clickable, and anything that looks like a fee payment is refused before that check is
  reached. A payment dialog aborts the run.
- **We do not pay fees.** Ever, under any configuration flag.
- **We do not store secrets in plaintext.** Portal passwords and security answers exist only
  inside AES-256-GCM encrypted envelopes. The API never returns a password — a credential
  reports only whether a secret is set. Passwords, account and meter numbers, and similar
  identifiers are stripped before anything reaches an LLM, and sensitive fields are bound by
  name rather than by value. Operational notes stored alongside a credential are visible to
  the system and are not a place for secrets.

## What to expect in your first two weeks

Activities, not promised portal counts — because how fast your portals come online depends
on which platforms they run and whether your credentials work, and we will not invent a
number for that.

1. **Days 1-2 — accounts and credentials.** You register or confirm your own portal accounts
   on each AHJ and utility site (this is yours to do; many portals email a one-time code and
   automation is not permitted to complete that). We load your company licence and business
   details, and import your portal credentials encrypted. Your contractor licence number is
   required — staging refuses to run without it.
2. **Days 2-3 — inheritance check.** We report, per jurisdiction you filed in, whether it is
   already covered by pooled knowledge (a recipe or a confirmed portal profile exists) or is
   a first encounter. For covered AHJs, existing recipes apply on day one. This report is
   the honest scope of what is ready versus what needs work, and it is where you should
   expect the surprises.
3. **Days 3-8 — first learn attempts on your portals.** We drive your actual portals with
   your credentials against a real project. Expect refused credentials to surface here: every
   sweep prints them, and each is a credential to fix rather than a bug to file. Expect
   MFA/CAPTCHA portals to be identified as permanently human-assisted. Expect at least one
   AHJ to need you to confirm its correct permit type once.
4. **Days 8-12 — first real filings, fully supervised.** Filings are staged to the portal's
   review screen and a human on your side verifies and submits every one. Do not plan on
   unattended filing in the first two weeks; the final submit is a person's job by design,
   and for a new jurisdiction a person should also confirm the portal URL was real before
   trusting that a stage happened.
5. **Days 12-14 — what is actually working, measured.** We re-run the portals that matter to
   you with repeats, so any claim about your fleet is a rate rather than a single run, and
   hand you the same rung breakdown shown above for your own portals. New platforms
   discovered in your set are scoped as engineering work with the two-day-per-new-platform
   figure above as the realistic unit, not promised inside the two weeks.

A note on where the human sits: the person who verifies and submits must be at the machine
running the browser, or on a supervised remote session to it. A staged or paused filing
cannot be completed from elsewhere.
