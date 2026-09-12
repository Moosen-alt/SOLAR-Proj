// A FORM IS A DATED ARTIFACT, AND THE STORE USED TO TREAT IT AS TIMELESS.
//
// ahj_form_templates could not answer three questions an operator asks before filing a
// stored blank: where did this come from, is it current, and does the fee table printed on
// it still apply. The worked example is Coos County. Its own solar page
// (co.coos.or.us/solar-installations) links an electrical permit application that carries
// the renewable-energy fee table on page 1 — "5 kva or less $79.00 | 5.01 kva to 15 kva
// $94.00 | 15.01 kva to 25 kva $156.00" — under the line "Revised 12/23/2022". The county's
// ADOPTED schedule for those same brackets is $135/$160/$265. The form is not wrong; it is
// OLD, by about 1.70x, and nothing in the store could have said so.
//
// So: source_url, document_date, retrieved_at, fee_table_found (migration v21), threaded
// through storeAhjFormTemplate and back out to whatever lists a template.
//
// THE FAILURE MODE THIS TEST HUNTS IS A DATE PARSER THAT GUESSES. A wrong document date is
// strictly worse than none: "" reads as "unknown, go look", while a year scraped off a
// filename or a copyright footer makes a stale form look current — the exact lie the column
// exists to prevent. Every "" case below is a KILL-TEST, and there are more of them than
// there are positives on purpose. Two of them (a bare date with no label, a label with no
// full date) pin the parser's two gates INDEPENDENTLY: without them a parser that guesses
// still passes the obvious cases.
//
// Browser-free, no network, scratch DB. Run: npx tsx backend/test/ahjFormProvenance.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ahj-form-provenance-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";

const { openDatabase } = await import("../src/db");
const {
  storeAhjFormTemplate, markTemplateFeeTableFound, templateProvenance,
  extractDocumentDate, isoForDocumentDate, documentDateAgeDays, isDocumentDateStale,
  DOCUMENT_DATE_STALE_DAYS,
} = await import("../src/ahjFormAuto");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// A fixed "now" so the two-digit-year pivot and the staleness threshold are not a function
// of the day this suite happens to run.
const NOW = new Date("2026-09-12T00:00:00.000Z");

// ---------------------------------------------------------------------------
// 1 · The migration.
// ---------------------------------------------------------------------------
const columns = (table: string): string[] =>
  db.query<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);

check("migration v21 applied — ahj_form_templates can answer where/when/what-it-says", () => {
  const cols = columns("ahj_form_templates");
  for (const c of ["source_url", "document_date", "retrieved_at", "fee_table_found"]) {
    assert.ok(cols.includes(c), `ahj_form_templates is missing ${c}`);
  }
});

check("...and v21 is recorded, so a second open does not replay it", () => {
  const row = db.get<{ name: string }>("SELECT name FROM schema_meta WHERE version = 21");
  assert.equal(row?.name, "ahj_form_template_provenance");
});

// ---------------------------------------------------------------------------
// 2 · extractDocumentDate — the four real formats. Each of these is a line that
//     actually appears on a jurisdiction's permit PDF.
// ---------------------------------------------------------------------------
const positives: Array<[text: string, phrase: string, iso: string]> = [
  // Coos County's electrical permit application, page 1 footer. THE case.
  ["Electrical Permit Application\nCoos County, Oregon\nRevised 12/23/2022", "Revised 12/23/2022", "2022-12-23"],
  ["City of Hood River building permit application   Rev. 06/11/2019", "Rev. 06/11/2019", "2019-06-11"],
  ["Fee schedule attachment — Effective 7-1-25", "Effective 7-1-25", "2025-07-01"],
  ["Solar PV checklist (eff. 01/01/26)", "eff. 01/01/26", "2026-01-01"],
];

for (const [text, phrase, iso] of positives) {
  check(`reads the document's own words: "${phrase}"`, () => {
    assert.equal(extractDocumentDate(text, NOW), phrase);
    assert.equal(isoForDocumentDate(extractDocumentDate(text, NOW), NOW), iso, "the stored phrase must still parse back to a comparable date");
  });
}

check("THE HOOD RIVER LESSON, applied to dates: a split text run still reads as one date", () => {
  // A PDF text layer splits runs wherever it likes — the same layer that renders $171.99 as
  // "$ | 1 | 71 | . | 99" will hand back "Revised 12 / 23 / 2022". Row grouping puts the
  // pieces back on one line; the parser has to tolerate the gaps that survive, and the
  // STORED phrase has to read the way the page reads.
  assert.equal(extractDocumentDate("Revised 12 / 23 / 2022", NOW), "Revised 12/23/2022");
  assert.equal(isoForDocumentDate("Revised 12 / 23 / 2022", NOW), "2022-12-23");
});

