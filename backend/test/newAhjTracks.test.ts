// NEW-AHJ TRACKS (e2e gap round, 2026-09-26) — the tracks builder's four gaps, each as an engine
// invariant on FICTIONAL jurisdictions and utilities (the seven e2e AHJs are the scorer's held-out
// set; nothing here names one).
//
//   GAP 1  ONE permit-structure answer (applicationDocs.permitStructureAnswer), asked by the tracks,
//          the form finder's permitType, the email subject and the package: "separate — both must
//          be filed" only on a cited page / a person / a hand-written profile / a cited state rule;
//          flags, hedged notes and uncited research are leads, never the answer; a prerequisite
//          office is its own step.
//   GAP 2  process profiles match the EXACT jurisdiction (city vs county; state mismatch loses);
//          per-job research replaces a seeded document list; Oregon's template document list
//          (prescriptive-or-structural, "Renewable Energy (electrical)") only for Oregon jobs;
//          a seeded note is labelled as a note, not an instruction.
//   GAP 3  the utility filing location, found and cited (utilityFilingLookup), rule 5 on the URL,
//          and the utility track labelled by what the program IS — never "NEM" by default.
//   GAP 4  a portal / "no portal" the lookup found reaches the tracks' channel.
//
// KILL TESTS (each verified red by hand with the fix removed — see the commit message):
//   K1 processProfiles: drop the kind gate (jurisdictionKindsCompatible → true)      → (j1) fails.
//   K2 applicationDocs: flags-both → "separate" again (level 5 settles)              → (s1) fails.
//   K3 applicationDocs: the email subject's unknown falls to "BLD, ELE"              → (s1) fails.
//   K4 applicationDocs: drop the HEDGED test                                          → (s2) fails.
//   K5 submittalTracks: channel ignores the lookup's portal                           → (c1) fails.
//   K6 utilityFilingLookup: acceptFilingUrl skips hostFitsTrackAndEntity              → (u2) fails.
//   K7 utilityFilingLookup: unknown program labelled net metering                     → (u4) fails.
//   K8 applicationDocs: Oregon template list outside Oregon                           → (j5) fails.
//
// Run: npx tsx backend/test/newAhjTracks.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "new-ahj-tracks-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.ANTHROPIC_API_KEY = "";
process.env.PERMIT_PROCESS_LOOKUP = "off";

// A SYNTHETIC process reference whose FILE ORDER makes the old scorer pick wrong: the CITY profile
// comes first and ties the county on "ahj + city" substring scoring.
const profile = (o: Record<string, unknown>) => ({
  state: "NM", ahj: "", submissionMethod: "", timeline: "", requiresElectricianSign: false, requiresElectricalStamp: false,
  requiresStructuralStamp: false, requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false,
  requiresSolarChecklist: false, requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false,
  requiresFloodplainCheck: false, requiresJurisdictionCheck: false, otherRequirements: "", reviewerNotes: "", sourceSheet: "(test) NM", ...o,
});
const REFERENCE = path.join(tmp, "reference-ahj-processes.json");
fs.writeFileSync(REFERENCE, JSON.stringify({ profiles: [
  profile({ ahj: "Pinon Mesa", submissionMethod: "Email", timeline: "~10 business days", requiresElectricalPermitApplication: true, requiresBuildingPermitApplication: true,
    requiresSolarChecklist: true, reviewerNotes: 'Select "Solar Systems/Green Including Everything" and drop off two copies at the City of Pinon Mesa office.' }),
  profile({ ahj: "Pinon Mesa County", submissionMethod: "In-person: appointment only", requiresElectricianSign: true }),
  profile({ ahj: "Arroyo Hondo", submissionMethod: "Arroyo Hondo portal", requiresElectricalPermitApplication: true, requiresBuildingPermitApplication: true,
    reviewerNotes: "Upload 2 copies of the plan set. Looks like combo permit (?)" }),
  profile({ ahj: "Tres Piedras", submissionMethod: "Email", reviewerNotes: "Apply for the building and electrical permits separately." }),
  profile({ state: "OR", ahj: "Fernhollow", submissionMethod: "Email", requiresBuildingPermitApplication: true, requiresElectricalPermitApplication: true, requiresSolarChecklist: true }),
] }));
process.env.AHJ_PROCESS_REFERENCE_PATH = REFERENCE;

