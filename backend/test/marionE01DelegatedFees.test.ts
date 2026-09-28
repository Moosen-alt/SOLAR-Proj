// THE MARION E-01 PRINTED LADDER ON THE REAL LOOKUP SHAPE (stage-forms-fee skeptic MF, 2026-09-27).
//
// marionE01PrintedFees pins the ladder where the project has NO electrical fee line at all. The real
// per-job lookup never leaves it that way: runPermitProcessLookup -> applyLookupFees saves the City of
// Jefferson's rows as DELEGATIONS to Marion County (collectedByProfileKey 'or|marion county'), and with
// no Marion County schedule on file feeLinesForProject returns an electrical line with feeUsd null and
// the reason "Fee is collected by ..., and no schedule is stored for that authority yet". The ladder
// read that line as "a saved line that declines to price" and left Michael's E-01 blank.
//
// The rule: feeLinesForProject / resolveLine FLAG such a line (unresolvedCollector: true — nothing was
// evaluated), and ahjForms treats a flagged line as "no saved line" at both places (the fee cells and
// the fill note) — by the flag, never a regex on the reason. Everything else keeps its blank.
//
//   MUST-PASS     savePermitProcessLookup + applyLookupFees (Jefferson -> Marion County, no Marion
//                 schedule): E-01 fills 94.00 / 94.00 / 11.28 / 105.28 for AC 12.913 kVA.
//   MUST-EXCLUDE  a chain (Marion County's own row delegates onward) is not flagged and stays blank;
//                 once a Marion County schedule is saved (saveFeeSchedule, the real write path) the
//                 hopped saved line wins ($120.00 / $134.40), and where it declines (4 kVA, no bracket)
//                 the cells stay blank.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "marion-e01-delegated-"));
process.env.AUTOPILOT_DB_PATH = path.join(temp, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.PROJECT_DOCS_DIR = path.join(temp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(temp, "profiles");
process.env.BACKUP_DIR = path.join(temp, "backups");
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { savePermitProcessLookup } = await import("../src/permitProcess");
const { applyLookupFees } = await import("../src/permitProcessLookup");
const forms = await import("../src/ahjForms");
const auto = await import("../src/ahjFormAuto");
const fees = await import("../src/feeSchedules");

const db = await openDatabase();
const noModel = new Proxy({}, { get() { throw new Error("known public forms must not call a model"); } }) as never;
const fixture = (name: string) => fs.readFileSync(path.join("backend/test/fixtures", name));
const B01S_URL = "https://www.co.marion.or.us/PW/BuildingInspection/Documents/B-01S%20Solar%20Prescriptive%20Installation%20Application%20Filleable.pdf";
const E01_URL = "https://www.co.marion.or.us/PW/BuildingInspection/Documents/E-01%20Renewable%20Energy%20Permit%20Application.pdf";
const B5952_URL = "https://www.oregon.gov/bcd/Formslibrary/5952.pdf";
const MARION_PAGE = "https://www.co.marion.or.us/PW/BuildingInspection";
const JEFF_PAGE = "https://jeffersonoregon.org/planning-committee/";

let passed = 0;
const failed: string[] = [];
const check = (name: string, cond: unknown, detail = ""): void => {
  if (cond) { passed++; return; }
  failed.push(name);
  console.error(`  FAIL - ${name}${detail ? `\n         ${detail.slice(0, 900)}` : ""}`);
};

// Michael's lookup shape: Marion County issues both permits; no fee found for either.
const cited = (value: string, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const notFound = (why: string, sourceUrl = "", quote = "") => ({ value: null, sourceUrl, quote, origin: "lookup" as const, notFound: why });
const portal = notFound("no online portal named", MARION_PAGE, "Check permit status online and general information for individual permits");
const res = savePermitProcessLookup(db, {
  state: "OR", ahj: "City of Jefferson", lookedUpAt: new Date().toISOString(), issuingAgency: notFound("not stated at the top level"),
  permitStructure: cited("separate", JEFF_PAGE, "All Electrical and Plumbing permits are submitted to Marion County Building"),
  permits: [
    { discipline: "structural", label: "Solar PV (Prescriptive) / Structural Permit", issuingAgency: cited("Marion County", B01S_URL, "Prescriptive Solar Photovoltaic Installation Permit Application · Marion County Public Works"),
      portalUrl: portal, recordType: notFound("none"), documents: notFound("no list"), fee: notFound("none") },
    { discipline: "electrical", label: "Electrical Permit", issuingAgency: cited("Marion County", JEFF_PAGE, "All Electrical and Plumbing permits are submitted to Marion County Building and those forms can be found here."),
      portalUrl: portal, recordType: notFound("none"), documents: notFound("no list"), fee: notFound("none") },
  ],
  notes: [],
} as never) as { saved?: boolean; lookup?: unknown };
assert.equal(res.saved, true, "lookup saved");
// THE REAL WRITE PATH the lookup runs right after saving (runPermitProcessLookup -> applyLookupFees).
const landed = applyLookupFees(db, res.lookup as never);

const jefferson = {
  id: "jefferson-deleg", ahj: "City of Jefferson", state: "OR", city: "Jefferson", zip: "97352", utility: "Pacific Power",
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
async function fill(acKw: number) {
  const project = { ...jefferson, id: `jefferson-deleg-${++seq}`, systemSizeAcKw: acKw } as never;
  filledDirs.push((project as { id: string }).id);
  const pkg = await forms.buildFilledFormsForProject(db, project);
  const loaded = forms.loadStoredTemplates(db, "City of Jefferson", "OR");
  const e = pkg.forms.find((f) => f.templateId === loaded.find((t) => t.formType === "electrical_application")?.templateId);
  assert.ok(e?.outputPath, `fill produced the county's E-01: ${JSON.stringify(pkg.forms.map((f) => [f.formName, f.status]))}`);
  const doc = await PDFDocument.load(fs.readFileSync(e.outputPath));
  const tf = (n: string) => doc.getForm().getTextField(n).getText() ?? "";
  const got: Fees = { q5: tf("5 kva or less"), t5: tf("7900"), q15: tf("501 to 15 kva"), t15: tf("9400"), q25: tf("1501 to 25 kva"), t25: tf("15600"),
    subtotal: tf("Subtotal"), surcharge: tf("State surcharge 12 of permit fee"), total: tf("TOTAL PERMIT FEE") };
  return { e, fees: got };
}
const show = (f: Fees) => JSON.stringify(f);
const electricalLine = () => fees.feeForProject(db, jefferson as never, "permit")?.lines?.find((l) => l.discipline === "electrical");
const allCells = (f: Fees) => [f.t5, f.t15, f.t25, f.subtotal, f.surcharge, f.total];

try {
  // ═══ SETUP — the lookup's own fee landing: the City of Jefferson delegates to Marion County ═══════
  const marionKey = fees.feeScheduleProfileKey({ state: "OR", ahj: "Marion County" }, "permit");
  const jRows = fees.getFeeSchedulesForKey(db, fees.feeScheduleProfileKey({ state: "OR", ahj: "City of Jefferson" }, "permit"), "permit");
  check("setup: applyLookupFees saved the City of Jefferson's rows as delegations to Marion County ('or|marion county|…')",
    marionKey.startsWith("or|marion county") && jRows.some((r) => r.discipline === "electrical" && r.collectedByProfileKey === marionKey),
    JSON.stringify({ marionKey, landed, rows: jRows.map((r) => [r.discipline, r.collectedByProfileKey]) }));
  const pre = electricalLine();
  check("setup (the shape that left Michael blank): an electrical line IS on file, feeUsd null, the collector has no schedule",
    pre != null && pre.feeUsd == null && /no schedule is stored for that authority/.test(pre.reason), JSON.stringify(pre));
  check("the line is FLAGGED unresolvedCollector (feeLinesForProject)", pre?.unresolvedCollector === true, JSON.stringify(pre));
  const single = fees.feeForProject(db, jefferson as never, "electrical")?.lines?.[0];
  check("one question, one predicate: the discipline-named door (resolveLine) flags it too", single?.unresolvedCollector === true && single.feeUsd == null, JSON.stringify(single));

  const ens = await auto.ensureAhjFormsForProject(db, noModel, jefferson as never, { allowResearch: false });
  assert.ok(ens.results.every((r) => r.status === "acquired"), `setup: acquired ${JSON.stringify(ens.results.map((r) => [r.formType, r.status, r.message]))}`);

  // ═══ MUST-PASS — the flagged line is "no saved line": the E-01 prices off its printed ladder ═══════
  const michael = await fill(12.913);
  check("MUST-PASS Michael 12.913 kVA through the real lookup: Qty 1 on 5.01-15, $94.00 / $94.00 / $11.28 / $105.28",
    michael.fees.q15 === "1" && michael.fees.t15 === "94.00" && michael.fees.subtotal === "94.00" && michael.fees.surcharge === "11.28" && michael.fees.total === "105.28", show(michael.fees));
  check("MUST-PASS the fill says the fees are the form's printed schedule, and not also 'printed rates may be historical'",
    /Fees are the schedule printed on this form/.test(michael.e.message ?? "") && !/printed rates may be historical/.test(michael.e.message ?? ""), michael.e.message);

  // ═══ MUST-EXCLUDE — a chain of pointers is not "no schedule": not flagged, stays blank ══════════════
  const SRC = "https://www.co.marion.or.us/PW/BuildingInspection/fees.pdf";
  const chain = fees.saveFeeSchedule(db, { state: "OR", ahj: "Marion County", track: "permit", discipline: "electrical" }, {
    found: true, reason: "", basis: "other", brackets: [], sourceUrl: SRC, sourceQuote: "Electrical permits for the county are issued by Polk County", sourceKind: "official",
    collectedByProfileKey: fees.feeScheduleProfileKey({ state: "OR", ahj: "Polk County" }, "permit"), notes: "",
  } as never);
  const chained = electricalLine();
  check("(setup) Marion County's own row delegates onward: the Jefferson line is a chain", (chain as { saved?: boolean }).saved === true && /delegates onward/.test(chained?.reason ?? ""), JSON.stringify({ chain, chained }));
  check("MUST-EXCLUDE a chain is NOT flagged unresolvedCollector", chained != null && chained.unresolvedCollector === undefined, JSON.stringify(chained));
  const chainFill = await fill(12.913);
  check("MUST-EXCLUDE a chain keeps its blank: no printed-ladder amount on any fee cell", allCells(chainFill.fees).every((v) => v === ""), show(chainFill.fees));
  check("MUST-EXCLUDE and the fill does not claim the printed schedule", !/Fees are the schedule printed on this form/.test(chainFill.e.message ?? ""), chainFill.e.message);

  // ═══ MUST-EXCLUDE — a Marion County schedule saved through the real write path wins ════════════════
  const row = "Renewable energy 5.01 to 15 kva | $120.00";
  const surcharge = "Note: A 12% surcharge fee as mandated by the State Building Codes Division is applied to all permit fees, investigation fees and inspection fees listed.";
  const finding = { found: true, reason: "", basis: "system_kw" as const, brackets: [{ minKw: 5.01, maxKw: 15, feeUsd: 120, label: "Renewable energy 5.01 to 15 kva" }], notes: "", sourceUrl: SRC, sourceQuote: row, sourceKind: "official", discipline: "electrical" };
  const saved = fees.saveFeeSchedule(db, { state: "OR", ahj: "Marion County", track: "permit", discipline: "electrical" }, finding as never,
    { corroborateAgainst: { evidence: [{ url: SRC, via: "http" as const, status: 200, kind: "pdf" as const, bytes: 100, handed: 2 }], corpus: [row + "\n" + surcharge] } } as never);
  const hopped = electricalLine();
  check("(setup) the Marion County schedule is on file and the Jefferson line hops to it: $134.40, not flagged",
    (saved as { saved?: boolean }).saved === true && hopped?.feeUsd === 134.4 && hopped.unresolvedCollector === undefined && Boolean(hopped.delegatedFromScheduleId),
    JSON.stringify({ saved, hopped }));
  const withLine = await fill(12.913);
  check("MUST-EXCLUDE the saved (hopped) line wins: $120.00 / $120.00 / $14.40 / $134.40, not the printed $94.00",
    withLine.fees.t15 === "120.00" && withLine.fees.subtotal === "120.00" && withLine.fees.surcharge === "14.40" && withLine.fees.total === "134.40", show(withLine.fees));
  check("MUST-EXCLUDE and the fill does not claim the printed schedule", !/Fees are the schedule printed on this form/.test(withLine.e.message ?? ""), withLine.e.message);
  const declined = await fill(4);
  check("MUST-EXCLUDE a saved schedule that was evaluated and declined (4 kVA, no bracket) keeps its blank — never the printed $79.00",
    declined.fees.q5 === "1" && allCells(declined.fees).every((v) => v === ""), show(declined.fees));

  assert.equal(failed.length, 0, `${failed.length} check(s) failed: ${failed.join(" | ")}`);
  console.log(`marionE01DelegatedFees: ${passed} checks passed — through the real lookup (applyLookupFees: City of Jefferson -> Marion County, no Marion schedule) the electrical line is flagged unresolvedCollector at both line builders and the E-01 fills its printed ladder (Michael $105.28); a chain of pointers stays blank; a saved Marion County schedule wins ($134.40) and where it declines the cells stay blank`);
} finally {
  globalThis.fetch = realFetch;
  db.close();
  for (const id of filledDirs) fs.rmSync(path.resolve("backend/data/filled", id), { recursive: true, force: true });
  assert.equal(path.dirname(temp), os.tmpdir());
  fs.rmSync(temp, { recursive: true, force: true });
}
