// OFF-BOX SYNC — copy the backup set to a SECOND place, prove every copy, and say so.
//
//   npx tsx scripts/ops/offbox-sync.ts --to "D:\OneDrive\SolarBackups"             # one run
//   npx tsx scripts/ops/offbox-sync.ts --to "\\nas\backups\solar" --dry-run        # what would copy
//   npx tsx scripts/ops/offbox-sync.ts                                             # uses BACKUP_SECOND_DIR
//
// WHAT IT COPIES (from BACKUP_DIR — the same directory the server writes to; nothing about that
// directory changes):
//   1. every AUTOMATIC snapshot (autopilot-<stamp>.sqlite) not already off-box, each with a
//      SHA-256 sidecar; the copy is hashed again and refused unless it matches;
//   2. the document mirror (BACKUP_DIR/documents), incrementally — without it a restored
//      database 404s on every plan set, letter and photo;
//   3. then rotates the off-box snapshots to BACKUP_SECOND_KEEP (default BACKUP_KEEP, else 14).
// It does NOT copy portal-profiles/: those Chrome sessions are bound to this Windows user on this
// machine (DPAPI) and are useless anywhere else. After a restore on another box, portals are
// logged into again; the SAVED PASSWORDS survive only if SESSION_ENCRYPTION_KEY was escrowed.
//
// A CORRUPT SOURCE IS NEVER PROPAGATED. When a snapshot in BACKUP_DIR has a sidecar (written by
// the server at snapshot time) and no longer matches it, that snapshot is reported and skipped —
// copying it would put a bad file off-box next to a sidecar calling it good.
//
// Runs as a separate process on purpose (a scheduled task: scripts/ops/install-offbox-sync.ps1),
// so a slow share never stalls the server, and so it works against a server build that predates
// the sidecar (those are hashed here at copy time, and reported as such).
//
// PRIVACY: prints counts, snapshot stamps and error CODES only — never a document file name
// (stored names embed the uploaded file name, which routinely carries a homeowner's name).
//
// Writes BACKUP_DIR/.offbox-status.json for scripts/ops/watchdog.ts.
// EXIT: 0 all good, 1 something failed (see the report), 2 bad configuration.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  AUTOMATIC_SNAPSHOT_RE, OFFBOX_STATUS_NAME, copyVerified, listAutomaticSnapshots, mirrorTree,
  pruneAutomaticSnapshots, readChecksumSidecar, sha256File, verifyChecksum,
  writeStatusFile,
} from "../../backend/src/offboxBackup";

const args = process.argv.slice(2);
const flag = (name: string): string => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3).trim();
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1].trim() : "";
};
const dryRun = args.includes("--dry-run");
const withDocuments = !args.includes("--no-documents");

// Same default and same resolution as backend/src/backup.ts, so "BACKUP_DIR" means one place.
const fromDir = path.resolve(process.cwd(), flag("from") || process.env.BACKUP_DIR || "backend/data/backups");
const toRaw = flag("to") || process.env.BACKUP_SECOND_DIR || "";
const keep = Number(flag("keep") || process.env.BACKUP_SECOND_KEEP || process.env.BACKUP_KEEP || 14);

const line = (s = ""): void => console.log(s);
if (!toRaw) {
  line("offbox-sync: no destination. Pass --to <folder> or set BACKUP_SECOND_DIR (a synced cloud folder or a network share).");
  process.exit(2);
}
const toDir = path.resolve(process.cwd(), toRaw);
const same = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
if (same(fromDir, toDir) || toDir.toLowerCase().startsWith(`${fromDir.toLowerCase()}${path.sep}`)) {
  line(`offbox-sync: the destination ${toDir} is the backup directory itself (or inside it). That is not off-box.`);
  process.exit(2);
}
if (!fs.existsSync(fromDir)) {
  line(`offbox-sync: backup directory ${fromDir} does not exist — nothing has ever been backed up here.`);
  process.exit(1);
}
if (!Number.isFinite(keep) || keep < 1) {
  line(`offbox-sync: keep must be a positive number (got ${keep}).`);
  process.exit(2);
}

line(`offbox-sync  ${dryRun ? "DRY RUN" : "RUN"}   ${new Date().toISOString()}`);
line(`  from   ${fromDir}`);
line(`  to     ${toDir}`);
line(`  keep   ${keep} automatic snapshot(s) off-box`);

const problems: string[] = [];
let copied = 0;
let alreadyThere = 0;
let noSourceSidecar = 0;
let youngSkipped = 0;
const SETTLE_MS = Number(process.env.OFFBOX_SETTLE_SECONDS ?? 120) * 1000;

