// THE DAY 2-3 DELIVERABLE, PINNED TO ITS OWN DEFINITIONS.
//
// The onboarding guide we hand every new customer promises a coverage report in their first
// week: "Which of your jurisdictions are ready now, which need a supervised first run, and
// which can't be filed yet." Three buckets, and the value of the document is entirely in the
// LINE BETWEEN THEM. Put a portal in READY NOW that a person has to babysit and the customer
// discovers it holding the mouse; put one in CANNOT FILE YET that actually works and we have
// sold them less than we have.
//
// So this test seeds one jurisdiction per bucket in a scratch database and asserts the
// classification through the SAME resolution the report uses in production — the real recipe
// lookups, the real credential selection, the real login-health flags. The cases that matter
// most are the two where every other signal is green:
//
//   - a portal that emails a one-time code at login with NOBODY NAMED TO RELAY IT lands in
//     CANNOT FILE YET even though it has a complete recipe and an accepted login. Software
//     never clears an MFA code. Name an inbox or a person, and the same row moves.
//   - a complete recipe whose login this customer has never had accepted is SUPERVISED FIRST
//     RUN, not READY NOW. A recipe recorded against another account is evidence about the
//     portal, not about their access to it.
//
// Both are kill-tested in both directions: the fix removed, the row must move back.
//
// Browser-free, network-free, secret-free. Run: tsx backend/test/coverageReport.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-report-"));
const DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_DB_PATH = DB_PATH;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { createPortalCredential, updatePortalCredential, listPortalCredentials, recordLoginOutcome } = await import("../src/portalCredentials");
const { recipeProfileKey } = await import("../src/portalRecipes");
const { knowledgeProfileKey } = await import("../src/knowledgeBase");
const {
  buildCoverageReport,
  renderCoverageReport,
  parseJurisdictions,
  jurisdictionsFromProjects,
  classifyCoverage,
  textSuggestsMfa,
  findRelay,
  COVERAGE_BUCKETS,
} = await import("../../scripts/coverage-report");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------
// Fixture.
//
// EVERY NAME BELOW IS FICTIONAL AND DELIBERATELY UN-FUZZY-MATCHABLE. openDatabase() seeds
// the baseline knowledge base on EVERY open — a few hundred real AHJ and utility rows sit in
// this scratch file — and findKnowledgeForLearn matches on tokens with a 60-point threshold.
// A jurisdiction named "City of Portland" or "Ameren Illinois" would resolve a REAL portal
// URL and quietly break the no-portal-URL case into a pass. The states are NV and NM for the
// same reason: Oregon carries a statewide Accela fallback that fires for any OR AHJ whose
// process profile files through e-permitting.
// ---------------------------------------------------------------------------
const CLIENT = createClient(db, { companyName: "Thorncrest Solar Works" } as never).id;
const PASSWORD = "correct-horse-battery-staple-DO-NOT-PRINT";

const THORNCREST_URL = "https://thorncrest-permits.invalid/portal/";
const QUARRY_URL = "https://quarryridge-interconnect.invalid/apply/";
const PELHAM_URL = "https://pelhambay-permits.invalid/citizen/";
const HARROWGATE_URL = "https://harrowgate-permits.invalid/portal/";
const MARROWVALE_URL = "https://marrowvale-permits.invalid/portal/";

