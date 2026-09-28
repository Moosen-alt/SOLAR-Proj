// ONE PERMIT TRACK, ONE ISSUER — AND EVERY DOOR ASKS WHO IT IS (split issuer, 2026-09-28).
//
// Operator fact, a real Oregon job: "Electrical permit issued through Yamhill; Building permit issued
// through Newberg." The city runs its own building program on its own portal (OpenGov); it has no
// electrical program, and the county issues electrical on Oregon ePermitting. Every permit-track door
// keyed on project.ahj, so with the county as the AHJ the building permit staged on the county's
// portal and the city's was refused as a FOREIGN ENTITY — and the other way round with the city as
// the AHJ. Oregon has many such cities; this is a general capability, never one city's patch.
//
// THE PREDICATE: permitProcess.trackIssuer(project, track) — the operator's per-track issuer, else the
// per-job lookup's cited agency for this permit when it is another agency, else the project AHJ — and
// permitProcess.projectForTrack, the track-scoped view every door reads (the SAME object when the
// issuer is the project AHJ). Fictional places only: "Birchwood County" (the AHJ) contains "City of
// Fernhollow" (the building issuer); "City of Oakvale" is a neighbour with its own portal.
//
// Scratch DB, real writers (updateProject, startPortalRecording/savePortalRecipeSteps,
// savePermitProcessLookup), the real prepareSubmission with only the browser stubbed, the real
// autoLearnPortal with the launcher stubbed, and the real HTTP routes on a scratch server (refusal
// paths only — nothing that could open a window or a browser).
//
// KILLS (each disables one door; the named cases go RED — verified by hand, see the commit):
//   K1 repository.prepareSubmission: portalProject = detail.project          → (s3)
//   K2 permitProcess.issuingAgencyFor: skip the operator layer                → (f1)
//   K3 applicationDocsAgency.formAuthorityFor: drop the operator-first read   → (f1)(f2)
//   K4 autoLearn.autoLearnPortal: baseProject = loadedProject                 → (l1)
//   K5 submittalTracks.ensureCheckTarget: trackedAt = project                 → (t1)
//   K6 submittalTracks.getSubmittalTracks: issuerProject = project            → (c1)
//   K7 portalRecipes.resolveRecipeFieldValues: no projectForTrack             → (v1)
//   K8 repository.updateProject: no refuseTrackIssuerValue                    → (w2)
//   K9 permitProcess.trackIssuer: honour a refused value                      → (x1)
//   K10 server /auto-learn + /launch-record: judge project.ahj again          → (r1)
//   K11 permitProcess.projectForTrack: always the project (the whole view)    → (s1)(s3)(c1)(l1)(t1)(v1)
//   K12 permitProcess.permitAnswerForTrack / lookedUpIssuingAgency: no view
//       fallback to the project's own lookup                                  → (b1)(b3)
// Round 2 (round-1 skeptic's mustFix):
//   K16 permitProcess.refuseTrackIssuerValue: no known-utility refusal        → (u1)(u2)
//   K17 permitProcess.trackIssuer: a looked-up utility name re-keys the track → (u3)
//
//   npx tsx backend/test/splitIssuer.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import type { ProjectRecord, RecipeStep } from "../../shared/src/types";
import { REPO } from "./_isolate";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("split-issuer");
const { db, repo, recipes } = fx;
const pp = await import("../src/permitProcess");
const channel = await import("../src/portalChannel");
const tracksMod = await import("../src/submittalTracks");
const agencyDocs = await import("../src/applicationDocsAgency");
const autoLearn = await import("../src/autoLearn");

const COUNTY = "Birchwood County";
const CITY = "City of Fernhollow";
const NEIGHBOUR = "City of Oakvale";
const COUNTY_URL = "https://aca-oregon.accela.com/oregon/";
const CITY_URL = "https://fernhollowor.portal.opengov.com/categories/1071";
const NEIGHBOUR_URL = "https://oakvaleor.portal.opengov.com/";
const WA_CITY_URL = "https://fernhollowwa.portal.opengov.com/";

