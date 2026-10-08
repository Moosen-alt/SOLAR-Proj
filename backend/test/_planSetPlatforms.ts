// Two SYNTHETIC plan sets laid out the way two different design platforms lay out a sheet, built
// with pdf-lib so no binary is committed (#260). Every name, address and number is invented.
//
//   - Platform A: 11x17 landscape, the title block a narrow RIGHT-HAND column of short lines
//     (label on one line, value on the next), notes wrapped into a paragraph block.
//   - Platform B: letter landscape, the title block a BOTTOM strip of cells (label above value),
//     notes as a numbered list, a design-criteria TABLE (label and value on one row).
//
// What the text extractor sees differs: A's title block is one item per line, B's is cells side by
// side on two rows. Both carry the facts the consumers read: sheet titles the splitter files,
// design criteria, a 705.12 calculation, rapid shutdown, fire pathways, attachment spacing — and a
// meter number that WRAPS across two lines (rule 2: the scrub must still find it).
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

/** The invented meter number both fixtures print, split over a line break. */
export const SYNTHETIC_METER = "80 000 1234";

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const probe = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(probe, size) > width) { lines.push(line); line = word; } else line = probe;
  }
  if (line) lines.push(line);
  return lines;
}

function drawLines(page: PDFPage, font: PDFFont, lines: string[], x: number, y: number, size: number, lead = size + 3): number {
  lines.forEach((l, i) => page.drawText(l, { x, y: y - i * lead, size, font }));
  return y - lines.length * lead;
}

type Sheet = { number: string; title: string; notes: string[] };

const SHEETS: Sheet[] = [
  { number: "PV-1", title: "COVER SHEET", notes: [
    "8.40 KW DC / 7.60 KW AC ROOF MOUNTED PHOTOVOLTAIC SYSTEM WITH 21 MODULES AND MICROINVERTERS.",
    "ALL WORK SHALL CONFORM TO THE 2021 IRC, 2023 NEC AND ALL LOCAL AMENDMENTS.",
  ] },
  { number: "PV-2", title: "SITE PLAN", notes: [
    "FIRE PATHWAYS: 36 IN CLEAR ACCESS PATHWAY FROM EAVE TO RIDGE ON EACH ROOF PLANE WITH MODULES. 18 IN CLEAR SETBACK EACH SIDE OF THE RIDGE.",
    "NEW PV AC DISCONNECT LOCATED WITHIN 10 FT OF THE UTILITY METER. EXISTING UTILITY METER NO. 80 000 1234 ON THE EAST WALL.",
  ] },
  { number: "PV-3", title: "ATTACHMENT DETAIL", notes: [
    "ROOF FRAMING: 2X6 RAFTERS AT 24 IN O.C., COMPOSITION SHINGLE, ONE LAYER. ATTACHMENT SPACING 48 IN O.C. MAX, STAGGERED, INTO RAFTERS.",
    "GROUND SNOW LOAD 25 PSF. ULTIMATE WIND SPEED 110 MPH. WIND EXPOSURE CATEGORY C. PV DEAD LOAD 2.7 PSF.",
  ] },
  { number: "PV-4", title: "ONE-LINE DIAGRAM", notes: [
    "RAPID SHUTDOWN PER NEC 690.12 PROVIDED BY MODULE-LEVEL MICROINVERTERS; INITIATOR AT THE SERVICE DISCONNECT.",
    "NEC 705.12(B)(3)(2): 200A BUS BAR X 120% = 240A ALLOWABLE; 175A MAIN BREAKER + 40A PV OCPD = 215A, LESS THAN 240A - COMPLIES.",
    "MICROINVERTERS UL 1741-SB LISTED. RACKING UL 2703 LISTED.",
  ] },
  { number: "PV-5", title: "WARNING LABELS", notes: [
    "PLACARD AND LABEL LOCATIONS PER NEC 690.56 AND 705.10. PV SYSTEM DISCONNECT LABEL AT THE AC DISCONNECT.",
  ] },
  { number: "PV-6", title: "PV MODULE SPECIFICATION SHEET", notes: [
    "EXAMPLE SOLAR XS-400 400W MODULE, UL 61730 LISTED.",
  ] },
  { number: "PV-7", title: "MICROINVERTER SPECIFICATIONS", notes: [
    "EXAMPLE POWER MX-290 MICROINVERTER, 290 VA, UL 1741-SB LISTED.",
  ] },
];

const COMPANY = "EXAMPLE SOLAR INSTALLERS (FICTITIOUS)";
const PROJECT = "SYNTHETIC RESIDENCE";
const ADDRESS = "123 EXAMPLE WAY, ANYTOWN ST 00000";

