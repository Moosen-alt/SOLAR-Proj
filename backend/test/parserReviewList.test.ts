// THE PARSER PAGE'S REVIEW LIST — every rule in frontend/parser-review.js, MUST-PASS and
// MUST-EXCLUDE, on synthetic look-alike text (no operator documents, no PII, no LLM).
//
// The module is the page's own file, loaded through node:vm exactly as the browser sees it,
// so a rule removed from the page fails here. Each block names the fix it guards; each was
// run with the fix disabled to confirm it fails (see .probe/prl/report.json "failsWithoutFix").
// Run: tsx backend/test/parserReviewList.test.ts
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { REPO } from "./_isolate";

const src = fs.readFileSync(path.join(REPO, "frontend", "parser-review.js"), "utf8");
const sandbox: { window: Record<string, unknown> } = { window: {} };
vm.runInNewContext(src, sandbox, { filename: "parser-review.js" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PR = sandbox.window.ParserReview as any;
assert.ok(PR, "parser-review.js must attach window.ParserReview");

let passed = 0;
const ok = (n: string) => { passed++; console.log(`ok   ${n}`); };
// Values cross the vm realm boundary (different Array prototype), so compare by shape.
const same = (a: unknown, b: unknown, msg?: string) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

// ---------------------------------------------------------------------------
// 1. METER CROSS-CHECK — one predicate; the reading's provenance picks the field.
// ---------------------------------------------------------------------------
assert.equal(PR.compareMeters("1234567", "1234567"), "DIGITS MATCH");
assert.match(PR.compareMeters("1234567", ""), /UB or meter photo meter missing/);
assert.match(PR.compareMeters("1234567", "7654321"), /^MISMATCH/);
same(PR.meterTargets({ source: "utility_bill", vision: false }), ["meter", "ubMeterNumber"], "a bill meter read by the TEXT pass is the UB meter");
same(PR.meterTargets({ source: "meter_photo", vision: false }), ["meter", "ubMeterNumber"]);
same(PR.meterTargets({ source: "plan_set", vision: true }), ["planMeterNumber"], "a plan-set meter is the plan meter whichever pass read it");
same(PR.meterTargets({ source: undefined, vision: false, docsGiven: ["plan_set", "structural_letter"] }), ["planMeterNumber"]);
same(PR.meterTargets({ source: undefined, vision: false, docsGiven: ["utility_bill"] }), ["meter", "ubMeterNumber"], "no provenance + no plan set given → it can only be the bill's");
same(PR.meterTargets({ source: undefined, vision: true }), ["meter", "ubMeterNumber"]);
// verbatim confirmation in the plan text: grouped digits count, near-misses do not
assert.equal(PR.meterInText("UTILITY: SAMPLE POWER METER #123 456 789. ESID 1234", "123456789"), "123 456 789");
assert.equal(PR.meterInText("METER NUMBER: 3141592", "3141592"), "3141592");
assert.equal(PR.meterInText("METER NUMBER: 13141592", "3141592"), "", "a longer number containing the digits is not the meter");
assert.equal(PR.meterInText("METER NUMBER: 3141593", "3141592"), "");
assert.equal(PR.meterInText("METER 12345", "12345"), "", "too short to be a verbatim confirmation");
ok("meter: provenance routes the reading; one compare predicate; verbatim plan-text confirmation");

// ---------------------------------------------------------------------------
// 2. NOTES — one attributed section; a pass may not assert an attached doc was not supplied.
// ---------------------------------------------------------------------------
{
  const passes = [
    { label: "photos", docsGiven: ["utility_bill", "meter_photo"], notes: "Meter number matches on both bill and meter faceplate. Account printed in spaced segments." },
    { label: "text", docsGiven: ["plan_set", "structural_letter"], notes: "NAME CONFLICT: title block vs letter — verify with the utility bill (no bill supplied). No utility bill or meter photo provided, so account number and rate schedule are unknown. Dead load: letter 3.0 psf vs plan 2.58 psf. Building height taken from 'Roof Height 25 ft'." },
  ];
  const m = PR.mergeNotes(passes, ["plan_set", "utility_bill", "meter_photo", "structural_letter"]);
  assert.equal(m.sections.length, 2, "one attributed section per pass, not a bare 'Notes:' per pass");
  assert.doesNotMatch(m.text, /no bill supplied|No utility bill or meter photo provided/i, "a pass not given the bill may not say it was not supplied");
  assert.match(m.text, /verify with the utility bill/, "the useful part of the sentence survives");
  assert.match(m.text, /Dead load: letter 3.0 psf/);
  assert.match(m.text, /read: plan set \+ structural letter/);
  assert.equal(m.dropped.length, 2);
  // the review list gets ONE notes item carrying both attributions — never two "Notes" entries
  assert.equal((m.line.match(/Notes/g) || []).length, 1, m.line);
  assert.match(m.line, /^Notes — \(photos, read: utility bill \+ meter photo\): .* ‖ \(text, read: plan set \+ structural letter\): /);
  assert.equal(PR.mergeNotes([], ["plan_set"]).line, "");
  // MUST-EXCLUDE: when the bill really is NOT attached, the sentence stands.
  const m2 = PR.mergeNotes([passes[1]], ["plan_set", "structural_letter"]);
  assert.match(m2.text, /No utility bill or meter photo provided/);
  assert.equal(m2.dropped.length, 0);
  ok("notes: one attributed section; 'not supplied' claims dropped only for attached documents");
}

// ---------------------------------------------------------------------------
// 3. RESOLUTION — resolve deterministically before flagging, never by inventing.
// ---------------------------------------------------------------------------
const planTextSF = `PV 0.0 COVER  JANE SAMPLE RESIDENCE  100 EXAMPLE RD  INTERCONNECTION METHOD: LOAD BREAKER
SHUTDOWN - NO   MID CLAMPS 16   Distributed Load 2.58 Per SqFt
E 1.2 NOTES  RAPID SHUTDOWN PER NEC 690.12  LABELS PER 690.56`;
const field = (value: unknown, source: string, excerpt: string, confidence = 0.55, sheet = "") => ({ value, confidence, evidence: { source, sheet, excerpt } });
const textPass = (fields: Record<string, unknown>, low: string[], extra: Record<string, unknown> = {}) => ({ kind: "text", label: "text", docsGiven: ["plan_set", "structural_letter"], response: { fields, lowConfidenceFields: low, notes: "", ...extra } });
const visionPass = (fields: Record<string, unknown>) => ({ kind: "vision", label: "photos", docsGiven: ["utility_bill", "meter_photo"], response: { fields, lowConfidenceFields: [], notes: "" } });

{
  const items = PR.resolveReviewItems({
    attached: ["plan_set", "utility_bill", "meter_photo", "structural_letter"],
    planText: planTextSF,
    passes: [
      visionPass({ owner: field("JANE SAMPLE", "utility_bill", "Service Provided To: JANE SAMPLE", 0.97, "header") }),
      textPass({
        owner: field("Jane Sample", "plan_set", "JANE SAMPLE RESIDENCE", 0.45, "PV 0.0"),
        buildingHeightFeet: field(25, "structural_letter", "Roof Height 25 ft", 0.55, "p.1"),
        buildingHeightInches: field(0, "structural_letter", "Roof Height 25 ft", 0.5, "p.1"),
        moduleHeightAboveRoof: field(6, "plan_set", 'PANELS WILL NOT EXTEND MORE THAN 6" ABOVE PITCHED ROOF SURFACES', 0.6, "S 1.1"),
        deadLoad: field(3, "structural_letter", "Dead Load 3.00 psf", 0.85, "p.2"),
        dwellingUnits: field(1, "plan_set", "MAIN HOUSE / JANE SAMPLE RESIDENCE", 0.55, "PV 1.0"),
        numberOfBuildings: field(1, "plan_set", "MAIN HOUSE", 0.55, "PV 1.0"),
        framingType: field("truss", "structural_letter", 'For (2) #14 X 3", 1/2" Hex into trusses', 0.45, "p.2"),
        pvBreaker: field("40A", "plan_set", "MAX. PV OCPD (200A x 120%) - 200 = 40A", 0.75, "E 1.1"),
        attachmentEdgeSpacingIn: field(32, "structural_letter", "Zone 3r Attachments at 32 in O.C. with 2 rails", 0.7, "p.3"),
      }, ["owner", "buildingHeightFeet", "buildingHeightInches", "moduleHeightAboveRoof", "dwellingUnits", "numberOfBuildings", "framingType", "pvBreaker", "attachmentEdgeSpacingIn", "existingBuildingArea", "moduleMake"], {
        conflicts: [
          { field: "deadLoad", readings: [{ value: 3, source: "structural_letter", sheet: "p.2", excerpt: "Dead Load 3.00 psf" }, { value: 2.58, source: "plan_set", sheet: "PV 1.1", excerpt: "Distributed Load 2.58 Per SqFt" }] },
          { field: "owner", readings: [{ value: "JANE SAMPLE RESIDENCE", source: "plan_set", sheet: "PV 0.0", excerpt: "JANE SAMPLE RESIDENCE" }, { value: "Robin Other Residence", source: "structural_letter", sheet: "p.1", excerpt: "Robin Other Residence" }] },
          { field: "framingType", readings: [{ value: "rafter", source: "structural_letter", sheet: "p.1 table", excerpt: "Rafter Size 2x10 in" }, { value: "truss", source: "structural_letter", sheet: "p.2", excerpt: "into trusses" }, { value: "deck", source: "plan_set", sheet: "S 1.1", excerpt: "DECK MOUNT 2-1/2 MIN EMBEDMENT" }] },
        ],
        uncertainties: [
          { field: "buildingHeightFeet", kind: "unconfirmed", reason: "roof height taken as building height" },
          { field: "pvBreaker", kind: "inferred", reason: "read as the 705.12 maximum, the SLD tag is noisy" },
        ],
        resolutions: [{ field: "moduleMake", value: "Hanwha Q CELLS", how: "CEC equipment list: model Q.TRON BLK M-G2.C1+/AC is listed under Hanwha Q CELLS" }],
      }),
    ],
  });
  const R = (f: string) => items.resolved.find((x: { field: string }) => x.field === f);
  const U = (f: string) => items.unsure.find((x: { field: string }) => x.field === f);
  const M = (f: string) => items.missing.find((x: { field: string }) => x.field === f);
  const C = (f: string) => items.conflicts.find((x: { field: string }) => x.field === f);

  // stated verbatim on a sealed letter / the plan set → RESOLVED with evidence
  assert.ok(R("buildingHeightFeet") && R("buildingHeightFeet").value === 25 && /Roof Height 25 ft/.test(R("buildingHeightFeet").how), "buildingHeightFeet 25 is stated, not unsure");
  assert.ok(R("buildingHeightInches") && R("buildingHeightInches").value === 0 && /whole feet/.test(R("buildingHeightInches").how));
  assert.ok(R("moduleHeightAboveRoof") && R("moduleHeightAboveRoof").value === 6);
  // conflict the sealed-source rule resolves → RESOLVED with the rule named
  assert.ok(R("deadLoad") && R("deadLoad").value === 3 && /sealed-source rule/.test(R("deadLoad").how) && /2\.58/.test(R("deadLoad").how), "deadLoad resolved by the sealed-source rule, naming both readings");
  // owner: bill account holder is the tie-breaker when it matches one candidate
  assert.ok(R("owner") && R("owner").value === "JANE SAMPLE" && /account of record/.test(R("owner").how) && /Robin Other/.test(R("owner").how), "owner resolved to the bill holder, naming the letter's other name");
  assert.ok(!C("owner"));
  // single-family → 1 / 1 with basis
  assert.ok(R("dwellingUnits") && R("dwellingUnits").value === 1 && /RESIDENCE/.test(R("dwellingUnits").how));
  assert.ok(R("numberOfBuildings") && R("numberOfBuildings").value === 1);
  // CEC make → RESOLVED from the server-side resolution
  assert.ok(R("moduleMake") && /CEC/.test(R("moduleMake").how));
  // framingType stays a CONFLICT naming all three readings
  assert.ok(C("framingType") && C("framingType").readings.length === 3 && /rafter/.test(C("framingType").text) && /truss/.test(C("framingType").text) && /deck/.test(C("framingType").text), "framingType is a conflict naming three readings");
  assert.ok(!R("framingType"));
  // a calculation line is not a stated value → UNSURE with value + evidence + why
  assert.ok(U("pvBreaker") && U("pvBreaker").value === "40A" && /705\.12 maximum/.test(U("pvBreaker").why), "pvBreaker from a formula line stays unsure, with the reason");
  assert.ok(!R("pvBreaker"), "a number inside a calculation must not be 'stated'");
  // a derived zone-table reading is not auto-resolved
  assert.ok(U("attachmentEdgeSpacingIn") && U("attachmentEdgeSpacingIn").value === 32 && U("attachmentEdgeSpacingIn").evidence.excerpt);
  // nothing anywhere → MISSING with who supplies it
  assert.ok(M("existingBuildingArea") && /assessor|homeowner/.test(M("existingBuildingArea").suppliedBy));
  // RSD contradiction is a structured CONFLICT
  assert.ok(C("rapidShutdown") && C("rapidShutdown").readings.length === 2 && /SHUTDOWN - NO/.test(C("rapidShutdown").text) && /690\.12/i.test(C("rapidShutdown").text), "RSD contradiction surfaces as a structured conflict");
  same(items.counts, { resolved: items.resolved.length, unsure: items.unsure.length, missing: items.missing.length, conflicts: items.conflicts.length });
  // No "Not fully sure" survives as a bare line: every flagged field landed in exactly one bucket.
  const all = [...items.resolved, ...items.unsure, ...items.missing, ...items.conflicts].map((x: { field: string }) => x.field);
  for (const f of ["owner", "buildingHeightFeet", "buildingHeightInches", "moduleHeightAboveRoof", "dwellingUnits", "numberOfBuildings", "framingType", "pvBreaker", "attachmentEdgeSpacingIn", "existingBuildingArea", "moduleMake"]) {
    assert.equal(all.filter((x) => x === f).length, 1, `${f} lands in exactly one bucket`);
  }
  const lines = PR.formatReviewList(items);
  assert.match(lines[0], /^CONFLICTS \(\d+\)/);
  assert.ok(lines.some((l: string) => /^UNSURE \(\d+\)/.test(l)) && lines.some((l: string) => /^MISSING \(\d+\)/.test(l)) && lines.some((l: string) => /^RESOLVED \(\d+\)/.test(l)));
  ok("resolution: stated / sealed-source / owner-by-bill / single-family / CEC make resolved; framing + RSD conflicts; formula stays unsure; missing names its supplier");
}

// MUST-EXCLUDE: never resolve by inventing.
{
  // dwellingUnits=1 on a duplex stays open
  const duplex = PR.resolveReviewItems({ attached: ["plan_set"], planText: "JANE SAMPLE RESIDENCE  DUPLEX - 2 UNITS  100 EXAMPLE RD", passes: [textPass({ dwellingUnits: field(1, "plan_set", "RESIDENCE", 0.5) }, ["dwellingUnits"])] });
  assert.ok(!duplex.resolved.some((x: { field: string }) => x.field === "dwellingUnits"), "dwellingUnits must not resolve to 1 on a duplex");
  assert.ok(duplex.unsure.some((x: { field: string }) => x.field === "dwellingUnits"));
  assert.equal(PR.singleFamilyBasis("JANE SAMPLE RESIDENCE  TWO-FAMILY DWELLING"), null);
  assert.equal(PR.singleFamilyBasis("JANE SAMPLE RESIDENCE  OCCUPANCY: R-2"), null);
  // a racking calculation's "2 Unit Depth" is not a two-unit building
  assert.equal(PR.singleFamilyBasis("JANE SAMPLE RESIDENCE  Unit Depth x Unit Width x Unit Depth / 2 Unit Depth = 7.60 in."), "RESIDENCE");
  // an array drawn on a detached garage: numberOfBuildings stays open
  const garage = PR.resolveReviewItems({ attached: ["plan_set"], planText: "JANE SAMPLE RESIDENCE  (N) 8 MODULES ON DETACHED GARAGE  MAIN HOUSE", passes: [textPass({ numberOfBuildings: field(1, "plan_set", "MAIN HOUSE", 0.5) }, ["numberOfBuildings"])] });
  assert.ok(!garage.resolved.some((x: { field: string }) => x.field === "numberOfBuildings"));
  // owner: bill name matches neither candidate → CONFLICT naming all, never resolved
  const owner = PR.resolveReviewItems({ attached: ["plan_set", "utility_bill"], planText: planTextSF, passes: [
    visionPass({ owner: field("PAT UNRELATED", "utility_bill", "Service Provided To: PAT UNRELATED", 0.97) }),
    textPass({ owner: field("Jane Sample", "plan_set", "JANE SAMPLE RESIDENCE", 0.45) }, ["owner"], { conflicts: [{ field: "owner", readings: [{ value: "JANE SAMPLE RESIDENCE", source: "plan_set" }, { value: "Robin Other Residence", source: "structural_letter" }] }] }),
  ] });
  assert.ok(!owner.resolved.some((x: { field: string }) => x.field === "owner"), "owner must not resolve when the bill holder matches no candidate");
  const oc = owner.conflicts.find((x: { field: string }) => x.field === "owner");
  assert.ok(oc && oc.readings.length === 3 && /UNRELATED/.test(oc.text) && /Robin Other/.test(oc.text), "owner conflict names the bill holder and both document names");
  // a make with no CEC match is not filled: no server resolution → stays unsure/missing
  const make = PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [textPass({ moduleModel: field("ZZZ-999", "plan_set", "MODULES: 10 ZZZ-999", 0.9) }, ["moduleMake"])] });
  assert.ok(!make.resolved.some((x: { field: string }) => x.field === "moduleMake"));
  assert.ok(make.missing.some((x: { field: string }) => x.field === "moduleMake"));
  // a model-reported CONFLICT on a structural field whose letter readings disagree is not resolved by the letter
  const split = PR.resolveReviewItems({ attached: ["plan_set", "structural_letter"], planText: planTextSF, passes: [textPass({ snow: field(40, "structural_letter", "Ground Snow Load 40 psf", 0.6) }, ["snow"], { conflicts: [{ field: "snow", readings: [{ value: 40, source: "structural_letter" }, { value: 30, source: "structural_letter" }, { value: 40, source: "plan_set" }] }] })] });
  assert.ok(!split.resolved.some((x: { field: string }) => x.field === "snow") && split.conflicts.some((x: { field: string }) => x.field === "snow"));
  // a number inside a calculation line is never "stated", even with no reason attached
  const formula = PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [textPass({ busRating: field("200A", "plan_set", "MAX. PV OCPD (200A x 120%) - 200 = 40A BUS", 0.7) }, ["busRating"])] });
  assert.ok(formula.unsure.some((x: { field: string }) => x.field === "busRating") && !formula.resolved.length, "a calculation line must not resolve a stated field");
  // a guessed/inferred value with a verbatim-looking excerpt is still unsure
  const inferred = PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [textPass({ moduleHeightAboveRoof: field(6, "plan_set", '6" MAX', 0.5) }, ["moduleHeightAboveRoof"], { uncertainties: [{ field: "moduleHeightAboveRoof", kind: "inferred", reason: "from a dimension on the mount detail" }] })] });
  assert.ok(inferred.unsure.some((x: { field: string }) => x.field === "moduleHeightAboveRoof") && !inferred.resolved.length);
  // RSD: labels alone, no "SHUTDOWN - NO" → no conflict
  assert.equal(PR.rsdConflict("E 1.2 NOTES RAPID SHUTDOWN PER NEC 690.12"), null);
  assert.equal(PR.rsdConflict("SHUTDOWN - NO"), null);
  // RSD reported by the model under another field name is not listed twice
  const rsdOnce = PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [textPass({}, [], { conflicts: [{ field: "electricalCalcText", readings: [{ value: "SHUTDOWN - NO", source: "plan_set", excerpt: "SHUTDOWN - NO" }, { value: "rapid shutdown labels shown", source: "plan_set", excerpt: "RAPID SHUTDOWN 690.12" }] }] })] });
  assert.equal(rsdOnce.conflicts.length, 1, "one RSD conflict, not the model's plus the page's");
  // a whole-feet height resolves its 0 inches even when the model calls it inferred
  const inches = PR.resolveReviewItems({ attached: ["plan_set", "structural_letter"], planText: planTextSF, passes: [textPass({ buildingHeightInches: field(0, "structural_letter", "Roof Height 25 ft", 0.5) }, ["buildingHeightInches"], { uncertainties: [{ field: "buildingHeightInches", kind: "inferred", reason: "height given only in whole feet" }] })] });
  assert.ok(inches.resolved.some((x: { field: string }) => x.field === "buildingHeightInches"));
  // the letter's "Roof Height N ft" is the building height even when the model calls it inferred
  const feet = PR.resolveReviewItems({ attached: ["plan_set", "structural_letter"], planText: planTextSF, passes: [textPass({ buildingHeightFeet: field(15, "structural_letter", "Roof Height 15 ft", 0.75) }, ["buildingHeightFeet"], { uncertainties: [{ field: "buildingHeightFeet", kind: "inferred", reason: "no grade-to-ridge height stated" }] })] });
  assert.ok(feet.resolved.some((x: { field: string; value: number }) => x.field === "buildingHeightFeet" && x.value === 15));
  // a flagged meter the cross-check already confirmed is RESOLVED; a mismatch is a CONFLICT; no verdict → unsure
  const meterOk = PR.resolveReviewItems({ attached: ["plan_set", "meter_photo"], planText: planTextSF, meterVerdict: "DIGITS MATCH", passes: [textPass({ meter: field("5000000123", "plan_set", "UTILITY METER #5 000 000 123", 0.6) }, ["meter"])] });
  assert.ok(meterOk.resolved.some((x: { field: string; how: string }) => x.field === "meter" && /DIGITS MATCH/.test(x.how)));
  const meterBad = PR.resolveReviewItems({ attached: ["plan_set", "meter_photo"], planText: planTextSF, meterVerdict: "MISMATCH. Plan 5000000123 vs UB/photo 5000000124.", passes: [textPass({ meter: field("5000000123", "plan_set", "UTILITY METER #5 000 000 123", 0.6) }, ["meter"])] });
  assert.ok(meterBad.conflicts.some((x: { field: string }) => x.field === "meter") && !meterBad.resolved.length);
  const meterNone = PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, meterVerdict: "Plan meter parsed. UB or meter photo meter missing.", passes: [textPass({ meter: field("5000000123", "plan_set", "UTILITY METER #5 000 000 123", 0.6) }, ["meter"])] });
  assert.ok(meterNone.unsure.some((x: { field: string }) => x.field === "meter"));
  // two documents agree + one confident reading → RESOLVED; one pass alone at 78% stays unsure
  const agree = PR.resolveReviewItems({ attached: ["plan_set", "utility_bill", "meter_photo"], planText: planTextSF, passes: [
    { kind: "vision", label: "photos", docsGiven: ["meter_photo"], response: { fields: { state: field("AZ", "meter_photo", "SRP CONNECT", 0.5) }, lowConfidenceFields: ["state"], notes: "" } },
    textPass({ state: field("AZ", "utility_bill", "PHOENIX AZ 85040", 0.97) }, []),
  ] });
  assert.ok(agree.resolved.some((x: { field: string; how: string }) => x.field === "state" && /two documents agree/.test(x.how)));
  const alone = PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [textPass({ pvBreaker: field("30A", "plan_set", "(N) PV BREAKER 30A/2P", 0.78) }, ["pvBreaker"], { uncertainties: [{ field: "pvBreaker", kind: "inferred", reason: "label and value glued" }] })] });
  assert.ok(alone.unsure.some((x: { field: string }) => x.field === "pvBreaker") && !alone.resolved.length, "one pass's flagged reading is not resolved by its own confidence");
  const disagree = PR.resolveReviewItems({ attached: ["plan_set", "utility_bill"], planText: planTextSF, passes: [
    { kind: "vision", label: "photos", docsGiven: ["utility_bill"], response: { fields: { state: field("NM", "utility_bill", "ALBUQUERQUE NM", 0.9) }, lowConfidenceFields: ["state"], notes: "" } },
    textPass({ state: field("AZ", "plan_set", "PHOENIX AZ", 0.97) }, []),
  ] });
  assert.ok(disagree.conflicts.some((x: { field: string }) => x.field === "state") && !disagree.resolved.length, "disagreeing documents are a conflict, never resolved by confidence");
  ok("must-exclude: duplex, outbuilding array, unmatched bill holder, no-CEC make, split letter, inferred value, RSD needs both readings");
}

