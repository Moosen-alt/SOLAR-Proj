// A SUITE THAT STOPS AT THE FIRST RED IS A SUITE THAT REPORTS ONE FACT AND HIDES SEVENTY.
//
// `portal:test:dom` was 71 smokes joined with `&&`. `controlIdentity` is the 9th, and it has
// been red since before this session — so the chain died at #9 on every run and smokes 10..71
// HAD NOT EXECUTED for an unknown number of weeks. Nobody knew, because `&&` reports the first
// failure and stops, and the exit code of a chain says nothing about what it skipped. That is
// the same shape as the other exit-code lies this project keeps hitting: an answer that is true
// about one thing and silent about everything else.
//
// This runs EVERY smoke in its own process, collects all the reds, and prints a summary with a
// DENOMINATOR — a count of passes with nothing to divide by is how "63 not running" stayed
// invisible.
//
//   npx tsx scripts/run-dom-smokes.ts
//   npx tsx scripts/run-dom-smokes.ts --only controlIdentity,battery
//   npx tsx scripts/run-dom-smokes.ts --concurrency 4 --timeout 240
//
// Design decisions that are load-bearing — do not "simplify" these away:
//
//   DISCOVERY, NOT A LIST. The old runner (portal-bot/src/runDomSmokes.ts, now deleted) built
//   its list by parsing the `&&` chain out of package.json, so it inherited exactly the drift
//   it was meant to cure: a smoke nobody remembered to append to the chain was invisible to
//   both. Here the filesystem is the register. A new `*.dom.smoke.ts` runs the day it lands.
//
//   BROAD NET, THEN CLASSIFY. Discovery matches `*.smoke.ts`, not `*.dom.smoke.ts`, because the
//   one file that actually broke the convention is `autoLearnDom.smoke.ts` — a real DOM smoke
//   that a `.dom.smoke.ts` glob silently drops. Matching wide and then sorting into buckets
//   means a misnamed file surfaces as UNCLASSIFIED instead of vanishing.
//
//   UNCLASSIFIED IS A FAILURE, NOT A SHRUG. A discovered smoke that fits no bucket is never run
//   (it might be a live/credentialed one) and makes the suite exit non-zero until a human sorts
//   it. Silently skipping the unknown is the bug this file exists to prevent.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

/**
 * Real DOM smokes whose filename predates the `*.dom.smoke.ts` convention. Listed by hand
 * BECAUSE they are the exception — every other DOM smoke is found by the convention and needs
 * no entry here. Renaming the file would empty this map; that is fine, and preferable.
 */
const LEGACY_DOM_SMOKES = new Set<string>([
  "portal-bot/src/adapters/autoLearnDom.smoke.ts",
]);

/**
 * Discovered smokes that are deliberately NOT part of this suite, each with the reason a human
 * needs in order to agree with the decision. These are REPORTED in every summary rather than
 * quietly filtered: an exclusion you cannot see is indistinguishable from a smoke that stopped
 * existing, and this project has already paid for one invisible filter.
 */
const NOT_DOM_SMOKES = new Map<string, string>([
  ["portal-bot/src/adapters/autoLearnLive.smoke.ts", "live portal + real credentials — npm run portal:test:live"],
  ["portal-bot/src/adapters/oregonEPermitting.stress.smoke.ts", "live stress run — npm run portal:test:stress"],
  ["backend/test/rehearsal.live.smoke.ts", "live rehearsal against real services — npm run rehearse:live"],
]);

type Bucket = "run" | "skip" | "unclassified";

const classify = (rel: string): { bucket: Bucket; reason: string } => {
  if (NOT_DOM_SMOKES.has(rel)) return { bucket: "skip", reason: NOT_DOM_SMOKES.get(rel)! };
  if (rel.endsWith(".dom.smoke.ts")) return { bucket: "run", reason: "matches the .dom.smoke.ts convention" };
  if (LEGACY_DOM_SMOKES.has(rel)) return { bucket: "run", reason: "legacy name, known DOM smoke" };
  return {
    bucket: "unclassified",
    reason: "ends in .smoke.ts but is neither a .dom.smoke.ts nor a known exception — rename it to " +
      "*.dom.smoke.ts, or add it to NOT_DOM_SMOKES with a reason",
  };
};

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "data", "portal-profiles"]);
// Top-level folders that hold COPIES of this tree: .probe/ carries git worktrees and scratch kits,
// demo-kit/ is the shipped demo install, .claude/ may hold agent worktrees. Walking them ran every
// smoke several times over against stale code and reported the copies' failures as ours. Matched
// only at the repo root, so a legitimately nested folder of the same name is still searched.
const IGNORED_ROOT_DIRS = new Set([".probe", "demo-kit", "demo-kit-data", ".claude", ".playwright-mcp", ".dom-smoke-logs"]);