// ── the world, through the real writers ─────────────────────────────────────────────────────
const REVIEW = { action: "stopForReview", selector: {} } as RecipeStep;
const fill = (i: number): RecipeStep => ({ action: "fill", selector: { name: `f${i}` }, field: "homeownerName", note: `Field ${i}` } as RecipeStep);
const ahjRecipe = (state: string, ahj: string, discipline: string, portalUrl: string) => {
  const r = recipes.startPortalRecording(db, { scopeType: "ahj", state, ahj, utility: "PGE", portalUrl, discipline, createdBy: "test" });
  return recipes.savePortalRecipeSteps(db, r.id, [{ action: "goto", value: portalUrl, note: "entry url" } as RecipeStep, fill(1), fill(2), REVIEW], { status: "complete" });
};
const countyStructural = ahjRecipe("OR", COUNTY, "structural", COUNTY_URL);
const countyElectrical = ahjRecipe("OR", COUNTY, "electrical", COUNTY_URL);
const cityStructural = ahjRecipe("OR", CITY, "structural", CITY_URL);
ahjRecipe("OR", NEIGHBOUR, "structural", NEIGHBOUR_URL);
// MUST-EXCLUDE evidence: a same-named city in ANOTHER state with its own portal.
const waCity = ahjRecipe("WA", CITY, "structural", WA_CITY_URL);

const newCountyProject = () => fx.newProject({ ahj: COUNTY, city: "Fernhollow", zip: "97990" });
const load = (id: string): ProjectRecord => repo.getProjectDetail(db, id).project;
const resolve = (project: ProjectRecord, track: "building" | "electrical" | "nem") =>
  repo.resolveStagePortal(db, { projectId: project.id, project: pp.projectForTrack(project, track), track, portalType: "mock", isRealPortal: false });

// The split job, set through the REAL write path (the dashboard's Save posts exactly this).
const splitId = newCountyProject();
repo.updateProject(db, splitId, { trackIssuerBuilding: CITY } as never);
const baseId = newCountyProject();

// ── the predicate ────────────────────────────────────────────────────────────────────────────
await check("(i1) trackIssuer: operator > lookup > project; MPU follows electrical; NEM and a trackless stage never read it", () => {
  const p = load(splitId);
  assert.deepEqual(pp.trackIssuer(p, "building"), { name: CITY, source: "operator", override: CITY });
  assert.equal(pp.trackIssuer(p, "structural").name, CITY, "building and structural are one trade");
  assert.deepEqual(pp.trackIssuer(p, "electrical"), { name: COUNTY, source: "project", override: "" });
  const mpu = { ...p, trackIssuers: { electrical: CITY } };
  assert.equal(pp.trackIssuer(mpu, "mpu").name, CITY, "MPU follows electrical unless set");
  assert.equal(pp.trackIssuer({ ...mpu, trackIssuers: { electrical: CITY, mpu: NEIGHBOUR } }, "mpu").name, NEIGHBOUR);
  for (const t of ["nem", null, undefined, ""] as const) {
    assert.deepEqual(pp.trackIssuer(p, t), { name: COUNTY, source: "project", override: "" }, `track ${String(t)} read the override`);
    assert.equal(pp.projectForTrack(p, t), p, `track ${String(t)} got a view`);
  }
});

await check("(i2) projectForTrack: the SAME object when the issuer is the project AHJ (a department spelling too); a view names the issuer and a view of a view is itself", () => {
  const b = load(baseId);
  for (const t of ["building", "electrical", "combo", "mpu"]) assert.equal(pp.projectForTrack(b, t), b, `${t}: not the same object`);
  const spelled = { ...b, trackIssuers: { building: "Birchwood County Building Division" } };
  assert.equal(pp.projectForTrack(spelled, "building"), spelled, "a department suffix re-keyed the project");
  const p = load(splitId);
  const view = pp.projectForTrack(p, "building");
  assert.equal(view.ahj, CITY);
  assert.equal((view.parserSnapshot as Record<string, unknown>).ahj, CITY, "the view's snapshot still names the county");
  assert.deepEqual(view.trackView, { track: "building", projectAhj: COUNTY, source: "operator" });
  assert.equal(pp.projectForTrack(view, "building"), view, "a view of a view is not itself");
  assert.equal(pp.projectForTrack(view, "electrical").ahj, COUNTY, "the other track of a view is not the project's");
  assert.equal(p.ahj, COUNTY, "the record itself was changed");
});

