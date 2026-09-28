// A SYSTEM WITHOUT A BATTERY NEVER DECLARES ONE — AND NEVER LEAVES THE QUESTION BLANK.
//
// Live on Ivy's PacifiCorp interconnection: the project carries hasBattery = "No" and a plan
// set of 8 modules + 4 microinverters, and the planner ticked "This system includes battery
// storage" regardless. That tick reveals a block of REQUIRED battery fields, which gap-fill
// then answered with textbook numbers — 13.5 kWh, 11.5 kW, 89% round-trip. Those are a
// Powerwall's specifications, not this customer's, and they were on their way to a utility
// as fact. The planner HAD hasBattery and still got it wrong, so the fix is a guard.
//
// Live on PGE (2026-09-28, two supervised learns, hasBattery "No"): that guard refused the
// planner's CORRECT "No" on the required select "Energy Storage" as a battery spec, four times
// per run, and page 7 ended with required_never_filled ["Energy Storage"]. The regex knew the
// storage words, not what the control asked.
//
// This file pins THE ONE PREDICATE (shared batteryControls) both sides now ask — imported, not
// copied: an earlier version of this test re-declared the regexes inline and could not have
// failed when the adapter's own copy drifted (which it did, on both sides: see the REPLAY
// section). MUST-PASS and MUST-EXCLUDE both, because a guard that refuses a PV field because
// the word "storage" appears somewhere breaks every job.
//   npx tsx portal-bot/src/adapters/batteryGuard.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BATTERY_DECLARATION_QUESTION,
  batteryControlKind,
  batteryControlOfStep,
  batteryDeclarationAnswer,
  parseHasBattery,
} from "../../../shared/src/batteryControls";
import type { RecipeStep } from "../../../shared/src/types";

// The learner's debug bundle must never land in the repo's data/.
process.env.AUTOLEARN_RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "battery-guard-test-"));

