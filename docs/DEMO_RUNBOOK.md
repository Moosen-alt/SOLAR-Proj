# Demo Runbook — live presenting Solar Submission Autopilot

The demo is a **separate, self-contained installation** in `demo-kit/` — its own
database, its own documents, its own launcher. Production and the demo no longer share
anything. You can hand the `demo-kit` folder to anyone, or carry it on a thumbdrive,
and there is no way to show a real customer from it, because it does not contain one.

**The rule that shapes this document:** the reliable demo touches no external network.
The kit runs with no API key, no SMTP, no portal credentials, and no background
workers — it cannot reach anything, and nothing it demonstrates needs it to. The live
portal replay is a bonus act with a video fallback, never the backbone.

Verified end-to-end on 2026-09-23.

| | Production | Demo kit |
|---|---|---|
| Where | repo root | `demo-kit/` (git-ignored) |
| Start | `npm run dev` | double-click `demo-kit/START-DEMO.cmd` |
| URL | http://localhost:4173 | http://localhost:4270 |
| Data | real installers, real homeowners | 4 synthetic projects, one fake company |
| Secrets | `.env` with live keys | none — fresh throwaway encryption key only |
| Network | LLM, SMTP, portals, schedulers | nothing outbound, binds 127.0.0.1 only |

Both can run at the same time; the ports never collide.

---

## What the kit shows

Four synthetic projects for **Solaris Demo Co** at invented addresses (every ZIP is
`99999`), created through the product's real intake paths and advanced by the real
chain — no status parked, no artifact faked.

| Homeowner | AHJ | Utility | QC after the gates ran |
|---|---|---|---|
| Terrence Boyd | City of Coos Bay | Pacific Power | 23 pass / 3 warn — the clean one |
| Priya Raman | City of Portland | PGE | 23 pass / 4 warn |
| Marisol Vega | City of Salem | PGE | 22 pass / 4 warn |
| Gus Halvorsen | City of Tigard | PGE | 22 pass / 4 warn — **one is an `error`: PE-stamped structural** |

Each has 8 documents (uploaded plan set → six split sheets → assembled utility
package zip) **plus filled AHJ forms on disk** — the prescriptive application,
electrical application, and NEM package the job worker produced when the set was
built.

The board reads uniformly `ready_to_stage`. **The story is in the QC results**, and
they differ per jurisdiction because the product knows each jurisdiction's
requirement list. Say that out loud — it is the product's whole argument.

---

## Running it

1. Double-click `demo-kit/START-DEMO.cmd`. It checks Node, re-points the document
   paths at wherever the folder now lives (this is what makes it thumbdrive-safe),
   starts the server, and opens the browser.
2. Present. Everything on screen is synthetic; there is no filter to remember and no
   tab that can betray you.
3. Close the terminal window when done.

The host machine needs **Node 22** installed — nothing else. The kit is ~225 MB
(204 MB of that is `node_modules`), so it fits any thumbdrive. `better-sqlite3`'s
compiled binary is pinned to Node 22 and **Windows**; the launcher warns on a version
mismatch, and the kit will not run on macOS/Linux without reinstalling node_modules
there.

If the room has no Node and no time: run it on your laptop and share the browser
window. The kit binds `127.0.0.1` only, deliberately — it will not serve the
conference wifi.

---

## The walkthrough

### Act 1 — the board (2 min)

Four jobs, four jurisdictions, all mid-flight at *Build & Validate*. Nothing here was
typed by a person: a plan set went in, and the product derived the AHJ, the utility,
the equipment, and the documents.

### Act 2 — the gate refusing to proceed (4 min — this is the demo)

Open **Gus Halvorsen (Tigard)** → QC results:

> "**[error]** PE-stamped structural plans + sealed structural letter/calcs is not
> attached for City of Tigard."

The system knows Tigard puts this job on the engineered path, knows that path
requires a stamped structural package, checked for one, and is refusing to call the
job ready. That is the product in one line.

Contrast with **Terrence Boyd (Coos Bay)** — 23 of 26 clean, three advisory
warnings. The gate is not noisy; it is specific. **Marisol Vega (Salem)** sits in
between: her remaining application warning says *"entered in the portal at staging"*
— the gate knows that document is satisfied by portal entry, not by an attachment.

### Act 3 — the artifacts (4 min)

On any project, open the documents list: one uploaded plan set, six sheets the
product split and classified out of it, one assembled `utility_package_zip` — the
thing an installer otherwise assembles by hand.

Then the finale of this act: the **filled AHJ form**. Trigger the form-fill panel
and download **"Oregon BCD 5952 — Prescriptive Solar PV Installation Checklist"**
on the Coos Bay project. That is the State of Oregon's actual form, fetched blank
and filled with 20 fields from the project — and in this kit it happens **offline,
with no LLM**, because the binding is deterministic. The output is not a report
about the work; it is the work.

