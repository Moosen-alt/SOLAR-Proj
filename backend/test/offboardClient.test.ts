// THE LEAVING PROMISE, PINNED.
//
// The onboarding guide tells every customer, in "Your data": if you ever leave, change your
// portal passwords; WE THEN REMOVE YOUR CREDENTIALS, SESSIONS, PROJECTS AND DOCUMENTS FROM
// OUR LIVE SYSTEMS. That sentence was false in every clause. The only delete path was
// deleteClient, which removes three tables — client_portal_identities, portal_profiles, the
// clients row — and REFUSES outright the moment a project is linked, which is every real
// departing customer. So after a company left we were still holding their AES-256-GCM portal
// passwords in portal_credentials, their logged-in Chrome sessions under
// portal-profiles/<clientId>/ (three such directories exist on this machine today), every
// project, every homeowner record and every uploaded plan set, with no route that removed
// any of it.
//
// offboardClient is the route. It is irreversible, so this test pins the SAFETY as hard as
// the deletion — a purge that destroys the wrong customer is worse than one that never runs:
//
//   1. DRY RUN IS THE DEFAULT. No confirm, no writes — not one row, not even the audit entry.
//   2. A MISTYPED --confirm IS A REFUSAL, not a quiet dry run and not a purge of whatever row
//      the typo named. KILL-TEST: make offboardClient fall through to a dry run on mismatch
//      and this suite fails on the throw AND on the "nothing changed" follow-up.
//   3. THE PURGE ACTUALLY REMOVES the credentials, the projects and their documents, the
//      customer, the on-disk session directory and the client row.
//   4. THE POOLED KNOWLEDGE SURVIVES BYTE-IDENTICAL. permit_utility_knowledge, portal_recipes
//      and the rest are shared ON PURPOSE — an AHJ quirk a departing customer's filings
//      taught us belongs to every other customer, and the guide says so. KILL-TEST: add
//      `DELETE FROM portal_recipes` to the purge and this suite fails on the deep-equal.
//   5. THE NEIGHBOUR IS UNTOUCHED. A second client's credentials, project, customer and
//      session directory are all still there afterwards.
//   6. AN AUDIT ROW NAMES WHAT WAS PURGED, with project_id null so it outlives every project
//      it describes.
//
// Browser-free, scratch DB, scratch PORTAL_PROFILES_DIR (without that second one this test
// would delete the real portal-profiles/ tree in the repo).
// Run: tsx backend/test/offboardClient.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "offboard-client-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "portal-profiles");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "project-documents");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient, deleteClient, offboardClient, offboardInventory } = await import("../src/clients");
const { createPortalCredential } = await import("../src/portalCredentials");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const checkAsync = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------
// Seed. Two clients: one leaving, one staying. The neighbour is not decoration — the
// mistyped-id case is dangerous exactly because the typo names a live row.
// ---------------------------------------------------------------------------
const LEAVING = createClient(db, { companyName: "Departing Solar LLC", ccbLicenseNumber: "223690" } as never).id;
const STAYING = createClient(db, { companyName: "Still Here Solar", ccbLicenseNumber: "998877" } as never).id;

const now = new Date().toISOString();
let seq = 0;
const nid = (prefix: string): string => `${prefix}-${++seq}`;

function seedProject(clientId: string, homeowner: string): string {
  const projectId = nid("proj");
  db.run(
    `INSERT INTO projects (id, client_id, homeowner_name, project_address, city, state, zip, ahj, utility,
      status, current_stage, parser_json, created_at, updated_at, org_id)
     VALUES (?, ?, ?, ?, 'Coos Bay', 'OR', '97420', 'Coos Bay', 'Pacific Power', 'intake', 'intake', '{}', ?, ?, ?)`,
    [projectId, clientId, homeowner, "12 Sample St", now, now, DEFAULT_ORG_ID],
  );
  return projectId;
}

function seedDocument(projectId: string, filename: string): string {
  const stored = path.join(tmpDir, "project-documents", projectId, filename);
  fs.mkdirSync(path.dirname(stored), { recursive: true });
  fs.writeFileSync(stored, "plan set bytes", "utf8");
  db.run(
    `INSERT INTO project_documents (id, project_id, doc_type, original_filename, stored_path, content_type,
      size_bytes, source, uploaded_by, uploaded_at)
     VALUES (?, ?, 'plan_set', ?, ?, 'application/pdf', 14, 'upload', 'test', ?)`,
    [nid("doc"), projectId, filename, stored, now],
  );
  return stored;
}

