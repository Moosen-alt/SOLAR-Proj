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
// The planner's page plan, set per check (B2 learn): what the model would have filed.
let nextPlan: { fills: Array<{ index: number; value: string; field: string | null }> } = { fills: [] };
const fakeLlm = Object.assign(Object.create(base), {
  verifyPortalFill: async () => verified,
  verifyPortalFillVision: async () => verified,
  planPortalFields: async () => ({ fills: nextPlan.fills, advanceIndex: null, navigateIndex: null, finalSubmitIndex: null, atReview: false, notes: "" }),
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

// ═══ B2 ═════════════════════════════════════════════════════════════════════════════════════
const { bindRecipeForReplay, openPerJobQuestions } = await import("../src/recipeReplayBinding");
const OWNERSHIP_Q = "Will the System be Customer-Owned or Third-Party Owned?";
// The live PacifiCorp recipe's step, exactly as the learn froze it: an UNBOUND select literal.
const ownershipStep = (): RecipeStep => ({ action: "select", selector: { label: OWNERSHIP_Q }, value: "Customer-Owned", note: OWNERSHIP_Q } as RecipeStep);
// MUST-EXCLUDE: per-job-SOUNDING controls whose key is a plan-set fact or whose answer is not in the
// key's vocabulary — label-binding them would match no option on replay (a new false stop).
const KEEP_AS_RECORDED: RecipeStep[] = [
  { action: "select", selector: { label: "Will you be participating in the Wattsmart Battery Program?" }, value: "No, I will not be participating", note: "Will you be participating in the Wattsmart Battery Program?" },
  { action: "select", selector: { label: "System Mounting Method" }, value: "Roof Mounting", note: "System Mounting Method" },
  { action: "select", selector: { label: "Is the system leased?" }, value: "No", note: "Is the system leased?" },
  { action: "select", selector: { label: "Will a third-party inspection agency be used?" }, value: "No", note: "Will a third-party inspection agency be used?" },
] as RecipeStep[];

await check("(B2 save) the save-time binder binds a frozen ownership literal to ownershipModel and drops it; per-job-sounding plan-set controls are untouched", () => {
  const out = recipes.convertLiteralsToBoundFields([ownershipStep(), ...KEEP_AS_RECORDED], { homeownerName: "Pat Example", hasBattery: "No", mountType: "roof" });
  assert.equal(out.steps[0].field, "ownershipModel", `the ownership select was not bound: ${JSON.stringify(out.steps[0])}`);
  assert.equal(out.steps[0].value, undefined, "the learn job's 'Customer-Owned' is still in the recipe");
  out.steps.slice(1).forEach((s, i) => {
    assert.equal(s.field, undefined, `MUST-EXCLUDE: "${KEEP_AS_RECORDED[i].note}" was bound to ${s.field}`);
    assert.equal(s.value, KEEP_AS_RECORDED[i].value, `MUST-EXCLUDE: "${KEEP_AS_RECORDED[i].note}" lost its recorded answer`);
  });
  // The disconnect-distance rule is the same predicate now: a yes/no answer binds, as before.
  const disc = recipes.convertLiteralsToBoundFields([{ action: "select", selector: { label: "Is your AC disconnect within 10 feet of the utility meter?" }, value: "Yes" } as RecipeStep], {});
  assert.equal(disc.steps[0].field, "disconnectWithin10ft");
});

await check("(B2 replay) an EXISTING recipe's frozen ownership literal replays this job's answer (R10), even on the borrow probe's empty value map", () => {
  const project = { state: "OR", ahj: "Coos Bay", parserSnapshot: {} };
  const policyStep = { action: "select", selector: { label: "Is the system Customer-Owned?" }, value: "Customer-Owned", note: "policy default: Is the system Customer-Owned? -> Customer-Owned" } as RecipeStep;
  for (const fieldValues of [{ ownershipModel: "PPA" }, {} as Record<string, string>]) {
    const b = bindRecipeForReplay({ steps: [ownershipStep(), ...KEEP_AS_RECORDED, policyStep], project, fieldValues, track: "nem", borrowed: null, agency: null });
    assert.equal(b.steps[0].field, "ownershipModel", `R10 did not rebind: ${JSON.stringify(b.steps[0])}`);
    assert.equal(b.steps[0].value, undefined, "the recorded 'Customer-Owned' would still replay");
    assert.ok(b.changes.some((c) => c.index === 0 && c.kind === "rebound" && /ownershipModel/.test(c.reason)), "the rebind is not named in the run's account");
    b.steps.slice(1, 1 + KEEP_AS_RECORDED.length).forEach((s, i) => assert.equal(s.value, KEEP_AS_RECORDED[i].value, `MUST-EXCLUDE: "${KEEP_AS_RECORDED[i].note}" changed on replay`));
    assert.equal(b.steps[b.steps.length - 1].value, "Customer-Owned", "an operator's standing 'policy default:' answer must stay as recorded");
  }
  // The stage gate's reading of the bound steps: open when the job has no answer, closed when it does.
  const bound = bindRecipeForReplay({ steps: [ownershipStep()], project, fieldValues: {}, track: "nem", borrowed: null, agency: null }).steps;
  assert.deepEqual(openPerJobQuestions(bound, {}).map((q) => q.key), ["ownershipModel"]);
  assert.deepEqual(openPerJobQuestions(bound, { ownershipModel: "Lease" }), []);
});

await check("(B2 learn) the planner's ownership pick is replaced by the job's answer — or left blank — never filed as its guess", async () => {
  const req = {
    url: "https://pacificorpnetmetering.powerclerk.com/MvcProjects/EditProject", pageTitle: "Generating Facility",
    bodyText: "", alreadyFilledLabels: [], isDashboard: false,
    fields: [
      { label: OWNERSHIP_Q, fieldType: "select", options: ["Select...", "Customer-Owned", "Third-Party Owned"] },
      { label: "Will you be participating in the Wattsmart Battery Program?", fieldType: "select", options: ["Select...", "No, I will not be participating", "Yes, I will be participating"] },
    ],
  };
  nextPlan = { fills: [
    { index: 0, value: "Customer-Owned", field: null },
    { index: 1, value: "No, I will not be participating", field: null },
  ] };
  const plan = async (projectId: string) => {
    const project = repo.getProjectDetail(db, projectId).project;
    const { planner } = autoLearn.buildPortalPlanner(db, project, { portalType: "utility", scopeType: "utility", track: "nem" });
    return (await planner(req as never)).fills;
  };
  const unanswered = await plan(fx.newProject());
  assert.deepEqual({ value: unanswered[0].value, field: unanswered[0].field }, { value: "", field: "ownershipModel" },
    `an unanswered job's ownership was filed as the planner's pick: ${JSON.stringify(unanswered[0])}`);
  assert.equal(unanswered[1].value, "No, I will not be participating", "MUST-EXCLUDE: a plan-set-keyed question keeps the planner's answer");
  const answeredId = fx.newProject();
  db.run("UPDATE projects SET ownership_model = 'ppa' WHERE id = ?", [answeredId]);
  const answered = await plan(answeredId);
  assert.deepEqual({ value: answered[0].value, field: answered[0].field }, { value: "PPA", field: "ownershipModel" }, "the job's own answer is filed, in the portal's wording");
});

await check("(B2 gate) a stage whose recipe asks an unanswered ownership question stops before any browser, naming it; answered, it replays the job's answer", async () => {
  const projectId = fx.newProject();
  fx.completeRecipe([...fx.fills(4), ownershipStep(), fx.REVIEW, fx.FINAL]);
  let launched: { steps: RecipeStep[]; values: Record<string, string> } | null = null;
  fx.stubRunner(async (r, _p, values) => {
    launched = { steps: r.steps, values };
    return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] };
  });
  const runsBefore = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [projectId])!.n;
  await assert.rejects(repo.prepareSubmission(db, projectId), (err: { status?: number; message?: string; details?: { unansweredPortalQuestions?: Array<{ key: string; label: string }> } }) => {
    assert.equal(err.status, 409, String(err.message));
    assert.deepEqual(err.details?.unansweredPortalQuestions?.map((q) => q.key), ["ownershipModel"], String(err.message));
    assert.match(String(err.message), /Customer-Owned or Third-Party Owned/, "the refusal must name the portal's own question");
    return true;
  });
  assert.equal(launched, null, "a browser was launched with the ownership question unanswered");
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [projectId])!.n, runsBefore, "no run row may be written for a stage that never started");
  // MUST-PASS: answered (the intake / portal-questions write lands in the v17 column), it stages
  // and the replay files THIS job's answer at the ownership select — never "Customer-Owned".
  db.run("UPDATE projects SET ownership_model = 'third-party-owned' WHERE id = ?", [projectId]);
  await repo.prepareSubmission(db, projectId);
  assert.ok(launched, "the answered stage did not launch");
  const own = launched!.steps.find((s) => /Customer-Owned or Third-Party/.test(String(s.note ?? "")));
  assert.equal(own?.field, "ownershipModel");
  assert.equal(own?.value, undefined);
  assert.equal(launched!.values.ownershipModel, "Third-Party Owned");
});

