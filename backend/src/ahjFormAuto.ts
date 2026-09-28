import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { AppDb } from "./db";
import type { AhjFormUrlResult, LLMProvider, ProjectRecord } from "../../shared/src/types";
import { inspectFormFields, inspectPlacedFields, loadStoredTemplates, formApplicationKind, storedApplicationKind, applicationKindForPath, type InspectedField, type OverlayField, type SignaturePlacement } from "./ahjForms";
import {
  attestsAttachedDocument, OREGON_CCB_SOURCE, placementOnWidget, sanitizeAcroMap, STATE_LICENCE_SOURCE, typedLicenceSource, type OperatorItem,
} from "./formFieldChecks";
import { LICENCE_KINDS, licenceKindWords } from "../../shared/src/licenceKinds";
import { parseJson } from "./json";
import { HttpError } from "./httpError";
import { describePermitType, findApplicationProfile, permitStructureAnswer } from "./applicationDocs";
import { ensureUtilityFilingLookedUp } from "./utilityFilingLookup";
import { fetchPublicDocument } from "./documentFetch";
import { logger } from "./logger";
import { saveResearchedAhjProfile, knowledgeResearchHint, findKnowledgeForLearn } from "./knowledgeBase";
import { findAhjProcessProfile } from "./processProfiles";
import { applicationDocContext, requiredApplicationDocs } from "./requiredDocuments";
import { renderPdfPageToPng } from "./pageImages";
import { prescriptiveCriterionCatalog, resolvePermitPath } from "./permitPath";
import { nowIso } from "./time";
// A form is a DATED artifact; documentDate.ts is what reads the date off it.
// It lives in its OWN module, importing nothing from here, because ahjForms.ts
// needs the same staleness verdict on the fill screen and ahjFormAuto already
// imports ahjForms — a helper parked here would have closed that cycle.
// Re-exported so every existing caller of this module keeps working.
export {
  DOCUMENT_DATE_STALE_DAYS, extractDocumentDate, findDocumentDates, isoForDocumentDate,
  documentDateAgeDays, isDocumentDateStale, documentDateForPdf, templateProvenance,
  type DocumentDateFinding, type TemplateProvenance,
} from "./documentDate";
import { documentDateForPdf } from "./documentDate";
import { bcd5952Template } from "./bcd5952Template";
import { iowaPvWorksheetTemplate, PV_WORKSHEET_DOC_TYPE } from "./iowaPvWorksheet";
import { curatedFormSource, curatedFormMap } from "./curatedAhjForms";
import { sanitizePlacements, signatureStandIns } from "./formFieldChecks";
import type { LabelItem } from "./formTextLayer";
import { agencyApplicationForms, agencyRowAppliesToJob, agencyRowProvenance, anchorSitesOnce, formAuthorityFor, rowBelongsToAuthority, TRACK_FORM_TYPES, type FormAuthority } from "./applicationDocsAgency";
import {
  acceptedFormTypes, acceptedFormTypesFor, applicationKindForProject, clearFormFetchFailure, hasStoredTemplateOfType, issuingAgencyFormPlan, noteFormFetchFailure,
  ownFreeFormSource, recentFormFetchFailure, type EnsureFormResult,
} from "./formAcquisitionPlan";
// The acquisition's pre-fetch predicates live in formAcquisitionPlan.ts — the ONE answer the pre-Stage
// gate reads too (gates-proper C1). Re-exported so every existing caller of this module keeps working.
export { applicationKindForProject, hasStoredTemplateOfType, type EnsureFormResult } from "./formAcquisitionPlan";
import { isRefusal, PAGE_READ_MIN_GAP_MS, type PageReader } from "./agencyPageReader";
// Its own line (not beside the applicationDocs import above): forms-fill rewrites the ahjForms import next to it.
import { permitStructureForProject } from "./applicationDocs";
import { applicationFormLinks, classifyApplicationDocument, documentSlugWords, isAhjFormsSite, namesCombinedApplication, WIRING_PERMIT_PHRASE, DOCUMENT_URL, type ApplicationDiscipline } from "./permitPlatformCatalog";
import { isUtilityPlatformUrl, portalHostOf, registrableDomain } from "./portalChannel";

// ---------------------------------------------------------------------------
// Auto-acquire an AHJ's official permit PDF form: web-research the URL, download
// the blank PDF, map its AcroForm fields to project data, and store it so every
// future project under that AHJ gets the real filled form. Operator upload is
// the fallback when no form can be found (see /api/ahj-templates/upload).
// ---------------------------------------------------------------------------

// Prescriptive-checklist sources (one Yes/No pair per structural criterion, plus
// the overall screen). Each resolves via prescriptiveComputed in ahjForms.ts:
// "X" when the parsed data answers that way, "" when unverified — so a checklist
// row with no parsed backing stays blank for the operator instead of attesting.
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const PRESCRIPTIVE_SOURCES: string[] = [
  ...prescriptiveCriterionCatalog().flatMap(({ key, label }) => [
    `computed.presc${cap(key)}Yes  (checklist row "${label}" — "X" iff the parsed data answers Yes)`,
    `computed.presc${cap(key)}No  (same row — "X" iff it answers No)`,
    `computed.presc${cap(key)}Answer  (same row — the word Yes/No for a written blank; TEXT FIELDS ONLY)`,
  ]),
  'computed.prescAllYes  ("X" iff EVERY prescriptive criterion answers Yes — for a single "meets all prescriptive criteria" box)',
  'computed.prescAllNo  ("X" iff any prescriptive criterion answers No)',
  'computed.prescAllAnswer  (overall Yes/No as text; TEXT FIELDS ONLY)',
];

// Parsed structural values, for checklists with written blanks ("Ground snow
// load: ___ psf"). Same snapshot keys the prescriptive evaluator reads.
const STRUCTURAL_VALUE_SOURCES: string[] = [
  "snapshot.snow  (ground snow load, psf)",
  "snapshot.wind  (wind exposure category B/C/D)",
  "snapshot.windSpeed  (ultimate design wind speed, mph)",
  "snapshot.deadLoad  (PV system dead load, psf)",
  "snapshot.roofRafterSpacing  (rafter/truss spacing, in. o.c.)",
  "snapshot.moduleHeightAboveRoof  (module height above roof surface, in.)",
  "snapshot.roofLayers  (existing roofing layers)",
  "snapshot.riskCategory  (risk category I/II/III/IV)",
  "snapshot.mounting  (mounting type, e.g. roof mount)",
];

// Existing-system (addition) values, for NEM/permit forms that ask about
// generation already on the service. Blank on projects with no existing system.
const EXISTING_SYSTEM_SOURCES: string[] = [
  'snapshot.hasExistingSystem  ("Yes" when an existing PV system remains in service, blank otherwise — safe for an "existing generation on site" checkbox)',
  "snapshot.existingDcKw  (existing PV system size, kW DC)",
  "snapshot.existingAcKw  (existing PV system size, kW AC)",
  "snapshot.existingModuleMake  (existing PV module manufacturer)",
  "snapshot.existingModuleModel  (existing PV module model)",
  "snapshot.existingModuleQty  (existing module count)",
  "snapshot.existingInvMake  (existing inverter manufacturer)",
  "snapshot.existingInvModel  (existing inverter model)",
  "snapshot.existingInvQty  (existing inverter count)",
  "snapshot.combinedDcKw  (combined new + existing size, kW DC)",
  "snapshot.combinedAcKw  (combined new + existing size, kW AC)",
];

// The typed licence sources: THIS job's state's licence of each kind (number, expiry; the holder's
// name for a person licence). Names only reach the mapper — never a number (hard rule 2).
const TYPED_LICENCE_SOURCES: string[] = LICENCE_KINDS.filter((k) => k.kind !== "business_registration").flatMap((k) => [
  `${typedLicenceSource(k.kind)}  (THIS job's state's ${licenceKindWords(k.kind)} NUMBER — for a slot that names it${k.kind === "construction_supervisor" ? ', e.g. "Construction Supervisor License", "CSL #"' : k.kind === "home_improvement_contractor" ? ', e.g. "HIC Registration Number"' : k.kind === "electrical_contractor" ? ', e.g. "Electrical Contractor License"' : k.kind === "master_electrician" ? ', e.g. "Supervising / Master Electrician License"' : ""})`,
  `${typedLicenceSource(k.kind, "expires")}  (that licence's EXPIRATION date)`,
  ...(k.person ? [`${typedLicenceSource(k.kind, "holder")}  (the NAME of the person who holds that licence — for a "Licensed ${k.kind === "construction_supervisor" ? "Construction Supervisor" : "Electrician"}" name blank)`] : []),
]);

// The project-data sources the field mapper may target. Mirrors resolveSource()
// scopes in ahjForms.ts. Kept explicit so the LLM only maps to real fields.
export const AVAILABLE_FIELD_SOURCES: string[] = [
  "project.homeownerName",
  "project.projectAddress",
  "project.city",
  "project.state",
  "project.zip",
  "project.ahj",
  "project.utility",
  "project.systemSizeDcKw",
  "project.systemSizeAcKw",
  "project.interconnectionMethod",
  "snapshot.homeownerEmail",
  "snapshot.homeownerPhone",
  "snapshot.moduleMake",
  "snapshot.moduleModel",
  "snapshot.moduleWattage",
  "snapshot.moduleQty",
  "snapshot.invMake",
  "snapshot.invModel",
  "snapshot.invQty",
  "snapshot.busRating",
  "snapshot.mainBreaker",
  "snapshot.pvBreaker",
  "snapshot.batteryMake",
  "snapshot.batteryModel",
  "snapshot.batteryQty",
  "client.installerCompanyName",
  "client.installerEmail",
  "client.installerPhone",
  "client.installerStreet",
  "client.installerCityStateZip",
  // A LICENCE IS A STATE'S (City of Waltham, MA printed an Oregon CCB number in its construction-
  // supervisor licence slot). The CCB source is Oregon's only — fieldSourcesForState drops it from
  // any other state's mapping, and buildContext blanks it at fill time.
  'client.ccbLicenseNumber  (OREGON CCB contractor licence number — Oregon forms ONLY)',
  `${STATE_LICENCE_SOURCE}  (the contractor licence THIS job's permit takes in THIS job's state — for a licence / registration NUMBER slot that does NOT say which licence; blank when none is on file)`,
  // LICENCES BY KIND (clients.licenceFor): a slot that NAMES its licence binds that kind's source.
  ...TYPED_LICENCE_SOURCES,
  // The operator valuation (resolveValuation, the 2026-09-21 ruling) and the plan set's parcel number
  // existed in the fill path but were never OFFERED to the mapper, so Waltham's estimated-cost
  // table and parcel blank stayed empty.
  'computed.estimatedJobValue  (estimated construction cost / job valuation in whole dollars — for "Estimated cost", "Cost of construction", "Valuation", "Job value"; in a cost table the TOTAL row only)',
  'snapshot.parcelNumber  (assessor parcel number / APN, as printed on the plan set — write it as printed)',
  "computed.fullAddress",
  "computed.cityStateZip",
  "computed.systemSize",
  "computed.systemSizeDcKw",
  "computed.descriptionOfWork",
  // Print-name lines under signatures. These resolvers existed in the fill path
  // but were never OFFERED to the mapper, so every "Print name" blank on every
  // auto-mapped form stayed empty (caught on the live Coos Bay building permit).
  'computed.applicantSignerName  (typed name of the applicant/agent signer — for "Print name" lines under the authorized signature)',
  'computed.electricianSignerName  (typed name of the electrician signer — for "Print name" next to the electrician signature)',
  ...STRUCTURAL_VALUE_SOURCES,
  ...EXISTING_SYSTEM_SOURCES,
  ...PRESCRIPTIVE_SOURCES,
  'lit:X  (literal — use for fixed checkbox marks / constant text like "lit:Solar")',
  'operator:<printed caption>  (NOT a value: marks a blank the applicant must fill by hand because no source above answers it — it is listed for the operator by that caption)',
];

/** The sources offered for a form of this state: the Oregon CCB source only on an Oregon form (a
 *  template with no stored state keeps it on offer; the FILL resolves it only on an Oregon job —
 *  clients.licenceJobState reads a blank project state as unknown). */
export function fieldSourcesForState(state: string): string[] {
  const st = String(state || "").trim().toUpperCase();
  return !st || st === "OR" ? AVAILABLE_FIELD_SOURCES : AVAILABLE_FIELD_SOURCES.filter((s) => !s.startsWith(OREGON_CCB_SOURCE));
}

