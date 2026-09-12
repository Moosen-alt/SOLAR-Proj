// Reading a fee table BY ROW instead of by reading order. The fixture is a real
// PDF, generated here, whose text stream is deliberately scrambled the way the
// City of Coos Bay schedule's is: "Structural" is emitted before the row above
// it and "Plan Review" after, so reading the stream in order pairs
//     "Plan Review" | "65% of permit fee"
// and hangs "Structural" on the $200 solar row. Test 3 PROVES the fixture is
// adversarial (the naive pairing really is wrong) before test 4 proves the
// coordinate pairing fixes it — a fixture that passes without the fix proves
// nothing. Browser/DB/network-free. Run: tsx backend/test/pdfTables.test.ts
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  extractPdfRows,
  extractPdfTextItems,
  findFeeRows,
  findMoneyCells,
  parseBracketRow,
  parseMoney,
  type PdfTextItem,
  type PdfTextRow,
} from "../src/pdfTables";

let passed = 0;
const ok = (n: string) => { passed++; console.log(`ok   ${n}`); };

const SIZE = 10;

// A two-column fee table. Column 1 (description) at x=50, column 2 (value) at
// x=400 — and the draw order below is NOT top-to-bottom.
async function makeFeeSchedulePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage([612, 792]);
  const page2 = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const draw = (p: typeof page1, s: string, x: number, y: number) => p.drawText(s, { x, y, size: SIZE, font });
  // One space-width to the right of "Structural" — the same cell, two stream items.
  const afterStructural = 50 + font.widthOfTextAtSize("Structural ", SIZE);

  draw(page1, "Structural", 50, 660);                                                    // row 3, part 1
  draw(page1, "Solar Permit (when required) - Prescriptive Path System,", 50, 700);      // row 1
  draw(page1, "fee includes plan review", 50, 686);                                      // row 1, wrapped
  draw(page1, "$200.00", 400, 700);                                                      // row 1 value
  draw(page1, "Plan Review", afterStructural, 660);                                      // row 3, part 2
  draw(page1, "65% of permit fee", 400, 660);                                            // row 3 value
  draw(page1, "Renewable energy for electrical systems - 5.01kva through 15kva", 50, 630);
  draw(page1, "$175.00", 400, 630);
  // Value emitted BEFORE its description: this row's stream runs right-to-left,
  // which is what makes sorting a row by x load-bearing rather than decorative.
  draw(page1, "$250.00", 400, 612);
  draw(page1, "Renewable energy for electrical systems - 15.01kva through 25kva", 50, 612);
  draw(page1, "Solar array reroof, 2,001 to 3,600 square-feet", 50, 594);
  draw(page1, "$88.00", 400, 594);
  draw(page1, "Solar system less than 5kw", 50, 576);
  draw(page1, "$50.00", 400, 576);
  // A multiplier in a dollar-formatted value column, as the real Coos County
  // land-use schedule prints it ("Community Development Fee *(% of Land Use
  // application fee)" | "$" "0.05"). The number is real; the dollars are not.
  draw(page1, "Solar plan review *(% of permit fee)", 50, 558);
  draw(page1, "0.65", 400, 558);
  // Same baseline as a page-1 row: rows must group by (page, y), never y alone.
  draw(page2, "Solar Permit - City of Elsewhere", 50, 660);
  draw(page2, "$310.00", 400, 660);

  return doc.save();
}

/** How a reading-order reader pairs a fee table: accumulate text, and when a
 *  token looks like money, call everything before it the label. This is the
 *  thing being disproved, so it lives in the test, not in the module. */
function naiveReadingOrderPairs(items: PdfTextItem[]): Array<{ label: string; feeUsd: number }> {
  const out: Array<{ label: string; feeUsd: number }> = [];
  let buf: string[] = [];
  for (const it of items) {
    const amount = parseMoney(it.str);
    if (amount != null) { out.push({ label: buf.join(" ").replace(/\s+/g, " ").trim(), feeUsd: amount }); buf = []; }
    else buf.push(it.str);
  }
  return out;
}

const rowText = (r: PdfTextRow) => r.cells.join(" | ");
const findRow = (rows: PdfTextRow[], needle: string) => rows.find((r) => rowText(r).includes(needle));

/** feeSchedules.ts matchBracket, restated: "Bounds are INCLUSIVE at both ends
 *  and an absent bound is open." The parser must agree with the one evaluator. */
const covers = (b: { minKw?: number; maxKw?: number }, kw: number) =>
  (b.minKw == null || kw >= b.minKw) && (b.maxKw == null || kw <= b.maxKw);

