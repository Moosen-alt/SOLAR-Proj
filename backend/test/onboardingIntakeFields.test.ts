// WHAT THE ONBOARDING GUIDE PROMISES TO COLLECT MUST HAVE SOMEWHERE TO GO.
//
// The customer-facing onboarding guide hands every new solar company an intake packet and
// says each item goes "straight onto permit and interconnection applications". Eight of the
// things it asks for had nowhere in the schema to land: whether a portal emails a one-time
// code at login and WHICH INBOX it goes to; who pays that portal's AHJ/utility fees; the
// shared inbox we send confirmations and corrections to; who receives our invoices; which
// state issued the contractor licence; and when the insurance and bond certificates expire.
//
// A promised field with no column is not "collected later". It is collected once, onto a
// spreadsheet, and then it is not there at run time — which is exactly the failure the
// onboarding kit exists to end. This test pins the columns, the round-trip through the
// credential API, and the vocabulary, in BOTH directions.
//
// And it kill-tests the thing that must never regress while that view grows: the credential
// view still cannot leak a password. Every field added here is non-secret ON PURPOSE (an
// inbox is who to ask for a code, never the code), so the view widening is the moment to
// re-pin it.
//
// Browser-free, scratch DB. Run: npx tsx backend/test/onboardingIntakeFields.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-intake-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";

const { openDatabase } = await import("../src/db");
const {
  createPortalCredential, updatePortalCredential, listPortalCredentials,
  mfaCodeDestinationFor, FEE_RESPONSIBILITY_VALUES,
} = await import("../src/portalCredentials");
const { createClient } = await import("../src/clients");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const columns = (table: string): string[] =>
  db.query<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);

// ---------------------------------------------------------------------------
// 1 · The migration.
// ---------------------------------------------------------------------------
check("migration v18 applied — portal_credentials carries the per-portal packet answers", () => {
  const cols = columns("portal_credentials");
  for (const c of ["mfa_required", "mfa_code_destination", "fee_responsibility"]) {
    assert.ok(cols.includes(c), `portal_credentials is missing ${c}`);
  }
});

check("...and clients carries the per-company ones", () => {
  const cols = columns("clients");
  for (const c of ["updates_inbox", "billing_contact_email", "license_state", "insurance_expiry", "bond_expiry"]) {
    assert.ok(cols.includes(c), `clients is missing ${c}`);
  }
});

check("...and v18 is recorded, so a second open does not replay it", () => {
  const row = db.get<{ name: string }>("SELECT name FROM schema_meta WHERE version = 18");
  assert.equal(row?.name, "onboarding_intake_packet_fields");
});

const CLIENT = createClient(db, { companyName: "Packet Test Solar" } as never).id;

// ---------------------------------------------------------------------------
// 2 · Per-credential round-trip. S3.6 "Emailed code at login? Which inbox?" and
//     S3.7 "who pays AHJ and utility fees, and how — agreed PER PORTAL at kickoff".
// ---------------------------------------------------------------------------
const AMEREN = "https://ameren.example.invalid/MvcAccount/Login";
const SMARTGOV = "https://smartgov.example.invalid/portal/";
const SECRET = "correct-horse-battery-staple-9713";

const created = createPortalCredential(db, CLIENT, {
  portalType: "IL · PowerClerk",
  portalUrl: AMEREN,
  username: "permits@packet.invalid",
  password: SECRET,
  mfaRequired: true,
  mfaCodeDestination: "permits@packet.invalid (shared inbox)",
  feeResponsibility: "mailed-check",
});

const byUrl = (url: string) => listPortalCredentials(db, CLIENT).find((c) => c.portalUrl === url)!;

check("THE GAP: a credential round-trips the MFA answer the packet asked for", () => {
  assert.equal(created.mfaRequired, true);
  assert.equal(created.mfaCodeDestination, "permits@packet.invalid (shared inbox)");
  assert.equal(byUrl(AMEREN).mfaRequired, true);
  assert.equal(byUrl(AMEREN).mfaCodeDestination, "permits@packet.invalid (shared inbox)");
});

check("...and the per-portal fee agreement (Ameren Illinois really is a mailed cheque)", () => {
  assert.equal(created.feeResponsibility, "mailed-check");
  assert.equal(byUrl(AMEREN).feeResponsibility, "mailed-check");
});

// A credential created with no MFA answer must read FALSE. This is not a formality: the
// column is INTEGER, and the idiom the rest of this view uses for TEXT columns —
// Boolean(text(row.x)) — turns the integer 0 into the string "0", which is truthy. Under
// that bug every portal on the fleet reports as MFA-gated and every operator goes hunting
// for a shared inbox that was never set up.
const plain = createPortalCredential(db, CLIENT, {
  portalType: "WA · SmartGov", portalUrl: SMARTGOV, username: "packet-solar", password: "another-secret",
});

