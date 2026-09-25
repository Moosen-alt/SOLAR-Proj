// AUTOSTART: THE SERVER COMES BACK BY ITSELF, AND NEVER TWICE.
//
// DAY1-OF-100 blocker 3: five power losses in twelve days, no service or scheduled task, and a
// start script that ends in `pause`. After today's outage the box was dark 2 h 23 min until a
// person double-clicked it. scripts/ops/install-autostart.ps1 registers a task that runs
// run-prod-supervised.ps1; install-watchdog.ps1 / install-offbox-sync.ps1 register the other two.
//
// THE INSTALLERS ARE NEVER RUN FOR REAL HERE — only with -WhatIf, a test task name and a test port,
// and the test then proves Task Scheduler holds no such task. The supervisor's logic is exercised
// directly against fake start scripts on free ports (never 4173/4270).
//
//   MUST-PASS    a free port -> the start script runs; its trailing `pause` does not hang (input
//                is NUL); when it exits it is started again; -WhatIf prints the whole plan.
//   MUST-EXCLUDE a port already listening -> no second copy; a matching server process that has
//                not bound the port yet -> no second copy; -DryRun starts nothing; -WhatIf
//                registers nothing; an interval outside 1-24 h is refused.
//
// Windows only (Task Scheduler, PowerShell). Run: npx tsx backend/test/opsAutostart.test.ts
import { REPO, ISOLATED_CWD } from "./_isolate";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

if (process.platform !== "win32") {
  console.log("opsAutostart: skipped (Windows only).");
  process.exit(0);
}

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const OPS = path.join(REPO, "scripts", "ops");
const FORBIDDEN_PORTS = new Set([4173, 4270]);
const ps = (args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> => new Promise((resolve) => {
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], { cwd: ISOLATED_CWD, windowsHide: true });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const timer = setTimeout(() => { out += "\n<<TIMEOUT: killed>>"; child.kill(); }, timeoutMs);
  child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
});
const freePort = async (): Promise<number> => {
  for (;;) {
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    });
    if (!FORBIDDEN_PORTS.has(port)) return port;
  }
};
const TEST_TASK = `SolarAutopilot-Test-${process.pid}`;
const tasksNamed = async (pattern: string): Promise<number> => {
  const r = await ps(["-Command", `@(Get-ScheduledTask -TaskName '${pattern}' -ErrorAction SilentlyContinue).Count`]);
  return Number(r.out.trim().split(/\s+/).pop());
};

// ---------------------------------------------------------------------------
console.log("installers: -WhatIf prints the plan and registers nothing");
const testPort = await freePort();
let r = await ps(["-File", path.join(OPS, "install-autostart.ps1"), "-WhatIf", "-Port", String(testPort), "-TaskName", `${TEST_TASK}-server`]);
await check("install-autostart -WhatIf exits 0 with the full plan", () => {
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /action\s+powershell\.exe .*run-prod-supervised\.ps1" -Port \d+ -PollSeconds 30 -StartScript ".*start-prod-pinned\.cmd"/);
  assert.ok(r.out.includes(`-Port ${testPort}`), r.out);
  assert.match(r.out, /trigger\s+Logon/);
  assert.match(r.out, /trigger\s+Time repeating every PT5M/);
  assert.match(r.out, /logon type Interactive/);
  assert.match(r.out, /instances\s+IgnoreNew/);
  assert.match(r.out, /time limit none/);
  assert.match(r.out, /What if: Performing the operation "Register scheduled task/);
  assert.match(r.out, /Nothing registered \(-WhatIf\)\./);
  assert.doesNotMatch(r.out, /New Alias/);
});
r = await ps(["-File", path.join(OPS, "install-watchdog.ps1"), "-WhatIf", "-TaskName", `${TEST_TASK}-watchdog`]);
await check("install-watchdog -WhatIf: boot + every 5 min, S4U, watchdog.ts --once", () => {
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /watchdog\.ts" --once/);
  assert.match(r.out, /trigger\s+Boot/);
  assert.match(r.out, /repeating every PT5M/);
  assert.match(r.out, /logon type S4U/);
  assert.match(r.out, /Nothing registered \(-WhatIf\)\./);
});
r = await ps(["-File", path.join(OPS, "install-watchdog.ps1"), "-WhatIf", "-Interactive", "-EveryMinutes", "10", "-TaskName", `${TEST_TASK}-watchdog`]);
await check("install-watchdog -Interactive: logon trigger, interactive, every 10 min", () => {
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /trigger\s+Logon/);
  assert.match(r.out, /repeating every PT10M/);
  assert.match(r.out, /logon type Interactive/);
});
r = await ps(["-File", path.join(OPS, "install-offbox-sync.ps1"), "-WhatIf", "-IntervalHours", "2", "-Destination", path.join(ISOLATED_CWD, "cloud"), "-TaskName", `${TEST_TASK}-offbox`]);
await check("install-offbox-sync -WhatIf: every 2 h, offbox-sync.ts --to <destination>", () => {
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /offbox-sync\.ts" --to ".*cloud"/);
  assert.match(r.out, /repeating every PT2H/);
  assert.match(r.out, /Nothing registered \(-WhatIf\)\./);
});
r = await ps(["-File", path.join(OPS, "install-offbox-sync.ps1"), "-WhatIf", "-IntervalHours", "0", "-TaskName", `${TEST_TASK}-offbox`]);
await check("MUST-EXCLUDE: an off-box interval of 0 h is refused", () => {
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /IntervalHours/);
});
r = await ps(["-File", path.join(OPS, "uninstall-autostart.ps1"), "-WhatIf", "-TaskName", `${TEST_TASK}-server`]);
await check("uninstall of a task that is not installed says so and exits 0", () => {
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /is not installed - nothing to remove/);
});
r = await ps(["-File", path.join(OPS, "uninstall-watchdog.ps1"), "-WhatIf", "-IncludeOffboxSync", "-TaskName", `${TEST_TASK}-watchdog`, "-OffboxTaskName", `${TEST_TASK}-offbox`]);
await check("uninstall-watchdog -IncludeOffboxSync handles both names", () => {
  assert.equal(r.code, 0, r.out);
  assert.equal((r.out.match(/is not installed/g) ?? []).length, 2, r.out);
});
await check("MUST-EXCLUDE: Task Scheduler holds no task from this test", async () => {
  assert.equal(await tasksNamed(`${TEST_TASK}*`), 0);
});