function seedRecipe(opts: {
  scopeType: "ahj" | "utility";
  state: string;
  ahj?: string;
  utility?: string;
  discipline?: string;
  status: "complete" | "recording" | "needs_rerecord";
  portalUrl: string;
  steps: number;
}): void {
  // The KEY comes from production's own builder. A hand-typed profile key is the classic
  // way a fixture passes while production resolves nothing.
  const key = recipeProfileKey({ scopeType: opts.scopeType, state: opts.state, ahj: opts.ahj, utility: opts.utility });
  const steps = JSON.stringify(Array.from({ length: opts.steps }, (_, i) => ({ action: "fill", label: `field ${i + 1}` })));
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO portal_recipes
      (id, scope_type, profile_key, state, ahj, utility, portal_platform, portal_url, status, version, steps_json, created_by, created_at, updated_at, notes, discipline)
     VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 4, ?, 'fixture', ?, ?, '', ?)`,
    [
      `recipe-${key}-${opts.discipline || "none"}-${opts.status}`,
      opts.scopeType, key, opts.state, opts.ahj ?? "", opts.utility ?? "",
      opts.portalUrl, opts.status, steps, now, now, opts.discipline ?? "",
    ],
  );
}

function seedKnowledge(opts: { state: string; ahj?: string; utility?: string; portalUrl: string; notes?: string }): void {
  const key = knowledgeProfileKey({ state: opts.state, ahj: opts.ahj, utility: opts.utility });
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO permit_utility_knowledge
      (id, profile_key, state, ahj, utility, portal_name, portal_url, notes, first_seen_at, last_learned_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
    [`kb-${key}`, key, opts.state, opts.ahj ?? "", opts.utility ?? "", opts.portalUrl, opts.notes ?? "", now, now, now],
  );
}

// 1. READY NOW — complete recipe + a login this portal has accepted.
seedRecipe({ scopeType: "ahj", state: "NV", ahj: "City of Thorncrest", status: "complete", portalUrl: THORNCREST_URL, steps: 41 });
createPortalCredential(db, CLIENT, {
  portalType: "NV · Thorncrest", portalUrl: THORNCREST_URL, username: "permits@thorncrest-solar.invalid", password: PASSWORD,
  notes: "Office hours only; the counter closes at 16:00.",
});
recordLoginOutcome(db, CLIENT, THORNCREST_URL, { ok: true, note: "login accepted" });

// 2. SUPERVISED FIRST RUN — healthy login, no recipe at all. The portal URL comes from the
//    shared knowledge base, which is where a jurisdiction nobody has driven yet has one.
seedKnowledge({ state: "NV", utility: "Quarry Ridge Electric Cooperative", portalUrl: QUARRY_URL });
createPortalCredential(db, CLIENT, {
  portalType: "NV · Quarry Ridge", portalUrl: QUARRY_URL, username: "interconnect@thorncrest-solar.invalid", password: PASSWORD,
  notes: "Account is registered to the supervising electrician, not the office.",
});

// 3. CANNOT FILE YET — everything green EXCEPT the code at login, which nobody is named to
//    relay. This is the row the guide's S4 is about, answered through the intake packet's own
//    per-portal columns (migration v18): mfa_required set, mfa_code_destination blank.
seedRecipe({ scopeType: "ahj", state: "NM", ahj: "Town of Pelham Bay", status: "complete", portalUrl: PELHAM_URL, steps: 33 });
createPortalCredential(db, CLIENT, {
  portalType: "NM · Pelham Bay", portalUrl: PELHAM_URL, username: "permits@thorncrest-solar.invalid", password: PASSWORD,
  mfaRequired: true, feeResponsibility: "customer-pays",
});
recordLoginOutcome(db, CLIENT, PELHAM_URL, { ok: true, note: "login accepted" });

// 3b. The same blocker reached the OLD way. Most of the fleet predates the v18 columns and
//     carries this only as an operator's note, so the note has to keep working.
seedRecipe({ scopeType: "ahj", state: "NM", ahj: "City of Marrowvale", status: "complete", portalUrl: MARROWVALE_URL, steps: 22 });
createPortalCredential(db, CLIENT, {
  portalType: "NM · Marrowvale", portalUrl: MARROWVALE_URL, username: "permits@thorncrest-solar.invalid", password: PASSWORD,
  notes: "Login emails a one-time code (human-capture at login).",
});
recordLoginOutcome(db, CLIENT, MARROWVALE_URL, { ok: true, note: "login accepted" });

// 4. CANNOT FILE YET — nothing seeded at all. No recipe, no knowledge row, no login.
//    This is the mock trap: a stage here reports success without opening a browser.

// 5. CANNOT FILE YET — the portal refused the stored login.
seedRecipe({ scopeType: "ahj", state: "NV", ahj: "Village of Harrowgate", status: "complete", portalUrl: HARROWGATE_URL, steps: 27 });
createPortalCredential(db, CLIENT, {
  portalType: "NV · Harrowgate", portalUrl: HARROWGATE_URL, username: "permits@thorncrest-solar.invalid", password: PASSWORD,
});
recordLoginOutcome(db, CLIENT, HARROWGATE_URL, { ok: true, note: "login accepted" });
recordLoginOutcome(db, CLIENT, HARROWGATE_URL, { ok: false, note: "Still on the login form after submitting — the stored username/password was likely rejected." });

const SCOPE =
  "NV|City of Thorncrest|, NV||Quarry Ridge Electric Cooperative, NM|Town of Pelham Bay|, NM|City of Marrowvale|, NM|City of Fallowmere|, NV|Village of Harrowgate|";
const jurisdictions = parseJurisdictions(SCOPE);
const client = { id: CLIENT, name: "Thorncrest Solar Works" };
const run = () => buildCoverageReport(db, client, jurisdictions);
const rowFor = (label: string, report = run()) => {
  const hit = report.rows.find((r) => r.jurisdiction.toLowerCase().includes(label.toLowerCase()));
  assert.ok(hit, `no row for "${label}" — the report produced: ${report.rows.map((r) => r.jurisdiction).join(" / ")}`);
  return hit;
};

// ---------------------------------------------------------------------------
// Scope: one row per TRACK, never a jurisdiction folded into one verdict.
// ---------------------------------------------------------------------------
check("six jurisdictions produce six track rows — five permit, one NEM", () => {
  const report = run();
  assert.equal(jurisdictions.length, 6);
  assert.equal(report.rows.length, 6);
  assert.equal(report.rows.filter((r) => r.track === "permit").length, 5);
  assert.equal(report.rows.filter((r) => r.track === "nem").length, 1);
});

// ---------------------------------------------------------------------------
// One jurisdiction per bucket.
// ---------------------------------------------------------------------------
check("READY NOW: a complete recipe plus a login the portal has accepted", () => {
  const row = rowFor("Thorncrest");
  assert.equal(row.bucket, "ready_now", row.reason);
  assert.equal(row.recipeStatus, "complete");
  assert.equal(row.credential.loginAccepted, true);
  assert.match(row.reason, /complete recipe/i);
  // Even READY NOW must not read as unattended.
  assert.match(row.unblocks, /review screen|person|submit/i);
});

check("SUPERVISED FIRST RUN: healthy login, no recorded recipe — a learn is needed", () => {
  const row = rowFor("Quarry Ridge");
  assert.equal(row.bucket, "supervised_first_run", row.reason);
  assert.equal(row.track, "nem");
  assert.equal(row.recipeStatus, "none");
  assert.equal(row.credential.stored, true);
  assert.equal(row.portalUrl, QUARRY_URL, "the knowledge base is where an undriven jurisdiction's URL comes from");
  assert.match(row.reason, /no recorded recipe|learn run/i);
});

check("CANNOT FILE YET: an emailed code at login with nobody named to relay it", () => {
  const row = rowFor("Pelham Bay");
  // Everything else about this row is green — that is the whole point of the case.
  assert.equal(row.recipeStatus, "complete");
  assert.equal(row.credential.loginAccepted, true);
  assert.equal(row.credential.stale, false);
  assert.equal(row.mfa.expected, true);
  assert.equal(row.mfa.relayNamed, false);
  assert.equal(row.mfa.evidence, "portal_credentials.mfa_required", "the packet's own answer is the authority");
  assert.equal(row.bucket, "cannot_file_yet", row.reason);
  assert.match(row.reason, /one-time code|code at login/i);
  assert.match(row.reason, /nobody is named to relay/i);
  assert.match(row.unblocks, /inbox|relay/i);
});

check("...and the same blocker recorded only as an operator's note still lands there", () => {
  // mfa_required is 0 on this row: everything comes from the notes column, which is where
  // the pre-v18 fleet still carries it.
  const row = rowFor("Marrowvale");
  assert.equal(row.recipeStatus, "complete");
  assert.equal(row.credential.loginAccepted, true);
  assert.equal(row.mfa.expected, true);
  assert.equal(row.mfa.evidence, "the credential's notes");
  assert.equal(row.bucket, "cannot_file_yet", row.reason);
});

check("CANNOT FILE YET: no portal URL known — the mock trap, named as such", () => {
  const row = rowFor("Fallowmere");
  assert.equal(row.bucket, "cannot_file_yet", row.reason);
  assert.equal(row.portalUrl, "", "a fictional AHJ must not fuzzy-match a seeded knowledge row");
  assert.equal(row.credential.stored, false);
  assert.match(row.reason, /no portal URL/i);
  assert.match(row.reason, /mock/i);
});

check("CANNOT FILE YET: a login the portal refused, with the §6 remedy and not the wrong one", () => {
  const row = rowFor("Harrowgate");
  assert.equal(row.bucket, "cannot_file_yet", row.reason);
  assert.equal(row.credential.stale, true);
  assert.match(row.reason, /refused/i);
  // Two tools in this repo print `--host <host>` as the fix for a stale credential and it
  // silently skips the host. Do not ship a third.
  assert.match(row.unblocks, /--include-stale/);
  assert.match(row.unblocks, /successful login clears it/i);
});

// ---------------------------------------------------------------------------
// A FILING IS A LOGIN THAT WORKED.
//
// READY NOW turns on portal_credentials.last_login_ok_at, and exactly one caller writes that
// flag: the auto-learn path. A REPLAY that stages a real filing logs in, fills the form and
// captures an application number — and records nothing. On the live database only ONE credential
// in the whole table had ever recorded an accepted login (a Sacramento benchmark), while real
// applications had been filed through aca-oregon.accela.com twice. The report was telling the
// operator to book a supervised first run for portals already proven.
// ---------------------------------------------------------------------------
const EVERDALE_URL = "https://everdale-permits.invalid/portal/";
seedRecipe({ scopeType: "ahj", state: "NM", ahj: "City of Everdale", status: "complete", portalUrl: EVERDALE_URL, steps: 31 });
createPortalCredential(db, CLIENT, {
  portalType: "NM · Everdale", portalUrl: EVERDALE_URL, username: "permits@thorncrest-solar.invalid", password: PASSWORD,
});
// Deliberately NO recordLoginOutcome — this is the state every replayed portal is in.
const everdaleScope = [...jurisdictions, ...parseJurisdictions("NM|City of Everdale|")];
const everdaleRow = () => {
  const report = buildCoverageReport(db, client, everdaleScope);
  return report.rows.find((r) => r.jurisdiction.includes("Everdale") && r.track === "permit")!;
};

check("before any filing: a complete recipe with an untried login is SUPERVISED", () => {
  const row = everdaleRow();
  assert.equal(row.recipeStatus, "complete");
  assert.equal(row.credential.neverAttempted, true, "fixture is wrong — this login must be untried");
  assert.equal(row.bucket, "supervised_first_run", row.reason);
});

const { project: everdaleProject } = createProject(db, {
  clientId: CLIENT, owner: "Everdale Owner", street: "4 Everdale Rd", city: "Everdale",
  state: "NM", ahj: "City of Everdale", utility: "Everdale Power", dcKw: "8", acKw: "6.4",
});
const fileIt = (status: string, appNumber: string, discipline = "electrical") => db.run(
  `INSERT INTO submissions (id, project_id, submission_type, permit_type, status, application_number, submitted_at, created_at)
   VALUES (?, ?, 'permit', ?, ?, ?, ?, ?)`,
  [`sub-${appNumber}-${status}`, everdaleProject.id, discipline, status, appNumber,
    "2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z"],
);

check("MUST NOT: a STAGED filing is not evidence — nothing was ever presented to the portal", () => {
  // awaiting_human_submit means the form is filled and sitting in our review window. No login of
  // this company's was necessarily accepted, and certainly no application exists.
  fileIt("awaiting_human_submit", "EV-STAGED");
  assert.equal(everdaleRow().bucket, "supervised_first_run", "a staged, unfiled application was read as proof of login");
});

check("THE HEADLINE: a real filing moves it to READY NOW, and the reason says why", () => {
  fileIt("submitted", "EV-2026-0042");
  const row = everdaleRow();
  assert.equal(row.bucket, "ready_now", row.reason);
  assert.equal(row.filedHere.filed, true);
  assert.match(row.reason, /EV-2026-0042/, `the reason must name the evidence: ${row.reason}`);
  assert.match(row.reason, /could not exist unless the login worked/i, row.reason);
});

check("MUST NOT: a REFUSED login outranks a past filing — the password has since changed", () => {
  // The refusal branch sits above this one on purpose. A portal that rejected us this week is not
  // ready because we filed there last month.
  recordLoginOutcome(db, CLIENT, EVERDALE_URL, { ok: false, note: "Still on the login form after submitting — the stored username/password was likely rejected." });
  const row = everdaleRow();
  assert.equal(row.bucket, "cannot_file_yet", `a filing overrode a live refusal: ${row.reason}`);
  assert.match(row.reason, /REFUSED/i, row.reason);
  recordLoginOutcome(db, CLIENT, EVERDALE_URL, { ok: true, note: "login accepted" });
});

check("MUST NOT: a filing in a DIFFERENT jurisdiction is not evidence for this one", () => {
  const otherRow = buildCoverageReport(db, client, everdaleScope).rows
    .find((r) => r.jurisdiction.includes("Fallowmere"))!;
  assert.equal(otherRow.filedHere.filed, false,
    "Everdale's filing was counted as evidence for Fallowmere");
});

check("MUST EXCLUDE: an ARCHIVED project is not a jurisdiction we serve", () => {
  // The archive (v27) hides superseded staging passes and test fixtures from the client portal.
  // Counting them here inflates the denominator of the only number this report states. On the
  // live database two Illinois TEST fixtures put City of Springfield and City of Evanston into
  // CANNOT FILE YET, so the readiness figure described jurisdictions nobody has a job in.
  const before = jurisdictionsFromProjects(db, CLIENT).length;
  const { project: fixture } = createProject(db, {
    clientId: CLIENT, owner: "Test Testerson", street: "800 E Monroe St", city: "Springfield",
    state: "IL", ahj: "City of Springfield", utility: "Ameren Illinois", dcKw: "8", acKw: "6.4",
  });
  assert.equal(jurisdictionsFromProjects(db, CLIENT).length, before + 1,
    "fixture is wrong — the new jurisdiction should show up before it is archived");
  db.run("UPDATE projects SET archived_at = ? WHERE id = ?", [new Date().toISOString(), fixture.id]);
  const after = jurisdictionsFromProjects(db, CLIENT);
  assert.equal(after.length, before, `an archived project still counts as a jurisdiction: ${JSON.stringify(after.map((j) => j.ahj))}`);
  assert.ok(!after.some((j) => j.ahj === "City of Springfield"), "the archived jurisdiction is still listed");
});

check("the counts add up and every bucket is one of the three the guide names", () => {
  const report = run();
  const total = COVERAGE_BUCKETS.reduce((n, b) => n + report.counts[b], 0);
  assert.equal(total, report.rows.length);
  assert.equal(report.counts.ready_now, 1);
  assert.equal(report.counts.supervised_first_run, 1);
  assert.equal(report.counts.cannot_file_yet, 4);
  for (const row of report.rows) assert.ok(COVERAGE_BUCKETS.includes(row.bucket), `unknown bucket "${row.bucket}"`);
});

// ---------------------------------------------------------------------------
// KILL-TEST 1 — the READY NOW / SUPERVISED FIRST RUN boundary, both directions.
//
// "A complete recipe exists" is NOT the line. The line is "this customer's login has been
// accepted on that portal". Take the acceptance away from the READY NOW row and it must move;
// give it back and it must return. A report that cannot tell those apart is the one that
// promises a portal nobody has ever logged into.
// ---------------------------------------------------------------------------
check("KILL-TEST: with no accepted login, the SAME complete recipe is SUPERVISED FIRST RUN", () => {
  db.run("UPDATE portal_credentials SET last_login_ok_at = NULL, last_login_failed_at = NULL WHERE client_id = ? AND portal_url = ?", [CLIENT, THORNCREST_URL]);
  const row = rowFor("Thorncrest");
  assert.equal(row.recipeStatus, "complete", "the recipe has not changed — only the login evidence has");
  assert.equal(row.bucket, "supervised_first_run", row.reason);
  assert.equal(row.credential.neverAttempted, true);
  assert.match(row.reason, /never presented|not accepted/i);
  assert.match(row.unblocks, /D3-6|supervis|watch/i);
});

check("...and a successful login moves it back to READY NOW with no other edit", () => {
  recordLoginOutcome(db, CLIENT, THORNCREST_URL, { ok: true, note: "login accepted" });
  assert.equal(rowFor("Thorncrest").bucket, "ready_now");
});

// ---------------------------------------------------------------------------
// KILL-TEST 2 — the MFA relay boundary, both directions.
// ---------------------------------------------------------------------------
check("KILL-TEST: naming the inbox moves the MFA row out of CANNOT FILE YET", () => {
  const cred = listPortalCredentials(db, CLIENT).find((c) => c.portalUrl === PELHAM_URL)!;
  updatePortalCredential(db, CLIENT, cred.id, { mfaCodeDestination: "permits-shared@thorncrest-solar.invalid" });
  const row = rowFor("Pelham Bay");
  assert.equal(row.mfa.expected, true, "the portal still challenges a code");
  assert.equal(row.mfa.relayNamed, true);
  assert.equal(row.mfa.relay, "permits-shared@thorncrest-solar.invalid");
  assert.equal(row.bucket, "ready_now", row.reason);
  // It must still say a person is in the loop every session — "ready" is never "unattended".
  assert.match(row.reason, /relay one every session|never unattended/i);
});

check("...and clearing the inbox again puts it straight back in CANNOT FILE YET", () => {
  const cred = listPortalCredentials(db, CLIENT).find((c) => c.portalUrl === PELHAM_URL)!;
  updatePortalCredential(db, CLIENT, cred.id, { mfaCodeDestination: "" });
  assert.equal(rowFor("Pelham Bay").bucket, "cannot_file_yet");
});

// ---------------------------------------------------------------------------
// S3.7 — who pays this portal's fees, agreed PER PORTAL at kickoff. It never moves a row
// between buckets (automation never pays a fee under any value of it), but the unagreed
// state has to be visible somewhere the customer reads.
// ---------------------------------------------------------------------------
check("the per-portal fee agreement is carried, and an unagreed portal says so", () => {
  const report = run();
  assert.equal(rowFor("Pelham Bay", report).feeResponsibility, "customer-pays");
  assert.equal(rowFor("Thorncrest", report).feeResponsibility, "", "nobody has agreed this one yet");
  // Collapsed, because the renderer wraps long sentences and a phrase can straddle the break.
  const rendered = renderCoverageReport(report).replace(/\s+/g, " ");
  assert.match(rendered, /NOT AGREED/, "an unagreed portal must be visible in the printed report");
  assert.match(rendered, /customer-pays/);
  assert.match(rendered, /never pays a portal fee/i);
});

// ---------------------------------------------------------------------------
// THE RELAY MUST BE SOMEBODY ON THIS CUSTOMER'S SIDE.
//
// The relay decides READY NOW vs CANNOT FILE YET, and it was satisfied by any email-shaped
// string in the sources - including the SHARED knowledge-base row, which every tenant reads
// and which routinely carries the utility's own support address. A utility hotline is not a
// person who can hand us a one-time code, so that produced a false READY on a
// customer-facing deliverable. Found by the onboarding-guide audit; the previous fixture
// passed only because its KB notes happened to contain no email.
// ---------------------------------------------------------------------------
check("MUST NOT: an address in the POOLED knowledge base counts as a relay", () => {
  const cred = listPortalCredentials(db, CLIENT).find((c) => c.portalUrl === PELHAM_URL)!;
  // Clear the customer's own answer, then put a utility support address in the SHARED row.
  updatePortalCredential(db, CLIENT, cred.id, { mfaCodeDestination: "", notes: "" });
  // SEED the shared row (Pelham Bay has none by default) — an UPDATE here hits zero rows and
  // makes this whole case vacuous, which is exactly how the first attempt at this test passed
  // with the fix disabled.
  seedKnowledge({
    state: "NM", ahj: "Town of Pelham Bay", portalUrl: PELHAM_URL,
    notes: "Interconnection questions: customerservice@pelhambay-utility.example — code is emailed at login",
  });
  const row = rowFor("Pelham Bay");
  assert.equal(row.mfa.expected, true, "the shared row still tells us the portal challenges a code");
  assert.equal(row.mfa.relayNamed, false,
    `a pooled utility address was accepted as this customer's relay: ${row.mfa.relay}`);
  assert.equal(row.bucket, "cannot_file_yet",
    "a declared-MFA portal with nobody named to relay must never read READY NOW");
});

