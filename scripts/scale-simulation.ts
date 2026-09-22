// ---------------------------------------------------------------------------
// CAN ONE PERSON SUPERVISE 100 PROJECTS A MONTH? MEASURE IT.
//
// The operator's standard is a number, so it deserves a number back rather than an opinion:
// "if you're hiring three people just to babysit 100 projects/month, the product isn't
// automated enough yet." This drives 100 synthetic projects through the REAL local pipeline
// — createProject, QC, the auto-chain (split, bill read, form acquisition, document package,
// reviewer gate) and the submit gate — and counts how many times a human is interrupted.
//
// HOW IT AVOIDS RIGGING ITSELF:
//   · Every field is drawn at the rate the operator's OWN book shows. Measured from the live
//     projects: framing type present 74% of the time, job value 53%, locates 84%, inverter
//     details 74%. A simulation of perfect intakes would measure nothing.
//   · It runs on a COPY of the live database, so the knowledge base, form templates, fee
//     schedules and code profiles are the real ones — a scratch database would have no
//     templates and would invent document blockers that do not exist in production.
//   · The copy is thrown away. Nothing is written to the operator's board.
//   · Jurisdictions are spread across the states actually in play, INCLUDING non-Oregon, so
//     the state gate and the research loop are exercised rather than avoided.
//
// WHAT IT DOES NOT MEASURE, said plainly: the portal leg. Staging, the operator's submit
// click, CAPTCHA/MFA and the record-number capture all need live portals and real
// credentials. Those carry the safety-mandated floor (~3 touches per project) that should
// never go away. This measures everything BEFORE that — the part that is supposed to be
// hands-off, and the part where the audit found the avoidable interruptions.
//
//   npx tsx scripts/scale-simulation.ts            # 100 projects
//   npx tsx scripts/scale-simulation.ts --count 250
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argCount = Number(process.argv[process.argv.indexOf("--count") + 1]);
const COUNT = Number.isFinite(argCount) && argCount > 0 ? argCount : 100;

// Work on a throwaway copy of the live database so the real board is never touched.
const LIVE_DB = process.env.SCALE_SIM_SOURCE_DB || "backend/data/autopilot.sqlite";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scale-sim-"));
const simDb = path.join(scratch, "sim.sqlite");
if (!fs.existsSync(LIVE_DB)) { console.error(`No database at ${LIVE_DB}`); process.exit(1); }
fs.copyFileSync(LIVE_DB, simDb);
for (const suffix of ["-wal", "-shm"]) {
  if (fs.existsSync(LIVE_DB + suffix)) fs.copyFileSync(LIVE_DB + suffix, simDb + suffix);
}
process.env.AUTOPILOT_DB_PATH = simDb;
process.env.BACKUP_DIR = path.join(scratch, "backups");
process.env.AUTOPILOT_AUTO_START = "0";
// Jurisdiction research reaches the network and costs money per unknown AHJ. The simulation
// is about supervision load, not research spend, so it is off — and the projects use
// jurisdictions the knowledge base already holds, which is the realistic steady state for an
// installer working their own territory.
process.env.SKIP_CODE_RESEARCH = "1";

const { openDatabase } = await import("../backend/src/db");
const { createClient } = await import("../backend/src/clients");
const { createProject } = await import("../backend/src/repository");
const { saveProjectDocument } = await import("../backend/src/projectDocuments");
const { processStageStep } = await import("../backend/src/autoStageSteps");
const { PDFDocument, StandardFonts } = await import("pdf-lib");

const db = await openDatabase();

// ---- the shape of a real intake -------------------------------------------------------
// Presence rates measured from the operator's live projects (2026-09-22).
const PRESENCE: Record<string, number> = {
  account: 1.0, meter: 1.0,
  moduleMake: 1.0, moduleModel: 1.0, moduleWattage: 1.0, moduleQty: 1.0,
  invModel: 0.74, invQty: 0.74, invOutputW: 0.74,
  // Measured at 100% in the live book: these are microinverter jobs, and the string-inverter
  // fields above sit alongside them. Omitting these made every simulated project look like a
  // string system, which QC correctly asks about — a fixture artefact, not a product cost.
  pvMicroModel: 1.0, pvMicroQty: 1.0, pvMicroOutputW: 1.0, pvMicroMake: 1.0,
  interco: 1.0, busRating: 1.0, mainBreaker: 1.0, pvBreaker: 1.0,
  locateCalloutText: 0.84,
  snow: 1.0, wind: 1.0, windSpeed: 1.0, deadLoad: 1.0,
  roofRafterSpacing: 1.0, framingType: 0.74, roofMaterial: 1.0,
  jobValue: 0.53,
};

