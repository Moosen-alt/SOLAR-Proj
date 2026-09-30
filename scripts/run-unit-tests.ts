// ONE RUNNER FOR THE UNIT SUITES, AND THE FILESYSTEM IS THE REGISTER.
//
// `backend:test:unit` used to be 290 `tsx a.test.ts && tsx b.test.ts && ...` links split across
// two package.json scripts — the first one had already hit cmd.exe's 8191-char limit on Windows
// ("The command line is too long." — nothing ran, and the exit was 1). Every new test meant
// appending to that line. With several agents working the board in parallel, every PR that
// added a test edited the SAME line of package.json, so those PRs conflicted with each other by
// construction; and a test nobody remembered to append never ran at all.
//
// This is the unit-suite twin of scripts/run-dom-smokes.ts — read that file's header for the
// reasoning behind the choices the two share: discovery instead of a list, every suite in its
// own process, ALL the reds collected (a `&&` chain reports the first and hides the rest), and a
// summary with a denominator.
//
//   npx tsx scripts/run-unit-tests.ts                          # backend suite (the default)
//   npx tsx scripts/run-unit-tests.ts --suite portal
//   npx tsx scripts/run-unit-tests.ts --suite all --only tenancy,routeScope
//   npx tsx scripts/run-unit-tests.ts --shard 2/4              # CI: the 2nd of 4 even slices
//
// A NEW TEST NEEDS NO REGISTRATION: `backend/test/<name>.test.ts` or any
// `portal-bot/**/<name>.test.ts` runs the day it lands.
//
// Load-bearing choices — do not "simplify" these away:
//
//   SERIAL BY DEFAULT. Several backend suites boot the real server on a port band of their own,
//   and a socket left in TIME_WAIT by the previous suite made shared bands flaky. One suite at a
//   time is the behaviour the old chain had. CI gets its speed from --shard instead: each shard
//   is a separate machine, so their ports can never collide. --concurrency exists for runs you
//   know are hermetic.
//
//   THE WHOLE PROCESS GROUP IS REAPED AFTER EVERY SUITE. Server-booting suites spawn
//   `npx tsx backend/src/server.ts`, and SIGTERM to the npx wrapper does not always reach the real
//   node child. Orphaned servers then squatted on the port bands and made LATER suites fail with
//   "fetch failed" — a red pinned on an innocent suite. Each suite here runs as the leader of its
//   own process group, and the group is killed the moment the suite exits, pass or fail, so
//   nothing a suite started can outlive it.
//
//   EXCLUSIONS ARE NAMED, NEVER SILENT. A discovered test that is deliberately not part of a
//   suite is listed in NOT_UNIT with the reason and printed in every summary. An exclusion you
//   cannot see is indistinguishable from a test that stopped existing.
//
//   EXIT 0 WITH "FAIL - " LINES IS A FAILURE. Same rule as the DOM runner: a suite that prints a
//   red check and still exits clean has a broken exit path, and that needs its own repair.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Spawn node against tsx's own entry rather than the `tsx` shim through a shell: with a shell on
// Windows, child.pid is the cmd.exe wrapper and killing it on timeout leaves tsx running (see
// run-dom-smokes.ts). Owning the real pid is what lets the reaper below kill the whole tree.
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

// ---------------------------------------------------------------------------------------------
// Suites and discovery
// ---------------------------------------------------------------------------------------------

type SuiteName = "backend" | "portal";

/** Where each suite's tests live. backend/test is flat on purpose (helpers like _isolate.ts and
 *  rehearsal.harness.ts sit beside the tests without the .test.ts suffix). */
const SUITES: Record<SuiteName, { root: string; recursive: boolean }> = {
  backend: { root: "backend/test", recursive: false },
  portal: { root: "portal-bot", recursive: true },
};

/**
 * Discovered *.test.ts files that are deliberately NOT unit tests, each with the reason a human
 * needs in order to agree. Reported in every summary, never quietly filtered.
 */
const NOT_UNIT = new Map<string, string>([
  ["portal-bot/src/adapters/powerClerk.stress.test.ts", "stress run, not a unit test — npm run portal:test:stress"],
]);

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "data", "portal-profiles"]);

