// THE ONE-TIME SECURE LINK MUST BE A WRITE-ONLY, SINGLE-USE, EXPIRING DROP BOX.
//
// The onboarding guide (§4) promises customers: "Send them through the one-time secure link
// we provide... Never by email, text or chat." A link that echoes what it received, or that
// works twice, or that never expires, is worse than no link — it is the forbidden channel
// with a nicer URL.
//
//   MUST PASS    — a password submitted through the link lands ENCRYPTED via the ordinary
//                  credential writer, and the portal is then usable.
//   MUST NOT     — the secret appears in any response or in the public view; the link works a
//                  second time; an expired link works; a token-holder adds a portal we never
//                  asked about.
//
//   npx tsx backend/test/credentialRequest.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "credreq-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "credreq-test-key-not-a-real-secret-0123456789";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createCredentialRequest, getCredentialRequestPublic, submitCredentialRequest, listCredentialRequests } =
  await import("../src/credentialRequests");
const { listPortalCredentials, getDecryptedCredentialByUrl } = await import("../src/portalCredentials");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const db = await openDatabase();
const client = createClient(db, { companyName: "ZZ Secure Link Test LLC" });

const PORTAL_URL = "https://aca-oregon.accela.com/oregon/";
const SECRET = "ZZ-not-a-real-password-9f3a";

const req = createCredentialRequest(db, client.id, [
  { portalType: "OR · Accela (Coos Bay)", portalUrl: PORTAL_URL },
], { createdBy: "test", ttlHours: 72 });

check("the link is minted with a long opaque token and an expiry", () => {
  assert.ok(req.token.length >= 32, `token is only ${req.token.length} chars`);
  assert.ok(Date.parse(req.expiresAt) > Date.now(), "no future expiry");
});

check("the public view shows WHICH portals we ask about, and nothing else", () => {
  const pub = getCredentialRequestPublic(db, req.token);
  assert.equal(pub.portals.length, 1);
  assert.equal(pub.portals[0].portalUrl, PORTAL_URL);
  const json = JSON.stringify(pub);
  assert.ok(!/password|secret|username/i.test(json),
    `the public payload carries credential fields: ${json}`);
});

const result = submitCredentialRequest(db, req.token, [
  { portalType: "OR · Accela (Coos Bay)", portalUrl: PORTAL_URL, username: "ops@zz.invalid", password: SECRET,
    mfaRequired: true, mfaCodeDestination: "permits@zz.invalid", feeResponsibility: "customer-pays" },
]);

check("MUST NOT: the submission response never echoes the secret", () => {
  const json = JSON.stringify(result);
  assert.ok(!json.includes(SECRET), `the password came back in the response: ${json}`);
  assert.equal(result.count, 1);
  assert.equal(result.stored[0].username, "ops@zz.invalid");
});

check("MUST PASS: the credential is stored, encrypted, and decrypts to what was sent", () => {
  const creds = listPortalCredentials(db, client.id);
  assert.equal(creds.length, 1, "credential not stored");
  assert.equal(creds[0].hasSecret, true);
  assert.ok(!JSON.stringify(creds).includes(SECRET), "the credential VIEW leaked the secret");
  const dec = getDecryptedCredentialByUrl(db, client.id, PORTAL_URL);
  assert.ok(dec, "stored credential does not resolve by URL");
  assert.equal((dec as { password?: string }).password, SECRET, "decrypted secret does not match what was submitted");
});

check("the MFA and fee answers the guide asks for ride along", () => {
  const c = listPortalCredentials(db, client.id)[0] as unknown as Record<string, unknown>;
  assert.equal(c.mfaRequired, true, "mfaRequired not stored — §3.6 asks 'Emailed code at login?'");
  assert.equal(c.mfaCodeDestination, "permits@zz.invalid", "§3.6 asks 'Which inbox?'");
  assert.equal(c.feeResponsibility, "customer-pays", "§3.7 fee responsibility not stored");
});

check("MUST NOT: the link is spent — a second read is refused", () => {
  assert.throws(() => getCredentialRequestPublic(db, req.token), /no longer valid/i,
    "a forwarded link still opens after it was used");
});

check("MUST NOT: a second submission is refused", () => {
  assert.throws(() => submitCredentialRequest(db, req.token, [
    { portalType: "OR · Accela (Coos Bay)", portalUrl: PORTAL_URL, username: "attacker@zz.invalid", password: "x" },
  ]), /no longer valid/i);
  assert.equal(listPortalCredentials(db, client.id).length, 1, "a second credential was written through a spent link");
});

check("MUST NOT: an expired link is refused", () => {
  const expired = createCredentialRequest(db, client.id, [{ portalType: "x", portalUrl: "https://x.invalid/" }]);
  db.run("UPDATE credential_requests SET expires_at = ? WHERE token = ?",
    [new Date(Date.now() - 60_000).toISOString(), expired.token]);
  assert.throws(() => getCredentialRequestPublic(db, expired.token), /no longer valid/i);
});

check("MUST NOT: a token-holder cannot add a portal we never asked about", () => {
  const r2 = createCredentialRequest(db, client.id, [{ portalType: "asked", portalUrl: "https://asked.invalid/" }]);
  assert.throws(() => submitCredentialRequest(db, r2.token, [
    { portalType: "NOT asked", portalUrl: "https://evil.invalid/", username: "u", password: "p" },
  ]), /not part of this request/i);
});

check("an unknown token is refused with the same message as a spent one", () => {
  assert.throws(() => getCredentialRequestPublic(db, "0".repeat(64)), /no longer valid/i,
    "a distinct error would tell a prober which tokens exist");
});

check("the operator listing never contains the token itself", () => {
  const list = listCredentialRequests(db, client.id);
  assert.ok(list.length >= 2);
  assert.ok(!JSON.stringify(list).includes(req.token), "the operator listing leaks the live token");
});

console.log(failures === 0
  ? "\nAll credential-request checks passed."
  : `\n${failures} credential-request check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
