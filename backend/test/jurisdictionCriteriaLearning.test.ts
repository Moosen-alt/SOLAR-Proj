// EVERY PROJECT TEACHES THE JURISDICTION — SAFELY.
//
// Two real bounces (fixtures are SYNTHETIC strings modelled on their facts — no names,
// addresses, firms or seals):
//   A. A coastal city's building review, "Addl Info Needed": "Provide updated design criteria
//      ... -Ground snow load 36 psf. Provide updated mounting spacing. -The mounting spacing
//      should be 2' oc per R324.4.1 exception 5 exception 1.4. Provide UL listing ..." Its code
//      profile had designCriteria {} and prescriptive {}; nothing learned from the comment.
//   B. Another coastal city: "... special wind region. The minimum wind speed design is 120 MPH
//      Ultimate Exposure D. R310.2.1 ORSC" plus a conflicting-criteria item and a manufactured-
//      home item that state no number. No profile row for that city at all.
//
// WHAT THIS FILE REFUSES TO LET REGRESS:
//   1. AHJ COMMENT -> PROPOSAL: the deterministic extractor reads A and B into the right
//      criteria (MUST-PASS) and nothing else (MUST-EXCLUDE: a live load, a fee, a code section,
//      framing spacing, roof snow, a quoted package value, an ASD speed, a rating, a negation).
//      Intake (addManualCorrection — the real write path) attaches them to the correction's
//      review item; apply lands them as SEEDED with a citation to the comment; a verified row
//      is untouched; an existing different seeded value is shown old -> new and a value that
//      drifted after the proposal is refused; a later research re-save keeps the AHJ's value.
//   2. APPROVED DESIGNS ARE CORROBORATION: the monitor's first issued reading records an
//      observation; designCriteria is unchanged; the unknown finding quotes it; a value a later
//      AHJ correction contradicted is not counted.
//   3. LOOK IT UP: one design-criteria lookup per AHJ lacking criteria, skipped when off /
//      keyless / recently asked / verified; the merge fills blanks only (stubbed LLM).
//
//   npx tsx backend/test/jurisdictionCriteriaLearning.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesignCriteriaResearchResult, JurisdictionCodeProfile, LLMProvider } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jurisdiction-criteria-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CODE_RESEARCH;
delete process.env.SKIP_CODE_RESEARCH;
delete process.env.PORTAL_AUTOSEED;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const CP = await import("../src/codeProfiles");
const { extractAhjRequiredCriteria, evaluateDesignCriteriaFindings } = await import("../src/designCriteria");
const { applyJurisdictionProposals, applyCorrectionApproval, parseCorrectionProposals, persistTriage } = await import("../src/correctionAgent");
const { enqueueJob, processNextJob } = await import("../src/jobQueue");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const TEXT_A = "Provide updated design criteria for the letter from the engineer and the plan set. -Ground snow load 36 psf. "
  + "Provide updated mounting spacing. -The mounting spacing should be 2' oc per R324.4.1 exception 5 exception 1.4. "
  + "Provide UL listing for the panels, mounting and racking hardware.";
const TEXT_B = "1. The structural engineered design criteria is conflicting between the calculations and the submitted plans set. "
  + "Please ensure the correct design criteria is the same on all documents. R106 ORSC 2. Testcoast City is located in a special wind region. "
  + "The minimum wind speed design is 120 MPH Ultimate Exposure D. R310.2.1 ORSC 3. The proposed installation is being placed on a manufactured home. "
  + "Prescriptive code does not allow this as these structures are not conventionally designed to support any additional loads. "
  + "Revise the structural design to show how the new loads will be adequately transferred through the existing walls to the ground below (Cont. load path). R301.1.3 ORSC";

const asMap = (list: Array<{ criterion: string; value: unknown }>): Record<string, unknown> =>
  Object.fromEntries(list.map((c) => [c.criterion, c.value]));

// ─────────────────────────────────────────────────────────────────────────────────────────
// 1a. THE EXTRACTOR — must pass AND must exclude.
// ─────────────────────────────────────────────────────────────────────────────────────────
await check("MUST PASS (A): ground snow 36 psf, 2' o.c. attachment spacing (24 in), UL listing evidence — and nothing else", () => {
  const got = extractAhjRequiredCriteria(TEXT_A);
  assert.deepEqual(asMap(got), { groundSnowLoadPsf: 36, maxAttachmentSpacingIn: 24, listingEvidenceRequired: true });
  assert.equal(got.find((c) => c.criterion === "listingEvidenceRequired")?.block, "prescriptive");
  assert.equal(got.find((c) => c.criterion === "maxAttachmentSpacingIn")?.block, "prescriptive");
  assert.match(String(got.find((c) => c.criterion === "groundSnowLoadPsf")?.basis), /Ground snow load 36 psf/);
});

await check("MUST PASS (B): 120 mph ultimate, Exposure D, special wind region — items 1 and 3 state no criterion", () => {
  assert.deepEqual(asMap(extractAhjRequiredCriteria(TEXT_B)), { specialWindRegion: true, windSpeedMph: 120, windExposure: "D" });
});

await check("MUST PASS: other honest phrasings of the same requirements", () => {
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Design ground snow load (Pg) shall be 25 psf.")), { groundSnowLoadPsf: 25 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Attachments must be spaced at 48\" o.c. maximum.")), { maxAttachmentSpacingIn: 48 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Use Vult = 130 mph, Exposure C.")), { windSpeedMph: 130, windExposure: "C" });
  // The framing member's spacing in the SAME sentence is not the attachment spacing.
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Roof hooks shall be at 48\" o.c. max into rafters @ 16\" o.c.")), { maxAttachmentSpacingIn: 48 });
});

await check("MUST EXCLUDE: live load, fee, code sections, framing, roof snow, quoted package, ASD, rating, negation, ambiguity", () => {
  const none: string[] = [
    "Roof live load shall be 20 psf roof live load.",
    "The plan review fee is $120. The permit fee is $365.40, payable before issuance.",
    "See R324.4.1 exception 5 exception 1.4 and R310.2.1.",
    "Existing 2x4 rafters @ 24\" o.c. — verify span.",
    "Roof snow load 36 psf.",
    "The calculations show Exposure B, 95 mph wind and ground snow 28 psf.",
    "Vasd 93 mph wind.",
    "Racking is tested to 160 mph wind.",
    "Pg(asd) 20 psf.",
    "Testcoast City is not located in a special wind region.",
    "Ground snow load 25 psf. Ground snow load 36 psf.", // two values: ambiguous, a human reads it
  ];
  for (const text of none) assert.deepEqual(extractAhjRequiredCriteria(text), [], `extracted from: ${text}`);
});

await check("MUST EXCLUDE: a REJECTED, CONDITIONAL or QUOTED value is never proposed as the AHJ's requirement", () => {
  const none: string[] = [
    // rejection context
    "Ground snow load 16 psf on the plans is incorrect.",
    "Design wind speed 95 mph is incorrect.",
    "Exposure B is not acceptable",
    "Exposure B is not acceptable for this site.",
    "The attachments at 6' o.c. are not allowed.",
    "Anchors at 32\" o.c. exceed the manufacturer's allowable spacing.",
    "The ground snow load in the letter (25 psf) does not match the plans (30 psf).",
    // conditional / a question
    "Verify whether the site is in a special wind region.",
    "If the site is located in a special wind region, provide a wind design by an engineer.",
    "Provide an engineered design if the ground snow load exceeds 25 psf.",
    // the package quoted back
    "Plan set: ground snow 25 psf.",
    "Calcs - Exposure B, 95 mph, ground snow 28 psf.",
    "Engineer letter: 110 mph, Exposure C.",
    "The letter states the minimum ground snow load is 25 psf.",
    "Per the engineer, the plans show the minimum ground snow load of 25 psf.",
    "Engineer letter: minimum ground snow load 25 psf.", // the letter's claim, cue word and all
    "Calcs - design wind speed shall be 110 mph.",
    "The site's ground snow load is 36 psf.", // no cue, not a bare label statement, no header
    "Design criteria: Wind 110 mph Exposure C, Ground snow 25 psf per engineer letter dated 1/1.",
    // a portal page printing the applicant's entered criteria mid-line (caveat e)
    "Record 187-26-000309-STR In Review Addl Info Needed Wind Speed 120 mph Exposure C Snow Load 16 psf",
    // no requirement at all
    "Rails at 48\" o.c. span; attachments at 72\" o.c.",
    "Max span between mounts 48 in o.c.",
    // listings: an inverter's UL 1741 is not module/racking evidence; a negated requirement is none
    "Provide UL 1741 listing for the inverter.",
    "UL listing is not required for the racking.",
  ];
  for (const text of none) assert.deepEqual(extractAhjRequiredCriteria(text).map((c) => [c.criterion, c.value]), [], `extracted from: ${text}`);
});

await check("MUST PASS: requirement cues — shall / should / minimum ... is / required / provide / a bullet under 'Provide' / special wind region stated", () => {
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Attachment spacing shall not exceed 4' o.c.")), { maxAttachmentSpacingIn: 48 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("The minimum ground snow load is 25 psf; your plans show 16 psf.")), { groundSnowLoadPsf: 25 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Exposure B is not acceptable; Exposure C is required.")), { windExposure: "C" });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Provide the following:\nGround snow load 36 psf\nDesign wind speed 120 mph")), { groundSnowLoadPsf: 36, windSpeedMph: 120 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Provide updated design criteria. -The site's ground snow load is 36 psf.")), { groundSnowLoadPsf: 36 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Testcoast City is located in a special wind region.")), { specialWindRegion: true });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Provide UL listing for the panels, mounting and racking hardware.")), { listingEvidenceRequired: true });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Racking must be UL 2703 listed.")), { listingEvidenceRequired: true });
});

// MF3: "Provide ..." asks for something; it states a value only with a CODE citation for it.
await check("MUST EXCLUDE: 'Provide/Submit ...' carrying the PACKAGE's number, and a flattened portal STATUS PAGE's fields", () => {
  const none: string[] = [
    "Provide calculations for 16 psf ground snow load.",
    "Provide a copy of the engineer letter for the 16 psf ground snow load used.",
    "Provide attachment spacing at 72\" o.c. per the engineer letter.",
    "Submit calculations for 110 mph wind, Exposure C.",
    "Provide ground snow load 16 psf per the plans.",
    "Provide engineering calculations for 36 psf ground snow load per ORSC R301.2.3.", // a document asked for, code or not
    // The status page, flattened WITH periods (every production portal text is single-line).
    "Record 187-26-000309-STR: Residential Structural Record Status: Addl Info Needed. Application Information. Wind Speed 120 mph Exposure C. Snow Load 16 psf.",
    "Record Status: Addl Info Needed Expiration Date: 03/16/2027. Ground Snow Load 16 psf. Wind Speed 120 mph.",
    "Application Information: Wind Exposure: C Ground Snow Load: 16 psf Roof Pitch: 6/12",
    "Permit 2026-0001 Status: Additional Information Required\nWind Speed 115 mph\nExposure C\nSnow Load 0 psf",
  ];
  for (const text of none) assert.deepEqual(extractAhjRequiredCriteria(text).map((c) => [c.criterion, c.value]), [], `extracted from: ${text}`);
});

