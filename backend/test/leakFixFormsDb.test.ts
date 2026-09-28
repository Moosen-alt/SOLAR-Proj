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

console.log(`\nleakFixFormsDb: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
