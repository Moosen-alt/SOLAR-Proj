// ---------------------------------------------------------------------------
// CROSS-PROJECT TRIPWIRES — did the replay file THIS project, or the one it learned on?
//
// The product contract is "the learn goes off once per portal, then replay does the heavy
// lifting". Its safety half: a recipe learned on project A is reused for project B, and A's
// homeowner must never appear on B's application. The value-resolution unit test
// (portal-bot/src/adapters/crossProjectReplay.test.ts) proved the leak exists at the
// resolveValue layer; this module is the LIVE half — given what a real replay reported
// filling, classify every value as B's (landed), A's (leaked), both (shared — no evidence
// either way), or neither (unverifiable by this sweep).
//
// Pure and browser-free so the classification can be kill-tested without a portal —
// the part that must not drift is exactly the part that decides "leak" vs "fine".
//
// MATCHING RULES, and the two traps they were built around:
//   • Unit-scaled leaks are real leaks: A's 7.2 kW typed as "7200" W is still A's system
//     size on B's form. Mirrors tracesTo in portal-bot/src/llmGapFill.ts — same factors.
//   • ...but the numeric path runs ONLY on values that ARE numbers. tracesTo strips
//     non-digits first, so "Q.PEAK DUO BLK ML-G10.a+ 405" reduces to ".10405" and
//     "Q.PEAK DUO BLK ML-G10+ 400" to ".10400" — within 0.5% of each other, a false
//     "leak" between two different module models. A model string is not a quantity.
//   • Containment needs a length floor: A's dcKw "7.2" normalizes to "72", which appears
//     inside phone numbers and zip codes. Exact equality has no floor (A's module count
//     "18" replayed verbatim must be caught); substring matching starts at 4 chars.
// ---------------------------------------------------------------------------

/** One value the replay reported putting on the portal. Field names come from the
 *  adapter's own labels (step.note), which are NOT unique — PowerClerk renders two bare
 *  "Manufacturer" selects — so this is an array, never a map keyed by name. */
export interface FilledField {
  field: string;
  value: string;
  /** Where the value came from: a project binding, the CEC-certified rendering of one,
   *  or a literal frozen into the recipe at learn time (the place leaks live). */
  source?: "bound" | "certified" | "literal" | "none";
}

export interface TripwireMatch {
  field: string;
  value: string;
  /** Which of project A's tripwire keys this value traces to. */
  matchedA: string[];
  /** Which of project B's expected keys this value traces to. */
  matchedB: string[];
}

export interface TripwireReport {
  /** B's value, and only B's: the substitution worked. */
  landed: TripwireMatch[];
  /** A's value, and not B's: the learn project leaked into this filing. */
  leaked: TripwireMatch[];
  /** Traces to BOTH projects (utility name, state, battery "No"). A value A and B
   *  genuinely share proves nothing either way — shared, not evidence. */
  shared: TripwireMatch[];
  /** Traces to A but ALSO to the CLIENT's own record — the installer's email, licence,
   *  business address. A value the solar company itself carries appears on EVERY filing
   *  that company makes, so its presence on B's filing can never prove cross-PROJECT
   *  leakage. Found live on the first Ameren B run: three "leaks" of
   *  permit@infinitysolarusa.com that were installerEmail-bound fields doing their job —
   *  the benchmark learn fixture had used the installer address as project A's contact
   *  email, so the string sat in both sets. Sensitivity is not lost: if a client value
   *  lands where B's own value belonged, that B key still surfaces under `unfilled`. */
  clientScoped: TripwireMatch[];
  /** Traces to neither set — portal vocabulary, dates, values this sweep cannot judge. */
  unverifiable: TripwireMatch[];
  /** B keys no filled value traced to: either the form never asks, or it did not land. */
  unfilled: string[];
  /** THE DENOMINATOR. Zero leaks over zero checked fields is not a clean sweep —
   *  "scores need a denominator" is a standing lesson in this repo. */
  checkedFields: number;
}

const normalize = (v: unknown): string => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const digitsOf = (v: unknown): string => String(v ?? "").replace(/\D/g, "");

/** Parse a value that IS a quantity — optionally unit-suffixed ("7.2 kW", "200A").
 *  Anything with other words in it (an address, a model string) returns null, which is
 *  what keeps the unit-scale path off strings that merely contain digits. */