check("...and the qualifier is KEPT, because it is half the meaning", () => {
  // "Effective 01/01/2027" on a schedule adopted today means the form is the current one.
  // "Revised 01/01/2027" would mean something else entirely. A bare ISO date loses that.
  assert.match(extractDocumentDate("Fee schedule Effective 01/01/2027", NOW), /^Effective /);
  assert.match(extractDocumentDate("Application Revised 12/23/2022", NOW), /^Revised /);
});

check("common wrappings the same line arrives in", () => {
  assert.equal(extractDocumentDate("Revised: 12/23/2022", NOW), "Revised: 12/23/2022");
  assert.equal(isoForDocumentDate("(Rev 06/11/2019)", NOW), "2019-06-11");
  assert.equal(isoForDocumentDate("LAST UPDATED 3/4/2021", NOW), "2021-03-04");
  assert.equal(isoForDocumentDate("Adopted December 23, 2022", NOW), "2022-12-23");
  assert.equal(isoForDocumentDate("Revised 12-23-2022", NOW), "2022-12-23");
});

check("the LATEST stamp wins — a form often carries an old footer beside a new one", () => {
  // Two revision lines on one document is the normal case (a footer the AHJ forgot to
  // update, plus the stamp on the current page). The newer one is what this copy IS; the
  // older one would make a current form look stale and send an operator hunting.
  const both = "Rev. 06/11/2019\n...\nform content\n...\nRevised 12/23/2022";
  assert.equal(extractDocumentDate(both, NOW), "Revised 12/23/2022");
});

// ---------------------------------------------------------------------------
// 3 · THE KILL-TESTS. A parser that guesses fails here and only here.
// ---------------------------------------------------------------------------
const mustBeBlank: Array<[label: string, text: string]> = [
  // The brief's two, verbatim in shape:
  ["a bare copyright line is not a revision date", "© 2019 City of Springfield. All rights reserved."],
  ["...nor is 'Copyright 2020' spelled out", "Copyright 2020 Coos County, Oregon"],
  ["a filename that merely contains a year says nothing about the document",
    "coos-county-electrical-permit-application-2019.pdf"],
  // The two that pin each gate on its own. Without these, a parser with only ONE of the two
  // gates — or with neither — still passes everything above.
  ["GATE 1 (label required): a full date with nothing labelling it is somebody else's date",
    "Inspection scheduled 12/23/2022. Bring this page to the counter."],
  ["GATE 2 (full date required): a label with only a year is not a date we can age",
    "Revised 2019"],
  // Everything else that looks like a date on a permit form and is not this document's.
  ["an example date printed in an instructions box", "Enter the date of application, e.g. 12/23/2022, in box 4."],
  ["a project/permit expiry is about the permit, not the form", "This permit expires 12/31/2027 unless work has begun."],
  ["a version number is not a date", "Form version 3.1.2"],
  ["an impossible calendar date is a misread, not a finding", "Revised 02/31/2022"],
  ["a date outside any plausible revision window is a misread too", "Revised 12/23/1904"],
  ["empty and junk input", ""],
];

for (const [label, text] of mustBeBlank) {
  check(`REFUSES TO GUESS — ${label}`, () => {
    assert.equal(extractDocumentDate(text, NOW), "", `extractDocumentDate(${JSON.stringify(text)}) invented a date`);
  });
}

check("...and the refusal is not the parser simply being broken", () => {
  // The cheapest way to pass every kill-test above is to always return "". This is the
  // counter-check that makes the kill-tests mean something: the same input, plus a real
  // labelled date, must still be found.
  assert.equal(extractDocumentDate("© 2019 City of Springfield. Revised 12/23/2022", NOW), "Revised 12/23/2022");
  assert.equal(extractDocumentDate("Inspection scheduled 12/23/2022. Rev. 06/11/2019", NOW), "Rev. 06/11/2019");
});

check("the two-digit year pivots forward, not backward, for a plausible revision", () => {
  // "eff. 01/01/26" on a 2026 form is 2026, not 1926. The pivot is the only place a
  // two-digit year can go wrong silently.
  assert.equal(isoForDocumentDate("eff. 01/01/26", NOW), "2026-01-01");
  assert.equal(isoForDocumentDate("Revised 12/23/99", NOW), "1999-12-23");
});

// ---------------------------------------------------------------------------
// 4 · Staleness. The operator-facing verdict, computed in ONE place.
// ---------------------------------------------------------------------------
check("a Coos-County-aged form is flagged worth re-checking", () => {
  const age = documentDateAgeDays("Revised 12/23/2022", NOW);
  assert.ok(age != null && age > DOCUMENT_DATE_STALE_DAYS, `expected > ${DOCUMENT_DATE_STALE_DAYS} days, got ${age}`);
  assert.equal(isDocumentDateStale("Revised 12/23/2022", NOW), true);
});