// ---------------------------------------------------------------------------
// 4. NO OREGON LEAKAGE — licence label by state; identified ≠ unknown utility.
// ---------------------------------------------------------------------------
assert.equal(PR.licenseLabel("MA"), "HIC");
assert.equal(PR.licenseLabel("PA"), "HIC");
assert.equal(PR.licenseLabel("AZ"), "ROC");
assert.equal(PR.licenseLabel("TX"), "TDLR/TECL");
assert.equal(PR.licenseLabel("CA"), "CSLB");
assert.equal(PR.licenseLabel("OR"), "CCB");
assert.equal(PR.licenseLabel("KS"), "contractor license");
assert.equal(PR.licenseLabel(""), "contractor license");
{
  const line = PR.installerLine({ contractorCompany: "Sample Solar", contractorCcb: "N/A", contractorEmail: "N/A", contractorPhone: "1-800-000-0000", contractorElectricalLicense: "" }, "MA");
  assert.equal(line, "Plan-set installer read from the title block: Sample Solar | 1-800-000-0000", "N/A fields are dropped from the installer line");
  assert.match(PR.installerLine({ contractorCompany: "Sample Solar", contractorCcb: "123456" }, "MA"), /HIC 123456/);
  assert.match(PR.installerLine({ contractorCompany: "Sample Solar", contractorCcb: "123456" }, "OR"), /CCB 123456/);
  assert.doesNotMatch(PR.installerLine({ contractorCompany: "Sample Solar", contractorCcb: "123456" }, "MA"), /CCB/);
}
{
  const ev = PR.identifyUtility("Eversource", "COVER SHEET UTILITY: EVERSOURCE");
  same([ev.norm, ev.identified, ev.sop, ev.name], ["OTHER", true, false, "Eversource"], "Eversource is IDENTIFIED with no SOP rule table");
  const pge = PR.identifyUtility("PGE", "");
  same([pge.norm, pge.identified, pge.sop], ["PGE", true, true]);
  const pac = PR.identifyUtility("", "UTILITY: PACIFIC POWER");
  same([pac.norm, pac.sop], ["PACIFICORP", true]);
  const unk = PR.identifyUtility("", "COVER SHEET WITH NO UTILITY LINE");
  same([unk.norm, unk.identified], ["UNKNOWN", false], "nothing named it → UNKNOWN");
}
ok("no Oregon leakage: licence label by state, N/A dropped, identified-vs-unknown utility");

