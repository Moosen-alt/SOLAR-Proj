// ---------------------------------------------------------------------------
// LEARN BENCHMARK — how often does pointing the bot at a portal actually work?
//
// "Is the learn universal?" has been answered all session by ad-hoc scripts that were
// deleted afterwards, so every number came with no way to reproduce or compare it. A target
// like "95% accuracy" is unverifiable in that state: you cannot move a number you do not
// keep.
//
// This scores every learn on ONE ladder, so a run produces a figure that means the same
// thing next week as it does today, and a regression is visible as a portal that fell a rung
// rather than as a vague sense that things got worse.
//
// WHY A LADDER AND NOT PASS/FAIL. Almost no first run reaches the top, and a flat pass rate
// throws away the only information worth having: a portal stuck at `login_failed` needs a
// human with a password, one stuck at `authenticated` is an entry-finder gap, and one stuck
// at `reached_form` is a fill problem. Those are three different jobs, and the ladder tells
// them apart without anyone reading a log.
//
// It never submits: the learn stops at the review screen by design. It is deliberately not
// wired into any test chain — it drives live government portals and costs LLM calls, so it
// runs only when a person asks for it.
// ---------------------------------------------------------------------------

import { isHarnessAbort } from "./runAbort";

/** How far a learn got, worst to best. Index is the score. */
export const LEARN_RUNGS = [
  "unreachable",          // the portal never loaded
  "login_failed",         // a login was reached but not passed (stale/missing credential, MFA)
  "authenticated",        // signed in, but no way into an application was found
  "entered_application",  // the entry control was found and followed
  "reached_form",         // a page with fillable fields was reached
  "recorded_steps",       // steps were captured — a recipe exists
  "reached_review",       // the review screen: the whole point
] as const;

export type LearnRung = typeof LEARN_RUNGS[number];

export interface LearnOutcome {
  /** autoLearnPortal's status: complete | failed | paused | ... */
  status?: string;
  pageCount?: number;
  /** Steps on the resulting recipe, of every kind including goto and click. */
  steps?: number;
  /**
   * Steps that actually PUT DATA INTO THE FORM — fill, select, check.
   *
   * The rung above reached_form is called "recorded_steps" and the headline counts it as a
   * usable recipe. Counting raw steps made that claim for navigation: of six "usable"
   * recipes in the 2026-09-04 re-sweep, three held a goto and some clicks and nothing else
   * — momentum 5 steps / 0 fills, permittrax 4 / 0, iWorq 2 / 0. Momentum's own run said
   * "found nothing fillable on 4 page(s); no steps recorded" while the scorecard called it
   * a usable recipe.
   *
   * A recipe that fills nothing replays to a blank application. Same rule the trust gate in
   * autoLearn already applies to promotion, so the two agree on what a recipe IS.
   */
  substantiveSteps?: number;
  message?: string;
  /** Whether the run reached the portal's review screen. */
  reachedReview?: boolean;
  /** Parsed events.jsonl from the run's debug bundle, if available. */
  events?: Array<{ type?: string; status?: string; ok?: boolean; trace?: string }>;
}

export interface LearnScore {
  rung: LearnRung;
  /** 0-6. The number that moves. */
  index: number;
  /** Why this rung and not the next — the actionable half. */
  reason: string;
  /** Who has to do something about it. */
  owner: "engine" | "credential" | "portal" | "harness" | "none";
  /**
   * False when the run never became a measurement of the portal at all — see
   * HARNESS_ABORT. Absent means measured; old scorecards on disk predate the field.
   */
  measured?: boolean;
}

const evt = (o: LearnOutcome, type: string) => (o.events ?? []).find((e) => e?.type === type);

/** Whether a score represents a real attempt at the portal. Old rows on disk carry no
 *  `measured` flag, so their reason text is the only evidence — read it too. */
export function isMeasured(score: Pick<LearnScore, "reason" | "measured">): boolean {
  if (score.measured === false) return false;
  return !isHarnessAbort(score.reason);
}

/**
 * Score one learn. Pure, so the ladder can be tested without touching a portal — which
 * matters, because the scoring is the part that must not drift.
 *
 * Evidence order is deliberate: the RUN'S OWN EVENTS beat the summary message, because a
 * message is prose assembled at the end while events are recorded as they happen.
 */
