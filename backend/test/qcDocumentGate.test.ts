// THE DOCUMENT CHECK FIRED AT THE PORTAL, WHICH IS THE ONE PLACE IT IS TOO LATE.
//
// Two real Coos Bay structural permits came back "Intake Requirements Needed" — one wanting a
// PE-stamped structural, one wanting a plan review fee — and in both cases the operator found out
// from the CITY rather than from us. The information was not missing: documentInventory already
// knows exactly what a Coos Bay structural filing needs, and the staging gate already refuses
// without it (repository.ts, "Submission staging blocked: required document(s) not attached").
//
// It just ran at the wrong moment. The staging gate fires when somebody presses stage — by then
// the plan set is weeks old, the crew may be booked, and getting a sealed letter means going back
// to the designer. QC runs right after the parse, which is when there is still time to ask.
//
// So QC now reports the same inventory the staging gate uses. Same source of truth, moved
// earlier: an operator sees "this AHJ will want a PE-stamped structural letter" on the QC screen
// the day the plan set lands, not three weeks later from a plans examiner.
//
//   MUST WARN    — a project missing a document staging will refuse is WARNED about at QC, by
//                  name. Deliberately not a QC failure: qc_failed blocks staging and autopilot,
//                  so failing here would stall every project the moment it parses, before anyone
//                  could attach anything. Surface early, block late — the refusal stays at
//                  staging, where it already was.
//   MUST WARN    — an advisory document (a filled application form) warns rather than blocks, so
//                  a complete-but-unpapered project is not stopped dead.
//   MUST PASS    — a project with everything attached raises nothing. A gate that always fires
//                  is one an operator learns to click past.
//   MUST AGREE   — with the staging gate. Two lists that can disagree is how the portal ends up
//                  being the thing that tells you.
//
//   npx tsx backend/test/qcDocumentGate.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-doc-gate-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { runQcForProject } = await import("../src/qc");
const { documentInventory } = await import("../src/requiredDocuments");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const client = createClient(db, { companyName: "QC Docs Solar", ccbLicenseNumber: "959595" });
let n = 0;
const mk = () => createProject(db, {
  clientId: client.id, owner: `QC Owner ${++n}`, street: `${n} QC St`, city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
}).project;

// A REAL FILE ON DISK. projectDocsByType requires fs.existsSync(stored_path) — a row pointing at
// nothing is not a document, which is right, and is why the first version of this fixture showed
// every sheet as missing no matter what it inserted.
const attach = (pid: string, docType: string, extractedText = "") => {
  const file = path.join(tmpDir, `${pid}-${docType}.pdf`);
  fs.writeFileSync(file, "%PDF-1.4 test fixture");
  db.run(
    `INSERT INTO project_documents (id, project_id, doc_type, original_filename, stored_path, source, uploaded_at, extracted_text)
     VALUES (?, ?, ?, ?, ?, 'upload', ?, ?)`,
    [`${pid}-${docType}`, pid, docType, `${docType}.pdf`, file, new Date().toISOString(), extractedText],
  );
};

const docRules = (pid: string) => {
  runQcForProject(db, pid);
  return db.query<{ rule_id: string; qc_status: string; message: string; severity: string }>(
    "SELECT rule_id, qc_status, message, severity FROM qc_results WHERE project_id = ? AND rule_id LIKE 'docs.%'",
    [pid],
  );
};

check("THE HEADLINE: a project missing required documents is WARNED about at QC, by name", () => {
  const p = mk();   // nothing attached at all
  const rules = docRules(p.id);
  assert.ok(rules.length > 0, "QC said nothing at all about documents — this is the gap the portal filled");
  const raised = rules.filter((r) => r.qc_status !== "pass");
  assert.ok(raised.length > 0, `nothing raised: ${JSON.stringify(rules.map((r) => [r.rule_id, r.qc_status]))}`);
  assert.equal(rules.filter((r) => r.qc_status === "fail").length, 0,
    "documents must WARN at QC, never fail — a QC failure blocks staging and autopilot");
  const text = raised.map((r) => r.message).join(" ");
  assert.match(text, /plan set|site plan|one-line|SLD|structural/i,
    `the failure must name what is missing, not just that something is: ${text}`);
});

check("...and it names the AHJ, because the requirement is the AHJ's, not ours", () => {
  const p = mk();
  const text = docRules(p.id).map((r) => r.message).join(" ");
  assert.match(text, /Coos Bay/i, `an operator needs to know whose requirement this is: ${text}`);
});

check("MUST PASS: a fully papered project raises nothing", () => {
  // A gate that fires on every project is one people learn to click past.
  const p = mk();
  for (const d of ["plan_set", "site_plan", "sld", "structural", "module_spec", "inverter_spec", "labels",
    "permit_application", "electrical_application", "solar_checklist", "building_application"]) attach(p.id, d);
  const rules = docRules(p.id);
  assert.equal(rules.filter((r) => r.qc_status === "fail").length, 0,
    `a complete project was BLOCKED: ${JSON.stringify(rules.filter((r) => r.qc_status === "fail").map((r) => r.message))}`);
});

