# Demo Runbook — live presenting Solar Submission Autopilot

A demo you can open in front of a prospect without showing them another installer's
customers, and without depending on a government server being up.

**The rule that shapes this whole document:** the reliable demo touches no external
network. Everything in Act 1–3 runs against the local DB and local documents. The live
portal replay is a bonus act with a video fallback, never the backbone.

Verified end-to-end on 2026-09-23 against `backend/data/autopilot.sqlite`.

---

## What you are showing

Four synthetic projects for a fake company, **Solaris Demo Co**, at invented addresses
(every ZIP is `99999`). They were built through the product's real creation paths and
advanced by the real chain — no status was parked, no artifact was faked. The gates judged
them exactly as they judge a live project.

| Homeowner | AHJ | Utility | Status | QC |
|---|---|---|---|---|
| Terrence Boyd | City of Coos Bay | Pacific Power | ready_to_stage | 23 pass / 3 warn — the clean one |
| Marisol Vega | City of Salem | PGE | ready_to_stage | 22 pass / 5 warn |
| Priya Raman | City of Portland | PGE | ready_to_stage | 22 pass / 5 warn |
| Gus Halvorsen | City of Tigard | PGE | ready_to_stage | 22 pass / 4 warn — **one is an `error`: PE-stamped structural** |

Each carries **8 documents**: the uploaded `plan_set`, six sheets split and classified out
of it (`sld`, `site_plan`, `structural`, `module_spec`, `inverter_spec`, `labels`), and an
assembled `utility_package_zip`. **No filled permit application** — see Act 3.

The board reads uniformly green. **The story is not in the status column — it is in the QC
warnings**, and they differ per jurisdiction because the product knows each jurisdiction's
requirement list. That is the point to make out loud.

---

## Pre-flight (do this the day before, not five minutes before)

```bash
# 1. Demo data exists and is where you expect
npx tsx scripts/demo-environment.ts --status
#    -> Demo company: Solaris Demo Co (<a client id>)
#    -> 4 projects, all ready_to_stage

# 2. Server boots clean
npm run dev
#    -> banner in ~10s, "Dashboard http://localhost:4173/"
```

Read the startup banner. Today it prints two warnings you should know about before someone
in the room reads them over your shoulder:

- `30 background job(s) are in 'failed' state` — historical, unrelated to the demo path.
- `3 client message(s) were never delivered` — real client names appear in that line.

Neither is visible from the filtered board, but both are visible in the terminal. **Present
from the browser, not from a window where the terminal is visible.**

If the demo data is missing or stale, rebuild it (10–15 min, needs the LLM key):

```bash
npx tsx scripts/demo-environment.ts --reset
npx tsx scripts/demo-environment.ts
# then the finishing pass below — the script cannot do it in-process
```

### The finishing pass (required after any re-seed)

Form acquisition runs in the job worker, so it only happens with the server up. With
`npm run dev` running:

**Derive the project IDs — never paste them.** A re-seed mints new IDs, and a re-seed is
the only time you need this pass. Stale IDs 404, `curl` swallows it, and you wait for a
drain that never starts.

```bash
BASE=http://localhost:4173

CLIENT=$(curl -s "$BASE/api/clients" \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).clients.find(c=>/Solaris Demo/i.test(c.companyName||'')).id")
echo "demo client: $CLIENT"   # must not be empty or 'undefined'

IDS=$(curl -s "$BASE/api/projects?clientId=$CLIENT&limit=50" \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).projects.map(p=>p.id).join(' ')")
echo "$IDS" | wc -w          # must print 4

for id in $IDS; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/projects/$id/qc" \
         -H 'Content-Type: application/json' -d '{}')
  echo "$id -> $code"        # must be 200, not 404
done
```

This drops all four back to `qc_passed` and enqueues `stage_step` jobs. **Wait for the queue
to drain (~20s)** — they return to `ready_to_stage` on their own. Do not present mid-drain.

```bash
curl -s "http://localhost:4173/api/jobs?limit=300" | grep -o '"status":"running"' | wc -l
# wait until 0
```

Job statuses are `pending` / `running` / `done` / `failed` — **not** `queued`. Grepping for
`queued` returns zero on a busy queue and will tell you the demo is ready when it is not.

---

## Setup, immediately before presenting

1. `npm run dev` — wait for the banner.
2. Open http://localhost:4173/
3. **Set the board's Client filter to "Solaris Demo Co" before you share your screen.**
   This is the single step that keeps real customers off the display. The filter is
   server-side (`/api/projects?clientId=...`), so real projects are not merely hidden in the
   DOM — they are never sent to the browser.
4. Share the browser window only. Not the desktop, not the terminal.

> **The client filter scopes the project board only.** Other tabs — customers,
> communications, KB, ops — are not client-filtered and will show real installer data.
> Rehearse the exact tabs you intend to open, and stay on them.

---

## The walkthrough

### Act 1 — the board (2 min)

Four jobs, four different jurisdictions, each mid-flight. Point at the stage label
(*Build & Validate, 1 of 5*) and the fact that nothing here was typed by a person: a plan
set went in, and the product derived the AHJ, the utility, the equipment and the documents.

### Act 2 — the gate refusing to proceed (4 min — this is the demo)

Open **Gus Halvorsen (Tigard)**. Go to the QC results.

> "PE-stamped structural plans + sealed structural letter/calcs is not attached for City of
> Tigard. Non-prescriptive path."

That is severity `error`, and it is the whole product in one line. The system knows Tigard
puts this job on the engineered path, knows that path requires a stamped structural
package, has checked whether one is attached, and is refusing to call the job ready.

