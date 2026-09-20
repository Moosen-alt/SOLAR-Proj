// THE PIPELINE IS FIVE STAGES, AND EVERY STATUS LANDS ON ONE OF THEM.
//
// The operator called the status sub-stages "jank". Two measured causes:
//
//   (A) 8 of 20 ProjectStatus values had ZERO writers anywhere in the codebase, yet were
//       labeled, bannered with operator instructions, and offered as board filters — dead
//       vocabulary rendered as live UI. Three of them (`intake_uploaded`, `submit_staging`,
//       `resubmit_staging`) were removed outright on 2026-09-19; portal RUN state belongs to
//       `portal_runs.status`, not to a project's lifecycle. Landing gate before removal: zero
//       rows carrying any of the three, in ANY column of ANY of the live DB's 54 tables.
//   (B) The leading "Intake" stage was permanently complete the moment a project existed.
//       Upload and parse happen together in the parser, so a project is BORN `parsed` and
//       nothing ever sat in Intake. A stage that is always already done is not a step in a
//       pipeline; it makes the remaining work look shorter than it is. Intake was REMOVED
//       (operator ruling) rather than left empty: six stages became five.
//
// What this file pins, so neither can quietly come back:
//
//   1. The birth status is `parsed` and it maps to the FIRST stage — not to a completed one.
//      `normalizeProject` with no status argument is the real production birth path.
//   2. STAGE_COUNT is 5 and the indices are 0..4, contiguous, in array order.
//   3. EXHAUSTIVENESS, driven through the real `stageForStatus` — not a copy of the map.
//   4. mustExclude — none of the three removed literals survives as a STATUS in source or in
//      a raw-SQL/object fixture. Deliberately anchored on `status`, because the stress smokes
//      legitimately carry "submit_staging" as `currentStage` PROSE and a recorded label is a
//      matching key: that string must NOT be rewritten.
//
// HOW THE STATUS LIST IS PINNED AT RUNTIME, AND WHY IT ISN'T A TYPE ASSERTION.
// `ProjectStatus` is a TYPE: it does not exist at runtime, and this file cannot see it. Two
// separate facts make a naive `Record<ProjectStatus, true>` in a TEST file worthless here:
// the chain runs tests under `tsx`, which STRIPS types without checking them, AND
// tsconfig.json's `include` covers only backend/src, portal-bot/src, shared/src and tools —
// backend/test is NOT typechecked by `npm run typecheck` either. Such a Record would be
// checked by nothing at all while looking authoritative.
// So the union is pinned through a PRODUCTION surface that IS compile-locked to it and whose
// keys survive to runtime: `PUBLIC_STATUS_TEXT` in backend/src/clientPortal.ts, typed
// `Record<ProjectStatus, string>` and inside the typecheck include. Re-adding a status to the
// union forces a matching entry there (tsc refuses otherwise — verified), so its key set grows
// and the assertions below fail. It lives in a different module from `STATUS_TO_STAGE`, so
// using it to drive `stageForStatus` compares two independent things rather than a map
// against a copy of itself.
//
// NO DATABASE IS OPENED. normalizeProject and stageForStatus are pure. The clientPortal
// import does reach ./db through ./repository, but only for types and function definitions —
// nothing calls openDatabase() at module load, so this test needs no AUTOPILOT_DB_PATH and
// touches no sqlite file. (Checked, not assumed: importing it yields the 17 keys and exits.)
//
// Browser-free. Run: tsx backend/test/stagePipeline.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_STAGES, STAGE_COUNT, stageForStatus } from "../src/projectStage";
import { normalizeProject } from "../src/normalize";
import { PUBLIC_STATUS_TEXT } from "../src/clientPortal";
import type { ProjectStatus } from "../../shared/src/types";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ── 1. the birth status ──────────────────────────────────────────────────────
// Through the REAL creation path. normalize.ts's `status: ProjectStatus = "parsed"` default
// is what every parser-created project gets; if that default drifts, a project would be born
// somewhere other than the start of the pipeline and this fails.
check("THE BIRTH STATUS: a freshly created project is `parsed`", () => {
  const born = normalizeProject("stage-pipeline-fixture", {});
  assert.equal(born.status, "parsed", "normalizeProject's default status is the birth status");
});

