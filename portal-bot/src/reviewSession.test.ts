// THE REVIEW WINDOW IS NOT AN ORPHAN — BUT A CRASHED MARKER MUST NOT WEDGE A PROFILE.
//
// The reaper exists because an abandoned browser holds a profile lock forever and every
// later run for that client fails to launch. Sparing the operator's open review window is a
// NARROWING of that rule, and the danger of narrowing it is reintroducing the bug it fixed.
// So both directions are pinned here: a live review session is spared, and a stale marker
// stops protecting anything once its window passes.
// Run: tsx portal-bot/src/reviewSession.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REVIEW_MARKER_MAX_AGE_MS,
  clearReviewOpen,
  hasLiveReviewSession,
  markReviewOpen,
  shouldSpareForReview,
  userDataDirFromCommandLine,
} from "./reviewSession";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-session-"));
const profile = path.join(root, "client-a", "utility");

console.log("\n1. THE MARKER'S LIFECYCLE");
check("a profile with no marker is not a review session", () => {
  assert.equal(hasLiveReviewSession(profile), false);
});

check("MUST PASS: marking makes it a live review session", () => {
  markReviewOpen(profile);
  assert.equal(hasLiveReviewSession(profile), true);
});

check("clearing ends it — the profile is reapable again", () => {
  clearReviewOpen(profile);
  assert.equal(hasLiveReviewSession(profile), false);
});

check("marking is safe when the directory does not exist yet, and on an undefined dir", () => {
  const fresh = path.join(root, "never-created", "utility");
  markReviewOpen(fresh);
  assert.equal(hasLiveReviewSession(fresh), true);
  markReviewOpen(undefined);
  clearReviewOpen(undefined);
});

console.log("\n2. THE AGE BOUND — a crashed run must not protect a dead browser forever");
check("MUST EXCLUDE: a marker older than the window no longer spares anything", () => {
  markReviewOpen(profile);
  const wayLater = Date.now() + REVIEW_MARKER_MAX_AGE_MS + 60_000;
  assert.equal(hasLiveReviewSession(profile, wayLater), false,
    "a stale marker kept protecting a profile — the stuck-lock bug, reintroduced");
});

check("...but inside the window it still holds", () => {
  const soon = Date.now() + Math.floor(REVIEW_MARKER_MAX_AGE_MS / 2);
  assert.equal(hasLiveReviewSession(profile, soon), true);
});

console.log("\n3. READING THE PROFILE OUT OF A BROWSER COMMAND LINE");
check("quoted and unquoted --user-data-dir are both understood", () => {
  assert.equal(userDataDirFromCommandLine(`chrome.exe --user-data-dir="${profile}" --flag`), profile);
  assert.equal(userDataDirFromCommandLine(`chrome --user-data-dir=${profile} --flag`), profile);
  assert.equal(userDataDirFromCommandLine("chrome --no-sandbox"), "");
});

check("MUST PASS: a browser on a marked profile is spared", () => {
  markReviewOpen(profile);
  assert.equal(shouldSpareForReview(`chrome.exe --user-data-dir="${profile}"`), true);
});

check("MUST EXCLUDE: a browser on an UNMARKED profile is still reaped", () => {
  const other = path.join(root, "client-b", "AHJ");
  fs.mkdirSync(other, { recursive: true });
  assert.equal(shouldSpareForReview(`chrome.exe --user-data-dir="${other}"`), false,
    "an ordinary orphan was spared — the reaper would stop clearing stuck profile locks");
});

check("MUST EXCLUDE: a command line with no profile at all is never spared", () => {
  assert.equal(shouldSpareForReview("chrome.exe --headless"), false);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0
  ? "\nAll review-session checks passed."
  : `\n${failures} review-session check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
