import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { AppDb } from "./db";
import type { AhjFormUrlResult, LLMProvider, ProjectRecord } from "../../shared/src/types";
import { inspectFormFields, loadStoredTemplates, type OverlayField, type SignaturePlacement } from "./ahjForms";
import { describePermitType, findApplicationProfile } from "./applicationDocs";
import { saveResearchedAhjProfile } from "./knowledgeBase";
import { renderPdfPageToPng } from "./pageImages";
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
  /** Coordinate placements (PDF points, bottom-left origin) for flat/scanned PDFs
   *  filled by vision-derived overlay. Used when fillMode === "overlay". */
  overlayFields?: OverlayField[];
  /** Vision-detected signature line placements (PDF points). The operator's
   *  stored signature for each role is stamped here at fill time. */
  signatureFields?: SignaturePlacement[];
  notes: string;
  /** sha256 of the blank PDF bytes — lets the periodic refresh detect when the
   *  AHJ has revised the form at its source URL. Set by storeAhjFormTemplate. */
  sourceHash?: string;
  /** ISO timestamp of the last source-URL freshness check. */
  lastCheckedAt?: string;
  /** Human-verified that the field/signature mapping is correct. Auto-maps start
   *  false; a real submit is gated until the operator previews and verifies. */
  verified?: boolean;
  verifiedAt?: string;
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// Fetch a URL and return the bytes only if it looks like a real PDF.
export async function fetchPdf(url: string): Promise<Uint8Array | null> {
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
  // AHJ has revised the form at its source URL. A fresh (re)mapping is always
  // UNVERIFIED — the operator must preview and verify before a real submit.
  input.map = { ...input.map, sourceHash: sha256(input.bytes), lastCheckedAt: now, verified: false, verifiedAt: undefined };
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

// Vision-map a FLAT (non-AcroForm) PDF: render each page to an image, ask the
// vision model where each value goes, and convert the normalized coordinates to
// PDF-point overlay placements (bottom-left origin) that fillLoadedForm draws.
// Computed once and stored, so later projects reuse it with no further LLM cost.
export async function buildOverlayMapForPdf(
  llm: LLMProvider,
  input: { ahj: string; state: string; formName: string; bytes: Uint8Array },
): Promise<{ overlayFields: OverlayField[]; signatureFields: SignaturePlacement[]; notes: string } | null> {
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
    availableSources: AVAILABLE_FIELD_SOURCES,
  });
  if (!mapped.fields.length && !mapped.signatures.length) return null;

  const overlayFields: OverlayField[] = mapped.fields.map((f) => {
    const sz = pageSizes[f.page] || pageSizes[0];
    return {
      source: f.source,
      page: f.page,
      x: Math.round(f.nx * sz.w),
      y: Math.round((1 - f.ny) * sz.h), // flip: ny is from top, PDF y from bottom
      size: f.size && f.size > 0 ? f.size : 9,
      ...(f.maxWidthFrac && f.maxWidthFrac > 0 ? { maxWidth: Math.round(f.maxWidthFrac * sz.w) } : {}),
    };
  });
  const signatureFields: SignaturePlacement[] = mapped.signatures.map((sg) => {
    const sz = pageSizes[sg.page] || pageSizes[0];
    const h = Math.round(sg.heightFrac * sz.h);
    const hasDate = sg.dateNx != null && sg.dateNy != null;
    return {
      role: sg.role,
      page: sg.page,
      x: Math.round(sg.nx * sz.w),
      // ny marks the bottom-left corner from the top; flip and subtract the box
      // height so the image sits just above the printed line.
      y: Math.round((1 - sg.ny) * sz.h - h),
      width: Math.round(sg.widthFrac * sz.w),
      height: h,
      label: sg.label,
      ...(hasDate ? { dateX: Math.round(sg.dateNx! * sz.w), dateY: Math.round((1 - sg.dateNy!) * sz.h), dateSize: 9 } : {}),
    };
  });
  return { overlayFields, signatureFields, notes: mapped.notes };
}

