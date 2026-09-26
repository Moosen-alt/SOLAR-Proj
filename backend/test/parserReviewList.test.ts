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

console.log(`\nparserReviewList: all ${passed} checks passed`);
