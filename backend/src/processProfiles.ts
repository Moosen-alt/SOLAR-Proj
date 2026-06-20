import fs from "node:fs";
import path from "node:path";
import type { AhjProcessProfile, ParserPayload, ProjectRecord } from "../../shared/src/types";

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

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
  return normalize(value)
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

export function findAhjProcessProfile(input: ProjectRecord | ParserPayload): AhjProcessProfile | null {
  const profiles = loadProfiles();
  const state = stateFrom(input);
  const haystack = normalize(ahjFrom(input));
  if (!state || !haystack) return null;

  const stateProfiles = profiles.filter((profile) => profile.state.toUpperCase() === state);
  let best: { profile: AhjProcessProfile; score: number } | null = null;
  const hayTokens = new Set(tokens(haystack));
  for (const profile of stateProfiles) {
    const ahj = normalize(profile.ahj);
    if (!ahj) continue;
    let score = 0;
    if (haystack === ahj) score += 100;
    if ((ahj.length > 5 && haystack.includes(ahj)) || (haystack.length > 5 && ahj.includes(haystack))) score += 70;
    for (const token of tokens(ahj)) {
      if (hayTokens.has(token)) score += 12;
    }
    if (score > (best?.score || 0)) best = { profile, score };
  }
  return best && best.score >= 24 ? best.profile : null;
}

export function allAhjProcessProfiles(): AhjProcessProfile[] {
  return loadProfiles();
}
