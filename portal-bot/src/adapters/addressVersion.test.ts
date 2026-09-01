// WHICH VERSION OF THE ADDRESS DO WE TRY FIRST?
//
// Accela lists one street address once per issuing jurisdiction and the permit types on offer
// differ per row. A first cut hard-mapped CITY->structural and COUNTY->electrical; the operator
// corrected that (either can hold both). The replacement tried every version until one offered
// the permit — and promptly selected "DEQ Applications", which issues onsite/septic permits and
// nothing else, then wedged. These are the real 773 Kentucky rows.
//   npx tsx portal-bot/src/adapters/addressVersion.test.ts
import assert from "node:assert/strict";
import { rankAddressVersions } from "./oregonEPermitting";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Verbatim from the live search for 773 Kentucky Ave, Coos Bay.
const KENTUCKY = [
  "Select 773 KENTUCKY AV, DEQ Applications, COOS BAY Coos OR 97420 DEQ Applications COOS BAY OR 97420 25S13W20CC2503 GILPIN, BILLY, JR. & LAMBERT, COURTNEY",
  "Select 773 KENTUCKY AVE, City Applications, EMPIRE, COOS BAY COOS OR 97420 City Applications COOS BAY OR 97420 25S13W20CCTL0250300 SAKSCHEWSKI, GERHARD & JEANNETT",
  "Select 773 KENTUCKY AVE, COUNTY APPLICATIONS, COOS BAY COOS OR 97420 COUNTY APPLICATIONS COOS BAY OR 97420 25S1320CC02503 HUISMAN, VINCENT",
];
const IVY = { city: "Coos Bay", zip: "97420", homeownerName: "Christopher Ivy" };

const first = (rows: string[], isElectrical: boolean): string =>
  rankAddressVersions(rows, { ...IVY, isElectrical }).ranked[0]?.text ?? "";

check("electrical tries the COUNTY version first (it holds the electrical permit)", () => {
  assert.match(first(KENTUCKY, true), /COUNTY APPLICATIONS/);
});

check("structural tries the CITY version first (it holds the structural permit)", () => {
  assert.match(first(KENTUCKY, false), /City Applications/);
});

check("THE REGRESSION: DEQ is never tried first — it issues nothing we file", () => {
  assert.doesNotMatch(first(KENTUCKY, true), /DEQ/);
  assert.doesNotMatch(first(KENTUCKY, false), /DEQ/);
  // and it sorts last in both directions
  for (const elec of [true, false]) {
    const r = rankAddressVersions(KENTUCKY, { ...IVY, isElectrical: elec }).ranked;
    assert.match(r[r.length - 1].text, /DEQ/, `DEQ should be last (isElectrical=${elec})`);
  }
});

check("every version of THIS property stays a candidate — order is a hint, not a filter", () => {
  assert.equal(rankAddressVersions(KENTUCKY, { ...IVY, isElectrical: true }).ranked.length, 3);
});

// The operator's correction: sometimes one record carries BOTH disciplines.
check("a single record holding both disciplines is tried first for either", () => {
  const both = ["Select 1780 OCEAN BLVD SE, City Applications, COOS BAY OR 97420 City Applications COOS BAY OR 97420 111 MARINEAU, CRAIG"];
  assert.match(first(both, true), /OCEAN BLVD/);
  assert.match(first(both, false), /OCEAN BLVD/);
});

check("the owner of record outranks the jurisdiction convention", () => {
  const rows = [
    "Select 773 KENTUCKY AVE, COUNTY APPLICATIONS, COOS BAY OR 97420 COUNTY APPLICATIONS COOS BAY OR 97420 25S1320CC02503 HUISMAN, VINCENT",
    "Select 773 KENTUCKY AVE, City Applications, COOS BAY OR 97420 City Applications COOS BAY OR 97420 25S13W20CCTL0250300 IVY, CHRISTOPHER A",
  ];
  // Electrical would normally prefer COUNTY, but the customer's own parcel wins.
  assert.match(first(rows, true), /IVY, CHRISTOPHER/);
});

check("a different town's row is REJECTED, never merely ranked low", () => {
  const loose = [
    "Select 119 7TH E, County Applications, MILTON FREEWATER UMATILLA OR 97862 County Applications MILTON FREEWATER OR 97862",
    "Select 119 NE 78TH AVE, PORTLAND OR 97213 PORTLAND OR 97213 1N2E32DA10900",
    "Select 773 KENTUCKY AVE, COUNTY APPLICATIONS, COOS BAY OR 97420 COUNTY APPLICATIONS COOS BAY OR 97420 25S1320CC02503 HUISMAN, VINCENT",
  ];
  const out = rankAddressVersions(loose, { ...IVY, isElectrical: true });
  assert.equal(out.ranked.length, 1, "only the Coos Bay row is a candidate");
  assert.equal(out.rejected.length, 2);
});

check("no candidate at all yields an empty ranking, so the caller can refuse to file", () => {
  const out = rankAddressVersions(
    ["Select 119 NE 78TH AVE, PORTLAND OR 97213 PORTLAND OR 97213"],
    { ...IVY, isElectrical: true },
  );
  assert.equal(out.ranked.length, 0);
});

if (failures) { console.error(`\n${failures} address-version check(s) FAILED.`); process.exit(1); }
console.log("\nAll address-version checks passed.");
process.exit(0);
