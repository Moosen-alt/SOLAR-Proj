import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import { DOCS_DIR } from "./projectDocuments";
import { logger } from "./logger";
import {
  BACKUP_STATUS_NAME, copyVerified, pruneAutomaticSnapshots, sidecarPath, writeChecksumSidecar, writeStatusFile,
} from "./offboxBackup";

// Where snapshots go, and how many to keep. Both overridable via env.
const BACKUP_DIR = path.resolve(process.cwd(), process.env.BACKUP_DIR || "backend/data/backups");
const KEEP = Number(process.env.BACKUP_KEEP || 14);
const INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS || 24);

// OFF-BOX COPY (optional, OFF unless set). BACKUP_DIR is still where every snapshot is written
// first — this adds a SECOND destination (a synced cloud folder or a network share) and changes
// nothing about the first. Only the snapshot + its checksum are copied from inside the server; the
// document mirror goes off-box through scripts/ops/offbox-sync.ts, so a slow share can never stall
// the event loop for a 2 GB tree. A failure here NEVER fails the primary backup.
const SECOND_DIR = process.env.BACKUP_SECOND_DIR ? path.resolve(process.cwd(), process.env.BACKUP_SECOND_DIR) : "";
const SECOND_KEEP = Number(process.env.BACKUP_SECOND_KEEP || KEEP);
const STATUS_FILE = path.join(BACKUP_DIR, BACKUP_STATUS_NAME);

// Uploaded plan sets, stamped letters, meter photos and split sheets are files on
// disk; only their metadata lives in SQLite. Backing up the database alone produces
// a restore that LOOKS complete — every project, every document row — and 404s on
// every actual file. So each snapshot also mirrors the document tree.
//
// The mirror is append-only and deliberately NOT pruned alongside the rotating .sqlite
// snapshots: a 14-day-old snapshot restored tomorrow still needs the files it referenced,
// and stored names (`<docId>-<safe name>`) are unique and never rewritten in place, so
// keeping everything costs one copy per file, ever. Deleting a document removes it from
// the live tree but leaves the mirrored copy — which is what you want from a backup.
const DOCS_MIRROR = path.join(BACKUP_DIR, "documents");

// PORTAL LOGIN SESSIONS. `portal-profiles/` holds a Chrome profile per (client, portal) —
// cookies and localStorage — and those directories ARE the live portal logins. They are not
// in the database and no key protects them, so a restore that covered only the DB and the
// documents came back with every portal session gone: the same failure mode the document
// mirror above exists to prevent, one layer down.
//
// Only session state is mirrored (Cookies, Local/Session Storage, Login Data, Preferences).
// A Chrome profile is mostly cache — hundreds of MB of it — and copying that would make
// every backup enormous while restoring nothing of value.
const PROFILES_DIR = path.resolve(process.cwd(), process.env.PORTAL_PROFILES_DIR || "portal-profiles");
const PROFILES_MIRROR = path.join(BACKUP_DIR, "portal-profiles");
const SESSION_FILE_RE = /(^|[\\/])(Cookies|Cookies-journal|Login Data|Login Data-journal|Web Data|Preferences|Local State|Secure Preferences)$|[\\/](Local Storage|Session Storage|IndexedDB)[\\/]/i;

/** One snapshot file on disk. */
export interface BackupInfo {
  file: string;
  sizeBytes: number;
  createdAt: string;
}

/** The outcome of one backup RUN — the snapshot plus the state of the document mirror. */
export interface BackupRunInfo extends BackupInfo {
  /** Document files copied into the mirror by THIS run (new since the last one). */
  documentsCopied: number;
  /** Total document files now held in the mirror. */
  documentsMirrored: number;
  /** Document rows whose file is already gone from the live tree — data loss, if > 0. */
  documentsMissingOnDisk: number;
  /** Portal session files refreshed into the mirror by THIS run. */
  portalSessionFilesCopied: number;
  /** Portal session files now held in the mirror — 0 means NO portal logins are backed up. */
  portalSessionFilesMirrored: number;
  /** SHA-256 of the snapshot, also written beside it as `<file>.sha256`. */
  sha256: string;
  /** Where the verified off-box copy landed, or null when BACKUP_SECOND_DIR is unset or the copy failed. */
  secondCopy: string | null;
  /** Why the off-box copy failed (the primary snapshot is still good), or null. */
  secondError: string | null;
}

