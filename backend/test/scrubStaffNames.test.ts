// THE STAFF-NAME SCRUB REMOVES THE COMPANY'S OWN PEOPLE FROM SHARED KNOWLEDGE NOTES — AND
// NOTHING ELSE (operator ruling 2026-09-26: "Remove them if you see them I suppose").
//
// Both directions, from the real function (scripts/scrub-shared-knowledge-staff-names.ts):
//   mustRemove — the four company-staff clauses the operator's reference sheet carried
//                ("Nick's prepped …" ×3 shapes, "Person to pick up permit: Stephen Bearden");
//   mustKeep   — jurisdiction desk staff in the very same shapes (Megan Winner - [REDACTED_PHONE],
//                "Contact is Vicki Russell", "(Nathan)", "Heaven (", "Ray / Rebecca / Alice",
//                "- Debra") and every "Contact: <email>" line. A filter list fails both ways.
// And the seed itself: backend/data/reference-ahj-processes.json no longer carries the clauses
// (re-import re-seeds the KB, and applicationDocs / reviewerEngine read reviewerNotes at runtime).
//
// KILL: widen the first clause to /\b\w+'s prepped/ → mustKeep still passes (no desk-staff
// "prepped" clause exists) but the JSON check catches nothing — so the kill for this test is
// dropping the Stephen Bearden clause (mustRemove red) and adding a generic
// "<First Last> - [REDACTED_PHONE]" clause (mustKeep red on Megan Winner).
// Run: npx tsx backend/test/scrubStaffNames.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";
import { COMPANY_STAFF_CLAUSES, scrubStaffClauses, scrubStaffNotes } from "../../scripts/scrub-shared-knowledge-staff-names";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The four clauses as the production notes carry them (nm|corrales, nm|los ranchos, az|kingman,
// az|pinal county), each inside its real sentence.
const MUST_REMOVE: Array<[string, RegExp, RegExp]> = [
  ["Submissions via email. Building permit is in Nick's prepped applications. Electrical permit is through Rio Rancho.",
    /Nick/, /Building permit is in the prepared applications folder\. Electrical permit/],
  ["Permits are submitted in person. All required applications are under Nick's prepped folder. Submission requires IA as well as application and planset",
    /Nick/, /All required applications are in the prepared applications folder\. Submission requires/],
  ["Building inspection permit is under Nick's prepped applications folder. Highlighted yellow box on inspection permit DOES NOT need to be filled out.",
    /Nick/, /Building inspection permit is in the prepared applications folder\. Highlighted/],
  ["looks like combo permit Person to pick up permit: Stephen Bearden MANUFACTURED HOME REQUIRES ES, EE, AND SS FOR PERMIT SUBMISSIONS",
    /Stephen|Bearden/, /combo permit Permit is picked up in person by the company's designated person\. MANUFACTURED HOME/],
];

// Jurisdiction desk staff, in the same shapes — a separate operator question, left as written.
const MUST_KEEP: string[] = [
  "submit through Accela. Partners with Cottage Grove for reviews. No apps required. Engineering for all projects. Megan Winner - [REDACTED_PHONE]",
  "Contact is Vicki Russell [REDACTED_PHONE]. Submittal must have SS letter, EE stamp and HOA approval",
  "TILLAMOOK COUNTY - ACCELA ([REDACTED_PHONE] (press 6) - Debra (MAY NEED LAND USE APPROVAL)",
  "Accela Heaven ([REDACTED_PHONE] (permitting) Engineering for rafters",
  "mechanical permit [REDACTED_PHONE] - Hazel (up to date)",
  "([REDACTED_PHONE] (Nathan) RCE 56118 copy of license",
  "[REDACTED_PHONE] (Christine); [REDACTED_PHONE] (Richard) Building permit - choose residential minor",
  "[REDACTED_PHONE] Ray / Rebecca / Alice",
  "Contact: permits@example-city.gov",
  "Contact: building.desk@county.example.us | Fee pay [REDACTED_PHONE]",
  // Someone else's prepped folder is not a clause on the list — the list is name-bound.
  "Applications are in Dana's prepped folder",
];

check("mustRemove: each of the four company-staff clauses goes, and the instruction stays in its place", () => {
  for (const [input, gone, kept] of MUST_REMOVE) {
    const r = scrubStaffClauses(input);
    assert.ok(r.hits >= 1, `no hit on: ${input.slice(0, 60)}`);
    assert.doesNotMatch(r.text, gone, `name survived: ${r.text}`);
    assert.match(r.text, kept, `instruction lost: ${r.text}`);
  }
});

check("mustKeep: jurisdiction desk staff and every Contact: <email> line are left as written", () => {
  for (const input of MUST_KEEP) {
    const r = scrubStaffClauses(input);
    assert.equal(r.hits, 0, `scrubbed a desk-staff / contact line: ${input.slice(0, 60)}`);
    assert.equal(r.text, input.replace(/\s{2,}/g, " ").trim());
  }
});

check("the clause list is name-bound: every pattern names its person, none is a generic name shape", () => {
  assert.ok(COMPANY_STAFF_CLAUSES.length >= 2);
  for (const c of COMPANY_STAFF_CLAUSES) {
    assert.match(c.pattern.source, /Nick|Stephen\\s\+Bearden/, `a clause without a bound name: ${c.pattern.source}`);
    assert.doesNotMatch(c.pattern.source, /\[A-Z\]\[a-z\]\+\s*\\s\+\s*\[A-Z\]\[a-z\]\+/, `a generic First Last shape: ${c.pattern.source}`);
  }
});

check("segment-wise over a ' | ' blob: only the named segment changes, duplicates collapse, others untouched", () => {
  const blob = [
    "Submissions via email. Building permit is in Nick's prepped applications.",
    "Megan Winner - [REDACTED_PHONE]",
    // An earlier hand-scrubbed copy of the same segment: identical once the name is gone.
    "Submissions via email. Building permit is in the prepared applications folder.",
    "Contact: permits@example-city.gov",
  ].join(" | ");
  const r = scrubStaffNotes(blob);
  assert.equal(r.hits, 1);
  assert.equal(r.changed, true);
  assert.equal(r.text, [
    "Submissions via email. Building permit is in the prepared applications folder.",
    "Megan Winner - [REDACTED_PHONE]",
    "Contact: permits@example-city.gov",
  ].join(" | "), r.text);
  const clean = scrubStaffNotes("Megan Winner - [REDACTED_PHONE] | Contact: permits@example-city.gov");
  assert.equal(clean.changed, false);
  assert.equal(clean.hits, 0);
});

check("the seed JSON no longer carries the clauses, and the instructions are in their place", () => {
  const raw = fs.readFileSync(path.join(REPO, "backend", "data", "reference-ahj-processes.json"), "utf8");
  const parsed = JSON.parse(raw) as { profiles?: Array<{ reviewerNotes?: string }> } | Array<{ reviewerNotes?: string }>;
  const profiles = Array.isArray(parsed) ? parsed : (parsed.profiles || []);
  assert.ok(profiles.length > 100, "the reference file parsed to nothing");
  const notes = profiles.map((p) => String(p.reviewerNotes || ""));
  assert.doesNotMatch(raw, /Nick'?s prepped/i, "the seed still names the folder's owner");
  assert.doesNotMatch(raw, /Stephen Bearden/, "the seed still names the pick-up person");
  assert.equal(notes.filter((n) => /in the prepared applications folder/.test(n)).length, 3, "three prepared-folder instructions expected");
  assert.equal(notes.filter((n) => /picked up in person by the company's designated person/.test(n)).length, 1);
  // The desk staff are still there — the seed was not scrubbed wholesale.
  assert.match(raw, /Vicki Russell/);
  assert.match(raw, /Megan Winner/);
});

if (failures) { console.error(`\n${failures} staff-name scrub test(s) failed.`); process.exit(1); }
console.log("\nAll staff-name scrub tests passed.");
