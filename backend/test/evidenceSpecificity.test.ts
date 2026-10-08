// THE EVIDENCE LISTS THAT ACCEPTED ANYTHING.
//
// Four screens were cleared by ordinary plan-set vocabulary rather than by the evidence they
// were asking for. Each is a FALSE CLEAR on a structural or fire-safety item, and each has the
// same shape as the fire-pathway defect fixed alongside them: an inclusion list containing a
// word that appears on every drawing.
//
//   attachment  — /mount/i cleared it. Every set says "roof mount". Measured: the demo
//                 projects, which carry NO extracted plan text at all, passed the
//                 attachment-detail screen purely because their `mounting` field reads
//                 "Roof mount".
//   framing     — /structural/i and /engineer/i cleared it, and title blocks carry both. A
//                 sentence SAYING the framing information is absent also contains
//                 "structural", so the report cleared itself on a statement of ignorance.
//   ESS         — the suppression list held /fire/i (now on every plan set, thanks to the
//                 fire-pathway work) and /ESS/i, which matches "addrESS" and "procESS".
//                 Even word-bounded, the acronym also TRIGGERED the rule, so it cleared its
//                 own review (#245); suppression now takes 706/R328/1207/clearance only.
//   truss span  — /truss/i on framingType granted the span exemption even for "rafter/truss"
//                 or "not truss", dropping the very demand that caught the overspan Portland
//                 bounced Trask for.
//
// Measured against the operator's 23-project book before shipping: zero real customer projects
// change verdict on framing, ESS or truss. Only projects with no plan text at all newly flag.
// (That ESS measurement predates #245 and #257, which changed the ESS screen again: the bare
// acronym no longer clears it, and parser labels and negated mentions no longer raise it.)
// Run: tsx backend/test/evidenceSpecificity.test.ts
import assert from "node:assert/strict";
import type { ProjectRecord } from "../../shared/src/types";
import { buildReviewerReport } from "../src/reviewerEngine";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// `over` overlays the parser snapshot; a `state`/`ahj` in it is also set on the project row
// itself, so a fixture's jurisdiction is the project's, not only the snapshot's (#257).
const mk = (text: string, over: Record<string, string> = {}): ProjectRecord => ({
  id: "ev", clientId: "c", homeownerName: "Evidence Probe", projectAddress: "1 Sheet St",
  city: "Coos Bay", state: over.state ?? "OR", zip: "97420", ahj: over.ahj ?? "City of Coos Bay",
  utility: "Pacific Power", accountNumber: "1234567890", meterNumber: "987654",
  systemSizeDcKw: 9, systemSizeAcKw: 7.6, interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
    mounting: "Roof mount", interco: "Load-side breaker",
    busRating: "225A", mainBreaker: "175A", pvBreaker: "40",
    planSetExtractedText: text, ...over,
  },
} as unknown as ProjectRecord);

const has = (id: string, text: string, over: Record<string, string> = {}): boolean =>
  buildReviewerReport(mk(text, over)).findings.some((f) => f.id === id);
check("fixture: a jurisdiction override reaches the project row, not only the snapshot", () => {
  const p = mk("", { state: "AZ", ahj: "Town of Example Mesa" });
  assert.equal(p.state, "AZ");
  assert.equal(p.ahj, "Town of Example Mesa");
});

// A realistic sheet body that satisfies every OTHER screen, so only the rule under test moves.
const BASE = '36" FIRE ACCESS PATHWAY PER IFC 1205.2. RAPID SHUTDOWN PER NEC 690.12. 705.12 BUSBAR CALC. SITE PLAN AND ROOF PLAN. SINGLE LINE DIAGRAM. LABEL SCHEDULE.';

