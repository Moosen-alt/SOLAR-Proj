import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-upgrade-"));
const dbPath = path.join(tmpDir, "legacy.sqlite");

// Simulate a PRE-change production DB: portal_recipes exists WITHOUT `discipline`,
// with the old UNIQUE index on profile_key alone, and schema_meta stamped at v13.
const raw = new Database(dbPath);
raw.exec(`
  CREATE TABLE portal_recipes (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL DEFAULT 'ahj',
    profile_key TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT '',
    ahj TEXT NOT NULL DEFAULT '',
    utility TEXT NOT NULL DEFAULT '',
    portal_platform TEXT NOT NULL DEFAULT '',
    portal_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'recording',
    version INTEGER NOT NULL DEFAULT 1,
    steps_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX idx_portal_recipes_profile ON portal_recipes(profile_key);
  CREATE TABLE schema_meta (version INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', applied_at TEXT NOT NULL);
`);
for (let v = 1; v <= 13; v++) raw.prepare("INSERT INTO schema_meta (version, name, applied_at) VALUES (?, ?, ?)").run(v, "pre", "2026-01-01");
raw.prepare(`INSERT INTO portal_recipes (id, scope_type, profile_key, state, ahj, utility, portal_platform, portal_url, status, version, steps_json, created_by, created_at, updated_at, notes)
  VALUES ('legacy-1','ahj','or|city of coos bay|pacific power','OR','City of Coos Bay','Pacific Power','accela','https://aca-oregon.accela.com/oregon/','complete',3,?, 'admin','2026-01-01','2026-01-01','')`)
  .run(JSON.stringify([{ action: "click", note: "work location: select city/structural address row" }]));
raw.close();

process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.SEED_TEST_INSTALLER = "false";
const { openDatabase } = await import("./backend/src/db");
try {
  const db = await openDatabase();
  console.log("OPENED OK");
  console.log(JSON.stringify(db.get("SELECT id, discipline, status FROM portal_recipes WHERE id='legacy-1'")));
  db.close();
} catch (err) {
  console.log("UPGRADE FAILED:", err instanceof Error ? err.stack : String(err));
}
