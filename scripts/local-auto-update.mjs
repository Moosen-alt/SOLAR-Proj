// LOCAL AUTO-UPDATE: keeps the owner's local install on current `main` (issue #80).
//
//   node scripts/local-auto-update.mjs              one cycle (what the scheduled task runs)
//   node scripts/local-auto-update.mjs --dry-run    print what it would do; change nothing
//
// One cycle, in order. Every refusal/skip leaves the install exactly as it was:
//   1. paused (data/auto-update.pause exists)               -> skip
//   2. not on `main`, or tracked changes in the tree        -> refuse
//   3. `git fetch origin main`; HEAD == origin/main          -> nothing to do
//   4. HEAD is not an ancestor of origin/main (diverged)     -> refuse (fast-forward only)
//   4b. a cycle already failed for THIS origin/main sha (data/auto-update.failed) -> skip until
//      origin/main moves; otherwise a failed pull/npm ci would bounce the server and copy the DB
//      every tick
//   4c. no server answering /health on PORT                 -> skip: it only updates a RUNNING
//      install (issue #290). A stopped server is usually deliberate (a restore, maintenance, the
//      owner in the tree), and a hand start must boot the code the owner left, not a surprise
//   5. NOT IDLE: a job running or due, a portal run queued/running/staged/paused for a human,
//      a filing awaiting_human_submit, a lookup in flight   -> skip, try again next cycle
//      (a waiting portal run / filing counts only while its window can be open: written since the
//      running server started and not on an archived project; issue #99)
//   6. the supervised server (run-prod-supervised.ps1) owns this install -> skip
//   7. snapshot the DB (online backup + .sha256 sidecar, verified) -> no snapshot, no pull
//   8. stop this install's server (the process LISTENING on PORT whose command line is server.ts)
//   9. `git merge --ff-only origin/main`; failure -> restart the old code, install unchanged
//  10. `npm ci` only when package-lock.json changed; failure -> `git reset --keep` back to the old
//      commit and `npm ci` again, BEFORE any start (so no migration of the new code has run)
//  11. restart `npm start` in its own minimized window (unless the server vanished between 4c and 8) and
//      wait for /health to report the new commit (source "git" only: an env-stamped BUILD_SHA
//      names a build, not this checkout). Failure is logged loudly; no automatic rollback,
//      because the new code's migrations may already have run.
//
// Pre-update snapshots are capped at the newest PRE_UPDATE_KEEP. The lock is touched before every
// long step, so a slow cycle (npm ci twice is up to 30 min) never looks stale to the next tick.
//
// Idle is read READ-ONLY: the SQLite DB opened with { readonly: true } (better-sqlite3, already a
// dependency) plus the unauthenticated /health counter of in-flight jobs. No new dependencies.
// Plain .mjs, not .ts, for the same reason as doctor.mjs: an updater that needs tsx could not
// survive the update that broke tsx.
//
// Log: data/logs/auto-update.log, one line per action. Commit shas, counts and timings only; it
// never logs a row's content (no customer data).
//
// The scheduled-task install is a separate, human step: see docs/OWNER_SETUP.md, "Automatic updates".
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";

export const DEFAULTS = {
  root: ROOT,
  branch: "main",
  remote: "origin",
  port: 4173,
  logFile: path.join(ROOT, "data", "logs", "auto-update.log"),
  pauseFile: path.join(ROOT, "data", "auto-update.pause"),
  lockFile: path.join(ROOT, "data", "auto-update.lock"),
  failedFile: path.join(ROOT, "data", "auto-update.failed"),
  healthTimeoutMs: 180_000,
};

// ---------------------------------------------------------------------------------------------
// The idle predicate. ONE place: every state that means "a restart now would lose something".
// ---------------------------------------------------------------------------------------------

