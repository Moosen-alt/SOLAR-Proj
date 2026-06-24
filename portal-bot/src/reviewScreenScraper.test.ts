import assert from "node:assert/strict";
import { compareReviewFields, type ReviewField } from "./reviewScreenScraper";
import type { ProjectRecord } from "../../shared/src/types";

// Browser-free tests for compareReviewFields — the deterministic review-screen check that
// guards against submitting a portal application that silently came back blank.
// Run with: npx tsx portal-bot/src/reviewScreenScraper.test.ts

// Minimal project record — compareReviewFields only reads these fields.
const project = {
  homeownerName: "Jeffery Bienvenu",
  projectAddress: "1420 Marigold Street, Portland, OR 97201",
  systemSizeDcKw: "9.89",
  accountNumber: "4036870000",
  meterNumber: "88812345",
} as unknown as ProjectRecord;

function structuredReview(): ReviewField[] {
  return [
    { label: "Applicant Name", value: "Jeffery Bienvenu" },
    { label: "Service Address", value: "1420 Marigold Street" },
    { label: "System Size (DC kW)", value: "9.89" },
    { label: "Account Number", value: "******0000" },
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
      "Applicant: Jeffery Bienvenu",
      "Service Address: 1420 Marigold Street, Portland, OR 97201",
      "System Size: 9.89 kW DC",
      "Account: ******0000",
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
      "Account: ******0000",
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
      { label: "Applicant Name", value: "Jeffery Bienvenu" },
      { label: "Service Address", value: "1420 Marigold Street" },
      { label: "System Size (DC kW)", value: "3.21" }, // wrong
    ];
    const m = compareReviewFields(fields, project, "Applicant Jeffery Bienvenu Address 1420 Marigold Street Size 3.21 kW");
    assert.ok(m.some((x) => x.field === "systemSizeDcKw"), `wrong system size should be flagged, got ${JSON.stringify(m)}`);
    console.log("  ✅ wrong value flagged (fallback does not mask it)");
  }

  console.log("\n✅ ALL PASS: review-screen comparison tests");
}

run();
