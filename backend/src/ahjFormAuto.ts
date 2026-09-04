import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { AppDb } from "./db";
import type { AhjFormUrlResult, LLMProvider, ProjectRecord } from "../../shared/src/types";
import { inspectFormFields, loadStoredTemplates, type OverlayField, type SignaturePlacement } from "./ahjForms";
import { describePermitType, findApplicationProfile } from "./applicationDocs";
import { saveResearchedAhjProfile, knowledgeResearchHint, findKnowledgeForLearn } from "./knowledgeBase";
import { findAhjProcessProfile } from "./processProfiles";
import { renderPdfPageToPng } from "./pageImages";
import { prescriptiveCriterionCatalog } from "./permitPath";
import { nowIso } from "./time";

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
  // Print-name lines under signatures. These resolvers existed in the fill path
  // but were never OFFERED to the mapper, so every "Print name" blank on every
  // auto-mapped form stayed empty (caught on the live Coos Bay building permit).
  'computed.applicantSignerName  (typed name of the applicant/agent signer — for "Print name" lines under the authorized signature)',
  'computed.electricianSignerName  (typed name of the electrician signer — for "Print name" next to the electrician signature)',
  ...STRUCTURAL_VALUE_SOURCES,
  ...EXISTING_SYSTEM_SOURCES,
  ...PRESCRIPTIVE_SOURCES,
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

// Classify a downloaded PDF into a form_type from its name/URL, so one research
// pass that surfaces the building app + electrical app + checklist stores each
// under its own slot instead of overwriting a single "permit_application" row.
export function classifyFormType(nameOrUrl: string, fallback: string): string {
  const t = (nameOrUrl || "").toLowerCase();
  if (/checklist|worksheet|eligibilit/.test(t)) return "solar_checklist";
  if (/electrical|ele[-_ ]?permit/.test(t)) return "electrical_application";
  if (/building|structural|bld[-_ ]?permit/.test(t)) return "building_application";
  return fallback;
}

// Does this AHJ already have a stored template of THIS form type? (Same fuzzy
// name containment as loadStoredTemplates, narrowed by form_type.)
export function hasStoredTemplateOfType(db: AppDb, ahj: string, state: string, formType: string): boolean {
  const needle = (ahj || "").trim().toLowerCase();
  if (!needle) return false;
  const rows = db.query<{ ahj_name: string; state: string }>(
    "SELECT ahj_name, state FROM ahj_form_templates WHERE pdf_blob IS NOT NULL AND form_type = ?",
    [formType],
  );
  return rows.some((row) => {
    const rowAhj = String(row.ahj_name || "").trim().toLowerCase();
    const stateOk = !row.state || !state || String(row.state).toLowerCase() === String(state).toLowerCase();
    return Boolean(rowAhj) && stateOk && (rowAhj === needle || needle.includes(rowAhj) || rowAhj.includes(needle));
  });
}

/** The full set of forms this AHJ needs for a residential solar submission —
 *  the main application(s) plus any required checklist — acquired in one pass.
 *  Sources for "what's needed": the AHJ process profile flags and the KB's
 *  imported required-documents list. Each acquisition stores + learns, so the
 *  next project under this AHJ skips the research entirely. */
export async function ensureAhjFormsForProject(
  db: AppDb,
  llm: LLMProvider,
  project: ProjectRecord,
): Promise<{ neededTypes: string[]; results: Array<EnsureFormResult & { formType: string }> }> {
  const needed = new Set<string>(["permit_application"]);
  try {
    const proc = findAhjProcessProfile(project);
    if (proc?.requiresSolarChecklist) needed.add("solar_checklist");
  } catch { /* profile data optional */ }
  try {
    const kb = findKnowledgeForLearn(db, { state: project.state, ahj: project.ahj, utility: project.utility });
    if ((kb.ahj?.requiredDocuments || []).some((d) => /checklist|worksheet/i.test(d))) needed.add("solar_checklist");
  } catch { /* KB optional */ }
  const results: Array<EnsureFormResult & { formType: string }> = [];
  for (const formType of needed) {
    results.push({ formType, ...(await ensureAhjFormTemplate(db, llm, project, formType)) });
  }
  return { neededTypes: [...needed], results };
}

