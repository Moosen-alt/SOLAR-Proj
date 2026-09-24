// WHAT CODE IS RUNNING — one module answers it, everywhere (banner, /health, diagnostics,
// the dashboard label).
//
// The old answer was a hard-coded "0.1.0-beta" that never moved. The version is now
// derived from the RUNNING code's own git commit: "YYYY.MM.DD" of its committer date, shown
// with the short sha ("2026.09.24 · 0c466bb"), plus "· pinned" and/or "· uncommitted
// changes" when true.
//
// codeRoot is the repo root of the code that is EXECUTING — resolved from this file's own
// location (backend/src/buildInfo.ts → two levels up), NEVER process.cwd(). Pinned
// production runs code from .probe/prod-pinned while its working directory is the live
// folder; a cwd-based answer would name the dev tree's commit, which is exactly the
// confusion this module exists to end. And codeRoot must BE a git top-level itself: a
// checkout with no .git of its own (a copied folder, an image) sitting inside some other
// repo would otherwise let `git -C` walk up and report the PARENT repo's commit.
//
// Source rule, in order:
//   1. env  — any of APP_VERSION / BUILD_SHA / BUILD_DATE set (non-empty). An explicit
//             operator/CI stamp beats inference; this is for deploys without .git (the
//             Docker image: .dockerignore excludes .git and the image has no git binary).
//             version = APP_VERSION, else YYYY.MM.DD from BUILD_DATE.
//   2. git  — codeRoot is a git top-level and HEAD resolves.
//   3. fallback — neither. Labelled "unknown build"; never a made-up number.
//
// Unknowns stay unknown: sha/version/commitDate/dirty are null when they could not be read,
// never "" or false — a failed `git status` must not read as "clean".
//
// Computed ONCE (buildInfo() caches). git runs via execFileSync (no shell) with a short
// timeout, --no-optional-locks (status would otherwise refresh the index and take
// index.lock under concurrent git work), and never throws. No network.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BuildSource = "git" | "env" | "fallback";

export interface BuildInfo {
  /** "YYYY.MM.DD" from the running code's commit date (or APP_VERSION when stamped). null = unknown. */
  version: string | null;
  /** Short commit sha of the running code. null = unknown. */
  sha: string | null;
  /** Committer date, ISO-8601 with the committer's offset (git) or BUILD_DATE (env). */
  commitDate: string | null;
  /** Tracked files changed in codeRoot. null = could not be determined (or not applicable). */
  dirty: boolean | null;
  /** codeRoot differs from process.cwd() — code runs from somewhere other than the data folder. */
  pinned: boolean;
  /** Repo root of the EXECUTING code (from this module's location, not cwd). */
  codeRoot: string;
  source: BuildSource;
  /** Human label: "2026.09.24 · 0c466bb · pinned · uncommitted changes" / "unknown build". */
  label: string;
}

/** The subset safe for an unauthenticated endpoint (no server filesystem path). */
export type PublicBuildInfo = Omit<BuildInfo, "codeRoot">;

export interface BuildInfoOptions {
  /** Override the code root (tests, and computing another checkout's identity). */
  codeRoot?: string;
  /** Override the working directory the pinned comparison uses. */
  cwd?: string;
  /** Override the environment read for the APP_VERSION/BUILD_SHA/BUILD_DATE stamp. */
  env?: Record<string, string | undefined>;
  /** Override the git executable (tests: a missing binary → fallback). */
  gitBin?: string;
  timeoutMs?: number;
}

const DEFAULT_CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Canonical form for comparing two directories: real path, and case-folded on Windows. */
function canonicalDir(p: string): string {
  let out = path.resolve(p);
  try { out = fs.realpathSync.native(out); } catch { /* keep the resolved path */ }
  out = path.normalize(out).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? out.toLowerCase() : out;
}

/** "2026-09-24T12:39:37-06:00" → "2026.09.24". Taken from the string, NOT via Date: a
 *  late-evening commit would flip to the next day in UTC. */
