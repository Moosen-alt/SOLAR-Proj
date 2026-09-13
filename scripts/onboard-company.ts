// ONE FILLED-IN INTAKE FILE -> EVERY ROW A NEW SOLAR COMPANY NEEDS, idempotently.
//
//   npx tsx scripts/onboard-company.ts ~/intake/<company>.json --dry-run   # ALWAYS start here
//   npx tsx scripts/onboard-company.ts ~/intake/<company>.json             # writes
//   npx tsx scripts/onboard-company.ts ~/intake/<company>.json --db backend/data/scratch.sqlite
//   npx tsx scripts/onboard-company.ts --example > ~/intake/<company>.json # a blank to fill in
//
// KEEP THE INTAKE FILE OUT OF THE REPO. A filled intake is a PLAINTEXT list of live portal
// passwords, with no encryption and no access control. Nothing under the repo is gitignored
// by default, so `--example > intake.json` in the working tree is one `git add .` away from
// committing every password in it. Write it to ~/intake/ (or any path outside the tree),
// run it, then delete it — the secrets then live only in portal_credentials.encrypted_secret.
//
// WHICH LANE ARE YOU IN? This is the decision that everything else follows from.
//
//   LANE A - SERVICE BUREAU (this is what the product does today, and the default here).
//     The new solar company is a `clients` row inside the OPERATOR'S OWN org (org-default).
//     No org row, no entitlements, no logins for them: the operator stages the filings. This
//     is the COMPLETE path to a staged submission. Omit the org block and the users block.
//
//   LANE B - THE COMPANY LOGS IN AS ITS OWN TENANT. Requires `org.createTenant: true`, and
//     it is a DEAD END TODAY, so do not start down it expecting to finish:
//       * POST /api/orgs/:id/users hardcodes role 'operator'. There is no role-elevation
//         route and no password-reset route, so a new tenant org can never get its own admin
//         and can never administer itself.
//       * 'autopilot' is the wildcard product and the ONLY one that unlocks staging, and it
//         is apiKeyAuth:false. An org holding only permit_reviewer/form_filler can never
//         stage anything at all, by key or by session.
//     Finishing Lane B needs product work (a set-password route and a role writer), not a
//     bigger intake file. Until then a tenant org is a row that can log in and do nothing.
//
// WHY THIS EXISTS. Onboarding a company today is five separate surfaces and no checklist:
// a superadmin-only HTTP route for the org (POST /api/orgs — no UI anywhere, curl only),
// grantProduct for the licence, createClient for the licence/business fields, createUser
// for the logins, and createPortalCredential once per portal account. Nothing enforces the
// order and nothing tells you what you skipped. Every miss shows up LATER, somewhere else,
// looking like a bug:
//   - org row created by hand with no org_entitlements rows -> every /api/* request 403s
//     "This account has no active product licence." The org exists and reaches nothing.
//   - client created without ccbLicenseNumber -> the filing looks fine for three days and
//     then prepareSubmission 409s {needsCcb} at the moment someone tries to stage it.
//   - client created with blank business address/phone/email -> nothing throws at all. The
//     portal is filled with blank installer fields and the AHJ rejects the application.
//     That is the quiet one, and it costs a week.
//   - a user created with createUser or POST /api/users has no password_hash, so the login
//     you just "created" cannot log in, and there is no set-password route to fix it with.
//   - a credential stored against the wrong portal_url is never found again: credential
//     selection matches on host AND first path segment and REFUSES rather than guessing,
//     because Accela serves a dozen cities from one host.
// So: one file, one command, one report, run it twice and the second run must say
// "already exists, unchanged" for every row.
//
// SAFETY.
//   - --dry-run is the posture to run first: it prints exactly what would be created or
//     changed and writes nothing. A real run is the absence of the flag.
//   - Never prints secrets. Portal passwords, security answers, login passwords and EIN are
//     shown only as "set"/"missing"; field changes are reported by field NAME, never value.
//   - Additive and idempotent. It creates rows, and it updates only the fields this intake
//     names on rows it matched. It never deletes a client, never revokes a product, never
//     rotates a password that is already set, and never moves a client between orgs.
//   - It NEVER mints a tenant by accident. A new org row is created only for an explicit
//     `org.createTenant: true`; an org.name on its own is ignored (loudly). A silently
//     separate tenant is the worst outcome here, because it is invisible: the operator's own
//     org-scoped dashboard and routes cannot see it, and per LANE B above it can never get
//     its own admin, so nobody inside it can see it either.
//   - It NEVER adds a login to the OPERATOR'S tenant without --allow-operator-org-user. In
//     the service-bureau lane a `users` entry is not the customer's login; it is a new
//     password-bearing account inside org-default, which reaches every client the operator
//     serves. That has to be typed, not inherited from a template.
//   - It writes NO knowledge-base rows, so there is nothing here that could overwrite
//     human-verified knowledge (confidence "mixed"/"verified", map.verified).
//   - It refuses a real run when SESSION_ENCRYPTION_KEY is unset or still the .env.example
//     placeholder. Credentials encrypted under an ephemeral key are unreadable forever, and
//     the failure is SILENT later: the decrypt helpers catch and return null, so the symptom
//     is "no stored credential for this client/portal" months from now.
//   - It does NOT create portal accounts. Every AHJ/utility login must already have been
//     registered by a human on the portal's own site (many email a one-time code), and
//     automation never solves CAPTCHA/MFA, never pays a fee, and never clicks final submit.
//
// EXIT CODES: 0 success (or a clean dry run), 1 intake validation failure, 2 runtime error.
import "dotenv/config";
import fs from "node:fs";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Args BEFORE the dynamic imports: openDatabase() is async, takes no path, and reads
// AUTOPILOT_DB_PATH at import time — so --db has to be parsed and assigned first. That
// ordering is the whole reason scripts/ uses `await import` instead of static imports.
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const wantExample = args.includes("--example");
const flag = (name: string): string => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=").trim();
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1].trim() : "";
};
const dbFlag = flag("db");
const actorFlag = flag("actor") || "onboard-company script";
/** Opt-in for the one thing the service-bureau lane should never do silently: create a
 *  password-bearing login inside the OPERATOR'S own tenant (org-default). */
const allowOperatorOrgUser = args.includes("--allow-operator-org-user");

