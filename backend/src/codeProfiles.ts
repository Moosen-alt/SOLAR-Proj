// ---------------------------------------------------------------------------
// Jurisdiction code profiles — the data layer that makes the review gate work
// for ANY jurisdiction (Elmore County ID, City of Boise, …), not just the
// hardcoded Oregon constants it grew up with.
//
// A profile records what a jurisdiction has ADOPTED (code families + editions +
// local amendments), its site design criteria (ground snow, wind, seismic,
// frost), and the solar prescriptive-path limits. Rules never read this table
// directly — they receive an EffectiveCodeContext resolved here, so the rule
// modules stay pure (same style as buildReviewerReport).
//
// Confidence model mirrors the knowledge base: "seeded" (LLM-researched or
// bulk-imported — findings must phrase as "verify locally") vs "verified"
// (a human confirmed the values against official sources; citations become
// authoritative). The reference seeder NEVER overwrites a verified row.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import type {
  ApprovedDesignObservation,
  CodeEdition,
  CodeReference,
  DesignCriteriaResearchResult,
  JurisdictionCodeProfile,
  JurisdictionCriteriaProposal,
  JurisdictionDesignCriteria,
  LLMProvider,
  PrescriptiveLimits,
  FireSetbackRule,
  ProjectRecord,
} from "../../shared/src/types";
import { knowledgeProfileKey, knowledgeNameMatchScore, isLearningExcluded } from "./knowledgeBase";
import { addAuditLog } from "./audit";
import { extractStatedDesignCriteria } from "./designCriteria";
import { isAutoSeedDisabled } from "./portalChannel";
import { id as newId } from "./ids";
import { logger } from "./logger";
import { resolvePermitPath } from "./permitPath";
import { nowIso } from "./time";

interface Row { [key: string]: unknown }
const text = (v: unknown): string => (v == null ? "" : String(v));

/** HOW A SEEDED PROFILE WAS RESEARCHED — stored in payload_json, because "seeded" alone
 *  cannot tell an operator (or a cleanup) a web-grounded answer from model memory, and both
 *  are shared with every tenant. researchJurisdictionCodes attaches it to the profile it
 *  returns; absent means the row came from a path that does not say (imports, seeds). */
export interface CodeResearchProvenance {
  webGrounded: boolean;
  method: "web_search" | "model_memory";
  notes?: string;
}

function provenanceOf(value: unknown): CodeResearchProvenance | undefined {
  const p = (value as { researchProvenance?: unknown } | null)?.researchProvenance as Partial<CodeResearchProvenance> | undefined;
  if (!p || typeof p !== "object" || typeof p.webGrounded !== "boolean") return undefined;
  return { webGrounded: p.webGrounded, method: p.webGrounded ? "web_search" : "model_memory", ...(p.notes ? { notes: String(p.notes).slice(0, 1000) } : {}) };
}

// Model-code fallbacks used when a jurisdiction has no profile: current ICC/NFPA
// cycles, clearly labeled so findings say "verify the locally adopted edition".
export const MODEL_CODE_DEFAULTS: CodeEdition[] = [
  { code: "NEC", edition: "2023", title: "National Electrical Code (NFPA 70)", notes: "Model code default — verify the locally adopted edition and amendments." },
  { code: "IRC", edition: "2021", title: "International Residential Code", notes: "Model code default — verify the locally adopted edition and amendments." },
  { code: "IBC", edition: "2021", title: "International Building Code", notes: "Model code default — verify the locally adopted edition and amendments." },
  { code: "IFC", edition: "2021", title: "International Fire Code", notes: "Model code default — verify the locally adopted edition and amendments." },
];

/** What the rule engines consume. `verified` gates authoritative phrasing:
 *  seeded/default contexts must produce "verify locally with {ahj}" findings. */
export interface EffectiveCodeContext {
  state: string;
  ahj: string;
  /** Which layer supplied the values. */
  source: "verified" | "seeded" | "defaults";
  verified: boolean;
  profile: JurisdictionCodeProfile | null;
  adoptedCodes: CodeEdition[];
  amendments: JurisdictionCodeProfile["amendments"];
  designCriteria: JurisdictionDesignCriteria;
  prescriptive: PrescriptiveLimits;
  fireSetbacks: FireSetbackRule[];
  /** What ISSUED projects in this AHJ stated (corroboration only — never the AHJ's value).
   *  Loaded by resolveEffectiveCodeContext; absent/empty from the pure builder. */
  approvedDesigns?: ApprovedDesignObservation[];
  /** Resolve a citation for a code family ("NEC", "IRC", …) from the adopted
   *  editions; returns a CodeReference shell the rule fills with section/title. */
  citationFor(code: string, section: string, title: string, fallback?: CodeReference): CodeReference;
}

function mapRow(row: Row): JurisdictionCodeProfile {
  let payload: Partial<JurisdictionCodeProfile> = {};
  try { payload = JSON.parse(text(row.payload_json) || "{}") as Partial<JurisdictionCodeProfile>; } catch { payload = {}; }
  return {
    key: text(row.profile_key),
    state: text(row.state),
    ahj: text(row.ahj),
    confidence: text(row.confidence) === "verified" ? "verified" : "seeded",
    adoptedCodes: Array.isArray(payload.adoptedCodes) ? payload.adoptedCodes : [],
    amendments: Array.isArray(payload.amendments) ? payload.amendments : [],
    designCriteria: payload.designCriteria ?? {},
    prescriptive: payload.prescriptive ?? {},
    fireSetbacks: Array.isArray(payload.fireSetbacks) ? payload.fireSetbacks : [],
    citations: Array.isArray(payload.citations) ? payload.citations : [],
    researchedAt: text(row.researched_at) || undefined,
    verifiedAt: text(row.verified_at) || undefined,
    verifiedBy: text(row.verified_by) || undefined,
    updatedAt: text(row.updated_at),
  };
}

export function codeProfileKey(input: { state?: string; ahj?: string }): string {
  return knowledgeProfileKey({ state: input.state, ahj: input.ahj, utility: "" });
}

/** Resolve the effective profile for a state+AHJ, LAYERED: the county/city row
 *  overrides the state-level default (ahj "") field-by-field — a county that only
 *  records its local design criteria still inherits the state's adopted codes
 *  (Elmore County ID builds on the Idaho DOPL state codes). Confidence of the
 *  merged result is the WEAKEST layer used, so a seeded county over a verified
 *  state still phrases as "verify locally". Null when neither row exists. */
