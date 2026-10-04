// One-off driver: live PowerClerk (utility NEM) auto-learn verification run.
// Uses the MANUAL auto-learn entry, exactly like live-accela-learn.ts, so no submission
// bookkeeping is created and a complete recipe for the same key is protected. The learner
// NEVER clicks final submit, NEVER pays fees, NEVER solves CAPTCHA/MFA — it stops at the
// review screen and leaves the browser open for the operator.
//
//   npx tsx live-nem-learn.ts pge [projectId]          -> Portland General Electric
//   npx tsx live-nem-learn.ts pacificorp [projectId]   -> Pacific Power / PacifiCorp
//
// Delete this file after the session.
import "dotenv/config";

const { openDatabase } = await import("./backend/src/db");
const { autoLearnPortal } = await import("./backend/src/autoLearn");

const which = (process.argv[2] || "pge").toLowerCase();
const TARGETS: Record<string, { projectId: string; portalUrl: string; who: string }> = {
  // Blake Fixture, Salem — utility stored as the LEGAL name "Portland General Electric",
  // which is the spelling every real project uses.
  pge: {
    projectId: "cf1c56aa-aeb0-44d5-b797-f663436463a7",
    portalUrl: "https://pgenm.powerclerk.com/MvcAccount/Login",
    who: "Portland General Electric",
  },
  // Avery Sample, Coos Bay — the same project the Accela permit runs used.
  pacificorp: {
    projectId: "bb47ba38-e30d-405e-85f6-84e2e2f7004a",
    portalUrl: "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login",
    who: "Pacific Power",
  },
};
const target = TARGETS[which];
// A projectId may be passed to learn against a DIFFERENT project than the built-in default
// — otherwise "learn with live data" quietly re-learns the same one every time.
const overrideProject = process.argv.slice(3).filter((a) => !a.startsWith("--"))[0];
if (target && overrideProject) target.projectId = overrideProject;
if (!target) {
  console.error(`unknown target ${JSON.stringify(which)} — use "pge" or "pacificorp"`);
  process.exit(2);
}

const db = await openDatabase();
console.log(`=== LIVE NEM LEARN: ${target.who} ===`);
console.log(`project ${target.projectId}`);
console.log(`portal  ${target.portalUrl}`);
console.log("The run stops at the review screen. It never submits, pays, or solves a challenge.\n");

const res = await autoLearnPortal(db, target.projectId, {
  scope: "utility",
  portalUrl: target.portalUrl,
  createdBy: `live NEM verification run (${which})`,
  headless: false, // operator convention: headed, browser left open at review
  onProgress: (p) => console.log(`[progress] ${p.phase} p${p.pageCount}/${p.maxPages} ${p.message ?? ""}`),
});

console.log("=== RESULT ===");
console.log(JSON.stringify({
  status: res.status,
  pauseReason: res.pauseReason,
  pageCount: res.pageCount,
  finalSubmitRecorded: res.finalSubmitRecorded,
  recipeId: res.recipe?.id,
  steps: res.recipe?.steps?.length,
  message: (res.message || "").slice(0, 2500),
}, null, 1));
process.exit(res.status === "failed" ? 1 : 0);
