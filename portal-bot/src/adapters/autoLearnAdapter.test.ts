import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the per-run debug bundle at a temp dir so these tests exercise the recorder
// (sidecars, events, manifest) without ever writing into the repo's data/.
const debugTmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "autolearn-test-runs-"));
process.env.AUTOLEARN_RUN_DIR = debugTmpBase;
process.on("exit", () => { try { fs.rmSync(debugTmpBase, { recursive: true, force: true }); } catch { /* best effort */ } });

import type { ProjectRecord } from "../../../shared/src/types";
import {
  AutoLearnAdapter,
  type ExtractedField,
  type LearnPlanRequest,
  type LearnPlanResponse,
  type LearnPlanner,
} from "./autoLearnAdapter";

// Browser-free tests for the autonomous-learning loop. We inject a fake Playwright page
// (modelled on recipeAdapter.test.ts) plus a FAKE planner so we can assert the safety-
// critical behaviours without launching Chromium:
//   1. fields are extracted, filled, and recorded as steps
//   2. the final submit step is recorded isFinalSubmit:true and NEVER clicked
//   3. a pay/fee button returned by the planner is never clicked
//   4. a challenge frame stops the run with pauseReason "mfa_captcha"
//   5. multi-page advance works (clicks "Next", continues, stops at review)
//   6. sensitive fields don't store literal values
//
// Run with: npm run portal:test:unit   (or: npm run portal:test:learn)

// --- Fake page model -------------------------------------------------------------

// A "DOM element" the fake page's $$eval will see. We don't run real DOM extraction in
// the page; instead the fake page returns pre-baked RawField rows per page index, which
// mirror what extractFieldsInPage would produce in a browser.
interface RawFieldRow {
  label: string;
  fieldType: ExtractedField["fieldType"];
  options?: string[];
  role?: string;
  name?: string;
  placeholder?: string;
  id?: string;
  text?: string;
  section?: string;
}

interface FakePageSpec {
  // One entry per page the loop will visit, in order.
  pages: Array<{
    url: string;
    title: string;
    body: string;
    rawFields: RawFieldRow[];
    // Review-screen value pairs returned by scrapeReviewScreen's $$eval, if any.
    reviewPairs?: Array<{ label: string; value: string }>;
    // When set, clicking this page's advance button does NOT move forward (the portal blocked
    // it), and page.evaluate() returns these as inline-validation blockers.
    blockedValidationErrors?: string[];
  }>;
  // Frame URLs returned by page.frames() (for structural challenge detection).
  frameUrls?: string[];
  challengeText?: boolean;
}

interface ActionLog {
  clicks: string[];
  fills: Array<{ key: string; value: string }>;
  selects: Array<{ key: string; value: string }>;
  checks: string[];
}

function selectorKey(sel: any): string {
  if (sel?.role && sel?.name) return `role:${sel.role}:${sel.name}`;
  if (sel?.label) return `label:${sel.label}`;
  if (sel?.placeholder) return `placeholder:${sel.placeholder}`;
  if (sel?.css) return `css:${sel.css}`;
  if (sel?.text) return `text:${sel.text}`;
  if (sel?.role) return `role:${sel.role}`;
  return "unknown";
}

function makeFakePage(spec: FakePageSpec, log: ActionLog) {
  // Current page index advances when the adapter clicks the "advance" button.
  let pageIdx = 0;
  // Last value written per selector key, so inputValue() read-backs match what was
  // filled (the adapter DROPS a fill whose read-back does not hold).
  const written = new Map<string, string>();

  function curPage() {
    return spec.pages[Math.min(pageIdx, spec.pages.length - 1)];
  }

  // A locator keyed by a stable selector string so tests can assert which control was hit.
  function locatorFor(key: string): any {
    const loc: any = {
      first: () => loc,
      nth: () => loc,
      count: async () => 1,
      click: async () => {
        log.clicks.push(key);
        // Clicking an "advance" (Next/Continue) navigates to the next page — UNLESS this page
        // is configured to block the advance (validation error), in which case pageIdx stays.
        if (!curPage().blockedValidationErrors) pageIdx++;
      },
      fill: async (v: string) => { log.fills.push({ key, value: v }); written.set(key, v); },
      selectOption: async (v: any) => {
        const value = typeof v === "string" ? v : v?.label ?? "";
        log.selects.push({ key, value });
        written.set(key, value);
      },
      check: async () => { log.checks.push(key); },
      uncheck: async () => undefined,
      press: async () => undefined,
      waitFor: async () => undefined,
      setInputFiles: async () => undefined,
      innerText: async () => curPage().body,
      // Read-back used by fill verification and by the ACA attachment pass's
      // empty-Description/Type detection.
      inputValue: async () => written.get(key) ?? "",
      // detectChallengeFrame reads iframe src attributes via evaluateAll.
      evaluateAll: async () => [],
      // Chainable helpers the ACA passes use: row-scoping (locator("tr").filter().
      // getByRole()), the Add-New OR-chain (getByRole().or().or().first()), and the
      // dialog-frame fills (frameLocator().locator("tr").filter().locator("input")).
      filter: () => loc,
      or: () => loc,
      getByRole: (role: string, o?: { name?: RegExp | string }) => locatorFor(`role:${role}:${String(o?.name ?? "")}`),
      locator: (css: string) => locatorFor(`css:${css}`),
      frameLocator: () => loc,
    };
    return loc;
  }

  const page: any = {
    url: () => curPage().url,
    title: async () => curPage().title,
    goto: async () => undefined,
    waitForLoadState: async () => undefined,
    reload: async () => undefined,
    // collectValidationErrors() runs its scrape via page.evaluate; return the page's configured
    // blockers so the validation guard can be exercised without a real DOM.
    evaluate: async () => curPage().blockedValidationErrors ?? [],
    frames: () => (spec.frameUrls ?? []).map((u) => ({ url: () => u })),
    getByRole: (role: string, o?: { name?: string }) => locatorFor(`role:${role}:${o?.name ?? ""}`),
    getByLabel: (label: string) => locatorFor(`label:${label}`),
    getByPlaceholder: (p: string) => locatorFor(`placeholder:${p}`),
    getByTestId: (t: string) => locatorFor(`testId:${t}`),
    getByText: (t: any) => {
      if (t instanceof RegExp && /captcha/i.test(t.source)) {
        return { ...locatorFor("text:challenge"), count: async () => (spec.challengeText ? 1 : 0) };
      }
      return locatorFor(`text:${String(t)}`);
    },
    locator: (css: string) => {
      if (css === "body") {
        return { innerText: async () => curPage().body };
      }
      if (css === "iframe") {
        return { evaluateAll: async () => [] };
      }
      return locatorFor(`css:${css}`);
    },
    frameLocator: () => page,
    // $$eval is selector-dependent: the field-extraction selector returns rawFields
    // (passed through the real toExtractedField-equivalent shape), the review selector
    // returns reviewPairs. The fn arg is ignored; we return pre-baked rows.
    $$eval: async (selector: string, _fn: any) => {
      if (selector.includes("button")) {
        // Field extraction selector: "input, select, textarea, button, [role=button]".
        return curPage().rawFields;
      }
      // Review scrape selector: "input, select, textarea".
      return curPage().reviewPairs ?? [];
    },
  };
  return page;
}

const fakeProject = {} as ProjectRecord;
const fakeContext = {} as Parameters<AutoLearnAdapter["learn"]>[0];

function withFakePage(adapter: AutoLearnAdapter, page: any): AutoLearnAdapter {
  (adapter as unknown as { page: unknown }).page = page;
  return adapter;
}

// --- Tests -----------------------------------------------------------------------

// 1) Fields are extracted, filled, and recorded as steps.
async function testFieldsExtractedFilledRecorded() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
    // Fill the first two fields; the page is the review screen.
    return {
      fills: [
        { selectorIndex: 0, value: "John Homeowner", field: "homeownerName" },
        { selectorIndex: 1, value: "Residential Solar" },
      ],
      atReview: true,
    };
  };
  const adapter = new AutoLearnAdapter("Test AHJ", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://portal.example/apply",
            title: "Apply",
            body: "Solar permit application",
            rawFields: [
              { label: "Homeowner Name", fieldType: "text", id: "hn" },
              { label: "Project Type", fieldType: "text", id: "pt" },
            ],
            reviewPairs: [{ label: "Homeowner Name", value: "John Homeowner" }],
          },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true, "should succeed after reaching review");
  assert.equal(result.pageCount, 1);
  // Two fills were applied.
  assert.equal(log.fills.length, 2, "both fields should be filled");
  // Steps recorded: a goto (entry url) + two fills.
  const fillSteps = result.steps.filter((s) => s.action === "fill");
  assert.equal(fillSteps.length, 2, "two fill steps recorded");
  // The data-bound field keeps its `field` binding (not a literal value).
  const boundStep = fillSteps.find((s) => s.field === "homeownerName");
  assert.ok(boundStep, "data-bound fill recorded with field binding");
  assert.equal(boundStep?.value, undefined, "data-bound fill should not store a literal value");
  // The portal-literal fill keeps its literal value.
  const literalStep = fillSteps.find((s) => s.note === "Project Type");
  assert.equal(literalStep?.value, "Residential Solar", "portal-literal fill stores the literal value");
}

// 2) The final submit step is recorded isFinalSubmit:true and is NEVER clicked.
async function testFinalSubmitRecordedNeverClicked() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => ({
    fills: [{ selectorIndex: 0, value: "X", field: "homeownerName" }],
    finalSubmitSelectorIndex: 1, // the "Submit Application" button
    atReview: true,
  });
  const adapter = new AutoLearnAdapter("Test AHJ", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://portal.example/review",
            title: "Review",
            body: "Review and submit",
            rawFields: [
              { label: "Homeowner Name", fieldType: "text", id: "hn" },
              { label: "Submit Application", fieldType: "button", role: "button", text: "Submit Application" },
            ],
          },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true);
  assert.equal(result.finalSubmitRecorded, true, "final submit must be recorded");
  const finalStep = result.steps.find((s) => s.isFinalSubmit === true);
  assert.ok(finalStep, "a step flagged isFinalSubmit:true must exist");
  assert.equal(finalStep?.action, "click");
  // CRITICAL: the final submit button must NEVER have been clicked.
  assert.ok(
    !log.clicks.includes("role:button:Submit Application"),
    "final submit must NOT be clicked by learn()",
  );
  assert.equal(log.clicks.length, 0, "no clicks at all — only fills then stop at review");
}