/**
 * ONE BACKUP DIRECTORY BACKS UP ONE DATABASE.
 *
 * The directory has no way, on its own, to say which database its snapshots are OF — every file
 * is `autopilot-<stamp>.sqlite` whatever wrote it. So eight tests in the backend chain, which
 * boot the real server and never override `BACKUP_DIR`, inherited the operator's `.env` and each
 * filed a 1 MB snapshot of its own throwaway scratch database onto the real backup drive, in
 * among the 30 MB real ones. With rotation running, junk written by a test suite is enough to
 * retire a real restore point — the same loss as the interval bug, by a different door.
 *
 * This marker closes the door for good, and generically: it names the source database, and any
 * OTHER database that points at this directory is refused rather than quietly mixed in. It also
 * catches the real-world version nobody has hit yet — two app instances sharing one backup
 * directory, each rotating away the other's history.
 *
 * Reconfiguring on purpose (moving the live database, pointing at a new drive) means deleting
 * this file deliberately. The refusal message says so and names both paths, because a guard that
 * refuses without saying what to do is just an outage.
 */
const SOURCE_MARKER = path.join(BACKUP_DIR, ".backup-source.json");

/** Windows gives back `C:\x` and `c:/x` for the same file; compare them as the same file. */
function sameFile(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Claim this backup directory for `sourcePath`, or report who already holds it.
 * Returns the conflicting source when the directory belongs to a DIFFERENT database.
 */
export function claimBackupDirectory(sourcePath: string, dir = BACKUP_DIR, marker = SOURCE_MARKER): string | null {
  let held: string | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(marker, "utf8")) as { source?: unknown };
    if (typeof raw.source === "string" && raw.source.trim()) held = raw.source;
  } catch {
    // No marker, or an unreadable one. An unreadable marker is treated as absent and
    // rewritten — refusing every backup over a corrupt one-line file would be worse than
    // the problem it guards.
  }
  if (held && !sameFile(held, sourcePath)) return held;
  if (!held) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(marker, `${JSON.stringify({ source: path.resolve(sourcePath), claimedAt: new Date().toISOString() }, null, 2)}\n`);
    } catch {
      // Cannot write the marker (read-only mount, permissions). Do not fail the backup over
      // bookkeeping — the snapshot itself is the thing that matters.
    }
  }
  return null;
}

/** The directory belongs to a DIFFERENT database. Distinct so the scheduler can refuse without
 *  writing a failure status into a directory it does not own — a stray test server pointed at the
 *  operator's backup drive must not page the operator about the operator's (healthy) backups. */
export class BackupDirectoryConflictError extends Error {}

// Write one snapshot now. Returns the created file path.
export function runBackup(db: AppDb): BackupRunInfo {
  const conflict = claimBackupDirectory(db.sourcePath);
  if (conflict) {
    throw new BackupDirectoryConflictError(
      `[backup] REFUSED: ${BACKUP_DIR} holds snapshots of ${conflict}, not ${db.sourcePath}. ` +
        `One backup directory backs up one database — mixing them lets rotation retire real restore ` +
        `points to make room for another database's. Point BACKUP_DIR somewhere else for this process, ` +
        `or if you have deliberately moved the database, delete ${SOURCE_MARKER} and run again.`,
    );
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `autopilot-${stamp}.sqlite`);
  db.backupTo(file);
  // The checksum is taken NOW, while the bytes are the ones VACUUM INTO just wrote — every later
  // copy (and the restore drill) is compared against this, so bit rot on E: is detectable too.
  const sha256 = writeChecksumSidecar(file);
  pruneOldBackups();
  const docs = mirrorDocuments();
  const profiles = mirrorPortalProfiles();
  const stat = fs.statSync(file);
  let secondCopy: string | null = null;
  let secondError: string | null = null;
  if (SECOND_DIR) {
    try {
      secondCopy = copyVerified(file, SECOND_DIR, sha256).dest;
      pruneAutomaticSnapshots(SECOND_DIR, SECOND_KEEP);
    } catch (err) {
      secondError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    }
  }
  const info: BackupRunInfo = {
    file,
    sizeBytes: stat.size,
    createdAt: new Date().toISOString(),
    documentsCopied: docs.copied,
    documentsMirrored: docs.total,
    documentsMissingOnDisk: countMissingDocumentFiles(db),
    portalSessionFilesCopied: profiles.copied,
    portalSessionFilesMirrored: profiles.total,
    sha256,
    secondCopy,
    secondError,
  };
  writeStatusFile(STATUS_FILE, {
    ok: true, at: info.createdAt, file: path.basename(file), sizeBytes: info.sizeBytes, sha256,
    second: SECOND_DIR ? { ok: !secondError, error: secondError } : null,
    documentsMissingOnDisk: info.documentsMissingOnDisk,
  });
  return info;
}

