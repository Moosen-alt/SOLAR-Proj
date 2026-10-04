// ---------------------------------------------------------------------------
// Required-document inventory — the gate that prevents "documents still missing"
// rejections.
//
// The old submit gate was DOCUMENT-BLIND: it checked that scalar project fields
// were non-empty and that the parser's TEXT mentioned the right keywords, but it
// never verified the actual files were attached. A plan set that was parsed at
// intake but never attached to the submittal would pass. A real AHJ (Marion
// County / Keizer on Oregon ePermitting) bounced exactly that.
//
// This module resolves the concrete set of documents a clean residential rooftop
// solar submittal must carry — path-driven (prescriptive vs engineered),
// structure-driven (one combined permit vs separate BLD + ELE permits) and
// lane-aware (AHJ permit vs utility NEM) — and checks each against the actual
// file inventory: uploads (project_documents) AND the filled AHJ forms on disk
// (backend/data/filled/<projectId>/, which carry no row), with the parsed
// plan-set sheet map as a secondary signal for sheets that legitimately live
// INSIDE the combined plan-set PDF. Missing blocking documents hard-block submit.
//
// The permit APPLICATIONS themselves (requiredApplicationDocs, below) were the
// long-standing hole: nothing ever computed "the set of documents this project
// must produce", so a jurisdiction that files TWO permits could pass every check
// with one of the two applications never acquired, never filled, never attached.
//
// Authoritative basis (verified against state sources):
//   - Oregon requires a SEPARATE structural permit AND electrical permit for solar
//     (OAR 918-050-0180; Oregon BCD form 440-5952 header).
//   - Prescriptive path → prescriptive checklist (440-5952) + site plan with fire
//     access/escape pathways (R324.6). Non-prescriptive → PE-stamped structural
//     plans + sealed structural letter/calcs, plan review, full fees.
//   - Plan set must show: site/plot plan w/ dimensioned fire pathways, electrical
//     SLD/one-line w/ rapid shutdown + NEC 705.12 busbar result, structural roof
//     framing + attachment detail, module spec, inverter spec, label/placard set.
//   - PGE NEM requires inverter cut-sheets (UL 1741), one-line, and site plan.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { projectDocsByType } from "./projectDocuments";
import { duplicateUploads, uploadedSubmissionDocuments } from "./submissionDocuments";
import { filledFormsByDocType, applicationKindForPath, loadStoredTemplates, formAllowedForPath, formContradictsPath } from "./ahjForms";
import { resolvePermitPath, resolveStampRequirement, hasStampedStructuralEvidence } from "./permitPath";
import { codeLimitProvenance, resolveEffectiveCodeContext } from "./codeProfiles";
import { findAhjProcessProfile, ahjProcessKnowledgeStatus, AHJ_PROCESS_REFERENCE_ENV } from "./processProfiles";
import { findKnowledgeForLearn } from "./knowledgeBase";
import { HttpError } from "./httpError";
import { applicationProfiles, findApplicationProfile, namedApplicationForm, permitStructureForProject } from "./applicationDocs";
import { normalizeAhjName, permitProcessFor, stateIssuerFormsFor, stateRulesFor } from "./permitProcess";
import { namesPvWorksheet, PV_WORKSHEET_DOC_TYPE } from "./iowaPvWorksheet";
import {
  agencyApplicationForms, applicationSlotFor, agencyListNamesDocument, agencyListReplacesLine, agencyRowAppliesToJob, anchorSitesOnce, issuingAgencyDocumentList, prerequisiteSettled, rowBelongsToAuthority, tracksIssuedByOther, TRACK_FORM_TYPES,
  type AgencyApplicationForm, type AgencyLineStatus, type AgencyLineStatusOf, type FormTrack,
} from "./applicationDocsAgency";
import { filledApplicationForms, heldUnfillableAgencyBlanks } from "./ahjForms";
import { requirementSlots } from "./requirementSlots";
import { stageAcquiresForm, stageAcquisitionFor, type StageAcquiredForm, type StageAcquisition } from "./formAcquisitionPlan";

export interface RequiredDocItem {
  /** project_documents.doc_type this maps to (or a synthetic key for path docs). */
  docType: string;
  label: string;
  /** Why a clean submittal needs it (shown to the operator). */
  why: string;
  /** "permit" (AHJ) or "nem" (utility) lane. */
  lane: "permit" | "nem";
  /** Missing a blocking doc stops submit; advisory docs only warn. */
  blocking: boolean;
  /**
   * The permit DISCIPLINE this document files under, in the SAME vocabulary
   * recipeDisciplineForTrack (portalChannel.ts) already defines for submittal
   * tracks and migration v22 for fee rows: "structural" | "electrical" |
   * "combo" | "". Deliberately not a parallel "building" word — the track
   * `building` maps to discipline `structural`, and the doc side must agree or
   * a staging filter keyed on one will silently miss the other.
   * Absent/"" on the universal plan-set family, which every discipline needs.
   */
  discipline?: string;
  /**
   * Other docTypes that satisfy this row. Needed because classifyFormType
   * (ahjFormAuto.ts) falls through to the generic `permit_application` for a
   * blank whose name carries neither "building" nor "structural" — Coos Bay's
   * "Prescriptive Solar Photovoltaic Installation Permit Application" is exactly
   * that. Without the alias the inventory demands a document that is sitting on
   * disk under another key: the one-letter-apart bug, rebuilt.
   */
  altDocTypes?: string[];
  /**
   * Which of the two MUTUALLY EXCLUSIVE building-side applications this row is,
   * in the vocabulary formAllowedForPath (ahjForms.ts) enforces at fill time.
   * Only ever set on the ONE building-side row — the AHJ takes exactly one
   * ("upload only the application that pertains — DO NOT upload both").
   */
  applicationKind?: "prescriptive" | "structural";
}

/** An application/checklist row, which always names its discipline. */
export interface RequiredApplicationDoc extends RequiredDocItem {
  discipline: string;
}

/**
 * The AHJ-dependent inputs the application set needs, resolved by the caller.
 *
 * requiredDocuments() is called DB-free with bare projects that carry no
 * ahj/state/city (backend/test/conditionalStampDocs.test.ts), and
 * permitStructureForProject -> findApplicationProfile does
 * `project.state.trim().toUpperCase()`, which throws on those. So the lookups
 * live in applicationDocContext() — guarded, called from documentInventory and
 * from form acquisition — and are THREADED IN, exactly the way
 * stampThresholdKwDc / processProfileRequiresStamp already are. The pure
 * function stays pure.
 */
export interface ApplicationDocContext {
  permitStructure?: "separate" | "combo" | "unknown";
  processFlags?: {
    requiresBuildingPermitApplication?: boolean;
    requiresElectricalPermitApplication?: boolean;
    requiresSolarChecklist?: boolean;
  };
  /** The AHJ's own name for the path-chosen building-side application. */
  buildingApplicationName?: string;
  /** How to refer to this jurisdiction in `why`. */
  ahjLabel?: string;
  /**
   * The jurisdiction's application profile says the PRESCRIPTIVE path carries its own
   * itemized checklist/worksheet (ApplicationRequirementProfile.requiresPrescriptiveChecklist).
   * A structured per-AHJ field, resolved in applicationDocContext() — NOT prose. It is a
   * separate signal from the process profile's requiresSolarChecklist flag: Coos Bay's
   * process row has that flag FALSE while the application profile carries the checklist
   * from Oregon's statewide prescriptive rule, which is why nothing ever demanded it.
   */
  requiresPrescriptiveChecklist?: boolean;
  /**
   * The jurisdiction takes applications ONLY through its online portal — no standalone
   * application PDF exists to download, fill, or attach (Salem's E-permitting, Portland's
   * DevHub). Form acquisition already knows this (ahjFormAuto skips the web search and says
   * "no PDF template needed"); the doc gate must agree, or it blocks staging on a file
   * nobody can produce while the staged portal run is what actually carries these answers.
   * Operator (2026-09-21): "If no files found needed, call it out" — the rows stay VISIBLE
   * with the portal-entry explanation; they just stop blocking.
   */
  requiresPortalEntryOnly?: boolean;
  /**
   * WHETHER THE ABSENCE OF DEMANDS ABOVE IS AN ANSWER AT ALL — the same distinction
   * Round 3 drew for pkg.missingDocumentsStatus, one layer upstream and in the same
   * two words on purpose.
   *
   *   "resolved"    — the 381-profile AHJ process reference was read. An empty
   *                   processFlags then genuinely means THIS AHJ IS UNKNOWN TO US:
   *                   a legitimately empty demand, and the NO SIGNAL, NO DEMAND rule
   *                   in requiredApplicationDocs is the right answer.
   *   "unavailable" — the reference file could not be read at all (absent, malformed,
   *                   zero profiles). EVERY jurisdiction looks unknown, which is
   *                   indistinguishable from the case above by the flags alone — and
   *                   that indistinguishability is the bug: with the file unreachable,
   *                   Drew Example's blocking set went from three documents to
   *                   none and the packet printed "Every required document is
   *                   attached". documentInventory() refuses on this value rather
   *                   than computing a set it has no basis for.
   *
   * Set only by applicationDocContext(), which does the lookups. A context built by
   * hand (unit tests, the pure-function callers) leaves it absent.
   */
  knowledgeStatus?: "resolved" | "unavailable";
  /** Why the knowledge base could not be read. Set only alongside "unavailable". */
  knowledgeError?: string;
  /**
   * Per permit track, the OTHER agency the per-job lookup cites as that permit's issuer
   * (applicationDocsAgency.formAuthorityFor) and the applications of that agency known BY NAME (a
   * curated public seed, or a PDF the lookup cited), narrowed to the path. Absent for a track the
   * AHJ issues itself — today's behaviour. When forms are known the row names them, and it is NOT
   * portal-entry-only: a generic fallback profile's "no PDF exists" claim is contradicted by the
   * agency's own published application.
   */
  issuingAgencies?: Partial<Record<FormTrack, IssuingAgencyForms>>;
  /** A STATE agency issues these tracks, on its own application per track (permitProcess.stateIssuerFormsFor
   *  — New Mexico CID, issue #53); the AHJ's own application is then its local zoning / site review. */
  stateIssuer?: ReturnType<typeof stateIssuerFormsFor>;
}

export interface IssuingAgencyForms {
  agency: string;
  sourceUrl: string;
  quote: string;
  forms: AgencyApplicationForm[];
}