// ---------------------------------------------------------------------------
// 5. LOCATES — SOP utilities unchanged; others fire on excavation evidence only.
// ---------------------------------------------------------------------------
{
  const pgeRule = ["MPU", "FSU", "PSU", "MMD", "METER_BASE", "TAP", "FULL_HOME_BACKUP", "PARTIAL_HOME_BACKUP", "TRENCH", "UNDERGROUND", "SERVICE_RELOCATION"];
  // operator SOP (PGE): a tap still needs locates, exactly as before
  assert.equal(PR.locatesDecision({ sop: true, ruleLocatesRequired: pgeRule, nonBreakerTypes: ["TAP"], breakerOnly: false, evidence: [] }).needed, true);
  assert.equal(PR.locatesDecision({ sop: true, ruleLocatesRequired: pgeRule, nonBreakerTypes: ["MPU"], breakerOnly: false, evidence: [] }).needed, true, "PGE MPU: locates per SOP");
  assert.equal(PR.locatesDecision({ sop: true, ruleLocatesRequired: pgeRule, nonBreakerTypes: [], breakerOnly: true, evidence: [] }).needed, false);
  // no SOP (Eversource, Oncor, SRP...): a tap or MPU with no digging → no 811
  assert.equal(PR.locatesDecision({ sop: false, ruleLocatesRequired: pgeRule, nonBreakerTypes: ["TAP"], breakerOnly: false, evidence: [{ type: "TAP", text: "SUPPLY SIDE TAP" }] }).needed, false, "a supply-side tap with no excavation is not an 811 job");
  assert.equal(PR.locatesDecision({ sop: false, ruleLocatesRequired: pgeRule, nonBreakerTypes: ["MPU"], breakerOnly: false, evidence: [{ type: "MPU", text: "MPU" }] }).needed, false);
  // MUST-EXCLUDE: real excavation still fires, quoting the evidence
  const trench = PR.locatesDecision({ sop: false, ruleLocatesRequired: pgeRule, nonBreakerTypes: ["TRENCH"], breakerOnly: false, evidence: [{ type: "TRENCH", page: 2, sheet: "PV 1.1", text: "~119 FT TRENCH TO BE 24\" DEEP", snippet: "" }] });
  assert.equal(trench.needed, true);
  assert.match(trench.quotes[0], /TRENCH TO BE 24/);
  // a one-word match quotes its context, and repeats collapse
  const kw = PR.locatesDecision({ sop: false, ruleLocatesRequired: pgeRule, nonBreakerTypes: ["TRENCH"], breakerOnly: false, evidence: [
    { type: "TRENCH", page: 3, sheet: "PV 1.1", text: "TRENCH", snippet: "ON WALL (UNDER EAVE) ~119 FT TRENCH TO BE 24\" DEEP WITH 18\" MINIMUM FILL" },
    { type: "TRENCH", page: 3, sheet: "PV 1.1", text: "TRENCH", snippet: "ON WALL (UNDER EAVE) ~119 FT TRENCH TO BE 24\" DEEP WITH 18\" MINIMUM FILL" },
  ] });
  assert.equal(kw.quotes.length, 1);
  assert.match(kw.quotes[0], /119 FT TRENCH TO BE 24/);
  assert.equal(PR.locatesDecision({ sop: false, ruleLocatesRequired: pgeRule, nonBreakerTypes: ["UNDERGROUND"], breakerOnly: false, evidence: [{ type: "UNDERGROUND", text: "NEW UNDERGROUND CONDUIT" }] }).needed, true);
  assert.equal(PR.locatesDecision({ sop: false, ruleLocatesRequired: pgeRule, nonBreakerTypes: ["SERVICE_RELOCATION"], breakerOnly: false, evidence: [{ type: "SERVICE_RELOCATION", text: "METER RELOCATION" }] }).needed, true);
  assert.equal(PR.locatesDecision({ sop: false, ruleLocatesRequired: pgeRule, nonBreakerTypes: ["POLE"], breakerOnly: false, evidence: [{ type: "POLE", text: "NEW UTILITY POLE" }] }).needed, true);
  ok("locates: SOP rules untouched; non-SOP utilities fire on excavation evidence only");
}