// ═══ B11 ════════════════════════════════════════════════════════════════════════════════════
const { readDraftLedger } = await import("../src/draftLedger");
const { draftReferenceFromUrl } = await import("../../portal-bot/src/adapters/submissionLedger");
const rowsFor = (projectId: string) => readDraftLedger().filter((r) => r.projectId === projectId);

await check("(B11 ref) the draft reference is read by the one identifier filter: PowerClerk's ProjectId yes, an Accela wizard URL none", () => {
  const pc = draftReferenceFromUrl("https://pacificorpnetmetering.powerclerk.com/MvcProjects/EditProject?ProjectId=TESTPROJ0001&NewProject=1&sessionToken=abc");
  assert.equal(pc.id, "TESTPROJ0001");
  assert.doesNotMatch(pc.link, /sessionToken|NewProject/i, `session material kept in the link: ${pc.link}`);
  assert.match(pc.link, /ProjectId=TESTPROJ0001/, "the record's own key must survive in the link");
  const accela = draftReferenceFromUrl("https://aca-oregon.accela.com/oregon/Cap/CapEdit.aspx?stepNumber=3&pageNumber=1&isRenewal=false&Module=Building");
  assert.equal(accela.id, "", "an Accela wizard URL carries no record key — none may be invented");
  assert.match(accela.link, /^https:\/\/aca-oregon\.accela\.com\/oregon\/Cap\/CapEdit\.aspx\?Module=Building$/, accela.link);
  const cap = draftReferenceFromUrl("https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx?Module=Building&capID1=26TMP&capID2=00000&capID3=00123&agencyCode=COOS_BAY");
  assert.equal(cap.id, "26TMP-00000-00123");
});

