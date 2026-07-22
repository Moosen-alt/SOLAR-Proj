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

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const valueFlags = new Set(["--data", "--out", "--form-name", "--map", "--name", "--signature", "--limit", "--nudge-x", "--nudge-y"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (valueFlags.has(a)) {
        const v = argv[i + 1];
        if (v == null || v.startsWith("--")) fail(`${a} requires a value`);
        flags.set(a, v);
        i++;
      } else {
        flags.set(a, true);
      }
    } else {
      positional.push(a);
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
  if (bytes[0] !== 0x25) fail(`${filePath} does not look like a PDF (missing %PDF header)`);
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
    if (!map.signatureFields?.length) {
      console.warn("warning: --signature given but the map has no signatureFields — nothing will be stamped.");
    }
  }
  const nudgeX = Number(args.flags.get("--nudge-x") ?? 0);
  const nudgeY = Number(args.flags.get("--nudge-y") ?? 0);
  if (nudgeX) opts.nudgeX = nudgeX;
  if (nudgeY) opts.nudgeY = nudgeY;

  const limitRaw = args.flags.get("--limit");
  const limit = typeof limitRaw === "string" ? Math.max(1, Math.floor(Number(limitRaw)) || 1) : rows.length;
  const targets = rows.slice(0, limit);

  const usedNames = new Set<string>();
  const allUnmapped = new Set<string>();
  let ok = 0;
  for (let i = 0; i < targets.length; i++) {
    let name = renderName(nameTemplate, targets[i], i);
    if (usedNames.has(name)) name = name.replace(/\.pdf$/i, `-${i + 1}.pdf`);
    usedNames.add(name);
    const outPath = path.join(outDir, name);
    try {
      const result = await fillPdf(bytes, map, targets[i], opts);
      fs.writeFileSync(outPath, result.bytes);
      result.unmapped.forEach((u) => allUnmapped.add(u));
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
  console.log(`${ok}/${targets.length} filled -> ${outDir}${limit < rows.length ? ` (limited to first ${limit} of ${rows.length} rows)` : ""}`);
  if (ok < targets.length) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!command || command === "help" || args.flags.has("--help")) {
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