/** The application-family docTypes — the only keys a filled AHJ form may claim.
 *  Agrees with classifyFormType, filledFormsByDocType and UPLOAD_LABEL_PATTERNS
 *  (pinned in backend/test/filledFormUpload.test.ts). */
export const APPLICATION_DOC_TYPES = new Set([
  "permit_application",
  "building_application",
  "electrical_application",
  "solar_checklist",
  // A state PV worksheet (Iowa SFM) filled from a stored template (pvWorksheetRequirement).
  "pv_worksheet",
]);

export interface DocPresence extends RequiredDocItem {
  present: boolean;
  /** How presence was established: "attached file" | "in plan set" | "". */
  via: string;
}

export interface DocumentInventory {
  required: RequiredDocItem[];
  presence: DocPresence[];
  missingBlocking: DocPresence[];
  missingAdvisory: DocPresence[];
  /** Set when the application set is EMPTY because nothing is known about this AHJ (structure
   *  unknown, no flags, no cited documents, no KB list, no issuing agency): the sentence the packet
   *  and the gate show instead of an all-clear. Advisory — it never blocks (NO SIGNAL, NO DEMAND). */
  applicationSetUnknown?: string;
}

function snap(project: ProjectRecord, key: string): string {
  const v = (project.parserSnapshot || {})[key];
  return v == null ? "" : String(v);
}

// Plan-set sheet labels we look for in the parser's readiness / split text, used as a
// secondary signal that a sheet is present INSIDE the combined plan-set PDF (the plan
// set file itself must still physically exist — we never count prose alone).
const PLAN_SHEET_HINTS: Record<string, RegExp> = {
  sld: /\b(sld|one-?line|single-?line|3-?line|three-?line)\b/i,
  site_plan: /\b(site\s*plan|plot\s*plan|site\/?roof)\b/i,
  structural: /\b(structural|roof\s*fram|rafter|truss|attachment\s*detail|mount\s*detail)\b/i,
  module_spec: /\bmodule\s*spec/i,
  inverter_spec: /\b(inverter|microinverter)\s*spec|\bUL[\s-]*1741\b/i,
  labels: /\b(label|placard)/i,
};

function planSetPresent(docsByType: Record<string, string>): boolean {
  return Boolean(docsByType.plan_set || docsByType.plan || docsByType.plan_pdf);
}

// Is a sheet identified inside the uploaded plan set? Requires the plan-set FILE to
// exist AND the parse of that real file to map the sheet (READY in packetReadiness or a
// page range in the split map) — not a bare keyword anywhere in free text.
function sheetInPlanSet(project: ProjectRecord, docType: string, docsByType: Record<string, string>): boolean {
  if (!planSetPresent(docsByType)) return false;
  const hint = PLAN_SHEET_HINTS[docType];
  if (!hint) return false;
  const readiness = snap(project, "packetReadinessText");
  const split = snap(project, "splitPagesText");
  // packetReadiness lines look like "READY - SLD" / "MISSING - Module spec".
  const readyLine = readiness
    .split(/\n+/)
    .some((line) => hint.test(line) && /\bREADY\b/i.test(line) && !/\bMISSING\b/i.test(line));
  // split map lines look like "02 SLD 3-Line ...: page 3", or — what the parser page actually
  // writes (parser.html splitPagesText) — "02 Site + plot plan: 2, 3" / "...: missing". A line
  // ending in a page list counts; "missing" / "not detected" never does.
  const splitLine = split.split(/\n+/).some((line) =>
    hint.test(line) && (/\bpages?\b/i.test(line) || /:\s*\d+(?:\s*,\s*\d+)*\s*$/.test(line)));
  return readyLine || splitLine;
}

function present(
  item: RequiredDocItem,
  project: ProjectRecord,
  docsByType: Record<string, string>,
  uploads: Record<string, string> = docsByType,
  filledApplications: Record<string, string> = {},
): { present: boolean; via: string } {
  const docType = item.docType;
  // A row is satisfied by its own docType OR by any alias it accepts, and by an
  // UPLOAD or by a FILLED form. Uploads are checked first at each key so an
  // operator's own version wins, mirroring prepareSubmission's merge order.
  for (const key of [docType, ...(item.altDocTypes || [])]) {
    const under = key === docType ? "" : ` (stored as ${key.replace(/_/g, " ")})`;
    if (uploads[key]) return { present: true, via: `attached file${under}` };
    if (filledApplications[key]) return { present: true, via: `filled form${under}` };
  }
  // The engineered PE stamp + structural letter usually live ON the structural sheets
  // inside the uploaded plan set. Count it present when a stamped-structural file exists
  // OR the parse of the real uploaded plan set shows a current stamp/seal/letter.
  if (docType === "structural_letter") {
    if (docsByType.stamped_plans || docsByType.engineering_letter) return { present: true, via: "attached file" };
    if (planSetPresent(docsByType) && hasStampedStructuralEvidence(project)) return { present: true, via: "stamp in plan set" };
    return { present: false, via: "" };
  }
  if (PLAN_SHEET_HINTS[docType] && sheetInPlanSet(project, docType, docsByType)) {
    return { present: true, via: "in plan set" };
  }
  return { present: false, via: "" };
}

/**
 * The documents a clean submittal for THIS project must carry, resolved from the
 * permit path (prescriptive vs engineered) and whether the project has a utility/NEM
 * filing. Doc types align with docSplitter / project_documents so presence can be
 * verified against real files.
 */
