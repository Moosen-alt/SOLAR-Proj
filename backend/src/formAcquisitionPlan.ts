// WHAT STAGE ACQUIRES BEFORE IT COUNTS — read BEFORE Stage runs (gates-proper C1).
//
// prepareSubmission acquires the official forms a permit filing owes (prepareOfficialDocuments:
// the issuing agency's curated seed, a cited agency PDF, the AHJ's own curated seed / the Oregon
// BCD 5952, and paid research when the 24h cooldown is open), fills them, and only THEN counts the
// required documents for its 409. The pre-Stage readers (the submit gate, the Stage button, the
// banner) counted before that acquisition: Jules Testperson's Marion County B-01S / E-01 — curated,
// hash-locked seeds Stage downloads in 1.5 s — held staging as "Attach or split out the missing
// document(s)", and the operator bypassed the gate to stage.
//
// This module is the ONE answer to "will Stage get this form itself?", shared by the acquisition
// (ahjFormAuto / prepareOfficialDocuments) and the gate (requiredDocuments.owedMissingDocuments):
//   - the pre-fetch decision for an issuing agency's application (issuingAgencyFormPlan) — the same
//     steps ensureIssuingAgencyForm takes before it downloads anything;
//   - the AHJ's own free source (ownFreeFormSource — a curated seed or the BCD 5952);
//   - the cooldown / research switch (stageAcquisitionFor), read WITHOUT writing: a read path that
//     created the cooldown table would break "reads write nothing" (nextStep.test);
//   - the in-process record of recently failed downloads (go gently), moved here from ahjFormAuto so
//     both sides read the same map.
// It downloads nothing and calls no model. A LEAF for requiredDocuments: nothing here imports it.
import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { documentFetchDisabled } from "./documentFetch";
import { loadStoredTemplates, storedApplicationKind } from "./ahjForms";
import { findApplicationProfile, permitStructureForProject } from "./applicationDocs";
import {
  agencyApplicationForms, agencyRowAppliesToJob, agencyRowProvenance, anchorSitesOnce, applicationKindForPath, formAuthorityFor, localReviewSlotTypes,
  rowBelongsToAuthority, stateIssuerKeepsGenericSlot, TRACK_FORM_TYPES, type AgencyApplicationForm, type FormAuthority,
} from "./applicationDocsAgency";
import { curatedFormSource, curatedFormSourcesFor } from "./curatedAhjForms";

type CuratedSource = ReturnType<typeof curatedFormSourcesFor>[number];
import { resolvePermitPath } from "./permitPath";
import { servedByStateIssuer, stateIssuerFormsFor, stateRulesFor, stateTradeIssuerFor } from "./permitProcess";
import { sameAgencyName } from "./agencyName";

export interface EnsureFormResult {
  status: "exists" | "acquired" | "needs_manual" | "not_found";
  message: string;
  formName?: string;
  sourceUrl?: string;
  mappedFields?: number;
  /** Human callout of the permit TYPE for this AHJ (combo vs separate BLD/ELE, submission method). */
  permitType?: string;
  /** TRUE when the form SEARCH could not run (llm.findAhjFormUrl lookupFailed: an abort, a timeout,
   *  unparseable output) and nothing else produced the form — "we could not look", never "this AHJ
   *  has no form". Stage shortens its 24h cooldown claim to a short back-off on it
   *  (prepareOfficialDocuments.LOOKUP_FAILED_RETRY_MS — never to zero). */
  lookupFailed?: boolean;
  /** Set when the search ran out of its budget (issue #163): the budget, how many pages it had seen,
   *  and the leads it had gathered (their URLs) — the not-found detail, never a bare abort. */
  searchTimeout?: FormSearchTimeout;
}

