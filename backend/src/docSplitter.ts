import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { PDFDocument } from "pdf-lib";
import { extractPdfPages } from "./batchImport";
import { portalUploadCapBytes } from "../../portal-bot/src/uploadCap";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { saveProjectDocument, listProjectDocuments, projectDocsByType, documentTypesDeletedSince } from "./projectDocuments";

// Sheet/content patterns → upload doc category. Ported from the parser's detectSplitPages;
// pages are scored against each category and assigned to the best match. The categories are
// the files an AHJ/utility upload package needs.
//
// Real plan sets identify each sheet by the Sheet Name spelled out in the title block —
// present as extractable text even when the body of the sheet is an image (equipment
// cut-sheets, spec sheets). So we match the sheet-name text, and a single page may satisfy
// MORE THAN ONE category (e.g. Infinity's "PV MODULE / INV SPECIFICATION SHEET" is both the
// module spec and the inverter spec). The general-notes / sheet-index page lists every sheet
// name, so it would match everything — it is detected and skipped before classification.
//
// `vocabulary` patterns are words a sheet USES rather than the sheet's NAME, and together they
// count as at most ONE hit. The roof words (RAFTER / TRUSS / ROOF SECTION) are the case: the
// site plan's roof legend ("= RAFTER"), its "ROOF SECTION(S)" block and a "TRUSS SIZE &
// SPACING" note carry all three, so as full patterns they out-scored SITE PLAN + PV 1.0 (3 to 2)
// and the winner-take-all below filed the site plan as structural — no site_plan part was
// written and the submit gate owed a sheet the plan set contained (#29). A real structural
// sheet still wins on its name (MOUNT/ATTACHMENT DETAIL, S 1.x, STRUCTURAL).
//
// `words` are full hits on most pages, but on an ELECTRICAL sheet (an E x.x sheet number) they —
// and the vocabulary — are words the sheet uses, not its name, and do not count. The electrical
// NOTES sheet (E 1.2) carries a "STRUCTURAL NOTES" block (design loads, rafter spacing, truss
// capacity); the bare STRUCTURAL plus that vocabulary scored it structural, and with no
// electrical category naming E 1.2 it was filed into the structural upload (#33). On an E sheet
// only a structural sheet NAME (MOUNT/ATTACHMENT DETAIL, S 1.x) pulls it into structural;
// otherwise it stays in its named category or unclassified.
const ELECTRICAL_SHEET = /\bE\s*-?\s*\d+\.\d+\b/i;
const CATEGORY_PATTERNS: Array<{ docType: string; label: string; patterns: RegExp[]; words?: RegExp[]; vocabulary?: RegExp[] }> = [
  // "ELECTRICAL LINE DIAGRAM" is how the Basson-style sets title their SLD (sheet PV-6) —
  // neither "one-line" nor "3-line" appears anywhere on the sheet, so the whole electrical
  // diagram went unsplit and the submit gate reported the SLD missing from a plan set that
  // plainly contains one. Anchored on LINE DIAGRAM with an electrical qualifier; a bare
  // /LINE DIAGRAM/ is deliberately NOT used ("property line", "setback line" prose risk).
  { docType: "sld", label: "SLD / one-line", patterns: [/\b3-?LINE DIAGRAM\b/i, /\bONE-?LINE\b/i, /\bSINGLE-?LINE\b/i, /\bELECTRICAL\s+LINE\s+DIAGRAM\b/i, /\bE\s*1\.1\b/i] },
  // Fire access pathways / setbacks are drawn and labeled on the site plan (the fire-access
  // sheet the gate asks for), so they identify it alongside the sheet name.
  { docType: "site_plan", label: "Site / plot plan", patterns: [/\bSITE PLAN\b/i, /\bPLOT PLAN\b/i, /\bPV\s*1\.[01]\b/i, /\bFIRE\s+(?:PATHWAYS?|SETBACKS?|ACCESS)\b/i] },
  { docType: "structural", label: "Structural / roof framing", patterns: [/\bMOUNT DETAIL\b/i, /\bATTACHMENT DETAIL\b/i, /\bS\s*1\.\d\b/i], words: [/STRUCTURAL/i], vocabulary: [/\bROOF SECTION\b/i, /\bRAFTER\b/i, /\bTRUSS\b/i] },
  // Match the dedicated SPEC SHEET by its title-block Sheet Name only. Model strings
  // (Q.TRON, Q.MI) and the word "PV MODULE" appear in the spec-callout block on the site
  // plan, SLD, etc., so they are NOT reliable — only the sheet name "… SPEC(IFICATION) SHEET"
  // identifies the actual cut-sheet page. The combined "MODULE / INV SPECIFICATION SHEET"
  // counts as BOTH module and inverter spec.
  //
  // The single-equipment names REQUIRE the word SHEET (#66). "INVERTER SPECIFICATIONS" and
  // "PV MODULE SPECIFICATIONS" are also the headings of the spec TABLES in a WIRING
  // CALCULATIONS sheet's body; as patterns they were that calcs sheet's only hit, so
  // winner-take-all had nothing to rescue it with and it shipped as the inverter spec.
  //
  // "EQUIPMENT SPECIFICATION(S)" is deliberately NOT a pattern here (#66). Those pages (Basson
  // PV-11+) are image cut-sheets whose only text is the title block, and the section holds the
  // module, the combiner, the racking brochure… all with the same text. Filing them as
  // module_spec (and "counting as both") put a combiner and a racking brochure in the spec parts
  // with no way to tell. They are reported as undecided instead (EQUIPMENT_SPEC_SHEET below).
  { docType: "module_spec", label: "Module spec", patterns: [/MODULE\s*[\/&]?\s*INV(?:ERTER)?\.?\s*SPEC/i, /MODULE\s+SPECIFICATION\s+SHEET/i, /\bPV\s+MODULE\s+SPEC(?:IFICATION)?S?\s+SHEETS?\b/i] },
  // NOTE: do NOT match on the UL listing standard (/UL 1741/) — that number is cited on the
  // SLD, general notes, and most electrical sheets, so it pulled those dense pages into the
  // inverter_spec split and bloated it past PowerClerk's 5 MB upload limit. Match the dedicated
  // SPEC SHEET by its title-block name only, per this file's stated discipline.
  { docType: "inverter_spec", label: "Inverter spec", patterns: [/MODULE\s*[\/&]?\s*INV(?:ERTER)?\.?\s*SPEC/i, /MICRO-?INVERTERS?\s+SPEC(?:IFICATION)?S?\s+SHEETS?\b/i, /\bINVERTERS?\s+SPEC(?:IFICATION)?S?\s+SHEETS?\b/i] },
  { docType: "labels", label: "Labels / placards", patterns: [/\bWARNING LABELS\b/i, /\bLABEL LOCATION\b/i, /\bE\s*1\.3\b/i] },
];