await check("MUST PASS: 'Provide X per <code>' states a requirement; a CUED comment on a status page still counts; a bare statement off a status page still counts", () => {
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Provide attachment spacing of 48\" o.c. maximum per R324.4.1.")), { maxAttachmentSpacingIn: 48 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Provide design for a ground snow load of 36 psf per ORSC R301.2.3.")), { groundSnowLoadPsf: 36 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Provide ground snow load of 40 psf per ASCE 7-22.")), { groundSnowLoadPsf: 40 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Record Status: Addl Info Needed. Application Information. Wind Speed 110 mph. Comments: Design wind speed shall be 120 mph.")), { windSpeedMph: 120 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Ground snow load 36 psf.")), { groundSnowLoadPsf: 36 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria(TEXT_A)), { groundSnowLoadPsf: 36, maxAttachmentSpacingIn: 24, listingEvidenceRequired: true });
});

// r3r MUST-FIX 1: a document noun ANYWHERE in what "Provide" asks for — not only the word right after
// it — makes the number the package's; a header that asks for a document passes no cue (and no bare
// reading) to its items. The first text puts an ADJECTIVE before "calculations": without calc\w* in
// the noun list, or with the old adjacent-word match, it proposes 16.
await check("MUST EXCLUDE (r3r): 'Provide <words> calculations/calcs/letter/copy ...' and a header asking for a document carry the PACKAGE's numbers", () => {
  const none: string[] = [
    "Provide structural calculations per ASCE 7-22 for 16 psf ground snow load.",
    "Provide stamped structural calcs per ASCE 7-16 for the 25 psf ground snow load.",
    "Provide wind load calculations per ASCE 7-22 using 110 mph.",
    "Provide a structural letter per IRC R301.2 for 16 psf ground snow load.",
    "Provide pull-out calcs per NDS 2018 for lag screws at 48 in o.c.",
    "Provide a copy of the engineer letter for:\n- 16 psf ground snow load\n- 110 mph wind",
    "Provide calculations for the following:\n- Ground snow load 16 psf\n- Wind speed 110 mph",
    // the same list with its items unmarked: every line under the header is an item, not only the first
    "Provide calculations for the following:\nGround snow load 16 psf\nWind speed 110 mph",
    "Provide racking manufacturer's span tables per ASCE 7-22 for attachment spacing at 72\" o.c.",
  ];
  for (const text of none) assert.deepEqual(extractAhjRequiredCriteria(text).map((c) => [c.criterion, c.value]), [], `extracted from: ${JSON.stringify(text)}`);
});

await check("MUST PASS (r3r): 'Provide <value> per <code>' and a header asking for DESIGN CRITERIA (not a document) still state the requirement", () => {
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Provide Vult = 130 mph per ASCE 7-22.")), { windSpeedMph: 130 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Provide ground snow load of 25 psf per ORSC R301.2.")), { groundSnowLoadPsf: 25 });
  // TEXT_A's header names "the letter" and "the plan set" — as where the criteria GO, after "for".
  assert.deepEqual(asMap(extractAhjRequiredCriteria(TEXT_A)), { groundSnowLoadPsf: 36, maxAttachmentSpacingIn: 24, listingEvidenceRequired: true });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Provide updated design criteria on the cover sheet:\n- Ground snow load 36 psf\n- Wind speed 120 mph")), { groundSnowLoadPsf: 36, windSpeedMph: 120 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Provide the following:\nGround snow load 36 psf\nDesign wind speed 120 mph")), { groundSnowLoadPsf: 36, windSpeedMph: 120 });
  // A document request still carries the listing FLAG (evidence is what it asks for).
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Provide UL 2703 listing documentation for the racking.")), { listingEvidenceRequired: true });
});

// r3r-close MUST-FIX 1: a document header cuts off its items WHATEVER THE LAYOUT — under a section
// heading, as a bullet itself, with numbered/lettered items, and with its items on its own line after
// the colon. Each text is read as a paste AND as a status reading (both must give nothing).
// Mutations that must fail this check: the item-number fold in ahjSentences (the "1." split off as a
// sentence of its own made the item a bare statement), the bullet-header branch (a header ending ":"
// that is itself an item), and the same-line list after a document's ":".
await check("MUST EXCLUDE (r3r-close): a document header's items carry the PACKAGE's numbers in every layout", () => {
  const none: string[] = [
    "Structural Comments:\nProvide calculations for the following:\n- Ground snow load 16 psf\n- Wind speed 110 mph",
    "- Provide calculations for the following:\n  - Ground snow load 16 psf\n  - Wind speed 110 mph",
    "Provide calculations for the following:\n1. Ground snow load 16 psf\n2. Wind speed 110 mph",
    "Provide calculations for the following: ground snow load 16 psf; wind speed 110 mph.",
    "Structural:\nProvide a copy of the engineer letter for:\n1. 16 psf ground snow load",
    // the same lists in the other common shapes
    "Provide calculations for the following: 1. Ground snow load 16 psf 2. Wind speed 110 mph",
    "Provide calculations for the following: ground snow load 16 psf. Wind speed 110 mph.",
    "Structural Comments:\nProvide calculations for the following:\n1. Ground snow load 16 psf\n2. Wind speed 110 mph",
    "Provide calculations for the following:\n- Structural:\n  - Ground snow load 16 psf",
  ];
  for (const text of none) {
    for (const statusReading of [false, true]) {
      assert.deepEqual(extractAhjRequiredCriteria(text, { statusReading }).map((c) => [c.criterion, c.value]), [], `extracted (statusReading=${statusReading}) from: ${JSON.stringify(text)}`);
    }
  }
});

await check("MUST PASS (r3r-close): a header asking for DESIGN CRITERIA keeps its items — numbered, under a heading — as a paste and as a status reading", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["Provide the following:\n1. Ground snow load 36 psf\n2. Design wind speed 120 mph", { groundSnowLoadPsf: 36, windSpeedMph: 120 }],
    ["Plan Review Comments:\nProvide updated design criteria on the cover sheet:\n- Ground snow load 36 psf\n- Wind speed 120 mph", { groundSnowLoadPsf: 36, windSpeedMph: 120 }],
    ["Structural Comments:\nProvide updated design criteria on the cover sheet:\n1. Ground snow load 36 psf", { groundSnowLoadPsf: 36 }],
    [TEXT_A, { groundSnowLoadPsf: 36, maxAttachmentSpacingIn: 24, listingEvidenceRequired: true }],
    ["Provide Vult = 130 mph per ASCE 7-22.", { windSpeedMph: 130 }],
  ];
  for (const [text, want] of cases) {
    for (const statusReading of [false, true]) {
      assert.deepEqual(asMap(extractAhjRequiredCriteria(text, { statusReading })), want, `statusReading=${statusReading}: ${JSON.stringify(text)}`);
    }
  }
  // TEXT_B's numbered items state their own cues; folding the item numbers changes none of them.
  assert.deepEqual(asMap(extractAhjRequiredCriteria(TEXT_B)), { specialWindRegion: true, windSpeedMph: 120, windExposure: "D" });
});