console.log("\n1. ATTACHMENT — the word 'mount' is not an attachment detail");
check("MUST PASS: a set that only says 'roof mount' still owes an attachment detail", () => {
  assert.equal(has("city.struct.attachment-detail-missing", `${BASE} ROOF MOUNT SOLAR ARRAY.`), true,
    "the attachment-detail blocker was cleared by the words 'roof mount'");
});
check("MUST PASS: a project with NO plan text at all owes one", () => {
  // This is the measured live case: the demo rows carry no extracted text and were cleared
  // by their `mounting` FIELD reading "Roof mount".
  assert.equal(has("city.struct.attachment-detail-missing", ""), true,
    "a project with no plan set text passed the attachment screen");
});
for (const [label, detail] of [
  ["attachment detail", "ATTACHMENT DETAIL: 5/16 LAG SCREW INTO RAFTER, 4 IN EMBEDMENT."],
  ["flashed standoff", "FLASHED STANDOFF AT EACH ATTACHMENT POINT, 48 IN O.C."],
  ["racking spec", "RACKING DETAIL: IRONRIDGE XR-10 RAIL, L-FOOT WITH FLASHFOOT2 FLASHING."],
] as const) {
  check(`MUST EXCLUDE: a real ${label} satisfies it`, () => {
    assert.equal(has("city.struct.attachment-detail-missing", `${BASE} ${detail}`), false,
      `a package showing ${label} was still told the detail is missing`);
  });
}

console.log("\n2. ROOF FRAMING — a title block is not framing evidence");
check("MUST PASS: 'STRUCTURAL ENGINEER OF RECORD' in a title block does not clear framing", () => {
  assert.equal(has("city.struct.framing-missing", `${BASE} STRUCTURAL ENGINEER OF RECORD: SMITH PE.`), true,
    "a title-block credit cleared the roof-framing screen");
});
check("MUST PASS: a sentence SAYING framing is unknown does not clear it", () => {
  // The old list matched /structural/i, so this sentence cleared the very screen it admits to failing.
  assert.equal(has("city.struct.framing-missing", `${BASE} NO STRUCTURAL FRAMING INFORMATION WAS AVAILABLE FOR THIS ROOF.`), true,
    "a statement of ignorance was accepted as evidence");
});
for (const [label, detail] of [
  ["rafter callout", "ROOF FRAMING: 2x6 RAFTERS @ 24 O.C., DF-L No.2, CLEAR SPAN 12 FT."],
  ["truss callout", "PRE-ENGINEERED TRUSSES, 2x4 TOP CHORD @ 24 O.C."],
  ["span table", "SPAN TABLE PER OSSC TABLE 2308.7.2(1)."],
] as const) {
  check(`MUST EXCLUDE: a real ${label} satisfies it`, () => {
    assert.equal(has("city.struct.framing-missing", `${BASE} ${detail}`), false,
      `real framing evidence (${label}) was reported missing`);
  });
}