// ---------------------------------------------------------------------------
// 6b. TAP vs BREAKER — the plan's own interconnection callout sets scope; notes never do.
// ---------------------------------------------------------------------------
{
  const ev = (type: string, text: string, snippet: string, sheetType = "sld", page = 7) => ({ type, text, snippet, sheetType, page, sheet: "", confidence: 0.9 });
  // MUST-PASS (the MA shape): cover says LOAD BREAKER, SLD says POINT OF INTERCONNECT, LOAD BREAKER; a general
  // note lists "5. FEEDER TAP INTERCONNECTION (LOADSIDE) ACCORDING TO NEC 705.12(B)(1) 6. SUPPLY SIDE TAP ... NEC 705.11"
  const noteTaps = [
    ev("TAP", "SUPPLY SIDE TAP", "OUTPUT IS EXEMPT FROM ADDITIONAL ENTRANCE CONDUCTORS IN ACCORDANCE WITH NEC 230.42 2.7.8 BACKFEEDING SUPPLY SIDE TAP INTERCONNECTION ACCORDING TO NEC 705.11 WITH SERVICE FEEDER TAP INTERCONNECTION (LOADSIDE)"),
    ev("TAP", "FEEDER TAP", "MAY BE EXCLUDED ACCORDING TO NEC 705.12 (B)(3)(3). 5. FEEDER TAP INTERCONNECTION (LOADSIDE) ACCORDING TO NEC 705.12 (B)(1) 6. SUPPLY SIDE TAP INTERCONNECTION ACCORDING TO NEC 705.11"),
  ];
  const breakers = [
    ev("BREAKER", "INTERCONNECTION METHOD: LOAD BREAKER", "MICRO-INVERTER: (10) SAMPLE INTERCONNECTION METHOD: LOAD BREAKER AHJ: SAMPLE CITY", "cover", 1),
    ev("BREAKER", "POINT OF INTERCONNECT, LOAD BREAKER 20A/2P", "UTILITY METER POINT OF INTERCONNECT, LOAD BREAKER 20A/2P N UTILITY SERVICE", "sld", 6),
  ];
  const r = PR.filterTapEvidence(noteTaps, breakers);
  assert.equal(r.kept.length, 0, "general-note tap mentions never set scope");
  assert.equal(r.dropped.length, 2);
  assert.match(r.dropped[0].why, /code-reference|option/);
  // a label heading followed a sentence later by a numbered code note is NOT an explicit callout
  const heading = PR.filterTapEvidence([ev("TAP", "POINT OF INTERCONNECT 4. THE COMBINED OVERCURRENT DEVICE MAY BE EXCLUDED ACCORDING TO NEC 705.12 (B)(3)(3). 5. FEEDER TAP INTERCONNECTION (LOADSIDE) ACCORDING TO NEC 705.12 (B)(1) 6. SUPPLY SIDE TAP", "WIRE TAG BUS BAR RATING POINT OF INTERCONNECT 4. THE COMBINED OVERCURRENT DEVICE MAY BE EXCLUDED ACCORDING TO NEC 705.12 (B)(3)(3). 5. FEEDER TAP INTERCONNECTION (LOADSIDE) ACCORDING TO NEC 705.12 (B)(1) 6", "notes", 3)], breakers);
  assert.equal(heading.kept.length, 0, "a heading word 220 chars before a numbered tap note is not a callout");
  assert.equal(heading.explicitTap.length, 0);
  // a bare tap mention (not a code clause) while the callout names a breaker: dropped, citing the callout
  const bare = PR.filterTapEvidence([ev("TAP", "LOAD SIDE TAP", "SEE DETAIL FOR LOAD SIDE TAP LUG KIT", "notes", 9)], breakers);
  assert.equal(bare.kept.length, 0);
  assert.match(bare.dropped[0].why, /INTERCONNECTION METHOD: LOAD BREAKER/);
  // MUST-EXCLUDE: a real supply/line-side tap on the cover callout or the SLD is still detected
  const realCover = PR.filterTapEvidence([ev("TAP", "INTERCONNECTION METHOD: LINE SIDE TAP", "BATTERY: (01) SAMPLE INTERCONNECTION METHOD: LINE SIDE TAP AHJ: SAMPLE CITY", "cover", 1), ...noteTaps], []);
  assert.equal(realCover.kept.length, 1);
  assert.equal(realCover.explicitTap.length, 1);
  const realSld = PR.filterTapEvidence([ev("TAP", "POINT OF INTERCONNECTION , SUPPLY SIDE TAP", "UTILITY METER POINT OF INTERCONNECTION , SUPPLY SIDE TAP (N) SERVICE ENTRANCE CONDUCTORS", "sld", 6)], []);
  assert.equal(realSld.kept.length, 1, "an SLD point-of-interconnection tap callout is scope");
  // a real load-side tap job whose SLD also carries breaker words: the explicit tap callout wins
  const both = PR.filterTapEvidence([ev("TAP", "POINT OF INTERCONNECT , LOAD SIDE TAP", "POINT OF INTERCONNECT , LOAD SIDE TAP 200A BUS", "sld", 6), ev("TAP", "LOAD SIDE TAP", "SEE LOAD SIDE TAP DETAIL", "sld", 6)], [ev("BREAKER", "(N) PV BREAKER", "(N) PV BREAKER 40A/2P", "sld", 6)]);
  assert.equal(both.kept.length, 2, "explicit tap callout keeps the bare mentions too");
  // a bare mention with nothing explicit either way stays (the engine's old behaviour)
  const lone = PR.filterTapEvidence([ev("TAP", "SUPPLY SIDE TAP", "NEW SUPPLY SIDE TAP AT SERVICE ENTRANCE", "sld", 6)], []);
  assert.equal(lone.kept.length, 1);
  ok("tap vs breaker: callout sets scope; code-reference/option notes never do; real taps still detected");
}

