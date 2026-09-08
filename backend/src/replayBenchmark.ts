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

/**
 * How many project values must be FOUND on the review screen before a filing counts as
 * verified. Three is the smallest number that cannot be met by coincidence: the checks are
 * homeowner name, site address, system size, account and meter, and a page echoing three of
 * those is showing this project rather than a template.
 */
export const MIN_CONFIRMED_FIELDS = 3;

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
  /** Steps that had NOTHING TO TYPE — the project carried no value. A data gap, not drift. */
  unresolvedFields?: string[];
  /** Review-screen check (cfdcca5). fieldsSeen 0 means the screen could not be read. */
  reviewFieldsSeen?: number;
  /** Project values actually FOUND on that screen. Reading a page is not checking it. */
  reviewFieldsConfirmed?: number;
  reviewMismatches?: Array<{ field: string; expected: string; found: string }>;
  pauseReason?: string | null;
}

/**
 * Pull a replay's report out of a portal-run result.
 *
 * `ok(message, data)` puts the whole report — executed, skipped, requiredStillEmpty,
 * driftWarnings, reviewFieldsSeen — inside the STEP's `data`, never on the top-level
 * result. Reading the top level returns zero for every one of them, which is exactly what
 * made a live run that filled eight pages score "executed: 0" and still read as clean.
 *
 * Shared so the benchmark and the production KPI cannot drift apart on what a run "said".
 */
export function mergeStepReport(result: unknown): Record<string, unknown> {
  const res = (result ?? {}) as { steps?: Array<{ ok?: boolean; message?: string; data?: Record<string, unknown> }> };
  const merged: Record<string, unknown> = {};
  for (const st of res.steps ?? []) {
    for (const [k, v] of Object.entries(st?.data ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v) && !v.length && Array.isArray(merged[k])) continue; // don't blank a real list
      merged[k] = v;
    }
  }
  const stepMsg = (res.steps ?? []).find((st) => st && st.ok === false)?.message ?? "";
  const top = (result ?? {}) as Record<string, unknown>;
  return { ...top, ...merged, message: String(top.message || stepMsg) };
}

export interface ReplayScore {
  rung: ReplayRung;
  index: number;
  reason: string;
  owner: "engine" | "credential" | "portal" | "recipe" | "harness" | "data" | "none";
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

