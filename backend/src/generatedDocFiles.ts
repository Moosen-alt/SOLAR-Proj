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
 * A GENERATED WORKSHEET IS NEVER AN OFFICIAL FORM (docs-audit PLAN D2, operator decision OD-3).
 * It used to be packaged UNDER the official keys: the reader keyed files by FILENAME
 * (`electrical.pdf` → electrical_application, `structural.pdf` → building_application,
 * `prescriptive-application.pdf` → permit_application), so a portal slot named "Electrical Permit
 * Application" received this product's internal worksheet whenever no official form was held —
 * the gate said the application was missing while the package said it was there. A second table
 * keyed by documentType disagreed with the first and was discarded unread (V5, V17). Now ONE table
 * keys each render by its builder's own doc.id (applicationDocs.ts `doc("<id>", …)`), and every
 * worksheet lives under its OWN `generated_*` key, which no upload slot pattern names. The two
 * slots the 2026-09-21 "attach them all" ruling opened stay open: the AHJ transfer sheet
 * (application_transfer_sheet) and the utility NEM worksheet (utility_application).
 *
 * A RENDER IS ONE SET, NOT A PILE (V5). Each materialization writes `generated/manifest.json`
 * (doc.id → key → file, plus the permit path it was rendered on) and deletes every generated PDF
 * that is not in it — so a prescriptive render removes the `structural.pdf` an earlier engineered
 * render left behind (6a1c2127, ec5c36d3 on disk). The reader reads the manifest, never the
 * directory, and packages nothing when the project's permit path has moved since the render —
 * the same path scoping filledFormsByDocType gives the official forms.
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
import { resolvePermitPath } from "./permitPath";
import { logger } from "./logger";

/** Same root the filled official forms use, one subfolder per project. */
const FILLED_DIR = path.resolve(process.cwd(), "backend/data/filled");

/**
 * THE ONE MAPPING: a generated document's builder id (applicationDocs.ts) → the docsByType key
 * its PDF is packaged under. Keyed by doc.id, not documentType, because the builders' documentType
 * is itself misleading here: the prescriptive worksheet is emitted as `checklist` (which would
 * impersonate the BCD 5952) and the transfer sheet as `ahj_application` (which would impersonate
 * the application). No key below is an official application key (APPLICATION_DOC_TYPES) or an
 * exact-upload type — pinned in generatedDocFiles.test section 4.
 */
export const GENERATED_DOC_KEYS: Readonly<Record<string, string>> = {
  // The transfer sheet the 2026-09-21 ruling lets a "transfer sheet" slot receive. On a
  // portal-entry-only AHJ the same builder emits the Portal Entry Worksheet instead — a sheet to
  // type FROM, never to upload — see generatedDocKey.
  "ahj-worksheet": "application_transfer_sheet",
  "prescriptive-application": "generated_prescriptive_worksheet",
  "structural": "generated_structural_worksheet",
  "electrical": "generated_electrical_worksheet",
  "engineered-docs": "generated_engineered_doc_collection",
  "path-chooser": "generated_path_chooser",
  "cover": "application_cover",
  "manifest": "application_manifest",
  // The NEM worksheet the 2026-09-21 ruling lets an interconnection-application slot receive.
  "utility-nem": "utility_application",
  "bid-sheet": "bid_sheet",
};

/** The key for one rendered doc. An id this table does not know gets its own `generated_<id>`
 *  key — never an official one, and never dropped. */