// Fuzzy AHJ fallback: imported reference rows are keyed by spreadsheet names
// ("Woodburn", "Elmore County") while projects say "City of Woodburn" /
// "Elmore County, ID". Same scorer as the KB resolver; STATE MATCH IS REQUIRED
// (a fuzzy "Springfield" must never cross state lines into the wrong code cycle).
function fuzzyCodeRow(db: AppDb, input: { state?: string; ahj?: string }): Row | null {
  const state = text(input.state).trim().toUpperCase();
  const wanted = text(input.ahj).trim();
  if (!state || !wanted) return null;
  let best: { row: Row; score: number } | null = null;
  for (const row of db.query<Row>("SELECT * FROM jurisdiction_code_profiles WHERE ahj != '' AND UPPER(state) = ?", [state])) {
    let score = knowledgeNameMatchScore(wanted, text(row.ahj));
    if (!score) continue;
    if (text(row.confidence) === "verified") score += 4;
    if (!best || score > best.score) best = { row, score };
  }
  return best && best.score >= 60 ? best.row : null;
}

export function getCodeProfile(db: AppDb, input: { state?: string; ahj?: string }): JurisdictionCodeProfile | null {
  const exactRow = input.ahj
    ? db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [codeProfileKey({ state: input.state, ahj: input.ahj })]) ??
      fuzzyCodeRow(db, input)
    : null;
  const stateRow = db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [codeProfileKey({ state: input.state, ahj: "" })]);
  const exact = exactRow ? mapRow(exactRow) : null;
  const base = stateRow ? mapRow(stateRow) : null;
  if (!exact) return base;
  if (!base) return exact;
  return {
    ...exact,
    confidence: exact.confidence === "verified" && base.confidence === "verified" ? "verified" : "seeded",
    adoptedCodes: exact.adoptedCodes.length ? exact.adoptedCodes : base.adoptedCodes,
    amendments: [...base.amendments, ...exact.amendments],
    designCriteria: { ...base.designCriteria, ...exact.designCriteria },
    prescriptive: { ...base.prescriptive, ...exact.prescriptive },
    fireSetbacks: exact.fireSetbacks.length ? exact.fireSetbacks : base.fireSetbacks,
    citations: [...base.citations, ...exact.citations],
  };
}

export function listCodeProfiles(db: AppDb): JurisdictionCodeProfile[] {
  return db.query<Row>("SELECT * FROM jurisdiction_code_profiles ORDER BY state, ahj").map((row) => {
    const profile = mapRow(row);
    if (!profile.ahj) return profile;
    let summary: JurisdictionCodeProfile["approvedDesignSummary"] = [];
    try { summary = summarizeApprovedDesigns(listApprovedDesignObservations(db, profile.state, profile.ahj)); } catch { summary = []; }
    return summary.length ? { ...profile, approvedDesignSummary: summary } : profile;
  });
}

/** Approved designs as a SHARED-SAFE aggregate: each (criterion, value) with a count and the latest
 *  issue date. The per-observation project id and record number stay behind — this list reaches
 *  every tenant through /api/code-profiles. */
export function summarizeApprovedDesigns(observations: ApprovedDesignObservation[]): NonNullable<JurisdictionCodeProfile["approvedDesignSummary"]> {
  const byKey = new Map<string, { criterion: ApprovedDesignObservation["criteria"][number]["criterion"]; value: number | string; count: number; lastIssuedAt: string }>();
  for (const o of observations) {
    const seen = new Set<string>();
    for (const c of o.criteria) {
      const k = `${c.criterion}|${String(c.value).toUpperCase()}`;
      if (seen.has(k)) continue; // one issued permit counts once per value
      seen.add(k);
      const cur = byKey.get(k) ?? { criterion: c.criterion, value: c.value, count: 0, lastIssuedAt: "" };
      cur.count++;
      const day = String(o.issuedAt || "").slice(0, 10);
      if (day > cur.lastIssuedAt) cur.lastIssuedAt = day;
      byKey.set(k, cur);
    }
  }
  return [...byKey.values()].sort((a, b) => a.criterion.localeCompare(b.criterion) || b.count - a.count);
}