// ---------------------------------------------------------------------------
// 6b (close). A code clause counts only when it belongs to the tap phrase itself — the same
// sentence, numbered note or label — never because it sits nearby. Label pages run labels
// together with no punctuation; on real line-side-tap jobs the label is the ONLY TAP evidence.
// ---------------------------------------------------------------------------
{
  // the evidence's own tap sits ~120 chars into the snippet, as the scope engine builds it
  const at120 = (pre: string, tap: string, post: string) => (" ".repeat(Math.max(0, 120 - pre.length)) + pre).slice(-120) + tap + post;
  const ev = (text: string, snippet: string, sheetType = "labels", page = 9) => ({ type: "TAP", text, snippet, sheetType, page, sheet: "", confidence: 0.8 });
  const keep = (label: string, e: ReturnType<typeof ev>) => { const r = PR.filterTapEvidence([e], []); assert.equal(r.kept.length, 1, `${label} must be KEPT: ${JSON.stringify(r.dropped.map((d: { why: string }) => d.why))}`); };
  const drop = (label: string, e: ReturnType<typeof ev>) => { const r = PR.filterTapEvidence([e], []); assert.equal(r.kept.length, 0, `${label} must be DROPPED`); assert.match(r.dropped[0].why, /code-reference|option/); };

  // MUST-EXCLUDE (real taps still detected) — look-alikes of the three real label-only jobs.
  keep("label after another label's CODE REF", ev("LINE SIDE TAP", at120("SHUTDOWN SWITCH CODE REF: NEC 690.13 (B) PRODUCTION METER LABEL LOCATION: MAIN SERVICE PANEL SOLAR CONNECTION ", "LINE SIDE TAP", " PHOTOVOLTAIC DC DISCONNECT WARNING: PHOTOVOLTAIC POWER SOURCE CODE REF: NEC 690.31(D)(2)")));
  keep("label after a PER CODE(S): NEC cite", ev("LINE SIDE TAP", at120("PER CODE(S): NEC 690.54 PV SYSTEM DISCONNECT LABEL LOCATION: MAIN SERVICE PANEL SOLAR CONNECTION ", "LINE SIDE TAP", " PHOTOVOLTAIC DC DISCONNECT WARNING: PHOTOVOLTAIC POWER SOURCE 100 EXAMPLE RD")));
  keep("label followed by a page break and a labelling note", ev("LINE SIDE TAP", at120("P H O T O V O L T A I C LABEL LOCATION: MAIN SERVICE DISCONNECT SOLAR CONNECTION ", "LINE SIDE TAP", " --- PAGE 9 --- LABELING NOTES: AFFIXED [NEC 690.56(C)(1)(A)]. 5. LABELS TO BE A MINIMUM LETTER HEIGHT")));
  keep("new supply-side tap on the SLD, with its own cite", ev("SUPPLY SIDE TAP", at120("UTILITY METER (E) MAIN SERVICE PANEL 200A ", "SUPPLY SIDE TAP", " PER NEC 705.11(A) (N) SERVICE ENTRANCE CONDUCTORS"), "sld", 6));
  keep("(N) marks new work even in method form", ev("SUPPLY SIDE TAP", at120("LINE SIDE INTERCONNECTION AT MAIN SERVICE PANEL. (N) ", "SUPPLY SIDE TAP", " INTERCONNECTION PER NEC 705.11 WITH INSULATION PIERCING CONNECTORS"), "sld", 6));
  keep("an option word in the NEIGHBOURING label does not reach the tap", ev("LINE SIDE TAP", at120("LABEL LOCATION: SUB PANEL (OPTIONAL) CODE REF: NEC 705.12 LABEL LOCATION: MAIN SERVICE PANEL SOLAR CONNECTION ", "LINE SIDE TAP", " WARNING: DUAL POWER SOURCE")));
  // scrambled title-block text runs on with no break; a stray option word 200 chars on is not the tap's
  keep("a stray word far along break-free title-block soup", ev("LINE SIDE TAP", at120("ROOF MOUNT SYSTEM BE ELECTRICAL PHOTOVOLTAIC SAMPLE POWER SAMPLE CITY ", "LINE SIDE TAP", " (18) SAMPLE Q.MI-349 (240V) (L/W/H) 67.8/44.6/1.57 (18) SAMPLE BLK 430W 6.282 KW AC 7.740 KW DC SYSTEM OTHER ARE WITHIN THE 18 MODULES ROOF MOUNTED SHOWN ALTERNATIVE LAYOUT"), "cover", 1));
  // the snippet's FIRST tap word is a numbered note; this evidence is the label after it
  keep("the evidence's own tap, not the first tap word in the snippet", ev("LINE SIDE TAP", at120("6. SUPPLY SIDE TAP INTERCONNECTION ACCORDING TO NEC 705.11. LABEL LOCATION: MAIN SERVICE PANEL SOLAR CONNECTION ", "LINE SIDE TAP", " PHOTOVOLTAIC AC DISCONNECT")));

  // MUST-PASS (notes still never set scope) — the MA1 numbered-note shapes and their kin.
  drop("numbered method note with its cite", ev("FEEDER TAP", at120("THE COMBINED OVERCURRENT DEVICE MAY BE EXCLUDED ACCORDING TO NEC 705.12 (B)(3)(3). 5. ", "FEEDER TAP", " INTERCONNECTION (LOADSIDE) ACCORDING TO NEC 705.12 (B)(1) 6. SUPPLY SIDE TAP INTERCONNECTION ACCORDING TO NEC 705.11"), "notes", 3));
  drop("hierarchical number glued to the word", ev("SUPPLY SIDE TAP", at120("EXEMPT FROM ADDITIONAL ENTRANCE CONDUCTORS IN ACCORDANCE WITH NEC 230.42 2.7.8BACKFEEDING ", "SUPPLY SIDE TAP", " INTERCONNECTION ACCORDING TO NEC 705.11 WITH SERVICE ENTRANCE CONDUCTORS"), "notes", 3));
  drop("numbered note citing the code (no INTERCONNECTION word)", ev("SUPPLY SIDE TAP", at120("ALL WORK SHALL BE PERFORMED BY A LICENSED ELECTRICIAN. 3. ", "SUPPLY SIDE TAP", " SHALL COMPLY WITH NEC 705.11 AND 230.46"), "notes", 3));
  drop("unnumbered method form with its cite", ev("SUPPLY SIDE TAP", at120("GENERAL ELECTRICAL NOTES: ", "SUPPLY SIDE TAP", " INTERCONNECTION ACCORDING TO NEC 705.11 WITH SERVICE ENTRANCE CONDUCTORS"), "notes", 3));
  drop("option in the tap's own sentence", ev("SUPPLY SIDE TAP", at120("THE PV SYSTEM SHALL CONNECT THROUGH A BACKFED BREAKER. ALTERNATIVELY A ", "SUPPLY SIDE TAP", " MAY BE USED WHERE THE BUS CANNOT ACCEPT THE BREAKER."), "notes", 3));
  // the snippet carries a real label later on, but THIS evidence is the numbered note
  drop("the evidence's own tap is the note even with a label later in the snippet", ev("FEEDER TAP", at120("MAY BE EXCLUDED ACCORDING TO NEC 705.12 (B)(3)(3). 5. ", "FEEDER TAP", " INTERCONNECTION (LOADSIDE) ACCORDING TO NEC 705.12 (B)(1). LABEL LOCATION: MAIN SERVICE PANEL SOLAR CONNECTION LINE SIDE TAP"), "notes", 3));
  ok("tap close: a cite or option word counts only inside the tap's own sentence / numbered note / label; label-only real taps kept, numbered method notes dropped");
}

// ---------------------------------------------------------------------------
// 3 (close). Two-family houses are common in MA: "TWO FAMILY" / "2-FAMILY" with no dwelling
// noun after it is still two units, and R-3 (one- AND two-family; also a "REV R3" tag) is
// never a single-family basis.
// ---------------------------------------------------------------------------
{
  for (const t of ["SAMPLE RESIDENCE TWO FAMILY", "SAMPLE RESIDENCE 2-FAMILY", "SAMPLE RESIDENCE 2 FAMILY  100 EXAMPLE RD", "SAMPLE RESIDENCE THREE-FAMILY"]) {
    assert.equal(PR.singleFamilyBasis(t), null, `${t} is not single-family`);
    const r = PR.resolveReviewItems({ attached: ["plan_set"], planText: t, passes: [textPass({ dwellingUnits: field(1, "plan_set", "RESIDENCE", 0.5) }, ["dwellingUnits"])] });
    assert.ok(!r.resolved.some((x: { field: string }) => x.field === "dwellingUnits"), `dwellingUnits must not resolve to 1 on "${t}"`);
  }
  assert.equal(PR.singleFamilyBasis("PV 0.0 COVER  OCCUPANCY: R-3  CONSTRUCTION TYPE V-B"), null, "R-3 alone is one- or two-family: no basis");
  assert.equal(PR.singleFamilyBasis("PV 0.0 COVER  REV R3  100 EXAMPLE RD"), null, "a revision tag is not an occupancy");
  // MUST-PASS: an explicit single-family statement still resolves, R-3 beside it or not
  assert.equal(PR.singleFamilyBasis("OCCUPANCY: R-3 SINGLE FAMILY"), "SINGLE FAMILY");
  assert.equal(PR.singleFamilyBasis("JANE SAMPLE RESIDENCE  REV R3"), "RESIDENCE");
  ok("duplex close: TWO FAMILY / 2-FAMILY alone blocks single-family; R-3 is not a basis");
}

// ---------------------------------------------------------------------------
// 4 (close). Owner tie-break: a shared surname is not the same person.
// ---------------------------------------------------------------------------
{
  assert.equal(PR.namesMatch("PAT SAMPLE", "JANE SAMPLE"), false, "surname-only is not a match");
  assert.equal(PR.namesMatch("JANE A SAMPLE", "Jane Sample Residence"), true, "given name + surname, middle initial ignored");
  assert.equal(PR.namesMatch("SAMPLE, JANE", "JANE SAMPLE"), true);
  // MUST-EXCLUDE: bill PAT SAMPLE, plan + letter JANE SAMPLE (a spouse) → CONFLICT naming both, nothing resolved
  const spouse = PR.resolveReviewItems({ attached: ["plan_set", "utility_bill", "structural_letter"], planText: planTextSF, passes: [
    visionPass({ owner: field("PAT SAMPLE", "utility_bill", "Service Provided To: PAT SAMPLE", 0.97) }),
    textPass({ owner: field("Jane Sample", "plan_set", "JANE SAMPLE RESIDENCE", 0.6, "PV 0.0") }, ["owner"], { conflicts: [{ field: "owner", readings: [{ value: "JANE SAMPLE", source: "plan_set", sheet: "PV 0.0" }, { value: "Jane Sample Residence", source: "structural_letter", sheet: "p.1" }] }] }),
  ] });
  assert.ok(!spouse.resolved.some((x: { field: string }) => x.field === "owner"), "owner must not resolve on a surname-only match");
  const sc = spouse.conflicts.find((x: { field: string }) => x.field === "owner");
  assert.ok(sc && /PAT SAMPLE/.test(sc.text) && /Jane Sample/i.test(sc.text), "the conflict names the bill holder and the document name");
  assert.match(sc.text, /shares only a surname/);
  assert.doesNotMatch(sc.text, /gives a surname only/);
  // a title block that prints a surname only ("SAMPLE RESIDENCE") names no different person:
  // still a CONFLICT (no given-name match), but the words must not invent a spouse
  const bareTitle = PR.resolveReviewItems({ attached: ["plan_set", "utility_bill"], planText: planTextSF, passes: [
    visionPass({ owner: field("JANE SAMPLE", "utility_bill", "Service Provided To: JANE SAMPLE", 0.97) }),
    textPass({ owner: field("SAMPLE RESIDENCE", "plan_set", "SAMPLE RESIDENCE", 0.5, "PV 0.0") }, ["owner"]),
  ] });
  const bt = bareTitle.conflicts.find((x: { field: string }) => x.field === "owner");
  assert.ok(bt && !bareTitle.resolved.some((x: { field: string }) => x.field === "owner"));
  assert.match(bt.text, /gives a surname only \("SAMPLE RESIDENCE"\)/);
  assert.doesNotMatch(bt.text, /spouse|different given name|matches/, bt.text);
  assert.doesNotMatch(JSON.stringify(spouse), /matches the plan set/, "never claims a match that does not exist");
  // MUST-PASS: the same person with a middle initial on the bill still resolves to the bill holder
  const same = PR.resolveReviewItems({ attached: ["plan_set", "utility_bill"], planText: planTextSF, passes: [
    visionPass({ owner: field("JANE A SAMPLE", "utility_bill", "Service Provided To: JANE A SAMPLE", 0.97) }),
    textPass({ owner: field("Jane Sample", "plan_set", "JANE SAMPLE RESIDENCE", 0.6, "PV 0.0") }, ["owner"]),
  ] });
  const so = same.resolved.find((x: { field: string }) => x.field === "owner");
  assert.ok(so && so.value === "JANE A SAMPLE" && /matches the plan set/.test(so.how));
  ok("owner close: a surname-only match is a CONFLICT naming both; given name + surname still resolves");
}

