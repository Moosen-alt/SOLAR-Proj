// B4 — WHO THE BOT MAY E-SIGN AS: THE PROJECT'S OWN CLIENT'S AUTHORIZED SIGNER, NOTHING ELSE.
//
// Operator ruling 2026-09-26 ("This is fine. Push it to the review page."): the learner may type
// an EnerGov e-signature on the draft, as the client record's authorized signer only. The value
// is read from the client row itself (learnSignerName), not from projectFields — which layers the
// parser snapshot under the client overlay, so a plan-set contact could stand in for a signer.
//
//   MUST-PASS:    a client with an authorized signer -> that name (written through createClient /
//                 updateClient, the real write path).
//   MUST-EXCLUDE: a client with only a CONTACT name -> "" (the contact is not the signer); a project
//                 with no client -> ""; another client's signer is never returned; a signer that
//                 is cleared on the client -> "".
//
//   npx tsx backend/test/learnSignerName.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-signer-name-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createClient, updateClient } = await import("../src/clients");
const { learnSignerName } = await import("../src/autoLearn");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const keel = createClient(db, { companyName: "Keel Test Solar", contactName: "Casey Contact", authorizedSignerName: "  Dana   Signer " });
const other = createClient(db, { companyName: "Other Solar", contactName: "Olive Other", authorizedSignerName: "Oscar Other" });
const contactOnly = createClient(db, { companyName: "Contact Only Solar", contactName: "Connie Contact" });

check("MUST-PASS the project's client's authorized signer, whitespace tidied", () => {
  assert.equal(learnSignerName(db, { clientId: keel.id }), "Dana Signer");
});
check("MUST-EXCLUDE a client with only a contact name has no signer (the contact does not sign)", () => {
  assert.equal(learnSignerName(db, { clientId: contactOnly.id }), "");
});
check("MUST-EXCLUDE a project with no client has no signer", () => {
  assert.equal(learnSignerName(db, { clientId: null } as never), "");
  assert.equal(learnSignerName(db, { clientId: "no-such-client" }), "");
});
check("MUST-EXCLUDE another client's signer is never returned", () => {
  assert.notEqual(learnSignerName(db, { clientId: keel.id }), "Oscar Other");
  assert.equal(learnSignerName(db, { clientId: other.id }), "Oscar Other");
});
check("MUST-EXCLUDE a signer cleared on the client is gone at once", () => {
  updateClient(db, keel.id, { authorizedSignerName: "" });
  assert.equal(learnSignerName(db, { clientId: keel.id }), "");
});

if (failures) { console.error(`\n${failures} learn-signer-name check(s) FAILED.`); process.exit(1); }
console.log("\nAll learn-signer-name checks passed.");
process.exit(0);
