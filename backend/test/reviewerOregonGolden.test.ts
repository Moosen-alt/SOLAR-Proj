// GOLDEN test for the Oregon reviewer report. Captured from the engine BEFORE the
// data-driven-rules refactor; the refactor must reproduce this byte-identically
// (minus generatedAt) — blocker counts gate staging, so any drift is a regression.
//
// Fixture is deliberately adversarial: it trips the prescriptive screens
// (snow 85 > 70, dead load 5 > 4.5, rafter 32 > 24, wind D, 60 kW DC > 50 stamp,
// 30 kW export > 25) plus PGE utility checks, on a Portland AHJ so the
// Portland-specific rafter guidance applies.
//
// Regenerate ONLY when a behavior change is intended:
//   UPDATE_GOLDEN=1 tsx backend/test/reviewerOregonGolden.test.ts
// Run: tsx backend/test/reviewerOregonGolden.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ProjectRecord } from "../../shared/src/types";
import { buildReviewerReport } from "../src/reviewerEngine";

const fixture = {
  id: "golden-or-1",
  clientId: "client-golden",
  homeownerName: "Golden Test",
  projectAddress: "123 Snowy Ridge Rd",
  city: "Portland",
  state: "OR",
  zip: "97201",
  ahj: "Portland",
  utility: "PGE",
  accountNumber: "1234567890",
  meterNumber: "987654",
  systemSizeDcKw: 60,
  systemSizeAcKw: 48,
  interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    // evaluateBaselineRules reads jurisdiction from the payload itself.
    state: "OR",
    ahj: "Portland",
    utility: "PGE",
    dcKw: "60",
    acKw: "48",
    exportKw: "30",
    snow: "85",
    deadLoad: "5",
    roofRafterSpacing: "32",
    wind: "D",
    busRating: "200",
    mainBreaker: "200",
    pvBreaker: "70",
    moduleMake: "Qcells",
    moduleModel: "Q.TRON BLK M-G2+",
    moduleWattage: "430",
    moduleQty: "140",
    inverterModel: "IQ8M",
    homeownerEmail: "golden@test.example",
    homeownerPhone: "(503) 555-0100",
    permitPath: "prescriptive",
    splitPagesText: "one-line diagram rapid shutdown site plan roof plan",
    projectDescriptionText: "Roof-mounted PV, load side interconnection.",
  },
} as unknown as ProjectRecord;

import { evaluateBaselineRules } from "../src/baselineRules";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname — the pathname form ("/C:/Users/…") re-resolves
// against the cwd drive on Windows and yields "C:\C:\Users\…" (ENOENT).
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const goldenPath = path.join(fixturesDir, "reviewerOregonGolden.json");
const baselineGoldenPath = path.join(fixturesDir, "baselineOregonGolden.json");

function normalized(): unknown {
  const report = buildReviewerReport(fixture);
  return JSON.parse(JSON.stringify({ ...report, generatedAt: "<normalized>" }));
}

// The QC-side rule engine (evaluateBaselineRules) carries its own hardcoded Oregon
// thresholds — golden it too so the data-driven refactor can't drift it either.
function baselineNormalized(): unknown {
  return JSON.parse(JSON.stringify(evaluateBaselineRules((fixture as unknown as { parserSnapshot: never }).parserSnapshot)));
}

if (process.env.UPDATE_GOLDEN === "1") {
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.writeFileSync(goldenPath, JSON.stringify(normalized(), null, 2));
  fs.writeFileSync(baselineGoldenPath, JSON.stringify(baselineNormalized(), null, 2));
  console.log(`goldens written: ${goldenPath}, ${baselineGoldenPath}`);
  process.exit(0);
}

let failures = 0;
try {
  assert.deepEqual(normalized(), JSON.parse(fs.readFileSync(goldenPath, "utf8")));
  const actual = normalized() as { findings: Array<{ severity: string }> };
  const blockers = actual.findings.filter((f) => f.severity === "blocker").length;
  console.log(`  ok   - Oregon reviewer golden matches (${actual.findings.length} findings, ${blockers} blockers)`);
} catch (err) {
  failures++;
  console.error("  FAIL - Oregon reviewer golden drifted. If the change is INTENDED, regenerate with UPDATE_GOLDEN=1.");
  console.error(err instanceof Error ? err.message.slice(0, 4000) : String(err));
}
try {
  assert.deepEqual(baselineNormalized(), JSON.parse(fs.readFileSync(baselineGoldenPath, "utf8")));
  console.log(`  ok   - Oregon baseline-QC golden matches (${(baselineNormalized() as unknown[]).length} results)`);
} catch (err) {
  failures++;
  console.error("  FAIL - Oregon baseline-QC golden drifted. If the change is INTENDED, regenerate with UPDATE_GOLDEN=1.");
  console.error(err instanceof Error ? err.message.slice(0, 4000) : String(err));
}
// --- Data-driven jurisdiction checks (non-golden) ---------------------------
// The same fixture reviewed under an IDAHO seeded profile with prescriptive limits:
// screens fire with state-prefixed ids and SOFTENED severity (seeded ≠ verified).
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";