// ── Timed-out form searches (bounded, never re-run blind) ─────────────────────────────────
// A form search that ran out of its 240 s budget (issue #163: an Oregon county, 240,012 ms, then a
// 385 s request that returned nothing actionable) is NOT re-run with the same query in the same pass
// — the next form type of that pass would spend another four minutes on the same broad search. The
// attempt is recorded per AHJ so the NEXT trigger's search is told it timed out and to take the
// state-scoped / served-city path instead (issue #162). In-process (a restart forgets it — at most
// one more broad search); a search that completes clears it.
export interface FormSearchTimeout { at: number; budgetMs: number; pagesSeen: number; leads: string[] }
export const FORM_SEARCH_TIMEOUT_MEMORY_MS = 24 * 60 * 60 * 1000;
const formSearchTimeouts = new Map<string, FormSearchTimeout>();
const formSearchKey = (ahj: string, state: string): string => `${String(state || "").trim().toUpperCase()}|${String(ahj || "").trim().toLowerCase()}`;
export function noteFormSearchTimeout(ahj: string, state: string, t: FormSearchTimeout): void {
  formSearchTimeouts.set(formSearchKey(ahj, state), t);
}
export function clearFormSearchTimeout(ahj: string, state: string): void {
  formSearchTimeouts.delete(formSearchKey(ahj, state));
}
/** The last timed-out search for this AHJ within FORM_SEARCH_TIMEOUT_MEMORY_MS, else null. */
export function recentFormSearchTimeout(ahj: string, state: string): FormSearchTimeout | null {
  const t = formSearchTimeouts.get(formSearchKey(ahj, state));
  if (!t || Date.now() - t.at >= FORM_SEARCH_TIMEOUT_MEMORY_MS) return null;
  return t;
}

// ── Recently failed downloads (go gently) ─────────────────────────────────────────────────
// A curated / cited / checklist URL whose download failed is not fetched again for 6 hours by Stage's
// pass inside the cooldown (every Stage re-fetching a walled URL could open a headed browser each
// time). Per URL, not per AHJ; in-process (a restart forgets it — at most one extra fetch). A success
// clears the URL. The operator's explicit "Find missing official forms" never consults it.
export const FORM_FETCH_RETRY_MS = 6 * 60 * 60 * 1000;
const recentFormFetchFailures = new Map<string, number>();
export function noteFormFetchFailure(url: string): void {
  // Nothing was sent with downloads switched off — that is not a failure of the URL.
  if (documentFetchDisabled()) return;
  const now = Date.now();
  for (const [u, at] of recentFormFetchFailures) if (now - at >= FORM_FETCH_RETRY_MS) recentFormFetchFailures.delete(u);
  recentFormFetchFailures.set(url, now);
}
export function clearFormFetchFailure(url: string): void {
  recentFormFetchFailures.delete(url);
}
/** "tried <when>, retry after <when>" when `url` failed within FORM_FETCH_RETRY_MS, else null. */
export function recentFormFetchFailure(url: string): string | null {
  const at = recentFormFetchFailures.get(url);
  if (at == null || Date.now() - at >= FORM_FETCH_RETRY_MS) return null;
  const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `tried ${when(at)}, retry after ${when(at + FORM_FETCH_RETRY_MS)}`;
}

// ── The cooldown and the research switch ────────────────────────────────────────────────
export const FORM_ACQUISITION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** The shared AHJ/path cooldown key (ahj_form_acquisition_attempts.scope_key). */
export function acquisitionScopeKey(project: Pick<ProjectRecord, "state" | "ahj">, permitPath: string): string {
  return `${project.state}|${project.ahj}|${permitPath}`.trim().toLowerCase();
}
/** Form downloads at all (AHJ_FORM_DOWNLOADS=off stops every acquisition). */
export function formDownloadsOn(): boolean {
  return process.env.AHJ_FORM_DOWNLOADS !== "off";
}
/** May this process pay for form research / model mapping? */
export function formResearchAllowed(): boolean {
  return process.env.AHJ_FORM_RESEARCH !== "off" && Boolean(process.env.ANTHROPIC_API_KEY);
}
/** Is the 24h cooldown open for this key? READ-ONLY: no table yet means never attempted (open). */
export function acquisitionCooldownOpen(db: AppDb, key: string): boolean {
  const table = db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ahj_form_acquisition_attempts'");
  if (!table) return true;
  const prior = db.get<{ attempted_at: number }>("SELECT attempted_at FROM ahj_form_acquisition_attempts WHERE scope_key = ?", [key]);
  return !prior || Date.now() - Number(prior.attempted_at) >= FORM_ACQUISITION_COOLDOWN_MS;
}

