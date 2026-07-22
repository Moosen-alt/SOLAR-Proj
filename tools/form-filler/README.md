# pdf-form-filler

Batch PDF form filler, split out of the SOLAR-Proj AHJ form-fill engine
(`backend/src/ahjForms.ts`) so it can be used on any repetitive government/admin
paperwork — e.g. **permitting refund requests**: one blank form, one spreadsheet
of requests, one filled PDF per row.

The workflow mirrors the solar tool's trust model: a blank form is **mapped
once** (which field gets which column), the map is saved as a JSON file you can
read and correct, the **first output is human-verified**, and every fill after
that is deterministic — no AI in the loop at fill time.

## What it handles

- **Fillable (AcroForm) PDFs** — text fields, checkboxes, dropdowns, radio
  groups. Values that exceed a field's max length are truncated, dropdown
  options are matched case/punctuation-insensitively, and output is flattened
  (values baked in) unless you pass `--no-flatten`.
- **Flat / scanned PDFs** — filled by drawing text at coordinates (an "overlay
  map"). With `ANTHROPIC_API_KEY` set, a vision model reads the blank and
  proposes placements; otherwise you place coordinates by hand in the map file.
- **Signatures** — the map can carry signature-line placements; pass
  `--signature sig.png` to stamp your signature image (plus today's date on the
  adjacent date line). Without the flag, signature lines are simply left blank.
- **Pure XFA (LiveCycle) forms** cannot be filled programmatically — they show
  up in `inspect` as having no fields; use the overlay path or fill by hand.

## Quick start (inside SOLAR-Proj)

Dependencies are already installed at the repo root. From the repo root:

```sh
npm run form:fill -- inspect path/to/refund-form.pdf
npm run form:fill -- map     path/to/refund-form.pdf --data refunds.csv
npm run form:fill -- fill    path/to/refund-form.pdf \
    --map path/to/refund-form.map.json --data refunds.csv \
    --out filled/ --name "{Permit Number} refund.pdf" --limit 1
# open the one output, verify it, fix the map if needed, set "verified": true,
# then re-run without --limit for the full batch.
```

Or try the offline end-to-end demo first:

```sh
cd tools/form-filler
npx tsx sample/make-sample.ts
npx tsx src/cli.ts map  sample/refund-request-blank.pdf --data sample/refund-requests.csv
npx tsx src/cli.ts fill sample/refund-request-blank.pdf \
    --map sample/refund-request-blank.map.json --data sample/refund-requests.csv \
    --out sample/filled --name "{Permit Number} refund.pdf"
```

## Using it as a separate project

Copy this folder anywhere and run `npm install` in it — `package.json` carries
its own dependencies (`pdf-lib` for filling, `pdfjs-dist` + `@napi-rs/canvas`
for page rendering, `@anthropic-ai/sdk` for auto-mapping, `tsx` to run
TypeScript directly). Then use `npx tsx src/cli.ts ...` or the npm scripts
(`npm run inspect|map|fill|test -- ...`).

## The three commands

### `inspect <blank.pdf>`

Lists the PDF's fillable fields (name, type, dropdown options, max length), or
reports that the PDF is flat/scanned. Use it to see what you're working with
and to get exact field names for hand-editing a map.

### `map <blank.pdf> --data rows.csv [--out map.json] [--form-name "..."]`

Builds the field map against **your columns** (that's why `--data` is
required — mapping targets the CSV/JSON headers). Best available method wins:

| Situation | Method |
|---|---|
| AcroForm + `ANTHROPIC_API_KEY` | LLM maps field names → columns semantically |
| AcroForm, no key | Offline name matching (`applicant_name` ↔ "Applicant Name") |
| Flat PDF + key | Vision model proposes coordinate placements + signature lines |
| Flat PDF, no key | Stub map with instructions for manual coordinates |

The map is written next to the blank as `<blank>.map.json` by default. It is
plain JSON — open it, check it, edit it. Every fresh map is `"verified": false`
and `fill` warns until you flip it.

### `fill <blank.pdf> --map map.json --data rows.csv [options]`

One filled PDF per data row.

| Flag | Meaning |
|---|---|
| `--out <dir>` | Output directory (default `./filled`) |
| `--name "<tmpl>"` | Output filename template: `{Column Name}` pulls from the row (case/punctuation-insensitive), `{n}` is the zero-padded row number. Default `{n}.pdf` |
| `--signature <img>` | PNG/JPG stamped at the map's `signatureFields` |
| `--no-flatten` | Keep AcroForm fields editable in the outputs |
| `--limit N` | Fill only the first N rows (preview before a big batch) |
| `--nudge-x/--nudge-y N` | Shift ALL overlay text by N PDF points (+y = up) — fixes "prints a smidge low/left" without re-mapping |

Blank-column and unknown-field problems are reported loudly: the CLI warns
when the map references columns your data doesn't have, and lists any mapped
field names that don't exist on the form.

## Data format

- **CSV** — first row is headers. Quoted fields, embedded commas/newlines and
  `""` escapes are handled. Surrounding whitespace is trimmed from each cell;
  values are otherwise used as written.
- **JSON** — an array of objects, e.g. `[{"Permit Number": "BP-1", ...}, ...]`.
  Values are stringified, so a JSON **number** like `455.40` becomes `"455.4"`
  (the trailing zero is already gone by the time JSON is parsed). Quote values
  that must keep their exact formatting — currency, IDs, ZIPs — as **strings**
  (`"455.40"`, `"07201"`).

Non-Latin characters (beyond the standard PDF font's Latin-1 range) are replaced
with `?` and the run reports how many — the standard AcroForm/Helvetica fonts
can't render them. Common typographic characters (curly quotes, en/em dashes,
ellipsis) are normalized to their ASCII equivalents automatically.

## Map format (hand-editing)

```jsonc
{
  "formName": "Refund Request",
  "fillMode": "acroform",            // or "overlay" for flat PDFs
  "textFields": {                     // AcroForm field name -> source
    "Permit Number": "row.Permit Number",
    "Date": "computed.today"
  },
  "checkboxes": {                     // checked when source is truthy, or equals `equals`
    "Paid By Applicant": { "source": "row.Paid By Applicant", "equals": "yes" }
  },
  "overlayFields": [                  // fillMode "overlay": draw at coordinates
    { "source": "row.Applicant Name", "page": 0, "x": 150, "y": 640, "size": 9,
      "maxWidth": 200, "label": "Applicant" }
  ],
  "signatureFields": [                // where --signature is stamped
    { "page": 0, "x": 110, "y": 96, "width": 150, "height": 22,
      "dateX": 320, "dateY": 100, "dateSize": 9 }
  ],
  "verified": false                   // set true after checking a filled output
}
```

Sources: `row.<column>` (exact column name first, then case/punctuation-
insensitive), `lit:<text>` (literal — `lit:X` marks a checkbox on an overlay),
`computed.today` (MM/DD/YYYY). Overlay coordinates are **PDF points from the
bottom-left** of the page (US Letter is 612×792).

## Auto-mapping configuration

- `ANTHROPIC_API_KEY` — enables LLM/vision mapping (`map` only; `fill` never
  calls the API).
- `FORM_FILLER_MODEL` — override the mapping model (default `claude-opus-4-8`).

## Tests

```sh
npm run form:test          # from the SOLAR-Proj root
npm test                   # from this folder (standalone)
```