  // THE PORTAL HUNG UP ON US. Some portals (PowerClerk among them) allow exactly one
  // session per user and end the older one when a second login appears — so a sweep that
  // runs back-to-back against the same account can kill its own run, and a human logging in
  // to check on things will do it too. The adapter detects this and says so in as many
  // words; scoring it as "the recipe no longer matches the portal" blames the recipe for
  // being interrupted, and the step failure it reports is the symptom, not the cause.
  if (/ended this session|session ended|session (has )?(expired|timed out)|logged out|concurrent (login|session)/i.test(msg)) {
    return {
      rung: "login_failed", index: 1, owner: "portal", measured: false,
      reason: `not measured — the portal ended the session mid-run (commonly a second login on the same account): ${msg.slice(0, 100)}`,
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
  // A STEP WITH NO VALUE TO TYPE IS NOT A DRIFTED RECIPE.
  //
  // Both used to return false and land in `skipped`, so a run reported eight skipped steps
  // of which four were things the throwaway project never had — an account number, a meter
  // number, and two plan-set documents — and the verdict blamed the recipe. That sends
  // someone to re-record a recipe that is working. The gap is real and still demotes the
  // run; only the name on it changes.
  const unresolved = outcome.unresolvedFields ?? [];
  const unresolvedSet = new Set(unresolved.map((u) => String(u)));
  const mismatches = outcome.reviewMismatches ?? [];
  const fieldsSeen = Number(outcome.reviewFieldsSeen ?? 0);

  // Anything less than a whole run is a gap, however tidy the summary reads.
  const realSkips = skipped.filter((sName) => !/final submit|isFinalSubmit|NOT clicked/i.test(String(sName)));
  if (blanks.length || realSkips.length || healed || drift.length) {
    // Separate the two kinds of gap before naming anyone: steps that had nothing to type,
    // and steps that tried and did not land.
    // THE FINAL SUBMIT IS SUPPOSED TO BE SKIPPED. Automation never clicks it — that is the
    // system's first hard safety rule — so the recipe records it and replay declines it,
    // every single run. Counting that as a step that "did not land" scored the safety rule
    // as a defect and pushed the owner to `recipe` on a run where nothing had gone wrong.
    const isDeclinedSubmit = (n: string): boolean => /final submit|isFinalSubmit|NOT clicked/i.test(n);
    const failedSteps = skipped.filter((sName) => !unresolvedSet.has(String(sName)) && !isDeclinedSubmit(String(sName)));
    const missingData = skipped.filter((sName) => unresolvedSet.has(String(sName)) && !isDeclinedSubmit(String(sName)));
    const parts = [
      blanks.length ? `${blanks.length} required field(s) left blank (${blanks.slice(0, 3).join(", ")})` : "",
      failedSteps.length ? `${failedSteps.length} step(s) did not land (${failedSteps.slice(0, 3).join(", ").slice(0, 90)})` : "",
      missingData.length ? `${missingData.length} step(s) had NO VALUE in the project to enter (${missingData.slice(0, 3).join(", ").slice(0, 90)})` : "",
      healed ? `${healed} selector(s) had to be re-anchored — the recipe is drifting` : "",
      drift.length ? `replay warned: ${drift.slice(0, 2).join("; ").slice(0, 150)}` : "",
    ].filter(Boolean);
    // Whoever can actually fix it: a recipe that no longer lands its values, or a project
    // that was never given them. Only when the ONLY gaps are missing values is it data.
    // A RECIPE THAT LANDED EVERYTHING IT WAS GIVEN HAS NOT DRIFTED.
    //
    // The first honest run: 81 of 98 steps executed, ZERO healed, ZERO failed to land, and
    // every skip a value the project did not carry. It still read `owner: recipe`, because
    // this counted blanks and drift warnings — but a blank the recipe was never given a
    // value for, and a "Calculate left the page unchanged" caused by the empty rows above
    // it, are both the same missing data seen further downstream. Blaming the recipe there
    // sends someone to re-record a working one. The warnings stay in the reason either way;
    // only the name on the verdict changes.
    const owner = (failedSteps.length || healed) ? "recipe" as const : "data" as const;
    return { rung: "replayed_with_gaps", index: 3, owner, reason: parts.join("; ") };
  }

  // Clean, but unverified. An unreadable review screen cannot promote a run: "we could not
  // check" must never score the same as "we checked and it was right".
  if (!fieldsSeen) {
    return {
      rung: "replayed_clean", index: 4, owner: "engine",
      reason: `every recorded step ran and nothing was left blank, but the review screen could not be read — the filing is UNVERIFIED`,
    };
  }
  // READING A REVIEW SCREEN IS NOT CHECKING IT.
  //
  // Every comparison returns early when the project has no value to check with, so a page of
  // boilerplate against a sparse project yields zero mismatches having established nothing —
  // and this rung would have called that verified. A live run sat one fixture fix away from
  // exactly that: reviewFieldsSeen 4, zero mismatches, nothing confirmed. Same principle as
  // the unreadable case directly above, reached from the other side.
  const confirmed = Number(outcome.reviewFieldsConfirmed ?? 0);
  if (confirmed < MIN_CONFIRMED_FIELDS && !mismatches.length) {
    return {
      rung: "replayed_clean", index: 4, owner: "engine",
      reason: `every recorded step ran and nothing was left blank, and the review screen was read (${fieldsSeen} field(s)) — but only ${confirmed} project value(s) could be confirmed on it, which is too few to call the filing verified`,
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
    reason: `replayed ${executed} step(s) clean; the review screen shows ${fieldsSeen} field(s) and ${confirmed} project value(s) were confirmed present with no mismatch`,
  };
}

export interface ReplayRow {
  portal: string;
  profileKey: string;
  score: ReplayScore;
  /** Carried onto the scorecard so a row can be argued with without re-running it. */
  detail?: {
    executed?: number; recorded?: number; reviewFieldsSeen?: number; reviewFieldsConfirmed?: number;
    healed?: number; blanks?: number;
    /** WHICH fields, not just how many — a count sends someone back to the portal to look. */
    blankNames?: string[]; driftWarnings?: string[]; skippedNames?: string[]; unresolvedFields?: string[];
    /** Values read back from the portal after writing them, and those that would not hold. */
    fieldsVerified?: number; fieldsUnverified?: string[];
    /** THE DENOMINATOR. Every control the portal itself marked required across the run.
     *  "0 blanks" is the same sentence whether we satisfied thirty required fields or the
     *  sweep never saw one; only this number separates a complete filing from a blind one. */
    requiredFieldsSeen?: number; requiredFieldNames?: string[];
    /** The failure text in full — the scorer's reason truncates it where it matters. */
    message?: string;
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
