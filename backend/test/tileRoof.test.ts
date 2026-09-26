// TILE ROOFS: never shingle, never prescriptive in Oregon, and the gate asks what a tile job owes.
//
// Operator heads-up (2026-09-26): tile roofs will come in (FL / CA / AZ). The backend had no tile
// handling: bcdChecklistFacts left a tile roof's roofing row BLANK, and permitPath's Oregon screen
// only recognised membranes — so an Oregon tile roof with clean numbers routed PRESCRIPTIVE, the
// wrong application, with a BCD 5952 that must never be filed for it.
//
// Oregon's roofing row (ORSC / BCD 440-5952): "metal, single-layer wood shingles or shakes, or no
// more than two layers of composition shingles". Tile is none of those -> NO -> not prescriptive
// -> engineered/structural application, and the 5952 is not required. roofCovering.ts is the one
// predicate the row, the path and the gate all ask.
//
// KILL TESTS (each run as a mutation, 2026-09-26):
//   K1 roofCovering.oregonRoofingRowQualifies: tile -> null (the old blank)   -> (b1) fails
//   K2 permitPath: drop `covering.family === "tile"` from nonPrescriptiveRoof  -> (p1) fails (the
//      path still routes engineered through the row predicate, but the basis stops naming tile)
//   K3 classifyRoofCovering: test composition before tile                     -> (c2) fails
//   K4 codeReviewRules: drop the tile block                                   -> (g1) (g2) (g4) (g5) fail
//   K5 structuralIntake: drop the tile label                                  -> (i1) fails
//
// Synthetic projects only. Run: npx tsx backend/test/tileRoof.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tile-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const repo = await import("../src/repository");
const clients = await import("../src/clients");
const roof = await import("../src/roofCovering");
const facts = await import("../src/bcdChecklistFacts");
const pp = await import("../src/permitPath");
const rules = await import("../src/codeReviewRules");
const req = await import("../src/requiredDocuments");
const intake = await import("../src/structuralIntake");

let failures = 0; let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const client = clients.createClient(db, { companyName: "Tileworks Test Solar LLC", ccbLicenseNumber: "900001" });
// Every number inside Oregon's prescriptive limits, so ONLY the covering decides the path.
const JOB = {
  owner: "Tile Test Owner", street: "10 Synthetic Way", city: "Maple Hollow", state: "OR", zip: "97352", ahj: "City of Maple Hollow",
  utility: "Pacific Power", dcKw: "6", acKw: "5", moduleMake: "Qcells", moduleModel: "Q.PEAK DUO BLK ML-G10+ 400",
  pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US", mounting: "Roof Mount",
  roofMaterial: "Composition Shingle", roofLayers: "1", framingType: "truss", roofRafterSpacing: "24", attachmentToFraming: "yes", attachmentSpacingIn: "24",
  gravityWindDesign: "yes", manufacturerInstallation: "yes", snow: "20", deadLoad: "3", wind: "C", windSpeed: "100",
};
const make = (over: Record<string, string> = {}) => repo.createProject(db, { clientId: client.id, ...JOB, ...over } as never).project;
const reload = (id: string) => repo.getProjectDetail(db, id).project;

