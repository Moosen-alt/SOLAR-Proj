// ---------------------------------------------------------------------------
// A DEMO YOU CAN OPEN IN FRONT OF ANYONE.
//
// The product demos itself well — the board, the reviewer gate, the staged portal run that
// stops dead at the review screen. What you could not do was show it to a PROSPECT, because
// the board lists a real installer's real customers by name and street address. Showing one
// installer another installer's customer list is how you lose the room.
//
// So this builds a parallel world: one demo company, synthetic homeowners at addresses that
// do not exist, sitting at the stages that tell the story. It uses the SAME creation paths
// the product uses (createClient / createProject / saveProjectDocument), so a demo project
// behaves exactly like a real one — the gates judge it, the chain moves it, nothing is
// special-cased. A demo that lies about the product is worse than no demo.
//
// SAFETY, because this writes to the live database:
//   · Everything it creates is named with a fixed marker (DEMO_MARKER) and can be removed
//     with --reset: every project of the demo company (demo-later-stages.ts's included), their
//     child rows, the company's own rows, and the company — in ONE transaction, so a failure
//     removes nothing. It keys on the company, so it never touches another client's row.
//   · Synthetic homeowners only. The addresses are deliberately invalid (999xx) so nobody
//     can mistake one for a real filing, and no demo project is ever staged to a portal.
//   · It refuses to run against a database that has no real data ONLY in the sense that it
//     does not care — it adds, it does not migrate, and --reset is exact.
//
//   · Its projects are created learning_excluded: a demo homeowner teaches the SHARED
//     knowledge base nothing (no profile facts, fingerprints, failure patterns or timeline
//     samples). --reset rebuilds the shared rollup of every profile the demo touched.
//   · There is NO default database. It used to fall back to backend/data/autopilot.sqlite —
//     production — so a bare run wrote demo projects into the live book. --db is required.
//
//   npx tsx scripts/demo-environment.ts --db <path>            # create (idempotent)
//   npx tsx scripts/demo-environment.ts --db <path> --reset    # remove every demo row
//   npx tsx scripts/demo-environment.ts --db <path> --status   # what exists right now
// ---------------------------------------------------------------------------
import "dotenv/config";
import nodePath from "node:path";
{
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--db");
  const dbArg = at >= 0 ? argv[at + 1] : "";
  if (!dbArg || dbArg.startsWith("--")) {
    console.error("\n[demo-environment] REFUSED: pass --db <path to the database>. There is no default: this script writes, and must never land on production by accident.");
    process.exit(1);
  }
  // Explicit beats inherited: an AUTOPILOT_DB_PATH exported by the shell or .env must not win.
  process.env.AUTOPILOT_DB_PATH = nodePath.resolve(dbArg);
}
// "No demo project is ever staged to a portal" is enforced here, not hoped for. createProject
// auto-enqueues an autopilot run, and once the demo plan set cleared the reviewer gate nothing
// else stood between that run and a live portal. Forced, not defaulted: an operator's .env
// must not be able to turn either back on for a seeding run.
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOMATION = "off";

const RESET = process.argv.includes("--reset");
const STATUS = process.argv.includes("--status");

/** Every row this script creates carries this marker, so --reset is exact. */
const DEMO_MARKER = "Solaris Demo Co";
const DEMO_COMPANY = {
  companyName: DEMO_MARKER,
  legalBusinessName: "Solaris Demo Co LLC",
  ccbLicenseNumber: "000000",
  contactName: "Dana Reyes",
  contactEmail: "demo@example.invalid",
  phone: "(555) 010-0000",
  businessAddress: "1 Demonstration Way",
  businessCity: "Portland",
  businessState: "OR",
  businessZip: "97201",
  electricalSupervisorName: "Alex Kim",
  electricianLicenseNumber: "0000S",
};