/** Platform A: 11x17 landscape, right-column title block, wrapped note paragraphs. */
export async function platformAPlanSet(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const sheet of SHEETS) {
    const page = pdf.addPage([1224, 792]);
    let y = 740;
    page.drawText(sheet.title, { x: 60, y, size: 18, font: bold });
    y -= 30;
    if (sheet.number === "PV-1") {
      y = drawLines(page, font, ["SHEET INDEX", ...SHEETS.map((s) => `${s.number} ${s.title}`)], 60, y, 10);
      y -= 10;
    }
    for (const note of sheet.notes) y = drawLines(page, font, wrap(font, note, 9, 380), 60, y, 9) - 6;
    // The title block: one short item per line, label above value.
    drawLines(page, font, [
      COMPANY.slice(0, 24), COMPANY.slice(24).trim(),
      "PROJECT NAME:", PROJECT, ADDRESS.split(",")[0], ADDRESS.split(",")[1].trim(),
      "SHEET TITLE:", sheet.title, "SHEET NUMBER:", sheet.number,
      "SYNTHETIC - NOT FOR CONSTRUCTION",
    ], 1050, 700, 8, 14);
  }
  return Buffer.from(await pdf.save());
}

/** Platform B: letter landscape, bottom-strip title block (label row over value row), numbered
 *  notes, and a design-criteria table whose label and value share a row. */
export async function platformBPlanSet(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const sheet of SHEETS) {
    const page = pdf.addPage([792, 612]);
    page.drawText(`${sheet.number} ${sheet.title}`, { x: 36, y: 570, size: 14, font });
    let y = 540;
    if (sheet.number === "PV-1") {
      y = drawLines(page, font, ["SHEET INDEX", ...SHEETS.map((s) => `${s.number} ${s.title}`)], 36, y, 9);
      y -= 8;
    }
    if (sheet.number === "PV-3") {
      // The criteria table: label column and value column on the same row.
      [["GROUND SNOW LOAD", "25 PSF"], ["ULTIMATE WIND SPEED", "110 MPH"], ["WIND EXPOSURE CATEGORY", "C"]].forEach(([label, value], row) => {
        page.drawText(label, { x: 420, y: 520 - row * 14, size: 9, font });
        page.drawText(value, { x: 600, y: 520 - row * 14, size: 9, font });
      });
    }
    sheet.notes.forEach((note, i) => {
      y = drawLines(page, font, wrap(font, `${i + 1}. ${note}`, 9, 360), 36, y, 9) - 4;
    });
    // The bottom strip: four cells, label row above value row.
    const cells: Array<[string, string]> = [["CONTRACTOR", COMPANY], ["PROJECT", PROJECT], ["ADDRESS", ADDRESS], ["SHEET", sheet.number]];
    cells.forEach(([label, value], i) => {
      page.drawText(label, { x: 36 + i * 190, y: 56, size: 7, font });
      page.drawText(value, { x: 36 + i * 190, y: 44, size: 7, font });
    });
    page.drawText("SYNTHETIC - NOT FOR CONSTRUCTION", { x: 36, y: 24, size: 7, font });
  }
  return Buffer.from(await pdf.save());
}

/** The CAD layouts the #260 review reproduced regressions on, one per sheet: a fire note wrapped
 *  between FIRE and SETBACK; a framing TABLE (header row over value row) and a "RAFTERS:" label
 *  over its value; a two-line "ATTACHMENT / DETAIL" title; a period-free equipment schedule whose
 *  every row is a digest topic; and a meter label on the line ABOVE its space-grouped digits. */
export async function wrapLayoutPlanSet(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sheet = (lines: string[]) => drawLines(pdf.addPage([792, 612]), font, lines, 36, 570, 9);
  sheet(["PV-1 SITE PLAN", "ARRAY KEEPS A 36 IN CLEAR FIRE", "SETBACK FROM THE RIDGE AND EAVE"]);
  sheet(["PV-2 ROOF FRAMING", "RAFTERS   SIZE   SPACING   SPAN", "ROOF 1   2X6   24 IN O.C.   12 FT", "RAFTERS:", "2X6 @ 24 IN O.C."]);
  sheet(["PV-3", "ATTACHMENT", "DETAIL", "FLASHED STANDOFF INTO RAFTER, 48 IN O.C. MAX"]);
  sheet(["PV-4 EQUIPMENT SCHEDULE", ...Array.from({ length: 30 }, (_, i) =>
    [`AC DISCONNECT ${i + 1} 60A FUSED`, `BATTERY UNIT ${i + 1} 13 KWH`, `RAPID SHUTDOWN DEVICE ${i + 1}`][i % 3])]);
  sheet(["PV-5 ELECTRICAL LINE DIAGRAM", "UTILITY METER NO.", SYNTHETIC_METER, "SEE ONE-LINE FOR TIE IN", "LOAD SIDE TAP, 200A BUS BAR"]);
  return Buffer.from(await pdf.save());
}
