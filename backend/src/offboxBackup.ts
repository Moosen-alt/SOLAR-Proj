// OFF-BOX BACKUP PRIMITIVES — checksums, verified copies, rotation, an incremental tree mirror.
//
// WHY THIS EXISTS. Every snapshot and every mirrored document lived on E:, an internal disk in the
// SAME desktop as the live database (DAY1-OF-100 blocker 9). A fire, a theft, or the power surge
// that already hard-killed this box five times in twelve days takes both copies at once. A second
// destination — a synced cloud folder (OneDrive / Google Drive / Dropbox) or a network share — is
// the fix, and a copy nobody can prove is intact is not a backup, so every snapshot carries a
// SHA-256 sidecar (`<file>.sha256`, the `sha256sum` format: "<hex>  <name>") written right after it
// is taken and checked again after every copy.
//
// Used by two callers, one implementation:
//   * backup.ts (the server's own scheduler) — writes the sidecar at snapshot time and, when
//     BACKUP_SECOND_DIR is set, copies the snapshot there. Documents are NOT copied from inside the
//     server: a slow network share must never stall the event loop.
//   * scripts/ops/offbox-sync.ts — a separate process (scheduled task) that catches up snapshots
//     AND mirrors the document tree. It also works against a server build that predates this file.
//
// NEVER LOGS FILE NAMES FROM THE DOCUMENT TREE. Stored document names embed the uploaded file name,
// which routinely carries a homeowner's name or street. Callers report counts and error CODES only.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The automatic snapshot series (what backup.ts writes and rotates). Named restore points
 *  (`autopilot-manual-…`, `autopilot-pre-…`) never match, exactly as in backup.ts. */
export const AUTOMATIC_SNAPSHOT_RE = /^autopilot-\d.*\.sqlite$/;

export const SIDECAR_EXT = ".sha256";

/** Status files the watchdog reads, both kept in the PRIMARY backup directory:
 *  written by the server after every snapshot attempt, and by offbox-sync after every run. */
export const BACKUP_STATUS_NAME = ".last-backup.json";
export const OFFBOX_STATUS_NAME = ".offbox-status.json";

/** SHA-256 of a file, streamed in 1 MB chunks so a 30 MB snapshot or a 100 MB plan set never has
 *  to sit in memory whole. Synchronous on purpose: callers run it in a script or right after a
 *  synchronous VACUUM INTO. */
export function sha256File(file: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function sidecarPath(file: string): string {
  return `${file}${SIDECAR_EXT}`;
}

/** Write `<file>.sha256` ("<hex>  <basename>\n", checkable with `sha256sum -c`). Returns the hex. */
export function writeChecksumSidecar(file: string, hex = sha256File(file)): string {
  fs.writeFileSync(sidecarPath(file), `${hex}  ${path.basename(file)}\n`);
  return hex;
}

/** The hex recorded in `<file>.sha256`, or null when there is no readable sidecar. */
export function readChecksumSidecar(file: string): string | null {
  try {
    const m = fs.readFileSync(sidecarPath(file), "utf8").trim().match(/^([0-9a-f]{64})\b/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export type ChecksumVerdict =
  | { state: "ok"; sha256: string }
  | { state: "mismatch"; expected: string; actual: string }
  | { state: "no-sidecar"; sha256: string };

/** Re-hash `file` and compare it with its sidecar. "no-sidecar" is NOT "ok": a snapshot written
 *  by a server build older than the sidecar cannot be proven intact, and callers must say so. */
export function verifyChecksum(file: string): ChecksumVerdict {
  const actual = sha256File(file);
  const expected = readChecksumSidecar(file);
  if (!expected) return { state: "no-sidecar", sha256: actual };
  return expected === actual ? { state: "ok", sha256: actual } : { state: "mismatch", expected, actual };
}

/**
 * Copy `src` into `destDir` and PROVE the copy: write to `<name>.partial`, hash the partial, refuse
 * (and delete it) unless it matches `expectedSha256`, then rename into place and write the sidecar.
 * A half-written file therefore never carries a real name, and a copy that a flaky share or a
 * sync client mangled never carries a sidecar claiming it is good.
 */
export function copyVerified(src: string, destDir: string, expectedSha256: string): { dest: string; sha256: string } {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  const partial = `${dest}.partial`;
  fs.copyFileSync(src, partial);
  const got = sha256File(partial);
  if (got !== expectedSha256) {
    try { fs.unlinkSync(partial); } catch { /* best effort */ }
    throw new Error(`copy of ${path.basename(src)} did not verify (expected ${expectedSha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
  }
  fs.renameSync(partial, dest);
  writeChecksumSidecar(dest, got);
  return { dest, sha256: got };
}

/** Automatic snapshots in `dir`, newest first (by the ISO stamp in the name, which sorts). */
export function listAutomaticSnapshots(dir: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((f) => AUTOMATIC_SNAPSHOT_RE.test(f)).sort().reverse();
}

/** Keep the newest `keep` automatic snapshots in `dir`; delete older ones AND their sidecars.
 *  Named restore points are never touched. Returns how many snapshots were removed. */
export function pruneAutomaticSnapshots(dir: string, keep: number): number {
  if (!Number.isFinite(keep) || keep < 1) return 0; // never "prune everything" on a bad setting
  let removed = 0;
  for (const name of listAutomaticSnapshots(dir).slice(keep)) {
    try { fs.unlinkSync(path.join(dir, name)); removed++; } catch { /* best effort */ }
    try { fs.unlinkSync(sidecarPath(path.join(dir, name))); } catch { /* may not exist */ }
  }
  return removed;
}

/** Incremental one-way mirror of a file tree (new or size-changed files only; nothing deleted —
 *  the source is itself an append-only backup mirror). Errors are counted by CODE, never by
 *  name, because document names carry customer names. */
export function mirrorTree(srcRoot: string, destRoot: string): { copied: number; total: number; errors: number; errorCodes: string[] } {
  const out = { copied: 0, total: 0, errors: 0, errorCodes: [] as string[] };
  if (!fs.existsSync(srcRoot)) return out;
  const walk = (rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(srcRoot, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { walk(r); continue; }
      if (!e.isFile() || e.name.endsWith(".partial")) continue;
      out.total++;
      const src = path.join(srcRoot, r);
      const dest = path.join(destRoot, r);
      try {
        const s = fs.statSync(src);
        const d = fs.existsSync(dest) ? fs.statSync(dest) : null;
        if (d && d.size === s.size) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, `${dest}.partial`);
        fs.renameSync(`${dest}.partial`, dest);
        out.copied++;
      } catch (err) {
        out.errors++;
        const code = (err as NodeJS.ErrnoException)?.code || "ERROR";
        if (!out.errorCodes.includes(code)) out.errorCodes.push(code);
      }
    }
  };
  walk("");
  return out;
}

/** Write a small JSON status file atomically (tmp + rename) — read by scripts/ops/watchdog.ts.
 *  Never throws: bookkeeping must not fail a backup. */
export function writeStatusFile(file: string, status: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(status, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    /* best effort */
  }
}
