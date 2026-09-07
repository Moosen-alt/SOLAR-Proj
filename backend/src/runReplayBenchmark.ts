// Replay every complete recipe against its live portal and write a scorecard.
//
//   npm run replay:benchmark -- --dry-run          list what WOULD run, touch nothing
//   npm run replay:benchmark -- --key "pacific power"
//   npm run replay:benchmark -- --limit 1
//
// DRIVES LIVE GOVERNMENT AND UTILITY PORTALS, and unlike the learn benchmark it does so with
// a RECIPE — meaning it fills a real application form and leaves a DRAFT on the portal. It
// never submits (replay stops at the review marker by design; autoSubmit is never passed)
// and it deletes the throwaway project afterwards, but the draft it creates is the
// operator's to discard. Every run prints the portal and the project name so those drafts
// can be found and pruned.
//
// DRY RUN IS THE DEFAULT-SAFE PATH: --dry-run answers "which recipes are testable and what
// would this cost" without opening a browser.
import "dotenv/config";
process.env.SKIP_CODE_RESEARCH = "1";
process.env.AUTOPILOT_AUTO_START = "0";
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "./db";
import { createProject, deleteProject } from "./repository";
import { listPortalCredentials } from "./portalCredentials";
import { scoreReplayOutcome, summarizeReplay, type ReplayRow } from "./replayBenchmark";
import { resolveRecipeFieldValues } from "./portalRecipes";
import type { PortalRecipe, ProjectRecord } from "../../shared/src/types";

const OUT_DIR = path.resolve(process.cwd(), "data", "replay-benchmark");
const CLIENT = process.env.BENCHMARK_CLIENT_ID || "tml-international-llc";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// The project a replay fills with. Deliberately recognisable in a portal's draft list, so a
// human pruning drafts can tell a benchmark run from a real filing at a glance.
const BENCH = {
  owner: "ZZ Replay Benchmark",
  homeownerName: "ZZ Replay Benchmark",
  homeownerEmail: "permit@infinitysolarusa.com",
  homeownerPhone: "(503) 555-0142",
  street: "555 Liberty St SE", city: "Salem", state: "OR", zip: "97301",
  dcKw: "7.2", acKw: "6.4", moduleQty: "18", moduleWattage: "400",
  permitPath: "prescriptive", framingType: "rafter", roofRafterSpacing: "24",
  roofRafterSpan: "11.5", snow: "25", deadLoad: "3.0", wind: "B",
};

