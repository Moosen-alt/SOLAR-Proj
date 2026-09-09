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
import { reachedReviewFromEvents, scoreLearnOutcome, summarize, compareRuns, compareDepth, markUnreachableBursts, isMeasured, type BenchmarkRow } from "./learnBenchmark";

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
// ...EXCEPT WHERE THE PORTAL VALIDATES THE ADDRESS AGAINST ITS OWN PARCEL DATABASE, WHICH
// MOST PERMIT PORTALS DO. A state-level address is not local enough for those: it is filed
// in the wrong city and the portal correctly finds nothing.
//
// Measured on City of Miami's iBuild portal. The FL fixture is "400 S Orange Ave, Orlando" —
// 200 miles from Miami — so the property search ran on "Orange", returned no rows, and the
// walk re-planned that same page seven times until the budget died. The row read "recorded
// steps, never reached review" and looked like an engine defect; the engine did exactly the
// right thing with an address that cannot exist there.
//
// The REPLAY benchmark already learned this lesson and keys its addresses per AHJ. This is
// the same idea for learn, by portal host: a real parcel in the jurisdiction that portal
// actually serves. Anything not listed falls back to the state address, which is fine for a
// portal that does not check.
const ADDRESS_BY_HOST: Record<string, { city: string; zip: string; street: string }> = {
  // Miami City Hall — a real, unmistakable City of Miami parcel.
  "apps.miami.gov": { city: "Miami", zip: "33133", street: "3500 Pan American Dr" },
};

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

  const picked = limit > 0 ? targets.slice(0, limit) : targets;
  // POINT-AND-SHOOT RELIABILITY IS A RATE, AND A RATE NEEDS TRIALS.
  //
  // "Does it work on portal X" has been answered one run at a time all session, and three
  // separate fixes that looked right on one portal degraded another - a single run cannot
  // tell a fix from a coin flip. --repeat N runs each portal N times, ROUND-ROBIN so a
  // portal's attempts spread across the sweep instead of sampling one four-minute window
  // (the discipline the replay benchmark already uses), and reports per-portal k/N
  // worst-first. An operator does not meet the fleet; they meet one portal.
  const repeat = Math.max(1, Math.min(10, Number(arg("repeat") || 1)));
  const chosen = repeat > 1 ? Array.from({ length: repeat }, () => picked).flat() : picked;
  console.log(`learn benchmark: ${picked.length} portal(s)${repeat > 1 ? ` x ${repeat} attempts = ${chosen.length} runs` : ""}\n`);

  const rows: BenchmarkRow[] = [];
  let cursor = 0;
  const runOne = async (t: typeof chosen[number], i: number): Promise<void> => {
    // Per-host first (a portal that checks its parcel database needs a parcel IT has), then
    // the state default. Utility comes from the state either way.
    const stateLoc = CITY_BY_STATE[t.state];
    const hostLoc = ADDRESS_BY_HOST[String(t.host || "").toLowerCase()];
    const loc = hostLoc ? { ...stateLoc, ...hostLoc } : stateLoc;
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
        dcKw: "7.2", acKw: "5.22", moduleQty: "18", moduleWattage: "400",
        // REAL EQUIPMENT, OR THE EQUIPMENT FIELDS ARE NEVER TESTED.
        //
        // The whole payload becomes the project's parserSnapshot, and
        // resolveRecipeFieldValues emits equipment keys ONLY for values the project has. A
        // benchmark project with no equipment therefore produces no inverterMake /
        // inverterModel / inverterQty — so every portal's equipment dropdowns came back
        // blank and the scorecard could not tell "the engine cannot fill these" from "there
        // was nothing to fill". Ameren's review screen listed four of them as required and
        // empty on seven consecutive runs.
        //
        // A real, CEC-listed pairing, internally consistent with the sizes above: 18 x 400 W
        // modules is 7.2 kW DC, 18 microinverters at 290 W AC is 5.22 kW AC (a 1.38 DC:AC
        // ratio, which is ordinary residential). Certified names differ from plan-set names,
        // which is exactly what EQUIPMENT_MAKE_ALIASES and certifiedModelFor exist to bridge
        // — so the fixture uses the names a plan set would carry, not the portal's.
        inverterManufacturer: "Enphase", inverterModel: "IQ8PLUS-72-2-US",
        inverterQuantity: "18", inverterWattage: "290",
        moduleManufacturer: "Q CELLS", moduleModel: "Q.PEAK DUO BLK ML-G10+ 400",
        mountType: "roof", racking: "IronRidge XR100", tilt: "22", azimuth: "180",
        mainServiceRating: "200", hasBattery: "No",
        pvArrays: [{
          quantity: 18, moduleManufacturer: "Q CELLS", moduleModel: "Q.PEAK DUO BLK ML-G10+ 400",
          moduleWattage: 400, tilt: 22, azimuth: 180,
        }],
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
        // …and what the run's own verifier made of that page. accurate===false is the only
        // reading taken: the verifier is deliberately conservative, and a review it calls
        // inaccurate is not a review this benchmark should count as the goal reached.
        reviewContradicted: (r.verification as { accurate?: unknown } | undefined)?.accurate === false,
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

  // A RUN OF UNREACHABLE VERDICTS IS A STATEMENT ABOUT THE RUNNER. Applied before the
  // summary so the headline never counts a machine failure as dead hosts — see
  // markUnreachableBursts for the sweep that made this necessary.
  const burstMarked = markUnreachableBursts(rows);
  if (burstMarked > 0) {
    console.log(`
⚠ ${burstMarked} row(s) reported no response back-to-back and were marked NOT MEASURED — that is the runner (browser launch, network, or disk), not that many portals. Re-run them once the machine is healthy.`);
  }
  // PER-PORTAL k/N, WORST FIRST. The fleet average is not what an operator experiences.
  if (repeat > 1) {
    const byPortal = new Map<string, BenchmarkRow[]>();
    for (const r of rows) {
      if (!isMeasured(r.score)) continue;
      const list = byPortal.get(r.portal) ?? [];
      list.push(r);
      byPortal.set(r.portal, list);
    }
    const rates = Array.from(byPortal.entries())
      .map(([portal, rs]) => ({
        portal,
        n: rs.length,
        review: rs.filter((r) => r.score.rung === "reached_review").length,
        usable: rs.filter((r) => r.score.index >= 5).length,
      }))
      .map((r) => ({ ...r, pct: r.n ? (r.review / r.n) * 100 : 0 }))
      .sort((a, b) => a.pct - b.pct);
    console.log(`\nPER-PORTAL RELIABILITY over ${repeat} attempts - worst first`);
    console.log(`   (reached review / measured attempts; "usable" = recorded a recipe)`);
    for (const r of rates) {
      console.log(`   ${String(Math.round(r.pct)).padStart(3)}%  review ${r.review}/${r.n}   usable ${r.usable}/${r.n}   ${r.portal}`);
    }
    const totalN = rates.reduce((a, r) => a + r.n, 0);
    const totalReview = rates.reduce((a, r) => a + r.review, 0);
    console.log(`   ---- ${totalN ? Math.round((totalReview / totalN) * 100) : 0}% overall (${totalReview}/${totalN} measured attempts reached review)`);
  }
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
      // AND HOW FAR THROUGH THE FORM, not just which rung. Six portals walked further on
      // 2026-09-09 and every one of them was reported as "unchanged" because the ladder has
      // no rung between "recorded steps" and "reached review".
      const depth = compareDepth(prev.rows || [], rows);
      console.log(`
depth: ${depth.deeper.length} deeper, ${depth.shallower.length} shallower  (fleet ${depth.pageDelta >= 0 ? "+" : ""}${depth.pageDelta} page(s), ${depth.fillDelta >= 0 ? "+" : ""}${depth.fillDelta} field(s) filled)`);
      for (const d of depth.deeper) console.log(`   deeper     ${d.portal}: ${d.pages[0]}->${d.pages[1]} page(s), ${d.fills[0]}->${d.fills[1]} field(s)`);
      for (const d of depth.shallower) console.log(`   SHALLOWER  ${d.portal}: ${d.pages[0]}->${d.pages[1]} page(s), ${d.fills[0]}->${d.fills[1]} field(s)`);
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
