// A BORROWED REPLAY NEVER BILLS ANOTHER PROJECT'S FEE TIER, AND NEVER FILES WITH AN AGENCY IT
// CANNOT BIND (close M1 + M2, measure item 5).
//
// M1. The donor electrical recipe on Oregon ePermitting records ONE kVA fee-tier quantity box —
//     the tier its learn project fell in — keyed feeBracketQuantity:5.01-15 with value "1". The
//     per-job lookup's fee landing wrote each tier's lower bound as the previous tier's upper
//     bound (5-15, 15-25), so this project's tier keys never matched the recorded box and the
//     donor's "1" replayed into the 5.01-15 box whatever this project's size.
// M2. A borrow was refused only when the looked-up agency was a city or county that disagreed
//     with the row the replay picks; an agency that is neither ("Oregon Building Codes Division")
//     or an unknown agency on a donor with no agency row borrowed with nothing bound.
//
// The fixture recipe has the SHAPE of the real donor (address-version row, record type, the
// agency-coded fee box) with invented literals; the jurisdictions are fictional.
//
// KILL TESTS (each disabled by hand and seen red):
//   K1 permitProcessLookup.applyLookupFees: previous-max lower bound again   → (f1), (f4) fail.
//   K2 recipeReplayBinding R6: no numeric rebind                             → (f2) fails.
//   K3 recipeReplayBinding R6: no borrowed blank                             → (f3) fails.
//   (f4) is the end-to-end: a 20.1 kVA borrowed replay through the real prepareSubmission.
//   K4 recipeReplayBinding R3: `kind && kind !== livePrefers` again          → (g1) fails.
//   K5 recipeReplayBinding: no refusal for an unknown agency + no agency row → (g2) fails.
//
// Run: npx tsx backend/test/borrowedReplayFeeTierAgency.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { CitedFact, RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("borrowed-replay-fee-tier");
const { db, repo, recipes } = fx;
const pp = await import("../src/permitProcess");
const ppl = await import("../src/permitProcessLookup");
const fees = await import("../src/feeSchedules");
const binding = await import("../src/recipeReplayBinding");

const ACA = "https://aca-oregon.accela.com/oregon/";
const FEES = "https://docs.example-countyfees.org/2026-fee-schedule.pdf";
const COUNTY_PAGE = "https://www.co.example-county.or.us/building";
const TIER_LABEL = "Renewable energy for electrical systems- 5.01kva through 15kva:";
const TIER_KEY = "feeBracketQuantity:5.01-15";
const donorSteps = (opts: { agencyRow?: boolean } = {}): RecipeStep[] => [
  { action: "goto", value: `${ACA}Dashboard.aspx`, note: "entry url" },
  { action: "fill", selector: { name: "f1" }, field: "streetNumber", value: "4242", note: "work location: street number" },
  ...(opts.agencyRow === false ? [] : [{ action: "click", selector: { css: "[data-al-row=\"ar2\"]", fallbacks: [{ role: "link", name: "Select" }] }, note: "address version: County Applications (electrical)" } as RecipeStep]),
  { action: "check", selector: { label: "Residential - Electrical" }, note: "record type: Residential - Electrical" },
  { action: "click", selector: { text: "Continue Application »" }, note: "record type: continue" },
  { action: "fill", selector: { label: TIER_LABEL, fallbacks: [{ css: "#ctl00_PlaceHolderMain_AppSpecB42EAF26Edit_DONOR_CO_txt_0_28" }] }, note: TIER_LABEL, field: TIER_KEY, value: "1" },
  { action: "stopForReview", selector: {} } as RecipeStep,
];
const DONOR = "City of Donorport";
const donor = (() => {
  const r = recipes.startPortalRecording(db, {
    scopeType: "ahj", state: "OR", ahj: DONOR, utility: "Pacific Power", portalUrl: ACA,
    discipline: "electrical", portalPlatform: "accela", createdBy: "test",
  });
  return recipes.savePortalRecipeSteps(db, r.id, donorSteps(), { status: "complete" });
})();

