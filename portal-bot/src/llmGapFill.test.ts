import assert from "node:assert/strict";
import { isGrounded, gapFillCurrentPage } from "./llmGapFill";
import type { ExtractedField, LearnPlanResponse, RawField } from "./adapters/autoLearnAdapter";

// Browser-free tests for the LLM-assisted gap-fill guardrail: "proper data, not guessing".
// Run with: npx tsx portal-bot/src/llmGapFill.test.ts

// --- isGrounded: the core guardrail ---------------------------------------------

function field(partial: Partial<ExtractedField>): ExtractedField {
  return { selector: {}, label: partial.label ?? "x", fieldType: partial.fieldType ?? "text", options: partial.options };
}

function testGroundingRules() {
  const pf = { commissioningDate: "2026-07-17", homeownerName: "Testy McTestface", systemSizeDcKw: "9.89" };

  // Text bound to a real project key (even reformatted) → grounded.
  assert.equal(isGrounded(field({ fieldType: "text" }), "7/17/2026", "commissioningDate", pf), true, "mapped date is grounded");
  // Text whose value traces to a real project value → grounded.
  assert.equal(isGrounded(field({ fieldType: "text" }), "Testy", undefined, pf), true, "value tracing to project data is grounded");
  // Text with a fabricated value and no backing key → REJECTED (a guess).
  assert.equal(isGrounded(field({ fieldType: "text" }), "totally made up", undefined, pf), false, "invented free text is rejected");
  // Text with a hallucinated key not in projectFields and value not traceable → REJECTED.
  assert.equal(isGrounded(field({ fieldType: "text" }), "2099-01-01", "nope", pf), false, "hallucinated key + untraceable value is rejected");
  // Select whose value matches a real portal option → grounded.
  assert.equal(isGrounded(field({ fieldType: "select", options: ["Yes", "No"] }), "Yes", undefined, pf), true, "option match is grounded");
  // Select whose value is NOT among the offered options and no key → REJECTED.
  assert.equal(isGrounded(field({ fieldType: "select", options: ["Yes", "No"] }), "Maybe", undefined, pf), false, "non-option select value is rejected");
  // Radio/checkbox boolean → grounded (the planner chose which portal control to toggle).
  assert.equal(isGrounded(field({ fieldType: "radio" }), "true", undefined, pf), true, "radio true is grounded");
  // Empty value is never grounded.
  assert.equal(isGrounded(field({ fieldType: "text" }), "", "homeownerName", pf), false, "empty value is never grounded");
  console.log("  ✅ isGrounded enforces proper-data-only (8 cases)");
}

// --- gapFillCurrentPage: end-to-end with a fake page ----------------------------

interface FState { type: ExtractedField["fieldType"]; value: string; checked: boolean; options?: string[]; required?: boolean }

function makeFakePage(fields: Array<{ label: string } & FState>) {
  const state = new Map<string, FState>();
  const raws: RawField[] = [];
  for (const f of fields) {
    state.set(f.label, { type: f.type, value: f.value, checked: f.checked, options: f.options });
    raws.push({ label: f.label, fieldType: f.type, options: f.options, required: f.required } as RawField);
  }
  function locatorFor(label: string): any {
    const st = state.get(label);
    const loc: any = {
      first: () => loc,
      nth: () => loc,
      count: async () => (st ? 1 : 0),
      isChecked: async () => Boolean(st?.checked),
      inputValue: async () => st?.value ?? "",
      fill: async (v: string) => { if (st) st.value = v; },
      selectOption: async (v: any) => {
        const val = typeof v === "string" ? v : v?.label;
        if (st && st.options && st.options.includes(val)) { st.value = val; return; }
        throw new Error("no such option");
      },
      check: async () => { if (st) st.checked = true; },
      uncheck: async () => { if (st) st.checked = false; },
      blur: async () => undefined,
    };
    return loc;
  }
  const page: any = {
    url: () => "https://pgenm.powerclerk.com/MvcProjects/EditProject",
    title: async () => "Edit Project",
    $$eval: async () => raws,
    getByLabel: (label: string) => locatorFor(label),
    getByRole: () => locatorFor("__none__"),
    getByPlaceholder: () => locatorFor("__none__"),
    getByText: () => locatorFor("__none__"),
    getByTestId: () => locatorFor("__none__"),
    locator: (css: string) => {
      if (css === "body") return { innerText: async () => "PV System ..." };
      return locatorFor("__none__");
    },
    frameLocator: () => page,
  };
  return { page, state };
}

