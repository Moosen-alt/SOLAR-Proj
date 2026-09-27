// THE PAYLOAD IS SCOPED TO THE TRACK THROUGH ONE DISCIPLINE TABLE (docs-audit PLAN D3).
//
// The staging GATE was track-scoped (stagingMissingDocuments) while the files handed to the run
// were not: packagedDocumentsByType returned every document the project holds. Michael Sheridan's
// ELECTRICAL run (53266857) was handed 16 keys — among them the BCD 5952 building checklist, the
// utility bill and the meter photo (V6). The learn run (autoLearn.ts) and the correction/resubmit
// run (reopenCorrectionOnPortal) called the unfiltered policy directly (V18). And the gate's own
// PE-letter row carried no discipline, so it blocked the ELECTRICAL track of an engineered job
// (b0ab5169, ec5c36d3) over a document only the building permit files (V9).
//
// Now one table (backend/src/docDiscipline.ts) answers "which filing does this document belong
// to", read by the payload (submissionDocumentsByType(db, project, track) — every caller names its
// track) and by the gate. An AHJ track takes a utility document only when the AHJ's own required
// list names it (operator decision OD-4: the bill carries the account number).
//
// Real write paths: createProject, saveProjectDocument (project_documents + a file on disk), a
// stored template + its filled PDF (the ahjForms fill layout), materializeGeneratedDocs, the real
// autoLearnPortal (browser stubbed through its test seam) and reopenCorrectionOnPortal (runner
// injected). The shapes are the plan's (OR, separate building + electrical permits, prescriptive,
// Pacific Power; 5952 filled) — synthetic projects, no production data.
//
// KILLS:
//   - return the unfiltered map from submissionDocumentsByType → (x1)(x2)(x4)(g1) FAIL;
//   - drop structural_letter from DOC_DISCIPLINE → (p3) FAILS;
//   - pass null at autoLearn.ts's payload call → (L1) FAILS.
//
// Run: npx tsx backend/test/packagedByTrack.test.ts
import "./_isolate"; // FIRST: temp cwd, so filled/ and project-documents/ never land in the repo
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "packaged-by-track-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.RUN_TRIAGE = "off";
process.env.AUTOPILOT_TEST_SEAMS = "1";
process.env.AHJ_FORM_DOWNLOADS = "off"; // the learn path's form acquisition must not reach the network
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const repo = await import("../src/repository");
const { documentInventory, requiredListCheck } = await import("../src/requiredDocuments");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { storeAhjFormTemplate } = await import("../src/ahjFormAuto");
const { submissionDocumentsByType, uploadDocumentGuard } = await import("../src/submissionDocuments");
const { materializeGeneratedDocs } = await import("../src/generatedDocFiles");
const { DOC_DISCIPLINE } = await import("../src/docDiscipline");
const autoLearn = await import("../src/autoLearn");
const pp = await import("../src/permitProcess");

const db = await openDatabase();
let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

const client = createClient(db, { companyName: "Track Scope Solar", ccbLicenseNumber: "771122" });
let n = 0;
const mk = (permitPathOverride: string, ahj = "City of Coos Bay", city = "Coos Bay") => repo.createProject(db, {
  clientId: client.id, owner: `Track Owner ${++n}`, street: `${n} Track St`, city, state: "OR", zip: "97420",
  ahj, utility: "Pacific Power", dcKw: "8", acKw: "6.4", permitPathOverride,
}).project;

// Distinct bytes per document: byte-identical files are one document (duplicateUploads).
const save = (pid: string, docType: string): string => saveProjectDocument(db, pid, {
  docType, filename: `${docType}.pdf`, contentType: "application/pdf",
  buffer: Buffer.from(`%PDF-1.4\n% ${docType} for ${pid}\n`), source: "upload",
}).storedPath ?? "";
const PLAN_SET_FAMILY = ["plan_set", "site_plan", "sld", "structural", "module_spec", "inverter_spec", "labels"];
const UTILITY_FILES = ["utility_bill", "meter_photo"];

