// B8(c)/(d): the gate answers "which process applies?" with the packet's own predicate, and the
// boilerplate reminders (final preview, installer scope confirmation, the prescriptive upload note,
// locates on a job with no digging) are the SUBMIT CHECKLIST, not findings against this project.
//
// KILL TESTS (verified red by hand):
//   K1 reviewerEngine: keep the old "No seeded AHJ process profile matched" wording → (c1) fails.
//   K2 reviewerEngine: keep the boilerplate as findings                          → (d1) fails.
//   K3 reviewerEngine: the old locates regex                                     → (d2) fails.
//
// Run: npx tsx backend/test/gateProcessAndBoilerplate.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-boiler-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;
const db = await (await import("../src/db")).openDatabase();
const repo = await import("../src/repository");
const pp = await import("../src/permitProcess");

let failures = 0;
const check = (name: string, fn: () => void) => { try { fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); } };
const report = (over: Record<string, string>) => {
  const p = repo.createProject(db, {
    owner: "Gate Owner", street: "9 Gate Rd", city: "Hollowmere", state: "OR", zip: "97352", ahj: "City of Hollowmere", utility: "Pacific Power",
    dcKw: "5", acKw: "4", roofMaterial: "Composition Shingle", locateCalloutText: "No excavation — roof mount only; no 811 callout appears.", ...over,
  } as never).project;
  return repo.buildReviewerReportFor(db, repo.getProjectDetail(db, p.id).project);
};
const titles = (r: ReturnType<typeof report>) => r.findings.map((f) => f.title);

check("(c1) MUST-PASS: an Oregon AHJ with no profile says the STATEWIDE profile was applied (a callout, not a warning)", () => {
  const r = report({});
  const f = r.findings.find((x) => x.id === "reviewer.profile.missing")!;
  assert.match(f.title, /Oregon statewide profile applied; no City of Hollowmere-specific profile on file/);
  assert.equal(f.severity, "callout");
});
check("(c2) MUST-EXCLUDE: outside Oregon, with no profile and no lookup, the warning stands", () => {
  const f = report({ state: "WA", zip: "98000", ahj: "City of Hollowmere WA" }).findings.find((x) => x.id === "reviewer.profile.missing")!;
  assert.equal(f.title, "No seeded AHJ process profile matched");
  assert.equal(f.severity, "warning");
});
check("(c3) with a per-job lookup, the gate names it and its agency", () => {
  pp.savePermitProcessLookup(db, {
    state: "OR", ahj: "City of Brightwater", lookedUpAt: new Date().toISOString(),
    issuingAgency: { value: "Marion County", sourceUrl: "https://example.gov", quote: "Marion County issues", origin: "lookup" },
    permitStructure: { value: "separate", sourceUrl: "https://example.gov", quote: "separate electrical permit", origin: "lookup" }, permits: [],
  });
  const f = report({ ahj: "City of Brightwater", city: "Brightwater" }).findings.find((x) => x.id === "reviewer.profile.missing")!;
  assert.match(f.title, /Per-job lookup applied/);
  assert.match(f.message, /Marion County/);
});
check("(d1) MUST-EXCLUDE: final-preview / installer-scope / prescriptive-upload reminders are not findings — they are on the submit checklist", () => {
  const r = report({});
  for (const t of ["Final AHJ preview is required", "Installer pre-submittal scope confirmation", "Prescriptive path"]) assert.ok(!titles(r).includes(t), `${t} is still a finding`);
  const reqs = r.finalSubmitGate.requirements.join(" | ");
  assert.match(reqs, /Final AHJ preview/);
  assert.match(reqs, /Installer pre-submittal scope confirmation/);
  assert.equal(r.finalSubmitGate.finalSubmitButtonAloneIsEnough, false);
});
check("(d2) MUST-EXCLUDE: 'No excavation — roof mount only' is not a locates finding; real digging still is", () => {
  assert.ok(!titles(report({})).includes("Locates/utility coordination"));
  assert.ok(titles(report({ locateCalloutText: "Trench 40 ft from array to MSP; call 811 before digging." })).includes("Locates/utility coordination"));
});

if (failures) { console.error(`\n${failures} gate check(s) failed.`); process.exit(1); }
console.log("\nAll gate process/boilerplate checks passed.");
process.exit(0);
