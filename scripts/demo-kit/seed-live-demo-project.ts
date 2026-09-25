// ---------------------------------------------------------------------------
// TWO TEST PROJECTS FOR THE SUPERVISED, MASKED PGE RECORDING SESSION.
//
// Operator ruling (docs/HANDOFF.md, 2026-09-24): a supervised run on PGE's live PowerClerk with
// clearly test-labelled homeowner data is authorised for the masked demo video. The session has
// two beats — a human-driven RECORDED capture on project A (npm run portal:record), then the bot
// REPLAYS the captured recipe for project B and stops at the review screen. This seeds A and B.
//
// WHAT IT DOES
//   · Creates both projects through the product's REAL creation path — the same createProject()
//     POST /api/projects calls, with the route's client guard replicated — so QC, the parser
//     snapshot and the field bindings are exactly what a real intake produces. No raw SQL.
//   · Flags both learning_excluded (a demo project never teaches the shared knowledge base;
//     written in the INSERT so even the birth learn skips it).
//   · Attaches the four documents PGE's Net Metering form asks for (one-line diagram, site plan,
//     inverter spec, cut sheets) as generated PDFs headed "DEMO TEST — NOT A REAL DOCUMENT".
//     Each is a few KB (PGE's per-file cap is 5.00 MB). No engineering content, no names.
//   · Queues NOTHING. Every automatic research / staging trigger is switched off on this process
//     with the product's own switches (CODE_RESEARCH=off, FEE_RESEARCH=off, AUTOPILOT_AUTO_START=0,
//     AUTO_STAGE_STEPS=0, …), the stage_step chain the route would enqueue is deliberately not
//     enqueued, and after creation the job_queue is AUDITED: a research, learn or staging job for
//     either project (or any research job created during the run) fails the seed with exit 1.
//
// WHAT IT NEVER DOES: open a portal, send a request, read a credential, or write to a database
// that was not named. --apply refuses when AUTOPILOT_DB_PATH is unset (db.ts would otherwise
// default to backend/data/autopilot.sqlite — production — relative to the cwd). --dry-run opens
// no database at all (openDatabase migrates, which is a write).
//
// VALUES. Homeowner "DEMO TEST HOMEOWNER A" / "B"; phone (503) 555-01xx and email @example.com
// (reserved, cannot reach a person); the account and meter numbers are the OPERATOR'S to supply
// (--account-a/--meter-a/--account-b/--meter-b): the July capture shows no server-side lookup
// and every autosave answered success, but acceptance of a made-up account is UNVERIFIED —
// HANDOFF's fallback (a real unfiled project's numbers, masked on screen) is the operator's call.
// System: 7.2 kW DC / 18 modules for A, 6.4 kW DC / 16 for B — every tripwire dimension differs
// between the two so the replay for B demonstrably carries B's own data — a CEC-listed module and
// microinverter (verified against cec_equipment 2026-09-24), 200 A main, 40 A backfeed, no
// battery, export ≤ 25 kW AC so the PGE review shows Tier 1 / Application Fee $0.00.
// Schedule: "Schedule 7" (the residential schedule the July learn bound) — replay B once reached
// review with Schedule blank because the project carried no value.
//
// USAGE (repo root; AUTOPILOT_DB_PATH names the database on purpose — the operator points it at
// production for the session and nowhere else):
//   npx tsx scripts/demo-kit/seed-live-demo-project.ts --dry-run [--address "…"] …
//   AUTOPILOT_DB_PATH=backend/data/autopilot.sqlite npx tsx scripts/demo-kit/seed-live-demo-project.ts --apply \
//       --account-a 1234567890 --meter-a A12345678 --account-b 2345678901 --meter-b B23456789 \
//       [--address "1201 SW Demo Test Ln, Tigard, 97223"] [--address-b "1203 SW Demo Test Ln, Tigard, 97223"] \
//       [--client tml-international-llc] [--ahj "City of Tigard"] [--utility "Portland General Electric"] \
//       [--state OR] [--email-domain example.com]
// Cleanup afterwards: DELETE /api/projects/<id> (or scripts/archive-projects.ts) — see the
// runbook's "Live PGE recording session".
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { AppDb } from "../../backend/src/db";