check("THE TRAP: an unanswered MFA question reads false, not truthy-zero", () => {
  assert.equal(plain.mfaRequired, false, "mfa_required 0 must map to false");
  assert.equal(typeof plain.mfaRequired, "boolean");
  assert.equal(plain.mfaCodeDestination, "");
  assert.equal(plain.feeResponsibility, "", "'' must stay distinguishable from an agreement");
  assert.equal(byUrl(SMARTGOV).mfaRequired, false);
});

check("an update writes the answers a kickoff call produced", () => {
  updatePortalCredential(db, CLIENT, plain.id, {
    mfaRequired: true, mfaCodeDestination: "Dana relays the code (503-555-0100)", feeResponsibility: "customer-pays",
  });
  assert.equal(byUrl(SMARTGOV).mfaRequired, true);
  assert.equal(byUrl(SMARTGOV).mfaCodeDestination, "Dana relays the code (503-555-0100)");
  assert.equal(byUrl(SMARTGOV).feeResponsibility, "customer-pays");
});

check("...and an unrelated update leaves them EXACTLY alone", () => {
  // A re-run of a stripped intake file names portalType and nothing else. If absence read as
  // "false"/"", it would erase an MFA destination somebody spent a phone call establishing.
  updatePortalCredential(db, CLIENT, plain.id, { portalType: "WA · SmartGov (Citizen)" });
  const after = byUrl(SMARTGOV);
  assert.equal(after.portalType, "WA · SmartGov (Citizen)");
  assert.equal(after.mfaRequired, true);
  assert.equal(after.mfaCodeDestination, "Dana relays the code (503-555-0100)");
  assert.equal(after.feeResponsibility, "customer-pays");
});

check("an MFA answer can be withdrawn deliberately — false is settable, not just absent", () => {
  updatePortalCredential(db, CLIENT, plain.id, { mfaRequired: false, mfaCodeDestination: "" });
  assert.equal(byUrl(SMARTGOV).mfaRequired, false);
  assert.equal(byUrl(SMARTGOV).mfaCodeDestination, "");
  updatePortalCredential(db, CLIENT, plain.id, { mfaRequired: true, mfaCodeDestination: "Dana relays the code (503-555-0100)" });
});

// ---------------------------------------------------------------------------
// 3 · The fee vocabulary, BOTH directions. A filter that only proves what it rejects has
//     not been tested; one that only proves what it accepts has not either.
// ---------------------------------------------------------------------------
check("every agreed answer the guide names is accepted", () => {
  for (const value of FEE_RESPONSIBILITY_VALUES) {
    const row = createPortalCredential(db, CLIENT, {
      portalType: "vocab", portalUrl: `https://fee-${value}.example.invalid/`, username: "u", password: "p",
      feeResponsibility: value,
    });
    assert.equal(row.feeResponsibility, value);
  }
  // '' is a real state at kickoff day zero: asked, not yet agreed.
  const blank = createPortalCredential(db, CLIENT, {
    portalType: "vocab", portalUrl: "https://fee-blank.example.invalid/", username: "u", password: "p", feeResponsibility: "",
  });
  assert.equal(blank.feeResponsibility, "");
});

check("...and an answer nobody agreed to is REFUSED, not stored", () => {
  assert.throws(
    () => createPortalCredential(db, CLIENT, {
      portalType: "vocab", portalUrl: "https://fee-bogus.example.invalid/", username: "u", password: "p",
      feeResponsibility: "venmo",
    }),
    /feeResponsibility must be one of/,
  );
  const stored = listPortalCredentials(db, CLIENT).find((c) => c.portalUrl === "https://fee-bogus.example.invalid/");
  assert.equal(stored, undefined, "the refused create must not have written a row");
});

check("...on update too — the write path is not a back door round the vocabulary", () => {
  assert.throws(() => updatePortalCredential(db, CLIENT, plain.id, { feeResponsibility: "invoice them somehow" }), /feeResponsibility must be one of/);
  assert.equal(byUrl(SMARTGOV).feeResponsibility, "customer-pays", "the refused update must have changed nothing");
});

check("case and stray whitespace normalise rather than minting a second vocabulary", () => {
  updatePortalCredential(db, CLIENT, plain.id, { feeResponsibility: "  Card-On-File " });
  assert.equal(byUrl(SMARTGOV).feeResponsibility, "card-on-file");
  updatePortalCredential(db, CLIENT, plain.id, { feeResponsibility: "customer-pays" });
});

