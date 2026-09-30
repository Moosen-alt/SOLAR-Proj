// SPLIT ISSUER x NOT SERVED HERE (merge seam, release #11): split issuer (integ-11) x portal-truth D5 (not served).
// A county project whose BUILDING issuer is a city; the city's KB row holds the statewide URL with
// nothing saying it files elsewhere (d1-r2's shape), a donor recipe on that host lends its steps
// (borrow), and the replay comes back "not served here". Split-issuer's invariant: every portal door
// reads the track's VIEW (the city). D5's: nothing is kept for THIS entity on that host, and the next
// stage neither borrows nor falls back to it. Which entity does the merged code key the refusal to?
//   npx tsx backend/test/splitIssuerNotServed.test.ts
import "./_isolate"; // FIRST
const { setupStageFixture } = await import("./_stageFixture");
const fx = await setupStageFixture("merge-seam");
const { db, repo, recipes } = fx;
const kb = await import("../src/knowledgeBase");
const pp = await import("../src/permitProcess");
const ev = await import("../src/statewideEvidence");

const ACA_OREGON = "https://aca-oregon.accela.com/oregon/";
const COUNTY = "Birchwood County";
const CITY = "City of Fernhollow";
const NOT_SERVED = "No Building services were returned for this address.";
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} - ${label}${detail ? ` :: ${detail}` : ""}`); if (!ok) failures++; };

// The donor: another city's complete structural recipe on the statewide host.
const donorRec = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: "City of Donorvale", utility: "PGE", portalUrl: ACA_OREGON, discipline: "structural", portalPlatform: "accela", createdBy: "test" });
const donor = recipes.savePortalRecipeSteps(db, donorRec.id, [
  { action: "goto", value: `${ACA_OREGON}Dashboard.aspx`, note: "entry url" },
  { action: "fill", selector: { name: "f1" }, field: "streetNumber", note: "work location: street number" },
  { action: "check", selector: { label: "Residential - Structural" }, note: "record type: Residential - Structural" },
  { action: "click", selector: { text: "Continue Application »" }, note: "record type: continue" },
  { action: "stopForReview", selector: {} },
], { status: "complete" });
// The city's KB row: the statewide URL, nothing on file saying it files elsewhere (served, d1-r2).
kb.saveResearchedAhjProfile(db, { state: "OR", ahj: CITY, utility: "PGE" }, {
  provider: "claude", portalName: "", portalPlatform: "Accela", portalUrl: ACA_OREGON, submissionMethod: "online portal",
  requiredDocuments: ["Plan set"], commonCorrections: [], tips: [], submissionSteps: [], confidence: "medium", needsHumanVerification: true, notes: "", webGrounded: true,
});
// The county's own electrical recipe on its own portal (so the county has a key of its own).
const countyRec = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: COUNTY, utility: "PGE", portalUrl: "https://birchwood.example.gov/permits", discipline: "electrical", createdBy: "test" });
recipes.savePortalRecipeSteps(db, countyRec.id, [{ action: "goto", value: "https://birchwood.example.gov/permits", note: "entry url" }, { action: "stopForReview", selector: {} }], { status: "complete" });

const projectId = fx.newProject({ ahj: COUNTY, city: "Fernhollow", zip: "97990", utility: "PGE" });
repo.updateProject(db, projectId, { trackIssuerBuilding: CITY });
const project = repo.getProjectDetail(db, projectId).project;
check("fixture: the building issuer is the city (operator)", pp.trackIssuer(project, "building").name === CITY);
const view = pp.projectForTrack(project, "building");
const pre = repo.resolveStagePortal(db, { projectId, project: view, track: "building", portalType: "mock", isRealPortal: false });
check("fixture: the building stage borrows the donor on the statewide host (the city's KB row served)", pre.borrowed?.recipe?.id === donor.id || pre.borrowed != null, `borrowed=${JSON.stringify(pre.borrowed && { learnedFor: pre.borrowed.learnedFor })} own=${pre.ownPortalUrl} reason=${String(pre.borrowDecisionReason).slice(0, 200)}`);

let ran = 0;
let seenAhj = "";
fx.stubRunner(async (_recipe: unknown, p: { ahj: string }) => {
  ran++; seenAhj = p.ahj;
  return { ok: false, finalSubmitClicked: false, message: "Stopped: the portal says this address is not served there",
    steps: [{ ok: true, message: "Opened stub portal." }, { ok: false, message: `Stopped: the portal says this address is not served there — "${NOT_SERVED}".`, data: { notServed: NOT_SERVED } }] };
});
await repo.prepareSubmission(db, projectId, "building");
check("the borrowed replay ran once, on the city's view", ran === 1 && seenAhj === CITY, `ran=${ran} ahj=${seenAhj}`);
const run = fx.latestRun(projectId);
// The run's own sentence lives in portal_runs.error_message (repository.ts failureMessage, which
// appends the not-served verdict note); result_json is only the adapter's raw result.
const msg = String(run?.error_message ?? "");
console.log(`  run message: ${msg.slice(0, 400)}`);
const refusedRows = db.query<any>("SELECT id, ahj, discipline, status, portal_url, flag_reason FROM portal_recipes WHERE flag_reason LIKE 'not served here:%'");
console.log(`  refused rows: ${JSON.stringify(refusedRows.map((r: any) => ({ ahj: r.ahj, discipline: r.discipline, host: r.portal_url })))}`);
check("D5 x split issuer: the refused row is keyed to the CITY (the view whose portal refused), not the county", refusedRows.some((r: any) => r.ahj === CITY) && !refusedRows.some((r: any) => r.ahj === COUNTY), JSON.stringify(refusedRows.map((r: any) => r.ahj)));
check("the donor recipe is untouched", String(fx.recipeRow(donor.id).flag_reason ?? "") === "" && fx.recipeRow(donor.id).status === "complete");
check("the county's own electrical recipe is untouched", String(fx.recipeRow(countyRec.id).flag_reason ?? "") === "" && fx.recipeRow(countyRec.id).status === "complete");
const notServedAudit = fx.audits("portal_recipe.not_served").map((x: any) => JSON.parse(x.details));
console.log(`  portal_recipe.not_served audits: ${JSON.stringify(notServedAudit)}`);
check("the run's message names the city as the entity not served there", /City of Fernhollow does not file this permit on that portal|for City of Fernhollow on/.test(msg), msg.slice(0, 200));
// The next building stage for the city must not borrow onto the refused host again.
const d = ev.statewideDecisionFor(db, view, "building");
console.log(`  city's statewide decision after the refusal: because=${d?.because} url=${d?.url} withheld=${String(d?.withheld ?? "").slice(0, 160)}`);
const post = repo.resolveStagePortal(db, { projectId, project: view, track: "building", portalType: "mock", isRealPortal: false });
check("the next building stage does not borrow onto the host that refused the city", post.borrowed == null && !/aca-oregon/.test(post.ownPortalUrl), `borrowed=${JSON.stringify(post.borrowed && { learnedFor: post.borrowed.learnedFor })} own=${post.ownPortalUrl} refused=${JSON.stringify(post.refusedUrls.map((r: any) => `${r.source}:${r.code}`))}`);
await repo.prepareSubmission(db, projectId, "building");
check("a second building stage replays nothing on that host", ran === 1, `ran=${ran}`);

console.log(failures ? `\n${failures} split-issuer x not-served check(s) FAILED` : "\nAll split-issuer x not-served checks passed.");
process.exit(failures ? 1 : 0);
