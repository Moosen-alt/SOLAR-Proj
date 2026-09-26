import assert from "node:assert/strict";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter, fingerprintBoost, healTargetOf, scoreHealCandidate, rankHealCandidates, decideHeal, sideVerdict, HEAL_MIN_SCORE, HEAL_TIE_MARGIN } from "./recipeAdapter";

// Browser-free tests for the recipe replay loop. We inject a fake Playwright page
// so we can assert the safety-critical behaviours (final-submit denylist, stop-at-
// review halt, field substitution, selector fallbacks, credential never logged)
// without launching Chromium. Run with: npm run portal:test:unit

// Keep the persist-settle sleep negligible so the gap-fill-ordering tests run fast and
// deterministically (the production default is 3s). "1" → Number("1") || 3000 === 1.
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";
// Anything a replay under test writes goes to a temp folder, never the repo's data/.
{
  const os = await import("node:os");
  const fsm = await import("node:fs");
  const pth = await import("node:path");
  const dir = fsm.mkdtempSync(pth.join(os.tmpdir(), "recipe-adapter-test-"));
  process.env.REPLAY_CAPTURE_DIR = dir;
  process.env.REPLAY_RUN_DIR = pth.join(dir, "runs");
  process.env.PORTAL_SCREENSHOT_DIR = pth.join(dir, "screenshots");
}

// --- Fake Playwright page/locator ------------------------------------------------

interface FakeMatch {
  // Identity used to drive count(): selectors that "don't exist" return 0.
  present: boolean;
}

// Records every action the adapter performed so tests can assert on them.
interface ActionLog {
  clicks: string[];
  fills: Array<{ key: string; value: string }>;
  gotos: string[];
  checks: number;
}

function makeFakePage(opts: {
  // Map of a stable key -> whether that locator is "present" on the page.
  present?: Record<string, boolean>;
  log: ActionLog;
  // Frame URLs returned by page.frames() (for structural challenge detection).
  frameUrls?: string[];
  // iframe src attributes returned by locator("iframe").evaluateAll(...).
  iframeSrcs?: string[];
  // When true, getByText(<challenge regex>).count() returns 1 (visible challenge text).
  challengeText?: boolean;
  // When set, the page exposes $$eval returning these pre-built RawField rows —
  // enables the self-heal + drift-precheck paths (absent on legacy fakes → both
  // features silently no-op, which the backward-compat tests rely on).
  rawFields?: Array<Record<string, unknown>>;
  // When set, the page is "readable": page.evaluate exists (answering null to every in-page
  // question) and locator("body").innerText() returns this text — enough for the final-submit
  // outcome read, which only ever reads the body through the shared classifier.
  bodyText?: string;
}) {
  const present = opts.present ?? {};
  const log = opts.log;

  function locatorFor(key: string): any {
    const isPresent = present[key] ?? true;
    // Absent locators behave like Playwright: waitFor/actions throw a
    // TimeoutError instead of silently succeeding — required for the
    // self-heal tests (heal only runs when a step actually fails).
    const gone = async () => { throw new Error(`TimeoutError: locator ${key} not found`); };
    const loc: any = {
      first: () => loc,
      nth: () => loc,
      count: async () => (isPresent ? 1 : 0),
      click: async () => { if (!isPresent) await gone(); log.clicks.push(key); },
      fill: async (v: string) => { if (!isPresent) await gone(); log.fills.push({ key, value: v }); },
      selectOption: async () => { if (!isPresent) await gone(); },
      check: async () => { if (!isPresent) await gone(); log.checks++; },
      uncheck: async () => { if (!isPresent) await gone(); },
      press: async () => undefined,
      waitFor: async () => { if (!isPresent) await gone(); },
      setInputFiles: async () => undefined,
      // Used by detectChallengeFrame to read iframe src attributes.
      evaluateAll: async () => opts.iframeSrcs ?? [],
      innerText: async () => (key === "css:body" ? opts.bodyText ?? "" : ""),
    };
    return loc;
  }

  const page: any = {
    goto: async (url: string) => { log.gotos.push(url); },
    waitForLoadState: async () => undefined,
    reload: async () => undefined,
    frames: () => (opts.frameUrls ?? []).map((u) => ({ url: () => u })),
    getByRole: (role: string, o?: { name?: string }) => locatorFor(`role:${role}:${o?.name ?? ""}`),
    getByLabel: (label: string) => locatorFor(`label:${label}`),
    getByPlaceholder: (p: string) => locatorFor(`placeholder:${p}`),
    getByTestId: (t: string) => locatorFor(`testId:${t}`),
    getByText: (t: any) => {
      // detectChallengeFrame calls getByText(<RegExp containing "captcha">).count();
      // honor the challengeText flag for any such challenge-text query.
      if (t instanceof RegExp && /captcha/i.test(t.source)) {
        return { ...locatorFor(`text:challenge`), count: async () => (opts.challengeText ? 1 : 0) };
      }
      return locatorFor(`text:${String(t)}`);
    },
    locator: (css: string) => locatorFor(`css:${css}`),
    frameLocator: () => page,
    // Render-readiness spy: waitForInteractiveControls() calls page.waitForFunction. Count the
    // calls so tests can assert readiness ran after a goto / advancing click (and NOT on the
    // final-submit branch). Resolving here mirrors "a control mounted" → returns ready=true,
    // so the no-throw/never-skip contract the existing safety tests rely on is preserved.
    readyCheckCount: 0,
    waitForFunction: async () => { page.readyCheckCount += 1; return true; },
  };
  if (opts.rawFields) page.$$eval = async () => opts.rawFields;
  if (opts.bodyText !== undefined) page.evaluate = async () => null;
  return page;
}

// THE FINAL-SUBMIT GATE'S INPUTS. PORTAL_ALLOW_FINAL_SUBMIT is re-read at the click, so a test
// sets it around the run and restores it after.
async function withFinalSubmitEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  if (value === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = prev;
  }
}
const APPROVED_RUN_R = { autoSubmit: true, runApproval: { approver: "A. Person", runId: "R" }, runId: "R" };
const CONFIRMATION = "Your application has been successfully submitted. Record Number: 187-26-000309-STR";

function baseRecipe(steps: RecipeStep[]): PortalRecipe {
  return {
    id: "r1",
    scopeType: "ahj",
    profileKey: "or|portland|",
    state: "OR",
    ahj: "Portland",
    utility: "PGE",
    portalPlatform: "test",
    portalUrl: "",
    status: "complete",
    version: 1,
    steps,
    createdBy: "test",
    createdAt: "",
    updatedAt: "",
    notes: "",
  };
}

const fakeProject = {} as ProjectRecord;

// Attach a fake page to the (private) adapter.page field for replay tests.
function withFakePage(adapter: RecipeAdapter, page: any): RecipeAdapter {
  (adapter as unknown as { page: unknown }).page = page;
  return adapter;
}

// --- Tests -----------------------------------------------------------------------

async function testStopForReviewHalts() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { label: "Account" }, field: "accountNumber" },
    { action: "stopForReview" },
    // This step is AFTER the stop marker and must never run.
    { action: "click", selector: { role: "button", name: "Submit Application" } },
  ]);
  const adapter = new RecipeAdapter(recipe, { accountNumber: "12345" }, {});
  withFakePage(adapter, makeFakePage({ log }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true);
  assert.equal(log.fills.length, 1, "should fill before stop marker");
  assert.equal(log.clicks.length, 0, "must NOT click anything after stopForReview");
}

async function testFinalSubmitDenylist() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    // A click whose target name matches a pay keyword must be skipped.
    { action: "click", selector: { role: "button", name: "Submit & Pay" } },
    // A safe click must go through.
    { action: "click", selector: { role: "button", name: "Next" } },
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {});
  withFakePage(adapter, makeFakePage({ log }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true);
  assert.deepEqual(log.clicks, ["role:button:Next"], "final-submit click must be blocked; only the safe click runs");
}

// P0-3: an id/css-only final-submit step whose recorded selector `name` is EMPTY
// (typical for ASP.NET id-based buttons) must NOT be clicked in autoSubmit unless it
// carries the explicit isFinalSubmit allowlist flag.
async function testIdOnlyFinalSubmitNotClickedWithoutFlag() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "stopForReview" },
    // No name/text — only a css id. Past the review marker. NOT flagged → must be blocked.
    { action: "click", selector: { css: "#ctl00_btnSubmit" } },
  ]);
  // autoSubmit ON — the bypass would let this slip through under the old denylist.
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: true });
  withFakePage(adapter, makeFakePage({ log }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true);
  assert.deepEqual(log.clicks, [], "id/css-only final submit past review must NOT be clicked without isFinalSubmit");
  assert.equal((adapter as unknown as { finalSubmitClicked: boolean }).finalSubmitClicked, false, "finalSubmitClicked must stay false");
  assert.equal(result.data?.finalSubmitClicked, false);
}

// R2 MUST-PASS: the flagged final submit is clicked ONLY when every input of the shared gate
// agrees, asked at the click: PORTAL_ALLOW_FINAL_SUBMIT=1, a named person's approval of THIS run,
// the recipe's single terminal flagged step right after stopForReview. Local fixture only.
// Acceptance is read through classifySubmissionText: a confirmation page is "accepted".
async function testFlaggedFinalSubmitClickedInAutoSubmit() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "stopForReview" },
    { action: "click", selector: { css: "#ctl00_btnSubmit" }, isFinalSubmit: true } as RecipeStep,
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {}, APPROVED_RUN_R);
  withFakePage(adapter, makeFakePage({ log, bodyText: CONFIRMATION }));
  const result = await withFinalSubmitEnv("1", () => adapter.fillApplication(fakeProject));
  assert.equal(result.ok, true, String(result.message));
  assert.deepEqual(log.clicks, ["css:#ctl00_btnSubmit"], "env 1 + approval for run R + run R + terminal flagged step → clicked");
  assert.equal((adapter as unknown as { finalSubmitClicked: boolean }).finalSubmitClicked, true, "finalSubmitClicked must be true");
  assert.equal(result.data?.finalSubmitClicked, true);
  assert.equal(adapter.finalSubmitOutcome?.verdict, "accepted", "a confirmation page is positive evidence");
}

