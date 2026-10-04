// WHICH VERSION OF THE ADDRESS DO WE TRY FIRST?
//
// Accela lists one street address once per issuing jurisdiction and the permit types on offer
// differ per row. A first cut hard-mapped CITY->structural and COUNTY->electrical; the operator
// corrected that (either can hold both). The replacement tried every version until one offered
// the permit — and promptly selected "DEQ Applications", which issues onsite/septic permits and
// nothing else, then wedged. These are the real 540 Mockup rows.
//   npx tsx portal-bot/src/adapters/addressVersion.test.ts
import assert from "node:assert/strict";
import { rankAddressVersions } from "./oregonEPermitting";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Verbatim from the live search for 540 Mockup Ave, Coos Bay.
const KENTUCKY = [
  "Select 540 MOCKUP AV, DEQ Applications, COOS BAY Coos OR 97420 DEQ Applications COOS BAY OR 97420 25S13W20CC0000 SAMPLE, ALEX, JR. & FIXTURE, CASEY",
  "Select 540 MOCKUP AVE, City Applications, EMPIRE, COOS BAY COOS OR 97420 City Applications COOS BAY OR 97420 25S13W20CCTL0250300 SAKSCHEWSKI, GERHARD & JEANNETT",
  "Select 540 MOCKUP AVE, COUNTY APPLICATIONS, COOS BAY COOS OR 97420 COUNTY APPLICATIONS COOS BAY OR 97420 25S1320CC02503 HUISMAN, VINCENT",
];
const IVY = { city: "Coos Bay", zip: "97420", homeownerName: "Drew Example" };

const first = (rows: string[], isElectrical: boolean): string =>
  rankAddressVersions(rows, { ...IVY, isElectrical }).ranked[0]?.text ?? "";

check("electrical tries the COUNTY version first (it holds the electrical permit)", () => {
  assert.match(first(KENTUCKY, true), /COUNTY APPLICATIONS/);
});

check("structural tries the CITY version first (it holds the structural permit)", () => {
  assert.match(first(KENTUCKY, false), /City Applications/);
});

check("THE REGRESSION: DEQ is never tried first — it issues nothing we file", () => {
  assert.doesNotMatch(first(KENTUCKY, true), /DEQ/);
  assert.doesNotMatch(first(KENTUCKY, false), /DEQ/);
  // and it sorts last in both directions
  for (const elec of [true, false]) {
    const r = rankAddressVersions(KENTUCKY, { ...IVY, isElectrical: elec }).ranked;
    assert.match(r[r.length - 1].text, /DEQ/, `DEQ should be last (isElectrical=${elec})`);
  }
});

check("every version of THIS property stays a candidate — order is a hint, not a filter", () => {
  assert.equal(rankAddressVersions(KENTUCKY, { ...IVY, isElectrical: true }).ranked.length, 3);
});

// The operator's correction: sometimes one record carries BOTH disciplines.
check("a single record holding both disciplines is tried first for either", () => {
  const both = ["Select 5050 PLACEHOLDER BLVD SE, City Applications, COOS BAY OR 97420 City Applications COOS BAY OR 97420 111 PLACEHOLDER, CRAIG"];
  assert.match(first(both, true), /OCEAN BLVD/);
  assert.match(first(both, false), /OCEAN BLVD/);
});

check("the owner of record outranks the jurisdiction convention", () => {
  const rows = [
    "Select 540 MOCKUP AVE, COUNTY APPLICATIONS, COOS BAY OR 97420 COUNTY APPLICATIONS COOS BAY OR 97420 25S1320CC02503 HUISMAN, VINCENT",
    "Select 540 MOCKUP AVE, City Applications, COOS BAY OR 97420 City Applications COOS BAY OR 97420 25S13W20CCTL0250300 EXAMPLE, DREW A",
  ];
  // Electrical would normally prefer COUNTY, but the customer's own parcel wins.
  assert.match(first(rows, true), /EXAMPLE, DREW/);
});

