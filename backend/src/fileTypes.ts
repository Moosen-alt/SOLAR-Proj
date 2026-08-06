// What a file ACTUALLY is, from its leading bytes — not from its extension or the
// Content-Type the browser guessed. Design houses send us whatever their CAD or
// plan software exported, sometimes renamed by hand, so the filename lies often
// enough to matter: a ".pdf" that is really a DWG, a ".dwg" that is really a ZIP
// container, a plan set someone saved as a .png.
//
// This exists because an unvalidated upload used to fail SILENTLY and late: the
// bytes were stored, text extraction wrote the "[no text layer]" marker, the
// project counted a plan set as present, and the failure only surfaced when the
// splitter tried to parse it as a PDF and threw a 500 with no explanation the
// operator could act on. Catching it at the door turns that into one sentence
// telling them exactly what to send instead.

// Longest magic prefix we compare against.
const SNIFF_BYTES = 12;

export type SniffedKind = "pdf" | "zip" | "png" | "jpeg" | "gif" | "tiff" | "heic" | "dwg" | "dxf" | "rtf" | "unknown";

function startsWith(buf: Buffer, sig: number[] | string, offset = 0): boolean {
  const bytes = typeof sig === "string" ? Buffer.from(sig, "latin1") : Buffer.from(sig);
  if (buf.length < offset + bytes.length) return false;
  return buf.compare(bytes, 0, bytes.length, offset, offset + bytes.length) === 0;
}

/**
 * Identify a file from its leading bytes. Returns "unknown" rather than guessing —
 * callers decide whether unknown is acceptable for a given slot.
 */
export function sniffFileKind(buffer: Buffer): SniffedKind {
  if (!buffer || buffer.length < 4) return "unknown";
  const head = buffer.subarray(0, SNIFF_BYTES);
  // Some writers emit a UTF-8 BOM or stray whitespace ahead of "%PDF-"; readers
  // (pdf-lib included) tolerate a few bytes of slack, so we should too.
  const pdfAt = head.indexOf("%PDF-", 0, "latin1");
  if (pdfAt >= 0 && pdfAt <= 4) return "pdf";
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return "zip";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(head, "GIF87a") || startsWith(head, "GIF89a")) return "gif";
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  // HEIC/HEIF from iPhone camera rolls: "....ftypheic" / "ftypmif1" at offset 4.
  if (startsWith(head, "ftyp", 4)) {
    const brand = buffer.subarray(8, 12).toString("latin1");
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return "heic";
  }
  // AutoCAD DWG: "AC" + a 4-digit version code ("AC1027" = AutoCAD 2013).
  if (startsWith(head, "AC10") || startsWith(head, "AC1.") || startsWith(head, "AC2.")) return "dwg";
  if (startsWith(head, "{\\rtf")) return "rtf";
  // DXF is plain text; the interchange header is near the top.
  const textHead = buffer.subarray(0, 512).toString("latin1");
  if (/^\s*0\s*[\r\n]+\s*SECTION\s*[\r\n]+\s*2\s*[\r\n]+\s*HEADER/i.test(textHead)) return "dxf";
  if (/^\s*999[\r\n]/.test(textHead) && /SECTION/i.test(textHead)) return "dxf";
  return "unknown";
}

export function isImageKind(kind: SniffedKind): boolean {
  return kind === "png" || kind === "jpeg" || kind === "gif" || kind === "tiff" || kind === "heic";
}

// Native design/CAD formats we can store as reference but can never read, split,
// extract text from, or hand to an AHJ portal (portal file inputs take PDFs).
// Extension is the only signal for several of these (RVT/SKP/PLN are compound
// containers with no stable public magic), so we check both.
const CAD_EXTENSIONS = /\.(dwg|dxf|dwf|dwfx|rvt|rfa|rte|skp|pln|pla|dgn|iam|ipt|3dm|sldprt|slddrw|catpart|step|stp|iges|igs)$/i;

export function looksLikeCad(filename: string, kind: SniffedKind): boolean {
  return kind === "dwg" || kind === "dxf" || CAD_EXTENSIONS.test(filename || "");
}

/** Human-facing name for a sniffed kind, for error messages. */
export function describeKind(kind: SniffedKind, filename: string): string {
  if (kind === "unknown") {
    const ext = /\.([A-Za-z0-9]{1,8})$/.exec(filename || "")?.[1];
    return ext ? `a .${ext.toLowerCase()} file` : "an unrecognized file";
  }
  const names: Record<Exclude<SniffedKind, "unknown">, string> = {
    pdf: "a PDF", zip: "a ZIP archive", png: "a PNG image", jpeg: "a JPEG image",
    gif: "a GIF image", tiff: "a TIFF image", heic: "a HEIC image (iPhone photo)",
    dwg: "an AutoCAD DWG drawing", dxf: "a DXF drawing", rtf: "an RTF document",
  };
  return names[kind];
}