export interface StoredFieldMap {
  requiredFields?: Record<string, string>;
  preserveInteractive?: boolean;
  fieldFontSizes?: Record<string, number>;
  formName: string;
  sourceUrl: string;
  fillMode: "acroform" | "overlay";
  textFields: Record<string, string>;
  checkboxes: Record<string, { source: string; equals?: string }>;
  /** Well-formed Yes/No radio groups: select `option` when the rule holds (ahjForms.fillLoadedForm). */
  radioGroups?: Record<string, { source: string; equals?: string; option: string }>;
  /** Coordinate placements (PDF points, bottom-left origin) for flat/scanned PDFs
   *  filled by vision-derived overlay. Used when fillMode === "overlay". */
  overlayFields?: OverlayField[];
  /** Vision-detected signature line placements (PDF points). The operator's
   *  stored signature for each role is stamped here at fill time. */
  signatureFields?: SignaturePlacement[];
  notes: string;
  /** Which of the two MUTUALLY EXCLUSIVE building-side applications this blank is —
   *  the vocabulary formAllowedForPath / applicationKindForPath enforce. Stamped by
   *  acquisition, which KNOWS what it went looking for; absent means "makes no claim"
   *  (a generic application a jurisdiction uses on both paths), which is compatible
   *  with every path. Deliberately its own field rather than a re-reading of formName:
   *  a structural blank published as "Building Permit Application.pdf" derives NOTHING
   *  from its name, and that is the hole this closes. */
  applicationKind?: "prescriptive" | "structural";
  /** sha256 of the blank PDF bytes — lets the periodic refresh detect when the
   *  AHJ has revised the form at its source URL. Set by storeAhjFormTemplate. */
  sourceHash?: string;
  /** ISO timestamp of the last source-URL freshness check. */
  lastCheckedAt?: string;
  /** Human-verified that the field/signature mapping is correct. Auto-maps start
   *  false; a real submit is gated until the operator previews and verifies. */
  verified?: boolean;
  verifiedAt?: string;
  /** Blanks no source can fill (zoning, setbacks, flood zone, a widget-less printed blank…), by
   *  printed label, from the mappers and the post-map checks — listed on every fill result. */
  operatorItems?: OperatorItem[];
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// Fetch a URL and return the bytes only if it looks like a real PDF.
//
// A FORM THAT WAS BLOCKED MUST NEVER READ AS A FORM THAT DOES NOT EXIST.
// This used to be a bare fetch() that returned null on !res.ok — and null is what
// ensureAhjFormTemplate turns into "Found candidate links but none returned a valid PDF (link
// rot or login-gated)". coosbayor.gov, and a good number of other jurisdiction sites, sit
// behind Akamai and answer 403 to EVERY programmatic client: curl with a browser User-Agent,
// WebFetch and headless Playwright alike, while a headed window gets 200. So form acquisition
// failed silently on exactly the AHJs that most needed it, and the failure was indistinguishable
// from the AHJ publishing nothing. fetchPublicDocument is the one retrieval path — it escalates
// a bot wall to a real window, refuses to climb a CAPTCHA or a stated no-robots notice, and
// ALWAYS carries a reason. Null still means "no usable PDF" to every caller; the reason is now
// in the log instead of nowhere.
export async function fetchPdf(url: string): Promise<Uint8Array | null> {
  const failed = (): null => { noteFormFetchFailure(url); return null; };
  try {
    const got = await fetchPublicDocument(url);
    if (!got.ok || !got.bytes) {
      logger.warn("ahj-forms", "a blank form could not be downloaded", {
        url, status: got.status, via: got.via, reason: got.reason,
      });
      return failed();
    }
    const buf = got.bytes;
    const type = got.contentType || "";
    // %PDF magic, or a pdf content-type. Guard against HTML error pages.
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) { clearFormFetchFailure(url); return buf; }
    if (type.includes("pdf") && buf.length > 1000) { clearFormFetchFailure(url); return buf; }
    // The link answered — with a login page, a "moved" notice or a CMS 200 error page. That is
    // a different repair from a wall (fix the link, not the browser), so it is said differently.
    logger.warn("ahj-forms", "a form link answered, but not with a PDF", {
      url, status: got.status, contentType: type || "(none)", bytes: buf.length, via: got.via,
    });
    return failed();
  } catch (err) {
    // fetchPublicDocument reports rather than throws; this is the belt on the braces, so the
    // acquisition loop's contract (null, never an exception) holds whatever happens below it.
    logger.warn("ahj-forms", "a blank form download threw", { url, error: err instanceof Error ? err.message : String(err) });
    return failed();
  }
}

// GO GENTLY ON A FORM URL THAT JUST FAILED (stage-forms-fee skeptic N2; operator rule "go gently on
// Cloudflare sites"). Inside the 24h per-AHJ cooldown Stage runs the FREE acquisition pass on every
// Stage — and a curated or cited URL that is walled or down was fetched again each time, and
// fetchPublicDocument may open a HEADED browser for a walled one each time. So a per-URL memo of the
// last failed download: the within-cooldown pass (skipRecentlyFailed, set only by
// prepareOfficialDocuments) does not re-fetch a URL that failed in the last FORM_FETCH_RETRY_MS, and
// says so ("tried <when>, retry after <when>"). Every other door — the full pass once the cooldown
// opens, and the operator's explicit "Find missing official forms" — never consults it. Per URL, not
// per AHJ: every city a county issues for fetches the county's one URL. In-process: a restart forgets
// it, which costs at most one extra fetch. A success clears the URL. The map lives in
// formAcquisitionPlan.ts (gates-proper C1), so the pre-Stage gate reads the same record.
export { FORM_FETCH_RETRY_MS, recentFormFetchFailure } from "./formAcquisitionPlan";

/** Record that this blank carried a fee table we harvested. Written by the
 *  fee-harvest side, which owns the reading; storage owns only the flag. */
export function markTemplateFeeTableFound(db: AppDb, templateId: string, found = true): void {
  db.run("UPDATE ahj_form_templates SET fee_table_found = ?, updated_at = ? WHERE id = ?", [found ? 1 : 0, nowIso(), templateId]);
}

/**
 * A STORE THAT WOULD REPLACE A HUMAN-VERIFIED MAP, REFUSED (hard rule 3). storeAhjFormTemplate throws
 * this instead of writing; `result` is the acquisition's answer ("exists", the HUMAN-VERIFIED
 * message). An acquisition door returns it; a door that does not catch it fails loudly and writes
 * nothing (409 at a route edge).
 */
export class VerifiedTemplateRefusal extends HttpError {
  constructor(public readonly result: EnsureFormResult) { super(409, result.message); }
}

// Insert or replace a stored AHJ form template. Dedupes on (ahj_name, state, form_type).
//
// THE ONE CHOKEPOINT FOR RULE 3: the row this store would ACTUALLY replace (templateSlot, after the
// form's own name re-types it) is checked here, by the same predicate every acquisition door asks
// up front (verifiedSlotRefusal / verifiedStoreRefusal). A human-verified row is never overwritten:
// the store throws VerifiedTemplateRefusal and touches nothing. The one waiver is the 60-day refresh
// re-storing THAT SAME ROW from its own source URL (refreshOfRowId): the AHJ revised the PDF, so the
// verified mapping is carried over and demoted to unverified (ahjFormRefresh).
export function storeAhjFormTemplate(
  db: AppDb,
  input: {
    ahjName: string; state: string; formType: string; filename: string; bytes: Uint8Array; map: StoredFieldMap;
    /** ONLY the 60-day refresh: the id of the row it re-fetched. A verified map in the slot is
     *  replaced (carried over, demoted) only when the slot IS that row; any other verified row is
     *  still refused. */
    refreshOfRowId?: string;
    /** Which building-side application this blank is, when the caller KNOWS (it went
     *  looking for the prescriptive one). Stamped onto the field map, and part of the
     *  storage key for building_application so the two mutually-exclusive blanks do
     *  not overwrite each other. Omit when unknown — the form's name is the fallback. */
    applicationKind?: "prescriptive" | "structural" | null;
    /** What the DOCUMENT says about itself ("Revised 12/23/2022"). "" when it
     *  says nothing — never a guess. From documentDateForPdf(bytes). */
    documentDate?: string;
    /** When WE pulled these bytes. Defaults to now; pass the row's existing
     *  value when re-storing bytes that were NOT freshly downloaded (a re-map
     *  off the stored blob), so a local operation cannot overstate freshness. */
    retrievedAt?: string;
    /** Did this blank carry a fee table we harvested? */
    feeTableFound?: boolean;
  },
): string {
  const slot = templateSlot(db, input);
  const refusal = verifiedRowRefusal(slot, { ahj: input.ahjName, formName: storeFormName(input), sourceUrl: String(input.map?.sourceUrl || "") });
  if (refusal && !(input.refreshOfRowId && slot.existing?.id === input.refreshOfRowId)) throw new VerifiedTemplateRefusal(refusal);
  const now = nowIso();
  const blob = Buffer.from(input.bytes);
  input.formType = slot.formType;
  const existing = slot.existing;
  const applicationKind = slot.applicationKind;
  // Stamp the content hash + check time so the periodic refresh can tell when the
  // AHJ has revised the form at its source URL. A fresh (re)mapping is always
  // UNVERIFIED — the operator must preview and verify before a real submit.
  input.map = {
    ...input.map,
    ...(applicationKind ? { applicationKind } : {}),
    sourceHash: sha256(input.bytes), lastCheckedAt: now, verified: false, verifiedAt: undefined,
  };
  return writeTemplateRow(db, input, blob, existing, now);
}

type TemplateSlotRow = { id: string; original_filename?: string; field_map?: string; source_url?: string };

/**
 * WHICH STORED ROW A BLANK REPLACES — the one answer storeAhjFormTemplate writes by and
 * verifiedSlotRefusal reads (so the refusal can never guard a different row than the store would
 * overwrite). Returns the classified form type, the row in this blank's slot (null = a new row)
 * and the building-side kind the row will carry.
 */
export function templateSlot(
  db: AppDb,
  input: { ahjName: string; state: string; formType: string; filename: string; map?: { formName?: string; sourceUrl?: string; applicationKind?: unknown }; applicationKind?: "prescriptive" | "structural" | null },
): { formType: string; existing: TemplateSlotRow | null; applicationKind: "prescriptive" | "structural" | null } {
  // THE FORM'S OWN NAME DECIDES WHAT IT IS. Callers pass a formType they inferred from the
  // context that sent them looking, which is often the generic "permit_application" — so
  // Coos Bay's "Building Permit Application.pdf" was stored as permit_application. That
  // matters because the portal-side upload sweep resolves an Accela slot labelled "Building
  // Permit Application" to docType building_application, looks for a file under that key,
  // finds nothing, and skips the slot in silence. The filled application existed on disk the
  // whole time. classifyFormType returns the caller's value when the name says nothing, so a
  // specific name wins and a generic caller is still respected.
  const formType = classifyFormType(input.filename || "", input.formType);
  // WHICH of the two building-side applications this blank is, stamped so nothing
  // downstream has to re-guess from a filename that may say nothing. The caller's
  // explicit answer wins (acquisition knows what it went looking for); then a stamp the
  // caller already put on the map; then the form's own name, and null when it makes no
  // claim. Resolved BEFORE the row lookup, because the kind is part of the building-side
  // storage key.
  const claimedKind: "prescriptive" | "structural" | null =
    input.applicationKind
    ?? (input.map?.applicationKind === "prescriptive" || input.map?.applicationKind === "structural" ? input.map.applicationKind : null)
    ?? formApplicationKind(`${input.map?.formName || ""} ${input.filename || ""}`);
  const incomingUrl = String(input.map?.sourceUrl || "");
  // ONE SLOT PER (ahj, state, form_type) — EXCEPT THE BUILDING SIDE, WHICH IS TWO FORMS.
  //
  // A jurisdiction on the separate-permit model publishes BOTH a prescriptive solar
  // application and a structural (non-prescriptive) one, and classifyFormType lands both
  // in `building_application`. Under a single slot, whichever was acquired first was
  // overwritten by the second — and hasStoredTemplateOfType then answered "already have
  // it" for a project on the OTHER path, permanently blocking acquisition of the blank it
  // actually needs. So the building-side slot is keyed by kind as well.
  //
  // Scoped to building_application deliberately: it is the only mutually-exclusive pair.
  // Widening the key to every form_type would turn a renamed re-upload of a checklist or
  // an electrical application into a duplicate row instead of an update.
  const kindKeyed = formType === "building_application";
  type ExistingRow = TemplateSlotRow;
  let existing: ExistingRow | null = null;
  // A RE-STORE MUST NOT AMNESIA THE STAMP. The 60-day refresh (ahjFormRefresh.ts) re-fetches
  // a row's own sourceUrl and re-stores the new bytes with a freshly BUILT field map — it
  // passes no applicationKind and its map carries none, so the kind fell back to the form's
  // NAME. For a structural blank published as "Building Permit Application.pdf" the name
  // claims nothing, so the refresh silently downgraded a stamped row to kind-less; worse, on
  // the building side the kind IS the storage key, so the re-store no longer matched its own
  // row and INSERTED a third, kind-less duplicate beside the two real applications. The
  // invariant belongs here, at the one chokepoint every writer passes through, not in the
  // refresh — an operator re-uploading the same blank is the same re-store.
  let inheritedKind: "prescriptive" | "structural" | null = null;
  if (kindKeyed) {
    const rows = db.query<ExistingRow>(
      "SELECT id, original_filename, field_map, source_url FROM ahj_form_templates WHERE lower(ahj_name) = lower(?) AND lower(state) = lower(?) AND form_type = ?",
      [input.ahjName, input.state, formType],
    );
    if (claimedKind) {
      // Replace the row that is the SAME application.
      existing = rows.find((row) => storedApplicationKind(row) === claimedKind) ?? null;
    } else {
      // No claim in hand. Bytes arriving from a row's OWN source URL are a re-store OF THAT
      // ROW, so it is the row to replace and its stamp is the answer. Matched on URL only:
      // a name match would let an operator's generically-named upload inherit a stamp that
      // belongs to a different application, and uploads carry sourceUrl "" so they cannot.
      const sameSource = incomingUrl ? rows.find((row) => String(row.source_url || "") === incomingUrl) ?? null : null;
      // Otherwise a kind-less incoming blank replaces a kind-less row (the
      // single-generic-form jurisdiction), never one of the two named applications.
      existing = sameSource ?? rows.find((row) => storedApplicationKind(row) === null) ?? null;
      if (existing) inheritedKind = storedApplicationKind(existing);
    }
  } else {
    existing = db.get<ExistingRow>(
      "SELECT id, original_filename, field_map, source_url FROM ahj_form_templates WHERE lower(ahj_name) = lower(?) AND lower(state) = lower(?) AND form_type = ? LIMIT 1",
      [input.ahjName, input.state, formType],
    ) ?? null;
    if (!claimedKind && existing) inheritedKind = storedApplicationKind(existing);
  }
  return { formType, existing, applicationKind: claimedKind ?? inheritedKind };
}

