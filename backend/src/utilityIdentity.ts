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
//   - PacifiCorp = "Pacific Power" | "PacifiCorp" | "Rocky Mountain Power", in a state PacifiCorp
//     serves (OR, WA, CA, UT, ID, WY). Never "Pacific" alone.
//   - Portland General Electric = "Portland General (Electric)" | "PGE", on an OREGON job only.
// An unknown state is not a match: an unknown never reads as the Oregon answer.
import { usStateCode } from "./permitPath";

export type KnownPowerClerkUtility = "pacificorp" | "portland_general";

/** The states PacifiCorp serves (Pacific Power: OR, WA, CA; Rocky Mountain Power: UT, ID, WY). */
export const PACIFICORP_STATES: ReadonlySet<string> = new Set(["OR", "WA", "CA", "UT", "ID", "WY"]);
const PACIFICORP_NAME = /\bpacific\s*power\b|\bpacificorp\b|\brocky\s*mountain\s*power\b/i;
const PORTLAND_GENERAL_NAME = /\bportland\s+general\b|\bpge\b/i;

/** The known PowerClerk utility this (state, utility name) IS, or null. */
export function knownPowerClerkUtility(input: { state?: unknown; utility?: unknown }): KnownPowerClerkUtility | null {
  const name = String(input.utility ?? "").trim();
  if (!name) return null;
  const st = usStateCode(input.state);
  if (!st) return null;
  if (PACIFICORP_NAME.test(name) && PACIFICORP_STATES.has(st)) return "pacificorp";
  if (PORTLAND_GENERAL_NAME.test(name) && st === "OR") return "portland_general";
  return null;
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
