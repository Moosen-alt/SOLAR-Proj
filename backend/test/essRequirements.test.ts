// BATTERY / ESS DRIVES THE REQUIRED SET AND THE PERMIT CARD (issue #246). A storage job owes the ESS
// spec sheet (UL 9540) and an ESS installation detail (NEC 706 / IRC R328), and its permit card says
// whether the AHJ wants a fire review or a separate ESS permit — from the cited per-job lookup or the
// seeded notes, or "not on file, verify". Never a new track. Gated on batteryStatus() === "yes": a
// no-battery job and an unknown one are unchanged. FICTIONAL jurisdictions on two permit platforms
// (an Accela-shaped and an EnerGov-shaped portal); no real AHJ anywhere.
//
// KILL TESTS (each verified red by hand with the change removed):
//   K1 requiredDocuments: drop the essDocumentRows() push           → (d1) (d2) fail.
//   K2 essRequirements: gate on batteryStatus() !== "no"             → (x2) fails.
//   K3 submittalTracks: drop the essStep spread                      → (c1)-(c4) and (c6) fail.
//   K4 normalize.ts: derive hasBattery from a placeholder model again → (x3) fails; so does
//      batteryStatus reading any non-empty model as evidence again → (x3) (x4) fail.
//   K7 portalRecipes: energySource back to its own model test           → (x4) fails.
//   K8 ahjForms / iowaPvWorksheet: the raw battery test again             → (x4) fails;
//      electricalSizing.essOnBus the same → essBusbar.test "placeholder battery model" fails.
//   K9 portalRecipes: energySource honours a bare hasBattery "No" again   → (x5) fails.
//   K5 essRequirements: a fire-only cite counts as "cited"             → (c7) fails.
//   K6 dashboard.js: drop the listed-above filter                      → (r1) fails.
//
// Run: npx tsx backend/test/essRequirements.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ess-requirements-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.ANTHROPIC_API_KEY = "";
process.env.PERMIT_PROCESS_LOOKUP = "off";

const profile = (o: Record<string, unknown>) => ({
  state: "CO", ahj: "", submissionMethod: "", timeline: "", requiresElectricianSign: false, requiresElectricalStamp: false,
  requiresStructuralStamp: false, requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false,
  requiresSolarChecklist: false, requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false,
  requiresFloodplainCheck: false, requiresJurisdictionCheck: false, otherRequirements: "", reviewerNotes: "", sourceSheet: "(test) CO", ...o,
});
const REFERENCE = path.join(tmp, "reference-ahj-processes.json");
fs.writeFileSync(REFERENCE, JSON.stringify({ profiles: [
  profile({ ahj: "Juniper Flats", submissionMethod: "Portal", reviewerNotes: "Upload the plan set. Battery jobs go to the fire department for review. ESS clearances per NEC 706.10 apply." }),
  profile({ ahj: "Sagebrush", submissionMethod: "Portal", reviewerNotes: "Upload the plan set and the spec sheets." }),
] }));
process.env.AHJ_PROCESS_REFERENCE_PATH = REFERENCE;

const { openDatabase } = await import("../src/db");
const db = await openDatabase();
const tracks = await import("../src/submittalTracks");
const permitProcess = await import("../src/permitProcess");
const rd = await import("../src/requiredDocuments");
const { createClient } = await import("../src/clients");
const repo = await import("../src/repository");
const { resolveRecipeFieldValues } = await import("../src/portalRecipes");
const { batteryStatus } = await import("../src/batteryServiceFeeder");
const { resolveSource } = await import("../src/ahjForms");
const { iowaPvWorksheetValues } = await import("../src/iowaPvWorksheet");
const { createProject } = repo;

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
let seq = 0;
const BATTERY = { hasBattery: "Yes", batteryMake: "Examplecell", batteryModel: "EX-13", batteryQty: "1" };
const NO_BATTERY = { hasBattery: "No" };
const project = (o: Record<string, unknown>) => ({
  id: `p-${++seq}`, clientId: null, state: "CO", ahj: "", city: "", utility: "Example Mountain Electric", homeownerName: "Test Owner",
  projectAddress: "1 Test Way", zip: "80000", systemSizeDcKw: 6, systemSizeAcKw: 5, parserSnapshot: {}, status: "parsed", ...o,
}) as never;
const cited = <T>(value: T, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const none = (why = "not searched") => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });
const lookup = (ahj: string, o: Record<string, unknown> = {}) => permitProcess.savePermitProcessLookup(db, {
  state: "CO", ahj, lookedUpAt: new Date().toISOString(), issuingAgency: none(), permitStructure: none(), permits: [], ...o,
} as never);
const permit = (discipline: string, label: string, portalUrl: string, platform: string, extra: Record<string, unknown> = {}) => ({
  discipline, label, issuingAgency: none(), portalUrl: cited(portalUrl, portalUrl, `Apply online for the ${label} in our permit portal`),
  recordType: none(), documents: none(), fee: none(), portalPlatform: platform, ...extra,
});
const docTypes = (p: never) => rd.requiredDocuments(p).map((d) => d.docType);
type View = ReturnType<typeof tracks.getSubmittalTracks>[number];
const cards = (p: never): View[] => tracks.getSubmittalTracks(db, p);

