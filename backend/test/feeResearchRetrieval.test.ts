// THE RESEARCHER'S HANDS: retrieval, coordinate pairing, and the quote check.
//
// The fee researcher used to have one faculty — web search — and it reported
// found:false for the City of Coos Bay with an honest, well-reasoned refusal.
// The operator found the document in their browser in seconds. Two separate
// things had to be true for that gap to close, and this file pins both:
//
//   1. THE DOOR. coosbayor.gov returns 403 to every programmatic client (Akamai);
//      a headed window gets 200. So a 403 from a WAF must ESCALATE, and the bytes
//      that come back through the window must be the ones we read.
//   2. THE ROW. A PDF has no rows. Read in text-stream order, the City's schedule
//      pairs "Plan Review" with "65% of permit fee" where the printed row says
//      "Structural Plan Review" — and pairs a $200 fee against a line it does not
//      belong to. A fee attributed to the wrong row goes onto a customer quote.
//
// THE FIXTURE IS A TRAP ON PURPOSE. The PDF below is written with its whole VALUE
// column drawn before its whole DESCRIPTION column, so consecutive items in the
// text stream are a description and the WRONG line's value. The test asserts that
// stream order really does mis-pair (so the fixture cannot pass a broken reader)
// and then asserts the coordinate reader recovers the printed rows.
//
// No network beyond 127.0.0.1 and no browser: the WAF is a local http server that
// 403s like Akamai, and the "headed window" is an injected fake session holding
// the PDF bytes. What is exercised is every decision between them.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-research-retrieval-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  const { openDatabase } = await import("../src/db");
  const {
    openFeeDocument, newFeeDocumentLedger, checkQuoteSupport, retrievalNotes,
    normalizeFeePaymentMethod, saveFeeSchedule, getFeeSchedule, feeScheduleProfileKey,
    lookupPublishedFee, markFeeScheduleVerified,
  } = await import("../src/feeSchedules");
  type Finding = import("../src/feeSchedules").FeeScheduleFinding;
  const { extractPdfTextItems } = await import("../src/pdfTables");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  // -------------------------------------------------------------------------
  // A fee schedule whose text stream lies about its rows.
  // -------------------------------------------------------------------------
  const SOLAR_DESC = "Solar Permit (when required) - Prescriptive Path System, fee includes plan review";
  const REVIEW_DESC = "Structural Plan Review";
  const KVA_DESC = "Renewable energy for electrical systems- 5.01kva through 15kva";

  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const draw = (s: string, x: number, y: number): void => { page.drawText(s, { x, y, size: 9, font }); };
  // VALUE COLUMN FIRST — the whole point of the fixture.
  draw("$200.00", 430, 600);
  draw("65% of permit fee", 430, 580);
  draw("$160.00", 430, 560);
  // …then the descriptions.
  draw(SOLAR_DESC, 72, 600);
  draw(REVIEW_DESC, 72, 580);
  draw(KVA_DESC, 72, 560);
  const pdfBytes = await pdfDoc.save();

  // The fixture must actually be a trap: in STREAM order, the item that follows
  // "$200.00" is the NEXT ROW's value, and the descriptions arrive only after
  // every value. A reader that walked the stream would pair them wrongly.
  const streamItems = await extractPdfTextItems(pdfBytes);
  const streamOrder = streamItems.map((i) => i.str.trim()).filter(Boolean);
  const idx = (s: string): number => streamOrder.findIndex((t) => t.startsWith(s.slice(0, 20)));
  check(
    "FIXTURE IS A TRAP: stream order puts every value before any description",
    idx("$200.00") < idx(SOLAR_DESC) && idx("65% of permit fee") < idx(SOLAR_DESC) && idx("$160.00") < idx(SOLAR_DESC),
    streamOrder.join(" // "),
  );
  check(
    "FIXTURE IS A TRAP: reading the stream pairwise mis-pairs $200.00",
    streamOrder[idx("$200.00") + 1] !== undefined && !streamOrder[idx("$200.00") + 1].startsWith("Solar Permit"),
    `next after $200.00 was "${streamOrder[idx("$200.00") + 1]}"`,
  );

  // -------------------------------------------------------------------------
  // The WAF, and the window that gets past it.
  // -------------------------------------------------------------------------
  let plainHits = 0;
  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    if (url.startsWith("/fees.pdf")) {
      // Akamai's stock refusal, verbatim in shape: a 403 with an empty-ish body
      // and a Server header that names the CDN, aimed at the client and not at
      // any account.
      plainHits++;
      res.writeHead(403, { "content-type": "text/html", server: "AkamaiGHost" });
      res.end("<html><head><title>Access Denied</title></head><body>You don't have permission to access /fees.pdf on this server.</body></html>");
      return;
    }
    if (url.startsWith("/find-a-document")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<html><body><nav><a href='/'>Home</a><a href='/contact'>Contact Us</a></nav>"
        + "<ul><li><a href=\"/home/showpublisheddocument/570/639239531899170000\">Fee Schedule - Resolution 26-30</a></li>"
        + "<li><a href='/home/showpublisheddocument/99/1'>Dog Licence Application</a></li></ul>"
        + "<p>Permit fees are set by resolution of the City Council.</p></body></html>",
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The "headed window": no Chromium, but every decision around it is real.
  let windowsOpened = 0;
  let warmedOrigin = "";
  const launcher = async () => {
    windowsOpened++;
    return {
      async visit(url: string) { warmedOrigin = url; return { status: 200, html: "<html><body>warm</body></html>", url }; },
      async fetchInPage(url: string) {
        return { status: 200, contentType: "application/pdf", bytes: new Uint8Array(pdfBytes), url };
      },
      async close() { /* nothing to close */ },
    };
  };

  // -------------------------------------------------------------------------
  // 1. A refused PDF is escalated, and comes back as PRINTED ROWS.
  // -------------------------------------------------------------------------
  const ledger = newFeeDocumentLedger();
  const pdfOut = await openFeeDocument(
    { url: `${base}/fees.pdf`, find: "solar" },
    ledger,
    { launcher, timeoutMs: 5_000, browserTimeoutMs: 10_000 },
  );

  check("the plain HTTP client was tried first, and refused", plainHits === 1, `${plainHits} plain hit(s)`);
  check("a WAF 403 opened a real window", windowsOpened === 1, `${windowsOpened} window(s)`);
  check("the window warmed the ORIGIN before asking for the document", warmedOrigin === base, warmedOrigin);
  check("the tool result says it came through a browser", /via browser/.test(pdfOut), pdfOut.slice(0, 200));

  const lines = pdfOut.split("\n");
  const rowWith = (s: string): string => lines.find((l) => l.includes(s)) || "";
  check(
    "THE ROW: $200.00 is paired with the solar line it is printed beside",
    rowWith(SOLAR_DESC).includes("$200.00"),
    rowWith(SOLAR_DESC),
  );
  check(
    "THE ROW: '65% of permit fee' stays with Structural Plan Review",
    rowWith(REVIEW_DESC).includes("65% of permit fee") && !rowWith(REVIEW_DESC).includes("$200.00"),
    rowWith(REVIEW_DESC),
  );
  check(
    "THE ROW: the solar line did NOT absorb the next row's value",
    !rowWith(SOLAR_DESC).includes("65%"),
    rowWith(SOLAR_DESC),
  );
  check("cells are joined with the ' | ' the prompt tells the model to quote", rowWith(SOLAR_DESC).includes(" | "), rowWith(SOLAR_DESC));
  // `find` returns the matching row and ONE line either side — enough to see a
  // heading, not enough to see the rest of the table. Reading the whole bracket
  // table is what `pages` is for, and the prompt tells the model to use it.
  check("a narrow `find` does not silently hand back the whole table", !pdfOut.includes(KVA_DESC), "");
  const pageLedger = newFeeDocumentLedger();
  const pageOut = await openFeeDocument({ url: `${base}/fees.pdf`, pages: [1] }, pageLedger, { launcher, timeoutMs: 5_000, browserTimeoutMs: 10_000 });
  check("`pages` returns the page in full, bracket rows included", pageOut.includes(KVA_DESC), pageOut.slice(0, 400));
  check("…still paired by coordinate, not by stream order", (pageOut.split("\n").find((l) => l.includes(KVA_DESC)) || "").includes("$160.00"), pageOut.split("\n").find((l) => l.includes(KVA_DESC)));

  check("the retrieval was recorded as evidence", ledger.evidence.length === 1 && ledger.evidence[0].kind === "pdf", JSON.stringify(ledger.evidence));
  check("evidence names the browser rung, which is what a report must flag", ledger.evidence[0]?.via === "browser");
  check("evidence carries the real byte count", (ledger.evidence[0]?.bytes ?? 0) > 500, String(ledger.evidence[0]?.bytes));

  // -------------------------------------------------------------------------
  // 2. An HTML page is the way IN to the document: its links come back absolute.
  // -------------------------------------------------------------------------
  const windowsBefore = windowsOpened;
  const htmlLedger = newFeeDocumentLedger();
  const htmlOut = await openFeeDocument({ url: `${base}/find-a-document`, find: "fee" }, htmlLedger, { timeoutMs: 5_000 });
  // A browser launch costs a second or two and a window on somebody's screen.
  // The ladder's cheapest rung must stay the one nearly every fetch uses.
  check("an ordinary 200 page does NOT open a window", windowsOpened === windowsBefore, `${windowsOpened} vs ${windowsBefore}`);
  check("the document-search link is found", htmlOut.includes("Fee Schedule - Resolution 26-30"), htmlOut.slice(0, 400));
  check(
    "its href comes back ABSOLUTE, so the model can follow it",
    htmlOut.includes(`${base}/home/showpublisheddocument/570/639239531899170000`),
    htmlOut.slice(0, 400),
  );
  check("`find` filtered the navigation furniture out", !htmlOut.includes("Dog Licence") && !htmlOut.includes("Contact Us"), htmlOut.slice(0, 400));
  check("html retrieval is evidence too", htmlLedger.evidence[0]?.kind === "html" && htmlLedger.evidence[0]?.via === "http");

  // A document that is simply missing is a REASON, never a throw — a tool that
  // throws ends the research loop and loses everything read before it.
  const missing = await openFeeDocument({ url: `${base}/nope.pdf` }, htmlLedger, { timeoutMs: 5_000 });
  check("a 404 comes back as a sentence, not an exception", /404/.test(missing) && /Could not retrieve/.test(missing), missing.slice(0, 160));
  check("a failed retrieval is not recorded as evidence", htmlLedger.evidence.length === 1, String(htmlLedger.evidence.length));

  // -------------------------------------------------------------------------
  // 3. THE QUOTE CHECK. Did the sentence we are about to store come out of
  //    bytes we actually read, or out of the model?
  // -------------------------------------------------------------------------
  const base_finding = (over: Partial<Finding>): Finding => ({
    found: true, reason: "", basis: "flat", brackets: [], notes: "",
    sourceUrl: `${base}/fees.pdf`, sourceQuote: "", sourceKind: "official", ...over,
  });

  // Quoted off the row, with the differences a real model introduces: an en-dash
  // where the PDF prints a hyphen, and a trailing bracketed citation.
  const realQuote = base_finding({
    sourceQuote: "Solar Permit (when required) – Prescriptive Path System, fee includes plan review | $200.00 [Exhibit A, BUILDING FEES, p.8]",
    brackets: [{ feeUsd: 200, label: "Prescriptive path system" }],
  });
  const realSupport = checkQuoteSupport(realQuote, ledger);
  check("a quote copied off the row verifies", realSupport.quoteVerified, realSupport.matchedFragment);
  check("…despite an en-dash where the PDF prints a hyphen", realSupport.matchedFragment.includes("-"), realSupport.matchedFragment);
  check("its fee is found in the retrieved bytes", realSupport.feesVerified, JSON.stringify(realSupport.missingFees));

  const inventedQuote = base_finding({
    sourceQuote: "Residential photovoltaic installation permit: $450.00 per application.",
    brackets: [{ feeUsd: 450, label: "Solar PV permit" }],
  });
  const inventedSupport = checkQuoteSupport(inventedQuote, ledger);
  check("A QUOTE THAT WAS NEVER READ DOES NOT VERIFY", !inventedSupport.quoteVerified);
  check("…and the fee it carries is reported missing", !inventedSupport.feesVerified && inventedSupport.missingFees.includes(450), JSON.stringify(inventedSupport.missingFees));

  const goodNotes = retrievalNotes(realQuote, ledger, realSupport).join(" | ");
  const badNotes = retrievalNotes(inventedQuote, ledger, inventedSupport).join(" | ");
  check("notes say the quote was verified", /Quote verified/.test(goodNotes), goodNotes);
  check("notes say the BROWSER was needed — the operator must know the site blocks scripts", /headed browser/.test(goodNotes), goodNotes);
  check("notes say rows were paired by coordinate", /BY COORDINATE/i.test(goodNotes), goodNotes);
  check("an unverifiable quote is called out in as many words", /QUOTE NOT VERIFIED/.test(badNotes), badNotes);
  check("…and so is the fee that appears nowhere in the document", /FEE NOT FOUND/.test(badNotes), badNotes);

  // With nothing retrieved at all the check must say "could not tell", never
  // "verified" — a silent pass here is how a web-search paraphrase would be
  // laundered into a checked quote.
  const emptySupport = checkQuoteSupport(realQuote, newFeeDocumentLedger());
  check("no evidence means NOT verified, and says so", emptySupport.noEvidence && !emptySupport.quoteVerified);
  check("…and the notes admit the finding rests on search alone", /web search alone/.test(retrievalNotes(realQuote, newFeeDocumentLedger(), emptySupport).join(" | ")));

  // -------------------------------------------------------------------------
  // 3b. A ROW WITH NO SIZE BOUNDS IS NOT A SIZE BRACKET.
  //
  // Straight off a live harvest: ComEd's real interconnection table is Level 1
  // (25 kW export, $50) and Level 2 (to 5 MW, $100/kVA) — printed beside a $500
  // non-export line and a $300 PRE-APPLICATION report fee, neither keyed on
  // system size. Stored as-is, first-match gave a 60 kW job the $500 line.
  // -------------------------------------------------------------------------
  const comed = { state: "IL", utility: "ComEd Bracket Probe", track: "nem" as const };
  saveFeeSchedule(db, comed, base_finding({
    basis: "system_kw",
    brackets: [
      { minKw: 0, maxKw: 50, feeUsd: 50, label: "Level 1 — export capacity 25 kW or less" },
      { feeUsd: 500, label: "Level 3 — non-export systems" },
      { feeUsd: 300, label: "Pre-Application report" },
      { minKw: 50, maxKw: 5000, feeUsd: 100, label: "Level 2 — up to 5 MW" },
    ],
    sourceUrl: "https://www.comed.com/der-guidelines.pdf",
    sourceQuote: "Level 1 | Export capacity of 25 kW or less | $50",
  }));
  const comedSeam = (kw: number) => lookupPublishedFee(db, { track: "nem", state: "IL", ahj: "", utility: "ComEd Bracket Probe", bracketKw: kw });
  check("a 7 kW job still gets Level 1", comedSeam(7)?.feeUsd === 50, JSON.stringify(comedSeam(7)));
  check("a 60 kW job gets Level 2 — NOT the unbounded $500 line", comedSeam(60)?.feeUsd === 100, JSON.stringify(comedSeam(60)));
  check(
    "a size past every bounded row reports unresolved rather than grabbing a boundless one",
    comedSeam(9000) !== null && comedSeam(9000)?.feeUsd === null,
    JSON.stringify(comedSeam(9000)),
  );

  // -------------------------------------------------------------------------
  // 4. HOW THE MONEY MOVES. Ameren Illinois' $50 is a MAILED PAPER CHECK within
  //    15 business days; the application is not reviewed until it lands. A fee
  //    sheet that does not say so hands the operator a filing that silently
  //    stalls.
  // -------------------------------------------------------------------------
  const cols = db.query<{ name: string }>("PRAGMA table_info(fee_schedules)").map((c) => c.name);
  check("migration v20 landed payment_method", cols.includes("payment_method"), cols.join(","));

  check("'Mailed check' normalises", normalizeFeePaymentMethod("Mailed check") === "mailed_check");
  check("'paid by check, by mail' normalises", normalizeFeePaymentMethod("paid by check, by mail") === "mailed_check");
  check("'Online portal' normalises", normalizeFeePaymentMethod("Online portal") === "portal");
  check("'no fee' normalises", normalizeFeePaymentMethod("no fee") === "none");
  check("a value the enum does not know becomes 'unknown', never invented", normalizeFeePaymentMethod("venmo") === "unknown");
  check("absent is 'unknown'", normalizeFeePaymentMethod(undefined) === "unknown");

  const ameren = { state: "IL", utility: "Ameren Illinois", track: "nem" as const };
  const amerenSave = saveFeeSchedule(db, ameren, base_finding({
    basis: "flat",
    brackets: [{ feeUsd: 50, label: "Level 1 interconnection application fee" }],
    paymentMethod: "mailed check",
    sourceUrl: "https://www.ameren.com/illinois/interconnection",
    sourceQuote: "A $50 application fee is required for Level 1 interconnection, payable by check mailed within 15 business days.",
  }));
  const amerenKey = feeScheduleProfileKey(ameren, "nem");
  check("the Ameren schedule saved", amerenSave.saved, amerenSave.reason);
  check("the payment METHOD survived the round trip", getFeeSchedule(db, amerenKey, "nem")?.paymentMethod === "mailed_check", getFeeSchedule(db, amerenKey, "nem")?.paymentMethod);

  const seam = lookupPublishedFee(db, { track: "nem", state: "IL", ahj: "", utility: "Ameren Illinois" });
  check("the seam carries the method to the fee sheet", seam?.paymentMethod === "mailed_check", JSON.stringify(seam));
  check("the seam carries the quote the consumer reads as a last resort", (seam?.sourceQuote || "").includes("15 business days"), seam?.sourceQuote);
  check("the seam still answers the amount", seam?.feeUsd === 50);

  // A later pass that says nothing about payment must not ERASE what the last
  // one found. "unknown" is the absence of an answer, not an answer of absence.
  const silent = saveFeeSchedule(db, ameren, base_finding({
    basis: "flat",
    brackets: [{ feeUsd: 50, label: "Level 1 interconnection application fee" }],
    sourceUrl: "https://www.ameren.com/illinois/interconnection",
    sourceQuote: "A $50 application fee is required for Level 1 interconnection.",
  }));
  check("a re-research with no method still saves", silent.saved);
  check("…and does NOT wipe the mailed-check answer", getFeeSchedule(db, amerenKey, "nem")?.paymentMethod === "mailed_check");

  // And the method rides the same rail as everything else: a human-verified row
  // refuses the write entirely (hard rule 3).
  markFeeScheduleVerified(db, amerenKey, "nem", "operator@example.com");
  const overwrite = saveFeeSchedule(db, ameren, base_finding({
    basis: "flat",
    brackets: [{ feeUsd: 75, label: "Level 1" }],
    paymentMethod: "portal",
    sourceUrl: "https://example.com/blog",
    sourceQuote: "Ameren charges $75 online.",
  }));
  check("a verified row refuses a method change too", overwrite.refusedVerified && getFeeSchedule(db, amerenKey, "nem")?.paymentMethod === "mailed_check", JSON.stringify(getFeeSchedule(db, amerenKey, "nem")?.paymentMethod));

  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nfeeResearchRetrieval: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
