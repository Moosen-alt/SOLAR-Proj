// WHAT DID THE SHARED KNOWLEDGE BASE LEARN THAT IT SHOULD NOT HAVE? — a DRY RUN (L2 / L3 / L4).
//
//   npx tsx scripts/audit-learned-provenance.ts --source <live.sqlite> --copy <scratch.sqlite>
//
// NEVER writes the source. It copies the source database (SQLite online backup — WAL-safe, the
// server may be running) to --copy, and everything else happens on the COPY:
//
//   L3  shared profiles (permit_utility_knowledge) whose key is benchmark/demo-shaped, and
//       profiles learned ONLY from projects that no longer exist (every knowledge event points
//       at a deleted project and every source is a learned_* source), plus project_count drift
//       against COUNT(DISTINCT project_id) in knowledge_events. Listed, never deleted.
//   L2  what the derived timelines become: the copy is opened with openDatabase() (runs the
//       v32 migration on the COPY), every recorded permit_status_checks transition is replayed
//       through recordTimelineSample in created_at order (first reading wins the UNIQUE key),
//       and every profile carrying a legacy polling timeline is rebuilt. Before/after printed.
//   L4  live corrections whose learned failure row disagrees with the correction's CURRENT
//       classification, and what relearnCorrection does to each (on the copy).
//
// Prints profile keys (jurisdiction / utility names — public entities) and 8-char ids only;
// never a homeowner name, address, email, phone or account number.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const arg = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] || "" : ""; };
const source = arg("--source");
const copy = arg("--copy");
if (!source || !copy) {
  console.error("Usage: npx tsx scripts/audit-learned-provenance.ts --source <live.sqlite> --copy <scratch.sqlite>\n  Both are required; the source is only ever read.");
  process.exit(2);
}
if (path.resolve(source) === path.resolve(copy)) {
  console.error("REFUSED: --copy must be a different file from --source.");
  process.exit(2);
}