export interface EnsureFormResult {
  status: "exists" | "acquired" | "needs_manual" | "not_found";
  message: string;
  formName?: string;
  sourceUrl?: string;
  mappedFields?: number;
  /** Human callout of the permit TYPE for this AHJ (combo vs separate BLD/ELE, submission method). */
  permitType?: string;
}

// Normalize the model's free-text platform label to a canonical platform + method.
function canonicalPortal(research: AhjFormUrlResult): { platform: string; method: string } {
  const blob = `${research.portalPlatform || ""} ${research.submissionMethod || ""} ${research.notes || ""}`.toLowerCase();
  if (/projectdox|avolve/.test(blob)) return { platform: "ProjectDox", method: "online portal" };
  if (/portland.*(portal|hub|devhub|development hub)/.test(blob)) return { platform: "Portland Portal", method: "online portal" };
  if (/epermitting|accela|oregon.*permit/.test(blob)) return { platform: "Oregon ePermitting", method: "online portal" };
  if (/email/.test(blob)) return { platform: "Email", method: "email" };
  return { platform: research.portalPlatform || "", method: research.submissionMethod || "" };
}

// Persist the discovered submittal portal/platform/requirements so the record-portal
// training step pre-fills the portal URL for a new AHJ and future projects reuse it.
function learnAhjPortalFromResearch(db: AppDb, project: ProjectRecord, research: AhjFormUrlResult): void {
  if (!project.ahj || !project.state) return;
  const { platform, method } = canonicalPortal(research);
  if (!platform && !method && !research.submittalPortalUrl && !research.formsPageUrl) return;
  const notes = [
    research.submittalRequirements ? `Submittal requirements: ${research.submittalRequirements}` : "",
    research.formsPageUrl ? `Forms page: ${research.formsPageUrl}` : "",
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
    });
  } catch { /* non-fatal */ }
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

  // Check if the AHJ is known to be online-only (e-permitting portal). These
  // AHJs don't distribute a standalone PDF — the application is entered directly
  // in their portal. Skip the web search to save time and cost.
  const ahjProfile = findApplicationProfile(project);
  if (ahjProfile.requiresPortalEntryOnly) {
    const pt = describePermitType(ahjProfile);
    return {
      status: "not_found",
      permitType: pt.callout,
      message: `Permitting type: ${pt.callout} ${project.ahj} is an online-only portal — there is no standalone PDF to download. Enter the application directly in the portal. No PDF template needed.`,
    };
  }

  const research = await llm.findAhjFormUrl({ ahj: project.ahj, state: project.state, formType });

  // Learn the submittal portal/platform/requirements so the record-portal training
  // step pre-fills the portal URL for this new AHJ, and future projects skip the
  // search. Runs whether or not a fillable PDF was found.
  learnAhjPortalFromResearch(db, project, research);

  // Always determine + surface the permit TYPE (combo vs separate BLD/ELE, and how
  // it's submitted), folding in what the search just learned — so even when no PDF
  // is found the operator is told what kind of permitting this AHJ uses.
  const permitType = describePermitType(ahjProfile, { submissionMethod: research.submissionMethod, portalPlatform: research.portalPlatform, permitStructure: research.permitStructure });

  if (!research.candidateUrls.length) {
    const portalNote = research.submittalPortalUrl
      ? ` Submittal portal: ${research.submittalPortalUrl}${research.portalPlatform ? ` (${research.portalPlatform})` : ""} — it's pre-filled on the record/training step.`
      : "";
    const reqNote = research.submittalRequirements ? ` Requirements: ${research.submittalRequirements}` : "";
    return {
      status: "not_found",
      permitType: permitType.callout,
      message: `Permitting type: ${permitType.callout}${research.notes ? ` ${research.notes}` : ` No downloadable PDF form was found for ${project.ahj} — submit through the method above.`}${portalNote}${reqNote}`,
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
      permitType: permitType.callout,
      message: `Permitting type: ${permitType.callout} Found candidate links for ${project.ahj} but none returned a valid PDF (link rot or login-gated). Upload the blank PDF to proceed. Tried: ${research.candidateUrls.join(", ")}`,
    };
  }

  const formName = research.formName || `${project.ahj} ${formType.replace(/_/g, " ")}`;
  const acquired = await acquireFromBytes(db, llm, { ahj: project.ahj, state: project.state, formType, formName, bytes, sourceUrl: usedUrl });
  return { ...acquired, permitType: permitType.callout };
}