function seedCustomer(clientId: string, name: string): string {
  const customerId = nid("cust");
  db.run(
    `INSERT INTO customers (id, name, email, phone, address, city, state, zip, lead_source, lead_stage,
      client_id, assigned_user_id, notes, created_at, updated_at, org_id)
     VALUES (?, ?, ?, '555-0100', '12 Sample St', 'Coos Bay', 'OR', '97420', 'referral', 'new_lead',
      ?, '', '', ?, ?, ?)`,
    [customerId, name, `${name.split(" ")[0].toLowerCase()}@example.com`, clientId, now, now, DEFAULT_ORG_ID],
  );
  return customerId;
}

function seedSessionDir(clientId: string, portalType: string, host: string): string {
  const dir = path.join(process.env.PORTAL_PROFILES_DIR as string, clientId, portalType, host);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Cookies"), "a-live-logged-in-session", "utf8");
  return dir;
}

// The departing customer's world.
const LEAVING_PROJECTS = [seedProject(LEAVING, "Ada Marsh"), seedProject(LEAVING, "Bo Ng")];
const LEAVING_DOC_PATHS = [
  seedDocument(LEAVING_PROJECTS[0], "plans.pdf"),
  seedDocument(LEAVING_PROJECTS[0], "meter.jpg"),
  seedDocument(LEAVING_PROJECTS[1], "plans.pdf"),
];
const LEAVING_CUSTOMER = seedCustomer(LEAVING, "Ada Marsh");
const LEAVING_SESSION_DIR = seedSessionDir(LEAVING, "AHJ", "aca-oregon.accela.com");
seedSessionDir(LEAVING, "utility", "pge.powerclerk.com");
createPortalCredential(db, LEAVING, {
  portalType: "OR · Accela", portalUrl: "https://aca-oregon.accela.com/oregon/", username: "departing.permits", password: "x",
});
createPortalCredential(db, LEAVING, {
  portalType: "utility", portalUrl: "https://pge.powerclerk.com/", username: "departing.nem", password: "y",
});
db.run(
  `INSERT INTO communications (id, customer_id, project_id, direction, channel, subject, body, logged_by, occurred_at, created_at, org_id)
   VALUES (?, ?, NULL, 'outbound', 'email', 'Your permit', 'Hello Ada, your permit is approved.', 'ops', ?, ?, ?)`,
  [nid("comm"), LEAVING_CUSTOMER, now, now, DEFAULT_ORG_ID],
);
db.run(
  `INSERT INTO communications (id, customer_id, project_id, direction, channel, subject, body, logged_by, occurred_at, created_at, org_id)
   VALUES (?, NULL, ?, 'inbound', 'email', 'Correction', 'AHJ wants a revised single line.', 'ops', ?, ?, ?)`,
  [nid("comm"), LEAVING_PROJECTS[1], now, now, DEFAULT_ORG_ID],
);
db.run(
  `INSERT INTO email_tracking_sources (id, source_type, label, file_path, client_id, created_at, updated_at, org_id)
   VALUES (?, 'imap', 'Departing inbox', ?, ?, ?, ?, ?)`,
  [nid("src"), "imap://departing", LEAVING, now, now, DEFAULT_ORG_ID],
);
db.run(
  `INSERT INTO portal_profiles (id, client_id, portal_name, portal_type, portal_url, username_reference,
    encrypted_storage_state, created_at)
   VALUES (?, ?, 'Coos Bay ACA', 'AHJ', 'https://aca-oregon.accela.com/oregon/', 'departing.permits', 'ciphertext', ?)`,
  [nid("prof"), LEAVING, now],
);
db.run(
  `INSERT INTO client_portal_identities (id, client_id, portal_type, installer_company_label, installer_contact_code, notes, created_at)
   VALUES (?, ?, 'OR · Accela', 'DEPARTING SOLAR LLC', '', '', ?)`,
  [nid("ident"), LEAVING, now],
);

// The neighbour's world — every one of these must be untouched afterwards.
const STAYING_PROJECT = seedProject(STAYING, "Cy Okoro");
const STAYING_CUSTOMER = seedCustomer(STAYING, "Cy Okoro");
const STAYING_SESSION_DIR = seedSessionDir(STAYING, "AHJ", "aca-oregon.accela.com");
createPortalCredential(db, STAYING, {
  portalType: "OR · Accela", portalUrl: "https://aca-oregon.accela.com/oregon/", username: "stillhere.permits", password: "z",
});

