// THE PARSER PAGE'S SPLIT MAP USES THE SAME SPEC-SHEET RULE AS THE BACKEND SPLITTER (#90).
//
// parser.html's split map matched a bare /INVERTER SPECIFICATION/ (and /MODULE SPECIFICATION/),
// so a WIRING CALCULATIONS sheet — whose body tabulates "INVERTER SPECIFICATIONS" and
// "PV MODULE SPECIFICATIONS" — was mapped as the inverter (and module) spec. The submit gate
// (requiredDocuments.sheetInPlanSet) reads that map's text as a presence fallback, so it said
// "in plan set" for a spec sheet docSplitter (#66, #77) reports missing or undecided.
//
// The rule now lives in frontend/parser-review.js (loaded here through node:vm, exactly as
// the browser sees it), and the gate treats an "undecided" line — and a spec line from a
// snapshot written before this rule — as not present. Synthetic text only.
// Run: tsx backend/test/parserReviewSplitMap.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { REPO } from "./_isolate";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "parser-split-map-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "test.db");

const src = fs.readFileSync(path.join(REPO, "frontend", "parser-review.js"), "utf8");
const sandbox: { window: Record<string, unknown> } = { window: {} };
vm.runInNewContext(src, sandbox, { filename: "parser-review.js" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PR = sandbox.window.ParserReview as any;

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`ok   - ${name}`);
  else { failures++; console.log(`FAIL - ${name}${detail ? ` :: ${detail}` : ""}`); }
};
// Values cross the vm realm boundary (different Array prototype), so compare by shape.
const json = (v: unknown) => JSON.stringify(v);

// Title-block text as the PDF text layer joins it (sheet name, then the next label).
const CALCS = "DS 3.0 Sheet Name WIRING CALCULATIONS Sheet Number DS 3.0 INVERTER SPECIFICATIONS MAX AC OUTPUT 384 VA PV MODULE SPECIFICATIONS VOC 37.1 MICROINVERTER QTY 18";
const ELEC_CALCS = "DS 3.1 Sheet Name ELECTRICAL CALCULATIONS INVERTER SPECIFICATIONS 240V";
const MICRO = "DS 2.0 Sheet Name MICROINVERTER SPECIFICATION SHEET Sheet Number DS 2.0";
const INV = "DS 2.1 Sheet Name INVERTER SPECIFICATION SHEET Sheet Number DS 2.1";
const MODULE = "DS 1.0 Sheet Name PV MODULE SPECIFICATION SHEET Sheet Number DS 1.0";
const EQUIP = "DS 4.0 Sheet Name EQUIPMENT SPECIFICATION Sheet Number DS 4.0";

