// THE ADOPTED NEC EDITION DECIDES THE CITATION AND THE EVIDENCE (issue #143).
//
// Rapid shutdown, PV labels and the 705 interconnection rules cited "NEC 690.12" / "NEC 705.12"
// whatever cycle the jurisdiction is on, and asked only whether the words appear. A plan checker
// applies the ADOPTED edition: 2014 measures rapid shutdown from 10 ft; 2017+ adds the inside-
// the-array-boundary requirement (690.12(B)(2)); 2020+ asks where the initiation device is
// (690.12(C)) and moves supply-side connections to 705.11. The same plan set is run under each
// edition and must come back with that edition's articles and that edition's missing evidence.
// Severity is rule-3 shaped: VERIFIED edition + documents actually read → blocker; seeded, or
// parser fields only → warning. Unknown edition → today's generic rules plus one callout.
//
// Every fixture is SYNTHETIC. No database, no LLM, no network.
//
// Run: npx tsx backend/test/codeReviewNecEditions.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { CodeEdition, JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";
import { adoptedNecEdition, NEC_EDITION_REQUIREMENTS, necEditionRequirements } from "../src/necEditions";
import { adoptedNecEdition as reexported } from "../src/requiredDocuments";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const STATE = "ZZ";
const AHJ = "City of Testville";
const plan = (over: Record<string, unknown> = {}, snapshot: Record<string, unknown> = {}): ProjectRecord => ({
  id: "nec-edition-plan", state: STATE, ahj: AHJ, utility: "Test Power", homeownerName: "Test Owner", projectAddress: "1 Test St",
  interconnectionMethod: "Supply-side tap",
  parserSnapshot: { mounting: "Roof mount", invModel: "Test 7600 string inverter", ...snapshot },
  ...over,
} as unknown as ProjectRecord);
const profile = (confidence: "verified" | "seeded", adoptedCodes: CodeEdition[]): JurisdictionCodeProfile => ({
  key: `${STATE.toLowerCase()}|${AHJ.toLowerCase()}|unknown`, state: STATE, ahj: AHJ, confidence,
  adoptedCodes, amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  researchedAt: "2026-09-01T00:00:00.000Z",
});
const nec = (edition: string): CodeEdition[] => [
  { code: "NEC", edition, title: "National Electrical Code" },
  { code: "IRC", edition: "2021", title: "International Residential Code" },
];

// A plan that mentions rapid shutdown and has a label schedule, but nothing edition-specific.
const GENERIC = "E-1 ONE-LINE DIAGRAM. RAPID SHUTDOWN PER NEC 690.12. LABEL SCHEDULE: SERVICE EQUIPMENT DIRECTORY. ROOF PLAN: 36 IN FIRE ACCESS PATHWAY.";
// The same plan with every 2017+/2020+ element shown.
const COMPLETE = `${GENERIC} PV HAZARD CONTROL SYSTEM LISTED TO UL 3741. RAPID SHUTDOWN SWITCH AT EXTERIOR OF DWELLING NEXT TO METER. `
  + `LABEL: "SOLAR PV SYSTEM IS EQUIPPED WITH RAPID SHUTDOWN". LABEL: "PV SYSTEM DISCONNECT". LABEL: MAXIMUM DC VOLTAGE 480 V. `
  + `LABEL: RATED AC OUTPUT CURRENT 32 A, NOMINAL AC VOLTAGE 240 V.`;

const run = (opts: { edition?: string; codes?: CodeEdition[]; confidence?: "verified" | "seeded"; text?: string; project?: ProjectRecord; noCtx?: boolean; parserOnly?: boolean }): ReviewerFinding[] => {
  const text = opts.text ?? GENERIC;
  // getProjectDetail overlays the uploaded documents' text as planSetExtractedText; the rules read
  // it there (designText) and per document (documentTexts). Parser-only: neither.
  const base = opts.project ?? plan();
  const project = opts.parserOnly ? base : { ...base, parserSnapshot: { ...(base.parserSnapshot || {}), planSetExtractedText: text } } as ProjectRecord;
  const ctx = opts.noCtx ? undefined : buildCodeContext(STATE, AHJ, profile(opts.confidence ?? "verified", opts.codes ?? nec(opts.edition ?? "2020")));
  return evaluateDesignCodeFindings(project, null, ctx, [], opts.parserOnly ? [] : [{ label: "Plan set", text }]);
};
const get = (fs: ReviewerFinding[], id: string): ReviewerFinding | undefined => fs.find((f) => f.id === id);
const sections = (f: ReviewerFinding | undefined): string[] => (f?.codeReferences ?? []).map((r) => `${r.code} ${r.section}`);