// PLATFORM A — an Accela-shaped portal with a cited ESS permit of its own (discipline "other").
const ACCELA = "https://aca.cedar-ridge.example.gov/CitizenAccess/Default.aspx";
lookup("City of Cedar Ridge", {
  permitStructure: cited("combo", "https://cedar-ridge.example.gov/solar", "One residential solar permit covers building and electrical"),
  permits: [
    permit("combo", "Residential Solar PV", ACCELA, "accela"),
    permit("other", "Energy Storage System Permit", ACCELA, "accela", {
      issuingAgency: cited("Cedar Ridge Fire Department", "https://cedar-ridge.example.gov/fire/ess", "Battery energy storage systems require a separate permit from the Fire Department"),
    }),
  ],
});
// PLATFORM B — an EnerGov-shaped portal; separate building + electrical, a cited fire-review prerequisite.
const ENERGOV = "https://energov.pine-hollow.example.gov/EnerGov_Prod/SelfService";
lookup("Town of Pine Hollow", {
  permitStructure: cited("separate", "https://pine-hollow.example.gov/solar", "Solar requires a building permit and a separate electrical permit"),
  permits: [permit("structural", "Residential Solar Building", ENERGOV, "energov"), permit("electrical", "Residential Electrical", ENERGOV, "energov")],
  prerequisites: [cited("Fire Marshal plan review of the battery storage before the building permit", "https://pine-hollow.example.gov/fire", "Plans with battery storage must be reviewed by the Fire Marshal before building permit intake")],
});

const cedar = (snap: Record<string, unknown>) => project({ ahj: "City of Cedar Ridge", city: "Cedar Ridge", parserSnapshot: snap });
const sage = (snap: Record<string, unknown>) => project({ ahj: "Sagebrush", city: "Sagebrush", parserSnapshot: snap });
const pine = (snap: Record<string, unknown>) => project({ ahj: "Town of Pine Hollow", city: "Pine Hollow", parserSnapshot: snap });

console.log("\nRequired documents");
await check("(d1) MUST-PASS: a battery job owes the ESS spec sheet (blocking) and the ESS detail (advisory) — both platforms", () => {
  for (const p of [cedar(BATTERY), pine(BATTERY)]) {
    const rows = rd.requiredDocuments(p);
    const spec = rows.find((r) => r.docType === "battery_spec");
    const detail = rows.find((r) => r.docType === "ess_detail");
    assert.ok(spec?.blocking, JSON.stringify(rows.map((r) => r.docType)));
    assert.match(spec!.label, /UL 9540/);
    assert.ok(detail && !detail.blocking);
    assert.match(detail!.label, /706.*R328/);
  }
});
await check("(d2) MUST-PASS: a battery model alone (no hasBattery flag) is a battery", () => {
  assert.ok(docTypes(cedar({ batteryModel: "EX-13" })).includes("battery_spec"));
});
await check("(d3) MUST-PASS: the parser's READY line / page map counts the spec sheet present in the plan set; a MISSING line never does", () => {
  const docs = { plan_set: "/tmp/plan.pdf" };
  assert.ok(rd.sheetInPlanSet(cedar({ ...BATTERY, packetReadinessText: "READY - 07 Battery / ESS Spec Sheet" }), "battery_spec", docs));
  assert.ok(rd.sheetInPlanSet(cedar({ ...BATTERY, splitPagesText: "07 Battery / ESS specs: 12, 13" }), "battery_spec", docs));
  assert.ok(!rd.sheetInPlanSet(cedar({ ...BATTERY, packetReadinessText: "OPTIONAL/MISSING - 07 Battery / ESS Spec Sheet" }), "battery_spec", docs));
  assert.ok(!rd.sheetInPlanSet(cedar({ ...BATTERY, splitPagesText: "07 Battery / ESS specs: not detected" }), "battery_spec", docs));
  assert.ok(rd.sheetInPlanSet(cedar({ ...BATTERY, splitPagesText: "E-4 ESS location detail (R328): page 9" }), "ess_detail", docs));
});

