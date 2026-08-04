// Map a blank PDF once so every future fill is deterministic and free.
//
// Three tiers, best available wins:
//   1. LLM AcroForm mapping  — field names -> row.<column> (needs ANTHROPIC_API_KEY)
//   2. LLM vision overlay    — flat/scanned PDFs: where each value goes (needs key)
//   3. Heuristic AcroForm    — offline: normalized field-name <-> column matching
// Without a key a flat PDF yields a stub map with instructions for manual
// coordinate placement. A fresh map is ALWAYS unverified — preview the first
// filled output before trusting a batch (same trust model as the solar tool).
import { inspectPdf, type InspectedField } from "./inspect";
import { normalizeName } from "./engine";
import { renderPdfPagesToPng } from "./render";
import type { CheckboxRule, DataRow, FormMap, OverlayField, SignaturePlacement } from "./types";

const MODEL = process.env.FORM_FILLER_MODEL || "claude-opus-5";

export interface BuildMapInput {
  bytes: Uint8Array;
  formName: string;
  headers: string[];
  /** First data row — sample values help the mapper understand column semantics. */
  sampleRow?: DataRow;
}

export interface BuildMapResult {
  map: FormMap;
  method: "llm-acroform" | "heuristic-acroform" | "llm-overlay" | "stub";
  warnings: string[];
}

function hasLlmCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function availableSources(headers: string[], sampleRow?: DataRow): string[] {
  const sources = headers.map((h) => {
    const sample = sampleRow?.[h];
    return `row.${h}${sample ? `  (sample value: ${JSON.stringify(String(sample).slice(0, 60))})` : ""}`;
  });
  sources.push('lit:<text>  (literal constant — e.g. "lit:X" for a checkbox mark, "lit:Refund request")');
  sources.push("computed.today  (today's date, MM/DD/YYYY)");
  return sources;
}

// ---------------------------------------------------------------------------
// Tier 3: offline heuristic — normalized name matching between AcroForm field
// names and data columns. Good enough when the form's internal field names
// resemble their printed labels ("Applicant Name" <-> "applicant_name").
// ---------------------------------------------------------------------------
export function heuristicAcroMap(
  fields: InspectedField[],
  headers: string[],
): { textFields: Record<string, string>; checkboxes: Record<string, CheckboxRule>; matched: number } {
  const byNorm = new Map<string, string>();
  for (const h of headers) {
    const n = normalizeName(h);
    if (n && !byNorm.has(n)) byNorm.set(n, h);
  }
  const findHeader = (fieldName: string): string | null => {
    const n = normalizeName(fieldName);
    if (n.length < 3) return null;
    const exact = byNorm.get(n);
    if (exact) return exact;
    // Containment either way; prefer the longest normalized header (most specific).
    let best: string | null = null;
    let bestLen = 0;
    for (const [hn, h] of byNorm) {
      if (hn.length < 3) continue;
      if ((n.includes(hn) || hn.includes(n)) && hn.length > bestLen) { best = h; bestLen = hn.length; }
    }
    return best;
  };

  const textFields: Record<string, string> = {};
  const checkboxes: Record<string, CheckboxRule> = {};
  let matched = 0;
  for (const f of fields) {
    if (f.type === "other") continue;
    if (/\b(signature|sign here|date signed)\b/i.test(f.name)) continue; // humans sign
    const header = findHeader(f.name);
    if (!header) continue;
    if (f.type === "checkbox") checkboxes[f.name] = { source: `row.${header}` };
    else textFields[f.name] = `row.${header}`;
    matched += 1;
  }
  return { textFields, checkboxes, matched };
}

