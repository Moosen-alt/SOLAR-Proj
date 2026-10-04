// "THE LETTER WAS NOT SUPPLIED" WAS READ AS EVIDENCE THE LETTER EXISTS.
//
// Twice. Same defect, two AHJs, two missing artifacts, ten weeks apart.
//
// ONE — Coos Bay structural 187-26-000309-STR (Emery Placeholder, 5050 Placeholder Blvd SE). The parser had
// already written "No PE stamp/seal shown (title block 'Signature with Seal' is blank); AHJ may
// require stamped structural for 2x4 @16\" rafters" and the packet filed anyway: the positive
// pattern matched "stamped" and the negative guard wanted the words "no stamp" ADJACENT. "PE" sat
// between them. Fixed in 8c6f6a8 by adding a DENIES_A_SEAL list.
//
// TWO — Portland 26-033226-000-00-RS (Bren Trask, 11739 SE Reedway St). Straight through that
// list. The project's own parserSnapshot.stampRecommendation reads, verbatim:
//
//   "Vector Structural Engineering review block with signature/seal area shown (VSE Project
//    U4703-1659-261) referencing a separate structural letter; the letter itself was not
//    supplied — submit the sealed letter with the permit"
//
// documentInventory showed structural_letter present:TRUE via "stamp in plan set", missingBlocking
// was [], and the packet printed the all-clear. DENIES_A_SEAL covered "not stamped / not sealed /
// not signed" and had no pattern for "not supplied". No upload of that type existed.
//
// A LIST OF WAYS TO SAY "ABSENT" CANNOT BE FINISHED, which is why there was a second occurrence.
// The predicate side of English is open-class. NEGATION is closed-class — about twenty words — so
// the rule now reads NEGATORS, clause by clause, and additionally requires an affirmative clause
// to actually ASSERT the document is in hand rather than merely name it. Both lists now fail
// toward NOT SATISFIED.
//
//   MUST REFUSE  — every real way a parser says the artifact is absent, INCLUDING phrasings
//                  nobody wrote a pattern for, and the two live sentences verbatim.
//   MUST KEEP    — genuine stamp evidence, including the exact wording llm.ts instructs the
//                  parser to emit when a sealed letter IS present, and the real-file path. A
//                  guard that eats real stamps sends every engineered project back for a
//                  document it already has; that is the mirror-image defect.
//
// THE KILL TEST: revert hasStampedStructuralEvidence in backend/src/permitPath.ts to the
// DENIES_A_SEAL version from 8c6f6a8. Section 1's Trask checks and every [CALLER] check on Trask
// go red — present becomes TRUE via "stamp in plan set" and missingBlocking empties — while the
// MUST-KEEP checks stay green. That difference IS the finding.
//
//   npx tsx backend/test/stampEvidence.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-evidence-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { hasStampedStructuralEvidence } = await import("../src/permitPath");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const withStamp = (text: string) => ({ parserSnapshot: { stampRecommendation: text } }) as never;
const withCalcs = (text: string) => ({ parserSnapshot: { structuralCalcText: text } }) as never;

// The two live sentences verbatim, then the ways a parser phrases the same fact.
const TRASK_SENTENCE =
  "Vector Structural Engineering review block with signature/seal area shown (VSE Project U4703-1659-261) "
  + "referencing a separate structural letter; the letter itself was not supplied "
  + "— submit the sealed letter with the permit";
const ANN_SENTENCE =
  "No PE stamp/seal shown (title block 'Signature with Seal' is blank); AHJ may require stamped structural for 2x4 @16\" rafters";

const ABSENT = [
  ANN_SENTENCE,
  TRASK_SENTENCE,
  "No PE stamp shown on the structural sheets.",
  "No engineer's seal shown; the signature block is blank.",
  "Title block 'Signature with Seal' is blank.",
  "Structural sheets are unsigned — no seal present.",
  "The stamp area is empty; a stamped structural letter may be required.",
  "Plan set does not appear to be stamped.",
  "No wet stamp visible on S-1.1.",
];

