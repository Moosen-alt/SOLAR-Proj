// A RECIPE REPLAY NEVER PUTS ANOTHER PROJECT'S DATA INTO THIS APPLICATION (B4 + measure item 5).
//
// The fixture recipe mirrors the SHAPE of the complete Coos Bay structural recipe on Oregon
// ePermitting (step notes, field keys, agency-coded ASI control ids, a human-patch click on a
// filed record's link) with INVENTED literals — no real customer's data is in this file.
//
// Drives the real prepareSubmission with only the browser stubbed, and reads what the stub was
// handed: the effective value of every fill is computed the way the adapter resolves it (a known
// field key → that project's value, else the recorded literal).
//
// KILL TESTS (verified red by hand before the fix landed — the test was written first):
//   K1 recipeReplayBinding R1: drop the record-link strip           → (x1) fails.
//   K2 recipeReplayBinding R2: drop the project-literal binding     → (x2) fails.
//   K3 recipeReplayBinding R3: drop the agency refusal              → (a1), (a2b), (a2c) fail.
//   K3b recipeReplayBinding R3: the pre-agency-row "live ranking prefers CITY for structural"
//       refusal restored                                            → (a2), (a2d) fail.
//   K4 recipeReplayBinding R4: keep donor-agency fallbacks          → (a3) fails.
//   K5 repository: run the recorded steps instead of the bound ones → (x1), (x2), (o1) fail.
//
// Run: npx tsx backend/test/replayBindsThisProject.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("replay-binds-this-project");
const { db, repo, recipes } = fx;
const pp = await import("../src/permitProcess");
const binding = await import("../src/recipeReplayBinding");

const ACA = "https://aca-oregon.accela.com/oregon/";
const ASI = "#ctl00_PlaceHolderMain_AppSpec7E1D9A3EEdit_COOS_BAY";
// Invented donor literals (the SHAPE of the real ones: kW figures, a module count, a record number).
const DONOR_DESCRIPTION = "Install 9.99 kW DC / 8.88 kW AC roof-mounted residential solar PV system: (23) Examplesun EX-400 modules with (12) Microco MC-1 microinverters, with AC disconnect.";
const DONOR_COMMENTS = "Roof-mounted residential solar PV system, 9.99 kW DC / 8.88 kW AC";
const DONOR_RECORD = "187-26-009999-STR";
const donorSteps = (): RecipeStep[] => [
  { action: "goto", value: `${ACA}Dashboard.aspx`, note: "entry url" },
  { action: "fill", selector: { name: "f1" }, field: "streetNumber", value: "4242", note: "work location: street number" },
  { action: "click", selector: { css: "[data-al-row=\"ar1\"]", fallbacks: [{ role: "link", name: "Select" }] }, note: "address version: City Applications" },
  { action: "check", selector: { label: "Residential - Structural", fallbacks: [{ css: "#ctl00_PlaceHolderMain_WorkLocationEdit_ucAddressList_serviceControl_rptAgency_ctl00_cbListServices_2" }] }, note: "record type: Residential - Structural" },
  { action: "click", selector: { text: "Continue Application »" }, note: "record type: continue" },
  { action: "select", selector: { label: "Category of Construction" }, value: "1-1 or 2 Family Dwelling", note: "Category of Construction" },
  { action: "fill", selector: { label: "Description of Work" }, value: DONOR_DESCRIPTION, note: "Description of Work" },
  { action: "check", selector: { label: "No", fallbacks: [{ css: `${ASI}_rdo_0_0_1` }] }, note: "No" },
  { action: "select", selector: { label: "Category of Construction:", fallbacks: [{ css: `${ASI}_ddl_1_0` }] }, value: "Other", note: "Category of Construction:" },
  { action: "select", selector: { label: "Type of Work:", fallbacks: [{ css: `${ASI}_ddl_1_2` }] }, value: "New", note: "Type of Work:" },
  { action: "fill", selector: { label: "Building Height - Feet:", fallbacks: [{ css: `${ASI}_txt_1_7` }] }, value: "27", note: "Building Height - Feet:" },
  { action: "fill", selector: { label: "Number of Stories:" }, value: "3", note: "Number of Stories:" },
  { action: "fill", selector: { label: "Existing Building Area:" }, value: "4321", note: "Existing Building Area:" },
  { action: "fill", selector: { label: "*Other Category of Construction:" }, value: "Solar", note: "*Other Category of Construction:" },
  { action: "fill", selector: { label: "Additional Comments:" }, value: DONOR_COMMENTS, note: "Additional Comments:" },
  { action: "click", selector: { role: "link", name: DONOR_RECORD }, note: `human-patch: ${DONOR_RECORD}` },
  { action: "stopForReview", selector: {} } as RecipeStep,
];
const DONOR_LITERALS = [DONOR_DESCRIPTION, DONOR_COMMENTS, "9.99", "(23)", DONOR_RECORD, "4321", "27", "Solar"];