// ---------------------------------------------------------------------------
// The MFA vocabulary, in BOTH directions. A filter list fails both ways: one that misses
// the real note reads as "this portal is fine", and one that fires on everything buries the
// report under portals nobody has to staff.
// ---------------------------------------------------------------------------
check("MFA detection: the notes an operator actually types are recognised", () => {
  assert.equal(textSuggestsMfa("Login emails a one-time code (human-capture at login)."), true);
  assert.equal(textSuggestsMfa("Portal sends a code to the account email on every new device."), true);
  assert.equal(textSuggestsMfa("MFA required on this account."), true);
  assert.equal(textSuggestsMfa("Needs the authenticator app at login."), true);
});

check("...and the notes that are NOT about a code are left alone", () => {
  assert.equal(textSuggestsMfa("Account is shared with the electrician."), false);
  assert.equal(textSuggestsMfa("Office hours only; the counter closes at 16:00."), false);
  assert.equal(textSuggestsMfa("Net metering facility application, level 1."), false);
  assert.equal(textSuggestsMfa("No MFA on this portal."), false, "an explicit negation must not read as MFA");
});

check("a relay is somebody NAMED — the MFA note on its own is not one", () => {
  assert.equal(findRelay("Login emails a one-time code (human-capture at login)."), "");
  assert.equal(findRelay("Codes go to permits-shared@example.invalid"), "permits-shared@example.invalid");
  assert.match(findRelay("Shared inbox for codes, call 555-010-0100 if it is late"), /shared inbox|555/i);
});

