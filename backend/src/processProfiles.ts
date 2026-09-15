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

function ahjFrom(input: ProjectRecord | ParserPayload): string {
  const direct = clean("ahj" in input ? input.ahj : input.ahj);
  const city = clean("city" in input ? input.city : input.city);
  return [direct, city].filter(Boolean).join(" ");
}

// Split a multi-jurisdiction AHJ name into its individual jurisdictions and strip a
// trailing 2-letter state token + parentheticals, so a combined record like
// "Marion Co/Hubbard OR/Keizer OR / Mount Angel / Salem / Gervais" matches a project
// in "Keizer". Without this, a bare "Keizer" stub outscores the rich combined record.
function jurisdictionNames(rawAhj: string): string[] {
  const parts = rawAhj.split(/[/,;]+/).map((p) => p.trim()).filter(Boolean);
  const names = new Set<string>();
  for (const part of parts) {
    const noParen = part.replace(/\([^)]*\)/g, " ");
    const norm = normalizeTokens(noParen).replace(/\b(or|wa|ca|id|tx|nm|az|nj|fl|oh|sc|nc)\b\s*$/i, "").trim();
    if (norm) names.add(norm);
  }
  return Array.from(names);
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
  const haystack = normalizeTokens(ahjFrom(input));
  if (!state || !haystack) return null;

  const stateProfiles = profiles.filter((profile) => profile.state.toUpperCase() === state);
  const candidates: Array<{ profile: AhjProcessProfile; score: number; rich: number }> = [];
  const hayTokens = new Set(tokens(haystack));
  for (const profile of stateProfiles) {
    const ahj = normalizeTokens(profile.ahj);
    if (!ahj) continue;
    let score = 0;
    if (haystack === ahj) score += 100;
    if ((ahj.length > 5 && haystack.includes(ahj)) || (haystack.length > 5 && ahj.includes(haystack))) score += 70;
    // Per-jurisdiction match for combined records: a project in "Keizer" should match
    // the "…/Keizer OR/…" sub-name strongly even though the full string differs.
    for (const name of jurisdictionNames(profile.ahj)) {
      if (!name || name.length < 3) continue;
      if (haystack === name) { score += 90; break; }
      if (haystack.includes(name) || hayTokens.has(name)) score += 55;
    }
    for (const token of tokens(ahj)) {
      if (hayTokens.has(token)) score += 12;
    }
    if (score >= 24) candidates.push({ profile, score, rich: richness(profile) });
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