// The pooled knowledge. Shared ON PURPOSE — this is the product's core asset and it is NOT
// the departing customer's to take with them.
db.run(
  `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_name, portal_url,
    confidence, notes, first_seen_at, last_learned_at, updated_at)
   VALUES ('kb-1', 'OR|Coos Bay|Pacific Power', 'OR', 'Coos Bay', 'Pacific Power', 'Accela ACA',
    'https://aca-oregon.accela.com/oregon/', 'mixed', 'Upload the single line LAST or ACA drops it.', ?, ?, ?)`,
  [now, now, now],
);
db.run(
  `INSERT INTO portal_recipes (id, scope_type, profile_key, state, ahj, utility, portal_platform, portal_url,
    status, version, steps_json, created_by, created_at, updated_at, notes)
   VALUES ('recipe-1', 'ahj', 'OR|Coos Bay|', 'OR', 'Coos Bay', '', 'accela',
    'https://aca-oregon.accela.com/oregon/', 'complete', 3, '[{"action":"click"}]', 'learn', ?, ?, '')`,
  [now, now],
);

const knowledgeSnapshot = (): unknown =>
  JSON.parse(JSON.stringify({
    knowledge: db.query("SELECT * FROM permit_utility_knowledge ORDER BY id"),
    recipes: db.query("SELECT * FROM portal_recipes ORDER BY id"),
  }));
const KNOWLEDGE_BEFORE = knowledgeSnapshot();

const count = (sql: string, params: unknown[] = []): number =>
  Number(db.get<{ n: number }>(sql, params as never)?.n ?? 0);
const leavingCounts = () => ({
  clients: count("SELECT COUNT(*) AS n FROM clients WHERE id = ?", [LEAVING]),
  credentials: count("SELECT COUNT(*) AS n FROM portal_credentials WHERE client_id = ?", [LEAVING]),
  projects: count("SELECT COUNT(*) AS n FROM projects WHERE client_id = ?", [LEAVING]),
  customers: count("SELECT COUNT(*) AS n FROM customers WHERE client_id = ?", [LEAVING]),
  emailSources: count("SELECT COUNT(*) AS n FROM email_tracking_sources WHERE client_id = ?", [LEAVING]),
  identities: count("SELECT COUNT(*) AS n FROM client_portal_identities WHERE client_id = ?", [LEAVING]),
  profiles: count("SELECT COUNT(*) AS n FROM portal_profiles WHERE client_id = ?", [LEAVING]),
});
const FULL_BEFORE = leavingCounts();
const auditCount = (): number => count("SELECT COUNT(*) AS n FROM audit_logs");
const AUDIT_BEFORE = auditCount();

// ---------------------------------------------------------------------------
// 1. The inventory an operator sees before authorising anything.
// ---------------------------------------------------------------------------
await checkAsync("THE DRY RUN IS THE DEFAULT: no confirm, no writes at all", async () => {
  const result = await offboardClient(db, LEAVING);
  assert.equal(result.dryRun, true, "a call with no confirm must never purge");
  assert.deepEqual(leavingCounts(), FULL_BEFORE, "a dry run changed rows");
  assert.equal(auditCount(), AUDIT_BEFORE, "a dry run wrote an audit row — it must write NOTHING");
  assert.equal(fs.existsSync(LEAVING_SESSION_DIR), true, "a dry run removed a session directory");
  assert.deepEqual(result.sessionDirsRemoved, []);
});

check("...and it counts exactly what a purge would destroy", () => {
  const inv = offboardInventory(db, LEAVING);
  assert.equal(inv.companyName, "Departing Solar LLC");
  assert.equal(inv.portalCredentials, 2, "the encrypted portal passwords — the row that matters most");
  assert.equal(inv.projects, 2);
  assert.equal(inv.documents, 3);
  assert.equal(inv.customers, 1);
  assert.equal(inv.communications, 2, "one reached through the customer, one through a project");
  assert.equal(inv.emailSources, 1);
  assert.equal(inv.portalIdentities, 1);
  assert.equal(inv.portalProfiles, 1);
  assert.equal(inv.sessionDirs.length, 2, "one logged-in browser profile per portal");
  assert.equal(inv.sessionKeyOk, true);
});

