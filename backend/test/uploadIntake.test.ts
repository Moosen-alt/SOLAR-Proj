// INTAKE HARDENING for multi-company scale. Three things that used to fail silently:
//
//  1. A CAD drawing (.dwg) uploaded as the plan set was stored, extracted to the
//     "[no text layer]" marker, counted as a present plan set, and then 500'd the
//     splitter with nothing the operator could act on. Now it is refused at the door
//     with a message naming the fix.
//  2. Uploaded files were on NO backup path — runBackup copied only the SQLite file
//     and litestream replicates only the DB, so a restore produced complete-looking
//     project rows whose every document 404'd.
//  3. A sealed structural letter the operator HAD uploaded never reached the AHJ:
//     PACKAGE_SETS omitted structural_letter entirely.
//
// Browser-free. Run: tsx backend/test/uploadIntake.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-intake-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const { saveProjectDocument, projectDocsByType } = await import("../src/projectDocuments");
const { sniffFileKind, looksLikeCad } = await import("../src/fileTypes");
const { runBackup } = await import("../src/backup");
const { buildUtilityPackage } = await import("../src/docSplitter");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

// A real (tiny) PDF, and convincing fakes of the other formats by magic bytes.
const realPdf = Buffer.from(await (await PDFDocument.create()).save());

// A plan set whose sheet titles the splitter can actually classify, so package
// assembly has something to work with.
async function planSetPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const title of ["3-LINE DIAGRAM", "SITE PLAN", "ROOF SECTION / RAFTER DETAIL"]) {
    doc.addPage([612, 792]).drawText(title, { x: 40, y: 740, size: 14, font });
  }
  return Buffer.from(await doc.save());
}
const planSet = await planSetPdf();
const dwgBytes = Buffer.concat([Buffer.from("AC1027", "latin1"), Buffer.alloc(64)]);
const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const zipBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);

const detail = createProject(db, {
  owner: "Intake Test", street: "9 Scale Rd", city: "Salem", state: "OR", zip: "97301",
  ahj: "City of Scale", utility: "PGE", dcKw: "7.2",
});
const projectId = detail.project.id;

const upload = (docType: string, filename: string, buffer: Buffer) =>
  saveProjectDocument(db, projectId, { docType, filename, contentType: "application/octet-stream", buffer, source: "upload" });

