// WHAT CODE IS RUNNING — buildInfo() is the one answer (banner, /health, diagnostics, the
// dashboard label). The version used to be a hard-coded "0.1.0-beta" that never moved.
//
// Pinned here, each both ways:
//   - the sha is the MODULE'S OWN repo's HEAD — not the cwd's (pinned production runs code
//     from .probe/prod-pinned with cwd = the live folder; a cwd answer names the wrong commit);
//   - pinned = code root ≠ cwd, compared as real, case-folded paths;
//   - env stamp (APP_VERSION/BUILD_SHA/BUILD_DATE) → source 'env'; empty values are no stamp;
//   - no git binary / no .git / a folder NESTED in another repo → 'fallback', no throw, no
//     borrowed sha, and an honest "unknown build" label;
//   - version is YYYY.MM.DD from the commit's own date string (not UTC-shifted);
//   - dirty = tracked changes only (untracked files do not count), on a scratch repo;
//   - ONLY `git status` failing (corrupted index) → dirty null + "working-tree state
//     unknown", never dirty=false and a clean-looking label;
//   - the startup banner's service line carries buildInfo().label (in-process AND from the
//     real server), never "v0.1.0-beta" / "v<date>";
//   - the REAL server's unauthenticated GET /health: version and build.label are
//     buildInfo()'s, and the body carries no codeRoot or filesystem path; server.ts has no
//     APP_VERSION constant.
//
// Scratch git repos live under os.tmpdir(). No network. Run: npx tsx backend/test/buildInfo.test.ts
import "./_isolate";
import { ISOLATED_CWD, REPO } from "./_isolate";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The test process's own environment must not stamp the default buildInfo().
for (const k of ["APP_VERSION", "BUILD_SHA", "BUILD_DATE"]) delete process.env[k];

const { buildInfo, computeBuildInfo, dateVersion, formatBuildLabel, publicBuildInfo } = await import("../src/buildInfo");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=buildinfo-test", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
    cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const scratchRoots: string[] = [];
function scratchRepo(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buildinfo-repo-"));
  scratchRoots.push(dir);
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "tracked.txt"), content);
  git(dir, "add", "tracked.txt");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

const repoSha = git(REPO, "rev-parse", "--short", "HEAD");
const NO_ENV = {};

// ── 1. the running code's own repo ─────────────────────────────────────────────────────────
check("default buildInfo(): sha is this module's repo HEAD, source git, date version", () => {
  const info = buildInfo();
  assert.equal(info.source, "git");
  assert.equal(info.sha, git(REPO, "rev-parse", "--short", "HEAD"));
  assert.match(String(info.version), /^\d{4}\.\d{2}\.\d{2}$/);
  assert.equal(info.version, dateVersion(git(REPO, "log", "-1", "--format=%cI", "HEAD")));
  assert.equal(path.resolve(info.codeRoot).toLowerCase(), path.resolve(REPO).toLowerCase());
  assert.ok(info.label.startsWith(`${info.version} · ${info.sha}`), info.label);
});

check("buildInfo() is computed once (cached)", () => {
  assert.equal(buildInfo(), buildInfo());
});

check("publicBuildInfo omits codeRoot (it is served unauthenticated on /health)", () => {
  const pub = publicBuildInfo(buildInfo()) as Record<string, unknown>;
  assert.equal("codeRoot" in pub, false);
  assert.equal(pub.sha, buildInfo().sha);
});

// ── 2. cwd elsewhere → pinned, and still the CODE ROOT's commit ────────────────────────────
const other = scratchRepo("the live folder's own commit\n");
const otherSha = git(other, "rev-parse", "--short", "HEAD");
check("cwd in another repo: pinned true, sha is the code root's, NOT the cwd's", () => {
  assert.notEqual(otherSha, repoSha, "fixture sanity: two different commits");
  const info = computeBuildInfo({ cwd: other, env: NO_ENV });
  assert.equal(info.pinned, true);
  assert.equal(info.sha, repoSha);
  assert.notEqual(info.sha, otherSha); // MUST-EXCLUDE: the cwd's commit
  assert.ok(info.label.includes("pinned"), info.label);
});
check("default buildInfo() under _isolate's temp cwd reads pinned", () => {
  assert.equal(buildInfo().pinned, true);
});
check("cwd = the code root: pinned false, even spelled with other slashes/case", () => {
  assert.equal(computeBuildInfo({ cwd: REPO, env: NO_ENV }).pinned, false);
  const respelled = process.platform === "win32" ? REPO.replace(/\\/g, "/").toUpperCase() : REPO + "/";
  assert.equal(computeBuildInfo({ cwd: respelled, env: NO_ENV }).pinned, false);
  assert.ok(!computeBuildInfo({ cwd: REPO, env: NO_ENV }).label.includes("pinned"));
});
check("codeRoot option computes ANOTHER checkout's identity (how prod-pinned is reported)", () => {
  const info = computeBuildInfo({ codeRoot: other, cwd: REPO, env: NO_ENV });
  assert.equal(info.sha, otherSha);
  assert.equal(info.pinned, true);
});

