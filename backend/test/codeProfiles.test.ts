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

const db = await openDatabase(); // reference seed is awaited inside openDatabase

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

// ---------------------------------------------------------------------------
// ONE STATE'S CODE IS NOT ANOTHER'S AUTHORITY. The rules carry Oregon fallbacks
// (ORSC sections, oregon.gov/bcd links) because they were written for Oregon.
// Audited 2026-09-22: Cape Coral was cited the Oregon Residential Specialty Code,
// and a Florida NEC citation hyperlinked Oregon BCD as its source.
// ---------------------------------------------------------------------------
const OREGON_FALLBACK = {
  code: "ORSC",
  section: "R324.4.1",
  title: "Rooftop-mounted photovoltaic systems",
  adoptionScope: "Oregon residential prescriptive path.",
  sourceUrl: "https://www.oregon.gov/bcd/Formslibrary/5952.pdf",
  note: "Oregon worksheet.",
};

const isOregonSource = (url: string) => /oregon|\bbcd\b|orsc|ossc|oar\s*918/i.test(url);

await run("MUST PASS: an Oregon source URL never becomes a Florida citation's authority", () => {
  const fl = resolveEffectiveCodeContext(db, "FL", "Cape Coral");
  const cite = fl.citationFor("NEC", "690.12", "Rapid shutdown", OREGON_FALLBACK);
  // Florida's OWN source is the right answer when it has one; the invariant is only
  // that Oregon's never is.
  assert.ok(!isOregonSource(cite.sourceUrl), `an Oregon link was cited to a Florida project: ${cite.sourceUrl}`);
});

await run("MUST PASS: an Oregon-only code FAMILY is not returned verbatim outside Oregon", () => {
  const oh = resolveEffectiveCodeContext(db, "OH", "Columbus");
  const cite = oh.citationFor("ORSC", "R324.4.1", "Rooftop PV", OREGON_FALLBACK);
  assert.equal(cite.sourceUrl, "", "Oregon's worksheet URL must not be Columbus's authority");
  assert.match(cite.note, /Oregon's, which is not authority here|No adopted-code data/i);
});

await run("MUST EXCLUDE: Oregon projects keep their Oregon citations and links", () => {
  const or = resolveEffectiveCodeContext(db, "OR", "Salem");
  const cite = or.citationFor("ORSC", "R324.4.1", "Rooftop PV", OREGON_FALLBACK);
  // Salem's own adopted-code source outranks the rule's fallback; either way an Oregon
  // project must still end up with an Oregon authority rather than a stripped citation.
  assert.ok(cite.sourceUrl && isOregonSource(cite.sourceUrl),
    `Oregon must still cite Oregon, got "${cite.sourceUrl}"`);
});

await run("a model-code default says it is a placeholder, not an adoption record", () => {
  const wy = resolveEffectiveCodeContext(db, "WY", "Cheyenne");
  const cite = wy.citationFor("NEC", "690.12", "Rapid shutdown");
  assert.match(cite.adoptionScope, /No adopted-code record|placeholder/i,
    `a model default claimed to be Cheyenne's adopted code: ${cite.adoptionScope}`);
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

await run("autonomous research: first contact queues the STATE layer first (the county waits for it), deduped", async () => {
  const { ensureCodeProfilesResearched, codeResearchDecision } = await import("../src/codeProfiles");
  const n = ensureCodeProfilesResearched(db, "MT", "Gallatin County");
  // State first: Montana's adoption model is unknown until its state layer is researched, so the
  // county's code research waits (pending_state) instead of racing it.
  assert.equal(n, 1, "only the state default layer is queued on first contact");
  assert.equal(codeResearchDecision(db, "MT", "Gallatin County").reason, "pending_state");
  await new Promise((r) => setTimeout(r, 400)); // lazy-import enqueue settles
  const jobs = db.query<{ payload: string; status: string }>("SELECT payload, status FROM job_queue WHERE job_type = 'code_research'");
  assert.ok(jobs.length >= 1, `jobs enqueued (${jobs.length})`);
  assert.ok(jobs.every((j) => /"ahj":""/.test(j.payload)), `a county layer was queued before its state: ${jobs.map((j) => j.payload).join(" | ")}`);
  // Re-ensure: nothing new — pending/running jobs AND recent attempts dedupe
  // (in stub mode jobs finish instantly without storing a row; the 6h window
  // stops every review from re-queuing no-op research).
  const again = ensureCodeProfilesResearched(db, "MT", "Gallatin County");
  assert.equal(again, 0, "recent research attempts dedupe re-enqueue");
  // Existing profile layer also dedupes (Idaho state row exists from the seed).
  const idAgain = ensureCodeProfilesResearched(db, "ID", "");
  assert.equal(idAgain, 0, "existing profile layer never re-queued");
});

await run("code_research job in stub mode saves NOTHING (never blocks future research)", async () => {
  const { processNextJob } = await import("../src/jobQueue");
  delete process.env.ANTHROPIC_API_KEY; // stub LLM
  // Drain the queued research jobs.
  for (let i = 0; i < 4; i++) await processNextJob(db);
  // Wait out any in-flight kick from the enqueue helper before asserting.
  for (let i = 0; i < 20; i++) {
    const busy = db.get("SELECT id FROM job_queue WHERE job_type = 'code_research' AND status IN ('pending','running')");
    if (!busy) break;
    await new Promise((r) => setTimeout(r, 250));
    await processNextJob(db);
  }
  const done = db.query<{ status: string; result: string }>("SELECT status, result FROM job_queue WHERE job_type = 'code_research'");
  assert.ok(done.every((j) => j.status === "done"), `jobs terminal (${done.map((j) => j.status).join(",")})`);
  assert.ok(done.every((j) => /"saved":\s*false/.test(String(j.result))), "stub research reports saved:false");
  const mt = db.get("SELECT profile_key FROM jurisdiction_code_profiles WHERE state = 'MT'");
  assert.ok(!mt, "no empty MT profile row stored");
});

// Close before deleting the scratch DB - Windows holds the open handle as a file lock (EBUSY).
db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} code-profile test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll code-profile tests passed.`);
process.exit(0);
