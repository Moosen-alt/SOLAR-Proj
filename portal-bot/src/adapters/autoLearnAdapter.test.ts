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
      fill: async (v: string) => { log.fills.push({ key, value: v }); },
      selectOption: async (v: any) => {
        log.selects.push({ key, value: typeof v === "string" ? v : v?.label ?? "" });
      },
      check: async () => { log.checks.push(key); },
      uncheck: async () => undefined,
      press: async () => undefined,
      waitFor: async () => undefined,
      setInputFiles: async () => undefined,
      innerText: async () => curPage().body,
      // detectChallengeFrame reads iframe src attributes via evaluateAll.
      evaluateAll: async () => [],
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
      { selectorIndex: 1, value: "4036870000", field: "accountNumber" },
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
  assert.ok(!serialized.includes("4036870000"), "the planner account value must never be in the recorded steps");
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

const tests: Array<[string, () => Promise<void>]> = [
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
