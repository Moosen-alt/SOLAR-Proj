// Standalone batch PDF form filler — inspect / map / fill.
//
//   npx tsx src/cli.ts inspect <blank.pdf>
//   npx tsx src/cli.ts map     <blank.pdf> --data rows.csv [--out map.json] [--form-name "..."]
//   npx tsx src/cli.ts fill    <blank.pdf> --map map.json --data rows.csv
//                              [--out filled/] [--name "{Permit Number} refund.pdf"]
//                              [--signature sig.png] [--no-flatten] [--limit N]
//                              [--nudge-x N] [--nudge-y N]
//
// From the SOLAR-Proj repo root: npm run form:fill -- <command> ...
import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { loadRows, renderName } from "./data";
import { fillPdf, unknownRowSources } from "./engine";
import { inspectPdf } from "./inspect";
import type { FillOptions, FormMap } from "./types";

const USAGE = `pdf-form-filler — map a blank PDF once, then batch-fill it from CSV/JSON rows.

Commands:
  inspect <blank.pdf>
      List the PDF's fillable fields (or report that it's flat/scanned).

  map <blank.pdf> --data <rows.csv|rows.json> [--out <map.json>] [--form-name "<name>"]
      Build a field map for the blank. Uses the Anthropic API when
      ANTHROPIC_API_KEY is set (semantic matching + vision placement for flat
      PDFs); otherwise falls back to offline field-name matching.

  fill <blank.pdf> --map <map.json> --data <rows.csv|rows.json>
       [--out <dir>]            output directory (default: ./filled)
       [--name "<template>"]    output name, e.g. "{Permit Number} refund.pdf";
                                {Column} pulls from the row, {n} = row number.
                                Default: "{n}.pdf"
       [--signature <img>]      PNG/JPG stamped at the map's signatureFields
       [--no-flatten]           keep AcroForm fields editable in the output
       [--limit N]              only fill the first N rows (preview)
       [--nudge-x N] [--nudge-y N]  shift ALL overlay text by N PDF points

Data: CSV (first row = column headers) or a JSON array of objects.
Sources in the map: "row.<column>", "lit:<text>", "computed.today".`;

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["--data", "--out", "--form-name", "--map", "--name", "--signature", "--limit", "--nudge-x", "--nudge-y"]);
const BOOL_FLAGS = new Set(["--no-flatten", "--help"]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    // Support --flag=value as well as --flag value.
    let inlineVal: string | undefined;
    const eq = a.indexOf("=");
    if (eq >= 0) { inlineVal = a.slice(eq + 1); a = a.slice(0, eq); }
    if (VALUE_FLAGS.has(a)) {
      const v = inlineVal !== undefined ? inlineVal : argv[++i];
      if (v == null) fail(`${a} requires a value`);
      flags.set(a, v);
    } else if (BOOL_FLAGS.has(a)) {
      if (inlineVal !== undefined) fail(`${a} does not take a value`);
      flags.set(a, true);
    } else {
      // Reject unknown/typo'd flags instead of silently ignoring them.
      fail(`unknown flag: ${a}`);
    }
  }
  return { positional, flags };
}

function fail(message: string): never {
  console.error(`error: ${message}\n`);
  console.error(USAGE);
  process.exit(1);
}

function readPdf(filePath: string): Uint8Array {
  if (!fs.existsSync(filePath)) fail(`no such file: ${filePath}`);
  const bytes = new Uint8Array(fs.readFileSync(filePath));
  // The %PDF header may sit a few bytes in (the spec allows leading bytes within
  // the first 1KB), so scan rather than requiring it at offset 0.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (!head.includes("%PDF-")) fail(`${filePath} does not look like a PDF (no %PDF header in first 1KB)`);
  return bytes;
}

