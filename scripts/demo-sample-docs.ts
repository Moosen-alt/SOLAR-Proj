// ---------------------------------------------------------------------------
// THE PAPER THE PRESENTER HOLDS UP.
//
// The "fill out" section of the demo needs a blank form to upload, and the only blanks
// worth handing a presenter are the ones the kit ALREADY holds: the public forms its
// form library stored when the demo projects were built. They live as bytes in
// ahj_form_templates.pdf_blob, so this copies them out — no download, no network.
//
// Two rules decide what lands in the folder:
//
//   1. ONLY BLANKS. A stored blob is supposed to be the blank, but "supposed to be" is the
//      shape of every leak: one filled copy saved into the template column and the
//      sample folder would hand a homeowner's name to whoever picks up the thumbdrive.
//      So every file is checked — no AcroForm field may carry a value, and the text layer
//      may not contain any homeowner / address / account / company string from the kit's
//      own projects and clients. A file that fails is EXCLUDED and named in the output.
//
//   2. ONLY PINNED OFFICIAL REVISIONS. A row whose bytes do not hash to a revision the code
//      knows (curatedAhjForms / bcd5952Template) is excluded too: nothing proves it is a
//      public blank rather than an operator's upload, and the upload beat could not map it
//      offline anyway — it would reach the (absent) LLM and hand back an unfilled form.
//
// No synthetic AcroForm, utility bill or extra plan set is generated: nothing offline
// recognises them, so they would only be traps for the presenter.
//
//   npx tsx scripts/demo-sample-docs.ts --kit demo-kit --out demo-kit/sample-docs
//   npx tsx scripts/demo-sample-docs.ts --kit demo-kit --verify some.pdf   # blank check only
//
// The kit database is opened READ-ONLY (safe while the kit server is running).
// ---------------------------------------------------------------------------
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, PDFName } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { curatedFormMap } from "../backend/src/curatedAhjForms";
import { bcd5952Template } from "../backend/src/bcd5952Template";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const kitArg = arg("--kit");
const outArg = arg("--out");
const verifyArg = arg("--verify");
if (!kitArg || (!outArg && !verifyArg)) {
  console.error("usage: npx tsx scripts/demo-sample-docs.ts --kit <kit dir> --out <dir>");
  console.error("       npx tsx scripts/demo-sample-docs.ts --kit <kit dir> --verify <pdf>");
  process.exit(2);
}
const KIT = path.resolve(kitArg);
const DB_FILE = path.join(KIT, "backend", "data", "autopilot.sqlite");
if (!fs.existsSync(DB_FILE)) {
  console.error(`No kit database at ${DB_FILE}.`);
  process.exit(2);
}
const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });

// ---- what counts as "project data" -----------------------------------------
// Every identifying string the kit's own projects and clients carry. Values are never
// printed — a hit reports only which kind of row it matched, so running this against the
// wrong database cannot echo a real customer into a terminal log.
interface Needle { text: string; from: string }
function projectDataNeedles(): Needle[] {
  const out: Needle[] = [];
  const add = (v: unknown, from: string): void => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    // A needle must be specific enough not to match ordinary form text: letters and at
    // least four characters, or a ZIP. "000000" (a placeholder licence) would match
    // blank number boxes on a real form and is deliberately not a needle.
    if (/^\d{5}(-\d{4})?$/.test(s) || (s.length >= 4 && /[a-z]/i.test(s))) out.push({ text: s.toLowerCase(), from });
  };
  const cols = (table: string): Set<string> =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  const pick = (table: string, wanted: string[]): string[] => { const have = cols(table); return wanted.filter((c) => have.has(c)); };
  const pCols = pick("projects", ["homeowner_name", "project_address", "zip", "account_number", "meter_number"]);
  if (pCols.length) {
    for (const row of db.prepare(`SELECT ${pCols.join(", ")} FROM projects`).all() as Array<Record<string, unknown>>) {
      for (const c of pCols) add(row[c], `projects.${c}`);
    }
  }
  const cCols = pick("clients", ["company_name", "legal_business_name", "contact_name", "contact_email", "business_address", "business_email"]);
  if (cCols.length) {
    for (const row of db.prepare(`SELECT ${cCols.join(", ")} FROM clients`).all() as Array<Record<string, unknown>>) {
      for (const c of cCols) add(row[c], `clients.${c}`);
    }
  }
  // Markers every demo seed uses, in case a filled copy came from a project since deleted.
  for (const m of ["example.invalid", "demo-mtr-", "demo-000-", "solaris demo co"]) out.push({ text: m, from: "demo marker" });
  return out;
}

