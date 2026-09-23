// THE BLD+ELE GAP: NOTHING EVER COMPUTED "THE DOCUMENTS THIS PROJECT MUST PRODUCE".
//
// Coos Bay files a SEPARATE building (BLD) permit and electrical (ELE) permit — its process
// profile says so in two flags, permitStructureFromAhjProcess reads them to return "separate",
// requiredTracks() splits on them, and the operator's screen prints "Separate building (BLD) +
// electrical (ELE) permits — both must be filed". The permit STRUCTURE knew about two permits.
// The DOCUMENT side never asked it:
//
//   1. Form acquisition asked for a hardcoded ["permit_application"] and one checklist flag.
//      The electrical application was acquired by luck or never. Worse, Coos Bay's blank is
//      STORED as building_application (the form's own name decides the type), so the
//      permit_application existence check never matched and every "Find official form" click
//      re-ran a paid research pass — and still never asked for the electrical one.
//   2. requiredDocuments' baseline is the plan-set family. Not one permit APPLICATION. The
//      permit path was resolved on line 128 and then never read.
//   3. Presence was read from project_documents only, while filled AHJ forms live on disk in
//      backend/data/filled/<projectId>/ with no row — so even a built-and-filled application
//      read as missing.
//
// Both gates therefore went green with one of two required permit applications never acquired.
//
//   MUST DEMAND BOTH  — a separate-structure AHJ needs a building-side application AND an
//                       electrical application, both blocking, in the discipline vocabulary
//                       recipeDisciplineForTrack already defines.
//   MUST NOT DEMAND   — the prescriptive and structural applications are MUTUALLY EXCLUSIVE.
//   BOTH BUILDING       "Please upload only the application that pertains — DO NOT upload
//   APPLICATIONS        both." A set that tells a prescriptive project to attach the
//                       structural application is as wrong as filing neither.
//   PATH-INDEPENDENT  — the electrical application does not care about the permit path. That
//                       orthogonality is the whole fix.
//   THE GATE FAILS    — missing electrical application => documentInventory blocks and
//                       prepareSubmission 409s, naming the document and why.
//   AND CLEARS ON A   — a FILLED form on disk satisfies the row, not only an upload.
//   FILLED FORM
//   NO OVER-BLOCK     — combo/unknown structure demands nothing as a hard blocker, because
//                       these are 380+ spreadsheet-imported flags.
//
// AND THEN: THE DISTINCTION WAS EXPRESSED AND NEVER READ. `applicationKind` was declared,
// set, and consulted NOWHERE in production — only here, in 398 lines of passing assertions
// against functions nothing called. What that cost, each pinned below:
//
//   THE FORBIDDEN     — a stale STRUCTURAL fill left on disk by a path flip satisfied the
//   UPLOAD              PRESCRIPTIVE row and was packaged for upload. Coos Bay prints
//                       "upload ONLY the prescriptive application. ... Do NOT also upload
//                       the structural application" — the gate green-lit the violation.
//   INVERTED NAME     — "Non-Prescriptive" CONTAINS "prescriptive", and the prescriptive
//   CLASSIFICATION      test ran first, so the AHJ's own name for the ENGINEERED form
//                       classified as the prescriptive one. Exactly backwards.
//   ONE SLOT, TWO     — whichever building-side blank was acquired first overwrote and then
//   FORMS               permanently blocked the other.
//   PATH-BLIND        — acquisition kept item.docType and threw applicationKind away, so a
//   ACQUISITION         prescriptive project researched a generic "building application".
//   TRACK BLEED       — both applications are lane 'permit' and blocking, so staging the
//                       BUILDING track alone 409'd over the ELECTRICAL application.
//   THE SENTENCE      — "No critical document fields missing from the generated packet" came
//                       out of fifteen SCALAR field checks that never look at a document.
//
//   npx tsx backend/test/requiredApplicationSet.test.ts
import { REPO } from "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ page-images never land in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "required-app-set-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.ANTHROPIC_API_KEY = ""; // stub LLM — deterministic, no network research

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
// The REAL staging filter and the REAL packaging expression, imported rather than
// restated. See "THE FILTER ITSELF, NOT A COPY OF IT" below.
const {
  createProject,
  stagingMissingDocuments,
  packagedDocumentsByType,
  getApplicationDocumentPackage,
  addManualCorrection,
  captureConfirmation,
} = await import("../src/repository");
const {
  applicationDocContext,
  documentInventory,
  requiredApplicationDocs,
  requiredDocuments,
} = await import("../src/requiredDocuments");
const { permitStructureForProject } = await import("../src/applicationDocs");
const { resolvePermitPath } = await import("../src/permitPath");
const { findAhjProcessProfile } = await import("../src/processProfiles");
const { recipeDisciplineForTrack } = await import("../src/portalChannel");
const { ensureAhjFormsForProject, storeAhjFormTemplate, hasStoredTemplateOfType } = await import("../src/ahjFormAuto");
const {
  loadStoredTemplates,
  formApplicationKind,
  formAllowedForPath,
  filledFormsByDocType,
  storedApplicationKind,
  buildFilledFormsForProject,
} = await import("../src/ahjForms");
const { createLLMProvider } = await import("../src/llm");
const { submissionDocumentsByType, uploadDocumentGuard } = await import("../src/submissionDocuments");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ok   - ${label}`); })
    .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

const client = createClient(db, { companyName: "BLD ELE Solar", ccbLicenseNumber: "778899" });
let n = 0;
/** A real Coos Bay project. `permitPathOverride` is the operator's own dropdown choice —
 *  the strongest permit-path signal — so the fixture is not at the mercy of parsed structural
 *  data it does not have. */
const mk = (permitPathOverride?: string) => createProject(db, {
  clientId: client.id, owner: `BLD Owner ${++n}`, street: `${n} Bay St`, city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
  ...(permitPathOverride ? { permitPathOverride } : {}),
}).project;

// A REAL FILE ON DISK: projectDocsByType requires fs.existsSync(stored_path), so a row that
// points at nothing is correctly not a document.
const attach = (pid: string, docType: string): void => {
  const file = path.join(tmpDir, `${pid}-${docType}.pdf`);
  fs.writeFileSync(file, "%PDF-1.4 test fixture");
  db.run(
    `INSERT INTO project_documents (id, project_id, doc_type, original_filename, stored_path, source, uploaded_at)
     VALUES (?, ?, ?, ?, ?, 'upload', ?)`,
    [`${pid}-${docType}`, pid, docType, `${docType}.pdf`, file, new Date().toISOString()],
  );
};
const PLAN_SET_FAMILY = ["plan_set", "site_plan", "sld", "structural", "module_spec", "inverter_spec", "labels"];

// backend/data/filled/<projectId>/ is REPO-RELATIVE (ahjForms.ts resolves it off cwd), so
// every directory this test creates there is torn down in the finally below.
const FILLED_ROOT = path.resolve(process.cwd(), "backend/data/filled");
const filledDirs: string[] = [];
/** Build a filled form the way the real fill path does: a stored template (so its form_type
 *  is the AHJ's own classification) plus a PDF at backend/data/filled/<pid>/tmpl-<id>.pdf. */
// Filled-form fixtures are stored under their OWN AHJ, never Coos Bay. filledFormsByDocType
// resolves a filled PDF by TEMPLATE ID, so the AHJ name is irrelevant to it — but
// hasStoredTemplateOfType is keyed on the AHJ, and a fixture blank parked under Coos Bay
// silently answers the acquisition checks below.
const FILLED_FIXTURE_AHJ = "City of Filledformville";
const buildFilledForm = (pid: string, formType: string, filename: string): string => {
  const templateId = storeAhjFormTemplate(db, {
    ahjName: FILLED_FIXTURE_AHJ, state: "OR", formType, filename,
    bytes: new Uint8Array(Buffer.from("%PDF-1.4 blank")),
    map: { formName: filename.replace(/\.pdf$/, ""), sourceUrl: "", fillMode: "acroform", textFields: {}, checkboxes: {}, notes: "" },
  });
  placeFilledForm(pid, templateId);
  return templateId;
};
/** Drop an already-stored template's filled PDF into another project's filled dir —
 *  the same blank filled for a second project, which is exactly what happens in life. */
const placeFilledForm = (pid: string, templateId: string): void => {
  const dir = path.join(FILLED_ROOT, pid);
  fs.mkdirSync(dir, { recursive: true });
  filledDirs.push(dir);
  fs.writeFileSync(path.join(dir, `tmpl-${templateId}.pdf`), "%PDF-1.4 filled");
};

// THE FILTER ITSELF, NOT A COPY OF IT.
//
// This used to be a local `stagingWouldRefuse` that RE-IMPLEMENTED prepareSubmission's
// lane filter, under a check claiming "...and that is exactly the list prepareSubmission
// turns into its 409". A copy of a filter cannot notice the original drifting — and the
// original did drift (it grew a discipline dimension), which a copy would have sailed
// straight past while still claiming to pin it. The filter is now an exported function
// that prepareSubmission calls and this test calls; there is one of it.
const stagingWouldRefuse = (project: object, track?: string) =>
  stagingMissingDocuments(documentInventory(db, project as never), track as never);

// ---------------------------------------------------------------------------
// FIXTURE PREMISES — asserted, not assumed. If the snapshot override is dropped or the
// seeded Coos Bay row changes, every check below would silently test the wrong thing.
// ---------------------------------------------------------------------------
const prescriptive = mk("prescriptive");
const engineered = mk("engineered");

await check("PREMISE: Coos Bay's seeded process profile really does carry BOTH permit-application flags", () => {
  const proc = findAhjProcessProfile(prescriptive as never);
  assert.ok(proc, "no process profile matched City of Coos Bay / OR");
  assert.equal(proc!.requiresBuildingPermitApplication, true);
  assert.equal(proc!.requiresElectricalPermitApplication, true);
});

await check("PREMISE: the fixture resolves to a SEPARATE structure and a known permit path", () => {
  assert.equal(permitStructureForProject(prescriptive as never), "separate");
  assert.equal(resolvePermitPath(prescriptive as never).path, "prescriptive");
  assert.equal(resolvePermitPath(engineered as never).path, "engineered");
});

const ctxFor = (p: object) => applicationDocContext(p as never);
const setFor = (p: object) => requiredApplicationDocs(p as never, ctxFor(p));

// ---------------------------------------------------------------------------
// THE HEADLINE
// ---------------------------------------------------------------------------
await check("MUST DEMAND BOTH: a separate-permit AHJ needs a building-side AND an electrical application, both blocking", () => {
  const set = setFor(prescriptive);
  const building = set.find((d) => d.docType === "building_application");
  const electrical = set.find((d) => d.docType === "electrical_application");
  assert.ok(building, `no building-side application demanded: ${JSON.stringify(set.map((d) => d.docType))}`);
  assert.ok(electrical, "THE GAP: the electrical permit application was never in the required set");
  assert.equal(building!.discipline, "structural");
  assert.equal(electrical!.discipline, "electrical");
  assert.equal(building!.blocking, true);
  assert.equal(electrical!.blocking, true);
});

// ---------------------------------------------------------------------------
// PORTAL-ENTRY-ONLY: no application PDF exists anywhere, so nothing may BLOCK on
// one — but the rows stay VISIBLE and say where the application actually lives
// (operator, 2026-09-21: "If no files found needed, call it out"). Salem's own
// acquisition run says "online-only portal — no PDF template needed" while the
// doc gate blocked Reavis's staging on the very same nonexistent PDFs.
// ---------------------------------------------------------------------------
await check("PORTAL-ONLY MUST NOT BLOCK: the same separate-structure demands stop blocking when the AHJ is portal-entry-only", () => {
  const set = requiredApplicationDocs(prescriptive as never, { ...ctxFor(prescriptive), requiresPortalEntryOnly: true });
  const building = set.find((d) => d.docType === "building_application");
  const electrical = set.find((d) => d.docType === "electrical_application");
  assert.ok(building, "the row must STAY VISIBLE — dropping it silently hides what the portal run owes");
  assert.ok(electrical, "the electrical row must stay visible too");
  assert.equal(building!.blocking, false, "no PDF exists — blocking on it is a demand nobody can satisfy");
  assert.equal(electrical!.blocking, false);
  assert.match(building!.why, /online portal.*no application PDF exists/i, "the row must SAY why no file is owed");
  assert.match(electrical!.why, /online portal.*no application PDF exists/i);
});

await check("PORTAL-ONLY PREMISE: a City of Salem project resolves requiresPortalEntryOnly from its own profile", () => {
  const salem = { ...(prescriptive as object), ahj: "City of Salem" };
  const ctx = ctxFor(salem);
  assert.equal(ctx.requiresPortalEntryOnly, true, "salem-pac-solar-array carries requiresPortalEntryOnly: true");
});

await check("PORTAL-ONLY MUST EXCLUDE: a PDF-taking AHJ (Coos Bay) keeps both rows blocking", () => {
  const ctx = ctxFor(prescriptive);
  assert.equal(Boolean(ctx.requiresPortalEntryOnly), false, "Coos Bay takes PDFs — the flag must not leak");
  const set = requiredApplicationDocs(prescriptive as never, ctx);
  assert.equal(set.find((d) => d.docType === "building_application")!.blocking, true);
  assert.equal(set.find((d) => d.docType === "electrical_application")!.blocking, true);
});

await check("...and each says WHY, naming the AHJ whose requirement it is", () => {
  const set = setFor(prescriptive);
  for (const d of set) {
    assert.match(d.why, /Coos Bay/, `a requirement with no attributable source: ${d.docType} — ${d.why}`);
  }
  assert.match(set.find((d) => d.docType === "electrical_application")!.why, /SEPARATE/,
    "the electrical row must say what makes it required");
});

await check("DISCIPLINE VOCABULARY: every discipline emitted is one recipeDisciplineForTrack already produces", () => {
  // Migration v22 and feeSchedules.ts import that function rather than restating it; a
  // parallel "building" discipline here would silently miss every filter keyed on the real one.
  const known = new Set(["building", "electrical", "combo", "mpu", "nem", null].map((t) => recipeDisciplineForTrack(t as never)));
  for (const d of setFor(prescriptive)) {
    assert.ok(known.has(d.discipline), `${d.docType} claims discipline "${d.discipline}", which no submittal track maps to`);
  }
  // The track↔discipline mapping this relies on: `building` is `structural`, not "building".
  assert.equal(recipeDisciplineForTrack("building"), "structural");
});

// ---------------------------------------------------------------------------
// THE TWO AXES ARE ORTHOGONAL — the part a "generate everything" fix gets wrong
// ---------------------------------------------------------------------------
await check("MUST NOT DEMAND BOTH BUILDING APPLICATIONS: prescriptive path demands the prescriptive one only", () => {
  const set = setFor(prescriptive);
  const kinds = set.map((d) => d.applicationKind).filter(Boolean);
  assert.deepEqual(kinds, ["prescriptive"],
    `the AHJ takes exactly one building-side application; got ${JSON.stringify(kinds)}`);
  const building = set.find((d) => d.docType === "building_application")!;
  assert.match(building.label, /Prescriptive/i);
  assert.match(building.why, /PRESCRIPTIVE/,
    "the row must say which of the two mutually exclusive applications to file");
});

await check("...and the engineered path demands the structural one only", () => {
  const set = setFor(engineered);
  const kinds = set.map((d) => d.applicationKind).filter(Boolean);
  assert.deepEqual(kinds, ["structural"], `got ${JSON.stringify(kinds)}`);
  const building = set.find((d) => d.docType === "building_application")!;
  assert.match(building.label, /Structural/i);
  assert.doesNotMatch(building.label, /^Prescriptive/i);
});

await check("ELECTRICAL IS PATH-INDEPENDENT: it is demanded, and blocking, on BOTH paths", () => {
  for (const [name, p] of [["prescriptive", prescriptive], ["engineered", engineered]] as const) {
    const electrical = setFor(p).find((d) => d.docType === "electrical_application");
    assert.ok(electrical, `${name} path dropped the electrical application`);
    assert.equal(electrical!.blocking, true, `${name} path: the electrical application must block`);
    assert.equal(electrical!.applicationKind, undefined,
      "the electrical application is not one of the two path-chosen applications");
  }
});

// ---------------------------------------------------------------------------
// THE GATE
// ---------------------------------------------------------------------------
const missingEle = mk("prescriptive");
for (const d of [...PLAN_SET_FAMILY, "building_application"]) attach(missingEle.id, d);

await check("THE GATE FAILS: building application attached, electrical absent — the inventory blocks and names it", () => {
  const inv = documentInventory(db, missingEle as never);
  const blocked = inv.missingBlocking.map((d) => d.docType);
  assert.ok(blocked.includes("electrical_application"),
    `the gate went green with one of two required permit applications missing: ${JSON.stringify(blocked)}`);
  assert.ok(!blocked.includes("building_application"), "the attached building application must count as present");
  const row = inv.missingBlocking.find((d) => d.docType === "electrical_application")!;
  assert.match(row.label, /[Ee]lectrical/, "the operator has to be told WHICH document");
  assert.match(row.why, /Coos Bay/, "…and why it is required");
  assert.ok(stagingWouldRefuse(missingEle, "electrical").length > 0,
    "the filter prepareSubmission applies drops it, so staging would still go through");
});

await check("...and that is exactly the list prepareSubmission turns into its 409", () => {
  // prepareSubmission is reached only after the QC / human-review / reviewer-blocker gates,
  // which a fixture project trips for unrelated reasons (a bare parse has no SLD, no fire
  // pathways, no framing...). So the DOCUMENT gate is exercised through the REAL exported
  // filter prepareSubmission calls — not a restatement of it — and the WIRING (that
  // prepareSubmission still calls that filter, and still 409s on what it returns) is pinned
  // by source, the way credentialLockout.test.ts does.
  const kept = stagingWouldRefuse(missingEle, "electrical");
  assert.match(kept.map((d) => d.label).join("; "), /[Ee]lectrical/,
    "the 409 interpolates these labels and nothing else — it must name the document");
  const src = fs.readFileSync(path.join(REPO, "backend", "src", "repository.ts"), "utf8");
  const at = src.indexOf("const inv = documentInventory(db, detail.project);");
  assert.ok(at > -1, "prepareSubmission no longer consults documentInventory at all");
  const window = src.slice(at, at + 900);
  assert.match(window, /stagingMissingDocuments\(inv, track\)/,
    "the gate must call the SAME exported filter this test calls — an inline copy is how the two drift apart");
  assert.match(window, /Submission staging blocked: required document\(s\) not attached/,
    "…and refuse with a 409 that names them");
});

// FIXTURE COMPLETION under the concurrent requiredDocuments.ts change that makes the
// prescriptive solar checklist a BLOCKING row on a confirmed prescriptive path. Only the
// attachment list grows; not one assertion below is altered. Attaching a document can only
// SATISFY a demand, so these fixtures stay correct whether or not that change lands.
const bothUploaded = mk("prescriptive");
for (const d of [...PLAN_SET_FAMILY, "building_application", "electrical_application", "solar_checklist"]) attach(bothUploaded.id, d);

await check("THE GATE ACCEPTS when both applications are present", () => {
  const inv = documentInventory(db, bothUploaded as never);
  assert.deepEqual(inv.missingBlocking.map((d) => d.docType), [],
    `a complete filing was blocked: ${JSON.stringify(inv.missingBlocking.map((d) => `${d.label}: ${d.why}`))}`);
});

const filledOnly = mk("prescriptive");
for (const d of [...PLAN_SET_FAMILY, "building_application", "solar_checklist"]) attach(filledOnly.id, d);
buildFilledForm(filledOnly.id, "electrical_application", "Coos Bay Electrical Permit Application.pdf");

await check("learn and replay use the same explicit upload when a generated application also exists", () => {
  const project = mk("prescriptive");
  buildFilledForm(project.id, "electrical_application", "Electrical Permit Application.pdf");
  const generated = submissionDocumentsByType(db, project as never).electrical_application;
  assert.ok(generated?.includes("tmpl-"), "the generated application is available before upload");
  attach(project.id, "electrical_application");
  const explicit = path.join(tmpDir, `${project.id}-electrical_application.pdf`);
  assert.equal(submissionDocumentsByType(db, project as never).electrical_application, explicit);
  assert.equal(packagedDocumentsByType(db, project as never).electrical_application, explicit);
  assert.notEqual(explicit, generated);
});

await check("THE GATE CLEARS ON A FILLED FORM, NOT ONLY AN UPLOAD", () => {
  // Filled forms live in backend/data/filled/<pid>/ with no project_documents row, which is
  // why prepareSubmission has to merge filledFormsByDocType before it packages anything. The
  // inventory read only the uploads, so it called a built-and-filled application missing.
  const inv = documentInventory(db, filledOnly as never);
  assert.deepEqual(inv.missingBlocking.map((d) => d.docType), [],
    `a filled electrical application did not satisfy the row: ${JSON.stringify(inv.missingBlocking.map((d) => d.label))}`);
  const row = inv.presence.find((d) => d.docType === "electrical_application")!;
  assert.equal(row.present, true);
  assert.match(row.via, /filled form/, `presence should say where it came from: "${row.via}"`);
});

const genericBlank = mk("prescriptive");
for (const d of [...PLAN_SET_FAMILY, "permit_application", "electrical_application", "solar_checklist"]) attach(genericBlank.id, d);

await check("DOCTYPE DEAD-END GUARD: the generic permit_application satisfies the BUILDING-side row", () => {
  // "Prescriptive Solar Photovoltaic Installation Permit Application" matches neither
  // /building|structural/ nor /checklist|worksheet/, so classifyFormType stores it under the
  // generic key. A row that only accepts building_application would demand a document that is
  // already on disk — the one-letter-apart bug, rebuilt from the other side.
  const inv = documentInventory(db, genericBlank as never);
  assert.deepEqual(inv.missingBlocking.map((d) => d.docType), [],
    `the generic blank was not accepted: ${JSON.stringify(inv.missingBlocking.map((d) => d.label))}`);
});

await check("...but that generic blank does NOT also satisfy the ELECTRICAL row", () => {
  // One file must never paper over two permits.
  const p = mk("prescriptive");
  for (const d of [...PLAN_SET_FAMILY, "permit_application", "solar_checklist"]) attach(p.id, d);
  const blocked = documentInventory(db, p as never).missingBlocking.map((d) => d.docType);
  assert.deepEqual(blocked, ["electrical_application"], `got ${JSON.stringify(blocked)}`);
});

// ---------------------------------------------------------------------------
// NO OVER-BLOCKING — these are 380+ seeded, spreadsheet-imported flags, and this is the
// first place one of them can stop a filing.
// ---------------------------------------------------------------------------
await check("COMBO does not over-block: one application, demanded but not blocking", () => {
  const set = requiredApplicationDocs(prescriptive as never, { permitStructure: "combo", ahjLabel: "Combo City" });
  assert.equal(set.length, 1, `a combined permit is ONE filing: ${JSON.stringify(set.map((d) => d.docType))}`);
  assert.equal(set[0].discipline, "combo");
  assert.equal(set[0].blocking, false, "only a 'separate' structure — the signal the operator already sees — may block");
});

await check("UNKNOWN structure demands nothing as blocking, and an unknown AHJ demands nothing at all", () => {
  const flagged = requiredApplicationDocs(prescriptive as never, {
    permitStructure: "unknown",
    processFlags: { requiresBuildingPermitApplication: true, requiresElectricalPermitApplication: true },
    ahjLabel: "Rumour County",
  });
  assert.ok(flagged.length > 0, "a flagged AHJ should still surface the documents, as advisories");
  assert.deepEqual(flagged.filter((d) => d.blocking), [], "an unresolved structure must never hard-block");
  assert.deepEqual(requiredApplicationDocs(prescriptive as never, {}), [],
    "no structure and no flags means no demand — we cannot name a document we know nothing about");
});

await check("AN UNCONFIRMED PERMIT PATH does not double-block", () => {
  // Staging already refuses outright on an unknown path with a message that says exactly what
  // to do. A second, vaguer blocker for the application it cannot choose only muddies that.
  const unknownPath = mk();
  assert.equal(resolvePermitPath(unknownPath as never).path, "unknown", "fixture premise");
  const set = setFor(unknownPath);
  const building = set.find((d) => d.docType === "building_application")!;
  assert.equal(building.blocking, false);
  assert.equal(building.applicationKind, undefined, "neither application may be named before the path is");
  assert.equal(set.find((d) => d.docType === "electrical_application")!.blocking, true,
    "the electrical application does not depend on the path, so it still blocks");
});

await check("A BARE PROJECT IS STILL SAFE: no ahj/state, no application demands, no throw", () => {
  // requiredDocuments is called DB-free with objects like this (conditionalStampDocs.test.ts).
  // permitStructureForProject would throw on them, which is why the lookups live in
  // applicationDocContext and are threaded in rather than done inside the pure function.
  const bare = { utility: "PGE", systemSizeDcKw: 8, parserSnapshot: { mounting: "Roof Mount" } } as never;
  const items = requiredDocuments(bare);
  assert.deepEqual(items.filter((i) => i.docType.endsWith("_application")), []);
  assert.ok(items.some((i) => i.docType === "plan_set"), "the plan-set baseline must be untouched");
});

// ---------------------------------------------------------------------------
// THE DISTINCTION MUST BE REAL AT RUNTIME, NOT JUST EXPRESSED.
//
// The round that added applicationKind DECLARED it and SET it and then read it
// nowhere in production. Everything below is a consequence of that, and every check
// here fails with the distinction removed.
//
// Coos Bay prints both instructions at once, and they are both true:
//   "Prescriptive path — upload ONLY the prescriptive application. ... Do NOT also
//    upload the structural application."
//   "Separate building (BLD) + electrical (ELE) permits — both must be filed."
// Two permits; exactly ONE of the two mutually-exclusive building-side forms.
// ---------------------------------------------------------------------------

// A project FILLED on the engineered path, then flipped to prescriptive. Nothing
// deletes backend/data/filled/<pid>/, so the STRUCTURAL pdf is still sitting there.
const flipped = mk("prescriptive");
for (const d of [...PLAN_SET_FAMILY, "electrical_application"]) attach(flipped.id, d);
const structuralTemplateId = buildFilledForm(flipped.id, "building_application", "Coos Bay Structural (non-prescriptive) Permit Application.pdf");

await check("A STALE STRUCTURAL FILL DOES NOT SATISFY THE PRESCRIPTIVE ROW", () => {
  // Both applications key to building_application, so the leftover structural PDF
  // reported the prescriptive row as present "via: filled form" — the gate that exists
  // to prevent the double upload green-lighting it instead.
  const inv = documentInventory(db, flipped as never);
  const row = inv.presence.find((d) => d.docType === "building_application")!;
  assert.equal(row.applicationKind, "prescriptive", "fixture premise: this project owes the PRESCRIPTIVE application");
  assert.equal(row.present, false,
    `a STRUCTURAL application satisfied the PRESCRIPTIVE row (via: "${row.via}") — the AHJ takes exactly one, and this is the upload it forbids`);
  assert.ok(inv.missingBlocking.map((d) => d.docType).includes("building_application"),
    "…so the prescriptive application must read as still missing");
});

await check("…AND IT IS NOT PACKAGED FOR UPLOAD", () => {
  // The other half, and the one that actually reaches the jurisdiction: the packaging
  // expression prepareSubmission hands to the portal upload sweep.
  const packaged = packagedDocumentsByType(db, flipped as never);
  const stale = path.join(FILLED_ROOT, flipped.id, `tmpl-${structuralTemplateId}.pdf`);
  assert.ok(!Object.values(packaged).includes(stale),
    `the stale STRUCTURAL application was packaged for upload as ${JSON.stringify(Object.entries(packaged).find(([, f]) => f === stale))} — "Do NOT also upload the structural application"`);
  assert.equal(packaged.building_application, undefined,
    "nothing may occupy the building-side upload slot when the only candidate is the wrong one of the two");
  // AND WITH NO PATH ARGUMENT AT ALL. autoLearn's upload sweep has only a projectId in
  // hand and calls filledFormsByDocType(db, projectId) — a second door onto the same
  // portal upload. It is not downstream of the staging document gate (the learn job can
  // be queued on its own), so the drop has to hold when nobody passes the path.
  assert.deepEqual(filledFormsByDocType(db, flipped.id), {},
    "the off-path fill came back through the caller that does not know the permit path");
});

await check("NO OVER-BLOCK: the same filled structural form DOES satisfy an ENGINEERED project", () => {
  // The rule is "contradicts the path", not "is an application". A fix that simply
  // stopped trusting filled forms would break every engineered filing to fix this one.
  const onPath = mk("engineered");
  for (const d of [...PLAN_SET_FAMILY, "electrical_application"]) attach(onPath.id, d);
  placeFilledForm(onPath.id, structuralTemplateId);
  const inv = documentInventory(db, onPath as never);
  const row = inv.presence.find((d) => d.docType === "building_application")!;
  assert.equal(row.applicationKind, "structural", "fixture premise");
  assert.equal(row.present, true, `the engineered path's own application was rejected: ${JSON.stringify(inv.missingBlocking.map((d) => d.label))}`);
  assert.match(row.via, /filled form/);
  assert.equal(packagedDocumentsByType(db, onPath as never).building_application,
    path.join(FILLED_ROOT, onPath.id, `tmpl-${structuralTemplateId}.pdf`),
    "…and it is the file that goes up");
});