/**
 * A HUMAN CHALLENGE IS NOT AN ENGINE DEFECT — AT ANY STAGE.
 *
 * The scorer knew this at the login step (`mfa_captcha` -> owner portal) and nowhere else.
 * Star ID (iWorq) walked to its "Solar Permit or Panel Application" — the right form, on a
 * portal that needs no account — and stopped on `challenge_stop: challenge frame detected
 * (recaptcha)`. That is the engine doing exactly what the safety rules require: automation
 * never solves a CAPTCHA, a person does. It was scored owner ENGINE, which reads as a
 * defect to fix and sends the next day's work at a wall that is meant to be there.
 *
 * The rung is unchanged — a run keeps whatever it reached — but the owner and the reason
 * become the truth: a person has to clear this.
 */
function challengeStopped(outcome: LearnOutcome): string {
  for (const e of outcome.events ?? []) {
    if (e?.type === "challenge_stop") return String((e as { detail?: unknown }).detail || "a human challenge");
    // A CONSENT WALL IS A HUMAN DECISION TOO. Des Moines will not start an application
    // until its cookie consent is answered — the engine picked the right permit type and
    // the portal redirected it to the cookie policy regardless. Accepting non-essential
    // cookies for the operator is not automation's call, so this ends the run the same way
    // a CAPTCHA does, and belongs to the same owner: not us.
    if (e?.type === "consent_wall") return "a cookie-consent wall the portal will not pass without an answer";
  }
  if (/cookie consent is answered|consent wall/i.test(String(outcome.message || ""))) {
    return "a cookie-consent wall the portal will not pass without an answer";
  }
  if (/challenge frame detected|recaptcha|captcha|hcaptcha|cloudflare turnstile/i.test(String(outcome.message || ""))) {
    return "a CAPTCHA/challenge";
  }
  return "";
}

export function scoreLearnOutcome(outcome: LearnOutcome): LearnScore {
  const score = scoreLearnOutcomeInner(outcome);
  const challenge = challengeStopped(outcome);
  // Applied last, so it re-attributes whatever rung was reached rather than replacing it.
  // The login-stage branch already says "portal"; this catches the rest of the walk.
  if (challenge && score.owner !== "credential" && score.owner !== "none") {
    return {
      ...score,
      owner: "portal",
      reason: `${score.reason} — then stopped at ${challenge}, which a human must clear (automation never solves one)`,
    };
  }
  return score;
}

