// TYPED REQUIRED UPLOAD CARDS GET THE DOCUMENT THEY NAME (B7).
//
// An AHJ learn runs in "combined" upload mode (one plan-set PDF, the Oregon/Accela rule), and
// resolveUpload put the full plan set into EVERY upload control. EnerGov CSS (Iowa City) shows
// typed REQUIRED cards — "Manufacturer's Product Data/Spec", "Solar Roof Plan/Solar Site Plan",
// "Standard or Micro-Inverter Array" (= the PV worksheet) — and Lee County's DigEplan types
// "Photovoltaic Plans" / "Aerial/Site Plan". The worksheet was never attached (no pattern), and
// the spec card received the plan set.
//
// MUST-PASS  spec card -> module_spec; worksheet card -> pv_worksheet (both modes); roof/site plan
//            card -> plan_set; "Aerial/Site Plan" -> site_plan; "Photovoltaic Plans", Oregon's
//            "Plans - Construction" and a generic "Attachment" -> plan_set (unchanged).
// MUST-EXCLUDE with no spec sheet the spec card is left EMPTY (reported), never the plan set; with no
//            worksheet the worksheet card is left empty, never the plan set or the inverter spec.
//
// Run: npx tsx portal-bot/src/adapters/typedUploadCards.test.ts
import assert from "node:assert/strict";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${e instanceof Error ? e.message : String(e)}`); }
};
const planner: LearnPlanner = async () => ({ fills: [], atReview: false });
const ALL = { plan_set: "C:/nope/plan-set.pdf", module_spec: "C:/nope/module-spec.pdf", inverter_spec: "C:/nope/inverter-spec.pdf", pv_worksheet: "C:/nope/pv-worksheet.pdf", site_plan: "C:/nope/site-plan.pdf" };
const pick = (docs: Record<string, string>, label: string, mode: "combined" | "split" = "combined"): string | null => {
  const a = new AutoLearnAdapter("Typed Cards", planner, { uploadMode: mode, docsByType: docs }) as unknown as { resolveUploadByLabel(l: string, r?: boolean, acc?: string): { docType: string } | null };
  return a.resolveUploadByLabel(label, true, ".pdf,.docx")?.docType ?? null;
};

check("MUST-PASS Iowa spec card -> the spec sheet, not the plan set", () => {
  assert.equal(pick(ALL, "Manufacturer's Product Data/Spec (REQUIRED)"), "module_spec");
  assert.equal(pick({ plan_set: ALL.plan_set, inverter_spec: ALL.inverter_spec }, "Manufacturer's Product Data/Spec"), "inverter_spec");
});
check("MUST-PASS Iowa worksheet card ('Standard or Micro-Inverter Array') -> pv_worksheet, in both modes", () => {
  assert.equal(pick(ALL, "Standard or Micro-Inverter Array (REQUIRED)"), "pv_worksheet");
  assert.equal(pick(ALL, "Standard or Micro-Inverter Array (REQUIRED)", "split"), "pv_worksheet");
  assert.equal(pick(ALL, "PV Worksheet"), "pv_worksheet");
});
check("MUST-PASS roof/site plan card -> the plan set (Iowa: all plan sheets as ONE file)", () => {
  assert.equal(pick(ALL, "Solar Roof Plan/Solar Site Plan (REQUIRED)"), "plan_set");
});
check("MUST-PASS Lee's 'Aerial/Site Plan' -> the site plan; 'Photovoltaic Plans' -> the plan set", () => {
  assert.equal(pick(ALL, "Aerial/Site Plan"), "site_plan");
  assert.equal(pick({ plan_set: ALL.plan_set }, "Aerial/Site Plan"), "plan_set");
  assert.equal(pick(ALL, "Photovoltaic Plans"), "plan_set");
});
check("MUST-PASS unchanged: Oregon 'Plans - Construction' and a generic 'Attachment' take the plan set", () => {
  assert.equal(pick(ALL, "Plans - Construction"), "plan_set");
  assert.equal(pick(ALL, "Attachment"), "plan_set");
});
check("MUST-EXCLUDE no spec sheet: the spec card is left empty (reported), never the plan set", () => {
  assert.equal(pick({ plan_set: ALL.plan_set, site_plan: ALL.site_plan }, "Manufacturer's Product Data/Spec (REQUIRED)"), null);
});
check("MUST-EXCLUDE no worksheet: the worksheet card is left empty, never the plan set or the inverter spec", () => {
  const noWs = { plan_set: ALL.plan_set, inverter_spec: ALL.inverter_spec, module_spec: ALL.module_spec };
  assert.equal(pick(noWs, "Standard or Micro-Inverter Array (REQUIRED)"), null);
  assert.equal(pick(noWs, "Standard or Micro-Inverter Array (REQUIRED)", "split"), null);
});

if (failures) { console.error(`\n${failures} typed-upload-card check(s) FAILED.`); process.exit(1); }
console.log("\nAll typed-upload-card checks passed.");
