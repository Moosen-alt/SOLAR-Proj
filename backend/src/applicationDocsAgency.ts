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
import { DOCUMENT_URL, hostStateOf, isAgencyOwnDomain, jurisdictionTypes, nameKeys, portalNameToken, stateAgencyOf, wordsNameAnotherJurisdiction } from "./permitPlatformCatalog";
import { isPathTenantedHost, isVendorDomain, portalHostOf, portalTenantOf, registrableDomain } from "./portalChannel";
import { curatedFormSourcesFor } from "./curatedAhjForms";
import { resolvePermitPath } from "./permitPath";
import { requirementTrack } from "./requirementSlots";

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
  /** The blank's sha256 when it is known in advance (a curated seed's hash) — one of the keys a stored
   *  row is matched to this form by (rule 2). */
  sha?: string;
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

const answeredName = (f: CitedFact<string> | null | undefined): f is CitedFact<string> & { value: string } =>
  Boolean(f && typeof f.value === "string" && f.value.trim());

// ── WHOSE SITE A CITED PDF IS ON: ANCHOR SITES (agency-apps-close2 rule 1) ─────────────────────
// agency-apps-close MF1 asked "is this the agency's own domain BY NAME" (isAgencyOwnUrl), and a name
// is exactly what cannot tell deschutes.org (Deschutes County) from pbcgov.org (Palm Beach County), nor
// the City of Boulder's bouldercolorado.gov from Boulder County's bouldercounty.gov. The operator's rule
// (2026-09-27, "THIS NEEDS TO BE UNIVERSAL" — a wrong agency's form is worse than a missing one) is
// fail-closed and names nothing: a cited PDF is agency A's only when it sits on a site where the lookup
// ITSELF cited a PAGE for A.