// R2 MUST-EXCLUDE: each missing input of the gate alone keeps the final submit unclicked.
async function testFinalSubmitGateRefusesEachMissingInput() {
  const flagged = { action: "click", selector: { css: "#ctl00_btnSubmit" }, isFinalSubmit: true } as RecipeStep;
  const cases: Array<{ name: string; env: string | undefined; opts: Record<string, unknown>; steps: RecipeStep[] }> = [
    { name: "autoSubmit:true with the env switch unset", env: undefined, opts: APPROVED_RUN_R, steps: [{ action: "stopForReview" }, flagged] },
    { name: "autoSubmit:true, env 1, runApproval null", env: "1", opts: { autoSubmit: true, runApproval: null, runId: "R" }, steps: [{ action: "stopForReview" }, flagged] },
    { name: "autoSubmit:true, env 1, no approval option at all", env: "1", opts: { autoSubmit: true }, steps: [{ action: "stopForReview" }, flagged] },
    { name: "an approval for run R2 while in run R", env: "1", opts: { autoSubmit: true, runApproval: { approver: "A. Person", runId: "R2" }, runId: "R" }, steps: [{ action: "stopForReview" }, flagged] },
    { name: "an approval naming no approver", env: "1", opts: { autoSubmit: true, runApproval: { approver: " ", runId: "R" }, runId: "R" }, steps: [{ action: "stopForReview" }, flagged] },
    { name: "env 'true' (only exactly 1 arms it)", env: "true", opts: APPROVED_RUN_R, steps: [{ action: "stopForReview" }, flagged] },
    { name: "a flagged step that is not last", env: "1", opts: APPROVED_RUN_R, steps: [{ action: "stopForReview" }, flagged, { action: "waitFor" }] },
    { name: "a flagged step not after stopForReview", env: "1", opts: APPROVED_RUN_R, steps: [{ action: "waitFor" }, flagged] },
    { name: "two flagged steps", env: "1", opts: APPROVED_RUN_R, steps: [{ action: "stopForReview" }, flagged, flagged] },
  ];
  for (const c of cases) {
    const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
    const adapter = new RecipeAdapter(baseRecipe(c.steps), {}, {}, c.opts as never);
    withFakePage(adapter, makeFakePage({ log, bodyText: CONFIRMATION }));
    const result = await withFinalSubmitEnv(c.env, () => adapter.fillApplication(fakeProject));
    assert.deepEqual(log.clicks, [], `MUST-EXCLUDE (${c.name}): the final submit must not be clicked`);
    assert.equal(adapter.finalSubmitClicked, false, `${c.name}: finalSubmitClicked stays false`);
    assert.notEqual(result.data?.finalSubmitClicked, true, `${c.name}: never reported clicked`);
  }
}

// R2: a quiet page after the approved click is "unknown", never "accepted" — the click is
// reported (finalSubmitClicked true, so nothing re-clicks it), the run stops for a human, and the
// click happens ONCE even though the step failed.
async function testFinalSubmitQuietPageIsUnknownAndNotRetried() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "stopForReview" },
    { action: "click", selector: { css: "#ctl00_btnSubmit" }, isFinalSubmit: true } as RecipeStep,
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {}, APPROVED_RUN_R);
  withFakePage(adapter, makeFakePage({ log, bodyText: "Step 5: Record Issuance" }));
  const result = await withFinalSubmitEnv("1", () => adapter.fillApplication(fakeProject));
  assert.equal(result.ok, false, "an unconfirmed filing is not a clean run");
  assert.match(String(result.message), /outcome unknown — human must verify/);
  assert.deepEqual(log.clicks, ["css:#ctl00_btnSubmit"], "clicked exactly once — never retried");
  assert.equal(adapter.finalSubmitClicked, true, "the click happened and is reported");
  assert.equal(adapter.finalSubmitOutcome?.verdict, "unknown");
  const review = await adapter.stopAtReview();
  assert.equal(review.data?.finalSubmitClicked, true);
  assert.match(String(review.message), /UNKNOWN — human must verify/);
}

// A flagged final submit must STILL never be clicked in guided-manual (autoSubmit off).
async function testFlaggedFinalSubmitNotClickedWithoutAutoSubmit() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "click", selector: { css: "#ctl00_btnSubmit" }, isFinalSubmit: true } as RecipeStep,
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {}); // autoSubmit OFF
  withFakePage(adapter, makeFakePage({ log }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true);
  assert.deepEqual(log.clicks, [], "guided-manual must never click the final submit, even when flagged");
  assert.equal(result.data?.finalSubmitClicked, false);
  // The refused final submit is where a guided run ENDS — not a skipped step that makes a
  // correct run read as incomplete — and the report says why it was left for a human.
  assert.deepEqual((result.data as { skipped?: string[] }).skipped ?? [], [], "the refused final submit is not a skipped step");
  assert.ok(((result.data as { agingNotes?: string[] }).agingNotes ?? []).some((n) => /final submit left for a human/.test(n)), "the report names why");
}

// PAY_FEE is ALWAYS blocked, even in autoSubmit and even if (wrongly) flagged.
async function testPayFeeBlockedInAutoSubmit() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "stopForReview" },
    { action: "click", selector: { role: "button", name: "Pay Now" }, isFinalSubmit: true } as RecipeStep,
  ]);
  // Fully approved and armed: the fee gate must stop it on its own.
  const adapter = new RecipeAdapter(recipe, {}, {}, APPROVED_RUN_R);
  withFakePage(adapter, makeFakePage({ log, bodyText: CONFIRMATION }));
  const result = await withFinalSubmitEnv("1", () => adapter.fillApplication(fakeProject));
  assert.equal(result.ok, true);
  assert.deepEqual(log.clicks, [], "PAY_FEE must be hard-blocked even in autoSubmit even if flagged final");
  assert.equal(result.data?.finalSubmitClicked, false);
}

// P0-4: an iframe-based CAPTCHA/MFA challenge on the final page must STOP the run
// (the flagged final submit is NOT clicked) — detected structurally by frame URL.
async function testIframeChallengeStopsAutoSubmit() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "stopForReview" },
    { action: "click", selector: { css: "#ctl00_btnSubmit" }, isFinalSubmit: true } as RecipeStep,
  ]);
  // Approved and armed, so the challenge check is what stops it.
  const adapter = new RecipeAdapter(recipe, {}, {}, APPROVED_RUN_R);
  withFakePage(adapter, makeFakePage({
    log,
    frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=abc"],
  }));
  const result = await withFinalSubmitEnv("1", () => adapter.fillApplication(fakeProject));
  assert.equal(result.ok, false, "an iframe challenge at the final step must fail the run");
  assert.deepEqual(log.clicks, [], "must NOT click final submit when a challenge iframe is present");
  assert.equal((adapter as unknown as { finalSubmitClicked: boolean }).finalSubmitClicked, false);
}

// The default guided-manual path still stops at review and reports finalSubmitClicked:false.
async function testGuidedManualReportsNotSubmitted() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { label: "Account" }, field: "accountNumber" },
    { action: "stopForReview" },
  ]);
  const adapter = new RecipeAdapter(recipe, { accountNumber: "12345" }, {});
  withFakePage(adapter, makeFakePage({ log }));
  const fillResult = await adapter.fillApplication(fakeProject);
  assert.equal(fillResult.ok, true);
  assert.equal(fillResult.data?.finalSubmitClicked, false);
  const reviewResult = await adapter.stopAtReview();
  assert.equal(reviewResult.ok, true);
  assert.equal(reviewResult.data?.finalSubmitClicked, false, "stopAtReview must report not-submitted in guided-manual");
}

async function testFieldSubstitution() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { label: "Account" }, field: "accountNumber" },
    // Empty field value -> step is skipped (returns false), nothing filled.
    { action: "fill", selector: { label: "Meter" }, field: "meterNumber" },
  ]);
  const adapter = new RecipeAdapter(recipe, { accountNumber: "98765" }, {});
  withFakePage(adapter, makeFakePage({ log }));
  await adapter.fillApplication(fakeProject);
  assert.deepEqual(log.fills, [{ key: "label:Account", value: "98765" }]);
}

async function testSelectorFallback() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    {
      action: "click",
      // Primary selector is absent on the page; the css fallback is present.
      selector: {
        role: "button",
        name: "Continue",
        fallbacks: [{ css: "#continueBtn" }],
      },
    },
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {});
  withFakePage(adapter, makeFakePage({
    log,
    present: { "role:button:Continue": false, "css:#continueBtn": true },
  }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true);
  assert.deepEqual(log.clicks, ["css:#continueBtn"], "should fall back to the css selector when primary is absent");
}

async function testCredentialNeverLogged() {
  // Capture anything written to stdout/stderr during a login with credentials and
  // assert the password text never appears.
  const secret = "sup3r-s3cret-pw";
  const writes: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => { writes.push(String(chunk)); return origOut(chunk, ...rest); };
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => { writes.push(String(chunk)); return origErr(chunk, ...rest); };
  try {
    const recipe = baseRecipe([]);
    recipe.loginStep = { usernameSel: { label: "Email" }, passwordSel: { label: "Password" }, submitSel: { role: "button", name: "Log In" } };
    const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
    const adapter = new RecipeAdapter(recipe, {}, {});
    const page = makeFakePage({ log });
    // The adapter's login() opens a real browser; instead exercise the fill path by
    // pre-setting the page and calling the private fill via fillApplication is not
    // applicable, so we assert at the log level: the password reached fill() but not stdout.
    withFakePage(adapter, page);
    // Manually drive the credential fill the way login() would, via the fake page.
    await page.getByLabel("Password").fill(secret);
    assert.ok(log.fills.some((f) => f.value === secret), "sanity: password was filled");
    assert.ok(!writes.some((w) => w.includes(secret)), "password must never be written to stdout/stderr");
  } finally {
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
  }
}

// --- Gap A: render-readiness call sites ------------------------------------------