// A filled official form the way the fill path leaves it: a stored template (its form_type is the
// classification) and backend/data/filled/<pid>/tmpl-<id>.pdf under the (isolated) cwd. Stored
// under its own AHJ so the learn path's real buildFilledFormsForProject never re-fills or prunes it.
const FIXTURE_AHJ = "City of Trackscope Fixtures";
const fill = (pid: string, formType: string, filename: string): string => {
  const templateId = storeAhjFormTemplate(db, {
    ahjName: FIXTURE_AHJ, state: "OR", formType, filename,
    bytes: new Uint8Array(Buffer.from("%PDF-1.4 blank")),
    map: { formName: filename.replace(/\.pdf$/, ""), sourceUrl: "", fillMode: "acroform", textFields: {}, checkboxes: {}, notes: "" },
  });
  const dir = path.join(process.cwd(), "backend", "data", "filled", pid);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `tmpl-${templateId}.pdf`);
  fs.writeFileSync(file, `%PDF-1.4 filled ${formType}`);
  return file;
};

/** Michael-shaped: OR, separate building + electrical permits (Coos Bay's seeded flags), the
 *  PRESCRIPTIVE path, Pacific Power; the plan-set family, the utility bill and the meter photo
 *  uploaded; the BCD 5952 filled; the generated package rendered. */
const michaelShaped = async () => {
  const p = mk("prescriptive");
  for (const t of [...PLAN_SET_FAMILY, ...UTILITY_FILES]) save(p.id, t);
  fill(p.id, "solar_checklist", "BCD 440-5952 Prescriptive Solar Checklist.pdf");
  await materializeGeneratedDocs(db, p);
  return p;
};

const SHARED = new Set(Object.entries(DOC_DISCIPLINE).filter(([, d]) => d.lane === "shared").map(([t]) => t));
const michael = await michaelShaped();
const everything = submissionDocumentsByType(db, michael, null);

await check("PREMISE: the every-track map really does hold the 5952, the bill, the meter photo and the NEM worksheet — so every exclusion below is the filter's doing", () => {
  for (const t of ["plan_set", "solar_checklist", "utility_bill", "meter_photo", "utility_application", "generated_electrical_worksheet"]) {
    assert.ok(everything[t], `${t} is not in the unscoped map: ${JSON.stringify(Object.keys(everything))}`);
  }
  const list = requiredListCheck(db, michael, { required: [], presence: [], missingBlocking: [], missingAdvisory: [] });
  assert.ok(!list.items.some((i) => i.docTypes.includes("utility_bill") || i.docTypes.includes("meter_photo")),
    `the fixture AHJ's own list names a utility document, so OD-4 would admit it: ${JSON.stringify(list.items)}`);
});

// ---------------------------------------------------------------------------------------------
// MICHAEL ELECTRICAL
// ---------------------------------------------------------------------------------------------
await check("(p1) MUST-PASS, Michael electrical: the plan-set family + the electrical track's own documents, nothing else", () => {
  const ele = repo.packagedDocumentsByType(db, michael, "electrical");
  for (const t of PLAN_SET_FAMILY) assert.ok(ele[t], `the electrical run lost the shared ${t}`);
  assert.equal(ele.electrical_application, undefined, "no official electrical application is filled, so none is packaged (never the worksheet)");
  const allowed = new Set([...SHARED, "electrical_application", "pv_worksheet", "generated_electrical_worksheet",
    "application_transfer_sheet", "portal_entry_worksheet", "application_cover", "application_manifest", "bid_sheet"]);
  const stray = Object.keys(ele).filter((k) => !allowed.has(k));
  assert.deepEqual(stray, [], `the electrical run carries another filing's documents: ${JSON.stringify(stray)}`);
});
await check("(p1) …and once an official electrical application is filled, it IS the file that goes up", () => {
  const p = mk("prescriptive");
  for (const t of PLAN_SET_FAMILY) save(p.id, t);
  const official = fill(p.id, "electrical_application", "Coos Bay Electrical Permit Application.pdf");
  assert.equal(repo.packagedDocumentsByType(db, p, "electrical").electrical_application, official);
});
await check("(x1) MUST-EXCLUDE, Michael electrical: the 5952, the building/permit application, the utility bill, the meter photo, the NEM worksheet", () => {
  const ele = repo.packagedDocumentsByType(db, michael, "electrical");
  for (const t of ["solar_checklist", "building_application", "permit_application", "utility_bill", "meter_photo", "utility_application", "utility_package_zip", "generated_prescriptive_worksheet"]) {
    assert.equal(ele[t], undefined, `the ELECTRICAL run was handed ${t}`);
  }
});

