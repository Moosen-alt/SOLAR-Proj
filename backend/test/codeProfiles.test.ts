// Jurisdiction code profiles: key resolution, layered county-over-state merge,
// verified-never-overwritten, and the EffectiveCodeContext contract the rule
// engines consume. Browser-free. Run: tsx backend/test/codeProfiles.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-profiles-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const {
  getCodeProfile, listCodeProfiles, saveResearchedCodeProfile, saveVerifiedCodeProfile,
  resolveEffectiveCodeContext, buildCodeContext, MODEL_CODE_DEFAULTS,
} = await import("../src/codeProfiles");

const db = await openDatabase();
// The boot seeder runs via a lazy import — give it a beat, then assert on it.
await new Promise((r) => setTimeout(r, 300));

let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};

await run("reference seed loads Oregon (verified) + Idaho/Elmore (seeded)", () => {
  const all = listCodeProfiles(db);
  assert.ok(all.length >= 4, `expected >=4 profiles, got ${all.length}`);
  const or = getCodeProfile(db, { state: "OR" })!;
  assert.equal(or.confidence, "verified");
  assert.equal(or.prescriptive.maxGroundSnowPsf, 70);
  assert.equal(or.prescriptive.maxPvDeadLoadPsf, 4.5);
  assert.deepEqual(or.prescriptive.allowedWindExposures, ["B", "C"]);
  const elmore = getCodeProfile(db, { state: "ID", ahj: "Elmore County" })!;
  assert.equal(elmore.confidence, "seeded");
});

await run("county layer inherits state adopted codes (Elmore over Idaho)", () => {
  const elmore = getCodeProfile(db, { state: "ID", ahj: "Elmore County" })!;
  assert.ok(elmore.adoptedCodes.some((c) => c.code === "NEC"), "NEC inherited from ID state default");
  assert.ok(elmore.citations.some((c) => /elmore/i.test(c.label)), "county citations kept");
});

await run("unknown AHJ falls back to the state default; unknown state → null", () => {
  const boise = getCodeProfile(db, { state: "ID", ahj: "City of Boise" })!;
  assert.ok(boise, "state fallback");
  assert.equal(boise.ahj, "", "state-level row");
  assert.equal(getCodeProfile(db, { state: "WY", ahj: "Cheyenne" }), null);
});

await run("EffectiveCodeContext: verified vs seeded vs defaults phrasing", () => {
  const or = resolveEffectiveCodeContext(db, "OR", "Salem");
  assert.equal(or.source, "verified");
  const cite = or.citationFor("NEC", "690.12", "Rapid shutdown");
  assert.ok(cite.code.includes("2023"), `adopted edition in citation (${cite.code})`);
  assert.ok(/adopted/i.test(cite.adoptionScope));

  const elmore = resolveEffectiveCodeContext(db, "ID", "Elmore County");
  assert.equal(elmore.source, "seeded");
  assert.equal(elmore.verified, false);
  assert.ok(/verify locally/i.test(elmore.citationFor("NEC", "690.12", "Rapid shutdown").adoptionScope));

  const unknown = resolveEffectiveCodeContext(db, "WY", "Cheyenne");
  assert.equal(unknown.source, "defaults");
  assert.equal(unknown.adoptedCodes, MODEL_CODE_DEFAULTS);
  assert.ok(/verify/i.test(unknown.citationFor("IRC", "R324", "Rooftop PV").adoptionScope + unknown.citationFor("IRC", "R324", "Rooftop PV").note));
});

await run("research NEVER downgrades a verified row; verify upgrades a seeded one", () => {
  const or = getCodeProfile(db, { state: "OR" })!;
  saveResearchedCodeProfile(db, { ...or, prescriptive: { ...or.prescriptive, maxGroundSnowPsf: 999 } });
  const after = getCodeProfile(db, { state: "OR" })!;
  assert.equal(after.confidence, "verified", "still verified");
  assert.equal(after.prescriptive.maxGroundSnowPsf, 70, "verified values untouched by research");

  const elmoreBefore = getCodeProfile(db, { state: "ID", ahj: "Elmore County" })!;
  saveVerifiedCodeProfile(db, { ...elmoreBefore, designCriteria: { ...elmoreBefore.designCriteria, groundSnowLoadPsf: 35 } }, "test-operator");
  // Re-read the RAW county row (merged confidence dilutes via the seeded ID state row).
  const rows = listCodeProfiles(db).filter((p) => p.ahj === "Elmore County");
  assert.equal(rows[0].confidence, "verified");
  assert.equal(rows[0].designCriteria.groundSnowLoadPsf, 35);
});

await run("buildCodeContext is pure and honors a null profile", () => {
  const ctx = buildCodeContext("TX", "Austin", null);
  assert.equal(ctx.source, "defaults");
  assert.equal(ctx.profile, null);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} code-profile test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll code-profile tests passed.`);
process.exit(0);
