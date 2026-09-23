// ---------------------------------------------------------------------------
// THE REST OF THE BOARD.
//
// scripts/demo-environment.ts seeds four synthetic projects and every one of them stops at
// `ready_to_stage` — columns 1 and 2. A prospect watching the demo sees the intake, the gates
// and the document package, and then three empty columns: Submit, Track Approvals and
// Closeout. Those are the columns that answer "and then what?", and they were blank.
//
// This adds FOUR more synthetic projects for the same demo company, each carried to a later
// stage through the product's REAL code paths — the same functions the buttons call:
//
//   (A) 3 · Submit          City of Portland / PGE     every required track mock-staged to the
//                                                      review screen → awaiting_human_submit.
//                                                      The presenter captures a confirmation live.
//   (B) 4 · Track Approvals City of Salem / PGE        staged, each track recorded as filed
//                                                      (simulated, numbered DEMO-SLM-…), then
//                                                      pasted portal status text → building permit
//                                                      ready_for_issue, NEM + electrical in review.
//   (C) 5 · Closeout        City of Coos Bay /         staged, filed, both permits issued, NEM
//                           Pacific Power — or, when   approved → handoff_ready. Coos Bay only when
//                           the kit lacks the Coos     the kit holds a City of Coos Bay
//                           Bay building form, City    building_application form (see
//                           of Salem / PGE             closeoutSpec); the run prints which.
//   (D) 2 · Build           City of Happy Valley / PGE a prescriptive AHJ with NO forms on file.
//                                                      Downloads are off, so none are acquired and
//                                                      it waits in column 2 — the live
//                                                      form-upload beat.
//
// NOTHING LEAVES THE MACHINE, AND THAT IS ASSERTED, NOT HOPED FOR:
//   · "Staging" is the MockPortalAdapter, selected by the product's own explicit simulation
//     switch (MOCK_PORTAL=1 — the smoke test's switch). No browser is launched; Playwright is
//     pointed at a browsers folder that does not exist so a launch could not succeed anyway.
//   · A network trap (scripts/demo-portal/offlineTrap.ts) is installed before any backend module
//     loads: TCP at net.Socket.prototype.connect (under net, http(s) agents, tls and fetch), plus
//     tls.connect, http(s).request/get, new http.ClientRequest, DNS and fetch at the call, throw on
//     any host that is not EXACTLY 127.0.0.1, ::1 or localhost, and every attempt is counted. Not
//     trapped: UDP and child processes — this script's code paths use neither.
//   · It refuses to start unless the backend code it runs carries the offline gates
//     (portalAutomationDisabled in backend/src/autopilot.ts, documentFetchDisabled in
//     backend/src/ahjForms.ts). WHICH code: the modules are imported relative to THIS FILE, so
//     `npx tsx ../scripts/demo-later-stages.ts` from a kit runs the REPO's backend/src against the
//     KIT's database — not the kit's own copy of backend/src (that copy is what the kit SERVER
//     runs; keeping it current is the kit's job). The script prints the code root it used.
//   · Filings are recorded with markTrackSubmitted — the operator's "I submitted this" door —
//     with numbers that say DEMO, a submitter that says "simulated filing, no portal contacted",
//     and NO tracking URL, so nothing on these rows can ever be polled.
//   · At the end the script REFUSES (non-zero exit) unless every portal run on these projects was
//     the MockPortalAdapter with finalSubmitClicked false, no job was enqueued, the trap counted
//     zero outbound attempts, and EACH of the four — including any an earlier run seeded — sits
//     in its intended column with every track staged / numbered / read as designed.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   · Touch the four projects demo-environment.ts made. They are read, never written.
//   · Seed a correction loop. A correction writes historical_failure_examples, which changes
//     the learned-failure callouts on the OTHER demo projects.
//   · Download anything (DOCUMENT_FETCH=off, AHJ_FORM_DOWNLOADS=off, no API key).
//
// LEARNING: its projects are created learning_excluded, so their status checks, targets and
// saves teach the SHARED knowledge base nothing (no profile facts, fingerprints, failure rows or
// timeline samples). The script still prints which KB rows changed, and that list should now be
// empty — anything on it is a learn path that forgot the exclusion.
// Run it only against a demo database — which is also why it refuses to run without an explicit
// --db, and refuses (read-only check, before anything migrates) any database holding a client
// other than the demo company.
//
//   cd demo-kit && npx tsx ../scripts/demo-later-stages.ts --db backend/data/autopilot.sqlite
//   (stop the kit server first; run from the KIT folder — documents and filled forms are written
//    relative to the current directory, beside the database)
//   cd demo-kit && npx tsx ../scripts/demo-later-stages.ts --db backend/data/autopilot.sqlite --remove
//
// Re-runnable: a homeowner that already exists is not created again, but IS re-verified, and a
// project that has moved or was half-seeded fails the run (--remove, then re-run, restores it).
// `--remove` deletes only these four projects, in one transaction (the originals are untouched).
// `demo-environment.ts --reset` removes every project of the demo company — these included — plus
// the company, also in one transaction. Neither removes the shared KB rows above or files on disk.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Builtins only (and a type-only playwright import), so both are safe ahead of the trap.
import { installOfflineTrap } from "./demo-portal/offlineTrap";
import { demoOnlyDatabaseProblem, offlineGatesProblem } from "./demo-portal/guards";

