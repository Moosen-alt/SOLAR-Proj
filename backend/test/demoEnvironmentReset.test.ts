// demo-environment.ts --reset MUST REMOVE THE WHOLE DEMO OR NOTHING.
//
// THE DEFECT, MEASURED. --reset deleted each demo project's child rows in ONE pass in schema
// order. Child tables reference each other (permit_status_checks.target_id →
// permit_check_targets), so on a kit seeded by demo-later-stages.ts — whose projects carry status
// checks — it crashed with "FOREIGN KEY constraint failed" after removing two of eight projects,
// and exited leaving the demo half-deleted.
//
//   MUST PASS    — a demo company whose project has a tracking target AND a status check that
//                  references it (both written through the real repository paths), plus a
//                  company-level customer row: --reset exits 0 and every demo row is gone.
//   MUST EXCLUDE — another company's client + project in the same database are untouched.
//   ATOMICITY    — a reference the reset cannot clear (an injected table pointing at the status
//                  check) makes it exit non-zero AND leaves every count exactly as it was: the
//                  transaction rolled back, nothing is half-removed.
//
// The script is SPAWNED through its real CLI entry (it runs on import), with cwd and
// AUTOPILOT_DB_PATH inside a temp dir; this process also chdirs there before importing the
// backend, so nothing is written under the repo's backend/data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = process.cwd();
const SCRIPT = path.join(REPO, "scripts", "demo-environment.ts");
const TSX_CLI = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-env-reset-"));
process.chdir(root);
process.env.AUTOPILOT_DB_PATH = path.join(root, "seed.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(root, "project-documents");
process.env.BACKUP_DIR = path.join(root, "backups");
process.env.AUTOPILOT_LOG_FILE = "";
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.BACKGROUND_WORKERS = "off";
process.env.CLIENT_NOTIFICATIONS = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, createPermitCheckTarget, recordPermitStatusCheck } = await import("../src/repository");
const { createCustomer } = await import("../src/crm");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

