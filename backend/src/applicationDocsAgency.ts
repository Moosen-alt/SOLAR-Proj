// ---------------------------------------------------------------------------
// WHOSE FORMS APPLY TO A PERMIT TRACK — THE ISSUING AGENCY'S.
//
// Operator finding 2026-09-27 (Michael Sheridan, City of Jefferson / Marion County / Pacific
// Power): "still only just pulling that one doc". The AHJ packet held ONLY the Oregon BCD 5952
// checklist. The per-job lookup (permit_process_lookups 'or|city of jefferson') says MARION COUNTY
// issues both permits and cites the county's B-01S prescriptive application — held as a citation
// only. Every form door keyed on project.ahj ("City of Jefferson"), so the county's applications
// were never stored, never filled, never listed.
//
// THE RULE, for any AHJ (never Marion-specific): when the lookup says permit X is issued by agency
// A and A is a DIFFERENT agency than the AHJ, the applications for X are A's — stored under A's
// name (never the city's), found for every city A issues for, and named in the packet as A's. A
// form that is not a permit application (the state checklist, a state worksheet) stays the AHJ's,
// and so does a track the AHJ issues itself. A job whose lookup names no agency is untouched.
//
// ONE predicate answers "whose forms apply to this track": formAuthorityFor. The fill loader
// (ahjForms.loadStoredTemplates), acquisition (ahjFormAuto.ensureAhjFormTemplate), the required
// set (requiredDocuments.applicationDocContext) and the packet list (applicationDocs) all read it.
//
// IMPORT DISCIPLINE: applicationDocs imports this module, and permitProcessLookup's graph reaches
// applicationDocs (feeSchedules -> knowledgeBase -> applicationDocs). Nothing here may run an import
// at module top level — functions only — so the cycle stays inert.
// ---------------------------------------------------------------------------
import type { CitedFact, ProjectRecord } from "../../shared/src/types";
import { issuingAgencyFor, permitAnswerForTrack, permitProcessFor, structureTypeMeaning } from "./permitProcess";
import { agencyNameKey, sameAgencyName } from "./permitProcessLookup";
import { DOCUMENT_URL, isOfficialAgencyHost } from "./permitPlatformCatalog";
import { curatedFormSourcesFor } from "./curatedAhjForms";
import { resolvePermitPath } from "./permitPath";

export type FormTrack = "building" | "electrical";

/** The stored form types that file under each permit track. A state checklist / worksheet is
 *  no track's application: it stays the AHJ's. */
export const TRACK_FORM_TYPES: Record<FormTrack, readonly string[]> = {
  building: ["building_application", "permit_application"],
  electrical: ["electrical_application"],
};

export function trackForFormType(formType: string): FormTrack | null {
  if (TRACK_FORM_TYPES.building.includes(formType)) return "building";
  if (TRACK_FORM_TYPES.electrical.includes(formType)) return "electrical";
  return null;
}

/** Which of the two MUTUALLY EXCLUSIVE building-side applications a permit path calls for. THE
 *  single mapping from path -> application kind (re-exported by ahjForms, where every gate reads
 *  it). "unknown" yields null: until the operator confirms the path we do not know which one the
 *  AHJ is owed. */
export function applicationKindForPath(path: "prescriptive" | "engineered" | "unknown"): "prescriptive" | "structural" | null {
  if (path === "prescriptive") return "prescriptive";
  if (path === "engineered") return "structural";
  return null;
}

/** Classify a form by which mutually-exclusive solar application it is, from its name. THE
 *  STRUCTURAL TEST RUNS FIRST: "Non-Prescriptive" contains "prescriptive". Null = the name makes no
 *  claim (a jurisdiction's one generic application), compatible with every path. (Moved here from
 *  ahjForms, which re-exports it, so this module can classify a cited PDF without importing the
 *  fill engine.) */
export function formApplicationKind(formName: string): "prescriptive" | "structural" | null {
  const n = (formName || "").toLowerCase();
  if (/structural|non[-\s]?prescriptive|engineered/.test(n)) return "structural";
  if (/prescriptive/.test(n)) return "prescriptive";
  return null;
}

export interface FormAuthority {
  /** Whose forms apply: the issuing agency's name, or the AHJ's own. */
  name: string;
  /** True only when the per-job lookup CITES a different agency as this track's issuer. */
  issuedByOther: boolean;
  track: FormTrack | null;
  /** The lookup's cited answer the authority rests on (null for the AHJ's own). */
  fact: CitedFact<string> | null;
}

