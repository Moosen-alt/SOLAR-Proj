// OUT-OF-STATE PROJECTS MOVE: "prescriptive vs engineered — confirm which" is an OREGON question.
//
// The 100-project load test (.probe/volume/assess_load.result.md) stopped 25/25 IL and WA projects
// at the submit gate's "Permit path confirmed (prescriptive vs engineered)". Mechanism: permitPath.ts
// answered UNKNOWN for every non-Oregon project whose jurisdiction had no researched prescriptive
// path (the screen it encodes is ORSC / BCD 440-5952), the gate blocks on unknown, and staging
// 409s on it. The operator was asked to choose between two applications the jurisdiction does
// not publish, once per project.
//
// THE ENGINE RULE (any state): outside Oregon, unless the jurisdiction's OWN research says it
// publishes a prescriptive rooftop-PV path, there is one route — the standard structural review
// (standardReview). It asks for what that review needs: the roof framing + attachment
// detail (every project's required set) and a sealed letter ONLY where the jurisdiction's own
// stamp rule says so (CA > 10 kW DC, Chicago at any size — reference code profiles). Never
// "prescriptive": no Oregon number judges a Florida roof.
//
//   MUST-PASS    FL, TX, UT, CA, IL, WA projects with complete documents clear the permit-path
//                check and reach the next real step (the gate is not blocked on the path; no
//                Oregon-style PE package is demanded);
//   MUST-PASS    a jurisdiction's own stamp rule still demands the letter (CA 12 kW, Chicago);
//   MUST-EXCLUDE an Oregon project skipping its path confirmation (no structural inputs → unknown
//                → the gate blocks), and an unknown-path Oregon project treated as confirmed;
//   MUST-EXCLUDE a project with NO state treated as routed;
//   MUST-EXCLUDE (MF2) a state spelling the resolver does not recognise ("Oreg.", "OR 97201",
//                "Portland, OR", "97201", garbage) treated as "some other state" and routed past
//                Oregon's confirmation — it is unknown (or Oregon), and the gate blocks.
import "./_isolate";

process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.CODE_RESEARCH = "off";
process.env.SKIP_CODE_RESEARCH = "1";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.PORTAL_AUTOMATION = "off";
process.env.PORTAL_AUTOSEED = "0";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { createProject, getSubmitGateReport, getProjectDetail } = await import("../src/repository");
const { computeNextStep } = await import("../src/nextStep");
const { resolvePermitPath, resolveStampRequirement, permitPathCallout } = await import("../src/permitPath");
const { resolvePermitPathForProject } = await import("../src/codeProfiles");
const { documentInventory } = await import("../src/requiredDocuments");
const db = await openDatabase();

// ── Resolver level: the rule itself ─────────────────────────────────────────────────────────
const snapshot = { mounting: "Roof mount", framingType: "rafter", roofRafterSpacing: "24", roofRafterSpan: "10", snow: "25", wind: "B", windSpeed: "100", deadLoad: "2.6", roofMaterial: "Composition Shingle", permitPath: "prescriptive" };
const bare = (state: string, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ id: `r-${state}`, state, ahj: `City of ${state}ville`, systemSizeDcKw: 6, parserSnapshot: { ...snapshot, ...over }, ...extra }) as never;

for (const state of ["FL", "TX", "UT", "CA", "IL", "WA"]) {
  const r = resolvePermitPath(bare(state));
  check(`MUST-PASS resolver: ${state} with no prescriptive path on file routes to the standard structural review (not unknown, not prescriptive)`,
    r.path === "engineered" && r.standardReview === true, JSON.stringify({ path: r.path, source: r.source, standardReview: r.standardReview }));
  check(`…${state} does NOT demand Oregon's engineered-path PE package by itself`,
    r.needsEngineeredDocs === false && r.requiredEngineeredDocs.length === 0 && !resolveStampRequirement(bare(state)).required,
    JSON.stringify(resolveStampRequirement(bare(state))));
  check(`…and ${state}'s basis SAYS what it asks for instead of going quiet`,
    /standard structural/i.test(r.basis.join(" ")) && /framing/i.test(r.basis.join(" ")), r.basis.join(" ").slice(0, 200));
}
check("the callout says there is no path choice to make (not 'upload ONLY the structural application')",
  /no prescriptive-vs-engineered choice/i.test(permitPathCallout(resolvePermitPath(bare("FL")))), permitPathCallout(resolvePermitPath(bare("FL"))));