const { RecipeAdapter } = await import("./recipeAdapter");
const { AutoLearnAdapter } = await import("./autoLearnAdapter");
type ExtractedField = import("./autoLearnAdapter").ExtractedField;
type LearnPlanner = import("./autoLearnAdapter").LearnPlanner;

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ok   - ${label}`); })
    .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

const YES_NO = ["Select...", "Yes", "No"];

// ── THE PREDICATE, over a labels × control-types table ──────────────────────────────────────
await check("THE PGE REGRESSION: the storage QUESTION is a declaration, on every control that can ask it", () => {
  assert.equal(batteryControlKind("Energy Storage", { control: "select", options: YES_NO }), "declaration", "select Yes/No");
  assert.equal(batteryControlKind("Energy Storage *", { control: "select", options: YES_NO }), "declaration", "required marker");
  assert.equal(batteryControlKind("Energy Storage", { control: "select" }), "declaration", "options unread (custom combobox)");
  assert.equal(batteryControlKind("Energy Storage", { control: "checkbox" }), "declaration", "checkbox");
  assert.equal(batteryControlKind("Energy Storage", { control: "text" }), "declaration", "free text");
  assert.equal(batteryControlKind("Storage", { control: "select", options: ["Select...", "None", "Yes"] }), "declaration", "Yes/None vocabulary");
});

await check("other ways a portal words the same question", () => {
  for (const l of [
    "Battery storage?",
    "Battery Storage",
    "Will energy storage be installed?",
    "Does the system include a battery?",
    "Is there a battery?",
    "Energy Storage Installed?",
    "Battery installed?",
    "This system includes battery storage",
    "The system includes energy storage",
    "This project has a battery",
    "System with battery storage",
    "Battery storage included?",
    "Energy Storage System Information",
  ]) {
    assert.equal(batteryControlKind(l, { control: "checkbox" }), "declaration", `checkbox: ${l}`);
    assert.equal(batteryControlKind(l, { control: "select", options: YES_NO }), "declaration", `select: ${l}`);
  }
});

await check("the invented specs are all SPECS, whatever control asks for them", () => {
  for (const l of [
    "Energy Storage Manufacturer",
    "Battery Manufacturer",
    "Battery Model",
    "Battery Make",
    "Storage capacity (kWh)",
    "Energy Storage Capacity of Battery (kWh)",
    "Battery Round-trip Efficiency (%)",
    "Maximum Power Draw of Battery During a Charging Cycle (kW)",
    "Number of Batteries",
    "Battery Quantity",
    "Battery Disconnect Manufacturer",
    "Battery Part Number",
    "Battery UL 9540 Certification",
    "The battery has an integrated (built-in) inverter",
    "Energy Storage Voltage",
  ]) {
    assert.equal(batteryControlKind(l, { control: "text" }), "spec", `text: ${l}`);
    assert.equal(batteryControlKind(l, { control: "select", options: ["Select...", "Tesla", "LG"] }), "spec", `select: ${l}`);
  }
  // A battery's document is a fact about the battery, never the yes/no question.
  assert.equal(batteryControlKind("upload battery_spec: Battery Specification Sheet", { control: "file" }), "spec");
  assert.equal(batteryControlKind("Energy Storage", { control: "file" }), "spec", "a file slot named for storage takes its datasheet");
});

await check("a PROGRAM question is neither — required of every applicant, battery or not", () => {
  const q = "Will you be participating in the Wattsmart Battery Program?";
  assert.equal(batteryControlKind(q, { control: "select", options: ["Select...", "Yes, I will be participating", "No, I will not be participating"] }), "program");
  assert.equal(batteryControlKind(q, { control: "radio" }), "program");
  assert.equal(batteryControlKind("Battery Programme enrolment", { control: "checkbox" }), "program");
});

await check("MUST-EXCLUDE: PV fields are not about storage at all", () => {
  for (const l of [
    "Inverter Manufacturer",
    "Module Model",
    "Total AC System Size (kW)",
    "PV System Specification",
    "Azimuth",
    "Roof Mounting",
    "Utility Account Number",
    "Do you propose to limit the export capacity?",
    "System Capacity (kW)",
  ]) {
    assert.equal(batteryControlKind(l, { control: "text" }), null, `text: ${l}`);
    assert.equal(batteryControlKind(l, { control: "select", options: YES_NO }), null, `select: ${l}`);
    assert.equal(batteryControlKind(l, { control: "checkbox" }), null, `checkbox: ${l}`);
  }
});

await check("MUST-EXCLUDE: a bare mention is neither refused nor answered for the planner", () => {
  // An acknowledgment box citing the battery requirements is not a declaration: refusing it on
  // every no-battery job would leave a required acknowledgment unticked.
  assert.equal(batteryControlKind("See the Battery System Interim Technical Requirements on our Resources page", { control: "checkbox" }), "mention");
  assert.equal(batteryControlKind("I have read the Battery System Interim Technical Requirements", { control: "checkbox" }), "mention");
  assert.equal(batteryControlKind("Energy storage notes", { control: "text" }), "mention");
  // A permit portal's storage shed is not a battery.
  assert.equal(batteryControlKind("Does the property have a storage shed?", { control: "select", options: YES_NO }), null);
  assert.equal(batteryControlKind("Storage tank", { control: "text" }), null);
});

await check("the answer is given in the control's own vocabulary", () => {
  assert.equal(batteryDeclarationAnswer(false, YES_NO, "No"), "No", "the planner's right answer is kept");
  assert.equal(batteryDeclarationAnswer(false, YES_NO, "Yes"), "No", "the planner's wrong answer is corrected");
  assert.equal(batteryDeclarationAnswer(false, YES_NO, ""), "No", "a blank is answered");
  assert.equal(batteryDeclarationAnswer(false, ["Select...", "None", "Lithium-ion"], "Lithium-ion"), "None", "a portal's None stays None");
  assert.equal(batteryDeclarationAnswer(false, undefined, "Yes"), "No", "no option list: the literal");
  assert.equal(batteryDeclarationAnswer(true, YES_NO, "No"), "Yes", "a battery job's No becomes Yes");
  assert.equal(batteryDeclarationAnswer(true, YES_NO, "Yes"), "Yes");
  assert.equal(batteryDeclarationAnswer(true, YES_NO, ""), "Yes");
  assert.equal(batteryDeclarationAnswer(true, ["Select...", "None", "Lithium-ion"], "None"), null, "no Yes on offer: the type picker is the planner's");
  assert.equal(batteryDeclarationAnswer(true, undefined, "Tesla Powerwall 2"), null, "free text that already names a battery stays");
});

await check("only an explicit No or Yes arms the guard; silence leaves it to the planner", () => {
  assert.equal(parseHasBattery("No"), false);
  assert.equal(parseHasBattery("no"), false);
  assert.equal(parseHasBattery("None"), false);
  assert.equal(parseHasBattery("Yes"), true);
  assert.equal(parseHasBattery("true"), true);
  assert.equal(parseHasBattery(""), undefined);
  assert.equal(parseHasBattery("unknown"), undefined);
  assert.equal(parseHasBattery(undefined), undefined);
});

await check("the declaration pass looks for the question, never a spec", () => {
  for (const q of ["Energy Storage", "Energy Storage *", "Battery Storage?", "Will energy storage be installed?", "Does the system include a battery?"]) {
    assert.ok(BATTERY_DECLARATION_QUESTION.test(q), `must find: ${q}`);
  }
  for (const q of ["Battery Manufacturer", "Energy Storage Capacity of Battery (kWh)", "Energy Storage Manufacturer", "Energy Storage Type", "Inverter Manufacturer", "Will you be participating in the Wattsmart Battery Program?"]) {
    assert.ok(!BATTERY_DECLARATION_QUESTION.test(q), `must not find: ${q}`);
  }
});

// ── THE LEARNER'S FILL PASS, on the real adapter with a stub page ───────────────────────────
// The stub records what would have been typed / selected / checked; the adapter's own
// applyFill runs every guard the live run runs.
type Log = { selects: Array<{ css: string; value: string }>; fills: Array<{ css: string; value: string }>; checks: string[]; unchecks: string[] };
const stubPage = (log: Log) => {
  const locatorFor = (css: string) => {
    const loc: Record<string, unknown> = {
      first: () => loc,
      nth: () => loc,
      count: async () => 1,
      selectOption: async (v: unknown) => { log.selects.push({ css, value: typeof v === "string" ? v : String((v as { label?: string })?.label ?? "") }); },
      fill: async (v: string) => { log.fills.push({ css, value: v }); },
      check: async () => { log.checks.push(css); },
      uncheck: async () => { log.unchecks.push(css); },
      blur: async () => undefined,
      inputValue: async () => "",
    };
    return loc;
  };
  return {
    url: () => "http://127.0.0.1/learn",
    locator: (css: string) => locatorFor(css),
    getByLabel: (l: string) => locatorFor(`label:${l}`),
    getByRole: (r: string, o?: { name?: string }) => locatorFor(`role:${r}:${o?.name ?? ""}`),
    getByPlaceholder: (p: string) => locatorFor(`placeholder:${p}`),
    getByTestId: (t: string) => locatorFor(`testId:${t}`),
    getByText: (t: string) => locatorFor(`text:${t}`),
    frames: () => [],
  };
};
const learnerWith = (hasBattery: boolean | undefined, log: Log) => {
  const planner: LearnPlanner = (async () => ({ fills: [], atReview: false })) as unknown as LearnPlanner;
  const a = new AutoLearnAdapter("Test utility", planner, { hasBattery });
  (a as unknown as { page: unknown }).page = stubPage(log);
  const events: Array<Record<string, unknown>> = [];
  (a as unknown as { debug: unknown }).debug = { event: (e: Record<string, unknown>) => { events.push(e); }, writeJson: () => undefined };
  const applyFill = (a as unknown as { applyFill(f: ExtractedField, r: { value: string; field?: string }, s: boolean): Promise<RecipeStep | null> }).applyFill.bind(a);
  return { applyFill, events };
};
const essSelect: ExtractedField = { selector: { css: "#ess" }, label: "Energy Storage", fieldType: "select", options: YES_NO, required: true };
const capText: ExtractedField = { selector: { css: "#cap" }, label: "Energy Storage Capacity of Battery (kWh)", fieldType: "text", required: false };
const mfrSelect: ExtractedField = { selector: { css: "#bmfr" }, label: "Battery Manufacturer", fieldType: "select", options: ["Select...", "Tesla Energy"] };
const progSelect: ExtractedField = { selector: { css: "#prog" }, label: "Will you be participating in the Wattsmart Battery Program?", fieldType: "select", options: YES_NO, required: true };
const incBox: ExtractedField = { selector: { css: "#inc" }, label: "This system includes battery storage", fieldType: "checkbox" };
const ackBox: ExtractedField = { selector: { css: "#ack" }, label: "I have read the Battery System Interim Technical Requirements", fieldType: "checkbox" };

await check("LEARN, no battery: the planner's \"No\" on the required Energy Storage select is APPLIED and recorded", async () => {
  const log: Log = { selects: [], fills: [], checks: [], unchecks: [] };
  const { applyFill, events } = learnerWith(false, log);
  const req = { value: "No" };
  const step = await applyFill(essSelect, req, false);
  assert.ok(step, "no step recorded — the live PGE blank");
  assert.equal(step!.action, "select");
  assert.equal(step!.value, "No");
  assert.equal(step!.note, "Energy Storage", "the recorded label is a matching key");
  assert.deepEqual(log.selects, [{ css: "#ess", value: "No" }]);
  assert.ok(!events.some((e) => e.type === "battery_spec_refused"), `refused as a spec: ${JSON.stringify(events)}`);
  assert.ok(events.some((e) => e.type === "battery_declaration_answered" && e.answer === "No"), JSON.stringify(events));
});

await check("LEARN, no battery: a planner's \"Yes\" on the question is corrected to No, and the caller's expected value follows", async () => {
  const log: Log = { selects: [], fills: [], checks: [], unchecks: [] };
  const { applyFill, events } = learnerWith(false, log);
  const req = { value: "Yes" };
  const step = await applyFill(essSelect, req, false);
  assert.equal(step?.value, "No");
  assert.equal(req.value, "No", "AppliedFill.expected is read from fillReq.value after the call");
  assert.deepEqual(log.selects, [{ css: "#ess", value: "No" }]);
  assert.ok(events.some((e) => e.type === "battery_declaration_answered" && e.planner === "corrected"), JSON.stringify(events));
});

await check("LEARN, no battery: the specs are still refused, the programme question still answered", async () => {
  const log: Log = { selects: [], fills: [], checks: [], unchecks: [] };
  const { applyFill, events } = learnerWith(false, log);
  assert.equal(await applyFill(capText, { value: "13.5" }, false), null, "capacity invented");
  assert.equal(await applyFill(mfrSelect, { value: "Tesla Energy" }, false), null, "manufacturer invented");
  assert.equal(await applyFill(incBox, { value: "true" }, false), null, "the Ivy tick");
  assert.equal(log.fills.length + log.checks.length, 0, JSON.stringify(log));
  assert.equal(events.filter((e) => e.type === "battery_spec_refused").length, 2);
  assert.ok(events.some((e) => e.type === "battery_declaration_refused"));
  const prog = await applyFill(progSelect, { value: "No" }, false);
  assert.equal(prog?.value, "No", "the Wattsmart question was refused");
  const ack = await applyFill(ackBox, { value: "true" }, false);
  assert.ok(ack, "an acknowledgment that merely cites the battery requirements was refused");
  assert.deepEqual(log.checks, ["#ack"]);
});

await check("LEARN, battery job: the question is answered Yes even when the planner said No, and the specs are filled", async () => {
  const log: Log = { selects: [], fills: [], checks: [], unchecks: [] };
  const { applyFill } = learnerWith(true, log);
  const req = { value: "No" };
  const step = await applyFill(essSelect, req, false);
  assert.equal(step?.value, "Yes");
  assert.equal(req.value, "Yes");
  assert.ok(await applyFill(capText, { value: "27" }, false), "a real battery's capacity refused");
  assert.ok(await applyFill(mfrSelect, { value: "Tesla Energy" }, false));
  const box = await applyFill(incBox, { value: "false" }, false);
  assert.equal(box?.action, "check", "the declaring checkbox is ticked on a battery job");
  assert.deepEqual(log.checks, ["#inc"]);
  assert.deepEqual(log.fills, [{ css: "#cap", value: "27" }]);
});

await check("LEARN, unknown: silence about a battery stays the planner's call", async () => {
  const log: Log = { selects: [], fills: [], checks: [], unchecks: [] };
  const { applyFill, events } = learnerWith(undefined, log);
  assert.equal((await applyFill(essSelect, { value: "Yes" }, false))?.value, "Yes");
  assert.ok(await applyFill(capText, { value: "13.5" }, false));
  assert.equal(events.filter((e) => String(e.type).startsWith("battery_")).length, 0, JSON.stringify(events));
});

// ── THE REPLAY SIDE, on the real RecipeAdapter ──────────────────────────────────────────────
// A recipe learned on a battery job records the whole storage section, specs frozen as
// literals. The live PacifiCorp NEM recipe carries 16 such steps including
// `Energy Storage Capacity of Battery (kWh) = "13.5"`, and replaying it onto a project with
// no battery declared one and handed the utility a Powerwall's capacity as fact.
type Replay = { skipForNoBattery(s: RecipeStep): boolean; isBatteryDeclaration(s: RecipeStep): boolean; resolveValue(s: RecipeStep): string };
const replayWith = (hasBattery: string): Replay => {
  const a = Object.create(RecipeAdapter.prototype) as Record<string, unknown>;
  a.fieldValues = { hasBattery };
  a.recipe = { steps: [] };
  return a as unknown as Replay;
};
const st = (action: RecipeStep["action"], note: string, value?: string, extra: Partial<RecipeStep> = {}): RecipeStep =>
  ({ action, phase: "fill", note, selector: { css: "#x" }, ...(value !== undefined ? { value } : {}), ...extra });

await check("REPLAY: the recorded battery SPECS are skipped for a project with none", () => {
  for (const s of [
    st("fill", "Energy Storage Capacity of Battery (kWh)", "13.5"),
    st("fill", "Battery Round-trip Efficiency (%)", "89"),
    st("fill", "Number of Batteries", "1"),
    st("select", "Battery Manufacturer", "Tesla"),
    st("check", "The battery has an integrated (built-in) inverter"),
    st("upload", "upload battery_spec: Battery Specification Sheet", undefined, { docType: "battery_spec" }),
  ]) assert.equal(replayWith("No").skipForNoBattery(s), true, String(s.note));
});

await check("REPLAY: THE IVY TICK — a recorded check on the declaring checkbox is left unchecked on a no-battery job", () => {
  // Between the declaration commit and this one, isBatteryDeclaration called every check step a
  // declaration and skipForNoBattery then executed it: the tick that revealed the Powerwall
  // fields, replayed. Unchecked IS the No answer.
  const s = st("check", "This system includes battery storage");
  assert.equal(replayWith("No").isBatteryDeclaration(s), true);
  assert.equal(replayWith("No").skipForNoBattery(s), true, "the box would be ticked");
  assert.equal(replayWith("Yes").skipForNoBattery(s), false, "a battery job ticks it as recorded");
});

await check("REPLAY: the storage QUESTION is executed on a no-battery job and answered No", () => {
  const sel = st("select", "Energy Storage", "Yes");
  assert.equal(replayWith("No").skipForNoBattery(sel), false, "the live PGE blank: skipped, so left empty");
  assert.equal(replayWith("No").resolveValue(sel), "No");
  const withOptions = st("select", "Energy Storage", "Lithium-ion", { options: ["Select...", "None", "Lithium-ion"] } as Partial<RecipeStep>);
  assert.equal(replayWith("No").resolveValue(withOptions), "None", "in the control's own vocabulary");
});

await check("REPLAY: THE MIRROR — a recipe learned on a no-battery job (recorded No) answers Yes on a battery job", () => {
  const sel = st("select", "Energy Storage", "No");
  assert.equal(replayWith("Yes").resolveValue(sel), "Yes");
  assert.equal(replayWith("Yes").resolveValue(st("select", "Energy Storage", "Yes")), "Yes");
  assert.equal(replayWith("").resolveValue(sel), "No", "unknown replays as recorded");
  assert.equal(replayWith("Yes").resolveValue(st("fill", "Energy Storage", "Tesla Powerwall 2")), "Tesla Powerwall 2", "a typed product name already says there is one");
});

await check("REPLAY: the Wattsmart PROGRAM question is still answered, not skipped", () => {
  // Skipping it would leave a required question blank — it asks about a utility programme,
  // not about equipment, and the recorded answer ("No, I will not be participating") is right.
  const s = st("select", "Will you be participating in the Wattsmart Battery Program?", "No, I will not be participating");
  assert.equal(replayWith("No").skipForNoBattery(s), false);
  assert.equal(replayWith("No").resolveValue(s), "No, I will not be participating");
  assert.equal(replayWith("Yes").resolveValue(s), "No, I will not be participating", "never forced on a battery job either");
});

await check("REPLAY: a battery project replays the section as recorded", () => {
  assert.equal(replayWith("Yes").skipForNoBattery(st("fill", "Energy Storage Capacity of Battery (kWh)", "13.5")), false);
  assert.equal(replayWith("").skipForNoBattery(st("fill", "Energy Storage Capacity of Battery (kWh)", "13.5")), false);
});

await check("REPLAY: ordinary PV steps and mentions are never skipped", () => {
  for (const s of [
    st("select", "Inverter Manufacturer", "Enphase"),
    st("upload", "upload sld: Please upload your one-line drawing", undefined, { docType: "sld" }),
    st("fill", "Total AC System Size (kW)", "6.97"),
    st("check", "I have read the Battery System Interim Technical Requirements"),
  ]) assert.equal(replayWith("No").skipForNoBattery(s), false, String(s.note));
  assert.equal(batteryControlOfStep({ action: "check" }), "checkbox");
  assert.equal(batteryControlOfStep({ action: "upload" }), "file");
});

if (failures) { console.error(`\n${failures} battery-guard check(s) FAILED.`); process.exit(1); }
console.log("\nAll battery-guard checks passed.");
process.exit(0);