// ── The form research pass in flight (single flight) ────────────────────────────────────
// ONE search per AHJ/path at a time, and every door knows it is running. The chain's automatic
// pass claims the 24h cooldown BEFORE it awaits (so retries / simultaneous projects do not amplify
// paid research) — and from that instant the gate read "research closed" and told the operator to
// "find the official form (App Docs → Find missing official forms) or upload the blank" while the
// search it named was in flight (City of Beaverton, 2026-09-28: the operator clicked Find twice, and
// three passes — six searches, 727 s of model time — ran at once, all writing the same KB profile).
// The claim cannot distinguish "claimed, search in flight" from "claimed, search finished"; this
// registry can. In-process, like recentFormFetchFailures: the job worker and the routes share the
// process, and a restart forgets an entry that no longer exists anyway.
//   - ensureAhjFormsForProject REGISTERS a research pass here (same tick as the claim, before its
//     first await) and JOINS one already in flight instead of starting another;
//   - stageAcquiresForm reports the form as acquired-at-staging with `inFlight` while the key is
//     present, so the gate / App Docs / QC say "Stage is searching for it now — started HH:MM",
//     never "find it or upload the blank".
export interface FormResearchInFlight {
  /** ISO time the pass started. */
  since: string;
  /** The project whose pass this is (a joiner for the same project takes its result verbatim). */
  projectId: string;
  promise: Promise<unknown>;
}
const researchInFlight = new Map<string, FormResearchInFlight>();
/** The research pass running for this scope key, or null. */
export function formResearchInFlight(key: string): FormResearchInFlight | null {
  return researchInFlight.get(key) ?? null;
}
/** Register a research pass for `key` until `promise` settles (either way). Synchronous: call it
 *  in the same tick as the cooldown claim so no gate read sees "claimed but not in flight". */
export function trackFormResearch(key: string, projectId: string, promise: Promise<unknown>): FormResearchInFlight {
  const entry: FormResearchInFlight = { since: new Date().toISOString(), projectId, promise };
  researchInFlight.set(key, entry);
  const clear = (): void => { if (researchInFlight.get(key) === entry) researchInFlight.delete(key); };
  void promise.then(clear, clear);
  return entry;
}
/** "started HH:MM UTC" for an in-flight pass (the operator's clock is the server's, in UTC). */
export function startedAtLabel(sinceIso: string): string {
  const d = new Date(sinceIso);
  return Number.isNaN(d.getTime()) ? "started just now" : `started ${d.toISOString().slice(11, 16)} UTC`;
}

export interface StageAcquisition {
  path: "prescriptive" | "engineered" | "unknown";
  /** Stage acquires anything at all (a confirmed path, downloads on). */
  acquires: boolean;
  /** The model may map a cited PDF (and research, when the cooldown is open). */
  research: boolean;
  /** Paid research runs on the next Stage (the cooldown is open and research is allowed). */
  researchOpen: boolean;
}
/** What the next Stage's acquisition pass will be allowed to do for this project — the switches
 *  prepareOfficialDocuments reads, without claiming the cooldown. */
export function stageAcquisitionFor(db: AppDb, project: ProjectRecord): StageAcquisition {
  const path = resolvePermitPath(project).path;
  const acquires = path !== "unknown" && formDownloadsOn() && !documentFetchDisabled();
  const research = formResearchAllowed();
  return { path, acquires, research, researchOpen: acquires && research && acquisitionCooldownOpen(db, acquisitionScopeKey(project, path)) };
}

// ── The AHJ's own free source ───────────────────────────────────────────────────────────
export const BCD_5952_URL = "https://www.oregon.gov/bcd/Formslibrary/5952.pdf";

