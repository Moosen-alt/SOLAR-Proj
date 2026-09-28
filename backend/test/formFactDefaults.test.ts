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
// (S) THE STRUCTURE — derived from the plan set when no person answered it, by ONE derivation
//     (frontend/parser-review.js structureBasis: the parser page runs it at save, the server loads
//     the same file and runs it at read time — applicationDocsAgency.structureDescriptionOf), read
//     by every door: formFactQuestions (asked only with no evidence), the fill context (the BCD 5952
//     "Structure description" box), the one structure predicate (Coos County / Marion forms, the
//     Iowa worksheet), and the fill note (the words that decided it). The ARRAY's building decides,
//     never every structure on the lot; a person's answer always wins.
//
// Synthetic projects only (fictional names), a scratch DB, the real write paths (createProject /
// updateProject / answerPortalQuestions / a plan-set PDF upload). Run:
//   npx tsx backend/test/formFactDefaults.test.ts
//
// KILLS (each run by hand, RED then restored GREEN):
//   K-R1 roofCovering.oregonRoofingRow: unstated comp/wood back to `qualifies: null` -> R1, R2 FAIL
//        (and bcd5952Complete q1, q4).
//   K-R2 bcdChecklistFacts.bcd5952AssumedFacts pushes nothing                           -> R1, R2 FAIL.
//   K-R3 permitPath: drop the assumed-layers basis line                                 -> R1 FAILS.
//   K-R4 formFactQuestions back to `!has("roofLayers")` (not the row predicate)         -> R1, R2 FAIL.
//   K-S1 structureDescriptionOf never derives                              -> S1 S2 S3 S4 S6 S7 FAIL.
//   K-S2 formFactQuestions back to `!has("structureDescription")`          -> S2, S3 FAIL.
//   K-S3 buildContext does not overlay the derived answer                  -> S2, S3 FAIL.
//   K-S4 structureAnswerOf ignores the derivation (project-snapshot readers) -> S9 FAILS.
//   K-S5 the fill note drops the structure evidence                        -> S2, S3 FAIL.
//   K-S6 the parser page writes structureDescription (the person's key)    -> S7 FAILS.
//   K-S7 a garage counts without "DETACHED"                                -> S1 FAILS.
//   K-S8 any structure named on the lot decides (not the array's)          -> S1, S3, S4 FAIL.
//   K-S9 a bare "PANEL" is read as the array (SUBPANEL AT DETACHED GARAGE) -> S1 FAILS.
//   K-S10 a derived answer contradicting a stated "Other" / "Duplex" is taken -> S6 FAILS.
//   K-S11 the page reads a manufactured-home mention itself (no defer)     -> S1, S7 FAIL.
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
const agency = await import("../src/applicationDocsAgency");
const docs = await import("../src/projectDocuments");
const { curatedFormMap } = await import("../src/curatedAhjForms");
const { extractLabels } = await import("../src/formTextLayer");
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const vm = await import("node:vm");

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
const bytes5952 = fs.readFileSync(path.join(REPO, "backend/test/fixtures/bcd-5952-2024.pdf"));
// The built-in map for the exact blank (what production fills it with), answers recovered at fill.
const { bcd5952Template } = await import("../src/bcd5952Template");
const map5952 = bcd5952Template(bytes5952, "https://www.oregon.gov/bcd/Formslibrary/5952.pdf");
assert.ok(map5952, "the fixture is the exact BCD 5952 blank");
// (Its notes are one string; a stored row carries them as a list — ahjForms wraps them the same way.)
const def5952 = () => ({ ...map5952, notes: map5952?.notes ? [map5952.notes] : [], id: "bcd-defaults", matchJurisdictions: [], version: "stored", status: "verified", recoverPrescriptiveCheckboxes: true }) as never;
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

  // ── (S) the structure the array is on ────────────────────────────────────────────────────
  // The page's own file, loaded as the browser (and parserReviewList) loads it.
  const prSandbox: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(REPO, "frontend", "parser-review.js"), "utf8"), prSandbox);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PR = prSandbox.window.ParserReview as any;
  const SF = "Single-family dwelling", DUP = "Two-family dwelling (duplex)", TOWN = "Townhouse", MFG = "Manufactured home", ACC = "Accessory building (garage/shed)";
  // [case, plan text, the server's answer, the page's answer ("defer" = the page stores nothing)]
  const TABLE: Array<[string, string, string, string]> = [
    ["residence", "PAT EXAMPLE RESIDENCE  PV-1 COVER SHEET", SF, SF],
    ["array on a detached garage", "PAT EXAMPLE RESIDENCE  SITE PLAN  (N) PV ARRAY ON (E) DETACHED GARAGE", ACC, ACC],
    ["array on the roof of the detached garage", "PAT EXAMPLE RESIDENCE  (N) MODULES INSTALLED ON THE ROOF OF THE EXISTING DETACHED GARAGE", ACC, ACC],
    ["ADU", "PAT EXAMPLE RESIDENCE  (N) SOLAR PANELS ON ADU ROOF", ACC, ACC],
    ["accessory dwelling unit", "MODULES MOUNTED ON ACCESSORY DWELLING UNIT  SITE PLAN", ACC, ACC],
    ["shed / barn", "PAT EXAMPLE RESIDENCE  PV ARRAY ON (N) SHED", ACC, ACC],
    ["duplex", "PAT EXAMPLE DUPLEX  UNITS: 2  ARRAY ON ROOF", DUP, DUP],
    ["two-family", "TWO-FAMILY DWELLING  PV-1", DUP, DUP],
    ["townhouse", "PAT EXAMPLE TOWNHOUSE  PV ON ROOF", TOWN, TOWN],
    ["manufactured home", "PAT EXAMPLE RESIDENCE  THIS PROJECT IS A MANUFACTURED HOME (HUD) ON A PERMANENT FOUNDATION", MFG, "defer"],
    ["an attached garage is the house", "PAT EXAMPLE RESIDENCE  (N) PV ARRAY ON ATTACHED GARAGE", SF, SF],
    ["dwelling units 1, no words", "PV-1 COVER SHEET", "", ""],
    // MUST-EXCLUDE
    ["(E) SHED / EXISTING DETACHED GARAGE merely drawn", "PAT EXAMPLE RESIDENCE  SITE PLAN  (E) SHED  EXISTING DETACHED GARAGE  (N) PV ARRAY ON (E) ROOF", SF, SF],
    ["a SUBPANEL at the detached garage is not the array", "PAT EXAMPLE RESIDENCE  (N) PV SUBPANEL AT DETACHED GARAGE", SF, SF],
    ["'2 UNIT DEPTH' racking text is not a duplex", "PAT EXAMPLE RESIDENCE  Unit Depth x Unit Width / 2 Unit Depth = 7.60 in.", SF, SF],
    ["a revision tag 'REV R3' is not an occupancy", "PV 0.0 COVER  REV R3  100 EXAMPLE RD", "", ""],
    ["no evidence at all", "PV-1 COVER SHEET  SCALE: NTS", "", ""],
    ["'ARRAY ON GARAGE' without attached/detached is asked", "PAT EXAMPLE RESIDENCE  (N) PV ARRAY ON GARAGE", "", ""],
    ["a triplex is asked", "PAT EXAMPLE TRIPLEX RESIDENCE", "", ""],
    ["R-2 occupancy is asked", "OCCUPANCY: R-2  RESIDENCE", "", ""],
    ["an ADU merely named is asked", "PAT EXAMPLE RESIDENCE  (E) ADU", "", ""],
    ["a code title is not a manufactured home", "PAT EXAMPLE RESIDENCE  CODES: OREGON MANUFACTURED DWELLING INSTALLATION SPECIALTY CODE", SF, "defer"],
  ];
  await check("(S1) the derivation table — the server (structureDescriptionOf) and the page (ParserReview.structureBasis, the SAME file) answer alike", () => {
    const bad: string[] = [];
    for (const [name, text, server, page] of TABLE) {
      const got = agency.structureDescriptionOf({ planSetExtractedText: text }).value;
      if (got !== server) bad.push(`server ${name}: ${JSON.stringify(got)} (want ${JSON.stringify(server)})`);
      const sb = PR.structureBasis(text, {});
      const pageGot = sb.defer ? "defer" : sb.option;
      if (pageGot !== page) bad.push(`page ${name}: ${JSON.stringify(pageGot)} (want ${JSON.stringify(page)})`);
    }
    // The unit count answers only when the words are silent — and never over an ambiguity.
    if (agency.structureDescriptionOf({ planSetExtractedText: "PV-1 COVER SHEET", dwellingUnits: 1 }).value !== SF) bad.push("dwellingUnits 1 -> single-family");
    if (agency.structureDescriptionOf({ dwellingUnits: "2" }).value !== DUP) bad.push("dwellingUnits 2 -> duplex");
    if (agency.structureDescriptionOf({ dwellingUnits: 3 }).value !== "") bad.push("dwellingUnits 3 -> asked");
    if (agency.structureDescriptionOf({ planSetExtractedText: "PAT EXAMPLE RESIDENCE  (N) PV ARRAY ON GARAGE", dwellingUnits: 1 }).value !== "") bad.push("an ambiguous garage is not answered by the unit count");
    // The basis quotes only the words that decided it — never the homeowner's name beside them.
    const basis = agency.structureDescriptionOf({ planSetExtractedText: "PAT EXAMPLE RESIDENCE" }).basis;
    if (/PAT|EXAMPLE/.test(basis) || !/"RESIDENCE"/.test(basis)) bad.push(`basis carries more than the deciding words: ${basis}`);
    assert.deepEqual(bad, []);
  });

  // Plan sets through the real write path: the PDF is uploaded, the server extracts its text, and
  // getProjectDetail overlays it (planSetExtractedText) — what every door reads.
  const planPdf = async (lines: string[]) => {
    const d = await PDFDocument.create();
    const page = d.addPage([612, 792]);
    const font = await d.embedFont(StandardFonts.Helvetica);
    lines.forEach((l, i) => page.drawText(l, { x: 40, y: 740 - i * 20, size: 11, font }));
    return Buffer.from(await d.save());
  };
  const withPlanSet = async (lines: string[], over: Record<string, unknown> = {}) => {
    const p = make(over);
    docs.saveProjectDocument(db, p.id, { filename: "plan-set.pdf", docType: "plan_set", contentType: "application/pdf", buffer: await planPdf(lines), source: "upload" });
    for (let i = 0; i < 200; i++) {
      const pending = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ? AND (extracted_text = '' OR extracted_text IS NULL)", [p.id])?.n ?? 0;
      if (!pending) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const back = reload(p.id);
    assert.match(String(back.parserSnapshot.planSetExtractedText ?? ""), new RegExp(lines[lines.length - 1].replace(/[()]/g, "\\$&").slice(0, 20)), "the plan-set text reached the project");
    return back;
  };
  const RESIDENCE = ["PAT EXAMPLE RESIDENCE", "PV-1 COVER SHEET", "SITE PLAN (N) PV ARRAY ON (E) ROOF"];
  const GARAGE = ["PAT EXAMPLE RESIDENCE", "SITE PLAN", "(N) PV ARRAY ON (E) DETACHED GARAGE"];
  const SHED_DRAWN = ["PAT EXAMPLE RESIDENCE", "SITE PLAN (E) SHED  EXISTING DETACHED GARAGE", "(N) PV ARRAY ON (E) ROOF"];
  const NO_EVIDENCE = ["PV-1 COVER SHEET", "SCALE: NTS"];
  const coosBytes = fs.readFileSync(path.join(REPO, "backend/test/fixtures/coos-electrical.pdf"));
  const e01Bytes = fs.readFileSync(path.join(REPO, "backend/test/fixtures/marion-e-01.pdf"));
  const b01sBytes = fs.readFileSync(path.join(REPO, "backend/test/fixtures/marion-b-01s.pdf"));
  const curated = (bytes: Buffer, url: string, id: string) => ({ ...curatedFormMap(bytes, url)!.map, id, notes: [], status: "verified", matchJurisdictions: [], version: "test" }) as never;
  const COOS = curated(coosBytes, "https://co.coos.or.us/files/5bb0a81e5/electrical_permit.pdf", "coos-el");
  const E01 = curated(e01Bytes, "https://www.co.marion.or.us/PW/BuildingInspection/Documents/E-01%20Renewable%20Energy%20Permit%20Application.pdf", "marion-e01");
  const B01S = curated(b01sBytes, "https://www.co.marion.or.us/PW/BuildingInspection/Documents/B-01S%20Solar%20Prescriptive%20Installation%20Application%20Filleable.pdf", "marion-b01s");
  const fillAll = async (p: ReturnType<typeof reload>, tag: string) => {
    const ctx = () => forms.buildContext(db, reload(p.id));
    const out = (n: string) => path.join(tmp, `${tag}-${n}.pdf`);
    const r5952 = await forms.fillLoadedForm(def5952(), bytes5952, ctx(), out("5952"));
    const coos = await forms.fillLoadedForm(COOS, coosBytes, ctx(), out("coos"));
    const e01 = await forms.fillLoadedForm(E01, e01Bytes, ctx(), out("e01"));
    const b01s = await forms.fillLoadedForm(B01S, b01sBytes, ctx(), out("b01s"));
    // The filled checklist is flattened: its printed text is what a reviewer reads.
    const printed = (await extractLabels(fs.readFileSync(out("5952")))).map((l) => l.str).join(" | ");
    const coosForm = (await PDFDocument.load(fs.readFileSync(out("coos")))).getForm();
    const e01Form = (await PDFDocument.load(fs.readFileSync(out("e01")))).getForm();
    const b01sForm = (await PDFDocument.load(fs.readFileSync(out("b01s")))).getForm();
    return {
      r5952, coos, e01, b01s, printed,
      coosSfd: coosForm.getCheckBox("Single Family Dwelling").isChecked(),
      e01Residential: e01Form.getCheckBox("undefined").isChecked(),
      b01sSfdOrAccessory: b01sForm.getRadioGroup("undefined_4").getSelected() ?? "",
    };
  };

  await check("(S2) MUST-PASS: a plan set reading 'PAT EXAMPLE RESIDENCE', array on the house -> Single-family dwelling: NOT asked, and the 5952, Coos County and Marion forms read it, with its evidence", async () => {
    const p = await withPlanSet(RESIDENCE);
    assert.ok(!(await askedKeys(p.id)).includes("structureDescription"), "the structure is not asked");
    const d = agency.structureDescriptionOf(p.parserSnapshot);
    assert.equal(d.value, SF);
    assert.equal(d.source, "plan");
    // Not asked => the box is filled, for the SAME project (never "not asked" beside a blank box).
    assert.equal(forms.resolveSource("snapshot.structureDescription", forms.buildContext(db, p)), SF);
    const f = await fillAll(p, "s2");
    assert.match(f.printed, /Single-family dwelling/, "the 5952 prints the structure description");
    for (const [name, r] of [["5952", f.r5952], ["coos", f.coos], ["e01", f.e01], ["b01s", f.b01s]] as const) {
      assert.match(String(r.message), /Structure: Single-family dwelling — from the plan set \(the plan set reads "RESIDENCE"/, `${name} names the evidence: ${r.message}`);
    }
    assert.ok(f.coosSfd, "Coos County: Single Family Dwelling ticked");
    assert.doesNotMatch(String(f.coos.message), /Still needs:[^.]*construction category/);
    assert.ok(f.e01Residential, "Marion E-01: residential category ticked");
    assert.equal(f.b01sSfdOrAccessory, "Yes_4", "Marion B-01S: single-family-or-accessory row Yes");
    // The derived answer is not written onto the project: a person's key stays empty.
    assert.equal(String(reload(p.id).parserSnapshot.structureDescription ?? ""), "");
  });

  await check("(S3) MUST-PASS: the array on a DETACHED GARAGE -> Accessory building, not asked; the forms read it (no Single Family tick)", async () => {
    const p = await withPlanSet(GARAGE);
    assert.ok(!(await askedKeys(p.id)).includes("structureDescription"));
    const f = await fillAll(p, "s3");
    assert.match(f.printed, /Accessory building \(garage\/shed\)/);
    assert.match(String(f.r5952.message), /Structure: Accessory building \(garage\/shed\) — from the plan set \(the plan set reads "ARRAY ON \(E\) DETACHED GARAGE"; operator ruling 2026-09-28\)/);
    assert.ok(!f.coosSfd, "an accessory building is not a single-family dwelling");
    assert.equal(f.b01sSfdOrAccessory, "Yes_4", "Marion B-01S admits an accessory building");
  });

  await check("(S4) MUST-EXCLUDE: a shed / detached garage merely DRAWN while the array is on the house stays Single-family", async () => {
    const p = await withPlanSet(SHED_DRAWN);
    assert.equal(agency.structureDescriptionOf(p.parserSnapshot).value, SF);
    assert.equal(forms.resolveSource("computed.singleFamilyCategory", forms.buildContext(db, p)), "yes");
  });

  await check("(S5) MUST-EXCLUDE: no evidence at all -> still ASKED, the 5952 box blank, no structure note", async () => {
    const p = await withPlanSet(NO_EVIDENCE);
    assert.ok((await askedKeys(p.id)).includes("structureDescription"), "asked when the plan set does not show it");
    assert.equal(forms.resolveSource("snapshot.structureDescription", forms.buildContext(db, p)), "");
    const r = await fill5952(p.id, "s5");
    assert.doesNotMatch(String(r.message), /Structure:/);
    // The person's answer lands and ends the question.
    await intake.answerPortalQuestions(db, p.id, { structureDescription: ACC });
    assert.equal(agency.structureDescriptionOf(reload(p.id).parserSnapshot).source, "answer");
    assert.ok(!(await askedKeys(p.id)).includes("structureDescription"));
    assert.equal(forms.resolveSource("snapshot.structureDescription", forms.buildContext(db, reload(p.id))), ACC);
  });

  await check("(S6) MUST-EXCLUDE: an explicit answer ALWAYS wins over the plan set, and clearing it hands the answer back", async () => {
    const p = await withPlanSet(RESIDENCE);
    repo.updateProject(db, p.id, { structureDescription: TOWN } as never); // Manual entry's write path
    const d = agency.structureDescriptionOf(reload(p.id).parserSnapshot);
    assert.deepEqual([d.value, d.source], [TOWN, "answer"]);
    const r = await fill5952(p.id, "s6");
    assert.doesNotMatch(String(r.message), /from the plan set/);
    assert.equal(forms.resolveSource("snapshot.structureDescription", forms.buildContext(db, reload(p.id))), TOWN);
    repo.updateProject(db, p.id, { structureDescription: "" } as never);
    assert.equal(agency.structureDescriptionOf(reload(p.id).parserSnapshot).value, SF, "cleared -> the plan set answers again");
    // The Manual-entry structure type "manufactured" is a person's answer too.
    const m = await withPlanSet(RESIDENCE, { structureTypeOverride: "manufactured" });
    assert.deepEqual([agency.structureDescriptionOf(m.parserSnapshot).value, agency.structureDescriptionOf(m.parserSnapshot).source], [MFG, "answer"]);
    // A stated category that means something else (or an explicit "Other") is a question, not a pick.
    const other = await withPlanSet(RESIDENCE, { constructionCategory: "Other" });
    assert.equal(agency.structureDescriptionOf(other.parserSnapshot).value, "");
    assert.ok((await askedKeys(other.id)).includes("structureDescription"));
    const duplexStated = await withPlanSet(RESIDENCE, { constructionCategory: "Duplex" });
    assert.equal(agency.structureDescriptionOf(duplexStated.parserSnapshot).value, "");
  });

  // The parser page's save payload (buildSystemPayload, lifted from parser.html and run as the page
  // runs it) — the intake's derivation, never the person's key.
  const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8").replace(/\r\n/g, "\n");
  const liftFunction = (src: string, name: string): string => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `parser.html defines ${name}`);
    let i = src.indexOf("{", src.indexOf(")", start));
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const buildPayload = (st: Record<string, unknown>): Record<string, unknown> => {
    const sandbox: Record<string, unknown> = {
      state: { llmSnapshot: {}, llmEvidence: [], suggestedClient: null, ...st },
      getVal: () => "", numVal: (v: string) => (v === "" ? NaN : Number(v)), buildEvidenceText: () => "",
      clean: (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim(), ParserReview: PR,
    };
    vm.runInNewContext(`${liftFunction(html, "buildSystemPayload")}\nthis.out = buildSystemPayload();`, sandbox);
    return JSON.parse(JSON.stringify(sandbox.out));
  };
  await check("(S7) the parser page saves the derivation as the intake's (structureFromPlan + its evidence), never as structureDescription; the server reads it", async () => {
    const res = buildPayload({ planDoc: { text: RESIDENCE.join("\n") } });
    assert.equal(res.structureFromPlan, SF);
    assert.match(String(res.structureFromPlanBasis), /"RESIDENCE"/);
    assert.equal(res.structureDescription, undefined, "a person's key is never written by the page");
    // The plan-set read's layout answer: agreeing adds its words; disagreeing is a question.
    const agree = buildPayload({ planDoc: { text: GARAGE.join("\n") }, llmStructureReading: { value: ACC, excerpt: "ARRAY ON DETACHED GARAGE" } });
    assert.equal(agree.structureFromPlan, ACC);
    const disagree = buildPayload({ planDoc: { text: RESIDENCE.join("\n") }, llmStructureReading: { value: ACC, excerpt: "ARRAY ON BARN ROOF" } });
    assert.equal(disagree.structureFromPlan, "");
    assert.match(String(disagree.structureFromPlanBasis), /confirm which building carries the array/);
    const readOnly = buildPayload({ planDoc: { text: NO_EVIDENCE.join("\n") }, llmStructureReading: { value: "single-family dwelling", excerpt: "" } });
    assert.equal(readOnly.structureFromPlan, SF, "the read's answer alone, in the option vocabulary");
    // Nothing parsed -> nothing sent (a re-save without a parse never wipes an earlier derivation);
    // a manufactured-home mention -> left to the server's one predicate.
    assert.ok(!("structureFromPlan" in buildPayload({})));
    assert.ok(!("structureFromPlan" in buildPayload({ planDoc: { text: "PAT EXAMPLE RESIDENCE  MOBILE HOME PARK SPACE 4" } })));
    // Saved through the real create path, the server reads the stored derivation (and the question
    // is not asked); a stored disagreement is asked even though the text alone would answer.
    const saved = repo.createProject(db, { clientId: client.id, ...JOB, ...agree } as never).project;
    assert.deepEqual([agency.structureDescriptionOf(reload(saved.id).parserSnapshot).value, agency.structureDescriptionOf(reload(saved.id).parserSnapshot).source], [ACC, "plan"]);
    const split = repo.createProject(db, { clientId: client.id, ...JOB, ...disagree, projectDescriptionText: RESIDENCE.join(" ") } as never).project;
    assert.equal(agency.structureDescriptionOf(reload(split.id).parserSnapshot).value, "");
    assert.ok((await askedKeys(split.id)).includes("structureDescription"));
    // The page never persists the read's field under the person's key.
    const keys = /const LLM_SNAPSHOT_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(html)?.[1] ?? "";
    assert.ok(keys && !/'structureDescription'/.test(keys), "structureDescription must not be an LLM snapshot key");
  });

  await check("(S9) a reader of the PROJECT's own snapshot (the Iowa PV worksheet — no fill context) gets the same derived answer, with its words", async () => {
    const { iowaPvWorksheetValues } = await import("../src/iowaPvWorksheet");
    const p = await withPlanSet(RESIDENCE, { state: "IA", ahj: "City of Example IA", zip: "50000" });
    const w = iowaPvWorksheetValues(p);
    assert.equal(w.values["p3.loc12fam"], "X", "one- and two-family dwelling row ticked");
    assert.match(w.basis["p3.loc12fam"], /structure "Single-family dwelling" \(from the plan set: the plan set reads "RESIDENCE"/);
    assert.ok(!w.questions.some((q) => q.key === "dwellingUnits"), "not asked how many units");
    const none = await withPlanSet(NO_EVIDENCE, { state: "IA", ahj: "City of Example IA", zip: "50000" });
    assert.equal(iowaPvWorksheetValues(none).values["p3.loc12fam"], "", "no evidence: unticked, still asked");
  });

  await check("(S8) the plan-set extraction asks the model for the structure (compact, one line, the five options)", () => {
    const src = fs.readFileSync(path.join(REPO, "backend", "src", "llm.ts"), "utf8");
    const line = src.split("\n").find((l) => l.startsWith("- structureDescription:")) ?? "";
    assert.ok(line, "llm.ts plan-set field list names structureDescription");
    for (const o of [SF, DUP, TOWN, MFG, ACC]) assert.ok(line.includes(`"${o}"`), `the prompt offers "${o}"`);
    assert.ok(line.length < 500, `one compact line (${line.length} chars)`);
  });
} finally {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nformFactDefaults: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
