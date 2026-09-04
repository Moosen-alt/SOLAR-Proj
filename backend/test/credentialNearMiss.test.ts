// A REFUSAL HAS TO NAME THE PORTAL IT WANTED.
//
// Autopilot stopped on Bren Trask's Portland permit with:
//
//   "City of Portland is showing a login page but no stored credential was found for this
//    client/portal. Add the portal username + password under the client's logins, then retry."
//
// The operator's reasonable reply was that the logins WERE imported. Both were right. The
// client holds 83 stored logins, one of them for Oregon ePermitting at aca-oregon.accela.com
// — and the page in front of the bot was devhub.portlandoregon.gov, City of Portland's own
// permitting system, which needs its own account. Refusing was correct: reusing another
// portal's password would spray a secret at a system it does not belong to. Not naming the
// host was the defect, and it cost an afternoon.
//
// The first attempt at a fix listed all 83 stored logins — 4,764 characters of wall that
// buried the one fact worth reading. So the note names the host it needed and offers only
// the logins that plausibly ARE it.
//
// The lookalike case is the one that earns this its own test: the client holds a login for
// selfservice.portlandmaine.gov. Portland, Maine is not Portland, Oregon, and that is
// exactly the login a tired operator tries at 6pm.
//
// Browser-free. Run: tsx backend/test/credentialNearMiss.test.ts
import assert from "node:assert/strict";
import { nearestStoredLogins } from "../src/portalCredentials";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// A representative slice of the real 83, including the traps.
const STORED = [
  { portalType: "oregon_epermitting_accela", portalUrl: "https://aca-oregon.accela.com/oregon/" },
  { portalType: "ME · Tyler EnerGov (CSS Self Service)", portalUrl: "https://selfservice.portlandmaine.gov/EnerGov_Prod/SelfService" },
  { portalType: "CA · Unknown (www.cityofsacramento.gov)", portalUrl: "https://www.cityofsacramento.gov/permits" },
  { portalType: "MA · Unknown (onlinepermitsandlicenses.cityofboston.gov)", portalUrl: "https://onlinepermitsandlicenses.cityofboston.gov/isdpermits" },
  { portalType: "OR · Accela Citizen Access", portalUrl: "https://aca-prod.accela.com/CLACKAMAS/Welcome.aspx" },
  { portalType: "powerclerk_pge_nem_portal", portalUrl: "https://pgenm.powerclerk.com/MvcAccount/Login" },
  { portalType: "AZ · Citizenserve", portalUrl: "https://www4.citizenserve.com/az" },
];

const PORTLAND_OR = "https://devhub.portlandoregon.gov/";

check("THE LOOKALIKE: Portland, Maine surfaces when Portland, Oregon is wanted", () => {
  const near = nearestStoredLogins(STORED, PORTLAND_OR, "City of Portland");
  assert.ok(near.some((n) => /portlandmaine/i.test(n)), `expected the Maine login among ${JSON.stringify(near)}`);
});

check("...and it is offered as a CANDIDATE to check, never as a match", () => {
  // The function's whole contract: it ranks plausibility, it does not resolve a credential.
  // Nothing here returns a username or password.
  const near = nearestStoredLogins(STORED, PORTLAND_OR, "City of Portland");
  for (const n of near) assert.ok(typeof n === "string" && !/password|secret/i.test(n));
});

check("THE NOISE BUG: 'City' does not drag in every municipal host", () => {
  const near = nearestStoredLogins(STORED, PORTLAND_OR, "City of Portland");
  assert.ok(!near.some((n) => /sacramento/i.test(n)), `Sacramento matched on the word "City": ${JSON.stringify(near)}`);
  assert.ok(!near.some((n) => /boston/i.test(n)), `Boston matched on the word "City": ${JSON.stringify(near)}`);
});

check("the list is short enough to read", () => {
  const near = nearestStoredLogins(STORED, PORTLAND_OR, "City of Portland");
  assert.ok(near.length <= 4, `${near.length} entries — the point was to stop dumping the whole book`);
});

check("a same-system different-subdomain login ranks first", () => {
  // Two hosts sharing a distinctive label are far more likely to be the same system than
  // two that merely share a jurisdiction word.
  const near = nearestStoredLogins(
    [{ portalType: "OR · Accela", portalUrl: "https://aca-oregon.accela.com/oregon/" }, ...STORED],
    "https://aca-oregon.accela.com/CoosBay/Welcome.aspx",
    "City of Coos Bay",
  );
  assert.match(near[0], /aca-oregon/i);
});

check("nothing related yields an EMPTY list — which is itself the answer", () => {
  const near = nearestStoredLogins(STORED, "https://permits.exampletown.gov/apply", "Town of Exampleton");
  assert.deepEqual(near, []);
});

check("a client with no stored logins yields nothing and does not throw", () => {
  assert.deepEqual(nearestStoredLogins([], PORTLAND_OR, "City of Portland"), []);
});

check("an unparseable portal URL degrades instead of throwing", () => {
  assert.doesNotThrow(() => nearestStoredLogins(STORED, "not a url", "City of Portland"));
});

check("a stored row with no URL is tolerated", () => {
  assert.doesNotThrow(() => nearestStoredLogins([{ portalType: "Legacy", portalUrl: null }], PORTLAND_OR, "City of Portland"));
});

if (failures) { console.error(`\n${failures} credential-near-miss check(s) FAILED.`); process.exit(1); }
console.log("\nAll credential-near-miss checks passed.");
process.exit(0);
