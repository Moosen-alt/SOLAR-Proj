// ONBOARDING KEEPS ITS ANSWERS.
//
// Found 2026-09-24 (DAY1-OF-100 blocker 12): scripts/onboard-company.ts never read
// feeResponsibility or mfaRequired from the intake, although the shipped intake template has
// asked for both since migration v18. Unknown keys inside a portalCredentials[] entry were
// dropped with NO warning, so every one of the 20 credential rows on the machine read
// "fees NOT AGREED" in the coverage report while the customer had answered on the call. The REST
// routes had the same hole one layer down: zod strips undeclared keys, so a POST/PUT carrying the
// answers returned 201/200 and stored nothing.
//
// This drives the REAL script as a child process (the write path an operator uses) against a
// scratch DB in an isolated cwd, so the script's `dotenv/config` can never pick up the live .env.
//
//   MUST-PASS    the answers land on create; a change is reported and written; a re-run is
//                "unchanged"; the REST schemas keep the three keys.
//   MUST-EXCLUDE an intake that OMITS the keys must not blank a stored agreement; a typo'd fee is
//                refused with nothing written; "yes" is not a boolean; a real PUBLIC_BASE_URL
//                raises no dead-link warning.
//
// Kill test: ONBOARD_SCRIPT=<path to the pre-fix script> makes this fail.
// Run: npx tsx backend/test/onboardKeepsAnswers.test.ts
import { REPO, ISOLATED_CWD } from "./_isolate";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dbPath = path.join(ISOLATED_CWD, "onboard.sqlite");
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SESSION_ENCRYPTION_KEY = "unit-test-key-not-a-real-secret";

const { openDatabase } = await import("../src/db");
const { listPortalCredentials, createPortalCredential } = await import("../src/portalCredentials");
const { validate, portalCredentialCreateSchema, portalCredentialUpdateSchema } = await import("../src/validation");
const db = await openDatabase();

const SCRIPT = process.env.ONBOARD_SCRIPT || path.join(REPO, "scripts", "onboard-company.ts");
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const SMARTGOV = "https://permits.example-city.invalid/portal/";
const POWERCLERK = "https://interconnect.example-utility.invalid/MvcAccount/Login";

type Cred = Record<string, unknown>;
const intake = (creds: Cred[]): Record<string, unknown> => ({
  client: {
    companyName: "Keepanswers Solar Co",
    contactEmail: "office@keepanswers.invalid",
    ccbLicenseNumber: "123456",
    businessAddress: "1 Test Way", businessCity: "Salem", businessState: "OR", businessZip: "97301",
    businessPhone: "503-555-0100", businessEmail: "permits@keepanswers.invalid", authorizedSignerName: "Pat Test",
  },
  portalCredentials: creds,
});
const fullCreds = (): Cred[] => [
  { portalType: "OR · SmartGov", portalUrl: SMARTGOV, username: "ka-permits", password: "pw-one",
    mfaRequired: false, mfaCodeDestination: "", feeResponsibility: "card-on-file", notes: "" },
  { portalType: "OR · PowerClerk", portalUrl: POWERCLERK, username: "ka-nem", password: "pw-two",
    mfaRequired: true, mfaCodeDestination: "shared inbox permits@keepanswers.invalid", feeResponsibility: "mailed-check", notes: "" },
];

