// IS THE ARRAY ON A MANUFACTURED HOME? ONE PREDICATE, TWO CONFIDENCE LEVELS.
//
// The first version read any plan-set sentence naming a manufactured / mobile home as the
// answer, and raised city.struct.manufactured-home-prescriptive as a BLOCKER with evidence
// "verified" — including for sentences that DENY it: "This letter does not apply to
// mobile/manufactured homes", "NOT FOR INSTALLATION ON MOBILE HOMES", a Y/N question answered N,
// an unchecked box, and the Oregon Manufactured Dwelling code listed under GOVERNING CODES.
// Engineer letters and racking notes carry that wording routinely.
//
// Now:
//   STATED   — the operator's intake answer (structureTypeOverride; always wins) or the parser's
//              structureType field -> BLOCKER (as built: prescriptive path / missing load path).
//   INFERRED — package text only -> WARNING that asks for the structure type to be confirmed.
//   A stated SITE-BUILT answer suppresses text inference entirely.
// And the text reader skips disclaimers, exclusions, code titles, checkboxes and questions.
//
// Every fixture is synthetic. Run: npx tsx backend/test/structureTypeConfidence.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { REPO } from "./_isolate";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings, structureType } from "../src/codeReviewRules";
import { buildReviewerReport } from "../src/reviewerEngine";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const project = (snapshot: Record<string, unknown>): ProjectRecord => ({
  id: "structure-type-confidence", state: "OR", ahj: "City of Testport", utility: "Test Power",
  homeownerName: "Test Owner", projectAddress: "1 Test St", interconnectionMethod: "Load-side breaker",
  parserSnapshot: { mounting: "Roof mount", ...snapshot },
} as unknown as ProjectRecord);
const ctx = buildCodeContext("OR", "City of Testport", {
  key: "or|city of testport|unknown", state: "OR", ahj: "City of Testport", confidence: "seeded",
  adoptedCodes: [{ code: "ORSC", edition: "2023" }], amendments: [], designCriteria: {}, prescriptive: {},
  fireSetbacks: [], citations: [], updatedAt: "",
} as JurisdictionCodeProfile);
const findings = (snap: Record<string, unknown>): ReviewerFinding[] => evaluateDesignCodeFindings(project(snap), null, ctx);
const mhFinding = (snap: Record<string, unknown>): ReviewerFinding | undefined =>
  findings(snap).find((f) => f.id === "city.struct.manufactured-home-prescriptive" || f.id === "city.struct.manufactured-home-load-path");
const kind = (snap: Record<string, unknown>): string => structureType(project(snap)).kind;
const PRESCRIPTIVE = { permitPath: "prescriptive" };

console.log("\n1. Two confidence levels");
check("STATED by the intake (structureTypeOverride: manufactured) + prescriptive -> BLOCKER, evidence verified, source named", () => {
  const f = mhFinding({ ...PRESCRIPTIVE, structureTypeOverride: "manufactured" });
  assert.equal(f?.id, "city.struct.manufactured-home-prescriptive");
  assert.equal(f?.severity, "blocker");
  assert.equal(f?.evidenceStatus, "verified");
  assert.match(f!.message, /recorded as a manufactured home/);
  assert.match(f!.evidenceFound?.[0]?.source ?? "", /Intake/);
});
check("STATED by the parser (structureType: manufactured) -> BLOCKER; engineered path without a load path -> load-path BLOCKER", () => {
  assert.equal(mhFinding({ ...PRESCRIPTIVE, structureType: "manufactured" })?.severity, "blocker");
  const lp = mhFinding({ permitPath: "engineered", structureType: "manufactured" });
  assert.equal(lp?.id, "city.struct.manufactured-home-load-path");
  assert.equal(lp?.severity, "blocker");
});
check("INFERRED from text only -> WARNING (not a blocker), evidence 'weak', and it asks for the intake answer", () => {
  const f = mhFinding({ ...PRESCRIPTIVE, structuralCalcText: "Structure: HUD manufactured home on piers." });
  assert.equal(f?.severity, "warning");
  assert.equal(f?.evidenceStatus, "weak", "a regex reading is not verified evidence");
  assert.match(f!.message, /inferred from text, not confirmed/);
  assert.match(f!.designTeamAction, /confirm the structure type/i);
  assert.equal(structureType(project({ structuralCalcText: "Structure: HUD manufactured home on piers." })).basis, "inferred");
});
check("INFERRED through the real engine (buildReviewerReport): still a warning with evidence 'weak' — attachEvidence does not upgrade it", () => {
  const report = buildReviewerReport(project({ ...PRESCRIPTIVE, structuralCalcText: "Structure: HUD manufactured home on piers." }), { codeContext: ctx });
  const f = report.findings.find((x) => x.id === "city.struct.manufactured-home-prescriptive");
  assert.equal(f?.severity, "warning");
  assert.equal(f?.evidenceStatus, "weak");
});
check("PRECEDENCE: the intake answer beats the parser's; 'unknown' falls through to the parser", () => {
  assert.equal(kind({ structureTypeOverride: "site_built", structureType: "manufactured" }), "site_built");
  assert.equal(kind({ structureTypeOverride: "manufactured", structureType: "site_built" }), "manufactured_home");
  assert.equal(kind({ structureTypeOverride: "unknown", structureType: "manufactured" }), "manufactured_home");
});
check("MUST-EXCLUDE: a STATED site-built answer suppresses text inference — no MH finding at all", () => {
  const snap = { ...PRESCRIPTIVE, structureTypeOverride: "site_built", structuralCalcText: "Structure: HUD manufactured home on piers." };
  assert.equal(kind(snap), "site_built");
  assert.equal(mhFinding(snap), undefined);
});
check("MUST-EXCLUDE: no answer and no text -> unknown / none, and no finding (silence is not site-built either)", () => {
  const f = structureType(project({}));
  assert.deepEqual([f.kind, f.basis], ["unknown", "none"]);
  assert.equal(mhFinding(PRESCRIPTIVE), undefined);
});

