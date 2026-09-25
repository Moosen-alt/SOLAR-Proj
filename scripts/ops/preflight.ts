// OPS PREFLIGHT — one read-only command that says whether this box is set up to run for a customer.
//
//   npx tsx scripts/ops/preflight.ts            # run in the install folder (reads the live .env)
//   npx tsx scripts/ops/preflight.ts --json
//
// Every step of docs/OPERATIONS.md ends with "re-run preflight; this line must say PASS". It checks
// configuration, not behaviour: the restore drill, --test-alert and the restart drill prove the rest.
//
// READ-ONLY. Reads .env (via the environment), the users table (read-only connection, operator
// accounts only: email, role, whether a password is set) and the backup folders. Writes nothing.
// NEVER PRINTS A SECRET: keys, passwords and tokens are reported as set/missing/length only.
//
// EXIT: 0 no FAIL (WARNs allowed), 1 at least one FAIL.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { AUTOMATIC_SNAPSHOT_RE } from "../../backend/src/offboxBackup";

const env = process.env;
const asJson = process.argv.includes("--json");
type Verdict = "PASS" | "WARN" | "FAIL";
const rows: { area: string; check: string; verdict: Verdict; detail: string }[] = [];
const add = (area: string, check: string, verdict: Verdict, detail: string): void => { rows.push({ area, check, verdict, detail }); };
const PLACEHOLDER_KEY = "replace-with-a-long-random-secret";

// --- ACCESS -----------------------------------------------------------------------------------
const authOn = String(env.AUTH_ENABLED ?? "").toLowerCase() === "true"; // exactly how auth.ts reads it
add("access", "AUTH_ENABLED", authOn ? "PASS" : "FAIL",
  authOn ? "login required" : "no login: anyone who can reach the port can read customer data and use the credential/approve endpoints");

const dbPath = path.resolve(process.cwd(), env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite");
let admins: { email: string; role: string; hasPassword: boolean }[] | null = null;
try {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    admins = (db.prepare("SELECT email, role, COALESCE(password_hash, '') <> '' AS has_pw FROM users WHERE COALESCE(active, 1) = 1").all() as { email: string; role: string; has_pw: number }[])
      .map((u) => ({ email: String(u.email), role: String(u.role), hasPassword: Number(u.has_pw) === 1 }));
  } finally {
    db.close();
  }
} catch {
  admins = null;
}
const adminWithPw = (admins ?? []).filter((u) => (u.role === "admin" || u.role === "superadmin") && u.hasPassword);
const seedReady = Boolean(env.ADMIN_EMAIL && env.ADMIN_PASSWORD);
if (admins === null) {
  add("access", "admin login", "WARN", `could not read users from ${dbPath}`);
} else if (adminWithPw.length) {
  add("access", "admin login", "PASS", `${adminWithPw.length} admin account(s) with a password (${adminWithPw.map((u) => u.email).join(", ")})`);
} else if (seedReady) {
  const match = admins.find((u) => u.email.toLowerCase() === String(env.ADMIN_EMAIL).trim().toLowerCase());
  add("access", "admin login", "WARN",
    `no account has a password yet; ADMIN_EMAIL/ADMIN_PASSWORD are set, so the next start with AUTH_ENABLED=true sets it` +
    (match ? ` on the existing account ${match.email} (role ${match.role})` : " on a NEW admin account (ADMIN_EMAIL matches no existing user)"));
} else {
  add("access", "admin login", "FAIL", "no account has a password and ADMIN_EMAIL/ADMIN_PASSWORD are not set - turning auth on would lock everyone out");
}
if (env.ADMIN_PASSWORD && adminWithPw.length) {
  add("access", "ADMIN_PASSWORD in .env", "WARN", "an admin password is already set, so this line is no longer used - remove it from .env (it is plaintext)");
}

