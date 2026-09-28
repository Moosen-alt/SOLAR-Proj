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

// ── C2 ─────────────────────────────────────────────────────────────────────────────────
// A structural design-criteria conflict (plan set vs structural letter — designCriteriaDocuments'
// own MUST-PASS shape) held the utility's application and the approval of a staged NEM draft.
const { getAutopilotState, runAutopilotApproval, gateBlockersForTracks } = await import("../src/autopilot");
const { computeNextStep, loadFullNextStepFacts } = await import("../src/nextStep");
const { requiredTracks } = await import("../src/submittalTracks");
const { HttpError } = await import("../src/httpError");
const scope = await import("../src/gateScope");
const PLAN = ["STRUCTURAL NOTES:", "1. GROUND SNOW LOAD = 20 PSF", "2. WIND SPEED = 110 MPH", "3. EXPOSURE CATEGORY = C", "ROOF MOUNT PV ARRAY"];
const LETTER = ["Structural analysis for the rooftop PV array.", "Design wind speed, Vult: 95 mph (3-sec gust)", "Wind exposure category: B", "Ground snow load, Pg : 28 psf"];
const mkRun = (pid: string, status: string, permitType: string, startedAt: string): string => {
  const runId = `run-gp-${++seq}`;
  db.run(
    `INSERT INTO portal_runs (id, project_id, portal_profile_id, run_type, status, started_at, error_message,
       human_action_required, screenshots_path, logs_path, result_json, permit_type)
     VALUES (?, ?, NULL, 'prepare_submit', ?, ?, '', 0, '', '', ?, ?)`,
    [runId, pid, status, startedAt, JSON.stringify({ actor: "RecipeAdapter", ok: true }), permitType],
  );
  return runId;
};
const structuralConflictProject = async (): Promise<string> => {
  const pid = mkProject();
  await uploadTextPdf(pid, "plan_set", PLAN);
  await uploadTextPdf(pid, "structural_letter", LETTER);
  const f = findingOf(pid, "city.struct.design-criteria-conflict");
  if (!f || f.severity !== "blocker") throw new Error(`fixture: the structural conflict did not fire as a blocker (${f?.severity})`);
  return pid;
};
/** The 409 prepareSubmission raises for reviewer findings on this track, or null when it raised none. */
const reviewerRefusal = async (pid: string, track: "nem" | "building" | "electrical" | "combo"): Promise<string[] | null> => {
  try { await prepareSubmission(pid, track); return null; } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      const d = (err.details ?? {}) as Record<string, unknown>;
      const titles = Array.isArray(d.reviewerBlockers) ? d.reviewerBlockers.map(String) : [];
      return titles.length ? titles : null;
    }
    return null; // any other refusal (documents, adapter) is not the reviewer gate's
  }
};
const prepareSubmission = (pid: string, track: "nem" | "building" | "electrical" | "combo") => repo.prepareSubmission(db, pid, track, false);
const permitTrackOf = (pid: string): "building" | "combo" => (requiredTracks(repo.getProjectDetail(db, pid).project).includes("combo") ? "combo" : "building");

