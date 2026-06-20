import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { ProjectRecord } from "../../shared/src/types";
import type { AppDb } from "./db";
import { clientStagingOverlay } from "./clients";
import { HttpError } from "./httpError";
import { nowIso } from "./time";

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
      // Job site information
      { source: "project.projectAddress", page: 0, x: 160, y: 614, maxWidth: 320 },
      { source: "computed.cityStateZip", page: 0, x: 115, y: 597, maxWidth: 300 },
      { source: "project.homeownerName", page: 0, x: 215, y: 581, maxWidth: 200 },
      // Description of work (open area below the label)
      { source: "computed.descriptionOfWork", page: 0, x: 35, y: 516, size: 8, maxWidth: 545 },
      // Property owner
      { source: "project.homeownerName", page: 0, x: 63, y: 455, maxWidth: 130 },
      { source: "snapshot.homeownerEmail", page: 0, x: 245, y: 455, maxWidth: 130 },
      { source: "project.projectAddress", page: 0, x: 75, y: 438, maxWidth: 480 },
      { source: "computed.cityStateZip", page: 0, x: 115, y: 421, maxWidth: 300 },
      { source: "snapshot.homeownerPhone", page: 0, x: 66, y: 404, maxWidth: 120 },
      // Contractor
      { source: "client.installerCompanyName", page: 0, x: 115, y: 342, maxWidth: 80 },
      { source: "client.installerEmail", page: 0, x: 245, y: 342, maxWidth: 130 },
      { source: "client.installerAddress", page: 0, x: 75, y: 325, maxWidth: 480 },
      { source: "client.installerPhone", page: 0, x: 66, y: 291, maxWidth: 120 },
      { source: "client.electricalLicenseNumber", page: 0, x: 100, y: 275, maxWidth: 90 },
      { source: "client.ccbLicenseNumber", page: 0, x: 267, y: 275, maxWidth: 120 },
      // Supervising electrician
      { source: "client.electricalSupervisorName", page: 0, x: 93, y: 225, maxWidth: 150 },
    ],
    notes: [
      "Flat PDF (no fillable fields) filled by coordinate overlay.",
      "Signatures (owner, supervising electrician, authorized) are intentionally left blank for a human to sign.",
      "Checkboxes for Type of work / Category of construction are left for human selection.",
    ],
  },
];

interface FillContext {
  project: ProjectRecord;
  client: Record<string, string>; // overlay keys (installerCompanyName, ccbLicenseNumber, ...)
  snapshot: Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function computed(name: string, ctx: FillContext): string {
  switch (name) {
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
    case "descriptionOfWork": {
      const s = ctx.snapshot;
      const qty = str(s["moduleQuantity"] ?? s["module_quantity"]);
      const model = str(s["moduleModel"] ?? s["module_model"]);
      const size = ctx.project.systemSizeDcKw ? `${ctx.project.systemSizeDcKw} kW DC` : "";
      const battery = str(s["batteryModel"] ?? s["battery_model"]);
      return [
        "Install roof-mounted photovoltaic solar system",
        qty && model ? `: ${qty}x ${model}` : "",
        size ? `, ${size}` : "",
        battery ? `, with ${battery} battery storage` : "",
        ".",
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

function buildContext(db: AppDb, project: ProjectRecord): FillContext {
  // Reuse the same client overlay the portal adapters get, so PDF and portal
  // stay consistent. portalType "" yields licensing fields without a specific
  // installer identity.
  const client = clientStagingOverlay(db, project.clientId, "");
  return {
    project,
    client,
    snapshot: (project.parserSnapshot ?? {}) as Record<string, unknown>,
  };
}

export function matchingForms(ahj: string): AhjFormDefinition[] {
  const needle = (ahj || "").toLowerCase();
  if (!needle) return [];
  return ahjFormRegistry.filter((def) => def.matchJurisdictions.some((m) => needle.includes(m)));
}

// Downloads and caches a form template; falls back to the cached copy when the
// network fetch fails (link rot is common on AHJ sites).
export async function fetchFormTemplate(def: AhjFormDefinition): Promise<Uint8Array> {
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
  const cachePath = path.join(TEMPLATE_DIR, `${def.id}.pdf`);

  try {
    const res = await fetch(def.sourceUrl, { redirect: "follow" });
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
  status: "filled" | "needs_manual" | "error";
  outputPath?: string;
  filledFieldCount?: number;
  unmappedRequested?: string[];
  message?: string;
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

  const doc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });

  // Overlay mode: flat PDF, draw text at coordinates.
  if (def.fillMode === "overlay") {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    let drawn = 0;
    for (const field of def.overlayFields ?? []) {
      const page = pages[field.page];
      if (!page) continue;
      let text = resolveSource(field.source, ctx);
      if (!text) continue;
      const size = field.size ?? 9;
      if (field.maxWidth) {
        while (text.length > 1 && font.widthOfTextAtSize(text, size) > field.maxWidth) {
          text = text.slice(0, -1);
        }
      }
      page.drawText(text, { x: field.x, y: field.y, size, font, color: rgb(0, 0, 0) });
      drawn += 1;
    }
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
      const checked = rule.equals != null ? value === rule.equals : Boolean(value);
      const box = form.getCheckBox(fieldName);
      if (checked) box.check(); else box.uncheck();
      filled += 1;
    } catch {
      unmapped.push(fieldName);
    }
  }

  // Flatten so the filled values are baked in and can't be edited in transit.
  try { form.flatten(); } catch { /* some forms can't flatten; leave as-is */ }

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
  const defs = matchingForms(project.ahj).filter((d) => d.status === "verified");
  const ctx = buildContext(db, project);
  const outDir = path.join(FILLED_DIR, project.id);

  const forms: FilledFormResult[] = [];
  for (const def of defs) {
    forms.push(await fillForm(def, ctx, path.join(outDir, `${def.id}.pdf`)));
  }

  return {
    projectId: project.id,
    ahj: project.ahj,
    generatedAt: nowIso(),
    forms,
    unmatched: defs.length === 0,
  };
}

export function filledFormPath(projectId: string, formId: string): string {
  // Guard against path traversal in the formId path segment.
  const safe = formId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(FILLED_DIR, projectId, `${safe}.pdf`);
}
