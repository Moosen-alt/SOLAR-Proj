// THE WATCHDOG: SOMEONE IS TOLD, ONCE, AND TOLD WHEN IT IS FIXED.
//
// DAY1-OF-100 blocker 4: nothing polled /health; 30 background jobs had failed with nobody looking;
// after a power cut the server stayed dark for 2 h 23 min until someone happened to double-click a
// script; backup results went only to a console window. scripts/ops/watchdog.ts is the fix.
//
//   MUST-PASS    a down server alerts after WATCHDOG_DOWN_AFTER polls, then RECOVERED; a rise in
//                failed jobs alerts; a stale or failed backup alerts; a gap in the watchdog's own
//                runs (the box was off) is reported; the CLI delivers through REAL SMTP (a fake
//                server here) and a webhook, and persists state between --once runs.
//   MUST-EXCLUDE no duplicate alert while the problem persists; an unreachable server does not
//                read as "queue recovered"; nothing a server or status file wrote (names,
//                addresses) ever reaches an alert.
//
// Run: npx tsx backend/test/opsWatchdog.test.ts
import { REPO, ISOLATED_CWD } from "./_isolate";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { composeMessage, emptyState, runOnce, type Alert, type WatchdogConfig, type WatchdogState } from "../../scripts/ops/watchdogCore";
import { SMTP_ENV_KEYS } from "../../scripts/ops/mailer";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Customer-shaped strings the fake server and status files carry. None may reach an alert.
const PLANTED = ["Hollis Quintero", "4471 Larkspur Bend", "quintero@home.invalid"];
const allText: string[] = [];
const noPlanted = (alerts: Alert[]): void => {
  const { subject, text } = composeMessage("Solar Autopilot", alerts);
  allText.push(subject, text);
  for (const p of PLANTED) assert.ok(!`${subject}\n${text}`.includes(p), `alert text contains "${p}"`);
};

