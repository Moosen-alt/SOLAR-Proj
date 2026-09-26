// A SCRATCH DATABASE MUST NOT BACK UP THE REAL DOCUMENT TREE.
//
// 2026-09-26: a scratch server for a UI audit set its own AUTOPILOT_DB_PATH and BACKUP_DIR but not
// PROJECT_DOCS_DIR / PORTAL_PROFILES_DIR. Both resolved to the real trees, and the startup
// snapshot copied 1.2 GB of customer documents and the live portal login sessions into the
// auditor's scratch folder. The backup-directory marker could not see it — the backup directory
// really was the scratch database's; the SOURCE trees were not.
//
// This test builds a fake data root (a fake "real" document tree and a fake portal-profile tree at
// their DEFAULT locations) and chdirs into it before importing, so the module's defaults resolve
// there and nothing on the real disk is ever in reach — even with the fix removed.
//
//   A. MUST-EXCLUDE — a database NOT at the default path, trees at their defaults: 0 files copied,
//      the mirror directories hold 0 files, and the skip is named on the result.
//   B. MUST-PASS    — the production shape (database AND trees at their defaults): every file
//      mirrored, exactly as before.
//   C. MUST-PASS    — a scratch database whose trees were ALSO moved (every test in the chain):
//      its own trees are mirrored.
//
// Order is load-bearing: A runs first against an empty mirror, so its zero cannot be the
// "already mirrored" zero that a B-first order would produce.
//
//   npx tsx backend/test/backupMirrorScope.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backup-mirror-scope-"));
const backupDir = path.join(fakeRoot, "backups");
const realDocs = path.join(fakeRoot, "backend", "data", "project-documents");
const realProfiles = path.join(fakeRoot, "portal-profiles");
const DOC_FILES = ["11111111-aaaa-4bbb-8ccc-000000000001/plan-set.pdf", "11111111-aaaa-4bbb-8ccc-000000000002/bill.pdf"];
const SESSION_FILES = ["client-a/accela_oregon/aca-prod.accela.com/Default/Cookies", "client-a/accela_oregon/aca-prod.accela.com/Default/Preferences"];
for (const rel of DOC_FILES) {
  fs.mkdirSync(path.dirname(path.join(realDocs, rel)), { recursive: true });
  fs.writeFileSync(path.join(realDocs, rel), `fake customer document ${rel}`);
}
for (const rel of SESSION_FILES) {
  fs.mkdirSync(path.dirname(path.join(realProfiles, rel)), { recursive: true });
  fs.writeFileSync(path.join(realProfiles, rel), `fake session ${rel}`);
}

process.chdir(fakeRoot);
// The trees are left at their DEFAULTS — exactly the incident. Explicitly unset, because
// dotenv/config or the calling shell may carry values.
delete process.env.PROJECT_DOCS_DIR;
delete process.env.PORTAL_PROFILES_DIR;
delete process.env.BACKUP_SECOND_DIR;
process.env.BACKUP_DIR = backupDir;
process.env.BACKUP_INTERVAL_HOURS = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTOPILOT_DB_PATH = path.join(fakeRoot, "scratch", "scratch.sqlite");
fs.mkdirSync(path.join(fakeRoot, "scratch"), { recursive: true });
fs.mkdirSync(path.join(fakeRoot, "backend", "data"), { recursive: true });

const { openDatabase } = await import("../src/db");
const { runBackup, mirrorTreeBelongsToDatabase } = await import("../src/backup");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};
const filesUnder = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(dir);
  return out;
};
const docsMirror = path.join(backupDir, "documents");
const profilesMirror = path.join(backupDir, "portal-profiles");
const marker = path.join(backupDir, ".backup-source.json");

