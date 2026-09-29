/**
 * IS THE AHJ NAME A NEAR-MISS OF THE ADDRESS CITY? — one question, one predicate.
 *
 * Intake test, 2026-09-29: a plan set printed "AHJ: CITY OF SMONROE" (a typo on the drawing) for
 * an address in Monroe, OR. The parser copied it faithfully — as it must (operator ruling: "have it
 * be what it says on the plan set"; nothing here auto-corrects) — QC passed, the reviewer gate
 * approved, a permit-process lookup was queued for a jurisdiction that does not exist, and the
 * project reached ready_to_stage with nothing pending. Nothing stopped to ASK.
 *
 * The predicate: strip the jurisdiction prefix/suffix ("City of", "Town of", "Village of",
 * "Borough of", "… Township" — via codeProfiles.jurisdictionIdentity, the ONE stripper); a county
 * or parish is a different thing from the city and is never compared (Yamhill County / Newberg);
 * fold the abbreviations a drawing and an address spell differently (St./Saint, Ft/Fort, Mt/Mount)
 * and every case / punctuation / whitespace difference; then the AHJ core must be within edit
 * distance 1–2 of the city core but NOT equal (City of Monroe / Monroe is the same place). A name
 * the shared KB knows on someone's authority is not a typo, whatever its distance from the city —
 * the caller supplies that answer (isKnown), so the predicate itself reads nothing.
 *
 * What fires does NOT block on its own: qc.ts writes the critical.ahj row as a WARNING and files a
 * pending human_review_items row on the ahj field with AHJ_NEAR_MISS_ISSUE_TYPE — the existing
 * mechanism, which already holds the submit gate through isCriticalReviewItem. The operator
 * confirms (Save Edit as-is) or corrects the AHJ; a corrected name makes the check pass and QC's
 * own pass branch resolves the item.
 *
 * "IS THE AHJ STILL IN QUESTION" is a SECOND question with its own one answer — ahjNearMissPending,
 * the pending item itself. The predicate keeps firing on a confirmed name (the value is unchanged
 * and still one letter off the city), so anything that keyed the lookup / forms skip off the
 * predicate would withhold the per-job permit-process lookup and permit-side fee research for the
 * project's whole life once a person said "yes, that is the jurisdiction" (fix round 2026-09-29:
 * confirm-as-is queued nothing before Stage). Both skip sites — QC's fire-and-forget research block
 * and the chain's acquire_forms step — read the RESULTING item, never re-derive it: pending on the
 * firing run, absent the moment a person answers, so the confirm's own QC run queues the lookup.
 *
 * Kill switch: AHJ_NEAR_MISS_CHECK=off (read at call time; the test's in-file kill check uses it).
 */
import type { AppDb } from "./db";
import { jurisdictionIdentity, knownCodeProfileName } from "./codeProfiles";
import { knownKnowledgeName } from "./knowledgeBase";

/** The review item's issue type: distinct so the chain can find it, critical by default
 *  (repository.isCriticalReviewItem excludes nothing new — a pending question holds staging). */
export const AHJ_NEAR_MISS_ISSUE_TYPE = "AHJ name is a near-miss of the address city";

export interface AhjNearMiss {
  /** The AHJ's name core after stripping and folding (what was compared). */
  ahjCore: string;
  /** The address city's core after the same treatment. */
  cityCore: string;
  /** 1 or 2. */
  distance: number;
}

const MAX_DISTANCE = 2;

/** Abbreviations a title block and a postal address spell differently; folded BEFORE the distance
 *  ("Ft Worth" / "Fort Worth" is distance 2 and would otherwise fire). */
const ABBREVIATIONS: Record<string, string> = { st: "saint", ste: "sainte", ft: "fort", mt: "mount", pt: "point" };

/** "st helens" -> "sainthelens": token abbreviations expanded, then everything but [a-z0-9] dropped. */
function foldCore(core: string): string {
  return core.split(/\s+/).filter(Boolean).map((t) => ABBREVIATIONS[t] ?? t).join("").replace(/[^a-z0-9]/g, "");
}