const EXAMPLE_INTAKE = {
  _comment: [
    "A FILLED COPY OF THIS FILE IS A PLAINTEXT LIST OF LIVE PORTAL PASSWORDS. Keep it outside",
    "the repo (~/intake/<company>.json), run it, then delete it.",
    "",
    "This example is the SERVICE-BUREAU LANE (lane A), which is what the product does today:",
    "the company becomes a `clients` row inside the operator's own org (org-default) and the",
    "operator stages its filings. There is deliberately NO org block and no users entry — that",
    "is not an omission to fill in, it is the whole lane. A client in org-default is the",
    "complete path to a staged submission.",
    "",
    "LANE B (the company logs in as its own tenant) is a DEAD END today: POST /api/orgs/:id/users",
    "hardcodes role 'operator', and there is no password-reset route and no role-elevation route,",
    "so a new tenant org can never get its own admin. Only the 'autopilot' product unlocks",
    "staging and it refuses API keys, so a review-gate-only org cannot stage at all. If you have",
    "read that and still want it, the shape is an explicit opt-in — nothing else creates an org:",
    "  \"org\": { \"createTenant\": true, \"name\": \"Sunrise Solar Co\", \"edition\": \"full\" },",
    "  \"entitlements\": [\"autopilot\"],",
    "  \"users\": [{ \"name\": \"Dana Ruiz\", \"email\": \"dana@example.com\", \"password\": \"typed-here-once\" }]",
    "and `users` is REQUIRED there, because a tenant with no login is a row nobody can reach.",
    "",
    "An existing tenant is addressed by \"org\": { \"id\": \"org-1234abcd\" } — an id that does not",
    "already exist is refused, never created, unless createTenant is also true.",
  ],
  client: {
    companyName: "Sunrise Solar Co",
    legalBusinessName: "Sunrise Solar Company LLC",
    dba: "",
    contactName: "Dana Ruiz",
    contactEmail: "dana@example.com",
    phone: "503-555-0100",
    ccbLicenseNumber: "223690",
    ccbExpiration: "2027-04-30",
    electricalLicenseNumber: "",
    electricianLicenseNumber: "",
    electricalSupervisorName: "",
    metroCityLicenseNumber: "",
    docketNumber: "",
    businessAddress: "1400 SW Alder St",
    businessCity: "Portland",
    businessState: "OR",
    businessZip: "97205",
    businessPhone: "503-555-0100",
    businessEmail: "permits@example.com",
    ein: "",
    bondCarrier: "",
    insuranceCarrier: "",
    authorizedSignerName: "Dana Ruiz",
    authorizedSignerTitle: "Owner",
    standardDisconnectMake: "Eaton",
    standardDisconnectModel: "DG221URB",
    billingMode: "",
    serviceFeeUsd: null,
    billingStatus: "active",
    notes: "",
    portalIdentities: [
      { portalType: "OR · Accela Citizen Access", installerCompanyLabel: "SUNRISE SOLAR CO", installerContactCode: "", notes: "" },
    ],
  },
  // EMPTY ON PURPOSE. In the service-bureau lane a `users` entry does not create a login for
  // the customer — it creates one inside the OPERATOR'S org, which reaches every client the
  // operator serves. This script refuses that without --allow-operator-org-user.
  users: [],
  portalCredentials: [
    {
      portalType: "OR · Accela Citizen Access",
      portalUrl: "https://aca-oregon.accela.com/oregon/",
      username: "sunrise.permits",
      password: "typed-here-once-then-delete-this-file",
      securityAnswers: "mother's maiden name: Reyes",
      notes: "non-secret operational hints only — this column is LLM-visible",
    },
  ],
};

if (wantExample) {
  console.log(JSON.stringify(EXAMPLE_INTAKE, null, 2));
  // stderr, so it survives `--example > file` without corrupting the JSON.
  console.error("Redirect this OUTSIDE the repo — e.g. `> ~/intake/<company>.json`. A filled intake holds live");
  console.error("portal passwords in plaintext, nothing here is gitignored, and `git add .` would commit them.");
  process.exit(0);
}

// Accept the path positionally or as --intake=<path> (what docs/ONBOARDING.md shows).
const intakePath = flag("intake") || args.find((a) => !a.startsWith("--") && a !== dbFlag && a !== actorFlag) || "";
if (!intakePath) {
  console.error("Usage: npx tsx scripts/onboard-company.ts ~/intake/<company>.json [--dry-run] [--db <path>] [--actor=<email>]");
  console.error("  --dry-run   report what would be created/changed and write nothing. Run this first.");
  console.error("  --db        SQLite file to write (default: AUTOPILOT_DB_PATH, else backend/data/autopilot.sqlite)");
  console.error("  --intake    the intake file, if you would rather not pass it positionally");
  console.error("  --example   print a blank intake file to fill in, and exit (redirect it OUTSIDE the repo)");
  console.error("  --allow-operator-org-user   permit a login to be created inside the OPERATOR'S own tenant");
  console.error("              (org-default). Needed only in the service-bureau lane, and rarely wanted: that");
  console.error("              account reaches every client the operator serves, not just this company's.");
  process.exit(1);
}
if (!fs.existsSync(intakePath)) {
  console.error(`Intake file not found: ${intakePath}`);
  process.exit(1);
}

if (dbFlag) process.env.AUTOPILOT_DB_PATH = dbFlag;
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

const { openDatabase, DEFAULT_ORG_ID } = await import("../backend/src/db");
const { createClient, updateClient, getClient } = await import("../backend/src/clients");
const { createUser, updateUser } = await import("../backend/src/users");
// The ONE writer of users.password_hash outside the seed path. Imported rather than
// re-implemented: the format is scrypt(pw, 16-byte salt, 64) as "salthex:hashhex" and
// verifyPassword in auth.ts is its only reader, so a second copy of the hasher here would
// be a login that silently cannot log in the moment either side changed.
const { setUserPassword } = await import("../backend/src/auth");
const { createPortalCredential, updatePortalCredential } = await import("../backend/src/portalCredentials");
const { grantProduct, orgEntitlements, productsForEdition, PRODUCT_KEYS } = await import("../backend/src/entitlements");
const { addAuditLog } = await import("../backend/src/audit");
const { decryptStorageState } = await import("../portal-bot/src/cryptoStorage");

// ---------------------------------------------------------------------------
// Output helpers — sectioned plain text, no colour, no emoji, two-space detail indent.
// ---------------------------------------------------------------------------
const line = (s = ""): void => console.log(s);
const rule = (t: string): void => { line(); line(`── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`); };
const secretState = (v: string): string => (v ? "set" : "missing");

// ---------------------------------------------------------------------------
// The intake shape. Every client key below maps 1:1 to a FIELD_COLUMNS pair in
// backend/src/clients.ts — the COMPLETE writable set. Anything else in the intake's client
// block is silently ignored by createClient, so unknown keys are reported as a warning
// rather than quietly dropped. docketNumber is in this list on purpose: it is writable and
// it feeds clientStagingOverlay, and it is the one field the licensing-column lists in the
// docs keep leaving out.
// ---------------------------------------------------------------------------
const CLIENT_FIELDS = [
  "companyName", "contactName", "contactEmail", "phone", "billingStatus", "notes",
  "legalBusinessName", "dba", "ccbLicenseNumber", "standardDisconnectMake", "standardDisconnectModel",
  "ccbExpiration", "electricalLicenseNumber", "docketNumber", "metroCityLicenseNumber",
  "electricalSupervisorName", "electricianLicenseNumber", "businessAddress", "businessCity",
  "businessState", "businessZip", "businessPhone", "businessEmail", "ein", "bondCarrier",
  "insuranceCarrier", "authorizedSignerName", "authorizedSignerTitle", "billingMode", "serviceFeeUsd",
  // The v18 five. intake-template.json has collected these since the column landed; until they
  // reached ClientRecord and FIELD_COLUMNS this list rejected them with "is not a writable
  // client field", so an operator filling the template correctly got a warning and a dropped
  // value. updatesInbox is the address every automated status update is sent to.
  "updatesInbox", "billingContactEmail", "licenseState", "insuranceExpiry", "bondExpiry",
] as const;

/** Fields that never throw when blank but silently produce blank PORTAL fields, which is a
 *  rejected filing three days later. Warned about, never fatal — some companies genuinely
 *  have no electrical supervisor, and the operator is the one who knows. */
const OVERLAY_FIELDS = ["businessAddress", "businessCity", "businessState", "businessZip", "businessPhone", "businessEmail", "authorizedSignerName"] as const;

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const norm = (v: string): string => v.trim().toLowerCase();

let intake: Json;
try {
  intake = obj(JSON.parse(fs.readFileSync(intakePath, "utf8")));
} catch (err) {
  console.error(`Intake file is not valid JSON: ${(err as Error).message}`);
  process.exit(1);
}

const orgIn = obj(intake.org);
const clientIn = obj(intake.client);
const usersIn = arr(intake.users).map(obj);
const credsIn = arr(intake.portalCredentials).map(obj);

// ---------------------------------------------------------------------------
// VALIDATE EVERYTHING BEFORE OPENING THE DATABASE FOR WRITES. A half-onboarded company is
// worse than none: it looks provisioned and fails at staging time.
// ---------------------------------------------------------------------------
const problems: string[] = [];
const warnings: string[] = [];

