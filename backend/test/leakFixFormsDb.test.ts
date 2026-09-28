// LEAK-FIX (forms, documents, client messages) — the database half. Each section pins one
// confirmed sweep finding (.probe/leak-sweep/RESULT.json) through the REAL write paths
// (createClient, createProject, assignProjectClient, createSignature, buildContext,
// fillLoadedForm), with a MUST-PASS beside every MUST-EXCLUDE. Synthetic companies and people only.
//
//   npx tsx backend/test/leakFixFormsDb.test.ts
import "./_isolate"; // FIRST: temp cwd, so filled/ and docs/ never land in the repo
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "leak-fix-forms-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE"]) process.env[k] = "off";
process.env.DOCUMENT_FETCH_BROWSER = "0";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "false";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const R = await import("../src/repository");
const sig = await import("../src/signatures");
const forms = await import("../src/ahjForms");
const { curatedFormMap } = await import("../src/curatedAhjForms");
const { extractLabels } = await import("../src/formTextLayer");
const { createCanvas } = await import("@napi-rs/canvas");

let db = await openDatabase();
let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// A real PNG with ink, so the filler's margin trim and pdf-lib's embed both run for real.
const inkPng = (): Uint8Array => {
  const c = createCanvas(160, 48);
  const g = c.getContext("2d");
  g.strokeStyle = "#000"; g.lineWidth = 3;
  g.beginPath(); g.moveTo(8, 38); g.bezierCurveTo(40, 4, 80, 44, 150, 10); g.stroke();
  return new Uint8Array(c.toBuffer("image/png"));
};
const imageCount = (bytes: Uint8Array): number => (Buffer.from(bytes).toString("latin1").match(/\/Subtype\s*\/Image/g) || []).length;

// ---------------------------------------------------------------------------------------------
// F2 — a licence holder's signature is the job's COMPANY's; the applicant is the org's submitter.
// ---------------------------------------------------------------------------------------------
const alpha = createClient(db, { companyName: "Alpha Test Solar LLC", electricalSupervisorName: "Sam Sparksworth" });
const beta = createClient(db, { companyName: "Beta Test Solar LLC", electricalSupervisorName: "Bea Voltaire" });
const noSup = createClient(db, { companyName: "Gamma Test Solar LLC" });

// THE MIGRATION (v40): replayed over the pre-v40 shape — org-level rows with no company. That shape
// is written raw on purpose: the fixed write path can no longer produce it (a licence-holder
// signature without a company is refused), and it is exactly what the live table holds.
const png = inkPng();
const legacy = (idv: string, role: string, name: string, isDefault: number): void => {
  db.run(
    `INSERT INTO signatures (id, role, name, image_png, mime, width_px, height_px, is_default, created_at, updated_at, org_id, client_id)
     VALUES (?, ?, ?, ?, 'image/png', 160, 48, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'org-default', '')`,
    [idv, role, name, Buffer.from(png), isDefault],
  );
};
createClient(db, { companyName: "Delta Twin LLC", electricalSupervisorName: "Dana Duo" });
createClient(db, { companyName: "Epsilon Twin LLC", electricalSupervisorName: "Dana Duo" });
legacy("legacy-elec-alpha", "electrician", "Sam Sparksworth", 1);
legacy("legacy-elec-twin", "electrician", "Dana Duo", 0);
legacy("legacy-elec-nobody", "electrician", "Nobody Onfile", 0);
legacy("legacy-applicant", "applicant", "Ada Submitter", 1);
db.run("DELETE FROM schema_meta WHERE version >= 40");
db = await openDatabase();
const clientOf = (idv: string): string => String(db.get<{ c: string }>("SELECT client_id AS c FROM signatures WHERE id = ?", [idv])?.c ?? "?");

