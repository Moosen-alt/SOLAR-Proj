import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";

// Where snapshots go, and how many to keep. Both overridable via env.
const BACKUP_DIR = path.resolve(process.cwd(), process.env.BACKUP_DIR || "backend/data/backups");
const KEEP = Number(process.env.BACKUP_KEEP || 14);
const INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS || 24);

export interface BackupInfo {
  file: string;
  sizeBytes: number;
  createdAt: string;
}

// Write one snapshot now. Returns the created file path.
export function runBackup(db: AppDb): BackupInfo {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `autopilot-${stamp}.sqlite`);
  db.backupTo(file);
  pruneOldBackups();
  const stat = fs.statSync(file);
  return { file, sizeBytes: stat.size, createdAt: new Date().toISOString() };
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

// Keep only the newest KEEP snapshots.
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

// Run one at startup, then on a fixed interval.
export function startBackupScheduler(db: AppDb): void {
  const tick = () => {
    try {
      const info = runBackup(db);
      console.log(`[backup] snapshot written: ${info.file} (${Math.round(info.sizeBytes / 1024)} KB)`);
    } catch (err) {
      console.error("[backup] snapshot failed:", err instanceof Error ? err.message : String(err));
    }
  };
  tick();
  setInterval(tick, INTERVAL_HOURS * 60 * 60 * 1000).unref();
}