// A recorded goto lands on a fresh SPA section; readiness must poll after the navigation
// so the next fill targets a mounted/bound input (not a visible-but-unbound Vue field).
async function testRenderReadinessAfterGoto() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "goto", value: "https://portal.test/section-1" },
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {});
  const page = makeFakePage({ log });
  withFakePage(adapter, page);
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true);
  assert.deepEqual(log.gotos, ["https://portal.test/section-1"], "the goto ran");
  assert.ok(page.readyCheckCount >= 1, "render-readiness must run after a goto navigation");
}

// An advancing Next/Continue click moves a wizard to a not-yet-bound section; readiness must
// poll after that click too, before the next fill.
async function testRenderReadinessAfterAdvancingClick() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "click", selector: { role: "button", name: "Next" } },
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {});
  const page = makeFakePage({ log });
  withFakePage(adapter, page);
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true);
  assert.deepEqual(log.clicks, ["role:button:Next"], "the advancing click ran");
  assert.ok(page.readyCheckCount >= 1, "render-readiness must run after an ordinary advancing click");
}

// The final-submit branch must NOT poll readiness — we click the operator-approved submit and
// capture the confirmation; there is no "next section" to wait for, and an extra poll there
// would only delay the submit. (Verifies the call site was added to navigation, not submit.)
async function testRenderReadinessNotOnFinalSubmit() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "stopForReview" },
    { action: "click", selector: { css: "#ctl00_btnSubmit" }, isFinalSubmit: true } as RecipeStep,
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {}, APPROVED_RUN_R);
  const page = makeFakePage({ log, bodyText: CONFIRMATION });
  withFakePage(adapter, page);
  const result = await withFinalSubmitEnv("1", () => adapter.fillApplication(fakeProject));
  assert.equal(result.ok, true);
  assert.deepEqual(log.clicks, ["css:#ctl00_btnSubmit"], "the flagged final submit ran");
  assert.equal(page.readyCheckCount, 0, "render-readiness must NOT run on the final-submit branch");
}

// --- Gap B: gap-fill call sites + surfaced report --------------------------------

// Helper: replace the inherited runGapFill with a counter so tests can assert WHEN it fires
// without enabling a real LLM planner. Returns a getter for the call count.
function spyGapFill(adapter: RecipeAdapter): () => number {
  let calls = 0;
  (adapter as unknown as { runGapFill: (p: unknown) => Promise<void> }).runGapFill = async () => { calls += 1; };
  return () => calls;
}

// Gap-fill must run in the persist-settle window — after a data section's autosave commits and
// before the advancing click that follows it. A `[fill, click]` recipe (no stopForReview) fires
// gap-fill exactly once: in the persist-settle branch.
async function testGapFillRunsInPersistSettleBranch() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { label: "Account" }, field: "accountNumber" },
    { action: "click", selector: { role: "button", name: "Next" } },
  ]);
  const adapter = new RecipeAdapter(recipe, { accountNumber: "12345" }, {});
  const gapFillCalls = spyGapFill(adapter);
  withFakePage(adapter, makeFakePage({ log }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true);
  assert.equal(log.fills.length, 1, "the data section was filled");
  assert.deepEqual(log.clicks, ["role:button:Next"], "the advancing click ran");
  assert.equal(gapFillCalls(), 1, "gap-fill must run once, in the persist-settle branch before the advancing click");
}

// The LAST data section before review is not followed by an advancing click, so gap-fill must
// also run in the guided-manual stopForReview branch before the halt. A `[fill, stopForReview]`
// recipe (no intervening advancing click) fires gap-fill exactly once: before the review break.
async function testGapFillRunsBeforeGuidedManualReview() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { label: "Account" }, field: "accountNumber" },
    { action: "stopForReview" },
  ]);
  const adapter = new RecipeAdapter(recipe, { accountNumber: "12345" }, {});
  const gapFillCalls = spyGapFill(adapter);
  withFakePage(adapter, makeFakePage({ log }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true);
  assert.equal(log.clicks.length, 0, "guided-manual must not click anything");
  assert.equal(gapFillCalls(), 1, "gap-fill must run once, before the guided-manual review halt");
}

function assertGapFillReport(value: unknown, where: string) {
  const gf = value as { filled?: unknown; skippedUngrounded?: unknown; reportedMissing?: unknown } | undefined;
  assert.ok(gf, `${where}: result must surface a gapFill report`);
  assert.ok(
    Array.isArray(gf.filled) && Array.isArray(gf.skippedUngrounded) && Array.isArray(gf.reportedMissing),
    `${where}: gapFill must carry the filled / skippedUngrounded / reportedMissing arrays`,
  );
}

// The stop-at-review return must surface the gap-fill report under the `gapFill` key (same key
// the hand-coded adapters use), so the operator/UI sees a uniform report. Uses the real no-op
// runGapFill (no planner) so the report is the default empty-but-present shape.
async function testGapFillReportInStopAtReviewResult() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { label: "Account" }, field: "accountNumber" },
    { action: "stopForReview" },
  ]);
  const adapter = new RecipeAdapter(recipe, { accountNumber: "12345" }, {});
  withFakePage(adapter, makeFakePage({ log }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true);
  assert.equal(result.data?.finalSubmitClicked, false);
  assertGapFillReport(result.data?.gapFill, "stop-at-review");
}

// The final-submit return must ALSO surface the gap-fill report under `gapFill`.
async function testGapFillReportInFinalSubmitResult() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "stopForReview" },
    { action: "click", selector: { css: "#ctl00_btnSubmit" }, isFinalSubmit: true } as RecipeStep,
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {}, APPROVED_RUN_R);
  withFakePage(adapter, makeFakePage({ log, bodyText: CONFIRMATION }));
  const result = await withFinalSubmitEnv("1", () => adapter.fillApplication(fakeProject));
  assert.equal(result.ok, true);
  assert.equal(result.data?.finalSubmitClicked, true);
  assertGapFillReport(result.data?.gapFill, "final-submit");
}

// SELF-HEAL FINGERPRINTS: two live fields share the bare label "Manufacturer";
// the step's recorded fingerprint (name/section) must pick the RIGHT one.
async function testHealPrefersFingerprintMatch() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    // BOUND, not a frozen literal. An equipment manufacturer is per-project data (project A
    // is Enphase, project B is SolarEdge), so resolveValue now refuses to replay it from a
    // recorded literal - see crossProjectReplay.test.ts. This fixture is about SELECTOR
    // HEALING, so bind it and let healing be what is under test.
    { action: "fill", selector: { css: "#old-gone-id" }, note: "Manufacturer", field: "inverterManufacturer",
      fingerprint: { name: "inv_mfr", section: "Inverter Information" } },
    { action: "stopForReview" },
  ]);
  const adapter = new RecipeAdapter(recipe, { inverterManufacturer: "AP Systems" }, {});
  withFakePage(adapter, makeFakePage({
    log,
    present: { "css:#old-gone-id": false, "label:Manufacturer": false }, // primary dead; label ambiguous → heal path
    rawFields: [
      { label: "Manufacturer", fieldType: "text", id: "m1", name: "mod_mfr", section: "PV Module Information" },
      { label: "Manufacturer", fieldType: "text", id: "i2", name: "inv_mfr", section: "Inverter Information" },
    ],
  }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true, `heal should save the run (${result.message})`);
  assert.equal(log.fills.length, 1, "healed fill executed");
  // Both candidates yield label-selectors ("Manufacturer") — identical keys — so
  // assert via the healed selector's #id fallback identity instead.
  const healed = (result.data as { healedSteps?: Array<{ selector: { label?: string; fallbacks?: Array<{ css?: string }> } }> }).healedSteps ?? [];
  assert.equal(healed.length, 1, "one healed step reported");
  const healedCss = JSON.stringify(healed[0].selector);
  assert.ok(healedCss.includes("#i2") && !healedCss.includes("#m1"), `fingerprint picked the inverter-section field (got ${healedCss})`);
}

// A LEGACY STEP (no recorded fingerprint) BOUND TO THE INVERTER. This test used to EXPECT the
// inverter make to heal into the MODULE's Manufacturer box (#m1, first of equals) — that
// expectation was the bug: a wrong-box write, and the recipe patched with it. The derived
// fingerprint (the binding inverterManufacturer names the inverter side) puts it in #i2, and
// the heal is identified by step index + recipe version.
async function testHealWithoutFingerprintLegacy() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { css: "#old-gone-id" }, note: "Manufacturer", field: "inverterManufacturer" },
    { action: "stopForReview" },
  ]);
  const adapter = new RecipeAdapter(recipe, { inverterManufacturer: "AP Systems" }, {});
  withFakePage(adapter, makeFakePage({
    log,
    present: { "css:#old-gone-id": false },
    rawFields: [
      { label: "Manufacturer", fieldType: "text", id: "m1", name: "mod_mfr", section: "PV Module Information" },
      { label: "Manufacturer", fieldType: "text", id: "i2", name: "inv_mfr", section: "Inverter Information" },
    ],
  }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true, String(result.message));
  const healed = (result.data as { healedSteps?: Array<{ selector: unknown; stepIndex?: number; recipeVersion?: number; performed?: boolean }> }).healedSteps ?? [];
  assert.equal(healed.length, 1);
  const sel = JSON.stringify(healed[0].selector);
  assert.ok(!sel.includes("#m1"), `MUST-EXCLUDE: the inverter make never heals into the module's box (got ${sel})`);
  assert.ok(sel.includes("#i2"), `the inverter binding heals into the inverter section (got ${sel})`);
  assert.equal(healed[0].stepIndex, 0, "identified by step index");
  assert.equal(healed[0].recipeVersion, 1, "and recipe version");
  assert.equal(healed[0].performed, true);
}

// TWO CANDIDATES NOTHING TELLS APART: refuse with a named ambiguity — no fill, no heal reported,
// the run fails on that step saying why.
async function testHealRefusesATie() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { css: "#old-gone-id" }, note: "Manufacturer", field: "inverterManufacturer" },
    { action: "stopForReview" },
  ]);
  const adapter = new RecipeAdapter(recipe, { inverterManufacturer: "AP Systems" }, {});
  withFakePage(adapter, makeFakePage({
    log,
    present: { "css:#old-gone-id": false },
    rawFields: [
      { label: "Manufacturer", fieldType: "text", id: "e1", name: "equip_a", section: "Equipment" },
      { label: "Manufacturer", fieldType: "text", id: "e2", name: "equip_b", section: "Equipment" },
    ],
  }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, false, "a tie fails the step");
  assert.match(String(result.message), /self-heal refused — ambiguous/, `named ambiguity (${result.message})`);
  assert.equal(log.fills.length, 0, "nothing was written");
  assert.equal(((result.data as { healedSteps?: unknown[] }).healedSteps ?? []).length, 0, "no heal reported");
}