/** WHICH of the two building-side applications a form search is for — and NONE where the split does
 *  not exist (resolvePermitPath's standardReview: one building application). */
export function applicationKindForProject(project: ProjectRecord): "prescriptive" | "structural" | null {
  const res = resolvePermitPath(project);
  if (res.standardReview) return null;
  return applicationKindForPath(res.path);
}

/** A free, model-free download for the AHJ's OWN form: its curated seed (hash-locked map), or the
 *  Oregon BCD 5952 checklist on the prescriptive path. null = none (research or an upload is needed). */
export function ownFreeFormSource(project: ProjectRecord, formType: string, applicationKind: "prescriptive" | "structural" | null): { url: string; formName: string; curated: CuratedSource | null } | null {
  const curated = curatedFormSource(project, formType, applicationKind);
  if (curated) return { url: curated.url, formName: curated.formName, curated };
  if (formType === "solar_checklist") return statewideChecklistSource(project);
  const statewide = statewideApplicationSource(project, formType, applicationKind);
  return statewide ? { url: statewide.url, formName: statewide.formName, curated: statewide } : null;
}

/** A SERVED CITY'S BUILDING APPLICATION is the statewide portal's (Oregon ePermitting, issue #171):
 *  the catalog's blank filed under the portal's name, when the catalog holds one. null = none held
 *  (servedJurisdictionForms then answers the slot with the issuer named — never a search). */
export function statewideApplicationSource(project: ProjectRecord, formType: string, applicationKind: "prescriptive" | "structural" | null): CuratedSource | null {
  if (formType !== "building_application" && formType !== "permit_application") return null;
  const portal = stateRulesFor(project.state).statewidePortalName;
  if (!portal) return null;
  let served: ReturnType<typeof servedByStateIssuer> = null;
  try { served = servedByStateIssuer(project); } catch { served = null; }
  return served ? curatedFormSource({ ahj: portal, state: project.state }, formType, applicationKind) ?? null : null;
}

/** The STATE's own checklist for this project's path, filed wherever the job is in the state: the Oregon
 *  BCD 5952 on the prescriptive path. null = none. */
export function statewideChecklistSource(project: ProjectRecord): { url: string; formName: string; curated: null } | null {
  const checklist = String(project.state ?? "").toUpperCase() === "OR" && resolvePermitPath(project).path === "prescriptive";
  return checklist ? { url: BCD_5952_URL, formName: "Oregon BCD 5952", curated: null } : null;
}

/**
 * A SERVED JURISDICTION'S FORM IS NOT SEARCHED FOR UNDER ITS NAME (issue #162). Where a source says
 * the AHJ does not run its own building program (permitProcess.servedByStateIssuer — a state issuer
 * rule, or the lookup's / a person's cited buildingProgram "state"), a paid search for "<AHJ> building
 * permit application" finds nothing of the AHJ's and, on a common name, spends itself on same-named
 * places in other states (City of Monroe, Oregon: three searches, all Monroe MI / CT / OH). The state's
 * own forms are attached instead (statewideChecklistSource; a state issuer's per-track applications
 * travel through formAuthorityFor / issuingAgencyFormPlan as before), and the slot says whose form it
 * is. Not for a state issuer's GENERIC slot: that is the AHJ's own local-review application
 * (stateIssuerKeepsGenericSlot), which is the AHJ's to publish and is still searched for.
 * null = searched as before.
 */