/** What a store input calls its blank, for a person: the map's form name, else the filename. */
const storeFormName = (input: { filename: string; map?: { formName?: string } }): string =>
  String(input.map?.formName || "").trim() || String(input.filename || "").replace(/\.pdf$/i, "");

/**
 * THE ONE PREDICATE (hard rule 3): does the row in this slot carry a HUMAN-VERIFIED map? Then the
 * new blank is not stored over it, and the answer says why and what a person does instead. null
 * when the slot is free or holds an unverified map.
 */
function verifiedRowRefusal(
  slot: ReturnType<typeof templateSlot>,
  who: { ahj: string; formName: string; sourceUrl: string },
): EnsureFormResult | null {
  const map = slot.existing ? parseJson<{ verified?: boolean; formName?: string }>(String(slot.existing.field_map || "{}"), {}) : null;
  if (!map || map.verified !== true) return null;
  const held = map.formName || String(slot.existing?.original_filename || "").replace(/\.pdf$/i, "") || `${who.ahj} ${slot.formType.replace(/_/g, " ")}`;
  return {
    status: "exists", formName: held, sourceUrl: who.sourceUrl, mappedFields: 0,
    message: `${who.ahj}'s ${slot.formType.replace(/_/g, " ")} slot holds a HUMAN-VERIFIED field map ("${held}"), so ${who.formName} was not stored over it and was not mapped. The verified form is kept exactly as confirmed; to replace it, mark it unverified first, then upload again.`,
  };
}

/**
 * Would storeAhjFormTemplate refuse THIS store input? Asked with the store's own input shape (its
 * real filename, map.formName, map.sourceUrl, applicationKind), so it resolves the very row the
 * store would replace. For a door that wants to skip work (a model call, a download) before storing.
 */
export function verifiedStoreRefusal(db: AppDb, input: Parameters<typeof templateSlot>[1]): EnsureFormResult | null {
  return verifiedRowRefusal(templateSlot(db, input), { ahj: input.ahjName, formName: storeFormName(input), sourceUrl: String(input.map?.sourceUrl || "") });
}

/**
 * A HUMAN-VERIFIED MAP IS NEVER OVERWRITTEN BY AN ACQUISITION (hard rule 3). The acquisition's shape
 * of verifiedStoreRefusal: acquireFromBytes stores `${formName}.pdf` with this formName / sourceUrl /
 * kind, so this is the slot its store would replace. (The 60-day refresh is a different door on
 * purpose: an AHJ's revised PDF demotes a verified map to unverified and carries the mapping over —
 * ahjFormRefresh, storeAhjFormTemplate's refreshOfRowId.)
 */
export function verifiedSlotRefusal(
  db: AppDb,
  input: { ahj: string; state: string; formType: string; formName: string; sourceUrl: string; applicationKind?: "prescriptive" | "structural" | null },
): EnsureFormResult | null {
  return verifiedStoreRefusal(db, {
    ahjName: input.ahj, state: input.state, formType: input.formType, filename: `${input.formName}.pdf`,
    map: { formName: input.formName, sourceUrl: input.sourceUrl }, applicationKind: input.applicationKind ?? null,
  });
}