// ---------------------------------------------------------------------------------------------
// MICHAEL BUILDING
// ---------------------------------------------------------------------------------------------
const building = fill(michael.id, "building_application", "Coos Bay Residential Building Permit Application.pdf");
await check("(p2) MUST-PASS, Michael building: the 5952 and the building application go up with the plan set", () => {
  const bld = repo.packagedDocumentsByType(db, michael, "building");
  assert.ok(bld.solar_checklist, `the building run lost the BCD 5952: ${JSON.stringify(Object.keys(bld))}`);
  assert.equal(bld.building_application, building, "the building run lost its application");
  assert.ok(bld.plan_set && bld.sld && bld.site_plan, "…and the shared plan-set family");
});
await check("(x2) MUST-EXCLUDE, Michael building: the utility bill, the meter photo, the electrical track's worksheet", () => {
  const bld = repo.packagedDocumentsByType(db, michael, "building");
  for (const t of ["utility_bill", "meter_photo", "utility_application", "generated_electrical_worksheet"]) {
    assert.equal(bld[t], undefined, `the BUILDING run was handed ${t}`);
  }
});
await check("(p2b) a COMBINATION permit (one filing, both trades) and the discipline-less 'permit' track take both applications — never the utility's files", () => {
  for (const track of ["combo", "permit"] as const) {
    const docs = repo.packagedDocumentsByType(db, michael, track);
    assert.ok(docs.solar_checklist && docs.building_application && docs.generated_electrical_worksheet, `${track}: ${JSON.stringify(Object.keys(docs))}`);
    assert.equal(docs.utility_bill, undefined, `${track} was handed the utility bill`);
  }
});

// ---------------------------------------------------------------------------------------------
// THE GATE: the PE letter belongs to the building permit (V9)
// ---------------------------------------------------------------------------------------------
await check("(p3) MUST-PASS, ec5c36d3-shaped (engineered, PE letter missing): electrical staging does NOT 409 on the PE letter; building staging still does", () => {
  const p = mk("engineered");
  for (const t of PLAN_SET_FAMILY) save(p.id, t);
  const inv = documentInventory(db, p);
  assert.ok(inv.missingBlocking.some((d) => d.docType === "structural_letter"),
    `PREMISE: the engineered job owes a blocking PE letter: ${JSON.stringify(inv.missingBlocking.map((d) => d.docType))}`);
  const eleGate = repo.stagingMissingDocuments(inv, "electrical").map((d) => d.docType);
  assert.ok(!eleGate.includes("structural_letter"), `the ELECTRICAL track 409s on the PE letter: ${JSON.stringify(eleGate)}`);
  assert.ok(repo.stagingMissingDocuments(inv, "building").some((d) => d.docType === "structural_letter"),
    "the BUILDING track must still refuse without the sealed letter");
  assert.ok(repo.stagingMissingDocuments(inv, "combo").some((d) => d.docType === "structural_letter"),
    "…and so must a combination permit");
});

// ---------------------------------------------------------------------------------------------
// POWERCLERK NEM (29cd57b5-shaped, Pacific Power)
// ---------------------------------------------------------------------------------------------
await check("(p4) MUST-PASS, PowerClerk NEM: the meter photo, the SLD, the site plan (and the bill and the NEM worksheet)", () => {
  const nem = repo.packagedDocumentsByType(db, michael, "nem");
  for (const t of ["meter_photo", "sld", "site_plan", "plan_set", "inverter_spec", "utility_bill", "utility_application"]) {
    assert.ok(nem[t], `the NEM run lost ${t}: ${JSON.stringify(Object.keys(nem))}`);
  }
});
await check("(x4) MUST-EXCLUDE, PowerClerk NEM: the 5952, the building application, every AHJ-only sheet", () => {
  const nem = repo.packagedDocumentsByType(db, michael, "nem");
  const ahjOnly = Object.keys(nem).filter((k) => ["solar_checklist", "building_application", "electrical_application", "permit_application",
    "application_transfer_sheet", "portal_entry_worksheet", "application_cover", "application_manifest"].includes(k) || k.startsWith("generated_"));
  assert.deepEqual(ahjOnly, [], "the utility run was handed AHJ documents");
});

