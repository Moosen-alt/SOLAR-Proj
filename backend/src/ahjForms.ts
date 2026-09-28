import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { PDFDocument, PDFName, PDFRadioGroup, StandardFonts, rgb } from "pdf-lib";
import type { ProjectRecord } from "../../shared/src/types";
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { clientStagingOverlay } from "./clients";
import { HttpError } from "./httpError";
import { loadDefaultSignaturesByRole } from "./signatures";
import { nowIso } from "./time";
import { resolveValuation } from "./valuation";
import { parseJson } from "./json";
import { resolvePermitPath, evaluatePrescriptiveCriteria, type PrescriptiveCriterion, type PrescriptiveLimitInputs } from "./permitPath";
import { resolveEffectiveCodeContext } from "./codeProfiles";
import { isDocumentDateStale } from "./documentDate";
import { mountAdjective, mountKindForProject } from "./codeReviewRules";
import { findFeeScheduleForProject, feeForProject, knownElectricalReviewRequired, type FeeScheduleLine } from "./feeSchedules";
import { curatedPrintedFees, CURATED_SAVED_FEE_NOTE, type PrintedFeeLadder } from "./curatedAhjForms";
import {
  batteryStatus, SERVICE_FEEDER_CHARGE_KIND, SERVICE_FEEDER_COMMUNITY_SURCHARGE_KIND, SERVICE_FEEDER_STATE_SURCHARGE_KIND,
} from "./batteryServiceFeeder";
import { BCD_5952_LIMITS, type ChecklistRecovery } from "./prescriptiveChecklist";
import { bcdChecklistAnswers, bcd5952MissingFacts, bcd5952SnapshotAdditions } from "./bcdChecklistFacts";
import { iowaPvWorksheetValues } from "./iowaPvWorksheet";
import { documentFetchDisabled } from "./documentFetch";
import {
  agencyRowAppliesToJob, agencyRowProvenance, anchorSitesOnce,
  applicationKindForPath, formApplicationKind, formAuthorityFor, rowBelongsToAuthority, structureMeaningOf,
  TRACK_FORM_TYPES, tracksIssuedByOther,
} from "./applicationDocsAgency";

/** Which of the two MUTUALLY EXCLUSIVE building-side applications a permit path calls
 *  for. THE single mapping from path → application kind; requiredApplicationDocs,
 *  form acquisition, the FILL gate (formAllowedForPath) and the presence/packaging
 *  filters all read it rather than each
 *  restating `path === "engineered" ? "structural" : ...`. "unknown" deliberately
 *  yields null: before the operator confirms the path we do not know which of the two
 *  the AHJ is owed, and guessing is the failure this whole module exists to stop.
 *  (Defined in applicationDocsAgency — the issuing-agency module names an agency's application
 *  by kind without importing the fill engine — and re-exported here, where every gate reads it.) */
export { applicationKindForPath, formApplicationKind } from "./applicationDocsAgency";

// Classify an AHJ form by which mutually-exclusive solar application it is, from its
// name/filename. A prescriptive and a structural application must NEVER both be filled
// for the same project — the AHJ takes exactly one, chosen by the permit path.
//
// NULL IS A REAL ANSWER, NOT A FAILURE. Plenty of AHJs publish ONE generic application
// used on both paths ("Building Permit Application.pdf"), and a name that says neither
// "prescriptive" nor "structural" is exactly that until something better says otherwise.
// So null means "no claim" and is treated as compatible with every path — widening
// /building/ into "structural" would hard-block every single-form jurisdiction.
// Where the truth IS known (we went looking for the prescriptive blank specifically),
// acquisition stamps it on the stored template and storedApplicationKind reads it back;
// the name is the fallback, not the only source.
//
// THE STRUCTURAL TEST RUNS FIRST, AND THAT ORDER IS THE WHOLE CORRECTNESS OF THIS
// FUNCTION. "Non-Prescriptive" CONTAINS "prescriptive". With /prescriptive/ tested
// first, every form whose title is the AHJ's own phrasing for the ENGINEERED
// application — "Structural (Non-Prescriptive) Permit Application" — came back
// "prescriptive": the fill gate then built the structural application for prescriptive
// projects and refused it for engineered ones, exactly inverted, on the one pair of
// forms where being wrong means uploading the document the AHJ forbids.
// (formApplicationKind itself lives in applicationDocsAgency and is re-exported above.)

/**
 * Does a form of this kind CONTRADICT the project's resolved permit path?
 *
 * This is deliberately weaker than formAllowedForPath, and the difference matters.
 * formAllowedForPath is the FILL-time gate: on an unconfirmed path it refuses to fill
 * either application, because building the wrong one wastes a form and invites the
 * operator to upload it. This is the PRESENCE/PACKAGING gate, and it only ever removes
 * an AFFIRMATIVE contradiction — a structural application on a prescriptive project.
 * An unknown path contradicts nothing (staging already refuses outright there, with a
 * message that says what to do), and a null-kind form contradicts nothing either.
 */
export function formContradictsPath(formName: string, path: "prescriptive" | "engineered" | "unknown", knownKind?: "prescriptive" | "structural" | null): boolean {
  const want = applicationKindForPath(path);
  if (!want) return false;
  const kind = knownKind === undefined ? formApplicationKind(formName) : knownKind;
  if (!kind) return false;
  return kind !== want;
}

// Should this form be filled given the project's resolved permit path? Only the
// application matching the path is filled; non-application forms (electrical, etc.)
// always pass. When the path is unknown we fill neither application form (the operator
// must confirm the path first) — surfaced in the form message.
//
// THE NAME IS THE FALLBACK, NOT THE SOURCE. `knownKind` is the kind the STORED template
// carries (storedApplicationKind: acquisition's own stamp first, its name second). Pass
// it whenever you have it. A jurisdiction is free to publish the structural application
// as "Building Permit Application.pdf" — the name then claims nothing, this gate returned
// true on BOTH paths, and the structural blank was filled and handed to a prescriptive
// project, against the AHJ's printed "do NOT upload both". The packaging filter
// (formContradictsPath, which DOES read the stamp) dropped it from the upload sweep, so
// the two halves disagreed: the operator saw a filled structural application in the forms
// list and uploaded it by hand. Reading the same stamp here makes the fill gate and the
// packaging filter one answer.
//
// Convention matches formContradictsPath exactly: `undefined` means "no stamp in hand,
// classify by name"; an explicit `null` means "this form makes no claim" and is therefore
// compatible with every confirmed path.
export function formAllowedForPath(
  formName: string,
  path: "prescriptive" | "engineered" | "unknown",
  knownKind?: "prescriptive" | "structural" | null,
): boolean {
  const kind = knownKind === undefined ? formApplicationKind(formName) : knownKind;
  if (!kind) return true;
  // applicationKindForPath IS the path → kind mapping (see its header). Restating it here
  // as `path === "engineered" ? "structural" : ...` is what let the fill gate and the
  // presence/packaging filters drift apart while each stayed self-consistent.
  const want = applicationKindForPath(path);
  return want != null && kind === want; // unknown path → fill neither application until confirmed
}

// =============================================================================
// AHJ PDF form fill engine
//
// For a given AHJ, we know which official forms it requires. Each form has a
// verified source URL (downloaded + cached once) and a FIELD MAP that says how
// to populate each AcroForm field from project/client data. We fill, flatten,
// and emit a completed PDF that can be attached to the submission.
//
// HARD LIMITS (by design / format):
//  - Pure XFA (LiveCycle) forms cannot be filled by pdf-lib. They are detected
//    and reported so a human handles them.
//  - Forms that legally require a wet signature are still routed to a human to
//    sign; automation only pre-fills.
// =============================================================================

const TEMPLATE_DIR = path.resolve(process.cwd(), "backend/data/ahj-forms");
const FILLED_DIR = path.resolve(process.cwd(), "backend/data/filled");

// A value source mini-language used by field maps:
//   "project.<field>"  -> ProjectRecord field
//   "client.<field>"   -> linked client field (via clientStagingOverlay keys)
//   "snapshot.<key>"   -> parserSnapshot key
//   "lit:<text>"       -> literal text
//   "computed.<name>"  -> a computed helper (fullAddress, systemSize, ...)
export type FieldSource = string;

export interface CheckboxRule {
  // Field is checked when the resolved source is truthy, or equals `equals`.
  source: FieldSource;
  equals?: string;
}

/** The single checkbox decision, shared by fill + tests. An EMPTY `equals` is
 *  treated as absent (truthy check), never as `value === ""` — otherwise a rule
 *  like {source: "computed.prescSnowLoadYes", equals: ""} would tick the box
 *  exactly when the data is unverified (the "" case), inverting the safety. */
export function checkboxRuleChecked(rule: CheckboxRule, value: string): boolean {
  const equals = rule.equals != null && String(rule.equals) !== "" ? String(rule.equals) : null;
  return equals != null ? value === equals : Boolean(value);
}

// For flat (non-fillable) PDFs we draw the value at a coordinate. x/y are in
// PDF points from the bottom-left of the page (same convention pdf.js text
// extraction reports), so label baselines map directly to draw positions.
export interface OverlayField {
  source: FieldSource;
  page: number; // 0-based
  x: number;
  y: number;
  size?: number;
  maxWidth?: number; // truncate long values to fit
  // Only draw when this source resolves truthy (or equals `equals`). Used to
  // place a value on the one fee-bracket row that matches the system size.
  onlyIf?: { source: FieldSource; equals?: string };
  // The form's printed label this value belongs to (from the vision mapper).
  // When set AND the flat PDF has a text layer, the fill anchors to that label's
  // real baseline instead of the LLM's estimated x/y — fixing the "off a bit"
  // drift. Absent on hand-tuned registry defs, which keep their exact x/y.
  label?: string;
}

// Where an operator signature image is stamped. PDF points, bottom-left origin
// (the box's bottom-left corner). The image is scaled to fit, preserving aspect.
export interface SignaturePlacement {
  role: string; // applicant | owner | contractor | electrician | other
  page: number; // 0-based
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string; // the form's printed signature label, for review
  // Adjacent "date signed" line (PDF points, baseline). When set, today's date is
  // written here whenever this signature is stamped (the operator signs today).
  dateX?: number;
  dateY?: number;
  dateSize?: number;
}

export interface AhjFormDefinition {
  id: string;
  formName: string;
  matchJurisdictions: string[]; // lowercase substrings matched against project.ahj
  sourceUrl: string; // verified URL of the blank fillable PDF
  version: string;
  status: "verified" | "unverified_template";
  // "acroform" fills AcroForm fields; "overlay" draws text at coordinates on a
  // flat (non-fillable) PDF. Defaults to "acroform".
  fillMode?: "acroform" | "overlay";
  // pdf AcroForm field name -> value source (text/dropdown)
  textFields: Record<string, FieldSource>;
  // pdf AcroForm checkbox field name -> rule
  checkboxes?: Record<string, CheckboxRule>;
  // pdf AcroForm RADIO GROUP name -> rule + the option selected when the rule holds. A well-formed
  // Yes/No group (one group per question — Marion County's B-01S) is selected, never cleared: an
  // unanswered question stays unanswered. (BCD 5952's malformed groups never come through here.)
  radioGroups?: Record<string, CheckboxRule & { option: string }>;
  // overlay placements (used when fillMode === "overlay")
  overlayFields?: OverlayField[];
  // operator-signature image placements (applied to both fill modes)
  signatureFields?: SignaturePlacement[];
  /** Runtime-only recovery for unverified stored checklists. Never set on
   *  registry or human-verified definitions and never persisted to field maps. */
  recoverPrescriptiveCheckboxes?: boolean;
  notes?: string[];
  requiredFields?: Record<string, string>;
  preserveInteractive?: boolean;
  fieldFontSizes?: Record<string, number>;
}

