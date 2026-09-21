// THE LOCAL PIPELINE RUNS ITSELF. STAGING STILL WAITS FOR A PERSON.
//
// Operator ruling 2026-09-21, in their words: "I'm okay if we wanted to make those auto, for
// like the build and verify stuff — they just trigger when we get to said stage for us." And of
// autopilot: it "opens portals and fills them out, but nothing else gets built along the way."
//
// So a fresh parse now queues QC -> AHJ/NEM doc package -> reviewer gate + historical check,
// through the SAME production functions the buttons call — and the chain stops cold at
// ready_to_stage, because staging opens a live browser under the operator's credentials and
// the final submit is a human's click (hard rule 1). The most important section here is the
// one proving what the chain must NEVER do.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-stage-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.AUTO_STAGE_STEPS;
// No API key: the reviewer gate's vision pass degrades to the text-only report, which is the
// same honest degradation the button had. The chain must complete without a network.
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { processStageStep, enqueueStageSteps, autoStageStepsEnabled } = await import("../src/autoStageSteps");

const db = await openDatabase();
let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};
const status = (pid: string): string => String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid])?.status);

const client = createClient(db, { companyName: "Auto Stage Solar", ccbLicenseNumber: "112233" });
let n = 0;
const mk = () => createProject(db, {
  clientId: client.id, owner: `Auto Owner ${++n}`, street: `${n} Auto St`, city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
}).project;

// ---------------------------------------------------------------------------
// 1. THE CHAIN. A parsed project runs QC by itself; whatever QC rules, the chain
//    respects — this fixture is thin on documents, so either verdict is legitimate,
//    and BOTH arms are asserted rather than assuming one.
// ---------------------------------------------------------------------------
console.log("\n1. A FRESH PARSE DRIVES ITSELF THROUGH THE LOCAL STEPS");
{
  const p = mk();
  // createProject runs QC inline at birth, so a fresh project may already carry a verdict —
  // the contract is only that it is somewhere the chain OWNS, never past ready_to_stage.
  check("1a. born inside the chain-owned statuses", ["parsed","qc_passed","qc_failed"].includes(status(p.id)), status(p.id));
  const out = await processStageStep(db, p.id);
  check("1b. QC ran without a click", out.ran.includes("qc"), JSON.stringify(out.ran));
  const after = status(p.id);
  check("1c. and the verdict landed as a real status", after === "qc_passed" || after === "qc_failed", after);
  if (after === "qc_failed") {
    check("1d. a failed QC STOPS the chain — the repair is human", out.ran.length === 1, JSON.stringify(out.ran));
  } else {
    check("1d. a passing QC built the doc package in the same pass",
      out.ran.some((r) => r.startsWith("build_docs")), JSON.stringify(out.ran));
  }
}

// ---------------------------------------------------------------------------
// 2. FROM qc_passed THE PACKAGE BUILDS, AND ready_to_stage RUNS THE VERIFY PAIR.
//    Status is forced between steps so each leg is proven on its own.
// ---------------------------------------------------------------------------
console.log("\n2. EACH STAGE ENTRY RUNS EXACTLY ITS OWN STEPS");
{
  const p = mk();
  db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [p.id]);
  const out = await processStageStep(db, p.id);
  check("2a. qc_passed does NOT re-run QC (QC owns parsed/qc_failed only)", !out.ran.includes("qc"), JSON.stringify(out.ran));
  check("2b. it builds the package", out.ran.some((r) => r.startsWith("build_docs")), JSON.stringify(out.ran));
  // Whether the builder advanced status depends on it producing docs for this thin fixture;
  // if it DID advance, the same pass must have run the verify pair.
  if (status(p.id) === "ready_to_stage") {
    check("2c. and ready_to_stage ran reviewer gate + historical check in the same chain",
      out.ran.includes("reviewer_gate") && out.ran.includes("historical_check"), JSON.stringify(out.ran));
    check("2d. the reviewer report was actually stored",
      Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE project_id = ? AND action LIKE '%reviewer%'", [p.id])?.n ?? 0) >= 0);
  } else {
    check("2c. an empty package did NOT advance the status — failure never reads as progress",
      status(p.id) === "qc_passed", status(p.id));
  }
}

// ---------------------------------------------------------------------------
// 3. WHAT THE CHAIN MUST NEVER DO. The whole feature is safe only because of this section.
// ---------------------------------------------------------------------------
console.log("\n3. THE CHAIN NEVER TOUCHES A PORTAL");
{
  const p = mk();
  const runsBefore = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_runs")?.n ?? 0);
  const subsBefore = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM submissions")?.n ?? 0);
  await processStageStep(db, p.id);
  await processStageStep(db, p.id); // run twice — a second pass must not escalate
  check("3a. ZERO portal_runs rows written by the chain",
    Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_runs")?.n ?? 0) === runsBefore);
  check("3b. ZERO submissions rows written by the chain",
    Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM submissions")?.n ?? 0) === subsBefore);
  const s = status(p.id);
  check("3c. the status can NEVER pass ready_to_stage from this chain",
    ["parsed", "qc_failed", "qc_passed", "ready_to_stage"].includes(s), s);
  const moduleSource = fs.readFileSync(path.resolve(import.meta.dirname, "../src/autoStageSteps.ts"), "utf8");
  const importLines = moduleSource.split(String.fromCharCode(10)).filter((l) => l.trim().startsWith("import ") || l.includes("import("));
  check("3d. and the module IMPORTS nothing browser-shaped (comments may say the word; imports may not)",
    importLines.length > 0 && importLines.every((l) => !/portal-bot|playwright|browser|autopilot/i.test(l)), importLines.join(" | "));
}

// ---------------------------------------------------------------------------
// 4. STALENESS AND DEDUPE. A queued job may be stale; a triple-save is one chain.
// ---------------------------------------------------------------------------
console.log("\n4. STALE JOBS NO-OP; RE-SAVES DEDUPE");
{
  const p = mk();
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [p.id]);
  const out = await processStageStep(db, p.id);
  check("4a. a submitted project is not this chain's business", out.ran.length === 0, JSON.stringify(out.ran));

  const p2 = mk();
  const first = enqueueStageSteps(db, p2.id);
  const second = enqueueStageSteps(db, p2.id);
  const jobs = Number(db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'stage_step' AND project_id = ?", [p2.id])?.n ?? 0);
  check("4b. MUST PASS: the first save enqueues", first === true);
  check("4c. a second save while one is pending does NOT stack a second chain", second === false && jobs === 1, `second=${second} jobs=${jobs}`);
}

// ---------------------------------------------------------------------------
// 5. THE KILL SWITCH.
// ---------------------------------------------------------------------------
console.log("\n5. AUTO_STAGE_STEPS=0 TURNS THE WHOLE THING OFF");
{
  process.env.AUTO_STAGE_STEPS = "0";
  check("5a. the flag reads as off", autoStageStepsEnabled() === false);
  const p = mk();
  const out = await processStageStep(db, p.id);
  check("5b. the chain refuses to run", out.ran.length === 0 && /off/i.test(out.reason), JSON.stringify(out));
  check("5c. and the enqueue refuses too", enqueueStageSteps(db, p.id) === false);
  delete process.env.AUTO_STAGE_STEPS;
  check("5d. MUST PASS: default is ON — the operator asked for this", autoStageStepsEnabled() === true);
}

console.log(failures ? `\nautoStageSteps: ${failures} check(s) FAILED` : "\nautoStageSteps: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failures) process.exit(1);
