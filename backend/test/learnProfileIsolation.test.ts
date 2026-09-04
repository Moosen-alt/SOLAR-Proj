// ONE PORTAL'S COOKIES MUST NOT DECIDE WHAT THE NEXT PORTAL SHOWS US.
//
// autoLearnPortal built its browser profile path from portalType, which is the literal
// string "AHJ" or "utility". So every jurisdiction a client ever learned ran in ONE Chrome
// profile: eleven portals across eight platforms in the 2026-09-04 sweep, all sharing
// cookies, localStorage, service workers and consent state in a single 412 MB directory.
//
// For a tool whose promise is "point it at any portal and it learns", that is close to the
// worst possible default — the previous portal is an invisible input to the next one. It
// also forced every learn through one profile lease, so portals queued for no reason.
//
// The measured symptom: Washington County's Accela login form is detectable 1.2 seconds
// after navigation from a clean context, and the sweep still recorded "the portal's login
// form was not recognised".
//
// Browser-free. Run: tsx backend/test/learnProfileIsolation.test.ts
import assert from "node:assert/strict";
import { learnProfileName } from "../src/autoLearn";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

check("THE REGRESSION: two AHJ portals no longer share one profile", () => {
  const a = learnProfileName("AHJ", "https://pprmaca.co.washington.or.us/CitizenAccess/Welcome.aspx");
  const b = learnProfileName("AHJ", "https://cityofwilsonvilleor-energovweb.tylerhost.net/apps/selfservice#/home");
  assert.notEqual(a, b, "these are different portals on different platforms");
  assert.match(a, /washington/);
  assert.match(b, /tylerhost/);
});

check("...and the eleven portals of the sweep produce eleven distinct profiles", () => {
  const hosts = [
    "pprmaca.co.washington.or.us", "quincyma.portal.opengov.com", "co-franklin-oh.smartgovcommunity.com",
    "cityofwilsonvilleor-energovweb.tylerhost.net", "www4.citizenserve.com", "tukw-egov.aspgov.com",
    "momentum.princegeorgescountymd.gov", "bsaonline.com", "us.cloudpermit.com",
    "staridpermit.portal.iworq.net", "desmoines-wa.permittrax.com",
  ];
  const names = new Set(hosts.map((h) => learnProfileName("AHJ", `https://${h}/x`)));
  assert.equal(names.size, hosts.length, "every portal needs its own profile, or contamination returns");
});

check("the same portal keeps ONE profile across projects — the saved session is the point", () => {
  // Different homeowners, different query strings, same portal: a stored login and any
  // remembered-device state must survive, or every project re-triggers a device challenge.
  const one = learnProfileName("AHJ", "https://us.cloudpermit.com/gov/dashboard?project=123");
  const two = learnProfileName("AHJ", "https://us.cloudpermit.com/gov/applications/new");
  assert.equal(one, two);
});

check("a permit portal and a utility portal on the SAME host stay apart", () => {
  // The tracks are kept apart everywhere else in this codebase for good reason; a shared
  // profile would be a back door between them.
  assert.notEqual(
    learnProfileName("AHJ", "https://example.gov/portal"),
    learnProfileName("utility", "https://example.gov/portal"),
  );
});

check("www is not a distinguishing feature", () => {
  assert.equal(
    learnProfileName("AHJ", "https://www.citizenserve.com/x"),
    learnProfileName("AHJ", "https://citizenserve.com/x"),
  );
});

check("the name is filesystem-safe and bounded", () => {
  const n = learnProfileName("AHJ", `https://${"a".repeat(200)}.example.gov/x`);
  assert.ok(/^[a-z0-9-]+$/.test(n), `not path-safe: ${n}`);
  assert.ok(n.length <= 70, `too long for a path segment: ${n.length}`);
});

check("a URL we cannot parse falls back rather than bucketing everything together", () => {
  // "" as a directory name would put every unparseable portal in one profile — the exact
  // bug being fixed, wearing a different hat.
  assert.equal(learnProfileName("AHJ", "not a url"), "AHJ");
  assert.equal(learnProfileName("utility", ""), "utility");
});

if (failures) { console.error(`\n${failures} learn-profile-isolation check(s) FAILED.`); process.exit(1); }
console.log("\nAll learn-profile-isolation checks passed.");
process.exit(0);