// The registry. Seed with verified forms as field maps are confirmed via the
// inspect endpoint. Entries marked "unverified_template" will not auto-attach.
export const ahjFormRegistry: AhjFormDefinition[] = [
  {
    id: "portland-electrical-renewable-energy",
    formName: "City of Portland — Electrical Renewable Energy Permit Application",
    matchJurisdictions: ["portland", "city of portland"],
    sourceUrl: "https://www.portland.gov/ppd/documents/electrical-renewable-energy-permit-application/download",
    version: "2024",
    status: "verified",
    // This is a flat (non-AcroForm) PDF; values are drawn at coordinates derived
    // from the form's own label baselines (US Letter, 612x792, y from bottom).
    fillMode: "overlay",
    textFields: {},
    overlayFields: [
      // Type of work + Category of construction: mark "Other" and write "Solar"
      { source: "lit:X", page: 0, x: 186, y: 688, size: 9 },          // Type of work -> Other checkbox
      { source: "lit:Solar", page: 0, x: 224, y: 688, size: 9 },      // Type of work -> Other: blank
      { source: "lit:X", page: 0, x: 264, y: 643, size: 9 },          // Category -> Other checkbox
      { source: "lit:Solar", page: 0, x: 301, y: 643, size: 9 },      // Category -> Other: blank
      // Section-header role checkboxes: we file as the contractor + applicant and
      // fill the property-owner block, so check those three (not Tenant /
      // Subcontractor / Contact Person).
      { source: "lit:X", page: 0, x: 33, y: 470, size: 9 },   // ☑ Property owner
      { source: "lit:X", page: 0, x: 33, y: 358, size: 9 },   // ☑ Contractor
      { source: "lit:X", page: 0, x: 33, y: 175, size: 9 },   // ☑ Applicant
      // Job site information
      { source: "computed.streetAddress", page: 0, x: 160, y: 614, maxWidth: 200 },
      { source: "computed.cityStateZip", page: 0, x: 115, y: 597, maxWidth: 240 },
      { source: "project.homeownerName", page: 0, x: 215, y: 581, maxWidth: 150 },
      // Description of work (open area below the label)
      { source: "computed.descriptionOfWork", page: 0, x: 35, y: 516, size: 8, maxWidth: 320 },
      // Property owner
      { source: "project.homeownerName", page: 0, x: 63, y: 455, maxWidth: 130 },
      { source: "snapshot.homeownerEmail", page: 0, x: 245, y: 455, maxWidth: 110 },
      { source: "computed.streetAddress", page: 0, x: 75, y: 438, maxWidth: 280 },
      { source: "computed.cityStateZip", page: 0, x: 115, y: 421, maxWidth: 240 },
      { source: "snapshot.homeownerPhone", page: 0, x: 66, y: 404, maxWidth: 120 },
      // Contractor
      { source: "client.installerCompanyName", page: 0, x: 115, y: 342, maxWidth: 80 },
      { source: "client.installerEmail", page: 0, x: 245, y: 342, maxWidth: 110 },
      { source: "client.installerStreet", page: 0, x: 75, y: 325, maxWidth: 280 },
      { source: "client.installerCityStateZip", page: 0, x: 115, y: 308, maxWidth: 240 },
      { source: "client.installerPhone", page: 0, x: 66, y: 291, maxWidth: 120 },
      { source: "client.electricalLicenseNumber", page: 0, x: 100, y: 275, maxWidth: 90 },
      { source: "client.ccbLicenseNumber", page: 0, x: 267, y: 275, maxWidth: 90 },
      // Supervising electrician — name typed from client profile (supervisor field).
      // If an electrician signature image is stored, it is stamped via signatureFields below.
      // ONE printed name on the electrician's "Print name:" row. There used to be a second
      // overlay (computed.electricianSignerName) at y=212, which resolves to the same person
      // — a filled form showed "Charles Bitton" twice, once beside the label and once in the
      // blank strip beneath it. The form's own text layer puts "Print name:" at y=224.7, so
      // 225 is the row and 212 is dead space.
      { source: "client.electricalSupervisorName", page: 0, x: 93, y: 225, maxWidth: 150 },
      // "License no" is the RIGHT-HAND label on that same Print name row — the text layer
      // puts it at x=256.4, y=224.7. It was at y=212, one row low, so the licence number
      // floated in the gap instead of sitting beside its label. (It also once carried
      // today's DATE, from a signature placement writing its date at these coordinates.)
      { source: "client.electricianLicenseNumber", page: 0, x: 306, y: 225, maxWidth: 76 },
      // Printed name under the Authorized signature (operator who signs).
      { source: "computed.applicantSignerName", page: 0, x: 108, y: 189, maxWidth: 150 },
      // Applicant / Contact Person = our (submitter) info
      { source: "client.installerCompanyName", page: 0, x: 120, y: 161, maxWidth: 230 },
      { source: "client.installerContactName", page: 0, x: 115, y: 144, maxWidth: 230 },
      { source: "client.installerStreet", page: 0, x: 75, y: 127, maxWidth: 280 },
      { source: "client.installerCityStateZip", page: 0, x: 115, y: 110, maxWidth: 240 },
      { source: "client.installerPhone", page: 0, x: 66, y: 93, maxWidth: 120 },
      { source: "client.installerEmail", page: 0, x: 75, y: 76, maxWidth: 280 },
      // Fee schedule — renewable energy per-system fee by kVA bracket.
      // Qty=1 + Total drawn only on the row matching the system size.
      { source: "lit:1", page: 0, x: 494, y: 649, size: 8, onlyIf: { source: "computed.feeBracket", equals: "le5" } },
      { source: "computed.renewableFee", page: 0, x: 540, y: 649, size: 8, onlyIf: { source: "computed.feeBracket", equals: "le5" } },
      { source: "lit:1", page: 0, x: 494, y: 638, size: 8, onlyIf: { source: "computed.feeBracket", equals: "5to15" } },
      { source: "computed.renewableFee", page: 0, x: 540, y: 638, size: 8, onlyIf: { source: "computed.feeBracket", equals: "5to15" } },
      { source: "lit:1", page: 0, x: 494, y: 627, size: 8, onlyIf: { source: "computed.feeBracket", equals: "15to25" } },
      { source: "computed.renewableFee", page: 0, x: 540, y: 627, size: 8, onlyIf: { source: "computed.feeBracket", equals: "15to25" } },
      // Over 25 kVA solar: enter total kVA on the per-kVA line
      { source: "computed.systemKva", page: 0, x: 455, y: 443, size: 8, onlyIf: { source: "computed.feeBracket", equals: "over25" } },
      { source: "computed.renewableFee", page: 0, x: 540, y: 443, size: 8, onlyIf: { source: "computed.feeBracket", equals: "over25" } },
      // Totals block
      { source: "computed.renewableFee", page: 0, x: 540, y: 346, size: 8 },     // Subtotal
      { source: "computed.planReview", page: 0, x: 540, y: 334, size: 8 },       // Plan review (only >25 kVA)
      { source: "computed.stateSurcharge", page: 0, x: 540, y: 322, size: 8 },   // 12% surcharge
      { source: "computed.totalPermitFee", page: 0, x: 540, y: 310, size: 8 },   // TOTAL PERMIT FEE
    ],
    // The operator (applicant/submitter) signs the "Authorized signature" line
    // only. Owner and supervising-electrician lines are left blank — the
    // homeowner and the licensed electrician must sign those themselves. These
    // coordinates were mapped from the actual form layout (US Letter, y from
    // bottom); the date is written on the adjacent "Date:" line.
    signatureFields: [
      {
        role: "applicant",
        page: 0,
        // "Authorized signature:" sits at y=204.3 in the form's text layer, with the
        // Print name row above it at 224.7 — twenty points, so this line can carry a
        // fuller signature than the electrician's.
        x: 138,
        y: 204,
        width: 150,
        // Lift included, per the renderer's envelope rule.
        height: 16,
        label: "Authorized signature",
        dateX: 292,
        dateY: 189,
        dateSize: 9,
      },
      {
        // "Supervising electrician / Signature, required:" line.
        // Coordinates measured from the actual form (y from bottom, US Letter 792pt).
        // Stamped only when an electrician signature image has been stored.
        role: "electrician",
        page: 0,
        // The form's own text layer puts "Signature, required:" at y=239.7 and the
        // "Supervising electrician" label directly above it at y=248.7 — nine points of
        // room, the tightest signature row on the sheet. Anchored on the rule itself.
        // Clear of the "Signature, required:" label, which runs to about x=106.
        x: 115,
        y: 239,
        width: 150,
        // The whole 9pt gap, lift included: height is the row's budget, and the renderer
        // now fits the lift INSIDE it. At the old 12 (plus a 6pt lift added on top) the ink
        // reached 18pt and landed on the "Supervising electrician" label instead of the
        // rule — visible on Bren Trask's filled application.
        height: 9,
        label: "Supervising electrician signature",
        // NO DATE. The supervising-electrician row carries "Print name" and "License no",
        // not a date line; writing one here put today's date in the LICENCE NUMBER field
        // on a filed application. The licence itself is mapped in overlayFields above.
      },
    ],
    notes: [
      "Flat PDF (no fillable fields) filled by coordinate overlay.",
      "Type of work and Category of construction are marked Other = Solar.",
      "Fees use the rate schedule printed on the form (rev 7/1/2025): per-system kVA brackets + 12% state surcharge; 25% plan review only when over 25 kVA.",
      "Authorized signature (applicant) and supervising-electrician signature are auto-stamped when images are stored. Owner signature is left blank for homeowner to sign in person.",
    ],
  },
];

export interface FillContext {
  publishedFeeLines?: FeeScheduleLine[];
  project: ProjectRecord;
  client: Record<string, string>; // overlay keys (installerCompanyName, ccbLicenseNumber, ...)
  snapshot: Record<string, unknown>;
  // Default operator signature image per role, drawn at the form's signature
  // placements. Loaded in buildContext; empty when none are stored.
  signatures?: Record<string, { bytes: Uint8Array; mime: string; widthPx: number; heightPx: number; name: string }>;
  // Lazily-evaluated prescriptive criteria rows, cached so the presc* computed
  // sources evaluate the screen once per fill (see prescriptiveComputed).
  prescriptive?: PrescriptiveCriterion[];
  // The Iowa SFM PV worksheet's values, cached like `prescriptive` (iowaPvWorksheet.ts).
  iaPv?: Record<string, string>;
  // Per-AHJ prescriptive limit overrides from the jurisdiction code profile
  // (loaded in buildContext) — the presc* sources must screen against the SAME
  // limits QC's baseline rules use, not always the Oregon defaults.
  prescriptiveLimits?: PrescriptiveLimitInputs;
  // The jurisdiction's PUBLISHED electrical fee brackets, when one is on file. Loaded in
  // buildContext so renewableFee can prefer a schedule somebody researched over the ladder
  // printed on the form we happen to have a copy of. See renewableFee.
  publishedElectricalBrackets?: Array<{ minKw?: number | null; maxKw?: number | null; feeUsd: number }>;
  // The fee ladder PRINTED on the blank being filled (curatedAhjForms.curatedPrintedFees, by the
  // blank's own hash) — set per form by fillLoadedForm, never shared across forms. The electrical*
  // fee sources fall back to it only where no saved electrical fee line is on file.
  printedFeeLadder?: PrintedFeeLadder | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// kVA basis for renewable-energy electrical permit fees (solar inverter AC
// output ≈ kVA). Falls back to DC size if AC is missing.
function systemKva(ctx: FillContext): number {
  return Number(ctx.project.systemSizeAcKw || ctx.project.systemSizeDcKw || 0);
}

// A FEE HARDCODED FROM A FORM GOES STALE EVERY JULY, AND THIS ONE HAD.
//
// The ladder below is the one PRINTED ON THE FORM we hold a copy of (rev 7/1/2025):
// ≤5 kVA $201, 5.01–15 $283, 15.01–25 $372, >25 $14.78/kVA. Running the fee researcher at
// Portland as a brand-new AHJ on 2026-09-13 turned up the CURRENT schedule — "Electrical Permit
// Fee Schedule, City of Portland, Effective Date: July 10, 2026" — and every row had moved:
//
//     ≤5 kVA $212   5.01–15 $298   15.01–25 $391   >25 $15.52/kva
//
// Uniformly ~5.3% higher: an annual increase, the same shape as the Coos County 1.70x jump.
// So this function was writing $283 onto a Portland application where the city charges $298 —
// and it feeds the line, the subtotal, the 12% state surcharge and the TOTAL, so one stale
// constant is four wrong numbers on a document that goes to the city.
//
// The repair is not to retype the 2026 figures, which would be stale again next July. A
// published schedule on file WINS, and the printed ladder is the fallback for a jurisdiction
// nobody has researched yet — so every future fee year is free, and the worst case is exactly
// today's behaviour. feeSchedules is the same store the fee sheet and the invoice read, so the
// PDF and the quote cannot disagree about what this permit costs.
const PRINTED_LADDER: Array<{ max: number | null; fee: number | null; perKva: number | null }> = [
  { max: 5, fee: 201, perKva: null },
  { max: 15, fee: 283, perKva: null },
  { max: 25, fee: 372, perKva: null },
  { max: null, fee: null, perKva: 14.78 },
];

function renewableFee(ctx: FillContext): number {
  const k = systemKva(ctx);
  if (k <= 0) return 0;
  // Bounds are INCLUSIVE at both ends, matching feeSchedules.matchBracket — a schedule read one
  // way and evaluated another disagrees silently at the boundary.
  for (const b of ctx.publishedElectricalBrackets || []) {
    const min = b.minKw ?? null;
    const max = b.maxKw ?? null;
    if (min == null && max == null) continue;      // not a size row
    if (min != null && k < min) continue;
    if (max != null && k > max) continue;
    return Math.round(b.feeUsd * 100) / 100;
  }
  for (const row of PRINTED_LADDER) {
    if (row.max != null && k > row.max) continue;
    if (row.fee != null) return row.fee;
    return Math.round(k * (row.perKva ?? 0) * 100) / 100;
  }
  return 0;
}

function feeBracket(ctx: FillContext): string {
  const k = systemKva(ctx);
  if (k <= 0) return "";
  if (k <= 5) return "le5";
  if (k <= 15) return "5to15";
  if (k <= 25) return "15to25";
  return "over25";
}

function money(n: number): string {
  return n.toFixed(2);
}

/** "4583294881" / "+1 458.329.4881" -> "(458) 329-4881"; anything that is not a 10-digit US
 *  number (an extension, a foreign number, a blank) is returned exactly as written. */
export function formatUsPhone(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text || /[a-wyz]/i.test(text)) return text;
  let d = text.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return text;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Split text into two lines of at most `width` characters on a word boundary; the second line
 *  keeps the remainder (clipped by its own box only if the text is over two lines long). */
function wrapTwoLines(text: string, width: number): [string, string] {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= width) return [t, ""];
  let cut = t.lastIndexOf(" ", width);
  if (cut < width * 0.5) cut = width;
  return [t.slice(0, cut).trim(), t.slice(cut).trim()];
}

