// ONE DOCUMENT-TYPE PREDICATE, AND THE TYPE EACH DOCUMENT TAKES (attachmentTypes.ts).
//
// Live 2026-09-28, City of Corvallis (aca-prod.accela.com/CORVALLIS, learn run 16-40-15, page p017): the
// attachment row's required Type offers ["--Select--","01 Plans","02 Specifications or Engineering",
// "03 Other Documents"]. The learner's document-type test missed the "01 " numbering, never chose a Type,
// the Save was refused ("Your documents are not yet saved") and a person picked it by hand.
//
// MUST-PASS    the Corvallis numbered list (and "1." / "1)" / "A." / "A-" codings) is a document-type list;
//              Oregon ePermitting's real list still is; the old head words still are.
// MUST-EXCLUDE states, Yes/No, record types, a numbered record-subtype list, contact types, "also attach
//              to" with only a placeholder, Work Type / Category lists ending in "Other", a department
//              list naming Engineering, a status list, an "Application Type" list.
// MUST-PASS    plan set → "01 Plans"; module/inverter/battery spec, structural letter, calcs → "02
//              Specifications or Engineering"; applications, the checklist, the authorisation → "03 Other
//              Documents". The exact option text comes back, never the stripped one.
// PINNED       Oregon ePermitting maps exactly as before (plan set by trade, applications "Other", spec
//              "Specifications", PE letter "Structural Calculations", site plan "Plans - Site Plan"),
//              never Homeowner Acknowledgement / Contractor Responsibility, unknown documents never guessed.
//
// Run: npx tsx portal-bot/src/adapters/attachmentTypes.test.ts
import assert from "node:assert/strict";
import { attachmentTypeFor, isDocumentTypeList, isPlanSetDocType, stripOptionCode } from "./attachmentTypes";

