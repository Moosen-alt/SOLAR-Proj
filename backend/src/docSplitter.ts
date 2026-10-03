import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { PDFDocument } from "pdf-lib";
import { extractPdfPages } from "./batchImport";
import { portalUploadCapBytes } from "../../portal-bot/src/uploadCap";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { saveProjectDocument, listProjectDocuments, projectDocsByType, documentTypesDeletedSince, withdrawSplitPart } from "./projectDocuments";

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
  // A WIRING CALCULATIONS sheet carries text TABLES headed "INVERTER SPECIFICATIONS" and
  // "PV MODULE SPECIFICATIONS" — the same words as a spec sheet's name, and that sheet's only
  // hit, so winner-take-all had nothing to rescue it with and it shipped as the inverter spec
  // (#66). It is excluded by what the sheet IS (CALCS_SHEET below), not by tightening the names:
  // the text layer joins the title block's lines, so "… SPECIFICATION SHEET" vs "… SPECIFICATIONS"
  // only tests what label happens to follow the name ("SHEET NUMBER" or not).
  //
  // "EQUIPMENT SPECIFICATION(S)" is deliberately NOT a pattern here (#66). Those pages (Basson
  // PV-11+) are image cut-sheets whose only text is the title block, and the section holds the
  // module, the combiner, the racking brochure… all with the same text. Filing them as
  // module_spec (and "counting as both") put a combiner and a racking brochure in the spec parts
  // with no way to tell. They are reported as undecided instead (SPEC_SHEET_NAME below).
  { docType: "module_spec", label: "Module spec", patterns: [/MODULE\s*[\/&]?\s*INV(?:ERTER)?\.?\s*SPEC/i, /MODULE\s+SPECIFICATION\s+SHEET/i, /PV MODULE SPEC/i] },
  // NOTE: do NOT match on the UL listing standard (/UL 1741/) — that number is cited on the
  // SLD, general notes, and most electrical sheets, so it pulled those dense pages into the
  // inverter_spec split and bloated it past PowerClerk's 5 MB upload limit. Match the dedicated
  // SPEC SHEET by its title-block name only, per this file's stated discipline.
  { docType: "inverter_spec", label: "Inverter spec", patterns: [/MODULE\s*[\/&]?\s*INV(?:ERTER)?\.?\s*SPEC/i, /MICRO-?INVERTER\s+SPEC(?:IFICATION)?S?\b/i, /\bINVERTER\s+SPEC(?:IFICATION)?S?\b/i] },
  { docType: "labels", label: "Labels / placards", patterns: [/\bWARNING LABELS\b/i, /\bLABEL LOCATION\b/i, /\bE\s*1\.3\b/i] },
];

// A calculations sheet (WIRING CALCULATIONS, ELECTRICAL CALCULATIONS). Its body tabulates the
// module and inverter specs, so it is never a spec part — the spec categories and the combined
// MODULE / INV fan-out do not apply to it (#66). Other categories still score as before.
const CALCS_SHEET = /\b(?:WIR(?:E|ING)|ELECTRICAL)\s+CALC(?:ULATION)?S?\b/i;
const SPEC_DOC_TYPES = new Set(["module_spec", "inverter_spec"]);

