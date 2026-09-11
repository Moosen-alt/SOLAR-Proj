// A RECIPE IS SHARED — PROVE THE VALUES ON B'S FILING ARE B'S, AND CLASSIFY HONESTLY.
//
// The live cross-project harness (runCrossProjectReplay.ts) stages project B through a
// recipe learned on project A and sweeps every reported fill against both projects. This
// pins the sweep itself, because every rule in it was written around a specific trap:
//
//   • A's system size leaks UNIT-SCALED: 7.2 kW typed as "7200" W is still A's number on
//     B's form (the tracesTo lesson from llmGapFill, mirrored here).
//   • ...but the numeric path must run ONLY on values that ARE numbers. tracesTo's digit
//     strip reduces "Q.PEAK DUO BLK ML-G10.a+ 405" to ".10405" and A's "...G10+ 400" to
//     ".10400" — within 0.5%, a false "leak" between two DIFFERENT module models that
//     would fail every honest run of the harness.
//   • B's values in different FORMATTING are landed, never leaked: portals re-group
//     account numbers and phones, and the CEC list adds "{240V}" to a model.
//   • A value A and B genuinely SHARE (utility, state, battery "No") proves nothing
//     either way — it must be reported "shared, not evidence", never as a leak and never
//     as landing evidence.
//   • Zero leaks over zero checked fields is NOT a pass — scores need a denominator.
//
// Pure and browser-free. Run: tsx backend/test/crossProjectTripwire.test.ts
import assert from "node:assert/strict";
import {
  cleanNumber, valueTraces, sweepTripwires, tripwireVerdict, distinctLandedKeys, plannedFills,
} from "../src/crossProjectReplay";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The two projects, shaped like the harness's real fixtures: A is the learn-benchmark
// project (runLearnBenchmark.ts, IL row), B the materially different replay project.
const A = {
  homeownerName: "Benchmark Springfield",
  street: "800 E Monroe St", city: "Springfield", zip: "62701",
  phone: "(503) 555-0142", email: "permit@infinitysolarusa.com",
  dcKw: "7.2", acKw: "5.22", moduleQty: "18", moduleWattage: "400",
  inverterModel: "IQ8PLUS-72-2-US", inverterModelCertified: "IQ8PLUS-72-2-US {240V}",
  moduleModel: "Q.PEAK DUO BLK ML-G10+ 400",
  account: "84739218 306 4",
  // Shared with B on purpose:
  utility: "Ameren Illinois", state: "IL", hasBattery: "No",
};
const B = {
  homeownerName: "ZZTest CrossProject Bravo",
  street: "914 W Eldorado St", city: "Decatur", zip: "62521",
  phone: "(217) 555-0179", email: "permit+xproj-b@infinitysolarusa.com",
  dcKw: "5.67", acKw: "4.55", moduleQty: "14", moduleWattage: "405",
  inverterModel: "IQ8M-72-2-US", inverterModelCertified: "IQ8M-72-2-US {240V}",
  moduleModel: "Q.PEAK DUO BLK ML-G10.a+ 405",
  account: "30917 44286 1",
  utility: "Ameren Illinois", state: "IL", hasBattery: "No",
};

// ---------------------------------------------------------------------------
// MUST CATCH — A's data on B's filing, in every disguise it has actually worn.
// ---------------------------------------------------------------------------
check("A's homeowner name in ANY field is a leak, whatever the field is called", () => {
  const r = sweepTripwires([{ field: "Contractor Name", value: "Benchmark Springfield" }], A, B);
  assert.equal(r.leaked.length, 1);
  // It legitimately trips two of A's wires — the name, and the city inside it.
  assert.ok(r.leaked[0].matchedA.includes("homeownerName"));
  assert.equal(r.landed.length, 0);
});

check("THE UNIT-SCALED LEAK: A's 7.2 kW typed as \"7200\" W is still A's size", () => {
  const r = sweepTripwires([{ field: "Total System Size (W)", value: "7200" }], A, B);
  assert.equal(r.leaked.length, 1, "a kW value re-expressed in watts slipped past the sweep");
  assert.ok(r.leaked[0].matchedA.includes("dcKw"));
});

check("A's module count \"18\" verbatim is a leak — exact equality has no length floor", () => {
  const r = sweepTripwires([{ field: "Number of Modules", value: "18" }], A, B);
  assert.equal(r.leaked.length, 1);
  assert.ok(r.leaked[0].matchedA.includes("moduleQty"));
});