check("the inventory is scoped to ONE client — the neighbour is not in it", () => {
  const inv = offboardInventory(db, LEAVING);
  assert.ok(!inv.sessionDirs.some((d) => d.includes(STAYING)), "another client's session directory is in the kill list");
  const neighbour = offboardInventory(db, STAYING);
  assert.equal(neighbour.projects, 1);
  assert.equal(neighbour.portalCredentials, 1);
});

check("an unknown client is a 404, not an empty purge", () => {
  assert.throws(() => offboardInventory(db, "client-does-not-exist"), /not found/i);
});

// ---------------------------------------------------------------------------
// 2. The refusal. This is the half that keeps the purge from being a weapon.
// ---------------------------------------------------------------------------
await checkAsync("A MISTYPED --confirm IS REFUSED — and the id typed may be a LIVE neighbour", async () => {
  await assert.rejects(
    () => offboardClient(db, LEAVING, { confirm: STAYING }),
    /--confirm does not match/,
    "a mismatched confirm must THROW; falling back to a dry run would read as 'it ran'",
  );
  assert.deepEqual(leavingCounts(), FULL_BEFORE, "the refused run still deleted the target's rows");
  assert.equal(
    count("SELECT COUNT(*) AS n FROM clients WHERE id = ?", [STAYING]), 1,
    "the refused run purged the client whose id was mistyped in — the exact disaster",
  );
  assert.equal(count("SELECT COUNT(*) AS n FROM portal_credentials WHERE client_id = ?", [STAYING]), 1);
  assert.equal(auditCount(), AUDIT_BEFORE, "a refusal wrote an audit row for a purge that did not happen");
});

await checkAsync("a near-miss id (right prefix, wrong tail) is refused too", async () => {
  await assert.rejects(() => offboardClient(db, LEAVING, { confirm: `${LEAVING}x` }), /--confirm does not match/);
  await assert.rejects(() => offboardClient(db, LEAVING, { confirm: LEAVING.slice(0, -1) }), /--confirm does not match/);
  assert.deepEqual(leavingCounts(), FULL_BEFORE);
});

await checkAsync("IT REFUSES WITHOUT SESSION_ENCRYPTION_KEY — half of what it destroys is ciphertext", async () => {
  const saved = process.env.SESSION_ENCRYPTION_KEY;
  try {
    delete process.env.SESSION_ENCRYPTION_KEY;
    assert.equal(offboardInventory(db, LEAVING).sessionKeyOk, false, "the dry run must SAY the key is missing");
    await assert.rejects(() => offboardClient(db, LEAVING, { confirm: LEAVING }), /SESSION_ENCRYPTION_KEY is unset/);
    process.env.SESSION_ENCRYPTION_KEY = "replace-with-a-long-random-secret";
    await assert.rejects(() => offboardClient(db, LEAVING, { confirm: LEAVING }), /placeholder/);
    assert.deepEqual(leavingCounts(), FULL_BEFORE, "a key refusal must not half-purge");
  } finally {
    process.env.SESSION_ENCRYPTION_KEY = saved;
  }
});

// ---------------------------------------------------------------------------
// 3. The purge itself.
// ---------------------------------------------------------------------------
let purged!: Awaited<ReturnType<typeof offboardClient>>;
await checkAsync("THE PROMISE: a confirmed purge removes credentials, sessions, projects and documents", async () => {
  purged = await offboardClient(db, LEAVING, { confirm: LEAVING, actor: "ops@operator.test" });
  assert.equal(purged.dryRun, false);
  assert.equal(count("SELECT COUNT(*) AS n FROM portal_credentials WHERE client_id = ?", [LEAVING]), 0,
    "the encrypted portal passwords are still here — this is the sentence the guide breaks");
  assert.equal(count("SELECT COUNT(*) AS n FROM projects WHERE client_id = ?", [LEAVING]), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM customers WHERE client_id = ?", [LEAVING]), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM clients WHERE id = ?", [LEAVING]), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM email_tracking_sources WHERE client_id = ?", [LEAVING]), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM client_portal_identities WHERE client_id = ?", [LEAVING]), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM portal_profiles WHERE client_id = ?", [LEAVING]), 0);
});