/** A document, not a page: a PDF (or an office file), a CMS document door. */
const OFFICE_FILE = /\.(?:pdf|docx?|xlsx?|rtf|txt|zip)(?:$|[?#])/i;
export function isDocumentUrl(url: string): boolean {
  return DOCUMENT_URL.test(url) || OFFICE_FILE.test(url);
}

/** Hosts where one instance serves MANY organisations' files or code — a CDN, a CMS file host, a code
 *  publisher, a cloud drive, a mirror. A page there is nobody's own site, so it never anchors; a PDF
 *  there is never confirmed (the rule would need the agency's own page to link it, and that link is not
 *  verified offline). Permit / utility platforms (portalChannel.isVendorDomain) count too. */
const SHARED_DOCUMENT_DOMAINS = new Set([
  "municode.com", "ecode360.com", "codepublishing.com", "amlegal.com", "generalcode.com", "sterlingcodifiers.com", "qcode.us", "municipal.codes", "up.codes", "iccsafe.org",
  "civiclive.com", "civicplus.com", "revize.com", "cdn-website.com", "granicus.com", "govoffice.com", "govoffice2.com", "govoffice3.com", "cloudfront.net", "amazonaws.com", "azureedge.net", "akamaized.net", "windows.net",
  "googleusercontent.com", "google.com", "googleapis.com", "dropbox.com", "dropboxusercontent.com", "box.com", "sharepoint.com", "onedrive.live.com", "live.com",
  "wixsite.com", "wix.com", "squarespace.com", "wordpress.com", "weebly.com", "github.io", "issuu.com", "scribd.com", "documentcloud.org", "archive.org", "yumpu.com", "pdfhost.io",
]);
export function isSharedDocumentHost(host: string): boolean {
  const h = String(host ?? "").toLowerCase().replace(/^www\./, "");
  if (!h) return true;
  return SHARED_DOCUMENT_DOMAINS.has(registrableDomain(h)) || isVendorDomain(h);
}

/** A URL's SITE: its registrable domain (assets.bouldercounty.gov -> bouldercounty.gov; a US locality
 *  keeps its four labels: co.marion.or.us, ci.boulder.co.us), plus the path tenant on a host where one
 *  instance serves many agencies. */
export function siteOf(url: string): string {
  const host = portalHostOf(url);
  if (!host) return "";
  const reg = registrableDomain(host);
  return isPathTenantedHost(host) ? `${reg}/${portalTenantOf(url)}` : reg;
}

const MUNICIPAL = new Set(["city", "town", "village", "borough"]);
const LOCALITY_TYPE: Record<string, string> = { ci: "city", city: "city", co: "county", town: "town", twp: "township", vil: "village", village: "village" };
/** The host names a jurisdiction TYPE the named agency's own name does not carry (skagitcounty.net
 *  under the Washington L&I, a state division with no type at all; cityofmarion.org under Marion
 *  County; ci.boulder.co.us under Boulder County). The agency's own name keys are taken out first
 *  (bouldercounty.gov under Boulder County names its own type). Municipal types are one type (a city
 *  is never also a town). Used ONLY to remove an anchor — a name never creates one. */
export function hostNamesAnotherType(url: string, agency: string): boolean {
  let t = portalNameToken(url);
  for (const k of nameKeys([agency]).sort((a, b) => b.length - a.length)) t = t.split(k).join(" ");
  const found = [...t.matchAll(/(township|twp|county|city|town|borough|boro|village|parish)/g)].map((m) => ({ twp: "township", boro: "borough" }[m[1]] ?? m[1]));
  const locality = /^([a-z]+)\.[a-z0-9-]+\.[a-z]{2}\.us$/.exec(registrableDomain(portalHostOf(url)));
  if (locality && LOCALITY_TYPE[locality[1]]) found.push(LOCALITY_TYPE[locality[1]]);
  if (!found.length) return false;
  const own = jurisdictionTypes([agency]);
  if (!own.size) return true;
  return !found.some((f) => own.has(f) || (MUNICIPAL.has(f) && [...own].some((o) => MUNICIPAL.has(o))));
}

/** The agency a permit answer is attributed to: its own cited answer, else the AHJ-wide one. */
function permitAgencyName(p: { issuingAgency?: CitedFact<string> | null }, top: CitedFact<string> | null | undefined): string {
  if (answeredName(p.issuingAgency)) return String(p.issuingAgency.value).trim();
  return answeredName(top) ? String(top.value).trim() : "";
}
const httpUrl = (u: unknown): string => {
  const s = String(u ?? "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
};

/**
 * AGENCY A'S ANCHOR SITES in this job's lookup — the sites of the PAGES the lookup itself cited for A:
 *   - the source pages of every permit whose OWN issuer answer names A: issuingAgency / portalUrl /
 *     documents / fee — a notFound portal / documents / fee answer's page too (Michael's lookup read
 *     co.marion.or.us/PW/BuildingInspection for Marion County's portal and found none: the page is
 *     still Marion County's). A permit whose own issuer answer is notFound anchors NOTHING, even where
 *     the AHJ-wide answer names A (agency-contain C4, "notFound never vouches" — the skeptic's S3: a
 *     notFound answer sourced to Polk County's page made co.polk.or.us Fixture County's site);
 *   - the AHJ-wide issuingAgency's page, only when that answer NAMES A.
 * A DOCUMENT never anchors — not itself, not another document (the lookup citing Lane County's PDF as
 * the Oregon BCD's source is the error this rule refuses). And a site is removed — names only ever
 * REMOVE — when it is:
 *   - cited for ANOTHER agency's permit (the AHJ's own included) or by an AHJ-wide answer naming
 *     another agency: it is that agency's;
 *   - a shared document host (CDN, code publisher, platform);
 *   - the AHJ's own domain (isAgencyOwnDomain by the AHJ's name, unless the host names a type the AHJ
 *     is not: co.marion.or.us is never the City of Marion's): the city's page saying "submit to the
 *     county" is the city's (jeffersonoregon.org);
 *   - a host naming a jurisdiction type A is not (hostNamesAnotherType);
 *   - (agency-contain C3) a host carrying ANOTHER STATE (co.jefferson.or.us, jeffersoncountyor.gov for
 *     Colorado's Jefferson County); the state's own site (oregon.gov) for a county / a city; and, for an
 *     agency that IS the state (stateAgencyOf: "Oregon Building Codes Division"), any host but the
 *     state's own site — a county's site with no type in its name (deschutes.org, clackamas.us,
 *     multco.us) is never the state agency's.
 */
export function agencyAnchorSites(project: Pick<ProjectRecord, "state" | "ahj">, agency: string): string[] {
  const lk = permitProcessFor(project);
  if (!lk || !String(agency ?? "").trim()) return [];
  const ahj = String(project.ahj ?? "").trim();
  const top = lk.issuingAgency as CitedFact<string> | null | undefined;
  const mine = new Map<string, string[]>(); // site -> the page URLs that put it there
  const others = new Set<string>();
  const addPage = (u: unknown): void => {
    const url = httpUrl(u);
    if (!url || isDocumentUrl(url)) return;
    const site = siteOf(url);
    if (site) mine.set(site, [...(mine.get(site) ?? []), url]);
  };
  for (const p of lk.permits ?? []) {
    const who = permitAgencyName(p, top);
    if (!who) continue;
    const sources = [p.issuingAgency, p.portalUrl, p.documents, p.fee].map((f) => httpUrl(f?.sourceUrl)).filter(Boolean);
    // C4: only a permit whose OWN issuer answer names A vouches for its pages; one attributed to A only
    // through the AHJ-wide answer (its own notFound) anchors nothing. (Its pages still REMOVE a site when
    // the answer it is attributed to names another agency — below, unchanged.)
    if (sameAgencyName(who, agency)) { if (answeredName(p.issuingAgency)) sources.forEach(addPage); }
    else for (const u of sources) others.add(siteOf(u));
  }
  if (answeredName(top)) {
    const u = httpUrl(top.sourceUrl);
    if (u && sameAgencyName(top.value, agency)) addPage(u);
    else if (u) others.add(siteOf(u));
  }
  // Any one page of a site failing a veto removes the site (fail-closed).
  const jobState = String(project.state ?? "").trim().toLowerCase();
  const agencyTyped = jurisdictionTypes([agency]).size > 0;
  const agencyState = stateAgencyOf(agency);
  const vetoed = (url: string): boolean => {
    const host = portalHostOf(url);
    if (isSharedDocumentHost(host)) return true;
    if (ahj && !sameAgencyName(ahj, agency) && isAgencyOwnDomain(host, [ahj], project.state) && !hostNamesAnotherType(url, ahj)) return true;
    // C3 NAMES ONLY REMOVE, INCLUDING STATE (agency-contain): the host's state, read from its structure
    // (permitPlatformCatalog.hostStateOf), against the job's state and the agency's KIND, both directions.
    const hs = hostStateOf(host);
    if (hs && jobState && hs.state !== jobState) return true; // another state's host (co.jefferson.or.us for Colorado)
    if (hs?.stateSite && agencyTyped) return true; // the state's own site is never a county's / a city's (oregon.gov)
    if (agencyState && !hs?.stateSite) return true; // the state's agency lives only on the state's site (deschutes.org is not the BCD's)
    return hostNamesAnotherType(url, agency);
  };
  return [...mine].filter(([site, urls]) => !others.has(site) && !urls.some(vetoed)).map(([site]) => site);
}

/**
 * The application PDFs the per-job lookup CITES for this track's permit, split by rule 1:
 *   - WHICH ANSWERS: the permits of this track attributed to this agency (their own answer, else the
 *     AHJ-wide one); the AHJ-wide answer's source only when that answer NAMES this agency. A notFound
 *     AHJ-wide answer, or one naming another agency, lends its source to no track (MF1c / MF1d).
 *   - WHAT IT IS: its file name names this track's application and no other jurisdiction (a fee
 *     schedule, a checklist, "City of Houston ..." is no candidate at all).
 *   - CONFIRMED only when its site is one of the agency's anchor sites (agencyAnchorSites). Everything
 *     else is UNCONFIRMED — listed "cited: <file> — confirm it is <A>'s form before it is used", never
 *     fetched, never stored, never filled.
 */
export function citedAgencyApplications(project: Pick<ProjectRecord, "state" | "ahj">, authority: FormAuthority): { confirmed: string[]; unconfirmed: string[] } {
  const none = { confirmed: [] as string[], unconfirmed: [] as string[] };
  if (!authority.issuedByOther || !authority.track) return none;
  const lk = permitProcessFor(project);
  if (!lk) return none;
  const track = authority.track;
  const agency = authority.name;
  const top = lk.issuingAgency as CitedFact<string> | null | undefined;
  const permits = (lk.permits ?? []).filter((p) => (track === "electrical" ? p.discipline === "electrical" : p.discipline === "structural" || p.discipline === "combo")
    && sameAgencyName(permitAgencyName(p, top), agency));
  const anchors = new Set(agencyAnchorSites(project, agency));
  const out = { confirmed: [] as string[], unconfirmed: [] as string[] };
  const consider = (u: unknown): void => {
    const url = httpUrl(u);
    if (!url || !isDocumentUrl(url) || out.confirmed.includes(url) || out.unconfirmed.includes(url)) return;
    if (!portalHostOf(url)) return;
    const name = fileNameOf(url);
    if (!citedNameFitsTrack(name, track) || wordsNameAnotherJurisdiction(name, [agency])) return;
    (anchors.has(siteOf(url)) && !isSharedDocumentHost(portalHostOf(url)) ? out.confirmed : out.unconfirmed).push(url);
  };
  for (const p of permits) {
    for (const f of [p.issuingAgency, p.documents, p.fee, p.recordType, p.portalUrl]) consider(f?.sourceUrl);
    for (const d of p.documents?.value ?? []) consider(d);
  }
  if (answeredName(top) && sameAgencyName(top.value, agency)) consider(top.sourceUrl);
  return out;
}

const citedFormName = (url: string): string => fileNameOf(url).replace(/\.pdf$/i, "").replace(/\s*fill+e?able\s*$/i, "").trim();

/** The agency's applications for this form type that we know BY NAME AND CAN CONFIRM ARE ITS — a curated
 *  public seed first, then a cited PDF on one of the agency's anchor sites — narrowed to the path's
 *  application kind. What acquisition fetches, what the required row names, what the list calls the
 *  agency's form. */
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
    out.push({ formName: s.formName, sourceUrl: s.url, formType: s.formType, applicationKind: kind, origin: "curated", sha: s.hash });
  }
  for (const url of citedAgencyApplications(project, authority).confirmed) {
    if (out.some((o) => o.sourceUrl === url)) continue;
    const name = citedFormName(url);
    const kind = formApplicationKind(name);
    if (!kindFits(kind, authority.track === "building" ? want : null)) continue;
    out.push({ formName: name, sourceUrl: url, formType: authority.track === "electrical" ? "electrical_application" : "building_application", applicationKind: kind, origin: "cited" });
  }
  return out;
}

/** The PDFs the lookup cited for this track's agency that rule 1 could NOT confirm as the agency's (no
 *  page of the agency's on their site, or a shared document host) — narrowed to the path's kind, never
 *  one already confirmed or seeded. Listed to confirm; never fetched, stored or filled. */
export function unconfirmedAgencyApplicationForms(
  project: Pick<ProjectRecord, "state" | "ahj">,
  formType: string,
  want: "prescriptive" | "structural" | null,
): AgencyApplicationForm[] {
  const authority = formAuthorityFor(project, formType);
  if (!authority.issuedByOther || !authority.track) return [];
  const known = new Set(agencyApplicationForms(project, formType, want).map((f) => f.sourceUrl));
  const out: AgencyApplicationForm[] = [];
  for (const url of citedAgencyApplications(project, authority).unconfirmed) {
    if (known.has(url) || curatedFormSourcesFor(authority.name, project.state).some((s) => s.url === url)) continue;
    const name = citedFormName(url);
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
  /** The issuing agency whose application this is (role "application"). */
  agency?: string;
  sourceUrl: string;
  /** THE FORM this line is (role "application" naming a specific form): the keys its template row is
   *  matched by (source URL / form name / sha — rule 2), and whether rule 1 confirmed it as the agency's.
   *  Absent on the generic "<agency>'s application" line, whose status is the slot's. */
  form?: AgencyLineForm;
  /** The status the list's resolver gave this line (null: no resolver, or no slot). */
  status?: AgencyLineStatus | null;
}
export interface AgencyLineForm {
  sourceUrl: string;
  formName: string;
  sha?: string;
  confirmed: boolean;
}
export interface AgencyDocumentList {
  agencies: string[];
  sourceUrl: string;
  items: AgencyListItem[];
  /** The list decided the STATE checklist (Oregon: the BCD 440-5952 on the prescriptive path, none
   *  on the engineered one), so the AHJ's own checklist line gives way to that decision either way. */
  decidesStateChecklist: boolean;
}

/** A step at the CITY's office before the county takes the application: the lookup's cited
 *  prerequisites, else — where a COUNTY issues a CITY's building permit — the zoning approval every
 *  such county application asks the city for, with the lookup's own words when one of its quotes
 *  says so. */
export function cityPrerequisiteFor(project: Pick<ProjectRecord, "state" | "ahj">): { text: string; sourceUrl: string; quote: string } | null {
  const lk = permitProcessFor(project);
  const ahj = String(project.ahj ?? "").trim();
  const cited = (lk?.prerequisites ?? []).find((p) => typeof p?.value === "string" && p.value.trim() && /^https?:\/\//i.test(String(p.sourceUrl || "")) && String(p.quote || "").trim().length >= 8);
  if (cited) return { text: `${ahj} first: ${String(cited.value).trim()}`, sourceUrl: String(cited.sourceUrl), quote: String(cited.quote).trim() };
  // Only where the county issues the BUILDING permit (agency-apps-close MF2): the zoning block is on
  // the county's building application. Where the city issues its own building permit (Coos Bay,
  // Happy Valley — the county only the electrical), its zoning review is its own permit's.
  const county = tracksIssuedByOther(project).find((o) => o.track === "building" && /\bcounty\b/i.test(o.name));
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

// ── A line's status: the inventory's, never "known by name" ────────────────────────────────
/**
 * Where a line's document stands (agency-apps-close MF3 — every agency line said "filled" when its
 * form was merely KNOWN BY NAME, and the 5952 line unconditionally; the packet manifest and
 * docs.complete printed it before anything was held). Answered by requiredDocuments.
 * agencyListStatusResolver from the ONE inventory the fill and the gate already read.
 */
export type AgencyLineStatus = "attached" | "filled" | "on_file" | "held_not_fillable" | "cited_unconfirmed" | "not_on_file";
export type AgencyLineStatusOf = (item: Pick<AgencyListItem, "docTypes" | "role" | "track" | "agency" | "sourceUrl" | "form">) => AgencyLineStatus | null;
export const AGENCY_LINE_STATUS_TEXT: Record<AgencyLineStatus, string> = {
  attached: "attached (uploaded)",
  filled: "filled",
  on_file: "on file (fill pending)",
  held_not_fillable: "held, not fillable (complete by hand and attach)",
  // The cited line's own words already say it ("cited: <file> — confirm it is <A>'s form before it is
  // used"); the status is carried on the item, not appended twice.
  cited_unconfirmed: "cited, needs confirmation",
  not_on_file: "not yet on file",
};
/** The line for a PDF the lookup cited for the agency that rule 1 could not confirm as the agency's. */
export function citedUnconfirmedLineText(agency: string, discipline: string, url: string): string {
  return `${agency} (issues the ${discipline} permit): cited: ${fileNameOf(url) || url} — confirm it is ${agency}'s form before it is used`;
}

/**
 * THE JOB'S OWN LIST when another agency issues its permits: each issuing agency's application(s)
 * for the path, the state checklist where the path is prescriptive (Oregon's BCD 440-5952), and
 * the city's prerequisite step. null when every permit is the AHJ's own (today's behaviour).
 *
 * A line's STATUS comes from `statusOf` (requiredDocuments.agencyListStatusResolver — uploads, the
 * filled files on disk for this path, the fill's own template list, the held-but-unfillable blanks).
 * Without it (a caller with no database) a line names the document and claims nothing about it.
 */
export function issuingAgencyDocumentList(project: Pick<ProjectRecord, "state" | "ahj"> & Partial<ProjectRecord>, statusOf: AgencyLineStatusOf | null = null): AgencyDocumentList | null {
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
  const add = (item: AgencyListItem): void => {
    let status: AgencyLineStatus | null = null;
    try { status = statusOf ? statusOf(item) : null; } catch { status = null; }
    const obtain = status === "not_on_file" && item.role === "application" ? "; obtain the agency's blank" : "";
    // The cited-to-confirm line already says what it is; its status rides on the item.
    const said = !status || status === "cited_unconfirmed" ? item.text : `${item.text} — ${AGENCY_LINE_STATUS_TEXT[status]}${obtain}`;
    items.push({ ...item, text: said, status });
  };
  for (const o of others) {
    const discipline = o.track === "building" ? "structural (building)" : "electrical";
    const docTypes = [...TRACK_FORM_TYPES[o.track]];
    const want = o.track === "building" ? kind : null;
    const forms = agencyApplicationForms(project, docTypes[0], want);
    if (forms.length) {
      for (const f of forms) {
        add({ text: `${o.name} (issues the ${discipline} permit): ${f.formName}`, docTypes, role: "application", track: o.track, agency: o.name, sourceUrl: f.sourceUrl,
          form: { sourceUrl: f.sourceUrl, formName: f.formName, ...(f.sha ? { sha: f.sha } : {}), confirmed: true } });
      }
    } else {
      const which = o.track === "building" && kind ? `${kind === "prescriptive" ? "prescriptive solar" : "structural (non-prescriptive)"} permit application` : `${discipline} permit application`;
      add({ text: `${o.name} (issues the ${discipline} permit): ${o.name}'s ${which}`, docTypes, role: "application", track: o.track, agency: o.name, sourceUrl: String(o.fact?.sourceUrl || "") });
    }
    // RULE 1: a PDF the lookup cited for the agency on no anchor site of the agency's is named — so a
    // person can confirm it — and is never the agency's form until they do.
    for (const f of unconfirmedAgencyApplicationForms(project, docTypes[0], want)) {
      add({ text: citedUnconfirmedLineText(o.name, discipline, f.sourceUrl), docTypes, role: "application", track: o.track, agency: o.name, sourceUrl: f.sourceUrl,
        form: { sourceUrl: f.sourceUrl, formName: f.formName, confirmed: false } });
    }
  }
  const oregon = String(project.state ?? "").trim().toUpperCase() === "OR";
  if (oregon && !standardReview && path !== "engineered") {
    add({
      text: `Oregon BCD 440-5952 prescriptive rooftop PV checklist${path === "unknown" ? " (prescriptive path only)" : ""}`,
      docTypes: ["solar_checklist"], role: "checklist", sourceUrl: "https://www.oregon.gov/bcd/Formslibrary/5952.pdf",
    });
  }
  const pre = cityPrerequisiteFor(project);
  if (pre) items.push({ text: pre.text + (pre.quote ? ` — "${pre.quote.slice(0, 160)}"` : ""), docTypes: [], role: "prerequisite", sourceUrl: pre.sourceUrl });
  const agencies = [...new Set(others.map((o) => o.name))];
  return { agencies, sourceUrl: String(others[0].fact?.sourceUrl || ""), items, decidesStateChecklist: oregon };
}

/**
 * Does the agency list REPLACE this line of the AHJ's own required list (agency-apps-close MF2)?
 * Only the line for a TRACK another agency issues — that agency's own application(s) stand in for
 * the AHJ's — and the AHJ's checklist line where the list decided the state checklist (one
 * checklist, not two, on the prescriptive path; none on the engineered path, where the prescriptive
 * checklist is the upload the AHJ forbids). The AHJ's own lines for the tracks it issues itself stay
 * (Coos Bay's building application where Coos County issues only the electrical permit), and so does
 * every line that is no application (plan set, specs, stamps). One vocabulary:
 * requirementSlots.requirementTrack.
 */
export function agencyListReplacesLine(list: AgencyDocumentList, line: string): boolean {
  if (agencyListNamesDocument(list, line)) return true;
  const t = requirementTrack(line);
  if (!t) return false;
  if (t === "checklist") return list.decidesStateChecklist || list.items.some((i) => i.role === "checklist");
  return list.items.some((i) => i.role === "application" && i.track === t);
}

/** The line names, BY ITS URL, a PDF the agency list already carries as one of its application lines
 *  (a confirmed form with its own status, or a cited PDF with its confirm warning) — the lookup's raw
 *  document entry ("structural permit: https://…/Solar Permit Application.pdf"), which no slot can
 *  hold and so read "missing" forever beside the line that says where that PDF stands. */
export function agencyListNamesDocument(list: AgencyDocumentList, line: string): boolean {
  const s = String(line ?? "");
  return list.items.some((i) => i.role === "application" && Boolean(i.form?.sourceUrl) && s.includes(String(i.form!.sourceUrl)));
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