// ── 3. env stamp ───────────────────────────────────────────────────────────────────────────
check("BUILD_SHA + BUILD_DATE → source env, short sha, date version", () => {
  const info = computeBuildInfo({ cwd: REPO, env: { BUILD_SHA: "abcdef0123456789abcdef0123456789abcdef01", BUILD_DATE: "2026-01-02T23:04:05-06:00" } });
  assert.equal(info.source, "env");
  assert.equal(info.sha, "abcdef0");
  assert.equal(info.version, "2026.01.02");
  assert.equal(info.commitDate, "2026-01-02T23:04:05-06:00");
  assert.equal(info.dirty, null);
  assert.equal(info.label, "2026.01.02 · abcdef0");
});
check("APP_VERSION alone → source env, used verbatim", () => {
  const info = computeBuildInfo({ cwd: REPO, env: { APP_VERSION: "2026.03.04-rc1" } });
  assert.equal(info.source, "env");
  assert.equal(info.version, "2026.03.04-rc1");
  assert.equal(info.sha, null);
});
check("empty stamp values (Docker ARG defaults) are NO stamp → git", () => {
  const info = computeBuildInfo({ cwd: REPO, env: { APP_VERSION: "", BUILD_SHA: "  ", BUILD_DATE: "" } });
  assert.equal(info.source, "git");
  assert.equal(info.sha, repoSha);
});

// ── 4. fallback ────────────────────────────────────────────────────────────────────────────
check("git binary missing → fallback, no throw, 'unknown build', nothing invented", () => {
  const info = computeBuildInfo({ cwd: REPO, env: NO_ENV, gitBin: "definitely-not-git-buildinfo" });
  assert.equal(info.source, "fallback");
  assert.equal(info.sha, null);
  assert.equal(info.version, null);
  assert.equal(info.dirty, null);
  assert.equal(info.label, "unknown build");
});
check("code root with no .git → fallback", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "buildinfo-nogit-"));
  scratchRoots.push(empty);
  const info = computeBuildInfo({ codeRoot: empty, cwd: empty, env: NO_ENV });
  assert.equal(info.source, "fallback");
  assert.equal(info.sha, null);
  assert.equal(info.label, "unknown build");
});
check("code root NESTED inside another repo (no .git of its own) → fallback, not the parent's sha", () => {
  const parent = scratchRepo("parent repo\n");
  const parentSha = git(parent, "rev-parse", "--short", "HEAD");
  const nested = path.join(parent, "copied-checkout");
  fs.mkdirSync(path.join(nested, "backend", "src"), { recursive: true });
  const info = computeBuildInfo({ codeRoot: nested, cwd: nested, env: NO_ENV });
  assert.equal(info.source, "fallback");
  assert.notEqual(info.sha, parentSha); // MUST-EXCLUDE: a borrowed identity
  assert.equal(info.sha, null);
});

// ── 5. version format ──────────────────────────────────────────────────────────────────────
check("dateVersion takes the committer's own date (a late-evening commit does not flip to UTC)", () => {
  assert.equal(dateVersion("2026-09-24T23:30:00-06:00"), "2026.09.24");
  assert.equal(dateVersion("2026-09-24T12:39:37-06:00"), "2026.09.24");
  assert.match(String(dateVersion("2026-09-24T12:39:37-06:00")), /^\d{4}\.\d{2}\.\d{2}$/);
  assert.equal(dateVersion("not a date"), null);
  assert.equal(dateVersion(null), null);
});

