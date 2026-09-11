// PAGING A TABLE IS NOT ADVANCING AN APPLICATION.
//
// ComEd (interconnect.comed.com - a NEM portal, and the second-biggest utility in Illinois)
// banked this as step 10 of its recipe:
//   {"action":"click","selector":{"role":"button","name":"Next page"},"note":"advance: Next page"}
// "Next page" is Angular Material's mat-paginator aria-label on the DASHBOARD BEHIND the open
// application drawer. It passed the advance test because that regex matches /^next\b/, and the
// rollback never fired because the page fingerprint counts document.body.innerText.length - which
// paging a table changes. The walk "advanced" repeatedly on one screen and banked a recipe that
// teaches replay to click a paginator.
//
// This is a filter list, and filter lists fail BOTH ways, so both directions are pinned:
//   MUST EXCLUDE - pager wording is never treated as an advance.
//   MUST PASS    - every real wizard advance still is. Rejecting "Next" would strand the walk on
//                  page one of every portal in the fleet, which is far worse than the bug.
//
//   npx tsx portal-bot/src/adapters/paginationAdvance.test.ts
import assert from "node:assert/strict";
import { PAGINATION_CONTROL } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

// Labels a pager uses. No wizard's forward control is ever called any of these.
const PAGER = ["Next page", "next page", "NEXT PAGE", "Previous page", "Prev page", "Next 10", "Next 25", "Previous 10"];
// Real advances seen across this fleet - PowerClerk, Accela, EnerGov, SmartGov, iWorq.
const REAL_ADVANCES = [
  "Next", "next", "NEXT", "Next Step", "Next >", "Continue", "Proceed",
  "Save and Continue", "Save & Next", "Go to Next", "Continue Application", "Next Section",
];

check("MUST EXCLUDE: pager wording is never an advance", () => {
  for (const label of PAGER) {
    assert.ok(PAGINATION_CONTROL.test(label),
      `"${label}" is a table pager and must be refused as an advance — this is ComEd's step 10`);
  }
});

check("MUST PASS: every real wizard advance survives", () => {
  for (const label of REAL_ADVANCES) {
    assert.ok(!PAGINATION_CONTROL.test(label),
      `"${label}" is a genuine advance and was rejected — that strands the walk on page one, which is worse than the bug being fixed`);
  }
});

check("a bare 'Next' is an advance, not a pager — the distinction the whole fix rests on", () => {
  assert.equal(PAGINATION_CONTROL.test("Next"), false);
  assert.equal(PAGINATION_CONTROL.test("Next page"), true);
});

check("the rule is shape-based, carrying no hostname or portal name", () => {
  const src = PAGINATION_CONTROL.source.toLowerCase();
  for (const portalish of ["comed", "powerclerk", "accela", "smartgov", "iworq", "http", ".com"]) {
    assert.ok(!src.includes(portalish),
      `the pattern names "${portalish}" — a fix keyed to one portal does not help the unknown ones`);
  }
});

console.log(failures === 0
  ? "\nAll pagination-advance checks passed."
  : `\n${failures} pagination-advance check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