// The story the board tells, left to right. Each project sits at a stage that shows a
// different part of the product, and every homeowner is invented.
// THE DEMO MUST SHOW A PIPELINE THAT FLOWS, NOT ONE DROWNING IN QUESTIONS.
//
// First run of this script produced four projects carrying 56 pending review items between
// them, because a sparse fixture makes QC ask for every field it needs — which is QC working
// correctly and a demo failing completely: the product would look like it interrogates you
// about fourteen things per project. These are the exact fields QC requires, so three of the
// four projects are COMPLETE and sail through, and the fourth is short on purpose.
// THE PAYLOAD KEYS ARE NOT THE CHECK NAMES. QC resolves each check through
// normalize.fieldAliases, so the account number lives under `account`/`ubAccountNumber`,
// the inverter under `invModel`/`pvMicroModel`, locates under `locateCalloutText`, and so
// on. Writing the human-readable check name into the snapshot looks right, satisfies
// nothing, and produced a demo board with seven standing questions per project even after
// a real QC re-run. Keys below are the aliases QC actually reads.
const ELECTRICAL_COMPLETE = {
  meter: "DEMO-MTR-0001",
  moduleMake: "Q CELLS",
  moduleModel: "Q.TRON BLK M-G2.C1+",
  moduleWattage: "430",
  invModel: "IQ8PLUS-72-2-US",
  invOutputW: "290",
  interco: "Load-side breaker at the main panel",
  busRating: "200",
  mainBreaker: "175",
  pvBreaker: "40",
  locateCalloutText: "N/A - roof mount, no excavation",
};

const DEMO_PROJECTS: Array<{
  owner: string; street: string; city: string; state: string; ahj: string; utility: string;
  dcKw: string; acKw: string; status?: string; note: string;
  snapshot?: Record<string, unknown>;
}> = [
  {
    owner: "Marisol Vega", street: "412 Lantern Way", city: "Salem", state: "OR",
    ahj: "City of Salem", utility: "Portland General Electric", dcKw: "7.31", acKw: "4.93",
    note: "Just parsed — shows intake and the automatic chain picking it up.",
    snapshot: {
      mounting: "Roof mount", framingType: "truss", roofRafterSpacing: "24", roofMaterial: "Composition Shingle",
      snow: "36", wind: "C", windSpeed: "95", deadLoad: "2.6", jobValue: "31500",
      ...ELECTRICAL_COMPLETE, account: "DEMO-000-0001", moduleQty: "17", invQty: "17", permitPath: "prescriptive",
    },
  },
  {
    owner: "Terrence Boyd", street: "88 Kestrel Loop", city: "Coos Bay", state: "OR",
    ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "9.46", acKw: "6.38",
    status: "qc_passed",
    note: "Through QC — shows the built AHJ/NEM document package.",
    snapshot: {
      mounting: "Roof mount", framingType: "rafter", roofRafterSpacing: "24", roofRafterSpan: "11",
      roofMaterial: "Composition Shingle", snow: "16", wind: "C", windSpeed: "110", deadLoad: "2.8",
      jobValue: "38200", account: "DEMO-000-1234", ...ELECTRICAL_COMPLETE, moduleQty: "22", invQty: "22", permitPath: "prescriptive",
    },
  },
  {
    owner: "Priya Raman", street: "2170 Alder Bend", city: "Portland", state: "OR",
    ahj: "City of Portland", utility: "Portland General Electric", dcKw: "6.45", acKw: "4.35",
    status: "ready_to_stage",
    note: "Ready to stage — shows the reviewer gate green and the submit gate armed.",
    snapshot: {
      mounting: "Roof mount", framingType: "truss", roofRafterSpacing: "24", roofMaterial: "Composition Shingle",
      snow: "25", wind: "B", windSpeed: "100", deadLoad: "2.4", jobValue: "26400",
      account: "DEMO-000-5678", ...ELECTRICAL_COMPLETE, moduleQty: "15", invQty: "15", permitPath: "prescriptive",
    },
  },
  {
    owner: "Gus Halvorsen", street: "57 Ember Court", city: "Tigard", state: "OR",
    ahj: "City of Tigard", utility: "Portland General Electric", dcKw: "12.04", acKw: "8.12",
    status: "ready_to_stage",
    note: "A deliberately UNRESOLVED one — engineered path, so the gate asks for stamped plans.",
    snapshot: {
      mounting: "Roof mount", permitPath: "engineered", framingType: "rafter", roofRafterSpacing: "24",
      roofMaterial: "Composition Shingle", snow: "25", wind: "B", windSpeed: "100", deadLoad: "3.1",
      jobValue: "46900", account: "DEMO-000-9012", ...ELECTRICAL_COMPLETE, moduleQty: "28", invQty: "28",
      stampRecommendation: "Requires PE-stamped structural plans and a sealed engineering letter — spans exceed the prescriptive tables",
    },
  },
];

