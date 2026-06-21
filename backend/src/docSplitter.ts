import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { PDFDocument } from "pdf-lib";
import { extractPdfPages } from "./batchImport";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { saveProjectDocument, listProjectDocuments, projectDocsByType } from "./projectDocuments";

// Sheet/content patterns → upload doc category. Ported from the parser's detectSplitPages;
// pages are scored against each category and assigned to the best match. The categories are
// the files an AHJ/utility upload package needs.
const CATEGORY_PATTERNS: Array<{ docType: string; label: string; patterns: RegExp[] }> = [
  { docType: "sld", label: "SLD / one-line", patterns: [/\b3-?LINE DIAGRAM\b/i, /\bONE-?LINE\b/i, /\bSINGLE-?LINE\b/i, /\bE\s*1\.1\b/i, /UTILITY COMPANY/i] },
  { docType: "site_plan", label: "Site / plot plan", patterns: [/\bSITE PLAN\b/i, /\bPLOT PLAN\b/i, /\bPV\s*1\.[01]\b/i] },
  { docType: "structural", label: "Structural / roof framing", patterns: [/\bMOUNT DETAIL\b/i, /\bATTACHMENT DETAIL\b/i, /\bROOF SECTION\b/i, /\bRAFTER\b/i, /\bTRUSS\b/i, /\bS\s*1\.\d\b/i, /STRUCTURAL/i] },
  { docType: "module_spec", label: "Module spec", patterns: [/MODULE SPECIFICATION/i, /PV MODULE SPEC/i, /ZXM7|Q\.TRON|ZNSHINE/i] },
  { docType: "inverter_spec", label: "Inverter spec", patterns: [/MICROINVERTER SPECIFICATION/i, /INVERTER SPECIFICATION/i, /DS3 Series|Q\.MI|IQ8/i] },
  { docType: "labels", label: "Labels / placards", patterns: [/\bWARNING LABELS\b/i, /\bLABEL LOCATION\b/i, /\bE\s*1\.3\b/i] },
];

function classifyPage(text: string): string | null {
  let best: { docType: string; score: number } | null = null;
  for (const cat of CATEGORY_PATTERNS) {
    const score = cat.patterns.reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
    if (score > 0 && (!best || score > best.score)) best = { docType: cat.docType, score };
  }
  return best?.docType ?? null;
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
  permit: ["sld", "site_plan", "structural", "module_spec", "inverter_spec", "labels"],
  // Everything we could split/attach — for debug or portals with no defined set yet.
  all: ["sld", "site_plan", "structural", "module_spec", "inverter_spec", "labels", "meter_photo", "utility_bill"],
};

export interface UtilityPackageResult {
  target: string;
  planSetDocId: string;
  pages: number;
  parts: Array<{ docType: string; label: string; pages: number[]; documentId: string }>;
  packagedDocTypes: string[];
  missingDocTypes: string[];
  zipDocumentId: string;
  unclassifiedPages: number[];
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

  const pageTexts = await extractPdfPages(planSet.path, 80);
  const source = await PDFDocument.load(fs.readFileSync(planSet.path));
  const total = source.getPageCount();

  // Assign each page to a category.
  const byCategory = new Map<string, number[]>();
  const unclassified: number[] = [];
  for (let i = 0; i < total; i++) {
    const docType = classifyPage(pageTexts[i] ?? "");
    if (docType) {
      const arr = byCategory.get(docType) ?? [];
      arr.push(i);
      byCategory.set(docType, arr);
    } else {
      unclassified.push(i + 1);
    }
  }

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
    const bytes = Buffer.from(await out.save());
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
    const filePath = available[docType];
    if (filePath && fs.existsSync(filePath)) {
      zip.addFile(`${docType}${path.extname(filePath) || ".pdf"}`, fs.readFileSync(filePath));
      packaged.push(docType);
    } else {
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

  return { target, planSetDocId: planSet.id, pages: total, parts, packagedDocTypes: packaged, missingDocTypes: missing, zipDocumentId: zipDoc.id, unclassifiedPages: unclassified };
}
