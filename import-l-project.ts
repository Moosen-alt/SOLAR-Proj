// Import a REAL project from the operator's archive into the LIVE db, so live portal
// learns/replays can be exercised with genuinely DIFFERENT data than the recipe was
// recorded with — which is the only thing that proves a recipe replays "forever" rather
// than replaying the one project it was learned on.
//
//   npx tsx import-l-project.ts --list [pge|pacificorp]
//   npx tsx import-l-project.ts "Abby Johnson - Happy Valley OR"
//
// Writes to the live DB on purpose (the live portal drivers read it). Delete after use.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const ROOT = "L:/INFINITY SOLAR DOCS";
const ARCHIVE = `${ROOT}/01 - CUSTOMERS`;

// PGE serves the Portland metro / Salem corridor; Pacific Power (PacifiCorp) serves the
// coast and much of the south/mid valley. Used only to SUGGEST candidates — the utility
// actually filed comes from the plan set the parser reads.
const PGE_CITIES = /portland|beaverton|tigard|happy valley|newberg|turner|salem|keizer|hillsboro|gresham|milwaukie|oregon city|tualatin|sherwood|wilsonville|canby|molalla|estacada|clackamas|west linn|lake oswego/i;
const PAC_CITIES = /coos bay|lincoln city|cottage grove|lebanon|falls city|corvallis|albany|dallas|independence|monmouth|sweet home|newport|florence|roseburg|medford|grants pass|klamath|bend|redmond|prineville|the dalles|hood river|astoria|seaside|tillamook/i;

const folders = fs.readdirSync(ARCHIVE, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "COMPLETED" && d.name.includes(" - "))
  .map((d) => d.name).sort();

const listArg = process.argv.includes("--list");
if (listArg) {
  const which = (process.argv[process.argv.indexOf("--list") + 1] || "").toLowerCase();
  const re = which === "pge" ? PGE_CITIES : which === "pacificorp" ? PAC_CITIES : null;
  const shown = re ? folders.filter((f) => re.test(f)) : folders;
  console.log(`${shown.length} candidate folder(s)${re ? ` for ${which}` : ""}:`);
  for (const f of shown) console.log(`  ${f}`);
  process.exit(0);
}

const folder = process.argv.slice(2).filter((a) => !a.startsWith("--"))[0];
if (!folder) { console.error('pass a folder name, or --list [pge|pacificorp]'); process.exit(2); }
const dir = path.join(ARCHIVE, folder);
if (!fs.existsSync(dir)) { console.error(`no such folder: ${dir}`); process.exit(2); }

const { openDatabase } = await import("./backend/src/db");
const { extractPdfText } = await import("./backend/src/batchImport");
const { createLLMProvider } = await import("./backend/src/llm");
const { createProject, rerunQc, getProjectDetail } = await import("./backend/src/repository");
const { saveProjectDocument } = await import("./backend/src/projectDocuments");
const { buildUtilityPackage } = await import("./backend/src/docSplitter");
const { resolveRecipeFieldValues } = await import("./backend/src/portalRecipes");

// The plan set is the PDF named like the folder; fall back to the largest PDF.
const pdfs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"))
  .map((f) => ({ f, full: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }));
if (!pdfs.length) { console.error("no PDF in that folder"); process.exit(1); }
const owner = folder.split(" - ")[0].toLowerCase().replace(/[^a-z]/g, "");
const named = pdfs.filter((p) => p.f.toLowerCase().replace(/[^a-z]/g, "").startsWith(owner));
const planSet = (named.length ? named : pdfs).sort((a, b) => b.size - a.size)[0].full;

const db = await openDatabase();
const llm = createLLMProvider();
console.log(`folder   ${folder}`);
console.log(`plan set ${path.basename(planSet)}`);

const planText = await extractPdfText(planSet, 30);
console.log(`text     ${planText.length} chars`);
const ex = await llm.extractProjectFields({ planText, defaultState: "OR" });
const f = ex.fields as Record<string, { value?: string }>;
const payload: Record<string, unknown> = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v?.value ?? ""]));
payload.owner = payload.owner || folder.split(" - ")[0];
payload.city = payload.city || (folder.split(" - ")[1] || "").replace(/,?\s*OR$/i, "").trim();
payload.state = payload.state || "OR";