const { openDatabase } = await import("../backend/src/db");
const db = await openDatabase();

interface Row { [k: string]: unknown }
const demoClientRow = (): Row | null =>
  db.get<Row>("SELECT id, company_name FROM clients WHERE company_name = ?", [DEMO_MARKER]);

function demoProjectIds(clientId: string): string[] {
  return db.query<{ id: string }>("SELECT id FROM projects WHERE client_id = ?", [clientId]).map((r) => r.id);
}

function report(): void {
  const client = demoClientRow();
  if (!client) { console.log("No demo environment present."); return; }
  const ids = demoProjectIds(String(client.id));
  console.log(`Demo company: ${DEMO_MARKER} (${client.id})`);
  console.log(`Demo projects: ${ids.length}`);
  for (const id of ids) {
    const p = db.get<Row>("SELECT homeowner_name, city, state, status FROM projects WHERE id = ?", [id]);
    console.log(`  ${String(p?.homeowner_name).padEnd(20)} ${String(p?.city + ", " + p?.state).padEnd(18)} ${p?.status}  ${id.slice(0, 8)}`);
  }
}

if (STATUS) { report(); db.close(); process.exit(0); }

if (RESET) {
  const client = demoClientRow();
  if (!client) { console.log("Nothing to remove — no demo company on file."); db.close(); process.exit(0); }
  const clientId = String(client.id);
  const ids = demoProjectIds(clientId);
  // Child rows first, and the table list is DERIVED FROM THE SCHEMA rather than written out
  // here. A hand-kept list was wrong the first time it ran (it missed source_files,
  // extracted_fields, reviewer_vision_cache and eight more, and named a status_history table
  // that does not exist), and it would rot again the next time a table is added. Asking the
  // schema which tables carry a project_id cannot go stale.
  const childTables = db.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).map((r) => String(r.name)).filter((table) => {
    try {
      return db.query<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => String(c.name) === "project_id");
    } catch { return false; }
  });
  // Rows that hang off the COMPANY rather than a project (customers, portal credentials and
  // profiles, client-portal identities) — derived the same way, from the foreign keys that
  // point at `clients`, because the final DELETE FROM clients fails on any one of them.
  const clientTables = db.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).map((r) => String(r.name)).filter((table) => {
    if (table === "projects") return false;
    try {
      return db.query<{ table: string; from: string }>(`PRAGMA foreign_key_list(${table})`)
        .some((fk) => String(fk.table) === "clients" && String(fk.from) === "client_id");
    } catch { return false; }
  });
  // DEPENDENCY ORDER BY REPETITION, INSIDE ONE TRANSACTION. Child tables reference EACH OTHER
  // (permit_status_checks.target_id → permit_check_targets, email_project_matches →
  // permit_status_checks, communications → customers), so one pass in schema order fails a
  // foreign key the moment a project has a status check. It used to do exactly that: measured on
  // a copy of a kit seeded by demo-later-stages.ts, --reset crashed with "FOREIGN KEY constraint
  // failed" after deleting two of the eight projects, leaving the demo half-removed.
  // So: every statement is attempted each pass, a statement blocked by a row a LATER statement
  // removes succeeds on the next pass, and N+1 passes settle any acyclic order. Anything still
  // blocked after that is a reference this script does not know about — it THROWS, and the
  // transaction rolls the whole reset back: the demo is either fully present or fully gone.
  const statements: Array<{ label: string; sql: string; params: string[] }> = [];
  for (const id of ids) {
    for (const table of childTables) statements.push({ label: `${table} (project ${id.slice(0, 8)})`, sql: `DELETE FROM ${table} WHERE project_id = ?`, params: [id] });
    statements.push({ label: `projects (${id.slice(0, 8)})`, sql: "DELETE FROM projects WHERE id = ?", params: [id] });
  }
  for (const table of clientTables) statements.push({ label: `${table} (company)`, sql: `DELETE FROM ${table} WHERE client_id = ?`, params: [clientId] });
  statements.push({ label: "clients (company)", sql: "DELETE FROM clients WHERE id = ?", params: [clientId] });
  // The shared profiles this demo taught (older demos predate learning_excluded), collected
  // BEFORE the rows go, so their derived fields can be rebuilt from what remains — the same
  // rollup deleteProject runs.
  const affectedKeys = new Set<string>();
  for (const id of ids) {
    for (const table of ["knowledge_events", "historical_failure_examples", "historical_project_fingerprints", "permit_timeline_samples"]) {
      try {
        for (const r of db.query<{ profile_key: string }>(`SELECT DISTINCT profile_key FROM ${table} WHERE project_id = ?`, [id])) {
          if (r.profile_key) affectedKeys.add(String(r.profile_key));
        }
      } catch { /* table absent on an old schema */ }
    }
  }
  try {
    db.transaction(() => {
      let blocked: string[] = [];
      for (let pass = 0; pass <= statements.length; pass++) {
        blocked = [];
        for (const st of statements) {
          try { db.run(st.sql, st.params); } catch (err) { blocked.push(`${st.label}: ${(err as Error).message}`); }
        }
        if (!blocked.length) return;
      }
      throw new Error(`still blocked after ${statements.length + 1} passes — ${blocked.slice(0, 5).join("; ")}${blocked.length > 5 ? `; …and ${blocked.length - 5} more` : ""}`);
    });
  } catch (err) {
    console.error(`[demo-environment] --reset REFUSED and rolled back — nothing was removed: ${(err as Error).message}`);
    db.close();
    process.exit(1);
  }
  const { rebuildKnowledgeRollup } = await import("../backend/src/knowledgeBase");
  for (const key of affectedKeys) rebuildKnowledgeRollup(db, key);
  console.log(`Removed the demo environment: ${ids.length} project(s) and the ${DEMO_MARKER} company.`);
  console.log(`Rebuilt the derived fields (project count, correction patterns, timeline) of ${affectedKeys.size} shared profile(s) it had touched.`);
  console.log("Not removed: note/source SEGMENTS an older (pre-learning_excluded) demo merged into shared profiles,");
  console.log("and document/filled-form files on disk.");
  db.close();
  process.exit(0);
}

