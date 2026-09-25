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
// The symbol as a factor in a product: the value after it is the product's result, not Pg.
blocks16("Pg = 16 psf (strength); Pg(asd) = 0.7 x Pg = 11.2 psf");
blocks16("GROUND SNOW LOAD: 16 PSF. ASD SNOW S = 0.7 Pg = 11.2 PSF");
reads36("Pg = 36 psf (strength); Pg(asd) = 0.7 x Pg = 25.2 psf");
reads36("2. Pg = 36 PSF");
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
// Not a table: a pair that closes one alternating segment and opens the next (sections run together
// in flattened text) — a sure reading stays sure, and a sure 16 stays a BLOCKER.
reads36("36 PSF GROUND SNOW LOAD 25 PSF ROOF SNOW LOAD 10 PSF DEAD LOAD\nROOF LIVE LOAD: 20 PSF", (j) => assert.deepEqual(j.roof, [25], show(j)));
blocks16("16 PSF GROUND SNOW LOAD 10 PSF DEAD LOAD\nROOF LIVE LOAD: 20 PSF");
blocks16("GROUND SNOW LOAD 16 PSF 10 PSF DEAD LOAD");
blocks16("16 PSF GROUND SNOW LOAD\nFLAT ROOF SNOW LOAD Pf = 0.7 Ce Ct Is Pg = 0.7 (1.0)(1.1)(1.0)(16 PSF) = 12.3 PSF");
reads36("GROUND SNOW LOAD 36 PSF ROOF SNOW LOAD 25 PSF DEAD LOAD", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("DEAD LOAD 10 PSF LIVE LOAD 20 PSF GROUND SNOW LOAD 36 PSF");

// A table's cells may be quantities the reader does not tokenise (an unknown label, a wind speed, a
// negative pressure): still a table.
neverBlocks("ROOF SNOW LOAD C&C PRESSURE GROUND SNOW LOAD 25 PSF -16 PSF 36 PSF", [25]);
neverBlocks("ROOF SNOW LOAD WIND SPEED GROUND SNOW LOAD 25 PSF 110 MPH 36 PSF", [25]);
neverBlocks("16 PSF 110 MPH 10 PSF GROUND SNOW LOAD WIND SPEED ROOF SNOW LOAD", [10]);
neverBlocks("ROOF SNOW LOAD WIND SPEED GROUND SNOW LOAD 25 PSF 110 MPH 36 PSF DEAD LOAD 10 PSF", [25]);
neverBlocks("EXISTING ROOFING EXPOSURE GROUND SNOW LOAD 10 PSF C 36 PSF", [10]);
neverBlocks("36 PSF C 25 PSF GROUND SNOW LOAD EXPOSURE ROOF SNOW LOAD", [25]);
neverBlocks("36 PSF II 25 PSF GROUND SNOW LOAD RISK CATEGORY ROOF SNOW LOAD", [25]);
// A header row whose first cell is a label the reader does not list: the orphan last value makes it a table.
neverBlocks("EXISTING ROOF GROUND SNOW LOAD 10 PSF 36 PSF", [10]);
neverBlocks("MODULE RAILS\nWIND SPEED\nGROUND SNOW LOAD\n3 PSF\n110 MPH\n36 PSF", [3]);
// …but a word between two values is a label of its own, not a table cell.
blocks16("GROUND SNOW LOAD 16 PSF EXISTING ROOF 10 PSF");
// …and a label whose value is "N/A" is not a header cell.
blocks16("SEISMIC LOAD N/A GROUND SNOW LOAD 16 PSF");

console.log("round 5 corpus finds — a negative value, a formula line after a list, an ASD line after a list");
// A value with a minus sign is a wind pressure, never a load (column-major "-16 PSF GROUND SNOW LOAD").
neverBlocks("36 PSF -16 PSF GROUND SNOW LOAD C&C PRESSURE", [16]);
neverBlocks("36 PSF 10 PSF -16 PSF GROUND SNOW LOAD EXISTING ROOFING C&C PRESSURE", [16]);
// "ROOF SNOW LOAD pf = 0.7 x Ce …": the formula line after a list is not the roof label assigning 0.7.
neverBlocks("3 PSF MODULE RAILS\n36 PSF GROUND SNOW LOAD\n25 PSF ROOF SNOW LOAD\npf = 0.7 x Ce x Ct x Is x pg = 0.7 x 1.0 x 1.1 x 1.0 x 36 = 27.7 psf", [25]);
// "10 PSF EXISTING ROOF GROUND SNOW LOAD = 25.2 PSF (ASD)": EXISTING ROOF has no value of its own.
neverBlocks("3 PSF MODULE RAILS\n36 PSF GROUND SNOW LOAD\n10 PSF EXISTING ROOF\nGROUND SNOW LOAD = 25.2 PSF (ASD)", [10]);
// "GROUND SNOW LOAD Pf = 0.7 Ce …" (the formula line right after the label): the label does not assign 0.7.
blocks16("16 PSF GROUND SNOW LOAD\nPf = 0.7 Ce Ct Is Pg = 0.7 (1.0)(1.1)(1.0)(16 PSF) = 12.3 PSF");
neverBlocks("3 PSF MODULE RAILS\n36 PSF GROUND SNOW LOAD\n10 PSF EXISTING ROOF\npf = 0.7 x Ce x Ct x Is x pg = 0.7 x 1.0 x 1.1 x 1.0 x 36 = 27.7 psf", [10]);
// A bare "ASD" that opens the next line is not the value's qualifier.
reads36("GROUND SNOW LOAD 36 PSF\nASD GROUND SNOW LOAD: 25.2 PSF", (j) => assert.deepEqual(j.asd, [25.2], show(j)));

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

// ROUND 6 (the round-5 skeptic's must-fixes; the last snow round — real documents are the acceptance
// instrument from here). Every text below is the verdict's own, verbatim.

console.log("MF-A — every dash glyph a sheet prints, and a run of dot leaders, is the same spaced separator");
reads36("GROUND SNOW LOAD — 36 PSF");
reads36("ROOF DEAD LOAD — 3 PSF GROUND SNOW LOAD — 36 PSF");
reads36("ROOF DEAD LOAD — 3 PSF Pg — 36 PSF");
reads36("ROOF DEAD LOAD ..... 3 PSF GROUND SNOW LOAD ..... 36 PSF");
reads36("GROUND SNOW LOAD ........ 36 PSF ROOF SNOW LOAD ........ 25 PSF DEAD LOAD ........ 10 PSF", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("GROUND SNOW LOAD .. 36 PSF");
reads36("ROOF DEAD LOAD 3 PSF -- GROUND SNOW LOAD -- 36 PSF");
reads36("36 PSF — GROUND SNOW LOAD 25 PSF — ROOF SNOW LOAD", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("36 PSF ..... GROUND SNOW LOAD 25 PSF ..... ROOF SNOW LOAD", (j) => assert.deepEqual(j.roof, [25], show(j)));
// A production phrasing with its "=" rendered as an em dash, and as dot leaders.
reads36("WIND SPEED AND EXPOSURE — 120 MPH, C ROOF SNOW LOAD — 25 PSF DEAD LOAD FOR ROOF-MOUNTED PANELS ATTACHMENTS — 2.81 PSF GROUND SNOW LOAD — 36 PSF", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("WIND SPEED AND EXPOSURE ..... 120 MPH, C ROOF SNOW LOAD ..... 25 PSF DEAD LOAD FOR ROOF-MOUNTED PANELS ATTACHMENTS ..... 2.81 PSF GROUND SNOW LOAD ..... 36 PSF", (j) => assert.deepEqual(j.roof, [25], show(j)));
blocks16("GROUND SNOW LOAD — 16 PSF");
blocks16("ROOF DEAD LOAD — 3 PSF GROUND SNOW LOAD — 16 PSF");
blocks16("ROOF DEAD LOAD ..... 3 PSF GROUND SNOW LOAD ..... 16 PSF");
// An em dash touching a digit is an edition or a sign, never a separator; a single full stop is not a leader.
reads36("ASCE 7—16 GROUND SNOW LOAD 36 PSF");
neverBlocks("C&C PRESSURE —16 PSF GROUND SNOW LOAD 36 PSF", [16]);
reads36("DEAD LOAD 10 psf. GROUND SNOW LOAD 36 PSF");
reads36("ROOF SNOW LOAD 25 PSF. GROUND SNOW LOAD 36 PSF", (j) => assert.deepEqual(j.roof, [25], show(j)));
// Caveat (f): a SPACED double hyphen assigns — "C&C PRESSURE -- 16 PSF" hands the 16 to the C&C pressure,
// so the plan's ground snow is its 36 alone (a sure 36, correct: the skeptic's own note).
reads36("C&C PRESSURE -- 16 PSF GROUND SNOW LOAD 36 PSF");

console.log("MF-C — a value-first reader never reads across an OCR-glued label ('25 PSFGROUND SNOW LOAD')");
neverBlocks("ROOF SNOW LOAD 25 PSFGROUND SNOW LOAD 36 PSF", [25]);
neverBlocks("25 PSFGROUND SNOW LOAD 36 PSF", [25]);
// A missing space between the digit and its unit is still a unit; a bare value-first list is still read.
reads36("36PSF GROUND SNOW 25PSF ROOF SNOW 3PSF DEAD LOAD", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("36 PSF GROUND SNOW 25 PSF ROOF SNOW 10 PSF DEAD LOAD", (j) => assert.deepEqual(j.roof, [25], show(j)));

console.log("MF-B — the Pg symbol as the LAST FACTOR of a juxtaposed product ('0.7 Ce Ct Is Pg = 27.7 psf') is not a stated Pg");
reads36("GROUND SNOW LOAD Pg = 36 PSF\nFLAT ROOF SNOW LOAD Pf = 0.7 Ce Ct Is Pg = 25.2 PSF");
reads36("Pg = 36 psf. Pf = 0.7 Ce Ct Is Pg = 27.7 psf");
/** A correct 36 psf plan beside a calculation document: U36, no conflict, no minimum finding. */
const reads36WithCalc = (plan: string, calc: string): void => {
  check(`MUST-PASS plan + calc reads Pg 36 only, no conflict: ${JSON.stringify(plan)} + ${JSON.stringify(calc)}`, () => {
    const docs = [{ label: "Plan set", text: plan }, { label: "Structural calculations", text: calc }];
    const reading = statedGroundSnowReading(project, docs);
    const fs = evaluateDesignCodeFindings(project, null, ctx, [], docs);
    const says = reading.status === "unambiguous" ? `U${reading.value}` : reading.status === "ambiguous" ? `A{${reading.readings.map((r) => `${r.value}${r.unsure ? "?" : ""}`).join("/")}}` : "none";
    const found = fs.filter((f) => [MIN_ID, AHJ_ID, CONFLICT_ID].includes(f.id)).map((f) => `${f.id}=${f.severity}`);
    assert.equal(says, "U36", `reads ${says}; findings ${found.join(", ") || "none"}`);
    assert.deepEqual(found, [], `reads ${says}; findings ${found.join(", ")}`);
  });
};
for (const calc of ["Pf = 0.7 Ce Ct Is Pg = 27.7 psf", "FLAT ROOF SNOW LOAD Pf = 0.7 Ce Ct Is Pg = 27.7 PSF", "Pf = 0.7 Ce Ct I Pg = 27.7 PSF", "Pg = 36 psf. Pf = 0.7 Ce Ct Is Pg = 27.7 psf"]) {
  reads36WithCalc("GROUND SNOW LOAD: 36 PSF", calc);
}
blocks16("GROUND SNOW LOAD: 16 PSF\nPf = 0.7 Ce Ct Is Pg = 11.2 PSF");
check("MUST-PASS a 16 psf plan beside the calc's product line is still the BLOCKER naming 16", () => {
  const docs = [{ label: "Plan set", text: "GROUND SNOW LOAD: 16 PSF" }, { label: "Structural calculations", text: "Pf = 0.7 Ce Ct Is Pg = 11.2 PSF" }];
  const reading = statedGroundSnowReading(project, docs);
  const min = evaluateDesignCodeFindings(project, null, ctx, [], docs).find((f) => f.id === MIN_ID);
  assert.deepEqual(reading, { status: "unambiguous", value: 16 }, JSON.stringify(reading));
  assert.equal(min?.severity, "blocker", `min=${min?.severity ?? "-"}`);
  assert.match(min!.message.match(/Ground snow load Pg: stated ([^—]*)—/)?.[1] ?? "", /^16 psf in Plan set\s*$/, min!.message);
});
// A comma list of the coefficients is not a product: Pg = 36 is stated.
reads36("Ce = 1.0, Ct = 1.1, Is = 1.0, Pg = 36 PSF, Pf = 27.7 PSF", (j) => assert.deepEqual(j.roof, [27.7], show(j)));
reads36("SNOW: Pg = 36 PSF, Ce = 1.0, Ct = 1.1, Is = 1.0");
reads36("GROUND SNOW LOAD: 36 PSF Pf=0.7CeCtIsPg=27.7psf");
check("MUST-EXCLUDE the production calc's 'p f = 0.7CeCtIsPg When Pg > 20 psf' still reads Pg 31 alone", () => {
  const j = judge("qz 13.75 psf pg 31.00 psf Ground Snow Load pg (Value overridden from ASCE Hazards default) p f = 0.7CeCtIsPg When Pg > 20 psf, then use Pf = 20 psf");
  assert.equal(j.says, "U31", show(j));
});
blocks16("GROUND SNOW LOAD: 16 PSF\nPg,asd = 0.7 Pg = 11.2 psf");
// PINNED DECISION: 'DESIGN SNOW: Is Pg = 36 PSF' alone reads NOTHING. "Is Pg" is the importance factor
// times Pg — the design snow, a product whose result is not a stated Pg (the same rule as
// '0.7 Ce Ct Is Pg = 27.7'). The package then gets the unknown callout, which asks a human; before this
// round it read a sure Pg 36. Either reading is defensible; this test says which one the engine gives,
// so a change is a decision, not a drift.
check("PINNED 'DESIGN SNOW: Is Pg = 36 PSF' alone reads nothing (a product's result is not a stated Pg)", () => {
  const j = judge("DESIGN SNOW: Is Pg = 36 PSF");
  assert.equal(j.says, "none", show(j));
  assert.ok(!j.min && !j.ahj, show(j));
});

console.log("K25 — a label that closes a value-first list and then assigns a formula COEFFICIENT does not close the list with a value");
// loadValueOwners' lastAssignsOwn asks OWN_VALUE_AFTER (a separator and a number that is not a coefficient),
// not the old '^\s*[:=]\s*\d'. The difference shows only where the closing label's first word is prose
// ("DESIGN", "MINIMUM") so no label-ish word claims the value before it: with the old test the run
// "36 PSF GROUND SNOW LOAD 25 PSF DESIGN SNOW LOAD Ps = 0.7 x …" closed with a value, read as "both"
// (A{36?/25?}, a warning on a correct plan; a 16 psf plan's BLOCKER lost) — with OWN_VALUE_AFTER the
// coefficient is no value, the list is V L V L, and the 36 is the sure Pg (round-5 skeptic K25).
reads36("36 PSF GROUND SNOW LOAD 25 PSF DESIGN SNOW LOAD Ps = 0.7 x Ce x Ct x Is x Pg = 0.7 x 1.0 x 1.1 x 1.0 x 36 = 27.7 PSF");
blocks16("16 PSF GROUND SNOW LOAD 10 PSF DESIGN SNOW LOAD Ps = 0.7 x Ce x Ct x Is x Pg = 0.7 x 1.0 x 1.1 x 1.0 x 16 = 12.3 PSF");
reads36("36 PSF GROUND SNOW LOAD 25 PSF DESIGN SNOW LOAD = 0.7 Ce Ct Is Pg = 27.7 PSF");

console.log("MF-D (one rule) — a value-first run BROKEN by a token the glue does not recognise reads UNSURE on both sides, never sure label-first");
// "36 PSF (ULT.) GROUND SNOW LOAD 25 PSF ROOF SNOW LOAD": the parenthetical after the 36 broke the run, and
// the fragment opening with the ground label read the 25 as a SURE Pg — a BLOCKER on a correct plan (and a
// 16 psf plan blocked naming 10). The one rule: a run that opens with a label, just after a value no
// label-first run owns, is read both ways — a warning naming the readings, never a blocker. No new tokens:
// the 36 itself is not read here (its reader needs the label beside it), so the warning names the 25.
/** MF-D on a 36 psf plan: never a BLOCKER, `notSure` never a sure Pg, and the minimum is a WARNING. */
function warnsUnsure(text: string, notSure: number[]): void {
  neverBlocks(text, notSure, (j) => {
    assert.equal(j.min?.severity, "warning", show(j));
    assert.notEqual(j.says, "none", show(j));
  });
}
/** MF-D on a 16 psf plan: blocked naming 16, or a warning; 10 is never a sure Pg. */
function neverSure10(text: string): void {
  check(`MUST-PASS a 16 psf plan is blocked naming 16 or warned, never a sure 10: ${JSON.stringify(text)}`, () => {
    const j = judge(text);
    assert.notEqual(j.says, "U10", show(j));
    if (j.reading.status === "ambiguous") assert.ok(!j.reading.readings.some((r) => r.value === 10 && !r.unsure), `10 is a sure reading — ${show(j)}`);
    if (j.min?.severity === "blocker") assert.match(j.min.message.match(/Ground snow load Pg: stated ([^—]*)—/)?.[1] ?? "", /^16 psf in Plan set\s*$/, show(j));
    else assert.equal(j.min?.severity, "warning", show(j));
  });
}
const D36 = [
  "36 PSF (ULT.) GROUND SNOW LOAD 25 PSF ROOF SNOW LOAD",
  "36 PSF (1.72 KPA) GROUND SNOW LOAD 25 PSF ROOF SNOW LOAD",
  "36 PSF* GROUND SNOW LOAD 25 PSF ROOF SNOW LOAD",
  "36 psf. GROUND SNOW LOAD 25 PSF ROOF SNOW LOAD",
  "36 P.S.F. GROUND SNOW LOAD 25 PSF ROOF SNOW LOAD",
  "36 P\nSF GROUND SNOW LOAD 25 PSF ROOF SNOW LOAD",
  "36 GROUND SNOW LOAD 25 PSF ROOF SNOW LOAD",
  "36 PSF (1.72 KPA) GROUND SNOW LOAD 25 PSF (1.20 KPA) ROOF SNOW LOAD 10 PSF (0.48 KPA) DEAD LOAD",
  // The same list with ":" / "=" after each value (a third of the skeptic's decoration family).
  "36 PSF (ULT.): GROUND SNOW LOAD 25 PSF: ROOF SNOW LOAD",
  "36 PSF (ULT.) = GROUND SNOW LOAD 25 PSF = ROOF SNOW LOAD",
  "36: GROUND SNOW LOAD 25 PSF: ROOF SNOW LOAD",
  // A stray value after a value-first fragment the reader does not list ("10 PSF EXISTING ROOF 36 GROUND …").
  "10 PSF EXISTING ROOF 36 GROUND SNOW LOAD 3 PSF ROOF DEAD LOAD",
];
for (const t of D36) warnsUnsure(t, [25, 3]);
for (const t of D36) neverSure10(t.replace(/\b36\b/g, "16").replace(/\b25\b/g, "10").replace("1.72 KPA", "0.77 KPA").replace("1.20 KPA", "0.48 KPA"));
// MUST-EXCLUDE: nothing precedes the run; a paren after a LABEL-FIRST value; a value a label before it owns;
// a list marker; a speed; an edition; a sign; a heading's colon. Every one stays a sure 36.
reads36("GROUND SNOW LOAD 36 PSF ROOF SNOW LOAD 25 PSF DEAD LOAD", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("ROOF LIVE LOAD 20 PSF (0 PSF UNDER PV), GROUND SNOW 36 PSF, WIND 110 MPH");
reads36("GROUND SNOW LOAD 36 PSF, ROOF SNOW 25 PSF (BALANCED), DEAD 3 PSF");
reads36("GROUND SNOW LOAD 36 PSF (ULT.) ROOF SNOW LOAD 25 PSF (ULT.) DEAD LOAD 10 PSF (ULT.)", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("ROOF DEAD LOAD 3 PSF (TYP.) GROUND SNOW LOAD 36 PSF (TYP.)");
reads36("EXISTING ROOFING 10 PSF (TYP.) GROUND SNOW LOAD 36 PSF (TYP.)");
reads36("2. GROUND SNOW LOAD 36 PSF 3. ROOF SNOW LOAD 25 PSF", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("2) GROUND SNOW LOAD 36 PSF 3) ROOF SNOW LOAD 25 PSF", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("110 MPH GROUND SNOW LOAD 36 PSF ROOF SNOW LOAD 25 PSF", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("WIND SPEED 110 MPH (TYP.) GROUND SNOW LOAD 36 PSF");
reads36("ASCE 7-16 GROUND SNOW LOAD 36 PSF ROOF SNOW LOAD 25 PSF", (j) => assert.deepEqual(j.roof, [25], show(j)));
reads36("C&C PRESSURE -16 PSF (TYP.) GROUND SNOW LOAD 36 PSF");
reads36("SNOW LOADS: GROUND SNOW LOAD 36 PSF ROOF SNOW LOAD 25 PSF", (j) => assert.deepEqual(j.roof, [25], show(j)));
blocks16("ROOF DEAD LOAD 3 PSF (TYP.) GROUND SNOW LOAD 16 PSF (TYP.)");
blocks16("2. GROUND SNOW LOAD 16 PSF 3. ROOF SNOW LOAD 10 PSF");

if (failures) {
  console.error(`\n${failures} ground-snow misread check(s) FAILED`);
  process.exit(1);
}
console.log("\nall ground-snow misread checks passed");
process.exit(0);
