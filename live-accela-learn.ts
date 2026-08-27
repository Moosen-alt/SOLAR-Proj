// One-off driver: live Oregon ePermitting (Accela) auto-learn verification run.
// Coos Bay project (a participating ePermitting jurisdiction — Salem is NOT; it has
// its own portal, per the operator). Uses the manual auto-learn entry so the existing
// recipe is protected (protectComplete) and no submission bookkeeping is created.
// The learner NEVER clicks final submit / pays fees / solves challenges; the run
// stops at review and any TMP draft is deleted by the operator.
// Run: npx tsx live-accela-learn.ts   (delete this file after the session)
import "dotenv/config";

const { openDatabase } = await import("./backend/src/db");
const { autoLearnPortal } = await import("./backend/src/autoLearn");

const db = await openDatabase();
const projectId = "bb47ba38-e30d-405e-85f6-84e2e2f7004a"; // Coos Bay, qc_passed

const res = await autoLearnPortal(db, projectId, {
  scope: "ahj",
  portalUrl: "https://aca-oregon.accela.com/oregon/",
  createdBy: "live ACA verification run",
  // Discipline from argv so both tracks can be exercised: `npx tsx live-accela-learn.ts electrical`.
  // structural -> the CITY (COOS_BAY) offering; electrical -> the COUNTY (COOS_CO) one.
  permitType: (process.argv[2] === "electrical" ? "electrical" : "structural"),
  discipline: (process.argv[2] === "electrical" ? "electrical" : "structural"),
  headless: false, // operator convention: headed, browser left open at review
  onProgress: (p) => console.log(`[progress] ${p.phase} p${p.pageCount}/${p.maxPages} ${p.message ?? ""}`),
});

console.log("=== RESULT ===");
console.log(JSON.stringify({
  status: res.status,
  pauseReason: res.pauseReason,
  pageCount: res.pageCount,
  finalSubmitRecorded: res.finalSubmitRecorded,
  message: (res.message || "").slice(0, 2500),
}, null, 1));
process.exit(res.status === "failed" ? 1 : 0);