// ---- create -----------------------------------------------------------------
const { createClient } = await import("../backend/src/clients");
const { createProject, rerunQc } = await import("../backend/src/repository");
const { saveProjectDocument } = await import("../backend/src/projectDocuments");
const { processStageStep } = await import("../backend/src/autoStageSteps");
const { buildPlanSetPdf } = await import("./demoPlanSet");

const planSetPdf = await buildPlanSetPdf();
const created: Array<{ id: string; target?: string }> = [];

let client = demoClientRow();
if (!client) {
  const created = createClient(db, DEMO_COMPANY);
  console.log(`Created demo company ${DEMO_MARKER} (${created.id})`);
  client = demoClientRow();
} else {
  console.log(`Demo company already present (${client.id})`);
}
const clientId = String(client!.id);

const existingOwners = new Set(
  db.query<{ homeowner_name: string }>("SELECT homeowner_name FROM projects WHERE client_id = ?", [clientId])
    .map((r) => String(r.homeowner_name)),
);

let made = 0;
for (const spec of DEMO_PROJECTS) {
  if (existingOwners.has(spec.owner)) { console.log(`  = ${spec.owner} already present`); continue; }
  const { project } = createProject(db, {
    clientId,
    owner: spec.owner,
    street: spec.street,
    city: spec.city,
    state: spec.state,
    zip: "99999", // deliberately invalid — no demo row can be mistaken for a real filing
    ahj: spec.ahj,
    utility: spec.utility,
    dcKw: spec.dcKw,
    acKw: spec.acKw,
    homeownerEmail: `${spec.owner.toLowerCase().replace(/[^a-z]+/g, ".")}@example.invalid`,
    homeownerPhone: "(555) 010-0000",
    ...(spec.snapshot ?? {}),
  } as never, undefined, { learningExcluded: true });
  // A PLAN SET, because a project with no documents is a demo that breaks on the first
  // click. The board would look right and every detail page would show a wall of
  // document-inventory blockers — no plan set, no SLD, no site plan — which is precisely
  // the "Blocked" band you do not want on screen in front of a prospect. This is a real
  // multi-sheet PDF through the real upload path, so the splitter produces real parts and
  // the document gates are answered by documents rather than by parking a status.
  saveProjectDocument(db, project.id, {
    filename: `${spec.owner.toLowerCase().replace(/[^a-z]+/g, "-")}-plan-set.pdf`,
    docType: "plan_set",
    contentType: "application/pdf",
    buffer: planSetPdf,
    source: "upload",
  });

  // RE-RUN QC THROUGH THE REAL PATH. createProject runs QC at birth against the payload as
  // it was first normalized, which leaves review items standing even when the snapshot holds
  // the answers — measured on the first build of this demo: every project carried 7 pending
  // items for fields it demonstrably had. rerunQc is the same function the QC button calls,
  // and a passing check auto-resolves the item (resolvePendingReviewItem), so the demo board
  // shows what a complete project actually looks like instead of a wall of questions.
  rerunQc(db, project.id);
  created.push({ id: project.id, target: spec.status });
  console.log(`  + ${spec.owner.padEnd(20)} ${spec.status ?? "parsed"}  — ${spec.note}`);
  made++;
}

