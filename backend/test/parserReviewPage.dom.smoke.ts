// THE PARSER PAGE, WIRED — real Chromium, real parser.html, synthetic documents, recorded
// (PII-free) smart-read responses. The unit test proves the rules; this proves the page
// calls them: the meter verdict is recomputed after the smart-read passes, the review list
// renders RESOLVED / UNSURE / MISSING / CONFLICTS, the two passes' notes become one
// attributed section each with the "not supplied" claim stripped, a general-note tap
// mention does not set scope, and no 811 flag fires for a roof-only breaker job under a
// utility with no SOP.
//
// Discovered by scripts/run-dom-smokes.ts (*.dom.smoke.ts). Direct:
//   npx tsx backend/test/parserReviewPage.dom.smoke.ts
// Needs the network for the page's CDN scripts (pdf.js, tesseract).
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { REPO, ISOLATED_CWD } from "./_isolate";
import express from "express";
import { chromium } from "playwright";
import { PDFDocument, StandardFonts } from "pdf-lib";

// ---- synthetic plan set: cover + notes + SLD (look-alike text, no real project) ----
async function makePlanPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = (lines: string[]) => {
    const p = pdf.addPage([792, 612]);
    let y = 580;
    for (const l of lines) { p.drawText(l, { x: 30, y, size: 9, font }); y -= 14; }
  };
  page([
    "PV 0.0 COVER SHEET  JANE SAMPLE RESIDENCE  100 EXAMPLE RD SAMPLE CITY, MA 02100, USA",
    "PHOTOVOLTAIC SYSTEM SPECIFICATIONS:  SYSTEM SIZE: 4.300 KW DC 3.490 KW AC",
    "MODULE TYPE & AMOUNT: (10) Q.TRON BLK M-G2.C1+/AC - 430W  MICRO-INVERTER: (10) QCELLS Q.MI.349B-G1 (240V)",
    "INTERCONNECTION METHOD: LOAD BREAKER  AHJ: SAMPLE CITY  UTILITY: SAMPLE POWER  UTILITY METER NUMBER: 3141592",
    "SHEET INDEX  PV 0.0 COVER  PV 1.0 SITE PLAN  E 1.1 3-LINE DIAGRAM  E 1.2 NOTES",
    "SITE PLAN  ROOF #1  NOTE : ATTIC RUN - YES  ATTIC FAN - NO  SHUTDOWN - NO  MID CLAMPS 16",
    "RAFTER SIZE & SPACING - 2\"X10\" @ 16\" O.C.  Distributed Load 2.58 Per SqFt",
  ]);
  page([
    "E 1.1 3-LINE DIAGRAM  UTILITY COMPANY - SAMPLE POWER  UTILITY METER# 3141592  EXISTING BI-DIRECTIONAL UTILITY METER",
    "POINT OF INTERCONNECT, LOAD BREAKER 20A/2P  EXISTING 240V/125A BUS BAR RATING, MAIN SERVICE PANEL  WITH A 100A MAIN BREAKER (N) PV BREAKER",
    "WIRE TAG  L1 L2 N G  PV MODULE RATING  INVERTER CHARACTERISTICS",
  ]);
  page([
    "E 1.2 INTERCONNECTION NOTES  WIRE TAG  BUS BAR RATING  POINT OF INTERCONNECT",
    "4. THE COMBINED OVERCURRENT DEVICE MAY BE EXCLUDED ACCORDING TO NEC 705.12 (B)(3)(3).",
    "5. FEEDER TAP INTERCONNECTION (LOADSIDE) ACCORDING TO NEC 705.12 (B)(1)",
    "6. SUPPLY SIDE TAP INTERCONNECTION ACCORDING TO NEC 705.11 WITH SERVICE ENTRANCE CONDUCTORS",
    "PV SYSTEM CIRCUITS SHALL INCLUDE A RAPID SHUTDOWN FUNCTION PER NEC 690.12(A) THROUGH (D)  WARNING LABELS",
  ]);
  return Buffer.from(await pdf.save());
}
// a 1x1 PNG is enough: the vision response is recorded, the bytes are never read.
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// ---- recorded smart-read responses (the shape the backend returns; no real project) ----
const VISION = {
  provider: "claude",
  fields: {
    owner: { value: "JANE SAMPLE", confidence: 0.97, evidence: { source: "utility_bill", sheet: "header", excerpt: "Service Provided To: JANE SAMPLE" } },
    utility: { value: "Sample Power", confidence: 0.96, evidence: { source: "utility_bill", sheet: "logo", excerpt: "SAMPLE POWER" } },
    account: { value: "10000000001", confidence: 0.92, evidence: { source: "utility_bill", sheet: "header", excerpt: "Account Number: 1000 000 0001" } },
    meter: { value: "3141592", confidence: 0.96, evidence: { source: "utility_bill", sheet: "meter table / faceplate", excerpt: "Meter Number 3141592 | SAMPLE ELECTRIC 3141592" } },
    state: { value: "MA", confidence: 0.97, evidence: { source: "utility_bill", sheet: "address", excerpt: "SAMPLE CITY MA 02100" } },
  },
  lowConfidenceFields: [],
  notes: "Meter number matches on both bill and meter faceplate. Account printed in three spaced segments.",
  documentsSeen: ["utility_bill", "meter_photo"],
};
const TEXT = {
  provider: "claude",
  fields: {
    owner: { value: "Jane Sample", confidence: 0.45, evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "JANE SAMPLE RESIDENCE" } },
    street: { value: "100 Example Rd", confidence: 0.97, evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "100 EXAMPLE RD" } },
    city: { value: "Sample City", confidence: 0.97, evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "SAMPLE CITY, MA 02100" } },
    state: { value: "MA", confidence: 0.97, evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "SAMPLE CITY, MA 02100" } },
    utility: { value: "Sample Power", confidence: 0.95, evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "UTILITY: SAMPLE POWER" } },
    meter: { value: "3141592", confidence: 0.9, evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "UTILITY METER NUMBER: 3141592" } },
    dcKw: { value: 4.3, confidence: 0.96, evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "SYSTEM SIZE: 4.300 KW DC" } },
    acKw: { value: 3.49, confidence: 0.96, evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "3.490 KW AC" } },
    interco: { value: "Load-side breaker", confidence: 0.9, evidence: { source: "plan_set", sheet: "PV 0.0 / E 1.1", excerpt: "INTERCONNECTION METHOD: LOAD BREAKER" } },
    moduleModel: { value: "Q.TRON BLK M-G2.C1+/AC", confidence: 0.93, evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "(10) Q.TRON BLK M-G2.C1+/AC - 430W" } },
    moduleWattage: { value: 430, confidence: 0.95, evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "430W" } },
    moduleQty: { value: 10, confidence: 0.96, evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "(10) Q.TRON" } },
    deadLoad: { value: 3, confidence: 0.85, evidence: { source: "structural_letter", sheet: "p.2", excerpt: "Dead Load 3.00 psf" } },
    buildingHeightFeet: { value: 25, confidence: 0.55, evidence: { source: "structural_letter", sheet: "p.1", excerpt: "Roof Height 25 ft" } },
    buildingHeightInches: { value: 0, confidence: 0.5, evidence: { source: "structural_letter", sheet: "p.1", excerpt: "Roof Height 25 ft" } },
    dwellingUnits: { value: 1, confidence: 0.55, evidence: { source: "plan_set", sheet: "PV 0.0", excerpt: "JANE SAMPLE RESIDENCE" } },
    framingType: { value: "truss", confidence: 0.45, evidence: { source: "structural_letter", sheet: "p.2", excerpt: "into trusses" } },
    contractorCompany: { value: "Sample Solar Co", confidence: 0.9, evidence: { source: "plan_set", sheet: "title block", excerpt: "SAMPLE SOLAR CO" } },
    contractorEmail: { value: "N/A", confidence: 0.9, evidence: { source: "plan_set", sheet: "title block", excerpt: "EMAIL: N/A" } },
    contractorPhone: { value: "1-800-000-0000", confidence: 0.9, evidence: { source: "plan_set", sheet: "title block", excerpt: "PHONE: 1-800-000-0000" } },
  },
  lowConfidenceFields: ["owner", "buildingHeightFeet", "buildingHeightInches", "dwellingUnits", "framingType", "attachmentEdgeSpacingIn"],
  uncertainties: [{ field: "buildingHeightFeet", kind: "unconfirmed", reason: "roof height taken as building height" }],
  conflicts: [
    { field: "deadLoad", readings: [{ value: 3, source: "structural_letter", sheet: "p.2", excerpt: "Dead Load 3.00 psf" }, { value: 2.58, source: "plan_set", sheet: "PV 1.0", excerpt: "Distributed Load 2.58 Per SqFt" }] },
    { field: "framingType", readings: [{ value: "rafter", source: "structural_letter", sheet: "p.1", excerpt: "Rafter Size 2x10 in" }, { value: "truss", source: "structural_letter", sheet: "p.2", excerpt: "into trusses" }, { value: "rafter", source: "plan_set", sheet: "PV 1.0", excerpt: "RAFTER SIZE & SPACING - 2\"X10\" @ 16\" O.C." }] },
  ],
  notes: "NAME CONFLICT: title block vs letter — verify homeowner name with the utility bill (no bill supplied). No utility bill or meter photo provided, so account number is unknown. Building height taken from the letter's 'Roof Height 25 ft'.",
  documentsSeen: ["plan_set", "structural_letter"],
  resolutions: [{ field: "moduleMake", value: "Sample Modules Inc.", how: "CEC equipment list: module Q.TRON BLK M-G2.C1+/AC is listed under Sample Modules Inc." }],
};

