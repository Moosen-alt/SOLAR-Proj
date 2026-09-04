// Run the learn benchmark against real portals and write a scorecard.
//
//   npm run learn:benchmark                  -- every portal with a stored credential
//   npm run learn:benchmark -- --limit 6     -- the first 6
//   npm run learn:benchmark -- --host opengov,smartgov
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
import { listPortalCredentials } from "./portalCredentials";
import { scoreLearnOutcome, summarize, compareRuns, type BenchmarkRow } from "./learnBenchmark";

const OUT_DIR = path.resolve(process.cwd(), "data", "learn-benchmark");
const CLIENT = process.env.BENCHMARK_CLIENT_ID || "tml-international-llc";

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
    .filter((t) => CITY_BY_STATE[t.state]);

  const chosen = limit > 0 ? targets.slice(0, limit) : targets;
  console.log(`learn benchmark: ${chosen.length} portal(s)\n`);

  const rows: BenchmarkRow[] = [];
  for (const [i, t] of chosen.entries()) {
    const loc = CITY_BY_STATE[t.state];
    let pid = "";
    let outcome: Record<string, unknown> = {};
    try {
      const created = createProject(db, {
        owner: `Benchmark ${loc.city}`, homeownerName: `Benchmark ${loc.city}`,
        homeownerEmail: "permit@infinitysolarusa.com", homeownerPhone: "(503) 555-0142",
        street: loc.street, city: loc.city, state: t.state, zip: loc.zip,
        ahj: `City of ${loc.city}`, utility: loc.utility, clientId: CLIENT,
        dcKw: "7.2", acKw: "6.4", moduleQty: "18", moduleWattage: "400",
        permitPath: "prescriptive", framingType: "rafter", roofRafterSpacing: "24",
        roofRafterSpan: "11.5", snow: "25", deadLoad: "3.0", wind: "B",
      } as never).project.id;
      pid = created;
      const started = Date.now();
      const res = await autoLearnPortal(db, pid, {
        scope: "ahj", portalUrl: t.url, createdBy: "learn-benchmark",
        permitType: "electrical", headless: true,
      }).catch((e: unknown) => ({ status: "threw", message: String((e as Error)?.message || e) }));
      const r = res as Record<string, unknown>;
      // Read the run's own event log — it beats the summary prose for scoring.
      let events: Array<{ type?: string; status?: string; ok?: boolean }> = [];
      const dir = String(r.debugDir || "");
      if (dir) {
        try {
          events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n")
            .map((l) => { try { return JSON.parse(l); } catch { return {}; } });
        } catch { /* bundle optional */ }
      }
      outcome = {
        status: r.status, pageCount: r.pageCount, message: r.message,
        steps: (r.recipe as { steps?: unknown[] } | undefined)?.steps?.length ?? 0,
        reachedReview: /reached (the )?review|awaiting human/i.test(String(r.message || "")),
        events, seconds: Math.round((Date.now() - started) / 1000),
      };
    } catch (e) {
      outcome = { status: "setup-error", message: String((e as Error).message) };
    } finally {
      if (pid) { try { deleteProject(db, pid); } catch { /* leave it */ } }
    }

    const score = scoreLearnOutcome(outcome);
    rows.push({ portal: t.host, platform: t.platform, score });
    console.log(`${String(i + 1).padStart(2)}/${chosen.length} ${score.index} ${score.rung.padEnd(20)} ${t.host}`);
    console.log(`      ${score.reason.slice(0, 150)}`);
  }

  const summary = summarize(rows);
  console.log(`\n================ SCORECARD ================`);
  console.log(`portals              : ${summary.total}`);
  console.log(`usable recipes       : ${summary.usableRecipes}  (${summary.usablePct}%)`);
  console.log(`mean rung (0-6)      : ${summary.meanIndex}`);
  console.log(`\nby rung:`);
  for (const [rung, n] of Object.entries(summary.byRung)) if (n) console.log(`   ${String(n).padStart(3)}  ${rung}`);
  console.log(`\nwho can act:`);
  for (const [owner, n] of Object.entries(summary.byOwner)) console.log(`   ${String(n).padStart(3)}  ${owner}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const payload = { at: new Date().toISOString(), summary, rows };
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}.json`), JSON.stringify(payload, null, 2));

  const latestPath = path.join(OUT_DIR, "latest.json");
  if (fs.existsSync(latestPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(latestPath, "utf8")) as { rows: BenchmarkRow[] };
      const diff = compareRuns(prev.rows || [], rows);
      console.log(`\nvs previous run: ${diff.improved.length} improved, ${diff.regressed.length} REGRESSED, ${diff.unchanged} unchanged`);
      for (const r of diff.regressed) console.log(`   REGRESSED  ${r.portal}: ${r.from} -> ${r.to}`);
      for (const r of diff.improved) console.log(`   improved   ${r.portal}: ${r.from} -> ${r.to}`);
    } catch { /* first comparable run */ }
  }
  fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2));
  console.log(`\nscorecard written to ${path.join(OUT_DIR, `${stamp}.json`)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
