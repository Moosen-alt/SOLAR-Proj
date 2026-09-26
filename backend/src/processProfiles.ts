import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AhjProcessProfile, ParserPayload, ProjectRecord } from "../../shared/src/types";
import { normalizeTokens } from "./normalize";
import { logger } from "./logger";

interface ProfileData {
  profiles: AhjProcessProfile[];
}

// ---------------------------------------------------------------------------
// AN UNREADABLE KNOWLEDGE BASE IS AN ERROR STATE, NOT AN EMPTY ONE.
//
// This file holds the 381 seeded AHJ process profiles — the only place the system
// knows that Coos Bay files SEPARATE building + electrical permits and wants a
// prescriptive checklist. Everything downstream is derived from it:
// applicationDocContext -> requiredApplicationDocs -> documentInventory ->
// pkg.missingDocuments and the staging gate.
//
// The old loader did two things that turned "we could not read the knowledge base"
// into "this jurisdiction asks for nothing":
//
//   1. `path.resolve(process.cwd(), "backend/data/...")` — CWD-relative. Any process
//      whose working directory is not the repo root silently found nothing.
//   2. `if (!fs.existsSync(f)) { cache = []; return cache; }` — a missing file cached
//      as an EMPTY SUCCESS. No log, no flag, no way for a caller to tell the two
//      apart. A JSON.parse failure was worse: it threw into callers that all swallow
//      (applicationDocContext, qc, repository), landing in the same silent state.
//
// Measured against the live DB with the file made unreachable: Christopher Ivy's
// blocking set went from [building_application, electrical_application,
// solar_checklist] to [] — the packet card printed the pass-green "Every required
// document is attached" and the submit gate fell from blocker to warning. Those are
// the exact documents the two stalled Coos Bay permits bounced for.
//
// So: resolution no longer depends on the CWD, every failure mode (absent, unreadable,
// malformed, zero profiles) is ONE representable "unavailable" status, it logs at
// error level, and FAILURE IS NEVER CACHED — only success is. A restored file
// recovers on the next call without a restart, and the boot gate in server.ts
// refuses to start on it in the first place.
// ---------------------------------------------------------------------------

/** Point the loader at an explicit file. Set this when the reference JSON does not
 *  live at <repo>/backend/data — e.g. a container image that does not ship it (the
 *  repo's own .dockerignore excludes `backend/data`, so the Docker/Fly images do not
 *  carry this file at all) and mounts it from a volume instead. */
export const AHJ_PROCESS_REFERENCE_ENV = "AHJ_PROCESS_REFERENCE_PATH";
const REFERENCE_FILENAME = "reference-ahj-processes.json";
// Module-relative: backend/src/processProfiles.ts -> backend/data/<file>. Survives a
// process started from any working directory. fileURLToPath (not url.pathname) —
// on Windows the raw pathname carries a leading slash and un-decoded escapes.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** The paths tried, in order. An explicit env override is EXCLUSIVE: if an operator
 *  named a file we do not silently fall back to another one and report success from
 *  a file they did not choose. */
function ahjProcessReferenceCandidates(): string[] {
  const explicit = (process.env[AHJ_PROCESS_REFERENCE_ENV] || "").trim();
  if (explicit) return [path.resolve(explicit)];
  const candidates = [
    path.resolve(moduleDir, "..", "data", REFERENCE_FILENAME),
    path.resolve(process.cwd(), "backend", "data", REFERENCE_FILENAME),
  ];
  return Array.from(new Set(candidates));
}

/**
 * Whether the AHJ process knowledge base could be read at all.
 *
 * Same two words Round 3 gave pkg.missingDocumentsStatus ("resolved" / "unavailable")
 * on purpose — this is the upstream cause of that downstream state, not a second
 * vocabulary for it.
 */
export interface AhjProcessKnowledgeStatus {
  status: "resolved" | "unavailable";
  profileCount: number;
  /** The file actually read, when resolved. */
  path: string | null;
  triedPaths: string[];
  /** Operator-readable reason, set only when unavailable. */
  error?: string;
}

let cache: AhjProcessProfile[] | null = null;
let cacheSource = "";
let loggedFailure = false;