// ---------------------------------------------------------------------------
// Tier 1: LLM AcroForm mapping.
// ---------------------------------------------------------------------------
function parseJsonLoose<T>(raw: string, fallback: T): T {
  const text = raw.replace(/```(?:json)?/g, "").trim();
  try { return JSON.parse(text) as T; } catch { /* fall through */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]) as T; } catch { /* fall through */ }
  }
  return fallback;
}

const SOURCE_RE = /^row\.|^lit:|^computed\./;

async function llmAcroMap(
  input: BuildMapInput,
  fields: InspectedField[],
): Promise<{ textFields: Record<string, string>; checkboxes: Record<string, CheckboxRule>; notes: string }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const system = `You map a blank PDF form's fillable fields onto tabular data columns, so the form can be batch-filled (one output PDF per data row).

You are given the form's field NAMES (with types, and options for dropdowns/radio groups) and the AVAILABLE DATA SOURCES. For each form field you can confidently fill, choose the single best matching source. Leave a field out entirely if no source clearly matches (do not guess).

Source syntax (use these EXACT strings):
- "row.<column>" — the value of that data column
- "lit:<text>" — a literal constant (e.g. "lit:X" for a fixed mark)
- "computed.today" — today's date

Return ONLY JSON:
{
  "textFields": { "<exact form field name>": "<source string>", ... },
  "checkboxes": { "<exact checkbox field name>": { "source": "<source string>", "equals": "<optional value to compare>" }, ... },
  "notes": "<short note on anything ambiguous or left blank>"
}
Rules:
- Use the EXACT field names provided (case/spacing matters).
- Checkbox-type fields go in "checkboxes"; text/dropdown/radio fields go in "textFields".
- For dropdown/radio fields, the source's resolved value should match one of the listed options.
- A checkbox rule with "equals" is checked when the column's value equals that string; without "equals" it is checked when the value is truthy (not empty/0/false/no).
- NEVER map signature, date-signed, or payment-card fields — leave them for the human.
- Return valid JSON only.`;
  const userMsg = `Form: ${input.formName}

FORM FIELDS (name | type | options):
${fields.slice(0, 200).map((f) => `${f.name} | ${f.type}${f.options?.length ? ` | ${f.options.join(", ")}` : ""}`).join("\n")}

AVAILABLE DATA SOURCES:
${availableSources(input.headers, input.sampleRow).join("\n")}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content: userMsg }],
  });
  const raw = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
  const parsed = parseJsonLoose<{ textFields?: Record<string, unknown>; checkboxes?: Record<string, unknown>; notes?: string }>(raw, {});

  const known = new Set(fields.map((f) => f.name));
  const textFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.textFields ?? {})) {
    const src = String(v);
    if (known.has(k) && SOURCE_RE.test(src)) textFields[k] = src;
  }
  const checkboxes: Record<string, CheckboxRule> = {};
  for (const [k, v] of Object.entries(parsed.checkboxes ?? {})) {
    const rule = v as { source?: unknown; equals?: unknown };
    const src = String(rule?.source ?? "");
    if (known.has(k) && SOURCE_RE.test(src)) {
      checkboxes[k] = rule?.equals != null ? { source: src, equals: String(rule.equals) } : { source: src };
    }
  }
  return { textFields, checkboxes, notes: String(parsed.notes ?? "") };
}

