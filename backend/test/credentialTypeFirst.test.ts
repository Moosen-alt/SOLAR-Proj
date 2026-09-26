// B11 — A GENERIC portal_type ROW NEVER OUTRANKS THE PORTAL'S OWN URL.
//
// The learn's credential lookup took the newest row whose portal_type was literally "AHJ" BEFORE
// it looked at any URL (autoLearn.ts, getDecryptedCredential(db, client, "AHJ")), so an operator
// who typed "AHJ" into the free-text type field on Iowa City's login had Iowa City's password
// typed into Lee County's login. Now the URL decides first (host + first path segment); a typed
// row stands only when its own stored URL fits the target.
//
//   MUST-EXCLUDE: an "AHJ"-typed row for another tenant (newest) is not used for Lee County;
//                 an "AHJ"-typed row with NO stored URL is not used when the client holds others.
//   MUST-PASS:    the "AHJ"-typed row IS used for its own portal; a Lee row stored with no type is
//                 found by URL; the client's only credential on the target host still works.
//
//   npx tsx backend/test/credentialTypeFirst.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-type-first-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createPortalCredential, getDecryptedCredentialForPortal } = await import("../src/portalCredentials");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const touch = (username: string, at: string): void => { db.run("UPDATE portal_credentials SET updated_at = ? WHERE username_reference = ?", [at, username]); };

const IOWA = "https://egov.iowa-city.org/energovprod/selfservice";
const LEE = "https://aca-prod.accela.com/LEECO/Login.aspx";
const LEE_START = "https://aca-prod.accela.com/LEECO/Cap/CapApplyDisclaimer.aspx?module=Permitting&TabName=Permitting";

const a = createClient(db, { companyName: "Type First Solar", ccbLicenseNumber: "111111" });
createPortalCredential(db, a.id, { portalType: "", portalUrl: LEE, username: "lee-user", password: "lee-pw" });
createPortalCredential(db, a.id, { portalType: "AHJ", portalUrl: IOWA, username: "iowa-user", password: "iowa-pw" });
touch("lee-user", "2026-01-01T00:00:00.000Z");
touch("iowa-user", "2026-09-26T00:00:00.000Z"); // the generic-typed row is the NEWEST

check("MUST-EXCLUDE: Lee County's learn never gets the newest 'AHJ'-typed row stored for Iowa City", () => {
  const got = getDecryptedCredentialForPortal(db, a.id, "AHJ", LEE_START);
  assert.ok(got, "Lee's own row must be found by its URL");
  assert.equal(got!.username, "lee-user");
});
check("MUST-PASS: the 'AHJ'-typed row is still used for ITS OWN portal", () => {
  const got = getDecryptedCredentialForPortal(db, a.id, "AHJ", "https://egov.iowa-city.org/EnergovProd/selfservice#/home");
  assert.equal(got?.username, "iowa-user");
});
check("MUST-EXCLUDE: a portal with no matching row gets NOTHING — not the generic-typed row", () => {
  assert.equal(getDecryptedCredentialForPortal(db, a.id, "AHJ", "https://eg.carlsbadca.gov/energov_prod/selfservice#/home"), null);
});

const b = createClient(db, { companyName: "Typed No Url Solar", ccbLicenseNumber: "222222" });
createPortalCredential(db, b.id, { portalType: "AHJ", portalUrl: "", username: "typed-nourl", password: "x" });
createPortalCredential(db, b.id, { portalType: "", portalUrl: LEE, username: "b-lee", password: "y" });
touch("typed-nourl", "2026-09-26T00:00:00.000Z");
check("MUST-EXCLUDE: an 'AHJ'-typed row with no stored URL is not typed into Columbus when the client holds other logins", () => {
  assert.equal(getDecryptedCredentialForPortal(db, b.id, "AHJ", "https://portal.columbus.gov/permits/Welcome.aspx"), null);
});
check("MUST-PASS: and Lee County still gets its own row", () => {
  assert.equal(getDecryptedCredentialForPortal(db, b.id, "AHJ", LEE_START)?.username, "b-lee");
});

const c = createClient(db, { companyName: "Single Login Solar", ccbLicenseNumber: "333333" });
createPortalCredential(db, c.id, { portalType: "AHJ", portalUrl: "https://portal.columbus.gov/Permits/Welcome.aspx", username: "cbus", password: "z" });
check("MUST-PASS: the client's only credential, on the target's host, still logs in (case-insensitive segment)", () => {
  assert.equal(getDecryptedCredentialForPortal(db, c.id, "AHJ", "https://portal.columbus.gov/permits/Cap/CapApplyDisclaimer.aspx?module=Building")?.username, "cbus");
});
check("MUST-EXCLUDE: ...but never on another host", () => {
  assert.equal(getDecryptedCredentialForPortal(db, c.id, "AHJ", LEE_START), null);
});

check("the learn's real lookup is this function (autoLearn.ts no longer asks by portal_type first)", () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "../src/autoLearn.ts"), "utf8");
  assert.match(src, /getDecryptedCredentialForPortal\(db, project\.clientId, portalType, portalUrl\)/);
  assert.doesNotMatch(src, /getDecryptedCredential\(db, project\.clientId, portalType\)/);
});

db.close?.();
if (failures) { console.error(`\n${failures} credential type-first check(s) FAILED.`); process.exit(1); }
console.log("\nAll credential type-first checks passed.");
