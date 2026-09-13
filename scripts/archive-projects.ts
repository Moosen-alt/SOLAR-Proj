// TAKE A PROJECT OFF THE CLIENT'S PORTAL WITHOUT DESTROYING IT.
//
//   npx tsx scripts/archive-projects.ts --list
//   npx tsx scripts/archive-projects.ts --project <id> [--project <id> …] --why "reason"   (dry run)
//   npx tsx scripts/archive-projects.ts --project <id> --why "reason" --apply
//   npx tsx scripts/archive-projects.ts --unarchive <id> --apply
//
// IDS ONLY, never a pattern. The projects this exists for are repeated staging passes at ONE
// address, and which pass is the keeper is a judgement — HANDOFF.md cites some by id as
// certified runs, demoReplay.ts names others. A matcher clever enough to group them is clever
// enough to archive the wrong one silently, so the caller names each row and says why.
//
// DRY RUN IS THE DEFAULT and the write is behind --apply, because the last script in this repo
// that took a --dry-run flag guarded only half its writes.
import { openDatabase } from "../backend/src/db";
import { archiveProject, unarchiveProject, listArchivedProjects } from "../backend/src/projectArchive";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const flagValues = (flag: string): string[] => argv.reduce<string[]>((acc, a, i) => {
  if (a === flag && argv[i + 1]) acc.push(String(argv[i + 1]));
  return acc;
}, []);
const targets = flagValues("--project");
const unarchive = flagValues("--unarchive");
const why = flagValues("--why")[0] || "";

const db = await openDatabase();

if (argv.includes("--list") || (!targets.length && !unarchive.length)) {
  const archived = listArchivedProjects(db);
  console.log(`\n${archived.length} archived project(s) — hidden from client portals, still in the database:\n`);
  for (const a of archived) {
    console.log(`  ${a.id}  ${a.address}`);
    console.log(`     ${a.archivedAt.slice(0, 16)}  ${a.reason}`);
  }
  if (!archived.length) console.log("  (none)");
  console.log("");
  db.close();
  process.exit(0);
}

if (unarchive.length) {
  for (const id of unarchive) {
    if (!apply) { console.log(`  would UNARCHIVE ${id}`); continue; }
    const r = unarchiveProject(db, id);
    console.log(r.archived ? `  unarchived ${id}` : `  SKIPPED ${id}: ${r.reason}`);
  }
  if (!apply) console.log("\nDry run. Re-run with --apply to write.\n");
  db.close();
  process.exit(0);
}

if (!why) {
  console.error("\nRefusing: --why is required. Six months from now it is the only thing that\n"
    + "explains why a job vanished from a client's list.\n");
  db.close();
  process.exit(1);
}

for (const id of targets) {
  const row = db.get<{ project_address?: string; status?: string; archived_at?: string }>(
    "SELECT project_address, status, archived_at FROM projects WHERE id = ?", [id],
  );
  if (!row) { console.log(`  NOT FOUND ${id}`); continue; }
  const label = `${id}  ${String(row.project_address || "").slice(0, 42).padEnd(44)} ${row.status}`;
  if (String(row.archived_at || "")) { console.log(`  already archived  ${label}`); continue; }
  if (!apply) { console.log(`  would archive     ${label}`); continue; }
  const r = archiveProject(db, id, why);
  console.log(r.archived ? `  archived          ${label}` : `  SKIPPED ${id}: ${r.reason}`);
}

console.log(apply
  ? "\nDone. Nothing was deleted — every row, document and submission is still there.\n"
    + "Undo with:  npx tsx scripts/archive-projects.ts --unarchive <id> --apply\n"
  : "\nDry run. Nothing was written. Re-run with --apply.\n");
db.close();