// A page that NAMES a spec sheet. One that no category claimed is reported in
// `undecidedSpecPages`, so a spec-named page is never dropped silently: a title-only
// "EQUIPMENT SPECIFICATION" cut-sheet (module datasheet? combiner? racking brochure?) is the
// expected case, and the split says it could not decide rather than guessing (#66). A
// calculations sheet is not undecided — it is known not to be a spec sheet.
const SPEC_SHEET_NAME = /(?:MICRO-?)?(?:INVERTERS?|MODULES?|EQUIPMENT)\s+SPEC(?:IFICATION)?S?\b/i;

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
  const calcsSheet = CALCS_SHEET.test(text);
  let best: { docType: string; score: number } | null = null;
  for (const cat of CATEGORY_PATTERNS) {
    if (calcsSheet && SPEC_DOC_TYPES.has(cat.docType)) continue;
    const hits = (res: RegExp[] | undefined) => (res ?? []).reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
    const score = hits(cat.patterns)
      + (electricalSheet ? 0 : hits(cat.words) + (cat.vocabulary?.some((re) => re.test(text)) ? 1 : 0));
    if (score > 0 && (!best || score > best.score)) best = { docType: cat.docType, score };
  }
  if (!best) return [];
  const out = [best.docType];
  if (!calcsSheet && /MODULE\s*[\/&]?\s*INV(?:ERTER)?\.?\s*SPEC/i.test(text)) {
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
  /** 1-based pages that name a spec sheet but that no category claimed — typically a title-only
   *  "EQUIPMENT SPECIFICATION" cut-sheet, whose text cannot tell module / inverter / combiner /
   *  racking apart (#66). Never filed into a spec part; a person (or a vision read) decides. */
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
// the unclassified pages that name a spec sheet are also listed as undecided spec pages.
async function classifyPlanSetPages(planSetPath: string, total: number): Promise<{ byCategory: Map<string, number[]>; unclassified: number[]; undecidedSpec: number[]; pageTexts: string[] }> {
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
      if (SPEC_SHEET_NAME.test(text) && !CALCS_SHEET.test(text) && !isIndexOrNotesPage(text)) undecidedSpec.push(i + 1);
    }
  }
  return { byCategory, unclassified, undecidedSpec, pageTexts };
}

