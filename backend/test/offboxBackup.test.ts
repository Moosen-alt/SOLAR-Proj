// OFF-BOX BACKUPS: A SECOND COPY, A CHECKSUM, AND A DRILL THAT PROVES THE RESTORE.
//
// DAY1-OF-100 blocker 9: every snapshot and the document mirror sat on E:, an internal disk in the
// same desktop as the live database, and SESSION_ENCRYPTION_KEY was in no backup at all — a restore
// on another machine would leave all 83 saved portal logins unreadable. Nothing could prove a copy
// was intact, and the one restore drill ever run was by hand.
//
//   MUST-PASS    runBackup writes a sha256 sidecar that matches; BACKUP_SECOND_DIR gets a verified
//                copy; rotation takes the sidecar with the snapshot (both dirs); offbox-sync copies
//                snapshots + documents idempotently; the drill PASSes with the right key.
//   MUST-EXCLUDE a broken second destination never fails the primary snapshot; a corrupt source is
//                never propagated off-box; a flipped byte off-box FAILs the drill; the wrong key
//                FAILs the drill's login check; no output ever carries a customer name, a document
//                file name or a credential value.
//
// Run: npx tsx backend/test/offboxBackup.test.ts
import { REPO, ISOLATED_CWD } from "./_isolate";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const backupDir = path.join(ISOLATED_CWD, "backups");
const secondDir = path.join(ISOLATED_CWD, "offbox-cloud");
const syncDest = path.join(ISOLATED_CWD, "offbox-sync-dest");
process.env.BACKUP_DIR = backupDir;
process.env.BACKUP_SECOND_DIR = secondDir;
process.env.BACKUP_KEEP = "3";
process.env.BACKUP_INTERVAL_HOURS = "0";
process.env.PORTAL_PROFILES_DIR = path.join(ISOLATED_CWD, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
const KEY = "offbox-test-key-not-a-real-secret";
process.env.SESSION_ENCRYPTION_KEY = KEY;
// This test's own backend.log (the isolate disables it by default), to check what [backup] writes there.
const logFile = path.join(ISOLATED_CWD, "logs", "backend.log");
process.env.AUTOPILOT_LOG_FILE = logFile;

const { openDatabase } = await import("../src/db");
const { runBackup, startBackupScheduler } = await import("../src/backup");
const { createClient } = await import("../src/clients");
const { createPortalCredential } = await import("../src/portalCredentials");
const { saveProjectDocument } = await import("../src/projectDocuments");
const R = await import("../src/repository");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const sha = (f: string): string => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const snaps = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^autopilot-\d.*\.sqlite$/.test(f)).sort() : []);
const sidecars = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sqlite.sha256")).sort() : []);

// Customer-shaped data that must never appear in any output.
const OWNER = "Hollis Quintero";
const STREET = "4471 Larkspur Bend";
const DOC_NAME = "Quintero_Larkspur_meter_photo.txt";
const PASSWORD = "pw-Larkspur-9931";
const client = createClient(db, { companyName: "Offbox Test Solar", ccbLicenseNumber: "999999" });
createPortalCredential(db, (client as { id: string }).id, {
  portalType: "OR · Test", portalUrl: "https://offbox.example.invalid/portal/", username: "offbox-user", password: PASSWORD,
});
const projectId = R.createProject(db, {
  owner: OWNER, state: "OR", dcKw: "8.4", acKw: "7.7", permitPath: "prescriptive",
  street: STREET, city: "Coos Bay", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
} as never).project.id;
saveProjectDocument(db, projectId, { docType: "other", filename: DOC_NAME, buffer: Buffer.from(`meter photo notes for ${OWNER}\n`) });

