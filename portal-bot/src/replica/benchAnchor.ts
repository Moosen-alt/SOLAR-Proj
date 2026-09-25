// THE COMMIT A SCOREBOARD RUN MEASURED — captured at the START, re-read at the END.
//
// A before/after comparison is only as good as its anchor. The first version read .git/HEAD
// by hand when the report was WRITTEN, so (a) a run started at one commit whose HEAD moved
// during its ~30 minutes reported the commit it ended on, silently, and (b) from a git
// worktree (.git is a FILE there) the read threw, was swallowed, and wrote commit "" as if it
// were an anchor. `git rev-parse HEAD` handles worktrees, detached HEADs and packed refs; it
// is asked twice, and the report says whether the answers differ and whether the measured
// code had uncommitted edits.
import { execFileSync } from "node:child_process";

/** Paths whose uncommitted edits change what the scoreboard measures. */
export const MEASURED_PATHS = ["portal-bot", "scripts", "shared", "backend/src"];

export type GitRunner = (args: string[], cwd: string) => string;

export const realGit: GitRunner = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

const HEX40 = /^[0-9a-f]{40}$/;

/** HEAD as a 40-hex hash, or "UNKNOWN" — never an empty string. */
export function readHead(repo: string, git: GitRunner = realGit): string {
  try {
    const out = git(["rev-parse", "HEAD"], repo).trim();
    return HEX40.test(out) ? out : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

/** true = uncommitted edits under the measured paths; null = could not tell (an unknown, not a clean tree). */
export function readDirty(repo: string, git: GitRunner = realGit): boolean | null {
  try {
    return git(["status", "--porcelain", "--", ...MEASURED_PATHS], repo).trim().length > 0;
  } catch {
    return null;
  }
}

export interface BenchAnchor {
  commitAtStart: string;
  commitAtEnd: string;
  /** null when either end is UNKNOWN — a move cannot be ruled out. */
  headMoved: boolean | null;
  dirtyAtStart: boolean | null;
  dirtyAtEnd: boolean | null;
  /** One line for the console and the report. */
  summary: string;
  /** false when the anchor cannot be trusted as a before/after reference. */
  trustworthy: boolean;
}

export function startAnchor(repo: string, git: GitRunner = realGit): { commitAtStart: string; dirtyAtStart: boolean | null } {
  return { commitAtStart: readHead(repo, git), dirtyAtStart: readDirty(repo, git) };
}

export function finishAnchor(repo: string, start: { commitAtStart: string; dirtyAtStart: boolean | null }, git: GitRunner = realGit): BenchAnchor {
  const commitAtEnd = readHead(repo, git);
  const dirtyAtEnd = readDirty(repo, git);
  const unknown = start.commitAtStart === "UNKNOWN" || commitAtEnd === "UNKNOWN";
  const headMoved = unknown ? null : start.commitAtStart !== commitAtEnd;
  const short = (h: string) => (h === "UNKNOWN" ? h : h.slice(0, 10));
  const dirtyWord = (d: boolean | null) => (d === null ? "dirty=UNKNOWN" : d ? "DIRTY (uncommitted edits under the measured paths)" : "clean");
  const summary = unknown
    ? `commit anchor UNKNOWN (start ${short(start.commitAtStart)}, end ${short(commitAtEnd)}) — this run cannot anchor a before/after comparison`
    : headMoved
      ? `commit anchor ${short(start.commitAtStart)} at start, HEAD MOVED to ${short(commitAtEnd)} during the run — the code measured is the START commit only if nothing reloaded; ${dirtyWord(start.dirtyAtStart)} at start`
      : `commit anchor ${short(start.commitAtStart)} (unchanged start to end); ${dirtyWord(start.dirtyAtStart)} at start, ${dirtyWord(dirtyAtEnd)} at end`;
  return {
    commitAtStart: start.commitAtStart, commitAtEnd, headMoved, dirtyAtStart: start.dirtyAtStart, dirtyAtEnd, summary,
    trustworthy: !unknown && headMoved === false && start.dirtyAtStart === false,
  };
}