const RSD_EDITION = "city.elec.rapid-shutdown-edition-evidence";
const LABELS_EDITION = "city.elec.labels-edition-missing";
const UNKNOWN = "city.code.nec-edition-unknown";

console.log("A. the edition table and its reader");

check("adoptedNecEdition is one shared function (requiredDocuments re-exports necEditions')", () => {
  assert.equal(reexported, adoptedNecEdition);
  assert.equal(adoptedNecEdition(nec("2017")), 2017);
  assert.equal(adoptedNecEdition([{ code: "OESC", edition: "2023", basedOn: "2023 NEC" }]), 2023);
});
check("the table covers 2014/2017/2020/2023 and nothing else", () => {
  assert.deepEqual(Object.keys(NEC_EDITION_REQUIREMENTS), ["2014", "2017", "2020", "2023"]);
  assert.equal(necEditionRequirements(2011), null);
  assert.equal(necEditionRequirements(2026), null);
  assert.equal(necEditionRequirements(null), null);
});

console.log("\nB. the same plan under each edition");

check("2014: no 2017+ evidence demanded; labels cite 690.56(C)/690.54/690.53 under 2014 NEC; supply side is 705.12(A)", () => {
  const fs = run({ edition: "2014" });
  assert.equal(get(fs, RSD_EDITION), undefined, get(fs, RSD_EDITION)?.message);
  const labels = get(fs, LABELS_EDITION);
  assert.ok(labels, "labels-edition-missing expected");
  assert.equal(labels.severity, "blocker");
  assert.deepEqual(sections(labels), ["2014 NEC 690.56(C)", "2014 NEC 690.54", "2014 NEC 690.53"]);
  const tap = get(fs, "city.elec.supply-side-tap");
  assert.deepEqual(sections(tap), ["2014 NEC 705.12(A)"]);
  assert.match(tap!.message, /705\.12\(D\)\(2\)\(3\)\(b\)/);
});
check("2017: inside-boundary listed equipment (690.12(B)(2)) missing → blocker; no 690.12(C) demand; 690.13(B) label asked", () => {
  const fs = run({ edition: "2017" });
  const rsd = get(fs, RSD_EDITION);
  assert.ok(rsd, "rapid-shutdown-edition-evidence expected");
  assert.equal(rsd.severity, "blocker");
  assert.deepEqual(sections(rsd), ["2017 NEC 690.12(B)(2)"]);
  assert.deepEqual(sections(get(fs, LABELS_EDITION)), ["2017 NEC 690.56(C)", "2017 NEC 690.13(B)", "2017 NEC 690.54", "2017 NEC 690.53"]);
  assert.deepEqual(sections(get(fs, "city.elec.supply-side-tap")), ["2017 NEC 705.12(A)"]);
});
check("2020: 690.12(B)(2) AND 690.12(C) initiation device missing; supply side renumbered to 705.11", () => {
  const fs = run({ edition: "2020" });
  assert.deepEqual(sections(get(fs, RSD_EDITION)), ["2020 NEC 690.12(B)(2)", "2020 NEC 690.12(C)"]);
  const tap = get(fs, "city.elec.supply-side-tap");
  assert.deepEqual(sections(tap), ["2020 NEC 705.11"]);
  assert.match(tap!.message, /705\.12\(B\)\(3\)\(2\)/);
});
check("2023: same RSD evidence; the 690.54 cell the table leaves unknown is not asked for", () => {
  const fs = run({ edition: "2023" });
  assert.deepEqual(sections(get(fs, RSD_EDITION)), ["2023 NEC 690.12(B)(2)", "2023 NEC 690.12(C)"]);
  assert.deepEqual(sections(get(fs, LABELS_EDITION)), ["2023 NEC 690.56(C)", "2023 NEC 690.13(B)", "2023 NEC 690.53"]);
  assert.deepEqual(sections(get(fs, "city.elec.supply-side-tap")), ["2023 NEC 705.11"]);
});
check("a plan showing every edition element → no edition findings under any edition", () => {
  for (const e of ["2014", "2017", "2020", "2023"]) {
    const fs = run({ edition: e, text: COMPLETE });
    assert.equal(get(fs, RSD_EDITION), undefined, `${e}: ${get(fs, RSD_EDITION)?.message}`);
    assert.equal(get(fs, LABELS_EDITION), undefined, `${e}: ${get(fs, LABELS_EDITION)?.message}`);
  }
});
check("no rapid shutdown at all under 2017 → the presence rule names the 1 ft boundary and cites 690.12 + 690.56(C)", () => {
  const fs = run({ edition: "2017", text: "E-1 ONE-LINE DIAGRAM. LABEL SCHEDULE: DIRECTORY." });
  const missing = get(fs, "city.elec.rapid-shutdown-missing");
  assert.ok(missing);
  assert.equal(missing.severity, "blocker");
  assert.match(missing.message, /NEC 2017 690\.12 requires .*1 ft/);
  assert.deepEqual(sections(missing).slice(0, 2), ["2017 NEC 690.12", "2017 NEC 690.56(C)"]);
  assert.equal(get(fs, RSD_EDITION), undefined, "no second RSD finding on top of the presence one");
});