// ---------------------------------------------------------------------------
// Safety rule 5 — a permit track must never resolve a utility portal URL.
// ---------------------------------------------------------------------------
check("a permit jurisdiction whose only known URL is a utility platform reports NO portal URL", () => {
  // This is the exact shape the guard exists for: a knowledge row matched through the
  // project's utility carries the PowerClerk URL, and a permit filing must never be pointed
  // at it. Falling through to "no portal URL known" is the correct, safe answer.
  seedKnowledge({ state: "NM", ahj: "City of Fallowmere", portalUrl: "https://fallowmere.powerclerk.com/apply" });
  const row = rowFor("Fallowmere");
  assert.equal(row.portalUrl, "", "a PowerClerk URL must never become a permit track's portal");
  assert.equal(row.bucket, "cannot_file_yet");
  db.run("DELETE FROM permit_utility_knowledge WHERE profile_key = ?", [knowledgeProfileKey({ state: "NM", ahj: "City of Fallowmere" })]);
});

// ---------------------------------------------------------------------------
// The classifier is pure, so the precedence can be asserted without a database: a blocker
// always beats a recipe.
// ---------------------------------------------------------------------------
check("precedence: a refused login beats a complete recipe", () => {
  const verdict = classifyCoverage(
    {
      portalUrl: "https://example.invalid/portal/",
      portalHost: "example.invalid",
      recipeStatus: "complete",
      recipeDetail: "a complete recipe (v9, 50 steps) replays here",
      credential: {
        stored: true, hasSecret: true, usernameReference: "someone", loginAccepted: false, stale: true,
        neverAttempted: false, lastLoginOkAt: "", lastLoginNote: "rejected", matchedBy: "url",
      },
      mfa: { expected: false, relayNamed: false, relay: "", evidence: "" },
      otherDisciplinesWithRecipe: [],
      feeResponsibility: "",
    },
    { track: "permit", portalLabel: "Example City" },
  );
  assert.equal(verdict.bucket, "cannot_file_yet");
});

