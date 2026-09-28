import type { PortalRecipe, PortalRecipeStatus, ProjectRecord, RecipeStep } from "../../shared/src/types";
import { createHash } from "node:crypto";
import { addAuditLog } from "./audit";
import { clientLicenceNumbersForClient, clientStagingOverlay, kindForSlot, LICENCE_OVERLAY_KEYS, licenceJobState, licenceOverlayForClient } from "./clients";
import { GENERIC_LICENCE_EXPIRY_KEY, GENERIC_LICENCE_NUMBER_KEY, licenceKeyForKind, licenceKeyInfo } from "../../shared/src/licenceKinds";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { asJson, bool, parseJson, text as s } from "./json";
import { knowledgeProfileKey, knowledgeNameMatchScore, isJunkEntityName, isVerifiedKnowledge } from "./knowledgeBase";
import { ahjLooksLikeHostname } from "./codeProfiles";
import {
  hostFitsTrackAndEntity, portalHostOf, recipeDisciplineForTrack, recipeDisciplineFromSteps, recipeRecordTypeFromSteps,
  samePortal, scopeForTrack, trackSafeUrl, isInformationalPageUrl, isPermitPlatformUrl,
  type HostFit, type PortalEntity, type PortalUrlSource,
} from "./portalChannel";
import { isHarnessAbort, looksBotBlocked } from "./runAbort";
import { certifiedModelFor } from "./cecEquipment";
import { nowIso } from "./time";
import { sameRecordType } from "./permitProcess";
import { parseStreetNumber, parseStreetName, parseStreetLine } from "../../portal-bot/src/addressParse";
import { feeBracketFieldForLabel, feeBracketQuantityFields } from "./feeBracketFields";
import { FEE_BRACKET_FIELD_PREFIX } from "../../portal-bot/src/feeBracketQuantity";
import { filingValuationText } from "./valuation";
import { planSetDisconnectPart, standardDisconnectConflicts } from "./baselineRules";
import { clientCompanyFactFields } from "./clients";
import { COMPANY_IDENTIFIER_KEY, companyFactStamp, isCompanyAttestationStep, isCompanyIdentityLabel, looksLikePlaceholderIdentifier } from "../../shared/src/companyFacts";
import { usStateCode } from "./permitPath";
import { provablyDifferentUtility, sameUtilityEntity } from "./utilityIdentity";
import { labelWords } from "../../shared/src/portalSafety";
import { mountAdjective, mountKindForProject } from "./codeReviewRules";

type Row = Record<string, unknown>;


/** A recipe as the API returns it: the shared PortalRecipe plus the keep-and-flag flag (operator
 *  ruling 2026-09-24: a replay failure nobody can attribute keeps the recipe and FLAGS it for a
 *  human — a flag nobody can see is no flag). Kept here, not in shared types (owned elsewhere). */
export type PortalRecipeWithFlag = PortalRecipe & {
  /** Why a human is asked to look ("" when nothing is flagged). Raised by demoteOnReplayFailure
   *  (unattributed failure) and the restore script; cleared by clearPortalRecipeFlag. */
  flagReason: string;
  flaggedAt: string | null;
};

function mapRecipe(row: Row): PortalRecipeWithFlag {
  return {
    flagReason: s(row.flag_reason),
    flaggedAt: row.flagged_at ? s(row.flagged_at) : null,
    id: s(row.id),
    scopeType: s(row.scope_type) === "utility" ? "utility" : "ahj",
    profileKey: s(row.profile_key),
    state: s(row.state),
    ahj: s(row.ahj),
    utility: s(row.utility),
    portalPlatform: s(row.portal_platform),
    portalUrl: s(row.portal_url),
    status: (["recording", "complete", "needs_rerecord"].includes(s(row.status)) ? s(row.status) : "recording") as PortalRecipeStatus,
    version: Number(row.version ?? 1),
    steps: parseJson<RecipeStep[]>(s(row.steps_json) || "[]", []),
    loginStep: row.login_step_json ? parseJson(s(row.login_step_json), undefined) : undefined,
    createdBy: s(row.created_by),
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
    notes: s(row.notes),
    // bool() (not Boolean()) — a string "0" cell must read as false, never as trusted.
    autoSubmitEnabled: bool(row.auto_submit_enabled),
    discipline: s(row.discipline),
  };
}

// ---------------------------------------------------------------------------
// NOTES ARE THE ONLY EVIDENCE THE NEXT SESSION GETS.
//
// A recipe's notes column carries the failure taxonomy everything downstream reasons
// from — "Auto-learn paused: mfa_captcha", "Auto-learn did not stage cleanly", the
// portal's own validation text, and the "Required field(s) left blank" finding that
// promoteRecordingIfEligible refuses to promote past. The stale-recording sweep
// OVERWROTE that whole column with one sentence about the sweep, so the row that most
// needed explaining reached the next session explaining nothing.
//
// Notes are " | "-joined SEGMENTS (CLAUDE.md). Merge by SEGMENT, never by blob, or the
// same sentence re-appends on every sweep tick (the runaway-notes bug the KB already hit).
// ---------------------------------------------------------------------------
export function recipeNoteSegments(value: unknown): string[] {
  return String(value ?? "").split(" | ").map((seg) => seg.trim()).filter(Boolean);
}

/** Append `incoming` to `existing` as segments, deduped case-insensitively, oldest first. */
export function mergeRecipeNotes(existing: unknown, incoming: unknown, limit = 40): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seg of [...recipeNoteSegments(existing), ...recipeNoteSegments(incoming)]) {
    const key = seg.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seg);
    if (out.length >= limit) break;
  }
  return out.join(" | ");
}

/**
 * Merge one TAGGED segment in, replacing any segment already carrying that tag.
 *
 * Plain segment-dedupe is not enough for a note that carries a value — "[recording
 * interrupted — no activity since 2026-09-09T22:01Z]" is a different string on every sweep
 * tick, so dedupe sees a new fact each time and the column grows without bound. That is the
 * runaway-notes bug wearing a different hat; it was caught by the fixture that sweeps twice.
 * One segment per tag: the newest statement of a fact replaces the previous one, and every
 * OTHER segment — the paused reason, the required-blank finding, the portal's validation
 * text — is untouched.
 */
export function upsertRecipeNote(existing: unknown, tag: string, segment: string, limit = 40): string {
  const prefix = `[${tag.toLowerCase()}`;
  const kept = recipeNoteSegments(existing).filter((seg) => !seg.toLowerCase().startsWith(prefix));
  return mergeRecipeNotes(kept.join(" | "), segment, limit);
}

// ---------------------------------------------------------------------------
// WHOSE STEPS ARE IN prev_steps_json?
//
// restoreRecipeSnapshotIfAbandoned calls them "the previous WORKING recipe" and hands
// them back as status 'complete'. startPortalRecording, however, snapshotted the outgoing
// steps of ANY row it reset — draft, paused, never-verified, anything. So an unproven
// draft could be parked in a slot whose only reader treats it as proven, and a crashed
// re-record then promoted it to a replayable recipe with nobody's verification behind it.
//
// It is not hypothetical: on the live DB, the Ameren Illinois NEM recipe (da3544a8) and
// the Coos Bay structural recipe (e965c645) are both status 'complete' with notes that
// still read "Auto-learned but NOT verified" — one of them also carrying the required-blank
// finding — next to "[re-record abandoned — restored the previous working recipe]".
//
// The snapshot now says what it is. The marker is written by the same statement that
// writes the snapshot and dropped by every statement that clears it, so it can never
// describe a different payload than the one present. A row with NO marker (every recipe
// learned before this change) is treated as unproven — the safe direction: its steps are
// still restored, it just lands at needs_rerecord instead of being silently trusted.
// ---------------------------------------------------------------------------
const PREV_SNAPSHOT_MARKER_RE = /\s*\[prev-recipe:[^\]]*\]/gi;
const prevSnapshotMarker = (status: string, version: number): string =>
  `[prev-recipe: ${status === "complete" ? "proven" : `unproven ${status || "recording"}`} v${version}]`;
/** True when this row's snapshot was taken from a recipe that had earned 'complete'. */
export function snapshotIsProven(notes: unknown): boolean {
  return /\[prev-recipe:\s*proven/i.test(String(notes ?? ""));
}
const stripPrevMarker = (notes: unknown): string => String(notes ?? "").replace(PREV_SNAPSHOT_MARKER_RE, "").trim();
const carriedPrevMarker = (notes: unknown): string => (String(notes ?? "").match(PREV_SNAPSHOT_MARKER_RE) ?? [])[0]?.trim() ?? "";

/** Fills, selects and checks — the steps that actually put data into a form, and the only
 *  depth measure available on both a stored snapshot and a freshly-saved recording.
 *  Deliberately duplicated from autoLearn.substantiveStepCount rather than imported:
 *  autoLearn imports THIS module, and the reverse import would close a cycle. */
function recipeDepth(steps: Array<{ action?: unknown }> | undefined): number {
  return (steps ?? []).filter((st) => ["fill", "select", "check"].includes(String(st?.action ?? ""))).length;
}

// Split a US phone into the three boxes segmented portal controls use (Accela renders
// area / prefix / line as separate inputs). Emitted as derived substitution keys so a
// recorded segment step binds to a KEY rather than freezing the learn project's number.
export function phoneSegmentKeys(base: string, raw: string): Record<string, string> {
  const digits = String(raw || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (digits.length < 10) return {};
  return {
    [`${base}Area`]: digits.slice(0, 3),
    [`${base}Prefix`]: digits.slice(3, 6),
    [`${base}Line`]: digits.slice(6, 10),
  };
}

export function recipeProfileKey(input: { scopeType: "ahj" | "utility"; state?: string; ahj?: string; utility?: string }): string {
  // AHJ recipes key on state|ahj|utility; utility recipes key on the utility only
  // (ahj empty) so they match any AHJ in that utility territory.
  return input.scopeType === "utility"
    ? knowledgeProfileKey({ state: input.state, ahj: "", utility: input.utility })
    : knowledgeProfileKey({ state: input.state, ahj: input.ahj, utility: input.utility });
}

export function listPortalRecipes(db: AppDb): PortalRecipeWithFlag[] {
  return db.query<Row>("SELECT * FROM portal_recipes ORDER BY updated_at DESC").map(mapRecipe);
}

export function getPortalRecipe(db: AppDb, recipeId: string): PortalRecipeWithFlag {
  const row = db.get<Row>("SELECT * FROM portal_recipes WHERE id = ?", [recipeId]);
  if (!row) throw new HttpError(404, "Portal recipe not found.");
  return mapRecipe(row);
}

// Recipes are keyed per AHJ PER DISCIPLINE: Oregon solar files a city/structural permit
// AND a county/electrical one for the same project, and their portal steps differ
// (different jurisdiction row, different record type). An exact discipline match wins; a
// LEGACY row (discipline '', learned before the dimension existed) is accepted as a
// fallback so existing recipes keep replaying — the staging discipline gate still refuses
// one whose recorded steps belong to the other discipline.
// NAME-ALIAS FALLBACK for the recipe key. The profile key is built from the utility/AHJ
// string as the PROJECT spells it, so a portal learned under one spelling is invisible to a
// project that uses another. Measured on the live DB: the trusted 60-step PGE recipe is
// keyed "or|unknown|pge", but a real PGE project stores "Portland General Electric" and
// therefore resolved to NO complete recipe — every NEM stage re-learned the portal from
// scratch instead of replaying, and the second key quietly accumulated its own draft
// (v11). Same for "Pacific Power". This reuses the KB's own scorer, which already bridges
// operator short names to legal names ("PGE" -> "Portland General Electric" scores 78).
// EXACT KEY ALWAYS WINS (CLAUDE.md); this only runs when the exact key finds nothing.
const NAME_ALIAS_MIN_SCORE = 78;
function findRecipeByNameAlias(
  db: AppDb,
  input: { scopeType: "ahj" | "utility"; state?: string; ahj?: string; utility?: string; discipline?: string },
  requireComplete: boolean,
): PortalRecipeWithFlag | null {
  const wanted = s(input.scopeType === "utility" ? input.utility : input.ahj).trim();
  if (!wanted) return null;
  // A state-less project is exactly where a wrong-portal replay could slip through, since
  // the state guard below can only compare states it has. Fuzzy needs both sides known.
  if (!s(input.state).trim()) return null;
  const discipline = s(input.discipline);
  const rows = db.query<Row>(
    `SELECT * FROM portal_recipes WHERE scope_type = ?${requireComplete ? " AND status = 'complete'" : ""}
       AND (discipline = ? OR discipline = '') ORDER BY updated_at DESC`,
    [input.scopeType, discipline],
  );
  let best: { row: Row; score: number } | null = null;
  for (const row of rows) {
    // Never cross states — a same-named utility in another state is a different portal.
    const rowState = s(row.state);
    if (!rowState || rowState.toLowerCase() !== s(input.state).trim().toLowerCase()) continue;
    // The one utility identity first (utilityIdentity — "PacifiCorp" IS "Pacific Power" in Oregon,
    // which the fuzzy scorer scores 0; "Pacific Gas and Electric" is provably not), then the fuzzy score.
    const utilityScope = input.scopeType === "utility";
    const score = utilityScope && sameUtilityEntity(input.state, wanted, s(row.utility))
      ? 100
      : utilityScope && provablyDifferentUtility(input.state, wanted, s(row.utility))
        ? 0
        : knowledgeNameMatchScore(wanted, s(utilityScope ? row.utility : row.ahj));
    if (score >= NAME_ALIAS_MIN_SCORE && (!best || score > best.score)) best = { row, score };
  }
  return best ? mapRecipe(best.row) : null;
}

export function findCompleteRecipeForProject(
  db: AppDb,
  input: { scopeType: "ahj" | "utility"; state?: string; ahj?: string; utility?: string; discipline?: string },
): PortalRecipeWithFlag | null {
  const key = recipeProfileKey(input);
  const discipline = s(input.discipline);
  const row = db.get<Row>(
    `SELECT * FROM portal_recipes
      WHERE profile_key = ? AND status = 'complete' AND (discipline = ? OR discipline = '')
      ORDER BY CASE WHEN discipline = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
    [key, discipline, discipline],
  );
  return row ? mapRecipe(row) : findRecipeByNameAlias(db, input, true);
}

// Like findCompleteRecipeForProject, but matches a recipe of ANY status (recording / needs_rerecord
// / complete), newest first. Used by staging to recover a launchable portal URL even before a recipe
// is verified-complete: a draft/recording recipe still carries the entry URL the operator (or a prior
// auto-learn pass) pointed the recorder at. Without it, a real portal whose only recipe is still a
// draft has no URL to launch and the self-seed can't fire — staging silently falls to the no-op mock.
export function findAnyRecipeForProject(
  db: AppDb,
  input: { scopeType: "ahj" | "utility"; state?: string; ahj?: string; utility?: string; discipline?: string },
): PortalRecipeWithFlag | null {
  const key = recipeProfileKey(input);
  const discipline = s(input.discipline);
  // Discipline-scoped for the same reason as above. Critically, this is what the learn
  // path calls to decide whether a trusted recipe already exists: unscoped, an ELECTRICAL
  // learn would see the STRUCTURAL recipe, "preserve" it, and silently discard its own
  // pass — the other half of the one-recipe-per-AHJ ceiling.
  const row = db.get<Row>(
    `SELECT * FROM portal_recipes
      WHERE profile_key = ? AND (discipline = ? OR discipline = '')
      ORDER BY CASE WHEN discipline = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
    [key, discipline, discipline],
  );
  return row ? mapRecipe(row) : findRecipeByNameAlias(db, input, false);
}

// ---------------------------------------------------------------------------
// WHOSE PORTAL IS THIS? The evidence hostFitsTrackAndEntity (portalChannel) judges a URL by.
//
// Built from the two shared tables that name portals: portal_recipes (every status — a draft
// still says where its entity files) and permit_utility_knowledge. Only claims that pass the
// track half of rule 5 count (a PowerClerk URL parked on an AHJ row is the poisoning, not a
// claim), only rows that name a real entity (the learn benchmark keyed rows on the portal HOST —
// "Benchmark aca-prod.accela.com" — which is no jurisdiction), and only rows pinned to a state
// (a same-named AHJ in another state is a different entity). Names are merged with the KB's own
// alias scorer, so "PGE" and "Portland General Electric" are ONE owner, never "two entities
// sharing a portal".
// ---------------------------------------------------------------------------
const ENTITY_ALIAS_MIN_SCORE = 78;
/**
 * JUNK A REFERENCE IMPORT LEFT IN THE AHJ COLUMN CLAIMS NO PORTAL (resolution skeptic MF4). On
 * production 'OR portal (OR)' + 'ROSEBURG (OR)' made roseburgor.portal.opengov.com read as SHARED
 * (two owners → fits any Oregon AHJ), while '1 - 5 DAYS (OR)' was the sole owner of Medford's
 * portal and '2-5 days / REV 3-8 days …' of Washington County's — a real Medford project would
 * have been refused its own portal as foreign. isJunkEntityName (knowledgeBase) catches bare
 * state names and digits; these are the other shapes a spreadsheet's process columns leak:
 *   - "<state> portal" / "<state> website" / "… login" — a column header, not a jurisdiction;
 *   - a turnaround ("1 - 5 DAYS", "2-5 days / REV 3-8 days") — a DIGIT with a time unit (a
 *     digit is required: "Days Creek" is a city);
 *   - a platform ("SolarAPP+") and placeholders ("n/a", "online", "varies", "see notes").
 * Judged here (the portal evidence), not at the import, which is another workstream's door.
 */
export function looksLikePortalJunkName(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  // A SPREADSHEET SENTENCE NAMES NO ENTITY (close MF4-class). Production aae50fab (AZ) holds
  // 'FIRE PERMIT: 3 kW – 15 kW submit for permit via email NON SOLARAPP+ SUBMITTALS:' in the AHJ
  // column; on a host nobody else claims it would be the SOLE owner, and every real AZ city would
  // be refused that portal as another entity's. The shapes, none of which a jurisdiction's or a
  // utility's name takes:
  //   - a label — a word followed by ':' ("ELECTRICAL PERMIT:");
  //   - an electrical quantity — a number with a unit ("3 kW", "15 kW", "200 amps", "240 volts");
  //   - submission instructions — "submit…", "submittals", "via email" (NOT bare "email":
  //     'Tomball (emailed for link to portal)' is Tomball, with a note);
  //   - a sentence — ten or more words in the NAME ITSELF, i.e. before any parenthetical note or
  //     " — department" suffix ("No permit required unless there is a derate, MPU, battery or
  //     demand manager. App", production e26e5b17). The longest real names run to nine ("Unified
  //     Government of Wyandotte County and Kansas City, Kansas"), and production's
  //     "Cook County, IL (unincorporated) — Dept. of Building and Zoning" is three before its suffix.
  if (/[a-z)]\s*:/i.test(n)) return true;
  if (/\b\d+(?:\.\d+)?\s*(?:kw|kwh|kwdc|kwac|kva|mw|mwh|watts?|amps?|volts?|vac|vdc)\b/i.test(n)) return true;
  if (/\bsubmit(?:s|tals?|ted|ting)?\b|\bvia\s+e-?mail\b/i.test(n)) return true;
  const core = n.replace(/\([^)]*\)/g, " ").split(/\s[—–-]\s/)[0];
  if (core.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length >= 10) return true;
  if (/^(?:[a-z]{2}|[a-z]+)\s+(?:portal|website|web ?site|site|link|url|login|log-?in|e-?permitting)\s*$/i.test(n)) return true;
  if (/\d/.test(n) && /\b(?:days?|weeks?|hours?|hrs?|business\s+days?|rev)\b/i.test(n)) return true;
  if (/^solar\s*app\+?$/i.test(n)) return true;
  if (/^(?:n\/?a|none|null|tbd|tba|varies|online|portal|email|e-?mail|paper|in person|unknown|see\s+(?:notes?|below|above))\s*$/i.test(n)) return true;
  return false;
}
function isRealEntityName(name: string): boolean {
  return Boolean(name.trim()) && !isJunkEntityName(name) && !ahjLooksLikeHostname(name) && !looksLikePortalJunkName(name);
}
/** A trailing state code is spelling, not identity: "Tigard, OR" is "Tigard". */
function entityNameCore(name: string): string {
  return name.trim().replace(/,\s*[A-Za-z]{2}\.?$/, "").replace(/\s+[A-Z]{2}$/, "").trim();
}
function sameEntity(stateA: string, nameA: string, stateB: string, nameB: string): boolean {
  const sa = stateA.trim().toLowerCase();
  const sb = stateB.trim().toLowerCase();
  const score = knowledgeNameMatchScore(entityNameCore(nameA), entityNameCore(nameB));
  if (!sa || !sb) return sa === sb && score === 100;
  return sa === sb && score >= ENTITY_ALIAS_MIN_SCORE;
}
/** "Generic Oregon ePermitting AHJ" names a SHARED portal (the statewide one), not an entity. */
function declaresSharedPortal(name: string): boolean {
  return /^generic\b/i.test(name.trim());
}