const outputs: string[] = [];
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
function script(rel: string, argv: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync(process.execPath, [TSX, path.join(REPO, rel), ...argv], {
    cwd: ISOLATED_CWD, // no .env here
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 180_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  outputs.push(out);
  return { code: r.status ?? -1, out };
}

// ---------------------------------------------------------------------------
console.log("runBackup: sidecar + verified second copy");
const first = runBackup(db);
check("the snapshot has a .sha256 sidecar that matches its bytes", () => {
  const side = fs.readFileSync(`${first.file}.sha256`, "utf8");
  assert.match(side, new RegExp(`^${sha(first.file)}  ${path.basename(first.file).replace(/\./g, "\\.")}\\n$`));
  assert.equal(first.sha256, sha(first.file));
});
check("BACKUP_SECOND_DIR holds an identical copy with its own sidecar", () => {
  assert.ok(first.secondCopy, `secondCopy null; secondError=${first.secondError}`);
  assert.equal(first.secondError, null);
  const copy = path.join(secondDir, path.basename(first.file));
  assert.equal(sha(copy), first.sha256);
  assert.ok(fs.readFileSync(`${copy}.sha256`, "utf8").startsWith(first.sha256));
});
check("the watchdog status file records the success", () => {
  const st = JSON.parse(fs.readFileSync(path.join(backupDir, ".last-backup.json"), "utf8"));
  assert.equal(st.ok, true);
  assert.equal(st.second.ok, true);
  assert.equal(st.sha256, first.sha256);
});

console.log("rotation takes the sidecar with the snapshot");
for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 15)); runBackup(db); }
check("primary keeps 3 snapshots and exactly their 3 sidecars", () => {
  assert.equal(snaps(backupDir).length, 3);
  assert.deepEqual(sidecars(backupDir), snaps(backupDir).map((f) => `${f}.sha256`));
});
check("second dir keeps 3 snapshots and exactly their 3 sidecars", () => {
  assert.equal(snaps(secondDir).length, 3);
  assert.deepEqual(sidecars(secondDir), snaps(secondDir).map((f) => `${f}.sha256`));
});

// MUST-EXCLUDE: a broken second destination must not fail the primary.
fs.rmSync(secondDir, { recursive: true, force: true });
fs.writeFileSync(secondDir, "this is a file where a folder should be — the share is gone");
let broken: Awaited<ReturnType<typeof runBackup>> | null = null;
check("a broken second destination does not throw", () => { broken = runBackup(db); });
check("...the primary snapshot is still written and verified", () => {
  assert.ok(broken && fs.existsSync(broken.file));
  assert.equal(sha(broken!.file), broken!.sha256);
});
check("...and the failure is reported, not swallowed", () => {
  assert.equal(broken!.secondCopy, null);
  assert.ok(broken!.secondError && broken!.secondError.length > 0);
  const st = JSON.parse(fs.readFileSync(path.join(backupDir, ".last-backup.json"), "utf8"));
  assert.equal(st.ok, true, "the primary is fine");
  assert.equal(st.second.ok, false, "the off-box copy is not");
});
fs.rmSync(secondDir, { force: true });

// ---------------------------------------------------------------------------
console.log("offbox-sync: snapshots + documents, idempotent");
const s1 = script("scripts/ops/offbox-sync.ts", ["--from", backupDir, "--to", syncDest], { OFFBOX_SETTLE_SECONDS: "0" });
check("first sync exits 0 and copies 3 snapshots + the document", () => {
  assert.equal(s1.code, 0, s1.out);
  assert.match(s1.out, /snapshots copied\s+3/);
  assert.match(s1.out, /documents\s+1 mirrored off-box \(\+1 new\)/);
  assert.equal(snaps(syncDest).length, 3);
  for (const f of snaps(syncDest)) assert.equal(sha(path.join(syncDest, f)), sha(path.join(backupDir, f)));
});
const s2 = script("scripts/ops/offbox-sync.ts", ["--from", backupDir, "--to", syncDest], { OFFBOX_SETTLE_SECONDS: "0" });
check("a second sync copies nothing", () => {
  assert.equal(s2.code, 0, s2.out);
  assert.match(s2.out, /snapshots copied\s+0/);
  assert.match(s2.out, /snapshots already off-box\s+3/);
  assert.match(s2.out, /\(\+0 new\)/);
});
check("the sync writes its status for the watchdog", () => {
  const st = JSON.parse(fs.readFileSync(path.join(backupDir, ".offbox-status.json"), "utf8"));
  assert.equal(st.ok, true);
  assert.equal(st.newestOffbox, snaps(syncDest).at(-1));
});
check("a snapshot younger than the settle window is left for the next run", () => {
  const young = script("scripts/ops/offbox-sync.ts", ["--from", backupDir, "--to", path.join(ISOLATED_CWD, "young-dest")], { OFFBOX_SETTLE_SECONDS: "3600" });
  assert.match(young.out, /still being written\s+3/);
  assert.equal(snaps(path.join(ISOLATED_CWD, "young-dest")).length, 0);
});

