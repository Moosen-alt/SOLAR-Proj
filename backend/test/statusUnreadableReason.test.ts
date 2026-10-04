// WHY A STATUS CHECK READ NOTHING (issue #161).
//
// The monitor logged "skipping status check — no portal URL/recipe" whenever a sweep gathered no
// text, even when a complete recipe had signed in and then read the wrong page (live: a PacifiCorp
// NEM filing, 2026-10-04). Now the scraper's own reason reaches the log and a
// permit_status.unreadable audit row, and "no portal URL or recipe" is said only when there was
// neither. The browser is the only thing stubbed (setStatusCheckSeamsForTests); the sweep is the real
// runDuePermitChecks over targets and recipes written through the real writers.
//
//   MUST-PASS    the reason the scraper reports is the audited reason
//   MUST-EXCLUDE a target whose recipe ran is never audited "no portal URL or recipe", even when the
//                scraper reported nothing
//   MUST-PASS    a target with neither a recipe nor a URL is audited as exactly that, with no scrape
//   MUST-PASS    a scraper that THROWS -> "the status read failed: <its message>"; a scraper that
//                returns a sign-in wall's text -> "the portal page read was a sign-in wall"
//   MUST-PASS    a target with no application/permit number says so, and nothing is scraped; a recipe
//                refused for this track (rule 5) says the recorded portal was not used, and why
//
// Run: npx tsx backend/test/statusUnreadableReason.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("status-unreadable-reason");
const { db, repo, recipes } = fx;
// The live install's mode. The stage fixture sets PORTAL_AUTOSEED=0, which routes an empty read to
// the mock-status gate instead of the skip under test (isAutoSeedDisabled in runDuePermitChecks).
process.env.PORTAL_AUTOSEED = "1";
const PACIFICORP_NM = "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login";
const REVIEW = { action: "stopForReview", selector: {} } as never;
const fill = (i: number) => ({ action: "fill", selector: { name: `f${i}` }, field: "homeownerName", note: `Field ${i}` }) as never;

let report: string | null = null;
let mode: "report" | "throw" | "wall" = "report";
const scrapes: string[] = [];
repo.setStatusCheckSeamsForTests({
  checkStatus: (async (adapter: string, _apps: string[], opts: { onReason?: (r: string) => void }) => {
    scrapes.push(adapter);
    if (mode === "throw") throw new Error("browser closed: target page crashed");
    if (mode === "wall") return "Log in Username Password Forgot password? Register a new account";
    if (report) opts?.onReason?.(report);
    return null;
  }) as never,
  publicCheck: (async () => null) as never,
});

const nemTarget = (projectId: string, applicationNumber: string) => {
  repo.createPermitCheckTarget(db, projectId, { targetType: "nem", portalUrl: "", applicationNumber, jurisdiction: "Pacific Power", portalName: "PowerClerk", permitType: "nem" });
  return db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [projectId])!.id;
};
/** One sweep over exactly these targets. */
const sweep = async (...ids: string[]) => {
  db.run("UPDATE permit_check_targets SET active = 0");
  for (const t of ids) db.run("UPDATE permit_check_targets SET active = 1, next_check_at = NULL WHERE id = ?", [t]);
  scrapes.length = 0;
  await repo.runDuePermitChecks(db, "all");
};
const reasons = (targetId: string): string[] =>
  fx.audits("permit_status.unreadable").map((a) => JSON.parse(a.details)).filter((d) => d.targetId === targetId).map((d) => String(d.reason));

const pac = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "Pacific Power", portalUrl: PACIFICORP_NM, createdBy: "test" });
recipes.savePortalRecipeSteps(db, pac.id, [fill(1), fill(2), REVIEW], { status: "complete" });

await check("(r1) MUST-PASS the scraper's reason is what the monitor audits", async () => {
  const t = nemTarget(fx.newProject({ utility: "Pacific Power" }), "APP-100001");
  report = "the sign-in failed: the portal rejected the stored login";
  await sweep(t);
  assert.ok(scrapes.includes("recipe"), `the recipe was not scraped: ${JSON.stringify(scrapes)}`);
  assert.deepEqual(reasons(t), ["the sign-in failed: the portal rejected the stored login"]);
});

await check("(r2) MUST-EXCLUDE a recipe that ran is never audited 'no portal URL or recipe', even with no reason given", async () => {
  const t = nemTarget(fx.newProject({ utility: "Pacific Power" }), "APP-100002");
  report = null;
  await sweep(t);
  assert.ok(scrapes.includes("recipe"));
  assert.deepEqual(reasons(t), ["the portal read returned nothing"]);
});

await check("(r3) MUST-PASS neither a recipe nor a URL -> exactly that, and nothing is scraped", async () => {
  const t = nemTarget(fx.newProject({ utility: "Nowhere Power Co" }), "APP-100003");
  report = "should not be used";
  await sweep(t);
  assert.deepEqual(scrapes, [], "a scrape ran with no recipe and no URL");
  assert.deepEqual(reasons(t), ["no portal URL or recipe to read"]);
});

await check("(r4) MUST-PASS a scraper that throws -> 'the status read failed: <its message>'", async () => {
  const t = nemTarget(fx.newProject({ utility: "Pacific Power" }), "APP-100004");
  mode = "throw";
  await sweep(t);
  mode = "report";
  assert.ok(scrapes.includes("recipe"));
  assert.deepEqual(reasons(t), ["the status read failed: browser closed: target page crashed"]);
});

await check("(r5) MUST-PASS a scraper that reads a sign-in wall -> 'the portal page read was a sign-in wall'", async () => {
  const t = nemTarget(fx.newProject({ utility: "Pacific Power" }), "APP-100005");
  mode = "wall";
  await sweep(t);
  mode = "report";
  assert.ok(scrapes.includes("recipe"));
  assert.deepEqual(reasons(t), ["the portal page read was a sign-in wall"]);
});

await check("(r6) MUST-PASS a filing with no application or permit number says so, and nothing is scraped", async () => {
  const t = nemTarget(fx.newProject({ utility: "Pacific Power" }), "");
  report = "should not be used";
  await sweep(t);
  assert.deepEqual(scrapes, [], "a scrape ran with no number to look for");
  assert.deepEqual(reasons(t), ["the filing has no application or permit number to look up"]);
});

await check("(r7) MUST-PASS a recipe refused for this track says the recorded portal was not used, and why", async () => {
  // A utility recipe that drives an AHJ permit platform: rule 5 refuses it on the NEM track.
  const wrong = recipes.startPortalRecording(db, { scopeType: "utility", state: "UT", utility: "Wasatch Test Power", portalUrl: "https://aca-prod.accela.com/TESTCITY/Default.aspx", createdBy: "test" });
  recipes.savePortalRecipeSteps(db, wrong.id, [fill(1), fill(2), REVIEW], { status: "complete" });
  const t = nemTarget(fx.newProject({ utility: "Wasatch Test Power", state: "UT" }), "APP-100007");
  report = "should not be used";
  await sweep(t);
  assert.deepEqual(scrapes, [], "a refused recipe was scraped");
  const got = reasons(t);
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.match(got[0], /^the recorded portal was not used for this filing: .*accela\.com.* AHJ permit portal/);
});

repo.setStatusCheckSeamsForTests(null);
finish("statusUnreadableReason");