/** THE BATTERY'S SERVICES/FEEDERS <=200A LINE ON AN ELECTRICAL APPLICATION.
 *
 *  Operator rule 2026-09-24 (batteryServiceFeeder.ts): a battery job on an
 *  electrical permit bills ONE "Services or feeders: 200 amps or less" line on
 *  top of the PV kVA line. Every computed name that reads this is mapped onto an
 *  ELECTRICAL application only, so the form itself is the filing gate.
 *
 *  `applies` is the battery predicate; the amounts come off the electrical fee
 *  line's own charges, written by the ONE evaluator (feeSchedules
 *  .serviceFeederCharges) — never re-derived here. `priced` is false whenever the
 *  schedule does not record the amount, and then every whole-application figure
 *  (subtotal, surcharges, grand total) is left BLANK: a renewable-only total
 *  printed beside a services quantity of 1 is the same understatement as
 *  pricing the line at $0. The per-row renewable figures are unaffected. */
function serviceFeederOnForm(ctx: FillContext, line: FeeScheduleLine | undefined): {
  applies: boolean; priced: boolean; baseUsd: number; stateUsd: number; communityUsd: number;
} {
  const applies = batteryStatus(ctx.snapshot) === "yes";
  const charges = line?.charges ?? [];
  const base = charges.find((c) => c.kind === SERVICE_FEEDER_CHARGE_KIND);
  const priced = applies && base?.amountUsd != null;
  const sum = (kind: string) => charges.filter((c) => c.kind === kind).reduce((n, c) => n + (c.amountUsd ?? 0), 0);
  return {
    applies,
    priced,
    baseUsd: priced ? base!.amountUsd! : 0,
    stateUsd: priced ? sum(SERVICE_FEEDER_STATE_SURCHARGE_KIND) : 0,
    communityUsd: priced ? sum(SERVICE_FEEDER_COMMUNITY_SURCHARGE_KIND) : 0,
  };
}

/** THE FEE LADDER PRINTED ON THE BLANK BEING FILLED, in whole cents — only where no saved electrical
 *  fee line is on file (the caller's rule), and only up to the size the form prices flat
 *  (`autoMaxKva`: above it the form needs per-kVA math and plan review, which are never computed).
 *  The kVA is the same AC-rating basis as the bracket Qty (systemKva / feeBracket), bounds inclusive. */
function printedLadderCents(ctx: FillContext): { base: number; stateSurcharge: number } | null {
  const ladder = ctx.printedFeeLadder;
  if (!ladder || ladder.discipline !== "electrical") return null;
  // THE AC RATING ONLY — never systemKva's DC fallback. The ladder is priced in kVA (inverter
  // output); a DC-only job (15.91 kW DC, no AC on file) would otherwise be priced from the ARRAY,
  // one bracket up ($156 where the AC rating may well sit in the $94 row). No AC rating, no amount.
  const k = Number(ctx.project.systemSizeAcKw);
  if (!(k > 0) || k > ladder.autoMaxKva) return null;
  const tier = ladder.tiers.find((t) => k <= t.maxKva);
  if (!tier) return null;
  const base = Math.round(tier.feeUsd * 100);
  // "State surcharge (12% of permit fee)", to the cent.
  return { base, stateSurcharge: Math.round((base * ladder.stateSurchargePercent) / 100) };
}

/** THE SAVED ELECTRICAL FEE LINE, as the printed-ladder fallback asks "is one on file?". A line
 *  flagged `unresolvedCollector` (feeSchedules: a delegation whose collector has no schedule stored —
 *  the City of Jefferson -> Marion County row the per-job lookup writes) is NOT a saved line: nothing
 *  was evaluated. Any other line, priced or declined, is — a schedule that declined keeps its blank.
 *  The one answer for the computed fee sources and the fill's "fees came from the form" note. */
function savedElectricalLine(ctx: FillContext): FeeScheduleLine | undefined {
  const line = ctx.publishedFeeLines?.find((l) => l.discipline === "electrical");
  return line?.unresolvedCollector ? undefined : line;
}

/** MAY THE FORM'S PRINTED LADDER PRICE IT? The one answer for the fee cells and the "fees came from
 *  the form" note. Only when no saved electrical line is on file (savedElectricalLine) AND the ladder's
 *  OWN authority has no undifferentiated / combo schedule on file either (skeptic stage-forms-fee-2: a
 *  direct Marion County project with Marion's undifferentiated $134.40 schedule printed the ladder's
 *  $105.28 and said "no saved Marion County schedule is on file"). Then the cells stay blank — the E-01
 *  is never priced from an undifferentiated amount. Another authority's undifferentiated row (the
 *  city's own, on a Jefferson job) does not stop it. */
function printedLadderApplies(ctx: FillContext): boolean {
  if (!ctx.printedFeeLadder || savedElectricalLine(ctx)) return false;
  const own = String(ctx.printedFeeLadder.authority ?? "").trim().toLowerCase();
  if (!own) return true;
  return !(ctx.publishedFeeLines ?? []).some((l) => (l.discipline === "" || l.discipline === "combo") && !l.unresolvedCollector
    && String(l.authority ?? "").trim().toLowerCase() === own);
}

function printedLadderFee(name: string, ctx: FillContext): string {
  const fees = printedLadderCents(ctx);
  if (!fees) return "";
  const usd = (cents: number) => money(cents / 100);
  // The kVA row's own amount (it fills the bracket's Total through electricalTier*Total).
  if (name === "electricalBaseFee") return usd(fees.base);
  // The ladder prices the renewable row alone. A battery job's services/feeders line is not on it, so
  // no whole-application figure is written — the same rule as an unpriced services line on a saved
  // schedule (serviceFeederOnForm): a renewable-only total beside a battery understates the permit.
  if (serviceFeederOnForm(ctx, undefined).applies) return "";
  if (name === "electricalSubtotal") return usd(fees.base);
  // A known plan-review trigger adds a charge the ladder does not compute: no surcharge, no total.
  if (knownElectricalReviewRequired(ctx.snapshot)) return "";
  if (name === "electricalStateSurcharge") return usd(fees.stateSurcharge);
  if (name === "electricalTotalFee") return usd(fees.base + fees.stateSurcharge);
  // A community surcharge / another county's grand total is not on this ladder.
  return "";
}

// ---------------------------------------------------------------------------
// Prescriptive-checklist bridge: computed sources that answer an AHJ's
// prescriptive structural checklist straight from the parsed data, so a stored
// checklist PDF's Yes/No checkboxes get ticked by the same evaluator that fills
// the generated Markdown checklist. Names:
//   computed.presc<Key>Yes    -> "X" when that criterion answers Yes, else ""
//   computed.presc<Key>No     -> "X" when that criterion answers No, else ""
//   computed.presc<Key>Answer -> "Yes"/"No" as text; "" when unverified
//   computed.prescAllYes/No/Answer -> the overall screen (all rows Yes / any No)
// <Key> is a PrescriptiveCriterionKey with its first letter capitalized
// (snowLoad -> prescSnowLoadYes). An unparsed criterion answers [verify], which
// resolves to "" in every variant — no box is ticked and no text is written, so
// unverified data can never silently attest compliance on a real form.
// ---------------------------------------------------------------------------
function prescriptiveComputed(name: string, ctx: FillContext): string {
  const m = name.match(/^presc([A-Z][A-Za-z]*?)(Yes|No|Answer)$/);
  if (!m) return "";
  const key = m[1][0].toLowerCase() + m[1].slice(1);
  const variant = m[2];
  const rows = (ctx.prescriptive ??= evaluatePrescriptiveCriteria(ctx.project, ctx.prescriptiveLimits || {}));
  let answer: string;
  if (key === "all") {
    // Overall verdict: Yes only when EVERY row affirmatively passes; No as soon
    // as any row definitively fails; otherwise unverified.
    if (rows.length && rows.every((r) => r.answer === "Yes")) answer = "Yes";
    else if (rows.some((r) => r.answer === "No")) answer = "No";
    else answer = "";
  } else {
    const row = rows.find((r) => r.key === key);
    answer = row && row.answer !== "[verify]" ? row.answer : "";
  }
  if (variant === "Yes") return answer === "Yes" ? "X" : "";
  if (variant === "No") return answer === "No" ? "X" : "";
  return answer;
}

