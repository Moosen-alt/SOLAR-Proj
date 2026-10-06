// THE MPU RIDES ON THE ELECTRICAL PERMIT (operator ruling 2026-09-28, City of Corvallis).
// A main panel / service upgrade in scope is filed on the job's electrical (or combination) permit —
// on Corvallis it was the electrical permit's "Service 0-200 amps" line, "not a separate permit". It
// gets its own tracked permit only when the AHJ's process notes say it needs one. Before this, every
// MPU job got a separate "mpu" track unless the notes said it folded — a track nothing ever files,
// which held the project open after both real permits were in.
//   npx tsx backend/test/mpuOnElectricalPermit.test.ts
import assert from "node:assert/strict";
import type { ProjectRecord } from "../../shared/src/types";
import { requiredTracks } from "../src/submittalTracks";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const MPU_SCOPE = "Install roof-mounted PV system, 12 modules. Main panel upgrade to 200A.";
const project = (ahj: string, state: string, description = MPU_SCOPE, extra: Record<string, unknown> = {}): ProjectRecord =>
  ({
    id: "p-mpu", name: "Example", homeownerName: "Example Owner", address: "1 Example St", city: ahj, state, ahj, utility: "Example Utility",
    parserSnapshot: { electricalCalcText: description, ...extra },
  }) as unknown as ProjectRecord;

// The shipped AHJ process profiles (backend/data/reference-ahj-processes.json) are the notes read.
check("no AHJ note: an MPU job files NO separate mpu track (it rides on the electrical/combo permit)", () => {
  const tracks = requiredTracks(project("Sampletown", "OR"));
  assert.ok(!tracks.includes("mpu"), `tracks ${JSON.stringify(tracks)}`);
  assert.ok(tracks.includes("combo") || tracks.includes("electrical"), `no electrical-bearing permit: ${JSON.stringify(tracks)}`);
});
check("Beaverton ('can go under one electric trade permit'): no mpu track", () => {
  assert.ok(!requiredTracks(project("Beaverton", "OR")).includes("mpu"));
});
check("Wasco County ('mpu need to fill out separate epa'): the MPU gets its own track", () => {
  const tracks = requiredTracks(project("Wasco County", "OR"));
  assert.ok(tracks.includes("mpu"), `tracks ${JSON.stringify(tracks)}`);
});
check("Santa Fe ('mpu requires electrical permit to be pulled') on a combination-permit job: its own track", () => {
  const tracks = requiredTracks(project("Santa Fe", "NM"));
  if (tracks.includes("electrical")) {
    // Santa Fe filed separately: the electrical permit carries the MPU.
    assert.ok(!tracks.includes("mpu"), `separate electrical permit, but an mpu track too: ${JSON.stringify(tracks)}`);
  } else {
    assert.ok(tracks.includes("mpu"), `combination job, no mpu track: ${JSON.stringify(tracks)}`);
  }
});
check("Irving ('if mpu, no photos') says nothing about a permit: no mpu track", () => {
  assert.ok(!requiredTracks(project("Irving", "TX")).includes("mpu"));
});
check("a job with no MPU scope never gets an mpu track, even where the AHJ wants a separate one", () => {
  assert.ok(!requiredTracks(project("Wasco County", "OR", "Install roof-mounted PV system, 12 modules.")).includes("mpu"));
});

if (failures) { console.error(`\n${failures} MPU-track check(s) FAILED.`); process.exit(1); }
console.log("\nAll MPU-on-the-electrical-permit checks passed.");
process.exit(0);