// ---------------------------------------------------------------------------
// NO SECRET, ANYWHERE. This document is pasted into a customer's report.
// ---------------------------------------------------------------------------
check("neither the printed report nor the JSON carries a password", () => {
  const report = run();
  const rendered = renderCoverageReport(report);
  const json = JSON.stringify(report);
  assert.equal(rendered.includes(PASSWORD), false);
  assert.equal(json.includes(PASSWORD), false);
  // And nothing that smells like an envelope either.
  assert.equal(/encrypted_secret|encryptedSecret/i.test(json), false);
  assert.equal(/password"\s*:/i.test(json), false);
});

check("the report is readable: every row prints its bucket, its reason and what unblocks it", () => {
  const rendered = renderCoverageReport(run());
  for (const label of ["READY NOW", "SUPERVISED FIRST RUN", "CANNOT FILE YET", "why", "unblocks", "SUMMARY"]) {
    assert.ok(rendered.includes(label), `the rendered report is missing "${label}"`);
  }
});

// ---------------------------------------------------------------------------
// --json must print the report and NOTHING ELSE. Only a real run proves that: a stray
// console.log anywhere in the import graph makes the operator's `> coverage.json` unparseable,
// and no in-process assertion can see it.
// ---------------------------------------------------------------------------
check("the CLI's --json output parses as JSON with nothing else on stdout", () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  assert.ok(fs.existsSync(tsxCli), `tsx cli not found at ${tsxCli}`);
  const stdout = execFileSync(
    process.execPath,
    [tsxCli, path.join(repoRoot, "scripts", "coverage-report.ts"), "--db", DB_PATH, "--client", CLIENT, "--jurisdictions", SCOPE, "--json"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, AUTOPILOT_DB_PATH: DB_PATH } },
  );
  const parsed = JSON.parse(stdout) as { rows: Array<{ bucket: string }>; counts: Record<string, number>; client: { id: string } };
  assert.equal(parsed.client.id, CLIENT);
  assert.equal(parsed.rows.length, 6);
  for (const row of parsed.rows) assert.ok(COVERAGE_BUCKETS.includes(row.bucket as never), `unknown bucket "${row.bucket}"`);
  assert.equal(stdout.includes(PASSWORD), false);
});

if (failures) { console.error(`\n${failures} coverage-report check(s) FAILED.`); process.exit(1); }
console.log("\nAll coverage-report checks passed.");
process.exit(0);