await check("(i3) agencyNameState reads only a comma / parenthesis form — never a bare trailing word", () => {
  assert.equal(pp.agencyNameState("Clark County, WA"), "WA");
  assert.equal(pp.agencyNameState("City of Vancouver, Washington"), "WA");
  assert.equal(pp.agencyNameState("Clark County (WA)"), "WA");
  assert.equal(pp.agencyNameState("Yamhill Co"), null, "\"Co\" is a county, not Colorado");
  assert.equal(pp.agencyNameState("Washington County"), null, "an Oregon county");
  assert.equal(pp.agencyNameState("City of Salem, Permit Center"), null);
});

// ── the write path ───────────────────────────────────────────────────────────────────────────
await check("(w1) MUST-PASS: PUT /api/projects/:id's writer stores the per-track issuer, maps it back, audits it; \"\" clears it", () => {
  const p = load(splitId);
  assert.deepEqual(p.trackIssuers, { building: CITY });
  const audit = db.get<{ details: string }>("SELECT details FROM audit_logs WHERE project_id = ? AND action = 'project.track_issuer_set'", [splitId]);
  assert.deepEqual(JSON.parse(String(audit?.details)), { key: "trackIssuerBuilding", from: "", to: CITY });
  const tmp = newCountyProject();
  repo.updateProject(db, tmp, { trackIssuerElectrical: NEIGHBOUR } as never);
  assert.equal(load(tmp).trackIssuers?.electrical, NEIGHBOUR);
  repo.updateProject(db, tmp, { trackIssuerElectrical: "" } as never);
  assert.equal(load(tmp).trackIssuers, undefined, "a cleared issuer is still on the record");
  assert.equal(pp.trackIssuer(load(tmp), "electrical").source, "project");
  assert.equal(load(baseId).trackIssuers, undefined, "a project with none carries the key");
});

await check("(w2) MUST-EXCLUDE: the writer refuses an issuer in ANOTHER state (and a web address) with 400 — nothing is written", () => {
  const tmp = newCountyProject();
  for (const bad of [`${CITY}, WA`, `${CITY} (Washington)`, CITY_URL]) {
    assert.throws(() => repo.updateProject(db, tmp, { trackIssuerBuilding: bad } as never),
      (err: { status?: number }) => err.status === 400, `${bad} was accepted`);
  }
  assert.equal(load(tmp).trackIssuers, undefined, "a refused value was written");
  assert.ok(!db.get("SELECT id FROM audit_logs WHERE project_id = ? AND action = 'project.track_issuer_set'", [tmp]), "a refused value was audited as set");
});

// ── staging's resolution (resolveStagePortal — prepareSubmission's own) ─────────────────────
await check("(s1) THE POINT: with the override the BUILDING track resolves the city's portal and recipe; the ELECTRICAL track the county's", () => {
  const p = load(splitId);
  const b = resolve(p, "building");
  assert.equal(b.recipe?.id, cityStructural.id, `building replays ${b.recipe?.id}`);
  assert.equal(b.ownPortalUrl, CITY_URL);
  assert.equal(b.hostEntity?.name, CITY, "the entity the host predicate judges is not the issuer");
  const e = resolve(p, "electrical");
  assert.equal(e.recipe?.id, countyElectrical.id);
  assert.equal(e.ownPortalUrl, COUNTY_URL);
});

await check("(s2) rule 5 / entity through the ONE predicate: the city's portal FITS the building track and is FOREIGN to the county's electrical track", () => {
  const p = load(splitId);
  const b = resolve(p, "building");
  assert.equal(channel.hostFitsTrackAndEntity("building", b.hostEntity, CITY_URL, "kb").fits, true, "the city's own portal was refused for its own permit");
  const e = resolve(p, "electrical");
  const fit = channel.hostFitsTrackAndEntity("electrical", e.hostEntity, CITY_URL, "kb");
  assert.equal(fit.code, "foreign_entity", `the city's portal is not foreign to the county's electrical permit: ${fit.reason}`);
  // Rule 5 is untouched: a utility portal never fits a permit track, whoever issues it.
  assert.equal(channel.hostFitsTrackAndEntity("building", b.hostEntity, "https://pgenm.powerclerk.com/MvcAccount/Login", "kb").code, "track_conflict");
});

await check("(s0) BASE BEHAVIOUR: without an override both tracks resolve the county, and the city's portal reads foreign on the building track", () => {
  const p = load(baseId);
  const b = resolve(p, "building");
  assert.equal(b.recipe?.id, countyStructural.id);
  assert.equal(b.ownPortalUrl, COUNTY_URL);
  assert.equal(channel.hostFitsTrackAndEntity("building", b.hostEntity, CITY_URL, "kb").code, "foreign_entity");
  assert.equal(resolve(p, "electrical").recipe?.id, countyElectrical.id);
});

