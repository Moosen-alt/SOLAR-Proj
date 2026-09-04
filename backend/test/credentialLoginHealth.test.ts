// A STALE LOGIN LOOKS EXACTLY LIKE A BROKEN BOT.
//
// A learn run against OpenGov's Newberg portal found the right credential by host, revealed
// the login behind a link, filled it, submitted, and stopped with "Still on the login form
// after submitting — the stored username/password was likely rejected." All correct. And
// then the knowledge died with the run: nothing on the credential recorded that the portal
// had refused it, so the next person to touch Newberg would rediscover it from scratch.
//
// A service bureau holding 80+ logins for jurisdictions it files in a few times a year will
// always have some that have rotated or expired. Which ones is a fact worth keeping.
//
// Both outcomes are recorded, and that is the point of most of this test: a credential
// marked stale must un-mark itself the moment the portal accepts it again, or the refresh
// list fills up with logins that were fixed weeks ago and nobody trusts it.
//
// Browser-free. Run: tsx backend/test/credentialLoginHealth.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-login-health-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";

const { openDatabase } = await import("../src/db");
const { createPortalCredential, listPortalCredentials, listStaleCredentials, recordLoginOutcome } = await import("../src/portalCredentials");
const { createClient } = await import("../src/clients");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const CLIENT = createClient(db, { companyName: "Health Test Co" } as never).id;

const NEWBERG = "https://newbergor.portal.opengov.com/";
const COOSBAY = "https://aca-oregon.accela.com/oregon/";
createPortalCredential(db, CLIENT, { portalType: "OR · OpenGov", portalUrl: NEWBERG, username: "permit@example.com", password: "x" });
createPortalCredential(db, CLIENT, { portalType: "OR · Accela", portalUrl: COOSBAY, username: "installer", password: "y" });

const byUrl = (url: string) => listPortalCredentials(db, CLIENT).find((c) => c.portalUrl === url)!;

check("a fresh credential is not stale — nothing has been tried yet", () => {
  assert.equal(byUrl(NEWBERG).stale, false);
  assert.equal(listStaleCredentials(db, CLIENT).length, 0);
});

// ---------------------------------------------------------------------------
// The live case.
// ---------------------------------------------------------------------------
check("THE REGRESSION: a refused login marks THAT credential stale", () => {
  const hit = recordLoginOutcome(db, CLIENT, NEWBERG, {
    ok: false,
    note: "Still on the login form after submitting — the stored username/password was likely rejected.",
  });
  assert.equal(hit, true, "the outcome should have landed on a credential");
  assert.equal(byUrl(NEWBERG).stale, true);
});

check("...and keeps what the portal actually did, in the engine's words", () => {
  assert.match(String(byUrl(NEWBERG).lastLoginNote), /still on the login form/i);
  assert.ok(byUrl(NEWBERG).lastLoginFailedAt, "the failure needs a timestamp to compare against");
});

check("...while every OTHER login is left alone", () => {
  // Marking by host is what keeps this honest: one portal's rotation must not cast doubt
  // on the 80 others.
  assert.equal(byUrl(COOSBAY).stale, false);
  const stale = listStaleCredentials(db, CLIENT);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].portalUrl, NEWBERG);
});

// ---------------------------------------------------------------------------
// Un-marking. Without this the refresh list rots.
// ---------------------------------------------------------------------------
check("THE UN-MARK: a later success clears stale with no manual edit", () => {
  recordLoginOutcome(db, CLIENT, NEWBERG, { ok: true, note: "login accepted" });
  assert.equal(byUrl(NEWBERG).stale, false);
  assert.equal(listStaleCredentials(db, CLIENT).length, 0);
});

check("...and a fresh refusal after that success marks it stale again", () => {
  recordLoginOutcome(db, CLIENT, NEWBERG, { ok: false, note: "rejected again" });
  assert.equal(byUrl(NEWBERG).stale, true);
});

// ---------------------------------------------------------------------------
// Matching is by host, exactly as the credential was chosen in the first place.
// ---------------------------------------------------------------------------
check("an outcome for a portal we hold no login for lands nowhere", () => {
  const hit = recordLoginOutcome(db, CLIENT, "https://devhub.portlandoregon.gov/", { ok: false, note: "no credential" });
  assert.equal(hit, false, "there is no Portland credential to mark");
  assert.equal(listStaleCredentials(db, CLIENT).length, 1, "and nothing else should have been touched");
});

check("a different path on the SAME host still matches its credential", () => {
  // The learn's URL is rarely byte-identical to the stored one.
  const hit = recordLoginOutcome(db, CLIENT, "https://newbergor.portal.opengov.com/some/deep/path?x=1", { ok: true, note: "ok" });
  assert.equal(hit, true);
  assert.equal(byUrl(NEWBERG).stale, false);
});

check("garbage input is survived rather than thrown on", () => {
  assert.doesNotThrow(() => recordLoginOutcome(db, CLIENT, "not a url", { ok: false }));
  assert.doesNotThrow(() => recordLoginOutcome(db, "", NEWBERG, { ok: false }));
});

if (failures) { console.error(`\n${failures} credential-login-health check(s) FAILED.`); process.exit(1); }
console.log("\nAll credential-login-health checks passed.");
process.exit(0);
