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
import { getDecryptedCredential, getDecryptedCredentialAny, getDecryptedCredentialByUrl, listPortalCredentials } from "./portalCredentials";
import { mergeStepReport, scoreReplayOutcome, summarizeReplay, type ReplayRow } from "./replayBenchmark";
import { getPortalRecipe, resolveRecipeFieldValues } from "./portalRecipes";
import type { ProjectRecord } from "../../shared/src/types";

const OUT_DIR = path.resolve(process.cwd(), "data", "replay-benchmark");
const CLIENT = process.env.BENCHMARK_CLIENT_ID || "tml-international-llc";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// The project a replay fills with. Deliberately recognisable in a portal's draft list, so a
// human pruning drafts can tell a benchmark run from a real filing at a glance.
// THE FIXTURE'S VALUES ARE THE EVIDENCE — so they must not be findable by accident.
//
// verified_accurate requires three project values CONFIRMED on the review screen, and that
// bar is only as strong as the needles. The first draft of this fixture defeated it four
// ways at once: "ZZ" is two characters, so the name check silently never ran; the street
// number 555 also appears in the phone, so the address "confirmed" against the phone; and
// an account and meter of all zeroes reduce to "0000", which turns up in any run of digits
// on the page. Three confirmations, none of them real.
const BENCH = {
  owner: "ZZTest Replay Benchmark",
  // Still sorts under ZZ in a portal's draft list, still obviously a benchmark — and now
  // long enough that the name check actually runs, with a needle nothing else supplies.
  homeownerName: "ZZTest Replay Benchmark",
  homeownerEmail: "permit@infinitysolarusa.com",
  homeownerPhone: "(503) 555-0142",
  // A street number that does not collide with the phone's 555.
  street: "1847 Liberty St SE", city: "Salem", state: "OR", zip: "97301",
  dcKw: "7.2", acKw: "6.4", moduleQty: "18", moduleWattage: "400",
  permitPath: "prescriptive", framingType: "rafter", roofRafterSpacing: "24",
  roofRafterSpan: "11.5", snow: "25", deadLoad: "3.0", wind: "B",

  // A THIN FIXTURE MEASURES THE FIXTURE, NOT THE RECIPE.
  //
  // The first honest run scored `replayed_with_gaps` with EIGHT skipped steps and zero
  // recipe failures: every one was a value this project did not carry. An interconnection
  // form asks for the utility account and meter, the export capacity, and the electrical
  // service — none of which a bare address and a kW figure supply — so the equipment page
  // could not complete, Calculate had nothing to total, and the portal flagged the array
  // rows. The recipe was blameless and the benchmark could not have reached its top rung
  // no matter how good the recipe was.
  //
  // These are DELIBERATELY OBVIOUS FAKES on a draft named "ZZ Replay Benchmark" that is
  // never submitted. `account`/`meter` are the payload keys normalizeProject reads, and the
  // whole payload becomes the design snapshot, which is where `phase` and `voltage` are
  // looked up from.
  // Distinctive digits, not runs of zeroes — see the note above the fixture.
  account: "84739218 306 4", meter: "ZZ84920175", exportKw: "6.4",
  phase: "Single Phase", voltage: "240",
  energySource: "Solar", generationTechnology: "Photovoltaic",

  // REAL, CEC-LISTED EQUIPMENT — not invented strings. A utility portal builds its
  // manufacturer and model dropdowns from the same CEC list this database mirrors, so a
  // made-up model would be a select that can never land, and the benchmark would be
  // measuring its own fixture again. These are looked up from `cec_equipment` and resolve
  // through certifiedModelFields the way a real project's do.
  // EXACT KEYS, NOT ALIASES. The snapshot is read by exact key (`snapshotFlat[k]`), so the
  // alias names in the field-hint map do not stand in for one another: a run carrying only
  // `inverterMake` left the recipe's `inverterManufacturer` step with nothing to select, and
  // the portal then flagged the array row it was never given. Both spellings, deliberately.
  moduleMake: "Qcells North America", moduleManufacturer: "Qcells North America",
  moduleModel: "Q.PEAK DUO BLK ML-G10 400",
  inverterMake: "Enphase Energy, Inc.", inverterManufacturer: "Enphase Energy, Inc.",
  inverterModel: "IQ8PLUS-72-2-US {240V}",
  inverterQuantity: "1", inverterQty: "1",
  array1ModuleQuantity: "18",
  tilt: "22", azimuth: "180",
  // "Installation Voltage" binds `voltage`; "Electrical SERVICE Voltage" binds
  // `serviceVoltage` — the two are told apart by the extra token, which is exactly what the
  // tiebreak in portalRecipes describes. Supplying only `voltage` left the second one blank.
  serviceVoltage: "240",

  // NOT FAKED: the one-line drawing and site plan. Those steps will keep reporting "no
  // value in the project", and that is the right outcome — uploading junk documents to a
  // live utility portal is worse than leaving a draft incomplete. Document upload is
  // therefore the one part of a filing this benchmark does not measure; the scorer already
  // attributes it to data rather than to the recipe.
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
      // createProject RETURNS the mapped ProjectRecord. Re-reading the row with raw SQL
      // handed the adapter snake_case columns — the same mistake as the recipe below, made
      // twice in one function. mapProject is not exported, so the returned object IS the
      // accessor.
      const created = createProject(db, { ...BENCH, ahj: "Salem", utility: "Pacific Power", clientId: CLIENT } as never);
      pid = created.project.id;
      const project = created.project as unknown as ProjectRecord;
      // USE THE ACCESSOR, NOT THE RAW ROW. Spreading the DB row gave the adapter
      // snake_case keys (steps_json, profile_key, portal_url) with `steps` bolted on, so it
      // had no portalUrl, no loginStep, no scopeType — and returned ok:false with an EMPTY
      // message before opening a browser. Scored as "the recipe no longer matches the
      // portal", which was one report away from sending someone to chase a drift that did
      // not exist.
      const recipe = getPortalRecipe(db, String(c.row.id));
      if (!recipe) throw new Error(`recipe ${String(c.row.id)} could not be loaded`);
      const portalType = scopeType === "utility" ? "utility" : "AHJ";
      const fieldValues = resolveRecipeFieldValues(db, project, portalType);
      // THE OPTIONS PRODUCTION PASSES, not a bare { headless }. Without `credential` the
      // adapter reached the login page and reported "no stored credential was found for
      // this client/portal" — while the dry run listed that very credential as ok, because
      // the dry run reads the credential TABLE and the run needs it DECRYPTED and handed in.
      // Mirrors repository.ts: exact portalType first, then by URL, then any for this client.
      const profileBase = process.env.PORTAL_PROFILES_DIR || path.join(process.cwd(), "portal-profiles");
      const userDataDir = path.join(profileBase, CLIENT, portalType);
      const credential = getDecryptedCredential(db, CLIENT, portalType)
        ?? getDecryptedCredentialByUrl(db, CLIENT, String(recipe.portalUrl || c.url))
        ?? getDecryptedCredentialAny(db, CLIENT, String(recipe.portalUrl || c.url))
        ?? undefined;
      if (!credential) throw new Error(`no decryptable credential for ${c.host || c.key}`);
      const res = await stageWithRecipe(recipe, project, fieldValues, {}, [], {
        headless: true, credential, userDataDir,
      });
      // THE FAILURE TEXT LIVES ON THE FAILING STEP, NOT ON result.message. HANDOFF already
      // records this trap — it is what made the stale-recipe flag dead code in repository.ts
      // once before — and this harness walked straight into it, reporting a silent failure
      // for three runs while the reason sat one level down in `steps`.
      // The report lives on the STEP, not the result — see mergeStepReport, which the
      // production KPI uses too so the two cannot drift apart on what a run "said".
      outcome = { ...mergeStepReport(res), recorded: c.steps };
    } catch (e) {
      outcome = { ok: false, message: String((e as Error)?.message || e), recorded: c.steps };
    } finally {
      if (pid) { try { deleteProject(db, pid); } catch { /* leave it */ } }
    }

    const score = scoreReplayOutcome(outcome as never);
    const o = outcome as Record<string, unknown>;
    rows.push({
      portal: c.host || c.key, profileKey: c.key, score,
      // The numbers behind the verdict, so a scorecard row can be argued with offline.
      detail: {
        executed: Number(o.executed ?? 0), recorded: c.steps,
        reviewFieldsSeen: Number(o.reviewFieldsSeen ?? 0),
        healed: ((o.healedSteps as unknown[]) ?? []).length,
        blanks: ((o.requiredStillEmpty as unknown[]) ?? []).length,
        blankNames: ((o.requiredStillEmpty as string[]) ?? []).slice(0, 30),
        driftWarnings: ((o.driftWarnings as string[]) ?? []).slice(0, 30),
        // A step that "did not take" is recorded as SKIPPED, and the count alone sends
        // someone back to the portal to find out which. Name them.
        skippedNames: ((o.skipped as string[]) ?? []).slice(0, 30),
        unresolvedFields: ((o.unresolvedFields as string[]) ?? []).slice(0, 30),
      },
    });
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
