// INPUT-ROBUSTNESS PROBE for the AHJ reviewer gate. Not a unit test — a harness that
// runs buildReviewerReport against off-happy-path input and reports what breaks.
// Run: npx tsx backend/test/robustnessProbe.ts
import type { ProjectRecord } from "../../shared/src/types";
import { buildReviewerReport } from "../src/reviewerEngine";

type Delta = Record<string, unknown>;

const base = (): Record<string, unknown> => ({
  id: "probe-1",
  clientId: "client-probe",
  homeownerName: "Probe Owner",
  projectAddress: "1 Service Lane",
  city: "Lincoln City",
  state: "OR",
  zip: "97367",
  ahj: "City of Lincoln City",
  utility: "Pacific Power",
  accountNumber: "1234567890",
  meterNumber: "987654",
  systemSizeDcKw: 9,
  systemSizeAcKw: 7.6,
  interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserConfidenceSummary: "",
  parserSnapshot: {
    state: "OR", ahj: "City of Lincoln City", utility: "Pacific Power",
    mounting: "Roof mount", interco: "Load-side breaker",
    busRating: "200A", mainBreaker: "175A", pvBreaker: "40",
  } as Record<string, unknown>,
});

function make(delta: Delta, snapDelta?: Delta): ProjectRecord {
  const p = base();
  if (snapDelta) {
    if (snapDelta.__replace) p.parserSnapshot = snapDelta.__value;
    else p.parserSnapshot = { ...(p.parserSnapshot as Record<string, unknown>), ...snapDelta };
  }
  for (const [k, v] of Object.entries(delta)) {
    if (v === "__delete") delete p[k];
    else p[k] = v;
  }
  return p as unknown as ProjectRecord;
}

const BAD = /undefined|NaN|\[object Object\]/;

interface Outcome {
  name: string;
  threw: string | null;
  counts: string;
  ids: string[];
  dirty: string[];
}

const results: Outcome[] = [];

