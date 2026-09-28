// THE STORAGE QUESTION ON A POWERCLERK-SHAPED PAGE, IN REAL CHROMIUM — THE LEARNER'S SIDE.
//
// Live on PGE (2026-09-28, two supervised learns on release #10, hasBattery "No"): page 7
// carries a REQUIRED select "Energy Storage" [Select…, Yes, No]. The planner decided "No" —
// correct — and the learner's battery guard refused it as a battery SPEC (battery_spec_refused
// label="Energy Storage", four times per run); the page ended with required_never_filled
// ["Energy Storage"], a required miss at review, and a recipe that could never be trusted.
//
// The guard exists so a no-battery job never types a battery's make/model/kWh/quantity. It must
// never swallow the yes/no question, which on a no-battery job is answered No — and on a battery
// job answered Yes, with the spec boxes then filled from the project's battery fields.
//
// Every run below goes through the adapter's own extraction (extractAllFrames → toExtractedField)
// and its own applyFill, and then the same required sweep (collectUnfilledRequired) that produced
// the live miss. The spec boxes are ALWAYS visible here, and the planner OFFERS values for them on
// the no-battery run, so "specs untouched" proves the refusal and not the absence of an offer.
//   npx tsx portal-bot/src/adapters/batteryQuestion.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import type { RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, EXTRACT_SEL, toExtractedField, type ExtractedField, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const PAGE = `<!doctype html><html><head><style>body{font:14px sans-serif;padding:16px}.form-group{margin:8px 0}</style></head><body>
  <h2>Generation and Storage</h2>
  <div class="form-group"><label for="ess">Energy Storage *</label>
    <select id="ess" name="ess" required><option value="">Select...</option><option value="Yes">Yes</option><option value="No">No</option></select></div>
  <div class="form-group"><label for="bmfr">Battery Manufacturer</label>
    <select id="bmfr" name="bmfr"><option value="">Select...</option><option>Tesla Energy</option><option>Enphase Energy Inc.</option></select></div>
  <div class="form-group"><label for="bmodel">Battery Model</label><input id="bmodel" name="bmodel"></div>
  <div class="form-group"><label for="bkwh">Energy Storage Capacity of Battery (kWh)</label><input id="bkwh" name="bkwh"></div>
  <div class="form-group"><label for="bqty">Number of Batteries</label><input id="bqty" name="bqty"></div>
  <div class="form-group"><label for="prog">Will you be participating in the Wattsmart Battery Program? *</label>
    <select id="prog" name="prog" required><option value="">Select...</option><option>Yes</option><option>No</option></select></div>
  <div class="form-group"><label for="invmfr">Inverter Manufacturer</label>
    <select id="invmfr" name="invmfr"><option value="">Select...</option><option>Enphase Energy Inc.</option></select></div>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch();
const context = await browser.newContext();
// The SAME shim openPortal installs (browser.ts): esbuild's keepNames wraps nested helpers in
// __name(), which does not exist in the page; without it every in-page evaluate throws and the
// adapter's own catches read that as "nothing found".
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

type Internals = {
  extractAllFrames(sel: string): Promise<Array<Parameters<typeof toExtractedField>[0]>>;
  applyFill(f: ExtractedField, r: { value: string; field?: string }, s: boolean): Promise<RecipeStep | null>;
  collectUnfilledRequired(): Promise<string[]>;
  applyBatteryDeclaration(labels: string[]): Promise<Array<{ step: RecipeStep; applied: { label: string; expected: string } }>>;
};

interface Outcome {
  ess: string; bmfr: string; bmodel: string; bkwh: string; bqty: string; prog: string; invmfr: string;
  unfilled: string[]; steps: RecipeStep[]; events: Array<Record<string, unknown>>; declarationSteps: RecipeStep[];
}

/** One learn-shaped pass over the page: the planner's decisions (by label) through applyFill,
 *  then the declaration pass, then the required sweep. */