let failures = 0;
let passes = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); passes++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${e instanceof Error ? e.message : String(e)}`); }
};

// Verbatim from the live page (page-p017-before, ddlDocType).
const CORVALLIS = ["--Select--", "01 Plans", "02 Specifications or Engineering", "03 Other Documents"];
// Oregon ePermitting's list, verbatim (data/portal-replicas/city-of-coos-bay.json; repeatableAttach's TYPES_REAL).
const OREGON = ["--Select--", "Contractor Responsibility Form", "Deferred Submittal Agreement", "Flood Plain Elevation Certificate", "Framing Moisture Content Statement",
  "Homeowner Acknowledgement", "Lighting Efficiency Statement", "Other", "Plans - Architectural", "Plans - Civil", "Plans - Construction", "Plans - Electrical",
  "Plans - Fire Alarm", "Plans - Fire Sprinkler", "Plans - Mechanical", "Plans - Plumbing", "Plans - Site Plan", "Plans - Structural", "Plans - Truss", "Revisions",
  "Septic Review", "Special Inspection Deficiencies Report", "Special Inspection Final Summary Report", "Special Inspection Form", "Specifications", "Structural Calculations"];

console.log("\nS. the leading ordinal/code is numbering, not meaning");
check("\"01 Plans\", \"1. Plans\", \"1) Plans\", \"(1) Plans\", \"1.2 Plans\", \"1.Plans\", \"A. Plans\", \"A- Plans\", \"A) Plans\", \"(A) Plans\" all read \"Plans\"", () => {
  for (const s of ["01 Plans", "1. Plans", "1) Plans", "(1) Plans", "1.2 Plans", "1.Plans", "A. Plans", "A- Plans", "A) Plans", "(A) Plans", "01 - Plans"]) assert.equal(stripOptionCode(s), "Plans", s);
});
check("MUST-EXCLUDE a word is never cut: \"Plans - Structural\", \"Yes\", \"Other\", \"Specifications\", a bare number, \"--Select--\"", () => {
  for (const s of ["Plans - Structural", "Yes", "Other", "Specifications", "100", "--Select--", "Structural Calculations"]) assert.equal(stripOptionCode(s), s, s);
});
check("MUST-EXCLUDE a letter joined to its word is a name, not a code: \"B-01S Application\", \"X-Ray Report\", \"E-Signature Form\", \"A-Frame Plans\", \"A-Plans\"", () => {
  for (const s of ["B-01S Application", "X-Ray Report", "E-Signature Form", "A-Frame Plans", "A-Plans", "01S Application"]) assert.equal(stripOptionCode(s), s, s);
});

console.log("\nP. MUST-PASS: document-type lists");
check("the Corvallis numbered list (the live miss)", () => assert.equal(isDocumentTypeList(CORVALLIS), true));
check("Oregon ePermitting's real list (unchanged)", () => assert.equal(isDocumentTypeList(OREGON), true));
check("other numberings of the same list: \"1.\", \"1)\", \"A.\", \"A-\"", () => {
  assert.equal(isDocumentTypeList(["--Select--", "1. Plans", "2. Specifications or Engineering", "3. Other Documents"]), true);
  assert.equal(isDocumentTypeList(["--Select--", "1) Drawings", "2) Calculations", "3) Other"]), true);
  assert.equal(isDocumentTypeList(["--Select--", "A. Site Plan", "B. Structural Calculations", "C. Photos"]), true);
  assert.equal(isDocumentTypeList(["--Select--", "A- Supporting Documents", "B- Application"]), true);
});
check("the old head words still count (a superset of the three copies it replaces)", () => {
  assert.equal(isDocumentTypeList(["--Select--", "Plans", "Calculations", "Photos", "Forms"]), true);
  assert.equal(isDocumentTypeList(["--Select--", "Plans - Structural", "Plans - Electrical"]), true);
  assert.equal(isDocumentTypeList(["Photos", "Other"]), true);
});
check("document vocabulary: drawings, specifications, engineering calcs, other/supporting documents, site plan, structural plans", () => {
  assert.equal(isDocumentTypeList(["--Select--", "Drawings", "Other"]), true);
  assert.equal(isDocumentTypeList(["--Select--", "Specifications or Engineering", "Other"]), true);
  assert.equal(isDocumentTypeList(["--Select--", "Engineering Calculations", "Other"]), true);
  assert.equal(isDocumentTypeList(["--Select--", "Supporting Documents", "Correspondence"]), true);
  assert.equal(isDocumentTypeList(["--Select--", "Site Plan", "Other"]), true);
  assert.equal(isDocumentTypeList(["--Select--", "Structural Plans", "Other"]), true);
  assert.equal(isDocumentTypeList(["--Select--", "Application", "Checklist", "Other"]), true);
});

console.log("\nX. MUST-EXCLUDE: lists that are not document types");
const NOT_DOC: Array<[string, string[]]> = [
  ["US states", ["--Select--", "Alabama", "Alaska", "Arizona", "Oregon", "Washington"]],
  ["state codes", ["--Select--", "AL", "AK", "OR", "WA"]],
  ["Yes / No", ["--Select--", "Yes", "No"]],
  ["Accela record types", ["--Select--", "Building - Residential (1 & 2 Family)", "Electrical - Residential", "Mechanical - Residential", "Plumbing - Residential"]],
  ["a numbered record-subtype list", ["--Select--", "01 New Construction", "02 Addition", "03 Alteration"]],
  ["contact types", ["--Select--", "Applicant", "Contractor", "Engineer", "Owner", "Architect"]],
  ["\"also attach to\" with only a placeholder (the live row's second select)", ["--Select--"]],
  ["Work Type ending in Other (smoke case I)", ["--Select--", "New", "Alteration", "Other"]],
  ["Category of Construction with Other (skeptic 13985c6 S5)", ["--Select--", "Residential", "Commercial", "Other"]],
  ["a department list naming Engineering", ["--Select--", "Building", "Engineering", "Planning", "Fire", "Other"]],
  ["a status list", ["--Select--", "Application Received", "Application Complete", "Issued"]],
  ["an Application Type list", ["--Select--", "New Application", "Renewal", "Other"]],
  ["a review type list", ["--Select--", "Plan Review", "Over the Counter"]],
  ["stories", ["1", "2", "3"]],
];
for (const [name, list] of NOT_DOC) check(`not a document list: ${name}`, () => assert.equal(isDocumentTypeList(list), false, JSON.stringify(list)));

console.log("\nC. MUST-PASS: the Corvallis numbered list, by document (exact option text back)");
check("the plan set → \"01 Plans\" (structural and electrical alike: the list does not split plans by trade)", () => {
  assert.equal(attachmentTypeFor("plan_set", CORVALLIS), "01 Plans");
  assert.equal(attachmentTypeFor("plan_set", CORVALLIS, { discipline: "structural" }), "01 Plans");
  assert.equal(attachmentTypeFor("plan_set", CORVALLIS, { discipline: "electrical" }), "01 Plans");
  assert.equal(attachmentTypeFor("combined_plan_set", CORVALLIS), "01 Plans");
});
check("module / inverter / battery / racking spec, the structural letter, calcs → \"02 Specifications or Engineering\"", () => {
  for (const d of ["module_spec", "inverter_spec", "battery_spec", "racking_spec", "spec_sheet", "structural_letter", "engineering_letter", "pe_letter", "calcs", "structural_calcs"]) {
    assert.equal(attachmentTypeFor(d, CORVALLIS), "02 Specifications or Engineering", d);
  }
});
check("applications, the checklist, the authorisation → \"03 Other Documents\" (the list has no Application option)", () => {
  for (const d of ["building_application", "electrical_application", "permit_application", "solar_checklist", "owner_authorization"]) {
    assert.equal(attachmentTypeFor(d, CORVALLIS), "03 Other Documents", d);
  }
});
check("a site plan → \"01 Plans\" (no Site Plan option)", () => assert.equal(attachmentTypeFor("site_plan", CORVALLIS), "01 Plans"));
check("MUST-EXCLUDE an unknown document is never guessed, even with \"Other Documents\" on offer", () => {
  assert.equal(attachmentTypeFor("utility_bill", CORVALLIS), null);
  assert.equal(attachmentTypeFor("meter_photo", CORVALLIS), null);
});

console.log("\nO. PINNED: Oregon ePermitting maps exactly as before");
check("the plan set → \"Plans - Structural\" (building) / \"Plans - Electrical\" (electrical) — the learner's own picks", () => {
  assert.equal(attachmentTypeFor("plan_set", OREGON, { discipline: "structural" }), "Plans - Structural");
  assert.equal(attachmentTypeFor("plan_set", OREGON, { discipline: "electrical" }), "Plans - Electrical");
  assert.equal(attachmentTypeFor("plan_set", OREGON), "Plans - Structural");
});
check("applications and the 5952 take 'Other' (the list has no Application / Checklist)", () => {
  assert.equal(attachmentTypeFor("building_application", OREGON), "Other");
  assert.equal(attachmentTypeFor("electrical_application", OREGON), "Other");
  assert.equal(attachmentTypeFor("solar_checklist", OREGON), "Other");
});
check("a spec is 'Specifications', a PE letter 'Structural Calculations', a site plan 'Plans - Site Plan'", () => {
  assert.equal(attachmentTypeFor("module_spec", OREGON), "Specifications");
  assert.equal(attachmentTypeFor("structural_letter", OREGON), "Structural Calculations");
  assert.equal(attachmentTypeFor("site_plan", OREGON), "Plans - Site Plan");
});
check("MUST-EXCLUDE never Homeowner Acknowledgement / Contractor Responsibility, even as the only non-placeholder option (numbered too)", () => {
  assert.equal(attachmentTypeFor("building_application", ["--Select--", "Homeowner Acknowledgement", "Contractor Responsibility Form"]), null);
  assert.equal(attachmentTypeFor("building_application", ["--Select--", "01 Homeowner Acknowledgement", "02 Contractor Responsibility Form"]), null);
  assert.equal(attachmentTypeFor("plan_set", ["--Select--", "01 Homeowner Acknowledgement", "02 Contractor Responsibility Form"]), null);
});
check("MUST-EXCLUDE an unknown document type is not guessed", () => {
  assert.equal(attachmentTypeFor("utility_bill", OREGON), null);
  assert.equal(attachmentTypeFor("meter_photo", OREGON), null);
});
check("MUST-EXCLUDE no Type fits a list with no 'Other' (smoke case C)", () => {
  assert.equal(attachmentTypeFor("building_application", OREGON.filter((t) => t !== "Other")), null);
});

console.log("\nG. generic lists");
check("an unqualified \"Plans\" beats the first \"Plans - <sub>\" when the trade is not on the list", () => {
  assert.equal(attachmentTypeFor("plan_set", ["--Select--", "Plans - Architectural", "Plans", "Other"], { discipline: "electrical" }), "Plans");
});
check("\"Electrical Plans\" for an electrical plan set, a forms option for an application when there is no Application", () => {
  assert.equal(attachmentTypeFor("plan_set", ["--Select--", "Structural Plans", "Electrical Plans", "Other"], { discipline: "electrical" }), "Electrical Plans");
  assert.equal(attachmentTypeFor("building_application", ["--Select--", "Plans", "Forms", "Other"]), "Forms");
});
check("the plan-set family", () => {
  for (const d of ["plan_set", "combined_plan_set", "full_plan_set", "plan_pdf", "stamped_plans"]) assert.equal(isPlanSetDocType(d), true, d);
  for (const d of ["site_plan", "module_spec", "building_application", ""]) assert.equal(isPlanSetDocType(d), false, d);
});

console.log(`\nattachmentTypes: ${passes} passed, ${failures} failed (of ${passes + failures} checks)`);
if (failures) { console.error(`attachmentTypes: ${failures} check(s) FAILED`); process.exit(1); }
console.log("attachmentTypes: all checks passed");
