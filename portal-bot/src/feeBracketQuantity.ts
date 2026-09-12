// ---------------------------------------------------------------------------
// FEE BRACKET QUANTITIES — one box per row of the county's fee table.
//
// MEASURED, in the live database. The City of Coos Bay ELECTRICAL recipe
// (profile_key "or|city of coos bay|pacific power", 53 steps) carries exactly one
// fill step with no field binding:
//
//   label "Renewable energy for electrical systems- 5.01kva through 15kva:"
//   value "1"
//   id    ctl00_PlaceHolderMain_AppSpecB42EAF26Edit_COOS_CO_txt_0_28
//
// Accela renders ONE TEXT BOX PER BRACKET ROW of Coos County's schedule, and the
// quantity ticks the row that applies to this job. "1" is the right answer for the
// project the recipe was LEARNED on (4.55 kW-AC would be wrong too — that job is in
// "5 KVA or less"). Replay it onto a 20 kVA job and the county bills the 5.01–15
// tier for a 15.01–25 system: wrong, and invisible, because the field looks
// answered and every click succeeds.
//
// So the answer has to be computed per project from the stored fee schedule, and
// the ONE THING that makes that possible without touching replay is that
// resolveRecipeFieldValues returns a FLAT Record<string,string> the adapter looks a
// step's `field` up in. Emit one key PER BRACKET — "feeBracketQuantity:5.01-15" —
// carrying "1" for the bracket this project falls in and "0" for the others, bind
// each recorded box to its own key, and replay needs no change at all: "0" is a
// non-empty string, so it survives the adapter's `if (!v)` blank check and gets
// typed like any other value.
//
// THIS MODULE IS A LEAF ON PURPOSE. The key format has to be identical on three
// sides — the backend resolver that emits the values, the backend binder that reads
// a recorded Accela label, and the portal-bot adapter that checks coverage — and
// "the concept lived in two places and the copies disagreed" is a bug this codebase
// has already paid for more than once. It imports nothing but the shared step type
// so the backend (which already imports addressParse from here, same reason) and
// the adapter can both have it.
// ---------------------------------------------------------------------------
import type { RecipeStep } from "../../shared/src/types";

/** Every bracket-quantity binding starts with this. The colon is deliberate: it
 *  cannot collide with a resolver key or a planner-invented camelCase name, and it
 *  makes the family greppable in a stored recipe. */
export const FEE_BRACKET_FIELD_PREFIX = "feeBracketQuantity:";

/** Canonical number text for a bound. `String(Number(x))` folds 15.00 and 15 onto
 *  the same key, which matters because the schedule prints "15" and an Accela label
 *  may print "15.00" for the identical row. */
function boundText(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "";
  return String(Number(value));
}

/** The field key for one bracket. "" when the bracket carries NEITHER bound — a row
 *  with no size is not a size row (the same rule matchBracket applies when it
 *  evaluates), and a key of "feeBracketQuantity:-" would collide every such row onto
 *  one another. */
export function feeBracketFieldKey(minKw: number | null | undefined, maxKw: number | null | undefined): string {
  const min = boundText(minKw);
  const max = boundText(maxKw);
  if (!min && !max) return "";
  return `${FEE_BRACKET_FIELD_PREFIX}${min}-${max}`;
}

export interface FeeBracketBounds {
  minKw: number | null;
  maxKw: number | null;
}

/** Read a field key back into its bounds. Returns null for anything that is not one
 *  of ours, so a caller can filter a whole fieldValues map through it. */
