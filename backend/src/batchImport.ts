import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import { learnFromHistoricalDocument } from "./knowledgeBase";
import { pdfjsDocumentOptions } from "./pdfjsOptions";

// ---------------------------------------------------------------------------
// PDF text extraction (server-side via pdfjs-dist)
// ---------------------------------------------------------------------------

type PdfjsModule = {
  getDocument: (opts: { data: Uint8Array; useSystemFonts?: boolean; disableWorker?: boolean; standardFontDataUrl?: string }) => { promise: Promise<PdfjsDoc> };
  GlobalWorkerOptions: { workerSrc: string };
};
type PdfjsDoc = { numPages: number; getPage: (n: number) => Promise<PdfjsPage> };
type PdfjsPage = { getTextContent: () => Promise<{ items: Array<{ str: string }> }> };

let _pdfjs: PdfjsModule | null = null;
async function getPdfjs(): Promise<PdfjsModule> {
  if (!_pdfjs) {
    const mod = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    // In Node.js we run the worker in-process — point workerSrc at the worker
    // file so pdfjs doesn't complain, then rely on disableWorker in getDocument.
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const workerPath = req.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    mod.GlobalWorkerOptions.workerSrc = `file://${workerPath}`;
    _pdfjs = mod as unknown as PdfjsModule;
  }
  return _pdfjs;
}

// Harmless pdfjs console noise we suppress. The JBig2/JPEG2000/wasm warnings fire when
// a PDF embeds JBig2-encoded scans and pdfjs can't load the optional wasm decoder — that
// only affects IMAGE decoding, not the TEXT extraction we do here, so it's safe to drop.
const PDFJS_WARN_RE = /^Warning: (TT: undefined function:|Font "[^"]+" is not available|getHexString|Indexing all PDF objects|#instantiateWasm|#getJsModule|Unable to decode image|Dependent image isn't ready|.*[Jj]Big2|.*JBIG2|.*wasmUrl|.*nulljbig2|.*OpenJPEG|.*JpxError)/;

// Shared pdfjs driver: open the PDF, suppress the harmless image-decode warnings, and
// run `perPage` over each page's RAW concatenated text (items joined by a space), up to
// maxPages. The two public extractors below differ only in how they post-process pages.
async function withPdfPages<T>(filePath: string, maxPages: number, perPage: (rawPageText: string) => T): Promise<T[]> {
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && PDFJS_WARN_RE.test(args[0])) return;
    origWarn.apply(console, args);
  };
  try {
    const doc = await pdfjs.getDocument(pdfjsDocumentOptions({ data, useSystemFonts: true, disableWorker: true })).promise;
    const pages = Math.min(doc.numPages, maxPages);
    const out: T[] = [];
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      out.push(perPage(content.items.map((item) => item.str).join(" ")));
    }
    return out;
  } finally {
    console.warn = origWarn;
  }
}

export async function extractPdfText(filePath: string, maxPages = 30): Promise<string> {
  // Whole-document cleanup: join raw pages with newlines, THEN collapse whitespace once.
  return (await withPdfPages(filePath, maxPages, (s) => s)).join("\n").replace(/\s{3,}/g, "  ").trim();
}