export function listBackups(): BackupInfo[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("autopilot-") && f.endsWith(".sqlite"))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * A SNAPSHOT SOMEBODY NAMED ON PURPOSE IS NOT ROTATION FODDER.
 *
 * `runBackup` is the only thing that ever writes into the automatic series, and it always names
 * the file `autopilot-<ISO stamp>.sqlite` — so an automatic snapshot ALWAYS has a digit (the
 * year) right after the prefix. Anything else under that prefix was named by a human or a
 * migration: `autopilot-manual-…`, `autopilot-pre-connie`, `autopilot-BEFORE-round2`. Those are
 * restore points pinned ahead of something risky, and the entire point of pinning one is that a
 * later routine snapshot cannot quietly retire it — which is exactly what rotation did.
 */
export function isAutomaticSnapshot(fileName: string): boolean {
  return /^autopilot-\d/.test(fileName);
}

// Keep only the newest KEEP AUTOMATIC snapshots. Only ever touches autopilot-<stamp>.sqlite
// files, so the documents/ mirror alongside them — and any pinned restore point — is untouched.
function pruneOldBackups(): void {
  const files = listBackups().filter((f) => isAutomaticSnapshot(f.file));
  for (const old of files.slice(KEEP)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, old.file));
    } catch {
      /* best effort */
    }
    try {
      fs.unlinkSync(sidecarPath(path.join(BACKUP_DIR, old.file)));
    } catch {
      /* a snapshot from before sidecars existed has none */
    }
  }
}

// Mirror portal session state. Unlike documents this is NOT append-only — a session file
// changes in place every time a login refreshes — so a changed file is re-copied (size or
// mtime differing), and the newest copy wins.
function mirrorPortalProfiles(): { copied: number; total: number } {
  if (!fs.existsSync(PROFILES_DIR)) return { copied: 0, total: 0 };
  let copied = 0;
  let total = 0;
  for (const rel of walkFiles(PROFILES_DIR)) {
    if (!SESSION_FILE_RE.test(rel)) continue;
    total++;
    const src = path.join(PROFILES_DIR, rel);
    const dest = path.join(PROFILES_MIRROR, rel);
    try {
      const srcStat = fs.statSync(src);
      const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
      if (destStat && destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.partial`;
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dest);
      copied++;
    } catch {
      // A profile in use by a live run can refuse a copy (locked SQLite files); the next
      // backup catches it. Never fail a backup over one session file.
    }
  }
  return { copied, total };
}

// Copy any document file not already mirrored (matched on relative path + byte size).
// Copies to a temp name and renames, so an interrupted run can never leave a truncated
// file that a later run would mistake for a complete one.
function mirrorDocuments(): { copied: number; total: number } {
  if (!fs.existsSync(DOCS_DIR)) return { copied: 0, total: 0 };
  let copied = 0;
  let total = 0;
  for (const rel of walkFiles(DOCS_DIR)) {
    total++;
    const src = path.join(DOCS_DIR, rel);
    const dest = path.join(DOCS_MIRROR, rel);
    try {
      const srcStat = fs.statSync(src);
      const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
      if (destStat && destStat.size === srcStat.size) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.partial`;
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dest);
      copied++;
    } catch (err) {
      console.error(`[backup] could not mirror ${rel}:`, err instanceof Error ? err.message : String(err));
    }
  }
  return { copied, total };
}

// Relative paths of every file under root (documents are one directory per project).
function walkFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(root, rel));
    else if (entry.isFile() && !entry.name.endsWith(".partial")) out.push(rel);
  }
  return out;
}