const discover = (dir: string, found: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (dir === REPO_ROOT && IGNORED_ROOT_DIRS.has(entry.name)) continue;
      discover(path.join(dir, entry.name), found);
    } else if (entry.name.endsWith(".smoke.ts")) {
      // `.endsWith(".smoke.ts")` and not `/smoke\.ts$/` on purpose: backend/src/smoke.ts is the
      // end-to-end runner, not a smoke in this suite, and must not be swept in.
      found.push(path.relative(REPO_ROOT, path.join(dir, entry.name)).split(path.sep).join("/"));
    }
  }
  return found;
};

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const only = (argValue("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.max(1, Number(argValue("concurrency") ?? 3));
// Generous on purpose. The budget exists to bound a HANG, not to police slowness — and under
// concurrency every smoke's own Chromium competes for the same cores, so a wall clock that looks
// roomy in isolation produces FALSE TIMEOUTs in a full run. Measured 2026-09-12 on the full set:
// terminalPage takes 317s ALONE and was killed at a 300s budget during the concurrency-3 run —
// reported as a hang when nothing had hung. multiArray landed at 291s, also inside the noise.
// 600s clears the slowest real smoke twice over and still catches the failure this bounds:
// replica.dom.smoke once sat for FIFTY MINUTES. Raise it, don't lower it.
const TIMEOUT_MS = Math.max(1, Number(argValue("timeout") ?? 600)) * 1000;
const LOG_DIR = path.join(REPO_ROOT, ".dom-smoke-logs");

// ---------------------------------------------------------------------------------------------
// Running one smoke
// ---------------------------------------------------------------------------------------------

// Spawn node against tsx's own entry rather than the `tsx` shim through a shell. With
// `shell:true` on Windows, child.pid is the cmd.exe wrapper — killing it on timeout leaves tsx
// and its Chromium running, which is precisely where the orphaned browsers of 2026-09-08 came
// from. Owning the real pid lets the timeout path kill the whole tree.
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const killTree = (pid: number): void => {
  if (process.platform === "win32") {
    // /T = the process and every descendant (tsx -> node -> chrome.exe), /F = force.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
};

type Outcome = "pass" | "fail" | "timeout" | "disagreement";

interface Result {
  rel: string;
  outcome: Outcome;
  code: number | null;
  seconds: number;
  failLines: string[];
  tail: string[];
  logPath: string;
}

// The per-check failure marker the whole suite shares: `  FAIL - <label>` followed by an
// indented detail line carrying expected-vs-actual. Anchored to the line start with the exact
// space-dash-space, because several smokes print the WORD "FAILED" inside a passing check's
// label ("ok   - ... FAILED TO FIND."), and a loose /FAIL/ would read those as reds.
const FAIL_LINE = /^\s*FAIL\s+-\s/;

const runOne = (rel: string): Promise<Result> =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [TSX_CLI, path.join(REPO_ROOT, rel)], {
      cwd: REPO_ROOT,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
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
      const logPath = path.join(LOG_DIR, `${rel.replace(/[\\/]/g, "__").replace(/\.ts$/, "")}.log`);
      fs.writeFileSync(logPath, out, "utf8");

      const lines = out.split(/\r?\n/);
      const failLines = lines.filter((l) => FAIL_LINE.test(l)).map((l) => l.trim());
      const tail = lines.filter((l) => l.trim()).slice(-15);
      const seconds = (Date.now() - started) / 1000;

      let outcome: Outcome;
      if (timedOut) outcome = "timeout";
      else if (code !== 0) outcome = "fail";
      // EXIT 0 WITH REDS IN THE LOG IS ITS OWN CATEGORY. A chain in this project once crashed
      // with a SqliteError and still reported exit 0; a smoke that prints `FAIL - ` and exits
      // clean is the same lie one level down, and it needs a different repair (fix the smoke's
      // exit path) than an honest red. Only `FAIL - ` lines and the replica runner's explicit
      // error banner are trusted here — see FAIL_LINE on why a loose match is wrong.
      else if (failLines.length > 0 || /\bSMOKE ERROR\b/.test(out)) outcome = "disagreement";
      else outcome = "pass";

      resolve({ rel, outcome, code, seconds, failLines, tail, logPath });
    });
  });

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const discovered = discover(REPO_ROOT).sort();
const runnable: string[] = [];
const skipped: Array<{ rel: string; reason: string }> = [];
const unclassified: Array<{ rel: string; reason: string }> = [];