// THE CLASS, not the string. Nobody wrote a pattern for any of these, and that is the point:
// each one is caught by a closed-class NEGATOR ("not", "never", "without", "missing") bound to
// its own clause, or by the absence of any claim that the document is in hand.
const ABSENT_UNANTICIPATED = [
  "PE-stamped structural letter was not supplied with this submittal.",
  "The sealed structural letter is not provided.",
  "Structural letter was never included in the set.",
  "We do not have the stamped calculations for this roof.",
  "Sealed letter is missing from the package.",
  "Submitted without a stamped structural letter.",
  "The engineer's seal is illegible on the scan.",
  "Sealed structural letter: pending.",
  // Not a negation at all, and still not evidence: it names the letter without claiming anyone
  // has it. RULE 5 - a mention is not an assertion.
  "Sealed structural letter is still outstanding.",
  "Referencing a separate structural letter held by the engineer.",
];

check("THE HEADLINE (Portland): 'the letter itself was not supplied' is NOT evidence of a letter", () => {
  assert.equal(hasStampedStructuralEvidence(withStamp(TRASK_SENTENCE)), false,
    "this exact sentence made documentInventory print the all-clear on 26-033226-000-00-RS");
});

check("THE FIRST OCCURRENCE (Coos Bay): the blank-seal-box sentence is still refused", () => {
  assert.equal(hasStampedStructuralEvidence(withStamp(ANN_SENTENCE)), false,
    "this exact sentence let 187-26-000309-STR file without stamps and land in plan review");
});

check("MUST REFUSE: every way a parser says the artifact is absent", () => {
  const wrong = ABSENT.filter((t) => hasStampedStructuralEvidence(withStamp(t)));
  assert.deepEqual(wrong, [], `read as PROOF OF A STAMP: ${JSON.stringify(wrong, null, 1)}`);
});

check("MUST REFUSE: phrasings NO pattern was written for (this is the class fix)", () => {
  const wrong = ABSENT_UNANTICIPATED.filter((t) => hasStampedStructuralEvidence(withStamp(t)));
  assert.deepEqual(wrong, [], `read as PROOF OF A STAMP: ${JSON.stringify(wrong, null, 1)}`);
});

check("...and the same sentences in the structural-calcs field, not just the recommendation", () => {
  const wrong = [...ABSENT, ...ABSENT_UNANTICIPATED].filter((t) => hasStampedStructuralEvidence(withCalcs(t)));
  assert.deepEqual(wrong, [], `read as PROOF OF A STAMP: ${JSON.stringify(wrong, null, 1)}`);
});