await check("A GENERIC APPLICATION STILL SATISFIES EITHER PATH", () => {
  // Plenty of AHJs publish ONE application used on both paths. A name that claims
  // neither kind must stay compatible with both — over-blocking those jurisdictions
  // would be the same mistake seen from the other side.
  const generic = mk("prescriptive");
  for (const d of [...PLAN_SET_FAMILY, "electrical_application", "solar_checklist"]) attach(generic.id, d);
  buildFilledForm(generic.id, "building_application", "Coos Bay Residential Permit Application.pdf");
  const inv = documentInventory(db, generic as never);
  assert.deepEqual(inv.missingBlocking.map((d) => d.docType), [],
    `a jurisdiction's single generic application was refused: ${JSON.stringify(inv.missingBlocking.map((d) => d.label))}`);
});

// ---------------------------------------------------------------------------
// BOTH BLANKS MUST BE STORABLE. hasStoredTemplateOfType keyed on one (ahj, form_type)
// slot, so whichever of the two building-side blanks was acquired FIRST overwrote and
// then permanently blocked the other — leaving every project on the other path with
// nothing to file and the system reporting it already had the form.
// ---------------------------------------------------------------------------
const TWO_FORM_AHJ = "City of Twoforms";
const blank = (filename: string, ahjName = TWO_FORM_AHJ) => storeAhjFormTemplate(db, {
  ahjName, state: "OR", formType: "building_application", filename,
  bytes: new Uint8Array(Buffer.from(`%PDF-1.4 ${filename}`)),
  // A mapped field, because loadStoredTemplates skips a template it could not fill.
  map: { formName: filename.replace(/\.pdf$/, ""), sourceUrl: "", fillMode: "acroform", textFields: { Owner: "project.homeownerName" }, checkboxes: {}, notes: "" },
});