// ---- serve the real frontend folder, answer the API from the recordings ----
const app = express();
app.use(express.static(path.join(REPO, "frontend")));
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

const tmp = path.join(ISOLATED_CWD, "docs");
fs.mkdirSync(tmp, { recursive: true });
const planPath = path.join(tmp, "sample-plan.pdf");
fs.writeFileSync(planPath, await makePlanPdf());
const billPath = path.join(tmp, "sample-bill.png");
fs.writeFileSync(billPath, PNG_1x1);
const meterPath = path.join(tmp, "sample-meter.jpg");
fs.writeFileSync(meterPath, PNG_1x1);
const letterPath = path.join(tmp, "sample-letter.pdf");
{
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p = pdf.addPage([612, 792]);
  ["STRUCTURAL LETTER  RE: Roof Mounted PV System  Robin Other Residence  100 Example Rd", "Roof Height 25 ft  Rafter Type Spruce-Pine-Fir  Rafter Size 2x10 in  Rafter Spacing 16 in", "Dead Load 3.00 psf  For (2) #14 X 3\", 1/2\" Hex into trusses"].forEach((l, i) => p.drawText(l, { x: 30, y: 740 - i * 14, size: 9, font }));
  fs.writeFileSync(letterPath, Buffer.from(await pdf.save()));
}