// ---------------------------------------------------------------------------
// A fake server whose /health we control.
// ---------------------------------------------------------------------------
type Mode = { kind: "healthy"; failed24h: number; warning?: string } | { kind: "error503" } | { kind: "down" };
let mode: Mode = { kind: "healthy", failed24h: 30 };
const fake = http.createServer((req, res) => {
  if (mode.kind === "down") { req.socket.destroy(); return; }
  if (mode.kind === "error503") {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, db: "error", error: `SQLITE_BUSY while reading project for ${PLANTED[0]} at ${PLANTED[1]}` }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok: true, db: "ok", owner: PLANTED[0],
    jobs: { pending: 3, running: mode.warning ? 0 : 1, failed24h: mode.failed24h, oldestPendingAgeSec: 10 },
    ...(mode.warning ? { warning: `${mode.warning} (${PLANTED[1]})` } : {}),
  }));
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const healthUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/health`;

const backupDir = path.join(ISOLATED_CWD, "wd-backups");
const offboxDir = path.join(ISOLATED_CWD, "wd-offbox");
fs.mkdirSync(backupDir, { recursive: true });
fs.mkdirSync(offboxDir, { recursive: true });
const T0 = new Date("2026-09-24T12:00:00Z").getTime();
let clock = T0;
const HOUR = 3600_000;
const snapshotAt = (dir: string, ms: number): void => {
  const name = `autopilot-${new Date(ms).toISOString().replace(/[:.]/g, "-")}.sqlite`;
  fs.writeFileSync(path.join(dir, name), "x");
  fs.utimesSync(path.join(dir, name), new Date(ms), new Date(ms));
};
snapshotAt(backupDir, T0 - 2 * HOUR);
snapshotAt(offboxDir, T0 - 3 * HOUR);

const config: WatchdogConfig = {
  name: "Solar Autopilot", healthUrl, timeoutMs: 3000, downAfter: 2, repeatHours: 6, intervalSec: 300,
  backupDir, backupMaxAgeHours: 37, offboxDir, offboxMaxAgeHours: 43,
};
let state: WatchdogState = emptyState();
const history: Alert[] = [];
const poll = async (advanceMin = 5, fresh = false): Promise<Alert[]> => {
  clock += advanceMin * 60_000;
  const r = await runOnce(config, state, { fetch: (u, i) => fetch(u, i), now: () => new Date(clock) }, { fresh });
  state = r.state;
  history.push(...r.alerts);
  try { noPlanted(r.alerts); } catch (err) { failures++; console.error(`  FAIL - MUST-EXCLUDE (every poll): ${(err as Error).message}`); }
  return r.alerts;
};
const keys = (alerts: Alert[]): string[] => alerts.map((a) => `${a.kind}:${a.key}`);

console.log("watchdog core: state machine against a real HTTP fake");
let a = await poll(0, true);
await check("a fresh start sends exactly one ARMED message with the current picture", () => {
  assert.deepEqual(keys(a), ["armed:armed"]);
  assert.match(a[0].summary, /Server up; 30 job failure\(s\) in the last 24 h/);
});
a = await poll();
await check("a healthy second poll sends nothing", () => assert.deepEqual(keys(a), []));

mode = { kind: "down" };
a = await poll();
await check("one failed poll is not yet an alert (WATCHDOG_DOWN_AFTER=2)", () => assert.deepEqual(keys(a), []));
a = await poll();
await check("the second consecutive failure alerts: server problem", () => {
  assert.deepEqual(keys(a), ["problem:server"]);
  assert.match(a[0].summary, /is not answering/);
});
a = await poll();
await check("MUST-EXCLUDE: still down 5 min later sends nothing (de-duplicated)", () => assert.deepEqual(keys(a), []));
a = await poll(6 * 60);
await check("still down after WATCHDOG_REPEAT_HOURS sends one reminder (the 6 h jump is also a gap)", () => {
  assert.deepEqual(keys(a).sort(), ["event:gap", "reminder:server"]);
});
mode = { kind: "error503" };
a = await poll();
await check("a 503 with a database error is still 'down', and its error text is never echoed", () => {
  assert.deepEqual(keys(a), []);
});
mode = { kind: "healthy", failed24h: 30 };
a = await poll();
await check("back up: exactly one RECOVERED, with the outage length", () => {
  assert.deepEqual(keys(a), ["recovered:server"]);
  assert.match(a[0].summary, /was down\/failing for 6 h/);
});

// A 503 that is the FIRST failure: its alert is built while the server's error text (which names
// a homeowner and a street) is in hand. Only typed fields may shape the sentence.
mode = { kind: "error503" };
await poll();
a = await poll();
await check("MUST-EXCLUDE: a 503 outage alerts in fixed words — the server's own error text is not echoed", () => {
  assert.deepEqual(keys(a), ["problem:server"]);
  assert.match(a[0].summary, /answered HTTP 503 with its database unreachable/);
  for (const p of PLANTED) assert.ok(!a[0].summary.includes(p), `echoed "${p}"`);
});
mode = { kind: "healthy", failed24h: 30 };
await poll();

mode = { kind: "healthy", failed24h: 32 };
a = await poll();
await check("failed24h rising 30 -> 32 is one job-failures notice naming the rise", () => {
  assert.deepEqual(keys(a), ["event:job-failures"]);
  assert.match(a[0].summary, /^2 background job\(s\) failed permanently since the last check \(32 in the last 24 h\)/);
});
a = await poll();
await check("the same count again sends nothing", () => assert.deepEqual(keys(a), []));
mode = { kind: "healthy", failed24h: 20 };
a = await poll();
await check("a falling count (old failures ageing out of 24 h) sends nothing", () => assert.deepEqual(keys(a), []));

mode = { kind: "healthy", failed24h: 20, warning: "Jobs are pending but nothing is running" };
a = await poll();
await check("the stuck-worker warning is a queue problem", () => assert.deepEqual(keys(a), ["problem:queue"]));
mode = { kind: "down" };
await poll();
a = await poll();
await check("MUST-EXCLUDE: an unreachable server is not read as 'queue recovered'", () => {
  assert.deepEqual(keys(a), ["problem:server"]);
  assert.equal(state.checks.queue.bad, true, "queue state must survive an unknown reading");
});
mode = { kind: "healthy", failed24h: 20 };
a = await poll();
await check("when the server answers without the warning, both recover", () => {
  assert.deepEqual(keys(a).sort(), ["recovered:queue", "recovered:server"]);
});

console.log("watchdog core: backups");
clock = T0 + 40 * HOUR; // the newest snapshot is now ~42 h old (> 37 h), off-box ~43 h (= 43, not over)
a = await poll(0);
await check("a snapshot older than the allowed age is a backup problem", () => {
  assert.ok(keys(a).includes("problem:backup"), keys(a).join(","));
  assert.match(a.find((x) => x.key === "backup")!.summary, /newest database snapshot is 42 h 0 min old \(allowed: 37 h\)/);
});
snapshotAt(backupDir, clock - 60_000);
a = await poll();
await check("a fresh snapshot recovers it", () => assert.ok(keys(a).includes("recovered:backup"), keys(a).join(",")));
fs.writeFileSync(path.join(backupDir, ".last-backup.json"), JSON.stringify({ ok: false, at: new Date(clock + 60_000).toISOString(), error: `disk full writing ${PLANTED[0]}` }));
a = await poll();
await check("a failed attempt recorded after the newest snapshot is a backup problem (without its error text)", () => {
  assert.ok(keys(a).includes("problem:backup"), keys(a).join(","));
  assert.match(a.find((x) => x.key === "backup")!.summary, /last database snapshot attempt FAILED/);
});
fs.rmSync(path.join(backupDir, ".last-backup.json"));
await poll();
await check("the off-box copy going stale (43 h 5 min > 43 h) was its own problem, raised exactly once", () => {
  const off = history.filter((x) => x.key === "offbox");
  assert.deepEqual(off.map((x) => x.kind), ["problem"]);
  assert.match(off[0].summary, /newest OFF-BOX snapshot is 43 h 5 min old \(allowed: 43 h\)/);
});
fs.writeFileSync(path.join(backupDir, ".offbox-status.json"), JSON.stringify({ ok: false, at: new Date(clock).toISOString(), firstProblem: PLANTED[2] }));
snapshotAt(offboxDir, clock);
a = await poll();
await check("a fresh off-box snapshot but a failed last sync stays a problem (no false recovery)", () => {
  assert.ok(!keys(a).includes("recovered:offbox"), keys(a).join(","));
  assert.equal(state.checks.offbox.bad, true);
});
fs.rmSync(path.join(backupDir, ".offbox-status.json"));
a = await poll();
await check("...and recovers once the sync is clean", () => assert.ok(keys(a).includes("recovered:offbox"), keys(a).join(",")));

console.log("watchdog core: the machine was off");
a = await poll(3 * 60);
await check("a 3 h gap in the watchdog's own runs is reported once, with both times", () => {
  assert.deepEqual(keys(a).filter((k) => k === "event:gap"), ["event:gap"]);
  assert.match(a.find((x) => x.key === "gap")!.summary, /did not run from .* to .* \(3 h 0 min\)/);
});
a = await poll();
await check("...and not again on the next poll", () => assert.ok(!keys(a).includes("event:gap")));

// ---------------------------------------------------------------------------
// The CLI end to end: real nodemailer against a fake SMTP server, plus a webhook.
// ---------------------------------------------------------------------------
console.log("watchdog CLI: real SMTP + webhook delivery, state across --once runs");
const mails: string[] = [];
const smtp = net.createServer((sock) => {
  let buf = "";
  let inData = false;
  let data = "";
  sock.write("220 fake.smtp.invalid ESMTP\r\n");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\r\n")) >= 0) {
      const lineIn = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (inData) {
        // Quoted-printable soft-wraps long lines ("=\n") and escapes UTF-8 ("=E2=80=94"). Decode, so
        // both the assertions and the privacy check see the text a person reads — a name split
        // across a soft line break must not slip past the MUST-EXCLUDE.
        if (lineIn === ".") {
          inData = false;
          const decoded = Buffer.from(data.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
          mails.push(decoded); data = ""; sock.write("250 2.0.0 queued\r\n");
        }
        else data += `${lineIn}\n`;
        continue;
      }
      const cmd = lineIn.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250 fake.smtp.invalid\r\n");
      else if (cmd === "MAIL" || cmd === "RCPT" || cmd === "RSET" || cmd === "NOOP") sock.write("250 OK\r\n");
      else if (cmd === "DATA") { inData = true; sock.write("354 go ahead\r\n"); }
      else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
      else sock.write("250 OK\r\n");
    }
  });
});
await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
const hooks: { title: string; body: string }[] = [];
const hook = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => { hooks.push({ title: String(req.headers.title ?? ""), body }); res.writeHead(200); res.end("ok"); });
});
await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));

const stateFile = path.join(ISOLATED_CWD, "cli", "watchdog-state.json");
const cliEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  SMTP_HOST: "127.0.0.1", SMTP_PORT: String((smtp.address() as AddressInfo).port), SMTP_SECURE: "false",
  SMTP_FROM: "Watchdog <watchdog@ops.invalid>", SMTP_USER: "", SMTP_PASS: "",
  WATCHDOG_ALERT_TO: "operator@ops.invalid",
  WATCHDOG_WEBHOOK_URL: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/topic`, WATCHDOG_WEBHOOK_FORMAT: "text",
  WATCHDOG_HEALTH_URL: healthUrl, WATCHDOG_STATE_FILE: stateFile, WATCHDOG_LOG_FILE: path.join(ISOLATED_CWD, "cli", "watchdog.log"),
  WATCHDOG_BACKUP_DIR: "off", WATCHDOG_OFFBOX_DIR: "", BACKUP_SECOND_DIR: "", WATCHDOG_DOWN_AFTER: "2", WATCHDOG_TIMEOUT_SECONDS: "3",
  ...extra,
});
// spawn, not spawnSync: the fake servers live on THIS process's event loop.
const cli = (argv: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join(REPO, "scripts", "ops", "watchdog.ts"), ...argv], { cwd: ISOLATED_CWD, env });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const timer = setTimeout(() => child.kill(), 120_000);
  child.on("close", (code) => { clearTimeout(timer); allText.push(out); resolve({ code: code ?? -1, out }); });
});