await check("(s3) END TO END: prepareSubmission stages the building permit with the city's recipe, the city as the jurisdiction and the agency; electrical with the county's", async () => {
  const seen: Array<{ recipeId: string; ahj: string; fieldAhj: string; agency: unknown }> = [];
  fx.stubRunner((async (recipe: { id: string }, project: ProjectRecord, values: Record<string, string>, _docs: unknown, _files: unknown, opts: { issuingAgency?: unknown }) => {
    seen.push({ recipeId: recipe.id, ahj: project.ahj, fieldAhj: values.ahj, agency: opts.issuingAgency });
    return { ok: true, finalSubmitClicked: false, steps: [{ ok: true, message: "reached review" }] };
  }) as never);
  await repo.prepareSubmission(db, splitId, "building");
  assert.equal(fx.latestRun(splitId)?.recipe_id, cityStructural.id, `building run used ${fx.latestRun(splitId)?.recipe_id}`);
  assert.deepEqual(seen.at(-1), { recipeId: cityStructural.id, ahj: CITY, fieldAhj: CITY, agency: CITY });
  await repo.prepareSubmission(db, splitId, "electrical");
  assert.equal(fx.latestRun(splitId)?.recipe_id, countyElectrical.id);
  assert.equal(seen.at(-1)?.ahj, COUNTY);
  assert.equal(load(splitId).ahj, COUNTY, "staging changed the project");
});

// ── forms, the learn, the tracking target, the card, the field values ───────────────────────
await check("(f1) forms follow the same issuer: issuingAgencyFor answers the override (origin operator) and formAuthorityFor names the city for building forms only", () => {
  const p = load(splitId);
  const f = pp.issuingAgencyFor(p, "building");
  assert.equal(f?.value, CITY);
  assert.equal(f?.origin, "operator");
  assert.equal(pp.issuingAgencyFor(p, "electrical"), null, "no lookup: the electrical permit has no named agency");
  const building = agencyDocs.formAuthorityFor(p, agencyDocs.TRACK_FORM_TYPES.building[0]);
  assert.equal(building.name, CITY, `building forms follow ${building.name}`);
  assert.equal(building.issuedByOther, true);
  const electrical = agencyDocs.formAuthorityFor(p, agencyDocs.TRACK_FORM_TYPES.electrical[0]);
  assert.equal(electrical.name, COUNTY);
  assert.equal(electrical.issuedByOther, false);
});

await check("(f2) on a single-permit project the operator's COMBO issuer names both sides' forms — ahead of a cited lookup naming someone else", () => {
  pp.savePermitProcessLookup(db, {
    state: "OR", ahj: "City of Hazelby", lookedUpAt: new Date().toISOString(),
    issuingAgency: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not searched" },
    permitStructure: { value: "combo", sourceUrl: "https://hazelby.example.gov", quote: "one combination permit", origin: "lookup" },
    permits: [{ discipline: "combo", label: "combination permit", issuingAgency: { value: "Alder County", sourceUrl: "https://hazelby.example.gov/permits", quote: "Alder County issues permits for Hazelby", origin: "lookup" },
      portalUrl: { value: null, sourceUrl: "", quote: "", origin: "lookup" }, recordType: { value: null, sourceUrl: "", quote: "", origin: "lookup" },
      documents: { value: null, sourceUrl: "", quote: "", origin: "lookup" }, fee: { value: null, sourceUrl: "", quote: "", origin: "lookup" } }],
  } as never);
  const p = { ...load(fx.newProject({ ahj: "City of Hazelby", city: "Hazelby", zip: "97352" })), trackIssuers: { combo: NEIGHBOUR } };
  for (const form of [agencyDocs.TRACK_FORM_TYPES.building[0], agencyDocs.TRACK_FORM_TYPES.electrical[0]]) {
    const a = agencyDocs.formAuthorityFor(p, form);
    assert.equal(a.name, NEIGHBOUR, `${form} follows ${a.name}`);
    assert.equal(a.fact?.origin, "operator");
  }
  // MUST-PASS without the override: the cited lookup's agency, as before.
  const { trackIssuers: _t, ...plain } = p;
  assert.equal(agencyDocs.formAuthorityFor(plain, agencyDocs.TRACK_FORM_TYPES.building[0]).name, "Alder County");
});