// A portal run in any of these is a live browser session or one a human is about to act on.
// Restarting closes the review window the human submits from (hard rule 1's human gate).
export const BUSY_PORTAL_RUN_STATUSES = ["queued", "running", "awaiting_human_submit", "awaiting_human_resubmit", "paused_for_human"];

// A review window lives in the server process that staged it (issue #99). A row staged BEFORE the
// running server started has no window left to close (that process and its browser are gone), and a
// row on an archived project is never filed from one. So a waiting portal run / filing holds an
// update only while its window can still be open: written since `liveSince` (the running server's
// start) and not on an archived project. `liveSince` null = start unknown: every non-archived
// waiting row counts. Times go through julianday() so 'YYYY-MM-DD HH:MM:SS' and ISO 'T…Z' compare
// alike; a time that cannot be read counts as live.
const LIVE_SINCE = (col) => `(? IS NULL OR ${col} IS NULL OR julianday(${col}) IS NULL OR julianday(${col}) >= julianday(?))`;
const NOT_ARCHIVED = (alias) =>
  `NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = ${alias}.project_id AND p.archived_at IS NOT NULL AND p.archived_at <> '')`;

/** Counts that make the install busy. `nowIso` decides which pending jobs are due; `liveSince` (ISO,
 *  or null when unknown) decides which waiting portal runs and filings can still have a window. */
export function readBusyCounts(db, nowIso = new Date().toISOString(), liveSince = null) {
  const n = (sql, params = []) => db.prepare(sql).get(...params).n;
  const marks = BUSY_PORTAL_RUN_STATUSES.map(() => "?").join(", ");
  return {
    // A pending job scheduled for later survives a restart untouched; a due one is about to run.
    jobs: n(
      "SELECT COUNT(*) AS n FROM job_queue WHERE status = 'running' OR (status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= ?))",
      [nowIso],
    ),
    portalRuns: n(
      `SELECT COUNT(*) AS n FROM portal_runs r WHERE r.status IN (${marks}) AND ${LIVE_SINCE("r.started_at")} AND ${NOT_ARCHIVED("r")}`,
      [...BUSY_PORTAL_RUN_STATUSES, liveSince, liveSince],
    ),
    filings: n(
      `SELECT COUNT(*) AS n FROM submissions s WHERE s.status = 'awaiting_human_submit' AND ${LIVE_SINCE("s.created_at")} AND ${NOT_ARCHIVED("s")}`,
      [liveSince, liveSince],
    ),
  };
}

/** Waiting rows that do NOT hold the update (staged before the running server started, or on an
 *  archived project). Only for the log line, so the owner can see what was set aside and why. */
export function readStaleWaiting(db, liveSince = null) {
  const n = (sql, params = []) => db.prepare(sql).get(...params).n;
  const marks = BUSY_PORTAL_RUN_STATUSES.map(() => "?").join(", ");
  const live = readBusyCounts(db, new Date().toISOString(), liveSince);
  return {
    portalRuns: n(`SELECT COUNT(*) AS n FROM portal_runs WHERE status IN (${marks})`, BUSY_PORTAL_RUN_STATUSES) - live.portalRuns,
    filings: n("SELECT COUNT(*) AS n FROM submissions WHERE status = 'awaiting_human_submit'") - live.filings,
  };
}

// How far back a review window can still be open: the running server's start, read from /health's
// uptimeSec, with a minute of slack (uptime is rounded; a row may be written while it boots). No
// server listening = nothing can be open. A server that is there but did not answer /health, or an
// older one with no uptimeSec, = unknown (null), and every non-archived waiting row counts.
export const LIVE_SLACK_MS = 60_000;
export function liveSessionCutoff(health, server, nowMs) {
  if (health && typeof health.uptimeSec === "number" && Number.isFinite(health.uptimeSec) && health.uptimeSec >= 0) {
    return new Date(nowMs - health.uptimeSec * 1000 - LIVE_SLACK_MS).toISOString();
  }
  if (!health && server && Array.isArray(server.roots) && server.roots.length === 0) return new Date(nowMs).toISOString();
  return null;
}