export function servedJurisdictionForms(project: ProjectRecord, formType: string): { agency: string; sourceUrl: string; checklist: { url: string; formName: string } | null; message: string } | null {
  if (formType === "permit_application" && stateIssuerKeepsGenericSlot(project)) return null;
  // A state issuer's served village publishes its OWN solar checklist as it does its zoning form (the
  // local step is the village's): still searched, unless a statewide checklist covers it (#171).
  if (formType === "solar_checklist" && !statewideChecklistSource(project)) {
    let local = null;
    try { local = stateTradeIssuerFor(project); } catch { local = null; }
    if (local) return null;
  }
  let served: ReturnType<typeof servedByStateIssuer> = null;
  try { served = servedByStateIssuer(project); } catch { served = null; }
  if (!served) return null;
  let checklist: { url: string; formName: string } | null = null;
  try { checklist = statewideChecklistSource(project); } catch { checklist = null; }
  const agency = served.agency || "the state building agency";
  const label = formType.replace(/_/g, " ");
  const cite = served.sourceUrl ? ` (cited: ${served.sourceUrl})` : "";
  const portal = formType === "building_application" || formType === "permit_application" ? stateRulesFor(project.state).statewidePortalName : "";
  const message = formType === "solar_checklist" && checklist
    ? ""
    : `${project.ahj} does not run its own building program — ${agency} issues its permits${cite}. No ${label} was searched for under ${project.ahj}'s name.`
      + `${checklist ? ` The statewide ${checklist.formName} is attached on its own row.` : ""}`
      + `${portal ? ` No statewide ${portal} ${label} is in the form catalog.` : ""}`
      + ` Upload ${served.agency || "the issuing agency"}'s ${label} blank (Find official form → upload); it has not been counted as present.`;
  return { agency, sourceUrl: served.sourceUrl, checklist, message };
}

// WHICH STORED FORM TYPES SATISFY A SLOT — the one answer the pre-Stage gate and Stage's acquisition
// read. A building-side row also accepts the generic application blank (requiredDocuments'
// altDocTypes); the GENERIC slot accepts the building blank it was re-typed to (storeAhjFormTemplate's
// classifyFormType) unless the AHJ files SEPARATE permits — without that, a harvested "Building Permit
// Application" never satisfied the generic slot and every pass paid for a search again (forms-find
// skeptic). The electrical slot accepts only its own type.
export function acceptedFormTypes(formType: string, structure: "separate" | "combo" | "unknown" = "unknown"): string[] {
  if (formType === "building_application") return ["building_application", "permit_application"];
  if (formType === "permit_application" && structure !== "separate") return ["permit_application", "building_application"];
  return [formType];
}
/** acceptedFormTypes for this project's permit structure (unknown when it cannot be read). */
export function acceptedFormTypesFor(project: ProjectRecord, formType: string): string[] {
  let structure: "separate" | "combo" | "unknown" = "unknown";
  if (formType === "permit_application") {
    // A state issuer's project: the generic slot is the AHJ's local review application, held under
    // whatever type the AHJ's own blank was stored as (applicationDocsAgency.applicationSlotFor) —
    // hasStoredTemplateOfType reads the AHJ's own rows only, so an issuer's form never counts here.
    const local = localReviewSlotTypes(project);
    if (local.length) return local;
    try { structure = permitStructureForProject(project); } catch { /* unknown */ }
  }
  return acceptedFormTypes(formType, structure);
}

// Is a stored template of this form type held for the AHJ (fuzzy name, same state, kind-compatible)?
// A row that makes no kind claim counts for either path: a jurisdiction with one generic application
// genuinely has what both paths need.
export function hasStoredTemplateOfType(
  db: AppDb,
  ahj: string,
  state: string,
  formType: string,
  applicationKind?: "prescriptive" | "structural" | null,
): boolean {
  const needle = (ahj || "").trim().toLowerCase();
  if (!needle) return false;
  const rows = db.query<{ ahj_name: string; state: string; original_filename?: string; field_map?: string }>(
    "SELECT ahj_name, state, original_filename, field_map FROM ahj_form_templates WHERE pdf_blob IS NOT NULL AND form_type = ?",
    [formType],
  );
  return rows.some((row) => {
    const rowAhj = String(row.ahj_name || "").trim().toLowerCase();
    const stateOk = !row.state || !state || String(row.state).toLowerCase() === String(state).toLowerCase();
    if (!rowAhj || !stateOk || !(rowAhj === needle || needle.includes(rowAhj) || rowAhj.includes(needle))) return false;
    if (!applicationKind) return true;
    const rowKind = storedApplicationKind(row);
    return !rowKind || rowKind === applicationKind;
  });
}

