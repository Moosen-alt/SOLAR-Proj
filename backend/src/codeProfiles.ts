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
} from "../../shared/src/types";
import { knowledgeProfileKey } from "./knowledgeBase";
import { addAuditLog } from "./audit";
import { logger } from "./logger";
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
export function getCodeProfile(db: AppDb, input: { state?: string; ahj?: string }): JurisdictionCodeProfile | null {
  const exactRow = input.ahj
    ? db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [codeProfileKey({ state: input.state, ahj: input.ahj })])
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
      if (!edition) {
        return fallback ?? {
          code, section, title,
          adoptionScope: `Verify the adopted edition with ${ahj || state || "the jurisdiction"}.`,
          sourceUrl: "",
          note: "No adopted-code data for this jurisdiction — confirm the local code cycle and amendments.",
        };
      }
      return {
        code: `${edition.edition} ${edition.code}`.trim(),
        section,
        title,
        adoptionScope: verified
          ? `${ahj || state}: adopted ${edition.code} ${edition.edition}${edition.title ? ` (${edition.title})` : ""}.`
          : `${ahj || state}: ${edition.code} ${edition.edition} (seeded — verify locally before citing as authoritative).`,
        sourceUrl: edition.sourceUrl || fallback?.sourceUrl || "",
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
    const filePath = path.resolve(process.cwd(), "backend/data/reference-code-profiles.json");
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
        enqueueJob(db, "code_research", { state: layer.state, ahj: layer.ahj, profileKey: key }, { priority: 3, maxRetries: 1 });
        void processNextJob(db).catch(() => null);
      }).catch(() => null);
      enqueued++;
      logger.info("code-profiles", `auto-research queued for ${layer.state}/${layer.ahj || "(state default)"}`);
    } catch { /* autonomy is best-effort — never break a review */ }
  }
  return enqueued;
}