const { openDatabase } = await import("../src/db");
const db = await openDatabase();
const pp = await import("../src/processProfiles");
const appDocs = await import("../src/applicationDocs");
const tracks = await import("../src/submittalTracks");
const permitProcess = await import("../src/permitProcess");
const ufl = await import("../src/utilityFilingLookup");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
let seq = 0;
const project = (o: Record<string, unknown>) => ({
  id: `p-${++seq}`, clientId: null, state: "NM", ahj: "", city: "", utility: "Mesa Electric Cooperative", homeownerName: "Test Owner",
  projectAddress: "1 Test Way", zip: "87500", systemSizeDcKw: 6, systemSizeAcKw: 5, parserSnapshot: {}, status: "parsed", ...o,
}) as never;
const cited = <T>(value: T, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const none = (why = "not searched") => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });
const lookup = (state: string, ahj: string, o: Record<string, unknown> = {}) => permitProcess.savePermitProcessLookup(db, {
  state, ahj, lookedUpAt: new Date().toISOString(), issuingAgency: none(), permitStructure: none(), permits: [], ...o,
} as never);
const trackOf = (p: never, type: string) => tracks.getSubmittalTracks(db, p).find((t) => t.type === type)!;

// ── GAP 2: the exact jurisdiction ─────────────────────────────────────────────────────────────
console.log("\nGAP 2 — the exact jurisdiction");
await check("(j1) MUST-EXCLUDE: a project that names a COUNTY never gets the same-named CITY's profile (even when its mailing city is that city)", () => {
  assert.equal(pp.findAhjProcessProfile(project({ ahj: "Pinon Mesa County", city: "Pinon Mesa" }))?.ahj, "Pinon Mesa County");
  assert.equal(pp.findAhjProcessProfile(project({ ahj: "Pinon Mesa County, NM", city: "Pinon Mesa" }))?.ahj, "Pinon Mesa County");
  // No county profile at all → nothing, never the city's.
  assert.equal(pp.findAhjProcessProfile(project({ ahj: "Tres Piedras County", city: "Tres Piedras" })), null);
  // And a "City of" project never gets a county's profile.
  assert.notEqual(pp.findAhjProcessProfile(project({ ahj: "City of Pinon Mesa", city: "Pinon Mesa" }))?.ahj, "Pinon Mesa County");
});
await check("(j2) MUST-PASS: the city's own name, a bare name and an empty AHJ with that mailing city still find the city profile", () => {
  assert.equal(pp.findAhjProcessProfile(project({ ahj: "City of Pinon Mesa", city: "Pinon Mesa" }))?.ahj, "Pinon Mesa");
  assert.equal(pp.findAhjProcessProfile(project({ ahj: "Pinon Mesa", city: "" }))?.ahj, "Pinon Mesa");
  assert.equal(pp.findAhjProcessProfile(project({ ahj: "", city: "Pinon Mesa" }))?.ahj, "Pinon Mesa");
});
await check("(j3) MUST-EXCLUDE: state mismatch always loses", () => {
  assert.equal(pp.findAhjProcessProfile(project({ state: "AZ", ahj: "City of Pinon Mesa", city: "Pinon Mesa" })), null);
});
await check("(j4) MUST-EXCLUDE: the hand-written Oregon registry — a Marion County project with a Salem mailing address is Marion County, not the City of Salem", () => {
  const p = project({ state: "OR", ahj: "Marion County", city: "Salem", utility: "Portland General Electric" });
  assert.equal(appDocs.findApplicationProfile(p).id, "marion-county-keizer-solar");
  assert.equal(appDocs.findApplicationProfile(project({ state: "OR", ahj: "City of Salem", city: "Salem" })).id, "salem-pac-solar-array");
});
await check("(j5) MUST-EXCLUDE: Oregon's template document list never appears outside Oregon; MUST-PASS: it still does in Oregon", () => {
  const nm = appDocs.findApplicationProfile(project({ ahj: "City of Pinon Mesa", city: "Pinon Mesa" }));
  const docs = nm.requiredDocuments.join(" | ");
  assert.doesNotMatch(docs, /PRESCRIPTIVE or STRUCTURAL|Renewable Energy \(electrical\)|prescriptive checklist/i, docs);
  assert.match(docs, /building permit application/i);
  const or = appDocs.findApplicationProfile(project({ state: "OR", ahj: "City of Fernhollow", city: "Fernhollow", utility: "Portland General Electric" }));
  assert.match(or.requiredDocuments.join(" | "), /PRESCRIPTIVE or STRUCTURAL/);
});
await check("(j6) MUST-PASS: a seeded note is labelled as the operator's unverified reference, never printed as a bare instruction", () => {
  const notes = appDocs.findApplicationProfile(project({ ahj: "City of Pinon Mesa", city: "Pinon Mesa" })).notes;
  const selectNote = notes.find((n) => /Solar Systems\/Green/.test(n))!;
  assert.match(selectNote, /^Seeded reference note \(unverified\): /);
});
await check("(j7) MUST-PASS: the per-job lookup's cited documents replace a seeded list", () => {
  lookup("NM", "City of Pinon Mesa", { permits: [{ discipline: "combo", label: "Residential Solar", issuingAgency: none(), portalUrl: none(), recordType: none(),
    documents: cited(["Site plan with fire clearances", "Three-line diagram"], "https://pinonmesa.example.gov/solar", "Submit a site plan with fire clearances and a three-line diagram"), fee: none() }] });
  const prof = appDocs.findApplicationProfile(project({ ahj: "City of Pinon Mesa", city: "Pinon Mesa" }));
  assert.deepEqual(prof.requiredDocuments, ["Site plan with fire clearances", "Three-line diagram"]);
  assert.match(prof.notes[0], /per-job lookup/);
});

