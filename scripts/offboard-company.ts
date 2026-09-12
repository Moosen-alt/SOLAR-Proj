// THE LEAVING PROMISE, EXECUTED. One departing solar company -> their credentials, sessions,
// projects, documents, homeowner records and portal logins gone from our live systems.
//
//   npx tsx scripts/offboard-company.ts <clientId>                      # DRY RUN. Always first.
//   npx tsx scripts/offboard-company.ts <clientId> --confirm <clientId> # irreversible purge
//   npx tsx scripts/offboard-company.ts --list                          # ids and names, to copy from
//
// WHY THIS EXISTS. The onboarding guide tells every customer, in "Your data": if you ever
// leave, change your portal passwords; WE THEN REMOVE YOUR CREDENTIALS, SESSIONS, PROJECTS
// AND DOCUMENTS FROM OUR LIVE SYSTEMS. That sentence was false. The only delete path was the
// dashboard's deleteClient, which removes three tables and REFUSES outright when a project is
// linked — which is every real departing customer. Their encrypted portal passwords, their
// logged-in browser sessions on disk, their projects and every uploaded plan set stayed, with
// no route that removed them. This is that route.
//
// THE CUSTOMER CHANGES THEIR PORTAL PASSWORDS FIRST. We cannot invalidate a session we no
// longer hold: once these files are gone we cannot log in to end anything, and any session
// cookie that leaked before the purge outlives it. Their password change is what actually
// closes the door; this run is what stops us holding the key. Do it in that order.
//
// SAFETY, because there is no undo.
//   - DRY RUN IS THE DEFAULT. Without --confirm nothing is written — not one row, not the
//     audit entry. A real run is the presence of the flag, and the flag carries a value.
//   - --confirm TAKES THE CLIENT ID AND MUST MATCH. A mistyped id is refused, not treated as
//     a dry run and not applied to whatever row the typo happens to name. Both halves matter:
//     the id you fat-finger may be another live customer's.
//   - THE INVENTORY IS PRINTED BEFORE ANYTHING IS TOUCHED, on the dry run and on the real
//     one: N credentials, N projects, N documents, N session directories, N customers. If
//     those numbers are not the company you meant, stop.
//   - IT REFUSES WITHOUT SESSION_ENCRYPTION_KEY (or with the .env.example placeholder). Half
//     of what this destroys is ciphertext keyed by that value; a process that cannot read
//     them is a process pointed at the wrong environment, which is the last moment to purge.
//   - IT WRITES AN AUDIT ROW (client.offboarded) naming what was purged and when, with
//     project_id null so it outlives every project it describes.
//   - IT NEVER PRINTS A SECRET. Credentials are counted, never shown — not even the username.
//
// WHAT IT DELIBERATELY LEAVES: the pooled portal knowledge — portal_recipes,
// permit_utility_knowledge, jurisdiction_code_profiles, ahj_form_templates, cec_equipment.
// The guide draws that line itself: your projects, homeowner records, documents and
// credentials are yours alone; how a portal behaves is shared. Also left: the append-only
// draft ledger (data/portal-drafts.jsonl), which records the drafts we left on their real
// portal account and holds no secret — deleting it would erase the list of what they still
// have to cancel on their side.
//
// EXIT CODES: 0 success (or a clean dry run), 1 usage/refusal, 2 runtime error.
import "dotenv/config";

// Args BEFORE the dynamic imports: openDatabase() is async, takes no path, and reads
// AUTOPILOT_DB_PATH at import time — so --db has to be assigned first. Same reason
// scripts/onboard-company.ts uses `await import` rather than static imports.
const args = process.argv.slice(2);
const flag = (name: string): string => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=").trim();
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1].trim() : "";
};
const hasFlag = (name: string): boolean => args.includes(`--${name}`) || args.some((a) => a.startsWith(`--${name}=`));

const dbFlag = flag("db");
const actorFlag = flag("actor") || "offboard-company script";
const confirmFlag = flag("confirm");
const wantList = args.includes("--list");

const usage = (): void => {
  console.error("Usage: npx tsx scripts/offboard-company.ts <clientId> [--confirm <clientId>] [--db <path>] [--actor=<email>]");
  console.error();
  console.error("  (no flags)          DRY RUN — print the inventory of what would be destroyed, write nothing.");
  console.error("                      Run this first, every time. It is the default posture on purpose.");
  console.error("  --confirm <id>      Perform the purge. The id must MATCH the client being offboarded;");
  console.error("                      a mistyped id is refused outright so it cannot purge the wrong customer.");
  console.error("  --list              Print client ids and names, so the id can be copied rather than typed.");
  console.error("  --db <path>         SQLite file (default: AUTOPILOT_DB_PATH, else backend/data/autopilot.sqlite)");
  console.error("  --actor=<email>     Who ran it. Recorded on the audit row.");
  console.error();
  console.error("BEFORE A REAL RUN: the customer must change their portal passwords FIRST. We cannot");
  console.error("invalidate a session we no longer hold — their password change closes the door, this");
  console.error("run only stops us holding the key.");
};

// The client id is the one positional argument. --confirm's value is a flag value, not a
// positional, so it must not be mistaken for one.
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--db" && args[i - 1] !== "--actor" && args[i - 1] !== "--confirm");
const clientId = positional[0] || "";