await check("NAME CLASSIFICATION: \"Non-Prescriptive\" is the STRUCTURAL form, not the prescriptive one", () => {
  // "non-prescriptive" CONTAINS "prescriptive". Testing /prescriptive/ first classified
  // the AHJ's own name for the ENGINEERED application as the prescriptive one — the fill
  // gate then built it for prescriptive projects and refused it for engineered ones,
  // exactly inverted, on the one pair where being wrong means the forbidden upload.
  assert.equal(formApplicationKind("Structural (Non-Prescriptive) Permit Application"), "structural");
  assert.equal(formApplicationKind("Non-Prescriptive Solar Application"), "structural");
  assert.equal(formApplicationKind("Prescriptive Solar Photovoltaic Installation Permit Application"), "prescriptive");
  assert.equal(formApplicationKind("Residential Permit Application"), null,
    "a form that claims neither kind must stay compatible with both paths");
  assert.equal(formAllowedForPath("Structural (Non-Prescriptive) Permit Application", "engineered"), true);
  assert.equal(formAllowedForPath("Structural (Non-Prescriptive) Permit Application", "prescriptive"), false,
    "the fill gate must refuse to build the structural application for a prescriptive project");
});

await check("ONE AHJ, TWO BUILDING-SIDE BLANKS: storing the second does not destroy the first", () => {
  const prescriptiveId = blank("Prescriptive Solar Photovoltaic Installation Permit Application.pdf");
  const structuralId = blank("Structural Permit Application.pdf");
  assert.notEqual(prescriptiveId, structuralId,
    "the second blank overwrote the first — one slot for two mutually exclusive forms");
  const rows = db.query<{ id: string }>(
    "SELECT id FROM ahj_form_templates WHERE lower(ahj_name) = lower(?) AND form_type = 'building_application'", [TWO_FORM_AHJ]);
  assert.equal(rows.length, 2, `expected both blanks stored, got ${rows.length}`);
  const names = loadStoredTemplates(db, TWO_FORM_AHJ, "OR").map((t) => t.def.formName).sort();
  assert.deepEqual(names, ["Prescriptive Solar Photovoltaic Installation Permit Application", "Structural Permit Application"],
    "both must be loadable for fill — formAllowedForPath picks the one the path calls for");
  // Re-storing the SAME application updates its own row rather than adding a third.
  assert.equal(blank("Prescriptive Solar Photovoltaic Installation Permit Application.pdf"), prescriptiveId,
    "a re-acquisition of the same form must update it, not accumulate duplicates");
});

