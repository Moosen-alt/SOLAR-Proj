// THE STRUCTURE ANSWER REACHES EVERY FORM THROUGH ONE PREDICATE (dry run 2026-09-28, B5).
//
// The operator answered the portal question "What structure is the array installed on?" with
// "Single-family dwelling" — stored as parserSnapshot.structureDescription. The BCD 5952 printed it;
// the Coos County electrical application (curated map: checkbox "Single Family Dwelling" and required
// field 'construction category' -> computed.singleFamilyCategory) read ONLY constructionCategory, so it
// shipped unticked with "Still needs: construction category". Two predicates, one question.
//
// Pinned through the real resolver (ahjForms.resolveSource — the exact call the fill's required-field
// check makes: `!resolveSource(source, ctx).trim()` is "Still needs"):
//   a THE POINT      — structureDescription alone answers singleFamilyCategory / constructionCategory.
//   b MUST-PASS      — every value the old constructionCategory regex answered still answers (R-3, 1&2).
//   c FALL-THROUGH   — structureDescription "" falls through to constructionCategory (the `??` bug).
//   d MUST-EXCLUDE   — a manufactured home / duplex / an unanswered job ticks nothing (blank = ask).
//   e ONE ANSWER     — residentialCategory and structureSfdOrAccessory agree with the two above.
//   f THE IOWA SHEET — the PV worksheet's one-/two-family row reads the same answer.
//
// KILLS (verified by hand): singleFamilyCategory back to the constructionCategory regex -> a FAILS;
// structureMeaningOf back to `??` -> c FAILS; dropping the R-3 read -> b FAILS.
//
//   npx tsx backend/test/structureOnePredicate.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "structure-one-predicate-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(dir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
delete process.env.ANTHROPIC_API_KEY;

const { resolveSource } = await import("../src/ahjForms");
const { structureMeaningOf } = await import("../src/applicationDocsAgency");
const { iowaPvWorksheetValues } = await import("../src/iowaPvWorksheet");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};
const ctx = (snapshot: Record<string, unknown>) => ({ project: { id: "p", state: "OR", ahj: "City of Coos Bay", parserSnapshot: snapshot } as never, client: {}, snapshot });
const r = (source: string, snapshot: Record<string, unknown>): string => resolveSource(source as never, ctx(snapshot) as never);
const sfc = (s: Record<string, unknown>) => r("computed.singleFamilyCategory", s);
const cc = (s: Record<string, unknown>) => r("computed.constructionCategory", s);

console.log("\na. THE OPERATOR'S STRUCTURE ANSWER ANSWERS THE CONSTRUCTION CATEGORY");
const answered = { structureDescription: "Single-family dwelling" };
check("a1. THE POINT: structureDescription 'Single-family dwelling' ticks 'Single Family Dwelling' (computed.singleFamilyCategory)", sfc(answered) === "yes", sfc(answered));
check("a2. and 'construction category' is no longer a 'Still needs' blank (computed.constructionCategory)", cc(answered) === "residential", cc(answered));

console.log("\nb. MUST-PASS: EVERYTHING THE OLD REGEX ANSWERED STILL ANSWERS");
for (const v of ["Single Family", "Single-Family Dwelling", "single family dwelling", "1 and 2 family", "One and Two Family", "R-3", "R3"]) {
  check(`b. constructionCategory "${v}" -> residential`, cc({ constructionCategory: v }) === "residential", cc({ constructionCategory: v }));
}
check("b'. occupancyType 'R-3' alone -> residential", cc({ occupancyType: "R-3" }) === "residential");
check("b''. constructionCategory 'Single Family' alone still ticks the box", sfc({ constructionCategory: "Single Family" }) === "yes");
check("b'''. an explicit 'Other' with its description stays the operator's own answer", cc({ constructionCategory: "Other", constructionCategoryOther: "Barn" }) === "other"
  && cc({ constructionCategory: "Other" }) === "");

console.log("\nc. AN EMPTY ANSWER FALLS THROUGH");
check("c. MUST-PASS: structureDescription '' falls through to constructionCategory 'Single Family'",
  structureMeaningOf({ structureDescription: "", constructionCategory: "Single Family" }) === "single_family"
  && sfc({ structureDescription: "", constructionCategory: "Single Family" }) === "yes",
  String(structureMeaningOf({ structureDescription: "", constructionCategory: "Single Family" })));

console.log("\nd. MUST-EXCLUDE: NO GUESS");
for (const s of [{ structureDescription: "Manufactured home" }, { structureDescription: "Two-family dwelling (duplex)" }, { structureDescription: "Detached garage" }, {}, { structureDescription: "  " }]) {
  check(`d. ${JSON.stringify(s)} ticks nothing and names no category`, sfc(s) === "" && cc(s) === "", `${sfc(s)} / ${cc(s)}`);
}
check("d'. the operator's structure answer wins over a contradicting parsed category (no silent pick)",
  sfc({ structureDescription: "Manufactured home", constructionCategory: "Single Family" }) === "");

console.log("\ne. THE SIBLINGS AGREE");
check("e1. residentialCategory: residential", r("computed.residentialCategory", answered) === "residential");
check("e2. structureSfdOrAccessory: yes", r("computed.structureSfdOrAccessory", answered) === "yes");
check("e3. and for a parsed R-3 too (all four read one answer)", sfc({ constructionCategory: "R-3" }) === "yes"
  && r("computed.residentialCategory", { constructionCategory: "R-3" }) === "residential"
  && r("computed.structureSfdOrAccessory", { constructionCategory: "R-3" }) === "yes");

console.log("\nf. THE IOWA PV WORKSHEET");
const ia = (snapshot: Record<string, unknown>) => iowaPvWorksheetValues({ id: "ia", state: "IA", ahj: "City of Ames", parserSnapshot: { mounting: "roof", ...snapshot } } as never);
const iaAnswered = ia(answered);
check("f1. THE POINT: 'Single-family dwelling' marks the one-/two-family row and does not ask for dwelling units",
  iaAnswered.values["p3.loc12fam"] === "X" && !iaAnswered.questions.some((q) => q.key === "dwellingUnits"),
  JSON.stringify({ v: iaAnswered.values["p3.loc12fam"], q: iaAnswered.questions.map((q) => q.key) }));
const iaUnknown = ia({});
check("f2. MUST-EXCLUDE: no structure answer -> the row stays blank and the question is asked",
  iaUnknown.values["p3.loc12fam"] === "" && iaUnknown.questions.some((q) => q.key === "dwellingUnits"),
  JSON.stringify({ v: iaUnknown.values["p3.loc12fam"], q: iaUnknown.questions.map((q) => q.key) }));

console.log(failures ? `\nstructureOnePredicate: ${failures} check(s) FAILED` : "\nstructureOnePredicate: all checks passed");
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