function upsert(db: AppDb, profile: JurisdictionCodeProfile, opts: { confidence: "seeded" | "verified"; verifiedBy?: string }): JurisdictionCodeProfile {
  const key = codeProfileKey(profile);
  const ts = nowIso();
  const existing = db.get<Row>("SELECT confidence, researched_at, verified_at, verified_by, payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
  // Provenance: the incoming research's own, else — for a seeded re-save that does not carry
  // one (a reference import merging onto a researched row) — the row's existing one, so a
  // merge cannot launder model memory into an unmarked row. A human verification drops it:
  // "verified" is the stronger statement.
  let priorProvenance: CodeResearchProvenance | undefined;
  if (existing && opts.confidence === "seeded") {
    try { priorProvenance = provenanceOf(JSON.parse(text(existing.payload_json) || "{}")); } catch { priorProvenance = undefined; }
  }
  const researchProvenance = provenanceOf(profile) ?? priorProvenance;
  const payload = JSON.stringify({
    adoptedCodes: profile.adoptedCodes ?? [],
    amendments: profile.amendments ?? [],
    designCriteria: profile.designCriteria ?? {},
    prescriptive: profile.prescriptive ?? {},
    fireSetbacks: profile.fireSetbacks ?? [],
    citations: profile.citations ?? [],
    ...(researchProvenance && opts.confidence === "seeded" ? { researchProvenance } : {}),
  });
  if (existing) {
    db.run(
      `UPDATE jurisdiction_code_profiles
         SET state = ?, ahj = ?, confidence = ?, payload_json = ?,
             researched_at = COALESCE(?, researched_at),
             verified_at = ?, verified_by = ?, updated_at = ?
       WHERE profile_key = ?`,
      [
        profile.state, profile.ahj, opts.confidence, payload,
        opts.confidence === "seeded" ? ts : null,
        opts.confidence === "verified" ? ts : text(existing.verified_at) || null,
        opts.confidence === "verified" ? (opts.verifiedBy || "operator") : text(existing.verified_by) || null,
        ts, key,
      ],
    );
  } else {
    db.run(
      `INSERT INTO jurisdiction_code_profiles
        (profile_key, state, ahj, confidence, payload_json, researched_at, verified_at, verified_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        key, profile.state, profile.ahj, opts.confidence, payload,
        opts.confidence === "seeded" ? ts : null,
        opts.confidence === "verified" ? ts : null,
        opts.confidence === "verified" ? (opts.verifiedBy || "operator") : null,
        ts,
      ],
    );
  }
  return getCodeProfile(db, profile)!;
}

/** Persist an LLM-researched (or bulk-imported) profile. NEVER downgrades a
 *  human-verified row back to seeded — re-research lands as a no-op on verified
 *  jurisdictions until an operator explicitly re-verifies. */
export function saveResearchedCodeProfile(db: AppDb, profile: JurisdictionCodeProfile): JurisdictionCodeProfile {
  const key = codeProfileKey(profile);
  const existing = db.get<Row>("SELECT confidence, payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
  if (existing && text(existing.confidence) === "verified") {
    logger.info("code-profiles", `research skipped — ${profile.state}/${profile.ahj || "(state default)"} is human-verified`);
    return getCodeProfile(db, profile)!;
  }
  return upsert(db, existing ? keepCorrectionCitedValues(mapRow({ ...existing, profile_key: key }), profile) : profile, { confidence: "seeded" });
}

/** WHAT THE AHJ ITSELF SAID OUTRANKS RESEARCH. A value a human applied from the AHJ's own
 *  correction (citation kind "ahj_correction") survives a later research/import re-save of
 *  the row: research replaces the whole payload, and "the city told us 36 psf" must not be
 *  silently swapped for whatever a web search or a spreadsheet says next. */
function keepCorrectionCitedValues(existing: JurisdictionCodeProfile, incoming: JurisdictionCodeProfile): JurisdictionCodeProfile {
  const cited = existing.citations.filter((c) => c.kind === "ahj_correction" && typeof c.field === "string");
  // A value the narrow design-criteria LOOKUP filled (cited, web-grounded) survives a later full
  // research that says nothing about that field — research fills its blanks, never erases them.
  // Unlike an AHJ-stated value, a value the new research DOES carry replaces it.
  const looked = existing.citations.filter((c) => c.kind === "design_criteria_research" && typeof c.field === "string");
  if (looked.length) {
    const dc: Record<string, unknown> = { ...(incoming.designCriteria ?? {}) };
    const cites = [...(incoming.citations ?? [])];
    for (const c of looked) {
      const [block, field] = String(c.field).split(".");
      if (block !== "designCriteria") continue;
      const had = (existing.designCriteria as Record<string, unknown>)[field];
      const now = dc[field];
      if (had === undefined || had === null || had === "" || (now !== undefined && now !== null && now !== "")) continue;
      dc[field] = had;
      if (!cites.some((x) => x.kind === c.kind && x.field === c.field)) cites.push(c);
    }
    incoming = { ...incoming, designCriteria: dc as JurisdictionDesignCriteria, citations: cites };
  }
  if (!cited.length) return incoming;
  const out: JurisdictionCodeProfile = {
    ...incoming,
    designCriteria: { ...(incoming.designCriteria ?? {}) },
    prescriptive: { ...(incoming.prescriptive ?? {}) },
    citations: [...(incoming.citations ?? [])],
  };
  for (const c of cited) {
    const [block, field] = String(c.field).split(".");
    if (block !== "designCriteria" && block !== "prescriptive") continue;
    const had = (existing[block] as Record<string, unknown>)[field];
    if (had === undefined || had === null || had === "") continue;
    (out[block] as Record<string, unknown>)[field] = had;
    if (!out.citations.some((x) => x.kind === "ahj_correction" && x.field === c.field)) out.citations.push(c);
  }
  return out;
}

/** Human verification: the operator confirmed the values against official sources. */
export function saveVerifiedCodeProfile(db: AppDb, profile: JurisdictionCodeProfile, verifiedBy: string): JurisdictionCodeProfile {
  const saved = upsert(db, profile, { confidence: "verified", verifiedBy });
  addAuditLog(db, null, "human", verifiedBy || "operator", "code_profile.verified", {
    key: saved.key, state: saved.state, ahj: saved.ahj,
  });
  return saved;
}

/** Merge the jurisdiction's profile over model-code defaults into the context
 *  the rule engines consume. Never throws; missing table → defaults. */
export function resolveEffectiveCodeContext(db: AppDb, state: string, ahj: string): EffectiveCodeContext {
  let profile: JurisdictionCodeProfile | null = null;
  try { profile = getCodeProfile(db, { state, ahj }); } catch { profile = null; }
  let approvedDesigns: ApprovedDesignObservation[] = [];
  try { approvedDesigns = listApprovedDesignObservations(db, state, ahj); } catch { approvedDesigns = []; }
  return buildCodeContext(state, ahj, profile, approvedDesigns);
}

/**
 * THE PERMIT PATH, DECIDED WITH THIS JURISDICTION'S OWN RULES.
 *
 * resolvePermitPath is pure and has no database, so on its own it can only offer Oregon's
 * screen (for Oregon) or an honest "unknown". This is the seam that hands it the
 * jurisdiction's researched prescriptive limits, so a Florida or Ohio project can be
 * routed by FLORIDA's or OHIO's published rule instead of waiting on a human forever.
 *
 * It also closes the loop the operator asked for — "ensuring the LLM can look up as needed
 * when it encounters a new one": touching an un-profiled jurisdiction queues the research
 * that fills these limits in, so the second project in Cape Coral is answered even though
 * the first one had to be confirmed by hand.
 *
 * Every db-holding caller should prefer this over the bare resolver.
 */
export function resolvePermitPathForProject(
  db: AppDb,
  project: ProjectRecord,
): ReturnType<typeof resolvePermitPath> {
  let limits: PrescriptiveLimits | undefined;
  try {
    const profile = getCodeProfile(db, { state: project.state, ahj: project.ahj });
    limits = profile?.prescriptive;
    // No profile at all for a jurisdiction we are actually filing in → go find out.
    // ensureCodeProfilesResearched owns its own dedupe and 6-hour backoff.
    if (!profile) ensureCodeProfilesResearched(db, project.state, project.ahj);
  } catch { /* research is best-effort; never break a path resolution */ }
  return resolvePermitPath(project, { limits });
}

/** Pure context builder (also used by tests and the Oregon-constants fallback). */
export function buildCodeContext(state: string, ahj: string, profile: JurisdictionCodeProfile | null, approvedDesigns: ApprovedDesignObservation[] = []): EffectiveCodeContext {
  const verified = profile?.confidence === "verified";
  const adopted = profile?.adoptedCodes?.length ? profile.adoptedCodes : MODEL_CODE_DEFAULTS;
  const source: EffectiveCodeContext["source"] = !profile ? "defaults" : verified ? "verified" : "seeded";
  return {
    state, ahj, source, verified, profile, approvedDesigns,
    adoptedCodes: adopted,
    amendments: profile?.amendments ?? [],
    designCriteria: profile?.designCriteria ?? {},
    prescriptive: profile?.prescriptive ?? {},
    fireSetbacks: profile?.fireSetbacks ?? [],
    citationFor(code: string, section: string, title: string, fallback?: CodeReference): CodeReference {
      const edition = adopted.find((e) => e.code.toUpperCase() === code.toUpperCase());
      // ONE STATE'S CODE IS NOT ANOTHER'S AUTHORITY.
      //
      // The rules pass Oregon fallbacks (ORSC/OSSC sections, oregon.gov/bcd worksheet
      // links) because they were written for Oregon. Two paths carried those into other
      // states' documents, both confirmed by audit on 2026-09-22:
      //   · a family with no adopted edition returns the fallback VERBATIM, so a Cape
      //     Coral finding cited the Oregon Residential Specialty Code as its authority;
      //   · a MODEL-CODE default (NEC/IRC/IBC/IFC, which always match, which is why the
      //     honest "no adopted-code data" branch below was unreachable) carries no URL of
      //     its own, so `edition.sourceUrl || fallback?.sourceUrl` reached past it and
      //     hyperlinked Oregon BCD as the source for a Florida NEC citation.
      // Outside Oregon an Oregon source is dropped rather than shown, and the citation
      // says it is unconfirmed. Losing a link is a smaller harm than a wrong authority
      // on a document a Florida plans examiner reads.
      const foreignOregonSource = (value: string): boolean =>
        state.trim().toUpperCase() !== "OR" && /oregon|\bor\.gov\b|\bbcd\b|orsc|ossc|oar\s*918/i.test(value || "");
      const safeUrl = (value: string | undefined): string => (value && !foreignOregonSource(value) ? value : "");

      if (!edition) {
        if (fallback && !foreignOregonSource(`${fallback.code} ${fallback.sourceUrl} ${fallback.adoptionScope}`)) return fallback;
        return {
          code, section, title,
          adoptionScope: `Verify the adopted edition with ${ahj || state || "the jurisdiction"}.`,
          sourceUrl: "",
          note: fallback
            ? `No adopted-code data for ${ahj || state || "this jurisdiction"} — and the reference this rule carries is Oregon's, which is not authority here. Confirm the local code cycle and amendments.`
            : "No adopted-code data for this jurisdiction — confirm the local code cycle and amendments.",
        };
      }
      // Did this edition come from the jurisdiction, or is it the model-code default
      // standing in? The difference is the whole claim being made.
      const isModelDefault = !profile?.adoptedCodes?.length;
      return {
        code: `${edition.edition} ${edition.code}`.trim(),
        section,
        title,
        adoptionScope: isModelDefault
          ? `No adopted-code record for ${ahj || state || "this jurisdiction"} — showing the ${edition.code} model cycle as a placeholder. Confirm what is adopted locally before citing it.`
          : verified
            ? `${ahj || state}: adopted ${edition.code} ${edition.edition}${edition.title ? ` (${edition.title})` : ""}.`
            : `${ahj || state}: ${edition.code} ${edition.edition} (seeded — verify locally before citing as authoritative).`,
        sourceUrl: safeUrl(edition.sourceUrl) || safeUrl(fallback?.sourceUrl) || "",
        note: edition.notes || fallback?.note || "",
      };
    },
  };
}