export interface SeedAddress { street: string; city: string; zip: string }

export interface SeedOptions {
  clientId: string;
  ahj: string;
  utility: string;
  state: string;
  addressA: SeedAddress;
  addressB: SeedAddress;
  accountA: string;
  meterA: string;
  accountB: string;
  meterB: string;
  emailDomain: string;
}

export const DEFAULTS = {
  clientId: "tml-international-llc",
  ahj: "City of Tigard",
  // The legal name: the KB's seeded utility row, the NEM fee-schedule row and recipe 481c00f4 all
  // key on it, and the alias bridge resolves "PGE" to it. Pass the SAME string to portal:record.
  utility: "Portland General Electric",
  state: "OR",
  addressA: { street: "1201 SW Demo Test Ln", city: "Tigard", zip: "97223" } as SeedAddress,
  addressB: { street: "1203 SW Demo Test Ln", city: "Tigard", zip: "97223" } as SeedAddress,
  emailDomain: "example.com",
};

export const HOMEOWNER = { A: "DEMO TEST HOMEOWNER A", B: "DEMO TEST HOMEOWNER B" } as const;
export type Variant = keyof typeof HOMEOWNER;

/** The document slots PGE's Net Metering form asks for (both PGE recipes carry exactly these). */
export const DOC_SLOTS: ReadonlyArray<{ docType: string; label: string }> = [
  { docType: "sld", label: "One-Line Electrical Diagram" },
  { docType: "site_plan", label: "Site Plan" },
  { docType: "inverter_spec", label: "Inverter Technical Specifications" },
  { docType: "module_spec", label: "Cut Sheets" },
];

/** Job types that must NOT exist for a demo project after seeding (research, learn, staging). */
export const FORBIDDEN_JOB_TYPES = ["code_research", "fee_research", "design_criteria_research", "auto_learn", "autopilot", "prepare_submission", "stage_step"] as const;

/**
 * The product's own switches, set on THIS process before the backend loads: no automatic
 * research, no auto staging, no notifications, no LLM. Exported so the test can assert the
 * seeder applies them rather than relying on the shell.
 */
export function applyDemoSeedEnv(env: NodeJS.ProcessEnv = process.env): void {
  env.CODE_RESEARCH = "off";
  env.FEE_RESEARCH = "off";
  env.AUTOPILOT_AUTO_START = "0";
  env.AUTO_STAGE_STEPS = "0";
  env.AUTO_RELEARN_STALE = "0";
  env.CLIENT_NOTIFICATIONS = "off";
  env.BACKGROUND_WORKERS = "off";
  env.DOCUMENT_FETCH = "off";
  env.AHJ_FORM_DOWNLOADS = "off";
  env.AHJ_FORM_RESEARCH = "off";
  env.PORTAL_URL_RESEARCH = "off";
  env.RUN_TRIAGE = "off";
  env.PORTAL_AUTOSEED = "0";
  env.SEED_TEST_INSTALLER = "false";
  for (const k of Object.keys(env)) if (/^(ANTHROPIC|OPENAI|CLAUDE)_/i.test(k)) delete env[k];
}

/** PGE's help text: "Enter the 10-digit PGE account number as it appears on the customer's PGE bill." */
export function accountProblem(value: string, which: string): string | null {
  const v = String(value ?? "").replace(/[\s-]/g, "");
  if (!v) return `--account-${which} is required with --apply (PGE's form requires an account number; the operator supplies it)`;
  if (!/^\d{10}$/.test(v)) return `--account-${which} must be 10 digits (PGE's form: "the 10-digit PGE account number as it appears on the customer's PGE bill"); got ${v.length} character(s)`;
  return null;
}

