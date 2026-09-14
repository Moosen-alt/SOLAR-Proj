// SETTING THE AGREEMENT ON EVERY PORTAL MADE IT UNRESOLVABLE.
//
// feeResponsibilityNow finds which agreement applies to a track in two steps:
//
//   1. the portal the submission FILED THROUGH — submissions.portal_profile_id -> portal_url
//   2. failing that, "exactly one credential states an agreement, so it is unambiguous"
//
// On the live database step 1 never fires: portal_profile_id is NULL on every submission, because
// a filing marked by hand (markTrackSubmitted) inserts null there and the staged runs did too. So
// everything fell to step 2 — which worked only while exactly ONE credential had an agreement.
//
// The moment all 83 credentials were set to keelix-pays, step 2 went from "one, unambiguous" to
// "83, ambiguous" and correctly returned "". Recording a real fee then stamped a blank agreement,
// and the invoice refused it: "no fee responsibility was on file when it was entered". Setting
// the agreement everywhere made the answer less available, not more.
//
// permit_check_targets.portal_url is the missing evidence. It IS populated — by markTrackSubmitted
// and by staging — it is per TRACK, and it is a recorded fact about the door the filing went
// through rather than a prediction made today.
//
//   MUST RESOLVE — from the track's own recorded portal, matching the stored credential for it.
//   MUST NOT     — let a permit track inherit the UTILITY portal's agreement (safety rule 5), even
//                  though both sit on the same project and both credentials state one.
//   MUST REFUSE  — when nothing records a portal and several credentials disagree. An arbitrary
//                  pick is a statement about whose money it was.
//
//   npx tsx backend/test/feeResponsibilityResolve.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-responsibility-resolve-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createPortalCredential } = await import("../src/portalCredentials");
const { createProject } = await import("../src/repository");
const { feeResponsibilityNow } = await import("../src/submissionFees");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const ACCELA = "https://aca-oregon.accela.com/oregon/";
const POWERCLERK = "https://pacificorpnetmetering.powerclerk.com/";

const client = createClient(db, { companyName: "Resolve Solar", ccbLicenseNumber: "919191" });
// BOTH portals carry an agreement, and they DISAGREE — which is the live shape after the
// agreement was recorded across the whole credential set, and the case the old fallback cannot
// answer. It is also what makes the safety-rule-5 check below meaningful.
createPortalCredential(db, client.id, {
  portalType: "OR · Coos Bay", portalUrl: ACCELA, username: "permits@resolve.invalid",
  password: "not-a-real-password", feeResponsibility: "keelix-pays",
});
createPortalCredential(db, client.id, {
  portalType: "PacifiCorp NEM", portalUrl: POWERCLERK, username: "nem@resolve.invalid",
  password: "not-a-real-password", feeResponsibility: "customer-pays",
});

const { project } = createProject(db, {
  clientId: client.id, owner: "Resolve Owner", street: "5 Resolve Way", city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
});
const now = new Date().toISOString();

check("THE LIVE SHAPE: with several agreements and no recorded portal, it refuses", () => {
  // Not a bug — an arbitrary pick between two disagreeing agreements is a claim about whose
  // money it was. This is the state that blocked every invoice.
  assert.equal(feeResponsibilityNow(db, project, "permit"), "");
  assert.equal(feeResponsibilityNow(db, project, "nem"), "");
});

// The filing is recorded against its portal, exactly as markTrackSubmitted writes it — a deep
// per-application URL, not the bare login page the credential is stored under.
db.run(
  `INSERT INTO permit_check_targets (id, project_id, target_type, permit_type, active, latest_outcome, application_number, portal_url, created_at, updated_at)
   VALUES ('t-elec', ?, 'permit', 'electrical', 1, 'waiting', '194-26-001471-ELEC',
           'https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx?Module=Building&capID1=26CAP', ?, ?)`,
  [project.id, now, now],
);

check("THE HEADLINE: the track's own recorded portal resolves the agreement", () => {
  assert.equal(feeResponsibilityNow(db, project, "permit"), "keelix-pays",
    "the permit filed through Accela, whose credential says keelix-pays");
});

check("...and it matches on host + first path segment, not on the exact stored URL", () => {
  // The recorded URL is a deep CapDetail link with query parameters; the credential is stored
  // against the bare portal entry. Requiring string equality would resolve nothing in practice.
  const target = db.get<{ portal_url: string }>("SELECT portal_url FROM permit_check_targets WHERE id = 't-elec'")!;
  assert.notEqual(target.portal_url, ACCELA, "fixture is wrong — the URLs must differ for this to prove anything");
});

check("MUST NOT: the permit track does not inherit the UTILITY portal's agreement", () => {
  // Safety rule 5. Both credentials state an agreement and they disagree, so a lookup that is not
  // track-scoped would hand the permit track "customer-pays" off the NEM portal and under-bill.
  db.run(
    `INSERT INTO permit_check_targets (id, project_id, target_type, permit_type, active, latest_outcome, application_number, portal_url, created_at, updated_at)
     VALUES ('t-nem', ?, 'nem', 'nem', 1, 'waiting', 'APP-1', ?, ?, ?)`,
    [project.id, POWERCLERK, now, now],
  );
  assert.equal(feeResponsibilityNow(db, project, "permit"), "keelix-pays",
    "the permit track picked up the NEM portal's agreement");
  assert.equal(feeResponsibilityNow(db, project, "nem"), "customer-pays",
    "the NEM track must read its OWN portal");
});

check("MUST NOT: a track with no recorded portal stays unresolved", () => {
  // Deleting the permit track's target puts it back to "nothing recorded, several disagree".
  db.run("DELETE FROM permit_check_targets WHERE id = 't-elec'");
  assert.equal(feeResponsibilityNow(db, project, "permit"), "",
    "an unrecorded track fell through to some other track's agreement");
  assert.equal(feeResponsibilityNow(db, project, "nem"), "customer-pays", "the NEM track is unaffected");
});

check("a single stated agreement is still unambiguous, as it was before", () => {
  // The original fallback has to keep working for a one-portal client.
  const solo = createClient(db, { companyName: "Solo Solar", ccbLicenseNumber: "929292" });
  createPortalCredential(db, solo.id, {
    portalType: "OR · Coos Bay", portalUrl: ACCELA, username: "solo@resolve.invalid",
    password: "not-a-real-password", feeResponsibility: "mailed-check",
  });
  const { project: soloProject } = createProject(db, {
    clientId: solo.id, owner: "Solo Owner", street: "6 Solo St", city: "Coos Bay",
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
  });
  assert.equal(feeResponsibilityNow(db, soloProject, "permit"), "mailed-check");
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nfeeResponsibilityResolve: all checks passed."
  : `\nfeeResponsibilityResolve: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
