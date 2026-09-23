// DEMO, BENCHMARK AND FIXTURE PROJECTS DO NOT TEACH THE SHARED KNOWLEDGE BASE (L3).
//
// Every product path teaches permit_utility_knowledge — the pool every tenant reads — and the
// demo, the learn/replay benchmarks and fixtures run exactly those paths. Production carried 69
// 'benchmark …' profiles and two demo rows, and the demo tool defaulted to the PRODUCTION
// database. projects.learning_excluded (createProject's option, written in the INSERT so even the
// birth learn skips) is checked at the top of every project-sourced learn write: the project-event
// upsert, the failure example, the fingerprint, and the timeline sample.
//
// Drives the real paths for an excluded project and a control project side by side, then checks
// demo-environment.ts refuses to run without an explicit --db.
// Run: npx tsx backend/test/learningExclusion.test.ts
import { REPO } from "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-exclusion-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.CLIENT_NOTIFICATIONS = "off";
process.env.BACKGROUND_WORKERS = "off";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.AHJ_FORM_RESEARCH = "off";
process.env.FEE_RESEARCH = "off";
process.env.PORTAL_URL_RESEARCH = "off";
process.env.RUN_TRIAGE = "off";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const kb = await import("../src/knowledgeBase");
const db = await openDatabase();

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