export function portalEntityEvidence(
  db: AppDb,
  input: {
    scope: "ahj" | "utility"; state?: string; name?: string;
    /** Recipes under judgment: a recipe is never evidence for itself (a mis-keyed recipe would
     *  otherwise make its own wrong host "this entity's portal"). */
    excludeRecipeIds?: string[];
  },
): PortalEntity | null {
  const scope = input.scope === "utility" ? "utility" : "ahj";
  const name = s(input.name).trim();
  const state = s(input.state).trim();
  if (!name) return null;
  const excluded = new Set((input.excludeRecipeIds ?? []).filter(Boolean));
  const trackForScope = scope === "utility" ? "nem" : "permit";
  type Claim = { url: string; state: string; name: string; verified: boolean };
  const claims: Claim[] = [];
  // UTILITY scope: a permit-platform portal named by the utility's OWN human-verified record
  // (a municipal utility whose NEM application lives in the city's permit portal). Kept apart —
  // it is not a claim on the portal for anyone else, and only hostFitsTrackAndEntity's one
  // carve-out reads it.
  const verifiedPermitPlatform: Claim[] = [];
  const add = (url: unknown, rowState: unknown, rowName: unknown, verified: boolean, fromKbRow = false) => {
    const u = s(url).trim();
    const n = s(rowName).trim();
    const st = s(rowState).trim();
    if (!portalHostOf(u) || !isRealEntityName(n) || !st) return;
    // An information page (a help/guide page, a PDF) is nobody's portal — a junk recipe saved on
    // BCD's help page must not make oregon.gov "City of Jefferson's own portal".
    if (isInformationalPageUrl(u)) return;
    if (!trackSafeUrl(trackForScope, u)) {
      if (scope === "utility" && verified && fromKbRow && isPermitPlatformUrl(u)) verifiedPermitPlatform.push({ url: u, state: st, name: n, verified });
      return;
    }
    claims.push({ url: u, state: st, name: n, verified });
  };
  for (const row of db.query<Row>(
    "SELECT id, state, ahj, utility, portal_url FROM portal_recipes WHERE scope_type = ? AND portal_url IS NOT NULL AND portal_url != ''",
    [scope],
  )) {
    if (excluded.has(s(row.id))) continue;
    add(row.portal_url, row.state, scope === "utility" ? row.utility : row.ahj, false);
  }
  // KB: AHJ rows for the AHJ scope; UTILITY-KEYED rows (no AHJ) for the utility scope — an AHJ
  // row's utility column says which utility serves the city, not where the utility files.
  // Both columns: reference imports file the link in portal_name, and one row had both inverted.
  const kbRows = db.query<Row>(
    scope === "utility"
      ? `SELECT * FROM permit_utility_knowledge WHERE (ahj IS NULL OR ahj = '') AND utility != ''
           AND ((portal_url IS NOT NULL AND portal_url != '') OR portal_name LIKE 'http%')`
      : `SELECT * FROM permit_utility_knowledge WHERE ahj IS NOT NULL AND ahj != ''
           AND ((portal_url IS NOT NULL AND portal_url != '') OR portal_name LIKE 'http%')`,
  );
  for (const row of kbRows) {
    const verified = isVerifiedKnowledge(row);
    const rowName = scope === "utility" ? row.utility : row.ahj;
    add(row.portal_url, row.state, rowName, verified, true);
    add(row.portal_name, row.state, rowName, verified, true);
  }
  const own = claims.filter((c) => sameEntity(state, name, c.state, c.name));
  const sharedPortals = [...new Set(claims.filter((c) => declaresSharedPortal(c.name)).map((c) => c.url))];
  // Other owners, alias-merged within a state. The label is the first spelling seen.
  const owners: Array<{ state: string; name: string; label: string }> = [];
  const otherClaims: Array<{ url: string; owner: string }> = [];
  for (const c of claims) {
    if (own.includes(c) || declaresSharedPortal(c.name)) continue;
    let owner = owners.find((o) => sameEntity(o.state, o.name, c.state, c.name));
    if (!owner) {
      owner = { state: c.state, name: c.name, label: `${c.name} (${c.state.toUpperCase()})` };
      owners.push(owner);
    }
    otherClaims.push({ url: c.url, owner: owner.label });
  }
  return {
    scope,
    state,
    name,
    ownPortals: [...new Set(own.map((c) => c.url))],
    verifiedPortals: [...new Set(own.filter((c) => c.verified).map((c) => c.url))],
    otherClaims,
    sharedPortals,
    verifiedPermitPlatformPortals: [...new Set(verifiedPermitPlatform.filter((c) => sameEntity(state, name, c.state, c.name)).map((c) => c.url))],
  };
}

/**
 * THE ROUTE EDGE: refuse an operator-supplied portal URL that does not fit (409, never a silent
 * launch). A track conflict is rule 5 and has no override. Another entity's portal, or one that
 * disagrees with the portal a person verified for this entity, is refused with the way through:
 * save the portal on the entity's own KB profile (verified) — that is the confirmation.
 */
export function assertOperatorPortalUrlFits(
  db: AppDb,
  input: { track: string | null | undefined; state?: string; name?: string; url: string; excludeRecipeIds?: string[] },
): void {
  const url = s(input.url).trim();
  if (!url) return;
  const scope = scopeForTrack(input.track);
  const entity = portalEntityEvidence(db, { scope, state: input.state, name: input.name, excludeRecipeIds: input.excludeRecipeIds });
  const fit = hostFitsTrackAndEntity(input.track, entity, url, "operator");
  if (fit.fits) return;
  const who = s(input.name).trim() || (scope === "utility" ? "this utility" : "this AHJ");
  throw new HttpError(409,
    `${url} was refused: ${fit.reason}. `
    + (fit.code === "track_conflict"
      ? `Use the ${scope === "utility" ? "utility's interconnection" : "AHJ's permit"} portal for this track.`
      : `If ${who} really files there, save that portal on ${who}'s knowledge-base profile (verified) and try again.`),
    { hostRefused: true, code: fit.code, portalUrl: url });
}