check("A's account number re-grouped by the portal is still A's account", () => {
  const r = sweepTripwires([{ field: "Account", value: "84739218-3064" }], A, B);
  assert.equal(r.leaked.length, 1);
  assert.ok(r.leaked[0].matchedA.includes("account"));
});

check("A's certified model string (the {240V} rendering) is a leak", () => {
  const r = sweepTripwires([{ field: "Model", value: "IQ8PLUS-72-2-US {240V}" }], A, B);
  assert.equal(r.leaked.length, 1);
});

check("the review screen showing A's street is a leak the sweep can read", () => {
  // The harness feeds reviewMismatches[].found through valueTraces — same matcher.
  assert.equal(valueTraces("800 E Monroe St, Springfield IL", A.street), true);
  assert.equal(valueTraces("914 W Eldorado St, Decatur IL", A.street), false);
});

// ---------------------------------------------------------------------------
// MUST COUNT AS LANDED — B's values under portal reformatting are B's, never A's.
// ---------------------------------------------------------------------------
check("B's phone with the punctuation stripped is LANDED, not leaked", () => {
  const r = sweepTripwires([{ field: "Phone", value: "2175550179" }], A, B);
  assert.equal(r.landed.length, 1);
  assert.ok(r.landed[0].matchedB.includes("phone"));
  assert.equal(r.leaked.length, 0);
});

check("B's model with the CEC \"{240V}\" suffix is LANDED", () => {
  const r = sweepTripwires([{ field: "Model", value: "IQ8M-72-2-US {240V}" }], A, B);
  assert.equal(r.landed.length, 1);
  assert.equal(r.leaked.length, 0, "B's certified model must never read as A's");
});

check("B's 5.67 kW typed as \"5670\" W is LANDED — the unit tolerance works both ways", () => {
  const r = sweepTripwires([{ field: "Total System Size (W)", value: "5670" }], A, B);
  assert.equal(r.landed.length, 1);
  assert.ok(r.landed[0].matchedB.includes("dcKw"));
  assert.equal(r.leaked.length, 0);
});

// ---------------------------------------------------------------------------
// MUST NOT FLAG — the false positives that would fail every honest run.
// ---------------------------------------------------------------------------
check("THE MODULE-MODEL TRAP: B's \"…G10.a+ 405\" must not read as A's \"…G10+ 400\"", () => {
  // tracesTo's digit strip turns both into ".10405"/".10400" — within 0.5% at factor 1.
  // The numeric path must refuse strings that are not actually quantities.
  assert.equal(cleanNumber("Q.PEAK DUO BLK ML-G10.a+ 405"), null, "a model string is not a quantity");
  // The single-dot pair is the one tracesTo's digit strip actually inverts on:
  // ".10405" vs ".10400" are within 0.5% of each other at factor 1.
  assert.equal(valueTraces("Q.PEAK DUO BLK ML-G10+ 405", "Q.PEAK DUO BLK ML-G10+ 400"), false,
    "two different module models were called the same quantity");
  const r = sweepTripwires([{ field: "Module Model", value: "Q.PEAK DUO BLK ML-G10.a+ 405" }], A, B);
  assert.equal(r.leaked.length, 0, "two different module models were called the same value");
  assert.equal(r.landed.length, 1);
});

check("shared values (utility, state, battery No) are SHARED, not evidence either way", () => {
  const r = sweepTripwires([
    { field: "Utility", value: "Ameren Illinois" },
    { field: "State", value: "IL" },
    { field: "Energy Storage", value: "No" },
  ], A, B);
  assert.equal(r.shared.length, 3);
  assert.equal(r.leaked.length, 0, "a value A and B genuinely share proves nothing and must not fail the run");
  assert.equal(r.landed.length, 0, "…and must not count as landing evidence either");
  assert.deepEqual(distinctLandedKeys(r), [], "shared keys must not inflate the pass evidence");
});

check("THE DIGIT-TWIN TRAP: A's and B's certified inverters share every digit", () => {
  // "IQ8PLUS-72-2-US {240V}" and "IQ8M-72-2-US {240V}" both reduce to the digit string
  // "8722240" — the digit-run path must not treat letter-bearing model names as phone
  // numbers, or the two models read as the same value and every verdict inverts.
  assert.equal(valueTraces("IQ8M-72-2-US {240V}", "IQ8PLUS-72-2-US {240V}"), false);
  assert.equal(valueTraces("IQ8PLUS-72-2-US {240V}", "IQ8M-72-2-US {240V}"), false);
});