// ── The issuing agency's application: the steps before any download ─────────────────────
export interface IssuingAgencyPlan {
  agency: string;
  label: string;
  whose: string;
  want: "prescriptive" | "structural" | null;
  /** An answer reached with no download: held (exists / not fillable) or nothing seeded or cited. */
  settled: EnsureFormResult | null;
  /** The candidates in the order ensureIssuingAgencyForm tries them, each with its pre-fetch verdict:
   *  `stop` ends the pass with that answer; `skip` moves to the next (the reason goes in `tried`);
   *  neither = the one it downloads next. */
  steps: Array<{ c: AgencyApplicationForm; stop?: EnsureFormResult; skip?: string }>;
}

/**
 * THE ISSUING AGENCY'S APPLICATION, UP TO THE DOWNLOAD — the pre-fetch half of
 * ahjFormAuto.ensureIssuingAgencyForm, which executes this plan (and the gate reads it):
 *   1. already held for the agency, for THIS job (kind-compatible, agency-contain C1) -> exists, or
 *      needs_manual when not fillable;
 *   2. nothing seeded or cited -> not_found;
 *   3. per candidate (the curated seed first): a cited PDF whose slot already holds a form this job's
 *      lookup does not cite -> stop (a cited form never replaces a stored one); a URL that failed
 *      recently, when the caller skips those -> a curated seed stops (C2: no cited PDF in its place),
 *      a cited one is skipped.
 */
