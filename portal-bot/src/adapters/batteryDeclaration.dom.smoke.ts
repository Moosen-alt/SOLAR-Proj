// NOT HAVING A BATTERY IS AN ANSWER, NOT A REASON TO SAY NOTHING.
//
// A recipe learned on a job WITH storage records the whole section: the declaration that
// asks whether there is a battery, and the specs that describe it. Replaying that onto a job
// without one has two wrong outcomes and one right one.
//
//   Replay it as recorded  -> the utility is told this customer owns a Powerwall. This
//                             actually happened on a live PacifiCorp NEM filing: 8 modules,
//                             4 microinverters, hasBattery No, and a declared 13.5 kWh.
//   Skip the whole section -> the portal marks "Energy Storage" required and the filing goes
//                             in with a required field blank. This actually happened on a
//                             live PGE replay -- it was the run's only blank.
//   Answer the question No -> the specs are correctly left alone, and nothing is blank.
//
// The page below is the ordinary shape of that section on any interconnection portal: one
// question, then the specs it governs.
//   npx tsx portal-bot/src/adapters/batteryDeclaration.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { sweepEmptyRequiredControls } from "../requiredControlSweep";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGE = `<!doctype html><html><head><style>body{font:14px sans-serif;padding:16px}</style></head><body>
  <h3>Energy Storage</h3>
  <label for="ess">Energy Storage *</label>
  <select id="ess"><option value="">Please select...</option><option>Yes</option><option>No</option></select>
  <label for="cap">Energy Storage Capacity of Battery (kWh)</label>
  <input id="cap" />
  <label for="bmake">Battery Manufacturer</label>
  <select id="bmake"><option>Select...</option><option>Tesla</option></select>
  <label><input type="checkbox" id="inc"> This system includes battery storage</label>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

// Exactly what a learn on a battery job leaves behind: literals from THAT roof.
const recipe = {
  id: "bd1", scopeType: "utility", profileKey: "or|unknown|portland general electric", state: "OR",
  ahj: "", utility: "Portland General Electric", portalPlatform: "powerclerk", portalUrl: url,
  status: "complete", version: 1,
  steps: [
    { action: "select", phase: "fill", field: "", note: "Energy Storage", value: "Yes", selector: { css: "#ess" } },
    { action: "fill", phase: "fill", field: "", note: "Energy Storage Capacity of Battery (kWh)", value: "13.5", selector: { css: "#cap" } },
    { action: "select", phase: "fill", field: "", note: "Battery Manufacturer", value: "Tesla", selector: { css: "#bmake" } },
  ] as unknown as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;

// THE CAPACITY IS THE PROJECT'S, NOT THE RECIPE'S, so every run carries a project capacity
// that is DELIBERATELY NOT 13.5: a pass here has to mean this roof's number was filed, and
// an assertion against 13.5 could not tell that apart from replaying the learn roof's.
const run = async (
  values: Record<string, string>,
  which: PortalRecipe = recipe,
): Promise<{ ess: string; cap: string; make: string; inc: boolean; blanks: string[] }> => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await context.newPage();
  await page.goto(url);
  const a = new RecipeAdapter(which, values, {}, { autoSubmit: false });
  (a as unknown as { page: unknown }).page = page;
  await a.fillApplication({} as never);
  const ess = await page.locator("#ess").inputValue().catch(() => "");
  const cap = await page.locator("#cap").inputValue().catch(() => "");
  const make = await page.locator("#bmake").inputValue().catch(() => "");
  const inc = await page.locator("#inc").isChecked().catch(() => false);
  const blanks = (await sweepEmptyRequiredControls(page)).empty.map((e) => e.name);
  await browser.close();
  return { ess, cap, make, inc, blanks };
};

// The no-battery project is given a capacity ANYWAY. A stale essKwh on a project whose
// hasBattery says No must not put a number on the page — and without this key the
// "specs stay empty" check below would pass for the trivial reason that there was no
// capacity to fill, proving nothing about the substitution added for the with-battery case.
const no = await run({ hasBattery: "No", essKwh: "27" });
console.log(`   no battery -> Energy Storage=${JSON.stringify(no.ess)} capacity=${JSON.stringify(no.cap)} make=${JSON.stringify(no.make)}`);
console.log(`              -> still blank: ${JSON.stringify(no.blanks)}`);

check("THE LIVE BLANK: the storage QUESTION is answered rather than skipped",
  /^no$/i.test(no.ess), `Energy Storage came out ${JSON.stringify(no.ess)} — blank means the filing goes in incomplete`);

check("...and it is answered NO, not replayed as the recorded Yes",
  !/^yes$/i.test(no.ess), "the recipe declared a battery this customer does not own");

check("...and the SPECS of the battery that does not exist stay empty",
  no.cap === "" && !/tesla/i.test(no.make), `capacity=${JSON.stringify(no.cap)} make=${JSON.stringify(no.make)}`);

check("...so the portal has nothing left to complain about",
  !no.blanks.some((b) => /energy storage/i.test(b)), JSON.stringify(no.blanks));

// THE FAIL-SAFE, from the other side: a job that DOES have a battery must still file one.
//
// This is the half that was silently broken. Capacity is the ONE battery spec with no
// binding key (RECIPE_FIELD_DESCRIPTIONS defines batteryManufacturer/batteryModel/
// batteryQuantity and nothing for kWh), so the binder can only freeze it as an unbound
// literal — and the cross-project literal guard then refuses it, because "capacity" is
// project data. Refusing is right; the bug was that nothing took its place. The utility
// was told there is a Tesla battery and never told how big it is: a required kWh field
// left empty, which suspends an interconnection application rather than rejecting it.
const yes = await run({ hasBattery: "Yes", essKwh: "27" });
console.log(`   with battery -> Energy Storage=${JSON.stringify(yes.ess)} capacity=${JSON.stringify(yes.cap)} make=${JSON.stringify(yes.make)}`);