function computed(name: string, ctx: FillContext): string {
  if (name.startsWith("bcd")) {
    const m = name.match(/^bcd([A-Z][A-Za-z0-9]*?)(Yes|No)$/);
    if (!m) return "";
    const key = m[1][0].toLowerCase() + m[1].slice(1);
    return bcdChecklistAnswers(ctx.project)[key] === m[2] ? "X" : "";
  }
  if (name.startsWith("presc")) return prescriptiveComputed(name, ctx);
  // Iowa SFM PV worksheet: every value is iowaPvWorksheetValues' (parsed field, written-out
  // derivation, or "" for an operator question) — computed once per fill.
  if (name.startsWith("iaPv.")) return (ctx.iaPv ??= iowaPvWorksheetValues(ctx.project).values)[name.slice(5)] ?? "";
  switch (name) {
    case "installerRole": {
      const role = String(ctx.snapshot.installerRole ?? "").trim().toLowerCase();
      if (role) return role === "owner" || role === "contractor" ? role : "";
      return ctx.client.installerCompanyName ? "contractor" : "";
    }
    case "todaySigned": {
      const d = new Date();
      return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
    }
    case "systemKva": {
      const k = systemKva(ctx);
      return k ? String(k) : "";
    }
    case "servicesFeeders200Qty":
    case "servicesFeeders200Total": {
      const line = savedElectricalLine(ctx);
      const svc = serviceFeederOnForm(ctx, line);
      if (name === "servicesFeeders200Qty") return svc.applies ? "1" : "";
      return svc.priced ? money(svc.baseUsd) : "";
    }
    // electricalBaseFee is the RENEWABLE (kVA) line's own amount — it fills the
    // kVA row and the renewable-table subtotal, and older stored maps also put it
    // on the application subtotal. electricalSubtotal is the WHOLE application's
    // subtotal ("add ALL fees"), which on a battery job includes the services line.
    case "electricalBaseFee":
    case "electricalSubtotal":
    case "electricalStateSurcharge":
    case "electricalCommunitySurcharge":
    case "coosElectricalTotal":
    case "electricalTotalFee": {
      // No saved electrical line (none at all, or a delegation to a collector with no schedule on
      // file — savedElectricalLine): the ladder printed on this blank, where it has one. A saved
      // line that declines to price (feeUsd null, with its reason) is never overruled by the form.
      const line = savedElectricalLine(ctx);
      if (!line) return printedLadderApplies(ctx) ? printedLadderFee(name, ctx) : "";
      if (line.feeUsd == null) return "";
      if (name === "electricalBaseFee") return line.baseFeeUsd == null ? "" : money(line.baseFeeUsd);
      const svc = serviceFeederOnForm(ctx, line);
      if (svc.applies && !svc.priced) return "";
      if (name === "electricalSubtotal") return line.baseFeeUsd == null ? "" : money(line.baseFeeUsd + svc.baseUsd);
      if (name === "electricalStateSurcharge") return line.stateSurchargeUsd == null ? "" : money(line.stateSurchargeUsd + svc.stateUsd);
      if (name === "electricalCommunitySurcharge") return line.communitySurchargeUsd == null ? "" : money(line.communitySurchargeUsd + svc.communityUsd);
      if (name === "coosElectricalTotal" && line.communitySurchargeUsd == null) return "";
      // Do not represent a base-only lookup as the application's grand total.
      // Review-triggering work requires an actual review charge first.
      if (line.stateSurchargeUsd == null || systemKva(ctx) > 25 || knownElectricalReviewRequired(ctx.snapshot)) return "";
      return money(line.feeUsd + svc.baseUsd + svc.stateUsd + svc.communityUsd);
    }
    case "electricalTier5Qty": case "electricalTier15Qty": case "electricalTier25Qty":
    case "electricalTier5Total": case "electricalTier15Total": case "electricalTier25Total": {
      const tier = name.includes('Tier15') ? '5to15' : name.includes('Tier25') ? '15to25' : 'le5';
      const base = computed('electricalBaseFee', ctx);
      return base && feeBracket(ctx) === tier ? name.endsWith('Qty') ? '1' : base : '';
    }
    case "singleFamilyCategory":
      return /^single[- ]family(?: dwelling)?$/i.test(str(ctx.snapshot.constructionCategory).trim()) ? "yes" : "";
    case "constructionCategory": {
      const v = str(ctx.snapshot.constructionCategory || ctx.snapshot.occupancyType).trim();
      if (/^other$/i.test(v)) return str(ctx.snapshot.constructionCategoryOther).trim() ? "other" : "";
      return /^(?:single[- ]family(?: dwelling)?|1[- ]and[- ]2[- ]family|one[- ]and[- ]two[- ]family|R-?3)$/i.test(v) ? "residential" : "";
    }
    case "declaredValuation":
    case "estimatedJobValue": {
      // EVERY valuation field on EVERY AHJ form carries the OPERATOR'S VALUATION
      // FORMULA (40% of contract + battery adders) — the same authority the fee
      // engine uses (valuation.ts, whose own note says the application carries the
      // formula OF the contract, never the contract itself). declaredValuation used
      // to return the raw contract, quietly contradicting that rule on the curated
      // Oregon building maps; operator ruling 2026-09-21 made the formula the
      // default for all AHJs, so both names now answer identically.
      const v = resolveValuation(ctx.snapshot, Number(ctx.project.systemSizeDcKw) || null);
      return v.value != null && v.value > 0 ? String(Math.round(v.value)) : "";
    }
    case "feeBracket":
      return feeBracket(ctx);
    case "renewableFee": {
      const f = renewableFee(ctx);
      return f ? money(f) : "";
    }
    case "renewableFeeQty":
      return systemKva(ctx) > 0 ? "1" : "";
    case "planReview": {
      // Plan review (25%) only required for systems over 25 kVA.
      if (feeBracket(ctx) !== "over25") return "";
      return money(renewableFee(ctx) * 0.25);
    }
    case "stateSurcharge": {
      const f = renewableFee(ctx);
      return f ? money(f * 0.12) : "";
    }
    case "totalPermitFee": {
      const f = renewableFee(ctx);
      if (!f) return "";
      const plan = feeBracket(ctx) === "over25" ? f * 0.25 : 0;
      return money(f + plan + f * 0.12);
    }
    case "fullAddress": {
      // projectAddress often ALREADY carries city/state/zip; joining blindly printed
      // "1095 Michigan Ave, Coos Bay, OR, 97420, Coos Bay, OR, 97420" on the live
      // Simmons building application. Build on streetAddress, which strips them.
      const street = computed("streetAddress", ctx) || str(ctx.project.projectAddress);
      return [street, ctx.project.city, ctx.project.state, ctx.project.zip]
        .filter(Boolean)
        .join(", ");
    }
    case "systemSize":
      return `${ctx.project.systemSizeDcKw ?? "?"} kW DC / ${ctx.project.systemSizeAcKw ?? "?"} kW AC`;
    case "systemSizeDcKw":
      return str(ctx.project.systemSizeDcKw);
    case "cityStateZip":
      return [ctx.project.city, ctx.project.state].filter(Boolean).join(", ") + (ctx.project.zip ? ` ${ctx.project.zip}` : "");
    case "streetAddress": {
      // The project address often already includes city/state/zip; strip those
      // so the street line + the separate City/State/ZIP line don't duplicate.
      const full = str(ctx.project.projectAddress);
      if (!full) return "";
      const city = str(ctx.project.city).toLowerCase();
      const state = str(ctx.project.state).toLowerCase();
      const zip = str(ctx.project.zip).toLowerCase();
      const drop = new Set([city, state, zip, `${state} ${zip}`.trim(), `${city} ${state} ${zip}`.trim()].filter(Boolean));
      const kept = full
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p && !drop.has(p.toLowerCase()));
      return kept.join(", ");
    }
    case "applicantSignerName":
      // The typed name on the applicant's stored signature, for the "Print name"
      // line under the authorized signature.
      return ctx.signatures?.applicant?.name ?? "";
    case "electricianSignerName":
      // Typed name on the stored electrician signature; falls back to the
      // supervisor name from the client profile when no sig image is stored.
      return ctx.signatures?.electrician?.name ?? ctx.client.electricalSupervisorName ?? "";
    case "descriptionOfWork": {
      const s = ctx.snapshot;
      const qty = str(s["moduleQuantity"] ?? s["module_quantity"]);
      const model = str(s["moduleModel"] ?? s["module_model"]);
      const size = ctx.project.systemSizeDcKw ? `${ctx.project.systemSizeDcKw} kW DC` : "";
      const battery = str(s["batteryModel"] ?? s["battery_model"]);
      // System addition: an existing PV system stays in service — the scope is
      // the NEW equipment, but the AHJ/utility must see it's an addition.
      // Both flags demand an explicit "yes" — existingSystem:"no" must not read
      // as an addition just because the string is truthy.
      const isAddition = /^yes$/i.test(str(s["hasExistingSystem"])) || /^yes$/i.test(str(s["existingSystem"]));
      const existingDc = str(s["existingDcKw"]);
      const combinedDc = str(s["combinedDcKw"]);
      const additionTail = isAddition
        ? ` Addition to existing${existingDc ? ` ${existingDc} kW DC` : ""} PV system${combinedDc ? ` (combined ${combinedDc} kW DC)` : ""}.`
        : "";
      // THE ONE MOUNT PREDICATE (codeReviewRules.mountKindForProject): this hard-coded "roof-mounted"
      // for every job, so a ground-mount form said roof-mounted beside its own roofMounted = "no".
      // Unknown mount: no adjective (leak sweep 2026-09-28).
      const mountWord = mountAdjective(mountKindForProject({ ...ctx.project, parserSnapshot: s } as ProjectRecord)).toLowerCase();
      const system = `photovoltaic solar system${isAddition ? " addition" : ""}`;
      return [
        mountWord ? `Install ${mountWord} ${system}` : `Install ${system}`,
        qty && model ? `: ${qty}x ${model}` : "",
        size ? `, ${size}` : "",
        battery ? `, with ${battery} battery storage` : "",
        ".",
        additionTail,
      ].join("");
    }
    case "installerBlock":
      return [ctx.client.installerCompanyName, ctx.client.ccbLicenseNumber ? `CCB ${ctx.client.ccbLicenseNumber}` : ""]
        .filter(Boolean)
        .join(" — ");
    // THE BUILDING DEPARTMENT THAT REVIEWS THIS PERMIT: the agency the per-job lookup cites as the
    // structural permit's issuer when that is not the AHJ (Marion County for a City of Jefferson
    // job), else the AHJ. BCD 5952's "Building department:" line printed "City of Jefferson" on a
    // checklist Marion County reviews (applicationDocsAgency.formAuthorityFor — the one predicate).
    case "buildingDepartment":
      return formAuthorityFor(ctx.project, "building_application").name || str(ctx.project.ahj);
    // A 10-digit US number reads as one on a form: "(458) 329-4881", never "4583294881" beside a
    // contractor phone the client record already formats. Anything else is left as written.
    case "homeownerPhone":
      return formatUsPhone(str(ctx.snapshot.homeownerPhone));
    case "homeownerMailingCity":
    case "homeownerMailingState":
    case "homeownerMailingZip": {
      const m = /^\s*(.+?),?\s+([A-Za-z]{2})\.?,?\s+(\d{5}(?:-\d{4})?)\s*$/.exec(str(ctx.snapshot.homeownerMailingCityStateZip));
      if (!m) return "";
      return name === "homeownerMailingCity" ? m[1].replace(/,\s*$/, "").trim() : name === "homeownerMailingState" ? m[2].toUpperCase() : m[3];
    }
    // Roof-mounted? From the parsed mounting text; blank when it says neither.
    case "roofMounted": {
      const m = str(ctx.snapshot.mounting).toLowerCase();
      if (/ground|pole|carport|canopy/.test(m)) return "no";
      return /roof/.test(m) ? "yes" : "";
    }
    // A county prescriptive application's structure row ("a single family dwelling … or accessory
    // building to a single-family dwelling"): yes only for those structure meanings; any other
    // structure depends on floor area / height the plan set does not state — blank.
    // (Not named presc*: that prefix belongs to the criterion bridge above and would swallow it.)
    case "structureSfdOrAccessory": {
      const meaning = structureMeaningOf(ctx.snapshot);
      return meaning === "single_family" || meaning === "accessory" ? "yes" : "";
    }
    // EVERY ROW THE STATE CHECKLIST PRINTS ANSWERS YES — the four independent rows at the form's
    // printed limits and the five compound rows (bcdChecklistFacts, including the height row
    // assumed Yes per the operator ruling of 2026-09-27). A county application's prescriptive
    // attestation ("verify that the installation will meet OSSC 3111.4.8 and 3111.5") answers the
    // same question, so it reads the same answers — never a second, stricter evaluator that leaves
    // the attestation blank beside a checklist that says Yes to every row.
    case "checklistAllYes": {
      const rows = evaluatePrescriptiveCriteria(ctx.project, { ...(ctx.prescriptiveLimits || {}), ...BCD_5952_LIMITS });
      const independent = ["snowLoad", "windExposure", "lightFrame", "deadLoad"].every((k) => rows.find((r) => r.key === k)?.answer === "Yes");
      // The five printed rows only — truss/rafter and method 1/2 are "check one" sub-choices.
      const answers = bcdChecklistAnswers(ctx.project);
      const compound = ["designInstallation", "framing", "roofing", "heightFigures", "attachments"].every((k) => answers[k] === "Yes");
      return independent && compound ? "yes" : "";
    }
    // Residential category of construction: a stated residential construction category, or a
    // structure description that means a dwelling (permitProcess.structureTypeMeaning).
    case "residentialCategory": {
      if (computed("constructionCategory", ctx) === "residential") return "residential";
      const meaning = structureMeaningOf(ctx.snapshot);
      return meaning === "single_family" || meaning === "two_family" || meaning === "townhouse" || meaning === "manufactured" ? "residential" : "";
    }
    // "1" on the renewable-energy row the system's kVA falls in — a fact of the system, whether or
    // not a fee schedule is on file (the Total beside it is the fee line's, blank without one).
    case "kvaTier5Qty": case "kvaTier15Qty": case "kvaTier25Qty": {
      const tier = name === "kvaTier15Qty" ? "5to15" : name === "kvaTier25Qty" ? "15to25" : "le5";
      return feeBracket(ctx) === tier ? "1" : "";
    }
    // A one-line description box holds ~60 characters at 9 pt; a form with two rows gets the
    // description wrapped across them on a word boundary instead of clipped at the box edge.
    case "descriptionOfWorkLine1":
    case "descriptionOfWorkLine2": {
      const [l1, l2] = wrapTwoLines(computed("descriptionOfWork", ctx), 62);
      return name === "descriptionOfWorkLine1" ? l1 : l2;
    }
    default:
      return "";
  }
}

export function resolveSource(source: FieldSource, ctx: FillContext): string {
  if (!source) return "";
  if (source.startsWith("lit:")) return source.slice(4);
  const [scope, ...rest] = source.split(".");
  const key = rest.join(".");
  switch (scope) {
    case "project":
      return str((ctx.project as unknown as Record<string, unknown>)[key]);
    case "client":
      return str(ctx.client[key]);
    case "snapshot":
      return str(ctx.snapshot[key]);
    case "computed":
      return computed(key, ctx);
    default:
      return "";
  }
}

export function buildContext(db: AppDb, project: ProjectRecord): FillContext {
  // Reuse the same client overlay the portal adapters get, so PDF and portal
  // stay consistent. portalType "" yields licensing fields without a specific
  // installer identity.
  const client = clientStagingOverlay(db, project.clientId, "");
  // Per-AHJ prescriptive limits (same jurisdiction code profile QC screens on),
  // so the presc* checkbox sources answer against this AHJ's actual thresholds.
  // Only concrete values override; anything missing keeps the Oregon defaults.
  const prescriptiveLimits: PrescriptiveLimitInputs = {};
  try {
    const p = resolveEffectiveCodeContext(db, project.state, project.ahj).prescriptive || {};
    if (p.maxGroundSnowPsf != null) prescriptiveLimits.maxGroundSnowPsf = p.maxGroundSnowPsf;
    if (p.maxPvDeadLoadPsf != null) prescriptiveLimits.maxPvDeadLoadPsf = p.maxPvDeadLoadPsf;
    if (p.maxRafterSpacingIn != null) prescriptiveLimits.maxRafterSpacingIn = p.maxRafterSpacingIn;
    if (p.allowedWindExposures?.length) prescriptiveLimits.allowedWindExposures = p.allowedWindExposures;
  } catch { /* profile data optional — Oregon defaults apply */ }
  // The jurisdiction's own published electrical brackets, if anybody has researched them. Read
  // through the SAME discipline-aware lookup the fee sheet and the invoice use, so the PDF and
  // the quote cannot disagree. Absent is the ordinary case and costs nothing: renewableFee then
  // falls back to the ladder printed on the form.
  // STATICALLY IMPORTED, not require()d. This is the second time today the same mistake was
  // made in this repo: require() does not exist in an ESM module, the surrounding catch
  // swallows the ReferenceError, and the feature silently does nothing — here that meant the
  // printed ladder kept winning and the test that proves the fix went red. feeSchedules does
  // not import this file, so there is no cycle to dodge.
  let publishedElectricalBrackets: FillContext["publishedElectricalBrackets"];
  try {
    const sched = findFeeScheduleForProject(db, project, "permit", "electrical" as never);
    // Only a SIZE-bracketed schedule can answer this box. A flat or valuation-keyed one is a
    // different question, and silently substituting it would be worse than the printed ladder.
    if (sched && sched.basis === "system_kw" && Array.isArray(sched.brackets) && sched.brackets.length) {
      publishedElectricalBrackets = sched.brackets;
    }
  } catch { /* no schedule module or unreadable row — the printed ladder stands */ }
  const ctx: FillContext = {
    project,
    client,
    publishedElectricalBrackets,
    publishedFeeLines: feeForProject(db, project, "permit")?.lines,
    // Parsed/operator values win; beneath them, BCD 5952 facts another record already answers
    // (BCD license # from the client's electrical contractor licence, the module's listing
    // agency from its datasheet text) — bcdChecklistFacts.bcd5952SnapshotAdditions.
    snapshot: {
      ...bcd5952SnapshotAdditions(project, client as Record<string, unknown>, { moduleSpec: moduleSpecText(db, project.id) }),
      ...((project.parserSnapshot ?? {}) as Record<string, unknown>),
    } as Record<string, unknown>,
    // The signature stamped on a permit form comes from the org that OWNS the
    // project — this runs from background jobs with no request, so it can't be
    // taken from a session.
    signatures: loadDefaultSignaturesByRole(db, projectOrgId(db, project.id)),
    prescriptiveLimits,
  };
  // THE OWNER'S MAILING ADDRESS IS THE INSTALLATION ADDRESS unless the project records another
  // (operator ruling 2026-09-27, Michael Sheridan's Marion B-01S / E-01: "this will just be the
  // install address"). Only when NO mailing address is on file — a parsed or entered one (even a
  // partial one) is never mixed with the site's.
  if (!str(ctx.snapshot.homeownerMailingAddress) && !str(ctx.snapshot.homeownerMailingCityStateZip)) {
    const street = computed("streetAddress", ctx);
    const cityStateZip = computed("cityStateZip", ctx);
    if (street && str(ctx.project.city) && str(ctx.project.zip)) {
      ctx.snapshot.homeownerMailingAddress = street;
      ctx.snapshot.homeownerMailingCityStateZip = cityStateZip;
    }
  }
  return ctx;
}