/** The row write for storeAhjFormTemplate: an UPDATE of the slot's row, else an INSERT. */
function writeTemplateRow(
  db: AppDb,
  input: Parameters<typeof storeAhjFormTemplate>[1],
  blob: Buffer,
  existing: TemplateSlotRow | null,
  now: string,
): string {
  // PROVENANCE FOLLOWS THE BYTES. sourceUrl lives in the field map already and
  // every caller sets it, so the column mirrors it rather than inventing a
  // second answer; the column is what makes it selectable, sortable and
  // showable without parsing every row's JSON.
  //
  // On the update path all four are written UNCONDITIONALLY, blanks included.
  // The blob is being replaced, so carrying a previous document_date forward
  // would attach the OLD document's revision line to the NEW document — which
  // is the precise lie this work exists to stop.
  const sourceUrl = String(input.map.sourceUrl || "");
  const documentDate = String(input.documentDate || "");
  // undefined means "these are fresh bytes, stamp now"; an explicit "" means
  // "we genuinely do not know when this arrived" and must survive as blank.
  const retrievedAt = input.retrievedAt === undefined ? now : String(input.retrievedAt);
  const feeTableFound = input.feeTableFound ? 1 : 0;
  if (existing) {
    db.run(
      `UPDATE ahj_form_templates
          SET original_filename = ?, pdf_blob = ?, field_map = ?,
              source_url = ?, document_date = ?, retrieved_at = ?, fee_table_found = ?, updated_at = ?
        WHERE id = ?`,
      [input.filename, blob, JSON.stringify(input.map), sourceUrl, documentDate, retrievedAt, feeTableFound, now, existing.id],
    );
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO ahj_form_templates (id, ahj_name, state, form_type, original_filename, pdf_blob, moat_data, field_map, notes,
       source_url, document_date, retrieved_at, fee_table_found, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, '', ?, ?, ?, ?, ?, ?)`,
    [id, input.ahjName, input.state, input.formType, input.filename, blob, JSON.stringify(input.map),
      sourceUrl, documentDate, retrievedAt, feeTableFound, now, now],
  );
  return id;
}

// Build the field map for a blank PDF's bytes using its AcroForm fields. Returns
// null when the PDF has no fillable fields (flat/scanned/XFA) — those can't be
// auto-filled without coordinate overlays and are routed to a human.
//
// THE MAPPER SEES WHAT THE APPLICANT SEES. It used to get widget NAMES only, and auto-generated
// names are often shifted onto the neighbouring box: Waltham's "Telephone" widget is the agent's
// Email Address box, so the homeowner's phone number was mapped into it. Each field now goes with
// its page and the printed caption(s) around it (inspectPlacedFields) — the blank's own text,
// never a field value and never project data (hard rule 2: the mapper gets names and captions).
// What the model returns then passes the deterministic checks (formFieldChecks.sanitizeAcroMap).
export async function buildFieldMapForPdf(
  llm: LLMProvider,
  input: { ahj: string; state: string; formName: string; bytes: Uint8Array },
): Promise<{ textFields: Record<string, string>; checkboxes: Record<string, { source: string; equals?: string }>; notes: string; fieldCount: number; fields: InspectedField[]; operatorItems: OperatorItem[]; labels: LabelItem[] } | null> {
  const inspected = await inspectPlacedFields(input.bytes);
  if (inspected.isXfa || inspected.fields.length === 0) return null;
  const mapped = await llm.mapAcroFormFields({
    ahj: input.ahj,
    state: input.state,
    formName: input.formName,
    fields: inspected.fields.map((f) => ({
      name: f.name, type: f.type,
      ...(f.page != null ? { page: f.page } : {}),
      ...(f.caption ? { caption: f.caption } : {}),
      ...(f.captions && Object.keys(f.captions).length ? { captions: f.captions } : {}),
    })),
    captionSide: inspected.captionSide,
    availableSources: fieldSourcesForState(input.state),
  });
  const checked = sanitizeAcroMap({
    widgets: inspected.fields, items: inspected.labels, state: input.state,
    textFields: mapped.textFields, checkboxes: mapped.checkboxes,
  });
  const notes = [mapped.notes, ...checked.notes].filter(Boolean).join(" ");
  return {
    textFields: checked.textFields, checkboxes: checked.checkboxes, notes, fieldCount: inspected.fields.length,
    fields: inspected.fields, operatorItems: [...(mapped.operatorItems ?? []), ...checked.operatorItems],
    labels: inspected.labels,
  };
}

/** The tallest a signature box may be. Signature rules on real permit forms sit 9-20pt
 *  apart — measured on Portland's electrical application, whose tightest is 9pt. */
export const MAX_SIGNATURE_BOX_PT = 30;
/** Below this a signature is a smudge regardless of the row. */
export const MIN_SIGNATURE_BOX_PT = 8;

/**
 * Convert a vision-reported signature area to a PDF-point box.
 *
 * `ny` is the BOTTOM-left corner measured from the TOP of the page — the prompt says so in
 * as many words — so flipping it (`(1 - ny) * pageHeight`) already gives the box's bottom in
 * PDF coordinates, which is exactly what pdf-lib's drawImage anchors on.
 *
 * It used to subtract the box height as well, on the stated reasoning that this made the
 * image "sit just above the printed line". Subtracting moves ink DOWN, so every vision-mapped
 * signature landed a full box-height BELOW its own rule — roughly 26pt of ink hanging under
 * the line, spanning two rows on a normal form. It went unnoticed because the one form anyone
 * had inspected closely, Portland's, is hand-tuned in the registry and never passes through
 * this conversion.
 *
 * The height is clamped because heightFrac defaults to 0.04, or 32pt on US Letter — taller
 * than any signature row on a permit form.
 */
export function visionSignatureBox(ny: number, heightFrac: number, pageHeight: number): { y: number; height: number } {
  const raw = Number.isFinite(heightFrac) ? heightFrac * pageHeight : 0;
  const height = Math.max(MIN_SIGNATURE_BOX_PT, Math.min(MAX_SIGNATURE_BOX_PT, Math.round(raw)));
  const y = Math.round((1 - ny) * pageHeight);
  return { y, height };
}

// Vision-map a FLAT (non-AcroForm) PDF: render each page to an image, ask the
// vision model where each value goes, and convert the normalized coordinates to
// PDF-point overlay placements (bottom-left origin) that fillLoadedForm draws.
// Computed once and stored, so later projects reuse it with no further LLM cost.
export async function buildOverlayMapForPdf(
  llm: LLMProvider,
  input: { ahj: string; state: string; formName: string; bytes: Uint8Array },
): Promise<{ overlayFields: OverlayField[]; signatureFields: SignaturePlacement[]; notes: string; operatorItems: OperatorItem[] } | null> {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");

  let pageSizes: { w: number; h: number }[] = [];
  try {
    const doc = await PDFDocument.load(input.bytes, { ignoreEncryption: true });
    const n = Math.min(doc.getPageCount(), 3);
    for (let i = 0; i < n; i++) {
      const sz = doc.getPage(i).getSize();
      pageSizes.push({ w: sz.width, h: sz.height });
    }
  } catch {
    return null;
  }
  if (!pageSizes.length) return null;

  // renderPdfPageToPng works off a file path — write the blank to a temp file.
  const tmp = path.join(os.tmpdir(), `ahj-flat-${crypto.randomUUID()}.pdf`);
  const pages: { base64: string; mimeType: "image/png" }[] = [];
  try {
    fs.writeFileSync(tmp, Buffer.from(input.bytes));
    for (let i = 0; i < pageSizes.length; i++) {
      const png = await renderPdfPageToPng(tmp, i + 1, 1.6);
      pages.push({ base64: png.toString("base64"), mimeType: "image/png" });
    }
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }

  const mapped = await llm.mapFlatFormOverlay({
    ahj: input.ahj,
    state: input.state,
    formName: input.formName,
    pages,
    availableSources: fieldSourcesForState(input.state),
  });
  const operatorItems: OperatorItem[] = [...(mapped.operatorItems ?? [])];
  // Never an attestation of an attached document (a workers'-comp affidavit "Yes" box): named for
  // the operator, never drawn.
  const placeable = mapped.fields.filter((f) => {
    if (!attestsAttachedDocument(f.label)) return true;
    operatorItems.push({ label: `${String(f.label).trim()} (an attestation — attach the document and tick by hand)` });
    return false;
  });
  if (!placeable.length && !mapped.signatures.length) return operatorItems.length ? { overlayFields: [], signatureFields: [], notes: mapped.notes, operatorItems } : null;

  const overlayFields: OverlayField[] = placeable.map((f) => {
    const sz = pageSizes[f.page] || pageSizes[0];
    return {
      source: f.source,
      page: f.page,
      x: Math.round(f.nx * sz.w),
      y: Math.round((1 - f.ny) * sz.h), // flip: ny is from top, PDF y from bottom
      size: f.size && f.size > 0 ? f.size : 9,
      ...(f.maxWidthFrac && f.maxWidthFrac > 0 ? { maxWidth: Math.round(f.maxWidthFrac * sz.w) } : {}),
      // Persist the label so the fill can anchor to the form's real text baseline
      // (fixes the vision y-drift). The LLM already returns it; we stopped dropping it.
      ...(f.label && f.label.trim() ? { label: f.label.trim() } : {}),
    };
  });
  const signatureFields: SignaturePlacement[] = mapped.signatures.map((sg) => {
    const sz = pageSizes[sg.page] || pageSizes[0];
    const box = visionSignatureBox(sg.ny, sg.heightFrac, sz.h);
    const hasDate = sg.dateNx != null && sg.dateNy != null;
    return {
      role: sg.role,
      page: sg.page,
      x: Math.round(sg.nx * sz.w),
      y: box.y,
      width: Math.round(sg.widthFrac * sz.w),
      height: box.height,
      label: sg.label,
      ...(hasDate ? { dateX: Math.round(sg.dateNx! * sz.w), dateY: Math.round((1 - sg.dateNy!) * sz.h), dateSize: 9 } : {}),
    };
  });
  return { overlayFields, signatureFields, notes: mapped.notes, operatorItems };
}

/** THE "ahj_form.find" AUDIT DETAILS (server find-ahj-form). THE WHY IS KEPT — Waltham's audit said
 *  "not_found" and nothing else, so nobody could see what the search found, read or could not run.
 *  The message carries the forms page read, the links tried and "the form search could not run":
 *  AHJ facts, never project values. */
export function formFindAuditDetails(
  ahj: string,
  ensure: Pick<EnsureFormResult, "status" | "message" | "formName" | "permitType" | "sourceUrl" | "lookupFailed">,
  additional: Array<{ formType: string; status: string; message: string }>,
): Record<string, unknown> {
  return {
    status: ensure.status, formName: ensure.formName || "", ahj, permitType: ensure.permitType || "",
    message: String(ensure.message || "").slice(0, 2000),
    lookupFailed: Boolean(ensure.lookupFailed),
    sourceUrl: ensure.sourceUrl || "",
    additional: additional.map((a) => `${a.formType}:${a.status}`),
    additionalMessages: additional.map((a) => `${a.formType}: ${String(a.message || "").slice(0, 600)}`),
  };
}

/** Where the forms page is read from, and how gently: the reader (default: the per-job lookup's
 *  reader switches — defaultLookupReader — with a budget of two pages, shared by every form type of
 *  one pass so a forms page is read once) and the gap before a download from a host we just asked
 *  (default PAGE_READ_MIN_GAP_MS). Tests inject both. */
export interface FormsPageOptions {
  reader?: PageReader | null;
  minGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Normalize the model's STRUCTURED platform answer + the portal URL to a canonical platform + method.
// Never a regex over its free-text notes: a note that DENIES a platform ("ProjectDox is STALE ...
// replaced by EnerGov", "No Accela/ePermitting/ProjectDox portal applies here") stored ProjectDox for
// Iowa City, Waltham, Northern Cambria, Corry and Venus in the shared knowledge base (new-AHJ e2e
// test, 2026-09-26). Accela is "Oregon ePermitting" only on Oregon's own instance, never Lee County's.
export function canonicalPortal(research: AhjFormUrlResult): { platform: string; method: string } {
  const label = `${research.portalPlatform || ""} ${research.submissionMethod || ""}`.toLowerCase();
  const method = String(research.submissionMethod || "").toLowerCase();
  let host = "";
  try { host = research.submittalPortalUrl ? new URL(research.submittalPortalUrl).hostname.toLowerCase() : ""; } catch { host = ""; }
  if (/projectdox|avolve/.test(host) || /projectdox|avolve/.test(label)) return { platform: "ProjectDox", method: "online portal" };
  if (host === "aca-oregon.accela.com" || /oregon\s*e-?permitting/.test(label)) return { platform: "Oregon ePermitting", method: "online portal" };
  if (/(^|\.)accela\.com$/.test(host) || /\baccela\b|citizen access/.test(label)) return { platform: "Accela Citizen Access", method: "online portal" };
  if (/portland.*(portal|hub|devhub|development hub)/.test(label)) return { platform: "Portland Portal", method: "online portal" };
  if (!host && /\be-?mail\b/.test(method) && !/portal|online|in[- ]person/.test(method)) return { platform: "Email", method: "email" };
  return { platform: research.portalPlatform || "", method: research.submissionMethod || "" };
}

// Persist the discovered submittal portal/platform/requirements so the record-portal
// training step pre-fills the portal URL for a new AHJ and future projects reuse it.
function learnAhjPortalFromResearch(db: AppDb, project: ProjectRecord, research: AhjFormUrlResult): void {
  if (!project.ahj || !project.state) return;
  const { platform, method } = canonicalPortal(research);
  // THE FORMS PAGE IS KEPT (Waltham: the search's "why" was dropped, so nobody could see where it
  // looked). In ONE place — its own note segment (formsPageUrl below), never in the free-text notes —
  // and only when it is on the AHJ's own site (isAhjFormsSite, the predicate the harvest reads it
  // under): another town's forms page is never written into THIS AHJ's shared KB row, and a result
  // carrying nothing else writes no row at all (forms-find skeptic F1). It steers the next search
  // through knowledgeResearchHint.
  const formsPageUrl = research.formsPageUrl && isAhjFormsSite(portalHostOf(research.formsPageUrl), [project.ahj], project.state) ? research.formsPageUrl : "";
  if (!platform && !method && !research.submittalPortalUrl && !formsPageUrl) return;
  const notes = [
    research.submittalRequirements ? `Submittal requirements: ${research.submittalRequirements}` : "",
    research.notes || "",
  ].filter(Boolean).join(" · ");
  try {
    saveResearchedAhjProfile(db, { state: project.state, ahj: project.ahj }, {
      provider: "claude",
      portalName: platform || "",
      portalUrl: research.submittalPortalUrl || "",
      portalPlatform: platform || "",
      submissionMethod: method || "",
      requiredDocuments: [], commonCorrections: [], submissionSteps: [], tips: [],
      confidence: research.confidence,
      notes,
      needsHumanVerification: true,
      formsPageUrl,
    });
  } catch { /* non-fatal */ }
}

// ── THE AHJ'S OWN APPLICATION, FOUND WITHOUT ANOTHER MODEL CALL (Waltham, 2026-09-28) ─────────────
// The search named City of Waltham's forms page (/1289/Applications) and received its document
// links in the raw results, but the only candidates were the model's own list — empty — so a public
// "Residential Application" (/DocumentCenter/View/4313/…, application/pdf) was reported as no form.
// Two deterministic widenings, no extra LLM spend, both through the catalog's document predicates
// (permitPlatformCatalog.classifyApplicationDocument — DOCUMENT_URL, FEE_LINK, OTHER_FEE_KIND):
//   (b) the forms page research returned, read ONCE through the lookup's polite page reader, when it
//       is on the AHJ's own site (isAhjFormsSite) — its links on that site only (applicationFormLinks);
//   (a) the search results the call received, on the AHJ's own site (isAhjFormsSite again — a search
//       returns other towns' forms too). ONE predicate for "the AHJ's own site" at every door: the
//       forms page's REDIRECT target is never a second admission (a page that lands off-site admitted
//       every search result on the landing domain).
// A utility host is never a candidate (rule 5), and fetchPdf still decides what is a PDF.
export const APPLICATION_FORM_TYPES = ["permit_application", "building_application", "electrical_application"];
const MAX_PAGE_CANDIDATES = 3;
const MAX_SEARCH_CANDIDATES = 2;
interface FormCandidate {
  url: string;
  /** The words that name it: the link's text or the search result's title ("" for the model's list). */
  label: string;
  origin: "research" | "forms-page" | "search-result" | "kb";
  discipline?: ApplicationDiscipline;
}
/** May an application of this discipline be THIS slot's primary blank? An electrical-only
 *  application is never the building-side / generic blank; the electrical slot takes only an
 *  electrical one — a COMBINED building + electrical form is the building side's (classifyFormType
 *  stores it as building_application, so taken for the electrical slot it would never fill it). */
export function disciplineFitsSlot(discipline: ApplicationDiscipline, formType: string): boolean {
  if (formType === "electrical_application") return discipline === "electrical";
  return discipline !== "electrical";
}
/** A URL that is never this slot's application whoever proposed it: a utility host (rule 5), and —
 *  for an application slot — a document whose own name says fee schedule / agenda / minutes /
 *  newsletter (an opaque URL says nothing and is left to fetchPdf, as before). */
export function neverTheApplication(url: string, formType: string): boolean {
  if (isUtilityPlatformUrl(url)) return true;
  if (!APPLICATION_FORM_TYPES.includes(formType)) return false;
  const slug = documentSlugWords(url);
  return Boolean(slug) && /fee schedule|schedule of fees|fee table|master fee|agenda|minutes|newsletter/i.test(slug);
}
/** The process-wide last request per host made by this module's harvest (go gently: >= the gap
 *  between two requests to one host, after the forms page read too). */
const formHostLastAt = new Map<string, number>();
async function politeGap(url: string, fp: FormsPageOptions): Promise<void> {
  const host = portalHostOf(url);
  const gap = fp.minGapMs ?? PAGE_READ_MIN_GAP_MS;
  const wait = (formHostLastAt.get(host) ?? 0) + gap - Date.now();
  if (host && gap > 0 && wait > 0) await (fp.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(wait);
}
function noteHostHit(url: string): void {
  const host = portalHostOf(url);
  if (host) formHostLastAt.set(host, Date.now());
}
/** The reader for forms pages when none is injected: the per-job lookup's switches (a model key,
 *  PERMIT_LOOKUP_PAGE_READ, DOCUMENT_FETCH), two pages. Null = no page is read. */
export async function defaultFormsPageReader(): Promise<PageReader | null> {
  try {
    const { defaultLookupReader } = await import("./permitProcessLookup");
    return defaultLookupReader(2);
  } catch {
    return null;
  }
}
async function harvestApplicationCandidates(
  project: ProjectRecord,
  formType: string,
  applicationKind: "prescriptive" | "structural" | null,
  research: AhjFormUrlResult,
  fp: FormsPageOptions,
): Promise<{ candidates: FormCandidate[]; note: string; refusedDomains: Set<string> }> {
  if (!APPLICATION_FORM_TYPES.includes(formType)) return { candidates: [], note: "", refusedDomains: new Set<string>() };
  const names = [project.ahj].filter(Boolean);
  // The other of the two building-side applications is not this one (the same test the KB links pass).
  const kindOk = (label: string, url: string) => {
    const k = formApplicationKind(`${url} ${label}`);
    return !(k && applicationKind && k !== applicationKind);
  };
  const rank = (a: { discipline: ApplicationDiscipline; score: number }, b: { discipline: ApplicationDiscipline; score: number }) =>
    Number(disciplineFitsSlot(b.discipline, formType)) - Number(disciplineFitsSlot(a.discipline, formType)) || b.score - a.score;
  const notes: string[] = [];
  const fromPage: FormCandidate[] = [];
  /** Sites that REFUSED the forms page read (a challenge, a wall, 401/403/429 — isRefusal): nothing
   *  this harvest found is requested from them (go gently — the reader has backed the host off). */
  const refusedDomains = new Set<string>();
  const page = String(research.formsPageUrl || "");
  if (page) {
    const host = portalHostOf(page);
    if (!isAhjFormsSite(host, names, project.state)) {
      notes.push(`The forms page the search named (${page}) is not on ${project.ahj}'s own site, so it was not read.`);
    } else if (DOCUMENT_URL.test(page)) {
      notes.push(`The search named a document (${page}) as the forms page; it was not read as a page.`);
    } else {
      const reader = fp.reader !== undefined ? fp.reader : await defaultFormsPageReader();
      if (!reader) {
        notes.push(`The forms page ${page} was not read (page reading is off on this installation), so its links were not checked.`);
      } else {
        await politeGap(page, fp);
        const read = await reader.read(page);
        noteHostHit(page);
        if (read.finalUrl) noteHostHit(read.finalUrl);
        if (!read.ok && isRefusal(read.status, read.reason)) {
          // A REFUSAL IS NOT ASKED AGAIN IN THE SAME BREATH: the search results on that site are
          // dropped too (they would be the next requests to a host that just refused us).
          for (const h of [host, portalHostOf(read.finalUrl)]) if (h) refusedDomains.add(registrableDomain(h));
          notes.push(`The forms page ${page} refused the read (${read.reason || `HTTP ${read.status}`}), so nothing else was requested from that site — not a finding about ${project.ahj}.`);
        } else if (!read.ok || read.kind !== "html") {
          notes.push(`The forms page ${page} could not be read (${read.reason || read.kind}), so its links were not checked — not a finding about ${project.ahj}.`);
        } else {
          const links = applicationFormLinks([read], names, project.state).filter((l) => kindOk(l.text, l.href)).sort(rank);
          for (const l of links.slice(0, MAX_PAGE_CANDIDATES)) fromPage.push({ url: l.href, label: l.text, origin: "forms-page", discipline: l.discipline });
          notes.push(links.length
            ? `Read the forms page ${page}: ${links.length} permit application link(s) on ${project.ahj}'s site.`
            : `Read the forms page ${page}: no permit application document is linked on it.`);
        }
      }
    }
  }
  const fromSearch: Array<FormCandidate & { score: number; discipline: ApplicationDiscipline }> = [];
  for (const r of research.searchResults ?? []) {
    const host = portalHostOf(r.url);
    if (!host || isUtilityPlatformUrl(r.url) || fromPage.some((c) => c.url === r.url)) continue;
    if (!isAhjFormsSite(host, names, project.state) || refusedDomains.has(registrableDomain(host))) continue;
    const doc = classifyApplicationDocument(r.title, r.url);
    if (!doc || !kindOk(r.title, r.url)) continue;
    fromSearch.push({ url: r.url, label: r.title, origin: "search-result", ...doc });
  }
  fromSearch.sort(rank);
  if (fromSearch.length) notes.push(`${fromSearch.length} search result(s) on ${project.ahj}'s site name a permit application.`);
  return { candidates: [...fromPage, ...fromSearch.slice(0, MAX_SEARCH_CANDIDATES).map(({ score: _s, ...c }) => c)], note: notes.join(" "), refusedDomains };
}