await check("F2 migration MUST-PASS: an electrician signature goes to the ONE company whose supervisor it names", () => {
  assert.equal(clientOf("legacy-elec-alpha"), alpha.id);
});
await check("F2 migration MUST-EXCLUDE: ambiguous / unmatched electricians stay unassigned; the applicant stays org-level", () => {
  assert.equal(clientOf("legacy-elec-twin"), "", "two companies name the same supervisor — never guess");
  assert.equal(clientOf("legacy-elec-nobody"), "");
  assert.equal(clientOf("legacy-applicant"), "");
});

const project = (clientId: string, over: Record<string, unknown> = {}) => {
  const detail = R.createProject(db, {
    owner: "Test Homeowner", state: "OR", city: "Tigard", zip: "97223", street: "1 Test Lane", ahj: "City of Tigard",
    utility: "Portland General Electric", dcKw: "7.2", acKw: "5.8", permitPath: "prescriptive", ...over,
  } as never);
  return R.assignProjectClient(db, detail.project.id, clientId).project;
};
const alphaJob = project(alpha.id);
const betaJob = project(beta.id);
const betaUtah = project(beta.id, { state: "UT", city: "Salt Lake City", zip: "84101", ahj: "Salt Lake City", utility: "Rocky Mountain Power" });
const gammaJob = project(noSup.id);

await check("F2 MUST-PASS: the job's own company gets its own electrician (signature + printed name); the applicant is the org's", () => {
  const ctx = forms.buildContext(db, alphaJob);
  assert.equal(ctx.signatures?.electrician?.name, "Sam Sparksworth");
  assert.equal(ctx.signatures?.applicant?.name, "Ada Submitter");
  assert.equal(forms.resolveSource("computed.electricianSignerName", ctx), "Sam Sparksworth");
});

await check("F2 MUST-EXCLUDE: another company's job never loads that electrician (OR or UT), and prints its OWN supervisor", () => {
  for (const job of [betaJob, betaUtah]) {
    const ctx = forms.buildContext(db, job);
    assert.equal(ctx.signatures?.electrician, undefined, `${job.state}: another company's electrician signature was loaded`);
    assert.equal(forms.resolveSource("computed.electricianSignerName", ctx), "Bea Voltaire");
    assert.equal(ctx.signatures?.applicant?.name, "Ada Submitter", "the applicant is whoever submits — the org's, on every company's job");
  }
});

await check("F2 MUST-EXCLUDE: a company with no supervisor on record prints NO electrician name (never the org's)", () => {
  const ctx = forms.buildContext(db, gammaJob);
  assert.equal(forms.resolveSource("computed.electricianSignerName", ctx), "");
});

// The real curated Tigard electrical application: an electrician placement (with its date line)
// and an applicant placement, both printed-name overlays.
const tigardBytes = new Uint8Array(fs.readFileSync(path.join(REPO, "backend/test/fixtures/tigard-electrical.pdf")));
const tigardMap = curatedFormMap(tigardBytes, "https://www.tigard-or.gov/home/showpublisheddocument/44/637615268530600000")!.map;
const tigardDef = { ...tigardMap, id: "tigard-electrical-test", state: "OR", notes: [], status: "verified", matchJurisdictions: ["tigard"], version: "test" } as never;
const fillTigard = async (job: typeof alphaJob, name: string) => {
  const out = path.join(process.cwd(), `${name}.pdf`);
  const result = await forms.fillLoadedForm(tigardDef, tigardBytes, forms.buildContext(db, job), out);
  const bytes = new Uint8Array(fs.readFileSync(out));
  const labels = await extractLabels(bytes);
  // A signing date written on the electrician's date line (the curated map's dateY 81; the
  // applicant's date line sits at 39).
  const electricianDate = labels.some((l) => /^\d{2}\/\d{2}\/\d{4}$/.test(l.str.trim()) && Math.abs(l.y - 81) < 4);
  return { result, bytes, text: labels.map((l) => l.str).join(" "), electricianDate };
};
const blankImages = imageCount(tigardBytes);
const alphaFill = await fillTigard(alphaJob, "alpha-tigard");
const betaFill = await fillTigard(betaJob, "beta-tigard");