// ---------------------------------------------------------------------------
// 4 · THE KILL-TEST. The view grew; it must still be impossible to read a password out of it.
// ---------------------------------------------------------------------------
check("THE INVARIANT: the credential view exposes hasSecret and never the secret", () => {
  const view = byUrl(AMEREN);
  assert.equal(view.hasSecret, true, "the envelope is there");
  const serialised = JSON.stringify(view);
  assert.ok(!serialised.includes(SECRET), "the password must not be reachable through the view");
  assert.ok(!serialised.includes("encrypted_secret"), "nor the raw column name/blob");
  assert.ok(!/"password"|"securityAnswers"|"encryptedSecret"/.test(serialised), "no secret-bearing key on the view at all");
});

check("...including the whole list, and after an MFA-only update re-maps the row", () => {
  updatePortalCredential(db, CLIENT, created.id, { mfaCodeDestination: "ops@packet.invalid" });
  const serialised = JSON.stringify(listPortalCredentials(db, CLIENT));
  assert.ok(!serialised.includes(SECRET), "listing every credential must not surface one");
  assert.ok(!serialised.includes("another-secret"));
  assert.equal(byUrl(AMEREN).hasSecret, true, "and the envelope survived the non-secret update");
});

// ---------------------------------------------------------------------------
// 5 · Where the code arrives, for a run that pauses. Resolved the SAME way the password was
//     chosen, so the hint describes the account actually being logged into.
// ---------------------------------------------------------------------------
check("a paused run can name the inbox the code goes to", () => {
  assert.equal(mfaCodeDestinationFor(db, CLIENT, AMEREN), "ops@packet.invalid");
  assert.equal(mfaCodeDestinationFor(db, CLIENT, `${AMEREN}?returnUrl=%2F`), "ops@packet.invalid", "a different path on the same host is the same account");
});

check("...and says nothing rather than naming the WRONG inbox", () => {
  // One Accela host serves many cities by first path segment. A neighbour's inbox is not a
  // near-miss worth printing — it sends the operator to a mailbox they cannot read, for a
  // code that was never sent there.
  createPortalCredential(db, CLIENT, {
    portalType: "OR · Accela", portalUrl: "https://aca-prod.example.invalid/sandiego/", username: "sd", password: "p",
    mfaRequired: true, mfaCodeDestination: "sandiego-permits@packet.invalid",
  });
  assert.equal(mfaCodeDestinationFor(db, CLIENT, "https://aca-prod.example.invalid/sandiego/x"), "sandiego-permits@packet.invalid");
  assert.equal(mfaCodeDestinationFor(db, CLIENT, "https://aca-prod.example.invalid/sacramento/"), "", "a different jurisdiction segment is a different account");
  assert.equal(mfaCodeDestinationFor(db, CLIENT, "https://nothing-stored.example.invalid/"), "", "we were never told");
  assert.doesNotThrow(() => mfaCodeDestinationFor(db, CLIENT, "not a url"));
});

// ---------------------------------------------------------------------------
// 6 · Per-client columns. Read and written by COLUMN NAME on purpose — clients.ts belongs to
//     another agent, and the column name is the whole of the contract between us.
// ---------------------------------------------------------------------------
check("the client columns round-trip, and updates_inbox is NOT business_email", () => {
  db.run(
    `UPDATE clients SET business_email = ?, updates_inbox = ?, billing_contact_email = ?,
       license_state = ?, insurance_expiry = ?, bond_expiry = ? WHERE id = ?`,
    [
      "permits@packet.invalid", "keelix-updates@packet.invalid", "ap@packet.invalid",
      "OR", "2027-03-31", "2027-06-30", CLIENT,
    ],
  );
  const row = db.get<Record<string, unknown>>("SELECT * FROM clients WHERE id = ?", [CLIENT])!;
  assert.equal(row.updates_inbox, "keelix-updates@packet.invalid");
  assert.equal(row.billing_contact_email, "ap@packet.invalid");
  assert.equal(row.license_state, "OR");
  assert.equal(row.insurance_expiry, "2027-03-31");
  assert.equal(row.bond_expiry, "2027-06-30");
  // The distinction the guide draws, and the reason this is a separate column: business_email
  // is the installer address that goes ON the application (the AHJ mails corrections there),
  // updates_inbox is where WE send confirmations and status. They are different addresses and
  // the customer must be able to change one without changing the other.
  assert.notEqual(row.updates_inbox, row.business_email);
});

check("...and a client created before v18 reads '' rather than NULL", () => {
  const fresh = createClient(db, { companyName: "Never Onboarded Co" } as never).id;
  const row = db.get<Record<string, unknown>>("SELECT * FROM clients WHERE id = ?", [fresh])!;
  for (const c of ["updates_inbox", "billing_contact_email", "license_state", "insurance_expiry", "bond_expiry"]) {
    assert.equal(row[c], "", `${c} should default to '' so callers never have to null-check`);
  }
});