// r3f MF2: after the item-number fold, a numbered SIBLING comment ("2." after a header that was itself
// "1. …:") read as an item of comment 1's header, so the header's cue carried to it — and on a STATUS
// reading the package's own 110 mph / Exposure C became the jurisdiction's proposals. A line whose
// marker is the header's own family at the same level is the next comment: it closes the header.
await check("MUST EXCLUDE (r3f): a numbered sibling comment does not inherit the numbered header's cue (status reading)", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["Corrections:\n1. The following design criteria are required:\n   a. Ground snow load 36 psf\n2. Wind speed 110 mph per plans.", { groundSnowLoadPsf: 36 }],
    ["1. Minimum design loads shall be as follows:\n- Ground snow load 36 psf\n2. Wind exposure C noted on PV-1.", { groundSnowLoadPsf: 36 }],
    ["1) The following design criteria are required:\n   a) Ground snow load 36 psf\n2) Wind speed 110 mph per plans.", { groundSnowLoadPsf: 36 }],
    // The header need not open its line: the "1." numbers the comment the header sits in.
    ["1. Revise per the checklist. The following design criteria are required:\n   a. Ground snow load 36 psf\n2. Wind speed 110 mph per plans.", { groundSnowLoadPsf: 36 }],
  ];
  for (const [text, want] of cases) assert.deepEqual(asMap(extractAhjRequiredCriteria(text, { statusReading: true })), want, JSON.stringify(text));
});
await check("MUST PASS (r3f): a sibling closes only its own header — an unnumbered header's numbered lines stay its items; later comments still read as pasted", () => {
  for (const statusReading of [false, true]) {
    assert.deepEqual(asMap(extractAhjRequiredCriteria("Provide the following:\n1. Ground snow load 36 psf\n2. Design wind speed 120 mph", { statusReading })), { groundSnowLoadPsf: 36, windSpeedMph: 120 }, `statusReading=${statusReading}`);
    // Lettered items under a numbered header are ITEMS (another family), even printed flush left.
    assert.deepEqual(asMap(extractAhjRequiredCriteria("1. The following design criteria are required:\na. Ground snow load 36 psf\nb. Design wind speed 120 mph", { statusReading })), { groundSnowLoadPsf: 36, windSpeedMph: 120 }, `lettered, statusReading=${statusReading}`);
    // The same family INDENTED under the header is a nested list — items, not siblings.
    assert.deepEqual(asMap(extractAhjRequiredCriteria("1. The following design criteria are required:\n   1. Ground snow load 36 psf\n   2. Design wind speed 120 mph", { statusReading })), { groundSnowLoadPsf: 36, windSpeedMph: 120 }, `nested, statusReading=${statusReading}`);
  }
  // Comment 1 asks for a DOCUMENT (its item is the package's 16); comment 2 states the requirement.
  assert.deepEqual(asMap(extractAhjRequiredCriteria("1. Provide calculations for the following:\n- Ground snow load 16 psf\n2. Revise the design criteria to the following:\n- Ground snow load 36 psf")), { groundSnowLoadPsf: 36 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("1. Provide a stamped engineer letter for the following:\n   a. Attachment spacing 48 in\n2. Ground snow load: 36 psf")), { groundSnowLoadPsf: 36 });
  // A bullet header's same-level bullets are still its items: the document header still cuts them off.
  for (const statusReading of [false, true]) {
    assert.deepEqual(extractAhjRequiredCriteria("- Provide calculations for the following:\n- Ground snow load 16 psf\n- Wind speed 110 mph", { statusReading }), [], `statusReading=${statusReading}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 1b. INTAKE -> PROPOSAL -> APPLY, through the real write paths.
// ─────────────────────────────────────────────────────────────────────────────────────────
const seeded = (ahj: string, over: Partial<JurisdictionCodeProfile> = {}): void => {
  CP.saveResearchedCodeProfile(db, {
    key: "", state: "OR", ahj, confidence: "seeded",
    adoptedCodes: [{ code: "ORSC", edition: "2023" }], amendments: [], designCriteria: {}, prescriptive: {},
    fireSetbacks: [], citations: [], updatedAt: "", ...over,
  });
};
const ownRow = (ahj: string) => CP.ownCodeProfileRow(db, "OR", ahj);
const mkProject = (ahj: string, snapshot: Record<string, string> = {}, learningExcluded = false): string => R.createProject(db, {
  owner: "Synthetic Owner", state: "OR", dcKw: "8.4", acKw: "7.7", street: "1 Test Way", city: "Testbay", zip: "97420",
  ahj, utility: "Test Power", ...snapshot,
} as never, undefined, { learningExcluded }).project.id;
const itemPayload = (projectId: string, correctionId: string) => {
  const row = db.query<{ notes: string }>("SELECT notes FROM human_review_items WHERE project_id = ? AND field_name = 'correction'", [projectId])
    .find((r) => parseCorrectionProposals(r.notes)?.correctionId === correctionId);
  return row ? parseCorrectionProposals(row.notes) : null;
};

seeded("City of Testbay");
const pidA = mkProject("City of Testbay");
const corrA = R.addManualCorrection(db, pidA, TEXT_A).corrections[0].id;

await check("intake attaches JURISDICTION proposals (blank -> value), separate from the project-field list", () => {
  const p = itemPayload(pidA, corrA);
  assert.ok(p, "no linked review item");
  assert.deepEqual(p!.proposals, [], "a jurisdiction value leaked into the project-field proposals");
  const j = p!.jurisdictionProposals;
  assert.deepEqual(asMap(j), { groundSnowLoadPsf: 36, maxAttachmentSpacingIn: 24, listingEvidenceRequired: true });
  for (const x of j) {
    assert.equal(x.status, "proposed");
    assert.equal(x.currentValue, null);
    assert.equal(x.ahj, "City of Testbay");
    assert.equal(x.source.correctionId, corrA);
    assert.equal(x.profileKey, ownRow("City of Testbay")!.key);
  }
});

await check("the LLM triage's rewrite of the notes keeps the jurisdiction proposals", () => {
  persistTriage(db, { correctionId: corrA, projectId: pidA }, { actions: ["Revise sheets."], proposals: [] });
  assert.equal(itemPayload(pidA, corrA)!.jurisdictionProposals.length, 3);
});

await check("APPLY: lands as seeded with the value + a citation to the AHJ comment; a second apply does nothing", () => {
  const r = applyJurisdictionProposals(db, corrA, undefined, "operator@test");
  assert.equal(r.applied.length, 3, JSON.stringify(r));
  const row = ownRow("City of Testbay")!;
  assert.equal(row.profile.prescriptive.listingEvidenceRequired, true);
  assert.equal(row.profile.confidence, "seeded");
  assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 36);
  assert.equal(row.profile.prescriptive.maxAttachmentSpacingIn, 24);
  const cite = row.profile.citations.find((c) => c.kind === "ahj_correction" && c.field === "designCriteria.groundSnowLoadPsf");
  assert.ok(cite, "no ahj_correction citation");
  // MF2: the SHARED row carries criterion, value, date and a generic source — never the AHJ's
  // sentence, the correction id or the record number (they stay in the org's review item + audit).
  assert.match(cite!.label, /^AHJ plan-review correction \(\d{4}-\d{2}-\d{2}\): groundSnowLoadPsf = 36$/);
  assert.ok(cite!.at, "the citation lost its date");
  const stored = String(db.get<{ p: string }>("SELECT payload_json AS p FROM jurisdiction_code_profiles WHERE profile_key = ?", [row.key])?.p);
  assert.doesNotMatch(stored, /Ground snow load 36 psf|Provide updated|correctionId|recordNumber/, "a correction excerpt / id reached the shared profile row");
  assert.doesNotMatch(stored, new RegExp(corrA), "the correction id reached the shared profile row");
  // ...and the org-scoped side still has the sentence: the review item and the project's audit log.
  assert.match(String(itemPayload(pidA, corrA)!.jurisdictionProposals.find((x) => x.criterion === "groundSnowLoadPsf")?.basis), /Ground snow load 36 psf/);
  assert.ok(db.query<{ d: string }>("SELECT details AS d FROM audit_logs WHERE project_id = ? AND action = 'code_profile.criterion_from_correction'", [pidA])
    .some((r) => /Ground snow load 36 psf/.test(r.d) && r.d.includes(corrA)), "the audit log lost the quote / correction id");
  assert.ok(itemPayload(pidA, corrA)!.jurisdictionProposals.every((x) => x.status === "applied"));
  assert.equal(applyJurisdictionProposals(db, corrA, undefined, "operator@test").attempted, 0, "an applied proposal re-applied");
  assert.ok(R.getProjectDetail(db, pidA).project, "project still readable");
});

await check("a later research / import re-save keeps the value the AHJ itself stated", () => {
  seeded("City of Testbay", { designCriteria: { groundSnowLoadPsf: 20, windSpeedMph: 100 } });
  const row = ownRow("City of Testbay")!;
  assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 36, "research overwrote the AHJ's own value");
  assert.equal(row.profile.designCriteria.windSpeedMph, 100, "research's other values should still land");
  assert.ok(row.profile.citations.some((c) => c.kind === "ahj_correction"));
});

await check("a VERIFIED row is never touched: proposal is blocked, and a forced apply is refused", () => {
  CP.saveVerifiedCodeProfile(db, {
    key: "", state: "OR", ahj: "City of Verifiedport", confidence: "verified",
    adoptedCodes: [{ code: "ORSC", edition: "2023" }], amendments: [], designCriteria: { groundSnowLoadPsf: 30 }, prescriptive: {},
    fireSetbacks: [], citations: [], updatedAt: "",
  }, "tester");
  const pid = mkProject("City of Verifiedport");
  const cid = R.addManualCorrection(db, pid, "Ground snow load 36 psf.").corrections[0].id;
  const j = itemPayload(pid, cid)!.jurisdictionProposals;
  assert.equal(j.length, 1);
  assert.equal(j[0].status, "blocked_verified");
  assert.equal(applyJurisdictionProposals(db, cid, undefined, "op").attempted, 0);
  const forced = CP.applyCorrectionCriterionToProfile(db, { ...j[0], status: "proposed" }, { actor: "op", projectId: pid });
  assert.equal(forced.status, "refused");
  const row = ownRow("City of Verifiedport")!;
  assert.equal(row.profile.confidence, "verified");
  assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 30);
});

await check("a DIFFERENT seeded value is shown old -> new, and a value that drifted since is refused", () => {
  seeded("City of Oldvalue", { designCriteria: { groundSnowLoadPsf: 25 } });
  const pid = mkProject("City of Oldvalue");
  const cid = R.addManualCorrection(db, pid, "Ground snow load 36 psf.").corrections[0].id;
  const j = itemPayload(pid, cid)!.jurisdictionProposals;
  assert.equal(j[0].currentValue, 25);
  assert.equal(j[0].value, 36);
  assert.equal(j[0].status, "proposed");
  // Someone else changes the row before the human applies.
  seeded("City of Oldvalue", { designCriteria: { groundSnowLoadPsf: 30 } });
  const r = applyJurisdictionProposals(db, cid, ["jurisdiction:groundSnowLoadPsf"], "op");
  assert.equal(r.refused.length, 1, JSON.stringify(r));
  assert.equal(ownRow("City of Oldvalue")!.profile.designCriteria.groundSnowLoadPsf, 30, "a value the human never saw was overwritten");
});

await check("B: no row yet -> proposals from blank; apply creates the AHJ's seeded row", () => {
  const pid = mkProject("City of Testcoast");
  const cid = R.addManualCorrection(db, pid, TEXT_B).corrections[0].id;
  const j = itemPayload(pid, cid)!.jurisdictionProposals;
  assert.deepEqual(asMap(j), { specialWindRegion: true, windSpeedMph: 120, windExposure: "D" });
  assert.ok(j.every((x) => x.profileKey === "" && x.currentValue === null));
  assert.ok(j.every((x) => x.targetProfileKey === CP.codeProfileKey({ state: "OR", ahj: "City of Testcoast" })), "the card must name the row it will create");
  const r = applyJurisdictionProposals(db, cid, undefined, "op");
  assert.equal(r.applied.length, 3);
  const row = ownRow("City of Testcoast")!;
  assert.equal(row.profile.confidence, "seeded");
  assert.deepEqual([row.profile.designCriteria.windSpeedMph, row.profile.designCriteria.windExposure, row.profile.designCriteria.specialWindRegion], [120, "D", true]);
});

await check("THE APPROVAL (apply route): a jurisdiction-only, non-design correction applies without a 409", () => {
  seeded("City of Routeville");
  const pid = mkProject("City of Routeville");
  const created = R.addManualCorrection(db, pid, "Ground snow load 36 psf.").corrections[0];
  assert.notEqual(created.correctionBucket, "B_designer_fix", "fixture precondition: this leg needs a non-design bucket");
  const out = applyCorrectionApproval(db, created.id, undefined, "op");
  assert.equal(out.jurisdictionCriteria?.applied.length, 1);
  assert.equal(ownRow("City of Routeville")!.profile.designCriteria.groundSnowLoadPsf, 36);
  // Project fields were not touched and the project did not move to a designer wait.
  assert.notEqual(String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid])?.status), "waiting_on_designer");
});

await check("THE APPROVAL: a design correction applies its jurisdiction values AND parks on the designer", () => {
  seeded("City of Designton");
  const pid = mkProject("City of Designton");
  const created = R.addManualCorrection(db, pid, TEXT_A).corrections[0];
  assert.equal(created.correctionBucket, "B_designer_fix");
  const out = applyCorrectionApproval(db, created.id, undefined, "op");
  assert.equal(out.jurisdictionCriteria?.applied.length, 3);
  assert.equal(String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid])?.status), "waiting_on_designer");
});

const reviewItem = (projectId: string, correctionId: string) =>
  db.query<{ status: string; notes: string }>("SELECT status, notes FROM human_review_items WHERE project_id = ? AND field_name = 'correction'", [projectId])
    .find((r) => parseCorrectionProposals(r.notes)?.correctionId === correctionId);
const auditCount = (projectId: string, action: string): number => Number(db.get<{ n: number }>(
  "SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ? AND action = ?", [projectId, action])?.n ?? 0);

await check("THE APPROVAL: a fields-only (project) apply does NOT strand the jurisdiction proposals — the next click applies them, once", () => {
  seeded("City of Selectton");
  const pid = mkProject("City of Selectton");
  const cid = R.addManualCorrection(db, pid, TEXT_A).corrections[0].id;
  applyCorrectionApproval(db, cid, ["meterNumber"], "op");
  assert.equal(ownRow("City of Selectton")!.profile.designCriteria.groundSnowLoadPsf, undefined, "an unselected jurisdiction value was applied");
  const mid = reviewItem(pid, cid)!;
  assert.equal(mid.status, "pending", "the item closed with its jurisdiction proposals still 'proposed' — nothing left to click");
  assert.ok(parseCorrectionProposals(mid.notes)!.jurisdictionProposals.every((p) => p.status === "proposed"));
  assert.equal(auditCount(pid, "correction.waiting_on_designer"), 1);
  // The background triage lands AFTER that approval: its rewrite must keep "project half done".
  persistTriage(db, { correctionId: cid, projectId: pid }, { actions: ["Revise sheets."], proposals: [{ field: "meterNumber", currentValue: "", proposedValue: "M-1", basis: "x" }] });
  assert.ok((JSON.parse(reviewItem(pid, cid)!.notes.slice(13)) as { projectAppliedAt?: string }).projectAppliedAt, "the triage rewrite dropped the record that the project half already ran");
  // The operator's next click (the dashboard posts {}): the jurisdiction values land, the item
  // closes, and the project half (designer wait) is NOT run a second time.
  const out = applyCorrectionApproval(db, cid, undefined, "op");
  assert.equal(out.jurisdictionCriteria?.applied.length, 3);
  assert.equal(ownRow("City of Selectton")!.profile.designCriteria.groundSnowLoadPsf, 36);
  assert.equal(reviewItem(pid, cid)!.status, "approved");
  assert.equal(auditCount(pid, "correction.waiting_on_designer"), 1, "the designer wait ran twice");
  assert.equal(auditCount(pid, "correction.proposals_applied"), 1, "the project half was applied twice");
});

await check("OTHER STATES: a Texas AHJ's correction proposes for ITS OWN row (tx|...), never a same-named row in another state", () => {
  // Same city name seeded in Oregon: a state is part of the key, and it is never crossed.
  seeded("City of Plano", { designCriteria: { windSpeedMph: 100 } });
  const orBefore = JSON.stringify(ownRow("City of Plano")!.profile);
  const pid = R.createProject(db, {
    owner: "Synthetic Owner", state: "TX", dcKw: "8.4", acKw: "7.7", street: "1 Test Way", city: "Plano", zip: "75074",
    ahj: "City of Plano", utility: "Test Electric",
  } as never).project.id;
  const cid = R.addManualCorrection(db, pid, "Design wind speed shall be 115 mph, Exposure C.").corrections[0].id;
  const j = itemPayload(pid, cid)!.jurisdictionProposals;
  assert.deepEqual(asMap(j), { windSpeedMph: 115, windExposure: "C" });
  assert.ok(j.every((x) => x.state === "TX" && x.targetProfileKey === CP.codeProfileKey({ state: "TX", ahj: "City of Plano" })));
  assert.ok(j.every((x) => x.currentValue === null), "an Oregon value was shown as the Texas city's");
  applyJurisdictionProposals(db, cid, undefined, "op");
  assert.equal(CP.exactCodeProfileRow(db, "TX", "City of Plano")!.profile.designCriteria.windSpeedMph, 115);
  assert.equal(JSON.stringify(ownRow("City of Plano")!.profile), orBefore, "the Oregon row was changed by a Texas correction");
});

await check("THE APPROVAL: a jurisdiction-only approval CLOSES the review item and marks the correction human-reviewed", () => {
  seeded("City of Closeton");
  const pid = mkProject("City of Closeton");
  const created = R.addManualCorrection(db, pid, "Ground snow load 36 psf.").corrections[0];
  assert.notEqual(created.correctionBucket, "B_designer_fix", "fixture precondition: a non-design correction");
  applyCorrectionApproval(db, created.id, undefined, "op");
  assert.equal(reviewItem(pid, created.id)!.status, "approved", "left pending with nothing to click");
  assert.equal(Number(db.get<{ h: number }>("SELECT human_approved AS h FROM corrections WHERE id = ?", [created.id])?.h), 1);
  assert.equal(db.get<{ c: string | null }>("SELECT closed_at AS c FROM corrections WHERE id = ?", [created.id])?.c ?? null, null, "approval must not close the correction itself");
});

await check("THE WRITE PATH NEVER FUZZY-MATCHES: 'City of Lincoln City' is not written into 'Lincoln County'", () => {
  seeded("Lincoln County", { designCriteria: { windSpeedMph: 110 } });
  const countyBefore = JSON.stringify(ownRow("Lincoln County")!.profile);
  assert.equal(CP.ownCodeProfileRow(db, "OR", "City of Lincoln City")?.profile.ahj, "Lincoln County", "fixture precondition: the READ fuzzy match bridges these two");
  const pid = mkProject("City of Lincoln City");
  const cid = R.addManualCorrection(db, pid, TEXT_B.replace("Testcoast City", "Lincoln City")).corrections[0].id;
  const j = itemPayload(pid, cid)!.jurisdictionProposals;
  assert.ok(j.length >= 2);
  for (const x of j) {
    assert.equal(x.profileKey, "", "the proposal was aimed at another jurisdiction's row");
    assert.equal(x.currentValue, null, "the proposal showed another jurisdiction's value as this one's");
    assert.equal(x.targetProfileKey, CP.codeProfileKey({ state: "OR", ahj: "City of Lincoln City" }));
    assert.equal(x.nearestOtherRow?.ahj, "Lincoln County", "the card should say which row a name match would have picked");
  }
  applyJurisdictionProposals(db, cid, undefined, "op");
  const created = CP.exactCodeProfileRow(db, "OR", "City of Lincoln City");
  assert.ok(created, "no row created for City of Lincoln City");
  assert.equal(created!.profile.designCriteria.windSpeedMph, 120);
  assert.equal(JSON.stringify(ownRow("Lincoln County")!.profile), countyBefore, "Lincoln County's shared row was changed");
  // A proposal made before this rule (aimed at the fuzzy row) is refused, never written through —
  // for an AHJ that has no row of its own yet, too.
  const legacy = { ...j[0], ahj: "City of Lincoln Shore", status: "proposed" as const, currentValue: null, profileKey: ownRow("Lincoln County")!.key };
  assert.equal(CP.applyCorrectionCriterionToProfile(db, legacy, { actor: "op", projectId: pid }).status, "refused");
  assert.equal(CP.exactCodeProfileRow(db, "OR", "City of Lincoln Shore"), null, "a legacy fuzzy-aimed proposal still wrote");
  assert.equal(JSON.stringify(ownRow("Lincoln County")!.profile), countyBefore);
});

// ─── MF1: THE WRITE PATH NEVER SHADOWS OR DOWNGRADES THE ROW THE READS USE ─────────────────
// Reads resolve "City of Portland" to the verified bare-name row or|portland (fuzzy); imported rows
// are keyed "Plano"/"Seattle" while projects say "City of X". A write that created a row under the
// project's spelling replaced those rows for every later read (verified -> seeded, amendments gone).
const fakeProvider = (result: DesignCriteriaResearchResult): LLMProvider => ({ researchDesignCriteria: async () => result } as unknown as LLMProvider);
const enqueued: Array<Record<string, unknown>> = [];
const mkProjectIn = (state: string, ahj: string): string => R.createProject(db, {
  owner: "Synthetic Owner", state, dcKw: "8.4", acKw: "7.7", street: "1 Test Way", city: "Testville", zip: "00000",
  ahj, utility: "Test Power",
} as never).project.id;

await check("sameJurisdictionName: one jurisdiction under two labels is the same; a county, another type or another name is not", () => {
  const same: Array<[string, string, string]> = [["City of Plano", "Plano", "TX"], ["Portland", "City of Portland", "OR"], ["Elmore County, ID", "Elmore County", "ID"],
    ["County of Elmore", "Elmore County", "ID"], ["Town of Testham", "Testham", "WI"], ["Portland OR", "Portland", "OR"], ["City of The Dalles", "The Dalles", "OR"]];
  const different: Array<[string, string, string]> = [["City of Lincoln City", "Lincoln County", "OR"], ["City of Lincoln", "Lincoln County", "OR"], ["Lincoln", "Lincoln County", "OR"],
    ["Town of Testham", "City of Testham", "WI"], ["City of Coos Bay", "Coos County", "OR"], ["Springfield", "Springfield Township", "PA"], ["City of Salem", "Salem Heights", "OR"]];
  for (const [a, b, st] of same) assert.equal(CP.sameJurisdictionName(a, b, st), true, `${a} / ${b}`);
  for (const [a, b, st] of different) assert.equal(CP.sameJurisdictionName(a, b, st), false, `${a} / ${b}`);
});

await check("MUST EXCLUDE (Portland-shaped): a 'City of Portland' correction is blocked_verified against the verified bare 'Portland' row; reads stay verified with the amendment; no row is created", async () => {
  CP.saveVerifiedCodeProfile(db, {
    key: "", state: "OR", ahj: "Portland", confidence: "verified",
    adoptedCodes: [{ code: "ORSC", edition: "2023" }], amendments: [{ code: "AHJ", summary: "Portland solar worksheet applies" }], designCriteria: {}, prescriptive: {},
    fireSetbacks: [], citations: [], updatedAt: "",
  }, "reference-seed");
  assert.equal(CP.getCodeProfile(db, { state: "OR", ahj: "City of Portland" })!.confidence, "verified", "fixture precondition: reads resolve to the verified bare-name row");
  const pid = mkProject("City of Portland");
  const cid = R.addManualCorrection(db, pid, "Ground snow load shall be 25 psf.").corrections[0].id;
  const j = itemPayload(pid, cid)!.jurisdictionProposals;
  assert.equal(j.length, 1);
  assert.equal(j[0].status, "blocked_verified", JSON.stringify(j[0]));
  assert.equal(j[0].profileKey, CP.codeProfileKey({ state: "OR", ahj: "Portland" }), "the card must name the verified row that governs");
  assert.match(String(j[0].statusNote), /human-verified profile "Portland"/);
  assert.equal(applyJurisdictionProposals(db, cid, undefined, "op").attempted, 0);
  // A forced apply (a stale or hand-edited "proposed") is refused by the writer itself.
  const forced = CP.applyCorrectionCriterionToProfile(db, { ...j[0], status: "proposed", profileKey: "", targetProfileKey: CP.codeProfileKey({ state: "OR", ahj: "City of Portland" }) }, { actor: "op", projectId: pid });
  assert.equal(forced.status, "refused", forced.note);
  assert.equal(CP.exactCodeProfileRow(db, "OR", "City of Portland"), null, "a seeded row was created that shadows the verified one");
  const after = CP.getCodeProfile(db, { state: "OR", ahj: "City of Portland" })!;
  assert.equal(after.confidence, "verified");
  assert.equal(after.amendments.length, 1, "the verified amendment was dropped from reads");
  assert.equal(CP.resolveEffectiveCodeContext(db, "OR", "City of Portland").verified, true);
  // The lookup's merge and its queueing refuse the same way (never a row that outranks verified).
  const merged = await CP.runDesignCriteriaResearch(db, { state: "OR", ahj: "City of Portland" }, fakeProvider({
    provider: "claude", webGrounded: true, notes: "", values: [{ criterion: "groundSnowLoadPsf", value: 25, sourceUrl: "https://portland.example.gov/d", quote: "ground snow load 25 psf" }],
  }));
  assert.equal(merged.saved, false);
  assert.equal(CP.exactCodeProfileRow(db, "OR", "City of Portland"), null, "the lookup created a shadowing row");
  // Full research / an import under the project's spelling (POST /api/code-profiles/research, a
  // code_research job) is refused the same way.
  CP.saveResearchedCodeProfile(db, { key: "", state: "OR", ahj: "City of Portland", confidence: "seeded", adoptedCodes: [{ code: "ORSC", edition: "2021" }], amendments: [], designCriteria: { groundSnowLoadPsf: 25 }, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "" });
  assert.equal(CP.exactCodeProfileRow(db, "OR", "City of Portland"), null, "a research save created a shadowing row");
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-called";
  CP.setDesignResearchEnqueuerForTests((_d, payload) => { enqueued.push(payload); });
  try {
    CP.resetResearchMarkersForTests();
    assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Portland"), 0, "a lookup was queued against a verified row");
    assert.equal(enqueued.length, 0);
  } finally { delete process.env.ANTHROPIC_API_KEY; CP.setDesignResearchEnqueuerForTests(null); }
});

await check("MUST PASS (TX/WA/FL bare-name import rows): 'City of X' writes the imported 'X' row, keeping its amendments; no second row", async () => {
  const importRow = (state: string, ahj: string) => CP.saveResearchedCodeProfile(db, {
    key: "", state, ahj, confidence: "seeded", adoptedCodes: [{ code: "IRC", edition: "2021" }],
    amendments: [{ code: "AHJ", summary: "Structural stamp required: Yes" }, { code: "AHJ", summary: "Electrical stamp required: Yes" }, { code: "AHJ", summary: "Stamp notes: wet stamp" }],
    designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [{ label: "Operator stamp-requirements list (Stamp Summary)", sourceUrl: "" }], updatedAt: "",
  });
  importRow("TX", "Testplano");
  importRow("WA", "Testattle");
  importRow("FL", "Testmiami");
  // Reads layer the (reference-seeded) state row under the AHJ row: compare the layered view before/after.
  const readAmend = (st: string, a: string): number => CP.getCodeProfile(db, { state: st, ahj: a })!.amendments.length;
  const txBefore = readAmend("TX", "City of Testplano");
  const flBefore = readAmend("FL", "City of Testmiami");
  // TX: an AHJ correction, applied by a human.
  const pid = mkProjectIn("TX", "City of Testplano");
  const cid = R.addManualCorrection(db, pid, "Design wind speed shall be 115 mph, Exposure C.").corrections[0].id;
  const j = itemPayload(pid, cid)!.jurisdictionProposals;
  assert.deepEqual(asMap(j), { windSpeedMph: 115, windExposure: "C" });
  for (const x of j) {
    assert.equal(x.status, "proposed");
    assert.equal(x.profileKey, CP.codeProfileKey({ state: "TX", ahj: "Testplano" }), "the proposal did not aim at the imported row");
    assert.equal(x.nearestOtherRow, undefined, "the card called the SAME jurisdiction's row 'not changed'");
  }
  assert.equal(applyJurisdictionProposals(db, cid, undefined, "op").applied.length, 2);
  const tx = CP.exactCodeProfileRow(db, "TX", "Testplano")!;
  assert.equal(tx.profile.designCriteria.windSpeedMph, 115);
  assert.equal(tx.profile.amendments.length, 3, "the imported amendments were dropped");
  assert.equal(CP.exactCodeProfileRow(db, "TX", "City of Testplano"), null, "a second row forked the jurisdiction");
  assert.equal(readAmend("TX", "City of Testplano"), txBefore, "reads lost amendments");
  // FL: the same through another criterion.
  const pf = mkProjectIn("FL", "City of Testmiami");
  const cf = R.addManualCorrection(db, pf, "Exposure D is required.").corrections[0].id;
  assert.equal(applyJurisdictionProposals(db, cf, undefined, "op").applied.length, 1);
  assert.equal(CP.exactCodeProfileRow(db, "FL", "Testmiami")!.profile.designCriteria.windExposure, "D");
  assert.equal(CP.exactCodeProfileRow(db, "FL", "City of Testmiami"), null);
  assert.equal(readAmend("FL", "City of Testmiami"), flBefore, "reads lost amendments");
  // WA: the design-criteria LOOKUP's merge lands on the imported row too.
  const r = await CP.runDesignCriteriaResearch(db, { state: "WA", ahj: "City of Testattle" }, fakeProvider({
    provider: "claude", webGrounded: true, notes: "", values: [{ criterion: "groundSnowLoadPsf", value: 25, sourceUrl: "https://testattle.example.gov/d", quote: "ground snow load 25 psf" }],
  }));
  assert.equal(r.saved, true, JSON.stringify(r));
  assert.equal(r.profileKey, CP.codeProfileKey({ state: "WA", ahj: "Testattle" }));
  assert.equal(CP.exactCodeProfileRow(db, "WA", "City of Testattle"), null, "the lookup forked the jurisdiction");
  assert.equal(CP.exactCodeProfileRow(db, "WA", "Testattle")!.profile.amendments.length, 3);
  // Full code research is not queued under the project's spelling (its save would create the fork).
  CP.resetResearchMarkersForTests();
  CP.ensureCodeProfilesResearched(db, "TX", "City of Testplano");
  assert.equal(CP.researchQueuedForTests().includes(CP.codeProfileKey({ state: "TX", ahj: "City of Testplano" })), false, "research queued under the forking key");
});

await check("a VERIFIED STATE layer's field is never overridden by a seeded AHJ value; the AHJ's other criteria still apply", () => {
  CP.saveVerifiedCodeProfile(db, {
    key: "", state: "ID", ahj: "", confidence: "verified", adoptedCodes: [{ code: "IRC", edition: "2018" }], amendments: [],
    designCriteria: {}, prescriptive: { maxAttachmentSpacingIn: 48 }, fireSetbacks: [], citations: [], updatedAt: "",
  }, "tester");
  const pid = mkProjectIn("ID", "City of Testboise");
  const cid = R.addManualCorrection(db, pid, "Attachment spacing shall not exceed 6' o.c. Ground snow load shall be 20 psf.").corrections[0].id;
  const j = itemPayload(pid, cid)!.jurisdictionProposals;
  assert.equal(j.find((x) => x.criterion === "maxAttachmentSpacingIn")?.status, "blocked_verified", JSON.stringify(j));
  assert.equal(j.find((x) => x.criterion === "groundSnowLoadPsf")?.status, "proposed");
  assert.equal(applyJurisdictionProposals(db, cid, undefined, "op").applied.length, 1);
  const row = CP.exactCodeProfileRow(db, "ID", "City of Testboise")!;
  assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 20);
  assert.equal(row.profile.prescriptive.maxAttachmentSpacingIn, undefined, "a seeded AHJ value overrode the verified state field");
  assert.equal(CP.getCodeProfile(db, { state: "ID", ahj: "City of Testboise" })!.prescriptive.maxAttachmentSpacingIn, 48);
});

await check("RESEARCH IS PER FIELD: a row created by an applied proposal does not stop adopted-code research for that AHJ", () => {
  // OREGON ADOPTS EVERY FAMILY UNIFORMLY (ORS 455.040; the shipped reference layer): City of
  // Testcoast — whose row was created above by applying B, design criteria only — reads the state's
  // editions, so its codes are NOT researched city by city (B3). Its design criteria still are.
  CP.resetResearchMarkersForTests();
  const row = CP.exactCodeProfileRow(db, "OR", "City of Testcoast")!;
  assert.equal(row.profile.adoptedCodes.length, 0, "fixture precondition");
  assert.equal(CP.codeResearchDecision(db, "OR", "City of Testcoast").reason, "inherits_state");
  CP.ensureCodeProfilesResearched(db, "OR", "City of Testcoast");
  assert.equal(CP.researchQueuedForTests().includes(row.key), false, "an Oregon city's codes were researched although the state adopts them uniformly");
  // In a LOCAL-ADOPTION state (Texas adopts no residential code for its cities) the same shape of
  // row — criteria from an applied correction, no codes — IS researched, for the local families.
  const txSeeded = (ahj: string, over: Partial<JurisdictionCodeProfile>) => CP.saveResearchedCodeProfile(db, {
    key: "", state: "TX", ahj, confidence: "seeded", adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {},
    fireSetbacks: [], citations: [], updatedAt: "", ...over,
  });
  txSeeded("City of Testcoastal", { designCriteria: { windSpeedMph: 115 }, citations: [CP.sharedCorrectionCitation("designCriteria.windSpeedMph", 115, "2026-09-01")] });
  CP.resetResearchMarkersForTests();
  CP.ensureCodeProfilesResearched(db, "TX", "City of Testcoastal");
  const txKey = CP.codeProfileKey({ state: "TX", ahj: "City of Testcoastal" });
  assert.equal(CP.researchQueuedForTests().includes(txKey), true, "adopted-code research was not queued for an AHJ whose row has no codes");
  assert.ok(CP.codeResearchDecision(db, "TX", "City of Testcoastal").families?.includes("residential"), "a TX city's research is not scoped to its local families");
  // Control: a row WITH web-grounded research codes (fresh) is not re-researched.
  txSeeded("City of Testbayou", {
    adoptedCodes: [{ family: "residential", code: "IRC", edition: "2021", sourceUrl: "https://testbayou.example.gov/codes" }],
    researchProvenance: { webGrounded: true, method: "web_search", at: new Date().toISOString(), searches: 3, groundedSearches: 3 },
  });
  CP.resetResearchMarkersForTests();
  CP.ensureCodeProfilesResearched(db, "TX", "City of Testbayou");
  assert.equal(CP.researchQueuedForTests().includes(CP.codeProfileKey({ state: "TX", ahj: "City of Testbayou" })), false, "a researched row was re-queued");
  // An operator IMPORT row with no codes (production: 559 of 578 rows, the Stamp Summary import —
  // amendments + its own citation) IS researched now: the research save MERGES and keeps the stamp
  // notes (codeEditionResearch.test.ts pins the merge).
  txSeeded("City of Stampville", { amendments: [{ code: "AHJ", summary: "Structural stamp required: Yes" }], citations: [{ label: "Operator stamp-requirements list (Stamp Summary)", sourceUrl: "" }] });
  CP.resetResearchMarkersForTests();
  CP.ensureCodeProfilesResearched(db, "TX", "City of Stampville");
  assert.equal(CP.researchQueuedForTests().includes(CP.codeProfileKey({ state: "TX", ahj: "City of Stampville" })), true, "a stamp-import row with no codes was never researched");
});

await check("research re-saves keep what the lookup filled when the research is silent on it (fills blanks, never erases)", () => {
  seeded("City of Keepton", { adoptedCodes: [], designCriteria: { groundSnowLoadPsf: 30 }, citations: [
    { label: "Design criteria lookup: groundSnowLoadPsf = 30", sourceUrl: "https://keepton.example.gov/d", kind: "design_criteria_research", field: "designCriteria.groundSnowLoadPsf", at: "2026-09-01" },
  ] });
  seeded("City of Keepton", { designCriteria: { windSpeedMph: 100 } }); // full research lands, silent on snow
  const row = ownRow("City of Keepton")!;
  assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 30, "research erased a cited lookup value");
  assert.equal(row.profile.designCriteria.windSpeedMph, 100);
  seeded("City of Keepton", { designCriteria: { groundSnowLoadPsf: 25 } }); // research that DOES state it wins
  assert.equal(ownRow("City of Keepton")!.profile.designCriteria.groundSnowLoadPsf, 25);
});

await check("MUST EXCLUDE: a utility correction and a learning-excluded project teach no jurisdiction", () => {
  const pid = mkProject("City of Utilitytown");
  const cid = R.addManualCorrection(db, pid, "Ground snow load 36 psf.", "utility_email").corrections[0].id;
  assert.equal(itemPayload(pid, cid)!.jurisdictionProposals.length, 0);
  const demo = mkProject("City of Demoville", {}, true);
  const did = R.addManualCorrection(db, demo, "Ground snow load 36 psf.").corrections[0].id;
  assert.equal(itemPayload(demo, did)!.jurisdictionProposals.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 2. APPROVED DESIGNS ARE CORROBORATION, NOT THE RULE.
// ─────────────────────────────────────────────────────────────────────────────────────────
const page = (status: string): string =>
  `Record 187-26-000777-STR: Residential Structural Record Status: ${status} Expiration Date: 03/16/2027 Record Info Processing Status`;
const mkTarget = (pid: string, jurisdiction: string, targetType = "permit", permitType = targetType === "nem" ? "nem" : "building"): string => {
  const detail = R.createPermitCheckTarget(db, pid, {
    jurisdiction, portalName: "Test ePermitting", portalUrl: "https://permits.example.test/cap",
    applicationNumber: "187-26-000777-STR", permitType, targetType,
  } as never) as never as { permitCheckTargets: Array<{ id: string; targetType?: string }> };
  return String(detail.permitCheckTargets[detail.permitCheckTargets.length - 1].id);
};
// The reviewer's comment sits on its own line under the page's record header.
const COMMENT = "\nGround snow load shall be 36 psf.";
await check("MONITOR intake: an 'Addl Info Needed' reading's text is proposed for the TARGET's jurisdiction, with its record", async () => {
  const pid = mkProject("City of Monitorbay");
  const tid = mkTarget(pid, "Monitor County");
  db.run("UPDATE permit_check_targets SET application_number = '187-26-000888-STR' WHERE id = ?", [tid]);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review") });
  // The page does NOT print the record number: the target comes from the check, not the text.
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url",
    rawStatusText: page("In Review/Addl Info Needed").replace("Record 187-26-000777-STR: ", "") + COMMENT });
  const cid = String(db.get<{ id: string }>("SELECT id FROM corrections WHERE project_id = ?", [pid])?.id ?? "");
  assert.ok(cid, "the monitor raised no correction (fixture precondition)");
  const j = itemPayload(pid, cid)!.jurisdictionProposals;
  assert.deepEqual(asMap(j), { groundSnowLoadPsf: 36 });
  assert.equal(j[0].ahj, "Monitor County");
  assert.equal(j[0].source.recordNumber, "187-26-000888-STR");
  // The triage rewrite rebuilds from the CHECK ROW's target, to the same answer.
  db.run("UPDATE human_review_items SET notes = ? WHERE project_id = ? AND field_name = 'correction'",
    [`agent-triage:${JSON.stringify({ correctionId: cid, proposals: [], actions: [] })}`, pid]);
  persistTriage(db, { correctionId: cid, projectId: pid }, { actions: [], proposals: [] });
  assert.equal(itemPayload(pid, cid)!.jurisdictionProposals[0]?.ahj, "Monitor County");
});

await check("MUST EXCLUDE (rule 5): a NEM target's correction — its page NOT printing the application number — proposes nothing for the building AHJ", async () => {
  const pid = mkProject("City of Nembay");
  // Named unlike the project's utility on purpose: the NEM type alone must exclude it.
  const tid = mkTarget(pid, "Coastal Interconnection Desk", "nem");
  db.run("UPDATE permit_check_targets SET application_number = 'APP-222222' WHERE id = ?", [tid]);
  const nemPage = (status: string) => `Interconnection Application Status: ${status} Utility review queue`;
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: nemPage("In Review") });
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: nemPage("In Review/Addl Info Needed") + COMMENT + "\nWind exposure D is required." });
  const cid = String(db.get<{ id: string }>("SELECT id FROM corrections WHERE project_id = ?", [pid])?.id ?? "");
  assert.ok(cid, "the monitor raised no correction (fixture precondition)");
  assert.equal(itemPayload(pid, cid)!.jurisdictionProposals.length, 0, "a utility's correction taught the building AHJ");
  assert.equal(CP.exactCodeProfileRow(db, "OR", "City of Nembay"), null);
  // The rebuild path (triage rewrite) must reach the same answer from the check row.
  persistTriage(db, { correctionId: cid, projectId: pid }, { actions: [], proposals: [] });
  assert.equal(itemPayload(pid, cid)!.jurisdictionProposals.length, 0, "the triage rebuild taught the building AHJ");
});

await check("MUST EXCLUDE: a permit-typed target whose 'jurisdiction' is the project's UTILITY teaches nothing; an EMAIL reading's assigned target teaches nothing", async () => {
  const pid = mkProject("City of Oddtarget");
  const tid = mkTarget(pid, "Test Power"); // target_type permit, jurisdiction = the utility (production oddity)
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review") });
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review/Addl Info Needed") + COMMENT });
  const cid = String(db.get<{ id: string }>("SELECT id FROM corrections WHERE project_id = ?", [pid])?.id ?? "");
  assert.ok(cid, "fixture precondition");
  assert.equal(itemPayload(pid, cid)!.jurisdictionProposals.length, 0);
  const pe = mkProject("City of Emailtown");
  const te = mkTarget(pe, "City of Emailtown");
  await R.recordPermitStatusCheck(db, pe, { targetId: te, source: "email", rawStatusText: "Email bucket: permit\nStatus: Addl Info Needed\nCorrections required." + COMMENT });
  const ce = String(db.get<{ id: string }>("SELECT id FROM corrections WHERE project_id = ?", [pe])?.id ?? "");
  assert.ok(ce, "fixture precondition: the email raised a correction");
  assert.equal(itemPayload(pe, ce)!.jurisdictionProposals.length, 0, "an email's tracker-assigned target was trusted");
  // Control: the SAME comment on a real permit target, read on its portal, does propose.
  const pc = mkProject("City of Controlton");
  const tc = mkTarget(pc, "City of Controlton");
  await R.recordPermitStatusCheck(db, pc, { targetId: tc, source: "public_url", rawStatusText: page("In Review") });
  await R.recordPermitStatusCheck(db, pc, { targetId: tc, source: "public_url", rawStatusText: page("In Review/Addl Info Needed") + COMMENT });
  const cc = String(db.get<{ id: string }>("SELECT id FROM corrections WHERE project_id = ?", [pc])?.id ?? "");
  assert.equal(itemPayload(pc, cc)!.jurisdictionProposals.length, 1);
});

// r3r caveat (a): WHERE a text came from decides whether its bare "label value" lines count — not a
// list of words a status page might use. These pages carry NONE of the STATUS_PAGE markers (no
// "Record Status", no "Status:", no "Application Information"), so only the source can catch them.
const unmarkedPages = [
  "Record 187-26-000309-STR: Residential Structural. Addl Info Needed. Record Details. Wind Speed 120 mph Exposure C. Snow Load 16 psf.",
  "Permit 2026-0001. Additional Information Required. Project Details. Wind Speed 115 mph. Exposure C. Ground Snow Load 16 psf.",
];
await check("MUST EXCLUDE (r3r): a MONITOR reading whose page prints the application's criteria bare proposes nothing, whatever the page calls itself; the triage rebuild agrees", async () => {
  for (const [i, text] of unmarkedPages.entries()) {
    assert.ok(extractAhjRequiredCriteria(text).length > 0, "fixture precondition: the words alone read as bare statements");
    const pid = mkProject(`City of Scrapeton${i}`);
    const tid = mkTarget(pid, `City of Scrapeton${i}`);
    await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review") });
    await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: text });
    const cid = String(db.get<{ id: string }>("SELECT id FROM corrections WHERE project_id = ?", [pid])?.id ?? "");
    assert.ok(cid, "fixture precondition: the monitor raised a correction");
    assert.deepEqual(itemPayload(pid, cid)!.jurisdictionProposals.map((p) => [p.criterion, p.value]), [], `a scraped page's own fields were proposed: ${text}`);
    persistTriage(db, { correctionId: cid, projectId: pid }, { actions: [], proposals: [] });
    assert.deepEqual(itemPayload(pid, cid)!.jurisdictionProposals.map((p) => [p.criterion, p.value]), [], "the triage rebuild proposed the page's fields");
  }
});

await check("MUST PASS (r3r): the SAME page with a CUED reviewer comment proposes the comment's value; the same bare line PASTED by a person still proposes", async () => {
  const pid = mkProject("City of Scrapecue");
  const tid = mkTarget(pid, "City of Scrapecue");
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review") });
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: unmarkedPages[0].replace("Snow Load 16 psf.", "") + COMMENT });
  const cid = String(db.get<{ id: string }>("SELECT id FROM corrections WHERE project_id = ?", [pid])?.id ?? "");
  assert.deepEqual(asMap(itemPayload(pid, cid)!.jurisdictionProposals), { groundSnowLoadPsf: 36 });
  const pp = mkProject("City of Pasteton");
  const cp = R.addManualCorrection(db, pp, "Wind Speed 120 mph Exposure C.").corrections[0].id;
  assert.deepEqual(asMap(itemPayload(pp, cp)!.jurisdictionProposals), { windSpeedMph: 120, windExposure: "C" });
});