async function cmdInspect(args: Args): Promise<void> {
  const [pdfPath] = args.positional;
  if (!pdfPath) fail("inspect: missing <blank.pdf>");
  const info = await inspectPdf(readPdf(pdfPath));
  console.log(`${pdfPath}: ${info.pageCount} page(s), ${info.pageSizes.map((p) => `${Math.round(p.width)}x${Math.round(p.height)}`).join(", ")} points`);
  if (!info.hasAcroFields) {
    console.log("No fillable (AcroForm) fields — this is a flat/scanned (or XFA) PDF.");
    console.log("Use `map` to build a coordinate overlay map (vision-assisted with ANTHROPIC_API_KEY, or by hand).");
    return;
  }
  console.log(`${info.fields.length} fillable field(s):`);
  for (const f of info.fields) {
    const extra = [
      f.options?.length ? `options: ${f.options.join(" | ")}` : "",
      f.maxLength != null ? `maxLength: ${f.maxLength}` : "",
    ].filter(Boolean).join(", ");
    console.log(`  [${f.type.padEnd(10)}] ${f.name}${extra ? `  (${extra})` : ""}`);
  }
}

async function cmdMap(args: Args): Promise<void> {
  const [pdfPath] = args.positional;
  if (!pdfPath) fail("map: missing <blank.pdf>");
  const dataPath = args.flags.get("--data");
  if (typeof dataPath !== "string") fail("map: --data <rows.csv|rows.json> is required (mapping targets your columns)");
  const bytes = readPdf(pdfPath);
  const { headers, rows } = loadRows(dataPath);
  const formName = typeof args.flags.get("--form-name") === "string"
    ? String(args.flags.get("--form-name"))
    : path.basename(pdfPath, path.extname(pdfPath));

  const { buildMap } = await import("./autoMap");
  const result = await buildMap({ bytes, formName, headers, sampleRow: rows[0] });

  const outPath = typeof args.flags.get("--out") === "string"
    ? String(args.flags.get("--out"))
    : path.join(path.dirname(pdfPath), `${path.basename(pdfPath, path.extname(pdfPath))}.map.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(result.map, null, 2)}\n`);

  for (const w of result.warnings) console.warn(`warning: ${w}`);
  const fieldCount = Object.keys(result.map.textFields).length
    + Object.keys(result.map.checkboxes ?? {}).length
    + (result.map.overlayFields?.length ?? 0);
  console.log(`Wrote ${outPath} (${result.method}, ${fieldCount} mapped field(s), ${result.map.signatureFields?.length ?? 0} signature line(s)).`);
  console.log("Next: fill ONE row (--limit 1), open the output, fix/verify the map, then run the full batch.");
}