check("MUST-PASS: the jurisdiction's OWN stamp rule still demands the sealed letter (Chicago: any size)",
  resolveStampRequirement(bare("IL"), { stampThresholdKwDc: 0, jurisdictionLabel: "Chicago" }).required === true);
check("MUST-PASS: …and CA's > 10 kW DC rule on a 12 kW system",
  resolveStampRequirement(bare("CA", {}, { systemSizeDcKw: 12 }), { stampThresholdKwDc: 10, jurisdictionLabel: "CA" }).required === true);
check("MUST-EXCLUDE: a Florida plan set that SAYS engineered still carries the full engineered package",
  resolvePermitPath(bare("FL", { permitPath: "engineered" })).needsEngineeredDocs === true
  && resolveStampRequirement(bare("FL", { permitPath: "engineered" })).required === true);
check("MUST-EXCLUDE: never 'prescriptive' outside Oregon from Oregon's numbers",
  ["FL", "TX", "UT", "CA", "IL", "WA"].every((st) => resolvePermitPath(bare(st)).path !== "prescriptive"));
check("MUST-PASS: a jurisdiction whose OWN research publishes a prescriptive path still runs its own screen",
  resolvePermitPath(bare("FL"), { limits: { hasPrescriptivePath: true, maxRafterSpacingIn: 24 } }).path === "prescriptive");
check("MUST-EXCLUDE: a project with NO state is not routed (unknown — no jurisdiction to route by)",
  resolvePermitPath(bare("")).path === "unknown");
check("MUST-EXCLUDE: an Oregon project with no structural inputs stays UNKNOWN (it must confirm its path)",
  resolvePermitPath(bare("OR", { framingType: "", roofRafterSpacing: "", roofRafterSpan: "", snow: "", wind: "", windSpeed: "", deadLoad: "", permitPath: "" })).path === "unknown");
for (const spelled of ["Oregon", "oregon", "Ore.", " or "]) {
  check(`MUST-EXCLUDE: an Oregon project with the state spelled "${spelled}" and no structural inputs stays UNKNOWN (never standard review)`,
    resolvePermitPath(bare(spelled, { framingType: "", roofRafterSpacing: "", roofRafterSpan: "", snow: "", wind: "", windSpeed: "", deadLoad: "", permitPath: "" })).path === "unknown");
  check(`…and "${spelled}" with clean numerics runs ORSC's screen (prescriptive)`, resolvePermitPath(bare(spelled)).path === "prescriptive");
}
check("…while an Oregon project that clears ORSC's screen is still prescriptive (Oregon's rule is untouched)",
  resolvePermitPath(bare("OR")).path === "prescriptive");

