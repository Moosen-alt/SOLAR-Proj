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
import { fileURLToPath } from "node:url";
import type { AppDb } from "./db";
import type {
  ApprovedDesignObservation,
  CodeEdition,
  CodeFamily,
  CodeReference,
  CodeResearchProvenance,
  DesignCriteriaChecklistItem,
  DesignCriteriaLookupProgress,
  DesignCriteriaLookupRecord,
  DesignCriteriaResearchResult,
  JurisdictionAdoptionModel,
  JurisdictionCodeProfile,
  JurisdictionCriteriaProposal,
  JurisdictionDesignCriteria,
  JurisdictionEditionProposal,
  LLMProvider,
  PrescriptiveLimits,
  FireSetbackRule,
  ProjectRecord,
  UpcomingCodeEdition,
} from "../../shared/src/types";
import { knowledgeProfileKey, knowledgeNameMatchScore, isLearningExcluded } from "./knowledgeBase";
import { addAuditLog } from "./audit";
import { extractStatedDesignCriteria, normCodeToken } from "./designCriteria";
import {
  CODE_FAMILIES, codeFamilyOf, editionLabel, editionsInEffect, familyAdoptionModel, isAdoptionModel,
  isCodeFamily, isFamilyAdoptionModel, locallyAdoptedFamilies, modelBaseOf, upcomingDue,
} from "./codeFamilies";
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
 *  returns; absent means the row came from a path that does not say (imports, seeds).
 *  The type lives in shared/src/types.ts; re-exported for the modules that import it here. */
export type { CodeResearchProvenance };

const PROVENANCE_METHODS = ["web_search", "model_memory", "reference_truth"] as const;
const MAX_RESULT_URLS = 20;

function provenanceOf(value: unknown): CodeResearchProvenance | undefined {
  const p = (value as { researchProvenance?: unknown } | null)?.researchProvenance as Partial<CodeResearchProvenance> | undefined;
  if (!p || typeof p !== "object" || typeof p.webGrounded !== "boolean") return undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
  // The stored method is kept when it is one we know ("reference_truth" is grounded but not a web
  // search); an unknown/missing one is derived from webGrounded, as before.
  const method = (PROVENANCE_METHODS as readonly string[]).includes(String(p.method)) && (p.method !== "model_memory" || !p.webGrounded)
    ? p.method as CodeResearchProvenance["method"]
    : p.webGrounded ? "web_search" : "model_memory";
  const out: CodeResearchProvenance = { webGrounded: p.webGrounded, method };
  if (p.notes) out.notes = String(p.notes).slice(0, 1000);
  if (typeof p.at === "string" && p.at) out.at = p.at.slice(0, 40);
  for (const k of ["searches", "groundedSearches", "inputTokens", "outputTokens"] as const) {
    const n = num(p[k]);
    if (n !== undefined) out[k] = n;
  }
  if (Array.isArray(p.resultUrls)) {
    const urls = p.resultUrls.map((u) => String(u || "").slice(0, 300)).filter((u) => /^https?:\/\//i.test(u));
    if (urls.length) out.resultUrls = [...new Set(urls)].slice(0, MAX_RESULT_URLS);
  }
  if (typeof p.model === "string" && p.model) out.model = p.model.slice(0, 60);
  return out;
}

/** A stored adoption model, validated (unknown values dropped rather than trusted). */
function adoptionModelOf(value: unknown): JurisdictionAdoptionModel | undefined {
  const m = value as Partial<JurisdictionAdoptionModel> | null | undefined;
  if (!m || typeof m !== "object" || !isAdoptionModel(m.model)) return undefined;
  const byFamily: JurisdictionAdoptionModel["byFamily"] = {};
  for (const [fam, v] of Object.entries(m.byFamily ?? {})) if (isCodeFamily(fam) && isFamilyAdoptionModel(v)) byFamily[fam] = v;
  return {
    model: m.model,
    ...(Object.keys(byFamily).length ? { byFamily } : {}),
    ...(m.sourceUrl ? { sourceUrl: String(m.sourceUrl).slice(0, 500) } : {}),
    ...(m.quote ? { quote: String(m.quote).slice(0, 400) } : {}),
    ...(m.note ? { note: String(m.note).slice(0, 600) } : {}),
  };
}

function upcomingOf(value: unknown): UpcomingCodeEdition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((u): u is Record<string, unknown> => !!u && typeof u === "object")
    .map((u) => ({
      family: isCodeFamily(u.family) ? u.family : codeFamilyOf({ code: String(u.code || ""), basedOn: String(u.basedOn || "") }),
      code: String(u.code || "").slice(0, 40),
      edition: String(u.edition || "").slice(0, 16),
      ...(u.basedOn ? { basedOn: String(u.basedOn).slice(0, 120) } : {}),
      ...(/^\d{4}-\d{2}-\d{2}/.test(String(u.anticipatedDate || "")) ? { anticipatedDate: String(u.anticipatedDate).slice(0, 10) } : {}),
      ...(u.status ? { status: String(u.status).slice(0, 40) } : {}),
      ...(u.sourceUrl ? { sourceUrl: String(u.sourceUrl).slice(0, 500) } : {}),
      ...(u.quote ? { quote: String(u.quote).slice(0, 300) } : {}),
    }))
    .filter((u): u is UpcomingCodeEdition => !!u.family && !!u.code && !!u.edition)
    .slice(0, 12);
  return out;
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
  /** Where this AHJ's design-criteria lookup stands (readDesignLookupProgress — a job_queue READ).
   *  Loaded by resolveEffectiveCodeContext; absent from the pure builder and when no lookup exists. */
  designLookup?: DesignCriteriaLookupProgress;
  /** Resolve a citation for a code family ("NEC", "IRC", …) from the adopted
   *  editions; returns a CodeReference shell the rule fills with section/title. */
  citationFor(code: string, section: string, title: string, fallback?: CodeReference): CodeReference;
}

/** The citation an applied AHJ correction leaves on the SHARED profile: which field, what value,
 *  when, and a generic source label — never the AHJ's sentence, the correction id or the record
 *  number (those are one org's project data; they stay in its review item and audit log). */
export function sharedCorrectionCitation(field: string, value: unknown, at: string | undefined): JurisdictionCodeProfile["citations"][number] {
  const day = String(at || "").slice(0, 10);
  const criterion = String(field || "").split(".").pop() || field;
  return {
    label: `AHJ plan-review correction${day ? ` (${day})` : ""}: ${criterion} = ${value === undefined || value === null ? "" : String(value)}`,
    sourceUrl: "",
    kind: "ahj_correction",
    field,
    ...(at ? { at } : {}),
  };
}

/** Rows written before the shared citation was narrowed carried the quote / correction id / record:
 *  every read (and so every later re-save, and GET /api/code-profiles) gets the narrow form. */
function sanitizeCitations(payload: Partial<JurisdictionCodeProfile>): JurisdictionCodeProfile["citations"] {
  const list = Array.isArray(payload.citations) ? payload.citations : [];
  return list.map((c) => {
    if (c?.kind !== "ahj_correction") return c;
    const [block, key] = String(c.field || "").split(".");
    const v = block === "designCriteria" || block === "prescriptive" ? (payload[block] as Record<string, unknown> | undefined)?.[key] : undefined;
    return sharedCorrectionCitation(String(c.field || ""), v, c.at);
  });
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
    citations: sanitizeCitations(payload),
    researchedAt: text(row.researched_at) || undefined,
    verifiedAt: text(row.verified_at) || undefined,
    verifiedBy: text(row.verified_by) || undefined,
    updatedAt: text(row.updated_at),
    ...optionalLayerFields(payload),
  };
}

function optionalLayerFields(payload: unknown): Pick<JurisdictionCodeProfile, "adoptionModel" | "upcoming" | "researchProvenance" | "designCriteriaLookup"> {
  const p = (payload ?? {}) as { adoptionModel?: unknown; upcoming?: unknown; designCriteriaLookup?: unknown };
  const adoptionModel = adoptionModelOf(p.adoptionModel);
  const upcoming = upcomingOf(p.upcoming);
  const researchProvenance = provenanceOf(payload);
  const designCriteriaLookup = designCriteriaLookupOf(p.designCriteriaLookup);
  return {
    ...(adoptionModel ? { adoptionModel } : {}),
    ...(upcoming && upcoming.length ? { upcoming } : {}),
    ...(researchProvenance ? { researchProvenance } : {}),
    ...(designCriteriaLookup ? { designCriteriaLookup } : {}),
  };
}

/** A stored lookup checklist, shape-checked on read (rows are shared data; older rows have none). */
function designCriteriaLookupOf(v: unknown): DesignCriteriaLookupRecord | undefined {
  const r = v as { at?: unknown; items?: unknown } | null | undefined;
  if (!r || typeof r !== "object" || typeof r.at !== "string" || !Array.isArray(r.items)) return undefined;
  const items = (r.items as Array<Record<string, unknown> | null>)
    .filter((i): i is Record<string, unknown> => !!i && (DESIGN_CRITERIA_CHECKLIST as readonly string[]).includes(String(i.item))
      && ["found", "weak_source", "not_found", "not_researched", "site_specific"].includes(String(i.status)))
    .map((i) => ({
      item: i.item as DesignCriteriaChecklistItem,
      status: i.status as DesignCriteriaLookupRecord["items"][number]["status"],
      ...(typeof i.sourceUrl === "string" && i.sourceUrl ? { sourceUrl: i.sourceUrl.slice(0, 500) } : {}),
      ...(typeof i.note === "string" && i.note ? { note: i.note.slice(0, 300) } : {}),
    }));
  return items.length ? { at: r.at, items } : undefined;
}

// --- The state's adoption model --------------------------------------------------------------
//
// WHICH LAYER OWNS A FAMILY'S EDITION is a structural fact about the state (ORS 455.040 makes
// Oregon's building code uniform in every municipality; Texas leaves the IRC to each city). It is
// read from the state row (research / the reference seed), else from the shipped reference data —
// a state whose row is human-verified (Oregon) cannot carry a seeded adoption model on that row,
// and must not lose the fact for it.

let referenceCache: { path: string; data: ReferenceFile | null } | null = null;
interface ReferenceStateAdoption {
  state: string;
  asOf: string;
  adoptionModel: JurisdictionAdoptionModel;
  adoptedCodes: CodeEdition[];
  upcoming?: UpcomingCodeEdition[];
  citations?: JurisdictionCodeProfile["citations"];
}
interface ReferenceFile {
  profiles?: Array<JurisdictionCodeProfile & { confidence?: string }>;
  stateAdoptions?: ReferenceStateAdoption[];
}

// MODULE-RELATIVE, NOT CWD-RELATIVE (e2e-gap close, 2026-09-26). The reference file was resolved
// against process.cwd(); the e2e scorer's scratch server ran from a private cwd, so the file was
// unreadable, every state's adoption model came back undefined, and `inheritAdoptedCodes` fell to
// its "unknown model → the state's" branch: Scottsdale read Arizona's 2024 IFC as its fire code and
// Venus read Texas's 2012 IRC floor as its residential code (P15 ifcSetback, P11 ircIbc). Same
// resolution processProfiles.ts already uses for its own reference file. The env override stays
// exclusive; the cwd form is a last resort for a checkout that moved the file.
const codeProfilesModuleDir = path.dirname(fileURLToPath(import.meta.url));
function referencePath(): string {
  const explicit = (process.env.CODE_PROFILE_REFERENCE_PATH || "").trim();
  if (explicit) return path.resolve(explicit);
  const moduleRelative = path.resolve(codeProfilesModuleDir, "..", "data", "reference-code-profiles.json");
  if (fs.existsSync(moduleRelative)) return moduleRelative;
  return path.resolve(process.cwd(), "backend/data/reference-code-profiles.json");
}

function loadReference(): ReferenceFile | null {
  const p = referencePath();
  if (referenceCache && referenceCache.path === p) return referenceCache.data;
  let data: ReferenceFile | null = null;
  try { data = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as ReferenceFile) : null; } catch { data = null; }
  referenceCache = { path: p, data };
  return data;
}

/** Test seam: forget the cached reference file (a test that swaps CODE_PROFILE_REFERENCE_PATH). */
export function resetReferenceCacheForTests(): void {
  referenceCache = null;
}

function referenceStateAdoption(state: string): ReferenceStateAdoption | undefined {
  const st = String(state || "").trim().toUpperCase();
  return (loadReference()?.stateAdoptions ?? []).find((s) => String(s.state || "").toUpperCase() === st);
}

/** How this state adopts its codes: the state row's own (research / reference seed), else the shipped
 *  reference data. Undefined = not known (every family is then treated as the AHJ's own). */
