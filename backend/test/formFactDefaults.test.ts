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
//     ROUND 3 (convergence, 2026-09-28): the conservative rule — Single-family ONLY over text naming
//     no other building at all (garage / shop / shed / barn / carport / workshop / pool house /
//     outbuilding / pergola / patio cover / ADU / accessory / detached, or a ground mount; the one
//     exception an ATTACHED GARAGE); Accessory ONLY from an explicit array-on phrase with no array on
//     the house; duplex ONLY from DUPLEX or 2 dwelling units, no other building named; EVERYTHING
//     ELSE asked (a townhouse, a manufactured home, a read of an accessory building alone). The
//     "beside the work" phrase is quoted, never decides. Every round-1/2 skeptic probe string is a
//     MUST-EXCLUDE of Single-family (S1 PROBES, with a single-family read and 1 unit beside it).
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
//   Round-1 skeptic fixes (each RED, restored GREEN, 2026-09-28):
//   K-S12 the beside-the-work abstain dropped (structureFromText)          -> S1 S7 S10 S11 FAIL.
//   K-S13 ARRAY_ON without A/AN                                            -> S1 FAILS.
//   K-S14 ARRAY_ON without the PHOTOVOLTAIC / SOLAR / <X> ARRAY subjects   -> S1, S3 FAIL.
//   K-S15 the SHED ROOF / SHED DORMER guard dropped                        -> S1 FAILS.
//   K-S16 the SHOP DRAWING(S) guard dropped                                -> S1 FAILS.
//   K-S17 negated phrases not skipped (firstUnnegated takes the first)     -> S1 FAILS.
//   K-S18 two-unit words alone ("TWO-FAMILY", "UNITS: 2") answer duplex    -> S1 FAILS.
//   K-S19 a DUPLEX RECEPTACLE counted as a duplex                          -> S1 FAILS.
//   K-S20 a plural code-title TOWNHOUSES answers townhouse                 -> S1 FAILS.
//   K-S21 a plan-set read answers over ambiguous text                      -> S1, S7 FAIL.
//   K-S22 a disagreeing parsed unit count ignored                          -> S1 FAILS.
//   K-S23 arrays on the house AND an accessory building -> Accessory       -> S1 FAILS.
//   K-S24 otherStructureEvidence does not quote the beside phrase          -> S10 FAILS.
//   K-S25 an ATTACHED GARAGE roof label not skipped                        -> S1 FAILS.
//   K-S26 trench reach unbounded (any trench anywhere in the set)          -> S1 FAILS.
//   K-S27 a system/array label may cross "(N)" filler                      -> S1, S4, S10 FAIL.
//   K-S28 the single-family basis names no other structure (unchecked claim) -> S10 FAILS.
//   (Round 3 retires the "beside the work" shapes as deciders: K-S12, K-S26, K-S27 no longer apply —
//   the other-building gate asks on the word alone; the phrase is only quoted, K-S45.)
//   Round-3 convergence (each RED, restored GREEN, 2026-09-28; harness applies the mutation to the
//   source, runs this file, restores the bytes):
//   K-S29 SHOP dropped from the family                                     -> S1 S2 S10 FAIL.
//   K-S30 the NON-/NOT-ATTACHED guard dropped                              -> S1, S10 FAIL.
//   K-S31 a plan-set read answers alone again (accessory / duplex / ...)   -> S1, S7 FAIL.
//   K-S32 a townhouse answered again                                       -> S1 FAILS.
//   K-S33 a duplex skips the other-building gate                           -> S1, S10 FAIL.
//   K-S34 numberOfBuildings' evidence reads its own (pre-round-3) word list -> S10 FAILS.
//   K-S35 numberOfBuildings' evidence: one capped pass, attached garage first -> S10 FAILS.
//   K-S36 the basis list drifts from the family (a read word not named)    -> S2, S10 FAIL.
//   K-S37 the server takes a stored single-family answer over a named building -> S7 FAILS.
//   K-S38 a unit count answers over an ambiguous text                      -> S1 FAILS.
//   K-S39 the manufactured verdict answers again                           -> S1 FAILS.
//   K-S40 MAIN HOUSE taken as the single-family word                       -> S1 FAILS.
//   K-S41 the ground mount dropped from the family                         -> S1, S10 FAIL.
//   K-S42 the attached-garage clause dropped from the basis                -> S10 FAILS.
//   K-S43 a bare ACCESSORY word no longer counts                           -> S1, S10 FAIL.
//   K-S44 a bare DETACHED word no longer counts                            -> S1, S10 FAIL.
//   K-S45 the beside phrase no longer quoted in the structure basis        -> S7 S10 S11 FAIL.
//   K-S46 two-unit words alone answer duplex again (round-1 multi-unit PROBES) -> S1 FAILS.
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
    ["array on a detached garage", "PAT EXAMPLE RESIDENCE  SITE PLAN  (N) PV ARRAY ON (E) DETACHED GARAGE", "", ""],
    ["array on the roof of the detached garage", "PAT EXAMPLE RESIDENCE  (N) MODULES INSTALLED ON THE ROOF OF THE EXISTING DETACHED GARAGE", "", ""],
    ["ADU", "PAT EXAMPLE RESIDENCE  (N) SOLAR PANELS ON ADU ROOF", "", ""],
    ["accessory dwelling unit", "MODULES MOUNTED ON ACCESSORY DWELLING UNIT  SITE PLAN", "", ""],
    ["shed / barn", "PAT EXAMPLE RESIDENCE  PV ARRAY ON (N) SHED", "", ""],
    ["duplex", "PAT EXAMPLE DUPLEX  UNITS: 2  ARRAY ON ROOF", DUP, DUP],
    // Round 3 (rule 4): a townhouse is not derived — asked, as on base.
    ["townhouse (round 3: asked)", "PAT EXAMPLE TOWNHOUSE  PV ON ROOF", "", ""],
    // Round-1 skeptic probes: ordinary scope-of-work wording for an array on a detached building.
    ["scope: PV SYSTEM ON A DETACHED GARAGE", "PAT EXAMPLE RESIDENCE  SCOPE: INSTALL (N) 7.2 KW PV SYSTEM ON A DETACHED GARAGE", "", ""],
    ["SOLAR MODULES ON THE ROOF OF AN EXISTING DETACHED GARAGE", "PAT EXAMPLE RESIDENCE  INSTALLATION OF 18 SOLAR MODULES ON THE ROOF OF AN EXISTING DETACHED GARAGE", "", ""],
    ["PHOTOVOLTAIC SYSTEM ON DETACHED GARAGE", "PAT EXAMPLE RESIDENCE  PHOTOVOLTAIC SYSTEM ON DETACHED GARAGE", "", ""],
    ["ROOFTOP SOLAR ON DETACHED SHOP", "PAT EXAMPLE RESIDENCE  ROOFTOP SOLAR ON DETACHED SHOP", "", ""],
    ["ROOF MOUNTED PV ON DETACHED GARAGE", "PAT EXAMPLE RESIDENCE  ROOF MOUNTED PV ON DETACHED GARAGE", "", ""],
    ["ARRAY LOCATED ON EXISTING POLE BARN", "PAT EXAMPLE RESIDENCE  ARRAY LOCATED ON EXISTING POLE BARN", "", ""],
    ["a later un-negated accessory phrase still counts", "PAT EXAMPLE RESIDENCE  NO PV ON (E) SHED  (N) PV ARRAY ON (E) DETACHED GARAGE", "", ""],
    // Another building BESIDE the work (never "single-family" — asked). The real OR shape (cf1c56aa):
    // a roof label and module count on the garage, a GARAGE SYSTEM label, a trench.
    ["real shape: GARAGE ROOF #2 (07) / GARAGE SYSTEM- / MAIN HOUSE SYSTEM- / 22-ft trench", "PAT EXAMPLE RESIDENCE  PV-1 SITE PLAN  ROOF #1 (05) EXAMPLE EX-440 SLOPE: 25 AZIM.: 180  GARAGE ROOF #2 (07) EXAMPLE EX-440 SLOPE: 27 AZIM.: 199  ROOF #3 (05) EXAMPLE EX-440  ROOF #01 ROOF #02 ROOF #03 ~22'-0\" TRENCH TO BE 24\" DEEP  GARAGE SYSTEM- MAIN HOUSE SYSTEM-", "", ""],
    ["GARAGE ROOF #2 (07) alone", "PAT EXAMPLE RESIDENCE  GARAGE ROOF #2 (07) EXAMPLE EX-440", "", ""],
    ["GARAGE SYSTEM label alone", "PAT EXAMPLE RESIDENCE  GARAGE SYSTEM- 38.40A", "", ""],
    ["a module count beside a shed", "PAT EXAMPLE RESIDENCE  (E) SHED (N) 12 MODULES", "", ""],
    ["a detached-garage roof plan with a module count", "PAT EXAMPLE RESIDENCE  PV-2 ROOF PLAN - DETACHED GARAGE  (N) 16 MODULES", "", ""],
    ["a trench beside the detached garage", "PAT EXAMPLE RESIDENCE  DETACHED GARAGE  (N) TRENCH 120 FT TO MAIN HOUSE  ARRAY ON ROOF", "", ""],
    ["a trench run to a barn", "PAT EXAMPLE RESIDENCE  (N) PV ARRAY  ~80 FT TRENCH FROM MAIN HOUSE TO (E) BARN", "", ""],
    ["arrays on two buildings", "PAT EXAMPLE RESIDENCE  (N) PV ARRAY ON DETACHED GARAGE  (N) PV ARRAY ON MAIN HOUSE", "", ""],
    ["an ADU beside the ruling's words is still asked", "PAT EXAMPLE RESIDENCE  (N) PV ARRAY ON DETACHED ADU", "", ""],
    // Round 3 (rule 4): the server's manufactured-home verdict blocks every answer and derives none.
    ["manufactured home (round 3: asked)", "PAT EXAMPLE RESIDENCE  THIS PROJECT IS A MANUFACTURED HOME (HUD) ON A PERMANENT FOUNDATION", "", "defer"],
    ["an attached garage is the house", "PAT EXAMPLE RESIDENCE  (N) PV ARRAY ON ATTACHED GARAGE", SF, SF],
    ["dwelling units 1, no words", "PV-1 COVER SHEET", "", ""],
    // MUST-EXCLUDE
    // Round 3 (rule 1): another building merely DRAWN is enough to ask — no word of the family
    // anywhere is the only single-family text.
    ["(E) SHED / EXISTING DETACHED GARAGE merely drawn (round 3: asked)", "PAT EXAMPLE RESIDENCE  SITE PLAN  (E) SHED  EXISTING DETACHED GARAGE  (N) PV ARRAY ON (E) ROOF", "", ""],
    ["a SUBPANEL at the detached garage is not the array (round 3: asked)", "PAT EXAMPLE RESIDENCE  (N) PV SUBPANEL AT DETACHED GARAGE", "", ""],
    ["'2 UNIT DEPTH' racking text is not a duplex", "PAT EXAMPLE RESIDENCE  Unit Depth x Unit Width / 2 Unit Depth = 7.60 in.", SF, SF],
    ["a revision tag 'REV R3' is not an occupancy", "PV 0.0 COVER  REV R3  100 EXAMPLE RD", "", ""],
    ["no evidence at all", "PV-1 COVER SHEET  SCALE: NTS", "", ""],
    ["'ARRAY ON GARAGE' without attached/detached is asked", "PAT EXAMPLE RESIDENCE  (N) PV ARRAY ON GARAGE", "", ""],
    ["a triplex is asked", "PAT EXAMPLE TRIPLEX RESIDENCE", "", ""],
    ["R-2 occupancy is asked", "OCCUPANCY: R-2  RESIDENCE", "", ""],
    ["an ADU merely named is asked", "PAT EXAMPLE RESIDENCE  (E) ADU", "", ""],
    ["a code title is not a manufactured home", "PAT EXAMPLE RESIDENCE  CODES: OREGON MANUFACTURED DWELLING INSTALLATION SPECIALTY CODE", SF, "defer"],
    // Round-1 skeptic probes: a house array is never derived as an accessory building — and, since
    // round 3, never as single-family either while the word is there (a false hit only asks).
    ["SHED ROOF is a roof shape (round 3: asked)", "PAT EXAMPLE RESIDENCE  (N) PV MODULES ON SHED ROOF  3/12 PITCH", "", ""],
    ["SHED DORMER is a roof shape (round 3: asked)", "PAT EXAMPLE RESIDENCE  ARRAY ON SHED DORMER", "", ""],
    ["SHOP DRAWING is not a building (round 3: asked)", "PAT EXAMPLE RESIDENCE  MODULES AT SHOP DRAWING STAGE", "", ""],
    ["a negation never derives: NO MODULES ON SHOP (round 3: asked)", "PAT EXAMPLE RESIDENCE  PV ARRAY ON HOUSE ROOF  NOTE: NO MODULES ON SHOP", "", ""],
    ["a negation never derives: NO PV ON (E) SHED (round 3: asked)", "PAT EXAMPLE RESIDENCE  (N) PV ARRAY ON (E) ROOF  NO PV ON (E) SHED", "", ""],
    ["an ATTACHED GARAGE roof label is the house", "PAT EXAMPLE RESIDENCE  ATTACHED GARAGE ROOF #2 (07) EXAMPLE EX-440", SF, SF],
    // Site-plan labels read off the real OR plan sets (names replaced) — since round 3, asked.
    ["site plan: DRIVEWAY GARAGE MAIN HOUSE ARRAY LOCATION (round 3: asked)", "PAT EXAMPLE RESIDENCE  ROOF #1 (10) EXAMPLE EX-410  DRIVEWAY GARAGE MAIN HOUSE ARRAY LOCATION", "", ""],
    ["site plan: MAIN HOUSE SHED DECK (round 3: asked)", "PAT EXAMPLE RESIDENCE  ROOF #1 (14) EXAMPLE EX-440  DRIVEWAY MAIN HOUSE SHED DECK", "", ""],
    ["site plan: CARPORT SHED SHED, a trench to the service pole elsewhere (round 3: asked)", `PAT EXAMPLE RESIDENCE  ROOF #1 (23) EXAMPLE EX-410  PROPERTY LINE CARPORT SHED SHED FRONT OF HOUSE 100 EXAMPLE AVE EXISTING POLE  ${"NOTES ".repeat(20)} 1-1/4" PVC PIPE ~42 FEET APPROX TRENCH TO BE 24" DEEP`, "", ""],
    ["site plan: a garage label after a roof spec (round 3: asked)", "PAT EXAMPLE RESIDENCE  MAIN HOUSE ROOF #2 (05) EXAMPLE EX-440 SLOPE: 19 AZIM.: 86 GARAGE NW EXAMPLE AVE", "", ""],
    ["site plan: (E) DETACHED STRUCTURE (E) FENCE (round 3: asked)", "PAT EXAMPLE RESIDENCE  (E) PATIO (TYP.) (E) DETACHED STRUCTURE (E) FENCE (E) GATE (E) (16) EXAMPLE MODULES", "", ""],
    // Round-2 skeptic probes: near-variants of the real garage shape, bare SHOP arrays. Asked (or,
    // for an explicit array-on phrase, Accessory) — never single-family.
    ["GARAGE ROOF 2 (07) (no #)", "PAT EXAMPLE RESIDENCE  ROOF 1 (05) EXAMPLE EX-440  GARAGE ROOF 2 (07) EXAMPLE EX-440 SLOPE: 27", "", ""],
    ["GARAGE ROOF (07)", "PAT EXAMPLE RESIDENCE  GARAGE ROOF (07) EXAMPLE EX-440", "", ""],
    ["GARAGE ROOF - 7 MODULES", "PAT EXAMPLE RESIDENCE  GARAGE ROOF - 7 MODULES", "", ""],
    ["ROOF 2 (GARAGE) (07)", "PAT EXAMPLE RESIDENCE  ROOF 1 (05)  ROOF 2 (GARAGE) (07) EXAMPLE EX-440", "", ""],
    ["DETACHED GARAGE ROOF 2 (07)", "PAT EXAMPLE RESIDENCE  DETACHED GARAGE ROOF 2 (07) EXAMPLE EX-440", "", ""],
    ["(N) PV ARRAYS ON DETACHED GARAGE ROOF (a plural subject: asked, not answered)", "PAT EXAMPLE RESIDENCE  (N) PV ARRAYS ON DETACHED GARAGE ROOF", "", ""],
    ["bare SHOP: an array-on phrase is an accessory building", "PAT EXAMPLE RESIDENCE  (N) PV ARRAY ON (E) SHOP", "", ""],
    ["bare SHOP: SHOP ROOF (12)", "PAT EXAMPLE RESIDENCE  SHOP ROOF (12) EXAMPLE EX-440", "", ""],
    ["bare SHOP: a module count beside it", "PAT EXAMPLE RESIDENCE  SHOP (N) 12 MODULES", "", ""],
    ["bare SHOP: SHOP ARRAY label", "PAT EXAMPLE RESIDENCE  SHOP ARRAY 4.4 KW", "", ""],
    // Round 3: the ATTACHED exception is exact; a negated one is another building.
    ["NON-ATTACHED GARAGE", "PAT EXAMPLE RESIDENCE  (N) PV ARRAY ON NON-ATTACHED GARAGE", "", ""],
    ["NOT ATTACHED GARAGE", "PAT EXAMPLE RESIDENCE  NOT ATTACHED GARAGE ROOF (07)", "", ""],
    ["an attached garage AND a garage elsewhere", "PAT EXAMPLE RESIDENCE  ATTACHED GARAGE  GARAGE ROOF (07)", "", ""],
    ["an attached garage named before three other buildings", "PAT EXAMPLE RESIDENCE  (E) ATTACHED GARAGE  (E) SHED  (E) BARN  (E) CARPORT", "", ""],
    // Round 3: every word of the family counts, wherever it sits.
    ["a bare ACCESSORY word", "PAT EXAMPLE RESIDENCE  RACKING ACCESSORY KIT", "", ""],
    ["a bare DETACHED word", "PAT EXAMPLE RESIDENCE  (E) DETACHED  (N) PV ARRAY ON (E) ROOF", "", ""],
    ["a pool house", "PAT EXAMPLE RESIDENCE  (E) POOL HOUSE", "", ""],
    ["a workshop / a barn / an outbuilding / a pergola / a patio cover", "PAT EXAMPLE RESIDENCE  (E) WORKSHOP  (E) BARN  (E) OUTBUILDING  (E) PERGOLA  (E) PATIO COVER", "", ""],
    ["a solar carport", "PAT EXAMPLE RESIDENCE  (N) SOLAR CARPORT 20 MODULES", "", ""],
    ["a ground mount is off the house", "PAT EXAMPLE RESIDENCE  (N) GROUND MOUNTED ARRAY 24 MODULES", "", ""],
    ["a duplex beside another building is asked", "PAT EXAMPLE DUPLEX  UNITS: 2  GARAGE ROOF 2 (07)", "", ""],
    ["MAIN HOUSE alone is not the single-family word", "PV-1 SITE PLAN  MAIN HOUSE  (N) PV ARRAY ON (E) ROOF", "", ""],
    // Round-1 skeptic probes: MULTI_UNIT is an exclusion filter; a positive duplex / townhouse
    // answer takes only the building's own word ("DUPLEX", a singular "TOWNHOUSE").
    ["two-family words alone are asked (only DUPLEX answers duplex)", "TWO-FAMILY DWELLING  PV-1", "", ""],
    ["IRC title: ONE- AND TWO-FAMILY DWELLINGS", "PAT EXAMPLE RESIDENCE  APPLICABLE CODES: 2021 INTERNATIONAL RESIDENTIAL CODE FOR ONE- AND TWO-FAMILY DWELLINGS", "", ""],
    ["IRC title without hyphens", "PAT EXAMPLE RESIDENCE  CODE: IRC ONE AND TWO FAMILY DWELLING CODE", "", ""],
    ["MA code title 780 CMR", "PAT EXAMPLE RESIDENCE  780 CMR 51.00 ONE- AND TWO-FAMILY DWELLINGS 9TH EDITION", "", ""],
    ["BATTERY UNITS: 2", "PAT EXAMPLE RESIDENCE  BATTERY UNITS: 2  EXAMPLE IQ 5P", "", ""],
    ["QTY 2 UNITS", "PAT EXAMPLE RESIDENCE  AC DISCONNECT QTY 2 UNITS", "", ""],
    ["IRC scope: ... AND TOWNHOUSES", "PAT EXAMPLE RESIDENCE  R101.2 SCOPE: DETACHED ONE- AND TWO-FAMILY DWELLINGS AND TOWNHOUSES", "", ""],
    ["a plural TOWNHOUSES code section is not a townhouse", "PAT EXAMPLE RESIDENCE  SEE R302.2 TOWNHOUSES", "", ""],
    ["a DUPLEX RECEPTACLE is not a duplex", "PAT EXAMPLE RESIDENCE  (N) GFCI DUPLEX RECEPTACLE AT INVERTER", "", ""],
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
    // A parsed unit count that disagrees with the words is a question, both ways; two-unit words
    // other than DUPLEX do not become a duplex by agreeing with a count.
    if (agency.structureDescriptionOf({ planSetExtractedText: "PAT EXAMPLE RESIDENCE  PV-1", dwellingUnits: 2 }).value !== "") bad.push("RESIDENCE + 2 dwelling units -> asked");
    if (agency.structureDescriptionOf({ planSetExtractedText: "PAT EXAMPLE DUPLEX  PV-1", dwellingUnits: 1 }).value !== "") bad.push("DUPLEX + 1 dwelling unit -> asked");
    if (agency.structureDescriptionOf({ planSetExtractedText: "PAT EXAMPLE DUPLEX  PV-1", dwellingUnits: 2 }).value !== DUP) bad.push("DUPLEX + 2 dwelling units -> duplex");
    if (agency.structureDescriptionOf({ planSetExtractedText: "PAT EXAMPLE RESIDENCE  PV-1", dwellingUnits: 1 }).value !== SF) bad.push("RESIDENCE + 1 dwelling unit -> single-family");
    if (agency.structureDescriptionOf({ planSetExtractedText: "TWO-FAMILY DWELLING  PV-1", dwellingUnits: 2 }).value !== "") bad.push("TWO-FAMILY words + 2 units -> still asked (the words are ambiguous)");
    // The plan-set READ never answers over ambiguous text (the page stores what it derives, and the
    // server takes the stored answer first): a read of the real garage shape as single-family is asked.
    const realGarage = TABLE.find((r) => r[0].startsWith("real shape"))![1];
    for (const v of [SF, ACC]) {
      const r = PR.structureBasis(realGarage, { reading: { value: v, excerpt: "MAIN HOUSE" } });
      if (r.option !== "" || !/confirm which building carries the array/.test(r.basis)) bad.push(`a read of ${v} answered over the ambiguous garage shape: ${JSON.stringify(r)}`);
    }
    if (PR.structureBasis("PAT EXAMPLE RESIDENCE  (N) PV ARRAY ON GARAGE", { reading: { value: SF } }).option !== "") bad.push("a read answered over an undifferentiated garage");
    // Round 3: neither the read nor the unit count rescues a single-family / duplex answer over another
    // building named anywhere; the read answers ALONE only "Single-family dwelling" (rule 1), a duplex
    // only beside 2 dwelling units (rule 3) — never an accessory building (rule 2), a townhouse or a
    // manufactured home (rule 4).
    if (agency.structureDescriptionOf({ planSetExtractedText: "PAT EXAMPLE RESIDENCE  (E) SHED", dwellingUnits: 1 }).value !== "") bad.push("a shed drawn + 1 dwelling unit -> asked");
    if (agency.structureDescriptionOf({ planSetExtractedText: "PAT EXAMPLE DUPLEX  (E) DETACHED GARAGE", dwellingUnits: 2 }).value !== "") bad.push("DUPLEX + a detached garage drawn + 2 units -> asked");
    if (agency.structureDescriptionOf({ planSetExtractedText: "PV-1 SITE PLAN  (E) SHED", dwellingUnits: 2 }).value !== "") bad.push("a shed drawn + 2 units -> asked");
    const NO_WORDS = "PV-1 COVER SHEET  SCALE: NTS";
    const readAlone = (value: string, dwellingUnits?: number) => PR.structureBasis(NO_WORDS, { reading: { value, excerpt: "" }, dwellingUnits }).option;
    if (readAlone(SF) !== SF) bad.push("a read of single-family over text naming nothing -> single-family");
    if (readAlone(ACC) !== "") bad.push("a read of an accessory building ALONE -> asked (only the text's array-on phrase derives it)");
    if (readAlone(DUP) !== "") bad.push("a read of a duplex ALONE -> asked");
    if (readAlone(DUP, 2) !== DUP) bad.push("a read of a duplex beside 2 dwelling units -> duplex");
    if (readAlone(TOWN) !== "") bad.push("a read of a townhouse -> asked");
    if (readAlone(MFG) !== "") bad.push("a read of a manufactured home -> asked");
    // The server's manufactured verdict with no plan text at all never lets a unit count answer.
    if (agency.structureDescriptionOf({ structureType: "manufactured home", dwellingUnits: 1 }).value === SF) bad.push("a manufactured verdict + 1 unit answered single-family");
    // EVERY skeptic probe string (rounds 1-2) through BOTH doors, and with a single-family read and
    // 1 dwelling unit beside it: never "Single-family dwelling".
    const PROBES = [
      "PAT EXAMPLE RESIDENCE  SCOPE: INSTALL (N) 7.2 KW PV SYSTEM ON A DETACHED GARAGE",
      "PAT EXAMPLE RESIDENCE  INSTALLATION OF 18 SOLAR MODULES ON THE ROOF OF AN EXISTING DETACHED GARAGE",
      "PAT EXAMPLE RESIDENCE  PHOTOVOLTAIC SYSTEM ON DETACHED GARAGE",
      "PAT EXAMPLE RESIDENCE  ROOFTOP SOLAR ON DETACHED SHOP",
      "PAT EXAMPLE RESIDENCE  PV-2 ROOF PLAN - DETACHED GARAGE  (N) 16 MODULES",
      "PAT EXAMPLE RESIDENCE  (N) PV MODULES ON SHED ROOF  3/12 PITCH",
      "PAT EXAMPLE RESIDENCE  ARRAY ON SHED DORMER",
      "PAT EXAMPLE RESIDENCE  MODULES AT SHOP DRAWING STAGE",
      "PAT EXAMPLE RESIDENCE  PV ARRAY ON HOUSE ROOF  NOTE: NO MODULES ON SHOP",
      "PAT EXAMPLE RESIDENCE  GARAGE ROOF #2 (07) EXAMPLE EX-440",
      "PAT EXAMPLE RESIDENCE  GARAGE SYSTEM- 38.40A",
      "PAT EXAMPLE RESIDENCE  ROOF 1 (05) EXAMPLE EX-440  GARAGE ROOF 2 (07) EXAMPLE EX-440 SLOPE: 27",
      "PAT EXAMPLE RESIDENCE  GARAGE ROOF (07) EXAMPLE EX-440",
      "PAT EXAMPLE RESIDENCE  GARAGE ROOF - 7 MODULES",
      "PAT EXAMPLE RESIDENCE  ROOF 1 (05)  ROOF 2 (GARAGE) (07) EXAMPLE EX-440",
      "PAT EXAMPLE RESIDENCE  DETACHED GARAGE ROOF 2 (07) EXAMPLE EX-440",
      "PAT EXAMPLE RESIDENCE  (N) PV ARRAYS ON DETACHED GARAGE ROOF",
      "PAT EXAMPLE RESIDENCE  (N) PV ARRAY ON (E) SHOP",
      "PAT EXAMPLE RESIDENCE  SHOP ROOF (12) EXAMPLE EX-440",
      "PAT EXAMPLE RESIDENCE  SHOP (N) 12 MODULES",
      "PAT EXAMPLE RESIDENCE  SHOP ARRAY 4.4 KW",
      TABLE.find((r) => r[0].startsWith("real shape"))![1],
      // Round-1 multi-unit probes (derived duplex on the branch then): asked, never single-family.
      "PAT EXAMPLE RESIDENCE  APPLICABLE CODES: 2021 INTERNATIONAL RESIDENTIAL CODE FOR ONE- AND TWO-FAMILY DWELLINGS",
      "PAT EXAMPLE RESIDENCE  CODE: IRC ONE AND TWO FAMILY DWELLING CODE",
      "PAT EXAMPLE RESIDENCE  780 CMR 51.00 ONE- AND TWO-FAMILY DWELLINGS 9TH EDITION",
      "PAT EXAMPLE RESIDENCE  BATTERY UNITS: 2  EXAMPLE IQ 5P",
      "PAT EXAMPLE RESIDENCE  AC DISCONNECT QTY 2 UNITS",
    ];
    for (const text of PROBES) {
      for (const opts of [{}, { reading: { value: SF, excerpt: "MAIN HOUSE" } }, { dwellingUnits: 1 }]) {
        const page = PR.structureBasis(text, opts).option;
        if (page === SF) bad.push(`page answered single-family on a probe ${JSON.stringify(opts)}: ${text}`);
        if (!["", ACC].includes(page)) bad.push(`page answered ${page} on a probe ${JSON.stringify(opts)}: ${text}`);
      }
      const server = agency.structureDescriptionOf({ planSetExtractedText: text, dwellingUnits: 1 }).value;
      if (server === SF) bad.push(`server answered single-family on a probe: ${text}`);
      if (!["", ACC].includes(server)) bad.push(`server answered ${server} on a probe: ${text}`);
    }
    // The basis quotes only the words that decided it — never the homeowner's name beside them.
    const basis = agency.structureDescriptionOf({ planSetExtractedText: "PAT EXAMPLE RESIDENCE" }).basis;
    if (/PAT|EXAMPLE/.test(basis) || !/"RESIDENCE"/.test(basis)) bad.push(`basis carries more than the deciding words: ${basis}`);
    assert.deepEqual(bad, []);
  });

  await check("(S10) one question, one predicate: where the structure abstains on another building, the page's numberOfBuildings evidence names the same words (and stays UNSURE); a single-family / duplex answer only over text naming no building, its basis listing exactly what was checked", () => {
    const bad: string[] = [];
    // An independent reading of the round-3 word list (NOT the page's regex): any of these, bar an
    // un-negated ATTACHED GARAGE, means the text names another building (or a ground mount).
    const WORDS = /\b(?:GARAGES?|SHOPS?|SHEDS?|BARNS?|CARPORTS?|WORKSHOPS?|POOL\s*HOUSES?|OUTBUILDINGS?|PERGOLAS?|PATIO\s+COVERS?|ADUS?|ACCESSORY|DETACHED|GROUND[-\s]?MOUNT(?:ED|S)?)\b/i;
    const withoutAttached = (t: string) => t.replace(/(^|[^-\w])(?<!\b(?:NON|NOT|UN)[-\s]*)ATTACHED\s+GARAGES?\b/gi, "$1");
    const CHECKED = "names no other building (garage, shop, shed, barn, carport, workshop, pool house, outbuilding, pergola, patio cover, ADU, accessory building or detached building) and no ground mount";
    let wordRows = 0;
    for (const [name, text] of TABLE) {
      const words = PR.otherBuildingWords(text) as string[];
      const sb = PR.structureBasis(text, {});
      const named = WORDS.test(withoutAttached(text));
      if (named !== words.length > 0) bad.push(`${name}: the page's word list (${JSON.stringify(words)}) and the independent reading (${named}) disagree`);
      // An array-on phrase naming an accessory building abstains on its OWN quoted phrase (round-3 close).
      if (words.length && sb.option !== ACC && !/may be on an accessory building/.test(String(sb.basis))) {
        wordRows++;
        if (sb.option !== "") bad.push(`${name}: answered ${sb.option} over ${words.join(", ")}`);
        // The items the evidence NAMES (each `WORD ("…context…")`), the quoted context set aside — a
        // word merely inside another item's context is not named.
        const ose = (PR.otherStructureEvidence(text) as string).replace(/ \("…[\s\S]*?…"\)/g, "");
        for (const w of words.slice(0, 3)) {
          if (!ose.includes(w)) bad.push(`${name}: the numberOfBuildings evidence does not name "${w}": ${ose}`);
          if (!sb.basis.includes(w)) bad.push(`${name}: the structure basis does not name "${w}": ${sb.basis}`);
        }
      }
      if ((sb.option === SF || sb.option === DUP) && (named || !sb.basis.includes(CHECKED))) bad.push(`${name}: ${sb.option} over a named building, or its basis does not say what was checked: ${sb.basis}`);
      // "names no garage" is never said over an attached one without naming it.
      if ((sb.option === SF || sb.option === DUP) && /\bATTACHED\s+GARAGE/i.test(text) && !/garage is called ATTACHED \(the house\)/.test(sb.basis)) bad.push(`${name}: the basis does not name the attached garage it read as the house: ${sb.basis}`);
    }
    if (wordRows < 30) bad.push(`only ${wordRows} rows reached the other-building gate`);
    // Through the page's own review list: the real garage shape leaves numberOfBuildings UNSURE,
    // quoting the same words the structure's basis quotes.
    const realGarage = TABLE.find((r) => r[0].startsWith("real shape"))![1];
    const items = PR.resolveReviewItems({ attached: ["plan_set"], planText: realGarage, passes: [{ kind: "text", label: "text", docsGiven: ["plan_set"], response: { fields: { numberOfBuildings: { value: 1, confidence: 0.55, evidence: { source: "plan_set", sheet: "PV-1", excerpt: "MAIN HOUSE" } } }, lowConfidenceFields: ["numberOfBuildings"], notes: "" } }] });
    const nu = items.unsure.find((x: { field: string }) => x.field === "numberOfBuildings");
    if (!nu || !/GARAGE ROOF #2/.test(nu.why)) bad.push(`numberOfBuildings is not UNSURE on "GARAGE ROOF #2": ${JSON.stringify(nu)}`);
    if (!/GARAGE ROOF #2/.test(PR.structureBasis(realGarage, {}).basis)) bad.push("the structure basis does not quote GARAGE ROOF #2");
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
  const REAL_GARAGE = ["PAT EXAMPLE RESIDENCE", "PV-1 SITE PLAN  ROOF #1 (05) EXAMPLE EX-440", "GARAGE ROOF #2 (07) EXAMPLE EX-440 SLOPE: 27", "ROOF #01 ROOF #02 ~22 FT TRENCH TO BE 24 IN DEEP", "GARAGE SYSTEM- MAIN HOUSE SYSTEM-"];
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
      assert.match(String(r.message), /Structure: Single-family dwelling — from the plan set \(the plan set reads "RESIDENCE" and names no other building \(garage, shop, shed, barn, carport, workshop, pool house, outbuilding, pergola, patio cover, ADU, accessory building or detached building\) and no ground mount; operator ruling 2026-09-28\)/, `${name} names the evidence (and only what was checked): ${r.message}`);
    }
    assert.ok(f.coosSfd, "Coos County: Single Family Dwelling ticked");
    assert.doesNotMatch(String(f.coos.message), /Still needs:[^.]*construction category/);
    assert.ok(f.e01Residential, "Marion E-01: residential category ticked");
    assert.equal(f.b01sSfdOrAccessory, "Yes_4", "Marion B-01S: single-family-or-accessory row Yes");
    // The derived answer is not written onto the project: a person's key stays empty.
    assert.equal(String(reload(p.id).parserSnapshot.structureDescription ?? ""), "");
  });

  await check("(S3) MUST-EXCLUDE (round-3 close): the array on a DETACHED GARAGE is never derived — ASKED, the phrase quoted; no structure fill, no Single Family tick", async () => {
    const p = await withPlanSet(GARAGE);
    const d = agency.structureDescriptionOf(p.parserSnapshot);
    assert.equal(d.value, "");
    assert.match(d.basis, /PV ARRAY ON \(E\) DETACHED GARAGE" — the array may be on an accessory building, so the structure is asked/, d.basis);
    assert.ok((await askedKeys(p.id)).includes("structureDescription"), "asked, never derived");
    const f = await fillAll(p, "s3");
    assert.doesNotMatch(f.printed, /Accessory building \(garage\/shed\)/);
    assert.doesNotMatch(String(f.r5952.message), /Structure:/);
    assert.ok(!f.coosSfd, "never ticked single-family over an accessory phrase");
  });

  await check("(S4) MUST-EXCLUDE (round 3, the conservative rule): a shed / detached garage merely DRAWN is ASKED — never Single-family; the 5952 box blank, no Single Family tick, no structure note", async () => {
    const p = await withPlanSet(SHED_DRAWN);
    const d = agency.structureDescriptionOf(p.parserSnapshot);
    assert.equal(d.value, "");
    assert.match(d.basis, /the plan set names "SHED", "DETACHED GARAGE" — the array may not be on the house, so the structure is asked/, d.basis);
    assert.ok((await askedKeys(p.id)).includes("structureDescription"), "asked when another building is named");
    assert.equal(forms.resolveSource("snapshot.structureDescription", forms.buildContext(db, p)), "");
    assert.notEqual(forms.resolveSource("computed.singleFamilyCategory", forms.buildContext(db, p)), "yes");
    assert.doesNotMatch(String((await fill5952(p.id, "s4")).message), /Structure:/);
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

  await check("(S11) MUST-EXCLUDE: the real OR garage shape (GARAGE ROOF #2 with its module count, GARAGE SYSTEM-, a trench) through the real upload -> ASKED, the 5952 box blank, no structure note", async () => {
    const p = await withPlanSet(REAL_GARAGE);
    assert.equal(agency.structureDescriptionOf(p.parserSnapshot).value, "");
    assert.match(agency.structureDescriptionOf(p.parserSnapshot).basis, /GARAGE ROOF #2/);
    assert.ok((await askedKeys(p.id)).includes("structureDescription"), "asked when another building sits beside the work");
    assert.equal(forms.resolveSource("snapshot.structureDescription", forms.buildContext(db, p)), "");
    assert.doesNotMatch(String((await fill5952(p.id, "s11")).message), /Structure: Single-family/);
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
    // Round-3 close: an accessory building is never derived — text and read agreeing still ASK.
    assert.equal(agree.structureFromPlan, "");
    const disagree = buildPayload({ planDoc: { text: RESIDENCE.join("\n") }, llmStructureReading: { value: ACC, excerpt: "ARRAY ON BARN ROOF" } });
    assert.equal(disagree.structureFromPlan, "");
    assert.match(String(disagree.structureFromPlanBasis), /confirm which building carries the array/);
    // A read never answers over ambiguous text: the real garage shape read as single-family is stored
    // as a question, so the server (which takes the stored answer first) asks it too.
    const overAmbiguous = buildPayload({ planDoc: { text: REAL_GARAGE.join("\n") }, llmStructureReading: { value: SF, excerpt: "MAIN HOUSE" } });
    assert.equal(overAmbiguous.structureFromPlan, "");
    assert.match(String(overAmbiguous.structureFromPlanBasis), /GARAGE ROOF #2/);
    const readOnly = buildPayload({ planDoc: { text: NO_EVIDENCE.join("\n") }, llmStructureReading: { value: "single-family dwelling", excerpt: "" } });
    assert.equal(readOnly.structureFromPlan, SF, "the read's answer alone, in the option vocabulary");
    // Round 3: a read of an accessory building ALONE is stored as a question (only the text's own
    // array-on phrase derives it), and so is a single-family read over a shed merely drawn.
    const accReadOnly = buildPayload({ planDoc: { text: NO_EVIDENCE.join("\n") }, llmStructureReading: { value: ACC, excerpt: "ARRAY ON BARN ROOF" } });
    assert.equal(accReadOnly.structureFromPlan, "");
    assert.match(String(accReadOnly.structureFromPlanBasis), /no array-on phrase names the building/);
    const sfOverShed = buildPayload({ planDoc: { text: SHED_DRAWN.join("\n") }, llmStructureReading: { value: SF, excerpt: "RESIDENCE" } });
    assert.equal(sfOverShed.structureFromPlan, "");
    // Round 3: the server takes a stored single-family / duplex answer only over text on file that
    // names no other building (the page read the plan set alone; the server's text also carries the
    // description) — a stored answer from before the rule never outlives it.
    const stale = repo.createProject(db, { clientId: client.id, ...JOB, structureFromPlan: SF, structureFromPlanBasis: "the plan set reads \"RESIDENCE\"", projectDescriptionText: "PAT EXAMPLE RESIDENCE  (E) SHED" } as never).project;
    assert.equal(agency.structureDescriptionOf(reload(stale.id).parserSnapshot).value, "");
    assert.ok((await askedKeys(stale.id)).includes("structureDescription"));
    const staleTown = repo.createProject(db, { clientId: client.id, ...JOB, structureFromPlan: TOWN, structureFromPlanBasis: "the plan set reads \"TOWNHOUSE\"" } as never).project;
    assert.equal(agency.structureDescriptionOf(reload(staleTown.id).parserSnapshot).value, "", "a stored townhouse (before round 3) is asked");
    const heldSf = repo.createProject(db, { clientId: client.id, ...JOB, structureFromPlan: SF, structureFromPlanBasis: "the plan set reads \"RESIDENCE\"", projectDescriptionText: "PAT EXAMPLE RESIDENCE" } as never).project;
    assert.equal(agency.structureDescriptionOf(reload(heldSf.id).parserSnapshot).value, SF, "a stored single-family answer over text naming nothing holds");
    // Nothing parsed -> nothing sent (a re-save without a parse never wipes an earlier derivation);
    // a manufactured-home mention -> left to the server's one predicate.
    assert.ok(!("structureFromPlan" in buildPayload({})));
    assert.ok(!("structureFromPlan" in buildPayload({ planDoc: { text: "PAT EXAMPLE RESIDENCE  MOBILE HOME PARK SPACE 4" } })));
    // Saved through the real create path, the server reads the stored derivation (and the question
    // is not asked); a stored disagreement is asked even though the text alone would answer.
    const saved = repo.createProject(db, { clientId: client.id, ...JOB, ...agree } as never).project;
    assert.equal(agency.structureDescriptionOf(reload(saved.id).parserSnapshot).value, "", "an accessory building saved from the page is asked (never derived)");
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