// ---------------------------------------------------------------------------
// WHICH LANE. Decided here, from the intake alone, because almost every rule below reads
// differently in the two lanes — whether `users` is required, whether products are granted,
// and what a stray org.name means.
//
// The rule is: NOTHING creates an org except an explicit `org.createTenant: true`. An
// org.name on its own used to be enough, and the shipped template has exactly that shape
// (id: "", name: "EXAMPLE SOLAR LLC"), so ordinary onboarding minted a brand-new tenant and
// put the customer inside it. That failure is invisible from both sides: the operator's own
// dashboard and API routes are org-scoped and cannot see the row, and the new tenant can
// never get an admin of its own to look at it (POST /api/orgs/:id/users hardcodes role
// 'operator'; there is no role-elevation route and no password-reset route). The customer
// then exists, is billed for, and is unreachable. A loud warning is strictly better.
// ---------------------------------------------------------------------------
const orgIdIn = str(orgIn.id);
const orgNameIn = str(orgIn.name);
const createTenantIn = orgIn.createTenant === true;
/** True when this intake addresses an org at all (lane B). False = service-bureau lane. */
const tenantLane = Boolean(orgIdIn) || (createTenantIn && Boolean(orgNameIn));

if (createTenantIn && !orgNameIn) {
  problems.push(
    "org.createTenant is true but org.name is blank. A tenant is identified by name in every report " +
    "and in the admin UI; refusing rather than creating an unnamed org.",
  );
}
if (!tenantLane && (orgNameIn || orgIn.edition != null || orgIn.products != null || intake.entitlements != null)) {
  warnings.push(
    `org${orgNameIn ? ` "${orgNameIn}"` : ""} is IGNORED — this run is the service-bureau lane. ` +
    "The client will be created inside the operator's own tenant (org-default), which is the complete " +
    "path to a staged filing. No org row, no entitlement grant, no login is created for this company. " +
    "To create a separate tenant you must say so explicitly with org.createTenant: true — and read the " +
    "LANE B note at the top of this script first, because a tenant org cannot get its own admin today.",
  );
}
if (createTenantIn) {
  warnings.push(
    "org.createTenant is true, so a NEW TENANT will be created. Read the LANE B note at the top of this " +
    "script: POST /api/orgs/:id/users hardcodes role 'operator' and there is no role-elevation or " +
    "password-reset route, so this org can never administer itself, and only the 'autopilot' product " +
    "unlocks staging. The service-bureau lane (no org block) needs none of that.",
  );
}

// ---------------------------------------------------------------------------
// TOP-LEVEL UNKNOWN-KEY SWEEP. This script already warns about unknown keys inside `client`,
// so silently tolerating them at the TOP level was the inconsistency that hid a real bug: the
// shipped template asks for products under `entitlements`, this script only ever read
// `org.products`, and the mismatch was invisible — the intake requested one product and the
// org got all three. `entitlements` is now an accepted alias (below); anything else the script
// does not consume gets named, because a key that looks like configuration and is read by
// nothing is worse than a typo: it reads as "this was set up" in every review of the file.
// ---------------------------------------------------------------------------
const TOP_LEVEL_KEYS = ["org", "client", "users", "portalCredentials", "entitlements"] as const;
for (const key of Object.keys(intake)) {
  if (key.startsWith("_") || (TOP_LEVEL_KEYS as readonly string[]).includes(key)) continue;
  warnings.push(
    `${key} is a top-level key this script does not consume — nothing reads it, and nothing will. ` +
    `Known top-level keys: ${TOP_LEVEL_KEYS.join(", ")}.` +
    (key === "jurisdictions"
      ? " Jurisdiction/AHJ/utility coverage is knowledge-base data (permit_utility_knowledge, shared across tenants); this script writes no KB rows on purpose. Use the reference importer or the research flow."
      : ""),
  );
}

// SESSION_ENCRYPTION_KEY. The literal placeholder counts as missing, exactly as
// cryptoStorage.ts treats it — copying .env.example without editing it is indistinguishable
// from having no key at all.
const rawKey = process.env.SESSION_ENCRYPTION_KEY || "";
const keyMissing = !rawKey || rawKey === "replace-with-a-long-random-secret";
if (keyMissing && !dryRun) {
  problems.push(
    "SESSION_ENCRYPTION_KEY is " + (rawKey ? "still the .env.example placeholder" : "unset") + ". " +
    "This script will not write under it. Portal credentials are AES-256-GCM blobs keyed by that value, and " +
    "anything encrypted under a key you cannot reproduce is unreadable FOREVER — silently, because the decrypt " +
    "helpers catch and return null, so months later the symptom is \"no stored credential for this client/portal\". " +
    "Set a real value in .env (`openssl rand -base64 32`) and re-run. Until then `--dry-run` still reports the full plan.",
  );
}

const clientName = str(clientIn.companyName) || str(clientIn.legalBusinessName);
if (!clientName) problems.push("client.companyName (or client.legalBusinessName) is required — createClient refuses a nameless client.");
if (!str(clientIn.ccbLicenseNumber)) {
  problems.push(
    "client.ccbLicenseNumber is blank. This is the hard staging gate, not a nice-to-have: prepareSubmission " +
    "throws 409 {needsCcb} and the project soft-locks with no way forward from the dashboard.",
  );
}
for (const key of Object.keys(clientIn)) {
  if (key === "id" || key === "portalIdentities" || key.startsWith("_")) continue;
  if (key === "logoBase64" || key === "logoMime") {
    warnings.push(`client.${key} cannot be set by any code path today (not in FIELD_COLUMNS; the logo routes UPDATE a clients.updated_at column that does not exist). Ignored.`);
    continue;
  }
  if (!(CLIENT_FIELDS as readonly string[]).includes(key)) {
    warnings.push(`client.${key} is not a writable client field — createClient ignores it. Check the spelling against CLIENT_FIELDS in this script.`);
  }
}
for (const key of OVERLAY_FIELDS) {
  if (!str(clientIn[key])) warnings.push(`client.${key} is blank — it feeds clientStagingOverlay, so the portal gets a blank field and the AHJ rejects the filing. Nothing will throw.`);
}
if (str(clientIn.contactEmail) && !EMAIL_RE.test(str(clientIn.contactEmail))) problems.push(`client.contactEmail is not a valid email: ${str(clientIn.contactEmail)}`);
if (str(clientIn.businessEmail) && !EMAIL_RE.test(str(clientIn.businessEmail))) problems.push(`client.businessEmail is not a valid email: ${str(clientIn.businessEmail)}`);
if (clientIn.serviceFeeUsd != null && clientIn.serviceFeeUsd !== "" && !Number.isFinite(Number(String(clientIn.serviceFeeUsd).replace(/[$,\s]/g, "")))) {
  problems.push(`client.serviceFeeUsd is not a number: ${String(clientIn.serviceFeeUsd)}`);
}

// `users` is NOT required. It used to be required for every intake, which was wrong in the
// lane this product actually runs: in the service-bureau lane the operator's staff verify and
// press submit, so the company needs no login at all — and the user the intake asked for was
// created inside the OPERATOR'S own tenant, quietly adding an account that reaches every
// client the operator serves. `users` is required only where it is load-bearing: a NEW tenant
// with no login is a row nobody can ever reach. That check needs the DB (is a tenant really
// being created, or did org.id match an existing one?) and so lives in the plan phase below.
if (usersIn.length && !tenantLane) {
  warnings.push(
    `users lists ${usersIn.length} login(s) but this run is the service-bureau lane, so they would be created ` +
    "inside the OPERATOR'S tenant (org-default) — not the company's. That account reaches every client the " +
    "operator serves. The run will refuse unless --allow-operator-org-user is passed.",
  );
}
const seenEmails = new Set<string>();
usersIn.forEach((u, i) => {
  const email = norm(str(u.email));
  if (!email) problems.push(`users[${i}].email is required.`);
  else if (!EMAIL_RE.test(email)) problems.push(`users[${i}].email is not a valid email: ${email}`);
  else if (seenEmails.has(email)) problems.push(`users[${i}].email is listed twice in this intake: ${email}`);
  seenEmails.add(email);
  if (!str(u.name)) warnings.push(`users[${i}].name is blank — the email will be used as the display name.`);
  if (str(u.role)) warnings.push(`users[${i}].role is ignored: every user created anywhere in this system is an operator, and updateUser (the only role writer) needs a signed-in admin actor. Promote with raw SQL, deliberately.`);
});