interface BlankCheck { blank: boolean; problems: string[]; fieldCount: number; pages: number }

/** A form is blank when no AcroForm field holds a value and its text layer carries no
 *  project/client string from this kit. Both, because a flat form is filled by overlay
 *  text (no fields at all) and an AcroForm is filled through field values. */
async function checkBlank(bytes: Uint8Array, needles: Needle[]): Promise<BlankCheck> {
  const problems: string[] = [];
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  let fields: ReturnType<ReturnType<PDFDocument["getForm"]>["getFields"]> = [];
  try { fields = doc.getForm().getFields(); } catch { /* no AcroForm */ }
  for (const f of fields) {
    const v = f.acroField.dict.get(PDFName.of("V"));
    if (!v) continue;
    const raw = String(v);
    // Empty strings and an unchecked box are the blank state; anything else is a value.
    if (raw === "()" || raw === "<>" || raw === "<FEFF>" || raw === "/Off" || raw === "/") continue;
    problems.push(`field "${f.getName()}" has a value`);
  }
  // verbosity 0: font-hinting warnings from official PDFs are noise, not findings.
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 });
  const pdf = await task.promise;
  let text = "";
  for (let n = 1; n <= pdf.numPages; n++) {
    const tc = await (await pdf.getPage(n)).getTextContent();
    text += " " + (tc.items as Array<{ str?: string }>).map((it) => it.str ?? "").join(" ");
  }
  await task.destroy();
  const spaced = text.replace(/\s+/g, " ").toLowerCase();
  const squashed = spaced.replace(/ /g, "");
  const hitFrom = new Set<string>();
  for (const n of needles) {
    if (spaced.includes(n.text) || squashed.includes(n.text.replace(/ /g, ""))) hitFrom.add(n.from);
  }
  for (const from of hitFrom) problems.push(`text layer contains a value from ${from}`);
  return { blank: problems.length === 0, problems, fieldCount: fields.length, pages: doc.getPageCount() };
}

/** Which pinned official revision these bytes are, if any — the same recognisers the
 *  upload path runs, so "recognised" here means "the upload beat maps it without an LLM". */
function recognise(bytes: Uint8Array): { formName: string; fileName: string; via: string; ahjScope: string } | null {
  if (bcd5952Template(bytes, "")) {
    return { formName: "Oregon BCD 5952 Prescriptive Solar PV Installation Checklist", fileName: "Oregon-BCD-5952-blank.pdf",
      via: "bcd5952Template", ahjScope: "any Oregon AHJ" };
  }
  const curated = curatedFormMap(bytes, "");
  if (curated) {
    const name = curated.source.formName;
    const scope = curated.source.ahj === "coos bay" ? "City of Coos Bay" : `City of ${curated.source.ahj.replace(/\b\w/g, (c) => c.toUpperCase())}`;
    return { formName: name, fileName: `${name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}-blank.pdf`,
      via: "curatedAhjForms", ahjScope: `${scope} only` };
  }
  return null;
}

const needles = projectDataNeedles();

if (verifyArg) {
  const bytes = new Uint8Array(fs.readFileSync(path.resolve(verifyArg)));
  const res = await checkBlank(bytes, needles);
  const rec = recognise(bytes);
  console.log(`${path.basename(verifyArg)}: ${res.blank ? "BLANK" : "NOT BLANK"} (${res.pages} page(s), ${res.fieldCount} field(s); ${rec ? `official revision via ${rec.via}` : "not a pinned official revision"})`);
  for (const p of res.problems.slice(0, 10)) console.log(`   - ${p}`);
  if (res.problems.length > 10) console.log(`   - …and ${res.problems.length - 10} more`);
  db.close();
  process.exit(res.blank ? 0 : 1);
}

// ---- generate ---------------------------------------------------------------
const OUT = path.resolve(outArg!);
fs.mkdirSync(OUT, { recursive: true });

interface Row { id: string; ahj_name: string; form_type: string; original_filename: string; pdf_blob: Buffer | null }
const rows = db.prepare(
  "SELECT id, ahj_name, form_type, original_filename, pdf_blob FROM ahj_form_templates ORDER BY ahj_name, form_type",
).all() as Row[];

interface Written { fileName: string; formName: string; via: string; ahjScope: string; bytes: number; heldFor: string[] }
const written = new Map<string, Written>(); // by sha256 — the same blank stored for three AHJs is one file
const excluded: string[] = [];

