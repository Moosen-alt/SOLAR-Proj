// WHICH UTILITY IS THIS — for the two whose PowerClerk tenants this codebase knows by heart.
//
// Leak sweep 2026-09-28 (unknown-as-fact-utility-regex-foreign-powerclerk +
// oregon-defaults-pacific-regex-seeds-pacificorp-portal). Bare /PACIFIC/ and /PGE/ name regexes
// decided "this is PacifiCorp / Portland General" in six places, with no state: a California job for
// "Pacific Gas and Electric Company" (or typed "PGE", the common spelling of PG&E) and a Washington
// job for "Pacific County PUD" were given PacifiCorp's / Portland General's PowerClerk as the
// utility's OWN portal — learnFromProject wrote it into the shared KB, hostFitsTrackAndEntity then
// accepted it, and NEM staging launched it under the client's login. QC meanwhile blocked every
// PG&E job on "Pacific Power meter photo missing".
//
// ONE anchored, state-gated answer, asked at every door (knowledgeBase portalFromProject /
// projectDocs, applicationDocs, reviewerEngine addUtilityFindings, baselineRules,
// utilityFilingLookup.knownOregonNemUtility, the v41 cleanup):
//   - PacifiCorp = "Pacific Power" | "Pac Power" | "PacifiCorp" | "Rocky Mountain Power" |
//     "Rocky Mtn Power", in a state PacifiCorp serves (OR, WA, CA, UT, ID, WY); "RMP" in UT/ID/WY.
//     Never "Pacific" alone.
//   - Portland General Electric = "Portland General (Electric)" | "Portland GE" | "PGE" | "P.G.E.",
//     on an OREGON job only.
// The NAME-MATCHING predicates (sameUtilityEntity / provablyDifferentUtility) ask a wider,
// still state-aware identity (utilityIdentityOf) that also knows PG&E — never a portal decision.
// An unknown state is not a match: an unknown never reads as the Oregon answer.
import { usStateCode } from "./permitPath";

export type KnownPowerClerkUtility = "pacificorp" | "portland_general";

/** The states PacifiCorp serves (Pacific Power: OR, WA, CA; Rocky Mountain Power: UT, ID, WY). */
export const PACIFICORP_STATES: ReadonlySet<string> = new Set(["OR", "WA", "CA", "UT", "ID", "WY"]);
/** Rocky Mountain Power's own states — where the bare "RMP" means it. */
const ROCKY_MOUNTAIN_POWER_STATES: ReadonlySet<string> = new Set(["UT", "ID", "WY"]);
// PacifiCorp runs ONE PowerClerk tenant for both of its brands, so every brand spelling is the one
// identity: "Pacific Power" / "Pac Power", "PacifiCorp", "Rocky Mountain Power" / "Rocky Mtn Power".
const PACIFICORP_NAME = /\bpacific\s*power\b|\bpac\s*power\b|\bpacificorp\b|\brocky\s*(?:mountain|mtn\.?)\s*power\b/i;
const RMP_NAME = /\brmp\b/i;
// On an OREGON job: "Portland General (Electric)", "Portland GE", and the bare acronym "PGE" / "P.G.E."
// (outside Oregon the bare acronym is PG&E's common spelling — see utilityIdentityOf).
const PORTLAND_GENERAL_NAME = /\bportland\s+general\b|\bportland\s+g\.?\s*e\b|\bp\.?\s*g\.?\s*e\b/i;

/** The known PowerClerk utility this (state, utility name) IS, or null. */
export function knownPowerClerkUtility(input: { state?: unknown; utility?: unknown }): KnownPowerClerkUtility | null {
  const name = String(input.utility ?? "").trim();
  if (!name) return null;
  const st = usStateCode(input.state);
  if (!st) return null;
  if (PACIFICORP_NAME.test(name) && PACIFICORP_STATES.has(st)) return "pacificorp";
  if (RMP_NAME.test(name) && ROCKY_MOUNTAIN_POWER_STATES.has(st)) return "pacificorp";
  if (PORTLAND_GENERAL_NAME.test(name) && st === "OR") return "portland_general";
  return null;
}

/** The identities the name-matching predicates know: the two PowerClerk utilities, plus PG&E — which
 *  files on no PowerClerk this codebase knows (so it is NOT a KnownPowerClerkUtility and never picks a
 *  portal), but whose names collide with both of theirs ("Pacific …", "PGE"). */
export type UtilityIdentity = KnownPowerClerkUtility | "pacific_gas_electric";
// PG&E's unambiguous spellings — the full name and the ampersand forms (PG&E, P.G.&E.) — in any state.
const PACIFIC_GAS_ELECTRIC_NAME = /\bpacific\s+gas\s*(?:and|&)\s*electric\b|\bp\.?\s*g\.?\s*(?:&|and)\s*e\b/i;
// The bare acronym, which is PG&E's spelling in CALIFORNIA and Portland General's in Oregon.
const BARE_PGE_ACRONYM = /\bp\.?\s*g\.?\s*e\b/i;
// "Portland General" spelled out is Portland General in any state (only the bare acronym is ambiguous).
const PORTLAND_GENERAL_FULL_NAME = /\bportland\s+general\b/i;

/**
 * WHICH UTILITY THIS NAME IS, for the NAME-MATCHING questions only (sameUtilityEntity /
 * provablyDifferentUtility) — never a portal decision (that is knownPowerClerkUtility's, above,
 * and stays state-gated to the utility's own states). STATE-AWARE: an unknown state is no answer,
 * and the bare acronym "PGE" is Portland General in Oregon, PG&E in California, nobody elsewhere.
 * The unambiguous spellings (PG&E's full name / ampersand forms, "Portland General" spelled out)
 * are known in any known state, so an empty-state KB row named "PG&E" can never answer an Oregon
 * "Portland General Electric" job, and vice versa.
 */