mode = { kind: "healthy", failed24h: 5 };
let r = await cli(["--once"], cliEnv());
await check("first --once run exits 0 and delivers ARMED by email AND webhook", () => {
  assert.equal(r.code, 0, r.out);
  assert.equal(mails.length, 1, r.out);
  assert.match(mails[0], /Subject: \[Solar Autopilot\] ARMED: armed/);
  assert.match(mails[0], /To: operator@ops\.invalid/);
  assert.equal(hooks.length, 1);
  assert.match(hooks[0].title, /\[Solar Autopilot\] ARMED/);
  assert.match(hooks[0].body, /Watchdog armed\. Server up; 5 job failure/);
});
mode = { kind: "down" };
r = await cli(["--once"], cliEnv());
await check("down once: no mail yet", () => { assert.equal(r.code, 0, r.out); assert.equal(mails.length, 1); });
r = await cli(["--once"], cliEnv());
await check("down twice (state persisted between runs): one PROBLEM mail", () => {
  assert.equal(r.code, 0, r.out);
  assert.equal(mails.length, 2, r.out);
  assert.match(mails[1], /Subject: \[Solar Autopilot\] PROBLEM: server/);
});
r = await cli(["--once"], cliEnv());
await check("MUST-EXCLUDE: down a third time sends no duplicate", () => { assert.equal(mails.length, 2, r.out); });
mode = { kind: "healthy", failed24h: 5 };
r = await cli(["--once"], cliEnv());
await check("up again: one RECOVERED mail", () => {
  assert.equal(mails.length, 3, r.out);
  assert.match(mails[2], /Subject: \[Solar Autopilot\] RECOVERED: server/);
});
mode = { kind: "healthy", failed24h: 9 };
r = await cli(["--once"], cliEnv({ SMTP_PORT: "1", WATCHDOG_WEBHOOK_URL: "http://127.0.0.1:1/none" }));
await check("when no channel accepts an alert, the run exits 1 and keeps it", () => {
  assert.equal(r.code, 1, r.out);
  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) as WatchdogState;
  assert.equal(saved.undelivered.length, 1);
  assert.equal(saved.undelivered[0].key, "job-failures");
});
r = await cli(["--once"], cliEnv());
await check("...and delivers it, marked delayed, on the next run that can", () => {
  assert.equal(r.code, 0, r.out);
  assert.equal(mails.length, 4, r.out);
  assert.match(mails[3], /\(delayed from /);
  assert.match(mails[3], /4 background job\(s\) failed permanently/);
});
r = await cli(["--once"], { ...cliEnv(), SMTP_HOST: "", WATCHDOG_WEBHOOK_URL: "" });
await check("no channel configured at all is a configuration error (exit 2), not a silent watchdog", () => {
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /no alert channel is configured/);
});
r = await cli(["--test-alert"], cliEnv());
await check("--test-alert reaches the inbox", () => {
  assert.equal(r.code, 0, r.out);
  assert.match(mails.at(-1) ?? "", /Test alert from the watchdog/);
});

await check("the alert mailer reads exactly the SMTP variables clientNotifier.ts reads", () => {
  const src = fs.readFileSync(path.join(REPO, "backend", "src", "clientNotifier.ts"), "utf8");
  const used = [...new Set([...src.matchAll(/process\.env\.(SMTP_[A-Z_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, [...SMTP_ENV_KEYS].sort());
});
await check("MUST-EXCLUDE: no alert, mail, webhook body or log line carries a planted name/address", () => {
  const everything = [...allText, ...mails, ...hooks.map((h) => h.body), fs.readFileSync(path.join(ISOLATED_CWD, "cli", "watchdog.log"), "utf8")].join("\n");
  for (const p of PLANTED) assert.ok(!everything.includes(p), `found "${p}"`);
});

fake.close(); smtp.close(); hook.close();
if (failures) { console.error(`\n${failures} watchdog check(s) FAILED.`); process.exit(1); }
console.log("\nAll watchdog checks passed.");
process.exit(0);