for (const r of rows) {
  const label = `${r.ahj_name} / ${r.form_type} (${r.id.slice(0, 8)})`;
  if (!r.pdf_blob || r.pdf_blob.length === 0) { excluded.push(`${label}: no stored PDF bytes`); continue; }
  const bytes = new Uint8Array(r.pdf_blob);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const seen = written.get(hash);
  if (seen) { seen.heldFor.push(r.ahj_name); continue; }
  const rec = recognise(bytes);
  if (!rec) { excluded.push(`${label}: not a pinned official revision — cannot prove it is a public blank, and the upload beat could not map it offline`); continue; }
  const check = await checkBlank(bytes, needles);
  if (!check.blank) { excluded.push(`${label}: stored copy is NOT blank (${check.problems.slice(0, 3).join("; ")})`); continue; }
  fs.writeFileSync(path.join(OUT, rec.fileName), bytes);
  written.set(hash, { ...rec, bytes: bytes.length, heldFor: [r.ahj_name] });
}
db.close();

const files = [...written.values()].sort((a, b) => (a.via === "bcd5952Template" ? -1 : b.via === "bcd5952Template" ? 1 : a.fileName.localeCompare(b.fileName)));
const bcd = files.find((f) => f.via === "bcd5952Template");

// ---- README -----------------------------------------------------------------
const beatProject = arg("--beat-project") || "the column-2 upload-beat project";
// The count the page prints is the upload route's mappedFields for this revision — read
// from the same template, not written down here to drift.
const bcdFieldCount = bcd
  ? Object.keys(bcd5952Template(new Uint8Array(fs.readFileSync(path.join(OUT, bcd.fileName))), "")?.textFields ?? {}).length
  : 0;
const lines: string[] = [
  "SAMPLE DOCUMENTS - public BLANK forms copied out of this kit's own form library. No project data in any of them; nothing here needs the internet.",
  "",
];
for (const f of files) {
  if (f.via === "bcd5952Template") {
    lines.push(`${f.fileName} - the State of Oregon's Prescriptive Solar PV Installation Checklist (BCD 5952). THE ONE TO UPLOAD: 'Fill a form' page -> pick ${beatProject} -> 'Upload a blank form' -> choose this file -> 'Upload & fill' -> 'Form mapped (${bcdFieldCount} fields) — filling…' -> 'Done — form filled from the project.' -> Download PDF = the checklist filled from that project. Recognised by its exact bytes, so it works for any Oregon AHJ with no AI call.`);
  } else {
    lines.push(`${f.fileName} - the official blank behind the filled ${f.formName} on the ${f.heldFor.join(" / ")} demo project. Show-and-tell only: hold it next to the filled copy on that project. Do not upload it under another AHJ - the server declines another jurisdiction's form.`);
  }
}
lines.push("");
// Measured, not assumed: every upload the kit cannot map offline ends with NO download. What
// the page says about it depends on the kit's build — older fill-form.html printed "Form
// mapped (0 fields)" then "Done"; the fixed one warns "not mapped". Either way it is a dead
// end, so the README states the outcome, not a status line that differs between builds.
lines.push("DO NOT upload anything else on the 'Fill a form' page (a plan set, a utility bill, a form from the web, or a Coos/Tigard blank under another AHJ). Offline nothing can map it: there is NO filled download - a dead end on stage (an older kit build even says 'Done'). An unrecognised form is also kept on file for that AHJ until deleted under 'AHJ Forms (official permit PDFs)' on the dashboard.");
fs.writeFileSync(path.join(OUT, "README.txt"), lines.join("\r\n") + "\r\n");

console.log(`[sample-docs] ${files.length} blank form(s) written to ${OUT}`);
for (const f of files) console.log(`  + ${f.fileName.padEnd(62)} ${String(f.bytes).padStart(7)} bytes  ${f.via}  (${f.ahjScope}; stored for ${f.heldFor.length} AHJ row(s))`);
if (excluded.length) {
  console.log(`[sample-docs] ${excluded.length} stored template(s) excluded:`);
  for (const e of excluded) console.log(`  - ${e}`);
} else {
  console.log("[sample-docs] 0 stored templates excluded.");
}
if (!bcd) {
  console.error("[sample-docs] WARNING: no Oregon BCD 5952 blank in this kit — the upload beat has nothing to upload.");
  process.exitCode = 1;
}
