# Demo Runbook — presenting Solar Submission Autopilot to a client

The demo is a **separate, self-contained installation** in `demo-kit/` — its own database,
documents, recordings and launchers. It shares nothing with production. You can hand the
folder to anyone or carry it on a thumbdrive: it contains no real customer, no credentials
and no API key, and it makes no outbound network request.

**One rule shapes the demo:** it touches no network and no real portal. The kit runs with
no API key, no SMTP, no portal credentials, workers off, and every outbound path switched
off in its `.env` (`PORTAL_AUTOMATION=off`, `DOCUMENT_FETCH=off`, `AHJ_FORM_DOWNLOADS=off`,
`AUTOPILOT_AUTO_START=0`, `CLIENT_NOTIFICATIONS=false`). Everything you show is either live
and local, or a recording.

| | Production | Demo kit |
|---|---|---|
| Where | repo root | `demo-kit/` (git-ignored) |
| Start | `npm run dev` | double-click `demo-kit/START-DEMO.cmd` |
| Reset | — | double-click `demo-kit/RESET-DEMO.cmd` |
| URL | http://localhost:4173 | http://localhost:4270 (recordings at `/demo/`) |
| Data | real installers, real homeowners | 8 synthetic projects, one fake company |
| Secrets | `.env` with live keys | none — a throwaway encryption key only |

Both can run at once; the ports never collide.

---

## Before every showing: reset

