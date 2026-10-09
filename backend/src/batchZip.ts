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

// EACH ORG EXTRACTS UNDER ITS OWN ROOT (#276). One shared root let a tenant point
// /api/batch-import/scan at another tenant's extracted zip (or the root itself) and read
// its project-document paths back through its own, correctly scoped, job list. The org id
// is sanitized like the label so it can never climb out of UPLOAD_ROOT.
export function batchUploadRoot(orgId: string): string {
  const safeOrg = orgId.replace(/[^a-z0-9._-]+/gi, "_").replace(/^\.+/, "_").slice(0, 80) || "_";
  return path.join(UPLOAD_ROOT, safeOrg);
}

// True when `folder` lies strictly INSIDE `root`, judged on resolved paths (and on real
// paths where they exist, so a symlink or `..` cannot step out). The root itself does not
// count: scanning it would read every upload at once.
export function folderWithinRoot(folder: string, root: string): boolean {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(folder).startsWith(real(root) + path.sep);
}

// Extract a zip buffer into a fresh working folder under the org's own root and report
// how many PDFs it contains. The folder scanner walks this directory recursively afterward.
export function extractZipToWorkdir(zipBuffer: Buffer, label: string, orgId: string): ExtractedZip {
  const root = batchUploadRoot(orgId);
  fs.mkdirSync(root, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 40) || "upload";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const folderPath = path.join(root, `${safeLabel}-${stamp}`);
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