// ---------------------------------------------------------------------------
// 4b (close 3). A compound surname counts ONCE: "DE LA CRUZ" is one surname, not three
// shared tokens, so two people who share it are a spouse/relative pair, never a match.
// ---------------------------------------------------------------------------
{
  // MUST-PASS: the same person written four ways still matches "JANE SAMPLE" (both directions)
  for (const n of ["SAMPLE, JANE A", "SAMPLE JANE", "JANE SAMPLE-DOE", "JANE A SAMPLE"]) {
    assert.equal(PR.namesMatch(n, "JANE SAMPLE"), true, `${n} is JANE SAMPLE`);
    assert.equal(PR.namesMatch("JANE SAMPLE", n), true, `JANE SAMPLE is ${n}`);
  }
  assert.equal(PR.namesMatch("DE LA CRUZ, MARIA", "MARIA DE LA CRUZ RESIDENCE"), true, "a compound surname with the same given name still matches");
  // MUST-EXCLUDE: a shared surname block (however many tokens) with a different given name
  for (const [a, b] of [["MARIA DE LA CRUZ", "JOSE DE LA CRUZ"], ["MARIA GARCIA LOPEZ", "JOSE GARCIA LOPEZ"], ["ANNA VAN DER BERG", "PIET VAN DER BERG"], ["SMITH FAMILY TRUST", "JONES FAMILY TRUST"], ["JOSE DE LA CRUZ GARCIA", "MARIA DE LA CRUZ"], ["MARIA DE LA CRUZ", "DE LA CRUZ RESIDENCE"], ["ANNA VAN DER BERG", "PIET VAN DEN BERG"], ["JOSE GARCIA LOPEZ MARTINEZ", "MARIA GARCIA LOPEZ"]]) {
    assert.equal(PR.namesMatch(a, b), false, `${a} is not ${b}`);
    assert.equal(PR.namesMatch(b, a), false, `${b} is not ${a}`);
  }
  const owner = (bill: string, plan: string) => PR.resolveReviewItems({ attached: ["plan_set", "utility_bill"], planText: planTextSF, passes: [
    visionPass({ owner: field(bill, "utility_bill", `Service Provided To: ${bill}`, 0.97) }),
    textPass({ owner: field(plan, "plan_set", `${plan} RESIDENCE`, 0.6, "PV 0.0") }, ["owner"]),
  ] });
  // MUST-EXCLUDE through the page's resolver: the spouse is a CONFLICT naming both, never RESOLVED
  const cruz = owner("MARIA DE LA CRUZ", "JOSE DE LA CRUZ");
  assert.ok(!cruz.resolved.some((x: { field: string }) => x.field === "owner"), "a compound-surname spouse must not resolve to the bill holder");
  assert.doesNotMatch(JSON.stringify(cruz), /matches the plan set/);
  const cc = cruz.conflicts.find((x: { field: string }) => x.field === "owner");
  assert.ok(cc && /MARIA DE LA CRUZ/.test(cc.text) && /JOSE DE LA CRUZ/.test(cc.text), "the conflict names both people");
  assert.match(cc.text, /shares only a surname/);
  // an initial-only bill name is not "a different given name" — the given name is just not confirmed
  const init = owner("J SAMPLE", "JANE SAMPLE");
  const ic = init.conflicts.find((x: { field: string }) => x.field === "owner");
  assert.ok(ic && !init.resolved.some((x: { field: string }) => x.field === "owner"));
  assert.match(ic.text, /initial or surname only \("J SAMPLE"\).*not confirmed/);
  assert.doesNotMatch(ic.text, /different given name|spouse/);
  // a family trust on the plan names a surname, not a person called FAMILY: no spouse invented
  const trust = owner("JANE SMITH", "SMITH FAMILY TRUST");
  const tc = trust.conflicts.find((x: { field: string }) => x.field === "owner");
  assert.ok(tc && !trust.resolved.some((x: { field: string }) => x.field === "owner"));
  assert.match(tc.text, /gives a surname only/);
  assert.doesNotMatch(tc.text, /spouse|different given name/);
  // MUST-PASS through the resolver: a joint bill naming the plan-set owner resolves to the bill
  const joint = owner("JOHN & JANE SAMPLE", "JANE SAMPLE");
  const jr = joint.resolved.find((x: { field: string }) => x.field === "owner");
  assert.ok(jr && jr.value === "JOHN & JANE SAMPLE" && /matches the plan set/.test(jr.how), "a joint account holder that names the owner still resolves");
  ok("owner close 3: a compound surname counts once — spouse pairs are CONFLICTs; reversed / comma / hyphenated / middle-initial forms still match");
}

// ---------------------------------------------------------------------------
// 5 (close 3). Sealed-source rule: the letter governs the plan set only for the SAME quantity.
// A zone- or exposure-qualified letter reading ("Zone 2n ... 24 in O.C.") is not the whole-roof
// spacing the plan states — a CONFLICT naming both, never "letter 24 over 48".
// ---------------------------------------------------------------------------
{
  const planSpacing = { value: 48, source: "plan_set", sheet: "PV 1.1", excerpt: `NEW PV ATTACHMENTS AT 4'-0" O.C.` };
  const zoneLetter = { value: 24, source: "structural_letter", sheet: "p.3", excerpt: "Zone 2n ... Attachments at 24 in O.C. with 2 rails" };
  const run = (conflicts: unknown[], fields: Record<string, unknown> = {}, low: string[] = []) => PR.resolveReviewItems({ attached: ["plan_set", "structural_letter"], planText: planTextSF, passes: [textPass(fields, low, { conflicts })] });
  // MUST-EXCLUDE (model-reported conflict): plan 48 unqualified vs letter 24 in Zone 2n
  const a = run([{ field: "attachmentSpacingIn", readings: [planSpacing, zoneLetter], note: "the letter limits exposed zones to 24 in" }]);
  assert.ok(!a.resolved.some((x: { field: string }) => x.field === "attachmentSpacingIn"), "a zone-specific letter value must not replace the plan's general spacing");
  const ac = a.conflicts.find((x: { field: string }) => x.field === "attachmentSpacingIn");
  assert.ok(ac && /48/.test(ac.text) && /24/.test(ac.text) && /ZONE 2N/.test(ac.note) && /not the same quantity/.test(ac.note), "the conflict names both readings and the zone");
  // MUST-EXCLUDE (flagged field, readings from two passes): an EXPOSED-module letter value
  const b = PR.resolveReviewItems({ attached: ["plan_set", "structural_letter"], planText: planTextSF, passes: [
    { kind: "text", label: "plan", docsGiven: ["plan_set"], response: { fields: { attachmentSpacingIn: field(48, "plan_set", `NEW PV ATTACHMENTS AT 4'-0" O.C.`, 0.6) }, lowConfidenceFields: ["attachmentSpacingIn"], notes: "" } },
    { kind: "text", label: "letter", docsGiven: ["structural_letter"], response: { fields: { attachmentSpacingIn: field(24, "structural_letter", "Exposed modules: Attachments at 24 in O.C.", 0.6) }, lowConfidenceFields: [], notes: "" } },
  ] });
  assert.ok(!b.resolved.some((x: { field: string }) => x.field === "attachmentSpacingIn") && b.conflicts.some((x: { field: string }) => x.field === "attachmentSpacingIn" && /EXPOSED/.test(x.note)), "flagged path: an exposed-module letter value is a conflict too");
  // ground snow vs roof snow are different quantities
  const s = run([{ field: "snow", readings: [{ value: 30, source: "plan_set", excerpt: "GROUND SNOW LOAD 30 PSF" }, { value: 21, source: "structural_letter", excerpt: "Roof Snow Load 21 psf" }] }]);
  assert.ok(!s.resolved.some((x: { field: string }) => x.field === "snow") && s.conflicts.some((x: { field: string }) => x.field === "snow"), "roof snow never replaces ground snow");
  // every roof-area qualifier makes a zone-specific reading (one assert per word, so none is decorative)
  for (const q of ["Edge zone", "Ridge", "Corner", "Eave", "Hip", "Rake", "Perimeter", "Interior", "Non-exposed modules", "Zone 3r"]) {
    const r = run([{ field: "attachmentSpacingIn", readings: [planSpacing, { value: 40, source: "structural_letter", excerpt: `${q} attachments at 40 in O.C.` }] }]);
    assert.ok(!r.resolved.some((x: { field: string }) => x.field === "attachmentSpacingIn") && r.conflicts.some((x: { field: string }) => x.field === "attachmentSpacingIn"), `"${q}" qualifies the letter reading`);
  }
  const ne = run([{ field: "attachmentSpacingIn", readings: [{ value: 48, source: "plan_set", excerpt: "NON-EXPOSED MODULES: ATTACHMENTS @ 48\" O.C." }, { value: 24, source: "structural_letter", excerpt: "Exposed modules: attachments at 24 in O.C." }] }]);
  assert.ok(!ne.resolved.some((x: { field: string }) => x.field === "attachmentSpacingIn"), "non-exposed and exposed are different quantities");
  // ultimate vs ASD / unqualified wind speed are different quantities; Vult and ULTIMATE are the same one
  const wind = (plan: string, letter: string) => run([{ field: "windSpeed", readings: [{ value: 110, source: "plan_set", excerpt: plan }, { value: 115, source: "structural_letter", excerpt: letter }] }]);
  for (const [p, l] of [["WIND SPEED = 110 MPH", "Vult = 115 mph"], ["ASD WIND SPEED 110 MPH", "Ultimate wind speed 115 mph"], ["NOMINAL WIND SPEED 110", "Wind speed 115 mph"], ["WIND SPEED 110 MPH", "V ult 115 mph"]]) {
    const w = wind(p, l);
    assert.ok(!w.resolved.some((x: { field: string }) => x.field === "windSpeed") && w.conflicts.some((x: { field: string }) => x.field === "windSpeed"), `${p} vs ${l} is a conflict`);
  }
  assert.ok(wind("ULTIMATE WIND SPEED 110 MPH", "Vult = 115 mph").resolved.some((x: { field: string; value: number }) => x.field === "windSpeed" && x.value === 115), "Vult and ULTIMATE are the same quantity");
  assert.ok(wind("ASD WIND SPEED 110 MPH", "Vasd = 115 mph").resolved.some((x: { field: string; value: number }) => x.field === "windSpeed" && x.value === 115), "Vasd and ASD are the same quantity");
  // MUST-PASS: the same quantity still goes to the sealed letter — unqualified over unqualified,
  // the same zone on both sides, and the dead-load pair (asserted in section 3) keeps resolving
  const u = run([{ field: "attachmentSpacingIn", readings: [planSpacing, { value: 32, source: "structural_letter", sheet: "p.3", excerpt: "Attachments at 32 in O.C. with 2 rails" }] }]);
  const ur = u.resolved.find((x: { field: string }) => x.field === "attachmentSpacingIn");
  assert.ok(ur && ur.value === 32 && /sealed-source rule/.test(ur.how), "an unqualified letter spacing still governs the plan's");
  const z = run([{ field: "attachmentSpacingIn", readings: [{ value: 32, source: "plan_set", excerpt: "ZONE 2N ATTACHMENTS @ 32\" O.C." }, zoneLetter] }]);
  assert.ok(z.resolved.some((x: { field: string }) => x.field === "attachmentSpacingIn" && x.value === 24), "the same zone on both sides is the same quantity");
  const d = run([{ field: "deadLoad", readings: [{ value: 3, source: "structural_letter", sheet: "p.2", excerpt: "Dead Load 3.00 psf" }, { value: 2.58, source: "plan_set", sheet: "PV 1.1", excerpt: "Distributed Load (Total System Weight / Total Array Area) 2.58 Per SqFt" }] }]);
  assert.ok(d.resolved.some((x: { field: string }) => x.field === "deadLoad" && x.value === 3), "letter dead load 3.00 still governs the plan's 2.58");
  ok("sealed-source close 3: a zone/exposure-qualified letter reading is a CONFLICT, never a resolution; the same quantity still goes to the letter");
}

