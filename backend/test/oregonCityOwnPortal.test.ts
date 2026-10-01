// OREGON CITY FILES ON ITS OWN PORTAL (#24). The owner saw it live (2026-10-01): Oregon City, OR
// takes residential solar on its own Tyler EnerGov Citizen Self Service portal — record type
// "Solar Prescriptive - Solar" (else "Alteration Permit"), one permit per structure, a separate
// electrical permit. The repo said "Oregon City / ePermitting" (hand-written profile) and "email"
// (seeded process row), so the D1 evidence (statewideEvidence.statewideDecisionFor) read the
// hand-written profile as "files on Oregon ePermitting" and the building stage fell back to
// aca-oregon.accela.com, where Oregon City is not a subscriber.
//
// The fix is DATA through the existing withhold mechanism — the hand-written profile and the seeded
// process row now name the city's own EnerGov portal, which classifyChannelWords reads as
// "elsewhere" — not a new special case. Everything stays seeded (hard rule 3): no verified row,
// no hard-coded portal URL. No network.
//
// Run: npx tsx backend/test/oregonCityOwnPortal.test.ts
import "./_isolate"; // FIRST
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("oregon-city-own-portal");
const { db, repo, recipes } = fx;
const ev = await import("../src/statewideEvidence");
const docs = await import("../src/applicationDocs");
const tracks = await import("../src/submittalTracks");
const procs = await import("../src/processProfiles");

const ACA_OREGON = "https://aca-oregon.accela.com/oregon/";
const fail = (msg: string): never => { throw new Error(msg); };

// A complete structural recipe for ANOTHER Oregon city on the statewide host — exactly what the
// statewide fallback would lend Oregon City if the evidence said it files there.
const donorRec = recipes.startPortalRecording(db, {
  scopeType: "ahj", state: "OR", ahj: "City of Donorvale", utility: "PGE", portalUrl: ACA_OREGON,
  discipline: "structural", portalPlatform: "accela", createdBy: "test",
});
recipes.savePortalRecipeSteps(db, donorRec.id, [
  { action: "goto", value: `${ACA_OREGON}Dashboard.aspx`, note: "entry url" },
  { action: "check", selector: { label: "Residential - Structural" }, note: "record type: Residential - Structural" },
  { action: "stopForReview", selector: {} },
], { status: "complete" });

const projectId = fx.newProject({ ahj: "Oregon City", city: "Oregon City", zip: "97045", utility: "PGE" });
const project = repo.getProjectDetail(db, projectId).project;

await check("hand-written profile: Oregon City's own EnerGov Citizen Self Service, not ePermitting", () => {
  const p = docs.registryApplicationProfileFor(project) ?? fail("no hand-written Oregon City profile");
  if (p.id !== "oregon-city-solar") fail(`matched ${p.id}`);
  if (!/energov/i.test(p.portalName) || !/citizen self service/i.test(p.portalName)) fail(`portalName "${p.portalName}"`);
  if (/e-?permitting/i.test(`${p.portalName} ${p.submissionMethod ?? ""}`)) fail(`still names ePermitting: "${p.portalName}" / "${p.submissionMethod}"`);
  if (p.permitStructure !== "separate") fail(`permitStructure ${p.permitStructure}`);
  if (!p.requiresPrescriptiveChecklist) fail("Oregon's installation checklist dropped");
  if (p.sourceUrl !== "https://www.orcity.org/3224/Solar-PV-installation") fail(`sourceUrl ${p.sourceUrl}`);
  const notes = p.notes.join(" ");
  for (const want of [/Solar Prescriptive - Solar/, /Alteration Permit/, /each structure/i, /separate electrical permit/i]) {
    if (!want.test(notes)) fail(`notes miss ${want}: ${notes}`);
  }
});

await check("seeded process row: an online portal (its own), not email", () => {
  const proc = procs.findAhjProcessProfile(project) ?? fail("no seeded Oregon City process row");
  if (/e-?mail/i.test(proc.submissionMethod)) fail(`submissionMethod "${proc.submissionMethod}"`);
  if (!/portal/i.test(proc.submissionMethod) || !/energov/i.test(proc.submissionMethod)) fail(`submissionMethod "${proc.submissionMethod}"`);
});

await check("D1: the statewide decision withholds Oregon ePermitting for Oregon City (files elsewhere)", () => {
  const d = ev.statewideDecisionFor(db, project, "building") ?? fail("no decision for OR");
  if (d.url !== null) fail(`statewide portal taken: ${d.url} (evidence: ${d.evidence.map((e) => `${e.kind}:${e.source}`).join("; ")})`);
  if (d.because !== "elsewhere") fail(`because=${d.because}`);
  if (d.evidence.some((e) => e.verified)) fail("evidence claims a person verified it — it is seeded");
  if (d.evidence.some((e) => e.kind === "statewide")) fail(`evidence still says statewide: ${d.evidence.filter((e) => e.kind === "statewide").map((e) => e.detail).join("; ")}`);
});

await check("the building stage never resolves aca-oregon.accela.com for Oregon City", () => {
  const view = { ...project };
  const r = repo.resolveStagePortal(db, { projectId, project: view, track: "building", portalType: "mock", isRealPortal: false });
  const seen = JSON.stringify({ own: r.ownPortalUrl, borrowed: r.borrowed && { learnedFor: r.borrowed.learnedFor, url: r.borrowed.recipe?.portalUrl } });
  if (/aca-oregon\.accela\.com/i.test(seen)) fail(`resolved the statewide host: ${seen}`);
  if (r.borrowed) fail(`borrowed another city's statewide recipe: ${seen}`);
});

await check("the AHJ card: own EnerGov portal, separate electrical permit; never ePermitting", () => {
  const cards = tracks.getSubmittalTracks(db, project);
  const types = cards.map((c) => c.type);
  if (!types.includes("building") || !types.includes("electrical")) fail(`tracks ${types.join(",")} — want separate building + electrical`);
  for (const c of cards.filter((x) => x.type === "building" || x.type === "electrical")) {
    if (/e-?permitting|aca-oregon/i.test(c.channel)) fail(`${c.type} card says "${c.channel}"`);
    if (!/energov/i.test(c.channel)) fail(`${c.type} card does not name EnerGov: "${c.channel}"`);
  }
  const info = docs.describePermitType(docs.findApplicationProfile(project), { answer: docs.permitStructureAnswer(project) });
  if (info.structure !== "separate") fail(`structure ${info.structure}: ${info.callout}`);
  if (/e-?permitting|email/i.test(info.submissionMethod)) fail(`submission "${info.submissionMethod}"`);
});

finish("Oregon City own-portal");