// ---------------------------------------------------------------------------
// Tier 2: LLM vision overlay for flat/scanned PDFs. Renders pages, asks where
// each value goes in normalized coordinates, converts to PDF points.
// ---------------------------------------------------------------------------
async function llmOverlayMap(
  input: BuildMapInput,
  pageSizes: { width: number; height: number }[],
): Promise<{ overlayFields: OverlayField[]; signatureFields: SignaturePlacement[]; notes: string }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const maxPages = Math.min(pageSizes.length, 3);
  const pages = await renderPdfPagesToPng(input.bytes, maxPages, 1.6);

  const system = `You are reading a BLANK form (image per page) to determine WHERE each data value should be written, so a flat (non-fillable) PDF can be auto-filled by drawing text at coordinates.

For each blank/line/box that one of the AVAILABLE DATA SOURCES should fill, return a placement:
- "source": the EXACT source string (from AVAILABLE DATA SOURCES; "lit:X" for a checkbox mark)
- "page": 0-based page index
- "nx": normalized horizontal position (0=left, 1=right) where the text should START (just right of the label / start of the blank)
- "ny": normalized vertical position (0=top, 1=bottom) of the text BASELINE
- "size": font size in points (8-10 typical)
- "maxWidthFrac": optional, available width as a fraction of page width
- "label": the form's printed label for this blank (for human review)

ALSO locate every SIGNATURE line and return it under "signatures":
- "page": 0-based page index
- "nx","ny": normalized position of the BOTTOM-LEFT corner of the signature area (just above the line, at its left)
- "widthFrac","heightFrac": area size as fractions of page width/height (typical: ~0.25 wide, ~0.04 tall)
- "dateNx","dateNy": if a "date" line sits next to the signature, the normalized baseline to write the date; omit if none
- "label": the printed signature label

Return ONLY JSON: {"fields":[ ... ], "signatures":[ ... ], "notes":"<caveats>"}
Rules:
- Place a value ONLY where you can clearly see the matching labeled blank. Do not guess positions.
- Signature and date-signed lines go in "signatures", never in "fields".
- For checkboxes, use source "lit:X" placed inside the box.
- Coordinates must be precise — they are used verbatim. Return valid JSON only.`;

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: `Form: ${input.formName}\n\nAVAILABLE DATA SOURCES:\n${availableSources(input.headers, input.sampleRow).join("\n")}\n\nPages follow:` },
  ];
  pages.forEach((pg, i) => {
    content.push({ type: "text", text: `PAGE ${i}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: pg.png.toString("base64") } });
  });
  content.push({ type: "text", text: "Return the placements JSON now." });

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system,
    messages: [{ role: "user", content: content as never }],
  });
  const raw = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
  const parsed = parseJsonLoose<{ fields?: unknown[]; signatures?: unknown[]; notes?: string }>(raw, {});

  const overlayFields: OverlayField[] = [];
  for (const f of parsed.fields ?? []) {
    const o = f as Record<string, unknown>;
    const source = String(o.source ?? "");
    const nx = Number(o.nx);
    const ny = Number(o.ny);
    const pageIdx = Number.isFinite(Number(o.page)) ? Math.max(0, Math.floor(Number(o.page))) : 0;
    const sz = pageSizes[pageIdx] ?? pageSizes[0];
    if (!SOURCE_RE.test(source)) continue;
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
    overlayFields.push({
      source,
      page: pageIdx,
      x: Math.round(nx * sz.width),
      y: Math.round((1 - ny) * sz.height), // flip: ny is from top, PDF y from bottom
      size: Number.isFinite(Number(o.size)) && Number(o.size) > 0 ? Number(o.size) : 9,
      ...(Number.isFinite(Number(o.maxWidthFrac)) && Number(o.maxWidthFrac) > 0
        ? { maxWidth: Math.round(Number(o.maxWidthFrac) * sz.width) }
        : {}),
      ...(o.label != null ? { label: String(o.label) } : {}),
    });
  }
  const signatureFields: SignaturePlacement[] = [];
  for (const s of parsed.signatures ?? []) {
    const o = s as Record<string, unknown>;
    const nx = Number(o.nx);
    const ny = Number(o.ny);
    const widthFrac = Number(o.widthFrac);
    const heightFrac = Number(o.heightFrac);
    const pageIdx = Number.isFinite(Number(o.page)) ? Math.max(0, Math.floor(Number(o.page))) : 0;
    const sz = pageSizes[pageIdx] ?? pageSizes[0];
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
    if (!Number.isFinite(widthFrac) || !Number.isFinite(heightFrac) || widthFrac <= 0 || heightFrac <= 0) continue;
    const h = Math.round(heightFrac * sz.height);
    const hasDate = o.dateNx != null && o.dateNy != null && Number.isFinite(Number(o.dateNx)) && Number.isFinite(Number(o.dateNy));
    signatureFields.push({
      page: pageIdx,
      x: Math.round(nx * sz.width),
      // ny marks the bottom-left corner measured from the top; flip and drop by
      // the box height so the image sits just above the printed line.
      y: Math.round((1 - ny) * sz.height - h),
      width: Math.round(widthFrac * sz.width),
      height: h,
      ...(o.label != null ? { label: String(o.label) } : {}),
      ...(hasDate
        ? { dateX: Math.round(Number(o.dateNx) * sz.width), dateY: Math.round((1 - Number(o.dateNy)) * sz.height), dateSize: 9 }
        : {}),
    });
  }
  return { overlayFields, signatureFields, notes: String(parsed.notes ?? "") };
}

// ---------------------------------------------------------------------------
// Orchestrator.
// ---------------------------------------------------------------------------
export async function buildMap(input: BuildMapInput): Promise<BuildMapResult> {
  const inspection = await inspectPdf(input.bytes);
  const warnings: string[] = [];

  if (inspection.hasAcroFields) {
    if (hasLlmCredentials()) {
      try {
        const mapped = await llmAcroMap(input, inspection.fields);
        const count = Object.keys(mapped.textFields).length + Object.keys(mapped.checkboxes).length;
        if (count > 0) {
          return {
            method: "llm-acroform",
            warnings,
            map: {
              formName: input.formName,
              fillMode: "acroform",
              textFields: mapped.textFields,
              checkboxes: mapped.checkboxes,
              notes: [
                `Auto-mapped ${count} of ${inspection.fields.length} field(s) by ${MODEL}.`,
                ...(mapped.notes ? [mapped.notes] : []),
                "UNVERIFIED — preview the first filled PDF, fix any wrong sources in this file, then set verified:true.",
              ],
              verified: false,
            },
          };
        }
        warnings.push("LLM mapping returned no fields; falling back to heuristic name matching.");
      } catch (err) {
        warnings.push(`LLM mapping failed (${err instanceof Error ? err.message : String(err)}); falling back to heuristic name matching.`);
      }
    }
    const heur = heuristicAcroMap(inspection.fields, input.headers);
    const unmappedNames = inspection.fields
      .filter((f) => f.type !== "other" && !(f.name in heur.textFields) && !(f.name in heur.checkboxes))
      .map((f) => `${f.name} (${f.type})`);
    return {
      method: "heuristic-acroform",
      warnings,
      map: {
        formName: input.formName,
        fillMode: "acroform",
        textFields: heur.textFields,
        checkboxes: heur.checkboxes,
        notes: [
          `Heuristically matched ${heur.matched} of ${inspection.fields.length} field(s) by name (${warnings.length ? "LLM mapping unavailable" : "no ANTHROPIC_API_KEY"}).`,
          ...(unmappedNames.length
            ? [`Unmatched fields — map by hand (add "<field name>": "row.<column>" entries): ${unmappedNames.join("; ")}`]
            : []),
          "UNVERIFIED — preview the first filled PDF, fix any wrong sources in this file, then set verified:true.",
        ],
        verified: false,
      },
    };
  }

  // Flat/scanned (or XFA) — needs an overlay map.
  if (hasLlmCredentials()) {
    try {
      const overlay = await llmOverlayMap(input, inspection.pageSizes);
      if (overlay.overlayFields.length || overlay.signatureFields.length) {
        return {
          method: "llm-overlay",
          warnings,
          map: {
            formName: input.formName,
            fillMode: "overlay",
            textFields: {},
            overlayFields: overlay.overlayFields,
            signatureFields: overlay.signatureFields,
            notes: [
              `Vision-mapped flat PDF: ${overlay.overlayFields.length} placement(s), ${overlay.signatureFields.length} signature line(s).`,
              ...(overlay.notes ? [overlay.notes] : []),
              "Coordinate placement is approximate — VERIFY the first filled PDF and nudge x/y values (or use --nudge-x/--nudge-y) before a real batch.",
            ],
            verified: false,
          },
        };
      }
      warnings.push("Vision mapping found no placeable fields.");
    } catch (err) {
      warnings.push(`Vision mapping failed (${err instanceof Error ? err.message : String(err)}).`);
    }
  } else {
    warnings.push("This PDF has no fillable fields and no ANTHROPIC_API_KEY is set — vision mapping unavailable.");
  }
  return {
    method: "stub",
    warnings,
    map: {
      formName: input.formName,
      fillMode: "overlay",
      textFields: {},
      overlayFields: [],
      notes: [
        "STUB MAP for a flat (non-fillable) PDF. Add overlayFields entries by hand:",
        '{ "source": "row.<column>", "page": 0, "x": <points from left>, "y": <points from BOTTOM>, "size": 9 }',
        `Page size(s): ${inspection.pageSizes.map((p) => `${Math.round(p.width)}x${Math.round(p.height)}`).join(", ")} points. US Letter is 612x792.`,
        "Or set ANTHROPIC_API_KEY and re-run `map` for automatic vision placement.",
      ],
      verified: false,
    },
  };
}