/** The module datasheet's extracted text (the listing agency is read from it — never from the
 *  plan set, whose "UL CERTIFICATION" sheets belong to other equipment). */
function moduleSpecText(db: AppDb, projectId: string): string {
  try {
    return String(db.get<{ t?: string }>(
      "SELECT extracted_text AS t FROM project_documents WHERE project_id = ? AND doc_type = 'module_spec' ORDER BY uploaded_at DESC LIMIT 1",
      [projectId],
    )?.t ?? "");
  } catch { return ""; }
}

/** The org that owns a project, for background work that has no request context. */
function projectOrgId(db: AppDb, projectId: string): string {
  const row = db.get<{ org_id?: string }>("SELECT org_id FROM projects WHERE id = ?", [projectId]);
  return String(row?.org_id || DEFAULT_ORG_ID);
}

// Stamp the operator's stored signature image(s) onto the form at the detected
// signature placements. Each role uses its default signature; an unmatched role
// falls back to the applicant signature. Returns how many were drawn.
/** How far above its anchor a signature is lifted so it rests ON the rule, not under it. */
const SIGNATURE_LIFT = 6;

/**
 * Crop a signature image to its ink, so the placement box is spent on signature rather than
 * on the blank border around it. Best-effort: any failure returns the original bytes, since
 * a form with a slightly small signature beats a form with none.
 */
async function trimSignatureMargins(bytes: Uint8Array, mime: string): Promise<{ bytes: Uint8Array; mime: string }> {
  try {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(Buffer.from(bytes));
    const w = img.width, h = img.height;
    if (!w || !h || w * h > 8_000_000) return { bytes, mime };
    const probe = createCanvas(w, h);
    const pctx = probe.getContext("2d");
    pctx.drawImage(img, 0, 0);
    const data = pctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // Ink is opaque AND dark. Alpha alone would keep a white-filled background;
        // darkness alone would keep a transparent-but-dark antialias halo.
        if (data[i + 3] <= 24 || (data[i] + data[i + 1] + data[i + 2]) / 3 >= 200) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0 || maxY < 0) return { bytes, mime };           // no ink found — leave it alone
    const pad = 2;                                               // keep a hair of breathing room
    const sx = Math.max(0, minX - pad), sy = Math.max(0, minY - pad);
    const sw = Math.min(w - sx, maxX - minX + 1 + pad * 2);
    const sh = Math.min(h - sy, maxY - minY + 1 + pad * 2);
    if (sw <= 0 || sh <= 0 || (sw === w && sh === h)) return { bytes, mime };
    const out = createCanvas(sw, sh);
    out.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    // Always PNG out: the crop preserves transparency, which a JPEG round-trip would fill.
    return { bytes: new Uint8Array(out.toBuffer("image/png")), mime: "image/png" };
  } catch {
    return { bytes, mime };
  }
}

async function drawSignatures(doc: PDFDocument, def: AhjFormDefinition, ctx: FillContext): Promise<number> {
  const placements = def.signatureFields ?? [];
  const sigs = ctx.signatures ?? {};
  if (!placements.length || !Object.keys(sigs).length) return 0;
  const pages = doc.getPages();
  let dateFont;
  let drawn = 0;
  for (const pl of placements) {
    // Never auto-stamp the property-owner signature line — the homeowner must
    // sign that in person. Only fall back to the applicant signature for other
    // operator-signable roles.
    if (pl.role === "owner") continue;
    // ONE PERSON'S SIGNATURE IS NEVER ANOTHER PERSON'S.
    // This used to fall back to the applicant's image for any unmatched role, which on the
    // Portland electrical form would draw the applicant's signature on the line reading
    // "Supervising electrician / Signature, required:" — directly above that electrician's
    // printed name and licence number. That is a misattributed signature on a filed permit
    // application, which is a different kind of wrong from a blank line. A missing signature
    // leaves the line empty for a human to sign, which is the correct outcome.
    const sig = sigs[pl.role];
    if (!sig) continue;
    const page = pages[pl.page];
    if (!page) continue;
    // A bad vision detection can return NaN/Infinity coords; pdf-lib throws on
    // those. Skip such placements rather than let them abort the whole fill.
    if (!Number.isFinite(pl.x) || !Number.isFinite(pl.y)) continue;
    let img;
    try {
      // TRIM THE EMPTY MARGIN FIRST. A captured signature PNG is mostly blank canvas — the
      // operator's stored images measured 57% and 68% empty. Scaling the whole canvas into
      // a short row makes the ink shrink to a smudge: at 12pt tall an 820x200 image drew
      // 49pt wide, a third of its 150pt box, because the transparent border ate the budget.
      // Cropping to the ink first yields ~45% more visible signature at the SAME row height
      // (49pt -> 70pt), which is the whole difference between a signature and a mark.
      const cropped = await trimSignatureMargins(sig.bytes, sig.mime);
      img = cropped.mime.includes("jpeg") ? await doc.embedJpg(cropped.bytes) : await doc.embedPng(cropped.bytes);
    } catch {
      continue;
    }
    // Fit within the placement box, preserving aspect ratio.
    const boxW = Number.isFinite(pl.width) && pl.width > 0 ? pl.width : 130;
    const boxH = Number.isFinite(pl.height) && pl.height > 0 ? pl.height : 34;

    // HEIGHT IS THE ROW'S BUDGET, NOT THE INK'S. The lift used to be added ON TOP of a
    // full-height image, so a 12pt placement actually reached 18pt and crossed the line
    // above it. Measured on the Portland electrical form, whose rules sit 9pt apart at the
    // supervising-electrician row: the signature landed on the label instead of the rule.
    // Everything now fits inside boxH — the lift is taken OUT of the budget, so a
    // placement's height is the space it really occupies.
    const lift = Math.min(SIGNATURE_LIFT, Math.max(0, boxH * 0.25));
    const inkBudgetH = Math.max(1, boxH - lift);
    const scale = Math.min(boxW / img.width, inkBudgetH / img.height) || 1;
    page.drawImage(img, { x: pl.x, y: pl.y + lift, width: img.width * scale, height: img.height * scale });
    drawn += 1;
    // The operator signs today — write today's date on the adjacent date line.
    if (pl.dateX != null && pl.dateY != null && Number.isFinite(pl.dateX) && Number.isFinite(pl.dateY)) {
      if (!dateFont) dateFont = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText(computed("todaySigned", ctx), { x: pl.dateX, y: pl.dateY, size: pl.dateSize ?? 9, font: dateFont, color: rgb(0, 0, 0) });
    }
  }
  return drawn;
}

export function matchingForms(ahj: string): AhjFormDefinition[] {
  const needle = (ahj || "").toLowerCase();
  if (!needle) return [];
  return ahjFormRegistry.filter((def) => def.matchJurisdictions.some((m) => needle.includes(m)));
}

// SSRF guard: an AHJ form URL comes from operator input (/api/ahj-forms/inspect), so a
// server-side fetch of it must never reach internal/cloud-metadata hosts. Reject anything
// that isn't a public http(s) address. Returns the validated URL; throws HttpError(400) on
// a private/loopback/link-local/metadata/multicast target or a non-http scheme.
function ipIsPrivate(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const o = ip.split(".").map(Number);
    if (o[0] === 10 || o[0] === 127 || o[0] === 0) return true;
    if (o[0] === 169 && o[1] === 254) return true;            // link-local + cloud metadata
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
    if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true;
    if (o[0] >= 224) return true;                              // multicast / reserved
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);        // IPv4-mapped
    if (mapped) return ipIsPrivate(mapped[1]);
    return false;
  }
  return true; // not a valid IP literal → treat as unsafe
}

async function assertPublicHttpUrl(raw: string): Promise<void> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, `Invalid URL: ${raw}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new HttpError(400, `Only http(s) URLs may be fetched (got ${u.protocol}).`);
  }
  const host = u.hostname;
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some((a) => ipIsPrivate(a))) {
    throw new HttpError(400, `Refusing to fetch an internal/private address (${host}).`);
  }
}

// Fetch following redirects MANUALLY, re-validating each hop against the SSRF guard so a
// public URL can't 30x-redirect into an internal host.
async function safeFetchTemplate(rawUrl: string): Promise<Response> {
  let url = rawUrl;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicHttpUrl(url);
    const res = await fetch(url, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      url = new URL(loc, url).toString();
      continue;
    }
    return res;
  }
  throw new HttpError(502, "Too many redirects fetching the form template.");
}

// Downloads and caches a form template; falls back to the cached copy when the
// network fetch fails (link rot is common on AHJ sites).
export async function fetchFormTemplate(def: AhjFormDefinition): Promise<Uint8Array> {
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
  const cachePath = path.join(TEMPLATE_DIR, `${def.id}.pdf`);

  // DOCUMENT_FETCH=off: an offline install fills from the cached blank ONLY. This check has
  // to come before safeFetchTemplate, not inside its try: the SSRF guard resolves the host
  // (dns.lookup) before any fetch, so "the download failed and we fell back to cache" was
  // still an outbound lookup of www.portland.gov every time Portland's forms were filled —
  // while the kit's .env promised nothing outbound. Same predicate fetchPublicDocument asks.
  if (documentFetchDisabled()) {
    if (fs.existsSync(cachePath)) return new Uint8Array(fs.readFileSync(cachePath));
    throw new HttpError(
      502,
      `Form "${def.formName}" has no cached blank on this installation, and document downloads are off (DOCUMENT_FETCH=off), so it was not fetched from ${def.sourceUrl}.`,
    );
  }

  try {
    const res = await safeFetchTemplate(def.sourceUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "";
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!type.includes("pdf") && buf[0] !== 0x25 /* % */) {
      throw new Error(`Not a PDF (content-type ${type})`);
    }
    fs.writeFileSync(cachePath, buf);
    return buf;
  } catch (err) {
    if (fs.existsSync(cachePath)) {
      return new Uint8Array(fs.readFileSync(cachePath));
    }
    throw new HttpError(
      502,
      `Could not fetch form "${def.formName}" from ${def.sourceUrl} and no cached copy exists: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface InspectedField {
  name: string;
  type: string;
}

export async function inspectFormFields(pdfBytes: Uint8Array): Promise<{ isXfa: boolean; fields: InspectedField[] }> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const fields = form.getFields().map((f) => ({ name: f.getName(), type: f.constructor.name }));
  // No terminal AcroForm fields => likely XFA-only or a flat/scanned PDF that
  // pdf-lib cannot fill programmatically.
  const isXfa = fields.length === 0;
  return { isXfa, fields };
}

/**
 * WHOSE IS A REQUIRED FIELD THE FILL LEFT BLANK (gates-proper C4) — the one answer the fill result and
 * the "application field(s) still blank" card read. By the field's SOURCE key first (a label is prose):
 *   - "agency": a fee, surcharge, subtotal or total the form could not price (computed.*Fee /
 *     *Surcharge / *Subtotal / *Total) — the issuing agency computes it from its own schedule (Marion
 *     County in its portal; Coos County at intake). Not the operator's data, never a reason to wait.
 *   - "planning_office": a land-use approval number / date — issued by the planning office, and only
 *     where the project needed one.
 *   - "operator": everything else — project data the operator can add, or complete on the form.
 */
export type RequiredFieldOwner = "agency" | "planning_office" | "operator";
export function requiredFieldOwner(label: string, source: string): RequiredFieldOwner {
  const src = String(source ?? "");
  if (/^computed\.[A-Za-z]*(Fee|Surcharge|Subtotal|Total)$/.test(src)) return "agency";
  if (/^snapshot\.landUse/i.test(src) || /land[-\s]?use approval/i.test(String(label ?? ""))) return "planning_office";
  return "operator";
}

export interface FilledFormResult {
  formId: string;
  formName: string;
  status: "filled" | "needs_manual" | "error" | "skipped";
  outputPath?: string;
  filledFieldCount?: number;
  unmappedRequested?: string[];
  /** For a blank in unmappedRequested that is NOT the operator's data: whose it is (requiredFieldOwner). */
  requestedFieldOwners?: Record<string, RequiredFieldOwner>;
  message?: string;
  /** Whether this form's mapping is human-verified. Registry forms are inherently
   *  verified; stored auto/uploaded forms start false until the operator confirms. */
  verified?: boolean;
  /** ahj_form_templates row id (stored forms only), for the verify action. */
  templateId?: string;
  /** True when signature placements are hand-tuned on the registry def, so the
   *  "Detect signature lines" affordance is irrelevant and hidden in the UI. */
  signaturesLocked?: boolean;
  /** What the blank says about ITSELF ("Revised 12/23/2022"), "" when it does
   *  not say. Stored forms only — registry forms are version-pinned in code. */
  documentDate?: string;
  /** The document dates itself more than two years back. Worth re-checking
   *  against the AHJ's current forms page BEFORE this one is filed. */
  documentStale?: boolean;
  /** Where the blank was downloaded from, so the operator can re-check it. */
  sourceUrl?: string;
}

export async function fillForm(
  def: AhjFormDefinition,
  ctx: FillContext,
  outputPath: string,
): Promise<FilledFormResult> {
  let templateBytes: Uint8Array;
  try {
    templateBytes = await fetchFormTemplate(def);
  } catch (err) {
    return { formId: def.id, formName: def.formName, status: "error", message: err instanceof Error ? err.message : String(err) };
  }
  return fillLoadedForm(def, templateBytes, ctx, outputPath);
}

