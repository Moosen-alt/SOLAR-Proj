// ONE LINK, ONE COMPANY, ALL OF THEIR JOBS — AND NOBODY ELSE'S.
//
// The per-project status page (/status?token=) already works, but it hands out one token per
// project. A solar company with fifteen jobs needs fifteen links and has to be sent a new one on
// every new job, which is why nobody uses it as a tracker. This is the same idea keyed on the
// CLIENT: a stable link the company bookmarks once, listing everything we are filing for them.
//
// STABLE ON PURPOSE, not an oversight. The operator asked for a link a client can keep without
// requesting a new one, so the token is minted once and never rotated. The cost is real and is
// recorded here rather than discovered later: a link forwarded to the wrong person cannot be
// killed, because there is nothing to rotate it to.
//
// THE RISK IS TENANCY, and it is bigger than the per-project page's. One leaked or mis-minted
// token exposes a company's entire book of work rather than one address, so the first check is
// that a token reaches its own client's projects and stops there.
//
//   MUST LIST    — every project belonging to this client, and a stable token across calls.
//   MUST EXCLUDE — another client's projects; correction TEXT (raw scraped AHJ prose, which can
//                  carry PII — the page says a correction landed, never what it said); an
//                  unknown or blank token.
//
//   npx tsx backend/test/clientPortal.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-portal-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { ensureClientPortalToken, clientPortalUrl, clientPortalPayload } = await import("../src/clientPortal");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const ours = createClient(db, { companyName: "Ours Solar", ccbLicenseNumber: "111222", businessEmail: "ops@ours.test" });
const theirs = createClient(db, { companyName: "Theirs Solar", ccbLicenseNumber: "333444", businessEmail: "ops@theirs.test" });

const mk = (clientId: string, owner: string, street: string) => createProject(db, {
  clientId, owner, street, city: "Coos Bay", state: "OR", ahj: "City of Coos Bay",
  utility: "Pacific Power", dcKw: "8", acKw: "6.4",
}).project;

const p1 = mk(ours.id, "Owner One", "1 First St");
const p2 = mk(ours.id, "Owner Two", "2 Second St");
const otherCompanysJob = mk(theirs.id, "Not Yours", "99 Private Ln");

const token = ensureClientPortalToken(db, ours.id);

check("THE HEADLINE: one link lists every job we are filing for this company", () => {
  const payload = clientPortalPayload(db, token);
  assert.ok(payload, "the token did not resolve to a client at all");
  assert.equal(payload!.company, "Ours Solar");
  const addresses = payload!.projects.map((p) => p.address).sort();
  assert.equal(payload!.projects.length, 2, JSON.stringify(addresses));
  assert.ok(addresses.some((a) => a.includes("1 First St")), JSON.stringify(addresses));
  assert.ok(addresses.some((a) => a.includes("2 Second St")), JSON.stringify(addresses));
});

check("MUST EXCLUDE: another company's job is not on it — the whole risk of a per-client link", () => {
  // A per-project token leaks one address. This one would leak a company's entire book of work,
  // so the tenancy check is the first thing asserted and the last thing to be allowed to rot.
  const payload = clientPortalPayload(db, token)!;
  const ids = payload.projects.map((p) => p.id);
  assert.ok(!ids.includes(otherCompanysJob.id),
    `a different solar company's project appeared on this link: ${JSON.stringify(payload.projects.map((p) => p.address))}`);
  assert.ok(!JSON.stringify(payload).includes("99 Private Ln"),
    "the other company's address leaked somewhere in the payload");
  assert.ok(!JSON.stringify(payload).includes("Not Yours"),
    "the other company's homeowner name leaked somewhere in the payload");
});

check("STABLE: minting again returns the SAME token, so a bookmarked link keeps working", () => {
  // The operator's explicit requirement: a client should not have to ask for a new link. A
  // second call must not roll it — that would silently break every link already sent.
  assert.equal(ensureClientPortalToken(db, ours.id), token, "the token rolled — every link already sent is now dead");
  assert.equal(ensureClientPortalToken(db, ours.id), token);
});

check("two companies never share a token", () => {
  assert.notEqual(ensureClientPortalToken(db, theirs.id), token);
});