console.log("\nC. severity: rule-3 shape");

check("a SEEDED edition → warnings, never blockers", () => {
  const fs = run({ edition: "2020", confidence: "seeded" });
  assert.equal(get(fs, RSD_EDITION)?.severity, "warning");
  assert.equal(get(fs, LABELS_EDITION)?.severity, "warning");
});
check("verified edition but parser fields only (no document read) → warning", () => {
  const fs = run({ edition: "2020", parserOnly: true, project: plan({}, { electricalCalcText: GENERIC }) });
  assert.equal(get(fs, RSD_EDITION)?.severity, "warning");
  assert.equal(get(fs, LABELS_EDITION)?.severity, "warning");
});
check("an MLPE design's RSD evidence gap is documentation: warning even when verified", () => {
  const fs = run({ edition: "2020", project: plan({}, { invModel: "", pvMicroModel: "Test micro 300", pvMicroQty: "20" }) });
  assert.equal(get(fs, RSD_EDITION)?.severity, "warning");
  // A microinverter design carries no DC PV circuit label demand.
  assert.ok(!sections(get(fs, LABELS_EDITION)).some((s) => s.endsWith("690.53")));
});

console.log("\nD. edition unknown: today's generic behaviour plus a callout");

check("no electrical entry on the profile → generic citations, no edition findings, one callout naming the gap", () => {
  const fs = run({ codes: [{ code: "IRC", edition: "2021", title: "International Residential Code" }] });
  assert.equal(get(fs, RSD_EDITION), undefined);
  assert.equal(get(fs, LABELS_EDITION), undefined);
  const tap = get(fs, "city.elec.supply-side-tap");
  assert.deepEqual(tap?.codeReferences.map((r) => r.section), ["705.11"]);
  assert.match(tap!.message, /NEC 705\.12\(B\)\(3\)\(2\)'s 120% busbar/);
  const callout = get(fs, UNKNOWN);
  assert.equal(callout?.severity, "callout");
  assert.match(callout!.message, /No adopted electrical code edition is on file/);
});
check("model-code defaults (no profile) are placeholders, not an adoption → unknown", () => {
  const fs = evaluateDesignCodeFindings(plan({}, { planSetExtractedText: GENERIC }), null, buildCodeContext(STATE, AHJ, null), [], [{ label: "Plan set", text: GENERIC }]);
  assert.equal(get(fs, RSD_EDITION), undefined);
  assert.equal(get(fs, LABELS_EDITION), undefined);
  assert.ok(get(fs, UNKNOWN));
});
check("an edition the table does not cover (NEC 2026) → unknown, and the callout says which year", () => {
  const fs = run({ edition: "2026" });
  assert.equal(get(fs, RSD_EDITION), undefined);
  assert.match(get(fs, UNKNOWN)!.message, /NEC 2026/);
});
check("no context at all → exactly the legacy findings: no callout, generic labels evidence", () => {
  const fs = run({ noCtx: true, text: "E-1 ONE-LINE DIAGRAM. RAPID SHUTDOWN DEVICES AT ARRAY." });
  assert.equal(get(fs, UNKNOWN), undefined);
  assert.equal(get(fs, RSD_EDITION), undefined);
  assert.deepEqual(get(fs, "city.elec.labels-missing")?.evidenceNeeded, ["Label schedule", "Placard locations", "Backfed breaker warning where applicable", "Power source directory"]);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall NEC edition checks passed");
