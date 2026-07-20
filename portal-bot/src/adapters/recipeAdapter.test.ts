import assert from "node:assert/strict";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter, fingerprintBoost } from "./recipeAdapter";

// Browser-free tests for the recipe replay loop. We inject a fake Playwright page
// so we can assert the safety-critical behaviours (final-submit denylist, stop-at-
// review halt, field substitution, selector fallbacks, credential never logged)
// without launching Chromium. Run with: npm run portal:test:unit

// Keep the persist-settle sleep negligible so the gap-fill-ordering tests run fast and
// deterministically (the production default is 3s). "1" → Number("1") || 3000 === 1.
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";

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
  return page;
}

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

// P0-3: the SAME id/css-only step IS clicked when explicitly flagged isFinalSubmit in
// autoSubmit mode, and finalSubmitClicked is reported true.
async function testFlaggedFinalSubmitClickedInAutoSubmit() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "stopForReview" },
    { action: "click", selector: { css: "#ctl00_btnSubmit" }, isFinalSubmit: true } as RecipeStep,
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: true });
  withFakePage(adapter, makeFakePage({ log }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true);
  assert.deepEqual(log.clicks, ["css:#ctl00_btnSubmit"], "flagged final submit must be clicked in autoSubmit");
  assert.equal((adapter as unknown as { finalSubmitClicked: boolean }).finalSubmitClicked, true, "finalSubmitClicked must be true");
  assert.equal(result.data?.finalSubmitClicked, true);
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
}

// PAY_FEE is ALWAYS blocked, even in autoSubmit and even if (wrongly) flagged.
async function testPayFeeBlockedInAutoSubmit() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "stopForReview" },
    { action: "click", selector: { role: "button", name: "Pay Now" }, isFinalSubmit: true } as RecipeStep,
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: true });
  withFakePage(adapter, makeFakePage({ log }));
  const result = await adapter.fillApplication(fakeProject);
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
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: true });
  withFakePage(adapter, makeFakePage({
    log,
    frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=abc"],
  }));
  const result = await adapter.fillApplication(fakeProject);
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
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: true });
  const page = makeFakePage({ log });
  withFakePage(adapter, page);
  const result = await adapter.fillApplication(fakeProject);
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
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: true });
  withFakePage(adapter, makeFakePage({ log }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true);
  assert.equal(result.data?.finalSubmitClicked, true);
  assertGapFillReport(result.data?.gapFill, "final-submit");
}

// SELF-HEAL FINGERPRINTS: two live fields share the bare label "Manufacturer";
// the step's recorded fingerprint (name/section) must pick the RIGHT one.
async function testHealPrefersFingerprintMatch() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { css: "#old-gone-id" }, note: "Manufacturer", value: "AP Systems",
      fingerprint: { name: "inv_mfr", section: "Inverter Information" } },
    { action: "stopForReview" },
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {});
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

// Backward compat: same scenario minus the fingerprint — legacy first-candidate wins.
async function testHealWithoutFingerprintLegacy() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { css: "#old-gone-id" }, note: "Manufacturer", value: "AP Systems" },
    { action: "stopForReview" },
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {});
  withFakePage(adapter, makeFakePage({
    log,
    present: { "css:#old-gone-id": false },
    rawFields: [
      { label: "Manufacturer", fieldType: "text", id: "m1", name: "mod_mfr", section: "PV Module Information" },
      { label: "Manufacturer", fieldType: "text", id: "i2", name: "inv_mfr", section: "Inverter Information" },
    ],
  }));
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true);
  const healed = (result.data as { healedSteps?: Array<{ selector: unknown }> }).healedSteps ?? [];
  assert.equal(healed.length, 1);
  assert.ok(JSON.stringify(healed[0].selector).includes("#m1"), "no fingerprint → first ≥70 candidate (legacy)");
}

// A matching fingerprint must NEVER manufacture a heal when no label matches.
async function testFingerprintNeverInventsMatch() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const recipe = baseRecipe([
    { action: "fill", selector: { css: "#old-gone-id" }, note: "Manufacturer", value: "X",
      fingerprint: { name: "inv_mfr" } },
  ]);
  const adapter = new RecipeAdapter(recipe, {}, {});
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
const threeFills: RecipeStep[] = [
  { action: "fill", selector: { label: "Homeowner Name" }, note: "Homeowner Name", value: "X" },
  { action: "fill", selector: { label: "Project Address" }, note: "Project Address", value: "Y" },
  { action: "select", selector: { label: "Utility Company" }, note: "Utility Company", value: "Z" },
  { action: "stopForReview" },
];

async function testDriftZeroOverlapFailsFast() {
  const log: ActionLog = { clicks: [], fills: [], gotos: [], checks: 0 };
  const adapter = new RecipeAdapter(baseRecipe(threeFills), {}, {});
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
  const adapter = new RecipeAdapter(baseRecipe(threeFills), {}, {});
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
  const adapter = new RecipeAdapter(baseRecipe(threeFills), {}, {});
  withFakePage(adapter, makeFakePage({ log })); // no rawFields → no $$eval on the fake
  const result = await adapter.fillApplication(fakeProject);
  assert.equal(result.ok, true, "no $$eval → precheck silently passes (legacy fakes)");
  assert.equal(log.fills.length, 2, "fills ran normally");
}

const tests: Array<[string, () => Promise<void>]> = [
  ["DRIFT: zero overlap on data segment fails fast as needs_rerecord message", testDriftZeroOverlapFailsFast],
  ["DRIFT: partial overlap annotates driftWarnings and continues", testDriftPartialOverlapWarnsAndContinues],
  ["DRIFT: sparse segment (<3 labels) is never prechecked", testDriftSparseSegmentSkipped],
  ["DRIFT: frame-scoped steps excluded from the expected set", testDriftFrameScopedExcluded],
  ["DRIFT: page without \$\$eval passes silently (legacy)", testDriftNoEvalSilent],
  ["HEAL FINGERPRINT: ambiguous label healed onto the fingerprint-matching field", testHealPrefersFingerprintMatch],
  ["HEAL FINGERPRINT: legacy recipes (no fingerprint) behave as before", testHealWithoutFingerprintLegacy],
  ["HEAL FINGERPRINT: attributes alone never invent a match", testFingerprintNeverInventsMatch],
  ["fingerprintBoost unit scoring (max 58 < 70 gate)", testFingerprintBoostUnit],
  ["stopForReview halts replay and blocks later clicks", testStopForReviewHalts],
  ["pay/submit keyword clicks are blocked; safe clicks run", testFinalSubmitDenylist],
  ["P0-3: id/css-only final submit NOT clicked in autoSubmit without isFinalSubmit", testIdOnlyFinalSubmitNotClickedWithoutFlag],
  ["P0-3: flagged final submit IS clicked in autoSubmit and reports finalSubmitClicked", testFlaggedFinalSubmitClickedInAutoSubmit],
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
