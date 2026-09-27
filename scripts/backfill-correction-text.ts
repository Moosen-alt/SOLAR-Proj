// RE-READ EXISTING PORTAL CORRECTIONS FOR THE CORRECTION ITSELF (correction card round, 2026-09-27).
//
//   npx tsx scripts/backfill-correction-text.ts --db <path-to-sqlite>            (dry run, read-only)
//   npx tsx scripts/backfill-correction-text.ts --db <path-to-sqlite> --apply    (backs up, then writes)
//
// Before this round a correction the permit monitor opened from a portal reading stored the WHOLE
// record page as correction_text (production 1fb3dc39: 3,712 characters around one Accela
// Condition). New rows store what correctionExtract reads off the page and keep the page in
// corrections.source_text (migration v39). This brings the old rows to the same shape:
//
//   1. A `portal` row with no source_text: the stored text is the page. It moves to source_text
//      (NEVER discarded) and correction_text becomes the extraction — or stays the whole page when
//      nothing is found (source_text then equals it, which is how the card says it fell back).
//   2. The review item linked to that correction (by correctionId in its triage notes) whose
//      excerpt is still the page's first 800 characters gets the correction's instead.
//   3. EVERY row's assigned_to is re-derived from its stored bucket (corrections.assigneeForBucket):
//      the bucket is what the correction agent refined, and no code path ever moved the owner with
//      it — production 1fb3dc39 is an A_we_fix row still assigned to `designer`.
// Nothing else is touched: bucket, root cause, required action and draft stay as the agent wrote
// them. IDEMPOTENT: a re-extracted row has source_text set and is skipped; an owner already equal
// to its bucket's is skipped; a second run plans nothing.
//
// Same shape as delete-knowledge-rows.ts: --db is REQUIRED (never a default database); the dry run
// opens the file READ-ONLY at the SQLite level (never openDatabase(), which migrates and seeds — a
// write); --apply REFUSES a database not at this build's schema (the server migrates it on its next
// start; run --apply after that), takes a `.backup` copy beside it, and writes in ONE transaction.
// Prints counts and 8-char ids only — never correction text (it can carry an address or a name).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AppDb, currentSchemaVersion, latestSchemaVersion } from "../backend/src/db";
import { extractCorrectionFromPage } from "../backend/src/correctionExtract";
import { assigneeForBucket } from "../backend/src/corrections";
import type { CorrectionBucket } from "../shared/src/types";

const BUCKETS: CorrectionBucket[] = ["A_we_fix", "B_designer_fix", "C_reviewer_clarification"];
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const short = (id: unknown): string => s(id).slice(0, 8);

export interface CorrectionBackfillEntry {
  id: string;
  /** "items" / "whole_text": the row is re-read off its page. "owner_only": only assigned_to moves. */
  method: "items" | "whole_text" | "owner_only";
  /** The text the row holds now (the page, for a re-read row). */
  previousText: string;
  correctionText: string;
  sourceText: string;
  previousAssignedTo: string;
  assignedTo: string;
}

function hasSourceTextColumn(db: AppDb): boolean {
  return db.query<{ name: string }>("PRAGMA table_info(corrections)").some((c) => c.name === "source_text");
}

export function planCorrectionTextBackfill(db: AppDb): CorrectionBackfillEntry[] {
  const withColumn = hasSourceTextColumn(db);
  const rows = db.query<Record<string, unknown>>(
    `SELECT id, source, correction_text, correction_bucket, assigned_to${withColumn ? ", source_text" : ""} FROM corrections ORDER BY created_at`,
  );
  const plan: CorrectionBackfillEntry[] = [];
  for (const row of rows) {
    const text = s(row.correction_text);
    const bucket = s(row.correction_bucket);
    const owner = (BUCKETS as string[]).includes(bucket) ? assigneeForBucket(bucket as CorrectionBucket) : s(row.assigned_to);
    const reread = s(row.source) === "portal" && !s(row.source_text).trim() && text.trim() !== "";
    if (reread) {
      const reading = extractCorrectionFromPage(text);
      plan.push({
        id: s(row.id), method: reading.method, previousText: text,
        correctionText: reading.method === "items" ? reading.text : text, sourceText: text,
        previousAssignedTo: s(row.assigned_to), assignedTo: owner,
      });
    } else if (owner !== s(row.assigned_to)) {
      plan.push({
        id: s(row.id), method: "owner_only", previousText: text, correctionText: text, sourceText: s(row.source_text),
        previousAssignedTo: s(row.assigned_to), assignedTo: owner,
      });
    }
  }
  return plan;
}