const TIERS = [
  { maxKva: 5, amountUsd: 79, label: "5 kva or less" },
  { maxKva: 15, amountUsd: 94, label: "5.01 to 15 kva" },
  { maxKva: 25, amountUsd: 156, label: "15.01 to 25 kva" },
];
/** The per-job lookup's answer for a fictional city whose electrical permits a county issues —
 *  written through the real lookup write path, fees through applyLookupFees. */
function seedLookup(ahj: string, agency: string) {
  const cite = (value: string): CitedFact<string> => ({ value, sourceUrl: COUNTY_PAGE, quote: `${value} issues electrical permits for ${ahj}`, origin: "lookup" });
  const saved = pp.savePermitProcessLookup(db, {
    state: "OR", ahj, lookedUpAt: new Date().toISOString(),
    issuingAgency: cite(agency),
    permitStructure: { value: "separate", sourceUrl: COUNTY_PAGE, quote: "a structural permit and a separate electrical permit", origin: "lookup" },
    permits: [{
      discipline: "electrical", label: "Residential Electrical", issuingAgency: cite(agency),
      portalUrl: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not searched" },
      recordType: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not searched" },
      documents: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not searched" },
      fee: { value: { amountUsd: 94, basis: "tier 5.01-15 kVA", lines: [{ label: "5.01 to 15 kva", amountUsd: 94 }], tiers: TIERS } as never,
        sourceUrl: FEES, quote: "5 kva or less $79.00 5.01 to 15 kva $94.00 15.01 to 25 kva $156.00", origin: "lookup" },
    }],
  } as never);
  assert.ok(saved.saved && saved.lookup, `lookup saved: ${saved.reason}`);
  return ppl.applyLookupFees(db, saved.lookup!);
}

// ── M1: the fee tier ───────────────────────────────────────────────────────────────────────
seedLookup("City of Fernbrook", "Lane County");

await check("(f1) MUST-PASS: the lookup's tiers land with their PRINTED lower bounds (5.01, 15.01), not the previous row's upper bound", () => {
  const sched = fees.findFeeScheduleForProject(db, { state: "OR", ahj: "City of Fernbrook", utility: "Pacific Power" } as never, "permit", "electrical");
  assert.ok(sched, "the county's electrical schedule is reachable from the city");
  const mins = sched!.brackets.map((b) => b.minKw ?? null);
  assert.deepEqual(mins, [0, 5.01, 15.01], `bracket lower bounds: ${JSON.stringify(mins)}`);
});

await check("(f2) MUST-PASS: a recorded tier box binds to THIS project's same tier by its numeric bounds (5.01-15 ≡ 5-15)", () => {
  const b = binding.bindRecipeForReplay({
    steps: donorSteps(), project: { state: "OR", ahj: "X", parserSnapshot: {} }, track: "electrical",
    fieldValues: { "feeBracketQuantity:0-5": "0", "feeBracketQuantity:5-15": "0", "feeBracketQuantity:15-25": "1" },
    borrowed: null, agency: null,
  });
  const tier = b.steps.find((s) => s.note === TIER_LABEL)!;
  assert.equal(tier.field, "feeBracketQuantity:5-15", `the tier box stayed on ${tier.field}`);
  // MUST-EXCLUDE: an unrelated tier is never matched (15-25 is not 5.01-15).
  assert.notEqual(tier.field, "feeBracketQuantity:15-25");
});

