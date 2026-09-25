// THE LIVE-DEMO SEEDER CREATES TWO TEST PROJECTS THAT TEACH NOTHING AND QUEUE NOTHING.
//
// scripts/demo-kit/seed-live-demo-project.ts seeds project A (recorded capture) and project B
// (bot replay) for the supervised PGE recording session, through the product's real creation
// path. Three things it promises, each pinned here with a CONTROL that proves the assertion
// has teeth (a test that passes without the fix is not a test):
//
//   1. LEARNING_EXCLUDED. Both rows carry the flag and write no knowledge event.
//      CONTROL: the same payload through bare createProject writes a knowledge event.
//   2. NOTHING QUEUED. With the job worker "running" (the production shape — QC's fee-research
//      trigger is gated on jobWorkerRunning()) and the seeder's env switches, no research /
//      learn / staging job exists for the projects or was created during the seed.
//      CONTROL: the same payload through bare createProject with the seeder's switches removed
//      queues fee_research for a jurisdiction with no fee row — so the seeder's "0" means the
//      switches held, not that nothing could fire.
//   3. THE CLI REFUSES: --apply with AUTOPILOT_DB_PATH unset (before the backend loads — db.ts
//      would default to backend/data/autopilot.sqlite under the cwd); --apply with a missing
//      account; and --dry-run opens no database at all.
//
// Also: valid, unreachable contact formats (555-01xx, @example.com), the documents PGE's form
// asks for attached through saveProjectDocument, and B differing from A in every tripwire.
// Run: npx tsx backend/test/liveDemoSeeder.test.ts
import { REPO, ISOLATED_CWD } from "./_isolate";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

