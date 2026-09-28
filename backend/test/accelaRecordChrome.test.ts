// ACCELA'S RECORD-PAGE CHROME IS NOT THE RECORD'S STATUS — AND NOTHING ELSE MOVES.
//
// THE LIVE CASE (2026-09-28). A City of Corvallis building record (Accela, anonymous view) read
// "Record Status: Received" and the monitor raised a correction on it. On a record that is not yet
// issued, Accela prints the "Add to Existing Collection … Create a New Collection" widget where an
// issued record prints "Expiration Date", so the stated status was never pulled out and the WHOLE
// page was scanned. Two pieces of page chrome then spoke for the record:
//   - the record-detail heading pair "More Details" › "Additional Information" (the section that
//     holds Job Value) matched correctionPattern's "additional information" — correction_flagged;
//   - with that heading gone, the anonymous visitor's invitation "To schedule inspections, pay fees
//     or upload documents, please log in to your account." matched readyForIssuePattern's "pay
//     fees" — ready_for_issue, a POSITIVE reading on a trusted poll (project status + client email).
// Both are removed from the scanned text before any pattern runs (permitMonitor's
// withoutAccelaRecordChrome). Nothing in the patterns changes.
//
// THE CONVERGENCE RULE: a missed correction is worse than a false one. The previous round rewrote
// the classifier around the stated status and regressed real corrections (skeptic verdict items
// 1–5, .probe/status-fix-RESULT.json). Every one of those shapes is pinned below to EXACTLY what
// the base classifier (release #10 / 0a4fc06) read — outcome and label — including the ones base
// reads wrongly: this change is not allowed to move them either way.
//   npx tsx backend/test/accelaRecordChrome.test.ts            (the checks)
//   npx tsx backend/test/accelaRecordChrome.test.ts --print    (what this checkout reads, per case)
import assert from "node:assert/strict";
import { classifyPermitStatusText, type TrackKind } from "../src/permitMonitor";

type Pinned = { name: string; text: string; track: TrackKind; outcome: string; label: string };

/** The email tracker's status text, joined exactly as repository.ts emailStatusText joins it. */
const email = (bucket: string, workflow: string, statusLabel: string, body: string): string =>
  [
    `Email bucket: ${bucket}`,
    `Workflow: ${workflow}`,
    `Status: ${statusLabel}`,
    "Required action: Review email, add missing document/data, and update pre-submission QC rule.",
    body,
  ].join("\n");

/** A fictional equivalent of the live Corvallis page: collection widget (no Expiration Date),
 *  the anonymous-visitor invitation, the conditions notice, and the More Details heading pair. */
const HEADING = "More Details Additional Information";
const corvallis = (status: string, heading = HEADING): string =>
  `Record BLD26-09990: Building - Residential (1 & 2 Family) Record Status: ${status} Add to Existing Collection --Select-- `
  + "Create a New Collection *Name: Description: Add Cancel To schedule inspections, pay fees or upload documents, please log in to your account."
  + "Note: Conditions are subject to change and are not valid until the permit is issued. Site Address 100 EXAMPLE STJURIS: SAMPLETOWN * "
  + "Case Details Applicant: Example Solar LLC 1 Example Ave Sampletown, OR, 97000 Project Description:Install roof-mounted photovoltaic "
  + "solar system: 9 modules at 440W, 3.96 kW DC / 3.84 kW AC, with microinverters and AC disconnect (30A). Interconnection method: "
  + `Load-side breaker. ${heading} Job Value($):$4,752.00 Case Information GENERAL Class of Work: Alteration Type of Use: 1 & 2 Family `
  + "Dwelling The City regularly uses drones to perform required inspections. I consent to drone inspection(s) for this project.: No "
  + "Parcel Information Parcel Number:00000AA00000 Print/View Summary Inspections Loading... Upcoming You have not added any inspections.";

/** Accela with an Expiration Date (the stated status is pulled out). */
const accelaExp = (status: string): string =>
  `Record 187-26-000901-STR: Residential Structural Record Status: ${status} Expiration Date: 03/16/2027 Create a New Collection `
  + "Work Location 1 EXAMPLE AVE SAMPLETOWN OR 97000 More Details Additional Information Job Value($):$9,999.00";