let n = 0;
function run(body: Record<string, unknown>, flags: string[] = [], env: Record<string, string> = {}): { code: number; out: string } {
  const file = path.join(ISOLATED_CWD, `intake-${++n}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  const r = spawnSync(process.execPath, [TSX, SCRIPT, file, "--db", dbPath, ...flags], {
    cwd: ISOLATED_CWD, // no .env here — the script's dotenv/config finds nothing live
    env: { ...process.env, AUTOPILOT_DB_PATH: dbPath, PUBLIC_BASE_URL: "http://localhost:4173", ...env },
    encoding: "utf8", timeout: 120_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const clientId = (): string => String(db.get<{ id: string }>("SELECT id FROM clients WHERE company_name = ?", ["Keepanswers Solar Co"])?.id ?? "");
const byUrl = (url: string) => listPortalCredentials(db, clientId()).find((c) => c.portalUrl === url);

// ---------------------------------------------------------------------------
console.log("onboard-company: the dry run reports the answers and writes nothing");
const dry = run(intake(fullCreds()), ["--dry-run"]);
check("dry run exits 0", () => assert.equal(dry.code, 0, dry.out.slice(-1500)));
check("dry run prints each portal's fee answer", () => {
  assert.match(dry.out, /fees\s+card-on-file/);
  assert.match(dry.out, /fees\s+mailed-check/);
});
check("dry run prints the MFA answer (destination as set/missing, never the value)", () => {
  assert.match(dry.out, /mfa\s+required\s+code destination set/);
  assert.match(dry.out, /mfa\s+not required/);
  assert.ok(!dry.out.includes("shared inbox permits@keepanswers.invalid"), "the destination value must not be printed");
});
check("dry run wrote nothing", () => {
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_credentials")?.n, 0);
});
check("localhost PUBLIC_BASE_URL is called out as dead links", () => {
  assert.match(dry.out, /PUBLIC_BASE_URL\s+http:\/\/localhost:4173 — customer links will be DEAD/);
});

console.log("onboard-company: the real run stores them");
const real = run(intake(fullCreds()));
check("real run exits 0", () => assert.equal(real.code, 0, real.out.slice(-1500)));
check("SmartGov stored card-on-file, no MFA", () => {
  const c = byUrl(SMARTGOV);
  assert.ok(c, "credential missing");
  assert.equal(c.feeResponsibility, "card-on-file");
  assert.equal(c.mfaRequired, false);
});
check("PowerClerk stored mailed-check, MFA required, destination kept", () => {
  const c = byUrl(POWERCLERK);
  assert.ok(c, "credential missing");
  assert.equal(c.feeResponsibility, "mailed-check");
  assert.equal(c.mfaRequired, true);
  assert.equal(c.mfaCodeDestination, "shared inbox permits@keepanswers.invalid");
});

console.log("onboard-company: re-runs");
const again = run(intake(fullCreds()), ["--dry-run"]);
check("an identical re-run is unchanged for every credential", () => {
  assert.equal(again.code, 0, again.out.slice(-1500));
  assert.match(again.out, /Nothing written\. 0 row\(s\)\/grant\(s\) would be created or changed\./);
});

// MUST-EXCLUDE: an intake with the secrets stripped and the answers OMITTED keeps what is stored.
const stripped = fullCreds().map((c) => ({ portalType: c.portalType, portalUrl: c.portalUrl, username: c.username, notes: "" }));
const keep = run(intake(stripped));
check("omitting the keys on a re-run exits 0", () => assert.equal(keep.code, 0, keep.out.slice(-1500)));
check("...and keeps every stored answer (no blanking to 'not agreed' / MFA off)", () => {
  assert.equal(byUrl(SMARTGOV)?.feeResponsibility, "card-on-file");
  assert.equal(byUrl(POWERCLERK)?.feeResponsibility, "mailed-check");
  assert.equal(byUrl(POWERCLERK)?.mfaRequired, true);
  assert.equal(byUrl(POWERCLERK)?.mfaCodeDestination, "shared inbox permits@keepanswers.invalid");
});
check("...and says so in the report", () => assert.match(keep.out, /fees\s+not in intake — stored answer kept/));

// A changed answer is reported by name and written.
const changed = fullCreds();
changed[0] = { ...changed[0], password: "", feeResponsibility: "Customer-Pays " };
const upd = run(intake(changed));
check("a changed fee answer exits 0 with a blank password (plain column, no envelope rewrite)", () => assert.equal(upd.code, 0, upd.out.slice(-1500)));
check("...is reported as a feeResponsibility update", () => assert.match(upd.out, /to update\s+feeResponsibility/));
check("...and is stored normalised", () => assert.equal(byUrl(SMARTGOV)?.feeResponsibility, "customer-pays"));

// MUST-EXCLUDE: a value outside the vocabulary is an intake problem, nothing written.
const bad = fullCreds();
bad[1] = { ...bad[1], feeResponsibility: "venmo" };
const refused = run(intake(bad));
check("a fee outside the vocabulary exits 1", () => assert.equal(refused.code, 1, refused.out.slice(-1500)));
check("...names the field", () => assert.match(refused.out, /feeResponsibility "venmo"/));
check("...and changed nothing", () => assert.equal(byUrl(POWERCLERK)?.feeResponsibility, "mailed-check"));

const yes = fullCreds();
yes[0] = { ...yes[0], mfaRequired: "no" };
const notBool = run(intake(yes), ["--dry-run"]);
check("mfaRequired as a string is refused (\"no\" is truthy)", () => {
  assert.equal(notBool.code, 1, notBool.out.slice(-1500));
  assert.match(notBool.out, /mfaRequired .* must be true or false/);
});

const typo = fullCreds();
typo[0] = { ...typo[0], feeResponsibilty: "card-on-file" };
const typoRun = run(intake(typo), ["--dry-run"]);
check("an unknown key inside a credential is warned about, not silently dropped", () => {
  assert.equal(typoRun.code, 0, typoRun.out.slice(-1500));
  assert.match(typoRun.out, /portalCredentials\[0\]\.feeResponsibilty .* is not a credential field/);
});

const goodBase = run(intake(fullCreds()), ["--dry-run"], { PUBLIC_BASE_URL: "https://autopilot.keepanswers.invalid" });
check("a real PUBLIC_BASE_URL raises no dead-link warning", () => {
  assert.equal(goodBase.code, 0, goodBase.out.slice(-1500));
  assert.doesNotMatch(goodBase.out, /customer links will be DEAD/);
  assert.doesNotMatch(goodBase.out, /PUBLIC_BASE_URL is /);
});

// ---------------------------------------------------------------------------
console.log("REST schemas keep the answers");
check("create schema keeps mfaRequired / mfaCodeDestination / feeResponsibility", () => {
  const body = validate(portalCredentialCreateSchema, {
    portalType: "x", portalUrl: "https://rest.example.invalid/", username: "u", password: "p",
    mfaRequired: true, mfaCodeDestination: "ops inbox", feeResponsibility: "keelix-pays",
  });
  assert.equal(body.mfaRequired, true);
  assert.equal(body.mfaCodeDestination, "ops inbox");
  assert.equal(body.feeResponsibility, "keelix-pays");
  // The route body, verbatim: validate, then createPortalCredential.
  const made = createPortalCredential(db, clientId(), body);
  assert.equal(made.feeResponsibility, "keelix-pays");
  assert.equal(made.mfaRequired, true);
});
check("update schema keeps them, and an omitted key stays omitted", () => {
  const body = validate(portalCredentialUpdateSchema, { feeResponsibility: "customer-pays" });
  assert.equal(body.feeResponsibility, "customer-pays");
  assert.ok(!("mfaRequired" in body), "an omitted mfaRequired must not appear (it would reset the stored answer)");
});
check("a non-vocabulary fee still 400s at the one gate (createPortalCredential)", () => {
  const body = validate(portalCredentialCreateSchema, {
    portalUrl: "https://rest2.example.invalid/", username: "u", password: "p", feeResponsibility: "venmo",
  });
  assert.throws(() => createPortalCredential(db, clientId(), body), /feeResponsibility must be one of/);
});
check("mfaRequired must be a boolean at the REST edge too", () => {
  assert.throws(() => validate(portalCredentialCreateSchema, { username: "u", password: "p", mfaRequired: "yes" }), /mfaRequired/);
});

db.close();
if (failures) { console.error(`\n${failures} onboarding-answer check(s) FAILED.`); process.exit(1); }
console.log("\nAll onboarding-answer checks passed.");