const authSecret = env.AUTH_SECRET ?? "";
const sessionKey = env.SESSION_ENCRYPTION_KEY ?? "";
add("access", "AUTH_SECRET", !authSecret ? "WARN" : authSecret === sessionKey ? "FAIL" : authSecret.length < 32 ? "WARN" : "PASS",
  !authSecret ? "unset: login cookies are signed with SESSION_ENCRYPTION_KEY (works, but one secret doing two jobs)"
    : authSecret === sessionKey ? "identical to SESSION_ENCRYPTION_KEY - set its own value"
      : authSecret.length < 32 ? `only ${authSecret.length} characters - use 32+ random characters` : `set (${authSecret.length} characters)`);

const host = String(env.SERVER_HOST ?? "").trim();
const localOnly = ["127.0.0.1", "::1", "localhost"].includes(host);
add("access", "SERVER_HOST", localOnly ? "PASS" : authOn ? "WARN" : "FAIL",
  localOnly ? `${host}: reachable only from this machine (customer links then need a tunnel - see OPERATIONS.md)`
    : `${host || "unset (0.0.0.0)"}: listening on every network interface - keep the Node firewall rule off the Public profile`);

const finalSubmit = String(env.PORTAL_ALLOW_FINAL_SUBMIT ?? "").trim() === "1";
add("access", "PORTAL_ALLOW_FINAL_SUBMIT", !finalSubmit ? "PASS" : authOn ? "WARN" : "FAIL",
  !finalSubmit ? "unset: automation never clicks a portal's final submit"
    : authOn ? "=1: Approve & Submit may click a portal's final submit after a named per-run approval (operator ruling; acceptable only with that gate verified on the running build)"
      : "=1 with no login: anyone on the network can approve a filing into a real submission");

// --- CUSTOMER LINKS -----------------------------------------------------------------------------
const base = String(env.PUBLIC_BASE_URL ?? "").trim();
let baseHost = "";
try { baseHost = base ? new URL(base).hostname.toLowerCase() : ""; } catch { baseHost = "(unparseable)"; }
const baseDead = !base || ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "(unparseable)"].includes(baseHost);
add("links", "PUBLIC_BASE_URL", baseDead ? "FAIL" : base.startsWith("https://") ? "PASS" : "WARN",
  baseDead ? `${base || "unset"}: every status/portal/credential link a customer receives points at this machine and will not open`
    : base.startsWith("https://") ? base : `${base}: not https - customers will type portal passwords into the credential page over plain http`);

// --- SECRETS ---------------------------------------------------------------------------------------
add("secrets", "SESSION_ENCRYPTION_KEY", !sessionKey || sessionKey === PLACEHOLDER_KEY ? "FAIL" : sessionKey.length < 32 ? "WARN" : "PASS",
  !sessionKey || sessionKey === PLACEHOLDER_KEY ? "missing or the .env.example placeholder - saved portal logins cannot be read"
    : `set (${sessionKey.length} characters). It is in NO backup: escrow it in a password manager and prove it with the restore drill (--no-dotenv)`);