async function testGapFillAppliesOnlyGroundedData() {
  const { page, state } = makeFakePage([
    { label: "Estimated Commissioning Date", type: "text", value: "", checked: false },
    { label: "Smart Inverter Settings", type: "select", value: "", checked: false, options: ["Yes", "No"] },
    { label: "Random Notes", type: "text", value: "", checked: false },
    // Required, empty, and no project data to fill it → must be reported, not guessed.
    { label: "Special Permit ID", type: "text", value: "", checked: false, required: true },
    { label: "Homeowner Name", type: "text", value: "Testy McTestface", checked: false }, // already filled
  ]);

  const projectFields = { commissioningDate: "2026-07-17", homeownerName: "Testy McTestface" };

  // A planner that proposes one grounded date, one grounded option, and one invented value.
  const planner = async (req: { fields: ExtractedField[] }): Promise<LearnPlanResponse> => {
    const fills: LearnPlanResponse["fills"] = [];
    req.fields.forEach((f, i) => {
      if (/commissioning/i.test(f.label)) fills.push({ selectorIndex: i, value: "7/17/2026", field: "commissioningDate" });
      else if (/smart inverter/i.test(f.label)) fills.push({ selectorIndex: i, value: "Yes" });
      else if (/notes/i.test(f.label)) fills.push({ selectorIndex: i, value: "totally made up note", field: "nope" });
    });
    return { fills, atReview: false };
  };

  const outcome = await gapFillCurrentPage(page, planner, projectFields, []);

  assert.equal(state.get("Estimated Commissioning Date")!.value, "7/17/2026", "grounded date applied");
  assert.equal(state.get("Smart Inverter Settings")!.value, "Yes", "grounded option applied");
  assert.equal(state.get("Random Notes")!.value, "", "invented value NOT applied");
  assert.equal(state.get("Homeowner Name")!.value, "Testy McTestface", "already-filled field untouched");
  assert.ok(outcome.filled.includes("Estimated Commissioning Date"), "reports the date as filled");
  assert.ok(outcome.filled.includes("Smart Inverter Settings"), "reports the option as filled");
  assert.ok(outcome.skippedUngrounded.includes("Random Notes"), "reports the guess as skipped");
  assert.equal(state.get("Special Permit ID")!.value, "", "required no-data field left blank, not guessed");
  assert.ok(outcome.reportedMissing.includes("Special Permit ID"), "reports the required no-data field as missing");
  console.log("  ✅ gapFillCurrentPage applies grounded data, rejects guesses, reports required gaps");
}

async function testGapFillNoPlannerSafe() {
  // No fillable empties → returns an empty outcome without throwing.
  const { page } = makeFakePage([{ label: "Homeowner Name", type: "text", value: "Filled", checked: false }]);
  const planner = async (): Promise<LearnPlanResponse> => ({ fills: [{ selectorIndex: 0, value: "x" }], atReview: false });
  const outcome = await gapFillCurrentPage(page, planner, {}, []);
  assert.equal(outcome.filled.length, 0, "nothing filled when no empties");
  console.log("  ✅ gapFillCurrentPage is a safe no-op when nothing is empty");
}

async function main() {
  console.log("\n──────── LLM gap-fill: proper-data-only guardrail ────────");
  testGroundingRules();
  await testGapFillAppliesOnlyGroundedData();
  await testGapFillNoPlannerSafe();
  console.log("\n✅ ALL PASS: LLM gap-fill guardrail tests\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