console.log("\n2. Disclaimers and exclusions are not statements (the skeptic's eight forms)");
const DISCLAIMERS: Array<[string, string]> = [
  ["plural applicability", "This letter does not apply to mobile/manufactured homes."],
  ["singular applicability", "This letter does not apply to a manufactured home."],
  ["NOT FOR INSTALLATION ON", "NOT FOR INSTALLATION ON MOBILE HOMES"],
  ["not approved for use on", "Racking not approved for use on a manufactured home."],
  ["not valid for", "Calculations not valid for a mobile or manufactured home."],
  ["excludes", "Scope excludes manufactured homes and the manufactured home foundation."],
  ["generic rule", "Manufactured homes require a separate evaluation."],
  ["Y/N answered N", "IS THE STRUCTURE A MANUFACTURED HOME OR MOBILE HOME (Y/N): N"],
  ["unanswered question", "Is the structure a manufactured home?"],
  ["unchecked box", "STRUCTURE TYPE: [ ] MANUFACTURED HOME [X] SITE BUILT"],
  ["unchecked glyph", "☐ MOBILE HOME ☒ SITE-BUILT"],
  ["code title", "GOVERNING CODES: 2023 OREGON RESIDENTIAL SPECIALTY CODE, 2022 OREGON MANUFACTURED DWELLING AND PARK SPECIALTY CODE, 2023 OESC"],
  ["standard title", "Racking tested per the Manufactured Home Construction and Safety Standards."],
  ["HUD income program", "Income limits per HUD standards; HUD-certified housing counselor on file."],
];
for (const [label, text] of DISCLAIMERS) {
  check(`MUST-EXCLUDE (${label}): no manufactured-home reading, no finding`, () => {
    assert.equal(kind({ structuralCalcText: text }), "unknown", text);
    assert.equal(mhFinding({ ...PRESCRIPTIVE, structuralCalcText: text }), undefined, text);
  });
}

console.log("\n3. Real statements still read (must-pass)");
const STATEMENTS: Array<[string, string]> = [
  ["the approved letter", "Structure: HUD manufactured home. Framing: 2x2 manufactured trusses @ 24\" o.c."],
  ["MH UNIT in capitals", "EXISTING MH UNIT ON PIERS"],
  ["MH HOME in capitals", "(E) MH HOME, SINGLE STORY"],
  ["pinned to this house despite a 'not'", "The prescriptive path does not apply to this manufactured home."],
  ["engineered, not prescriptive", "Design is engineered, not prescriptive, for a manufactured home."],
  ["Y/N answered Y", "IS THE STRUCTURE A MANUFACTURED HOME (Y/N): Y"],
  ["checked box", "STRUCTURE TYPE: [X] MANUFACTURED HOME [ ] SITE BUILT"],
  ["double-wide", "EXISTING DOUBLE-WIDE MANUFACTURED HOME"],
];
for (const [label, text] of STATEMENTS) {
  check(`MUST-PASS (${label}): read as a manufactured home, inferred -> warning`, () => {
    const f = structureType(project({ structuralCalcText: text }));
    assert.deepEqual([f.kind, f.basis], ["manufactured_home", "inferred"], text);
    assert.equal(mhFinding({ ...PRESCRIPTIVE, structuralCalcText: text })?.severity, "warning", text);
  });
}
check("MUST-EXCLUDE: a manhole 'MH' in capitals is still not a home", () => {
  assert.equal(kind({ sitePlanNotesText: "EXISTING SEWER MANHOLE (MH) AT CURB. MH RIM EL 102.3. MH COVER" }), "unknown");
});