// 3) A pay/fee button returned by the planner (as advance) is never clicked.
async function testPayFeeButtonNeverClicked() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => ({
    fills: [{ selectorIndex: 0, value: "X", field: "homeownerName" }],
    // The planner WRONGLY returns a "Pay Now" button as the page-advance control.
    advanceSelectorIndex: 1,
    atReview: false,
  });
  const adapter = new AutoLearnAdapter("Test AHJ", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://portal.example/fees",
            title: "Fees",
            body: "Pay your fees",
            rawFields: [
              { label: "Homeowner Name", fieldType: "text", id: "hn" },
              { label: "Pay Now", fieldType: "button", role: "button", text: "Pay Now" },
            ],
          },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  // The pay/fee advance must be refused; nothing pay-related is clicked.
  assert.ok(
    !log.clicks.includes("role:button:Pay Now"),
    "a pay/fee button must NEVER be clicked",
  );
  assert.equal(log.clicks.length, 0, "no advance click happened — pay/fee was refused");
  assert.match(result.message, /pay\/fee/i, "result should explain it stopped on a pay/fee control");
  assert.equal(result.ok, false, "stopping on a pay/fee control is not a clean success");
}

// 4) A challenge frame stops the run with pauseReason "mfa_captcha".
async function testChallengeStopsRun() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => ({
    fills: [{ selectorIndex: 0, value: "X" }],
    atReview: true,
  });
  const adapter = new AutoLearnAdapter("Test AHJ", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://portal.example/login",
            title: "Verify",
            body: "Verify",
            rawFields: [{ label: "Field", fieldType: "text", id: "f" }],
          },
        ],
        frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=abc"],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, false, "a challenge must stop the run");
  assert.equal(result.pauseReason, "mfa_captcha", "pauseReason must be mfa_captcha");
  assert.equal(log.fills.length, 0, "nothing should be filled once a challenge is detected");
}

// 5) Multi-page advance works: clicks "Next", continues, stops at review.
async function testMultiPageAdvance() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  let call = 0;
  const planner: LearnPlanner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
    call++;
    if (call === 1) {
      // Page 1: fill, then advance via the "Next" button (index 1).
      assert.deepEqual(req.alreadyFilledLabels, [], "no prior labels on page 1");
      return {
        fills: [{ selectorIndex: 0, value: "John", field: "homeownerName" }],
        advanceSelectorIndex: 1,
        atReview: false,
      };
    }
    // Page 2: alreadyFilledLabels resets per page. Carrying page 1's labels forward made the
    // planner skip a later page that REUSED the same labels (PowerClerk reuses "Name"/"Address"/
    // "Email" on each contact step), blanking it — so each page starts with an empty list.
    assert.deepEqual(req.alreadyFilledLabels, [], "page 2 does not inherit page 1's filled labels");
    return {
      fills: [{ selectorIndex: 0, value: "240", field: "systemSize" }],
      atReview: true,
    };
  };
  const adapter = new AutoLearnAdapter("Test AHJ", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://portal.example/p1",
            title: "Page 1",
            body: "Step 1",
            rawFields: [
              { label: "Homeowner Name", fieldType: "text", id: "hn" },
              { label: "Next", fieldType: "button", role: "button", text: "Next" },
            ],
          },
          {
            url: "https://portal.example/p2",
            title: "Page 2",
            body: "Step 2",
            rawFields: [{ label: "System Size", fieldType: "text", id: "ss" }],
            reviewPairs: [
              { label: "Homeowner Name", value: "John" },
              { label: "System Size", value: "240" },
            ],
          },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true);
  assert.equal(result.pageCount, 2, "should have visited two pages");
  assert.deepEqual(log.clicks, ["role:button:Next"], "exactly one advance (Next) click");
  assert.equal(log.fills.length, 2, "filled one field on each page");
  // An advance click step is recorded between the two pages.
  const advanceSteps = result.steps.filter((s) => s.action === "click" && /advance/i.test(s.note ?? ""));
  assert.equal(advanceSteps.length, 1, "one advance click step recorded");
  // Review screen scraped.
  assert.ok(result.reviewScreen.fields.length >= 1, "review screen fields scraped");
}

// 5b) Progress callback fires per page and at review (drives the UI progress bar).
async function testProgressEmitted() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  let call = 0;
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => {
    call++;
    if (call === 1) return { fills: [{ selectorIndex: 0, value: "John", field: "homeownerName" }], advanceSelectorIndex: 1, atReview: false };
    return { fills: [{ selectorIndex: 0, value: "240", field: "systemSize" }], atReview: true };
  };
  const progress: Array<{ phase: string; pageCount: number; classification?: string }> = [];
  const adapter = new AutoLearnAdapter("Test AHJ", planner, {
    onProgress: (p) => progress.push({ phase: p.phase, pageCount: p.pageCount, classification: p.classification }),
  });
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://portal.example/p1",
            title: "Page 1",
            body: "Step 1",
            rawFields: [
              { label: "Homeowner Name", fieldType: "text", id: "hn" },
              { label: "Next", fieldType: "button", role: "button", text: "Next" },
            ],
          },
          {
            url: "https://portal.example/p2",
            title: "Page 2",
            body: "Step 2",
            rawFields: [{ label: "System Size", fieldType: "text", id: "ss" }],
            reviewPairs: [{ label: "Homeowner Name", value: "John" }],
          },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true);
  // One progress signal per page visited (2), the second classified as review.
  assert.ok(progress.length >= 2, `expected ≥2 progress signals, got ${progress.length}`);
  assert.equal(progress[0].pageCount, 1, "first progress is page 1");
  assert.ok(progress.some((p) => p.phase === "review"), "a review-phase progress signal is emitted");
  // Page counters never go backwards (the bar advances monotonically).
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i].pageCount >= progress[i - 1].pageCount, "pageCount is monotonic");
  }
}

// 6) Sensitive fields don't store literal values.
async function testSensitiveFieldsRedacted() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => ({
    fills: [
      { selectorIndex: 0, value: "supersecret-pw", field: "password" },
      { selectorIndex: 1, value: "9990001111", field: "accountNumber" },
      { selectorIndex: 3, value: "Normal Value", field: "homeownerName" },
    ],
    atReview: true,
  });
  const adapter = new AutoLearnAdapter("Test Utility", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://portal.example/login",
            title: "Login",
            body: "Enter your account",
            rawFields: [
              { label: "Password", fieldType: "text", id: "pw" },
              { label: "Account Number", fieldType: "text", id: "acct" },
              { label: "Meter Number", fieldType: "text", id: "mtr" },
              { label: "Homeowner Name", fieldType: "text", id: "hn" },
            ],
          },
        ],
      },
      log,
    ),
  );

  // Account/meter are filled + bound DETERMINISTICALLY from the project (never the planner), so the
  // learn must receive a project carrying them. The literal values must never be recorded.
  const result = await adapter.learn(fakeContext, { ...fakeProject, accountNumber: "ACCT-9001", meterNumber: "MTR-5002" } as ProjectRecord);
  assert.equal(result.ok, true);
  const fillSteps = result.steps.filter((s) => s.action === "fill");

  // A password is a login credential, not a replayable form field — the planner's value is ignored
  // and no password fill step is recorded (it has no project-data binding).
  const pwStep = fillSteps.find((s) => s.note === "Password");
  assert.ok(!pwStep, "password is NOT recorded as a replayable fill step");

  // Account number is filled + bound deterministically from the project (not the planner's value),
  // recorded sensitive with NO literal value, bound by `field` for replay.
  const acctStep = fillSteps.find((s) => s.note === "Account Number");
  assert.ok(acctStep, "account step recorded");
  assert.equal(acctStep?.sensitive, true, "account number must be flagged sensitive");
  assert.equal(acctStep?.value, "", "account number literal value must NOT be stored");
  assert.equal(acctStep?.field, "accountNumber", "account number bound by field for replay");

  // Meter number binds the same way, so the recipe actually fills it on replay.
  const meterStep = fillSteps.find((s) => s.note === "Meter Number");
  assert.ok(meterStep, "meter step recorded");
  assert.equal(meterStep?.sensitive, true, "meter number must be flagged sensitive");
  assert.equal(meterStep?.value, "", "meter number literal value must NOT be stored");
  assert.equal(meterStep?.field, "meterNumber", "meter number bound by field for replay");

  // A non-sensitive field keeps its binding/value normally.
  const nameStep = fillSteps.find((s) => s.note === "Homeowner Name");
  assert.equal(nameStep?.sensitive, undefined, "ordinary field is not flagged sensitive");
  assert.equal(nameStep?.field, "homeownerName");

  // No secret literal may appear anywhere in the recorded steps — not the planner's password/account
  // guess, and not the real project account/meter value that was typed into the browser.
  const serialized = JSON.stringify(result.steps);
  assert.ok(!serialized.includes("supersecret-pw"), "the password literal must never be in the recorded steps");
  assert.ok(!serialized.includes("9990001111"), "the planner account value must never be in the recorded steps");
  assert.ok(!serialized.includes("ACCT-9001"), "the project account number must never be in the recorded steps");
  assert.ok(!serialized.includes("MTR-5002"), "the project meter number must never be in the recorded steps");
}