export function meterProblem(value: string, which: string): string | null {
  const v = String(value ?? "").trim();
  if (!v) return `--meter-${which} is required with --apply (PGE's form requires a meter number; the operator supplies it)`;
  if (!/^[A-Za-z0-9-]{4,20}$/.test(v)) return `--meter-${which} must be 4-20 letters/digits with no spaces`;
  return null;
}

/** "street, city, zip" → parts; city/zip fall back to the default when omitted. */
export function parseAddress(text: string | undefined, fallback: SeedAddress): SeedAddress {
  const raw = String(text ?? "").trim();
  if (!raw) return { ...fallback };
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const street = parts[0] ?? "";
  if (!street) return { ...fallback };
  let city = fallback.city;
  let zip = fallback.zip;
  for (const p of parts.slice(1)) {
    if (/^\d{5}(-\d{4})?$/.test(p)) zip = p.slice(0, 5);
    else if (!/^[A-Z]{2}$/.test(p)) city = p;
  }
  return { street, city, zip };
}

/** Every reason the options cannot be applied. Empty means proceed. */
export function optionProblems(o: SeedOptions): string[] {
  const out: string[] = [];
  for (const [which, acc, met] of [["a", o.accountA, o.meterA], ["b", o.accountB, o.meterB]] as const) {
    const a = accountProblem(acc, which); if (a) out.push(a);
    const m = meterProblem(met, which); if (m) out.push(m);
  }
  const clean = (s: string) => String(s ?? "").replace(/[\s-]/g, "").toLowerCase();
  if (clean(o.accountA) && clean(o.accountA) === clean(o.accountB)) out.push("--account-a and --account-b must differ: B's replay must demonstrably carry B's own data");
  if (clean(o.meterA) && clean(o.meterA) === clean(o.meterB)) out.push("--meter-a and --meter-b must differ");
  if (o.addressA.street.trim().toLowerCase() === o.addressB.street.trim().toLowerCase()) out.push("--address and --address-b must be different streets");
  if (!o.clientId.trim()) out.push("--client is required");
  if (!o.ahj.trim() || !o.utility.trim() || !/^[A-Z]{2}$/.test(o.state)) out.push("--ahj, --utility and a 2-letter --state are required");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(o.emailDomain) || /\.invalid$/i.test(o.emailDomain)) {
    out.push("--email-domain must be a real-looking domain (PowerClerk's platform silently dropped a .invalid address server-side on PacifiCorp, 2026-08-30)");
  }
  return out;
}

interface SystemSpec {
  moduleQty: number; moduleWattage: number; inverterQty: number; inverterWattage: number;
  tilt: string; azimuth: string; jobValue: string; phone: string; emailLocal: string;
}
const SYSTEM: Record<Variant, SystemSpec> = {
  // 18 × 400 W = 7.2 kW DC; 18 × IQ8PLUS at 290 W = 5.22 kW AC (DC:AC 1.38, ordinary).
  A: { moduleQty: 18, moduleWattage: 400, inverterQty: 18, inverterWattage: 290, tilt: "22", azimuth: "180", jobValue: "24800", phone: "(503) 555-0101", emailLocal: "demo.test.homeowner.a" },
  // 16 × 400 W = 6.4 kW DC; 16 × IQ8PLUS at 290 W = 4.64 kW AC. Differs from A in every
  // tripwire dimension (name, street, phone, email, account, meter, size, count, value).
  B: { moduleQty: 16, moduleWattage: 400, inverterQty: 16, inverterWattage: 290, tilt: "27", azimuth: "195", jobValue: "22300", phone: "(503) 555-0102", emailLocal: "demo.test.homeowner.b" },
};

/** The parser-shaped payload createProject takes (normalize.ts keys + the snapshot extras the
 *  recipe bindings read). Both alias spellings are given where the snapshot is read by exact key. */