await check("C2", "KILL (real path): a structural conflict does not hold the NEM track — Stage names only the permit filing and says NEM can go alone", async () => {
  const pid = await structuralConflictProject();
  const s = getAutopilotState(db, pid);
  assert.ok(s.stageDisabledReason, "the permit filing is still held");
  assert.doesNotMatch(s.stageDisabledReason!.split(":")[0], /\bnem\b/, s.stageDisabledReason!);
  assert.match(s.stageDisabledReason!, /nem track\(s\) can be staged on their own/);
});
await check("C2", "KILL (real path): prepareSubmission's NEM stage is not refused by the structural finding", async () => {
  const pid = await structuralConflictProject();
  const refusal = await reviewerRefusal(pid, "nem");
  assert.ok(!refusal || !refusal.some((t) => /Design criteria conflict/.test(t)), `NEM refused by: ${refusal?.join(", ")}`);
});
await check("C2", "MUST-EXCLUDE (real path): the building-side stage IS still refused by the structural finding", async () => {
  const pid = await structuralConflictProject();
  const refusal = await reviewerRefusal(pid, permitTrackOf(pid));
  assert.ok(refusal && refusal.some((t) => /Design criteria conflict/.test(t)), `not refused: ${refusal}`);
});
await check("C2", "KILL (real path): a staged NEM draft is approvable over a structural finding — panel, Approve button and approval route agree", async () => {
  const pid = await structuralConflictProject();
  const combo = mkRun(pid, "awaiting_human_submit", permitTrackOf(pid), "2026-09-20T09:00:00.000Z");
  repo.captureConfirmation(db, combo, { applicationNumber: "APP-GP-1", confirmationNumber: "C-GP-1", submittedBy: "test operator" });
  mkRun(pid, "awaiting_human_submit", "nem", "2026-09-20T10:00:00.000Z");
  db.run("UPDATE projects SET status = 'awaiting_human_submit', stage_detail = 'staged_for_review' WHERE id = ?", [pid]);
  const s = getAutopilotState(db, pid);
  assert.equal(s.canApprove, true, `refused: ${s.approveDisabledReason}`);
  const step = computeNextStep(db, pid);
  assert.equal(step.key, "staged_awaiting_submit", step.headline);
  assert.equal(step.button?.id, "approveSubmitBtn", "the next step hides Approve");
  let err: unknown = null;
  try { await runAutopilotApproval(db, pid, { approverName: "Test Approver", track: "nem" }); } catch (e) { err = e; }
  assert.ok(!(err instanceof HttpError && /reviewer gate still has blockers/.test(err.message)), `approval route refused: ${err instanceof Error ? err.message : err}`);
});
await check("C2", "MUST-EXCLUDE (real path): a staged building-side draft is NOT approvable over the same finding", async () => {
  const pid = await structuralConflictProject();
  mkRun(pid, "awaiting_human_submit", permitTrackOf(pid), "2026-09-20T10:00:00.000Z");
  db.run("UPDATE projects SET status = 'awaiting_human_submit', stage_detail = 'staged_for_review' WHERE id = ?", [pid]);
  const s = getAutopilotState(db, pid);
  assert.equal(s.canApprove, false);
  assert.match(String(s.approveDisabledReason), /reviewer gate/);
  await assert.rejects(runAutopilotApproval(db, pid, { approverName: "Test Approver", track: permitTrackOf(pid) }), /reviewer gate still has blockers/);
});
await check("C2", "one predicate: scopes by category — structural->building side, electrical->electrical + NEM (not rapid shutdown), utility->NEM, unknown->all", () => {
  const holds = (id: string, category: string) => scope.tracksHeld(scope.findingHoldScope({ id, category } as never));
  assert.deepEqual(holds("city.struct.design-criteria-conflict", "structural"), ["building", "combo", "permit"]);
  assert.deepEqual(holds("city.elec.service-rating-mismatch", "electrical"), ["nem", "electrical", "combo", "permit", "mpu"]);
  assert.deepEqual(holds("city.elec.rapid-shutdown-missing", "electrical"), ["electrical", "combo", "permit", "mpu"]);
  assert.deepEqual(holds("reviewer.utility.meter-mismatch", "utility_nem"), ["nem"]);
  assert.deepEqual(holds("city.fire.pathways-missing", "plan_set"), ["building", "combo", "permit"]);
  // MUST-EXCLUDE: anything the predicate does not recognise holds every filing, and a null track is always held.
  assert.deepEqual(holds("reviewer.plan.site", "plan_set"), [...scope.GATE_TRACKS]);
  assert.deepEqual(holds("something.new", "ai_review"), [...scope.GATE_TRACKS]);
  assert.deepEqual(holds("reviewer.core.dc", "project_data"), [...scope.GATE_TRACKS]);
  assert.equal(scope.scopeHoldsTrack("building", null), true);
});
await check("C2", "KILL (real path): a missing account number holds only the utility filing (the scope prepareSubmission's own field gate uses)", async () => {
  const pid = mkProject({ account: "" });
  // A bill on file makes the missing account a blocker, not the "waiting on the bill" warning.
  saveProjectDocument(db, pid, { docType: "utility_bill", filename: "bill.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% bill\n", "utf8"), source: "upload" });
  const gateReport = repo.getSubmitGateReport(db, pid);
  const spr = gateReport.checks.find((c) => c.id === "single-project-record")!;
  assert.equal(spr.status, "blocker", spr.nextAction);
  assert.deepEqual(spr.holds?.map((h) => h.tracks), [["nem"]]);
  const facts = loadFullNextStepFacts(db, pid);
  const project = repo.getProjectDetail(db, pid).project;
  const heldIds = (t: "nem" | "building" | "combo") => gateBlockersForTracks(db, project, facts.gate, [t]).map((b) => b.id);
  assert.ok(!heldIds(permitTrackOf(pid)).includes("single-project-record"), `the permit filing is held by: ${heldIds(permitTrackOf(pid)).join(", ")}`);
  // MUST-EXCLUDE: the utility filing IS held by it.
  assert.ok(heldIds("nem").includes("single-project-record"), `NEM held by: ${heldIds("nem").join(", ")}`);
});