Now open **Priya Raman (Portland)** and **Marisol Vega (Salem)** side by side. Different
jurisdictions, different missing-document lists, named specifically:

- Portland: *site/plot plan, fire access path, roof framing/roof plan, roof cross-section*
- Salem: *Prescriptive solar permit application* and *Electrical (renewable-energy) permit
  application* — by name, because Salem's requirements list names them

Then **Terrence Boyd (Coos Bay)** — 23 of 26 clean. The contrast is the argument: the gate
is not noisy, it is specific.

### Act 3 — the artifacts (3 min)

On any project, open the documents list. **Eight entries: one uploaded plan set, six sheets
the product split and classified out of it, and one assembled `utility_package_zip`.**

```
plan_set              <name>-plan-set.pdf              (the input)
site_plan             ... Site / plot plan.pdf          \
sld                   ... SLD / one-line.pdf             |
structural            ... Structural / roof framing.pdf  | derived by the splitter
module_spec           ... Module spec.pdf                |
inverter_spec         ... Inverter spec.pdf              |
labels                ... Labels / placards.pdf         /
utility_package_zip   ... all package.zip                (assembled for the utility)
```

The point: a single PDF went in, and the product recognised each sheet for what it is and
filed it under the document type the AHJ and the utility ask for by name. The zip is the
thing the installer would otherwise assemble by hand.

If you open one sheet, open the **SLD / one-line** — it carries a real load-side
interconnection calculation (200A bus × 120% = 240A allowable; 175A main + 40A PV = 215A,
complies) which is exactly what a plan reviewer checks first.

> **Do not promise a filled permit application.** The demo projects do not have one — form
> acquisition did not attach it, and Act 2's warnings say so out loud ("Permit application
> (filled) is not attached for City of Portland"). That absence is Act 2's story, not a bug
> to explain away in Act 3.
>
> Also know what these sheets look like: they are **text pages, not CAD drawings**, each
> footed `SOLARIS DEMO CO — DEMONSTRATION PLAN SET, NOT FOR CONSTRUCTION`. The content is
> genuine; the draughting is not. Show the documents *list* freely; open a sheet only if you
> are ready to say "this is a synthetic plan set — a real one is a drawing."

### Act 4 — the portal (optional, see below)

---

## Act 4: the portal replay — read this before you promise it

`npm run demo:replay -- <target>` opens a visible Chrome window and replays a recorded
recipe against a **real utility portal**, stopping at the review screen and never clicking
submit. It is the most impressive thing the product does.

**Do not run it live in front of a prospect.** Three independent reasons:

1. **It hits a live government/utility server.** Network, portal drift, bot-blocking, and
   credential lockout are all failure modes outside your control, and each one fails in
   front of the room.
2. **It binds real customer data.** The targets are hardcoded to `tml-international-llc`
   with real project IDs. You would be showing one installer another installer's customer —
   the exact thing the demo environment exists to prevent.
3. **Every run creates a real draft application** on that portal, which someone then has to
   clear.

### What to do instead

**Record it once, present the recording.** Run it yourself, off-camera, against a project
you are entitled to use, and capture the window. A 60-second clip of a browser filling 53
fields and halting at the review screen makes the point, and it makes it the same way every
time.

Say the safety property out loud while it plays: *the machine does the typing, a human
signs off — it cannot click submit.* That is a feature, not a limitation, and prospects who
have been burned by automation will care about it more than the speed.

### Why not the offline replica?

`data/portal-replicas/` holds 5 captured bundles (`pacific-power` 34 pages,
`city-of-coos-bay` 51, and three small ones), served by `npm run replica:serve`. It looks
like the perfect offline demo target and it is not — **yet**.

The bundles are static page captures keyed by route. `replica.dom.smoke.ts` uses them to
assert DOM facts (the record-type checkbox, the nested results grid, the hidden combobox),
which is exactly what they are good for. **Nothing drives a full recipe through one**, and a
53-step replay needs the replica to transition between pages in response to actions — it is
a snapshot, not a working app.

Making the replica stateful enough to carry a full recipe replay is the single highest-value
build item for this demo. It would turn Act 4 from a video into a live, offline, repeatable
finale with no customer data and no portal dependency. It is real work, not a config change.

---

## Teardown

```bash
npx tsx scripts/demo-environment.ts --reset   # removes every demo row, exactly
```

The demo data is safe to leave in place between demos — it is marked and isolated, and
`--reset` never touches a row it did not create. Re-seeding costs 10–15 minutes and an LLM
spend, so leave it unless something has drifted.

---

## Known gaps, in the order they would bite you

| Risk | Blast radius | Mitigation |
|---|---|---|
| Client filter not set before screen-share | Real customer names on screen | Set it first, every time. Verify before sharing. |
| Navigating off the board to an unfiltered tab | Real data in customers/comms/KB/ops | Rehearse the exact tab path; do not improvise. |
| Terminal visible | Failed-job + undelivered-message warnings name real clients | Share the browser window only. |
| Presenting mid-drain after a re-seed | Board reads `qc_passed`, story breaks | Wait for the job queue to hit zero. |
| Live portal replay | Fails in front of the room | Pre-recorded video. |
| `AUTH_ENABLED=false` | Server is open on all interfaces | Fine on localhost. Never demo from a shared network without auth on. |

---

## The dry run is part of the plan

This runbook is not finished until you have executed it start to finish, on the machine you
will present from, with the screen shared to a second device so you can see what the room
sees. Budget 20 minutes. The two things that break are always the same: the client filter
was not set, and the queue had not drained.