const obsCount = (ahj: string): number => Number(db.get<{ n: number }>(
  "SELECT COUNT(*) AS n FROM jurisdiction_design_observations WHERE ahj = ?", [ahj])?.n ?? 0);

seeded("City of Approvedville");
const pidI = mkProject("City of Approvedville", { snow: "25", windSpeed: "120", wind: "C" });
const tidI = mkTarget(pidI, "City of Approvedville");

await check("the FIRST issued reading records an observation; designCriteria is unchanged; a re-read adds nothing", async () => {
  await R.recordPermitStatusCheck(db, pidI, { targetId: tidI, source: "public_url", rawStatusText: page("In Review") });
  assert.equal(obsCount("City of Approvedville"), 0, "an in-review reading recorded an approved design");
  await R.recordPermitStatusCheck(db, pidI, { targetId: tidI, source: "public_url", rawStatusText: page("Issued") });
  assert.equal(obsCount("City of Approvedville"), 1);
  await R.recordPermitStatusCheck(db, pidI, { targetId: tidI, source: "public_url", rawStatusText: page("Issued") });
  assert.equal(obsCount("City of Approvedville"), 1);
  assert.deepEqual(ownRow("City of Approvedville")!.profile.designCriteria, {}, "an approved design was written into the AHJ's rule");
  const obs = CP.listApprovedDesignObservations(db, "OR", "City of Approvedville");
  assert.equal(obs[0].recordNumber, "187-26-000777-STR");
  assert.ok(obs[0].criteria.some((c) => c.criterion === "groundSnowPsf" && c.value === 25));
});