check("two different ZIP codes are not 'the same quantity' — but kW rounding still is", () => {
  // At 0.5% relative tolerance, 62521 and 62701 counted as equal quantities. Integers
  // compared at face value must be EQUAL; the tolerance stays for decimal rounding
  // across unit scales (7.678 kW rendered as "7680" W by a portal that rounds).
  assert.equal(valueTraces("62521", "62701"), false);
  assert.equal(valueTraces("7678", "7.68"), true);
});

check("A's \"7.2\" must not fire inside unrelated digit runs (containment floor)", () => {
  // normalize("7.2") is "72", which appears inside zips and phone numbers all day.
  const r = sweepTripwires([{ field: "Some Zip", value: "97223" }], A, B);
  assert.equal(r.leaked.length, 0);
  assert.equal(r.unverifiable.length, 1, "a value matching neither project is unverifiable, not a verdict");
});

check("a value tracing to neither project is UNVERIFIABLE, never landed", () => {
  const r = sweepTripwires([{ field: "Rate Schedule", value: "7" }], A, B);
  assert.equal(r.landed.length, 0);
  assert.equal(r.leaked.length, 0);
  assert.equal(r.unverifiable.length, 1);
});

// ---------------------------------------------------------------------------
// THE DENOMINATOR — empty evidence must say so, never pass vacuously.
// ---------------------------------------------------------------------------
check("an empty filled set is checkedFields 0 with every B key unfilled — and NOT a pass", () => {
  const r = sweepTripwires([], A, B);
  assert.equal(r.checkedFields, 0);
  assert.ok(r.unfilled.includes("homeownerName"));
  assert.ok(r.unfilled.includes("account"));
  const v = tripwireVerdict(r);
  assert.equal(v.verdict, "INSUFFICIENT_EVIDENCE", "zero leaks over zero fields read as a clean bill");
});

check("empty values were never typed: excluded from the denominator entirely", () => {
  const r = sweepTripwires([{ field: "Meter", value: "" }, { field: "Phone", value: "  " }], A, B);
  assert.equal(r.checkedFields, 0);
});

check("verdict: one leak fails the run however much of B also landed", () => {
  const r = sweepTripwires([
    { field: "Name", value: B.homeownerName },
    { field: "Street", value: B.street },
    { field: "Zip", value: B.zip },
    { field: "Size", value: "7200" }, // A's, unit-scaled
  ], A, B);
  assert.equal(tripwireVerdict(r).verdict, "LEAKED");
});

check("verdict: three distinct B values with no leak is a PASS", () => {
  const r = sweepTripwires([
    { field: "Name", value: B.homeownerName },
    { field: "Street", value: B.street },
    { field: "Zip", value: B.zip },
  ], A, B);
  const v = tripwireVerdict(r);
  assert.equal(v.verdict, "PASS");
});

check("verdict: two distinct B values is still INSUFFICIENT — below the coincidence floor", () => {
  const r = sweepTripwires([
    { field: "Name", value: B.homeownerName },
    { field: "Zip", value: B.zip },
  ], A, B);
  assert.equal(tripwireVerdict(r).verdict, "INSUFFICIENT_EVIDENCE");
});

check("one field matching two B keys is ONE distinct key per key, not double credit", () => {
  // "14" traces to both moduleQty and (hypothetically) inverterQuantity when equal —
  // distinct KEYS are counted, so evidence cannot be inflated by aliased keys landing once.
  const r = sweepTripwires([
    { field: "Modules", value: "14" },
    { field: "Inverters", value: "14" },
  ], A, { moduleQty: "14", inverterQuantity: "14" });
  assert.deepEqual(distinctLandedKeys(r), ["inverterQuantity", "moduleQty"]);
  assert.equal(tripwireVerdict(r).verdict, "INSUFFICIENT_EVIDENCE", "two keys from the same digit pair is not three");
});