// Classify a downloaded PDF into a form_type from its name/URL, so one research
// pass that surfaces the building app + electrical app + checklist stores each
// under its own slot instead of overwriting a single "permit_application" row.
export function classifyFormType(nameOrUrl: string, fallback: string): string {
  const t = (nameOrUrl || "").toLowerCase();
  // The Iowa SFM PV worksheet is an ELECTRICAL worksheet, not the path-scoped prescriptive
  // checklist: a caller that recognised it (by its anchors) keeps its own type.
  if (fallback === PV_WORKSHEET_DOC_TYPE) return fallback;
  if (/checklist|worksheet|eligibilit/.test(t)) return "solar_checklist";
  // A COMBINED building + electrical application ("Building & Wiring", "Building/Electrical Permit
  // Application") is the BUILDING side's — the one answer the harvest reads too
  // (permitPlatformCatalog.headDiscipline). Filed as electrical, it replaced the AHJ's real electrical
  // application and left the building / generic slot unsatisfied (a paid re-search on every pass).
  if (namesCombinedApplication(t)) return "building_application";
  // A WIRING permit is the electrical permit (Massachusetts towns' "Wiring Permit Application") — but
  // only as a permit phrase (WIRING_PERMIT_PHRASE): a "Sample Wiring Diagram", a "wire transfer" or a
  // "wire fraud" notice is not the AHJ's electrical application.
  if (/electrical|ele[-_ ]?permit/.test(t) || WIRING_PERMIT_PHRASE.test(t)) return "electrical_application";
  if (/building|structural|bld[-_ ]?permit/.test(t)) return "building_application";
  return fallback;
}

// Does this AHJ already have a stored template of THIS form type? — formAcquisitionPlan
// .hasStoredTemplateOfType (re-exported above). `applicationKind` narrows further, and is what stops
// the two mutually-exclusive building-side applications from being treated as one holding: asking
// "do we have a building_application?" answered YES off the STRUCTURAL blank for a project on the
// PRESCRIPTIVE path, so acquisition of the prescriptive one was skipped forever.

/**
 * WHICH STORED FORM TYPES SATISFY THIS SLOT — the one answer the "already held?" check and the
 * "usable?" check both read (ensureAhjFormTemplate).
 *   - building_application: the building blank, or the generic application blank (a blank whose name
 *     says neither is stored generic — requiredDocuments' altDocTypes, the same alias);
 *   - permit_application (the generic / baseline slot) where the permit structure is ONE permit or not
 *     known: the generic blank, or a BUILDING application. storeAhjFormTemplate re-types a blank by
 *     its own name, so a "Building Permit Application" fetched for this slot is stored as
 *     building_application — and a slot that accepted only permit_application re-searched (paid) and
 *     re-downloaded it on EVERY pass (forms-find skeptic, the re-type loop). Where the permits are
 *     SEPARATE the generic slot is not a building one, and it keeps its own type;
 *   - anything else (electrical_application above all — one generic blank never satisfies both the
 *     building side and the electrical one): its own type only.
 */
export function storedTypesForSlot(formType: string, structure: "separate" | "combo" | "unknown"): string[] {
  return acceptedFormTypes(formType, structure);
}

/** The full set of forms this AHJ needs for a residential solar submission —
 *  the main application(s) plus any required checklist — acquired in one pass.
 *  Sources for "what's needed": the AHJ process profile flags and the KB's
 *  imported required-documents list. Each acquisition stores + learns, so the
 *  next project under this AHJ skips the research entirely. */
export interface NeededAhjForm {
  formType: string;
  /** WHICH building-side application, when the required set names one. Carried
   *  through acquisition so a prescriptive project goes after the PRESCRIPTIVE
   *  blank rather than "whatever is stored under building_application". */
  applicationKind: "prescriptive" | "structural" | null;
}

export async function ensureAhjFormsForProject(
  db: AppDb,
  llm: LLMProvider,
  project: ProjectRecord,
  /** allowMapping: may a CITED agency PDF be mapped by the model when research is off? Defaults to
   *  allowResearch. Stage's no-research pass inside the cooldown sets it from the process's research
   *  switch (prepareOfficialDocuments) — one mapping per cited form, never a search.
   *  skipRecentlyFailed: do not re-fetch a curated/cited/checklist URL whose download failed within
   *  FORM_FETCH_RETRY_MS (recentFormFetchFailure) — set ONLY by Stage's pass inside the cooldown; the
   *  operator's "Find missing official forms" (server find-ahj-form) never sets it. */
  opts: { allowResearch?: boolean; allowMapping?: boolean; skipRecentlyFailed?: boolean; formsPage?: FormsPageOptions } = {},
): Promise<{ neededTypes: string[]; needed: NeededAhjForm[]; results: Array<EnsureFormResult & { formType: string; applicationKind: "prescriptive" | "structural" | null }> }> {
  // WHAT THIS PROJECT MUST FILE DECIDES WHAT WE GO AND FETCH.
  //
  // This used to be the constant ["permit_application"], which is why a
  // separate-permit AHJ — Coos Bay files a BLD permit and an ELE permit, and its
  // process profile says so in two flags — only ever had its building
  // application acquired. The electrical one arrived by luck (the download loop
  // classifies whatever extra blanks a research pass trips over) or not at all.
  // The same constant also re-ran a paid research pass on every "Find official
  // form" click, because the blank is STORED as building_application (the form's
  // own name decides) and hasStoredTemplateOfType was asked about
  // permit_application. A discipline-keyed needed set fixes both.
  //
  // AND WHICH ONE OF THE TWO. requiredApplicationDocs already decides, by permit path,
  // which of the two mutually-exclusive building-side applications this project owes —
  // and the acquisition side used to throw that away, keeping only item.docType. So a
  // PRESCRIPTIVE project researched a generic "building application", and a structural
  // blank whose filename says nothing satisfied it on every path. The kind travels with
  // the slot now.
  const needed = new Map<string, NeededAhjForm>();
  const want = (formType: string, applicationKind: "prescriptive" | "structural" | null = null): void => {
    const prior = needed.get(formType);
    // A named kind is strictly more information than none; never let a later
    // unqualified mention erase one.
    if (prior && (prior.applicationKind || !applicationKind)) return;
    needed.set(formType, { formType, applicationKind });
  };
  try {
    for (const item of requiredApplicationDocs(project, applicationDocContext(project))) {
      want(item.docType, item.applicationKind ?? null);
    }
  } catch { /* profile data optional — the baseline slot below still runs */ }
  // THE BASELINE SLOT. An AHJ we have no structure/flags for still gets its one
  // application pulled, and a blank whose own name says nothing falls through
  // classifyFormType to this generic type — so it has to be a slot we asked for.
  // It still carries the project's path, because even the generic slot should go
  // looking for the right one of the two when the AHJ turns out to publish both.
  if (!needed.has("building_application") && !needed.has("permit_application")) {
    let baselineKind: "prescriptive" | "structural" | null = null;
    try { baselineKind = applicationKindForProject(project); } catch { /* path optional */ }
    want("permit_application", baselineKind);
  }
  try {
    const proc = findAhjProcessProfile(project);
    if (proc?.requiresSolarChecklist && resolvePermitPath(project).path !== "engineered") want("solar_checklist");
  } catch { /* profile data optional */ }
  try {
    const kb = findKnowledgeForLearn(db, { state: project.state, ahj: project.ahj, utility: project.utility });
    if (resolvePermitPath(project).path !== "engineered" && (kb.ahj?.requiredDocuments || []).some((d) => /checklist|worksheet/i.test(d))) want("solar_checklist");
  } catch { /* KB optional */ }
  const results: Array<EnsureFormResult & { formType: string; applicationKind: "prescriptive" | "structural" | null }> = [];
  // ONE reader for every form type of this pass (its cache reads a forms page once) — created only
  // when research may run; with research off no forms page is ever named, so none is read.
  let formsPage: FormsPageOptions | undefined = opts.formsPage;
  if (opts.allowResearch !== false && formsPage?.reader === undefined) formsPage = { ...(formsPage ?? {}), reader: await defaultFormsPageReader() };
  for (const item of needed.values()) {
    results.push({
      formType: item.formType,
      applicationKind: item.applicationKind,
      ...(await ensureAhjFormTemplate(db, llm, project, item.formType, { applicationKind: item.applicationKind, allowResearch: opts.allowResearch, allowMapping: opts.allowMapping, skipRecentlyFailed: opts.skipRecentlyFailed, formsPage })),
    });
  }
  return { neededTypes: [...needed.keys()], needed: [...needed.values()], results };
}

// WHICH of the two building-side applications a form search is for — and NONE where the split does
// not exist — is formAcquisitionPlan.applicationKindForProject (re-exported above): outside Oregon
// resolvePermitPath says standardReview, and the search must not be told "find the STRUCTURAL one,
// not the prescriptive one" (the Iowa City form finder, e2e-gap close 2026-09-26).