// Fill from in-memory template bytes (e.g. a stored/uploaded blank PDF) — same
// logic as fillForm but without the network fetch.
export async function fillLoadedForm(
  def: AhjFormDefinition,
  templateBytes: Uint8Array,
  ctx: FillContext,
  outputPath: string,
): Promise<FilledFormResult> {
  // THE BLANK'S OWN PRINTED FEE LADDER, by its exact bytes (curatedAhjForms.curatedPrintedFees) — so
  // a row stored before the ladder existed reads it too. Per form: a copy of the context, never the
  // caller's shared one, and a blank without a ladder never inherits another form's.
  const printedFeeLadder = curatedPrintedFees(templateBytes);
  if (printedFeeLadder || ctx.printedFeeLadder) ctx = { ...ctx, printedFeeLadder };
  const doc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
  let checklist: ChecklistRecovery = { recognized: false, overlays: [], omittedTextFields: [], textFieldOverrides: {} };
  let checklistCtx = ctx;
  if (def.recoverPrescriptiveCheckboxes === true) {
    const [{ extractLabels }, { recoverBcd5952Checklist, BCD_5952_LIMITS }] = await Promise.all([
      import("./formTextLayer"), import("./prescriptiveChecklist"),
    ]);
    checklist = recoverBcd5952Checklist(doc, await extractLabels(templateBytes), def.overlayFields,
      def.textFields, Object.values(def.checkboxes ?? {}).map((r) => r.source));
    // A checklist's printed thresholds control its answers, even when a cached
    // project evaluation used different jurisdiction limits. Do not mutate ctx.
    checklistCtx = { ...ctx, prescriptive: undefined,
      prescriptiveLimits: { ...ctx.prescriptiveLimits, ...BCD_5952_LIMITS } };
  }
  const drawChecklist = async (): Promise<number> => {
    if (!checklist.overlays.length) return 0;
    const font = await doc.embedFont(StandardFonts.Helvetica);
    let drawn = 0;
    for (const field of checklist.overlays) {
      const text = resolveSource(field.source, checklistCtx);
      const page = doc.getPages()[field.page];
      if (!text || !page) continue;
      page.drawText(text, { x: field.x, y: field.y, size: field.size ?? 9, font, color: rgb(0, 0, 0) });
      drawn++;
    }
    return drawn;
  };
  // NAME THE MISSING FACT, NOT THE ROW: "roof material and layer count" on a project whose roof
  // material was parsed read as "it filled metal roofing" (bcdChecklistFacts.bcd5952MissingFacts).
  const unresolvedChecklistRows = checklist.recognized ? bcd5952MissingFacts(ctx.project).map((m) => m.missing) : [];
  const checklistMessage = checklist.recognized
    ? "BCD 5952: filled independently supported answers. Review the completed PDF before filing."
      + (unresolvedChecklistRows.length ? ` Still needs evidence: ${unresolvedChecklistRows.join("; ")}.` : "")
    : undefined;
  // The cached research title can claim several applications were combined,
  // while the actual two-page PDF is only this checklist.
  const resultFormName = checklist.recognized
    ? "Oregon BCD 5952 - Prescriptive Solar PV Installation Checklist"
    : def.formName;
  const missingRequiredEntries = Object.entries(def.requiredFields ?? {}).filter(([, source]) => !resolveSource(source, ctx).trim());
  const missingRequired = missingRequiredEntries.map(([label]) => label);
  // WHO SUPPLIES EACH BLANK (gates-proper C4 — requiredFieldOwner, the one answer). A fee, a
  // surcharge or a grand total the form could not price is the AGENCY's to compute (Marion County
  // prices the E-01 in its own portal); a land-use approval comes from the planning office. Neither is
  // "resolve in QC / Human Review". The labels stay in unmappedRequested (the blank is still SAID);
  // requestedFieldOwners tells the screen whose it is.
  const requestedFieldOwners: Record<string, RequiredFieldOwner> = {};
  for (const [label, source] of missingRequiredEntries) {
    const owner = requiredFieldOwner(label, source);
    if (owner !== "operator") requestedFieldOwners[label] = owner;
  }
  const operatorMissing = missingRequired.filter((l) => !requestedFieldOwners[l]);
  const agencyMissing = missingRequired.filter((l) => requestedFieldOwners[l] === "agency");
  const officeMissing = missingRequired.filter((l) => requestedFieldOwners[l] === "planning_office");
  // Say where the fees came from whenever the printed ladder priced this form (no saved line on file —
  // the same savedElectricalLine answer the fee cells used).
  const printedFeeNote = ctx.printedFeeLadder && printedLadderApplies(ctx)
    && resolveSource("computed.electricalBaseFee", ctx) ? ctx.printedFeeLadder.note : "";
  // ONE STORY ABOUT THE FEES. The curated maps' generic note ("Fee entries use the current saved
  // jurisdiction lookup; printed rates may be historical.") contradicts the printed-ladder note, so
  // when the ladder priced the form that exact sentence is dropped — at fill time, because a row
  // stored before the ladder existed (Michael's E-01) carries it in its stored map. Exact literal.
  const notes = printedFeeNote
    ? (def.notes ?? []).map((n) => n.split(CURATED_SAVED_FEE_NOTE).map((s) => s.trim()).filter(Boolean).join(" "))
    : (def.notes ?? []);
  const completionMessage = [checklistMessage, operatorMissing.length ? `Still needs: ${operatorMissing.join("; ")}.` : "",
    officeMissing.length ? `From the planning / land-use office (when it applies): ${officeMissing.join("; ")}.` : "",
    agencyMissing.length ? `Left for the agency to compute: ${agencyMissing.join("; ")}.` : "",
    printedFeeNote, ...notes].filter(Boolean).join(" ") || undefined;

  // Both flat and AcroForm templates can have additional fields without widgets.
  const drawMappedOverlays = async (): Promise<number> => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    let drawn = 0;
    // Label anchoring: when overlay fields carry a `label` (vision-mapped stored
    // forms do; hand-tuned registry defs do NOT), snap each value to that label's
    // real text-layer baseline instead of the LLM's estimated x/y — fixing the
    // "off a bit" drift. Falls back to x/y for unlabeled fields / no text layer /
    // label-not-found, so nothing regresses. Text layer is read at most once.
    let anchorFor: ((f: OverlayField) => { x: number; y: number } | null) | null = null;
    if ((def.overlayFields ?? []).some((f) => f.label && f.label.trim())) {
      try {
        const { extractLabels, hasTextLayer, anchorPlacement, sideForLabel } = await import("./formTextLayer");
        const items = await extractLabels(templateBytes);
        if (hasTextLayer(items)) {
          anchorFor = (f) => (f.label && f.label.trim())
            ? anchorPlacement(items, { page: f.page, label: f.label, side: sideForLabel(f.label), size: f.size ?? 9 })
            : null;
        }
      } catch { /* keep anchorFor null → use stored x/y */ }
    }
    for (const [index, field] of (def.overlayFields ?? []).entries()) {
      const page = pages[field.page];
      if (!page) continue;
      if (field.onlyIf) {
        const cond = resolveSource(field.onlyIf.source, ctx);
        if (!checkboxRuleChecked({ source: field.onlyIf.source, equals: field.onlyIf.equals }, cond)) continue;
      }
      // A recognized checklist may repair a stored placement's SOURCE (never its map).
      let text = resolveSource(checklist.overlaySourceOverrides?.[index] ?? field.source, ctx);
      if (!text) continue;
      const size = field.size ?? 9;
      if (field.maxWidth) {
        while (text.length > 1 && font.widthOfTextAtSize(text, size) > field.maxWidth) {
          text = text.slice(0, -1);
        }
      }
      // Prefer the label-anchored baseline; else the stored x/y. Calibration:
      // vision-derived baselines drift a few points consistently per machine/
      // model. OVERLAY_NUDGE_X/OVERLAY_NUDGE_Y (PDF points; +y = up) shift EVERY
      // overlay placement so the operator can true-up alignment with one env knob.
      const anchored = anchorFor ? anchorFor(field) : null;
      const nx = (anchored ? anchored.x : field.x) + (Number(process.env.OVERLAY_NUDGE_X) || 0);
      const ny = (anchored ? anchored.y : field.y) + (Number(process.env.OVERLAY_NUDGE_Y) || 0);
      page.drawText(text, { x: nx, y: ny, size, font, color: rgb(0, 0, 0) });
      drawn += 1;
    }
    return drawn;
  };
  // Overlay mode: flat PDF, draw text at coordinates.
  if (def.fillMode === "overlay") {
    const drawn = await drawMappedOverlays() + await drawChecklist();
    await drawSignatures(doc, def, ctx);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, await doc.save());
    return { formId: def.id, formName: resultFormName, status: "filled", outputPath, filledFieldCount: drawn,
      unmappedRequested: [...checklist.omittedTextFields, ...missingRequired], message: completionMessage,
      ...(Object.keys(requestedFieldOwners).length ? { requestedFieldOwners } : {}) };
  }

  const form = doc.getForm();
  const available = new Set(form.getFields().map((f) => f.getName()));
  // A reused unverified BCD blank can contain stale radio selections. These
  // groups span unrelated questions, so none is a trustworthy row answer.
  if (checklist.recognized) {
    for (const field of form.getFields()) {
      if (field instanceof PDFRadioGroup) field.clear();
    }
  }
  if (available.size === 0) {
    return {
      formId: def.id,
      formName: def.formName,
      status: "needs_manual",
      message: "Form has no fillable AcroForm fields (XFA or scanned) and no overlay map is defined. A human must complete it.",
    };
  }

  const unmapped: string[] = [];
  let filled = 0;
  // A fixed value size is a look, not a licence to overflow: a value too wide for its box at that
  // size keeps the blank's own auto-size (fit), so it is never clipped at the box edge.
  const sizingFont = await doc.embedFont(StandardFonts.Helvetica);

  for (const [fieldName, source] of Object.entries(def.textFields)) {
    if (checklist.omittedTextFields.includes(fieldName)) { unmapped.push(fieldName); continue; }
    if (!available.has(fieldName)) { unmapped.push(fieldName); continue; }
    try {
      const field = form.getTextField(fieldName);
      const value = resolveSource(checklist.textFieldOverrides[fieldName] ?? source, ctx);
      field.setText(value);
      const fontSize = def.fieldFontSizes?.[fieldName] ?? checklist.fieldFontSizes?.[fieldName];
      const boxWidth = field.acroField.getWidgets()[0]?.getRectangle().width ?? 0;
      const fits = !value || !boxWidth || sizingFont.widthOfTextAtSize(value, fontSize ?? 0) <= boxWidth - 4;
      if (fontSize && fontSize >= 6 && fontSize <= 16 && fits) field.setFontSize(fontSize);
      filled += 1;
    } catch {
      unmapped.push(fieldName);
    }
  }

  // THE VALUATION FIELD DEFAULTS TO THE FORMULA ON EVERY AHJ FORM. Operator ruling
  // 2026-09-21: "put the valuation as default for the AHJs, not just Coos Bay — the
  // formula." Any fillable text field that asks for the job value and is NOT already
  // mapped gets computed.estimatedJobValue — which also spares the human-verified
  // Coos Bay map from needing an edit (rule 3): its blank "Estimated Job Value"
  // field fills here without the map changing. The name match is deliberately
  // tight: "Valuation Date" or "Land Value" must never catch it, and a value the
  // map already wrote is never overwritten.
  const valuationDefault = resolveSource("computed.estimatedJobValue", ctx);
  if (valuationDefault) {
    const mappedNames = new Set(Object.keys(def.textFields));
    const valuationName = /((estimated|declared)\s+)?job\s+valu(e|ation)|declared\s+valuation|valuation\s+of\s+(the\s+)?work|estimated\s+value\b|^valuation$/i;
    for (const name of available) {
      if (mappedNames.has(name) || !valuationName.test(name)) continue;
      try {
        const field = form.getTextField(name);
        if (!field.getText()) { field.setText(valuationDefault); filled += 1; }
      } catch { /* not a text field — leave it */ }
    }
  }

  for (const [fieldName, rule] of Object.entries(def.checkboxes ?? {})) {
    if (!available.has(fieldName)) { unmapped.push(fieldName); continue; }
    try {
      const value = resolveSource(rule.source, ctx);
      const checked = checkboxRuleChecked(rule, value);
      const box = form.getCheckBox(fieldName);
      if (checked) box.check(); else box.uncheck();
      filled += 1;
    } catch {
      unmapped.push(fieldName);
    }
  }

  for (const [fieldName, rule] of Object.entries(def.radioGroups ?? {})) {
    if (!available.has(fieldName)) { unmapped.push(fieldName); continue; }
    try {
      const group = form.getRadioGroup(fieldName);
      if (!checkboxRuleChecked(rule, resolveSource(rule.source, ctx))) continue;
      if (!group.getOptions().includes(rule.option)) { unmapped.push(fieldName); continue; }
      group.select(rule.option);
      filled += 1;
    } catch {
      unmapped.push(fieldName);
    }
  }

  // Flatten so the filled values are baked in and can't be edited in transit.
  try { if (!def.preserveInteractive) form.flatten(); else form.updateFieldAppearances(); } catch (error) {
    if (checklist.recognized) throw error;
    // Some forms can't flatten; retain the existing generic behavior.
  }
  if (checklist.recognized && form.getFields().length === 0) {
    // BCD's malformed radio groups leave annotation references to widgets that
    // pdf-lib removed. Keep valid links, but remove these dangling references.
    for (const page of doc.getPages()) {
      const annotations = page.node.Annots();
      if (!annotations) continue;
      for (let i = annotations.size() - 1; i >= 0; i--) {
        if (!doc.context.lookup(annotations.get(i))) annotations.remove(i);
      }
    }
    doc.catalog.delete(PDFName.of("AcroForm"));
  }

  // BCD's Yes radio groups span unrelated questions. Independent X overlays
  // after flattening preserve multiple answers without radio-group clearing.
  filled += await drawMappedOverlays();
  filled += await drawChecklist();

  // Stamp signatures on top of the flattened form.
  await drawSignatures(doc, def, ctx);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, await doc.save());

  return {
    formId: def.id,
    formName: resultFormName,
    status: "filled",
    outputPath,
    filledFieldCount: filled,
    unmappedRequested: [...unmapped, ...missingRequired],
    message: completionMessage,
    ...(Object.keys(requestedFieldOwners).length ? { requestedFieldOwners } : {}),
  };
}

