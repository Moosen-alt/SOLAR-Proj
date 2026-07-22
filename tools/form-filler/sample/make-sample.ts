// Generates a demo blank "Permit Fee Refund Request" AcroForm PDF so the tool
// can be tried end-to-end offline:
//   npx tsx sample/make-sample.ts
//   npx tsx src/cli.ts inspect sample/refund-request-blank.pdf
//   npx tsx src/cli.ts map     sample/refund-request-blank.pdf --data sample/refund-requests.csv
//   npx tsx src/cli.ts fill    sample/refund-request-blank.pdf \
//       --map sample/refund-request-blank.map.json --data sample/refund-requests.csv \
//       --out sample/filled --name "{Permit Number} refund.pdf"
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText("CITY BUILDING DEPARTMENT — PERMIT FEE REFUND REQUEST", {
    x: 60, y: 740, size: 12, font, color: rgb(0, 0, 0),
  });
  const label = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();

  let y = 700;
  const addText = (name: string, width = 220): void => {
    page.drawText(`${name}:`, { x: 60, y: y + 4, size: 9, font: label });
    const f = form.createTextField(name);
    f.addToPage(page, { x: 200, y, width, height: 16 });
    y -= 32;
  };
  addText("Permit Number");
  addText("Project Address", 300);
  addText("Applicant Name");
  addText("Mailing Address", 300);
  addText("Phone");
  addText("Email");
  addText("Refund Amount Requested", 120);
  addText("Reason For Refund", 320);

  page.drawText("Refund Type:", { x: 60, y: y + 4, size: 9, font: label });
  const kind = form.createDropdown("Refund Type");
  kind.addOptions(["Full Refund", "Partial Refund"]);
  kind.addToPage(page, { x: 200, y, width: 140, height: 16 });
  y -= 32;

  page.drawText("Fee was paid by the applicant:", { x: 60, y: y + 2, size: 9, font: label });
  const paid = form.createCheckBox("Paid By Applicant");
  paid.addToPage(page, { x: 220, y, width: 12, height: 12 });
  y -= 48;

  page.drawText("Applicant Signature: ______________________________        Date: ____________", {
    x: 60, y, size: 9, font: label,
  });

  fs.writeFileSync(path.join(here, "refund-request-blank.pdf"), await doc.save());
  console.log("wrote sample/refund-request-blank.pdf");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
