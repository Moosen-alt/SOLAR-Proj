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
//   - dirty = tracked changes only (untracked files do not count), on a scratch repo.
//
// Scratch git repos live under os.tmpdir(). No network. Run: npx tsx backend/test/buildInfo.test.ts
import "./_isolate";
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

for (const d of scratchRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

if (failures) {
  console.error(`\n${failures} build-info check(s) FAILED`);
  process.exit(1);
}
console.log("\nall build-info checks passed");
process.exit(0);
