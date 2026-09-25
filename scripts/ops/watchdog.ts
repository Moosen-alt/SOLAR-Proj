// WATCHDOG — tell a person when the server is down, jobs are failing, or backups have stopped.
//
//   npx tsx scripts/ops/watchdog.ts --once          # one poll (what the scheduled task runs every 5 min)
//   npx tsx scripts/ops/watchdog.ts                 # poll forever, every WATCHDOG_INTERVAL_SECONDS
//   npx tsx scripts/ops/watchdog.ts --test-alert    # send a test message through every channel
//   npx tsx scripts/ops/watchdog.ts --once --dry-run   # evaluate and print; send and save nothing
//   npx tsx scripts/ops/watchdog.ts --print-config
//
// WHY. On 2026-09-24 this server was dark for 2 h 23 min after a power cut, 30 background jobs had
// failed with nobody looking, and backup results only ever reached a console window. Nothing
// polled /health. This does, and it runs OUTSIDE the server process, so it can report the
// server's death — and, when it comes back after a power cut, how long the machine was out.
//
// IT RUNS ON THE SAME BOX. When the whole machine is off, nothing here can send anything; that is
// what WATCHDOG_HEARTBEAT_URL is for: point it at a free dead-man's-switch service
// (healthchecks.io) which alerts YOU when these pings stop. See docs/OPERATIONS.md.
//
// CONFIGURATION (env, read from the live .env when run in the install folder):
//   WATCHDOG_ALERT_TO          comma list of addresses (email uses the product's SMTP_* settings)
//   WATCHDOG_WEBHOOK_URL       optional POST target (ntfy.sh topic, Slack/Discord webhook, SMS bridge)
//   WATCHDOG_WEBHOOK_FORMAT    json (default) | text  (text = ntfy.sh style)
//   WATCHDOG_HEARTBEAT_URL     optional GET after every run (healthchecks.io dead-man's switch)
//   WATCHDOG_HEALTH_URL        default http://127.0.0.1:<PORT or 4173>/health
//   WATCHDOG_DOWN_AFTER        consecutive failed polls before "server down" (default 2)
//   WATCHDOG_REPEAT_HOURS      re-alert while still broken (default 6; 0 = never)
//   WATCHDOG_INTERVAL_SECONDS  loop cadence and the expected gap between --once runs (default 300)
//   WATCHDOG_BACKUP_MAX_AGE_HOURS  default BACKUP_INTERVAL_HOURS x 1.5 + 1 (37 h at the 24 h default)
//   WATCHDOG_OFFBOX_DIR        default BACKUP_SECOND_DIR; unset = off-box check off
//   WATCHDOG_OFFBOX_MAX_AGE_HOURS  default backup max age + 6
//   WATCHDOG_STATE_FILE        default data/ops/watchdog-state.json
//   WATCHDOG_LOG_FILE          default data/ops/watchdog.log (every alert and delivery result)
//   WATCHDOG_NAME              label in the subject line (default "Solar Autopilot")
//
// NEVER sends a customer name or address: alerts are fixed sentences with numbers and times
// (see watchdogCore.ts). EXIT: 0 ran; 1 an alert could not be delivered on any channel;
// 2 configuration error (no channel configured).
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { composeMessage, loadState, runOnce, saveState, type WatchdogConfig } from "./watchdogCore";
import { configuredChannels, deliver } from "./mailer";

const args = process.argv.slice(2);
const once = args.includes("--once");
const dryRun = args.includes("--dry-run");
const env = process.env;