console.log("1. THE SPLIT MAP'S SPEC RULE (frontend/parser-review.js)");
check("1a. parser-review.js exposes specSheetPages", typeof PR?.specSheetPages === "function");
if (typeof PR?.specSheetPages === "function") {
  const calcsOnly = PR.specSheetPages([{ page: 7, text: CALCS }, { page: 8, text: ELEC_CALCS }]);
  check("1b. THE POINT: a WIRING / ELECTRICAL CALCULATIONS sheet is not the inverter spec",
    json(calcsOnly.inverterSpecs) === "[]", json(calcsOnly));
  check("1c. …nor the module spec", json(calcsOnly.moduleSpecs) === "[]", json(calcsOnly));
  check("1d. …nor undecided (it is known not to be a spec sheet)", json(calcsOnly.undecidedSpecs) === "[]", json(calcsOnly));

  const named = PR.specSheetPages([{ page: 5, text: MICRO }, { page: 7, text: CALCS }]);
  check("1e. a named MICROINVERTER SPECIFICATION SHEET still is the inverter spec (calcs excluded)",
    json(named.inverterSpecs) === "[5]", json(named));
  const inv = PR.specSheetPages([{ page: 6, text: INV }]);
  check("1f. a named INVERTER SPECIFICATION SHEET still is the inverter spec", json(inv.inverterSpecs) === "[6]", json(inv));
  const mod = PR.specSheetPages([{ page: 4, text: MODULE }]);
  check("1g. a named PV MODULE SPECIFICATION SHEET is the module spec", json(mod.moduleSpecs) === "[4]", json(mod));

  const equip = PR.specSheetPages([{ page: 11, text: EQUIP }, { page: 12, text: EQUIP }]);
  check("1h. a title-only EQUIPMENT SPECIFICATION page is undecided, not module spec",
    json(equip.moduleSpecs) === "[]" && json(equip.inverterSpecs) === "[]" && json(equip.undecidedSpecs) === "[11,12]", json(equip));

  check("1i. specMapValue: pages → list, none + undecided → undecided, none → missing",
    PR.specMapValue([4, 5], [11]) === "4, 5"
      && /^undecided\b/.test(PR.specMapValue([], [11, 12])) && /11, 12/.test(PR.specMapValue([], [11, 12]))
      && PR.specMapValue([], []) === "missing",
    json([PR.specMapValue([4, 5], [11]), PR.specMapValue([], [11, 12]), PR.specMapValue([], [])]));
  check("1j. isCalcsSheet is the backend's CALCS_SHEET",
    PR.isCalcsSheet(CALCS) && PR.isCalcsSheet("WIRE CALCS") && PR.isCalcsSheet(ELEC_CALCS) && !PR.isCalcsSheet(MICRO));

  // #149: a dense SLD whose callout cites "INVERTER SPECIFICATIONS" and says MICROINVERTER. The
  // splitter files it as sld on its own sheet name (docSplitter.ts classifyPage, #119); the bare
  // /MICROINVERTER/ and /INVERTER SPECIFICATION/ mapped it as the inverter spec here.
  const SLD = "DS 5.0 Sheet Name ELECTRICAL LINE DIAGRAM Sheet Number DS 5.0 INVERTER SPECIFICATIONS MAX AC OUTPUT 384 VA (18) MICROINVERTER Q.MI DS3 Series";
  const MICROS = "DS 2.2 Sheet Name MICROINVERTER SPECIFICATIONS Sheet Number DS 2.2";
  const sld = PR.specSheetPages([{ page: 9, text: SLD }]);
  check("1m. THE POINT (#149): a dense SLD citing INVERTER SPECIFICATIONS is not the inverter spec",
    json(sld.inverterSpecs) === "[]" && json(sld.moduleSpecs) === "[]", json(sld));
  check("1n. …nor undecided (it won the SLD on its own sheet name)", json(sld.undecidedSpecs) === "[]", json(sld));
  const withSld = PR.specSheetPages([{ page: 5, text: MICRO }, { page: 9, text: SLD }, { page: 10, text: MICROS }, { page: 11, text: EQUIP }]);
  check("1o. beside the SLD, named MICROINVERTER SPECIFICATION SHEET / SPECIFICATIONS pages still are the inverter spec",
    json(withSld.inverterSpecs) === "[5,10]", json(withSld));
  check("1p. …and a title-only EQUIPMENT SPECIFICATION page is still undecided", json(withSld.undecidedSpecs) === "[11]", json(withSld));
  const modelOnly = PR.specSheetPages([{ page: 3, text: "DS 3.5 Q.TRON AC Q.MI MICROINVERTER DS3 Series datasheet" }]);
  check("1q. model strings alone (no spec sheet name) do not make a spec page",
    json(modelOnly.inverterSpecs) === "[]" && json(modelOnly.moduleSpecs) === "[]", json(modelOnly));

  // #193: the inverter pages were copied into an empty module side (and vice versa). The splitter
  // has no such fallback, so the gate said "in plan set" for a module spec it reports missing.
  const microOnly = PR.specSheetPages([{ page: 5, text: MICRO }, { page: 9, text: SLD }]);
  check("1r. THE POINT (#193): only a MICROINVERTER SPECIFICATION SHEET → module spec missing",
    json(microOnly.moduleSpecs) === "[]" && PR.specMapValue(microOnly.moduleSpecs, microOnly.undecidedSpecs) === "missing"
      && json(microOnly.inverterSpecs) === "[5]", json(microOnly));
  check("1s. …and only a module spec sheet → inverter spec missing", json(mod.inverterSpecs) === "[]", json(mod));
}