check("the on-disk logged-in sessions are gone, not just the DB rows", () => {
  assert.equal(fs.existsSync(LEAVING_SESSION_DIR), false, "a cookie jar that still opens their portal account");
  assert.equal(fs.existsSync(path.join(process.env.PORTAL_PROFILES_DIR as string, LEAVING)), false);
  assert.equal(purged.sessionDirsFailed.length, 0, JSON.stringify(purged.sessionDirsFailed));
  assert.equal(purged.sessionDirsRemoved.length, 2);
});

check("everything reaching a project went with it — documents, rows AND files", () => {
  for (const projectId of LEAVING_PROJECTS) {
    assert.equal(count("SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ?", [projectId]), 0);
  }
  for (const stored of LEAVING_DOC_PATHS) {
    assert.equal(fs.existsSync(stored), false, `plan set left on disk: ${stored}`);
  }
});

check("the homeowner correspondence is gone, not merely unlinked", () => {
  // Both cascades only NULL these out — deleteProject NULLs project_id, deleteCustomer NULLs
  // customer_id — so run in sequence a comms row survives BOTH, orphaned, still carrying the
  // homeowner's name and the body of the email. offboardClient deletes them first.
  assert.equal(count("SELECT COUNT(*) AS n FROM communications WHERE customer_id = ?", [LEAVING_CUSTOMER]), 0);
  assert.equal(
    count("SELECT COUNT(*) AS n FROM communications WHERE customer_id IS NULL AND project_id IS NULL"), 0,
    "an orphaned communication is homeowner correspondence nobody will ever find again",
  );
});

// ---------------------------------------------------------------------------
// 4. What must NOT have moved.
// ---------------------------------------------------------------------------
check("THE POOLED KNOWLEDGE SURVIVES BYTE-IDENTICAL — it was never theirs to take", () => {
  assert.deepEqual(
    knowledgeSnapshot(), KNOWLEDGE_BEFORE,
    "a portal quirk this customer's filings taught us belongs to every other customer; the guide says so",
  );
});

check("the neighbouring client is untouched — rows, credentials and session alike", () => {
  assert.equal(count("SELECT COUNT(*) AS n FROM clients WHERE id = ?", [STAYING]), 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM portal_credentials WHERE client_id = ?", [STAYING]), 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM projects WHERE id = ?", [STAYING_PROJECT]), 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM customers WHERE id = ?", [STAYING_CUSTOMER]), 1);
  assert.equal(fs.existsSync(STAYING_SESSION_DIR), true, "we deleted a paying customer's live session");
});

check("AN AUDIT ROW NAMES WHAT WAS PURGED, and outlives the projects it describes", () => {
  const row = db.get<{ project_id: string | null; actor_name: string; details: string; created_at: string }>(
    "SELECT project_id, actor_name, details, created_at FROM audit_logs WHERE action = 'client.offboarded'",
  );
  assert.ok(row, "no audit row: an irreversible purge with no record of what it took");
  assert.equal(row.project_id, null, "a project_id here would point at a row this purge just deleted");
  assert.equal(row.actor_name, "ops@operator.test");
  const details = JSON.parse(row.details) as Record<string, unknown>;
  assert.equal(details.clientId, LEAVING);
  assert.equal(details.companyName, "Departing Solar LLC");
  assert.deepEqual(details.purged, {
    portalCredentials: 2, projects: 2, documents: 3, customers: 1,
    communications: 2, emailSources: 1, portalIdentities: 1, portalProfiles: 1,
  });
  assert.equal(details.sessionDirsRemoved, 2);
  assert.ok(Array.isArray(details.sharedKnowledgeRetained) && (details.sharedKnowledgeRetained as string[]).includes("portal_recipes"),
    "the audit row must record that leaving the shared knowledge was a DECISION, not a miss");
  assert.ok(row.created_at, "when it happened is half the point of an audit row");
});

// ---------------------------------------------------------------------------
// 5. The ordinary dashboard path stays hard. The two are deliberately different.
// ---------------------------------------------------------------------------
check("deleteClient still REFUSES a client with projects — a misclick must not purge anything", () => {
  assert.throws(() => deleteClient(db, STAYING), /project\(s\) are still linked/);
  assert.equal(count("SELECT COUNT(*) AS n FROM clients WHERE id = ?", [STAYING]), 1);
});

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* windows file locks */ }

console.log(failures === 0 ? "\noffboardClient: all checks passed" : `\noffboardClient: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
