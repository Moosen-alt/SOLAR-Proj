// ---------------------------------------------------------------------------
// REPLAY BENCHMARK — does a recorded recipe still file the right thing?
//
// The learn benchmark answers "can we learn an unknown portal". This answers the other half
// of the promise, which had no measurement at all: a recipe recorded weeks ago replays on
// every subsequent filing, and until now nothing checked whether it still worked — or, more
// pointedly, whether what it typed was still landing in the right fields.
//
// WHY THE TOP RUNG IS NOT "IT RAN". Replay reported `Replayed 98 recorded step(s)` without
// once reading the review screen (fixed in cfdcca5), so "executed" has never been evidence
// of a correct filing. A drifted selector executes perfectly into the wrong field. The rung
// that matters is the one where the portal's own review screen agrees with the project.
//
// The ladder is deliberately shaped like the learn ladder, because the same distinctions
// earned their place there the hard way:
//   • a harness death is NOT a measurement (runAbort.ts)
//   • a CAPTCHA or consent wall is the PORTAL's, not a defect
//   • a refused password is the OPERATOR's
//   • steps that fill nothing are not a success
//
// Pure and browser-free, so the scoring can be tested without touching a portal — which is
// the part that must not drift.
// ---------------------------------------------------------------------------

import { isHarnessAbort, looksBotBlocked } from "./runAbort";

/** How well a recorded recipe still replays, worst to best. Index is the score. */
export const REPLAY_RUNGS = [
  "unreachable",        // the portal never loaded
  "login_failed",       // the stored credential or a challenge stopped it
  "steps_failed",       // replay aborted part-way through the recorded sequence
  "replayed_with_gaps", // finished, but skipped steps / blank required fields / healed selectors
  "replayed_clean",     // every recorded step ran, nothing required left blank
  "verified_accurate",  // AND the portal's review screen matches the project
] as const;

export type ReplayRung = typeof REPLAY_RUNGS[number];

export interface ReplayOutcome {
  ok?: boolean;
  message?: string;
  /** Recorded steps that ran. */
  executed?: number;
  /** Steps on the recipe, for the completeness ratio. */
  recorded?: number;
  /** Step notes replay chose to skip. */
  skipped?: string[];
  /** Required fields still blank after the run — replay's own report. */
  requiredStillEmpty?: string[];
  /** Selectors replay had to re-anchor. Not a failure, but a recipe that is drifting. */
  healedSteps?: unknown[];
  driftWarnings?: string[];
  /** Review-screen check (cfdcca5). fieldsSeen 0 means the screen could not be read. */
  reviewFieldsSeen?: number;
  reviewMismatches?: Array<{ field: string; expected: string; found: string }>;
  pauseReason?: string | null;
}

export interface ReplayScore {
  rung: ReplayRung;
  index: number;
  reason: string;
  owner: "engine" | "credential" | "portal" | "recipe" | "harness" | "none";
  /** False when the run never became a measurement of the recipe — see runAbort. */
  measured?: boolean;
}

/**
 * Score one replay.
 *
 * EVIDENCE ORDER MATTERS, and it is the reverse of the intuitive one: the review-screen
 * check is consulted LAST but decides the TOP rung, because everything below it can be true
 * of a filing that is wrong. A run can execute every step, leave nothing blank, and still
 * have put the homeowner's name in the contractor field — which is a thing that has actually
 * happened on a live PowerClerk filing.
 */