export function utilityIdentityOf(state: unknown, name: unknown): UtilityIdentity | null {
  const n = String(name ?? "").trim();
  if (!n) return null;
  const st = usStateCode(state);
  if (!st) return null;
  const known = knownPowerClerkUtility({ state: st, utility: n });
  if (known) return known;
  if (PACIFIC_GAS_ELECTRIC_NAME.test(n)) return "pacific_gas_electric";
  if (st === "CA" && BARE_PGE_ACRONYM.test(n)) return "pacific_gas_electric";
  if (PORTLAND_GENERAL_FULL_NAME.test(n)) return "portland_general";
  return null;
}

/**
 * ARE THESE TWO NAMES THE SAME UTILITY, HERE? True only when both resolve to the same known
 * identity in this state (a parent company and its operating brands — "PacifiCorp" = "Pacific
 * Power" in Oregon, "RMP" = "Rocky Mountain Power" in Utah; "PGE" = "Portland General Electric" in
 * Oregon). An unknown name, an unknown state, or a state the identity does not serve is NOT a
 * match: not provable is not the same.
 *
 * Why it exists (dry run 2026-09-28, B9): the plan set said "UTILITY: PACIFICORP", the KB and every
 * recipe say "Pacific Power", and the name scorer (knowledgeNameMatchScore) scores that pair 0 —
 * "power" is a stopword and neither contains the other. So the recipe, KB, fee and filing-lookup
 * keys forked by spelling. The alias fallbacks (portalRecipes.findRecipeByNameAlias, the KB's
 * findKnowledgeByName) ask this BEFORE the fuzzy score; an exact key still wins over both.
 */
export function sameUtilityEntity(state: unknown, a: unknown, b: unknown): boolean {
  const ia = utilityIdentityOf(state, a);
  return ia !== null && ia === utilityIdentityOf(state, b);
}

/**
 * PROVABLY NOT the same utility, here: BOTH names are known identities in this (known) state and
 * they differ. The fuzzy scorer strips "gas", "electric" and "power" as stopwords, so "Pacific Gas
 * and Electric" vs "Pacific Power" scored 65 — a California PG&E job resolved PacifiCorp's KB row.
 *
 * BOTH, never one (converge 2026-09-28): a name the identity does not recognise is not proof of a
 * different utility — it is the fuzzy scorer's question. The one-side rule zeroed every short-name
 * bridge CLAUDE.md relies on ("RMP" -> "Rocky Mountain Power", "P.G.E." -> "Portland General
 * Electric") because only the legal name was a known identity. Unknown state: false.
 */
export function provablyDifferentUtility(state: unknown, a: unknown, b: unknown): boolean {
  const ia = utilityIdentityOf(state, a);
  const ib = utilityIdentityOf(state, b);
  return ia !== null && ib !== null && ia !== ib;
}
export const isPacifiCorp = (input: { state?: unknown; utility?: unknown }): boolean => knownPowerClerkUtility(input) === "pacificorp";
export const isPortlandGeneral = (input: { state?: unknown; utility?: unknown }): boolean => knownPowerClerkUtility(input) === "portland_general";

/** The interconnection PowerClerk tenants these two utilities file on (their portal-ENTRY URLs — the
 *  application lives behind the login, not on the marketing / resource-library pages). */
export const KNOWN_POWERCLERK_PORTALS: Record<KnownPowerClerkUtility, { portalName: string; portalUrl: string; host: string; owner: string }> = {
  pacificorp: { portalName: "Pacific Power Customer Generation Portal", portalUrl: "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login", host: "pacificorpnetmetering.powerclerk.com", owner: "PacifiCorp (Pacific Power / Rocky Mountain Power)" },
  portland_general: { portalName: "PowerClerk", portalUrl: "https://pgenm.powerclerk.com/MvcAccount/Login", host: "pgenm.powerclerk.com", owner: "Portland General Electric" },
};

/** The known utility whose PowerClerk tenant this host is, or null. */
export function knownTenantOwner(host: string): KnownPowerClerkUtility | null {
  const h = String(host ?? "").trim().toLowerCase().replace(/^www\./, "");
  for (const [k, v] of Object.entries(KNOWN_POWERCLERK_PORTALS) as Array<[KnownPowerClerkUtility, typeof KNOWN_POWERCLERK_PORTALS[KnownPowerClerkUtility]]>) {
    if (h === v.host) return k;
  }
  return null;
}

/**
 * IS THIS KNOWN TENANT PROVABLY ANOTHER UTILITY'S? Returns the tenant's owner (display name) when
 * `host` is PacifiCorp's or Portland General's PowerClerk and the utility `entity` is provably NOT
 * that utility (a known state, and the one identity says it is someone else); null otherwise —
 * including when the state is unknown and the name does match the owner (not provable either way).
 */
export function foreignKnownTenant(host: string, entity: { state?: unknown; utility?: unknown }): string | null {
  const owner = knownTenantOwner(host);
  if (!owner) return null;
  const identity = knownPowerClerkUtility(entity);
  if (identity === owner) return null;
  const nameMatchesOwner = owner === "pacificorp" ? PACIFICORP_NAME.test(String(entity.utility ?? "")) : PORTLAND_GENERAL_NAME.test(String(entity.utility ?? ""));
  if (!usStateCode(entity.state) && nameMatchesOwner) return null;
  return KNOWN_POWERCLERK_PORTALS[owner].owner;
}