console.log("\nThe permit card");
await check("(c1) MUST-PASS (Accela-shaped): the cited ESS permit is a cited step on the one permit card", () => {
  const combo = cards(cedar(BATTERY)).find((t) => t.type === "combo")!;
  assert.equal(combo.essStep?.status, "cited");
  const e = combo.essStep!.entries[0];
  assert.equal(e.basis, "lookup_permit");
  assert.match(e.step, /Energy Storage System Permit — issued by Cedar Ridge Fire Department/);
  assert.equal(e.sourceUrl, "https://cedar-ridge.example.gov/fire/ess");
});
await check("(c2) MUST-PASS (EnerGov-shaped, separate permits): the cited fire review rides the building card only", () => {
  const all = cards(pine(BATTERY));
  const bld = all.find((t) => t.type === "building")!;
  assert.equal(bld.essStep?.status, "cited");
  assert.equal(bld.essStep!.entries[0].basis, "lookup_prerequisite");
  assert.match(bld.essStep!.entries[0].step, /Fire Marshal plan review/);
  assert.equal(all.find((t) => t.type === "electrical")!.essStep, undefined);
  assert.equal(all.find((t) => t.type === "nem")!.essStep, undefined);
});
await check("(c3) MUST-PASS: only a seeded note mentions storage → quoted as an unverified note, never a cited fact", () => {
  const combo = cards(project({ ahj: "Juniper Flats", city: "Juniper Flats", parserSnapshot: BATTERY })).find((t) => t.category === "permit")!;
  assert.equal(combo.essStep?.status, "process_note");
  assert.match(combo.essStep!.entries[0].step, /Battery jobs go to the fire department/);
  // Split on sentence boundaries, not on every '.': the section number stays whole.
  assert.ok(combo.essStep!.entries.some((e) => e.step === "ESS clearances per NEC 706.10 apply"), JSON.stringify(combo.essStep!.entries.map((e) => e.step)));
  assert.equal(combo.essStep!.entries[0].sourceUrl, "");
  assert.match(combo.essStep!.summary, /unverified/);
});
await check("(c4) MUST-PASS: nothing on file → \"not on file, verify\", never assumed", () => {
  const combo = cards(project({ ahj: "Sagebrush", city: "Sagebrush", parserSnapshot: BATTERY })).find((t) => t.category === "permit")!;
  assert.equal(combo.essStep?.status, "not_on_file");
  assert.equal(combo.essStep!.entries.length, 0);
  assert.match(combo.essStep!.summary, /not on file — verify/);
});
await check("(c5) MUST-EXCLUDE: a battery adds no track — the same tracks as the no-battery job (no autopilot staging)", () => {
  for (const mk of [cedar, pine]) assert.deepEqual(tracks.requiredTracks(mk(BATTERY)), tracks.requiredTracks(mk(NO_BATTERY)));
});
await check("(c6) MUST-EXCLUDE: an uncited 'other' permit is not a fact (no step from it)", () => {
  lookup("Village of Aspen Bend", { permits: [{ ...permit("other", "Battery Storage Permit", ACCELA, "accela"), portalUrl: none() }] });
  const combo = cards(project({ ahj: "Village of Aspen Bend", city: "Aspen Bend", parserSnapshot: BATTERY })).find((t) => t.category === "permit")!;
  assert.equal(combo.essStep?.status, "not_on_file");
});