export function stateAdoptionModel(db: AppDb, state: string): JurisdictionAdoptionModel | undefined {
  const st = String(state || "").trim();
  if (!st) return undefined;
  try {
    const row = db.get<Row>("SELECT payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [codeProfileKey({ state: st, ahj: "" })]);
    if (row) {
      const own = adoptionModelOf((JSON.parse(text(row.payload_json) || "{}") as { adoptionModel?: unknown }).adoptionModel);
      if (own) return own;
    }
  } catch { /* fall through to the reference */ }
  const ref = referenceStateAdoption(st);
  return ref ? adoptionModelOf(ref.adoptionModel) : undefined;
}

/** THE FAMILIES AN AHJ-LAYER CODE RESEARCH ASKS FOR. The state's local-adoption families; and
 *  when there is at least one (so the AHJ is researched anyway, no new call), also the families the
 *  state sets only as a MINIMUM that cities may amend — Texas's NEC is TDLR's floor, and Venus
 *  adopted 2020 (new-AHJ e2e, 2026-09-26): never asked, the city read the state's 2026. A state
 *  whose every family is uniform or minimum (PA, NM, MA) still skips the AHJ layer. */
export function ahjResearchFamilies(model: JurisdictionAdoptionModel | null | undefined): CodeFamily[] {
  const local = locallyAdoptedFamilies(model);
  if (!local.length) return local;
  const amendable = CODE_FAMILIES.filter((f) => familyAdoptionModel(model, f) === "statewide_minimum_local_amend");
  return [...local, ...amendable.filter((f) => !local.includes(f))];
}

/** A code entry an AHJ row holds on its own authority: research, an operator import or edit, the
 *  reference data — not a legacy entry with no origin (model-memory research, or state codes an
 *  older import copied down), which an explicit state edition outranks. */
function attributedEntry(c: CodeEdition): boolean {
  if (c.origin) return true;
  return /^Imported from operator reference list/i.test(String(c.notes || ""));
}

/**
 * PER-FAMILY INHERITANCE. An AHJ row's own entries and its state's entries, merged FAMILY BY FAMILY
 * by the state's adoption model (it used to be the whole list: one AHJ entry dropped every state
 * code). Order: the AHJ's kept entries in its order, then the state's in its order.
 *   statewide_uniform            — the state's edition only; an AHJ entry for it is ignored (a city
 *                                  in Oregon cannot adopt its own ORSC — a stored one is wrong) —
 *                                  UNLESS a person stated it (the AHJ row is human-verified, or the
 *                                  entry's origin is "operator"): hard rule 3, a seeded / reference
 *                                  fact never hides a human's statement. That entry is read, in
 *                                  place of the state's for its family.
 *   statewide_minimum_local_amend— the AHJ's own OPERATOR/IMPORT entry (a person's statement), else
 *                                  the state's. A machine-owned AHJ entry (research, the reference,
 *                                  a memory-era entry with no origin) never displaces the state's
 *                                  edition: the edition is the state's; locals only amend it.
 *   local_adoption               — the AHJ's own only: a state floor is not the city's edition, and
 *                                  showing it would read an unknown as an answer.
 *   unknown model                — the AHJ's own, else the state's.
 * Entries with no decidable family stay with their row (state ones only when the AHJ has none).
 * An AHJ with NO row reads through this too (ownCodes []): a local-adoption family then reads as
 * no data, never as the state's floor.
 */
/** READ-TIME ONLY: which layer an inherited entry is, said on the entry so no consumer can present
 *  a state default as the city's adopted code (e2e-gap close, 2026-09-26 — MF2/MF3). Declared here:
 *  shared/src/types.ts is not this module's to widen. Stripped by every write (upsert, proposals). */
export type CodeEditionLayer = "state_uniform" | "state_minimum" | "state_default";
export type PresentedCodeEdition = CodeEdition & { layer?: CodeEditionLayer; layerLabel?: string };

function stateLayerLabel(layer: CodeEditionLayer, state: string, ahj: string): string {
  const st = state || "the state";
  const who = ahj || "this jurisdiction";
  if (layer === "state_uniform") return `${st} statewide edition (adopted uniformly — ${who} cannot adopt its own)`;
  if (layer === "state_minimum") return `State default (${st} statewide minimum) — ${who}'s own adoption not confirmed`;
  return `State default — ${who} not confirmed`;
}

/** The hosts the state layer itself cites (its statute, its adopting agency). An AHJ entry sourced
 *  from one of them states the STATE's rule, not a local adoption (Venus: the Texas statute's
 *  "IRC as it existed May 1, 2012" stored as the city's residential code). */
function stateLayerHosts(stateCodes: CodeEdition[]): Set<string> {
  return new Set(stateCodes.map((s) => hostOf(s.sourceUrl)).filter(Boolean));
}

export function inheritAdoptedCodes(
  stateCodes: CodeEdition[],
  ownCodes: CodeEdition[],
  model: JurisdictionAdoptionModel | undefined,
  opts: { ownVerified?: boolean; state?: string; ahj?: string } = {},
): PresentedCodeEdition[] {
  const fam = (c: CodeEdition) => codeFamilyOf(c);
  const personStated = (c: CodeEdition) => !!opts.ownVerified || c.origin === "operator";
  const stateHosts = stateLayerHosts(stateCodes);
  // A CITED LOCAL EDITION WINS ITS FAMILY (MF2/MF3 b): beside a cited 2021 IBC, an uncited or
  // state-sourced research entry for the same family is not shown as the city's code.
  const citedFamilies = new Set<CodeFamily>();
  for (const c of ownCodes) { const f = fam(c); if (f && citedLocalAdoption(c, stateCodes)) citedFamilies.add(f); }
  const keptOwnFamilies = new Set<CodeFamily>();
  const out: PresentedCodeEdition[] = [];
  const asState = (s: CodeEdition, layer: CodeEditionLayer): PresentedCodeEdition =>
    ({ ...s, inheritedFrom: "state", layer, ...(opts.ahj ? { layerLabel: stateLayerLabel(layer, opts.state || "", opts.ahj) } : {}) });
  for (const c of ownCodes) {
    const f = fam(c);
    if (!f) { out.push(c); continue; }
    const m = familyAdoptionModel(model, f);
    if (m === "statewide_uniform" && !personStated(c)) continue;
    // A STATE RULE NEVER OVERRIDES A CITED LOCAL RULE. Venus TX (new-AHJ e2e, 2026-09-26): the
    // city's own page says "The City of Venus has Adopted the 2020 NEC", and the code panel showed
    // Texas's 2026 NEC — then told the installer to "update" a plan that was right. A machine-owned
    // entry still yields to the state's edition when it is NOT a cited local adoption (no quote,
    // a quote that does not state the edition, or the state's own source).
    if (m === "statewide_minimum_local_amend" && researchOwnedEntry(c) && !personStated(c) && stateCodes.some((s) => fam(s) === f)
      && !citedLocalAdoption(c, stateCodes)) continue;
    if (researchOwnedEntry(c) && !personStated(c)) {
      // THE STATE'S OWN SOURCE IS THE STATE'S RULE. A machine-owned AHJ entry cited to a state-layer
      // host is the floor / the statute read as the city's code — never the city's edition. In a
      // local-adoption family it is dropped (the floor is not the city's edition; showing it reads an
      // unknown as an answer); elsewhere the state's own entry stands in, labelled as the state's.
      const host = hostOf(c.sourceUrl);
      if (host && stateHosts.has(host)) continue;
      // Beside a cited local edition, an uncited research entry of the same family is not shown.
      if (citedFamilies.has(f) && !citedLocalAdoption(c, stateCodes)) continue;
    }
    out.push(c);
    keptOwnFamilies.add(f);
  }
  for (const s of stateCodes) {
    const f = fam(s);
    if (!f) { if (!ownCodes.length) out.push(asState(s, "state_default")); continue; }
    const m = familyAdoptionModel(model, f);
    if (m === "local_adoption") continue;
    if (keptOwnFamilies.has(f)) continue;
    out.push(asState(s, m === "statewide_uniform" ? "state_uniform" : m === "statewide_minimum_local_amend" ? "state_minimum" : "state_default"));
  }
  return out;
}

const FAMILY_QUOTE_WORDS: Record<CodeFamily, RegExp> = {
  residential: /\bIRC\b|residential/i,
  building: /\bIBC\b|building\s+code/i,
  electrical: /\bNEC\b|electrical\s+code|NFPA\s*70\b/i,
  fire: /\bIFC\b|fire\s+code/i,
  energy: /\bIECC\b|energy/i,
  mechanical: /\bIMC\b|mechanical/i,
  plumbing: /\b[IU]PC\b|plumbing/i,
};

function hostOf(url: string | undefined): string {
  try { return new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/**
 * IS THIS AN AHJ ENTRY A LOCAL PAGE STATES, WITH ITS OWN WORDS? All of:
 *   · machine-owned research / reference evidence (a quote is only stored from a web-grounded
 *     answer, so a model-memory entry can never qualify);
 *   · a source URL and a quote that names BOTH the edition year and the code (by token or name);
 *   · the source is not one the state layer itself cites (the state's statute or TDLR page is the
 *     state's rule, not a local adoption).
 */
export function citedLocalAdoption(c: CodeEdition, stateCodes: CodeEdition[]): boolean {
  if (c.origin !== "research" && c.origin !== "reference") return false;
  const quote = String(c.quote || "");
  const host = hostOf(c.sourceUrl);
  if (!host || !quote.trim()) return false;
  const edition = String(c.edition || "").match(/\d{4}/)?.[0];
  if (!edition || !quote.includes(edition)) return false;
  const f = codeFamilyOf(c);
  const token = normCodeToken(c.code);
  const namesCode = (token && new RegExp(`\\b${token.replace(/[^A-Za-z0-9]/g, "")}\\b`, "i").test(quote)) || (f ? FAMILY_QUOTE_WORDS[f].test(quote) : false);
  if (!namesCode) return false;
  const stateHosts = new Set(stateCodes.map((s) => hostOf(s.sourceUrl)).filter(Boolean));
  return !stateHosts.has(host);
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

/**
 * WHOSE IS THIS PRESCRIPTIVE LIMIT, AND IS IT CONFIRMED? (leak sweep, 2026-09-28: the shipped
 * state-level "PE stamp commonly required over ~10 kW" notes for CA, MA and AZ were stored as hard
 * engineerStampOverKwDc numbers and refused staging in every AHJ of those states, worded
 * "<AHJ> requires".) A limit is CONFIRMED when a person verified the layer that supplied it, or it
 * sits on the AHJ's OWN row and that row cites a public source (the prescriptive sourceUrl, a
 * citation URL, or a field-specific citation such as an applied AHJ correction). A state-layer seeded
 * value, or an AHJ value with no source, is a note.
 */
export function codeLimitProvenance(
  db: AppDb,
  input: { state?: string; ahj?: string },
  field: keyof PrescriptiveLimits,
): { value: PrescriptiveLimits[keyof PrescriptiveLimits] | undefined; confirmed: boolean; layer: "ahj" | "state" | "none"; state: string } {
  const merged = getCodeProfile(db, input);
  const value = merged?.prescriptive?.[field];
  if (!merged || value === undefined) return { value: undefined, confirmed: false, layer: "none", state: text(input.state) };
  const src = merged.fieldSources?.[`prescriptive.${field}`] ?? { ahj: merged.ahj, state: merged.state, confidence: merged.confidence };
  const layer: "ahj" | "state" = text(src.ahj) ? "ahj" : "state";
  if (src.confidence === "verified") return { value, confirmed: true, layer, state: merged.state };
  if (layer !== "ahj") return { value, confirmed: false, layer, state: merged.state };
  // The AHJ's OWN row (ownCodeProfileRow — exact key, then the same fuzzy match), not the merge:
  // merged citations carry the state row's too.
  const own = ownCodeProfileRow(db, text(input.state), text(input.ahj))?.profile ?? null;
  const isUrl = (u: unknown) => /^https?:\/\//i.test(text(u));
  const cited = Boolean(own && (isUrl(own.prescriptive?.sourceUrl)
    || own.citations.some((c) => isUrl(c.sourceUrl) || text(c.field).includes(String(field)))));
  return { value, confirmed: cited, layer, state: merged.state };
}

export function getCodeProfile(db: AppDb, input: { state?: string; ahj?: string }): JurisdictionCodeProfile | null {
  const exactRow = input.ahj
    ? db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [codeProfileKey({ state: input.state, ahj: input.ahj })]) ??
      fuzzyCodeRow(db, input)
    : null;
  const stateRow = db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [codeProfileKey({ state: input.state, ahj: "" })]);
  const exact = exactRow ? mapRow(exactRow) : null;
  const base = stateRow ? mapRow(stateRow) : null;
  // The state's adoption model decides, family by family, whose edition the AHJ reads — also when
  // the state has NO row yet (the reference data still knows Oregon is uniform), and also when the
  // AHJ has NO row: a Texas city nobody has researched must not read Texas's IRC 2012 floor as its
  // own edition (it reads "no adopted-code data" for its local families, exactly as it would with
  // a stamp-only row). Only the state-level read (no AHJ asked) returns the state row whole.
  const model = base?.adoptionModel ?? stateAdoptionModel(db, exact?.state || text(input.state));
  const layerOpts = { state: (exact?.state || base?.state || text(input.state)).toUpperCase(), ahj: String(input.ahj || "").trim() };
  if (!exact) {
    if (!base || !String(input.ahj || "").trim()) return base;
    return { ...base, ...(model ? { adoptionModel: model } : {}), adoptedCodes: inheritAdoptedCodes(base.adoptedCodes, [], model, layerOpts) };
  }
  const ownVerified = exact.confidence === "verified";
  if (!base) {
    // The reference's state layer still says whose source is the state's, even before a state row exists.
    const refCodes = referenceStateAdoption(exact.state)?.adoptedCodes ?? [];
    const own = inheritAdoptedCodes(refCodes, exact.adoptedCodes, model, { ownVerified, ...layerOpts }).filter((c) => !c.inheritedFrom);
    return own.length === exact.adoptedCodes.length ? exact : { ...exact, adoptedCodes: own };
  }
  // Which layer supplied each criteria / limit field (the merged confidence below is the weaker of
  // the two, so a verified state value under a seeded city row would otherwise read as seeded).
  const fieldSources: NonNullable<JurisdictionCodeProfile["fieldSources"]> = {};
  const sourceOf = (p: JurisdictionCodeProfile) => ({
    ahj: p.ahj, state: p.state, confidence: p.confidence,
    ...(p.verifiedBy ? { verifiedBy: p.verifiedBy } : {}), ...(p.verifiedAt ? { verifiedAt: p.verifiedAt } : {}),
  });
  for (const block of ["designCriteria", "prescriptive"] as const) {
    for (const layer of [base, exact]) {
      for (const [field, value] of Object.entries(layer[block] ?? {})) {
        if (value !== undefined) fieldSources[`${block}.${field}`] = sourceOf(layer);
      }
    }
  }
  return {
    ...exact,
    fieldSources,
    confidence: exact.confidence === "verified" && base.confidence === "verified" ? "verified" : "seeded",
    adoptedCodes: inheritAdoptedCodes(base.adoptedCodes, exact.adoptedCodes, model, { ownVerified, ...layerOpts }),
    // State-level facts: the state row's (the AHJ row never carries them).
    ...(model ? { adoptionModel: model } : {}),
    ...(base.upcoming?.length ? { upcoming: base.upcoming } : {}),
    amendments: [...base.amendments, ...exact.amendments],
    designCriteria: { ...base.designCriteria, ...exact.designCriteria },
    prescriptive: { ...base.prescriptive, ...exact.prescriptive },
    fireSetbacks: exact.fireSetbacks.length ? exact.fireSetbacks : base.fireSetbacks,
    citations: [...base.citations, ...exact.citations],
  };
}

export function listCodeProfiles(db: AppDb): JurisdictionCodeProfile[] {
  let proposals = new Map<string, JurisdictionEditionProposal[]>();
  try {
    for (const p of listEditionProposals(db)) proposals.set(p.profileKey, [...(proposals.get(p.profileKey) ?? []), p]);
  } catch { proposals = new Map(); }
  return db.query<Row>("SELECT * FROM jurisdiction_code_profiles ORDER BY state, ahj").map((row) => {
    const mapped = mapRow(row);
    const pending = proposals.get(mapped.key);
    const profile = pending?.length ? { ...mapped, editionProposals: pending } : mapped;
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
  let priorPayload: Record<string, unknown> = {};
  if (existing) {
    try { priorPayload = JSON.parse(text(existing.payload_json) || "{}") as Record<string, unknown>; } catch { priorPayload = {}; }
  }
  if (existing && opts.confidence === "seeded") priorProvenance = provenanceOf(priorPayload);
  const researchProvenance = provenanceOf(profile) ?? priorProvenance;
  // State-level facts are kept across a re-save that does not carry them (an operator verify
  // through the PUT route edits codes/criteria and says nothing about the adoption model).
  const adoptionModel = adoptionModelOf(profile.adoptionModel) ?? adoptionModelOf(priorPayload.adoptionModel);
  const upcoming = upcomingOf(profile.upcoming) ?? upcomingOf(priorPayload.upcoming);
  // The last lookup's checklist rides every re-save that does not carry its own.
  const designCriteriaLookup = designCriteriaLookupOf(profile.designCriteriaLookup) ?? designCriteriaLookupOf(priorPayload.designCriteriaLookup);
  const payload = JSON.stringify({
    // Read-time presentation (inheritedFrom, layer, layerLabel) never lands in a row: a verify
    // through the PUT route sends the read back, and "not confirmed" must not be stored as a fact.
    adoptedCodes: (profile.adoptedCodes ?? []).map(({ inheritedFrom: _read, layer: _l, layerLabel: _ll, ...c }: PresentedCodeEdition) => c),
    amendments: profile.amendments ?? [],
    designCriteria: profile.designCriteria ?? {},
    prescriptive: profile.prescriptive ?? {},
    fireSetbacks: profile.fireSetbacks ?? [],
    citations: profile.citations ?? [],
    ...(adoptionModel ? { adoptionModel } : {}),
    ...(upcoming && upcoming.length ? { upcoming } : {}),
    ...(designCriteriaLookup ? { designCriteriaLookup } : {}),
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

/**
 * Persist an LLM-researched (or bulk-imported) profile. NEVER downgrades a human-verified row back
 * to seeded — research onto a verified row is recorded as an edition PROPOSAL for a person instead
 * (never written).
 *
 * A RESEARCH save (the profile carries researchProvenance — the researcher and the reference seed
 * attach it) is gated and MERGED:
 *   · not web-grounded -> nothing is stored. Model memory is not an edition: stored, the review
 *     would cite it, and the row would read "researched" and block the grounded attempt behind it.
 *   · onto an existing row -> mergeResearchIntoRow: research-owned codes are replaced family by
 *     family, operator imports / corrections / stamp notes / amendments / citations are kept, and
 *     design criteria and prescriptive limits fill BLANKS only.
 *   · an AHJ-level save drops editions for families its state adopts uniformly (the AHJ reads the
 *     state's; a local "edition" there is a conflict, not a finding).
 * An IMPORT save (no researchProvenance: the operator spreadsheets, which pre-merge the row
 * themselves) replaces the payload as before, keeping AHJ-correction and lookup-cited values.
 */
export function saveResearchedCodeProfile(
  db: AppDb,
  profile: JurisdictionCodeProfile,
  /** AHJ research: the families it was ASKED for (the job payload). Absent -> the state's
   *  local-adoption families when its model is known. Editions outside the scope are dropped. */
  opts: { families?: CodeFamily[] } = {},
): JurisdictionCodeProfile {
  const incomingProvenance = provenanceOf(profile);
  const isResearch = !!incomingProvenance;
  if (incomingProvenance && !incomingProvenance.webGrounded) {
    logger.info("code-profiles", `research not saved — ${profile.state}/${profile.ahj || "(state default)"} was not web-grounded (model memory is never stored as an edition)`);
    return getCodeProfile(db, profile) ?? { ...profile, adoptedCodes: [], amendments: [], citations: [] };
  }
  if (String(profile.ahj || "").trim()) {
    const target = resolveCriteriaWriteRow(db, profile.state, profile.ahj);
    // Never CREATE a row that would shadow the human-verified row this AHJ's reads resolve to by
    // name (research or an import for "City of Portland" creating or|city of portland over the
    // verified or|portland).
    if (target?.kind === "blocked_verified" && target.key !== codeProfileKey(profile)) {
      logger.info("code-profiles", `research/import not saved — ${profile.state}/${profile.ahj} reads the human-verified ${target.key}`);
      return getCodeProfile(db, profile)!;
    }
    // A research save lands on the same jurisdiction's row under its own label ("Coos Bay" for
    // "City of Coos Bay") instead of forking it; imports resolve their row themselves.
    if (isResearch && target?.kind === "same_jurisdiction") profile = { ...profile, state: target.profile.state, ahj: target.profile.ahj };
  }
  const key = codeProfileKey(profile);
  const existing = db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
  // ONE RESEARCH DOES NOT FLIP HOW A WHOLE STATE ADOPTS ITS CODES. A state research whose adoption
  // model disagrees (for any family) with the model already known for the state — the row's own,
  // else the shipped source-verified reference — keeps the known model and records a proposal a
  // person resolves (GET /api/code-profiles shows it on the state row). A state with no known model
  // takes the research's; one that agrees stores it. The reference seed is not a research here.
  const incomingModel = adoptionModelOf(profile.adoptionModel);
  if (isResearch && incomingModel && !String(profile.ahj || "").trim() && incomingProvenance?.method !== "reference_truth") {
    const known = stateAdoptionModel(db, profile.state);
    const conflicts = adoptionModelConflicts(known, incomingModel);
    if (known && conflicts.length) {
      proposeAdoptionModelChange(db, { key, state: profile.state, ahj: "" }, incomingModel, conflicts, "research");
      profile = { ...profile, adoptionModel: known };
    }
  }
  if (existing && text(existing.confidence) === "verified") {
    if (isResearch && profile.adoptedCodes?.length) {
      const proposal = proposeEditionUpdate(db, mapRow(existing), profile, incomingProvenance?.method === "reference_truth" ? "reference" : "research");
      logger.info("code-profiles", `research not saved — ${profile.state}/${profile.ahj || "(state default)"} is human-verified${proposal ? `; ${proposal.changes.length} edition change(s) proposed for a person` : " and agrees with it"}`);
    } else {
      logger.info("code-profiles", `research skipped — ${profile.state}/${profile.ahj || "(state default)"} is human-verified`);
    }
    return getCodeProfile(db, profile)!;
  }
  if (!isResearch) {
    return upsert(db, existing ? keepCorrectionCitedValues(mapRow({ ...existing, profile_key: key }), profile) : profile, { confidence: "seeded" });
  }
  const incoming = scopeResearchToLayer(db, profile, opts.families);
  return upsert(db, existing ? mergeResearchIntoRow(mapRow(existing), incoming) : incoming, { confidence: "seeded" });
}

/** Research codes are machine-owned: every entry is marked (a research result can never carry an
 *  "operator" origin — that is a person's statement, and reads outrank the state with it). An
 *  AHJ-level result keeps only the families it was ASKED for — the job's families, else the state's
 *  local-adoption families when its model is known — never a uniform family, and no state-level
 *  facts. An entry whose family cannot be decided is kept (it claims no family's edition). */
function scopeResearchToLayer(db: AppDb, profile: JurisdictionCodeProfile, askedFamilies?: CodeFamily[]): JurisdictionCodeProfile {
  const origin: CodeEdition["origin"] = provenanceOf(profile)?.method === "reference_truth" ? "reference" : "research";
  let adoptedCodes: CodeEdition[] = (profile.adoptedCodes ?? []).map((c) => ({ ...c, origin, ...(c.family || !codeFamilyOf(c) ? {} : { family: codeFamilyOf(c) }) }));
  if (!String(profile.ahj || "").trim()) return { ...profile, adoptedCodes };
  const model = stateAdoptionModel(db, profile.state);
  const scope = askedFamilies?.length ? askedFamilies : model ? ahjResearchFamilies(model) : undefined;
  // THE STATE'S OWN SOURCE IS NOT A LOCAL ADOPTION (MF2/MF3 b). An AHJ research that read the state
  // statute / the state agency's page and returned the state's floor as the city's edition (Venus:
  // the Texas statute's "IRC as it existed May 1, 2012") is the state layer restated — never stored
  // on the city's row, where it would sit beside the city's cited 2021 IBC as its residential code.
  let stateHosts = new Set<string>();
  try {
    const stateRow = db.get<Row>("SELECT payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [codeProfileKey({ state: profile.state, ahj: "" })]);
    const stateCodes = stateRow ? mapRow({ ...stateRow, profile_key: "" }).adoptedCodes : [];
    stateHosts = stateLayerHosts([...stateCodes, ...(referenceStateAdoption(profile.state)?.adoptedCodes ?? [])]);
  } catch { stateHosts = new Set<string>(); }
  const uniform: string[] = [];
  const unasked: string[] = [];
  const stateSourced: string[] = [];
  adoptedCodes = adoptedCodes.filter((c) => {
    const f = codeFamilyOf(c);
    if (!f) return true;
    if (familyAdoptionModel(model, f) === "statewide_uniform") { uniform.push(editionLabel(c)); return false; }
    if (scope && !scope.includes(f)) { unasked.push(editionLabel(c)); return false; }
    const host = hostOf(c.sourceUrl);
    if (host && stateHosts.has(host)) { stateSourced.push(`${editionLabel(c)} (${host})`); return false; }
    return true;
  });
  if (uniform.length) logger.info("code-profiles", `${profile.state}/${profile.ahj}: dropped ${uniform.join(", ")} — the state adopts ${uniform.length === 1 ? "that family" : "those families"} uniformly; the AHJ reads the state's edition`);
  if (unasked.length) logger.info("code-profiles", `${profile.state}/${profile.ahj}: dropped ${unasked.join(", ")} — outside the families this research was asked for (${scope!.join(", ") || "none"}); the AHJ reads the state's edition there`);
  if (stateSourced.length) logger.info("code-profiles", `${profile.state}/${profile.ahj}: dropped ${stateSourced.join(", ")} — cited to the STATE layer's own source, so it states the state's rule, not a local adoption`);
  const { adoptionModel: _a, upcoming: _u, ...rest } = profile;
  return { ...rest, adoptedCodes };
}

/** Is this stored code entry machine-owned (a later grounded research may replace it)? Research,
 *  the reference seed, and legacy entries with no origin (memory-era research). Operator imports
 *  and edits are not. */
function researchOwnedEntry(c: CodeEdition): boolean {
  if (c.origin) return c.origin === "research" || c.origin === "reference";
  return !attributedEntry(c);
}

/**
 * MERGE, NOT REPLACE. What a grounded research adds to an existing seeded row:
 *   adoptedCodes    — for each family the research found, the row's machine-owned entries of that
 *                     family are replaced; operator-imported entries are kept and win their family.
 *   designCriteria, prescriptive — BLANK fields only (an AHJ correction, the lookup, an operator
 *                     import put the others there).
 *   amendments, fireSetbacks, citations — the row's kept; research amendments/citations appended
 *                     (deduped); research fireSetbacks only when the row has none.
 *   adoptionModel, upcoming, researchProvenance — research-owned: the research's.
 */
export function mergeResearchIntoRow(existing: JurisdictionCodeProfile, incoming: JurisdictionCodeProfile): JurisdictionCodeProfile {
  const fam = (c: CodeEdition) => codeFamilyOf(c);
  const incomingFamilies = new Set(incoming.adoptedCodes.map(fam).filter((f): f is CodeFamily => !!f));
  const keptImports = existing.adoptedCodes.filter((c) => !researchOwnedEntry(c));
  const importFamilies = new Set(keptImports.map(fam).filter((f): f is CodeFamily => !!f));
  // A state layer that says a family is LOCAL (no state edition — Arizona's residential code) also
  // retires a machine-owned state entry for it: the memory-era "IRC 2018" on Arizona's row said the
  // state adopts one, which is exactly what the research found it does not.
  const localAtState = (f: CodeFamily) => !incoming.ahj && familyAdoptionModel(incoming.adoptionModel, f) === "local_adoption";
  const keptResearch = existing.adoptedCodes.filter((c) => researchOwnedEntry(c) && (() => {
    const f = fam(c);
    return f ? !incomingFamilies.has(f) && !localAtState(f) : !incoming.adoptedCodes.some((n) => normCodeToken(n.code) === normCodeToken(c.code));
  })());
  const added = incoming.adoptedCodes.filter((c) => {
    const f = fam(c);
    return !(f && importFamilies.has(f));
  });
  const fillBlanks = <T extends object>(have: T, add: T): T => {
    const out: Record<string, unknown> = { ...(have as Record<string, unknown>) };
    for (const [k, v] of Object.entries(add as Record<string, unknown>)) {
      const cur = out[k];
      if ((cur === undefined || cur === null || cur === "") && v !== undefined && v !== null && v !== "") out[k] = v;
    }
    return out as T;
  };
  const amendKey = (a: { code: string; section?: string; summary: string }) => `${a.code}|${a.section ?? ""}|${a.summary}`.toLowerCase();
  const haveAmend = new Set(existing.amendments.map(amendKey));
  const citeKey = (c: JurisdictionCodeProfile["citations"][number]) => `${c.kind ?? ""}|${c.field ?? ""}|${c.label}|${c.sourceUrl}`.toLowerCase();
  const haveCite = new Set(existing.citations.map(citeKey));
  return {
    ...existing,
    adoptedCodes: [...keptImports, ...keptResearch, ...added],
    amendments: [...existing.amendments, ...(incoming.amendments ?? []).filter((a) => !haveAmend.has(amendKey(a)))],
    designCriteria: fillBlanks(existing.designCriteria ?? {}, incoming.designCriteria ?? {}),
    prescriptive: fillBlanks(existing.prescriptive ?? {}, incoming.prescriptive ?? {}),
    fireSetbacks: existing.fireSetbacks.length ? existing.fireSetbacks : incoming.fireSetbacks ?? [],
    citations: [...existing.citations, ...(incoming.citations ?? []).filter((c) => !haveCite.has(citeKey(c)))],
    ...(incoming.adoptionModel ? { adoptionModel: incoming.adoptionModel } : {}),
    ...(incoming.upcoming ? { upcoming: incoming.upcoming } : {}),
    ...(incoming.researchProvenance ? { researchProvenance: incoming.researchProvenance } : {}),
  };
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
  const ctx = buildCodeContext(state, ahj, profile, approvedDesigns);
  // The gate words "criteria not on file" from where the lookup stands (queued, running, ran and
  // found nothing). A READ of job_queue — this runs on page-load read paths that write nothing.
  let designLookup: DesignCriteriaLookupProgress | undefined;
  try { designLookup = readDesignLookupProgress(db, state, ahj); } catch { designLookup = undefined; }
  return designLookup ? { ...ctx, designLookup } : ctx;
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
      // The entry filed under the asked code, else — for a model code — the state code BUILT ON it
      // (Oregon's fire code is the OFC, built on the IFC: an "IFC" citation there is the OFC's).
      // Never the IRC: a state residential code may renumber, and residentialCodeRef owns that map.
      const asked = normCodeToken(code);
      const edition = adopted.find((e) => e.code.toUpperCase() === code.toUpperCase())
        ?? (asked !== "IRC" ? adopted.find((e) => normCodeToken(e.code) !== asked && modelBaseOf(e) === asked) : undefined);
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
      const basis = edition.basedOn ? `, built on the ${edition.basedOn}` : "";
      // An inherited entry says WHICH layer it is (state_uniform = the city's code by law;
      // state_minimum / state_default = a state default the city has not confirmed).
      const presented = edition as PresentedCodeEdition;
      const inherited = edition.inheritedFrom === "state" && ahj
        ? (presented.layerLabel ? ` — ${presented.layerLabel}` : ` — ${state}'s statewide edition`)
        : "";
      if (!isModelDefault && (basis || inherited)) {
        return {
          code: `${edition.edition} ${edition.code}`.trim(),
          section,
          title,
          adoptionScope: verified
            ? `${ahj || state}: adopted ${edition.code} ${edition.edition}${basis}${inherited}.`
            : `${ahj || state}: ${edition.code} ${edition.edition}${basis}${inherited} (seeded — verify locally before citing as authoritative).`,
          sourceUrl: safeUrl(edition.sourceUrl) || safeUrl(fallback?.sourceUrl) || "",
          note: edition.notes || fallback?.note || "",
        };
      }
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
    const filePath = referencePath();
    if (!fs.existsSync(filePath)) return;
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as ReferenceFile;
    referenceCache = { path: filePath, data };
    let seeded = 0;
    for (const p of data.profiles ?? []) {
      const key = codeProfileKey(p);
      const existing = db.get<Row>("SELECT confidence FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
      if (existing) continue; // never clobber operator edits (verified OR re-seeded)
      upsert(db, p, { confidence: p.confidence === "verified" ? "verified" : "seeded", verifiedBy: p.confidence === "verified" ? "reference-seed" : undefined });
      seeded++;
    }
    if (seeded > 0) logger.info("code-profiles", `seeded ${seeded} jurisdiction code profile(s) from reference data`);
    const layers = seedReferenceStateAdoptions(db, data.stateAdoptions ?? []);
    if (layers.created || layers.merged || layers.proposed) {
      logger.info("code-profiles", `reference state layers: ${layers.created} created, ${layers.merged} merged onto seeded rows, ${layers.proposed} proposal(s) for human-verified rows`);
    }
  } catch (err) {
    logger.warn("code-profiles", `reference seed failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The state layer a reference entry describes, as a research-shaped profile (provenance
 *  "reference_truth": every value was confirmed on the cited official page as of `asOf`). */
export function referenceStateProfile(sa: ReferenceStateAdoption): JurisdictionCodeProfile {
  const asOf = String(sa.asOf || "").slice(0, 10);
  return {
    key: "", state: String(sa.state || "").toUpperCase(), ahj: "", confidence: "seeded",
    adoptedCodes: (sa.adoptedCodes ?? []).map((c) => ({ ...c, origin: "reference" as const })),
    amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [],
    citations: sa.citations ?? [],
    updatedAt: "",
    adoptionModel: sa.adoptionModel,
    ...(sa.upcoming?.length ? { upcoming: sa.upcoming } : {}),
    researchProvenance: { webGrounded: true, method: "reference_truth", at: asOf, notes: `Shipped reference data: each edition confirmed on the cited official page as of ${asOf}.` },
  };
}

/**
 * THE SHIPPED STATE LAYERS (reference-code-profiles.json "stateAdoptions", generated from the
 * source-verified truth files). Runs on every open; idempotent:
 *   no state row            -> created, seeded;
 *   a seeded row            -> merged through the research merge (machine-owned codes replaced per
 *                              family, everything else kept) — unless the row already carries this
 *                              reference or a grounded research newer than it;
 *   a human-verified row    -> NEVER written (hard rule 3): a disagreement becomes an edition
 *                              proposal a person resolves by re-verifying.
 */
export function seedReferenceStateAdoptions(db: AppDb, adoptions: ReferenceStateAdoption[]): { created: number; merged: number; proposed: number; skipped: number } {
  const out = { created: 0, merged: 0, proposed: 0, skipped: 0 };
  for (const sa of adoptions) {
    try {
      if (!sa?.state || !sa.adoptionModel) { out.skipped++; continue; }
      const profile = referenceStateProfile(sa);
      const key = codeProfileKey(profile);
      const row = db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
      if (!row) { upsert(db, profile, { confidence: "seeded" }); out.created++; continue; }
      const existing = mapRow(row);
      if (existing.confidence === "verified") {
        if (proposeEditionUpdate(db, existing, profile, "reference")?.isNew) out.proposed++;
        else out.skipped++;
        continue;
      }
      const prov = existing.researchProvenance;
      const asOf = profile.researchProvenance!.at!;
      const rowAt = String(prov?.at || "").slice(0, 10);
      if (prov?.webGrounded && rowAt && rowAt >= asOf) { out.skipped++; continue; }
      // A model the row already carries (a person approved it, or an earlier reference said it) is
      // not silently replaced either: a disagreement becomes a proposal.
      const modelConflicts = adoptionModelConflicts(existing.adoptionModel, profile.adoptionModel);
      if (existing.adoptionModel && modelConflicts.length) {
        if (proposeAdoptionModelChange(db, { key, state: existing.state, ahj: "" }, profile.adoptionModel!, modelConflicts, "reference")?.isNew) out.proposed++;
        upsert(db, mergeResearchIntoRow(existing, { ...profile, adoptionModel: existing.adoptionModel }), { confidence: "seeded" });
        out.merged++;
        continue;
      }
      upsert(db, mergeResearchIntoRow(existing, profile), { confidence: "seeded" });
      out.merged++;
    } catch (err) {
      logger.warn("code-profiles", `reference state layer ${sa?.state} not seeded: ${err instanceof Error ? err.message : String(err)}`);
      out.skipped++;
    }
  }
  return out;
}

// --- Newer editions for a HUMAN-VERIFIED row: a proposal, never a write ---------------------------
//
// Hard rule 3: research and the reference seed never write a verified row. When either finds that
// row stale (Oregon's verified IFC 2021 while the 2025 OFC is in effect; no OSSC at all), the
// finding is recorded as a JurisdictionEditionProposal in the audit log (append-only, no project;
// one per distinct finding) and surfaced on GET /api/code-profiles (listCodeProfiles). A person
// resolves it by re-verifying the row — applyEditionProposal is that re-verification.

const PROPOSAL_ACTION = "code_profile.edition_proposal";
const PROPOSAL_DISMISSED = "code_profile.edition_proposal_dismissed";

function entryAgrees(have: CodeEdition, want: CodeEdition): boolean {
  if (normCodeToken(have.code) === normCodeToken(want.code) && String(have.edition).trim() === String(want.edition).trim()) return true;
  // A verified "IRC 2021" beside "ORSC 2023 (2021 IRC)": the same statement about the basis.
  const basis = String(want.basedOn || "");
  const model = modelBaseOf(want);
  return !!model && normCodeToken(have.code) === model && new RegExp(`\\b${String(have.edition).trim()}\\b`).test(basis);
}

/** Per family: the edition the proposal carries that the verified row does not state. */
export function editionChanges(current: CodeEdition[], proposed: CodeEdition[], asOf = nowIso()): JurisdictionEditionProposal["changes"] {
  const changes: JurisdictionEditionProposal["changes"] = [];
  for (const family of CODE_FAMILIES) {
    const inEffect = editionsInEffect(proposed, family, asOf);
    const want = proposed.find((p) => codeFamilyOf(p) === family && inEffect.allowed.some((a) => a.role === "current" && a.edition === p.edition && a.code === p.code))
      ?? proposed.find((p) => codeFamilyOf(p) === family);
    if (!want) continue;
    const have = current.filter((c) => codeFamilyOf(c) === family);
    if (have.some((h) => entryAgrees(h, want))) continue;
    changes.push({
      family,
      current: have.length ? have.map((h) => `${h.code} ${h.edition}`).join(", ") : null,
      proposed: editionLabel(want),
      ...(want.sourceUrl ? { sourceUrl: want.sourceUrl } : {}),
      ...(want.quote ? { quote: String(want.quote).slice(0, 300) } : {}),
    });
  }
  return changes;
}

function fingerprintOf(key: string, changes: JurisdictionEditionProposal["changes"]): string {
  const s = `${key}|${changes.map((c) => `${c.family}:${c.proposed}`).sort().join(";")}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${key}#${(h >>> 0).toString(16)}`;
}

/** Record (once) that a verified row disagrees with grounded research / the reference data.
 *  Returns the proposal, or null when the row already states every proposed edition. */
export function proposeEditionUpdate(db: AppDb, verifiedRow: JurisdictionCodeProfile, found: JurisdictionCodeProfile, source: "reference" | "research"): (JurisdictionEditionProposal & { isNew: boolean }) | null {
  const changes = editionChanges(verifiedRow.adoptedCodes, found.adoptedCodes ?? []);
  if (!changes.length) return null;
  const key = verifiedRow.key || codeProfileKey(verifiedRow);
  const fingerprint = fingerprintOf(key, changes);
  const proposal: JurisdictionEditionProposal = {
    profileKey: key, state: verifiedRow.state, ahj: verifiedRow.ahj, fingerprint, source, createdAt: nowIso(), changes,
    proposedCodes: (found.adoptedCodes ?? []).map(({ inheritedFrom: _r, layer: _l, layerLabel: _ll, ...c }: PresentedCodeEdition) => c),
    ...(found.adoptionModel ? { adoptionModel: found.adoptionModel } : {}),
    ...(found.upcoming?.length ? { upcoming: found.upcoming } : {}),
  };
  const seen = db.get<Row>("SELECT id FROM audit_logs WHERE action = ? AND details LIKE ? ESCAPE '\\' LIMIT 1", [PROPOSAL_ACTION, `%"fingerprint":"${likeLiteral(fingerprint)}"%`]);
  if (seen) return { ...proposal, isNew: false };
  addAuditLog(db, null, "system", source === "reference" ? "reference code data" : "code research", PROPOSAL_ACTION, proposal as unknown as Record<string, unknown>);
  logger.warn("code-profiles", `human-verified ${key} looks stale: ${changes.map((c) => `${c.family} ${c.current ?? "(none)"} -> ${c.proposed}`).join("; ")} — proposal ${fingerprint} awaits a person`);
  return { ...proposal, isNew: true };
}

/** Per family: where two adoption models BOTH say something and say different things. A family
 *  only one of them decides is not a conflict. */
export function adoptionModelConflicts(known: JurisdictionAdoptionModel | undefined, incoming: JurisdictionAdoptionModel | undefined): JurisdictionEditionProposal["changes"] {
  const out: JurisdictionEditionProposal["changes"] = [];
  if (!known || !incoming) return out;
  for (const family of CODE_FAMILIES) {
    const a = familyAdoptionModel(known, family);
    const b = familyAdoptionModel(incoming, family);
    if (a && b && a !== b) {
      out.push({ family, current: a, proposed: b, ...(incoming.sourceUrl ? { sourceUrl: incoming.sourceUrl } : {}), ...(incoming.quote ? { quote: String(incoming.quote).slice(0, 300) } : {}) });
    }
  }
  return out;
}

/** Record (once per distinct finding) that a grounded research disagrees with the state's known
 *  adoption model. The row keeps its model; a person decides (applyEditionProposal / dismiss). */
export function proposeAdoptionModelChange(
  db: AppDb,
  row: { key: string; state: string; ahj: string },
  proposedModel: JurisdictionAdoptionModel,
  changes: JurisdictionEditionProposal["changes"],
  source: "reference" | "research",
): (JurisdictionEditionProposal & { isNew: boolean }) | null {
  if (!changes.length) return null;
  const fingerprint = fingerprintOf(row.key, changes.map((c) => ({ ...c, proposed: `adoption-model:${c.proposed}` })));
  const proposal: JurisdictionEditionProposal = {
    profileKey: row.key, state: row.state, ahj: row.ahj, kind: "adoption_model", fingerprint, source, createdAt: nowIso(), changes,
    proposedCodes: [], adoptionModel: proposedModel,
  };
  const seen = db.get<Row>("SELECT id FROM audit_logs WHERE action = ? AND details LIKE ? ESCAPE '\\' LIMIT 1", [PROPOSAL_ACTION, `%"fingerprint":"${likeLiteral(fingerprint)}"%`]);
  if (seen) return { ...proposal, isNew: false };
  addAuditLog(db, null, "system", source === "reference" ? "reference code data" : "code research", PROPOSAL_ACTION, proposal as unknown as Record<string, unknown>);
  logger.warn("code-profiles", `${row.key}: research says ${changes.map((c) => `${c.family} ${c.proposed}`).join(", ")} — the state's known model says ${changes.map((c) => `${c.family} ${c.current}`).join(", ")}; the known model is kept and proposal ${fingerprint} awaits a person`);
  return { ...proposal, isNew: true };
}

/** A value matched LITERALLY inside a LIKE pattern (with ESCAPE '\'): "%" and "_" are wildcards. */
function likeLiteral(value: string): string {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Proposals still awaiting a person: the newest per row and kind, not dismissed, and still true —
 *    editions:       the row still verified and still not stating them;
 *    adoption_model: the row still there and the state's known model still disagreeing (a seeded
 *                    state row counts: that is where a research's disagreement lands). */
export function listEditionProposals(db: AppDb, profileKey?: string): JurisdictionEditionProposal[] {
  const rows = db.query<Row>(
    `SELECT details, created_at FROM audit_logs WHERE action = ? ${profileKey ? "AND details LIKE ? ESCAPE '\\'" : ""} ORDER BY created_at DESC LIMIT 500`,
    profileKey ? [PROPOSAL_ACTION, `%"profileKey":"${likeLiteral(profileKey)}"%`] : [PROPOSAL_ACTION],
  );
  const dismissed = new Set(db.query<Row>("SELECT details FROM audit_logs WHERE action = ?", [PROPOSAL_DISMISSED]).map((r) => {
    try { return String((JSON.parse(text(r.details)) as { fingerprint?: string }).fingerprint || ""); } catch { return ""; }
  }));
  const newest = new Map<string, JurisdictionEditionProposal>();
  for (const r of rows) {
    let p: JurisdictionEditionProposal;
    try { p = JSON.parse(text(r.details)) as JurisdictionEditionProposal; } catch { continue; }
    if (!p?.profileKey || (profileKey && p.profileKey !== profileKey)) continue;
    const slot = `${p.profileKey}|${p.kind ?? "editions"}`;
    if (newest.has(slot)) continue;
    newest.set(slot, p);
  }
  const out: JurisdictionEditionProposal[] = [];
  for (const p of newest.values()) {
    if (dismissed.has(p.fingerprint)) continue;
    const row = db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [p.profileKey]);
    if (!row) continue;
    if (p.kind === "adoption_model") {
      const current = mapRow(row);
      if (!adoptionModelConflicts(stateAdoptionModel(db, current.state), p.adoptionModel).length) continue; // resolved since
      out.push(p);
      continue;
    }
    if (text(row.confidence) !== "verified") continue;
    if (!editionChanges(mapRow(row).adoptedCodes, p.proposedCodes).length) continue; // re-verified since
    out.push(p);
  }
  return out;
}

/** A PERSON approved the proposal: re-verify the row with the proposed editions. Codes of the
 *  families the proposal covers are replaced; the row's other codes, amendments, design criteria,
 *  prescriptive limits, setbacks and citations are kept; the proposal's sources are cited. */
export function applyEditionProposal(db: AppDb, fingerprint: string, actor: string): { status: "applied" | "refused"; note: string; profile?: JurisdictionCodeProfile } {
  const p = listEditionProposals(db).find((x) => x.fingerprint === fingerprint);
  if (!p) return { status: "refused", note: "No pending proposal with that id (applied, dismissed, superseded, or the row is no longer verified)." };
  const row = db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [p.profileKey]);
  if (!row) return { status: "refused", note: "The profile row no longer exists." };
  const current = mapRow(row);
  if (p.kind === "adoption_model") {
    // A person accepted the research's adoption model. Only the model changes: the row's codes and
    // its confidence are untouched (approving a model is not a verification of the editions).
    if (!p.adoptionModel) return { status: "refused", note: "The proposal carries no adoption model." };
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(text(row.payload_json) || "{}") as Record<string, unknown>; } catch { payload = {}; }
    payload.adoptionModel = { ...p.adoptionModel, note: `${p.adoptionModel.note ? `${p.adoptionModel.note} ` : ""}Approved by ${actor || "operator"} ${nowIso().slice(0, 10)}.`.slice(0, 600) };
    db.run("UPDATE jurisdiction_code_profiles SET payload_json = ?, updated_at = ? WHERE profile_key = ?", [JSON.stringify(payload), nowIso(), p.profileKey]);
    addAuditLog(db, null, "human", actor || "operator", "code_profile.edition_proposal_applied", { fingerprint, profileKey: p.profileKey, kind: p.kind, changes: p.changes });
    return { status: "applied", note: `Adoption model of ${p.profileKey} set by ${actor || "operator"} (${p.changes.map((c) => `${c.family}: ${c.proposed}`).join(", ")}).`, profile: getCodeProfile(db, current) ?? current };
  }
  // Only the families the proposal CHANGES: a family the row already states correctly keeps the
  // person's own entries (Oregon's verified "IRC 2021" beside "ORSC 2023" is not touched).
  const families = new Set(p.changes.map((c) => c.family));
  const adding = p.proposedCodes.filter((c) => { const f = codeFamilyOf(c); return !!f && families.has(f); });
  const keep = current.adoptedCodes.filter((c) => { const f = codeFamilyOf(c); return !f || !families.has(f); });
  const cites = [...current.citations];
  for (const c of adding) {
    if (c.sourceUrl && !cites.some((x) => x.sourceUrl === c.sourceUrl)) cites.push({ label: `${editionLabel(c)} — adopted edition source`, sourceUrl: c.sourceUrl, ...(c.quote ? { quote: String(c.quote).slice(0, 240) } : {}) });
  }
  const saved = saveVerifiedCodeProfile(db, {
    ...current,
    adoptedCodes: [...keep, ...adding.map((c) => ({ ...c, origin: "operator" as const }))],
    citations: cites,
    ...(p.adoptionModel ? { adoptionModel: p.adoptionModel } : {}),
    ...(p.upcoming ? { upcoming: p.upcoming } : {}),
  }, actor || "operator");
  addAuditLog(db, null, "human", actor || "operator", "code_profile.edition_proposal_applied", { fingerprint, profileKey: p.profileKey, changes: p.changes });
  return { status: "applied", note: `Re-verified ${p.profileKey} with ${p.changes.length} edition change(s).`, profile: saved };
}

export function dismissEditionProposal(db: AppDb, fingerprint: string, actor: string, reason = ""): void {
  addAuditLog(db, null, "human", actor || "operator", PROPOSAL_DISMISSED, { fingerprint, reason: String(reason).slice(0, 400) });
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
      const d = codeResearchDecision(db, layer.state, layer.ahj);
      if (d.action === "skip") continue;
      const key = d.key;
      const askedAt = inFlightCodeResearch.get(key);
      const window = d.action === "verify_check" ? VERIFY_CHECK_WINDOW_MS : CODE_RESEARCH_WINDOW_MS;
      if (askedAt != null && Date.now() - askedAt < window) continue;
      // Dedupe: a pending/running job for this layer, OR any attempt inside the window (a stub or
      // ungrounded research stores nothing — without the window, every review of the jurisdiction
      // would re-queue it forever). A verified row's staleness check backs off 30 days: it never
      // changes the row, so nothing else would stop it repeating.
      const recent = db.get<Row>(
        `SELECT id FROM job_queue
          WHERE job_type = 'code_research' AND payload LIKE ? ESCAPE '\\'
            AND (status IN ('pending','running') OR created_at > ?)`,
        [`%"profileKey":"${likeLiteral(key)}"%`, new Date(Date.now() - window).toISOString()],
      );
      if (recent) continue;
      inFlightCodeResearch.set(key, Date.now());
      const payload: CodeResearchJobPayload = {
        state: d.state, ahj: d.ahj, profileKey: key, reason: d.reason,
        ...(d.action === "verify_check" ? { mode: "verify_check" as const } : {}),
        ...(d.families?.length ? { families: d.families } : {}),
      };
      if (codeResearchEnqueuerForTests) codeResearchEnqueuerForTests(db, payload);
      // Lazy import avoids a static cycle (jobQueue -> ... -> codeProfiles).
      else void import("./jobQueue").then(({ enqueueJob, processNextJob }) => {
        // maxRetries 2: the worker's retry math (`retryCount+1 < maxRetries`)
        // means 1 yields ZERO retries — 2 gives the intended single retry.
        enqueueJob(db, "code_research", payload as unknown as Record<string, unknown>, { priority: 3, maxRetries: 2 });
        void processNextJob(db).catch(() => null);
      }).catch(() => { inFlightCodeResearch.delete(key); });
      enqueued++;
      logger.info("code-profiles", `auto-research queued for ${d.state}/${d.ahj || "(state default)"} (${d.reason})`);
    } catch { /* autonomy is best-effort — never break a review */ }
  }
  // A row can EXIST and still say nothing about the site: Coos Bay's researched profile had
  // adopted codes and designCriteria {} — so the check above ("a row exists, done") never
  // asked again, and every project there reviewed against an unknown ground snow load. This runs
  // for every AHJ, including one whose codes it inherits from a uniform state.
  const ahjLayer = layers.find((l) => l.ahj);
  if (ahjLayer) {
    try { enqueued += ensureDesignCriteriaResearched(db, ahjLayer.state, ahjLayer.ahj); } catch { /* best-effort */ }
  }
  return enqueued;
}

/** A verified row's staleness check (research whose only output is a proposal) backs off longer. */
const VERIFY_CHECK_WINDOW_MS = 30 * 24 * 3600_000;
/** A grounded row older than this is re-researched (codes change on a ~3-year cycle, with phase-ins). */
export const CODE_RESEARCH_MAX_AGE_DAYS = 180;

export interface CodeResearchJobPayload {
  state: string;
  ahj: string;
  profileKey: string;
  /** "verify_check": the target is human-verified — the research may only produce a proposal. */
  mode?: "verify_check";
  /** AHJ layer: only these families (the state leaves them to local adoption). */
  families?: CodeFamily[];
  reason?: string;
}

export type CodeResearchDecision = {
  state: string;
  ahj: string;
  key: string;
} & (
  | { action: "research"; reason: "no_row" | "no_grounded_codes" | "memory_provenance" | "upcoming_due" | "older_than_180d"; families?: CodeFamily[] }
  | { action: "verify_check"; reason: "upcoming_due" | "older_than_180d"; families?: undefined }
  | { action: "skip"; reason: "verified_fresh" | "blocked_verified" | "inherits_state" | "pending_state" | "fresh" | "no_jurisdiction"; families?: undefined }
);

function daysSince(iso: string | undefined, now: number): number {
  const t = Date.parse(String(iso || ""));
  return Number.isFinite(t) ? (now - t) / 86_400_000 : Infinity;
}

/** Codes on this row that a grounded source put there (research, the reference data, an operator)
 *  for the given families (all when none are named). */
function hasGroundedCodes(profile: JurisdictionCodeProfile, families?: CodeFamily[]): boolean {
  const inScope = (c: CodeEdition) => !families?.length || families.includes(codeFamilyOf(c) as CodeFamily);
  const codes = profile.adoptedCodes.filter(inScope);
  if (!codes.length) return false;
  if (codes.some((c) => c.origin === "research" || c.origin === "reference" || c.origin === "operator")) return true;
  // Rows researched before entries carried an origin: the row's provenance speaks for them.
  return profile.researchProvenance?.webGrounded === true;
}

/**
 * WHETHER (AND WHY) ONE LAYER'S CODES SHOULD BE RESEARCHED NOW — the one rule the automatic trigger
 * and the backfill share.
 *   AHJ layer:  a verified row is never researched; in a state whose every family is adopted
 *               uniformly (or as a statewide minimum) the AHJ inherits and only its design criteria
 *               are looked up; otherwise the local families are researched when the row has no
 *               grounded code for them, holds model memory, or is stale.
 *   State layer: a verified row gets a staleness CHECK (proposal only) when it is older than 180
 *               days or an announced edition's date has passed since it was verified; a seeded row
 *               is researched when it has no grounded codes, holds model memory, an upcoming date
 *               passed after its research, or it is older than 180 days.
 * Rows that hold only stamp notes / imports / corrections are researched too: the save MERGES.
 */
export function codeResearchDecision(db: AppDb, state: string, ahj: string, asOf: string = nowIso()): CodeResearchDecision {
  const now = Date.parse(asOf) || Date.now();
  let st = String(state || "").trim();
  let name = String(ahj || "").trim();
  if (!st) return { state: st, ahj: name, key: "", action: "skip", reason: "no_jurisdiction" };
  let row: JurisdictionCodeProfile | null = null;
  const model = stateAdoptionModel(db, st);
  if (name) {
    // The row a research save would land on (resolveCriteriaWriteRow): a verified row the reads use
    // is left alone, and the same jurisdiction under another label ("Plano" for "City of Plano") is
    // researched under ITS name — a save under the project's spelling would fork it.
    const target = resolveCriteriaWriteRow(db, st, name);
    if (!target) return { state: st, ahj: name, key: "", action: "skip", reason: "no_jurisdiction" };
    if (target.kind === "blocked_verified") return { state: st, ahj: name, key: target.key, action: "skip", reason: "blocked_verified" };
    if (target.kind === "same_jurisdiction") { st = target.profile.state; name = target.profile.ahj; }
    row = target.kind === "create" ? null : target.profile;
    const key = codeProfileKey({ state: st, ahj: name });
    // STATE FIRST, ALSO ON THE LIVE TRIGGER: with no adoption model known, the AHJ waits while its
    // state layer is still to be researched — researched in parallel, an AHJ copy of the state's
    // editions could land first and then read as the AHJ's own (and, the state having said
    // "inherits", never be looked at again). Once the state layer has been researched (fresh, or
    // verified) the AHJ proceeds with or without a model: a state answer that omits the model
    // must not strand every AHJ in it.
    if (!model && codeResearchDecision(db, st, "", asOf).action === "research") {
      return { state: st, ahj: name, key, action: "skip", reason: "pending_state" };
    }
    // What the state adopts uniformly (or as the minimum every AHJ enforces) is not looked up city
    // by city. Only local-adoption families are the AHJ's to research.
    const local = model ? ahjResearchFamilies(model) : undefined;
    if (local && !local.length) return { state: st, ahj: name, key, action: "skip", reason: "inherits_state" };
    const base = { state: st, ahj: name, key, ...(local ? { families: local } : {}) };
    if (!row) return { ...base, action: "research", reason: "no_row" };
    return seededRowDecision(base, row, local, now);
  }
  const key = codeProfileKey({ state: st, ahj: "" });
  const stateRowRaw = db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
  row = stateRowRaw ? mapRow(stateRowRaw) : null;
  if (!row) return { state: st, ahj: "", key, action: "research", reason: "no_row" };
  if (row.confidence === "verified") {
    const upcoming = row.upcoming?.length ? row.upcoming : referenceStateAdoption(st)?.upcoming;
    if (upcomingDue(upcoming, row.verifiedAt, new Date(now).toISOString()).length) return { state: st, ahj: "", key, action: "verify_check", reason: "upcoming_due" };
    if (daysSince(row.verifiedAt, now) > CODE_RESEARCH_MAX_AGE_DAYS) return { state: st, ahj: "", key, action: "verify_check", reason: "older_than_180d" };
    return { state: st, ahj: "", key, action: "skip", reason: "verified_fresh" };
  }
  return seededRowDecision({ state: st, ahj: "", key }, row, undefined, now);
}

function seededRowDecision(
  base: { state: string; ahj: string; key: string; families?: CodeFamily[] },
  row: JurisdictionCodeProfile,
  families: CodeFamily[] | undefined,
  now: number,
): CodeResearchDecision {
  if (row.confidence === "verified") return { ...base, action: "skip", reason: "blocked_verified", families: undefined };
  const prov = row.researchProvenance;
  if (prov && !prov.webGrounded && row.adoptedCodes.length) return { ...base, action: "research", reason: "memory_provenance" };
  if (!hasGroundedCodes(row, families)) return { ...base, action: "research", reason: prov && !prov.webGrounded ? "memory_provenance" : "no_grounded_codes" };
  const researchedAt = prov?.at || row.researchedAt;
  if (upcomingDue(row.upcoming, researchedAt, new Date(now).toISOString()).length) return { ...base, action: "research", reason: "upcoming_due" };
  if (daysSince(researchedAt, now) > CODE_RESEARCH_MAX_AGE_DAYS) return { ...base, action: "research", reason: "older_than_180d" };
  return { ...base, action: "skip", reason: "fresh", families: undefined };
}

/** Test seam: enqueue WITHOUT kicking the worker. null restores the real path. */
let codeResearchEnqueuerForTests: ((db: AppDb, payload: CodeResearchJobPayload) => void) | null = null;
export function setCodeResearchEnqueuerForTests(fn: ((db: AppDb, payload: CodeResearchJobPayload) => void) | null): void {
  codeResearchEnqueuerForTests = fn;
}

/**
 * THE code_research JOB BODY (jobQueue's handler and the backfill's --apply both call this, so the
 * backfill runs the real save path). `provider` is a test seam.
 *   stub / not web-grounded / no codes -> nothing stored (the job row is the backoff marker), and the
 *   grounding evidence is reported;
 *   a verified target -> saveResearchedCodeProfile records a proposal, never a write;
 *   otherwise -> the research MERGE onto the row.
 */
export async function runCodeResearch(db: AppDb, payload: Partial<CodeResearchJobPayload> & Record<string, unknown>, provider?: LLMProvider): Promise<Record<string, unknown>> {
  const state = String(payload.state || "");
  const ahj = String(payload.ahj || "");
  const families = Array.isArray(payload.families) ? payload.families.filter(isCodeFamily) : undefined;
  const llm = provider ?? (await import("./llm")).createLLMProvider();
  const research = await llm.researchJurisdictionCodes({ state, ahj, ...(families?.length ? { families } : {}) });
  const prov = provenanceOf(research.profile);
  const evidence = {
    webGrounded: research.webGrounded,
    searches: prov?.searches ?? 0,
    groundedSearches: prov?.groundedSearches ?? 0,
    resultUrls: prov?.resultUrls?.length ?? 0,
    outputTokens: prov?.outputTokens,
  };
  if (research.provider === "stub") return { saved: false, reason: "stub LLM (no API key)", notes: research.notes };
  if (!research.webGrounded) {
    // A TIMEOUT MUST NOT LEAVE THE AHJ WITH NO CODES. New-AHJ e2e (2026-09-26): Iowa City's full
    // research died at the 180-300 s budget and nothing was stored — every code field read
    // "not found". A transient failure (a timeout, an overloaded API, a cut-off answer) gets ONE
    // lighter pass: editions only, the asked families, fewer searches, no page reads — and still
    // only grounded, cited, quoted editions land (lightCodeResearch).
    const failureNotes = String(research.notes || "");
    if (TRANSIENT_RESEARCH_FAILURE.test(failureNotes) && llm.webLookup) {
      const light = await lightCodeResearch(llm, { state, ahj, families });
      if (light.profile) {
        const saved = saveResearchedCodeProfile(db, light.profile, { ...(families?.length ? { families } : {}) });
        return { saved: true, key: saved.key, confidence: saved.confidence, adoptedCodes: saved.adoptedCodes.length, light: true, lightKept: light.kept, lightDropped: light.dropped.slice(0, 6), fullFailure: failureNotes.slice(0, 300) };
      }
      return { saved: false, reason: `full research failed (${failureNotes.slice(0, 200)}); the lighter retry stored nothing: ${light.reason}`, ...evidence, lightDropped: light.dropped.slice(0, 6) };
    }
    return { saved: false, reason: "not web-grounded — model memory is never stored as an edition", ...evidence, notes: failureNotes.slice(0, 600) };
  }
  if (!research.profile.adoptedCodes.length && !research.profile.adoptionModel) return { saved: false, reason: "research found no adopted codes", ...evidence };
  // The row the save would land on: the exact key, or — for an AHJ — the human-verified row its
  // name resolves to by fuzzy match ("City of Portland" -> or|portland), which the save refuses to
  // shadow. Either way the result is "not saved", never a saved:true over an unchanged row.
  const writeTarget = ahj.trim() ? resolveCriteriaWriteRow(db, state, ahj) : null;
  const key = writeTarget?.kind === "blocked_verified" ? writeTarget.key : codeProfileKey({ state, ahj });
  const targetVerified = text(db.get<Row>("SELECT confidence FROM jurisdiction_code_profiles WHERE profile_key = ?", [key])?.confidence) === "verified";
  const before = targetVerified ? listEditionProposals(db, key).map((p) => p.fingerprint) : [];
  const saved = saveResearchedCodeProfile(db, research.profile, { ...(families?.length ? { families } : {}) });
  if (targetVerified) {
    const after = listEditionProposals(db, key);
    return { saved: false, verified: true, proposals: after.length, newProposal: after.some((p) => !before.includes(p.fingerprint)), ...evidence };
  }
  return { saved: true, key: saved.key, confidence: saved.confidence, adoptedCodes: saved.adoptedCodes.length, ...evidence };
}

/** A full research that failed for a reason a lighter pass can survive (the budget, the API, a cut-off
 *  answer) — not one that searched and found nothing, which a lighter pass would only repeat. */
export const TRANSIENT_RESEARCH_FAILURE = /web search failed|timed?\s*out|timeout|aborted|overloaded|rate.?limit|\b(?:429|500|502|503|529)\b|ECONNRESET|socket hang up|truncated|max_tokens|did not parse/i;

export const LIGHT_CODE_RESEARCH_SYSTEM = `You find which building-code EDITIONS one jurisdiction enforces TODAY for residential work. Nothing else: no design criteria, no amendments, no process.

SEARCH the jurisdiction's own site (or, for a state, the state agency that adopts the codes) for its adopted-codes page or ordinance. Every entry must be backed by a page your searches returned, and you must quote the sentence on it that names the edition.

Return ONLY JSON:
{"adoptedCodes":[{"family":"residential|building|electrical|fire|energy|mechanical|plumbing","code":"<IRC|IBC|NEC|IFC|IECC|IMC|IPC|UPC or the state code's own name>","edition":"<year>","sourceUrl":"<page>","quote":"<the sentence naming the edition, verbatim>"}]}

Omit a family rather than guess. An empty list is a correct answer when nothing citable is found.`;

function normResultUrl(u: string): string {
  return String(u || "").trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * THE LIGHTER PASS. One webLookup (3 searches, no page reads, a small answer); an edition is kept only
 * when its URL is one the searches returned, its quote names the edition year, and its family is one
 * that was asked (all, for the state layer). The profile it returns carries web-grounded provenance
 * marked as the light pass, and goes through the same save (scope, merge, verified refusal).
 */
export async function lightCodeResearch(
  llm: Pick<LLMProvider, "webLookup">,
  input: { state: string; ahj: string; families?: CodeFamily[] },
): Promise<{ profile: JurisdictionCodeProfile | null; kept: number; dropped: string[]; reason: string }> {
  if (!llm.webLookup) return { profile: null, kept: 0, dropped: [], reason: "no web lookup available" };
  const who = input.ahj.trim() ? `${input.ahj}, ${input.state}` : `the state of ${input.state} (the statewide codes)`;
  const res = await llm.webLookup({
    label: "researchJurisdictionCodes.light",
    system: LIGHT_CODE_RESEARCH_SYSTEM,
    user: `Jurisdiction: ${who}${input.families?.length ? `\nFamilies to answer: ${input.families.join(", ")}` : ""}`,
    maxTokens: 2500,
    maxSearches: 3,
    readPages: false,
    timeoutMs: 120_000,
  });
  if (res.error) return { profile: null, kept: 0, dropped: [], reason: `lookup failed: ${res.error.slice(0, 200)}` };
  if (!res.groundedSearches) return { profile: null, kept: 0, dropped: [], reason: "no web search returned results" };
  let parsed: { adoptedCodes?: unknown };
  try {
    const m = String(res.text || "").match(/```(?:json)?\s*([\s\S]*?)```/) ?? String(res.text || "").match(/(\{[\s\S]*\})/);
    parsed = JSON.parse(m ? m[1] : String(res.text || "")) as { adoptedCodes?: unknown };
  } catch {
    return { profile: null, kept: 0, dropped: [], reason: "the answer did not parse" };
  }
  const seen = new Set((res.resultUrls ?? []).map(normResultUrl));
  const dropped: string[] = [];
  const codes: CodeEdition[] = [];
  for (const raw of Array.isArray(parsed.adoptedCodes) ? parsed.adoptedCodes : []) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const family = isCodeFamily(String(o.family || "").trim().toLowerCase()) ? (String(o.family).trim().toLowerCase() as CodeFamily) : undefined;
    const code = String(o.code || "").trim().slice(0, 24);
    const edition = String(o.edition || "").match(/\d{4}/)?.[0] ?? "";
    const sourceUrl = String(o.sourceUrl || "").trim().slice(0, 500);
    const quote = String(o.quote || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const label = `${code} ${edition}`.trim() || "(unnamed)";
    if (!family || !code || !edition) { dropped.push(`${label}: missing family/code/edition`); continue; }
    if (input.families?.length && !input.families.includes(family)) { dropped.push(`${label}: ${family} was not asked`); continue; }
    if (!sourceUrl || !seen.has(normResultUrl(sourceUrl))) { dropped.push(`${label}: its URL was not a page the searches returned`); continue; }
    if (!quote.includes(edition)) { dropped.push(`${label}: the quote does not name ${edition}`); continue; }
    codes.push({ family, code, edition, sourceUrl, quote });
  }
  if (!codes.length) return { profile: null, kept: 0, dropped, reason: dropped.length ? "every edition was dropped (uncited or unquoted)" : "no edition found" };
  const profile: JurisdictionCodeProfile = {
    key: "", state: input.state, ahj: input.ahj, confidence: "seeded",
    adoptedCodes: codes, amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [],
    citations: codes.map((c) => ({ label: `${c.code} ${c.edition} (light research)`, sourceUrl: c.sourceUrl! })),
    updatedAt: "",
    researchProvenance: {
      webGrounded: true, method: "web_search",
      notes: "Light retry after the full research failed (editions only, cited and quoted).",
      at: nowIso(), searches: res.searches ?? res.groundedSearches, groundedSearches: res.groundedSearches,
      ...(res.resultUrls?.length ? { resultUrls: res.resultUrls.slice(0, 20) } : {}),
    },
  };
  return { profile, kept: codes.length, dropped, reason: "" };
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

/** For display only: the DIFFERENT jurisdiction's row a fuzzy name match would pick for this AHJ
 *  (the row a write does NOT touch). Null when the match is this same jurisdiction under another
 *  label ("Plano" for "City of Plano") — that row IS the one written. */
export function nearestOtherCodeProfileRow(db: AppDb, state: string, ahj: string): { key: string; ahj: string } | null {
  const target = resolveCriteriaWriteRow(db, state, ahj);
  return target?.kind === "create" && target.differentRow ? target.differentRow : null;
}

// --- WHICH ROW A WRITE LANDS ON --------------------------------------------------------
//
// Reads resolve an AHJ to its exact-key row, else to the fuzzy name match (getCodeProfile). A write
// that ignores that and creates a row under the project's own spelling SHADOWS the row reads used:
// "City of Portland" created or|city of portland, and every later read of City of Portland lost the
// human-verified or|portland row (verified -> seeded, its amendment gone) — and the new seeded row
// then unlocked automatic full research. Imported rows are keyed by bare names ("Plano", "Seattle")
// while projects say "City of X", so the same fork dropped imported amendments in TX, WA and FL.
//
// One rule for every writer of one AHJ's criteria (a correction apply, the design-criteria lookup
// and its merge, full code research):
//   exact key exists          -> that row (refused when human-verified);
//   else a fuzzy match exists -> human-verified: REFUSED (a person verifies instead; nothing is
//                                created that would outrank it);
//                                same jurisdiction under another label: that row;
//                                a different jurisdiction (Lincoln County for City of Lincoln
//                                City): a new row under the exact key;
//   else                      -> a new row under the exact key.

/** "City of Plano" -> {type:"city", core:"plano"}; "Elmore County, ID" -> {type:"county", core:"elmore"}.
 *  The ONE prefix/suffix stripper; the AHJ-vs-city near-miss predicate (ahjNearMiss.ts) builds on it. */
export function jurisdictionIdentity(name: string, state: string): { type: string; core: string } {
  let s = String(name || "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const st = String(state || "").trim().toLowerCase();
  if (st && s.endsWith(` ${st}`) && s.length > st.length + 1) s = s.slice(0, -(st.length + 1)).trim();
  s = s.replace(/^the\s+/, "");
  let type = "";
  const pre = s.match(/^(city|town|village|township|borough|county|parish|municipality)\s+of\s+/);
  if (pre) { type = pre[1]; s = s.slice(pre[0].length).replace(/^the\s+/, ""); } // "City of The Dalles" = "The Dalles"
  else {
    // "Yamhill Co" / "Jackson Co." is a county too — the reference file's own spelling for twelve
    // counties (Polk Co, Wasco Co, Yamhill Co, Clark Co, King Co…). Without it "Jackson Co." read as
    // a bare municipality "jackson co", two edits from the city "Jackson" (fix round 2026-09-29).
    const suf = s.match(/\s+(county|co|parish|township|borough)$/);
    if (suf && s.length > suf[0].length) { type = suf[1] === "co" ? "county" : suf[1]; s = s.slice(0, -suf[0].length); }
  }
  return { type, core: s.trim() };
}

/** A bare name is a municipality ("Plano" = "City of Plano"); a county, parish, township or borough
 *  must say so on both sides ("Lincoln" is not "Lincoln County"); two different named types differ. */
const MUNICIPAL_TYPES = new Set(["", "city", "town", "village", "municipality"]);
export function sameJurisdictionName(a: string, b: string, state: string): boolean {
  const x = jurisdictionIdentity(a, state);
  const y = jurisdictionIdentity(b, state);
  if (!x.core || x.core !== y.core) return false;
  if (x.type === y.type) return true;
  return (!x.type || !y.type) && MUNICIPAL_TYPES.has(x.type) && MUNICIPAL_TYPES.has(y.type);
}

/**
 * IS THIS NAME A JURISDICTION THIS TABLE KNOWS ON SOMEONE'S AUTHORITY — a human-verified row, or one
 * the shipped reference file carries. EXACT key only (never fuzzyCodeRow: the containment scorer
 * calls "City Of Smonroe" a match for "Monroe"). A seeded row proves nothing: code research, a
 * correction's criterion (applyJurisdictionCriteriaProposal) and the design-criteria lookup all
 * create seeded rows under whatever name the project carried — a typo included — so the product's
 * own writes can never make a typo "known". Read-only.
 */
export function knownCodeProfileName(db: AppDb, state: string, name: string): boolean {
  if (!String(name || "").trim() || !String(state || "").trim()) return false;
  const key = codeProfileKey({ state, ahj: name });
  try {
    const row = db.get<{ confidence?: string }>("SELECT confidence FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
    if (row && text(row.confidence) === "verified") return true;
  } catch { /* table not there yet: not known */ }
  return (loadReference()?.profiles ?? []).some((p) => String(p.ahj || "").trim() && codeProfileKey(p) === key);
}

export type CriteriaWriteRow =
  | { kind: "exact" | "same_jurisdiction"; key: string; profile: JurisdictionCodeProfile }
  | { kind: "create"; key: string; profile: null; differentRow?: { key: string; ahj: string } }
  | { kind: "blocked_verified"; key: string; profile: JurisdictionCodeProfile; message: string };

export function resolveCriteriaWriteRow(db: AppDb, state: string, ahj: string): CriteriaWriteRow | null {
  const st = String(state || "").trim();
  const name = String(ahj || "").trim();
  if (!st || !name) return null;
  const exactKey = codeProfileKey({ state: st, ahj: name });
  const exact = db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [exactKey]);
  if (exact) {
    const profile = mapRow(exact);
    return profile.confidence === "verified"
      ? { kind: "blocked_verified", key: exactKey, profile, message: `${profile.ahj || name}'s profile is human-verified — it is not changed automatically. A person verifies the value on that profile instead.` }
      : { kind: "exact", key: exactKey, profile };
  }
  const fuzzy = fuzzyCodeRow(db, { state: st, ahj: name });
  if (fuzzy) {
    const profile = mapRow(fuzzy);
    const key = text(fuzzy.profile_key);
    if (profile.confidence === "verified") {
      return { kind: "blocked_verified", key, profile, message: `Reviews for ${name} read the human-verified profile "${profile.ahj}" (${key}). Nothing is written: a new row would replace that verified profile for every later review. A person verifies the value on "${profile.ahj}" instead.` };
    }
    if (sameJurisdictionName(name, profile.ahj, st)) return { kind: "same_jurisdiction", key, profile };
    return { kind: "create", key: exactKey, profile: null, differentRow: { key, ahj: profile.ahj } };
  }
  return { kind: "create", key: exactKey, profile: null };
}

/** A seeded AHJ value never overrides a field the VERIFIED state layer supplies (the AHJ row is
 *  merged over the state row on every read). The state layer's note, or "" when the write is free. */
function verifiedStateLayerNote(db: AppDb, state: string, block: CriterionBlock, criterion: string): string {
  const row = db.get<Row>("SELECT * FROM jurisdiction_code_profiles WHERE profile_key = ?", [codeProfileKey({ state, ahj: "" })]);
  if (!row || text(row.confidence) !== "verified") return "";
  const v = blockValue(mapRow(row), block, criterion);
  // A DECISION, not the layering default: an AHJ row normally overrides the state default field by
  // field, but a SEEDED value (a correction apply, a lookup) does not override a VERIFIED state value.
  return v === null ? "" : `The state's human-verified profile sets ${criterion} = ${String(v)} for every AHJ in ${state}; a seeded local value would override it on every read. If this AHJ differs, a person verifies the local value on its own profile.`;
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
  /** Set when the write is refused before anyone clicks: a verified row (or verified state field) governs. */
  blockedNote?: string;
} {
  // The row the apply will WRITE — or the verified row that refuses it (resolveCriteriaWriteRow).
  const target = resolveCriteriaWriteRow(db, state, ahj);
  const own = target && target.kind !== "create" ? target.profile : null;
  const stateNote = target && target.kind !== "blocked_verified" ? verifiedStateLayerNote(db, state, block, criterion) : "";
  return {
    profileKey: own ? target!.key : "",
    targetProfileKey: target?.key ?? codeProfileKey({ state, ahj }),
    value: blockValue(own, block, criterion),
    confidence: stateNote ? "verified" : own?.confidence ?? null,
    ...(target?.kind === "blocked_verified" ? { blockedNote: target.message } : stateNote ? { blockedNote: stateNote } : {}),
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
  const target = resolveCriteriaWriteRow(db, proposal.state, proposal.ahj);
  if (!target) return { status: "refused", note: "No state / jurisdiction on the proposal.", profileKey: "" };
  // Hard rule 3: a verified row the reads resolve to is never written, and never shadowed.
  if (target.kind === "blocked_verified") return { status: "refused", note: target.message, profileKey: target.key };
  const stateNote = verifiedStateLayerNote(db, proposal.state, proposal.block, proposal.criterion);
  if (stateNote) return { status: "refused", note: stateNote, profileKey: target.key };
  // The row must be the one the human saw on the card. A proposal made earlier may name another
  // jurisdiction's row ("Lincoln County" for "City of Lincoln City") or a row that has since
  // changed identity: never write through it.
  const shownKey = proposal.profileKey || proposal.targetProfileKey || "";
  if (shownKey && shownKey !== target.key) {
    return { status: "refused", note: `This proposal named profile row ${shownKey}, but ${proposal.ahj} now resolves to ${target.key} — re-triage the correction.`, profileKey: target.key };
  }
  const own = target.kind === "create" ? null : { key: target.key, profile: target.profile };
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
  // THE SHARED ROW CARRIES THE VALUE, NOT THE COMMENT. jurisdiction_code_profiles reaches every
  // tenant (GET /api/code-profiles); the AHJ's sentence can name a homeowner's address, and the
  // correction id / record number point into one org's project. Those stay in the org-scoped review
  // item (proposal.basis) and the project's audit log below.
  next.citations.push(sharedCorrectionCitation(field, proposal.value, proposal.source.receivedAt));
  const saved = upsert(db, next, { confidence: "seeded" });
  addAuditLog(db, opts.projectId, "human", opts.actor || "operator", "code_profile.criterion_from_correction", {
    profileKey: codeProfileKey(next), field, from: proposal.currentValue, to: proposal.value,
    correctionId: proposal.source.correctionId, recordNumber: proposal.source.recordNumber,
    quote: proposal.basis.slice(0, 240),
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
/** An incomplete lookup is retried after this long — not held for the 30-day window, which is for
 *  ANSWERS (a complete lookup, values or none). */
export const DESIGN_RESEARCH_RETRY_MS = 3600_000;
/** Incomplete attempts in the window before the retry stops (a person looks; the next window retries). */
export const DESIGN_RESEARCH_MAX_INCOMPLETE = 3;

interface DesignLookupAttempt {
  jobType: string;
  status: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  result: Record<string, unknown> | null;
}

/** The AHJ's lookup jobs in the 30-day window (plus any still pending/running), newest first: the
 *  design-criteria lookup and the full code research that asks for the same criteria. A READ. */
function designLookupAttempts(db: AppDb, key: string): DesignLookupAttempt[] {
  if (!key) return [];
  return db.query<Row>(
    `SELECT job_type, status, created_at, started_at, finished_at, result FROM job_queue
      WHERE job_type IN ('design_criteria_research','code_research') AND payload LIKE ? ESCAPE '\\'
        AND (status IN ('pending','running') OR created_at > ?)
      ORDER BY created_at DESC LIMIT 20`,
    [`%"profileKey":"${likeLiteral(key)}"%`, new Date(Date.now() - DESIGN_RESEARCH_WINDOW_MS).toISOString()],
  ).map((r) => {
    let result: Record<string, unknown> | null = null;
    try { result = r.result ? JSON.parse(text(r.result)) : null; } catch { result = null; }
    return { jobType: text(r.job_type), status: text(r.status), createdAt: text(r.created_at), startedAt: text(r.started_at), finishedAt: text(r.finished_at), result };
  }).filter((a) => a.jobType === "design_criteria_research" || a.status === "pending" || a.status === "running");
}

/** A finished design-criteria lookup that is NOT an answer: it failed, was cut off, or did not
 *  ground on the web (model memory is never stored, so nothing was looked at). */
function isIncompleteDesignLookup(a: DesignLookupAttempt): boolean {
  if (a.status === "failed") return true;
  return a.result?.webGrounded === false || a.result?.truncated === true;
}

/** Every finished attempt in the window is incomplete, under the cap, and the newest is older than
 *  the retry backoff. */
function designLookupRetryDue(attempts: DesignLookupAttempt[]): boolean {
  const finished = attempts.filter((a) => a.jobType === "design_criteria_research" && a.status !== "pending" && a.status !== "running");
  if (!finished.length) return true;
  if (!finished.every(isIncompleteDesignLookup)) return false;
  if (finished.length >= DESIGN_RESEARCH_MAX_INCOMPLETE) return false;
  const newest = Date.parse(finished[0].finishedAt || finished[0].createdAt);
  return !Number.isFinite(newest) || Date.now() - newest >= DESIGN_RESEARCH_RETRY_MS;
}

/** Whether a design lookup may be queued at all in this process (key, switches). */
function designLookupEnabled(): boolean {
  if (process.env.SKIP_CODE_RESEARCH === "1" || codeResearchSwitchedOff() || isAutoSeedDisabled()) return false;
  return !!String(process.env.ANTHROPIC_API_KEY ?? "").trim();
}

/**
 * WHERE THIS AHJ'S DESIGN-CRITERIA LOOKUP STANDS, for the reviewer's wording. A pure READ of
 * job_queue (the page-load reads write nothing — nextStep.test pins it). undefined = no lookup in the
 * window (the finding keeps its "not on file" wording).
 */
export function readDesignLookupProgress(db: AppDb, state: string, ahj: string): DesignCriteriaLookupProgress | undefined {
  const target = resolveCriteriaWriteRow(db, state, ahj);
  if (!target || target.kind === "blocked_verified") return undefined;
  const attempts = designLookupAttempts(db, target.key);
  const live = attempts.find((a) => a.status === "pending" || a.status === "running");
  if (live) return live.status === "running" ? { status: "running", at: live.startedAt || live.createdAt } : { status: "queued", at: live.createdAt };
  // Queued by this process a moment ago: the job row is inserted after a dynamic import resolves.
  const askedAt = inFlightDesignResearch.get(target.key);
  const lastRow = attempts.find((a) => a.jobType === "design_criteria_research");
  if (askedAt != null && (!lastRow || Date.parse(lastRow.createdAt) < askedAt - 1000)) return { status: "queued", at: new Date(askedAt).toISOString() };
  const last = lastRow;
  if (!last) return undefined;
  const at = last.finishedAt || last.createdAt;
  if (isIncompleteDesignLookup(last)) {
    // "Retrying" only when a retry will actually be queued: the next review of this AHJ queues it.
    const finished = attempts.filter((a) => a.jobType === "design_criteria_research");
    const retrying = designLookupEnabled() && finished.every(isIncompleteDesignLookup) && finished.length < DESIGN_RESEARCH_MAX_INCOMPLETE;
    return { status: retrying ? "retrying" : "incomplete", at };
  }
  const items = designCriteriaLookupOf({ at, items: last.result?.checklist })?.items;
  return { status: "landed", at, ...(items ? { items } : {}) };
}

/**
 * THE CHECKLIST OF A LOOKUP THAT HAS NO ROW TO LIVE ON. A county in a statewide-minimum state gets
 * no AHJ row from code research, and a lookup that found nothing creates none (an empty row would
 * read as researched) — so its checklist lives only in the job result. The KB card reads these
 * (GET /api/code-profiles) so "we looked and found nothing" shows with its date, not as "not
 * researched". Newest complete lookup per profile key without a row. A READ.
 */
export function listRowlessDesignLookups(db: AppDb): Array<{ key: string; state: string; ahj: string; designCriteriaLookup: DesignCriteriaLookupRecord }> {
  const haveRow = new Set(db.query<Row>("SELECT profile_key FROM jurisdiction_code_profiles").map((r) => text(r.profile_key)));
  const out = new Map<string, { key: string; state: string; ahj: string; designCriteriaLookup: DesignCriteriaLookupRecord }>();
  for (const r of db.query<Row>(
    "SELECT payload, result, finished_at FROM job_queue WHERE job_type = 'design_criteria_research' AND status = 'done' ORDER BY finished_at DESC LIMIT 500",
  )) {
    let payload: Record<string, unknown> = {};
    let result: Record<string, unknown> = {};
    try { payload = JSON.parse(text(r.payload) || "{}"); result = JSON.parse(text(r.result) || "{}"); } catch { continue; }
    const key = String(payload.profileKey || "");
    if (!key || haveRow.has(key) || out.has(key)) continue;
    if (result.webGrounded === false || result.truncated === true) continue;
    const record = designCriteriaLookupOf({ at: text(r.finished_at), items: result.checklist });
    if (!record) continue;
    out.set(key, { key, state: String(payload.state || ""), ahj: String(payload.ahj || ""), designCriteriaLookup: record });
  }
  return [...out.values()];
}

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
  // The row the merge will write (resolveCriteriaWriteRow): never a verified row the reads use.
  const target = resolveCriteriaWriteRow(db, st, name);
  if (!target || target.kind === "blocked_verified") return 0;
  const own = target.kind === "create" ? null : { key: target.key, profile: target.profile };
  const dc = own?.profile.designCriteria ?? {};
  // A jurisdiction that publishes only pg(asd) (2024 IRC Table R301.2) has its ground snow answered.
  const snowAnswered = typeof dc.groundSnowLoadPsf === "number" || typeof dc.groundSnowLoadAsdPsf === "number";
  // Answered criteria: nothing to ask. (The AHJ's placement rules ride this job — runDesignCriteriaResearch
  // — so a NEW AHJ gets them; a row whose criteria were filled earlier is not re-queued for them alone.)
  if (snowAnswered && typeof dc.windSpeedMph === "number") return 0;
  const key = target.key;
  const fullAskedAt = inFlightCodeResearch.get(key);
  if (fullAskedAt != null && Date.now() - fullAskedAt < CODE_RESEARCH_WINDOW_MS) return 0;
  const fullPending = db.get<Row>(
    "SELECT id FROM job_queue WHERE job_type = 'code_research' AND payload LIKE ? ESCAPE '\\' AND status IN ('pending','running')", [`%${likeLiteral(key)}%`],
  );
  if (fullPending) return 0;
  const askedAt = inFlightDesignResearch.get(key);
  if (askedAt != null && Date.now() - askedAt < DESIGN_RESEARCH_WINDOW_MS) return 0;
  // A complete lookup in the window backs off 30 days; an INCOMPLETE one (failed, cut off, not
  // web-grounded) is not an answer and is retried (designLookupRetryDue).
  const attempts = designLookupAttempts(db, key);
  if (attempts.some((a) => a.status === "pending" || a.status === "running")) return 0;
  if (attempts.length && !designLookupRetryDue(attempts)) return 0;
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
  // The row is resolved NOW (resolveCriteriaWriteRow), not taken from the job payload: a row may
  // have been verified, or created, since the job was queued.
  const resolved = resolveCriteriaWriteRow(db, target.state, target.ahj);
  if (!resolved) return { saved: false, filled: [], skipped: [], reason: "no state / jurisdiction", profileKey: "" };
  const key = resolved.key;
  if (resolved.kind === "blocked_verified") return { saved: false, filled: [], skipped: [], reason: `profile is human-verified — ${resolved.message}`, profileKey: key };
  if (target.profileKey && target.profileKey !== key) {
    logger.info("code-profiles", `design-criteria lookup for ${target.state}/${target.ahj} was queued for ${target.profileKey}; it now resolves to ${key}`);
  }
  const own = resolved.kind === "create" ? null : { key, profile: resolved.profile };
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
    else if (v.criterion === "seismicDesignCategory") value = /^(?:A|B|C|D[012]?|E|F)$/i.test(String(v.value).trim()) ? String(v.value).trim().toUpperCase() : null;
    else if (v.criterion === "riskCategory") value = /^(?:I|II|III|IV)$/i.test(String(v.value).trim()) ? String(v.value).trim().toUpperCase() : null;
    else value = typeof v.value === "number" && Number.isFinite(v.value) && v.value > 0 && v.value < 400 ? v.value : null;
    if (value == null) { skipped.push(`${v.criterion} (unusable value)`); continue; }
    // pg(asd) is ANOTHER quantity (allowable-stress, ~0.7 x Pg): stored in its own field, never in
    // groundSnowLoadPsf, which every rule compares with a plan's strength-level Pg.
    const field: keyof JurisdictionDesignCriteria = v.criterion === "groundSnowLoadPsf" && v.qualifier === "pg_asd" ? "groundSnowLoadAsdPsf" : v.criterion;
    const had = (dc as Record<string, unknown>)[field];
    if (had !== undefined && had !== null && had !== "") { skipped.push(`${field} (already on file)`); continue; }
    if (verifiedStateLayerNote(db, target.state, "designCriteria", field)) { skipped.push(`${field} (the state's verified profile sets it)`); continue; }
    (dc as Record<string, unknown>)[field] = value;
    // A project-type handout is kept (seeded, like every lookup value) but FLAGGED on its citation.
    citations.push({ label: `Design criteria lookup: ${field} = ${value}`, sourceUrl: url.slice(0, 500), kind: "design_criteria_research", field: `designCriteria.${field}`, ...(v.quote ? { quote: String(v.quote).slice(0, 240) } : {}), at, ...(v.weakSource ? { weakSource: String(v.weakSource).slice(0, 200) } : {}) });
    filled.push(field);
  }
  if (!filled.length) return { saved: false, filled, skipped, reason: "nothing new to fill", profileKey: key };
  if (!dc.sourceUrl) dc.sourceUrl = citations.filter((c) => c.kind === "design_criteria_research").pop()?.sourceUrl;
  upsert(db, { ...base, designCriteria: dc, citations }, { confidence: "seeded" });
  addAuditLog(db, null, "system", "design criteria lookup", "code_profile.design_criteria_researched", { profileKey: key, filled, skipped });
  return { saved: true, filled, skipped, profileKey: key };
}

/** Stored placement-rule ids carry this prefix: the reviewer shows ONLY these as "AHJ rule on file"
 *  callouts (a reference/import setback row keeps its own id and behaviour). */
export const PLACEMENT_RULE_ID_PREFIX = "placement-research:";

/**
 * THE AHJ'S OWN PV PLACEMENT RULES ONTO ITS OWN ROW (pvPlacementRules.ts found and grounded them).
 * Fire setbacks / access pathways / placement rules land in fireSetbacks — only when the row holds
 * none (a human's or an import's rules are never replaced); local PV amendments are appended to
 * amendments (deduped). Always seeded; never a human-verified row (resolveCriteriaWriteRow).
 */
export function saveResearchedPlacementRules(
  db: AppDb,
  target: { state: string; ahj: string },
  rules: Array<{ kind: string; rule: string; sourceUrl: string; section?: string }>,
): { saved: boolean; setbacks: number; amendments: number; reason?: string; profileKey: string } {
  const resolved = resolveCriteriaWriteRow(db, target.state, target.ahj);
  if (!resolved) return { saved: false, setbacks: 0, amendments: 0, reason: "no state / jurisdiction", profileKey: "" };
  const key = resolved.key;
  if (resolved.kind === "blocked_verified") return { saved: false, setbacks: 0, amendments: 0, reason: `profile is human-verified — ${resolved.message}`, profileKey: key };
  if (!rules.length) return { saved: false, setbacks: 0, amendments: 0, reason: "no cited rule found", profileKey: key };
  const base: JurisdictionCodeProfile = resolved.kind === "create" ? {
    key: "", state: target.state, ahj: target.ahj, confidence: "seeded",
    adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  } : resolved.profile;
  const at = nowIso();
  const who = base.ahj || target.ahj;
  const placement = rules.filter((r) => r.kind !== "local_amendment");
  const local = rules.filter((r) => r.kind === "local_amendment");
  const fireSetbacks = base.fireSetbacks.length ? base.fireSetbacks : placement.map((r, i) => ({
    id: `${PLACEMENT_RULE_ID_PREFIX}${r.kind}:${i + 1}`,
    description: r.rule,
    codeReference: {
      code: `${who} ${r.kind === "fire_setback" || r.kind === "access_pathway" ? "fire access rule" : "PV placement rule"}`,
      section: r.section || "",
      title: r.kind.replace(/_/g, " "),
      adoptionScope: `${who}'s own published rule (seeded from its page — verify before citing as authoritative).`,
      sourceUrl: r.sourceUrl,
      note: "Looked up from the AHJ's own page; the rule is quoted, not checked against the plan.",
    },
  }));
  const amendKey = (a: { code: string; section?: string; summary: string }) => `${a.code}|${a.section ?? ""}|${a.summary}`.toLowerCase();
  const have = new Set(base.amendments.map(amendKey));
  const newAmend = local.map((r) => ({ code: "Local PV amendment", section: r.section || undefined, summary: r.rule.slice(0, 400), sourceUrl: r.sourceUrl }))
    .filter((a) => !have.has(amendKey(a)));
  const addedSetbacks = base.fireSetbacks.length ? 0 : fireSetbacks.length;
  if (!addedSetbacks && !newAmend.length) return { saved: false, setbacks: 0, amendments: 0, reason: "the row already holds placement rules; nothing new", profileKey: key };
  // The citation carries no `kind` (the shared type names two kinds, and this module may not widen
  // it); its label marks it, and it is deduped by label + URL.
  const label = `PV placement / fire access rules (${who})`;
  const citeKeys = new Set(base.citations.map((c) => `${c.label}|${c.sourceUrl}`.toLowerCase()));
  const citations = [...base.citations];
  for (const r of rules) {
    const k = `${label}|${r.sourceUrl.slice(0, 500)}`.toLowerCase();
    if (citeKeys.has(k)) continue;
    citeKeys.add(k);
    citations.push({ label, sourceUrl: r.sourceUrl.slice(0, 500), quote: r.rule.slice(0, 240), at });
  }
  upsert(db, { ...base, fireSetbacks, amendments: [...base.amendments, ...newAmend], citations }, { confidence: "seeded" });
  addAuditLog(db, null, "system", "placement rules lookup", "code_profile.placement_rules_researched", { profileKey: key, setbacks: addedSetbacks, amendments: newAmend.length });
  return { saved: true, setbacks: addedSetbacks, amendments: newAmend.length, profileKey: key };
}

// --- The lookup's checklist -------------------------------------------------------------

/** WHAT THE DESIGN-CRITERIA JOB MUST ANSWER for every AHJ, in display order. */
export const DESIGN_CRITERIA_CHECKLIST: readonly DesignCriteriaChecklistItem[] = [
  "groundSnowLoad", "windSpeed", "windExposure", "seismicDesignCategory", "frostDepth", "riskCategory", "fireSetbacks", "localPvAmendments",
];
const CHECKLIST_FIELDS: Partial<Record<DesignCriteriaChecklistItem, Array<keyof JurisdictionDesignCriteria>>> = {
  groundSnowLoad: ["groundSnowLoadPsf", "groundSnowLoadAsdPsf"],
  windSpeed: ["windSpeedMph"],
  windExposure: ["windExposure"],
  seismicDesignCategory: ["seismicDesignCategory"],
  frostDepth: ["frostDepthIn"],
  riskCategory: ["riskCategory"],
};

const SITE_SPECIFIC_ITEM: Record<NonNullable<DesignCriteriaResearchResult["siteSpecific"]>[number]["criterion"], DesignCriteriaChecklistItem> = {
  groundSnowLoadPsf: "groundSnowLoad", windSpeedMph: "windSpeed", windExposure: "windExposure", seismicDesignCategory: "seismicDesignCategory", frostDepthIn: "frostDepth",
};

/**
 * EVERY CHECKLIST ITEM, EXPLICITLY (pure). A value on the row is found — or weak_source when its
 * lookup citation is flagged (a project-type handout). A missing one is not_found ONLY when the half
 * that asks for it ran web-grounded and complete; otherwise it is not_researched (no API key, a
 * failed or truncated lookup, a lookup that never ran) — "we looked and it isn't published" and "we
 * never looked" are different answers for the operator.
 * `research` null = the criteria lookup did not run; `placementRan` = the placement lookup ran grounded.
 */
export function buildDesignCriteriaChecklist(
  profile: Pick<JurisdictionCodeProfile, "designCriteria" | "fireSetbacks" | "amendments" | "citations"> | null,
  research: DesignCriteriaResearchResult | null,
  placementRan: boolean,
  at: string = nowIso(),
): DesignCriteriaLookupRecord {
  const dc = (profile?.designCriteria ?? {}) as Record<string, unknown>;
  const cites = profile?.citations ?? [];
  const lookupComplete = !!research && research.provider !== "stub" && research.webGrounded && !research.truncated;
  const whyNot = !research ? "the design-criteria lookup did not run"
    : research.provider === "stub" ? "no LLM configured"
      : !research.webGrounded ? "the lookup was not web-grounded"
        : "the lookup was cut off before it finished";
  const items = DESIGN_CRITERIA_CHECKLIST.map((item): DesignCriteriaLookupRecord["items"][number] => {
    const fields = CHECKLIST_FIELDS[item];
    if (fields) {
      const field = fields.find((f) => dc[f] !== undefined && dc[f] !== null && dc[f] !== "");
      if (field) {
        const c = cites.filter((x) => x && x.field === `designCriteria.${field}`).pop();
        if (c?.weakSource) return { item, status: "weak_source", ...(c.sourceUrl ? { sourceUrl: c.sourceUrl } : {}), note: c.weakSource };
        return { item, status: "found", ...(c?.sourceUrl ? { sourceUrl: c.sourceUrl } : {}) };
      }
      // Published only per site (an elevation-banded table, an address lookup): a page for a person.
      const site = research?.webGrounded ? (research.siteSpecific ?? []).find((x) => SITE_SPECIFIC_ITEM[x.criterion] === item) : undefined;
      if (site) return { item, status: "site_specific", sourceUrl: site.sourceUrl, note: site.note || "published per site (elevation band / address lookup), not one jurisdiction-wide value" };
      return lookupComplete ? { item, status: "not_found", note: "no jurisdiction-wide value found on an official page" } : { item, status: "not_researched", note: whyNot };
    }
    const have = item === "fireSetbacks" ? (profile?.fireSetbacks ?? []).length > 0 : (profile?.amendments ?? []).length > 0;
    if (have) return { item, status: "found" };
    return placementRan ? { item, status: "not_found", note: "no cited rule found on the AHJ's own pages" } : { item, status: "not_researched", note: "the placement-rules lookup did not run or was not web-grounded" };
  });
  return { at, items };
}

/** Store the checklist on the AHJ's own EXISTING row, as seeded — never a human-verified row
 *  (resolveCriteriaWriteRow), and never a new row created only to say "nothing found" (an empty AHJ
 *  row would read as researched; the job result carries the checklist either way). */
export function saveDesignCriteriaLookupRecord(db: AppDb, target: { state: string; ahj: string }, record: DesignCriteriaLookupRecord): boolean {
  const row = resolveCriteriaWriteRow(db, target.state, target.ahj);
  if (!row || row.kind === "blocked_verified" || row.kind === "create") return false;
  upsert(db, { ...row.profile, designCriteriaLookup: record }, { confidence: "seeded" });
  return true;
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
  // The job row dedupes from here on (a complete lookup backs off 30 days; an incomplete or FAILED
  // one is retried after DESIGN_RESEARCH_RETRY_MS) — this process's own marker would hold a retry for
  // the whole window. Cleared however the job ends: a lookup that THROWS (#38) used to leave it set,
  // so the gate read "retrying" while ensureDesignCriteriaResearched queued nothing until a restart.
  let mergedKey: string | undefined;
  try {
    return await designCriteriaResearchBody(db, state, ahj, profileKey, provider, (k) => { mergedKey = k; });
  } finally {
    if (mergedKey) inFlightDesignResearch.delete(mergedKey);
    if (profileKey) inFlightDesignResearch.delete(profileKey);
  }
}

async function designCriteriaResearchBody(
  db: AppDb, state: string, ahj: string, profileKey: string | undefined, provider: LLMProvider | undefined,
  onMerged: (key: string) => void,
): Promise<Record<string, unknown>> {
  const llm = provider ?? (await import("./llm")).createLLMProvider();
  // THE AHJ'S OWN PLACEMENT RULES ride the same job (it runs for every AHJ, a uniform-state one
  // included — Waltham's access-path rule is Waltham's, whatever Massachusetts adopts). Best effort:
  // a failed lookup never fails the criteria half.
  const placementHalf = async (): Promise<Record<string, unknown>> => {
    try {
      const row = resolveCriteriaWriteRow(db, state, ahj);
      if (!row || row.kind === "blocked_verified") return { skipped: "no writable row" };
      if (row.kind !== "create" && row.profile.fireSetbacks.length) return { skipped: "placement rules already on file" };
      if (!llm.webLookup) return { skipped: "no web lookup available" };
      const { researchPlacementRules } = await import("./pvPlacementRules");
      const found = await researchPlacementRules(llm, { ahj, state });
      const saved = saveResearchedPlacementRules(db, { state, ahj }, found.rules);
      return { ...saved, found: found.rules.length, webGrounded: found.webGrounded, ...(found.dropped.length ? { dropped: found.dropped.slice(0, 6) } : {}), ...(found.error ? { error: found.error.slice(0, 300) } : {}) };
    } catch (err) {
      return { error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) };
    }
  };
  const own = resolveCriteriaWriteRow(db, state, ahj);
  const dcNow = own && own.kind !== "create" ? own.profile.designCriteria ?? {} : {};
  const criteriaAnswered = (typeof dcNow.groundSnowLoadPsf === "number" || typeof dcNow.groundSnowLoadAsdPsf === "number") && typeof dcNow.windSpeedMph === "number";
  // EVERY CHECKLIST ITEM IS RECORDED (found / weak source / not found / not researched) on the row
  // and in the job result, so a criterion nobody found is a visible gap, never a silent pass.
  const checklist = (research: DesignCriteriaResearchResult | null, placement: Record<string, unknown>): DesignCriteriaLookupRecord => {
    const row = resolveCriteriaWriteRow(db, state, ahj);
    const record = buildDesignCriteriaChecklist(row && row.kind !== "create" ? row.profile : null, research,
      placement.webGrounded === true && !placement.error);
    saveDesignCriteriaLookupRecord(db, { state, ahj }, record);
    return record;
  };
  if (criteriaAnswered || !llm.researchDesignCriteria) {
    const placement = await placementHalf();
    return { saved: false, reason: criteriaAnswered ? "design criteria already on file" : "provider has no design-criteria lookup", placement, checklist: checklist(null, placement).items };
  }
  const research = await llm.researchDesignCriteria({ state, ahj });
  const merged = mergeResearchedDesignCriteria(db, { state, ahj, profileKey }, research);
  onMerged(merged.profileKey);
  const placement = await placementHalf();
  // The lookup's own notes (truncated, pages read, what was dropped and why) reach the job result.
  return {
    ...merged, webGrounded: research.webGrounded, ...(research.truncated ? { truncated: true } : {}),
    found: research.values?.length ?? 0, notes: String(research.notes || "").slice(0, 1000), placement, checklist: checklist(research, placement).items,
  };
}