// A title-block "EQUIPMENT SPECIFICATION" sheet: a cut-sheet whose equipment its text does not
// name. When no category claims such a page it is reported in `undecidedSpecPages` — the split
// says it could not tell the module datasheet from the combiner or racking brochure rather than
// guessing one into a spec part (#66).
const EQUIPMENT_SPEC_SHEET = /\bEQUIPMENT\s+SPECIFICATIONS?\b/i;

// The general-notes / sheet-index cover page lists every sheet name and would otherwise
// match every category. It is never an uploadable single-category doc, so skip it.
function isIndexOrNotesPage(text: string): boolean {
  return /SHEET INDEX/i.test(text) || /GENERAL NOTES AND PROJECT DATA/i.test(text);
}

// Assign a page to its SINGLE best-matching category (most pattern hits wins), the original
// winner-take-all discipline. Returning EVERY matching category instead let a dense SLD page
// that merely cites "INVERTER SPECIFICATIONS" / "UL 1741" in a callout block leak into the
// inverter_spec split alongside the real cut-sheet — several heavy pages per category, which
// blew the per-file size past PowerClerk's 5 MB upload limit (every required upload failed).
//
// The one legitimate multi-category case is preserved explicitly: a COMBINED
// "MODULE / INV SPECIFICATION SHEET" genuinely IS both the module spec and the inverter spec,
// so that single sheet is added to both — and nothing else fans out.
function classifyPage(text: string): string[] {
  if (isIndexOrNotesPage(text)) return [];
  const electricalSheet = ELECTRICAL_SHEET.test(text);
  let best: { docType: string; score: number } | null = null;
  for (const cat of CATEGORY_PATTERNS) {
    const hits = (res: RegExp[] | undefined) => (res ?? []).reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
    const score = hits(cat.patterns)
      + (electricalSheet ? 0 : hits(cat.words) + (cat.vocabulary?.some((re) => re.test(text)) ? 1 : 0));
    if (score > 0 && (!best || score > best.score)) best = { docType: cat.docType, score };
  }
  if (!best) return [];
  const out = [best.docType];
  if (/MODULE\s*[\/&]?\s*INV(?:ERTER)?\.?\s*SPEC/i.test(text)) {
    if (!out.includes("module_spec")) out.push("module_spec");
    if (!out.includes("inverter_spec")) out.push("inverter_spec");
  }
  return out;
}