// MUST-EXCLUDE: a source that no longer matches its sidecar is never copied as good.
const newestPrimary = path.join(backupDir, snaps(backupDir).at(-1)!);
const corruptDest = path.join(ISOLATED_CWD, "corrupt-dest");
const pristine = fs.readFileSync(newestPrimary);
const flipped = Buffer.from(pristine); flipped[flipped.length - 100] ^= 0xff;
fs.writeFileSync(newestPrimary, flipped);
const s3 = script("scripts/ops/offbox-sync.ts", ["--from", backupDir, "--to", corruptDest, "--no-documents"], { OFFBOX_SETTLE_SECONDS: "0" });
check("a corrupt source is reported and NOT copied off-box", () => {
  assert.equal(s3.code, 1, s3.out);
  assert.match(s3.out, /no longer matches its checksum .* NOT copied/);
  assert.ok(!fs.existsSync(path.join(corruptDest, path.basename(newestPrimary))), "the corrupt file reached the destination");
});
fs.writeFileSync(newestPrimary, pristine);

// ---------------------------------------------------------------------------
console.log("restore drill");
const good = script("scripts/ops/restore-drill.ts", ["--from", syncDest, "--no-dotenv"], { SESSION_ENCRYPTION_KEY: KEY });
check("the drill PASSes on a good off-box copy with the escrowed key from the shell", () => {
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /PASS\s+checksum/);
  assert.match(good.out, /PASS\s+integrity\s+PRAGMA integrity_check = ok/);
  assert.match(good.out, /PASS\s+documents\s+1 of 1 document files present/);
  assert.match(good.out, /PASS\s+logins\s+1 of 1 saved login\(s\) decrypt with the key from the shell environment/);
  assert.match(good.out, /PASS\s+boot/);
  assert.match(good.out, /RESTORE DRILL: PASS\n/);
});
const wrongKey = script("scripts/ops/restore-drill.ts", ["--from", syncDest, "--no-dotenv", "--no-boot-check"], { SESSION_ENCRYPTION_KEY: "not-the-escrowed-key" });
check("the wrong key FAILs the login check (the escrow failure, made visible)", () => {
  assert.equal(wrongKey.code, 1, wrongKey.out);
  assert.match(wrongKey.out, /FAIL\s+logins\s+0 of 1 saved login\(s\) decrypt/);
});
const noKey = script("scripts/ops/restore-drill.ts", ["--from", syncDest, "--no-dotenv", "--no-boot-check"], { SESSION_ENCRYPTION_KEY: "" });
check("no key at all is a WARNING, never a silent pass", () => {
  assert.equal(noKey.code, 3, noKey.out);
  assert.match(noKey.out, /WARN\s+logins\s+SESSION_ENCRYPTION_KEY is not set here/);
});
const newestOff = path.join(syncDest, snaps(syncDest).at(-1)!);
const offBytes = fs.readFileSync(newestOff);
const offFlipped = Buffer.from(offBytes); offFlipped[offFlipped.length - 100] ^= 0xff;
fs.writeFileSync(newestOff, offFlipped);
const damaged = script("scripts/ops/restore-drill.ts", ["--from", syncDest, "--no-dotenv", "--no-boot-check"], { SESSION_ENCRYPTION_KEY: KEY });
check("one flipped byte off-box FAILs the drill's checksum", () => {
  assert.equal(damaged.code, 1, damaged.out);
  assert.match(damaged.out, /FAIL\s+checksum\s+does NOT match its sidecar/);
});
fs.writeFileSync(newestOff, offBytes);
const noDocs = path.join(ISOLATED_CWD, "no-docs");
fs.mkdirSync(noDocs);
fs.copyFileSync(newestOff, path.join(noDocs, path.basename(newestOff)));
fs.copyFileSync(`${newestOff}.sha256`, path.join(noDocs, `${path.basename(newestOff)}.sha256`));
const docless = script("scripts/ops/restore-drill.ts", ["--from", noDocs, "--no-dotenv", "--no-boot-check"], { SESSION_ENCRYPTION_KEY: KEY });
check("a snapshot copied without its documents FAILs (a restore would 404 every upload)", () => {
  assert.equal(docless.code, 1, docless.out);
  assert.match(docless.out, /FAIL\s+documents\s+0 of 1/);
});