// ---------------------------------------------------------------------------------------------
// OD-4: an AHJ whose OWN list names the utility bill gets it (the exclusion is not a blanket ban)
// ---------------------------------------------------------------------------------------------
await check("(p5) MUST-PASS, OD-4: an AHJ whose cited per-job list names the utility bill receives it — and still not the meter photo", () => {
  const cite = (value: unknown, quote: string) => ({ value, sourceUrl: "https://billsburg.example.gov/solar", quote, origin: "lookup" as const });
  const none = () => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "not searched" });
  const saved = pp.savePermitProcessLookup(db, {
    state: "OR", ahj: "City of Billsburg", lookedUpAt: new Date().toISOString(),
    issuingAgency: cite("City of Billsburg", "The City of Billsburg issues solar permits"),
    permitStructure: cite("combo", "one combination permit"),
    permits: [{
      discipline: "structural", label: "Solar permit", issuingAgency: cite("City of Billsburg", "The city issues it"),
      portalUrl: none(), recordType: none(), fee: none(),
      documents: cite(["Plan set", "Copy of the customer's most recent utility bill"], "Submit a plan set and a copy of the most recent utility bill"),
    }],
  } as never) as { saved: boolean; reason?: string };
  assert.ok(saved.saved, `lookup saved: ${saved.reason}`);
  const p = mk("prescriptive", "City of Billsburg", "Billsburg");
  for (const t of [...PLAN_SET_FAMILY, ...UTILITY_FILES]) save(p.id, t);
  assert.equal(requiredListCheck(db, p, { required: [], presence: [], missingBlocking: [], missingAdvisory: [] }).source, "lookup", "PREMISE: the AHJ's own list is read");
  const docs = repo.packagedDocumentsByType(db, p, "building");
  assert.ok(docs.utility_bill, `the AHJ names the bill, so its building run carries it: ${JSON.stringify(Object.keys(docs))}`);
  assert.equal(docs.meter_photo, undefined, "the list does not name the meter photo");
});

// ---------------------------------------------------------------------------------------------
// THE ATTACH-TIME GUARD compares against the same scoped map; an omitted track fails loudly
// ---------------------------------------------------------------------------------------------
await check("(g1) the attach-time guard refuses an out-of-track document for a scoped run, and passes the run's own", () => {
  const guard = uploadDocumentGuard(db, michael.id, { track: "electrical" });
  assert.throws(() => guard("utility_bill", everything.utility_bill), /document changed or no longer matches/);
  assert.throws(() => guard("solar_checklist", everything.solar_checklist), /electrical filing/);
  assert.doesNotThrow(() => guard("plan_set", everything.plan_set));
  // The legacy boolean form (its callers are outside this round) compares every track, as before.
  assert.doesNotThrow(() => uploadDocumentGuard(db, michael.id, true)("utility_bill", everything.utility_bill));
});
await check("(t1) a caller that omits the track is refused, never handed everything", () => {
  assert.throws(() => (submissionDocumentsByType as unknown as (a: unknown, b: unknown) => unknown)(db, michael), /name the track/);
});