async function main(): Promise<void> {
  const db = await openDatabase();
  const dryRun = process.argv.includes("--dry-run");
  const keyFilter = (arg("key") || "").toLowerCase();
  const limit = Number(arg("limit") || 0);

  // Only COMPLETE recipes carrying real fills. A `needs_rerecord` row or one holding a goto
  // and two clicks tells us nothing about replay fidelity — it was never a recipe.
  const recipes = db.query<Record<string, unknown>>(
    "SELECT * FROM portal_recipes WHERE status = 'complete' ORDER BY updated_at DESC", [],
  );
  const creds = listPortalCredentials(db, CLIENT);

  const candidates = recipes
    .map((r) => {
      const steps = (() => { try { return JSON.parse(String(r.steps_json || "[]")) as Array<Record<string, unknown>>; } catch { return []; } })();
      const fills = steps.filter((s) => ["fill", "select", "check"].includes(String(s.action))).length;
      const key = String(r.profile_key || "");
      // The recipe's goto step carries the portal URL it was recorded against.
      const url = String((steps.find((s) => s.action === "goto") as { value?: unknown } | undefined)?.value || "");
      let host = ""; try { host = new URL(url).hostname.toLowerCase(); } catch { /* none */ }
      const cred = creds.find((c) => { try { return new URL(c.portalUrl).hostname.toLowerCase() === host; } catch { return false; } });
      return { row: r, key, steps: steps.length, fills, url, host, cred };
    })
    .filter((c) => c.fills >= 5)                       // a recipe that fills nothing is not one
    .filter((c) => !/benchmark/i.test(c.key))          // never the throwaway rows
    .filter((c) => !keyFilter || c.key.toLowerCase().includes(keyFilter));

  console.log(`complete recipes with >=5 fills: ${candidates.length}\n`);
  console.log("steps fills  credential      profile_key");
  for (const c of candidates) {
    const credState = !c.cred ? "NONE" : c.cred.stale ? "REFUSED" : "ok";
    console.log(`${String(c.steps).padStart(5)} ${String(c.fills).padStart(5)}  ${credState.padEnd(15)} ${c.key.slice(0, 52)}`);
  }

  // NEVER REPLAY THROUGH A LOGIN THE PORTAL HAS ALREADY REFUSED. Same rule the learn
  // benchmark follows: repeated failures against real accounts lock people out, and the
  // credential-health flag exists precisely so a sweep can decline.
  const runnable = candidates.filter((c) => c.cred && !c.cred.stale);
  const skipped = candidates.filter((c) => !c.cred || c.cred.stale);
  if (skipped.length) {
    console.log(`\nskipping ${skipped.length} (no credential, or the portal has refused it):`);
    for (const c of skipped) console.log(`   ${c.key.slice(0, 60)}`);
  }

  const chosen = limit > 0 ? runnable.slice(0, limit) : runnable;
  console.log(`\nrunnable: ${chosen.length}`);

  if (dryRun) {
    console.log(`\nDRY RUN — no browser opened, no portal touched, no draft created.`);
    console.log(`Each live run WOULD leave a draft application on its portal under the name`);
    console.log(`"${BENCH.homeownerName}" for the operator to discard.`);
    return;
  }

  console.log(`\nLIVE. Each replay fills a real form and leaves a DRAFT named "${BENCH.homeownerName}".`);
  console.log(`Replay stops at the review marker; nothing is submitted and no fee is paid.\n`);

  const { stageWithRecipe } = await import("../../portal-bot/src/index");
  const rows: ReplayRow[] = [];

  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i];
    let pid = "";
    let outcome: Record<string, unknown> = {};
    try {
      const scopeType = /powerclerk|nem|interconnect/i.test(c.key) ? "utility" : "ahj";
      pid = createProject(db, { ...BENCH, ahj: "Salem", utility: "Pacific Power", clientId: CLIENT } as never).project.id;
      const project = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [pid]) as unknown as ProjectRecord;
      const recipe = { ...(c.row as unknown as PortalRecipe), steps: JSON.parse(String(c.row.steps_json || "[]")) };
      const fieldValues = resolveRecipeFieldValues(db, project, scopeType === "utility" ? "utility" : "AHJ");
      const res = await stageWithRecipe(recipe, project, fieldValues, {}, [], { headless: true });
      outcome = { ...res, recorded: c.steps };
    } catch (e) {
      outcome = { ok: false, message: String((e as Error)?.message || e), recorded: c.steps };
    } finally {
      if (pid) { try { deleteProject(db, pid); } catch { /* leave it */ } }
    }

    const score = scoreReplayOutcome(outcome as never);
    rows.push({ portal: c.host || c.key, profileKey: c.key, score });
    console.log(`${String(i + 1).padStart(2)}/${chosen.length} ${score.index} ${score.rung.padEnd(20)} ${c.key.slice(0, 44)}`);
    console.log(`      ${score.reason.slice(0, 160)}`);
  }

  const summary = summarizeReplay(rows);
  console.log(`\n================ REPLAY SCORECARD ================`);
  console.log(`recipes              : ${summary.total}`);
  console.log(`measured             : ${summary.measured}${summary.notMeasured ? `   (${summary.notMeasured} NOT measured — harness aborted)` : ""}`);
  console.log(`SUBMITTABLE          : ${summary.submittable}  (${summary.submittablePct}% of measured)`);
  console.log(`   — ran clean AND the review screen matched the project`);
  console.log(`mean rung (0-5)      : ${summary.meanIndex}`);
  console.log(`\nby rung:`);
  for (const [rung, n] of Object.entries(summary.byRung)) if (n) console.log(`   ${String(n).padStart(3)}  ${rung}`);
  console.log(`\nwho can act:`);
  for (const [owner, n] of Object.entries(summary.byOwner)) console.log(`   ${String(n).padStart(3)}  ${owner}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}.json`), JSON.stringify({ at: new Date().toISOString(), summary, rows }, null, 2));
  console.log(`\nscorecard written to ${path.join(OUT_DIR, `${stamp}.json`)}`);
  console.log(`\nDRAFTS TO DISCARD: one per portal above, named "${BENCH.homeownerName}".`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