export function issuingAgencyFormPlan(
  db: AppDb,
  project: ProjectRecord,
  formType: string,
  authority: FormAuthority,
  applicationKind: "prescriptive" | "structural" | null,
  opts: { skipRecentlyFailed?: boolean } = {},
): IssuingAgencyPlan {
  const agency = authority.name;
  const track = authority.track;
  const want = track === "building" ? applicationKind : null;
  const types = track ? TRACK_FORM_TYPES[track] : [formType];
  const label = track === "electrical" ? "electrical permit application" : `${want === "prescriptive" ? "prescriptive solar " : want === "structural" ? "structural (non-prescriptive) " : ""}permit application`;
  const cite = authority.fact?.sourceUrl ? ` (per-job lookup, cited: ${authority.fact.sourceUrl})` : "";
  const whose = `${agency} issues this permit for ${project.ahj}${cite}`;
  const base = { agency, label, whose, want };
  // "Already held" means held FOR THIS JOB (agency-contain C1): a row another city's lookup attributed to
  // the agency, on a site this job's lookup does not anchor, is not this job's form — so it neither
  // answers "exists" nor stops the agency's curated seed / this job's own cited form being fetched.
  const anchors = anchorSitesOnce(project, agency);
  const agencyRows = db.query<{ id: string; ahj_name: string; state: string; form_type: string; original_filename?: string; field_map?: string; source_url?: string }>(
    "SELECT id, ahj_name, state, form_type, original_filename, field_map, source_url FROM ahj_form_templates WHERE pdf_blob IS NOT NULL",
  ).filter((r) => types.includes(String(r.form_type)) && (!r.state || String(r.state).toLowerCase() === String(project.state).toLowerCase())
    && rowBelongsToAuthority(r.ahj_name, agency) && (!want || !storedApplicationKind(r) || storedApplicationKind(r) === want));
  const held = agencyRows.filter((r) => agencyRowAppliesToJob(project, agency, agencyRowProvenance(r), anchors));
  // THE SLOT IS SHARED, THE VERDICT IS NOT (agency-contain skeptic MF-1): a stored row this job's
  // lookup does not anchor still occupies the agency's one slot, so this job's cited PDF is not stored
  // over it. The agency's curated seed (its real form) still may be.
  const occupiedBy = agencyRows.filter((r) => !held.includes(r));
  if (held.length) {
    const usable = loadStoredTemplates(db, agency, project.state, { ownOnly: true }).some((t) => held.some((h) => h.id === t.templateId));
    return {
      ...base, steps: [],
      settled: usable
        ? { status: "exists", message: `${agency}'s own ${label} is stored — ${whose}.` }
        : { status: "needs_manual", mappedFields: 0, message: `${agency}'s own ${label} is stored but is not fillable — ${whose}. Complete it by hand and attach it; it is required and has not been filled.` },
    };
  }
  const candidates = agencyApplicationForms(project, formType, want);
  // A STATE ISSUER'S FORM is looked for on the ISSUER's forms page, never the AHJ's (issue #53): the
  // state rule names where — ONE form per track (Helm's decision on PR #64) — never a guessed URL,
  // never a search under the AHJ's name. A form filled BY HAND (#60: CID's Word documents; the filler
  // is PDF-only) is needs_manual with its seeded download — nothing is fetched or stored, and the row
  // stays owed until a person uploads the filled PDF. One with no confirmed download stays not_found.
  const stateIssuer = !candidates.length ? stateIssuerFormsFor(project) : null;
  const stateForm = stateIssuer && sameAgencyName(agency, stateIssuer.agency) && track ? stateIssuer.forms.find((f) => f.track === track) : undefined;
  if (stateForm) {
    const where = `${agency} issues the ${track} permit for ${project.ahj} (state rule, seeded — ${stateForm.sourceUrl}) on its own ${stateForm.formName}. It was looked for on ${agency}'s forms page (${stateForm.searchUrl}), not ${project.ahj}'s`;
    if (stateForm.url && stateForm.fill === "by_hand") {
      const what = stateForm.format === "docx" ? "Word document" : stateForm.format.toUpperCase();
      return { ...base, steps: [], settled: { status: "needs_manual", sourceUrl: stateForm.url, mappedFields: 0,
        message: `${where}: ${stateForm.note}. Download (${what}, ${stateForm.bytes} bytes, SHA-256 ${stateForm.sha256} when seeded): ${stateForm.url}. It is required, is not filled automatically, and has not been counted as present.` } };
    }
    return { ...base, steps: [], settled: { status: "not_found", message: `${where}: ${stateForm.note}. Upload ${agency}'s blank (Find official form → upload); it has not been counted as present.` } };
  }
  if (!candidates.length) {
    return { ...base, steps: [], settled: { status: "not_found", message: `${whose}, but no ${label} of ${agency}'s is held, seeded or cited. Upload ${agency}'s blank (Find official form → upload); it has not been counted as present.` } };
  }
  const steps: IssuingAgencyPlan["steps"] = [];
  for (const c of candidates) {
    const taken = c.origin === "cited"
      ? occupiedBy.find((r) => String(r.form_type) === c.formType
        && (c.formType !== "building_application" || !storedApplicationKind(r) || storedApplicationKind(r) === (c.applicationKind ?? want)))
      : undefined;
    if (taken) {
      let from = String(taken.source_url || "");
      try { from = from ? new URL(from).hostname : "an upload"; } catch { /* keep the raw value */ }
      steps.push({ c, stop: { status: "not_found", sourceUrl: c.sourceUrl, message: `${agency}'s ${label} slot already holds a form from ${from} that this job's lookup does not cite, so the form cited for ${project.ahj} (${c.sourceUrl}) was not stored over it. ${whose}. Check which is ${agency}'s current form and upload it (Find official form → upload); it has not been counted as present.` } });
      break;
    }
    const recent = opts.skipRecentlyFailed ? recentFormFetchFailure(c.sourceUrl) : null;
    if (recent && c.origin === "curated") {
      steps.push({ c, stop: { status: "not_found", sourceUrl: c.sourceUrl, message: `${agency}'s ${c.formName} was not fetched again from ${c.sourceUrl}: its download failed recently (${recent}) and Stage does not retry it inside the 24h cooldown. ${whose}; no other PDF was tried in its place, and it has not been counted as present. Find missing official forms retries it now.` } });
      break;
    }
    if (recent) { steps.push({ c, skip: `${c.sourceUrl} (not fetched again: ${recent})` }); continue; }
    steps.push({ c });
  }
  return { ...base, settled: null, steps };
}

