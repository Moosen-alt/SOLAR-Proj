import type { AppDb } from "./db";
import { nowIso } from "./time";

// Self-teaching digest topics. When a learn/stage run leaves a REQUIRED portal
// question unanswered, the question's meaningful words are recorded here. A word
// seen across enough distinct misses becomes a learned topic: designNotesDigest
// starts pulling plan-set/notes lines containing it into the planner's designNotes,
// so the next run can answer the question from the project's own documents.
// Deterministic and cheap — no LLM involved in the learning loop.

// Generic form vocabulary that would match everything — never learn these.
const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "this", "that", "with", "from", "have", "will",
  "are", "was", "not", "any", "all", "does", "did", "please", "select", "enter", "type",
  "field", "fields", "required", "optional", "information", "info", "number", "name",
  "first", "last", "company", "address", "street", "city", "state", "zip", "email",
  "phone", "date", "application", "project", "system", "portal", "form", "page",
  "upload", "document", "documents", "file", "files", "attach", "attached", "other",
  "yes", "propose", "proposed", "would", "like", "want", "each", "than", "then",
  "which", "what", "when", "where", "how", "who", "there", "here", "their", "must",
]);

/** How many distinct misses a term needs before it becomes an active topic. */
const ACTIVATION_COUNT = 2;

function termsFrom(label: string): string[] {
  return [...new Set(
    label
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)),
  )];
}

/** Record the terms of required portal questions that were left unanswered. */
export function learnNoteTopicsFromMisses(db: AppDb, missedLabels: string[]): void {
  const now = nowIso();
  for (const label of missedLabels) {
    for (const term of termsFrom(label)) {
      try {
        db.run(
          `INSERT INTO learned_note_topics (term, miss_count, sample_label, updated_at)
           VALUES (?, 1, ?, ?)
           ON CONFLICT(term) DO UPDATE SET miss_count = miss_count + 1, sample_label = ?, updated_at = ?`,
          [term, label.slice(0, 200), now, label.slice(0, 200), now],
        );
      } catch { /* table missing on very old DBs — learning is best-effort */ }
    }
  }
}

/** Terms that have recurred enough to actively steer the design-notes digest. */
export function activeLearnedNoteTerms(db: AppDb, limit = 40): string[] {
  try {
    return db
      .query<{ term: string }>(
        "SELECT term FROM learned_note_topics WHERE miss_count >= ? ORDER BY miss_count DESC, updated_at DESC LIMIT ?",
        [ACTIVATION_COUNT, limit],
      )
      .map((row) => String(row.term));
  } catch {
    return [];
  }
}