const discover = (suite: SuiteName): string[] => {
  const { root, recursive } = SUITES[suite];
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && !IGNORED_DIRS.has(e.name)) walk(full);
      } else if (e.name.endsWith(".test.ts")) {
        found.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(REPO_ROOT, root));
  return found.sort();
};

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const suiteArg = argValue("suite") ?? "backend";
if (!["backend", "portal", "all"].includes(suiteArg)) {
  console.error(`--suite must be backend, portal or all (got ${JSON.stringify(suiteArg)})`);
  process.exit(2);
}
const suites: SuiteName[] = suiteArg === "all" ? ["backend", "portal"] : [suiteArg as SuiteName];
const only = (argValue("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.max(1, Number(argValue("concurrency") ?? 1));
// Bounds a HANG, not slowness — a generous budget, same reasoning as the DOM runner.
const TIMEOUT_MS = Math.max(1, Number(argValue("timeout") ?? 600)) * 1000;

let shardIndex = 1;
let shardCount = 1;
const shardArg = argValue("shard");
if (shardArg) {
  const m = /^(\d+)\/(\d+)$/.exec(shardArg);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) {
    console.error(`--shard must look like 2/4 (got ${JSON.stringify(shardArg)})`);
    process.exit(2);
  }
  shardIndex = Number(m[1]);
  shardCount = Number(m[2]);
}

const LOG_DIR = path.join(REPO_ROOT, ".unit-test-logs");
/** Portal-bot code reads these to decide where a run's artifacts land; each defaults to a folder
 *  under data/, which is the production forensics store. Tests never write there. */
const ARTIFACT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "unit-test-artifacts-"));
const artifactEnvFor = (root: string): Record<string, string> => ({
  AUTOLEARN_RUN_DIR: path.join(root, "learn-runs"),
  REPLAY_RUN_DIR: path.join(root, "replay-runs"),
  REPLAY_CAPTURE_DIR: path.join(root, "replay-captures"),
  PORTAL_SCREENSHOT_DIR: path.join(root, "screenshots"),
  POWERCLERK_DEBUG_DIR: path.join(root, "portal-debug"),
});

// ---------------------------------------------------------------------------------------------
// Running one suite
// ---------------------------------------------------------------------------------------------

/** Kill a process and everything it started. On POSIX the child is a process-group leader
 *  (detached), so -pid reaches every descendant — including a server the suite forgot to stop —
 *  even after the leader itself has exited. */
const killTree = (pid: number): void => {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
};

type Outcome = "pass" | "fail" | "timeout" | "lied";

interface Result {
  rel: string;
  outcome: Outcome;
  code: number | null;
  seconds: number;
  failLines: string[];
  tail: string[];
  logPath: string;
}

// The per-check failure marker the suites share, anchored exactly as in run-dom-smokes.ts: a
// passing check's label can contain the word "FAIL", so a loose /FAIL/ would read greens as reds.
const FAIL_LINE = /^\s*FAIL\s+-\s/;

const runOne = (rel: string): Promise<Result> =>
  new Promise((resolve) => {
    const started = Date.now();
    const slug = rel.replace(/[\\/]/g, "__").replace(/\.ts$/, "");
    const child = spawn(process.execPath, [TSX_CLI, path.join(REPO_ROOT, rel)], {
      cwd: REPO_ROOT,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...artifactEnvFor(path.join(ARTIFACT_ROOT, slug)) },
    });

    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("error", (e) => { out += `\nspawn error: ${String(e)}\n`; });

    child.on("close", (code) => {
      clearTimeout(timer);
      // Reap anything the suite left behind (a server it booted and never stopped), pass or fail.
      if (child.pid) killTree(child.pid);
      const logPath = path.join(LOG_DIR, `${slug}.log`);
      fs.writeFileSync(logPath, out, "utf8");
      const lines = out.split(/\r?\n/);
      const failLines = lines.filter((l) => FAIL_LINE.test(l)).map((l) => l.trim());
      const tail = lines.filter((l) => l.trim()).slice(-15);
      const outcome: Outcome = timedOut ? "timeout" : code !== 0 ? "fail" : failLines.length ? "lied" : "pass";
      resolve({ rel, outcome, code, seconds: (Date.now() - started) / 1000, failLines, tail, logPath });
    });
  });

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const discovered = suites.flatMap((s) => discover(s));
const excluded = discovered.filter((r) => NOT_UNIT.has(r)).map((rel) => ({ rel, reason: NOT_UNIT.get(rel)! }));
const runnable = discovered.filter((r) => !NOT_UNIT.has(r));
const matched = only.length ? runnable.filter((r) => only.some((f) => r.toLowerCase().includes(f.toLowerCase()))) : runnable;
const filteredOut = runnable.length - matched.length;