function die(message: string): never {
  console.error(`\n[demo-later-stages] REFUSED: ${message}`);
  process.exit(1);
}

// ---- arguments + where we are -----------------------------------------------
const argv = process.argv.slice(2);
const dbArgIndex = argv.indexOf("--db");
const dbArg = dbArgIndex >= 0 ? argv[dbArgIndex + 1] : "";
if (!dbArg) die("pass --db <path to the DEMO database>. There is no default: this script writes, and must never land on production by accident.");
const DB_PATH = path.resolve(dbArg);
if (!fs.existsSync(DB_PATH)) die(`no database at ${DB_PATH}. Seed the demo first (scripts/demo-environment.ts).`);
// Documents (backend/data/project-documents) and filled forms (backend/data/filled) resolve off
// process.cwd(). A database outside the current folder means those files would be written into
// some OTHER installation's data folder while the rows point at them — refuse instead.
// "Inside the current folder" is not enough: the kit sits INSIDE the repo, so running from the repo
// root with --db demo-kit/backend/data/... would pass that test and write the kit's documents into
// the repo's own backend/data. The database must be exactly <cwd>/backend/data/<file>.
const CWD = path.resolve(process.cwd());
const expectedDataDir = path.join(CWD, "backend", "data");
if (path.dirname(DB_PATH).toLowerCase() !== expectedDataDir.toLowerCase()) {
  die(`the database (${DB_PATH}) must live in ${expectedDataDir} — run this from the kit folder itself, so its documents and filled forms land beside its database.`);
}

// ---- environment: forced, before any backend module is imported ----------------
// Staging must be the mock and nothing else. PORTAL_AUTOMATION=off would stop prepareSubmission
// before the mock could stage (it is the kit's refuse-only switch), so it is removed for THIS
// process only; the explicit simulation switch plus auto-seed off is what makes the product's
// own channel resolver pick MockPortalAdapter. The preflight below proves no recipe or portal
// profile exists that would outrank the mock.
delete process.env.PORTAL_AUTOMATION;
process.env.MOCK_PORTAL = "1";
process.env.PORTAL_AUTOSEED = "0";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.DOCUMENT_FETCH = "off";
process.env.DOCUMENT_FETCH_BROWSER = "0";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.AHJ_FORM_RESEARCH = "off";
process.env.BACKGROUND_WORKERS = "off";
process.env.CLIENT_NOTIFICATIONS = "off";
process.env.FEE_RESEARCH = "off";
process.env.PORTAL_URL_RESEARCH = "off";
process.env.RUN_TRIAGE = "off";
process.env.AUTO_RELEARN_STALE = "0";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "false";
process.env.AUTOPILOT_DB_PATH = DB_PATH;
// A browser launch cannot succeed: Playwright looks for Chromium in a folder that does not exist.
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(CWD, ".no-browsers-for-demo-seeding");
// No secret reaches this process, whatever the shell or a stray .env carried. With no API key
// the LLM provider is the local stub; with no SMTP nothing can send.
for (const key of Object.keys(process.env)) {
  if (/^(ANTHROPIC_API_KEY|OPENAI_API_KEY|SMTP_|EMAIL_IMAP_|GMAIL_|LITESTREAM_)/.test(key)) delete process.env[key];
}

// ---- network trap: installed before any backend module loads -------------------
// scripts/demo-portal/offlineTrap.ts lists exactly what it covers (TCP at
// net.Socket.prototype.connect, tls, http(s) incl. ClientRequest, DNS, fetch) and what it does
// not (UDP, child processes). Loopback means EXACTLY 127.0.0.1, ::1 or localhost.
const outbound = installOfflineTrap("demo-later-stages").attempts;

// ---- which backend code this runs, and does it carry the offline gates ----------
// The backend modules below are imported RELATIVE TO THIS FILE, not the current folder: run as
// `npx tsx ../scripts/demo-later-stages.ts` from a kit, it drives the REPO's backend/src against
// the KIT's database. That is the code whose gates must be present — a kit's own older copy of
// backend/src is not what runs here (it IS what the kit's server runs; checking that is the
// kit's job, not this script's).
const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
{
  const gateProblem = offlineGatesProblem(CODE_ROOT);
  if (gateProblem) die(gateProblem);
  console.log(`Running backend code from ${path.join(CODE_ROOT, "backend", "src")} (offline gates present) against ${DB_PATH}.`);
}

// ---- the story -------------------------------------------------------------------
const DEMO_MARKER = "Solaris Demo Co"; // the company demo-environment.ts created; --reset keys on it