const answeredCited = (f: CitedFact<string> | null | undefined, verified: boolean): f is CitedFact<string> =>
  Boolean(f && typeof f.value === "string" && f.value.trim()) && (verified || /^https?:\/\//i.test(String(f?.sourceUrl ?? "")));

/**
 * THE ONE PREDICATE: whose forms apply to this form type on this project. A building-side form
 * reads the lookup's structural permit, then a combo permit, then the AHJ-wide answer
 * (permitProcess.issuingAgencyFor); an electrical form reads the electrical permit, then the
 * AHJ-wide answer. The agency counts only when CITED (or the lookup is verified by a person) and
 * only when permitProcessLookup.sameAgencyName says it is not the AHJ itself ("City of Salem
 * Permit Center" is Salem; "Marion County" is not the City of Jefferson).
 */
export function formAuthorityFor(project: Pick<ProjectRecord, "state" | "ahj">, formType: string): FormAuthority {
  const ahj = String(project?.ahj ?? "").trim();
  const track = trackForFormType(formType);
  const own: FormAuthority = { name: ahj, issuedByOther: false, track, fact: null };
  if (!track || !ahj || !String(project?.state ?? "").trim()) return own;
  let fact: CitedFact<string> | null = null;
  try {
    const verified = permitProcessFor(project)?.confidence === "verified";
    const tries = track === "building" ? ["building", "combo"] : ["electrical"];
    for (const t of tries) {
      const f = t === "combo" ? permitAnswerForTrack(project, "combo")?.issuingAgency ?? null : issuingAgencyFor(project, t);
      if (answeredCited(f, verified)) { fact = f; break; }
    }
  } catch { fact = null; }
  const agency = String(fact?.value ?? "").trim();
  if (!fact || !agency || sameAgencyName(agency, ahj)) return { ...own, fact };
  return { name: agency, issuedByOther: true, track, fact };
}

/** Is a stored row (its ahj_name) THIS authority's? Exact identity key — never the loader's
 *  name-containment test, which would hand "Jefferson County" rows to "City of Jefferson". */
export function rowBelongsToAuthority(rowAhjName: string, authorityName: string): boolean {
  const a = agencyNameKey(rowAhjName);
  return Boolean(a) && a === agencyNameKey(authorityName);
}

/** The tracks another agency issues for this project, with that authority. */
export function tracksIssuedByOther(project: Pick<ProjectRecord, "state" | "ahj">): Array<FormAuthority & { track: FormTrack }> {
  const out: Array<FormAuthority & { track: FormTrack }> = [];
  for (const track of ["building", "electrical"] as const) {
    const a = formAuthorityFor(project, TRACK_FORM_TYPES[track][0]);
    if (a.issuedByOther) out.push({ ...a, track });
  }
  return out;
}

// ── The agency's own applications, by name ─────────────────────────────────────────────────
export interface AgencyApplicationForm {
  formName: string;
  sourceUrl: string;
  formType: string;
  applicationKind: "prescriptive" | "structural" | null;
  /** "curated": a hash-locked public form seed; "cited": a PDF the per-job lookup cited. */
  origin: "curated" | "cited";
}

const kindFits = (kind: "prescriptive" | "structural" | null, want: "prescriptive" | "structural" | null): boolean =>
  !want || !kind || kind === want;

function fileNameOf(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || ""); } catch { return ""; }
}

/** Does a cited document's own file name say it is THIS track's application? A fee schedule,
 *  checklist, brochure or handout is never an application; a building-side one names solar /
 *  photovoltaic (or building / structural) and not electrical; an electrical one names electrical
 *  or renewable energy. */
export function citedNameFitsTrack(name: string, track: FormTrack): boolean {
  const n = String(name || "").toLowerCase();
  if (!/application|permit/.test(n) || /fee|schedule|checklist|brochure|handout|guide|instruction|worksheet/.test(n)) return false;
  const electrical = /electric|renewable\s*energy/.test(n);
  if (track === "electrical") return electrical;
  return !electrical && /solar|photo-?voltaic|\bpv\b|building|structural/.test(n);
}

/** The application PDFs the per-job lookup CITES for this track's permit: any source URL on that
 *  permit's answers (and the AHJ-wide agency answer) that is a document on the agency's own
 *  official host and whose file name names this track's application. */