// --- Reference seeding -------------------------------------------------------
// backend/data/reference-code-profiles.json ships known-good profiles (Oregon
// verified from the previously hardcoded constants; example counties seeded).
// Idempotent; NEVER overwrites a verified row; seeds only missing/seeded keys.
export function seedReferenceCodeProfiles(db: AppDb): void {
  try {
    const filePath = path.resolve(process.env.CODE_PROFILE_REFERENCE_PATH || path.join(process.cwd(), "backend/data/reference-code-profiles.json"));
    if (!fs.existsSync(filePath)) return;
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as { profiles?: Array<JurisdictionCodeProfile & { confidence?: string }> };
    let seeded = 0;
    for (const p of data.profiles ?? []) {
      const key = codeProfileKey(p);
      const existing = db.get<Row>("SELECT confidence FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
      if (existing) continue; // never clobber operator edits (verified OR re-seeded)
      upsert(db, p, { confidence: p.confidence === "verified" ? "verified" : "seeded", verifiedBy: p.confidence === "verified" ? "reference-seed" : undefined });
      seeded++;
    }
    if (seeded > 0) logger.info("code-profiles", `seeded ${seeded} jurisdiction code profile(s) from reference data`);
  } catch (err) {
    logger.warn("code-profiles", `reference seed failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Is this "AHJ" really a hostname / portal address? The learn benchmark created projects
 *  whose AHJ was the portal host ("Benchmark bsaonline.com"), and each one became a shared
 *  seeded code profile for a jurisdiction that does not exist. A dot followed by a TLD at a
 *  word boundary, a scheme or "www.", or a known portal-vendor host token. Deliberately
 *  narrow on the dot rule so "St. Johns County" / "Ft. Myers" / "Washington D.C." pass. */
const PORTAL_HOST_TOKEN = /bsaonline|accela\.com|citizenaccess|energov|tylerhost|etrakit|smartgovcommunity|citizenserve|viewpointcloud|projectdox|powerclerk|opengov\.com/i;
export function ahjLooksLikeHostname(ahj: string): boolean {
  const s = (ahj || "").trim();
  if (!s) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /(^|\s)www\./i.test(s)) return true;
  if (/[a-z0-9-]\.(?:com|net|org|gov|us|edu|info|io|biz)(?![a-z0-9])/i.test(s)) return true;
  return PORTAL_HOST_TOKEN.test(s);
}

/** Research this process has already asked for, keyed by profile key → when. The DB check
 *  below cannot see an enqueue that has not happened yet: the enqueue sits behind a lazy
 *  import, so five synchronous callers all passed the check before the first job row landed
 *  (production: 24 code_research jobs for 8 keys, 4-5 identical rows in the same ms). This is
 *  set SYNCHRONOUSLY before the import, cleared if the enqueue fails so a retry is possible,
 *  and expires with the DB window; the DB check stays for dedupe across restarts. */
const CODE_RESEARCH_WINDOW_MS = 6 * 3600_000;
const inFlightCodeResearch = new Map<string, number>();

// --- Autonomous onboarding ----------------------------------------------------
// "Search all the codes needed — city/county AND state — and store them." The
// moment any review (internal gate or standalone API) touches a jurisdiction
// whose code profile isn't verified, background research jobs are enqueued for
// every missing LAYER: the state default (which counties/cities inherit) and the
// specific AHJ (the city or county itself — its row records local amendments +
// design criteria over the state layer). Fire-and-forget: the current review
// proceeds on defaults/"verify locally"; the next one picks up the seeded data,
// and a human verifies when convenient. Dedupe: never enqueue when the layer's
// row already exists or a research job for it is already pending/running.
export function ensureCodeProfilesResearched(db: AppDb, state: string, ahj: string): number {
  // The learn benchmark creates a throwaway project per portal, each in a different city, so
  // every run would enqueue jurisdiction research for jurisdictions nobody is filing in —
  // minutes of web-search LLM calls that say nothing about whether the PORTAL can be learned.
  // The benchmark is meant to be run often, so it opts out.
  if (process.env.SKIP_CODE_RESEARCH === "1" || codeResearchSwitchedOff()) return 0;
  const st = (state || "").trim();
  if (!st) return 0;
  const layers: Array<{ state: string; ahj: string }> = [{ state: st, ahj: "" }];
  // A hostname is not a jurisdiction: skip the AHJ layer, still research the state default.
  if ((ahj || "").trim() && !ahjLooksLikeHostname(ahj)) layers.push({ state: st, ahj: ahj.trim() });
  else if ((ahj || "").trim()) logger.info("code-profiles", `auto-research skipped for AHJ "${ahj.trim()}" — it looks like a hostname, not a jurisdiction`);
  let enqueued = 0;
  for (const layer of layers) {
    try {
      const key = codeProfileKey(layer);
      // WHAT THE ROW HOLDS, NOT THAT IT EXISTS. A row created only by a human applying an AHJ
      // correction's design criteria (or by the design-criteria lookup) carries no adopted codes,
      // and "a row exists, done" would then never research that AHJ's code cycle. Such a row is
      // still researched. Any other row — a verified one, one with codes, or an operator import
      // (the Stamp Summary rows carry amendments and their own citation) — is left alone as
      // before: a research re-save replaces the payload, and must not wipe imported notes.
      const existing = db.get<Row>("SELECT confidence, payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
      if (existing && (text(existing.confidence) === "verified" || !rowHoldsOnlyLearnedCriteria(existing))) continue;
      const askedAt = inFlightCodeResearch.get(key);
      if (askedAt != null && Date.now() - askedAt < CODE_RESEARCH_WINDOW_MS) continue;
      // Dedupe: a pending/running job for this layer, OR any attempt in the last
      // 6 hours (a stub/failed research stores no row — without the time window,
      // every review of the jurisdiction would re-queue no-op research forever).
      const recent = db.get<Row>(
        `SELECT id FROM job_queue
          WHERE job_type = 'code_research' AND payload LIKE ?
            AND (status IN ('pending','running') OR created_at > ?)`,
        [`%${key}%`, new Date(Date.now() - CODE_RESEARCH_WINDOW_MS).toISOString()],
      );
      if (recent) continue;
      inFlightCodeResearch.set(key, Date.now());
      // Lazy import avoids a static cycle (jobQueue -> ... -> codeProfiles).
      void import("./jobQueue").then(({ enqueueJob, processNextJob }) => {
        // maxRetries 2: the worker's retry math (`retryCount+1 < maxRetries`)
        // means 1 yields ZERO retries — 2 gives the intended single retry.
        enqueueJob(db, "code_research", { state: layer.state, ahj: layer.ahj, profileKey: key }, { priority: 3, maxRetries: 2 });
        void processNextJob(db).catch(() => null);
      }).catch(() => { inFlightCodeResearch.delete(key); });
      enqueued++;
      logger.info("code-profiles", `auto-research queued for ${layer.state}/${layer.ahj || "(state default)"}`);
    } catch { /* autonomy is best-effort — never break a review */ }
  }
  // A row can EXIST and still say nothing about the site: Coos Bay's researched profile had
  // adopted codes and designCriteria {} — so the check above ("a row exists, done") never
  // asked again, and every project there reviewed against an unknown ground snow load.
  const ahjLayer = layers.find((l) => l.ahj);
  if (ahjLayer) {
    try { enqueued += ensureDesignCriteriaResearched(db, ahjLayer.state, ahjLayer.ahj); } catch { /* best-effort */ }
  }
  return enqueued;
}

/** Does this row hold NOTHING but design criteria learned from AHJ corrections / the lookup? No
 *  adopted codes, no amendments or fire setbacks, no research provenance, and every citation of
 *  kind "ahj_correction" or "design_criteria_research". Unparseable -> false (leave it alone). */
function rowHoldsOnlyLearnedCriteria(row: Row): boolean {
  try {
    const p = JSON.parse(text(row.payload_json) || "{}") as Partial<JurisdictionCodeProfile> & { researchProvenance?: unknown };
    const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
    if (len(p.adoptedCodes) || len(p.amendments) || len(p.fireSetbacks) || p.researchProvenance) return false;
    return (Array.isArray(p.citations) ? p.citations : []).every((c) => c?.kind === "ahj_correction" || c?.kind === "design_criteria_research");
  } catch {
    return false;
  }
}

/** CODE_RESEARCH=off stops every automatic jurisdiction lookup (full code research and the
 *  narrow design-criteria lookup) — for tests, demos and CI that must never call out. */
function codeResearchSwitchedOff(): boolean {
  return /^(off|0|false|no)$/i.test(String(process.env.CODE_RESEARCH ?? "").trim());
}

// --- The AHJ's OWN row -----------------------------------------------------------
//
// getCodeProfile MERGES the AHJ row over the state default, so "what does Coos Bay have on
// file" read through it answers with the state's values. Anything that writes one AHJ's
// criteria, or asks whether that AHJ has them, must read the AHJ's own row — exact key first,
// then the same fuzzy name match (state required) — or it would write under the project's
// spelling and fork the jurisdiction into two rows.
export function ownCodeProfileRow(db: AppDb, state: string, ahj: string): { key: string; profile: JurisdictionCodeProfile } | null {
  if (!String(ahj || "").trim() || !String(state || "").trim()) return null;
  const row = db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [codeProfileKey({ state, ahj })]) ?? fuzzyCodeRow(db, { state, ahj });
  return row ? { key: text(row.profile_key), profile: mapRow(row) } : null;
}

/**
 * THE WRITE PATH'S ROW: the AHJ's row by EXACT profile key, or null (the writer creates it). Never
 * a fuzzy name match — reads may bridge "Woodburn" / "City of Woodburn", but a write that fuzzy-
 * matched put a correction from "City of Lincoln City" into "Lincoln County"'s shared row (score
 * 65, over the 60 threshold). Every writer of one AHJ's criteria (a correction apply, the
 * design-criteria lookup and its merge) resolves its row here.
 */
export function exactCodeProfileRow(db: AppDb, state: string, ahj: string): { key: string; profile: JurisdictionCodeProfile } | null {
  if (!String(ahj || "").trim() || !String(state || "").trim()) return null;
  const row = db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [codeProfileKey({ state, ahj })]);
  return row ? { key: text(row.profile_key), profile: mapRow(row) } : null;
}

/** For display only: the DIFFERENT existing row a fuzzy name match would pick for this AHJ. */
export function nearestOtherCodeProfileRow(db: AppDb, state: string, ahj: string): { key: string; ahj: string } | null {
  if (!String(ahj || "").trim() || !String(state || "").trim()) return null;
  const row = fuzzyCodeRow(db, { state, ahj });
  if (!row || text(row.profile_key) === codeProfileKey({ state, ahj })) return null;
  return { key: text(row.profile_key), ahj: text(row.ahj) };
}

type CriterionBlock = JurisdictionCriteriaProposal["block"];
type CriterionValue = JurisdictionCriteriaProposal["value"];

function blockValue(profile: JurisdictionCodeProfile | null, block: CriterionBlock, criterion: string): CriterionValue | null {
  if (!profile) return null;
  const v = (profile[block] as Record<string, unknown> | undefined)?.[criterion];
  return typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.trim()) ? (v as CriterionValue) : null;
}

export function sameCriterionValue(a: CriterionValue | null, b: CriterionValue | null): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
}

/** What the AHJ's own row holds for one criterion right now (for a proposal's old -> new). */
export function currentCriterionOnFile(db: AppDb, state: string, ahj: string, block: CriterionBlock, criterion: string): {
  profileKey: string; targetProfileKey: string; value: CriterionValue | null; confidence: "seeded" | "verified" | null;
} {
  // The row the apply will WRITE — exact key only (see exactCodeProfileRow).
  const own = exactCodeProfileRow(db, state, ahj);
  return {
    profileKey: own?.key ?? "",
    targetProfileKey: codeProfileKey({ state, ahj }),
    value: blockValue(own?.profile ?? null, block, criterion),
    confidence: own?.profile.confidence ?? null,
  };
}

/**
 * APPLY ONE AHJ-STATED CRITERION — only ever after a human approved it (the corrections apply
 * route). Writes the AHJ's own row as "seeded" with a citation to the comment. Refuses:
 *  - a human-verified row (hard rule 3) — never touched, whatever the AHJ comment says;
 *  - a row whose value CHANGED since the proposal was made — the human approved "old -> new"
 *    for a specific old; replacing a value they never saw is the silent overwrite this avoids.
 */
export function applyCorrectionCriterionToProfile(
  db: AppDb,
  proposal: JurisdictionCriteriaProposal,
  opts: { actor: string; projectId: string | null },
): { status: "applied" | "refused"; note: string; profileKey: string } {
  const own = exactCodeProfileRow(db, proposal.state, proposal.ahj);
  // A proposal made before writes went exact-key-only may name a fuzzy-matched row of ANOTHER
  // jurisdiction ("Lincoln County" for "City of Lincoln City"): never write through it.
  if (proposal.profileKey && proposal.profileKey !== codeProfileKey({ state: proposal.state, ahj: proposal.ahj })) {
    return { status: "refused", note: `This proposal was matched to another jurisdiction's profile row (${proposal.profileKey}), not ${proposal.ahj}'s own — re-triage the correction.`, profileKey: proposal.profileKey };
  }
  if (own && proposal.profileKey && own.key !== proposal.profileKey) {
    return { status: "refused", note: `The jurisdiction now resolves to a different profile row (${own.key}) than when this was proposed — re-triage the correction.`, profileKey: own.key };
  }
  if (own?.profile.confidence === "verified") {
    return { status: "refused", note: "The jurisdiction's profile is human-verified — an AHJ comment does not overwrite it. Update it through code-profile verification if it is wrong.", profileKey: own.key };
  }
  const now = blockValue(own?.profile ?? null, proposal.block, proposal.criterion);
  if (!sameCriterionValue(now, proposal.currentValue)) {
    return { status: "refused", note: `The profile's ${proposal.criterion} changed since this was proposed (now ${now ?? "blank"}, proposal assumed ${proposal.currentValue ?? "blank"}) — re-triage the correction to see the current value.`, profileKey: own?.key ?? "" };
  }
  const base: JurisdictionCodeProfile = own?.profile ?? {
    key: "", state: proposal.state, ahj: proposal.ahj, confidence: "seeded",
    adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  };
  const field = `${proposal.block}.${proposal.criterion}`;
  const next: JurisdictionCodeProfile = {
    ...base,
    designCriteria: { ...base.designCriteria },
    prescriptive: { ...base.prescriptive },
    citations: base.citations.filter((c) => !(c.kind === "ahj_correction" && c.field === field)),
  };
  (next[proposal.block] as Record<string, unknown>)[proposal.criterion] = proposal.value;
  next.citations.push({
    label: `AHJ correction${proposal.source.recordNumber ? ` on record ${proposal.source.recordNumber}` : ""} (${proposal.source.receivedAt.slice(0, 10)}): ${proposal.criterion} = ${String(proposal.value)}`,
    sourceUrl: "",
    kind: "ahj_correction",
    field,
    quote: proposal.basis.slice(0, 240),
    correctionId: proposal.source.correctionId,
    recordNumber: proposal.source.recordNumber,
    at: proposal.source.receivedAt,
  });
  const saved = upsert(db, next, { confidence: "seeded" });
  addAuditLog(db, opts.projectId, "human", opts.actor || "operator", "code_profile.criterion_from_correction", {
    profileKey: codeProfileKey(next), field, from: proposal.currentValue, to: proposal.value,
    correctionId: proposal.source.correctionId, recordNumber: proposal.source.recordNumber,
  });
  return { status: "applied", note: `Recorded on the ${saved.ahj || proposal.ahj} code profile as seeded, citing the AHJ comment.`, profileKey: codeProfileKey(next) };
}

// --- Approved designs: corroboration, never the rule --------------------------------

/**
 * WHEN A PERMIT FIRST READS ISSUED, RECORD WHAT THE APPROVED DESIGN SAID. One row per
 * (project, target); idempotent. This is evidence ("approved designs used 25 psf") and is NEVER
 * written into designCriteria: a conservative design over-states the minimum, and treating it
 * as the rule would raise false below-ahj warnings on every leaner design after it. Skipped for
 * learning-excluded (demo/benchmark/fixture) projects — the table is pooled across tenants.
 */
/**
 * DID THIS TRACK REVIEW THE STRUCTURE? Only a building / structural / combined permit's issuance
 * says the jurisdiction accepted the design's snow and wind criteria. An ELECTRICAL permit issuing
 * says nothing about them (production: both issued targets were -ELEC, and recording them as
 * approved designs would corroborate the 16 psf the same city had just bounced), a NEM approval is
 * the utility's, and a blank / legacy "permit" type is unknown — an unknown is never recorded as
 * corroboration.
 */
export function isStructuralPermitTrack(targetType: string, permitType: string): boolean {
  if (String(targetType || "").trim().toLowerCase() === "nem") return false;
  return ["building", "structural", "combo"].includes(String(permitType || "").trim().toLowerCase());
}

export function recordApprovedDesignObservation(
  db: AppDb,
  project: ProjectRecord,
  input: { targetId: string; recordNumber: string; issuedAt?: string; ahj?: string },
): boolean {
  try {
    const ahj = String(input.ahj || project.ahj || "").trim();
    const state = String(project.state || "").trim();
    if (!ahj || !state || ahjLooksLikeHostname(ahj) || isLearningExcluded(db, project.id)) return false;
    const seen = new Set<string>();
    const criteria = extractStatedDesignCriteria(project).criteria
      .filter((c) => c.criterion === "groundSnowPsf" || c.criterion === "windSpeedMph" || c.criterion === "windExposure" || c.criterion === "riskCategory")
      .map((c) => ({ criterion: c.criterion, value: c.value, qualifier: c.qualifier }))
      .filter((c) => {
        const k = `${c.criterion}|${c.qualifier}|${c.value}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    if (!criteria.length) return false;
    const before = db.get<Row>("SELECT id FROM jurisdiction_design_observations WHERE project_id = ? AND target_id = ?", [project.id, input.targetId || ""]);
    if (before) return false;
    db.run(
      `INSERT OR IGNORE INTO jurisdiction_design_observations
        (id, profile_key, state, ahj, project_id, target_id, record_number, issued_at, criteria_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), codeProfileKey({ state, ahj }), state, ahj, project.id, input.targetId || "", String(input.recordNumber || "").slice(0, 80),
        input.issuedAt || nowIso(), JSON.stringify(criteria.slice(0, 24)), nowIso()],
    );
    return true;
  } catch (err) {
    logger.warn("code-profiles", `approved-design observation not recorded: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Observations for one AHJ (exact key or the same fuzzy name match, state required). */
export function listApprovedDesignObservations(db: AppDb, state: string, ahj: string): ApprovedDesignObservation[] {
  const st = String(state || "").trim().toUpperCase();
  const wanted = String(ahj || "").trim();
  if (!st || !wanted) return [];
  const key = codeProfileKey({ state, ahj });
  const out: ApprovedDesignObservation[] = [];
  for (const row of db.query<Row>(
    "SELECT * FROM jurisdiction_design_observations WHERE UPPER(state) = ? ORDER BY issued_at DESC LIMIT 500", [st],
  )) {
    if (text(row.profile_key) !== key && knowledgeNameMatchScore(wanted, text(row.ahj)) < 60) continue;
    let criteria: ApprovedDesignObservation["criteria"] = [];
    try { criteria = JSON.parse(text(row.criteria_json) || "[]"); } catch { criteria = []; }
    out.push({ projectId: text(row.project_id), recordNumber: text(row.record_number), issuedAt: text(row.issued_at), criteria: Array.isArray(criteria) ? criteria : [] });
  }
  return out;
}

// --- Look it up at the AHJ -------------------------------------------------------------

const DESIGN_RESEARCH_WINDOW_MS = 30 * 24 * 3600_000;
const inFlightDesignResearch = new Map<string, number>();

/**
 * ONE design-criteria lookup per AHJ whose own row lacks ground snow or wind speed. Deduped per
 * AHJ (a pending/running job, or ANY attempt in the last 30 days — a lookup that found nothing
 * leaves no row change, so the job row is the backoff marker). Never for a human-verified row
 * (filling a blank on it would still be an automatic write to verified knowledge), never while
 * a full code_research for that AHJ is in flight (it asks for the same criteria), and never
 * with research switched off, no API key, or the explicit offline/dev switch.
 */
export function ensureDesignCriteriaResearched(db: AppDb, state: string, ahj: string): number {
  if (process.env.SKIP_CODE_RESEARCH === "1" || codeResearchSwitchedOff() || isAutoSeedDisabled()) return 0;
  if (!String(process.env.ANTHROPIC_API_KEY ?? "").trim()) return 0;
  const st = String(state || "").trim();
  const name = String(ahj || "").trim();
  if (!st || !name || ahjLooksLikeHostname(name)) return 0;
  const own = exactCodeProfileRow(db, st, name);
  if (own?.profile.confidence === "verified") return 0;
  const dc = own?.profile.designCriteria ?? {};
  if (typeof dc.groundSnowLoadPsf === "number" && typeof dc.windSpeedMph === "number") return 0;
  const key = own?.key ?? codeProfileKey({ state: st, ahj: name });
  const fullAskedAt = inFlightCodeResearch.get(key);
  if (fullAskedAt != null && Date.now() - fullAskedAt < CODE_RESEARCH_WINDOW_MS) return 0;
  const fullPending = db.get<Row>(
    "SELECT id FROM job_queue WHERE job_type = 'code_research' AND payload LIKE ? AND status IN ('pending','running')", [`%${key}%`],
  );
  if (fullPending) return 0;
  const askedAt = inFlightDesignResearch.get(key);
  if (askedAt != null && Date.now() - askedAt < DESIGN_RESEARCH_WINDOW_MS) return 0;
  const recent = db.get<Row>(
    `SELECT id FROM job_queue WHERE job_type = 'design_criteria_research' AND payload LIKE ?
        AND (status IN ('pending','running') OR created_at > ?)`,
    [`%${key}%`, new Date(Date.now() - DESIGN_RESEARCH_WINDOW_MS).toISOString()],
  );
  if (recent) return 0;
  inFlightDesignResearch.set(key, Date.now());
  const ahjForJob = own?.profile.ahj || name;
  const stateForJob = own?.profile.state || st;
  const payload = { state: stateForJob, ahj: ahjForJob, profileKey: key };
  if (designResearchEnqueuerForTests) designResearchEnqueuerForTests(db, payload);
  else void import("./jobQueue").then(({ enqueueJob, processNextJob }) => {
    enqueueJob(db, "design_criteria_research", payload, { priority: 3, maxRetries: 2 });
    void processNextJob(db).catch(() => null);
  }).catch(() => { inFlightDesignResearch.delete(key); });
  logger.info("code-profiles", `design-criteria lookup queued for ${stateForJob}/${ahjForJob}`);
  return 1;
}

/** Test seam: the profile keys this process has queued full code research for. */
export function researchQueuedForTests(): string[] {
  return [...inFlightCodeResearch.keys()];
}

/** Test seam: forget this process's in-flight markers (the DB job rows still dedupe). */
export function resetResearchMarkersForTests(): void {
  inFlightCodeResearch.clear();
  inFlightDesignResearch.clear();
}

/** Test seam: enqueue WITHOUT kicking the worker (the real path runs the job at once, which
 *  would reach the network with a test key). null restores the real path. */
let designResearchEnqueuerForTests: ((db: AppDb, payload: Record<string, unknown>) => void) | null = null;
export function setDesignResearchEnqueuerForTests(fn: ((db: AppDb, payload: Record<string, unknown>) => void) | null): void {
  designResearchEnqueuerForTests = fn;
}

/**
 * Land a design-criteria lookup: fill ONLY blank fields on the AHJ's own row, as "seeded", each
 * with its citation. Never a verified row; never overwrite a value already on file (an AHJ
 * correction or an operator put it there); only web-grounded values with a source URL.
 */
export function mergeResearchedDesignCriteria(
  db: AppDb,
  target: { state: string; ahj: string; profileKey?: string },
  result: DesignCriteriaResearchResult,
): { saved: boolean; filled: string[]; skipped: string[]; reason?: string; profileKey: string } {
  const row = target.profileKey ? db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [target.profileKey]) : null;
  const own = row ? { key: text(row.profile_key), profile: mapRow(row) } : exactCodeProfileRow(db, target.state, target.ahj);
  const key = own?.key ?? codeProfileKey(target);
  if (own?.profile.confidence === "verified") return { saved: false, filled: [], skipped: [], reason: "profile is human-verified", profileKey: key };
  if (result.provider === "stub") return { saved: false, filled: [], skipped: [], reason: "stub LLM (no API key)", profileKey: key };
  if (!result.webGrounded) return { saved: false, filled: [], skipped: [], reason: "not web-grounded — model memory is not stored as a design criterion", profileKey: key };
  const base: JurisdictionCodeProfile = own?.profile ?? {
    key: "", state: target.state, ahj: target.ahj, confidence: "seeded",
    adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  };
  const dc: JurisdictionDesignCriteria = { ...base.designCriteria };
  const citations = [...base.citations];
  const filled: string[] = [];
  const skipped: string[] = [];
  const at = nowIso();
  for (const v of result.values ?? []) {
    const url = String(v.sourceUrl || "").trim();
    if (!/^https?:\/\//i.test(url)) { skipped.push(`${v.criterion} (no source URL)`); continue; }
    let value: number | string | null = null;
    if (v.criterion === "windExposure") value = /^[BCD]$/i.test(String(v.value).trim()) ? String(v.value).trim().toUpperCase() : null;
    else value = typeof v.value === "number" && Number.isFinite(v.value) && v.value > 0 && v.value < 400 ? v.value : null;
    if (value == null) { skipped.push(`${v.criterion} (unusable value)`); continue; }
    const had = (dc as Record<string, unknown>)[v.criterion];
    if (had !== undefined && had !== null && had !== "") { skipped.push(`${v.criterion} (already on file)`); continue; }
    (dc as Record<string, unknown>)[v.criterion] = value;
    citations.push({ label: `Design criteria lookup: ${v.criterion} = ${value}`, sourceUrl: url.slice(0, 500), kind: "design_criteria_research", field: `designCriteria.${v.criterion}`, ...(v.quote ? { quote: String(v.quote).slice(0, 240) } : {}), at });
    filled.push(v.criterion);
  }
  if (!filled.length) return { saved: false, filled, skipped, reason: "nothing new to fill", profileKey: key };
  if (!dc.sourceUrl) dc.sourceUrl = citations.filter((c) => c.kind === "design_criteria_research").pop()?.sourceUrl;
  upsert(db, { ...base, designCriteria: dc, citations }, { confidence: "seeded" });
  addAuditLog(db, null, "system", "design criteria lookup", "code_profile.design_criteria_researched", { profileKey: key, filled, skipped });
  return { saved: true, filled, skipped, profileKey: key };
}

/** The design_criteria_research job body. `provider` is a test seam. */
export async function runDesignCriteriaResearch(
  db: AppDb,
  payload: { state?: unknown; ahj?: unknown; profileKey?: unknown },
  provider?: LLMProvider,
): Promise<Record<string, unknown>> {
  const state = String(payload.state || "");
  const ahj = String(payload.ahj || "");
  const profileKey = String(payload.profileKey || "") || undefined;
  const llm = provider ?? (await import("./llm")).createLLMProvider();
  if (!llm.researchDesignCriteria) return { saved: false, reason: "provider has no design-criteria lookup" };
  const research = await llm.researchDesignCriteria({ state, ahj });
  const merged = mergeResearchedDesignCriteria(db, { state, ahj, profileKey }, research);
  return { ...merged, webGrounded: research.webGrounded, found: research.values?.length ?? 0 };
}