export function scoreReplayOutcome(outcome: ReplayOutcome): ReplayScore {
  const msg = String(outcome.message || "");

  // A run our own harness killed says nothing about the recipe. Same rule as the learn side.
  if (isHarnessAbort(msg)) {
    return {
      rung: "unreachable", index: 0, owner: "harness", measured: false,
      reason: `not measured — the run was cut short by the harness, not the portal: ${msg.slice(0, 110)}`,
    };
  }
  if (/ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_CERT|net::|ETIMEDOUT|ENOTFOUND/i.test(msg)) {
    return { rung: "unreachable", index: 0, owner: "portal", reason: "the portal did not respond" };
  }
  if (looksBotBlocked(msg)) {
    return { rung: "unreachable", index: 0, owner: "portal", reason: "the portal refused an automated browser (WAF/bot block)" };
  }

  // A human gate ends the run and is nobody's defect.
  if (outcome.pauseReason === "mfa_captcha" || /mfa|captcha|challenge/i.test(msg)) {
    return { rung: "login_failed", index: 1, owner: "portal", reason: "stopped at an MFA/CAPTCHA challenge, which a human must clear" };
  }
  if (/still on the login form|likely rejected|username\/password/i.test(msg)) {
    return { rung: "login_failed", index: 1, owner: "credential", reason: "the stored credential was refused by the portal" };
  }
  if (/no stored credential|no credential was found/i.test(msg)) {
    return { rung: "login_failed", index: 1, owner: "credential", reason: "no credential is stored for this portal" };
  }


  const executed = Number(outcome.executed ?? 0);
  const recorded = Number(outcome.recorded ?? 0);

  // A FAILURE THAT SAYS NOTHING IS NOT EVIDENCE ABOUT THE RECIPE.
  //
  // The first live run of this benchmark returned ok:false, executed 0, message "" — and was
  // scored "the recipe no longer matches the portal", owner RECIPE. The recipe was fine; the
  // harness had handed the adapter a malformed object and it bailed before opening a
  // browser. A verdict about a recipe requires the replay to have REACHED the recipe, and
  // zero steps with nothing to say is the signature of something failing upstream of it.
  if (outcome.ok === false && executed === 0 && !msg.trim()) {
    return {
      rung: "unreachable", index: 0, owner: "harness", measured: false,
      reason: "not measured — replay failed before executing any step and reported no reason, which is a harness fault, not the recipe's",
    };
  }

  // Replay aborted part-way. This is the drift case the benchmark exists to catch: the
  // recipe no longer matches the portal.
  if (outcome.ok === false) {
    const where = recorded > 0 ? ` after ${executed} of ${recorded} recorded step(s)` : "";
    return {
      rung: "steps_failed", index: 2, owner: "recipe",
      reason: `replay stopped${where} — the recipe no longer matches the portal: ${msg.slice(0, 120)}`,
    };
  }

  // A RUN THAT EXECUTED NOTHING IS NOT A CLEAN RUN, WHATEVER IT REPORTS.
  //
  // The mirror of the harness guard above, and it caught a real one: a live replay that
  // filled eight pages of PacifiCorp reported `executed: 0` — because the harness was
  // reading the adapter's report from the wrong level — and this scorer, which only ever
  // asked "ok, and nothing flagged?", promoted it to `replayed_clean`. "Nothing happened"
  // and "everything happened correctly" produced the same number. They must not.
  if (outcome.ok === true && recorded > 0 && executed === 0) {
    return {
      rung: "unreachable", index: 0, owner: "harness", measured: false,
      reason: `not measured — replay reported success having executed 0 of ${recorded} recorded step(s), which is a harness or reporting fault, not a filing`,
    };
  }

  const blanks = outcome.requiredStillEmpty ?? [];
  const skipped = outcome.skipped ?? [];
  const healed = (outcome.healedSteps ?? []).length;
  // THE ADAPTER'S OWN WARNINGS WERE DECLARED AND THEN IGNORED. `driftWarnings` sat in this
  // interface unread, so replay could say "held-check could read only 1 of 2 array rows —
  // verify the arrays by eye before submit" and still score a clean run. A warning we asked
  // for, received, and dropped is worse than one we never collected: the adapter pays to
  // produce it on the assumption that someone acts on it.
  const drift = outcome.driftWarnings ?? [];
  const mismatches = outcome.reviewMismatches ?? [];
  const fieldsSeen = Number(outcome.reviewFieldsSeen ?? 0);

  // Anything less than a whole run is a gap, however tidy the summary reads.
  if (blanks.length || skipped.length || healed || drift.length) {
    const parts = [
      blanks.length ? `${blanks.length} required field(s) left blank (${blanks.slice(0, 3).join(", ")})` : "",
      skipped.length ? `${skipped.length} step(s) skipped` : "",
      healed ? `${healed} selector(s) had to be re-anchored — the recipe is drifting` : "",
      drift.length ? `replay warned: ${drift.slice(0, 2).join("; ").slice(0, 150)}` : "",
    ].filter(Boolean);
    return { rung: "replayed_with_gaps", index: 3, owner: "recipe", reason: parts.join("; ") };
  }

  // Clean, but unverified. An unreadable review screen cannot promote a run: "we could not
  // check" must never score the same as "we checked and it was right".
  if (!fieldsSeen) {
    return {
      rung: "replayed_clean", index: 4, owner: "engine",
      reason: `every recorded step ran and nothing was left blank, but the review screen could not be read — the filing is UNVERIFIED`,
    };
  }
  if (mismatches.length) {
    const named = mismatches.slice(0, 3).map((m) => `${m.field} shows "${String(m.found).slice(0, 30)}"`).join(", ");
    return {
      rung: "replayed_clean", index: 4, owner: "recipe",
      reason: `ran clean, but the review screen disagrees with the project on ${mismatches.length} field(s): ${named} — DO NOT SUBMIT without checking`,
    };
  }

  return {
    rung: "verified_accurate", index: 5, owner: "none",
    reason: `replayed ${executed} step(s) clean and the review screen matches the project across ${fieldsSeen} field(s)`,
  };
}

export interface ReplayRow {
  portal: string;
  profileKey: string;
  score: ReplayScore;
  /** Carried onto the scorecard so a row can be argued with without re-running it. */
  detail?: {
    executed?: number; recorded?: number; reviewFieldsSeen?: number; healed?: number; blanks?: number;
    /** WHICH fields, not just how many — a count sends someone back to the portal to look. */
    blankNames?: string[]; driftWarnings?: string[]; skippedNames?: string[];
  };
}

export interface ReplaySummary {
  total: number;
  measured: number;
  notMeasured: number;
  /** The headline: recipes that replayed clean AND verified against the project. */
  submittable: number;
  submittablePct: number;
  meanIndex: number;
  byRung: Record<string, number>;
  byOwner: Record<string, number>;
}

export function summarizeReplay(rows: ReplayRow[]): ReplaySummary {
  const byRung: Record<string, number> = {};
  const byOwner: Record<string, number> = {};
  for (const r of REPLAY_RUNGS) byRung[r] = 0;
  let sum = 0, measured = 0, submittable = 0;
  for (const row of rows) {
    byRung[row.score.rung] = (byRung[row.score.rung] ?? 0) + 1;
    byOwner[row.score.owner] = (byOwner[row.score.owner] ?? 0) + 1;
    if (row.score.measured === false) continue;
    measured++;
    sum += row.score.index;
    // ONLY the verified rung counts. A clean run whose review screen was never read is
    // exactly the state that let a wrong filing through once already.
    if (row.score.index >= 5) submittable++;
  }
  return {
    total: rows.length,
    measured,
    notMeasured: rows.length - measured,
    submittable,
    submittablePct: measured ? Math.round((submittable / measured) * 1000) / 10 : 0,
    meanIndex: measured ? Math.round((sum / measured) * 100) / 100 : 0,
    byRung,
    byOwner,
  };
}