process.env.AUTOPILOT_DB_PATH = path.join(ISOLATED_CWD, "backend", "data", "seeder-test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.CLIENT_NOTIFICATIONS = "off";
process.env.BACKGROUND_WORKERS = "off";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.AHJ_FORM_RESEARCH = "off";
process.env.PORTAL_URL_RESEARCH = "off";
process.env.RUN_TRIAGE = "off";
// The switches the SEEDER must apply itself — unset here so a pass cannot come from the shell.
delete process.env.FEE_RESEARCH;
delete process.env.CODE_RESEARCH;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { startJobWorker, jobWorkerRunning } = await import("../src/jobQueue");
const seeder = await import("../../scripts/demo-kit/seed-live-demo-project");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

const db = await openDatabase();
const client = createClient(db, { companyName: "Seeder Test Installer LLC", ccbLicenseNumber: "000001" });
// The production shape: a worker is running, so QC's fee-research trigger is live.
const timer = startJobWorker(db);
clearInterval(timer);
check("SETUP: the job worker reads as running (QC's fee-research trigger is armed)", jobWorkerRunning());

const n = (sql: string, params: Array<string | number> = []) => Number(db.get<{ n: number }>(sql, params)?.n ?? 0);
const opts: import("../../scripts/demo-kit/seed-live-demo-project").SeedOptions = {
  ...seeder.DEFAULTS,
  clientId: client.id,
  ahj: "City of Seedertown",       // no fee row, no code profile: research WOULD fire for it
  utility: "Portland General Electric",
  accountA: "1234567890", meterA: "A1234567",
  accountB: "2345678901", meterB: "B2345678",
};

// ── 1. the seeder ───────────────────────────────────────────────────────────────────────
console.log("\n1. seeding through the real path with the worker running");
const result = await seeder.seedLiveDemoProjects(db, opts);
await settle();
const ids = result.projects.map((p) => p.id);
check("two projects created (A and B)", ids.length === 2 && result.projects.map((p) => p.label).join("") === "AB");
check("named DEMO TEST HOMEOWNER A / B",
  result.projects.every((p) => db.get<{ homeowner_name: string }>("SELECT homeowner_name FROM projects WHERE id = ?", [p.id])?.homeowner_name === seeder.HOMEOWNER[p.label]));
check("both rows are learning_excluded", n("SELECT COUNT(*) n FROM projects WHERE id IN (?, ?) AND learning_excluded = 1", ids) === 2);
check("the seeder's own audit passed", result.audit.problems.length === 0, result.audit.problems.join("; "));
check("no knowledge event was written from either project", n("SELECT COUNT(*) n FROM knowledge_events WHERE project_id IN (?, ?)", ids) === 0);
check("no job of any type is queued for either project", n("SELECT COUNT(*) n FROM job_queue WHERE project_id IN (?, ?)", ids) === 0,
  JSON.stringify(db.query<{ job_type: string }>("SELECT job_type FROM job_queue WHERE project_id IN (?, ?)", ids)));
const forbidden = seeder.FORBIDDEN_JOB_TYPES;
const forbiddenCount = () => n(`SELECT COUNT(*) n FROM job_queue WHERE job_type IN (${forbidden.map(() => "?").join(",")})`, [...forbidden]);
check("no research / learn / staging job exists at all after the seed", forbiddenCount() === 0,
  JSON.stringify(db.query<{ job_type: string; status: string }>("SELECT job_type, status FROM job_queue")));
check("the seeder applied its own switches (CODE_RESEARCH=off, FEE_RESEARCH=off, AUTOPILOT_AUTO_START=0)",
  process.env.CODE_RESEARCH === "off" && process.env.FEE_RESEARCH === "off" && process.env.AUTOPILOT_AUTO_START === "0");

for (const p of result.projects) {
  const row = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [p.id])!;
  const snap = JSON.parse(String(row.parser_json || "{}")) as Record<string, unknown>;
  check(`${p.label}: client, jurisdiction and utility as asked`, row.client_id === client.id && row.ahj === opts.ahj && row.utility === opts.utility && row.state === "OR");
  check(`${p.label}: phone is a 555-01xx number and email is @example.com`,
    /^\(\d{3}\) 555-01\d{2}$/.test(String(snap.homeownerPhone)) && /^[a-z.]+@example\.com$/.test(String(snap.homeownerEmail)), `${snap.homeownerPhone} ${snap.homeownerEmail}`);
  check(`${p.label}: account and meter are the operator's (10-digit account)`,
    /^\d{10}$/.test(String(row.account_number)) && String(row.meter_number).length >= 4, `${row.account_number} ${row.meter_number}`);
  check(`${p.label}: 200 A main, 40 A backfeed, no battery, Schedule 7, export ≤ 25 kW AC`,
    snap.mainServiceRating === "200" && snap.pvBreaker === "40" && snap.hasBattery === "No" && snap.pgeSchedule === "Schedule 7" && snap.utilitySchedule === "Schedule 7" && Number(row.total_export_kw) <= 25);
  check(`${p.label}: CEC-listed module and microinverter (snapshot canonical keys)`,
    snap.moduleModel === "Q.PEAK DUO BLK ML-G10+ 400" && snap.inverterModel === "IQ8PLUS-72-2-US" && snap.moduleManufacturer === "Qcells North America" && snap.inverterManufacturer === "Enphase Energy, Inc.");
  const docs = db.query<{ doc_type: string; stored_path: string; size_bytes: number }>("SELECT doc_type, stored_path, size_bytes FROM project_documents WHERE project_id = ?", [p.id]);
  const types = new Set(docs.map((d) => d.doc_type));
  check(`${p.label}: the four PGE upload slots are attached (sld, site_plan, inverter_spec, module_spec)`,
    ["sld", "site_plan", "inverter_spec", "module_spec"].every((t) => types.has(t)), [...types].join(","));
  check(`${p.label}: every document exists on disk, is under 5 MB and is named without a homeowner`,
    docs.every((d) => fs.existsSync(d.stored_path) && d.size_bytes < 5 * 1024 * 1024 && !/homeowner|demo test homeowner/i.test(path.basename(d.stored_path))));
  check(`${p.label}: the seeder reported the stored document paths`, p.documents.length === 4 && p.documents.every((d) => fs.existsSync(d.path)));
}
{
  const a = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [ids[0]])!;
  const b = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [ids[1]])!;
  const sa = JSON.parse(String(a.parser_json)) as Record<string, unknown>;
  const sb = JSON.parse(String(b.parser_json)) as Record<string, unknown>;
  check("A is the 7.2 kW DC / 18-module system", Number(a.system_size_dc_kw) === 7.2 && sa.moduleQuantity === "18");
  check("B differs from A in every tripwire (name, street, phone, email, account, meter, size, count)",
    a.homeowner_name !== b.homeowner_name && a.project_address !== b.project_address && sa.homeownerPhone !== sb.homeownerPhone
    && sa.homeownerEmail !== sb.homeownerEmail && a.account_number !== b.account_number && a.meter_number !== b.meter_number
    && a.system_size_dc_kw !== b.system_size_dc_kw && sa.moduleQuantity !== sb.moduleQuantity);
}
check("a second seed refuses instead of duplicating the rows",
  await seeder.seedLiveDemoProjects(db, opts).then(() => false, (e: Error) => /already exist/.test(e.message)));