const run = async (hasBattery: boolean | undefined, decisions: Record<string, string>): Promise<Outcome> => {
  const page = await context.newPage();
  await page.goto(url);
  const planner: LearnPlanner = (async () => ({ fills: [], atReview: false })) as unknown as LearnPlanner;
  const adapter = new AutoLearnAdapter("PGE PowerClerk", planner, { hasBattery, policyProfile: "residential_nem" });
  (adapter as unknown as { page: unknown }).page = page;
  const events: Array<Record<string, unknown>> = [];
  const holder = adapter as unknown as { debug?: { event: (e: Record<string, unknown>) => void } };
  if (holder.debug && typeof holder.debug.event === "function") {
    const orig = holder.debug.event.bind(holder.debug);
    holder.debug.event = (e) => { events.push(e); orig(e); };
  } else {
    holder.debug = { event: (e) => { events.push(e); } };
  }
  const internals = adapter as unknown as Internals;
  const fields = (await internals.extractAllFrames(EXTRACT_SEL)).map(toExtractedField);
  const steps: RecipeStep[] = [];
  const filled: string[] = [];
  for (const f of fields) {
    // The extractor keeps the required marker on the label ("Energy Storage *"); the planner's
    // decisions here are keyed on the bare question.
    const want = decisions[f.label.replace(/\s*\*\s*$/, "")];
    if (want === undefined) continue;
    const step = await internals.applyFill(f, { value: want }, false);
    if (step) { steps.push(step); filled.push(f.label); }
  }
  const declarationSteps = (await internals.applyBatteryDeclaration(filled)).map((d) => d.step);
  const unfilled = await internals.collectUnfilledRequired();
  const v = async (css: string) => page.locator(css).inputValue().catch(() => "");
  const out: Outcome = {
    ess: await v("#ess"), bmfr: await v("#bmfr"), bmodel: await v("#bmodel"), bkwh: await v("#bkwh"), bqty: await v("#bqty"),
    prog: await v("#prog"), invmfr: await v("#invmfr"), unfilled, steps, events, declarationSteps,
  };
  await page.close();
  // Diagnostics: what the extractor saw, what was recorded, and every battery event — so a red
  // line above can be read without re-running.
  console.log(`      fields: ${JSON.stringify(fields.map((f) => `${f.fieldType}:${f.label}`))}`);
  console.log(`      steps: ${JSON.stringify(steps.map((s) => `${s.action} ${s.note} = ${s.value ?? ""}`))}`);
  console.log(`      events: ${JSON.stringify(events.filter((e) => String(e.type).startsWith("battery_") || /refused|skipped|unresolved/.test(String(e.type))))}`);
  return out;
};

const SPEC_OFFERS = { "Battery Manufacturer": "Tesla Energy", "Battery Model": "Powerwall 2", "Energy Storage Capacity of Battery (kWh)": "13.5", "Number of Batteries": "1" };
const OTHER_OFFERS = { "Will you be participating in the Wattsmart Battery Program?": "No", "Inverter Manufacturer": "Enphase Energy Inc." };

// ── 1. THE LIVE RUN: no battery, the planner says No ─────────────────────────────────────────
const no = await run(false, { "Energy Storage": "No", ...SPEC_OFFERS, ...OTHER_OFFERS });
console.log(`   no battery, planner No -> Energy Storage=${JSON.stringify(no.ess)} specs=${JSON.stringify([no.bmfr, no.bmodel, no.bkwh, no.bqty])} unfilled=${JSON.stringify(no.unfilled)}`);

check("THE LIVE MISS: the planner's No on the required Energy Storage select lands on the page", () => {
  assert.equal(no.ess, "No", `Energy Storage came out ${JSON.stringify(no.ess)} — blank is the PGE page-7 miss`);
});
const essStep = (o: Outcome): RecipeStep | undefined => o.steps.find((x) => /^Energy Storage\s*\*?$/.test(String(x.note ?? "")));
check("...and is recorded as a select step under its own label", () => {
  const s = essStep(no);
  assert.ok(s, `no step for Energy Storage: ${JSON.stringify(no.steps.map((x) => x.note))}`);
  assert.equal(s!.action, "select");
  assert.equal(s!.value, "No");
  assert.equal(no.declarationSteps.length, 0, "the planner answered it; the declaration pass had nothing to do");
});
check("...and is never logged as a refused battery spec", () => {
  const refusedQuestion = no.events.filter((e) => e.type === "battery_spec_refused" && e.label === "Energy Storage");
  assert.equal(refusedQuestion.length, 0, `battery_spec_refused label="Energy Storage" ×${refusedQuestion.length} — the live log line`);
});
check("...while the OFFERED specs of the battery that does not exist stay untouched", () => {
  assert.equal(no.bmfr, "", `manufacturer=${JSON.stringify(no.bmfr)}`);
  assert.equal(no.bmodel, "", `model=${JSON.stringify(no.bmodel)}`);
  assert.equal(no.bkwh, "", `capacity=${JSON.stringify(no.bkwh)}`);
  assert.equal(no.bqty, "", `quantity=${JSON.stringify(no.bqty)}`);
  assert.equal(no.events.filter((e) => e.type === "battery_spec_refused").length, 4, JSON.stringify(no.events.filter((e) => String(e.type).startsWith("battery_"))));
});
check("...the programme question and the PV field are answered as before", () => {
  assert.equal(no.prog, "No");
  assert.equal(no.invmfr, "Enphase Energy Inc.");
});
check("...so the required sweep reports NO miss (this list is a hard blocker in the trust gate)", () => {
  assert.deepEqual(no.unfilled, [], `required_never_filled: ${JSON.stringify(no.unfilled)}`);
});