await check("…and the existence check answers per KIND, not per slot", () => {
  assert.equal(hasStoredTemplateOfType(db, TWO_FORM_AHJ, "OR", "building_application", "prescriptive"), true);
  assert.equal(hasStoredTemplateOfType(db, TWO_FORM_AHJ, "OR", "building_application", "structural"), true);
  // An AHJ holding ONLY the structural blank does not "already have" the prescriptive one.
  const oneSided = "City of Onlystructural";
  blank("Structural (Non-Prescriptive) Permit Application.pdf", oneSided);
  assert.equal(hasStoredTemplateOfType(db, oneSided, "OR", "building_application", "structural"), true);
  assert.equal(hasStoredTemplateOfType(db, oneSided, "OR", "building_application", "prescriptive"), false,
    "a stored STRUCTURAL blank answered YES to 'do we have the prescriptive application?' — acquisition then skipped it forever");
  // A blank that claims NEITHER kind is a jurisdiction's single generic form and counts for both.
  const generic = "City of Onegeneric";
  blank("Residential Permit Application.pdf", generic);
  assert.equal(hasStoredTemplateOfType(db, generic, "OR", "building_application", "prescriptive"), true);
  assert.equal(hasStoredTemplateOfType(db, generic, "OR", "building_application", "structural"), true);
});