console.log("\n0. THE PREDICATE");
{
  const d = { tree: "C:/data/project-documents", db: "C:/data/autopilot.sqlite" };
  check("0a. MUST-EXCLUDE: default tree + another database -> no",
    !mirrorTreeBelongsToDatabase("C:/data/project-documents", "C:/scratch/x.sqlite", d));
  check("0b. MUST-EXCLUDE: an explicit env spelling the default path is still the default tree",
    !mirrorTreeBelongsToDatabase("c:\\data\\project-documents", "C:/scratch/x.sqlite", d));
  check("0c. MUST-PASS: default tree + default database -> yes",
    mirrorTreeBelongsToDatabase("C:/data/project-documents", "c:\\data\\autopilot.sqlite", d));
  check("0d. MUST-PASS: a moved tree + another database -> yes",
    mirrorTreeBelongsToDatabase("C:/scratch/docs", "C:/scratch/x.sqlite", d));
  check("0e. MUST-PASS: another database IN the default data directory (the test isolate's test.sqlite) -> yes",
    mirrorTreeBelongsToDatabase("C:/data/project-documents", "C:/data/test.sqlite", d));
  check("0f. MUST-EXCLUDE: a database in a sub-folder of the data directory is not the data directory",
    !mirrorTreeBelongsToDatabase("C:/data/project-documents", "C:/data/scratch/x.sqlite", d));
}

console.log("\nA. MUST-EXCLUDE — a scratch database never mirrors the default (real) trees");
{
  const db = await openDatabase();
  const info = runBackup(db);
  check("A1. no document copied", info.documentsCopied === 0, `copied ${info.documentsCopied}`);
  check("A2. no portal session file copied", info.portalSessionFilesCopied === 0, `copied ${info.portalSessionFilesCopied}`);
  check("A3. the document mirror holds 0 files", filesUnder(docsMirror).length === 0, filesUnder(docsMirror).join(", "));
  check("A4. the profile mirror holds 0 files", filesUnder(profilesMirror).length === 0, filesUnder(profilesMirror).join(", "));
  check("A5. the skip is NAMED on the result (never silent)",
    info.mirrorSkipped.length === 2 && info.mirrorSkipped.some((s) => s.startsWith("document")) && info.mirrorSkipped.some((s) => s.startsWith("portal-profile")),
    JSON.stringify(info.mirrorSkipped));
  const status = JSON.parse(fs.readFileSync(path.join(backupDir, ".last-backup.json"), "utf8"));
  check("A6. ...and in the status file", Array.isArray(status.mirrorSkipped) && status.mirrorSkipped.length === 2,
    JSON.stringify(status).slice(0, 200));
  check("A7. the snapshot itself still ran", fs.existsSync(info.file));
  db.close();
}

console.log("\nB. MUST-PASS — the production shape still mirrors every file");
{
  fs.rmSync(marker, { force: true }); // this directory now backs up a different database, on purpose
  process.env.AUTOPILOT_DB_PATH = path.join(fakeRoot, "backend", "data", "autopilot.sqlite");
  const db = await openDatabase();
  const info = runBackup(db);
  check("B1. every document mirrored", info.documentsCopied === DOC_FILES.length, `copied ${info.documentsCopied}`);
  check("B2. every session file mirrored", info.portalSessionFilesCopied === SESSION_FILES.length, `copied ${info.portalSessionFilesCopied}`);
  check("B3. nothing reported skipped", info.mirrorSkipped.length === 0, JSON.stringify(info.mirrorSkipped));
  check("B4. the mirrored bytes are the source bytes",
    DOC_FILES.every((rel) => fs.readFileSync(path.join(docsMirror, rel), "utf8") === `fake customer document ${rel}`));
  db.close();
}

console.log("\nC. MUST-PASS — a scratch database mirrors its OWN moved trees");
{
  // Module constants are read at import, so this is checked through the predicate with the
  // shape every backend test uses (explicit temp trees beside a temp database).
  check("C1. moved document tree + scratch database",
    mirrorTreeBelongsToDatabase(path.join(fakeRoot, "scratch", "docs"), path.join(fakeRoot, "scratch", "scratch.sqlite"),
      { tree: realDocs, db: path.join(fakeRoot, "backend", "data", "autopilot.sqlite") }));
}

process.chdir(os.tmpdir());
try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch { /* Windows may hold the db briefly */ }
console.log(failures === 0 ? "\nbackupMirrorScope: all checks passed." : `\nbackupMirrorScope: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