check("...a recent revision is not", () => {
  assert.equal(isDocumentDateStale("Revised 01/01/2026", NOW), false);
});

check("...a FUTURE effective date is pending, never stale", () => {
  // A fee schedule adopted now to take effect next January is the most current document
  // there is. A naive abs() age would flag it and send the operator to re-download the
  // form they already have.
  assert.equal(isDocumentDateStale("Effective 01/01/2027", NOW), false);
  assert.ok((documentDateAgeDays("Effective 01/01/2027", NOW) ?? 0) < 0);
});

check("...and a document that never dated itself is UNKNOWN, not stale", () => {
  // Different message, different action: "we don't know" sends you to look, "it's old"
  // sends you to re-download. Collapsing them would cry wolf on every uploaded blank.
  assert.equal(documentDateAgeDays("", NOW), null);
  assert.equal(isDocumentDateStale("", NOW), false);
});

// ---------------------------------------------------------------------------
// 5 · The round trip. Provenance in, provenance out.
// ---------------------------------------------------------------------------
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3]);
const COOS_URL = "https://co.coos.or.us/sites/default/files/electrical-permit-application.pdf";

// NOTE: storeAhjFormTemplate re-classifies form_type from the FILENAME (classifyFormType),
// so the filename and the asserted type have to agree or the round trip fails for a reason
// that has nothing to do with provenance.
const id = storeAhjFormTemplate(db, {
  ahjName: "Coos County", state: "OR", formType: "electrical_application",
  filename: "Electrical Permit Application.pdf",
  bytes: PDF_BYTES,
  map: { formName: "Coos County Electrical Permit Application", sourceUrl: COOS_URL, fillMode: "acroform", textFields: {}, checkboxes: {}, notes: "" },
  documentDate: "Revised 12/23/2022",
  retrievedAt: "2026-09-10T12:00:00.000Z",
  feeTableFound: true,
});

const rowOf = (templateId: string) =>
  db.get<Record<string, unknown>>("SELECT * FROM ahj_form_templates WHERE id = ?", [templateId])!;

check("THE GAP: a stored template answers where it came from and what it says about itself", () => {
  const row = rowOf(id);
  assert.equal(row.source_url, COOS_URL);
  assert.equal(row.document_date, "Revised 12/23/2022");
  assert.equal(row.retrieved_at, "2026-09-10T12:00:00.000Z");
  assert.equal(row.fee_table_found, 1);
  assert.equal(row.form_type, "electrical_application");
});

check("...and the operator-facing view says it is worth re-checking", () => {
  const p = templateProvenance(rowOf(id), NOW);
  assert.equal(p.sourceUrl, COOS_URL);
  assert.equal(p.documentDate, "Revised 12/23/2022");
  assert.equal(p.documentDateIso, "2022-12-23");
  assert.equal(p.feeTableFound, true, "the fee-table flag is what makes this the Coos County shape");
  assert.equal(p.stale, true);
});

check("a template stored with nothing known defaults safely rather than to NULL", () => {
  const bare = storeAhjFormTemplate(db, {
    ahjName: "Nowhere City", state: "OR", formType: "permit_application",
    filename: "blank.pdf", bytes: PDF_BYTES,
    map: { formName: "Nowhere blank", sourceUrl: "", fillMode: "overlay", textFields: {}, checkboxes: {}, notes: "" },
  });
  const row = rowOf(bare);
  assert.equal(row.source_url, "", "'' so callers never have to null-check");
  assert.equal(row.document_date, "");
  assert.equal(row.fee_table_found, 0);
  assert.ok(String(row.retrieved_at).length > 0, "fresh bytes with no stated retrieval time are retrieved NOW");
  const p = templateProvenance(row, NOW);
  assert.equal(p.stale, false, "unknown is not stale");
  assert.equal(p.documentAgeDays, null);
});

check("an explicit blank retrieved_at survives — a re-map must not claim a fresh download", () => {
  // The re-map route re-reads bytes already on disk. Stamping "retrieved now" there would
  // make a purely local operation look like a trip to the AHJ's site.
  const local = storeAhjFormTemplate(db, {
    ahjName: "Unknown Provenance City", state: "OR", formType: "permit_application",
    filename: "uploaded.pdf", bytes: PDF_BYTES,
    map: { formName: "Uploaded blank", sourceUrl: "", fillMode: "overlay", textFields: {}, checkboxes: {}, notes: "" },
    retrievedAt: "",
  });
  assert.equal(rowOf(local).retrieved_at, "");
});