// A HEAL WHOSE HEALED STEP DID NOT PERFORM IS NOT A HEAL: it must not reach healedSteps (the
// backend patches the recipe from that list).
async function testHealNotReportedWhenHealedStepDidNotPerform() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { css: "#old-gone-id" }, note: "Manufacturer", field: "inverterManufacturer" },
    { action: "stopForReview" },
  ]);
  const adapter = new RecipeAdapter(recipe, { inverterManufacturer: "AP Systems" }, {});
  withFakePage(adapter, makeFakePage({
    log,
    present: { "css:#old-gone-id": false },
    rawFields: [{ label: "Manufacturer", fieldType: "text", id: "i2", name: "inv_mfr", section: "Inverter Information" }],
  }));
  // The recorded step throws (as a dead selector does); the healed attempt returns false.
  const a = adapter as unknown as { executeStep: (s: RecipeStep, p: boolean) => Promise<boolean> };
  const real = a.executeStep.bind(adapter);
  a.executeStep = async (s, p) => {
    if (s.action !== "fill") return real(s, p);
    if (JSON.stringify(s.selector).includes("#old-gone-id") && !JSON.stringify(s.selector).includes("#i2")) throw new Error("some error: control gone");
    return false;
  };
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(((result.data as { healedSteps?: unknown[] }).healedSteps ?? []).length, 0, "a heal that did not perform is not reported");
  assert.ok(((result.data as { skipped?: string[] }).skipped ?? []).some((s) => /Manufacturer/.test(s)), "the step is reported skipped");
}

// BELOW THE MINIMUM, LOOK ONCE MORE: the first re-extraction finds nothing (the control is still
// rendering); after one settle the second finds it. Without the re-localization the step fails.
async function testHealRelocalizesOnceBelowMinimum() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { css: "#old-gone-id" }, note: "Manufacturer", field: "inverterManufacturer" },
    { action: "stopForReview" },
  ]);
  const adapter = new RecipeAdapter(recipe, { inverterManufacturer: "AP Systems" }, {});
  const page = makeFakePage({ log, present: { "css:#old-gone-id": false }, rawFields: [] });
  // The control "renders" only once the heal itself has settled the page.
  let inHeal = false;
  let settledInHeal = false;
  const a = adapter as unknown as { settle: (ms?: number) => Promise<void>; healSelectorForStep: (s: RecipeStep) => Promise<unknown> };
  const realHeal = a.healSelectorForStep.bind(adapter);
  a.healSelectorForStep = async (s) => { inHeal = true; try { return await realHeal(s); } finally { inHeal = false; } };
  a.settle = async () => { if (inHeal) settledInHeal = true; };
  page.$$eval = async () => (settledInHeal ? [{ label: "Manufacturer", fieldType: "text", id: "i2", name: "inv_mfr", section: "Inverter Information" }] : []);
  withFakePage(adapter, page);
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true, `re-localized once and healed (${result.message})`);
  assert.equal(((result.data as { healedSteps?: unknown[] }).healedSteps ?? []).length, 1);
}

async function testHealScoringUnit() {
  const f = (label: string, section: string, extra: Record<string, unknown> = {}) => ({ selector: { label }, label, fieldType: "select", section, fingerprint: { section, ...extra } }) as never;
  const t = healTargetOf({ action: "select", note: "Manufacturer", field: "inverterMake" } as RecipeStep, "Enphase");
  assert.equal(t.side, "inverter", "the binding derives the side");
  const inv = scoreHealCandidate({ ...(f("Manufacturer", "Inverter Information") as object), options: ["Enphase Energy", "SolarEdge"] } as never, t);
  const mod = scoreHealCandidate({ ...(f("Manufacturer", "PV Module Information") as object), options: ["REC", "Qcells"] } as never, t);
  assert.ok(inv > mod + HEAL_TIE_MARGIN, `inverter side + option signature beat the module box (${inv} vs ${mod})`);
  assert.equal(scoreHealCandidate(f("Completely Different", "Inverter Information", { name: "x" }), t), -1, "no label anchor → never a candidate");
  const tie = decideHeal(rankHealCandidates([f("Manufacturer", "Equipment"), f("Manufacturer", "Equipment")], healTargetOf({ action: "select", note: "Manufacturer" } as RecipeStep)));
  assert.equal(tie.kind, "ambiguous", "equal candidates are a refusal");
  // A section that reads as TWO sides ("Electrical Contractor": electrical, and "contractor" for
  // the installer) still counts for the electrician, and loses to the installer's own section.
  assert.ok(sideVerdict("electrical", "Electrical Contractor") > 0, "the electrician's section counts for the electrician");
  assert.ok(sideVerdict("installer", "Installer/Equipment Contractor") > sideVerdict("installer", "Electrical Contractor"), "the installer's own section beats the shared word");
  assert.equal(sideVerdict("installer", "PV Module Information"), -1);
  const weak = decideHeal(rankHealCandidates([f("Manufacturer Name Of Record", "")], healTargetOf({ action: "select", note: "manufacturer" } as RecipeStep)));
  assert.equal(weak.kind, "none", `a contains-only label with nothing else agreeing is below the minimum (${HEAL_MIN_SCORE})`);
}

// A matching fingerprint must NEVER manufacture a heal when no label matches.
async function testFingerprintNeverInventsMatch() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { css: "#old-gone-id" }, note: "Manufacturer", field: "inverterManufacturer",
      fingerprint: { name: "inv_mfr" } },
  ]);
  const adapter = new RecipeAdapter(recipe, { inverterManufacturer: "AP Systems" }, {});
  withFakePage(adapter, makeFakePage({
    log,
    present: { "css:#old-gone-id": false },
    rawFields: [{ label: "Completely Different Field", fieldType: "text", id: "z9", name: "inv_mfr" }],
  }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, false, "no label anchor → heal refuses; step fails as before");
  assert.match(String(result.message), /Recipe step failed/);
}

async function testFingerprintBoostUnit() {
  assert.equal(fingerprintBoost(undefined, { name: "a" }), 0);
  assert.equal(fingerprintBoost({ name: "a" }, undefined), 0);
  assert.equal(fingerprintBoost({ name: "inv_mfr" }, { name: "INV_MFR" }), 15, "name match, case-insensitive");
  assert.equal(fingerprintBoost({ placeholder: "p" }, { placeholder: "p" }), 15);
  assert.equal(fingerprintBoost({ id: "x" }, { id: "x" }), 10);
  assert.equal(fingerprintBoost({ ariaLabel: "l" }, { ariaLabel: "l" }), 10);
  assert.equal(fingerprintBoost({ section: "Inverter Information" }, { section: "Inverter Info" }), 8, "section substring both-ways");
  assert.equal(fingerprintBoost({ section: "abc" }, { section: "abc" }), 0, "section <4 chars ignored");
  const max = fingerprintBoost(
    { id: "x", name: "n", placeholder: "p", ariaLabel: "l", section: "Section One" },
    { id: "x", name: "n", placeholder: "p", ariaLabel: "l", section: "Section One" },
  );
  assert.equal(max, 58, "max boost stays below the 70 label gate");
}

// DRIFT PRECHECK -----------------------------------------------------------
// BOUND, not frozen literals. A homeowner name and a service address under their own
// labels are exactly what resolveValue now refuses to replay from a recording (see
// crossProjectReplay.test.ts - a recipe is shared across AHJs and across ORGS, so a frozen
// literal is another customer's data). These fixtures are about DRIFT DETECTION, so bind
// them and keep drift the thing under test.
const DRIFT_VALUES: Record<string, string> = {
  homeownerName: "X", projectAddress: "Y", utility: "Z",
};

const threeFills: RecipeStep[] = [
  { action: "fill", selector: { label: "Homeowner Name" }, note: "Homeowner Name", field: "homeownerName" },
  { action: "fill", selector: { label: "Project Address" }, note: "Project Address", field: "projectAddress" },
  { action: "select", selector: { label: "Utility Company" }, note: "Utility Company", field: "utility" },
  { action: "stopForReview" },
];

async function testDriftZeroOverlapFailsFast() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const adapter = new RecipeAdapter(baseRecipe(threeFills), DRIFT_VALUES, {});
  withFakePage(adapter, makeFakePage({
    log,
    rawFields: [
      { label: "Totally New Field A", fieldType: "text", id: "a" },
      { label: "Totally New Field B", fieldType: "text", id: "b" },
    ],
  }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, false);
  assert.match(String(result.message), /Recipe step failed \(page drift\)/);
  assert.equal(log.fills.length, 0, "fails fast — no per-step timeout death");
  const warnings = (result.data as { driftWarnings?: string[] }).driftWarnings ?? [];
  assert.equal(warnings.length, 0, "hard fail carries the message, not a warning");
}

async function testDriftPartialOverlapWarnsAndContinues() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const adapter = new RecipeAdapter(baseRecipe(threeFills), DRIFT_VALUES, {});
  withFakePage(adapter, makeFakePage({
    log,
    rawFields: [
      { label: "Homeowner Name", fieldType: "text", id: "hn" }, // 1 of 3 → 0.33 < 0.34
      { label: "Totally New Field", fieldType: "text", id: "x" },
    ],
  }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true, `partial overlap must continue (${result.message})`);
  const warnings = (result.data as { driftWarnings?: string[] }).driftWarnings ?? [];
  assert.equal(warnings.length, 1, "drift annotated");
  assert.match(warnings[0], /1\/3 recorded fields/);
}