const UTILITY = "Pacific Power";
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function exercise(ahj: string, learningExcluded: boolean): Promise<string> {
  const { project } = R.createProject(db, {
    owner: `${ahj} Owner`, street: "1 Test St", city: ahj, state: "OR", zip: "97000", ahj, utility: UTILITY, dcKw: "5", acKw: "4",
  } as never, undefined, { learningExcluded });
  const pid = project.id;
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, submitted_at, created_at)
     VALUES (?, ?, 'permit', 'combo', 'submitted', ?, ?)`,
    [`sub-${pid.slice(0, 8)}`, pid, iso(9 * 86400000), iso(9 * 86400000)],
  );
  const target = R.createPermitCheckTarget(db, pid, { jurisdiction: ahj, portalName: "DevHub", applicationNumber: `APP-${ahj}`, permitType: "combo" })
    .permitCheckTargets.find((t) => t.targetType === "permit")!;
  R.addManualCorrection(db, pid, "Please provide the rafter span calculations stamped by an engineer.");
  // Seen in review first: a timeline sample needs an OBSERVED transition (timelineSamples.ts).
  await R.recordPermitStatusCheck(db, pid, { targetId: target.id, source: "manual", rawStatusText: "Plan review in progress." });
  await R.recordPermitStatusCheck(db, pid, { targetId: target.id, source: "manual", rawStatusText: "Permit issued. Download permit card." });
  return pid;
}
const count = (sql: string, id: string) => Number(db.get<{ n: number }>(sql, [id])?.n ?? 0);
const learned = (pid: string, ahj: string) => ({
  events: count("SELECT COUNT(*) n FROM knowledge_events WHERE project_id = ?", pid),
  fingerprints: count("SELECT COUNT(*) n FROM historical_project_fingerprints WHERE project_id = ?", pid),
  failures: count("SELECT COUNT(*) n FROM historical_failure_examples WHERE project_id = ?", pid),
  samples: count("SELECT COUNT(*) n FROM permit_timeline_samples WHERE project_id = ?", pid),
  profile: count("SELECT COUNT(*) n FROM permit_utility_knowledge WHERE profile_key = ?", kb.knowledgeProfileKey({ state: "OR", ahj, utility: UTILITY })),
});

const control = await exercise("Realville", false);
const c = learned(control, "Realville");
check("CONTROL: a normal project teaches the KB (events, fingerprint, failure row, sample, profile)",
  c.events > 0 && c.fingerprints === 1 && c.failures === 1 && c.samples === 1 && c.profile === 1, JSON.stringify(c));

// The production shape: a demo project in a jurisdiction REAL work already taught (the demo's
// "City of Portland / PGE" keyed to the real Portland row). The shared profile exists, so every
// guard has to hold on its own — no "profile missing" early-out can mask one.
const sharedKey = kb.knowledgeProfileKey({ state: "OR", ahj: "Realville", utility: UTILITY });
const sharedBefore = db.get<{ project_count: number; common_corrections_json: string; timeline_sample_count: number }>(
  "SELECT project_count, common_corrections_json, timeline_sample_count FROM permit_utility_knowledge WHERE profile_key = ?", [sharedKey],
);
const demo = await exercise("Realville", true);
check("SETUP: the flag is written at creation", count("SELECT learning_excluded n FROM projects WHERE id = ?", demo) === 1);
const d = learned(demo, "Realville");
check("an excluded project writes no knowledge event", d.events === 0, JSON.stringify(d));
check("…no fingerprint (it is never 'a prior project like this one')", d.fingerprints === 0, JSON.stringify(d));
check("…no failure example", d.failures === 0, JSON.stringify(d));
check("…no timeline sample", d.samples === 0, JSON.stringify(d));
const sharedAfter = db.get<{ project_count: number; common_corrections_json: string; timeline_sample_count: number }>(
  "SELECT project_count, common_corrections_json, timeline_sample_count FROM permit_utility_knowledge WHERE profile_key = ?", [sharedKey],
);
check("…and the shared profile it shares with real work is unchanged (count, patterns, timeline)",
  JSON.stringify(sharedAfter) === JSON.stringify(sharedBefore), `${JSON.stringify(sharedBefore)} -> ${JSON.stringify(sharedAfter)}`);
// A novel jurisdiction: an excluded project creates no shared profile at all.
const novel = await exercise("Demoville", true);
check("an excluded project in a new jurisdiction creates no shared profile", learned(novel, "Demoville").profile === 0, JSON.stringify(learned(novel, "Demoville")));
check("the project itself still works (it has its correction and its issued status)",
  R.getProjectDetail(db, demo).corrections.length === 1 && R.getProjectDetail(db, demo).permitCheckTargets[0]?.latestOutcome === "issued");

// The LATER learn doors: an operator resolve (relearnCorrection) and a boot backfill.
const demoCorrection = R.getProjectDetail(db, demo).corrections[0];
if (!demoCorrection.closedAt) R.resolveCorrection(db, demoCorrection.id, { resubmitted: false });
else kb.relearnCorrection(db, demoCorrection.id);
check("a resolve / relearn of its correction still learns no failure row", learned(demo, "Realville").failures === 0, JSON.stringify(learned(demo, "Realville")));
await openDatabase(); // a second open runs the boot backfill (seedInitialKnowledgeBase)
const afterBoot = learned(demo, "Realville");
check("the boot backfill teaches nothing from it either", afterBoot.events === 0 && afterBoot.fingerprints === 0, JSON.stringify(afterBoot));

// ── the demo tool has no production default ────────────────────────────────────────────────────
const TSX_CLI = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const run = spawnSync(process.execPath, [TSX_CLI, path.join(REPO, "scripts", "demo-environment.ts"), "--status"], {
  cwd: tmpDir, encoding: "utf8", timeout: 120_000,
  env: { ...process.env, AUTOPILOT_DB_PATH: path.join(tmpDir, "must-not-be-used.sqlite") },
});
check("demo-environment.ts without --db refuses (exit non-zero)", run.status !== 0 && run.status !== null, `status=${run.status}`);
check("…says why", /pass --db/.test(`${run.stderr}${run.stdout}`), `${run.stderr}${run.stdout}`.slice(0, 300));
check("…and opened no database (not even the inherited AUTOPILOT_DB_PATH)", !fs.existsSync(path.join(tmpDir, "must-not-be-used.sqlite")));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nlearningExclusion: all checks passed");
