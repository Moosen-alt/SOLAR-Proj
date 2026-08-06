import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import { DOCS_DIR } from "./projectDocuments";

// Where snapshots go, and how many to keep. Both overridable via env.
const BACKUP_DIR = path.resolve(process.cwd(), process.env.BACKUP_DIR || "backend/data/backups");
const KEEP = Number(process.env.BACKUP_KEEP || 14);
const INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS || 24);

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
}

// Write one snapshot now. Returns the created file path.
export function runBackup(db: AppDb): BackupRunInfo {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `autopilot-${stamp}.sqlite`);
  db.backupTo(file);
  pruneOldBackups();
  const docs = mirrorDocuments();
  const stat = fs.statSync(file);
  return {
    file,
    sizeBytes: stat.size,
    createdAt: new Date().toISOString(),
    documentsCopied: docs.copied,
    documentsMirrored: docs.total,
    documentsMissingOnDisk: countMissingDocumentFiles(db),
  };
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

// Keep only the newest KEEP snapshots. Only ever touches autopilot-*.sqlite files,
// so the documents/ mirror alongside them is untouched by rotation.
function pruneOldBackups(): void {
  const files = listBackups();
  for (const old of files.slice(KEEP)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, old.file));
    } catch {
      /* best effort */
    }
  }
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

// Run one at startup, then on a fixed interval.
export function startBackupScheduler(db: AppDb): void {
  const tick = () => {
    try {
      const info = runBackup(db);
      console.log(
        `[backup] snapshot written: ${info.file} (${Math.round(info.sizeBytes / 1024)} KB); ` +
          `documents mirrored: ${info.documentsMirrored} (+${info.documentsCopied} new)`,
      );
      if (info.documentsMissingOnDisk > 0) {
        console.error(
          `[backup] WARNING: ${info.documentsMissingOnDisk} document row(s) point at files missing from ${DOCS_DIR}. ` +
            `Those uploads are gone from the live tree; check ${DOCS_MIRROR} for mirrored copies.`,
        );
      }
    } catch (err) {
      console.error("[backup] snapshot failed:", err instanceof Error ? err.message : String(err));
    }
  };
  tick();
  setInterval(tick, INTERVAL_HOURS * 60 * 60 * 1000).unref();
}
