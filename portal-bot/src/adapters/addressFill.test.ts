// HOW MUCH OF AN ADDRESS TO STRIP DEPENDS ON HOW MANY BOXES THE PORTAL SPLITS IT INTO.
//
// Accela's work-location search wants the CORE street name — "925 N Grant St" searched as
// "Grant", because the direction and suffix have boxes of their own and including them
// returns nothing. Miami's iBuild has ONE box and wants the whole line: its database holds
// the property as "3500 PAN AMERICAN DR", and "3500 Pan American" — the very value the
// split-form keys produce — comes back "Property Address not found." (browser-verified
// against the live portal; the whole line finds it first try).
//
// Both behaviours are correct, on their own form. So this tests the discrimination, in both
// directions: the correction must fire on a combined box and must NOT fire on a split one,
// and it must only ever EXPAND — never swap one address for another.
//   npx tsx portal-bot/src/adapters/addressFill.test.ts
import assert from "node:assert/strict";
import {
  parseStreetLine,
  isSplitAddressForm,
  correctTruncatedAddressFill,
  parseStreetName,
} from "../addressParse";

const MIAMI = "3500 Pan American Dr, Miami, FL, 33133";
const OREGON = "925 N Grant St, Lafayette, OR, 97127";

// --- parseStreetLine: the whole street, city/state/zip gone --------------------------
assert.equal(parseStreetLine(MIAMI, "Miami"), "3500 Pan American Dr");
assert.equal(parseStreetLine(OREGON, "Lafayette"), "925 N Grant St");
// The city repeated INSIDE the street line (common in imported records) is stripped too.
assert.equal(parseStreetLine("3500 Pan American Dr Miami FL 33133", "Miami"), "3500 Pan American Dr");
// No city known — still returns the street line, never the whole comma-joined address.
assert.equal(parseStreetLine(MIAMI), "3500 Pan American Dr");
assert.equal(parseStreetLine(""), "");
// And it keeps exactly what the subtracting parser removes.
assert.equal(parseStreetName(MIAMI), "Pan American");
console.log("ok - parseStreetLine keeps the whole street line");

// --- isSplitAddressForm: MUST PASS ----------------------------------------------------
assert.equal(isSplitAddressForm(["Street No.", "Street Name"]), true);
assert.equal(isSplitAddressForm(["House Number", "Street"]), true);
assert.equal(isSplitAddressForm(["Street Name", "Street Type"]), true);
assert.equal(isSplitAddressForm(["Direction", "Street Name", "Suffix"]), true);
assert.equal(isSplitAddressForm(["Street Direction", "Street Name"]), true);
console.log("ok - split address forms are recognised");

// --- isSplitAddressForm: MUST EXCLUDE -------------------------------------------------
// Miami's actual labels. A combined box is often called "Street Address" or "Property
// Address" — reading either as split would silently disable the correction on exactly the
// forms it exists for.
assert.equal(isSplitAddressForm([
  "Search by Address, Process Number, Permit Number or Menu Option...",
  "SearchType",
  "cbAutoComplete",
]), false);
assert.equal(isSplitAddressForm(["Street Address"]), false);
assert.equal(isSplitAddressForm(["Property Address"]), false);
assert.equal(isSplitAddressForm(["Address", "City", "State", "Zip"]), false);
// A contact block's Jr./Sr. box is not a street suffix.
assert.equal(isSplitAddressForm(["First Name", "Last Name", "Name Suffix"]), false);
assert.equal(isSplitAddressForm([undefined, ""]), false);
console.log("ok - combined address boxes are NOT read as split");

// --- the correction: MUST PASS --------------------------------------------------------
const combined = { fullStreetLine: "3500 Pan American Dr", projectAddress: MIAMI, splitForm: false };

// The exact value Miami's walk searched on page 4 — streetNumber + streetNameCore.
assert.deepEqual(
  correctTruncatedAddressFill({ value: "3500 Pan American" }, combined),
  { value: "3500 Pan American Dr", field: "street" },
);
// Page 7's value — streetNameCore alone.
assert.deepEqual(
  correctTruncatedAddressFill({ value: "Pan American", field: "streetNameCore" }, combined),
  { value: "3500 Pan American Dr", field: "street" },
);
// The 3-character search portion.
assert.deepEqual(
  correctTruncatedAddressFill({ value: "Pan", field: "streetNameSearchPortion" }, combined),
  { value: "3500 Pan American Dr", field: "street" },
);
// Corrected fills stay BOUND to `street`, never frozen as this project's literal — a recipe
// is shared across every project under the profile.
assert.equal(correctTruncatedAddressFill({ value: "Pan American" }, combined)?.field, "street");
console.log("ok - a truncated fill on a combined box is expanded to the whole line");

// --- the correction: MUST EXCLUDE -----------------------------------------------------
const split = { fullStreetLine: "925 N Grant St", projectAddress: OREGON, splitForm: true };

// Accela: the core name in the Street Name box is CORRECT and must survive untouched.
assert.equal(correctTruncatedAddressFill({ value: "Grant", field: "streetNameCore" }, split), null);
assert.equal(correctTruncatedAddressFill({ value: "Gra", field: "streetNameSearchPortion" }, split), null);

// Already whole — no rewrite, no churn.
assert.equal(correctTruncatedAddressFill({ value: "3500 Pan American Dr", field: "street" }, combined), null);
assert.equal(correctTruncatedAddressFill({ value: "3500 PAN AMERICAN DR." }, combined), null);

// Not an address at all.
assert.equal(correctTruncatedAddressFill({ value: "Jane Doe", field: "homeownerName" }, combined), null);
assert.equal(correctTruncatedAddressFill({ value: "Miami", field: "city" }, combined), null);

// EXPANSION ONLY. A value the street line does not contain is somebody else's address, and
// replacing it would file the job against the wrong property — the one failure here that is
// worse than the bug being fixed.
assert.equal(
  correctTruncatedAddressFill({ value: "Main", field: "streetNameCore" }, combined),
  null,
);
assert.equal(
  correctTruncatedAddressFill({ value: "412 Main St", field: "street" }, combined),
  null,
);

// Nothing to expand to.
assert.equal(
  correctTruncatedAddressFill({ value: "Pan American", field: "streetNameCore" }, { fullStreetLine: "", projectAddress: MIAMI, splitForm: false }),
  null,
);
console.log("ok - split forms, whole values, and unrelated values are left alone");

console.log("addressFill.test: PASS");
