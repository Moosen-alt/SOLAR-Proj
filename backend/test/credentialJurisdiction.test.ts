// ONE VENDOR HOST, MANY JURISDICTIONS — AND ONE CITY'S PASSWORD MUST NOT REACH ANOTHER'S.
//
// Accela serves every city it hosts from aca-prod.accela.com and tells them apart by the
// first path segment: /sandiego, /lascruces, /SACRAMENTO. Tyler, iWorQ and SmartGov do the
// same. The lookup matched on HOST alone and returned whichever row was updated last.
//
// Measured live: San Diego's credential logged in successfully on its own, then reported
// "still on the login form" the moment Sacramento and Las Cruces moved onto the same host —
// it was typing a neighbour's password. Repeated attempts of that kind lock accounts out,
// and a lockout is indistinguishable from a bad credential afterwards.
//
// This tests the SELECTION, which is where the decision lives. Watching the decrypted output
// cannot see it: in a fixture every row fails to decrypt, so the answer is null either way
// and the test would pass with the fix removed.
//   npx tsx backend/test/credentialJurisdiction.test.ts
import assert from "node:assert/strict";
import { selectCredentialUrlsFor } from "../src/portalCredentials";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${e instanceof Error ? e.message : String(e)}`); }
};

const ACCELA = [
  "https://aca-prod.accela.com/SACRAMENTO/Default.aspx",
  "https://aca-prod.accela.com/lascruces/Default.aspx",
  "https://aca-prod.accela.com/sandiego/Default.aspx",
];

check("THE LIVE BUG: each jurisdiction gets its OWN row, not the most recently updated one", () => {
  const got = selectCredentialUrlsFor("https://aca-prod.accela.com/sandiego/Default.aspx", ACCELA);
  assert.deepEqual(got, ["https://aca-prod.accela.com/sandiego/Default.aspx"]);
});

check("...and the segment match is case-insensitive, because Accela writes SACRAMENTO in caps", () => {
  const got = selectCredentialUrlsFor("https://aca-prod.accela.com/sacramento/Cap/CapHome.aspx", ACCELA);
  assert.deepEqual(got, ["https://aca-prod.accela.com/SACRAMENTO/Default.aspx"]);
});

check("A JURISDICTION WITH NO CREDENTIAL GETS NOTHING — never a neighbour's", () => {
  const got = selectCredentialUrlsFor("https://aca-prod.accela.com/hollywood/Default.aspx", ACCELA);
  assert.deepEqual(got, [], "a host match with a different jurisdiction is the WRONG ACCOUNT, not a near miss");
});

check("a portal living at the host root still matches on host alone", () => {
  const got = selectCredentialUrlsFor("https://permiteyes.us/bellingham/userindex.php", ["https://permiteyes.us/"]);
  assert.deepEqual(got, ["https://permiteyes.us/"], "no stored row carries a segment, so there is no ambiguity to refuse");
});

check("but a root row does NOT win when siblings carry segments", () => {
  const mixed = ["https://aca-prod.accela.com/", ...ACCELA];
  const got = selectCredentialUrlsFor("https://aca-prod.accela.com/hollywood/Default.aspx", mixed);
  assert.deepEqual(got, [], "the bare row is as likely to be someone else's as any other");
});

check("a different host is refused outright, as before", () => {
  assert.deepEqual(selectCredentialUrlsFor("https://apps.miami.gov/iBuildPortal/", ACCELA), []);
});

if (failures) { console.error(`\n${failures} credential-jurisdiction check(s) FAILED.`); process.exit(1); }
console.log("\nAll credential-jurisdiction checks passed.");