console.log("\n4. The intake field and the parser field exist where the predicate reads them");
check("dashboard: a structure-type select writes structureTypeOverride (site-built / manufactured / unknown)", () => {
  const html = fs.readFileSync(path.join(REPO, "frontend/dashboard.html"), "utf8");
  const js = fs.readFileSync(path.join(REPO, "frontend/dashboard.js"), "utf8");
  const select = /<select id="manualStructureType">([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
  for (const v of ["unknown", "site_built", "manufactured"]) assert.match(select, new RegExp(`value="${v}"`), `option ${v}`);
  assert.match(js, /payload\.structureTypeOverride\s*=/, "saveManualEntry must send structureTypeOverride");
  // Every option value must be one the predicate understands — a value it ignores would read as "no answer".
  assert.equal(kind({ structureTypeOverride: "site_built" }), "site_built");
  assert.equal(kind({ structureTypeOverride: "manufactured" }), "manufactured_home");
  assert.equal(kind({ structureTypeOverride: "unknown" }), "unknown");
});
check("parser schema: ONE structureType line in the STRUCTURAL block, values the predicate reads", () => {
  const llm = fs.readFileSync(path.join(REPO, "backend/src/llm.ts"), "utf8");
  const lines = llm.split("\n").filter((l) => /^- structureType:/.test(l));
  assert.equal(lines.length, 1, "exactly one parser field");
  assert.match(lines[0], /"manufactured"/);
  assert.match(lines[0], /"site_built"/);
  assert.ok(lines[0].length < 260, "keep the prompt compact");
});

console.log("\n4b. Other states and AHJs — the rule is structure, not Oregon");
for (const [st, ahj, residential] of [
  ["WA", "City of Spokane", { code: "IRC", edition: "2021" }],
  ["CA", "City of Fresno", { code: "CRC", edition: "2022" }],
  ["FL", "City of Tampa", { code: "FBC-R", edition: "2023" }],
  ["IL", "Village of Oak Park", { code: "IRC", edition: "2021" }],
  ["ID", "Ada County", { code: "IRC", edition: "2018" }],
] as const) {
  check(`${st} / ${ahj}: stated MH blocks, inferred warns, a disclaimer is silent — and no Oregon code is cited`, () => {
    const c = buildCodeContext(st, ahj, {
      key: `${st.toLowerCase()}|${ahj.toLowerCase()}|unknown`, state: st, ahj, confidence: "seeded",
      adoptedCodes: [residential, { code: "NEC", edition: "2023" }], amendments: [], designCriteria: {}, prescriptive: {},
      fireSetbacks: [], citations: [], updatedAt: "",
    } as JurisdictionCodeProfile);
    const p = (snap: Record<string, unknown>) => ({ ...project(snap), state: st, ahj } as ProjectRecord);
    const mh = (snap: Record<string, unknown>) => evaluateDesignCodeFindings(p({ ...PRESCRIPTIVE, ...snap }), null, c)
      .find((f) => f.id === "city.struct.manufactured-home-prescriptive");
    const stated = mh({ structureTypeOverride: "manufactured" });
    assert.equal(stated?.severity, "blocker");
    assert.ok(stated!.codeReferences.length > 0 && !stated!.codeReferences.some((r) => /ORSC|Oregon/i.test(`${r.code} ${r.adoptionScope}`)), JSON.stringify(stated!.codeReferences));
    assert.equal(mh({ structuralCalcText: "EXISTING MH UNIT ON PIERS" })?.severity, "warning");
    assert.equal(mh({ structuralCalcText: "NOT FOR INSTALLATION ON MOBILE HOMES" }), undefined);
  });
}

console.log("\n5. Through the real write path (the dashboard's PUT -> updateProject)");
{
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "structure-type-"));
  process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
  process.env.SEED_TEST_INSTALLER = "false";
  process.env.AUTOPILOT_AUTO_START = "0";
  delete process.env.ANTHROPIC_API_KEY;
  const { openDatabase } = await import("../src/db");
  const R = await import("../src/repository");
  const db = await openDatabase();
  const pid = R.createProject(db, {
    owner: "Structure Owner", state: "OR", dcKw: "6.0", acKw: "5.0", street: "1 Test Way", city: "Testport", zip: "97000",
    ahj: "City of Testport", utility: "Test Power",
  } as never).project.id;
  check("the intake answer persists through updateProject and the predicate reads it back as STATED", () => {
    R.updateProject(db, pid, { structureTypeOverride: "manufactured" } as never);
    const f = structureType(R.getProjectDetail(db, pid).project);
    assert.deepEqual([f.kind, f.basis], ["manufactured_home", "stated"]);
  });
  check("a later parser write (structureType: site_built, as a re-parse would merge it) does not clobber the operator's answer", () => {
    R.updateProject(db, pid, { structureType: "site_built" } as never);
    assert.equal(structureType(R.getProjectDetail(db, pid).project).kind, "manufactured_home");
    R.updateProject(db, pid, { structureTypeOverride: "unknown" } as never);
    assert.equal(structureType(R.getProjectDetail(db, pid).project).kind, "site_built", "'unknown' hands the answer back to the parser");
  });
  try { db.close(); } catch { /* best effort */ }
}

if (failures) { console.error(`\n${failures} structure-type check(s) FAILED`); process.exit(1); }
console.log("\nall structure-type checks passed");
