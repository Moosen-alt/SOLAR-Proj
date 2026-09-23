// WHAT A PORTAL IS HANDED WHEN REPLAY ATTACHES A DOCUMENT — one function, both paths.
//
// Stored project files carry a UUID prefix for on-disk uniqueness
// ("cf33f760-...-terrence-boyd-plan-set.pdf"). That prefix must never reach the portal: the
// reviewer sees the attachment's name. The recorded upload step stripped it; the unrecorded
// upload sweep did not, and passed the raw stored path — so the same document arrived under
// two different names depending on which path attached it (and the PDF-wrap branch used a
// looser regex than the plain branch). One predicate, one place: every replay attach builds
// its payload here.
//
// A LARGE DOCUMENT CANNOT TRAVEL AS A BUFFER. Playwright refuses a buffer payload of 50MB or
// more ("Cannot set buffer larger than 50Mb, please write it to a file and pass its path
// instead"). A plan set with photos passes that easily, and the callers' catch turned the
// refusal into "no document attached", in silence. So a large file is staged as a PATH: a
// temp file whose basename IS the clean display name — the portal still sees the clean name
// and there is no size limit. The browser reads a path-backed file lazily (when the portal
// uploads it, which can be at the human's final submit), so the staged copy must outlive the
// attach: the caller owns `tempDir` and removes it only once the browser is gone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pdfNameFor } from "../imageToPdf";

const STORED_UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

/** Playwright's own ceiling for buffer payloads (fileUploadSizeLimit: `>=` this throws). */
export const INLINE_UPLOAD_LIMIT = 50 * 1024 * 1024;

/** Staged copies left behind by a run that never closed (crash, killed process) are removed
 *  by the next staging after this long — long past any browser that could still read them. */
const STALE_STAGING_MS = 7 * 24 * 60 * 60 * 1000;
const STAGING_PREFIX = "solar-upload-";

/** The filename a portal reviewer should see: the stored basename minus its UUID prefix. */
export function uploadDisplayName(filePath: string): string {
  const base = path.basename(String(filePath ?? ""));
  return base.replace(STORED_UUID_PREFIX, "") || base;
}

export interface UploadFilePayload { name: string; mimeType: string; buffer: Buffer }

export interface PreparedUpload {
  /** What to hand setInputFiles / FileChooser.setFiles. */
  file: UploadFilePayload | string;
  /** A staging directory this call created (large files only), else null. The CALLER removes
   *  it (removeUploadStaging) once no browser can still read it — never right after the
   *  attach, since the portal may read the file only at submit. */
  tempDir: string | null;
}

function pruneStaleStaging(): void {
  try {
    const root = os.tmpdir();
    const cutoff = Date.now() - STALE_STAGING_MS;
    for (const entry of fs.readdirSync(root)) {
      if (!entry.startsWith(STAGING_PREFIX)) continue;
      const full = path.join(root, entry);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
      } catch { /* another process's dir, or already gone */ }
    }
  } catch { /* best-effort */ }
}

/** Stage `write` under `name` in a fresh temp dir; the path, or null if it could not be done. */
function stageAsPath(name: string, write: (target: string) => void): PreparedUpload | null {
  pruneStaleStaging();
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), STAGING_PREFIX));
    const target = path.join(dir, name);
    write(target);
    return { file: target, tempDir: dir };
  } catch {
    if (dir) removeUploadStaging(dir);
    return null;
  }
}

/** Remove a staging dir uploadPayloadFor created. Only ever touches its own prefix. */
export function removeUploadStaging(dir: string | null | undefined): void {
  if (!dir) return;
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(STAGING_PREFIX)) return;
  try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** The payload for setInputFiles / FileChooser.setFiles. `pdf` is the image-wrapped PDF when
 *  the slot refuses the image but takes a PDF (see imageToPdf.ts), else null. Falls back to
 *  the raw path only when the file cannot be read, letting Playwright report the real error. */
export function uploadPayloadFor(filePath: string, pdf: Buffer | null): PreparedUpload {
  const name = uploadDisplayName(filePath);
  if (pdf) {
    const pdfName = pdfNameFor(name);
    if (pdf.byteLength < INLINE_UPLOAD_LIMIT) {
      return { file: { name: pdfName, mimeType: "application/pdf", buffer: pdf }, tempDir: null };
    }
    return stageAsPath(pdfName, (t) => fs.writeFileSync(t, pdf)) ?? { file: filePath, tempDir: null };
  }
  try {
    const size = fs.statSync(filePath).size;
    if (size >= INLINE_UPLOAD_LIMIT) {
      // A hard link costs nothing on the same volume; a copy covers a temp dir elsewhere.
      return stageAsPath(name, (t) => {
        try { fs.linkSync(filePath, t); } catch { fs.copyFileSync(filePath, t); }
      }) ?? { file: filePath, tempDir: null };
    }
    const ext = path.extname(name).toLowerCase();
    const mimeType = ext === ".pdf" ? "application/pdf"
      : ext === ".png" ? "image/png"
      : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".zip" ? "application/zip"
      : "application/octet-stream";
    return { file: { name, mimeType, buffer: fs.readFileSync(filePath) }, tempDir: null };
  } catch {
    return { file: filePath, tempDir: null }; // unreadable — let Playwright read the path itself
  }
}