// Kept identical to ELECTRICAL_COMPLETE in scripts/demo-environment.ts (that file runs on import,
// so it cannot be imported). These are the ALIAS keys QC reads, not the check names.
const ELECTRICAL_COMPLETE = {
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

type Stage = "submit" | "track" | "closeout" | "build";
interface Spec {
  key: "A" | "B" | "C" | "D";
  owner: string; street: string; city: string; ahj: string; utility: string;
  dcKw: string; acKw: string; phone: string;
  snapshot: Record<string, unknown>;
  /** Board column + status the project must end in. */
  expect: { stageKey: Stage; status: string; stageDetail?: string };
  /** The permit tracks this AHJ must require — asserted, so an AHJ profile change that alters
   *  the track set stops the script instead of producing a half-filed demo. */
  expectTracks: string[];
  /** Stage every required track to the (mock) review screen. */
  stage: boolean;
  /** Record each track as filed (simulated). */
  file?: { prefix: string; seq: string; daysAgo: number };
  /** Pasted portal status text, IN THIS ORDER. The order is load-bearing: a "waiting" read
   *  may advance ready_for_issue back to submitted (MONITOR_WAITING_MAY_ADVANCE), so any
   *  waiting reads go FIRST and the decisive read goes LAST. */
  statusChecks?: Array<{ track: string; text: string; outcome: string }>;
}

const SIMULATED_BY = "Dana Reyes (demo — simulated filing, no portal contacted)";

const SPECS: Spec[] = [
  {
    key: "A", owner: "Lena Okafor", street: "3318 Juniper Terrace", city: "Portland",
    ahj: "City of Portland", utility: "Portland General Electric", dcKw: "7.74", acKw: "5.22", phone: "(555) 010-0011",
    snapshot: {
      mounting: "Roof mount", framingType: "truss", roofRafterSpacing: "24", roofMaterial: "Composition Shingle",
      snow: "25", wind: "B", windSpeed: "100", deadLoad: "2.4", jobValue: "30900",
      account: "DEMO-000-0011", meter: "DEMO-MTR-0011", ...ELECTRICAL_COMPLETE, moduleQty: "18", invQty: "18", permitPath: "prescriptive",
    },
    expect: { stageKey: "submit", status: "awaiting_human_submit", stageDetail: "staged_for_review" },
    expectTracks: ["nem", "combo"],
    stage: true,
  },
  {
    key: "B", owner: "Walt Brennan", street: "905 Quarry Bend", city: "Salem",
    ahj: "City of Salem", utility: "Portland General Electric", dcKw: "8.60", acKw: "5.80", phone: "(555) 010-0012",
    snapshot: {
      mounting: "Roof mount", framingType: "truss", roofRafterSpacing: "24", roofMaterial: "Composition Shingle",
      snow: "36", wind: "C", windSpeed: "95", deadLoad: "2.6", jobValue: "34800",
      account: "DEMO-000-0012", meter: "DEMO-MTR-0012", ...ELECTRICAL_COMPLETE, moduleQty: "20", invQty: "20", permitPath: "prescriptive",
    },
    expect: { stageKey: "track", status: "ready_for_issue", stageDetail: "ready_for_issue" },
    expectTracks: ["nem", "building", "electrical"],
    stage: true,
    file: { prefix: "DEMO-SLM", seq: "0001", daysAgo: 9 },
    statusChecks: [
      { track: "electrical", text: "Plans assigned to reviewer - electrical plan review in progress.", outcome: "waiting" },
      { track: "nem", text: "Engineering Review", outcome: "waiting" },
      { track: "building", text: "Approved pending payment. Permit is ready to issue; issuance fees are due.", outcome: "ready_for_issue" },
    ],
  },
  // (C) is built by closeoutSpec() below — its AHJ depends on which forms the kit holds.
  {
    key: "D", owner: "Idris Farah", street: "12 Scouters Ridge", city: "Happy Valley",
    ahj: "City of Happy Valley", utility: "Portland General Electric", dcKw: "6.88", acKw: "4.64", phone: "(555) 010-0014",
    snapshot: {
      mounting: "Roof mount", framingType: "truss", roofRafterSpacing: "24", roofMaterial: "Composition Shingle",
      snow: "25", wind: "B", windSpeed: "100", deadLoad: "2.4", jobValue: "27600",
      account: "DEMO-000-0014", meter: "DEMO-MTR-0014", ...ELECTRICAL_COMPLETE, moduleQty: "16", invQty: "16", permitPath: "prescriptive",
    },
    // ready_to_stage, not qc_passed: the chain's package builder still produces the GENERATED
    // documents (cover sheet, manifest, transfer sheet, worksheets) for an AHJ with no forms on
    // file, so it advances. What it cannot produce is the AHJ's own checklist, and the staging
    // document gate says so — asserted below, because that missing form IS the beat.
    expect: { stageKey: "build", status: "ready_to_stage" },
    expectTracks: ["nem", "combo"],
    stage: false,
  },
];

// CLOSEOUT: COOS BAY / PACIFIC POWER WHEN THE KIT CAN HONESTLY FILE IT, SALEM / PGE OTHERWISE.
// Coos Bay is the design (a second utility on the board). Without a Coos Bay building
// application form on file the product refuses it honestly — the staging document gate blocks
// the building track with "Prescriptive solar permit application, filled", the same blocker the
// original Coos Bay demo project carries — and faking that form would be the demo lying about
// the product. So the kit's own form library decides: a stored building_application template for
// City of Coos Bay → Coos Bay; none → Salem, which files the same three tracks with every form on
// file. The owner is the same either way, so --remove and the re-run check find the row.
const CLOSEOUT_OWNER = "Rosa Delgado";
function closeoutSpec(coosBay: boolean): Spec {
  const checks = (nemText: string): Spec["statusChecks"] => [
    // Wording avoids "Record Status: Issued", which reads as a portal scrape.
    { track: "building", text: "Permit issued. Download permit card from the portal.", outcome: "issued" },
    { track: "electrical", text: "Permit issued. Download permit card from the portal.", outcome: "issued" },
    { track: "nem", text: nemText, outcome: "nem_approved" },
  ];
  const common = {
    key: "C" as const, owner: CLOSEOUT_OWNER, street: "41 Driftwood Spur", dcKw: "10.32", acKw: "6.96", phone: "(555) 010-0013",
    expect: { stageKey: "closeout" as Stage, status: "handoff_ready", stageDetail: "handoff_ready" },
    expectTracks: ["nem", "building", "electrical"],
    stage: true,
  };
  if (coosBay) {
    return {
      ...common, city: "Coos Bay", ahj: "City of Coos Bay", utility: "Pacific Power",
      // The original Coos Bay demo project's structural answers (rafter framing, coastal wind),
      // which the chain already carries to ready_to_stage.
      snapshot: {
        mounting: "Roof mount", framingType: "rafter", roofRafterSpacing: "24", roofRafterSpan: "11",
        roofMaterial: "Composition Shingle", snow: "16", wind: "C", windSpeed: "110", deadLoad: "2.8", jobValue: "41700",
        account: "DEMO-000-0013", meter: "DEMO-MTR-0013", ...ELECTRICAL_COMPLETE, moduleQty: "24", invQty: "24", permitPath: "prescriptive",
      },
      file: { prefix: "DEMO-CBY", seq: "0002", daysAgo: 26 },
      statusChecks: checks("Interconnection application approved - approved to install."),
    };
  }
  return {
    ...common, city: "Salem", ahj: "City of Salem", utility: "Portland General Electric",
    snapshot: {
      mounting: "Roof mount", framingType: "truss", roofRafterSpacing: "24", roofMaterial: "Composition Shingle",
      snow: "36", wind: "C", windSpeed: "95", deadLoad: "2.6", jobValue: "41700",
      account: "DEMO-000-0013", meter: "DEMO-MTR-0013", ...ELECTRICAL_COMPLETE, moduleQty: "24", invQty: "24", permitPath: "prescriptive",
    },
    file: { prefix: "DEMO-SLM", seq: "0002", daysAgo: 26 },
    statusChecks: checks("Interconnection application approved - approved to install."),
  };
}

// ---- open + preflight -------------------------------------------------------------
// THE DECISIVE PRODUCTION GUARD, checked READ-ONLY before openDatabase (which migrates — a write).
// demo-environment.ts was written to run against the live database, so "the demo company exists"
// does not tell a kit from production. A kit holds the demo company and nothing else; any other
// client means real customers live here. Refuse.
{
  const Database = (await import("better-sqlite3")).default;
  const ro = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  let problem: string | null;
  try {
    problem = demoOnlyDatabaseProblem({ get: (sql, params = []) => ro.prepare(sql).get(...(params as never[])) as never });
  } finally { ro.close(); }
  if (problem) die(`${problem} Run scripts/demo-environment.ts in a demo kit first — this script extends that demo, and runs only on a demo kit.`);
}
const { openDatabase } = await import("../backend/src/db");
const db = await openDatabase();
interface Row { [k: string]: unknown }
const count = (sql: string, params: unknown[] = []): number =>
  Number(db.get<{ n: number }>(sql, params as never)?.n ?? 0);
const client = db.get<Row>("SELECT id FROM clients WHERE company_name = ?", [DEMO_MARKER]);
if (!client) die(`no "${DEMO_MARKER}" company in this database.`);
const clientId = String(client.id);

// Project C's AHJ, decided by the kit's own form library (see closeoutSpec). A C row seeded on an
// earlier run keeps the AHJ it was seeded with — it is verified as what it is, not re-targeted.
const existingC = db.get<Row>("SELECT ahj FROM projects WHERE client_id = ? AND homeowner_name = ?", [clientId, CLOSEOUT_OWNER]);
const coosBayFormOnFile = count(
  "SELECT COUNT(*) AS n FROM ahj_form_templates WHERE lower(ahj_name) = 'city of coos bay' AND form_type = 'building_application' AND pdf_blob IS NOT NULL AND length(pdf_blob) > 0",
) > 0;
const closeoutIsCoosBay = existingC ? /coos bay/i.test(String(existingC.ahj ?? "")) : coosBayFormOnFile;
SPECS.splice(2, 0, closeoutSpec(closeoutIsCoosBay));
console.log(closeoutIsCoosBay
  ? `(C) Closeout targets City of Coos Bay / Pacific Power${existingC ? " (as already seeded)" : " — a City of Coos Bay building_application form is on file"}.`
  : `(C) Closeout targets City of Salem / PGE${existingC ? " (as already seeded)" : " — no City of Coos Bay building_application form in this kit, so Coos Bay cannot be filed honestly"}.`);
if (existingC && closeoutIsCoosBay !== coosBayFormOnFile) {
  console.log(`    note: the kit ${coosBayFormOnFile ? "now holds" : "no longer holds"} the Coos Bay building form; --remove and re-run to re-seed (C) accordingly.`);
}

// --remove: delete ONLY this script's four projects, leaving demo-environment.ts's four alone
// (its --reset removes every demo project). Child tables are derived from the schema, exactly as
// --reset does it, so a table added later cannot be missed. Shared KB rows are not touched —
// they carry no project_id — and document files stay on disk as orphans, as with --reset.
if (argv.includes("--remove")) {
  const ids = db.query<{ id: string; homeowner_name: string }>(
    `SELECT id, homeowner_name FROM projects WHERE client_id = ? AND homeowner_name IN (${SPECS.map(() => "?").join(", ")})`,
    [clientId, ...SPECS.map((s) => s.owner)],
  );
  const childTables = db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((r) => String(r.name))
    .filter((t) => { try { return db.query<{ name: string }>(`PRAGMA table_info(${t})`).some((c) => String(c.name) === "project_id"); } catch { return false; } });
  // SEVERAL PASSES, because child tables reference EACH OTHER (permit_status_checks.target_id →
  // permit_check_targets, email_project_matches → permit_status_checks), and a single pass in
  // schema order fails the foreign key on a project that has status checks (demo-environment.ts
  // --reset did exactly that until it got the same treatment). Repeat until a pass is blocked
  // nowhere, then the project row — all inside ONE transaction, so a reference this cannot clear
  // throws and removes nothing rather than leaving a half-deleted project.
  try {
    db.transaction(() => {
      for (const { id } of ids) {
        let blocked: string[] = [];
        for (let pass = 0; pass <= childTables.length; pass++) {
          blocked = [];
          for (const t of childTables) {
            try { db.run(`DELETE FROM ${t} WHERE project_id = ?`, [id]); } catch (err) { blocked.push(`${t}: ${(err as Error).message}`); }
          }
          if (!blocked.length) break;
        }
        if (blocked.length) throw new Error(`project ${id.slice(0, 8)} still blocked — ${blocked.slice(0, 3).join("; ")}`);
        db.run("DELETE FROM projects WHERE id = ?", [id]);
      }
    });
  } catch (err) {
    die(`--remove rolled back — nothing was removed: ${(err as Error).message}`);
  }
  console.log(`Removed ${ids.length} later-stage demo project(s): ${ids.map((r) => r.homeowner_name).join(", ") || "none present"}. The original demo projects were not touched.`);
  db.close();
  process.exit(0);
}

// Anything that would outrank the mock in the product's channel resolver: a recorded recipe
// (RecipeAdapter replays it in a real browser) or a configured portal profile (hand-coded
// adapters). Either one means "staging" would try to drive a real portal. Refuse up front.
const recipeCount = count("SELECT COUNT(*) AS n FROM portal_recipes");
const profileCount = count("SELECT COUNT(*) AS n FROM portal_profiles");
if (recipeCount > 0 || profileCount > 0) {
  die(`this database carries ${recipeCount} portal recipe(s) and ${profileCount} portal profile(s). Either would route staging to a REAL portal adapter instead of the mock. This script only runs on a demo database with neither.`);
}

const jobsBefore = count("SELECT COUNT(*) AS n FROM job_queue");
const kbBefore = new Map(db.query<Row>("SELECT * FROM permit_utility_knowledge").map((r) => [String(r.id), JSON.stringify(r)]));

const { createProject, rerunQc, getProjectDetail, prepareSubmission, recordPermitStatusCheck, stagingMissingDocuments } = await import("../backend/src/repository");
const { documentInventory } = await import("../backend/src/requiredDocuments");
const { saveProjectDocument } = await import("../backend/src/projectDocuments");
const { processStageStep } = await import("../backend/src/autoStageSteps");
const { tracksToStage } = await import("../backend/src/autopilot");
const { requiredTracks, markTrackSubmitted, getSubmittalTracks } = await import("../backend/src/submittalTracks");
const { stageForStatus } = await import("../backend/src/projectStage");
const { buildPlanSetPdf } = await import("./demoPlanSet");
type ProjectStatus = Parameters<typeof stageForStatus>[0];
type TrackType = Parameters<typeof markTrackSubmitted>[2];

const existingOwners = new Set(
  db.query<{ homeowner_name: string }>("SELECT homeowner_name FROM projects WHERE client_id = ?", [clientId])
    .map((r) => String(r.homeowner_name)),
);
const planSetPdf = await buildPlanSetPdf();
const createdIds = new Map<string, Spec>();
const statusOf = (id: string): string => String(db.get<Row>("SELECT status FROM projects WHERE id = ?", [id])?.status ?? "");

async function runChain(id: string): Promise<void> {
  // Same two-pass chain demo-environment.ts runs, for the same reason: the first pass judges the
  // split sheets before their text is extracted; the second judges them with it.
  for (let pass = 0; pass < 3; pass++) await processStageStep(db, id);
  for (let waited = 0; waited < 40; waited++) {
    if (count("SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ? AND extracted_text = ''", [id]) === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  for (let pass = 0; pass < 2; pass++) await processStageStep(db, id);
}

for (const spec of SPECS) {
  if (existingOwners.has(spec.owner)) { console.log(`  = (${spec.key}) ${spec.owner} already present — not re-created; re-verified below`); continue; }
  console.log(`  + (${spec.key}) ${spec.owner} — ${spec.ahj} / ${spec.utility}`);
  const { project } = createProject(db, {
    clientId,
    owner: spec.owner,
    street: spec.street,
    city: spec.city,
    state: "OR",
    zip: "99999", // deliberately invalid — no demo row can be mistaken for a real filing
    ahj: spec.ahj,
    utility: spec.utility,
    dcKw: spec.dcKw,
    acKw: spec.acKw,
    homeownerEmail: `${spec.owner.toLowerCase().replace(/[^a-z]+/g, ".")}@example.invalid`,
    homeownerPhone: spec.phone,
    ...spec.snapshot,
  } as never, undefined, { learningExcluded: true });
  const id = project.id;
  createdIds.set(id, spec);
  saveProjectDocument(db, id, {
    filename: `${spec.owner.toLowerCase().replace(/[^a-z]+/g, "-")}-plan-set.pdf`,
    docType: "plan_set",
    contentType: "application/pdf",
    buffer: planSetPdf,
    source: "upload",
  });
  rerunQc(db, id);
  await runChain(id);
  // QC AGAIN, AFTER THE SPLIT — the "one more pass" demo-environment.ts tells the operator to
  // make. The first QC judged the project before the plan set was split, so it filed eight
  // "document missing" warnings for sheets that now exist; the originals show 22-23 pass / 3-4
  // warn only because they got this pass. rerunQc is the Run QC button, and like the button's
  // route it rewinds the status to qc_passed — so the chain runs again to carry it back.
  rerunQc(db, id);
  await runChain(id);

  const tracks = requiredTracks(getProjectDetail(db, id).project);
  if (tracks.join(",") !== spec.expectTracks.join(",")) {
    die(`(${spec.key}) ${spec.ahj} requires tracks [${tracks.join(", ")}], expected [${spec.expectTracks.join(", ")}]. The AHJ profile changed; update this script rather than seed a half-filed demo.`);
  }
  if (!spec.stage) continue;

  if (statusOf(id) !== "ready_to_stage") {
    die(`(${spec.key}) ${spec.owner} reached ${statusOf(id)} after the chain, not ready_to_stage — the gates are not clear, so it cannot honestly be staged. Nothing further was done to it; remove the later-stage projects with --remove, fix the cause, and re-run.`);
  }
  // PREFLIGHT THE DOCUMENT GATE FOR EVERY TRACK BEFORE STAGING ANY. Staging is per track, so a
  // track that the gate refuses AFTER an earlier one staged leaves a half-filed project on the
  // board (measured: Coos Bay staged NEM, then its building track was refused). Same predicate
  // prepareSubmission applies — one question, one answer.
  const toStage = tracksToStage(db, getProjectDetail(db, id).project);
  const gateGaps = toStage.flatMap((track) =>
    stagingMissingDocuments(documentInventory(db, getProjectDetail(db, id).project), track).map((d) => `${track}: ${d.label}`));
  if (gateGaps.length) {
    die(`(${spec.key}) ${spec.ahj}: the staging document gate would refuse — ${gateGaps.join("; ")}. Nothing was staged; remove the later-stage projects with --remove, fix the cause, and re-run.`);
  }
  // PER TRACK, never trackless: a trackless stage records permit_type 'permit' (on no track)
  // and skips the already-filed guard. tracksToStage is what autopilot stages.
  for (const track of toStage) {
    try {
      await prepareSubmission(db, id, track, /* autoSubmit */ false, /* allowFinalSubmit */ false);
    } catch (err) {
      die(`(${spec.key}) staging the ${track} track was refused: ${(err as Error).message}. Tracks staged before it stay staged; remove the later-stage projects with --remove, fix the cause, and re-run.`);
    }
  }

  if (spec.file) {
    const submittedAt = new Date(Date.now() - spec.file.daysAgo * 86_400_000).toISOString();
    for (const track of tracks) {
      // Re-read every time: markTrackSubmitted advances the project only when the record it is
      // handed says awaiting_human_submit, so a stale record would never advance.
      markTrackSubmitted(db, getProjectDetail(db, id).project, track as TrackType, {
        applicationNumber: `${spec.file.prefix}-${track.toUpperCase()}-${spec.file.seq}`,
        submittedBy: SIMULATED_BY,
        notes: `SIMULATED for the demo — no portal was contacted and nothing was filed with ${track === "nem" ? spec.utility : spec.ahj}. The number is invented.`,
        submittedAt,
      });
    }
  }

  for (const check of spec.statusChecks ?? []) {
    const target = db.get<Row>(
      "SELECT id FROM permit_check_targets WHERE project_id = ? AND permit_type = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1",
      [id, check.track],
    );
    if (!target) die(`(${spec.key}) no tracking target for the ${check.track} track — markTrackSubmitted should have created one.`);
    await recordPermitStatusCheck(db, id, { targetId: String(target.id), source: "manual", rawStatusText: check.text });
    const recorded = db.get<Row>("SELECT outcome FROM permit_status_checks WHERE project_id = ? AND target_id = ? ORDER BY created_at DESC LIMIT 1", [id, String(target.id)]);
    if (String(recorded?.outcome ?? "") !== check.outcome) {
      die(`(${spec.key}) "${check.text}" classified as ${String(recorded?.outcome ?? "nothing")}, expected ${check.outcome}. The status classifier changed; pick wording it reads as ${check.outcome}.`);
    }
  }
}

// ---- verdict -------------------------------------------------------------------------
const failures: string[] = [];
if (outbound.length) failures.push(`${outbound.length} outbound network attempt(s): ${outbound.slice(0, 5).join("; ")}`);

const jobsAfter = count("SELECT COUNT(*) AS n FROM job_queue");
if (jobsAfter !== jobsBefore) {
  const newJobs = db.query<Row>("SELECT job_type, status FROM job_queue ORDER BY created_at DESC LIMIT ?", [jobsAfter - jobsBefore]);
  failures.push(`${jobsAfter - jobsBefore} job(s) were enqueued (${newJobs.map((j) => `${j.job_type}:${j.status}`).join(", ")}); a seeding run must enqueue none — an enqueue self-starts the worker in this process.`);
}
const autopilotJobs = count("SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'autopilot'");
if (autopilotJobs) failures.push(`${autopilotJobs} autopilot job row(s) exist in job_queue.`);

// EVERY later-stage project is verified — the ones this run created AND the ones an earlier run
// left behind. A re-run used to print "already present — skipped" and exit 0 over a project that
// had been half-seeded (a run that died between two tracks) or clicked around since (a presenter
// capturing a confirmation moves (A) out of Submit), so the board could be wrong while the
// script said OK. Now a pre-existing project gets the same checks as a new one, plus the ones
// that tell half-done from done: every track staged, every filing numbered, every status read.
const verified = new Map<string, Spec>(createdIds);
for (const spec of SPECS) {
  const row = db.get<Row>("SELECT id FROM projects WHERE client_id = ? AND homeowner_name = ?", [clientId, spec.owner]);
  if (!row) { failures.push(`(${spec.key}) ${spec.owner} is not present after the run.`); continue; }
  verified.set(String(row.id), spec);
}
for (const [id, spec] of verified) {
  const was = createdIds.has(id) ? "" : " [seeded by an earlier run]";
  const project = getProjectDetail(db, id).project;
  if (String(project.ahj) !== spec.ahj || String(project.utility) !== spec.utility) {
    failures.push(`(${spec.key}) ${spec.owner}${was} is ${project.ahj} / ${project.utility}, intended ${spec.ahj} / ${spec.utility}.`);
  }
  const tracksNow = requiredTracks(project);
  if (tracksNow.join(",") !== spec.expectTracks.join(",")) {
    failures.push(`(${spec.key}) ${spec.owner}${was} requires tracks [${tracksNow.join(", ")}], intended [${spec.expectTracks.join(", ")}].`);
  }
  const submittal = new Map(getSubmittalTracks(db, project).map((t) => [String(t.type), t]));
  if (spec.stage) {
    const unstaged = spec.expectTracks.filter((t) => !submittal.get(t) || submittal.get(t)!.status === "not_started");
    if (unstaged.length) failures.push(`(${spec.key}) ${spec.owner}${was} has track(s) never staged: ${unstaged.join(", ")} — a half-seeded project.`);
  }
  if (spec.file) {
    for (const t of spec.expectTracks) {
      const want = `${spec.file.prefix}-${t.toUpperCase()}-${spec.file.seq}`;
      const got = String(submittal.get(t)?.applicationNumber ?? "");
      if (got !== want) failures.push(`(${spec.key}) ${spec.owner}${was} ${t} filing number is "${got || "none"}", intended ${want} — not recorded as filed.`);
    }
  }
  for (const check of spec.statusChecks ?? []) {
    const hit = count(
      `SELECT COUNT(*) AS n FROM permit_status_checks s JOIN permit_check_targets t ON t.id = s.target_id
        WHERE s.project_id = ? AND t.permit_type = ? AND s.outcome = ?`,
      [id, check.track, check.outcome],
    );
    if (!hit) failures.push(`(${spec.key}) ${spec.owner}${was} has no ${check.outcome} status reading on its ${check.track} track.`);
  }
  for (const run of db.query<Row>("SELECT id, permit_type, status, result_json FROM portal_runs WHERE project_id = ?", [id])) {
    let result: Record<string, unknown> = {};
    try { result = JSON.parse(String(run.result_json || "{}")); } catch { /* unreadable is a failure below */ }
    if (result.actor !== "MockPortalAdapter") failures.push(`(${spec.key}) portal run ${String(run.id).slice(0, 8)} (${run.permit_type}) was driven by ${String(result.actor ?? "an unrecorded actor")}, not MockPortalAdapter.`);
    if (result.finalSubmitClicked !== false) failures.push(`(${spec.key}) portal run ${String(run.id).slice(0, 8)} (${run.permit_type}) has finalSubmitClicked=${String(result.finalSubmitClicked)} — must be false.`);
  }
  const p = db.get<Row>("SELECT status, stage_detail FROM projects WHERE id = ?", [id]);
  const status = String(p?.status ?? "");
  const stageKey = stageForStatus(status as ProjectStatus).key;
  if (status !== spec.expect.status || stageKey !== spec.expect.stageKey) {
    failures.push(`(${spec.key}) ${spec.owner}${was} is at ${status} (column ${stageKey}), intended ${spec.expect.status} (column ${spec.expect.stageKey})${was ? " — it has moved since it was seeded; --remove and re-run to restore it" : ""}.`);
  }
  if (spec.expect.stageDetail && String(p?.stage_detail ?? "") !== spec.expect.stageDetail) {
    failures.push(`(${spec.key}) ${spec.owner}${was} stage_detail is ${String(p?.stage_detail ?? "")}, intended ${spec.expect.stageDetail}.`);
  }
  if (spec.key === "D") {
    const forms = count("SELECT COUNT(*) AS n FROM ahj_form_templates WHERE lower(ahj_name) = lower(?)", [spec.ahj]);
    if (forms) failures.push(`(D) ${spec.ahj} now has ${forms} stored form template(s) — the form-upload beat needs none on file.`);
    const gaps = stagingMissingDocuments(documentInventory(db, getProjectDetail(db, id).project), "combo");
    if (!gaps.length) failures.push(`(D) the staging document gate reports nothing missing for ${spec.ahj} — the form-upload beat needs the AHJ's form to be visibly absent.`);
  }
}

// ---- summary ----------------------------------------------------------------------------
console.log("\nLater-stage demo projects:");
for (const spec of SPECS) {
  const row = db.get<Row>("SELECT id FROM projects WHERE client_id = ? AND homeowner_name = ?", [clientId, spec.owner]);
  if (!row) { console.log(`  (${spec.key}) ${spec.owner}: not present`); continue; }
  const id = String(row.id);
  const detail = getProjectDetail(db, id);
  const status = detail.project.status;
  const stage = stageForStatus(status);
  const docs = count("SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ?", [id]);
  const qc = { pass: 0, warning: 0, fail: 0 } as Record<string, number>;
  for (const r of detail.qcResults) qc[r.qcStatus] = (qc[r.qcStatus] ?? 0) + 1;
  const tracks = getSubmittalTracks(db, detail.project).map((t) => `${t.type}=${t.status}${t.applicationNumber ? `(${t.applicationNumber})` : ""}`);
  const fresh = createdIds.has(id) ? "" : "  [pre-existing — re-verified]";
  const stageDetail = String(db.get<Row>("SELECT stage_detail FROM projects WHERE id = ?", [id])?.stage_detail ?? "");
  console.log(`  (${spec.key}) ${spec.owner.padEnd(14)} ${id.slice(0, 8)}  status=${status}  stage_detail=${stageDetail}  column=${stage.index + 1} · ${stage.label} (${stage.key})${fresh}`);
  console.log(`        tracks: ${tracks.join("  ")}`);
  console.log(`        documents: ${docs}   QC pass/warn/fail: ${qc.pass ?? 0}/${qc.warning ?? 0}/${qc.fail ?? 0}`);
}

const kbChanged = db.query<Row>("SELECT * FROM permit_utility_knowledge").filter((r) => kbBefore.get(String(r.id)) !== JSON.stringify(r));
// Written by the product's own learning hooks on the paths above: createProject/updates
// (learnFromProject) and every status check (learnFromPermitStatus — a NEM check keys its row
// by the utility's name in the ahj column). Shared tables carry no project_id, so --reset
// leaves these behind. Listed so nobody has to discover them.
console.log(`\nShared knowledge base rows this run changed (permit_utility_knowledge, confidence 'learned'): ${kbChanged.length}`);
for (const r of kbChanged) console.log(`  ${kbBefore.has(String(r.id)) ? "updated" : "added  "} ${String(r.ahj || "")} / ${String(r.utility || "")} [${String(r.confidence || "")}]`);
console.log(`Outbound network attempts: ${outbound.length}.  Jobs enqueued: ${jobsAfter - jobsBefore}.  Portal runs created: ${[...createdIds.keys()].reduce((n, id) => n + count("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [id]), 0)} (all must be MockPortalAdapter).`);

db.close();
if (failures.length) {
  console.error("\n[demo-later-stages] FAILED — the demo database is NOT in the intended state:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nOK: ${createdIds.size} project(s) created, ${verified.size - createdIds.size} pre-existing re-verified; all ${verified.size} at their intended stage, every staging run was the mock, nothing left the machine.`);
process.exit(0);