// ---------------------------------------------------------------------------
console.log("supervisor: starts, restarts, and never starts a second copy");
const node = process.execPath;
function fakeStart(name: string, port: number, holdMs: number): { script: string; marker: string } {
  const dir = path.join(ISOLATED_CWD, name);
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, "starts.txt");
  const script = path.join(dir, "start-fake.cmd");
  // Mirrors .probe\start-prod-pinned.cmd's shape: runs a server in the foreground, then `pause`.
  fs.writeFileSync(script, [
    "@echo off",
    `echo started>> "${marker}"`,
    `"${node}" -e "const s=require('net').createServer().listen(${port},'127.0.0.1');setTimeout(()=>{s.close();process.exit(0)},${holdMs})"`,
    "echo.",
    "echo Server exited. You can close this window.",
    "pause",
    "",
  ].join("\r\n"));
  return { script, marker };
}
const starts = (marker: string): number => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").split(/\r?\n/).filter((l) => l.trim() === "started").length : 0);
const supervise = (port: number, script: string, extra: string[], logFile: string, timeoutMs = 120_000) =>
  ps(["-File", path.join(OPS, "run-prod-supervised.ps1"), "-Port", String(port), "-StartScript", script, "-PollSeconds", "1", "-LogFile", logFile, ...extra], timeoutMs);

const p1 = await freePort();
const a = fakeStart("restart", p1, 2500);
const t0 = Date.now();
r = await supervise(p1, a.script, ["-MaxStarts", "2", "-ProcessPattern", ""], path.join(ISOLATED_CWD, "restart", "autostart.log"), 90_000);
await check("a free port: the start script runs, exits, and is started AGAIN (restart on exit)", () => {
  assert.equal(r.code, 0, r.out);
  assert.equal(starts(a.marker), 2, r.out);
  assert.equal((r.out.match(/server exited after/g) ?? []).length, 2, r.out);
});
await check("the start script's trailing `pause` does not hang the supervisor (input is NUL)", () => {
  assert.doesNotMatch(r.out, /<<TIMEOUT/);
  assert.ok(Date.now() - t0 < 60_000, `took ${Date.now() - t0} ms`);
});

// MUST-EXCLUDE: something already listens -> no second copy.
const p2 = await freePort();
const holder = net.createServer().listen(p2, "127.0.0.1");
await new Promise((res) => holder.once("listening", res));
const b = fakeStart("occupied", p2, 1000);
r = await supervise(p2, b.script, ["-MaxCycles", "3", "-ProcessPattern", ""], path.join(ISOLATED_CWD, "occupied", "autostart.log"));
holder.close();
await check("MUST-EXCLUDE: a port already listening is left alone - no second copy", () => {
  assert.equal(r.code, 0, r.out);
  assert.equal(starts(b.marker), 0, r.out);
  assert.match(r.out, /already listening - not starting a second copy/);
});

// MUST-EXCLUDE: a server process that is still booting (not yet listening) -> no second copy.
const p3 = await freePort();
const tag = `fake-prod-pinned-${process.pid}-server.ts`;
const booting = spawn(node, ["-e", "setTimeout(()=>{},60000)", tag], { stdio: "ignore", windowsHide: true });
await new Promise((res) => setTimeout(res, 500));
const c = fakeStart("booting", p3, 1000);
r = await supervise(p3, c.script, ["-MaxCycles", "3", "-ProcessPattern", `*${tag}*`], path.join(ISOLATED_CWD, "booting", "autostart.log"));
booting.kill();
await check("MUST-EXCLUDE: a matching server process that has not bound the port yet blocks a second start", () => {
  assert.equal(r.code, 0, r.out);
  assert.equal(starts(c.marker), 0, r.out);
  assert.match(r.out, /already running but not listening yet/);
});

const p4 = await freePort();
const d = fakeStart("dry", p4, 1000);
r = await supervise(p4, d.script, ["-MaxCycles", "2", "-DryRun", "-ProcessPattern", ""], path.join(ISOLATED_CWD, "dry", "autostart.log"));
await check("MUST-EXCLUDE: -DryRun reports what it would start and starts nothing", () => {
  assert.equal(r.code, 0, r.out);
  assert.equal(starts(d.marker), 0);
  assert.match(r.out, /would start: .*start-fake\.cmd \(port \d+ is free\)/);
});

r = await supervise(await freePort(), path.join(ISOLATED_CWD, "nope", "missing.cmd"), ["-MaxCycles", "1"], path.join(ISOLATED_CWD, "missing.log"));
await check("a missing start script is a loud exit 2, not a silent loop", () => {
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /START SCRIPT NOT FOUND/);
});
await check("the supervisor logs to its log file", () => {
  const log = fs.readFileSync(path.join(ISOLATED_CWD, "restart", "autostart.log"), "utf8");
  assert.match(log, /supervisor up/);
  assert.match(log, /starting .*start-fake\.cmd/);
});

if (failures) { console.error(`\n${failures} autostart check(s) FAILED.`); process.exit(1); }
console.log("\nAll autostart checks passed.");
process.exit(0);
