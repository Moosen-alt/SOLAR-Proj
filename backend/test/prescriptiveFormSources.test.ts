// Prescriptive-checklist form-fill bridge: computed.presc<Key>Yes/No/Answer
// sources answer an AHJ checklist's Yes/No checkboxes straight from the parsed
// structural data (same evaluator as the generated Markdown checklist), and a
// real AcroForm checkbox fill proves the end-to-end behavior: Yes rows tick the
// Yes box only, No rows tick the No box only, unverified rows tick NOTHING.
// Run: tsx backend/test/prescriptiveFormSources.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { checkboxRuleChecked, fillLoadedForm, resolveSource, type AhjFormDefinition, type FillContext } from "../src/ahjForms";
import { AVAILABLE_FIELD_SOURCES } from "../src/ahjFormAuto";
import { prescriptiveCriterionCatalog } from "../src/permitPath";
import type { ProjectRecord } from "../../shared/src/types";

let passed = 0;
const ok = (n: string) => { passed++; console.log(`ok   ${n}`); };

const ctxOf = (snapshot: Record<string, unknown>): FillContext =>
  ({ project: { parserSnapshot: snapshot } as unknown as ProjectRecord, client: {}, snapshot });

const PASSING = {
  mounting: "Roof Mount", lightFrame: "yes", riskCategory: "II", snow: 25,
  wind: "C", windSpeed: 110, roofRafterSpacing: 24, deadLoad: 3.2,
  moduleHeightAboveRoof: 6, roofLayers: 1,
};
const FAILING = {
  mounting: "Ground Mount", lightFrame: "no", riskCategory: "III", snow: 90,
  wind: "D", windSpeed: 150, roofRafterSpacing: 32, deadLoad: 6,
  moduleHeightAboveRoof: 24, roofLayers: 3,
};

// 1) A passing project: every Yes-mark draws "X", every No-mark stays blank,
//    Answer reads "Yes" — for EVERY criterion in the catalog.
{
  const ctx = ctxOf(PASSING);
  for (const { key } of prescriptiveCriterionCatalog()) {
    const cap = key.charAt(0).toUpperCase() + key.slice(1);
    assert.equal(resolveSource(`computed.presc${cap}Yes`, ctx), "X", `presc${cap}Yes should mark on a passing project`);
    assert.equal(resolveSource(`computed.presc${cap}No`, ctx), "", `presc${cap}No should stay blank on a passing project`);
    assert.equal(resolveSource(`computed.presc${cap}Answer`, ctx), "Yes");
  }
  assert.equal(resolveSource("computed.prescAllYes", ctx), "X");
  assert.equal(resolveSource("computed.prescAllNo", ctx), "");
  assert.equal(resolveSource("computed.prescAllAnswer", ctx), "Yes");
  ok("passing project: Yes-marks X, No-marks blank, overall Yes");
}

// 2) A failing project: inverse — and the overall screen answers No.
{
  const ctx = ctxOf(FAILING);
  for (const { key } of prescriptiveCriterionCatalog()) {
    const cap = key.charAt(0).toUpperCase() + key.slice(1);
    assert.equal(resolveSource(`computed.presc${cap}Yes`, ctx), "", `presc${cap}Yes should stay blank on a failing project`);
    assert.equal(resolveSource(`computed.presc${cap}No`, ctx), "X", `presc${cap}No should mark on a failing project`);
    assert.equal(resolveSource(`computed.presc${cap}Answer`, ctx), "No");
  }
  assert.equal(resolveSource("computed.prescAllYes", ctx), "");
  assert.equal(resolveSource("computed.prescAllNo", ctx), "X");
  assert.equal(resolveSource("computed.prescAllAnswer", ctx), "No");
  ok("failing project: No-marks X, Yes-marks blank, overall No");
}

// 3) SAFETY: an unparsed project answers [verify] → every variant resolves "",
//    so no checkbox is ever ticked and no Yes/No is ever written on unverified
//    data. This is the guarantee that lets the fill run before human review.
{
  const ctx = ctxOf({});
  for (const { key } of prescriptiveCriterionCatalog()) {
    const cap = key.charAt(0).toUpperCase() + key.slice(1);
    assert.equal(resolveSource(`computed.presc${cap}Yes`, ctx), "");
    assert.equal(resolveSource(`computed.presc${cap}No`, ctx), "");
    assert.equal(resolveSource(`computed.presc${cap}Answer`, ctx), "");
  }
  assert.equal(resolveSource("computed.prescAllYes", ctx), "");
  assert.equal(resolveSource("computed.prescAllNo", ctx), "");
  assert.equal(resolveSource("computed.prescAllAnswer", ctx), "");
  ok("unparsed project: every variant blank — nothing attested without data");
}

// 4) Mixed: one No among Yeses → overall is No (any definitive failure fails
//    the screen); one [verify] among Yeses → overall is blank, not Yes.
{
  const oneNo = ctxOf({ ...PASSING, snow: 90 });
  assert.equal(resolveSource("computed.prescSnowLoadNo", oneNo), "X");
  assert.equal(resolveSource("computed.prescAllYes", oneNo), "");
  assert.equal(resolveSource("computed.prescAllNo", oneNo), "X");
  const oneUnknown = ctxOf({ ...PASSING, snow: undefined });
  assert.equal(resolveSource("computed.prescAllYes", oneUnknown), "");
  assert.equal(resolveSource("computed.prescAllNo", oneUnknown), "");
  ok("overall screen: any No fails it; any [verify] withholds it");
}