// Shared acquisition: map a downloaded/uploaded blank PDF (AcroForm first, then
// vision overlay for flat/scanned), store it, and report what happened.
export async function acquireFromBytes(
  db: AppDb,
  llm: LLMProvider,
  input: { ahj: string; state: string; formType: string; formName: string; bytes: Uint8Array; sourceUrl: string },
): Promise<EnsureFormResult> {
  const { ahj, state, formType, formName, bytes, sourceUrl } = input;

  // A single vision pass locates signature lines (and, for flat forms, the data
  // placements). Reused across both branches so signatures are detected once.
  const overlay = await buildOverlayMapForPdf(llm, { ahj, state, formName, bytes });
  const signatureFields = overlay?.signatureFields || [];

  const acro = await buildFieldMapForPdf(llm, { ahj, state, formName, bytes });
  if (acro) {
    storeAhjFormTemplate(db, {
      ahjName: ahj, state, formType, filename: `${formName}.pdf`, bytes,
      map: { formName, sourceUrl, fillMode: "acroform", textFields: acro.textFields, checkboxes: acro.checkboxes, signatureFields, notes: acro.notes },
    });
    const count = Object.keys(acro.textFields).length + Object.keys(acro.checkboxes).length;
    return { status: "acquired", message: `Acquired and mapped ${formName} (${count} field(s) of ${acro.fieldCount}${signatureFields.length ? `, ${signatureFields.length} signature line(s)` : ""}). It will be auto-filled for ${ahj}.`, formName, sourceUrl, mappedFields: count };
  }

  // No AcroForm fields — flat/scanned. Use the vision overlay placements.
  if (overlay && overlay.overlayFields.length) {
    storeAhjFormTemplate(db, {
      ahjName: ahj, state, formType, filename: `${formName}.pdf`, bytes,
      map: { formName, sourceUrl, fillMode: "overlay", textFields: {}, checkboxes: {}, overlayFields: overlay.overlayFields, signatureFields, notes: `Vision-mapped flat form (${overlay.overlayFields.length} placements, ${signatureFields.length} signature line(s)). ${overlay.notes} VERIFY the filled PDF — coordinate placement is approximate; re-map if anything is off.` },
    });
    return { status: "acquired", message: `Acquired ${formName} (flat PDF) and vision-mapped ${overlay.overlayFields.length} placement(s)${signatureFields.length ? ` + ${signatureFields.length} signature line(s)` : ""}. Verify the filled output and re-map if needed.`, formName, sourceUrl, mappedFields: overlay.overlayFields.length };
  }

  // No data fields, but signatures alone are still useful (signs the blank).
  if (signatureFields.length) {
    storeAhjFormTemplate(db, {
      ahjName: ahj, state, formType, filename: `${formName}.pdf`, bytes,
      map: { formName, sourceUrl, fillMode: "overlay", textFields: {}, checkboxes: {}, signatureFields, notes: `No fillable data fields, but ${signatureFields.length} signature line(s) detected. The blank is stored; your signature will be stamped. Fill the rest by hand.` },
    });
    return { status: "acquired", message: `Stored ${formName} with ${signatureFields.length} signature line(s) mapped. Data fields must be filled by hand.`, formName, sourceUrl, mappedFields: signatureFields.length };
  }

  // Couldn't map anything — store the legit blank for manual completion.
  storeAhjFormTemplate(db, {
    ahjName: ahj, state, formType, filename: `${formName}.pdf`, bytes,
    map: { formName, sourceUrl, fillMode: "overlay", textFields: {}, checkboxes: {}, notes: "Flat/scanned PDF — vision mapping found no placeable fields. Stored as the blank for manual completion." },
  });
  return { status: "needs_manual", message: `Stored the official ${formName}, but it couldn't be auto-mapped. It's saved as the blank for manual completion.`, formName, sourceUrl, mappedFields: 0 };
}
