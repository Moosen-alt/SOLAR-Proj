// THE ONE SET OF OPTIONS EVERY SERVER-SIDE pdfjs getDocument() OPENS WITH (#207).
//
// pdfjs renders a NON-EMBEDDED standard font (Symbol, ZapfDingbats, and — without useSystemFonts —
// Helvetica/Times/Courier: the 14 fonts a form generator may reference without embedding) from the
// Foxit/Liberation files it ships in pdfjs-dist/standard_fonts/. Without `standardFontDataUrl` it
// cannot find them and prints "Warning: UnknownErrorException: Ensure that the `standardFontDataUrl`
// API parameter is provided." once per font per document — dozens per project across the splitter
// thumbnails, vision page reads and form fills, burying the warnings that matter. Renders completed
// anyway (with a substitute face), so this is noise, not a fix to output.
//
// Every call site spreads pdfjsDocumentOptions() so none can forget the path. Under Node pdfjs reads
// the URL with fs.readFile (node_utils_fetchData), so a plain filesystem path works — but it must end
// in "/" (getFactoryUrlProp throws otherwise), and forward slashes keep it valid on Windows too.

import path from "node:path";
import { createRequire } from "node:module";

let cached: string | null = null;

/** pdfjs-dist's bundled standard_fonts directory, as the trailing-slash path pdfjs requires. */
export function pdfjsStandardFontDataUrl(): string {
  if (cached == null) {
    const req = createRequire(import.meta.url);
    const dir = path.join(path.dirname(req.resolve("pdfjs-dist/package.json")), "standard_fonts");
    cached = `${dir.split(path.sep).join("/")}/`;
  }
  return cached;
}

/** The caller's getDocument options plus `standardFontDataUrl`. `data` and the caller's own flags
 *  (useSystemFonts, disableWorker) pass through unchanged. */
export function pdfjsDocumentOptions<T extends object>(opts: T): T & { standardFontDataUrl: string } {
  return { ...opts, standardFontDataUrl: pdfjsStandardFontDataUrl() };
}