// ── GAP 1: one permit-structure answer ────────────────────────────────────────────────────────
console.log("\nGAP 1 — one permit-structure answer");
await check("(s1) MUST-EXCLUDE: two seeded flags are a lead, not 'separate' — tracks, form finder, email subject and package all say NOT CONFIRMED", () => {
  const p = project({ ahj: "Pinon Mesa", city: "Pinon Mesa" }); // flags both applications, no words
  const a = appDocs.permitStructureAnswer(p);
  assert.equal(a.structure, "unknown");
  assert.match(a.hint, /flags both/);
  assert.deepEqual(tracks.requiredTracks(p), ["nem", "combo"]);
  const combo = trackOf(p, "combo");
  assert.match(combo.label, /not yet confirmed/);
  assert.doesNotMatch(combo.label, /\(combo\)/);
  // The form finder with its own uncited "separate": a lead, never "both must be filed".
  const ff = appDocs.describePermitType(appDocs.findApplicationProfile(p), { answer: appDocs.permitStructureAnswer(p, { researched: "separate", researchedFrom: "the form search (uncited)" }) });
  assert.doesNotMatch(ff.callout, /both must be filed/);
  assert.match(ff.callout, /not yet confirmed/);
  assert.match(ff.callout, /the form search \(uncited\) read it as separate/);
  const email = appDocs.buildSubmittalEmailDraft(p, { companyName: "Acme Solar" });
  assert.doesNotMatch(email.subject, /BLD, ELE/);
  assert.match(email.subject, /Acme Solar - Permit submittal - /);
  const pkg = appDocs.buildApplicationDocumentPackage(p);
  assert.doesNotMatch(pkg.permitType, /both must be filed/);
});
await check("(s2) MUST-EXCLUDE: a hedged note ('Looks like combo permit (?)') settles nothing", () => {
  const a = appDocs.permitStructureAnswer(project({ ahj: "Arroyo Hondo", city: "Arroyo Hondo" }));
  assert.equal(a.structure, "unknown");
  assert.match(a.hint, /hedged/);
});
await check("(s3) MUST-PASS: a cited agency page saying separate splits the tracks and every surface says 'both must be filed'", () => {
  lookup("NM", "Town of Cerro Alto", { permitStructure: cited("separate", "https://cerroalto.example.gov/solar", "Solar PV requires a building permit and a separate electrical permit") });
  const p = project({ ahj: "Town of Cerro Alto", city: "Cerro Alto" });
  assert.deepEqual(tracks.requiredTracks(p), ["nem", "building", "electrical"]);
  assert.equal(trackOf(p, "building").label, "Building permit (BLD)");
  const callout = appDocs.describePermitType(appDocs.findApplicationProfile(p), { answer: appDocs.permitStructureAnswer(p) }).callout;
  assert.match(callout, /both must be filed \(cited agency page\)/);
  assert.match(appDocs.buildSubmittalEmailDraft(p).subject, /BLD, ELE Permit submittal/);
});
await check("(s4) MUST-PASS: a cited ONE-permit answer titles the card as the combo permit and the subject as one permit", () => {
  lookup("NM", "Village of Lomita", { permitStructure: cited("combo", "https://lomita.example.gov/solar", "One Residential Solar permit covers the building and electrical scope") });
  const p = project({ ahj: "Village of Lomita", city: "Lomita" });
  assert.equal(trackOf(p, "combo").label, "Building + electrical permit (combo)");
  assert.match(appDocs.buildSubmittalEmailDraft(p).subject, / - Permit submittal - /);
});
await check("(s5) MUST-EXCLUDE: a lookup answer without its page's words is not an answer", () => {
  lookup("NM", "Village of Sin Cita", { permitStructure: { value: "separate", sourceUrl: "", quote: "", origin: "lookup" } });
  assert.equal(appDocs.permitStructureAnswer(project({ ahj: "Village of Sin Cita" })).structure, "unknown");
});
await check("(s6) MUST-PASS: a prerequisite office is its own step, first, cited — and never the answer's structure", () => {
  lookup("NM", "City of Rio Seco", {
    permitStructure: cited("combo", "https://rioseco.example.gov/solar", "A single solar permit covers the work"),
    prerequisites: [cited("Fire Prevention plan review before the building permit drop-off", "https://rioseco.example.gov/fire", "ALL plans need to go to Fire Prevention prior to Building drop off")],
  });
  const p = project({ ahj: "City of Rio Seco", city: "Rio Seco" });
  const t = trackOf(p, "combo") as ReturnType<typeof trackOf> & { prerequisites?: Array<{ step: string }> };
  assert.match(t.nextAction, /^FIRST, at another office: \(1\) Fire Prevention plan review/);
  assert.equal(t.prerequisites?.[0]?.step, "Fire Prevention plan review before the building permit drop-off");
  assert.match(appDocs.describePermitType(appDocs.findApplicationProfile(p), { answer: appDocs.permitStructureAnswer(p) }).callout, /FIRST, at another office: Fire Prevention plan review/);
});
await check("(s7) MUST-PASS: an unhedged seeded note still answers, stated as the operator's note (not a cited page)", () => {
  const p = project({ ahj: "Tres Piedras", city: "Tres Piedras" });
  const a = appDocs.permitStructureAnswer(p);
  assert.equal(a.structure, "separate");
  assert.equal(a.level, "reference");
  assert.match(trackOf(p, "building").label, /seeded note, not confirmed/);
  assert.doesNotMatch(appDocs.describePermitType(appDocs.findApplicationProfile(p), { answer: a }).callout, /both must be filed/);
});
await check("(s8) MUST-PASS: Oregon's cited state rule still settles an Oregon AHJ's seeded profile (OAR 918-050-0180)", () => {
  const p = project({ state: "OR", ahj: "City of Fernhollow", city: "Fernhollow", utility: "Portland General Electric" });
  const a = appDocs.permitStructureAnswer(p);
  assert.equal(a.structure, "separate");
  assert.equal(a.level, "state_rule");
  assert.match(a.basis, /918-050-0180/);
});