async function main(): Promise<void> {
  const bytes = await makeFeeSchedulePdf();
  const rows = await extractPdfRows(bytes);
  const page1 = rows.filter((r) => r.page === 1);

  // 1) Baselines become rows, in visual order, top of the page first.
  assert.equal(page1.length, 8, `expected 8 visual rows on page 1, got ${page1.length}: ${page1.map(rowText).join(" // ")}`);
  assert.ok(page1[0].y > page1[1].y, "rows come back top-to-bottom (PDF y grows upward)");
  assert.deepEqual(page1[0].cells, ["Solar Permit (when required) - Prescriptive Path System,", "$200.00"]);
  assert.ok(page1.every((r) => r.cells.every((c) => c.trim().length > 0)), "pdfjs' synthetic blank spacer items never become cells");
  ok("extractPdfRows groups text items into visual rows, cells left to right");

  // 2) The row the lead measured: two stream items, separated by items from
  //    OTHER rows, rejoined into one cell because they share a baseline.
  const structural = findRow(page1, "Structural");
  assert.ok(structural, "expected a Structural Plan Review row");
  assert.deepEqual(structural!.cells, ["Structural Plan Review", "65% of permit fee"]);
  ok('"Structural" + "Plan Review" rejoin into one cell — same baseline, adjacent x');

  // 3) THE FIXTURE IS ADVERSARIAL: reading order really does pair wrongly.
  const items = await extractPdfTextItems(bytes, { pages: [1] });
  const naive = naiveReadingOrderPairs(items);
  assert.equal(naive[0].feeUsd, 200);
  assert.ok(naive[0].label.includes("Structural"), `reading order should hang "Structural" on the $200 row, got: ${naive[0].label}`);
  assert.ok(naive[1].label.startsWith("Plan Review"), `reading order should orphan "Plan Review", got: ${naive[1].label}`);
  assert.ok(naive[1].label.includes("65% of permit fee"), "and glue the percentage onto the NEXT row's label");
  ok("reading order pairs the wrong description with the fee — the bug this module exists for");

  // 4) Same PDF, read by row: the $200 belongs to the solar line and nothing else.
  const fees = findFeeRows(rows);
  const solar = fees.filter((f) => f.money.some((m) => m.amountUsd === 200));
  assert.equal(solar.length, 1, "exactly one row carries the $200");
  assert.ok(solar[0].label.startsWith("Solar Permit (when required) - Prescriptive Path System,"));
  assert.ok(!solar[0].label.includes("Structural"), `the $200 label must not borrow "Structural": ${solar[0].label}`);
  assert.equal(solar[0].money.length, 1);
  assert.equal(solar[0].note, undefined);
  ok("row-aware pairing puts $200.00 on the solar line, with no borrowed words");

  // 5) A label wrapped onto a second visual line is folded in, not truncated —
  //    and the wrapped line is never reported as a fee row of its own.
  assert.deepEqual(solar[0].continuations, ["fee includes plan review"]);
  assert.ok(solar[0].label.endsWith("fee includes plan review"), `wrapped line must survive: ${solar[0].label}`);
  assert.ok(findRow(page1, "fee includes plan review"), "the wrapped line is still its own visual row in the raw extraction");
  assert.ok(!fees.some((f) => f.row.cells.join(" ") === "fee includes plan review"), "…but never a fee row in its own right");
  // The percentage row sits directly below and is moneyless too — it is kept
  // OUT by the column test (it reaches the value column), not by luck.
  assert.ok(!solar[0].label.includes("Plan Review"), "the moneyless percentage row is not swallowed as a continuation");
  ok("a row spanning two visual lines is folded into its label, and only the wrapped line is");

  // 6) parseMoney matches whole cells. A percentage and a square-foot range are
  //    not dollar amounts, however many digits they carry.
  for (const [cell, want] of [
    ["$200.00", 200], ["200", 200], ["$1,234.56", 1234.56], ["$0.00", 0], ["1,234", 1234], ["$ 88", 88],
    ["65% of permit fee", null], ["2,001 to 3,600 square-feet", null], ["200 amp service", null],
    ["Fee as per Structural Permit Fee table by valuation", null], ["", null], ["$100 - $200", null], ["15.01kva", null],
  ] as Array<[string, number | null]>) {
    assert.equal(parseMoney(cell), want, `parseMoney(${JSON.stringify(cell)}) should be ${want}`);
  }
  assert.notEqual(parseMoney("$0.00"), null, "a sourced $0.00 is a finding, not a gap");
  ok("parseMoney reads money and refuses percentages, ranges and descriptions");

  const reroof = findRow(page1, "square-feet");
  assert.ok(reroof, "expected the reroof row");
  const reroofMoney = findMoneyCells(reroof!);
  assert.equal(reroofMoney.length, 1, `only $88.00 is money in ${rowText(reroof!)}`);
  assert.equal(reroofMoney[0].amountUsd, 88);
  ok('"2,001 to 3,600 square-feet" is not quoted as a fee');

  // 7) Brackets, with the boundary that decides which tier a job is billed in.
  const lower = parseBracketRow(findRow(page1, "5.01kva")!);
  const upper = parseBracketRow(findRow(page1, "15.01kva")!);
  assert.deepEqual(
    { minKw: lower.minKw, maxKw: lower.maxKw, feeUsd: lower.feeUsd, unparsed: lower.unparsed },
    { minKw: 5.01, maxKw: 15, feeUsd: 175, unparsed: undefined },
  );
  assert.deepEqual(
    { minKw: upper.minKw, maxKw: upper.maxKw, feeUsd: upper.feeUsd, unparsed: upper.unparsed },
    { minKw: 15.01, maxKw: 25, feeUsd: 250, unparsed: undefined },
  );
  // INCLUSIVE/INCLUSIVE, verbatim from the printed numbers: 15.00 is the lower
  // row, 15.01 the upper, and there is no value between them with no row.
  assert.ok(covers(lower, 15) && !covers(upper, 15), "15.00 kVA belongs to the 5.01–15 row");
  assert.ok(covers(upper, 15.01) && !covers(lower, 15.01), "15.01 kVA belongs to the next row up");
  assert.ok(covers(lower, 5.01) && !covers(lower, 5), "the printed lower bound is inclusive too");
  assert.equal(
    [15, 15.005, 15.01].filter((kw) => !covers(lower, kw) && !covers(upper, kw)).length, 1,
    "only a value the schedule itself never prints (15.005) falls between the rows",
  );
  ok("bracket bounds parse inclusive/inclusive, so 15.00 and 15.01 land in different tiers");

  // 8) What it refuses to guess.
  const exclusive = parseBracketRow(findRow(page1, "less than 5kw")!);
  assert.equal(exclusive.feeUsd, 50, "the fee is readable even when the bound is not");
  assert.equal(exclusive.maxKw, undefined, "no invented 4.99");
  assert.ok(/less than 5kw/i.test(exclusive.unparsed ?? ""), `unparsed must name the phrase: ${exclusive.unparsed}`);
  const percent = parseBracketRow(structural!);
  assert.equal(percent.feeUsd, undefined);
  assert.ok(/no dollar amount/i.test(percent.unparsed ?? ""), `moneyless row reports, never returns 0: ${percent.unparsed}`);
  assert.equal(percent.label, "Structural Plan Review");
  ok("an exclusive bound and a percentage-only row come back unparsed, not guessed");

  // 8b) The percent sign on the OTHER side: the label says "% of", and the
  //     value column holds a bare multiplier that parseMoney is right to read
  //     as a number. Quoting it as $0.65 would be a 65-cent plan review.
  const proportion = fees.find((f) => f.label.includes("% of permit fee"));
  assert.ok(proportion, "expected the proportional plan-review row");
  assert.deepEqual(proportion!.money.map((m) => m.amountUsd), [0.65], "the cell really does parse as a number");
  assert.ok(/multiplier, not dollars/i.test(proportion!.note ?? ""), `findFeeRows must flag it: ${proportion!.note}`);
  const proportionBracket = parseBracketRow(proportion!);
  assert.equal(proportionBracket.feeUsd, undefined, "65% of the permit fee is not a $0.65 fee");
  assert.ok(/proportion of another fee/i.test(proportionBracket.unparsed ?? ""), proportionBracket.unparsed);
  ok("a multiplier in the value column is not quoted as dollars (real Coos County shape)");

  // 9) Pages are separate row spaces, and `pages` selects.
  const elsewhere = rows.filter((r) => r.page === 2);
  assert.equal(elsewhere.length, 1);
  assert.deepEqual(elsewhere[0].cells, ["Solar Permit - City of Elsewhere", "$310.00"]);
  assert.ok(!page1.some((r) => rowText(r).includes("Elsewhere")), "a page-2 row at y=660 never joins the page-1 row at y=660");
  const onlyPage2 = await extractPdfRows(bytes, { pages: [2] });
  assert.equal(onlyPage2.length, 1);
  assert.equal(onlyPage2[0].page, 2, "page numbers are 1-BASED (unlike formTextLayer's LabelItem.page)");
  ok("rows group by (page, y); the pages option reads one page of a 25-page schedule");

  // 10) KILL TEST — widen the y tolerance until rows merge and the pairing this
  //     whole module exists to produce must VANISH. If it survives, the tests
  //     above were passing for some reason other than the grouping.
  const clean = (rs: Array<{ label: string; money: Array<{ amountUsd: number }> }>) =>
    rs.filter((f) => f.label.includes("Prescriptive Path System") && !f.label.includes("Structural")
      && f.money.length === 1 && f.money[0].amountUsd === 200);
  assert.equal(clean(findFeeRows(rows)).length, 1, "with the default tolerance the clean pairing exists");
  const merged = await extractPdfRows(bytes, { yTolerance: 45 });
  assert.ok(merged.filter((r) => r.page === 1).length < page1.length, "a widened tolerance really does merge rows");
  assert.equal(
    clean(findFeeRows(merged)).length, 0,
    "y-grouping is load-bearing: merge the rows and the correct solar/$200 pairing must not survive",
  );
  ok("kill test: widening the y tolerance destroys the pairing — the grouping is doing the work");

  console.log(`\n${passed} checks passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