export function requiredDocuments(
  project: ProjectRecord,
  opts: {
    stampThresholdKwDc?: number | null;
    /** permitPath.resolveStampRequirement: absent = not confirmed (an advisory, never a block). */
    stampThresholdConfirmed?: boolean;
    stampThresholdBasis?: string;
    jurisdictionLabel?: string;
    processProfileRequiresStamp?: boolean;
    /** Resolved by the caller (documentInventory / form acquisition), which has
     *  the DB and does the guarded profile lookups. Omitted → no permit
     *  APPLICATION is demanded at all, which is what keeps this function safe to
     *  call with a bare project that has no ahj/state. */
    application?: ApplicationDocContext;
  } = {},
): RequiredDocItem[] {
  const hasUtility = Boolean((project.utility || "").trim());
  const items: RequiredDocItem[] = [
    { docType: "plan_set", label: "Plan set (stamped/complete PDF)", why: "The full plan set is the core of every AHJ + NEM submittal.", lane: "permit", blocking: true },
    { docType: "site_plan", label: "Site / plot plan with fire access + escape pathways", why: "AHJ requires the array location and dimensioned firefighter pathways/setbacks (R324.6).", lane: "permit", blocking: true },
    { docType: "sld", label: "Electrical one-line / SLD (rapid shutdown + NEC 705.12)", why: "Required for both the electrical permit and the utility NEM application.", lane: "permit", blocking: true },
    { docType: "structural", label: "Structural roof framing + attachment detail", why: "Required for the structural permit (framing, spacing, attachment).", lane: "permit", blocking: true },
    { docType: "module_spec", label: "PV module spec sheet", why: "AHJ + utility require the module cut sheet (listing/ratings).", lane: "permit", blocking: true },
    { docType: "inverter_spec", label: "Inverter / microinverter spec sheet (UL 1741)", why: `Required by the AHJ and by ${hasUtility ? `${(project.utility || "").trim()}'s` : "the utility's"} interconnection application (UL 1741-SB listing).`, lane: "nem", blocking: true },
    { docType: "labels", label: "Label / placard schedule", why: "Placard/label schedule (705.10 directory, RSD, disconnects) — usually a plan-set sheet.", lane: "permit", blocking: false },
  ];

  // CONDITIONAL — the sealed structural letter ("SS stamp"). One authority decides
  // (resolveStampRequirement in permitPath.ts): the engineered path or the
  // jurisdiction's own threshold is a hard requirement; a learned process-profile
  // flag is hearsay and surfaces as an advisory the operator confirms rather than
  // a block. A prescriptive project in a jurisdiction with no rule is never nagged.
  const stamp = resolveStampRequirement(project, {
    stampThresholdKwDc: opts.stampThresholdKwDc,
    stampThresholdConfirmed: opts.stampThresholdConfirmed,
    stampThresholdBasis: opts.stampThresholdBasis,
    jurisdictionLabel: opts.jurisdictionLabel,
    processProfileRequiresStamp: opts.processProfileRequiresStamp,
  });
  if (stamp.required) {
    items.push({
      docType: "structural_letter",
      label: "PE-stamped structural plans + sealed structural letter/calcs",
      why: stamp.reason,
      lane: "permit",
      blocking: !stamp.waivable,
    });
  }

  // If there is no utility, the NEM-only doc (inverter spec is dual-purpose) stays
  // permit-side; drop the pure-NEM framing. inverter_spec is required either way, so
  // re-lane it to permit when there's no utility so it still blocks.
  if (!hasUtility) {
    for (const it of items) if (it.docType === "inverter_spec") it.lane = "permit";
  }

  // THE PERMIT APPLICATIONS THEMSELVES. The baseline above is the plan-set
  // family; until now nothing in this list was an APPLICATION, so a jurisdiction
  // that files a building AND an electrical permit could pass every check with
  // one of the two never acquired, never filled and never attached.
  items.push(...requiredApplicationDocs(project, opts.application ?? {}));
  return items;
}

/**
 * The permit APPLICATIONS this project must file, computed through BOTH axes at
 * once — because they are orthogonal and conflating them is the bug:
 *
 *   AXIS 1 — PERMIT STRUCTURE (permitStructureForProject): combo = one permit;
 *     separate = a building (BLD) permit AND an electrical (ELE) permit, two
 *     filings. This is the same signal that already splits requiredTracks() and
 *     prints "Separate building (BLD) + electrical (ELE) permits — both must be
 *     filed" on the operator's screen.
 *   AXIS 2 — PERMIT PATH (resolvePermitPath): prescriptive XOR engineered. This
 *     chooses WHICH building-side application, and the AHJ takes exactly one
 *     ("upload only the application that pertains — DO NOT upload both").
 *
 * So a prescriptive project at a separate-permit AHJ needs the PRESCRIPTIVE
 * application plus the ELECTRICAL application — never the structural one. The
 * electrical application does not depend on the path at all; that independence
 * is the whole point.
 *
 * BLOCKING SOURCE RULE (the safety boundary): a flag-derived row blocks ONLY
 * when the structure resolves to "separate" — the signal already visible to the
 * operator as two submittal tracks. "combo"/"unknown" stay advisory, and the
 * KB-prose rows (kbApplicationDocItems) stay advisory as they always were.
 * These are 380+ seeded, spreadsheet-imported flags; a wrong one must not be
 * able to stop a filing on its own.
 */
export function requiredApplicationDocs(
  project: ProjectRecord,
  ctx: ApplicationDocContext = {},
): RequiredApplicationDoc[] {
  const structure = ctx.permitStructure ?? "unknown";
  const flags = ctx.processFlags ?? {};
  const separate = structure === "separate";
  const combo = structure === "combo";
  const wantsBuilding = separate || combo || Boolean(flags.requiresBuildingPermitApplication);
  const wantsElectrical = separate || Boolean(flags.requiresElectricalPermitApplication);
  // TWO SIGNALS, NOT ONE. The process profile's own flag is the narrow one; the
  // jurisdiction's APPLICATION profile (requiresPrescriptiveChecklist) is the one that
  // carries a state-level prescriptive-checklist rule down to an AHJ whose own row says
  // nothing. Coos Bay is exactly that shape — process flag FALSE, application profile
  // TRUE — so reading only the flag is why the checklist was never asked for.
  //
  // The profile field is a REFINEMENT of a building-side filing we already know about,
  // never a signal on its own. findApplicationProfile ALWAYS returns something, and its
  // Oregon fallback ("oregon-generic-epermitting") carries the checklist — so reading it
  // standalone makes an AHJ we know nothing about demand a document nobody can name,
  // which is exactly what the NO SIGNAL, NO DEMAND rule below exists to prevent. The
  // process FLAG keeps its old standing as a signal in its own right.
  const wantsChecklist = Boolean(flags.requiresSolarChecklist)
    || (wantsBuilding && Boolean(ctx.requiresPrescriptiveChecklist));
  // A STATE PV WORKSHEET is its own signal (Iowa's SFM worksheet): the per-job lookup's
  // documents, else the cited state rule. Path-independent — it is electrical, not the
  // prescriptive checklist.
  const worksheet = pvWorksheetRequirement(project);
  // NO SIGNAL, NO DEMAND. A project with no resolved structure and no process
  // flags (an AHJ we have no knowledge of, or a bare project in a unit test)
  // must not be told to attach applications nobody can name.
  if (!wantsBuilding && !wantsElectrical && !wantsChecklist) return worksheet ? [worksheet] : [];

  const pathResolution = resolvePermitPath(project);
  const path = pathResolution.path;
  // STANDARD REVIEW (outside a prescriptive-path jurisdiction — resolvePermitPath): ONE building
  // application, no prescriptive-vs-structural pair, no "renewable-energy" vocabulary. Oregon's
  // words printed for an Arizona or New Mexico AHJ stated an Oregon filing as that AHJ's
  // requirement (new-AHJ e2e, 2026-09-26).
  const standardReview = Boolean(pathResolution.standardReview);
  const oregon = (project.state || "").trim().toUpperCase() === "OR";
  const where = (ctx.ahjLabel || project.ahj || "").trim() || "This AHJ";
  const named = (ctx.buildingApplicationName || "").trim();
  const permitWord = combo ? "combined building + electrical permit" : "building permit";
  // PORTAL-ENTRY-ONLY AHJs HAVE NO APPLICATION PDF TO ATTACH. The application data is
  // entered in the portal at staging; blocking on a file that does not exist anywhere
  // is a demand nobody can satisfy. The rows stay listed (the answers are still owed)
  // but stop blocking, and the `why` says exactly where the application actually lives.
  const portalOnly = Boolean(ctx.requiresPortalEntryOnly);
  const portalNote = ` NOTE: ${where} takes applications ONLY through its online portal — no application PDF exists to download or attach. The staged portal run enters these answers; nothing is owed as a file here.`;
  // THE ISSUING AGENCY'S APPLICATION, NAMED AS ITS. Where the per-job lookup cites another agency
  // as a track's issuer, that track's row names the agency and its own form(s); with a form known,
  // the row is a filled PDF (not portal entry) — the agency published it.
  const issuer = (track: FormTrack) => ctx.issuingAgencies?.[track];
  const issuerWhy = (track: FormTrack, discipline: string): string => {
    const i = issuer(track);
    if (!i) return "";
    const quote = i.quote ? ` ("${i.quote.slice(0, 160)}"${i.sourceUrl ? ` — ${i.sourceUrl}` : ""})` : i.sourceUrl ? ` (${i.sourceUrl})` : "";
    return `The per-job lookup cites ${i.agency} as the agency that issues the ${discipline} permit for ${where}${quote} — so this is ${i.agency}'s own application, not ${where}'s. `;
  };
  const issuerLabel = (track: FormTrack, fallback: string): string => {
    const i = issuer(track);
    if (!i) return fallback;
    if (i.forms.length) return `${i.agency}: ${i.forms.map((f) => f.formName.replace(new RegExp(`^${i.agency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "")).join(" / ")}, filled`;
    return `${i.agency}'s ${fallback.charAt(0).toLowerCase()}${fallback.slice(1)}`;
  };
  const rowPortalOnly = (track: FormTrack): boolean => (issuer(track)?.forms.length ? false : portalOnly);
  const out: RequiredApplicationDoc[] = [];

  if (wantsBuilding) {
    // ONE building-side row, chosen BY PATH — never both. A required set that
    // tells a prescriptive project to attach the structural application is
    // wrong in the same way filing both is wrong.
    // ONE mapping from path → application kind, shared with the fill-time gate and the
    // presence/packaging filters (ahjForms.applicationKindForPath). A second copy here
    // is how the two sides drift into disagreeing about which form the AHJ is owed.
    const kind = applicationKindForPath(path) ?? "";
    const label =
      standardReview ? "Building permit application (the AHJ's own), filled"
      : kind === "structural" ? "Structural (non-prescriptive) permit application, filled"
      : kind === "prescriptive" ? "Prescriptive solar permit application, filled"
      : "Building-side permit application (prescriptive or structural), filled";
    const why =
      standardReview
        ? `${where} files a ${permitWord}; its review is the standard structural (building) review — one building application, no prescriptive-vs-structural choice on file for this jurisdiction. File the AHJ's own building application.`
      : kind === "structural"
        ? `${where} files a ${permitWord}, and this project resolved to the ENGINEERED (non-prescriptive) path — file ${named || "the AHJ's structural (standard building) permit application"}. The prescriptive one must NOT also go up; the AHJ takes exactly one.`
        : kind === "prescriptive"
          ? `${where} files a ${permitWord}, and this project resolved to the PRESCRIPTIVE path — file ${named || "the AHJ's prescriptive solar application"}. The structural one must NOT also go up; the AHJ takes exactly one.`
          : `${where} files a ${permitWord}, but the permit path is not confirmed. The prescriptive and structural applications are mutually exclusive — set the path (Manual entry → Permit path) so the right one is built.`;
    const buildingPortalOnly = rowPortalOnly("building");
    const buildingLabel = issuerLabel("building", label);
    const buildingWhy = issuerWhy("building", combo ? "combined building + electrical" : "structural (building)") + why;
    out.push({
      docType: "building_application",
      // A blank whose name says neither "building" nor "structural" is stored
      // under the generic key by classifyFormType; accept it here so the row is
      // not demanding a file that already exists under another name.
      altDocTypes: ["permit_application"],
      label: buildingPortalOnly ? `${buildingLabel.replace(/, filled$/, "")} — entered in the portal at staging` : buildingLabel,
      why: buildingPortalOnly ? buildingWhy + portalNote : buildingWhy,
      lane: "permit",
      // An unconfirmed path is ALREADY a hard block at repository.ts (staging
      // refuses until the operator picks). Blocking here too would only replace
      // a precise message with a vaguer one.
      blocking: separate && path !== "unknown" && !buildingPortalOnly,
      discipline: combo ? "combo" : "structural",
      // No split, no kind: on a standard (or stamped) structural review there is ONE building
      // application, so the form finder is not steered at "the structural one, not the
      // prescriptive one" (the Iowa City form-finder wording, e2e-gap close 2026-09-26).
      ...(kind && !standardReview ? { applicationKind: kind } : {}),
    });
  }

  if (wantsElectrical) {
    const statute = (project.state || "").trim().toUpperCase() === "OR" ? " (Oregon: OAR 918-050-0180.)" : "";
    const electricalPortalOnly = rowPortalOnly("electrical");
    const electricalLabel = issuerLabel("electrical", `Electrical ${oregon ? "(renewable-energy) " : ""}permit application, filled`);
    out.push({
      docType: "electrical_application",
      // DELIBERATELY NO `permit_application` ALIAS. One generic blank must never
      // be able to satisfy both the building-side row and this one — that is the
      // exact shape of the failure this set exists to catch.
      label: electricalPortalOnly
        ? `${electricalLabel.replace(/, filled$/, "")} — entered in the portal at staging`
        : electricalLabel,
      why: issuerWhy("electrical", "electrical") + (separate
        ? `${where} files SEPARATE building and electrical permits, so the ${oregon ? "renewable-energy " : ""}electrical application is required in addition to the building-side one — on either permit path, on every interconnection.${statute}`
        : `${where}'s process profile records that an electrical permit application is required. Confirm it before filing.`) + (electricalPortalOnly ? portalNote : ""),
      lane: "permit",
      blocking: separate && !electricalPortalOnly,
      discipline: "electrical",
    });
  }

  // A STATE ISSUER FILES ITS OWN APPLICATION PER TRACK (issue #53, NM CID; Helm's decision on PR #64):
  // CID takes a building application and a SEPARATE electrical application, so each track it issues
  // keeps its own blocking row, satisfied only by CID's form of that type — no altDocTypes between
  // them, and no generic alias (the generic slot is the AHJ's). The AHJ's OWN application stays
  // required as what it is here: the local zoning / site-development review that comes first
  // (applicationDocsAgency.stateIssuerKeepsGenericSlot), acquired and filled as before #45.
  const stateIssuer = ctx.stateIssuer;
  const covered = stateIssuer ? out.filter((r) => stateIssuer.tracks.some((t) => TRACK_FORM_TYPES[t][0] === r.docType)) : [];
  if (stateIssuer && covered.length) {
    const at = out.indexOf(covered[0]);
    const owed = covered.some((r) => r.blocking);
    const local: RequiredApplicationDoc = {
      docType: "permit_application",
      label: `${stateIssuer.localReviewer}'s own application for the local zoning / site-development review (the first step), filled`,
      why: `${stateIssuer.localReviewer} has no building department of its own: it reviews zoning and the site plan FIRST, on its own application, and ${stateIssuer.agency} then issues the ${stateIssuer.tracks.join(" and ")} permit${stateIssuer.tracks.length > 1 ? "s" : ""}, each on its own application.${portalOnly ? portalNote : ""}`,
      lane: "permit",
      blocking: separate && path !== "unknown" && !portalOnly,
      discipline: "structural",
    };
    const issuerRows: RequiredApplicationDoc[] = stateIssuer.forms.map((f) => ({
      docType: TRACK_FORM_TYPES[f.track][0],
      label: `${stateIssuer.agency}: ${f.formName}, filled`,
      why: `${stateIssuer.agency} issues the ${f.track} permit for ${where} (state rule, seeded — ${f.sourceUrl}) on its own ${f.formName}; only ${stateIssuer.agency}'s ${f.track} form satisfies this row. It is ${stateIssuer.agency}'s form, looked for on its own forms page (${f.searchUrl}), never ${where}'s.${f.url && f.fill === "by_hand" ? ` ${f.note} (download: ${f.url}).` : ""}`,
      lane: "permit",
      blocking: owed,
      discipline: f.track === "building" ? "structural" : "electrical",
    }));
    for (const r of covered) out.splice(out.indexOf(r), 1);
    out.splice(Math.min(at, out.length), 0, local, ...issuerRows);
  }

  // THE PRESCRIPTIVE CHECKLIST IS THE PRESCRIPTIVE PATH'S SEALED LETTER.
  //
  // The two building-side paths are mutually exclusive, and each carries its OWN evidence
  // that the path applies:
  //
  //     engineered    → PE stamp + sealed structural letter/calcs  (resolveStampRequirement,
  //                     blocking, in requiredDocuments above)
  //     prescriptive  → the itemized prescriptive checklist        (THIS ROW)
  //
  // Only the engineered half was ever demanded. The prescriptive half existed as an
  // advisory sourced from one process-profile flag that most AHJ rows leave false — so a
  // prescriptive filing went out with no checklist and nothing said a word. Coos Bay
  // 187-26-000309-STR and 187-26-000305-STR came back "Intake Requirements Needed", and
  // the operator's own account of why was "Prescriptive checklist and didnt call out
  // stamps that were needed". A gate that polices one half of a mutually-exclusive pair
  // is the same inverted gate formApplicationKind had, seen from the other side.
  //
  // PATH-SCOPED, and that scoping is load-bearing in BOTH directions: the checklist is
  // required on the prescriptive path and must NOT go up on the engineered one, where it
  // is precisely the upload the AHJ forbids ("upload only the application that pertains —
  // DO NOT upload both"). documentInventory suppresses the KB's prose version on the
  // engineered path for the same reason.
  if (wantsChecklist && path !== "engineered") {
    // Oregon publishes the checklist as a statewide form (BCD 440-5952) and its AHJs
    // inherit it, which is where a Coos Bay project's requirement actually comes from —
    // say that, rather than putting words in the city's mouth.
    const oregon = (project.state || "").trim().toUpperCase() === "OR";
    const basis = oregon
      ? "Oregon publishes the checklist as BCD form 440-5952 and its jurisdictions file it on the prescriptive path."
      : "This jurisdiction's application profile records a solar checklist / eligibility worksheet alongside the application.";
    out.push({
      docType: "solar_checklist",
      label: "Solar prescriptive checklist, filled",
      why: path === "prescriptive"
        ? `${where} takes one of two mutually exclusive building-side paths and this project resolved to the PRESCRIPTIVE one. The checklist is that path's own evidence that the system meets the prescriptive code — the counterpart to the PE stamp + sealed structural letter on the engineered path. ${basis} Without it the AHJ has nothing on which to grant the reduced-fee, no-plan-review path.`
        : `${where} takes one of two mutually exclusive building-side applications, and the permit path is not confirmed. If it resolves to PRESCRIPTIVE the checklist is required as that path's evidence of prescriptive compliance; if it resolves to ENGINEERED do NOT file it — the PE stamp + sealed structural letter take its place. ${basis}`,
      lane: "permit",
      // BLOCKING ON A CONFIRMED PRESCRIPTIVE PATH. This is not a flag-derived guess about
      // a second permit (the advisory-only case the blocking-source rule above guards):
      // it is the evidence for a path THIS SYSTEM chose, and filing that path without it
      // is what the two live records bounced for. An UNCONFIRMED path stays advisory —
      // staging already hard-blocks an unknown path with a more precise message, and
      // demanding a document we cannot yet say is owed would be the mirror-image mistake.
      blocking: path === "prescriptive",
      discipline: combo ? "combo" : "structural",
    });
  }

  if (worksheet) out.push(worksheet);
  return out;
}

