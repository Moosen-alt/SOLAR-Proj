// A SHORTER DRAFT MUST NOT ERASE A LONGER ONE.
//
// protectComplete guards a COMPLETE recipe. Two DRAFTS of the same portal were not ranked at
// all, so the last writer won — and on 2026-09-09 the last writer was a benchmark run the
// harness cut off at 660 seconds. It replaced Miami's 58-step, 39-fill draft, which had
// walked twelve pages of the intake, with the 28-step, 18-fill draft that run managed before
// it was killed. The good one survived only in prev_steps_json, where nothing looks for it.
//
// Neither draft replays, so nothing files differently either way. What is lost is the record
// of how far the portal can actually be walked, which is the entire point of keeping a draft.
//
// Browser-free. Run: tsx backend/test/deeperDraft.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deeper-draft-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { substantiveStepCount, shouldKeepDeeperDraft } = await import("../src/autoLearn");

let passed = 0;
const ok = (n: string): void => { passed++; console.log(`ok   ${n}`); };

const fills = (n: number): Array<{ action: string }> => Array.from({ length: n }, () => ({ action: "fill" }));
const clicks = (n: number): Array<{ action: string }> => Array.from({ length: n }, () => ({ action: "click" }));

// --- what counts as depth -------------------------------------------------------------
assert.equal(substantiveStepCount([...fills(3), ...clicks(9)]), 3);
assert.equal(substantiveStepCount([{ action: "select" }, { action: "check" }, { action: "goto" }]), 2);
assert.equal(substantiveStepCount(undefined), 0);
ok("depth counts fills, selects and checks — a goto and nine clicks is navigation");

// --- MUST KEEP ------------------------------------------------------------------------
assert.equal(
  shouldKeepDeeperDraft(fills(39), fills(18), { protectComplete: false, hasExisting: true }),
  true,
);
ok("Miami's case: a 39-fill draft is not replaced by an 18-fill one");

// --- MUST NOT KEEP --------------------------------------------------------------------
assert.equal(
  shouldKeepDeeperDraft(fills(18), fills(39), { protectComplete: false, hasExisting: true }),
  false,
  "a run that got FURTHER must be allowed to replace a shallower draft — that is progress",
);
ok("a deeper run replaces a shallower draft");

assert.equal(
  shouldKeepDeeperDraft(fills(20), fills(20), { protectComplete: false, hasExisting: true }),
  false,
  "equal depth means the fresher recording wins — the portal may have drifted",
);
ok("equal depth lets the fresher recording through");

assert.equal(
  shouldKeepDeeperDraft(fills(39), fills(0), { protectComplete: false, hasExisting: false }),
  false,
  "no existing recipe means there is nothing to protect",
);
ok("nothing to keep when there is no existing recipe");

assert.equal(
  shouldKeepDeeperDraft(fills(39), fills(1), { protectComplete: true, hasExisting: true }),
  false,
  "a COMPLETE recipe is already protected by its own guard, which returns a different result",
);
ok("a complete recipe is left to its own guard");

console.log(`\nAll ${passed} deeper-draft checks passed.`);
