// A LEGAL PAGE IS NEVER AN APPLICATION, AND EVERY PORTAL HAS ONE IN ITS FOOTER.
//
// Des Moines WA (PermitTrax) did everything right and then wasted the run. Its own events:
//
//   login              logged_in
//   entry pass page 1  ok:true, label "Click to Apply Online"
//   p2  .../citizen/Home/...          dashboard, 0 fills
//   p3  .../citizen/CookiePolicy/...  dashboard, 0 fills
//   p4  .../citizen/CookiePolicy/...  dashboard, 0 fills
//
// It signed in through a dropdown that names itself only by a tooltip, found the right
// entry control, and then spent its whole page budget in the cookie policy. "Cookie Policy"
// reads like any other link, and a consent banner puts one in front of the content on a
// first visit — which is every visit, now that each portal gets a fresh profile.
//
// This is the same lesson as the checklist exclusion found by sweeping 66 portals: a
// document ABOUT the process is not the process. Consent and legal pages are that class,
// they appear in essentially every government portal footer, and they cost a page of budget
// each time.
//
// Browser-free. Run: npx tsx portal-bot/src/adapters/entryExclude.test.ts
import assert from "node:assert/strict";
import { isExcludedEntryLabel, matchesEntryLabel } from "./applicationEntry";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

check("THE REGRESSION: 'Cookie Policy' is not somewhere to start an application", () => {
  assert.equal(isExcludedEntryLabel("Cookie Policy"), true);
  assert.equal(matchesEntryLabel("Cookie Policy"), false);
});

check("...nor are the rest of the footer, which every portal carries", () => {
  for (const label of [
    "Privacy Policy", "Terms of Use", "Terms of Service", "Consent Preferences",
    "Disclaimer", "Accessibility Statement", "Copyright 2023", "Site Map",
  ]) {
    assert.equal(isExcludedEntryLabel(label), true, `not excluded: ${label}`);
  }
});

// ---------------------------------------------------------------------------
// The expensive direction. An exclusion list that eats the target is the failure
// mode that reads as a portal bug, so the real entry labels are pinned here too.
// ---------------------------------------------------------------------------
check("the real entry controls are UNTOUCHED", () => {
  for (const label of [
    "Click to Apply Online",          // PermitTrax's own, the one it must still find
    "Apply for a Permit",
    "New Application",
    "Create an Application",
    "Start a New Permit Application",
    "Begin Submittal",
    "Submit a new record",
  ]) {
    assert.equal(isExcludedEntryLabel(label), false, `wrongly excluded: ${label}`);
  }
});

check("...and they still MATCH as entries, not merely escape exclusion", () => {
  for (const label of ["Click to Apply Online", "Apply for a Permit", "New Application"]) {
    assert.equal(matchesEntryLabel(label), true, `no longer matches: ${label}`);
  }
});

check("a permit whose name happens to contain a legal word is not eaten", () => {
  // The word-boundary lesson from PROGRAM_EXCLUDE, applied before it can bite here.
  // "Privacy" and "cookie" are unlikely in a permit name, but "terms" alone would be
  // dangerous — hence the rule matches "terms of use"/"terms of service", never bare terms.
  assert.equal(isExcludedEntryLabel("Short Terms Rental Permit"), false);
  assert.equal(isExcludedEntryLabel("Long Term Care Facility Permit"), false);
  // Bare "consent" is deliberately not excluded — this is a real permitting document.
  assert.equal(isExcludedEntryLabel("Owner Consent Form"), false);
});

check("the checklist exclusion that came before it still holds", () => {
  assert.equal(isExcludedEntryLabel("Permit Application Checklist"), true);
  assert.equal(isExcludedEntryLabel("Application Instructions"), true);
});

if (failures) { console.error(`\n${failures} entry-exclude check(s) FAILED.`); process.exit(1); }
console.log("\nAll entry-exclude checks passed.");
process.exit(0);