// ---------------------------------------------------------------------------------------------
// THE LEARN RUN (autoLearn.ts payload call) — the path Michael's building track will use
// ---------------------------------------------------------------------------------------------
type Seen = { docsByType?: Record<string, string> };
let seen: Seen | null = null;
const stubLearn = { ok: false, portalName: "stub", steps: [], reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 0, pauseReason: null, message: "stub learn: nothing walked" };
autoLearn.setAutoLearnSeamsForTests({ learnPortal: (async (input: Seen) => { seen = input; return { ...stubLearn }; }) as never });
const learnDocs = async (projectId: string, input: { scope: "ahj" | "utility"; permitType?: "structural" | "electrical" }, url: string) => {
  seen = null;
  await autoLearn.autoLearnPortal(db, projectId, { scope: input.scope, portalUrl: url, createdBy: "operator", permitType: input.permitType });
  assert.ok(seen, "the stub launcher was reached");
  return (seen as Seen).docsByType ?? {};
};
await check("(L1) MUST-EXCLUDE, the learn call site: a BUILDING-track learn is handed the 5952 and the plan set, never the utility bill or the meter photo", async () => {
  const docs = await learnDocs(michael.id, { scope: "ahj", permitType: "structural" }, "https://aca-oregon.accela.com/oregon/");
  assert.ok(docs.plan_set && docs.solar_checklist, `the building learn lost its own documents: ${JSON.stringify(Object.keys(docs))}`);
  for (const t of ["utility_bill", "meter_photo", "utility_application", "generated_electrical_worksheet"]) {
    assert.equal(docs[t], undefined, `the BUILDING learn was handed ${t}`);
  }
});
await check("(L2) …and a UTILITY learn is handed the meter photo, never the 5952", async () => {
  const docs = await learnDocs(michael.id, { scope: "utility" }, "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login");
  assert.ok(docs.meter_photo && docs.plan_set, `the NEM learn lost its documents: ${JSON.stringify(Object.keys(docs))}`);
  assert.equal(docs.solar_checklist, undefined, "the NEM learn was handed the building checklist");
});

// ---------------------------------------------------------------------------------------------
// THE CORRECTION / RESUBMIT RUN (reopenCorrectionOnPortal)
// ---------------------------------------------------------------------------------------------
await check("(R1) MUST-EXCLUDE, correction reopen: a BUILDING filing's reopen carries the building documents, never the utility's; the NEM reopen the reverse", async () => {
  const now = new Date().toISOString();
  db.run(`INSERT INTO submissions (id, project_id, submission_type, status, application_number, permit_type, created_at)
    VALUES (?, ?, 'permit', 'submitted', '187-26-000901-STR', 'building', ?)`, [`sub-bld-${michael.id}`, michael.id, now]);
  const bldTarget = repo.createPermitCheckTarget(db, michael.id, {
    targetType: "permit", permitType: "building", applicationNumber: "187-26-000901-STR",
    portalName: "Oregon ePermitting", portalUrl: "https://aca-oregon.accela.com/oregon/Cap/CapHome.aspx", checkFrequencyDays: 14,
  } as never) as unknown as { id?: string };
  const nemTarget = repo.createPermitCheckTarget(db, michael.id, {
    targetType: "nem", permitType: "nem", applicationNumber: "APP-900901",
    portalName: "Pacific Power", portalUrl: "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login", checkFrequencyDays: 14,
  } as never) as unknown as { id?: string };
  const targetId = (appNo: string, made: { id?: string }) => made?.id
    ?? String(db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? AND application_number = ?", [michael.id, appNo])?.id);
  const correction = repo.addManualCorrection(db, michael.id, "Record 187-26-000901-STR: revise the attachment detail on the structural sheet.");
  const correctionId = correction.corrections[0].id;
  let handed: Record<string, string> = {};
  const runner = (async (_recipe: unknown, _app: unknown, docsByType: Record<string, string>) => {
    handed = docsByType;
    return { ok: true, needsHuman: false, finalSubmitClicked: false, finalSubmitClickedByAutomation: false, reopenedForm: "Correction", attachedDocs: 0, browserLeftOpen: false, message: "", offeredForms: [] };
  }) as never;

  await repo.reopenCorrectionOnPortal(db, correctionId, { targetId: targetId("187-26-000901-STR", bldTarget), runner });
  assert.ok(handed.plan_set && handed.solar_checklist, `the building reopen lost its documents: ${JSON.stringify(Object.keys(handed))}`);
  for (const t of ["utility_bill", "meter_photo", "utility_application"]) assert.equal(handed[t], undefined, `the BUILDING reopen was handed ${t}`);

  handed = {};
  await repo.reopenCorrectionOnPortal(db, correctionId, { targetId: targetId("APP-900901", nemTarget), runner });
  assert.ok(handed.meter_photo, `the NEM reopen lost the meter photo: ${JSON.stringify(Object.keys(handed))}`);
  assert.equal(handed.solar_checklist, undefined, "the NEM reopen was handed the building checklist");
});

try { db.close(); } catch { /* best effort */ }
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0 ? "\npackagedByTrack: all checks passed." : `\npackagedByTrack: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