export function citedAgencyApplicationUrls(project: Pick<ProjectRecord, "state" | "ahj">, authority: FormAuthority): string[] {
  if (!authority.issuedByOther || !authority.track) return [];
  const lk = permitProcessFor(project);
  if (!lk) return [];
  const permits = (lk.permits ?? []).filter((p) => authority.track === "electrical" ? p.discipline === "electrical" : p.discipline === "structural" || p.discipline === "combo");
  const urls: string[] = [];
  const consider = (u: unknown): void => {
    const url = String(u ?? "").trim();
    if (!/^https?:\/\//i.test(url) || !DOCUMENT_URL.test(url) || urls.includes(url)) return;
    let host = "";
    try { host = new URL(url).hostname; } catch { return; }
    if (!isOfficialAgencyHost(host, [authority.name], project.state)) return;
    if (!citedNameFitsTrack(fileNameOf(url), authority.track!)) return;
    urls.push(url);
  };
  for (const p of permits) {
    for (const f of [p.issuingAgency, p.documents, p.fee, p.recordType, p.portalUrl]) consider(f?.sourceUrl);
    for (const d of p.documents?.value ?? []) consider(d);
  }
  consider(lk.issuingAgency?.sourceUrl);
  return urls;
}

/** The agency's applications for this form type that we know BY NAME — a curated public seed
 *  first, then a PDF the lookup cited — narrowed to the path's application kind. */
export function agencyApplicationForms(
  project: Pick<ProjectRecord, "state" | "ahj">,
  formType: string,
  want: "prescriptive" | "structural" | null,
): AgencyApplicationForm[] {
  const authority = formAuthorityFor(project, formType);
  if (!authority.issuedByOther || !authority.track) return [];
  const out: AgencyApplicationForm[] = [];
  for (const s of curatedFormSourcesFor(authority.name, project.state)) {
    if (trackForFormType(s.formType) !== authority.track) continue;
    const kind = ("applicationKind" in s ? (s.applicationKind as "prescriptive" | "structural") : null) ?? formApplicationKind(s.formName);
    if (!kindFits(kind, authority.track === "building" ? want : null)) continue;
    out.push({ formName: s.formName, sourceUrl: s.url, formType: s.formType, applicationKind: kind, origin: "curated" });
  }
  for (const url of citedAgencyApplicationUrls(project, authority)) {
    if (out.some((o) => o.sourceUrl === url)) continue;
    const name = fileNameOf(url).replace(/\.pdf$/i, "").replace(/\s*fill+e?able\s*$/i, "").trim();
    const kind = formApplicationKind(name);
    if (!kindFits(kind, authority.track === "building" ? want : null)) continue;
    out.push({ formName: name, sourceUrl: url, formType: authority.track === "electrical" ? "electrical_application" : "building_application", applicationKind: kind, origin: "cited" });
  }
  return out;
}

// ── The job's own required list, when another agency issues its permits ───────────────────
export interface AgencyListItem {
  text: string;
  /** The document slot(s) that hold it; [] for a step at another office. */
  docTypes: string[];
  role: "application" | "checklist" | "prerequisite";
  track?: FormTrack;
  sourceUrl: string;
}
export interface AgencyDocumentList {
  agencies: string[];
  sourceUrl: string;
  items: AgencyListItem[];
}

/** A step at the CITY's office before the county takes the application: the lookup's cited
 *  prerequisites, else — where a COUNTY issues for a CITY — the zoning approval every such county
 *  application asks the city for, with the lookup's own words when one of its quotes says so. */
export function cityPrerequisiteFor(project: Pick<ProjectRecord, "state" | "ahj">): { text: string; sourceUrl: string; quote: string } | null {
  const lk = permitProcessFor(project);
  const ahj = String(project.ahj ?? "").trim();
  const cited = (lk?.prerequisites ?? []).find((p) => typeof p?.value === "string" && p.value.trim() && /^https?:\/\//i.test(String(p.sourceUrl || "")) && String(p.quote || "").trim().length >= 8);
  if (cited) return { text: `${ahj} first: ${String(cited.value).trim()}`, sourceUrl: String(cited.sourceUrl), quote: String(cited.quote).trim() };
  const others = tracksIssuedByOther(project);
  const county = others.find((o) => /\bcounty\b/i.test(o.name));
  if (!county || !/^(city|town|village) of\b/i.test(ahj)) return null;
  // Display selection only (which of the lookup's own cited quotes to show beside the step).
  const facts = [lk?.issuingAgency, ...(lk?.permits ?? []).flatMap((p) => [p.issuingAgency, p.documents])].filter(Boolean) as CitedFact<unknown>[];
  const said = facts.find((f) => /\bfirst\b|\bzoning\b/i.test(String(f.quote || "")) && /^https?:\/\//i.test(String(f.sourceUrl || "")));
  return {
    text: `${ahj} zoning approval before ${county.name} takes the application (the county application's "within a city" zoning block is completed by the city)`,
    sourceUrl: String(said?.sourceUrl || county.fact?.sourceUrl || ""),
    quote: String(said?.quote || "").trim(),
  };
}

/**
 * THE JOB'S OWN LIST when another agency issues its permits: each issuing agency's application(s)
 * for the path, the state checklist where the path is prescriptive (Oregon's BCD 440-5952), and
 * the city's prerequisite step. null when every permit is the AHJ's own (today's behaviour).
 */
export function issuingAgencyDocumentList(project: Pick<ProjectRecord, "state" | "ahj"> & Partial<ProjectRecord>): AgencyDocumentList | null {
  const others = tracksIssuedByOther(project);
  if (!others.length) return null;
  let path: "prescriptive" | "engineered" | "unknown" = "unknown";
  let standardReview = false;
  try {
    const r = resolvePermitPath(project as ProjectRecord);
    path = r.path;
    standardReview = Boolean(r.standardReview);
  } catch { /* path optional */ }
  const kind = standardReview ? null : applicationKindForPath(path);
  const items: AgencyListItem[] = [];
  for (const o of others) {
    const discipline = o.track === "building" ? "structural (building)" : "electrical";
    const docTypes = [...TRACK_FORM_TYPES[o.track]];
    const forms = agencyApplicationForms(project, docTypes[0], o.track === "building" ? kind : null);
    if (forms.length) {
      for (const f of forms) items.push({ text: `${o.name} (issues the ${discipline} permit): ${f.formName} — filled`, docTypes, role: "application", track: o.track, sourceUrl: f.sourceUrl });
    } else {
      const which = o.track === "building" && kind ? `${kind === "prescriptive" ? "prescriptive solar" : "structural (non-prescriptive)"} permit application` : `${discipline} permit application`;
      items.push({ text: `${o.name} (issues the ${discipline} permit): ${o.name}'s ${which} — not yet on file; obtain the agency's blank`, docTypes, role: "application", track: o.track, sourceUrl: String(o.fact?.sourceUrl || "") });
    }
  }
  const oregon = String(project.state ?? "").trim().toUpperCase() === "OR";
  if (oregon && !standardReview && path !== "engineered") {
    items.push({
      text: `Oregon BCD 440-5952 prescriptive rooftop PV checklist — filled${path === "unknown" ? " (prescriptive path only)" : ""}`,
      docTypes: ["solar_checklist"], role: "checklist", sourceUrl: "https://www.oregon.gov/bcd/Formslibrary/5952.pdf",
    });
  }
  const pre = cityPrerequisiteFor(project);
  if (pre) items.push({ text: pre.text + (pre.quote ? ` — "${pre.quote.slice(0, 160)}"` : ""), docTypes: [], role: "prerequisite", sourceUrl: pre.sourceUrl });
  const agencies = [...new Set(others.map((o) => o.name))];
  return { agencies, sourceUrl: String(others[0].fact?.sourceUrl || ""), items };
}

/** The operator's answer to the zoning question (bcdChecklistFacts.formFactQuestions), read as the
 *  prerequisite's status: settled when "Not required" or "approval attached". */
export function prerequisiteSettled(snapshot: Record<string, unknown> | undefined): { settled: boolean; via: string } {
  const v = String(snapshot?.zoningApproval ?? "").trim();
  if (/^not required/i.test(v)) return { settled: true, via: "operator: zoning sign-off not required" };
  if (/approval attached/i.test(v)) return { settled: true, via: "operator: zoning approval attached" };
  if (v) return { settled: false, via: `operator: ${v}` };
  return { settled: false, via: "" };
}

/** Structure-type facts the county applications ask, read through permitProcess.structureTypeMeaning
 *  (ONE vocabulary for what a structure description means). */
export function structureMeaningOf(snapshot: Record<string, unknown> | undefined): ReturnType<typeof structureTypeMeaning> {
  const s = snapshot ?? {};
  return structureTypeMeaning(String(s.structureDescription ?? s.constructionCategory ?? s.occupancyType ?? ""));
}
