// A SYSTEM WITHOUT A BATTERY NEVER DECLARES ONE.
//
// Live on Ivy's PacifiCorp interconnection: the project carries hasBattery = "No" and a plan
// set of 8 modules + 4 microinverters, and the planner ticked "This system includes battery
// storage" regardless. That tick reveals a block of REQUIRED battery fields, which gap-fill
// then answered with textbook numbers — 13.5 kWh, 11.5 kW, 89% round-trip. Those are a
// Powerwall's specifications, not this customer's, and they were on their way to a utility
// as fact. The planner HAD hasBattery and still got it wrong, so the fix is a guard.
//
// Pins the label shapes the guard must catch and, just as importantly, the ones it must not:
// refusing a PV field because the word "storage" appears somewhere would break every job.
//   npx tsx portal-bot/src/adapters/batteryGuard.test.ts
import assert from "node:assert/strict";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The predicates as applyFill applies them.
const declaresBattery = (label: string): boolean =>
  /\b(includes?|has|with)\b[^.]{0,40}\b(batter(y|ies)|energy storage|\bess\b|storage system)\b/i.test(label)
  || /^\s*(battery|energy)\s*storage\b/i.test(label);

const isBatterySpec = (label: string): boolean =>
  /\bbatter(y|ies)\b|\benergy storage\b|\bess\b|round-?trip|state of charge/i.test(label);

check("THE REGRESSION: the checkbox that started it is refused", () => {
  assert.equal(declaresBattery("This system includes battery storage"), true);
});

check("other ways a portal words the same declaration", () => {
  for (const l of [
    "The system includes energy storage",
    "This project has a battery",
    "System with battery storage",
    "Battery storage included?",
    "Energy Storage System Information",
  ]) assert.equal(declaresBattery(l), true, l);
});

check("the invented specs are all refused as battery fields", () => {
  for (const l of [
    "Battery Manufacturer",
    "Battery Model",
    "Battery Round-trip Efficiency (%)",
    "Energy Storage Capacity of Battery (kWh)",
    "Maximum Power Draw of Battery During a Charging Cycle (kW)",
    "Number of Batteries",
    "Battery Disconnect Manufacturer",
  ]) assert.equal(isBatterySpec(l), true, l);
});

check("PV fields are NOT refused — the guard must not break an ordinary job", () => {
  for (const l of [
    "Inverter Manufacturer",
    "Module Model",
    "Total AC System Size (kW)",
    "PV System Specification",
    "Azimuth",
    "Roof Mounting",
    "Utility Account Number",
  ]) {
    assert.equal(declaresBattery(l), false, `declaresBattery: ${l}`);
    assert.equal(isBatterySpec(l), false, `isBatterySpec: ${l}`);
  }
});

check("a bare mention of storage in prose is not a declaration", () => {
  // The guard only refuses the CHECKBOX for a declaration; prose like this is not one.
  assert.equal(declaresBattery("See the Battery System Interim Technical Requirements on our Resources page"), false);
});

// The tri-state: only an explicit No arms the guard.
const parseHasBattery = (raw: string): boolean | undefined => {
  const v = String(raw ?? "").trim();
  if (/^(no|false|none|n)$/i.test(v)) return false;
  if (/^(yes|true|y)$/i.test(v)) return true;
  return undefined;
};

check("only an explicit No arms the guard; silence leaves it to the planner", () => {
  assert.equal(parseHasBattery("No"), false);
  assert.equal(parseHasBattery("no"), false);
  assert.equal(parseHasBattery("Yes"), true);
  assert.equal(parseHasBattery(""), undefined);
  assert.equal(parseHasBattery("unknown"), undefined);
});

// ── the REPLAY side ───────────────────────────────────────────────────────────────────────
// A recipe learned on a battery job records the whole storage section, specs frozen as
// literals. The live PacifiCorp NEM recipe carries 16 such steps including
// `Energy Storage Capacity of Battery (kWh) = "13.5"`, and replaying it onto a project with
// no battery declared one and handed the utility a Powerwall's capacity as fact.
const skipForNoBattery = (hasBattery: string, note: string): boolean => {
  if (!/^(no|false|none|n)$/i.test(String(hasBattery ?? "").trim())) return false;
  if (/program\b/i.test(note)) return false;
  return /\bbatter(y|ies)\b|\benergy storage\b|\bess\b|round-?trip|state of charge/i.test(note);
};

check("REPLAY: the recorded battery steps are skipped for a project with none", () => {
  for (const n of [
    "This system includes battery storage",
    "Energy Storage Capacity of Battery (kWh)",
    "Battery Round-trip Efficiency (%)",
    "Number of Batteries",
    "The battery has an integrated (built-in) inverter",
  ]) assert.equal(skipForNoBattery("No", n), true, n);
});

check("REPLAY: the Wattsmart PROGRAM question is still answered, not skipped", () => {
  // Skipping it would leave a required question blank — it asks about a utility programme,
  // not about equipment, and the recorded answer ("No, I will not be participating") is right.
  assert.equal(skipForNoBattery("No", "Will you be participating in the Wattsmart Battery Program?"), false);
});

check("REPLAY: a battery project replays the section as recorded", () => {
  assert.equal(skipForNoBattery("Yes", "Energy Storage Capacity of Battery (kWh)"), false);
  assert.equal(skipForNoBattery("", "Energy Storage Capacity of Battery (kWh)"), false);
});

check("REPLAY: ordinary PV steps are never skipped", () => {
  for (const n of ["Inverter Manufacturer", "upload sld: Please upload your one-line drawing", "Total AC System Size (kW)"]) {
    assert.equal(skipForNoBattery("No", n), false, n);
  }
});

if (failures) { console.error(`\n${failures} battery-guard check(s) FAILED.`); process.exit(1); }
console.log("\nAll battery-guard checks passed.");
process.exit(0);