export function parseFeeBracketFieldKey(field: string): FeeBracketBounds | null {
  const raw = String(field ?? "");
  if (!raw.startsWith(FEE_BRACKET_FIELD_PREFIX)) return null;
  const body = raw.slice(FEE_BRACKET_FIELD_PREFIX.length);
  const at = body.indexOf("-");
  if (at < 0) return null;
  const minText = body.slice(0, at);
  const maxText = body.slice(at + 1);
  const toNum = (t: string): number | null => {
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const minKw = toNum(minText);
  const maxKw = toNum(maxText);
  if ((minText && minKw == null) || (maxText && maxKw == null)) return null;
  if (minKw == null && maxKw == null) return null;
  return { minKw, maxKw };
}

/** How a person would say the bracket out loud, for an operator-facing message.
 *  Built from the KEY rather than from the schedule's own wording, so the coverage
 *  check stays pure over (steps, fieldValues) and needs no second lookup. */
export function feeBracketFieldLabel(field: string): string {
  const b = parseFeeBracketFieldKey(field);
  if (!b) return field;
  if (b.minKw == null) return `${b.maxKw} kVA and under`;
  if (b.maxKw == null) return `${b.minKw} kVA and above`;
  return `${b.minKw}–${b.maxKw} kVA`;
}

export interface FeeBracketCoverage {
  /** The bracket key this project's job actually falls in. */
  needed: string;
  neededLabel: string;
  /** Bracket keys the recipe has a step for. */
  recorded: string[];
  /** THE HAZARD. True when the box that must read "1" is not in the recipe at all. */
  uncovered: boolean;
}

/** DOES THIS RECIPE HAVE A BOX FOR THE BRACKET THIS JOB IS IN?
 *
 *  Computing the quantity correctly turns a 20 kVA job's wrong "1" into a right "0"
 *  — a strict improvement — but the 15.01–25 box then needs its own "1" AND NO STEP
 *  EXISTS FOR IT, because the recording only ever captured the box the learn project
 *  filled. A zero in the only box we know about is a fee the county will not have
 *  charged: a silently UNDER-billed permit, which is the same class of invisible
 *  wrongness as the frozen "1" and is not an acceptable trade for fixing it.
 *
 *  So this is the second half of the change, not a nicety. The caller reports it on
 *  the review screen a person already checks, and the run is completed by hand.
 *
 *  Returns null — deliberately silent — in the two cases that are NOT this hazard:
 *    · the project has no bracket keys at all (no schedule on file, or a schedule
 *      that does not bracket on system size). Nothing was computed, so the recipe's
 *      recorded literal replays exactly as it does today, which is visible.
 *    · the recipe has no bracket-bound step at all. This portal does not ask the
 *      question, or the binder has not been run against this recipe yet; either way
 *      there is no box to be missing.
 *
 *  Pure over (steps, fieldValues) so it can be tested on a scratch DB with no
 *  browser, no network and no LLM.
 */
export function feeBracketCoverage(
  steps: RecipeStep[] | undefined,
  fieldValues: Record<string, string> | undefined,
): FeeBracketCoverage | null {
  const values = fieldValues ?? {};
  let needed = "";
  for (const [key, value] of Object.entries(values)) {
    if (!parseFeeBracketFieldKey(key)) continue;
    if (String(value).trim() === "1") { needed = key; break; }
  }
  if (!needed) return null;

  const recorded: string[] = [];
  for (const step of steps ?? []) {
    const field = String(step?.field ?? "");
    if (!parseFeeBracketFieldKey(field)) continue;
    if (!recorded.includes(field)) recorded.push(field);
  }
  if (!recorded.length) return null;

  return {
    needed,
    neededLabel: feeBracketFieldLabel(needed),
    recorded,
    uncovered: !recorded.includes(needed),
  };
}

/** The sentence the operator reads. One place so the review-screen banner and the
 *  drift warning cannot describe the same condition two different ways. */
export function feeBracketCoverageMessage(coverage: FeeBracketCoverage): string {
  return `Fee bracket "${coverage.neededLabel}" — this job's bracket — has NO box in the recorded recipe`
    + ` (it only knows ${coverage.recorded.map(feeBracketFieldLabel).join(", ")}),`
    + ` so every bracket box this run filled reads 0. Enter 1 in the "${coverage.neededLabel}" row BY HAND`
    + ` before submitting, or the county bills nothing for this permit.`;
}