// ── 6. dirty ───────────────────────────────────────────────────────────────────────────────
check("dirty: clean → false; untracked-only → false; tracked edit → true", () => {
  const repo = scratchRepo("v1\n");
  const clean = computeBuildInfo({ codeRoot: repo, cwd: repo, env: NO_ENV });
  assert.equal(clean.source, "git");
  assert.equal(clean.dirty, false);
  assert.ok(!clean.label.includes("uncommitted"), clean.label);

  fs.writeFileSync(path.join(repo, "untracked.txt"), "scratch\n");
  assert.equal(computeBuildInfo({ codeRoot: repo, cwd: repo, env: NO_ENV }).dirty, false); // MUST-EXCLUDE

  fs.writeFileSync(path.join(repo, "tracked.txt"), "v2\n");
  const dirty = computeBuildInfo({ codeRoot: repo, cwd: repo, env: NO_ENV });
  assert.equal(dirty.dirty, true);
  assert.ok(dirty.label.endsWith("· uncommitted changes"), dirty.label);
});
check("label: pinned and dirty both shown; an unknown dirty state is not presented as clean", () => {
  assert.equal(formatBuildLabel({ version: "2026.09.24", sha: "0c466bb", dirty: true, pinned: true, source: "git" }), "2026.09.24 · 0c466bb · pinned · uncommitted changes");
  assert.equal(formatBuildLabel({ version: "2026.09.24", sha: "0c466bb", dirty: false, pinned: false, source: "git" }), "2026.09.24 · 0c466bb");
  assert.ok(formatBuildLabel({ version: "2026.09.24", sha: "0c466bb", dirty: null, pinned: false, source: "git" }).includes("unknown"));
});
// An unknown must not read as reassurance: ONLY `git status` fails (the index is corrupted
// after the commit; rev-parse and log never load it), so the sha is still known but the
// working-tree state is not. That must surface as null / "working-tree state unknown" —
// never as dirty=false and a label identical to a clean build's.
check("git status fails on its own → source git, dirty null, label says 'working-tree state unknown'", () => {
  const repo = scratchRepo("v1\n");
  const clean = computeBuildInfo({ codeRoot: repo, cwd: repo, env: NO_ENV });
  assert.equal(clean.dirty, false, "fixture sanity: clean before the corruption");
  // Corrupt, do not delete: a MISSING index reads as empty → every tracked file shows as
  // deleted → dirty TRUE, which is not the case being pinned.
  fs.writeFileSync(path.join(repo, ".git", "index"), "not an index\n");
  // Fixture sanity: the corruption isolates `status` — log still answers, status does not.
  assert.equal(git(repo, "log", "-1", "--format=%h"), clean.sha);
  assert.throws(() => git(repo, "--no-optional-locks", "status", "--porcelain", "--untracked-files=no"));

  const info = computeBuildInfo({ codeRoot: repo, cwd: repo, env: NO_ENV });
  assert.equal(info.source, "git");
  assert.equal(info.sha, clean.sha);
  assert.equal(info.dirty, null);
  assert.notEqual(info.dirty, false); // MUST-EXCLUDE: an unknown read as "clean"
  assert.ok(info.label.includes("working-tree state unknown"), info.label);
  assert.notEqual(info.label, clean.label); // MUST-EXCLUDE: indistinguishable from a clean build
  assert.ok(!info.label.includes("uncommitted changes"), info.label); // nor invented as dirty
});

// ── 7. the startup banner names the build (in-process, deterministic) ──────────────────────
const { collectDiagnostics, startupBanner } = await import("../src/logger");
type BannerDb = Parameters<typeof collectDiagnostics>[0];
/** The banner's service line — the one line that names what is running. */
const serviceLine = (text: string): string | undefined =>
  text.split(/\r?\n/).find((l) => l.includes("Solar Submission Autopilot"));
/** MUST-EXCLUDE on a banner/label line: the old frozen number, or a "v"-prefixed version. */
function assertNoLegacyVersion(line: string, version: string | null): void {
  assert.ok(!line.includes("0.1.0"), `legacy 0.1.0 version in: ${line}`);
  assert.ok(!/\bv\d/.test(line), `"v<number>" version prefix in: ${line}`);
  if (version) assert.ok(!line.includes(`v${version}`), `"v${version}" in: ${line}`);
}
check("startupBanner: the service line carries buildInfo().label, not 'v0.1.0-beta' / 'v<date>'", () => {
  // Every count query throws → safeCount's null; the banner needs no real database.
  const stubDb = { get: () => { throw new Error("stub db"); } } as unknown as BannerDb;
  const diag = collectDiagnostics(stubDb, { build: buildInfo(), port: 0, dbPath: path.join(os.tmpdir(), "none.sqlite") });
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { startupBanner(diag, { base: "http://localhost:0" }); } finally { console.log = realLog; }
  const line = serviceLine(lines.join("\n"));
  assert.ok(line, `no service line in the banner:\n${lines.join("\n")}`);
  assert.ok(line.includes(buildInfo().label), `banner "${line}" lacks label "${buildInfo().label}"`);
  assertNoLegacyVersion(line, buildInfo().version);
  assert.equal(diag.version, buildInfo().version ?? "unknown");
});

// ── 8. the REAL server: GET /health body + the banner it printed ───────────────────────────
// A builder tested in isolation cannot fail when server.ts stops calling it; only the real
// route can. /health is UNAUTHENTICATED, so its build block must never carry codeRoot (or
// any server filesystem path). The child inherits this process's cwd (ISOLATED_CWD) and code
// root (REPO) and has APP_VERSION/BUILD_* deleted above, so it takes the same git path and
// reports the same pinned state as buildInfo() here.
check("server.ts defines no APP_VERSION constant (the frozen '0.1.0-beta' source)", () => {
  const src = fs.readFileSync(path.join(REPO, "backend", "src", "server.ts"), "utf8");
  assert.ok(!/\bAPP_VERSION\b/.test(src), "server.ts mentions APP_VERSION again");
  assert.ok(!src.includes("0.1.0"), "server.ts carries a 0.1.0 literal again");
});

