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
  CodeEdition,
  CodeReference,
  JurisdictionCodeProfile,
  JurisdictionDesignCriteria,
  PrescriptiveLimits,
  FireSetbackRule,
  ProjectRecord,
} from "../../shared/src/types";
import { knowledgeProfileKey, knowledgeNameMatchScore } from "./knowledgeBase";
import { addAuditLog } from "./audit";
import { logger } from "./logger";
import { resolvePermitPath } from "./permitPath";
import { nowIso } from "./time";

interface Row { [key: string]: unknown }
const text = (v: unknown): string => (v == null ? "" : String(v));

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
  return db.query<Row>("SELECT * FROM jurisdiction_code_profiles ORDER BY state, ahj").map(mapRow);
}

function upsert(db: AppDb, profile: JurisdictionCodeProfile, opts: { confidence: "seeded" | "verified"; verifiedBy?: string }): JurisdictionCodeProfile {
  const key = codeProfileKey(profile);
  const ts = nowIso();
  const payload = JSON.stringify({
    adoptedCodes: profile.adoptedCodes ?? [],
    amendments: profile.amendments ?? [],
    designCriteria: profile.designCriteria ?? {},
    prescriptive: profile.prescriptive ?? {},
    fireSetbacks: profile.fireSetbacks ?? [],
    citations: profile.citations ?? [],
  });
  const existing = db.get<Row>("SELECT confidence, researched_at, verified_at, verified_by FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
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
  const existing = db.get<Row>("SELECT confidence FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
  if (existing && text(existing.confidence) === "verified") {
    logger.info("code-profiles", `research skipped — ${profile.state}/${profile.ahj || "(state default)"} is human-verified`);
    return getCodeProfile(db, profile)!;
  }
  return upsert(db, profile, { confidence: "seeded" });
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
  return buildCodeContext(state, ahj, profile);
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
export function buildCodeContext(state: string, ahj: string, profile: JurisdictionCodeProfile | null): EffectiveCodeContext {
  const verified = profile?.confidence === "verified";
  const adopted = profile?.adoptedCodes?.length ? profile.adoptedCodes : MODEL_CODE_DEFAULTS;
  const source: EffectiveCodeContext["source"] = !profile ? "defaults" : verified ? "verified" : "seeded";
  return {
    state, ahj, source, verified, profile,
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
  if (process.env.SKIP_CODE_RESEARCH === "1") return 0;
  const st = (state || "").trim();
  if (!st) return 0;
  const layers: Array<{ state: string; ahj: string }> = [{ state: st, ahj: "" }];
  if ((ahj || "").trim()) layers.push({ state: st, ahj: ahj.trim() });
  let enqueued = 0;
  for (const layer of layers) {
    try {
      const key = codeProfileKey(layer);
      const existing = db.get<Row>("SELECT profile_key FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
      if (existing) continue;
      // Dedupe: a pending/running job for this layer, OR any attempt in the last
      // 6 hours (a stub/failed research stores no row — without the time window,
      // every review of the jurisdiction would re-queue no-op research forever).
      const recent = db.get<Row>(
        `SELECT id FROM job_queue
          WHERE job_type = 'code_research' AND payload LIKE ?
            AND (status IN ('pending','running') OR created_at > ?)`,
        [`%${key}%`, new Date(Date.now() - 6 * 3600_000).toISOString()],
      );
      if (recent) continue;
      // Lazy import avoids a static cycle (jobQueue -> ... -> codeProfiles).
      void import("./jobQueue").then(({ enqueueJob, processNextJob }) => {
        // maxRetries 2: the worker's retry math (`retryCount+1 < maxRetries`)
        // means 1 yields ZERO retries — 2 gives the intended single retry.
        enqueueJob(db, "code_research", { state: layer.state, ahj: layer.ahj, profileKey: key }, { priority: 3, maxRetries: 2 });
        void processNextJob(db).catch(() => null);
      }).catch(() => null);
      enqueued++;
      logger.info("code-profiles", `auto-research queued for ${layer.state}/${layer.ahj || "(state default)"}`);
    } catch { /* autonomy is best-effort — never break a review */ }
  }
  return enqueued;
}