// ---------------------------------------------------------------------------
// THE DISCIPLINE FILTER. The application rows are lane 'permit' and blocking, so with a
// lane-only filter, staging the BUILDING track alone would 409 over the ELECTRICAL
// application — a document belonging to a filing this run is not making.
// ---------------------------------------------------------------------------
const buildingOnly = mk("prescriptive");
for (const d of [...PLAN_SET_FAMILY, "building_application", "solar_checklist"]) attach(buildingOnly.id, d);

await check("STAGING THE BUILDING TRACK ALONE does not 409 on the missing ELECTRICAL application", () => {
  assert.deepEqual(stagingWouldRefuse(buildingOnly, "building").map((d) => d.docType), [],
    "the building filing is complete; the electrical application belongs to the OTHER track");
  assert.deepEqual(stagingWouldRefuse(buildingOnly, "electrical").map((d) => d.docType), ["electrical_application"],
    "…and staging the electrical track must still refuse, naming it");
  assert.deepEqual(stagingWouldRefuse(buildingOnly, "mpu").map((d) => d.docType), ["electrical_application"],
    "an MPU is filed as an electrical permit, so it owes the electrical application");
  assert.ok(stagingWouldRefuse(buildingOnly, undefined).map((d) => d.docType).includes("electrical_application"),
    "staging EVERYTHING still owes both applications");
  // The plan-set family carries no discipline and must survive the filter on every track.
  const noPlans = mk("prescriptive");
  attach(noPlans.id, "building_application");
  const blocked = stagingWouldRefuse(noPlans, "building").map((d) => d.docType);
  assert.ok(blocked.includes("plan_set") && blocked.includes("sld"),
    `the universal plan-set family must block every discipline: ${JSON.stringify(blocked)}`);
});

await check("…and the discipline vocabulary is recipeDisciplineForTrack's, not a parallel one", () => {
  // The filter compares item.discipline against recipeDisciplineForTrack(track). If the doc
  // side ever said "building" where the track side says "structural", this filter would
  // silently drop the building application from every building stage.
  const building = setFor(prescriptive).find((d) => d.docType === "building_application")!;
  assert.equal(building.discipline, recipeDisciplineForTrack("building"));
  const electrical = setFor(prescriptive).find((d) => d.docType === "electrical_application")!;
  assert.equal(electrical.discipline, recipeDisciplineForTrack("electrical"));
});

// ---------------------------------------------------------------------------
// THE SENTENCE THE OPERATOR COMPLAINED ABOUT. "No critical document fields missing from
// the generated packet" was rendered out of pkg.missingFields — fifteen SCALAR field
// checks that never look at a document. It was literally true and read as "the packet is
// complete", and that is how two permits passed through with an application unattached.
// ---------------------------------------------------------------------------
await check("A PACKET MISSING A REQUIRED DOCUMENT SAYS SO", () => {
  const pkg = getApplicationDocumentPackage(db, missingEle.id);
  const missingDocs = pkg.missingDocuments || [];
  assert.ok(missingDocs.length > 0,
    "the packet reported nothing missing while a required permit application was not attached");
  assert.ok(missingDocs.some((d) => d.docType === "electrical_application"),
    `the missing document must be named: ${JSON.stringify(missingDocs.map((d) => d.docType))}`);
  assert.match(missingDocs.find((d) => d.docType === "electrical_application")!.why, /Coos Bay/,
    "…and say whose requirement it is");
});

await check("…WITHOUT being folded into missingFields, which four other things read", () => {
  // missingFields feeds packageReady and four stage-status computations. Widening it
  // would change four behaviours to fix one sentence.
  const pkg = getApplicationDocumentPackage(db, missingEle.id);
  for (const field of pkg.missingFields || []) {
    assert.doesNotMatch(field, /application|plan set|one-?line|spec sheet/i,
      `a DOCUMENT leaked into missingFields ("${field}") — packageReady and four stage statuses read that list`);
  }
  // A genuinely complete packet still says the all-clear.
  assert.deepEqual((getApplicationDocumentPackage(db, bothUploaded.id).missingDocuments || []).map((d) => d.docType), [],
    "a complete packet must not invent a missing document");
});

// The verdict the operator actually reads. There is no DOM harness in this suite, but
// documentVerdictHtml is a pure pkg -> string function, so we lift the REAL production
// body (plus the real esc/plural it closes over) out of dashboard.js and run it. That
// beats pinning source text: it survives a refactor and still fails on a behaviour change.
//
// Two distinct lies have been shipped from this card, and both are asserted here:
//   1. an all-clear printed out of missingFields alone, while a DOCUMENT was missing;
//   2. an all-clear printed when the inventory never RAN, because `missingDocuments || []`
//      turned "we did not ask" into "nothing is missing". Hence the status-based cases.
const ALL_CLEAR = "Every required document is attached";

function loadDocumentVerdictHtml(): (pkg: unknown) => string {
  const src = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8");
  const cut = (name: string) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > -1, `${name} is gone from dashboard.js — re-point this check`);
    // Brace-match so we lift exactly one function, regardless of what follows it.
    let depth = 0;
    let i = src.indexOf("{", at);
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) return src.slice(at, j + 1);
    }
    throw new Error(`unbalanced braces reading ${name}`);
  };
  const bundle = [cut("esc"), cut("plural"), cut("documentVerdictHtml")].join("\n\n");
  return new Function(`${bundle}\nreturn documentVerdictHtml;`)() as (pkg: unknown) => string;
}

const verdict = loadDocumentVerdictHtml();

await check("…and the screen no longer prints the all-clear while a DOCUMENT is missing", () => {
  const html = verdict({
    missingFields: [],
    missingDocumentsStatus: "resolved",
    missingDocuments: [{ docType: "electrical_application", label: "Electrical permit application", why: "City of Coos Bay files a separate ELE permit" }],
  });
  assert.ok(!html.includes(ALL_CLEAR),
    "the card printed the document all-clear while a required document was missing");
  assert.ok(html.includes("Electrical permit application"),
    "the missing document must be named on the screen, not merely counted");
  assert.match(html, /NOT in the packet/,
    "a missing required DOCUMENT must be stated as plainly as a missing field");
});