// ---- 1. the copy -------------------------------------------------------------------------
fs.mkdirSync(path.dirname(path.resolve(copy)), { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${copy}${suffix}`); } catch { /* none */ } }
{
  const src = new Database(source, { readonly: true, fileMustExist: true });
  await src.backup(copy);
  src.close();
}
console.log(`Copied ${source} -> ${copy} (source opened read-only).\n`);

type Row = Record<string, unknown>;
const s = (v: unknown) => (v == null ? "" : String(v));
const short = (v: unknown) => s(v).slice(0, 8);

// ---- 2. L3 provenance, read on the raw copy (before any migration) ------------------------
const raw = new Database(copy, { readonly: true });
const q = <T = Row>(sql: string, ...params: unknown[]) => raw.prepare(sql).all(...params) as T[];
const liveProjects = new Set(q<{ id: string }>("SELECT id FROM projects").map((r) => r.id));

const synthetic = q<Row>(
  `SELECT profile_key, confidence, project_count FROM permit_utility_knowledge
    WHERE profile_key LIKE '%|benchmark%' OR ahj LIKE 'benchmark%' OR utility LIKE 'benchmark%'
       OR profile_key LIKE '%demo%' OR ahj LIKE '%demo%'
    ORDER BY profile_key`,
);
const benchmarkKeys = synthetic.filter((r) => /benchmark/i.test(s(r.profile_key)));
const demoKeys = synthetic.filter((r) => !/benchmark/i.test(s(r.profile_key)));
console.log("L3 — SYNTHETIC-KEYED SHARED PROFILES (listed, not deleted)");
console.log(`  benchmark-keyed profiles: ${benchmarkKeys.length}`);
for (const r of benchmarkKeys.slice(0, 10)) console.log(`    ${s(r.profile_key)}  [${s(r.confidence)}] project_count=${s(r.project_count)}`);
if (benchmarkKeys.length > 10) console.log(`    …and ${benchmarkKeys.length - 10} more`);
console.log(`  demo-keyed profiles: ${demoKeys.length}`);
for (const r of demoKeys) console.log(`    ${s(r.profile_key)}  [${s(r.confidence)}] project_count=${s(r.project_count)}`);

// Demo rows are NOT demo-keyed (a demo project in "City of Portland" on PGE keys to the real
// Portland row), so the demo's learning shows up as events from deleted projects — below.
const profiles = q<Row>("SELECT profile_key, confidence, sources_json, project_count FROM permit_utility_knowledge");
const eventsByKey = new Map<string, Array<{ project_id: string | null }>>();
for (const e of q<{ profile_key: string; project_id: string | null }>("SELECT profile_key, project_id FROM knowledge_events")) {
  const list = eventsByKey.get(e.profile_key) || [];
  list.push({ project_id: e.project_id });
  eventsByKey.set(e.profile_key, list);
}
const orphanOnly: Row[] = [];
const partialOrphan: Array<{ key: string; deleted: number; live: number }> = [];
const drift: Array<{ key: string; stored: number; actual: number }> = [];
for (const p of profiles) {
  const key = s(p.profile_key);
  const events = eventsByKey.get(key) || [];
  const projectIds = new Set(events.map((e) => e.project_id).filter((v): v is string => Boolean(v)));
  const deleted = [...projectIds].filter((id) => !liveProjects.has(id));
  const live = [...projectIds].filter((id) => liveProjects.has(id));
  let sourceTypes: string[] = [];
  try { sourceTypes = (JSON.parse(s(p.sources_json) || "[]") as Array<{ sourceType?: string }>).map((x) => s(x.sourceType)); } catch { /* malformed */ }
  const onlyLearnedSources = sourceTypes.length > 0 && sourceTypes.every((t) => /^learned_(project|correction|permit_status)$/.test(t));
  // deleteProject removes a project's knowledge_events, so a row taught ONLY by projects that are
  // gone has project-learned sources and no event left from a live project (or none at all).
  const noLiveEvidence = events.every((e) => e.project_id && !liveProjects.has(e.project_id));
  if (onlyLearnedSources && noLiveEvidence) orphanOnly.push(p);
  else if (deleted.length) partialOrphan.push({ key, deleted: deleted.length, live: live.length });
  const actual = projectIds.size;
  if (Number(p.project_count ?? 0) !== actual) drift.push({ key, stored: Number(p.project_count ?? 0), actual });
}
console.log(`\n  profiles learned ONLY from projects that no longer exist (every source learned_project/correction/permit_status, no event from a live project): ${orphanOnly.length}`);
const orphanNonBenchmark = orphanOnly.filter((r) => !/benchmark/i.test(s(r.profile_key)));
console.log(`    of which benchmark-keyed: ${orphanOnly.length - orphanNonBenchmark.length}; other: ${orphanNonBenchmark.length}`);
for (const r of orphanNonBenchmark.slice(0, 25)) console.log(`    ${s(r.profile_key)}  [${s(r.confidence)}] project_count=${s(r.project_count)}`);
if (orphanNonBenchmark.length > 25) console.log(`    …and ${orphanNonBenchmark.length - 25} more`);
console.log(`  profiles that ALSO carry events from deleted projects (mixed provenance — keep; rebuild counts only): ${partialOrphan.length}`);
console.log(`  profiles whose project_count disagrees with COUNT(DISTINCT project_id) in knowledge_events: ${drift.length}`);
for (const d of drift.slice(0, 15)) console.log(`    ${d.key}  stored=${d.stored} actual=${d.actual}`);
if (drift.length > 15) console.log(`    …and ${drift.length - 15} more`);
const deletedProjectEvents = q<{ n: number }>(
  "SELECT COUNT(*) n FROM knowledge_events e WHERE e.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = e.project_id)",
)[0]?.n ?? 0;
console.log(`  knowledge_events rows pointing at deleted projects: ${deletedProjectEvents}`);

// L2 "before" snapshot, read raw.
const timelineBefore = new Map(
  q<Row>("SELECT profile_key, average_timeline_days, timeline_sample_count FROM permit_utility_knowledge WHERE timeline_sample_count > 0 OR average_timeline_days IS NOT NULL")
    .map((r) => [s(r.profile_key), { avg: r.average_timeline_days == null ? null : Number(r.average_timeline_days), n: Number(r.timeline_sample_count ?? 0) }]),
);
raw.close();

// ---- 3. L2 + L4 on the COPY through the product's own code -------------------------------
process.env.AUTOPILOT_DB_PATH = path.resolve(copy);
process.env.BACKGROUND_WORKERS = "off";
process.env.SEED_TEST_INSTALLER = "false";
const { openDatabase } = await import("../backend/src/db");
const { relearnCorrection } = await import("../backend/src/knowledgeBase");
const { backfillTimelineSamples } = await import("../backend/src/timelineSamples");
const db = await openDatabase();

// EXACTLY what an operator-approved backfill would do on production: the same exported function.
const backfill = backfillTimelineSamples(db);
const rebuildKeys = [...timelineBefore.keys()];
console.log("\nL2 — TIMELINES, RE-DERIVED FROM FIRST-TRANSITION SAMPLES (on the copy, via backfillTimelineSamples)");
console.log(`  recorded milestone transitions replayed: ${backfill.replayed}; samples written: ${backfill.samplesWritten}; profiles recomputed: ${backfill.profilesRecomputed.length}`);
const notesWithPolls = db.query<Row>("SELECT COUNT(*) n FROM permit_utility_knowledge WHERE timeline_notes_json LIKE '%\"issued: %' OR timeline_notes_json LIKE '%\"waiting: %' OR timeline_notes_json LIKE '%\"needs human review: %'")[0];
console.log(`  profiles still carrying per-poll notes after the backfill: ${s(notesWithPolls?.n)}`);
for (const r of db.query<Row>("SELECT track, milestone, COUNT(*) n FROM permit_timeline_samples GROUP BY track, milestone ORDER BY track, milestone")) {
  console.log(`    ${s(r.track).padEnd(10)} ${s(r.milestone).padEnd(18)} ${s(r.n)}`);
}
for (const key of rebuildKeys) {
  const after = db.get<Row>("SELECT average_timeline_days a, timeline_sample_count n FROM permit_utility_knowledge WHERE profile_key = ?", [key]);
  const before = timelineBefore.get(key);
  console.log(`    ${key}: before ${before?.avg == null ? "—" : before.avg.toFixed(1)} d (n=${before?.n ?? 0})  ->  after ${after?.a == null ? "—" : Number(after.a).toFixed(1)} d (n=${s(after?.n ?? 0)})`);
}

console.log("\nL4 — LIVE CORRECTIONS vs THEIR LEARNED FAILURE ROW (relearned on the copy)");
for (const c of db.query<Row>("SELECT id, project_id, correction_bucket, learning_retracted FROM corrections ORDER BY created_at")) {
  const before = db.query<Row>("SELECT correction_bucket FROM historical_failure_examples WHERE correction_id = ?", [s(c.id)]).map((r) => s(r.correction_bucket));
  const result = relearnCorrection(db, s(c.id));
  const after = db.query<Row>("SELECT correction_bucket FROM historical_failure_examples WHERE correction_id = ?", [s(c.id)]).map((r) => s(r.correction_bucket));
  console.log(`  correction ${short(c.id)} (project ${short(c.project_id)}) now ${s(c.correction_bucket)}: learned row ${JSON.stringify(before)} -> ${JSON.stringify(after)} [${result}]`);
}
console.log(`\nDry run complete. The source (${source}) was not written; every change above exists only in ${copy}.`);