await check("(f3) MUST-EXCLUDE: a BORROWED tier box matching none of this project's tiers types blank — never the donor's '1' — and keeps its key for the coverage check", () => {
  const b = binding.bindRecipeForReplay({
    steps: donorSteps(), project: { state: "OR", ahj: "X", parserSnapshot: {} }, track: "electrical", fieldValues: {},
    borrowed: { learnedFor: DONOR, discipline: "electrical" }, agency: { value: "Lane County", sourceUrl: "", quote: "", origin: "lookup" },
  });
  assert.equal(b.refusal, null, "a blank tier box is not a reason to refuse");
  const tier = b.steps.find((s) => s.note === TIER_LABEL)!;
  assert.equal(tier.field, TIER_KEY);
  assert.equal(b.fieldValues[TIER_KEY], "", `the donor's quantity would replay: ${JSON.stringify(b.fieldValues)}`);
  // MUST-PASS side: the entity's OWN recipe keeps its recorded quantity (status quo, visible).
  const own = binding.bindRecipeForReplay({
    steps: donorSteps(), project: { state: "OR", ahj: "X", parserSnapshot: {} }, track: "electrical", fieldValues: {}, borrowed: null, agency: null,
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(own.fieldValues, TIER_KEY));
});

await check("(f4) MUST-EXCLUDE end to end: a 20.1 kVA project borrowing the donor recipe never types '1' into the 5.01-15 box", async () => {
  let handed: { steps: RecipeStep[]; values: Record<string, string> } | null = null;
  fx.stubRunner(async (recipe, _p, values) => { handed = { steps: recipe.steps, values: values as Record<string, string> }; return { ok: true, finalSubmitClicked: false, steps: [{ ok: true, message: "reached review" }] }; });
  const projectId = fx.newProject({ ahj: "City of Fernbrook", city: "Fernbrook", zip: "97351", utility: "Pacific Power", dcKw: "24.08", acKw: "20.1", exportKw: "20.1", moduleQty: "56", invQty: "56", invOutputW: "359", busRating: "225", mainBreaker: "150", pvBreaker: "110", electricalCalcText: "NEC 705.12 load-side calculation: 225A bus x 120 percent = 270A, 150A main + 110A PV breaker = 260A. NEC 690.12 rapid shutdown shown." });
  await repo.prepareSubmission(db, projectId, "electrical");
  const borrowedAudit = fx.audits("portal.recipe_borrowed").find((a) => a.project_id === projectId);
  assert.ok(borrowedAudit, `the donor recipe ${donor.id} was borrowed (refused: ${JSON.stringify(fx.audits("portal.recipe_borrow_refused").map((a) => a.details))})`);
  assert.ok(handed, "the borrowed recipe drove the run");
  const h = handed!;
  const tier = h.steps.find((s) => s.note === TIER_LABEL)!;
  const effective = tier.field && Object.prototype.hasOwnProperty.call(h.values, tier.field) ? h.values[tier.field] : String(tier.value ?? "");
  assert.notEqual(effective, "1", `the 5.01-15 box would be billed for a 20.1 kVA system (field ${tier.field})`);
  assert.equal(effective, "0");
  // MUST-PASS: this project's own tier carries the "1".
  const own = Object.entries(h.values).find(([k, v]) => k.startsWith("feeBracketQuantity:") && v === "1");
  assert.equal(own?.[0], "feeBracketQuantity:15.01-25");
});

// ── M2: the agency ─────────────────────────────────────────────────────────────────────────
const bindBorrowed = (agency: string | null, steps = donorSteps()) => binding.bindRecipeForReplay({
  steps, project: { state: "OR", ahj: "City of Glenmoor", parserSnapshot: {} }, fieldValues: {}, track: "electrical",
  borrowed: { learnedFor: DONOR, discipline: "electrical" },
  agency: agency ? { value: agency, sourceUrl: "", quote: "", origin: "lookup" } : null,
});

await check("(g1) MUST-EXCLUDE: an issuing agency that is neither a city nor a county refuses the borrow with a named reason", () => {
  for (const agency of ["Oregon Building Codes Division", "State of Oregon"]) {
    const b = bindBorrowed(agency);
    assert.ok(b.refusal, `${agency}: the donor's county row would be clicked with nothing bound`);
    assert.match(b.refusal!, /neither a city nor a county/);
  }
});
await check("(g2) MUST-EXCLUDE: an unknown agency refuses the borrow even when the donor recipe has no agency row", () => {
  const b = bindBorrowed(null, donorSteps({ agencyRow: false }));
  assert.ok(b.refusal, "the borrow went ahead with no agency to check");
  assert.match(b.refusal!, /issuing agency .* is not known/);
});
await check("(g3) MUST-PASS: a county-issued electrical permit still borrows (the county row is what the replay picks)", () => {
  assert.equal(bindBorrowed("Lane County").refusal, null);
  assert.equal(bindBorrowed("Lane County", donorSteps({ agencyRow: false })).refusal, null);
});

finish("borrowed-replay-fee-tier-agency");
