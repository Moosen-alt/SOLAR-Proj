// EVIDENCE THAT ARRIVES WHILE A CHAIN RUNS IS SEEN BY A CHAIN THAT STARTS AFTER IT (dry run
// 2026-09-28, B1).
//
// The parser page CREATES the project (the save route enqueues the local chain; the instant kick
// claims it ~5 ms later) and UPLOADS the plan set a few hundred ms after. The running chain had
// already passed STEP 0 (split) with no plan set on file, and the upload's enqueue was dropped as a
// duplicate of the RUNNING job — so the project sat un-split behind "required documents missing"
// over sheets that were inside the plan set, until something else re-queued the chain.
//
// Pinned here, in the parser page's own order: create -> chain #1 running -> upload plan set ->
// a follow-up chain waits (one, never two) -> it never runs beside #1 -> it runs after #1 and
// splits the plan set. Everything synchronous until the claims are done: enqueueJob's instant kick
// is a setTimeout, and an await would let the real worker take the rows out from under the test.
//
// KILL (verified by hand): enqueueStageSteps deduping on status IN ('pending','running') -> 1a FAILS
// (the upload's enqueue returns false and no follow-up exists), and 1e never gets a chain to run.
//
//   npx tsx backend/test/chainLateEvidence.test.ts
import "./_isolate"; // FIRST: temp cwd, so filled/ docs/ never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-late-evidence-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(dir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(dir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
delete process.env.AUTO_STAGE_STEPS;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { claimNextJob } = await import("../src/jobQueue");
const { processStageStep, enqueueStageSteps } = await import("../src/autoStageSteps");
const { PDFDocument, StandardFonts } = await import("pdf-lib");

const db = await openDatabase();
let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

// The plan set is built BEFORE anything is enqueued — pdf-lib is async, and every await after the
// first enqueue hands the rows to the real worker.
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (const title of ["SITE PLAN", "ELECTRICAL LINE DIAGRAM"]) {
  const page = pdf.addPage([612, 792]);
  page.drawText(title, { x: 60, y: 700, size: 22, font });
  page.drawText("SCALE: NTS — fixture sheet for the late-evidence test", { x: 60, y: 660, size: 10, font });
}
const planSet = Buffer.from(await pdf.save());

const client = createClient(db, { companyName: "Late Evidence Solar", ccbLicenseNumber: "112244" });
const stageJobs = (pid: string, status: string): Array<{ id: string }> => db.query<{ id: string }>(
  "SELECT id FROM job_queue WHERE job_type = 'stage_step' AND project_id = ? AND status = ?", [pid, status]);
/** Claim until THIS project's stage_step is taken (other job types may sit ahead of it). */
const claimStageStepFor = (pid: string): string | null => {
  for (let i = 0; i < 25; i += 1) {
    const job = claimNextJob(db);
    if (!job) return null;
    if (job.jobType === "stage_step" && job.projectId === pid) return job.id;
  }
  return null;
};

console.log("\n1. CREATE -> CHAIN RUNNING -> UPLOAD: THE UPLOAD GETS A FOLLOW-UP CHAIN");
// ── from here to the processStageStep await: NO awaits ──────────────────────────────────────
const p = createProject(db, {
  clientId: client.id, owner: "Late Owner 1", street: "1 Late St", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
}).project;
check("setup: the save route's enqueue created chain #1", enqueueStageSteps(db, p.id) === true);
const first = claimStageStepFor(p.id);
check("setup: chain #1 is claimed and RUNNING (the instant kick, ~5 ms after create)", Boolean(first) && stageJobs(p.id, "running").length === 1);

saveProjectDocument(db, p.id, { filename: "plan-set.pdf", docType: "plan_set", contentType: "application/pdf", buffer: planSet, source: "upload" });
const followUp = enqueueStageSteps(db, p.id); // what POST /api/projects/:id/documents does
const pendingAfterUpload = stageJobs(p.id, "pending");
check("1a. THE POINT: the upload's enqueue is NOT dropped while chain #1 runs — one follow-up waits",
  followUp === true && pendingAfterUpload.length === 1, `returned=${followUp} pending=${pendingAfterUpload.length}`);

const again = enqueueStageSteps(db, p.id); // a bill + a meter photo land in the same second
check("1b. MUST-PASS: later evidence folds into that ONE pending follow-up (no stack)",
  again === false && stageJobs(p.id, "pending").length === 1, `returned=${again} pending=${stageJobs(p.id, "pending").length}`);

for (let i = 0; i < 25 && claimNextJob(db); i += 1) { /* drain anything claimable */ }
check("1c. MUST-EXCLUDE: the follow-up is never claimed beside the running chain (two chains never run at once)",
  stageJobs(p.id, "pending").length === 1 && stageJobs(p.id, "running").length === 1,
  `pending=${stageJobs(p.id, "pending").length} running=${stageJobs(p.id, "running").length}`);

// Chain #1 finishes having never seen the plan set (it passed STEP 0 before the upload landed).
db.run("UPDATE job_queue SET status = 'done', finished_at = ? WHERE id = ?", [new Date().toISOString(), first]);
const second = claimStageStepFor(p.id);
check("1d. once chain #1 is done, the follow-up is claimable", Boolean(second) && second === pendingAfterUpload[0]?.id,
  `claimed=${second} expected=${pendingAfterUpload[0]?.id}`);
// ── end of the synchronous section ──────────────────────────────────────────────────────────

// Only a chain the QUEUE handed out runs here — calling processStageStep without one would prove
// the splitter, not that anything would have run it.
const out = second ? await processStageStep(db, p.id) : { ran: [] as string[] };
const splitTypes = db.query<{ doc_type: string }>(
  "SELECT doc_type FROM project_documents WHERE project_id = ? AND source = 'split'", [p.id]).map((r) => r.doc_type).sort();
check("1e. THE POINT: the follow-up chain splits the plan set that arrived mid-chain",
  out.ran.some((r) => r.startsWith("split(")) && splitTypes.includes("site_plan") && splitTypes.includes("sld"),
  `ran=${JSON.stringify(out.ran)} split=${JSON.stringify(splitTypes)}`);

// saveProjectDocument fires a void text extraction; let it land before db.close().
for (let i = 0; i < 40; i += 1) {
  const busy = Number(db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ? AND source = 'upload' AND extracted_text = ''", [p.id])?.n ?? 0);
  if (busy === 0) break;
  await new Promise((r) => setTimeout(r, 100));
}

console.log(failures ? `\nchainLateEvidence: ${failures} check(s) FAILED` : "\nchainLateEvidence: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