let failures = 0;
const check = (label: string, fn: () => void) => { try { fn(); console.log(`  ok   - ${label}`); } catch (e) { failures++; console.error(`  FAIL - ${label}: ${(e as Error).message}`); } };

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const calls: string[] = [];
  await page.route("**/api/parser/**", async (route) => {
    const url = new URL(route.request().url()).pathname;
    calls.push(url);
    const body = url.endsWith("vision-extract") ? VISION : TEXT;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  // tsx wraps every function it compiles in __name(); page.evaluate ships the source into
  // the page, where __name is not defined. The shim makes it the identity.
  await page.addInitScript("window.__name = (fn) => fn;");
  await page.goto(`http://127.0.0.1:${port}/parser.html`, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => Boolean((window as unknown as { pdfjsLib?: unknown }).pdfjsLib && (window as unknown as { ParserReview?: unknown }).ParserReview), null, { timeout: 60000 });
  await page.setInputFiles("#planFile", planPath);
  await page.setInputFiles("#ubFile", billPath);
  await page.setInputFiles("#meterPhotoFile", meterPath);
  await page.setInputFiles("#structuralLetterFile", letterPath);
  await page.click("#parseBtn");
  await page.waitForFunction(() => /All done|INCOMPLETE|Parse failed/.test(document.getElementById("parseStatus")!.textContent || ""), null, { timeout: 5 * 60 * 1000, polling: 500 });

  // `state` is a script-scope const in parser.html: not a window property, but visible to a
  // function evaluated in the page's global scope. Declared here only so tsc accepts the name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare const state: any;
  const out = await page.evaluate(() => {
    const v = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";
    const s = typeof state !== "undefined" ? state : null;
    return {
      status: document.getElementById("parseStatus")!.textContent || "",
      verdict: v("ubMeterVerification"), planMeter: v("planMeterNumber"), ubMeter: v("ubMeterNumber"),
      critical: v("criticalWarnings"), flags: v("reviewFlags"),
      scope: s?.electricalScope ? { nonBreakerTypes: s.electricalScope.decision?.nonBreakerTypes, locates: s.electricalScope.flags?.locatesNeeded, utility: s.electricalScope.decision?.utility, rule: s.electricalScope.decision?.rule, tapIgnored: (s.electricalScope.tapIgnored || []).length, tapKept: (s.electricalScope.evidence || []).filter((e: { type: string }) => e.type === "TAP").map((e: { text: string; snippet: string; page: number }) => ({ page: e.page, text: e.text, snippet: String(e.snippet).slice(0, 300) })) } : null,
      priority: s?.utilityPriorityFlags ?? [],
    };
  });

  check("both smart-read passes were called through the page", () => { assert.ok(calls.some((c) => c.endsWith("vision-extract")) && calls.some((c) => c.endsWith("llm-extract")), calls.join(",")); });
  check("no page errors", () => assert.deepEqual(pageErrors, []));
  check("1. meter: verdict recomputed after the passes — DIGITS MATCH from plan meter vs UB meter", () => {
    assert.equal(out.planMeter, "3141592"); assert.equal(out.ubMeter, "3141592");
    assert.equal(out.verdict, "DIGITS MATCH");
    assert.doesNotMatch(out.critical, /METER VERIFICATION/);
  });
  check("7. layout: CONFLICTS / UNSURE / MISSING / RESOLVED with counts, no bare 'not fully sure'", () => {
    assert.match(out.critical, /CONFLICTS \(\d+\)/); assert.match(out.critical, /UNSURE \(\d+\)/);
    assert.match(out.critical, /MISSING \(\d+\)/); assert.match(out.critical, /RESOLVED \(\d+\)/);
    assert.doesNotMatch(out.critical, /Not fully sure/); assert.doesNotMatch(out.flags, /Not fully sure/);
  });
  check("3. resolution on the page: stated height, sealed-source dead load, owner by bill, single-family, CEC make; framing conflict; edge spacing missing", () => {
    assert.match(out.critical, /buildingHeightFeet = 25 — stated on the structural letter/);
    assert.match(out.critical, /deadLoad = 3 — sealed structural letter governs/);
    assert.match(out.critical, /owner = JANE SAMPLE — utility bill account holder/);
    assert.match(out.critical, /dwellingUnits = 1 — single-family residence/);
    assert.match(out.critical, /moduleMake = Sample Modules Inc\. — CEC equipment list/);
    assert.match(out.critical, /framingType: rafter \(structural letter p\.1[^)]*\) vs truss/);
    assert.match(out.critical, /attachmentEdgeSpacingIn — structural letter or racking engineer/);
  });
  check("6. RSD contradiction is a structured conflict", () => assert.match(out.critical, /rapidShutdown: NO \(plan set/));
  check("2. notes: one attributed section per pass; the 'not supplied' claims are gone; N/A dropped from the installer line", () => {
    assert.equal((out.flags.match(/^Notes/gm) || []).length, 1, out.flags);
    assert.match(out.flags, /^Notes — \(bill \/ meter photos, read: utility bill \+ meter photo\): .* ‖ \(plan set text, read: plan set \+ structural letter\): /m);
    assert.doesNotMatch(out.flags, /no bill supplied|No utility bill or meter photo provided/);
    assert.match(out.flags, /verify homeowner name with the utility bill/);
    assert.match(out.flags, /Plan-set installer read from the title block: Sample Solar Co \| 1-800-000-0000$/m);
    assert.doesNotMatch(out.flags, /N\/A|CCB/);
  });
  check("6b + 5 + 4. tap notes ignored, breaker-only, no 811, utility identified with no SOP", () => {
    assert.deepEqual(out.scope?.nonBreakerTypes, [], JSON.stringify(out.scope));
    assert.equal(out.scope?.locates, false);
    assert.ok((out.scope?.tapIgnored ?? 0) >= 1, "the general-note tap mentions were seen and ignored");
    assert.equal(out.scope?.utility, "OTHER");
    assert.match(String(out.scope?.rule), /Sample Power \(identified; no utility-specific D\/R rules on file/);
    assert.doesNotMatch(out.critical, /non-breaker scope was also detected: TAP|811|not confidently identified/);
    assert.deepEqual(out.priority, []);
  });
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\nparserReviewPage.dom.smoke: ${failures} FAILED`); process.exit(1); }
console.log("\nparserReviewPage.dom.smoke: PASS");
