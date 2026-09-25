// GROUND SNOW MISREADS THE EXTRACTOR WAS SURE OF — the round-4 skeptic's must-fixes, as tests.
//
// Round 4 made the below-minimum and below-AHJ snow BLOCKERs ask ONE predicate (readGroundSnow: is the
// stated Pg unambiguous). That predicate can only doubt what the readers record, and an independent
// layout generator (595,560 layouts per family) still found 16,788 false minimum BLOCKERs on correct
// 36 psf plans — every one an UNAMBIGUOUS misread:
//   · MF1 a spaced dash ("GROUND SNOW LOAD - 36 PSF") was not a separator anywhere, so "ROOF DEAD LOAD
//     - 3 PSF GROUND SNOW LOAD - 36 PSF" split into a value-first "3 PSF GROUND SNOW LOAD" -> Pg 3;
//     and a bare "Pg" read the value before it outside any value-first list ("36 PSF 2.8 PSF Pg").
//   · MF2 "SNOW LOAD (GROUND)" read the value after it without asking which label owns it, and a
//     formula's coefficient after "Pg =" ("Pg = 0.7 (1.0)(1.1)(1.0)(36 PSF)") read as Pg 0.7.
//   · MF3 an ASD qualifier AFTER the value ("25.2 PSF (ASD)") or before the label ("ASD GROUND SNOW
//     LOAD") was ignored, so an ASD value read as Pg.
//   · caveat (a) a flattened table (a header row of labels, then a row of values) read as a list;
//     caveat (b) metric first ("= 1.72 KPA (36 PSF)") read 1.72.
//
// Every case runs through the REAL finding path (evaluateDesignCodeFindings) at a VERIFIED Oregon row
// with the 36/25 psf minimums and a 36 psf AHJ design criterion, prescriptive path. Where a layout is
// genuinely ambiguous the answer is a WARNING naming the readings — never a blocker.
// Fixtures are synthetic. No LLM, no network.
//
// Run: npx tsx backend/test/groundSnowMisreads.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";
import { extractStatedDesignCriteria, statedGroundSnowReading } from "../src/designCriteria";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const MIN_ID = "city.struct.ground-snow-below-state-minimum";
const AHJ_ID = "city.struct.design-criteria-below-ahj";
const CONFLICT_ID = "city.struct.design-criteria-conflict";
const project = { id: "snow-misreads", state: "OR", ahj: "City of Testport", utility: "Test Power", homeownerName: "Test Owner", projectAddress: "1 Test St", interconnectionMethod: "Load-side breaker", parserSnapshot: { mounting: "Roof mount", permitPath: "PRESCRIPTIVE" } } as unknown as ProjectRecord;
const profile: JurisdictionCodeProfile = {
  key: "or|city of testport|unknown", state: "OR", ahj: "City of Testport", confidence: "verified",
  adoptedCodes: [], amendments: [], designCriteria: { groundSnowLoadPsf: 36 }, fireSetbacks: [], citations: [], updatedAt: "",
  prescriptive: { minGroundSnowPsfPrescriptive: 36, minGroundSnowPsfEngineered: 25, minGroundSnowCitation: "ORSC 2023 R301.2.3.1" },
  verifiedBy: "operator", verifiedAt: "2026-09-24T00:00:00.000Z",
};
const ctx = buildCodeContext("OR", "City of Testport", profile);