console.log("\n3. ESS — 'address' and 'fire access pathway' are not battery clearances");
const BATT = { batteryMake: "Tesla", batteryModel: "Powerwall 3", batteryQty: "1" };
check("MUST PASS: the fire-pathway note does not silence the ESS detail check", () => {
  // BASE contains "FIRE ACCESS PATHWAY", and the old suppression list held a bare /fire/i —
  // so the fire-pathway work would itself have switched off every battery review.
  assert.equal(has("city.ess.details-missing", BASE, BATT), true,
    "an ESS review was cleared by the roof's fire access pathway note");
});
check("MUST PASS: the word 'address' does not silence it", () => {
  assert.equal(has("city.ess.details-missing", `${BASE} SERVICE ADDRESS AND PROCESS NOTES.`, BATT), true,
    "/ESS/i matched 'addrESS' and cleared the battery review");
});
check("MUST EXCLUDE: real ESS clearances satisfy it", () => {
  assert.equal(has("city.ess.details-missing", `${BASE} ESS WORKING SPACE 36 IN CLEARANCE PER NEC 706 AND IRC R328.`, BATT), false,
    "a package showing ESS working space and clearances was still asked for them");
});
check("MUST EXCLUDE: a project with no battery raises no ESS finding at all", () => {
  assert.equal(has("city.ess.details-missing", BASE), false,
    "a system with no storage was asked for battery clearances");
});
// #245: /\bESS\b/i sat in BOTH the trigger list and the suppression list, so the acronym that
// raised the review also cleared it. A set whose only storage mention is an equipment-schedule
// line could never warn. Run on two synthetic jurisdictions so no single AHJ fixture carries it.
const SCHEDULE_ESS = "EQUIPMENT SCHEDULE: (1) ESS 13.5 KWH, (24) PV MODULES, (1) INVERTER.";
for (const [label, over] of [
  ["jurisdiction A", { state: "OR", ahj: "City of Sample Falls" }],
  ["jurisdiction B", { state: "AZ", ahj: "Town of Example Mesa" }],
] as const) {
  check(`MUST PASS: 'ESS' in the equipment schedule with no detail still warns (${label})`, () => {
    assert.equal(has("city.ess.details-missing", `${BASE} ${SCHEDULE_ESS}`, over), true,
      "the bare acronym 'ESS' cleared the battery-detail review it had just raised");
  });
  check(`MUST PASS: a battery project whose only ESS mention is the acronym still warns (${label})`, () => {
    assert.equal(has("city.ess.details-missing", `${BASE} ${SCHEDULE_ESS}`, { ...BATT, ...over }), true,
      "the bare acronym 'ESS' cleared a Powerwall's detail review");
  });
}
for (const [label, detail] of [
  ["NEC 706 detail", "ESS DETAIL SHEET E-5: INSTALLATION PER NEC 706."],
  ["IRC R328 detail", "ESS DETAIL SHEET E-5: LOCATION PER IRC R328.4, GARAGE WALL."],
  ["NFPA 855 detail", "ESS DETAIL SHEET E-5: INSTALLATION PER NFPA 855, GARAGE WALL."],
] as const) {
  check(`MUST EXCLUDE: an ESS detail sheet citing ${label} satisfies it`, () => {
    assert.equal(has("city.ess.details-missing", `${BASE} ${SCHEDULE_ESS} ${detail}`), false,
      `a package with an ESS detail (${label}) was still told the detail is missing`);
  });
}
// #257 (1): the parser's own split map and download checklist always print a Battery / ESS line,
// even with no battery. Those are the parser's labels, not the designer's sheets.
const PARSER_LABELS = {
  splitPagesText: "01 SLD / 3-line: 3\n07 Battery / ESS specs: not detected\n08 Gateway specs: not detected",
  utilityDownloadChecklistText: "READY - 01 SLD 3-Line Diagram\nOPTIONAL/MISSING - 07 Battery / ESS Spec Sheet\nOPTIONAL/MISSING - 08 Gateway Spec Sheet",
};
// #257 (2): a denied mention is not storage scope.
const NEGATED_ESS = ["ESS: N/A.", "NO ESS PROPOSED.", "BATTERY / ESS: NONE.", "BATTERY: NONE.", "NO BATTERY / ESS.", "ENERGY STORAGE (BATTERY BACKUP): NOT USED."];
for (const [label, over] of [
  ["jurisdiction A", { state: "OR", ahj: "City of Sample Falls" }],
  ["jurisdiction B", { state: "AZ", ahj: "Town of Example Mesa" }],
] as const) {
  check(`MUST EXCLUDE: the parser's split-map/checklist battery labels raise no ESS finding (${label})`, () => {
    assert.equal(has("city.ess.details-missing", BASE, { ...PARSER_LABELS, ...over }), false,
      "a no-battery project warned on the parser's own '07 Battery / ESS' labels");
  });
  for (const note of NEGATED_ESS) {
    check(`MUST EXCLUDE: '${note}' raises no ESS finding (${label})`, () => {
      assert.equal(has("city.ess.details-missing", `${BASE} ${note}`, over), false,
        `a negated storage mention ('${note}') raised the battery-detail review`);
    });
  }
  check(`MUST PASS: a real battery beside the parser labels still warns (${label})`, () => {
    assert.equal(has("city.ess.details-missing", `${BASE} ${SCHEDULE_ESS}`, { ...PARSER_LABELS, ...BATT, ...over }), true,
      "dropping the parser labels also dropped a real battery's review");
  });
  check(`MUST PASS: 'NO ESS' elsewhere does not hide an affirmed battery (${label})`, () => {
    assert.equal(has("city.ess.details-missing", `${BASE} GATEWAY: NONE. (1) POWERWALL 3 BATTERY IN GARAGE.`, over), true,
      "a negation next to a different item hid an affirmed battery");
  });
}