/**
 * THE STATE PV WORKSHEET ROW (Iowa SFM worksheet). Registered where the per-job lookup stores a
 * permit's documents — any lookup document naming the worksheet makes it BLOCKING for that AHJ —
 * and, beneath it, the cited state rule: blocking where the rule records the AHJ's application
 * requires it (Iowa City), advisory elsewhere in the state. One wording predicate
 * (iowaPvWorksheet.namesPvWorksheet). docType pv_worksheet — NOT solar_checklist, which is the
 * prescriptive path's evidence and is dropped on the engineered path.
 */
export function pvWorksheetRequirement(project: ProjectRecord): RequiredApplicationDoc | null {
  const state = String(project.state ?? "").trim();
  const ahj = String(project.ahj ?? "").trim();
  if (!state) return null;
  const lookup = ahj ? permitProcessFor({ state, ahj }) : null;
  for (const permit of lookup?.permits ?? []) {
    const hit = (permit.documents?.value ?? []).find((d) => namesPvWorksheet(d));
    if (hit) {
      return {
        docType: PV_WORKSHEET_DOC_TYPE, label: "PV worksheet (state electrical worksheet), filled", lane: "permit", blocking: true, discipline: "electrical",
        why: `${ahj}'s permit process lists "${hit}"${permit.documents.sourceUrl ? ` (${permit.documents.sourceUrl})` : ""}. The worksheet is filled from the parsed plan set and its written-out 690.7/690.8/690.9 calculations; unknowns are asked, never guessed.`,
      };
    }
  }
  const rule = stateRulesFor(state).pvWorksheet;
  if (!rule?.value) return null;
  const required = Boolean(ahj) && rule.value.requiredAt.includes(normalizeAhjName(ahj));
  return {
    docType: PV_WORKSHEET_DOC_TYPE, label: `${rule.value.formName}, filled`, lane: "permit", blocking: required, discipline: "electrical",
    why: required
      ? `${ahj}'s solar application requires it as an attachment: ${rule.quote}`
      : `The state electrical inspection asks for it (${rule.quote}). Not recorded as a required attachment for ${ahj || "this AHJ"} — advisory.`,
  };
}

/**
 * Resolve the AHJ-dependent inputs requiredApplicationDocs needs. Every lookup is
 * guarded: an incomplete project (no state/ahj/city, as qc.ts builds) yields a
 * thinner context, never a throw.
 *
 * AND IT DISTINGUISHES THE TWO WAYS OF KNOWING NOTHING. A thin context used to mean
 * one of two opposite things with no way to tell them apart:
 *
 *   - THIS AHJ IS UNKNOWN. The 381-profile reference was read and has no row for this
 *     jurisdiction. Demanding nothing is correct — see NO SIGNAL, NO DEMAND above.
 *   - THE LOOKUP FAILED. The reference file could not be read, so EVERY jurisdiction
 *     looks unknown, including the ones we have complete knowledge of. Demanding
 *     nothing is then a claim we have no basis for, and it renders as an all-clear.
 *
 * knowledgeStatus carries the difference. It does not throw here — ahjFormAuto also
 * calls this function and an exception would only trade a wrong answer for a crash —
 * the refusal belongs at documentInventory(), which is the choke point every document
 * verdict and the staging gate pass through.
 */
export function applicationDocContext(project: ProjectRecord): ApplicationDocContext {
  const ctx: ApplicationDocContext = {};
  const ahj = (project.ahj || "").trim();
  if (ahj) ctx.ahjLabel = ahj;
  const knowledge = ahjProcessKnowledgeStatus();
  ctx.knowledgeStatus = knowledge.status;
  if (knowledge.status === "unavailable") ctx.knowledgeError = knowledge.error;
  try {
    ctx.permitStructure = permitStructureForProject(project);
  } catch { /* profile data optional — an unresolved structure demands nothing as blocking */ }
  try {
    const proc = findAhjProcessProfile(project);
    if (proc) {
      ctx.processFlags = {
        requiresBuildingPermitApplication: Boolean(proc.requiresBuildingPermitApplication),
        requiresElectricalPermitApplication: Boolean(proc.requiresElectricalPermitApplication),
        requiresSolarChecklist: Boolean(proc.requiresSolarChecklist),
      };
    }
  } catch { /* process profile optional */ }
  try {
    const profile = findApplicationProfile(project);
    ctx.buildingApplicationName = namedApplicationForm(profile, resolvePermitPath(project).path);
    // The structured per-AHJ checklist field. Read from the SAME profile lookup that
    // already names the form, so the set cannot demand a checklist for a jurisdiction
    // whose profile we failed to resolve.
    ctx.requiresPrescriptiveChecklist = Boolean(profile.requiresPrescriptiveChecklist);
    ctx.requiresPortalEntryOnly = Boolean(profile.requiresPortalEntryOnly);
  } catch { /* the AHJ's own name for the form is a nicety, not a requirement */ }
  try { ctx.stateIssuer = stateIssuerFormsFor(project); } catch { /* state rule optional */ }
  // WHOSE APPLICATIONS (applicationDocsAgency.formAuthorityFor): a track the per-job lookup cites
  // ANOTHER agency for carries that agency and its known forms, and the building-side name is the
  // agency's own form's.
  try {
    const resolution = resolvePermitPath(project);
    const kind = resolution.standardReview ? null : applicationKindForPath(resolution.path);
    for (const other of tracksIssuedByOther(project)) {
      const forms = agencyApplicationForms(project, TRACK_FORM_TYPES[other.track][0], other.track === "building" ? kind : null);
      (ctx.issuingAgencies ??= {})[other.track] = {
        agency: other.name, sourceUrl: String(other.fact?.sourceUrl || ""), quote: String(other.fact?.quote || ""), forms,
      };
      if (other.track === "building" && forms.length) ctx.buildingApplicationName = forms.map((f) => f.formName).join(" / ");
    }
  } catch { /* lookup optional — the AHJ's own forms apply */ }
  return ctx;
}

