// ---------------------------------------------------------------------------
// THE REVIEW WINDOW IS NOT AN ORPHAN.
//
// The orphan reaper's stated rule is "no run of ours is in flight at startup, so any browser
// still holding one of our profiles is by definition an orphan" — and that is true of every
// browser EXCEPT the one case the product creates on purpose: a guided-manual stage leaves
// the review window OPEN so the operator can read the application and click submit
// themselves (hard rule 1). That window is not an orphan, it is their workspace, and it can
// sit there for hours while they get to it.
//
// Restart the server in that window — a deploy, a config change, a crash, or just the
// operator restarting — and the new process reaps it: the rule kills browsers OLDER than
// the current process, and a review window left by the previous instance is exactly that.
// The operator loses a staged filing they were about to submit, and someone has to go and
// check what the portal actually received, because staging is not idempotent portal-side.
// Two of the seven portal failures in the last eight days are this shape.
//
// So a profile carrying a live review session says so on disk. The marker is a file in the
// profile directory rather than in-memory state, because the whole point is that it must
// survive the process that created it.
//
// AGE-BOUNDED ON PURPOSE. A marker left by a crashed run must not protect a genuinely dead
// browser forever — that would reintroduce the stuck-profile-lock bug the reaper exists to
// fix. After the window expires the profile is reapable again, and the operator gets the
// same behaviour as today.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

/** File written into the profile directory while a review window is deliberately open. */
const MARKER = ".keelix-review-open";

/** How long a marker protects a profile. Long enough for an operator to come back from
 *  lunch and submit; short enough that a crashed run's marker does not wedge the profile
 *  until someone deletes it by hand. */
export const REVIEW_MARKER_MAX_AGE_MS = 8 * 60 * 60 * 1000;

function markerPath(userDataDir: string): string {
  return path.join(userDataDir, MARKER);
}

/** Record that this profile has a review window open for a human to submit in. */
export function markReviewOpen(userDataDir: string | undefined): void {
  if (!userDataDir) return;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(markerPath(userDataDir), new Date().toISOString(), "utf8");
  } catch { /* marking is best-effort — never fail a run over it */ }
}

/** The window is closed (submitted, closed by hand, or replaced by a new run). */
export function clearReviewOpen(userDataDir: string | undefined): void {
  if (!userDataDir) return;
  try { fs.rmSync(markerPath(userDataDir), { force: true }); } catch { /* best-effort */ }
}

/**
 * Is this profile's browser a review window a human is expected to use?
 * False when there is no marker, or when the marker is older than the protection window.
 */
export function hasLiveReviewSession(userDataDir: string, now = Date.now(), maxAgeMs = REVIEW_MARKER_MAX_AGE_MS): boolean {
  try {
    const stat = fs.statSync(markerPath(userDataDir));
    return now - stat.mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

/**
 * Pull the profile directory out of a browser's command line.
 *
 * The reaper works from process command lines, and the only way to know WHICH profile a
 * given Chromium belongs to is the --user-data-dir it was launched with. Handles the
 * quoted and unquoted spellings Chromium is launched with on Windows and POSIX.
 */
export function userDataDirFromCommandLine(commandLine: string): string {
  const text = String(commandLine || "");
  const quoted = text.match(/--user-data-dir="([^"]+)"/);
  if (quoted?.[1]) return quoted[1].trim();
  const bare = text.match(/--user-data-dir=(\S+)/);
  return bare?.[1]?.trim() ?? "";
}

/**
 * Should the reaper SPARE this browser? True only for a profile that is advertising a live
 * review session. Everything else stays reapable exactly as before — this narrows the
 * reaper, it never widens it.
 */
export function shouldSpareForReview(commandLine: string, now = Date.now()): boolean {
  const dir = userDataDirFromCommandLine(commandLine);
  if (!dir) return false;
  return hasLiveReviewSession(dir, now);
}
