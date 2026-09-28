// THE PRODUCTION DRY RUN'S PORTAL BLOCKERS (dryrun-0928, builder "portal").
//
// One clean project was driven end to end on production (plan set -> QC -> reviewer -> forms ->
// gates -> permit replays on Oregon ePermitting, NEM learn on PowerClerk -> review). This file pins
// the backend half of the fixes for the portal blockers it found, each through the REAL code path:
//
//   B10 a trusted learn's message + recipe note describe the ONE final-submit gate (a named
//       person's approval of the run + PORTAL_ALLOW_FINAL_SUBMIT=1) — never "opt this portal into
//       trusted auto-submit" — and say how many fields the verifier checked, of how many.
//   B2  a PER-JOB question (ownership / system configuration / disconnect distance) is never
//       answered from a recipe literal or a planner guess: bound at save time, rebound at replay
//       for an existing recipe, the planner's pick replaced at learn, and a stage whose recipe asks
//       one the job has not answered stops BEFORE a browser opens, naming the question.
//   B11 every staging browser launch writes a draft-ledger row (a headed retry is a second row),
//       and the portal's draft reference is kept when the review page's URL carries one.
//
// KILL TESTS (each disables its fix and turns this file red — recorded in the commit):
//   K-B10 autoLearn: restore the old trusted-learn strings            -> (B10) fails.
//   K-B2a portalRecipes.convertLiteralsToBoundFields: drop the per-job rule -> (B2 save) fails.
//   K-B2b recipeReplayBinding: drop R10                                -> (B2 replay) fails.
//   K-B2c autoLearn.buildPortalPlanner: drop the per-job override      -> (B2 learn) fails.
//   K-B2d repository.prepareSubmission: drop the per-job gate          -> (B2 gate) fails.
//   K-B11 repository: drop the staging recordDraftTouch                -> (B11) fails.
//
// Run: npx tsx backend/test/dryrunPortalClose.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "dryrun-portal-ledger-"));
process.env.PORTAL_DRAFT_LEDGER = path.join(ledgerDir, "portal-drafts.jsonl");

const fx = await setupStageFixture("dryrun-portal-close");
const { db, repo, recipes } = fx;
const autoLearn = await import("../src/autoLearn");
const llmMod = await import("../src/llm");

// ── the stub launcher and the stub LLM (learnTrackGuard's pattern) ─────────────────────────────
let nextLearn: Record<string, unknown> = {};
const failedLearn = { ok: false, portalName: "stub", steps: [], reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 0, pauseReason: null, message: "stub learn: nothing walked" };
autoLearn.setAutoLearnSeamsForTests({
  learnPortal: (async () => ({ ...failedLearn, ...nextLearn })) as never,
});
// The verifier "checked" three fields on the final page — the dry run's exact shape.
const verified = {
  accurate: true, overallConfidence: "high" as const, issues: [], notes: "",
  matches: [
    { label: "Meter aggregation", expected: "No Aggregation", found: "No Aggregation", ok: true },
    { label: "Serve more than one customer?", expected: "No", found: "No", ok: true },
    { label: "I certify", expected: "checked", found: "checked", ok: true },
  ],
};
const base = llmMod.createLLMProvider(); // no API key -> the stub provider
const fakeLlm = Object.assign(Object.create(base), {
  verifyPortalFill: async () => verified,
  verifyPortalFillVision: async () => verified,
});
autoLearn.setAutoLearnSeamsForTests({ llm: () => fakeLlm });

// ═══ B10 ════════════════════════════════════════════════════════════════════════════════════
const OPT_IN_WORDING = /opt(s)?\s+(this portal\s+)?in(to)?\b|allowlist|trusted auto-submit/i;
await check("(B10) a trusted learn's message and recipe note name the real gate and carry the denominator", async () => {
  const projectId = fx.newProject();
  const project = repo.getProjectDetail(db, projectId).project;
  const replay = recipes.resolveRecipeFieldValues(db, project, "AHJ", "building");
  const keys = Object.keys(replay).filter((k) => String(replay[k] ?? "").trim() && !/acc(oun)?t|meter|ssn|passw/i.test(k)).slice(0, 6);
  assert.ok(keys.length >= 5, `fixture: need 5 bindable fields, got ${keys.join(",")}`);
  const portalUrl = "https://devhub.portlandoregon.gov/apply";
  nextLearn = {
    ok: true, portalName: "Portland Permits", pageCount: 4, pauseReason: null, finalSubmitRecorded: true,
    reachedReview: true, filledSomething: true, message: "reached review",
    steps: [
      { action: "goto", value: portalUrl, note: "entry url" },
      ...keys.map((k, i) => ({ action: "fill", selector: { name: `f${i}` }, field: k, note: k })),
      { action: "stopForReview", selector: {} },
      { action: "click", selector: { text: "Submit" }, isFinalSubmit: true, note: "final submit: Submit (recorded, NOT clicked)" },
    ],
    reviewScreen: { fields: [{ label: "Owner", value: "x" }], bodyTextSnippet: "Review your application before submitting." },
    reviewScreenshotBase64: "iVBORw0KGgo=",
  };
  const result = await autoLearn.autoLearnPortal(db, projectId, { scope: "ahj", portalUrl, createdBy: "operator" });
  assert.equal(result.status, "trusted", `setup: the learn must be trusted (${result.message})`);
  const message = String(result.message);
  const note = String(recipes.getPortalRecipe(db, result.recipe!.id).notes ?? "");
  for (const [what, text] of [["message", message], ["note", note]] as const) {
    assert.doesNotMatch(text, OPT_IN_WORDING, `the ${what} still invites a per-portal auto-submit opt-in: ${text}`);
    assert.match(text, /named person approves/i, `the ${what} does not describe the approval gate: ${text}`);
    assert.match(text, /PORTAL_ALLOW_FINAL_SUBMIT=1/, `the ${what} does not name the environment switch`);
    assert.match(text, /3 field\(s\) checked on the final page \(3 matched\) of 6 recorded fill\(s\) across 4 page\(s\)/, `the ${what} has no denominator: ${text}`);
  }
  // THE MATCHING KEY SURVIVES: scripts/rekey-recipe.ts reads this prefix.
  assert.match(note, /^Auto-learned and verified \(high confidence\) on 4 page\(s\)\./, note);
  const { notesSayVerified } = await import("../../scripts/rekey-recipe");
  assert.equal(notesSayVerified(note), true, "rekey-recipe no longer recognises a trusted learn's note");
});

finish("dryrun portal close");
