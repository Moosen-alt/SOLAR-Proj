// Run the learn benchmark against real portals and write a scorecard.
//
//   npm run learn:benchmark                  -- every portal with a stored credential
//   npm run learn:benchmark -- --limit 6     -- the first 6
//   npm run learn:benchmark -- --host opengov,smartgov
//   npm run learn:benchmark -- --concurrency 3 --portal-timeout 420
//   npm run learn:benchmark -- --include-stale      (default: SKIPPED, see below)
//
// DRIVES LIVE GOVERNMENT PORTALS. It logs in with stored credentials and walks application
// forms; it never submits (the learn stops at review by design), and it deletes the
// throwaway project it creates for each portal. Not wired into any test chain.
import "dotenv/config";
// A benchmark measures the PORTAL, not the jurisdiction. Without this every throwaway
// project would enqueue code research for a city nobody is filing in.
process.env.SKIP_CODE_RESEARCH = "1";
process.env.AUTOPILOT_AUTO_START = "0";
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "./db";
import { createProject, deleteProject } from "./repository";
import { autoLearnPortal } from "./autoLearn";
import { listPortalCredentials, listStaleCredentials } from "./portalCredentials";
import { reachedReviewFromEvents, scoreLearnOutcome, summarize, compareRuns, type BenchmarkRow } from "./learnBenchmark";

const OUT_DIR = path.resolve(process.cwd(), "data", "learn-benchmark");
// The learn stops itself at budgetMs; the walk checks its deadline BETWEEN pages, so a run
// legitimately overruns by the length of its last page (uploads and slow postbacks can be a
// couple of minutes). This slack keeps the outer backstop from firing on an orderly finish —
// when it does fire, the run really is wedged.
const BACKSTOP_SLACK_MS = 180_000;
const CLIENT = process.env.BENCHMARK_CLIENT_ID || "tml-international-llc";

// LEARN, RE-RUN, VERIFY — IN ONE COMMAND. --self-test replays each freshly learned recipe in
// a fresh session and refuses to call it trusted unless it reproduces. It costs a second pass
// over the portal and leaves a second draft, which is why it is opt-in; it is also the only
// thing that answers "can the bot actually re-run what it just learned", and the first time
// it was run by hand the answer was no.
if (process.argv.includes("--self-test")) process.env.PORTAL_REPLAY_SELFTEST = "1";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// A plausible local address per state keeps the run about the ENGINE rather than about
// address validation. It is still a throwaway project, deleted after each portal.
const CITY_BY_STATE: Record<string, { city: string; zip: string; street: string; utility: string }> = {
  OR: { city: "Salem", zip: "97301", street: "555 Liberty St SE", utility: "Portland General Electric" },
  WA: { city: "Everett", zip: "98201", street: "2930 Wetmore Ave", utility: "Puget Sound Energy" },
  CA: { city: "Sacramento", zip: "95814", street: "915 I St", utility: "SMUD" },
  AZ: { city: "Phoenix", zip: "85003", street: "200 W Washington St", utility: "APS" },
  FL: { city: "Orlando", zip: "32801", street: "400 S Orange Ave", utility: "Duke Energy Florida" },
  MD: { city: "Largo", zip: "20774", street: "9400 Peppercorn Pl", utility: "Pepco" },
  MA: { city: "Everett", zip: "02149", street: "484 Broadway", utility: "Eversource" },
  OH: { city: "Columbus", zip: "43215", street: "90 W Broad St", utility: "AEP Ohio" },
  MI: { city: "Grand Rapids", zip: "49503", street: "300 Monroe Ave NW", utility: "Consumers Energy" },
  TX: { city: "Canton", zip: "75103", street: "119 N Buffalo St", utility: "Oncor" },
  IL: { city: "Springfield", zip: "62701", street: "800 E Monroe St", utility: "Ameren Illinois" },
  ID: { city: "Boise", zip: "83702", street: "150 N Capitol Blvd", utility: "Idaho Power" },
  NM: { city: "Las Cruces", zip: "88001", street: "700 N Main St", utility: "El Paso Electric" },
  NY: { city: "Buffalo", zip: "14202", street: "65 Niagara Sq", utility: "National Grid" },
  CT: { city: "Hartford", zip: "06103", street: "550 Main St", utility: "Eversource" },
  PA: { city: "Pittsburgh", zip: "15219", street: "414 Grant St", utility: "Duquesne Light" },
  ME: { city: "Portland", zip: "04101", street: "389 Congress St", utility: "Central Maine Power" },
};