const donor = (() => {
  const r = recipes.startPortalRecording(db, {
    scopeType: "ahj", state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", portalUrl: ACA,
    discipline: "structural", portalPlatform: "accela", createdBy: "test",
  });
  return recipes.savePortalRecipeSteps(db, r.id, donorSteps(), { status: "complete" });
})();

function seedAgency(ahj: string, agency: string | null) {
  pp.savePermitProcessLookup(db, {
    state: "OR", ahj, lookedUpAt: new Date().toISOString(),
    issuingAgency: agency
      ? { value: agency, sourceUrl: "https://example.gov/building", quote: `${agency} issues building permits for ${ahj}`, origin: "lookup" }
      : { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "no page named the issuing agency" },
    permitStructure: { value: "separate", sourceUrl: "https://example.gov", quote: "separate electrical permit", origin: "lookup" },
    permits: [],
  });
}
type Handed = { steps: RecipeStep[]; values: Record<string, string> };
async function stageBuilding(ahj: string): Promise<{ handed: Handed | null; projectId: string }> {
  let handed: Handed | null = null;
  fx.stubRunner(async (recipe, _p, values) => { handed = { steps: recipe.steps, values: values as Record<string, string> }; return { ok: true, finalSubmitClicked: false, steps: [{ ok: true, message: "reached review" }] }; });
  const projectId = fx.newProject({ ahj, city: ahj.replace(/^City of /, ""), zip: "97351", utility: "Pacific Power" });
  await repo.prepareSubmission(db, projectId, "building");
  return { handed, projectId };
}
const effective = (h: Handed) => h.steps.filter((s) => s.action === "fill" || s.action === "select")
  .map((s) => (s.field && Object.prototype.hasOwnProperty.call(h.values, s.field) ? h.values[s.field] : String(s.value ?? "")));

// ── The borrowed replay binds to the TARGET ────────────────────────────────────────────────
seedAgency("City of Alderbrook", "City of Alderbrook");
const run = await stageBuilding("City of Alderbrook");

await check("(x1) MUST-EXCLUDE: the step clicking the donor's filed record never reaches the run", () => {
  assert.ok(run.handed, "the borrowed recipe drove the run");
  const hay = JSON.stringify(run.handed!.steps);
  assert.ok(!hay.includes(DONOR_RECORD), "the record-link step was handed to the browser");
});
await check("(x2) MUST-EXCLUDE: no donor literal (kW, module count, heights, areas, 'Other/Solar') reaches any fill", () => {
  const values = effective(run.handed!);
  for (const lit of DONOR_LITERALS) {
    assert.ok(!values.some((v) => v === lit || (lit.length > 4 && v.includes(lit))), `donor literal ${JSON.stringify(lit)} reached a fill: ${JSON.stringify(values)}`);
  }
});
await check("(x3) MUST-PASS: the description binds THIS project's figures; CoC = structure type, ToW = Alteration", () => {
  const h = run.handed!;
  const desc = h.steps.find((s) => /Description of Work/.test(String(s.note)))!;
  assert.equal(desc.field, "workDescription");
  assert.match(h.values.workDescription, /8\.6 kW DC/, `the fixture project is 8.6 kW DC: ${JSON.stringify(h.values.workDescription)}`);
  const coc = h.steps.find((s) => s.note === "Category of Construction:")!;
  assert.equal(coc.value, "1-1 or 2 Family Dwelling");
  const tow = h.steps.find((s) => s.note === "Type of Work:")!;
  assert.equal(tow.value, "Alteration");
  const stage = db.get<{ current_stage: string }>("SELECT current_stage FROM projects WHERE id = ?", [run.projectId])!.current_stage;
  assert.match(stage, /Replay binding: .*not replayed/, stage);
});