// ── The look-ahead the gate reads ─────────────────────────────────────────────────────────
export interface StageAcquiredForm {
  /** How Stage gets it: a free curated / checklist download, a cited agency PDF the model maps, or
   *  a paid research pass (the cooldown is open). */
  via: "curated" | "cited" | "research";
  /** The PDF it downloads (curated / cited), else "". */
  sourceUrl: string;
  /** Whose form: the issuing agency, or the AHJ. */
  authority: string;
  /** Set when the research pass for this AHJ/path is running RIGHT NOW (formResearchInFlight):
   *  the gate says "Stage is searching for it now — started HH:MM", never "find it or upload it". */
  inFlight?: { since: string };
}

/**
 * WILL THE NEXT STAGE ACQUIRE THIS FORM ITSELF? The gate's forward read of the acquisition pass, from
 * the same steps it takes (issuingAgencyFormPlan / ownFreeFormSource / the research switch). Asked
 * only for a form NOT already held (a held one is the fill's question — requiredDocuments'
 * missingFilledAtStaging). Conservative where the pass could still come back empty:
 *   - a URL that failed in the last 6 hours is not counted (Stage may skip it; the operator's Find
 *     retries it now);
 *   - a CITED agency PDF counts only when the model may map it (unmapped, it is a hand-complete
 *     blank the fill cannot produce);
 *   - research counts only when it would actually run (key set, research on, the 24h cooldown open,
 *     and not a portal-entry-only AHJ). prepareSubmission's post-fill count still refuses, in words,
 *     when a pass comes back empty — that 409 is the hard line; this only stops the pre-Stage hold
 *     from duplicating it.
 */
export function stageAcquiresForm(
  db: AppDb,
  project: ProjectRecord,
  formType: string,
  applicationKindIn: "prescriptive" | "structural" | null | undefined,
  acq: StageAcquisition,
): StageAcquiredForm | null {
  if (!acq.acquires) return null;
  let applicationKind = applicationKindIn ?? null;
  if (!applicationKind && (formType === "building_application" || formType === "permit_application")) {
    try { applicationKind = applicationKindForProject(project); } catch { /* path optional */ }
  }
  const authority = formAuthorityFor(project, formType);
  if (authority.issuedByOther) {
    const plan = issuingAgencyFormPlan(db, project, formType, authority, applicationKind, { skipRecentlyFailed: true });
    if (plan.settled) return null; // held (the fill decides), not fillable, or nothing known
    for (const s of plan.steps) {
      if (s.stop) return null;
      if (s.skip) continue;
      if (s.c.origin === "cited" && !acq.research) return null;
      return { via: s.c.origin, sourceUrl: s.c.sourceUrl, authority: plan.agency };
    }
    return null;
  }
  // The AHJ's own form: held -> the fill decides (exists / needs_manual), never a download.
  if (acceptedFormTypesFor(project, formType).some((t) => hasStoredTemplateOfType(db, project.ahj, project.state, t, applicationKind))) return null;
  const free = ownFreeFormSource(project, formType, applicationKind);
  if (free) return recentFormFetchFailure(free.url) ? null : { via: "curated", sourceUrl: free.url, authority: project.ahj };
  // A served jurisdiction's form is never searched for under its name (servedJurisdictionForms).
  if (servedJurisdictionForms(project, formType)) return null;
  // THE SEARCH IS RUNNING NOW. Read before the cooldown switch: the pass claimed the cooldown before
  // it awaited, so `researchOpen` is false for the whole pass — this is the one reading that tells
  // "claimed, in flight" from "claimed, finished".
  const running = formResearchInFlight(acquisitionScopeKey(project, acq.path));
  if (running) return { via: "research", sourceUrl: "", authority: project.ahj, inFlight: { since: running.since } };
  if (acq.researchOpen && !findApplicationProfile(project).requiresPortalEntryOnly) return { via: "research", sourceUrl: "", authority: project.ahj };
  return null;
}
