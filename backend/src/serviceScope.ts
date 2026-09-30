// ---------------------------------------------------------------------------
// DOES THIS PLAN SET'S SCOPE INCLUDE A MAIN PANEL / SERVICE UPGRADE?
//
// ONE ANSWER. It used to be three identical private copies (submittalTracks: the
// MPU permit track; reviewerEngine: the MPU permit callout; applicationDocs: the
// packet's MPU line), and it is now also the question the electrical fee lines ask
// ("Service 0-200 amps (qty)" on an Accela electrical record, the Oregon
// "Services or feeders" row on the PDF application). Four readers, one regex: a
// job cannot be an MPU to the track list and not an MPU to the fee box.
//
// A LEAF on purpose: batteryServiceFeeder (itself a leaf imported by
// feeBracketFields and feeSchedules) reads it, and applicationDocs kept its own copy
// only "to avoid a circular import with submittalTracks".
//
// Keyed on UPGRADE language, not "derate" — a 705.12 remedy that is not itself a
// service upgrade.
// ---------------------------------------------------------------------------

/** The snapshot fields the scope is read from — the design's own words, never a
 *  value this system derived (a generated work description would read its own
 *  output back). */
const MPU_SCOPE_FIELDS = [
  "projectDescriptionText", "description", "scopeText", "electricalCalcText",
  "sitePlanNotesText", "mpu", "serviceUpgrade",
] as const;

const MPU_SCOPE = /\bmpu\b|main panel upgrade|main service panel upgrade|service (panel )?upgrade|\bmsp upgrade\b|panel upgrade|meter.?main upgrade/;

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/** The scope text the predicate reads, lower-cased (for the amps reader below). */
export function mpuScopeText(snapshot: Record<string, unknown> | null | undefined): string {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  return MPU_SCOPE_FIELDS.map((k) => text(s[k])).join(" ").toLowerCase();
}

/** THE predicate, on a parser snapshot. */
export function snapshotHasMpuScope(snapshot: Record<string, unknown> | null | undefined): boolean {
  return MPU_SCOPE.test(mpuScopeText(snapshot));
}

/** THE predicate, on a project. */
export function hasMpuScope(project: { parserSnapshot?: unknown } | null | undefined): boolean {
  return snapshotHasMpuScope((project?.parserSnapshot ?? null) as Record<string, unknown> | null);
}

/** A rating in amps: "200", "200A", "200 amps", "200A (2 of 2)" → 200. Anything that is
 *  not a plain amperage reads as unknown, never as a number it might be. */
function amps(value: unknown): number | null {
  const m = /^\s*(\d{2,4})(?:\.0+)?\s*(?:a|amps?|amperes?)?\b/i.exec(text(value));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** THE SERVICE SIZE a service upgrade leaves behind, in amps — the number the fee
 *  schedule's service tier (0-200 / 201-400 …) is read by. null when nobody knows.
 *
 *  NOT the bus rating: "a new 225A main bus with a 200A main breaker" is a 200 A
 *  service on a 225 A bus, and it is billed in the 0-200 tier. normalize.ts fills
 *  mainServiceRating from busRating when nothing better was parsed, so that key is
 *  trusted only when it is NOT merely the bus rating's copy. Order:
 *    1. the amps the upgrade sentence itself names for the main ("… 200A MAIN BREAKER"),
 *       the LAST one stated ("from a 100A main breaker to a 200A main breaker" is 200);
 *    2. mainBreaker (the parser's "main breaker / main service rating");
 *    3. mainServiceRating, when it is not the bus rating repeated;
 *    4. a bus rated <= 200 A (a main is never larger than its bus);
 *    5. otherwise unknown. */
export function serviceAmps(snapshot: Record<string, unknown> | null | undefined): number | null {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const scope = mpuScopeText(s);
  const stated = Array.from(scope.matchAll(/(?<!\d)(\d{2,4})\s*-?\s*a(?:mps?|mperes?)?\.?\s+(?:new\s+)?main\s+(?:breaker|disconnect|service|ocpd)/g)).pop();
  if (stated) {
    const n = Number(stated[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const main = amps(s.mainBreaker);
  if (main != null) return main;
  const bus = amps(s.busRating);
  const rating = amps(s.mainServiceRating);
  if (rating != null && (bus == null || rating !== bus)) return rating;
  if (bus != null && bus <= 200) return bus;
  return null;
}