const refusal = (docType: string, filename: string, buffer: Buffer): string => {
  try {
    upload(docType, filename, buffer);
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

console.log("\n[1] file-type sniffing reads the bytes, not the name");
run("PDF bytes are recognized", sniffFileKind(realPdf) === "pdf");
run("DWG bytes are recognized", sniffFileKind(dwgBytes) === "dwg");
run("PNG bytes are recognized", sniffFileKind(pngBytes) === "png");
run("a .dwg name flags CAD even when the bytes are unknown", looksLikeCad("roof.dwg", "unknown"));
run("a .rvt (Revit) name flags CAD — no public magic to sniff", looksLikeCad("model.rvt", "unknown"));
run("a plain PDF is not mistaken for CAD", !looksLikeCad("plans.pdf", "pdf"));

console.log("\n[2] a CAD drawing can never occupy the plan-set slot");
const cadMsg = refusal("plan_set", "SITE-PLAN.dwg", dwgBytes);
run("upload is refused", cadMsg !== "");
run("the message says to export a PDF", /export.*PDF/i.test(cadMsg), cadMsg);
run("the message names the reference slot that WOULD accept it", /cad_source/.test(cadMsg), cadMsg);
run("no plan set was recorded", !projectDocsByType(db, projectId).plan_set);

// Renaming the CAD file to .pdf must not get it past the gate — this is the exact
// move a hurried designer makes, and extension trust is what let it through before.
const renamedMsg = refusal("plan_set", "SITE-PLAN.pdf", dwgBytes);
run("a DWG renamed to .pdf is still refused", renamedMsg !== "", renamedMsg);

console.log("\n[3] the same CAD file IS accepted as reference material");
const cadDoc = upload("cad_source", "SITE-PLAN.dwg", dwgBytes);
run("stored under cad_source", cadDoc.docType === "cad_source");
run("and still does not count as a plan set", !projectDocsByType(db, projectId).plan_set);

console.log("\n[4] the right file in the right slot goes through");
upload("plan_set", "plan-set.pdf", planSet);
run("a real PDF plan set is accepted", Boolean(projectDocsByType(db, projectId).plan_set));
// Magic bytes win in the operator's favour too: a PDF saved with no extension works.
upload("sld", "one-line-no-extension", realPdf);
run("PDF bytes with no file extension are accepted", Boolean(projectDocsByType(db, projectId).sld));
run("a photo is refused for a plan-sheet slot", refusal("site_plan", "roof.png", pngBytes) !== "");
run("a photo IS accepted for the meter-photo slot", Boolean(upload("meter_photo", "meter.png", pngBytes)));
run("a scanned PDF is also accepted for the meter-photo slot", Boolean(upload("utility_bill", "bill.pdf", realPdf)));
run("a ZIP is refused for the meter-photo slot", refusal("meter_photo", "photos.zip", zipBytes) !== "");
run("an empty file is still refused", refusal("plan_set", "empty.pdf", Buffer.alloc(0)) !== "");

console.log("\n[5] a sealed structural letter reaches the AHJ package");
upload("structural_letter", "PE-sealed-letter.pdf", realPdf);
const permitPkg = await buildUtilityPackage(db, projectId, "permit");
run("structural_letter is packaged", permitPkg.packagedDocTypes.includes("structural_letter"));
run("it is not reported missing", !permitPkg.missingDocTypes.includes("structural_letter"));

// A project with no letter must not be nagged: requiredDocuments is the single authority
// on whether THIS project needs a stamp, so the package never invents the requirement.
const clean = createProject(db, {
  owner: "No Stamp", street: "10 Scale Rd", city: "Salem", state: "OR", zip: "97301",
  ahj: "City of Scale", utility: "PGE", dcKw: "5.0",
});
saveProjectDocument(db, clean.project.id, { docType: "plan_set", filename: "p.pdf", contentType: "application/pdf", buffer: planSet, source: "upload" });
const cleanPkg = await buildUtilityPackage(db, clean.project.id, "permit");
run("a project without a letter is not flagged as missing one", !cleanPkg.missingDocTypes.includes("structural_letter"));

console.log("\n[6] the letter is found under the names other intake paths use");
const aliased = createProject(db, {
  owner: "Alias Test", street: "11 Scale Rd", city: "Salem", state: "OR", zip: "97301",
  ahj: "City of Scale", utility: "PGE", dcKw: "5.0",
});
saveProjectDocument(db, aliased.project.id, { docType: "stamped_plans", filename: "stamped.pdf", contentType: "application/pdf", buffer: realPdf, source: "upload" });
run("stamped_plans resolves as the structural letter", Boolean(projectDocsByType(db, aliased.project.id).structural_letter));

console.log("\n[7] uploaded files are actually backed up");
const info = runBackup(db);
run("the snapshot exists", fs.existsSync(info.file));
run("documents were mirrored", info.documentsMirrored > 0, `mirrored=${info.documentsMirrored}`);
run("every live document was copied", info.documentsCopied === info.documentsMirrored);
run("nothing is reported missing on disk", info.documentsMissingOnDisk === 0);

// Each mirrored file must be byte-identical, or the "backup" is decorative.
const liveDocs = projectDocsByType(db, projectId);
const planSetLive = liveDocs.plan_set;
const mirrorRoot = path.join(process.env.BACKUP_DIR!, "documents");
const mirrored = path.join(mirrorRoot, path.relative(process.env.PROJECT_DOCS_DIR!, planSetLive));
run("the mirrored plan set exists", fs.existsSync(mirrored), mirrored);
run("and is byte-identical", fs.existsSync(mirrored) && fs.readFileSync(mirrored).equals(fs.readFileSync(planSetLive)));

// A second run is incremental, not a full re-copy.
const second = runBackup(db);
run("a second run copies nothing new", second.documentsCopied === 0, `copied=${second.documentsCopied}`);

// Losing a live file is detected and reported — and the mirrored copy survives it,
// which is the whole point of keeping the mirror out of snapshot rotation.
fs.unlinkSync(planSetLive);
const afterLoss = runBackup(db);
run("a document lost from the live tree is reported", afterLoss.documentsMissingOnDisk >= 1, `missing=${afterLoss.documentsMissingOnDisk}`);
run("the mirrored copy survives the loss", fs.existsSync(mirrored));

console.log("\n[8] deleting a project removes its FILES, not just its rows");
const { deleteProject } = await import("../src/repository");
const doomed = createProject(db, {
  owner: "Doomed", street: "13 Gone St", city: "Salem", state: "OR", zip: "97301",
  ahj: "City of Scale", utility: "PGE", dcKw: "5.0",
});
saveProjectDocument(db, doomed.project.id, { docType: "plan_set", filename: "doomed.pdf", contentType: "application/pdf", buffer: planSet, source: "upload" });
const doomedFile = projectDocsByType(db, doomed.project.id).plan_set;
run("the file exists before deletion", fs.existsSync(doomedFile));
deleteProject(db, doomed.project.id);
run("the file is gone after deletion — no orphaned homeowner PII on disk", !fs.existsSync(doomedFile), doomedFile);
run("the project's document folder is gone too", !fs.existsSync(path.dirname(doomedFile)), path.dirname(doomedFile));

console.log(failures === 0 ? "\nuploadIntake: all checks passed" : `\nuploadIntake: ${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