export function generatedDocKey(docId: string, portalEntryOnly: boolean): string {
  if (docId === "ahj-worksheet" && portalEntryOnly) return "portal_entry_worksheet";
  return GENERATED_DOC_KEYS[docId] ?? `generated_${docId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

/** What one render wrote — `generated/manifest.json`. */
interface GeneratedRender {
  version: 1;
  /** resolvePermitPath(project).path when rendered — the reader's staleness test. */
  permitPath: string;
  renderedAt: string;
  /** Package order (required-first): the first doc under a key wins it. */
  docs: Array<{ id: string; key: string; file: string }>;
}

const MANIFEST = "manifest.json";
const genDir = (projectId: string): string => path.join(FILLED_DIR, projectId, "generated");

/** Delete every generated PDF in `dir` that `keep` does not name. Only `*.pdf` directly inside
 *  generated/ — the official fills live one level up (filled/<pid>/tmpl-*.pdf) and are never
 *  touched here. */
function pruneGenerated(dir: string, keep: Set<string>): void {
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return; }
  for (const f of files) {
    if (!/\.pdf$/i.test(f) || keep.has(f)) continue;
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* best effort: the manifest already excludes it */ }
  }
}

/**
 * Render the application-document package to PDFs. Called from prepareOfficialDocuments —
 * the one seam both staging and learn already pass through — so by the time any upload path
 * asks, the files exist. A failure never blocks staging: these files are additive capability,
 * and the missing-document gates still rule on requiredness exactly as before. But a failed
 * render leaves NOTHING readable behind — the previous render describes a project state that
 * is no longer known to be current, which is exactly the stale-file bug on the error path.
 */
export async function materializeGeneratedDocs(db: AppDb, project: ProjectRecord): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const dir = genDir(project.id);
  let docs: GeneratedApplicationDocument[] = [];
  let portalEntryOnly = false;
  try {
    const { getApplicationDocumentPackage } = await import("./repository");
    const pkg = getApplicationDocumentPackage(db, project.id);
    docs = pkg.docs || [];
    portalEntryOnly = Boolean(pkg.profile?.requiresPortalEntryOnly);
  } catch (err) {
    logger.warn("official-documents", "generated-doc package build failed; staging continues on filled forms + uploads", {
      projectId: project.id, err: err instanceof Error ? err.message : String(err),
    });
    try { fs.rmSync(path.join(dir, MANIFEST), { force: true }); } catch { /* nothing to clear */ }
    pruneGenerated(dir, new Set());
    return out;
  }
  fs.mkdirSync(dir, { recursive: true });
  const render: GeneratedRender = { version: 1, permitPath: resolvePermitPath(project).path, renderedAt: new Date().toISOString(), docs: [] };
  for (const doc of docs) {
    try {
      const name = `${doc.id.replace(/[^a-z0-9_-]/gi, "_")}.pdf`;
      const file = path.join(dir, name);
      fs.writeFileSync(file, await markdownToPdf(doc.title, doc.markdown));
      const key = generatedDocKey(doc.id, portalEntryOnly);
      render.docs.push({ id: doc.id, key, file: name });
      if (!out[key]) out[key] = file; // first (the package orders required-first) wins
    } catch (err) {
      logger.warn("official-documents", "one generated doc failed to render; the rest continue", {
        projectId: project.id, doc: doc.id, err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Manifest first (atomically), then prune: a reader never sees a manifest naming a deleted file.
  const tmp = path.join(dir, `${MANIFEST}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(render, null, 2));
  fs.renameSync(tmp, path.join(dir, MANIFEST));
  pruneGenerated(dir, new Set(render.docs.map((d) => d.file)));
  return out;
}

/**
 * Read back what the LAST materialization rendered — the read half submissionDocumentsByType
 * calls on every assembly. Filesystem-only: no package rebuild on a read path.
 *
 *  - no manifest (a directory from before manifests, or a failed render) → nothing;
 *  - a manifest rendered on another permit path than `permitPath` → nothing (stale render);
 *  - otherwise each manifest entry whose file exists, first per key.
 * Nothing is ever keyed off a filename.
 */
export function generatedDocFilesByType(projectId: string, permitPath: string): Record<string, string> {
  const dir = genDir(projectId);
  const out: Record<string, string> = {};
  let render: GeneratedRender | null = null;
  try { render = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")) as GeneratedRender; } catch { return out; }
  if (!render || render.version !== 1 || !Array.isArray(render.docs)) return out;
  if (String(render.permitPath || "") !== String(permitPath || "")) return out;
  for (const d of render.docs) {
    const key = String(d?.key || "");
    const file = path.join(dir, path.basename(String(d?.file || "")));
    if (!key || out[key] || !/\.pdf$/i.test(file) || !fs.existsSync(file)) continue;
    out[key] = file;
  }
  return out;
}

// The standard fonts encode WinAnsi only, and drawText THROWS on anything else — so one
// arrow in the manifest's "← UPLOAD THIS ONE" line dropped the whole manifest from the
// package. Fold the symbols our own copy uses to ASCII, and anything else the font cannot
// encode to "?", so a stray character costs one glyph instead of one document.
const WINANSI_FOLDS: Record<string, string> = {
  "←": "<-", "→": "->", "↔": "<->", "⇒": "=>", "≥": ">=", "≤": "<=", "≠": "!=",
  "✓": "[x]", "✔": "[x]", "✗": "[ ]", "✘": "[ ]", "⚠": "(!)", "☐": "[ ]", "☑": "[x]",
};
function foldForFont(supported: Set<number>, text: string): string {
  return Array.from(text, (ch) => {
    if (supported.has(ch.codePointAt(0)!)) return ch;
    return WINANSI_FOLDS[ch] ?? (/\s/.test(ch) ? " " : "?");
  }).join("");
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
  // All three standard fonts share the WinAnsi character set.
  const charset = new Set(font.getCharacterSet());
  const W = 612, H = 792, M = 54, LH = 13;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const newPage = (): void => { page = pdf.addPage([W, H]); y = H - M; };
  const draw = (raw: string, f = font, size = 9.5, indent = 0): void => {
    const text = foldForFont(charset, raw);
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