check("a different town's row is REJECTED, never merely ranked low", () => {
  const loose = [
    "Select 119 7TH E, County Applications, MILTON FREEWATER UMATILLA OR 97862 County Applications MILTON FREEWATER OR 97862",
    "Select 119 NE 78TH AVE, PORTLAND OR 97213 PORTLAND OR 97213 1N2E32DA10900",
    "Select 540 MOCKUP AVE, COUNTY APPLICATIONS, COOS BAY OR 97420 COUNTY APPLICATIONS COOS BAY OR 97420 25S1320CC02503 HUISMAN, VINCENT",
  ];
  const out = rankAddressVersions(loose, { ...IVY, isElectrical: true });
  assert.equal(out.ranked.length, 1, "only the Coos Bay row is a candidate");
  assert.equal(out.rejected.length, 2);
});

check("no candidate at all yields an empty ranking, so the caller can refuse to file", () => {
  const out = rankAddressVersions(
    ["Select 119 NE 78TH AVE, PORTLAND OR 97213 PORTLAND OR 97213"],
    { ...IVY, isElectrical: true },
  );
  assert.equal(out.ranked.length, 0);
});

// ── THE ISSUING AGENCY DECIDES THE ROW (production 2026-09-27, City of Jefferson) ─────────────
//
// The CITY-for-structural / COUNTY-for-electrical order above is Coos Bay's convention: Coos Bay
// issues its own building permits. City of Jefferson's are issued by MARION COUNTY (the per-job
// lookup, both permits), so the convention picks the city's row for a structural filing — the
// wrong agency, and the backend refused to borrow the Coos Bay recipe for exactly that reason.
// The row preference is now the looked-up agency when it is known; the convention only when not.
//
// Synthetic street and owner (the live grid's SHAPE: "<street>, COUNTY APPLICATIONS, <CITY>
// <COUNTY> OR <ZIP>"; the county's name is in the row). JEFFERSON_TWO is the two-agency shape the
// finding describes (a City row and a County row); JEFFERSON_LIVE is what the live grid actually
// offered in run 99baa5d0 (recording frame f004): two versions, BOTH County Applications.
const { issuingAgencyRow, preferredRowLabel } = await import("../addressVersion");
const JEFF = { city: "Jefferson", zip: "97352", homeownerName: "Sample Customer" };
const JEFFERSON_TWO = [
  "Select 100 EXAMPLE RD SE, City Applications, JEFFERSON MARION OR 97352 City Applications JEFFERSON OR 97352 103W01CB09999 PARCEL HOLDER",
  "Select 100 EXAMPLE RD SE, COUNTY APPLICATIONS, JEFFERSON MARION OR 97352 COUNTY APPLICATIONS JEFFERSON OR 97352 103W01CB09999 PARCEL HOLDER",
];
const JEFFERSON_LIVE = [
  "Select 100 EXAMPLE RD SE, 1701000, COUNTY APPLICATIONS, SOUTH, JEFFERSON MARION OR 97352, 100 EXAMPLE RD SE, JEFFERSON, OR 97352 COUNTY APPLICATIONS JEFFERSON OR 97352 103W01CB09999 CUSTOMER, SAMPLE",
  "Select 100 EXAMPLE RD SE, 1701000, COUNTY APPLICATIONS, SOUTH, JEFFERSON MARION OR 97352, 100 EXAMPLE RD SE, JEFFERSON, OR 97352 COUNTY APPLICATIONS JEFFERSON OR 97352 103W01CB09999",
];
const rank = (rows: string[], id: typeof JEFF, isElectrical: boolean, issuingAgency?: string | null) =>
  rankAddressVersions(rows, { ...id, isElectrical, issuingAgency });

check("agency parse: county / city / bare city name / neither / ambiguous", () => {
  assert.deepEqual(issuingAgencyRow("Marion County"), { kind: "county", place: "MARION", ambiguous: false });
  assert.deepEqual(issuingAgencyRow("Marion County Building Inspection Division"), { kind: "county", place: "MARION", ambiguous: false });
  assert.deepEqual(issuingAgencyRow("County of Los Angeles"), { kind: "county", place: "LOS ANGELES", ambiguous: false });
  assert.deepEqual(issuingAgencyRow("City of Coos Bay"), { kind: "city", place: "COOS BAY", ambiguous: false });
  assert.deepEqual(issuingAgencyRow("City of Jefferson Planning"), { kind: "city", place: "JEFFERSON", ambiguous: false });
  assert.deepEqual(issuingAgencyRow("Oregon City"), { kind: "city", place: "OREGON CITY", ambiguous: false });
  // A bare place name is a city ONLY when it is this project's city.
  assert.deepEqual(issuingAgencyRow("Coos Bay", { city: "Coos Bay" }), { kind: "city", place: "COOS BAY", ambiguous: false });
  assert.equal(issuingAgencyRow("Coos Bay").kind, "");
  for (const n of ["Oregon Building Codes Division", "State of Oregon", "", null, undefined]) assert.equal(issuingAgencyRow(n as string).kind, "", String(n));
  const amb = issuingAgencyRow("City of Jefferson / Marion County");
  assert.equal(amb.kind, ""); assert.equal(amb.ambiguous, true);
});