check("...and `parsed` maps to the FIRST stage, QC / Verify — not to a completed one", () => {
  const born = normalizeProject("stage-pipeline-fixture", {});
  const stage = stageForStatus(born.status);
  assert.equal(stage.index, 0, `a new project must open on stage 0, got ${stage.index} (${stage.key})`);
  assert.equal(stage.key, "qc");
  assert.equal(stage.key, PROJECT_STAGES[0].key, "stage 0 must BE the first element of PROJECT_STAGES");
});

// ── 2. five stages, indices 0..4, contiguous ─────────────────────────────────
check("THE COLLAPSE: STAGE_COUNT is 5", () => {
  assert.equal(STAGE_COUNT, 5, `pipeline is five stages (QC → Build → Submit → Track → Closeout), got ${STAGE_COUNT}`);
  assert.equal(PROJECT_STAGES.length, 5);
});

check("...and the indices are 0-4, contiguous and in array order", () => {
  const indices = PROJECT_STAGES.map((s) => s.index);
  assert.deepEqual(indices, [0, 1, 2, 3, 4], `expected 0..4 in order, got [${indices.join(", ")}]`);
  assert.equal(Math.max(...indices), STAGE_COUNT - 1, "the last index must be STAGE_COUNT - 1");
});

check("...and no Intake stage survives anywhere in the array", () => {
  const keys = PROJECT_STAGES.map((s) => s.key);
  assert.ok(!keys.includes("intake"), `Intake was removed, not emptied — found keys [${keys.join(", ")}]`);
  assert.deepEqual(keys, ["qc", "build", "submit", "track", "closeout"]);
  const labels = PROJECT_STAGES.map((s) => s.label);
  assert.ok(!labels.some((l) => /intake/i.test(l)), `no stage label may say "Intake": [${labels.join(" | ")}]`);
});

// ── 3. exhaustiveness, through the real stageForStatus ───────────────────────
// EXPECTED: the 17 statuses this round deliberately left in the union. This list is the
// intent; PUBLIC_STATUS_TEXT's runtime keys are the fact. The cross-check below is what
// makes this list load-bearing rather than decorative.
const EXPECTED_STATUSES: ProjectStatus[] = [
  "parsed",
  "qc_failed",
  "qc_passed",
  "ready_to_stage",
  "awaiting_human_submit",
  "submitted",
  "correction_received",
  "correction_triaged",
  "waiting_on_designer",
  "ready_to_resubmit",
  "awaiting_human_resubmit",
  "ready_for_issue",
  "issued",
  "approved",
  "nem_approved",
  "handoff_ready",
  "blocked",
];

// THE ACTUAL UNION AT RUNTIME. See the header note: this is the only honest way for a tsx
// test to enumerate a TypeScript union.
const ALL_STATUSES = Object.keys(PUBLIC_STATUS_TEXT) as ProjectStatus[];
const VALID_KEYS = new Set(PROJECT_STAGES.map((s) => s.key));

check("THE UNION ITSELF: every ProjectStatus is accounted for, and only those 17", () => {
  assert.deepEqual(
    [...ALL_STATUSES].sort(),
    [...EXPECTED_STATUSES].sort(),
    "ProjectStatus drifted from what this round ruled — add or remove it here deliberately",
  );
});

check("EXHAUSTIVE: every ProjectStatus resolves to a stage that really exists", () => {
  // Not a copy of STATUS_TO_STAGE — the real exported function, so a fallback that quietly
  // catches an unmapped status (it used to fall back to the now-deleted "intake" key) is
  // caught by the index/key assertions rather than papering over the gap.
  for (const status of ALL_STATUSES) {
    const stage = stageForStatus(status);
    assert.ok(stage, `stageForStatus("${status}") returned nothing`);
    assert.ok(VALID_KEYS.has(stage.key), `"${status}" → stage key "${stage.key}", which is not in PROJECT_STAGES`);
    assert.ok(
      Number.isInteger(stage.index) && stage.index >= 0 && stage.index < STAGE_COUNT,
      `"${status}" → index ${stage.index}, outside 0..${STAGE_COUNT - 1}`,
    );
    assert.equal(stage.index, PROJECT_STAGES[stage.index].index, `"${status}" → index/array mismatch`);
    assert.equal(stage.key, PROJECT_STAGES[stage.index].key, `"${status}" → key/index mismatch`);
  }
});

