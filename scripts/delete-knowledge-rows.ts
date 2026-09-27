// DELETE NAMED permit_utility_knowledge ROWS — junk / false AHJ records that no import should
// have created (operator ruling 2026-09-26: "Yes, Delete them.").
//
//   npx tsx scripts/delete-knowledge-rows.ts --db <path> --id <uuid> [--id <uuid> …]            (dry run)
//   npx tsx scripts/delete-knowledge-rows.ts --db <path> --id <uuid> [--id <uuid> …] --apply    (writes)
//   add --force to delete a row that is human-verified (verified_at set) or has project_count > 0.
//
// Same shape as scrub-shared-knowledge-names.ts: --db is REQUIRED so this is never pointed at a
// database by default; the dry run opens the file READ-ONLY at the SQLite level (never through
// openDatabase(), which migrates and seeds — a write); --apply first takes a `.backup` copy next
// to the database (<db>.<timestamp>.backup) and then deletes inside ONE transaction.
//
// WHY THE CHILDREN GO FIRST. foreign_keys is ON in this database and knowledge_events,
// historical_project_fingerprints, historical_failure_examples and mbox_learning_records all
// REFERENCE permit_utility_knowledge(profile_key). A bare DELETE of the parent throws (FK on) or
// leaves orphans (FK off) — so the children are deleted by profile_key first, then the row, and
// the pragma is set ON explicitly so a wrong order can never pass silently. The child tables are
// read from sqlite_master, not a hand-kept list, so a table added later is not missed.
//
// WHAT IS REFUSED. An id that names no row; a row a human VERIFIED (verified_at set — hard rule 3:
// human-verified knowledge is never auto-overwritten, and deleting is the strongest overwrite);
// a row that has served projects (project_count > 0). --force overrides the last two, never the
// first. ATOMIC: with any refused id, --apply writes nothing at all.
//
// Prints counts and 8-char ids only — never a profile key, note or name.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const short = (id: unknown): string => s(id).slice(0, 8);

/** The tables whose rows reference permit_utility_knowledge(profile_key). */
export function knowledgeChildTables(db: Database.Database): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%REFERENCES permit_utility_knowledge%' ORDER BY name",
  ).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export interface DeletionPlanEntry {
  /** The full id as given (never printed beyond 8 chars). */
  id: string;
  found: boolean;
  verified: boolean;
  projectCount: number;
  /** Rows per child table that would go with it. */
  children: Record<string, number>;
  /** Empty when the row may be deleted. */
  refusal: string;
}