// Document rows pointing at a file that is no longer on disk. Non-zero means the
// live tree has already lost data, which is worth shouting about at backup time —
// it is the only routine moment anything checks.
function countMissingDocumentFiles(db: AppDb): number {
  let missing = 0;
  try {
    for (const row of db.query<{ stored_path: unknown }>("SELECT stored_path FROM project_documents")) {
      const p = typeof row.stored_path === "string" ? row.stored_path : "";
      if (!p || !fs.existsSync(p)) missing++;
    }
  } catch {
    return 0;
  }
  return missing;
}

/**
 * How long between automatic snapshots — or `null`, meaning THE SCHEDULE IS OFF.
 *
 * A NON-POSITIVE INTERVAL DISABLES THE SCHEDULE. It does not mean "as fast as possible".
 * `Number(process.env.BACKUP_INTERVAL_HOURS || 24)` lets "0" through, because "0" is a TRUTHY
 * STRING and survives the `||`; that used to reach `setInterval(tick, 0)` and take a snapshot
 * roughly every two seconds. With BACKUP_KEEP at 14, rotation then rolled every real restore
 * point off the disk inside a minute — measured, on the operator's backup drive, while someone
 * was only trying to turn backups OFF for a test server.
 *
 * Every other scheduler here already reads <= 0 as "off" (MONITOR_INTERVAL_MINUTES in
 * scheduler.ts, AHJ_FORM_REFRESH_DAYS, KB_LINK_CHECK_DAYS, CEC_SYNC_DAYS). This was the one
 * that read it as "continuously", and it owned the data every other one depends on.
 */
export function backupIntervalMs(hours: number): number | null {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return hours * 60 * 60 * 1000;
}

// Run one at startup, then on a fixed interval. The startup snapshot runs even when the
// schedule is off, so an operator who disables backups still keeps the state they disabled at.
export function startBackupScheduler(db: AppDb): void {
  const tick = () => {
    try {
      const info = runBackup(db);
      console.log(
        `[backup] snapshot written: ${info.file} (${Math.round(info.sizeBytes / 1024)} KB); ` +
          `documents mirrored: ${info.documentsMirrored} (+${info.documentsCopied} new)`,
      );
      // ALSO to backend.log. These lines used to reach only the console window, so a power cut or
      // a closed window erased the only record of whether last night's backup ran (ops audit §5).
      logger.info("backup", `snapshot written (${Math.round(info.sizeBytes / 1024)} KB)`, {
        file: path.basename(info.file), sha256: info.sha256.slice(0, 16), documentsMirrored: info.documentsMirrored,
        secondCopy: info.secondCopy ? "ok" : SECOND_DIR ? "FAILED" : "off",
      });
      if (info.secondError) {
        console.error(`[backup] off-box copy to ${SECOND_DIR} FAILED (primary snapshot is fine): ${info.secondError}`);
        logger.error("backup", "off-box copy failed (primary snapshot is fine)", { error: info.secondError });
      }
      if (info.documentsMissingOnDisk > 0) {
        console.error(
          `[backup] WARNING: ${info.documentsMissingOnDisk} document row(s) point at files missing from ${DOCS_DIR}. ` +
            `Those uploads are gone from the live tree; check ${DOCS_MIRROR} for mirrored copies.`,
        );
        logger.warn("backup", `${info.documentsMissingOnDisk} document row(s) point at files missing from the live tree`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[backup] snapshot failed:", message);
      logger.error("backup", "snapshot failed", { error: message.slice(0, 300) });
      // The watchdog reads this: a failed snapshot is an alert, not a console line nobody sees.
      // Except when the directory is not ours to write in (see BackupDirectoryConflictError).
      if (!(err instanceof BackupDirectoryConflictError)) {
        writeStatusFile(STATUS_FILE, { ok: false, at: new Date().toISOString(), error: message.slice(0, 300) });
      }
    }
  };
  tick();
  const everyMs = backupIntervalMs(INTERVAL_HOURS);
  if (everyMs === null) {
    console.log("[backup] scheduler disabled (BACKUP_INTERVAL_HOURS <= 0); the snapshot above still ran.");
    return;
  }
  setInterval(tick, everyMs).unref();
}