const seenUrls = new Set<string>();
credsIn.forEach((c, i) => {
  const url = str(c.portalUrl);
  // username is always required. password is required only when this credential does not
  // already exist — a BLANK password on an existing row means "leave the stored secret alone"
  // (updatePortalCredential re-encrypts only `if (s(payload.password))`). That is what lets an
  // operator keep a filled intake with the secrets stripped out and still re-run it safely.
  // Whether the row exists needs the DB, so the create-side requirement is checked in the plan.
  if (!str(c.username)) problems.push(`portalCredentials[${i}].username is required (createPortalCredential refuses a blank one). Portal: ${str(c.portalType) || url || "?"}`);
  if (!url) {
    problems.push(
      `portalCredentials[${i}].portalUrl is required. portal_url is the load-bearing field: credential lookup ` +
      `matches on hostname AND first path segment, so a missing URL means this login is never found again.`,
    );
  } else {
    try {
      new URL(url);
    } catch {
      problems.push(`portalCredentials[${i}].portalUrl does not parse as a URL: ${url}`);
    }
    if (seenUrls.has(norm(url))) problems.push(`portalCredentials[${i}].portalUrl is listed twice in this intake: ${url} — this script keys credentials by URL, so it cannot tell them apart.`);
    seenUrls.add(norm(url));
  }
  if (!str(c.portalType)) warnings.push(`portalCredentials[${i}].portalType is blank. Harmless for lookup (portal_type is mostly display) but the sweep reports read better with "<STATE> · <Platform>".`);
  if (/pass|pwd|answer|ssn|account num|meter/i.test(str(c.notes))) {
    problems.push(`portalCredentials[${i}].notes looks like it contains a secret. That column is PLAINTEXT and LLM-VISIBLE (knowledgeResearchHint feeds it to the research prompt). Security answers belong in securityAnswers, which rides inside the encrypted envelope.`);
  }
});

// ---------------------------------------------------------------------------
// PRODUCTS. Two spellings, one meaning. The shipped intake template asks for products under a
// TOP-LEVEL `entitlements` array; this script only ever read `org.products`. Nothing errored —
// the request was simply invisible, so an intake asking for ONE product produced an org holding
// all three (productsForEdition("full") returns every key), and the re-run report then printed
// "the intake requested none" about a file that plainly requested one. Both spellings are
// accepted; naming them both differently is a refusal, not a coin flip.
// ---------------------------------------------------------------------------
const productsFromOrg = arr(orgIn.products).map(str).filter(Boolean);
const productsFromTop = arr(intake.entitlements).map(str).filter(Boolean);
const productsSource = productsFromOrg.length ? "org.products" : "entitlements";
if (productsFromOrg.length && productsFromTop.length
  && [...productsFromOrg].sort().join(",") !== [...productsFromTop].sort().join(",")) {
  problems.push(
    `org.products (${productsFromOrg.join(", ")}) and entitlements (${productsFromTop.join(", ")}) both name products, ` +
    "and they disagree. They are the same field under two names — pick one. Guessing which you meant would grant a " +
    "licence you did not ask for.",
  );
}
const requestedProducts = productsFromOrg.length ? productsFromOrg : productsFromTop;
for (const p of requestedProducts) {
  if (!PRODUCT_KEYS.includes(p)) problems.push(`${productsSource} contains an unknown product "${p}". Known: ${PRODUCT_KEYS.join(", ")}.`);
}
if (requestedProducts.length && !requestedProducts.includes("autopilot")) {
  warnings.push(
    `${productsSource} does not include "autopilot". That is the wildcard product, and it is the ONLY one that ` +
    "unlocks staging — an org holding just permit_reviewer/form_filler can never stage a permit or NEM filing, " +
    "and cannot reach the staging routes with an API key either (the autopilot product is apiKeyAuth:false, so " +
    "there is no programmatic way around it). That is fine if you are selling one tool; it is a dead end if you " +
    "expected the autopilot.",
  );
}

