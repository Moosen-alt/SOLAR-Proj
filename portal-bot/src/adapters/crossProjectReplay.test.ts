// LEARN ONCE, REPLAY FOR EVERYONE ELSE — PROVE NO ONE ELSE'S DATA COMES ALONG.
//
// The product contract the operator asked for is "the learn goes off once per portal, then
// replay does the heavy lifting". That contract has a safety half nobody was testing: a
// recipe learned on project A is REUSED for projects B and C, and A's homeowner must never
// appear on B's application.
//
// The learn's own self-test cannot catch this. autoLearn.ts replays with
// resolveRecipeFieldValues(db, project, ...) — the SAME project it just learned — so a step
// that froze A's name replays A's name and the self-test calls it a pass. It proves selector
// reproducibility, not field substitution. Every "[self-test] PASSED" in this project's
// history carries that caveat, including the pinned Ameren 3/3.
//
// This is the missing acceptance test, run at the value-resolution layer where the leak
// lives, against a fake page so it costs nothing:
//
//   MUST PASS  — a correctly bound step resolves to the REPLAY project's value.
//   MUST NOT   — any value unique to the LEARN project reaches the page.
//
//   npx tsx portal-bot/src/adapters/crossProjectReplay.test.ts
import assert from "node:assert/strict";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

// --- minimal fake page: records what got typed ------------------------------------
interface Log { fills: Array<{ target: string; value: string }> }

function makeFakePage(log: Log): unknown {
  const loc = (target: string): Record<string, unknown> => {
    const l: Record<string, unknown> = {
      first: () => l, nth: () => l, count: async () => 1, isVisible: async () => true,
      isEnabled: async () => true, isEditable: async () => true,
      waitFor: async () => undefined, scrollIntoViewIfNeeded: async () => undefined,
      click: async () => undefined, check: async () => undefined,
      fill: async (v: string) => { log.fills.push({ target, value: String(v) }); },
      type: async (v: string) => { log.fills.push({ target, value: String(v) }); },
      selectOption: async (v: unknown) => {
        const value = typeof v === "string" ? v : String((v as { label?: string })?.label ?? "");
        log.fills.push({ target, value });
      },
      press: async () => undefined, inputValue: async () => "", textContent: async () => "",
      innerText: async () => "", getAttribute: async () => null, evaluate: async () => "",
      allInnerTexts: async () => [], setInputFiles: async () => undefined,
      dispatchEvent: async () => undefined,
      boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
      locator: () => l, elementHandle: async () => null,
      focus: async () => undefined, blur: async () => undefined,
    };
    return l;
  };
  const page: Record<string, unknown> = {
    url: () => "https://portal.test/app", title: async () => "Application",
    goto: async () => undefined, waitForLoadState: async () => undefined,
    reload: async () => undefined, waitForTimeout: async () => undefined,
    isClosed: () => false, bringToFront: async () => undefined,
    keyboard: { press: async () => undefined }, frames: () => [],
    evaluate: async () => "", screenshot: async () => Buffer.from(""),
    content: async () => "<html></html>",
    getByRole: (r: string, o?: { name?: string }) => loc(`role:${r}:${o?.name ?? ""}`),
    getByLabel: (lbl: string) => loc(`label:${lbl}`),
    getByPlaceholder: (p: string) => loc(`placeholder:${p}`),
    getByTestId: (t: string) => loc(`testId:${t}`),
    getByText: () => ({ ...loc("text"), count: async () => 0 }),
    locator: (css: string) => loc(`css:${css}`),
    $$eval: async () => [],
  };
  page.frameLocator = () => page;
  page.context = () => ({ pages: () => [page] });
  return page;
}

const withFakePage = (adapter: RecipeAdapter, page: unknown): void => {
  (adapter as unknown as { page: unknown }).page = page;
  (adapter as unknown as { opened: unknown }).opened = { context: { pages: () => [page] } };
};

// --- the two projects -------------------------------------------------------------
// Project A: what the recipe was LEARNED on. Every value here is a tripwire.
const A_HOMEOWNER = "Alice Anderson";
const A_ADDRESS = "111 First Street";
const A_ACCOUNT = "1111111111";
const A_SIZE_W = "8000"; // A's 8 kW system expressed in WATTS — never matches "8"

// Project B: a materially different project the recipe is REUSED for.
const projectB = {
  id: "proj-b", homeownerName: "Bob Baker", projectAddress: "222 Second Avenue",
  city: "Springfield", state: "IL", zip: "62701", utility: "Ameren Illinois",
} as unknown as ProjectRecord;

const fieldValuesB: Record<string, string> = {
  homeownerName: "Bob Baker",
  projectAddress: "222 Second Avenue",
  systemSizeKw: "6",
  accountNumber: "2222222222",
};

const baseRecipe = (steps: RecipeStep[]): PortalRecipe => ({
  id: "r1", scopeType: "utility", profileKey: "il|unknown|ameren illinois",
  state: "IL", ahj: "", utility: "Ameren Illinois", portalPlatform: "",
  portalUrl: "https://portal.test/app", status: "complete", version: 1, steps,
  createdBy: "test", createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(), notes: "",
} as unknown as PortalRecipe);

const run = async (steps: RecipeStep[]): Promise<Log> => {
  const log: Log = { fills: [] };
  const adapter = new RecipeAdapter(baseRecipe(steps), fieldValuesB, {});
  withFakePage(adapter, makeFakePage(log));
  await adapter.fillApplication(projectB);
  return log;
};