// ── (c) the one predicate ────────────────────────────────────────────────────────────────
await check("(c1) MUST-PASS: every tile wording is tile, with its subtype", () => {
  for (const [m, sub] of [["Concrete Tile", "Concrete"], ["Clay Tile", "Clay"], ["Concrete S-Tile", "Concrete / S-tile"], ["Flat Concrete Tile", "Concrete / Flat tile"], ["Spanish tile", "S-tile"], ["TILE", ""]] as const) {
    const c = roof.classifyRoofCovering(m);
    assert.equal(c.family, "tile", m);
    assert.equal(c.subtype, sub, `${m} subtype`);
  }
  assert.equal(roof.classifyRoofCovering("", "Clay").family, "unknown", "a subtype alone without a tile word is not a roof");
  assert.equal(roof.classifyRoofCovering("Tile", "Clay").subtype, "Clay", "subtype hint rides along");
});
await check("(c2) MUST-PASS: tile never collapses into shingle or shake", () => {
  assert.equal(roof.classifyRoofCovering("Concrete shake tile").family, "tile");
  assert.equal(roof.classifyRoofCovering("Tile shingle").family, "tile");
  assert.equal(roof.classifyRoofCovering("Flat tile").family, "tile");
});
await check("(c3) MUST-EXCLUDE: comp, metal, wood and membrane keep their families", () => {
  assert.equal(roof.classifyRoofCovering("Composition Shingle").family, "composition");
  assert.equal(roof.classifyRoofCovering("Asphalt shingles").family, "composition");
  assert.equal(roof.classifyRoofCovering("Standing seam metal").family, "metal");
  assert.equal(roof.classifyRoofCovering("Cedar shake").family, "wood");
  assert.equal(roof.classifyRoofCovering("TPO").family, "membrane");
  assert.equal(roof.classifyRoofCovering("").family, "unknown");
});
await check("(c4) attachment method from text: hook / replacement mount / comp-out, each with its quote", () => {
  assert.deepEqual(roof.tileAttachmentFromText("ATTACHMENT: QUICKBOLT TILE HOOK W/ FLASHING @ 48\" O.C.").map((m) => m.method), ["tile hook"]);
  assert.deepEqual(roof.tileAttachmentFromText("ECOFASTEN TILE REPLACEMENT MOUNT").map((m) => m.method), ["tile-replacement mount"]);
  assert.deepEqual(roof.tileAttachmentFromText("COMP-OUT AT EACH ATTACHMENT, FLASHED").map((m) => m.method), ["comp-out"]);
  assert.deepEqual(roof.tileAttachmentFromText("FLASHFOOT2 ON COMP SHINGLE"), [], "a comp flashing is not a tile method");
});

// ── (b) the BCD 5952 roofing row ─────────────────────────────────────────────────────────
await check("(b1) MUST-PASS: a tile roof answers the Oregon roofing row NO (was blank)", () => {
  assert.equal(facts.bcdChecklistAnswers(make({ roofMaterial: "Concrete Tile" })).roofing, "No");
  assert.equal(facts.bcdChecklistAnswers(make({ roofMaterial: "Tile", roofMaterialSubtype: "Clay / S-tile" })).roofing, "No");
});
await check("(b2) MUST-EXCLUDE: comp (1-2 layers) and metal still Yes; 3-layer comp answers No; tile asks no layer question", () => {
  assert.equal(facts.bcdChecklistAnswers(make()).roofing, "Yes");
  assert.equal(facts.bcdChecklistAnswers(make({ roofLayers: "2" })).roofing, "Yes");
  assert.equal(facts.bcdChecklistAnswers(make({ roofLayers: "3" })).roofing, "No");
  assert.equal(facts.bcdChecklistAnswers(make({ roofLayers: "3 or more" })).roofing, "No");
  assert.equal(facts.bcdChecklistAnswers(make({ roofMaterial: "Standing seam metal", roofLayers: "" })).roofing, "Yes");
  const q = facts.formFactQuestions(make({ roofMaterial: "Concrete Tile", roofLayers: "" }), { checklistApplies: true }).map((x) => x.key);
  assert.ok(!q.includes("roofLayers"), `tile must not be asked a comp layer count: ${q}`);
  const q2 = facts.formFactQuestions(make({ roofLayers: "" }), { checklistApplies: true }).map((x) => x.key);
  assert.ok(q2.includes("roofLayers"), "comp still asks the layer count");
});