// Per-page text (1-based index → text). Used by the plan-set splitter to map sheets
// to page ranges. maxPages caps the work for very large sets.
export async function extractPdfPages(filePath: string, maxPages = 60): Promise<string[]> {
  return withPdfPages(filePath, maxPages, (s) => s.replace(/\s{3,}/g, "  ").trim());
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

export type DocType = "permit_application" | "sld" | "issued_permit" | "utility_bill" | "correction" | "unknown";

const FILE_PATTERNS: Array<{ pattern: RegExp; type: DocType }> = [
  { pattern: /sld|single[_\s-]?line|one[_\s-]?line|diagram|riser/i, type: "sld" },
  { pattern: /utility[_\s-]?bill|ub[_\s-]?\d|electric[_\s-]?bill|pge[_\s-]?bill|pac[_\s-]?bill|meter[_\s-]?read|statement/i, type: "utility_bill" },
  { pattern: /correction|plan[_\s-]?check|deficiency|revision[_\s-]?comment|noncompliance/i, type: "correction" },
  { pattern: /issued[_\s-]?permit|permit[_\s-]?card|final[_\s-]?permit|approved[_\s-]?permit/i, type: "issued_permit" },
  { pattern: /permit[_\s-]?app|application|app[_\s-]?\d|building[_\s-]?permit|solar[_\s-]?app|pv[_\s-]?app|nem[_\s-]?app|interconnect/i, type: "permit_application" },
];

const TEXT_SIGNALS: Array<{ pattern: RegExp; type: DocType; weight: number }> = [
  { pattern: /single[- ]line diagram|one[- ]line diagram|SLD/i, type: "sld", weight: 3 },
  { pattern: /AC\s*disconnect|DC\s*disconnect|rapid shutdown|main\s*service\s*panel|MSP|PV\s*system\s*output|inverter\s*model|module\s*model/i, type: "sld", weight: 2 },
  { pattern: /account\s*number|account\s*no|billing\s*period|kilowatt[\s-]?hour|kWh\s*used|meter\s*number|net\s*energy\s*metering|NEM\s*rate|E-NET|E-TOU/i, type: "utility_bill", weight: 3 },
  { pattern: /electric\s*service\s*provider|your\s*bill|amount\s*due|previous\s*balance|current\s*charges/i, type: "utility_bill", weight: 2 },
  { pattern: /permit\s*is\s*hereby\s*issued|approved\s*by\s*building|permit\s*number|inspection\s*card|certificate\s*of\s*occupancy/i, type: "issued_permit", weight: 3 },
  { pattern: /plan\s*check\s*correction|correction\s*list|deficiency\s*list|items?\s*requiring\s*correction|resubmit/i, type: "correction", weight: 3 },
  { pattern: /applicant|homeowner|property\s*owner|installation\s*address|system\s*description|solar\s*photovoltaic|PV\s*system/i, type: "permit_application", weight: 2 },
];

export function classifyDoc(filename: string, text: string): DocType {
  const scores: Record<DocType, number> = {
    permit_application: 0, sld: 0, issued_permit: 0, utility_bill: 0, correction: 0, unknown: 0,
  };

  for (const { pattern, type } of FILE_PATTERNS) {
    if (pattern.test(path.basename(filename, path.extname(filename)))) scores[type] += 3;
  }
  const sample = text.slice(0, 4000);
  for (const { pattern, type, weight } of TEXT_SIGNALS) {
    if (pattern.test(sample)) scores[type] += weight;
  }

  const best = (Object.entries(scores) as [DocType, number][])
    .filter(([t]) => t !== "unknown")
    .sort(([, a], [, b]) => b - a)[0];
  return best && best[1] > 0 ? best[0] : "unknown";
}

// ---------------------------------------------------------------------------
// Field extractors
// ---------------------------------------------------------------------------

interface CorrectionFields {
  correctionItems?: string[];
  applicationNumber?: string;
}

// Pull numbered correction / plan-check items out of a correction document.
function quickExtractCorrections(text: string): Partial<CorrectionFields> {
  const appMatch = text.match(/(?:application|app|record|permit)\s*(?:number|no\.?|#)[:\s]+([A-Z0-9\-]{4,20})/i);
  const lines = text.split(/\n/);
  // Numbered correction items
  const items = lines
    .filter((l) => /^\s*\d+[\.\)]\s+.{20,}/.test(l))
    .map((l) => l.replace(/^\s*\d+[\.\)]\s+/, "").trim())
    .slice(0, 20);
  return {
    applicationNumber: appMatch?.[1],
    correctionItems: items.length > 0 ? items : undefined,
  };
}
// ---------------------------------------------------------------------------
// Customer / jurisdiction anchors from filenames + folders
// ---------------------------------------------------------------------------
//
// In real-world export dumps the useful signal lives in the *names*, not the PDF
// text: files are named "Casey Testcase - Happy Valley, OR.pdf" and grouped in a
// per-customer folder. We parse "Name - City, ST" to recover the jurisdiction
// (city -> AHJ) and state for each customer folder. We do NOT create projects or
// store any homeowner PII — only the jurisdiction/utility/requirement signals are
// learned into the knowledge base.

interface FolderAnchor {
  city: string;
  state: string;
}

const NAME_CITY_RE = /-\s*([A-Za-z][A-Za-z .'/]+?),\s*([A-Za-z]{2})\b/;

function parseCityState(name: string): FolderAnchor | null {
  const base = name.replace(/\.pdf$/i, "").trim();
  const m = base.match(NAME_CITY_RE);
  if (!m) return null;
  const city = m[1].replace(/\s{2,}/g, " ").trim();
  const state = m[2].toUpperCase();
  if (city.length < 3) return null;
  return { city, state };
}

// Dominant city/state for a folder: the most common one parsed from the
// filenames inside it, falling back to the folder's own name.
function folderAnchor(folderPath: string, files: string[]): FolderAnchor | null {
  const counts = new Map<string, { anchor: FolderAnchor; n: number }>();
  for (const f of files) {
    const a = parseCityState(path.basename(f));
    if (!a) continue;
    const key = `${a.city.toLowerCase()}|${a.state}`;
    const cur = counts.get(key);
    if (cur) cur.n++;
    else counts.set(key, { anchor: a, n: 1 });
  }
  let best: { anchor: FolderAnchor; n: number } | null = null;
  for (const v of counts.values()) if (!best || v.n > best.n) best = v;
  if (best) return best.anchor;
  return parseCityState(path.basename(folderPath));
}

// ---------------------------------------------------------------------------
// Canonical document labels (what a jurisdiction's submission packet contains)
// ---------------------------------------------------------------------------
//
// The set of filenames in a customer folder is itself a strong signal of what
// documents an AHJ requires. We normalise each filename to a canonical document
// label and learn those as the AHJ's required-document list.

const DOC_LABEL_RULES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /single[_\s-]?line|one[_\s-]?line|\bsld\b|riser/i, label: "Single-Line Diagram (SLD)" },
  { pattern: /site[_\s-]?plan/i, label: "Site Plan" },
  { pattern: /floodplain/i, label: "Floodplain Development Permit Application" },
  { pattern: /structural.*(permit|application|analysis)|structural[_\s-]?permit/i, label: "Structural Permit Application" },
  { pattern: /electrical.*(permit|renewable)|renewable[_\s-]?electrical|elec.*permit/i, label: "Electrical / Renewable Energy Permit Application" },
  { pattern: /building[_\s-]?permit[_\s-]?application|building[_\s-]?permit/i, label: "Building Permit Application" },
  { pattern: /prescriptive.*(solar|checklist|installation)|solar[_\s-]?installation[_\s-]?checklist|photovoltaic[_\s-]?checklist/i, label: "Prescriptive Solar Installation Checklist" },
  { pattern: /notice[_\s-]?authorizing[_\s-]?representative|authorizing[_\s-]?representative|letter[_\s-]?of[_\s-]?authorization/i, label: "Notice / Letter Authorizing Representative" },
  { pattern: /supplemental[_\s-]?required[_\s-]?signatures|required[_\s-]?signatures/i, label: "Supplemental Required Signatures Form" },
  { pattern: /construction[_\s-]?responsibilit|owners?[_\s-]?construction/i, label: "Construction Responsibilities Form" },
  { pattern: /moisture[_\s-]?content/i, label: "Moisture Content Acknowledgement Form" },
  { pattern: /land[_\s-]?use[_\s-]?compliance/i, label: "Land Use Compliance Checklist" },
  { pattern: /interconnection[_\s-]?agreement|net[_\s-]?metering|\bnem\b/i, label: "Interconnection / Net-Metering Agreement" },
  { pattern: /meter[_\s-]?mounted[_\s-]?device|work[_\s-]?order[_\s-]?authorization|mmd/i, label: "Meter-Mounted Device Work Order Authorization" },
  { pattern: /inspection[_\s-]?(card|worksheet|result)/i, label: "Inspection Card / Worksheet" },
  { pattern: /structural[_\s-]?(letter|analysis)|engineer/i, label: "Structural Engineering Letter" },
];

function canonicalDocLabel(filename: string): string | null {
  const base = path.basename(filename, path.extname(filename));
  for (const rule of DOC_LABEL_RULES) if (rule.pattern.test(base)) return rule.label;
  return null;
}

function utilityFromText(text: string): string {
  if (/pacific\s*power|pacificorp/i.test(text)) return "Pacific Power";
  if (/portland\s*general|\bpge\b/i.test(text)) return "PGE";
  if (/pacific\s*gas|pg&e/i.test(text)) return "PG&E";
  if (/puget\s*sound|\bpse\b/i.test(text)) return "PSE";
  if (/southern\s*california\s*edison|\bsce\b/i.test(text)) return "SCE";
  if (/san\s*diego\s*gas|sdg&e/i.test(text)) return "SDG&E";
  return "";
}

// ---------------------------------------------------------------------------
// Main folder scanner — LEARN, don't import
// ---------------------------------------------------------------------------

export interface ScanResult {
  filePath: string;
  docType: DocType;
  status: "learned" | "low_signal" | "error";
  message: string;
  profileKey?: string;
  docLabel?: string;
}

export interface ScanSummary {
  scanned: number;
  learned: number;
  lowSignal: number;
  errors: number;
  byType: Record<DocType, number>;
  byJurisdiction: Record<string, number>;
  profilesTouched: string[];
  requiredDocsByAhj: Record<string, string[]>;
  correctionsLearned: number;
  results: ScanResult[];
  reportPath?: string;
}

function walkPdfs(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkPdfs(full));
    else if (entry.isFile() && /\.(pdf)$/i.test(entry.name)) files.push(full);
  }
  return files;
}