await check("…and a missing FIELD alone never suppresses the document all-clear (no over-correction)", () => {
  const html = verdict({
    missingFields: ["Contractor licence number"],
    missingDocumentsStatus: "resolved",
    missingDocuments: [],
  });
  assert.ok(html.includes(ALL_CLEAR),
    "a blank scalar field must not make the DOCUMENT verdict go dark — they are separate claims");
  assert.match(html, /still blank/, "…while the field verdict still reports the blank field");
});

await check("A FAILURE TO ANSWER IS NOT AN ANSWER OF 'NOTHING': an unresolved inventory never reads as clear", () => {
  // `missingDocuments || []` on an absent list is how the all-clear got printed over a
  // computation that threw. Status drives the state; the array length must not.
  for (const pkg of [
    { missingFields: [], missingDocumentsStatus: "unavailable", missingDocumentsError: "reference profile unreadable" },
    { missingFields: [], missingDocumentsStatus: undefined, missingDocuments: [] }, // the DB-free workflow builder
    { missingFields: [] }, // status absent entirely
  ]) {
    const html = verdict(pkg);
    assert.ok(!html.includes(ALL_CLEAR),
      `an all-clear printed for an inventory that never resolved: ${JSON.stringify(pkg)}`);
    assert.match(html, /could not determine/i,
      `the operator must be told the question went unanswered: ${JSON.stringify(pkg)}`);
  }
  assert.match(verdict({ missingFields: [], missingDocumentsStatus: "unavailable", missingDocumentsError: "reference profile unreadable" }),
    /reference profile unreadable/, "a failed inventory must show why, so it can be fixed");
});

await check("…and everything interpolated into that card is esc()'d", () => {
  const html = verdict({
    missingFields: ["<img src=x onerror=alert(1)>"],
    missingDocumentsStatus: "resolved",
    missingDocuments: [{ docType: "x", label: "<script>bad()</script>", why: "<b>why</b>" }],
  });
  assert.ok(!html.includes("<script>") && !html.includes("<img src=x"),
    "raw markup reached innerHTML — esc() every interpolated value");
  assert.ok(html.includes("&lt;script&gt;"), "the escaped form should be what renders");
});

await check("…and the superseded all-clear sentence is gone from the file entirely", () => {
  // Cheap regression pin on the exact sentence that shipped the first lie. It may only
  // survive as prose in the comment explaining the history, never inside a template.
  const src = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8");
  const live = src.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
  });
  const offenders = live.filter((l) => l.includes("No critical document fields missing from the generated packet"));
  assert.deepEqual(offenders, [],
    `the old missingFields-only all-clear is still live code, not just history: ${JSON.stringify(offenders)}`);
});

// ---------------------------------------------------------------------------
// ACQUISITION — what we go and FETCH is now what the project must FILE.
// ---------------------------------------------------------------------------
await check("ACQUISITION asks for the electrical application, not a hardcoded generic slot", async () => {
  const llm = createLLMProvider(); // stub — no network, no research spend
  const ensured = await ensureAhjFormsForProject(db, llm, prescriptive as never);
  assert.ok(ensured.neededTypes.includes("electrical_application"),
    `the electrical blank was never even asked for: ${JSON.stringify(ensured.neededTypes)}`);
  assert.ok(ensured.neededTypes.includes("building_application"),
    `Coos Bay's blank is STORED as building_application, so that is what must be asked for: ${JSON.stringify(ensured.neededTypes)}`);
  assert.ok(!ensured.neededTypes.includes("permit_application"),
    "asking for permit_application here is what re-ran a paid research pass on every click");
});

await check("ACQUISITION GOES AFTER THE PRESCRIPTIVE BLANK, not 'whatever is under building_application'", async () => {
  // ahjFormAuto kept item.docType from the required set and DISCARDED applicationKind, so
  // a prescriptive project researched a generic "building application" — and a stored
  // STRUCTURAL blank answered the existence check, ending acquisition before it started.
  // Stand that structural blank up for the real Coos Bay fixture and ask both paths.
  storeAhjFormTemplate(db, {
    ahjName: "City of Coos Bay", state: "OR", formType: "building_application",
    filename: "Coos Bay Structural (non-prescriptive) Permit Application.pdf",
    bytes: new Uint8Array(Buffer.from("%PDF-1.4 structural blank")),
    map: { formName: "Coos Bay Structural (non-prescriptive) Permit Application", sourceUrl: "", fillMode: "acroform", textFields: {}, checkboxes: {}, notes: "" },
  });
  const llm = createLLMProvider(); // stub — no network, no research spend
  const forPrescriptive = await ensureAhjFormsForProject(db, llm, prescriptive as never);
  const bld = forPrescriptive.results.find((r) => r.formType === "building_application")!;
  assert.ok(bld, "the building-side slot was not asked for at all");
  assert.equal(bld.applicationKind, "prescriptive",
    "the required set already decided WHICH of the two; acquisition must carry it rather than drop it");
  assert.notEqual(bld.status, "exists",
    "a stored STRUCTURAL blank was accepted as the PRESCRIPTIVE application — the prescriptive form would never be acquired");
  // The same stored blank IS what an engineered project needs, and must not be re-fetched.
  const forEngineered = await ensureAhjFormsForProject(db, llm, engineered as never);
  const bldEng = forEngineered.results.find((r) => r.formType === "building_application")!;
  assert.equal(bldEng.applicationKind, "structural");
  assert.equal(bldEng.status, "needs_manual",
    "the saved engineered blank has no field map: report needs_manual without repeated research");
});

await check("...while an AHJ with no structure knowledge still gets its one generic application", () => {
  // The baseline slot. Removing it would stop acquisition dead for every AHJ we have no
  // process profile for — a much bigger regression than the one being fixed.
  const unknownAhj = { id: "p-unknown", clientId: null, state: "OR", ahj: "City of Nowhereville", utility: "PGE", parserSnapshot: {} };
  assert.deepEqual(requiredApplicationDocs(unknownAhj as never, applicationDocContext(unknownAhj as never)), []);
});

// ---------------------------------------------------------------------------
// THE STAMP THE FILL GATE COULD NOT SEE.
//
// storedApplicationKind already reads acquisition's stamp first and the form's NAME only
// as a fallback — and the packaging filter (formContradictsPath, filledApplicationForms)
// used it. The FILL gate did not: formAllowedForPath took a formName and nothing else. So
// for a blank the AHJ publishes as "Building Permit Application.pdf" — a name that claims
// NEITHER kind — the two halves disagreed:
//
//    fill gate  : kind = null  -> "compatible with every path" -> FILLED
//    packaging  : kind = structural (stamped) -> contradicts prescriptive -> DROPPED
//
// A prescriptive project therefore got a filled STRUCTURAL application sitting in its
// forms list, labelled filled, while the upload sweep quietly refused to send it. The
// operator sees a completed application and attaches it by hand — against Coos Bay's own
// printed "upload ONLY the prescriptive application. Do NOT also upload the structural
// application." Name-only classification is the fragile path ("Non-Prescriptive" CONTAINS
// "prescriptive"), and this was the last place still taking it as the only answer.
//
// AND A RE-STORE MUST NOT FORGET. The 60-day refresh (ahjFormRefresh.ts) re-fetches a row's
// own sourceUrl and re-stores with a freshly built map carrying no applicationKind — so the
// stamp fell back to the NAME, which for this blank says nothing. The row was silently
// demoted to kind-less, and because the kind IS the building-side storage key, the re-store
// no longer matched its own row and inserted a THIRD, kind-less duplicate.
// ---------------------------------------------------------------------------
const STAMPED_AHJ = "City of Stampedblank";
const STAMPED_URL = "https://stampedblank.example/forms/building-permit-application.pdf";
const STAMPED_NAME = "Building Permit Application";
const bldRows = (ahjName: string) => db.query<{ id: string; original_filename?: string; field_map?: string }>(
  "SELECT id, original_filename, field_map FROM ahj_form_templates WHERE lower(ahj_name) = lower(?) AND form_type = 'building_application'",
  [ahjName],
);
/** A REAL PDF, not `%PDF-1.4 blank`. buildFilledFormsForProject actually parses the blob;
 *  garbage bytes come back status "error", which would let this test pass for the wrong
 *  reason and hide whether the gate ran at all. */
