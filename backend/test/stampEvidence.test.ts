// A SENTENCE SAYING THE SEAL BOX IS BLANK WAS READ AS EVIDENCE OF A SEAL.
//
// Real filing, caught by the operator: Coos Bay structural permit 187-26-000309-STR (1780 Ocean
// Blvd SE) went into PLAN REVIEW because it needed stamps. The system had already read the plan
// set and written down, in plain English:
//
//   "No PE stamp/seal shown (title block 'Signature with Seal' is blank); AHJ may require
//    stamped structural for 2x4 @16" rafters..."
//
// It then filed anyway, because hasStampedStructuralEvidence keyword-searches a blob that
// INCLUDES that sentence:
//
//   hasStamp   /\b(...|stamped|...)/         matches "stamped" in "may require stamped structural"
//   onlyNeeds  /(no stamp|stamp (?:is )?(?:not|missing|...))/   does NOT match "No PE stamp"
//
// The negation guard wanted the words "no stamp" adjacent. The text says "No PE stamp". Two
// characters — "PE" — turned a statement of ABSENCE into evidence of PRESENCE, and
// requiredDocuments then counted the PE-stamped-structural-letter requirement as satisfied "via
// stamp in plan set" and let the filing through.
//
// This is the same shape as the other misreads in this codebase: a filter whose negative case is
// narrower than the language people actually write.
//
//   MUST REFUSE  — every real way a parser says a seal is absent, including the verbatim
//                  sentence above.
//   MUST KEEP    — genuine stamp evidence. A guard that eats real stamps sends every engineered
//                  project back for a document it already has.
//
//   npx tsx backend/test/stampEvidence.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-evidence-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { hasStampedStructuralEvidence } = await import("../src/permitPath");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const withStamp = (text: string) => ({ parserSnapshot: { stampRecommendation: text } }) as never;
const withCalcs = (text: string) => ({ parserSnapshot: { structuralCalcText: text } }) as never;

// The verbatim sentence from the live database, plus the ways a parser phrases the same fact.
const ABSENT = [
  "No PE stamp/seal shown (title block 'Signature with Seal' is blank); AHJ may require stamped structural for 2x4 @16\" rafters",
  "No PE stamp shown on the structural sheets.",
  "No engineer's seal shown; the signature block is blank.",
  "Title block 'Signature with Seal' is blank.",
  "Structural sheets are unsigned — no seal present.",
  "The stamp area is empty; a stamped structural letter may be required.",
  "Plan set does not appear to be stamped.",
  "No wet stamp visible on S-1.1.",
];

check("THE HEADLINE: the verbatim live sentence is NOT read as evidence of a stamp", () => {
  assert.equal(hasStampedStructuralEvidence(withStamp(ABSENT[0])), false,
    "this exact sentence let 187-26-000309-STR file without stamps and land in plan review");
});

check("MUST REFUSE: every way a parser says the seal is absent", () => {
  const wrong = ABSENT.filter((t) => hasStampedStructuralEvidence(withStamp(t)));
  assert.deepEqual(wrong, [], `read as PROOF OF A STAMP: ${JSON.stringify(wrong, null, 1)}`);
});

check("...and the same sentences in the structural-calcs field, not just the recommendation", () => {
  const wrong = ABSENT.filter((t) => hasStampedStructuralEvidence(withCalcs(t)));
  assert.deepEqual(wrong, [], `read as PROOF OF A STAMP: ${JSON.stringify(wrong, null, 1)}`);
});

// A guard that eats real evidence is worse than the gap it closes: every engineered project
// would be sent back for a letter that is already in the plan set.
const PRESENT = [
  "Structural sheets are PE stamped and sealed by the engineer of record.",
  "Wet stamp present on S-1.1 with the engineer's seal.",
  "Sealed by Jane Roe, PE, Oregon #12345.",
  "Stamped structural calcs included in the plan set.",
  "Engineer of record: Roe Engineering; structural letter attached.",
];

check("MUST KEEP: genuine stamp evidence still counts", () => {
  const eaten = PRESENT.filter((t) => !hasStampedStructuralEvidence(withStamp(t)));
  assert.deepEqual(eaten, [], `real stamp evidence was refused: ${JSON.stringify(eaten, null, 1)}`);
});

check("MUST REFUSE: an empty or absent snapshot is not evidence", () => {
  assert.equal(hasStampedStructuralEvidence({ parserSnapshot: {} } as never), false);
  assert.equal(hasStampedStructuralEvidence({} as never), false);
});

check("THE TRAP THAT CAUSED IT: absence and the word 'stamped' in ONE sentence", () => {
  // The live sentence both denies a stamp AND contains "stamped", because it goes on to say a
  // stamped structural MAY BE REQUIRED. Any rule that just looks for the word loses here, so the
  // denial has to win over the mention.
  assert.equal(hasStampedStructuralEvidence(withStamp(
    "No PE stamp/seal shown; AHJ may require stamped structural plans and a sealed letter.")), false,
    "the denial must outrank the word 'stamped' appearing later in the same sentence");
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nstampEvidence: all checks passed."
  : `\nstampEvidence: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