if (problems.length) {
  rule("INTAKE PROBLEMS");
  problems.forEach((p, i) => line(`  ${i + 1}. ${p}`));
  if (warnings.length) {
    rule("ALSO WORTH FIXING (not blocking)");
    warnings.forEach((w, i) => line(`  ${i + 1}. ${w}`));
  }
  line();
  line(`Nothing was written. Fix the ${problems.length} problem(s) above and re-run.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// PLAN. Read-only: work out create / unchanged / update for every row, print it, and only
// then write. Dry run and real run print the SAME plan from the same code, so the dry run is
// evidence about the real one rather than a separate opinion.
// ---------------------------------------------------------------------------
type Verdict = "create" | "unchanged" | "update";
const verdictLabel = (v: Verdict): string =>
  v === "create" ? "create" : v === "unchanged" ? "already exists, unchanged" : dryRun ? "would update" : "update";

// Opening the DB is a RUNTIME failure (exit 2), not a bad intake (exit 1) — a caller
// scripting this needs to tell "you typed the wrong thing" apart from "the machine is
// broken". Handled here because it happens before the try block that owns exit 2.
const db = await openDatabase().catch((err: Error) => {
  console.error(`Could not open the database at ${process.env.AUTOPILOT_DB_PATH}: ${err.message}`);
  console.error("Nothing was written.");
  process.exit(2);
});
let exitCode = 0;

/** Refuse in the INTAKE PROBLEMS style, print every reason at once, write nothing, exit 1.
 *  One helper so the plan-phase refusals (which need the DB to know they are wrong) read
 *  identically to the pre-DB ones — an operator should not be able to tell which pass
 *  caught the mistake. */
function refuse(items: string[]): never {
  rule("INTAKE PROBLEMS");
  items.forEach((p, i) => line(`  ${i + 1}. ${p}`));
  if (warnings.length) {
    rule("ALSO WORTH FIXING (not blocking)");
    warnings.forEach((w, i) => line(`  ${i + 1}. ${w}`));
  }
  line();
  line(`Nothing was written. Fix the ${items.length} problem(s) above and re-run.`);
  exitCode = 1;
  throw new Error("__handled__");
}
/** Problems that can only be found once the DB is open. Collected, not thrown one at a time,
 *  so the operator sees every one in a single pass instead of playing whack-a-mole. Flushed
 *  just before the report. */
const planProblems: string[] = [];

try {
  // --- ORG ------------------------------------------------------------------
  // Four shapes. The invariant across all of them: NOTHING creates an org except an explicit
  // `org.createTenant: true`.
  //   no org block / org.name alone -> DEFAULT_ORG_ID, the service-bureau lane. The company is
  //                    a `clients` row inside the OPERATOR'S own tenant. Complete path to a
  //                    staged submission; org/users/entitlements are lane B only.
  //   org.id           -> must already exist. A typo is refused, never created.
  //   org.id + createTenant -> that exact id is created if it is missing.
  //   createTenant + org.name -> match an org already called that, else create one.
  //
  // WHY THE OPT-IN. `org.name` alone used to create a tenant, and the shipped intake template
  // has exactly that shape, so ordinary onboarding minted a separate org and put the customer
  // in it. A silently separate tenant is invisible from both directions: the operator's own
  // routes and dashboard are org-scoped and cannot see the row, and the new org can never get
  // an admin of its own (POST /api/orgs/:id/users hardcodes role 'operator'; no role-elevation
  // route, no password-reset route exists). Nobody can see the customer you just onboarded.
  const orgEdition = str(orgIn.edition) === "full" ? "full" : str(orgIn.edition) === "review_gate" ? "review_gate" : "";
  let orgId = DEFAULT_ORG_ID;
  let orgVerdict: Verdict = "unchanged";
  let orgLabel = tenantLane
    ? DEFAULT_ORG_ID
    : `${DEFAULT_ORG_ID} (default tenant — the service-bureau lane${orgNameIn ? `; org "${orgNameIn}" in the intake was IGNORED, see WARNINGS` : "; no org block in the intake"})`;
  let orgCreateName = "";
  let orgCreateEdition = "";

  if (tenantLane) {
    const existingById = orgIdIn ? db.get<{ id: string; name: string }>("SELECT id, name FROM orgs WHERE id = ?", [orgIdIn]) : null;
    const byName = !orgIdIn && orgNameIn
      ? db.query<{ id: string; name: string }>("SELECT id, name FROM orgs").filter((o) => norm(String(o.name)) === norm(orgNameIn))
      : [];
    if (existingById) {
      // A matched id must also match the NAME the intake gave, when it gave one. Without this
      // a single mistyped character adopts an unrelated live tenant: the client, its portal
      // logins and every future project land in someone else's org, and the report cheerfully
      // says "already exists, unchanged" about a row nobody meant to touch.
      if (orgNameIn && norm(String(existingById.name)) !== norm(orgNameIn)) {
        refuse([
          `org.id "${orgIdIn}" exists but is named "${String(existingById.name)}", and this intake says ` +
          `org.name "${orgNameIn}". Those are different tenants as far as anyone reading them is concerned. ` +
          "Refusing rather than adopting the stored one: a one-character typo in an org id would otherwise " +
          "hand this company's clients and portal logins to an unrelated tenant, silently, and report it as " +
          "\"already exists, unchanged\". Fix the id, or fix the name to match the org you mean.",
        ]);
      }
      orgId = String(existingById.id);
      orgLabel = `${orgId}  "${existingById.name}"`;
    } else if (orgIdIn && !createTenantIn) {
      refuse([
        `org.id "${orgIdIn}" does not exist. A typo must not mint a junk tenant, so this script will not create ` +
        "an org from an id alone. Fix the id, drop the org block entirely for the service-bureau lane (the " +
        "client then lands in org-default, which is all staging needs), or say org.createTenant: true and give " +
        "org.name if you really do want a new tenant — read the LANE B note at the top of this script first.",
      ]);
    } else if (byName.length > 1) {
      refuse([
        `${byName.length} orgs are already named "${orgNameIn}" (${byName.map((o) => o.id).join(", ")}). Name is the ` +
        "only stable key this script has, so put the right org.id in the intake.",
      ]);
    } else if (byName.length === 1) {
      orgId = String(byName[0].id);
      orgLabel = `${orgId}  "${byName[0].name}"`;
    } else {
      // A NEW ORG IS A DIRECT INSERT, ON PURPOSE. There is no org-creation helper module in
      // this repo: the only production INSERT INTO orgs sites are POST /api/orgs
      // (server.ts:884, requireAdmin-gated and with no frontend at all) and migration v7
      // seeding org-default. Calling the route from a script would need a live server and an
      // admin session, so this mirrors the route's own statement instead — same columns, same
      // id shape, and the grantProduct loop that follows it, which is the half an operator
      // hand-writing SQL forgets. An org with zero org_entitlements rows authenticates and
      // then 403s on every single /api/* path.
      orgId = orgIdIn || `org-${crypto.randomUUID().slice(0, 8)}`;
      orgCreateName = orgNameIn;
      orgCreateEdition = orgEdition || "review_gate";
      orgVerdict = "create";
      // On a dry run the id is discarded, so don't print it as if it were the one you will
      // get — an operator who copied it into a runbook would be quoting a row that never
      // existed. A real run prints the id it actually wrote, in the WRITTEN section.
      orgLabel = `${orgIdIn || (dryRun ? "org-<assigned at write time>" : orgId)}  "${orgNameIn}"  edition=${orgCreateEdition}`;
    }
  }

  // A NEW TENANT WITH NO LOGIN IS A ROW NOBODY CAN REACH — this is the one place `users` is
  // load-bearing, so it is required here and nowhere else.
  if (orgVerdict === "create" && !usersIn.length) {
    planProblems.push(
      "org.createTenant is true, so a new tenant will be created, but `users` is empty. Nobody could ever sign " +
      "in to it: there is no self-service signup, no password-reset route, and no role-elevation route anywhere " +
      "in the API, so an org created with no user is unreachable forever. Add at least one users entry (with a " +
      "password), or drop the org block and use the service-bureau lane, where the operator's own staff stage " +
      "the filings and the company needs no login at all.",
    );
  }

  // Entitlements are granted only in the tenant lane. In the service-bureau lane the target org
  // IS the operator's own tenant, and an intake file quietly widening the operator's licence is
  // the same class of mistake as an intake file quietly adding a login to it: the customer's
  // paperwork must not be able to change what the operator's own org can reach. Use
  // PUT /api/orgs/:id/products for that, deliberately.
  const heldProducts = orgVerdict === "create" ? new Set<string>() : orgEntitlements(db, orgId);
  const wantProducts = !tenantLane
    ? []
    : requestedProducts.length
      ? requestedProducts
      : orgVerdict === "create"
        ? productsForEdition(orgCreateEdition)
        : [];
  const toGrant = wantProducts.filter((p) => !heldProducts.has(p));
  const alreadyHeld = wantProducts.filter((p) => heldProducts.has(p));
  const extraHeld = [...heldProducts].filter((p) => !wantProducts.includes(p));

  // --- CLIENT ---------------------------------------------------------------
  // Natural key: an explicit client.id, else the legal/company name WITHIN the target org.
  // Scoped to the org because two tenants may legitimately hold a client of the same name,
  // and matching across orgs would attach one tenant's portal logins to another's client.
  const clientIdIn = str(clientIn.id);
  const clientRows = db.query<Record<string, unknown>>(
    "SELECT id, org_id, company_name, legal_business_name FROM clients WHERE org_id = ?", [orgId],
  );
  let clientId: string | null = null;
  if (clientIdIn) {
    const row = db.get<{ id: string; org_id: string }>("SELECT id, org_id FROM clients WHERE id = ?", [clientIdIn]);
    if (!row) refuse([`client.id "${clientIdIn}" does not exist. Remove it to create the client, or fix the id.`]);
    if (String(row.org_id) !== orgId) {
      // Never move a client between tenants: portal_credentials hangs off client_id with no
      // org_id of its own, so re-homing a client hands one tenant another's live logins.
      refuse([
        `client.id "${clientIdIn}" belongs to org ${String(row.org_id)}, not ${orgId}. This script will not move a ` +
        "client between tenants — its portal credentials would move with it.",
      ]);
    }
    clientId = clientIdIn;
  } else {
    // AMBIGUITY IS A REFUSAL, NOT A COIN FLIP. Two columns can match (company_name and
    // legal_business_name) across any number of rows, and taking the first hit meant an
    // operator re-running an intake against a company that had been entered twice would
    // silently update whichever row SQLite happened to return first — leaving the other one
    // stale, and its portal credentials attached to a client nobody is maintaining.
    const wanted = norm(clientName);
    const seen = new Set<string>();
    const matches = clientRows.filter((r) => {
      const hit = norm(String(r.legal_business_name ?? "")) === wanted || norm(String(r.company_name ?? "")) === wanted;
      if (!hit) return false;
      const id = String(r.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (matches.length > 1) {
      refuse([
        `${matches.length} clients in org ${orgId} already match "${clientName}" by company name or legal business ` +
        `name (${matches.map((r) => String(r.id)).join(", ")}). The name is the only natural key this script has, ` +
        "so it cannot tell which one you mean, and picking one would silently leave the other stale with live " +
        "portal credentials attached. Put the right client.id in the intake, or merge the duplicates first.",
      ]);
    }
    if (matches.length === 1) clientId = String(matches[0].id);
  }

  // Only keys the intake actually names are written, matching updateClient's `key in payload`
  // semantics — an intake that omits a field must not blank it on an existing client.
  const clientPayload: Json = {};
  for (const key of CLIENT_FIELDS) {
    if (!(key in clientIn)) continue;
    clientPayload[key] = key === "serviceFeeUsd" ? clientIn[key] : str(clientIn[key]);
  }
  if (!("companyName" in clientPayload) && clientName) clientPayload.companyName = clientName;
  if ("portalIdentities" in clientIn) clientPayload.portalIdentities = clientIn.portalIdentities;

  let clientVerdict: Verdict = clientId ? "unchanged" : "create";
  const clientChanged: string[] = [];
  if (clientId) {
    const existing = getClient(db, clientId) as unknown as Json;
    for (const key of Object.keys(clientPayload)) {
      if (key === "portalIdentities") continue;
      const now = key === "serviceFeeUsd"
        ? (existing[key] == null ? "" : String(existing[key]))
        : str(existing[key]);
      const next = key === "serviceFeeUsd"
        ? (clientPayload[key] == null || clientPayload[key] === "" ? "" : String(Number(String(clientPayload[key]).replace(/[$,\s]/g, ""))))
        : str(clientPayload[key]);
      if (now !== next) clientChanged.push(key);
    }
    // portalIdentities is a full REPLACE, so it needs its own diff: without one, an intake
    // that changes ONLY an installer label would report "unchanged" and silently do nothing,
    // and that label is what a portal shows instead of the legal name.
    if ("portalIdentities" in clientPayload) {
      const shape = (list: unknown[]): string => JSON.stringify(
        list.map((e) => {
          const o = obj(e);
          return [str(o.portalType), str(o.installerCompanyLabel), str(o.installerContactCode), str(o.notes)];
        }).sort(),
      );
      if (shape(arr(existing.portalIdentities)) !== shape(arr(clientPayload.portalIdentities))) clientChanged.push("portalIdentities");
    }
    if (clientChanged.length) clientVerdict = "update";
  }

  // --- USERS ----------------------------------------------------------------
  // Natural key: email. users.email is globally UNIQUE (not per-org), so the same address
  // already in a DIFFERENT org is a refusal, not a match — the INSERT would fail anyway and
  // "already exists" would be a lie about whose tenant it is in.
  interface UserPlan {
    email: string; name: string; color: string; id: string | null; verdict: Verdict;
    changed: string[]; password: string; passwordNote: string;
  }
  const userPlans: UserPlan[] = [];
  for (const u of usersIn) {
    const email = norm(str(u.email));
    const name = str(u.name) || email;
    const color = str(u.color) || "#6366f1";
    const password = typeof u.password === "string" ? u.password : "";
    const row = db.get<{ id: string; org_id: string; name: string; color: string; password_hash: string }>(
      "SELECT id, org_id, name, color, COALESCE(password_hash, '') AS password_hash FROM users WHERE email = ?", [email],
    );
    if (row && String(row.org_id) !== orgId) {
      refuse([
        `${email} already exists in org ${String(row.org_id)}. users.email is globally unique, so this address ` +
        `cannot also be a login in ${orgId}. Use a different address.`,
      ]);
    }
    const changed: string[] = [];
    if (row) {
      if (str(row.name) !== name) changed.push("name");
      if (str(row.color) !== color) changed.push("color");
    }
    // A password already on the row is left alone. Rotating one because it happens to be in
    // an intake file would be a silent lockout on a re-run, and there is no set-password
    // route anywhere in the API to undo it with.
    const hasHash = Boolean(row && str(row.password_hash));
    const passwordNote = !password
      ? (hasHash ? "already set — left alone" : "not supplied — this login CANNOT sign in until one is set")
      : hasHash ? "already set — left alone (this script never rotates a password)" : "set";
    userPlans.push({
      email, name, color, id: row ? String(row.id) : null,
      verdict: row ? (changed.length || passwordNote === "set" ? "update" : "unchanged") : "create",
      changed, password, passwordNote,
    });
  }

  // A LOGIN IN THE OPERATOR'S OWN TENANT IS NOT THE CUSTOMER'S LOGIN. In the service-bureau
  // lane orgId IS org-default, so a `users` entry does not give the solar company an account —
  // it creates a password-bearing account inside OUR tenant, which reaches every client the
  // operator serves and every project across all of them. The intake template ships with a
  // users block, so this was happening by default and silently.
  //
  // Both a fresh row and a FIRST password on an existing row count: either way the run ends
  // with a working login into the operator's org that nobody typed a password for at the time.
  // A name/colour edit on an existing account is not gated — it grants nothing.
  const operatorOrgLogins = orgId === DEFAULT_ORG_ID
    ? userPlans.filter((u) => u.verdict === "create" || u.passwordNote === "set")
    : [];
  if (operatorOrgLogins.length && !allowOperatorOrgUser) {
    planProblems.push(
      `${operatorOrgLogins.length} login(s) would be created or given a first password inside ${DEFAULT_ORG_ID} — ` +
      `the OPERATOR'S own tenant, not this company's (${operatorOrgLogins.map((u) => u.email).join(", ")}). ` +
      "This intake is in the service-bureau lane, where the company is a client row and the operator's own staff " +
      "verify and press submit, so the company needs no login at all. An account here reaches EVERY client the " +
      "operator serves, and it cannot be removed or de-privileged through the API afterwards (no role writer, no " +
      "password-reset route). Drop the `users` block — that is the right answer for onboarding a customer — or " +
      "pass --allow-operator-org-user if you genuinely meant to add a member of your OWN staff.",
    );
  }

  // --- PORTAL CREDENTIALS ---------------------------------------------------
  // Natural key: lowercase portal_url within the client — the same key
  // importPortalProcessesWorkbook uses, so a workbook import and this script converge on
  // one row instead of stacking duplicates.
  interface CredPlan {
    portalType: string; portalUrl: string; username: string; password: string; notes: string;
    securityAnswers: string; id: string | null; verdict: Verdict; changed: string[]; secretUnreadable: boolean;
  }
  const credPlans: CredPlan[] = [];
  const existingCreds = clientId
    ? db.query<Record<string, unknown>>("SELECT id, portal_type, portal_url, username_reference, encrypted_secret, notes FROM portal_credentials WHERE client_id = ?", [clientId])
    : [];
  // A BLANK SECRET IN THE INTAKE MEANS "LEAVE THE STORED ONE ALONE", NOT "IT IS EMPTY". That is
  // the only way an operator can keep a filled intake on disk with the passwords stripped out
  // and still re-run it safely, which is the difference between an idempotent runbook and a
  // plaintext password file nobody dares delete. It also matches the writer:
  // updatePortalCredential re-encrypts only `if (s(payload.password))` and carries the stored
  // securityAnswers across when the intake supplies none. Diffing a blank intake field against
  // a stored value reported a change that the writer would then not make — an "update" that
  // updated nothing, on every single re-run.
  //
  // The corollary the writer forces on us: the envelope can only be rewritten WHOLE, and only
  // when a password is present. So a changed username or changed securityAnswers with a blank
  // password is not an update we can honestly make — updatePortalCredential would write
  // username_reference and notes, skip the envelope, and report success while the bot kept
  // using the old username. That is a refusal, not a warning.
  credsIn.forEach((c, i) => {
    const portalUrl = str(c.portalUrl);
    const row = existingCreds.find((r) => norm(String(r.portal_url ?? "")) === norm(portalUrl));
    const plan: CredPlan = {
      portalType: str(c.portalType), portalUrl, username: str(c.username),
      password: typeof c.password === "string" ? c.password : "", notes: str(c.notes),
      securityAnswers: str(c.securityAnswers), id: row ? String(row.id) : null,
      verdict: row ? "unchanged" : "create", changed: [], secretUnreadable: false,
    };
    const label = plan.portalType || portalUrl || `#${i}`;
    if (!row) {
      // Creating: the password is genuinely required — createPortalCredential throws on a blank
      // one. Caught here, as an intake problem (exit 1, nothing written), rather than mid
      // transaction as a runtime error (exit 2) six rows in.
      if (!plan.password) {
        planProblems.push(
          `portalCredentials[${i}] (${label}) is new and has no password. createPortalCredential refuses a blank ` +
          "one, and a credential row with no secret is worse than none: the bot finds it, tries to log in with " +
          "nothing, and the portal failure reads as a bad password rather than a missing one. A blank password is " +
          "allowed only on a credential that ALREADY exists, where it means \"keep the stored secret\".",
        );
      }
    } else {
      if (str(row.portal_type) !== plan.portalType) plan.changed.push("portalType");
      if (str(row.notes) !== plan.notes) plan.changed.push("notes");
      // Envelope fields, diffed only where the intake actually said something. username is
      // always supplied (validated above) and is also mirrored in the plaintext
      // username_reference column, so it can be diffed without the key.
      const envelope: string[] = [];
      if (keyMissing) {
        // Dry run only (a real run refuses without the key). Don't guess about the parts we
        // cannot read: an undecryptable blob and an identical one look the same from here.
        if (str(row.username_reference) !== plan.username) envelope.push("username");
        if (plan.password || plan.securityAnswers) {
          plan.changed.push("secret (cannot be compared without SESSION_ENCRYPTION_KEY)");
        }
      } else {
        let prev: { username?: string; password?: string; securityAnswers?: string } | null = null;
        try {
          prev = decryptStorageState(String(row.encrypted_secret ?? "")) as { username?: string; password?: string; securityAnswers?: string };
        } catch {
          // A blob that will not decrypt under the current key was written under a different
          // one and is already dead — say so and replace it.
          plan.secretUnreadable = true;
        }
        if (plan.secretUnreadable) {
          plan.changed.push("secret (unreadable under the current key — must be rewritten)");
          if (!plan.password) {
            planProblems.push(
              `portalCredentials[${i}] (${label}) has a stored secret that will not decrypt under the current ` +
              "SESSION_ENCRYPTION_KEY — it was written under a different key and is already unusable. Rewriting it " +
              "needs the password in this intake, and this intake has none. Supply the password, or delete the dead " +
              "credential row first. Leaving it is the silent case: lookups find the row, decrypt returns null, and " +
              "the symptom months later is \"no stored credential for this client/portal\".",
            );
          }
        } else if (prev) {
          if (str(prev.username) !== plan.username) envelope.push("username");
          if (plan.password && String(prev.password ?? "") !== plan.password) envelope.push("password");
          if (plan.securityAnswers && str(prev.securityAnswers) !== plan.securityAnswers) envelope.push("securityAnswers");
        }
      }
      if (envelope.length) {
        plan.changed.push(`secret (${envelope.join(", ")})`);
        if (!plan.password) {
          planProblems.push(
            `portalCredentials[${i}] (${label}) changes ${envelope.join(" and ")} but supplies no password. The ` +
            "secret is one encrypted envelope that can only be rewritten whole, and updatePortalCredential " +
            "re-encrypts ONLY when a password is present — so this edit would write the plaintext " +
            "username_reference/notes columns, silently skip the envelope, and report success while the bot kept " +
            "logging in with the old values. Supply the password to change any part of the secret; leave " +
            "username and securityAnswers exactly as stored to change only portalType/notes.",
          );
        }
      }
      if (plan.changed.length) plan.verdict = "update";
    }
    credPlans.push(plan);
  });

  // Everything the DB had to be open to discover. Flushed as one list, in the same format as
  // the pre-DB validation, so an operator cannot tell which pass caught the mistake.
  if (planProblems.length) refuse(planProblems);

  // -------------------------------------------------------------------------
  // REPORT
  // -------------------------------------------------------------------------
  line();
  line(`onboard-company  ${dryRun ? "DRY RUN" : "WRITE"}   intake: ${intakePath}`);
  line(`  database                 ${process.env.AUTOPILOT_DB_PATH}`);
  line(`  SESSION_ENCRYPTION_KEY   ${keyMissing ? (rawKey ? "default placeholder — a real run will refuse" : "missing — a real run will refuse") : "set"}`);
  line(`  lane                     ${tenantLane ? "TENANT (the company logs in as its own org — see the LANE B dead end at the top of this script)" : "SERVICE BUREAU (the company is a client row inside the operator's own tenant)"}`);

  rule("ORG (the tenant that logs in)");
  line(`  ${verdictLabel(orgVerdict).padEnd(26)} ${orgLabel}`);
  if (toGrant.length) line(`  grant                      ${toGrant.join(", ")}`);
  if (alreadyHeld.length) line(`  already granted            ${alreadyHeld.join(", ")}`);
  if (extraHeld.length) {
    // Three distinct reasons the intake's products are not being granted, and they used to
    // print the same sentence. "The intake requested none" about a file that plainly requests
    // one is how the entitlements-alias bug stayed invisible.
    line(wantProducts.length
      ? `  held, left alone           ${extraHeld.join(", ")}   (this script never revokes — use PUT /api/orgs/:id/products)`
      : requestedProducts.length
        ? `  already held               ${extraHeld.join(", ")}   (this is the operator's own tenant; the intake's ${productsSource} (${requestedProducts.join(", ")}) is NOT applied to it — see WARNINGS)`
        : `  already held               ${extraHeld.join(", ")}   (the intake requested none, so nothing changes)`);
  }
  if (!toGrant.length && !alreadyHeld.length && !extraHeld.length) line("  products                   none requested and none held — this org can reach NOTHING until a product is granted");

  rule("CLIENT (the solar company the work is FOR)");
  line(`  ${verdictLabel(clientVerdict).padEnd(26)} ${clientName}${clientId ? `   ${clientId}` : ""}`);
  line(`  ccb licence                ${secretState(str(clientIn.ccbLicenseNumber))}`);
  line(`  ein                        ${secretState(str(clientIn.ein))}`);
  if (clientChanged.length) line(`  fields to update           ${clientChanged.join(", ")}`);
  if (clientVerdict === "create") line(`  fields to write            ${Object.keys(clientPayload).filter((k) => k !== "portalIdentities").length} of ${CLIENT_FIELDS.length} writable`);
  if ("portalIdentities" in clientPayload) {
    line(`  portal identities          ${arr(clientPayload.portalIdentities).length}${clientChanged.includes("portalIdentities") || clientVerdict === "create" ? "  (written as a full REPLACE of this client's identity rows)" : "  (unchanged)"}`);
  }

  rule("USERS");
  if (!userPlans.length) line("  (none)");
  for (const u of userPlans) {
    line(`  ${verdictLabel(u.verdict).padEnd(26)} ${u.email}   ${u.name}`);
    line(`      password               ${u.passwordNote}`);
    if (u.changed.length) line(`      fields to update       ${u.changed.join(", ")}`);
  }

  rule("PORTAL CREDENTIALS");
  if (!credPlans.length) line("  (none in this intake)");
  for (const c of credPlans) {
    line(`  ${verdictLabel(c.verdict).padEnd(26)} ${c.portalType || "(no portalType)"}`);
    line(`      url                    ${c.portalUrl}`);
    line(`      username               ${secretState(c.username)}   password ${secretState(c.password)}   security answers ${secretState(c.securityAnswers)}`);
    if (c.secretUnreadable) line("      NOTE                   the stored blob will not decrypt under the current SESSION_ENCRYPTION_KEY — it is already dead and will be replaced");
    if (c.changed.length) line(`      to update              ${c.changed.join(", ")}`);
  }

  if (warnings.length) {
    rule("WARNINGS (nothing here blocks the write)");
    warnings.forEach((w, i) => line(`  ${i + 1}. ${w}`));
  }

  const writeCount = (orgVerdict === "create" ? 1 : 0) + toGrant.length
    + (clientVerdict === "unchanged" ? 0 : 1)
    + userPlans.filter((u) => u.verdict !== "unchanged").length
    + credPlans.filter((c) => c.verdict !== "unchanged").length;

  if (dryRun) {
    rule("DRY RUN");
    line(`  Nothing written. ${writeCount} row(s)/grant(s) would be created or changed.`);
    line("  Re-run without --dry-run to apply.");
    line();
  } else {
    // ONE TRANSACTION for everything. A half-onboarded company is the worst outcome: a client
    // with no credentials stages against a mock portal and reports success, and an org with no
    // entitlements 403s on every route. Either the whole company exists or none of it does.
    db.transaction(() => {
      if (orgVerdict === "create") {
        db.run("INSERT INTO orgs (id, name, edition, created_at) VALUES (?, ?, ?, ?)", [orgId, orgCreateName, orgCreateEdition, new Date().toISOString()]);
        addAuditLog(db, null, "human", actorFlag, "org.created", { orgId, name: orgCreateName, edition: orgCreateEdition, products: wantProducts });
      }
      for (const product of toGrant) grantProduct(db, orgId, product);
      if (toGrant.length) addAuditLog(db, null, "human", actorFlag, "org.products_changed", { orgId, granted: toGrant });

      if (clientVerdict === "create") {
        clientId = (createClient(db, clientPayload, orgId) as { id: string }).id;
      } else if (clientVerdict === "update" && clientId) {
        // Only the fields that actually differ. Passing the whole payload would work, but a
        // narrow patch is what makes the reported field list a true statement about the write.
        const patch: Json = {};
        for (const key of clientChanged) patch[key] = clientPayload[key];
        updateClient(db, clientId, patch);
      }
      // Only when something actually changed — matching the three sibling audit sites in this
      // transaction (org.created, org.products_changed, org.user_created), which all guard.
      // Unconditional, a pure no-op re-run appended a `client.onboarded` row every time, so the
      // audit trail grew while every business row stayed identical: the one place an operator
      // looks to answer "was this company touched?" answered yes about a run that did nothing.
      if (clientVerdict !== "unchanged") {
        addAuditLog(db, null, "human", actorFlag, "client.onboarded", { orgId, clientId, name: clientName, action: clientVerdict });
      }

      for (const u of userPlans) {
        if (u.verdict === "create") u.id = createUser(db, { name: u.name, email: u.email, color: u.color, orgId }).id;
        else if (u.changed.length && u.id) updateUser(db, u.id, { name: u.name, color: u.color });
        if (u.passwordNote === "set" && u.id) {
          // THE ONLY WAY A SCRIPT CAN PRODUCE A LOGIN THAT WORKS. createUser deliberately
          // writes no password_hash, POST /api/users takes no password, and there is no
          // set-password route anywhere in the API — the only other password writers in the
          // repo are seedAdminUser (default org, once ever) and POST /api/orgs/:id/users.
          // This calls auth.ts's setUserPassword rather than re-deriving the hash here: the
          // stored format (scrypt(pw, 16-byte salt, 64) as "salthex:hashhex") has exactly one
          // reader, verifyPassword, and a second copy of the hasher in a script is a login
          // that silently cannot log in the day either side changes.
          setUserPassword(db, u.id, u.password);
        }
        if (u.verdict !== "unchanged") addAuditLog(db, null, "human", actorFlag, "org.user_created", { orgId, email: u.email, action: u.verdict });
      }

      for (const c of credPlans) {
        if (c.verdict === "unchanged" || !clientId) continue;
        // Called directly, not over HTTP, ON PURPOSE: the REST schemas silently strip
        // securityAnswers (zod drops unknown keys), so a portal that challenges security
        // questions on a new device would stall for a human even though the operator
        // supplied the answers. This path keeps them, inside the encrypted envelope.
        if (c.verdict === "create") {
          createPortalCredential(db, clientId, {
            portalType: c.portalType, portalUrl: c.portalUrl, username: c.username,
            password: c.password, notes: c.notes, securityAnswers: c.securityAnswers,
          });
        } else {
          // updatePortalCredential re-encrypts ONLY when a password is present. The plan
          // guarantees the two cases that matters for: a blank password here means the plan
          // found NO envelope change (so skipping the re-encrypt is correct and the stored
          // secret is deliberately preserved), and any envelope change was refused unless the
          // intake supplied the password. So passing c.password through — blank or not — is
          // exactly the intent in both directions.
          updatePortalCredential(db, clientId, c.id!, {
            portalType: c.portalType, portalUrl: c.portalUrl, notes: c.notes,
            username: c.username, password: c.password, securityAnswers: c.securityAnswers,
          });
        }
        addAuditLog(db, null, "human", actorFlag, "portal_credential.onboarded", { clientId, portalType: c.portalType, portalUrl: c.portalUrl, action: c.verdict });
      }
    });

    rule("WRITTEN");
    line(`  org        ${orgId}${orgId === DEFAULT_ORG_ID ? "   (the operator's own tenant — service-bureau lane)" : orgVerdict === "create" ? "   (NEW TENANT)" : ""}`);
    line(`  client     ${clientId}`);
    line(`  users      ${userPlans.length} (${userPlans.filter((u) => u.passwordNote === "set").length} with a password set by this run)`);
    line(`  portal credentials  ${credPlans.length}`);
    line(`  ${writeCount} row(s)/grant(s) created or changed.`);

    rule("NEXT");
    line("  1. Re-run this script with --dry-run: every row must now say \"already exists, unchanged\".");
    line(`  2. Create a project and bind this client:  POST /api/projects  then  POST /api/projects/:id/client { clientId: "${clientId}" }`);
    line("     (createProject auto-enqueues an autopilot job unless AUTOPILOT_AUTO_START=0 — a scripted project starts a real staging attempt on its own.)");
    line("  3. GET /health must report sessionKeySet true, or every stored credential above is unreadable.");
    line("  4. Each portal login must already exist on the portal's own site. This script stores logins; it never registers them,");
    line("     and a portal the shared knowledge base has never seen will \"stage successfully\" against a MOCK adapter that never");
    line("     opened a browser. Point the recorder at the real portal URL before trusting a stage for a new jurisdiction.");
    line("  5. Final submit, fees and CAPTCHA/MFA stay a human's job. Nothing here changes that.");
    if (orgVerdict === "create") {
      line(`  6. YOU CREATED A TENANT (${orgId}). It has no admin and no route to get one: POST /api/orgs/:id/users`);
      line("     hardcodes role 'operator', and there is no role-elevation route and no password-reset route in the API.");
      line("     Promote a user with raw SQL (UPDATE users SET role = 'admin' WHERE email = ?) or that org can never");
      line("     administer itself. Also confirm it holds 'autopilot' above — no other product unlocks staging, and");
      line("     the autopilot routes refuse API keys, so there is no programmatic way around a missing grant.");
    }
    line();
  }
} catch (err) {
  if ((err as Error).message !== "__handled__") {
    console.error();
    console.error(`onboard-company failed: ${(err as Error).message}`);
    console.error("Nothing was committed — every write runs inside one transaction.");
    exitCode = 2;
  }
} finally {
  // Close before exiting: Windows holds an open SQLite handle as a file lock, and a scratch
  // DB that cannot be deleted has broken more than one test loop.
  db.close();
}

process.exit(exitCode);
