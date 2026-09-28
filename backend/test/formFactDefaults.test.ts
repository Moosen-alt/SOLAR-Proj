// FORM FACTS THE OPERATOR SETTLED BY DEFAULT (operator rulings 2026-09-28, verbatim):
//   "Assume 1-2 layers is good."
//   "Single family most of the time, but can be an ADU/Accessory/garage you can see it on the
//    plan-set how its laid out"
//
// Oregon's BCD 5952 asks two facts a plan set rarely states outright, and a real job whose plan set
// read "<NAME> RESIDENCE", one dwelling unit, array on the house, was ASKED both.
//
// (R) ROOF LAYERS — ONE predicate (roofCovering.oregonRoofingRow) answers "does the roofing row
//     pass" for the 5952 fill (bcdChecklistFacts), the permit-path screen (permitPath) and the
//     form-fact questions: an UNSTATED count on a composition / wood roof passes on the default and
//     says so; a STATED count always wins ("3 or more" fails the row and routes engineered). The
//     default never types a number into a box (snapshot.roofLayers stays blank).
//
// Synthetic projects only (fictional names), a scratch DB, the real write paths (createProject /
// updateProject / answerPortalQuestions). Run: npx tsx backend/test/formFactDefaults.test.ts
//
// KILLS (each run by hand, RED then restored GREEN):
//   K-R1 roofCovering.oregonRoofingRow: unstated comp/wood back to `qualifies: null` -> R1, R2 FAIL
//        (and bcd5952Complete q1, q4).
//   K-R2 bcdChecklistFacts.bcd5952AssumedFacts pushes nothing                           -> R1, R2 FAIL.
//   K-R3 permitPath: drop the assumed-layers basis line                                 -> R1 FAILS.
//   K-R4 formFactQuestions back to `!has("roofLayers")` (not the row predicate)         -> R1, R2 FAIL.
import "./_isolate"; // FIRST
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "form-fact-defaults-"));
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
const pp = await import("../src/permitPath");

let failures = 0; let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const client = clients.createClient(db, { companyName: "Defaults Test Solar LLC", ccbLicenseNumber: "900003" });
// Every other 5952 row passes (trusses at 24, attachments 24 in to framing, 20 psf, 110 mph Exp C).
const JOB = {
  owner: "Pat Example", street: "12 Fictional Rd", city: "Maple Hollow", state: "OR", zip: "97352", ahj: "City of Maple Hollow",
  utility: "Test Electric", dcKw: "6", acKw: "5", moduleMake: "Example", moduleModel: "EX-440", mounting: "Roof Mount",
  roofMaterial: "Composition Shingle", framingType: "truss", roofRafterSpacing: "24", attachmentToFraming: "yes",
  attachmentSpacingIn: "24", gravityWindDesign: "yes", manufacturerInstallation: "yes",
  snow: "20", deadLoad: "3", wind: "C", windSpeed: "110",
};
const make = (over: Record<string, unknown> = {}) => repo.createProject(db, { clientId: client.id, ...JOB, ...over } as never).project;
const reload = (id: string) => repo.getProjectDetail(db, id).project;
const askedKeys = async (id: string) => (await intake.unansweredPortalQuestions(db, reload(id))).map((q) => q.key);
const def5952 = () => ({ id: "bcd-defaults", formName: "BCD 5952", matchJurisdictions: [], sourceUrl: "", version: "stored", status: "verified",
  fillMode: "acroform", recoverPrescriptiveCheckboxes: true, textFields: {} }) as never;
const bytes5952 = fs.readFileSync(path.join(REPO, "backend/test/fixtures/bcd-5952-2024.pdf"));
const fill5952 = async (id: string, name: string) => {
  const p = reload(id);
  return forms.fillLoadedForm(def5952(), bytes5952, forms.buildContext(db, p), path.join(tmp, `${name}.pdf`));
};