// ── (p) the permit path ──────────────────────────────────────────────────────────────────
await check("(p1) MUST-PASS: an Oregon tile roof with every number inside the limits routes ENGINEERED, naming tile", () => {
  const r = pp.resolvePermitPath(reload(make({ roofMaterial: "Concrete S-Tile" }).id));
  assert.equal(r.path, "engineered");
  assert.equal(r.source, "structural-screen");
  assert.ok(r.needsEngineeredDocs, "engineered path owes the PE package");
  assert.match(r.basis.join(" "), /tile/i);
  assert.match(r.basis.join(" "), /engineered\/structural application/);
});
await check("(p2) MUST-EXCLUDE: the same job on comp (1 layer) and on metal stays PRESCRIPTIVE", () => {
  assert.equal(pp.resolvePermitPath(reload(make().id)).path, "prescriptive");
  assert.equal(pp.resolvePermitPath(reload(make({ roofMaterial: "Standing seam metal", roofLayers: "" }).id)).path, "prescriptive");
  assert.equal(pp.resolvePermitPath(reload(make({ roofLayers: "" }).id)).path, "prescriptive", "unknown layer count is not a failure");
});
await check("(p3) the path and the row cannot disagree: 3-layer comp answers No AND is not prescriptive", () => {
  const p = reload(make({ roofLayers: "3" }).id);
  assert.equal(facts.bcdChecklistAnswers(p).roofing, "No");
  const r = pp.resolvePermitPath(p);
  assert.equal(r.path, "engineered");
  assert.match(r.basis.join(" "), /no more than two layers/);
});
await check("(p4) MUST-EXCLUDE: Oregon's roofing row does not judge a Florida tile roof", () => {
  const r = pp.resolvePermitPath(reload(make({ state: "FL", ahj: "City of Cape Coral", zip: "33904", roofMaterial: "Concrete Tile" }).id));
  assert.doesNotMatch(r.basis.join(" "), /BCD 5952 roofing row/);
});
await check("(p5) an operator override still wins (the operator decides)", () => {
  assert.equal(pp.resolvePermitPath(reload(make({ roofMaterial: "Concrete Tile", permitPathOverride: "prescriptive" }).id)).path, "prescriptive");
});

// ── (d) the 5952 is not filed on the tile job ────────────────────────────────────────────
await check("(d1) MUST-PASS: an Oregon tile job is not asked for the prescriptive checklist; the comp job is", () => {
  const ctx = { permitStructure: "separate" as const, requiresPrescriptiveChecklist: true };
  const tile = req.requiredApplicationDocs(reload(make({ roofMaterial: "Clay Tile" }).id), ctx).map((d) => d.docType);
  const comp = req.requiredApplicationDocs(reload(make().id), ctx).map((d) => d.docType);
  assert.ok(!tile.includes("solar_checklist"), `tile job must not file the 5952: ${tile}`);
  assert.ok(comp.includes("solar_checklist"), `comp job still files the 5952: ${comp}`);
});

// ── (g) the gate ─────────────────────────────────────────────────────────────────────────
const ids = (over: Record<string, string>, docTypes: string[] = []) =>
  rules.evaluateDesignCodeFindings(reload(make(over).id), null, undefined, docTypes).map((f) => f.id);