> Know what the plan-set sheets look like before you open one: they are **text
> pages, not CAD drawings**, footed `SOLARIS DEMO CO — DEMONSTRATION PLAN SET, NOT
> FOR CONSTRUCTION`. The content is genuine (the SLD carries a real NEC
> 705.12(B)(3)(2) busbar calculation: 200A × 120% = 240A ≥ 175A + 40A = 215A —
> complies). Show the documents *list* freely; open a sheet only with a sentence of
> framing. The **filled BCD 5952 is the exception — it is the state's real PDF and
> presents perfectly.**

### Act 4 — the portal (optional): pre-recorded video only

`npm run demo:replay -- <target>` (from the production repo, not the kit) opens a
visible Chrome window and replays a learned recipe against a **real utility
portal**, stopping at the review screen — it cannot click submit. It is the most
impressive thing the product does, and you must not run it live:

1. It hits a live portal — network, drift, bot-blocking, lockout all fail in front
   of the room.
2. Its targets bind **a real client's projects** — the exact exposure the kit exists
   to prevent.
3. Every run creates a real draft application someone has to clear.

Record it once off-camera, present the clip, and say the safety property out loud
while it plays: *the machine does the typing, a human signs off — it cannot click
submit.* Prospects burned by automation care about that more than the speed.

(The offline portal replicas in `data/portal-replicas/` cannot replace this yet —
they are static page captures used by the DOM smoke tests, and nothing can drive a
full recipe through one. Making them stateful is the single highest-value build item
for this demo.)

---

## Rebuilding the kit

The kit is a build artifact. If it drifts or you want fresh data, rebuild from the
production repo (needs the real `.env` for the LLM during the build only —
the *shipped* kit never carries it):

```bash
# 1. Seed a fresh isolated DB + documents (uses the same creation paths as production)
mkdir -p demo-kit-data
AUTOPILOT_DB_PATH=demo-kit-data/demo.sqlite \
PROJECT_DOCS_DIR=demo-kit-data/project-documents \
  npx tsx scripts/demo-environment.ts

# 2. Assemble the kit folder: copy source (backend/src, frontend, shared, scripts,
#    tools, portal-bot/src, package.json, tsconfig), the reference data
#    (backend/data/reference-*.json, backend/data/ahj-forms), node_modules, and the
#    seeded DB + documents into demo-kit/backend/data/. Write the powerless .env
#    (see the one in demo-kit/ — copy it, generate a NEW SESSION_ENCRYPTION_KEY).

# 3. Repair paths, then the finishing pass with workers ON (build mode only):
cd demo-kit && node kit-repair-paths.mjs
BACKGROUND_WORKERS=on npx tsx backend/src/server.ts   # + real ANTHROPIC_API_KEY in env
# then for each project id (derive them, never paste):
#   POST /api/projects/<id>/qc   → wait for the job queue to drain
#   (job statuses are pending/running/done/failed — 'queued' is not a status)

# 4. A re-run of QC re-splits the plan set and duplicates document rows — dedupe
#    keeps newest per (project, type, filename). Then verify: 4 projects, 8 docs
#    each, Tigard shows the PE-stamp error, Coos Bay ~23/3.
```

Ship it only after the acceptance check passes and the server has been relaunched
via `START-DEMO.cmd` (workers off, no key) with the same QC results.

**Never** copy `.env`, `portal-profiles/`, `.portal-profiles/`, `pge-session.json`,
or anything under `backend/data/` beyond the two `reference-*.json` files and
`ahj-forms/` into a kit. The kit is an allowlist, not a filtered copy.

---

## Production stays production

- The demo rows were removed from the production DB (`--reset`) **and** their
  on-disk document/filled dirs were deleted — `--reset` alone leaves the files.
- `demo-kit/` is git-ignored. It contains a database; it must never be committed.
- If you ever seed demo data into production again (don't — use the kit), remember
  the board's Client filter only scopes the project board; customers, comms, KB and
  ops tabs are unfiltered.

---

## Known gaps

| Risk | Mitigation |
|---|---|
| Host machine lacks Node 22 | Launcher detects and says so. Carry your laptop as the fallback. |
| Kit copied to a new path/drive | Handled — the launcher repairs document paths on every start. |
| QC re-run mid-demo duplicates document rows | Workers are off in the kit; the splitter cannot re-run. Don't demo in build mode. |
| Live portal replay | Pre-recorded video, always. |
| Kit committed to git | `.gitignore` covers `demo-kit/`; keep it that way. |

---

## The dry run is part of the plan

Before the first real showing: copy `demo-kit/` onto the actual thumbdrive, plug it
into a machine that is not yours, double-click `START-DEMO.cmd`, and click through
all four acts. Budget 15 minutes. The things that break are the ones a rehearsal on
your own machine cannot catch: Node missing on the host, and paths that only repair
correctly because the launcher ran.