// --- BACKUPS ------------------------------------------------------------------------------------------
const backupDir = path.resolve(process.cwd(), env.BACKUP_DIR || "backend/data/backups");
const newestIn = (dir: string): { name: string; ageH: number } | null => {
  try {
    const hits = fs.readdirSync(dir).filter((f) => AUTOMATIC_SNAPSHOT_RE.test(f))
      .map((f) => ({ name: f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
    return hits[0] ? { name: hits[0].name, ageH: (Date.now() - hits[0].m) / 3600_000 } : null;
  } catch { return null; }
};
const interval = Number(env.BACKUP_INTERVAL_HOURS || 24);
const keep = Number(env.BACKUP_KEEP || 14);
const newest = newestIn(backupDir);
add("backups", "BACKUP_DIR", newest ? (newest.ageH <= Math.max(interval, 1) * 1.5 + 1 ? "PASS" : "FAIL") : "FAIL",
  newest ? `${backupDir}: newest snapshot ${newest.ageH.toFixed(1)} h old` : `${backupDir}: no automatic snapshot found`);
add("backups", "BACKUP_INTERVAL_HOURS", interval >= 1 && interval <= 4 ? "PASS" : "WARN",
  interval > 0 ? `${interval} h between snapshots = up to ${interval} h of work lost${interval > 4 ? " (1-4 h recommended)" : ""}` : "schedule OFF (one snapshot per boot only)");
const historyH = interval > 0 ? interval * keep : 0;
add("backups", "BACKUP_KEEP", historyH >= 7 * 24 || interval <= 0 ? "PASS" : "WARN",
  `${keep} snapshots x ${interval} h = ${(historyH / 24).toFixed(1)} days of history${historyH < 7 * 24 ? ` (set BACKUP_KEEP=${Math.ceil((7 * 24) / Math.max(interval, 1))} for 7 days)` : ""}`);
const second = String(env.BACKUP_SECOND_DIR ?? "").trim();
if (!second) {
  add("backups", "BACKUP_SECOND_DIR", "FAIL", "unset: every backup is on this one machine");
} else {
  const secondDir = path.resolve(process.cwd(), second);
  const off = newestIn(secondDir);
  const sameDrive = (a: string, b: string): boolean => path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase();
  add("backups", "BACKUP_SECOND_DIR", !fs.existsSync(secondDir) ? "FAIL" : !off ? "WARN" : "PASS",
    !fs.existsSync(secondDir) ? `${secondDir} does not exist (a disconnected share?)`
      : !off ? `${secondDir}: no snapshot copied yet - run scripts/ops/offbox-sync.ts`
        : `${secondDir}: newest off-box snapshot ${off.ageH.toFixed(1)} h old` +
          (sameDrive(secondDir, dbPath) || sameDrive(secondDir, backupDir) ? " (same drive as the database or BACKUP_DIR: fine ONLY if it is a cloud-synced folder)" : ""));
}

// --- ALERTS ---------------------------------------------------------------------------------------------
const smtp = Boolean(env.SMTP_HOST && env.SMTP_FROM);
const to = String(env.WATCHDOG_ALERT_TO ?? "").trim();
const hook = Boolean(env.WATCHDOG_WEBHOOK_URL);
add("alerts", "watchdog channel", (smtp && to) || hook ? "PASS" : "FAIL",
  [smtp && to ? `email to ${to.split(/[,;]/).length} address(es)` : smtp ? "SMTP set but WATCHDOG_ALERT_TO is empty" : "no SMTP",
    hook ? "webhook set" : "no webhook"].join("; "));
add("alerts", "WATCHDOG_HEARTBEAT_URL", env.WATCHDOG_HEARTBEAT_URL ? "PASS" : "WARN",
  env.WATCHDOG_HEARTBEAT_URL ? "set: an outside service notices when this machine goes silent" : "unset: when the whole machine is off, nothing can tell anyone");
const stateFile = path.resolve(process.cwd(), env.WATCHDOG_STATE_FILE || "data/ops/watchdog-state.json");
let lastRun: number | null = null;
try { lastRun = Date.parse(JSON.parse(fs.readFileSync(stateFile, "utf8")).lastRunAt); } catch { lastRun = null; }
add("alerts", "watchdog running", lastRun && Date.now() - lastRun < 20 * 60_000 ? "PASS" : "FAIL",
  lastRun ? `last poll ${Math.round((Date.now() - lastRun) / 60_000)} min ago` : "has never run here (install-watchdog.ps1)");

// --- REPORT -------------------------------------------------------------------------------------------
const fails = rows.filter((r) => r.verdict === "FAIL").length;
const warns = rows.filter((r) => r.verdict === "WARN").length;
if (asJson) {
  console.log(JSON.stringify({ fails, warns, rows }, null, 2));
} else {
  console.log(`ops preflight   ${new Date().toISOString()}   (read-only; docs/OPERATIONS.md)`);
  let area = "";
  for (const r of rows) {
    if (r.area !== area) { console.log(`\n  ${r.area.toUpperCase()}`); area = r.area; }
    console.log(`    ${r.verdict.padEnd(4)}  ${r.check.padEnd(26)} ${r.detail}`);
  }
  console.log(`\nPREFLIGHT: ${fails ? `${fails} FAIL` : "no FAIL"}, ${warns} WARN`);
}
process.exit(fails ? 1 : 0);
