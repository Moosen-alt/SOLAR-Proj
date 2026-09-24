// THE STATE'S MINIMUM GROUND SNOW LOAD, BY PERMIT PATH.
//
// Operator decision (Oregon, ORSC 2023 R301.2.3.1): the site's ground snow load Pg comes from the
// SEAO lookup, and it is never less than 36 psf for PRESCRIPTIVE design or 25 psf for
// NON-PRESCRIPTIVE (engineered) design. The finding city.struct.ground-snow-below-state-minimum
// compares the package's stated Pg — never Pg(asd), never a roof snow load — with the minimum for
// the project's path:
//   · a BLOCKER when the path is known, the profile ROW carrying the minimum is verified, and a
//     document states the value;
//   · a WARNING when that row is seeded, when only the parser's reading states it, or when the path
//     is unknown (then the stricter minimum is used and the message says the path is unknown).
// "Which row carried the minimum" is JurisdictionCodeProfile.fieldSources on a layered read: a
// seeded city row over the verified state row must not demote the state's verified floor, and a
// verified city row over a seeded state minimum must not promote it.
//
// Fixtures are synthetic. Part 1 is pure (hand-built profiles); part 2 goes through the real write
// path (saveResearchedCodeProfile / saveVerifiedCodeProfile / resolveEffectiveCodeContext on a temp
// DB seeded from the shipped reference profiles). No LLM, no network.
//
// Run: npx tsx backend/test/designCriteriaStateMinimum.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext, type EffectiveCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const ID = "city.struct.ground-snow-below-state-minimum";
const OR_MINS = { minGroundSnowPsfPrescriptive: 36, minGroundSnowPsfEngineered: 25, minGroundSnowCitation: "ORSC 2023 R301.2.3.1" };

const project = (ahj: string, snap: Record<string, string> = {}, state = "OR"): ProjectRecord => ({
  id: "state-minimum-test", state, ahj, utility: "Test Power", homeownerName: "Test Owner", projectAddress: "1 Test St",
  interconnectionMethod: "Load-side breaker", parserSnapshot: { mounting: "Roof mount", ...snap },
} as unknown as ProjectRecord);
const profileOf = (state: string, ahj: string, over: Partial<JurisdictionCodeProfile>): JurisdictionCodeProfile => ({
  key: `${state.toLowerCase()}|${ahj.toLowerCase()}|unknown`, state, ahj, confidence: "verified",
  adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  verifiedBy: "operator", verifiedAt: "2026-09-24T00:00:00.000Z", ...over,
});
const run = (p: ProjectRecord, ctx: EffectiveCodeContext, text: string | null): ReviewerFinding[] =>
  evaluateDesignCodeFindings(p, null, ctx, [], text == null ? [] : [{ label: "Plan set", text }]);
const orCtx = (ahj: string, over: Partial<JurisdictionCodeProfile> = {}): EffectiveCodeContext =>
  buildCodeContext("OR", ahj, profileOf("OR", ahj, { prescriptive: { ...OR_MINS }, ...over }));
const minimum = (fs: ReviewerFinding[]): ReviewerFinding | undefined => fs.find((f) => f.id === ID);
const PRESCRIPTIVE = { permitPath: "PRESCRIPTIVE" };
const ENGINEERED = { permitPath: "Non-prescriptive" };

console.log("1. the stated Pg against the minimum for the project's path (pure)");

