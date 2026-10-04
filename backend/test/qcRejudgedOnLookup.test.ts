// QC'S DOCUMENT ROWS ARE RE-JUDGED WHEN A PERMIT-PROCESS LOOKUP LANDS (#112).
//
// The per-AHJ permit-process lookup is where the AHJ's cited required-documents list comes from, and
// QC's `docs.complete` row is judged from it. QC runs at create, before the lookup lands; when the
// permit_process_lookup job finished, the worker started fee research and nothing else, so the row
// kept saying "not yet confirmed" until QC happened to run again — the list was never applied to the
// plan set that triggered the lookup.
//
// Pinned:
//   1 THE POINT     — a pre-stage project whose QC said the list is unknown: after the lookup job lands
//                     with a cited list holding one item not attached, docs.complete names that item.
//   2 MUST-EXCLUDE  — a project in another AHJ (same state) is untouched; so is a project in the AHJ
//                     whose QC has never run (the re-judge refreshes verdicts, it does not start QC).
//   3 NO MODEL CALL — the worker's provider is the stub; its webLookup is never asked (the lookup row is
//                     already on file), and the parser output is not rewritten.
//   4 FAILED FOR GOOD — with the lookup enabled (placeholder key, web lookup stubbed to throw), a job
//                     that failed for good re-judges nothing: no qc_rerun, and QC's trigger queues no
//                     fresh lookup for the AHJ (the loop Helm's review on #130 found).
//
// KILLS (verified by hand): drop the permit_process_lookup arm in jobQueue.rejudgeAfterJurisdictionLookup
// -> 1 FAILS; match on state only (no permitProcessKey) -> 2 FAILS; drop the 'done' check in that arm
// -> 4 FAILS.
//
//   npx tsx backend/test/qcRejudgedOnLookup.test.ts
import "./_isolate"; // FIRST: temp cwd, so filled/ docs/ never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qc-rejudged-lookup-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmp, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.CODE_RESEARCH = "off";
process.env.SKIP_CODE_RESEARCH = "1";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.PORTAL_AUTOMATION = "off";
process.env.PERMIT_PROCESS_LOOKUP = "off";
delete process.env.AUTO_STAGE_STEPS;
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail.slice(0, 600)}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { savePermitProcessLookup } = await import("../src/permitProcess");
const { StubLLMProvider } = await import("../src/llm");
const jobQueue = await import("../src/jobQueue");

const db = await openDatabase();
clearInterval(jobQueue.startJobWorker(db));

// NO MODEL CALL: count every web lookup the worker's (stub) provider is asked for.
let webLookups = 0;
const realWebLookup = StubLLMProvider.prototype.webLookup;
StubLLMProvider.prototype.webLookup = async function (this: InstanceType<typeof StubLLMProvider>) {
  webLookups += 1;
  return realWebLookup.call(this);
};

// Synthetic jurisdictions (no shipped profile); field set from e2eGapClose's COMPLETE job.
const COMPLETE: Record<string, string> = {
  street: "12 Lookup Way", zip: "99999",
  account: "1234567890", meter: "987654321", dcKw: "8.6", acKw: "6.5", exportKw: "6.5", moduleMake: "Qcells",
  moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20", invMake: "SolarEdge", invModel: "SE7600H-US", invQty: "1", invOutputW: "7600",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40", permitPath: "engineered",
  framingType: "rafter", roofRafterSpacing: "24", roofRafterSpan: "10", snow: "25", deadLoad: "3.2", wind: "B", mounting: "Roof mount",
};
const HERE = { state: "PA", city: "Harbor Ridge", ahj: "City of Harbor Ridge", utility: "Harbor Ridge Power" };
const ELSEWHERE = { state: "PA", city: "Elk Ridge", ahj: "City of Elk Ridge", utility: "Elk Ridge Power" };
const pdf = (label: string): Buffer => Buffer.from(`%PDF-1.4\n% ${label}\n`, "utf8");
const client = createClient(db, { companyName: "Lookup Rejudge Solar", ccbLicenseNumber: "112112" });
let seq = 0;
const mk = (j: typeof HERE): string => {
  const d = createProject(db, { clientId: client.id, owner: `Lookup Owner ${++seq}`, ...COMPLETE, ...j } as never);
  for (const docType of ["plan_set", "site_plan", "sld", "structural_letter", "module_spec", "inverter_spec"]) {
    saveProjectDocument(db, d.project.id, { docType, filename: `${docType}.pdf`, contentType: "application/pdf", buffer: pdf(docType), source: "upload" });
  }
  return d.project.id;
};
const { rerunQc } = await import("../src/repository");
const docsComplete = (pid: string) => db.get<{ qc_status: string; message: string; created_at: string }>(
  "SELECT qc_status, message, created_at FROM qc_results WHERE project_id = ? AND rule_id = 'docs.complete'", [pid]);