export interface FilledFormPackage {
  projectId: string;
  ahj: string;
  generatedAt: string;
  forms: FilledFormResult[];
  unmatched: boolean;
}

export async function buildFilledFormsForProject(db: AppDb, project: ProjectRecord): Promise<FilledFormPackage> {
  // READ THE MODULE DATASHEET BEFORE FILLING (Oregon: BCD 5952 Part IV "Listing agency"). Text
  // first; a vision read of the datasheet page only when the text layer names no mark and a model
  // key is configured. The answer lands on the project (with its evidence) and is used below.
  if (String(project.state ?? "").trim().toUpperCase() === "OR" && !String((project.parserSnapshot ?? {}).moduleListingAgency ?? "").trim()) {
    try {
      const { ensureModuleListingAgency } = await import("./moduleListing");
      const { createLLMProvider } = await import("./llm");
      const reading = await ensureModuleListingAgency(db, project, process.env.ANTHROPIC_API_KEY ? createLLMProvider() : null);
      if (reading.agency) project = { ...project, parserSnapshot: { ...(project.parserSnapshot ?? {}), moduleListingAgency: reading.agency } };
    } catch { /* best-effort: the row stays blank and the fill note names it */ }
  }
  const permitPath = resolvePermitPath(project).path;
  const defs = matchingForms(project.ahj).filter((d) => d.status === "verified");
  const ctx = buildContext(db, project);
  const outDir = path.join(FILLED_DIR, project.id);

  const forms: FilledFormResult[] = [];
  // Forms skipped because they're the "other" application for this permit path —
  // reported so the operator can see why only one application was filled.
  const skipped: FilledFormResult[] = [];
  const noteSkip = (formId: string, formName: string, knownKind?: "prescriptive" | "structural" | null): void => {
    // Same precedence as the gate that just refused it, or the skip message names the
    // wrong application for a stamped blank whose filename claims nothing.
    const kind = knownKind === undefined ? formApplicationKind(formName) : knownKind;
    // A SKIP MUST ALSO CLEAN UP. Skipping was the whole of the old behaviour, and it
    // left the PREVIOUS path's filled PDF sitting in backend/data/filled/<projectId>/.
    // Flip a project from engineered to prescriptive and rebuild, and the structural
    // application is still on disk — now off-path, still packaged. Delete it as part
    // of not filling it. (The presence/packaging filters are the guarantee for the
    // window where nobody rebuilds; this closes the window.)
    try {
      const stale = path.join(outDir, `${formId}.pdf`);
      if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
    } catch { /* best effort — the off-path filters still drop it */ }
    skipped.push({
      formId,
      formName,
      status: "skipped",
      message: permitPath === "unknown"
        ? `Not filled — permit path not confirmed. ${kind === "prescriptive" ? "Prescriptive" : "Structural"} application is only filled once you set the permit path (Manual entry → Permit path).`
        // NAME THE FORM'S OWN KIND, not just the path's. A blank the AHJ published as
        // "Building Permit Application.pdf" IS the structural application (acquisition
        // stamped it), and a message that only repeats the path leaves the operator
        // staring at a generically-named form with no idea why it was skipped.
        : `Not filled — this blank is the ${kind === "prescriptive" ? "prescriptive" : "structural"} application and this project is on the ${permitPath} path, so only the ${permitPath === "prescriptive" ? "prescriptive" : "structural"} application is filled. Do NOT upload both applications.`,
      verified: true,
    });
  };

  for (const def of defs) {
    if (!formAllowedForPath(def.formName, permitPath)) { noteSkip(def.id, def.formName); continue; }
    // Built-in registry forms are hand-tuned, so inherently verified. Merge any
    // vision-detected signature placements stored for this registry form.
    // Isolate each fill: a bad signature override (e.g. from a detect-sigs run
    // with out-of-bounds coords) must not nuke the whole package — surface it as
    // a per-form error so the operator still sees every other form.
    try {
      // Prefer hand-tuned signature placements on the registry def; only fall
      // back to a vision-detected override when the def defines none. A bad
      // detect-signatures run must not override known-good coordinates.
      const sigOverride = loadRegistrySignatureOverride(db, def.id);
      const effectiveDef = def.signatureFields?.length
        ? def
        : sigOverride.length ? { ...def, signatureFields: sigOverride } : def;
      forms.push({ ...(await fillForm(effectiveDef, ctx, path.join(outDir, `${def.id}.pdf`))), verified: true, signaturesLocked: Boolean(def.signatureFields?.length) });
    } catch (err) {
      forms.push({
        formId: def.id,
        formName: def.formName,
        status: "error",
        message: `Fill failed: ${(err as Error).message || String(err)}`,
        verified: true,
      });
    }
  }

  // Also fill any stored AHJ form templates (operator-uploaded or auto-researched)
  // for this AHJ/state that aren't already covered by a built-in registry form.
  for (const stored of loadStoredTemplates(db, project.ahj, project.state)) {
    if (forms.some((f) => f.formId === stored.def.id)) continue;
    // The STORED kind, not the name — see formAllowedForPath's header. A structural blank
    // published as "Building Permit Application.pdf" is invisible to a name-only gate.
    if (!formAllowedForPath(stored.def.formName, permitPath, stored.applicationKind)) {
      noteSkip(stored.def.id, stored.def.formName, stored.applicationKind);
      continue;
    }
    // A FORM IS A DATED ARTIFACT, AND THIS IS THE SCREEN WHERE IT GETS FILED.
    // Coos County's electrical permit application prints the renewable-energy
    // fee table on page 1 under "Revised 12/23/2022"; the county's adopted
    // schedule for those same brackets is 1.70x higher. The operator holding
    // the filled PDF is the last person who can catch that, so the document's
    // own date travels with the fill result rather than living only in the
    // template manager.
    const dated = {
      documentDate: stored.documentDate,
      documentStale: stored.documentStale,
      sourceUrl: stored.sourceUrl,
    };
    const staleNote = stored.documentStale
      ? `This blank dates ITSELF "${stored.documentDate}" — over two years old. Re-check the AHJ's current forms page before filing, and if it prints a fee table, re-check that against the adopted schedule.`
      : "";
    // WHOSE FORM IT IS, said on the result: a county application filled for a city job must read
    // as the county's, never as the city's.
    const issuerNote = stored.issuedBy
      ? `${stored.issuedBy}'s own application — the per-job lookup cites ${stored.issuedBy} as the agency that issues this permit for ${project.ahj}.`
      : "";
    const withNote = (message?: string): string | undefined =>
      [issuerNote, message, staleNote].filter(Boolean).join(" ") || undefined;
    try {
      const result = await fillLoadedForm(stored.def, stored.bytes, ctx, path.join(outDir, `${stored.def.id}.pdf`));
      forms.push({ ...result, ...dated, message: withNote(result.message), verified: stored.verified, templateId: stored.templateId });
    } catch (err) {
      // Keep the verify/re-map affordance alive even when the fill errors, so the
      // operator can re-map or delete a broken template instead of being stuck.
      forms.push({
        formId: stored.def.id,
        formName: stored.def.formName,
        status: "error",
        message: withNote(`Fill failed: ${(err as Error).message || String(err)}`),
        verified: stored.verified,
        templateId: stored.templateId,
        ...dated,
      });
    }
  }

  // THE ISSUING AGENCY'S BLANK THAT CANNOT BE FILLED IS STILL ITS REQUIRED APPLICATION. It is
  // never reported "filled"; it is named, so the operator completes it by hand and attaches it.
  // (Path-gated like every other form: an off-path application is simply not this job's.)
  try {
    for (const blank of heldUnfillableAgencyBlanks(db, project)) {
      if (forms.some((f) => f.templateId === blank.templateId)) continue;
      if (!formAllowedForPath(blank.formName, permitPath, blank.applicationKind)) continue;
      forms.push({
        formId: `tmpl-${blank.templateId}`,
        formName: blank.formName,
        status: "needs_manual",
        message: `${blank.agency}'s own application (the agency that issues this permit for ${project.ahj}) is held but is not fillable — print it, complete it by hand, and attach it. It is required and has NOT been filled.`,
        verified: false,
        templateId: blank.templateId,
        sourceUrl: blank.sourceUrl,
      });
    }
  } catch { /* listing only — the required-document gate still names the missing application */ }

  return {
    projectId: project.id,
    ahj: project.ahj,
    generatedAt: nowIso(),
    forms: [...forms, ...skipped],
    unmatched: forms.length === 0,
  };
}

// Build fillable definitions from stored ahj_form_templates rows for this AHJ.
// The field_map column holds { formName, sourceUrl, fillMode, textFields, checkboxes }.
//
// `applicationKind` travels WITH the template, because the gates that read it (the fill
// gate here, the submit gate in repository.ts) only ever held the form's NAME, and a name
// is the weaker of the two answers — acquisition stamped what it went looking for.
export interface StoredTemplate {
  def: AhjFormDefinition;
  bytes: Uint8Array;
  templateId: string;
  verified: boolean;
  documentDate: string;
  documentStale: boolean;
  sourceUrl: string;
  /** The stored blank's sha256 (field_map.sourceHash, stamped at store) — "" on rows stored before it. */
  sourceHash: string;
  applicationKind: "prescriptive" | "structural" | null;
  /** The row's form_type ("" on rows stored before the column mattered). */
  formType: string;
  /** Whose form it is: the row's own ahj_name. */
  authority: string;
  /** Set when the row is loaded for a project because the per-job lookup cites THIS agency as the
   *  issuer of a track the AHJ does not issue itself (applicationDocsAgency.formAuthorityFor). */
  issuedBy: string;
}

type TemplateRow = { id: string; ahj_name: string; state: string; form_type?: string; original_filename: string; pdf_blob: Buffer | null; field_map: string; document_date: string; source_url: string };

/** A stored row as a fillable definition; null when its map could fill nothing. */
function storedTemplateFromRow(row: TemplateRow, issuedBy = ""): StoredTemplate | null {
  if (!row.pdf_blob) return null;
  const rowAhj = String(row.ahj_name || "").trim().toLowerCase();
  let map: { formName?: string; sourceUrl?: string; sourceHash?: string; fillMode?: string; textFields?: Record<string, string>; checkboxes?: Record<string, { source: string; equals?: string }>; radioGroups?: Record<string, { source: string; equals?: string; option: string }>; overlayFields?: OverlayField[]; signatureFields?: SignaturePlacement[]; verified?: boolean; requiredFields?: Record<string,string>; notes?: string; preserveInteractive?: boolean; fieldFontSizes?: Record<string,number> } = {};
  map = parseJson(row.field_map, {});
  const textFields = map.textFields || {};
  const overlayFields = map.overlayFields || [];
  const signatureFields = map.signatureFields || [];
  const isOverlay = map.fillMode === "overlay" && overlayFields.length > 0;
  const hasAcro = Object.keys(textFields).length > 0 || (map.checkboxes && Object.keys(map.checkboxes).length > 0);
  // A form with only signature placements is still usable (signs the blank).
  if (!isOverlay && !hasAcro && !signatureFields.length) return null;
  return {
    def: {
      id: `tmpl-${row.id}`,
      formName: map.formName || row.original_filename || `${row.ahj_name} form`,
      matchJurisdictions: [rowAhj],
      sourceUrl: map.sourceUrl || "",
      version: "stored",
      status: "verified",
      fillMode: isOverlay ? "overlay" : "acroform",
      textFields,
      checkboxes: map.checkboxes || {},
      radioGroups: map.radioGroups,
      overlayFields,
      signatureFields,
      requiredFields: map.requiredFields,
      preserveInteractive: map.preserveInteractive,
      fieldFontSizes: map.fieldFontSizes,
      notes: map.notes ? [map.notes] : undefined,
      recoverPrescriptiveCheckboxes: map.verified !== true,
    },
    bytes: new Uint8Array(row.pdf_blob),
    templateId: row.id,
    verified: map.verified === true,
    documentDate: String(row.document_date || ""),
    documentStale: isDocumentDateStale(String(row.document_date || "")),
    sourceUrl: String(row.source_url || map.sourceUrl || ""),
    sourceHash: String(map.sourceHash || ""),
    applicationKind: storedApplicationKind(row),
    formType: String(row.form_type || ""),
    authority: String(row.ahj_name || ""),
    issuedBy,
  };
}

const rowStateOk = (row: { state?: string }, state: string): boolean =>
  !row.state || !state || String(row.state).toLowerCase() === String(state).toLowerCase();