check("MUST EXCLUDE: correction TEXT never reaches the page, only that one landed", () => {
  // Correction text is raw scraped portal prose or forwarded AHJ email. It can carry the
  // homeowner's name, phone, or a plans-examiner's direct line. The decision is that the client
  // learns a correction landed and we are on it; the wording stays internal.
  db.run(
    `INSERT INTO corrections (id, project_id, source, correction_text, correction_bucket, required_action, created_at)
     VALUES ('corr-1', ?, 'portal', 'Call homeowner Jane Doe at 555-0143 re: setback on E-1', 'plan_error', 'Revise sheet E-1', ?)`,
    [p1.id, new Date().toISOString()],
  );
  const blob = JSON.stringify(clientPortalPayload(db, token));
  assert.ok(!blob.includes("555-0143"), "a phone number out of correction text reached the client page");
  assert.ok(!blob.includes("Jane Doe"), "a name out of correction text reached the client page");
  assert.ok(!blob.includes("setback on E-1"), "raw correction prose reached the client page");
  assert.ok(!blob.includes("Revise sheet E-1"), "the required-action text is internal too — it names sheets and people");
});

check("MUST EXCLUDE: an unknown or blank token resolves to nothing", () => {
  assert.equal(clientPortalPayload(db, "not-a-real-token"), null);
  assert.equal(clientPortalPayload(db, ""), null, "a blank token must not match the clients with no token minted");
  // The nastiest version: every client row defaults to '' for this column, so a blank token
  // matching on equality would hand out the FIRST unminted client's whole book of work.
  const unminted = createClient(db, { companyName: "Never Shared LLC", ccbLicenseNumber: "555666" });
  mk(unminted.id, "Unminted Owner", "5 Hidden Way");
  assert.equal(clientPortalPayload(db, ""), null, "a blank token matched a client that never had a link minted");
});

check("the link is built from PUBLIC_BASE_URL, like every other client-facing link", () => {
  process.env.PUBLIC_BASE_URL = "https://portal.example.test";
  assert.equal(clientPortalUrl(token), `https://portal.example.test/portal?token=${encodeURIComponent(token)}`);
  delete process.env.PUBLIC_BASE_URL;
});

check("each project carries what a tracker needs, and the plain-English status", () => {
  const p = clientPortalPayload(db, token)!.projects.find((x) => x.id === p1.id)!;
  assert.ok(p.address.includes("1 First St"));
  assert.equal(p.ahj, "City of Coos Bay");
  assert.equal(p.utility, "Pacific Power");
  assert.ok(typeof p.status === "string" && p.status.length > 0);
  assert.ok(Array.isArray(p.tracks), "per-track permit/NEM rows are what the client actually watches");
});

check("THE RECEIPT SURVIVES A SPLIT FILING: one filing recorded as several rows still shows its confirmation number", () => {
  // One filing is recorded as two or three submission rows on the live database — a re-record,
  // a resume, a correction resubmit — and only the row that reached the confirmation page
  // carries the number. The aggregate that collapses those rows takes MIN() over a column
  // whose schema default is the EMPTY STRING, and '' sorts below every real receipt, so the
  // client's page prints a blank where the portal handed us a number.
  //
  // MIN(submitted_at) is deliberate and stays: the earliest date is when the jurisdiction
  // actually received it. MIN over the confirmation number is not the same decision.
  db.run(
    `INSERT INTO permit_check_targets (id, project_id, target_type, permit_type, jurisdiction, portal_name,
       application_number, permit_number, latest_status_label, latest_outcome, active, created_at, updated_at)
     VALUES ('tgt-split', ?, 'permit', 'electrical', 'City of Coos Bay', 'Accela',
       'CB-2026-0511', '', 'Under review', 'waiting', 1, ?, ?)`,
    [p2.id, "2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z"],
  );
  // Row one: the re-record. It knows the application number and nothing else.
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, application_number,
       confirmation_number, submitted_at, created_at)
     VALUES ('sub-split-blank', ?, 'permit', 'electrical', 'submitted', 'CB-2026-0511', '', ?, ?)`,
    [p2.id, "2026-09-02T10:00:00.000Z", "2026-09-02T10:00:00.000Z"],
  );
  // Row two: the run that actually reached the portal's confirmation page.
  db.run(
    `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, application_number,
       confirmation_number, submitted_at, created_at)
     VALUES ('sub-split-receipt', ?, 'permit', 'electrical', 'submitted', 'CB-2026-0511', 'RCPT-88421', ?, ?)`,
    [p2.id, "2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z"],
  );
  const project = clientPortalPayload(db, token)!.projects.find((x) => x.id === p2.id)!;
  const track = project.tracks.find((t) => t.applicationNumber === "CB-2026-0511")!;
  assert.ok(track, "the seeded tracking target did not appear on the client page at all");
  assert.equal(track.confirmationNumber, "RCPT-88421",
    "a real receipt exists on another row of the same filing, and the client's page shows a blank");
  // The filing date still comes from the EARLIEST row, so a re-record cannot walk it forward.
  assert.equal(track.submittedAt, "2026-09-01T10:00:00.000Z",
    "the filing date must stay the earliest of the rows for this application number");
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nclientPortal: all checks passed."
  : `\nclientPortal: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
