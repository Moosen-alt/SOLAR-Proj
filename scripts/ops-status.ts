// ONE PICTURE OF WHAT THE SYSTEM IS DOING, readable by the operator and by a session
// helping them. Everything here was reconstructed by hand at least once during a live
// debugging session, from four different places, while the operator was blocked.
//
//   npx tsx scripts/ops-status.ts            # the snapshot
//   npx tsx scripts/ops-status.ts --errors   # plus the last errors from the backend log
//
// Read-only. Never prints secrets: no credentials, and account/meter numbers are shown
// only as "set"/"missing", never their values.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";
const { openDatabase } = await import("../backend/src/db");
const { getProjectDetail, buildReviewerReportFor } = await import("../backend/src/repository");
const { buildHistoricalFailureReport } = await import("../backend/src/historicalFailures");

const db = await openDatabase();
const line = (s = "") => console.log(s);
const rule = (t: string) => { line(); line(`── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`); };

// --- Backend liveness --------------------------------------------------------
rule("BACKEND");
const logFile = process.env.AUTOPILOT_LOG_FILE || path.join(process.cwd(), "data", "logs", "backend.log");
if (fs.existsSync(logFile)) {
  const st = fs.statSync(logFile);
  const ageMin = (Date.now() - st.mtimeMs) / 60000;
  line(`  log        ${logFile}`);
  line(`  last write ${ageMin < 2 ? "just now" : `${ageMin.toFixed(0)} min ago`}   (${Math.round(st.size / 1024)} KB)`);
  line(`  live tail  tail -f "${logFile}"`);
} else {
  line(`  log        none yet at ${logFile}`);
  line("             (the server writes it once it starts; set AUTOPILOT_LOG_FILE=\"\" to disable)");
}

// --- Job queue ---------------------------------------------------------------
rule("JOB QUEUE");
const counts = db.query<{ status: string; n: number }>(
  "SELECT status, COUNT(*) n FROM job_queue GROUP BY status ORDER BY n DESC");
line(counts.length ? "  " + counts.map((c) => `${c.status}=${c.n}`).join("   ") : "  (empty)");
const failed = db.query<{ job_type: string; project_id: string | null; error: string; finished_at: string }>(
  "SELECT job_type, project_id, error, finished_at FROM job_queue WHERE status='failed' ORDER BY finished_at DESC LIMIT 5");
for (const f of failed) {
  line(`  FAILED ${String(f.finished_at ?? "").slice(0, 19)}  ${f.job_type}  ${String(f.project_id ?? "").slice(0, 8)}`);
  line(`         ${String(f.error ?? "").replace(/\s+/g, " ").slice(0, 150)}`);
}

// --- Projects that cannot stage, and WHY -------------------------------------
// The dashboard says "Can't submit yet — N blocker(s)" without naming them, which is
// exactly the state that soft-locked a project for an operator with no way out.
rule("PROJECTS BLOCKED FROM STAGING");
const projects = db.query<{ id: string; homeowner_name: string; ahj: string; status: string }>(
  "SELECT id, homeowner_name, ahj, status FROM projects ORDER BY updated_at DESC LIMIT 25");
let blocked = 0;
for (const p of projects) {
  let detail;
  try { detail = getProjectDetail(db, p.id, null); } catch { continue; }
  const qcFail = detail.qcResults.filter((r: { qcStatus: string }) => r.qcStatus === "fail").length;
  const pending = detail.humanReviewItems.filter((i: { status: string; fieldName: string; issueType: string }) =>
    i.status === "pending" && i.fieldName !== "correction" && i.issueType !== "Background job failed").length;
  const reviewerBlockers = buildReviewerReportFor(db, detail.project)
    .findings.filter((f: { severity: string }) => f.severity === "blocker");
  const hist = buildHistoricalFailureReport(db, p.id, null);
  const learned = hist.checklist.filter((item: { status: string; sourceCauseSignature: string }) => {
    const cause = hist.topRejectionCauses.find((c: { signature: string; count: number; severity: string }) =>
      c.signature === item.sourceCauseSignature);
    return item.status === "missing" && Boolean(cause && cause.count > 0 && cause.severity === "blocker");
  });
  if (!qcFail && !pending && !reviewerBlockers.length && !learned.length) continue;
  blocked++;
  line(`  ${String(p.homeowner_name).slice(0, 22).padEnd(24)} ${String(p.ahj).slice(0, 22).padEnd(24)} ${String(p.id).slice(0, 8)}`);
  if (qcFail) line(`      QC failures: ${qcFail}`);
  if (pending) line(`      pending human review items: ${pending}`);
  for (const b of reviewerBlockers.slice(0, 3)) line(`      reviewer blocker: ${b.title}`);
  for (const l of learned.slice(0, 3)) line(`      learned-historical gap: ${l.title}`);
}
if (!blocked) line("  none of the 25 most recent projects is blocked");

// --- Portal recipes ----------------------------------------------------------
rule("PORTAL RECIPES");
for (const r of db.query<{ id: string; status: string; version: number; utility: string; ahj: string; discipline: string; steps_json: string; updated_at: string }>(
  "SELECT id, status, version, utility, ahj, discipline, steps_json, updated_at FROM portal_recipes ORDER BY updated_at DESC LIMIT 8")) {
  let steps = 0;
  try { steps = JSON.parse(r.steps_json || "[]").length; } catch { /* unreadable */ }
  line(`  ${r.id.slice(0, 8)}  ${String(r.status).padEnd(14)} v${String(r.version).padEnd(3)} ${String(steps).padStart(4)} steps  ${String(r.updated_at).slice(0, 16)}  ${r.utility || r.ahj}${r.discipline ? ` / ${r.discipline}` : ""}`);
}

// --- Latest run artifacts ----------------------------------------------------
rule("LATEST RUN ARTIFACTS");
for (const [label, dir] of [["learn", "data/learn-runs"], ["replay", "data/replay-runs"]] as const) {
  try {
    const entries = fs.readdirSync(dir).sort().reverse().slice(0, 3);
    if (!entries.length) { line(`  ${label}: (none)`); continue; }
    for (const e of entries) {
      const n = fs.readdirSync(path.join(dir, e)).filter((f) => f.endsWith(".png")).length;
      line(`  ${label}: ${e}   ${n} page screenshot(s)`);
    }
  } catch { line(`  ${label}: (no ${dir})`); }
}

// --- Errors (opt-in) ---------------------------------------------------------
if (process.argv.includes("--errors") && fs.existsSync(logFile)) {
  rule("RECENT ERRORS / WARNINGS");
  const tail = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter((l) => /ERROR|WARN/.test(l)).slice(-20);
  for (const l of tail) line("  " + l.slice(0, 190));
  if (!tail.length) line("  none");
}

line();
db.close();