await check("(l1) the learn's key is the issuer: a building learn is saved under the CITY's key, an electrical one under the county's", async () => {
  let launched = 0;
  autoLearn.setAutoLearnSeamsForTests({
    learnPortal: (async () => { launched++; return { ok: false, portalName: "stub", steps: [], reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 0, pauseReason: null, message: "stub learn: nothing walked" }; }) as never,
  });
  const learnId = newCountyProject();
  repo.updateProject(db, learnId, { trackIssuerBuilding: CITY } as never);
  // The staging self-seed passes the discipline; the operator's /auto-learn passes permitType.
  const building = await autoLearn.autoLearnPortal(db, learnId, { scope: "ahj", portalUrl: CITY_URL, createdBy: "operator", permitType: "structural", discipline: "structural" });
  assert.equal(launched, 1, "the city's portal was refused at the learn's door");
  assert.equal(building.recipe.ahj, CITY, `the building learn was keyed on ${building.recipe.ahj}`);
  assert.equal(building.recipe.state, "OR");
  const electrical = await autoLearn.autoLearnPortal(db, learnId, { scope: "ahj", portalUrl: COUNTY_URL, createdBy: "operator", permitType: "electrical", discipline: "electrical" });
  assert.equal(electrical.recipe.ahj, COUNTY);
  // MUST-EXCLUDE: the city's portal is refused for the county's electrical learn (nothing launched).
  await assert.rejects(autoLearn.autoLearnPortal(db, learnId, { scope: "ahj", portalUrl: CITY_URL, createdBy: "operator", permitType: "electrical" }),
    (err: { status?: number; details?: { code?: string } }) => err.status === 409 && err.details?.code === "foreign_entity");
  assert.equal(launched, 2, "a refused learn launched");
});

await check("(t1) the tracking target of the building filing is the CITY's; the electrical filing's the county's", () => {
  const trackId = newCountyProject();
  repo.updateProject(db, trackId, { trackIssuerBuilding: CITY } as never);
  const p = load(trackId);
  const b = tracksMod.ensureCheckTarget(db, p, { track: "building", targetType: "permit", permitType: "building", applicationNumber: "BLD-0001" });
  const e = tracksMod.ensureCheckTarget(db, p, { track: "electrical", targetType: "permit", permitType: "electrical", applicationNumber: "ELE-0001" });
  const jurisdiction = (id: string) => db.get<{ jurisdiction: string }>("SELECT jurisdiction FROM permit_check_targets WHERE id = ?", [id])!.jurisdiction;
  assert.equal(jurisdiction(b.targetId), CITY);
  assert.equal(jurisdiction(e.targetId), COUNTY);
});

await check("(c1) the card: the building card says who issues it (operator) and shows the city's recipe; the electrical card the county's", () => {
  const cards = tracksMod.getSubmittalTracks(db, load(splitId));
  const building = cards.find((c) => c.type === "building");
  const electrical = cards.find((c) => c.type === "electrical");
  assert.deepEqual(building?.issuer, { name: CITY, source: "operator", override: CITY });
  assert.equal(building?.recipeId, cityStructural.id, `the building card shows ${building?.recipeId}`);
  assert.deepEqual(electrical?.issuer, { name: COUNTY, source: "project", override: "" });
  assert.equal(electrical?.recipeId, countyElectrical.id);
  assert.equal(cards.find((c) => c.type === "nem")?.issuer, undefined, "the utility card names an issuer");
});

await check("(v1) the field values bind `ahj` to the track's issuer; NEM and a trackless call bind the project's", () => {
  const p = load(splitId);
  assert.equal(recipesResolve(p, "building").ahj, CITY);
  assert.equal(recipesResolve(p, "electrical").ahj, COUNTY);
  assert.equal(recipesResolve(p, "nem").ahj, COUNTY);
  assert.equal(recipesResolve(p, null).ahj, COUNTY);
});
function recipesResolve(p: ProjectRecord, track: string | null) {
  return recipes.resolveRecipeFieldValues(db, p, "", track);
}