// 7) THE ACCELA TRAP: on a read-only Review page, "Continue Application" SUBMITS.
// Even if the planner WRONGLY returns it as advance, the structural guard must override
// it — record it as final submit, never click it.
async function testAccelaContinueApplicationNeverClicked() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => ({
    fills: [],
    // DANGEROUS: planner mistakes the review-page "Continue Application" for an advance.
    advanceSelectorIndex: 0,
    atReview: false,
  });
  const adapter = new AutoLearnAdapter("Oregon ePermitting", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://aca-oregon.accela.com/oregon/Cap/CapConfirm.aspx?stepNumber=4",
            title: "Review",
            body: "Step 3: Review. Please review all information below. If everything is correct, click the Continue Application button below.",
            // Read-only review page: NO fillable inputs, only the Continue Application button.
            rawFields: [
              { label: "Continue Application", fieldType: "button", role: "button", text: "Continue Application" },
            ],
          },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true);
  assert.equal(result.finalSubmitRecorded, true, "Continue Application must be recorded as the final submit");
  const finalStep = result.steps.find((s) => s.isFinalSubmit === true);
  assert.ok(finalStep, "a step flagged isFinalSubmit:true must exist for Continue Application");
  // CRITICAL: Continue Application must NEVER be clicked, despite the planner saying advance.
  assert.equal(log.clicks.length, 0, "Continue Application on the review page must NOT be clicked");
  assert.ok(result.reviewScreen != null, "should stop at the review screen");
}

// 8) NEW-TAB ADOPTION (the PowerClerk failure mode): clicking "Start Application" on the
// dashboard opens the real form in a NEW TAB. The loop must SWITCH to the popup and fill it,
// instead of re-scraping the dead dashboard until it reports "nothing fillable".
async function testNewTabPopupAdopted() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };

  // A minimal multi-tab fake: a shared `pages` array IS the browser context. Clicking the
  // dashboard's nav link pushes the form page into `pages` (a new tab opening).
  const pages: any[] = [];
  function fakeLoc(key: string, onClick?: () => void): any {
    const loc: any = {
      first: () => loc, nth: () => loc, count: async () => 1, isVisible: async () => false,
      waitFor: async () => undefined, scrollIntoViewIfNeeded: async () => undefined,
      click: async () => { log.clicks.push(key); if (onClick) onClick(); },
      fill: async (v: string) => { log.fills.push({ key, value: v }); },
      selectOption: async (v: any) => { log.selects.push({ key, value: typeof v === "string" ? v : v?.label ?? "" }); },
      check: async () => { log.checks.push(key); }, press: async () => undefined,
      setInputFiles: async () => undefined, dispatchEvent: async () => undefined,
      bringToFront: async () => undefined, evaluateAll: async () => [],
    };
    return loc;
  }
  function fakePage(opts: { url: string; title: string; body: string; rawFields: RawFieldRow[]; fp: string; navKey?: string; onNav?: () => void; reviewPairs?: Array<{ label: string; value: string }> }): any {
    const page: any = {
      url: () => opts.url, title: async () => opts.title, goto: async () => undefined,
      waitForLoadState: async () => undefined, reload: async () => undefined,
      isClosed: () => false, bringToFront: async () => undefined,
      keyboard: { press: async () => undefined }, frames: () => [],
      evaluate: async () => opts.fp, // clearOverlays ignores the return; pageFingerprint uses it
      screenshot: async () => Buffer.from(""),
      getByRole: (role: string, o?: { name?: string }) => {
        const key = `role:${role}:${o?.name ?? ""}`;
        return fakeLoc(key, opts.navKey && key === opts.navKey ? opts.onNav : undefined);
      },
      getByLabel: (l: string) => fakeLoc(`label:${l}`),
      getByPlaceholder: (p: string) => fakeLoc(`placeholder:${p}`),
      getByTestId: (t: string) => fakeLoc(`testId:${t}`),
      getByText: () => fakeLoc("text"),
      locator: (css: string) => {
        if (css === "body") return { innerText: async () => opts.body };
        if (css === "iframe") return { evaluateAll: async () => [] };
        return fakeLoc(`css:${css}`);
      },
      frameLocator: () => page,
      $$eval: async (selector: string, _fn: any) => (selector.includes("button") ? opts.rawFields : (opts.reviewPairs ?? [])),
    };
    return page;
  }

  const formPage = fakePage({
    url: "https://pacificorpnetmetering.powerclerk.com/Form/Apply", title: "Application",
    body: "Interconnection application form", fp: "form-fp",
    rawFields: [{ label: "Homeowner Name", fieldType: "text", id: "hn" }],
    reviewPairs: [{ label: "Homeowner Name", value: "Jane Solar" }],
  });
  const dashboard = fakePage({
    url: "https://pacificorpnetmetering.powerclerk.com/Homepage/ProgramHome", title: "Program Home",
    body: "Welcome to your program home", fp: "dash-fp",
    rawFields: [{ label: "Start Application", fieldType: "button", role: "link", text: "Start Application", id: "start" }],
    navKey: "role:link:Start Application",
    onNav: () => { pages.push(formPage); }, // clicking the nav link opens the form in a NEW TAB
  });
  pages.push(dashboard);

  let call = 0;
  const planner: LearnPlanner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
    call++;
    if (call === 1) {
      assert.equal(req.isDashboard, true, "page 1 is recognised as a dashboard");
      return { fills: [], navigateSelectorIndex: 0, atReview: false };
    }
    // After adoption we must be on the FORM page (not the dashboard).
    assert.match(req.url, /\/Form\/Apply/, "after the nav click the loop is on the popup form, not the dashboard");
    return { fills: [{ selectorIndex: 0, value: "Jane Solar", field: "homeownerName" }], atReview: true };
  };

  const adapter = new AutoLearnAdapter("Pacific Power", planner);
  (adapter as unknown as { page: unknown }).page = dashboard;
  (adapter as unknown as { opened: unknown }).opened = { context: { pages: () => pages } };

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true, "should succeed: adopted the popup and filled the form");
  assert.equal(log.fills.length, 1, "the form field on the popup tab was filled");
  assert.ok(result.steps.some((s) => s.action === "fill" && s.field === "homeownerName"), "form fill recorded from the adopted tab");
  // The nav link was clicked exactly once; the dashboard was not re-scraped into a stuck loop.
  assert.ok(log.clicks.includes("role:link:Start Application"), "the dashboard nav link was clicked");
}

// 9) T&C PASS-THROUGH: a Terms & Conditions/billing page (no inputs + "Continue Application"
// but NO review markers) must NOT be treated as the review screen. The loop should click
// through it and continue to the real application form.
async function testTermsPagePassThrough() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  let call = 0;
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => {
    call++;
    if (call === 1) {
      // T&C page: planner correctly says navigate past it.
      return { fills: [], navigateSelectorIndex: 0, atReview: false };
    }
    // Real form page with a fill field and an advance button.
    if (call === 2) return { fills: [{ selectorIndex: 0, value: "John", field: "homeownerName" }], advanceSelectorIndex: 1, atReview: false };
    // Review screen — return finalSubmitSelectorIndex so the Continue Application is recorded.
    return { fills: [], atReview: true, finalSubmitSelectorIndex: 0 };
  };
  const adapter = new AutoLearnAdapter("Oregon ePermitting", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            // T&C/billing page: no inputs, "Continue Application" button, NO review markers.
            url: "https://aca-oregon.accela.com/oregon/Cap/CapApplyDisclaimer.aspx",
            title: "Disclaimer",
            body: "By clicking Continue Application you agree to the Terms and Conditions of this portal.",
            rawFields: [
              { label: "Continue Application", fieldType: "button", role: "button", text: "Continue Application" },
            ],
          },
          {
            url: "https://aca-oregon.accela.com/oregon/Cap/CapApplyStep1.aspx",
            title: "Step 1",
            body: "Application form step 1",
            rawFields: [
              { label: "Homeowner Name", fieldType: "text", id: "hn" },
              { label: "Next", fieldType: "button", role: "button", text: "Next" },
            ],
          },
          {
            url: "https://aca-oregon.accela.com/oregon/Cap/CapConfirm.aspx",
            title: "Review",
            body: "Step 3: Review. Please review all information. Click Continue Application button below.",
            rawFields: [
              { label: "Continue Application", fieldType: "button", role: "button", text: "Continue Application" },
            ],
            reviewPairs: [{ label: "Homeowner Name", value: "John" }],
          },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true, "should succeed: clicked through T&C and reached real review");
  assert.equal(result.pageCount, 3, "visited all 3 pages (T&C, form, review)");
  // The T&C continue click must NOT be recorded as finalSubmit.
  const finalSteps = result.steps.filter((s) => s.isFinalSubmit === true);
  // The only finalSubmit must be the REVIEW page's Continue Application, not the T&C one.
  assert.equal(finalSteps.length, 1, "exactly one finalSubmit recorded (the review page one)");
  assert.ok(result.finalSubmitRecorded, "finalSubmit on the review page is recorded");
  // The homeowner name fill was on the actual form page, not on the T&C page.
  assert.ok(result.steps.some((s) => s.action === "fill" && s.field === "homeownerName"), "form fill recorded");
  assert.equal(result.reviewScreen.fields.length, 1, "review screen fields scraped");
}

