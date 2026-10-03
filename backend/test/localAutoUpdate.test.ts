// LOCAL AUTO-UPDATE: THE DECISION LOGIC OF scripts/local-auto-update.mjs (issue #80).
//
// The owner's install pulls `main` and restarts itself every 15 minutes. Restarting at the wrong
// moment closes the browser window a human is about to submit a filing from; pulling at the wrong
// moment leaves a half-updated install. So every guard is pinned here, with the shell steps mocked
// (git, npm, server stop/start, snapshot): nothing touches a real checkout or a real server.
//
//   MUST-PASS    idle + behind -> snapshot, stop, fast-forward, restart, health; lockfile changed
//                -> npm ci; the idle predicate reads the real schema read-only.
//   MUST-EXCLUDE busy (job running/due, portal run staged or paused for a human, filing
//                awaiting_human_submit, lookup in flight) -> no stop, no pull; dirty tree / not on
//                main / diverged -> nothing; lockfile unchanged -> no npm ci; failed pull -> the
//                install is restarted unchanged; dry-run -> no side effect.
//
// Run: npx tsx backend/test/localAutoUpdate.test.ts
import { ISOLATED_CWD, REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(path.join(REPO, "scripts", "local-auto-update.mjs")).href);
const { runCycle, busyReasons, readBusyCounts, BUSY_PORTAL_RUN_STATUSES } = mod;

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

type World = {
  branch?: string; dirty?: boolean; head?: string; remote?: string; diverged?: boolean;
  lockfileChanged?: boolean; mergeFails?: boolean; npmCiFails?: boolean; busy?: string[];
  supervisor?: boolean; serverRunning?: boolean; healthy?: boolean; paused?: boolean; snapshotFails?: boolean;
};

/** A fake checkout + server. `calls` records every side effect in order. */
function harness(w: World) {
  const calls: string[] = [];
  const lines: string[] = [];
  let head = w.head ?? OLD;
  let npmCiRuns = 0;
  const git = (args: string[]) => {
    const [cmd] = args;
    if (cmd !== "rev-parse" && cmd !== "status" && cmd !== "diff" && cmd !== "merge-base") calls.push(`git ${args.join(" ")}`);
    if (cmd === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, out: w.branch ?? "main" };
    if (cmd === "rev-parse" && args[1] === "HEAD") return { code: 0, out: head };
    if (cmd === "rev-parse") return { code: 0, out: w.remote ?? NEW };
    if (cmd === "status") return { code: 0, out: w.dirty ? " M backend/src/server.ts" : "" };
    if (cmd === "fetch") return { code: 0, out: "" };
    if (cmd === "merge-base") return { code: w.diverged ? 1 : 0, out: "" };
    if (cmd === "diff") return { code: w.lockfileChanged ? 1 : 0, out: "" };
    if (cmd === "merge") { if (w.mergeFails) return { code: 128, out: "" }; head = args[args.length - 1]; return { code: 0, out: "" }; }
    if (cmd === "reset") { head = args[args.length - 1]; return { code: 0, out: "" }; }
    return { code: 1, out: "" };
  };
  const deps = {
    log: (m: string) => lines.push(m),
    now: () => 0,
    paused: () => !!w.paused,
    git,
    npmCi: () => { calls.push("npm ci"); npmCiRuns++; return { code: w.npmCiFails && npmCiRuns === 1 ? 1 : 0, out: "" }; },
    busy: async () => w.busy ?? [],
    supervisorRunning: () => !!w.supervisor,
    snapshot: async () => { calls.push("snapshot"); return w.snapshotFails ? { ok: false, detail: "disk full" } : { ok: true, file: "autopilot-pre-update-x.sqlite" }; },
    stopServer: () => { calls.push("stop"); return { ok: true, stopped: w.serverRunning === false ? 0 : 1 }; },
    startServer: () => { calls.push("start"); },
    waitForBuild: async (sha: string) => { calls.push(`health ${sha.slice(0, 7)}`); return w.healthy !== false; },
  };
  return { deps, calls, lines, head: () => head };
}

const mutating = (calls: string[]) => calls.filter((c) => !c.startsWith("git fetch"));

console.log("local auto-update: decision logic");

