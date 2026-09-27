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

// ---------------------------------------------------------------------------
// THE TIER IS DECIDED FROM THE PAGE'S OWN LABELS (live run 99baa5d0, City of Jefferson OR,
// 2026-09-27). The Coos Bay electrical recipe was borrowed onto MARION COUNTY's services page.
// City of Jefferson's electrical permit is a delegation to Marion County and NO Marion County fee
// schedule is on file, so feeBracketQuantityFields emitted {} and R6 (a borrowed tier box that
// matches none of this project's tiers types BLANK) left the "5.01kva through 15kva" box empty on
// a 12.913 kVA job. The run then clicked Continue into "Please select at least 1 electrical
// service for purchase" — and reported no reason. The page ITSELF prints the tier bounds in every
// box label ("5kva or less" / "5.01kva through 15kva" / "15.01kva through 25kva" / "solar
// generation over 25 kva (enter total # of kva)"), and the project's AC kVA is known: the box to
// tick is decidable from the page WITHOUT a fee schedule. The schedule is only needed for the
// PRICE, and when one is stored it must AGREE with the page.
//
// ONE GRAMMAR FOR PORTAL LABELS, HERE. feeBracketFields.feeBracketFieldForLabel and
// recipeReplayBinding.tierKeyForLabel (backend) and the replay adapter (portal-bot) all read the
// same label shape; they used to hand it to pdfTables.parseBracketRow as a synthetic PDF row, and
// the adapter cannot import that module (pdfjs). The agreement of this grammar with the PDF fee
// table grammar on the shared spellings is pinned by backend/test/feeTierFromPage.test.ts.
// ---------------------------------------------------------------------------

/** THE RATING THE TIER IS DECIDED ON — the one number feeBracketFields.ratingKw computes (AC
 *  first, DC as the fallback), emitted into the replay's field values so the adapter asks the
 *  same question of the same number. "" when the project has no size at all. */
export const FEE_TIER_RATING_FIELD = "feeTierRatingKw";

export type TierLabelKind = "solar" | "wind" | "other";

export interface TierLabelReading extends FeeBracketBounds {
  /** Solar/renewable/electrical-systems tier, a WIND tier (never ticked for a PV job), or a tier
   *  of something else (services/feeders amps carry no kVA and never get here). */
  kind: TierLabelKind;
  /** The box asks for the kVA NUMBER, not a count: "over 25 kva (enter total # of kva)". */
  asksForKva: boolean;
}

const NUM = "(\\d+(?:[.,]\\d+)?)";
const KVA = "\\s*k\\s?va\\b";
const num = (t: string): number => Number(String(t).replace(",", "."));
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Read a portal tier label's bounds: "…- 5kva or less:", "…- 5.01kva through 15kva:",
 *  "5.01 KVA to 15 KVA", "over 25 kva", "25 kva or more". null when the label carries no kVA
 *  bound at all. An "over N" / "N or more" bound is OPEN above and starts a hundredth past N,
 *  the way a fee table prints the next row ("15.01 through 25" after "5.01 through 15"). */
export function tierBoundsFromLabel(label: string): FeeBracketBounds | null {
  const text = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!text || !/k\s?va/i.test(text)) return null;
  let m: RegExpExecArray | null;
  // "N kva or less" / "N kva or under" / "N kva and under" / "up to N kva" / "N kva or below"
  if ((m = new RegExp(`${NUM}${KVA}\\s*(?:or|and)\\s*(?:less|under|below|fewer)`, "i").exec(text))
    || (m = new RegExp(`(?:up to|not (?:more than|exceeding)|at most|less than or equal to)\\s*${NUM}${KVA}`, "i").exec(text))) {
    return { minKw: null, maxKw: num(m[1]) };
  }
  // "N(kva)? through|to|- M kva"
  if ((m = new RegExp(`${NUM}(?:${KVA})?\\s*(?:through|thru|to|-|–|—)\\s*${NUM}${KVA}`, "i").exec(text))) {
    const lo = num(m[1]);
    const hi = num(m[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) return { minKw: lo, maxKw: hi };
  }
  // "over N kva" / "above N kva" / "greater than N kva" / "exceeding N kva" / "more than N kva"
  if ((m = new RegExp(`(?:over|above|greater than|exceeding|more than|in excess of)\\s*${NUM}${KVA}`, "i").exec(text))) {
    return { minKw: round2(num(m[1]) + 0.01), maxKw: null };
  }
  // "N kva or more" / "N kva and above" / "N kva or greater" / "N kva and up"
  if ((m = new RegExp(`${NUM}${KVA}\\s*(?:or|and)\\s*(?:more|above|greater|up|over|larger)`, "i").exec(text))) {
    return { minKw: num(m[1]), maxKw: null };
  }
  return null;
}

/** Whose tier this label is. WIND is read by name so a 30 kVA solar job never lands in Marion's
 *  "Renewable energy for wind systems- 25.01kva through 50kva" box (it goes to "solar generation
 *  over 25 kva"). */
export function tierLabelKind(label: string): TierLabelKind {
  const t = String(label ?? "");
  if (/\bwind\b/i.test(t)) return "wind";
  if (/solar|photovoltaic|\bpv\b|renewable|electrical systems|generation|inverter/i.test(t)) return "solar";
  return "other";
}

