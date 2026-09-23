// "PAY THE FEE" NAMES THE PERMIT THAT IS ACTUALLY READY — NOT EVERY PERMIT ON THE JOB.
//
// Found on the demo kit's Track Approvals project: Salem's building permit read ready-for-issue
// (fee due) while the electrical permit was still in plan review, and the next-step banner said
// "City of Salem approved the building permit and electrical permit — pay the issuance fee".
// feeDue was decided per KIND (any permit target ready for issue) instead of per track, so one
// permit's fee made every permit track "approved". Driven through the real write paths.
//
//   npx tsx backend/test/nextStepFeeDueTrack.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nextstep-feedue-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { computeNextStep } = await import("../src/nextStep");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Salem files SEPARATE building + electrical permits (plus NEM).
const pid = R.createProject(db, {
  owner: "Fee Due Owner", state: "OR", dcKw: "8.6", acKw: "5.8", permitPath: "prescriptive",
  street: "905 Quarry Bend", city: "Salem", zip: "97301", ahj: "City of Salem", utility: "Portland General Electric",
} as never).project.id;
let detail = R.getProjectDetail(db, pid);
for (const t of [
  { applicationNumber: "BLD-1", permitType: "building", targetType: "permit" },
  { applicationNumber: "ELE-1", permitType: "electrical", targetType: "permit" },
  { applicationNumber: "NEM-1", permitType: "nem", targetType: "nem" },
]) detail = R.createPermitCheckTarget(db, pid, { jurisdiction: "City of Salem", ...t } as never);
const target = (app: string): string => detail.permitCheckTargets.find((t) => t.applicationNumber === app)!.id;

await R.recordPermitStatusCheck(db, pid, { targetId: target("ELE-1"), source: "manual", rawStatusText: "Plans assigned to reviewer - electrical plan review in progress." });
await R.recordPermitStatusCheck(db, pid, { targetId: target("BLD-1"), source: "manual", rawStatusText: "Approved pending payment. Permit is ready to issue; issuance fees are due." });

await check("the banner names ONLY the building permit as approved and fee-due", async () => {
  const step = await computeNextStep(db, R.getProjectDetail(db, pid).project);
  assert.equal(step.key, "fee_due", `key=${step.key}`);
  assert.match(step.headline, /building permit/i, step.headline);
  assert.doesNotMatch(step.headline, /electrical/i, `electrical is in plan review, not approved: "${step.headline}"`);
});

await check("once electrical is ALSO ready for issue, both are named", async () => {
  await R.recordPermitStatusCheck(db, pid, { targetId: target("ELE-1"), source: "manual", rawStatusText: "Approved pending payment. Permit is ready to issue; issuance fees are due." });
  const step = await computeNextStep(db, R.getProjectDetail(db, pid).project);
  assert.equal(step.key, "fee_due");
  assert.match(step.headline, /building permit/i);
  assert.match(step.headline, /electrical/i, step.headline);
});

db.close();
console.log(failures ? `\nnextStepFeeDueTrack: ${failures} check(s) FAILED` : "\nnextStepFeeDueTrack: all checks passed");
process.exit(failures ? 1 : 0);
