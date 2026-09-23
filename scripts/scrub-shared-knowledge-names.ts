// SCRUB PERSON-NAME FRAGMENTS OUT OF THE SHARED KNOWLEDGE ROWS.
//
//   npx tsx scripts/scrub-shared-knowledge-names.ts --db <path-to-sqlite>            (dry run)
//   npx tsx scripts/scrub-shared-knowledge-names.ts --db <path-to-sqlite> --apply    (writes)
//
// permit_utility_knowledge is shared with EVERY tenant on purpose (CLAUDE.md), but three
// writers used to put people into it:
//
//   1. The batch past-project scanner labelled its source `batch:<file name>`, and past-project
//      files are named "First Last - City, ST.pdf" — a homeowner's name, in sources_json and in
//      the batch_import knowledge_events' details. The scanner now writes a document-KIND label
//      ("batch scan: correction"); this relabels the old ones. ALL `batch:` labels are
//      relabelled, not only the ones matching a name pattern: the file name is private
//      provenance by policy now, and a name regex misses as much as it catches ("filter lists
//      fail both ways").
//   2. The correction rollup (common_corrections_json) copied the raw correction excerpt as
//      `sample` — "Hi <first name>, ..." and co-customer names. The rollup no longer carries a
//      sample at all; this removes the key from every existing entry.
//   3. historical_failure_examples.sample (org-scoped now, migration v31) still holds salutation +
//      name openings from the June mbox import. Defence in depth: the name after a greeting is
//      replaced with "[name]"; the rest of the excerpt — the actual correction — is kept.
//
// Nothing else is touched: no portal URL, note, confidence or verification. Opens the database
// directly (NOT openDatabase(), which would run migrations and seeders — a write — on a dry run).
// The dry run opens it READ-ONLY. Prints counts and 8-char ids only, never a name.
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const dbIdx = argv.indexOf("--db");
const dbPath = dbIdx >= 0 ? argv[dbIdx + 1] : "";
if (!dbPath) {
  console.error("Usage: npx tsx scripts/scrub-shared-knowledge-names.ts --db <path> [--apply]\n  --db is required so this is never pointed at a database by default.");
  process.exit(2);
}

const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });

/** The document-kind label the scanner writes when it no longer knows the kind. */
const SCRUBBED_BATCH_LABEL = "batch scan: document";
const BATCH_LABEL = /^batch:/;
/** Counted separately so the report can be compared with the evaluation's figure (56). */
const NAME_SHAPED_BATCH = /^batch:[A-Z][a-z]+ [A-Z][a-z]+ - [A-Za-z .]+, [A-Z]{2}\.pdf$/;