check("MUST WARN, NOT FAIL: an advisory document does not block", () => {
  // The filled application forms are advisory — the package is submittable without them attached
  // as separate files, and stopping on that would block work that is genuinely ready.
  const p = mk();
  for (const d of ["plan_set", "site_plan", "sld", "structural", "module_spec", "inverter_spec"]) attach(p.id, d);
  const rules = docRules(p.id);
  assert.equal(rules.filter((r) => r.qc_status === "fail").length, 0,
    `an advisory-only gap was treated as blocking: ${JSON.stringify(rules.map((r) => [r.rule_id, r.qc_status, r.message]))}`);
  assert.ok(rules.some((r) => r.qc_status === "warning"), "the gap should still be said out loud");
});

check("MUST AGREE with the staging gate — same inventory, read earlier", () => {
  // Two lists that can disagree is exactly how the portal ends up being the thing that tells you.
  const p = mk();
  attach(p.id, "plan_set");
  attach(p.id, "site_plan");
  const inv = documentInventory(db, { ...(p as object), id: p.id } as never);
  const gateSays = inv.missingBlocking.map((d: { label: string }) => d.label).sort();
  const qcSays = docRules(p.id).filter((r) => r.qc_status !== "pass")
    .flatMap((r) => gateSays.filter((label: string) => r.message.includes(label))).sort();
  assert.deepEqual(qcSays, gateSays,
    `QC and the staging gate disagree about what is missing.\n  gate: ${JSON.stringify(gateSays)}\n  qc:   ${JSON.stringify(qcSays)}`);
});