check("MUST-PASS: Jefferson STRUCTURAL, agency Marion County → the COUNTY APPLICATIONS row", () => {
  const r = rank(JEFFERSON_TWO, JEFF, false, "Marion County");
  assert.match(r.ranked[0].text, /COUNTY APPLICATIONS/);
  assert.equal(r.preference.basis, "agency");
  assert.match(r.preference.note, /Marion County/);
});
check("MUST-PASS: Jefferson ELECTRICAL, agency Marion County → the COUNTY row", () => {
  assert.match(rank(JEFFERSON_TWO, JEFF, true, "Marion County").ranked[0].text, /COUNTY APPLICATIONS/);
});
check("MUST-PASS: the live Jefferson grid (both versions County Applications) → a County row, the owner's first", () => {
  const r = rank(JEFFERSON_LIVE, JEFF, false, "Marion County");
  assert.match(r.ranked[0].text, /CUSTOMER, SAMPLE/);
  assert.equal(r.preference.contradicts, false);
});
check("MUST-PASS: Coos Bay STRUCTURAL, agency City of Coos Bay → the CITY row", () => {
  const r = rank(KENTUCKY, IVY, false, "City of Coos Bay");
  assert.match(r.ranked[0].text, /City Applications/);
  assert.equal(r.preference.basis, "agency");
});
check("MUST-PASS: a bare \"Coos Bay\" agency for a Coos Bay project is the city → the CITY row, even for electrical", () => {
  assert.match(rank(KENTUCKY, IVY, true, "Coos Bay").ranked[0].text, /City Applications/);
});
check("MUST-PASS: Coos Bay ELECTRICAL, agency Coos County (or unknown) → the COUNTY row", () => {
  assert.match(rank(KENTUCKY, IVY, true, "Coos County").ranked[0].text, /COUNTY APPLICATIONS/);
  assert.match(rank(KENTUCKY, IVY, true, null).ranked[0].text, /COUNTY APPLICATIONS/);
});
check("MUST-PASS: the fallback row label (no grid to rank) follows the agency's kind, else the convention", () => {
  assert.equal(preferredRowLabel({ issuingAgency: "Marion County", city: "Jefferson", isElectrical: false }), "COUNTY APPLICATIONS");
  assert.equal(preferredRowLabel({ issuingAgency: "City of Coos Bay", city: "Coos Bay", isElectrical: true }), "CITY APPLICATIONS");
  assert.equal(preferredRowLabel({ issuingAgency: "", city: "Jefferson", isElectrical: false }), "CITY APPLICATIONS");
  assert.equal(preferredRowLabel({ issuingAgency: "Oregon Building Codes Division", city: "Jefferson", isElectrical: true }), "COUNTY APPLICATIONS");
});