// EARN THE STATUSES. Run the real automatic chain — split, form acquisition, document
// package, reviewer gate — exactly as a live project gets it. A parked status with no
// artifacts behind it is the lie this script's header warns about: the board reads right
// and the first detail page a prospect opens shows blockers for documents nobody built.
if (created.length) {
  console.log("\nRunning the real chain on each demo project (split → docs → reviewer gate)…");
  for (const { id, target } of created) {
    try {
      // The chain advances as far as the evidence allows; it never passes ready_to_stage.
      for (let pass = 0; pass < 3; pass++) await processStageStep(db, id);
      // WAIT FOR THE DOCUMENT TEXT, THEN RUN IT AGAIN. saveProjectDocument kicks off text
      // extraction as fire-and-forget, so the first chain judges the split sheets before
      // their text exists — the reviewer and the historical check then see no framing or
      // interconnection evidence and raise blockers the documents plainly answer. Measured
      // on this very demo: one project went from three blockers to zero on a second pass
      // with nothing else changed. A real project gets the same second look from the next
      // save; a one-shot script has to wait for it deliberately.
      for (let waited = 0; waited < 40; waited++) {
        const pending = Number(db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ? AND extracted_text = ''", [id])?.n ?? 0);
        if (pending === 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      for (let pass = 0; pass < 2; pass++) await processStageStep(db, id);
    } catch (err) {
      console.log(`  ! chain error on ${id.slice(0, 8)}: ${(err as Error).message.slice(0, 120)}`);
    }
    const now = String(db.get<Row>("SELECT status FROM projects WHERE id = ?", [id])?.status ?? "");
    const docs = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ?", [id])?.n ?? 0);
    const owner = String(db.get<Row>("SELECT homeowner_name FROM projects WHERE id = ?", [id])?.homeowner_name ?? "");
    // Only note a difference from the intended stage — the chain's verdict is the truth here,
    // and a demo that quietly forces a status would be back to parking.
    const note = target && target !== now ? `  (intended ${target}; the chain says ${now} — that IS the honest state)` : "";
    console.log(`  ${owner.padEnd(20)} ${now.padEnd(16)} ${docs} document(s)${note}`);
  }
}

console.log(`\nDemo environment ready: ${made} project(s) created.`);
console.log("Every homeowner is invented and every address is a 99999 ZIP — no real customer appears.");
console.log("Filter the board by client \"" + DEMO_MARKER + "\" to show it, and run with --reset to remove it.");
console.log("");
console.log("ONE MORE PASS, with the server running, finishes the set:");
console.log("  for each demo project:  POST /api/projects/<id>/qc");
console.log("Form ACQUISITION runs in the job worker (it fetches and fills the AHJ's own blanks),");
console.log("so an in-process build cannot produce those files. After that pass the board reads:");
console.log("  · one project fully green — Approve & Submit armed, nothing outstanding");
console.log("  · two carrying a learned-failure callout from a real past correction");
console.log("  · one on the engineered path, correctly demanding PE-stamped plans");
console.log("which is a better demo than four identical green rows: it shows the gates working.");
db.close();
process.exit(0);