const realBlank = async (heading: string): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(heading, { x: 46, y: 730, size: 14, font });
  for (let i = 0; i < 9; i++) page.drawText(`Field label ${i}:`, { x: 46, y: 660 - i * 16, size: 11, font });
  return doc.save();
};
/** An overlay map, so loadStoredTemplates considers the template fillable. */
const overlayMap = (formName: string, sourceUrl: string) => ({
  formName, sourceUrl, fillMode: "overlay" as const, textFields: {}, checkboxes: {},
  overlayFields: [{ source: "project.homeownerName", page: 0, x: 240, y: 730, size: 11 }],
  notes: "",
});
const stampedId = storeAhjFormTemplate(db, {
  ahjName: STAMPED_AHJ, state: "OR", formType: "building_application",
  filename: `${STAMPED_NAME}.pdf`, bytes: await realBlank(STAMPED_NAME),
  // Acquisition KNEW: it went looking for the structural (non-prescriptive) blank.
  applicationKind: "structural",
  map: overlayMap(STAMPED_NAME, STAMPED_URL),
});
const atStamped = (permitPathOverride: string) => {
  const proj = createProject(db, {
    clientId: client.id, owner: `Stamp Owner ${++n}`, street: `${n} Stamp Ave`, city: "Stampton",
    state: "OR", ahj: STAMPED_AHJ, utility: "Pacific Power", dcKw: "8", acKw: "6.4",
    permitPathOverride,
  }).project;
  filledDirs.push(path.join(FILLED_ROOT, proj.id));
  return proj;
};

await check("PREMISE: the stamped blank's own NAME claims neither kind — only the stamp knows", () => {
  assert.equal(formApplicationKind(STAMPED_NAME), null,
    "fixture premise: this filename must be the generic kind a name cannot classify");
  const rows = bldRows(STAMPED_AHJ);
  assert.equal(rows.length, 1, `fixture premise: one stored blank, got ${rows.length}`);
  assert.equal(storedApplicationKind(rows[0]), "structural",
    "acquisition's stamp is the only evidence of which application this is");
  const loaded = loadStoredTemplates(db, STAMPED_AHJ, "OR");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].applicationKind, "structural",
    "the stamp has to survive the load, or the fill gate has nothing to read");
});

await check("THE FILL GATE READS THE STAMP: the structural blank is NOT built for a prescriptive project", async () => {
  const proj = atStamped("prescriptive");
  assert.equal(resolvePermitPath(proj as never).path, "prescriptive", "fixture premise");
  const pkg = await buildFilledFormsForProject(db, proj as never);
  const entry = pkg.forms.find((f) => f.formId === `tmpl-${stampedId}`);
  assert.ok(entry, `the stored template never reached the fill loop: ${JSON.stringify(pkg.forms.map((f) => f.formId))}`);
  assert.equal(entry!.status, "skipped",
    `the STRUCTURAL application was BUILT for a PRESCRIPTIVE project — the AHJ's printed instruction is "do NOT upload both": ${JSON.stringify(entry)}`);
  assert.match(String(entry!.message), /structural/i,
    "…and the skip names the application it skipped, from the stamp — not the one the filename suggests");
  assert.ok(!fs.existsSync(path.join(FILLED_ROOT, proj.id, `tmpl-${stampedId}.pdf`)),
    "a skip must also leave nothing on disk for the upload sweep to find");
});

await check("…and the SAME blank IS built for the engineered project it belongs to", async () => {
  // The gate must not simply become stricter: over-blocking the engineered path would be
  // the same failure seen from the other side.
  const proj = atStamped("engineered");
  const pkg = await buildFilledFormsForProject(db, proj as never);
  const entry = pkg.forms.find((f) => f.formId === `tmpl-${stampedId}`);
  assert.equal(entry?.status, "filled",
    `the engineered path's own application was refused: ${JSON.stringify(entry)}`);
  assert.ok(fs.existsSync(path.join(FILLED_ROOT, proj.id, `tmpl-${stampedId}.pdf`)),
    "…and the filled PDF is on disk for the upload sweep");
});

await check("A RE-STORE OF THE SAME BLANK KEEPS THE STAMP, and updates its own row", async () => {
  // EXACTLY the refresh's shape (ahjFormRefresh.ts:137-157): new bytes fetched from the
  // row's OWN sourceUrl, a freshly BUILT field map, and no applicationKind anywhere.
  const again = storeAhjFormTemplate(db, {
    ahjName: STAMPED_AHJ, state: "OR", formType: "building_application",
    filename: `${STAMPED_NAME}.pdf`, bytes: await realBlank(`${STAMPED_NAME} (rev 2026)`),
    map: overlayMap(STAMPED_NAME, STAMPED_URL),
  });
  assert.equal(again, stampedId,
    "the refresh did not land on the row it was refreshing — the kind is part of the building-side key, so losing it loses the row");
  const rows = bldRows(STAMPED_AHJ);
  assert.equal(rows.length, 1,
    `the refresh inserted a duplicate beside the row it meant to update: ${JSON.stringify(rows.map((r) => r.id))}`);
  assert.equal(storedApplicationKind(rows[0]), "structural",
    "the refresh stripped the stamp — the blank is kind-less now and every gate is back to reading its filename");
});

await check("…and the gate still refuses it for a prescriptive project AFTER the refresh", async () => {
  const proj = atStamped("prescriptive");
  const pkg = await buildFilledFormsForProject(db, proj as never);
  const entry = pkg.forms.find((f) => f.formId === `tmpl-${stampedId}`);
  assert.equal(entry?.status, "skipped",
    `the refresh re-opened the hole: ${JSON.stringify(entry)}`);
});

await check("BUT A DIFFERENT BLANK DOES NOT INHERIT THE STAMP — the carry-forward is not a name match", () => {
  // The other half of the filter. An operator uploading their own generically-named blank
  // (sourceUrl "", because it came off their desktop) must NOT be adopted as the stamped
  // structural application — that would invent evidence and silently re-key the AHJ.
  const uploaded = storeAhjFormTemplate(db, {
    ahjName: STAMPED_AHJ, state: "OR", formType: "building_application",
    filename: `${STAMPED_NAME}.pdf`, bytes: new Uint8Array(Buffer.from("%PDF-1.4 operator upload")),
    map: { formName: STAMPED_NAME, sourceUrl: "", fillMode: "acroform" as const, textFields: { Owner: "project.homeownerName" }, checkboxes: {}, notes: "" },
  });
  assert.notEqual(uploaded, stampedId,
    "an operator's own generic blank overwrote the stamped structural application");
  const rows = bldRows(STAMPED_AHJ);
  assert.equal(rows.length, 2, `expected the stamped row plus the new generic one, got ${rows.length}`);
  const fresh = rows.find((r) => r.id === uploaded)!;
  assert.equal(storedApplicationKind(fresh), null,
    "a blank that claims nothing and came from nowhere must stay kind-less — compatible with both paths, claiming neither");
  assert.equal(storedApplicationKind(rows.find((r) => r.id === stampedId)!), "structural",
    "…and the stamped row is untouched");
});

// ---------------------------------------------------------------------------
// "WE COULD NOT FIND OUT" IS NOT "NOTHING IS MISSING".
//
// getApplicationDocumentPackage attached missingDocuments inside a bare try/catch. When
// documentInventory threw, missingDocuments stayed undefined — and the packet screen's
// `pkg.missingDocuments || []` turned that absence into an empty list, printing the
// pass-styled "No critical document fields missing, and every required document is
// attached." The sentence this whole field exists to stop, reproduced by its error path.
// The catch's own excuse ("the staging gate is the authority and runs its own check") does
// not hold either: the staging gate calls the SAME documentInventory.
//
// The failure is REPRESENTABLE now. The frontend contract: render an all-clear only when
// missingDocumentsStatus === "resolved"; "unavailable" (or an absent status) renders as
// unknown, never as empty.
// ---------------------------------------------------------------------------
await check("THE PACKET SAYS 'RESOLVED' when the inventory actually ran", () => {
  const proj = mk("prescriptive");
  for (const d of [...PLAN_SET_FAMILY, "building_application", "electrical_application", "solar_checklist"]) attach(proj.id, d);
  const pkg = getApplicationDocumentPackage(db, proj.id);
  assert.equal(pkg.missingDocumentsStatus, "resolved",
    "a package whose inventory ran must say so, or the honest rendering has nothing to key on");
  assert.ok(Array.isArray(pkg.missingDocuments), "…and the list is a list");
  assert.deepEqual(pkg.missingDocuments!.map((d) => d.docType), [],
    "fixture premise: this project is complete, so an EMPTY list here is a real answer");
  assert.equal(pkg.missingDocumentsError, undefined);
});