function groupByFolder(files: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const dir = path.dirname(f);
    const arr = groups.get(dir);
    if (arr) arr.push(f);
    else groups.set(dir, [f]);
  }
  return groups;
}

export async function scanFolder(
  db: AppDb,
  folderPath: string,
  options: {
    /** The scanning job's org: the historical-failure rows this writes are org-scoped. */
    orgId: string;
    defaultState?: string;
    defaultAhj?: string;
    defaultUtility?: string;
    useLlm?: boolean;
    onProgress?: (done: number, total: number, latest: string) => void;
  },
): Promise<ScanSummary> {
  const allFiles = walkPdfs(folderPath);
  const groups = groupByFolder(allFiles);

  const summary: ScanSummary = {
    scanned: 0,
    learned: 0,
    lowSignal: 0,
    errors: 0,
    byType: { permit_application: 0, sld: 0, issued_permit: 0, utility_bill: 0, correction: 0, unknown: 0 },
    byJurisdiction: {},
    profilesTouched: [],
    requiredDocsByAhj: {},
    correctionsLearned: 0,
    results: [],
  };
  const profiles = new Set<string>();
  let processed = 0;

  for (const [dir, files] of groups) {
    const anchor = folderAnchor(dir, files);
    const state = anchor?.state || options.defaultState || "";
    const ahj = options.defaultAhj || anchor?.city || "";

    // Learn the jurisdiction's required-document set from the folder's filenames.
    const folderDocLabels = Array.from(
      new Set(files.map((f) => canonicalDocLabel(f)).filter((l): l is string => Boolean(l))),
    );

    for (const filePath of files) {
      const filename = path.basename(filePath);
      options.onProgress?.(processed, allFiles.length, filename);
      processed++;
      summary.scanned++;

      try {
        const text = await extractPdfText(filePath, 12);
        const docType = classifyDoc(filePath, text);
        summary.byType[docType]++;

        const utility = utilityFromText(text) || options.defaultUtility || "";
        const docLabel = canonicalDocLabel(filePath) || undefined;

        // Build the requirement signal for this doc: the canonical label of this
        // file plus the wider folder packet.
        const requiredDocuments = Array.from(new Set([...(docLabel ? [docLabel] : []), ...folderDocLabels]));

        // Pull a correction sample if this is a correction/plan-check doc.
        let correctionText: string | undefined;
        if (docType === "correction") {
          const items = quickExtractCorrections(text).correctionItems;
          if (items && items.length) correctionText = items.join("\n");
        }

        // A doc with no jurisdiction anchor AND no recognisable signal teaches us
        // nothing — flag it for troubleshooting rather than silently dropping it.
        const hasSignal = Boolean(state || ahj || utility || requiredDocuments.length || correctionText);
        if (!hasSignal) {
          summary.lowSignal++;
          summary.results.push({
            filePath,
            docType,
            status: "low_signal",
            message: "No jurisdiction (city/state), utility, document type, or correction signal could be derived — nothing to learn.",
            docLabel,
          });
          continue;
        }

        const learned = learnFromHistoricalDocument(db, {
          orgId: options.orgId,
          state,
          ahj,
          utility,
          requiredDocuments,
          // The file name stays PRIVATE (org-scoped failure row + dedupe signature): past-project
          // files are named "First Last - City, ST.pdf". The shared profile gets docKind only.
          sourceLabel: `batch:${filename}`,
          docKind: docType,
          correctionText,
          notes: `Historical ${docType.replace(/_/g, " ")} (${ahj || "unknown AHJ"}, ${state || "??"}).`,
        });

        profiles.add(learned.profileKey);
        if (learned.learnedCorrection) summary.correctionsLearned++;

        const jurKey = `${ahj || "Unknown AHJ"}, ${state || "??"}`;
        summary.byJurisdiction[jurKey] = (summary.byJurisdiction[jurKey] || 0) + 1;
        if (folderDocLabels.length) summary.requiredDocsByAhj[jurKey] = folderDocLabels;

        summary.learned++;
        summary.results.push({
          filePath,
          docType,
          status: "learned",
          profileKey: learned.profileKey,
          docLabel,
          message: `Learned into ${jurKey}${docLabel ? ` — ${docLabel}` : ""}${learned.learnedCorrection ? " (+correction pattern)" : ""}.`,
        });
      } catch (err) {
        summary.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[batch-scan] ERROR ${filename}: ${msg}`);
        summary.results.push({ filePath, docType: "unknown", status: "error", message: msg });
      }
    }
  }

  summary.profilesTouched = Array.from(profiles);
  options.onProgress?.(allFiles.length, allFiles.length, "done");

  summary.reportPath = writeScanReport(folderPath, summary);
  printScanReport(summary);
  return summary;
}

// ---------------------------------------------------------------------------
// Reporting — terminal + on-disk, for troubleshooting as the dataset grows
// ---------------------------------------------------------------------------

const REPORT_DIR = process.env.BATCH_REPORT_DIR || path.join(process.cwd(), "backend", "data", "batch-reports");

function writeScanReport(folderPath: string, summary: ScanSummary): string | undefined {
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = path.join(REPORT_DIR, `scan-${stamp}.json`);
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ folderPath, generatedAt: new Date().toISOString(), summary }, null, 2),
    );

    // Human-readable troubleshooting report.
    const lines: string[] = [];
    lines.push(`Batch learning report — ${new Date().toISOString()}`);
    lines.push(`Source folder: ${folderPath}`);
    lines.push("");
    lines.push(`Scanned ${summary.scanned} PDFs — learned ${summary.learned}, low-signal ${summary.lowSignal}, errors ${summary.errors}.`);
    lines.push(`Knowledge profiles touched: ${summary.profilesTouched.length}. Correction patterns learned: ${summary.correctionsLearned}.`);
    lines.push("");
    lines.push("By document type:");
    for (const [t, n] of Object.entries(summary.byType)) if (n) lines.push(`  ${t.padEnd(20)} ${n}`);
    lines.push("");
    lines.push("By jurisdiction (docs learned):");
    for (const [j, n] of Object.entries(summary.byJurisdiction).sort((a, b) => b[1] - a[1])) lines.push(`  ${String(n).padStart(4)}  ${j}`);
    lines.push("");
    lines.push("Required-document packets learned per AHJ:");
    for (const [j, docs] of Object.entries(summary.requiredDocsByAhj)) {
      lines.push(`  ${j}:`);
      for (const d of docs) lines.push(`     - ${d}`);
    }
    lines.push("");
    const lowSignal = summary.results.filter((r) => r.status === "low_signal");
    if (lowSignal.length) {
      lines.push(`Low-signal files (${lowSignal.length}) — nothing learned, review naming/source:`);
      for (const r of lowSignal) lines.push(`  - ${path.basename(r.filePath)}`);
      lines.push("");
    }
    const errors = summary.results.filter((r) => r.status === "error");
    if (errors.length) {
      lines.push(`Errors (${errors.length}):`);
      for (const r of errors) lines.push(`  - ${path.basename(r.filePath)}: ${r.message}`);
      lines.push("");
    }
    const txtPath = path.join(REPORT_DIR, `scan-${stamp}.txt`);
    fs.writeFileSync(txtPath, lines.join("\n"));
    return txtPath;
  } catch (err) {
    console.error(`[batch-scan] could not write report: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function printScanReport(summary: ScanSummary): void {
  console.log("");
  console.log("──────────────────────────────────────────────────────────");
  console.log("[batch-scan] LEARNING SUMMARY");
  console.log(`  scanned:       ${summary.scanned}`);
  console.log(`  learned:       ${summary.learned}`);
  console.log(`  low-signal:    ${summary.lowSignal}`);
  console.log(`  errors:        ${summary.errors}`);
  console.log(`  KB profiles:   ${summary.profilesTouched.length}`);
  console.log(`  corrections:   ${summary.correctionsLearned}`);
  const topJur = Object.entries(summary.byJurisdiction).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (topJur.length) {
    console.log("  top jurisdictions:");
    for (const [j, n] of topJur) console.log(`     ${String(n).padStart(4)}  ${j}`);
  }
  if (summary.errors) {
    console.log(`  ⚠ ${summary.errors} file(s) errored — see report for details.`);
  }
  if (summary.reportPath) console.log(`  full report:   ${summary.reportPath}`);
  console.log("──────────────────────────────────────────────────────────");
  console.log("");
}