// ---------------------------------------------------------------------------
// F1 (D2 verification): --to <existing folder> used to overwrite <folder>/autopilot.sqlite with the
// snapshot and then rm the whole folder recursively — `--to backend/data` replaced the live DB and
// deleted the data folder; `--to E:\` would have wiped the backup drive.
console.log("restore drill: --to never touches what it did not create");
const occupied = path.join(ISOLATED_CWD, "occupied");
fs.mkdirSync(path.join(occupied, "sub"), { recursive: true });
{
  const Database = (await import("better-sqlite3")).default;
  const live = new Database(path.join(occupied, "autopilot.sqlite"));
  live.exec("CREATE TABLE LIVE_ONLY (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO LIVE_ONLY (note) VALUES ('this is the operator''s own database');");
  live.close();
}
fs.writeFileSync(path.join(occupied, "keep.txt"), "important\n");
fs.writeFileSync(path.join(occupied, "sub", "doc.pdf"), "%PDF-1.4 keep\n");
const occupiedBefore = new Map(["autopilot.sqlite", "keep.txt", path.join("sub", "doc.pdf")].map((f) => [f, sha(path.join(occupied, f))]));
const toOccupied = script("scripts/ops/restore-drill.ts", ["--from", syncDest, "--no-dotenv", "--to", occupied], { SESSION_ENCRYPTION_KEY: KEY });
check("MUST-EXCLUDE: --to <folder with an autopilot.sqlite and other files>: every pre-existing file survives byte-identical", () => {
  assert.ok(fs.existsSync(occupied), `${occupied} was deleted (exit ${toOccupied.code})\n${toOccupied.out}`);
  for (const [f, digest] of occupiedBefore) {
    assert.ok(fs.existsSync(path.join(occupied, f)), `${f} is gone (exit ${toOccupied.code})\n${toOccupied.out}`);
    assert.equal(sha(path.join(occupied, f)), digest, `${f} was rewritten (exit ${toOccupied.code})\n${toOccupied.out}`);
  }
});
check("...and the drill either refused (exit 2, nothing written) or ran in a fresh child folder it made and removed", () => {
  if (toOccupied.code === 2) {
    assert.deepEqual(fs.readdirSync(occupied).sort(), ["autopilot.sqlite", "keep.txt", "sub"]);
    return;
  }
  assert.ok(toOccupied.code === 0 || toOccupied.code === 3, toOccupied.out);
  assert.match(toOccupied.out, /scratch\s+.*occupied[\\/]restore-drill-/);
  assert.match(toOccupied.out, /PASS\s+boot/);
  assert.deepEqual(fs.readdirSync(occupied).sort(), ["autopilot.sqlite", "keep.txt", "sub"], "the child scratch folder was not removed");
});
const liveDataDir = path.dirname(process.env.AUTOPILOT_DB_PATH!);
const liveListing = fs.readdirSync(liveDataDir).sort();
const liveDbSha = sha(process.env.AUTOPILOT_DB_PATH!);
const toLive = script("scripts/ops/restore-drill.ts", ["--from", syncDest, "--no-dotenv", "--no-boot-check", "--to", liveDataDir], { SESSION_ENCRYPTION_KEY: KEY });
check("MUST-EXCLUDE: --to <the live database's folder> is refused before anything is written (exit 2)", () => {
  assert.equal(toLive.code, 2, toLive.out);
  assert.match(toLive.out, /refused: --to .* is, contains, or is inside the live database's folder/);
  assert.ok(!/checksum/.test(toLive.out), "a check ran");
  assert.deepEqual(fs.readdirSync(liveDataDir).sort(), liveListing);
  assert.equal(sha(process.env.AUTOPILOT_DB_PATH!), liveDbSha, "the live database was rewritten");
});
const toAbove = script("scripts/ops/restore-drill.ts", ["--from", syncDest, "--no-dotenv", "--no-boot-check", "--to", path.dirname(liveDataDir)], { SESSION_ENCRYPTION_KEY: KEY });
check("MUST-EXCLUDE: --to <a folder that CONTAINS the live folder> is refused too", () => {
  assert.equal(toAbove.code, 2, toAbove.out);
  assert.match(toAbove.out, /refused/);
});
const toBackups = script("scripts/ops/restore-drill.ts", ["--from", syncDest, "--no-dotenv", "--no-boot-check", "--to", path.join(backupDir, "drill")], { SESSION_ENCRYPTION_KEY: KEY });
check("MUST-EXCLUDE: --to <inside BACKUP_DIR> is refused (the backups are not a scratch area)", () => {
  assert.equal(toBackups.code, 2, toBackups.out);
  assert.ok(!fs.existsSync(path.join(backupDir, "drill")));
});
const toSource = script("scripts/ops/restore-drill.ts", ["--from", syncDest, "--no-dotenv", "--no-boot-check", "--to", syncDest], { SESSION_ENCRYPTION_KEY: KEY });
check("MUST-EXCLUDE: --to <the backup folder being read> is refused", () => {
  assert.equal(toSource.code, 2, toSource.out);
  assert.equal(snaps(syncDest).length, 3);
});
const fresh = path.join(ISOLATED_CWD, "drill-new", "scratch");
const toFresh = script("scripts/ops/restore-drill.ts", ["--from", syncDest, "--no-dotenv", "--to", fresh], { SESSION_ENCRYPTION_KEY: KEY });
check("MUST-PASS: --to <new folder> runs all six checks and PASSes, and the folder it made is gone afterwards", () => {
  assert.equal(toFresh.code, 0, toFresh.out);
  for (const c of ["checksum", "integrity", "contents", "documents", "logins", "boot"]) assert.match(toFresh.out, new RegExp(`PASS\\s+${c}`));
  assert.ok(!fs.existsSync(fresh), `${fresh} still exists: ${fs.existsSync(fresh) ? fs.readdirSync(fresh).join(",") : ""}`);
});
const kept = path.join(ISOLATED_CWD, "drill-kept");
const toKept = script("scripts/ops/restore-drill.ts", ["--from", syncDest, "--no-dotenv", "--no-boot-check", "--to", kept, "--keep-scratch"], { SESSION_ENCRYPTION_KEY: KEY });
check("MUST-PASS: --to <new folder> --keep-scratch leaves the restored copy in a child the drill made", () => {
  assert.equal(toKept.code, 0, toKept.out);
  const children = fs.readdirSync(kept).filter((f) => f.startsWith("restore-drill-"));
  assert.equal(children.length, 1, fs.readdirSync(kept).join(","));
  assert.ok(fs.existsSync(path.join(kept, children[0], "autopilot.sqlite")));
});

// ---------------------------------------------------------------------------
console.log("the scheduler's log lines");
const logText = (): string => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "");
check("a normal scheduled snapshot reaches backend.log (it used to be console-only)", () => {
  startBackupScheduler(db); // interval 0: one snapshot now, no timer
  assert.match(logText(), /\[backup\] snapshot written/);
});
// MUST-EXCLUDE: a process pointed at ANOTHER database's backup directory (a test or smoke server
// that inherited the live .env) must not log "snapshot failed" nor write a failure status there.
const statusBefore = fs.readFileSync(path.join(backupDir, ".last-backup.json"), "utf8");
fs.writeFileSync(path.join(backupDir, ".backup-source.json"), JSON.stringify({ source: path.join(ISOLATED_CWD, "some-other.sqlite") }));
const failedBefore = (logText().match(/snapshot failed/g) ?? []).length;
startBackupScheduler(db);
check("MUST-EXCLUDE: a directory-conflict refusal is logged as a refusal, never as 'snapshot failed'", () => {
  assert.equal((logText().match(/snapshot failed/g) ?? []).length, failedBefore, "a conflict was logged as a backup failure");
  assert.match(logText(), /refused: this backup directory belongs to another database/);
});
check("MUST-EXCLUDE: ...and leaves the owner's status file untouched (the watchdog would page)", () => {
  assert.equal(fs.readFileSync(path.join(backupDir, ".last-backup.json"), "utf8"), statusBefore);
});

check("no output carries a customer name, street, document name or password", () => {
  const all = outputs.join("\n");
  for (const secret of [OWNER, "Quintero", STREET, "Larkspur", DOC_NAME, PASSWORD]) {
    assert.ok(!all.includes(secret), `output contains "${secret}"`);
  }
});

db.close();
if (failures) { console.error(`\n${failures} off-box backup check(s) FAILED.`); process.exit(1); }
console.log("\nAll off-box backup checks passed.");
