import fs from "node:fs";
import path from "node:path";
import type { AhjProcessProfile, ParserPayload, ProjectRecord } from "../../shared/src/types";
import { normalizeTokens } from "./normalize";

interface ProfileData {
  profiles: AhjProcessProfile[];
}

let cache: AhjProcessProfile[] | null = null;

function loadProfiles(): AhjProcessProfile[] {
  if (cache) return cache;
  const filePath = path.resolve(process.cwd(), "backend/data/reference-ahj-processes.json");
  if (!fs.existsSync(filePath)) {
    cache = [];
    return cache;
  }
  const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as ProfileData;
  cache = data.profiles || [];
  return cache;
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