/** Busy reasons from the DB counts plus /health's in-process count; [] means idle. */
export function busyReasons(counts, health) {
  const reasons = [];
  if (!counts) return ["idle state unreadable"];
  if (counts.jobs > 0) reasons.push(`${counts.jobs} job(s) running or due`);
  if (counts.portalRuns > 0) reasons.push(`${counts.portalRuns} portal run(s) in progress, staged or paused for a human`);
  if (counts.filings > 0) reasons.push(`${counts.filings} filing(s) awaiting_human_submit`);
  const inFlight = health?.jobs?.inFlightThisProcess ?? 0;
  if (inFlight > 0) reasons.push(`${inFlight} job(s)/lookup(s) in flight in the server`);
  return reasons;
}

// ---------------------------------------------------------------------------------------------
// Bookkeeping: the failure marker, the snapshot cap, the lock. Pure or file-local; tested directly.
// ---------------------------------------------------------------------------------------------

// Outcomes after which the install was (or may have been) bounced and is back at `from` while
// origin/main is still `to`. Retrying the same `to` would repeat the same failure every tick.
export const MARK_FAILED_OUTCOMES = ["stop-failed", "pull-failed", "npm-ci-failed"];

/** The `to` sha a previous cycle failed on, or null. Format: "<sha> <outcome>\n". */
export function readFailedMarker(file) {
  try { return fs.readFileSync(file, "utf8").trim().split(/\s+/)[0] || null; } catch { return null; }
}

export const PRE_UPDATE_KEEP = 3;
const PRE_UPDATE_RE = /^autopilot-pre-update-[0-9a-f]+-(.+)\.sqlite$/;

/** Pre-update snapshot names to delete so only the newest `keep` remain (newest by name stamp). */
export function preUpdateSnapshotsToPrune(names, keep = PRE_UPDATE_KEEP) {
  const stamped = names.map((n) => ({ n, m: PRE_UPDATE_RE.exec(n) })).filter((x) => x.m);
  stamped.sort((a, b) => (a.m[1] < b.m[1] ? 1 : a.m[1] > b.m[1] ? -1 : 0));
  return stamped.slice(keep).map((x) => x.n);
}

// The worst cycle (npm ci 900 s, twice, plus the stop wait and the 180 s health wait) is longer than
// any single step, so the lock is touched before every step (`deps.heartbeat`); the longest gap
// between touches is one npm ci (15 min), well inside this.
export const LOCK_STALE_MS = 45 * 60_000;

/** Exclusive lock so a slow cycle and the next scheduled one do not overlap. */
export function takeLock(lockFile, now = Date.now()) {
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    if (fs.existsSync(lockFile) && now - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lockFile);
    fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });
    return () => { try { fs.unlinkSync(lockFile); } catch { /* already gone */ } };
  } catch { return null; }
}

/** Mark the lock as still held (its mtime is what staleness reads). */
export function touchLock(lockFile) {
  try { const t = new Date(); fs.utimesSync(lockFile, t, t); } catch { /* lock gone: nothing to keep fresh */ }
}

// ---------------------------------------------------------------------------------------------
// One cycle. Every side effect goes through `deps`, so the test drives it with mocks.
// ---------------------------------------------------------------------------------------------

/**
 * @returns {Promise<{ outcome: string, from?: string, to?: string, reasons?: string[] }>}
 * Outcomes: paused | refused | fetch-failed | up-to-date | failed-before | no-server | busy | supervised |
 * would-update | snapshot-failed | stop-failed | pull-failed | npm-ci-failed | updated | unhealthy
 */
