import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
const { openDatabase } = await import("./backend/src/db");
const { startPortalRecording, savePortalRecipeSteps, findCompleteRecipeForProject, findAnyRecipeForProject } = await import("./backend/src/portalRecipes");
const { recipeDisciplineForTrack } = await import("./backend/src/portalChannel");
const db = await openDatabase();

// --- A. combo/mpu: what the LEARNER stamps vs what the LOOKUP asks for ---
const A = { scopeType: "ahj" as const, state: "OR", ahj: "City of Combo", utility: "PGE" };
// prepareSubmission -> autoLearnPortal(permitType: "structural") for a combo track,
// autoLearn -> learnDiscipline "structural" -> startPortalRecording(discipline:"structural")
const seeded = startPortalRecording(db, { ...A, discipline: "structural", portalUrl: "https://aca-oregon.accela.com/oregon/" });
savePortalRecipeSteps(db, seeded.id, [{ action: "click", phase: "fill", note: "record type: Residential - Combination" }], { status: "complete" });
console.log("A. combo track lookup finds its own seeded recipe? ->",
  Boolean(findCompleteRecipeForProject(db, { ...A, discipline: recipeDisciplineForTrack("combo") })), "(expected true)");
console.log("A. mpu   track lookup finds its own seeded recipe? ->",
  Boolean(findCompleteRecipeForProject(db, { ...A, discipline: recipeDisciplineForTrack("mpu") })), "(expected true)");

// --- B. callers that pass NO discipline ---
console.log("B. findAnyRecipeForProject(no discipline) finds the disciplined row? ->",
  Boolean(findAnyRecipeForProject(db, A)), "(recipe:clear / permit monitor / mark-track-submitted)");
console.log("B. findCompleteRecipeForProject(no discipline) finds it? ->",
  Boolean(findCompleteRecipeForProject(db, A)));

// --- C. legacy '' row still satisfies protectComplete for the OTHER discipline ---
const L = { scopeType: "ahj" as const, state: "OR", ahj: "City of Legacy2", utility: "PGE" };
const legacy = startPortalRecording(db, { ...L, portalUrl: "https://aca-oregon.accela.com/oregon/" });
savePortalRecipeSteps(db, legacy.id, [{ action: "click", phase: "fill", note: "work location: select city/structural address row" }], { status: "complete" });
const seenByElectricalLearn = findAnyRecipeForProject(db, { ...L, discipline: "electrical" });
console.log("C. electrical learn sees the STRUCTURAL legacy recipe as 'existing'? ->",
  seenByElectricalLearn?.id === legacy.id, "status:", seenByElectricalLearn?.status, "(=> protectComplete, learn discarded)");

// --- D. a trusted electrical learn ADOPTS + re-stamps that legacy structural row ---
const claimed = startPortalRecording(db, { ...L, discipline: "electrical", portalUrl: "https://aca-oregon.accela.com/oregon/" });
console.log("D. electrical learn claimed the legacy row? ->", claimed.id === legacy.id,
  "| now discipline =", JSON.stringify(claimed.discipline), "| steps =", claimed.steps.length, "| status =", claimed.status);
console.log("D. structural track can still find a complete recipe? ->",
  Boolean(findCompleteRecipeForProject(db, { ...L, discipline: "structural" })), "(expected true if the structural recipe survived)");

db.close();
