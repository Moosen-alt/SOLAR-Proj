// RESTORE DRILL — prove a backup restores, into a scratch folder, without touching anything live.
//
//   npx tsx scripts/ops/restore-drill.ts                          # newest snapshot in BACKUP_SECOND_DIR (else BACKUP_DIR)
//   npx tsx scripts/ops/restore-drill.ts --from "D:\OneDrive\SolarBackups"
//   npx tsx scripts/ops/restore-drill.ts --snapshot <file.sqlite> --keep-scratch
//
// KEY ESCROW TEST (the one that matters on a second machine): put the escrowed key in the SHELL,
// then run with --no-dotenv so the .env on this box cannot quietly supply it:
//   PowerShell:  $env:SESSION_ENCRYPTION_KEY = "<paste from the password manager>"
//                npx tsx scripts/ops/restore-drill.ts --no-dotenv --from <off-box folder>
//
// WHAT IT CHECKS, in order (each line prints PASS / WARN / FAIL):
//   1. checksum   the snapshot matches its .sha256 sidecar (no sidecar = WARN: cannot prove it)
//   2. integrity  PRAGMA integrity_check on a scratch COPY (the source is only ever read)
//   3. contents   schema version and row counts for the tables a restore must bring back
//   4. documents  every project_documents row has its file in the backup's documents/ mirror
//   5. logins     saved portal credentials DECRYPT with the SESSION_ENCRYPTION_KEY in this
//                 environment — without the key, a restore elsewhere leaves every saved login
//                 unreadable (83 of them on the production box today)
//   6. boot       this checkout's own openDatabase() opens a second scratch copy and applies any
//                 migrations (skip with --no-boot-check)
//
// PRIVACY: counts only. No names, addresses, file names or credential values are printed.
// NEVER WRITES outside the scratch folder (a temp dir unless --to), which it deletes unless
// --keep-scratch. The backup folder is opened read-only.
//
// EXIT: 0 PASS, 1 FAIL, 3 PASS WITH WARNINGS, 2 bad configuration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name: string): string => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3).trim();
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1].trim() : "";
};
// Where the key came from is part of the verdict: a key read from this box's .env proves the box
// can read its own backups, NOT that the escrowed copy works. Decided before dotenv loads.
const keyFromShell = Boolean(process.env.SESSION_ENCRYPTION_KEY);
if (!args.includes("--no-dotenv")) await import("dotenv/config");

const { listAutomaticSnapshots, verifyChecksum } = await import("../../backend/src/offboxBackup");
const { default: Database } = await import("better-sqlite3");

const line = (s = ""): void => console.log(s);
type Verdict = "PASS" | "WARN" | "FAIL";
const results: { check: string; verdict: Verdict; detail: string }[] = [];
const record = (check: string, verdict: Verdict, detail: string): void => {
  results.push({ check, verdict, detail });
  line(`  ${verdict.padEnd(4)}  ${check.padEnd(10)} ${detail}`);
};

const fromArg = flag("from") || process.env.BACKUP_SECOND_DIR || process.env.BACKUP_DIR || "backend/data/backups";
const fromDir = path.resolve(process.cwd(), fromArg);
let snapshot = flag("snapshot") ? path.resolve(process.cwd(), flag("snapshot")) : "";
if (!snapshot) {
  const newest = listAutomaticSnapshots(fromDir)[0];
  if (!newest) {
    line(`restore-drill: no automatic snapshot (autopilot-<stamp>.sqlite) in ${fromDir}.`);
    process.exit(2);
  }
  snapshot = path.join(fromDir, newest);
}
if (!fs.existsSync(snapshot)) {
  line(`restore-drill: snapshot not found: ${snapshot}`);
  process.exit(2);
}
// The documents mirror sits beside the snapshots in both BACKUP_DIR and the off-box folder.
const docsMirror = path.join(path.dirname(snapshot), "documents");
const scratch = flag("to") ? path.resolve(process.cwd(), flag("to")) : fs.mkdtempSync(path.join(os.tmpdir(), "restore-drill-"));
fs.mkdirSync(scratch, { recursive: true });
const keepScratch = args.includes("--keep-scratch");

line(`restore-drill   ${new Date().toISOString()}`);
line(`  snapshot  ${snapshot}`);
line(`  scratch   ${scratch}${keepScratch ? "  (kept)" : "  (deleted afterwards)"}`);
line();

