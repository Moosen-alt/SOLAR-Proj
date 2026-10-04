// WHEN A PORTAL PRINTS THE FORMAT IT WANTS, USE IT — BUT NEVER CHANGE THE VALUE.
//
// PacifiCorp rejected Ivy's interconnection naming "Customer's account number - please use
// this format: xxxxxxxx xxx x". The bill prints "90000000-004 0", intake stored
// "90000000-0040", and the digits were right the whole time; only the grouping was wrong.
//
// The risk in fixing that is worse than the bug: an account number that is subtly altered can
// attach a filing to somebody else's account. So these checks are mostly about what the
// function REFUSES to do.
//   npx tsx portal-bot/src/formatHint.test.ts
import assert from "node:assert/strict";
import { applyFormatHint, extractFormatMask } from "./formatHint";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const PACIFICORP = "Customer's account number - please use this format: xxxxxxxx xxx x";

check("THE REGRESSION: the stored account is re-grouped as PacifiCorp asked", () => {
  assert.equal(applyFormatHint("90000000-0040", PACIFICORP), "90000000 004 0");
});

check("the same digits, however they arrived", () => {
  for (const v of ["90000000 004 0", "900000000040", "90000000-004-0"]) {
    assert.equal(applyFormatHint(v, PACIFICORP), "90000000 004 0", v);
  }
});

check("Placeholder's account too", () => {
  assert.equal(applyFormatHint("90000000-0050", PACIFICORP), "90000000 005 0");
});

check("NOTHING is added, dropped or reordered — only separators change", () => {
  const out = applyFormatHint("90000000-0040", PACIFICORP);
  assert.equal(out.replace(/[^A-Za-z0-9]/g, ""), "900000000040");
});

check("a value that does not fit the mask is left ALONE, never padded or truncated", () => {
  // One digit short, and one too many: both are "not the thing the mask describes".
  assert.equal(applyFormatHint("5810350400", PACIFICORP), "5810350400");
  assert.equal(applyFormatHint("5810350400123", PACIFICORP), "5810350400123");
});

check("a label with no format hint changes nothing", () => {
  assert.equal(applyFormatHint("90000000-0040", "Customer's account number"), "90000000-0040");
});

check("prose that merely contains the word format is not a mask", () => {
  assert.equal(extractFormatMask("Enter the date in a readable format: 2024 or later"), "");
  assert.equal(applyFormatHint("90000000-0040", "…in any format: yes or no"), "90000000-0040");
});

check("an empty value stays empty rather than becoming a mask of separators", () => {
  assert.equal(applyFormatHint("", PACIFICORP), "");
});

check("a dashed mask is honoured as printed", () => {
  assert.equal(applyFormatHint("123456789", "Meter ID - format: xxx-xxx-xxx"), "123-456-789");
});

if (failures) { console.error(`\n${failures} format-hint check(s) FAILED.`); process.exit(1); }
console.log("\nAll format-hint checks passed.");
process.exit(0);