// 11) RADIO REGRESSION: a radio choice is SELECTED via check(), not fill(), and a radio the
//     planner marks false is left unselected. Previously radios fell through to loc.fill(),
//     which throws on a radio input, so PGE "Description of Service" / "Service Type" were never
//     selected. A checkbox marked false must be unchecked, not force-checked (meter-on-pole).
async function testRadioSelectedViaCheck() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => ({
    fills: [
      { selectorIndex: 0, value: "true" },   // radio we DO want selected
      { selectorIndex: 1, value: "false" },  // radio we do NOT want (must be skipped)
      { selectorIndex: 2, value: "false" },  // checkbox marked false (must NOT be checked)
    ],
    atReview: true,
  });
  const adapter = new AutoLearnAdapter("Test Utility", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://pgenm.powerclerk.com/MvcProjects/EditProject",
            title: "Edit Project",
            body: "Description of Service",
            rawFields: [
              { label: "Single", fieldType: "radio", id: "single" },
              { label: "3-Phase", fieldType: "radio", id: "phase3" },
              { label: "Click here if your existing meter is mounted on a pole.", fieldType: "checkbox", id: "pole" },
            ],
            reviewPairs: [{ label: "Service Type", value: "Single" }],
          },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true, "run should succeed");
  // The "true" radio was checked; nothing was filled (radios are not text fills).
  assert.equal(log.fills.length, 0, "radios/checkboxes must NOT go through fill()");
  assert.ok(log.checks.some((k) => k.includes("Single")), "the selected radio is checked");
  assert.ok(!log.checks.some((k) => k.includes("3-Phase")), "a false radio is never selected");
  // Recorded steps: only the selected radio is a check step; the false radio/checkbox produce none.
  const checkSteps = result.steps.filter((s) => s.action === "check");
  assert.equal(checkSteps.length, 1, "exactly one check step recorded (the selected radio)");
}

// 11b) NOT-LISTED GUARD: the planner WRONGLY asks to check "The proposed PV equipment is not
//      listed." — checking it hides the equipment dropdowns and degrades to unlisted plain-text.
//      The deterministic guard must refuse the check while still selecting the real dropdown.
async function testNotListedCheckboxRefused() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => ({
    fills: [
      { selectorIndex: 0, value: "Photovoltaic" },              // Prime Mover dropdown — keep
      { selectorIndex: 1, value: "true" },                       // "not listed" checkbox — refuse
    ],
    atReview: true,
  });
  const adapter = new AutoLearnAdapter("Test Utility", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://pgenm.powerclerk.com/MvcProjects/EditProject",
            title: "Edit Project",
            body: "System Information",
            rawFields: [
              { label: "Prime Mover", fieldType: "select", options: ["Photovoltaic"], id: "pm" },
              { label: "The proposed PV equipment is not listed.", fieldType: "checkbox", id: "notlisted" },
            ],
            reviewPairs: [{ label: "Prime Mover", value: "Photovoltaic" }],
          },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true, "run should succeed");
  assert.ok(log.selects.some((s) => /Photovoltaic/.test(s.value)), "the real dropdown is still selected");
  assert.ok(!log.checks.some((k) => /notlisted/i.test(k)), "the 'not listed' checkbox is NEVER checked");
  assert.ok(
    !result.steps.some((s) => s.action === "check" && /not listed/i.test(s.note ?? "")),
    "no recipe step records checking the 'not listed' box",
  );
}

// 12) VALIDATION GUARD: a blocked advance (page didn't move) is detected, the dead advance step
//     is dropped, and the portal's validation errors are surfaced in the result message — instead
//     of silently recording a broken page or looping with no explanation.
async function testValidationGuardBlockedAdvance() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  // Planner: fill a field and try to advance every time. Once it's been told (via recoveryHint)
  // that validation blocked it, stop the run (atReview) so the test terminates promptly.
  let sawValidationInHint = false;
  const planner: LearnPlanner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
    if (req.recoveryHint && /validation error/i.test(req.recoveryHint)) {
      sawValidationInHint = true;
      return { fills: [], atReview: true };
    }
    return { fills: [{ selectorIndex: 0, value: "225", field: "mainServiceRating" }], advanceSelectorIndex: 1, atReview: false };
  };
  const adapter = new AutoLearnAdapter("Test Utility", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://pgenm.powerclerk.com/MvcProjects/EditProject",
            title: "Edit Project",
            body: "Description of Service",
            rawFields: [
              { label: "Main Service Entrance Rating (Amps)", fieldType: "text", id: "msr" },
              { label: "Next", fieldType: "button", role: "button", text: "Next" },
            ],
            // The advance is blocked: Schedule is required and empty (the classic PGE failure).
            blockedValidationErrors: ["Schedule: This field is required."],
          },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  // The blocker is surfaced in the message, NOT silently swallowed.
  assert.ok(/Schedule: This field is required/i.test(result.message), "validation blocker surfaced in message");
  assert.ok(/blocked an advance/i.test(result.message), "message explains the advance was blocked");
  // The recovery hint carried the specific validation error to the planner.
  assert.ok(sawValidationInHint, "planner received the validation error in its recovery hint");
  // No advance step survives for a click that never advanced the form.
  assert.ok(!result.steps.some((s) => s.note?.startsWith("advance:")), "dead advance step was dropped");
}

// 12) POWERCLERK REVIEW GATE: the final review/submit screen carries a LIVE "Accept Terms and
//     Conditions" checkbox plus a "Submit" button and no Accela-style review markers. The page
//     is therefore "fillable", so the no-input structural guard misses it. The terms-gate guard
//     must still classify it as review: auto-check the ACCEPT_TERMS box, record Submit as the
//     finalSubmit (never click it), and stop at review. An unrelated optional checkbox on the
//     same page must NOT be auto-checked.
async function testPowerClerkTermsGateReview() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
    // Page 1: a normal form page that advances to the review screen.
    if (req.fields.some((f) => f.label === "System Size (kW)")) {
      return { fills: [{ selectorIndex: 0, value: "7.2", field: "systemSizeKw" }], advanceSelectorIndex: 1, atReview: false };
    }
    // Page 2: the review/submit screen. The planner FAILS to recognize it (the real-world
    // bug): no fills, no atReview, no finalSubmit. The structural terms-gate guard must fix it.
    return { fills: [], atReview: false };
  };
  const adapter = new AutoLearnAdapter("Portland General Electric", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://pgenm.powerclerk.com/MvcProjects/EditProject",
            title: "Edit Project",
            body: "System information form.",
            rawFields: [
              { label: "System Size (kW)", fieldType: "text", id: "sz" },
              { label: "Next", fieldType: "button", role: "button", text: "Next" },
            ],
          },
          {
            url: "https://pgenm.powerclerk.com/MvcProjects/EditProject",
            title: "Edit Project",
            body: "Please complete the items below. Your form will not be submitted until you click Submit.",
            rawFields: [
              { label: "Checkbox - Alternative Billing Contact", fieldType: "checkbox", id: "abc" },
              { label: "Click to Accept Terms and Conditions", fieldType: "checkbox", id: "terms" },
              { label: "Back", fieldType: "button", role: "button", text: "Back" },
              { label: "Submit", fieldType: "button", role: "button", text: "Submit" },
            ],
            reviewPairs: [{ label: "System Size (kW)", value: "7.2" }],
          },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true, "run succeeds and reaches the review gate");
  assert.ok(result.reachedReview, "the terms-gated submit page is recognized as review");
  // The Accept-Terms checkbox is auto-checked and recorded.
  assert.ok(
    log.checks.some((k) => /terms/i.test(k)),
    "ACCEPT_TERMS checkbox was checked live",
  );
  assert.ok(
    result.steps.some((s) => s.action === "check" && /accept terms/i.test(s.note ?? "")),
    "ACCEPT_TERMS checkbox recorded as a check step",
  );
  // The unrelated optional checkbox must NOT be auto-checked.
  assert.ok(
    !log.checks.some((k) => /billing contact/i.test(k)),
    "unrelated optional checkbox left untouched",
  );
  // Submit is recorded as finalSubmit and NEVER clicked.
  const finalSteps = result.steps.filter((s) => s.isFinalSubmit === true);
  assert.equal(finalSteps.length, 1, "exactly one finalSubmit recorded (Submit)");
  assert.ok(result.finalSubmitRecorded, "finalSubmit recorded");
  assert.ok(!log.clicks.some((k) => /Submit/i.test(k)), "Submit button was never clicked");
}

// 13) DATE FIELD: a "...Date" text input is filled and recorded normally — the date-picker
//     dismissal path (page Escape + overlay sweep) must not break or drop the fill. Guards the
//     P006 commissioning-date handling.
async function testDateFieldFilledAndRecorded() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
    if (req.fields.some((f) => f.label === "Estimated Commissioning Date")) {
      return { fills: [{ selectorIndex: 0, value: "08/15/2026" }], advanceSelectorIndex: 1, atReview: false };
    }
    return { fills: [], atReview: true, finalSubmitSelectorIndex: 0 };
  };
  const adapter = new AutoLearnAdapter("Portland General Electric", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://pgenm.powerclerk.com/MvcProjects/EditProject",
            title: "Edit Project",
            body: "Service details.",
            rawFields: [
              { label: "Estimated Commissioning Date", fieldType: "text", id: "ecd" },
              { label: "Next", fieldType: "button", role: "button", text: "Next" },
            ],
          },
          {
            url: "https://pgenm.powerclerk.com/MvcProjects/EditProject",
            title: "Edit Project",
            body: "Step review. Submit your application.",
            rawFields: [{ label: "Submit", fieldType: "button", role: "button", text: "Submit" }],
            reviewPairs: [{ label: "Estimated Commissioning Date", value: "08/15/2026" }],
          },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true, "run completes (no date-picker hang)");
  assert.ok(
    log.fills.some((f) => f.value === "08/15/2026"),
    "date value typed into the input",
  );
  assert.ok(
    result.steps.some((s) => s.action === "fill" && /commissioning date/i.test(s.note ?? "")),
    "date fill recorded as a step",
  );
}