/** Accela, not yet issued: the collection widget instead of the Expiration Date. */
const accelaWidget = (status: string): string =>
  `Record BLD26-09991: Building Record Status: ${status} Add to Existing Collection --Select-- Create a New Collection `
  + "Work Location 1 EXAMPLE AVE More Details Additional Information Job Value($):$9,999.00";
/** Oregon ePermitting (aca-oregon): every record page also prints "Processing Status" and "Plan Review
 *  Required: No", which waitingPattern reads — the page-wide words are NOT the record's own words. */
const oregonTail = " Work Location 1 EXAMPLE AVE SAMPLETOWN OR 97000 More Details Additional Information Job Value($):$9,999.00"
  + " Processing Status Plan Review Required: No Inspections Fees";
const oregonExp = (status: string): string =>
  `Record 187-26-000902-STR: Residential Structural Record Status: ${status} Expiration Date: 03/16/2027 Create a New Collection` + oregonTail;
const oregonWidget = (status: string): string =>
  `Record 187-26-000903-STR: Residential Structural Record Status: ${status} Add to Existing Collection --Select-- Create a New Collection` + oregonTail;
const smartGov = (status: string): string =>
  `Permit Number BLD-2026-0101 Permit Status: ${status} Applied Date: 09/01/2026 Issued Date: Expiration Date: Parcel 00-00-00`;
const citizenServe = (status: string): string =>
  `Permit # 2026-0101 Application Status: ${status} Date Applied 09/01/2026 Contractor Example Solar LLC`;

// ------------------------------------------------------------------------------------------------
// THE FIX: the live page shape reads what it states.
// ------------------------------------------------------------------------------------------------
const FIXED: Pinned[] = [
  { name: "LIVE CASE: the Corvallis page (Record Status: Received, widget, invitation, heading pair)", text: corvallis("Received"), track: "permit", outcome: "waiting", label: "In review" },
  { name: "the heading pair with a '>' separator", text: corvallis("Received", "More Details > Additional Information"), track: "permit", outcome: "waiting", label: "In review" },
  { name: "the heading pair with a '›' separator", text: corvallis("Received", "More Details › Additional Information"), track: "permit", outcome: "waiting", label: "In review" },
  { name: "the heading pair with a '»' separator", text: corvallis("Received", "More Details » Additional Information"), track: "permit", outcome: "waiting", label: "In review" },
  { name: "the heading pair with a '|' separator", text: corvallis("Received", "More Details | Additional Information"), track: "permit", outcome: "waiting", label: "In review" },
  { name: "the heading pair with a '-' separator", text: corvallis("Received", "More Details - Additional Information"), track: "permit", outcome: "waiting", label: "In review" },
  // Base read this one ready_for_issue: glued, the heading misses correctionPattern's \b and the
  // invitation's "pay fees" answered instead.
  { name: "the heading pair glued (markup stripped, no space)", text: corvallis("Received", "More DetailsAdditional Information"), track: "permit", outcome: "waiting", label: "In review" },
  { name: "the invitation alone (no heading) no longer reads as a fee due", text: corvallis("Received", "More Details"), track: "permit", outcome: "waiting", label: "In review" },
  // Base read this ready_for_issue off the invitation's "pay fees". A fee reading is never restored.
  { name: "an unknown status beside the invitation (no heading) goes to a person, not to a fee due", text: corvallis("Corr. Required", "More Details"), track: "permit", outcome: "needs_human_review", label: "Needs human review" },
];

