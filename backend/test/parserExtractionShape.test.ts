// THE PARSER PROMPT AND ITS RESPONSE SHAPE — what the backend hands the parser page.
//
// No real model: the text pass is exercised through the real extractProjectFields with
// askLong stubbed (so the exact system prompt the page's request produces is asserted),
// and normalizeExtraction / finalizeExtraction run on synthetic, PII-free responses.
// Run: tsx backend/test/parserExtractionShape.test.ts
import "./_isolate";
import assert from "node:assert/strict";

const { ClaudeLLMProvider, evidenceSource, normalizeConflicts, normalizeUncertainties, finalizeExtraction } = await import("../src/llm");
const { openDatabase } = await import("../src/db");
const { importCecRows, primeCecCache, lookupCecModuleMake } = await import("../src/cecEquipment");

let passed = 0;
const ok = (n: string) => { passed++; console.log(`ok   ${n}`); };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const provider = new ClaudeLLMProvider("sk-ant-test-key-not-used") as any;

// ---------------------------------------------------------------------------
// 1. The text-pass prompt: structural_letter provenance, structured uncertainty/conflicts,
//    no "not supplied" claims, and no Oregon vocabulary in the generic path.
// ---------------------------------------------------------------------------
{
  let captured = "";
  provider.askLong = async (_label: string, system: string) => { captured = system; return JSON.stringify({ fields: {}, lowConfidenceFields: [], notes: "" }); };
  const r = await provider.extractProjectFields({ planText: "PV 0.0 COVER SHEET SYSTEM SIZE 4.3 KW DC", structuralLetterText: "Roof Height 25 ft" });
  assert.match(captured, /"source": "plan_set\|utility_bill\|meter_photo\|structural_letter"/, "evidence source enum names the structural letter");
  assert.match(captured, /"uncertainties": \[/, "the response shape carries a reason per low-confidence field");
  assert.match(captured, /"conflicts": \[/, "the response shape carries structured cross-document conflicts");
  assert.match(captured, /NEVER write that a bill, meter photo, plan set or letter was "not supplied"/, "a pass may not assert a document it was not given is missing");
  assert.match(captured, /is STATED — it is NOT low confidence merely because no second document confirms it/, "lowConfidence means unreadable/guessed/inferred/conflicting, not unconfirmed");
  assert.doesNotMatch(captured, /contractorCcb: CCB \/ contractor license number/, "CCB is Oregon's board, not the generic licence label");
  assert.match(captured, /HIC, Arizona ROC, Texas TDLR\/TECL, California CSLB/, "the licence field names other states' boards");
  assert.doesNotMatch(captured, /utility: electric utility normalized \("PGE", "Pacific Power"\)/, "the utility field is not normalised to Oregon's two utilities");
  assert.match(captured, /"Eversource", "Oncor", "SRP"/);
  assert.doesNotMatch(captured, /UTILITY INTERCONNECTION \(PGE PowerClerk \/ Pacific Power customer generation NEM\)/);
  assert.deepEqual(r.documentsSeen, ["plan_set", "structural_letter"], "documentsSeen comes from the request, in document order");
  ok("text-pass prompt: structural_letter source, uncertainties + conflicts shape, no not-supplied claims, no Oregon vocabulary; documentsSeen from the request");
}

// ---------------------------------------------------------------------------
// 2. normalizeExtraction keeps the letter's provenance and the structured blocks.
// ---------------------------------------------------------------------------
{
  const raw = JSON.stringify({
    fields: {
      deadLoad: { value: 3, confidence: 0.85, evidence: { source: "structural_letter", sheet: "p.2", excerpt: "Dead Load 3.00 psf" } },
      snow: { value: 40, confidence: 0.9, evidence: { source: "Structural Letter", sheet: "p.2", excerpt: "Ground Snow Load: 40 psf" } },
      dcKw: { value: 4.3, confidence: 0.95, evidence: { source: "cover sheet", excerpt: "SYSTEM SIZE 4.3 KW DC" } },
    },
    lowConfidenceFields: ["deadLoad", 42],
    uncertainties: [{ field: "deadLoad", kind: "conflicting", reason: "letter 3.0 vs plan 2.58" }, { field: "", kind: "guessed" }, { field: "x", kind: "made-up", reason: "r" }],
    conflicts: [
      { field: "deadLoad", readings: [{ value: 3, source: "structural_letter", excerpt: "Dead Load 3.00 psf" }, { value: 2.58, source: "plan_set", excerpt: "Distributed Load 2.58 Per SqFt" }], note: "letter vs plan" },
      { field: "snow", readings: [{ value: 40, source: "plan_set" }] },
      "junk",
    ],
    notes: "n",
  });
  const r = provider.normalizeExtraction(raw, "x");
  assert.equal(r.fields.deadLoad.evidence.source, "structural_letter", "structural_letter provenance survives receipt");
  assert.equal(r.fields.snow.evidence.source, "structural_letter", "loose spelling of the source is normalised");
  assert.equal(r.fields.dcKw.evidence.source, "plan_set", "an unknown source still falls back to plan_set");
  assert.deepEqual(r.lowConfidenceFields, ["deadLoad"], "non-string entries are dropped");
  assert.deepEqual(r.uncertainties, [{ field: "deadLoad", kind: "conflicting", reason: "letter 3.0 vs plan 2.58" }, { field: "x", kind: "guessed", reason: "r" }], "uncertainties validated; unknown kind → guessed; empty field dropped");
  assert.equal(r.conflicts.length, 1, "a one-reading 'conflict' and junk are dropped");
  assert.equal(r.conflicts[0].field, "deadLoad");
  assert.equal(r.conflicts[0].readings[0].source, "structural_letter");
  assert.equal(r.conflicts[0].readings[1].value, 2.58);
  assert.equal(evidenceSource("meter-photo"), "meter_photo");
  assert.equal(normalizeUncertainties("nope"), undefined);
  assert.equal(normalizeConflicts(null), undefined);
  ok("normalizeExtraction: provenance kept, uncertainties/conflicts validated");
}

// ---------------------------------------------------------------------------
// 3. finalizeExtraction: moduleMake from the CEC list — only on a single-manufacturer hit.
// ---------------------------------------------------------------------------
{
  const db = await openDatabase();
  importCecRows(db, "module", [
    { manufacturer: "Sample Modules Inc.", model: "SM.TRON BLK X-G2.C1+/AC", powerW: 430, outputCurrentA: null, listedAt: "2026-01-01" },
    { manufacturer: "Sample Modules Inc.", model: "SM.TRON BLK X-G2.C1+/AC 435", powerW: 435, outputCurrentA: null, listedAt: "2026-01-01" },
    { manufacturer: "Maker A", model: "AMB-400-P", powerW: 400, outputCurrentA: null, listedAt: "2026-01-01" },
    { manufacturer: "Maker B", model: "AMB-400 {240V}", powerW: 400, outputCurrentA: null, listedAt: "2026-01-01" },
    { manufacturer: "Maker C", model: "AMB-400X", powerW: 400, outputCurrentA: null, listedAt: "2026-01-01" },
  ]);
  primeCecCache(db);
  assert.equal(lookupCecModuleMake("SM.TRON BLK X-G2.C1+/AC")?.manufacturer, "Sample Modules Inc.");
  assert.equal(lookupCecModuleMake("sm tron blk x-g2 c1+/ac")?.manufacturer, "Sample Modules Inc.", "punctuation/case-insensitive exact match");
  assert.equal(lookupCecModuleMake("AMB-400-P")?.manufacturer, "Maker A", "exact listing wins");
  assert.equal(lookupCecModuleMake("AMB-400"), null, "two manufacturers list the model at a token boundary → no answer (never guess)");
  assert.equal(lookupCecModuleMake("AMB-400X")?.manufacturer, "Maker C");
  assert.equal(lookupCecModuleMake("ZZZ-999"), null);

  const base = { provider: "claude" as const, notes: "", fields: { moduleModel: { value: "SM.TRON BLK X-G2.C1+/AC", confidence: 0.93, evidence: { source: "plan_set" as const, sheet: "PV 0.0", excerpt: "(26) SM.TRON BLK X-G2.C1+/AC - 430W" } } } };
  // absent make → resolved, with the resolution recorded for the page
  const a = finalizeExtraction({ ...base, lowConfidenceFields: [] }, ["plan_set"]);
  assert.equal(a.fields.moduleMake.value, "Sample Modules Inc.");
  assert.equal(a.resolutions?.[0].field, "moduleMake");
  assert.match(a.resolutions?.[0].how ?? "", /CEC equipment list/);
  assert.deepEqual(a.documentsSeen, ["plan_set"]);
  // unsure make → resolved and un-flagged
  const b = finalizeExtraction({ ...base, fields: { ...base.fields, moduleMake: { value: "SMTRON", confidence: 0.5 } }, lowConfidenceFields: ["moduleMake", "snow"], uncertainties: [{ field: "moduleMake", kind: "inferred", reason: "from the product family" }] }, ["plan_set"]);
  assert.equal(b.fields.moduleMake.value, "Sample Modules Inc.");
  assert.deepEqual(b.lowConfidenceFields, ["snow"]);
  assert.deepEqual(b.uncertainties, []);
  assert.match(b.resolutions?.[0].how ?? "", /the plan set reads "SMTRON"/);
  // MUST-EXCLUDE: a confident make is left alone; a no-match model fills nothing
  const c = finalizeExtraction({ ...base, fields: { ...base.fields, moduleMake: { value: "Sample Modules", confidence: 0.9 } }, lowConfidenceFields: [] }, ["plan_set"]);
  assert.equal(c.fields.moduleMake.value, "Sample Modules");
  assert.equal(c.resolutions, undefined);
  const d = finalizeExtraction({ ...base, fields: { moduleModel: { value: "ZZZ-999", confidence: 0.9 } }, lowConfidenceFields: ["moduleMake"] }, ["plan_set"]);
  assert.equal(d.fields.moduleMake, undefined, "no CEC match → make stays empty");
  assert.deepEqual(d.lowConfidenceFields, ["moduleMake"]);
  assert.equal(d.resolutions, undefined);
  const e = finalizeExtraction({ ...base, fields: { moduleModel: { value: "AMB-400", confidence: 0.9 } }, lowConfidenceFields: ["moduleMake"] }, ["plan_set"]);
  assert.equal(e.fields.moduleMake, undefined, "ambiguous listing → make stays empty");
  ok("finalizeExtraction: CEC make on a single-manufacturer hit only; confident make untouched; no match / ambiguity fills nothing");
}

console.log(`\nparserExtractionShape: all ${passed} checks passed`);