await check("idle and behind: snapshot -> stop -> fast-forward -> start -> health, in that order", async () => {
  const h = harness({});
  const r = await runCycle(h.deps, {});
  assert.equal(r.outcome, "updated");
  assert.deepEqual(h.calls, ["git fetch --quiet origin main", "snapshot", "stop", `git merge --ff-only --quiet ${NEW}`, "start", `health ${NEW.slice(0, 7)}`]);
  assert.equal(h.head(), NEW);
});

await check("busy -> skip: no snapshot, no stop, no pull", async () => {
  for (const reason of ["1 job(s) running or due", "1 filing(s) awaiting_human_submit", "1 portal run(s) in progress, staged or paused for a human"]) {
    const h = harness({ busy: [reason] });
    const r = await runCycle(h.deps, {});
    assert.equal(r.outcome, "busy");
    assert.deepEqual(mutating(h.calls), [], `side effects while busy (${reason}): ${h.calls.join(", ")}`);
    assert.ok(h.lines.some((l) => l.includes(reason)), "the skip reason is logged");
  }
});

await check("dirty tracked tree -> refused before even fetching", async () => {
  const h = harness({ dirty: true });
  assert.equal((await runCycle(h.deps, {})).outcome, "refused");
  assert.deepEqual(h.calls, []);
});

await check("not on main -> refused before even fetching", async () => {
  const h = harness({ branch: "agent/80-local-auto-update" });
  assert.equal((await runCycle(h.deps, {})).outcome, "refused");
  assert.deepEqual(h.calls, []);
});

await check("diverged (HEAD not an ancestor of origin/main) -> no pull", async () => {
  const h = harness({ diverged: true });
  assert.equal((await runCycle(h.deps, {})).outcome, "refused");
  assert.deepEqual(mutating(h.calls), []);
});

await check("already on origin/main -> nothing", async () => {
  const h = harness({ remote: OLD });
  assert.equal((await runCycle(h.deps, {})).outcome, "up-to-date");
  assert.deepEqual(mutating(h.calls), []);
});

await check("paused -> nothing at all", async () => {
  const h = harness({ paused: true });
  assert.equal((await runCycle(h.deps, {})).outcome, "paused");
  assert.deepEqual(h.calls, []);
});

await check("lockfile unchanged -> no npm ci", async () => {
  const h = harness({ lockfileChanged: false });
  await runCycle(h.deps, {});
  assert.ok(!h.calls.includes("npm ci"));
});

await check("lockfile changed -> npm ci after the pull and before the start", async () => {
  const h = harness({ lockfileChanged: true });
  assert.equal((await runCycle(h.deps, {})).outcome, "updated");
  const i = (c: string) => h.calls.findIndex((x) => x.startsWith(c));
  assert.ok(i("stop") < i("git merge") && i("git merge") < i("npm ci") && i("npm ci") < i("start"), h.calls.join(", "));
});

await check("pull failed -> install left at the old commit and the old server restarted, no npm ci", async () => {
  const h = harness({ mergeFails: true, lockfileChanged: true });
  assert.equal((await runCycle(h.deps, {})).outcome, "pull-failed");
  assert.equal(h.head(), OLD);
  assert.ok(!h.calls.includes("npm ci"));
  assert.equal(h.calls.at(-1), "start");
  assert.ok(h.lines.some((l) => l.includes("PULL FAILED")));
});

await check("npm ci failed -> reset --keep to the old commit and reinstall BEFORE any start", async () => {
  const h = harness({ lockfileChanged: true, npmCiFails: true });
  assert.equal((await runCycle(h.deps, {})).outcome, "npm-ci-failed");
  assert.equal(h.head(), OLD);
  const firstStart = h.calls.indexOf("start");
  assert.ok(h.calls.indexOf(`git reset --keep ${OLD}`) < firstStart, h.calls.join(", "));
  assert.equal(h.calls.filter((c) => c === "npm ci").length, 2);
});

await check("snapshot failed -> no snapshot, no pull", async () => {
  const h = harness({ snapshotFails: true });
  assert.equal((await runCycle(h.deps, {})).outcome, "snapshot-failed");
  assert.deepEqual(mutating(h.calls), ["snapshot"]);
});

await check("busy only after the snapshot -> still no stop, no pull", async () => {
  const h = harness({});
  let n = 0;
  h.deps.busy = async () => (n++ === 0 ? [] : ["1 job(s) running or due"]);
  assert.equal((await runCycle(h.deps, {})).outcome, "busy");
  assert.deepEqual(mutating(h.calls), ["snapshot"]);
});