export function demoProjectPayload(variant: Variant, o: SeedOptions): Record<string, unknown> {
  const s = SYSTEM[variant];
  const addr = variant === "A" ? o.addressA : o.addressB;
  const dcKw = (s.moduleQty * s.moduleWattage) / 1000;
  const acKw = (s.inverterQty * s.inverterWattage) / 1000;
  const owner = HOMEOWNER[variant];
  const email = `${s.emailLocal}@${o.emailDomain}`;
  const description = `Roof-mounted solar PV, ${dcKw} kW DC, ${s.moduleQty} modules, ${s.inverterQty} microinverters (DEMO TEST project — never submitted)`;
  return {
    clientId: o.clientId,
    owner, homeownerName: owner, ubAccountHolder: owner,
    street: addr.street, city: addr.city, state: o.state, zip: addr.zip,
    ahj: o.ahj, utility: o.utility,
    homeownerEmail: email, homeownerPhone: s.phone,
    account: variant === "A" ? o.accountA : o.accountB,
    meter: variant === "A" ? o.meterA : o.meterB,
    accountType: "Residential",
    // The PGE "Schedule" select: recipe 481c00f4 binds pgeSchedule, the July learn bound
    // utilitySchedule — both spellings, the same residential schedule.
    pgeSchedule: "Schedule 7", utilitySchedule: "Schedule 7",
    dcKw: String(dcKw), acKw: String(acKw), exportKw: String(acKw),
    interco: "NEM", interconnectionMethod: "NEM",
    phase: "Single Phase", voltage: "240", serviceVoltage: "240", serviceType: "Overhead",
    energySource: "Solar", generationTechnology: "Photovoltaic",
    mainServiceRating: "200", busRating: "200", mainBreaker: "200", pvBreaker: "40",
    hasBattery: "No", exportLimiting: "No",
    moduleMake: "Qcells North America", moduleManufacturer: "Qcells North America",
    moduleModel: "Q.PEAK DUO BLK ML-G10+ 400",
    moduleWattage: String(s.moduleWattage), moduleQty: String(s.moduleQty), moduleQuantity: String(s.moduleQty),
    invMake: "Enphase Energy, Inc.", inverterMake: "Enphase Energy, Inc.", inverterManufacturer: "Enphase Energy, Inc.",
    invModel: "IQ8PLUS-72-2-US", inverterModel: "IQ8PLUS-72-2-US",
    invQty: String(s.inverterQty), inverterQty: String(s.inverterQty), inverterQuantity: String(s.inverterQty),
    invOutputW: String(s.inverterWattage), inverterWattage: String(s.inverterWattage),
    mountType: "roof", racking: "IronRidge XR100", tilt: s.tilt, azimuth: s.azimuth,
    pvArrays: [{ quantity: s.moduleQty, moduleManufacturer: "Qcells North America", moduleModel: "Q.PEAK DUO BLK ML-G10+ 400", moduleWattage: s.moduleWattage, tilt: Number(s.tilt), azimuth: Number(s.azimuth) }],
    permitPath: "prescriptive", framingType: "rafter", roofRafterSpacing: "24", roofRafterSpan: "11.5",
    snow: "25", deadLoad: "3.0", wind: "B",
    jobValue: s.jobValue, projectValuation: s.jobValue,
    description, workDescription: description,
    demoTest: true,
  };
}