// Ensure the AHJ has a usable stored form. Research → download → map → store.
export async function ensureAhjFormTemplate(
  db: AppDb,
  llm: LLMProvider,
  project: ProjectRecord,
  formType = "permit_application",
  opts: { applicationKind?: "prescriptive" | "structural" | null; allowResearch?: boolean; allowMapping?: boolean; skipRecentlyFailed?: boolean; formsPage?: FormsPageOptions } = {},
): Promise<EnsureFormResult> {
  // THE UTILITY'S FILING LOCATION rides every per-project form-research pass — the pipeline's
  // (ensureAhjFormsForProject) and the operator's "Find official form" — fire-and-forget, once per
  // utility (shared, deduped in utilityFilingLookup): where the interconnection application is
  // filed and what the program is. Nothing here waits on it; the tracks read the stored row.
  if (opts.allowResearch !== false) {
    try { ensureUtilityFilingLookedUp(db, project, llm); } catch { /* best-effort */ }
    // AND THE AHJ'S OWN PROCESS (Waltham had no permit_process_lookups row: the lookup shipped after
    // its one QC, and QC was its only trigger). The same trigger QC uses — enqueued once per AHJ with
    // no lookup row and no process profile, deduped for 24h, a no-op without a model key or a running
    // job worker. Fire-and-forget; nothing here waits on it.
    void import("./permitProcessLookup").then((m) => m.ensurePermitProcessLookedUp(db, project)).catch(() => undefined);
  }
  // WHICH of the two building-side applications this call is for. Given by the caller
  // (the required set decided it from the permit path); otherwise resolved from the
  // project, so a direct "find official form" click is path-aware too.
  let applicationKind = opts.applicationKind ?? null;
  if (!applicationKind && (formType === "building_application" || formType === "permit_application")) {
    try { applicationKind = applicationKindForProject(project); } catch { /* path optional */ }
  }
  // WHOSE FORM THIS IS (applicationDocsAgency.formAuthorityFor — the one predicate). Where the
  // per-job lookup cites ANOTHER agency as this track's issuer, the application is that agency's:
  // acquired and stored under ITS name, from its own curated seed or the PDF the lookup cited —
  // never a paid search under the city's name, never a KB profile written for the agency.
  const authority = formAuthorityFor(project, formType);
  if (authority.issuedByOther) return ensureIssuingAgencyForm(db, llm, project, formType, authority, applicationKind, { allowResearch: opts.allowResearch, allowMapping: opts.allowMapping, skipRecentlyFailed: opts.skipRecentlyFailed });
  const kindWord = applicationKind === "structural" ? "structural (non-prescriptive)" : applicationKind === "prescriptive" ? "prescriptive" : "";
  // Already have a fillable stored template of THIS form type for this AHJ?
  // (Per-type, so acquiring the checklist isn't skipped just because the
  // permit application is already stored.) Kind-scoped on the building side: a
  // stored STRUCTURAL blank is not the prescriptive application, and answering
  // "exists" off it is what left a prescriptive project permanently without the
  // only form its AHJ will accept.
  // The building-side row accepts the generic application blank (requiredDocuments' altDocTypes):
  // an AHJ whose one stored application is filed as "permit_application" has its building-side form
  // once its structure resolves SEPARATE (building + electrical) — the same alias the inventory uses.
  // And the generic slot accepts the building blank it was re-typed to — the gate's own answer.
  const acceptedTypes = acceptedFormTypesFor(project, formType);
  if (acceptedTypes.some((t) => hasStoredTemplateOfType(db, project.ahj, project.state, t, applicationKind))) {
    const usable = loadStoredTemplates(db, project.ahj, project.state, { ownOnly: true }).some(t => {
      const type = db.get<{ form_type: string }>("SELECT form_type FROM ahj_form_templates WHERE id = ?", [t.templateId])?.form_type;
      return acceptedTypes.includes(String(type)) && (!applicationKind || !t.applicationKind || t.applicationKind === applicationKind)
        && (Object.keys(t.def.textFields || {}).length > 0 || Object.keys(t.def.checkboxes || {}).length > 0 || (t.def.overlayFields?.length ?? 0) > 0);
    });
    if (!usable) return { status: "needs_manual", mappedFields: 0,
      message: `The official ${formType.replace(/_/g, " ")} blank is saved but has no usable field map. Re-map it in App Docs or complete and upload it manually; it is not ready to file.` };
    return { status: "exists", message: `A stored ${kindWord ? `${kindWord} ` : ""}${formType.replace(/_/g, " ")} template already exists for this AHJ.` };
  }

  // Known public forms are free downloads; do not buy a search for a source we
  // already hold. An online application can still require a PDF attachment.
  // formAcquisitionPlan.ownFreeFormSource — the same answer the pre-Stage gate reads.
  const free = ownFreeFormSource(project, formType, applicationKind);
  const curated = free?.curated ?? null;
  if (free) {
    const url = free.url;
    // Inside the cooldown, a URL that failed recently is not fetched again (recentFormFetchFailure).
    const recent = opts.skipRecentlyFailed ? recentFormFetchFailure(url) : null;
    if (recent) return { status: "not_found", sourceUrl: url, message: `The official form at ${url} was not fetched again: its download failed recently (${recent}) and Stage does not retry it inside the 24h cooldown. Find missing official forms retries it now; it has not been counted as present.` };
    const bytes = await fetchPdf(url);
    if (bytes) {
      if (!(curated ? curatedFormMap(bytes, url)?.source.hash === curated.hash : bcd5952Template(bytes, url))) {
        return { status: "needs_manual", sourceUrl: url, message: "The official PDF has changed since its field map was checked. Review and re-map the new revision before filling it." };
      }
      return acquireFromBytes(db, llm, { ahj: project.ahj, state: project.state, formType,
        formName: curated?.formName || "Oregon BCD 5952", bytes, sourceUrl: url });
    }
    if (opts.allowResearch === false) return { status: "not_found", sourceUrl: url, message: "The official form could not be downloaded. Retry or upload the blank; it has not been counted as present." };
  }
  if (opts.allowResearch === false) return { status: "not_found", message: `No downloadable mapped ${formType.replace(/_/g, " ")} is held for this AHJ. Research is disabled; use Find official form or upload the official blank.` };

  // Check if the AHJ is known to be online-only (e-permitting portal). These
  // AHJs don't distribute a standalone PDF — the application is entered directly
  // in their portal. Skip the web search to save time and cost.
  const ahjProfile = findApplicationProfile(project);
  if (ahjProfile.requiresPortalEntryOnly) {
    // The structure every other surface resolved (tracks, packet) — never the bare profile's
    // "not yet confirmed" when a cited answer exists.
    const pt = describePermitType(ahjProfile, { answer: permitStructureAnswer(project) });
    return {
      status: "not_found",
      permitType: pt.callout,
      message: `Permitting type: ${pt.callout} ${project.ahj} is an online-only portal — there is no standalone PDF to download. Enter the application directly in the portal. No PDF template needed.`,
    };
  }

  // Seed the form search with whatever the KB already knows about this AHJ
  // (imported reference rows: portal, submission notes, any direct .pdf links).
  // The hint steers the web search; KB .pdf URLs become free download candidates.
  let kbHint: ReturnType<typeof knowledgeResearchHint> = null;
  try { kbHint = knowledgeResearchHint(db, { state: project.state, ahj: project.ahj }, "ahj"); } catch { /* non-fatal */ }
  for (const url of (kbHint?.pdfUrls || []).slice(0, 4)) {
    // Only a self-identifying link can avoid research classification. Do not
    // call an opaque checklist URL an application merely because we asked for one.
    if (classifyFormType(url, "") !== formType) continue;
    const kind = formApplicationKind(url);
    if (kind && applicationKind && kind !== applicationKind) continue;
    const bytes = await fetchPdf(url);
    if (bytes) return acquireFromBytes(db, llm, { ahj: project.ahj, state: project.state,
      formType, formName: decodeURIComponent(new URL(url).pathname.split("/").pop() || formType), bytes, sourceUrl: url, applicationKind: kind });
  }

  // STEER THE SEARCH AT THE RIGHT ONE OF THE TWO. An AHJ on the separate-permit model
  // publishes both a prescriptive solar application and a structural (standard building)
  // one, and the AHJ takes exactly one — "upload ONLY the application that pertains".
  // A search for a generic "building application" is a coin flip between them.
  const kindDirective = applicationKind === "prescriptive"
    ? "This project is on the PRESCRIPTIVE path. Find the AHJ's PRESCRIPTIVE solar PV application (often titled \"Prescriptive Solar Photovoltaic Installation Permit Application\" or a solar-specific checklist/worksheet application). Do NOT return the structural / non-prescriptive / standard building permit application — the AHJ accepts exactly one of the two."
    : applicationKind === "structural"
      ? "This project is on the ENGINEERED (non-prescriptive) path. Find the AHJ's STRUCTURAL / standard building permit application. Do NOT return the prescriptive solar application — the AHJ accepts exactly one of the two."
      : "";
  const knownContext = [kbHint?.text, kindDirective].filter(Boolean).join("\n\n") || undefined;

  const research = await llm.findAhjFormUrl({ ahj: project.ahj, state: project.state, formType, knownContext });

  // Learn the submittal portal/platform/requirements so the record-portal training
  // step pre-fills the portal URL for this new AHJ, and future projects skip the
  // search. Runs whether or not a fillable PDF was found.
  learnAhjPortalFromResearch(db, project, research);

  // Always determine + surface the permit TYPE (combo vs separate BLD/ELE, and how
  // it's submitted), folding in what the search just learned — so even when no PDF
  // is found the operator is told what kind of permitting this AHJ uses.
  //
  // THE STRUCTURE IS THE ONE ANSWER (permitStructureAnswer). This search's own permitStructure is
  // uncited model output: it printed "Separate building (BLD) + electrical (ELE) permits — both
  // must be filed" for Iowa City and Venus (each files ONE solar permit) while the first result in
  // the same response said "not yet confirmed". It is carried only as an unconfirmed lead.
  const permitType = describePermitType(ahjProfile, {
    submissionMethod: research.submissionMethod, portalPlatform: research.portalPlatform,
    answer: permitStructureAnswer(project, { researched: research.permitStructure, researchedFrom: "the form search (uncited)" }),
  });

  // Research candidates first (freshest), then the AHJ's own forms page and the search results
  // (harvestApplicationCandidates — deterministic, no model call), then any direct .pdf links carried
  // by the imported KB row — a spreadsheet-provided application link can rescue an AHJ whose site
  // the search couldn't crack (link may also just be stale). A utility host is never a candidate
  // (rule 5); a fee schedule / agenda named as such never an application.
  const fp = opts.formsPage ?? {};
  const harvest = await harvestApplicationCandidates(project, formType, applicationKind, research, fp);
  const candidates: FormCandidate[] = [];
  // ONE ANSWER TO "MAY THIS PASS ASK THAT HOST AGAIN": a site that REFUSED the forms page read is asked
  // nothing more in this pass — whoever proposed the URL (the model's own list, the KB row, the harvest).
  // The model's link on a host that just answered 403 was still requested, after a message saying
  // nothing else was (forms-find skeptic, P6b).
  let skippedOnRefused = 0;
  const addCandidate = (c: FormCandidate) => {
    if (neverTheApplication(c.url, formType) || candidates.some((x) => x.url === c.url)) return;
    const host = portalHostOf(c.url);
    if (host && harvest.refusedDomains.has(registrableDomain(host))) { skippedOnRefused++; return; }
    candidates.push(c);
  };
  for (const url of research.candidateUrls) addCandidate({ url, label: "", origin: "research" });
  for (const c of harvest.candidates) addCandidate(c);
  for (const url of kbHint?.pdfUrls || []) addCandidate({ url, label: "", origin: "kb" });
  const candidateUrls = candidates.map((c) => c.url);
  const harvestNote = `${harvest.note ? ` ${harvest.note}` : ""}${skippedOnRefused ? ` ${skippedOnRefused} other link(s) on that site (the search's or the knowledge base's) were not requested either.` : ""}`;
  // "WE COULD NOT LOOK" IS NOT "THERE IS NO FORM" (Waltham, 09-25: the search aborted at its 180s
  // budget and Stage reported "No downloadable PDF form was found" — then held the 24h cooldown).
  const couldNotRun = research.lookupFailed
    ? `The form search could not run: ${research.lookupError || "the web-search call failed"} — not a finding about ${project.ahj}. Nothing has been counted as present; search again (Find official form) before concluding anything.`
    : "";

  if (!candidateUrls.length) {
    const portalNote = research.submittalPortalUrl
      ? ` Submittal portal: ${research.submittalPortalUrl}${research.portalPlatform ? ` (${research.portalPlatform})` : ""} — it's pre-filled on the record/training step.`
      : "";
    const reqNote = research.submittalRequirements ? ` Requirements: ${research.submittalRequirements}` : "";
    if (research.lookupFailed) {
      return { status: "not_found", lookupFailed: true, permitType: permitType.callout, message: `${couldNotRun}${harvestNote}${portalNote}${reqNote} Permitting type: ${permitType.callout}` };
    }
    return {
      status: "not_found",
      permitType: permitType.callout,
      // A refused site is not "no form": nothing was downloaded because nothing more was asked of it.
      message: `Permitting type: ${permitType.callout}${research.notes ? ` ${research.notes}` : harvest.refusedDomains.size
        ? ` No form was downloaded for ${project.ahj}: its site refused the read. Retry Find official form later, or upload the official blank.`
        : ` No downloadable PDF form was found for ${project.ahj} — submit through the method above.`}${harvestNote}${portalNote}${reqNote}`,
    };
  }

  // Download EVERY distinct blank the research surfaced (building app +
  // electrical app + checklist often live as separate PDFs on one forms page),
  // classify each by name/URL, and store each under its own form_type slot.
  // Everything acquired is stored + learned, so the next project under this
  // AHJ skips the search entirely.
  const downloads: Array<{ url: string; bytes: Uint8Array; type: string; label: string; found: boolean }> = [];
  const seenHashes = new Set<string>();
  const storedTypes = new Set<string>();
  for (const c of candidates) {
    if (downloads.length >= 4) break;
    const url = c.url;
    // A document WE found (the forms page / a search result) is named by its own words: it is this
    // slot's primary blank only when its discipline fits, and it is fetched as an extra only for a
    // slot nothing downloaded yet fills — never a wasted request to the AHJ's host.
    const found = c.origin === "forms-page" || c.origin === "search-result";
    const words = found ? `${c.label} ${documentSlugWords(url)}` : "";
    if (found) {
      if (!downloads.length && c.discipline && !disciplineFitsSlot(c.discipline, formType)) continue;
      if (downloads.length) {
        const t = classifyFormType(`${url} ${words}`, formType);
        if (t === formType || downloads.some((d) => d.type === t)) continue;
      }
    }
    // AND GENTLY, whoever proposed the URL: a download from a host this module just asked (the forms
    // page read, any earlier download) waits the gap — the model's own link on the forms page's host too.
    // EVERY request is recorded on its host, whoever proposed it and whether or not it returned a PDF
    // (skeptic F3: only a FOUND document was recorded, so a failed model link on the same host was
    // followed at once by the next request — the gap was measured from the forms page read).
    await politeGap(url, fp);
    const bytes = await fetchPdf(url);
    noteHostHit(url);
    if (!bytes) continue;
    const hash = sha256(bytes);
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    const type = downloads.length === 0 ? formType : classifyFormType(`${url} ${found ? words : research.formName || ""}`, formType);
    downloads.push({ url, bytes, type, label: found ? c.label : "", found });
  }
  if (!downloads.length) {
    return {
      status: "not_found",
      permitType: permitType.callout,
      ...(research.lookupFailed ? { lookupFailed: true } : {}),
      message: `${couldNotRun ? `${couldNotRun} ` : ""}Permitting type: ${permitType.callout} Found candidate links for ${project.ahj} but none returned a valid PDF (link rot or login-gated). Upload the blank PDF to proceed. Tried: ${candidateUrls.join(", ")}${harvestNote}`,
    };
  }

  let primary: EnsureFormResult | null = null;
  const extraMessages: string[] = [];
  for (const dl of downloads) {
    // One template per (ahj, form_type) — EXCEPT the building side, where the
    // prescriptive and structural applications are two different forms that both
    // classify to building_application. Key the "already did this one" checks by
    // kind as well, or a research pass that usefully surfaced BOTH blanks throws
    // the second away and the other path is left with nothing to file.
    //
    // The kind comes from the blank's OWN name/URL, never from what we went looking
    // for: a name that claims neither is a jurisdiction's single generic form, and
    // stamping our search intent on it would be inventing evidence.
    // A blank WE found is named by its own words (the AHJ's link text / the result's title), never
    // by the model's formName for a different document.
    const dlName = dl.found ? dl.label : dl.type === formType && research.formName ? research.formName : "";
    const dlKind = formApplicationKind(`${dl.url} ${dlName}`);
    const slot = `${dl.type}|${dlKind || ""}`;
    const type = storedTypes.has(slot) || (dl.type !== formType && hasStoredTemplateOfType(db, project.ahj, project.state, dl.type, dlKind)) ? "" : dl.type;
    if (!type) continue;
    storedTypes.add(slot);
    const formName = dl.found && dl.label.trim()
      ? dl.label.trim().slice(0, 120)
      : type === formType && research.formName
        ? research.formName
        : `${project.ahj} ${type.replace(/_/g, " ")}`;
    const acquired = await acquireFromBytes(db, llm, { ahj: project.ahj, state: project.state, formType: type, formName, bytes: dl.bytes, sourceUrl: dl.url, applicationKind: dlKind });
    if (!primary) primary = acquired;
    else extraMessages.push(`Also stored ${type.replace(/_/g, " ")}: ${acquired.message}`);
  }
  if (!primary) {
    return { status: "exists", permitType: permitType.callout, message: "All downloadable forms for this AHJ are already stored." };
  }
  return {
    ...primary,
    permitType: permitType.callout,
    message: extraMessages.length ? `${primary.message} ${extraMessages.join(" ")}` : primary.message,
  };
}

