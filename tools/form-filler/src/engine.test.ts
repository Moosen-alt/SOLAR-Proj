// Unit tests for the standalone form filler: AcroForm fill (text/checkbox/
// dropdown/maxLength), overlay fill (draw + onlyIf + maxWidth + nudge),
// signature stamping, CSV parsing, heuristic auto-map, and name templating.
// Plain tsx script, repo convention: `npx tsx tools/form-filler/src/engine.test.ts`.
import { PDFDocument } from "pdf-lib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRows, parseCsv, renderName, sanitizeFilename } from "./data";
import { fillPdf, isTruthy, normalizeName, pdfSafeText, resolveSource, rowValue, unknownRowSources } from "./engine";
import { heuristicAcroMap } from "./autoMap";
import { inspectPdf } from "./inspect";
import { extractPdfText } from "./render";
import type { FormMap } from "./types";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

// 1x1 red-pixel PNG, for signature stamping.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function buildAcroFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const permit = form.createTextField("Permit Number");
  permit.addToPage(page, { x: 60, y: 700, width: 200, height: 18 });
  const applicant = form.createTextField("Applicant Name");
  applicant.addToPage(page, { x: 60, y: 670, width: 200, height: 18 });
  const amount = form.createTextField("Refund Amount");
  amount.setMaxLength(8);
  amount.addToPage(page, { x: 60, y: 640, width: 100, height: 18 });
  const paid = form.createCheckBox("Paid By Applicant");
  paid.addToPage(page, { x: 60, y: 610, width: 14, height: 14 });
  const kind = form.createDropdown("Refund Type");
  kind.addOptions(["Full Refund", "Partial Refund"]);
  kind.addToPage(page, { x: 60, y: 580, width: 160, height: 18 });
  return doc.save();
}

async function buildFlatFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}