// The page must actually use the shared rule, and bust the browser cache for it.
const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8");
check("1k. parser.html builds the spec rows from ParserReview.specSheetPages", /ParserReview\.specSheetPages\(/.test(html));
check("1l. parser.html no longer carries the bare /INVERTER SPECIFICATION/i split pattern",
  !/^\s*\/INVERTER SPECIFICATION\/i,?\s*$/m.test(html));

console.log("\n2. THE GATE (requiredDocuments.sheetInPlanSet) READS THE MAP");
{
  const { sheetInPlanSet } = await import("../src/requiredDocuments");
  const marker = String(PR?.SPEC_MAP_RULE ?? "");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const project = (splitPagesText: string) => ({ parserSnapshot: { splitPagesText } }) as any;
  const docs = { plan_set: "/tmp/synthetic-plan.pdf" };
  const map = (module: string, inverter: string, withMarker = true) =>
    ["01 SLD / 3-line: 5", "02 Site + plot plan: 2, 3", `03 Module specs: ${module}`, `04 Inverter specs: ${inverter}`, ...(withMarker ? [marker] : [])].join("\n");

  check("2a. the map carries a rule marker", marker.length > 0);
  check("2b. a mapped inverter spec page counts as in plan set", sheetInPlanSet(project(map("4", "5")), "inverter_spec", docs));
  check("2c. THE POINT: an undecided module-spec line is not in plan set",
    !sheetInPlanSet(project(map(PR.specMapValue?.([], [11, 12]) ?? "undecided (pages 11, 12)", "5")), "module_spec", docs));
  check("2d. an undecided inverter-spec line is not in plan set",
    !sheetInPlanSet(project(map("4", "undecided (pages 11, 12)")), "inverter_spec", docs));
  check("2e. a missing line is not in plan set", !sheetInPlanSet(project(map("4", "missing")), "inverter_spec", docs));
  // Decision (#90 AC 3): a spec line from a snapshot written BEFORE this rule may be the calcs
  // sheet and nothing says otherwise, so it is not trusted; a re-parse rewrites the map.
  check("2f. a pre-#90 snapshot's spec line (no marker) is not trusted",
    !sheetInPlanSet(project(map("4", "7", false)), "inverter_spec", docs) && !sheetInPlanSet(project(map("7", "7", false)), "module_spec", docs));
  check("2g. …but its non-spec lines still count (site plan, SLD)",
    sheetInPlanSet(project(map("4", "7", false)), "site_plan", docs) && sheetInPlanSet(project(map("4", "7", false)), "sld", docs));
  check("2h. no plan-set file → never in plan set", !sheetInPlanSet(project(map("4", "5")), "inverter_spec", {}));
}

// #67: the page's copy of the splitter's categories files the PLACARD (directory plaque) sheet as
// labels, like docSplitter.ts — the same synthetic sheets as docSplitterPlacard.test.ts.
console.log("\n3. THE SPLIT MAP'S LABELS RULE (#67)");
check("3a. parser-review.js exposes scoreSplitPage", typeof PR?.scoreSplitPage === "function");
if (typeof PR?.scoreSplitPage === "function") {
  const cat = (text: string) => json(PR.scoreSplitPage(text).docTypes);
  const LABELS = "PV-8 Sheet Name LABELS WARNING LABELS LABEL LOCATION: MAIN SERVICE PANEL";
  const PLACARD = "PV-9 Sheet Name PLACARD LABELING NOTES DIRECTORY PERMANENT PLAQUE OR DIRECTORY PROVIDING THE LOCATION OF THE SERVICE DISCONNECTING MEANS PER NEC 690.56(B) AND 705.10";
  const COVER = "PV-0 Sheet Name COVER SHEET SHEET INDEX: PV-1 SITE PLAN, PV-4 ONE-LINE DIAGRAM, PV-8 LABELS, PV-9 PLACARD";
  const SITE = "PV-1 Sheet Name SITE PLAN NOTE: PROVIDE PLACARD AT MAIN SERVICE PER NEC 705.10";
  const SLD1 = "PV-4 Sheet Name ONE-LINE DIAGRAM PLACARD NOTE: PERMANENT PLAQUE OR DIRECTORY PER NEC 690.56";
  const NOTES = "E 1.2 Sheet Name NOTES 1. PROVIDE PLACARD AT POINT OF INTERCONNECTION PER NEC 705.10.";
  check("3b. THE POINT: a PLACARD sheet with a DIRECTORY … PLAQUE body is labels", cat(PLACARD) === '["labels"]', cat(PLACARD));
  check("3c. the LABELS sheet is labels", cat(LABELS) === '["labels"]', cat(LABELS));
  check("3d. the sheet-index cover listing PV-9 PLACARD is unclassified", cat(COVER) === "[]", cat(COVER));
  check("3e. a site plan whose notes mention a placard stays the site plan", cat(SITE) === '["site_plan"]', cat(SITE));
  check("3f. an SLD whose notes mention a placard stays the SLD", cat(SLD1) === '["sld"]', cat(SLD1));
  check("3g. an E 1.2 NOTES sheet that says PROVIDE PLACARD is unclassified", cat(NOTES) === "[]", cat(NOTES));
  const PV_NOTES = "PV-2 Sheet Name GENERAL NOTES 1. PROVIDE PLACARD PER NEC 705.10";
  const E_NOTES = "E-2 Sheet Name NOTES PROVIDE PLACARD AT MAIN SERVICE";
  check("3h. a PV-2 GENERAL NOTES sheet that says PROVIDE PLACARD is unclassified", cat(PV_NOTES) === "[]", cat(PV_NOTES));
  check("3i. an E-2 NOTES sheet (no decimal) that says PROVIDE PLACARD is unclassified", cat(E_NOTES) === "[]", cat(E_NOTES));
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall parser split-map checks passed");