// "Hi Quentin," / "Hello Quentin Marlowe" / "Dear Ms. Marlowe". Greetings addressed to a role
// ("Hi Team", "Dear Applicant") are not names and are left as written.
const SALUTATION_NAME =
  /\b(Hi|Hello|Hey|Dear|Good (?:morning|afternoon|evening))([ ,]+)((?:(?:Mr|Mrs|Ms|Dr)\.?\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
const NOT_A_NAME = /^(All|Team|Everyone|There|Applicant|Customer|Sir|Madam|Folks|Guys|Permit|Permits|Staff|Friends|Again)\b/;

function scrubSalutationNames(value: string): { text: string; hits: number } {
  let hits = 0;
  const text = value.replace(SALUTATION_NAME, (whole, greet: string, sep: string, name: string) => {
    if (NOT_A_NAME.test(name)) return whole;
    hits += 1;
    return `${greet}${sep}[name]`;
  });
  return { text, hits };
}

type Source = { label?: string; url?: string; sourceType?: string; observedAt?: string };
const short = (id: unknown): string => String(id ?? "").slice(0, 8);

const counts = {
  kbRowsWithBatchLabels: 0,
  batchLabels: 0,
  batchLabelsNameShaped: 0,
  eventsWithBatchLabel: 0,
  kbRowsWithSampleKey: 0,
  correctionSamplesRemoved: 0,
  correctionSamplesWithSalutationName: 0,
  hfeSamplesWithSalutationName: 0,
};
const touchedKb: string[] = [];

const kbUpdates: Array<{ id: string; sources: string; corrections: string }> = [];
for (const row of db.prepare("SELECT id, sources_json, common_corrections_json FROM permit_utility_knowledge").all() as Array<Record<string, unknown>>) {
  let sources: Source[] = [];
  let corrections: Array<Record<string, unknown>> = [];
  try { sources = JSON.parse(String(row.sources_json || "[]")); } catch { sources = []; }
  try { corrections = JSON.parse(String(row.common_corrections_json || "[]")); } catch { corrections = []; }
  if (!Array.isArray(sources)) sources = [];
  if (!Array.isArray(corrections)) corrections = [];

  let sourcesChanged = false;
  const relabelled = sources.map((s) => {
    if (!BATCH_LABEL.test(String(s?.label ?? ""))) return s;
    counts.batchLabels += 1;
    if (NAME_SHAPED_BATCH.test(String(s.label))) counts.batchLabelsNameShaped += 1;
    sourcesChanged = true;
    return { ...s, label: SCRUBBED_BATCH_LABEL };
  });
  if (sourcesChanged) counts.kbRowsWithBatchLabels += 1;
  // Relabelling collapses many per-file sources into one: dedupe on the same key mergeSources
  // uses (sourceType|label|url), keeping the NEWEST observation.
  const deduped = new Map<string, Source>();
  for (const s of relabelled) {
    const k = `${s?.sourceType}|${s?.label}|${s?.url}`.toLowerCase();
    const prev = deduped.get(k);
    if (!prev || String(s?.observedAt ?? "") > String(prev.observedAt ?? "")) deduped.set(k, s);
  }

  let correctionsChanged = false;
  const cleaned = corrections.map((c) => {
    if (!c || typeof c !== "object" || !("sample" in c)) return c;
    correctionsChanged = true;
    counts.correctionSamplesRemoved += 1;
    if (scrubSalutationNames(String(c.sample ?? "")).hits) counts.correctionSamplesWithSalutationName += 1;
    const { sample: _dropped, ...rest } = c;
    return rest;
  });
  if (correctionsChanged) counts.kbRowsWithSampleKey += 1;

  if (sourcesChanged || correctionsChanged) {
    touchedKb.push(short(row.id));
    kbUpdates.push({
      id: String(row.id),
      sources: sourcesChanged ? JSON.stringify([...deduped.values()]) : String(row.sources_json),
      corrections: correctionsChanged ? JSON.stringify(cleaned) : String(row.common_corrections_json),
    });
  }
}

const eventUpdates: Array<{ id: string; details: string }> = [];
for (const row of db.prepare("SELECT id, details FROM knowledge_events WHERE details LIKE '%batch:%'").all() as Array<Record<string, unknown>>) {
  let details: Record<string, unknown>;
  try { details = JSON.parse(String(row.details || "{}")); } catch { continue; }
  if (!details || typeof details !== "object" || !BATCH_LABEL.test(String(details.sourceLabel ?? ""))) continue;
  counts.eventsWithBatchLabel += 1;
  eventUpdates.push({ id: String(row.id), details: JSON.stringify({ ...details, sourceLabel: SCRUBBED_BATCH_LABEL }) });
}

const hfeUpdates: Array<{ id: string; sample: string }> = [];
for (const row of db.prepare("SELECT id, sample FROM historical_failure_examples").all() as Array<Record<string, unknown>>) {
  const scrubbed = scrubSalutationNames(String(row.sample ?? ""));
  if (!scrubbed.hits) continue;
  counts.hfeSamplesWithSalutationName += 1;
  hfeUpdates.push({ id: String(row.id), sample: scrubbed.text });
}

console.log(`\nShared-knowledge name scrub — ${apply ? "APPLY" : "DRY RUN (read-only; nothing written)"}\n`);
console.log(`  permit_utility_knowledge rows with batch:<file> source labels   ${counts.kbRowsWithBatchLabels}`);
console.log(`    batch:<file> labels relabelled to "${SCRUBBED_BATCH_LABEL}"      ${counts.batchLabels}`);
console.log(`      of which exactly "batch:First Last - City, ST.pdf"            ${counts.batchLabelsNameShaped}`);
console.log(`  knowledge_events with a batch:<file> sourceLabel                 ${counts.eventsWithBatchLabel}`);
console.log(`  permit_utility_knowledge rows whose rollup carries a sample       ${counts.kbRowsWithSampleKey}`);
console.log(`    rollup samples removed                                          ${counts.correctionSamplesRemoved}`);
console.log(`      of which open with a salutation + name                        ${counts.correctionSamplesWithSalutationName}`);
console.log(`  historical_failure_examples samples with salutation + name        ${counts.hfeSamplesWithSalutationName}`);
if (touchedKb.length) console.log(`\n  knowledge rows affected (8-char ids): ${touchedKb.slice(0, 40).join(" ")}${touchedKb.length > 40 ? ` … +${touchedKb.length - 40}` : ""}`);

if (apply) {
  const ts = new Date().toISOString();
  db.transaction(() => {
    const kbStmt = db.prepare("UPDATE permit_utility_knowledge SET sources_json = ?, common_corrections_json = ?, updated_at = ? WHERE id = ?");
    for (const u of kbUpdates) kbStmt.run(u.sources, u.corrections, ts, u.id);
    const evStmt = db.prepare("UPDATE knowledge_events SET details = ? WHERE id = ?");
    for (const u of eventUpdates) evStmt.run(u.details, u.id);
    const hfeStmt = db.prepare("UPDATE historical_failure_examples SET sample = ? WHERE id = ?");
    for (const u of hfeUpdates) hfeStmt.run(u.sample, u.id);
  })();
  console.log(`\n  Written: ${kbUpdates.length} knowledge row(s), ${eventUpdates.length} event(s), ${hfeUpdates.length} failure sample(s).\n`);
} else {
  console.log("\n  Dry run. Re-run with --apply to write. Take a backup first.\n");
}
db.close();