export function planKnowledgeDeletions(db: Database.Database, ids: string[], opts: { force?: boolean } = {}): DeletionPlanEntry[] {
  const tables = knowledgeChildTables(db);
  const byId = db.prepare("SELECT id, profile_key, verified_at, project_count FROM permit_utility_knowledge WHERE id = ?");
  const plan: DeletionPlanEntry[] = [];
  for (const raw of ids) {
    const id = s(raw).trim();
    const row = byId.get(id) as Row | undefined;
    if (!row) {
      plan.push({ id, found: false, verified: false, projectCount: 0, children: {}, refusal: "no such knowledge row" });
      continue;
    }
    const verified = s(row.verified_at).trim() !== "";
    const projectCount = Number(row.project_count ?? 0) || 0;
    const children: Record<string, number> = {};
    for (const t of tables) {
      children[t] = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE profile_key = ?`).get(s(row.profile_key)) as { n: number }).n);
    }
    const refusals: string[] = [];
    if (verified && !opts.force) refusals.push("human-verified (verified_at set)");
    if (projectCount > 0 && !opts.force) refusals.push(`has served ${projectCount} project(s)`);
    plan.push({ id, found: true, verified, projectCount, children, refusal: refusals.join("; ") });
  }
  return plan;
}

/**
 * Delete every planned row and its children in ONE transaction. Throws (and writes nothing) when
 * any entry carries a refusal — the caller decides whether to print or exit.
 */
export function applyKnowledgeDeletions(db: Database.Database, plan: DeletionPlanEntry[]): { rows: number; children: Record<string, number> } {
  const refused = plan.filter((p) => p.refusal);
  if (refused.length) throw new Error(`refusing to apply: ${refused.length} id(s) refused — nothing written`);
  db.pragma("foreign_keys = ON");
  const tables = knowledgeChildTables(db);
  const totals: Record<string, number> = Object.fromEntries(tables.map((t) => [t, 0]));
  let rows = 0;
  db.transaction(() => {
    const keyOf = db.prepare("SELECT profile_key FROM permit_utility_knowledge WHERE id = ?");
    for (const entry of plan) {
      const row = keyOf.get(entry.id) as Row | undefined;
      if (!row) throw new Error(`row ${short(entry.id)} vanished between plan and apply`);
      const key = s(row.profile_key);
      for (const t of tables) {
        totals[t] += db.prepare(`DELETE FROM ${t} WHERE profile_key = ?`).run(key).changes;
      }
      rows += db.prepare("DELETE FROM permit_utility_knowledge WHERE id = ?").run(entry.id).changes;
    }
  })();
  return { rows, children: totals };
}

/** `<db>.<UTC timestamp>.backup`, next to the database. Uses SQLite's online backup API (WAL-safe). */
export async function backupBeside(dbPath: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${dbPath}.${stamp}.backup`;
  const src = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { await src.backup(dest); } finally { src.close(); }
  if (!fs.existsSync(dest)) throw new Error(`backup was not written: ${dest}`);
  return dest;
}

// ---------------------------------------------------------------------------------------------
// CLI — only when invoked directly (the test imports the functions without side effects).
// ---------------------------------------------------------------------------------------------
const invokedDirectly = ((): boolean => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch { return false; }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const force = argv.includes("--force");
  const dbIdx = argv.indexOf("--db");
  const dbPath = dbIdx >= 0 ? s(argv[dbIdx + 1]) : "";
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--id" && argv[i + 1]) ids.push(argv[++i]);
  if (!dbPath || !ids.length) {
    console.error("Usage: npx tsx scripts/delete-knowledge-rows.ts --db <path> --id <uuid> [--id <uuid> …] [--apply] [--force]\n  --db is required so this is never pointed at a database by default; --id names each row (repeatable).");
    process.exit(2);
  }

  const run = async (): Promise<number> => {
    const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
    const plan = planKnowledgeDeletions(probe, ids, { force });
    probe.close();

    console.log(`\nKnowledge row delete — ${apply ? "APPLY" : "DRY RUN (read-only; nothing written)"} — ${plan.length} id(s)\n`);
    for (const p of plan) {
      const kids = Object.entries(p.children).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(", ") || "no child rows";
      const flags = [p.verified ? "VERIFIED" : "", p.projectCount > 0 ? `project_count ${p.projectCount}` : ""].filter(Boolean).join(", ");
      console.log(`  ${p.refusal ? "REFUSE" : "delete"}  ${short(p.id)}  ${p.found ? `${kids}${flags ? `  [${flags}]` : ""}` : ""}${p.refusal ? `  — ${p.refusal}` : ""}`);
    }
    const refused = plan.filter((p) => p.refusal).length;
    const deletable = plan.length - refused;
    console.log(`\n  ${deletable} row(s) would be deleted, ${refused} refused.`);
    if (!apply) {
      console.log("\n  Dry run. Re-run with --apply to write (a .backup copy is taken first).\n");
      return 0;
    }
    if (refused) {
      console.error("\n  Refused id(s) present — nothing written. Drop them from the command or pass --force where that is the intent.\n");
      return 2;
    }
    const backup = await backupBeside(dbPath);
    console.log(`\n  Backup: ${path.basename(backup)}`);
    const rw = new Database(dbPath, { fileMustExist: true });
    rw.pragma("busy_timeout = 5000");
    try {
      const done = applyKnowledgeDeletions(rw, plan);
      const kids = Object.entries(done.children).map(([t, n]) => `${t} ${n}`).join(", ");
      console.log(`  Written: ${done.rows} knowledge row(s) deleted; child rows: ${kids}.\n`);
    } finally { rw.close(); }
    return 0;
  };
  run().then((code) => process.exit(code), (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