await check("F2 MUST-PASS: the company's own Tigard electrical application is stamped with ITS electrician (and the applicant)", () => {
  assert.equal(alphaFill.result.status, "filled");
  assert.ok(imageCount(alphaFill.bytes) >= blankImages + 2, `images: blank ${blankImages}, filled ${imageCount(alphaFill.bytes)}`);
  assert.match(alphaFill.text, /Sam Sparksworth/);
  assert.ok(alphaFill.electricianDate, "the electrician signs today — the date line carries the date");
  assert.ok(!(alphaFill.result.unmappedRequested ?? []).some((l) => /Electrician signature/.test(l)), "its own electrician is on file — nothing owed");
});

await check("F2 MUST-EXCLUDE: another company's Tigard application carries NONE of that electrician — image, name or date", () => {
  assert.equal(betaFill.result.status, "filled");
  // (A transparent PNG embeds as an image plus its soft mask, so counts move in pairs.)
  assert.ok(imageCount(betaFill.bytes) < imageCount(alphaFill.bytes), `the electrician's image was drawn: beta ${imageCount(betaFill.bytes)} vs alpha ${imageCount(alphaFill.bytes)}`);
  assert.ok(imageCount(betaFill.bytes) > blankImages, "the applicant (the org's submitter) still signs");
  assert.ok(!/Sam Sparksworth/.test(betaFill.text), "another company's electrician was printed");
  assert.ok(!betaFill.electricianDate, "a signing date was written on an unsigned electrician line");
  assert.match(betaFill.text, /Bea Voltaire/, "the job's own supervisor stays on its own print-name line");
});

await check("F2 operator item: the unsigned licence-holder line is NAMED on the fill result (blank + message)", () => {
  const item = (betaFill.result.unmappedRequested ?? []).find((l) => /Electrician signature/.test(l)) ?? "";
  assert.match(item, /no electrician signature on file for Beta Test Solar LLC/);
  assert.match(String(betaFill.result.message), /Left unsigned: Electrician signature/);
});

await check("F2 write door: a licence-holder signature needs a company of THIS org (400 without, 404 for another org's)", async () => {
  await assert.rejects(() => sig.createSignature(db, { role: "electrician", name: "X", bytes: png, mime: "image/png", isDefault: true, orgId: "org-default" }), /choose that company/);
  await assert.rejects(() => sig.createSignature(db, { role: "electrician", name: "X", bytes: png, mime: "image/png", isDefault: true, orgId: "org-other", clientId: beta.id }), /Client not found/);
  const applicant = await sig.createSignature(db, { role: "applicant", name: "Other Agent", bytes: png, mime: "image/png", isDefault: false, orgId: "org-default", clientId: beta.id });
  assert.equal(applicant.clientId, "", "an org-level role never carries a company");
});

await check("F2 defaults are per company: Beta's electrician default does not demote Alpha's", async () => {
  const betaSig = await sig.createSignature(db, { role: "electrician", name: "Bea Voltaire", bytes: png, mime: "image/png", isDefault: true, orgId: "org-default", clientId: beta.id });
  assert.equal(betaSig.clientId, beta.id);
  assert.equal(forms.buildContext(db, alphaJob).signatures?.electrician?.name, "Sam Sparksworth");
  assert.equal(forms.buildContext(db, betaJob).signatures?.electrician?.name, "Bea Voltaire");
  sig.setDefaultSignature(db, betaSig.id, "org-default");
  assert.equal(forms.buildContext(db, alphaJob).signatures?.electrician?.name, "Sam Sparksworth");
});

// ---------------------------------------------------------------------------------------------
// F8 — the learn planner's KB block (autoLearn.buildLearnKbContext) and the form-research hint
// (knowledgeResearchHint): one company's logins and licence numbers in a SHARED row never reach
// another company's prompt.
// ---------------------------------------------------------------------------------------------
const { importSeededAhjKnowledge, knowledgeResearchHint } = await import("../src/knowledgeBase");
const { buildLearnKbContext } = await import("../src/autoLearn");
importSeededAhjKnowledge(db, {
  state: "OR", ahj: "City of Leakton",
  notes: [
    "Leakton files structural and electrical on one portal record",
    "Operator credential stored for this portal.",
    "User name someone@alpha-test-solar.test",
    "WA COUNTY FOR ELEC AND LEAKTON FOR STRUC. metro license # 98765",
  ].join(" | "),
} as never);
const leakJob = project(beta.id, { city: "Leakton", ahj: "City of Leakton" });