for (const rel of discovered) {
  const { bucket, reason } = classify(rel);
  if (bucket === "run") runnable.push(rel);
  else if (bucket === "skip") skipped.push({ rel, reason });
  else unclassified.push({ rel, reason });
}

const selected = only.length ? runnable.filter((r) => only.some((f) => r.toLowerCase().includes(f.toLowerCase()))) : runnable;
const filteredOut = runnable.length - selected.length;

// A filter that matches nothing must not read as a green run. `--only typo` printing
// "0/0 passed, exit 0" is the filter-lists-fail-both-ways trap: the suite answers "all clear"
// about a set it never built.
if (only.length && selected.length === 0) {
  console.error(`--only ${JSON.stringify(only.join(","))} matched none of the ${runnable.length} DOM smokes. Nothing ran.`);
  process.exit(2);
}

fs.mkdirSync(LOG_DIR, { recursive: true });

console.log(`discovered ${discovered.length} *.smoke.ts | ${runnable.length} DOM | running ${selected.length}` +
  ` at concurrency ${CONCURRENCY}, ${TIMEOUT_MS / 1000}s each`);
if (unclassified.length) console.log(`WARNING: ${unclassified.length} unclassified — see summary`);
console.log("");

const results: Result[] = [];
let cursor = 0;
let done = 0;

const worker = async (): Promise<void> => {
  for (;;) {
    const i = cursor++;
    if (i >= selected.length) return;
    const rel = selected[i];
    const res = await runOne(rel);
    results.push(res);
    done++;
    const tag = { pass: "ok        ", fail: "FAIL      ", timeout: "TIMEOUT   ", disagreement: "EXIT-LIED " }[res.outcome];
    console.log(`${String(done).padStart(3)}/${selected.length} ${tag} ${path.basename(rel)} (${res.seconds.toFixed(0)}s)`);
  }
};

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, () => worker()));

results.sort((a, b) => a.rel.localeCompare(b.rel));
const by = (o: Outcome): Result[] => results.filter((r) => r.outcome === o);
const passed = by("pass");
const failed = by("fail");
const timeouts = by("timeout");
const lied = by("disagreement");

const rule = "=".repeat(94);
console.log(`\n${rule}\nDOM SMOKE SUMMARY\n${rule}`);

// THE DENOMINATOR LINE. Every number here is a share of `discovered` — a bare "N passed" with
// nothing to divide by is one of this project's recorded ways of sounding green while hiding a
// set that never ran.
console.log(
  `${discovered.length} smoke files discovered = ${passed.length} passed + ${failed.length} failed + ` +
  `${timeouts.length} timed out + ${lied.length} exit-code-lied + ${skipped.length} skipped (not DOM)` +
  `${filteredOut ? ` + ${filteredOut} filtered out by --only` : ""}` +
  `${unclassified.length ? ` + ${unclassified.length} UNCLASSIFIED` : ""}`,
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
      console.log(`    no "FAIL - " lines — it died before or outside the checks; read the tail`);
    }
    console.log(`    last ${r.tail.length} line(s):`);
    for (const l of r.tail) console.log(`      | ${l}`);
    console.log(`    full log: ${path.relative(REPO_ROOT, r.logPath).split(path.sep).join("/")}`);
  }
};

report("FAILED", failed, "red checks — the smoke ran and disagreed with the code");
report("TIMED OUT", timeouts, `killed at ${TIMEOUT_MS / 1000}s — a hang, not a red check. Different repair: find what never resolved`);
report("EXIT CODE LIED", lied, "printed failures and STILL exited 0 — the smoke's own exit path is broken, fix that first");

if (skipped.length) {
  console.log(`\nSKIPPED — discovered but deliberately not part of this suite (${skipped.length})\n${"-".repeat(94)}`);
  for (const s of skipped) console.log(`  ${s.rel}\n      ${s.reason}`);
}

if (unclassified.length) {
  console.log(`\nUNCLASSIFIED — DISCOVERED AND NOT RUN (${unclassified.length})\n${"-".repeat(94)}`);
  console.log(`  These were NOT executed. A smoke nobody classified is exactly how 63 of them went`);
  console.log(`  unrun, so this is a failure until someone decides which bucket each belongs in.`);
  for (const u of unclassified) console.log(`  ${u.rel}\n      ${u.reason}`);
}

if (filteredOut) console.log(`\nNOT RUN THIS PASS: ${filteredOut} DOM smoke(s) excluded by --only ${JSON.stringify(only.join(","))}.`);

const bad = failed.length + timeouts.length + lied.length + unclassified.length;
console.log(`\n${bad === 0 ? "GREEN" : `RED — ${bad} problem(s)`}`);
process.exit(bad === 0 ? 0 : 1);