check("a missing client refuses", await seeder.seedLiveDemoProjects(db, { ...opts, clientId: "no-such-client" }).then(() => false, (e: Error) => /No client/.test(e.message)));
check("A's and B's account numbers must differ", await seeder.seedLiveDemoProjects(db, { ...opts, accountB: opts.accountA }).then(() => false, (e: Error) => /must differ/.test(e.message)));
check("a .invalid email domain is refused (PowerClerk dropped one server-side)", seeder.optionProblems({ ...opts, emailDomain: "example.invalid" }).some((p) => /invalid/.test(p)));
check("a non-10-digit account is refused", seeder.accountProblem("12345", "a") !== null && seeder.accountProblem("1234567890", "a") === null);
check("--address parses street, city, zip", JSON.stringify(seeder.parseAddress("9 Elm St, Lake Oswego, 97034", seeder.DEFAULTS.addressA)) === JSON.stringify({ street: "9 Elm St", city: "Lake Oswego", zip: "97034" }));

// ── 2. CONTROLS: the same payload without the seeder's discipline ──────────────────────────
console.log("\n2. controls — bare createProject, switches removed");
delete process.env.FEE_RESEARCH;
delete process.env.CODE_RESEARCH;
const beforeForbidden = forbiddenCount();
const control = createProject(db, seeder.demoProjectPayload("A", { ...opts, accountA: "9999999999", meterA: "CTRL0001" }), undefined, {});
await settle(1200);
check("CONTROL: bare createProject writes a knowledge event (so the seeder's 0 is the flag, not chance)",
  n("SELECT COUNT(*) n FROM knowledge_events WHERE project_id = ?", [control.project.id]) > 0);
const controlJobs = db.query<{ job_type: string }>("SELECT job_type FROM job_queue WHERE created_at >= ? AND job_type IN (" + forbidden.map(() => "?").join(",") + ")", [control.project.createdAt, ...forbidden]);
check("CONTROL: with FEE_RESEARCH unset the creation path queues fee research for this jurisdiction (so the seeder's 0 means its switches held)",
  forbiddenCount() > beforeForbidden && controlJobs.some((j) => j.job_type === "fee_research"), JSON.stringify(controlJobs));
check("CONTROL: the seeded projects still have no jobs after the control fired", n("SELECT COUNT(*) n FROM job_queue WHERE project_id IN (?, ?)", ids) === 0);

// ── 3. the CLI ──────────────────────────────────────────────────────────────────────────
console.log("\n3. the CLI's refusals");
const TSX_CLI = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const SCRIPT = path.join(REPO, "scripts", "demo-kit", "seed-live-demo-project.ts");
const cliCwd = fs.mkdtempSync(path.join(ISOLATED_CWD, "cli-"));
const baseEnv = { ...process.env };
delete baseEnv.AUTOPILOT_DB_PATH;
const run = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], { cwd: cliCwd, encoding: "utf8", timeout: 120_000, env });
const accountArgs = ["--account-a", "1234567890", "--meter-a", "A1234567", "--account-b", "2345678901", "--meter-b", "B2345678"];

const noPath = run(["--apply", ...accountArgs], baseEnv);
check("--apply with AUTOPILOT_DB_PATH unset exits 2 and names the refusal", noPath.status === 2 && /AUTOPILOT_DB_PATH is unset/.test(noPath.stderr), `${noPath.status} ${noPath.stderr.slice(0, 200)}`);
check("…and created no default database under the cwd", !fs.existsSync(path.join(cliCwd, "backend", "data", "autopilot.sqlite")));

const dry = run(["--dry-run", "--address", "77 Test Ave, Tigard, 97223"], baseEnv);
check("--dry-run exits 0 with the plan and opens no database", dry.status === 0 && /DRY RUN/.test(dry.stdout) && /77 Test Ave/.test(dry.stdout) && !fs.existsSync(path.join(cliCwd, "backend")), `${dry.status} ${dry.stdout.slice(0, 200)} ${dry.stderr.slice(0, 200)}`);
check("--dry-run prints account placeholders, never digits", /<operator supplies --account-a>/.test(dry.stdout));

const before = n("SELECT COUNT(*) n FROM projects");
const missingAccount = run(["--apply", "--account-a", "1234567890", "--meter-a", "A1", "--client", client.id], { ...process.env });
check("--apply without B's account/meter exits 2 and writes nothing", missingAccount.status === 2 && /account-b is required/.test(missingAccount.stderr) && n("SELECT COUNT(*) n FROM projects") === before, `${missingAccount.status} ${missingAccount.stderr.slice(0, 300)}`);

const dupe = run(["--apply", "--client", client.id, ...accountArgs], { ...process.env });
check("--apply against a database that already holds the pair exits 2 (never duplicates)", dupe.status === 2 && /already exist/.test(dupe.stderr) && n("SELECT COUNT(*) n FROM projects") === before, `${dupe.status} ${dupe.stderr.slice(0, 300)}`);

db.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED — liveDemoSeeder");
process.exit(failures ? 1 : 0);
