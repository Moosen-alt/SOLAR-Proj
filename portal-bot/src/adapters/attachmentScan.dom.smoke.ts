// AN UPLOAD THAT WORKED MUST NOT LOOK LIKE AN UPLOAD THAT NEVER HAPPENED.
//
// The audit used to count `input[type=file]`, which counts only the slots still WAITING for a
// document. PowerClerk removes the picker once a file is accepted, so an Ameren application
// carrying 9 slots and 3 attached documents reported "0/6 attached" — and the one number that
// decides whether a submission is complete was the one number nobody could state.
//
// Pins that a real attachment is found, and — the part that matters more — that the three
// things which merely LOOK like one are not counted: a blank-template download link sitting
// inside the upload area, an editable field someone typed a filename into, and an empty slot.
//   npx tsx portal-bot/src/adapters/attachmentScan.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { findAttachmentsInPage } from "./attachmentScan";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const PAGE = `<!doctype html><html><body>
  <!-- PowerClerk's filled slot: the picker is GONE, replaced by a disabled box holding the
       file name plus Download/Remove. This is the shape the audit was blind to. -->
  <div class="row">
    <label data-test-role="input-label">Please attach the Data Sheet for the DC Source/PV Module *</label>
    <div data-test-role="input-file-wrapper">
      <div data-test-role="input-file-uploaded" class="input-group">
        <input id="A1Input" disabled type="text" value="module-datasheet.pdf">
        <button type="button" data-test-role="view-btn">Download</button>
        <button type="button" data-test-role="remove-btn">Remove</button>
      </div>
    </div>
  </div>

  <!-- An Accela-style attachment ROW: the name is text, and a Delete action sits beside it. -->
  <table><tr>
    <td><label>Site Plan</label></td>
    <td><span>site-plan.pdf</span></td>
    <td><a href="#">Delete</a></td>
  </tr></table>

  <!-- THE TRAP. A blank-template download link lives INSIDE the upload area, so "a filename
       near upload UI" would count it. Nothing offers to remove it, because nobody attached it. -->
  <div class="row">
    <label data-test-role="input-label">Interconnection Agreement *</label>
    <div data-test-role="input-file-wrapper">
      <a href="/forms/blank-agreement.pdf">blank-agreement.pdf</a>
      <div data-test-role="input-file">
        <label class="form-control pc-custom-file" data-browse="Browse">
          <input class="invisible" type="file" id="B2Input" accept=".pdf">
        </label>
        <div class="small">Allowed file types: .docx, .xlsx, .pdf</div>
      </div>
    </div>
  </div>

  <!-- An EDITABLE box that happens to contain a filename is a text answer, not a document. -->
  <div class="row">
    <label>Name of the drawing you are referencing</label>
    <input type="text" value="my-own-notes.pdf">
    <button type="button">Remove</button>
  </div>

  <!-- A plain empty slot contributes nothing. -->
  <div class="row">
    <label data-test-role="input-label">Additional Documents</label>
    <input type="file" id="C3Input">
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

const found = await page.evaluate(findAttachmentsInPage);
const names = found.map((f) => f.name);
console.log(`  found ${found.length}: ${JSON.stringify(found)}`);

check("a PowerClerk filled slot is recognised by its disabled filename box + Remove",
  names.includes("module-datasheet.pdf"), JSON.stringify(names));

check("an attachment table row (filename text + Delete) is recognised",
  names.includes("site-plan.pdf"), JSON.stringify(names));

check("a blank-template download link inside the upload area is NOT an attachment",
  !names.includes("blank-agreement.pdf"), JSON.stringify(names));

check("an editable field holding a filename is NOT an attachment",
  !names.includes("my-own-notes.pdf"), JSON.stringify(names));

check("exactly the two real attachments are reported (no ancestor double-count)",
  found.length === 2, JSON.stringify(names));

check("the attachment carries the slot's QUESTION, not just the file name",
  /Data Sheet for the DC Source/i.test(found.find((f) => f.name === "module-datasheet.pdf")?.label || ""),
  JSON.stringify(found.map((f) => f.label)));

// The field pass must not re-count a filename display as a filled form answer: the scan
// tags them, and the audit skips anything tagged.
const tagged = await page.$$eval("[data-al-attach]", (els) => els.length);
check("the filename display is tagged so the field pass skips it", tagged === 1, `tagged=${tagged}`);

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} attachment-scan check(s) FAILED.`); process.exit(1); }
console.log("\nAll attachment-scan checks passed (real Chromium).");
process.exit(0);
