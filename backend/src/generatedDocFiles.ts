/**
 * THE BUILT DOCS BECOME FILES THE BOT CAN ATTACH.
 *
 * Operator ruling 2026-09-21: "ensure the bot can see the build docs for submitting permits —
 * it can attach them all for us then as required by the AHJ."
 *
 * There were two families of "generated documents" with opposite fates. The FILLED AHJ FORMS
 * (BCD 5952, building/electrical applications) are real PDFs on disk and the upload paths
 * already reach them. But everything `getApplicationDocumentPackage` builds — the AHJ
 * Application Transfer Sheet, the prescriptive application, the structural and electrical
 * worksheets, the utility worksheet — existed only as MARKDOWN STRINGS serving the print
 * packet. No file, no `project_documents` row, no docsByType key: invisible to every upload
 * step the bot has. "Build Docs" built documents the submission could not carry.
 *
 * This module renders that package to PDFs beside the filled forms and returns them keyed the
 * way the upload resolvers key everything (docType → absolute path). Layering in
 * `submissionDocumentsByType` is deliberate and one-directional:
 *
 *     generated package  <  filled official forms  <  operator uploads
 *
 * A GENERATED WORKSHEET MUST NEVER SHADOW AN OFFICIAL FORM: where both carry the same docType
 * (a generated "prescriptive application" vs the jurisdiction's own filled PDF), the official
 * form wins, and anything a person uploaded by hand outranks both.
 *
 * Rendering is pdf-lib text layout — no browser, no LLM, no network. These are worksheets and
 * transfer sheets whose value is their CONTENT; a portal upload slot needs a legible PDF, not
 * typography.
 */
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { AppDb } from "./db";
import type { GeneratedApplicationDocument, ProjectRecord } from "../../shared/src/types";
import { logger } from "./logger";

/** Same root the filled official forms use, one subfolder per project. */
const FILLED_DIR = path.resolve(process.cwd(), "backend/data/filled");

/** documentType → the docsByType key upload steps and label patterns speak. Package types
 *  that overlap the filled-forms vocabulary REUSE it on purpose (a slot asking for the
 *  electrical application should find whichever exists); package-only types get their own. */
const DOC_TYPE_KEYS: Record<GeneratedApplicationDocument["documentType"], string> = {
  ahj_application: "permit_application",
  structural_application: "building_application",
  electrical_application: "electrical_application",
  checklist: "solar_checklist",
  utility_application: "utility_application",
  worksheet: "application_worksheet",
  cover: "application_cover",
  manifest: "application_manifest",
};

const genDir = (projectId: string): string => path.join(FILLED_DIR, projectId, "generated");

/**
 * Render the application-document package to PDFs. Called from prepareOfficialDocuments —
 * the one seam both staging and learn already pass through — so by the time any upload path
 * asks, the files exist. Re-renders are cheap and idempotent (same names, overwritten), and a
 * failure never blocks staging: these files are additive capability, and the missing-document
 * gates still rule on requiredness exactly as before.
 */
export async function materializeGeneratedDocs(db: AppDb, project: ProjectRecord): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let docs: GeneratedApplicationDocument[] = [];
  try {
    const { getApplicationDocumentPackage } = await import("./repository");
    docs = getApplicationDocumentPackage(db, project.id).docs || [];
  } catch (err) {
    logger.warn("official-documents", "generated-doc package build failed; staging continues on filled forms + uploads", {
      projectId: project.id, err: err instanceof Error ? err.message : String(err),
    });
    return out;
  }
  const dir = genDir(project.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const doc of docs) {
    try {
      const file = path.join(dir, `${doc.id.replace(/[^a-z0-9_-]/gi, "_")}.pdf`);
      fs.writeFileSync(file, await markdownToPdf(doc.title, doc.markdown));
      const key = DOC_TYPE_KEYS[doc.documentType] || "application_worksheet";
      if (!out[key]) out[key] = file; // first (the package orders required-first) wins
    } catch (err) {
      logger.warn("official-documents", "one generated doc failed to render; the rest continue", {
        projectId: project.id, doc: doc.id, err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Read back what a previous materialization wrote — the read half submissionDocumentsByType
 *  calls on every assembly. Filesystem-only: no package rebuild on a read path. */
export function generatedDocFilesByType(projectId: string): Record<string, string> {
  const dir = genDir(projectId);
  const out: Record<string, string> = {};
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".pdf")); } catch { return out; }
  // Recover the docType from the doc id embedded in the filename via the same table.
  for (const f of files.sort()) {
    const stem = f.replace(/\.pdf$/i, "");
    const key = keyForDocId(stem);
    if (key && !out[key]) out[key] = path.join(dir, f);
  }
  return out;
}

/** Doc ids are stable in applicationDocs.ts; map the known ones, default the rest to
 *  the worksheet bucket rather than dropping them. */
function keyForDocId(id: string): string {
  const s = id.toLowerCase();
  if (s.includes("transfer")) return "application_transfer_sheet";
  if (s.includes("cover")) return "application_cover";
  if (s.includes("manifest")) return "application_manifest";
  if (s.includes("prescriptive")) return "permit_application";
  if (s.includes("structural")) return "building_application";
  if (s.includes("electrical")) return "electrical_application";
  if (s.includes("utility") || s.includes("nem")) return "utility_application";
  if (s.includes("portal")) return "portal_entry_worksheet";
  if (s.includes("bid")) return "bid_sheet";
  return "application_worksheet";
}

/**
 * Minimal, dependency-free markdown → PDF: headings bold, lists indented, tables kept as
 * monospaced rows, long lines wrapped, multi-page. Content-faithful over pretty.
 */
async function markdownToPdf(title: string, markdown: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const W = 612, H = 792, M = 54, LH = 13;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const newPage = (): void => { page = pdf.addPage([W, H]); y = H - M; };
  const draw = (text: string, f = font, size = 9.5, indent = 0): void => {
    const maxW = W - 2 * M - indent;
    // Greedy wrap on width; Courier rows (tables) wrap too rather than truncate.
    let line = "";
    const words = text.split(/\s+/);
    const flush = (): void => {
      if (y < M + LH) newPage();
      page.drawText(line, { x: M + indent, y, size, font: f });
      y -= LH;
      line = "";
    };
    for (const w of words) {
      const probe = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(probe, size) > maxW && line) flush();
      line = line ? `${line} ${w}` : w;
    }
    if (line.trim()) flush();
  };

  draw(title, bold, 14);
  y -= 6;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1");
    if (!line.trim()) { y -= 6; if (y < M) newPage(); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { y -= 4; draw(h[2], bold, h[1].length <= 2 ? 12 : 10.5); continue; }
    if (/^\s*\|/.test(line)) { draw(line.trim(), mono, 8); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { draw(`• ${li[1]}`, font, 9.5, 12); continue; }
    draw(line.trim());
  }
  return pdf.save();
}