export function applyCorrectionTextBackfill(db: AppDb, plan: CorrectionBackfillEntry[]): { corrections: number; reviewItems: number } {
  let corrections = 0;
  let reviewItems = 0;
  db.transaction(() => {
    for (const e of plan) {
      if (e.method === "owner_only") {
        db.run("UPDATE corrections SET assigned_to = ? WHERE id = ? AND assigned_to = ?", [e.assignedTo, e.id, e.previousAssignedTo]);
        corrections += db.get<{ n: number }>("SELECT changes() AS n")?.n ?? 0;
        continue;
      }
      // Guarded on the shape planned against, so a row something else rewrote meanwhile is left alone.
      db.run(
        "UPDATE corrections SET correction_text = ?, source_text = ?, assigned_to = ? WHERE id = ? AND source_text = '' AND correction_text = ?",
        [e.correctionText, e.sourceText, e.assignedTo, e.id, e.previousText],
      );
      const changed = db.get<{ n: number }>("SELECT changes() AS n")?.n ?? 0;
      corrections += changed;
      if (!changed || e.correctionText === e.previousText) continue;
      db.run(
        `UPDATE human_review_items SET source_excerpt = ?
          WHERE field_name = 'correction' AND source_excerpt = ? AND notes LIKE ?
            AND project_id = (SELECT project_id FROM corrections WHERE id = ?)`,
        [e.correctionText.slice(0, 800), e.previousText.slice(0, 800), `%"correctionId":"${e.id}"%`, e.id],
      );
      reviewItems += db.get<{ n: number }>("SELECT changes() AS n")?.n ?? 0;
    }
  });
  return { corrections, reviewItems };
}

/** `<db>.<UTC timestamp>.backup`, next to the database — SQLite's online backup API (WAL-safe). */
async function backupBeside(dbPath: string): Promise<string> {
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
  const dbIdx = argv.indexOf("--db");
  const dbPath = dbIdx >= 0 ? s(argv[dbIdx + 1]) : "";
  if (!dbPath) {
    console.error("Usage: npx tsx scripts/backfill-correction-text.ts --db <path> [--apply]\n  --db is required so this is never pointed at a database by default.");
    process.exit(2);
  }
  const run = async (): Promise<number> => {
    const probe = new AppDb(new Database(dbPath, { readonly: true, fileMustExist: true }));
    const have = currentSchemaVersion(probe);
    const want = latestSchemaVersion();
    const withColumn = hasSourceTextColumn(probe);
    const plan = planCorrectionTextBackfill(probe);
    probe.close();

    const count = (m: CorrectionBackfillEntry["method"]): number => plan.filter((e) => e.method === m).length;
    console.log(`\nCorrection text backfill — ${apply ? "APPLY" : "DRY RUN (read-only; nothing written)"}  (schema v${have}, this build v${want})\n`);
    console.log(`  portal rows re-read: condition / comment found          ${count("items")}`);
    console.log(`  portal rows re-read: nothing found, whole page stands   ${count("whole_text")}`);
    console.log(`  rows whose owner moves to follow the bucket (any kind)   ${plan.filter((e) => e.assignedTo !== e.previousAssignedTo).length}`);
    for (const e of plan) {
      console.log(`    ${short(e.id)}  ${e.method.padEnd(10)}  ${String(e.previousText.length).padStart(5)} -> ${String(e.correctionText.length).padStart(5)} chars`
        + `${e.assignedTo !== e.previousAssignedTo ? `  owner ${e.previousAssignedTo || "(none)"} -> ${e.assignedTo}` : ""}`);
    }
    if (!withColumn) console.log("\n  corrections.source_text does not exist yet (schema older than v39): the server migrates on its next start.");
    if (!apply) { console.log("\nDry run: nothing written. Re-run with --apply to write."); return 0; }
    if (have !== want || !withColumn) {
      console.error(`\nRefusing --apply: ${dbPath} is at schema v${have}, this code expects v${want}. Start the server on this build once (it migrates), then --apply. Nothing was written.`);
      return 2;
    }
    if (!plan.length) { console.log("\nNothing to apply."); return 0; }
    const backup = await backupBeside(dbPath);
    console.log(`\n  backup: ${backup}`);
    const rw = new Database(dbPath, { fileMustExist: true });
    rw.pragma("busy_timeout = 5000");
    const db = new AppDb(rw);
    try {
      const done = applyCorrectionTextBackfill(db, planCorrectionTextBackfill(db));
      console.log(`  applied: ${done.corrections} correction row(s), ${done.reviewItems} review-item excerpt(s).`);
    } finally { db.close(); }
    return 0;
  };
  run().then((code) => process.exit(code)).catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