export async function runCycle(deps, opts = {}) {
  const { branch = "main", remote = "origin", dryRun = false } = opts;
  const log = deps.log;
  const beat = () => deps.heartbeat?.();
  const git = (...args) => deps.git(args);
  const t0 = deps.now();
  const took = () => `${((deps.now() - t0) / 1000).toFixed(1)}s`;

  if (deps.paused()) { log("paused (pause file present); nothing done"); return { outcome: "paused" }; }

  const current = git("rev-parse", "--abbrev-ref", "HEAD");
  if (current.code !== 0 || current.out !== branch) {
    log(`refused: checkout is on "${current.out || "?"}", not ${branch}; nothing done`);
    return { outcome: "refused", reasons: ["not on main"] };
  }
  const status = git("status", "--porcelain", "--untracked-files=no");
  if (status.code !== 0 || status.out !== "") {
    log("refused: tracked files have local changes; nothing done");
    return { outcome: "refused", reasons: ["dirty tree"] };
  }

  const fetch = git("fetch", "--quiet", remote, branch);
  if (fetch.code !== 0) { log(`fetch failed (exit ${fetch.code}); nothing done`); return { outcome: "fetch-failed" }; }
  const from = git("rev-parse", "HEAD").out;
  const to = git("rev-parse", `${remote}/${branch}`).out;
  if (!from || !to) { log("refused: could not resolve HEAD or the remote branch; nothing done"); return { outcome: "refused", reasons: ["unresolved sha"] }; }
  const short = (s) => s.slice(0, 7);
  if (from === to) { log(`up to date at ${short(from)}`); return { outcome: "up-to-date", from, to }; }
  if (git("merge-base", "--is-ancestor", from, to).code !== 0) {
    log(`refused: ${short(from)} is not an ancestor of ${remote}/${branch} ${short(to)} (diverged); nothing done`);
    return { outcome: "refused", from, to, reasons: ["diverged"] };
  }

  const failedTo = deps.failedTo?.() ?? null;
  if (failedTo === to) {
    log(`skipped: a previous cycle already failed on ${short(to)} (see earlier lines); waiting for ${remote}/${branch} to move. Delete data/auto-update.failed to retry now`);
    return { outcome: "failed-before", from, to };
  }

  // Only a running install is updated (#290): no server up means the owner stopped it, and the
  // checkout stays on the code they left until they start it again.
  if (!(await deps.serverUp())) {
    log(`skipped ${short(from)} -> ${short(to)}: no server answering /health; the updater only updates a running install`);
    return { outcome: "no-server", from, to };
  }

  const busy = await deps.busy();
  if (busy.length) { log(`busy, skipping ${short(from)} -> ${short(to)}: ${busy.join("; ")}`); return { outcome: "busy", from, to, reasons: busy }; }
  if (deps.supervisorRunning()) {
    log("skipped: run-prod-supervised.ps1 is running and owns restarts of this install; nothing done");
    return { outcome: "supervised", from, to };
  }

  // `git diff --quiet` exits 1 when the file differs between the two commits.
  const lockfileChanged = git("diff", "--quiet", from, to, "--", "package-lock.json").code !== 0;
  if (dryRun) {
    log(`dry-run: would snapshot the DB, stop the server, fast-forward ${short(from)} -> ${short(to)}, ` +
      `${lockfileChanged ? "run npm ci (package-lock.json changed)" : "skip npm ci (package-lock.json unchanged)"}, restart, check /health`);
    return { outcome: "would-update", from, to, lockfileChanged };
  }

  // From here every early return after a bounce records the failure, so the next tick skips `to`.
  const fail = (outcome) => { deps.markFailed?.(to, outcome); return { outcome, from, to }; };

  beat();
  const snap = await deps.snapshot(short(from));
  if (!snap.ok) { log(`snapshot failed: ${snap.detail}; no snapshot, no pull`); return { outcome: "snapshot-failed", from, to }; }
  log(`snapshot ${snap.file} verified`);

  // The snapshot took time; a job may have started meanwhile. Last check before anything stops.
  const busyAgain = await deps.busy();
  if (busyAgain.length) { log(`busy after snapshot, skipping: ${busyAgain.join("; ")}`); return { outcome: "busy", from, to, reasons: busyAgain }; }

  beat();
  const stop = deps.stopServer();
  if (!stop.ok) { log(`could not stop the server: ${stop.detail}; nothing pulled`); return fail("stop-failed"); }
  const wasRunning = stop.stopped > 0;
  log(wasRunning ? `stopped server (${stop.stopped} process tree(s))` : "no server was running");

  beat();
  const merge = git("merge", "--ff-only", "--quiet", to);
  if (merge.code !== 0 || git("rev-parse", "HEAD").out !== to) {
    // --ff-only either moves HEAD all the way or not at all; make sure it is where it started.
    const at = git("rev-parse", "HEAD").out;
    if (at !== from) git("reset", "--keep", from);
    log(`PULL FAILED (exit ${merge.code}); install left at ${short(from)}`);
    if (wasRunning) { beat(); deps.startServer(); log("restarted server on the unchanged install"); }
    return fail("pull-failed");
  }
  log(`fast-forwarded ${short(from)} -> ${short(to)}`);

  if (lockfileChanged) {
    beat();
    const ci = deps.npmCi();
    if (ci.code !== 0) {
      log(`NPM CI FAILED (exit ${ci.code}); rolling back to ${short(from)} before any start`);
      git("reset", "--keep", from);
      beat();
      const back = deps.npmCi();
      log(back.code === 0 ? `rolled back to ${short(from)} and reinstalled its dependencies` : `ROLLBACK npm ci ALSO FAILED (exit ${back.code}); run "npm ci" by hand`);
      if (wasRunning && back.code === 0) { beat(); deps.startServer(); log("restarted server on the old install"); }
      return fail("npm-ci-failed");
    }
    log("npm ci done (package-lock.json changed)");
  } else {
    log("npm ci skipped (package-lock.json unchanged)");
  }

  deps.clearFailed?.();
  if (!wasRunning) { log(`updated ${short(from)} -> ${short(to)} in ${took()}; the server went away after the check and before the stop, not started`); return { outcome: "updated", from, to }; }
  beat();
  deps.startServer();
  log("started server");
  if (!(await deps.waitForBuild(to))) {
    log(`UPDATE APPLIED BUT HEALTH CHECK FAILED: /health did not report ${short(to)} in time. Check the server window. No automatic rollback (migrations may have run).`);
    return { outcome: "unhealthy", from, to };
  }
  log(`updated ${short(from)} -> ${short(to)} in ${took()}; /health reports the new commit`);
  return { outcome: "updated", from, to };
}