async function cmdFill(args: Args): Promise<void> {
  const [pdfPath] = args.positional;
  if (!pdfPath) fail("fill: missing <blank.pdf>");
  const mapPath = args.flags.get("--map");
  const dataPath = args.flags.get("--data");
  if (typeof mapPath !== "string") fail("fill: --map <map.json> is required");
  if (typeof dataPath !== "string") fail("fill: --data <rows.csv|rows.json> is required");

  const bytes = readPdf(pdfPath);
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8")) as FormMap;
  if (!map || (map.fillMode !== "acroform" && map.fillMode !== "overlay")) {
    fail(`${mapPath}: not a form map (expected fillMode "acroform" or "overlay")`);
  }
  const { headers, rows } = loadRows(dataPath);

  const unknown = unknownRowSources(map, headers);
  if (unknown.length) {
    console.warn(`warning: map references columns not present in ${dataPath}: ${unknown.join(", ")} — those fields will be blank.`);
  }
  if (map.verified !== true) {
    console.warn("warning: this map is UNVERIFIED — check the first output carefully before trusting the batch.");
  }

  const outDir = typeof args.flags.get("--out") === "string" ? String(args.flags.get("--out")) : "filled";
  fs.mkdirSync(outDir, { recursive: true });
  const nameTemplate = typeof args.flags.get("--name") === "string" ? String(args.flags.get("--name")) : "{n}.pdf";

  const opts: FillOptions = { flatten: !args.flags.has("--no-flatten") };
  const sigPath = args.flags.get("--signature");
  if (typeof sigPath === "string") {
    if (!fs.existsSync(sigPath)) fail(`no such signature image: ${sigPath}`);
    const mime = /\.jpe?g$/i.test(sigPath) ? "image/jpeg" : "image/png";
    opts.signature = { bytes: new Uint8Array(fs.readFileSync(sigPath)), mime };
    // Fail fast: a corrupt/unsupported image would otherwise be silently
    // swallowed per-row, sending the whole batch out unsigned.
    try {
      const probe = await PDFDocument.create();
      if (mime === "image/jpeg") await probe.embedJpg(opts.signature.bytes);
      else await probe.embedPng(opts.signature.bytes);
    } catch {
      fail(`signature image ${sigPath} could not be read as ${mime === "image/jpeg" ? "JPEG" : "PNG"} — check the file (only PNG/JPEG are supported).`);
    }
    if (!map.signatureFields?.length) {
      console.warn("warning: --signature given but the map has no signatureFields — nothing will be stamped.");
    }
  }
  for (const flag of ["--nudge-x", "--nudge-y"] as const) {
    const raw = args.flags.get(flag);
    if (typeof raw !== "string") continue;
    if (!Number.isFinite(Number(raw))) fail(`${flag} must be a number (got "${raw}")`);
    if (flag === "--nudge-x") opts.nudgeX = Number(raw);
    else opts.nudgeY = Number(raw);
  }

  const limitRaw = args.flags.get("--limit");
  let limit = rows.length;
  if (typeof limitRaw === "string") {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1) fail(`--limit must be a positive integer (got "${limitRaw}")`);
    limit = n;
  }
  const targets = rows.slice(0, limit);

  const usedNames = new Set<string>();
  const allUnmapped = new Set<string>();
  let ok = 0;
  let sanitized = 0;
  for (let i = 0; i < targets.length; i++) {
    let name = renderName(nameTemplate, targets[i], i);
    // Guarantee a unique output name — re-check the deduped candidate too, so a
    // rename never lands on another row's file and silently overwrite it.
    if (usedNames.has(name)) {
      const base = name.replace(/\.pdf$/i, "");
      let suffix = 2;
      while (usedNames.has(`${base}-${suffix}.pdf`)) suffix++;
      name = `${base}-${suffix}.pdf`;
    }
    usedNames.add(name);
    const outPath = path.join(outDir, name);
    try {
      const result = await fillPdf(bytes, map, targets[i], opts);
      fs.writeFileSync(outPath, result.bytes);
      result.unmapped.forEach((u) => allUnmapped.add(u));
      sanitized += result.sanitizedCount;
      const sig = result.signaturesDrawn ? `, ${result.signaturesDrawn} signature(s)` : "";
      console.log(`ok   ${outPath} (${result.filledCount} field(s)${sig})`);
      ok += 1;
    } catch (err) {
      console.error(`FAIL row ${i + 1} -> ${outPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (allUnmapped.size) {
    console.warn(`warning: mapped field(s) not found/settable on the form: ${[...allUnmapped].sort().join(", ")}`);
  }
  if (sanitized) {
    console.warn(`warning: ${sanitized} character(s) fell outside the PDF font's Latin-1 range and were replaced with "?" — check values with non-Latin characters.`);
  }
  console.log(`${ok}/${targets.length} filled -> ${outDir}${limit < rows.length ? ` (limited to first ${limit} of ${rows.length} rows)` : ""}`);
  if (ok < targets.length) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(rest);
  if (args.flags.has("--help")) {
    console.log(USAGE);
    return;
  }
  if (command === "inspect") return cmdInspect(args);
  if (command === "map") return cmdMap(args);
  if (command === "fill") return cmdFill(args);
  fail(`unknown command: ${command}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