/**
 * Read the reference file, or say why it could not be read.
 *
 * SUCCESS IS CACHED, FAILURE IS NOT. Caching a failure is what the old `cache = []`
 * did, and it made the condition permanent for the life of the process even after the
 * file came back. It also makes the env override live, which is what lets a test drive
 * the failure and then the recovery in one process.
 *
 * ZERO PROFILES COUNTS AS UNAVAILABLE. The reference file is a shipped asset with 381
 * jurisdictions; it is never legitimately empty, and "zero profiles" is precisely the
 * state that renders as "this AHJ asks for nothing".
 */
export function ahjProcessKnowledgeStatus(): AhjProcessKnowledgeStatus {
  if (cache) return { status: "resolved", profileCount: cache.length, path: cacheSource, triedPaths: [cacheSource] };
  const triedPaths = ahjProcessReferenceCandidates();
  const problems: string[] = [];
  for (const filePath of triedPaths) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      problems.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      problems.push(`${filePath}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const profiles = (parsed as ProfileData | null)?.profiles;
    if (!Array.isArray(profiles)) {
      problems.push(`${filePath}: no "profiles" array`);
      continue;
    }
    if (!profiles.length) {
      problems.push(`${filePath}: contains 0 profiles`);
      continue;
    }
    cache = profiles;
    cacheSource = filePath;
    loggedFailure = false;
    return { status: "resolved", profileCount: profiles.length, path: filePath, triedPaths };
  }
  const error =
    `the AHJ process reference (${REFERENCE_FILENAME}) could not be read, so no jurisdiction's required documents can be resolved — ${problems.join(" ; ")}`;
  // ERROR LEVEL, ONCE PER FAILURE RUN. Per-call logging would spam every inventory
  // read; the flag resets on the next successful load so a later relapse logs again.
  if (!loggedFailure) {
    loggedFailure = true;
    logger.error(
      "ahj-knowledge",
      `${error}. Set ${AHJ_PROCESS_REFERENCE_ENV} to the file's absolute path, or restore it at backend/data/${REFERENCE_FILENAME}. Until then every document verdict reports UNKNOWN rather than an all-clear.`,
      { triedPaths },
    );
  }
  return { status: "unavailable", profileCount: 0, path: null, triedPaths, error };
}

/**
 * The profiles, or an empty list when the knowledge base is unavailable.
 *
 * DELIBERATELY DOES NOT THROW. findAhjProcessProfile has seven callers outside this
 * module (reviewerEngine, submittalTracks, repository, ahjFormAuto, knowledgeBase,
 * applicationDocs, requiredDocuments) and most sit inside a `catch {}` that would
 * swallow the throw straight back into the silence this exists to end. The failure is
 * carried by ahjProcessKnowledgeStatus() instead, and the ONE caller that turns it
 * into a refusal is documentInventory() — the choke point every document verdict and
 * the staging gate already go through.
 */
function loadProfiles(): AhjProcessProfile[] {
  return ahjProcessKnowledgeStatus().status === "resolved" ? cache ?? [] : [];
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

const stopWords = new Set([
  "and",
  "city",
  "county",
  "town",
  "village",
  "code",
  "ending",
  "zip",
  "the",
  "of",
  "for",
  "ahj",
  "permit",
  "permits",
]);

function tokens(value: string): string[] {
  return normalizeTokens(value)
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopWords.has(token));
}

function stateFrom(input: ProjectRecord | ParserPayload): string {
  return clean("state" in input ? input.state : input.state).toUpperCase();
}

// ---------------------------------------------------------------------------
// THE EXACT JURISDICTION (new-AHJ e2e, 2026-09-26).
//
// A project in UNINCORPORATED Santa Fe County, NM (ahj "Santa Fe County", mailing city
// "Santa Fe") was handed the shipped CITY of Santa Fe profile: BLD + ELE by email, "drop
// off at the City of Santa Fe Office", an Oregon-style document list — a different
// government. The old scorer matched one haystack, `ahj + " " + city`, by substring and
// token overlap; "santa fe" is inside "santa fe county santa fe", both profiles scored 137,
// and the stable sort kept file order.
//
// Now: a jurisdiction is a KIND (county vs city/town) plus a CORE name. A name that says
// "County"/"Co" never matches a profile name that does not, and a "City of"/"Town of" name
// never matches a county. The project's AHJ decides; its mailing city is consulted only
// when the AHJ field is empty — never when the AHJ names a county (an unincorporated
// address carries the nearest city's name, which is exactly the Santa Fe shape). State
// mismatch always loses (the state filter below).
// ---------------------------------------------------------------------------
export type JurisdictionKind = "county" | "city" | "unmarked";
const STATE_TAIL = /\b(or|wa|ca|id|tx|nm|az|nj|fl|oh|sc|nc|ia|ma|pa|ut|co|nv|mi|il|ny|ga|va|md|mn|wi|mo|ok|ks|ne|ky|tn|al|ms|la|ar|in|de|ct|ri|vt|nh|me|mt|wy|sd|nd|hi|ak|wv|dc)\b\s*$/i;
const DEPARTMENT_WORDS = new Set(["building", "buildings", "division", "department", "dept", "permit", "permits", "permitting", "planning",
  "development", "services", "service", "inspection", "inspections", "community", "and", "the", "office", "safety", "codes", "code", "center"]);

function stripParens(value: string): string {
  // A balanced parenthetical is a note ("Burns (Harney County)"); an UNBALANCED one runs to
  // the end ("Klamath County (zip code ending in 03 is county and 01 is city") — both go.
  return value.replace(/\([^)]*\)/g, " ").replace(/\([^)]*$/, " ");
}