await check("MUST EXCLUDE: an ELECTRICAL permit reading Issued records NO approved-design observation (it reviewed no structure)", async () => {
  const pid = mkProject("City of Elecville", { snow: "16", windSpeed: "120", wind: "C" });
  const tid = mkTarget(pid, "City of Elecville", "permit", "electrical");
  assert.equal(String(db.get<{ t: string }>("SELECT permit_type AS t FROM permit_check_targets WHERE id = ?", [tid])?.t), "electrical", "fixture precondition");
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review") });
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("Issued") });
  assert.equal(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jurisdiction_design_observations WHERE project_id = ?", [pid])?.n ?? 0), 0);
  // A blank / legacy permit type is unknown — never corroboration either.
  const p2 = mkProject("City of Blanktype", { snow: "16" });
  const t2 = mkTarget(p2, "City of Blanktype", "permit", "");
  db.run("UPDATE permit_check_targets SET permit_type = '' WHERE id = ?", [t2]);
  await R.recordPermitStatusCheck(db, p2, { targetId: t2, source: "public_url", rawStatusText: page("In Review") });
  await R.recordPermitStatusCheck(db, p2, { targetId: t2, source: "public_url", rawStatusText: page("Issued") });
  assert.equal(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jurisdiction_design_observations WHERE project_id = ?", [p2])?.n ?? 0), 0);
  // Control: a STRUCTURAL permit does record.
  const p3 = mkProject("City of Structville", { snow: "25" });
  const t3 = mkTarget(p3, "City of Structville", "permit", "structural");
  await R.recordPermitStatusCheck(db, p3, { targetId: t3, source: "public_url", rawStatusText: page("In Review") });
  await R.recordPermitStatusCheck(db, p3, { targetId: t3, source: "public_url", rawStatusText: page("Issued") });
  assert.equal(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jurisdiction_design_observations WHERE project_id = ?", [p3])?.n ?? 0), 1);
});

await check("MUST EXCLUDE: a utility (NEM) target's approval records no building observation", async () => {
  const pid = mkProject("City of Nemtown", { snow: "25", windSpeed: "120" });
  const tid = mkTarget(pid, "Test Power", "nem");
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review") });
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("Issued") });
  assert.equal(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jurisdiction_design_observations WHERE project_id = ?", [pid])?.n ?? 0), 0);
});

