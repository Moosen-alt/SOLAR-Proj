// ONCE A PORTAL HAS REFUSED THE LOGIN, STOP KNOCKING.
//
// We cannot detect a password change — the first sign is a failed filing. Re-attempting after that
// is how an account gets locked, and it is the operator's OWN account, under their licence. The
// `stale` flag has been correct for a long time (a later success clears it with nobody editing
// anything) but was consulted only by runLearnBenchmark, so every real stage kept knocking. There
// are 12 stale credentials on the live client right now.
//
//   MUST LOCK OUT  — a credential the portal refused, matched the way production matches a URL.
//   MUST NOT       — a credential that later SUCCEEDED (the flag clears itself); a DIFFERENT
//                    portal's credential; a client with nothing stored; and above all a run that
//                    failed because OUR BROWSER DIED rather than because the password was wrong —
//                    that mistake once recorded six credential failures and quietly retired seven
//                    working platforms.
//   AND            — prepareSubmission must actually consult it BEFORE opening a browser. A
//                    predicate nothing calls is the state this feature was already in.
//
//   npx tsx backend/test/credentialLockout.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-lockout-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createPortalCredential, recordLoginOutcome, lockedOutCredential } = await import("../src/portalCredentials");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const client = createClient(db, { companyName: "Lockout Solar", ccbLicenseNumber: "123456" });
const ACCELA = "https://aca-oregon.accela.com/oregon/";
const POWERCLERK = "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login";
createPortalCredential(db, client.id, { portalUrl: ACCELA, username: "u1", password: "p1" });
createPortalCredential(db, client.id, { portalUrl: POWERCLERK, username: "u2", password: "p2" });

check("a fresh credential is not locked out", () => {
  assert.equal(lockedOutCredential(db, client.id, ACCELA), null);
});

check("MUST LOCK OUT: after the portal refuses the login", () => {
  recordLoginOutcome(db, client.id, ACCELA, {
    ok: false,
    note: "Still on the login form after submitting — the stored username/password was likely rejected.",
  } as never);
  const hit = lockedOutCredential(db, client.id, ACCELA);
  assert.ok(hit, "a refused login must lock the portal out — repeated attempts are what locks an account");
  assert.equal(hit!.portalUrl, ACCELA);
});

check("MUST NOT: a DIFFERENT portal is untouched by that failure", () => {
  assert.equal(lockedOutCredential(db, client.id, POWERCLERK), null,
    "one portal refusing a login must not stop filings on every other portal");
});

check("MUST NOT: a later SUCCESS clears it, with no flag to reset by hand", () => {
  recordLoginOutcome(db, client.id, ACCELA, { ok: true, note: "signed in" } as never);
  assert.equal(lockedOutCredential(db, client.id, ACCELA), null);
});

check("MUST NOT: OUR BROWSER DYING is not the password being wrong", () => {
  // The regression this guard exists for: a killed benchmark wrote
  // "browserType.launchPersistentContext: Target page, context or browser has been closed" as a
  // LOGIN FAILURE against six real credentials, and the stale flag then skipped seven working
  // platforms on every later run. isHarnessAbort is what keeps that out of here.
  recordLoginOutcome(db, client.id, ACCELA, {
    ok: false,
    note: "browserType.launchPersistentContext: Target page, context or browser has been closed",
  } as never);
  assert.equal(lockedOutCredential(db, client.id, ACCELA), null,
    "a dead browser would retire a working portal — and this is how seven of them were retired once");
});

check("MUST NOT: a client with nothing stored is not locked out of everything", () => {
  const bare = createClient(db, { companyName: "No Creds LLC", ccbLicenseNumber: "999999" });
  assert.equal(lockedOutCredential(db, bare.id, ACCELA), null);
  assert.equal(lockedOutCredential(db, "", ACCELA), null);
  assert.equal(lockedOutCredential(db, client.id, ""), null);
});

check("THE WIRING: prepareSubmission consults it, and before a browser opens", () => {
  // A predicate nothing calls is exactly the state this feature was in for months — the flag was
  // right and only the benchmark read it. So the wiring is pinned, not just the function.
  const src = fs.readFileSync(path.join(process.cwd(), "backend", "src", "repository.ts"), "utf8");
  assert.match(src, /lockedOutCredential\(db, detail\.project\.clientId, credentialUrl\)/,
    "prepareSubmission does not consult the lockout at all");
  const at = src.indexOf("lockedOutCredential(db, detail.project.clientId, credentialUrl)");
  const launch = src.indexOf("autoLearnPortal(db, projectId", at);
  assert.ok(launch === -1 || launch > at,
    "the lockout must be checked BEFORE anything opens a browser, or it stops nothing");
  assert.match(src.slice(at, at + 1400), /credentialLockedOut: true/,
    "the refusal should be machine-readable so a caller can tell it from any other 409");
  assert.match(src.slice(at, at + 1400), /PORTAL_CREDENTIAL_LOCKOUT/,
    "there must be a way to switch it off on a machine where it gets in the way");
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\ncredentialLockout: all checks passed."
  : `\ncredentialLockout: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