/** Parentheticals and a trailing state code removed, normalized. ", CO" after a comma is the
 *  state; a bare trailing "Co" ("Marion Co") is the county abbreviation and stays. */
function placeWords(name: string): string {
  const noParen = stripParens(String(name ?? "")).replace(/,\s*[A-Za-z]{2}\.?\s*$/, " ");
  const n = normalizeTokens(noParen);
  const last = n.split(" ").pop() || "";
  return last !== "co" && n.includes(" ") ? n.replace(STATE_TAIL, "").trim() : n;
}

/** "Santa Fe County" → county; "City of Santa Fe" → city; "Santa Fe" → unmarked. */
export function jurisdictionKind(name: string): JurisdictionKind {
  const n = ` ${placeWords(name)} `;
  if (/ (county|co|parish) /.test(n)) return "county";
  if (/ (city|town|village|borough|township|twp) /.test(n)) return "city";
  return "unmarked";
}

/** The place name alone: kind words, "of", department words and a trailing state code removed. */
export function jurisdictionCore(name: string): string {
  const n = placeWords(name);
  return n
    .split(/\s+/)
    .filter((w) => w && !["county", "co", "parish", "city", "town", "village", "borough", "township", "twp", "of"].includes(w) && !DEPARTMENT_WORDS.has(w))
    .join(" ")
    .trim();
}

/** May a project jurisdiction of kind `a` be the same government as a profile name of kind `b`? */
export function jurisdictionKindsCompatible(project: JurisdictionKind, profile: JurisdictionKind): boolean {
  if (project === "county") return profile === "county";
  if (project === "city") return profile !== "county";
  return true; // a bare project name ("Deschutes", "Keizer") may be either — scored below
}

// Split a multi-jurisdiction AHJ name into its individual jurisdictions, so a combined record
// like "Marion Co/Hubbard OR/Keizer OR / Mount Angel / Salem / Gervais" matches a project in
// "Keizer". Without this, a bare "Keizer" stub outscores the rich combined record. Each part
// keeps its OWN kind ("Marion Co" is a county, "Keizer OR" is not).
function jurisdictionNames(rawAhj: string): Array<{ core: string; kind: JurisdictionKind }> {
  const parts = stripParens(rawAhj).split(/[/,;]+/).map((p) => p.trim()).filter(Boolean);
  const out = new Map<string, { core: string; kind: JurisdictionKind }>();
  for (const part of parts) {
    const core = jurisdictionCore(part);
    if (core) out.set(`${core}|${jurisdictionKind(part)}`, { core, kind: jurisdictionKind(part) });
  }
  return Array.from(out.values());
}

/** The names the project's jurisdiction goes by: its AHJ; its mailing city ONLY when the AHJ
 *  field is empty (see the header — an unincorporated address carries a city's name). */