// ── The agency is bound from the target, or the borrow refuses ──────────────────────────────
await check("(a1) MUST-EXCLUDE: a borrow whose agency the per-job lookup did not find is REFUSED with a named reason", async () => {
  seedAgency("City of Birchport", null);
  const r = await stageBuilding("City of Birchport");
  assert.equal(r.handed, null, "the donor recipe must not drive the run");
  const a = fx.audits("portal.recipe_borrow_refused").find((x) => x.project_id === r.projectId);
  assert.ok(a, "the refusal is audited");
  assert.match(JSON.parse(a!.details).reason, /issuing agency .* not known/);
});
// (a2) was a MUST-EXCLUDE until agency-row (2026-09-27): the replay's live ranking preferred the
// CITY row for structural, so a county-issued structural permit could only be refused. The
// replay now ranks the address grid by fieldValues.issuingAgency (portal-bot addressVersion), so
// the borrow BINDS — the donor's row choice is never replayed, the agency's is. What still
// refuses: an unknown agency (a1), neither/ambiguous (a2c, borrowedReplayFeeTierAgency g1), and a
// LITERAL row the replay cannot re-rank that names the other kind (a2b).
await check("(a2) MUST-PASS: a county-issued STRUCTURAL permit (Jefferson's shape) borrows, and the run is handed the agency to rank the address grid by", async () => {
  seedAgency("City of Cedarton", "Marion County");
  const r = await stageBuilding("City of Cedarton");
  const refused = fx.audits("portal.recipe_borrow_refused").find((x) => x.project_id === r.projectId);
  assert.equal(refused, undefined, `the borrow was refused: ${refused?.details}`);
  assert.ok(r.handed, "the borrowed recipe drove the run");
  assert.equal(r.handed!.values.issuingAgency, "Marion County", "the replay ranks the grid by the looked-up agency");
  const row = r.handed!.steps.find((s) => /data-al-row/.test(String(s.selector?.css ?? "")));
  assert.ok(row, "the agency row is still the LIVE re-ranked step (data-al-row), never the donor's literal row");
  assert.match(String(row!.note), /issuing agency: Marion County/);
  assert.ok(!(row!.selector?.fallbacks ?? []).some((f) => f.role === "link" && /^select$/i.test(String(f.name ?? ""))),
    "a bare 'Select' fallback would click the first row whatever its agency");
});
const bindAgency = (agency: string | null, steps: RecipeStep[] = donorSteps(), city = "Cedarton") => binding.bindRecipeForReplay({
  steps, project: { state: "OR", ahj: `City of ${city}`, city, parserSnapshot: {} }, fieldValues: {}, track: "building",
  borrowed: { learnedFor: "City of Coos Bay", discipline: "structural" },
  agency: agency ? { value: agency, sourceUrl: "", quote: "", origin: "lookup" } : null,
});
// The learner's no-grid fallback records a LITERAL row: tr:has-text("<KIND> APPLICATIONS").
const literalRow = (kind: "CITY" | "COUNTY"): RecipeStep[] => donorSteps().map((s) => (/^address version:/.test(String(s.note))
  ? { action: "click", selector: { css: `tr:has-text("${kind} APPLICATIONS") a:has-text("Select")`, fallbacks: [{ role: "link", name: "Select", exact: true }] }, note: "work location: select city/structural address row" } as RecipeStep
  : s));
