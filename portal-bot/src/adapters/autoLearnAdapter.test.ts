import assert from "node:assert/strict";
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
        // Clicking an "advance" (Next/Continue) navigates to the next page.
        pageIdx++;
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
    // Page 2: the prior page's label should be in context, then we reach review.
    assert.ok(req.alreadyFilledLabels.includes("Homeowner Name"), "page 2 sees prior labels");
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

// 6) Sensitive fields don't store literal values.
async function testSensitiveFieldsRedacted() {
  const log: ActionLog = { clicks: [], fills: [], selects: [], checks: [] };
  const planner: LearnPlanner = async (): Promise<LearnPlanResponse> => ({
    fills: [
      { selectorIndex: 0, value: "supersecret-pw", field: "password" },
      { selectorIndex: 1, value: "4036870000", field: "accountNumber" },
      { selectorIndex: 2, value: "Normal Value", field: "homeownerName" },
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
              { label: "Homeowner Name", fieldType: "text", id: "hn" },
            ],
          },
        ],
      },
      log,
    ),
  );

  const result = await adapter.learn(fakeContext, fakeProject);
  assert.equal(result.ok, true);
  const fillSteps = result.steps.filter((s) => s.action === "fill");

  const pwStep = fillSteps.find((s) => s.note === "Password");
  assert.ok(pwStep, "password step recorded");
  assert.equal(pwStep?.sensitive, true, "password must be flagged sensitive");
  assert.equal(pwStep?.value, "", "password literal value must NOT be stored");
  assert.equal(pwStep?.field, "password", "password bound by field instead");

  const acctStep = fillSteps.find((s) => s.note === "Account Number");
  assert.ok(acctStep, "account step recorded");
  assert.equal(acctStep?.sensitive, true, "account number must be flagged sensitive");
  assert.equal(acctStep?.value, "", "account number literal value must NOT be stored");

  // A non-sensitive field keeps its binding/value normally.
  const nameStep = fillSteps.find((s) => s.note === "Homeowner Name");
  assert.equal(nameStep?.sensitive, undefined, "ordinary field is not flagged sensitive");
  assert.equal(nameStep?.field, "homeownerName");

  // Assert the secret literal never appears anywhere in the recorded steps payload.
  const serialized = JSON.stringify(result.steps);
  assert.ok(!serialized.includes("supersecret-pw"), "the password literal must never be in the recorded steps");
  assert.ok(!serialized.includes("4036870000"), "the account number literal must never be in the recorded steps");
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

const tests: Array<[string, () => Promise<void>]> = [
  ["fields are extracted, filled, and recorded as steps", testFieldsExtractedFilledRecorded],
  ["a click that opens the form in a NEW TAB is adopted (PowerClerk)", testNewTabPopupAdopted],
  ["final submit is recorded isFinalSubmit:true and NEVER clicked", testFinalSubmitRecordedNeverClicked],
  ["a pay/fee button returned by the planner is never clicked", testPayFeeButtonNeverClicked],
  ["a challenge frame stops the run with pauseReason mfa_captcha", testChallengeStopsRun],
  ["multi-page advance clicks Next, continues, stops at review", testMultiPageAdvance],
  ["sensitive fields don't store literal values", testSensitiveFieldsRedacted],
  ["ACCELA TRAP: Continue Application on review page recorded, never clicked", testAccelaContinueApplicationNeverClicked],
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