// A guard that eats real evidence is worse than the gap it closes: every engineered project
// would be sent back for a letter that is already in the plan set.
const PRESENT = [
  "Structural sheets are PE stamped and sealed by the engineer of record.",
  "Wet stamp present on S-1.1 with the engineer's seal.",
  "Sealed by Jane Roe, PE, Oregon #12345.",
  // "No. 12345" is the abbreviation for NUMBER. A licence number sits right next to a real seal,
  // so reading it as the negator "no" would refuse the genuine article.
  "Sealed by Jane Roe, PE, Oregon No. 12345.",
  "Stamped structural calcs included in the plan set.",
  "Engineer of record: Roe Engineering; structural letter attached.",
  // The wording llm.ts (line ~1174) INSTRUCTS the parser to emit when a STRUCTURAL_LETTER is
  // present. If the gate refuses its own specified success string, it is broken. Note the "no"
  // in the trailing clause - blob-wide negation refuses this; clause-scoped negation does not.
  "PE-sealed structural letter provided — existing framing adequate",
  "PE-sealed structural letter provided: existing framing adequate, no upgrades required.",
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

check("AN UNKNOWN IS NOT A REASSURANCE: mention + disclaimer in one blob reads NOT SATISFIED", () => {
  // Trask's shape generalized: one field asserts, another retracts. The honest answer is no.
  assert.equal(hasStampedStructuralEvidence({
    parserSnapshot: {
      stampRecommendation: "PE-sealed structural letter provided by Vector Structural Engineering.",
      structuralCalcText: "That stamped letter is not included in this set.",
    },
  } as never), false, "a retraction anywhere in the parse outranks an assertion anywhere else");
});

check("THE BOX IS NOT THE MARK: a title block that HAS a seal area proves nothing", () => {
  assert.equal(hasStampedStructuralEvidence(withStamp(
    "Vector Structural Engineering review block with signature/seal area shown (VSE Project U4703-1659-261)")), false,
    "every title block has a seal area; only a seal in it is evidence");
});

// ---------------------------------------------------------------------------
// RAW EXTRACTED PLAN TEXT CAN DENY, BUT IT CANNOT ASSERT.
//
// Measured on the live database while building this fix: an EMPTY title block prints the literal
// words "SIGNATURE WITH SEAL" exactly like a signed one does, because that is the label of the
// box. Reading planSetExtractedText in the positive direction flipped 50030 SE Testing Way and
// 520 Example St NE to "stamped" on that boilerplate alone, with no seal anywhere in either set.
// ---------------------------------------------------------------------------
const TITLE_BLOCK_BOILERPLATE =
  "- N/A  DATE DESCRIPTION  REVISIONS SIGNATURE WITH SEAL PROJECT NAME & ADDRESS SHEET SIZE SHEET NUMBER  ANSI B 11";

check("RAW TEXT CANNOT ASSERT: an empty title block's own label is not a seal", () => {
  assert.equal(hasStampedStructuralEvidence({
    parserSnapshot: { planSetExtractedText: TITLE_BLOCK_BOILERPLATE },
  } as never), false, "the words 'SIGNATURE WITH SEAL' are printed on the blank box");
});

check("RAW TEXT CANNOT ASSERT: a plan note pointing AT a letter is not the letter", () => {
  assert.equal(hasStampedStructuralEvidence({
    parserSnapshot: { planSetExtractedText: "SEE DETAIL IN STRUCTURAL LETTER FOR ADDITIONAL METAL ROOF CONNECTION REQUIREMENTS" },
  } as never), false, "Trask's plan set says exactly this, and the letter was never sent");
});

check("RAW TEXT CAN STILL DENY: 'unstamped' on the sheets refuses an assessment that claims a seal", () => {
  assert.equal(hasStampedStructuralEvidence({
    parserSnapshot: {
      stampRecommendation: "PE-sealed structural letter provided.",
      planSetExtractedText: "STRUCTURAL SHEETS ISSUED UNSTAMPED FOR PERMIT REVIEW",
    },
  } as never), false, "the extract may contradict the assessment; it may never manufacture one");
});

// ===========================================================================
// [CALLER] THE PRODUCTION PATH: documentInventory -> present() -> hasStampedStructuralEvidence.
//
// The helper being right is not the bug that shipped. The bug that shipped is what the OPERATOR
// SAW: structural_letter present:true via "stamp in plan set", missingBlocking [], all-clear. So
// these drive requiredDocuments' real caller against a real database, with a real plan-set file
// on disk (projectDocsByType only counts a document whose bytes exist).
// ===========================================================================
const { openDatabase } = await import("../src/db");
const { createProject, getProjectDetail } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { documentInventory } = await import("../src/requiredDocuments");

const db = await openDatabase();
// Distinct bytes per document type: identical bytes under two doc types are ONE file, attached once
// (submissionDocuments.duplicateUploads, 2026-09-26).
const pdfBytesFor = async (title: string) => { const d = await PDFDocument.create(); d.setTitle(title); return Buffer.from(await d.save()); };
const pdfBytesByType: Record<string, Buffer> = {};
for (const t of ["plan_set", "structural_letter", "stamped_plans", "engineering_letter", "structural"]) pdfBytesByType[t] = await pdfBytesFor(t);
const pdfBytes = pdfBytesByType.plan_set;

/** An engineered Portland rooftop with a real plan-set PDF attached and whatever stamp text the
 *  case is about. `extraDocs` is how a project that genuinely HAS the letter as a file is built. */
function inventoryFor(snapshot: Record<string, unknown>, extraDocs: string[] = []): {
  present: boolean; via: string; blocking: boolean; required: boolean; missingBlocking: string[];
} {
  const detail = createProject(db, {
    owner: "Bren Trask", street: "11739 SE Reedway St", city: "Portland", state: "OR", zip: "97266",
    ahj: "City of Portland", utility: "Portland General Electric", dcKw: "8.1",
    // The live snapshot's own path signal, so the structural_letter row is REQUIRED here for the
    // same reason it is required in production.
    permitPath: "engineered",
    ...snapshot,
  });
  const projectId = detail.project.id;
  for (const docType of ["plan_set", ...extraDocs]) {
    saveProjectDocument(db, projectId, {
      docType, filename: `${docType}.pdf`, contentType: "application/pdf", buffer: pdfBytesByType[docType] ?? pdfBytes, source: "upload",
    });
  }
  const inv = documentInventory(db, getProjectDetail(db, projectId).project);
  const row = inv.presence.find((p) => p.docType === "structural_letter");
  return {
    present: Boolean(row?.present),
    via: String(row?.via ?? ""),
    blocking: Boolean(row?.blocking),
    required: Boolean(row),
    missingBlocking: inv.missingBlocking.map((p) => p.docType),
  };
}

check("[CALLER] premise: this project DOES require a sealed structural letter", () => {
  const out = inventoryFor({ stampRecommendation: TRASK_SENTENCE });
  assert.equal(out.required, true, "if the row is not even required the rest of this file proves nothing");
  assert.equal(out.blocking, true, "engineered path: the letter is a hard block, not an advisory");
});

check("[CALLER] THE REGRESSION: Trask's own sentence leaves the letter MISSING, not satisfied", () => {
  const out = inventoryFor({ stampRecommendation: TRASK_SENTENCE });
  assert.equal(out.present, false, `documentInventory said present via "${out.via}"`);
  assert.equal(out.via, "", "there is no file and no seal, so there is no route to present");
  assert.ok(out.missingBlocking.includes("structural_letter"),
    `missingBlocking was ${JSON.stringify(out.missingBlocking)} - the packet prints the all-clear off this list`);
});

check("[CALLER] ...and the same for the Coos Bay sentence", () => {
  const out = inventoryFor({ stampRecommendation: ANN_SENTENCE });
  assert.equal(out.present, false, `documentInventory said present via "${out.via}"`);
  assert.ok(out.missingBlocking.includes("structural_letter"));
});

check("[CALLER] MUST KEEP: a genuine sealed letter in the plan set still satisfies the row", () => {
  const out = inventoryFor({ stampRecommendation: "PE-sealed structural letter provided: existing framing adequate, no upgrades required." });
  assert.equal(out.present, true, "the parser's own specified success wording must satisfy the gate");
  assert.equal(out.via, "stamp in plan set");
  assert.ok(!out.missingBlocking.includes("structural_letter"));
});

check("[CALLER] MUST KEEP: an ATTACHED structural_letter satisfies even when the text denies a seal", () => {
  // This is how 5010 Fixture Ave and 5060 Synthetic Ave are satisfied on the live database: the
  // letter is a FILE. That route must not be touched by a text rule.
  const out = inventoryFor({ stampRecommendation: ANN_SENTENCE }, ["structural_letter"]);
  assert.equal(out.present, true, "a real uploaded letter is the strongest evidence there is");
  assert.equal(out.via, "attached file");
  assert.ok(!out.missingBlocking.includes("structural_letter"));
});

check("[CALLER] MUST KEEP: stamped_plans also satisfies it", () => {
  const out = inventoryFor({ stampRecommendation: ANN_SENTENCE }, ["stamped_plans"]);
  assert.equal(out.present, true);
  assert.equal(out.via, "attached file");
});

check("[CALLER] an empty title block in the extracted plan text does not satisfy the row", () => {
  const out = inventoryFor({ planSetExtractedText: TITLE_BLOCK_BOILERPLATE });
  assert.equal(out.present, false, `documentInventory said present via "${out.via}"`);
  assert.ok(out.missingBlocking.includes("structural_letter"));
});

// Windows keeps an open handle as a file lock, so the unlink EBUSYs until the DB is closed —
// and a throw HERE would kill the process before the banner prints, reporting a green run as a
// red one (and, in the `&&` chain, stopping every test after this file). Cleanup is best-effort.
try { db.close(); } catch { /* already closed */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* the OS will reap it */ }

console.log(failures === 0
  ? "\nstampEvidence: all checks passed."
  : `\nstampEvidence: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