// ---------------------------------------------------------------------------
// 6 (close 3). A resolution's basis quotes what the document says. "One building" was resolved
// with "no array is drawn on an outbuilding" on a plan set whose array sat on a detached
// structure with a trench back to the house; its text never said "ARRAY ON GARAGE". When the
// plan names another structure or trench scope, the count is an inference: UNSURE, with the
// evidence and the read's own basis stated.
// ---------------------------------------------------------------------------
{
  const inferred = { uncertainties: [{ field: "numberOfBuildings", kind: "inferred", reason: "array assumed on the main house only" }] };
  const outPlan = `PV 0.0 COVER  JANE SAMPLE RESIDENCE  100 EXAMPLE RD
PV 1.0 SITE PLAN  DRIVEWAY  MAIN HOUSE  GARAGE  SHED  PROPERTY LINE
PV 1.1  (N) AC DISCONNECT  ~100 FT TRENCH TO BE 24" DEEP  1" PVC CONDUIT
UTILITY SERVICE: UNDERGROUND`;
  const nb = PR.resolveReviewItems({ attached: ["plan_set"], planText: outPlan, passes: [textPass({
    numberOfBuildings: field(1, "plan_set", "MAIN HOUSE ... GARAGE ... SHED", 0.55, "PV 1.0"),
    dwellingUnits: field(1, "plan_set", "JANE SAMPLE RESIDENCE", 0.55, "PV 0.0"),
  }, ["numberOfBuildings", "dwellingUnits"], inferred)] });
  // MUST-EXCLUDE: no resolution, and never the claim that no array is on an outbuilding
  assert.ok(!nb.resolved.some((x: { field: string }) => x.field === "numberOfBuildings"), "numberOfBuildings must not resolve when the plan names another structure and a trench");
  assert.doesNotMatch(JSON.stringify(nb), /no array is drawn|names no other structure/);
  const nu = nb.unsure.find((x: { field: string }) => x.field === "numberOfBuildings");
  assert.ok(nu && nu.value === 1, "numberOfBuildings is UNSURE with the read's value");
  assert.match(nu.why, /GARAGE/); assert.match(nu.why, /SHED/); assert.match(nu.why, /trench scope TRENCH/);
  assert.match(nu.why, /array assumed on the main house only/, "the model's inference is stated as the basis, not upgraded to a fact");
  assert.doesNotMatch(nu.why, /UNDERGROUND/, "the utility service drop is not trench scope");
  // a trench alone (no structure word) is enough to leave it open
  const tr = PR.resolveReviewItems({ attached: ["plan_set"], planText: "JANE SAMPLE RESIDENCE  PV CONDUIT IN TRENCH 18\" DEEP", passes: [textPass({ numberOfBuildings: field(1, "plan_set", "RESIDENCE", 0.5) }, ["numberOfBuildings"])] });
  assert.ok(tr.unsure.some((x: { field: string }) => x.field === "numberOfBuildings"));
  // a detached garage does not change the unit count: dwellingUnits still resolves, quoting the text
  const du = nb.resolved.find((x: { field: string }) => x.field === "dwellingUnits");
  assert.ok(du && du.value === 1 && /the plan set reads "RESIDENCE"/.test(du.how), "dwellingUnits resolves on the RESIDENCE the text shows");
  // MUST-PASS: no other structure, no trench, "UTILITY SERVICE: UNDERGROUND" only → resolves,
  // and the basis says what was checked (never "title block", which the match cannot know)
  const one = PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF + "\nUTILITY SERVICE: UNDERGROUND", passes: [textPass({ numberOfBuildings: field(1, "plan_set", "MAIN HOUSE", 0.55) }, ["numberOfBuildings"], inferred)] });
  const or = one.resolved.find((x: { field: string }) => x.field === "numberOfBuildings");
  assert.ok(or && or.value === 1 && /the plan set reads "RESIDENCE"/.test(or.how) && /names no other structure/.test(or.how), "one building still resolves when the text names nothing else");
  assert.doesNotMatch(JSON.stringify(one), /title block reads/);
  ok("buildings close 3: another structure or trench scope leaves numberOfBuildings UNSURE with the evidence; the basis quotes the text");
}

// ---------------------------------------------------------------------------
// A CALCULATED LIMIT IS NOT A CONFLICT PEER (dry-run 2026-09-28 B15). Every plan set printing the
// 705.12 check raised "PV breaker 30 A vs 40 A": 40 A is the maximum worked out in a formula, the
// SLD states 30 A. Both conflict paths: (a) the model reports it, (d) passes disagree.
// ---------------------------------------------------------------------------
{
  const calc40 = { value: "40A", source: "plan_set", excerpt: "705.12: (200A x 120%) - 200A = 40A max PV OCPD", sheet: "E 1.1" };
  const stated30 = { value: "30A", source: "plan_set", excerpt: "(N) 30A PV BREAKER INSTALLED", sheet: "E 1.1" };
  const got = (items: { resolved: Array<{ field: string; value: unknown; how: string }>; conflicts: Array<{ field: string }> }) =>
    ({ r: items.resolved.find((x) => x.field === "pvBreaker"), c: items.conflicts.some((x) => x.field === "pvBreaker") });
  // (a) a model-reported conflict
  const a = got(PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [textPass({}, [], { conflicts: [{ field: "pvBreaker", readings: [stated30, calc40] }] })] }));
  assert.ok(a.r && a.r.value === "30A" && !a.c, `(a) resolves to the stated 30A: ${JSON.stringify(a)}`);
  assert.match(a.r!.how, /40A is a calculated limit, not a reading/);
  // (d) two passes that disagree
  const pass = (label: string, r: typeof stated30) => ({ kind: "text", label, docsGiven: ["plan_set"], response: { fields: { pvBreaker: field(r.value, r.source, r.excerpt, 0.7, r.sheet) }, lowConfidenceFields: ["pvBreaker"], notes: "" } });
  const d = got(PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [pass("one", stated30), pass("two", calc40)] }));
  assert.ok(d.r && d.r.value === "30A" && !d.c, `(d) resolves to the stated 30A: ${JSON.stringify(d)}`);
  // MUST-EXCLUDE: every reading a calculation — the conflict stays
  const calc50 = { ...calc40, value: "50A", excerpt: "(250A x 120%) - 250A = 50A max PV OCPD" };
  assert.ok(got(PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [textPass({}, [], { conflicts: [{ field: "pvBreaker", readings: [calc50, calc40] }] })] })).c, "all calculations: still a conflict");
  // MUST-EXCLUDE: an uncited reading is never dropped against a calculation
  assert.ok(got(PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [textPass({}, [], { conflicts: [{ field: "pvBreaker", readings: [{ value: "30A", source: "plan_set" }, calc40] }] })] })).c, "uncited reading: still a conflict");
  // MUST-EXCLUDE: a read that doubts the plain reading keeps it the reviewer's question
  const guessed = PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [pass("one", stated30), { ...pass("two", calc40), response: { ...pass("two", calc40).response, uncertainties: [{ field: "pvBreaker", kind: "guessed", reason: "tag unreadable" }] } }] });
  assert.ok(!guessed.resolved.some((x: { field: string }) => x.field === "pvBreaker"), "a guessed read is not resolved by dropping the calculation");
  // MUST-EXCLUDE: a labelled value with "=", a lumber size and a bare limit are READINGS, not calculations
  const spacing = PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [textPass({}, [], { conflicts: [{ field: "roofRafterSpacing", readings: [
    { value: 24, source: "plan_set", excerpt: "2 X 6 RAFTERS @ 24\" O.C." }, { value: 16, source: "plan_set", excerpt: "RAFTER SPACING = 16 IN" }] }] })] });
  assert.ok(spacing.conflicts.some((x: { field: string }) => x.field === "roofRafterSpacing"), "lumber size / labelled value: still a conflict");
  const height = PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [textPass({}, [], { conflicts: [{ field: "moduleHeightAboveRoof", readings: [
    { value: 12, source: "plan_set", excerpt: "NOT HIGHER THAN 12\" ABOVE ROOF" }, { value: 6, source: "plan_set", excerpt: "6\" MAX" }] }] })] });
  assert.ok(height.conflicts.some((x: { field: string }) => x.field === "moduleHeightAboveRoof"), "a bare limit is a reading: the height conflict stays");
  ok("calculated limit: the 705.12 maximum never makes a PV-breaker conflict (both paths); all-calculation, uncited, guessed, labelled '=', lumber size and bare MAX stay conflicts");
}

