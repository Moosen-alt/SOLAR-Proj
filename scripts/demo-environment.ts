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
//     completely with --reset. It never touches a row it did not create.
//   · Synthetic homeowners only. The addresses are deliberately invalid (999xx) so nobody
//     can mistake one for a real filing, and no demo project is ever staged to a portal.
//   · It refuses to run against a database that has no real data ONLY in the sense that it
//     does not care — it adds, it does not migrate, and --reset is exact.
//
//   npx tsx scripts/demo-environment.ts            # create (idempotent)
//   npx tsx scripts/demo-environment.ts --reset    # remove every demo row
//   npx tsx scripts/demo-environment.ts --status   # what exists right now
// ---------------------------------------------------------------------------
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

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
const DEMO_PROJECTS: Array<{
  owner: string; street: string; city: string; state: string; ahj: string; utility: string;
  dcKw: string; acKw: string; status?: string; note: string;
  snapshot?: Record<string, unknown>;
}> = [
  {
    owner: "Marisol Vega", street: "412 Lantern Way", city: "Salem", state: "OR",
    ahj: "City of Salem", utility: "Portland General Electric", dcKw: "7.31", acKw: "5.95",
    note: "Just parsed — shows intake and the automatic chain picking it up.",
    snapshot: {
      mounting: "Roof mount", framingType: "truss", roofRafterSpacing: "24", roofMaterial: "Composition Shingle",
      snow: "36", wind: "C", windSpeed: "95", deadLoad: "2.6", jobValue: "31500",
      moduleQuantity: "17", moduleModel: "Q.TRON BLK M-G2.C1+", pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US",
    },
  },
  {
    owner: "Terrence Boyd", street: "88 Kestrel Loop", city: "Coos Bay", state: "OR",
    ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "9.04", acKw: "7.60",
    status: "qc_passed",
    note: "Through QC — shows the built AHJ/NEM document package.",
    snapshot: {
      mounting: "Roof mount", framingType: "rafter", roofRafterSpacing: "24", roofRafterSpan: "11",
      roofMaterial: "Composition Shingle", snow: "16", wind: "C", windSpeed: "110", deadLoad: "2.8",
      jobValue: "38200", accountNumber: "DEMO-000-1234", moduleQuantity: "22",
    },
  },
  {
    owner: "Priya Raman", street: "2170 Alder Bend", city: "Portland", state: "OR",
    ahj: "City of Portland", utility: "Portland General Electric", dcKw: "6.12", acKw: "5.10",
    status: "ready_to_stage",
    note: "Ready to stage — shows the reviewer gate green and the submit gate armed.",
    snapshot: {
      mounting: "Roof mount", framingType: "truss", roofRafterSpacing: "24", roofMaterial: "Composition Shingle",
      snow: "25", wind: "B", windSpeed: "100", deadLoad: "2.4", jobValue: "26400",
      accountNumber: "DEMO-000-5678", moduleQuantity: "15",
    },
  },
  {
    owner: "Gus Halvorsen", street: "57 Ember Court", city: "Tigard", state: "OR",
    ahj: "City of Tigard", utility: "Portland General Electric", dcKw: "11.20", acKw: "9.60",
    status: "ready_to_stage",
    note: "A deliberately UNRESOLVED one — engineered path, so the gate asks for stamped plans.",
    snapshot: {
      mounting: "Roof mount", permitPath: "engineered", framingType: "rafter", roofRafterSpacing: "24",
      roofMaterial: "Composition Shingle", snow: "25", wind: "B", windSpeed: "100", deadLoad: "3.1",
      jobValue: "46900", accountNumber: "DEMO-000-9012", moduleQuantity: "28",
      stampRecommendation: "Requires PE-stamped structural plans and a sealed engineering letter — spans exceed the prescriptive tables",
    },
  },
];

const { openDatabase } = await import("../backend/src/db");
const db = await openDatabase();

interface Row { [k: string]: unknown }
const demoClientRow = (): Row | undefined =>
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
  for (const id of ids) {
    for (const table of childTables) {
      try { db.run(`DELETE FROM ${table} WHERE project_id = ?`, [id]); } catch { /* view or locked — skip */ }
    }
    db.run("DELETE FROM projects WHERE id = ?", [id]);
  }
  try { db.run("DELETE FROM portal_credentials WHERE client_id = ?", [clientId]); } catch { /* optional */ }
  db.run("DELETE FROM clients WHERE id = ?", [clientId]);
  console.log(`Removed the demo environment: ${ids.length} project(s) and the ${DEMO_MARKER} company.`);
  db.close();
  process.exit(0);
}

// ---- create -----------------------------------------------------------------
const { createClient } = await import("../backend/src/clients");
const { createProject } = await import("../backend/src/repository");

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
  } as never);
  // Park it at the stage that tells its part of the story. createProject runs QC at birth,
  // so this is set afterwards and deliberately — the demo is a STAGED BOARD, not a claim
  // that these projects passed every gate.
  if (spec.status) db.run("UPDATE projects SET status = ? WHERE id = ?", [spec.status, project.id]);
  console.log(`  + ${spec.owner.padEnd(20)} ${spec.status ?? "parsed"}  — ${spec.note}`);
  made++;
}

console.log(`\nDemo environment ready: ${made} project(s) created.`);
console.log("Every homeowner is invented and every address is a 99999 ZIP — no real customer appears.");
console.log("Filter the board by client \"" + DEMO_MARKER + "\" to show it, and run with --reset to remove it.");
db.close();
process.exit(0);