let exitCode = 0;
try {
  // 1. CHECKSUM ---------------------------------------------------------------
  const v = verifyChecksum(snapshot);
  if (v.state === "ok") record("checksum", "PASS", `matches its .sha256 sidecar (${v.sha256.slice(0, 16)}…)`);
  else if (v.state === "no-sidecar") record("checksum", "WARN", "no .sha256 sidecar — written by a server build without checksums; integrity below is the only proof");
  else record("checksum", "FAIL", `does NOT match its sidecar (expected ${v.expected.slice(0, 16)}…, got ${v.actual.slice(0, 16)}…) — this copy is damaged; try an older snapshot`);

  // 2. INTEGRITY (on a copy; the backup itself is only read) --------------------
  const restored = path.join(scratch, "autopilot.sqlite");
  fs.copyFileSync(snapshot, restored);
  const db = new Database(restored, { readonly: true, fileMustExist: true });
  let integrity = "";
  try {
    integrity = db.prepare("PRAGMA integrity_check").all().map((r) => String(Object.values(r as object)[0])).join("; ");
  } catch (err) {
    integrity = `could not run: ${(err as Error).message.slice(0, 120)}`;
  }
  if (integrity === "ok") record("integrity", "PASS", "PRAGMA integrity_check = ok");
  else record("integrity", "FAIL", `PRAGMA integrity_check: ${integrity.slice(0, 200)}`);

  // 3. CONTENTS ---------------------------------------------------------------
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String((r as { name: string }).name)));
  const count = (t: string): number | null => (tables.has(t) ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n) : null);
  const version = tables.has("schema_meta") ? Number((db.prepare("SELECT MAX(version) AS v FROM schema_meta").get() as { v: number }).v ?? 0) : 0;
  const counts = ["projects", "clients", "submissions", "project_documents", "portal_credentials", "users"]
    .map((t) => `${t}=${count(t) ?? "MISSING"}`);
  const essentialMissing = ["projects", "clients", "project_documents", "portal_credentials"].filter((t) => !tables.has(t));
  if (essentialMissing.length) record("contents", "FAIL", `tables missing: ${essentialMissing.join(", ")}`);
  else record("contents", "PASS", `schema v${version}; ${counts.join("  ")}`);

  // 4. DOCUMENTS ----------------------------------------------------------------
  if (tables.has("project_documents")) {
    const rows = db.prepare("SELECT stored_path FROM project_documents").all() as { stored_path: string | null }[];
    let present = 0;
    let missing = 0;
    for (const r of rows) {
      // Stored paths are absolute on the machine that wrote them; the mirror keeps the tail
      // <projectId>/<docId>-<name>. Compare on that tail so a restore on ANOTHER box checks too.
      const parts = String(r.stored_path ?? "").split(/[\\/]+/).filter(Boolean);
      const rel = parts.slice(-2).join(path.sep);
      if (rel && fs.existsSync(path.join(docsMirror, rel))) present++;
      else missing++;
    }
    if (!rows.length) record("documents", "PASS", "no document rows to check");
    else if (!present) record("documents", "FAIL", `0 of ${rows.length} document files are in ${docsMirror} — a restore would 404 on every upload (run scripts/ops/offbox-sync.ts)`);
    else if (missing) record("documents", "WARN", `${present} of ${rows.length} document files present in the mirror; ${missing} missing`);
    else record("documents", "PASS", `${present} of ${rows.length} document files present in the mirror`);
  }

  // 5. LOGINS (the key-escrow check) ---------------------------------------------
  if (tables.has("portal_credentials")) {
    const creds = db.prepare("SELECT encrypted_secret FROM portal_credentials").all() as { encrypted_secret: string | null }[];
    const key = process.env.SESSION_ENCRYPTION_KEY || "";
    const source = keyFromShell ? "the shell environment" : "this machine's .env (NOT an escrow test — see the header)";
    if (!creds.length) record("logins", "PASS", "no saved portal credentials");
    else if (!key || key === "replace-with-a-long-random-secret") {
      record("logins", "WARN", `SESSION_ENCRYPTION_KEY is not set here, so the ${creds.length} saved login(s) cannot be proven readable. Escrow the key and re-run with it.`);
    } else {
      const { decryptStorageState } = await import("../../portal-bot/src/cryptoStorage");
      let readable = 0;
      for (const c of creds) {
        try { if (c.encrypted_secret && decryptStorageState(String(c.encrypted_secret))) readable++; } catch { /* unreadable */ }
      }
      if (!readable) record("logins", "FAIL", `0 of ${creds.length} saved login(s) decrypt with the key from ${source}. That key is wrong or not the escrowed one — every portal password would have to be collected again.`);
      else if (readable < creds.length) record("logins", "WARN", `${readable} of ${creds.length} saved login(s) decrypt with the key from ${source}; ${creds.length - readable} do not (rows written under an older key are already dead on the live box too)`);
      else record("logins", keyFromShell ? "PASS" : "WARN", `${readable} of ${creds.length} saved login(s) decrypt with the key from ${source}`);
    }
  }
  db.close();

  // 6. BOOT --------------------------------------------------------------------
  if (!args.includes("--no-boot-check")) {
    const bootCopy = path.join(scratch, "boot.sqlite");
    fs.copyFileSync(snapshot, bootCopy);
    // Everything the app resolves at module load must point into the scratch folder: the log
    // (never append drill noise to the live backend.log), and the data folders.
    process.env.AUTOPILOT_DB_PATH = bootCopy;
    process.env.AUTOPILOT_LOG_FILE = "";
    process.env.SEED_TEST_INSTALLER = "false";
    process.env.PROJECT_DOCS_DIR = path.join(scratch, "project-documents");
    process.env.PAGE_IMAGE_CACHE_DIR = path.join(scratch, "page-images");
    try {
      const { openDatabase } = await import("../../backend/src/db");
      const app = await openDatabase();
      const after = Number(app.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_meta")?.v ?? 0);
      app.close();
      record("boot", "PASS", `this checkout opens it (schema v${version} -> v${after} after migrations)`);
    } catch (err) {
      record("boot", "FAIL", `this checkout could not open it: ${(err as Error).message.slice(0, 200)}`);
    }
  }
} catch (err) {
  record("drill", "FAIL", `stopped: ${(err as Error).message.slice(0, 200)}`);
} finally {
  if (!keepScratch) {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
  }
}

const fails = results.filter((r) => r.verdict === "FAIL").length;
const warns = results.filter((r) => r.verdict === "WARN").length;
line();
if (fails) { line(`RESTORE DRILL: FAIL (${fails} failed, ${warns} warning(s))`); exitCode = 1; }
else if (warns) { line(`RESTORE DRILL: PASS WITH ${warns} WARNING(S)`); exitCode = 3; }
else line("RESTORE DRILL: PASS");
process.exit(exitCode);