async function main(): Promise<void> {
  // --- source resolution ------------------------------------------------
  const row = { "Permit Number": "BP-2025-0421", "applicant name": "Dana Reyes", Amount: "150.00" };
  check("resolveSource lit", resolveSource("lit:X", row) === "X");
  check("resolveSource row exact", resolveSource("row.Permit Number", row) === "BP-2025-0421");
  check("resolveSource row case/punct-insensitive", resolveSource("row.Applicant_Name", row) === "Dana Reyes");
  check("resolveSource missing column -> empty", resolveSource("row.Nope", row) === "");
  check("resolveSource computed.today override", resolveSource("computed.today", row, "07/22/2026") === "07/22/2026");
  check("resolveSource computed.today format", /^\d{2}\/\d{2}\/\d{4}$/.test(resolveSource("computed.today", row)));
  check("rowValue exact beats fuzzy", rowValue({ ab: "1", "a b": "2" }, "ab") === "1");
  check("normalizeName strips punctuation", normalizeName("Permit #_Number!") === "permitnumber");

  // --- truthiness (shared by checkbox + overlay onlyIf) -----------------
  check("isTruthy yes-ish", isTruthy("Yes") && isTruthy("1") && isTruthy("x"));
  check("isTruthy no-ish", !isTruthy("") && !isTruthy("no") && !isTruthy("0") && !isTruthy("false") && !isTruthy(" N "));

  // --- pdf-safe text normalization --------------------------------------
  check("pdfSafeText maps smart quotes", pdfSafeText("‘a’ “b”").text === "'a' \"b\"" && pdfSafeText("‘a’").lossy === 0);
  check("pdfSafeText maps dash/ellipsis/nbsp", pdfSafeText("a—b…c d").text === "a-b...c d");
  check("pdfSafeText keeps Latin-1", pdfSafeText("José Peña").text === "José Peña" && pdfSafeText("José").lossy === 0);
  check("pdfSafeText replaces out-of-range + counts", pdfSafeText("Ał\u{1F600}B").text === "A??B" && pdfSafeText("Ał\u{1F600}B").lossy === 2);

  // --- CSV parsing ------------------------------------------------------
  const csv = '﻿Name,Address,Note\r\n"Reyes, Dana","123 ""A"" St","line1\nline2"\r\nBo,,\r\n,,\r\n';
  const grid = parseCsv(csv);
  check("csv row count (empty row dropped)", grid.length === 3, JSON.stringify(grid.length));
  check("csv BOM stripped", grid[0][0] === "Name");
  check("csv quoted comma", grid[1][0] === "Reyes, Dana");
  check("csv escaped quotes", grid[1][1] === '123 "A" St');
  check("csv newline inside quotes", grid[1][2] === "line1\nline2");
  check("csv sparse row", grid[2][0] === "Bo" && grid[2][1] === "");
  const midQuote = parseCsv('A,B\n12" pipe,ok\n');
  check("csv mid-field quote is literal", midQuote[1][0] === '12" pipe' && midQuote[1][1] === "ok", JSON.stringify(midQuote[1]));

  // --- loadRows JSON edge cases ----------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ff-data-"));
  const emptyJson = path.join(tmp, "empty.json");
  fs.writeFileSync(emptyJson, "[]");
  let emptyThrew = false;
  try { loadRows(emptyJson); } catch { emptyThrew = true; }
  check("loadRows rejects empty JSON array", emptyThrew);
  const bomJson = path.join(tmp, "bom.json");
  fs.writeFileSync(bomJson, `﻿[{"Permit Number":"BP-9"}]`);
  check("loadRows tolerates JSON BOM", loadRows(bomJson).rows[0]["Permit Number"] === "BP-9");

  // --- name templating --------------------------------------------------
  check("renderName column + n", renderName("{Permit Number}-{n}.pdf", row, 4) === "BP-2025-0421-005.pdf");
  check("renderName fuzzy column", renderName("{applicant_name}.pdf", row, 0) === "Dana Reyes.pdf");
  check("renderName appends .pdf", renderName("{Amount}", row, 0) === "150.00.pdf");
  check("sanitize strips path chars", sanitizeFilename("a/b\\c:d.pdf") === "a_b_c_d.pdf");
  check("sanitize keeps replaced path chars distinct", sanitizeFilename("///") === "___.pdf");
  check("sanitize empty -> filled.pdf", sanitizeFilename(" . ") === "filled.pdf");

  // --- AcroForm fill ----------------------------------------------------
  const acroBytes = await buildAcroFixture();
  const inspection = await inspectPdf(acroBytes);
  check("inspect finds fields", inspection.hasAcroFields && inspection.fields.length === 5, JSON.stringify(inspection.fields.map((f) => f.name)));
  check("inspect dropdown options", inspection.fields.find((f) => f.name === "Refund Type")?.options?.length === 2);
  check("inspect maxLength", inspection.fields.find((f) => f.name === "Refund Amount")?.maxLength === 8);

  const acroMap: FormMap = {
    formName: "Test Refund Request",
    fillMode: "acroform",
    textFields: {
      "Permit Number": "row.Permit Number",
      "Applicant Name": "row.Applicant Name",
      "Refund Amount": "row.Amount",
      "Refund Type": "row.Refund Type",
      "Missing Field": "row.Amount",
    },
    checkboxes: { "Paid By Applicant": { source: "row.Paid By Applicant", equals: "yes" } },
  };
  const acroRow = {
    "Permit Number": "BP-2025-0421",
    "Applicant Name": "Dana Reyes",
    Amount: "1234567890.00", // exceeds maxLength 8 -> truncated
    "Refund Type": "partial refund", // fuzzy option match
    "Paid By Applicant": "Yes",
  };
  const filled = await fillPdf(acroBytes, acroMap, acroRow, { flatten: false });
  check("acroform filled count", filled.filledCount === 5, String(filled.filledCount));
  check("acroform unmapped reported", filled.unmapped.length === 1 && filled.unmapped[0] === "Missing Field", JSON.stringify(filled.unmapped));
  const reloaded = await PDFDocument.load(filled.bytes);
  const rform = reloaded.getForm();
  check("text field value", rform.getTextField("Permit Number").getText() === "BP-2025-0421");
  check("maxLength truncation", rform.getTextField("Refund Amount").getText() === "12345678");
  check("checkbox equals rule", rform.getCheckBox("Paid By Applicant").isChecked());
  check("dropdown fuzzy select", rform.getDropdown("Refund Type").getSelected()[0] === "Partial Refund");

  // Unchecked path + flatten.
  const filled2 = await fillPdf(acroBytes, acroMap, { ...acroRow, "Paid By Applicant": "no" }, {});
  const reloaded2 = await PDFDocument.load(filled2.bytes);
  check("flatten removes fields", reloaded2.getForm().getFields().length === 0, String(reloaded2.getForm().getFields().length));
  const flatText = (await extractPdfText(filled2.bytes)).join(" ");
  check("flattened output keeps values", flatText.includes("BP-2025-0421") && flatText.includes("Dana Reyes"), flatText.slice(0, 200));

  // Checkbox-only hand-written map (textFields omitted) must not crash.
  const checkboxOnly = { formName: "cb", fillMode: "acroform", checkboxes: { "Paid By Applicant": { source: "row.Paid By Applicant" } } } as unknown as FormMap;
  const cbFilled = await fillPdf(acroBytes, checkboxOnly, { "Paid By Applicant": "1" }, { flatten: false });
  check("checkbox-only map does not crash", cbFilled.filledCount === 1 && cbFilled.unmapped.length === 0, JSON.stringify({ f: cbFilled.filledCount, u: cbFilled.unmapped }));

  // Non-Latin data is sanitized (surfaced via sanitizedCount), not aborted.
  const uni = await fillPdf(acroBytes, { formName: "u", fillMode: "acroform", textFields: { "Applicant Name": "row.Applicant Name" } }, { "Applicant Name": "Małgorzata \u{1F600}" }, {});
  check("acroform sanitizes + counts", uni.sanitizedCount === 2 && uni.filledCount === 1, String(uni.sanitizedCount));

  // --- overlay fill -----------------------------------------------------
  const flatBytes = await buildFlatFixture();
  const overlayMap: FormMap = {
    formName: "Flat Test",
    fillMode: "overlay",
    textFields: {},
    overlayFields: [
      { source: "row.Applicant Name", page: 0, x: 100, y: 700, size: 10 },
      { source: "lit:X", page: 0, x: 60, y: 650, size: 9 },
      { source: "computed.today", page: 0, x: 100, y: 600, size: 9 },
      { source: "row.Amount", page: 0, x: 100, y: 550, size: 10, maxWidth: 30 }, // forces truncation
      { source: "lit:SHOULD-NOT-APPEAR", page: 0, x: 100, y: 500, onlyIf: { source: "row.Missing" } },
      { source: "lit:CONDITIONAL", page: 0, x: 100, y: 470, onlyIf: { source: "row.Refund Type", equals: "Partial Refund" } },
      { source: "lit:off-page", page: 7, x: 10, y: 10 }, // silently skipped
    ],
    signatureFields: [
      { page: 0, x: 100, y: 120, width: 150, height: 24, dateX: 300, dateY: 120, dateSize: 9 },
    ],
  };
  const overlayRow = { "Applicant Name": "Dana Reyes", Amount: "1234567890.00", "Refund Type": "Partial Refund" };
  const overlayResult = await fillPdf(flatBytes, overlayMap, overlayRow, {
    today: "07/22/2026",
    signature: { bytes: new Uint8Array(TINY_PNG), mime: "image/png" },
    nudgeX: 2,
    nudgeY: 2,
  });
  check("overlay drawn count", overlayResult.filledCount === 5, String(overlayResult.filledCount));
  check("overlay signature drawn", overlayResult.signaturesDrawn === 1, String(overlayResult.signaturesDrawn));
  const overlayText = (await extractPdfText(overlayResult.bytes)).join(" ");
  check("overlay draws row value", overlayText.includes("Dana Reyes"));
  check("overlay draws today + sig date", overlayText.split("07/22/2026").length === 3, overlayText);
  check("overlay onlyIf falsy skipped", !overlayText.includes("SHOULD-NOT-APPEAR"));
  check("overlay onlyIf equals drawn", overlayText.includes("CONDITIONAL"));
  check("overlay maxWidth truncates", !overlayText.includes("1234567890.00") && overlayText.includes("12345"), overlayText);

  // --- heuristic auto-map ----------------------------------------------
  const heur = heuristicAcroMap(inspection.fields, ["permit number", "Applicant Name", "Refund Amount", "Paid By Applicant", "Unrelated"]);
  check("heuristic maps text fields", heur.textFields["Permit Number"] === "row.permit number" && heur.textFields["Applicant Name"] === "row.Applicant Name", JSON.stringify(heur.textFields));
  check("heuristic maps checkbox", heur.checkboxes["Paid By Applicant"]?.source === "row.Paid By Applicant");
  check("heuristic skips unmatched", !("Refund Type" in heur.textFields));
  const sigFields = [{ name: "Applicant Signature", type: "text" as const }];
  check("heuristic never maps signatures", heuristicAcroMap(sigFields, ["Applicant Signature"]).matched === 0);

  // --- map/header validation -------------------------------------------
  const unknown = unknownRowSources(acroMap, ["Permit Number", "Applicant Name", "Refund Type", "Paid By Applicant"]);
  check("unknownRowSources flags missing column", unknown.length === 1 && unknown[0] === "row.Amount", JSON.stringify(unknown));

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll form-filler engine tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
