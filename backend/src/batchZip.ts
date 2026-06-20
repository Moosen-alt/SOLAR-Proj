import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

// Where uploaded zips get extracted before the folder scan runs.
const UPLOAD_ROOT = path.resolve(process.cwd(), process.env.BATCH_UPLOAD_DIR || "backend/data/batch-uploads");

export interface ExtractedZip {
  folderPath: string;
  pdfCount: number;
  totalEntries: number;
}

// Extract a zip buffer into a fresh working folder and report how many PDFs
// it contains. The folder scanner walks this directory recursively afterward.
export function extractZipToWorkdir(zipBuffer: Buffer, label = "upload"): ExtractedZip {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 40) || "upload";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const folderPath = path.join(UPLOAD_ROOT, `${safeLabel}-${stamp}`);
  fs.mkdirSync(folderPath, { recursive: true });

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  let pdfCount = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    // Guard against zip-slip: resolve and confirm the target stays inside folderPath.
    const target = path.join(folderPath, entry.entryName);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(folderPath) + path.sep)) continue;
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, entry.getData());
    if (/\.pdf$/i.test(entry.entryName)) pdfCount++;
  }
  return { folderPath, pdfCount, totalEntries: entries.length };
}