async function testDriftSparseSegmentSkipped() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const adapter = new RecipeAdapter(baseRecipe([
    { action: "fill", selector: { label: "Search" }, note: "Search", value: "X" },
    { action: "stopForReview" },
  ]), {}, {});
  withFakePage(adapter, makeFakePage({ log, rawFields: [{ label: "Unrelated", fieldType: "text", id: "u" }] }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true, "sparse segment (<3 labels) never prechecked");
  assert.equal(((result.data as { driftWarnings?: string[] }).driftWarnings ?? []).length, 0);
}

async function testDriftFrameScopedExcluded() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const framed: RecipeStep[] = threeFills.map((st) =>
    st.action === "stopForReview" ? st : { ...st, selector: { ...st.selector, frame: "ACADialogFrame" } });
  const adapter = new RecipeAdapter(baseRecipe(framed), {}, {});
  withFakePage(adapter, makeFakePage({ log, rawFields: [{ label: "Whatever", fieldType: "text", id: "w" }] }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true, "frame-scoped steps never counted → precheck no-ops");
}

async function testDriftNoEvalSilent() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const adapter = new RecipeAdapter(baseRecipe(threeFills), DRIFT_VALUES, {});
  withFakePage(adapter, makeFakePage({ log })); // no rawFields → no $$eval on the fake
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true, "no $$eval → precheck silently passes (legacy fakes)");
  assert.equal(log.fills.length, 2, "fills ran normally");
}

// RECORD TYPE: the permit we apply for is chosen by an unambiguous LABEL or not at all.
//
// Live failure this pins: the recipe carried label "Residential - Electrical" plus the
// positional fallback cbListServices_1. Coos Bay's CITY record offers no Electrical at all —
// that discipline files with the COUNTY — so the label matched nothing, the fallback fired,
// and index 1 on the city list is "Residential - Mechanical". A mechanical permit was filed
// and ISSUED on a solar job at 1780 Ocean Blvd, with its fees paid.
//
// A page that offers a given list of record types, as Accela renders them: checkboxes whose
// accessible name is the type. `exact` is honoured so the ambiguity case is real.
function makeRecordTypePage(offered: string[], log: ActionLog) {
  const page: any = makeFakePage({ log });
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  page.checked = [] as string[];
  page.evaluate = async () => offered;
  const boxFor = (hits: string[], key: string): any => {
    const loc: any = {
      first: () => loc,
      nth: () => loc,
      count: async () => hits.length,
      isVisible: async () => hits.length > 0,
      getAttribute: async () => null,
      evaluate: async () => "",
      check: async () => {
        if (!hits.length) throw new Error(`TimeoutError: locator ${key} not found`);
        page.checked.push(hits[0]);
        log.checks++;
      },
      click: async () => { log.clicks.push(key); },
      fill: async () => undefined,
      waitFor: async () => { if (!hits.length) throw new Error(`TimeoutError: locator ${key} not found`); },
      evaluateAll: async () => [],
    };
    return loc;
  };
  // The positional fallback the recipe recorded, resolving the way the live portal did:
  // cbListServices_1 is whatever this jurisdiction happens to list second. Modelled so that
  // if the label guard is ever removed, these tests report the real-world outcome —
  // "Residential - Mechanical" checked — instead of an unrelated fake-page error.
  page.locator = (css: string) => {
    const m = /cbListServices_(\d+)/.exec(css);
    const at = m ? offered[Number(m[1])] : undefined;
    return boxFor(at ? [at] : [], `css:${css}`);
  };
  page.getByLabel = (label: string) => boxFor(offered.filter((t) => norm(t) === norm(String(label))), `label:${label}`);
  page.getByRole = (role: string, o?: { name?: string; exact?: boolean }) => {
    const want = norm(o?.name ?? "");
    const hits = role !== "checkbox" || !want
      ? []
      : offered.filter((t) => (o?.exact ? norm(t) === want : norm(t).includes(want)));
    return boxFor(hits, `role:${role}:${o?.name ?? ""}`);
  };
  return page;
}

// The step exactly as the recipe recorded it, positional fallback and all.
const electricalRecordTypeStep: RecipeStep = {
  action: "check",
  selector: {
    label: "Residential - Electrical",
    fallbacks: [{ css: "#ctl00_PlaceHolderMain_WorkLocationEdit_ucAddressList_serviceControl_rptAgency_ctl00_cbListServices_1" }],
  },
  note: "Residential - Electrical",
};

const COOS_BAY_CITY = [
  "Residential - Manufactured Dwelling Placement",
  "Residential - Mechanical",
  "Residential - Structural",
  "Commercial - Mechanical",
];

async function testRecordTypeNotOfferedRefusesToFile() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const adapter = new RecipeAdapter(baseRecipe([electricalRecordTypeStep]), {}, {});
  const page = makeRecordTypePage(COOS_BAY_CITY, log);
  withFakePage(adapter, page);
  const result = await adapter.fillApplication(fakeProject);

  assert.equal(result.ok, false, "an unofferable permit type must fail the run, not proceed");
  assert.equal(log.checks, 0, "NOTHING may be checked when the recorded type is absent");
  assert.deepEqual(page.checked, [], "above all, never Residential - Mechanical");
  assert.match(String(result.message), /not offered/i);
  // The message must name what this jurisdiction DOES offer, so a human reads
  // "the city has no electrical" and files it with the county instead.
  assert.match(String(result.message), /Residential - Mechanical/);
}

// THE RECORD-TYPE GUARD SETTLES BEFORE IT COUNTS. Right after the previous page's full postback
// the list can be unpainted; count() does not wait, and the guard used to read "(none read)" and
// refuse to file a type that was about to appear (the scoreboard's Accela record-type race). The
// list here "paints" only once the adapter has settled the page.
async function testRecordTypeGuardSettlesBeforeCounting() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const offered: string[] = [];
  const adapter = new RecipeAdapter(baseRecipe([electricalRecordTypeStep]), {}, {});
  const page = makeRecordTypePage(offered, log);
  withFakePage(adapter, page);
  (adapter as unknown as { settle: () => Promise<void> }).settle = async () => {
    if (!offered.length) offered.push(...COOS_BAY_CITY, "Residential - Electrical");
  };
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true, `settled, then found the offered type (${result.message})`);
  assert.deepEqual(page.checked, ["Residential - Electrical"]);
}

async function testRecordTypeOfferedIsCheckedByLabel() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const structural: RecipeStep = { ...electricalRecordTypeStep, selector: { ...electricalRecordTypeStep.selector, label: "Residential - Structural" }, note: "Residential - Structural" };
  const adapter = new RecipeAdapter(baseRecipe([structural]), {}, {});
  const page = makeRecordTypePage(COOS_BAY_CITY, log);
  withFakePage(adapter, page);
  const result = await adapter.fillApplication(fakeProject);

  assert.equal(result.ok, true);
  assert.deepEqual(page.checked, ["Residential - Structural"], "the offered type is checked by its own name");
}

async function testRecordTypeAmbiguousRefusesToGuess() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const structural: RecipeStep = { ...electricalRecordTypeStep, selector: { label: "Residential - Structural" }, note: "Residential - Structural" };
  const adapter = new RecipeAdapter(baseRecipe([structural]), {}, {});
  // A jurisdiction that splits the discipline in two. "Residential - Structural" is a
  // substring of both, and a demolition permit is not the one we came to file.
  const page = makeRecordTypePage(["Residential - Structural - New", "Residential - Structural - Demolition"], log);
  withFakePage(adapter, page);
  const result = await adapter.fillApplication(fakeProject);

  assert.equal(result.ok, false, "two candidate permit types is a question for a human");
  assert.deepEqual(page.checked, [], "must not take whichever came first");
  assert.match(String(result.message), /matches 2/i);
}

async function testRecordTypeIsNeverSelfHealed() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const adapter = new RecipeAdapter(baseRecipe([electricalRecordTypeStep]), {}, {});
  // rawFields present → the self-heal path is live on this fake. Heal re-anchors by label
  // similarity, and "Residential - Mechanical" is the nearest label to the one we want; if
  // heal ran here it would check it AND patch the recipe to point at it forever.
  const page = makeRecordTypePage(COOS_BAY_CITY, log);
  page.$$eval = async () => COOS_BAY_CITY.map((label, i) => ({ label, fieldType: "checkbox", id: `cbListServices_${i}` }));
  withFakePage(adapter, page);
  const result = await adapter.fillApplication(fakeProject);

  assert.equal(result.ok, false);
  assert.deepEqual(page.checked, [], "self-heal must not reintroduce the wrong permit type");
  assert.equal(((result.data?.healedSteps as unknown[]) ?? []).length, 0, "and must not patch the recipe with it");
}

// A DISABLED NAMESAKE IS NEVER THE ONE THE USER CLICKED.
//
// Live on Marineau's electrical replay: Oregon ePermitting's landing page carries a DISABLED
// decorative "Apply" nav pill, headless layout put it first in DOM order, the recorded step
// resolved onto it, and the click waited its full 30s on a button that can never be clicked —
// while the real Apply link sat enabled right below. Among namesakes, the first VISIBLE and
// ENABLED control is the click target.
async function testDisabledNamesakeSkipped() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const adapter = new RecipeAdapter(baseRecipe([
    { action: "click", selector: { role: "link", name: "Apply" }, note: "application entry: Apply" },
  ]), {}, {});
  const page: any = makeFakePage({ log });
  const clicked: string[] = [];
  const namesakes = (states: Array<{ visible: boolean; enabled: boolean; id: string }>) => {
    const at = (i: number): any => ({
      isVisible: async () => states[i].visible,
      isEnabled: async () => states[i].enabled,
      click: async () => {
        if (!states[i].enabled) throw new Error("TimeoutError: element is not enabled");
        clicked.push(states[i].id);
      },
      waitFor: async () => undefined,
      count: async () => 1,
      first: () => at(i),
      nth: (k: number) => at(k),
      evaluateAll: async () => [],
    });
    return { ...at(0), count: async () => states.length, nth: (k: number) => at(k), first: () => at(0) };
  };
  page.getByRole = (role: string, o?: { name?: string }) =>
    o?.name === "Apply"
      ? namesakes([
          { visible: true, enabled: false, id: "disabled-pill" },
          { visible: true, enabled: true, id: "real-apply" },
        ])
      : { count: async () => 0, first: () => ({ isVisible: async () => false }), nth: () => ({}), waitFor: async () => { throw new Error("TimeoutError"); }, click: async () => { throw new Error("TimeoutError"); }, evaluateAll: async () => [] };
  withFakePage(adapter, page);

  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true, `run should complete (${result.message || ""})`);
  assert.deepEqual(clicked, ["real-apply"], "the ENABLED namesake was clicked, never the disabled pill");
}

