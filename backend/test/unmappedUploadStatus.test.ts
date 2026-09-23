// A FORM THAT MAPPED NOTHING IS NOT "ACQUIRED — IT WILL BE AUTO-FILLED".
//
// Uploading an unknown blank AcroForm with no LLM configured (StubLLMProvider maps no fields)
// returned status "acquired" with "Acquired and mapped X (0 field(s) of N). It will be
// auto-filled for <AHJ>." — and loadStoredTemplates drops any map with no fields, so the form
// silently fell out of every fill while the UI said it was in. The upload route derives
// `fillable` from `status === "acquired"`, and fill-form.html branches on `fillable`, so the
// status is the whole contract.
//
// THE INVARIANT pinned here: status "acquired" <=> the stored template takes part in the fill.
//
// Run: tsx backend/test/unmappedUploadStatus.test.ts
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unmapped-upload-"));
process.chdir(dir);
process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { acquireFromBytes } = await import("../src/ahjFormAuto");
const { loadStoredTemplates } = await import("../src/ahjForms");
const { StubLLMProvider } = await import("../src/llm");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

/** A random, never-seen AcroForm: N text fields with meaningless names, plus a checkbox. */
async function randomAcroForm(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Unknown Municipality Solar Form", { x: 50, y: 740, size: 14, font });
  const form = doc.getForm();
  for (let i = 0; i < n; i++) {
    const f = form.createTextField(`fld_${crypto.randomBytes(3).toString("hex")}_${i}`);
    f.addToPage(page, { x: 50, y: 700 - i * 30, width: 250, height: 20 });
  }
  form.createCheckBox(`chk_${crypto.randomBytes(3).toString("hex")}`).addToPage(page, { x: 50, y: 700 - n * 30, width: 12, height: 12 });
  return doc.save();
}

const db = await openDatabase();
const AHJ = `Unmappedville ${crypto.randomBytes(2).toString("hex")}`;
const bytes = await randomAcroForm(7);

console.log("\n1. STUB LLM, RANDOM ACROFORM — 0 of 8 fields mapped");
const result = await acquireFromBytes(db, new StubLLMProvider(), {
  ahj: AHJ, state: "OR", formType: "permit_application", formName: "Unknown Municipality Solar Form", bytes, sourceUrl: "",
});
check("1a. status is needs_manual, not acquired", result.status === "needs_manual", `${result.status}: ${result.message}`);
check("1b. mappedFields is 0", (result.mappedFields ?? 0) === 0, String(result.mappedFields));
check("1c. MUST EXCLUDE: the message does not promise it will be auto-filled", !/will be auto-filled/i.test(result.message), result.message);
check("1d. the message says it was NOT mapped / will NOT be auto-filled, and names the field count",
  /not be auto-filled|could not be mapped|couldn't be auto-mapped/i.test(result.message) && /\b8\b/.test(result.message), result.message);
const row = db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE ahj_name = ?", [AHJ]);
check("1e. the blank is still stored (for manual completion / re-map)", Boolean(row), "no row");
const inFill = loadStoredTemplates(db, AHJ, "OR").length > 0;
check("1f. INVARIANT: not acquired <=> not in the fill", (result.status === "acquired") === inFill, `status=${result.status} inFill=${inFill}`);

console.log("\n2. COUNTER-FIXTURE — the same PDF with a provider that DOES map a field is acquired and fills");
{
  const mapping = new StubLLMProvider() as unknown as Record<string, unknown>;
  const AHJ2 = `${AHJ} Mapped`;
  const firstField = (await PDFDocument.load(bytes)).getForm().getFields()[0].getName();
  mapping.mapAcroFormFields = async () => ({ provider: "stub", textFields: { [firstField]: "project.homeownerName" }, checkboxes: {}, notes: "fixture" });
  const r2 = await acquireFromBytes(db, mapping as never, {
    ahj: AHJ2, state: "OR", formType: "permit_application", formName: "Unknown Municipality Solar Form", bytes, sourceUrl: "",
  });
  const inFill2 = loadStoredTemplates(db, AHJ2, "OR").length > 0;
  check("2a. status acquired with 1 mapped field", r2.status === "acquired" && r2.mappedFields === 1, `${r2.status} ${r2.mappedFields}`);
  check("2b. INVARIANT holds the other way: acquired <=> in the fill", inFill2, `inFill=${inFill2}`);
}

console.log("\n3. THE CONSUMERS KEY ON THE STATUS (source pins)");
{
  const server = fs.readFileSync(path.join(repoRoot, "backend", "src", "server.ts"), "utf8");
  const route = server.slice(server.indexOf('"/api/ahj-templates/upload"'), server.indexOf('"/api/ahj-templates/upload"') + 2500);
  check("3a. the upload route's `fillable` is derived from status === \"acquired\"", /fillable:\s*result\.status === "acquired"/.test(route), "fillable derivation changed");
  const ui = fs.readFileSync(path.join(repoRoot, "frontend", "fill-form.html"), "utf8");
  check("3b. fill-form.html branches on upData.fillable before claiming the form was filled",
    /upData\.fillable === true/.test(ui) && /if \(mapped\) setStatus\("Done — form filled from the project\."/.test(ui), "fill-form.html no longer gates its success message");
}

db.close();
process.chdir(os.tmpdir());
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(failures ? `\nunmappedUploadStatus: ${failures} FAILED` : "\nunmappedUploadStatus: all passed");
process.exit(failures ? 1 : 0);
