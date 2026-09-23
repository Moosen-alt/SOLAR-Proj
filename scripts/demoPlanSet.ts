// The demo plan set: one real multi-sheet PDF, shared by scripts/demo-environment.ts (which
// seeds a fresh demo DB) and any repair of an already-built kit, so the two cannot drift.
import { PDFDocument, StandardFonts } from "pdf-lib";

// One real multi-sheet plan set, reused for every demo project. Sheet titles are the ones
// the splitter recognises, so splitting produces genuine site_plan / sld / structural /
// spec parts rather than an empty package.
export async function buildPlanSetPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sheets: Array<[string, string]> = [
    ["SITE PLAN", "Array location, fire access pathways and setbacks shown. Demonstration sheet."],
    ["ELECTRICAL LINE DIAGRAM", "3-line: modules, microinverters, AC disconnect. RAPID SHUTDOWN initiator at the array per NEC 690.12; PV Rapid Shutdown System placard at the service. NEC 705.12(B)(3)(2) load-side calculation: 200A bus bar x 120% = 240A allowable; 175A main breaker + 40A PV OCPD = 215A, which is less than 240A - COMPLIES. Load-side breaker landed at the opposite end of the bus from the main."],
    ["ROOF SECTION", "Roof framing: pre-engineered trusses, 2x4 top chord at 24 in o.c., clear span 11 ft 6 in, DF-L No.2. Ground snow load 25 psf, PV dead load 2.6 psf, wind exposure B. Attachment detail: lag screws into truss top chord with flashed standoffs at 48 in o.c."],
    ["PV MODULE SPECIFICATION SHEET", "Q CELLS Q.TRON BLK M-G2.C1+ 430W."],
    ["MICROINVERTER SPECIFICATIONS", "Enphase IQ8PLUS-72-2-US microinverter, 290W AC, UL 1741-SB listed."],
    ["WARNING LABELS", "NEC 690/705 placard and label location schedule."],
  ];
  for (const [title, body] of sheets) {
    const page = pdf.addPage([612, 792]);
    page.drawText(title, { x: 54, y: 706, size: 22, font });
    // WRAPPED, not one drawText. A single line ran off the right edge of the sheet, and the
    // text past the edge was lost to extraction too — the reviewer gate then flagged
    // "Racking/attachment detail missing" on a sheet whose last sentence IS the attachment
    // detail, and every kit project carried that false blocker.
    const lines: string[] = [];
    let line = "";
    for (const word of body.split(/\s+/)) {
      const probe = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(probe, 10) > 612 - 2 * 54) { lines.push(line); line = word; } else line = probe;
    }
    if (line) lines.push(line);
    lines.forEach((l, i) => page.drawText(l, { x: 54, y: 664 - i * 14, size: 10, font }));
    page.drawText("SOLARIS DEMO CO — DEMONSTRATION PLAN SET, NOT FOR CONSTRUCTION", { x: 54, y: 60, size: 9, font });
  }
  return Buffer.from(await pdf.save());
}