// A page's identity for comparing a split part against the plan set: its text with whitespace
// collapsed. copyPages carries the content stream over unchanged, so a part's page reads the same
// as the plan-set page it was cut from.
const pageKey = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * RECONCILE THE SPLIT PARTS WITH THE CURRENT CLASSIFIER, then name the gaps.
 *
 * STALE PARTS (#77). A split row whose pages are not all pages the CURRENT classifier puts in that
 * type (including when it puts none there) was cut by an older classifier — the pre-#66 scoring
 * filed the WIRING CALCULATIONS sheet as inverter_spec and title-only EQUIPMENT SPECIFICATION
 * cut-sheets as module_spec. Such a row is withdrawn (withdrawSplitPart): left standing, the gate
 * counted it present ("attached file") and every guard skipped the re-split because the type
 * "existed". A subset is not stale: the NEM size cap trims a part to its lead page. Only rows the
 * splitter wrote (`source = 'split'`) are ever withdrawn — a document a person uploaded is theirs
 * whatever it holds — and a type a person deleted is left alone entirely.
 *
 * GAPS (#29). Sheet types the current classifier finds in the newest plan set that no remaining
 * split row cut from that plan set carries — re-cut by the caller. A type a PERSON deleted since
 * this plan set landed is never a gap: removing a split part is an operator's ruling on it (wrong
 * sheet, bad cut), and re-cutting it behind their back would undo that and hide the "not attached"
 * verdict QC owes them (qcRejudgedOnDocs 2c). Empty when nothing has been split from this plan set
 * yet (the ordinary split path owns that case).
 *
 * No plan set on disk → nothing to compare against, no writes. A part that cannot be read is left
 * standing; a plan set with no text at all withdraws nothing (no classifier answer to judge by).
 */
export async function reconcileSplitParts(db: AppDb, projectId: string): Promise<{ withdrawn: string[]; gaps: string[] }> {
  const latest = db.get<{ stored_path: string; uploaded_at: string }>(
    "SELECT stored_path, uploaded_at FROM project_documents WHERE project_id = ? AND doc_type = 'plan_set' ORDER BY uploaded_at DESC LIMIT 1",
    [projectId],
  );
  if (!latest?.stored_path || !fs.existsSync(latest.stored_path)) return { withdrawn: [], gaps: [] };
  const sheetTypes = CATEGORY_PATTERNS.map((c) => c.docType);
  const splitParts = db.query<{ id: string; doc_type: string; stored_path: string; uploaded_at: string }>(
    `SELECT id, doc_type, stored_path, uploaded_at FROM project_documents
      WHERE project_id = ? AND source = 'split' AND doc_type IN (${sheetTypes.map(() => "?").join(", ")})`,
    [projectId, ...sheetTypes],
  );
  if (splitParts.length === 0) return { withdrawn: [], gaps: [] };
  const deletedByPerson = documentTypesDeletedSince(db, projectId, latest.uploaded_at);
  const total = (await PDFDocument.load(fs.readFileSync(latest.stored_path))).getPageCount();
  const { byCategory, pageTexts } = await classifyPlanSetPages(latest.stored_path, total);

  const withdrawn = new Set<string>();
  if (pageTexts.some((t) => pageKey(t))) {
    for (const part of splitParts) {
      if (deletedByPerson.has(part.doc_type) || !part.stored_path || !fs.existsSync(part.stored_path)) continue;
      let partPages: string[];
      try { partPages = await extractPdfPages(part.stored_path, 80); } catch { continue; }
      const allowed = new Set((byCategory.get(part.doc_type) ?? []).map((i) => pageKey(pageTexts[i] ?? "")));
      if (partPages.some((t) => !allowed.has(pageKey(t))) && withdrawSplitPart(db, projectId, part.id)) withdrawn.add(part.doc_type);
    }
    // A package ZIP the splitter built bundles the withdrawn part (the bot's last-resort upload
    // fallback): it goes too, and the next package build writes a fresh one.
    if (withdrawn.size > 0) {
      for (const zip of db.query<{ id: string }>(
        "SELECT id FROM project_documents WHERE project_id = ? AND source = 'split' AND doc_type = 'utility_package_zip'", [projectId],
      )) withdrawSplitPart(db, projectId, zip.id);
    }
  }

  const splitTypes = new Set(db.query<{ doc_type: string }>(
    "SELECT DISTINCT doc_type FROM project_documents WHERE project_id = ? AND source = 'split' AND uploaded_at >= ?",
    [projectId, latest.uploaded_at],
  ).map((r) => r.doc_type));
  if (splitTypes.size === 0) return { withdrawn: [...withdrawn], gaps: [] };
  for (const t of deletedByPerson) splitTypes.add(t);
  const gaps = sheetTypes.filter((t) => PACKAGE_SETS.all.includes(t) && (byCategory.get(t)?.length ?? 0) > 0 && !splitTypes.has(t));
  return { withdrawn: [...withdrawn], gaps };
}

/**
 * THE STAGE / LEARN SPLIT GUARD. Withdraw stale parts, then split the plan set for `target` only
 * when a sheet it needs is still absent AND the split can change that: nothing has been split from
 * the newest plan set yet, or the current classifier finds one of the target's sheet types that no
 * split row carries (reconcileSplitParts gaps). Before (#75 review), the guard re-split whenever a
 * wanted type had no row — and a set whose only spec pages are title-only EQUIPMENT SPECIFICATION
 * cut-sheets never gets a spec row, so it was re-split on every stage pass.
 */
export async function ensurePlanSetSplit(
  db: AppDb, projectId: string, target: string, sheetTypes: string[],
): Promise<{ split: boolean; withdrawn: string[]; gaps: string[] }> {
  const { withdrawn, gaps: allGaps } = await reconcileSplitParts(db, projectId);
  const wanted = PACKAGE_SETS[target] ?? PACKAGE_SETS.all;
  const gaps = allGaps.filter((t) => wanted.includes(t));
  const existing = projectDocsByType(db, projectId);
  if (sheetTypes.every((t) => existing[t])) return { split: false, withdrawn, gaps };
  const planSet = db.get<{ uploaded_at: string }>(
    "SELECT uploaded_at FROM project_documents WHERE project_id = ? AND doc_type = 'plan_set' ORDER BY uploaded_at DESC LIMIT 1",
    [projectId],
  );
  const splitSince = planSet
    ? Number(db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ? AND source = 'split' AND uploaded_at >= ?",
        [projectId, planSet.uploaded_at],
      )?.n ?? 0)
    : 0;
  if (splitSince > 0 && gaps.length === 0) return { split: false, withdrawn, gaps };
  await buildUtilityPackage(db, projectId, target);
  return { split: true, withdrawn, gaps };
}