// Newest `keep` only: older ones would be pruned off-box straight after copying.
const snapshots = listAutomaticSnapshots(fromDir).slice(0, keep);
if (!snapshots.length) problems.push("no automatic snapshot exists in the backup directory");
for (const name of snapshots) {
  const src = path.join(fromDir, name);
  const dest = path.join(toDir, name);
  try {
    // VACUUM INTO writes straight to the final name, so a snapshot younger than this may still be
    // growing. Copying it would put a truncated file off-box with a sidecar calling it good.
    if (Date.now() - fs.statSync(src).mtimeMs < SETTLE_MS) { youngSkipped++; continue; }
    // 1. Is the source still what the server wrote?
    let sha: string;
    const recorded = readChecksumSidecar(src);
    if (recorded) {
      const v = verifyChecksum(src);
      if (v.state === "mismatch") {
        problems.push(`${name}: the snapshot in the backup directory no longer matches its checksum (disk corruption?) — NOT copied`);
        continue;
      }
      sha = recorded;
    } else {
      // Written by a server build without sidecars. Hash it as it is NOW, and say so. Nothing is
      // written into BACKUP_DIR: an older server rotates only the .sqlite files, so a sidecar left
      // there would outlive its snapshot. (The status file below is the one write, by design.)
      noSourceSidecar++;
      sha = sha256File(src);
    }
    // 2. Already off-box and intact?
    if (fs.existsSync(dest) && readChecksumSidecar(dest) === sha && sha256File(dest) === sha) {
      alreadyThere++;
      continue;
    }
    if (dryRun) { copied++; continue; }
    copyVerified(src, toDir, sha);
    copied++;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    problems.push(`${name}: ${e.code || (e.message || "copy failed").slice(0, 160)}`);
  }
}

let docs = { copied: 0, total: 0, errors: 0, errorCodes: [] as string[] };
if (withDocuments && !dryRun) {
  docs = mirrorTree(path.join(fromDir, "documents"), path.join(toDir, "documents"));
  if (docs.errors) problems.push(`${docs.errors} document file(s) could not be copied (${docs.errorCodes.join(", ")})`);
}
const pruned = dryRun ? 0 : pruneAutomaticSnapshots(toDir, keep);

// Orphan sidecars (a snapshot deleted by hand) would make the drill think a file is missing.
if (!dryRun) {
  try {
    for (const f of fs.readdirSync(toDir)) {
      if (f.endsWith(".sha256") && AUTOMATIC_SNAPSHOT_RE.test(f.slice(0, -7)) && !fs.existsSync(path.join(toDir, f.slice(0, -7)))) {
        fs.unlinkSync(path.join(toDir, f));
      }
    }
  } catch { /* best effort */ }
}

const newestOffbox = listAutomaticSnapshots(toDir)[0] || null;
line();
line(`  snapshots copied            ${copied}${dryRun ? " (would copy)" : ""}`);
line(`  snapshots already off-box   ${alreadyThere}`);
if (youngSkipped) line(`  still being written         ${youngSkipped} (skipped; the next run takes it)`);
if (noSourceSidecar) line(`  written without a checksum  ${noSourceSidecar} (a server build older than the sidecar; hashed at copy time)`);
line(`  documents                   ${withDocuments ? (dryRun ? "skipped in a dry run" : `${docs.total} mirrored off-box (+${docs.copied} new)`) : "skipped (--no-documents)"}`);
line(`  rotated away off-box        ${pruned}`);
line(`  newest off-box snapshot     ${newestOffbox || "NONE"}`);
if (problems.length) {
  line();
  line("  PROBLEMS");
  problems.forEach((p, i) => line(`    ${i + 1}. ${p}`));
}

if (!dryRun) {
  writeStatusFile(path.join(fromDir, OFFBOX_STATUS_NAME), {
    ok: problems.length === 0,
    at: new Date().toISOString(),
    destination: toDir,
    copied,
    alreadyThere,
    documentsCopied: docs.copied,
    documentsTotal: docs.total,
    newestOffbox,
    problems: problems.length,
    // Problems are snapshot stamps and error codes only — never document names.
    firstProblem: problems[0] ? problems[0].slice(0, 200) : null,
  });
}
line();
line(problems.length ? `OFFBOX SYNC: ${problems.length} PROBLEM(S)` : "OFFBOX SYNC: OK");
process.exit(problems.length ? 1 : 0);