export function dateVersion(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? "").trim());
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function formatBuildLabel(info: Pick<BuildInfo, "version" | "sha" | "dirty" | "pinned" | "source">): string {
  if (info.source === "fallback") return info.pinned ? "unknown build · pinned" : "unknown build";
  const parts: string[] = [];
  parts.push(info.version ?? "unknown version");
  if (info.sha) parts.push(info.sha);
  if (info.pinned) parts.push("pinned");
  if (info.dirty === true) parts.push("uncommitted changes");
  else if (info.dirty === null && info.source === "git") parts.push("working-tree state unknown");
  return parts.join(" · ");
}

function gitEnv(): NodeJS.ProcessEnv {
  // An inherited GIT_DIR/GIT_WORK_TREE would override -C and name some other repo.
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES"]) delete env[k];
  return env;
}

function runGit(gitBin: string, codeRoot: string, args: string[], timeoutMs: number): string | null {
  try {
    const out = execFileSync(gitBin, ["-C", codeRoot, "--no-optional-locks", ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    });
    return String(out);
  } catch {
    return null;
  }
}

export function computeBuildInfo(opts: BuildInfoOptions = {}): BuildInfo {
  const codeRoot = path.resolve(opts.codeRoot ?? DEFAULT_CODE_ROOT);
  let pinned = false;
  try { pinned = canonicalDir(codeRoot) !== canonicalDir(opts.cwd ?? process.cwd()); } catch { pinned = false; }
  const env = opts.env ?? process.env;
  const gitBin = opts.gitBin ?? "git";
  const timeoutMs = opts.timeoutMs ?? 3000;

  const finish = (b: Omit<BuildInfo, "label" | "codeRoot" | "pinned">): BuildInfo => {
    const info = { ...b, codeRoot, pinned } as BuildInfo;
    info.label = formatBuildLabel(info);
    return info;
  };

  try {
    // 1. env stamp
    const stamp = (k: string) => { const v = String(env[k] ?? "").trim(); return v || null; };
    const envVersion = stamp("APP_VERSION");
    const envSha = stamp("BUILD_SHA");
    const envDate = stamp("BUILD_DATE");
    if (envVersion || envSha || envDate) {
      const sha = envSha ? (/^[0-9a-f]{8,40}$/i.test(envSha) ? envSha.slice(0, 7) : envSha.slice(0, 40)) : null;
      return finish({ version: envVersion ?? dateVersion(envDate), sha, commitDate: envDate, dirty: null, source: "env" });
    }

    // 2. git — only when codeRoot IS the top-level (never a parent repo's answer)
    const top = runGit(gitBin, codeRoot, ["rev-parse", "--show-toplevel"], timeoutMs)?.trim();
    if (top && canonicalDir(top) === canonicalDir(codeRoot)) {
      const head = runGit(gitBin, codeRoot, ["log", "-1", "--format=%h%n%cI", "HEAD"], timeoutMs);
      const [shaLine, dateLine] = (head ?? "").split(/\r?\n/);
      const sha = /^[0-9a-f]{4,40}$/i.test(shaLine?.trim() ?? "") ? shaLine.trim() : null;
      if (sha) {
        const commitDate = dateLine?.trim() || null;
        const status = runGit(gitBin, codeRoot, ["status", "--porcelain", "--untracked-files=no"], timeoutMs);
        const dirty = status === null ? null : status.trim().length > 0;
        return finish({ version: dateVersion(commitDate), sha, commitDate, dirty, source: "git" });
      }
    }
  } catch {
    /* fall through — never throw */
  }

  // 3. fallback
  return finish({ version: null, sha: null, commitDate: null, dirty: null, source: "fallback" });
}

let cached: BuildInfo | null = null;

/** The running code's identity, computed once per process. */
export function buildInfo(): BuildInfo {
  if (!cached) cached = computeBuildInfo();
  return cached;
}

export function publicBuildInfo(info: BuildInfo = buildInfo()): PublicBuildInfo {
  const { codeRoot: _codeRoot, ...rest } = info;
  return rest;
}

/** The "version" key the status JSON has always carried — the date version, or "unknown". */
export function versionString(info: BuildInfo = buildInfo()): string {
  return info.version ?? "unknown";
}
