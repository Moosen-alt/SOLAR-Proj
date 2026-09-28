// THE BCD 5952 FRAMING AND ATTACHMENT ROWS ANSWER, OR ASK (dry-run 2026-09-28, B4).
//
// A comp-shingle job with attachments 48 in o.c. at 120 mph Exposure C printed its attachment row
// BLANK: Method 1 correctly answered No (48-in spacing is capped at 110 mph in Exposure C, the form's
// own clause 2.b.3.b), but Method 2 — the STANDING-SEAM METAL clamp method — read "unknown" on a
// shingle roof, so any(No, unknown) printed nothing, and no question could ever fill it. The framing
// row sat blank on rafters at 24 in: the R324.4.1 exception is stated nowhere and nothing asked it.
// A row that answered No went out silently (the fill note named only blank rows).
//
//   (a) Method 2 is gated on the roof-covering classifier (roofCovering.ts, the one predicate).
//   (b) A No row is named with the clause that failed (bcd5952FailedRows — read by the fill note).
//   (d) The rafter exception is ASKED (a form-fact question), answered into the project.
//   The roof-layer count is assumed 1-2 layers when unstated (operator ruling 2026-09-28), named as such.
//
// Synthetic projects only. Run: npx tsx backend/test/bcd5952RowsAnswered.test.ts
import "./_isolate"; // FIRST
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcd5952-rows-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const repo = await import("../src/repository");
const clients = await import("../src/clients");
const intake = await import("../src/intakeRequests");
const facts = await import("../src/bcdChecklistFacts");
const forms = await import("../src/ahjForms");
const { extractLabels } = await import("../src/formTextLayer");

let failures = 0; let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const client = clients.createClient(db, { companyName: "Rowcheck Test Solar LLC", ccbLicenseNumber: "900002" });
// The dry-run's design, synthetic: comp shingle, trusses at 24, attachments 48 in o.c. (24 in at the
// edges), 20 psf snow, 120 mph Exposure C.
const JOB = {
  owner: "Row Test Owner", street: "7 Synthetic Way", city: "Maple Hollow", state: "OR", zip: "97352", ahj: "City of Maple Hollow",
  utility: "Test Electric", dcKw: "6", acKw: "5", moduleMake: "Example", moduleModel: "EX-440", mounting: "Roof Mount",
  roofMaterial: "Composition Shingle", framingType: "truss", roofRafterSpacing: "24", attachmentToFraming: "yes",
  attachmentSpacingIn: "48", attachmentEdgeSpacingIn: "24", gravityWindDesign: "yes", manufacturerInstallation: "yes",
  snow: "20", deadLoad: "3", wind: "C", windSpeed: "120",
};
const make = (over: Record<string, string> = {}) => repo.createProject(db, { clientId: client.id, ...JOB, ...over } as never).project;
const reload = (id: string) => repo.getProjectDetail(db, id).project;