/** A PDF that cannot be mistaken for a real document and names no one. */
export async function demoPlaceholderPdf(slotLabel: string, variant: Variant, stamp: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const red = rgb(0.75, 0.1, 0.1);
  page.drawText("DEMO TEST", { x: 54, y: 700, size: 40, font: bold, color: red });
  page.drawText("NOT A REAL DOCUMENT", { x: 54, y: 660, size: 24, font: bold, color: red });
  const lines = [
    "", `Stands in for: ${slotLabel}`, `Test project: ${HOMEOWNER[variant]}`, "",
    "This page was generated for a supervised, masked product demonstration.",
    "It contains no engineering content, no customer information and no design.",
    "The application it is attached to is a test draft; it is never submitted,",
    "no fee is paid, and the operator deletes the draft afterwards.", "",
    "If you are reading this on a real submission, something has gone wrong:",
    "please discard the draft and tell the operator.", "", `Generated ${stamp}`,
  ];
  let y = 620;
  for (const line of lines) {
    if (line) page.drawText(line, { x: 54, y, size: 11, font: body, color: rgb(0.15, 0.15, 0.15) });
    y -= 18;
  }
  return Buffer.from(await doc.save());
}

export interface SeededProject {
  label: Variant;
  id: string;
  homeownerName: string;
  status: string;
  documents: Array<{ docType: string; path: string }>;
}
export interface SeedAudit {
  learningExcluded: boolean;
  jobsForProjects: number;
  researchJobsCreatedDuringRun: number;
  knowledgeEventsForProjects: number;
  problems: string[];
}
export interface SeedResult { projects: SeededProject[]; audit: SeedAudit }

/** Seed A and B into an OPEN database through the real creation path, then audit. */
export async function seedLiveDemoProjects(db: AppDb, o: SeedOptions): Promise<SeedResult> {
  applyDemoSeedEnv();
  const problems = optionProblems(o);
  if (problems.length) throw new Error(problems.join("\n"));

  // The route's guard, replicated: a project may not be born without a client that exists.
  const client = db.get<{ id: string; org_id: string }>("SELECT id, org_id FROM clients WHERE id = ?", [o.clientId]);
  if (!client) throw new Error(`No client "${o.clientId}" exists in this database. Pass --client <id> of the client the session files for.`);
  const existing = db.query<{ id: string; homeowner_name: string }>(
    "SELECT id, homeowner_name FROM projects WHERE client_id = ? AND homeowner_name IN (?, ?)", [o.clientId, HOMEOWNER.A, HOMEOWNER.B]);
  if (existing.length) {
    throw new Error(`Demo test project(s) already exist for ${o.clientId}: ${existing.map((r) => `${r.id} (${r.homeowner_name})`).join(", ")}. Delete them first (DELETE /api/projects/<id>) — this seeder never reuses a row.`);
  }

  const { createProject } = await import("../../backend/src/repository");
  const { saveProjectDocument } = await import("../../backend/src/projectDocuments");
  const startedAt = new Date().toISOString();
  const stamp = startedAt.slice(0, 16).replace("T", " ") + " UTC";
  const projects: SeededProject[] = [];
  for (const variant of ["A", "B"] as Variant[]) {
    const created = createProject(db, demoProjectPayload(variant, o), String(client.org_id || "org-default"), { learningExcluded: true });
    const pid = created.project.id;
    const documents: SeededProject["documents"] = [];
    for (const slot of DOC_SLOTS) {
      const view = saveProjectDocument(db, pid, {
        docType: slot.docType,
        filename: `demo-test-${variant.toLowerCase()}-${slot.docType.replace(/_/g, "-")}.pdf`,
        contentType: "application/pdf",
        buffer: await demoPlaceholderPdf(slot.label, variant, stamp),
        source: "upload",
        uploadedBy: "seed-live-demo-project",
      });
      const row = db.get<{ stored_path: string }>("SELECT stored_path FROM project_documents WHERE id = ?", [view.id]);
      documents.push({ docType: slot.docType, path: String(row?.stored_path ?? "") });
    }
    const status = String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid])?.status ?? "");
    projects.push({ label: variant, id: pid, homeownerName: HOMEOWNER[variant], status, documents });
  }

  // Every research trigger is asynchronous (a dynamic import, then an enqueue on a macrotask).
  // Let them settle before the audit says "nothing was queued".
  await new Promise((r) => setTimeout(r, 400));
  const ids = projects.map((p) => p.id);
  const ph = ids.map(() => "?").join(",");
  const n = (sql: string, params: Array<string | number>) => Number(db.get<{ n: number }>(sql, params)?.n ?? 0);
  // SCOPED to what this seed could have caused: a job FOR one of the two projects, or a research
  // job for their jurisdiction/utility created during the run (code_research and
  // design_criteria_research carry no project_id — they name the AHJ and state in their payload).
  // Never DB-wide: on production the server's worker is live, and another operator's stage_step
  // or fee_research landing in this window is not this seed's doing.
  const typeList = FORBIDDEN_JOB_TYPES.map(() => "?").join(",");
  const audit: SeedAudit = {
    learningExcluded: n(`SELECT COUNT(*) AS n FROM projects WHERE id IN (${ph}) AND learning_excluded = 1`, ids) === ids.length,
    jobsForProjects: n(`SELECT COUNT(*) AS n FROM job_queue WHERE project_id IN (${ph})`, ids),
    researchJobsCreatedDuringRun: n(
      `SELECT COUNT(*) AS n FROM job_queue WHERE job_type IN (${typeList}) AND created_at >= ?
         AND (project_id IN (${ph}) OR payload LIKE ? OR payload LIKE ?)`,
      [...FORBIDDEN_JOB_TYPES, startedAt, ...ids, `%${JSON.stringify(o.ahj)}%`, `%${JSON.stringify(o.utility)}%`],
    ),
    knowledgeEventsForProjects: n(`SELECT COUNT(*) AS n FROM knowledge_events WHERE project_id IN (${ph})`, ids),
    problems: [],
  };
  if (!audit.learningExcluded) audit.problems.push("a project is NOT learning_excluded — it would teach the shared knowledge base");
  if (audit.jobsForProjects) audit.problems.push(`${audit.jobsForProjects} job(s) are queued for the test projects — nothing may run for a demo project`);
  if (audit.researchJobsCreatedDuringRun) audit.problems.push(`${audit.researchJobsCreatedDuringRun} research/learn/staging job(s) for the test projects' jurisdiction were created during the seed`);
  if (audit.knowledgeEventsForProjects) audit.problems.push(`${audit.knowledgeEventsForProjects} knowledge event(s) were written from the test projects`);
  return { projects, audit };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
