// HOW WELL THE ROBOT FILLED — the question no KPI was asking.
//
// Every existing KPI is a business outcome: cycle days, corrections, SLA breaches. None of
// them notice a filing staged with three required boxes empty, because a person quietly
// fills them in and the permit still lands on time. That cost is real and it was invisible:
// PacifiCorp's missing meter photo was found by an operator looking at the live portal, not
// by anything the run reported.
//
// The data was already there. `portal_runs.result_json` has always stored the whole run
// result, and the replay report — blanks, drift warnings, the review-screen check — lives in
// `steps[].data` inside it. So this reads history rather than needing new instrumentation.
//
// Most of these checks are about what must NOT be counted as clean, for the same reason the
// replay benchmark's are: this session's whole lesson is that "we could not tell" scoring the
// same as "we checked and it was right" is how a wrong filing reaches a human wearing a clean
// bill of health.
// Run: tsx backend/test/stagingQuality.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kpi-staging-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.AUTOPILOT_AUTO_START = "0";
  process.env.ANTHROPIC_API_KEY = "";
  const { openDatabase } = await import("../src/db");
  const { getStagingQuality } = await import("../src/kpi");
  const { createProject } = await import("../src/repository");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  const { project } = createProject(db, {
    owner: "Test Owner", street: "1 Main St", city: "Salem", state: "OR", zip: "97301",
    ahj: "Salem", utility: "Pacific Power",
  } as never);

  let n = 0;
  // One staging run, with its report where the adapter actually puts it: on the STEP.
  const addRun = (data: Record<string, unknown> | null, portalName = "PowerClerk"): void => {
    n++;
    const result = data === null
      ? { portalName, ok: true, steps: [{ ok: true, message: "no report here" }] }
      : { portalName, ok: true, steps: [{ ok: true, message: "Replayed", data }] };
    db.run(
      `INSERT INTO portal_runs (id, project_id, run_type, status, started_at, finished_at, result_json)
       VALUES (?, ?, 'prepare_submit', 'succeeded', ?, ?, ?)`,
      [`run-${n}`, project.id, "2026-06-15T10:00:00.000Z", "2026-06-15T10:05:00.000Z", JSON.stringify(result)],
    );
  };

  const window = { start: "2026-01-01", end: "2026-12-31", orgId: null as string | null };

  // ---------------------------------------------------------------------------
  // The top bar, and everything that must fall short of it.
  // ---------------------------------------------------------------------------
  addRun({ executed: 98, requiredStillEmpty: [], skipped: [], driftWarnings: [], reviewFieldsSeen: 20, reviewMismatches: [] });
  let q = getStagingQuality(db, window);
  check("a clean, review-verified run counts as verified", q.verified === 1 && q.clean === 1, JSON.stringify(q));

  addRun({ executed: 98, requiredStillEmpty: [], skipped: [], driftWarnings: [], reviewFieldsSeen: 0 });
  q = getStagingQuality(db, window);
  check("THE REGRESSION: clean but never verified is CLEAN, not VERIFIED",
    q.clean === 2 && q.verified === 1, `clean=${q.clean} verified=${q.verified}`);

  addRun({ executed: 98, requiredStillEmpty: [], skipped: [], driftWarnings: [], reviewFieldsSeen: 12, reviewMismatches: [{ field: "homeownerName", expected: "a", found: "b" }] });
  q = getStagingQuality(db, window);
  check("...and a run the review screen CONTRADICTS is neither verified NOR clean",
    q.verified === 1 && q.clean === 2,
    `it ran without a stumble and the portal says it is wrong: verified=${q.verified} clean=${q.clean}`);
  check("...and that contradiction counts as work left for a person",
    q.neededHuman === 1, `neededHuman=${q.neededHuman}`);

  // ---------------------------------------------------------------------------
  // What leaves work for a person.
  // ---------------------------------------------------------------------------
  addRun({ executed: 90, requiredStillEmpty: ["Meter number", "Account number"], skipped: [], driftWarnings: [] });
  q = getStagingQuality(db, window);
  check("a run with blank required fields is counted as needing a human",
    q.neededHuman === 2, `neededHuman=${q.neededHuman}`);
  check("...and the blank fields are named, so the recurring ones can be fixed",
    q.topGaps.some((g) => /Meter number/.test(g.field)), JSON.stringify(q.topGaps));

  addRun({ executed: 98, requiredStillEmpty: [], skipped: [], driftWarnings: ["select \"Model\" landed nothing though 49 options were showing"] });
  q = getStagingQuality(db, window);
  check("a drift warning stops a run being clean, even with nothing blank",
    q.clean === 2, `clean=${q.clean}`);
  check("...and the portal is named so drift can be chased to its recipe",
    q.driftingPortals.some((d) => d.portal === "PowerClerk"), JSON.stringify(q.driftingPortals));

  // ---------------------------------------------------------------------------
  // The two rules this session paid for.
  // ---------------------------------------------------------------------------
  addRun({ executed: 97, requiredStillEmpty: [], skipped: ["final submit: Submit (recorded, NOT clicked)"], driftWarnings: [], reviewFieldsSeen: 15, reviewMismatches: [] });
  q = getStagingQuality(db, window);
  check("THE SAFETY RULE IS NOT A DEFECT: the declined final submit still counts as verified",
    q.verified === 2, `automation never clicks submit; that must not read as a failed step (verified=${q.verified})`);

  const before = getStagingQuality(db, window);
  addRun(null);
  q = getStagingQuality(db, window);
  check("THE REGRESSION: a run with NO report is excluded, never counted as clean",
    q.clean === before.clean && q.measured === before.measured,
    `an unreadable run must not improve the score: clean ${before.clean}->${q.clean}, measured ${before.measured}->${q.measured}`);
  check("...and it is still counted in the run total, so the gap is visible",
    q.runs === before.runs + 1, `runs=${q.runs}`);

  // ---------------------------------------------------------------------------
  // Arithmetic, and the period bound.
  // ---------------------------------------------------------------------------
  check("cleanRate is a percentage OF WHAT COULD BE MEASURED, not of every run",
    q.cleanRate === Math.round((q.clean / q.measured) * 1000) / 10,
    `${q.cleanRate}% vs ${q.clean}/${q.measured}`);

  const empty = getStagingQuality(db, { start: "2025-01-01", end: "2025-12-31", orgId: null });
  check("a period with no runs reports zeroes rather than dividing by zero",
    empty.runs === 0 && empty.cleanRate === 0 && empty.avgBlanksPerRun === 0, JSON.stringify(empty));

  if (failures) { console.error(`\n${failures} staging-quality check(s) FAILED.`); process.exit(1); }
  console.log("\nAll staging-quality checks passed.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