/** "over 25 kva (enter total # of kva)" — the box takes the kVA number. */
export function tierAsksForKva(label: string): boolean {
  return /enter\s*(?:the\s*)?(?:total\s*)?(?:#|number|no\.?|amount)\s*(?:of\s*)?kva|total\s*(?:#|number)?\s*(?:of\s*)?kva|enter\s*(?:total\s*)?kva|kva\s*\(enter/i.test(String(label ?? ""));
}

/** Everything the adapter needs to know about one printed tier box, from its label alone. */
export function readTierLabel(label: string): TierLabelReading | null {
  const b = tierBoundsFromLabel(label);
  if (!b) return null;
  return { ...b, kind: tierLabelKind(label), asksForKva: tierAsksForKva(label) };
}

/** Two kVA tiers are the same printed row when their bounds agree to the hundredth a fee table
 *  prints between rows ("5.01 to 15" vs a table written 5–15); an open lower bound is 0. The one
 *  predicate — recipeReplayBinding re-exports it. */
export function sameFeeTier(a: FeeBracketBounds, b: FeeBracketBounds): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) <= 0.0101;
  const maxEq = (a.maxKw == null && b.maxKw == null) || (a.maxKw != null && b.maxKw != null && close(a.maxKw, b.maxKw));
  return maxEq && close(a.minKw ?? 0, b.minKw ?? 0);
}

/** How a tier reads out loud: "5.01–15 kVA", "25.01 kVA and above". */
export function tierBoundsLabel(b: FeeBracketBounds): string {
  if (b.minKw == null && b.maxKw != null) return `${b.maxKw} kVA and under`;
  if (b.maxKw == null && b.minKw != null) return `${b.minKw} kVA and above`;
  return `${b.minKw}–${b.maxKw} kVA`;
}

/** A tier quantity box as read off the page: its control id and its own label. */
export interface TierBoxOnPage {
  id: string;
  label: string;
}

export interface FeeTierDecision {
  /** The box that gets the value, or null when nothing may be typed. */
  chosen: { id: string; label: string; value: string; bounds: FeeBracketBounds } | null;
  /** Why nothing was chosen (the pause's named reason), "" when chosen. */
  reason: string;
  /** The solar tier family that was read, for the report. */
  family: Array<{ id: string; label: string; bounds: FeeBracketBounds }>;
}

/** The number the "enter total # of kva" box takes: the rating as the project states it, no
 *  spurious precision ("30", "12.913"). */
export function kvaText(kw: number): string {
  return String(Number(kw.toFixed(3)));
}

/** DECIDE THE TIER FROM THE PAGE. Pure over (boxes, rating, stored schedule) so it is testable
 *  without a browser and its refusals are named:
 *    · no solar tier box on the page               → nothing to decide (not a tier page);
 *    · no rating on the project                     → NEVER guessed;
 *    · the rating falls in no tier / in two tiers   → refused, both named;
 *    · a stored schedule's "1" disagrees with the page's own bounds → refused (the schedule is
 *      the PRICE check; two answers to "which row" is a stop, not a coin toss).
 *  The chosen box gets "1" — a count — unless its label asks for the kVA number. Sibling boxes are
 *  never typed "0" by this decision (the learn's human left them EMPTY; the planner prompt says
 *  the same); a stored schedule's own "0" keys still replay through their recorded steps. */
export function decideFeeTier(input: {
  boxes: TierBoxOnPage[];
  ratingKw: number | null;
  /** The stored schedule's ticked tier (the feeBracketQuantity:* key whose value is "1"), if any. */
  scheduleTierKey?: string | null;
}): FeeTierDecision {
  const family: FeeTierDecision["family"] = [];
  const seen = new Set<string>();
  for (const box of input.boxes ?? []) {
    const id = String(box?.id ?? "").trim();
    const label = String(box?.label ?? "").trim();
    if (!id || !label || seen.has(id)) continue;
    const r = readTierLabel(label);
    if (!r || r.kind !== "solar") continue;
    seen.add(id);
    family.push({ id, label, bounds: { minKw: r.minKw, maxKw: r.maxKw } });
  }
  const list = () => family.map((f) => `"${f.label.replace(/:\s*$/, "").slice(0, 70)}"`).join(", ");
  if (!family.length) return { chosen: null, reason: "no solar kVA tier box could be read on this page (every box label was checked for kVA bounds)", family };
  const kw = input.ratingKw;
  if (kw == null || !Number.isFinite(kw) || kw <= 0) {
    return { chosen: null, reason: `this project has no AC (or DC) system size to place in a tier, and the tier is never guessed — the page offers ${list()}`, family };
  }
  const containing = family.filter((f) => (f.bounds.minKw == null || kw >= f.bounds.minKw) && (f.bounds.maxKw == null || kw <= f.bounds.maxKw));
  if (!containing.length) return { chosen: null, reason: `${kvaText(kw)} kVA falls in none of the tiers this page prints: ${list()}`, family };
  if (containing.length > 1) {
    return { chosen: null, reason: `${kvaText(kw)} kVA falls in ${containing.length} of the tiers this page prints (${containing.map((f) => `"${f.label.replace(/:\s*$/, "").slice(0, 70)}"`).join(" and ")}) — which box to tick cannot be told`, family };
  }
  const pick = containing[0];
  const scheduled = input.scheduleTierKey ? parseFeeBracketFieldKey(input.scheduleTierKey) : null;
  if (scheduled && !sameFeeTier(scheduled, pick.bounds)) {
    return {
      chosen: null,
      reason: `the stored fee schedule puts ${kvaText(kw)} kVA in the ${tierBoundsLabel(scheduled)} tier but this page's own labels put it in "${pick.label.replace(/:\s*$/, "").slice(0, 70)}" — the schedule on file does not match this agency's services page`,
      family,
    };
  }
  const value = tierAsksForKva(pick.label) ? kvaText(kw) : "1";
  return { chosen: { id: pick.id, label: pick.label, value, bounds: pick.bounds }, reason: "", family };
}