interface Judged {
  reading: ReturnType<typeof statedGroundSnowReading>;
  /** "U36", "A{36?/25}", "none" — the predicate's answer, compact. */
  says: string;
  pg: number[];
  asd: number[];
  roof: number[];
  min?: ReviewerFinding;
  ahj?: ReviewerFinding;
  conflict?: ReviewerFinding;
}
function judge(text: string): Judged {
  const docs = [{ label: "Plan set", text }];
  const reading = statedGroundSnowReading(project, docs);
  const crit = extractStatedDesignCriteria(project, docs).criteria;
  const vals = (pred: (c: (typeof crit)[number]) => boolean): number[] => [...new Set(crit.filter(pred).map((c) => c.value as number))].sort((a, b) => a - b);
  const fs = evaluateDesignCodeFindings(project, null, ctx, [], docs);
  const says = reading.status === "unambiguous" ? `U${reading.value}` : reading.status === "ambiguous" ? `A{${reading.readings.map((r) => `${r.value}${r.unsure ? "?" : ""}`).join("/")}}` : "none";
  return {
    reading, says,
    pg: vals((c) => c.criterion === "groundSnowPsf" && c.qualifier === "ground"),
    asd: vals((c) => c.criterion === "groundSnowPsf" && c.qualifier === "ground_asd"),
    roof: vals((c) => c.criterion === "roofSnowPsf"),
    min: fs.find((f) => f.id === MIN_ID), ahj: fs.find((f) => f.id === AHJ_ID), conflict: fs.find((f) => f.id === CONFLICT_ID),
  };
}
const show = (j: Judged): string => `reads ${j.says} (Pg [${j.pg}] asd [${j.asd}] roof [${j.roof}]) min=${j.min?.severity ?? "-"} belowAhj=${j.ahj?.severity ?? "-"} conflict=${j.conflict?.severity ?? "-"}`;

/** A correct 36 psf plan read exactly: Pg 36 alone, sure; no minimum finding, no conflict, no below-AHJ. */
function reads36(text: string, extra?: (j: Judged) => void): void {
  check(`MUST-PASS reads Pg 36 only: ${JSON.stringify(text)}`, () => {
    const j = judge(text);
    assert.equal(j.says, "U36", show(j));
    assert.deepEqual(j.pg, [36], show(j));
    assert.ok(!j.min && !j.conflict && !j.ahj, show(j));
    extra?.(j);
  });
}
/** A 16 psf plan read surely: the minimum BLOCKER fires and names 16 — and only 16. */
function blocks16(text: string): void {
  check(`MUST-PASS a sure 16 is the BLOCKER naming 16: ${JSON.stringify(text)}`, () => {
    const j = judge(text);
    assert.equal(j.says, "U16", show(j));
    assert.equal(j.min?.severity, "blocker", show(j));
    const stated = j.min!.message.match(/Ground snow load Pg: stated ([^—]*)—/)?.[1] ?? "";
    assert.match(stated, /^16 psf in Plan set\s*$/, `names "${stated}" — ${show(j)}`);
  });
}
/** Never a minimum or below-AHJ BLOCKER, and none of `notSure` is ever a SURE Pg reading. */
function neverBlocks(text: string, notSure: number[], extra?: (j: Judged) => void): void {
  check(`MUST-EXCLUDE never a BLOCKER, never a sure Pg ${notSure.join("/")}: ${JSON.stringify(text)}`, () => {
    const j = judge(text);
    assert.notEqual(j.min?.severity, "blocker", show(j));
    assert.notEqual(j.ahj?.severity, "blocker", show(j));
    for (const v of notSure) {
      assert.notEqual(j.says, `U${v}`, show(j));
      if (j.reading.status === "ambiguous") assert.ok(!j.reading.readings.some((r) => r.value === v && !r.unsure), `${v} is a sure reading — ${show(j)}`);
    }
    extra?.(j);
  });
}
/** Genuinely ambiguous: the minimum is a WARNING that names the readings, never a blocker. */
function warnsNaming(text: string, values: number[]): void {
  check(`ambiguous -> a WARNING naming ${values.join("/")}: ${JSON.stringify(text)}`, () => {
    const j = judge(text);
    assert.equal(j.reading.status, "ambiguous", show(j));
    assert.equal(j.min?.severity, "warning", show(j));
    assert.notEqual(j.ahj?.severity, "blocker", show(j));
    for (const v of values) assert.match(j.min!.message, new RegExp(`\\b${String(v).replace(".", "\\.")} psf in Plan set`), `${v} not named — ${show(j)}`);
  });
}