/** Resolve the required docs against the actual uploaded/split file inventory. */
export function documentInventory(db: AppDb, project: ProjectRecord): DocumentInventory {
  const uploads = uploadedSubmissionDocuments(db, project);
  // A FILLED APPLICATION IS A DOCUMENT. Filled AHJ forms are written to
  // backend/data/filled/<projectId>/ and have NO project_documents row, so
  // projectDocsByType cannot see them — which is why prepareSubmission already
  // merges filledFormsByDocType before packaging (repository.ts). The inventory
  // read only the uploads, so it would have called a built-and-filled
  // application "missing" forever. Same merge, same precedence: an operator who
  // uploaded their own version meant to use it.
  //
  // Narrowed to the APPLICATION family on purpose: nothing here may touch the
  // plan-set presence logic, and a stray template form_type must not be able to.
  //
  // PATH-SCOPED. The prescriptive and structural applications are mutually exclusive
  // and BOTH key to building_application, so a stale STRUCTURAL fill left over from
  // before the operator flipped the path to prescriptive used to satisfy the
  // PRESCRIPTIVE row ("via: filled form") — the gate green-lighting the exact upload
  // the AHJ forbids. filledFormsByDocType drops an off-path fill from the file list
  // before it collapses to one file per docType, so the row is satisfied only by a
  // form the path actually calls for. The permit path is passed explicitly because we
  // have the whole project here; a caller that only has an id gets the same answer
  // resolved from the record.
  const permitPath = resolvePermitPath(project).path;
  const filledApplications: Record<string, string> = {};
  try {
    for (const [type, file] of Object.entries(filledFormsByDocType(db, project.id, permitPath))) {
      if (APPLICATION_DOC_TYPES.has(type)) filledApplications[type] = file;
    }
  } catch { /* no filled dir yet — simply nothing built */ }
  const docsByType = { ...filledApplications, ...uploads };
  // Per-jurisdiction stamp threshold, so "does this project need a sealed
  // structural letter?" is answered by the AHJ's own adopted rules rather than a
  // single global assumption. Never fatal — an unknown jurisdiction simply falls
  // back to the permit-path trigger.
  let stampThresholdKwDc: number | null = null;
  let stampThresholdConfirmed = false;
  let stampThresholdBasis = "";
  let jurisdictionLabel = "";
  try {
    const ctx = resolveEffectiveCodeContext(db, project.state || "", project.ahj || "");
    const t = ctx.prescriptive?.engineerStampOverKwDc;
    if (typeof t === "number" && Number.isFinite(t)) {
      stampThresholdKwDc = t;
      // WHOSE NUMBER (codeLimitProvenance): only the AHJ's own cited row or a person-verified row is
      // a requirement; a seeded state-level note is an advisory the operator confirms.
      const prov = codeLimitProvenance(db, { state: project.state || "", ahj: project.ahj || "" }, "engineerStampOverKwDc");
      stampThresholdConfirmed = prov.confirmed;
      stampThresholdBasis = prov.layer === "state"
        ? `the seeded ${prov.state || "state"} state-level reference note`
        : `${project.ahj || "the AHJ"}'s seeded profile (no source cited)`;
    }
    jurisdictionLabel = ctx.ahj || ctx.state || "";
  } catch { /* profile data optional */ }
  // The learned AHJ process profile can also flag a stamp (hearsay → advisory).
  let processProfileRequiresStamp = false;
  try {
    processProfileRequiresStamp = Boolean(findAhjProcessProfile(project)?.requiresStructuralStamp);
  } catch { /* profile optional */ }
  // What THIS jurisdiction asks for beyond the universal set — the filled application
  // and/or checklist some AHJs want attached alongside the plan set. Learned data, so
  // advisory and never fatal to the inventory.
  let kbItems: RequiredDocItem[] = [];
  // Structure + process flags + the AHJ's own name for the path-chosen
  // application. Resolved HERE, where the guarded lookups belong, and threaded
  // into the pure function.
  const application = applicationDocContext(project);
  // AN UNREADABLE KNOWLEDGE BASE MUST NEVER RENDER AS "NOTHING IS MISSING".
  //
  // THE choke point. Every document verdict in the product reaches the operator through
  // this function: the packet card (getApplicationDocumentPackage), the submit-gate
  // report, the QC document rows, and prepareSubmission's staging refusal. If the
  // 381-profile reference is unreadable, every jurisdiction resolves to "no flags, no
  // structure", requiredApplicationDocs' NO SIGNAL, NO DEMAND rule correctly emits
  // nothing for a signal that isn't there, missingBlocking comes back empty, and the
  // screen prints the pass-green "Every required document is attached" over a lookup
  // that never happened. Measured on the live database with the file made unreachable,
  // Drew Example lost building_application, electrical_application and
  // solar_checklist — the operator's own stated reason his permit bounced — and the
  // submit gate dropped from blocker to warning.
  //
  // Refusing here is what converts that into the state Round 3 already built for it:
  // getApplicationDocumentPackage catches and sets missingDocumentsStatus
  // "unavailable", which the dashboard renders as "We could not determine which
  // documents this AHJ requires" with the reason, never an all-clear; prepareSubmission
  // does NOT catch, so staging stops with this message instead of proceeding.
  //
  // HttpError so the operator gets 503 + a readable cause rather than a 500 stack; the
  // status also says the truth, which is that a dependency is missing, not that the
  // request was wrong.
  if (application.knowledgeStatus === "unavailable") {
    throw new HttpError(
      503,
      `The AHJ process knowledge base is unreadable, so we cannot say which documents ${project.ahj || "this jurisdiction"} requires — refusing to report an empty list, which would read as "nothing is missing". Restore backend/data/reference-ahj-processes.json or set ${AHJ_PROCESS_REFERENCE_ENV} to its absolute path. Cause: ${application.knowledgeError || "unknown"}`,
      { ahjKnowledgeUnavailable: true },
    );
  }
  const docOpts = { stampThresholdKwDc, stampThresholdConfirmed, stampThresholdBasis, jurisdictionLabel, processProfileRequiresStamp, application };
  const baselineItems = requiredDocuments(project, docOpts);
  // A HELD BUT UNFILLABLE AGENCY APPLICATION IS STILL REQUIRED — AS A FILE TO ATTACH. The row
  // keeps blocking exactly as before; its words stop promising a fill that cannot happen.
  try {
    const blanks = heldUnfillableAgencyBlanks(db, project);
    for (const item of baselineItems) {
      const blank = blanks.find((b) => (b.formType === item.docType || (item.altDocTypes ?? []).includes(b.formType))
        && (!item.applicationKind || !b.applicationKind || b.applicationKind === item.applicationKind));
      if (!blank) continue;
      item.label = `${item.label.replace(/, filled$/, "")}, completed by hand and attached`;
      item.why += ` ${blank.agency}'s blank "${blank.formName}" is held but is not fillable — print it, complete it by hand, and attach it here.`;
    }
  } catch { /* wording only */ }
  try {
    const kb = findKnowledgeForLearn(db, { state: project.state, ahj: project.ahj, utility: project.utility });
    const reqs = kb.ahj?.requiredDocuments ?? [];
    if (reqs.length) {
      const baseline = new Set(baselineItems.flatMap((i) => [i.docType, ...(i.altDocTypes || [])]));
      // A PRESCRIPTIVE CHECKLIST ON THE ENGINEERED PATH IS THE UPLOAD THE AHJ FORBIDS.
      //
      // The baseline checklist row is path-scoped, so on the engineered path it emits
      // nothing — which is exactly what let the KB's own prose ("Solar prescriptive
      // checklist", matched by KB_APPLICATION_DOC_PATTERNS) back in behind it and tell an
      // ENGINEERED filing to attach the prescriptive path's document. Suppression here is
      // the same mutually-exclusive rule one layer down: on this path the PE stamp +
      // sealed structural letter is the evidence, and the checklist is simply not owed.
      if (permitPath === "engineered") baseline.add("solar_checklist");
      kbItems = kbApplicationDocItems(reqs, baseline);
    }
  } catch { /* KB optional */ }
  const required = [...baselineItems, ...kbItems];
  // NOTHING KNOWN IS NOT NOTHING OWED (leak sweep unknown-as-fact-unknown-ahj-green-all-clear). NO
  // SIGNAL, NO DEMAND keeps an unnamed application from BLOCKING — but an empty application set
  // because nobody knows this AHJ rendered the pass-green "Every required document is on file"
  // (Waltham MA: building + wires, in person). Said here, once, for the packet and the gate.
  let applicationSetUnknown: string | undefined;
  try {
    const flags = application.processFlags ?? {};
    const anyFlag = Boolean(flags.requiresBuildingPermitApplication || flags.requiresElectricalPermitApplication || flags.requiresSolarChecklist);
    const citedDocs = (permitProcessFor(project)?.permits ?? []).some((p) =>
      Array.isArray(p.documents?.value) && p.documents!.value.length > 0 && /^https?:\/\//i.test(String(p.documents?.sourceUrl || "")));
    if (!requiredApplicationDocs(project, application).length && (application.permitStructure ?? "unknown") === "unknown"
      && !anyFlag && !citedDocs && !kbItems.length && !application.issuingAgencies) {
      const where = (project.ahj || "").trim() || "this AHJ";
      applicationSetUnknown = `Which permit application(s) ${where} requires is not known — no cited agency page, person-verified record, state rule or seeded process profile names them, so nothing here demands one and nothing here has checked. Find ${where}'s own application form(s) and attach them before submitting.`;
    }
  } catch { /* the lookups are optional; an error here leaves the verdict as it was */ }
  // A doc type whose upload was the SAME FILE as another's (submissionDocuments.duplicateUploads) is
  // attached once, under the first type. Its row is FLAGGED rather than silently satisfied or
  // silently blocking: one datasheet can legitimately cover both (an AC module's sheet includes its
  // microinverter), and a person confirms which.
  const duplicates = new Map(duplicateUploads(projectDocsByType(db, project.id)).map((d) => [d.docType, d.sameAs]));
  const presence: DocPresence[] = required.map((item) => {
    const sameAs = duplicates.get(item.docType);
    const p = sameAs && uploads[sameAs]
      ? { present: true, via: `same file as ${sameAs.replace(/_/g, " ")} — attached once; confirm it covers the ${item.docType.replace(/_spec$/, "").replace(/_/g, " ")}` }
      : present(item, project, docsByType, uploads, filledApplications);
    // HONESTY CHECK on the sealed letter: presence only proves a FILE is in the
    // slot — a placeholder PDF satisfies the gate identically (live-tested with a
    // file literally named "FAKE STAMPS.pdf"). We can't verify a real PE seal
    // automatically, but when the attached letter HAS a text layer and that text
    // carries no seal/engineer language at all, say so on the row instead of
    // presenting it as settled. Advisory only — scanned letters with no text
    // layer stay untouched, and the human reviewer remains the authority.
    if (item.docType === "structural_letter" && p.present && p.via === "attached file") {
      try {
        const row = db.get<{ extracted_text?: string }>(
          `SELECT extracted_text FROM project_documents
           WHERE project_id = ? AND doc_type IN ('structural_letter','stamped_plans','engineering_letter')
           ORDER BY uploaded_at DESC LIMIT 1`,
          [project.id],
        );
        const text = String(row?.extracted_text || "");
        const hasSealLanguage = /seal|stamp|p\.?\s?e\.?\b|professional engineer|structural engineer|licensed engineer|expires/i.test(text);
        if (text && text !== "[no text layer]" && text.length > 40 && !hasSealLanguage) {
          return { ...item, present: true, via: "attached file — no PE seal language found in its text; confirm it is the real sealed letter before submitting" };
        }
      } catch { /* advisory only — never block on this check */ }
    }
    return { ...item, present: p.present, via: p.via };
  });
  return {
    required,
    presence,
    missingBlocking: presence.filter((p) => !p.present && p.blocking),
    missingAdvisory: presence.filter((p) => !p.present && !p.blocking),
    ...(applicationSetUnknown ? { applicationSetUnknown } : {}),
  };
}

// ---------------------------------------------------------------------------
// THE JOB'S OWN REQUIRED LIST, CHECKED ITEM BY ITEM (e2e-gap close, 2026-09-26 — MF6).
//
// qc.ts's docs.complete row said "Every document this filing needs for Waltham City is attached"
// on a job whose manifest listed the city's own cited six (workers-comp affidavit, waste-debris
// form, CSL/HIC copy, two engineer letters, the Wires application) with none of them on file.
// The row was true of the UNIVERSAL set the inventory tracks, and false of the list the AHJ
// published. This reads the job's REQUIRED list — the per-job lookup's cited documents when it
// has any, else a shipped profile's own list — maps each item to the document slot that would
// hold it, and says which are not attached. An item no slot can hold is not attached either.
// When neither source names a list, the answer is "not yet confirmed", never "every document".
// ---------------------------------------------------------------------------

export interface RequiredListItem {
  text: string;
  /** The slot(s) that would satisfy it; empty when nothing this product holds can. */
  docTypes: string[];
  present: boolean;
  via: string;
  /** Why the item does not apply to this job (the other permit path; entered in the portal). */
  skipped?: string;
}

export interface RequiredListCheck {
  source: "lookup" | "profile" | "unknown";
  /** Where the list came from, for the operator ("the per-job lookup (cited: <url>)"). */
  sourceLabel: string;
  items: RequiredListItem[];
  /** The items that apply and are not attached. */
  missing: RequiredListItem[];
}

// requirementSlots lives in the leaf module ./requirementSlots (applicationDocs reads it too; this module
// imports applicationDocs, so the vocabulary cannot live here without a cycle). Re-exported for callers.
export { requirementSlots };

function requirementSkipReason(text: string, path: "prescriptive" | "engineered" | "unknown", standardReview: boolean): string {
  const t = String(text || "").toLowerCase();
  if (/portal\s+entry|entered\s+in\s+the\s+portal|transfer\s+into|do\s+not\s+upload\s+this\s+worksheet/.test(t)) return "entered in the portal at staging — nothing to attach";
  if (!standardReview) {
    // An item scoped to ONE of the two paths ("… on the non-prescriptive path", "PRESCRIPTIVE PATH →
    // …", "prescriptive path only") does not apply on the other. An item naming both paths applies.
    const engineeredOnly = /non-?\s*prescriptive\s+path/.test(t);
    const prescriptiveOnly = /(?<!non-)(?<!non )prescriptive\s+path/.test(t);
    if (engineeredOnly && !prescriptiveOnly && path === "prescriptive") return "engineered-path item; this project is prescriptive";
    if (prescriptiveOnly && !engineeredOnly && path === "engineered") return "prescriptive-path item; this project is engineered";
  }
  return "";
}

/**
 * THE STATUS OF AN ISSUING-AGENCY LIST LINE (agency-apps-close MF3), read from the ONE inventory the
 * fill and the gate already use — never from whether a form is known by name:
 *   attached       — an upload holds the line's slot (present()'s first answer);
 *   filled         — a filled file ON DISK for this path holds it (filledFormsByDocType: off-path
 *                    and orphaned fills dropped — present()'s second answer);
 *   on file        — the fill's own list (loadStoredTemplates) holds a template for the slot that
 *                    the path does not contradict (formContradictsPath with the stored kind — the
 *                    presence / packaging gate; on an unconfirmed path the fill waits for it);
 *   held, not fillable — the issuing agency's blank is stored but nothing maps
 *                    (heldUnfillableAgencyBlanks, the same list the fill reports needs_manual);
 *   not yet on file — none of these.
 * A step at another office (no slot) has no status here. Read by requiredListCheck (docs.complete)
 * and by the packet door (repository.assembleApplicationDocumentPackage), so the manifest and the QC
 * row print the same words the gate's presence rows mean.
 *
 * PER FORM (agency-apps-close2 rule 2 — the skeptic's M3: two Douglas County applications for one track,
 * one held, and the SLOT's word printed on both). A line that names a specific form ("form") reads
 * THAT form's template: the stored rows matched to it by source URL, then the blank's sha256 (a curated
 * seed's hash), then its form name; "filled" only when a filled PDF of one of THOSE templates is on disk
 * for this path (filledApplicationForms: off-path and orphaned fills dropped). An upload holds the whole
 * slot and reads "attached" on every line of it — which form it is, only a person can say. The generic
 * "<agency>'s application" line (no form named) keeps the slot's answer; so does the checklist line.
 */
export function agencyListStatusResolver(db: AppDb, project: ProjectRecord): AgencyLineStatusOf {
  // Read on the FIRST line asked — a job whose lookup names no other agency (every QC run of every
  // other project) never loads the template blobs for nothing.
  let inventory: {
    permitPath: "prescriptive" | "engineered" | "unknown";
    uploads: Record<string, string>;
    filled: Record<string, string>;
    filledTemplateIds: Set<string>;
    stored: ReturnType<typeof loadStoredTemplates>;
    blanks: ReturnType<typeof heldUnfillableAgencyBlanks>;
  } | null = null;
  const read = () => {
    if (inventory) return inventory;
    const permitPath = resolvePermitPath(project).path;
    let uploads: Record<string, string> = {};
    try { uploads = uploadedSubmissionDocuments(db, project); } catch { uploads = {}; }
    let filled: Record<string, string> = {};
    try { filled = filledFormsByDocType(db, project.id, permitPath); } catch { filled = {}; }
    const filledTemplateIds = new Set<string>();
    try {
      for (const f of filledApplicationForms(db, project.id, permitPath)) {
        const id = f.filePath.replace(/^.*[\\/]/, "").replace(/\.pdf$/i, "");
        if (id.startsWith("tmpl-")) filledTemplateIds.add(id.slice(5));
      }
    } catch { /* nothing filled yet */ }
    let stored: ReturnType<typeof loadStoredTemplates> = [];
    try { stored = loadStoredTemplates(db, project.ahj, project.state); } catch { stored = []; }
    let blanks: ReturnType<typeof heldUnfillableAgencyBlanks> = [];
    try { blanks = heldUnfillableAgencyBlanks(db, project); } catch { blanks = []; }
    inventory = { permitPath, uploads, filled, filledTemplateIds, stored, blanks };
    return inventory;
  };
  const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
  // C1 (agency-contain): a NAME makes a stored row "this form" only when this job may use that row at all
  // (agencyRowAppliesToJob) — one anchor-site read per agency, on first need.
  const anchorsByAgency = new Map<string, () => ReadonlySet<string>>();
  const anchorsFor = (agency: string) => {
    if (!anchorsByAgency.has(agency)) anchorsByAgency.set(agency, anchorSitesOnce(project, agency));
    return anchorsByAgency.get(agency)!;
  };
  return (item) => {
    const types = item.docTypes;
    if (!types.length) return null;
    // RULE 1 (agency-apps-close2): a PDF the lookup cited that could not be confirmed as the agency's is
    // never on file, never filled — whatever holds the slot, it is not this document.
    if (item.form && !item.form.confirmed) return "cited_unconfirmed";
    const { permitPath, uploads, filled, filledTemplateIds, stored, blanks } = read();
    if (types.some((t) => uploads[t])) return "attached";
    const form = item.form;
    if (form) {
      // THIS form's templates: URL first, then the blank's hash (both name the document itself, whoever
      // it is stored under), then the form's own name — a name only among the AGENCY's own rows (the
      // AHJ's own same-named application is not the agency's form).
      const isThisForm = (t: { formType: string; sourceUrl: string; sourceHash: string; formName: string; owner: string; verified: boolean }): boolean =>
        types.includes(t.formType || "permit_application")
        && ((Boolean(form.sourceUrl) && t.sourceUrl === form.sourceUrl) || (Boolean(form.sha) && t.sourceHash === form.sha)
          || (Boolean(norm(form.formName)) && norm(t.formName) === norm(form.formName) && Boolean(item.agency) && rowBelongsToAuthority(t.owner, String(item.agency))
            && agencyRowAppliesToJob(project, String(item.agency), { sourceUrl: t.sourceUrl, sourceHash: t.sourceHash, verified: t.verified }, anchorsFor(String(item.agency)))));
      const mine = stored.filter((t) => isThisForm({ formType: t.formType, sourceUrl: t.sourceUrl, sourceHash: t.sourceHash, formName: t.def.formName, owner: t.authority, verified: t.verified }));
      const myBlanks = blanks.filter((b) => isThisForm({ ...b, owner: b.agency }));
      if (mine.some((t) => filledTemplateIds.has(t.templateId))) return "filled";
      if (mine.some((t) => !formContradictsPath(t.def.formName, permitPath, t.applicationKind))) return "on_file";
      if (myBlanks.some((b) => !formContradictsPath(b.formName, permitPath, b.applicationKind))) return "held_not_fillable";
      return "not_on_file";
    }
    if (types.some((t) => filled[t])) return "filled";
    // The slot a stored row fills is its AUTHORITY's (applicationSlotFor) — the key filledApplicationForms
    // gives its fill — so a state issuer's line is never "on file" off the AHJ's own blank, nor the reverse.
    if (stored.some((t) => types.includes(applicationSlotFor(project, t.formType || "permit_application", t.authority)) && !formContradictsPath(t.def.formName, permitPath, t.applicationKind))) return "on_file";
    if (blanks.some((b) => types.includes(applicationSlotFor(project, b.formType, b.agency)) && !formContradictsPath(b.formName, permitPath, b.applicationKind))) return "held_not_fillable";
    return "not_on_file";
  };
}

/** The per-job lookup's cited document list (every permit's, deduped), or []. */
function lookupRequiredList(project: ProjectRecord): { items: string[]; sourceUrl: string } {
  const lookup = String(project.ahj || "").trim() ? permitProcessFor({ state: project.state, ahj: project.ahj }) : null;
  const items: string[] = [];
  let sourceUrl = "";
  for (const permit of lookup?.permits ?? []) {
    const docs = permit.documents;
    if (!docs || !/^https?:\/\//i.test(String(docs.sourceUrl || ""))) continue;
    for (const raw of docs.value ?? []) {
      const text = String(raw || "").trim();
      if (!text || items.some((i) => i.toLowerCase() === text.toLowerCase())) continue;
      items.push(text);
    }
    if (!sourceUrl && (docs.value?.length ?? 0) > 0) sourceUrl = String(docs.sourceUrl);
  }
  return { items, sourceUrl };
}

/**
 * The job's REQUIRED list, item by item. `inventory` is the same documentInventory the caller
 * already built — the universal slots are read from its presence rows, and slots the inventory does
 * not track (a utility bill, labels) from the uploads directly.
 */
export function requiredListCheck(db: AppDb, project: ProjectRecord, inventory: DocumentInventory): RequiredListCheck {
  const pathResolution = resolvePermitPath(project);
  const path = pathResolution.path;
  const standardReview = Boolean(pathResolution.standardReview);
  let source: RequiredListCheck["source"] = "unknown";
  let sourceLabel = "";
  let texts: string[] = [];
  // Items with a KNOWN slot (the issuing agency's list names its own slots) or a step at another
  // office (a prerequisite, settled by the operator's zoning answer — not a file).
  const structured = new Map<string, { docTypes: string[]; prerequisite: boolean; unconfirmed?: { agency: string }; formStatus?: AgencyLineStatus }>();
  const found = lookupRequiredList(project);
  // THE ISSUING AGENCY'S LIST (applicationDocsAgency.issuingAgencyDocumentList): where the lookup
  // cites another agency as a permit's issuer, the job's list names THAT agency's applications, the
  // state checklist on the prescriptive path and the city's prerequisite step.
  let agencyList: ReturnType<typeof issuingAgencyDocumentList> = null;
  try { agencyList = issuingAgencyDocumentList(project, agencyListStatusResolver(db, project)); } catch { agencyList = null; }
  const addAgencyItems = (onlyUncovered: boolean): void => {
    // "Uncovered" by the LOOKUP's own list — never by an agency line added a moment ago: each of the
    // agency's forms for a track is its own line (two applications, two statuses — agency-apps-close2
    // rule 2), and a cited-to-confirm PDF is named beside the agency's confirmed form (rule 1).
    const lookupTexts = [...texts];
    for (const item of agencyList?.items ?? []) {
      if (onlyUncovered && item.docTypes.length && lookupTexts.some((t) => requirementSlots(t).some((s) => item.docTypes.includes(s)))) continue;
      texts.push(item.text);
      structured.set(item.text, {
        docTypes: item.docTypes, prerequisite: item.role === "prerequisite",
        ...(item.form && !item.form.confirmed ? { unconfirmed: { agency: String(item.agency || "") } } : {}),
        // A line naming ONE form carries that form's own status (rule 2); docs.complete reads it.
        ...(item.form?.confirmed && item.status ? { formStatus: item.status } : {}),
      });
    }
  };
  // A KNOWN list only: a hand-written profile, or the seeded process profile's own lines. The
  // generic fallback SYNTHESIZES a list for an AHJ nobody has looked up — that is not a list the
  // AHJ published, and the row must say so rather than pass on it.
  const knownProfile = (): { label: string; lines: string[] } | null => {
    let profile: ReturnType<typeof findApplicationProfile> | null = null;
    try { profile = findApplicationProfile(project); } catch { profile = null; }
    if (!profile || !(profile.id.startsWith("process-") || (applicationProfiles.includes(profile) && profile.id !== "oregon-generic-epermitting"))) return null;
    return {
      label: profile.id.startsWith("process-") ? `the seeded ${project.ahj || "AHJ"} process profile (not confirmed on an agency page)` : `the ${profile.name} profile`,
      lines: profile.requiredDocuments.filter((t) => String(t || "").trim()),
    };
  };
  if (found.items.length) {
    source = "lookup";
    sourceLabel = `the per-job process lookup (cited: ${found.sourceUrl})`;
    // A raw entry that IS one of the agency list's PDFs gives way to the agency's line for it.
    texts = agencyList ? found.items.filter((t) => !agencyListNamesDocument(agencyList!, t)) : found.items;
    addAgencyItems(true);
  } else if (agencyList) {
    source = "lookup";
    sourceLabel = `the per-job process lookup's issuing agenc${agencyList.agencies.length > 1 ? "ies" : "y"} (${agencyList.agencies.join(", ")}${agencyList.sourceUrl ? `, cited: ${agencyList.sourceUrl}` : ""})`;
    addAgencyItems(false);
    // SPLIT AGENCIES (agency-apps-close MF2): the agency's list replaces the AHJ's lines only for the
    // TRACK that agency issues. The AHJ's own known lines for the tracks it issues itself stay — Coos
    // Bay's building application where Coos County issues only the electrical permit.
    const own = knownProfile();
    const kept = own ? own.lines.filter((l) => !agencyListReplacesLine(agencyList!, l)) : [];
    if (own && kept.length) {
      sourceLabel += ` and ${own.label}`;
      texts.push(...kept);
    }
  } else {
    const own = knownProfile();
    if (own) {
      source = "profile";
      sourceLabel = own.label;
      texts = own.lines;
    }
  }
  if (source === "unknown") return { source, sourceLabel: "", items: [], missing: [] };

  const presenceByType = new Map<string, DocPresence>();
  for (const p of inventory.presence) presenceByType.set(p.docType, p);
  let uploads: Record<string, string> = {};
  try { uploads = uploadedSubmissionDocuments(db, project); } catch { uploads = {}; }
  const items: RequiredListItem[] = texts.map((text) => {
    const known = structured.get(text);
    if (known?.prerequisite) {
      const status = prerequisiteSettled(project.parserSnapshot);
      return { text, docTypes: [], present: status.settled, via: status.via || "not yet answered — asked on the project (zoning sign-off question)" };
    }
    // A PDF CITED BUT NOT CONFIRMED AS THE AGENCY'S (agency-apps-close2 rule 1) is never present — it is
    // not the document in any slot. It blocks only as OWED: while nothing holds the track's slot it is
    // missing; once the slot holds the agency's application (a confirmed form filled, an upload), it is
    // set aside with the reason.
    if (known?.unconfirmed) {
      const agency = known.unconfirmed.agency || "the issuing agency";
      const holder = known.docTypes.map((t) => presenceByType.get(t)).find((p) => p?.present);
      const uploaded = known.docTypes.find((t) => uploads[t]);
      if (holder || uploaded) {
        return { text, docTypes: known.docTypes, present: false, via: "", skipped: `cited, not confirmed as ${agency}'s form — ${agency}'s application for this track is already ${holder?.via || (uploaded ? "attached" : "on file")}` };
      }
      return { text, docTypes: known.docTypes, present: false, via: `cited, not confirmed as ${agency}'s form — confirm it (or attach ${agency}'s own) before it is used` };
    }
    const skipped = requirementSkipReason(text, path, standardReview);
    const docTypes = known?.docTypes ?? requirementSlots(text);
    if (skipped) return { text, docTypes, present: false, via: "", skipped };
    // ONE FORM, ITS OWN ANSWER (agency-apps-close2 rule 2): a line naming a specific agency form is
    // present only when THAT form is filled for this path, or the slot holds an upload — never because
    // the slot holds the agency's OTHER form of the same track.
    if (known?.formStatus) {
      const st = known.formStatus;
      return { text, docTypes, present: st === "filled" || st === "attached", via: st === "filled" ? "filled form" : st === "attached" ? "attached file" : "" };
    }
    for (const t of docTypes) {
      const p = presenceByType.get(t);
      if (p?.present) return { text, docTypes, present: true, via: p.via || "attached" };
      if (uploads[t]) return { text, docTypes, present: true, via: "attached file" };
      // A sheet the inventory does not list as its own row may still be inside the plan set.
      if (PLAN_SHEET_HINTS[t] && sheetInPlanSet(project, t, uploads)) return { text, docTypes, present: true, via: "in plan set" };
    }
    return { text, docTypes, present: false, via: "" };
  });
  return { source, sourceLabel, items, missing: items.filter((i) => !i.present && !i.skipped) };
}

/**
 * THE MISSING ROWS THE STAGING-TIME FILL PRODUCES — the forward half of present()'s
 * "filled form" answer, asked BEFORE the fill has run.
 *
 * prepareSubmission fills before it counts: on a permit-side track it runs
 * prepareOfficialDocuments -> buildFilledFormsForProject, and only THEN reads this module's
 * inventory for its 409. A read taken before that (the Stage portals button, Approve) saw
 * a checklist whose template was on file but not yet filled as "missing", and disabled
 * staging that would have succeeded — telling the operator to attach a form the system
 * fills itself (29cd57b5, 8f4ca8dd: "Solar prescriptive checklist, filled").
 *
 * The answer is present() itself — the same alias-aware "is this row satisfied by a filled
 * form" test documentInventory uses — run against the forms the fill WILL write instead of
 * the ones already on disk. What the fill will write is read off the fill's own gates, not
 * a restatement of them:
 *   - nothing on an unconfirmed path (prepareOfficialDocuments returns before filling);
 *   - loadStoredTemplates, the list buildFilledFormsForProject iterates (it already drops a
 *     blank with no usable field map);
 *   - formAllowedForPath with the STORED kind, the fill loop's own path gate;
 *   - the row's form_type, the key filledApplicationForms gives a tmpl-* fill, narrowed to
 *     APPLICATION_DOC_TYPES exactly as documentInventory narrows filled forms.
 * Built-in registry forms are NOT counted: their name -> docType mapping lives inline in
 * filledApplicationForms, and a second copy of it here is how the two would drift. Leaving
 * them out errs toward the old answer (held), never toward an enabled button.
 *
 * What this cannot see: a stored blank whose fill THROWS (a broken AcroForm). The fill
 * outcome is not persisted anywhere readable, and pdf-lib only fails once it parses the
 * bytes. prepareSubmission's post-fill inventory check still refuses such a stage, in words.
 *
 * GENERATED documents (materializeGeneratedDocs) are deliberately absent: documentInventory
 * never reads them, so they cannot satisfy prepareSubmission's check either.
 */
export function missingFilledAtStaging(db: AppDb, project: ProjectRecord, missing: DocPresence[]): Set<DocPresence> {
  const out = new Set<DocPresence>();
  if (!missing.some((d) => [d.docType, ...(d.altDocTypes || [])].some((k) => APPLICATION_DOC_TYPES.has(k)))) return out;
  const permitPath = resolvePermitPath(project).path;
  if (permitPath === "unknown") return out;
  const willFill: Record<string, string> = {};
  const stored = loadStoredTemplates(db, project.ahj, project.state);
  if (stored.length) {
    const formType = new Map(db.query<{ id: string; form_type: string }>("SELECT id, form_type FROM ahj_form_templates").map((r) => [String(r.id), String(r.form_type || "permit_application")]));
    for (const t of stored) {
      if (!formAllowedForPath(t.def.formName, permitPath, t.applicationKind)) continue;
      const docType = applicationSlotFor(project, formType.get(t.templateId) ?? "", t.authority);
      if (APPLICATION_DOC_TYPES.has(docType) && !willFill[docType]) willFill[docType] = t.def.formName;
    }
  }
  for (const d of missing) {
    if (present(d, project, {}, {}, willFill).present) out.add(d);
  }
  return out;
}

/**
 * WHAT THE OPERATOR STILL OWES BEFORE STAGING — the one answer to "which required document is
 * missing", read by the submit gate's document check (getSubmitGateReport) AND by the per-track
 * Stage / Approve scoping (gateBlockersForTracks).
 *
 * Two readers used to answer it with two predicates: the buttons dropped the rows the
 * staging-time fill produces, the gate did not — so nextStep said "The submit gate is blocked:
 * attach … Solar prescriptive checklist, filled" and the autopilot phase read BLOCKED beside an
 * ENABLED Stage portals (29cd57b5, e6b3afde). `owed` is inventory.missingBlocking minus those
 * rows; `filledAtStaging` is what was held out, so a panel can still name it instead of letting
 * it vanish.
 *
 * Only a PERMIT-lane row is ever held out: the fill runs on permit-side tracks only, and every
 * application-family row (the only kind missingFilledAtStaging can clear) is permit-lane — the
 * lane test pins that instead of trusting it. A row a person must supply (a PE letter, a plan
 * sheet, a NEM spec) is always owed.
 */
export function owedMissingDocuments(db: AppDb, project: ProjectRecord, inventory: DocumentInventory): OwedDocuments {
  const produced = missingFilledAtStaging(db, project, inventory.missingBlocking);
  const filledAtStaging = inventory.missingBlocking.filter((d) => d.lane === "permit" && produced.has(d));
  const rest = inventory.missingBlocking.filter((d) => !filledAtStaging.includes(d));
  // THE THIRD BUCKET (gates-proper C1): a permit-lane application Stage DOWNLOADS and fills itself —
  // the issuing agency's curated seed, a cited agency PDF the model may map, the AHJ's own curated
  // seed / the BCD 5952, or paid research on an open cooldown (formAcquisitionPlan.stageAcquiresForm,
  // the same plan the acquisition executes). Michael's Marion B-01S / E-01 held staging as "Attach or
  // split out" while Stage fetched them in 1.5 s. prepareSubmission's post-fill count is still the hard
  // line: a download that fails, or research that finds nothing, is refused there, in words.
  const acquiredVia = new Map<DocPresence, StageAcquiredForm>();
  let acq: StageAcquisition | null = null;
  for (const d of rest) {
    if (d.lane !== "permit" || !isApplicationFormRow(d)) continue;
    acq ??= stageAcquisitionFor(db, project);
    const got = stageAcquiresForm(db, project, d.docType, d.applicationKind, acq);
    if (got) acquiredVia.set(d, got);
  }
  const acquiredAtStaging = rest.filter((d) => acquiredVia.has(d));
  return { owed: rest.filter((d) => !acquiredVia.has(d)), filledAtStaging, acquiredAtStaging, acquiredVia };
}

export interface OwedDocuments {
  /** What the operator must supply before Stage can succeed. */
  owed: DocPresence[];
  /** Missing now; the staging-time fill produces it from a stored template. */
  filledAtStaging: DocPresence[];
  /** Missing now; Stage downloads (or researches) the blank and fills it — prepareSubmission's
   *  post-fill count still refuses if that comes back empty. */
  acquiredAtStaging: DocPresence[];
  acquiredVia: Map<DocPresence, StageAcquiredForm>;
}

/** An application-family row (a form the system acquires and fills), not a file a person supplies. */
export function isApplicationFormRow(d: Pick<DocPresence, "docType" | "altDocTypes">): boolean {
  return [d.docType, ...(d.altDocTypes || [])].some((k) => APPLICATION_DOC_TYPES.has(k));
}

/**
 * WHAT THE OPERATOR DOES ABOUT AN OWED DOCUMENT — said on the row, so the gate, the Stage reason and
 * the 409 say the same thing. A form the system acquires and fills, that no free source or research
 * pass will get, is a form to FIND (App Docs → Find missing official forms) or a blank to upload — not
 * something to "attach or split out" (the old wording sent the operator to split a plan set for the
 * county's application). Anything else (a plan sheet, a PE letter, a spec, a bill) is attached or
 * split out of the plan set.
 */
export function owedDocumentAction(d: Pick<DocPresence, "docType" | "altDocTypes" | "lane">): string {
  return d.lane === "permit" && isApplicationFormRow(d)
    ? "find the official form (App Docs → Find missing official forms) or upload the blank"
    : "attach it or split it out of the plan set";
}

// ---------------------------------------------------------------------------
// JURISDICTION-SPECIFIC APPLICATION DOCUMENTS, FROM THE KB
//
// The baseline above is the universal set — plan set, site plan, SLD, specs. What it
// cannot know is that Coos Bay's Accela config also wants a building permit application
// and a solar prescriptive checklist attached, while Portland wants its worksheet
// transcribed into DevHub and explicitly not uploaded.
//
// The KB already records exactly that, per profile, in required_documents: for
// or|city of coos bay|pacific power it lists "Building/structural permit application",
// "Solar prescriptive checklist" and "Renewable Energy (electrical) permit application".
// Nothing read it — the only consumer matched /checklist|worksheet/ to decide which BLANK
// form to go find. So the system knew what the jurisdiction wanted, filled the form, and
// never told anyone it was supposed to go up with the submittal. docSplitter's own comment
// anticipated this: "eventually this can be driven by the learned KB requiredDocuments".
//
// Scope is deliberately narrow: only the APPLICATION/CHECKLIST family, which is the part
// the baseline lacks and the part the portal upload sweep can actually attach. Everything
// else a KB list mentions (plan set, site plan, meter photo, post-install sign-off) is
// either already baseline or belongs to another lane, and surfacing it here would be noise.
//
// Advisory, never blocking: KB rows are learned, they vary in quality, and a wrong blocker
// would stop a filing that is genuinely complete. The operator decides.
// ---------------------------------------------------------------------------

/** KB requirement prose -> the docType that holds it. Ordered: specific before generic.
 *  This vocabulary must agree with the portal-side UPLOAD_LABEL_PATTERNS, or a document is
 *  demanded here under a name no upload slot will ever match — asserted in
 *  backend/test/filledFormUpload.test.ts. */
export const KB_APPLICATION_DOC_PATTERNS: Array<{ re: RegExp; docType: string; label: string }> = [
  // "Electrical" and "application" are often several words apart — Portland's form is the
  // "Electrical Renewable Energy Permit Application", which an adjacency-only pattern reads
  // as a generic application.
  { re: /electrical[\w\s/&()-]{0,40}application|renewable\s*energy[\w\s/&()-]{0,20}electrical/i, docType: "electrical_application", label: "Electrical permit application (filled)" },
  { re: /(building|structural)\s*(permit\s*)?application/i, docType: "building_application", label: "Building / structural permit application (filled)" },
  { re: /checklist|worksheet|eligibilit/i, docType: "solar_checklist", label: "Solar prescriptive checklist (filled)" },
  { re: /(solar|permit|completed|signed)\s*application|application\s*(form|packet)/i, docType: "permit_application", label: "Permit application (filled)" },
];

/**
 * Map a KB profile's required-documents prose to the application/checklist documents this
 * jurisdiction expects attached. `alreadyRequired` suppresses anything the baseline covers.
 */
export function kbApplicationDocItems(requirements: string[], alreadyRequired: Set<string> = new Set()): RequiredDocItem[] {
  const seen = new Set<string>();
  const out: RequiredDocItem[] = [];
  for (const raw of requirements || []) {
    const text = String(raw || "").trim();
    if (!text) continue;
    // A REBATE APPLICATION IS NOT THE FILING. Sweeping the mapper across all 461 KB
    // profiles turned up "Illinois Distributed Generation Rebate Application (Rider CGR)",
    // which happens not to match the patterns below only because "Rebate" sits between the
    // words they look for. That is luck, not a rule — and treating an incentive application
    // as the permit application is the same mistake as picking the rebate programme in
    // ComEd's drawer, where it is guarded explicitly. Guard it here too.
    if (/rebate|incentive|enroll|enrolment|enrollment/i.test(text)) continue;
    const hit = KB_APPLICATION_DOC_PATTERNS.find((p) => p.re.test(text));
    if (!hit || seen.has(hit.docType) || alreadyRequired.has(hit.docType)) continue;
    seen.add(hit.docType);
    out.push({
      docType: hit.docType,
      label: hit.label,
      // The jurisdiction's own words, so the operator can judge the claim rather than
      // trusting a classification.
      why: `This jurisdiction's requirements list names it: "${text.slice(0, 140)}".`,
      lane: "permit",
      blocking: false,
    });
  }
  return out;
}