// UPLOAD SIZE CAP (split mode): a candidate file over the portal limit is never offered —
// the resolver falls through to a smaller doc that fits, and when NOTHING fits it returns
// null (skip + debug event) instead of handing the portal a file it will reject.
async function testUploadSizeCap() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-cap-test-"));
  const bigPlanSet = path.join(dir, "plan_set.pdf");
  const smallSld = path.join(dir, "sld.pdf");
  fs.writeFileSync(bigPlanSet, Buffer.alloc(6 * 1024 * 1024, 1)); // 6 MB — over the 5 MB split cap
  fs.writeFileSync(smallSld, Buffer.alloc(200 * 1024, 1)); // 200 KB — fits

  const noPlan: LearnPlanner = async () => ({ fills: [], atReview: false });
  try {
    // Labeled SLD slot → the small split sheet wins (normal path, unchanged).
    const withBoth = new AutoLearnAdapter("Cap Test", noPlan, { uploadMode: "split", docsByType: { plan_set: bigPlanSet, sld: smallSld } });
    const sldPick = (withBoth as any).resolveUpload({ selector: {}, label: "One-Line Electrical Diagram", fieldType: "file" });
    assert.equal(sldPick?.docType, "sld", "labeled slot picks the fitting split sheet");

    // Generic slot with both available: the 6 MB plan_set no longer wins the fallback —
    // the fitting sld does.
    const genericPick = (withBoth as any).resolveUpload({ selector: {}, label: "Attachment", fieldType: "file" });
    assert.equal(genericPick?.docType, "sld", `generic slot skips the oversize plan_set (got ${genericPick?.docType})`);

    // Only the oversize file exists → nothing fits the default cap → the SMALLEST doc is
    // still attached (the post-upload rejection scan catches a genuine bounce); an empty
    // slot on a portal whose real limit is higher would be worse.
    const onlyBig = new AutoLearnAdapter("Cap Test", noPlan, { uploadMode: "split", docsByType: { plan_set: bigPlanSet } });
    const overCapPick = (onlyBig as any).resolveUpload({ selector: {}, label: "Attachment", fieldType: "file" });
    assert.equal(overCapPick?.docType, "plan_set", "nothing fits → smallest doc attempted anyway");

    // Combined (AHJ) mode is uncapped by default — the full plan set still uploads.
    const combined = new AutoLearnAdapter("Cap Test", noPlan, { uploadMode: "combined", docsByType: { plan_set: bigPlanSet } });
    const combinedPick = (combined as any).resolveUpload({ selector: {}, label: "Plans", fieldType: "file" });
    assert.equal(combinedPick?.docType, "plan_set", "combined mode keeps the full plan set");

    // Env override tightens/loosens the cap (fresh adapter — file sizes are cached per run).
    process.env.PORTAL_UPLOAD_MAX_MB = "10";
    const loosenedAdapter = new AutoLearnAdapter("Cap Test", noPlan, { uploadMode: "split", docsByType: { plan_set: bigPlanSet } });
    const loosened = (loosenedAdapter as any).resolveUpload({ selector: {}, label: "Attachment", fieldType: "file" });
    assert.equal(loosened?.docType, "plan_set", "PORTAL_UPLOAD_MAX_MB=10 lets the 6 MB file through");
  } finally {
    delete process.env.PORTAL_UPLOAD_MAX_MB;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// POWERCLERK SPECS PAGE: the PV System Specification repeater labels its controls
// BARE ("Manufacturer", "Model", "Quantity") — the side lives in the SECTION header.
// The planner reliably produces nothing here, so the deterministic equipment pass
// must fill from section+label context, inherit side by proximity within a section,
// fill tilt/azimuth/tracking, and NEVER touch look-alike fields in other sections
// (EV charger "Model", "Meter model", main-panel gear).
async function testEquipmentSpecsSectionContext() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  // Planner thrash simulation: no fills, page is the review-less specs page; second
  // call reports review so the run completes.
  let calls = 0;
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => {
    calls++;
    return { fills: [], atReview: calls > 1 };
  };
  const adapter = new AutoLearnAdapter("PGE PowerClerk", planner, {
    equipment: {
      inverterMake: "AP Systems",
      inverterModel: "DS3-L",
      moduleMake: "Znshine",
      moduleModel: "ZXM7-UHLDD108-440/N",
      inverterQty: "12",
      moduleQty: "23",
      tilt: "22.5",
      azimuth: "180",
      tracking: "Fixed",
      batteryMake: "Tesla",
      batteryModel: "Powerwall 3",
      batteryQty: "2",
    },
  });
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://pgenm.powerclerk.com/specs",
            title: "PV System Specification",
            body: "PV System Specification",
            rawFields: [
              // Bare labels; side comes ONLY from section.
              { label: "Manufacturer", fieldType: "select", id: "modMfr", section: "PV Module Information" },
              { label: "Model", fieldType: "select", id: "modModel", section: "PV Module Information" },
              { label: "Quantity", fieldType: "text", id: "modQty", section: "PV Module Information" },
              { label: "Tilt", fieldType: "text", id: "tilt", section: "PV Module Information" },
              { label: "Azimuth", fieldType: "text", id: "azimuth", section: "PV Module Information" },
              { label: "Tracking", fieldType: "select", id: "tracking", section: "PV Module Information" },
              { label: "Manufacturer", fieldType: "select", id: "invMfr", section: "Inverter Information" },
              { label: "Model", fieldType: "select", id: "invModel", section: "Inverter Information" },
              { label: "Quantity", fieldType: "text", id: "invQty", section: "Inverter Information" },
              // BATTERY/ESS section: filled from battery data, never PV data.
              { label: "Manufacturer", fieldType: "select", id: "battMfr", section: "Energy Storage Information" },
              { label: "Model", fieldType: "select", id: "battModel", section: "Energy Storage Information" },
              { label: "Quantity", fieldType: "text", id: "battQty", section: "Energy Storage Information" },
              // TRAPS: same bare labels under non-PV sections — must stay untouched.
              { label: "Model", fieldType: "select", id: "evModel", section: "EV Charger Information" },
              { label: "Meter model", fieldType: "select", id: "meterModel", section: "Service Information" },
            ],
          },
          { url: "https://pgenm.powerclerk.com/review", title: "Review", body: "Review your application", rawFields: [] },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true, `run should complete (${result.message || ""})`);

  // The page's bare labels collide ("Manufacturer" ×2, "Model" ×3), so assert by
  // the VALUES that landed. Exactly 5 selects (mod mfr/model, inv mfr/model,
  // tracking) and 4 text fills (qty ×2, tilt, azimuth) — anything more means a
  // trap field (EV charger / meter model) was touched.
  // (The pre-existing sensitive-field pass no-op-selects "" on "Meter model" —
  //  label contains "meter" — which is harmless on a real portal; ignore empties.
  //  The fake page's values can't be read back, so the once-per-page late
  //  equipment pass legitimately re-applies dup-label fills — assert UNIQUE
  //  values: everything expected landed, and the traps saw nothing.)
  const selectValues = [...new Set(log.selects.map((s) => s.value).filter(Boolean))].sort();
  const fillValues = [...new Set(log.fills.map((f) => f.value).filter(Boolean))].sort();
  assert.deepEqual(selectValues, ["AP Systems", "DS3-L", "Fixed", "Powerwall 3", "Tesla", "ZXM7-UHLDD108-440/N", "Znshine"].sort(), `selects: ${JSON.stringify(selectValues)}`);
  assert.deepEqual(fillValues, ["12", "180", "2", "22.5", "23"].sort(), `fills: ${JSON.stringify(fillValues)}`);

  // Steps recorded with data bindings (replayable, no literals for bound fields).
  const eqSteps = result.steps.filter((s) => ["inverterMake", "inverterModel", "moduleMake", "moduleModel", "moduleQty", "inverterQty", "tilt", "azimuth", "tracking"].includes(s.field || ""));
  assert.ok(eqSteps.length >= 9, `all equipment steps recorded (got ${eqSteps.length})`);
}

// Proximity fallback: NO sections at all (sectionless portal) — a bare "Model"
// directly after "Inverter Manufacturer" inherits the inverter side; a bare
// "Model" after a section-less unrelated block does not get PV data.
async function testEquipmentProximityFallback() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => ({ fills: [], atReview: true });
  const adapter = new AutoLearnAdapter("Generic Portal", planner, {
    equipment: { inverterMake: "AP Systems", inverterModel: "DS3-L", moduleMake: "Znshine", moduleModel: "ZXM7-UHLDD108-440/N" },
  });
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [{
          url: "https://portal.example/specs",
          title: "Equipment",
          body: "Equipment",
          rawFields: [
            { label: "Inverter Manufacturer", fieldType: "select", id: "invMfr" },
            { label: "Model", fieldType: "select", id: "invModel" }, // inherits inverter side
            { label: "Module Manufacturer", fieldType: "select", id: "modMfr" },
            { label: "Model", fieldType: "select", id: "modModel" }, // inherits module side
            // LEAK GUARDS (sectionless page): a racking block ends the inherited
            // side, so its bare Model must NOT receive PV data; and a far-away
            // bare Manufacturer (beyond the 3-field proximity bound) stays empty.
            { label: "Racking Manufacturer", fieldType: "select", id: "rackMfr" },
            { label: "Model", fieldType: "select", id: "rackModel" },
            { label: "Notes", fieldType: "text", id: "n1" },
            { label: "Contact", fieldType: "text", id: "n2" },
            { label: "Manufacturer", fieldType: "select", id: "farMfr" },
          ],
        }],
      },
      log,
    ),
  );
  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true);
  // DOM order: inverter make → bare Model (inherits inverter) → module make →
  // bare Model (inherits module). The racking block and the far bare
  // Manufacturer receive NOTHING (guard reset + proximity bound).
  const values = log.selects.map((s) => s.value).filter(Boolean);
  assert.deepEqual(values, ["AP Systems", "DS3-L", "Znshine", "ZXM7-UHLDD108-440/N"], JSON.stringify(values));
}