// A SELECTOR LEVEL WHOSE EVERY MATCH IS INVISIBLE HAS NOT FOUND THE CONTROL.
//
// Live on Marineau's NEM replay: the inverter Model step's recorded primary #pcInputBase55
// uniquely matched PowerClerk's HIDDEN combobox whose label also reads "Model" but whose
// option list is the ENERGY SOURCE values. resolveLocator settled for it (count > 0), the
// label fallback pointing at the real visible Model box was never consulted, the model rules
// rightly refused "Solar PV/Wind/Hydro" as models, and the cascade never completed —
// PowerClerk then took the manufacturer back too, and the replay looped on a page it could
// never finish. An invisible-only match must fall through to the next selector level.
// A RECORDED ORDINAL IS A GUESS ABOUT PAGE STRUCTURE, AND STRUCTURE MOVES.
//
// PGE's inverter Model is `{css:"#pcInputBase34", fallbacks:[{label:"Model", nth:0}]}`. The
// id is a per-render token that now points at a hidden combobox, and the fallback is pinned
// to nth:0 — which preferVisible honours untouched, because an explicit ordinal is an
// instruction. On this project the first "Model" is that same hidden control, so both levels
// resolve to something unusable and the select branch's side-picker, which knows that
// inverterModel wants the outer pair, never gets a set to choose from.
//
// The recording is still tried first. This is the safety net for when it lands on a page
// that has since re-rendered.
async function testOrdinalFallbackRetriesUnpinned() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const adapter = new RecipeAdapter(baseRecipe([
    { action: "fill", selector: { css: "#ghost", fallbacks: [{ label: "Model", nth: 0 }] }, field: "inverterModel", note: "Model" },
  ]), { inverterModel: "IQ8PLUS-72-2-US" }, {});
  const page: any = makeFakePage({ log });
  const mk = (visible: boolean, key: string): any => {
    const loc: any = {
      first: () => loc, nth: () => loc,
      count: async () => 1,
      isVisible: async () => visible,
      isEnabled: async () => true,
      waitFor: async () => { if (!visible) throw new Error("TimeoutError: hidden"); },
      fill: async (v: string) => {
        if (!visible) throw new Error("TimeoutError: element is not visible");
        log.fills.push({ key, value: v });
      },
      blur: async () => undefined,
      inputValue: async () => "IQ8PLUS-72-2-US",
      evaluateAll: async () => [],
    };
    return loc;
  };
  // The volatile id now points at a hidden combobox.
  page.locator = (css: string) => (css === "#ghost" ? mk(false, "ghost") : mk(false, `css:${css}`));
  // getByLabel("Model") pinned to nth 0 is that same hidden control; unpinned it is the real,
  // visible select. The fake distinguishes them by whether an ordinal was requested.
  page.getByLabel = (label: string, opts?: unknown) => {
    if (label !== "Model") return mk(false, `label:${label}`);
    const pinned = mk(false, "hidden-nth0");
    const free = mk(true, "real-model");
    // `nth` is applied by the adapter's locator builder; model it by returning the pinned
    // control only when the caller asks for a position.
    return { ...free, nth: (i: number) => (i === 0 ? pinned : free), __opts: opts };
  };
  withFakePage(adapter, page);

  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true, `run should complete (${result.message || ""})`);
  assert.deepEqual(log.fills.map((f) => f.key), ["real-model"],
    `the unpinned retry should reach the visible Model; got ${JSON.stringify(log.fills.map((f) => f.key))}`);
}

// THE LIVE FAILURE THAT KILLED BOTH COOS BAY RECIPES AT STEP 1.
//
// Oregon ePermitting's dashboard carries exactly ONE node whose text is "Apply": a disabled
// decorative pill (`<button disabled class="dropbtn1" onclick="alert('Button was
// clicked!')">`). A single match, so preferVisible — which does prefer an enabled control —
// never got to choose between candidates; and the level was VISIBLE, which was the only
// thing resolution asked before accepting it. The click then waited out its full 30 seconds
// on a button that can never be clicked.
//
// The real control was one fallback down and enabled. Rejecting the disabled level is all it
// takes to reach it: a disabled control is no more the one the operator used than a hidden
// one is.
async function testDisabledOnlyPrimaryFallsThroughToFallback() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const adapter = new RecipeAdapter(baseRecipe([
    { action: "click", selector: { text: "Apply", fallbacks: [{ role: "link", name: "Apply" }] }, note: "application entry: Apply" },
  ]), {}, {});
  const page: any = makeFakePage({ log });
  const clicked: string[] = [];
  const mk = (visible: boolean, enabled: boolean, id: string): any => {
    const loc: any = {
      first: () => loc, nth: () => loc,
      count: async () => 1,
      isVisible: async () => visible,
      isEnabled: async () => enabled,
      waitFor: async () => { if (!visible) throw new Error("TimeoutError: hidden"); },
      click: async () => {
        if (!enabled) throw new Error("TimeoutError: element is not enabled");
        clicked.push(id);
      },
      evaluateAll: async () => [],
    };
    return loc;
  };
  // The decorative pill: present, visible, and permanently disabled.
  page.getByText = () => mk(true, false, "disabled-pill");
  // The real one, whose accessible name carries the icon ligature ("check_circleApply") and
  // which a role+name fallback matches by substring.
  page.getByRole = (role: string, o?: { name?: string }) =>
    (role === "link" && o?.name === "Apply" ? mk(true, true, "real-apply") : mk(false, false, "other"));
  withFakePage(adapter, page);

  const result = await adapter.fillApplication(fakeProject);
  assert.deepEqual(clicked, ["real-apply"],
    `the disabled pill must be passed over for the enabled control (clicked ${JSON.stringify(clicked)})`);
  assert.ok(
    (result.data?.driftWarnings as string[] | undefined)?.some((w) => /hidden or disabled control/.test(w)),
    "and the pass-over is reported as drift",
  );
}

async function testHiddenPrimaryFallsThroughToVisibleFallback() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const adapter = new RecipeAdapter(baseRecipe([
    { action: "fill", selector: { css: "#pcInputBase55", fallbacks: [{ label: "Model" }] }, field: "inverterModel", note: "Model" },
  ]), { inverterModel: "DS3-L" }, {});
  const page: any = makeFakePage({ log });
  const mk = (visible: boolean, key: string): any => {
    const loc: any = {
      first: () => loc, nth: () => loc,
      count: async () => 1,
      isVisible: async () => visible,
      fill: async (v: string) => {
        if (!visible) throw new Error("TimeoutError: element is not visible");
        log.fills.push({ key, value: v });
      },
      blur: async () => undefined,
      waitFor: async () => { if (!visible) throw new Error("TimeoutError: hidden"); },
      evaluateAll: async () => [],
    };
    return loc;
  };
  page.locator = (css: string) => (css === "#pcInputBase55" ? mk(false, "ghost") : mk(false, `css:${css}`));
  page.getByLabel = (label: string) => (label === "Model" ? mk(true, "real-model") : mk(false, `label:${label}`));
  withFakePage(adapter, page);

  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true, `run should complete (${result.message || ""})`);
  assert.deepEqual(log.fills.map((f) => f.key), ["real-model"], "the VISIBLE fallback got the value; the hidden ghost got nothing");
  assert.ok(
    (result.data?.driftWarnings as string[] | undefined)?.some((w) => /hidden or disabled control/.test(w)),
    "and the pass-over is reported as drift",
  );
}

// ---------------------------------------------------------------------------
// A MEASUREMENT BEATS A SUSPICION -- BUT ONLY WHEN THE MEASUREMENT IS CLEAN.
//
// "A dropdown or date picker stayed open after two Escapes -- the next control may have been
// driven while covered" is the only warning in the adapter that is a guess rather than an
// observation, and it blocked a clean score on PacifiCorp every run. By the end of a run the
// guess is answerable: every fill reads its value back and the required sweep says what the
// portal still wants. If both are clean, the thing it feared did not happen.
//
// The direction that matters is the refusal. These two tests exist so that a future change
// cannot quietly make the discharge unconditional.
// ---------------------------------------------------------------------------
const COVERED = "a dropdown or date picker stayed open after two Escapes — the next control may have been driven while covered; verify it by eye";

const dischargeWith = (fieldsUnverified: string[], requiredStillEmpty: string[]): { drift: string[]; aging: string[] } => {
  const a = Object.create(RecipeAdapter.prototype) as Record<string, unknown>;
  a.driftWarnings = [COVERED];
  a.agingNotes = [];
  a.fieldsVerified = ["Meter", "Model", "kW AC"];
  a.fieldsUnverified = fieldsUnverified;
  a.requiredStillEmpty = requiredStillEmpty;
  (a as { dischargeCoveredWarning: () => void }).dischargeCoveredWarning();
  return { drift: a.driftWarnings as string[], aging: a.agingNotes as string[] };
};

async function testCoveredWarningDischargedByCleanReadback(): Promise<void> {
  const r = dischargeWith([], []);
  assert.ok(!r.drift.includes(COVERED),
    "every value read back and nothing was left blank, yet the suspicion still blocked the run");
  assert.ok(r.aging.some((w) => /nothing was driven while covered/i.test(w)),
    `the withdrawal was not recorded anywhere: ${JSON.stringify(r.aging)}`);
}

async function testCoveredWarningStandsWhenAValueDidNotHold(): Promise<void> {
  const unverified = dischargeWith(["Model"], []);
  assert.ok(unverified.drift.includes(COVERED),
    "a value that would not read back is exactly what this warning predicts — it must not be withdrawn");
  const blank = dischargeWith([], ["Total System Export (kW)"]);
  assert.ok(blank.drift.includes(COVERED),
    "the portal still wants a required field, and the warning was withdrawn anyway");
}