check("A REAL BATTERY still files its declaration and its specs",
  /^yes$/i.test(yes.ess) && yes.cap === "27" && /tesla/i.test(yes.make),
  `ess=${JSON.stringify(yes.ess)} cap=${JSON.stringify(yes.cap)} make=${JSON.stringify(yes.make)}`);

// A BLANK USED TO SATISFY THIS CHECK, WHICH MADE IT NO CHECK AT ALL.
//
// It asserted only `cap !== "13.5"`, and "" is not "13.5" — so while the capacity was being
// refused outright and filed as nothing, this stayed green and reported that the right
// number had gone in. It was the empty box, measured: the smoke above was red for the
// capacity and this line said the capacity was fine. An assertion must name the value it
// wants, not the one it fears.
// Asserting `=== "27"` is the whole fix; adding `&& !== "13.5"` alongside it is not belt and
// braces, it is dead code — tsc says so (TS2367: the types have no overlap), because once the
// value is known to be "27" the second comparison can never decide anything.
check("...and the capacity filed is THIS roof's, not the 13.5 kWh the recipe recorded",
  yes.cap === "27",
  `capacity=${JSON.stringify(yes.cap)} — wanted this roof's "27". A BLANK is not a pass here: `
  + `"" is not "13.5" either, and that is how this check once stayed green over an empty box.`);

// A SNAPSHOT THAT NEVER WENT THROUGH normalize.ts still has a battery. essKwh is the
// canonical key normalize derives; batteryCapacityKwh is what the parser itself emits, and
// both arrive in fieldValues via the snapshot passthrough in resolveRecipeFieldValues.
// portalRecipes.ts already guards the energy-source answer for exactly this case.
const raw = await run({ hasBattery: "Yes", batteryCapacityKwh: "27" });
console.log(`   un-normalised -> Energy Storage=${JSON.stringify(raw.ess)} capacity=${JSON.stringify(raw.cap)}`);

check("...and the raw parser key works too, for a snapshot that never went through normalize",
  /^yes$/i.test(raw.ess) && raw.cap === "27",
  `ess=${JSON.stringify(raw.ess)} cap=${JSON.stringify(raw.cap)}`);

// THE MIRROR IMAGE (battery-question, 2026-09-28). A recipe learned on a job WITHOUT a battery
// records the same question as "No" — and nothing else of the section, because that learn never
// revealed it. Replaying that literal onto a job WITH a battery would file the storage system
// as absent. The declaration takes THIS project's answer on both sides.
const learnedOnNoBattery = {
  ...recipe, id: "bd2",
  steps: [{ action: "select", phase: "fill", field: "", note: "Energy Storage", value: "No", selector: { css: "#ess" } }] as unknown as RecipeStep[],
} as unknown as PortalRecipe;
const mirror = await run({ hasBattery: "Yes", essKwh: "27" }, learnedOnNoBattery);
console.log(`   recorded No, battery job -> Energy Storage=${JSON.stringify(mirror.ess)}`);
check("THE MIRROR: a recipe that recorded No answers Yes on a job that has a battery",
  /^yes$/i.test(mirror.ess), `Energy Storage=${JSON.stringify(mirror.ess)} — the utility was told there is no storage`);
const mirrorNo = await run({ hasBattery: "No" }, learnedOnNoBattery);
check("...and still No on a job without one",
  /^no$/i.test(mirrorNo.ess), `Energy Storage=${JSON.stringify(mirrorNo.ess)}`);

// THE IVY TICK, REPLAYED. A recipe learned on a battery job records `check` on the declaring
// checkbox. On a no-battery job that box stays unchecked — unchecked IS the No answer — and
// the specs behind it stay blank; on a battery job it is ticked as recorded.
const withCheckbox = {
  ...recipe, id: "bd3",
  steps: [
    { action: "check", phase: "fill", note: "This system includes battery storage", selector: { css: "#inc" } },
    { action: "fill", phase: "fill", field: "", note: "Energy Storage Capacity of Battery (kWh)", value: "13.5", selector: { css: "#cap" } },
  ] as unknown as RecipeStep[],
} as unknown as PortalRecipe;
const tickNo = await run({ hasBattery: "No", essKwh: "27" }, withCheckbox);
console.log(`   recorded tick, no battery -> checked=${tickNo.inc} capacity=${JSON.stringify(tickNo.cap)}`);
check("A RECORDED DECLARING TICK is left unchecked on a no-battery job (the Ivy incident, replay side)",
  tickNo.inc === false && tickNo.cap === "", `checked=${tickNo.inc} capacity=${JSON.stringify(tickNo.cap)}`);
const tickYes = await run({ hasBattery: "Yes", essKwh: "27" }, withCheckbox);
check("...and ticked as recorded on a battery job, with this roof's capacity",
  tickYes.inc === true && tickYes.cap === "27", `checked=${tickYes.inc} capacity=${JSON.stringify(tickYes.cap)}`);

server.close();
if (failures) { console.error(`\n${failures} battery-declaration check(s) FAILED.`); process.exit(1); }
console.log("\nAll battery-declaration checks passed (real Chromium).");
process.exit(0);
