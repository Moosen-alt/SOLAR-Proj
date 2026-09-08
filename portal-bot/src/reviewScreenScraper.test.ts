import assert from "node:assert/strict";
import { compareReviewFields, reviewComparison, type ReviewField } from "./reviewScreenScraper";
import type { ProjectRecord } from "../../shared/src/types";

// Browser-free tests for compareReviewFields — the deterministic review-screen check that
// guards against submitting a portal application that silently came back blank.
// Run with: npx tsx portal-bot/src/reviewScreenScraper.test.ts

// Minimal project record — compareReviewFields only reads these fields.
const project = {
  homeownerName: "Testy McTestface",
  projectAddress: "1420 Marigold Street, Portland, OR 97201",
  systemSizeDcKw: "9.89",
  accountNumber: "9990001111",
  meterNumber: "88812345",
} as unknown as ProjectRecord;

function structuredReview(): ReviewField[] {
  return [
    { label: "Applicant Name", value: "Testy McTestface" },
    { label: "Service Address", value: "1420 Marigold Street" },
    { label: "System Size (DC kW)", value: "9.89" },
    { label: "Account Number", value: "******1111" },
    { label: "Meter Number", value: "******2345" },
  ];
}

function run() {
  // 1) A fully-populated structured review matches the project → no mismatches.
  {
    const m = compareReviewFields(structuredReview(), project);
    assert.equal(m.length, 0, `clean structured review should have no mismatches, got ${JSON.stringify(m)}`);
    console.log("  ✅ populated structured review → no mismatches");
  }

  // 2) THE BUG: read-only review page renders values as text, so the structured scrape is
  //    empty. With the rendered page text passed in, every value is still found → no false
  //    "blank application" mismatches.
  {
    const bodyText = [
      "Step 3: Review",
      "Applicant: Testy McTestface",
      "Service Address: 1420 Marigold Street, Portland, OR 97201",
      "System Size: 9.89 kW DC",
      "Account: ******1111",
      "Meter: ******2345",
      "Please review all information before submitting.",
    ].join("\n");
    const m = compareReviewFields([], project, bodyText);
    assert.equal(m.length, 0, `read-only review with body text should have no mismatches, got ${JSON.stringify(m)}`);
    console.log("  ✅ empty scrape + body text → values found, no phantom mismatches");
  }

  // 3) Truly unreadable review (no fields, no text) → ONE honest "could not read" signal,
  //    NOT a phantom mismatch per field.
  {
    const m = compareReviewFields([], project, "");
    assert.equal(m.length, 1, `unreadable review should yield one signal, got ${JSON.stringify(m)}`);
    assert.equal(m[0].field, "reviewScreen", "unreadable signal uses the reviewScreen field name");
    console.log("  ✅ empty scrape + no body → single 'unreadable' signal, not N phantom mismatches");
  }

  // 4) A genuinely missing/wrong field is STILL caught (the body fallback must not mask real
  //    errors): the homeowner name is absent from both the fields and the page text.
  {
    const bodyText = [
      "Step 3: Review",
      "Service Address: 1420 Marigold Street",
      "System Size: 9.89 kW",
      "Account: ******1111",
      "Meter: ******2345",
    ].join("\n");
    const m = compareReviewFields([], project, bodyText);
    const fields = m.map((x) => x.field);
    assert.ok(fields.includes("homeownerName"), `missing homeowner name should be flagged, got ${JSON.stringify(fields)}`);
    assert.ok(!fields.includes("projectAddress"), "address present in body should NOT be flagged");
    assert.ok(!fields.includes("systemSizeDcKw"), "system size present in body should NOT be flagged");
    console.log("  ✅ real missing field still flagged; present fields not flagged");
  }

  // 5) A wrong system size in the structured fields is caught even when body text exists but
  //    also lacks it (no false pass from the fallback).
  {
    const fields: ReviewField[] = [
      { label: "Applicant Name", value: "Testy McTestface" },
      { label: "Service Address", value: "1420 Marigold Street" },
      { label: "System Size (DC kW)", value: "3.21" }, // wrong
    ];
    const m = compareReviewFields(fields, project, "Applicant Testy McTestface Address 1420 Marigold Street Size 3.21 kW");
    assert.ok(m.some((x) => x.field === "systemSizeDcKw"), `wrong system size should be flagged, got ${JSON.stringify(m)}`);
    console.log("  ✅ wrong value flagged (fallback does not mask it)");
  }

  // 6) ZERO MISMATCHES IS NOT EVIDENCE. Every check returns early when the project has no
  //    value to check with, so a page of boilerplate complains about nothing while
  //    establishing nothing — and the replay ladder's top rung used to accept exactly that.
  {
    const sparse = { homeownerName: "", projectAddress: "", systemSizeDcKw: null, accountNumber: "", meterNumber: "" } as unknown as ProjectRecord;
    const fields: ReviewField[] = [
      { label: "Level 2 Application?", value: "false" },
      { label: "Does The Generation System Size Exceed The Limit?", value: "false" },
    ];
    const c = reviewComparison(fields, sparse, "Level 2 Application? false");
    assert.equal(c.mismatches.length, 0, "nothing to compare should not manufacture mismatches");
    assert.equal(c.confirmed, 0, `nothing was confirmed, but it reported ${c.confirmed}`);
    console.log("  ✅ a page nothing could be checked against confirms 0");
  }

  // 7) A NEEDLE OF ALL ONE DIGIT CANNOT CONFIRM ANYTHING. bodyDigits is every digit on the
  //    page run together, so "0000" turns up in a price, a timestamp, or two adjacent
  //    numbers colliding. The benchmark fixture once carried an all-zero account AND meter,
  //    which would have supplied two of the three confirmations the top rung requires —
  //    from a page that never showed either value.
  {
    const zeros = {
      homeownerName: "", projectAddress: "", systemSizeDcKw: null,
      accountNumber: "00000000 000 0", meterNumber: "ZZ00000000",
    } as unknown as ProjectRecord;
    const c = reviewComparison([{ label: "Fee", value: "$0.00" }], zeros, "Fee $0.00 filed 2026-10-01");
    assert.equal(c.confirmed, 0, `an all-zero needle confirmed ${c.confirmed} field(s) against a page showing neither`);
    assert.equal(c.compared, 0, "an un-evidentiary needle must not even count as compared");
    console.log("  ✅ an all-one-digit needle confirms nothing");
  }

  // ...but a distinctive account number IS confirmable, so the guard has not gone blind.
  {
    const real = {
      homeownerName: "", projectAddress: "", systemSizeDcKw: null,
      accountNumber: "84739218 306 4", meterNumber: "",
    } as unknown as ProjectRecord;
    const c = reviewComparison([{ label: "Account Number", value: "…3064" }], real, "Account Number …3064");
    assert.equal(c.confirmed, 1, `a distinctive account should confirm; got ${JSON.stringify(c)}`);
    console.log("  ✅ a distinctive account number still confirms");
  }

  // ---------------------------------------------------------------------------
  // NOT A REVIEW SCREEN IS NOT A WRONG APPLICATION.
  //
  // Live on PacifiCorp: the run ends on the Aggregation page — the last INPUT page, showing
  // an aggregation choice, a yes/no and a certification box, and none of the values entered
  // eight pages earlier. Every check failed to find its value and the scope fallback dressed
  // those failures in whatever text was on screen, producing `homeownerName shows "No;
  // checked"` and a DO NOT SUBMIT against a filing with zero blanks and 47 verified values.
  // ---------------------------------------------------------------------------
  {
    const aggregationPage = [
      { label: "Please make your selection regarding meter aggregation below", value: "No Aggregation" },
      { label: "Will the output of this generation system serve more than one customer?", value: "No" },
      { label: "I certify I am the property owner", value: "checked" },
    ];
    const c = reviewComparison(aggregationPage, project, "Meter Aggregation No Aggregation Will the output serve more than one customer? No I certify checked");
    assert.equal(c.mismatches.length, 0,
      `a page holding none of the project's values reported ${c.mismatches.length} mismatch(es): ${JSON.stringify(c.mismatches)}`);
    assert.equal(c.confirmed, 0, "and it must not claim to have confirmed anything either");
    console.log("  ✅ a page that is not a review screen reports UNVERIFIED, not mismatched");
  }

  // THE DIRECTION THAT MUST KEEP WORKING. One value found makes this a review screen, and a
  // genuinely wrong field on it is still reported — otherwise the guard has bought silence.
  {
    const realReview = [
      { label: "Customer Name", value: "Testy McTestface" },
      { label: "Service Address", value: "77 Wrong Avenue" },
      { label: "System Size (kW)", value: "9.89" },
    ];
    const c = reviewComparison(realReview, project, "Customer Name Testy McTestface Service Address 77 Wrong Avenue System Size 9.89");
    assert.ok(c.confirmed >= 1, `a real review screen confirmed nothing: ${JSON.stringify(c)}`);
    assert.ok(c.mismatches.some((m) => m.field === "projectAddress"),
      `the wrong address was not reported: ${JSON.stringify(c.mismatches)}`);
    console.log("  ✅ a REAL review screen still reports a genuinely wrong field");
  }

  console.log("\n✅ ALL PASS: review-screen comparison tests");
}

run();
