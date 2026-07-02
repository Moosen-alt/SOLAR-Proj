// WRONG-PORTAL regression tests: (1) migration v8 clears AHJ-keyed knowledge rows whose
// portal_url was poisoned with a utility (PowerClerk) URL — the root cause of a permit
// track staging in the NEM portal; (2) the poisoned-row shape can't survive a reopen.
// Browser-free. Run: tsx backend/test/portalUrlScope.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-url-scope-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const db = await openDatabase();
const now = new Date().toISOString();

// Simulate the pre-fix contamination: an AHJ-keyed row carrying the utility's PowerClerk
// URL, plus a legitimate utility-keyed row that must be left alone.
db.run(
  `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_url, first_seen_at, last_learned_at, updated_at)
   VALUES ('t-ahj', 'or|city of testville|pge', 'OR', 'City of Testville', 'PGE', 'https://pgenm.powerclerk.com/MvcAccount/Login', ?, ?, ?)`,
  [now, now, now],
);
db.run(
  `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_url, first_seen_at, last_learned_at, updated_at)
   VALUES ('t-util', 'or||pge', 'OR', '', 'PGE', 'https://pgenm.powerclerk.com/MvcAccount/Login', ?, ?, ?)`,
  [now, now, now],
);

// Force migration v8 to re-run against the poisoned data (fresh DBs apply it before any
// rows exist, so replay it the way an existing production DB would receive it).
db.run("DELETE FROM schema_meta WHERE version = 8");
const db2 = await openDatabase();

const ahjRow = db2.get<{ portal_url: string }>("SELECT portal_url FROM permit_utility_knowledge WHERE id = 't-ahj'");
run("v8 clears the PowerClerk URL from the AHJ-keyed row", ahjRow?.portal_url === "", `got: ${ahjRow?.portal_url}`);

const utilRow = db2.get<{ portal_url: string }>("SELECT portal_url FROM permit_utility_knowledge WHERE id = 't-util'");
run("v8 keeps the utility-keyed row's PowerClerk URL", (utilRow?.portal_url || "").includes("powerclerk.com"), `got: ${utilRow?.portal_url}`);

fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures > 0) { console.error(`\n${failures} portal-url-scope test(s) FAILED.`); process.exit(1); }
console.log("\nAll portal-url-scope tests passed.");
process.exit(0);