await check("the unknown finding quotes approved designs; a value a LATER AHJ correction contradicted is not counted", () => {
  const ctx = CP.resolveEffectiveCodeContext(db, "OR", "City of Approvedville");
  const probe = R.getProjectDetail(db, pidI).project;
  const unknown = evaluateDesignCriteriaFindings(probe, ctx, { roofMounted: true }).find((f) => f.id === "city.struct.design-criteria-unknown");
  assert.ok(unknown, "no unknown finding");
  assert.match(unknown!.message, /Approved designs used: ground snow 25 psf \(1 issued permit/);
  assert.doesNotMatch(unknown!.message, /187-26-000777-STR/, "a record number reached pooled finding text");
  // The shared list (GET /api/code-profiles) carries the AGGREGATE only — never a project id or record.
  const listed = CP.listCodeProfiles(db).find((p) => p.ahj === "City of Approvedville")!;
  assert.ok(listed.approvedDesignSummary?.some((o) => o.criterion === "groundSnowPsf" && o.value === 25 && o.count === 1));
  assert.doesNotMatch(JSON.stringify(listed.approvedDesignSummary), new RegExp(`187-26-000777-STR|${pidI}`), "a project id / record reached the shared list");
  // The AHJ later says 36 (a correction applied after that permit issued): 25 no longer counts.
  const cid = R.addManualCorrection(db, pidI, "Ground snow load 36 psf.").corrections[0].id;
  db.run("UPDATE corrections SET created_at = ? WHERE id = ?", ["2999-01-01T00:00:00.000Z", cid]);
  const row = db.query<{ id: string; notes: string }>("SELECT id, notes FROM human_review_items WHERE project_id = ? AND field_name = 'correction'", [pidI])
    .find((r) => parseCorrectionProposals(r.notes)?.correctionId === cid)!;
  const payload = JSON.parse(row.notes.slice(13));
  payload.jurisdictionProposals = payload.jurisdictionProposals.map((p: { source: Record<string, string> }) => ({ ...p, source: { ...p.source, receivedAt: "2999-01-01T00:00:00.000Z" } }));
  db.run("UPDATE human_review_items SET notes = ? WHERE id = ?", [`agent-triage:${JSON.stringify(payload)}`, row.id]);
  assert.equal(applyJurisdictionProposals(db, cid, undefined, "op").applied.length, 1);
  const after = CP.resolveEffectiveCodeContext(db, "OR", "City of Approvedville");
  const below = evaluateDesignCriteriaFindings(probe, after, { roofMounted: true }).find((f) => f.id === "city.struct.design-criteria-below-ahj");
  assert.ok(below, "no below-ahj finding after the AHJ value landed");
  assert.match(below!.message, /contradicted by a later AHJ correction/);
  assert.doesNotMatch(below!.message, /ground snow 25 psf \(/, "a contradicted approved value was still counted");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 3. LOOK IT UP AT THE AHJ — once, never when off, never to overwrite.
// ─────────────────────────────────────────────────────────────────────────────────────────
CP.setDesignResearchEnqueuerForTests((d, payload) => { enqueued.push(payload); enqueueJob(d, "design_criteria_research", payload, { priority: 3, maxRetries: 2 }); });

await check("keyless: no lookup is enqueued", () => {
  seeded("City of Lookupton");
  CP.resetResearchMarkersForTests();
  assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Lookupton"), 0);
  assert.equal(enqueued.length, 0);
});

await check("with a key: ONE lookup per AHJ (the review hook), deduped by the job row across restarts", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-called";
  try {
    CP.resetResearchMarkersForTests();
    CP.ensureCodeProfilesResearched(db, "OR", "City of Lookupton");
    CP.ensureCodeProfilesResearched(db, "OR", "City of Lookupton");
    assert.equal(enqueued.filter((p) => p.ahj === "City of Lookupton").length, 1);
    CP.resetResearchMarkersForTests(); // a restart: only the DB row remembers
    assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Lookupton"), 0, "re-queued within 30 days");
    assert.equal(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'design_criteria_research'")?.n ?? 0), 1);
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

await check("MUST EXCLUDE: switched off, offline, verified, or criteria already on file -> no lookup", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-called";
  try {
    seeded("City of Offton");
    CP.resetResearchMarkersForTests();
    process.env.CODE_RESEARCH = "off";
    assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Offton"), 0, "CODE_RESEARCH=off ignored");
    delete process.env.CODE_RESEARCH;
    process.env.PORTAL_AUTOSEED = "0";
    assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Offton"), 0, "offline switch ignored");
    delete process.env.PORTAL_AUTOSEED;
    assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Verifiedport"), 0, "a verified row was queued");
    seeded("City of Fullfile", { designCriteria: { groundSnowLoadPsf: 25, windSpeedMph: 110 } });
    assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Fullfile"), 0, "criteria on file, still queued");
    assert.equal(enqueued.filter((p) => ["City of Offton", "City of Verifiedport", "City of Fullfile"].includes(String(p.ahj))).length, 0);
    // Control: the same AHJ with every switch on DOES queue — the exclusions above are real.
    assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Offton"), 1);
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.CODE_RESEARCH; delete process.env.PORTAL_AUTOSEED; }
});


await check("the lookup fills BLANKS only, as seeded, with citations; web-grounded values only", async () => {
  seeded("City of Fillton", { designCriteria: { windSpeedMph: 110 } });
  const r = await CP.runDesignCriteriaResearch(db, { state: "OR", ahj: "City of Fillton" }, fakeProvider({
    provider: "claude", webGrounded: true, notes: "",
    values: [
      { criterion: "groundSnowLoadPsf", value: 30, sourceUrl: "https://fillton.example.gov/design", quote: "Ground snow load: 30 psf" },
      { criterion: "windSpeedMph", value: 140, sourceUrl: "https://fillton.example.gov/design" },
      { criterion: "windExposure", value: "C", sourceUrl: "" },
    ],
  }));
  const row = ownRow("City of Fillton")!;
  assert.equal(row.profile.confidence, "seeded");
  assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 30);
  assert.equal(row.profile.designCriteria.windSpeedMph, 110, "a value on file was overwritten by research");
  assert.equal(row.profile.designCriteria.windExposure, undefined, "an unsourced value was stored");
  assert.ok(row.profile.citations.some((c) => c.kind === "design_criteria_research" && c.sourceUrl === "https://fillton.example.gov/design"));
  assert.deepEqual(r.filled, ["groundSnowLoadPsf"]);
  const memory = await CP.runDesignCriteriaResearch(db, { state: "OR", ahj: "City of Lookupton" }, fakeProvider({
    provider: "claude", webGrounded: false, notes: "", values: [{ criterion: "groundSnowLoadPsf", value: 30, sourceUrl: "https://x.example.gov" }],
  }));
  assert.equal(memory.saved, false);
  assert.equal(ownRow("City of Lookupton")!.profile.designCriteria.groundSnowLoadPsf, undefined, "model memory was stored");
  const verified = await CP.runDesignCriteriaResearch(db, { state: "OR", ahj: "City of Verifiedport" }, fakeProvider({
    provider: "claude", webGrounded: true, notes: "", values: [{ criterion: "windSpeedMph", value: 140, sourceUrl: "https://v.example.gov" }],
  }));
  assert.equal(verified.saved, false);
  assert.equal(ownRow("City of Verifiedport")!.profile.designCriteria.windSpeedMph, undefined, "a verified row was filled");
});

// ─── MF5: the stored number is the one next to ITS OWN label; ranges and lists are not a value ──
const { parseDesignCriteriaLookup, ClaudeLLMProvider, DESIGN_LOOKUP_MAX_FETCHES, DESIGN_LOOKUP_MAX_PAGE_TOKENS } = await import("../src/llm");
const GOV = "https://www.testcity.example.gov/codes/r301";
const parsedValues = (o: Record<string, unknown>) => parseDesignCriteriaLookup(o, true).values.map((v) => `${v.criterion}=${v.value}${v.qualifier ? `/${v.qualifier}` : ""}`).sort();

await check("MUST EXCLUDE (lookup): the OTHER number of a two-number quote, a value inside a range or list, a site-conditional value, a non-official page", () => {
  const none: Array<Record<string, unknown>> = [
    { windSpeedMph: { value: 136, sourceUrl: GOV, quote: "Vult = 175 mph, Vasd = 136 mph" } },
    { groundSnowLoadPsf: { value: 25, sourceUrl: GOV, quote: "Roof snow load 25 psf; ground snow load 35 psf" } },
    { groundSnowLoadPsf: { value: 20, sourceUrl: GOV, quote: "Ground snow load 20-25 psf" } },
    { groundSnowLoadPsf: { value: 25, sourceUrl: GOV, quote: "Ground snow load 20-25 psf" } },
    { windSpeedMph: { value: 125, sourceUrl: GOV, quote: "Ultimate design wind speed 115/125/140 mph" } },
    { windExposure: { value: "C", sourceUrl: GOV, quote: "Wind exposure B or C" } },
    { groundSnowLoadPsf: { value: 25, sourceUrl: GOV, quote: "Ground snow load 25 psf below 3000 ft; site-specific above" } },
    { windSpeedMph: { value: 120, sourceUrl: "https://solar-installer-blog.example.com/wind", quote: "Vult 120 mph" } },
  ];
  for (const o of none) assert.deepEqual(parsedValues(o), [], JSON.stringify(o));
});

await check("MUST PASS (lookup): the labelled number of a two-number quote; a pg(asd) kept apart from Pg; an exposure named once; a code-publisher page", () => {
  assert.deepEqual(parsedValues({ windSpeedMph: { value: 175, sourceUrl: GOV, quote: "Vult = 175 mph, Vasd = 136 mph" } }), ["windSpeedMph=175"]);
  assert.deepEqual(parsedValues({ groundSnowLoadPsf: { value: 35, sourceUrl: GOV, quote: "Roof snow load 25 psf; ground snow load 35 psf" } }), ["groundSnowLoadPsf=35/pg"]);
  assert.deepEqual(parsedValues({
    groundSnowLoadPsf: { value: 49, sourceUrl: GOV, quote: "pg = 49 psf, pg(asd) = 35 psf" },
    groundSnowLoadAsdPsf: { value: 35, sourceUrl: GOV, quote: "pg = 49 psf, pg(asd) = 35 psf" },
  }), ["groundSnowLoadPsf=35/pg_asd", "groundSnowLoadPsf=49/pg"]);
  assert.deepEqual(parsedValues({ groundSnowLoadAsdPsf: { value: 49, sourceUrl: GOV, quote: "pg = 49 psf, pg(asd) = 35 psf" } }), [], "a strength Pg under the pg(asd) key was trusted");
  assert.deepEqual(parsedValues({ windExposure: { value: "C", sourceUrl: GOV, quote: "Exposure Category C" } }), ["windExposure=C"]);
  assert.deepEqual(parsedValues({ groundSnowLoadPsf: { value: 30, sourceUrl: "https://up.codes/viewer/testcity/irc-2021/chapter/3", quote: "Ground snow load 30 psf" } }), ["groundSnowLoadPsf=30/pg"]);
});

// r3r MUST-FIX 2: ".org" is not "official". Only a .org that is THIS jurisdiction's own site (its host
// names it) counts; a trade association, an encyclopedia and a hazard lookup tool never do.
const { isOfficialCodeSource } = await import("../src/llm");
const TESTCITY = { ahj: "City of Testcity", state: "OR" };
await check("MUST EXCLUDE (r3r): hazards.atcouncil.org, en.wikipedia.org, a trade-association .org blog, another name's .org — never an official source", () => {
  for (const url of [
    "https://hazards.atcouncil.org/#/wind?lat=45.5&lng=-122.6",
    "https://en.wikipedia.org/wiki/Testcity,_Oregon",
    "https://www.solarinstallersassociation.org/blog/oregon-wind",
    "https://snowload.seao.org/lookup.html",
    "https://www.testcityhealth.org/about", // CONTAINS the name, is not the city's site
    "https://www.othertown.org/building",
  ]) {
    assert.equal(isOfficialCodeSource(url, TESTCITY), false, url);
    const quote = "Ultimate design wind speed Vult 115 mph";
    assert.deepEqual(parseDesignCriteriaLookup({ windSpeedMph: { value: 115, sourceUrl: url, quote } }, true, false, TESTCITY).values, [], url);
  }
  // Without the jurisdiction no .org is anyone's own site (fails closed).
  assert.equal(isOfficialCodeSource("https://www.testcity.org/building", null), false);
  // The block list wins over a name match (a contrived jurisdiction whose name IS the tool's host).
  assert.equal(isOfficialCodeSource("https://hazards.atcouncil.org/#/snow", { ahj: "City of Atcouncil", state: "OR" }), false);
});

await check("MUST PASS (r3r): a city .gov page, up.codes, library.municode.com, codes.iccsafe.org, a county .us page, and the jurisdiction's OWN .org", () => {
  for (const url of [
    "https://www.testcity.example.gov/building/design-criteria",
    "https://up.codes/viewer/testcity/irc-2021/chapter/3",
    "https://library.municode.com/or/testcity/codes/code_of_ordinances",
    "https://codes.iccsafe.org/content/ORSC2023P1",
    "https://www.floridabuilding.org/bc/bc_default.aspx", // the state's own code site, on .org
    "https://testcity.municipal.codes/CC/Chapter9", // a publisher of the city's adopted code (cited in production)
    "https://www.co.testcounty.or.us/planning",
    "https://www.testcity.org/departments/building",
    "https://www.cityoftestcity.org/building",
  ]) assert.equal(isOfficialCodeSource(url, TESTCITY), true, url);
});

await check("the lookup hands ITS jurisdiction to the source check (stubbed client): the city's own .org value is kept, an association's .org is dropped", async () => {
  const provider = new ClaudeLLMProvider("sk-ant-test-never-called");
  const own = "https://www.testorgville.org/building/design-criteria";
  const reply = {
    content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "Testorgville Table R301.2" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: own, title: "Testorgville building" }] },
      { type: "text", text: JSON.stringify({
        groundSnowLoadPsf: { value: 30, sourceUrl: own, quote: "Ground snow load 30 psf" },
        windSpeedMph: { value: 115, sourceUrl: "https://www.solarinstallersassociation.org/blog/oregon-wind", quote: "Vult 115 mph" },
        notes: "",
      }) },
    ],
    usage: { input_tokens: 900, output_tokens: 100, server_tool_use: { web_search_requests: 1 } },
    stop_reason: "end_turn",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).client = { messages: { stream() { return { finalMessage: async () => reply }; } } };
  const out = await provider.researchDesignCriteria({ ahj: "City of Testorgville", state: "OR" });
  assert.deepEqual(out.values.map((v) => `${v.criterion}=${v.value}`), ["groundSnowLoadPsf=30"]);
  assert.match(out.notes, /windSpeedMph 115 \(source is not an official/);
});

await check("a pg(asd) lookup value is STORED (groundSnowLoadAsdPsf), never as the strength groundSnowLoadPsf; the job result carries the lookup's notes", async () => {
  seeded("City of Asdton");
  const r = await CP.runDesignCriteriaResearch(db, { state: "OR", ahj: "City of Asdton" }, fakeProvider({
    provider: "claude", webGrounded: true, notes: "Web-grounded lookup. Pages read: 1.",
    values: [{ criterion: "groundSnowLoadPsf", value: 43, qualifier: "pg_asd", sourceUrl: GOV, quote: "ground snow load is 43 psf (pg(asd))" }],
  }));
  const dc = ownRow("City of Asdton")!.profile.designCriteria;
  assert.equal(dc.groundSnowLoadAsdPsf, 43);
  assert.equal(dc.groundSnowLoadPsf, undefined, "a pg(asd) was stored as the strength Pg the rules compare with");
  assert.match(String(r.notes), /Pages read: 1/);
});

await check("THE PAGE FETCH (stubbed client): the lookup offers web_fetch capped per lookup and per page, reads the page, and the call lands in llm_calls", async () => {
  const provider = new ClaudeLLMProvider("sk-ant-test-never-called");
  let captured: { tools?: Array<Record<string, unknown>> } | null = null;
  const reply = {
    content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "Testcity Table R301.2" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: GOV, title: "Testcity codes" }] },
      { type: "server_tool_use", id: "f1", name: "web_fetch", input: { url: GOV } },
      { type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_result", url: GOV, content: { type: "document", source: { type: "text", media_type: "text/plain", data: "Table R301.2 Ground snow load 30 psf" } } } },
      { type: "text", text: JSON.stringify({ groundSnowLoadPsf: { value: 30, sourceUrl: GOV, quote: "Ground snow load 30 psf" }, notes: "" }) },
    ],
    usage: { input_tokens: 5123, output_tokens: 321, server_tool_use: { web_search_requests: 1, web_fetch_requests: 1 } },
    stop_reason: "end_turn",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).client = { messages: { stream(params: { tools?: Array<Record<string, unknown>> }) { captured = params; return { finalMessage: async () => reply }; } } };
  const before = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_calls WHERE label = 'researchDesignCriteria'")?.n ?? 0);
  const out = await provider.researchDesignCriteria({ ahj: "City of Testcity", state: "OR" });
  const tools = captured!.tools ?? [];
  assert.deepEqual(tools.map((t) => t.name), ["web_search", "web_fetch"]);
  const fetchTool = tools.find((t) => t.name === "web_fetch")!;
  assert.equal(fetchTool.type, "web_fetch_20260209");
  assert.equal(fetchTool.max_uses, DESIGN_LOOKUP_MAX_FETCHES);
  assert.equal(fetchTool.max_content_tokens, DESIGN_LOOKUP_MAX_PAGE_TOKENS);
  assert.ok(DESIGN_LOOKUP_MAX_FETCHES <= 5 && DESIGN_LOOKUP_MAX_PAGE_TOKENS <= 20000, "the fetch caps grew past the cost budget");
  assert.deepEqual(out.values.map((v) => `${v.criterion}=${v.value}/${v.qualifier}`), ["groundSnowLoadPsf=30/pg"]);
  assert.equal(out.webGrounded, true);
  assert.match(out.notes, /Pages read: 1/);
  const row = db.get<{ n: number; in_tok: number }>("SELECT COUNT(*) AS n, MAX(in_tok) AS in_tok FROM llm_calls WHERE label = 'researchDesignCriteria'");
  assert.equal(Number(row?.n) - before, 1, "the lookup's call was not recorded in llm_calls");
  assert.equal(Number(row?.in_tok), 5123, "the fetched page's input tokens were not recorded");
});