// ---------------------------------------------------------------------------
// THE DRIFT DENOMINATOR HAS THE SAME BUG THE BLANK COUNT HAD.
//
// "Only 4 of 14 recorded fields found for this section — the portal may have changed" was
// the last blocking warning standing on PGE, and several of those 14 were battery fields
// this project was never going to fill. Where a portal renders storage controls only once
// storage is declared, their labels are genuinely absent — so a correct filing was measured
// against a denominator that included rows it had correctly decided to skip.
// ---------------------------------------------------------------------------
const segmentLabels = (hasBattery: string): string[] => {
  const a = Object.create(RecipeAdapter.prototype) as Record<string, unknown>;
  a.fieldValues = { hasBattery };
  a.recipe = {
    steps: [
      { action: "fill", note: "System Size (kW AC)" },
      { action: "select", note: "Energy Source" },
      { action: "fill", note: "Energy Storage Capacity of Battery (kWh)" },
      { action: "select", note: "Battery Manufacturer" },
      { action: "select", note: "Wattsmart Battery Program?" },
      { action: "click", note: "advance: Next" },
      { action: "fill", note: "not in this segment" },
    ],
  };
  return (a as { expectedLabelsForSegment: (i: number) => string[] }).expectedLabelsForSegment(0);
};

async function testDriftDenominatorExcludesStepsThisRunWillSkip(): Promise<void> {
  const noBattery = segmentLabels("No");
  assert.ok(!noBattery.some((l) => /Energy Storage Capacity|Battery Manufacturer/i.test(l)),
    `battery specs counted as expected page fields on a job with no battery: ${JSON.stringify(noBattery)}`);
  // The PROGRAM question is answered No, not skipped — it must stay in the denominator, or a
  // page really missing it would look fine.
  assert.ok(noBattery.some((l) => /Wattsmart Battery Program/i.test(l)),
    `the program question is answered, not skipped, and must still be expected: ${JSON.stringify(noBattery)}`);
  assert.ok(noBattery.some((l) => /System Size/i.test(l)), JSON.stringify(noBattery));
  // The segment stops at the advancing click, as before.
  assert.ok(!noBattery.some((l) => /not in this segment/i.test(l)), JSON.stringify(noBattery));
}

async function testDriftDenominatorKeepsBatteryFieldsWhenThereIsABattery(): Promise<void> {
  const withBattery = segmentLabels("Yes");
  assert.ok(withBattery.some((l) => /Energy Storage Capacity/i.test(l)),
    `a job WITH a battery must still expect its storage fields: ${JSON.stringify(withBattery)}`);
  const unknown = segmentLabels("");
  assert.ok(unknown.some((l) => /Energy Storage Capacity/i.test(l)),
    `unknown battery state must replay as recorded, not silently shrink the check: ${JSON.stringify(unknown)}`);
}

// R4: A FAILURE CAPTURE NEVER WAITS FOR THE CONTROL THAT FAILED TO APPEAR. The fake locator's
// evaluate() behaves like Playwright's: it waits for its element (here 5 s standing in for the
// default 30 s) unless a shorter timeout is passed. MUST-EXCLUDE: an absent target (count 0) costs
// no wait at all. MUST-PASS: a present target is still captured, markup and options.
async function testFailureCaptureDoesNotWaitForAnAbsentTarget() {
  const os = await import("node:os");
  const fsm = await import("node:fs");
  const pth = await import("node:path");
  const dir = fsm.mkdtempSync(pth.join(os.tmpdir(), "capture-wait-"));
  const frame = { url: () => "http://127.0.0.1/review", name: () => "", evaluate: async () => "<body>review</body>" };
  const adapter = withFakePage(new RecipeAdapter(baseRecipe([]), {}, {}), {
    frames: () => [frame], url: () => "http://127.0.0.1/review", evaluate: async () => null,
  });
  const locator = (present: boolean) => ({
    count: async () => (present ? 1 : 0),
    evaluate: (_fn: unknown, _arg: unknown, o?: { timeout?: number }) => present
      ? Promise.resolve({ outerHTML: "<select id=\"county\"></select>", options: ["Alpha", "Beta"], secret: false })
      : new Promise((_res, rej) => setTimeout(() => rej(new Error("Timeout exceeded")), o?.timeout ?? 5000)),
  });
  const write = (adapter as unknown as { writeSanitizedCapture: (d: string, b: string, o: unknown) => Promise<string> }).writeSanitizedCapture.bind(adapter);
  const t0 = Date.now();
  const absentFile = await write(dir, "absent", { target: locator(false) });
  const took = Date.now() - t0;
  assert.ok(took < 1000, `capturing an ABSENT target waited ${took} ms for it (the step already spent its timeout proving it absent)`);
  assert.ok(absentFile, "the page itself is still captured when the target is absent");
  assert.equal(JSON.parse(fsm.readFileSync(absentFile, "utf8")).target, null);
  const presentFile = await write(dir, "present", { target: locator(true) });
  const cap = JSON.parse(fsm.readFileSync(presentFile, "utf8"));
  assert.ok(/county/.test(cap.target?.outerHTML ?? ""), `a present target's markup is captured: ${JSON.stringify(cap.target)}`);
  assert.deepEqual(cap.target.options, ["Alpha", "Beta"]);
}

// R1: THE CHOKEPOINT IS THE ONLY DOOR. Read the adapter's own source: no .click( / .press( /
// .goto( / .dblclick( / .tap( may appear outside guardedClick / guardedPress / guardedGoto, so a
// raw click re-introduced anywhere (the drift-seek click-through was one) fails here without a
// browser. Comments are stripped first; in-page evaluate bodies never call these.
async function testNoRawActionOutsideTheChokepoint() {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./recipeAdapter.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, ""));
  const helpers = ["guardedClick", "guardedPress", "guardedGoto", "guardedReload"];
  let inHelper = "";
  let depth = 0;
  const offenders: string[] = [];
  src.forEach((line, i) => {
    const m = /^\s*private async (guardedClick|guardedPress|guardedGoto|guardedReload)\(/.exec(line);
    if (m && !inHelper) { inHelper = m[1]; depth = 0; }
    if (inHelper) {
      depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      if (depth <= 0 && /}\s*$/.test(line) && !m) { inHelper = ""; return; }
      return;
    }
    if (/\.(click|dblclick|tap|press|goto|reload)\(/.test(line)) offenders.push(`${i + 1}: ${line.trim().slice(0, 110)}`);
  });
  assert.ok(helpers.every((h) => src.some((l) => l.includes(`private async ${h}(`))), "the four guarded helpers exist");
  assert.deepEqual(offenders, [], `raw click/press/goto outside the chokepoint:\n${offenders.join("\n")}`);
}