try {
  const idahoSeeded = buildCodeContext("ID", "Elmore County", {
    key: "id|elmore county|unknown", state: "ID", ahj: "Elmore County", confidence: "seeded",
    adoptedCodes: [{ code: "NEC", edition: "2023" }, { code: "IRC", edition: "2018" }],
    amendments: [], designCriteria: {}, fireSetbacks: [], citations: [], updatedAt: "",
    prescriptive: { maxGroundSnowPsf: 40, maxRafterSpacingIn: 24 },
  });
  const idahoPayload = { ...(fixture as unknown as { parserSnapshot: Record<string, string> }).parserSnapshot, state: "ID", ahj: "Elmore County", utility: "Idaho Power" };
  const results = evaluateBaselineRules(idahoPayload as never, idahoSeeded);
  assert.ok(results.some((r) => r.ruleId === "id-prescriptive-snow"), `Idaho snow screen fires with state-prefixed id (${results.map((r) => r.ruleId).join(",")})`);
  assert.ok(!results.some((r) => r.ruleId.startsWith("or-")), "no Oregon ids under an Idaho context");
  assert.ok(results.some((r) => /Elmore County prescriptive 40 psf/.test(r.message)), "threshold + jurisdiction from the profile");

  const idProject = { ...(fixture as Record<string, unknown>), state: "ID", ahj: "Elmore County", parserSnapshot: idahoPayload } as never;
  const findings = evaluateDesignCodeFindings(idProject, null, idahoSeeded);
  const span = findings.find((f) => f.id === "city.struct.span-table-incomplete");
  assert.ok(span, "prescriptive span screening applies to Idaho with recorded limits");
  assert.equal(span!.severity, "warning", "SEEDED profile softens the blocker to a warning");
  assert.ok(span!.message.includes("Elmore County"), "message names the jurisdiction");
  const sld = findings.find((f) => f.id === "city.plan.sld-missing");
  assert.ok(sld && sld.codeReferences.some((c) => c.code.includes("2023 NEC") && /verify locally/i.test(c.adoptionScope)), "citations render the adopted edition with verify-locally phrasing");
  assert.ok(!findings.some((f) => f.codeReferences.some((c) => /oregon/i.test(c.adoptionScope) && !/verify/i.test(c.adoptionScope))), "no bare Oregon-scoped citations at an Idaho county");
  console.log(`  ok   - Idaho seeded context: data-driven screens, softened severity, adopted-edition citations`);
} catch (err) {
  failures++;
  console.error("  FAIL - Idaho data-driven context checks");
  console.error(err instanceof Error ? err.message.slice(0, 2000) : String(err));
}

// Unknown jurisdiction, no profile: model-code defaults, NO prescriptive screens.
try {
  const unknownCtx = buildCodeContext("WY", "Cheyenne", null);
  const wyPayload = { ...(fixture as unknown as { parserSnapshot: Record<string, string> }).parserSnapshot, state: "WY", ahj: "Cheyenne", utility: "Rocky Mountain Power" };
  const results = evaluateBaselineRules(wyPayload as never, unknownCtx);
  assert.ok(!results.some((r) => /prescriptive/.test(r.ruleId)), "no prescriptive screens without recorded limits");
  console.log(`  ok   - unknown jurisdiction: defaults context, no phantom prescriptive screens`);
} catch (err) {
  failures++;
  console.error("  FAIL - unknown-jurisdiction checks");
  console.error(err instanceof Error ? err.message.slice(0, 2000) : String(err));
}

// A COMPLETE PACKAGE MUST NOT BE BLOCKED FOR "No split mapping found".
//
// The plan-set requirement was decided from parser TEXT (splitPagesText /
// utilityDownloadChecklistText / projectDescriptionText). Those are a proxy for "a package
// was produced", and the proxy reads MISSING for a project that holds every split document.
// Live: Abby Johnson (Happy Valley) had plan_set, sld, site_plan, module_spec, inverter_spec
// and five more attached, and staging was hard-blocked with "No split mapping found" —
// unclearable from the UI, because nothing an operator can type creates parser text.
//
// Built on its own fixture, not the Oregon golden: that one's profile never raises this
// finding, so asserting "no blocker" against it passed vacuously and proved nothing.
try {
  const happyValley = {
    id: "t1", homeownerName: "Plan Set Test", projectAddress: "1 Test St", city: "Happy Valley",
    state: "OR", zip: "97086", ahj: "City Of Happy Valley", utility: "PGE",
    parserSnapshot: { splitPagesText: "", utilityDownloadChecklistText: "", projectDescriptionText: "" },
  } as never;
  const planSetBlocker = (types: string[]): boolean =>
    buildReviewerReport(happyValley, { uploadedDocTypes: types })
      .findings.some((f) => f.id === "reviewer.profile.plan-set" && f.severity === "blocker");

  // The control: with nothing attached this MUST block, or the assertions below are vacuous.
  assert.ok(planSetBlocker([]), "a project with no package at all must still be blocked");
  assert.ok(planSetBlocker(["meter_photo", "utility_bill"]), "a meter photo and a bill are not a plan set");
  // And with a package present it must not.
  assert.ok(!planSetBlocker(["plan_set", "sld", "site_plan", "module_spec"]),
    "a project holding the split package was still blocked for a missing plan set");
  assert.ok(!planSetBlocker(["sld", "site_plan"]),
    "the split documents alone should satisfy the plan-set requirement");
  console.log("  ok   - plan-set requirement is settled by the attached documents, not parser text");
} catch (err) {
  failures++;
  console.error("  FAIL - plan-set requirement vs attached documents");
  console.error(err instanceof Error ? err.message.slice(0, 2000) : String(err));
}

if (failures > 0) process.exit(1);
console.log("\nAll reviewer-golden tests passed.");