// ── MUST-EXCLUDE ─────────────────────────────────────────────────────────────────────────────
await check("(x1) MUST-EXCLUDE: an issuer naming ANOTHER state (on file before the write check, or in memory) is refused — said on the answer — and never resolves that state's portal", () => {
  const p = { ...load(baseId), trackIssuers: { building: `${CITY}, WA` } };
  const answer = pp.trackIssuer(p, "building");
  assert.equal(answer.source, "project");
  assert.equal(answer.name, COUNTY);
  assert.match(String(answer.refused), /names an agency in WA/);
  const b = resolve(p, "building");
  assert.notEqual(b.recipe?.id, waCity.id, "the Washington city's recipe resolved on an Oregon project");
  assert.equal(b.ownPortalUrl, COUNTY_URL);
  assert.equal(pp.issuingAgencyFor(p, "building"), null, "a refused value reached the forms");
  // A bare same-named city never crosses states either: the view keeps the project's state.
  const bare = { ...load(baseId), trackIssuers: { building: CITY } };
  assert.equal(resolve(bare, "building").recipe?.id, cityStructural.id);
});

await check("(x2) MUST-EXCLUDE: a blank override falls back to the project AHJ", () => {
  const p = { ...load(baseId), trackIssuers: { building: "   " } };
  assert.equal(pp.trackIssuer(p, "building").source, "project");
  assert.equal(pp.projectForTrack(p, "building"), p);
});

await check("(x3) MUST-EXCLUDE: the NEM track never reads it — its resolution is identical with and without an override", () => {
  const withOverride = load(splitId);
  const without = load(baseId);
  const key = (r: ReturnType<typeof resolve>) => JSON.stringify({ recipe: r.recipe?.id ?? null, own: r.ownPortalUrl, util: r.utilityPortalUrl, entity: r.hostEntity?.name, scope: r.hostEntity?.scope });
  assert.equal(key(resolve(withOverride, "nem")), key(resolve(without, "nem")));
  assert.equal(pp.projectForTrack(withOverride, "nem"), withOverride);
});

// ── the per-job lookup's issuer (layer b) ───────────────────────────────────────────────────
const cite = (value: string | null, sourceUrl = "https://alder.example.gov/permits") => (value
  ? { value, sourceUrl, quote: `${value} issues these permits`, origin: "lookup" as const }
  : { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "not searched" });
const lookup = (ahj: string, agency: string, sourceUrl?: string, recordType: string | null = null) => {
  const permit = (discipline: "structural" | "electrical") => ({
    discipline, label: `${discipline} permit`, issuingAgency: cite(agency, sourceUrl),
    portalUrl: cite(null), recordType: recordType ? cite(recordType) : cite(null), documents: cite(null), fee: cite(null),
  });
  const saved = pp.savePermitProcessLookup(db, {
    state: "OR", ahj, lookedUpAt: new Date().toISOString(), issuingAgency: cite(null),
    permitStructure: { value: "separate", sourceUrl: "https://alder.example.gov", quote: "a separate electrical permit", origin: "lookup" },
    permits: [permit("structural"), permit("electrical")],
  } as never) as { saved: boolean };
  assert.ok(saved.saved);
};

await check("(b1) a CITED lookup naming another agency issues the track (Jefferson's shape): the view keeps the lookup's record type", () => {
  lookup("City of Cedarton", "Alder County", undefined, "Residential - Structural");
  const p = load(fx.newProject({ ahj: "City of Cedarton", city: "Cedarton", zip: "97352" }));
  const answer = pp.trackIssuer(p, "building");
  assert.equal(answer.name, "Alder County");
  assert.equal(answer.source, "lookup");
  const view = pp.projectForTrack(p, "building");
  assert.equal(view.ahj, "Alder County");
  assert.equal(pp.lookedUpRecordType(view, "building")?.value, "Residential - Structural", "the view lost the lookup's cited record type");
  assert.equal(pp.issuingAgencyFor(view, "building")?.value, "Alder County");
});

await check("(b3) an AHJ-WIDE cited agency (no per-permit answer) issues every permit track, and the view keeps it as the agency the replay binds", () => {
  const saved = pp.savePermitProcessLookup(db, {
    state: "OR", ahj: "City of Foxglen", lookedUpAt: new Date().toISOString(), issuingAgency: cite("Alder County"),
    permitStructure: { value: "separate", sourceUrl: "https://alder.example.gov", quote: "a separate electrical permit", origin: "lookup" },
    permits: [],
  } as never) as { saved: boolean };
  assert.ok(saved.saved);
  const p = load(fx.newProject({ ahj: "City of Foxglen", city: "Foxglen", zip: "97352" }));
  for (const t of ["building", "electrical"]) {
    const view = pp.projectForTrack(p, t);
    assert.equal(view.ahj, "Alder County", `${t}: ${view.ahj}`);
    assert.equal(pp.issuingAgencyFor(view, t)?.value, "Alder County", `${t}: the view lost the agency the replay binds`);
  }
});