// ── C1 ─────────────────────────────────────────────────────────────────────────────────
// Michael Sheridan's shape (City of Jefferson; the per-job lookup cites Marion County as the issuer of
// both permits; Marion's B-01S / E-01 are curated, hash-locked seeds). Before Stage fetched them, the
// gate held both permit filings with "Attach or split out ... (B-01S), filled; ... (E-01), filled".
const { savePermitProcessLookup } = await import("../src/permitProcess");
const { prepareOfficialDocuments } = await import("../src/prepareOfficialDocuments");
const { archiveProject } = await import("../src/projectArchive");
const { owedMissingDocuments, documentInventory } = await import("../src/requiredDocuments");
const plan = await import("../src/formAcquisitionPlan");
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const fixturePdf = (name: string) => fs.readFileSync(path.join(REPO, "backend/test/fixtures", name));
const B01S_URL = "https://www.co.marion.or.us/PW/BuildingInspection/Documents/B-01S%20Solar%20Prescriptive%20Installation%20Application%20Filleable.pdf";
const E01_URL = "https://www.co.marion.or.us/PW/BuildingInspection/Documents/E-01%20Renewable%20Energy%20Permit%20Application.pdf";
const B5952_URL = "https://www.oregon.gov/bcd/Formslibrary/5952.pdf";
const MARION_PAGE = "https://www.co.marion.or.us/PW/BuildingInspection";
// No network: public fixtures for their real URLs, nothing else answers; every download is counted.
const realFetch = globalThis.fetch;
let downloads: string[] = [];
const served = new Map<string, Buffer>();
globalThis.fetch = (async (url: string | URL) => {
  const u = String(url);
  downloads.push(u);
  const body = served.get(u);
  if (!body) return new Response("not found", { status: 404 });
  return new Response(body, { headers: { "Content-Type": "application/pdf" } });
}) as typeof fetch;
const citedFact = (value: string, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const notFoundFact = (why: string, sourceUrl = "", quote = "") => ({ value: null, sourceUrl, quote, origin: "lookup" as const, notFound: why });
function saveMarionLookup(ahj: string): void {
  const permit = (discipline: "structural" | "electrical", src: string, quote: string) => ({
    discipline, label: `${discipline} permit`,
    issuingAgency: citedFact("Marion County", src, quote),
    portalUrl: notFoundFact("no online portal named", MARION_PAGE, "Check permit status online and general information for individual permits"),
    recordType: notFoundFact("none"), documents: notFoundFact("no list", "https://jeffersonoregon.org/planning-committee/"), fee: notFoundFact("none"),
  });
  const r = savePermitProcessLookup(db, {
    state: "OR", ahj, lookedUpAt: new Date().toISOString(), issuingAgency: notFoundFact("not stated at the top level"),
    permitStructure: citedFact("separate", B01S_URL, "separate building and electrical permits"),
    permits: [
      permit("structural", B01S_URL, "Prescriptive Solar Photovoltaic Installation Permit Application · Marion County Public Works"),
      permit("electrical", "https://jeffersonoregon.org/planning-committee/", "All Electrical and Plumbing permits are submitted to Marion County Building and those forms can be found here."),
    ],
    notes: [],
  } as never);
  if (!(r as { saved?: boolean }).saved) throw new Error(`fixture: the lookup for ${ahj} was not saved`);
}
const JEFFERSON = { ahj: "City of Jefferson", city: "Jefferson", zip: "97352", utility: "Pacific Power", permitPath: "PRESCRIPTIVE" };
let marionSaved = false;
/** A Jefferson job with its plan set on file and NO Marion County form stored. */
const jeffersonJob = async (): Promise<string> => {
  if (!marionSaved) { saveMarionLookup("City of Jefferson"); marionSaved = true; }
  db.run("DELETE FROM ahj_form_templates WHERE ahj_name = 'Marion County'");
  const pid = mkProject(JEFFERSON);
  saveProjectDocument(db, pid, { docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% jefferson plan set\n", "utf8"), source: "upload" });
  return pid;
};
const docCheck = (pid: string) => repo.getSubmitGateReport(db, pid).checks.find((c) => c.id === "document-inventory")!;
const heldByMarion = (pid: string): string[] => (docCheck(pid).holds ?? []).map((h) => h.label).filter((l) => /Marion County/.test(l));

await check("C1", "KILL (real path): Marion's curated B-01S / E-01, not yet fetched, hold neither permit filing — the gate says Stage downloads and fills them", async () => {
  const pid = await jeffersonJob();
  const doc = docCheck(pid);
  assert.deepEqual(heldByMarion(pid), [], `held by: ${JSON.stringify(doc.holds)}`);
  const lines = doc.evidence.filter((l) => /^Stage downloads and fills it: Marion County/.test(l));
  assert.equal(lines.length, 2, doc.evidence.join(" | "));
  // From the county's own published forms (the acquisition's plan: curated seeds, by URL).
  const project = repo.getProjectDetail(db, pid).project;
  const owed = owedMissingDocuments(db, project, documentInventory(db, project));
  const urls = [...owed.acquiredVia.values()].map((a) => `${a.via} ${a.sourceUrl}`);
  assert.ok(urls.includes(`curated ${B01S_URL}`) && urls.includes(`curated ${E01_URL}`), urls.join(" | "));
  const s = getAutopilotState(db, pid);
  assert.ok(!/Marion County/.test(String(s.stageDisabledReason)), `Stage held by Marion's forms: ${s.stageDisabledReason}`);
});
await check("C1", "KILL (real path, reads write nothing): the look-ahead does not create or claim the acquisition cooldown", async () => {
  const pid = await jeffersonJob();
  const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ahj_form_acquisition_attempts'")?.n;
  const rows = before ? db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ahj_form_acquisition_attempts")?.n : 0;
  repo.getSubmitGateReport(db, pid);
  getAutopilotState(db, pid);
  const after = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ahj_form_acquisition_attempts'")?.n;
  assert.equal(after, before, "a read created the cooldown table");
  if (after) assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ahj_form_acquisition_attempts")?.n, rows, "a read claimed a cooldown");
});
await check("C1", "MUST-PASS (real path): Stage then really gets them — prepareOfficialDocuments downloads and fills both, and the owed list stays clear", async () => {
  const pid = await jeffersonJob();
  served.set(B01S_URL, fixturePdf("marion-b-01s.pdf"));
  served.set(E01_URL, fixturePdf("marion-e-01.pdf"));
  served.set(B5952_URL, fixturePdf("bcd-5952-2024.pdf"));
  downloads = [];
  await prepareOfficialDocuments(db, repo.getProjectDetail(db, pid).project);
  assert.ok(downloads.includes(B01S_URL) && downloads.includes(E01_URL), downloads.join(", "));
  const doc = docCheck(pid);
  assert.deepEqual(heldByMarion(pid), []);
  assert.ok(!doc.evidence.some((l) => /^Stage downloads and fills it: Marion County/.test(l)), "after Stage they are on file, not 'to be downloaded'");
});
await check("C1", "MUST-EXCLUDE: a curated URL that failed in the last 6 hours is NOT counted — it holds, worded 'find the official form or upload the blank'", async () => {
  const pid = await jeffersonJob();
  served.delete(E01_URL);
  plan.noteFormFetchFailure(E01_URL); // what fetchPdf records on a 404
  try {
    const held = (docCheck(pid).holds ?? []).find((h) => /E-01/.test(h.label));
    assert.ok(held, `E-01 not held: ${JSON.stringify(docCheck(pid).holds)}`);
    assert.match(String(held!.action), /find the official form .* or upload the blank/);
    assert.doesNotMatch(docCheck(pid).nextAction, /Attach or split out the missing/);
    const s = getAutopilotState(db, pid);
    assert.match(String(s.stageDisabledReason), /E-01[^·]*find the official form/);
  } finally { plan.clearFormFetchFailure(E01_URL); served.set(E01_URL, fixturePdf("marion-e-01.pdf")); }
});
await check("C1", "MUST-EXCLUDE (the hard line): when Stage's download fails, prepareSubmission's post-fill count still refuses, naming the form", async () => {
  const pid = await jeffersonJob();
  served.delete(E01_URL);
  try {
    let err: unknown = null;
    try { await repo.prepareSubmission(db, pid, "electrical", false); } catch (e) { err = e; }
    assert.ok(err instanceof HttpError && err.status === 409, `not refused: ${err instanceof Error ? err.message : err}`);
    const missing = ((err as InstanceType<typeof HttpError>).details as { missingDocuments?: Array<{ label: string }> })?.missingDocuments ?? [];
    assert.ok(missing.some((m) => /E-01/.test(m.label)), `refusal: ${(err as Error).message}`);
    assert.match((err as Error).message, /find the official form/);
  } finally { plan.clearFormFetchFailure(E01_URL); served.set(E01_URL, fixturePdf("marion-e-01.pdf")); }
});
// A separate-permit Oregon AHJ with no curated or cited source (Lincoln City's own shape — f7d7af7e /
// b0ab5169): only research can find its applications.
const RESEARCH_ONLY = { ahj: "City of Lincoln City", city: "Lincoln City", zip: "97367", utility: "Pacific Power", permitPath: "PRESCRIPTIVE" };
let researchLookupSaved = false;
const researchOnlyJob = (): string => {
  if (!researchLookupSaved) {
    // The AHJ's structure: separate building + electrical permits (a cited lookup), the city its own issuer.
    savePermitProcessLookup(db, {
      state: "OR", ahj: RESEARCH_ONLY.ahj, lookedUpAt: new Date().toISOString(), issuingAgency: citedFact("City of Lincoln City", "https://www.lincolncity.org/building", "The City of Lincoln City Building Division issues building and electrical permits"),
      permitStructure: citedFact("separate", "https://www.lincolncity.org/building", "separate building and electrical permits are required"),
      permits: [], notes: [],
    } as never);
    researchLookupSaved = true;
  }
  db.exec("CREATE TABLE IF NOT EXISTS ahj_form_acquisition_attempts (scope_key TEXT PRIMARY KEY, attempted_at INTEGER NOT NULL)");
  db.run("DELETE FROM ahj_form_acquisition_attempts WHERE scope_key LIKE 'or|city of lincoln city|%'", []);
  const pid = mkProject(RESEARCH_ONLY);
  saveProjectDocument(db, pid, { docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% lincoln plan set\n", "utf8"), source: "upload" });
  const rows = documentInventory(db, repo.getProjectDetail(db, pid).project).missingBlocking.filter((d) => /permit application/i.test(d.label));
  if (!rows.length) throw new Error(`fixture: no blocking application row for ${RESEARCH_ONLY.ahj}: ${JSON.stringify(docCheck(pid).evidence)}`);
  return pid;
};
const heldApplications = (pid: string) => (docCheck(pid).holds ?? []).filter((h) => /permit application/i.test(h.label));
await check("C1", "MUST-EXCLUDE: no key, no seed, no citation — the AHJ's applications still hold, worded 'find the official form or upload the blank'", () => {
  delete process.env.ANTHROPIC_API_KEY;
  const pid = researchOnlyJob();
  const held = heldApplications(pid);
  assert.ok(held.length >= 1, `nothing held: ${JSON.stringify(docCheck(pid))}`);
  assert.ok(held.every((h) => /find the official form/.test(String(h.action))), JSON.stringify(held));
});
await check("C1", "KILL: research available and the 24h cooldown open — Stage researches them, so staging is not held before it (the post-fill 409 decides)", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-never-sent";
  try {
    const pid = researchOnlyJob();
    assert.deepEqual(heldApplications(pid), [], JSON.stringify(docCheck(pid).holds));
    assert.ok(docCheck(pid).evidence.some((l) => /^Stage downloads and fills it: .*form research/.test(l)), docCheck(pid).evidence.join(" | "));
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});
await check("C1", "MUST-EXCLUDE: research available but the cooldown CLOSED (researched < 24h ago) — they hold again", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-never-sent";
  try {
    const pid = researchOnlyJob();
    db.exec("CREATE TABLE IF NOT EXISTS ahj_form_acquisition_attempts (scope_key TEXT PRIMARY KEY, attempted_at INTEGER NOT NULL)");
    db.run("INSERT OR REPLACE INTO ahj_form_acquisition_attempts(scope_key, attempted_at) VALUES (?, ?)", [plan.acquisitionScopeKey(repo.getProjectDetail(db, pid).project, "prescriptive"), Date.now()]);
    assert.ok(heldApplications(pid).length >= 1, JSON.stringify(docCheck(pid).holds));
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});
await check("C1", "MUST-EXCLUDE: a document a person supplies (the PE letter on the engineered path) is still owed, worded 'attach it or split it out'", () => {
  const pid = mkProject({ permitPath: "ENGINEERED", ahj: "City of Gatesville", city: "Gatesville", zip: "97000", utility: "Pacific Power" });
  const letter = (docCheck(pid).holds ?? []).find((h) => /PE-stamped|structural letter/i.test(h.label));
  assert.ok(letter, JSON.stringify(docCheck(pid).holds));
  assert.match(String(letter!.action), /attach it or split it out/);
});

// Approve judges a DRAFT by what it carried — never by the look-ahead, never by the disk now.
await check("C1", "KILL (real path): a draft staged BEFORE the Marion E-01 existed is not approvable once the E-01 is on file — 're-stage to attach it'", async () => {
  const pid = await jeffersonJob();
  mkRun(pid, "awaiting_human_submit", "electrical", new Date(Date.now() - 3600_000).toISOString());
  db.run("UPDATE projects SET status = 'awaiting_human_submit', stage_detail = 'staged_for_review' WHERE id = ?", [pid]);
  served.set(B01S_URL, fixturePdf("marion-b-01s.pdf"));
  served.set(E01_URL, fixturePdf("marion-e-01.pdf"));
  await prepareOfficialDocuments(db, repo.getProjectDetail(db, pid).project); // the forms arrive AFTER the draft
  const s = getAutopilotState(db, pid);
  assert.equal(s.canApprove, false, "a draft that went up without the E-01 read as complete");
  assert.match(String(s.approveDisabledReason), /went up without [^—]*E-01[^—]*— it is on file now: re-stage to attach it/);
  assert.doesNotMatch(String(s.approveDisabledReason), /Attach or split out/);
});
await check("C1", "MUST-PASS: a draft staged AFTER the forms were on file is approvable (no false stop on a legacy draft)", async () => {
  const pid = await jeffersonJob();
  served.set(B01S_URL, fixturePdf("marion-b-01s.pdf"));
  served.set(E01_URL, fixturePdf("marion-e-01.pdf"));
  await prepareOfficialDocuments(db, repo.getProjectDetail(db, pid).project);
  mkRun(pid, "awaiting_human_submit", "electrical", new Date(Date.now() + 1000).toISOString());
  db.run("UPDATE projects SET status = 'awaiting_human_submit', stage_detail = 'staged_for_review' WHERE id = ?", [pid]);
  const s = getAutopilotState(db, pid);
  assert.ok(!/went up without/.test(String(s.approveDisabledReason)), `refused: ${s.approveDisabledReason}`);
});
await check("C1", "KILL: a draft's recorded payload decides — a run handed no E-01 is refused even though it is on file now; one handed it is not", async () => {
  const pid = await jeffersonJob();
  served.set(B01S_URL, fixturePdf("marion-b-01s.pdf"));
  served.set(E01_URL, fixturePdf("marion-e-01.pdf"));
  await prepareOfficialDocuments(db, repo.getProjectDetail(db, pid).project);
  const runId = mkRun(pid, "awaiting_human_submit", "electrical", new Date(Date.now() + 1000).toISOString());
  db.run("UPDATE projects SET status = 'awaiting_human_submit', stage_detail = 'staged_for_review' WHERE id = ?", [pid]);
  db.run("UPDATE portal_runs SET result_json = ? WHERE id = ?", [JSON.stringify({ actor: "RecipeAdapter", ok: true, packagedDocTypes: ["plan_set", "sld"] }), runId]);
  assert.match(String(getAutopilotState(db, pid).approveDisabledReason), /went up without [^;]*E-01/);
  db.run("UPDATE portal_runs SET result_json = ? WHERE id = ?", [JSON.stringify({ actor: "RecipeAdapter", ok: true, packagedDocTypes: ["plan_set", "sld", "electrical_application"] }), runId]);
  assert.ok(!/went up without/.test(String(getAutopilotState(db, pid).approveDisabledReason)), String(getAutopilotState(db, pid).approveDisabledReason));
});
await check("C1", "MUST-PASS (the production recording path): a draft staged NOW records its payload, and is approvable — no 'went up without' on a fresh draft", async () => {
  const pid = mkProject();
  saveProjectDocument(db, pid, { docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% fresh draft plan set\n", "utf8"), source: "upload" });
  const staged: string[] = [];
  for (const track of requiredTracks(repo.getProjectDetail(db, pid).project)) {
    try { await repo.prepareSubmission(db, pid, track, false); staged.push(track); } catch (e) { staged.push(`${track}: ${e instanceof Error ? e.message.slice(0, 160) : e}`); }
  }
  const runs = db.query<{ id: string; permit_type: string; status: string; result_json: string }>("SELECT id, permit_type, status, result_json FROM portal_runs WHERE project_id = ? AND status = 'awaiting_human_submit'", [pid]);
  assert.ok(runs.length > 0, `nothing staged through the mock adapter: ${staged.join(" | ")}`);
  if (process.env.GP_VERBOSE) console.log(`         staged: ${staged.join(" | ")}; drafts: ${runs.map((r) => `${r.permit_type} carried ${JSON.stringify((JSON.parse(r.result_json) as { packagedDocTypes?: string[] }).packagedDocTypes)}`).join(" · ")}`);
  for (const r of runs) {
    const carried = (JSON.parse(r.result_json) as { packagedDocTypes?: string[] }).packagedDocTypes;
    assert.ok(Array.isArray(carried) && carried.length > 0, `run ${r.permit_type} recorded no payload: ${r.result_json.slice(0, 300)}`);
    const gaps = repo.draftDocumentGaps(db, repo.getProjectDetail(db, pid).project, db.get("SELECT * FROM portal_runs WHERE id = ?", [r.id])!, r.permit_type as never);
    assert.deepEqual(gaps, [], `a fresh ${r.permit_type} draft read as incomplete: ${JSON.stringify(gaps)}`);
  }
  const s = getAutopilotState(db, pid);
  assert.doesNotMatch(String(s.approveDisabledReason), /went up without/, String(s.approveDisabledReason));
});
await check("C1", "KILL: an archived project neither stages nor approves", async () => {
  const pid = await jeffersonJob();
  mkRun(pid, "awaiting_human_submit", "nem", new Date().toISOString());
  db.run("UPDATE projects SET status = 'awaiting_human_submit', stage_detail = 'staged_for_review' WHERE id = ?", [pid]);
  archiveProject(db, pid, "test: archived");
  const s = getAutopilotState(db, pid);
  assert.equal(s.canStage, false, String(s.stageDisabledReason));
  assert.equal(s.canApprove, false);
  assert.match(String(s.approveDisabledReason), /archived/);
});
// ── C4 ─────────────────────────────────────────────────────────────────────────────────
// "1 application field still blank — electrical permit fee (the county schedule, when not on file)"
// under "Resolve them in QC / Human Review before staging": Marion County computes that fee in its own
// portal, and the operator bypassed the gate over a card no gate even reads.
const ahjForms = await import("../src/ahjForms");
const FEE_LABEL = "electrical permit fee (the county schedule, when not on file)";
const dashboardSrc = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const liftFn = (name: string): string => {
  const m = new RegExp(`^function ${name}\\(`, "m").exec(dashboardSrc);
  if (!m) throw new Error(`dashboard.js: could not find ${name}`);
  let i = dashboardSrc.indexOf("{", dashboardSrc.indexOf(")", m.index));
  let depth = 0;
  for (; i < dashboardSrc.length; i++) {
    const ch = dashboardSrc[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return dashboardSrc.slice(m.index, i);
};
// The page's own call: documentVerdictHtml(pkg, ...filledFormBlanks(forms)). (Before the fix the page
// passed every filled form's unmappedRequested as one list — kept as the fallback so a kill run shows
// which checks fall instead of failing to load.)
const hasBlanksSplit = /^function filledFormBlanks\(/m.test(dashboardSrc);
const renderVerdict = new Function(`${["esc", "plural", ...(hasBlanksSplit ? ["filledFormBlanks"] : []), "documentVerdictHtml"].map(liftFn).join("\n\n")}
return (pkg, forms) => ${hasBlanksSplit
    ? "documentVerdictHtml(pkg, ...filledFormBlanks(forms))"
    : "documentVerdictHtml(pkg, forms.filter((f) => f.status === 'filled').flatMap((f) => f.unmappedRequested || []))"};`)() as (pkg: unknown, forms: unknown[]) => string;
/** A 30 kVA Jefferson job (over the E-01's printed <= 25 kVA ladder, so the fee cannot be priced). */
const bigE01 = async () => {
  const pid = await jeffersonJob();
  db.run("UPDATE projects SET system_size_ac_kw = 30 WHERE id = ?", [pid]);
  served.set(B01S_URL, fixturePdf("marion-b-01s.pdf"));
  served.set(E01_URL, fixturePdf("marion-e-01.pdf"));
  served.set(B5952_URL, fixturePdf("bcd-5952-2024.pdf"));
  const project = repo.getProjectDetail(db, pid).project;
  await prepareOfficialDocuments(db, project);
  const pkg = await ahjForms.buildFilledFormsForProject(db, project);
  const e = pkg.forms.find((f) => /E-01/.test(f.formName) && f.status === "filled");
  if (!e) throw new Error(`fixture: no filled E-01: ${JSON.stringify(pkg.forms.map((f) => [f.formName, f.status]))}`);
  if (!(e.unmappedRequested ?? []).includes(FEE_LABEL)) throw new Error(`fixture: the fee was priced: ${JSON.stringify(e.unmappedRequested)}`);
  return e;
};
await check("C4", "one predicate: a fee / surcharge / total is the agency's, a land-use approval the planning office's, the rest the operator's", () => {
  assert.equal(ahjForms.requiredFieldOwner(FEE_LABEL, "computed.electricalTotalFee"), "agency");
  assert.equal(ahjForms.requiredFieldOwner("Coos County surcharges and grand total", "computed.coosElectricalTotal"), "agency");
  assert.equal(ahjForms.requiredFieldOwner("land-use approval number", "snapshot.landUseApprovalNumber"), "planning_office");
  // MUST-EXCLUDE: the operator's data stays the operator's.
  assert.equal(ahjForms.requiredFieldOwner("owner email", "snapshot.homeownerEmail"), "operator");
  assert.equal(ahjForms.requiredFieldOwner("construction category", "computed.singleFamilyCategory"), "operator");
  assert.equal(ahjForms.requiredFieldOwner("supervising electrician license", "client.electricianLicenseNumber"), "operator");
});
await check("C4", "KILL (real fill): the unpriced E-01 fee is still SAID, as the agency's — never 'Still needs'", async () => {
  const e = await bigE01();
  assert.equal(e.requestedFieldOwners?.[FEE_LABEL], "agency", JSON.stringify(e.requestedFieldOwners));
  assert.match(String(e.message), /Left for the agency to compute: [^.]*electrical permit fee/);
  assert.doesNotMatch(String(e.message), /Still needs: [^.]*electrical permit fee/);
});
await check("C4", "KILL (the card): the fee is listed as the agency's to compute, not under 'still blank', and nothing says 'Resolve them in QC / Human Review before staging'", async () => {
  const e = await bigE01();
  const html = renderVerdict({ missingDocumentsStatus: "resolved", missingDocuments: [], filledAtStagingDocuments: [] }, [e]);
  assert.doesNotMatch(html, /Resolve them in QC \/ Human Review before staging/);
  const stillBlank = /still blank<\/span>[\s\S]*?<\/ul>/.exec(html)?.[0] ?? "";
  assert.ok(!stillBlank.includes(FEE_LABEL), `the fee is on the operator's list: ${stillBlank}`);
  const agencyBlock = /left for the agency to compute<\/span>[\s\S]*?<\/ul>/.exec(html)?.[0] ?? "";
  assert.ok(agencyBlock.includes(FEE_LABEL), `the fee vanished: ${html}`);
});
await check("C4", "MUST-EXCLUDE (the card): the operator's own blank (no owner email on the project) is still listed under 'still blank'", async () => {
  const e = await bigE01();
  assert.ok((e.unmappedRequested ?? []).includes("owner email") && !e.requestedFieldOwners?.["owner email"], JSON.stringify(e));
  const html = renderVerdict({ missingDocumentsStatus: "resolved", missingDocuments: [], filledAtStagingDocuments: [] }, [e]);
  const stillBlank = /still blank<\/span>[\s\S]*?<\/ul>/.exec(html)?.[0] ?? "";
  assert.ok(stillBlank.includes("owner email"), html);
});
globalThis.fetch = realFetch;

// ── summary ────────────────────────────────────────────────────────────────────────────
console.log("");
for (const [section, r] of Object.entries(results)) console.log(`  ${section}: ${r.ok}/${r.ok + r.fail} passed`);
if (failures) {
  console.error(`\ngatesProper: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\ngatesProper: all checks passed");
process.exit(0);