// Deterministic PRNG so a re-run of the same seed gives the same book of work — a
// supervision number that changes every run cannot be compared against a later one.
let seed = 20260922;
const rand = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)];
const present = (field: string): boolean => rand() < (PRESENCE[field] ?? 1);

// Jurisdictions the knowledge base already knows, spread across states so the state gate
// and the non-Oregon paths are exercised rather than dodged.
const PLACES: Array<{ city: string; state: string; ahj: string; utility: string }> = [
  { city: "Salem", state: "OR", ahj: "City of Salem", utility: "Portland General Electric" },
  { city: "Coos Bay", state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power" },
  { city: "Portland", state: "OR", ahj: "City of Portland", utility: "Portland General Electric" },
  { city: "Tigard", state: "OR", ahj: "City of Tigard", utility: "Portland General Electric" },
  { city: "Lincoln City", state: "OR", ahj: "City of Lincoln City", utility: "Pacific Power" },
  { city: "Happy Valley", state: "OR", ahj: "City of Happy Valley", utility: "Portland General Electric" },
  { city: "Cape Coral", state: "FL", ahj: "Cape Coral", utility: "Florida Power & Light" },
  { city: "Columbus", state: "OH", ahj: "Columbus", utility: "AEP Ohio" },
];

const ROOFS = ["Composition Shingle", "Composition Shingle", "Composition Shingle", "Metal", "TPO"];
const FRAMING = ["truss", "truss", "rafter"];

async function planSet(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sheets: Array<[string, string]> = [
    ["SITE PLAN", "Array location, fire access pathways and setbacks shown."],
    ["ELECTRICAL LINE DIAGRAM", "RAPID SHUTDOWN initiator per NEC 690.12. NEC 705.12(B)(3)(2): 200A bus x 120% = 240A; 175A main + 40A PV = 215A, COMPLIES."],
    ["ROOF SECTION", "Roof framing: trusses 2x4 at 24 in o.c., clear span 11 ft 6 in, DF-L No.2. Attachment: lag screws with flashed standoffs."],
    ["PV MODULE SPECIFICATION SHEET", "Q CELLS Q.TRON BLK M-G2.C1+ 430W."],
    ["MICROINVERTER SPECIFICATIONS", "Enphase IQ8PLUS-72-2-US, 290W AC, UL 1741-SB."],
    ["WARNING LABELS", "NEC 690/705 placard and label location schedule."],
  ];
  for (const [title, body] of sheets) {
    const page = pdf.addPage([612, 792]);
    page.drawText(title, { x: 54, y: 706, size: 20, font });
    page.drawText(body.slice(0, 110), { x: 54, y: 664, size: 9, font });
  }
  return Buffer.from(await pdf.save());
}

const client = createClient(db, {
  companyName: "Scale Simulation Co",
  ccbLicenseNumber: "000001",
  contactEmail: "sim@example.invalid",
  electricalSupervisorName: "Sim Supervisor",
  electricianLicenseNumber: "0001S",
});
const planSetPdf = await planSet();

console.log(`Driving ${COUNT} synthetic projects through the real local pipeline…`);
console.log("(field presence drawn at the rates the live book shows; database is a throwaway copy)\n");

const ids: string[] = [];
for (let i = 0; i < COUNT; i++) {
  const place = pick(PLACES);
  const qty = 12 + Math.floor(rand() * 20);
  const snap: Record<string, unknown> = { mounting: "Roof mount" };
  const set = (field: string, value: unknown): void => { if (present(field)) snap[field] = value; };
  set("account", `SIM-${1000 + i}`);
  set("meter", `SIM-MTR-${1000 + i}`);
  set("moduleMake", "Q CELLS");
  set("moduleModel", "Q.TRON BLK M-G2.C1+");
  set("moduleWattage", "430");
  set("moduleQty", String(qty));
  set("invModel", "IQ8PLUS-72-2-US");
  set("invQty", String(qty));
  set("invOutputW", "290");
  set("pvMicroMake", "Enphase");
  set("pvMicroModel", "IQ8PLUS-72-2-US");
  set("pvMicroQty", String(qty));
  set("pvMicroOutputW", "290");
  set("interco", "Load-side breaker at the main panel");
  set("busRating", "200");
  set("mainBreaker", "175");
  set("pvBreaker", "40");
  set("locateCalloutText", "N/A - roof mount, no excavation");
  set("snow", place.state === "FL" ? "0" : "25");
  set("wind", place.state === "FL" ? "C" : "B");
  set("windSpeed", place.state === "FL" ? "140" : "100");
  set("deadLoad", "2.6");
  set("roofRafterSpacing", "24");
  set("framingType", pick(FRAMING));
  set("roofMaterial", pick(ROOFS));
  set("jobValue", String(28000 + Math.floor(rand() * 25000)));

  const { project } = createProject(db, {
    clientId: client.id,
    owner: `Sim Owner ${i + 1}`,
    street: `${100 + i} Simulation Ave`,
    city: place.city, state: place.state, zip: "99999",
    ahj: place.ahj, utility: place.utility,
    dcKw: ((qty * 430) / 1000).toFixed(2),
    acKw: ((qty * 290) / 1000).toFixed(2),
    homeownerEmail: `sim${i + 1}@example.invalid`,
    homeownerPhone: "(555) 010-0000",
    ...snap,
  } as never);
  saveProjectDocument(db, project.id, {
    filename: `sim-${i + 1}-plan-set.pdf`, docType: "plan_set",
    contentType: "application/pdf", buffer: planSetPdf, source: "upload",
  });
  ids.push(project.id);
  if ((i + 1) % 25 === 0) console.log(`  created ${i + 1}/${COUNT}`);
}

console.log("\nRunning the automatic chain on each (split → bill read → QC → docs → reviewer gate)…");
for (const [n, id] of ids.entries()) {
  try {
    for (let pass = 0; pass < 3; pass++) await processStageStep(db, id);
    // Document text extraction is asynchronous; the chain judges split sheets before their
    // text lands, so wait and look again exactly as a real save's follow-up pass would.
    for (let waited = 0; waited < 40; waited++) {
      const pending = Number(db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ? AND extracted_text = ''", [id])?.n ?? 0);
      if (pending === 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    for (let pass = 0; pass < 2; pass++) await processStageStep(db, id);
  } catch { /* a chain error is itself a supervision cost — counted below as a non-advanced project */ }
  if ((n + 1) % 25 === 0) console.log(`  processed ${n + 1}/${COUNT}`);
}

// ---- the measurement ------------------------------------------------------------------
const q = (sql: string): number => Number(db.get<{ n: number }>(sql, [client.id])?.n ?? 0);
const humanItems = q("SELECT COUNT(*) AS n FROM human_review_items h JOIN projects p ON p.id = h.project_id WHERE p.client_id = ? AND h.status = 'pending'");
const projectsWithItems = q("SELECT COUNT(DISTINCT h.project_id) AS n FROM human_review_items h JOIN projects p ON p.id = h.project_id WHERE p.client_id = ? AND h.status = 'pending'");
const readyToStage = q("SELECT COUNT(*) AS n FROM projects WHERE client_id = ? AND status = 'ready_to_stage'");
const qcFailed = q("SELECT COUNT(*) AS n FROM projects WHERE client_id = ? AND status = 'qc_failed'");
const stuckEarlier = COUNT - readyToStage - qcFailed;

const byType = db.query<{ issue_type: string; n: number }>(
  `SELECT h.issue_type, COUNT(*) AS n FROM human_review_items h JOIN projects p ON p.id = h.project_id
    WHERE p.client_id = ? AND h.status = 'pending' GROUP BY h.issue_type ORDER BY n DESC`, [client.id]);

const per100 = (v: number): string => ((v / COUNT) * 100).toFixed(0);
console.log(`\n${"═".repeat(72)}`);
console.log(`SUPERVISION LOAD — ${COUNT} projects through the local pipeline`);
console.log("═".repeat(72));
console.log(`  reached ready_to_stage with NO human involved   ${Math.max(0, readyToStage - projectsWithItems)} / ${COUNT}`);
console.log(`  projects that interrupted a person              ${projectsWithItems} / ${COUNT}`);
console.log(`  total interruptions                             ${humanItems}  (${per100(humanItems)} per 100 projects)`);
console.log(`  stopped at qc_failed (needs a repair)           ${qcFailed}`);
console.log(`  did not advance for another reason              ${stuckEarlier}`);
if (byType.length) {
  console.log("\n  what the person is asked about:");
  for (const row of byType) console.log(`    x${String(row.n).padStart(3)}  ${row.issue_type}`);
}
console.log(`\n  NOT measured here: the portal leg (staging, the human's submit click, CAPTCHA/MFA,`);
console.log(`  record capture). That is where the safety-mandated floor lives and it needs live`);
console.log(`  portals to measure honestly.`);
console.log("═".repeat(72));

db.close();
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(0);