function cliOptions(argv: string[]): SeedOptions {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  const addressA = parseAddress(arg("address"), DEFAULTS.addressA);
  const addressB = parseAddress(arg("address-b"), { ...DEFAULTS.addressB, city: addressA.city, zip: addressA.zip });
  return {
    clientId: arg("client") ?? DEFAULTS.clientId,
    ahj: arg("ahj") ?? DEFAULTS.ahj,
    utility: arg("utility") ?? DEFAULTS.utility,
    state: (arg("state") ?? DEFAULTS.state).toUpperCase(),
    addressA, addressB,
    accountA: arg("account-a") ?? "", meterA: arg("meter-a") ?? "",
    accountB: arg("account-b") ?? "", meterB: arg("meter-b") ?? "",
    emailDomain: arg("email-domain") ?? DEFAULTS.emailDomain,
  };
}

const maskDigits = (v: string): string => {
  const s = String(v ?? "");
  return s.length <= 2 ? "**" : "*".repeat(s.length - 2) + s.slice(-2);
};

function printPlan(o: SeedOptions, apply: boolean): void {
  console.log(`\n${apply ? "SEEDING" : "DRY RUN — no database opened, nothing written"}: two DEMO TEST projects for ${o.clientId}`);
  console.log(`  jurisdiction  ${o.ahj}, ${o.state}   utility ${JSON.stringify(o.utility)}  (pass the SAME --utility string to portal:record)`);
  for (const v of ["A", "B"] as Variant[]) {
    const p = demoProjectPayload(v, o);
    const acc = String(p.account ?? ""), met = String(p.meter ?? "");
    console.log(`  ${v}: ${HOMEOWNER[v]} — ${p.street}, ${p.city} ${p.state} ${p.zip}`);
    console.log(`     ${p.dcKw} kW DC / ${p.acKw} kW AC, ${p.moduleQty} x ${p.moduleModel}, ${p.inverterQty} x ${p.inverterModel}, 200 A main, 40 A backfeed, battery No, ${p.pgeSchedule}`);
    console.log(`     ${p.homeownerPhone}, ${p.homeownerEmail}; account ${acc ? maskDigits(acc) : "<operator supplies --account-" + v.toLowerCase() + ">"}; meter ${met ? maskDigits(met) : "<operator supplies --meter-" + v.toLowerCase() + ">"}`);
    console.log(`     documents: ${DOC_SLOTS.map((d) => d.docType).join(", ")} (generated, headed DEMO TEST — NOT A REAL DOCUMENT)`);
  }
  console.log("  learning_excluded: yes (both).  Jobs queued: none — no research, no auto learn, no staging chain.");
}