// Which documents each submission TYPE needs in its upload package. The package is
// assembled from project_documents of these types — split sheets AND separately-uploaded
// files (e.g. the meter photo, which is never in the plan set). Extend as new portals
// surface their needs; eventually this can be driven by the learned KB requiredDocuments.
//
// SLD splitting is only needed for two cases:
//   • utility NEM submittals (nem) — utility portals want the SLD, site plan, and inverter
//     spec as separate files alongside the meter photo.
//   • ProjectDox/permit AHJ submittals (permit) — ProjectDox requires each sheet uploaded
//     to its own document slot. Standard Accela/EnerGov portals receive the FULL plan set
//     as a single PDF (no splitting needed there).
const PACKAGE_SETS: Record<string, string[]> = {
  // Utility NEM/interconnection upload set (PGE PowerClerk, Pacific Power, etc.).
  // Meter photo is uploaded separately and never in the plan set.
  nem: ["meter_photo", "sld", "site_plan", "inverter_spec"],
  // ProjectDox AHJ permit upload set — each sheet in its own slot.
  permit: ["sld", "site_plan", "structural", "structural_letter", "module_spec", "inverter_spec", "labels"],
  // Everything we could split/attach — for debug or portals with no defined set yet.
  all: ["sld", "site_plan", "structural", "structural_letter", "module_spec", "inverter_spec", "labels", "meter_photo", "utility_bill"],
};

// Doc types packaged WHEN PRESENT but never reported as missing. The sealed structural
// letter is only required for some projects (engineered path, or a jurisdiction stamp
// threshold) and requiredDocuments() is the single authority on which — duplicating that
// rule here would give two places to keep in sync and would flag every clean prescriptive
// job as incomplete. What this set fixes is the other half: before, "structural_letter"
// was absent from PACKAGE_SETS entirely, so a stamped letter the operator had uploaded
// was silently left out of the AHJ package.
const CONDITIONAL_PACKAGE_DOC_TYPES = new Set(["structural_letter", "utility_bill"]);

export interface UtilityPackageResult {
  target: string;
  planSetDocId: string;
  pages: number;
  parts: Array<{ docType: string; label: string; pages: number[]; documentId: string }>;
  packagedDocTypes: string[];
  missingDocTypes: string[];
  zipDocumentId: string;
  unclassifiedPages: number[];
  /** Plan-set sheet types this target wanted that no page classified as — the split log names
   *  them, so a sheet the classifier missed is visible where the split ran, not only later as a
   *  gate's "missing" (#29). Never includes separately-uploaded types (meter photo, bill). */
  missingSheetTypes: string[];
  /** 1-based pages titled "EQUIPMENT SPECIFICATION" that no category claimed: image cut-sheets
   *  whose text is only the title block, so module / inverter / combiner / racking cannot be told
   *  apart (#66). Never filed into a spec part; a person (or a vision read) decides. */
  undecidedSpecPages: number[];
}

// Find the project's stored plan set (doc_type plan_set, else the largest PDF upload).
function findPlanSet(db: AppDb, projectId: string): { id: string; path: string; name: string } {
  const docs = listProjectDocuments(db, projectId);
  const planSet = docs.find((d) => d.docType === "plan_set") ?? docs.find((d) => /\.pdf$/i.test(d.originalFilename));
  if (!planSet) throw new HttpError(400, "No plan-set PDF uploaded for this project. Upload the plan set (doc type: plan_set) first.");
  const row = db.get<{ stored_path: string }>("SELECT stored_path FROM project_documents WHERE id = ?", [planSet.id]);
  const stored = row?.stored_path ?? "";
  if (!stored || !fs.existsSync(stored)) throw new HttpError(404, "Plan-set file is missing on disk.");
  return { id: planSet.id, path: stored, name: planSet.originalFilename || "plan-set.pdf" };
}