// A filter that matches nothing must not read as a green run ("0/0 passed, exit 0").
if (only.length && matched.length === 0) {
  console.error(`--only ${JSON.stringify(only.join(","))} matched none of the ${runnable.length} unit tests. Nothing ran.`);
  process.exit(2);
}

// Round-robin over the sorted list: deterministic, and every file lands in exactly one shard.
const selected = matched.filter((_, i) => i % shardCount === shardIndex - 1);
const otherShards = matched.length - selected.length;

fs.mkdirSync(LOG_DIR, { recursive: true });
console.log(
  `suite ${suiteArg}: discovered ${discovered.length} *.test.ts | running ${selected.length}` +
  `${shardCount > 1 ? ` (shard ${shardIndex}/${shardCount})` : ""} at concurrency ${CONCURRENCY}, ${TIMEOUT_MS / 1000}s each\n`,
);

const results: Result[] = [];
let cursor = 0;
let done = 0;
const worker = async (): Promise<void> => {
  for (;;) {
    const i = cursor++;
    if (i >= selected.length) return;
    const res = await runOne(selected[i]);
    results.push(res);
    done++;
    const tag = { pass: "ok       ", fail: "FAIL     ", timeout: "TIMEOUT  ", lied: "EXIT-LIED" }[res.outcome];
    console.log(`${String(done).padStart(3)}/${selected.length} ${tag} ${res.rel} (${res.seconds.toFixed(0)}s)`);
  }
};
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, () => worker()));

results.sort((a, b) => a.rel.localeCompare(b.rel));
const by = (o: Outcome): Result[] => results.filter((r) => r.outcome === o);
const passed = by("pass");
const failed = by("fail");
const timeouts = by("timeout");
const lied = by("lied");

const rule = "=".repeat(94);
console.log(`\n${rule}\nUNIT TEST SUMMARY (${suiteArg})\n${rule}`);
// THE DENOMINATOR LINE — every number is a share of `discovered`.
console.log(
  `${discovered.length} test files discovered = ${passed.length} passed + ${failed.length} failed + ` +
  `${timeouts.length} timed out + ${lied.length} exit-code-lied + ${excluded.length} excluded (not unit)` +
  `${filteredOut ? ` + ${filteredOut} filtered out by --only` : ""}` +
  `${otherShards ? ` + ${otherShards} in other shards` : ""}`,
);

const report = (title: string, rows: Result[], note: string): void => {
  if (!rows.length) return;
  console.log(`\n${title} (${rows.length})\n${"-".repeat(94)}\n  ${note}`);
  for (const r of rows) {
    console.log(`\n  ${r.rel}  [exit ${r.code}, ${r.seconds.toFixed(0)}s]`);
    if (r.failLines.length) {
      console.log(`    failed checks (${r.failLines.length}):`);
      for (const l of r.failLines) console.log(`      ${l}`);
    } else {
      console.log(`    no "FAIL - " lines: it died before or outside its checks; read the tail`);
    }
    console.log(`    last ${r.tail.length} line(s):`);
    for (const l of r.tail) console.log(`      | ${l}`);
    console.log(`    full log: ${path.relative(REPO_ROOT, r.logPath).split(path.sep).join("/")}`);
  }
};
report("FAILED", failed, "red checks: the test ran and disagreed with the code");
report("TIMED OUT", timeouts, `killed at ${TIMEOUT_MS / 1000}s: a hang, not a red check. Find what never resolved`);
report("EXIT CODE LIED", lied, "printed failures and STILL exited 0: fix the test's exit path first");

if (excluded.length) {
  console.log(`\nEXCLUDED: discovered but deliberately not unit tests (${excluded.length})\n${"-".repeat(94)}`);
  for (const x of excluded) console.log(`  ${x.rel}\n      ${x.reason}`);
}
if (filteredOut) console.log(`\nNOT RUN THIS PASS: ${filteredOut} test(s) excluded by --only ${JSON.stringify(only.join(","))}.`);
if (otherShards) console.log(`\nNOT RUN IN THIS SHARD: ${otherShards} test(s) belong to the other ${shardCount - 1} shard(s).`);

const bad = failed.length + timeouts.length + lied.length;
console.log(`\n${bad === 0 ? "GREEN" : `RED: ${bad} problem(s)`}`);
process.exit(bad === 0 ? 0 : 1);