function scoreLearnOutcomeInner(outcome: LearnOutcome): LearnScore {
  const msg = String(outcome.message || "");
  const login = evt(outcome, "login");
  const entry = evt(outcome, "application_entry_pass");
  const pages = Number(outcome.pageCount ?? 0);
  const steps = Number(outcome.steps ?? 0);
  // Navigation is not a recipe: see substantiveSteps. Falls back to the raw count only when
  // the caller could not tell them apart, so an old scorecard still reads sensibly.
  const substantive = Number(outcome.substantiveSteps ?? outcome.steps ?? 0);

  // Top rung first: reaching review is the goal and outranks everything below it.
  if (outcome.reachedReview || /reached (the )?review/i.test(msg)) {
    return { rung: "reached_review", index: 6, reason: "reached the portal's review screen", owner: "none" };
  }
  if (substantive > 0 && pages > 0) {
    return { rung: "recorded_steps", index: 5, reason: `recorded ${substantive} field fill(s) across ${pages} page(s) but never reached review`, owner: "engine" };
  }
  if (pages > 0) {
    // Walked and clicked, but put no data into anything. This is the case that used to be
    // promoted to "usable recipe" on the strength of a goto and four clicks.
    if (steps > 0) {
      return {
        rung: "reached_form", index: 4,
        reason: `walked ${pages} page(s) and recorded ${steps} navigation step(s) but filled NO fields — a recipe that fills nothing replays to a blank application`,
        owner: "engine",
      };
    }
    // Two very different jobs land on this rung, and the reason is the actionable half.
    // "Our filler found nothing on a page it reached" is a planner gap; "the clock ran out
    // mid-walk" is a budget question. Reading the second as the first sends a day's work
    // at the wrong problem.
    const reason = String(outcome.status) === "timeout"
      ? `walked ${pages} page(s) and was cut off before a recipe was saved — it needs more time, not more detection`
      : `walked ${pages} page(s) but recorded no steps — nothing fillable was identified`;
    return { rung: "reached_form", index: 4, reason, owner: "engine" };
  }

  // Below the form, the events decide. An entry that was found and followed is real progress
  // even when the page after it defeated the planner.
  if (entry?.ok) {
    return { rung: "entered_application", index: 3, reason: "followed the application entry, but no page was planned", owner: "engine" };
  }

  // A DEAD HARNESS IS NOT A VERDICT EITHER — and unlike the cap below, it is not even a
  // slow engine. Nothing was learned about this portal, so it is marked unmeasured and
  // kept out of the average rather than counted as a zero. Placed after the progress
  // rungs above so a run that died holding real steps still keeps that credit.
  if (isHarnessAbort(msg)) {
    return {
      rung: "unreachable",
      index: 0,
      reason: `not measured — the run was cut short by the harness, not the portal: ${msg.slice(0, 110)}`,
      owner: "harness",
      measured: false,
    };
  }

  const loginStatus = String(login?.status || "");

  // A CAP IS NOT A VERDICT. A portal stopped by the benchmark's own time limit is scored on
  // what it actually reached (handled above by pages/steps/entry), never as a portal failure
  // — otherwise the harness would blame portals for its own impatience.
  //
  // AND IT MUST BE ASKED LAST AMONG THE LOW RUNGS. This branch used to sit above the login
  // checks, so it answered for every capped run before anything else got a look — and once
  // capped runs began carrying their event log, bsaonline's "mfa_captcha" would have been
  // filed as "stopped before reaching a login" when the bundle plainly says a human
  // challenge stopped it. A cap explains why a run ENDED; it never overrides what the run
  // had already established.
  if (String(outcome.status) === "timeout" && !loginStatus) {
    return { rung: "unreachable", index: 0, reason: "stopped by the benchmark time cap before reaching a login", owner: "engine" };
  }

  if (loginStatus === "logged_in" || loginStatus === "already_authenticated") {
    return { rung: "authenticated", index: 2, reason: "signed in, but no way into an application was found", owner: "engine" };
  }
  if (loginStatus === "no_login_required") {
    // A public submission form: there is no account to sign in to, so being past "login" is
    // not an achievement and not a failure. Scored level with authenticated.
    return { rung: "authenticated", index: 2, reason: "no login exists on this portal; the application is published directly", owner: "engine" };
  }
  if (loginStatus === "no_credential") {
    return { rung: "login_failed", index: 1, reason: "a login page was reached but no credential is stored for this portal", owner: "credential" };
  }
  if (loginStatus === "still_on_login" || /still on the login form|likely rejected/i.test(msg)) {
    return { rung: "login_failed", index: 1, reason: "the stored credential was refused by the portal", owner: "credential" };
  }
  if (loginStatus === "mfa_captcha" || /mfa|captcha/i.test(msg)) {
    return { rung: "login_failed", index: 1, reason: "stopped at an MFA/CAPTCHA challenge, which a human must clear", owner: "portal" };
  }
  // A PORTAL THAT NEVER ANSWERED IS NOT A DETECTOR BUG.
  //
  // The first baseline scored three portals as "the login form was not recognised", owner
  // engine — and probing them found one timed out, one returned 403 to a headless browser,
  // and one has no login at all. Only the third was ours. A benchmark that blames the engine
  // for a dead host sends the next day's work in the wrong direction, so network and
  // refusal failures are separated out before the login branches below.
  if (/ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_ABORTED|ERR_CERT|net::|ETIMEDOUT|ENOTFOUND|navigation timeout/i.test(msg)) {
    return { rung: "unreachable", index: 0, reason: "the portal did not respond", owner: "portal" };
  }
  if (/\b403\b|forbidden|access denied|request could not be satisfied|are you a robot|unusual traffic/i.test(msg)) {
    return { rung: "unreachable", index: 0, reason: "the portal refused an automated browser (WAF/bot block)", owner: "portal" };
  }
  if (loginStatus === "login_form_unrecognized" || /could not find a login form/i.test(msg)) {
    // Reached the site and it served a page, but no login was recognisable. Ours — unless
    // the page turns out to need no login at all, which the engine handles separately.
    return { rung: "login_failed", index: 1, reason: "the portal's login form was not recognised", owner: "engine" };
  }
  if (login) {
    return { rung: "login_failed", index: 1, reason: `login ended as "${loginStatus || "unknown"}"`, owner: "engine" };
  }
  return { rung: "unreachable", index: 0, reason: msg.slice(0, 160) || "the portal never loaded", owner: "portal" };
}