await check("(b2) MUST-EXCLUDE: an UNCITED lookup agency, or the AHJ under a department's name, changes nothing", () => {
  lookup("City of Dunmore", "Alder County", "");
  const uncited = load(fx.newProject({ ahj: "City of Dunmore", city: "Dunmore", zip: "97352" }));
  assert.equal(pp.projectForTrack(uncited, "building"), uncited, "an uncited agency re-keyed the project");
  lookup("City of Elmfield", "City of Elmfield Permit Center");
  const same = load(fx.newProject({ ahj: "City of Elmfield", city: "Elmfield", zip: "97352" }));
  assert.equal(pp.projectForTrack(same, "building"), same, "a department suffix re-keyed the project");
});

// ── round 2: A UTILITY IS NEVER A PERMIT ISSUER (tightening) ────────────────────────────────
await check("(u1) MUST-EXCLUDE: an issuer naming a known UTILITY is refused (\"Portland General Electric\", \"PGE\", \"Pacific Power\", \"PacifiCorp\"…), whatever the project's state says; MUST-PASS: real agencies", () => {
  for (const [v, st] of [
    ["Portland General Electric", "OR"], ["PGE", "OR"], ["P.G.E.", "OR"], ["Pacific Power", "OR"], ["PacifiCorp", "OR"], ["Pac Power", "WA"],
    ["Rocky Mountain Power", "UT"], ["RMP", "UT"], ["PG&E", "CA"], ["PGE", "CA"], ["Pacific Gas and Electric Company", "CA"],
    ["Portland General Electric", ""], ["Pacific Power", ""], ["PacifiCorp", "TX"],
  ] as const) {
    assert.match(String(pp.refuseTrackIssuerValue(v, st)), /names a utility/, `"${v}" (${st || "no state"}) was accepted as an issuer`);
  }
  for (const [v, st] of [
    ["City of Portland", "OR"], ["Yamhill County", "OR"], ["Portland", "OR"], ["City of Portland Bureau of Development Services", "OR"],
    ["City of Ashland", "OR"], ["City of Forest Grove", "OR"], ["Pacific County", "WA"], ["City of Newberg", "OR"], ["Marion County", "OR"],
  ] as const) {
    assert.equal(pp.refuseTrackIssuerValue(v, st), null, `the agency "${v}" was refused`);
  }
});

await check("(u2) the write path refuses a utility issuer (400, nothing written) and the read path never views it — the Yamhill job keeps the county on its electrical track", () => {
  const id = fx.newProject({ ahj: "Yamhill County", city: "Newberg", zip: "97132" });
  assert.throws(() => repo.updateProject(db, id, { trackIssuerElectrical: "Portland General Electric" } as never),
    (err: { status?: number; message?: string }) => err.status === 400 && /names a utility/.test(String(err.message)));
  assert.equal(load(id).trackIssuers, undefined, "a refused utility issuer was written");
  // On file before this check (or in memory): refused on read, said so, and never a view.
  const p = { ...load(id), trackIssuers: { electrical: "Portland General Electric" } };
  const answer = pp.trackIssuer(p, "electrical");
  assert.equal(answer.source, "project");
  assert.equal(answer.name, "Yamhill County");
  assert.match(String(answer.refused), /names a utility/);
  assert.equal(pp.projectForTrack(p, "electrical"), p, "a utility name re-keyed the electrical track");
  assert.equal(pp.issuingAgencyFor(p, "electrical"), null, "a refused utility issuer reached the forms");
  // MUST-PASS: a real agency on the same job is still honoured.
  repo.updateProject(db, id, { trackIssuerBuilding: "City of Newberg" } as never);
  assert.equal(pp.projectForTrack(load(id), "building").ahj, "City of Newberg");
});