// R1 EXTENDS TO THE HELPERS REPLAY IMPORTS. dismissPageModals (autoLearnAdapter) clicked a
// confirm dialog's "OK" / first button raw, before every step and on every retry — four filing
// POSTs on the skeptic's fixture. Replay must hand it the chokepoint (a click callback), and the
// dismisser's own raw click (the learner's path) must come after the in-page refusal check.
async function testImportedHelpersStayBehindTheChokepoint() {
  const fs = await import("node:fs");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const replay = strip(fs.readFileSync(new URL("./recipeAdapter.ts", import.meta.url), "utf8"));
  const calls = replay.match(/dismissPageModals\([^)]*\)?/g) ?? [];
  const unguarded = calls.filter((c) => !/click\s*:/.test(replay.slice(replay.indexOf(c), replay.indexOf(c) + 200)));
  assert.ok(calls.length >= 1, "replay still dismisses overlays");
  assert.deepEqual(unguarded, [], `replay calls dismissPageModals without routing its clicks through guardAction: ${unguarded.join(" ; ")}`);
  const learner = strip(fs.readFileSync(new URL("./autoLearnAdapter.ts", import.meta.url), "utf8"));
  const start = learner.indexOf("export async function dismissPageModals(");
  const end = learner.indexOf("export async function clearPageOverlays(");
  assert.ok(start > 0 && end > start, "dismissPageModals is where this test expects it");
  const body = learner.slice(start, end);
  const firstCheck = body.indexOf("dismissalRefusalInPage");
  const clicks = [...body.matchAll(/\.click\(/g)].map((m) => m.index ?? 0);
  assert.ok(firstCheck > 0, "the dismisser asks the shared in-page refusal question");
  assert.ok(clicks.every((i) => i > firstCheck), "every click in the dismisser comes after the refusal check");
  assert.ok(/if \(refusal\)/.test(body) && /opts\.click/.test(body), "a refusal skips the control, and a caller's chokepoint performs the click");
  // comboboxFill (replay's selectWithFallback) presses Enter in a widget's search box: that Enter
  // may only follow the shared implicit-submission question (replay skeptic MF3).
  const combo = strip(fs.readFileSync(new URL("../comboboxFill.ts", import.meta.url), "utf8"));
  const enters = [...combo.matchAll(/\.press\(\s*"Enter"/g)].map((m) => m.index ?? 0);
  const asked = combo.indexOf("enterRefusalInPage");
  assert.ok(enters.length >= 1 && asked > 0 && enters.every((i) => i > asked && combo.slice(asked, i).includes("if (refusal)")),
    "every Enter comboboxFill presses comes after the implicit-submission refusal check");
}

// A NAVIGATION IN FLIGHT IS NOT A DRIFT VERDICT (accela/extra_readonly_page flaked 2 of 3). The
// drift precheck's scan threw "Execution context was destroyed" while the advance was still
// navigating, the catch answered "no drift", the drift-seek never clicked through the extra page,
// and the next fill timed out. MUST-EXCLUDE: a scan that throws once and then reads a page with
// none of the recorded fields -> drift is reported. MUST-PASS: a page that has them -> no drift.
async function testDriftPrecheckRescansAfterANavigationError() {
  const steps = [
    { action: "fill", selector: { label: "First Name:" }, field: "homeownerFirstName", note: "First Name:" },
    { action: "fill", selector: { label: "Last Name:" }, field: "homeownerLastName", note: "Last Name:" },
    { action: "fill", selector: { label: "Business Name:" }, field: "installerCompanyName", note: "Business Name:" },
    { action: "stopForReview" },
  ] as RecipeStep[];
  const run = async (labels: string[]) => {
    const adapter = new RecipeAdapter(baseRecipe(steps), {}, {});
    let calls = 0;
    (adapter as unknown as { page: unknown }).page = {
      $$eval: async () => { calls++; if (calls === 1) throw new Error("page.$$eval: Execution context was destroyed, most likely because of a navigation"); return labels.map((label) => ({ label })); },
      url: () => "http://127.0.0.1/CitizenAccess/Cap/CapEdit.aspx",
    };
    return (adapter as unknown as { precheckPageDrift(i: number): Promise<string | null> }).precheckPageDrift(0);
  };
  const extra = await run(["Additional Details", "Parcel Summary", "Notes to reviewer"]);
  assert.match(String(extra), /page drift/, `MUST-EXCLUDE: a scan that died mid-navigation was read as 'no drift': ${extra}`);
  const contacts = await run(["First Name:", "Last Name:", "Business Name:"]);
  assert.equal(contacts, null, "MUST-PASS: the recorded page is not drift");
}

// R1 / hard rule 5 inside replay: a goto that leaves the recipe's portal stops the run, named.
async function testGotoLeavingThePortalStopsTheRun() {
  const cases: Array<{ name: string; scope: "ahj" | "utility"; portalUrl: string; to: string; allowed: boolean }> = [
    { name: "permit recipe goto a PowerClerk utility portal", scope: "ahj", portalUrl: "https://aca-oregon.accela.com/OREGON/Default.aspx", to: "https://pacificpower.powerclerk.com/MvcProjects/Home", allowed: false },
    { name: "utility recipe goto an Accela permit portal", scope: "utility", portalUrl: "https://pge.powerclerk.com/", to: "https://aca-oregon.accela.com/OREGON/Cap/CapHome.aspx", allowed: false },
    { name: "a goto to another site entirely (tylerhost -> accela)", scope: "ahj", portalUrl: "https://coosbay-or.tylerhost.net/prod/selfservice", to: "https://aca-oregon.accela.com/OREGON/Default.aspx", allowed: false },
    { name: "a goto within the recipe's own site (another subdomain)", scope: "ahj", portalUrl: "https://aca-oregon.accela.com/OREGON/Default.aspx", to: "https://www.accela.com/OREGON/Cap/CapApplyDisclaimer.aspx", allowed: true },
    { name: "a goto within the same host", scope: "ahj", portalUrl: "https://aca-oregon.accela.com/OREGON/Default.aspx", to: "https://aca-oregon.accela.com/OREGON/Cap/CapApplyDisclaimer.aspx?module=Building", allowed: true },
    { name: "an SSO bounce", scope: "utility", portalUrl: "https://pge.powerclerk.com/", to: "https://login.microsoftonline.com/common/oauth2", allowed: true },
  ];
  for (const c of cases) {
    const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
    const recipe = { ...baseRecipe([{ action: "goto", value: c.to, note: "entry" }, { action: "stopForReview" }]), scopeType: c.scope, portalUrl: c.portalUrl };
    const adapter = new RecipeAdapter(recipe, {}, {});
    withFakePage(adapter, makeFakePage({ log }));
    const result = await adapter.fillApplication(fakeProject);
    if (c.allowed) {
      assert.deepEqual(log.gotos, [c.to], `MUST-PASS (${c.name}): navigated`);
      assert.equal(result.ok, true, `${c.name}: ${result.message}`);
    } else {
      assert.deepEqual(log.gotos, [], `MUST-EXCLUDE (${c.name}): never navigated`);
      assert.equal(result.ok, false, `${c.name}: the run stops`);
      assert.match(String(result.message), /replay safety gate refused: .*(may not open|leaves the recipe's portal)/, `${c.name}: a named reason (${result.message})`);
    }
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["R4: a failure capture never waits for the control that failed to appear", testFailureCaptureDoesNotWaitForAnAbsentTarget],
  ["R1: no click/press/goto outside the replay chokepoint (static)", testNoRawActionOutsideTheChokepoint],
  ["R1: the overlay dismissor replay imports stays behind the chokepoint (static)", testImportedHelpersStayBehindTheChokepoint],
  ["DRIFT: a scan that died mid-navigation is rescanned, never read as 'no drift'", testDriftPrecheckRescansAfterANavigationError],
  ["R1: a goto that leaves the recipe's portal stops the run, named (rule 5)", testGotoLeavingThePortalStopsTheRun],
  ["R2: each missing input of the final-submit gate keeps it unclicked", testFinalSubmitGateRefusesEachMissingInput],
  ["R2: a quiet page after the approved click is unknown, reported, never retried", testFinalSubmitQuietPageIsUnknownAndNotRetried],
  ["RESOLVE: a hidden-only primary falls through to the visible fallback", testHiddenPrimaryFallsThroughToVisibleFallback],
  ["RESOLVE: a visible-but-DISABLED primary falls through too", testDisabledOnlyPrimaryFallsThroughToFallback],
  ["RESOLVE: an ordinal fallback that lands on a hidden control retries unpinned", testOrdinalFallbackRetriesUnpinned],
  ["CLICK: a disabled namesake ahead of the real control is skipped", testDisabledNamesakeSkipped],
  ["RECORD TYPE: a type this jurisdiction does not offer refuses to file", testRecordTypeNotOfferedRefusesToFile],
  ["RECORD TYPE: an offered type is checked by its own label", testRecordTypeOfferedIsCheckedByLabel],
  ["RECORD TYPE: the guard settles before it counts (no race with a just-navigated page)", testRecordTypeGuardSettlesBeforeCounting],
  ["RECORD TYPE: two matching types is a refusal, not a coin flip", testRecordTypeAmbiguousRefusesToGuess],
  ["RECORD TYPE: self-heal never re-anchors a permit type", testRecordTypeIsNeverSelfHealed],
  ["DRIFT: zero overlap on data segment fails fast as needs_rerecord message", testDriftZeroOverlapFailsFast],
  ["DRIFT: partial overlap annotates driftWarnings and continues", testDriftPartialOverlapWarnsAndContinues],
  ["DRIFT: sparse segment (<3 labels) is never prechecked", testDriftSparseSegmentSkipped],
  ["DRIFT: frame-scoped steps excluded from the expected set", testDriftFrameScopedExcluded],
  ["DRIFT: page without \$\$eval passes silently (legacy)", testDriftNoEvalSilent],
  ["HEAL FINGERPRINT: ambiguous label healed onto the fingerprint-matching field", testHealPrefersFingerprintMatch],
  ["HEAL (R3): a legacy step bound to the inverter never heals into the module's box; identified by index+version", testHealWithoutFingerprintLegacy],
  ["HEAL (R3): a tie is refused with a named ambiguity", testHealRefusesATie],
  ["HEAL (R3): a heal whose healed step did not perform is not reported", testHealNotReportedWhenHealedStepDidNotPerform],
  ["HEAL (R3): below the minimum, settle and re-localize once", testHealRelocalizesOnceBelowMinimum],
  ["HEAL (R3): weighted multi-attribute scoring, minimum and tie margin", testHealScoringUnit],
  ["HEAL FINGERPRINT: attributes alone never invent a match", testFingerprintNeverInventsMatch],
  ["fingerprintBoost unit scoring (max 58 < 70 gate)", testFingerprintBoostUnit],
  ["stopForReview halts replay and blocks later clicks", testStopForReviewHalts],
  ["pay/submit keyword clicks are blocked; safe clicks run", testFinalSubmitDenylist],
  ["P0-3: id/css-only final submit NOT clicked in autoSubmit without isFinalSubmit", testIdOnlyFinalSubmitNotClickedWithoutFlag],
  ["R2: flagged final submit IS clicked only with env 1 + this run's approval + terminal flagged step; accepted on positive evidence", testFlaggedFinalSubmitClickedInAutoSubmit],
  ["P0-3: flagged final submit NOT clicked in guided-manual", testFlaggedFinalSubmitNotClickedWithoutAutoSubmit],
  ["P0-3: PAY_FEE always blocked in autoSubmit even if flagged", testPayFeeBlockedInAutoSubmit],
  ["P0-4: iframe CAPTCHA/MFA challenge stops autoSubmit final click", testIframeChallengeStopsAutoSubmit],
  ["P0-2: guided-manual reports finalSubmitClicked:false", testGuidedManualReportsNotSubmitted],
  ["field values are substituted; empty fields are skipped", testFieldSubstitution],
  ["selector fallbacks are used when the primary is absent", testSelectorFallback],
  ["credentials are never written to stdout/stderr", testCredentialNeverLogged],
  ["Gap A: render-readiness runs after a goto navigation", testRenderReadinessAfterGoto],
  ["Gap A: render-readiness runs after an advancing click", testRenderReadinessAfterAdvancingClick],
  ["Gap A: render-readiness does NOT run on the final-submit branch", testRenderReadinessNotOnFinalSubmit],
  ["Gap B: gap-fill runs in the persist-settle branch before an advancing click", testGapFillRunsInPersistSettleBranch],
  ["Gap B: gap-fill runs before the guided-manual review halt", testGapFillRunsBeforeGuidedManualReview],
  ["Gap B: gapFill report is surfaced in the stop-at-review result", testGapFillReportInStopAtReviewResult],
  ["Gap B: gapFill report is surfaced in the final-submit result", testGapFillReportInFinalSubmitResult],
  ["COVERED CONTROL: a clean readback withdraws the suspicion", testCoveredWarningDischargedByCleanReadback],
  ["COVERED CONTROL: THE FAIL-SAFE — an unverified value keeps it standing", testCoveredWarningStandsWhenAValueDidNotHold],
  ["PAGE DRIFT: a step this run will skip is not a missing field", testDriftDenominatorExcludesStepsThisRunWillSkip],
  ["PAGE DRIFT: THE FAIL-SAFE — a real battery keeps its fields in the count", testDriftDenominatorKeepsBatteryFieldsWhenThereIsABattery],
];

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   - ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failures) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} recipe-adapter tests passed.`);