// COMBINED-SELECT SPECS TEMPLATE (the other PowerClerk shape): each repeater row
// is a bare "Qty" input plus ONE UNLABELED "Please select..." dropdown whose
// options are certified make+model strings. No "Manufacturer"/"Model" wording
// exists anywhere — side comes from row order (Inverter row first, then PV
// Array rows) within the spec section. The pass must fill both selects
// model-first, leave the bare Qty inputs to the planner, and never touch an
// unlabeled select outside the spec section.
async function testEquipmentCombinedSelectRepeater() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => ({ fills: [], atReview: true });
  const adapter = new AutoLearnAdapter("SCE PowerClerk", planner, {
    equipment: {
      inverterMake: "Enphase",
      inverterModel: "IQ8PLUS-72-2-US",
      moduleMake: "Znshine",
      moduleModel: "ZXM7-UHLDD108-440/N",
      inverterQty: "16",
      moduleQty: "31",
    },
  });
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [{
          url: "https://scenm.powerclerk.com/specs",
          title: "PV System Specification",
          body: "PV System Specification",
          rawFields: [
            // Inverter row: bare Qty + unlabeled combined select.
            { label: "Qty", fieldType: "text", id: "invQty", section: "PV System Specification" },
            { label: "", fieldType: "select", id: "invSel", section: "PV System Specification" },
            // PV Array row: same shape.
            { label: "Qty", fieldType: "text", id: "arrQty", section: "PV System Specification" },
            { label: "", fieldType: "select", id: "arrSel", section: "PV System Specification" },
            // Row-header-labeled variant must also resolve (explicit side wording).
            { label: "PV Array", fieldType: "select", id: "arr2Sel", section: "PV System Specification" },
            // TRAP: unlabeled select OUTSIDE the spec section — must stay empty.
            { label: "", fieldType: "select", id: "utilSel", section: "Utility Information" },
          ],
        }],
      },
      log,
    ),
  );
  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true, `run should complete (${result.message || ""})`);
  // Model-first candidates: the full model string is applied (the fake page
  // can't be read back, so the first candidate is trusted). The trap select and
  // the bare Qty inputs (planner's job, filled by index from the screenshot)
  // receive nothing from this pass.
  const selectValues = [...new Set(log.selects.map((s) => s.value).filter(Boolean))].sort();
  assert.deepEqual(selectValues, ["IQ8PLUS-72-2-US", "ZXM7-UHLDD108-440/N"].sort(), `selects: ${JSON.stringify(log.selects)}`);
  assert.ok(!log.selects.some((s) => s.key.includes("utilSel") && s.value), "trap select untouched");
  const qtyFills = log.fills.filter((f) => /invQty|arrQty/.test(f.key) && f.value);
  assert.equal(qtyFills.length, 0, `bare Qty left to the planner: ${JSON.stringify(qtyFills)}`);
  const boundKeys = result.steps.map((s) => s.field).filter(Boolean);
  assert.ok(boundKeys.includes("inverterModel") && boundKeys.includes("moduleModel"), `data-bound steps recorded: ${JSON.stringify(boundKeys)}`);
}

// ACA WORK-LOCATION + RECORD-TYPE (deterministic passes, live-verified selectors from
// the 2026-08-27 Salem bundles): the street-number control is an unlabeled from/to pair
// (…txtStreetNo4Search$ChildControl0/1) the planner left EMPTY on every live run, and
// the page's bare "Search" also matches the header-nav tab (the drift that bounced every
// run into the records module). The pass must fill via the id hooks, click the PANEL
// search, pick the jurisdiction row's Select link, and the record-type pass must then
// check the discipline's type — all without a planner call for those pages.
async function testAcaWorkLocationAndRecordTypeDeterministic() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  let plannerCalls = 0;
  const planner: LearnPlanner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
    plannerCalls++;
    // The ONLY page the planner should ever see in this run is the final review page.
    assert.match(req.url, /CapConfirm/, `planner saw a page the deterministic passes own: ${req.url}`);
    return { fills: [], atReview: true, finalSubmitSelectorIndex: 0 };
  };
  const adapter = new AutoLearnAdapter("Oregon ePermitting", planner);
  const project = {
    projectAddress: "1717 17th St SE, Salem, OR, 97302",
    permitType: "electrical",
    city: "Salem",
  } as ProjectRecord;
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            // p1: the address-search step. The pass fills + clicks Search (→ p2).
            url: "https://aca-oregon.accela.com/oregon/Cap/WorkLocation.aspx",
            title: "Work Location",
            body: "Begin your application by entering the work site location. Enter Work Site Location",
            rawFields: [{ label: "Search", fieldType: "button", role: "button", text: "Search" }],
          },
          {
            // p2: same step showing the results grid — the pass clicks the row's Select (→ p3).
            url: "https://aca-oregon.accela.com/oregon/Cap/WorkLocation.aspx",
            title: "Work Location",
            body: "Enter Work Site Location 1717 17TH ST SE COUNTY APPLICATIONS SALEM Select",
            rawFields: [{ label: "Select", fieldType: "button", role: "link", text: "Select" }],
          },
          {
            // p3: record-type selection — the record-type pass checks the electrical type (→ p4).
            url: "https://aca-oregon.accela.com/oregon/Cap/CapType.aspx",
            title: "Select a Record Type",
            body: "Select a Record Type",
            rawFields: [
              { label: "Residential - Structural Comprehensive", fieldType: "checkbox", id: "rtStruct" },
              { label: "Residential - Electrical Comprehensive", fieldType: "checkbox", id: "rtElec" },
              { label: "Continue Application", fieldType: "button", role: "button", text: "Continue Application" },
            ],
          },
          {
            // p4: review — the planner's first (and only) look.
            url: "https://aca-oregon.accela.com/oregon/Cap/CapConfirm.aspx",
            title: "Review",
            body: "Step 3: Review. Please review all information.",
            rawFields: [{ label: "Continue Application", fieldType: "button", role: "button", text: "Continue Application" }],
            reviewPairs: [{ label: "Street", value: "17th" }],
          },
        ],
      },
      log,
    ),
  );
  const result = await adapter.learn(fakeContext, project);
  assert.equal(result.ok, true, `run should complete (${result.message || ""})`);
  // Street number went in through the live-verified id hook — the labeled lookup misses it.
  const numFill = log.fills.find((f) => f.key.includes("StreetNo4Search"));
  assert.ok(numFill, `street number filled via the id hook: ${JSON.stringify(log.fills)}`);
  assert.equal(numFill!.value, "1717");
  const nameFill = log.fills.find((f) => f.key.includes("txtStreetName"));
  assert.ok(nameFill, "street name filled via the id hook");
  // Portion-FIRST search (the portal's own hint + the live watermark "First 3
  // characters only"); the full core name is the fallback attempt.
  assert.equal(nameFill!.value, "17t", "3-char portion of the core street name leads");
  // The PANEL search button was clicked — never a bare role/name "Search" (the nav trap).
  assert.ok(log.clicks.some((k) => k.includes("btnSearch")), `panel search clicked: ${JSON.stringify(log.clicks)}`);
  assert.ok(!log.clicks.includes("role:button:Search"), "the header-nav Search tab must never be clicked");
  // The jurisdiction row's Select link advanced the wizard.
  assert.ok(log.clicks.some((k) => k.startsWith("role:link:") && k.includes("Select")), "address row Select link clicked");
  // Record type: the ELECTRICAL type was checked (permitType drives the choice).
  assert.ok(log.checks.length > 0, "record-type checkbox checked");
  const recordTypeStep = result.steps.find((s) => (s.note || "").startsWith("record type:"));
  assert.ok(recordTypeStep, "record-type step recorded for replay");
  assert.match(String(recordTypeStep!.note), /Electrical/i, "electrical record type chosen for an electrical permit");
  // Replayable steps recorded for the address search with css selectors — and BOUND to
  // project fields (recipes are shared: a replay must search THAT project's address,
  // never this run's literals).
  const numStep = result.steps.find((s) => s.note === "work location: street number");
  assert.ok(numStep?.selector?.css?.includes("StreetNo4Search"), "street-number step records the id-hook selector");
  assert.equal(numStep?.field, "streetNumber", "street number is field-bound for replay");
  assert.equal(result.steps.find((s) => s.note === "work location: street name (portion)")?.field, "streetNameSearchPortion", "street name is field-bound to the portion key the search actually matched");
  // The Select click keeps its jurisdiction row context — a bare role/name "Select"
  // resolves to .first() at replay and silently files under the wrong authority.
  const selStep = result.steps.find((s) => (s.note || "").startsWith("work location: select"));
  assert.ok(selStep?.selector?.css?.includes("COUNTY APPLICATIONS"), `row context recorded: ${JSON.stringify(selStep?.selector)}`);
  assert.equal(plannerCalls, 1, "planner consulted only on the review page");
}

// ACA WRONG-MODULE GUARD: CapHome's "Applications & Permits" list + General Search is
// the records/search module, NOT the Apply wizard — the live runs drifted there and the
// planner then operated on the operator's REAL filings. The learner must leave
// immediately (goto the apply-flow entry, bounded) and never click Resume Application.
async function testAcaWrongModuleReentry() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const gotoUrls: string[] = [];
  let plannerCalls = 0;
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => {
    plannerCalls++;
    // Once the bounded re-entries are exhausted the planner may see the page — it must
    // do nothing dangerous; end the run.
    return { fills: [], atReview: true };
  };
  const adapter = new AutoLearnAdapter("Oregon ePermitting", planner);
  const page = makeFakePage(
    {
      pages: [{
        url: "https://aca-oregon.accela.com/oregon/Cap/CapHome.aspx?module=Building",
        title: "Applications & Permits",
        body: "Applications and Permits. General Search.",
        rawFields: [
          { label: "Resume Application", fieldType: "button", role: "link", text: "Resume Application" },
          { label: "ctl00$PlaceHolderMain$generalSearchForm$txtGSNumber$ChildControl0", fieldType: "text", id: "gs0" },
          { label: "Search >>", fieldType: "button", role: "button", text: "Search >>" },
        ],
      }],
    },
    log,
  );
  page.goto = async (u: string) => { gotoUrls.push(u); };
  withFakePage(adapter, page);
  const result = await adapter.learn(fakeContext, fakeProject);
  // The guard re-entered the apply flow (bounded at 2) with the derived disclaimer URL.
  assert.equal(gotoUrls.length, 2, `bounded re-entry: ${JSON.stringify(gotoUrls)}`);
  assert.match(gotoUrls[0], /\/oregon\/Cap\/CapApplyDisclaimer\.aspx\?module=Building$/);
  assert.ok(result.steps.filter((s) => s.action === "goto" && (s.note || "").includes("re-enter apply flow")).length === 2, "re-entry gotos recorded");
  // The records module's own controls were never operated.
  assert.ok(!log.clicks.some((k) => /resume application/i.test(k)), "Resume Application never clicked");
  assert.ok(!log.fills.some((f) => /generalSearchForm/i.test(f.key)), "General Search never filled");
}