await check("MUST-PASS: Coos Bay shape — prescriptive, 16 psf, verified minimum -> BLOCKER naming 16 and 36 and the citation", () => {
  const f = minimum(run(project("City of Coos Bay", PRESCRIPTIVE), orCtx("City of Coos Bay"), "DESIGN CRITERIA: GROUND SNOW LOAD = 16 PSF WIND SPEED = 96 MPH EXPOSURE C"));
  assert.ok(f, "the minimum finding must fire");
  assert.equal(f!.severity, "blocker");
  assert.match(f!.message, /stated 16 psf/);
  assert.match(f!.message, /minimum for prescriptive design is 36 psf \(ORSC 2023 R301\.2\.3\.1\)/);
  assert.match(f!.message, /human-verified by operator on 2026-09-24/);
});
await check("MUST-EXCLUDE: Lincoln City shape — engineered, 28 psf -> no finding (28 >= 25)", () => {
  assert.equal(minimum(run(project("City of Lincoln City", ENGINEERED), orCtx("City of Lincoln City"), "GROUND SNOW LOAD (Pg) = 28 PSF ULTIMATE WIND SPEED = 120 MPH EXPOSURE D")), undefined);
});
await check("MUST-PASS: engineered, 20 psf -> BLOCKER against the 25 psf non-prescriptive minimum", () => {
  const f = minimum(run(project("City of Testport", ENGINEERED), orCtx("City of Testport"), "GROUND SNOW LOAD = 20 PSF"));
  assert.ok(f && f.severity === "blocker", f?.message);
  assert.match(f!.message, /minimum for non-prescriptive \(engineered\) design is 25 psf/);
});
await check("MUST-PASS: Pg(asd) 20 with Pg 28 is judged on 28 (prescriptive -> blocker naming 28 only; engineered -> none)", () => {
  const text = "SNOW: Pg = 28 psf, Pg(asd) = 20 psf";
  const f = minimum(run(project("City of Testport", PRESCRIPTIVE), orCtx("City of Testport"), text));
  assert.ok(f && f.severity === "blocker", f?.message);
  assert.match(f!.message, /stated 28 psf/);
  assert.doesNotMatch(f!.message, /\b20 psf/);
  assert.equal(minimum(run(project("City of Testport", ENGINEERED), orCtx("City of Testport"), text)), undefined, "the Pg(asd) 20 is not a Pg below 25");
});
await check("MUST-EXCLUDE: roof snow 20 with Pg 40 is judged on 40 -> no finding on either path", () => {
  const text = "GROUND SNOW LOAD = 40 PSF ROOF SNOW LOAD = 20 PSF";
  assert.equal(minimum(run(project("City of Testport", PRESCRIPTIVE), orCtx("City of Testport"), text)), undefined);
  assert.equal(minimum(run(project("City of Testport", ENGINEERED), orCtx("City of Testport"), text)), undefined);
});
await check("MUST-PASS: a SEEDED row carrying the minimum -> WARNING, never a blocker", () => {
  const f = minimum(run(project("City of Coos Bay", PRESCRIPTIVE), orCtx("City of Coos Bay", { confidence: "seeded", verifiedBy: undefined, verifiedAt: undefined }), "GROUND SNOW LOAD = 16 PSF"));
  assert.ok(f && f.severity === "warning", f?.severity);
  assert.match(f!.message, /seeded/);
});
await check("MUST-PASS: unknown path at 30 psf -> WARNING against the stricter 36, naming the unknown path and both minimums", () => {
  const f = minimum(run(project("City of Testport"), orCtx("City of Testport"), "GROUND SNOW LOAD = 30 PSF"));
  assert.ok(f && f.severity === "warning", f?.severity);
  assert.match(f!.message, /is 36 psf/);
  assert.match(f!.message, /permit path is unknown/);
  assert.match(f!.message, /36 psf prescriptive, 25 psf non-prescriptive/);
  assert.doesNotMatch(f!.cityFeedback, /below the minimum 36 psf/, "an unknown path must not tell the city 36 applies");
});
await check("MUST-EXCLUDE: unknown path at 36 psf, prescriptive at 36, engineered at 25 -> no finding (the minimum is not exceeded)", () => {
  assert.equal(minimum(run(project("City of Testport"), orCtx("City of Testport"), "GROUND SNOW LOAD = 36 PSF")), undefined);
  assert.equal(minimum(run(project("City of Testport", PRESCRIPTIVE), orCtx("City of Testport"), "GROUND SNOW LOAD = 36 PSF")), undefined);
  assert.equal(minimum(run(project("City of Testport", ENGINEERED), orCtx("City of Testport"), "GROUND SNOW LOAD = 25 PSF")), undefined);
});
await check("MUST-PASS: the operator's path override decides before the parser's reading", () => {
  const text = "GROUND SNOW LOAD = 28 PSF";
  assert.equal(minimum(run(project("City of Testport", { permitPath: "PRESCRIPTIVE", permitPathOverride: "engineered" }), orCtx("City of Testport"), text)), undefined);
  const f = minimum(run(project("City of Testport", { permitPath: "Non-prescriptive", permitPathOverride: "prescriptive" }), orCtx("City of Testport"), text));
  assert.ok(f && f.severity === "blocker", f?.message);
});
await check("MUST-PASS: a value only the PARSER read (no document says it) -> WARNING that says so", () => {
  const f = minimum(run(project("City of Testport", { ...PRESCRIPTIVE, snow: "16" }), orCtx("City of Testport"), null));
  assert.ok(f && f.severity === "warning", f?.severity);
  assert.match(f!.message, /Only the parser's reading/);
});
await check("MUST-EXCLUDE: no minimum on file -> no finding (another state's 16 psf plan)", () => {
  assert.equal(minimum(run(project("City of Testville", PRESCRIPTIVE, "WA"), buildCodeContext("WA", "City of Testville", profileOf("WA", "City of Testville", { prescriptive: { maxGroundSnowPsf: 70 } })), "GROUND SNOW LOAD = 16 PSF")), undefined);
});
await check("MUST-EXCLUDE: a minimum alone does not switch on the prescriptive screening (no loads-missing from the floor)", () => {
  const empty = "PV SYSTEM NOTES ONLY";
  const onlyMins = run(project("City of Testport", PRESCRIPTIVE), orCtx("City of Testport"), empty);
  assert.equal(onlyMins.find((f) => f.id === "city.struct.loads-missing"), undefined, "a floor is not a screening limit");
  const withLimit = run(project("City of Testport", PRESCRIPTIVE), orCtx("City of Testport", { prescriptive: { ...OR_MINS, maxGroundSnowPsf: 70 } }), empty);
  assert.ok(withLimit.find((f) => f.id === "city.struct.loads-missing"), "control: a real screening limit does raise loads-missing");
});
await check("MUST-PASS: the unknown-criteria callout says the ground snow was compared only with the minimum", () => {
  const f = run(project("City of Testport", PRESCRIPTIVE), orCtx("City of Testport"), "GROUND SNOW LOAD = 40 PSF").find((x) => x.id === "city.struct.design-criteria-unknown");
  assert.ok(f, "the unknown callout must still fire (no site Pg on file)");
  assert.match(f!.message, /compared only with the 36 psf minimum for prescriptive design, not with the site's own Pg/);
});

// r3r-close MF1: a load printed with NO colon before the ground snow label ("ROOF DEAD LOAD 3 PSF
// GROUND SNOW LOAD 36 PSF") was read as a second Pg — the value-first "3 PSF GROUND SNOW" — and the
// minimum finding turned it into a false BLOCKER on a correct plan. A label followed by its own value
// with its unit owns that value; the number before it is the other load's.
const { extractStatedDesignCriteria } = await import("../src/designCriteria");
const snowRead = (text: string, kind = "groundSnowPsf"): number[] =>
  extractStatedDesignCriteria(project("City of Testport"), [{ label: "Plan set", text }]).criteria
    .filter((c) => c.criterion === kind).map((c) => Number(c.value)).sort((a, b) => a - b);
await check("MUST-EXCLUDE (r3r-close): an unseparated load before the ground snow label is not a Pg — no minimum finding, no conflict", () => {
  const cases: Array<[string, number]> = [
    ["ROOF DEAD LOAD 3 PSF GROUND SNOW LOAD 36 PSF WIND SPEED 110 MPH EXPOSURE C", 36],
    ["PV DEAD LOAD 2.5 PSF GROUND SNOW LOAD 40 PSF", 40],
    ["DEAD LOAD 4 PSF GROUND SNOW 36 PSF", 36],
    ["ROOF LIVE LOAD 20 PSF GROUND SNOW LOAD 36 PSF", 36],
  ];
  for (const [text, pg] of cases) {
    assert.deepEqual(snowRead(text), [pg], `Pg read from: ${text}`);
    const fs = run(project("City of Coos Bay", PRESCRIPTIVE), orCtx("City of Coos Bay"), text);
    assert.equal(minimum(fs), undefined, `minimum finding on a correct plan: ${text}`);
    assert.equal(fs.find((f) => f.id === "city.struct.design-criteria-conflict"), undefined, `conflict on: ${text}`);
  }
  // The same rule for roof snow's value-first read.
  assert.deepEqual(snowRead("DEAD LOAD 4 PSF ROOF SNOW LOAD 25 PSF", "roofSnowPsf"), [25]);
});
await check("MUST-PASS (r3r-close): value-first and separated labels still read; a 16 psf plan with a dead load before it is the BLOCKER naming 16", () => {
  assert.deepEqual(snowRead("28 psf ground snow"), [28]);
  assert.deepEqual(snowRead("GROUND SNOW LOAD (Pg) = 28 PSF"), [28]);
  assert.deepEqual(snowRead("ROOF LIVE LOAD: 20 PSF GROUND SNOW LOAD: 25 PSF"), [25]);
  const f = minimum(run(project("City of Coos Bay", PRESCRIPTIVE), orCtx("City of Coos Bay"), "ROOF DEAD LOAD 3 PSF GROUND SNOW LOAD 16 PSF"));
  assert.ok(f && f.severity === "blocker", `${f?.severity}: ${f?.message}`);
  assert.match(f!.message, /stated 16 psf/);
  assert.doesNotMatch(f!.message, /\b3 psf/);
});

// r3f MF1: the fix above treated ANY unseparated "N PSF" after a snow label as that label's own, so a
// VALUE-FIRST list's next value was taken: "36 PSF GROUND SNOW 25 PSF ROOF SNOW 10 PSF DEAD LOAD" read
// Pg 25 alone, a clean below-the-minimum BLOCKER on a correct 36 psf plan. The run's own layout now
// decides (value-first: each value is the NEXT label's; label-first: the PREVIOUS label's); where the
// layout is ambiguous both readings stay, so the conflict shows. The extractor reads flattened text, so
// the vertical list and the one-line list are the same case.
const roofRead = (text: string): number[] => snowRead(text, "roofSnowPsf");
await check("MUST-PASS (r3f): a value-first design-loads list reads Pg 36 and roof snow 25 — no minimum finding, no conflict", () => {
  for (const text of [
    "DESIGN LOADS\n36 PSF GROUND SNOW\n25 PSF ROOF SNOW\n10 PSF DEAD LOAD",
    "DESIGN LOADS: 36 PSF GROUND SNOW 25 PSF ROOF SNOW 15 PSF DEAD LOAD",
  ]) {
    assert.deepEqual(snowRead(text), [36], `Pg read from: ${JSON.stringify(text)}`);
    assert.deepEqual(roofRead(text), [25], `roof snow read from: ${JSON.stringify(text)}`);
    const fs = run(project("City of Salem", PRESCRIPTIVE), orCtx("City of Salem"), text);
    assert.equal(minimum(fs), undefined, `minimum finding on a correct 36 psf plan: ${minimum(fs)?.message}`);
    assert.equal(fs.find((f) => f.id === "city.struct.design-criteria-conflict"), undefined, `conflict on: ${JSON.stringify(text)}`);
  }
  assert.deepEqual(snowRead("40 PSF GROUND SNOW LOAD 28 PSF FLAT ROOF SNOW LOAD"), [40]);
  assert.deepEqual(roofRead("40 PSF GROUND SNOW LOAD 28 PSF FLAT ROOF SNOW LOAD"), [28]);
  assert.deepEqual(roofRead("25 PSF ROOF SNOW 10 PSF DEAD LOAD"), [25], "the roof side of the same rule");
});
await check("MUST-PASS (r3f): label-first lists keep their own values — Pg 25 / roof 20; 16 over 3 with a load after it", () => {
  assert.deepEqual(snowRead("28 psf ground snow"), [28]);
  assert.deepEqual(snowRead("GROUND SNOW LOAD (Pg) = 28 PSF"), [28]);
  assert.deepEqual(snowRead("GROUND SNOW LOAD 25 PSF ROOF SNOW LOAD 20 PSF"), [25]);
  assert.deepEqual(roofRead("GROUND SNOW LOAD 25 PSF ROOF SNOW LOAD 20 PSF"), [20]);
  assert.deepEqual(snowRead("PV WEIGHT 2.8 PSF GROUND SNOW 36 PSF"), [36], "a weight is a load label too");
  for (const text of ["ROOF DEAD LOAD 3 PSF GROUND SNOW LOAD 16 PSF", "ROOF DEAD LOAD 3 PSF GROUND SNOW LOAD 16 PSF ROOF LIVE LOAD 20 PSF"]) {
    assert.deepEqual(snowRead(text), [16], text);
    const f = minimum(run(project("City of Coos Bay", PRESCRIPTIVE), orCtx("City of Coos Bay"), text));
    assert.ok(f && f.severity === "blocker", `${f?.severity}: ${f?.message}`);
    assert.match(f!.message, /stated 16 psf/);
    assert.doesNotMatch(f!.message, /\b3 psf/);
  }
});
await check("MUST-PASS (r3f): an AMBIGUOUS run keeps both readings, so a low value never stands alone — the conflict shows", () => {
  // One value left over either way: "36 PSF GROUND SNOW 25 PSF" then a label this reader does not know.
  const text = "DESIGN LOADS 36 PSF GROUND SNOW 25 PSF ROOF LIVE";
  assert.deepEqual(snowRead(text), [25, 36]);
  const fs = run(project("City of Salem", PRESCRIPTIVE), orCtx("City of Salem"), text);
  assert.ok(fs.find((f) => f.id === "city.struct.design-criteria-conflict"), "the two readings must show as a conflict");
});

// snow-inv item 1 (the structural invariant): the minimum — and the below-AHJ snow line, and a
// two-document conflict — is a BLOCKER only when the stated Pg is UNAMBIGUOUS (one predicate,
// readGroundSnow / statedGroundSnowReading). At 2dc7527 the ambiguous run below produced a
// design-criteria-conflict warning AND a ground-snow-below-state-minimum BLOCKER naming 25.
const { statedGroundSnowReading } = await import("../src/designCriteria");
const AMBIGUOUS = "DESIGN LOADS 36 PSF GROUND SNOW 25 PSF"; // a heading, then V L V: one value left over either way
await check("MUST-PASS (snow-inv): an ambiguous Pg is never a minimum BLOCKER — a WARNING naming both readings", () => {
  const r = statedGroundSnowReading(project("City of Salem"), [{ label: "Plan set", text: AMBIGUOUS }]);
  assert.equal(r.status, "ambiguous");
  const f = minimum(run(project("City of Salem", PRESCRIPTIVE), orCtx("City of Salem"), AMBIGUOUS));
  assert.ok(f, "the low reading is still surfaced");
  assert.equal(f!.severity, "warning", f!.message);
  assert.match(f!.message, /25 psf in Plan set/);
  assert.match(f!.message, /36 psf in Plan set/);
  assert.match(f!.message, /reads more than one way/);
});
await check("MUST-PASS (snow-inv): the below-AHJ snow line asks the same predicate — ambiguous Pg under a verified 36 psf AHJ value is a WARNING", () => {
  const ctx = orCtx("City of Salem", { designCriteria: { groundSnowLoadPsf: 36 } });
  const f = run(project("City of Salem", PRESCRIPTIVE), ctx, AMBIGUOUS).find((x) => x.id === "city.struct.design-criteria-below-ahj");
  assert.ok(f, "the below-AHJ finding must still show the low reading");
  assert.equal(f!.severity, "warning", f!.message);
  assert.match(f!.message, /Ground snow load: stated 25 psf in Plan set — /);
  assert.match(f!.message, /reads more than one way \([^)]*36 psf in Plan set/);
  // Control: an unambiguous 16 psf under the same verified AHJ value is still the BLOCKER, and a wind
  // line below the AHJ still blocks beside an ambiguous snow line.
  const g = run(project("City of Salem", PRESCRIPTIVE), ctx, "GROUND SNOW LOAD = 16 PSF").find((x) => x.id === "city.struct.design-criteria-below-ahj");
  assert.equal(g?.severity, "blocker", g?.message);
  const w = run(project("City of Salem", PRESCRIPTIVE), orCtx("City of Salem", { designCriteria: { groundSnowLoadPsf: 36, windSpeedMph: 120 } }), `${AMBIGUOUS} WIND SPEED = 100 MPH`).find((x) => x.id === "city.struct.design-criteria-below-ahj");
  assert.equal(w?.severity, "blocker", w?.message);
});
await check("MUST-PASS (snow-inv): two documents that disagree only through an unsure reading are a conflict WARNING, and the minimum a WARNING", () => {
  const fs = evaluateDesignCodeFindings(project("City of Salem", PRESCRIPTIVE), null, orCtx("City of Salem"), [], [
    { label: "Plan set", text: AMBIGUOUS },
    { label: "Engineer letter", text: "GROUND SNOW LOAD = 36 PSF" },
  ]);
  assert.equal(fs.find((f) => f.id === "city.struct.design-criteria-conflict")?.severity, "warning");
  assert.equal(minimum(fs)?.severity, "warning", minimum(fs)?.message);
  // Control: two documents that SURELY disagree (16 vs 36) keep the conflict BLOCKER; the minimum is
  // a warning then (the package states two Pg values), naming both.
  const two = evaluateDesignCodeFindings(project("City of Salem", PRESCRIPTIVE), null, orCtx("City of Salem"), [], [
    { label: "Plan set", text: "GROUND SNOW LOAD = 16 PSF" },
    { label: "Engineer letter", text: "GROUND SNOW LOAD = 36 PSF" },
  ]);
  assert.equal(two.find((f) => f.id === "city.struct.design-criteria-conflict")?.severity, "blocker");
  assert.equal(minimum(two)?.severity, "warning");
  assert.match(minimum(two)!.message, /16 psf in Plan set; 36 psf in Engineer letter/);
});

console.log("\n2. which ROW carried the minimum decides the severity (real write path, temp DB)");

const { openDatabase } = await import("../src/db");
const CP = await import("../src/codeProfiles");
const db = await openDatabase();
const row = (state: string, ahj: string, over: Partial<JurisdictionCodeProfile> = {}): JurisdictionCodeProfile => ({
  key: "", state, ahj, confidence: "seeded", adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {},
  fireSetbacks: [], citations: [], updatedAt: "", ...over,
});

await check("MUST-PASS: the shipped Oregon state row carries 36 / 25 psf and the ORSC citation", () => {
  const or = CP.getCodeProfile(db, { state: "OR", ahj: "" });
  assert.ok(or, "the reference seed must create the Oregon state row");
  assert.equal(or!.confidence, "verified");
  assert.equal(or!.prescriptive.minGroundSnowPsfPrescriptive, 36);
  assert.equal(or!.prescriptive.minGroundSnowPsfEngineered, 25);
  assert.equal(or!.prescriptive.minGroundSnowCitation, "ORSC 2023 R301.2.3.1");
});
await check("MUST-PASS: a SEEDED Coos Bay row over the VERIFIED state row -> BLOCKER (the state's row carried the minimum)", () => {
  CP.saveResearchedCodeProfile(db, row("OR", "City of Coos Bay", { adoptedCodes: [{ code: "IRC", edition: "2023", title: "2023 Oregon Residential Specialty Code (ORSC)" }] }));
  const ctx = CP.resolveEffectiveCodeContext(db, "OR", "City of Coos Bay");
  assert.equal(ctx.verified, false, "precondition: the merged profile reads seeded (the weaker layer)");
  assert.equal(ctx.profile?.fieldSources?.["prescriptive.minGroundSnowPsfPrescriptive"]?.ahj, "", "the minimum came from the state row");
  const f = minimum(run(project("City of Coos Bay", PRESCRIPTIVE), ctx, "GROUND SNOW LOAD = 16 PSF"));
  assert.ok(f && f.severity === "blocker", `${f?.severity}: ${f?.message}`);
  assert.match(f!.message, /OR state-level code profile \(verified via the shipped reference seed/);
});
await check("MUST-PASS: a VERIFIED city row over a SEEDED state minimum -> WARNING (the seeded state row carried it)", () => {
  CP.saveResearchedCodeProfile(db, row("ID", "", { prescriptive: { minGroundSnowPsfPrescriptive: 30, minGroundSnowPsfEngineered: 20 } }));
  CP.saveVerifiedCodeProfile(db, row("ID", "City of Testfalls", { confidence: "verified", designCriteria: { windSpeedMph: 115 } }), "operator");
  const ctx = CP.resolveEffectiveCodeContext(db, "ID", "City of Testfalls");
  assert.equal(ctx.profile?.fieldSources?.["prescriptive.minGroundSnowPsfPrescriptive"]?.confidence, "seeded");
  assert.equal(ctx.profile?.fieldSources?.["designCriteria.windSpeedMph"]?.confidence, "verified");
  const f = minimum(run(project("City of Testfalls", PRESCRIPTIVE, "ID"), ctx, "GROUND SNOW LOAD = 16 PSF"));
  assert.ok(f && f.severity === "warning", `${f?.severity}: ${f?.message}`);
  assert.match(f!.message, /ID state-level code profile \(seeded/);
});
await check("MUST-PASS: a VERIFIED city row carrying its OWN minimum over a seeded state -> BLOCKER, owned by the city", () => {
  CP.saveVerifiedCodeProfile(db, row("ID", "City of Testcreek", { confidence: "verified", prescriptive: { minGroundSnowPsfPrescriptive: 40 } }), "operator");
  const ctx = CP.resolveEffectiveCodeContext(db, "ID", "City of Testcreek");
  assert.equal(ctx.verified, false, "precondition: the merged profile reads seeded (the state row is seeded)");
  const f = minimum(run(project("City of Testcreek", PRESCRIPTIVE, "ID"), ctx, "GROUND SNOW LOAD = 35 PSF"));
  assert.ok(f && f.severity === "blocker", `${f?.severity}: ${f?.message}`);
  assert.match(f!.message, /City of Testcreek's minimum for prescriptive design is 40 psf/);
});

// r3r-close MF2: `npm run import:reference` merged each sheet row onto getCodeProfile's LAYERED read,
// so a seeded city row saved the verified state's 36/25 psf minimums as its OWN seeded values, and
// the state-minimum BLOCKER on a 16 psf prescriptive plan became a WARNING credited to the seeded
// city row. The import merges onto the AHJ's own row (resolveCriteriaWriteRow), never the layers.
const { importAhjCodesSheet } = await import("../src/referenceImport");
const sheet = (rows: Array<Record<string, string>>) => ({ name: "NEC_and_Inspection Codes", headers: ["Name", "State", "NEC"], rows });
const MIN_KEYS = ["minGroundSnowPsfPrescriptive", "minGroundSnowPsfEngineered", "minGroundSnowCitation"];
await check("MUST-PASS (r3r-close): the reference import onto a seeded Coos Bay row keeps the state's verified minimum a BLOCKER", () => {
  const summary = importAhjCodesSheet(db, sheet([{ Name: "City of Coos Bay", State: "OR", NEC: "2023 NEC" }]));
  assert.equal(summary.imported, 1, JSON.stringify(summary));
  const own = CP.exactCodeProfileRow(db, "OR", "City of Coos Bay")!.profile;
  assert.ok(own.adoptedCodes.some((c) => c.code === "NEC" && c.edition === "2023"), "the sheet's NEC landed");
  assert.ok(own.adoptedCodes.some((c) => c.code === "IRC"), "the row's own ORSC entry is kept");
  for (const k of MIN_KEYS) assert.equal((own.prescriptive as Record<string, unknown>)[k], undefined, `the city row's own payload gained the state's ${k}`);
  const ctx = CP.resolveEffectiveCodeContext(db, "OR", "City of Coos Bay");
  assert.equal(ctx.profile?.fieldSources?.["prescriptive.minGroundSnowPsfPrescriptive"]?.ahj, "", "the minimum is still the state row's");
  const f = minimum(run(project("City of Coos Bay", PRESCRIPTIVE), ctx, "GROUND SNOW LOAD = 16 PSF"));
  assert.ok(f && f.severity === "blocker", `${f?.severity}: ${f?.message}`);
  assert.match(f!.message, /OR state-level code profile \(verified/);
});
await check("MUST-PASS (r3r-close): a NEW Oregon city is imported (the verified state row no longer refuses it): the sheet's NEC and the state's code list, no criteria or limits", () => {
  const summary = importAhjCodesSheet(db, sheet([{ Name: "City of Testharbor", State: "OR", NEC: "2023 NEC" }]));
  assert.deepEqual([summary.imported, summary.skippedVerified], [1, 0], JSON.stringify(summary));
  const own = CP.exactCodeProfileRow(db, "OR", "City of Testharbor")!.profile;
  assert.equal(own.confidence, "seeded");
  assert.deepEqual(own.prescriptive, {}, "no state prescriptive block copied into the new row");
  assert.deepEqual(own.designCriteria, {}, "no state design criteria copied into the new row");
  assert.ok(own.adoptedCodes.some((c) => c.code === "NEC" && c.edition === "2023"), "the sheet's NEC is on the row");
  // A layered read takes an AHJ row's code list WHOLE: the new row keeps the state's codes, so the
  // city does not read as "NEC 2023" alone (it read the state's full list before the import).
  const layered = CP.getCodeProfile(db, { state: "OR", ahj: "City of Testharbor" })!.adoptedCodes.map((c) => c.code);
  for (const code of ["ORSC", "OESC"]) assert.ok(layered.includes(code), `the layered read lost the state's ${code}: ${layered.join(", ")}`);
});
await check("MUST-PASS (r3r-close): a sheet's 'City of Testbay' lands on the bare 'Testbay' row on file (same jurisdiction) — no second row", () => {
  CP.saveResearchedCodeProfile(db, row("OR", "Testbay", { amendments: [{ code: "AHJ", summary: "Imported Testbay amendment" }] }));
  importAhjCodesSheet(db, sheet([{ Name: "City of Testbay", State: "OR", NEC: "2023 NEC" }]));
  assert.equal(CP.exactCodeProfileRow(db, "OR", "City of Testbay"), null, "the import forked the jurisdiction into a second row");
  const bare = CP.exactCodeProfileRow(db, "OR", "Testbay")!.profile;
  assert.ok(bare.adoptedCodes.some((c) => c.code === "NEC" && c.edition === "2023"), "the sheet's NEC landed on the row on file");
  assert.ok(bare.amendments.some((a) => a.summary === "Imported Testbay amendment"), "the row's own amendment is kept");
  for (const k of MIN_KEYS) assert.equal((bare.prescriptive as Record<string, unknown>)[k], undefined, `the row gained the state's ${k}`);
});
await check("MUST-EXCLUDE (r3r-close): a VERIFIED city row owning its own 40 psf minimum is skipped by the import and still owns the BLOCKER", () => {
  CP.saveVerifiedCodeProfile(db, row("OR", "City of Testridge", { confidence: "verified", prescriptive: { minGroundSnowPsfPrescriptive: 40 } }), "operator");
  const summary = importAhjCodesSheet(db, sheet([{ Name: "City of Testridge", State: "OR", NEC: "2023 NEC" }]));
  assert.deepEqual([summary.imported, summary.skippedVerified], [0, 1], JSON.stringify(summary));
  const f = minimum(run(project("City of Testridge", PRESCRIPTIVE), CP.resolveEffectiveCodeContext(db, "OR", "City of Testridge"), "GROUND SNOW LOAD = 38 PSF"));
  assert.ok(f && f.severity === "blocker", `${f?.severity}: ${f?.message}`);
  assert.match(f!.message, /City of Testridge's minimum for prescriptive design is 40 psf/);
});
await check("MUST-EXCLUDE (r3r-close): a SEEDED city row with its own 45 psf minimum over a seeded state keeps it (a WARNING naming the city) and gains none of the state's fields", () => {
  CP.saveResearchedCodeProfile(db, row("NV", "", { prescriptive: { minGroundSnowPsfPrescriptive: 30, minGroundSnowPsfEngineered: 20 } }));
  CP.saveResearchedCodeProfile(db, row("NV", "City of Testvale", { prescriptive: { minGroundSnowPsfPrescriptive: 45 } }));
  importAhjCodesSheet(db, sheet([{ Name: "City of Testvale", State: "NV", NEC: "2023 NEC" }]));
  const own = CP.exactCodeProfileRow(db, "NV", "City of Testvale")!.profile;
  assert.deepEqual(own.prescriptive, { minGroundSnowPsfPrescriptive: 45 });
  const f = minimum(run(project("City of Testvale", PRESCRIPTIVE, "NV"), CP.resolveEffectiveCodeContext(db, "NV", "City of Testvale"), "GROUND SNOW LOAD = 40 PSF"));
  assert.ok(f && f.severity === "warning", `${f?.severity}: ${f?.message}`);
  assert.match(f!.message, /City of Testvale \(NV\) code profile \(seeded/);
});

await check("MUST-PASS: PUT /api/code-profiles/verify keeps the minimums (the verify schema does not strip them) and they round-trip", async () => {
  const { codeProfileVerifySchema } = await import("../src/validation");
  const body = codeProfileVerifySchema.parse({ state: "MT", ahj: "", prescriptive: { maxGroundSnowPsf: 70, ...OR_MINS } });
  assert.deepEqual(body.prescriptive, { maxGroundSnowPsf: 70, ...OR_MINS });
  const saved = CP.saveVerifiedCodeProfile(db, row("MT", "", { confidence: "verified", prescriptive: body.prescriptive }), "operator");
  assert.equal(saved.prescriptive.minGroundSnowPsfPrescriptive, 36);
  assert.equal(saved.prescriptive.minGroundSnowCitation, "ORSC 2023 R301.2.3.1");
  assert.throws(() => codeProfileVerifySchema.parse({ state: "MT", prescriptive: { minGroundSnowPsfPrescriptive: -5 } }), "a negative minimum is refused");
});

if (failures) {
  console.error(`\n${failures} state-minimum ground snow check(s) FAILED`);
  process.exit(1);
}
console.log("\nall state-minimum ground snow checks passed");
process.exit(0);