const TILE_IDS = ["city.struct.tile-attachment-missing", "city.struct.tile-flashing-missing", "city.struct.tile-dead-load", "city.struct.tile-stamped-engineering-missing"];
await check("(g1) MUST-PASS: a tile job with no tile attachment, no roof dead load and no stamp gets each finding, with evidence", () => {
  const p = reload(make({ roofMaterial: "Concrete Tile", structuralCalcText: "PV DEAD LOAD 3 PSF. ATTACHMENT DETAIL: LAG SCREW 2.5\" EMBEDMENT." }).id);
  const found = rules.evaluateDesignCodeFindings(p, null, undefined, []);
  const got = found.map((f) => f.id);
  assert.ok(got.includes("city.struct.tile-attachment-missing"), got.join(","));
  assert.ok(got.includes("city.struct.tile-dead-load"), got.join(","));
  assert.ok(got.includes("city.struct.tile-stamped-engineering-missing") || got.includes("city.struct.stamped-engineering-missing"), got.join(","));
  const att = found.find((f) => f.id === "city.struct.tile-attachment-missing")!;
  assert.equal(att.severity, "blocker");
  assert.match(att.message, /Concrete Tile/);
});
await check("(g2) a tile job whose calc states a SHINGLE roof dead load is told so, with the quote", () => {
  const found = rules.evaluateDesignCodeFindings(reload(make({ roofMaterial: "Concrete Tile", structuralCalcText: "TILE HOOK W/ FLASHING. ROOF DEAD LOAD: 4 PSF. PV DEAD LOAD 3 PSF." }).id), null, undefined, ["structural_letter"]);
  const dl = found.find((f) => f.id === "city.struct.tile-dead-load");
  assert.ok(dl, "dead-load finding");
  assert.match(dl!.message, /4 psf \("[^"]*ROOF DEAD LOAD: 4 PSF/);
});
await check("(g3) MUST-EXCLUDE: a complete tile job (hook + flashing + 10 psf roof DL + stamped letter) raises no tile finding", () => {
  const got = ids({ roofMaterial: "Concrete Tile", tileAttachmentMethod: "tile hook", structuralCalcText: "QUICKBOLT TILE HOOK WITH FLASHING. ROOF DEAD LOAD: 10 PSF (CONCRETE TILE). PV DEAD LOAD 3 PSF." }, ["structural_letter"]);
  for (const id of TILE_IDS) assert.ok(!got.includes(id), `${id} fired on a complete tile job`);
});
await check("(g4) a hook named with no flashing anywhere -> the flashing finding", () => {
  assert.ok(ids({ roofMaterial: "Clay Tile", structuralCalcText: "TILE HOOK AT 48 IN O.C. ROOF DEAD LOAD 11 PSF" }, ["structural_letter"]).includes("city.struct.tile-flashing-missing"));
});
await check("(g5) two methods named -> ambiguous (warning), not a pick", () => {
  const f = rules.evaluateDesignCodeFindings(reload(make({ roofMaterial: "Concrete Tile", structuralCalcText: "TILE HOOK DETAIL 1. COMP-OUT DETAIL 2. FLASHING PER MFR. ROOF DEAD LOAD 10 PSF" }).id), null, undefined, ["structural_letter"])
    .find((x) => x.id === "city.struct.tile-attachment-missing");
  assert.ok(f && f.severity === "warning" && /tile hook/.test(f.message) && /comp-out/.test(f.message));
});
await check("(g6) MUST-EXCLUDE: comp and metal jobs raise no tile finding at all", () => {
  for (const over of [{}, { roofMaterial: "Standing seam metal", roofLayers: "" }, { roofLayers: "3" }]) {
    const got = ids(over);
    for (const id of TILE_IDS) assert.ok(!got.includes(id), `${id} fired on ${JSON.stringify(over)}`);
  }
});

// ── (i) the parse: an explicit tile label outranks a model's shingle guess ───────────────
await check("(i1) MUST-PASS: 'ROOF MATERIAL: CONCRETE S-TILE' overrides a model's 'Composition Shingle'; subtype + method ride along", () => {
  const out = intake.supplementStructuralIntake({ provider: "stub", fields: { roofMaterial: { value: "Composition Shingle", confidence: 0.6 } }, lowConfidenceFields: [], notes: "" } as never,
    "ROOF MATERIAL: CONCRETE S-TILE  ATTACHMENT: IRONRIDGE TILE HOOK W/ FLASHING");
  assert.equal(out.fields.roofMaterial.value, "Concrete S-Tile");
  assert.equal(out.fields.roofMaterialSubtype?.value, "Concrete / S-tile");
  assert.equal(out.fields.tileAttachmentMethod?.value, "tile hook");
});
await check("(i2) MUST-EXCLUDE: a comp label is untouched; a set labelled both comp and tile is not rewritten to tile by the tile label (conflict, not a pick)", () => {
  const comp = intake.supplementStructuralIntake({ provider: "stub", fields: {}, lowConfidenceFields: [], notes: "" } as never, "ROOF MATERIAL: COMPOSITION SHINGLE");
  assert.equal(comp.fields.roofMaterial.value, "Composition Shingle");
  assert.equal(comp.fields.tileAttachmentMethod, undefined);
  const both = intake.supplementStructuralIntake({ provider: "stub", fields: { roofMaterial: { value: "Tile", confidence: 0.5 } }, lowConfidenceFields: [], notes: "" } as never, "ROOF MATERIAL: COMPOSITION SHINGLE ... ROOF TYPE: CLAY TILE");
  assert.notEqual(both.fields.roofMaterial.value, "Clay Tile");
});

console.log(failures ? `tileRoof: ${failures} FAILED, ${passed} passed` : `tileRoof: ${passed}/${passed} passed`);
if (failures) process.exit(1);