console.log("\nNo-battery and unknown jobs are unchanged");
await check("(x1) MUST-EXCLUDE: a no-battery job carries no ESS row and no ESS step — both platforms", () => {
  for (const p of [cedar(NO_BATTERY), pine(NO_BATTERY)]) {
    assert.ok(!docTypes(p).some((d) => d === "battery_spec" || d === "ess_detail"));
    assert.ok(cards(p).every((t) => !("essStep" in t)));
  }
});
await check("(x2) MUST-EXCLUDE: an UNKNOWN battery (never parsed) is not a battery: output identical to the no-battery job", () => {
  for (const mk of [cedar, pine]) {
    const strip = (v: unknown) => JSON.stringify(v).replace(/"id":"p-\d+"/g, "");
    assert.equal(strip(rd.requiredDocuments(mk({}))), strip(rd.requiredDocuments(mk(NO_BATTERY))));
    assert.equal(strip(cards(mk({}))), strip(cards(mk(NO_BATTERY))));
    assert.ok(cards(mk({})).every((t) => !("essStep" in t)));
  }
});

console.log("\nReview round (#256)");
await check("(d4) MUST-PASS: the inventory holds battery_spec for a battery job whose plan set says MISSING; an uploaded battery_spec clears it", () => {
  const client = createClient(db, { companyName: "ESS Test Solar", ccbLicenseNumber: "246246" });
  const created = createProject(db, { clientId: client.id, owner: "ESS Owner", street: "2 Test Way", city: "Sagebrush", state: "CO", ahj: "Sagebrush", utility: "Example Mountain Electric", dcKw: "6", acKw: "5" }).project;
  const attach = (docType: string) => {
    const file = path.join(tmp, `${created.id}-${docType}.pdf`);
    fs.writeFileSync(file, "%PDF-1.4 test fixture");
    db.run(`INSERT INTO project_documents (id, project_id, doc_type, original_filename, stored_path, source, uploaded_at, extracted_text)
      VALUES (?, ?, ?, ?, ?, 'upload', ?, '')`, [`${created.id}-${docType}`, created.id, docType, `${docType}.pdf`, file, new Date().toISOString()]);
  };
  attach("plan_set");
  const p = { ...(created as object), parserSnapshot: { ...BATTERY, packetReadinessText: "MISSING - 07 Battery / ESS Spec Sheet" } } as never;
  const held = (inv: { missingBlocking: Array<{ docType: string }> }) => inv.missingBlocking.some((d) => d.docType === "battery_spec");
  assert.ok(held(rd.documentInventory(db, p)), "the MISSING battery line must hold battery_spec");
  attach("battery_spec");
  assert.ok(!held(rd.documentInventory(db, p)), "an uploaded battery_spec must clear the hold");
});
await check("(d5) MUST-PASS: the upload control offers battery_spec and ess_detail (the hold has an operator path)", () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend", "dashboard.html"), "utf8");
  const select = html.slice(html.indexOf('id="docUploadType"'), html.indexOf("</select>", html.indexOf('id="docUploadType"')));
  assert.match(select, /value="battery_spec"/);
  assert.match(select, /value="ess_detail"/);
});
await check("(x3) MUST-EXCLUDE: a placeholder battery model saved through createProject / updateProject is not a battery; MUST-PASS: a real model or a quantity still is", () => {
  // Through the SAVE path: normalize.ts derives hasBattery from the model, so a literal snapshot
  // would skip the very derivation that turned "N/A" into a battery.
  const { getProjectDetail, updateProject } = repo;
  const client = createClient(db, { companyName: "ESS Placeholder Solar", ccbLicenseNumber: "246247" });
  const save = (o: Record<string, unknown>) => createProject(db, { clientId: client.id, owner: "ESS Owner", street: "3 Test Way", city: "Sagebrush", state: "CO", ahj: "Sagebrush", utility: "Example Mountain Electric", dcKw: "6", acKw: "5", ...o } as never).project;
  const owes = (p: unknown) => docTypes(p as never).includes("battery_spec") || cards(p as never).some((t) => "essStep" in t);
  for (const model of ["N/A", " N / A ", "N.A.", "None", "(none)", "None proposed", "Not included", "Not in scope", "No ESS", "-"]) {
    const created = save({ batteryModel: model });
    assert.equal(created.parserSnapshot?.hasBattery, "No", `createProject derived hasBattery from "${model}"`);
    assert.ok(!owes(created), `createProject: "${model}" owes battery rows`);
    // A PARTIAL, unrelated edit: updateProject drops the stored flag and re-derives it from the merged
    // evidence — still not a battery.
    const updated = updateProject(db, created.id, { dcKw: "6.5" } as never).project;
    assert.equal(updated.parserSnapshot?.hasBattery, "No", `updateProject re-derived hasBattery from "${model}"`);
    assert.ok(!owes(getProjectDetail(db, created.id).project), `updateProject: "${model}" owes battery rows`);
  }
  const parsed = save({ hasBattery: false, batteryModel: "N/A" });
  assert.ok(!owes(updateProject(db, parsed.id, { acKw: "5.2" } as never).project), "a parser-made {hasBattery:false, batteryModel:'N/A'} became a battery on update");
  assert.ok(owes(save({ batteryModel: "EX-13" })), "a real model is a battery");
  assert.ok(owes(save({ batteryModel: "None", batteryQty: "2" })), "a quantity is a battery");
  // Operator ruling on #256: an undecided model is still a battery — it owes its spec sheet, and
  // declaring "no storage" to the utility for it would be false.
  const tbd = save({ batteryModel: "TBD" });
  assert.equal(tbd.parserSnapshot?.hasBattery, "Yes");
  assert.ok(owes(tbd), "'TBD' is a battery");
  assert.ok(owes(updateProject(db, tbd.id, { dcKw: "6.5" } as never).project), "'TBD' stays a battery on update");
});
await check("(x4) MUST-EXCLUDE: a saved {batteryModel:'N/A'} job — the flag, the fee predicate, the portal's energy source, the utility programme and the required set all say no battery", () => {
  const client = createClient(db, { companyName: "ESS Agree Solar", ccbLicenseNumber: "246248" });
  const p = createProject(db, { clientId: client.id, owner: "ESS Owner", street: "4 Test Way", city: "Sagebrush", state: "CO", ahj: "Sagebrush", utility: "Example Mountain Electric", dcKw: "6", acKw: "5", batteryModel: "N/A" } as never).project;
  const snap = p.parserSnapshot as Record<string, unknown>;
  const fields = resolveRecipeFieldValues(db, p, "powerclerk");
  assert.equal(snap.hasBattery, "No");
  assert.notEqual(batteryStatus(snap), "yes");
  assert.equal(fields.energySource, "Solar PV");
  assert.equal(fields.wattsmartBatteryProgram, "No");
  assert.ok(!docTypes(p as never).includes("battery_spec"));
  // The permit-PDF readers: the description of work, the PV worksheet's battery box.
  assert.doesNotMatch(resolveSource("computed.descriptionOfWork", { project: p, client: {}, snapshot: snap } as never), /battery/i);
  assert.equal(iowaPvWorksheetValues(p).values["p2.battery"], "N");
  // MUST-PASS: the same agreement for a real battery.
  const real = createProject(db, { clientId: client.id, owner: "ESS Owner", street: "5 Test Way", city: "Sagebrush", state: "CO", ahj: "Sagebrush", utility: "Example Mountain Electric", dcKw: "6", acKw: "5", batteryModel: "EX-13" } as never).project;
  assert.equal(batteryStatus(real.parserSnapshot as Record<string, unknown>), "yes");
  assert.equal(resolveRecipeFieldValues(db, real, "powerclerk").energySource, "Solar PV and Battery");
});
await check("(x5) MUST-PASS (operator ruling on #256): a real model outranks a bare hasBattery 'No' — {hasBattery:'No', batteryModel:'EX-13'} is a battery on every surface", () => {
  const snap = { hasBattery: "No", batteryModel: "EX-13", moduleQuantity: "12", moduleModel: "EX-400" };
  const p = sage(snap);
  const fields = resolveRecipeFieldValues(db, p as never, "powerclerk");
  assert.equal(batteryStatus(snap), "yes");
  assert.equal(fields.energySource, "Solar PV and Battery");
  assert.equal(fields.wattsmartBatteryProgram, "Yes");
  assert.ok(docTypes(p).includes("battery_spec"));
  assert.ok(cards(p).some((t) => "essStep" in t));
  assert.match(resolveSource("computed.descriptionOfWork", { project: p, client: {}, snapshot: snap } as never), /with EX-13 battery storage/);
  assert.equal(iowaPvWorksheetValues(p as never).values["p2.battery"], "Y");
});
await check("(c7) MUST-EXCLUDE: a cited fire-only permit or review is never presented as the cited ESS requirement", () => {
  lookup("Town of Mesa Verde Springs", {
    permits: [permit("other", "Fire Sprinkler Permit", ACCELA, "accela", {
      issuingAgency: cited("Mesa Verde Springs Fire District", "https://mvs.example.gov/fire", "Fire sprinkler permits are issued by the Fire District"),
    })],
    prerequisites: [cited("Fire district review of rooftop access pathways and setbacks (R324.6)", "https://mvs.example.gov/fire/solar", "All solar plans require fire district review of roof access pathways")],
  });
  const step = cards(project({ ahj: "Town of Mesa Verde Springs", city: "Mesa Verde Springs", parserSnapshot: BATTERY })).find((t) => t.category === "permit")!.essStep!;
  assert.equal(step.status, "fire_review_unconfirmed");
  assert.match(step.summary, /whether it covers the battery is not stated — verify/);
  assert.doesNotMatch(step.summary, /file it alongside/);
  assert.ok(step.entries.length === 2 && step.entries.every((e) => e.namesStorage === false), JSON.stringify(step.entries));
});

