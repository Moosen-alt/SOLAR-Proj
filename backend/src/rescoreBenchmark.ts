// ---------------------------------------------------------------------------
// RESCORE A SCORECARD FROM THE RUN BUNDLES IT LEFT BEHIND.
//
// A benchmark row is a reading of a run, and a reading can be wrong while the run it read
// was fine. The baseline of 2026-09-04 scored four portals "stopped by the benchmark time
// cap before reaching a login" — index 0, engine's fault — when their bundles in
// data/learn-runs said momentum had logged in and walked 9 pages, smartgov 2, cloudpermit
// 8, and bsaonline had been stopped by an MFA challenge. The runs were real; the reading
// was blind, because a Promise.race discards the losing promise and with it the debugDir
// the scorer needed.
//
// The evidence is still on disk, so the honest repair is to read it again rather than to
// spend another hour driving live government portals to reproduce data we already hold.
//
//   npx tsx backend/src/rescoreBenchmark.ts [scorecard.json] [--apply]
//
// Read-only by default. Nothing here touches a portal.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { reachedReviewFromEvents, scoreLearnOutcome, summarize, type BenchmarkRow, type LearnOutcome } from "./learnBenchmark";

const RUNS_DIR = path.resolve(process.cwd(), "data", "learn-runs");
const OUT_DIR = path.resolve(process.cwd(), "data", "learn-benchmark");

type Event = { type?: string; status?: string; ok?: boolean; trace?: string };

/**
 * Find the run bundle a benchmark row produced. Bundles are named
 * `<timestamp>_benchmark-<host-slug>_<rand>`, so the host identifies which portal and the
 * timestamp identifies which attempt.
 *
 * The scorecard's `at` is when the whole sweep FINISHED, so every one of its bundles
 * predates it — the bundle wanted is the newest one at or before that moment. That also
 * distinguishes this run's attempt from an earlier day's on the same host, which is the
 * only ambiguity that matters here (two runs on 2026-09-04 both wrote momentum bundles,
 * 07:36 from the killed run and 07:41 from the baseline).
 */