/** Levenshtein distance, bounded: returns null as soon as the distance must exceed `max`. */
export function boundedEditDistance(a: string, b: string, max: number): number | null {
  if (Math.abs(a.length - b.length) > max) return null;
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return null;
    prev = cur;
  }
  return prev[b.length] <= max ? prev[b.length] : null;
}

/**
 * THE PREDICATE (pure). Null when the AHJ is not a near-miss of the city: either side blank (other
 * checks own blanks); the AHJ is a county / parish; the folded cores are equal; the distance is 0 or
 * above 2; a 2-edit change on a name too short for it to be a slip ("Bend" / "Bern" is a different
 * word); or `isKnown` says the name as typed, or its stripped core, is a jurisdiction the KB knows.
 * `isKnown` is consulted LAST, only for an actual near-miss, so the caller's reads cost nothing on
 * the ordinary project.
 */
export function ahjCityNearMiss(
  ahj: string,
  city: string,
  state: string,
  isKnown?: (name: string) => boolean,
): AhjNearMiss | null {
  const ahjName = String(ahj || "").trim();
  const cityName = String(city || "").trim();
  if (!ahjName || !cityName) return null;
  const a = jurisdictionIdentity(ahjName, state);
  const c = jurisdictionIdentity(cityName, state);
  if (a.type === "county" || a.type === "parish") return null;
  const ahjCore = foldCore(a.core);
  const cityCore = foldCore(c.core);
  if (!ahjCore || !cityCore || ahjCore === cityCore) return null;
  const distance = boundedEditDistance(ahjCore, cityCore, MAX_DISTANCE);
  if (distance == null || distance < 1) return null;
  if (distance * 2 >= Math.max(ahjCore.length, cityCore.length)) return null;
  if (isKnown && (isKnown(ahjName) || isKnown(a.core))) return null;
  return { ahjCore, cityCore, distance };
}

/** Is this name — as typed — a jurisdiction the shared KB knows on someone's authority (a verified
 *  row, an official / reference source, the shipped code-profile reference)? Both halves are exact
 *  key reads in the table's own module; never the fuzzy resolvers. */
export function knownJurisdictionName(db: AppDb, state: string, name: string): boolean {
  return knownKnowledgeName(db, state, name) || knownCodeProfileName(db, state, name);
}

/** The predicate with the KB answer supplied — what QC consults. Read-only. */
export function ahjNearMissForProject(db: AppDb, project: { state: string; ahj: string; city: string }): AhjNearMiss | null {
  if (process.env.AHJ_NEAR_MISS_CHECK === "off") return null;
  return ahjCityNearMiss(project.ahj, project.city, project.state, (name) => knownJurisdictionName(db, project.state, name));
}

/**
 * IS THE AHJ STILL IN QUESTION — a pending near-miss item on the ahj field (the one QC files). The
 * ONE read for every site that waits on the answer (QC's lookup / fee-research skip, the chain's
 * acquire_forms step). False once a person answered (edited / approved / rejected) even though the
 * predicate still fires on the confirmed value — a person's answer is what lifts the skip, so the
 * confirm's own QC run queues the lookup. Also false when the predicate fired but no item could be
 * filed because a person had already answered an earlier ahj item (a value a person typed is theirs).
 * Read-only.
 */
export function ahjNearMissPending(db: AppDb, projectId: string): boolean {
  try {
    return Boolean(db.get<{ one: number }>(
      "SELECT 1 AS one FROM human_review_items WHERE project_id = ? AND field_name = 'ahj' AND issue_type = ? AND status = 'pending' LIMIT 1",
      [projectId, AHJ_NEAR_MISS_ISSUE_TYPE],
    ));
  } catch {
    return false;
  }
}

/** The review item's message: names both values and asks — never a correction. */
export function ahjNearMissMessage(ahj: string, city: string, state: string, miss: AhjNearMiss): string {
  const where = [city, state].filter(Boolean).join(", ");
  const n = miss.distance === 1 ? "one letter" : "two letters";
  return `The AHJ "${ahj}" is ${n} away from the address city "${city}" (${where}) and is not a jurisdiction on file — is it the right one? `
    + `A typo on the drawing would file the permit with a jurisdiction that does not exist. The plan-set value is kept as read, never auto-corrected: `
    + `confirm it in Human Review (Save Edit as-is) or correct it there.`;
}