console.log("\n4. TRUSS SPAN EXEMPTION — only an unambiguous truss earns it");
// Trusses are pre-engineered, so the truss arm asks for spacing but not clear span. That
// exemption must not open on a value that also says "rafter", or one that negates truss.
const spanAsked = (framingType: string): boolean =>
  has("city.struct.span-table-incomplete", `${BASE} ROOF FRAMING NOTED.`,
    { framingType, permitPath: "Prescriptive", rafterSpacing: "24" });
check("MUST EXCLUDE: a clean 'truss' still earns the exemption", () => {
  assert.equal(spanAsked("truss"), false,
    "a pre-engineered truss roof was asked for a rafter clear span — the Reavis regression");
});
for (const ambiguous of ["rafter/truss", "truss or rafter (unverified)", "not truss", "non-truss"]) {
  check(`MUST PASS: "${ambiguous}" does NOT earn the exemption`, () => {
    assert.equal(spanAsked(ambiguous), true,
      `an ambiguous framing type opened the truss exemption and dropped the span demand`);
  });
}
check("MUST EXCLUDE: a plain 'rafter' keeps the full span demand", () => {
  assert.equal(spanAsked("rafter"), true,
    "the rafter span demand disappeared — this is the overspan Portland bounced Trask for");
});

console.log("\n5. MLPE — a battery brand is not an inverter topology");
// Module-level power electronics satisfy NEC 690.12 inherently, so an MLPE design has its
// rapid-shutdown finding softened from blocker to warning. The detector scanned the WHOLE
// plan text for brand names — and Enphase makes batteries (Encharge, IQ Battery). So a
// STRING-inverter system with an Enphase battery was reclassified as MLPE and had its
// rapid-shutdown blocker downgraded. The inverter fields are the authority; a brand name
// elsewhere in the text is not.
const rsdSeverity = (snap: Record<string, string>, text: string): string => {
  const f = buildReviewerReport(mk(text, snap)).findings
    .find((x) => x.id === "city.elec.rapid-shutdown-missing");
  return f?.severity ?? "(absent)";
};
const STRING_INVERTER = { invModel: "SolarEdge SE7600H-US", inverterModel: "SolarEdge SE7600H-US" };
const NO_RSD = "SITE PLAN AND ROOF PLAN. SINGLE LINE DIAGRAM. ATTACHMENT DETAIL: LAG SCREW INTO RAFTER. 2x6 RAFTERS @ 24 O.C.";

check("MUST PASS: an Enphase BATTERY does not make a string design MLPE", () => {
  assert.equal(
    rsdSeverity({ ...STRING_INVERTER, batteryMake: "Enphase", batteryModel: "IQ Battery 5P" },
      `${NO_RSD} ENPHASE IQ BATTERY 5P ENERGY STORAGE.`),
    "blocker",
    "a string-inverter design had its rapid-shutdown blocker downgraded by a battery brand");
});
check("MUST EXCLUDE: a genuine microinverter design is still softened to a warning", () => {
  assert.equal(
    rsdSeverity({ pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US", pvMicroQty: "24" }, NO_RSD),
    "warning",
    "a real MLPE design was hard-blocked for a rapid-shutdown callout it satisfies inherently");
});
check("MUST EXCLUDE: a plain string design still raises the blocker", () => {
  assert.equal(rsdSeverity(STRING_INVERTER, NO_RSD), "blocker",
    "a string-inverter system stopped answering for rapid shutdown");
});

console.log(failures === 0
  ? "\nAll evidence-specificity checks passed."
  : `\n${failures} evidence-specificity check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