/** Every portal a recipe drives: its entry URL and each goto step's URL. */
export function recipePortalUrls(recipe: { portalUrl?: string; steps?: RecipeStep[] }): string[] {
  const urls = [s(recipe.portalUrl).trim()];
  for (const st of recipe.steps ?? []) {
    if (st?.action === "goto" && /^https?:\/\//i.test(s(st.value).trim())) urls.push(s(st.value).trim());
  }
  return urls.filter(Boolean);
}

/** Does this recipe fit the track and the entity — its entry URL AND every portal it navigates
 *  to (a Tigard EnerGov recipe carried a goto to aca-oregon.accela.com)? The first misfit. */
export function recipeHostFit(
  track: string | null | undefined,
  entity: PortalEntity | null,
  recipe: { portalUrl?: string; steps?: RecipeStep[] },
): HostFit & { url: string } {
  const urls = recipePortalUrls(recipe);
  if (!urls.length) return { fits: true, code: "ok", reason: "the recipe names no portal URL", url: "" };
  for (const u of urls) {
    const fit = hostFitsTrackAndEntity(track, entity, u, "recipe");
    if (!fit.fits) return { ...fit, url: u };
  }
  return { fits: true, code: "ok", reason: "every portal the recipe drives fits", url: urls[0] };
}

// ---------------------------------------------------------------------------
// STATEWIDE / SHARED-PORTAL REUSE (operator ruling 2026-09-24).
//
// One portal instance often serves many jurisdictions: aca-oregon.accela.com files for every
// subscribing Oregon city, MyGovernmentOnline for dozens of Texas and Louisiana towns, a county
// iWorQ for its cities. Keying recipes per jurisdiction meant every city on such a portal
// started from scratch (Salem's learn reached review 1 time in 11; Lincoln City never did)
// while a complete recipe for the SAME portal and the SAME application sat one row away.
//
// THE RULE (an engine rule, not an Accela patch). When an entity has no complete recipe of its
// own, a COMPLETE recipe learned for ANOTHER entity may replay for it when ALL of these hold:
//   - same scope (never across tracks), same state;
//   - the target's OWN resolved portal (its KB row, draft, or statewide fallback — never the
//     donor's URL) is the same portal as the donor's entry, and every portal the donor navigates
//     to is that portal too (never across hosts, never across tenants of a path-tenanted host);
//   - same discipline, exactly (a legacy '' row never lends), and the donor's recorded record
//     type is a choice of that discipline (never across record types). A donor that never
//     recorded its record type cannot prove it files the same application, so it never lends;
//   - if the target itself ever recorded a record type on this portal, the donor's is the same;
//     if two donors would lend DIFFERENT record types, nobody lends (we cannot tell which is the
//     target's);
//   - the donor is not flagged for a human, and its URL fits the target entity (hostFits…).
// Per-project and per-entity fields bind from the TARGET project at replay (resolveRecipeFieldValues);
// the choice is recorded on the run and shown; drift stops the run; the run stops at review.
//
// THE UTILITY (NEM) SCOPE NEVER BORROWS. A utility's application program is its own tariff
// program, and nothing in a project says which program on a shared host the target utility
// uses — so "same program" can never be established, and two utilities on one host with
// different programs must not cross. Trackless stages (no discipline) never borrow either.
// ---------------------------------------------------------------------------
export interface BorrowedRecipeChoice {
  recipe: PortalRecipeWithFlag;
  learnedFor: string;
  learnedForState: string;
  portalHost: string;
  recordType: string;
  discipline: string;
}
export interface BorrowDecision {
  choice: BorrowedRecipeChoice | null;
  reason: string;
  rejected: Array<{ recipeId: string; learnedFor: string; why: string }>;
}

export function findBorrowableRecipe(
  db: AppDb,
  input: {
    track: string | null | undefined;
    state?: string;
    ahj?: string;
    utility?: string;
    /** The TARGET entity's own resolved portal URL, and where it came from. */
    targetPortalUrl: string;
    targetSource?: PortalUrlSource;
    entity: PortalEntity | null;
    /** The record type the per-job lookup found for THIS AHJ's permit (permitProcess). A donor
     *  filing a different record type never lends; "" = the lookup did not find one. */
    targetRecordType?: string;
  },
): BorrowDecision {
  const none = (reason: string, rejected: BorrowDecision["rejected"] = []): BorrowDecision => ({ choice: null, reason, rejected });
  if (scopeForTrack(input.track) === "utility") return none("a utility (NEM) recipe is never borrowed: the target's program cannot be established");
  const discipline = recipeDisciplineForTrack(input.track);
  if (!discipline) return none("a stage with no permit discipline never borrows");
  const state = s(input.state).trim();
  const ahj = s(input.ahj).trim();
  if (!state || !ahj) return none("the project has no state or AHJ to borrow for");
  const target = s(input.targetPortalUrl).trim();
  if (!portalHostOf(target)) return none("the AHJ has no portal of its own on file, so there is no portal to match a recipe to");
  // The target's portal must fit the target. Every donor URL must then be THAT portal (checked
  // per donor below), so a donor can only ever drive a portal the target itself resolved to.
  const targetFit = hostFitsTrackAndEntity(input.track, input.entity, target, input.targetSource ?? "kb");
  if (!targetFit.fits) return none(`the AHJ's own portal does not fit: ${targetFit.reason}`);

  // What the target itself ever recorded as its record type on this portal (any status).
  const ownTypes = new Set(
    db.query<Row>("SELECT * FROM portal_recipes WHERE scope_type = 'ahj' AND discipline = ?", [discipline])
      .filter((r) => sameEntity(state, ahj, s(r.state), s(r.ahj)) && samePortal(s(r.portal_url), target))
      .map((r) => recipeRecordTypeFromSteps(parseJson<RecipeStep[]>(s(r.steps_json) || "[]", [])).toLowerCase())
      .filter(Boolean),
  );

  const rejected: BorrowDecision["rejected"] = [];
  const eligible: BorrowedRecipeChoice[] = [];
  const rows = db.query<Row>(
    `SELECT * FROM portal_recipes WHERE scope_type = 'ahj' AND status = 'complete' AND discipline = ?
      ORDER BY updated_at DESC, version DESC`,
    [discipline],
  );
  for (const row of rows) {
    const donor = mapRecipe(row);
    const learnedFor = donor.ahj;
    if (sameEntity(state, ahj, donor.state, donor.ahj)) continue; // its own (found by the exact lookup, or deliberately dropped)
    if (!isRealEntityName(learnedFor)) continue; // benchmark rows keyed on a hostname are no jurisdiction
    const reject = (why: string) => { rejected.push({ recipeId: donor.id, learnedFor: `${learnedFor} (${donor.state})`, why }); };
    if (donor.state.trim().toLowerCase() !== state.toLowerCase()) continue; // other states are not candidates at all
    if (!samePortal(donor.portalUrl, target)) continue; // other portals are not candidates at all
    if (s(row.flag_reason).trim()) { reject(`flagged for a human: ${s(row.flag_reason).slice(0, 80)}`); continue; }
    const leaves = recipePortalUrls(donor).find((u) => !samePortal(u, target));
    if (leaves) { reject(`it navigates off the portal to ${portalHostOf(leaves) || leaves}`); continue; }
    const recordType = recipeRecordTypeFromSteps(donor.steps);
    if (!recordType) { reject("it never recorded which record type it files, so it cannot prove it is the same application"); continue; }
    const stepsDiscipline = recipeDisciplineFromSteps(donor.steps);
    const typeFits = discipline === "electrical" || discipline === "structural"
      ? stepsDiscipline === discipline
      : stepsDiscipline === null;
    if (!typeFits) { reject(`its record type "${recordType}" is not a ${discipline} application`); continue; }
    const lookedUpType = s(input.targetRecordType).trim();
    if (lookedUpType && !sameRecordType(lookedUpType, recordType)) {
      reject(`its record type "${recordType}" differs from the one the per-job lookup found for ${ahj} ("${lookedUpType}")`);
      continue;
    }
    if (ownTypes.size && !ownTypes.has(recordType.toLowerCase())) {
      reject(`its record type "${recordType}" differs from the one ${ahj} recorded (${[...ownTypes].join(", ")})`);
      continue;
    }
    eligible.push({ recipe: donor, learnedFor, learnedForState: donor.state, portalHost: portalHostOf(target), recordType, discipline });
  }
  if (!eligible.length) return none(rejected.length ? "no recipe on this portal qualifies" : "no complete recipe for this portal and discipline exists", rejected);
  const types = new Set(eligible.map((e) => e.recordType.toLowerCase()));
  if (types.size > 1) {
    return none(`recipes on this portal file different record types (${[...new Set(eligible.map((e) => e.recordType))].join(" / ")}) — which one is ${ahj}'s cannot be told`, rejected);
  }
  return { choice: eligible[0], reason: `learned for ${eligible[0].learnedFor} on the same portal and record type`, rejected };
}

// Start (or reset) a recording for a portal. Creates a 'recording' stub keyed by
// profile_key; if a recipe already exists for that key, bumps the version and clears
// the steps so the admin re-records cleanly (used for "delete & re-record").
export function startPortalRecording(
  db: AppDb,
  input: {
    scopeType: "ahj" | "utility"; state?: string; ahj?: string; utility?: string; portalPlatform?: string; portalUrl?: string; createdBy?: string; discipline?: string;
    /** The row the CALLER already resolved as this entity's recipe (autoLearn: findAnyRecipeForProject,
     *  the same answer it protects a trusted recipe by). Reset in place instead of the exact-key row —
     *  a learn under a variant spelling ("PacifiCorp" vs the recipe's "Pacific Power") must write the
     *  row it resolved, not insert a duplicate shared recipe beside it (dry run 2026-09-28, B9). Ignored
     *  unless that row is this scope, this state, and this discipline (or a legacy '' row). */
    existingRecipeId?: string | null;
  },
): PortalRecipe {
  const scopeType = input.scopeType === "utility" ? "utility" : "ahj";
  if (scopeType === "ahj" && !s(input.ahj).trim()) throw new HttpError(400, "ahj is required for an AHJ recipe.");
  if (scopeType === "utility" && !s(input.utility).trim()) throw new HttpError(400, "utility is required for a utility recipe.");
  // A utility recipe is keyed by utility ONLY (it replays for any AHJ in that utility's
  // territory), so it must NOT carry the originating project's AHJ city — otherwise it
  // gets mislabeled as a city ("PGE shown as City of Dayton"). Null out ahj for utility.
  const ahj = scopeType === "utility" ? "" : s(input.ahj);
  const key = recipeProfileKey(input);
  // Scoped to THIS discipline: an electrical learn must not reset the AHJ's structural
  // recipe (or vice versa). A legacy row (discipline '') is adopted by the first learn
  // that claims a discipline, so the existing recipe is upgraded in place rather than
  // orphaned beside a duplicate.
  const discipline = scopeType === "utility" ? "" : s(input.discipline);
  // A wrong-row reset is worse than a duplicate: the resolved row is taken only when it is
  // provably this recipe's slot — same scope, same state, same (or legacy) discipline.
  const resolved = s(input.existingRecipeId)
    ? db.get<Row>("SELECT * FROM portal_recipes WHERE id = ?", [s(input.existingRecipeId)])
    : undefined;
  const resolvedFits = Boolean(resolved)
    && s(resolved!.scope_type) === scopeType
    && s(resolved!.state).trim().toLowerCase() === s(input.state).trim().toLowerCase() && Boolean(s(input.state).trim())
    && (s(resolved!.discipline) === discipline || s(resolved!.discipline) === "");
  // A legacy '' row resolved while ITS key already holds this discipline's own row: that row is the
  // slot (adopting the legacy one would collide on UNIQUE(profile_key, discipline)).
  const resolvedSlot = resolvedFits && s(resolved!.discipline) !== discipline
    ? db.get<Row>("SELECT * FROM portal_recipes WHERE profile_key = ? AND discipline = ?", [s(resolved!.profile_key), discipline]) ?? resolved
    : resolvedFits ? resolved : undefined;
  const existing = resolvedSlot ?? db.get<Row>(
    `SELECT * FROM portal_recipes WHERE profile_key = ? AND (discipline = ? OR discipline = '')
      ORDER BY CASE WHEN discipline = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
    [key, discipline, discipline],
  );
  const now = nowIso();
  if (existing) {
    const nextVersion = Number(existing.version ?? 1) + 1;
    // Snapshot the outgoing steps BEFORE wiping so an abandoned re-record can be
    // rolled back to the last working recipe (see restoreRecipeSnapshotIfAbandoned).
    // Only a non-empty step list overwrites the snapshot — re-recording twice in a
    // row must not clobber a good snapshot with the empty stub of attempt one.
    const outgoingSteps = parseJson<RecipeStep[]>(s(existing.steps_json) || "[]", []);
    // STAMP WHAT THE SNAPSHOT IS, in the same write that takes it. Only a snapshot that
    // is actually being REPLACED gets a new marker: when the outgoing steps are empty the
    // snapshot is left alone (re-recording twice in a row must not clobber attempt one's
    // good snapshot with attempt two's empty stub), so its marker must be left alone too.
    const nextNotes = outgoingSteps.length
      ? `${stripPrevMarker(existing.notes)} ${prevSnapshotMarker(s(existing.status), Number(existing.version ?? 1))}`.trim()
      : s(existing.notes);
    db.run(
      `UPDATE portal_recipes SET status = 'recording', version = ?, steps_json = '[]',
         prev_steps_json = CASE WHEN ? != '' THEN ? ELSE prev_steps_json END,
         portal_platform = COALESCE(NULLIF(?, ''), portal_platform),
         portal_url = COALESCE(NULLIF(?, ''), portal_url),
         flag_reason = '', flagged_at = NULL, auto_submit_enabled = 0,
         discipline = ?, notes = ?, updated_at = ? WHERE id = ?`,
      [nextVersion,
        outgoingSteps.length ? s(existing.steps_json) : "", outgoingSteps.length ? s(existing.steps_json) : "",
        s(input.portalPlatform), s(input.portalUrl), discipline, nextNotes, now, s(existing.id)],
    );
    return getPortalRecipe(db, s(existing.id));
  }
  const recipeId = id();
  db.run(
    `INSERT INTO portal_recipes
      (id, scope_type, profile_key, state, ahj, utility, portal_platform, portal_url, status, version, steps_json, created_by, created_at, updated_at, notes, discipline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recording', 1, '[]', ?, ?, ?, '', ?)`,
    [recipeId, scopeType, key, s(input.state), ahj, s(input.utility), s(input.portalPlatform), s(input.portalUrl), s(input.createdBy), now, now, discipline],
  );
  return getPortalRecipe(db, recipeId);
}

// Roll an ABANDONED re-record back to the last working recipe. Called by the
// stale-recording sweep: if the stub still holds a pre-re-record snapshot, the
// portal gets its proven steps back as 'complete' (the bot can replay again)
// instead of being stranded with no recipe at 'needs_rerecord'.
//
// A STALE RECORDING IS NOT EVIDENCE OF SUCCESS.
//
// This was the widest of the four ways round the trust gate. It restored ANY snapshot as
// 'complete' — the one status that makes a recipe replay unattended on real filings — on
// the strength of a run that DIED. Nothing here asked whether the steps it was promoting
// had ever reached a review screen, filled a required field, or been looked at by a human,
// because prev_steps_json was assumed to hold a proven recipe and (until the marker written
// by startPortalRecording) it held whatever the last reset happened to wipe.
//
// What a stale recording SHOULD become, and why:
//   - snapshot marked PROVEN (the row was 'complete' when the re-record wiped it) →
//     'complete'. That is the case this function was built for: a portal that had a
//     working recipe yesterday must not be left with none because a re-record crashed.
//     Nothing is being trusted that was not already trusted.
//   - snapshot present but UNPROVEN, or unmarked (every recipe that predates the marker) →
//     the steps are restored, because depth is information and losing it costs the next
//     session its map of the portal — but the status is 'needs_rerecord'. It surfaces for a
//     human, and it does not replay. A crashed run cannot be the thing that grants trust.
//
// Returns which status the row landed in, or null when there was nothing to restore.
export function restoreRecipeSnapshotIfAbandoned(db: AppDb, recipeId: string): "complete" | "needs_rerecord" | null {
  const row = db.get<Row>("SELECT * FROM portal_recipes WHERE id = ?", [recipeId]);
  if (!row || s(row.status) !== "recording") return null;
  const snapshot = parseJson<RecipeStep[]>(s(row.prev_steps_json) || "[]", []);
  if (!snapshot.length) return null;
  const proven = snapshotIsProven(row.notes);
  // WHICH STEPS SURVIVE. A PROVEN snapshot always wins — it is a working recipe and the whole
  // point of the rollback is to hand it back. An UNPROVEN one is just an older capture, and
  // the abandoned attempt may well have got FURTHER: live, the Lynn MA row was about to have
  // its 4-fill capture overwritten by the 3-fill snapshot underneath it. Neither replays, so
  // the only thing at stake is how much of the portal we still have a record of — keep more.
  const live = parseJson<RecipeStep[]>(s(row.steps_json) || "[]", []);
  const steps = proven || recipeDepth(snapshot) >= recipeDepth(live) ? snapshot : live;
  // The snapshot is consumed either way, so its marker goes with it — a marker that
  // outlived its payload would describe the NEXT snapshot wrongly.
  const base = stripPrevMarker(row.notes);
  const note = proven
    ? "[re-record abandoned — restored the previous working recipe]"
    : "[re-record abandoned — the previous steps were restored, but they had never been verified, so this needs a re-record rather than a promotion]";
  db.run(
    `UPDATE portal_recipes SET steps_json = ?, status = ?, structure_sig = ?, prev_steps_json = NULL, auto_submit_enabled = 0,
       notes = ?, updated_at = ? WHERE id = ? AND status = 'recording'`,
    [asJson(steps), proven ? "complete" : "needs_rerecord", recipeStructureSignature(steps),
      mergeRecipeNotes(base, note), nowIso(), recipeId],
  );
  return proven ? "complete" : "needs_rerecord";
}

// A stable fingerprint of a recipe's STRUCTURE — the ordered shape of its steps
// (action + selector identity), deliberately excluding any filled values. Two
// recordings of the same portal flow hash the same; a portal that adds/removes/renames
// a field changes the hash. Stored at save time as the baseline a future pre-flight
// drift check (or a re-record) can compare a freshly-observed structure against.
export function recipeStructureSignature(steps: RecipeStep[]): string {
  const shape = (Array.isArray(steps) ? steps : []).map((step) => {
    const sel = step.selector || {};
    // Identity = action + the most stable selector handle available (name/text/css),
    // never the value, so the signature tracks structure, not a project's data.
    return [step.action, sel.name || sel.text || sel.css || "", step.field || ""].join("|");
  });
  return fnv1a(shape.join("\n"));
}

/**
 * THE STEPS A REPLAY READ — every field of every step, selectors included, as a canonical
 * (sorted-key) serialization. This is what a replay's heal and demotion are measured against
 * (trust skeptic M3, close M3-selectors): the version guard cannot see a human step edit
 * (savePortalRecipeSteps — the PUT …/steps route and appendHumanPatchSteps — does not bump the
 * version), so a step inserted mid-replay shifted every index and the heal for "City" landed on
 * "Owner"; and a human who re-pointed ONE selector mid-replay had the heal overwrite the fix and
 * the drift on the OLD selector demote the fixed recipe. So nothing is left out.
 *
 * A run's OWN heal also rewrites a selector — so the replay does not compare the demotion against
 * the steps it started with once it has healed: persistHealedSteps returns the signature of the
 * steps it WROTE (computed from what it wrote, never re-read — a re-read would absorb a human edit
 * landing in the gap), and the demotion is measured against that. A run that heals step 2 and then
 * drifts at step 7 still demotes; a human edit before or after the heal spares the recipe.
 */
export function recipeStepsSignature(steps: RecipeStep[]): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  const text = JSON.stringify(canonical(Array.isArray(steps) ? steps : []));
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

// Cheap deterministic 32-bit hash (FNV-1a) — no crypto import needed for a fingerprint.
function fnv1a(joined: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * THE SAVE GUARD FOR COMPANY IDENTITY (leak sweep 2026-09-28, company-leak-3). An UNBOUND free-text
 * literal under a company-identity label (companyFacts.isCompanyIdentityLabel — insurer, policy,
 * bond, HIC/CSL/CCB/UBI registration, website, title, supervising/master electrician, contractor /
 * company / business, the contractor's split street) is the learn company's answer. The binder had
 * its chance to bind it to a key (insuranceCarrier, installerStreetNumber, ccbLicenseNumber…); what
 * is still a literal is never persisted into a recipe every company replays: the value is dropped
 * and the step replays BLANK, named for a person (step.operatorItem). Bound, sensitive and
 * closed-vocabulary steps are untouched.
 */
/** Stamp each company ATTESTATION step (companyFacts.isCompanyAttestationStep) with the opaque stamp
 *  of the client whose job recorded it, so replay answers it only for that client's own jobs
 *  (recipeReplayBinding R8). No client: nothing stamped — the step is then always left for a person. */
export function stampCompanyAttestations(steps: RecipeStep[], clientId: string | null | undefined): RecipeStep[] {
  const stamp = companyFactStamp(clientId);
  if (!stamp) return steps ?? [];
  return (steps ?? []).map((st) => (isCompanyAttestationStep(st) && !st.companyFactOf ? { ...st, companyFactOf: stamp } : st));
}

/** A licence number as a comparable token: upper-cased, separators dropped. A token must carry a digit
 *  and be long enough to identify something — "Yes", "1", "12" are never licences. */
function licenceToken(value: string): string {
  const full = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return full.length >= 4 && /\d/.test(full) ? full : "";
}
/** The forms a LICENCE ON FILE is recognised in: its full token, and its bare digits when a board
 *  prefix leads ("ROC 444222" is also typed "444222"). Only the licence side is expanded — a recorded
 *  value is compared by its full token, so a parcel "R700888" never collides with a CCB "700888". */
function licenceOnFileForms(number: string): string[] {
  const full = licenceToken(number);
  if (!full) return [];
  const bare = full.replace(/^[A-Z]+/, "");
  return bare !== full && bare.length >= 5 && /\d/.test(bare) ? [full, bare] : [full];
}
export const LICENCE_LITERAL_OPERATOR_ITEM = "company licence — the recorded answer was the learn company's own licence number, so the shared recipe leaves this box for a person";
/**
 * THE LEARN COMPANY'S LICENCE NEVER STAYS A LITERAL (licences skeptic L1 — the operator's "infinity
 * license on kin projects"). A recorded free-text FILL whose value equals ANY licence the learn job's
 * client holds — any state, any kind, the named columns and the typed entries, compared normalised —
 * is that company's number, whatever the box is called ("ROC #", "TECL #", "Reg. No."). The binder
 * had its chance to bind it to this job's key; what is still a literal is withheld (value dropped,
 * step.operatorItem named — never the value itself), the same shape as
 * withholdCompanyIdentityLiterals. A SELECT is closed vocabulary and stays recipeReplayBinding R8's:
 * a licence OPTION is stamped with the learn company and replays only on that company's own jobs.
 * Run where the learn client is known: the auto-learn binding pass (every save path) and the
 * human-patch merge.
 */
export function withholdClientLicenceLiterals(steps: RecipeStep[], licenceNumbers: string[]): { steps: RecipeStep[]; withheld: number } {
  const known = new Set((licenceNumbers ?? []).flatMap(licenceOnFileForms));
  if (!known.size) return { steps: steps ?? [], withheld: 0 };
  let withheld = 0;
  const out = (steps ?? []).map((st) => {
    if (!st || st.action !== "fill" || st.field || st.sensitive || !String(st.value ?? "").trim()) return st;
    const token = licenceToken(String(st.value));
    if (!token || !known.has(token)) return st;
    withheld++;
    const next: RecipeStep = { ...st, operatorItem: LICENCE_LITERAL_OPERATOR_ITEM };
    delete next.value;
    return next;
  });
  return { steps: out, withheld };
}
/** withholdClientLicenceLiterals for a job's client, read by id (steps unchanged with no client). */
export function withholdClientLicenceLiteralsFor(db: AppDb, steps: RecipeStep[], clientId: string | null | undefined): RecipeStep[] {
  return withholdClientLicenceLiterals(steps, clientLicenceNumbersForClient(db, clientId)).steps;
}

export function withholdCompanyIdentityLiterals(steps: RecipeStep[]): { steps: RecipeStep[]; withheld: number } {
  let withheld = 0;
  const out = (steps ?? []).map((st) => {
    if (!st || st.action !== "fill" || st.field || st.sensitive || !String(st.value ?? "").trim()) return st;
    const label = [st.selector?.label, st.selector?.name, st.selector?.placeholder, st.note].filter(Boolean).join(" ");
    if (!isCompanyIdentityLabel(label)) return st;
    withheld++;
    const next: RecipeStep = { ...st, operatorItem: "company identity — the recorded answer was one company's, so the shared recipe leaves this box for a person" };
    delete next.value;
    return next;
  });
  return { steps: out, withheld };
}

// Save the recorded steps (called by the recorder when the admin finishes, and by every
// auto-learn terminal path). The STATUS is the thing that decides whether a recipe replays
// unattended on real filings, so it is only ever changed by a caller that says so.
//
// THE DEFAULT USED TO PROMOTE. `options.status ?? (steps.length ? "complete" : "recording")`
// meant any caller that forgot the argument published the recipe: the PUT
// /api/portal-recipes/:id/steps route passes `req.body?.status` straight through, so a
// client that sent steps and no status promoted a mid-recording stub to replayable, and
// repository.ts's self-heal writer (which only ever means "same recipe, repaired selectors")
// relied on the recipe already being complete for its save not to change meaning.
//
// The safe default is the recipe's CURRENT status: saving steps is not a verdict, so on its
// own it must move nothing in either direction. That also keeps the self-heal writer exactly
// as correct as it was — a complete recipe stays complete — without touching that file.
// Promotion now has three explicit doors and no accidental one: an explicit status here,
// finishPortalRecipe (the operator's "Recording looks right"), and promoteRecordingIfEligible
// (the submit-observed signal, which enforces its own bar).
export function savePortalRecipeSteps(
  db: AppDb,
  recipeId: string,
  steps: RecipeStep[],
  options: { status?: PortalRecipeStatus; notes?: string } = {},
): PortalRecipe {
  const current = getPortalRecipe(db, recipeId); // 404 if missing
  const status = options.status ?? current.status;

  // DEPTH IS INFORMATION, AND A SAVE THAT HAS NOT EARNED TRUST MUST NOT SHRINK A RECIPE.
  //
  // startPortalRecording wipes the live steps before the new run's outcome is known and parks
  // them in prev_steps_json. Every auto-learn terminal path then saves whatever THIS run
  // managed, however little — and on 2026-09-09 that was a benchmark run the harness killed at
  // 660 seconds, whose 18-fill fragment replaced Miami's 39-fill draft. autoLearn's own
  // shouldKeepDeeperDraft guards the two failure paths and calls itself the fix, but the PAUSE
  // path and the untrusted-success path never consulted it, and neither does the PUT route or
  // any future caller. The invariant belongs here, where every writer passes through:
  //
  //   a save that is not 'complete' may never reduce the number of fills/selects/checks
  //   the row already had.
  //
  // 'complete' is exempt on purpose — a verified recipe is a verdict about THESE steps, and an
  // operator re-recording a portal that genuinely got simpler must be able to shorten it.
  // prev_steps_json is deliberately NOT cleared here: if the snapshot was proven, the stale
  // sweep must still be able to hand the portal back its 'complete' status.
  const snapshot = parseJson<RecipeStep[]>(
    s(db.get<Row>("SELECT prev_steps_json FROM portal_recipes WHERE id = ?", [recipeId])?.prev_steps_json) || "[]", []);
  const incoming = steps ?? [];
  const shallower = status !== "complete" && recipeDepth(snapshot) > recipeDepth(incoming);
  // A SHARED RECIPE NEVER CARRIES ONE COMPANY'S IDENTITY AS A LITERAL (leak sweep 2026-09-28) — the
  // invariant lives here, where every writer passes, and applies to whichever steps are kept.
  const finalSteps = withholdCompanyIdentityLiterals(shallower ? snapshot : incoming).steps;
  const depthNote = shallower
    ? `[kept the deeper recording: this save carried ${recipeDepth(incoming)} filled field(s), the row already had ${recipeDepth(snapshot)}]`
    : "";

  // A recording that lands 'complete' supersedes the pre-re-record snapshot, so drop it —
  // and drop the marker describing it, which must never outlive its payload.
  const clearsSnapshot = status === "complete";
  // Stripped on BOTH branches: appendHumanPatchSteps rebuilds its notes FROM recipe.notes and
  // passes them back in, so a marker left in the body would be re-appended beside itself.
  const body = stripPrevMarker(s(options.notes).trim() || current.notes);
  const marker = clearsSnapshot ? "" : carriedPrevMarker(current.notes);
  // Tagged upsert, not a plain merge: the depth note carries counts, so a plain append would
  // leave one segment per shallow save instead of one statement of the current fact.
  const notes = [depthNote ? upsertRecipeNote(body, "kept the deeper recording", depthNote) : body, marker]
    .filter(Boolean).join(" ").trim();

  db.run(
    `UPDATE portal_recipes SET steps_json = ?, status = ?, structure_sig = ?, auto_submit_enabled = 0,
       prev_steps_json = CASE WHEN ? = 'complete' THEN NULL ELSE prev_steps_json END,
       notes = ?, updated_at = ? WHERE id = ?`,
    [asJson(finalSteps), status, recipeStructureSignature(finalSteps), status, notes, nowIso(), recipeId],
  );
  return getPortalRecipe(db, recipeId);
}

// Promote a "recording" recipe to "complete" once a human has verified/fixed the captured
// fill (the "Recording looks right — save recipe" action, or automatically when the operator
// marks the track submitted — their manual submit just demonstrated the flow works). A recipe
// with no steps can't be promoted; already-complete is a no-op.
export function finishPortalRecipe(db: AppDb, recipeId: string, finishedBy?: string): PortalRecipe {
  const recipe = getPortalRecipe(db, recipeId);
  if (recipe.status === "complete") return recipe;
  if (!recipe.steps.length) throw new HttpError(409, "This recording has no captured steps yet — nothing to save as a replayable recipe.");
  // The snapshot is dropped here, so its `[prev-recipe:…]` marker goes with it. Every
  // statement that clears prev_steps_json must strip the marker, or a marker outlives its
  // payload and describes the NEXT snapshot — the one thing that would make the stale
  // sweep's proven/unproven judgement lie.
  db.run("UPDATE portal_recipes SET status = 'complete', prev_steps_json = NULL, auto_submit_enabled = 0, notes = ?, updated_at = ? WHERE id = ?", [
    mergeRecipeNotes(stripPrevMarker(recipe.notes), `[verified by ${finishedBy || "operator"} — promoted from recording]`),
    nowIso(), recipeId,
  ]);
  return getPortalRecipe(db, recipeId);
}

// AUTOMATIC promotion chokepoint (submit-observed signal, mark-submitted): promote a
// recording only when the learn actually REACHED REVIEW — its steps carry a terminal
// marker (stopForReview / isFinalSubmit). Without this guard, a learn that paused on a
// CAPTCHA at page 2 (or a stale abandoned draft) would be silently promoted to a
// replayable "complete" recipe by the operator's unrelated manual submit, and the bot
// would then deterministically replay a mid-form fragment for every future project.
// The explicit "Recording looks right — save recipe" button keeps using
// finishPortalRecipe directly: a deliberate operator override needs no marker.
export function promoteRecordingIfEligible(
  db: AppDb,
  recipeId: string,
  opts: { finishedBy: string; via: string; projectId?: string | null; /** Promote DESPITE recorded required-blank findings. Requires a written reason — see below. */ overrideBlankFields?: string },
): PortalRecipe | null {
  const recipe = getPortalRecipe(db, recipeId);
  if (recipe.status !== "recording" || recipe.steps.length === 0) return null;
  const reachedReview = recipe.steps.some(
    (st) => st.action === "stopForReview" || (st as { isFinalSubmit?: boolean }).isFinalSubmit === true,
  );
  if (!reachedReview) return null;

  // REACHING REVIEW IS NOT THE SAME AS FILLING THE FORM. The learn's required-field sweep
  // writes "Required field(s) left blank/unselected" into the notes precisely so a recipe
  // that walked the whole wizard while leaving required fields empty cannot be trusted.
  // That happened on the first Ameren Illinois learn — the sweep named Email, Street, Name,
  // Company, Address and Docket Number, and the recipe was promoted anyway on the strength
  // of a summary row that looked populated. Replay then faithfully reproduced an incomplete
  // application, reporting "no failures" because every recorded step did succeed.
  //
  // So the blank finding now BLOCKS promotion. Overriding is still possible, because a
  // sweep can be wrong, but it takes a written reason that lands in the notes and the audit
  // log next to the fields it overrode.
  const blankFinding = /required field\(s\) left blank/i.test(recipe.notes || "");
  if (blankFinding && !opts.overrideBlankFields) {
    throw new HttpError(409,
      "This recipe recorded REQUIRED FIELDS LEFT BLANK, so it is not trustworthy yet: "
      + `${(recipe.notes.match(/Required field\(s\) left blank[^.]*/i) || [""])[0].slice(0, 300)}. `
      + "Fill those fields (usually by adding the missing project/client data and re-learning), "
      + "or promote with an explicit written reason if the sweep is wrong.");
  }
  const finished = finishPortalRecipe(db, recipeId, opts.finishedBy);
  try {
    addAuditLog(db, opts.projectId ?? null, "human", "operator", "portal_recipe.finished", {
      recipeId, via: opts.via, profileKey: recipe.profileKey,
      // An override is the thing a later reader most needs to see, so it is stored
      // explicitly rather than buried in the free-text `via`.
      ...(opts.overrideBlankFields ? { overrodeBlankFieldFinding: opts.overrideBlankFields } : {}),
    });
  } catch { /* audit is best-effort */ }
  return finished;
}

// ---------------------------------------------------------------------------
// THE PORTAL BEING DOWN IS NOT THE RECIPE BEING WRONG.
//
// A replay that dies is demoted on the strength of one regex over the failure text
// (repository.ts: /recipe step failed/i). But a recorded step fails for two completely
// different families of reason, and only one of them is about the recipe:
//
//   ATTRIBUTABLE TO THE RECIPE — a selector no longer resolves, a control moved, a label
//   was renamed, the page structure drifted. The recipe genuinely no longer describes the
//   portal, and demoting it is the entire point of the check.
//
//   NOT ABOUT THE RECIPE — the host was unreachable or 5xx, the credential was rejected or
//   expired, an MFA/CAPTCHA wall appeared, a WAF refused the browser, our own browser or
//   process went away, or the account was already in session somewhere else (the portals
//   here allow ONE session per account, and two runs against one login is a collision, not
//   a defect — it is what produced this session's false 67% replay reading). Every one of
//   those fails identically tomorrow-morning-fine, and every one of them would have demoted
//   a verified recipe that was perfectly correct. For a product whose promise is "learn the
//   portal once", losing a 60-step verified recipe because the portal was down one night is
//   the worst outcome in the system.
//
// So a COMPLETE recipe is only demoted on evidence that points at the recipe. Told nothing
// (no failureText: the operator's own "mark for re-record" button, the CLI invalidator, the
// track/host mis-key gate) it demotes as before — a deliberate human act needs no evidence.
//
// The refusal only blocks the DEMOTION. repository.ts may still enqueue a re-learn off the
// same failure; that is harmless — autoLearn's protectComplete refuses to overwrite a
// complete recipe with an unverified pass, so the worst case is a wasted browser run.
// ---------------------------------------------------------------------------
const TRANSIENT_FAILURE: Array<[RegExp, string]> = [
  // Reuses the shared vocabulary rather than growing a fourth copy of it (see runAbort.ts).
  [/\bnet::ERR_[A-Z_]+|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|dns|tunnel connection failed/i, "the portal host could not be reached"],
  [/\b(5\d\d)\b.{0,40}(error|server|gateway|unavailable)|internal server error|bad gateway|service unavailable|gateway time-?out|under maintenance|temporarily unavailable|scheduled maintenance/i, "the portal returned a server error or maintenance page"],
  [/still on the login form|username\/password was likely rejected|login failed|sign ?in failed|invalid (username|password|credential)|credential(s)? (rejected|expired|invalid)|password (has )?expired|account (is )?locked|no stored credential/i, "the stored login was refused — a credential problem, not a recipe problem"],
  [/mfa|multi.?factor|one.?time (code|password)|\botp\b|captcha|recaptcha|hcaptcha|verification code|two.?factor/i, "a human challenge (MFA/CAPTCHA) blocked the run"],
  [/already (running|logged in|signed in)|another (session|user) is|session (is )?(already )?(in use|active)|concurrent (session|login)|logged in from another|single session|session limit/i, "the account was already in session elsewhere — one-session-per-account collision"],
  // A NAVIGATION timeout is the portal not answering. A SELECTOR/wait timeout is the page
  // not looking the way the recipe remembers, which is exactly the drift that should demote —
  // so it is deliberately absent from this list.
  [/page\.goto|navigation timeout|timeout .{0,20}exceeded.{0,20}navigat|net::ERR_TIMED_OUT|page\.waitFor(URL|LoadState|Navigation)/i, "the page never finished loading"],
];

// NOT ABOUT THE RECIPE, EITHER — the run was stopped by something about THIS PROJECT or by the
// filing's own outcome, and the same recipe replays cleanly for the next project:
//   - a DOCUMENT GATE refused an upload (submissionDocuments.uploadDocumentGuard: the document
//     changed mid-run, the permit path moved, the project vanished). PacifiCorp 6282e671 was
//     demoted on exactly this ("The site_plan document changed or no longer matches this permit
//     path") on 2026-09-21 and NEM replay went offline for the whole utility.
//   - MISSING PROJECT DATA — the project asked for something this jurisdiction does not offer, or
//     a value the step needs is absent. Fix the project, not the recipe.
//   - THE FINAL-SUBMIT OUTCOME needs a human (refused, unconfirmed, a challenge or a fee dialog
//     after the click). That is a filing to verify, never drift.
const PROJECT_OR_OUTCOME_FAILURE: Array<[RegExp, string]> = [
  [/document changed or no longer matches|upload stopped|permit path changed|document gate|required document\(s\) not attached|upload (was )?refused|refused (to attach|the upload)/i,
    "a document gate refused the upload — the project's documents, not the recipe"],
  [/is not offered here|matches \d+ of the types offered|address not in oregon epermitting|no value (was )?(supplied|provided|available)|missing (project|required) (data|value|field)|value dictionary does not define|project (data|record) (is )?missing|needs an answer/i,
    "the project is missing data this step needs (or asked for something this jurisdiction does not offer)"],
  [/final submit clicked|after the submit click|final-submit click did not complete|final submit needs a human|final submit triggered a challenge|payment dialog|fees are never automated|the approved final submit/i,
    "the final-submit outcome needs a human to verify — that is a filing to check, not drift"],
  // TEXT THE PORTAL SAID ABOUT THE PROJECT never demotes (trust skeptic M2). The adapter's
  // advance step reports the portal's own validation message ("The portal says: Service Account
  // Number: Account not found", "Meter number does not exist ...") — that is the project's data
  // being refused by the portal, and RECIPE_DRIFT's "not found | does not exist" would otherwise
  // read it as a control that vanished. Tested BEFORE the drift family on purpose.
  [/did not advance[\s\S]{0,240}the portal says:/i,
    "the portal refused the page with its own validation text — the project's data (or the portal's state), not the recipe"],
];

// THE ADAPTER'S OWN PAGE-DRIFT TRIPWIRE, WHEN IT BLAMES A BLANK REQUIRED FIELD: the replay is not
// on the page the recipe expects, but the adapter's best reading is that an earlier required
// field was left blank and the portal refused to advance — project data, or drift; nobody can
// say from the text. Unattributed → keep and flag for a human (never demote on it).
const DRIFT_BLAMED_ON_BLANK_FIELD = /left blank and the portal refused to advance|required field was left blank/i;

/** The captured page description recipeAdapter appends to a failing step's message —
 *  " [url=… | title=… | visible controls: … | self-heal: …]" — is what the page HAD, not what
 *  failed; it must never steer the verdict (a /403/ in the URL or a "Help: MFA setup" button
 *  turned real drift into a WAF or MFA reading). Only the text before it is classified. */
export function replayFailureTextWithoutPageContext(failureText: unknown): string {
  return String(failureText ?? "").replace(/\s*\[(?:url=|title=|visible controls:|self-heal:)[\s\S]*$/, "").trim();
}

// ATTRIBUTABLE TO THE RECIPE: the page no longer looks the way the recipe remembers — a recorded
// control that no longer resolves (a selector/locator wait timing out), a control or option that
// no longer exists, or the replay's own page-drift tripwire. This is the ONLY family that demotes.
const RECIPE_DRIFT =
  /page drift|waiting for (selector|locator)|locator\.[a-z]+:\s*timeout|timeout \d+ms exceeded|not found|no longer (on|exists|present|offered)|does not exist|resolved to 0 elements|no element|strict mode violation|no usable selector|element is not (visible|attached|enabled)|option .{0,60}not (offered|available|in (the )?list)|did not match any option/i;

/** Who a failed replay's own failure message points at.
 *  - "recipe": drift the replay could not heal, a control that no longer exists → demote.
 *  - "not_recipe": the environment, our harness, the project's data/documents, or the filing's
 *    outcome → keep, never demote, never queue a re-learn.
 *  - "unknown": nobody can attribute it (including NO message at all) → KEEP AND FLAG for a
 *    human (operator ruling 2026-09-24). An unattributed failure must not read as "the recipe
 *    is broken" — that is how a dead browser retired PGE 481c00f4. */
export type ReplayFailureAttribution = "recipe" | "not_recipe" | "unknown";

/**
 * Does this failure text point at the RECIPE (so a complete recipe should be demoted), at the
 * run's environment/project (so it should not), or at nothing anyone can name? Exported for the
 * fixture and for the restore script — there must not be a second copy of this rule.
 */
export function replayFailureBlamesRecipe(failureText: unknown): { blamesRecipe: boolean; attribution: ReplayFailureAttribution; reason: string } {
  const text = replayFailureTextWithoutPageContext(failureText);
  if (!text) return { blamesRecipe: false, attribution: "unknown", reason: "the run reported no failure message to attribute" };
  if (isHarnessAbort(text)) return { blamesRecipe: false, attribution: "not_recipe", reason: "our own browser or process went away mid-run (or our own profile lease refused to start it)" };
  if (looksBotBlocked(text)) return { blamesRecipe: false, attribution: "not_recipe", reason: "the portal refused the automated browser (WAF/bot wall)" };
  for (const [re, reason] of [...TRANSIENT_FAILURE, ...PROJECT_OR_OUTCOME_FAILURE]) {
    if (re.test(text)) return { blamesRecipe: false, attribution: "not_recipe", reason };
  }
  if (DRIFT_BLAMED_ON_BLANK_FIELD.test(text)) {
    return { blamesRecipe: false, attribution: "unknown", reason: "the replay is off its page, but the adapter itself blames an earlier blank required field — project data or drift, a human decides" };
  }
  if (RECIPE_DRIFT.test(text)) {
    return { blamesRecipe: true, attribution: "recipe", reason: "the page no longer matches what the recipe recorded (drift the replay could not heal)" };
  }
  return { blamesRecipe: false, attribution: "unknown", reason: "the failure could not be attributed to the recipe or to anything else" };
}

export type ReplayDemotionAction = "demoted" | "kept" | "flagged" | "not_complete" | "version_changed";

/**
 * THE RUN-DRIVEN DEMOTION — the only door a FAILED REPLAY has to a recipe's status.
 *
 * `failureText` is REQUIRED and must be the failing step's OWN message
 * (repository.extractStageFailureMessage), never the whole run's steps joined: the review step's
 * boilerplate says "handle any MFA/fee", so a joined text reads every failure as an MFA wall and
 * nothing is ever demoted (24 of 26 production failures would have been spared).
 *
 * `expectedVersion` is the recipe version the replay READ. A recipe re-learned or edited while the
 * replay ran is a different recipe; a failure of the old one says nothing about it.
 *
 * Only an attribution of "recipe" demotes. "not_recipe" keeps the recipe with a note; "unknown"
 * keeps it and raises the flag (flag_reason) for a human. Every outcome writes an audit row, so a
 * later restore reads what happened instead of reconstructing it.
 */
export function demoteOnReplayFailure(
  db: AppDb,
  recipeId: string,
  failureText: string,
  expectedVersion: number,
  ctx: {
    runId?: string | null; projectId?: string | null;
    /** recipeStepsSignature of the steps as this replay last knew them — as it READ them, or as
     *  its own heal WROTE them (persistHealedSteps' stepsSigAfter). A human step edit does not
     *  bump the version (savePortalRecipeSteps), so the full steps are compared too: drift on the
     *  old steps — even one re-pointed selector — says nothing about the edited recipe. */
    expectedStepsSig?: string | null;
  } = {},
): { action: ReplayDemotionAction; attribution: ReplayFailureAttribution | null; reason: string; recipe: PortalRecipe } {
  const recipe = getPortalRecipe(db, recipeId);
  const audit = (action: string, details: Record<string, unknown>): void => {
    try {
      addAuditLog(db, ctx.projectId ?? null, "system", "recipe replay", action, {
        recipeId, profileKey: recipe.profileKey, version: recipe.version, expectedVersion,
        runId: ctx.runId ?? null, failureText: String(failureText ?? "").slice(0, 300), ...details,
      });
    } catch { /* audit is best-effort */ }
  };
  if (recipe.status !== "complete") {
    return { action: "not_complete", attribution: null, reason: `the recipe is ${recipe.status}, not complete`, recipe };
  }
  if (recipe.version !== expectedVersion) {
    audit("portal_recipe.demotion_skipped", { reason: "recipe changed during replay" });
    return { action: "version_changed", attribution: null, reason: "the recipe changed while the replay ran", recipe };
  }
  if (ctx.expectedStepsSig && recipeStepsSignature(recipe.steps) !== ctx.expectedStepsSig) {
    audit("portal_recipe.demotion_skipped", { reason: "recipe changed during replay (its steps were edited)" });
    return { action: "version_changed", attribution: null, reason: "the recipe's steps were edited while the replay ran", recipe };
  }
  const verdict = replayFailureBlamesRecipe(failureText);
  const now = nowIso();
  if (verdict.attribution === "recipe") {
    db.run(
      `UPDATE portal_recipes SET status = 'needs_rerecord', auto_submit_enabled = 0, notes = ?, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'complete'`,
      [upsertRecipeNote(recipe.notes, "demoted by replay", `[demoted by replay ${now.slice(0, 10)}: ${verdict.reason} — "${String(failureText).slice(0, 160)}"]`),
        now, recipeId, expectedVersion],
    );
    const changed = Number(db.get<{ n: number }>("SELECT changes() AS n")?.n ?? 0) > 0;
    if (!changed) {
      audit("portal_recipe.demotion_skipped", { reason: "recipe changed during replay" });
      return { action: "version_changed", attribution: verdict.attribution, reason: "the recipe changed while the replay ran", recipe: getPortalRecipe(db, recipeId) };
    }
    audit("portal_recipe.demoted", { attribution: verdict.attribution, reason: verdict.reason });
    return { action: "demoted", attribution: verdict.attribution, reason: verdict.reason, recipe: getPortalRecipe(db, recipeId) };
  }
  if (verdict.attribution === "not_recipe") {
    const note = `[kept trusted: a replay failed, but ${verdict.reason} — that says nothing about the recipe, so it was not demoted]`;
    db.run("UPDATE portal_recipes SET notes = ?, updated_at = ? WHERE id = ?", [mergeRecipeNotes(recipe.notes, note), now, recipeId]);
    audit("portal_recipe.demotion_refused", { attribution: verdict.attribution, reason: verdict.reason });
    return { action: "kept", attribution: verdict.attribution, reason: verdict.reason, recipe: getPortalRecipe(db, recipeId) };
  }
  // KEEP AND FLAG. Still replayable; a human is asked to look.
  const flag = `A replay failed and the failure could not be attributed (${String(failureText || "no message").slice(0, 160)}) — kept replayable; check the run and clear this flag, or mark the recipe for re-record.`;
  db.run(
    "UPDATE portal_recipes SET flag_reason = ?, flagged_at = ?, auto_submit_enabled = 0, notes = ?, updated_at = ? WHERE id = ?",
    [flag, now, upsertRecipeNote(recipe.notes, "flagged for review", `[flagged for review ${now.slice(0, 10)}: an unattributed replay failure — kept replayable]`), now, recipeId],
  );
  audit("portal_recipe.replay_failure_flagged", { attribution: verdict.attribution, reason: verdict.reason });
  return { action: "flagged", attribution: verdict.attribution, reason: verdict.reason, recipe: getPortalRecipe(db, recipeId) };
}

/** A heal as the replay reports it (shared/src/portalSafety HealedStep), read defensively. */
export interface ReportedHeal {
  stepIndex: number;
  recipeVersion?: number;
  action: string;
  note?: string;
  selector?: unknown;
  performed: boolean;
}

/** Every heal a replay result reports — on the result itself or on any step's data (where
 *  recipeAdapter actually puts them) — one per step index, the last report winning. */
export function collectHealedSteps(result: unknown): ReportedHeal[] {
  const r = (result ?? {}) as { healedSteps?: unknown; steps?: Array<{ data?: { healedSteps?: unknown } }> };
  const lists: unknown[] = [r.healedSteps, ...(Array.isArray(r.steps) ? r.steps.map((st) => st?.data?.healedSteps) : [])];
  const byIndex = new Map<number, ReportedHeal>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const h of list as Array<Partial<ReportedHeal>>) {
      if (!h || !Number.isInteger(h.stepIndex)) continue;
      byIndex.set(Number(h.stepIndex), h as ReportedHeal);
    }
  }
  return [...byIndex.values()];
}

/**
 * PERSIST A REPLAY'S HEALS — onto the step each one healed, and only onto the recipe it healed.
 *
 * The old writer matched heals by (action, note) and rewrote EVERY step that shared them — one
 * heal re-pointed all six "No" radios of a policy page at the same control. It read the row with
 * no version check, so it could patch steps a concurrent re-learn had just written. And the
 * auto-submit disarm sat inside the same try as the step write ("best-effort"), so a throwing save
 * left a healed — unverified — recipe armed.
 *
 * Now: (1) the disarm is its own statement, FIRST, outside any try — auto_submit_enabled is never
 * authority (maySubmitAutomatically does not read it), but a healed recipe must never look armed;
 * (2) only heals that PERFORMED and were read from THIS version apply, each by stepIndex, and only
 * when the step still has the action the heal reports; (3) the write is
 * `UPDATE ... WHERE id = ? AND version = ?` — if the recipe moved during the replay the heals are
 * discarded with an audit row, never merged into a recipe they were not measured against. The
 * version is NOT bumped: a heal is the same recipe with a repaired selector (and a bump would make
 * the same run's demotion check think the recipe changed under it).
 */
export function persistHealedSteps(
  db: AppDb,
  recipeId: string,
  expectedVersion: number,
  healed: ReportedHeal[],
  ctx: {
    projectId?: string | null; runId?: string | null;
    /** recipeStepsSignature of the steps the replay READ — a human step edit (no version bump)
     *  may shift every index or re-point the very selector the heal measured; the heal must then
     *  be discarded, never landed on the human's steps. */
    expectedStepsSig?: string | null;
  } = {},
): {
  applied: number[]; discarded: string | null;
  /** recipeStepsSignature of the steps this call WROTE (null when it wrote nothing) — what the
   *  same run's demotion check must compare against, since its own heal changed a selector. */
  stepsSigAfter: string | null;
} {
  // (1) Disarm first — its own statement, outside the try.
  db.run("UPDATE portal_recipes SET auto_submit_enabled = 0 WHERE id = ?", [recipeId]);
  const audit = (action: string, details: Record<string, unknown>): void => {
    try {
      addAuditLog(db, ctx.projectId ?? null, "system", "recipe replay", action, { recipeId, expectedVersion, runId: ctx.runId ?? null, ...details });
    } catch { /* audit is best-effort */ }
  };
  const usable = (healed ?? []).filter((h) => h && h.performed === true && Number.isInteger(h.stepIndex) && h.stepIndex >= 0
    && (h.recipeVersion === undefined || h.recipeVersion === null || Number(h.recipeVersion) === expectedVersion));
  if (!usable.length) return { applied: [], discarded: null, stepsSigAfter: null };
  const discard = (reason: string): { applied: number[]; discarded: string; stepsSigAfter: null } => {
    audit("recipe.heal_discarded", { reason, stepIndexes: usable.map((h) => h.stepIndex).slice(0, 20) });
    return { applied: [], discarded: reason, stepsSigAfter: null };
  };
  try {
    const row = db.get<Row>("SELECT version, steps_json, notes FROM portal_recipes WHERE id = ?", [recipeId]);
    if (!row) return discard("recipe no longer exists");
    if (Number(row.version ?? 0) !== expectedVersion) return discard("recipe changed during replay");
    const steps = parseJson<RecipeStep[]>(s(row.steps_json) || "[]", []);
    if (ctx.expectedStepsSig && recipeStepsSignature(steps) !== ctx.expectedStepsSig) return discard("recipe changed during replay (its steps were edited)");
    const applied: number[] = [];
    for (const h of usable) {
      const st = steps[h.stepIndex];
      if (!st || st.action !== h.action) continue; // the step is not the one the heal measured
      steps[h.stepIndex] = {
        ...st,
        selector: { ...((h.selector ?? {}) as object), fallbacks: [...(st.selector ? [st.selector] : [])] } as RecipeStep["selector"],
      };
      applied.push(h.stepIndex);
    }
    if (!applied.length) return discard("no reported heal matches its step (index/action)");
    const note = `[self-healed ${nowIso().slice(0, 10)}: step(s) ${applied.map((i) => i + 1).join(", ")} re-anchored — verify the next review screen]`;
    // Written only over the exact steps text it read: a human save between the read and this
    // statement (no version bump) makes it a no-op, and the heal is discarded.
    const written = asJson(steps);
    db.run(
      `UPDATE portal_recipes SET steps_json = ?, structure_sig = ?, notes = ?, updated_at = ?
        WHERE id = ? AND version = ? AND steps_json = ?`,
      [written, recipeStructureSignature(steps), upsertRecipeNote(row.notes, "self-healed", note), nowIso(), recipeId, expectedVersion, s(row.steps_json)],
    );
    if (Number(db.get<{ n: number }>("SELECT changes() AS n")?.n ?? 0) === 0) return discard("recipe changed during replay");
    audit("recipe.self_healed", { stepIndexes: applied, steps: applied.map((i) => steps[i]?.note ?? steps[i]?.action).slice(0, 10) });
    return { applied, discarded: null, stepsSigAfter: recipeStepsSignature(parseJson<RecipeStep[]>(written, [])) };
  } catch (err) {
    return discard(`heal write failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
  }
}

/** The flag a kept-but-unattributed failure raised, or "" when none is raised. */
export function recipeReviewFlag(db: AppDb, recipeId: string): { reason: string; flaggedAt: string | null } {
  const row = db.get<Row>("SELECT flag_reason, flagged_at FROM portal_recipes WHERE id = ?", [recipeId]);
  return { reason: s(row?.flag_reason), flaggedAt: row?.flagged_at ? s(row.flagged_at) : null };
}

/**
 * A HUMAN CLEARS THE FLAG (trust skeptic M4): the operator looked at the run the flag names and
 * decided the recipe is fine. Audited with who cleared it and what the flag said, so the next
 * unattributed failure is not mistaken for the one already looked at. Idempotent: clearing a
 * recipe that carries no flag changes nothing and writes no audit row. The status is untouched —
 * a person who thinks the recipe is broken uses "mark for re-record" instead.
 */
export function clearPortalRecipeFlag(
  db: AppDb,
  recipeId: string,
  opts: { actor?: string; note?: string } = {},
): PortalRecipeWithFlag {
  const recipe = getPortalRecipe(db, recipeId); // 404 if missing
  if (!recipe.flagReason.trim()) return recipe;
  const now = nowIso();
  const actor = s(opts.actor).trim() || "operator";
  const note = s(opts.note).trim().slice(0, 240);
  db.run(
    "UPDATE portal_recipes SET flag_reason = '', flagged_at = NULL, notes = ?, updated_at = ? WHERE id = ?",
    [upsertRecipeNote(recipe.notes, "flag cleared", `[flag cleared ${now.slice(0, 10)} by ${actor}${note ? `: ${note}` : ""}]`), now, recipeId],
  );
  addAuditLog(db, null, "human", actor, "portal_recipe.flag_cleared", {
    recipeId, profileKey: recipe.profileKey, version: recipe.version, flagReason: recipe.flagReason.slice(0, 300), flaggedAt: recipe.flaggedAt, note,
  });
  return getPortalRecipe(db, recipeId);
}

/**
 * THE HUMAN (OR GATE) DECISION to re-record a recipe: the dashboard's "Flag re-record", the
 * recipe:clear CLI, and the track/host mis-key gate. A deliberate act needs no failure evidence —
 * which is exactly why a FAILED RUN must never come through here (demoteOnReplayFailure is its
 * door). Audited with who asked, so the restore script can tell a human's re-record from a run's.
 */
export function markPortalRecipeForRerecord(
  db: AppDb,
  recipeId: string,
  opts: { actor?: string; actorType?: "human" | "system"; reason?: string; projectId?: string | null } = {},
): PortalRecipe {
  const recipe = getPortalRecipe(db, recipeId);
  db.run("UPDATE portal_recipes SET status = 'needs_rerecord', auto_submit_enabled = 0, updated_at = ? WHERE id = ?", [nowIso(), recipeId]);
  try {
    addAuditLog(db, opts.projectId ?? null, opts.actorType ?? "human", opts.actor || "operator", "portal_recipe.marked_for_rerecord", {
      recipeId, profileKey: recipe.profileKey, version: recipe.version, fromStatus: recipe.status,
      reason: String(opts.reason ?? "").slice(0, 240),
    });
  } catch { /* audit is best-effort */ }
  return getPortalRecipe(db, recipeId);
}

export function deletePortalRecipe(db: AppDb, recipeId: string): { deleted: boolean } {
  getPortalRecipe(db, recipeId);
  db.run("DELETE FROM portal_recipes WHERE id = ?", [recipeId]);
  return { deleted: true };
}

// Human-readable descriptions for every bindable field key — used by the LLM field-binding
// classifier to understand what each key means when matching portal form values.
export const RECIPE_FIELD_DESCRIPTIONS: Record<string, string> = {
  homeownerName: "Property owner full name (the person who owns the house) — NOT the utility account holder, which is ubAccountHolder",
  ubAccountHolder: "Utility bill account holder, exactly as printed on the bill — this is the CUSTOMER on an interconnection application",
  wattsmartBatteryProgram: "Yes/No for the utility battery programme — Yes only when the project has storage",
  ubAccountHolderFirstName: "Utility bill account holder first name (title stripped)",
  ubAccountHolderLastName: "Utility bill account holder last name",
  ubAccountHolderEmail: "Account holder email (falls back to the homeowner's)",
  ubAccountHolderPhone: "Account holder phone (falls back to the homeowner's)",
  projectName: "Permit \"Project Name\" — the homeowner's name, which is how the AHJ, the inspector and the office look the job up later",
  homeownerFirstName: "Property owner first (given) name only",
  homeownerLastName: "Property owner last (family) name only",
  homeownerEmail: "Property owner / homeowner email address",
  homeownerPhone: "Property owner / homeowner phone number",
  street: "Installation site street address (no city/state/zip)",
  projectAddress: "Installation site full street address",
  city: "Installation site city",
  state: "Installation site state (2-letter abbreviation, e.g. OR)",
  zip: "Installation site zip/postal code",
  ahj: "Authority Having Jurisdiction (city/county) name",
  utility: "Electric utility company name",
  accountNumber: "Customer utility account number",
  meterNumber: "Utility meter number",
  interconnectionMethod: "Interconnection method (e.g. NEM, Parallel Generation)",
  systemSizeDcKw: "Solar system DC size in kilowatts",
  systemSizeAcKw: "Solar system AC size in kilowatts",
  totalExportKw: "Total export capacity in kilowatts",
  inverterManufacturer: "Inverter manufacturer/make (e.g. Tesla, Enphase, SolarEdge)",
  inverterMake: "Inverter manufacturer/make (alias of inverterManufacturer)",
  inverterModel: "Inverter model number",
  inverterQuantity: "Number of inverters",
  inverterQty: "Number of inverters (alias of inverterQuantity)",
  moduleManufacturer: "PV module/panel manufacturer/make",
  moduleMake: "PV module/panel manufacturer/make (alias of moduleManufacturer)",
  moduleModel: "PV module/panel model number",
  moduleQuantity: "Total number of PV modules/panels across all arrays",
  moduleQty: "Total number of PV modules/panels (alias of moduleQuantity)",
  totalModuleQuantity: "Total number of PV modules/panels across all arrays",
  moduleWattage: "Per-module DC wattage (W)",
  mainServiceRating: "Main service panel/entrance rating in amps",
  hasBattery: "Whether the system includes battery storage (Yes/No)",
  batteryManufacturer: "Battery/storage manufacturer/make",
  batteryModel: "Battery/storage model number",
  batteryQuantity: "Number of battery units",
  // THE ONE BATTERY SPEC THAT HAD NO KEY TO BIND TO. Every other storage field above has
  // one, so a capacity control could only ever be frozen as an unbound literal — and the
  // replay-side cross-project guard then refuses that literal, because "capacity" reads as
  // project data. Net effect measured on the PacifiCorp storage section: the filing declared
  // a Tesla battery and left the required kWh box empty on every project, forever. The
  // adapter now substitutes the project's own capacity for an already-recorded literal;
  // this entry is what lets a NEW learn bind the control properly instead.
  // Named for the canonical snapshot key normalize.ts derives (essKwh), with the parser's
  // own spelling as the alias, so the classifier can match either wording a portal uses.
  essKwh: "Battery/energy-storage capacity in kilowatt-hours (kWh) — the STORAGE size, never the PV system's kW rating",
  batteryCapacityKwh: "Battery/energy-storage capacity in kWh (alias of essKwh)",
  installerCompanyName: "Installer/contractor company name",
  installerEmail: "Installer company or contact email address",
  installerPhone: "Installer company phone number",
  installerAddress: "Full installer company address (street, city, state, zip combined)",
  installerStreet: "Installer company street address only",
  installerCityStateZip: "Installer company city, state, zip (no street)",
  installerContactName: "Installer contact person full name",
  // A LICENCE IS A STATE'S AND A PERMIT'S (clients.licenceOverlay). Oregon: the CCB. Elsewhere the
  // contractor licence THIS permit takes in the job's state — never Oregon's CCB.
  ccbLicenseNumber: "Contractor license number for THIS job's state and permit (Oregon: the CCB number; elsewhere the state's contractor licence this permit takes)",
  ccbExpiration: "Contractor license EXPIRATION date (the licence in ccbLicenseNumber) — when the licence runs out, not today's date",
  contractorLicenseNumber: "General / building / residential CONTRACTOR license number (THIS job's state), whatever the permit's trade — never the electrical or a person's licence",
  contractorLicenseExpiration: "General / building / residential contractor license EXPIRATION date (the licence in contractorLicenseNumber)",
  electricalLicenseNumber: "Electrical contractor license number (THIS job's state)",
  electricalLicenseExpiration: "Electrical contractor license EXPIRATION date (the licence in electricalLicenseNumber)",
  electricianLicenseExpiration: "Supervising / master electrician license EXPIRATION date (the licence in electricianLicenseNumber)",
  constructionSupervisorLicenseNumber: "Construction Supervisor License (CSL) number — Massachusetts-style construction supervisor licence, THIS job's state",
  constructionSupervisorLicenseExpiration: "Construction Supervisor License EXPIRATION date — when that licence runs out",
  homeImprovementLicenseNumber: "Home Improvement Contractor (HIC) registration number, THIS job's state",
  homeImprovementLicenseExpiration: "Home Improvement Contractor registration EXPIRATION date",
  docketNumber: "ICC/state docket number for the installer's DG certification (Illinois Part 468)",
  metroCityLicenseNumber: "Metro or city business license number",
  electricalSupervisorName: "Supervising / master electrician full name (the holder of electricianLicenseNumber)",
  electricianLicenseNumber: "Supervising / master electrician (personal) license number, THIS job's state",
  authorizedSignerName: "Authorized signer or representative full name",
  authorizedSignerTitle: "Authorized signer's title",
  powerclerkExistingContact: "PowerClerk existing contact ID code",
  // Building geometry + the permit narrative. AHJ applications ask for these directly, and
  // before they were bindable the recipes froze the learn project's house onto every filing.
  existingBuildingArea: "Existing house conditioned floor area in square feet",
  buildingHeightFeet: "Existing building height, whole feet (grade to ridge)",
  buildingHeightInches: "Existing building height, remaining inches",
  numberOfStories: "Number of storeys of the existing building",
  newBuildingArea: "New building area created by this work (0 for a rooftop retrofit)",
  dwellingUnits: "Dwelling units in the building (1 for a single-family house)",
  numberOfBuildings: "Buildings covered by this permit (1 unless the plans show more)",
  county: "County the project site is in",
  // THE PARCEL HAS ITS OWN KEY (portal-run-close 7). The learner's ACA work-location pass
  // records the parcel search bound to parcelNumber (the parser snapshot's key, "(no dashes)");
  // without this entry the key was bindable only on a project whose snapshot happened to carry
  // it, and the binder could never offer it to a frozen parcel literal. deadFieldBindings still
  // flags the step for a project with NO parcel (the resolver emits the key only when present).
  parcelNumber: "Assessor parcel number (APN) of the project site, as the county prints it",
  workDescription: "One-line scope of work for the permit application, derived from this project's own system size",
  // THE VALUE FOR EVERY JOB VALUE / VALUATION / ESTIMATED COST BOX (leak sweep 2026-09-28). The
  // operator's valuation formula (valuation.ts: 40% of contract + battery adders), whole dollars —
  // the same figure the PDF application carries. jobValue / contractAmount are the CONTRACT price.
  declaredValuation: "THE value for a Job Value / Valuation / Estimated Cost / Construction Value box: the declared valuation (operator formula, 40% of contract + battery adders) — the same number the PDF application states. NEVER the contract price.",
  jobValue: "The CONTRACT price the client pays — only for a box explicitly labelled contract price/amount; NEVER a Job Value / Valuation / Estimated Cost box (that is declaredValuation)",
  contractAmount: "The CONTRACT price the client pays (alias of jobValue) — only for a box explicitly labelled contract price/amount; never a valuation box",
  accelaContactCode: "Accela contact/license lookup code",
  hasExistingSystem: "Whether an existing PV/storage system is already interconnected on site (Yes/No)",
  existingSystemSizeDcKw: "EXISTING (already interconnected) system DC size in kilowatts",
  existingSystemSizeAcKw: "EXISTING (already interconnected) system AC size in kilowatts",
  totalSystemSizeDcKw: "COMBINED (existing + new) total system DC size in kilowatts after the addition",
  totalSystemSizeAcKw: "COMBINED (existing + new) total system AC size in kilowatts after the addition",
  existingInverterMake: "EXISTING system's inverter manufacturer/make",
  existingInverterModel: "EXISTING system's inverter model number",
  existingInverterQty: "Number of inverters in the EXISTING system",
  existingModuleMake: "EXISTING system's PV module manufacturer/make",
  existingModuleModel: "EXISTING system's PV module model number",
  existingBatteryMakeModel: "EXISTING system's battery/storage make and model",
  nemTariff: "NEM tariff/program the existing system is on (e.g. NEM1, NEM2, NEM3/NBT)",
  existingPtoDate: "Permission-to-operate date of the EXISTING system",
  existingPtoDateUs: "Permission-to-operate date of the EXISTING system, MM/DD/YYYY",
  existingPtoDateIso: "Permission-to-operate date of the EXISTING system, YYYY-MM-DD",
  // Company facts beside the licence (clients.clientCompanyFactFields) — THIS job's client only.
  insuranceCarrier: "Installer's (contractor's) liability insurance carrier / company",
  insuranceExpiration: "Installer's liability insurance policy EXPIRATION date",
  bondCarrier: "Installer's contractor / surety bond company",
  bondExpiration: "Installer's contractor / surety bond EXPIRATION date",
  installerStreetNumber: "Installer company street address — house NUMBER only",
  installerStreetName: "Installer company street address — street NAME only (everything after the number)",
  existingNemAgreementNumber: "EXISTING interconnection/NEM agreement number (sensitive — bind by name, never a literal)",
  existingNemApplicationNumber: "EXISTING interconnection application number (sensitive — bind by name, never a literal)",
  exportMode: "Export mode of the system (export / non-export-pcs / ngom)",
  ownershipModel: "System ownership/financing: Customer-Owned, Third-Party Owned, Lease, or PPA",
  systemConfiguration: "Behind the Meter vs Community Solar vs standalone",
  disconnectWithin10ft: "Is the AC disconnect within 10 feet of the utility meter (yes/no)",
};

// Build the field-substitution map a recipe step's `field` resolves against at replay:
// the project's authoritative fields + the assigned client's licensing overlay (so the
// correct contractor identity is always used) + parser-snapshot extras as fallback.
// Commissioning is an ESTIMATE the applicant supplies, not a known project date — no
// parser snapshot in the live DB carries one. Six weeks out matches the horizon the
// planner was already told to use ("todayDate plus a few weeks") and is comfortably
// future-dated for a portal that rejects a past commissioning date.
const COMMISSIONING_HORIZON_DAYS = 42;
function dateFields(): Record<string, string> {
  const today = new Date();
  const commissioning = new Date(today.getTime() + COMMISSIONING_HORIZON_DAYS * 86400000);
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const us = (d: Date): string => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  return {
    todayDate: iso(today),
    todayDateUs: us(today),
    estimatedCommissioningDate: us(commissioning),
    estimatedCommissioningDateIso: iso(commissioning),
  };
}

// Which date field a recorded date literal should become. Value-equality binding cannot
// reach these (that is exactly why they froze), so this matches on the CONTROL's label
// and picks the format the portal already demonstrated it accepts.
const DATE_LITERAL = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})$/;
const FUTURE_DATE_LABEL = /commission|in[- ]?service|energiz|operation|installation|completion|start|planned|expected|estimated|anticipat|schedul/i;
// AN EXPIRY IS NEITHER A SIGNATURE DATE NOR A COMMISSIONING ESTIMATE.
//
// This function's last line assumed every date that is not a future estimate is "today" —
// which is right for the signature and application dates it was written for, and wrong for a
// licence. A portal that asks for a contractor licence usually asks when it expires in the
// next box, and the next learn of one would have bound it to todayDate: every replay then
// files a licence that expires the day it was submitted. A wrong value on a contractor's
// application, filed silently, and it costs nothing to close before the next learn rather
// than after.
const EXPIRY_DATE_LABEL = /expir|valid\s*(through|until|thru)|renew/i;
// WHOSE expiry, though. "Expiration Date" is also what a payment page prints next to a card,
// and ccbExpiration is emphatically not that. Rather than teach this function card vocabulary
// — recipeAdapter's PAYMENT_FIELD already owns that question at replay, and a second copy of
// it here is how two regexes drift apart — the expiry rule requires the label to name what is
// expiring. An expiry with no licence context binds to NOTHING: the literal stays, the
// cross-project guard refuses it if it looks like somebody's data, and a person sees a blank
// at review. Declining to bind is the safe half of this decision.
// A CONTRACTOR LICENCE, NOT ANY EXPIRING DOCUMENT (leak sweep 2026-09-28). "registration",
// "certificat", "bond" and "insurance" used to count as licence context, so a Contractor Insurance /
// Surety Bond / Business Registration expiry was bound to the CCB licence's expiry — the wrong date,
// and blank for any company with no CCB. Insurance and bond now have their own keys (the client's
// own insurance_expiry / bond_expiry); a registration or a city/business licence binds to nothing.
const LICENCE_CONTEXT = /licen[sc]e|\bccb\b|contractor/i;
const NOT_A_CONTRACTOR_LICENCE = /\b(?:business|city|metro|driver'?s?|vehicle)\s+licen[sc]e|\bregistration\b/i;
const WORKERS_COMP_LABEL = /workers?'?\s*comp/i;
const INSURANCE_LABEL = /\binsurance\b|\bliability\s+(?:policy|coverage)\b|\binsurer\b/i;
const BOND_LABEL = /\bbond\b|\bsurety\b/i;
// AN EXISTING SYSTEM'S DATE IS A FACT ABOUT THE PAST. "Existing System Permission to Operate Date"
// fell through to "today" ("Operate" is not "operation") and "Existing system installation date"
// to a date six weeks in the FUTURE — every replay filed today / next month as the existing
// system's PTO. The existing system's PTO binds to its own key (in the format the portal accepted);
// any other existing-system or PTO date binds to nothing — the literal stays, and the replay guard
// refuses it as project data.
const PAST_SYSTEM_LABEL = /\b(?:existing|original(?:ly)?|prior|previous(?:ly)?)\b/i;
const PTO_WORDS = /\bpto\b|permission\s+to\s+operate/i;
const ESTIMATE_WORD = /\b(?:estimated|expected|anticipated|requested|projected|planned|target)\b/i;
/** A PAST system's date, or a PTO date the label does not call an estimate ("Permission to Operate
 *  Date" could be the existing system's): never today, never a commissioning estimate. An ESTIMATED /
 *  expected PTO is the new system's future date and falls through to the future-date rule. */
const pastOrUnestimatedPtoDate = (text: string): boolean => PAST_SYSTEM_LABEL.test(text) || (PTO_WORDS.test(text) && !ESTIMATE_WORD.test(text));
/** A date literal on such a label that binds to no key of its own: withheld at save, never frozen. */
export function existingSystemDateWithoutKey(label: string, value: string): boolean {
  const text = String(label || "");
  return DATE_LITERAL.test(String(value || "").trim()) && /date/i.test(text) && pastOrUnestimatedPtoDate(text) && !EXISTING_PTO_LABEL.test(text);
}
const EXISTING_PTO_LABEL = /\b(?:existing|original|prior|previous)\b[^.?]{0,60}(?:\bpto\b|permission\s+to\s+operate)|(?:\bpto\b|permission\s+to\s+operate)[^.?]{0,60}\b(?:existing|original|prior|previous)\b/i;
export function dateFieldForLiteral(label: string, value: string): string | null {
  const raw = String(value || "").trim();
  if (!DATE_LITERAL.test(raw)) return null;
  const text = String(label || "");
  if (!/date/i.test(text)) return null; // only rebind a control that is actually a date
  const isUs = raw.includes("/");
  // An EXISTING system's (or any PTO) date is never today and never a commissioning estimate.
  if (pastOrUnestimatedPtoDate(text)) return EXISTING_PTO_LABEL.test(text) ? (isUs ? "existingPtoDateUs" : "existingPtoDateIso") : null;
  // WHOSE expiry: workers' comp binds to nothing; insurance and bond to the client's own dates; a
  // registration or a business/city licence to nothing; a contractor licence to the licence's.
  if (EXPIRY_DATE_LABEL.test(text) && WORKERS_COMP_LABEL.test(text)) return null;
  if (EXPIRY_DATE_LABEL.test(text) && INSURANCE_LABEL.test(text)) return "insuranceExpiration";
  if (EXPIRY_DATE_LABEL.test(text) && BOND_LABEL.test(text)) return "bondExpiration";
  // Checked BEFORE the future-date rule on purpose: "Licence Valid Through Date" carries both
  // an expiry word and nothing else, while a label like "Expiration of the estimated schedule"
  // does not exist. Expiry is the more specific reading wherever both could fire.
  if (EXPIRY_DATE_LABEL.test(text)) {
    // WHICH licence expires: the slot's own words, read by kindForSlot — the ONE "which licence does
    // this label name" predicate (licences-by-type) — BEFORE the not-a-contractor-licence words
    // (leak-fix-portal): a CSL or HIC expiry has its own key even when the label says "registration"
    // (Massachusetts' HIC is a Home Improvement Contractor REGISTRATION), and a CCB registration is
    // Oregon's contractor licence. EVERY kind the overlay carries has its own expiry key
    // (licenceKinds.LICENCE_EXPIRY_KEY_BY_KIND — electrical contractor, supervising / master
    // electrician, contractor); a kind with NO key (a business registration, a solar licence) binds
    // to nothing, so the literal meets the save guard and is withheld — never the generic licence's
    // date (licences skeptic L3). A business or city licence, a driver's licence or a bare
    // registration that names no contractor licence binds to nothing.
    const kind = kindForSlot(text);
    if (kind && kind !== "generic") return licenceKeyForKind(kind, true, text);
    if (NOT_A_CONTRACTOR_LICENCE.test(text)) return null;
    // A licence expiry that does not say which licence is the generic licence's.
    return LICENCE_CONTEXT.test(text) ? "ccbExpiration" : null;
  }
  if (FUTURE_DATE_LABEL.test(text)) return isUs ? "estimatedCommissioningDate" : "estimatedCommissioningDateIso";
  // A signature/application date is "today", not a future estimate.
  return isUs ? "todayDateUs" : "todayDate";
}

/** A stored date ("2021-03-15", "3/15/2021") in both portal formats; blanks when it does not parse. */
function usAndIsoDate(raw: unknown): { us: string; iso: string } {
  const s = String(raw ?? "").trim();
  let y = 0, m = 0, d = 0;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; } else if (us) { y = +us[3]; m = +us[1]; d = +us[2]; } else return { us: "", iso: "" };
  if (m < 1 || m > 12 || d < 1 || d > 31) return { us: "", iso: "" };
  const p = (n: number) => String(n).padStart(2, "0");
  return { us: `${p(m)}/${p(d)}/${y}`, iso: `${y}-${p(m)}-${p(d)}` };
}

// A plan-set orientation rounded to the whole degree the portals accept. Anything that is
// not a number is passed through untouched (a portal may legitimately want "SW").
function wholeDegrees(value: unknown): unknown {
  if (value == null || value === "") return value;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) return value;
  return String(Math.round(n));
}

// PER-JOB PORTAL ANSWER RENDERING. The project columns store rigid slugs
// ('customer-owned', 'behind-the-meter', 'yes'); portals list display wordings. Replay's
// select matching — selectWithFallback's native two-pass scan and bestOptionMatch's
// combobox scan, both in portal-bot/src/comboboxFill.ts — normalizes CASE and WHITESPACE
// only, plus bidirectional contains: a hyphen never matches a space, so the slug
// 'behind-the-meter' would miss the option "Behind the Meter" in every tier. The resolver
// therefore returns the wording the live portals demonstrated (PacifiCorp's recorded
// literals: "Customer-Owned", "Third-Party Owned"; Ameren's question: "Community Solar /
// Behind the Meter"). An answer these maps do not know passes through VERBATIM — the
// operator may have typed the portal's own wording — and a select value no option matches
// fails soft and is reported, never guessed (comboboxFill refuses blind Enter while
// options are showing).
const OWNERSHIP_MODEL_RENDER: Record<string, string> = {
  "customer-owned": "Customer-Owned",
  "third-party-owned": "Third-Party Owned",
  "lease": "Lease",
  "leased": "Lease",
  "ppa": "PPA",
};
const SYSTEM_CONFIGURATION_RENDER: Record<string, string> = {
  "behind-the-meter": "Behind the Meter",
  "community-solar": "Community Solar",
  "standalone": "Standalone",
};
const YES_NO_ANSWER_RENDER: Record<string, string> = {
  "yes": "Yes", "y": "Yes", "true": "Yes",
  "no": "No", "n": "No", "false": "No",
};
function renderPerJobAnswer(raw: unknown, map: Record<string, string>): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return map[s.toLowerCase().replace(/[\s_]+/g, "-")] ?? s;
}

// The model strings a portal will actually list, for this project's equipment. Kept beside
// the other derived fields so both learn and replay see the same map.
function certifiedModelFields(
  db: AppDb,
  snapshotFlat: Record<string, string>,
  equipment: Record<string, string>,
): Record<string, string> {
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = String(equipment[k] ?? snapshotFlat[k] ?? "").trim();
      if (v) return v;
    }
    return "";
  };
  const out: Record<string, string> = {};
  try {
    const modWatts = pick("moduleWattage", "moduleWatts", "watts");
    const mod = certifiedModelFor(db, "module", pick("moduleMake", "moduleManufacturer"), pick("moduleModel"), modWatts);
    if (mod) out.moduleModelCertified = mod;
    const inv = certifiedModelFor(db, "inverter", pick("inverterMake", "inverterManufacturer"), pick("inverterModel"), pick("inverterWattage"));
    if (inv) out.inverterModelCertified = inv;
  } catch { /* CEC table absent or unsynced — fall back to the plan-set values */ }
  return out;
}

/** THE SITE CONTACT'S PHONE WHEN NONE IS ON FILE (operator ruling 2026-09-28: "elec got held up at
 *  the site contact phone #, assuming due to there not being one on file, if that happens just do
 *  000-000-0000"). A required portal phone box with no number stopped the replay; the operator's
 *  practice is this placeholder. Only when neither the homeowner's nor the owner's phone is known. */
export const NO_SITE_CONTACT_PHONE = "000-000-0000";
export function homeownerPhoneOrNone(snapshotFlat: Record<string, unknown>): string {
  return String(snapshotFlat.homeownerPhone || snapshotFlat.ownerPhone || "").trim() || NO_SITE_CONTACT_PHONE;
}

/**
 * `track` is the filing this run is for ("building" / "electrical" / "combo" / "mpu" / "nem"; null
 * when the caller cannot say). REQUIRED on purpose: the licence keys answer "the licence THIS permit
 * takes in THIS state" (clients.licenceOverlay), and a caller that forgets the track must decide to
 * pass null — which makes a generic licence key blank when several licences could fit.
 */
export function resolveRecipeFieldValues(db: AppDb, project: ProjectRecord, portalType: string, track: string | null): Record<string, string> {
  const snapshot = project.parserSnapshot || {};
  const snapshotFlat: Record<string, string> = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (v == null || typeof v === "object") continue;
    const s = String(v);
    // Fill values are short scalars. Long free-text blobs (plan-set extracted text,
    // split-page mappings, checklists, notes) are evidence for the reviewer gate, not
    // portal field values — and because projectFields is serialized into EVERY LLM
    // planning call, letting them through multiplies token spend per call (a 150KB
    // plan-set text is ~40k tokens on every planPortalFields call).
    if (k === "planSetExtractedText" || s.length > 400) continue;
    snapshotFlat[k] = s;
  }

  // Derive split first/last from full homeowner name so portals with separate
  // first/last inputs get proper field bindings instead of LLM-guessed literals.
  const hoFullName = (project.homeownerName || "").trim();
  const hoNameParts = hoFullName.split(/\s+/);
  const homeownerFirstName = hoNameParts[0] || "";
  const homeownerLastName = hoNameParts.slice(1).join(" ") || "";

  // Street-only address (no city/state/zip) for portals that split the address.
  // Comma-delimited addresses split cleanly; a comma-LESS parsed address ("7307 SW Arranmore
  // Way Portland OR 97223" — common from OCR) would leak city/state/zip into the street
  // field, so also strip a trailing "<city> [ST [zip]]" tail when it matches the project.
  // The whole street line, city/state/zip removed — shared with the learn adapter, which
  // needs the identical value to correct a planner fill that truncated it.
  const streetOnly = parseStreetLine(project.projectAddress || "", project.city || undefined);

  // AN INTERCONNECTION IS FILED UNDER THE NAME ON THE BILL.
  //
  // The permit goes under the property owner; the interconnection goes under whoever holds
  // the utility ACCOUNT, and they are routinely different people. Live: Ivy's account reads
  // "PROF CHRIS A IVY" where the project says "Christopher Ivy", and Marineau's account is
  // held by CRAIG while the plan set names ANN — a joint account. Filing a NEM application
  // under a name the utility has no account for is a rejection, or worse, a second account.
  //
  // Operator rule: intake keys off the project, submittal keys off the bill. So on a UTILITY
  // portal the homeowner* bindings resolve to the account holder, which fixes recipes already
  // recorded against homeownerName without re-recording them. ubAccountHolder* is also
  // exposed in its own right so a fresh recording can bind to it explicitly.
  // FALL BACK TO THE HOMEOWNER WHEN NO BILL WAS PARSED — the same rule the account holder's
  // email and phone already follow, and for the same reason: a blank required field fails
  // the submission outright. Without this, ubAccountHolder* is only safe to bind on projects
  // that happen to have a readable bill, so a recording binds the customer block to
  // homeowner* instead "to be safe" — and then a filing names the wrong person the moment
  // the account holder is not the homeowner. That is exactly what happened on PacifiCorp
  // APP-111681, where the customer block was bound to homeownerFirstName/LastName and the
  // application went out as David Simmons against Stephanie Simmons' account.
  // With the fallback the keys are always populated, so the customer block can be bound to
  // the account holder unconditionally: identical output when the holder IS the homeowner,
  // correct output when they differ.
  const ubHolder = String(snapshotFlat.ubAccountHolder || "").trim() || String(project.homeownerName || "").trim();
  // A billing name often carries a title ("PROF CHRIS A IVY"). Keep the full string for the
  // account-name field — it should match the bill — but drop the title before splitting, or
  // the first-name box gets "PROF".
  const ubNameParts = ubHolder.replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, "").split(/\s+/).filter(Boolean);
  const ubFirstName = ubNameParts[0] || "";
  const ubLastName = ubNameParts.length > 1 ? ubNameParts[ubNameParts.length - 1] : "";

  // PER-JOB PORTAL ANSWERS (migration v17): ownership/financing, system configuration,
  // disconnect-to-meter distance — the questions the live PacifiCorp/Ameren runs proved
  // portals ask and the project record could not answer, so recipes froze the learn
  // project's answer (or left the control blank). Read the COLUMNS directly: mapProject
  // (repository.ts) predates these fields, and an answer the intake link wrote five
  // minutes ago must reach replay either way. The in-memory record field wins when a
  // future mapping sets it; the parser snapshot is the last fallback.
  let answersRow: Record<string, unknown> | undefined;
  try {
    answersRow = db.query<Record<string, unknown>>(
      "SELECT ownership_model, system_configuration, disconnect_within_10ft FROM projects WHERE id = ?",
      [project.id],
    )[0];
  } catch { /* pre-migration DB or a project never persisted — fall through to record/snapshot */ }
  const perJobAnswer = (recordValue: unknown, columnValue: unknown, snapshotValue: unknown): string =>
    String(recordValue ?? "").trim() || String(columnValue ?? "").trim() || String(snapshotValue ?? "").trim();
  // ownershipModel: NO default, ever — financing is never guessable from documents.
  // Empty resolves to "" so replay leaves the control blank and REPORTS it: the safe
  // direction. The frozen alternative filed "Customer-Owned" on third-party-owned jobs.
  const ownershipModel = renderPerJobAnswer(
    perJobAnswer(project.ownershipModel, answersRow?.ownership_model, snapshotFlat.ownershipModel),
    OWNERSHIP_MODEL_RENDER,
  );
  // systemConfiguration: the ONE safe default. Every residential NEM filing in this
  // fleet is behind-the-meter — a rooftop system on a home offsets that home's own
  // metered load; community solar is an off-site subscription product that never enters
  // this pipeline. The default is GUARDED on the project having a utility account (the
  // evidence there is a meter for the system to sit behind) and is overridable per
  // project via the column; the resolved value is visible in the staged-fill report
  // like every other binding. A project with no account on file resolves "" — blank and
  // reported beats a guess.
  const hasUtilityAccount =
    String(project.accountNumber || "").trim() !== "" || String(snapshotFlat.accountNumber || "").trim() !== "";
  const systemConfiguration = renderPerJobAnswer(
    perJobAnswer(project.systemConfiguration, answersRow?.system_configuration, snapshotFlat.systemConfiguration),
    SYSTEM_CONFIGURATION_RENDER,
  ) || (hasUtilityAccount ? "Behind the Meter" : "");
  // disconnectWithin10ft: NO default — a site fact (PGE's distance-to-meter policy
  // questions), measured on the roof-side of a truck roll, not inferable here.
  const disconnectWithin10ft = renderPerJobAnswer(
    perJobAnswer(project.disconnectWithin10ft, answersRow?.disconnect_within_10ft, snapshotFlat.disconnectWithin10ft),
    YES_NO_ANSWER_RENDER,
  );
  // TWO ROLES, TWO FIELDS — DO NOT COLLAPSE THEM.
  //
  // A first cut made homeownerName resolve to the account holder on any utility portal. That
  // is wrong wherever the form asks for BOTH, and PacifiCorp's does: page 3 is "Customer
  // Information" (the account holder) and page 4 is "Property Owner Information" (the person
  // who owns the house). Overriding homeownerName would have put PROF CHRIS A IVY into the
  // property-owner block, which is a different assertion about a different person.
  //
  // So homeowner* stays the property owner, always and on every portal, and the account
  // holder has its own name. A recording binds the customer block to ubAccountHolder* and the
  // owner block to homeowner*, which is what the form is actually asking for.
  const projectFields: Record<string, string> = {
    homeownerName: project.homeownerName,
    // The permit's "Project Name" always follows the PROJECT, never the billing name — it is
    // how the AHJ and the inspector find the job.
    // Bound, never frozen: a recipe is shared across every project under the profile, so a
    // literal here would file every future job under the learn project's homeowner.
    projectName: project.homeownerName,
    // Always available by their own names, whichever portal this is.
    ubAccountHolder: ubHolder,
    // Operator policy: participate in the utility's battery programme only when the job
    // actually has storage. Answering yes on a PV-only system invites battery requirements
    // for equipment that is not there.
    wattsmartBatteryProgram: /^(yes|true|y)$/i.test(String(snapshotFlat.hasBattery ?? "").trim()) ? "Yes" : "No",
    ubAccountHolderFirstName: ubFirstName,
    ubAccountHolderLastName: ubLastName,
    // The account holder's own contact details when the bill carries them; otherwise the
    // homeowner's, which is who the utility would reach about this address anyway. Never
    // blank — an empty required contact field fails the submission outright.
    ubAccountHolderEmail: String(snapshotFlat.ubAccountHolderEmail || snapshotFlat.homeownerEmail || ""),
    ubAccountHolderPhone: String(snapshotFlat.ubAccountHolderPhone || "").trim() || homeownerPhoneOrNone(snapshotFlat),
    homeownerFirstName,
    homeownerLastName,
    homeownerEmail: String(snapshotFlat.homeownerEmail || snapshotFlat.ownerEmail || ""),
    homeownerPhone: homeownerPhoneOrNone(snapshotFlat),
    street: streetOnly || project.projectAddress,
    // Accela-style address SEARCH forms take the number and CORE street name in separate
    // boxes. The learner's work-location pass records its fills bound to these keys so a
    // shared recipe replays THIS project's address, never the learn project's literals.
    streetNumber: parseStreetNumber(project.projectAddress || ""),
    streetNameCore: parseStreetName(project.projectAddress || ""),
    // Bound instead of streetNameCore when the LEARN run's full-name search returned
    // zero results and its 3-char retry succeeded (the portal's own search hint).
    streetNameSearchPortion: parseStreetName(project.projectAddress || "").slice(0, 3),
    // SEGMENTED PHONE parts. Accela renders a US phone as three boxes (area/prefix/line);
    // recording the digits as literals would replay the LEARN project's phone number for
    // every future project, so each segment binds to its own derived key.
    ...phoneSegmentKeys("homeownerPhone", homeownerPhoneOrNone(snapshotFlat)),
    projectAddress: project.projectAddress,
    city: project.city,
    state: project.state,
    zip: project.zip,
    ahj: project.ahj,
    utility: project.utility,
    accountNumber: project.accountNumber,
    meterNumber: project.meterNumber,
    systemSizeDcKw: project.systemSizeDcKw == null ? "" : String(project.systemSizeDcKw),
    systemSizeAcKw: project.systemSizeAcKw == null ? "" : String(project.systemSizeAcKw),
    totalExportKw: project.totalExportKw == null ? "" : String(project.totalExportKw),
    interconnectionMethod: project.interconnectionMethod,
    // DATES ARE COMPUTED AT REPLAY, NEVER FROZEN. A portal date field has no project
    // value to bind to, so the learn-time planner computes one (llm.ts tells it to use
    // todayDate plus a few weeks) and — because convertLiteralsToBoundFields deliberately
    // skips the volatile todayDate — that computed value used to freeze into the recipe.
    // The live PGE recipe carried "08/08/2026" as its Estimated Commissioning Date: fine
    // the day it was learned, a PAST date by the time this was written, and every future
    // project would have filed it. These fields let the binder swap such a literal for a
    // binding that is recomputed on every replay. Both formats exist because the recorded
    // literal proves which one the portal accepted.
    // AC DISCONNECT. Utility interconnection portals ask for this by make/model/rating and
    // PacifiCorp REQUIRES it — a learn against a real project failed promotion on exactly
    // "Disconnect Switch Manufacturer" and "Disconnect Switch Model".
    //
    // The plan set's equipment schedule DOES carry the rating ("AC DISCONNECT 1 60A
    // NON-FUSIBLE AC DISCONNECT, 240V"), so those come from the parser. It does NOT carry
    // the make/model: the schedule leaves the part to the installer, and the manufacturer
    // named nearby belongs to the COMBINER PANEL, not the disconnect. So make/model is
    // operator knowledge (like the contract amount) and falls back to a per-installer
    // default. `disconnectMakeModel` is what a portal with ONE combined field wants.
    disconnectQty: String(snapshotFlat.acDiscQty ?? "").trim() || "1",
    disconnectAmps: String(snapshotFlat.acDiscAmps ?? "").trim(),
    disconnectVoltage: String(snapshotFlat.acDiscVoltage ?? "").trim(),
    disconnectType: String(snapshotFlat.acDiscFused ?? "").trim(),
    disconnectMake: String(snapshotFlat.acDiscMake ?? "").trim(),
    disconnectModel: String(snapshotFlat.acDiscModel ?? "").trim(),
    disconnectMakeModel: [String(snapshotFlat.acDiscMake ?? "").trim(), String(snapshotFlat.acDiscModel ?? "").trim()]
      .filter(Boolean).join(" ").trim(),

    // BUILDING GEOMETRY AND THE PERMIT NARRATIVE — the answers an AHJ application asks for
    // that were being FROZEN from the learn project. Coos Bay's Accela recipe carried "1675"
    // square feet, "15" feet of building height and a comments line naming the learn job's
    // 8.36 kW system onto every future filing, and the cross-project sweep could not see it:
    // the sweep compares against the fixture's value sets, and a number neither project
    // declares lands in "unverifiable", not "leaked". The question bank found them by reading
    // the recipe instead of the run (see docs/HANDOFF.md, 2026-09-12).
    //
    // Parsed where the plan set states them — never another house's. Where it does not, "0"
    // (operator ruling 2026-09-27, Michael Sheridan's Marion building page refused three blanks:
    // "Just put 0's there, that's what we do normally"): a rooftop retrofit's permit geometry is
    // entered as 0 by the operators themselves, and a blank only stops the filing.
    existingBuildingArea: String(snapshotFlat.existingBuildingArea ?? "").trim() || "0",
    buildingHeightFeet: String(snapshotFlat.buildingHeightFeet ?? "").trim() || "0",
    buildingHeightInches: String(snapshotFlat.buildingHeightInches ?? "").trim() || "0",
    numberOfStories: String(snapshotFlat.numberOfStories ?? "").trim() || "0",
    // Defaults that are facts about a ROOFTOP RETROFIT rather than about a project: adding
    // panels to an existing roof creates no new building area, and the permit covers the one
    // house the array sits on. The plan set overrides both whenever it says otherwise.
    newBuildingArea: String(snapshotFlat.newBuildingArea ?? "0").trim(),
    dwellingUnits: String(snapshotFlat.dwellingUnits ?? "1").trim(),
    numberOfBuildings: String(snapshotFlat.numberOfBuildings ?? "1").trim(),
    // The county the SITE is in — asked by Ameren, and previously frozen as "Sangamon" (the
    // benchmark project's county) on every Illinois filing. Parsed when the documents name it;
    // otherwise blank, never inferred from the state.
    county: String(snapshotFlat.county ?? snapshotFlat.projectCounty ?? "").trim(),
    // The scope-of-work sentence permit portals ask for free-text. Derived from THIS project's
    // own numbers so it can never carry another job's system size, which is exactly what the
    // frozen "Roof-mounted residential solar PV system, 8.36 kW DC / 7.68 kW AC" was doing.
    workDescription: (() => {
      const explicit = String(snapshotFlat.workDescription ?? snapshotFlat.description ?? "").trim();
      if (explicit) return explicit;
      const dc = String(snapshotFlat.dcKw ?? snapshotFlat.systemSizeDcKw ?? "").trim();
      const ac = String(snapshotFlat.acKw ?? snapshotFlat.systemSizeAcKw ?? "").trim();
      // THE ONE MOUNT PREDICATE (codeReviewRules.mountKindForProject — the parser's `mounting`, then
      // `mountType`, then the design text). It read only the dead mountType key, so every job —
      // ground and carport included — was described as "Roof-mounted". Unknown: no adjective.
      const mount = mountAdjective(mountKindForProject(project));
      if (!dc && !ac) return "";
      const size = [dc ? `${dc} kW DC` : "", ac ? `${ac} kW AC` : ""].filter(Boolean).join(" / ");
      return mount ? `${mount} residential solar PV system, ${size}` : `Residential solar PV system, ${size}`;
    })(),
    // THE VALUATION A JOB VALUE / VALUATION / ESTIMATED COST BOX TAKES — the operator's formula of
    // the contract (filingValuationText → resolveValuation), the SAME whole-dollar figure the PDF
    // application files. ALWAYS emitted, "" when nothing can be computed: a box bound here then
    // replays blank and is named, never the recorded contract.
    declaredValuation: filingValuationText(snapshot as never, project.systemSizeDcKw),
    ...dateFields(),
    // EXPORT LIMITING. Derived here, not only in the learner's planner map: a step that
    // BINDS to this key must resolve at REPLAY time, and it used to exist only at learn
    // time — so a recipe binding it filled nothing, forever, silently. Same derivation the
    // learner uses (autoLearn.ts), kept in the resolver so both sides agree by construction.
    exportLimiting:
      /non.?export|export.?limit\b|power control system|\bpcs\b|\bngom\b/i
        .test(`${snapshotFlat.exportMode ?? ""} ${snapshotFlat.pcs ?? ""} ${snapshotFlat.exportLimit ?? ""}`)
        ? "Yes" : "No",
    // ENERGY SOURCE — the GATE for a portal's whole battery section, and the reason it is
    // derived here rather than left as a recorded literal.
    //
    // PacifiCorp's recipe learned on a project WITH a Tesla battery recorded the literal
    // "Solar PV and Battery" with no field binding, so replaying it onto a project without
    // storage would have declared a battery that does not exist on an interconnection
    // application. The same portal's earlier learns, on projects WITHOUT batteries,
    // recorded "Solar PV" and carried ZERO battery steps — the portal only renders that
    // section once Battery is chosen. So this one answer decides whether ~17 downstream
    // questions are asked at all, and it must follow the project rather than whichever
    // system happened to be learned.
    //
    // Both option strings are taken from real recorded recipes for this portal, not
    // invented: "Solar PV" (v4/v6 backups) and "Solar PV and Battery" (v9).
    // hasBattery is set by normalize.ts, so it is present on real projects — but fall back
    // to the same inputs normalize derives it from, so this cannot silently answer "no
    // battery" for a snapshot that simply never went through normalisation.
    energySource: (
      /^y/i.test(String(snapshotFlat.hasBattery ?? "").trim())
      || String(snapshotFlat.batteryModel ?? "").trim() !== ""
      || Number(snapshotFlat.batteryQty ?? 0) > 0
    ) ? "Solar PV and Battery" : "Solar PV",
    // PER-JOB PORTAL ANSWERS, resolved above. ALWAYS emitted — even empty — so
    // deadFieldBindings sees the keys as resolvable (an empty value for THIS project is
    // fine; a key that cannot exist at all is dead) and the post-learn binder can offer
    // them for the frozen literals the live sweep found.
    ownershipModel,
    systemConfiguration,
    disconnectWithin10ft,
  };
  // EQUIPMENT BINDING (portal-agnostic). The PV module spec lives in a nested `pvArrays`
  // array in the parser snapshot, which the scalar-only flatten above drops — so the module
  // make/model/quantity never reached the planner and the equipment dropdowns came back
  // blank. Flatten it into scalar keys here, plus the key ALIASES the planner prompt already
  // references (moduleMake/moduleQty/inverterMake/inverterQty), so a value exists regardless
  // of which name a given portal's field maps to. Every utility/AHJ on any platform benefits;
  // nothing here is portal-specific. Only non-empty values are emitted (so they never blank
  // out a snapshot/overlay value via the merge below).
  const equipment: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    const s = v == null ? "" : String(v).trim();
    if (s) equipment[k] = s;
  };
  // Inverter aliases (snapshot uses *Manufacturer/*Quantity; the prompt/portals also say make/qty).
  put("inverterMake", snapshotFlat.inverterManufacturer || snapshotFlat.inverterMake);
  put("inverterQty", snapshotFlat.inverterQuantity || snapshotFlat.inverterQty);
  // Canonical inverter model (the parser stores it as invModel or pvMicroModel) so the
  // planner, the deterministic equipment pass, and recipe replay all bind one key.
  put("inverterModel", snapshotFlat.inverterModel || snapshotFlat.invModel || snapshotFlat.pvMicroModel);
  const arraysRaw = (snapshot as Record<string, unknown>).pvArrays;
  if (Array.isArray(arraysRaw) && arraysRaw.length) {
    let totalModules = 0;
    let firstMake = "";
    let firstModel = "";
    let firstWattage = "";
    arraysRaw.forEach((a, i) => {
      const arr = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
      const qty = arr.quantity ?? arr.moduleQuantity ?? arr.qty;
      const make = arr.moduleManufacturer ?? arr.moduleMake ?? arr.manufacturer;
      const model = arr.moduleModel ?? arr.model;
      const watt = arr.moduleWattage ?? arr.wattage ?? arr.watts;
      const n = Number(qty);
      if (!isNaN(n)) totalModules += n;
      if (!firstMake && make) firstMake = String(make);
      if (!firstModel && model) firstModel = String(model);
      if (!firstWattage && watt) firstWattage = String(watt);
      // Per-array indexed keys for portals with a repeater (one row per array/string).
      const p = `array${i + 1}`;
      put(`${p}ModuleQuantity`, qty);
      put(`${p}ModuleManufacturer`, make);
      put(`${p}ModuleModel`, model);
      put(`${p}ModuleWattage`, watt);
      // WHOLE DEGREES. Plan sets carry fractional orientations ("180.5"), but the utility
      // portals ask for degrees as an integer — filing the decimal was flagged live on the
      // PacifiCorp form. Half a degree is far below anything that changes an
      // interconnection review, so round rather than truncate or pass it through.
      put(`${p}Azimuth`, wholeDegrees(arr.azimuth));
      put(`${p}Tilt`, wholeDegrees(arr.tilt));
    });
    // The bare aliases some portals bind to come from the raw snapshot, which keeps the
    // plan-set decimal — round those the same way so no path can reach a portal with a
    // fractional degree. `equipment` overrides snapshotFlat in the merge below.
    put("azimuth", wholeDegrees(snapshotFlat.azimuth));
    put("tilt", wholeDegrees(snapshotFlat.tilt));
    put("moduleManufacturer", firstMake);
    put("moduleMake", firstMake);
    put("moduleModel", firstModel);
    put("moduleWattage", firstWattage);
    if (totalModules > 0) {
      put("moduleQuantity", totalModules);
      put("moduleQty", totalModules);
      put("totalModuleQuantity", totalModules);
    }
  } else {
    // No array repeater — carry any flat module scalars + their aliases through.
    put("moduleManufacturer", snapshotFlat.moduleManufacturer || snapshotFlat.moduleMake);
    put("moduleMake", snapshotFlat.moduleManufacturer || snapshotFlat.moduleMake);
    put("moduleModel", snapshotFlat.moduleModel);
    put("moduleQty", snapshotFlat.moduleQuantity || snapshotFlat.moduleQty);
    put("moduleQuantity", snapshotFlat.moduleQuantity || snapshotFlat.moduleQty);
    put("moduleWattage", snapshotFlat.moduleWattage);
  }

  // EXISTING-SYSTEM / NEM-ADDITION BINDINGS. Additions must disclose the existing
  // system's size/equipment and the combined totals on interconnection applications.
  // Values come from the project's structured existingSystem block (intake/manual);
  // only non-empty values are emitted so they never blank another layer.
  // existingNemAgreementNumber / existingNemApplicationNumber are account-linked
  // identifiers — they bind here BY NAME for deterministic replay, and
  // buildPortalPlanner strips them (key + value match) before anything reaches the
  // LLM, same as accountNumber/meterNumber (safety rule 2).
  const existingSys: Record<string, string> = {};
  const es = project.existingSystem;
  if (es) {
    const putEs = (k: string, v: unknown) => {
      const s = v == null ? "" : String(v).trim();
      if (s) existingSys[k] = s;
    };
    putEs("hasExistingSystem", es.hasExistingSystem ? "Yes" : "");
    putEs("existingSystemSizeDcKw", es.existingDcKw);
    putEs("existingDcKw", es.existingDcKw);
    putEs("existingSystemSizeAcKw", es.existingAcKw);
    putEs("existingAcKw", es.existingAcKw);
    putEs("totalSystemSizeDcKw", es.combinedDcKw);
    putEs("combinedDcKw", es.combinedDcKw);
    putEs("totalSystemSizeAcKw", es.combinedAcKw);
    putEs("combinedAcKw", es.combinedAcKw);
    putEs("existingInverterMake", es.existingInverterMake);
    putEs("existingInverterModel", es.existingInverterModel);
    putEs("existingInverterQty", es.existingInverterQty);
    putEs("existingModuleMake", es.existingModuleMake);
    putEs("existingModuleModel", es.existingModuleModel);
    putEs("existingBatteryMakeModel", es.existingBatteryMakeModel);
    putEs("nemTariff", es.nemTariff);
    putEs("existingPtoDate", es.ptoDate);
    putEs("existingNemAgreementNumber", es.agreementNumber);
    putEs("existingNemApplicationNumber", es.applicationNumber);
    putEs("exportMode", es.exportMode);
  }
  // THE EXISTING SYSTEM'S PTO IN BOTH FORMATS a portal has shown it accepts (the date binder picks
  // the one the recorded literal proved). ALWAYS present — "" for a project with no existing system —
  // so a recipe bound to it replays blank on a greenfield job, never another project's date.
  {
    const v = usAndIsoDate(es?.ptoDate);
    existingSys.existingPtoDateUs = v.us;
    existingSys.existingPtoDateIso = v.iso;
  }

  const job = { state: String(project.state ?? ""), track };
  const overlay = project.clientId ? clientStagingOverlay(db, project.clientId, portalType, job) : {};
  // EVERY LICENCE KEY IS PRESENT, "" WHERE NOTHING OF THE NEEDED KIND IS ON FILE — including a job
  // with no client. A recipe step bound to a key the dictionary defines replays that key's value,
  // blank included; a key the dictionary LACKS falls back to the step's recorded literal, and a
  // literal licence is the LEARN company's (recipes are shared across companies and orgs). So a
  // licence never comes from the snapshot or a recording — only from THIS project's client.
  const licenceKeys = licenceOverlayForClient(db, project.clientId, job);

  // Derive split installer first/last from the full installer contact name (mirrors the
  // homeowner split above). The overlay only provides a full `installerContactName`, so a
  // portal with separate first/last installer inputs (e.g. PGE PowerClerk Preparer/Installer
  // pages) had no binding to hit — the planner then guessed, and the company name bled into
  // the Name field. Only emit when non-empty so we never blank a real value via the merge.
  const installerSplit: Record<string, string> = {};
  const instFullName = String(overlay.installerContactName || "").trim();
  if (instFullName) {
    const parts = instFullName.split(/\s+/);
    installerSplit.installerFirstName = parts[0] || "";
    installerSplit.installerLastName = parts.slice(1).join(" ") || "";
  }

  // Precedence: snapshot scalars → derived equipment aliases → existing-system block → explicit project fields →
  // client licensing overlay → derived installer name split (each later layer wins).
  // PORTAL-READY EQUIPMENT MODELS, resolved last so it can see the merged equipment map.
  // A portal's dropdown lists CEC strings and the plan set's model is a prefix of them
  // ("DS3-L" vs "DS3-L {240V}"). Resolved HERE, where the CEC table lives, rather than in
  // the browser: PowerClerk renders a native <select> on one page and a Vue combobox
  // <input> on another, and a combobox has no <option> elements for a page-side matcher to
  // read — so it gave up exactly where the equipment matters. Empty when the CEC list is
  // unsynced or the choice is ambiguous, leaving the plan-set value to be used unchanged.
  const certifiedModels = certifiedModelFields(db, snapshotFlat, equipment);
  // FEE BRACKET QUANTITIES — one key per bracket of THIS project's stored fee
  // schedule, "1" for the bracket the job falls in and "0" for the others (see
  // feeBracketFields.ts for why that is a per-project fact and not a recordable
  // one). Resolved last and namespaced with a colon, so it can collide with
  // nothing above it. EMPTY when nothing is certain — no schedule, no size, a
  // size outside the table, or the fee evaluator disagreeing — because a recipe
  // that gets no keys replays its recorded literal exactly as it does today, and
  // an unbound literal is visible in a way a computed 0 is not.
  const feeBrackets = feeBracketQuantityFields(db, project);
  const merged: Record<string, string> = { ...snapshotFlat, ...equipment, ...existingSys, ...projectFields, ...overlay, ...licenceKeys, ...installerSplit, ...certifiedModels, ...feeBrackets };
  // A WHOLE-PHONE VALUE IS TYPED INTO A MASKED BOX VERBATIM. A number stored E.164
  // ("+15414042243") fed to a "(###) ###-####" mask keeps its first ten digits —
  // "(154) 140-4224" — and drops the last one: a valid-looking phone belonging to nobody,
  // live on Simmons's NEM. The segment keys already strip the country code (phoneSegmentKeys);
  // the whole-number keys get the same treatment, formatted the way US portals render it.
  // Anything that isn't a clean 10-digit US number is left untouched — never fabricate.
  for (const [k, v] of Object.entries(merged)) {
    if (!/phone$/i.test(k) || !v) continue;
    const digits = String(v).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (digits.length === 10) merged[k] = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  // THE COMPANY FACTS BESIDE THE LICENCE — insurance / bond carrier and expiry, the installer's street
  // number and name — from THIS project's own client, every key present ("" when not on file), so a
  // recipe box bound to one never falls back to the learn company's recorded answer.
  Object.assign(merged, clientCompanyFactFields(db, project.clientId));
  // A PLACEHOLDER IS NOT A LICENCE (leak sweep 2026-09-28). A licence / docket / registration value
  // shaped like a test or placeholder ("TEST-160001", "XXX…", "0000") is never filed: the key stays,
  // blank, and QC names it on the client record (runQcForProject). And the ICC docket is Illinois's
  // (Part 468 DG certification): on any other state's job it is present but blank — never another
  // state's number in a box that asks for this one.
  // The identifier keys are ALWAYS present ("" when nothing real is on file): a recipe step bound to
  // one then replays blank and is named, never the recorded literal of the company that learned it.
  // One list: the licence keys licenceOverlay answers (clients.LICENCE_OVERLAY_KEYS), plus the two
  // identifiers it does not (the metro/city licence and the ICC docket).
  for (const k of [...LICENCE_OVERLAY_KEYS, "metroCityLicenseNumber", "docketNumber"]) {
    if (!Object.prototype.hasOwnProperty.call(merged, k)) merged[k] = "";
  }
  for (const k of Object.keys(merged)) {
    if (COMPANY_IDENTIFIER_KEY.test(k) && looksLikePlaceholderIdentifier(merged[k])) merged[k] = "";
  }
  if (usStateCode(project.state) !== "IL") merged.docketNumber = "";
  // The metro / city business licence is Portland Metro's — an Oregon licence: blank on any other
  // state's job (and on a job with no recorded state), never one region's number in another's box.
  if (licenceJobState(project.state) !== "OR") merged.metroCityLicenseNumber = "";
  // THE AC DISCONNECT PART (leak sweep 2026-09-28) — resolved AFTER the merge, because the client
  // overlay used to win it outright: a plan set naming "Square D DU222RB" was filed as the client's
  // standard Eaton DG221URB, and a plan set calling for a 60 A FUSIBLE switch was filed with a 30 A
  // non-fused part beside "60A / fusible" — two contradictory facts on one utility application.
  //   - the plan set's own part (acDiscMakeModel, split; baselineRules.planSetDisconnectPart) wins;
  //   - else the client's standard part — unless it contradicts the plan set's rating or fusing
  //     (baselineRules.standardDisconnectConflicts, the same check QC names for the operator), in
  //     which case make and model are BLANK: the portal stops on them, QC says why, nothing is guessed;
  //   - disconnectMakeModel is always the final make + model, never a separately-derived string.
  {
    const planPart = planSetDisconnectPart(snapshotFlat);
    let make = "";
    let model = "";
    if (planPart.named) {
      make = planPart.make;
      model = planPart.model;
    } else {
      const stdMake = String(overlay.disconnectMake ?? "").trim();
      const stdModel = String(overlay.disconnectModel ?? "").trim();
      const ampsRaw = String(snapshotFlat.acDiscAmps ?? "").replace(/[^0-9.]/g, "");
      const conflicts = standardDisconnectConflicts(stdModel, { fused: snapshotFlat.acDiscFused, amps: ampsRaw ? Number(ampsRaw) : null });
      if (!conflicts.length) { make = stdMake; model = stdModel; }
    }
    merged.disconnectMake = make;
    merged.disconnectModel = model;
    merged.disconnectMakeModel = [make, model].filter(Boolean).join(" ").trim();
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Post-learn binding pass.
//
// The auto-learned recipe is the ONLY home for a portal's specifics, so any fill the
// learner recorded as a frozen LITERAL `value` (instead of a reusable `field` binding)
// replays verbatim on every future project. When that literal happens to be THIS project's
// own data (homeowner name, site address, system size, …), replaying it onto a DIFFERENT
// project produces wrong-but-plausible data that per-project verification — which only checks
// against the learn-project's data — can never catch.
//
// This deterministic pass converts a recorded literal into a `field` binding when the literal
// equals exactly one project field value. A literal matching MULTIPLE field values is AMBIGUOUS
// (we can't know which key the portal expects) — left literal and reported, so the caller can
// refuse to promote the recipe. Truly portal-specific literals (dropdown options, "Yes"/"No",
// "Solar") match no project value and are kept as-is.
// ---------------------------------------------------------------------------
export interface LiteralBindingResult {
  steps: RecipeStep[];
  /** Literals uniquely matched and converted to field bindings. */
  bound: Array<{ value: string; field: string; note?: string }>;
  /** Literals that equal project data but map to >1 field — cannot be safely auto-bound. */
  ambiguous: Array<{ value: string; candidates: string[]; note?: string }>;
  /**
   * Literals that COLLIDED with project data by coincidence — the control's label shows it
   * is asking something else entirely (a portal policy question), so the literal is kept
   * and the collision is reported for awareness rather than blocking the recipe.
   */
  portalConstants: Array<{ value: string; note?: string }>;
}

// Disambiguate a literal that matches SEVERAL project fields, using the control's own
// label. A Yes/No portal question is the common case: "No" is equally the value of
// hasBattery and of exportLimiting, so the binder refused to bind either and treated the
// ambiguity as a hard blocker — which by itself kept the live PGE recipe out of trust. The
// control was labelled "Energy Storage", which says plainly which field it is.
// Synonyms bridge the portal's wording to the field's name; a candidate wins only if it is
// the UNIQUE best match, so a genuinely ambiguous literal still blocks as before.
const FIELD_TOKEN_SYNONYMS: Record<string, string[]> = {
  battery: ["battery", "batteries", "storage", "ess"],
  export: ["export", "exporting"],
  limiting: ["limit", "limiting", "limited", "curtail", "curtailment"],
  phone: ["phone", "telephone", "mobile", "cell"],
  email: ["email", "e-mail"],
  zip: ["zip", "postal"],
  street: ["street", "address"],
  installer: ["installer", "contractor", "company"],
  homeowner: ["homeowner", "owner", "customer", "applicant"],
};
function fieldNameTokens(field: string): string[] {
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t && !["has", "is", "the", "of", "a", "an", "no", "number"].includes(t));
  const out = new Set<string>();
  for (const w of words) for (const t of (FIELD_TOKEN_SYNONYMS[w] ?? [w])) out.add(t);
  return [...out];
}
// A TOKEN IS A WORD, NOT A SUBSTRING (leak sweep 2026-09-28). acDiscReq's token "ac" matched inside
// "ACcessible", so "Is the meter socket accessible 24/7?" = Yes was bound to the parser's
// disconnect-is-shown flag. A token hits only as a whole word (a plural "s" allowed).
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function labelHasToken(text: string, token: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRe(token)}s?(?![a-z0-9])`, "i").test(text);
}
/** Does the control's label name this field (a whole-word token hit)? */
export function labelNamesField(label: string, field: string): boolean {
  const text = labelWords(String(label || "")).toLowerCase();
  return fieldNameTokens(field).some((t) => labelHasToken(text, t));
}
export function disambiguateByLabel(label: string, candidates: string[]): string | null {
  const text = labelWords(String(label || "")).toLowerCase();
  if (!text.trim() || candidates.length < 2) return null;
  const scored = candidates.map((c) => {
    const toks = fieldNameTokens(c);
    const hit = toks.filter((t) => labelHasToken(text, t));
    return { c, n: hit.length, extra: toks.length - hit.length };
  });
  const best = Math.max(...scored.map((x) => x.n));
  if (best === 0) return null;
  let winners = scored.filter((x) => x.n === best);
  // Tiebreak on PRECISION: "Installation Voltage" matches both serviceVoltage and voltage
  // on the token "voltage", but serviceVoltage also carries "service", which the label does
  // not say. The candidate with nothing left over is the better read of the label.
  if (winners.length > 1) {
    const fewest = Math.min(...winners.map((x) => x.extra));
    winners = winners.filter((x) => x.extra === fewest);
  }
  return winners.length === 1 ? winners[0].c : null;
}

// A literal can match project data by COINCIDENCE. PacifiCorp asks "Will the net metering
// facility interconnect to a switchgear?", "…include a parallel blocking scheme?", "…serve
// more than one customer?" — four separate questions whose answer is "No", which is also
// this project's hasBattery and exportLimiting. Binding any of them would be actively
// wrong: a later project with a battery would flip its answer about a switchgear. But
// REPORTING them as ambiguous is a hard blocker in the trust gate, and it kept the
// PacifiCorp recipe out of trust over a question that has nothing to do with the fields it
// collided with.
//
// A label that is SUBSTANTIVE and shares nothing with any candidate's name is strong
// evidence the control is a portal constant, not project data. A thin or missing label is
// not evidence of anything, so that case still blocks exactly as before.
const LABEL_STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "is", "are", "will", "do", "does", "you", "your",
  "this", "that", "for", "and", "or", "be", "on", "at", "it", "if", "any", "please", "select",
]);
export function labelRulesOutAllCandidates(label: string, candidates: string[]): boolean {
  const text = labelWords(String(label || "")).toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !LABEL_STOPWORDS.has(w));
  if (new Set(words).size < 3) return false; // too thin to conclude anything
  return candidates.every((c) => fieldNameTokens(c).every((t) => !labelHasToken(text, t)));
}

// Steps bound to a field name the project data does not define. The LLM planner CHOOSES
// the field a fill binds to (autoLearnAdapter sets `step.field = fillReq.field` verbatim),
// and an invented key resolves to "" on every replay forever: resolveValue returns empty,
// the step returns false, and it is SKIPPED IN SILENCE. Found live — the PacifiCorp recipe
// binds `descriptionOfService`, which no resolver produces, so that select could never fill
// on any project, and the blank it left changed the portal's branching two pages later.
export function deadFieldBindings(steps: RecipeStep[], projectFields: Record<string, string>): string[] {
  const known = new Set(Object.keys(projectFields ?? {}));
  const out: string[] = [];
  for (const step of steps ?? []) {
    const field = String(step.field ?? "");
    // A FEE BRACKET BINDING IS NEVER DEAD, and the reason is that its step keeps
    // its recorded literal (see convertLiteralsToBoundFields). The resolver emits
    // these keys only for a project whose AHJ has a size-bracketed fee schedule on
    // file, so the learn project's own jurisdiction routinely has none — and
    // without this exemption the first recipe to bind a bracket box would be
    // refused promotion by the trust gate for a binding that, when unresolved,
    // replays exactly what it replays today.
    if (field.startsWith(FEE_BRACKET_FIELD_PREFIX)) continue;
    // A field the resolver DOES define but which is empty for THIS project is fine — the
    // next project may have it. Only a key that cannot exist at all is dead.
    if (field && !known.has(field)) out.push(`${field} (${String(step.note ?? step.action).slice(0, 40)})`);
  }
  return out;
}

// PARSER QC / EVIDENCE SCALARS ARE NOT PORTAL ANSWERS (leak sweep 2026-09-28). Every parser scalar
// reaches the dictionary, including the QC evidence flags — acDiscReq ("is a lockable disconnect
// SHOWN on the plan set": "yes", or prose like "60A non-fusible blade-type…"), lightFrame,
// gravityWindDesign, the *Compliant / attachment* screens. A portal's "Is the meter socket
// accessible 24/7?" = Yes matched acDiscReq's "yes" by VALUE and was bound to it, so every later job
// answered a meter-access question with its disconnect evidence. They never enter the binder's index.
const PARSER_EVIDENCE_KEYS = new Set([
  "acDiscReq", "lightFrame", "gravityWindDesign", "manufacturerInstallation", "attachmentToFraming",
  "attachmentsOutsideEdgeZone", "attachmentSpacingIn", "attachmentEdgeSpacingIn", "stampRecommendation", "permitPath",
]);
export function isParserEvidenceKey(key: string): boolean {
  return PARSER_EVIDENCE_KEYS.has(key) || /(?:Text|Compliant|Recommendation)$/.test(key);
}
/** The words a step's own control prints — its label, else its name / text, else the learner's note —
 *  the text a licence KIND is read from (the same reading recipeReplayBinding R9 and the replay adapter
 *  make, so learn and replay name one kind). */
export function licenceLabelOf(step: Pick<RecipeStep, "selector" | "note">): string {
  return String(step.selector?.label || step.selector?.name || step.selector?.text || step.note || "").trim();
}
/**
 * A LICENCE VALUE IS BOUND BY WHAT ITS LABEL NAMES (licences skeptic L2 — the forms' "caption decides"
 * rule, on the portal side; one predicate, kindForSlot). When a recorded value equals one or more
 * licence keys of this job:
 *   - a label that names a kind binds that kind's key ("CSL License Number" -> the construction
 *     supervisor's key, never the generic ccbLicenseNumber that merely held the same number; a
 *     "CCB" label keeps the generic pair — on an Oregon job it IS the CCB). When none of the matching
 *     keys is that kind, the value is this client's licence of ANOTHER kind: "withhold" — never bound
 *     to the wrong kind, never kept as a literal;
 *   - a label that names no kind (a bare "License #") takes the generic key when it is among the
 *     matches (the CCB on an Oregon job, the permit's licence elsewhere);
 *   - otherwise null: the ordinary binding rules decide.
 */
export function licenceBindingByLabel(label: string, candidates: string[]): { field: string } | "withhold" | null {
  const licenceKeys = candidates.filter((c) => licenceKeyInfo(c));
  if (!licenceKeys.length) return null;
  const expiry = licenceKeys.every((c) => licenceKeyInfo(c)!.expiry);
  const kind = kindForSlot(label);
  if (kind && kind !== "generic") {
    const want = licenceKeyForKind(kind, expiry, label);
    return want && candidates.includes(want) ? { field: want } : "withhold";
  }
  if (licenceKeys.length !== candidates.length) return null;
  const generic = expiry ? GENERIC_LICENCE_EXPIRY_KEY : GENERIC_LICENCE_NUMBER_KEY;
  return candidates.includes(generic) ? { field: generic } : null;
}
/** Dates recomputed at every replay (dateFields) — assigned by a control's label, never by value. */
const VOLATILE_DATE_KEYS = new Set(["todayDate", "todayDateUs", "estimatedCommissioningDate", "estimatedCommissioningDateIso"]);
/** A bare Yes/No answer: it names nothing, so a value match alone never binds it. */
const YES_NO_LITERAL = /^(?:yes|no|y|n|true|false)$/i;
/** The learner's standing policy answers ("policy default: <question> -> Yes") stay literals. */
const POLICY_DEFAULT_NOTE = /^\s*policy default\s*:/i;
/** THE disconnect-to-meter distance question ("Is your disconnect within 10 feet of the utility
 *  meter?", "Are the AC disconnect(s) … within the state's required distance of the meter?") — one
 *  predicate, shared with the portal question bank (portalQuestionBank per-job:disconnect-10ft). */
export const DISCONNECT_DISTANCE_QUESTION = /disconnect[^?]{0,80}\bwithin\s*(?:10|ten)\b|disconnect[^?]{0,80}\bwithin\s+(?:the\s+)?(?:state'?s?\s+)?required\s+distance|\bwithin\s*(?:10|ten)\s*(?:feet|ft)\b[^?]{0,60}\bdisconnect/i;

export function convertLiteralsToBoundFields(
  steps: RecipeStep[],
  projectFields: Record<string, string>,
): LiteralBindingResult {
  const norm = (v: string): string => String(v || "").toLowerCase().replace(/\s+/g, " ").trim();

  // value -> the project field key(s) holding exactly that value. Skip very short values
  // (<2 chars) and the volatile todayDate helper — not stable identifying data — and the parser's
  // QC/evidence scalars (isParserEvidenceKey), which are never a portal's answer.
  const valueToFields = new Map<string, string[]>();
  for (const [key, raw] of Object.entries(projectFields)) {
    if (key === "todayDate") continue;
    if (isParserEvidenceKey(key)) continue;
    const nv = norm(raw);
    if (nv.length < 2) continue;
    const arr = valueToFields.get(nv) ?? [];
    if (!arr.includes(key)) arr.push(key);
    valueToFields.set(nv, arr);
  }

  const bound: LiteralBindingResult["bound"] = [];
  const ambiguous: LiteralBindingResult["ambiguous"] = [];
  const portalConstants: Array<{ value: string; note?: string }> = [];
  const out = steps.map((step) => {
    const bindable = (step.action === "fill" || step.action === "select") && !!step.value && !step.field && !step.sensitive;
    if (!bindable) return step;
    // A STANDING POLICY ANSWER IS A LITERAL ON PURPOSE ("policy default: Are the AC disconnect(s)…
    // -> Yes"): the operator's answer for every job, never a value to rebind to project data.
    if (POLICY_DEFAULT_NOTE.test(String(step.note ?? ""))) return step;
    // A DATE never matches by value (todayDate is skipped above as volatile), so it would
    // otherwise stay frozen and replay a stale — eventually PAST — date onto a live
    // application. Rebind it by the control's label to a field recomputed every replay.
    // A FEE BRACKET QUANTITY IS ANSWERED BY THE JOB'S SIZE, NOT BY THE VALUE IN
    // THE BOX. Accela prints one text box per bracket row of the county's fee
    // table and the quantity ticks the row that applies; the recorded "1" is the
    // LEARN project's row, so replaying it bills a 20 kVA job in the 5.01–15
    // tier. Value-equality binding cannot reach this — "1" is one character, and
    // the binder skips values under two characters as non-identifying — so it is
    // rebound from the CONTROL's own label, numerically (the Accela label reads
    // "5.01kva through 15kva" and the county schedule "5.01 KVA to 15 KVA":
    // different strings, identical bounds).
    //
    // AND THE LITERAL IS KEPT, which is the one place this deviates from the date
    // binding above. The kept literal IS the no-schedule fallback: where no fee
    // schedule is stored the resolver emits no bracket keys at all, the key reads
    // as unknown at replay, and the adapter's invented-key branch replays the
    // recorded answer and says so in its aging notes — exactly today's behaviour,
    // visibly. Dropping the literal would turn "we have no schedule for this
    // jurisdiction" into a silently blank fee box, which is worse than the bug.
    const bracketField = feeBracketFieldForLabel(`${step.selector?.label ?? ""} ${step.note ?? ""}`);
    if (bracketField && step.action === "fill") {
      bound.push({ value: step.value as string, field: bracketField, note: step.note });
      return { ...step, field: bracketField };
    }
    // EXACT VALUE EQUALITY BEFORE THE LABEL RULE (leak sweep 2026-09-28). A recorded date that IS a
    // stable project date (the existing system's PTO, "03/15/2021") binds to that key; the label
    // rule below only ever reaches the dates no project value holds. The volatile computed dates
    // (today, the commissioning estimate) are the label rule's to assign, never matched by value.
    // A LICENCE VALUE (number or expiry) IS BOUND BY WHAT ITS LABEL NAMES (licenceBindingByLabel) — the
    // label kind decides between keys holding the same value; another kind's licence is withheld.
    const byLicenceKind = (candidates: string[]): RecipeStep | null => {
      const decision = licenceBindingByLabel(licenceLabelOf(step), candidates);
      if (!decision) return null;
      if (decision === "withhold") {
        const next: RecipeStep = { ...step, operatorItem: LICENCE_LITERAL_OPERATOR_ITEM };
        delete next.value;
        return next;
      }
      bound.push({ value: step.value as string, field: decision.field, note: step.note });
      const next: RecipeStep = { ...step, field: decision.field };
      delete next.value;
      return next;
    };
    if (DATE_LITERAL.test(String(step.value ?? "").trim())) {
      const stable = (valueToFields.get(norm(step.value as string)) ?? []).filter((k) => !VOLATILE_DATE_KEYS.has(k));
      const licenceDate = byLicenceKind(stable);
      if (licenceDate) return licenceDate;
      const pick = stable.length === 1 ? stable[0] : stable.length > 1 ? disambiguateByLabel(`${step.selector?.label ?? ""} ${step.note ?? ""}`, stable) : null;
      if (pick) {
        bound.push({ value: step.value as string, field: pick, note: step.note });
        const next: RecipeStep = { ...step, field: pick };
        delete next.value;
        return next;
      }
    }
    const dateField = dateFieldForLiteral(`${step.selector?.label ?? ""} ${step.note ?? ""}`, step.value as string);
    if (dateField) {
      bound.push({ value: step.value as string, field: dateField, note: step.note });
      const next: RecipeStep = { ...step, field: dateField };
      delete next.value;
      return next;
    }
    // An EXISTING system's date with no key of its own is the learn job's fact — never frozen into a
    // recipe other jobs replay (leak-fix-portal skeptic): the box is left for a person.
    if (existingSystemDateWithoutKey(`${step.selector?.label ?? ""} ${step.note ?? ""}`, step.value as string)) {
      const next: RecipeStep = { ...step, operatorItem: "existing system date — the recorded answer was one job's, so the recipe leaves this box for a person" };
      delete next.value;
      return next;
    }
    const labelText = `${step.selector?.label ?? ""} ${step.note ?? ""}`;
    const yesNo = YES_NO_LITERAL.test(String(step.value ?? "").trim());
    // THE DISCONNECT-DISTANCE QUESTION HAS ITS OWN KEY — the per-job answer (intake asks it when a
    // recipe binds it), never whichever parser flag happened to hold "yes".
    if (yesNo && DISCONNECT_DISTANCE_QUESTION.test(labelText)) {
      bound.push({ value: step.value as string, field: "disconnectWithin10ft", note: step.note });
      const next: RecipeStep = { ...step, field: "disconnectWithin10ft" };
      delete next.value;
      return next;
    }
    const matches = valueToFields.get(norm(step.value as string));
    if (!matches || matches.length === 0) return step; // portal-specific literal — keep as-is
    const licenceBinding = byLicenceKind(matches);
    if (licenceBinding) return licenceBinding;
    // A BARE YES/NO NAMES NOTHING: a value match alone is coincidence ("No" is this project's
    // hasBattery and also the answer to "Will the facility interconnect to a switchgear?"). It binds
    // only when the control's own label names the field (a whole-word token hit); otherwise it is
    // kept as recorded and reported, never bound and never a blocker.
    if (yesNo && matches.length === 1 && !labelNamesField(labelText, matches[0])) {
      portalConstants.push({ value: step.value as string, note: `${String(step.note ?? "").slice(0, 60)} (a bare Yes/No matched ${matches[0]} by value only — kept as recorded)` });
      return step;
    }
    if (matches.length === 1) {
      bound.push({ value: step.value as string, field: matches[0], note: step.note });
      // Replace the frozen literal with a reusable binding (resolveValue() at replay reads
      // fieldValues[field]); drop the literal so it can never be replayed verbatim.
      const next: RecipeStep = { ...step, field: matches[0] };
      delete next.value;
      return next;
    }
    // The control's LABEL usually settles it — "Energy Storage" is hasBattery, not
    // exportLimiting, even though both hold "No".
    const picked = disambiguateByLabel(`${step.selector?.label ?? ""} ${step.note ?? ""}`, matches);
    if (picked) {
      bound.push({ value: step.value as string, field: picked, note: step.note });
      const next: RecipeStep = { ...step, field: picked };
      delete next.value;
      return next;
    }
    // A substantive label that shares nothing with any candidate means this control is a
    // portal constant that merely collided with project data — keep the literal, and do
    // NOT report an ambiguity that would block the recipe forever.
    if (labelRulesOutAllCandidates(`${step.selector?.label ?? ""} ${step.note ?? ""}`, matches)) {
      portalConstants.push({ value: step.value as string, note: step.note });
      return step;
    }
    ambiguous.push({ value: step.value as string, candidates: matches, note: step.note });
    return step; // leave literal; caller forces a draft
  });

  return { steps: out, bound, ambiguous, portalConstants };
}

// ---------------------------------------------------------------------------
// PATCH-BY-DEMONSTRATION merge. After an auto-learn leaves the browser open at
// the review screen, the operator's hand-made fixes (the fields the learner
// missed) arrive as captured RecipeSteps. Merge them into the learned recipe
// BEFORE its terminal steps — replay executes steps in order and stops at the
// stopForReview / isFinalSubmit marker, so a step appended after the terminal
// tail would never replay. Literal values that match the patching project's
// data are converted to reusable field bindings (same pass the learner uses)
// so the patch replays every future project's own data, not this project's.
// ---------------------------------------------------------------------------
export function appendHumanPatchSteps(
  db: AppDb,
  recipeId: string,
  newSteps: RecipeStep[],
  projectFields: Record<string, string>,
  /** The client whose job this patch was demonstrated on — stamps its company attestations. */
  clientId?: string | null,
): PortalRecipe {
  const recipe = getPortalRecipe(db, recipeId);
  newSteps = stampCompanyAttestations(newSteps, clientId);
  // DEFENSE IN DEPTH: the capture script already refuses submit/pay clicks, but a
  // mislabeled button can slip through (a real run recorded a bare "Submit" click).
  // Patches merge BEFORE the terminal stop markers — replayable position — so a
  // submit/pay click here would make replay file the application. Drop them at the
  // merge chokepoint too; fills/selects/uploads are always safe to keep.
  // The captured LABEL (note) is matched broadly — incl. the payment phrasings the
  // capture-side OFF_LIMITS blocks, so the two lists can't drift apart on pay intents.
  const SUBMIT_PAY = /\b(submit|pay|payment|pay now|checkout|finalize|place order|confirm submission|complete submission|file application)\b/i;
  newSteps = newSteps.filter((st) => {
    // The submit-observed pseudo-step is a SIGNAL, never a replayable step. Its marker
    // note (__human_submit_observed__) defeats \b-based matching (underscores are word
    // chars), so drop it explicitly — it carries an empty selector and would throw
    // "no usable selector" at replay if it ever merged.
    if ((st.note || "").includes("human_submit_observed")) return false;
    if (st.action !== "click") return true;
    const label = (st.note || "").replace(/^human-patch:?\s*/i, "");
    if (SUBMIT_PAY.test(label)) return false;
    // Selector content is only trusted as a signal when the button had NO accessible
    // label (icon-only <button id="btnSubmitFinal">): a labeled "Next" button inside a
    // '#submit-wizard-step' container is legitimate navigation and must merge.
    if (!label && SUBMIT_PAY.test(JSON.stringify(st.selector || {}))) return false;
    return true;
  });
  if (!newSteps.length) return recipe;
  // SENSITIVE steps: the capture ships the typed value in-memory ONLY so it can be bound
  // to a project field key here (account/meter numbers live in project data). Bind on a
  // unique match, then ALWAYS strip the literal before anything is persisted — a secret
  // must never land in steps_json, matched or not.
  newSteps = newSteps.map((st) => {
    if (!st.sensitive || !st.value) return st;
    const { steps: [bound] } = convertLiteralsToBoundFields([{ ...st, sensitive: undefined }], projectFields);
    const next: RecipeStep = { ...st, field: bound.field || st.field };
    delete next.value;
    return next;
  });
  const steps = [...(recipe.steps || [])];
  // Split off the trailing terminal markers (stopForReview and/or the recorded
  // final-submit) so patches land before them, in replayable position.
  let cut = steps.length;
  while (cut > 0) {
    const tailStep = steps[cut - 1] as RecipeStep & { isFinalSubmit?: boolean };
    if (tailStep.action === "stopForReview" || tailStep.isFinalSubmit === true) cut--;
    else break;
  }
  // A patch literal that is the patching company's own licence (any state, any kind) never stays a
  // literal in the shared recipe (withholdClientLicenceLiterals, licences skeptic L1).
  const bound = withholdClientLicenceLiteralsFor(db, convertLiteralsToBoundFields(newSteps, projectFields).steps, clientId);
  const merged = [...steps.slice(0, cut), ...bound, ...steps.slice(cut)];
  // One idempotent notes marker with the TOTAL patched count — steps stream in one at a
  // time as the human works, so a per-call append would spam the notes field.
  const totalPatched = merged.filter((st) => (st.note || "").startsWith("human-patch")).length;
  const baseNotes = (recipe.notes || "").replace(/\s*\[human-patch:[^\]]*\]/g, "").trim();
  return savePortalRecipeSteps(db, recipeId, merged, {
    status: recipe.status as PortalRecipeStatus,
    notes: `${baseNotes} [human-patch: ${totalPatched} step(s) demonstrated at review]`.trim(),
  });
}