/** A mapper that maps nothing: with research off, a cited agency PDF is still fetched and STORED
 *  (never dropped), but no model is paid to map it — it lands as a blank to complete by hand. */
const NO_MODEL_MAPPER = {
  mapAcroFormFields: async () => ({ textFields: {}, checkboxes: {}, notes: "not mapped — model mapping is off on this run" }),
  mapFlatFormOverlay: async () => ({ fields: [], signatures: [], notes: "not mapped — model mapping is off on this run" }),
} as unknown as LLMProvider;

/**
 * THE ISSUING AGENCY'S APPLICATION for a track another agency issues (formAuthorityFor said so,
 * citing the per-job lookup). Stored under the AGENCY's name — every city the agency issues for
 * then finds it — with provenance (source URL, retrieved-at, the blank's sha256 in its map):
 *
 *   1. already held for the agency (kind-compatible) -> exists, or needs_manual when not fillable;
 *   2. the agency's curated public seed (hash-locked, model-free map) -> fetched once; when it cannot
 *      be fetched, a named failure to retry — no cited PDF is tried in its place (agency-contain C2);
 *   3. an application PDF the lookup CITED on that permit (on one of the agency's anchor sites, its
 *      file name naming this track's application) -> fetched once, mapped by the existing pipeline;
 *   4. otherwise not_found, naming the agency and the citation — never a paid web search under
 *      the city's name and never a KB profile written for the agency.
 * A human-verified map is never overwritten (acquireFromBytes' protected checks, hard rule 3).
 */
export async function ensureIssuingAgencyForm(
  db: AppDb,
  llm: LLMProvider,
  project: ProjectRecord,
  formType: string,
  authority: FormAuthority,
  applicationKind: "prescriptive" | "structural" | null,
  opts: { allowResearch?: boolean; allowMapping?: boolean; skipRecentlyFailed?: boolean } = {},
): Promise<EnsureFormResult> {
  // THE STEPS BEFORE ANY DOWNLOAD are formAcquisitionPlan.issuingAgencyFormPlan — held for THIS job
  // (agency-contain C1) / not fillable / nothing seeded or cited; per candidate, a cited PDF whose
  // slot another row occupies (MF-1: a cited form never replaces a stored one), and a URL that failed
  // recently (a curated seed stops — C2 no fallthrough; a cited one is skipped). The pre-Stage gate
  // reads the same plan (gates-proper C1), so what it says Stage will download is what Stage does.
  const plan = issuingAgencyFormPlan(db, project, formType, authority, applicationKind, { skipRecentlyFailed: opts.skipRecentlyFailed });
  const { agency, label, whose, want } = plan;
  if (plan.settled) return plan.settled;
  const tried: string[] = [];
  for (const step of plan.steps) {
    if (step.stop) return step.stop;
    if (step.skip) { tried.push(step.skip); continue; }
    const c = step.c;
    const bytes = await fetchPdf(c.sourceUrl);
    // C2 NO FALLTHROUGH (agency-contain): the agency's CURATED seed is its form. A failed fetch (a 404, the
    // network) is a named failure to retry — never a reason to take the next cited PDF instead (the
    // skeptic's S7: Marion County's E-01 404'd and Polk County's application was stored as Marion's).
    if (!bytes && c.origin === "curated") {
      return { status: "not_found", sourceUrl: c.sourceUrl, message: `${agency}'s ${c.formName} could not be downloaded from ${c.sourceUrl} - retry. ${whose}; no other PDF was tried in its place, and it has not been counted as present.` };
    }
    if (!bytes) { tried.push(c.sourceUrl); continue; }
    if (c.origin === "curated") {
      const seed = curatedFormSource({ ahj: agency, state: project.state }, c.formType, want);
      if (!seed || curatedFormMap(bytes, c.sourceUrl)?.source.hash !== seed.hash) {
        return { status: "needs_manual", sourceUrl: c.sourceUrl, message: `${agency}'s official PDF has changed since its field map was checked. Review and re-map the new revision before filling it.` };
      }
    }
    // A cited PDF is mapped by the model unless mapping is off (it follows research unless the caller
    // says otherwise — Stage's no-research pass inside the cooldown still maps when research is allowed).
    const mapper = c.origin === "cited" && !(opts.allowMapping ?? opts.allowResearch !== false) ? NO_MODEL_MAPPER : llm;
    const acquired = await acquireFromBytes(db, mapper, { ahj: agency, state: project.state, formType: c.formType, formName: c.formName, bytes, sourceUrl: c.sourceUrl, applicationKind: c.applicationKind });
    return { ...acquired, message: `${acquired.message} (${whose}.)` };
  }
  return { status: "not_found", message: `${whose}, but ${agency}'s ${label} could not be downloaded (tried: ${tried.join(", ")}). Retry or upload the blank; it has not been counted as present.` };
}