// ── 2. THE MIRROR: a battery job, the planner (wrongly) says No ───────────────────────────────
const yes = await run(true, { "Energy Storage": "No", ...SPEC_OFFERS, ...OTHER_OFFERS });
console.log(`   battery, planner No -> Energy Storage=${JSON.stringify(yes.ess)} specs=${JSON.stringify([yes.bmfr, yes.bmodel, yes.bkwh, yes.bqty])} unfilled=${JSON.stringify(yes.unfilled)}`);

check("A BATTERY JOB answers Yes — project data over the planner's pick", () => {
  assert.equal(yes.ess, "Yes", `Energy Storage=${JSON.stringify(yes.ess)}`);
  assert.equal(essStep(yes)?.value, "Yes", `the recorded step must carry the corrected answer: ${JSON.stringify(yes.steps.map((x) => `${x.note}=${x.value}`))}`);
  assert.ok(yes.events.some((e) => e.type === "battery_declaration_answered" && e.planner === "corrected"), JSON.stringify(yes.events));
});
check("...and its specs are filled from what the planner carried for it", () => {
  assert.equal(yes.bmfr, "Tesla Energy");
  assert.equal(yes.bmodel, "Powerwall 2");
  assert.equal(yes.bkwh, "13.5");
  assert.equal(yes.bqty, "1");
  assert.deepEqual(yes.unfilled, []);
});

// ── 3. THE DECLARATION PASS: the planner never got to the question ────────────────────────────
const silentNo = await run(false, { ...SPEC_OFFERS, ...OTHER_OFFERS });
console.log(`   no battery, planner silent -> Energy Storage=${JSON.stringify(silentNo.ess)} declaration steps=${JSON.stringify(silentNo.declarationSteps.map((s) => s.note))} unfilled=${JSON.stringify(silentNo.unfilled)}`);
check("PLANNER SILENT, no battery: the declaration pass answers No from project data", () => {
  assert.equal(silentNo.ess, "No", `Energy Storage=${JSON.stringify(silentNo.ess)}`);
  assert.deepEqual(silentNo.unfilled, []);
  const s = silentNo.declarationSteps[0];
  assert.ok(s, "no step recorded by the declaration pass");
  assert.equal(s.action, "select");
  assert.equal(s.value, "No");
  assert.match(String(s.note), /^battery declaration: Energy Storage/, `note=${JSON.stringify(s.note)} — never "policy default:", which replay may skip as not asked`);
});

const silentYes = await run(true, { ...SPEC_OFFERS, ...OTHER_OFFERS });
console.log(`   battery, planner silent -> Energy Storage=${JSON.stringify(silentYes.ess)}`);
check("PLANNER SILENT, battery job: the declaration pass answers Yes", () => {
  assert.equal(silentYes.ess, "Yes", `Energy Storage=${JSON.stringify(silentYes.ess)}`);
});

const unknown = await run(undefined, { ...SPEC_OFFERS, ...OTHER_OFFERS });
check("PLANNER SILENT, battery unknown: nothing is invented — the sweep reports the question for a person", () => {
  assert.equal(unknown.ess, "", "answered a question the project never answered");
  assert.equal(unknown.declarationSteps.length, 0);
  assert.ok(unknown.unfilled.includes("Energy Storage *"), `unfilled=${JSON.stringify(unknown.unfilled)}`);
});

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} battery-question check(s) FAILED.`); process.exit(1); }
console.log("\nAll battery-question checks passed (real Chromium).");
process.exit(0);