const serverTmp = fs.mkdtempSync(path.join(os.tmpdir(), "buildinfo-server-"));
scratchRoots.push(serverTmp);
const PORT = 4960 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const serverEnv: Record<string, string | undefined> = {
  ...process.env,
  AUTOPILOT_DB_PATH: path.join(serverTmp, "test.sqlite"),
  BACKUP_DIR: path.join(serverTmp, "backups"),
  DATA_DIR: path.join(serverTmp, "data"),
  PORT: String(PORT),
  SERVER_HOST: "127.0.0.1",
  SEED_TEST_INSTALLER: "false",
  AUTOPILOT_AUTO_START: "0",
  MONITOR_INTERVAL_MINUTES: "0",
  LOG_LEVEL: "warn",
  ANTHROPIC_API_KEY: "", // stub LLM — no network
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  NO_PROXY: "*",
  no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "APP_VERSION", "BUILD_SHA", "BUILD_DATE"]) delete serverEnv[k];

// The expected identity, bracketing the child's own computation (a sibling commit or edit
// in this shared tree between the two is the one legitimate way they can differ).
const expectedBefore = computeBuildInfo({ env: NO_ENV });
const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: serverEnv, stdio: ["ignore", "pipe", "pipe"], detached: false, windowsHide: true,
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });

let health: { status: number; text: string } | null = null;
try {
  for (let i = 0; i < 120 && !health; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      health = { status: res.status, text: await res.text() };
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  // The banner prints synchronously in the listen callback; give the pipe a moment.
  for (let i = 0; i < 20 && !serviceLine(serverLog); i++) await new Promise((r) => setTimeout(r, 100));
} finally {
  server.kill();
}
const expectedAfter = computeBuildInfo({ env: NO_ENV });
const expectedLabels = new Set([buildInfo().label, expectedBefore.label, expectedAfter.label]);

check("GET /health: build.label and version are buildInfo()'s; no codeRoot or filesystem path", () => {
  assert.ok(health, `server never answered /health:\n${serverLog.slice(-2000)}`);
  assert.equal(health.status, 200, health.text.slice(0, 500));
  const body = JSON.parse(health.text) as { version?: unknown; build?: Record<string, unknown> };
  assert.ok(body.build && typeof body.build === "object", `no build block: ${health.text.slice(0, 500)}`);
  const label = String(body.build.label);
  assert.ok(expectedLabels.has(label), `/health label "${label}" is not buildInfo().label (${[...expectedLabels].join(" | ")})`);
  const expected = [buildInfo(), expectedBefore, expectedAfter].find((b) => b.label === label)!;
  assert.equal(body.version, expected.version ?? "unknown");
  assert.equal(body.build.version, expected.version);
  assert.equal(body.build.sha, expected.sha);
  assert.equal(body.build.source, "git");
  assert.equal(body.build.pinned, true); // code in REPO, cwd = ISOLATED_CWD
  assertNoLegacyVersion(String(body.version), null);
  // MUST-EXCLUDE: the unauthenticated body names no server path.
  assert.equal("codeRoot" in body.build, false, "codeRoot leaked into /health");
  assert.ok(!health.text.includes("codeRoot"), "codeRoot leaked into /health");
  const lower = health.text.toLowerCase();
  for (const p of [REPO, ISOLATED_CWD, serverTmp]) {
    assert.ok(!lower.includes(p.toLowerCase()) && !lower.includes(JSON.stringify(p).slice(1, -1).toLowerCase()), `path ${p} in /health`);
  }
  // A drive path ("C:\\..." in JSON, or "C:/..."); the leading guard keeps "http://" out.
  assert.ok(!/(^|[^A-Za-z])[A-Za-z]:(\\\\|\/)/.test(health.text), `a drive path in /health: ${health.text.slice(0, 500)}`);
});
check("the real server's startup banner names the same build", () => {
  const line = serviceLine(serverLog);
  assert.ok(line, `no banner service line:\n${serverLog.slice(-2000)}`);
  assert.ok([...expectedLabels].some((l) => line.includes(l)), `banner "${line}" lacks buildInfo().label (${[...expectedLabels].join(" | ")})`);
  assertNoLegacyVersion(line, buildInfo().version);
});

for (const d of scratchRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

if (failures) {
  console.error(`\n${failures} build-info check(s) FAILED`);
  process.exit(1);
}
console.log("\nall build-info checks passed");
process.exit(0);