export function findBundle(host: string, notAfter: string): string | null {
  // learnDebug truncates the portal-name slug to 40 chars when it builds the run id.
  const slug = `benchmark-${host.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 40);
  let best: { dir: string; id: string } | null = null;
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(RUNS_DIR); } catch { return null; }
  for (const name of dirs) {
    if (!name.includes(slug)) continue;
    const stamp = name.slice(0, 19).replace("_", "T").replace(/-(\d\d)-(\d\d)$/, ":$1:$2");
    if (notAfter && stamp > notAfter.slice(0, 19)) continue;
    if (!best || name > best.id) best = { dir: path.join(RUNS_DIR, name), id: name };
  }
  return best?.dir ?? null;
}

/** Rebuild the outcome the scorer should have been given, from what the run wrote down. */
export function outcomeFromBundle(dir: string): LearnOutcome | null {
  let events: Event[] = [];
  try {
    events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n")
      .map((l) => { try { return JSON.parse(l) as Event; } catch { return {}; } });
  } catch { return null; }

  // A finished run wrote its own verdict; prefer it over anything inferred.
  let result: Record<string, unknown> | null = null;
  try { result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")) as Record<string, unknown>; } catch { /* unfinished */ }

  const pageEvents = events.filter((e) => e.type === "page");
  // Each page event carries the walk's own trace line: `p3 "Title" [url] ... fills=2 ...`.
  const reachedReview = reachedReviewFromEvents(events, String(result?.message ?? ""));

  // STEPS ONLY COUNT IF A RECIPE WAS ACTUALLY SAVED.
  //
  // The tempting shortcut is to sum `fills=` across the page traces and call that the step
  // count. It would have promoted momentum, smartgov and cloudpermit to `recorded_steps`
  // — the rung the headline counts as "a usable recipe" — when all three were abandoned
  // mid-walk and persisted nothing. Filling a field is not the same as owning a recipe you
  // can replay tomorrow, and a benchmark that conflates them reports four usable recipes
  // where one exists.
  //
  // An unfinished run has no result.json. Its pages are real and it keeps that credit
  // (reached_form); its steps are zero, because there is no recipe.
  const steps = result ? Number((result.recipe as { steps?: unknown[] } | undefined)?.steps?.length ?? 0) : 0;
  // The walk's own per-page `fills=N` counter is the only record of substantive work a
  // bundle keeps, and it is the right one: it counts data going into the form.
  //
  // IT COUNTS ATTEMPTS, NOT WHAT SURVIVED. Momentum's traces read fills=1 on three pages
  // while the recipe it saved holds a goto and four clicks and no fill at all — the fills
  // were refused downstream (unbindable field, required-blank, policy guard) and never
  // became steps. So the run's own closing verdict vetoes the counter when it says plainly
  // that nothing was recorded. A live run scores from the persisted recipe and is always
  // the authority; this path is for reading a bundle after the fact, and it must not claim
  // more than the bundle can prove.
  const saidNothingRecorded = /no steps recorded|nothing fillable/i.test(String(result?.message ?? ""));
  const substantiveSteps = result && !saidNothingRecorded
    ? pageEvents.reduce((n, e) => n + Number(/fills=(\d+)/.exec(String(e.trace || ""))?.[1] ?? 0), 0)
    : 0;

  return {
    status: result ? String(result.status ?? "failed") : "timeout",
    pageCount: Number(result?.pageCount ?? pageEvents.length),
    steps,
    substantiveSteps,
    message: String(result?.message ?? ""),
    reachedReview,
    events,
  };
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== "--apply");
  const apply = process.argv.includes("--apply");
  const file = args[0] || path.join(OUT_DIR, "latest.json");
  const card = JSON.parse(fs.readFileSync(file, "utf8")) as { at: string; rows: BenchmarkRow[] };

  console.log(`rescoring ${path.basename(file)} (run of ${card.at}) from run bundles\n`);
  const rows: BenchmarkRow[] = [];
  let changed = 0;
  for (const row of card.rows) {
    const dir = findBundle(row.portal, card.at);
    const outcome = dir ? outcomeFromBundle(dir) : null;
    if (!outcome) {
      console.log(`  =  ${String(row.score.index)} ${row.score.rung.padEnd(20)} ${row.portal}  (no bundle — row kept as written)`);
      rows.push(row);
      continue;
    }
    const score = scoreLearnOutcome(outcome);
    const moved = score.index !== row.score.index || score.owner !== row.score.owner;
    if (moved) changed++;
    console.log(`  ${moved ? "->" : "= "} ${row.score.index}${moved ? ` becomes ${score.index}` : ""} ${score.rung.padEnd(20)} ${row.portal}`);
    if (moved) console.log(`       was: ${row.score.reason.slice(0, 100)}`);
    if (moved) console.log(`       now: ${score.reason.slice(0, 100)}`);
    rows.push({ portal: row.portal, platform: row.platform, score });
  }

  const before = summarize(card.rows);
  const after = summarize(rows);
  console.log(`\n${changed} row(s) re-read from run evidence`);
  console.log(`   usable  ${before.usableRecipes}/${before.measured} (${before.usablePct}%)  ->  ${after.usableRecipes}/${after.measured} (${after.usablePct}%)`);
  console.log(`   mean    ${before.meanIndex}  ->  ${after.meanIndex}`);

  if (!apply) { console.log(`\nDRY RUN — nothing written. Re-run with --apply.`); return; }
  // Rewrite in place and mark it, so nobody later mistakes a corrected card for a fresh run.
  const payload = { ...card, rows, summary: after, rescoredAt: new Date().toISOString(), rescoredFrom: "data/learn-runs bundles" };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  const latest = path.join(OUT_DIR, "latest.json");
  if (path.resolve(file) !== latest) fs.writeFileSync(latest, JSON.stringify(payload, null, 2));
  console.log(`\nwritten: ${file}${path.resolve(file) !== latest ? " and latest.json" : ""}`);
}

main();