function projectJurisdictionNames(input: ProjectRecord | ParserPayload): Array<{ core: string; kind: JurisdictionKind }> {
  const direct = clean("ahj" in input ? input.ahj : input.ahj);
  const city = clean("city" in input ? input.city : input.city);
  // An AHJ field of department words only ("Building Division") names no place: fall to the city,
  // the same rule applicationDocs.findApplicationProfile applies to the hand-written registry.
  if (direct && jurisdictionCore(direct)) return jurisdictionNames(direct);
  return city ?jurisdictionNames(city).map((n) => ({ ...n, kind: n.kind === "county" ? n.kind : "city" as JurisdictionKind })) : [];
}

/** Whole-word containment: "west salem" contains "salem"; "salemtown" does not. */
function containsWords(hay: string, needle: string): boolean {
  if (!hay || !needle) return false;
  return ` ${hay} `.includes(` ${needle} `);
}

// How much real, actionable data a profile carries — used as a tiebreak so a populated
// record beats an empty stub that happens to match the name exactly.
function richness(profile: AhjProcessProfile): number {
  let r = 0;
  const flags: Array<keyof AhjProcessProfile> = [
    "requiresElectricianSign", "requiresElectricalStamp", "requiresStructuralStamp",
    "requiresElectricalPermitApplication", "requiresBuildingPermitApplication",
    "requiresSolarChecklist", "requiresPlanSet", "requiresUtilityApproval",
    "requiresCustomerSignature", "requiresFloodplainCheck", "requiresJurisdictionCheck",
  ];
  for (const f of flags) if (profile[f]) r += 1;
  if ((profile.submissionMethod || "").trim()) r += 1;
  if ((profile.timeline || "").trim()) r += 1;
  if ((profile.reviewerNotes || "").trim().length > 20) r += 2;
  if ((profile.otherRequirements || "").trim().length > 20) r += 1;
  return r;
}

export function findAhjProcessProfile(input: ProjectRecord | ParserPayload): AhjProcessProfile | null {
  const profiles = loadProfiles();
  const state = stateFrom(input);
  const projectNames = projectJurisdictionNames(input);
  if (!state || !projectNames.length) return null;

  const stateProfiles = profiles.filter((profile) => profile.state.toUpperCase() === state);
  const candidates: Array<{ profile: AhjProcessProfile; score: number; rich: number }> = [];
  const hayTokens = new Set(projectNames.flatMap((n) => tokens(n.core)));
  for (const profile of stateProfiles) {
    const profileNames = jurisdictionNames(profile.ahj);
    if (!profileNames.length) continue;
    // Score by the BEST kind-compatible pairing of a project name with a profile sub-name.
    // Kind-incompatible pairs score nothing — "Santa Fe" (a city's short name) is never the
    // government of a project that names "Santa Fe County".
    let best = 0;
    for (const p of projectNames) {
      for (const n of profileNames) {
        if (!n.core || n.core.length < 3 || !jurisdictionKindsCompatible(p.kind, n.kind)) continue;
        // Same kind outranks a bare-name pairing: an unmarked "Santa Fe" project prefers the
        // unmarked/city "Santa Fe" profile over "Santa Fe County" at an otherwise equal score.
        const sameKind = (p.kind === "county") === (n.kind === "county") ? 5 : 0;
        let s = 0;
        if (p.core === n.core) s = 100;
        else if (containsWords(p.core, n.core) || containsWords(n.core, p.core)) s = 55;
        if (s) best = Math.max(best, s + sameKind);
      }
    }
    if (!best) continue;
    let score = best;
    for (const token of new Set(profileNames.flatMap((n) => tokens(n.core)))) {
      if (hayTokens.has(token)) score += 12;
    }
    candidates.push({ profile, score, rich: richness(profile) });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  // If the highest-scoring match is an empty stub (a name with no actionable data —
  // e.g. the bare "Keizer" record whose only note is the delegation pointer "Marion
  // County"), prefer the richest related record instead so we use the real process
  // knowledge (submission method, plan-set/stamp requirements, reviewer notes).
  if (top.rich <= 1) {
    const richer = candidates
      .filter((c) => c.rich >= 2)
      .sort((a, b) => b.rich - a.rich || b.score - a.score);
    if (richer.length) return richer[0].profile;
  }
  return top.profile;
}

export function allAhjProcessProfiles(): AhjProcessProfile[] {
  return loadProfiles();
}
