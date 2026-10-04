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
const attach = (pid: string, docType: string) => {
  const file = path.join(tmpDir, `${pid}-${docType}.pdf`);
  fs.writeFileSync(file, "%PDF-1.4 test fixture");
  db.run(
    `INSERT INTO project_documents (id, project_id, doc_type, original_filename, stored_path, source, uploaded_at)
     VALUES (?, ?, ?, ?, ?, 'upload', ?)`,
    [`${pid}-${docType}`, pid, docType, `${docType}.pdf`, file, new Date().toISOString()],
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
// A PERSON-VERIFIED REQUIRED LIST BLOCKS; A SEEDED ONE ADVISES (#113, hard rule 3's shape).
//
// The per-job lookup's cited list used to feed ONLY docs.complete's warning: confidence was never
// read, so a list a person had checked against the AHJ's page carried no more force than one a
// lookup wrote. Now a verified list's slot items that are not attached are blocking docs.<slot>
// rows (in missingBlocking, so the submit gate refuses), citing the page and words; a seeded list
// is advice; a line no slot holds is advice on either confidence, and says why.
// ---------------------------------------------------------------------------
{
  const { savePermitProcessLookup } = await import("../src/permitProcess");
  const { getSubmitGateReport } = await import("../src/repository");
  const { requiredListCheck } = await import("../src/requiredDocuments");
  const STATE = "PA";
  const AHJ = "Borough of Verity Falls";
  const URL = "https://www.verityfalls-pa.example/building/solar-submittals";
  const QUOTE = "Submit a copy of the current utility bill and a waste debris form with every solar permit.";
  const none = () => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "not searched" });
  const LIST = ["Plan set", "Copy of the current utility bill", "Waste debris form"];
  const saveList = (verified: boolean) => savePermitProcessLookup(db, {
    state: STATE, ahj: AHJ, lookedUpAt: new Date().toISOString(), issuingAgency: none(), permitStructure: none(),
    permits: [{ discipline: "structural", label: "Building permit", issuingAgency: none(), portalUrl: none(), recordType: none(), fee: none(),
      documents: { value: LIST, sourceUrl: URL, quote: QUOTE, origin: "lookup" } }],
    ...(verified ? { confidence: "verified" as const } : {}),
  } as never, verified ? { verifiedBy: "test reviewer" } : {});
  const FULL_UNIVERSAL = ["plan_set", "site_plan", "sld", "structural", "module_spec", "inverter_spec", "labels"];
  const mkVerity = () => createProject(db, {
    clientId: client.id, owner: `Verity Owner ${++n}`, street: `${n} Verity Ln`, city: "Verity Falls",
    state: STATE, ahj: AHJ, utility: "Verity Falls Electric", dcKw: "8", acKw: "6.4",
  }).project;
  const proj = (pid: string) => ({ ...(db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [pid]) as object), id: pid, state: STATE, ahj: AHJ, utility: "Verity Falls Electric", parserSnapshot: {} }) as never;
  const docGate = (pid: string) => getSubmitGateReport(db, pid).checks.find((c: { id: string }) => c.id === "document-inventory") as { status: string; evidence: string[] };

  saveList(false);
  const seeded = mkVerity();
  for (const d of FULL_UNIVERSAL) attach(seeded.id, d);
  check("#113 SEEDED: a seeded list's missing slot item is advisory only — not in missingBlocking, no docs.<slot> error", () => {
    const inv = documentInventory(db, proj(seeded.id));
    assert.ok(!inv.missingBlocking.some((d) => d.docType === "utility_bill"), JSON.stringify(inv.missingBlocking.map((d) => d.docType)));
    const rules = docRules(seeded.id);
    assert.ok(!rules.some((r) => r.rule_id === "docs.utility_bill" && r.severity === "error"), JSON.stringify(rules));
    const complete = rules.find((r) => r.rule_id === "docs.complete");
    assert.equal(complete?.qc_status, "warning");
    assert.match(complete!.message, /utility bill/);
    assert.notEqual(docGate(seeded.id).status, "blocker", JSON.stringify(docGate(seeded.id)));
  });
  check("#113 NO SLOT: a line no slot holds is advisory and says it could not be matched (seeded)", () => {
    const complete = docRules(seeded.id).find((r) => r.rule_id === "docs.complete");
    assert.match(complete!.message, /Waste debris form \(could not match to a document type; attach as additional/);
  });

  // The same row, verified by a person.
  saveList(true);
  const verified = mkVerity();
  for (const d of FULL_UNIVERSAL) attach(verified.id, d);
  check("#113 VERIFIED: the same missing item now blocks — in missingBlocking, citing the page and the words", () => {
    const inv = documentInventory(db, proj(verified.id));
    const row = inv.missingBlocking.find((d) => d.docType === "utility_bill");
    assert.ok(row, JSON.stringify(inv.missingBlocking.map((d) => d.docType)));
    assert.ok(row!.why.includes(URL) && row!.why.includes(QUOTE), row!.why);
    assert.equal(row!.verifiedList?.sourceUrl, URL);
  });
  check("#113 VERIFIED: QC raises a docs.utility_bill error row (warning status, error severity)", () => {
    const rules = docRules(verified.id);
    const r = rules.find((x) => x.rule_id === "docs.utility_bill");
    assert.ok(r && r.severity === "error" && r.qc_status === "warning", JSON.stringify(rules));
    assert.ok(r!.message.includes(URL), r!.message);
  });
  check("#113 VERIFIED: the submit gate refuses, with the citation", () => {
    const g = docGate(verified.id);
    assert.equal(g.status, "blocker", JSON.stringify(g));
    assert.ok(g.evidence.some((e) => /MISSING \(required\)/.test(e) && e.includes(URL)), JSON.stringify(g.evidence));
  });
  check("#113 NO SLOT stays advisory when verified too — never a blocking row, and said so", () => {
    const inv = documentInventory(db, proj(verified.id));
    assert.ok(!inv.missingBlocking.some((d) => /waste debris/i.test(d.label)), JSON.stringify(inv.missingBlocking.map((d) => d.label)));
    const complete = docRules(verified.id).find((r) => r.rule_id === "docs.complete");
    assert.match(complete!.message, /Waste debris form \(could not match to a document type; attach as additional/);
    assert.match(complete!.message, /verified by a person/);
  });
  check("#113 VERIFIED + PRESENT: an attached verified item is a pass row, and the gate no longer blocks on it", () => {
    attach(verified.id, "utility_bill");
    const inv = documentInventory(db, proj(verified.id));
    const p = inv.presence.find((d) => d.docType === "utility_bill");
    assert.ok(p?.present && p.blocking, JSON.stringify(p));
    assert.ok(!inv.missingBlocking.some((d) => d.docType === "utility_bill"));
    const item = requiredListCheck(db, proj(verified.id), inv).items.find((i) => /utility bill/.test(i.text));
    assert.equal(item?.present, true, JSON.stringify(item));
    assert.ok(!docRules(verified.id).some((r) => r.rule_id === "docs.utility_bill"));
    assert.notEqual(docGate(verified.id).status, "blocker", JSON.stringify(docGate(verified.id)));
  });
}

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

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nqcDocumentGate: all checks passed."
  : `\nqcDocumentGate: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
