// Missing completed applications/checklists/sealed letters must stay missing. A plan
// set in one of those slots used to look successful and become a permanent plan_set
// recipe binding. Covers resolution and the real browser upload/record/replay seams.
// No live portal or LLM; discovered automatically by npm run portal:test:dom.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, type ExtractedField } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";

type Mode = "combined" | "split";
type UploadInternals = {
  page: Page;
  resolveUpload(field: ExtractedField, required: boolean, accept: string): { docType: string; file: string } | null;
  performUploads(steps: RecipeStep[], filled: string[]): Promise<{ attached: number; missingRequired: string[] }>;
};
const noPlan = async () => ({ fills: [], atReview: false });
const adapter = (mode: Mode, docsByType: Record<string, string>): UploadInternals =>
  new AutoLearnAdapter("Local upload fixture", noPlan, { uploadMode: mode, docsByType }) as unknown as UploadInternals;
const pick = (a: UploadInternals, label: string, required = true, accept = ".pdf") =>
  a.resolveUpload({ selector: {}, label, fieldType: "file" }, required, accept);
const CASES = [
  ["Completed Building Permit Application", "building_application"],
  ["Building/structural permit application", "building_application"],
  ["Renewable Energy Electrical Permit Application", "electrical_application"],
  ["Electrical Renewable Energy Permit Application", "electrical_application"],
  ["Solar prescriptive checklist", "solar_checklist"],
  ["Eligibility worksheet", "solar_checklist"],
  ["Completed application", "permit_application"],
  ["Structural engineering letter", "structural_letter"],
  ["Sealed letter", "structural_letter"],
  ["Structural calculations", "structural_letter"],
] as const;
const tempRoot = path.resolve(os.tmpdir());
const dir = fs.mkdtempSync(path.join(tempRoot, "exact-document-upload-"));
const priorCap = process.env.PORTAL_UPLOAD_MAX_MB;
const makePdf = (name: string, body: string): string => {
  const file = path.join(dir, `${name}.pdf`);
  fs.writeFileSync(file, `%PDF-1.4\n${body}\n`);
  return file;
};
const plan = makePdf("plan_set", "PLAN SET -- NEVER AN APPLICATION");
const docs: Record<string, string> = { plan_set: plan };
for (const [, docType] of CASES) docs[docType] = makePdf(docType, `LEARN ${docType}`);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let checks = 0;
const check = (label: string, run: () => void) => { run(); checks++; console.log(`  ok - ${label}`); };