// ---------------------------------------------------------------------------
// ONLY ProjectDox NEEDS PER-SHEET UPLOADS. The splitter says so in its own header:
// "ProjectDox requires each sheet uploaded to its own document slot. Standard
// Accela/EnerGov portals receive the FULL plan set as a single PDF." The QC gate
// matched energov|etrakit|accela anyway and asked a person to hand-confirm a sheet
// mapping for portals that never wanted split sheets — all three live firings were
// Salem (accela) and Tigard (EnerGov), ~16 interruptions per 100 projects.
// ---------------------------------------------------------------------------
const { upsertSeededAhjPlatform } = { upsertSeededAhjPlatform: (state: string, ahj: string, platform: string): void => {
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_name, portal_url, portal_platform, confidence, first_seen_at, last_learned_at, updated_at)
     VALUES (?, ?, ?, ?, '', '', '', ?, 'seeded', ?, ?, ?)`,
    [`plat-${ahj}`, `${state.toLowerCase()}|${ahj.toLowerCase()}|unknown`, state, ahj, platform, ts, ts, ts],
  );
} };

const splitPagesAsked = (ahj: string, platform: string): boolean => {
  upsertSeededAhjPlatform("OR", ahj, platform);
  const p = createProject(db, {
    clientId: client.id, owner: `Split Owner ${ahj}`, street: "1 Split St", city: ahj,
    state: "OR", ahj, utility: "Pacific Power", dcKw: "8", acKw: "6.4",
  }).project;
  runQcForProject(db, p.id);
  const n = Number(db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM human_review_items WHERE project_id = ? AND field_name = 'splitPages'", [p.id])?.n ?? 0);
  return n > 0;
};

check("MUST PASS: a ProjectDox AHJ still gets the sheet-mapping question", () => {
  assert.equal(splitPagesAsked("Dox City", "ProjectDox"), true);
});

check("MUST EXCLUDE: Accela and EnerGov are NOT asked — they take the whole plan set", () => {
  assert.equal(splitPagesAsked("Accela Town", "accela"), false);
  assert.equal(splitPagesAsked("EnerGov Village", "Tyler EnerGov (CSS Self Service)"), false);
});


// ---------------------------------------------------------------------------
// LOCATES ARE DERIVABLE FOR A ROOF MOUNT WITH NOTHING BURIED — but only then.
// Measured across 100 simulated projects at the live book's field rates, this was
// the ONLY remaining interruption in the local pipeline (13 of 13). An 811 call
// missed is a real hazard, so anything that might dig still asks.
// ---------------------------------------------------------------------------
const locatesAsked = (snapshot: Record<string, unknown>): boolean => {
  const p = createProject(db, {
    clientId: client.id, owner: `Locates Owner ${Math.random()}`, street: "9 Dig St", city: "Coos Bay",
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
    ...snapshot,
  } as never).project;
  runQcForProject(db, p.id);
  return Number(db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM human_review_items WHERE project_id = ? AND field_name = 'locates'", [p.id])?.n ?? 0) > 0;
};

check("MUST PASS: a roof mount with nothing buried is not asked about locates", () => {
  assert.equal(locatesAsked({ mounting: "Roof mount" }), false);
});

check("MUST EXCLUDE: a GROUND mount still asks — those genuinely trench", () => {
  assert.equal(locatesAsked({ mounting: "Ground mount" }), true);
});

check("MUST EXCLUDE: a roof mount whose plan mentions trenching still asks", () => {
  assert.equal(locatesAsked({ mounting: "Roof mount", planSetExtractedText: "Underground conduit trenched to the detached garage" }), true);
});

check("MUST EXCLUDE: unknown mounting still asks — silence is not proof nothing is buried", () => {
  assert.equal(locatesAsked({}), true);
});

// ---------------------------------------------------------------------------
// A TITLE IS NOT CONTENT (#114). Presence of a plan-set sheet is decided from its title
// (PLAN_SHEET_HINTS), so a sheet titled "Single Line Diagram" with no interconnection detail
// passed docs.sld while the row's `why` promised "rapid shutdown + NEC 705.12". The content
// layer reads the plan-set text for those elements and says, as an ADVISORY, what it could not
// find — never a failure, and never a second opinion that contradicts the city.* rules.
// ---------------------------------------------------------------------------
const { sheetContentGaps, adoptedNecEdition } = await import("../src/requiredDocuments");

// THE WAY PRODUCTION HOLDS THE TEXT: on the uploaded plan set's project_documents row
// (extracted_text), never in the stored snapshot — planSetExtractedText is a non-persistent
// overlay that updateProject strips. QC has to overlay it the way getProjectDetail does.
// A real parse always leaves SOME summary text (reviewFlags, stampRecommendation …), so the
// fixture carries one: without the overlay the check would read only that and cry "not found".
const titledSld = (body: string, summary = "Parser review flags: confirm equipment schedule.") => {
  const p = createProject(db, {
    clientId: client.id, owner: `SLD Owner ${++n}`, street: `${n} SLD St`, city: "Coos Bay",
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
    packetReadinessText: "READY - SLD",
    splitPagesText: "02 SLD Single Line Diagram: page 3",
    reviewFlags: summary,
  } as never).project;
  attach(p.id, "plan_set", body);
  const stored = JSON.parse(String(db.get<{ parser_json: string }>("SELECT parser_json FROM projects WHERE id = ?", [p.id])?.parser_json || "{}"));
  assert.ok(!stored.planSetExtractedText, "fixture must not carry the plan-set text in the stored snapshot");
  return docRules(p.id);
};

check("A TITLED SLD WITHOUT 705.12 TEXT: docs.sld passes presence, docs.sld.content is an advisory naming the interconnection", () => {
  const rules = titledSld("SINGLE LINE DIAGRAM. (20) 400W MODULES. MICROINVERTERS WITH RAPID SHUTDOWN PER 690.12.");
  const sld = rules.filter((r) => r.rule_id === "docs.sld");
  assert.equal(sld.filter((r) => r.qc_status !== "pass").length, 0,
    `the titled SLD must count as present: ${JSON.stringify(sld)}`);
  const content = rules.filter((r) => r.rule_id === "docs.sld.content");
  assert.equal(content.length, 1, `expected one docs.sld.content advisory: ${JSON.stringify(rules.map((r) => r.rule_id))}`);
  assert.equal(content[0].qc_status, "warning");
  assert.equal(content[0].severity, "info", "advisory only — the city.* rules decide blockers");
  assert.match(content[0].message, /705\.12/);
  assert.match(content[0].message, /interconnection/i);
  // Said by what was searched: the uploaded text was read here, so the row must not say only the
  // summary was — and the summary-only wording must never claim the sheets were read.
  assert.match(content[0].message, /plan set's searchable text/i, content[0].message);
  assert.doesNotMatch(content[0].message, /rapid shutdown \(|690\.12 rapid shutdown/i,
    `rapid shutdown IS shown and must not be named missing: ${content[0].message}`);
  assert.equal(rules.filter((r) => r.qc_status === "fail").length, 0, "a content gap must never fail QC");
});

check("...WITH the interconnection text on the uploaded plan set (not in the stored snapshot): no docs.sld.content advisory", () => {
  const rules = titledSld("SINGLE LINE DIAGRAM. RAPID SHUTDOWN PER 690.12. LOAD SIDE CONNECTION PER NEC 705.12: 200A BUSBAR, 200A MAIN, 40A PV BREAKER, 120% RULE.");
  assert.equal(rules.filter((r) => r.rule_id === "docs.sld.content").length, 0,
    `a fully shown SLD raised a content advisory: ${JSON.stringify(rules.filter((r) => r.rule_id === "docs.sld.content"))}`);
});

check("THE TITLE CANNOT VOUCH FOR ITSELF: sheet-title maps are not read as content, and no readable body says nothing", () => {
  // Only the title maps carry text: nothing was read, which is not evidence of absence.
  const rules = titledSld("", "");
  assert.equal(rules.filter((r) => /\.content$/.test(r.rule_id)).length, 0,
    `no body text was read, yet a content advisory fired: ${JSON.stringify(rules.filter((r) => /\.content$/.test(r.rule_id)))}`);
  // A title mentioning 705.12 does not count as the SLD showing it.
  const presence = [{ docType: "sld", label: "SLD", why: "", lane: "permit" as const, blocking: true, present: true, via: "in plan set" }];
  const gaps = sheetContentGaps({ parserSnapshot: {
    splitPagesText: "02 SLD 705.12 interconnection: page 3", packetReadinessText: "READY - SLD 705.12",
    planSetExtractedText: "RAPID SHUTDOWN COMPLIANT",
  } } as never, presence, []);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].missing.join(" "), /705\.12/);
});

check("NO PDF TEXT LAYER: the advisory says only the parser's summary was searched, not the sheets", () => {
  const rules = titledSld("", "Parser review flags: rapid shutdown per 690.12 noted.");
  const content = rules.filter((r) => r.rule_id === "docs.sld.content");
  assert.equal(content.length, 1, `expected one docs.sld.content advisory: ${JSON.stringify(rules.map((r) => r.rule_id))}`);
  assert.match(content[0].message, /parser's summary of the plan set only/i, content[0].message);
  assert.doesNotMatch(content[0].message, /searchable text plus/i, content[0].message);
});

check("EDITION-AWARE: the adopted NEC decides how the missing element is named", () => {
  const presence = [{ docType: "sld", label: "SLD", why: "", lane: "permit" as const, blocking: true, present: true, via: "in plan set" }];
  const project = { parserSnapshot: { planSetExtractedText: "MODULES AND INVERTER ONLY" } } as never;
  const nec2017 = [{ code: "NEC", edition: "2017", title: "National Electrical Code" }];
  const oesc2023 = [{ code: "OESC", edition: "2023", basedOn: "2023 NEC", title: "Oregon Electrical Specialty Code" }];
  assert.equal(adoptedNecEdition(nec2017 as never), 2017);
  assert.equal(adoptedNecEdition(oesc2023 as never), 2023);
  assert.equal(adoptedNecEdition([]), null);
  const old = sheetContentGaps(project, presence, nec2017 as never)[0].missing.join(" | ");
  const cur = sheetContentGaps(project, presence, oesc2023 as never)[0].missing.join(" | ");
  assert.match(old, /NEC 2017 705\.12 interconnection point \(supply side 705\.12\(A\)/, old);
  assert.match(cur, /NEC 2023 705\.11 supply-side \/ 705\.12 load-side/, cur);
  assert.match(cur, /PV hazard control/, cur);
  // 2017+ accepts the PV hazard control wording as rapid-shutdown evidence.
  const phc = sheetContentGaps({ parserSnapshot: { planSetExtractedText: "PV HAZARD CONTROL SYSTEM. POINT OF INTERCONNECTION AT MSP." } } as never, presence, oesc2023 as never);
  assert.equal(phc.length, 0, JSON.stringify(phc));
});

check("SITE PLAN, SPEC SHEETS, LABELS: each present sheet is checked for what its row promises", () => {
  const presence = ["site_plan", "module_spec", "inverter_spec", "labels", "structural"].map((docType) =>
    ({ docType, label: docType, why: "", lane: "permit" as const, blocking: true, present: true, via: "attached file" }));
  const bare = sheetContentGaps({ parserSnapshot: { planSetExtractedText: "ROOF PLAN. ARRAY LAYOUT." } } as never, presence, []);
  assert.deepEqual(bare.map((g) => g.docType).sort(), ["inverter_spec", "labels", "module_spec", "site_plan"],
    "structural has no content row in this issue; the other four do");
  const shown = sheetContentGaps({ parserSnapshot: { planSetExtractedText:
    "36 IN FIRE ACCESS PATHWAY PER R324.6. MODULE LISTED UL 61730. INVERTER LISTED UL 1741-SB. POWER SOURCE DIRECTORY PER 705.10. RAPID SHUTDOWN LABEL." } } as never, presence, []);
  assert.equal(shown.length, 0, JSON.stringify(shown));
  // A sheet that is NOT present is the presence row's business, not this one's.
  assert.equal(sheetContentGaps({ parserSnapshot: { planSetExtractedText: "x" } } as never,
    presence.map((p) => ({ ...p, present: false })), []).length, 0);
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nqcDocumentGate: all checks passed."
  : `\nqcDocumentGate: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
