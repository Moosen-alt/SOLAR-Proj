// A LESSER OUTCOME MAY NOT OVERWRITE A GREATER ONE.
//
// updateProjectForPermitOutcome's `waiting` branch is the one branch with NO track guard, and
// its advance list used to include `issued`, `nem_approved` and `handoff_ready`. So a NEM target
// reading "still in review" dragged a project back from an ISSUED PERMIT to `submitted` — the
// utility re-describing the AHJ's finished work as pending.
//
// The other half of that line is an operator ruling (2026-09-20): the portal IS truth about
// whether a filing exists, so `awaiting_human_submit` stays in the list — an application shown in
// review was filed by a person whether or not they came back and clicked Capture Confirmation.
// That advance is the only one no human gestured for, so it is audited.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-advance-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createProject, recordPermitStatusCheck, getProjectDetail } = await import("../src/repository");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`ok   ${label}`); return; }
  failures += 1;
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

const db = await openDatabase();

const mk = (name: string, status: string): string => {
  const id = createProject(db, {
    homeownerName: name, projectAddress: "1 Monitor Way", city: "Coos Bay", state: "OR",
    zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
    systemSizeDcKw: 6, systemSizeAcKw: 5,
  } as never).project.id;
  db.run("UPDATE projects SET status = ? WHERE id = ?", [status, id]);
  return id;
};

const addTarget = (pid: string, type: "permit" | "nem", app: string): string => {
  const id = `tgt-${pid}-${type}`;
  db.run(
    `INSERT INTO permit_check_targets (id, project_id, jurisdiction, portal_name, portal_url,
       application_number, permit_number, check_frequency_days, active, target_type, created_at, updated_at)
     VALUES (?, ?, 'City of Coos Bay', 'Accela', 'https://example.gov', ?, '', 7, 1, ?, ?, ?)`,
    [id, pid, app, type, new Date().toISOString(), new Date().toISOString()],
  );
  return id;
};

const waitingSweep = async (pid: string, targetId: string): Promise<void> => {
  await recordPermitStatusCheck(db, pid, {
    targetId,
    source: "public_url",
    rawStatusText: "Record Status: In Review",
  } as never);
};

// ---------------------------------------------------------------------------
// 1. THE REWIND: an issued permit, and the UTILITY's target says "still in review".
// ---------------------------------------------------------------------------
{
  const pid = mk("Issued Permit", "issued");
  const nemTarget = addTarget(pid, "nem", "APP-999");
  await waitingSweep(pid, nemTarget);
  const after = getProjectDetail(db, pid).project.status;
  check("1a. an ISSUED permit is not dragged back to 'submitted' by the other track's waiting read",
    after === "issued", `status=${after}`);
}

// ---------------------------------------------------------------------------
// 2. Same for the other two outcomes a track has already earned.
// ---------------------------------------------------------------------------
{
  for (const earned of ["nem_approved", "handoff_ready"]) {
    const pid = mk(`Earned ${earned}`, earned);
    const t = addTarget(pid, "permit", "187-26-000999-STR");
    await waitingSweep(pid, t);
    const after = getProjectDetail(db, pid).project.status;
    check(`2. '${earned}' survives a waiting read from another target`,
      after === earned, `status=${after}`);
  }
}

// ---------------------------------------------------------------------------
// 3. THE OPERATOR RULING: the portal is truth about whether a filing exists.
//    A filing sent by hand must not sit at "awaiting your submit" forever.
// ---------------------------------------------------------------------------
{
  const pid = mk("Filed By Hand", "awaiting_human_submit");
  const t = addTarget(pid, "permit", "187-26-001000-STR");
  await waitingSweep(pid, t);
  const after = getProjectDetail(db, pid).project.status;
  check("3a. a filing the portal shows in review DOES advance from 'awaiting_human_submit'",
    after === "submitted", `status=${after}`);

  const audited = db.query<{ action: string }>(
    "SELECT action FROM audit_logs WHERE project_id = ? AND action = 'project.submitted_on_portal_evidence'",
    [pid],
  );
  check("3b. and that advance — the only one no human gestured for — is AUDITED",
    audited.length === 1, `rows=${audited.length}`);
}

// ---------------------------------------------------------------------------
// 4. The ordinary case still works: a submitted project stays submitted.
// ---------------------------------------------------------------------------
{
  const pid = mk("Ordinary", "submitted");
  const t = addTarget(pid, "permit", "187-26-001001-STR");
  await waitingSweep(pid, t);
  const after = getProjectDetail(db, pid).project.status;
  check("4a. MUST PASS: an ordinary submitted filing still reports in-review without drama",
    after === "submitted", `status=${after}`);
  const audited = db.query<{ action: string }>(
    "SELECT action FROM audit_logs WHERE project_id = ? AND action = 'project.submitted_on_portal_evidence'", [pid],
  );
  check("4b. and it is NOT audited as portal-evidence — no human gesture was skipped",
    audited.length === 0, `rows=${audited.length}`);
}

console.log(failures ? `\nmonitorWaitingAdvance: ${failures} check(s) FAILED` : "\nmonitorWaitingAdvance: all checks passed");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failures) process.exit(1);