/**
 * DID THE RUN REACH A REVIEW SCREEN? ONE ANSWER, FROM THE RUN'S OWN TRACE.
 *
 * There were two readings of this and they disagreed, which the benchmark caught by
 * reporting a regression that had not happened. The live runner tested the summary MESSAGE
 * with a regex; rescoreBenchmark read `review=true` out of the page traces. Gilbert's run
 * was identical on both days — trace says review=true, one page, ten steps — and scored 6
 * from the bundle and 5 from the message, so a rescored card and a fresh card could never
 * be compared without a phantom in the diff.
 *
 * The trace wins: it is recorded by the walk at the moment it judged the page, while the
 * message is prose assembled at the end. Both callers use this now, so the two paths cannot
 * drift apart again.
 */
export function reachedReviewFromEvents(
  events: Array<{ type?: string; trace?: string }> | undefined,
  message?: string,
): boolean {
  for (const e of events ?? []) {
    if (e?.type === "page" && /review=true/.test(String(e.trace || ""))) return true;
  }
  return /reached (the )?review|awaiting human/i.test(String(message || ""));
}

export interface BenchmarkRow { portal: string; platform: string; score: LearnScore }

export interface BenchmarkSummary {
  /** Every row attempted, measured or not. */
  total: number;
  /** Rows that actually became a measurement of a portal. The denominator. */
  measured: number;
  /** Rows the harness aborted before they could measure anything. */
  notMeasured: number;
  /** The headline: portals that produced a usable recipe (rung >= recorded_steps). */
  usableRecipes: number;
  usablePct: number;
  /** Mean rung index over all portals, 0-6 — moves before the headline does. */
  meanIndex: number;
  byRung: Record<string, number>;
  /** Split by who can act, so the number is not read as one problem. */
  byOwner: Record<string, number>;
}

export function summarize(rows: BenchmarkRow[]): BenchmarkSummary {
  const byRung: Record<string, number> = {};
  const byOwner: Record<string, number> = {};
  for (const r of LEARN_RUNGS) byRung[r] = 0;
  let sum = 0;
  let usable = 0;
  let measured = 0;
  for (const row of rows) {
    byRung[row.score.rung] = (byRung[row.score.rung] ?? 0) + 1;
    byOwner[row.score.owner] = (byOwner[row.score.owner] ?? 0) + 1;
    // A run the harness killed says nothing about the portal, so it is neither a
    // success nor a failure — it is not in the sample. Counting it as a zero is how
    // an 11-portal run reported "9% usable, mean 0.55" when only three portals had
    // actually been tried.
    if (!isMeasured(row.score)) continue;
    measured++;
    sum += row.score.index;
    if (row.score.index >= 5) usable++;
  }
  return {
    total: rows.length,
    measured,
    notMeasured: rows.length - measured,
    usableRecipes: usable,
    usablePct: measured ? Math.round((usable / measured) * 1000) / 10 : 0,
    meanIndex: measured ? Math.round((sum / measured) * 100) / 100 : 0,
    byRung,
    byOwner,
  };
}

/**
 * Compare against a previous run. Regressions are listed first and separately: a portal that
 * FELL a rung is the thing worth waking up for, and averaging it away is how a benchmark
 * stops being useful.
 */
export function compareRuns(
  previous: BenchmarkRow[],
  current: BenchmarkRow[],
): { regressed: Array<{ portal: string; from: LearnRung; to: LearnRung }>; improved: Array<{ portal: string; from: LearnRung; to: LearnRung }>; unchanged: number } {
  const before = new Map(previous.map((r) => [r.portal, r.score]));
  const regressed: Array<{ portal: string; from: LearnRung; to: LearnRung }> = [];
  const improved: Array<{ portal: string; from: LearnRung; to: LearnRung }> = [];
  let unchanged = 0;
  for (const row of current) {
    const was = before.get(row.portal);
    if (!was) continue;
    // NEITHER SIDE MAY BE A NON-MEASUREMENT. A killed run stored eight portals at
    // index 0; comparing the next real run against those would announce eight
    // "improvements" that are only the difference between measuring and not. The same
    // in reverse would cry regression the next time a run is interrupted.
    if (!isMeasured(was) || !isMeasured(row.score)) continue;
    if (row.score.index < was.index) regressed.push({ portal: row.portal, from: was.rung, to: row.score.rung });
    else if (row.score.index > was.index) improved.push({ portal: row.portal, from: was.rung, to: row.score.rung });
    else unchanged++;
  }
  return { regressed, improved, unchanged };
}