await check("F8 MUST-EXCLUDE: another company's learn prompt carries no login, no 'credential stored', no licence number", () => {
  const ctx = buildLearnKbContext(db, leakJob, { scopeType: "ahj", permitType: "electrical" });
  const hint = knowledgeResearchHint(db, { state: "OR", ahj: "City of Leakton" }, "ahj")?.text ?? "";
  for (const text of [ctx, hint]) {
    assert.ok(!/credential stored/i.test(text), `"credential stored" reached a prompt: ${text}`);
    assert.ok(!/alpha-test-solar/.test(text), `a login email reached a prompt: ${text}`);
    assert.ok(!/98765/.test(text), `a company licence number reached a prompt: ${text}`);
  }
});

await check("F8 MUST-PASS: the AHJ's knowledge still reaches the planner (routing, and which licence it asks for)", () => {
  const ctx = buildLearnKbContext(db, leakJob, { scopeType: "ahj", permitType: "electrical" });
  assert.match(ctx, /one portal record/);
  assert.match(ctx, /LEAKTON FOR STRUC\. metro license # \[the job's company's own number\]/);
});

// ---------------------------------------------------------------------------------------------
// F6 — a hedged STATE-level seeded stamp threshold is a waivable advisory, never a staging refusal
// worded "<AHJ> requires"; the AHJ's own cited row, or a person-verified row, still blocks.
// ---------------------------------------------------------------------------------------------
const { documentInventory } = await import("../src/requiredDocuments");
const stampRow = (job: typeof alphaJob) => documentInventory(db, job).presence.find((p) => p.docType === "structural_letter");
const ma = project(beta.id, { state: "MA", city: "Newton", zip: "02458", ahj: "City of Newton", utility: "Eversource", dcKw: "12", acKw: "10" });
const az = project(beta.id, { state: "AZ", city: "Maricopa", zip: "85138", ahj: "City of Maricopa", utility: "APS", dcKw: "16", acKw: "13" });
const ca = project(beta.id, { state: "CA", city: "Fresno", zip: "93721", ahj: "City of Fresno", utility: "PG&E", dcKw: "11", acKw: "9" });

await check("F6 MUST-EXCLUDE: MA / AZ / CA state-level seeded thresholds never block, never say '<AHJ> requires'", () => {
  for (const job of [ma, az, ca]) {
    const row = stampRow(job);
    assert.ok(row, `${job.ahj}: the note must still be NAMED (an advisory row), not dropped`);
    assert.equal(row!.blocking, false, `${job.ahj}: a state-level seeded note blocked staging — ${row!.why}`);
    assert.ok(!new RegExp(`${job.ahj} requires`).test(row!.why), `${job.ahj}: ${row!.why}`);
    assert.match(row!.why, /[Cc]onfirm/);
    assert.ok(!documentInventory(db, job).missingBlocking.some((p) => p.docType === "structural_letter"));
  }
});

await check("F6 MUST-PASS: the AHJ's own cited row (Chicago, any size) and a person-verified state row (Oregon) still block", () => {
  const chicago = project(beta.id, { state: "IL", city: "Chicago", zip: "60601", ahj: "Chicago", utility: "ComEd", dcKw: "4", acKw: "3.8" });
  const row = stampRow(chicago);
  assert.equal(row?.blocking, true, `Chicago: ${row?.why}`);
  assert.match(String(row?.why), /Chicago requires/);
  const oregonBig = project(beta.id, { dcKw: "60", acKw: "50" });
  const orRow = stampRow(oregonBig);
  assert.equal(orRow?.blocking, true, `Oregon 60 kW: ${orRow?.why}`);
});

// ---------------------------------------------------------------------------------------------
// F5 — an UNCONFIRMED permit structure never tells the client a "combination building &
// electrical permit" was issued, nor that "the building and electrical side is cleared".
// ---------------------------------------------------------------------------------------------
const { clientUpdateFor } = await import("../src/clientUpdates");
const { trackLabel, projectStatusHistory } = await import("../src/clientPortal");
const { requiredTracks } = await import("../src/submittalTracks");
const { savePermitProcessLookup } = await import("../src/permitProcess");
const cited = (value: string, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const nf = (why: string) => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });

const walthamLike = project(beta.id, { state: "MA", city: "Wexham", zip: "02451", ahj: "City of Wexham", utility: "Eversource" });
const wx = R.getProjectDetail(db, walthamLike.id).project;
await check("F5 premise: an MA AHJ with no cited structure gets the default single 'combo' track", () => {
  assert.ok(requiredTracks(wx).includes("combo"), requiredTracks(wx).join(","));
});

await check("F5 MUST-EXCLUDE: the client email never names a 'combination' permit or says the building AND electrical side is cleared", () => {
  const u = clientUpdateFor(db, wx, "issued", { targetType: "permit", permitType: "combo", permitNumber: "B-26-0001" })!;
  assert.match(u.headline, /has issued the permit, reference B-26-0001/, u.headline);
  assert.doesNotMatch(`${u.headline} ${u.meaning}`, /combination|building and electrical side is cleared/i, JSON.stringify(u));
  assert.match(u.meaning, /separate electrical permit/i, "it says what is still being confirmed");
  const c = clientUpdateFor(db, wx, "correction_flagged", { targetType: "permit", permitType: "combo" })!;
  assert.doesNotMatch(c.headline, /combination/i, c.headline);
});

await check("F5 MUST-EXCLUDE: the client's status page calls the unconfirmed default track just 'Permit'", async () => {
  R.createPermitCheckTarget(db, wx.id, { jurisdiction: "City of Wexham", portalName: "", portalUrl: "", applicationNumber: "B-26-0001", permitType: "combo", targetType: "permit" } as never);
  const tid = String(db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? LIMIT 1", [wx.id])?.id);
  await R.recordPermitStatusCheck(db, wx.id, { targetId: tid, source: "manual", rawStatusText: "Plan review in progress." } as never);
  const labels = projectStatusHistory(db, wx.id).map((e) => e.label);
  assert.ok(labels.length && labels.every((l) => l === "Permit"), JSON.stringify(labels));
});

await check("F5 MUST-PASS: a CITED combination permit is still named, and the whole-job claim is made", () => {
  const saved = savePermitProcessLookup(db, {
    state: "MA", ahj: "City of Combotown", lookedUpAt: new Date().toISOString(), issuingAgency: nf("not stated"),
    permitStructure: cited("combo", "https://combotown.example.gov/solar", "One permit covers the structural and electrical work."),
    permits: [], notes: [],
  } as never);
  assert.equal((saved as { saved?: boolean }).saved, true);
  const combo = R.getProjectDetail(db, project(beta.id, { state: "MA", city: "Combotown", zip: "02000", ahj: "City of Combotown", utility: "" }).id).project;
  const u = clientUpdateFor(db, combo, "issued", { targetType: "permit", permitType: "combo" })!;
  assert.match(u.headline, /combination building & electrical permit/, u.headline);
  assert.match(u.meaning, /building and electrical side is cleared/, u.meaning);
  assert.equal(trackLabel("permit", "combo", { combo: true }), "Combination building & electrical permit");
});

await check("F5 MUST-PASS: Oregon (state rule: separate) keeps 'the building and electrical side is cleared' once all is through", () => {
  const u = clientUpdateFor(db, R.getProjectDetail(db, alphaJob.id).project, "issued", { targetType: "permit", permitType: "electrical" })!;
  assert.match(u.meaning, /building and electrical side is cleared|still in review|clears the permit side/, u.meaning);
});

console.log(`\nleakFixFormsDb: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