check("...and the three zero-writer statuses are gone from the union for good", () => {
  assert.equal(ALL_STATUSES.length, 17, `expected 17 statuses after removing the 3 zero-writer ones, got ${ALL_STATUSES.length}`);
  for (const dead of ["intake_uploaded", "submit_staging", "resubmit_staging"]) {
    assert.ok(!ALL_STATUSES.includes(dead as ProjectStatus), `"${dead}" is back in ProjectStatus`);
  }
});

check("the anchor statuses still sit where the operator expects them", () => {
  assert.equal(stageForStatus("qc_failed").key, "qc");
  assert.equal(stageForStatus("qc_passed").key, "build");
  assert.equal(stageForStatus("awaiting_human_submit").key, "submit");
  assert.equal(stageForStatus("submitted").key, "track");
  assert.equal(stageForStatus("handoff_ready").key, "closeout");
  assert.equal(stageForStatus("handoff_ready").index, STAGE_COUNT - 1, "Closeout is the LAST stage");
});

// ── 4. mustExclude: no removed literal survives as a STATUS ──────────────────
const DEAD = ["intake_uploaded", "submit_staging", "resubmit_staging"];
// Anchored on a `status` key/assignment so `currentStage: "submit_staging"` (PROSE the stress
// smokes record, and a recorded label is a matching key) can never match. Covers object
// literals (`status: "x"`), assignments (`status = "x"`), comparisons (`status === "x"`) and
// raw-SQL fixtures that write a status column by name.
// The optional quotes around the key matter: a JSON fixture writes `"status": "submit_staging"`,
// where the closing quote sits between `status` and the colon. Without them this scanner would
// read every .json file it opens and match nothing in any of them.
const STATUS_ASSIGN = new RegExp(`["'\`]?\\bstatus["'\`]?\\s*(?::|={1,3})\\s*["'\`](?:${DEAD.join("|")})["'\`]`, "i");

check("the mustExclude pattern is not broken — positive control", () => {
  // filter lists fail both ways: a regex that matches nothing reads as a clean repo.
  assert.ok(STATUS_ASSIGN.test(`  status: "submit_staging",`), "must match an object-literal status");
  assert.ok(STATUS_ASSIGN.test(`project.status === "intake_uploaded"`), "must match a comparison");
  assert.ok(STATUS_ASSIGN.test(`status = 'resubmit_staging'`), "must match an assignment");
  assert.ok(STATUS_ASSIGN.test(`  "status": "submit_staging",`), "must match a JSON-style quoted key");
  // ...and the prose it must NOT match:
  assert.ok(!STATUS_ASSIGN.test(`  currentStage: "submit_staging",`), "must NOT match currentStage prose");
  assert.ok(!STATUS_ASSIGN.test(`current_stage = 'submit_staging'`), "must NOT match current_stage prose");
});

const SELF = path.resolve(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(SELF), "..", "..");
const SCAN_ROOTS = ["backend/src", "backend/test", "portal-bot/src", "shared/src", "scripts"];
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".sql", ".json"]);

function walk(dir: string, out: string[]): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".git") walk(full, out); continue; }
    if (SCAN_EXT.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

check("mustEXCLUDE: no removed literal survives as a STATUS in source or fixtures", () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(path.join(REPO_ROOT, r), []));
  assert.ok(files.length > 200, `scan found only ${files.length} files — the walk is broken, not the repo clean`);
  const hits: string[] = [];
  for (const file of files) {
    if (path.resolve(file) === SELF) continue; // this file names the literals on purpose
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (STATUS_ASSIGN.test(line)) hits.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], `a removed status is still being SET or COMPARED:\n         ${hits.join("\n         ")}`);
  console.log(`         (scanned ${files.length} files across ${SCAN_ROOTS.length} roots)`);
});

if (failures) { console.error(`\n${failures} stage-pipeline check(s) FAILED.`); process.exit(1); }
console.log("\nAll stage-pipeline checks passed.");
process.exit(0);