try {
  delete process.env.PORTAL_UPLOAD_MAX_MB;
  for (const mode of ["combined", "split"] as const) {
    for (const [label, docType] of CASES) {
      for (const required of [true, false]) {
        check(`${mode}: ${label} (${required ? "required" : "optional"}) cannot substitute plans`, () => {
          const missing = { ...docs };
          delete missing[docType];
          assert.equal(pick(adapter(mode, missing), label, required), null);
        });
      }
      check(`${mode}: ${label} keeps the exact document and binding`, () => {
        assert.deepEqual(pick(adapter(mode, docs), label), { docType, file: docs[docType] });
      });
      check(`${mode}: an incompatible ${docType} cannot become a different attachment`, () => {
        const zip = path.join(dir, `${docType}.zip`);
        fs.writeFileSync(zip, "not a PDF");
        assert.equal(pick(adapter(mode, { ...docs, [docType]: zip }), label), null);
      });
    }
    check(`${mode}: generic document control still takes the plan set`, () => {
      assert.equal(pick(adapter(mode, { plan_set: plan }), "Attach documents")?.docType, "plan_set");
    });
    check(`${mode}: a plan sheet can still use the full plan set`, () => {
      assert.equal(pick(adapter(mode, { plan_set: plan }), "Electrical one-line diagram")?.docType, "plan_set");
    });
    const large = path.join(dir, "oversize-application.pdf");
    fs.writeFileSync(large, Buffer.alloc(2 * 1024 * 1024));
    process.env.PORTAL_UPLOAD_MAX_MB = "1";
    check(`${mode}: a size-refused application stays missing`, () => {
      assert.equal(pick(adapter(mode, { plan_set: plan, building_application: large }), "Building Permit Application"), null);
    });
    delete process.env.PORTAL_UPLOAD_MAX_MB;
  }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await context.newPage();
  const labels = ["Building Permit Application", "Solar prescriptive checklist", "Structural engineering letter"];
  const types = ["building_application", "solar_checklist", "structural_letter"];
  const html = (chooser = false) => `<!doctype html><html><body>
    ${labels.map((label, i) => `<div class="form-group"><label for="doc${i}">${label}</label>
      ${chooser ? `<button type="button" id="doc${i}" aria-required="true" onclick="const f=document.createElement('input');f.type='file';f.accept='.pdf';f.id='chosen${i}';this.parentElement.appendChild(f);f.click()">Browse</button>`
        : `<input id="doc${i}" type="file" accept=".pdf" required>`}</div>`).join("")}
    </body></html>`;
  const uploadedTexts = () => page.locator('input[type="file"]').evaluateAll(async (inputs) =>
    Promise.all(inputs.map(async (input) => {
      const file = (input as HTMLInputElement).files?.[0];
      return file ? await file.text() : "";
    })));

  for (const mode of ["combined", "split"] as const) {
    for (const chooser of [false, true]) {
      await page.setContent(html(chooser));
      const missing = adapter(mode, { plan_set: plan });
      missing.page = page;
      const missingSteps: RecipeStep[] = [];
      const result = await missing.performUploads(missingSteps, []);
      check(`${mode}: missing ${chooser ? "chooser" : "native"} uploads remain visible gaps and record no steps`, () => {
        assert.equal(result.attached, 0);
        assert.deepEqual(result.missingRequired, labels);
        assert.deepEqual(missingSteps, []);
      });
      assert.ok((await uploadedTexts()).every((text) => !text), "no plan bytes were uploaded");
    }

    await page.setContent(html());
    const learner = adapter(mode, docs);
    learner.page = page;
    const steps: RecipeStep[] = [];
    const result = await learner.performUploads(steps, []);
    const learnedTexts = await uploadedTexts();
    check(`${mode}: real native uploads send the exact bytes and record their docTypes`, () => {
      assert.equal(result.attached, 3);
      assert.deepEqual(result.missingRequired, []);
      assert.deepEqual(steps.map((step) => step.docType), types);
      assert.deepEqual(learnedTexts, types.map((type) => fs.readFileSync(docs[type], "utf8")));
    });

    // Reuse learned steps against a different project's files. A literal path or an
    // erroneous plan_set binding cannot pass these byte assertions.
    const replayDocs = Object.fromEntries(types.map((type) => [type, makePdf(`replay-${mode}-${type}`, `REPLAY ${mode} ${type}`)]));
    const recipe = { id: "exact-doc-test", portalUrl: "about:blank", steps } as PortalRecipe;
    const replay = new RecipeAdapter(recipe, {}, { plan_set: plan, ...replayDocs }) as unknown as {
      page: Page;
      executeStep(step: RecipeStep, pastReview: boolean): Promise<boolean>;
      sweepUnrecordedUploads(): Promise<number>;
    };
    replay.page = page;
    await page.setContent(html());
    for (const step of steps) assert.equal(await replay.executeStep(step, false), true);
    const replayedTexts = await uploadedTexts();
    check(`${mode}: learned recipe uploads the next project's exact documents`, () => {
      assert.deepEqual(replayedTexts, types.map((type) => fs.readFileSync(replayDocs[type], "utf8")));
    });
    await page.setContent(html());
    const staleResult = await replay.executeStep({ ...steps[0], docType: "plan_set", note: "upload plan_set: Building Permit Application" }, false);
    check(`${mode}: legacy recipe cannot replay a plan set into an application slot`, () => {
      assert.equal(staleResult, false);
    });
    assert.ok((await uploadedTexts()).every((text) => !text));
    const swept = await replay.sweepUnrecordedUploads();
    check(`${mode}: unrecorded replay sweep still attaches exact application/checklist/letter files`, () => {
      assert.equal(swept, 3);
    });
    assert.deepEqual(await uploadedTexts(), types.map((type) => fs.readFileSync(replayDocs[type], "utf8")));
  }
  // The project can change after the run assembled its upload map. Exercise
  // the real upload boundaries, not just the backend's initial filter.
  await page.setContent(html());
  const reject = () => { throw new Error("permit path changed"); };
  const guardedLearn = new AutoLearnAdapter("Guard fixture", noPlan, { docsByType: docs, beforeUpload: reject }) as unknown as UploadInternals;
  guardedLearn.page = page;
  const guardedSteps: RecipeStep[] = [];
  const rejected = await guardedLearn.performUploads(guardedSteps, []);
  check("learn rechecks before native upload and records no blocked attachment", () => {
    assert.equal(rejected.attached, 0); assert.equal(guardedSteps.length, 0);
  });
  assert.ok((await uploadedTexts()).every(t => !t));
  const guardedReplay = new RecipeAdapter({ id: "guarded", steps: [] } as unknown as PortalRecipe, {}, docs, { beforeUpload: reject }) as unknown as {
    page: Page; executeStep(step: RecipeStep, review: boolean): Promise<boolean>; sweepUnrecordedUploads(): Promise<number>;
  };
  guardedReplay.page = page;
  await assert.rejects(() => guardedReplay.executeStep({ action: "upload", docType: "building_application", selector: { css: '#doc0' }, note: "upload building_application: Building Permit Application" } as RecipeStep, false), /permit path changed/);
  await assert.rejects(() => guardedReplay.sweepUnrecordedUploads(), /permit path changed/);
  assert.ok((await uploadedTexts()).every(t => !t));
  console.log(`\nAll ${checks} exact-document-upload checks passed (real Chromium, local HTML only).`);
} finally {
  await browser?.close();
  if (priorCap === undefined) delete process.env.PORTAL_UPLOAD_MAX_MB;
  else process.env.PORTAL_UPLOAD_MAX_MB = priorCap;
  assert.equal(path.dirname(path.resolve(dir)), tempRoot, "cleanup must stay inside the intended temporary directory");
  fs.rmSync(dir, { recursive: true, force: true });
}
