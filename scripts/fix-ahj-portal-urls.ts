// AN AHJ ROW HOLDING A UTILITY PORTAL URL IS A WRONG-SYSTEM FILING WAITING TO HAPPEN.
//
//   npx tsx scripts/fix-ahj-portal-urls.ts [--apply] [--include-harness]
//
// Found while building the supervised-learn entry point: or|city of coos bay|pacific power carried
// https://pacificorpnetmetering.powerclerk.com as its AHJ portal_url. It is not one row — 34 of
// the 152 rows with a portal_url are AHJ-scoped and point at a utility interconnection platform.
//
// The signature says how they got there. On several rows the REAL permit URL is sitting in
// portal_name while the utility URL took portal_url:
//
//   ahj="City of Wilsonville"
//   portal_name="https://cityofwilsonvilleor-energovweb.tylerhost.net/apps/selfservice#/home …"
//   portal_url ="https://pgenm.powerclerk.com/MvcAccount/Login"
//
// That is a learn that ran with the wrong scope — the benchmark used to pick the utility by STATE
// and hardcode scope "ahj" for every portal, so a NEM learn wrote its utility portal onto the AHJ
// key. Both halves of that were fixed earlier; these rows are the residue.
//
// PRODUCTION IS ALREADY SAFE FROM THEM. repository.ts runs every permit-side candidate through
// permitSafeUrl, which drops a utility platform (CLAUDE.md safety rule 5), so staging never opened
// one. What the bad data DOES break is everything that reads the KB directly: the coverage report
// says a jurisdiction is ready when its recorded portal is somebody else's, and a supervised learn
// would have opened a utility portal for a permit filing had it not re-applied the same filter.
//
// THE REPAIR PREFERS RECOVERY OVER ERASURE, in this order:
//   1. a COMPLETE RECIPE for the same profile key with a non-utility URL — the strongest evidence
//      there is, because it is a URL we have actually filed through;
//   2. the first non-utility http URL sitting in portal_name, which is where the real one landed;
//   3. otherwise BLANK. Empty is honest and is what permitSafeUrl already treats it as; the
//      coverage report then names "no portal URL known" as the blocker, which is true and
//      actionable, where a wrong URL is neither.
//
// Never touches a human-verified row (confidence "mixed" — hard rule 3), and never touches a
// utility-scoped row, which legitimately holds a utility URL.
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

const apply = process.argv.includes("--apply");
// Benchmark/cross-project rows name a HOSTNAME as their "AHJ" — harness bookkeeping, not a real
// jurisdiction. Off by default so a clean-up of real data is not buried in 8 rows of scaffolding.
const includeHarness = process.argv.includes("--include-harness");

const { openDatabase } = await import("../backend/src/db");
const { isUtilityPlatformUrl } = await import("../backend/src/portalChannel");

const db = await openDatabase();

const HARNESS_AHJ = /^(benchmark|cross.?project test|zztest)/i;
const HTTP_URL = /https?:\/\/[^\s"'<>)\]]+/g;

interface Row { rid: number; profile_key: string; ahj: string; portal_url: string; portal_name: string; confidence: string }
const rows = db.query<Row>(
  "SELECT rowid AS rid, profile_key, ahj, portal_url, portal_name, confidence FROM permit_utility_knowledge WHERE portal_url <> ''",
);

let examined = 0, fixedFromRecipe = 0, fixedFromName = 0, blanked = 0, skippedVerified = 0, skippedHarness = 0;

console.log(`\nAHJ rows whose portal_url is a utility platform${apply ? "" : "   (dry run — nothing written)"}\n`);

for (const r of rows) {
  if (!String(r.ahj || "").trim()) continue;                 // utility-scoped row: a utility URL is correct
  if (!isUtilityPlatformUrl(String(r.portal_url))) continue; // already fine
  if (HARNESS_AHJ.test(String(r.ahj)) && !includeHarness) { skippedHarness++; continue; }
  examined++;

  // Hard rule 3: a human-verified row is never rewritten by a script.
  if (String(r.confidence) === "mixed") {
    skippedVerified++;
    console.log(`  rowid ${r.rid}  ${r.profile_key}`);
    console.log(`     SKIPPED — human-verified. Fix it by hand if it is wrong; a script must not.`);
    continue;
  }

  const recipeUrl = String(db.get<{ portal_url?: string }>(
    `SELECT portal_url FROM portal_recipes
      WHERE profile_key = ? AND status = 'complete' AND portal_url <> ''
      ORDER BY updated_at DESC LIMIT 1`,
    [r.profile_key],
  )?.portal_url || "");
  const fromRecipe = recipeUrl && !isUtilityPlatformUrl(recipeUrl) ? recipeUrl : "";
  const fromName = fromRecipe
    ? ""
    : (String(r.portal_name || "").match(HTTP_URL) || []).find((u) => !isUtilityPlatformUrl(u)) || "";
  const next = fromRecipe || fromName || "";
  const why = fromRecipe ? "a recipe we have filed through" : fromName ? "the URL stranded in portal_name" : "nothing trustworthy — blanked";

  console.log(`  rowid ${r.rid}  ${r.profile_key}   ahj="${r.ahj}"`);
  console.log(`     was  ${r.portal_url}`);
  console.log(`     now  ${next || "(blank)"}   <- ${why}`);

  if (fromRecipe) fixedFromRecipe++; else if (fromName) fixedFromName++; else blanked++;
  if (apply) {
    db.run(
      "UPDATE permit_utility_knowledge SET portal_url = ?, updated_at = ? WHERE rowid = ?",
      [next, new Date().toISOString(), r.rid],
    );
  }
}

console.log(`\n  ${examined} contaminated AHJ row(s) examined`);
console.log(`    ${fixedFromRecipe} recovered from a recipe`);
console.log(`    ${fixedFromName} recovered from portal_name`);
console.log(`    ${blanked} blanked (no trustworthy URL — the coverage report will name it)`);
if (skippedVerified) console.log(`    ${skippedVerified} skipped: human-verified (hard rule 3)`);
if (skippedHarness) console.log(`    ${skippedHarness} skipped: benchmark/test scaffolding (pass --include-harness to sweep those too)`);
console.log(apply ? "\n  Written.\n" : "\n  Dry run. Re-run with --apply to write.\n");