export function cleanNumber(v: unknown): number | null {
  const m = String(v ?? "").trim().match(/^\$?([0-9][0-9,]*\.?[0-9]*)\s*(kwh|kw|kva|w|watts|kilowatts|amps?|a|volts?|v)?\.?$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Is `value` a recognisable rendering of `needle`? (Formatting-tolerant, see header.) */
export function valueTraces(value: unknown, needle: unknown): boolean {
  const nv = normalize(value);
  const nn = normalize(needle);
  if (!nv || !nn) return false;
  // Verbatim (after case/punctuation): catches short exact leaks like module count "18".
  if (nv === nn) return true;
  // One is a fuller rendering of the other ("IQ8M-72-2-US" -> "IQ8M-72-2-US {240V}",
  // "Roof" -> "Roof Mounted") — but only when the shorter side is substantial enough not
  // to appear by coincidence ("72" lives inside half the numbers on any form).
  if (Math.min(nv.length, nn.length) >= 4 && (nv.includes(nn) || nn.includes(nv))) return true;
  // Same digits, different punctuation: (217) 555-0179 -> 2175550179, 16-0001 -> 160001.
  // ONLY for values with no letters: alphanumeric model names carry a digit minority that
  // collides — "IQ8PLUS-72-2-US {240V}" and "IQ8M-72-2-US {240V}" BOTH reduce to
  // "8722240", which called A's inverter and B's the same value. A letter-bearing value
  // (a meter like "ZZ73048291") is still caught by the equality/containment paths above.
  const hasLetters = /[a-z]/i.test(String(value ?? "")) || /[a-z]/i.test(String(needle ?? ""));
  if (!hasLetters) {
    const dv = digitsOf(value);
    const dn = digitsOf(needle);
    if (dv.length >= 4 && dv === dn) return true;
  }
  // Same quantity, different unit scale: 7.2 kW recorded, 7200 W typed (or the reverse).
  // BOTH sides must actually be quantities — see cleanNumber and the module-model trap.
  const numV = cleanNumber(value);
  const numN = cleanNumber(needle);
  if (numV !== null && numN !== null) {
    for (const factor of [1, 1000, 0.001, 100, 0.01]) {
      const scaled = numN * factor;
      // Two INTEGERS at factor 1 must be EQUAL: the relative tolerance exists to absorb
      // decimal rounding across unit scales (7.678 kW typed as "7680" W), and at 0.5% it
      // was calling zip 62521 and zip 62701 "the same quantity".
      if (factor === 1 && Number.isInteger(numV) && Number.isInteger(numN)) {
        if (numV === numN) return true;
        continue;
      }
      if (Math.abs(numV - scaled) < Math.max(scaled, numV) * 0.005) return true;
    }
  }
  return false;
}

/**
 * Sweep the replay's reported fills against A's tripwires and B's expected values.
 *
 * Classification is per FILLED VALUE, matched against every entry of both sets:
 *   A only -> leaked;  B only -> landed;  both -> shared (not evidence);  neither ->
 *   unverifiable. `unfilled` then lists B keys nothing traced to. Empty filled values are
 *   not classified (nothing was typed) and do not count toward the denominator.
 */
export function sweepTripwires(
  filled: FilledField[],
  aValues: Record<string, string>,
  bValues: Record<string, string>,
  /** Strings the CLIENT record itself carries (business email/phone/address, licence and
   *  docket numbers, disconnect make/model, the credential's username reference). A
   *  tripwire hit whose value traces to one of these is classified clientScoped, never
   *  leaked — that string legitimately appears on every filing this company makes. */
  clientValues: string[] = [],
): TripwireReport {
  const aEntries = Object.entries(aValues).filter(([, v]) => String(v ?? "").trim());
  const bEntries = Object.entries(bValues).filter(([, v]) => String(v ?? "").trim());
  const clientEntries = clientValues.map((v) => String(v ?? "")).filter((v) => v.trim());
  const report: TripwireReport = { landed: [], leaked: [], clientScoped: [], shared: [], unverifiable: [], unfilled: [], checkedFields: 0 };
  const bSeen = new Set<string>();
  for (const f of filled) {
    const value = String(f.value ?? "");
    if (!value.trim()) continue;
    report.checkedFields++;
    const matchedA = aEntries.filter(([, v]) => valueTraces(value, v)).map(([k]) => k);
    const matchedB = bEntries.filter(([, v]) => valueTraces(value, v)).map(([k]) => k);
    for (const k of matchedB) bSeen.add(k);
    const entry: TripwireMatch = { field: String(f.field ?? ""), value, matchedA, matchedB };
    if (matchedA.length && matchedB.length) report.shared.push(entry);
    else if (matchedA.length && clientEntries.some((cv) => valueTraces(value, cv))) report.clientScoped.push(entry);
    else if (matchedA.length) report.leaked.push(entry);
    else if (matchedB.length) report.landed.push(entry);
    else report.unverifiable.push(entry);
  }
  report.unfilled = bEntries.map(([k]) => k).filter((k) => !bSeen.has(k));
  return report;
}

/** Distinct B keys confirmed landed — the positive half of the verdict's evidence. */
export function distinctLandedKeys(report: TripwireReport): string[] {
  const keys = new Set<string>();
  for (const e of report.landed) for (const k of e.matchedB) keys.add(k);
  return [...keys].sort();
}

/**
 * The harness verdict. A leak fails outright. A pass needs POSITIVE evidence — at least
 * `minLanded` distinct B values confirmed on the portal (mirrors MIN_CONFIRMED_FIELDS in
 * replayBenchmark.ts: three is the smallest number coincidence cannot meet). Zero leaks
 * over thin evidence is "insufficient", never "pass" — a sweep that checked nothing must
 * not read as a clean bill.
 */
export function tripwireVerdict(
  report: TripwireReport,
  minLanded = 3,
): { verdict: "LEAKED" | "PASS" | "INSUFFICIENT_EVIDENCE"; reason: string } {
  if (report.leaked.length) {
    const named = report.leaked.slice(0, 3).map((l) => `${l.field} = "${l.value.slice(0, 40)}" (A's ${l.matchedA.join("/")})`).join("; ");
    return { verdict: "LEAKED", reason: `${report.leaked.length} filled value(s) trace to the LEARN project, not this one: ${named}` };
  }
  const landedKeys = distinctLandedKeys(report);
  if (landedKeys.length >= minLanded) {
    return {
      verdict: "PASS",
      reason: `${landedKeys.length} distinct B value(s) confirmed on the portal (${landedKeys.slice(0, 6).join(", ")}) and none of A's tripwires appeared, over ${report.checkedFields} checked field(s)`,
    };
  }
  return {
    verdict: "INSUFFICIENT_EVIDENCE",
    reason: `no leak found, but only ${landedKeys.length} distinct B value(s) could be confirmed (need ${minLanded}) over ${report.checkedFields} checked field(s) — not enough to call the substitution proven`,
  };
}

// ---------------------------------------------------------------------------
// What replay WOULD type, step by step — mirrored from RecipeAdapter.resolveValue.
//
// The adapter reports which field names held (fieldsVerified) but never the values (by
// design — reports must not carry PII). The values are reconstructible: a bound step types
// fieldValues[step.field] (the certified rendering for *Model keys), and an UNBOUND step
// replays its recorded literal — the exact place project A's data rides along. The
// reconstruction is deliberately simpler than resolveValue (no format hints, no array-pass
// remapping): the comparator's matching is formatting-tolerant, so a re-grouped account
// number still traces to the same project.
// ---------------------------------------------------------------------------

/** The step subset plannedFills reads — structural, so portal-bot types need not import. */
export interface PlannedStep {
  action?: string;
  field?: string;
  value?: string;
  note?: string;
  isFinalSubmit?: boolean;
}

export interface PlannedFill extends FilledField {
  source: "bound" | "certified" | "literal" | "none";
}

/** The adapter's own label for a step (fieldsVerified/unresolvedFields use the same). */
export function stepFieldName(step: PlannedStep): string {
  return String(step.note ?? step.field ?? step.action ?? "").slice(0, 60);
}

export function plannedFills(steps: PlannedStep[], fieldValues: Record<string, string>): PlannedFill[] {
  const out: PlannedFill[] = [];
  for (const step of steps ?? []) {
    const action = String(step.action ?? "");
    if (!["fill", "select", "check"].includes(action)) continue;
    if (step.isFinalSubmit) continue; // never replayed, never part of the sweep
    const field = stepFieldName(step);
    const key = String(step.field ?? "");
    if (key) {
      // The CEC-certified rendering wins for *Model keys, same as resolveValue.
      const certified = /model$/i.test(key) ? String(fieldValues[`${key}Certified`] ?? "") : "";
      if (certified) { out.push({ field, value: certified, source: "certified" }); continue; }
      const known = Object.prototype.hasOwnProperty.call(fieldValues, key);
      const bound = String(fieldValues[key] ?? "");
      if (bound) { out.push({ field, value: bound, source: "bound" }); continue; }
      // A KNOWN key with no value is an answer — blank — and replays blank. Only an
      // UNKNOWN key falls through to the recorded literal (resolveValue may still refuse
      // it as another project's data; the runner reconciles that against the adapter's
      // unresolvedFields report rather than guessing here).
      if (!known && String(step.value ?? "").trim()) {
        out.push({ field, value: String(step.value), source: "literal" });
        continue;
      }
      out.push({ field, value: "", source: "none" });
      continue;
    }
    if (String(step.value ?? "").trim()) {
      out.push({ field, value: String(step.value), source: "literal" });
      continue;
    }
    out.push({ field, value: "", source: "none" });
  }
  return out;
}
