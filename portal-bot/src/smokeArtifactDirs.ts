// A SMOKE RUN BY HAND MUST NOT WRITE INTO (OR PRUNE) THE PRODUCTION FORENSICS STORE.
//
// scripts/run-dom-smokes.ts gives every child its own temp folder for the five artifact env vars
// and fails the run if data/ changed. A smoke run DIRECTLY (`npx tsx <file>` — CLAUDE.md tells
// developers to run powerClerkSpecs that way) got none of that: the learner's debug bundle went
// to data/learn-runs and learnDebug pruned that folder to its newest 20 runs, evicting real
// bundles (foundation verdict, caveat b: one hand run of fallbackAdvance left 20 run.json files).
//
// Import this module FIRST in any smoke that drives the learner or replay:
//   import "../smokeArtifactDirs";
// On import it points every artifact env var that is unset — or that resolves inside this
// checkout's data/ folder — at a fresh temp folder. A var the runner (or a developer) already
// pointed somewhere else is left alone. smokeArtifactDirs.test.ts pins the rule and checks that
// every learn-driving DOM smoke imports this before the adapter.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Every env var portal-bot reads to decide where a run's artifacts land (same list as the runner). */
export const SMOKE_ARTIFACT_ENV = [
  "AUTOLEARN_RUN_DIR",
  "REPLAY_RUN_DIR",
  "REPLAY_CAPTURE_DIR",
  "PORTAL_SCREENSHOT_DIR",
  "POWERCLERK_DEBUG_DIR",
] as const;

export interface SmokeArtifactDefaults {
  /** The temp folder the defaults point under, or null when nothing needed a default. */
  root: string | null;
  /** The vars this call set. */
  set: string[];
}

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Point each artifact var that is unset/empty, or that resolves inside `<cwd>/data`, at a folder
 * under a fresh temp directory. Never throws; a var set elsewhere is untouched.
 */
export function defaultSmokeArtifactDirs(
  env: Record<string, string | undefined> = process.env,
  opts: { cwd?: string; tmpRoot?: string } = {},
): SmokeArtifactDefaults {
  const dataDir = path.join(opts.cwd ?? process.cwd(), "data");
  const needs = SMOKE_ARTIFACT_ENV.filter((k) => {
    const v = String(env[k] ?? "").trim();
    return !v || inside(v, dataDir);
  });
  if (!needs.length) return { root: null, set: [] };
  let root: string;
  try { root = opts.tmpRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "smoke-artifacts-")); }
  catch { root = path.join(os.tmpdir(), `smoke-artifacts-${process.pid}-${Date.now()}`); }
  for (const k of needs) env[k] = path.join(root, k.toLowerCase());
  return { root, set: [...needs] };
}

const applied = defaultSmokeArtifactDirs();
if (applied.root && process.env.SMOKE_ARTIFACT_DIRS_QUIET !== "1") {
  console.log(`  (artifacts of this hand-run smoke go to ${applied.root}, not data/)`);
}