const numEnv = (name: string, fallback: number): number => {
  const raw = env[name];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
const backupIntervalHours = numEnv("BACKUP_INTERVAL_HOURS", 24);
// A disabled schedule (<= 0) still writes one snapshot per boot; allow a week before calling it stale.
const defaultBackupMax = backupIntervalHours > 0 ? backupIntervalHours * 1.5 + 1 : 24 * 7;
const backupMax = numEnv("WATCHDOG_BACKUP_MAX_AGE_HOURS", defaultBackupMax);
const offboxRaw = env.WATCHDOG_OFFBOX_DIR ?? env.BACKUP_SECOND_DIR ?? "";

const config: WatchdogConfig = {
  name: env.WATCHDOG_NAME || "Solar Autopilot",
  healthUrl: env.WATCHDOG_HEALTH_URL || `http://127.0.0.1:${env.PORT || 4173}/health`,
  timeoutMs: numEnv("WATCHDOG_TIMEOUT_SECONDS", 20) * 1000,
  downAfter: numEnv("WATCHDOG_DOWN_AFTER", 2),
  repeatHours: numEnv("WATCHDOG_REPEAT_HOURS", 6),
  intervalSec: numEnv("WATCHDOG_INTERVAL_SECONDS", 300),
  // Same default and resolution as backend/src/backup.ts, so it watches the folder the server writes.
  backupDir: env.WATCHDOG_BACKUP_DIR === "off" ? null : path.resolve(process.cwd(), env.WATCHDOG_BACKUP_DIR || env.BACKUP_DIR || "backend/data/backups"),
  backupMaxAgeHours: backupMax,
  offboxDir: offboxRaw ? path.resolve(process.cwd(), offboxRaw) : null,
  offboxMaxAgeHours: numEnv("WATCHDOG_OFFBOX_MAX_AGE_HOURS", backupMax + 6),
};
const stateFile = path.resolve(process.cwd(), env.WATCHDOG_STATE_FILE || "data/ops/watchdog-state.json");
const logFile = path.resolve(process.cwd(), env.WATCHDOG_LOG_FILE || "data/ops/watchdog.log");

function log(message: string): void {
  const stamped = `${new Date().toISOString()} ${message}`;
  console.log(stamped);
  if (dryRun) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${stamped}\n`);
  } catch { /* never let logging stop a watchdog */ }
}

async function heartbeat(): Promise<void> {
  if (!env.WATCHDOG_HEARTBEAT_URL || dryRun) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    await fetch(env.WATCHDOG_HEARTBEAT_URL, { signal: ctrl.signal }).finally(() => clearTimeout(t));
  } catch {
    log("heartbeat: could not reach WATCHDOG_HEARTBEAT_URL (the dead-man's switch will alert if this persists)");
  }
}

if (args.includes("--print-config")) {
  console.log(JSON.stringify({ ...config, stateFile, logFile, channels: configuredChannels(env), heartbeat: Boolean(env.WATCHDOG_HEARTBEAT_URL) }, null, 2));
  process.exit(0);
}

const channels = configuredChannels(env);
if (!channels.length && !dryRun) {
  console.error("watchdog: no alert channel is configured, so nobody would be told anything.");
  console.error("  Email: set SMTP_HOST + SMTP_FROM (the product's own mail settings) and WATCHDOG_ALERT_TO.");
  console.error("  Or:    set WATCHDOG_WEBHOOK_URL (e.g. an ntfy.sh topic, with WATCHDOG_WEBHOOK_FORMAT=text).");
  process.exit(2);
}

if (args.includes("--test-alert")) {
  const { subject, text } = composeMessage(config.name, [{
    key: "test", kind: "event", at: new Date().toISOString(),
    summary: `Test alert from the watchdog on this machine. If you are reading this, alerts reach you. Watching ${config.healthUrl}.`,
  }]);
  const results = dryRun ? [] : await deliver(subject, text, env);
  for (const r of results) log(`test-alert ${r.channel}: ${r.ok ? "sent" : `FAILED (${r.detail})`}`);
  process.exit(dryRun || results.some((r) => r.ok) ? 0 : 1);
}

async function tick(): Promise<number> {
  const { state, fresh } = loadState(stateFile);
  const result = await runOnce(config, state, {
    fetch: (url, init) => fetch(url, init),
    now: () => new Date(),
  }, { fresh });
  const o = result.observation;
  log(`poll: server ${o.server}${o.jobs ? ` jobs pending=${o.jobs.pending} running=${o.jobs.running} failed24h=${o.jobs.failed24h}` : ""}` +
    `${config.backupDir ? ` backup=${o.backupAgeHours === null ? "none" : `${o.backupAgeHours.toFixed(1)}h`}` : ""}` +
    `${config.offboxDir ? ` offbox=${o.offboxAgeHours === null ? "none" : `${o.offboxAgeHours.toFixed(1)}h`}` : ""}` +
    ` alerts=${result.alerts.length}`);
  let code = 0;
  if (result.alerts.length) {
    const { subject, text } = composeMessage(config.name, result.alerts);
    for (const a of result.alerts) log(`alert ${a.kind} [${a.key}] ${a.summary}`);
    if (dryRun) {
      console.log(`\n--- would send ---\nSubject: ${subject}\n\n${text}\n`);
    } else {
      const results = await deliver(subject, text, env);
      for (const r of results) log(`deliver ${r.channel}: ${r.ok ? "sent" : `FAILED (${r.detail})`}`);
      if (!results.some((r) => r.ok)) {
        // Keep them for the next run rather than losing the only record of an outage.
        result.state.undelivered = result.alerts.map((a) => ({ ...a, delayed: true })).slice(-20);
        code = 1;
      }
    }
  }
  if (!dryRun) saveState(stateFile, result.state);
  await heartbeat();
  return code;
}

if (once || dryRun) {
  process.exit(await tick());
}
log(`watchdog loop: every ${config.intervalSec}s, watching ${config.healthUrl}`);
for (;;) {
  try { await tick(); } catch (err) { log(`tick failed: ${(err as Error).message.slice(0, 200)}`); }
  await new Promise((r) => setTimeout(r, Math.max(30, config.intervalSec) * 1000));
}