const typed = (log: Log): string => log.fills.map((f) => f.value).join(" | ");

// ---------------------------------------------------------------------------------
const results: Record<string, Log> = {};

// The planner invented a binding key the dictionary does not define, and the recorded
// literal is project A's homeowner. recipeAdapter's `known` test asks only whether the KEY
// exists — so the literal replays. This is the leak.
results.unknownBinding = await run([
  { action: "fill", selector: { label: "Owner Name" }, field: "ownerFullName", value: A_HOMEOWNER } as RecipeStep,
]);

// The binder keeps any literal that does not EXACTLY match a project value as a
// "portal-specific literal". A's 8 kW recorded as 8000 W never matched, so it froze — and
// B, a 6 kW system, would file A's 8000.
results.frozenLiteral = await run([
  { action: "fill", selector: { label: "System Size (W)" }, value: A_SIZE_W } as RecipeStep,
]);

// Same mechanism, worse payload: A's address in a format that did not match the project
// record, frozen as a "constant" and replayed onto every later project.
results.frozenPii = await run([
  { action: "fill", selector: { label: "Service Address" }, value: A_ADDRESS } as RecipeStep,
]);

// The control case: a properly bound step MUST resolve to B's value.
results.boundCorrectly = await run([
  { action: "fill", selector: { label: "Homeowner" }, field: "homeownerName", value: A_HOMEOWNER } as RecipeStep,
]);

// MUST STILL WORK — the reason this fallback exists at all. Miami's Job Category is bound to
// an invented "jobCategory" key the dictionary does not define, and its recorded answer is
// the PORTAL's own vocabulary. Blank it and the required dropdown replays empty and the
// portal refuses to advance, every time, silently. Both the select and the free-text form of
// a taxonomy answer must survive the guard.
results.portalVocabularySelect = await run([
  { action: "select", selector: { label: "Job Category" }, field: "jobCategory", value: "STAND-ALONE" } as RecipeStep,
]);
results.portalVocabularyFill = await run([
  { action: "fill", selector: { label: "Permit Type" }, field: "permitTypeChoice", value: "Residential Solar" } as RecipeStep,
]);
// An unbound portal constant on a taxonomy label must also survive.
results.unboundVocabulary = await run([
  { action: "select", selector: { label: "Work Type" }, value: "SOLAR PANEL" } as RecipeStep,
]);

const leakCases = [results.unknownBinding, results.frozenLiteral, results.frozenPii, results.boundCorrectly];
const allTyped = leakCases.map(typed).join(" || ");
console.log(`   typed across all cases: ${allTyped}`);

check("a correctly bound step resolves to the REPLAY project's value", () => {
  const t = typed(results.boundCorrectly);
  assert.ok(t.includes("Bob Baker") && !t.includes(A_HOMEOWNER),
    `bound step typed ${JSON.stringify(t)}`);
});

check("MUST STILL WORK: portal vocabulary on an invented key still replays (Miami jobCategory)", () => {
  assert.ok(typed(results.portalVocabularySelect).includes("STAND-ALONE"),
    `the portal's own taxonomy answer was blanked — a required dropdown would replay empty and the portal would refuse to advance (typed: ${JSON.stringify(typed(results.portalVocabularySelect))})`);
  assert.ok(typed(results.portalVocabularyFill).includes("Residential Solar"),
    `a free-text taxonomy answer was blanked (typed: ${JSON.stringify(typed(results.portalVocabularyFill))})`);
});

check("MUST STILL WORK: an unbound portal constant on a taxonomy label still replays", () => {
  assert.ok(typed(results.unboundVocabulary).includes("SOLAR PANEL"),
    `an unbound portal constant was blanked (typed: ${JSON.stringify(typed(results.unboundVocabulary))})`);
});

check("MUST NOT: an unknown binding key replays the learn project's homeowner", () => {
  assert.ok(!typed(results.unknownBinding).includes(A_HOMEOWNER),
    `LEAK: project A's homeowner ${JSON.stringify(A_HOMEOWNER)} was typed into project B's application (typed: ${JSON.stringify(typed(results.unknownBinding))})`);
});

check("MUST NOT: a frozen unmatched literal replays the learn project's system size", () => {
  assert.ok(!typed(results.frozenLiteral).includes(A_SIZE_W),
    `WRONG DATA: project A's ${A_SIZE_W} W was typed for project B, whose system is ${fieldValuesB.systemSizeKw} kW (typed: ${JSON.stringify(typed(results.frozenLiteral))})`);
});

check("MUST NOT: a frozen unmatched literal replays the learn project's address", () => {
  assert.ok(!typed(results.frozenPii).includes(A_ADDRESS),
    `LEAK: project A's address ${JSON.stringify(A_ADDRESS)} was typed into project B's application (typed: ${JSON.stringify(typed(results.frozenPii))})`);
});

check("MUST NOT: any project-A-only value reaches the page, across every case", () => {
  for (const tripwire of [A_HOMEOWNER, A_ADDRESS, A_ACCOUNT, A_SIZE_W]) {
    assert.ok(!allTyped.includes(tripwire),
      `LEAK: ${JSON.stringify(tripwire)} (project A only) reached project B's application. Typed: ${allTyped}`);
  }
});

console.log(failures === 0
  ? "\nAll cross-project replay checks passed."
  : `\n${failures} cross-project replay check(s) FAILED — a recipe learned on one project carries its data to the next.`);
process.exit(failures === 0 ? 0 : 1);