// ── GAP 4: what the lookup found reaches the card ─────────────────────────────────────────────
console.log("\nGAP 4 — the found portal reaches the tracks");
await check("(c1) MUST-PASS: the lookup's cited portal and record type are the permit track's channel and portal URL", () => {
  lookup("NM", "City of Valle Verde", { permits: [{ discipline: "combo", label: "Residential Solar", issuingAgency: none(),
    portalUrl: cited("https://valleverdenm-energovweb.tylerhost.net/apps/selfservice#/home", "https://valleverde.example.gov/permits", "Apply online in the Valle Verde permit portal"),
    recordType: cited("Residential Solar", "https://valleverde.example.gov/permits", "Choose the Residential Solar permit type"), documents: none(), fee: none() }] });
  const t = trackOf(project({ ahj: "City of Valle Verde", city: "Valle Verde" }), "combo") as ReturnType<typeof trackOf> & { channelBasis?: string };
  assert.match(t.channel, /valleverdenm-energovweb\.tylerhost\.net/);
  assert.match(t.channel, /record type "Residential Solar"/);
  assert.equal(t.channelBasis, "cited");
  assert.equal(t.recipePortalUrl, "https://valleverdenm-energovweb.tylerhost.net/apps/selfservice#/home");
  assert.doesNotMatch(t.nextAction, /not yet identified/);
});
await check("(c2) MUST-EXCLUDE: a utility portal or an information page the lookup stored is never a permit channel (rule 5)", () => {
  lookup("NM", "City of Los Alamitos Viejos", { permits: [{ discipline: "combo", label: "Solar", issuingAgency: none(),
    portalUrl: cited("https://mesaelectric.powerclerk.com/MvcAccount/Login", "https://losalamitos.example.gov/solar", "Apply with the Mesa Electric PowerClerk portal"),
    recordType: none(), documents: none(), fee: none() }] });
  const t = trackOf(project({ ahj: "City of Los Alamitos Viejos" }), "combo");
  assert.doesNotMatch(t.channel, /powerclerk/i);
  assert.doesNotMatch(String(t.recipePortalUrl || ""), /powerclerk/i);
});
await check("(c3) MUST-PASS: 'no online portal — paper' that the lookup found is shown as its finding, not 'Unknown'", () => {
  lookup("NM", "City of Paperton", { permits: [{ discipline: "combo", label: "Solar", issuingAgency: none(),
    portalUrl: none("No online portal — building permits must be dropped off in person"), recordType: none(), documents: none(), fee: none() }] });
  const t = trackOf(project({ ahj: "City of Paperton" }), "combo");
  assert.match(t.channel, /^No online application portal found — No online portal — building permits must be dropped off in person/);
  assert.doesNotMatch(t.channel, /^Unknown/);
});

