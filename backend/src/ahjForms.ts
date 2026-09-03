import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { ProjectRecord } from "../../shared/src/types";
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { clientStagingOverlay } from "./clients";
import { HttpError } from "./httpError";
import { loadDefaultSignaturesByRole } from "./signatures";
import { nowIso } from "./time";
import { parseJson } from "./json";
import { resolvePermitPath, evaluatePrescriptiveCriteria, type PrescriptiveCriterion, type PrescriptiveLimitInputs } from "./permitPath";
import { resolveEffectiveCodeContext } from "./codeProfiles";

// Classify an AHJ form by which mutually-exclusive solar application it is, from its
// name/filename. A prescriptive and a structural application must NEVER both be filled
// for the same project — the AHJ takes exactly one, chosen by the permit path.
function formApplicationKind(formName: string): "prescriptive" | "structural" | null {
  const n = (formName || "").toLowerCase();
  if (/prescriptive/.test(n)) return "prescriptive";
  if (/structural|non[-\s]?prescriptive|engineered/.test(n)) return "structural";
  return null;
}

// Should this form be filled given the project's resolved permit path? Only the
// application matching the path is filled; non-application forms (electrical, etc.)
// always pass. When the path is unknown we fill neither application form (the operator
// must confirm the path first) — surfaced in the form message.
export function formAllowedForPath(formName: string, path: "prescriptive" | "engineered" | "unknown"): boolean {
  const kind = formApplicationKind(formName);
  if (!kind) return true;
  if (path === "prescriptive") return kind === "prescriptive";
  if (path === "engineered") return kind === "structural";
  return false; // unknown path → don't auto-fill either application until confirmed
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
  // overlay placements (used when fillMode === "overlay")
  overlayFields?: OverlayField[];
  // operator-signature image placements (applied to both fill modes)
  signatureFields?: SignaturePlacement[];
  notes?: string[];
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
      { source: "client.electricalSupervisorName", page: 0, x: 93, y: 225, maxWidth: 150 },
      // Print name under electrician sig (from stored electrician signature, fallback to supervisor name)
      { source: "computed.electricianSignerName", page: 0, x: 93, y: 212, maxWidth: 150 },
      // "License no" sits on the electrician's PRINT NAME row — it wants the supervising
      // electrician's own licence, and a filled form came back with TODAY'S DATE in it
      // because the signature placement below was writing its date at these coordinates.
      { source: "client.electricianLicenseNumber", page: 0, x: 292, y: 212, maxWidth: 90 },
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
        x: 138,
        y: 197,
        width: 150,
        // Same row pitch as the electrician line above — keep the ink inside its own row.
        height: 12,
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
        x: 93,
        y: 237,
        width: 150,
        // Rows on this form are ~13-17pt apart. At 22 the ink (plus SIGNATURE_LIFT)
        // spanned nearly two rows and collided with the line above — visible on a filled
        // form as the electrician's signature sitting across the row above its own.
        height: 12,
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
  project: ProjectRecord;
  client: Record<string, string>; // overlay keys (installerCompanyName, ccbLicenseNumber, ...)
  snapshot: Record<string, unknown>;
  // Default operator signature image per role, drawn at the form's signature
  // placements. Loaded in buildContext; empty when none are stored.
  signatures?: Record<string, { bytes: Uint8Array; mime: string; widthPx: number; heightPx: number; name: string }>;
  // Lazily-evaluated prescriptive criteria rows, cached so the presc* computed
  // sources evaluate the screen once per fill (see prescriptiveComputed).
  prescriptive?: PrescriptiveCriterion[];
  // Per-AHJ prescriptive limit overrides from the jurisdiction code profile
  // (loaded in buildContext) — the presc* sources must screen against the SAME
  // limits QC's baseline rules use, not always the Oregon defaults.
  prescriptiveLimits?: PrescriptiveLimitInputs;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// kVA basis for renewable-energy electrical permit fees (solar inverter AC
// output ≈ kVA). Falls back to DC size if AC is missing.
function systemKva(ctx: FillContext): number {
  return Number(ctx.project.systemSizeAcKw || ctx.project.systemSizeDcKw || 0);
}

// Renewable energy permit fee using the rate schedule PRINTED ON THIS FORM
// (rev 7/1/2025): ≤5 kVA $201, 5.01–15 $283, 15.01–25 $372, >25 $14.78/kVA.
function renewableFee(ctx: FillContext): number {
  const k = systemKva(ctx);
  if (k <= 0) return 0;
  if (k <= 5) return 201;
  if (k <= 15) return 283;
  if (k <= 25) return 372;
  return Math.round(k * 14.78 * 100) / 100;
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
  if (name.startsWith("presc")) return prescriptiveComputed(name, ctx);
  switch (name) {
    case "todaySigned": {
      const d = new Date();
      return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
    }
    case "systemKva": {
      const k = systemKva(ctx);
      return k ? String(k) : "";
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
    case "fullAddress":
      return [ctx.project.projectAddress, ctx.project.city, ctx.project.state, ctx.project.zip]
        .filter(Boolean)
        .join(", ");
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
      return [
        isAddition ? "Install roof-mounted photovoltaic solar system addition" : "Install roof-mounted photovoltaic solar system",
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
  return {
    project,
    client,
    snapshot: (project.parserSnapshot ?? {}) as Record<string, unknown>,
    // The signature stamped on a permit form comes from the org that OWNS the
    // project — this runs from background jobs with no request, so it can't be
    // taken from a session.
    signatures: loadDefaultSignaturesByRole(db, projectOrgId(db, project.id)),
    prescriptiveLimits,
  };
}

/** The org that owns a project, for background work that has no request context. */
function projectOrgId(db: AppDb, projectId: string): string {
  const row = db.get<{ org_id?: string }>("SELECT org_id FROM projects WHERE id = ?", [projectId]);
  return String(row?.org_id || DEFAULT_ORG_ID);
}

// Stamp the operator's stored signature image(s) onto the form at the detected
// signature placements. Each role uses its default signature; an unmatched role
// falls back to the applicant signature. Returns how many were drawn.
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
    const sig = sigs[pl.role] || sigs.applicant;
    if (!sig) continue;
    const page = pages[pl.page];
    if (!page) continue;
    // A bad vision detection can return NaN/Infinity coords; pdf-lib throws on
    // those. Skip such placements rather than let them abort the whole fill.
    if (!Number.isFinite(pl.x) || !Number.isFinite(pl.y)) continue;
    let img;
    try {
      img = sig.mime.includes("jpeg") ? await doc.embedJpg(sig.bytes) : await doc.embedPng(sig.bytes);
    } catch {
      continue;
    }
    // Fit within the placement box, preserving aspect ratio.
    const boxW = Number.isFinite(pl.width) && pl.width > 0 ? pl.width : 130;
    const boxH = Number.isFinite(pl.height) && pl.height > 0 ? pl.height : 34;
    const scale = Math.min(boxW / img.width, boxH / img.height) || 1;
    // Sit the signature ON the line, not on the label under it. Vision detections
    // anchor at the label's baseline, which put the ink overlapping "SIGNATURE
    // OWNER / AUTHORIZED AGENT" on real forms (Coos Bay building permit +
    // acknowledgement page, live-tested) — lift the image so its bottom rests
    // just above the rule line the way a pen signature would.
    const SIGNATURE_LIFT = 6;
    page.drawImage(img, { x: pl.x, y: pl.y + SIGNATURE_LIFT, width: img.width * scale, height: img.height * scale });
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

export interface FilledFormResult {
  formId: string;
  formName: string;
  status: "filled" | "needs_manual" | "error" | "skipped";
  outputPath?: string;
  filledFieldCount?: number;
  unmappedRequested?: string[];
  message?: string;
  /** Whether this form's mapping is human-verified. Registry forms are inherently
   *  verified; stored auto/uploaded forms start false until the operator confirms. */
  verified?: boolean;
  /** ahj_form_templates row id (stored forms only), for the verify action. */
  templateId?: string;
  /** True when signature placements are hand-tuned on the registry def, so the
   *  "Detect signature lines" affordance is irrelevant and hidden in the UI. */
  signaturesLocked?: boolean;
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
  const doc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });

  // Overlay mode: flat PDF, draw text at coordinates.
  if (def.fillMode === "overlay") {
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
    for (const field of def.overlayFields ?? []) {
      const page = pages[field.page];
      if (!page) continue;
      if (field.onlyIf) {
        const cond = resolveSource(field.onlyIf.source, ctx);
        if (!checkboxRuleChecked({ source: field.onlyIf.source, equals: field.onlyIf.equals }, cond)) continue;
      }
      let text = resolveSource(field.source, ctx);
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
    await drawSignatures(doc, def, ctx);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, await doc.save());
    return { formId: def.id, formName: def.formName, status: "filled", outputPath, filledFieldCount: drawn, unmappedRequested: [] };
  }

  const form = doc.getForm();
  const available = new Set(form.getFields().map((f) => f.getName()));
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

  for (const [fieldName, source] of Object.entries(def.textFields)) {
    if (!available.has(fieldName)) { unmapped.push(fieldName); continue; }
    try {
      form.getTextField(fieldName).setText(resolveSource(source, ctx));
      filled += 1;
    } catch {
      unmapped.push(fieldName);
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

  // Flatten so the filled values are baked in and can't be edited in transit.
  try { form.flatten(); } catch { /* some forms can't flatten; leave as-is */ }

  // Stamp signatures on top of the flattened form.
  await drawSignatures(doc, def, ctx);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, await doc.save());

  return {
    formId: def.id,
    formName: def.formName,
    status: "filled",
    outputPath,
    filledFieldCount: filled,
    unmappedRequested: unmapped,
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
  const permitPath = resolvePermitPath(project).path;
  const defs = matchingForms(project.ahj).filter((d) => d.status === "verified");
  const ctx = buildContext(db, project);
  const outDir = path.join(FILLED_DIR, project.id);

  const forms: FilledFormResult[] = [];
  // Forms skipped because they're the "other" application for this permit path —
  // reported so the operator can see why only one application was filled.
  const skipped: FilledFormResult[] = [];
  const noteSkip = (formId: string, formName: string): void => {
    const kind = formApplicationKind(formName);
    skipped.push({
      formId,
      formName,
      status: "skipped",
      message: permitPath === "unknown"
        ? `Not filled — permit path not confirmed. ${kind === "prescriptive" ? "Prescriptive" : "Structural"} application is only filled once you set the permit path (Manual entry → Permit path).`
        : `Not filled — this project is on the ${permitPath} path, so only the ${permitPath === "prescriptive" ? "prescriptive" : "structural"} application is filled. Do NOT upload both applications.`,
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
    if (!formAllowedForPath(stored.def.formName, permitPath)) { noteSkip(stored.def.id, stored.def.formName); continue; }
    try {
      const result = await fillLoadedForm(stored.def, stored.bytes, ctx, path.join(outDir, `${stored.def.id}.pdf`));
      forms.push({ ...result, verified: stored.verified, templateId: stored.templateId });
    } catch (err) {
      // Keep the verify/re-map affordance alive even when the fill errors, so the
      // operator can re-map or delete a broken template instead of being stuck.
      forms.push({
        formId: stored.def.id,
        formName: stored.def.formName,
        status: "error",
        message: `Fill failed: ${(err as Error).message || String(err)}`,
        verified: stored.verified,
        templateId: stored.templateId,
      });
    }
  }

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
export function loadStoredTemplates(db: AppDb, ahj: string, state: string): Array<{ def: AhjFormDefinition; bytes: Uint8Array; templateId: string; verified: boolean }> {
  const needle = (ahj || "").trim().toLowerCase();
  if (!needle) return [];
  const rows = db.query<{ id: string; ahj_name: string; state: string; original_filename: string; pdf_blob: Buffer | null; field_map: string }>(
    "SELECT id, ahj_name, state, original_filename, pdf_blob, field_map FROM ahj_form_templates WHERE pdf_blob IS NOT NULL ORDER BY updated_at DESC",
  );
  const out: Array<{ def: AhjFormDefinition; bytes: Uint8Array; templateId: string; verified: boolean }> = [];
  for (const row of rows) {
    const rowAhj = String(row.ahj_name || "").trim().toLowerCase();
    if (!rowAhj) continue;
    const nameMatches = rowAhj === needle || needle.includes(rowAhj) || rowAhj.includes(needle);
    const stateOk = !row.state || !state || String(row.state).toLowerCase() === String(state).toLowerCase();
    if (!nameMatches || !stateOk || !row.pdf_blob) continue;
    let map: { formName?: string; sourceUrl?: string; fillMode?: string; textFields?: Record<string, string>; checkboxes?: Record<string, { source: string; equals?: string }>; overlayFields?: OverlayField[]; signatureFields?: SignaturePlacement[]; verified?: boolean } = {};
    map = parseJson(row.field_map, {});
    const textFields = map.textFields || {};
    const overlayFields = map.overlayFields || [];
    const signatureFields = map.signatureFields || [];
    const isOverlay = map.fillMode === "overlay" && overlayFields.length > 0;
    const hasAcro = Object.keys(textFields).length > 0 || (map.checkboxes && Object.keys(map.checkboxes).length > 0);
    // A form with only signature placements is still usable (signs the blank).
    if (!isOverlay && !hasAcro && !signatureFields.length) continue;
    out.push({
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
        overlayFields,
        signatureFields,
      },
      bytes: new Uint8Array(row.pdf_blob),
      templateId: row.id,
      verified: map.verified === true,
    });
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

/** Already-BUILT filled forms for a project, keyed by application docType
 *  (building_application / electrical_application / solar_checklist /
 *  permit_application) so portal upload slots asking for the completed
 *  application can attach the real filled PDF. Disk-only — never triggers a
 *  build (step 3 builds; staging just uses what exists). First form wins per type. */
export function filledFormsByDocType(db: AppDb, projectId: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = path.join(FILLED_DIR, projectId);
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".pdf")); } catch { return out; }
  for (const f of files) {
    const formId = f.replace(/\.pdf$/, "");
    let docType = "permit_application";
    const tmpl = formId.startsWith("tmpl-")
      ? db.get<{ form_type?: string }>("SELECT form_type FROM ahj_form_templates WHERE id = ?", [formId.slice(5)])
      : null;
    if (tmpl?.form_type) docType = String(tmpl.form_type);
    else {
      const def = ahjFormRegistry.find((d) => d.id === formId);
      const name = (def?.formName || "").toLowerCase();
      if (/electrical/.test(name)) docType = "electrical_application";
      else if (/checklist|worksheet|eligibilit/.test(name)) docType = "solar_checklist";
      else if (/building|structural/.test(name)) docType = "building_application";
    }
    if (!out[docType]) out[docType] = path.join(dir, f);
  }
  return out;
}

export function filledFormPath(projectId: string, formId: string): string {
  // Guard against path traversal in the formId path segment.
  const safe = formId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(FILLED_DIR, projectId, `${safe}.pdf`);
}