// ACA ENTRY DISCLAIMER (deterministic): the T&C page is handled without a planner call —
// agree checkbox via the codegen-verified id hook, then Continue Application.
async function testAcaDisclaimerDeterministic() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  let plannerCalls = 0;
  const planner: LearnPlanner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
    plannerCalls++;
    assert.doesNotMatch(req.url, /CapApplyDisclaimer/, "planner must never see the disclaimer page");
    return { fills: [], atReview: true, finalSubmitSelectorIndex: 0 };
  };
  const adapter = new AutoLearnAdapter("Oregon ePermitting", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://aca-oregon.accela.com/oregon/Cap/CapApplyDisclaimer.aspx?module=Building",
            title: "Disclaimer",
            body: "Please review the Terms and Conditions. I have read and agree.",
            rawFields: [{ label: "Continue Application", fieldType: "button", role: "button", text: "Continue Application" }],
          },
          {
            url: "https://aca-oregon.accela.com/oregon/Cap/CapConfirm.aspx",
            title: "Review",
            body: "Step 3: Review. Please review all information.",
            rawFields: [{ label: "Continue Application", fieldType: "button", role: "button", text: "Continue Application" }],
            reviewPairs: [{ label: "Street", value: "17th" }],
          },
        ],
      },
      log,
    ),
  );
  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true, `run should complete (${result.message || ""})`);
  assert.ok(log.checks.some((k) => k.includes("termAccept")), `agree box checked via the id hook: ${JSON.stringify(log.checks)}`);
  assert.ok(result.steps.some((s) => (s.note || "") === "accela: accept entry terms"), "disclaimer accept recorded for replay");
  assert.equal(plannerCalls, 1, "no LLM call burned on the static T&C page");
}

// EXISTING-RECORD CONTROLS ARE OFF-LIMITS: a planner that returns "Resume Application"
// (someone's real draft filing) as the advance button must be refused, same as pay/fee.
async function testResumeApplicationNeverClicked() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> =>
    ({ fills: [{ selectorIndex: 0, value: "x", field: "notes" }], advanceSelectorIndex: 1, atReview: false });
  const adapter = new AutoLearnAdapter("Some County Portal", planner);
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [{
          url: "https://permits.example.gov/records",
          title: "Records",
          body: "Your records",
          rawFields: [
            { label: "Notes", fieldType: "text", id: "notes" },
            { label: "Resume Application", fieldType: "button", role: "link", text: "Resume Application" },
          ],
        }],
      },
      log,
    ),
  );
  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, false, "run must stop rather than resume an existing record");
  assert.ok(!log.clicks.some((k) => /resume application/i.test(k)), "Resume Application never clicked");
}

// ACA CONTACT step: CapEdit's Applicant/Site-Contact section stalls the planner (the
// account-dialog's Continue is disabled until a row is picked — live Coos Bay run:
// stuck ×3 → recovery exhausted). Per the operator, the pass clicks "Add New" and fills
// the FILING contractor's identity into the ACADialogFrame, never selecting one of the
// account's many pre-existing contacts.
async function testAcaAddContactDeterministic() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  let plannerCalls = 0;
  const planner: LearnPlanner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
    plannerCalls++;
    assert.match(req.url, /CapConfirm/, `planner saw the contacts page it should own: ${req.url}`);
    return { fills: [], atReview: true, finalSubmitSelectorIndex: 0 };
  };
  const adapter = new AutoLearnAdapter("Oregon ePermitting", planner, {
    contactIdentity: {
      firstName: "TML", lastName: "International", email: "permit@example.com",
      // Formatted phone + ZIP+4: ACA validates Primary Phone as three segments and Zip
      // as exactly ##### (operator-observed "Required Invalid" on both).
      phone: "(800) 818-0598", street: "808 SE Chkalov Dr ST 3-337",
      city: "Vancouver", state: "WA", zip: "98683-1234",
    },
  });
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://aca-oregon.accela.com/oregon/Cap/CapEdit.aspx",
            title: "General Info",
            // The saved contact's name appears on the page after the dialog commits — the
          // read-back the pass uses to prove ACA did not substitute an account contact.
          body: "Step 1: General Info > Applicant. Select from Account or Add New. TML International",
            rawFields: [
              { label: "Select from Account", fieldType: "button", role: "button", text: "Select from Account" },
              { label: "Add New", fieldType: "button", role: "button", text: "Add New" },
              { label: "Continue Application", fieldType: "button", role: "button", text: "Continue Application" },
            ],
          },
          {
            url: "https://aca-oregon.accela.com/oregon/Cap/CapConfirm.aspx",
            title: "Review",
            // The real review screen lists the Applicant block — that is what the pass
            // reads back to prove ACA attached the contact we saved rather than
            // substituting one of the account's own.
            body: "Step 3: Review. Please review all information. Applicant TML International",
            rawFields: [{ label: "Continue Application", fieldType: "button", role: "button", text: "Continue Application" }],
            reviewPairs: [{ label: "Applicant", value: "TML International" }],
          },
        ],
      },
      log,
    ),
  );
  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true, `run should complete (${result.message || ""})`);
  assert.ok(log.clicks.some((k) => /add new/i.test(k)), `Add New was clicked: ${JSON.stringify(log.clicks)}`);
  assert.ok(!log.clicks.some((k) => /select from account/i.test(k)), "must NOT select a pre-existing account contact");
  // Steps are tagged with the SECTION role: section 0 is the filing contractor
  // (applicant), section 1 is the property owner (site contact). Installer identity must
  // never be written into the site-contact section.
  assert.ok(result.steps.some((s) => (s.note || "") === "contact(applicant): add new"), "add-new recorded for the applicant section");
  assert.ok(result.steps.some((s) => /^contact: last name \[applicant\]$/.test(s.note || "") && s.field === "installerLastName"), `contact last name filled + field-bound: ${JSON.stringify(result.steps.map((s) => s.note))}`);
  assert.ok(result.steps.some((s) => /^contact: email \[applicant\]$/.test(s.note || "") && s.field === "installerEmail"), "contact email filled + field-bound");
  // Each contact field must record its OWN selector - one shared selector replays every
  // value into the same input (and, at learn time, last name overwrote first name).
  const contactSels = result.steps
    .filter((s) => (s.note || "").startsWith("contact: ") && s.action === "fill")
    .map((s) => String(s.selector?.css ?? ""));
  assert.equal(new Set(contactSels).size, contactSels.length, `contact fills use distinct selectors: ${JSON.stringify(contactSels)}`);
  // Zip is trimmed to exactly 5 digits (ACA rejects ZIP+4 with "Invalid (#####)").
  const zipStep = result.steps.find((s) => (s.note || "").startsWith("contact: zip"));
  assert.ok(zipStep, "zip recorded");
  assert.equal(zipStep!.value, "98683", `zip trimmed to 5 digits, got ${zipStep!.value}`);
  // The phone is split across the segmented control, never dumped whole into one box.
  const phoneSegs = result.steps.filter((s) => (s.note || "").startsWith("contact: phone"));
  assert.ok(phoneSegs.length >= 1, "phone recorded");
  const phoneValues = phoneSegs.map((s) => String(s.value));
  assert.ok(!phoneValues.includes("(800) 818-0598"), `the raw formatted string is never filled: ${JSON.stringify(phoneValues)}`);
  assert.ok(phoneValues.every((v) => /^\d{3,4}$/.test(v) || /^\d{3}-\d{3}-\d{4}$/.test(v)), `phone parts are digit segments: ${JSON.stringify(phoneValues)}`);
  assert.equal(plannerCalls, 1, "no planner call burned on the contacts step");
}

// ACA ATTACHMENT: Accela commits attachments only on the section's own "Save" —
// "Continue Application" leaves them pending (operator-reported, live). Each pending row
// also demands its own Description + Type. The pass must fill the empty ones and click
// Save, never "Save and resume later".
async function testAcaAttachmentSavePass() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  // The attachment step is a FORM page (uploads are skipped on review screens), so the
  // planner advances off it; page 2 is the review screen.
  let call = 0;
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => {
    call++;
    if (call === 1) return { fills: [], advanceSelectorIndex: 2, atReview: false };
    return { fills: [], atReview: true, finalSubmitSelectorIndex: 0 };
  };
  const adapter = new AutoLearnAdapter("Oregon ePermitting", planner, {
    docsByType: { plan_set: "C:/tmp/plan-set.pdf" },
    uploadMode: "combined",
  });
  const page = makeFakePage(
    {
      pages: [
        {
          url: "https://aca-oregon.accela.com/oregon/Cap/CapAttachment.aspx",
          title: "Attachment",
          body: "Attachment. File names should not contain special characters. No records found. Description Type (Required)",
          rawFields: [
            { label: "Type (Required)", fieldType: "select", id: "docType", options: ["--Select--", "Plans - Structural", "Plans - Electrical"] },
            { label: "Description", fieldType: "text", id: "desc" },
            { label: "Next", fieldType: "button", role: "button", text: "Next" },
          ],
          reviewPairs: [],
        },
        {
          url: "https://aca-oregon.accela.com/oregon/Cap/CapConfirm.aspx",
          title: "Review",
          body: "Step 3: Review. Please review all information.",
          rawFields: [{ label: "Continue Application", fieldType: "button", role: "button", text: "Continue Application" }],
          reviewPairs: [{ label: "Attachment", value: "plan-set.pdf" }],
        },
      ],
    },
    log,
  );
  // page.evaluate serves the upload-slot detector ONLY (it is also used for
  // fingerprints / banner scrapes, which must stay empty).
  const slotEval = (slots: unknown[]) => async (fn: unknown) =>
    (/data-al-upl/.test(String(fn ?? "")) ? slots : []);
  page.evaluate = slotEval([{ key: "u0", label: "", kind: "input", required: true }]);
  withFakePage(adapter, page);
  const project = { permitType: "structural" } as ProjectRecord;
  const result = await adapter.learn(fakeContext, project);
  assert.equal(result.ok, true, `run should complete (${result.message || ""})`);
  // The live ACA Save is an <a> (role=link) whose inner <span> holds the text, so a
  // button-role / :text-is locator counts ZERO on the real DOM - the pass must try the
  // LINK role first, and record it that way.
  assert.ok(log.clicks.some((k) => /role:link:.*Save/.test(k)), `Save clicked via the link role: ${JSON.stringify(log.clicks)}`);
  const saveStep = result.steps.find((s) => (s.note || "") === "attachment: save (commits the upload)");
  assert.ok(saveStep, "attachment save recorded for replay");
  assert.equal(saveStep!.selector?.role, "link", "recorded Save targets the anchor role the live control uses");
  assert.equal(saveStep!.selector?.exact, true, "Save is matched exactly so 'Save and resume later' can't be hit");
}