// ---------------------------------------------------------------------------
// ONLY A LIMIT-LABELLED RESULT IS SET ASIDE (skeptic round, dry-run 2026-09-28 B15). The first cut
// dropped ANY excerpt carrying '=' and arithmetic while another reading quoted a plain line, so a
// plan set's own worked sizing disagreeing with another sheet vanished from CONFLICTS and showed
// under RESOLVED as "X is a calculated limit, not a reading" — false. A reading is set aside only
// when its calculation labels the RESULT as a limit (MAX / MAXIMUM / ALLOW / ALLOWABLE / LIMIT) and
// the reading's value IS that result. Every MUST-EXCLUDE runs on both conflict paths: (a) the model
// reports the conflict, (d) two passes disagree on a flagged field.
// ---------------------------------------------------------------------------
{
  type R = { value: string; source: string; excerpt: string };
  type Items = { resolved: Array<{ field: string; value: unknown; how: string }>; conflicts: Array<{ field: string; text: string }> };
  const viaA = (f: string, x: R, y: R): Items => PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [textPass({}, [], { conflicts: [{ field: f, readings: [x, y] }] })] });
  const passOf = (f: string, label: string, r: R) => ({ kind: "text", label, docsGiven: ["plan_set"], response: { fields: { [f]: field(r.value, r.source, r.excerpt, 0.7, "E 1.1") }, lowConfidenceFields: [f], notes: "" } });
  const viaD = (f: string, x: R, y: R): Items => PR.resolveReviewItems({ attached: ["plan_set"], planText: planTextSF, passes: [passOf(f, "one", x), passOf(f, "two", y)] });
  const fails: string[] = [];
  const staysConflict = (name: string, f: string, x: R, y: R) => {
    for (const [p, run] of [["a", viaA], ["d", viaD]] as const) {
      const items = run(f, x, y);
      const conflict = items.conflicts.find((c) => c.field === f);
      const resolved = items.resolved.find((r) => r.field === f);
      if (!conflict || resolved) fails.push(`${name} (${p}): conflict=${Boolean(conflict)} resolved=${resolved ? JSON.stringify(resolved) : "no"}`);
      else if (/calculated limit, not a reading/.test(conflict.text)) fails.push(`${name} (${p}): the conflict text calls a reading a calculated limit: ${conflict.text}`);
    }
  };
  const resolvesTo = (name: string, f: string, x: R, y: R, want: string) => {
    for (const [p, run] of [["a", viaA], ["d", viaD]] as const) {
      const items = run(f, x, y);
      const resolved = items.resolved.find((r) => r.field === f);
      if (!resolved || resolved.value !== want || items.conflicts.some((c) => c.field === f)) fails.push(`${name} (${p}): expected RESOLVED ${want}, got ${JSON.stringify({ resolved, conflicts: items.conflicts.map((c) => c.field) })}`);
      else if (!/is a calculated limit, not a reading/.test(resolved.how)) fails.push(`${name} (${p}): the resolution does not name the dropped limit: ${resolved.how}`);
    }
  };
  const sd = (value: string, excerpt: string): R => ({ value, source: "plan_set", excerpt });

  // MUST-EXCLUDE (skeptic): a worked system size is a READING — its disagreement is a conflict.
  staysConflict("system size worked out vs stated", "systemSizeDcKw", sd("8.80", "DC SYSTEM SIZE: 20 x 440W = 8.80 KW DC"), sd("8.4", "SYSTEM SIZE: 8.4 KW DC"));
  // MUST-EXCLUDE (skeptic): a sized breaker ('USE 40A') is a reading, the 36.25 A is not labelled a limit.
  staysConflict("sized PV breaker vs stated", "pvBreaker", sd("40A", "1.25 x 29A = 36.25A, USE 40A PV BREAKER"), sd("30A", "(N) 30A PV BREAKER"));
  // MUST-EXCLUDE: the value must BE the limit-labelled result — a line that prints the 40 A maximum
  // and states a 30 A breaker is read as 30 A, and disagrees with a plain 40 A.
  staysConflict("value is not the limit result", "pvBreaker", sd("30A", "(200A x 120%) - 200A = 40A MAX PV OCPD; 30A PV BREAKER INSTALLED"), sd("40A", "(N) 40A PV BREAKER"));
  // MUST-EXCLUDE: a line that also STATES the number is a statement, not only a calculated limit.
  staysConflict("number also stated on the line", "pvBreaker", sd("40A", "(N) 40A PV BREAKER; (200A x 120%) - 200A = 40A MAX PV OCPD"), sd("30A", "(N) 30A PV BREAKER"));
  // MUST-PASS (skeptic): the 705.12 maximum labelled after its result is still set aside.
  resolvesTo("705.12 max after the result", "pvBreaker", sd("40A", "(200A x 120%) - 200A = 40A max PV OCPD"), sd("30A", "(N) 30A PV BREAKER"), "30A");
  // MUST-PASS: the same limit labelled before the calculation ("MAX PV OCPD ... = 40A").
  resolvesTo("705.12 max before the calculation", "pvBreaker", sd("40A", "MAX PV OCPD (200A x 120%) - 200A = 40A"), sd("30A", "(N) 30A PV BREAKER"), "30A");
  resolvesTo("allowable backfeed label", "pvBreaker", sd("40", "ALLOWABLE BACKFEED: 200A x 1.2 - 200A = 40 A"), sd("30A", "(N) 30A PV BREAKER"), "30A");
  assert.deepEqual(fails, [], fails.join("\n"));
  ok("calculated limit (skeptic round): worked sizing ('20 x 440W = 8.80 KW', '1.25 x 29A = 36.25A, USE 40A') stays a CONFLICT on both paths; only a limit-labelled result equal to the value is set aside");
}

// ---------------------------------------------------------------------------
// JOINT ACCOUNT (operator ruling 2026-09-28): the bill's name block lists two holders, the
// reading's value only the first. A plan-set owner who is one of the LISTED holders is on the
// account — resolved to the plan set's owner, never a "shares only a surname" conflict; one who is
// not listed stays the conflict it always was.
// ---------------------------------------------------------------------------
{
  const joint = (planOwner: string, block: string) => PR.resolveReviewItems({ attached: ["plan_set", "utility_bill"], planText: planTextSF, passes: [
    visionPass({ owner: field("Robin L Sample", "utility_bill", `"${block}"`, 0.95) }),
    textPass({ owner: field(planOwner, "plan_set", `${planOwner.toUpperCase()} RESIDENCE`, 0.85, "PV 0.0") }, ["owner"]),
  ] });
  const listed = joint("Durwood Sample", "Robin L Sample / Durwood W Sample");
  const lr = listed.resolved.find((x: { field: string }) => x.field === "owner");
  assert.ok(lr && lr.value === "Durwood Sample" && /joint account/.test(lr.how), `listed owner resolved: ${JSON.stringify(listed.resolved)}`);
  assert.ok(!listed.conflicts.some((x: { field: string }) => x.field === "owner"), "no owner conflict for a listed holder");
  // MUST-EXCLUDE: the plan-set owner is not among the listed holders -> still a conflict.
  const notListed = joint("Casey Sample", "Robin L Sample / Durwood W Sample");
  assert.ok(!notListed.resolved.some((x: { field: string }) => x.field === "owner"), "an unlisted owner never resolves");
  assert.ok(notListed.conflicts.some((x: { field: string }) => x.field === "owner"), "an unlisted owner stays a conflict");
  // MUST-EXCLUDE: an excerpt that is a sentence, not a name list, is never read as holders.
  assert.equal(PR.billHolderBlock({ value: "Robin L Sample", excerpt: "Customer: Robin L Sample account 12 / Durwood W Sample" }), "Robin L Sample");
  assert.equal(PR.billHolderBlock({ value: "Robin L Sample", excerpt: "\"Robin L Sample / Durwood W Sample\"" }), "Robin L Sample / Durwood W Sample");
  ok("joint account: a listed plan-set owner resolves (no spouse conflict); an unlisted one stays a conflict; a sentence excerpt is never a holder list");
}

console.log(`\nparserReviewList: all ${passed} checks passed`);