const parserJson = (pid: string) => String(db.get<{ parser_json: string }>("SELECT parser_json FROM projects WHERE id = ?", [pid])?.parser_json ?? "");
const tick = () => new Promise((r) => setTimeout(r, 15)); // ISO timestamps are ms-grained

const here = mk(HERE);
const elsewhere = mk(ELSEWHERE);
const neverRan = mk(HERE);
for (const pid of [here, elsewhere]) {
  rerunQc(db, pid, { holdStatusOnNewBillOnlyFails: true });
  db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [pid]);
}
// A pre-stage project in the AHJ whose QC has never run (rows cleared): not this re-judge's to start.
db.run("DELETE FROM qc_results WHERE project_id = ?", [neverRan]);
db.run("UPDATE projects SET status = 'ready_to_stage' WHERE id = ?", [neverRan]);

check("setup: QC before the lookup says the list is not yet confirmed",
  /not yet confirmed/i.test(docsComplete(here)?.message || "") && /not yet confirmed/i.test(docsComplete(elsewhere)?.message || ""),
  JSON.stringify([docsComplete(here), docsComplete(elsewhere)]));
const elsewhereBefore = docsComplete(elsewhere);
const parserBefore = parserJson(here);
await tick();

// What the lookup job's run wrote (savePermitProcessLookup lands it 'seeded' before the job leaves
// 'running'): a cited list — five items the plan set holds, one it does not. Every part answered, so
// the job's own run is "already looked up" and asks the model nothing.
const url = "https://www.harborridge-pa.gov/building/solar";
const cited = <T>(value: T, quote: string) => ({ value, sourceUrl: url, quote, origin: "lookup" as const });
const LIST = ["Plan set", "Site plan showing setbacks and the array", "Single-line electrical diagram",
  "Module and inverter specification sheets", "Stamped structural letter", "Copy of the current utility bill"];
const saved = savePermitProcessLookup(db, {
  state: HERE.state, ahj: HERE.ahj, lookedUpAt: new Date().toISOString(),
  issuingAgency: cited(HERE.ahj, HERE.ahj), permitStructure: cited("combined", "one building permit"),
  permits: [{
    discipline: "structural", label: "Building permit", issuingAgency: cited(HERE.ahj, HERE.ahj),
    portalUrl: cited(url, "apply online"), recordType: cited("Residential Solar", "Residential Solar"),
    fee: cited({ amountUsd: 150, basis: "flat", lines: [{ label: "Solar", amountUsd: 150 }] }, "Solar $150"),
    documents: cited(LIST, LIST[0]),
  }],
} as never);
check("setup: the lookup row landed seeded", saved.saved, saved.reason);
check("setup: saving the row alone re-judges nothing (the stale row the issue describes)",
  /not yet confirmed/i.test(docsComplete(here)?.message || ""), JSON.stringify(docsComplete(here)));

// Only the lookup job runs: QC at create queued fee research, which is not this test's subject.
db.run("UPDATE job_queue SET status = 'failed', error = 'parked by test' WHERE status = 'pending'");
const job = jobQueue.enqueueJob(db, "permit_process_lookup", { state: HERE.state, ahj: HERE.ahj, utility: HERE.utility }, { priority: 3, maxRetries: 1 });
check("the worker ran the lookup job", await jobQueue.processNextJob(db));
const finished = db.get<{ status: string; result: string }>("SELECT status, result FROM job_queue WHERE id = ?", [job.id]);