// SYNTHETIC only where the plan set cannot supply it, and TEST-prefixed so an account or
// meter number can never be mistaken for a real one on a live portal.
const n = Math.abs([...folder].reduce((a, c) => a + c.charCodeAt(0), 0)) % 9000 + 1000;
const synth: Record<string, string> = {
  accountNumber: `TEST-${n}0000${n % 97}`,
  meterNumber: `TEST-M${n}${n % 89}`,
  homeownerEmail: "test.homeowner@example.invalid",
  homeownerPhone: `541-555-${String(n).padStart(4, "0")}`,
  jobValue: "30000",
};
const synthesized: string[] = [];
for (const [k, v] of Object.entries(synth)) {
  if (!String(payload[k] ?? "").trim()) { payload[k] = v; synthesized.push(k); }
}

const detail = createProject(db, payload as never);
saveProjectDocument(db, detail.project.id, {
  docType: "plan_set", filename: path.basename(planSet),
  contentType: "application/pdf", buffer: fs.readFileSync(planSet), source: "upload",
});
// THE METER PHOTO. Never in the plan set — it is taken at the house — so the split above
// cannot produce it, and PacifiCorp's interconnection application asks for "a photo of
// meter where system will be interconnected". The operator's archive folder already holds
// one (Utility_Meter-NN.jpg) for most projects; without ingesting it the application
// reaches review with a required upload blank.
const meterPhoto = fs.readdirSync(dir)
  .find((f) => /meter/i.test(f) && /\.(jpe?g|png|webp)$/i.test(f));
if (meterPhoto) {
  saveProjectDocument(db, detail.project.id, {
    docType: "meter_photo", filename: meterPhoto,
    contentType: /\.png$/i.test(meterPhoto) ? "image/png" : "image/jpeg",
    buffer: fs.readFileSync(path.join(dir, meterPhoto)), source: "upload",
  });
  console.log(`meter    ${meterPhoto}`);
} else {
  console.log("meter    NO meter photo in the archive folder — the portal will ask for one");
}
// Split into the per-type documents the portal upload steps attach (sld, site_plan, specs).
try {
  const pkg = await buildUtilityPackage(db, detail.project.id, "all");
  console.log(`split    ${Array.isArray((pkg as { documents?: unknown[] }).documents) ? (pkg as { documents: unknown[] }).documents.length : "?"} document(s)`);
} catch (err) {
  console.log(`split    FAILED: ${err instanceof Error ? err.message : String(err)}`);
}
rerunQc(db, detail.project.id);
const after = getProjectDetail(db, detail.project.id, null);

console.log(`\nprojectId ${after.project.id}`);
console.log(`owner     ${after.project.homeownerName}`);
console.log(`address   ${after.project.projectAddress}, ${after.project.city}, ${after.project.state} ${after.project.zip}`);
console.log(`ahj       ${after.project.ahj || "(none)"}`);
console.log(`utility   ${after.project.utility || "(none)"}`);
console.log(`size      ${after.project.systemSizeDcKw ?? "?"} kW dc`);
console.log(`synth     ${synthesized.join(", ") || "(none — plan set supplied everything)"}`);
console.log(`qc        ${after.qcResults.filter((q) => q.qcStatus === "fail").length} fail / ${after.qcResults.filter((q) => q.qcStatus === "warning").length} warn`);

const fv = resolveRecipeFieldValues(db, after.project, "powerclerk");
const interesting = ["homeownerFirstName", "homeownerLastName", "street", "city", "zip", "moduleMake", "moduleModel", "inverterMake", "inverterModel", "inverterQty", "moduleQuantity", "array1Tilt", "array1Azimuth", "mainServiceRating"];
console.log("\nfield values a replay would send (these must differ from the recorded recipe's project):");
for (const k of interesting) console.log(`   ${k.padEnd(22)} ${JSON.stringify(fv[k] ?? "")}`);
process.exit(0);