if (!wantList && !clientId) {
  usage();
  process.exit(1);
}
if (hasFlag("confirm") && !confirmFlag) {
  console.error("--confirm needs the client id as its value: --confirm <clientId>. A bare --confirm is refused,");
  console.error("because the whole point of the flag is that the id has to be typed back.");
  process.exit(1);
}

if (dbFlag) process.env.AUTOPILOT_DB_PATH = dbFlag;
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

const { openDatabase } = await import("../backend/src/db");
const { offboardClient, offboardInventory } = await import("../backend/src/clients");

const line = (s = ""): void => console.log(s);
const rule = (t: string): void => { line(); line(`── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`); };

let exitCode = 0;
try {
  const db = await openDatabase();

  if (wantList) {
    const rows = db.query<{ id: string; company_name: string; created_at: string }>(
      "SELECT id, company_name, created_at FROM clients ORDER BY company_name, created_at",
    );
    rule("CLIENTS");
    if (rows.length === 0) line("  (none)");
    for (const row of rows) line(`  ${row.id}  ${row.company_name || "(unnamed)"}`);
    line();
    process.exit(0);
  }

  const inventory = offboardInventory(db, clientId);

  rule("OFFBOARDING");
  line(`  client        ${inventory.companyName || "(unnamed)"}`);
  line(`  clientId      ${inventory.clientId}`);
  line(`  database      ${process.env.AUTOPILOT_DB_PATH}`);

  rule("WHAT WOULD BE DESTROYED");
  line(`  portal credentials (encrypted passwords)   ${inventory.portalCredentials}`);
  line(`  projects (and every row reaching them)     ${inventory.projects}`);
  line(`  uploaded documents                         ${inventory.documents}`);
  line(`  customers (homeowner records)              ${inventory.customers}`);
  line(`  communications                             ${inventory.communications}`);
  line(`  per-client email sources                   ${inventory.emailSources}`);
  line(`  portal identities                          ${inventory.portalIdentities}`);
  line(`  portal profiles (stored session blobs)     ${inventory.portalProfiles}`);
  line(`  logged-in session directories on disk      ${inventory.sessionDirs.length}`);
  for (const dir of inventory.sessionDirs) line(`      ${dir}`);
  line(`  session root removed                       ${inventory.sessionRoot}`);
  line(`  the clients row itself                     1`);

  rule("WHAT STAYS, ON PURPOSE");
  line("  Pooled portal knowledge — portal_recipes, permit_utility_knowledge,");
  line("  jurisdiction_code_profiles, ahj_form_templates, cec_equipment. The guide says so:");
  line("  your projects, homeowner records, documents and credentials are yours alone; how a");
  line("  portal behaves is shared. What this customer's filings taught us about an AHJ stays.");
  line("  The append-only draft ledger stays too — it is the list of drafts still sitting in");
  line("  their portal account, and it holds no secret.");

  rule("FIRST, ON THEIR SIDE");
  line("  The customer changes their portal passwords BEFORE this runs. We cannot invalidate a");
  line("  session we no longer hold: once these files are gone we cannot log in to end anything.");
  line("  Their password change closes the door; this run stops us holding the key.");

  if (!confirmFlag) {
    rule("DRY RUN — NOTHING WAS WRITTEN");
    if (!inventory.sessionKeyOk) {
      line("  SESSION_ENCRYPTION_KEY is unset or still the .env.example placeholder. A real run");
      line("  will REFUSE: this purge destroys secrets encrypted under that key, and a process");
      line("  that cannot read them is pointed at the wrong environment.");
      line();
    }
    line("  To perform it, re-run with the client id typed back:");
    line(`      npx tsx scripts/offboard-company.ts ${inventory.clientId} --confirm ${inventory.clientId}`);
    line();
    process.exit(0);
  }

  const result = await offboardClient(db, clientId, { confirm: confirmFlag, actor: actorFlag });

  rule("PURGED");
  line(`  ${inventory.companyName || inventory.clientId} is removed from this database.`);
  line(`  session directories removed                ${result.sessionDirsRemoved.length}`);
  if (result.sessionDirsFailed.length > 0) {
    exitCode = 2;
    line();
    line("  COULD NOT REMOVE THESE SESSION DIRECTORIES — the promise is NOT yet kept:");
    for (const failure of result.sessionDirsFailed) line(`      ${failure.dir}  (${failure.error})`);
    line("  A running Chrome holds a profile's files open. Close every browser this tool started");
    line("  and re-run, or delete the directory by hand. Until then their logged-in session is");
    line("  still on this machine.");
  }
  line();
  line("  An audit row (client.offboarded) records what was purged and when.");
  line("  Confirm with them that their portal passwords were changed. If they were not, do it now:");
  line("  a session cookie that leaked before this run outlives it.");
  line();
} catch (err) {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  console.error();
  console.error(`REFUSED: ${message}`);
  console.error();
  // 400/404/409 are the deliberate refusals (bad confirm, missing key, unknown client) —
  // an operator error, not a crash. Anything else is a runtime failure.
  process.exit(status && status >= 400 && status < 500 ? 1 : 2);
}

process.exit(exitCode);
