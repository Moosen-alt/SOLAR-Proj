import crypto from "node:crypto";
import type { AppDb } from "./db";
import type { LLMProvider, ProjectRecord } from "../../shared/src/types";
import { inspectFormFields, loadStoredTemplates } from "./ahjForms";
import { nowIso } from "./time";

// ---------------------------------------------------------------------------
// Auto-acquire an AHJ's official permit PDF form: web-research the URL, download
// the blank PDF, map its AcroForm fields to project data, and store it so every
// future project under that AHJ gets the real filled form. Operator upload is
// the fallback when no form can be found (see /api/ahj-templates/upload).
// ---------------------------------------------------------------------------

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
  "client.ccbLicenseNumber",
  "computed.fullAddress",
  "computed.cityStateZip",
  "computed.systemSize",
  "computed.systemSizeDcKw",
  "computed.descriptionOfWork",
  'lit:X  (literal — use for fixed checkbox marks / constant text like "lit:Solar")',
];

export interface StoredFieldMap {
  formName: string;
  sourceUrl: string;
  fillMode: "acroform" | "overlay";
  textFields: Record<string, string>;
  checkboxes: Record<string, { source: string; equals?: string }>;
  notes: string;
  /** sha256 of the blank PDF bytes — lets the periodic refresh detect when the
   *  AHJ has revised the form at its source URL. Set by storeAhjFormTemplate. */
  sourceHash?: string;
  /** ISO timestamp of the last source-URL freshness check. */
  lastCheckedAt?: string;
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// Fetch a URL and return the bytes only if it looks like a real PDF.
async function fetchPdf(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const type = res.headers.get("content-type") || "";
    // %PDF magic, or a pdf content-type. Guard against HTML error pages.
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return buf;
    if (type.includes("pdf") && buf.length > 1000) return buf;
    return null;
  } catch {
    return null;
  }
}

// Insert or replace a stored AHJ form template. Dedupes on (ahj_name, state, form_type).
export function storeAhjFormTemplate(
  db: AppDb,
  input: { ahjName: string; state: string; formType: string; filename: string; bytes: Uint8Array; map: StoredFieldMap },
): string {
  const now = nowIso();
  const blob = Buffer.from(input.bytes);
  // Stamp the content hash + check time so the periodic refresh can tell when the
  // AHJ has revised the form at its source URL.
  input.map = { ...input.map, sourceHash: sha256(input.bytes), lastCheckedAt: now };
  const existing = db.get<{ id: string }>(
    "SELECT id FROM ahj_form_templates WHERE lower(ahj_name) = lower(?) AND lower(state) = lower(?) AND form_type = ? LIMIT 1",
    [input.ahjName, input.state, input.formType],
  );
  if (existing) {
    db.run(
      "UPDATE ahj_form_templates SET original_filename = ?, pdf_blob = ?, field_map = ?, updated_at = ? WHERE id = ?",
      [input.filename, blob, JSON.stringify(input.map), now, existing.id],
    );
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO ahj_form_templates (id, ahj_name, state, form_type, original_filename, pdf_blob, moat_data, field_map, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, '', ?, ?)`,
    [id, input.ahjName, input.state, input.formType, input.filename, blob, JSON.stringify(input.map), now, now],
  );
  return id;
}

// Build the field map for a blank PDF's bytes using its AcroForm fields. Returns
// null when the PDF has no fillable fields (flat/scanned/XFA) — those can't be
// auto-filled without coordinate overlays and are routed to a human.
export async function buildFieldMapForPdf(
  llm: LLMProvider,
  input: { ahj: string; state: string; formName: string; bytes: Uint8Array },
): Promise<{ textFields: Record<string, string>; checkboxes: Record<string, { source: string; equals?: string }>; notes: string; fieldCount: number } | null> {
  const inspected = await inspectFormFields(input.bytes);
  if (inspected.isXfa || inspected.fields.length === 0) return null;
  const mapped = await llm.mapAcroFormFields({
    ahj: input.ahj,
    state: input.state,
    formName: input.formName,
    fields: inspected.fields,
    availableSources: AVAILABLE_FIELD_SOURCES,
  });
  return { textFields: mapped.textFields, checkboxes: mapped.checkboxes, notes: mapped.notes, fieldCount: inspected.fields.length };
}

export interface EnsureFormResult {
  status: "exists" | "acquired" | "needs_manual" | "not_found";
  message: string;
  formName?: string;
  sourceUrl?: string;
  mappedFields?: number;
}

// Ensure the AHJ has a usable stored form. Research → download → map → store.
export async function ensureAhjFormTemplate(
  db: AppDb,
  llm: LLMProvider,
  project: ProjectRecord,
  formType = "permit_application",
): Promise<EnsureFormResult> {
  // Already have a fillable stored template for this AHJ? Nothing to do.
  if (loadStoredTemplates(db, project.ahj, project.state).length > 0) {
    return { status: "exists", message: "A stored form template already exists for this AHJ." };
  }

  const research = await llm.findAhjFormUrl({ ahj: project.ahj, state: project.state, formType });
  if (!research.candidateUrls.length) {
    return {
      status: "not_found",
      message: research.notes || `No official PDF form was found for ${project.ahj}. It may submit online only — upload the blank PDF if one exists.`,
    };
  }

  let bytes: Uint8Array | null = null;
  let usedUrl = "";
  for (const url of research.candidateUrls) {
    bytes = await fetchPdf(url);
    if (bytes) { usedUrl = url; break; }
  }
  if (!bytes) {
    return {
      status: "not_found",
      message: `Found candidate links for ${project.ahj} but none returned a valid PDF (link rot or login-gated). Upload the blank PDF to proceed. Tried: ${research.candidateUrls.join(", ")}`,
    };
  }

  const formName = research.formName || `${project.ahj} ${formType.replace(/_/g, " ")}`;
  const map = await buildFieldMapForPdf(llm, { ahj: project.ahj, state: project.state, formName, bytes });
  if (!map) {
    // Store the legit blank so the operator at least has the official form, but
    // it has no AcroForm fields to auto-fill (flat/scanned/XFA) — human fills it.
    storeAhjFormTemplate(db, {
      ahjName: project.ahj, state: project.state, formType,
      filename: `${formName}.pdf`, bytes,
      map: { formName, sourceUrl: usedUrl, fillMode: "overlay", textFields: {}, checkboxes: {}, notes: "Flat/scanned/XFA PDF — no fillable fields. Downloaded for manual completion." },
    });
    return { status: "needs_manual", message: `Downloaded the official ${formName}, but it has no fillable fields (flat/scanned). It's stored as the blank form for manual completion.`, formName, sourceUrl: usedUrl, mappedFields: 0 };
  }

  storeAhjFormTemplate(db, {
    ahjName: project.ahj, state: project.state, formType,
    filename: `${formName}.pdf`, bytes,
    map: { formName, sourceUrl: usedUrl, fillMode: "acroform", textFields: map.textFields, checkboxes: map.checkboxes, notes: map.notes },
  });
  const count = Object.keys(map.textFields).length + Object.keys(map.checkboxes).length;
  return { status: "acquired", message: `Acquired and mapped ${formName} (${count} field(s) mapped of ${map.fieldCount}). It will be auto-filled for projects in ${project.ahj}.`, formName, sourceUrl: usedUrl, mappedFields: count };
}
