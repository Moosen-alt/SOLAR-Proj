// THE MARION E-01 FEE TOTAL FROM THE FORM'S OWN PRINTED LADDER (live 2026-09-27, Michael Sheridan —
// City of Jefferson, Marion County issues the electrical permit). His filled E-01 ticked Qty 1 on
// "5.01 to 15 kva" but left the Total, Subtotal, State surcharge and TOTAL PERMIT FEE blank: no Marion
// County electrical fee schedule is on file, and the computed electrical* sources read only a saved
// jurisdiction fee line.
//
// The curated E-01 is hash-locked to one revision, and its fee schedule is PRINTED on it (read off
// backend/test/fixtures/marion-e-01.pdf): SOLAR 5 kva or less $79.00; 5.01 to 15 kva $94.00; 15.01 to
// 25 kva $156.00; over 25 kva $156.00 + $6.25/kva to 100; over 100 $624.75; state surcharge 12% of the
// permit fee; plan review 25% when the system exceeds 25 kVA. When no saved electrical fee line is on
// file, the E-01 fill uses that ladder for systems <= 25 kVA — data carried with the curated seed for
// that hash, never a DB write, never a "verified" fee schedule (hard rule 3).
//
//   MUST-PASS     Michael-shaped AC 12.913 kVA -> 5.01-15 -> $94.00 / $94.00 / $11.28 / $105.28, and the
//                 'electrical permit fee' line leaves the blank-fields list; 4 kVA -> $79.00 / $9.48 / $88.48.
//   MUST-EXCLUDE  30 kVA stays blank (plan review / per-kVA not auto-computed); a saved fee line wins over
//                 the printed ladder (and one that declines to price is not overruled); the building
//                 B-01S is untouched; no other curated form carries a ladder.
//   N1            no AC rating (DC-only 15.91) -> every fee cell blank: never a dollar amount from the DC fallback.
//   N3            the fill message says ONE fee story: the printed-ladder note, without the curated generic
//                 "printed rates may be historical" beside it (which stays when a saved line priced the form).
//   (The real lookup's delegation shape — City of Jefferson -> Marion County with no Marion schedule — is
//   marionE01DelegatedFees.)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "marion-e01-fees-"));
process.env.AUTOPILOT_DB_PATH = path.join(temp, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.PROJECT_DOCS_DIR = path.join(temp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(temp, "profiles");
process.env.BACKUP_DIR = path.join(temp, "backups");
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { savePermitProcessLookup } = await import("../src/permitProcess");
const forms = await import("../src/ahjForms");
const auto = await import("../src/ahjFormAuto");
const curated = await import("../src/curatedAhjForms");
const { saveFeeSchedule, feeForProject } = await import("../src/feeSchedules");
// (guarded so the pre-fix run reports which pins fall instead of throwing on a missing export)
const printedFees = (b: Uint8Array): unknown => (curated as { curatedPrintedFees?: (bytes: Uint8Array) => unknown }).curatedPrintedFees?.(b) ?? null;

const db = await openDatabase();
const noModel = new Proxy({}, { get() { throw new Error("known public forms must not call a model"); } }) as never;
const fixture = (name: string) => fs.readFileSync(path.join("backend/test/fixtures", name));
const B01S_URL = "https://www.co.marion.or.us/PW/BuildingInspection/Documents/B-01S%20Solar%20Prescriptive%20Installation%20Application%20Filleable.pdf";
const E01_URL = "https://www.co.marion.or.us/PW/BuildingInspection/Documents/E-01%20Renewable%20Energy%20Permit%20Application.pdf";
const B5952_URL = "https://www.oregon.gov/bcd/Formslibrary/5952.pdf";
const MARION_PAGE = "https://www.co.marion.or.us/PW/BuildingInspection";
const FEE_LABEL = "electrical permit fee (the county schedule, when not on file)";

let passed = 0;
const failed: string[] = [];
const check = (name: string, cond: unknown, detail = ""): void => {
  if (cond) { passed++; return; }
  failed.push(name);
  console.error(`  FAIL - ${name}${detail ? `\n         ${detail.slice(0, 900)}` : ""}`);
};

// Michael's lookup shape: Marion County issues both permits.
const cited = (value: string, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const notFound = (why: string, sourceUrl = "", quote = "") => ({ value: null, sourceUrl, quote, origin: "lookup" as const, notFound: why });
const portal = notFound("no online portal named", MARION_PAGE, "Check permit status online and general information for individual permits");
assert.equal((savePermitProcessLookup(db, {
  state: "OR", ahj: "City of Jefferson", lookedUpAt: new Date().toISOString(), issuingAgency: notFound("not stated at the top level"),
  permitStructure: cited("separate", "https://jeffersonoregon.org/planning-committee/", "All Electrical and Plumbing permits are submitted to Marion County Building"),
  permits: [
    { discipline: "structural", label: "Solar PV (Prescriptive) / Structural Permit", issuingAgency: cited("Marion County", B01S_URL, "Prescriptive Solar Photovoltaic Installation Permit Application · Marion County Public Works"),
      portalUrl: portal, recordType: notFound("none"), documents: notFound("no list"), fee: notFound("none") },
    { discipline: "electrical", label: "Electrical Permit", issuingAgency: cited("Marion County", "https://jeffersonoregon.org/planning-committee/", "All Electrical and Plumbing permits are submitted to Marion County Building and those forms can be found here."),
      portalUrl: portal, recordType: notFound("none"), documents: notFound("no list"), fee: notFound("none") },
  ],
  notes: [],
} as never) as { saved?: boolean }).saved, true);

const jefferson = {
  id: "jefferson-e01", ahj: "City of Jefferson", state: "OR", city: "Jefferson", zip: "97352", utility: "Pacific Power",
  homeownerName: "Fixture Owner", projectAddress: "1 Fixture Rd SE, Jefferson, OR, 97352", systemSizeDcKw: 15.91, systemSizeAcKw: 12.913,
  parserSnapshot: { permitPathOverride: "prescriptive", homeownerPhone: "4580000000", mounting: "Roof Mount", structureDescription: "Single-family dwelling" },
};

const realFetch = globalThis.fetch;
const served = new Map<string, Buffer>([[B01S_URL, fixture("marion-b-01s.pdf")], [E01_URL, fixture("marion-e-01.pdf")], [B5952_URL, fixture("bcd-5952-2024.pdf")]]);
globalThis.fetch = (async (url: string | URL) => {
  const body = served.get(String(url));
  return body ? new Response(body, { headers: { "Content-Type": "application/pdf" } }) : new Response("not found", { status: 404 });
}) as typeof fetch;

const filledDirs: string[] = [];
let seq = 0;
type Fees = { q5: string; t5: string; q15: string; t15: string; q25: string; t25: string; subtotal: string; surcharge: string; total: string };
async function fill(acKw: number | null, snapshot: Record<string, unknown> = {}) {
  const project = { ...jefferson, id: `jefferson-e01-${++seq}`, systemSizeAcKw: acKw, parserSnapshot: { ...jefferson.parserSnapshot, ...snapshot } } as never;
  filledDirs.push((project as { id: string }).id);
  const pkg = await forms.buildFilledFormsForProject(db, project);
  const loaded = forms.loadStoredTemplates(db, "City of Jefferson", "OR");
  const e = pkg.forms.find((f) => f.templateId === loaded.find((t) => t.formType === "electrical_application")?.templateId);
  const b = pkg.forms.find((f) => f.templateId === loaded.find((t) => t.formType === "building_application")?.templateId);
  assert.ok(e?.outputPath && b?.outputPath, `fill produced both county applications: ${JSON.stringify(pkg.forms.map((f) => [f.formName, f.status]))}`);
  const doc = await PDFDocument.load(fs.readFileSync(e.outputPath));
  const tf = (n: string) => doc.getForm().getTextField(n).getText() ?? "";
  const fees: Fees = { q5: tf("5 kva or less"), t5: tf("7900"), q15: tf("501 to 15 kva"), t15: tf("9400"), q25: tf("1501 to 25 kva"), t25: tf("15600"),
    subtotal: tf("Subtotal"), surcharge: tf("State surcharge 12 of permit fee"), total: tf("TOTAL PERMIT FEE") };
  return { e, b, fees };
}
const show = (f: Fees) => JSON.stringify(f);

try {
  const ens = await auto.ensureAhjFormsForProject(db, noModel, jefferson as never, { allowResearch: false });
  assert.ok(ens.results.every((r) => r.status === "acquired"), `setup: acquired ${JSON.stringify(ens.results.map((r) => [r.formType, r.status]))}`);
  check("setup: no saved electrical fee line for the job", !(feeForProject(db, jefferson as never, "permit")?.lines ?? []).some((l) => l.discipline === "electrical"));
  const feeRowsBefore = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM fee_schedules")!.n;
  const e01MapBefore = db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE ahj_name = 'Marion County' AND form_type = 'electrical_application'")!.field_map;

  // ═══ MUST-PASS — Michael: AC 12.913 kVA ═════════════════════════════════════════════════════
  const michael = await fill(12.913);
  check("MUST-PASS Michael 12.913 kVA: Qty 1 on 5.01-15, its Total $94.00", michael.fees.q15 === "1" && michael.fees.t15 === "94.00", show(michael.fees));
  check("MUST-PASS Subtotal $94.00, State surcharge (12%) $11.28, TOTAL PERMIT FEE $105.28", michael.fees.subtotal === "94.00" && michael.fees.surcharge === "11.28" && michael.fees.total === "105.28", show(michael.fees));
  check("MUST-PASS the other rows stay empty", !michael.fees.q5 && !michael.fees.t5 && !michael.fees.q25 && !michael.fees.t25, show(michael.fees));
  check("MUST-PASS the 'electrical permit fee' line leaves the blank-fields list", !(michael.e.unmappedRequested ?? []).includes(FEE_LABEL), JSON.stringify(michael.e.unmappedRequested));
  check("MUST-PASS the fill says where the fees came from (the form's printed schedule, no saved schedule on file)", /Fees are the schedule printed on this form/.test(michael.e.message ?? "") && /confirm/i.test(michael.e.message ?? ""), michael.e.message);
  // N3: one story — the curated generic "printed rates may be historical" is not said beside it.
  check("N3 the message does not also say 'printed rates may be historical' (one coherent fee story)", !/printed rates may be historical/i.test(michael.e.message ?? "")
    && /Owner mailing\/contact details require actual owner information/.test(michael.e.message ?? ""), michael.e.message);

  // N1: no AC rating -> the printed ladder declines (never a dollar amount from the DC fallback).
  const dcOnly = await fill(null);
  check("N1 DC-only 15.91 (no AC rating): every fee cell blank — no Total, Subtotal, surcharge or TOTAL from the DC fallback",
    !dcOnly.fees.t5 && !dcOnly.fees.t15 && !dcOnly.fees.t25 && !dcOnly.fees.subtotal && !dcOnly.fees.surcharge && !dcOnly.fees.total, show(dcOnly.fees));
  check("N1 and the fill does not claim the printed schedule priced it", !/Fees are the schedule printed on this form/.test(dcOnly.e.message ?? ""), dcOnly.e.message);

  const small = await fill(4);
  check("MUST-PASS 4 kVA: Qty 1 on 5 kva or less, $79.00 / $79.00 / $9.48 / $88.48", small.fees.q5 === "1" && small.fees.t5 === "79.00" && small.fees.subtotal === "79.00" && small.fees.surcharge === "9.48" && small.fees.total === "88.48", show(small.fees));
  const mid = await fill(20);
  check("15.01-25 kVA (20): $156.00 / $18.72 / $174.72", mid.fees.q25 === "1" && mid.fees.t25 === "156.00" && mid.fees.subtotal === "156.00" && mid.fees.surcharge === "18.72" && mid.fees.total === "174.72", show(mid.fees));
  const edge = await fill(15);
  check("the bracket bound is inclusive: exactly 15 kVA is 5.01-15 ($94.00)", edge.fees.q15 === "1" && edge.fees.t15 === "94.00" && edge.fees.total === "105.28", show(edge.fees));
  const top = await fill(25);
  check("exactly 25 kVA is 15.01-25 ($156.00 / $174.72)", top.fees.q25 === "1" && top.fees.total === "174.72", show(top.fees));

  // ═══ MUST-EXCLUDE — over 25 kVA stays blank ═════════════════════════════════════════════════
  const big = await fill(30);
  check("MUST-EXCLUDE 30 kVA: no row, no Total, Subtotal, surcharge or TOTAL (plan review / per-kVA not computed)",
    Object.values(big.fees).every((v) => v === ""), show(big.fees));
  check("MUST-EXCLUDE 30 kVA keeps 'electrical permit fee' on the blank-fields list", (big.e.unmappedRequested ?? []).includes(FEE_LABEL), JSON.stringify(big.e.unmappedRequested));

  // The existing blanking rules hold on the printed ladder too.
  const review = await fill(12.913, { electricalPlanReviewRequired: "yes" });
  check("a known plan-review trigger: the row fills, the surcharge and TOTAL stay blank", review.fees.t15 === "94.00" && !review.fees.surcharge && !review.fees.total, show(review.fees));
  const battery = await fill(12.913, { hasBattery: "Yes", batteryModel: "Fixture Battery 13.5" });
  check("a battery job (services/feeders line not on the E-01's ladder): the row fills, Subtotal / surcharge / TOTAL stay blank",
    battery.fees.t15 === "94.00" && !battery.fees.subtotal && !battery.fees.surcharge && !battery.fees.total, show(battery.fees));

  // ═══ MUST-EXCLUDE — the building B-01S is untouched; no other curated form carries a ladder ════
  const b01sDoc = await PDFDocument.load(fs.readFileSync(michael.b.outputPath!));
  const b01sValues = b01sDoc.getForm().getFields().filter((f) => "getText" in f).map((f) => (f as unknown as { getText(): string | undefined }).getText() ?? "");
  check("MUST-EXCLUDE the B-01S carries no fee figure", !b01sValues.some((v) => /^(?:94\.00|11\.28|105\.28|79\.00)$/.test(v)), JSON.stringify(b01sValues.filter(Boolean)));
  check("MUST-EXCLUDE the B-01S fill message says nothing of a printed schedule", !/Fees are the schedule printed on this form/.test(michael.b.message ?? ""), michael.b.message);
  check("only the E-01's hash carries a printed ladder (B-01S, Coos, Tigard, BCD 5952 do not)",
    printedFees(fixture("marion-e-01.pdf")) != null
    && ["marion-b-01s.pdf", "coos-electrical.pdf", "tigard-electrical.pdf", "tigard-building.pdf", "bcd-5952-2024.pdf"].every((f) => printedFees(fixture(f)) == null));
  check("a changed revision (other bytes) gets no ladder", printedFees(Buffer.concat([fixture("marion-e-01.pdf"), Buffer.from("revision")])) == null);

  // Never a DB write: no fee schedule row, and the stored E-01 map is unchanged by the fills.
  check("never a DB write: no fee schedule row was created by the fills", db.get<{ n: number }>("SELECT COUNT(*) AS n FROM fee_schedules")!.n === feeRowsBefore);
  check("never a DB write: the stored E-01 map is unchanged", db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE ahj_name = 'Marion County' AND form_type = 'electrical_application'")!.field_map === e01MapBefore);

  // ═══ MUST-EXCLUDE — a saved jurisdiction fee line wins over the printed ladder ═════════════════
  // (the real write path: saveFeeSchedule with a corroborated 12% surcharge — formFeeCompleteness' shape)
  const url = "https://www.co.marion.or.us/PW/BuildingInspection/fees.pdf";
  const row = "Renewable energy 5.01 to 15 kva | $120.00";
  const surcharge = "Note: A 12% surcharge fee as mandated by the State Building Codes Division is applied to all permit fees, investigation fees and inspection fees listed.";
  const finding = { found: true, reason: "", basis: "system_kw" as const, brackets: [{ minKw: 5.01, maxKw: 15, feeUsd: 120, label: "Renewable energy 5.01 to 15 kva" }], notes: "", sourceUrl: url, sourceQuote: row, sourceKind: "official", discipline: "electrical" };
  const saved = saveFeeSchedule(db, { state: "OR", ahj: "City of Jefferson", track: "permit", discipline: "electrical" }, finding as never,
    { corroborateAgainst: { evidence: [{ url, via: "http" as const, status: 200, kind: "pdf" as const, bytes: 100, handed: 2 }], corpus: [row + "\n" + surcharge] } } as never);
  check("(setup) the saved schedule is on file and prices the job", (saved as { saved?: boolean }).saved === true
    && feeForProject(db, jefferson as never, "permit")?.lines?.find((l) => l.discipline === "electrical")?.feeUsd === 134.4,
    JSON.stringify(feeForProject(db, jefferson as never, "permit")?.lines?.map((l) => [l.discipline, l.feeUsd, l.reason])));
  const withLine = await fill(12.913);
  check("MUST-EXCLUDE a saved fee line wins: $120.00 / $120.00 / $14.40 / $134.40, not the printed $94.00",
    withLine.fees.t15 === "120.00" && withLine.fees.subtotal === "120.00" && withLine.fees.surcharge === "14.40" && withLine.fees.total === "134.40", show(withLine.fees));
  check("MUST-EXCLUDE and the fill does not claim the printed schedule", !/Fees are the schedule printed on this form/.test(withLine.e.message ?? ""), withLine.e.message);
  check("N3 control: with a saved line the generic fee sentence stays (it is dropped only when the printed ladder priced the form)",
    /printed rates may be historical/.test(withLine.e.message ?? ""), withLine.e.message);
  const declined = await fill(4);
  check("MUST-EXCLUDE a saved line that declines to price this size (no bracket) is not overruled by the printed ladder", declined.fees.q5 === "1" && Object.entries(declined.fees).every(([k, v]) => k === "q5" || v === ""),
    show(declined.fees));

  assert.equal(failed.length, 0, `${failed.length} check(s) failed: ${failed.join(" | ")}`);
  console.log(`marionE01PrintedFees: ${passed} checks passed — with no saved fee line the Marion E-01 fills its own printed ladder (<= 25 kVA: row, Subtotal, 12% surcharge, TOTAL; Michael $105.28, 4 kVA $88.48), over 25 kVA stays blank, a saved line wins, the B-01S and every other curated form are untouched, nothing is written to the DB`);
} finally {
  globalThis.fetch = realFetch;
  db.close();
  for (const id of filledDirs) fs.rmSync(path.resolve("backend/data/filled", id), { recursive: true, force: true });
  assert.equal(path.dirname(temp), os.tmpdir());
  fs.rmSync(temp, { recursive: true, force: true });
}
