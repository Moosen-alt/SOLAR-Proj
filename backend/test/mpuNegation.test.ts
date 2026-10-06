// A NEGATED OR GENERATED MENTION IS NOT A MAIN PANEL / SERVICE UPGRADE (#200).
// snapshotHasMpuScope read "no MSP upgrade and no main breaker derate" as an MPU ("msp upgrade" matched
// inside "NO msp upgrade") in projectDescriptionText — a parser-written summary that, like every scope
// blob, states absences plainly. All four readers of that one predicate then called the job an MPU:
// the reviewer's installer.mpu-permit callout, the MPU permit track, the packet's MPU line, and the
// electrical service fee lines — and the KB's own copy of the regex tagged it scope:mpu. Synthetic
// text only.
//
// KNOWN GAPS (still read as an upgrade; the guard looks for a negator word, not for meaning):
//   "Panel upgrade: not anticipated", "Main panel upgrade was considered but rejected",
//   "MPU avoided by derate", "MPU unnecessary".
//   npx tsx backend/test/mpuNegation.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mpu-negation-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "test.db");

const { snapshotHasMpuScope } = await import("../src/serviceScope");
const { serviceFeeder200Quantity } = await import("../src/batteryServiceFeeder");
const { extractProjectFeatureTags } = await import("../src/knowledgeBase");
const { requiredTracks } = await import("../src/submittalTracks");
const { buildReviewerReport } = await import("../src/reviewerEngine");
const { buildApplicationDocumentPackage } = await import("../src/applicationDocs");
type ProjectRecord = import("../../shared/src/types").ProjectRecord;

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const MUST_PASS = ["200A main panel upgrade", "MPU 125A→200A", "service upgrade to 200 A"];
const MUST_EXCLUDE = [
  "no MSP upgrade and no main breaker derate",
  "MPU: none",
  "without a service panel upgrade",
  "N/A - no panel upgrade",
];

// ---- the predicate -------------------------------------------------------------------------------
for (const t of MUST_PASS) {
  check(`predicate: "${t}" on the one-line is an upgrade`, () => {
    assert.equal(snapshotHasMpuScope({ electricalCalcText: `Line side tap at the meter-main. ${t}.` }), true);
  });
}
for (const t of MUST_EXCLUDE) {
  check(`predicate: "${t}" is NOT an upgrade`, () => {
    assert.equal(snapshotHasMpuScope({ electricalCalcText: `Supply-side tap at the 125 A meter-main; ${t}.` }), false);
    assert.equal(snapshotHasMpuScope({ sitePlanNotesText: t }), false);
  });
}
check("predicate: an unrelated 'no' in another clause does not cancel a stated upgrade", () => {
  assert.equal(snapshotHasMpuScope({ electricalCalcText: "No batteries, MPU to 200A." }), true);
  assert.equal(snapshotHasMpuScope({ electricalCalcText: "No derate and main panel upgrade to 225A bus." }), true);
});
check("predicate: projectDescriptionText is read through the same guard (negated → false, affirmed → true)", () => {
  assert.equal(snapshotHasMpuScope({ projectDescriptionText: "7.2 kW roof mount, supply-side tap; no MSP upgrade and no main breaker derate." }), false);
  assert.equal(snapshotHasMpuScope({ projectDescriptionText: "7.2 kW roof mount; main panel upgrade to 200A." }), true);
});

// ---- end to end: all four readers ----------------------------------------------------------------
// Wasco County's shipped process note ("mpu need to fill out separate epa") gives an MPU job its own
// track, so a false positive there is visible.
const project = (snapshot: Record<string, unknown>): ProjectRecord =>
  ({
    id: "p-mpu-neg", clientId: "client-x", name: "Example", homeownerName: "Example Owner",
    address: "1 Example St", projectAddress: "1 Example St", city: "The Dalles", state: "OR", zip: "97058",
    ahj: "Wasco County", utility: "Example Utility", systemSizeDcKw: 7.2, systemSizeAcKw: 6,
    interconnectionMethod: "Supply-side tap", status: "pending",
    parserSnapshot: { state: "OR", ahj: "Wasco County", hasBattery: "No", ...snapshot },
  }) as unknown as ProjectRecord;

const NEGATED = project({
  projectDescriptionText: "7.2 kW roof mount, supply-side breaker at the existing 240 V/125 A meter-main; no MSP upgrade and no main breaker derate. no batteries.",
  electricalCalcText: "SLD E-1: supply-side tap, 40 A breaker; MPU: none.",
  sitePlanNotesText: "Site plan PV-2: N/A - no panel upgrade.",
});
const AFFIRMED = project({ electricalCalcText: "SLD E-1: MPU 125A→200A, new 200A main breaker." });
const AFFIRMED_SCOPE_ONLY = project({ projectDescriptionText: "7.2 kW roof mount; main panel upgrade to a new 200A main breaker." });

const readers = (p: ProjectRecord) => {
  const findings = buildReviewerReport(p).findings ?? [];
  const pkg = buildApplicationDocumentPackage(p);
  return {
    callout: findings.some((f) => f.id === "installer.mpu-permit"),
    track: requiredTracks(p).includes("mpu"),
    packetLine: pkg.docs.some((d) => /main panel\/service upgrade \(MPU\) is in scope/.test(d.markdown)),
    // The typed fee box: "Service 0-200 amps (qty)".
    feeLine: serviceFeeder200Quantity(p.parserSnapshot as Record<string, unknown>) !== "0",
    kbTag: extractProjectFeatureTags(p).includes("scope:mpu"),
  };
};

check("control: a stated MPU reaches every reader (callout, track, packet line, fee box, KB tag)", () => {
  assert.deepEqual(readers(AFFIRMED), { callout: true, track: true, packetLine: true, feeLine: true, kbTag: true });
});
check("control: an MPU stated only in projectDescriptionText still reaches every reader", () => {
  assert.deepEqual(readers(AFFIRMED_SCOPE_ONLY), { callout: true, track: true, packetLine: true, feeLine: true, kbTag: true });
});
check("negated mentions: no installer.mpu-permit finding, no mpu track, no packet MPU line, service fee box 0, no scope:mpu tag", () => {
  assert.deepEqual(readers(NEGATED), { callout: false, track: false, packetLine: false, feeLine: false, kbTag: false });
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} MPU-negation check(s) FAILED.`); process.exit(1); }
console.log("\nAll MPU-negation checks passed.");
process.exit(0);
