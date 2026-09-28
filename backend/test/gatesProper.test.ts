// GATES-PROPER — the false blockers the auditor found on the live board (2026-09-28), each pinned by
// a check that FAILS without its fix, beside a MUST-EXCLUDE that the accurate blocker still holds.
//
//   C3  the busbar rule read NEW equipment as a second EXISTING rating ("N NEW 240V/125A BUS BAR
//       RATING" beside "EXISTING 240V/200A BUS BAR RATING, MAIN SERVICE PANEL" — Brittany Reavis
//       6a1c2127, Randal Rowland b0ab5169), and any regex conflict was a hard blocker. Now: the
//       statement's own nearest status word decides new/existing; a conflict blocks only when
//       every value is stated as the existing gear; the reference cites the JOB's state.
//
//   npx tsx backend/test/gatesProper.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ page-images never land in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gates-proper-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
process.env.SKIP_CODE_RESEARCH = "1";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { saveProjectDocument } = await import("../src/projectDocuments");
const repo = await import("../src/repository");
const gate = await import("../src/pvWorksheetGate");
const { reviewerBlockerList } = await import("../src/nextStep");

const db = await openDatabase();
const results: Record<string, { ok: number; fail: number }> = {};
let failures = 0;
const check = (section: string, label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { (results[section] ??= { ok: 0, fail: 0 }).ok++; console.log(`  ok   - ${section} ${label}`); })
  .catch((err) => { failures++; (results[section] ??= { ok: 0, fail: 0 }).fail++; console.error(`  FAIL - ${section} ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

const client = createClient(db, {
  companyName: "Gates Proper Solar LLC", legalBusinessName: "Gates Proper Solar LLC", ccbLicenseNumber: "240135",
  electricalLicenseNumber: "C1234", businessEmail: "ops@gatesproper.test", businessPhone: "(503) 555-0142",
});
// The smoke's own fixture (backend/src/smoke.ts, as nextStepGates uses it): clears QC, documents and the reviewer.
const FIXTURE: Record<string, string> = {
  street: "123 Solar Way", city: "Portland", state: "OR", zip: "97201", ahj: "Portland", utility: "PGE",
  account: "1234567890", meter: "987654321", dcKw: "8.6", acKw: "6.5", exportKw: "6.5", moduleMake: "Qcells",
  moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20", invModel: "IQ8M", invQty: "20", invOutputW: "325",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40", permitPath: "PRESCRIPTIVE",
  roofRafterSpacing: "24", roofRafterSpan: "10", snow: "25", deadLoad: "3.2", wind: "B",
  locateCalloutText: "No locate-triggering scope found.",
  sitePlanNotesText: "Roof plan shows fire access pathway, ridge/eave setbacks, array dimensions, service equipment, and PV layout.",
  roofPlanNotesText: "Roof framing: 2x6 rafters at 24 inches on center, 10 ft clear span, roof slope 5:12. Racking attachment detail shows flashed standoffs lagged to rafters.",
  structuralCalcText: "Oregon prescriptive rooftop PV worksheet complete. Dead load 3.2 psf, ground snow 25 psf, wind exposure B, rafter span checked.",
  electricalCalcText: "NEC 705.12 load-side calculation: 200A bus x 120 percent = 240A, 200A main + 40A PV breaker = 240A. NEC 690.12 rapid shutdown shown.",
  labelsText: "PV label schedule includes rapid shutdown label, service power source directory, disconnect labels, and backfed breaker warning.",
  splitPagesText: "01 Site/Roof Plan and PV layout with fire pathway: pages 1-2\n02 SLD 3-Line Diagram with NEC 705.12 calculation and rapid shutdown: page 3\n03 Roof framing and racking attachment detail: pages 4-5\n04 Module spec UL 61730: pages 6-8\n05 Inverter spec UL 1741 SB: pages 9-11\n06 Label schedule and placards: page 12",
  utilityDownloadChecklistText: "PGE package includes SLD/3-line, site/plot plan, module spec, inverter spec, utility bill, meter data, and account data.",
  packetReadinessText: "READY - Plan set\nREADY - Utility bill\nREADY - Module spec\nREADY - Inverter spec",
};
let seq = 0;
const mkProject = (over: Record<string, string> = {}): string => {
  const d = repo.createProject(db, { clientId: client.id, owner: `Gates Owner ${++seq}`, ...FIXTURE, ...over });
  return d.project.id;
};
/** A text-layer PDF, uploaded through the real document path (saveProjectDocument extracts its text). */
async function uploadTextPdf(pid: string, docType: string, lines: string[]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([1224, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 30, y: 760 - i * 16, size: 9, font }));
  saveProjectDocument(db, pid, { docType, filename: `${docType}.pdf`, contentType: "application/pdf", buffer: Buffer.from(await doc.save()), source: "upload" });
  for (let i = 0; i < 100; i++) {
    const row = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ? AND doc_type = ? AND COALESCE(extracted_text, '') != ''", [pid, docType]);
    if (Number(row?.n) > 0) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`text extraction never finished for ${docType}`);
}
const findingOf = (pid: string, id: string) => repo.buildReviewerReportFor(db, repo.getProjectDetail(db, pid).project).findings.find((f) => f.id === id);

// ── C3 ─────────────────────────────────────────────────────────────────────────────────
// The live one-line's own words (6a1c2127's SLD text layer, 2026-09-28), a new BACKUP panel beside the existing MSP.
const REAVIS_SLD = [
  "EXISTING BI-DIRECTIONAL UTILITY METER, 1-PHASE, 3W, 120V/240V N NEW 240V/125A BUS BAR RATING, SINGLE PHASE,",
  "WITH A NEW 100A MAIN BREAKER (BACKUP LOAD PANEL) 100A (E) LOADS N N L1 L2 G",
  "TYPE NON FUSIBLE BATTERY DISCONNECT NEMA 3R 60A-2P 120/240VAC EXISTING 240V/200A BUS BAR RATING, MAIN SERVICE PANEL,",
  "SINGLE PHASE, WITH A 200A MAIN BREAKER UTILITY COMPANY - PGE",
];
await check("C3", "unit: a NEW bus with a voltage between the word and the amps is not the existing gear", () => {
  const st = gate.serviceRatingStatements(REAVIS_SLD.join(" "));
  assert.deepEqual(st.bus.map((b) => b.amps), [200], `bus statements: ${JSON.stringify(st.bus)}`);
  assert.deepEqual(gate.serviceRatingStatements("CT (N) 60A/2P N NEW 240V/125A BUS BAR RATING ... EXISTING 240V/200A BUS BAR RATING, MAIN SERVICE").bus.map((b) => b.amps), [200]);
});
await check("C3", "KILL (real path): the Reavis one-line holds nothing — no service-rating blocker in the reviewer list", async () => {
  const pid = mkProject();
  await uploadTextPdf(pid, "sld", REAVIS_SLD);
  const blockers = reviewerBlockerList(db, repo.getProjectDetail(db, pid).project).map((b) => b.code);
  assert.ok(!blockers.includes("city.elec.service-rating-mismatch"), `blockers: ${blockers.join(", ")}`);
});
await check("C3", "KILL: an unmarked second rating is a WARNING for a person, never a hard blocker", async () => {
  const pid = mkProject();
  await uploadTextPdf(pid, "sld", ["MSP 200A WITH 200A MAIN BREAKER", "SITE PLAN: MAIN SERVICE PANEL 100A"]);
  const f = findingOf(pid, "city.elec.service-rating-mismatch");
  assert.ok(f, "the conflict is still reported");
  assert.equal(f!.severity, "warning");
  assert.match(f!.message, /confirm which is the existing panel/);
});
await check("C3", "KILL: the finding cites the JOB's state, not Iowa's worksheet", async () => {
  const pid = mkProject();
  await uploadTextPdf(pid, "sld", ["(E) 100A MSP WITH 100A MAIN BREAKER", "PV-1 SITE PLAN (E) 200A MSP"]);
  const f = findingOf(pid, "city.elec.service-rating-mismatch");
  assert.ok(f);
  const refs = f!.codeReferences.map((r) => `${r.code} ${r.title}`).join(" | ");
  assert.ok(!/Iowa/i.test(refs), refs);
  assert.match(refs, /OR/);
});
await check("C3", "MUST-EXCLUDE (real path): Roesler's '(E) 100A MSP' vs '(E) 200A MSP' is still a BLOCKER quoting both", async () => {
  const pid = mkProject();
  await uploadTextPdf(pid, "sld", ["PV-5 LINE DIAGRAM (E) 100A MSP WITH 100A MAIN BREAKER", "PV-1 SITE PLAN (E) 200A MSP"]);
  const blockers = reviewerBlockerList(db, repo.getProjectDetail(db, pid).project).map((b) => b.code);
  assert.ok(blockers.includes("city.elec.service-rating-mismatch"), `blockers: ${blockers.join(", ")}`);
  const f = findingOf(pid, "city.elec.service-rating-mismatch")!;
  assert.match(f.message, /100 A \("[^"]*100A MSP[^"]*"\) and 200 A/);
});
await check("C3", "KILL: the finding carries its own quotes as evidence (not the SLD topic's 'a one-line exists')", async () => {
  const pid = mkProject();
  await uploadTextPdf(pid, "sld", ["PV-5 LINE DIAGRAM (E) 100A MSP WITH 100A MAIN BREAKER", "PV-1 SITE PLAN (E) 200A MSP"]);
  const f = findingOf(pid, "city.elec.service-rating-mismatch")!;
  assert.equal(f.evidenceStatus, "verified");
  assert.equal(f.evidenceFound?.length, 2);
});
await check("C3", "MUST-EXCLUDE: EXISTING stated twice with different amps still blocks", () => {
  const f = gate.serviceRatingConsistencyFindings(repo.getProjectDetail(db, mkProject()).project,
    "EXISTING 240V/100A BUS BAR RATING, MAIN SERVICE PANEL ... ELECTRICAL NOTES: EXISTING 240V/200A BUS BAR RATING");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "blocker");
});

// ── summary ────────────────────────────────────────────────────────────────────────────
console.log("");
for (const [section, r] of Object.entries(results)) console.log(`  ${section}: ${r.ok}/${r.ok + r.fail} passed`);
if (failures) {
  console.error(`\ngatesProper: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\ngatesProper: all checks passed");
process.exit(0);
