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
    corroborateAncillaryCharges, ancillaryChargeNotes, attachAncillaryCharges,
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

  // A SECOND FIXTURE: ONE FILING, SEVERAL CHARGES.
  //
  // Portland bills one 3.5 kW rooftop as four separate bills from three bureaus —
  // fire plan review, electrical permit + 12% state surcharge, land use review +
  // a building plan review computed as 65% of the building permit, and the
  // building permit itself. The permit lines were under half the $762.93 total.
  // This schedule prints the same shape: a permit line, a PERCENTAGE plan review,
  // a flat fire review, and a percentage surcharge. What it does NOT print is any
  // technology fee, and that absence is what the gate has to survive.
  const ANC_PERMIT = "Photovoltaic solar panel system permit - prescriptive path";
  const ANC_REVIEW = "Solar plan review and processing fee";
  const ANC_FIRE = "Fire and life safety plan review - residential";
  const ANC_SURCHARGE = "State of Oregon surcharge on all permit fees";
  const ancDoc = await PDFDocument.create();
  const ancPage = ancDoc.addPage([612, 792]);
  const ancFont = await ancDoc.embedFont(StandardFonts.Helvetica);
  const ancDraw = (s: string, x: number, y: number): void => { ancPage.drawText(s, { x, y, size: 9, font: ancFont }); };
  for (const [desc, value, y] of [
    [ANC_PERMIT, "$200.00", 700],
    [ANC_REVIEW, "65% of the permit fee", 680],
    [ANC_FIRE, "$50.00", 660],
    [ANC_SURCHARGE, "12% of the permit fee", 640],
  ] as Array<[string, string, number]>) {
    ancDraw(desc, 72, y);
    ancDraw(value, 400, y);
  }
  // A WRAPPED ROW, copied from the real thing. Portland's adopted electrical
  // schedule really does print its plan-review charge as two consecutive printed
  // lines, the label cell above the value cell — measured by retrieving the PDF,
  // page 2:
  //     p2  Plan Review Fee
  //     p2  25% of total electrical permit fee - Maximum number of allowable checksheets: 2
  const ANC_WRAP_HEAD = "Plan Review Fee";
  const ANC_WRAP_TAIL = "25% of total electrical permit fee - Maximum number of allowable checksheets: 2";
  ancDraw(ANC_WRAP_HEAD, 72, 620);
  ancDraw(ANC_WRAP_TAIL, 72, 600);
  const ancPdfBytes = await ancDoc.save();

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
    // The ordinary, unwalled path a harvest walks: a fee page that links the
    // adopted schedule, and the schedule itself served plainly at 200.
    if (url.startsWith("/fee-page")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<html><body><a href='/jobs'>Employment opportunities</a>"
        + "<a href=\"/forms/adopted-fee-schedule.pdf\">Community Development Fee Schedule effective 7-1-25</a>"
        + "</body></html>",
      );
      return;
    }
    if (url.startsWith("/anc-fees.pdf")) {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(Buffer.from(ancPdfBytes));
      return;
    }
    if (url.startsWith("/forms/adopted-fee-schedule.pdf")) {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(Buffer.from(pdfBytes));
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

  // -------------------------------------------------------------------------
  // 5. THE HARVEST'S OWN RETRIEVAL IS EVIDENCE — and it used to be thrown away.
  //
  // jurisdictionHarvest downloads the jurisdiction's adopted schedule and reads
  // its fee table by COORDINATE PAIRING. That is the strongest evidence anything
  // in this codebase can produce for a fee: bytes this process fetched, and the
  // bracket's label and amount on one printed line. It then called
  // saveFeeSchedule with NO ledger — and saveFeeSchedule treats a caller with no
  // ledger as untrusted and STRIPS corroboration (round 2's fix, which is right:
  // scripts/apply-fee-findings.ts fetches nothing and may not assert anything).
  // So every harvested bracket ever stored landed uncorroborated, and the
  // corroboration column on the live rows is empty for that reason and not
  // because the machinery cannot do it.
  //
  // This drives the REAL harvestJurisdiction against the REAL saveFeeSchedule and
  // reads the row back out of the database.
  // -------------------------------------------------------------------------
  const { harvestJurisdiction } = await import("../src/jurisdictionHarvest");
  const HARVEST_AHJ = "City of Ledger Falls";
  const harvest = await harvestJurisdiction(
    db,
    { state: "OR", ahj: HARVEST_AHJ, pageUrl: `${base}/fee-page` },
    { apply: true },
  );
  check("the harvest found and saved a schedule", harvest.fee.action === "saved", `${harvest.fee.action}: ${harvest.fee.reason}`);

  const harvestKey = feeScheduleProfileKey({ state: "OR", ahj: HARVEST_AHJ, utility: "" }, "permit");
  const harvested = getFeeSchedule(db, harvestKey, "permit");
  check("the harvested row is on file", Boolean(harvested), JSON.stringify(harvest.fee.reason));
  check("…and it is SEEDED, never verified — rule 3 is a human's signature", harvested?.confidence === "seeded", harvested?.confidence);
  const kvaBracket = (harvested?.brackets || []).find((b) => Math.abs(b.feeUsd - 160) < 0.005);
  check("the 5.01–15 kVA bracket was stored", Boolean(kvaBracket), JSON.stringify(harvested?.brackets));

  // THE POINT OF THIS SECTION.
  check(
    "A HARVESTED BRACKET CARRIES CORROBORATION — the harvest fetched the bytes, so it may assert it",
    kvaBracket?.corroboration?.corroborated === true,
    JSON.stringify(kvaBracket?.corroboration ?? null),
  );
  check(
    "…and the corroboration quotes the PRINTED ROW the fee was read off",
    (kvaBracket?.corroboration?.matchedLine || "").includes("5.01kva") && (kvaBracket?.corroboration?.matchedLine || "").includes("$160.00"),
    kvaBracket?.corroboration?.matchedLine,
  );
  check(
    "…naming the DOCUMENT it was downloaded from, not the page that linked it",
    (kvaBracket?.corroboration?.sourceUrl || "").includes("/forms/adopted-fee-schedule.pdf"),
    kvaBracket?.corroboration?.sourceUrl,
  );
  // ROWS STAY APART IN THE CORPUS. The harvest's `quote` staples every printed row
  // into one string; corroborateBrackets splits the corpus on "\n", so handing it
  // that blob would make every fee in the table co-occur with every label in it —
  // the wind-row mis-attribution, rebuilt. The matched line must be ONE row.
  check(
    "the matched line is ONE printed row, not the whole table stapled together",
    !(kvaBracket?.corroboration?.matchedLine || "").includes("Solar Permit (when required)"),
    kvaBracket?.corroboration?.matchedLine,
  );
  check(
    "the row's notes say CORROBORATED, in the operator's words",
    /CORROBORATED 1\/1 bracket/.test(harvested?.notes || ""),
    (harvested?.notes || "").slice(-300),
  );
  // THE SENTENCE MAY NOT OUTRUN THE ROW. harvest composes that notes line from its
  // own ledger and saveFeeSchedule re-derives the stored corroboration from the
  // same one; if those two ever stop being the same ledger, the notes would claim
  // evidence the row does not carry — which is worse than claiming none, because a
  // person reading the fee sheet would believe it. So the count in the sentence is
  // checked against the brackets actually stored.
  const storedCorroborated = (harvested?.brackets || []).filter((b) => b.corroboration?.corroborated).length;
  const claimed = Number(/CORROBORATED (\d+)\//.exec(harvested?.notes || "")?.[1] ?? -1);
  check(
    "the notes' corroborated COUNT matches the brackets actually stored",
    claimed === storedCorroborated,
    `notes claim ${claimed}, row carries ${storedCorroborated}`,
  );

  // A HUMAN-VERIFIED ROW IS STILL UNTOUCHABLE ON THIS PATH. Corroboration is
  // evidence, not authority: it may not become a reason to overwrite a person.
  markFeeScheduleVerified(db, harvestKey, "permit", "operator@example.com");
  const secondPass = await harvestJurisdiction(
    db,
    { state: "OR", ahj: HARVEST_AHJ, pageUrl: `${base}/fee-page` },
    { apply: true },
  );
  check("a corroborating harvest still refuses a human-verified row", secondPass.fee.action === "refused_verified", `${secondPass.fee.action}: ${secondPass.fee.reason}`);
  check("…and the row is still the human's", getFeeSchedule(db, harvestKey, "permit")?.confidence === "verified");

  // -------------------------------------------------------------------------
  // 6. THE REST OF THE BILL — ancillary charges, and the gate that keeps the
  //    plausible ones out.
  //
  // The researcher's ask was one sentence long ("extract the full bracket table
  // for the solar/renewable-energy line") and the researcher answered it
  // faithfully: one line. The operator's own paid City of Portland receipt for a
  // 3.520 kW rooftop is FOUR BILLS FROM THREE BUREAUS — $762.93, of which the two
  // permit lines are $354.00. Plan review, land use review, fire review and
  // processing were never requested, never held, and so no quote built from this
  // table could reach a real total.
  //
  // Widening the ask creates the danger this section is really about. Ask a model
  // for "every other charge on this filing" and it can answer plausibly from
  // priors: almost every jurisdiction has a plan-review fee, most express it as a
  // percentage, and 65% is a real number in several of them. So every charge is
  // checked the way a bracket is — label and amount CO-OCCURRING ON ONE PRINTED
  // ROW we retrieved — and the ones that fail are dropped and COUNTED, never
  // stored uncorroborated.
  // -------------------------------------------------------------------------
  const ancLedger = newFeeDocumentLedger();
  const ancOut = await openFeeDocument({ url: `${base}/anc-fees.pdf`, pages: [1] }, ancLedger, { timeoutMs: 5_000 });
  const ancRowWith = (s: string): string => ancOut.split("\n").find((l) => l.includes(s)) || "";
  check("fixture: the plan review is its OWN printed row, priced as a percentage", ancRowWith(ANC_REVIEW).includes("65%"), ancRowWith(ANC_REVIEW));
  check("fixture: the fire review is a separate flat row", ancRowWith(ANC_FIRE).includes("$50.00"), ancRowWith(ANC_FIRE));
  check("fixture: no technology fee is printed anywhere in this schedule", !/technology/i.test(ancOut));

  const ancFinding = base_finding({
    basis: "flat",
    discipline: "structural",
    brackets: [{ feeUsd: 200, label: ANC_PERMIT }],
    sourceUrl: `${base}/anc-fees.pdf`,
    sourceQuote: `${ANC_PERMIT} | $200.00`,
  });

  // Model-shaped output, exactly as the widened ask asks for it — three charges
  // this schedule really prints, and three that it does not.
  const CLAIMED_URL = "https://example.gov/the-url-the-model-typed";
  const INVENTED = "Technology and records processing fee";
  const reported = [
    { label: ANC_REVIEW, kind: "plan_review", percent: 65, percentOf: "of the permit fee", conditional: false, appliesTo: "structural", quote: `${ANC_REVIEW} | 65% of the permit fee`, sourceUrl: CLAIMED_URL },
    { label: ANC_FIRE, kind: "fire_review", amountUsd: 50, conditional: false, appliesTo: "structural", quote: `${ANC_FIRE} | $50.00`, sourceUrl: CLAIMED_URL },
    { label: ANC_SURCHARGE, kind: "surcharge", percent: 12, percentOf: "of the permit fee", conditional: false, appliesTo: "", quote: `${ANC_SURCHARGE} | 12% of the permit fee`, sourceUrl: CLAIMED_URL },
    // INVENTED OUTRIGHT: the label appears nowhere in anything we read.
    { label: INVENTED, kind: "processing", amountUsd: 35, conditional: false, appliesTo: "structural", quote: `${INVENTED} | $35.00`, sourceUrl: CLAIMED_URL },
    // THE DANGEROUS ONE: a REAL label carrying a WRONG number. "Does the label
    // appear?" says yes; only co-occurrence on one row says no.
    { label: ANC_REVIEW, kind: "plan_review", percent: 80, percentOf: "of the permit fee", conditional: false, appliesTo: "structural", quote: `${ANC_REVIEW} | 80% of the permit fee`, sourceUrl: CLAIMED_URL },
    // Neither one amount nor one percentage — nothing can evaluate it.
    { label: ANC_FIRE, kind: "fire_review", amountUsd: 50, percent: 10, conditional: false, appliesTo: "structural", quote: ANC_FIRE, sourceUrl: CLAIMED_URL },
  ];
  const gated = corroborateAncillaryCharges(reported, ancFinding, ancLedger);
  const heldLabels = gated.held.map((c) => c.label);
  check("THE WHOLE FILING IS HELD, not just the permit line: 3 charges survived", gated.held.length === 3, JSON.stringify(heldLabels));
  check("…the percentage plan review", heldLabels.includes(ANC_REVIEW), JSON.stringify(heldLabels));
  check("…the flat fire review", heldLabels.includes(ANC_FIRE), JSON.stringify(heldLabels));
  check("…and the surcharge", heldLabels.includes(ANC_SURCHARGE), JSON.stringify(heldLabels));

  const heldReview = gated.held.find((c) => c.label === ANC_REVIEW);
  check(
    "A PERCENTAGE IS STORED AS A PERCENTAGE — 65% of the permit fee, never pre-multiplied into dollars",
    heldReview?.percent === 65 && heldReview?.amountUsd === undefined && /permit fee/i.test(heldReview?.percentOf || ""),
    JSON.stringify(heldReview),
  );
  check(
    "each held charge quotes the PRINTED ROW it was matched on",
    (heldReview?.matchedLine || "").includes(ANC_REVIEW) && (heldReview?.matchedLine || "").includes("65%"),
    heldReview?.matchedLine,
  );
  check(
    "…and names the document WE FETCHED, not the URL the model typed",
    heldReview?.sourceUrl === `${base}/anc-fees.pdf` && heldReview?.sourceUrl !== CLAIMED_URL,
    heldReview?.sourceUrl,
  );

  check(
    "AN INVENTED CHARGE IS NOT STORED — nothing we read prints it",
    !heldLabels.includes(INVENTED) && gated.dropped.some((d) => d.includes(INVENTED)),
    JSON.stringify(gated.dropped),
  );
  check(
    "A REAL LABEL WITH A WRONG NUMBER IS NOT STORED EITHER — 80% is nowhere on that row",
    !gated.held.some((c) => c.percent === 80) && gated.dropped.filter((d) => d.startsWith(ANC_REVIEW)).length === 1,
    JSON.stringify(gated.dropped),
  );
  check(
    "a charge that is both an amount and a percentage is refused, and says which rule",
    gated.dropped.some((d) => d.startsWith(ANC_FIRE) && /neither a single amount nor a single percentage/.test(d)),
    JSON.stringify(gated.dropped),
  );
  check("every refusal is COUNTED, not silently swallowed", gated.dropped.length === 3, JSON.stringify(gated.dropped));

  // A WRAPPED ROW IS STILL ONE ROW. This is the live Portland failure, reproduced:
  // the schedule prints "Plan Review Fee" on one line and "25% of total electrical
  // permit fee…" on the next, the model reports them stapled into one label (which
  // is what they are), and before the pairing NOTHING matched — so a published,
  // mandatory 25% plan review was dropped as if it did not exist.
  const wrapReported = [{
    label: `${ANC_WRAP_HEAD} — ${ANC_WRAP_TAIL}`,
    kind: "plan_review", percent: 25, percentOf: "of total electrical permit fee",
    conditional: false, appliesTo: "electrical",
    quote: `${ANC_WRAP_HEAD} — ${ANC_WRAP_TAIL}`, sourceUrl: CLAIMED_URL,
  }];
  const wrapped = corroborateAncillaryCharges(wrapReported, ancFinding, ancLedger);
  check(
    "A CHARGE PRINTED ACROSS TWO LINES IS HELD — the label cell above its value cell is one row",
    wrapped.held.length === 1 && wrapped.held[0].percent === 25,
    JSON.stringify(wrapped),
  );
  check(
    "…and its matched line shows BOTH printed lines, so the join is visible, not hidden",
    (wrapped.held[0]?.matchedLine || "").includes(ANC_WRAP_HEAD) && (wrapped.held[0]?.matchedLine || "").includes("25%"),
    wrapped.held[0]?.matchedLine,
  );
  // THE GUARD ON THE PAIRING. A line that already names money never absorbs its
  // neighbour — that is the wind-row mis-attribution, and it must stay refused.
  // Here the fire review ($50.00) is printed directly above the 12% surcharge row.
  const straddle = corroborateAncillaryCharges([{
    label: `${ANC_FIRE} — ${ANC_SURCHARGE}`, kind: "surcharge", percent: 12,
    percentOf: "of the permit fee", conditional: false, appliesTo: "structural",
    quote: "stapled across a priced row", sourceUrl: CLAIMED_URL,
  }], ancFinding, ancLedger);
  check(
    "A PRICED LINE STILL NEVER ABSORBS THE ROW BELOW IT — the pairing did not reopen the wind-row bug",
    straddle.held.length === 0 && straddle.dropped.length === 1,
    JSON.stringify(straddle),
  );

  // THE SURCHARGE HAS TWO ROADS ONTO ONE BRACKET, AND ONLY ONE MAY BE TAKEN.
  // corroborateBrackets can fold a 12% state surcharge INTO the line's own fee;
  // this list can hold the identical 12% to be added ON TOP of it. A bracket
  // carrying both bills the customer twice, and the arithmetic looks deliberate.
  const twoRoads: Array<import("../src/feeSchedules").FeeBracket> = [
    { feeUsd: 200, label: "already carries its own surcharge", stateSurcharge: { percent: 12, quote: "12% surcharge fee as mandated by the State Building Codes Division is applied to all permit fees", sourceUrl: `${base}/anc-fees.pdf` } },
    { feeUsd: 200, label: "carries no surcharge of its own" },
  ];
  attachAncillaryCharges(twoRoads, gated.held);
  check(
    "A BRACKET THAT ALREADY FOLDS THE 12% IN DOES NOT ALSO GET IT AS AN EXTRA CHARGE",
    !(twoRoads[0].ancillaryCharges || []).some((c) => c.kind === "surcharge" && c.percent === 12),
    JSON.stringify(twoRoads[0].ancillaryCharges?.map((c) => c.label)),
  );
  check(
    "…while it keeps every charge that is NOT already inside its fee",
    (twoRoads[0].ancillaryCharges || []).length === 2,
    JSON.stringify(twoRoads[0].ancillaryCharges?.map((c) => c.label)),
  );
  check(
    "…and a bracket with no surcharge of its own STILL GETS the 12% — the dedupe must not lose it",
    (twoRoads[1].ancillaryCharges || []).some((c) => c.kind === "surcharge" && c.percent === 12),
    JSON.stringify(twoRoads[1].ancillaryCharges?.map((c) => c.label)),
  );
  check(
    "the notes read the UNION across brackets, so the dedupe cannot under-report the row",
    /ANCILLARY CHARGES HELD \(3\)/.test(ancillaryChargeNotes(twoRoads, []).join(" | ")),
    ancillaryChargeNotes(twoRoads, []).join(" | "),
  );

  // Production attaches the survivors to every bracket — these charges are levied
  // on the FILING, not on one size tier.
  attachAncillaryCharges(ancFinding.brackets, gated.held);
  const ancNotes = ancillaryChargeNotes(ancFinding.brackets, gated.dropped).join(" | ");
  check("notes itemise what is held, with its count", /ANCILLARY CHARGES HELD \(3\)/.test(ancNotes), ancNotes);
  check("…and print the percentage AS a percentage", /65% of the permit fee/.test(ancNotes), ancNotes);
  check(
    "…and refuse to imply a total that nothing has computed",
    /NOT yet totalled/.test(ancNotes) && !/total(?:s|led)? \$/i.test(ancNotes),
    ancNotes,
  );
  check("THE DROPS ARE VISIBLE, by count and by name", /3 REPORTED ANCILLARY CHARGE\(S\) NOT STORED/.test(ancNotes) && ancNotes.includes(INVENTED), ancNotes);
  check("no note segment carries the ' | ' that would shred it into two", !/HELD \(3\)[^|]*\| /.test(ancNotes.split(" | ")[0] || ""), ancNotes.split(" | ")[0]);

  // AN UNKNOWN MUST NEVER READ AS REASSURANCE. A pass that reported nothing must
  // not leave a row implying the permit line is the whole bill.
  const silentNotes = ancillaryChargeNotes([{ feeUsd: 200, label: ANC_PERMIT }], []).join(" | ");
  check(
    "reporting NOTHING reads as an absence of report, never as 'there is nothing else'",
    /ABSENCE OF REPORT/.test(silentNotes) && /several separate bills/.test(silentNotes),
    silentNotes,
  );

  // NOTHING RETRIEVED, NOTHING HELD. A finding resting on web search alone keeps
  // its permit line (advisory, as everywhere else in this module) and loses this
  // list entirely — it is the one shape in which a fabrication and a reading look
  // identical.
  const blind = corroborateAncillaryCharges(reported, ancFinding, newFeeDocumentLedger());
  check("with no document retrieved, NO charge is held", blind.held.length === 0, JSON.stringify(blind.held));
  check("…and all six reported charges are counted as dropped", blind.dropped.length === 6, JSON.stringify(blind.dropped));

  // -------------------------------------------------------------------------
  // 6b. THE REAL WRITE PATH. A field that survives only in memory is not stored.
  // -------------------------------------------------------------------------
  const ancTarget = { state: "OR", ahj: "City of Several Bureaus", track: "permit" as const, discipline: "structural" };
  const ancSave = saveFeeSchedule(db, ancTarget, ancFinding, { corroborateAgainst: ancLedger });
  check("the schedule saved", ancSave.saved, ancSave.reason);
  const ancKey = feeScheduleProfileKey(ancTarget, "permit");
  const ancRow = getFeeSchedule(db, ancKey, "permit", "structural");
  const storedCharges = (ancRow?.brackets || [])[0]?.ancillaryCharges || [];
  check(
    "THE CHARGES SURVIVE THE ROUND TRIP THROUGH SQLITE — read back off the stored row",
    storedCharges.length === 3,
    JSON.stringify((ancRow?.brackets || [])[0] ?? null),
  );
  check(
    "…the percentage is still a percentage after the round trip",
    storedCharges.find((c) => c.label === ANC_REVIEW)?.percent === 65
      && storedCharges.find((c) => c.label === ANC_REVIEW)?.amountUsd === undefined,
    JSON.stringify(storedCharges.find((c) => c.label === ANC_REVIEW) ?? null),
  );
  check(
    "…and its printed row came back with it, so the number can be checked",
    (storedCharges.find((c) => c.label === ANC_FIRE)?.matchedLine || "").includes("$50.00"),
    storedCharges.find((c) => c.label === ANC_FIRE)?.matchedLine,
  );
  check("…on a row that is SEEDED, never verified — rule 3 is a human's signature", ancRow?.confidence === "seeded", ancRow?.confidence);

  // A CALLER THAT CANNOT SHOW WHAT IT READ MAY NOT ASSERT IT. Same finding, same
  // brackets, no ledger — the path scripts/apply-fee-findings.ts takes.
  const ancBlindTarget = { state: "OR", ahj: "City of No Ledger", track: "permit" as const, discipline: "structural" };
  const blindSave = saveFeeSchedule(db, ancBlindTarget, ancFinding);
  check("the unledgered save still stores the fee itself", blindSave.saved, blindSave.reason);
  const blindRow = getFeeSchedule(db, feeScheduleProfileKey(ancBlindTarget, "permit"), "permit", "structural");
  check(
    "…but its ancillary charges are STRIPPED — untrusted input may not assert a printed row",
    !((blindRow?.brackets || [])[0]?.ancillaryCharges?.length),
    JSON.stringify((blindRow?.brackets || [])[0] ?? null),
  );

  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\nfeeResearchRetrieval: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