// ---------------------------------------------------------------------------
// 7 · The packet the operator actually sends. Every REQUIRED item in the guide must have a
//     key here, or the operator is back to a spreadsheet — which is the whole point.
// ---------------------------------------------------------------------------
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const templatePath = path.join(repoRoot, "docs", "onboarding", "intake-template.json");
let template: Record<string, unknown> = {};

check("the intake template still parses as JSON", () => {
  template = JSON.parse(fs.readFileSync(templatePath, "utf8")) as Record<string, unknown>;
  assert.ok(template.client && typeof template.client === "object");
  assert.ok(Array.isArray(template.portalCredentials) && (template.portalCredentials as unknown[]).length > 0);
});

check("every REQUIRED item in the guide's company/licensing packet has a home", () => {
  const client = template.client as Record<string, unknown>;
  const required = [
    "legalBusinessName",          // S3.1 * — what goes on the permit
    "contactName", "contactEmail", // S3.1 * — "where AHJs send corrections"
    "businessPhone", "businessAddress", // S3.1 *
    "updatesInbox",               // S3.1 * — "a shared inbox, not one person's"  (G3)
    "ccbLicenseNumber", "licenseState", // S3.2 * — the number AND its issuing state (G5)
    "authorizedSignerName", "authorizedSignerTitle", // S3.2 *
    "standardDisconnectMake", "standardDisconnectModel", // S3.4 * — plan sets list only the rating
    "billingContactEmail",        // S3.7 — "who receives Keelix invoices"          (G4)
    "insuranceExpiry", "bondExpiry", // S3.3 — certificates "with expiry dates"     (G6)
  ];
  const missing = required.filter((k) => !(k in client));
  assert.deepEqual(missing, [], `intake-template.json client block is missing: ${missing.join(", ")}`);
});

check("...and every portal account carries S3.6's and S3.7's per-portal answers", () => {
  const creds = template.portalCredentials as Array<Record<string, unknown>>;
  for (const [i, cred] of creds.entries()) {
    for (const key of ["portalType", "portalUrl", "username", "mfaRequired", "mfaCodeDestination", "feeResponsibility"]) {
      assert.ok(key in cred, `portalCredentials[${i}] is missing ${key}`);
    }
    assert.equal(typeof cred.mfaRequired, "boolean", `portalCredentials[${i}].mfaRequired must be a boolean`);
    const fee = String(cred.feeResponsibility ?? "");
    assert.ok(
      fee === "" || (FEE_RESPONSIBILITY_VALUES as readonly string[]).includes(fee),
      `portalCredentials[${i}].feeResponsibility "${fee}" is outside the vocabulary the code accepts`,
    );
  }
});

check("the template's placeholders are still obviously fake", () => {
  const raw = fs.readFileSync(templatePath, "utf8");
  const creds = template.portalCredentials as Array<Record<string, unknown>>;
  for (const cred of creds) {
    assert.match(String(cred.password), /REPLACE-ME/, "a template password must never look usable");
    assert.match(String(cred.portalUrl), /\.invalid\//, "template URLs must be unresolvable");
  }
  const client = template.client as Record<string, unknown>;
  for (const key of ["contactEmail", "businessEmail", "updatesInbox", "billingContactEmail"]) {
    assert.match(String(client[key]), /\.invalid$/, `${key} must use the reserved .invalid TLD`);
  }
  // A real secret pasted over a placeholder and committed is the failure the template's own
  // header warns about; this is the cheap net under it.
  assert.ok(!/BEGIN (RSA |EC )?PRIVATE KEY/.test(raw));
});

check("the checklist documents the packet's new items", () => {
  const md = fs.readFileSync(path.join(repoRoot, "docs", "onboarding", "INTAKE_CHECKLIST.md"), "utf8");
  for (const key of ["updatesInbox", "billingContactEmail", "licenseState", "insuranceExpiry", "bondExpiry", "mfaRequired", "mfaCodeDestination", "feeResponsibility"]) {
    assert.ok(md.includes(key), `INTAKE_CHECKLIST.md never mentions ${key} — an operator asked for it would not know why`);
  }
  // The guide says EIN is "sent securely" and passwords go by one-time link or phone, never
  // by email/text/chat. The checklist is where the operator reads that before the call.
  assert.match(md, /never (by |through )?(email|the file)/i);
});

if (failures) { console.error(`\n${failures} onboarding-intake-field check(s) FAILED.`); process.exit(1); }
console.log("\nAll onboarding-intake-field checks passed.");
process.exit(0);