// ------------------------------------------------------------------------------------------------
// NARROW: what the change must NOT touch. Real corrections on the same page shape, a heading that
// ASKS for something, the heading not adjacent to "More Details", and real fee wording.
// ------------------------------------------------------------------------------------------------
const NARROW: Pinned[] = [
  { name: "same page, Record Status: Corrections Required -> still a correction", text: corvallis("Corrections Required"), track: "permit", outcome: "correction_flagged", label: "Correction flagged" },
  { name: "same page, Record Status: Additional Info Needed -> still a correction", text: corvallis("Additional Info Needed"), track: "permit", outcome: "correction_flagged", label: "Correction flagged" },
  { name: "same page, Record Status: Additional Information Required -> still a correction", text: corvallis("Additional Information Required"), track: "permit", outcome: "correction_flagged", label: "Correction flagged" },
  { name: "same page, Record Status: In Review/Additional Information -> still a correction", text: corvallis("In Review/Additional Information"), track: "permit", outcome: "correction_flagged", label: "Correction flagged" },
  { name: "a heading that ASKS ('More Details Additional Information Required: …') is not stripped", text: corvallis("Received", "More Details Additional Information Required: provide the attachment detail."), track: "permit", outcome: "correction_flagged", label: "Correction flagged" },
  { name: "'More Details Additional Information Needed' is not stripped", text: corvallis("Received", "More Details Additional Information Needed"), track: "permit", outcome: "correction_flagged", label: "Correction flagged" },
  { name: "the heading NOT adjacent to More Details (Related Contacts between) is left alone (base: correction)", text: corvallis("Received", "More Details Related Contacts Site Contact information Example Person Additional Information"), track: "permit", outcome: "correction_flagged", label: "Correction flagged" },
  { name: "a stated 'Approved pending payment' is still ready for issue", text: accelaExp("Approved pending payment"), track: "permit", outcome: "ready_for_issue", label: "Ready for issue - fee/payment needed" },
  { name: "prose fee wording beside the invitation is still ready for issue", text: "Your permit is approved pending payment. Fees due: $120.00. To schedule inspections, pay fees or upload documents, please log in to your account.", track: "permit", outcome: "ready_for_issue", label: "Ready for issue - fee/payment needed" },
  { name: "'Pay fees online to receive your permit' (not the invitation) is still ready for issue", text: "Status: Plan review complete. Pay fees online to receive your permit.", track: "permit", outcome: "ready_for_issue", label: "Ready for issue - fee/payment needed" },
  { name: "LIVE 187-26-000309-STR shape: In Review/Addl Info Needed + heading pair -> still a correction", text: accelaExp("In Review/Addl Info Needed"), track: "permit", outcome: "correction_flagged", label: "Correction flagged" },
  // A status no rule knows, on the Corvallis page shape: once the chrome is gone the page's own
  // words answer nothing, so the correction base raised stands (a missed correction is worse).
  { name: "same page, a status no rule knows ('Corr. Required') keeps base's correction", text: corvallis("Corr. Required"), track: "permit", outcome: "correction_flagged", label: "Correction flagged" },
  // OREGON ePERMITTING (status-converge skeptic item 5): the page's "Processing Status" / "Plan Review
  // Required" chrome reads as waiting, so "the page's own words" must be the STATUS VALUE, not the
  // page — base's correction on these statuses (values STATUS_LINE cannot pull out) stands.
  { name: "Oregon ePermitting page (Expiration Date): Corr. Required keeps base's correction", text: oregonExp("Corr. Required"), track: "permit", outcome: "correction_flagged", label: "Correction flagged" },
  ...["Revisions Required", "Revisions Needed", "Needs Revision", "Plan Check Comments", "Comments Issued", "Info Required", "Awaiting Information", "Waiting for Information"].map((v): Pinned =>
    ({ name: `Oregon ePermitting page (collection widget): ${v} keeps base's correction`, text: oregonWidget(v), track: "permit", outcome: "correction_flagged", label: "Correction flagged" })),
  // ...while a status value that answers a waiting rule still reads as waiting on the same page.
  ...["Received", "In Review", "Processing"].map((v): Pinned =>
    ({ name: `Oregon ePermitting page (collection widget): ${v} reads as waiting`, text: oregonWidget(v), track: "permit", outcome: "waiting", label: "In review" })),
];

// ------------------------------------------------------------------------------------------------
// THE SKEPTIC'S REGRESSION CASES (status-fix-RESULT.json verdict items 1–5 + notes), each pinned
// to base's reading — NOT to what a person would call right. None may move.
// ------------------------------------------------------------------------------------------------
// Each expectation below was READ OFF the base classifier (`--print` at 0a4fc06, before the chrome
// removal existed), not reasoned about.
const CORR = ["correction_flagged", "Correction flagged"] as const;
const WAIT = ["waiting", "In review"] as const;
const NHR = ["needs_human_review", "Needs human review"] as const;
const ISSUED = ["issued", "Permit issued"] as const;
const P = (name: string, text: string, track: TrackKind, base: readonly [string, string]): Pinned =>
  ({ name, text, track, outcome: base[0], label: base[1] });
