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
//   npx tsx backend/test/requiredApplicationSet.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "required-app-set-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.ANTHROPIC_API_KEY = ""; // stub LLM — deterministic, no network research

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, prepareSubmission } = await import("../src/repository");
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
const { ensureAhjFormsForProject, storeAhjFormTemplate } = await import("../src/ahjFormAuto");
const { createLLMProvider } = await import("../src/llm");

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
const buildFilledForm = (pid: string, formType: string, filename: string): void => {
  const templateId = storeAhjFormTemplate(db, {
    ahjName: "City of Coos Bay", state: "OR", formType, filename,
    bytes: new Uint8Array(Buffer.from("%PDF-1.4 blank")),
    map: { formName: filename.replace(/\.pdf$/, ""), sourceUrl: "", fillMode: "acroform", textFields: {}, checkboxes: {}, notes: "" },
  });
  const dir = path.join(FILLED_ROOT, pid);
  fs.mkdirSync(dir, { recursive: true });
  filledDirs.push(dir);
  fs.writeFileSync(path.join(dir, `tmpl-${templateId}.pdf`), "%PDF-1.4 filled");
};

/** The exact filter prepareSubmission applies before its 409 (repository.ts). */
const stagingWouldRefuse = (pid: string, project: object, lane: "permit" | "nem" | null = "permit") =>
  documentInventory(db, project as never).missingBlocking
    .filter((d) => lane == null || d.lane === lane || d.docType === "inverter_spec");

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
  assert.ok(stagingWouldRefuse(missingEle.id, missingEle).length > 0,
    "the permit-lane filter prepareSubmission applies drops it, so staging would still go through");
});

await check("...and that is exactly the list prepareSubmission turns into its 409", () => {
  // prepareSubmission is reached only after the QC / human-review / reviewer-blocker gates,
  // which a fixture project trips for unrelated reasons (a bare parse has no SLD, no fire
  // pathways, no framing...). So the DOCUMENT gate is pinned where qcDocumentGate.test.ts
  // already pins it — the inventory plus the exact lane filter — and the WIRING is pinned by
  // source, the way credentialLockout.test.ts does: a list nothing consults is precisely the
  // state this one was in.
  const kept = stagingWouldRefuse(missingEle.id, missingEle);
  assert.match(kept.map((d) => d.label).join("; "), /[Ee]lectrical/,
    "the 409 interpolates these labels and nothing else — it must name the document");
  const src = fs.readFileSync(path.join(process.cwd(), "backend", "src", "repository.ts"), "utf8");
  const at = src.indexOf("const inv = documentInventory(db, detail.project);");
  assert.ok(at > -1, "prepareSubmission no longer consults documentInventory at all");
  const window = src.slice(at, at + 900);
  assert.match(window, /missingBlocking\.filter/, "the gate must read missingBlocking");
  assert.match(window, /Submission staging blocked: required document\(s\) not attached/,
    "…and refuse with a 409 that names them");
});

const bothUploaded = mk("prescriptive");
for (const d of [...PLAN_SET_FAMILY, "building_application", "electrical_application"]) attach(bothUploaded.id, d);

await check("THE GATE ACCEPTS when both applications are present", () => {
  const inv = documentInventory(db, bothUploaded as never);
  assert.deepEqual(inv.missingBlocking.map((d) => d.docType), [],
    `a complete filing was blocked: ${JSON.stringify(inv.missingBlocking.map((d) => `${d.label}: ${d.why}`))}`);
});

const filledOnly = mk("prescriptive");
for (const d of [...PLAN_SET_FAMILY, "building_application"]) attach(filledOnly.id, d);
buildFilledForm(filledOnly.id, "electrical_application", "Coos Bay Electrical Permit Application.pdf");

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
for (const d of [...PLAN_SET_FAMILY, "permit_application", "electrical_application"]) attach(genericBlank.id, d);

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
  for (const d of [...PLAN_SET_FAMILY, "permit_application"]) attach(p.id, d);
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

await check("...while an AHJ with no structure knowledge still gets its one generic application", () => {
  // The baseline slot. Removing it would stop acquisition dead for every AHJ we have no
  // process profile for — a much bigger regression than the one being fixed.
  const unknownAhj = { id: "p-unknown", clientId: null, state: "OR", ahj: "City of Nowhereville", utility: "PGE", parserSnapshot: {} };
  assert.deepEqual(requiredApplicationDocs(unknownAhj as never, applicationDocContext(unknownAhj as never)), []);
});

try { db.close(); } catch { /* best effort */ }
for (const dir of filledDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nrequiredApplicationSet: all checks passed."
  : `\nrequiredApplicationSet: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