await check("…and 'UNAVAILABLE' when it threw — the list is ABSENT, never empty", () => {
  const proj = mk("prescriptive");
  for (const d of PLAN_SET_FAMILY) attach(proj.id, d);
  // Break the inventory at a statement ONLY documentInventory issues on this path
  // (projectDocsByType, its first line), through the real getApplicationDocumentPackage.
  // No re-implementation, no raw-SQL fakery — the production function, a real throw.
  const BOOM = "SELECT doc_type, stored_path FROM project_documents WHERE project_id = ? ORDER BY uploaded_at DESC";
  let armed = false;
  const brokenDb = new Proxy(db as unknown as Record<string, unknown>, {
    get(target, prop, recv) {
      const value = Reflect.get(target, prop, recv);
      if (typeof value !== "function") return value;
      if (prop === "query") {
        return (sql: string, params?: unknown) => {
          if (armed && sql === BOOM) throw new Error("simulated inventory failure: reference profile unreadable");
          return (value as (s: string, p?: unknown) => unknown).call(target, sql, params);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as unknown as typeof db;
  armed = true;
  const pkg = getApplicationDocumentPackage(brokenDb, proj.id);
  assert.equal(pkg.missingDocumentsStatus, "unavailable",
    "the inventory threw and the package reported nothing about it — indistinguishable from a clean project");
  assert.equal(pkg.missingDocuments, undefined,
    "an empty list is a CLAIM, and it is the claim that shipped two permits with an application never attached");
  assert.match(String(pkg.missingDocumentsError), /simulated inventory failure/,
    "the operator must be told what failed, not handed silence");
});

// ---------------------------------------------------------------------------
// A RE-FILED PACKAGE MUST CLOSE THE CORRECTIONS IT ANSWERS.
//
// resolveOpenCorrectionsOnResubmit had ZERO callers, while its own header comment and
// resolveCorrection's BOTH said prepareSubmission called it. So a corrected package went
// back out and its corrections kept closed_at NULL and resubmitted = 0 unless an operator
// hit POST /api/corrections/:id/resolve by hand — and every surface filtering on
// `!closedAt && !resubmitted` (openCorrectionCount, the permit and NEM lanes, the action
// queue) kept telling the operator to "resolve AHJ corrections before resubmittal" on a
// job already resubmitted, while the cycle-time KPI that needs resubmitted = 1 never
// completed. Ann Marineau and Christopher Ivy are about to enter exactly this flow.
//
// Wired at captureConfirmation, NOT prepareSubmission: staging is not submitting (hard
// safety rule 1 — automation never clicks final submit), and a staged run can be abandoned
// at the review screen. captureConfirmation is where a HUMAN says the filing went out.
// ---------------------------------------------------------------------------
await check("A CONFIRMED RESUBMISSION CLOSES ITS OPEN CORRECTIONS", () => {
  const proj = mk("prescriptive");
  const withCorrection = addManualCorrection(db, proj.id, "Structural review: the prescriptive checklist was not attached. Resubmit with it.");
  const correctionId = withCorrection.corrections[0].id;
  assert.equal(withCorrection.corrections[0].closedAt ?? null, null, "fixture premise: the correction starts open");
  assert.equal(withCorrection.corrections[0].resubmitted, false, "fixture premise");

  // The staged re-filing, as the portal path leaves it: a run + a submission row awaiting
  // the human's final click. Raw SQL is fixture SETUP only — captureConfirmation, the real
  // route handler's function, is what is under test.
  const runId = `run-${proj.id}`;
  const ts = new Date().toISOString();
  db.run(
    "INSERT INTO portal_runs (id, project_id, run_type, status, started_at) VALUES (?, ?, 'submit', 'awaiting_human_submit', ?)",
    [runId, proj.id, ts],
  );
  db.run(
    "INSERT INTO submissions (id, project_id, submission_type, status, created_at) VALUES (?, ?, 'permit', 'awaiting_human_submit', ?)",
    [`sub-${proj.id}`, proj.id, ts],
  );

  const after = captureConfirmation(db, runId, { applicationNumber: "187-26-000309-STR", submittedBy: "operator" });
  const correction = after.corrections.find((c) => c.id === correctionId);
  assert.ok(correction, "the correction vanished from the project");
  assert.ok(correction!.closedAt,
    "the re-filing went out and the correction is still open — the board keeps saying 'resolve AHJ corrections before resubmittal' on a resubmitted job");
  assert.equal(correction!.resubmitted, true,
    "resubmitted stayed 0, so the cycle-time KPI that needs it can never complete");
  const stillOpen = db.query<{ id: string }>(
    "SELECT id FROM corrections WHERE project_id = ? AND closed_at IS NULL AND resubmitted = 0", [proj.id]);
  assert.equal(stillOpen.length, 0, `still open: ${JSON.stringify(stillOpen)}`);
});

await check("…and a FIRST submission with nothing open is an untouched no-op", () => {
  // The wiring fires on every confirmed submit, so it must be inert when there is no
  // correction to answer — otherwise a first filing would invent a resubmission.
  const proj = mk("prescriptive");
  const runId = `run-first-${proj.id}`;
  const ts = new Date().toISOString();
  db.run(
    "INSERT INTO portal_runs (id, project_id, run_type, status, started_at) VALUES (?, ?, 'submit', 'awaiting_human_submit', ?)",
    [runId, proj.id, ts],
  );
  db.run(
    "INSERT INTO submissions (id, project_id, submission_type, status, created_at) VALUES (?, ?, 'permit', 'awaiting_human_submit', ?)",
    [`sub-first-${proj.id}`, proj.id, ts],
  );
  const after = captureConfirmation(db, runId, { applicationNumber: "187-26-000999-STR", submittedBy: "operator" });
  assert.deepEqual(after.corrections, [], "a first filing must not manufacture correction history");
  const row = db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [proj.id]);
  assert.equal(row?.status, "submitted", "…and the confirmation itself still lands");
});

await check("wrong-path explicit uploads are rejected, including a path change during a browser run", () => {
  const proj = mk("engineered");
  attach(proj.id, "building_application");
  db.run("UPDATE project_documents SET original_filename = 'Non-Prescriptive Structural Application.pdf' WHERE project_id = ?", [proj.id]);
  const file = submissionDocumentsByType(db, proj).building_application;
  assert.ok(file);
  const guard = uploadDocumentGuard(db, proj.id, true);
  assert.doesNotThrow(() => guard("building_application", file));
  const snap = { ...proj.parserSnapshot, permitPathOverride: "prescriptive" };
  db.run("UPDATE projects SET parser_json = ? WHERE id = ?", [JSON.stringify(snap), proj.id]);
  assert.throws(() => guard("building_application", file), /changed|permit path/i);
  const changed = { ...proj, parserSnapshot: snap };
  assert.equal(submissionDocumentsByType(db, changed).building_application, undefined);
  assert.ok(documentInventory(db, changed).missingBlocking.some(d => d.docType === "building_application"));
});
await check("active board excludes archived projects while explicit history includes them", async () => {
  const { getProjectList } = await import("../src/repository");
  const proj = mk("prescriptive");
  db.run("UPDATE projects SET archived_at = ? WHERE id = ?", [new Date().toISOString(), proj.id]);
  assert.equal(getProjectList(db, { search: proj.homeownerName, includeArchived: false }).projects.length, 0);
  assert.equal(getProjectList(db, { search: proj.homeownerName, includeArchived: true }).projects.length, 1);
});
try { db.close(); } catch { /* best effort */ }
for (const dir of filledDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nrequiredApplicationSet: all checks passed."
  : `\nrequiredApplicationSet: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