// Shared acquisition: map a downloaded/uploaded blank PDF (AcroForm first, then
// vision overlay for flat/scanned), store it, and report what happened.
export async function acquireFromBytes(
  db: AppDb,
  llm: LLMProvider,
  input: {
    ahj: string; state: string; formType: string; formName: string; bytes: Uint8Array; sourceUrl: string;
    /** Which of the two building-side applications this blank is, when known. Null /
     *  omitted falls back to the form's own name, and stays null when the name makes
     *  no claim — a jurisdiction's single generic application is compatible with
     *  either path, and pretending otherwise would block it on both. */
    applicationKind?: "prescriptive" | "structural" | null;
    /** When the bytes were pulled. Omit for a fresh download (defaults to now);
     *  pass the stored row's value when re-mapping bytes already on disk. */
    retrievedAt?: string;
  },
): Promise<EnsureFormResult> {
  const { ahj, state, formType, formName, bytes, sourceUrl, retrievedAt } = input;
  // EVERY STORE BELOW GOES THROUGH THE ONE CHOKEPOINT: storeAhjFormTemplate refuses a slot a person
  // verified, keyed on the row it would actually replace, and that refusal is this acquisition's
  // answer ("exists", HUMAN-VERIFIED). Anything else it throws still throws.
  const store = (args: Parameters<typeof storeAhjFormTemplate>[1]): EnsureFormResult | null => {
    try { storeAhjFormTemplate(db, args); return null; }
    catch (err) { if (err instanceof VerifiedTemplateRefusal) return err.result; throw err; }
  };
  const curated = curatedFormMap(bytes, sourceUrl);
  if (curated) {
    if (!curatedFormSource({ahj, state}, curated.source.formType)) {
      return {status:"needs_manual", message:"This official PDF belongs to a different jurisdiction. Select the matching authority before mapping it.", sourceUrl};
    }
    const protectedRow = db.query<{field_map:string}>("SELECT field_map FROM ahj_form_templates WHERE lower(ahj_name)=lower(?) AND lower(state)=lower(?) AND form_type=?", [ahj,state,curated.source.formType])
      .some(row => { try { return JSON.parse(row.field_map).verified === true; } catch { return false; } });
    if (protectedRow) return {status:"exists",message:"The verified official form map was retained.",formName:curated.source.formName,sourceUrl};
    const refusedCurated = store({ahjName:ahj,state,formType:curated.source.formType,filename:curated.source.formName+".pdf",bytes,documentDate:curated.source.documentDate,retrievedAt,map:curated.map});
    if (refusedCurated) return refusedCurated;
    return {status:"acquired",message:"Downloaded and mapped the exact official revision. Review missing details and signatures in the filled copy before filing.",formName:curated.source.formName,sourceUrl,mappedFields:Object.keys(curated.map.textFields).length+curated.map.overlayFields.length};
  }
  // The actual bytes outrank a research title claiming that this checklist
  // contains a separate electrical or building application. Mapping a known
  // revision requires no model call and leaves every project fact dynamic.
  const bcd = bcd5952Template(bytes, sourceUrl);
  if (bcd) {
    const protectedTemplate = loadStoredTemplates(db, ahj, state, { ownOnly: true }).find(t => t.verified &&
      db.get<{ form_type: string }>("SELECT form_type FROM ahj_form_templates WHERE id = ?", [t.templateId])?.form_type === "solar_checklist");
    if (protectedTemplate) return { status: "exists", message: "The verified BCD checklist map was retained.", formName: bcd.formName, sourceUrl };
    const refusedBcd = store({ ahjName: ahj, state, formType: "solar_checklist", filename: `${bcd.formName}.pdf`, bytes,
      applicationKind: "prescriptive", documentDate: "2024-05-01", retrievedAt, map: bcd });
    if (refusedBcd) return refusedBcd;
    return { status: "acquired", message: "Stored the official BCD 5952 checklist with the exact-revision field map. It is a checklist only; separate applications remain separate requirements. Preview before filing.", formName: bcd.formName, sourceUrl, mappedFields: Object.keys(bcd.textFields).length };
  }

  // THE IOWA SFM PV WORKSHEET (2020 NEC): recognised by its printed labels at their exact
  // positions (no public URL for the blank has been retrieved, so no byte hash). A moved or
  // re-worded anchor (the 2023-NEC edition) is not this map and falls through to the generic path.
  const iaPv = await iowaPvWorksheetTemplate(bytes, sourceUrl);
  if (iaPv) {
    if (String(state).trim().toUpperCase() !== "IA") {
      return { status: "needs_manual", sourceUrl, message: "This is the Iowa State Fire Marshal PV worksheet; it belongs to an Iowa jurisdiction. Select the matching authority before mapping it." };
    }
    const protectedTemplate = loadStoredTemplates(db, ahj, state, { ownOnly: true }).find(t => t.verified &&
      db.get<{ form_type: string }>("SELECT form_type FROM ahj_form_templates WHERE id = ?", [t.templateId])?.form_type === PV_WORKSHEET_DOC_TYPE);
    if (protectedTemplate) return { status: "exists", message: "The verified PV worksheet map was retained.", formName: iaPv.formName, sourceUrl };
    const refusedIa = store({ ahjName: ahj, state, formType: PV_WORKSHEET_DOC_TYPE, filename: `${iaPv.formName}.pdf`, bytes,
      applicationKind: null, retrievedAt, map: iaPv });
    if (refusedIa) return refusedIa;
    return { status: "acquired", message: "Stored the Iowa SFM PV worksheet (2020 NEC) with its label-anchored field map. Values come from the project's parsed fields and written-out calculations; unknowns stay blank and are listed. Preview before filing.", formName: iaPv.formName, sourceUrl, mappedFields: iaPv.overlayFields.length };
  }

  // What the document says about ITSELF, read once and stamped on every branch
  // below. A form stored without it cannot answer "is this current", and the
  // Coos County electrical application — "Revised 12/23/2022", fee table 1.70x
  // below the adopted schedule — is what that costs.
  //
  // WHICH application it is rides along the same way, for the same reason: a blank
  // stored without it forces every later reader to re-guess from a filename.
  const documentDate = await documentDateForPdf(bytes);
  const applicationKind = input.applicationKind ?? formApplicationKind(formName);
  const provenance = { documentDate, retrievedAt, applicationKind };

  // A HUMAN-VERIFIED MAP IS NEVER OVERWRITTEN (hard rule 3). Every store below replaces the row in
  // this blank's slot (storeAhjFormTemplate — one per agency/state/form type, building by kind); an
  // upload or a download landing on a slot a person verified is refused before any model call, and
  // the store itself refuses again (a person may verify while the model runs) — the same predicate.
  const refusedUpFront = verifiedSlotRefusal(db, { ahj, state, formType, formName, sourceUrl, applicationKind });
  if (refusedUpFront) return refusedUpFront;

  // A single vision pass locates signature lines (and, for flat forms, the data
  // placements). Reused across both branches so signatures are detected once.
  const overlay = await buildOverlayMapForPdf(llm, { ahj, state, formName, bytes });
  const signatureFields = overlay?.signatureFields || [];

  const acro = await buildFieldMapForPdf(llm, { ahj, state, formName, bytes });
  const acroCount = acro ? Object.keys(acro.textFields).length + Object.keys(acro.checkboxes).length : 0;
  if (acro && acroCount > 0) {
    // THE VISION PASS'S PLACEMENTS WHERE NO WIDGET IS. An AcroForm often prints blanks it never gave
    // a widget (Waltham: Map/Parcel, Zoning, Lot area, Frontage, Flood zone). The vision pass places
    // values on the page image; those that land on a widget duplicate the AcroForm fill and are
    // dropped, the rest are kept as overlayFields — fillLoadedForm already draws overlayFields
    // after flattening an AcroForm.
    const mappedWidgets = new Set([...Object.keys(acro.textFields), ...Object.keys(acro.checkboxes)]);
    const offWidget = (overlay?.overlayFields ?? []).filter((p) => !placementOnWidget(p, acro.fields)
      // a value the AcroForm map already writes into a widget is not drawn a second time beside it
      && !acro.fields.some((w) => mappedWidgets.has(w.name) && acro.textFields[w.name] === p.source && w.page === p.page && w.rect
        && Math.abs(w.rect.y - p.y) <= 30 && Math.abs(w.rect.x - p.x) <= w.rect.width + 30));
    // The kept placements pass the SAME map checks as the widgets, together with them (a placed
    // "I, ___" and a Print Name widget under one signature are one signer; a placed cost row beside
    // a Total widget is not the Total; a placed licence holder is not the applicant). The vision
    // pass's signature lines ride along as stand-in signature widgets: they separate two blocks.
    const joint = sanitizePlacements({ widgets: [...acro.fields, ...signatureStandIns(signatureFields)], items: acro.labels, state, textFields: acro.textFields, checkboxes: acro.checkboxes, placements: offWidget });
    const hybrid = joint.placements;
    const textFields = joint.textFields;
    const operatorItems = [...acro.operatorItems, ...joint.operatorItems, ...(overlay?.operatorItems ?? [])];
    const notes = [acro.notes, ...joint.notes].filter(Boolean).join(" ");
    const refused = store({
      ahjName: ahj, state, formType, filename: `${formName}.pdf`, bytes, ...provenance,
      map: {
        formName, sourceUrl, fillMode: "acroform", textFields, checkboxes: joint.checkboxes, signatureFields, notes,
        ...(hybrid.length ? { overlayFields: hybrid } : {}),
        ...(operatorItems.length ? { operatorItems } : {}),
      },
    });
    if (refused) return refused;
    const mappedCount = Object.keys(textFields).length + Object.keys(joint.checkboxes).length;
    return { status: "acquired", message: `Acquired and mapped ${formName} (${mappedCount} field(s) of ${acro.fieldCount}${hybrid.length ? ` + ${hybrid.length} printed blank(s) with no field` : ""}${signatureFields.length ? `, ${signatureFields.length} signature line(s)` : ""}). It will be auto-filled for ${ahj}.`, formName, sourceUrl, mappedFields: mappedCount + hybrid.length };
  }
  // AN ACROFORM WITH ZERO MAPPED FIELDS IS NOT "ACQUIRED AND AUTO-FILLED". With no LLM (the
  // stub provider maps nothing) this branch used to store an empty map and report "Acquired
  // and mapped … (0 field(s) of 42). It will be auto-filled" — while loadStoredTemplates
  // drops any map with no fields, so the form silently fell out of every fill. It now falls
  // through to the branches below, which describe what was actually stored: vision
  // placements if there are any, signature lines if only those, else needs_manual.

  // No AcroForm fields — flat/scanned. Use the vision overlay placements, checked by the same map
  // rules as widgets against the page's own text (signature lines, the cost table's Total). A SCANNED
  // form has no text layer, so the signature lines the vision pass found stand in as signature
  // widgets — without them nothing separates the owner's block from the contractor's below it.
  if (overlay && overlay.overlayFields.length) {
    let labels: LabelItem[] = [];
    try { labels = await (await import("./formTextLayer")).extractLabels(bytes); } catch { labels = []; }
    const flat = sanitizePlacements({ widgets: signatureStandIns(signatureFields), items: labels, state, textFields: {}, checkboxes: {}, placements: overlay.overlayFields });
    const placed = flat.placements;
    const operatorItems = [...flat.operatorItems, ...overlay.operatorItems];
    if (placed.length) {
      const refused = store({
        ahjName: ahj, state, formType, filename: `${formName}.pdf`, bytes, ...provenance,
        map: { formName, sourceUrl, fillMode: "overlay", textFields: {}, checkboxes: {}, overlayFields: placed, signatureFields, notes: `Vision-mapped flat form (${placed.length} placements, ${signatureFields.length} signature line(s)). ${[overlay.notes, ...flat.notes].filter(Boolean).join(" ")} VERIFY the filled PDF — coordinate placement is approximate; re-map if anything is off.`,
          ...(operatorItems.length ? { operatorItems } : {}) },
      });
      if (refused) return refused;
      return { status: "acquired", message: `Acquired ${formName} (flat PDF) and vision-mapped ${placed.length} placement(s)${signatureFields.length ? ` + ${signatureFields.length} signature line(s)` : ""}. Verify the filled output and re-map if needed.`, formName, sourceUrl, mappedFields: placed.length };
    }
    overlay.operatorItems = operatorItems;
  }

  // No data fields, but signatures alone are still useful (signs the blank).
  if (signatureFields.length) {
    const refused = store({
      ahjName: ahj, state, formType, filename: `${formName}.pdf`, bytes, ...provenance,
      map: { formName, sourceUrl, fillMode: "overlay", textFields: {}, checkboxes: {}, signatureFields, notes: `No fillable data fields, but ${signatureFields.length} signature line(s) detected. The blank is stored; your signature will be stamped. Fill the rest by hand.`,
        ...(overlay?.operatorItems.length ? { operatorItems: overlay.operatorItems } : {}) },
    });
    if (refused) return refused;
    return { status: "acquired", message: `Stored ${formName} with ${signatureFields.length} signature line(s) mapped. Data fields must be filled by hand.`, formName, sourceUrl, mappedFields: signatureFields.length };
  }

  // Couldn't map anything — store the legit blank for manual completion. Say WHICH kind of
  // nothing: an AcroForm whose N fields mapped to no project data is not a flat scan, and
  // the operator's next step differs (re-map once field mapping is available vs. fill by hand).
  const unmappedWhy = acro
    ? `${acro.fieldCount} fillable field(s) found, but none could be mapped to project data${acro.notes ? ` (${acro.notes})` : ""}`
    : "Flat/scanned PDF — vision mapping found no placeable fields";
  const refusedBlank = store({
    ahjName: ahj, state, formType, filename: `${formName}.pdf`, bytes, ...provenance,
    map: { formName, sourceUrl, fillMode: acro ? "acroform" : "overlay", textFields: {}, checkboxes: {}, notes: `${unmappedWhy}. Stored as the blank for manual completion.` },
  });
  if (refusedBlank) return refusedBlank;
  return {
    status: "needs_manual",
    message: acro
      ? `Stored ${formName}, but NONE of its ${acro.fieldCount} fillable field(s) could be mapped to project data, so it will NOT be auto-filled. It's saved as the blank for manual completion — fill it by hand, or re-map it once field mapping is available.`
      : `Stored the official ${formName}, but it couldn't be auto-mapped. It's saved as the blank for manual completion.`,
    formName, sourceUrl, mappedFields: 0,
  };
}

/**
 * RE-MAP A STORED TEMPLATE FROM ITS STORED BLOB — the Re-map button (POST
 * /api/ahj-templates/:id/remap). An UNVERIFIED map (an AI map nobody has confirmed, like City of
 * Waltham's residential application mapped before the mapper saw captions) is re-mapped through the
 * current pipeline (captions, the post-map checks, the vision placements with no widget), keeping
 * the row's retrieved_at: a re-map re-reads bytes we already had.
 *
 * A HUMAN-VERIFIED map is never re-mapped (hard rule 3): the model is not called and the row is not
 * touched. A person who wants it re-mapped marks it unverified first — their decision, on record.
 */
export async function remapStoredTemplate(db: AppDb, llm: LLMProvider, templateId: string): Promise<EnsureFormResult> {
  const row = db.get<{ id: string; ahj_name: string; state: string; form_type: string; pdf_blob: Buffer | null; field_map: string; retrieved_at: string }>(
    "SELECT id, ahj_name, state, form_type, pdf_blob, field_map, retrieved_at FROM ahj_form_templates WHERE id = ?",
    [templateId],
  );
  if (!row) throw new HttpError(404, "Template not found.");
  if (!row.pdf_blob) throw new HttpError(410, "PDF blob has been wiped — re-upload the blank to re-map.");
  const map = parseJson<{ formName?: string; sourceUrl?: string; verified?: boolean }>(row.field_map, {});
  const formName = map.formName || `${row.ahj_name} ${row.form_type.replace(/_/g, " ")}`;
  if (map.verified === true) {
    return {
      status: "exists", formName, sourceUrl: map.sourceUrl || "",
      message: `${formName} has a HUMAN-VERIFIED field map, so it was not re-mapped. To re-map it, mark it unverified first (the verified map is otherwise kept exactly as confirmed).`,
    };
  }
  return acquireFromBytes(db, llm, {
    ahj: row.ahj_name, state: row.state, formType: row.form_type, formName,
    bytes: new Uint8Array(row.pdf_blob), sourceUrl: map.sourceUrl || "",
    retrievedAt: String(row.retrieved_at || ""),
  });
}