// UPLOAD DEDUPE: the same file must not be attached through several GENERIC slots — on
// Accela that creates duplicate pending rows, each demanding its own Description/Type
// (live Coos Bay: 3 rows of one PDF, two empty and blocking). Labeled slots are
// unaffected: combined mode legitimately gives each named slot the same plan set.
async function testUploadDedupeGenericSlots() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  // The planner keeps trying to advance, but the portal BLOCKS it (validation), so the
  // loop re-enters the SAME attachment page several times — exactly the live Accela shape
  // (every wizard step is served from CapEdit.aspx and the loop revisits it repeatedly).
  // The dedupe must be RUN-scoped: a per-visit set still re-attached on each pass and
  // produced a new pending row each time.
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> =>
    ({ fills: [], advanceSelectorIndex: 1, atReview: false });
  const adapter = new AutoLearnAdapter("Oregon ePermitting", planner, {
    docsByType: { plan_set: "C:/tmp/plan-set.pdf" },
    uploadMode: "combined",
  });
  const page = makeFakePage(
    {
      pages: [
        {
          url: "https://aca-oregon.accela.com/oregon/Cap/CapAttachment.aspx",
          title: "Attachment",
          body: "Attachment section",
          rawFields: [
            { label: "Notes", fieldType: "text", id: "n" },
            { label: "Next", fieldType: "button", role: "button", text: "Next" },
          ],
          // The portal refuses the advance, so the loop revisits this page.
          blockedValidationErrors: ["Description is required"],
          reviewPairs: [],
        },
        {
          url: "https://aca-oregon.accela.com/oregon/Cap/CapConfirm.aspx",
          title: "Review",
          body: "Step 3: Review. Please review all information.",
          rawFields: [{ label: "Continue Application", fieldType: "button", role: "button", text: "Continue Application" }],
          reviewPairs: [{ label: "Attachment", value: "plan-set.pdf" }],
        },
      ],
    },
    log,
  );
  // Three GENERIC slots (Accela's repeated attachment rows) + one LABELED slot.
  page.evaluate = async (fn: unknown) =>
    (/data-al-upl/.test(String(fn ?? "")) && /CapAttachment/.test(String(page.url()))
      ? [
          { key: "u0", label: "", kind: "input", required: true },
          { key: "u1", label: "", kind: "input", required: false },
          { key: "u2", label: "Browse", kind: "input", required: false },
          { key: "u3", label: "One-Line Electrical Diagram", kind: "input", required: false },
        ]
      : []);
  withFakePage(adapter, page);
  const result = await adapter.learn(fakeContext, fakeProject);
  const uploads = result.steps.filter((s) => s.action === "upload");
  // Across the WHOLE run (several visits to this page): one attach through the generic
  // slots + one through the labeled slot. Never one pair per visit.
  assert.equal(uploads.length, 2, `run-scoped dedupe holds across re-visits: ${JSON.stringify(uploads.map((u) => u.note))}`);
  assert.ok(uploads.some((u) => /One-Line/i.test(String(u.note))), "the labeled slot still received the combined plan set");
}

// ACA CONTACT SUBSTITUTION: a dialog save that does not commit leaves ACA free to attach
// one of the ACCOUNT's own contacts instead. Live, the Applicant came out as the account's
// "Permit Tech" while the pass reported success — the permit would have been filed under
// the wrong person. The pass must READ BACK the saved name and refuse to claim success.
async function testAcaContactSubstitutionDetected() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => ({ fills: [], atReview: true });
  const adapter = new AutoLearnAdapter("Oregon ePermitting", planner, {
    contactIdentity: { firstName: "TML", lastName: "International", email: "permit@example.com", phone: "800-818-0598", zip: "98683" },
  });
  withFakePage(
    adapter,
    makeFakePage(
      {
        pages: [
          {
            url: "https://aca-oregon.accela.com/oregon/Cap/CapEdit.aspx",
            title: "General Info",
            body: "Step 1: General Info > Applicant. Select from Account or Add New.",
            rawFields: [
              { label: "Select from Account", fieldType: "button", role: "button", text: "Select from Account" },
              { label: "Add New", fieldType: "button", role: "button", text: "Add New" },
              { label: "Continue Application", fieldType: "button", role: "button", text: "Continue Application" },
            ],
          },
          {
            url: "https://aca-oregon.accela.com/oregon/Cap/CapEdit.aspx",
            title: "General Info",
            // ACA attached one of the ACCOUNT's contacts instead of ours.
            body: "Step 1: General Info > Applicant. Permit Tech 808 SE Chkalov Dr Vancouver WA 98664",
            rawFields: [{ label: "Continue Application", fieldType: "button", role: "button", text: "Continue Application" }],
          },
        ],
      },
      log,
    ),
  );
  const result = await adapter.learn(fakeContext, fakeProject);
  // No contact step may survive: a save the portal did not honour must not replay later.
  const contactSteps = result.steps.filter((st) => /contact/i.test(String(st.note ?? "")));
  assert.equal(contactSteps.length, 0, `contact steps rolled back: ${JSON.stringify(contactSteps.map((c) => c.note))}`);
}

const tests: Array<[string, () => Promise<void>]> = [
  ["ACA CONTACT SUBSTITUTION: a contact the portal did not attach is not reported as saved", testAcaContactSubstitutionDetected],
  ["ACA ATTACHMENT: Save commits the upload (not Continue), rows get Description + Type", testAcaAttachmentSavePass],
  ["UPLOAD DEDUPE: one attach through generic slots, labeled slots unaffected", testUploadDedupeGenericSlots],
  ["ACA CONTACT: Add New with the contractor identity, never a pre-existing account contact", testAcaAddContactDeterministic],
  ["ACA DETERMINISTIC: work-location + record-type handled without the planner", testAcaWorkLocationAndRecordTypeDeterministic],
  ["ACA WRONG-MODULE: records/search module exited via bounded re-entry, real records untouched", testAcaWrongModuleReentry],
  ["ACA DISCLAIMER: entry T&C accepted deterministically, no planner call", testAcaDisclaimerDeterministic],
  ["EXISTING-RECORD GUARD: Resume Application advance is refused, never clicked", testResumeApplicationNeverClicked],
  ["POWERCLERK COMBINED SELECTS: unlabeled repeater dropdowns filled by row order, traps untouched", testEquipmentCombinedSelectRepeater],
  ["POWERCLERK SPECS: bare labels filled via section context; EV/meter traps untouched", testEquipmentSpecsSectionContext],
  ["EQUIPMENT PROXIMITY: sectionless bare Model inherits side from preceding make", testEquipmentProximityFallback],
  ["fields are extracted, filled, and recorded as steps", testFieldsExtractedFilledRecorded],
  ["RADIO REGRESSION: radio selected via check(), false radio/checkbox skipped", testRadioSelectedViaCheck],
  ["NOT-LISTED GUARD: 'equipment not listed' checkbox refused, dropdown still selected", testNotListedCheckboxRefused],
  ["VALIDATION GUARD: blocked advance is detected and surfaced", testValidationGuardBlockedAdvance],
  ["a click that opens the form in a NEW TAB is adopted (PowerClerk)", testNewTabPopupAdopted],
  ["final submit is recorded isFinalSubmit:true and NEVER clicked", testFinalSubmitRecordedNeverClicked],
  ["a pay/fee button returned by the planner is never clicked", testPayFeeButtonNeverClicked],
  ["a challenge frame stops the run with pauseReason mfa_captcha", testChallengeStopsRun],
  ["multi-page advance clicks Next, continues, stops at review", testMultiPageAdvance],
  ["progress callback fires per page and at review", testProgressEmitted],
  ["sensitive fields don't store literal values", testSensitiveFieldsRedacted],
  ["ACCELA TRAP: Continue Application on review page recorded, never clicked", testAccelaContinueApplicationNeverClicked],
  ["T&C PASS-THROUGH: disclaimer page is not treated as review screen", testTermsPagePassThrough],
  ["POWERCLERK REVIEW GATE: terms-checkbox submit page is review, box auto-checked, submit recorded", testPowerClerkTermsGateReview],
  ["DATE FIELD: commissioning date filled and recorded, picker dismissal does not drop it", testDateFieldFilledAndRecorded],
  ["UPLOAD SIZE CAP: oversize file skipped in split mode, fitting doc preferred, combined uncapped", testUploadSizeCap],
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
  console.error(`\n${failures} auto-learn test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} auto-learn-adapter tests passed.`);
