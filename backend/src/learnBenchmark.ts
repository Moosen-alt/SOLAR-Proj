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
  /** Steps on the resulting recipe. */
  steps?: number;
  message?: string;
  /** Whether the run reached the portal's review screen. */
  reachedReview?: boolean;
  /** Parsed events.jsonl from the run's debug bundle, if available. */
  events?: Array<{ type?: string; status?: string; ok?: boolean }>;
}

export interface LearnScore {
  rung: LearnRung;
  /** 0-6. The number that moves. */
  index: number;
  /** Why this rung and not the next — the actionable half. */
  reason: string;
  /** Who has to do something about it. */
  owner: "engine" | "credential" | "portal" | "none";
}

const evt = (o: LearnOutcome, type: string) => (o.events ?? []).find((e) => e?.type === type);

/**
 * Score one learn. Pure, so the ladder can be tested without touching a portal — which
 * matters, because the scoring is the part that must not drift.
 *
 * Evidence order is deliberate: the RUN'S OWN EVENTS beat the summary message, because a
 * message is prose assembled at the end while events are recorded as they happen.
 */
export function scoreLearnOutcome(outcome: LearnOutcome): LearnScore {
  const msg = String(outcome.message || "");
  const login = evt(outcome, "login");
  const entry = evt(outcome, "application_entry_pass");
  const pages = Number(outcome.pageCount ?? 0);
  const steps = Number(outcome.steps ?? 0);

  // Top rung first: reaching review is the goal and outranks everything below it.
  if (outcome.reachedReview || /reached (the )?review/i.test(msg)) {
    return { rung: "reached_review", index: 6, reason: "reached the portal's review screen", owner: "none" };
  }
  if (steps > 0 && pages > 0) {
    return { rung: "recorded_steps", index: 5, reason: `recorded ${steps} step(s) across ${pages} page(s) but never reached review`, owner: "engine" };
  }
  if (pages > 0) {
    return { rung: "reached_form", index: 4, reason: `walked ${pages} page(s) but recorded no steps — nothing fillable was identified`, owner: "engine" };
  }

  // Below the form, the events decide. An entry that was found and followed is real progress
  // even when the page after it defeated the planner.
  if (entry?.ok) {
    return { rung: "entered_application", index: 3, reason: "followed the application entry, but no page was planned", owner: "engine" };
  }

  const loginStatus = String(login?.status || "");
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

export interface BenchmarkRow { portal: string; platform: string; score: LearnScore }

export interface BenchmarkSummary {
  total: number;
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
  for (const row of rows) {
    byRung[row.score.rung] = (byRung[row.score.rung] ?? 0) + 1;
    byOwner[row.score.owner] = (byOwner[row.score.owner] ?? 0) + 1;
    sum += row.score.index;
    if (row.score.index >= 5) usable++;
  }
  const total = rows.length;
  return {
    total,
    usableRecipes: usable,
    usablePct: total ? Math.round((usable / total) * 1000) / 10 : 0,
    meanIndex: total ? Math.round((sum / total) * 100) / 100 : 0,
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
    if (row.score.index < was.index) regressed.push({ portal: row.portal, from: was.rung, to: row.score.rung });
    else if (row.score.index > was.index) improved.push({ portal: row.portal, from: was.rung, to: row.score.rung });
    else unchanged++;
  }
  return { regressed, improved, unchanged };
}
