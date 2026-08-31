// Keep run artifacts from filling the disk.
//
// Learn bundles already prune themselves (AUTOLEARN_RUN_KEEP). Nothing else did: on a
// developer workstation `data/screenshots` had grown to 48MB and `data/replay-runs` to 12MB
// with no ceiling at all. On a server running 5-20 portal sessions at once that is a slow
// disk-full — which takes the database down with it, because SQLite cannot write either.
//
// Deliberately keep-newest-N rather than delete-older-than-N-days: what an operator needs
// after a failure is the LAST few runs, and a quiet week should not age out the only
// evidence of the failure they are investigating.
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

interface Target {
  /** Directory holding the artifacts. */
  dir: string;
  /** How many entries to keep, newest first. */
  keep: number;
  /** Directory entries (a folder per run) or loose files. */
  kind: "dirs" | "files";
  label: string;
}

function targets(): Target[] {
  const base = path.resolve(process.cwd(), "data");
  const n = (env: string, fallback: number) => {
    const v = Number(process.env[env]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return [
    { dir: path.join(base, "replay-runs"), keep: n("REPLAY_RUN_KEEP", 20), kind: "dirs", label: "replay run" },
    { dir: path.join(base, "portal-debug"), keep: n("PORTAL_DEBUG_KEEP", 20), kind: "dirs", label: "portal debug" },
    { dir: path.join(base, "screenshots"), keep: n("SCREENSHOT_KEEP", 400), kind: "files", label: "screenshot" },
  ];
}

/** Prune every artifact directory to its ceiling. Best-effort and never throws — a cleanup
 *  failure must not take down the process it runs in. Returns how many entries it removed. */
export function pruneArtifacts(): number {
  let removed = 0;
  for (const t of targets()) {
    try {
      if (!fs.existsSync(t.dir)) continue;
      const entries = fs.readdirSync(t.dir, { withFileTypes: true })
        .filter((d) => (t.kind === "dirs" ? d.isDirectory() : d.isFile()))
        .map((d) => {
          const full = path.join(t.dir, d.name);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch { /* vanished mid-sweep */ }
          return { full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime); // newest first
      for (const stale of entries.slice(t.keep)) {
        try {
          fs.rmSync(stale.full, { recursive: true, force: true });
          removed += 1;
        } catch { /* in use / permission — the next sweep retries */ }
      }
    } catch { /* unreadable directory — skip it */ }
  }
  if (removed > 0) logger.info("retention", `Pruned ${removed} old run artifact(s) to keep the disk from filling.`);
  return removed;
}

/** Sweep at startup, then on an interval. The interval shares the backup cadence by
 *  default — both are "housekeeping that must never compete with live portal work". */
export function startArtifactRetention(): void {
  const hours = Math.max(1, Number(process.env.ARTIFACT_PRUNE_INTERVAL_HOURS || 24));
  const tick = () => { try { pruneArtifacts(); } catch { /* never throws */ } };
  tick();
  const timer = setInterval(tick, hours * 3600_000);
  // Housekeeping must not hold the process open at shutdown.
  if (typeof timer.unref === "function") timer.unref();
}