try {
  // ── (R) roof layers ────────────────────────────────────────────────────────────────────
  await check("(R1) MUST-PASS: comp roof, layer count unstated -> roofing row Yes, not asked, path prescriptive, the default NAMED in the fill note and the path basis", async () => {
    const p = make();
    assert.equal(facts.bcdChecklistAnswers(reload(p.id)).roofing, "Yes");
    assert.ok(!(await askedKeys(p.id)).includes("roofLayers"), "the layer count is not asked");
    const r = pp.resolvePermitPath(reload(p.id));
    assert.equal(r.path, "prescriptive", r.basis.join(" "));
    assert.match(r.basis.join(" "), /Roofing: roof layer count not stated — assumed 1-2 layers of composition \(operator ruling 2026-09-28/);
    const res = await fill5952(p.id, "r1");
    assert.match(String(res.message), /Assumed: roofing row: Yes — roof layer count not stated — assumed 1-2 layers of composition \(operator ruling 2026-09-28/);
    assert.doesNotMatch(String(res.message), /Still needs evidence:[^.]*layer/);
    // The default is a checklist answer, never a typed number: the layer box stays blank.
    assert.equal(forms.resolveSource("snapshot.roofLayers", forms.buildContext(db, reload(p.id))), "");
  });

  await check("(R2) MUST-PASS: a wood roof with no count passes on the default too, said as ONE layer (the row admits one)", async () => {
    const p = make({ roofMaterial: "Cedar Shake" });
    assert.equal(facts.bcdChecklistAnswers(reload(p.id)).roofing, "Yes");
    assert.match(facts.bcd5952AssumedFacts(reload(p.id))[0].assumed, /assumed a single layer of wood shingles\/shakes/);
    assert.ok(!(await askedKeys(p.id)).includes("roofLayers"));
  });

  await check("(R3) MUST-EXCLUDE: an explicit answer always wins — '3 or more' is No and routes ENGINEERED; a wood '2' is No; a stated '1' is Yes with nothing assumed", async () => {
    const three = make();
    repo.updateProject(db, three.id, { roofLayers: "3 or more" } as never);
    assert.equal(facts.bcdChecklistAnswers(reload(three.id)).roofing, "No");
    assert.deepEqual(facts.bcd5952AssumedFacts(reload(three.id)), []);
    const r = pp.resolvePermitPath(reload(three.id));
    assert.equal(r.path, "engineered", r.basis.join(" "));
    assert.match(r.basis.join(" "), /roofing row admits no more than two layers/);
    assert.doesNotMatch(r.basis.join(" "), /assumed 1-2 layers/);
    assert.ok(!(await askedKeys(three.id)).includes("roofLayers"));
    const wood2 = make({ roofMaterial: "Cedar Shake", roofLayers: "2" });
    assert.equal(facts.bcdChecklistAnswers(reload(wood2.id)).roofing, "No");
    const one = make({ roofLayers: "1" });
    assert.equal(facts.bcdChecklistAnswers(reload(one.id)).roofing, "Yes");
    assert.deepEqual(facts.bcd5952AssumedFacts(reload(one.id)), []);
    assert.doesNotMatch(String((await fill5952(one.id, "r3")).message), /Assumed:/);
    assert.doesNotMatch(pp.resolvePermitPath(reload(one.id)).basis.join(" "), /assumed 1-2 layers/);
  });

  await check("(R4) MUST-EXCLUDE: the default is for composition / wood only — metal names no assumption, tile is No, no material stays blank", async () => {
    const metal = make({ roofMaterial: "Standing seam metal" });
    assert.equal(facts.bcdChecklistAnswers(reload(metal.id)).roofing, "Yes");
    assert.deepEqual(facts.bcd5952AssumedFacts(reload(metal.id)), []);
    const tile = make({ roofMaterial: "Concrete Tile" });
    assert.equal(facts.bcdChecklistAnswers(reload(tile.id)).roofing, "No");
    assert.equal(pp.resolvePermitPath(reload(tile.id)).path, "engineered");
    const none = make({ roofMaterial: "" });
    assert.equal(facts.bcdChecklistAnswers(reload(none.id)).roofing, "");
    assert.deepEqual(facts.bcd5952AssumedFacts(reload(none.id)), []);
    // Outside Oregon the row is not Oregon's to assume: no basis line.
    const wa = make({ state: "WA", ahj: "City of Maple Hollow WA", zip: "98000" });
    assert.doesNotMatch(pp.resolvePermitPath(reload(wa.id)).basis.join(" "), /assumed 1-2 layers/);
  });
} finally {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nformFactDefaults: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
