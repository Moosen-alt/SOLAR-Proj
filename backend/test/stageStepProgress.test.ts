// THE AUTOMATIC CHAIN SAYS WHICH STEP IT IS ON, AND THE PROJECT PAGE SHOWS IT.
//
// Operator 2026-09-28, a brand-new AHJ: the chain's form search ran for six minutes while the page
// read "Blocked … find the official form" and then "Preparing this project automatically…" with
// nothing else — "it looks like its getting lost finding the forms". Each step now names itself on
// the job row as it starts (autoStageSteps STAGE_STEP_LABELS -> jobProgress.noteJobProgress, wired
// by the stage_step handler in jobQueue), and nextStep's automation_running answer carries it as a
// why line: "Checking the AHJ's required official forms… (started HH:MM UTC)".
//
//   MUST-PASS   processStageStep reports its steps in order (QC before the forms step); a job run
//               through the REAL worker handler (processNextJob) finishes with a non-empty note; a
//               RUNNING chain's note is the banner's why line, with its start time.
//   MUST-EXCLUDE a QUEUED (not started) chain shows no step; a stale/blank note reads as none.
//
//   npx tsx backend/test/stageStepProgress.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stage-step-progress-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.AUTO_STAGE_STEPS;
// No model, no downloads: the forms step returns at once (AHJ_FORM_DOWNLOADS=off) — what is under
// test is that it NAMES itself, not what it finds.
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH", "PERMIT_PROCESS_LOOKUP", "UTILITY_FILING_LOOKUP"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { computeNextStep } = await import("../src/nextStep");
const { enqueueJob, processNextJob, getJob } = await import("../src/jobQueue");
const { noteJobProgress, parseJobProgressNote } = await import("../src/jobProgress");
const { processStageStep, STAGE_STEP_LABELS } = await import("../src/autoStageSteps");

const db = await openDatabase();
let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};
const newProject = (owner: string): string => R.createProject(db, {
  owner, state: "OR", dcKw: "8.6", acKw: "5.8", permitPath: "prescriptive",
  street: "100 Example St", city: "Newberg", zip: "97132", ahj: "City of Newberg", utility: "Portland General Electric",
} as never).project.id;
const projectIds: string[] = [];

try {
  // ── 1. the chain names its steps, in order ─────────────────────────────────────────────────
  const p1 = newProject("Progress Owner"); projectIds.push(p1);
  const labels: string[] = [];
  const out = await processStageStep(db, p1, { onStep: (l) => labels.push(l) });
  const status = String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [p1])?.status);
  check("1 MUST-PASS the QC step names itself", labels.includes(STAGE_STEP_LABELS.qc), JSON.stringify({ labels, ran: out.ran, status }));
  if (status === "qc_failed") {
    check("1 a failed QC stops the chain before the forms step (so no forms label)", !labels.includes(STAGE_STEP_LABELS.acquire_forms), JSON.stringify(labels));
  } else {
    check("1 MUST-PASS the forms step names itself, after QC", labels.indexOf(STAGE_STEP_LABELS.acquire_forms) > labels.indexOf(STAGE_STEP_LABELS.qc), JSON.stringify(labels));
    check("1 ...and the package build after the forms step", labels.indexOf(STAGE_STEP_LABELS.build_docs) > labels.indexOf(STAGE_STEP_LABELS.acquire_forms), JSON.stringify(labels));
  }
  check("1 the forms label is the operator-facing sentence", STAGE_STEP_LABELS.acquire_forms === "Checking the AHJ's required official forms…");
  // And from qc_passed (the thin fixture fails QC on its own): the forms step, then the package.
  const p1b = newProject("Forms Step Owner"); projectIds.push(p1b);
  db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [p1b]);
  const labelsB: string[] = [];
  const outB = await processStageStep(db, p1b, { onStep: (l) => labelsB.push(l) });
  check("1 MUST-PASS from qc_passed the chain names the forms step", labelsB.includes(STAGE_STEP_LABELS.acquire_forms), JSON.stringify({ labelsB, ran: outB.ran }));
  check("1 ...and the package build after it", labelsB.indexOf(STAGE_STEP_LABELS.build_docs) > labelsB.indexOf(STAGE_STEP_LABELS.acquire_forms), JSON.stringify(labelsB));
  check("1 the forms step actually ran there", outB.ran.includes("acquire_forms"), JSON.stringify(outB.ran));

  // ── 2. through the REAL worker handler, the job row carries the note ───────────────────────
  const p2 = newProject("Worker Owner"); projectIds.push(p2);
  const job = enqueueJob(db, "stage_step", { projectId: p2 }, { projectId: p2, priority: 4 });
  const ran = await processNextJob(db);
  const row = getJob(db, job.id);
  check("2 MUST-PASS the worker ran the chain job", ran === true && row?.status === "done", JSON.stringify({ ran, status: row?.status, error: row?.error }));
  check("2 MUST-PASS the finished row keeps the last step it named (non-empty progress note)", row?.progressNote != null && Object.values(STAGE_STEP_LABELS).includes(row.progressNote.label as never)
    && /^\d{4}-\d\d-\d\dT/.test(row.progressNote.since), JSON.stringify(row?.progressNote));

  // ── 3. the banner: a RUNNING chain's step is the why line, with its start time ─────────────
  const p3 = newProject("Banner Owner"); projectIds.push(p3);
  const queued = enqueueJob(db, "stage_step", { projectId: p3 }, { projectId: p3, priority: 4 });
  const stepFor = () => computeNextStep(db, R.getProjectDetail(db, p3).project);
  const pendingStep = stepFor();
  check("3 MUST-EXCLUDE a QUEUED chain reads as automation running with no step line yet", pendingStep.key === "automation_running" && pendingStep.why.length === 0, JSON.stringify(pendingStep));
  db.run("UPDATE job_queue SET status = 'running', started_at = ? WHERE id = ?", [new Date().toISOString(), queued.id]);
  noteJobProgress(db, queued.id, STAGE_STEP_LABELS.acquire_forms);
  const runningStep = stepFor();
  check("3 MUST-PASS a RUNNING chain's step is the why line: \"Checking the AHJ's required official forms… (started HH:MM UTC)\"", runningStep.key === "automation_running"
    && runningStep.why.length === 1 && /^Checking the AHJ's required official forms… \(started \d\d:\d\d UTC\)$/.test(runningStep.why[0].text),
    JSON.stringify(runningStep.why));
  check("3 the headline is still the chain's own wording", /Preparing this project automatically/.test(runningStep.headline), runningStep.headline);
  db.run("UPDATE job_queue SET progress_note = '' WHERE id = ?", [queued.id]);
  check("3 MUST-EXCLUDE a blank note is no step (nothing invented)", stepFor().why.length === 0);
  db.run("UPDATE job_queue SET progress_note = 'not json' WHERE id = ?", [queued.id]);
  check("3 MUST-EXCLUDE an unreadable note is no step", stepFor().why.length === 0 && parseJobProgressNote("not json") === null && parseJobProgressNote(null) === null);
  db.run("UPDATE job_queue SET status = 'done', finished_at = ? WHERE id = ?", [new Date().toISOString(), queued.id]);

  assert.equal(failures, 0, `${failures} check(s) failed`);
  console.log("stageStepProgress: all checks passed — the chain names each step as it starts (QC, then the AHJ's official forms, then the package); the real worker handler writes it to the job row; a RUNNING chain's step is the project banner's why line with its start time; a queued chain, a blank or unreadable note show nothing");
} finally {
  db.close();
  for (const id of projectIds) fs.rmSync(path.resolve("backend/data/filled", id), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