await check("(B11 ledger) every staging browser launch writes a draft-ledger row before it opens; a headed retry writes a second; the draft's reference is recorded", async () => {
  // Launch 1: a replay that reaches review on a PowerClerk-shaped page.
  const a = fx.newProject();
  fx.completeRecipe();
  let seenLedgerAtLaunch = -1;
  fx.stubRunner(async () => {
    seenLedgerAtLaunch = rowsFor(a).length; // the row must exist BEFORE the browser runs
    return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }],
      draftReference: { link: "https://pacificorpnetmetering.powerclerk.com/MvcProjects/EditProject?ProjectId=TESTPROJ0002", id: "TESTPROJ0002" } };
  });
  await repo.prepareSubmission(db, a);
  const aRows = rowsFor(a);
  assert.equal(seenLedgerAtLaunch, 1, `the ledger row was not written before the launch (saw ${seenLedgerAtLaunch})`);
  assert.equal(aRows.filter((r) => /^staging replay/.test(r.purpose)).length, 1, JSON.stringify(aRows));
  assert.equal(aRows[0].host, "permits.portland.example");
  assert.ok(aRows.some((r) => r.purpose === "annotation" && r.portalReference === "TESTPROJ0002"), `the draft's reference was not recorded: ${JSON.stringify(aRows)}`);
  // No secret ever lands in the ledger: the account is a username reference or empty.
  assert.doesNotMatch(JSON.stringify(aRows), /1234567890|987654321|password/i, "an account/meter number or a password reached the ledger");

  // Launch 2 + 3: a portal that refuses the headless browser, retried headed — two browsers, two rows.
  const prevHeadless = process.env.PORTAL_HEADLESS;
  process.env.PORTAL_HEADLESS = "true";
  const b = fx.newProject();
  let calls = 0;
  fx.stubRunner(async () => {
    calls++;
    if (calls === 1) return { portalName: "stub", ok: false, finalSubmitClicked: false, pauseReason: null, message: "403 Forbidden — Access Denied", steps: [{ ok: false, message: "403 Forbidden — Access Denied" }] };
    return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }],
      draftReference: { link: "https://aca-oregon.accela.com/oregon/Cap/CapEdit.aspx?Module=Building", id: "" } };
  });
  await repo.prepareSubmission(db, b);
  if (prevHeadless === undefined) delete process.env.PORTAL_HEADLESS; else process.env.PORTAL_HEADLESS = prevHeadless;
  assert.equal(calls, 2, "setup: the headed retry did not fire");
  const bRows = rowsFor(b);
  assert.equal(bRows.filter((r) => /^staging replay/.test(r.purpose)).length, 2, `one row per browser launch expected: ${JSON.stringify(bRows.map((r) => r.purpose))}`);
  assert.ok(bRows.some((r) => /headed retry/.test(r.purpose)), "the second row must say it is the headed retry");
  const bRef = bRows.find((r) => r.purpose === "annotation");
  assert.equal(bRef?.portalReference, "https://aca-oregon.accela.com/oregon/Cap/CapEdit.aspx?Module=Building", "an Accela draft is recorded by its page link");
  assert.match(String(bRef?.note), /no record key/, "and the row says it carries no record key");
});

finish("dryrun portal close");
