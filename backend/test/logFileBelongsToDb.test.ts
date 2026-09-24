// A TEST'S LOG LINES DO NOT BELONG IN THE LIVE SERVER'S LOG.
//
// 165 of 192 backend tests set AUTOPILOT_DB_PATH to a temp file but run with the repo as cwd, and
// logger.ts defaulted the log file to <cwd>/data/logs/backend.log — the live server's log. On
// 2026-09-23 a real permit problem was diagnosed from that file between injected test ERRORs ("the
// drift pass exploded", "the AHJ process reference could not be read"). The default now follows the
// database: a process whose DB lives outside its cwd logs beside that DB.
//
// Each case runs in its own process (LOG_FILE is resolved at module load), from a fake install dir.
//   npx tsx backend/test/logFileBelongsToDb.test.ts
import { REPO } from "./_isolate"; // FIRST — and note it sets AUTOPILOT_LOG_FILE="" for THIS process only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const loggerUrl = new URL(`file:///${path.join(REPO, "backend", "src", "logger.ts").replace(/\\/g, "/")}`).href;
const tsx = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

function runIn(install: string, dbPath: string): void {
  const script = path.join(install, "log-once.mts");
  fs.writeFileSync(script, `const { logger } = await import(${JSON.stringify(loggerUrl)});\nlogger.warn("log-test", "marker line from a child process");\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, AUTOPILOT_DB_PATH: dbPath, LOG_LEVEL: "warn" };
  delete env.AUTOPILOT_LOG_FILE; // the default path is what is under test
  const r = spawnSync(process.execPath, [tsx, script], { cwd: install, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "log-belongs-"));

check("a process whose DB lives OUTSIDE its folder logs beside the DB, not into the folder's live log", () => {
  const install = path.join(base, "install-a"); fs.mkdirSync(install, { recursive: true });
  const elsewhere = path.join(base, "elsewhere"); fs.mkdirSync(elsewhere, { recursive: true });
  runIn(install, path.join(elsewhere, "t.sqlite"));
  const liveLog = path.join(install, "data", "logs", "backend.log");
  assert.equal(fs.existsSync(liveLog), false, "the test process wrote into the installation's live log");
  const besideDb = path.join(elsewhere, "logs", "backend.log");
  assert.ok(fs.existsSync(besideDb) && fs.readFileSync(besideDb, "utf8").includes("marker line"), "the line was not written beside its DB");
});

check("CONTROL: an installation with its DB inside its folder (production, the demo kit) still logs to data/logs", () => {
  const install = path.join(base, "install-b"); fs.mkdirSync(install, { recursive: true });
  runIn(install, "backend/data/autopilot.sqlite");
  const liveLog = path.join(install, "data", "logs", "backend.log");
  assert.ok(fs.existsSync(liveLog) && fs.readFileSync(liveLog, "utf8").includes("marker line"), "production's own log line went missing");
});

if (failures) { console.error(`\n${failures} log-file test(s) failed.`); process.exit(1); }
console.log("\nAll log-file tests passed.");