Double-click **`RESET-DEMO.cmd`** (close the demo's server window first if it is open). It
restores the database and every data folder to the snapshot taken when the kit was built,
then starts the demo. Everything a presenter did last time — confirmations captured,
statuses pasted, forms uploaded — is undone. It refuses to run while the server is up.
(`node kit-snapshot.mjs status` shows what the snapshot holds.)

---

## What the kit holds

Eight synthetic projects for **Solaris Demo Co**, every ZIP `99999`, every email
`@example.invalid`. They were created through the product's real intake paths and moved by
the product's real code — the later-stage ones staged through the built-in mock portal
adapter and filed with numbers that say `DEMO-…` and a submitter that says *simulated
filing, no portal contacted*.

| Column | Homeowner | AHJ / utility | What it shows |
|---|---|---|---|
| 2 · Build & Validate | Terrence Boyd | Coos Bay / Pacific Power | The clean one: QC 23/3, reviewer gate approved, fees from published schedules |
| 2 · Build & Validate | Priya Raman | Portland / PGE | QC 23/4, gate approved |
| 2 · Build & Validate | Marisol Vega | Salem / PGE | QC 22/5 — one advisory: Salem's building application is not on file |
| 2 · Build & Validate | **Gus Halvorsen** | Tigard / PGE | **The refusal**: QC 22/4 with an `error` — PE-stamped structural package required |
| 2 · Build & Validate | Idris Farah | Happy Valley / PGE | The form-upload beat: no AHJ forms on file yet |
| 3 · Submit | Lena Okafor | Portland / PGE | Staged to review (NEM + permit) — waiting for a person to file |
| 4 · Track Approvals | Walt Brennan | Salem / PGE | Filed; building permit ready to issue (fee due), NEM and electrical in review |
| 5 · Closeout | Rosa Delgado | Coos Bay / Pacific Power | All three filings issued/approved — handed off |

Every project carries 8 documents (plan set → six split sheets → utility package zip) and
its filled AHJ forms. Fee sheets read from real published schedules: NEM **$0.00** for PGE
and Pacific Power (OAR 860-039-0045 / PGE's FAQ); permits $84 Salem, $360 Coos Bay,
$808.41 Portland, $313.56 Tigard — each labelled *provisional — not verified*, because they
are research, not a human-checked receipt. That label is the product being honest.

In `demo-kit/sample-docs/` are the public **blank** forms the kit holds (Oregon BCD 5952 and
the Coos County / Tigard applications) plus a README — the documents for the form-fill beat.

---

## The walkthrough (about 20 minutes)

### Act 1 — the board (2 min)

One board, five stages, a project in every column. The row of pills at the top — *Your
submit*, *Staging failed*, *To fix*, *Corrections*, *Ready to stage*, *Waiting* — is the
answer to "what needs me today"; each card carries one chip saying what that project needs.
Nothing here was typed by a person: a plan set went in, and the product derived the AHJ,
the utility, the equipment, the documents and the next step.

### Act 2 — the gate refusing to proceed (4 min — this is the demo)

Open **Gus Halvorsen (Tigard)**. The Next-step banner at the top says who has to act and
why; the QC results say it plainly:

> **[error]** PE-stamped structural plans + sealed structural letter/calcs is not attached
> for City of Tigard.

The product knows Tigard puts this job on the engineered path, knows that path needs a
stamped structural package, checked for one, and refuses to call the job ready. Contrast
with **Terrence Boyd (Coos Bay)** — 23 clean, 3 advisory warnings. The gate is specific,
not noisy.

### Act 3 — documents in, applications out (5 min)

On Terrence Boyd, open the documents list: the uploaded plan set, six sheets the product
split and classified, and the assembled utility package. Then download the filled **Oregon
BCD 5952 — Prescriptive Solar PV Installation Checklist**: the State's real form, filled
from the project, offline, with no AI call — the binding is deterministic.

**Live beat — fill a form the product has never seen for this AHJ:**
1. Open **Fill a form** (`/fill-form`), pick **Idris Farah (City of Happy Valley)**.
2. Card **Upload a blank form** → choose `demo-kit/sample-docs/Oregon-BCD-5952-blank.pdf`
   → **Upload & fill**.
3. It reads *Form mapped (14 fields) — filling…* then *Done — form filled from the project*,
   and offers the filled PDF (22 fields). Recognised by its exact bytes: no internet, no AI.

Only upload that file. Anything else (a plan set, a bill, a form from the web) cannot be
mapped offline and the page will say so in amber — a dead end on stage.

> The plan-set sheets are **text pages, not CAD drawings**, footed `SOLARIS DEMO CO —
> DEMONSTRATION PLAN SET, NOT FOR CONSTRUCTION`. Their content is genuine (the SLD carries
> a real NEC 705.12(B)(3)(2) busbar calculation). Show the list freely; open a sheet with a
> sentence of framing. The filled state forms are real PDFs and present perfectly.

### Act 4 — through the stages (5 min)

- **Lena Okafor (Submit).** Staged up to the portal's review screen; the banner says a
  person must file it. Show that **Approve & Submit** refuses here — *portal automation is
  off on this installation* — and say why that is the point: nothing is filed without a
  person. Then play the filer: in **Submittal tracks**, record each filing (NEM, then the
  permit) with any application number. She moves to **Track Approvals**.
- **Walt Brennan (Track Approvals).** Each filing is tracked on its own: the building permit
  is *ready to issue* — the fee is a person's to pay — while NEM and electrical are in review.
  To close it out live, paste the portal's words against each filing (choose the filing,
  paste, **Classify status**): *"Permit issued. Download permit card from the portal."* on
  building and on electrical, *"Interconnection application approved - approved to
  install."* on NEM. After the last one he moves to **Closeout** on his own — the product
  hands a job off only when every required permit is issued and the interconnection is
  approved, never on a fee-due or one-of-two.
- **Rosa Delgado (Closeout).** Everything issued; the installer handoff note is written.

### Act 5 — the portal automation (recording, 1 min)

Open **http://localhost:4270/demo/** and play **The portal automation**: the product's real
replay engine filling an interconnection application field by field, and stopping at the
review screen. Say while it plays: *the machine does the typing, a human signs off — it
cannot click submit.* The portal is fictional ("Demo Utility Co", served from the laptop,
hazard banner on every page); the engine, the bindings and the stop-before-submit are the
product's real code. The same page has the **whole-process walkthrough** recording for a
room with no time.

Never run a live replay against a real portal in front of a client: it would hit a live
site, bind a real client's projects, and create a real draft application. That is exactly
what the kit exists to avoid.

### Recording a real portal run for the demo (optional, done beforehand, never live)

A prospect may want to see a real utility portal (PGE's PowerClerk), not "Demo Utility Co".
The same recorder can record a **real, unfiled** project's replay to the review screen with
every customer value **masked on screen at record time** — the name, address, phone, email,
account and meter numbers, the installer's login name and company, and the account's
application list are boxed in the rendering only; what the engine fills and what the portal
autosaves are untouched (`scripts/lib/piiMask.ts`; proven on the synthetic PowerClerk
replica by `scripts/demoMaskReplica.dom.smoke.ts`: 0 OCR hits masked over 150+ frames, the
unmasked control run shows them, and the portal's recorded state is byte-identical).

**Prerequisites — all of them, or the recorder refuses before it reads a database:**

- A real project that has **not been filed** and whose utility recipe is complete (learned)
  and trusted. The run creates a **draft** on the portal; you delete that draft afterwards.
- A **person present** at the keyboard for the whole run (`--i-am-present`): login and any
  MFA are yours to finish in the browser window; the recorder waits (`--login-wait`).
- `PORTAL_ALLOW_FINAL_SUBMIT` **unset** in the shell (not `0` — unset). The recorder never
  carries a run approval, so the engine cannot click submit; the recorder additionally
  aborts any browser POST whose URL reads as a filing or a payment and refuses the video.
- A **copy** of the production database (stop the server or take a backup copy first);
  the recorder copies it again and opens only its own copy. Run with the production `.env`
  loaded so the stored credential can be decrypted (`SESSION_ENCRYPTION_KEY`).
- `--headed`: you must see the browser. Masking is forced on (`--no-mask` is refused).

```bash
npx tsx scripts/demo-record-portal.ts --real-run --i-am-present --headed \
  --db backups/autopilot-copy.sqlite --project <project id> \
  --out demo-kit/frontend/demo/real-portal.webm --shots demo-kit/frontend/demo/real-shots \
  [--mask-selectors ".navbar-user,#accountMenu"]   # extra regions to box, if the header shows more
```

The video is kept only when the engine stopped at the review screen with the final submit
refused or skipped for want of a target, `finalSubmitClicked` false from every source, no
submit/pay POST, and nothing trapped on the Node side. The report prints the number of
masked values and every host the browser touched — never a value.

**Then a human reviews every frame** (`--shots` and the video, scrubbed slowly) before the
recording goes anywhere near a prospect: the masker boxes the values it knows and the
regions it is told about; a value the portal renders in a way it does not know (CSS
content, a canvas, an unlisted header block) is yours to catch, and `--mask-selectors` is
how you add the region and re-record. Delete the portal draft. Do not show the frames to
anyone before that review is done.

**Fallback:** the fictional recording above (Act 5) is the default and is always safe to
show. Use the real-portal recording only if it was made, reviewed and the draft cleaned up
before the day.

---

## What is safe to click

Everything a presenter is likely to press is safe, and RESET-DEMO undoes all of it.

| Action | What happens in the kit |
|---|---|
| Run QC | The chain re-runs locally (split check, documents, reviewer gate). A filed or closed project stays where it is. |
| Stage portals · Autopilot | Every gate gives its verdict, then it stops: *portal automation is off on this installation*. No browser opens. |
| Approve & Submit | Refused offline with a plain message. Nothing is recorded as filed. |
| Record a filing / paste a status | Real product behaviour — moves the project. Reset afterwards. |
| Fill a form (upload) | Stores the form for that AHJ. Reset afterwards. |
| Find & fill (lookup) | Answers that lookup is off (no API key) and lists the forms already stored. |

---

## Rebuilding the kit

The kit is a build artifact; `scripts/demo-kit/` holds its launchers, `.env` template and
recordings page. Rebuild from the repo root (the build needs the real `.env` only for the
first seeding step — the shipped kit never carries it):

```bash
# 1. Seed the four original projects into a fresh isolated DB (real creation paths)
AUTOPILOT_DB_PATH=demo-kit-data/demo.sqlite PROJECT_DOCS_DIR=demo-kit-data/project-documents \
  npx tsx scripts/demo-environment.ts --db demo-kit-data/demo.sqlite

# 2. Assemble demo-kit/: backend/src, frontend, shared, scripts, tools, portal-bot/src,
#    package.json, tsconfig.json, node_modules; backend/data/reference-*.json and ahj-forms/;
#    the seeded DB + documents into backend/data/. Launchers from scripts/demo-kit/
#    (START-DEMO.cmd, RESET-DEMO.cmd, kit-repair-paths.mjs, kit-snapshot.mjs);
#    .env from scripts/demo-kit/kit.env.template with a NEW SESSION_ENCRYPTION_KEY;
#    frontend/demo/index.html from scripts/demo-kit/demo-index.html.
#    Start the kit server once so migrations run, then stop it.

# 3. Shared knowledge from production — the ONLY rows ever copied (both tables are public,
#    shared-on-purpose data with no tenant columns):
npx tsx scripts/demo-copy-fee-schedules.ts --from backend/data/autopilot.sqlite --to demo-kit/backend/data/autopilot.sqlite
npx tsx scripts/demo-copy-form-templates.ts --from backend/data/autopilot.sqlite --to demo-kit/backend/data/autopilot.sqlite \
  --ids 96a92ac4-77c7-4f75-b42e-1474475e883c        # City of Coos Bay Building Permit Application

# 4. The later stages (from demo-kit/; offline env forced, asserts its own result):
cd demo-kit && npx tsx ../scripts/demo-later-stages.ts --db backend/data/autopilot.sqlite
#    Expect "OK: 4 project(s) created … nothing left the machine".

# 5. Start the kit, POST /api/projects/<id>/qc for the four originals, wait for the queue to
#    drain, POST /api/projects/<id>/filled-forms, then QC once more. Verify the table above
#    (QC 23/3, 23/4, 22/5, 22/4 + PE error; later stages in columns 3/4/5; 8 docs each).

# 6. Sample documents and recordings (from the repo root / demo-kit):
npx tsx scripts/demo-sample-docs.ts --kit demo-kit --out demo-kit/sample-docs --beat-project "Idris Farah (City of Happy Valley)"
cd demo-kit && npx tsx ../scripts/demo-record-portal.ts --out frontend/demo/act4-portal.webm
#    with the kit server running:
npx tsx scripts/demo-record-walkthrough.ts --url http://127.0.0.1:4270 --out demo-kit/frontend/demo/walkthrough.webm

# 7. Stop the server and freeze the starting state:
cd demo-kit && node kit-snapshot.mjs save
```

The recorders refuse to run against anything but a demo kit (only *Solaris Demo Co*, only
ZIP 99999) and refuse to keep a video if anything tried to leave the machine or the submit
button was pressed. Recording needs Playwright's Chromium on the build machine.

**Never** copy `.env`, `portal-profiles/`, `pge-session.json`, the portal replicas in
`data/portal-replicas/` (they contain real customers' data), or anything from the production
database beyond the two tables in step 3. The kit is an allowlist, not a filtered copy.

---

## Production stays production

- `demo-kit/` is git-ignored; it contains a database and must never be committed.
- No demo row lives in production. If you ever seed demo data there again (don't — use the
  kit), the board's company filter scopes only the board; customers, comms, KB and ops tabs
  are unfiltered.

---

## Known gaps

| Risk | Mitigation |
|---|---|
| Host lacks Node 22 | The launcher says so. Carry your laptop as the fallback. |
| Kit copied to a new drive | Handled — the launcher re-points document paths on every start. |
| Presenter clicks something that changes a project | RESET-DEMO before the next showing. |
| The kit's source files carry comments that mention real past jobs | Only visible to someone reading the code on the thumbdrive. Strip before handing the folder to a third party. |

## The dry run is part of the plan

Before the first real showing: copy `demo-kit/` to the thumbdrive, plug it into a machine that
is not yours, run `RESET-DEMO.cmd`, and click through all five acts. Budget 20 minutes.
