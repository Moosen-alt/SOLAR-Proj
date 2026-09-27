// SCRUB THE OPERATOR'S OWN STAFF OUT OF THE SHARED KNOWLEDGE NOTES.
//
//   npx tsx scripts/scrub-shared-knowledge-staff-names.ts --db <path-to-sqlite>            (dry run)
//   npx tsx scripts/scrub-shared-knowledge-staff-names.ts --db <path-to-sqlite> --apply    (writes)
//
// Sibling of scrub-shared-knowledge-names.ts (which handles homeowner names in provenance labels
// and correction samples). permit_utility_knowledge is shared with EVERY tenant on purpose
// (CLAUDE.md), and the reference-spreadsheet import carried a few of the operator's COMPANY
// STAFF into its notes — "Building permit is in Nick's prepped applications", "Person to pick
// up permit: Stephen Bearden". Every other tenant reads those cards. Operator ruling 2026-09-26:
// "Remove them if you see them I suppose."
//
// AN EXPLICIT ALLOWLIST OF CLAUSES, NOT A NAME DETECTOR. The same notes name JURISDICTION desk
// staff ("Megan Winner - [REDACTED_PHONE]" at Coburg, "Contact is Vicki Russell" at Oak Point,
// "(Nathan)", "Heaven (", "Ray / Rebecca / Alice") — those are the agency's own people, useful to
// every tenant, and whether they stay is a separate operator question. A generic
// "<First Last> - [REDACTED_PHONE]" rule would take Megan Winner with Nick, so nothing generic
// runs here: each entry below is bound to one named company-staff clause, and the instruction
// the clause carried is kept in its place (the folder still exists; the permit is still picked
// up in person). The list is exported so a test can prove both directions (mustRemove /
// mustKeep).
//
// SEGMENT-WISE: notes are " | "-joined segments (knowledgeBase.noteSegments convention); each
// segment is scrubbed on its own and the segments deduped afterwards (two segments can collapse
// to the same text once the name is gone). Opens the database directly (NOT openDatabase(), which
// migrates and seeds — a write — on a dry run); the dry run opens it READ-ONLY. Prints counts and
// 8-char ids only, never a name or a note.
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export interface StaffClause {
  /** What it removes — for the report, never the name itself. */
  label: string;
  pattern: RegExp;
  replacement: string;
}

/** The company-staff clauses, each bound to its name. Add a clause here, never a name pattern. */
export const COMPANY_STAFF_CLAUSES: readonly StaffClause[] = [
  {
    // "is in Nick's prepped applications" / "under Nick's prepped folder" /
    // "under Nick's prepped applications folder" → the folder, no owner.
    label: "prepped-applications folder owner",
    pattern: /\b(?:in|under)\s+Nick'?s\s+prepped\s+(?:applications\s+folder|applications|folder)\b/gi,
    replacement: "in the prepared applications folder",
  },
  {
    label: "permit pick-up person",
    pattern: /\bPerson\s+to\s+pick\s+up\s+permit:\s*Stephen\s+Bearden\b\.?/gi,
    replacement: "Permit is picked up in person by the company's designated person.",
  },
];

/** One segment, every clause. */
export function scrubStaffClauses(segment: string): { text: string; hits: number } {
  let text = segment;
  let hits = 0;
  for (const clause of COMPANY_STAFF_CLAUSES) {
    text = text.replace(clause.pattern, () => { hits += 1; return clause.replacement; });
  }
  return { text: text.replace(/\s{2,}/g, " ").trim(), hits };
}

/** A whole " | "-joined notes blob: segment-wise scrub, then dedupe (first occurrence wins). */
export function scrubStaffNotes(notes: string): { text: string; hits: number; changed: boolean } {
  const segments = String(notes || "").split(" | ").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  let hits = 0;
  for (const seg of segments) {
    const r = scrubStaffClauses(seg);
    hits += r.hits;
    if (!r.text || seen.has(r.text)) continue;
    seen.add(r.text);
    out.push(r.text);
  }
  const text = out.join(" | ");
  return { text, hits, changed: hits > 0 && text !== String(notes || "") };
}

const invokedDirectly = ((): boolean => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch { return false; }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dbIdx = argv.indexOf("--db");
  const dbPath = dbIdx >= 0 ? argv[dbIdx + 1] : "";
  if (!dbPath) {
    console.error("Usage: npx tsx scripts/scrub-shared-knowledge-staff-names.ts --db <path> [--apply]\n  --db is required so this is never pointed at a database by default.");
    process.exit(2);
  }
  const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
  if (apply) db.pragma("busy_timeout = 5000");

  const updates: Array<{ id: string; notes: string }> = [];
  const perClause = new Map<string, number>(COMPANY_STAFF_CLAUSES.map((c) => [c.label, 0]));
  let rowsScanned = 0;
  for (const row of db.prepare("SELECT id, notes FROM permit_utility_knowledge WHERE notes <> ''").all() as Array<{ id: string; notes: string }>) {
    rowsScanned += 1;
    const r = scrubStaffNotes(String(row.notes || ""));
    if (!r.changed) continue;
    for (const clause of COMPANY_STAFF_CLAUSES) {
      const n = (String(row.notes).match(clause.pattern) || []).length;
      if (n) perClause.set(clause.label, (perClause.get(clause.label) || 0) + n);
    }
    updates.push({ id: String(row.id), notes: r.text });
  }

  console.log(`\nShared-knowledge staff-name scrub — ${apply ? "APPLY" : "DRY RUN (read-only; nothing written)"}\n`);
  console.log(`  permit_utility_knowledge rows with notes scanned      ${rowsScanned}`);
  console.log(`  rows carrying a company-staff clause                  ${updates.length}`);
  for (const [label, n] of perClause) console.log(`    ${label.padEnd(50)} ${n}`);
  if (updates.length) console.log(`\n  rows affected (8-char ids): ${updates.map((u) => u.id.slice(0, 8)).join(" ")}`);

  if (apply) {
    const ts = new Date().toISOString();
    db.transaction(() => {
      const stmt = db.prepare("UPDATE permit_utility_knowledge SET notes = ?, updated_at = ? WHERE id = ?");
      for (const u of updates) stmt.run(u.notes, ts, u.id);
    })();
    console.log(`\n  Written: ${updates.length} knowledge row(s).\n`);
  } else {
    console.log("\n  Dry run. Re-run with --apply to write. Take a backup first.\n");
  }
  db.close();
}
