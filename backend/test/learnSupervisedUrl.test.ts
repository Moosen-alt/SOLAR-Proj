// B10 — `npm run learn:supervised -- --url <portal>` opens the operator's portal, judged by the
// SAME predicate the dashboard's auto-learn route uses (assertOperatorPortalUrlFits ->
// portalChannel.hostFitsTrackAndEntity, CLAUDE.md rule 5).
//
// Four of Monday's five supervised learns had no usable KB/recipe URL (Carlsbad and Iowa City
// have no KB portal; Columbus's seeded row is the old ca.columbus.gov), so the script either
// exited or opened the wrong site.
//
//   MUST-PASS:    an EnerGov permit portal on a permit learn is taken, and it wins over the KB.
//   MUST-EXCLUDE: a PowerClerk (utility) URL on a permit learn is REFUSED (exit 1, nothing opened);
//                 a Tyler-hosted permit portal on an NEM learn is refused; a PDF guide is refused;
//                 a non-URL is refused.
//   KILL: the assertOperatorPortalUrlFits call disabled -> the NEM and PDF cases go red.
//
// Every case runs the real script with --dry-run on a scratch DB, so no browser opens.
//   npx tsx backend/test/learnSupervisedUrl.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-supervised-url-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const db = await openDatabase();

const now = new Date().toISOString();
const projectId = "lsu-proj-0001";
// A bare project row: this test is about the CLI's door, not about how a project is born.
db.run(
  `INSERT INTO projects (id, homeowner_name, project_address, city, state, zip, ahj, utility, status, parser_json, created_at, updated_at)
   VALUES (?, 'Test Homeowner', '410 E Washington St', 'Iowa City', 'IA', '52240', 'City of Iowa City', 'MidAmerican Energy', 'parsed', '{}', ?, ?)`,
  [projectId, now, now],
);

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const script = path.join(repoRoot, "scripts", "learn-supervised.ts");

function runScript(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [tsxCli, script, "--project", projectId, ...args, "--dry-run"], {
    cwd: repoRoot,
    env: { ...process.env, AUTOPILOT_DB_PATH: dbPath, SEED_TEST_INSTALLER: "false" },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { code: r.status, out: `${r.stdout || ""}\n${r.stderr || ""}` };
}

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const ENERGOV = "https://egov.iowa-city.org/energovprod/selfservice#/home";
const POWERCLERK = "https://midamerican.powerclerk.com/MvcAccount/Login";

check("MUST-PASS: an EnerGov permit portal given by --url is taken on a permit learn (dry run)", () => {
  const r = runScript(["--url", ENERGOV]);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}\n${r.out.slice(-800)}`);
  assert.match(r.out, /portal\s+https:\/\/egov\.iowa-city\.org\/energovprod\/selfservice#\/home/, "the stated URL must be the one opened");
  assert.match(r.out, /--dry-run: nothing opened/);
});

check("MUST-EXCLUDE: a utility (PowerClerk) URL on a PERMIT learn is refused — rule 5, nothing opened", () => {
  const r = runScript(["--url", POWERCLERK]);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\n${r.out.slice(-800)}`);
  assert.match(r.out, /REFUSED/);
  assert.doesNotMatch(r.out, /nothing opened/, "a refused URL must stop before the dry-run line");
});

// The two refusals below are ones ONLY the shared predicate makes — the script's older
// isUtilityPlatformUrl check guards the permit side alone and knows nothing of either — so they
// are what proves --url is judged by hostFitsTrackAndEntity and not by a second spelling of it.
check("MUST-EXCLUDE: a PERMIT portal on an NEM learn is refused (rule 5, the other direction)", () => {
  const r = runScript(["--track", "nem", "--url", "https://tigardor-energovweb.tylerhost.net/apps/SelfService#/home"]);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\n${r.out.slice(-800)}`);
  assert.match(r.out, /REFUSED:.*AHJ permit portal/s);
});

check("MUST-EXCLUDE: an information page (a PDF guide) is never a portal to open", () => {
  const r = runScript(["--url", "https://www.icgov.org/files/solar-permit-guide.pdf"]);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\n${r.out.slice(-800)}`);
  assert.match(r.out, /REFUSED:.*information page/s);
});

check("MUST-EXCLUDE: --url that is not an absolute http(s) URL is refused", () => {
  const r = runScript(["--url", "egov.iowa-city.org"]);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\n${r.out.slice(-800)}`);
  assert.match(r.out, /REFUSED: --url needs an absolute/);
});

check("MUST-PASS: without --url the old behaviour stands (no KB portal -> says so and exits 1)", () => {
  const r = runScript([]);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\n${r.out.slice(-800)}`);
  assert.match(r.out, /No portal URL is on file/);
});

db.close?.();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows may hold the file */ }
if (failures) { console.error(`\n${failures} learnSupervisedUrl check(s) FAILED.`); process.exit(1); }
console.log("\nAll learnSupervisedUrl checks passed.");