// The card renderer, lifted from dashboard.js by bracket balance (feeTracksDisplay's lift).
const dashboard = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const lift = (name: string): string => {
  const m = new RegExp(`^function ${name}\\(|^const ${name} = `, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${name}`);
  const isConst = m[0].startsWith("const");
  let i = isConst ? m.index + m[0].length : dashboard.indexOf("{", dashboard.indexOf(")", m.index));
  let depth = 0;
  for (; i < dashboard.length; i++) {
    const ch = dashboard[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  return dashboard.slice(m.index, i) + (isConst ? ";" : "");
};
const RENDER = ["esc", "httpUrl", "linkifyText", "ESS_STEP_BASIS", "trackEssStepHtml"];
// eslint-disable-next-line no-new-func
const ui = new Function(`${RENDER.map(lift).join("\n\n")}\nreturn { ${RENDER.join(", ")} };`)() as { trackEssStepHtml: (t: unknown) => string };
await check("(r1) MUST-EXCLUDE: hostile strings render escaped, a non-http source is never linked, and a step listed above is not listed twice", () => {
  const html = ui.trackEssStepHtml({
    prerequisites: [{ step: "Fire Marshal review of the battery <b>first</b>", sourceUrl: "https://x.example.gov/a" }],
    essStep: {
      status: "cited", summary: "Battery/ESS <script>alert(1)</script>",
      entries: [
        { step: "Fire Marshal review of the battery <b>first</b>", sourceUrl: "https://x.example.gov/a", quote: "q", basis: "lookup_prerequisite", namesStorage: true },
        { step: "<img src=x onerror=alert(1)> ESS permit", sourceUrl: "javascript:alert(1)", quote: "q", basis: "lookup_permit", namesStorage: true },
        { step: "Fire \"review\"", sourceUrl: "https://x.example.gov/b", quote: "q", basis: "lookup_permit", namesStorage: false },
      ],
    },
  });
  assert.doesNotMatch(html, /<script|<img|<b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; ESS permit/);
  assert.doesNotMatch(html, /javascript:/);
  assert.equal((html.match(/Fire Marshal review/g) || []).length, 0, html);
  assert.match(html, /listed above/);
  assert.match(html, /whether it covers the battery is not stated — verify/);
  assert.equal(ui.trackEssStepHtml({ type: "combo" }), "");
});

if (failures) { console.error(`\n${failures} ESS check(s) FAILED.`); process.exit(1); }
console.log("\nAll battery/ESS requirement checks passed.");
process.exit(0);