async function main(): Promise<void> {
  const db = await openDatabase();
  const limit = Number(arg("limit") || 0);
  const hostFilter = (arg("host") || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  // SEQUENTIAL BY DEFAULT. Learns serialise on a per-recipe lease and share a browser-profile
  // queue, so parallelism mostly buys portals waiting in line — and the wall-clock cap counts
  // that waiting, which turned five portals into "timed out" when they had barely started.
  // The measurement is worth more than the wall clock.
  const concurrency = Math.max(1, Math.min(4, Number(arg("concurrency") || 1)));
  // One portal must not be able to eat an hour. Momentum ran 19 minutes and Accela 18 before
  // giving up, and a full sweep of 70 at that rate is a day. A capped portal scores on what
  // it reached, which is exactly what the ladder is for.
  const portalTimeoutMs = Math.max(60, Number(arg("portal-timeout") || 480)) * 1000;
  // NEVER RE-TRY A LOGIN THE PORTAL HAS ALREADY REFUSED, unless asked. Seventy portals means
  // seventy login attempts, and the ones we know are stale would be attempts against real
  // accounts this business depends on — repeated failures lock people out. The credential
  // health flag exists precisely so the benchmark can decline to bang on a locked door.
  const includeStale = process.argv.includes("--include-stale");

  const seen = new Set<string>();
  const targets = listPortalCredentials(db, CLIENT)
    .map((c) => {
      let host = "";
      try { host = new URL(c.portalUrl).hostname.toLowerCase(); } catch { return null; }
      const type = String(c.portalType || "");
      const state = type.includes("·") ? type.split("·")[0].trim().toUpperCase() : "";
      const platform = type.includes("·") ? type.split("·")[1].trim() : type;
      return { host, url: c.portalUrl, platform, state, stale: c.stale };
    })
    .filter((t): t is NonNullable<typeof t> => !!t)
    .filter((t) => !seen.has(t.host) && seen.add(t.host))
    .filter((t) => !hostFilter.length || hostFilter.some((h) => t.host.includes(h) || t.platform.toLowerCase().includes(h)))
    .filter((t) => CITY_BY_STATE[t.state])
    .filter((t) => includeStale || !t.stale);

  const chosen = limit > 0 ? targets.slice(0, limit) : targets;
  console.log(`learn benchmark: ${chosen.length} portal(s)\n`);

  const rows: BenchmarkRow[] = [];
  let cursor = 0;
  const runOne = async (t: typeof chosen[number], i: number): Promise<void> => {
    const loc = CITY_BY_STATE[t.state];
    let pid = "";
    let outcome: Record<string, unknown> = {};
    try {
      const created = createProject(db, {
        owner: `Benchmark ${loc.city}`, homeownerName: `Benchmark ${loc.city}`,
        homeownerEmail: "permit@infinitysolarusa.com", homeownerPhone: "(503) 555-0142",
        street: loc.street, city: loc.city, state: t.state, zip: loc.zip,
        // A SYNTHETIC JURISDICTION PER PORTAL, AND NEVER A REAL ONE.
        //
        // Recipes are keyed on (scope, state, ahj, utility). Naming the benchmark project
        // after a real city did two bad things at once. Portals sharing a state computed the
        // SAME key, so the concurrent-learn lease refused four of twelve outright and the
        // rest would have overwritten each other's recipe run sequentially. And far worse, a
        // benchmark project called "City of Salem" on PGE keys to the same row a real Salem
        // filing uses — a measurement run could quietly clobber a production recipe.
        //
        // The host is unique and unmistakably not a jurisdiction, so each portal gets its own
        // isolated row and nothing the benchmark writes can collide with real work.
        ahj: `Benchmark ${t.host}`, utility: loc.utility, clientId: CLIENT,
        dcKw: "7.2", acKw: "6.4", moduleQty: "18", moduleWattage: "400",
        permitPath: "prescriptive", framingType: "rafter", roofRafterSpacing: "24",
        roofRafterSpan: "11.5", snow: "25", deadLoad: "3.0", wind: "B",
      } as never).project.id;
      pid = created;
      const started = Date.now();
      // THE CAP IS INSIDE THE RUN, NOT AROUND IT.
      //
      // This used to be a bare Promise.race, and a race only stops the WAITING. The learn
      // walked on: capped at 400s, momentum ran 1220s — straight through the next two
      // portals' turns, holding a browser profile and spending LLM calls where nothing was
      // watching. All three then "timed out". One abandoned run cost three measurements,
      // and the scorecard blamed the portals.
      //
      // budgetMs lets the walk end itself, so a capped portal still returns a real result:
      // pages, steps and debug bundle intact, scored on what it actually reached. The race
      // survives only as a backstop with slack — if it ever fires now, the run is wedged,
      // which is a harness abort and is scored as "not measured" rather than as a verdict.
      const res = await Promise.race([
        autoLearnPortal(db, pid, {
          scope: "ahj", portalUrl: t.url, createdBy: "learn-benchmark",
          permitType: "electrical", headless: true, budgetMs: portalTimeoutMs,
          // The operator has authorised accepting a cookie banner that offers nothing else.
          // Declining is still tried first, every time; this governs only the residual, and
          // it never applies to a CAPTCHA.
          allowConsentAccept: true,
        }).catch((e: unknown) => ({ status: "threw", message: String((e as Error)?.message || e) })),
        new Promise((resolve) => setTimeout(
          () => resolve({ status: "timeout", message: `benchmark backstop: the learn was still running ${Math.round((portalTimeoutMs + BACKSTOP_SLACK_MS) / 1000)}s after start — target closed, treat as wedged` }),
          portalTimeoutMs + BACKSTOP_SLACK_MS,
        )),
      ]);
      const r = res as Record<string, unknown>;
      // Read the run's own event log — it beats the summary prose for scoring.
      let events: Array<{ type?: string; status?: string; ok?: boolean; trace?: string }> = [];
      const dir = String(r.debugDir || "");
      if (dir) {
        try {
          events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n")
            .map((l) => { try { return JSON.parse(l); } catch { return {}; } });
        } catch { /* bundle optional */ }
      }
      const recipeSteps = ((r.recipe as { steps?: unknown[] } | undefined)?.steps ?? []) as unknown[];
      outcome = {
        status: r.status, pageCount: r.pageCount, message: r.message,
        steps: recipeSteps.length,
        // fill/select/check only — a goto and four clicks is navigation, not a recipe.
        // Same rule autoLearn's trust gate uses, so the benchmark and the promotion
        // decision cannot disagree about what a recipe is.
        substantiveSteps: recipeSteps.filter((st) => {
          const a = String((st as { action?: unknown }).action ?? "");
          return a === "fill" || a === "select" || a === "check";
        }).length,
        // The run's own page trace, not a regex over the closing prose — see
        // reachedReviewFromEvents. These two readings disagreed and the benchmark reported
        // the difference as a regression.
        reachedReview: reachedReviewFromEvents(events, String(r.message || "")),
        // Carried so the scorecard row can hold it — see BenchmarkRow.pageTrace.
        pageTrace: r.pageTrace ?? [],
        events, seconds: Math.round((Date.now() - started) / 1000),
      };
    } catch (e) {
      outcome = { status: "setup-error", message: String((e as Error).message) };
    } finally {
      if (pid) { try { deleteProject(db, pid); } catch { /* leave it */ } }
    }

    const score = scoreLearnOutcome(outcome);
    // THE TRACE GOES IN THE ROW. A scorecard that records the verdict and not the evidence
    // sends the next session back to the portals to re-learn what this run already saw.
    rows.push({
      portal: t.host, platform: t.platform, score,
      pageTrace: ((outcome as { pageTrace?: string[] }).pageTrace ?? []).slice(0, 40),
      pages: Number((outcome as { pageCount?: number }).pageCount ?? 0),
      fills: Number((outcome as { substantiveSteps?: number }).substantiveSteps ?? 0),
    });
    console.log(`${String(i + 1).padStart(2)}/${chosen.length} ${score.index} ${score.rung.padEnd(20)} ${t.host}`);
    console.log(`      ${score.reason.slice(0, 150)}`);
  };

  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= chosen.length) break;
      await runOne(chosen[i], i);
    }
  }));

  const summary = summarize(rows);
  console.log(`\n================ SCORECARD ================`);
  console.log(`portals              : ${summary.total}`);
  // Say the sample size out loud. A run that was interrupted, or whose portals were
  // refused by the concurrency lease, has a headline computed over fewer portals than
  // it attempted — and a percentage that hides that is worse than no percentage.
  console.log(`measured             : ${summary.measured}${summary.notMeasured ? `   (${summary.notMeasured} NOT measured — harness aborted, excluded from the figures below)` : ""}`);
  console.log(`usable recipes       : ${summary.usableRecipes}  (${summary.usablePct}% of measured)`);
  console.log(`mean rung (0-6)      : ${summary.meanIndex}`);
  // TWO NUMBERS, BECAUSE THERE ARE TWO PROBLEMS AND DIFFERENT PEOPLE FIX THEM.
  console.log(`\nACCESS (ops owns this) : ${summary.accessReached}/${summary.measured} = ${summary.accessPct}% of portals we could authenticate into`);
  for (const [why, n] of Object.entries(summary.accessBlockers).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(3)}  ${why}`);
  }
  console.log(`\nAUTOMATION (engineering owns this), of the ${summary.accessReached} we got into:`);
  console.log(`   usable recipe  : ${summary.usableGivenAccess}/${summary.accessReached} = ${summary.usableGivenAccessPct}%`);
  console.log(`   reached REVIEW : ${summary.reviewReached}/${summary.accessReached} = ${summary.reviewGivenAccessPct}%   <- the product's own bar`);
  console.log(`\nby rung:`);
  for (const [rung, n] of Object.entries(summary.byRung)) if (n) console.log(`   ${String(n).padStart(3)}  ${rung}`);
  console.log(`\nwho can act:`);
  for (const [owner, n] of Object.entries(summary.byOwner)) console.log(`   ${String(n).padStart(3)}  ${owner}`);

  // CREDENTIALS NEEDING A HUMAN — THE LIST THIS TOOL HAS ALWAYS COMPUTED AND NEVER SHOWN.
  //
  // A refused credential sets a stale flag, and the sweep HONOURS that flag by skipping the
  // portal — correctly, so it does not bang on a locked door. The consequence nobody sees is
  // that the portal then leaves the fleet permanently: it is not learned, not measured, and
  // not reported. Nine rows are in that state today and access cannot rise past 73.7% until
  // a person edits them.
  //
  // So the run ends by naming them, with the portal's OWN wording. "password expired",
  // "account locked" and "user not found" need three different human actions, and one bucket
  // called "credential refused" hides which is which.
  {
    const needsHuman = listStaleCredentials(db, CLIENT);
    if (needsHuman.length) {
      console.log(`\nCREDENTIALS NEEDING A HUMAN (${needsHuman.length}) — these portals are SKIPPED until fixed:`);
      for (const c of needsHuman) {
        let host = c.portalUrl;
        try { host = new URL(c.portalUrl).hostname; } catch { /* keep the raw string */ }
        const lastOk = c.lastLoginOkAt ? String(c.lastLoginOkAt).slice(0, 10) : "never";
        console.log(`   ${host.slice(0, 44).padEnd(46)} user=${String(c.usernameReference ?? "?").slice(0, 24).padEnd(26)} lastOK=${lastOk}`);
        console.log(`      portal said: ${String(c.lastLoginNote ?? "(nothing recorded)").slice(0, 110)}`);
      }
      console.log(`   Fix these and re-run a single host to clear the flag: npm run learn:benchmark -- --host <host>`);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const payload = { at: new Date().toISOString(), summary, rows };
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}.json`), JSON.stringify(payload, null, 2));

  // A FILTERED RUN IS A DIAGNOSTIC, NOT A BASELINE.
  //
  // latest.json is what the next sweep compares against, and --host is how one portal gets
  // re-run while chasing one bug. Re-running Wilsonville alone to read its reveal trail
  // overwrote an eleven-portal baseline with a one-row card. The next sweep would then have
  // found every other portal "absent from the previous run" and reported no regression it
  // could possibly have caught.
  //
  // The timestamped card is written either way, so no measurement is lost. Only the
  // BASELINE pointer is reserved for a run that measured everything it was offered.
  const isDiagnostic = hostFilter.length > 0 || limit > 0;
  const latestPath = path.join(OUT_DIR, "latest.json");
  if (!isDiagnostic && fs.existsSync(latestPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(latestPath, "utf8")) as { rows: BenchmarkRow[] };
      const diff = compareRuns(prev.rows || [], rows);
      console.log(`\nvs previous run: ${diff.improved.length} improved, ${diff.regressed.length} REGRESSED, ${diff.unchanged} unchanged`);
      for (const r of diff.regressed) console.log(`   REGRESSED  ${r.portal}: ${r.from} -> ${r.to}`);
      for (const r of diff.improved) console.log(`   improved   ${r.portal}: ${r.from} -> ${r.to}`);
    } catch { /* first comparable run */ }
  }
  if (isDiagnostic) {
    console.log(`\nfiltered run (${chosen.length} portal(s)) — latest.json left alone so the baseline survives.`);
  } else {
    fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2));
  }
  console.log(`\nscorecard written to ${path.join(OUT_DIR, `${stamp}.json`)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