/**
 * The stored templates that apply to an AHJ's jobs — AND THE ISSUING AGENCY'S, where another
 * agency issues one of its permits (the one question answered by
 * applicationDocsAgency.formAuthorityFor; operator finding 2026-09-27: a City of Jefferson job
 * held only the BCD checklist while Marion County, which issues both its permits, had
 * applications of its own). Every door reads this one list — the fill
 * (buildFilledFormsForProject), the staging-time fill forecast (missingFilledAtStaging), the
 * submit gate's unverified-forms check (repository.ts) — so they cannot disagree about which forms
 * a job has.
 *
 *  - The AHJ's own rows: name containment, as always (a job whose lookup names no other agency
 *    gets exactly today's list).
 *  - For each track another agency issues: that agency's rows of the track's form types, matched
 *    by EXACT agency identity (never containment — "Jefferson County" is not the City of
 *    Jefferson). When the agency holds one, it REPLACES the AHJ's own application of that track —
 *    two electrical applications for one permit is the wrong filing — unless a person verified the
 *    AHJ's own (hard rule 3: a human answer is never displaced by an automatic one).
 *  - A state checklist / worksheet is no track's application and always stays the AHJ's.
 *
 * `ownOnly` answers "what does THIS authority hold" (acquisition's already-stored checks).
 */
export function loadStoredTemplates(db: AppDb, ahj: string, state: string, opts: { ownOnly?: boolean } = {}): StoredTemplate[] {
  const needle = (ahj || "").trim().toLowerCase();
  if (!needle) return [];
  const rows = db.query<TemplateRow>(
    "SELECT id, ahj_name, state, form_type, original_filename, pdf_blob, field_map, document_date, source_url FROM ahj_form_templates WHERE pdf_blob IS NOT NULL ORDER BY updated_at DESC",
  );
  let out: StoredTemplate[] = [];
  const ownRows = new Map<string, TemplateRow>();
  for (const row of rows) {
    const rowAhj = String(row.ahj_name || "").trim().toLowerCase();
    if (!rowAhj) continue;
    const nameMatches = rowAhj === needle || needle.includes(rowAhj) || rowAhj.includes(needle);
    if (!nameMatches || !rowStateOk(row, state)) continue;
    const t = storedTemplateFromRow(row);
    if (t) { out.push(t); ownRows.set(t.templateId, row); }
  }
  if (opts.ownOnly) return out;
  for (const other of tracksIssuedByOther({ state, ahj })) {
    const types = TRACK_FORM_TYPES[other.track];
    // C1 THE AMPLIFIER (agency-contain): the agency's rows THIS job may use — curated, person-placed, or
    // on a site this job's own lookup anchors (applicationDocsAgency.agencyRowAppliesToJob). A row of the
    // agency's that the AHJ's name happens to contain ("Unincorporated Kestrel County") is held to the
    // same answer: it is the agency's row whichever pass found it.
    const anchors = anchorSitesOnce({ state, ahj }, other.name);
    const applies = (row: TemplateRow): boolean => agencyRowAppliesToJob({ state, ahj }, other.name, agencyRowProvenance(row), anchors);
    out = out.filter((t) => {
      const own = ownRows.get(t.templateId);
      return t.issuedBy || !own || !types.includes(t.formType) || !rowBelongsToAuthority(t.authority, other.name) || applies(own);
    });
    const agency = rows
      .filter((row) => types.includes(String(row.form_type || "")) && rowStateOk(row, state) && rowBelongsToAuthority(row.ahj_name, other.name) && applies(row))
      .map((row) => storedTemplateFromRow(row, other.name))
      .filter((t): t is StoredTemplate => Boolean(t));
    if (!agency.length) continue;
    if (out.some((t) => !t.issuedBy && types.includes(t.formType) && t.verified)) continue;
    out = out.filter((t) => t.issuedBy || !types.includes(t.formType));
    for (const t of agency) if (!out.some((x) => x.templateId === t.templateId)) out.push(t);
  }
  return out;
}

/** Blanks the ISSUING AGENCY holds for this project's tracks that cannot be filled (no usable
 *  map: a flat scan, or an AcroForm nothing mapped to). They are never reported "filled" — they are
 *  listed so the operator completes and attaches them by hand. */
export function heldUnfillableAgencyBlanks(db: AppDb, project: Pick<ProjectRecord, "ahj" | "state">): Array<{ templateId: string; formName: string; formType: string; agency: string; sourceUrl: string; sourceHash: string; verified: boolean; applicationKind: "prescriptive" | "structural" | null }> {
  const out: Array<{ templateId: string; formName: string; formType: string; agency: string; sourceUrl: string; sourceHash: string; verified: boolean; applicationKind: "prescriptive" | "structural" | null }> = [];
  const others = tracksIssuedByOther(project);
  if (!others.length) return out;
  const rows = db.query<TemplateRow>(
    "SELECT id, ahj_name, state, form_type, original_filename, pdf_blob, field_map, document_date, source_url FROM ahj_form_templates WHERE pdf_blob IS NOT NULL",
  );
  for (const other of others) {
    // C1 (agency-contain): only the agency's rows THIS job may use (agencyRowAppliesToJob).
    const anchors = anchorSitesOnce(project, other.name);
    for (const row of rows) {
      if (!TRACK_FORM_TYPES[other.track].includes(String(row.form_type || "")) || !rowStateOk(row, project.state) || !rowBelongsToAuthority(row.ahj_name, other.name)) continue;
      if (!agencyRowAppliesToJob(project, other.name, agencyRowProvenance(row), anchors)) continue;
      if (storedTemplateFromRow(row)) continue;
      const map = parseJson<{ formName?: string; sourceHash?: string; verified?: boolean }>(String(row.field_map || "{}"), {});
      out.push({ templateId: row.id, formName: map.formName || row.original_filename, formType: String(row.form_type || ""), agency: other.name, sourceUrl: String(row.source_url || ""), sourceHash: String(map.sourceHash || ""), verified: map.verified === true, applicationKind: storedApplicationKind(row) });
    }
  }
  return out;
}

// Vision-detected signature placements stored for a built-in registry form.
export function loadRegistrySignatureOverride(db: AppDb, formId: string): SignaturePlacement[] {
  const row = db.get<{ signature_fields: string }>("SELECT signature_fields FROM registry_form_overrides WHERE form_id = ?", [formId]);
  if (!row) return [];
  try {
    const arr = JSON.parse(row.signature_fields || "[]");
    return Array.isArray(arr) ? (arr as SignaturePlacement[]) : [];
  } catch {
    return [];
  }
}

export function saveRegistrySignatureOverride(db: AppDb, formId: string, signatureFields: SignaturePlacement[]): void {
  db.run(
    `INSERT INTO registry_form_overrides (form_id, signature_fields, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(form_id) DO UPDATE SET signature_fields = excluded.signature_fields, updated_at = excluded.updated_at`,
    [formId, JSON.stringify(signatureFields), nowIso()],
  );
}

/** What a stored template row claims to be. The kind acquisition STAMPED on it wins
 *  (we went looking for the prescriptive blank and that is what we stored); the form's
 *  own name is the fallback for rows stored before the stamp existed. */
export function storedApplicationKind(row: { original_filename?: string; field_map?: string }): "prescriptive" | "structural" | null {
  const map = parseJson<{ formName?: string; applicationKind?: string }>(String(row.field_map || "{}"), {});
  const stamped = String(map.applicationKind || "");
  if (stamped === "prescriptive" || stamped === "structural") return stamped;
  return formApplicationKind(`${map.formName || ""} ${row.original_filename || ""}`);
}

/** The permit path for a project id, read the way resolvePermitPath reads it.
 *  resolvePermitPath consults ONLY project.parserSnapshot (permitPath.ts `snap`/`num`),
 *  which is the projects.parser_json column — so this is the same data the repository
 *  mapper hands it, not a second opinion. Guarded: anything unreadable is "unknown",
 *  which contradicts nothing and therefore filters nothing. */
function permitPathForProjectId(db: AppDb, projectId: string): "prescriptive" | "engineered" | "unknown" {
  try {
    // EVERY field resolvePermitPath reads, not the snapshot alone. Since the prescriptive split
    // became Oregon's (0d6ebe3 / 61c0e20) a project with no state resolves "unknown" and a
    // "prescriptive" override is set aside — so a snapshot-only record made every Oregon
    // prescriptive job "unknown" here, and autoLearn's upload sweep (projectId only) packaged the
    // stale STRUCTURAL fill Coos Bay forbids ("Do NOT also upload the structural application").
    const row = db.get<{ parser_json?: string; state?: string | null; ahj?: string | null; system_size_dc_kw?: number | null }>(
      "SELECT parser_json, state, ahj, system_size_dc_kw FROM projects WHERE id = ?", [projectId]);
    if (!row) return "unknown";
    return resolvePermitPath({
      parserSnapshot: parseJson(String(row.parser_json || "{}"), {}),
      state: row.state ?? "", ahj: row.ahj ?? "", systemSizeDcKw: row.system_size_dc_kw ?? null,
    } as ProjectRecord).path;
  } catch {
    return "unknown";
  }
}

export interface FilledApplicationForm {
  /** The application docType this filled PDF claims. */
  docType: string;
  /** Absolute path to the filled PDF on disk. */
  filePath: string;
  /** The form's own name, as stored/registered. */
  formName: string;
  /** Which of the two mutually-exclusive building-side applications it is, or null
   *  for a form that makes no such claim (generic application, electrical, checklist). */
  applicationKind: "prescriptive" | "structural" | null;
}

/**
 * Already-BUILT filled forms for a project. Disk-only — never triggers a build
 * (step 3 builds; staging just uses what exists).
 *
 * OFF-PATH FILLS ARE DROPPED HERE, AND THIS IS THE WHOLE POINT. buildFilledFormsForProject
 * only ever SKIPS the other application; nothing deleted backend/data/filled/<projectId>/.
 * So an ENGINEERED fill followed by a path flip to PRESCRIPTIVE left a STRUCTURAL PDF on
 * disk that satisfied the prescriptive row ("via: filled form") and was then handed to the
 * portal upload sweep — against the AHJ's own printed instruction: "Prescriptive path —
 * upload ONLY the prescriptive application. Do NOT also upload the structural application."
 *
 * The filter runs over the FILE LIST, before the first-wins-per-docType collapse: a stale
 * structural fill and a fresh prescriptive fill both key to building_application, and
 * collapsing first would let whichever was read first decide the slot.
 */
export function filledApplicationForms(db: AppDb, projectId: string, permitPath?: "prescriptive" | "engineered" | "unknown"): FilledApplicationForm[] {
  const dir = path.join(FILLED_DIR, projectId);
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".pdf")); } catch { return []; }
  // Resolved here when the caller didn't pass one, so EVERY consumer is covered —
  // including ones that only have a projectId in hand (autoLearn's upload sweep).
  const resolvedPath = permitPath ?? permitPathForProjectId(db, projectId);
  const out: FilledApplicationForm[] = [];
  for (const f of files) {
    const formId = f.replace(/\.pdf$/, "");
    let docType = "permit_application";
    let formName = "";
    let kind: "prescriptive" | "structural" | null = null;
    const tmpl = formId.startsWith("tmpl-")
      ? db.get<{ form_type?: string; original_filename?: string; field_map?: string }>(
          "SELECT form_type, original_filename, field_map FROM ahj_form_templates WHERE id = ?", [formId.slice(5)])
      : null;
    // AN ORPHANED FILL IS NOT AN APPLICATION. A filled PDF counts only when the form it was
    // filled FROM still exists: its ahj_form_templates row (tmpl-<id>) or its registry def.
    // Without this, a tmpl-*.pdf whose row is gone (deleted template, a data dir copied onto
    // another database — the demo kit shipped seven carrying production template ids) fell
    // through to the registry branch, found nothing, and was counted as a nameless
    // `permit_application` — enough to turn Coos Bay's blocking application row "present"
    // and pass docs.complete on a form nobody can identify, re-fill, or verify.
    if (formId.startsWith("tmpl-") && !tmpl) continue;
    if (tmpl) {
      if (tmpl.form_type) docType = String(tmpl.form_type);
      formName = String(parseJson<{ formName?: string }>(String(tmpl.field_map || "{}"), {}).formName || tmpl.original_filename || "");
      kind = storedApplicationKind(tmpl);
    } else {
      const def = ahjFormRegistry.find((d) => d.id === formId);
      if (!def) continue; // same rule for a registry id the code no longer carries
      formName = def.formName || "";
      const name = formName.toLowerCase();
      if (/electrical/.test(name)) docType = "electrical_application";
      else if (/checklist|worksheet|eligibilit/.test(name)) docType = "solar_checklist";
      else if (/building|structural/.test(name)) docType = "building_application";
      kind = formApplicationKind(formName);
    }
    if (formContradictsPath(formName, resolvedPath, kind)) continue;
    out.push({ docType, filePath: path.join(dir, f), formName, applicationKind: kind });
  }
  return out;
}

/** Already-BUILT filled forms keyed by application docType (building_application /
 *  electrical_application / solar_checklist / permit_application) so portal upload
 *  slots asking for the completed application can attach the real filled PDF.
 *  First form wins per type — AFTER the off-path drop above. */
export function filledFormsByDocType(db: AppDb, projectId: string, permitPath?: "prescriptive" | "engineered" | "unknown"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const form of filledApplicationForms(db, projectId, permitPath)) {
    if (!out[form.docType]) out[form.docType] = form.filePath;
  }
  return out;
}

export function filledFormPath(projectId: string, formId: string): string {
  // Guard against path traversal in the formId path segment.
  const safe = formId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(FILLED_DIR, projectId, `${safe}.pdf`);
}