const row = docsComplete(here);
check("1. THE POINT: after the lookup lands, docs.complete names the item the plan set lacks",
  row?.qc_status === "warning" && /utility bill/i.test(row.message) && /1 of 6 missing/.test(row.message) && row.message.includes(url) && !/not yet confirmed/i.test(row.message),
  JSON.stringify({ row, job: finished }));
check("…recorded as a QC re-run triggered by the landing",
  Boolean(db.get("SELECT 1 FROM audit_logs WHERE project_id = ? AND action = 'project.qc_rerun' AND details LIKE '%permit_process_lookup_landed%'", [here])));
check("…and the project is still pre-stage (a warning never demotes)",
  String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [here])?.status) === "qc_passed");

const other = docsComplete(elsewhere);
check("2. MUST-EXCLUDE: a project in another AHJ is untouched",
  other?.created_at === elsewhereBefore?.created_at && other?.message === elsewhereBefore?.message, JSON.stringify(other));
check("2. MUST-EXCLUDE: a project in the AHJ whose QC never ran is not started",
  !db.get("SELECT 1 FROM qc_results WHERE project_id = ?", [neverRan]));

check("3. NO MODEL CALL: the provider's web lookup was never asked", webLookups === 0, `webLookups=${webLookups} result=${finished?.result}`);
check("3. NO PARSER RE-RUN: the parser output is unchanged", parserJson(here) === parserBefore);

// 4 FAILED FOR GOOD — the lookup ENABLED (switch on, placeholder key: ensurePermitProcessLookedUp is live), the
// provider's web lookup stubbed to throw (no network), so QC's trigger path is real. A lookup that
// failed for good wrote no row; re-judging from that branch ran QC, whose trigger re-queued the
// same lookup (its dedupe ignores failed jobs), which failed the same way — a model-call loop.
const GONE = { state: "PA", city: "Gull Ridge", ahj: "City of Gull Ridge", utility: "Gull Ridge Power" };
const gone = mk(GONE);
rerunQc(db, gone, { holdStatusOnNewBillOnlyFails: true });
db.run("UPDATE projects SET status = 'qc_passed' WHERE id = ?", [gone]);
await tick();
db.run("UPDATE job_queue SET status = 'failed', error = 'parked by test' WHERE status = 'pending'");
const { ClaudeLLMProvider } = await import("../src/llm");
let failedAsks = 0;
ClaudeLLMProvider.prototype.webLookup = async function () {
  failedAsks += 1;
  throw new Error("stub provider: web lookup unavailable");
};
delete process.env.PERMIT_PROCESS_LOOKUP;
process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
const lookupRows = () => db.query<{ id: string; status: string }>(
  "SELECT id, status FROM job_queue WHERE job_type = 'permit_process_lookup' AND payload LIKE ?", [`%"ahj":${JSON.stringify(GONE.ahj)}%`]);
const failedJob = jobQueue.enqueueJob(db, "permit_process_lookup", { state: GONE.state, ahj: GONE.ahj, utility: GONE.utility }, { priority: 3, maxRetries: 1 });
check("setup: the worker ran the failing lookup job", await jobQueue.processNextJob(db));
// QC's lookup trigger is fire-and-forget (void async): give it, and any drain it kicks, time to land.
for (let i = 0; i < 20; i++) await tick();
process.env.ANTHROPIC_API_KEY = "";
process.env.PERMIT_PROCESS_LOOKUP = "off";
check("setup: the lookup job failed for good (the stub provider was asked and threw)",
  String(db.get<{ status: string }>("SELECT status FROM job_queue WHERE id = ?", [failedJob.id])?.status) === "failed" && failedAsks >= 1,
  JSON.stringify({ rows: lookupRows(), failedAsks }));
const rows = lookupRows();
check("4. FAILED FOR GOOD: no new permit_process_lookup row is queued for that AHJ",
  rows.length === 1 && rows[0].id === failedJob.id, JSON.stringify(rows));
check("4. FAILED FOR GOOD: no QC re-run is recorded for the AHJ's project",
  !db.get("SELECT 1 FROM audit_logs WHERE project_id = ? AND action = 'project.qc_rerun' AND details LIKE '%permit_process_lookup_landed%'", [gone]));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nqcRejudgedOnLookup: all checks passed");
process.exit(0);