check("PROVENANCE FOLLOWS THE BYTES: replacing the blob replaces all four answers", () => {
  // The dedupe key is (ahj_name, state, form_type), so this rewrites the Coos County row.
  // Carrying the OLD document_date onto the NEW bytes would attach a 2022 revision line to
  // a 2026 document — precisely the lie this work exists to stop. The AHJ dropped the fee
  // table from the new revision, so that flag has to clear too.
  const again = storeAhjFormTemplate(db, {
    ahjName: "Coos County", state: "OR", formType: "electrical_application",
    filename: "Electrical Permit Application.pdf",
    bytes: new Uint8Array([...PDF_BYTES, 0x0a]),
    map: { formName: "Coos County Electrical Permit Application", sourceUrl: `${COOS_URL}?v=2`, fillMode: "acroform", textFields: {}, checkboxes: {}, notes: "" },
    documentDate: "Revised 01/15/2026",
  });
  assert.equal(again, id, "same (ahj, state, form_type) must update the row, not add one");
  const row = rowOf(id);
  assert.equal(row.source_url, `${COOS_URL}?v=2`);
  assert.equal(row.document_date, "Revised 01/15/2026");
  assert.equal(row.fee_table_found, 0, "an unasserted fee table must not linger from the previous revision");
  assert.equal(templateProvenance(row, NOW).stale, false, "the new revision is current");
});

check("the fee-harvest side can flag a form that carried a fee table", () => {
  markTemplateFeeTableFound(db, id);
  assert.equal(rowOf(id).fee_table_found, 1);
  assert.equal(templateProvenance(rowOf(id), NOW).feeTableFound, true);
  markTemplateFeeTableFound(db, id, false);
  assert.equal(rowOf(id).fee_table_found, 0, "and can withdraw the flag");
});

// ---------------------------------------------------------------------------
// 6 · The backfill. Every row written before v21 already carried its source URL
//     inside the field_map JSON, where nothing could select or show it.
// ---------------------------------------------------------------------------
// Write the LEGACY shape by hand: provenance columns blank, source URL only in the
// field_map JSON — which is exactly how every row written before v21 looks.
const legacyId = storeAhjFormTemplate(db, {
  ahjName: "Legacy County", state: "OR", formType: "permit_application",
  filename: "legacy.pdf", bytes: PDF_BYTES,
  map: { formName: "Legacy blank", sourceUrl: "https://legacy.example.invalid/app.pdf", fillMode: "overlay", textFields: {}, checkboxes: {}, notes: "" },
});
db.run(
  "UPDATE ahj_form_templates SET source_url = '', retrieved_at = '', document_date = '', created_at = ? WHERE id = ?",
  ["2024-01-02T03:04:05.000Z", legacyId],
);

check("precondition: the legacy shape really is blank, and the URL really is in the map", () => {
  const row = rowOf(legacyId);
  assert.equal(row.source_url, "");
  assert.equal(row.retrieved_at, "");
  assert.match(String(row.field_map), /legacy\.example\.invalid/);
});

// Replay v21 the way the repo's other migration tests do: drop its schema_meta row and
// re-open, which re-runs the runner from MAX(version).
db.run("DELETE FROM schema_meta WHERE version >= 21");
const db2 = await openDatabase();

check("REPLAY: v21 backfills source_url out of the field_map every old row already carried", () => {
  const row = db2.get<Record<string, unknown>>("SELECT * FROM ahj_form_templates WHERE id = ?", [legacyId])!;
  assert.equal(row.source_url, "https://legacy.example.invalid/app.pdf", "the URL was in field_map all along — it just could not be selected or shown");
  assert.equal(row.retrieved_at, "2024-01-02T03:04:05.000Z", "retrieved_at backfills from created_at: the row was written when the bytes arrived");
  assert.equal(row.document_date, "", "a document date CANNOT be backfilled without re-reading the bytes, and is NOT guessed from anything else");
});

check("...and the replay leaves a row that already had its answers exactly alone", () => {
  const row = db2.get<Record<string, unknown>>("SELECT * FROM ahj_form_templates WHERE id = ?", [id])!;
  assert.equal(row.source_url, `${COOS_URL}?v=2`);
  assert.equal(row.document_date, "Revised 01/15/2026");
});

check("...and v21 is recorded again, so it is a migration and not a startup chore", () => {
  assert.equal(db2.get<{ name: string }>("SELECT name FROM schema_meta WHERE version = 21")?.name, "ahj_form_template_provenance");
});

if (failures) { console.error(`\n${failures} AHJ-form-provenance check(s) FAILED.`); process.exit(1); }
console.log("\nAll AHJ-form-provenance checks passed.");
process.exit(0);