await check("(a2b) MUST-EXCLUDE: a LITERAL city row (not re-ranked live) is still refused for a county agency; a literal county row binds", () => {
  const cityLit = bindAgency("Marion County", literalRow("CITY"));
  assert.ok(cityLit.refusal, "the literal CITY row would be clicked as recorded");
  assert.match(cityLit.refusal!, /Marion County/);
  assert.match(cityLit.refusal!, /CITY/);
  assert.equal(bindAgency("Marion County", literalRow("COUNTY")).refusal, null);
});
await check("(a2c) MUST-EXCLUDE: an agency naming BOTH a city and a county is refused (ambiguous), never guessed", () => {
  const b = bindAgency("City of Cedarton / Marion County");
  assert.ok(b.refusal, "an ambiguous agency cannot be ranked by");
  assert.match(b.refusal!, /both a city and a county/);
});
await check("(a2d) MUST-PASS: the same predicate as the replay — a city agency binds (named or bare), a county binds; unknown still refuses", () => {
  assert.equal(bindAgency("City of Cedarton").refusal, null);
  assert.equal(bindAgency("Cedarton").refusal, null, "a bare name equal to the project's city is that city (addressVersion.issuingAgencyRow)");
  assert.equal(bindAgency("Marion County").refusal, null);
  assert.match(String(bindAgency(null).refusal), /not known/);
});
await check("(a3) donor-agency ids are stripped for another agency, kept for the same agency", () => {
  const bind = (agency: string) => binding.bindRecipeForReplay({
    steps: donorSteps(), project: { state: "OR", ahj: "X", parserSnapshot: {} }, fieldValues: {}, track: "building",
    borrowed: { learnedFor: "City of Coos Bay", discipline: "structural" }, agency: { value: agency, sourceUrl: "", quote: "", origin: "lookup" },
  });
  const other = bind("City of Dunmore");
  assert.ok(!JSON.stringify(other.steps).includes("COOS_BAY"), "a COOS_BAY control id survived for another agency");
  assert.ok(!other.steps.some((s) => s.selector?.label === "No"), "a bare 'No' identified only by COOS_BAY's id was kept");
  assert.ok(!JSON.stringify(other.steps).includes("cbListServices_2"), "the positional service-list index survived");
  const same = bind("City of Coos Bay");
  assert.ok(same.steps.some((s) => s.selector?.label === "No"), "the same agency's own question must stay");
});

// ── The entity's OWN recipe is bound too ────────────────────────────────────────────────────
await check("(o1) MUST-EXCLUDE: an entity's OWN recipe never replays its human-patch record click or its learn job's description", async () => {
  const own = fx.completeRecipe([
    ...fx.fills(2),
    { action: "fill", selector: { label: "Description of Work" }, value: DONOR_DESCRIPTION, note: "Description of Work" } as RecipeStep,
    { action: "click", selector: { role: "link", name: DONOR_RECORD }, note: `human-patch: ${DONOR_RECORD}` } as RecipeStep,
    fx.REVIEW,
  ]);
  let handed: Handed | null = null;
  fx.stubRunner(async (recipe, _p, values) => { handed = { steps: recipe.steps, values: values as Record<string, string> }; return { ok: true, finalSubmitClicked: false, steps: [{ ok: true, message: "reached review" }] }; });
  const projectId = fx.newProject();
  await repo.prepareSubmission(db, projectId);
  assert.ok(handed, `own recipe ${own.id} drove the run`);
  assert.ok(!JSON.stringify(handed!.steps).includes(DONOR_RECORD));
  assert.ok(!effective(handed!).includes(DONOR_DESCRIPTION));
});

finish("replay-binds-this-project");
