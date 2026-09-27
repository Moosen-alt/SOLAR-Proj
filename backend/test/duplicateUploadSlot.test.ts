// THE SAME FILE IS NEVER ATTACHED AS TWO DIFFERENT DOCUMENTS (measure item 9: City of Jefferson's
// inverter_spec upload was byte-identical to its module_spec). Real write path (saveProjectDocument),
// real selection (submissionDocumentsByType / documentInventory).
//
// KILL (verified red by hand): drop the duplicate removal in uploadedSubmissionDocuments → (u1) fails;
// drop the inventory flag → (u2) fails.
//
//   npx tsx backend/test/duplicateUploadSlot.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dup-upload-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;
const db = await (await import("../src/db")).openDatabase();
const repo = await import("../src/repository");
const docs = await import("../src/projectDocuments");
const sub = await import("../src/submissionDocuments");
const req = await import("../src/requiredDocuments");

let failures = 0;
const check = (name: string, fn: () => void) => { try { fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); } };
const make = () => repo.createProject(db, { owner: "Dup Owner", street: "1 Dup St", city: "Dupville", state: "OR", zip: "97000", ahj: "City of Dupville", utility: "Pacific Power", dcKw: "5", acKw: "4" } as never).project;
const save = (id: string, docType: string, bytes: string) =>
  docs.saveProjectDocument(db, id, { docType, filename: `${docType}.pdf`, contentType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n${bytes}\n`), source: "upload" });

const same = make();
save(same.id, "module_spec", "module and inverter sheet");
save(same.id, "inverter_spec", "module and inverter sheet");
const distinct = make();
save(distinct.id, "module_spec", "module sheet");
save(distinct.id, "inverter_spec", "inverter sheet");

check("(u1) MUST-EXCLUDE: a byte-identical upload is attached ONCE, under the first document type", () => {
  const picked = sub.submissionDocumentsByType(db, repo.getProjectDetail(db, same.id).project, null);
  assert.ok(picked.module_spec, "the module spec is attached");
  assert.equal(picked.inverter_spec, undefined, "the same bytes must not go up a second time as the inverter spec");
});
check("(u2) the inventory FLAGS the duplicate instead of calling it an ordinary attachment", () => {
  const inv = req.documentInventory(db, repo.getProjectDetail(db, same.id).project);
  const row = inv.presence.find((p) => p.docType === "inverter_spec")!;
  assert.equal(row.present, true);
  assert.match(row.via, /same file as module spec/);
});
check("(u3) MUST-PASS: two different files both attach", () => {
  const picked = sub.submissionDocumentsByType(db, repo.getProjectDetail(db, distinct.id).project, null);
  assert.ok(picked.module_spec && picked.inverter_spec);
  assert.equal(req.documentInventory(db, repo.getProjectDetail(db, distinct.id).project).presence.find((p) => p.docType === "inverter_spec")?.via, "attached file");
});

if (failures) { console.error(`\n${failures} duplicate-upload check(s) failed.`); process.exit(1); }
console.log("\nAll duplicate-upload checks passed.");
process.exit(0);
