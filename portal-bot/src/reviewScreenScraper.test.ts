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

/** A NEM filing types the account and the meter (B8: the comparison is told what was entered). */
const NEM = { accountNumber: true, meterNumber: true };

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
    const m = compareReviewFields(structuredReview(), project, NEM);
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
    const m = compareReviewFields([], project, NEM, bodyText);
    assert.equal(m.length, 0, `read-only review with body text should have no mismatches, got ${JSON.stringify(m)}`);
    console.log("  ✅ empty scrape + body text → values found, no phantom mismatches");
  }

  // 3) Truly unreadable review (no fields, no text) → ONE honest "could not read" signal,
  //    NOT a phantom mismatch per field.
  {
    const m = compareReviewFields([], project, NEM, "");
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
    const m = compareReviewFields([], project, NEM, bodyText);
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
    const m = compareReviewFields(fields, project, NEM, "Applicant Testy McTestface Address 1420 Marigold Street Size 3.21 kW");
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
    const c = reviewComparison(fields, sparse, NEM, "Level 2 Application? false");
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
    const c = reviewComparison([{ label: "Fee", value: "$0.00" }], zeros, NEM, "Fee $0.00 filed 2026-10-01");
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
    const c = reviewComparison([{ label: "Account Number", value: "…3064" }], real, NEM, "Account Number …3064");
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
    // editable: true is the point, not decoration — these are three LIVE controls on an input
    // page. A hand-written fixture that omits the flag is treated as static markup, which is
    // the safe default: an unknown page reports its mismatches.
    const aggregationPage = [
      { label: "Please make your selection regarding meter aggregation below", value: "No Aggregation", editable: true },
      { label: "Will the output of this generation system serve more than one customer?", value: "No", editable: true },
      { label: "I certify I am the property owner", value: "checked", editable: true },
    ];
    const c = reviewComparison(aggregationPage, project, NEM, "Meter Aggregation No Aggregation Will the output serve more than one customer? No I certify checked");
    assert.equal(c.mismatches.length, 0,
      `a page holding none of the project's values reported ${c.mismatches.length} mismatch(es): ${JSON.stringify(c.mismatches)}`);
    assert.equal(c.confirmed, 0, "and it must not claim to have confirmed anything either");
    console.log("  ✅ a page that is not a review screen reports UNVERIFIED, not mismatched");
  }

  // THE REGRESSION THE DOM SMOKE CAUGHT. An earlier draft suppressed on "nothing confirmed"
  // alone — and a review screen showing the WRONG name confirms nothing either, so the catch
  // that matters most was swallowed. Static markup means it IS a review page: complain.
  {
    const wrongEverything = [
      { label: "Customer Name", value: "Someone Else Entirely", editable: false },
      { label: "Service Address", value: "77 Wrong Avenue", editable: false },
    ];
    const c = reviewComparison(wrongEverything, project, NEM, "Customer Name Someone Else Entirely Service Address 77 Wrong Avenue");
    assert.equal(c.confirmed, 0, "nothing should have confirmed here");
    assert.ok(c.mismatches.length > 0,
      "a review screen where EVERY field is wrong reported nothing — the suppression fails open");
    console.log("  ✅ a review screen where everything is wrong still complains");
  }

  // THE DIRECTION THAT MUST KEEP WORKING. One value found makes this a review screen, and a
  // genuinely wrong field on it is still reported — otherwise the guard has bought silence.
  {
    const realReview = [
      { label: "Customer Name", value: "Testy McTestface", editable: false },
      { label: "Service Address", value: "77 Wrong Avenue", editable: false },
      { label: "System Size (kW)", value: "9.89", editable: false },
    ];
    const c = reviewComparison(realReview, project, NEM, "Customer Name Testy McTestface Service Address 77 Wrong Avenue System Size 9.89");
    assert.ok(c.confirmed >= 1, `a real review screen confirmed nothing: ${JSON.stringify(c)}`);
    assert.ok(c.mismatches.some((m) => m.field === "projectAddress"),
      `the wrong address was not reported: ${JSON.stringify(c.mismatches)}`);
    console.log("  ✅ a REAL review screen still reports a genuinely wrong field");
  }

  // ABSENT FROM THE REVIEW PAGE IS NOT THE REVIEW PAGE DISAGREEING.
  //
  // A live PacifiCorp cross-project run reported homeownerName shows "No; checked" and
  // projectAddress shows "checked; No Aggregation; No; c". Neither is a name or an address:
  // no review field carried a matching label, so the scope fell back to EVERY field and the
  // summary ran unrelated values together. The finding was real (the value could not be
  // confirmed); its DESCRIPTION was fiction - and the verdict said "DO NOT SUBMIT without
  // checking", which sends an operator hunting for a wrong name that was never rendered.
  {
    const fields = [
      { label: "Meter Mounted Device", value: "No" },
      { label: "Acknowledgement", value: "checked" },
    ];
    const project = { homeownerName: "ZZTest CrossProject Bravo", projectAddress: "2419 SE Belmont St" } as never;
    const cmp = reviewComparison(fields, project, NEM, "No checked");
    const owner = cmp.mismatches.find((m) => m.field === "homeownerName");
    if (owner) {
      assert.ok(/could not confirm|no field with this label/i.test(owner.found),
        `found reads "${owner.found}" - an operator would hunt for a wrong name that was never rendered`);
      assert.ok(!owner.found.startsWith("No; checked"),
        "the fallback summary is leaking unrelated field values into found");
      console.log("  ok  an unlabelled review page says it could not confirm, not that it disagrees");
    } else {
      console.log("  ok  an unlabelled review page raised no phantom mismatch at all");
    }
  }

  // ---------------------------------------------------------------------------
  // B8 (dryrun-0928): A UTILITY IDENTIFIER IS CHECKED ONLY WHEN THIS FILING ENTERED IT.
  //
  // Both Accela permit runs said "VERIFY BEFORE SUBMITTING — meterNumber" (a permit application
  // has no meter field), and the account's last four were counted CONFIRMED from digits the
  // page printed for its own reasons. KILL: make reviewComparison ignore `entered` (always check)
  // -> the permit case reports the meterNumber mismatch and counts the account confirmed.
  // ---------------------------------------------------------------------------
  {
    // An Accela-style confirm page: homeowner, address and kW, plus a licence, a parcel and a
    // phone whose digits happen to END in the project's account last-4 ("1111") — no account or
    // meter field anywhere, because a permit never typed one.
    const permitPage: ReviewField[] = [
      { label: "Applicant Name", value: "Testy McTestface" },
      { label: "Work Location", value: "1420 Marigold Street, Portland OR 97201" },
      { label: "System Size (kW DC)", value: "9.89" },
      { label: "CCB License #", value: "241111" },
      { label: "Parcel Number", value: "10-10-10-10-101" },
      { label: "Contact Phone", value: "(503) 555-1111" },
    ];
    const body = "Step 4: Review Applicant Name Testy McTestface Work Location 1420 Marigold Street Portland OR 97201 System Size 9.89 CCB 241111 Parcel 10-10-10-10-101 Phone (503) 555-1111";
    const permit = reviewComparison(permitPage, project, { accountNumber: false, meterNumber: false }, body);
    assert.equal(permit.mismatches.length, 0, `a permit page reported utility-identifier mismatches: ${JSON.stringify(permit.mismatches)}`);
    assert.equal(permit.confirmed, 3, `a permit page must confirm exactly homeowner + address + size, got ${permit.confirmed}`);
    assert.equal(permit.compared, 3, `no account / meter check may even run on a permit page, compared ${permit.compared}`);
    console.log("  ✅ B8 MUST-EXCLUDE: a permit review page is never checked for an account or meter it did not type");

    // The same page, told the filing typed both (the pre-fix behaviour): the meter is "missing"
    // and the account is falsely confirmed from the phone/licence digits — the defect, pinned.
    const asIfTyped = reviewComparison(permitPage, project, NEM, body);
    assert.ok(asIfTyped.mismatches.some((m) => m.field === "meterNumber"), "with the flags on, the permit page's missing meter shows (the old false alarm)");
    console.log("  ✅ B8 (the defect, reproduced with the flags on): the meter is 'missing' on a permit page");

    // MIRROR — the NEM check still bites: a NEM review page with the meter MISSING, meterNumber
    // entered, still reports it.
    const nemMissingMeter: ReviewField[] = [
      { label: "Customer Name", value: "Testy McTestface" },
      { label: "Service Address", value: "1420 Marigold Street" },
      { label: "Account Number", value: "******1111" },
      { label: "Meter Number", value: "" },
    ];
    const nem = reviewComparison(nemMissingMeter, project, { accountNumber: true, meterNumber: true }, "Customer Name Testy McTestface Service Address 1420 Marigold Street Account ******1111 Meter");
    assert.ok(nem.mismatches.some((m) => m.field === "meterNumber"), `a NEM page missing its meter was not flagged: ${JSON.stringify(nem.mismatches)}`);
    console.log("  ✅ B8 MUST-PASS: a NEM review page that lost the meter it typed is still flagged");
  }

  console.log("\n✅ ALL PASS: review-screen comparison tests");
}

run();
