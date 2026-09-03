// CAN THESE CONCURRENCY NUMBERS ACTUALLY WORK TOGETHER?
//
// Three env vars have to agree, and nothing checked that they did:
//
//   JOB_CONCURRENCY             how many jobs are claimed at once
//   PORTAL_RUN_MAX_MS           hard ceiling on ONE portal run
//   PORTAL_PROFILE_WAIT_MS      how long a run waits for a busy profile before giving up
//
// Runs sharing a client+portal profile serialise (browser.ts profile queue) — correct and
// required, because PowerClerk permits one session per account. So when N jobs for the SAME
// client+portal are claimed together, the last one waits behind N-1 runs. If that wait can
// exceed PORTAL_PROFILE_WAIT_MS the run gives up — and portal-effecting jobs are pinned to
// maxRetries 0 (a timer must never replay a live browser run), so it fails PERMANENTLY and
// raises a human-review item for a filing that never started.
//
// At the shipped default JOB_CONCURRENCY=1 this is unreachable: one job at a time never
// waits. Raising concurrency without raising the wait quietly arms it — at 4 slots and a
// 25-minute ceiling the last in line can wait 75 minutes against a 15-minute timer. That is
// a configuration mistake no test catches and the portal never reports; it just looks like a
// filing that failed for no reason. So the server states the arithmetic out loud at boot.

export interface ConcurrencyConfig {
  jobConcurrency: number;
  portalRunMaxMs: number;
  profileWaitMs: number;
  maxConcurrentPortalRuns: number;
}

export function readConcurrencyConfig(env: NodeJS.ProcessEnv = process.env): ConcurrencyConfig {
  return {
    jobConcurrency: Math.max(1, Number(env.JOB_CONCURRENCY ?? 1)),
    portalRunMaxMs: Math.max(60_000, Number(env.PORTAL_RUN_MAX_MS ?? 25 * 60_000)),
    profileWaitMs: Math.max(1000, Number(env.PORTAL_PROFILE_WAIT_MS ?? 15 * 60 * 1000)),
    maxConcurrentPortalRuns: Math.max(1, Number(env.MAX_CONCURRENT_PORTAL_RUNS ?? 2)),
  };
}

export interface ConcurrencyWarning {
  code: "profile_wait_too_short" | "browser_slots_below_jobs";
  message: string;
}

/** Worst case: every claimed job wants the SAME profile, and each predecessor runs to its
 *  ceiling. This is the number PORTAL_PROFILE_WAIT_MS has to survive. */
export function worstCaseProfileWaitMs(cfg: ConcurrencyConfig): number {
  return Math.max(0, cfg.jobConcurrency - 1) * cfg.portalRunMaxMs;
}

export function checkConcurrencyConfig(cfg: ConcurrencyConfig): ConcurrencyWarning[] {
  const out: ConcurrencyWarning[] = [];
  const worst = worstCaseProfileWaitMs(cfg);
  const mins = (ms: number) => Math.round(ms / 60_000);
  if (worst > cfg.profileWaitMs) {
    out.push({
      code: "profile_wait_too_short",
      message:
        `PORTAL_PROFILE_WAIT_MS (${mins(cfg.profileWaitMs)} min) is shorter than the worst-case wait `
        + `for a busy portal profile (${mins(worst)} min = ${cfg.jobConcurrency - 1} runs ahead × `
        + `PORTAL_RUN_MAX_MS ${mins(cfg.portalRunMaxMs)} min). With JOB_CONCURRENCY=${cfg.jobConcurrency}, `
        + `several filings for the SAME client+portal can be claimed together and the last one gives up `
        + `waiting — portal jobs never retry, so it fails permanently and raises a human-review item for a `
        + `filing that never started. Raise PORTAL_PROFILE_WAIT_MS to at least ${mins(worst)} min, `
        + `lower PORTAL_RUN_MAX_MS, or lower JOB_CONCURRENCY.`,
    });
  }
  // The doc's other rule: browsers are the real ceiling, so fewer browser slots than job
  // slots means waiters occupy slots other clients need.
  if (cfg.maxConcurrentPortalRuns < cfg.jobConcurrency) {
    out.push({
      code: "browser_slots_below_jobs",
      message:
        `MAX_CONCURRENT_PORTAL_RUNS (${cfg.maxConcurrentPortalRuns}) is below JOB_CONCURRENCY `
        + `(${cfg.jobConcurrency}); a run waiting for a busy profile holds its browser slot, so the extra `
        + `job slots can stall every other client's portal work. Set them to the same number.`,
    });
  }
  return out;
}
