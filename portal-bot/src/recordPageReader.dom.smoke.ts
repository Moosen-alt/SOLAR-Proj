// THE RECORD PAGE, READ AFTER ITS SCRIPT LOADS THE FEES — real Chromium, local fixture pages.
//
// The one Coos Bay record page on file reads "Print/View Summary Fees Loading...": ACA fills
// the Fees section by script, so a plain fetch never sees it. readRecordPageInBrowser opens
// the record's own URL, waits for the placeholder to go, and returns the text — and NEVER
// CLICKS: the fixture's "Pay Fees" link is a trap that records any request to /pay.
//
//   1. a page whose Fees section loads ~900ms after load -> the loaded text, which the shared
//      parser reads as $236.00 ($56.00 outstanding + $180.00 paid);
//   2. a page whose Fees never load -> returned (within the timeout) WITH the placeholder,
//      which the parser reports as not_loaded — never a number;
//   3. nothing was clicked: zero requests reached /pay;
//   4. PORTAL_AUTOMATION=off -> no browser at all (null).
// Kill: remove the wait loop -> 1 FAILS (the placeholder text comes back).
//   npx tsx portal-bot/src/recordPageReader.dom.smoke.ts
import http from "node:http";
import { readRecordPageInBrowser } from "./recordPageReader";
import { readAccelaFeeSection } from "../../shared/src/portalFeeItems";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const LOADED = `<div>Fees</div><div>Outstanding:</div><table><tr><th>Date</th><th>Invoice Number</th><th>Amount</th></tr>
  <tr><td>09/05/2026</td><td>1234567</td><td>$56.00</td><td><a id="pay" href="/pay">Pay Fees</a></td></tr></table>
  <div>Total outstanding fees: $56.00</div><div>Paid:</div><table><tr><th>Date</th><th>Invoice Number</th><th>Amount</th></tr>
  <tr><td>08/31/2026</td><td>1234401</td><td>$180.00</td></tr></table><div>Total paid fees: $180.00</div>`;
const pageHtml = (loads: boolean) => `<!doctype html><html><body>
  <h1>Record 187-26-000309-STR: Residential Structural</h1>
  <div>Record Status: In Review</div>
  <div>Parcel Information Parcel Number: 25S13W20CCTL0250300</div>
  <div id="fees"><a href="/pay">Print/View Summary Fees</a> <span id="ph">Loading...</span></div>
  <div>Inspections</div><div>Documents Upload/View</div>
  <script>
    ${loads ? `setTimeout(function () { document.getElementById("fees").innerHTML = '<a href="/pay">Print/View Summary Fees</a>' + ${JSON.stringify(LOADED)}; }, 900);` : ""}
  </script>
</body></html>`;

let payHits = 0;
const server = http.createServer((req, res) => {
  if (String(req.url).startsWith("/pay")) { payHits++; res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html><body>PAYMENT PAGE</body></html>"); return; }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(pageHtml(String(req.url).startsWith("/loads")));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

try {
  const text = await readRecordPageInBrowser(`${base}/loads/CapDetail.aspx`, { timeoutMs: 8000 });
  const read = text ? readAccelaFeeSection(text) : null;
  check("1. the script-loaded Fees section is read after it loads: $236.00", !!read && read.ok && read.reading.totalUsd === 236 && !/Loading\.\.\./.test(text ?? ""),
    JSON.stringify(read).slice(0, 300));

  const t0 = Date.now();
  const stuck = await readRecordPageInBrowser(`${base}/never/CapDetail.aspx`, { timeoutMs: 2500 });
  const stuckRead = stuck ? readAccelaFeeSection(stuck) : null;
  check("2. fees that never load come back with the placeholder -> not_loaded, never a number",
    !!stuckRead && !stuckRead.ok && stuckRead.reason === "not_loaded", JSON.stringify(stuckRead));
  check("2b. …within the timeout", Date.now() - t0 < 25_000, `${Date.now() - t0}ms`);

  check("3. nothing was clicked: zero requests reached the Pay Fees link", payHits === 0, `pay hits: ${payHits}`);

  const prior = process.env.PORTAL_AUTOMATION;
  process.env.PORTAL_AUTOMATION = "off";
  const off = await readRecordPageInBrowser(`${base}/loads/CapDetail.aspx`, { timeoutMs: 3000 });
  if (prior === undefined) delete process.env.PORTAL_AUTOMATION; else process.env.PORTAL_AUTOMATION = prior;
  check("4. PORTAL_AUTOMATION=off opens no browser", off === null);
} finally {
  server.close();
}

if (failures) { console.error(`\nrecordPageReader: ${failures} failure(s)`); process.exit(1); }
console.log("\nrecordPageReader: all checks passed");
process.exit(0);