await check("MUST EXCLUDE: the other web-research calls are NOT given the page fetch", () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src", "llm.ts"), "utf8");
  const calls = [...src.matchAll(/this\.askWithWebSearch\(\s*"([A-Za-z]+)"[^\n]*/g)].map((m) => [m[1], /designLookupFetchTool\(\)/.test(m[0])] as const);
  assert.ok(calls.length >= 4, "fixture precondition: the research callers were found");
  for (const [label, hasFetch] of calls) assert.equal(hasFetch, label === "researchDesignCriteria", `${label}: page fetch ${hasFetch ? "offered" : "missing"}`);
});

await check("the job type is registered: a queued lookup runs keyless through the stub and stores nothing", async () => {
  CP.setDesignResearchEnqueuerForTests(null);
  db.run("UPDATE job_queue SET status = 'done' WHERE status IN ('pending','running')");
  enqueueJob(db, "design_criteria_research", { state: "OR", ahj: "City of Lookupton", profileKey: ownRow("City of Lookupton")!.key }, { priority: 3 });
  assert.equal(await processNextJob(db), true);
  const job = db.get<{ status: string; result: string }>("SELECT status, result FROM job_queue WHERE job_type = 'design_criteria_research' ORDER BY created_at DESC LIMIT 1")!;
  assert.equal(job.status, "done", job.result);
  assert.match(job.result, /stub/);
  assert.doesNotMatch(job.result, /handled externally/);
});

console.log(failures === 0 ? "\njurisdictionCriteriaLearning: all checks passed" : `\njurisdictionCriteriaLearning: ${failures} FAILED`);
try { db.close(); } catch { /* ignore */ }
process.exit(failures === 0 ? 0 : 1);