// 5) Every presc source offered to the LLM mapper resolves through the bridge
//    (catches drift between AVAILABLE_FIELD_SOURCES and prescriptiveComputed).
{
  const ctx = ctxOf(PASSING);
  const prescSources = AVAILABLE_FIELD_SOURCES
    .map((s) => s.split(/\s{2,}/)[0].trim())
    .filter((s) => s.startsWith("computed.presc"));
  assert.ok(prescSources.length >= 33, `expected >= 33 presc sources, got ${prescSources.length}`);
  for (const src of prescSources) {
    const v = resolveSource(src, ctx);
    assert.ok(v === "X" || v === "Yes" || v === "", `${src} resolved to unexpected "${v}"`);
    // On a fully-passing project every Yes/Answer variant must be affirmative.
    if (/Yes$/.test(src)) assert.equal(v, "X", `${src} should resolve "X" on a passing project`);
    if (/Answer$/.test(src)) assert.equal(v, "Yes", `${src} should resolve "Yes" on a passing project`);
  }
  ok("every mapper-offered presc source resolves (no key drift)");
}

// 5b) SAFETY: `equals: ""` must behave as truthy-check, never as `=== ""` —
//     otherwise a box would be ticked exactly when the data is unverified.
{
  assert.equal(checkboxRuleChecked({ source: "computed.prescSnowLoadYes", equals: "" }, ""), false, 'equals:"" + unverified "" must NOT tick');
  assert.equal(checkboxRuleChecked({ source: "computed.prescSnowLoadYes", equals: "" }, "X"), true, 'equals:"" degrades to truthy-check');
  assert.equal(checkboxRuleChecked({ source: "snapshot.hasExistingSystem", equals: "Yes" }, "Yes"), true);
  assert.equal(checkboxRuleChecked({ source: "snapshot.hasExistingSystem", equals: "Yes" }, ""), false);
  assert.equal(checkboxRuleChecked({ source: "computed.prescSnowLoadYes" }, ""), false);
  ok('checkbox equals:"" can never tick a box on unverified (empty) data');
}

// 6) End-to-end AcroForm fill: a checklist PDF with Yes/No checkbox pairs mapped
//    the way the LLM mapper is instructed to — Yes box ← presc*Yes, No box ←
//    presc*No — ticks exactly the right boxes for a mixed project.
async function acroformEndToEnd(): Promise<void> {
  const doc = await PDFDocument.create();
  const pg = doc.addPage([612, 792]);
  const form = doc.getForm();
  const mk = (name: string, y: number) => {
    const cb = form.createCheckBox(name);
    cb.addToPage(pg, { x: 500, y, width: 12, height: 12 });
  };
  mk("snow_yes", 700); mk("snow_no", 700 - 16);
  mk("wind_yes", 650); mk("wind_no", 650 - 16);
  mk("spacing_yes", 600); mk("spacing_no", 600 - 16);
  const bytes = await doc.save();

  const def: AhjFormDefinition = {
    id: "tmpl-checklist", formName: "Prescriptive Solar Checklist", matchJurisdictions: [],
    sourceUrl: "", version: "stored", status: "verified", fillMode: "acroform",
    textFields: {},
    checkboxes: {
      snow_yes: { source: "computed.prescSnowLoadYes" },
      snow_no: { source: "computed.prescSnowLoadNo" },
      wind_yes: { source: "computed.prescWindExposureYes" },
      wind_no: { source: "computed.prescWindExposureNo" },
      spacing_yes: { source: "computed.prescRafterSpacingYes" },
      spacing_no: { source: "computed.prescRafterSpacingNo" },
    },
  };

  // snow passes (25 <= 70), wind fails (D), rafter spacing unparsed → verify.
  const ctx = ctxOf({ snow: 25, wind: "D" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "presc-fill-"));
  const out = path.join(dir, "filled.pdf");
  const res = await fillLoadedForm(def, bytes, ctx, out);
  assert.equal(res.status, "filled");
  assert.equal(res.filledFieldCount, 6, "all six checkbox rules should bind to real fields");
  assert.deepEqual(res.unmappedRequested, [], "no checkbox rule should miss its field");

  // The output is flattened (checkbox widgets are baked into the page), so the
  // checked/unchecked decision is asserted at the rule layer: the exact source
  // strings the map binds, resolved through the same path the filler used.
  const val = (src: string): string => resolveSource(src, ctx);
  assert.equal(val("computed.prescSnowLoadYes"), "X");
  assert.equal(val("computed.prescSnowLoadNo"), "");
  assert.equal(val("computed.prescWindExposureYes"), "");
  assert.equal(val("computed.prescWindExposureNo"), "X");
  assert.equal(val("computed.prescRafterSpacingYes"), "");
  assert.equal(val("computed.prescRafterSpacingNo"), "");
  assert.ok(fs.statSync(out).size > 500, "filled PDF written");
  fs.rmSync(dir, { recursive: true, force: true });
  ok("acroform checklist fill: Yes/No pairs tick exactly the right boxes");
}

acroformEndToEnd()
  .then(() => console.log(`\nprescriptiveFormSources: all ${passed} checks passed`))
  .catch((e) => { console.error(e); process.exit(1); });