console.log("MF1 — a spaced dash is an assigning separator; a bare Pg label reads the value before it only in a V L V L list");
reads36("GROUND SNOW LOAD - 36 PSF");
reads36("GROUND SNOW LOAD – 36 PSF");
reads36("ROOF DEAD LOAD - 3 PSF GROUND SNOW LOAD - 36 PSF");
reads36("ROOF DEAD LOAD - 3 PSF Pg - 36 PSF");
reads36("ROOF SNOW LOAD - 25 PSF GROUND SNOW LOAD - 36 PSF DEAD LOAD - 10 PSF", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("36 PSF - GROUND SNOW LOAD 25 PSF - ROOF SNOW LOAD", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("25 PSF - ROOF SNOW LOAD 36 PSF - GROUND SNOW LOAD 10 PSF - DEAD LOAD", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("DESIGN CRITERIA - GROUND SNOW LOAD 36 PSF");
reads36("WIND SPEED - 110 MPH GROUND SNOW LOAD - 36 PSF");
blocks16("ROOF DEAD LOAD - 3 PSF GROUND SNOW LOAD - 16 PSF");
blocks16("ROOF DEAD LOAD - 3 PSF Pg - 16 PSF");
blocks16("16 PSF - GROUND SNOW LOAD 10 PSF - ROOF SNOW LOAD");
neverBlocks("36 PSF 2.8 PSF Pg PV DEAD LOAD", [2.8]);
neverBlocks("ROOF DEAD LOAD 3 PSF 2.8 PSF Pg", [2.8]);
check("MUST-EXCLUDE a bare Pg after a lone value reads nothing (no V L V L evidence): \"36 PSF Pg\"", () => {
  const j = judge("36 PSF Pg");
  assert.equal(j.says, "none", show(j));
});
reads36("36 PSF Pg 25 PSF ROOF SNOW LOAD 10 PSF DEAD LOAD", (j) => assert.deepEqual(j.roof, [25], show(j)));
check("MUST-EXCLUDE 'ASCE 7-16' is never a value", () => {
  const j = judge("DESIGN PER ASCE 7-16");
  assert.equal(j.says, "none", show(j));
});
reads36("ASCE 7-16 GROUND SNOW LOAD - 36 PSF");
neverBlocks("ZONE 1: -16.5 PSF GROUND SNOW LOAD 36 PSF", [16.5]);
neverBlocks("C&C PRESSURE -16 PSF GROUND SNOW LOAD 36 PSF", [16]);
// A dash after the label inside a list that opens with a value contradicts the list's shape: both
// readings, each unsure — a warning naming both, never a blocker.
neverBlocks("36 PSF GROUND SNOW LOAD - 25 PSF ROOF SNOW LOAD", [25]);
warnsNaming("36 PSF GROUND SNOW LOAD - 25 PSF ROOF SNOW LOAD", [25, 36]);
warnsNaming("3 PSF GROUND SNOW LOAD - 36 PSF ROOF SNOW LOAD", [3, 36]);
// …unless a label-ish word before the list owns its opening value: label-first throughout.
reads36("MODULE RAILS 3 PSF GROUND SNOW LOAD - 36 PSF ROOF SNOW LOAD - 25 PSF", (j) => assert.deepEqual(j.roof, [25], show(j)));
// A dash after an unlisted label assigns the value after it to that label.
reads36("EXISTING ROOF - 10 PSF GROUND SNOW LOAD 36 PSF");
blocks16("MODULE RAILS - 3 PSF GROUND SNOW LOAD 16 PSF");
// The builder's corpus shapes are unchanged.
reads36("DESIGN LOADS\n36 PSF GROUND SNOW\n25 PSF ROOF SNOW\n10 PSF DEAD LOAD", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("36 PSF GROUND SNOW");
reads36("ROOF DEAD LOAD 3 PSF GROUND SNOW LOAD 36 PSF");

console.log("MF2 — every Pg reader asks ownership; a formula coefficient is not a stated Pg");
reads36("36 PSF SNOW LOAD (GROUND) 10 PSF DEAD LOAD");
reads36("36 PSF = SNOW LOAD (GROUND) 25 PSF = ROOF SNOW LOAD 10 PSF = DEAD LOAD", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("36 PSF SNOW LOAD (GROUND)");
reads36("25 PSF ROOF SNOW LOAD 36 PSF SNOW LOAD (GROUND) 10 PSF DEAD LOAD", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("SNOW LOAD (GROUND): 36 PSF SNOW LOAD (ROOF): 25 PSF");
reads36("ROOF DEAD LOAD 3 PSF SNOW LOAD (GROUND) 36 PSF");
blocks16("16 PSF SNOW LOAD (GROUND) 10 PSF DEAD LOAD");
neverBlocks("FLAT ROOF SNOW LOAD Pf = 0.7 Ce Ct Is Pg = 0.7 (1.0)(1.1)(1.0)(36 PSF) = 27.7 PSF", [0.7], (j) => {
  assert.ok(!j.pg.includes(0.7), `0.7 read as Pg — ${show(j)}`);
  assert.ok(j.pg.every((v) => v === 36), show(j));
});
reads36("pg = 36 psf; pf = 0.7 x Ce x Ct x Is x pg = 0.7 x 1.0 x 1.1 x 1.0 x 36 = 27.7 psf");
reads36("Pg = 36 PSF, Ce = 1.0, Ct = 1.1, Is = 1.0, Pf = 0.7 * Ce * Ct * Is * Pg = 0.7 * 1.0 * 1.1 * 1.0 * 36 = 27.7 PSF");
reads36("SEE DETAIL 3, pg 5. GROUND SNOW LOAD: 36 PSF");
check("MUST-EXCLUDE 'pg 5' is a page reference", () => {
  const j = judge("REFER TO pg 5 FOR ATTACHMENT DETAILS");
  assert.equal(j.says, "none", show(j));
});
check("MUST-EXCLUDE the production calc still reads Pg 31 alone", () => {
  const j = judge("Loading Summary Exposure and Occupancy Categories B II Wind Loading: v 95 mph Value overridden from ASCE Hazards default qz 13.75 psf pg 31.00 psf Ground Snow Load pg (Value overridden from ASCE Hazards default) p f = 0.7CeCtIsPg Flat Roof Snow Load When Pg > 20 psf, then use Pf = 20 psf p m = 20 psf Total Snow Load p s = 20.00 psf");
  assert.equal(j.says, "U31", show(j));
});
check("MUST-EXCLUDE the production letter still reads Pg 28 alone", () => {
  const j = judge("Loading Summary Exposure and Occupancy Categories B II Wind Loading: v 95 mph qz 13.74 psf pg 28.00 psf Ground Snow Load pg Exposure Category (ASCE 7-22 Table 26.7.3, Page 274) Fully Exposed Exposure category Ce = 0.9 q z = 13.74 psf Vasd q z = 8.34 psf Basic wind pressure V= 95 mph p f = 17.64 psf p m = 20 psf p f = 20.00 psf Total Snow Load p s = 20.00 psf");
  assert.equal(j.says, "U28", show(j));
});

console.log("MF3 — an ASD qualifier after the value, or before the label, marks the value ground_asd");
for (const t of ["GROUND SNOW LOAD = 25.2 PSF (ASD)", "ASD GROUND SNOW LOAD: 25.2 PSF", "SNOW: Pg = 25.2 PSF (ASD)", "GROUND SNOW LOAD: 25.2 PSF ASD"]) {
  check(`MUST-PASS an ASD ground snow is ground_asd, never Pg: ${JSON.stringify(t)}`, () => {
    const j = judge(t);
    assert.deepEqual(j.asd, [25.2], show(j));
    assert.deepEqual(j.pg, [], show(j));
    assert.ok(!j.min, show(j));
    assert.notEqual(j.ahj?.severity, "blocker", show(j));
  });
}
check("MUST-EXCLUDE the production letter: 'Pg : 28 psf; Pg(asd): 20 psf' reads Pg 28 + Pg(asd) 20", () => {
  const j = judge("Ground snow load, Pg : 28 psf; Pg(asd): 20 psf Minimum roof snow load, Pm: 20 psf");
  assert.equal(j.says, "U28", show(j));
  assert.deepEqual(j.asd, [20], show(j));
});
reads36("GROUND SNOW LOAD (Pg): 36 PSF");
check("MUST-EXCLUDE 'GROUND SNOW LOAD, ASD: 25.2 PSF' stays ground_asd", () => {
  const j = judge("GROUND SNOW LOAD, ASD: 25.2 PSF");
  assert.deepEqual(j.asd, [25.2], show(j));
  assert.deepEqual(j.pg, [], show(j));
});
reads36("GROUND SNOW LOAD Pg = 36 PSF (ULTIMATE), Pg = 25.2 PSF (ASD)", (j) => assert.deepEqual(j.asd, [25.2], show(j)));
reads36("GROUND SNOW LOAD = 36 PSF (ULTIMATE)");
reads36("WIND SPEED VASD 95 MPH GROUND SNOW LOAD: 36 PSF");
reads36("GROUND SNOW LOAD: 36 PSF ASD WIND SPEED: 85 MPH");

console.log("caveat (a) — a flattened table (two adjacent labels or values) is unsure; a clean alternation is not");
warnsNaming("DEAD LOAD LIVE LOAD GROUND SNOW LOAD 10 PSF 20 PSF 36 PSF", [10]);
warnsNaming("ROOF SNOW LOAD GROUND SNOW LOAD 25 PSF 36 PSF", [25]);
warnsNaming("36 PSF 25 PSF 3 PSF GROUND SNOW LOAD ROOF SNOW LOAD DEAD LOAD", [3]);
neverBlocks("ROOF SNOW LOAD GROUND SNOW LOAD 10 PSF 16 PSF", [10]);
// Two labels side by side alone (a header row) — and two values side by side alone (a value column).
neverBlocks("ROOF SNOW LOAD GROUND SNOW LOAD 25 PSF", [25]);
neverBlocks("36 PSF 25 PSF GROUND SNOW LOAD", [25]);
reads36("GROUND SNOW LOAD 36 PSF ROOF SNOW LOAD 25 PSF DEAD LOAD", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("DEAD LOAD 10 PSF LIVE LOAD 20 PSF GROUND SNOW LOAD 36 PSF");

console.log("caveat (b) — metric first reads the psf value, never the kPa one");
reads36("GROUND SNOW LOAD = 1.72 KPA (36 PSF)");
reads36("GROUND SNOW LOAD: 36 PSF (1.72 KPA)");
check("MUST-EXCLUDE a bare kPa value is never a psf Pg: 'GROUND SNOW LOAD = 1.72 KPA'", () => {
  const j = judge("GROUND SNOW LOAD = 1.72 KPA");
  assert.equal(j.says, "none", show(j));
});
blocks16("GROUND SNOW LOAD = 0.77 KPA (16 PSF)");
reads36("SNOW: Pg = 1.72 kPa (36 psf)");
for (const t of ["SNOW: Pg = 1.72 kPa", "SNOW LOAD (GROUND) = 1.72 KPA"]) {
  check(`MUST-EXCLUDE a bare kPa value is never a psf Pg: ${JSON.stringify(t)}`, () => {
    const j = judge(t);
    assert.equal(j.says, "none", show(j));
  });
}

if (failures) {
  console.error(`\n${failures} ground-snow misread check(s) FAILED`);
  process.exit(1);
}
console.log("\nall ground-snow misread checks passed");
process.exit(0);