// Ensure the AHJ has a usable stored form. Research → download → map → store.
export async function ensureAhjFormTemplate(
  db: AppDb,
  llm: LLMProvider,
  project: ProjectRecord,
  formType = "permit_application",
): Promise<EnsureFormResult> {
  // Already have a fillable stored template of THIS form type for this AHJ?
  // (Per-type, so acquiring the checklist isn't skipped just because the
  // permit application is already stored.)
  if (hasStoredTemplateOfType(db, project.ahj, project.state, formType)) {
    return { status: "exists", message: `A stored ${formType.replace(/_/g, " ")} template already exists for this AHJ.` };
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

  // Seed the form search with whatever the KB already knows about this AHJ
  // (imported reference rows: portal, submission notes, any direct .pdf links).
  // The hint steers the web search; KB .pdf URLs become free download candidates.
  let kbHint: ReturnType<typeof knowledgeResearchHint> = null;
  try { kbHint = knowledgeResearchHint(db, { state: project.state, ahj: project.ahj }, "ahj"); } catch { /* non-fatal */ }

  const research = await llm.findAhjFormUrl({ ahj: project.ahj, state: project.state, formType, knownContext: kbHint?.text });

  // Learn the submittal portal/platform/requirements so the record-portal training
  // step pre-fills the portal URL for this new AHJ, and future projects skip the
  // search. Runs whether or not a fillable PDF was found.
  learnAhjPortalFromResearch(db, project, research);

  // Always determine + surface the permit TYPE (combo vs separate BLD/ELE, and how
  // it's submitted), folding in what the search just learned — so even when no PDF
  // is found the operator is told what kind of permitting this AHJ uses.
  const permitType = describePermitType(ahjProfile, { submissionMethod: research.submissionMethod, portalPlatform: research.portalPlatform, permitStructure: research.permitStructure });

  // Research candidates first (freshest), then any direct .pdf links carried by
  // the imported KB row — a spreadsheet-provided application link can rescue an
  // AHJ whose site the search couldn't crack (link may also just be stale).
  const candidateUrls = [...new Set([...research.candidateUrls, ...(kbHint?.pdfUrls || [])])];

  if (!candidateUrls.length) {
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

  // Download EVERY distinct blank the research surfaced (building app +
  // electrical app + checklist often live as separate PDFs on one forms page),
  // classify each by name/URL, and store each under its own form_type slot.
  // Everything acquired is stored + learned, so the next project under this
  // AHJ skips the search entirely.
  const downloads: Array<{ url: string; bytes: Uint8Array; type: string }> = [];
  const seenHashes = new Set<string>();
  const storedTypes = new Set<string>();
  for (const url of candidateUrls) {
    if (downloads.length >= 4) break;
    const bytes = await fetchPdf(url);
    if (!bytes) continue;
    const hash = sha256(bytes);
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    const type = downloads.length === 0 ? formType : classifyFormType(`${url} ${research.formName || ""}`, formType);
    downloads.push({ url, bytes, type });
  }
  if (!downloads.length) {
    return {
      status: "not_found",
      permitType: permitType.callout,
      message: `Permitting type: ${permitType.callout} Found candidate links for ${project.ahj} but none returned a valid PDF (link rot or login-gated). Upload the blank PDF to proceed. Tried: ${candidateUrls.join(", ")}`,
    };
  }

  let primary: EnsureFormResult | null = null;
  const extraMessages: string[] = [];
  for (const dl of downloads) {
    // One template per (ahj, form_type): don't overwrite a slot this pass
    // already filled, and don't re-store a type that already exists.
    const type = storedTypes.has(dl.type) || (dl.type !== formType && hasStoredTemplateOfType(db, project.ahj, project.state, dl.type)) ? "" : dl.type;
    if (!type) continue;
    storedTypes.add(type);
    const formName = type === formType && research.formName
      ? research.formName
      : `${project.ahj} ${type.replace(/_/g, " ")}`;
    const acquired = await acquireFromBytes(db, llm, { ahj: project.ahj, state: project.state, formType: type, formName, bytes: dl.bytes, sourceUrl: dl.url });
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