// ---------------------------------------------------------------------------
// plannedFills — the reconstruction of what replay types, where literals surface.
// ---------------------------------------------------------------------------
check("a bound step takes B's value; a *Model key takes the certified rendering", () => {
  const fills = plannedFills(
    [
      { action: "fill", field: "homeownerName", note: "Name" },
      { action: "select", field: "inverterModel", note: "Model" },
    ],
    { homeownerName: B.homeownerName, inverterModel: B.inverterModel, inverterModelCertified: B.inverterModelCertified },
  );
  assert.equal(fills[0].value, B.homeownerName);
  assert.equal(fills[0].source, "bound");
  assert.equal(fills[1].value, "IQ8M-72-2-US {240V}");
  assert.equal(fills[1].source, "certified");
});

check("an UNKNOWN key falls through to the recorded literal — the place leaks live", () => {
  const fills = plannedFills(
    [{ action: "fill", field: "ownerFullName", value: "Benchmark Springfield", note: "Owner" }],
    { homeownerName: B.homeownerName },
  );
  assert.equal(fills[0].source, "literal");
  assert.equal(fills[0].value, "Benchmark Springfield");
  const r = sweepTripwires(fills, A, B);
  assert.equal(r.leaked.length, 1, "the frozen learn-project literal must surface in the sweep");
});

check("a KNOWN key with no value replays BLANK — the literal must not resurrect", () => {
  // resolveValue's own rule: a key the dictionary defines and leaves empty is an answer
  // ("blank"), or a shared recipe files the learn project's homeowner.
  const fills = plannedFills(
    [{ action: "fill", field: "accountNumber", value: "84739218 306 4", note: "Account" }],
    { accountNumber: "" },
  );
  assert.equal(fills[0].value, "", "a defined-but-empty key resurrected the learn project's literal");
});

check("the final-submit step is never part of the sweep", () => {
  const fills = plannedFills(
    [{ action: "check", field: "agree", value: "yes", isFinalSubmit: true, note: "Submit" }],
    {},
  );
  assert.equal(fills.length, 0);
});

// CLIENT-SCOPED VALUES ARE NOT CROSS-PROJECT EVIDENCE. Found live on the first Ameren B
// run: three "leaks" of permit@infinitysolarusa.com, every one an installerEmail-bound
// field carrying the SOLAR COMPANY's own address - correct on every filing the company
// makes. The learn fixture had reused that address as project A's contact email, so the
// string sat in A's tripwires. The sweep now takes the client's own values and classifies
// such hits clientScoped, never leaked. Both directions pinned: without clientValues the
// same hit MUST still read as leaked (the kill direction), and an A value that is NOT the
// client's stays leaked (the list is not a blanket amnesty).
check("a client-scoped value matching A is clientScoped, not leaked", () => {
  const r = sweepTripwires([{ field: "Email", value: "permit@infinitysolarusa.com" }],
    { email: "permit@infinitysolarusa.com" }, { email: "permit+xproj-b@infinitysolarusa.com" },
    ["permit@infinitysolarusa.com"]);
  assert.equal(r.leaked.length, 0, "the company's own email on the company's filing is not a leak");
  assert.equal(r.clientScoped.length, 1);
});

check("KILL: the same hit WITHOUT clientValues still reads as leaked", () => {
  const r = sweepTripwires([{ field: "Email", value: "permit@infinitysolarusa.com" }],
    { email: "permit@infinitysolarusa.com" }, { email: "permit+xproj-b@infinitysolarusa.com" });
  assert.equal(r.leaked.length, 1, "omitting clientValues must not silently absorb real leaks");
});

check("MUST STILL LEAK: an A-only value that is NOT the client's stays leaked", () => {
  const r = sweepTripwires([{ field: "Owner", value: "Benchmark Springfield" }],
    { homeownerName: "Benchmark Springfield" }, { homeownerName: "ZZTest Bravo" },
    ["permit@infinitysolarusa.com", "TML INTERNATIONAL LLC"]);
  assert.equal(r.leaked.length, 1, "the client list must not become a blanket amnesty");
});

check("a value that is A's AND B's stays shared even when also client-scoped", () => {
  const r = sweepTripwires([{ field: "Utility", value: "Ameren Illinois" }],
    { utility: "Ameren Illinois" }, { utility: "Ameren Illinois" }, ["Ameren Illinois"]);
  assert.equal(r.shared.length, 1, "shared outranks clientScoped - both projects carry it");
});

if (failures) { console.error(`\n${failures} cross-project tripwire check(s) FAILED.`); process.exit(1); }
console.log("\nAll cross-project tripwire checks passed.");
process.exit(0);