check("MUST-EXCLUDE: agency unknown → EXACTLY today's convention (same order, same scores, no note)", () => {
  for (const [rows, id] of [[KENTUCKY, IVY], [JEFFERSON_TWO, JEFF], [JEFFERSON_LIVE, JEFF]] as const) {
    for (const elec of [true, false]) {
      const today = rankAddressVersions([...rows], { ...id, isElectrical: elec });
      for (const unknown of [undefined, null, "", "   "]) {
        const r = rank([...rows], id, elec, unknown as string | null | undefined);
        assert.deepEqual(r.ranked, today.ranked, `agency ${JSON.stringify(unknown)} changed the ranking`);
        assert.equal(r.preference.basis, "discipline");
        assert.equal(r.preference.note, "");
        assert.equal(r.preference.contradicts, false);
      }
    }
  }
});
check("MUST-EXCLUDE: an agency that is neither a city nor a county, or names both → the convention, and it is NAMED", () => {
  for (const agency of ["Oregon Building Codes Division", "City of Jefferson / Marion County"]) {
    const r = rank(JEFFERSON_TWO, JEFF, false, agency);
    assert.deepEqual(r.ranked, rankAddressVersions(JEFFERSON_TWO, { ...JEFF, isElectrical: false }).ranked, agency);
    assert.equal(r.preference.basis, "discipline");
    assert.match(r.preference.note, new RegExp(agency.replace(/[/]/g, "\\/")));
  }
});
check("MUST-EXCLUDE: an agency naming a DIFFERENT county/city than any row → no row invented; the convention, NAMED", () => {
  // Linn County at a Jefferson address: the county row names MARION, not LINN.
  const linnElec = rank(JEFFERSON_TWO, JEFF, true, "Linn County");
  assert.deepEqual(linnElec.ranked, rankAddressVersions(JEFFERSON_TWO, { ...JEFF, isElectrical: true }).ranked);
  assert.equal(linnElec.preference.basis, "discipline");
  assert.equal(linnElec.preference.agencyUnmatched, true);
  assert.match(linnElec.preference.note, /Linn County/);
  assert.equal(linnElec.preference.contradicts, false, "the convention's county row is not positively another KIND of agency");
  // City of Salem at a Jefferson address: the city row is Jefferson's.
  const salem = rank(JEFFERSON_TWO, JEFF, false, "City of Salem");
  assert.deepEqual(salem.ranked, rankAddressVersions(JEFFERSON_TWO, { ...JEFF, isElectrical: false }).ranked);
  assert.equal(salem.preference.agencyUnmatched, true);
  assert.match(salem.preference.note, /City of Salem/);
});
check("MUST-EXCLUDE: an unmatched agency whose convention pick is the OTHER kind of jurisdiction is flagged (a filing door stops on it)", () => {
  // Linn County (a county) for a STRUCTURAL filing: the convention's pick is the CITY row.
  const linn = rank(JEFFERSON_TWO, JEFF, false, "Linn County");
  assert.match(linn.ranked[0].text, /City Applications/);
  assert.equal(linn.preference.contradicts, true);
  // Marion County at a grid offering only the city's version (and DEQ).
  const cityOnly = [JEFFERSON_TWO[0], "Select 100 EXAMPLE RD SE, DEQ Applications, JEFFERSON Marion OR 97352 DEQ Applications JEFFERSON OR 97352"];
  const m = rank(cityOnly, JEFF, false, "Marion County");
  assert.equal(m.preference.agencyUnmatched, true);
  assert.equal(m.preference.contradicts, true);
});
check("MUST-EXCLUDE: the owner of record still outranks the agency preference", () => {
  const rows = [
    "Select 540 MOCKUP AVE, COUNTY APPLICATIONS, COOS BAY COOS OR 97420 COUNTY APPLICATIONS COOS BAY OR 97420 25S1320CC02503 HUISMAN, VINCENT",
    "Select 540 MOCKUP AVE, City Applications, COOS BAY OR 97420 City Applications COOS BAY OR 97420 25S13W20CCTL0250300 EXAMPLE, DREW A",
  ];
  const r = rank(rows, IVY, true, "Coos County");
  assert.match(r.ranked[0].text, /EXAMPLE, DREW/);
  assert.equal(r.preference.contradicts, false, "the agency's row exists — the owner's parcel is a choice, not a contradiction");
});
check("MUST-EXCLUDE: DEQ still ranks last and another town's row is still rejected with an agency supplied", () => {
  const r = rank(KENTUCKY, IVY, false, "Coos County");
  assert.match(r.ranked[r.ranked.length - 1].text, /DEQ/);
  const loose = rank(["Select 119 NE 78TH AVE, COUNTY APPLICATIONS, PORTLAND MULTNOMAH OR 97213", ...KENTUCKY], IVY, true, "Multnomah County");
  assert.equal(loose.rejected.length, 1);
  assert.ok(!loose.ranked.some((v) => /PORTLAND/.test(v.text)), "a Portland row was invented as Multnomah County's");
});

if (failures) { console.error(`\n${failures} address-version check(s) FAILED.`); process.exit(1); }
console.log("\nAll address-version checks passed.");
process.exit(0);