// ── GAP 3: the utility filing location ────────────────────────────────────────────────────────
console.log("\nGAP 3 — where the utility application is filed");
const stub = (text: string, resultUrls: string[], grounded = 2) => ({
  webLookup: async () => ({ text, groundedSearches: grounded, stopReason: "end_turn", resultUrls, pagesRead: 0, fetchedUrls: [] }),
}) as never;
const ans = (filing: unknown, program: unknown) => JSON.stringify({ filing, program });
await check("(u1) MUST-PASS: a cited filing portal + export-credit program → stored, and the card says what it IS", async () => {
  const run = await ufl.runUtilityFilingLookup(db, stub(ans(
    { value: { name: "Gridline PowerClerk", url: "https://gridline.powerclerk.com/MvcAccount/Login" }, sourceUrl: "https://www.gridline-electric.example.com/solar/contractors", quote: "Contractors submit the interconnection application through Gridline PowerClerk." },
    { value: "net_billing", programName: "Export Credit Plan", sourceUrl: "https://www.gridline-electric.example.com/solar/plans", quote: "Exported energy is credited to your bill at 3.1 cents per kWh." },
  ), ["https://www.gridline-electric.example.com/solar/contractors", "https://www.gridline-electric.example.com/solar/plans", "https://gridline.powerclerk.com/MvcAccount/Login"]),
  { state: "NM", utility: "Gridline Electric" });
  assert.equal(run.saved, true, run.reason);
  const p = project({ ahj: "Village of Lomita", utility: "Gridline Electric" });
  const t = trackOf(p, "nem") as ReturnType<typeof trackOf> & { channelBasis?: string };
  assert.match(t.label, /export credit \(net billing — not net metering\) — Export Credit Plan/);
  assert.doesNotMatch(t.label, /\bNEM\b/);
  assert.match(t.channel, /Gridline PowerClerk — https:\/\/gridline\.powerclerk\.com/);
  assert.match(t.channel, /cited/);
  assert.equal(t.recipePortalUrl, "https://gridline.powerclerk.com/MvcAccount/Login");
});
await check("(u2) MUST-EXCLUDE: a PERMIT portal is never the utility's filing location (rule 5) — the URL is dropped", async () => {
  const run = await ufl.runUtilityFilingLookup(db, stub(ans(
    { value: { name: "City permit portal", url: "https://canyoncitytx-energovweb.tylerhost.net/apps/selfservice" }, sourceUrl: "https://canyon-power.example.com/solar", quote: "Apply through the City permit portal for interconnection" },
    { value: null, notFound: "no program page" },
  ), ["https://canyon-power.example.com/solar", "https://canyoncitytx-energovweb.tylerhost.net/apps/selfservice"]),
  { state: "TX", utility: "Canyon Power" });
  assert.equal(run.lookup?.filing.value?.url ?? null, null);
  assert.ok(run.dropped.some((d) => /tylerhost/.test(d)), run.dropped.join("; "));
  assert.doesNotMatch(trackOf(project({ state: "TX", ahj: "City of Canyon", utility: "Canyon Power" }), "nem").channel, /tylerhost/);
});
await check("(u3) MUST-EXCLUDE: a portal whose own host no search returned is not kept (no URL from memory)", async () => {
  const run = await ufl.runUtilityFilingLookup(db, stub(ans(
    { value: { name: "Ridge Power PowerClerk", url: "https://ridgepower.powerclerk.com/" }, sourceUrl: "https://ridgepower.example.com/solar", quote: "Submit on the Ridge Power PowerClerk portal" },
    { value: null },
  ), ["https://ridgepower.example.com/solar"]),
  { state: "NM", utility: "Ridge Power" });
  assert.equal(run.lookup?.filing.value?.url ?? null, null);
  assert.equal(run.lookup?.filing.value?.name, "Ridge Power PowerClerk");
});
await check("(u4) MUST-EXCLUDE: 'net metering' is never the label by default, nor on a quote that does not say it", async () => {
  const run = await ufl.runUtilityFilingLookup(db, stub(ans(
    { value: null },
    { value: "net_metering", sourceUrl: "https://plains-coop.example.com/solar", quote: "Members may install rooftop solar after signing an agreement." },
  ), ["https://plains-coop.example.com/solar"]),
  { state: "NM", utility: "Plains Cooperative" });
  assert.equal(run.lookup?.program.value ?? null, null);
  const t = trackOf(project({ ahj: "Village of Lomita", utility: "Plains Cooperative" }), "nem");
  assert.equal(t.label, "Utility interconnection application (net-metering program not yet confirmed)");
  // No lookup at all (a utility nobody looked up): the same honest label.
  assert.equal(trackOf(project({ ahj: "Village of Lomita", utility: "Nobody Looked Electric" }), "nem").label, "Utility interconnection application (net-metering program not yet confirmed)");
});
await check("(u5) MUST-PASS: a wires-only utility whose page names the retail provider → 'interconnection only'", async () => {
  await ufl.runUtilityFilingLookup(db, stub(ans(
    { value: { name: "Installer portal", url: "https://dg.wiresco.example.com/installers" }, sourceUrl: "https://www.wiresco.example.com/installers", quote: "Installers must register and submit projects via the installer portal at dg.wiresco.example.com" },
    { value: "interconnection_only", sourceUrl: "https://www.wiresco.example.com/installers", quote: "Any credit for exported energy is set by your retail electric provider (REP)." },
  ), ["https://www.wiresco.example.com/installers", "https://dg.wiresco.example.com/installers"]),
  { state: "TX", utility: "WiresCo Delivery" });
  const t = trackOf(project({ state: "TX", ahj: "City of Canyon", utility: "WiresCo Delivery" }), "nem");
  assert.match(t.label, /^Utility interconnection only \(no utility net metering\)/);
  assert.match(t.channel, /dg\.wiresco\.example\.com/);
});
await check("(u6) MUST-EXCLUDE: an ungrounded answer keeps nothing; a verified row is never overwritten (hard rule 3)", async () => {
  const run = await ufl.runUtilityFilingLookup(db, stub(ans(
    { value: { name: "Memory Portal", url: "https://memory.powerclerk.com/" }, sourceUrl: "https://memory.example.com", quote: "Submit on the Memory Portal" }, { value: "net_metering", sourceUrl: "https://memory.example.com", quote: "net metering" },
  ), ["https://memory.example.com"], 0), { state: "NM", utility: "Memory Electric" });
  assert.equal(run.lookup?.filing.value ?? null, null);
  assert.equal(run.lookup?.program.value ?? null, null);
  ufl.saveUtilityFilingLookup(db, { state: "NM", utility: "Verified Electric", confidence: "verified", lookedUpAt: new Date().toISOString(),
    filing: cited({ name: "Verified PowerClerk", url: "https://verified.powerclerk.com/" }, "https://verified.example.com", "Use Verified PowerClerk"),
    program: cited("net_metering", "https://verified.example.com", "Net metering rider") }, { verifiedBy: "ops" });
  const again = await ufl.runUtilityFilingLookup(db, stub(ans({ value: null }, { value: null }), ["https://x.example.com"]), { state: "NM", utility: "Verified Electric", force: true });
  assert.equal(again.saved, false);
  assert.equal(ufl.getUtilityFilingLookup(db, "NM", "Verified Electric")?.filing.value?.name, "Verified PowerClerk");
  assert.match(trackOf(project({ ahj: "Village of Lomita", utility: "Verified Electric" }), "nem").channel, /verified by a person/);
});

console.log(failures ? `\nnewAhjTracks: ${failures} check(s) FAILED` : "\nnewAhjTracks: all checks passed");
process.exit(failures ? 1 : 0);