await check("supervised server -> skip (the supervisor owns restarts)", async () => {
  const h = harness({ supervisor: true });
  assert.equal((await runCycle(h.deps, {})).outcome, "supervised");
  assert.deepEqual(mutating(h.calls), []);
});

await check("no server running -> update the checkout but do not start one", async () => {
  const h = harness({ serverRunning: false });
  assert.equal((await runCycle(h.deps, {})).outcome, "updated");
  assert.ok(!h.calls.includes("start"));
});

await check("health never reports the new commit -> 'unhealthy', logged loudly, no rollback", async () => {
  const h = harness({ healthy: false });
  assert.equal((await runCycle(h.deps, {})).outcome, "unhealthy");
  assert.equal(h.head(), NEW);
  assert.ok(h.lines.some((l) => l.includes("HEALTH CHECK FAILED")));
});

await check("dry-run -> reports the plan, no side effect beyond the fetch", async () => {
  const h = harness({ lockfileChanged: true });
  const r = await runCycle(h.deps, { dryRun: true });
  assert.equal(r.outcome, "would-update");
  assert.deepEqual(mutating(h.calls), []);
  assert.ok(h.lines.some((l) => l.startsWith("dry-run:") && l.includes("run npm ci")));
});

console.log("local auto-update: idle predicate");

await check("busyReasons: idle only when every count is zero; unreadable state is busy", () => {
  assert.deepEqual(busyReasons({ jobs: 0, portalRuns: 0, filings: 0 }, { jobs: { inFlightThisProcess: 0 } }), []);
  assert.deepEqual(busyReasons({ jobs: 0, portalRuns: 0, filings: 0 }, null), []);
  assert.equal(busyReasons(null, null).length, 1);
  assert.equal(busyReasons({ jobs: 0, portalRuns: 0, filings: 0 }, { jobs: { inFlightThisProcess: 2 } }).length, 1);
});

await check("readBusyCounts against the real schema, opened read-only", async () => {
  // Build a DB with the real migrations, then read it the way the updater does.
  const dbPath = path.join(ISOLATED_CWD, "auto-update.sqlite");
  process.env.AUTOPILOT_DB_PATH = dbPath;
  const { openDatabase } = await import("../src/db");
  const db = await openDatabase();
  const now = "2026-10-03T12:00:00.000Z";
  db.run("INSERT INTO projects (id, status, parser_json, created_at, updated_at) VALUES ('p1','new','{}',?,?)", [now, now]);
  const Database = createRequire(path.join(REPO, "package.json"))("better-sqlite3");
  const counts = () => { const ro = new Database(dbPath, { readonly: true }); try { return readBusyCounts(ro, now); } finally { ro.close(); } };
  assert.deepEqual(counts(), { jobs: 0, portalRuns: 0, filings: 0 });

  db.run("INSERT INTO job_queue (id, job_type, status, created_at, scheduled_at) VALUES ('j1','x','pending',?, '2026-10-04T00:00:00.000Z')", [now]);
  assert.equal(counts().jobs, 0, "a job scheduled for later survives a restart; not busy");
  db.run("INSERT INTO job_queue (id, job_type, status, created_at) VALUES ('j2','x','running',?)", [now]);
  assert.equal(counts().jobs, 1);
  for (const [i, s] of BUSY_PORTAL_RUN_STATUSES.entries()) {
    db.run("INSERT INTO portal_runs (id, project_id, run_type, status, started_at) VALUES (?, 'p1', 'stage', ?, ?)", [`r${i}`, s, now]);
  }
  db.run("INSERT INTO portal_runs (id, project_id, run_type, status, started_at) VALUES ('rdone','p1','stage','submitted',?)", [now]);
  assert.equal(counts().portalRuns, BUSY_PORTAL_RUN_STATUSES.length);
  db.run("INSERT INTO submissions (id, project_id, submission_type, status, created_at) VALUES ('s1','p1','permit','awaiting_human_submit',?)", [now]);
  assert.equal(counts().filings, 1);
  assert.ok(BUSY_PORTAL_RUN_STATUSES.includes("awaiting_human_submit") && BUSY_PORTAL_RUN_STATUSES.includes("paused_for_human"));
  db.close?.();
  assert.ok(fs.existsSync(dbPath));
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall local auto-update checks passed");