function run(name: string, project: ProjectRecord, opts: Parameters<typeof buildReviewerReport>[1] = {}): Outcome {
  let outcome: Outcome = { name, threw: null, counts: "", ids: [], dirty: [] };
  try {
    const report = buildReviewerReport(project, opts);
    const f = report.findings;
    const n = (s: string) => f.filter((x) => x.severity === s).length;
    outcome.counts = `blocker=${n("blocker")} warning=${n("warning")} callout=${n("callout")} total=${f.length}`;
    outcome.ids = f.map((x) => `${x.severity}:${x.id}`);
    for (const item of f) {
      for (const field of ["title", "message", "cityFeedback", "designTeamAction"] as const) {
        const v = String(item[field] ?? "");
        if (BAD.test(v)) outcome.dirty.push(`${item.id}.${field} = ${JSON.stringify(v.slice(0, 220))}`);
      }
      for (const ev of item.evidenceFound ?? []) {
        const v = `${ev.label} | ${ev.excerpt}`;
        if (BAD.test(v)) outcome.dirty.push(`${item.id}.evidence = ${JSON.stringify(v.slice(0, 220))}`);
      }
      for (const en of item.evidenceNeeded ?? []) {
        if (BAD.test(String(en))) outcome.dirty.push(`${item.id}.evidenceNeeded = ${JSON.stringify(String(en).slice(0, 200))}`);
      }
    }
  } catch (err) {
    outcome.threw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  results.push(outcome);
  return outcome;
}

function show(o: Outcome, opts: { ids?: boolean } = {}): void {
  if (o.threw) { console.log(`  THREW  ${o.name}\n         ${o.threw}`); return; }
  console.log(`  ok     ${o.name}  [${o.counts}]`);
  if (opts.ids) for (const i of o.ids) console.log(`           ${i}`);
  for (const d of o.dirty) console.log(`  DIRTY  ${o.name} -> ${d}`);
}

// ---------------------------------------------------------------------------
console.log("\n=== 1. CONTROL (happy path) ===");
show(run("baseline OR roof mount", make({})), { ids: true });

console.log("\n=== 2. MISSING / NULL SNAPSHOT ===");
show(run("parserSnapshot = {}", make({}, { __replace: true, __value: {} })));
show(run("parserSnapshot = null", make({}, { __replace: true, __value: null })));
show(run("parserSnapshot deleted", make({ parserSnapshot: "__delete" })));

console.log("\n=== 3. MISSING / NULL TOP-LEVEL FIELDS ===");
for (const key of ["state", "ahj", "utility", "interconnectionMethod", "homeownerName",
                   "projectAddress", "accountNumber", "meterNumber", "systemSizeDcKw",
                   "systemSizeAcKw", "id", "clientId", "parserConfidenceSummary", "city", "zip"]) {
  show(run(`${key} = undefined (deleted)`, make({ [key]: "__delete" })));
}
console.log("  -- same fields as explicit null --");
for (const key of ["state", "ahj", "utility", "interconnectionMethod", "accountNumber",
                   "meterNumber", "systemSizeDcKw", "parserConfidenceSummary"]) {
  show(run(`${key} = null`, make({ [key]: null })));
}

console.log("\n=== 4. WRONG PRIMITIVE TYPES ON TOP-LEVEL FIELDS ===");
show(run("state = 41 (number)", make({ state: 41 })));
show(run("accountNumber = 1234567890 (number)", make({ accountNumber: 1234567890 })));
show(run("meterNumber = 987654 (number)", make({ meterNumber: 987654 })));
show(run("utility = 12 (number)", make({ utility: 12 })));
show(run("ahj = {name:'x'} (object)", make({ ahj: { name: "x" } })));
show(run("interconnectionMethod = ['load-side'] (array)", make({ interconnectionMethod: ["load-side"] })));
show(run("systemSizeDcKw = '9.5' (numeric string)", make({ systemSizeDcKw: "9.5" }, { moduleQty: "20", moduleWattage: "400" })));
show(run("systemSizeDcKw = '9.5 kW' (unit string)", make({ systemSizeDcKw: "9.5 kW" }, { moduleQty: "20", moduleWattage: "400" })));
show(run("systemSizeDcKw = 9.5 number, qty/watt mismatch", make({ systemSizeDcKw: 9.5 }, { moduleQty: "20", moduleWattage: "400" })));

console.log("\n=== 5. NUMERIC SNAPSHOT FIELDS AS STRINGS WITH UNITS ===");
show(run("busRating/main/pv with units", make({}, { busRating: "200A", mainBreaker: "200A", pvBreaker: "50A" })));
show(run("rafterSpacing '24 in o.c.', span '12 ft'", make({}, { roofRafterSpacing: "24 in o.c.", roofRafterSpan: "12 ft" })));
show(run("snow '25 psf' deadLoad '3 psf' wind 'Exp B'", make({}, { snow: "25 psf", deadLoad: "3 psf", wind: "Exposure B" })));

console.log("\n=== 6. NUMERIC SNAPSHOT FIELDS AS NUMBERS ===");
show(run("busRating/main/pv as numbers", make({}, { busRating: 200, mainBreaker: 200, pvBreaker: 50 })));
show(run("moduleQty/Wattage as numbers", make({ systemSizeDcKw: 8 }, { moduleQty: 20, moduleWattage: 400 })));

console.log("\n=== 7. ABSURD NUMERIC VALUES ===");
show(run("bus=0 main=200 pv=50", make({}, { busRating: "0", mainBreaker: "200", pvBreaker: "50" })));
show(run("bus=-200 main=200 pv=50", make({}, { busRating: "-200", mainBreaker: "200", pvBreaker: "50" })));
show(run("bus=200 main=-200 pv=-50", make({}, { busRating: "200", mainBreaker: "-200", pvBreaker: "-50" })));
show(run("bus=999999 main=999999 pv=999999", make({}, { busRating: "999999", mainBreaker: "999999", pvBreaker: "999999" })));
show(run("systemSizeDcKw = -5", make({ systemSizeDcKw: -5 })));
show(run("systemSizeDcKw = 0", make({ systemSizeDcKw: 0 })));
show(run("systemSizeDcKw = 999999", make({ systemSizeDcKw: 999999 })));
show(run("moduleQty=999999 wattage=999999 dc=9", make({ systemSizeDcKw: 9 }, { moduleQty: "999999", moduleWattage: "999999" })));
show(run("systemSizeDcKw = NaN", make({ systemSizeDcKw: Number.NaN }, { moduleQty: "20", moduleWattage: "400" })));
show(run("systemSizeDcKw = Infinity", make({ systemSizeDcKw: Number.POSITIVE_INFINITY }, { moduleQty: "20", moduleWattage: "400" })));

console.log("\n=== 8. SNAPSHOT VALUES OF WRONG SHAPE ===");
show(run("interco = {} (object)", make({ interconnectionMethod: "" }, { interco: { side: "load" } })));
show(run("reviewFlags = ['a','b'] (array)", make({}, { reviewFlags: ["flagA", "flagB"] })));
show(run("splitPagesText = {a:1} (object)", make({}, { splitPagesText: { a: 1 } })));
show(run("busRating = {} (object)", make({}, { busRating: {}, mainBreaker: {}, pvBreaker: {} })));
show(run("permitPath = ['engineered']", make({}, { permitPath: ["engineered"] })));
show(run("framingType = 42", make({}, { framingType: 42 })));

console.log("\n=== 9. PROJECT TYPES ===");
const fullText = "SLD one-line, site plan, roof plan, fire pathway setback ridge, rafter framing span table, "
  + "attachment lag flashing racking rail, rapid shutdown RSD 690.12, label placard directory 705.10, "
  + "705.12 busbar 120 percent calculation, module spec UL 61730, inverter spec UL 1741";
show(run("battery/ESS project", make({}, {
  planSetExtractedText: fullText, batteryModel: "Powerwall 3", batteryQty: "2", batteryMake: "Tesla",
})), { ids: true });
show(run("battery + the word 'address' in design text", make({}, {
  planSetExtractedText: `${fullText}. Service address 1 Service Lane.`,
  batteryModel: "Powerwall 3", batteryQty: "2", batteryMake: "Tesla",
})), { ids: true });
show(run("ground mount", make({ interconnectionMethod: "Ground mount, load-side breaker" }, { mounting: "Ground mount", interco: "Ground mount, load-side breaker" })), { ids: true });
show(run("MPU project", make({}, { projectDescriptionText: "Includes main panel upgrade to 200A" })));
show(run("no state (empty string)", make({ state: "" }, { state: "" })));
show(run("FL project", make({ state: "FL", ahj: "City of Orlando", utility: "Duke Energy" }, { state: "FL", ahj: "City of Orlando" })), { ids: true });
show(run("OH project", make({ state: "OH", ahj: "City of Columbus", utility: "AEP Ohio" }, { state: "OH", ahj: "City of Columbus" })));

console.log("\n=== 10. DOCUMENTS ===");
show(run("no documents", make({}), { uploadedDocTypes: [] }));
const everyDoc = ["plan_set", "combined_plan_set", "full_plan_set", "utility_package_zip", "sld", "site_plan",
  "structural_letter", "stamped_plans", "engineering_letter", "module_spec", "inverter_spec", "utility_bill",
  "meter_photo", "permit_application", "structural"];
show(run("every document type", make({}), { uploadedDocTypes: everyDoc }), { ids: true });
show(run("every doc + prescriptive path (no span data)", make({}, { permitPath: "prescriptive" }), { uploadedDocTypes: everyDoc }));
show(run("stamped_plans only, prescriptive, no span data", make({}, { permitPath: "prescriptive" }), { uploadedDocTypes: ["stamped_plans"] }));
show(run("uploadedDocTypes = [null, undefined, 42]", make({}), { uploadedDocTypes: [null, undefined, 42] as unknown as string[] }));

console.log("\n=== 11. UNICODE AND VERY LONG STRINGS ===");
show(run("unicode homeowner/ahj", make({ homeownerName: "Zoë Müller 田中さん 🏠", ahj: "Cité de Montréal ☀️", projectAddress: "1 Rüe ÉLÉCTRIQUE ✓" })));
show(run("unicode in snapshot text", make({}, { planSetExtractedText: "SLD ☀ roof plan — fire pathway ≥ 36″ · rafter 2×4 @ 24″ o.c." })));
const long = "SLD ".repeat(50000);
const t0 = Date.now();
show(run("200k-char planSetExtractedText", make({}, { planSetExtractedText: long })));
console.log(`         (elapsed ${Date.now() - t0}ms)`);
const longInterco = `load-side ${"x".repeat(50000)}`;
const t1 = Date.now();
show(run("50k-char interconnectionMethod", make({ interconnectionMethod: longInterco }, { interco: longInterco })));
console.log(`         (elapsed ${Date.now() - t1}ms)`);
show(run("control chars / newlines in fields", make({ homeownerName: "A\u0000B\nC\tD", ahj: "X\r\nY" })));

console.log("\n=== SUMMARY ===");
const threw = results.filter((r) => r.threw);
const dirty = results.filter((r) => !r.threw && r.dirty.length);
console.log(`scenarios=${results.length}  threw=${threw.length}  dirty-message=${dirty.length}  clean=${results.length - threw.length - dirty.length}`);
for (const r of threw) console.log(`  THREW: ${r.name} :: ${r.threw}`);
for (const r of dirty) console.log(`  DIRTY: ${r.name} :: ${r.dirty.join(" ;; ")}`);