await check("(u3) MUST-EXCLUDE: a CITED lookup naming a utility as the issuing agency does not re-key the track either", () => {
  const saved = pp.savePermitProcessLookup(db, {
    state: "OR", ahj: "City of Hollin", lookedUpAt: new Date().toISOString(),
    issuingAgency: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not searched" },
    permitStructure: { value: "separate", sourceUrl: "https://hollin.example.gov", quote: "a separate electrical permit", origin: "lookup" },
    permits: [{ discipline: "electrical", label: "electrical permit",
      issuingAgency: { value: "Portland General Electric", sourceUrl: "https://hollin.example.gov/solar", quote: "Portland General Electric reviews the interconnection", origin: "lookup" },
      portalUrl: { value: null, sourceUrl: "", quote: "", origin: "lookup" }, recordType: { value: null, sourceUrl: "", quote: "", origin: "lookup" },
      documents: { value: null, sourceUrl: "", quote: "", origin: "lookup" }, fee: { value: null, sourceUrl: "", quote: "", origin: "lookup" } }],
  } as never) as { saved: boolean };
  assert.ok(saved.saved);
  const p = load(fx.newProject({ ahj: "City of Hollin", city: "Hollin", zip: "97352" }));
  assert.equal(pp.trackIssuer(p, "electrical").source, "project");
  assert.equal(pp.projectForTrack(p, "electrical"), p, "a looked-up utility name re-keyed the electrical track");
});

// ── the operator routes, on a real scratch server (refusal paths only: nothing opens) ────────
const PORT = 5200 + Math.floor(Math.random() * 40); // never 4173 / 4270
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env, AUTOPILOT_DB_PATH: process.env.AUTOPILOT_DB_PATH, PORT: String(PORT), AUTOPILOT_AUTO_START: "0", SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off", BACKGROUND_WORKERS: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true", ADMIN_EMAIL: "admin@splitissuer.test", ADMIN_PASSWORD: "split-issuer-password-1", NO_PROXY: "*", no_proxy: "*",
  AUTOPILOT_TEST_SEAMS: "",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${serverLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@splitissuer.test", password: "split-issuer-password-1" }) });
  assert.equal(login.status, 200, await login.text());
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  const send = (method: string, p: string, body: Record<string, unknown>) => fetch(`${BASE}${p}`, { method, headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const jobsFor = (projectId: string) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE project_id = ? AND job_type = 'auto_learn'", [projectId])!.n;

  await check("(r0) the dashboard's Save: PUT /api/projects/:id stores the issuer (200) and refuses another state's (400)", async () => {
    const id = newCountyProject();
    let res = await send("PUT", `/api/projects/${id}`, { trackIssuerBuilding: `${CITY}, WA` });
    assert.equal(res.status, 400, await res.text());
    // A utility's name is refused at the route too (the skeptic's "Portland General Electric").
    res = await send("PUT", `/api/projects/${id}`, { trackIssuerElectrical: "Portland General Electric" });
    const refusedText = await res.text();
    assert.equal(res.status, 400, refusedText);
    assert.match(refusedText, /names a utility/);
    res = await send("PUT", `/api/projects/${id}`, { trackIssuerBuilding: CITY });
    const body = await res.json() as { project?: ProjectRecord };
    assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
    assert.deepEqual(body.project?.trackIssuers, { building: CITY });
  });

  await check("(r1) /auto-learn and /launch-record judge a permit URL against THAT track's issuer (409s name the city, not the county)", async () => {
    // A neighbour's portal: refused either way, so nothing is queued or opened whichever entity judges it.
    let res = await send("POST", `/api/projects/${splitId}/auto-learn`, { scope: "ahj", portalUrl: NEIGHBOUR_URL, permitType: "structural" });
    let text = await res.text();
    assert.equal(res.status, 409, text);
    assert.match(text, /City of Fernhollow/, `the building learn was judged against another entity: ${text.slice(0, 300)}`);
    assert.equal(jobsFor(splitId), 0, "a learn job was queued");
    res = await send("POST", `/api/projects/${splitId}/launch-record`, { scope: "ahj", portalUrl: NEIGHBOUR_URL, track: "building" });
    text = await res.text();
    assert.equal(res.status, 409, text);
    assert.match(text, /City of Fernhollow/, `the building recording was judged against another entity: ${text.slice(0, 300)}`);
    // MUST-EXCLUDE: the electrical learn is still the county's.
    res = await send("POST", `/api/projects/${splitId}/auto-learn`, { scope: "ahj", portalUrl: NEIGHBOUR_URL, permitType: "electrical" });
    text = await res.text();
    assert.equal(res.status, 409, text);
    assert.match(text, /Birchwood County/);
  });
} finally {
  server.kill("SIGTERM");
}

finish("split-issuer");