// ---- one seeded database, copied per case ------------------------------------------------
const seed = await openDatabase();
const demo = createClient(seed, { companyName: "Solaris Demo Co", ccbLicenseNumber: "000000" });
const other = createClient(seed, { companyName: "Unrelated Installer LLC", ccbLicenseNumber: "123456" });
const mk = (clientId: string, owner: string) => createProject(seed, {
  clientId, owner, street: "1 Test Way", city: "Salem", state: "OR", zip: "99999",
  ahj: "City of Salem", utility: "Portland General Electric", dcKw: "7", acKw: "5",
} as never).project;
const demoProject = mk(demo.id, "Demo Homeowner");
const otherProject = mk(other.id, "Other Homeowner");
createPermitCheckTarget(seed, demoProject.id, { targetType: "permit", permitType: "building", applicationNumber: "DEMO-T-0001" });
const targetId = String(seed.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ?", [demoProject.id])?.id ?? "");
await recordPermitStatusCheck(seed, demoProject.id, { targetId, source: "manual", rawStatusText: "Permit issued. Download permit card from the portal." });
createCustomer(seed, { name: "Demo Lead", clientId: demo.id } as never);
const statusCheckId = String(seed.get<{ id: string }>("SELECT id FROM permit_status_checks WHERE project_id = ?", [demoProject.id])?.id ?? "");
check("setup: the demo project has a status check that references its tracking target (the FK the old reset tripped)",
  Boolean(targetId && statusCheckId) && Boolean(seed.get("SELECT 1 FROM permit_status_checks WHERE id = ? AND target_id = ?", [statusCheckId, targetId])));
seed.backupTo(path.join(root, "seeded.sqlite"));
seed.close();

const counts = async (dbPath: string): Promise<Record<string, number>> => {
  const Database = (await import("better-sqlite3")).default;
  const d = new Database(dbPath, { readonly: true });
  const n = (sql: string, ...p: unknown[]) => Number((d.prepare(sql).get(...p) as { n: number }).n);
  const out = {
    demoClient: n("SELECT COUNT(*) AS n FROM clients WHERE id = ?", demo.id),
    demoProjects: n("SELECT COUNT(*) AS n FROM projects WHERE client_id = ?", demo.id),
    demoTargets: n("SELECT COUNT(*) AS n FROM permit_check_targets WHERE project_id = ?", demoProject.id),
    demoChecks: n("SELECT COUNT(*) AS n FROM permit_status_checks WHERE project_id = ?", demoProject.id),
    demoQc: n("SELECT COUNT(*) AS n FROM qc_results WHERE project_id = ?", demoProject.id),
    demoCustomers: n("SELECT COUNT(*) AS n FROM customers WHERE client_id = ?", demo.id),
    otherClient: n("SELECT COUNT(*) AS n FROM clients WHERE id = ?", other.id),
    otherProjects: n("SELECT COUNT(*) AS n FROM projects WHERE id = ?", otherProject.id),
    otherQc: n("SELECT COUNT(*) AS n FROM qc_results WHERE project_id = ?", otherProject.id),
  };
  d.close();
  return out;
};
const runReset = (dbPath: string) => spawnSync(process.execPath, [TSX_CLI, SCRIPT, "--db", dbPath, "--reset"], {
  cwd: root, encoding: "utf8", timeout: 180_000,
  env: { ...process.env, AUTOPILOT_DB_PATH: dbPath, AUTOPILOT_LOG_FILE: "" },
});

// ---- 1. the reset completes on a project with status checks ----------------------------
{
  const dbPath = path.join(root, "case1.sqlite");
  fs.copyFileSync(path.join(root, "seeded.sqlite"), dbPath);
  const before = await counts(dbPath);
  check("1pre. the case starts with the demo rows present", before.demoProjects === 1 && before.demoChecks >= 1 && before.demoCustomers === 1 && before.demoQc > 0, JSON.stringify(before));
  const r = runReset(dbPath);
  const after = await counts(dbPath);
  check("1a. --reset exits 0 on a demo project that carries a status check", r.status === 0,
    `status=${r.status} stderr=${String(r.stderr ?? "").split("\n").filter((l) => /Error|REFUSED|FOREIGN/.test(l)).slice(0, 3).join(" | ")}`);
  check("1b. every demo row is gone (client, project, target, check, QC, customer)",
    after.demoClient === 0 && after.demoProjects === 0 && after.demoTargets === 0 && after.demoChecks === 0 && after.demoQc === 0 && after.demoCustomers === 0,
    JSON.stringify(after));
  check("1c. MUST EXCLUDE: the other company's client, project and QC rows are untouched",
    after.otherClient === 1 && after.otherProjects === 1 && after.otherQc === before.otherQc, JSON.stringify(after));
}

// ---- 2. a reference it cannot clear rolls the WHOLE reset back -----------------------------
{
  const dbPath = path.join(root, "case2.sqlite");
  fs.copyFileSync(path.join(root, "seeded.sqlite"), dbPath);
  {
    // Failure injection, not setup of the thing under test: a table this script has never heard
    // of, pointing at the demo's status check, which no project_id/client_id sweep can clear.
    const Database = (await import("better-sqlite3")).default;
    const d = new Database(dbPath);
    d.exec("CREATE TABLE zz_unknown_ref (id TEXT PRIMARY KEY, check_id TEXT REFERENCES permit_status_checks(id))");
    d.prepare("INSERT INTO zz_unknown_ref (id, check_id) VALUES ('x', ?)").run(statusCheckId);
    d.close();
  }
  const before = await counts(dbPath);
  const r = runReset(dbPath);
  const after = await counts(dbPath);
  check("2a. an uncleared reference makes --reset exit non-zero", r.status !== 0 && r.status !== null, `status=${r.status}`);
  check("2b. and says it rolled back", /rolled back/i.test(String(r.stderr ?? "")), String(r.stderr ?? "").slice(-300));
  check("2c. ATOMIC: every count is exactly as before — nothing half-removed", JSON.stringify(before) === JSON.stringify(after),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
}

process.chdir(REPO);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp; best effort */ }
console.log(failures ? `\ndemoEnvironmentReset: ${failures} FAILED` : "\ndemoEnvironmentReset: all checks passed");
process.exit(failures ? 1 : 0);