// Split the uploaded plan set into individual sheets, then assemble the upload ZIP for
// the requested submission TYPE (nem | permit | all) — pulling split sheets AND separately
// uploaded docs (meter photo, utility bill). Backend equivalent of the parser's splitter,
// run in the submission slot; the bot then attaches these by doc_type.
export async function buildUtilityPackage(db: AppDb, projectId: string, target = "all"): Promise<UtilityPackageResult> {
  const project = db.get<{ id: string }>("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!project) throw new HttpError(404, "Project not found.");
  const wanted = PACKAGE_SETS[target] ?? PACKAGE_SETS.all;
  const planSet = findPlanSet(db, projectId);

  const source = await PDFDocument.load(fs.readFileSync(planSet.path));
  const total = source.getPageCount();
  const { byCategory, unclassified, undecidedSpec } = await classifyPlanSetPages(planSet.path, total);

  const baseName = planSet.name.replace(/\.pdf$/i, "");
  const parts: UtilityPackageResult["parts"] = [];

  // Split only the sheet categories this submission type needs (plus any already split).
  for (const cat of CATEGORY_PATTERNS) {
    if (!wanted.includes(cat.docType)) continue;
    const pages = byCategory.get(cat.docType);
    if (!pages || pages.length === 0) continue;
    const out = await PDFDocument.create();
    const copied = await out.copyPages(source, pages);
    copied.forEach((p) => out.addPage(p));
    let bytes = Buffer.from(await out.save());
    // SIZE CAP (utility "nem" packages ONLY — split-mode portals like PowerClerk enforce
    // a 5 MB per-file limit; override with PORTAL_UPLOAD_MAX_MB, the shared knob in
    // portalUploadCapBytes). A multi-page split that blew the cap gets trimmed to its
    // LEAD page — the dedicated sheet is always first-matched; a heavy raster tail page
    // (a vendor manual scan) is what pushes it over. Better one on-point sheet the portal
    // accepts than a "complete" file it bounces. The permit/all targets are NOT trimmed:
    // AHJ portals accept large files, and silently dropping structural-calc pages from a
    // permit package would ship an incomplete filing with no error anywhere.
    const CAP = target === "nem" ? portalUploadCapBytes("split") : Number.POSITIVE_INFINITY;
    if (bytes.length > CAP && pages.length > 1) {
      const lead = await PDFDocument.create();
      const [first] = await lead.copyPages(source, [pages[0]]);
      lead.addPage(first);
      const leadBytes = Buffer.from(await lead.save());
      if (leadBytes.length <= CAP) bytes = leadBytes;
    }
    const saved = saveProjectDocument(db, projectId, {
      docType: cat.docType,
      filename: `${baseName} - ${cat.label}.pdf`,
      contentType: "application/pdf",
      buffer: bytes,
      source: "split",
    });
    parts.push({ docType: cat.docType, label: cat.label, pages: pages.map((n) => n + 1), documentId: saved.id });
  }

  // Assemble the ZIP from the wanted doc set — split sheets AND separately uploaded files
  // (meter photo, utility bill come from uploads, not the plan set).
  const available = projectDocsByType(db, projectId);
  const zip = new AdmZip();
  const packaged: string[] = [];
  const missing: string[] = [];
  for (const docType of wanted) {
    // Separately-uploaded types (meter photo, utility bill, the sealed structural
    // letter) come straight from project_documents; projectDocsByType has already
    // resolved the aliases operators file them under.
    const filePath = available[docType];
    if (filePath && fs.existsSync(filePath)) {
      zip.addFile(`${docType}${path.extname(filePath) || ".pdf"}`, fs.readFileSync(filePath));
      packaged.push(docType);
    } else if (!CONDITIONAL_PACKAGE_DOC_TYPES.has(docType)) {
      missing.push(docType);
    }
  }
  if (packaged.length === 0) throw new HttpError(422, "No documents available for this package. Upload the plan set (and meter photo for NEM), then rebuild.");

  const zipDoc = saveProjectDocument(db, projectId, {
    docType: "utility_package_zip",
    filename: `${baseName} - ${target} package.zip`,
    contentType: "application/zip",
    buffer: zip.toBuffer(),
    source: "split",
  });

  const missingSheetTypes = CATEGORY_PATTERNS
    .map((c) => c.docType)
    .filter((t) => wanted.includes(t) && !parts.some((p) => p.docType === t));
  return { target, planSetDocId: planSet.id, pages: total, parts, packagedDocTypes: packaged, missingDocTypes: missing, zipDocumentId: zipDoc.id, unclassifiedPages: unclassified, missingSheetTypes, undecidedSpecPages: undecidedSpec };
}

// Assign each page of the plan set to its categories (classifyPage). 1-based unclassified pages;
// the unclassified EQUIPMENT SPECIFICATION pages are also listed as undecided spec pages.
async function classifyPlanSetPages(planSetPath: string, total: number): Promise<{ byCategory: Map<string, number[]>; unclassified: number[]; undecidedSpec: number[] }> {
  const pageTexts = await extractPdfPages(planSetPath, 80);
  const byCategory = new Map<string, number[]>();
  const unclassified: number[] = [];
  const undecidedSpec: number[] = [];
  for (let i = 0; i < total; i++) {
    const text = pageTexts[i] ?? "";
    const docTypes = classifyPage(text);
    if (docTypes.length) {
      for (const docType of docTypes) {
        const arr = byCategory.get(docType) ?? [];
        arr.push(i);
        byCategory.set(docType, arr);
      }
    } else {
      unclassified.push(i + 1);
      if (EQUIPMENT_SPEC_SHEET.test(text) && !isIndexOrNotesPage(text)) undecidedSpec.push(i + 1);
    }
  }
  return { byCategory, unclassified, undecidedSpec };
}

/**
 * Sheet types the CURRENT classifier finds in the newest plan set that no split row cut from
 * that plan set carries — i.e. the existing split is stale against a classifier fix. The auto
 * chain dedupes "already split" by recency, so without this a project split by the old
 * winner-take-all scoring (site plan filed as structural, #29) would never get its site_plan
 * part without a re-upload. Read-only: extracts text, writes nothing. Empty when there is no
 * plan set or nothing has been split from it yet (the ordinary split path owns that case).
 *
 * A type a PERSON deleted since this plan set landed is never a gap: removing a split part is an
 * operator's ruling on it (wrong sheet, bad cut), and re-cutting it behind their back would undo
 * that and hide the "not attached" verdict QC owes them (qcRejudgedOnDocs 2c).
 */
export async function splitSheetGaps(db: AppDb, projectId: string): Promise<string[]> {
  const latest = db.get<{ stored_path: string; uploaded_at: string }>(
    "SELECT stored_path, uploaded_at FROM project_documents WHERE project_id = ? AND doc_type = 'plan_set' ORDER BY uploaded_at DESC LIMIT 1",
    [projectId],
  );
  if (!latest?.stored_path || !fs.existsSync(latest.stored_path)) return [];
  const splitTypes = new Set(db.query<{ doc_type: string }>(
    "SELECT DISTINCT doc_type FROM project_documents WHERE project_id = ? AND source = 'split' AND uploaded_at >= ?",
    [projectId, latest.uploaded_at],
  ).map((r) => r.doc_type));
  if (splitTypes.size === 0) return [];
  for (const t of documentTypesDeletedSince(db, projectId, latest.uploaded_at)) splitTypes.add(t);
  // Every sheet type already split: nothing a re-classification could add, skip the text pass.
  if (CATEGORY_PATTERNS.every((c) => splitTypes.has(c.docType))) return [];
  const total = (await PDFDocument.load(fs.readFileSync(latest.stored_path))).getPageCount();
  const { byCategory } = await classifyPlanSetPages(latest.stored_path, total);
  return CATEGORY_PATTERNS
    .map((c) => c.docType)
    .filter((t) => PACKAGE_SETS.all.includes(t) && (byCategory.get(t)?.length ?? 0) > 0 && !splitTypes.has(t));
}