// ── Gate level: the load test's measurement, on the real submit gate ────────────────────────
const client = createClient(db, {
  companyName: "Out Of State Solar LLC", legalBusinessName: "Out Of State Solar LLC", ccbLicenseNumber: "240135",
  electricalLicenseNumber: "C1234", businessEmail: "ops@oos.test", businessPhone: "(503) 555-0142",
});
// The smoke's fixture (backend/src/smoke.ts): proven to clear QC, the document gate and the reviewer
// gate in Oregon. Only the jurisdiction changes.
const COMPLETE: Record<string, string> = {
  street: "123 Solar Way", zip: "99999",
  account: "1234567890", meter: "987654321", dcKw: "8.6", acKw: "6.5", exportKw: "6.5", moduleMake: "Qcells",
  moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20", invModel: "IQ8M", invQty: "20", invOutputW: "325",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40", permitPath: "PRESCRIPTIVE",
  framingType: "rafter", roofRafterSpacing: "24", roofRafterSpan: "10", snow: "25", deadLoad: "3.2", wind: "B", mounting: "Roof mount",
  locateCalloutText: "No locate-triggering scope found.",
  sitePlanNotesText: "Roof plan shows fire access pathway, ridge/eave setbacks, array dimensions, service equipment, and PV layout.",
  roofPlanNotesText: "Roof framing: 2x6 rafters at 24 inches on center, 10 ft clear span, roof slope 5:12. Racking attachment detail shows flashed standoffs lagged to rafters.",
  structuralCalcText: "Rooftop PV structural check complete. Dead load 3.2 psf, ground snow 25 psf, wind exposure B, rafter span checked.",
  electricalCalcText: "NEC 705.12 load-side calculation: 200A bus x 120 percent = 240A, 200A main + 40A PV breaker = 240A. NEC 690.12 rapid shutdown shown.",
  labelsText: "PV label schedule includes rapid shutdown label, service power source directory, disconnect labels, and backfed breaker warning.",
  splitPagesText: "01 Site/Roof Plan and PV layout with fire pathway: pages 1-2\n02 SLD 3-Line Diagram with NEC 705.12 calculation and rapid shutdown: page 3\n03 Roof framing and racking attachment detail: pages 4-5\n04 Module spec UL 61730: pages 6-8\n05 Inverter spec UL 1741 SB: pages 9-11\n06 Label schedule and placards: page 12",
  utilityDownloadChecklistText: "Utility package includes SLD/3-line, site/plot plan, module spec, inverter spec, utility bill, meter data, and account data.",
  packetReadinessText: "READY - Plan set\nREADY - Utility bill\nREADY - Module spec\nREADY - Inverter spec",
};
const JURISDICTIONS: Array<{ state: string; city: string; ahj: string; utility: string }> = [
  { state: "FL", city: "Cape Coral", ahj: "City of Cape Coral", utility: "Florida Power & Light" },
  { state: "TX", city: "Austin", ahj: "City of Austin", utility: "Austin Energy" },
  { state: "UT", city: "Provo", ahj: "Provo City", utility: "Rocky Mountain Power" },
  { state: "CA", city: "Fresno", ahj: "City of Fresno", utility: "PG&E" },
  { state: "IL", city: "Naperville", ahj: "City of Naperville", utility: "ComEd" },
  { state: "WA", city: "Spokane", ahj: "City of Spokane", utility: "Avista" },
];
let seq = 0;
// "Complete documents" means what THAT jurisdiction files: Cape Coral's process profile files a
// building AND an electrical application (reference-ahj-processes), so its complete set carries both.
const APPLICATIONS: Record<string, string[]> = { FL: ["building_application", "electrical_application"] };
const pdf = (label: string): Buffer => Buffer.from(`%PDF-1.4\n% ${label}\n`, "utf8");
const mk =(j: { state: string; city: string; ahj: string; utility: string }, over: Record<string, string> = {}): string => {
  const d = createProject(db, { clientId: client.id, owner: `OOS Owner ${++seq}`, ...COMPLETE, ...j, ...over });
  saveProjectDocument(db, d.project.id, { docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf", buffer: pdf("plan set"), source: "upload" });
  for (const docType of APPLICATIONS[j.state] ?? []) {
    saveProjectDocument(db, d.project.id, { docType, filename: `${docType}.pdf`, contentType: "application/pdf", buffer: pdf(docType), source: "upload" });
  }
  return d.project.id;
};
const gateBlockers = (pid: string): string[] => getSubmitGateReport(db, pid).checks.filter((c) => c.status === "blocker").map((c) => c.id);

// Oregon control: the same complete fixture in Portland is ready — so any blocker below is the
// jurisdiction's, not the fixture's.
const orControl = mk({ state: "OR", city: "Portland", ahj: "Portland", utility: "PGE" });
check("CONTROL: the complete fixture is gate-ready in Oregon", gateBlockers(orControl).length === 0, JSON.stringify(gateBlockers(orControl)));

for (const j of JURISDICTIONS) {
  const pid = mk(j);
  const project = getProjectDetail(db, pid).project;
  const blockers = gateBlockers(pid);
  const step = computeNextStep(db, pid);
  const owed = documentInventory(db, project).missingBlocking.map((d) => d.docType);
  check(`MUST-PASS gate: ${j.state} (${j.ahj}) is NOT stopped at "Permit path confirmed"`, !blockers.includes("permit-path"), JSON.stringify(blockers));
  check(`…${j.state} is not asked for an Oregon-style PE package`, !owed.includes("structural_letter"), JSON.stringify(owed));
  check(`…${j.state} with complete documents reaches the next real step (ready to stage), not a gate block`,
    blockers.length === 0 && step.key === "ready_to_stage", `${step.key}: ${step.headline} | blockers ${JSON.stringify(blockers)}`);
  check(`…and the resolver the gate uses agrees (standard review)`, resolvePermitPathForProject(db, project).standardReview === true);
}

// The jurisdiction's stamp note still speaks — as what it IS. CA's "> 10 kW" is the seeded STATE-level
// reference note ("structural PE stamp commonly required over ~10 kW"), not a confirmed rule of the
// AHJ: leak-sweep ruling 2026-09-28 (unknown-as-fact-seeded-state-stamp-threshold) makes it a named,
// waivable advisory — listed with "confirm", never a staging refusal worded "<AHJ> requires".
const caBig = mk(JURISDICTIONS[3], { dcKw: "12.4", acKw: "10" });
const caBigInv = documentInventory(db, getProjectDetail(db, caBig).project);
const caBigOwed = caBigInv.missingBlocking.map((d) => d.docType);
const caBigNote = caBigInv.missingAdvisory.find((d) => d.docType === "structural_letter");
check("MUST-PASS gate: a 12.4 kW CA project is still TOLD about the PE-sealed letter (CA's seeded > 10 kW note), as an advisory to confirm",
  Boolean(caBigNote) && /[Cc]onfirm/.test(caBigNote!.why) && !caBigOwed.includes("structural_letter"), JSON.stringify({ caBigOwed, why: caBigNote?.why }));

// MUST-EXCLUDE: an Oregon project with no structural inputs still has to confirm its path.
const orUnknown = mk({ state: "OR", city: "Portland", ahj: "Portland", utility: "PGE" }, {
  permitPath: "", framingType: "", roofRafterSpacing: "", roofRafterSpan: "", snow: "", deadLoad: "", wind: "", mounting: "",
});
const orUnknownProject = getProjectDetail(db, orUnknown).project;
check("MUST-EXCLUDE premise: the Oregon project has no path signal", resolvePermitPathForProject(db, orUnknownProject).path === "unknown",
  resolvePermitPathForProject(db, orUnknownProject).path);
check("MUST-EXCLUDE gate: an unknown-path OREGON project is still blocked at the permit-path check (never treated as confirmed)",
  gateBlockers(orUnknown).includes("permit-path"), JSON.stringify(gateBlockers(orUnknown)));

// ── MF2 (D1 verification): the state is an ALLOWLIST, not "anything that is not OR" ────────
// Intake stores the state as typed. The first normaliser knew "OREGON" and "ORE" only, so a
// Portland project stored as "Oreg.", "OR 97201", "Portland, OR" or "97201" was "not OR", routed
// to the standard review and skipped Oregon's confirmation with NO gate blocker — the fail-open
// the old "unknown" fallback had prevented.
const NO_STRUCTURAL = { framingType: "", roofRafterSpacing: "", roofRafterSpan: "", snow: "", wind: "", windSpeed: "", deadLoad: "", permitPath: "" };
for (const [spelled, code] of [["Florida", "FL"], ["Texas", "TX"], ["utah", "UT"], ["Calif.", "CA"], ["Tex", "TX"], ["Fla.", "FL"], ["Wash", "WA"], [" il ", "IL"]] as const) {
  const r = resolvePermitPath(bare(spelled));
  check(`MF2 MUST-PASS resolver: "${spelled}" (${code}) routes to the standard review like "${code}"`,
    r.path === "engineered" && r.standardReview === true, JSON.stringify({ path: r.path, standardReview: r.standardReview }));
}
for (const spelled of ["Oreg.", "OREG", "Oregon State", "OR 97201", "Portland, OR", "97201", "OR, USA", "O.R.", "OR-Oregon", "Or.", "Ore", "garbage", "??", "Oregon, USA", "Orgeon"]) {
  const r = resolvePermitPath(bare(spelled, NO_STRUCTURAL));
  check(`MF2 MUST-EXCLUDE resolver: "${spelled}" with no structural inputs never routes to the standard review (unknown or Oregon)`,
    r.standardReview === false && r.path === "unknown", JSON.stringify({ path: r.path, source: r.source, standardReview: r.standardReview, basis: r.basis }));
}
check("MF2: an unrecognised spelling's basis says so (not 'no state on file')",
  /not a recognised US state spelling/.test(resolvePermitPath(bare("OR 97201", NO_STRUCTURAL)).basis.join(" ")), resolvePermitPath(bare("OR 97201", NO_STRUCTURAL)).basis.join(" "));
// A recognised non-Oregon state that ALSO happens to have researched limits, and Oregon's own
// abbreviations, are unchanged.
check("MF2: 'Oreg.' with clean numerics is OREGON (runs ORSC's screen: prescriptive)", resolvePermitPath(bare("Oreg.")).path === "prescriptive");
check("MF2: an unrecognised spelling with a researched prescriptive path still runs that jurisdiction's own screen",
  resolvePermitPath(bare("Oreg."), { limits: { hasPrescriptivePath: true, maxRafterSpacingIn: 24 } }).path === "prescriptive");

// The gate: a real Portland project stored as "Oreg." with no structural inputs is BLOCKED at the
// permit-path check — exactly like the "OR" one above — never ready.
for (const spelled of ["Oreg.", "OR 97201", "Portland, OR", "97201"]) {
  const pid = mk({ state: spelled, city: "Portland", ahj: "Portland", utility: "PGE" }, {
    permitPath: "", framingType: "", roofRafterSpacing: "", roofRafterSpan: "", snow: "", deadLoad: "", wind: "", mounting: "",
  });
  const project = getProjectDetail(db, pid).project;
  check(`MF2 MUST-EXCLUDE gate: a Portland project stored as "${spelled}" is blocked at permit-path (never standard review)`,
    gateBlockers(pid).includes("permit-path") && resolvePermitPathForProject(db, project).standardReview === false && computeNextStep(db, pid).key !== "ready_to_stage",
    `${computeNextStep(db, pid).key} ${JSON.stringify(gateBlockers(pid))} ${JSON.stringify(resolvePermitPathForProject(db, project))}`);
}
for (const [spelled, j] of [["Florida", JURISDICTIONS[0]], ["Texas", JURISDICTIONS[1]]] as const) {
  const pid = mk({ ...j, state: spelled });
  check(`MF2 MUST-PASS gate: "${spelled}" spelled out with complete documents still reaches ready_to_stage`,
    computeNextStep(db, pid).key === "ready_to_stage" && !gateBlockers(pid).includes("permit-path"), `${computeNextStep(db, pid).key} ${JSON.stringify(gateBlockers(pid))}`);
}

if (failures) { console.error(`\noutOfStatePermitPath: ${failures} FAILED`); process.exit(1); }
console.log("\noutOfStatePermitPath: all checks passed");
process.exit(0);