const PINNED_BASE: Pinned[] = [
  // 1. Agency correction EMAILS whose body states a waiting status, then the correction.
  P("1 email: Permit Status: Under Review. The plans examiner has issued corrections", email("permit_correction", "permit", "Permit correction", "Permit Status: Under Review. The plans examiner has issued corrections; resubmit revised sheets."), "permit", CORR),
  P("1 email: Application Status: In Review. Corrections are required", email("permit_correction", "permit", "Permit correction", "Application Status: In Review. Corrections are required"), "permit", CORR),
  P("1 NEM email on the NEM track: Application Status: Received. Your application is incomplete", email("nem_correction", "nem", "NEM/interconnection correction", "Application Status: Received. Your application is incomplete; upload a photo of the meter face."), "nem", CORR),
  P("1 NEM email on the permit track: Application Status: Received. Your application is incomplete", email("nem_correction", "nem", "NEM/interconnection correction", "Application Status: Received. Your application is incomplete; upload a photo of the meter face."), "permit", CORR),
  P("1 bare line: Permit Status: Under Review. … issued corrections", "Permit Status: Under Review. The plans examiner has issued corrections; resubmit revised sheets.", "permit", CORR),
  P("1 bare line: Application Status: Received. Your application is incomplete (NEM)", "Application Status: Received. Your application is incomplete; upload a photo of the meter face.", "nem", CORR),
  // 2. "Additional information" wherever there is no labelled status field.
  P("2 page: Status Request for Additional Information", "Permit BLD-2026-0101 Status Request for Additional Information Applied 09/01/2026", "permit", CORR),
  P("2 page: Pending Additional Information", "Permit BLD-2026-0101 Status Pending Additional Information Applied 09/01/2026", "permit", CORR),
  P("2 page: Awaiting Additional Information", "Permit BLD-2026-0101 Status Awaiting Additional Information Applied 09/01/2026", "permit", CORR),
  P("2 page: Hold - Additional Information", "Permit BLD-2026-0101 Status Hold - Additional Information Applied 09/01/2026", "permit", CORR),
  P("2 page: bare Additional Information", "Additional Information", "permit", CORR),
  P("2 email: Please submit additional information for plan review.", email("permit_correction", "permit", "Permit correction", "Please submit additional information for plan review."), "permit", CORR),
  // Base reads this one as needs_human_review ("Workflow: permit Status: Status update" extracts a
  // stated "Status update"); pinned as base, not as right.
  P("2 email: The City needs additional information to continue processing your permit.", email("status_update", "permit", "Status update", "The City needs additional information to continue processing your permit."), "permit", NHR),
  P("2 email: Request for Additional Information - Permit BLD-2026-0101", email("permit_correction", "permit", "Permit correction", "Request for Additional Information - Permit BLD-2026-0101"), "permit", CORR),
  P("2 missing_info_request email: Please provide additional information", email("missing_info_request", "permit", "Missing information request", "Please provide additional information about the main service panel."), "permit", CORR),
  P("2 plain text: Please submit additional information for plan review.", "Please submit additional information for plan review.", "permit", CORR),
  P("2 plain text: Request for Additional Information - Permit BLD-2026-0101", "Request for Additional Information - Permit BLD-2026-0101", "permit", CORR),
  // 3. A stated review status with "Additional Information" after it, on four page shapes.
  ...["In Review/Additional Information", "In Review - Additional Information", "Plan Review - Additional Information"].flatMap((v) => [
    P(`3 Accela (Expiration Date): ${v}`, accelaExp(v), "permit", CORR),
    P(`3 Accela (collection widget): ${v}`, accelaWidget(v), "permit", CORR),
    P(`3 SmartGov: ${v}`, smartGov(v), "permit", CORR),
    P(`3 CitizenServe: ${v}`, citizenServe(v), "permit", CORR),
  ]),
  // 4. A sentence stop inside the stated value, and abbreviations with periods.
  P("4 Record Status: In Review. Corrections required", "Record Status: In Review. Corrections required", "permit", CORR),
  P("4 Record Status: Received. Corrections required: see plan review comments.", "Record Status: Received. Corrections required: see plan review comments.", "permit", CORR),
  P("4 LIVE 3addf63c shape: …(1 & 2 Family). Record Status: Received", "Record BLD26-09990: Building - Residential (1 & 2 Family). Record Status: Received", "permit", WAIT),
  ...["Plan Rev. Corrections Required", "Bldg. Corrections Required", "Appl. Incomplete", "In Review/Addl. Info Needed"].flatMap((v) => [
    P(`4 Record Status: ${v}`, `Record Status: ${v}`, "permit", CORR),
    P(`4 Accela (Expiration Date): ${v}`, accelaExp(v), "permit", CORR),
  ]),
  // Base: the bare line reads needs_human_review (no correction word in "Corr. Required"); on the
  // Accela page the page-wide scan meets the heading. Pinned as base, both ways.
  P("4 Record Status: Corr. Required", "Record Status: Corr. Required", "permit", NHR),
  P("4 Accela (Expiration Date): Corr. Required", accelaExp("Corr. Required"), "permit", CORR),
  // 5. Issued records with a qualifier, a date or a parenthetical.
  ...["Issued (Online)", "Issued (OTC)", "Issued 09/28/2026"].flatMap((v) => [
    P(`5 Record Status: ${v} Expiration Date: …`, `Record Status: ${v} Expiration Date: 09/28/2027`, "permit", ISSUED),
    P(`5 Record Status: ${v} (no Expiration Date)`, `Record Status: ${v}`, "permit", ISSUED),
    P(`5 Accela page: ${v}`, accelaExp(v), "permit", ISSUED),
  ]),
  // Base: a hyphenated qualifier is extracted whole ("Issued - Online") and statedIssuedPattern is
  // anchored, so base reads these as needs_human_review. Pinned as base.
  ...["Issued - Online", "Issued-OTC"].flatMap((v) => [
    P(`5 Record Status: ${v} Expiration Date: …`, `Record Status: ${v} Expiration Date: 09/28/2027`, "permit", NHR),
    P(`5 Record Status: ${v} (no Expiration Date)`, `Record Status: ${v}`, "permit", NHR),
    P(`5 Accela page: ${v}`, accelaExp(v), "permit", NHR),
  ]),
  // Notes: base reads these too; pinned so nothing moves.
  P("note: Record Status: Finaled (no Expiration Date)", "Record Status: Finaled", "permit", ISSUED),
  P("note: Record Status: Closed - Finaled (no Expiration Date)", "Record Status: Closed - Finaled", "permit", ISSUED),
  P("note: jurisdictionCriteriaLearning's ORIGINAL NEM page (no sentence stop)", "Interconnection Application Status: In Review/Addl Info Needed Utility review queue\nGround snow load shall be 36 psf.\nWind exposure D is required.", "nem", CORR),
  P("note: Record Status: Corrections Required + unknown page chrome", "Record Status: Corrections Required Print Page Help Log Out Search Records", "permit", CORR),
];

const ALL: Array<[string, Pinned[]]> = [["fix", FIXED], ["narrow", NARROW], ["base", PINNED_BASE]];

if (process.argv.includes("--print")) {
  for (const [group, cases] of ALL) {
    for (const c of cases) {
      const r = classifyPermitStatusText(c.text, c.track);
      console.log(JSON.stringify({ group, name: c.name, outcome: r.outcome, label: r.statusLabel }));
    }
  }
  process.exit(0);
}

let failures = 0;
let passed = 0;
for (const [group, cases] of ALL) {
  for (const c of cases) {
    try {
      const r = classifyPermitStatusText(c.text, c.track);
      assert.equal(`${r.outcome} / ${r.statusLabel}`, `${c.outcome} / ${c.label}`);
      passed++;
      console.log(`  ok   - [${group}] ${c.name}`);
    } catch (err) {
      failures++;
      console.error(`  FAIL - [${group}] ${c.name}\n         ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
}
const total = ALL.reduce((n, [, cases]) => n + cases.length, 0);
if (failures) { console.error(`\n${failures} of ${total} Accela record-chrome check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${passed} of ${total} Accela record-chrome checks passed.`);
process.exit(0);