// ---------------------------------------------------------------------------------------------
// The real side effects (the CLI). Nothing below runs when the test imports this module.
// ---------------------------------------------------------------------------------------------

function run(cmd, args, cwd, timeout = 120_000) {
  // npm is a .cmd shim on Windows, so it needs the shell; git and powershell do not.
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: WIN && cmd === "npm", timeout, windowsHide: true });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}`.trim() };
}

// One PowerShell call answers "which process trees are THIS install's server" and "is the
// supervisor running". The server is the process LISTENING on the port whose command line runs
// backend/src/server.ts; we walk up through its node/cmd parents that are part of the same
// `npm start` (so the old window closes too) and kill that root's tree.
const PS_SERVER = `
$ErrorActionPreference = 'SilentlyContinue'
$port = [int]$env:AU_PORT
$all = @{}; Get-CimInstance Win32_Process | ForEach-Object { $all[[int]$_.ProcessId] = $_ }
$roots = @()
foreach ($c in @(Get-NetTCPConnection -LocalPort $port -State Listen)) {
  $p = $all[[int]$c.OwningProcess]
  if (-not $p -or $p.CommandLine -notmatch 'server\\.ts') { continue }
  while ($true) {
    $parent = $all[[int]$p.ParentProcessId]
    if (-not $parent -or $parent.Name -notin @('node.exe','cmd.exe') -or $parent.CommandLine -notmatch 'npm|tsx|server\\.ts') { break }
    $p = $parent
  }
  $roots += [int]$p.ProcessId
}
$sup = [bool]($all.Values | Where-Object { $_.CommandLine -like '*run-prod-supervised.ps1*' })
@{ roots = @($roots | Select-Object -Unique); supervisor = $sup } | ConvertTo-Json -Compress
`;

function inspectServer(cfg) {
  if (!WIN) return { roots: [], supervisor: false };
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_SERVER], {
    encoding: "utf8", env: { ...process.env, AU_PORT: String(cfg.port) }, timeout: 60_000, windowsHide: true,
  });
  try { const j = JSON.parse(r.stdout); return { roots: [].concat(j.roots ?? []), supervisor: !!j.supervisor }; }
  catch { return null; }
}

/** True when /health's build came from git (not an env stamp) and names `toSha`. */
export function healthReportsCommit(health, toSha) {
  const b = health?.build;
  return !!(b && b.source === "git" && typeof b.sha === "string" && b.sha && toSha.startsWith(b.sha));
}

async function getHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
    return await res.json();
  } catch { return null; }
}

function loadEnv(root) {
  // The server reads .env via dotenv; read the same file so the DB and BACKUP_DIR match.
  try { createRequire(path.join(root, "package.json"))("dotenv").config({ path: path.join(root, ".env") }); } catch { /* no .env */ }
}

function openDb(root, readonly) {
  const Database = createRequire(path.join(root, "package.json"))("better-sqlite3");
  const dbPath = path.resolve(root, process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite");
  return new Database(dbPath, { readonly, fileMustExist: true });
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function realDeps(cfg, log) {
  return {
    log,
    now: () => Date.now(),
    paused: () => fs.existsSync(cfg.pauseFile),
    heartbeat: () => touchLock(cfg.lockFile),
    failedTo: () => readFailedMarker(cfg.failedFile),
    markFailed: (to, outcome) => { try { fs.writeFileSync(cfg.failedFile, `${to} ${outcome}\n`); } catch { /* the log line still says it failed */ } },
    clearFailed: () => { try { fs.unlinkSync(cfg.failedFile); } catch { /* none */ } },
    git: (args) => run("git", args, cfg.root),
    npmCi: () => run("npm", ["ci"], cfg.root, 900_000),
    // Up = /health answered. A process that listens but does not answer is not an install worth
    // updating under; skipping is the conservative reading of "only while the server is up".
    serverUp: async () => (await getHealth(cfg.port)) !== null,
    async busy() {
      const health = await getHealth(cfg.port);
      // Only ask Windows for the server process when /health did not answer (no server, or a hung one).
      const liveSince = liveSessionCutoff(health, health ? null : inspectServer(cfg), Date.now());
      let counts = null;
      let stale = null;
      try {
        const db = openDb(cfg.root, true);
        try { counts = readBusyCounts(db, new Date().toISOString(), liveSince); stale = readStaleWaiting(db, liveSince); } finally { db.close(); }
      } catch { counts = null; }
      if (stale && (stale.portalRuns > 0 || stale.filings > 0)) {
        log(`not holding for ${stale.portalRuns} portal run(s) / ${stale.filings} filing(s) waiting on a human from before the running server started${liveSince ? ` (${liveSince})` : ""} or on archived projects: no window of theirs can be open`);
      }
      return busyReasons(counts, health);
    },
    supervisorRunning: () => inspectServer(cfg)?.supervisor ?? true, // unreadable = assume it is
    // Online backup from a read-only connection, then the sha256sum-format sidecar backup.ts
    // writes, then re-read both and run quick_check on the copy. Named `autopilot-pre-update-…`
    // so it lists with the other snapshots; backup.ts rotation never prunes it (isAutomaticSnapshot),
    // so this keeps only the newest PRE_UPDATE_KEEP of them itself, after the new one verifies.
    async snapshot(fromShort) {
      try {
        const dir = path.resolve(cfg.root, process.env.BACKUP_DIR || "backend/data/backups");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `autopilot-pre-update-${fromShort}-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
        const db = openDb(cfg.root, true);
        try { await db.backup(file); } finally { db.close(); }
        fs.writeFileSync(`${file}.sha256`, `${sha256File(file)}  ${path.basename(file)}\n`);
        const recorded = fs.readFileSync(`${file}.sha256`, "utf8").slice(0, 64);
        if (recorded !== sha256File(file)) return { ok: false, detail: "sidecar does not match the snapshot" };
        const Database = createRequire(path.join(cfg.root, "package.json"))("better-sqlite3");
        const copy = new Database(file, { readonly: true });
        try { if (copy.pragma("quick_check", { simple: true }) !== "ok") return { ok: false, detail: "quick_check failed on the snapshot" }; }
        finally { copy.close(); }
        for (const old of preUpdateSnapshotsToPrune(fs.readdirSync(dir))) {
          for (const f of [old, `${old}.sha256`]) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* best effort */ } }
        }
        return { ok: true, file: path.basename(file) };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : String(err) };
      }
    },
    stopServer() {
      const found = inspectServer(cfg);
      if (!found) return { ok: false, detail: "could not list processes" };
      for (const pid of found.roots) run("taskkill", ["/PID", String(pid), "/T", "/F"], cfg.root);
      // Wait for the port to free; Windows cannot replace node_modules under a running server.
      for (let i = 0; i < 30; i++) {
        const left = inspectServer(cfg);
        if (left && left.roots.length === 0) return { ok: true, stopped: found.roots.length };
        spawnSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
      }
      return { ok: false, detail: `port ${cfg.port} still held after stopping` };
    },
    startServer() {
      // Its own visible (minimized) window, as the logged-in owner: PORTAL_HEADLESS=false needs
      // the desktop session, and the owner reads the server's output there as before.
      spawn("cmd.exe", ["/d", "/s", "/c", 'start "SOLAR-Proj server" /min cmd /k npm start'], {
        cwd: cfg.root, detached: true, stdio: "ignore", windowsVerbatimArguments: true,
      }).unref();
    },
    async waitForBuild(toSha) {
      const deadline = Date.now() + cfg.healthTimeoutMs;
      while (Date.now() < deadline) {
        const h = await getHealth(cfg.port);
        // Only a git-derived sha describes this checkout; BUILD_SHA/APP_VERSION/BUILD_DATE in .env
        // (source "env") would never match and must not count as "the new commit is up".
        if (healthReportsCommit(h, toSha)) return true;
        await new Promise((r) => setTimeout(r, 3000));
      }
      return false;
    },
  };
}

function makeLogger(logFile, echo = true) {
  return (msg) => {
    const line = `${new Date().toISOString()} [auto-update] ${msg}`;
    if (echo) console.log(line);
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${line}\n`); } catch { /* logging never stops a cycle */ }
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const cfg = { ...DEFAULTS };
  loadEnv(cfg.root);
  cfg.port = Number(process.env.PORT || cfg.port);
  // A dry run writes nothing, its log line included.
  const log = dryRun ? (msg) => console.log(`[auto-update] ${msg}`) : makeLogger(cfg.logFile);
  if (!WIN && !dryRun) {
    log("refused: stopping and restarting the server is implemented for Windows only; use --dry-run here");
    process.exit(2);
  }
  const release = dryRun ? () => {} : takeLock(cfg.lockFile);
  if (!release) { log("another update cycle is running; nothing done"); return; }
  try {
    const result = await runCycle(realDeps(cfg, log), { dryRun });
    if (["pull-failed", "npm-ci-failed", "unhealthy", "snapshot-failed", "stop-failed"].includes(result.outcome)) process.exitCode = 1;
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(`[auto-update] crashed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
}