try {
  await check("(a1) MUST-PASS: comp shingle, 48 in at 120 mph Exposure C — Method 1 No, Method 2 No (not metal), the attachment row prints No", () => {
    const a = facts.bcdChecklistAnswers(make());
    assert.equal(a.method1, "No");
    assert.equal(a.method2, "No", "Method 2 is the standing-seam metal method: a shingle roof answers it No, never unknown");
    assert.equal(a.attachments, "No");
  });

  await check("(a2) MUST-PASS: the deck-mount reading of the same plan set answers the attachment row No too (an uncertain reading does not blank it)", () => {
    assert.equal(facts.bcdChecklistAnswers(make({ attachmentToFraming: "no" })).attachments, "No");
  });

  await check("(a3) MUST-PASS: attachments at 24 in answer Yes, and no row is reported No", () => {
    const p = make({ attachmentSpacingIn: "24", roofLayers: "1" });
    assert.equal(facts.bcdChecklistAnswers(p).attachments, "Yes");
    assert.deepEqual(facts.bcd5952FailedRows(p), []);
  });

  await check("(a4) MUST-EXCLUDE: a METAL roof with no standing-seam statement leaves Method 2 blank (a question, not a No); an unnamed covering too", () => {
    const metal = facts.bcdChecklistAnswers(make({ roofMaterial: "Standing seam metal" }));
    assert.equal(metal.method2, "");
    assert.equal(metal.attachments, "", "Method 1 No + Method 2 unknown stays blank on a metal roof");
    assert.equal(facts.bcdChecklistAnswers(make({ roofMaterial: "" })).method2, "");
    assert.equal(facts.bcdChecklistAnswers(make({ roofMaterial: "Standing seam metal", standingSeamMethod2Compliant: "yes" })).attachments, "Yes");
  });

  await check("(b1) MUST-PASS: the No row is named with the clause that failed — the 110 mph cap at Exposure C, and why Method 2 cannot apply", () => {
    const failed = facts.bcd5952FailedRows(make());
    assert.deepEqual(failed.map((f) => f.row), ["attachments"]);
    const clause = failed[0].clause;
    assert.match(clause, /attachment method compliance: No/, "the App Docs mirror's needle");
    assert.match(clause, /110 mph or less at Exposure C \(plan 120 mph\)/);
    assert.match(clause, /spaced 48 in/);
    assert.match(clause, /standing-seam metal panels only/);
  });

  await check("(b2) MUST-EXCLUDE: a BLANK row is never reported No (it stays a missing fact)", () => {
    // The roof layer count no longer blanks the row (it is assumed — operator ruling 2026-09-28);
    // a roof MATERIAL nobody stated still does.
    const p = make({ roofMaterial: "" });
    assert.equal(facts.bcdChecklistAnswers(p).roofing, "");
    assert.ok(!facts.bcd5952FailedRows(p).some((f) => f.row === "roofing"));
    assert.ok(facts.bcd5952MissingFacts(p).some((m) => m.row === "roofing" && m.missing === "roof material"), "the roof material is named as missing");
  });

  await check("(b3) MUST-PASS: the filled 5952 says the No row, with its clause, in the fill note — and draws its No", async () => {
    const bytes = fs.readFileSync(path.join(REPO, "backend/test/fixtures/bcd-5952-2024.pdf"));
    const def = { id: "bcd-rows", formName: "BCD 5952", matchJurisdictions: [], sourceUrl: "", version: "stored", status: "verified",
      fillMode: "acroform", recoverPrescriptiveCheckboxes: true, textFields: {} } as never;
    const p = make({ roofLayers: "1" });
    const out = path.join(tmp, "rows.pdf");
    const result = await forms.fillLoadedForm(def, bytes, { project: p, client: {}, snapshot: p.parserSnapshot } as never, out);
    assert.match(String(result.message), /Answers No \(the checklist says a No row may not be submitted on the prescriptive path\): attachment method compliance: No/);
    assert.doesNotMatch(String(result.message), /Still needs evidence:[^.]*attachment method compliance[^:]/, "the attachment row is answered, not missing");
    const marks = (await extractLabels(fs.readFileSync(out))).filter((i) => i.str === "X").length;
    assert.ok(marks >= 9, `every row answered, the attachment row included (got ${marks} X marks)`);
  });

  await check("(d1) MUST-PASS: rafters at 24 in with no exception statement are ASKED, and the answer fills the framing row", async () => {
    const p = make({ framingType: "rafter", roofLayers: "1", attachmentSpacingIn: "24" });
    assert.equal(facts.bcdChecklistAnswers(p).framing, "");
    const qs = await intake.unansweredPortalQuestions(db, p);
    const q = qs.find((x) => x.key === "rafterExceptionCompliant");
    assert.ok(q, `rafter exception not asked: ${qs.map((x) => x.key).join(",")}`);
    assert.deepEqual([...q!.options], ["Yes", "No"]);
    assert.match(facts.bcd5952MissingFacts(p).find((m) => m.row === "framing")!.missing, /operator question/);
    await intake.answerPortalQuestions(db, p.id, { rafterExceptionCompliant: "Yes" });
    const after = reload(p.id);
    assert.equal(facts.bcdChecklistAnswers(after).framing, "Yes");
    assert.ok(!(await intake.unansweredPortalQuestions(db, after)).some((x) => x.key === "rafterExceptionCompliant"), "answered, no longer asked");
    const no = make({ framingType: "rafter", rafterExceptionCompliant: "No", roofLayers: "1", attachmentSpacingIn: "24" });
    assert.match(facts.bcd5952FailedRows(no).find((f) => f.row === "framing")!.clause, /R324\.4\.1 Exception 1\.4-1\.6/);
  });

  await check("(d2) MUST-EXCLUDE: trusses, rafters over 24 in, or an unknown spacing are not asked the rafter exception", () => {
    const keys = (over: Record<string, string>) => facts.formFactQuestions(make(over), { checklistApplies: true }).map((x) => x.key);
    assert.ok(!keys({}).includes("rafterExceptionCompliant"), "trusses");
    assert.ok(!keys({ framingType: "rafter", roofRafterSpacing: "32" }).includes("rafterExceptionCompliant"), "over 24 in — the row is No on spacing, nothing to ask");
    assert.ok(!keys({ framingType: "rafter", roofRafterSpacing: "" }).includes("rafterExceptionCompliant"), "spacing unknown");
    assert.ok(!facts.formFactQuestions(make({ framingType: "rafter" }), { checklistApplies: false }).some((x) => x.key === "rafterExceptionCompliant"), "not where the checklist does not apply");
  });

  await check("(r1) an unstated roof-layer count is ASSUMED 1-2 layers (operator ruling 2026-09-28): row Yes, not asked, named as assumed", async () => {
    const p = make({ roofLayers: "", attachmentSpacingIn: "24" });
    assert.equal(facts.bcdChecklistAnswers(p).roofing, "Yes");
    assert.ok(!facts.formFactQuestions(p, { checklistApplies: true }).some((q) => q.key === "roofLayers"));
    assert.ok(!facts.bcd5952MissingFacts(p).some((m) => m.row === "roofing"));
    assert.match(facts.bcd5952AssumedFacts(p).find((f) => f.row === "roofing")!.assumed, /assumed 1-2 layers of composition \(operator ruling 2026-09-28/);
    // A stated count is never assumed over: 1 is Yes with nothing assumed, 3 or more is No.
    assert.deepEqual(facts.bcd5952AssumedFacts(make({ roofLayers: "1", attachmentSpacingIn: "24" })), []);
    assert.equal(facts.bcdChecklistAnswers(make({ roofLayers: "3 or more", attachmentSpacingIn: "24" })).roofing, "No");
  });
} finally {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nbcd5952RowsAnswered: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