async function main(argv: string[]): Promise<number> {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run") || !apply;
  const o = cliOptions(argv);
  if (dryRun) {
    printPlan(o, false);
    const problems = optionProblems(o).filter((p) => !/--(account|meter)-[ab] is required/.test(p));
    if (problems.length) { for (const p of problems) console.log(`  ! ${p}`); return 2; }
    console.log("\nRe-run with --apply and AUTOPILOT_DB_PATH set to write.");
    return 0;
  }
  // BEFORE the backend loads: db.ts defaults an unset path to backend/data/autopilot.sqlite
  // (production, relative to the cwd), so the refusal is meaningless once openDatabase has run.
  const dbPath = String(process.env.AUTOPILOT_DB_PATH ?? "").trim();
  if (!dbPath) {
    console.error("[seed-live-demo] REFUSED: AUTOPILOT_DB_PATH is unset. Name the database deliberately (for the session: AUTOPILOT_DB_PATH=backend/data/autopilot.sqlite) — this script writes, and must never land somewhere by default.");
    return 2;
  }
  if (!fs.existsSync(path.resolve(process.cwd(), dbPath))) {
    console.error(`[seed-live-demo] REFUSED: no database at ${path.resolve(process.cwd(), dbPath)} — the seeder joins an existing database, it does not create one.`);
    return 2;
  }
  const problems = optionProblems(o);
  if (problems.length) { for (const p of problems) console.error(`[seed-live-demo] REFUSED: ${p}`); return 2; }
  applyDemoSeedEnv();
  printPlan(o, true);
  const { openDatabase } = await import("../../backend/src/db");
  const db = await openDatabase();
  try {
    const result = await seedLiveDemoProjects(db, o);
    console.log("");
    for (const p of result.projects) {
      console.log(`created ${p.label}: ${p.id}  (${p.homeownerName}, status ${p.status})`);
      for (const d of p.documents) console.log(`   ${d.docType.padEnd(14)} ${d.path}`);
    }
    console.log(`\nAUDIT  learning_excluded=${result.audit.learningExcluded}  jobsForProjects=${result.audit.jobsForProjects}  researchJobsCreatedDuringRun=${result.audit.researchJobsCreatedDuringRun}  knowledgeEvents=${result.audit.knowledgeEventsForProjects}`);
    if (result.audit.problems.length) {
      for (const p of result.audit.problems) console.error(`[seed-live-demo] AUDIT FAILED: ${p}`);
      console.error("The rows above exist; delete them (DELETE /api/projects/<id>) before the session.");
      return 1;
    }
    console.log("\nNext: docs/DEMO_RUNBOOK.md → \"Live PGE recording session\" (beat 1 records on A with the documents listed above; beat 2 replays for B).");
    return 0;
  } catch (err) {
    console.error(`[seed-live-demo] REFUSED: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

const invokedAs = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() : "";
if (invokedAs === import.meta.url.toLowerCase()) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
