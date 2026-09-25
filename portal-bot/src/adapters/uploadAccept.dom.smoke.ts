// A FILE MAY ONLY GO WHERE THE PORTAL SAYS IT CAN GO.
//
// Nothing checked a slot's `accept` list: fileFits() weighed SIZE alone, and the fallback
// chain ends in "utility_package_zip". So a generic "Attach documents" control that accepts
// only .pdf was handed a ZIP, the upload reported success, and the only person who ever found
// out was the utility reviewer who downloaded the attachment and could not open it. That is
// the failure mode this pins: it is invisible from our side by construction.
//
// Covers the pure rule AND that the rule's input — the accept attribute — is actually read
// off the live DOM, because the rule is worthless if the slot never carries the list.
//   npx tsx portal-bot/src/adapters/uploadAccept.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import { fileTypeAllowed, tagUploadControls } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

// ── the rule ───────────────────────────────────────────────────────────────────────────
const PDF_ONLY = ".docx, .xlsx, .pdf";
const IMAGE_ISH = ".docx, .pdf, .jpg, .jpeg, .png, .gif, .heic, .webp, .tiff, .csv, .xlsx";

check("THE BUG: a ZIP is refused by a slot that accepts only .docx/.xlsx/.pdf",
  fileTypeAllowed("/x/nem_package.zip", PDF_ONLY) === false);

check("the plan-set PDF is accepted there instead",
  fileTypeAllowed("/x/christopher-ivy-plan-set.pdf", PDF_ONLY) === true);

check("a meter photo (.jpg) is refused by a PDF-only slot",
  fileTypeAllowed("/x/meter.jpg", PDF_ONLY) === false);

check("a meter photo IS accepted where the portal allows images",
  fileTypeAllowed("/x/meter.jpg", IMAGE_ISH) === true);

check("no accept list means no restriction (slots without one must still fill)",
  fileTypeAllowed("/x/anything.zip", "") === true);

check("accept written as a MIME type works too",
  fileTypeAllowed("/x/a.pdf", "application/pdf") === true
  && fileTypeAllowed("/x/a.zip", "application/pdf") === false);

check("a wildcard family (image/*) matches by family",
  fileTypeAllowed("/x/p.png", "image/*") === true
  && fileTypeAllowed("/x/p.pdf", "image/*") === false);

check("*/* accepts anything", fileTypeAllowed("/x/p.zip", "*/*") === true);

check("a file with no extension is refused when a list is declared",
  fileTypeAllowed("/x/noextension", PDF_ONLY) === false);

check("case and spacing in the accept list are tolerated",
  fileTypeAllowed("/x/A.PDF", "  .PDF ,.docx ") === true);

// ── the input to the rule: the DOM must actually yield the accept list ─────────────────
const PAGE = `<!doctype html><html><body>
  <div class="form-group">
    <label>Please attach the Data Sheet for the DC Source/PV Module</label>
    <input type="file" id="a" accept=".docx, .xlsx, .pdf">
  </div>
  <div class="form-group">
    <label>Meter photo</label>
    <input type="file" id="b" accept=".jpg, .jpeg, .png">
  </div>
  <div class="form-group">
    <label>Attach documents</label>
    <input type="file" id="c">
  </div>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

const slots = await page.evaluate(tagUploadControls);
console.log(`  tagged ${slots.length} slot(s): ${JSON.stringify(slots.map((s) => ({ l: s.label.slice(0, 24), a: s.accept })))}`);

check("the slot carries the portal's accept list off the live DOM",
  /\.pdf/i.test(slots[0]?.accept || ""), JSON.stringify(slots[0]));

check("an image-only slot reports its own list, not the previous slot's",
  /jpg/i.test(slots[1]?.accept || "") && !/pdf/i.test(slots[1]?.accept || ""), JSON.stringify(slots[1]));

check("a slot with no accept attribute reports an empty list (unrestricted)",
  (slots[2]?.accept ?? null) === "", JSON.stringify(slots[2]));

// End to end through the real tagged slot: the ZIP must lose, the PDF must win.
check("end to end — the real DOM slot refuses the ZIP and takes the PDF",
  fileTypeAllowed("/x/nem_package.zip", slots[0]?.accept || "") === false
  && fileTypeAllowed("/x/plan-set.pdf", slots[0]?.accept || "") === true);

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} upload-accept check(s) FAILED.`); process.exit(1); }
console.log("\nAll upload-accept checks passed (real Chromium).");
process.exit(0);
