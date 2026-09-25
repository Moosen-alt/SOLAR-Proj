// A GENERATED LAYOUT CORPUS FOR THE GROUND SNOW READING — so the next layout cannot flip-flop it.
//
// Three rounds of regex fixes to the unseparated load-list reader (designCriteria.ts extractSnow /
// loadValueOwners) each closed one layout and opened its mirror image, and each time the state-minimum
// rule turned the misread number into a BLOCKER on a correct plan. Hand-picked fixtures cannot catch
// the mirror image, so this test ENUMERATES layouts (no randomness), in FAMILIES:
//   · grid     — every short load list built from the label vocabulary below, x {label-first,
//                value-first} x {separator ":" "=" " - " none} x {one line, one item per line, comma
//                list, under a "DESIGN LOADS" heading, under a "SNOW LOADS:" heading}. The ground label
//                includes the parenthetical "SNOW LOAD (GROUND)" and the spaced dash is a separator
//                (round 5: both were unambiguous misreads the round-4 corpus could not see).
//   · table    — the same lists FLATTENED as a table: a header row then a value row, or column-major
//                (values then labels). The alternation cannot map a table: never a blocker.
//   · formula  — a list followed by the snow calculation's formula line ("Pg = 0.7 (1.0)(1.1)(1.0)(36
//                PSF) = 27.7 PSF", "pf = 0.7 x Ce x Ct x Is x pg = 0.7 x …"): a coefficient is not a Pg.
//   · asd      — a list followed by the plan's ASD ground snow with the qualifier AFTER the value or
//                before the label ("= 25.2 PSF (ASD)", "ASD GROUND SNOW LOAD: 25.2 PSF"): never a Pg.
//   · metric   — the ground snow printed metric first ("GROUND SNOW LOAD = 1.72 KPA (36 PSF)").
//
// Two plan families, judged through the REAL finding path (evaluateDesignCodeFindings) at a VERIFIED
// Oregon row with the 36/25 psf minimums, prescriptive path:
//   · TRUE Pg = 36 (every other psf value in the list is below 36): NO ground-snow-below-state-minimum
//     BLOCKER, ever. A minimum warning or a design-criteria-conflict is allowed only where the reading
//     predicate itself says the layout is ambiguous (statedGroundSnowReading) — counted and printed.
//   · TRUE Pg = 16 (every other psf value below 36): never a Pg reading >= 36; and wherever the reading
//     is unambiguous, the BLOCKER fires and names 16 — and only 16.
// Denominators are printed per family: layouts generated, read exactly, not read, ambiguous, warnings,
// conflicts, blockers. Fixtures are synthetic. No LLM, no network.
//
// Run: npx tsx backend/test/groundSnowLayoutCorpus.test.ts
import "./_isolate";
import type { JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";
import { statedGroundSnowReading } from "../src/designCriteria";

const MIN_ID = "city.struct.ground-snow-below-state-minimum";
const CONFLICT_ID = "city.struct.design-criteria-conflict";

interface Item { label: string; value: number; unit: "PSF" | "MPH"; ground?: boolean }
const groundLabels = ["GROUND SNOW LOAD", "GROUND SNOW", "Pg", "SNOW LOAD (GROUND)"];
// Every other load a design-loads list prints — all below 36 psf, so a misread Pg is a false minimum.
const others = (family: 36 | 16): Item[] => [
  { label: "ROOF SNOW LOAD", value: family === 36 ? 25 : 10, unit: "PSF" },
  { label: "FLAT ROOF SNOW", value: family === 36 ? 25 : 10, unit: "PSF" },
  { label: "DEAD LOAD", value: 10, unit: "PSF" },
  { label: "ROOF DEAD LOAD", value: 3, unit: "PSF" },
  { label: "ROOF DL", value: 3, unit: "PSF" },
  { label: "DL", value: 10, unit: "PSF" },
  { label: "LIVE LOAD", value: 20, unit: "PSF" },
  { label: "ROOF LIVE", value: 20, unit: "PSF" },
  { label: "LL", value: 20, unit: "PSF" },
  { label: "PV WEIGHT", value: 2.8, unit: "PSF" },
  { label: "RACKING", value: 3, unit: "PSF" },
  { label: "COLLATERAL", value: 5, unit: "PSF" },
  { label: "WIND SPEED", value: 110, unit: "MPH" },
  // Labels this reader does NOT list — the class that flip-flopped (an unknown leading label).
  { label: "EXISTING ROOF", value: 10, unit: "PSF" },
  { label: "MODULE RAILS", value: 3, unit: "PSF" },
];

/** Every list: [A, G], [G, A], and [A, G, B], [G, A, B], [A, B, G] over ordered pairs A != B. */
function lists(family: 36 | 16, labels = groundLabels): Item[][] {
  const out: Item[][] = [];
  const o = others(family);
  for (const gl of labels) {
    const g: Item = { label: gl, value: family, unit: "PSF", ground: true };
    for (const a of o) {
      out.push([a, g], [g, a]);
      for (const b of o) if (b !== a) out.push([a, g, b], [g, a, b], [a, b, g]);
    }
  }
  return out;
}

type Order = "label-first" | "value-first";
// Round 6: the em dash (the typographic dash Word/InDesign emit) and a run of dot leaders (a title
// block's table fill) are the same spaced separator as the hyphen — the round-5 skeptic's MF-A.
type Sep = ":" | "=" | "-" | "—" | "....." | "none";
type Form = "one line" | "per line" | "comma list" | "DESIGN LOADS heading" | "SNOW LOADS: heading";
const ORDERS: Order[] = ["label-first", "value-first"];
const SEPS: Sep[] = [":", "=", "-", "—", ".....", "none"];
const FORMS: Form[] = ["one line", "per line", "comma list", "DESIGN LOADS heading", "SNOW LOADS: heading"];
const sepText = (sep: Sep): string => (sep === "none" ? " " : sep === ":" ? ": " : sep === "=" ? " = " : ` ${sep} `);

function renderItem(i: Item, order: Order, sep: Sep): string {
  const s = sepText(sep);
  return order === "label-first" ? `${i.label}${s}${i.value} ${i.unit}` : `${i.value} ${i.unit}${s}${i.label}`;
}
function render(items: Item[], order: Order, sep: Sep, form: Form, item = renderItem): string {
  const parts = items.map((i) => item(i, order, sep));
  switch (form) {
    case "one line": return parts.join(" ");
    case "per line": return parts.join("\n");
    case "comma list": return parts.join(", ");
    case "DESIGN LOADS heading": return `DESIGN LOADS\n${parts.join("\n")}`;
    case "SNOW LOADS: heading": return `SNOW LOADS: ${parts.join(" ")}`;
  }
}
const oneDecimal = (n: number): string => String(Math.round(n * 10) / 10);

const project = { id: "snow-corpus", state: "OR", ahj: "City of Testport", utility: "Test Power", homeownerName: "Test Owner", projectAddress: "1 Test St", interconnectionMethod: "Load-side breaker", parserSnapshot: { mounting: "Roof mount", permitPath: "PRESCRIPTIVE" } } as unknown as ProjectRecord;
const profile: JurisdictionCodeProfile = {
  key: "or|city of testport|unknown", state: "OR", ahj: "City of Testport", confidence: "verified",
  adoptedCodes: [], amendments: [], designCriteria: {}, fireSetbacks: [], citations: [], updatedAt: "",
  prescriptive: { minGroundSnowPsfPrescriptive: 36, minGroundSnowPsfEngineered: 25, minGroundSnowCitation: "ORSC 2023 R301.2.3.1" },
  verifiedBy: "operator", verifiedAt: "2026-09-24T00:00:00.000Z",
};
const ctx = buildCodeContext("OR", "City of Testport", profile);

const failures: string[] = [];
const fail = (why: string, text: string): void => { if (failures.length < 40) failures.push(`${why}: ${JSON.stringify(text)}`); else failures.length++; };

interface Counts { layouts: number; readExactly: number; notRead: number; ambiguous: number; minWarnings: number; conflicts: number; blockers: number; falseBlockers: number }
const newCounts = (): Counts => ({ layouts: 0, readExactly: 0, notRead: 0, ambiguous: 0, minWarnings: 0, conflicts: 0, blockers: 0, falseBlockers: 0 });

/** Judge ONE layout of a TRUE-Pg `family` plan; tallies into `n`, failures by `shape`. */
function judge(family: 36 | 16, text: string, shape: string, n: Counts, ambiguousShapes: Map<string, number>, failedShapes: Map<string, number>, mustRead = false): void {
  const failedBefore = failures.length;
  n.layouts++;
  const docs = [{ label: "Plan set", text }];
  const reading = statedGroundSnowReading(project, docs);
  const fs: ReviewerFinding[] = evaluateDesignCodeFindings(project, null, ctx, [], docs);
  const min = fs.find((f) => f.id === MIN_ID);
  const conflict = fs.find((f) => f.id === CONFLICT_ID);
  if (reading.status === "unambiguous" && reading.value === family) n.readExactly++;
  if (reading.status === "none") n.notRead++;
  if (reading.status === "ambiguous") {
    n.ambiguous++;
    ambiguousShapes.set(shape, (ambiguousShapes.get(shape) ?? 0) + 1);
  }
  if (conflict) n.conflicts++;
  if (min?.severity === "warning") n.minWarnings++;
  if (min?.severity === "blocker") n.blockers++;
  const values = reading.status === "unambiguous" ? [reading.value] : reading.status === "ambiguous" ? reading.readings.map((r) => r.value) : [];
  if (family === 36) {
    // A correct 36 psf plan: never a minimum BLOCKER; a warning or conflict only on an ambiguous reading.
    if (min?.severity === "blocker") { n.falseBlockers++; fail(`FALSE BLOCKER (read ${values.join("/")})`, text); }
    if ((min || conflict) && reading.status !== "ambiguous") fail(`${min ? "minimum warning" : "conflict"} on an unambiguous reading (${values.join("/")})`, text);
    if (reading.status === "unambiguous" && reading.value !== 36) fail(`unambiguous misread ${reading.value}`, text);
  } else {
    if (values.some((v) => v >= 36)) fail(`16 psf plan read as ${values.join("/")}`, text);
    if (reading.status === "unambiguous") {
      if (reading.value !== 16) fail(`unambiguous misread ${reading.value}`, text);
      else if (min?.severity !== "blocker") fail(`no BLOCKER on an unambiguous 16 (${min?.severity ?? "no finding"})`, text);
      else {
        const stated = min.message.match(/Ground snow load Pg: stated ([^—]*)—/)?.[1] ?? "";
        if (!/^16 psf in Plan set\s*$/.test(stated)) fail(`BLOCKER names "${stated.trim()}", not 16 alone`, text);
      }
    }
  }
  // A family whose every layout states Pg plainly (metric first) must READ it, not merely not misread it.
  if (mustRead && !(reading.status === "unambiguous" && reading.value === family)) fail(`not read exactly (${reading.status} ${values.join("/")})`, text);
  if (failures.length > failedBefore) failedShapes.set(shape, (failedShapes.get(shape) ?? 0) + 1);
}

/** Every layout of one shape FAMILY for one TRUE Pg: [text, shape] pairs. */
function* layouts(kind: string, family: 36 | 16): Generator<[string, string]> {
  const L = lists(family);
  if (kind === "grid") {
    for (const items of L) for (const order of ORDERS) for (const sep of SEPS) for (const form of FORMS) {
      yield [render(items, order, sep, form), `${order} / sep ${sep} / ${form}`];
    }
  } else if (kind === "table") {
    for (const items of L) for (const join of [" ", "\n"]) {
      const labels = items.map((i) => i.label).join(join);
      const values = items.map((i) => `${i.value} ${i.unit}`).join(join);
      yield [`${labels}${join}${values}`, `header row then value row / join ${JSON.stringify(join)}`];
      yield [`${values}${join}${labels}`, `column-major (values then labels) / join ${JSON.stringify(join)}`];
    }
  } else if (kind === "formula") {
    const pf = oneDecimal(0.7 * 1.1 * family);
    const formulas = [
      `FLAT ROOF SNOW LOAD Pf = 0.7 Ce Ct Is Pg = 0.7 (1.0)(1.1)(1.0)(${family} PSF) = ${pf} PSF`,
      `pf = 0.7 x Ce x Ct x Is x pg = 0.7 x 1.0 x 1.1 x 1.0 x ${family} = ${pf} psf`,
      // Round 6: the JUXTAPOSED product, the commonest line in a snow calc — its result is not a Pg
      // (round-5 skeptic MF-B). Without the guard: 62 false BLOCKERs (a '36 PSF Pg' the list could not
      // read, then the 27.7 read as the only, sure Pg).
      `FLAT ROOF SNOW LOAD Pf = 0.7 Ce Ct Is Pg = ${pf} PSF`,
    ];
    let k = 0;
    for (const items of L) {
      if (k++ % 3) continue; // a deterministic third of the lists: the formula line is the variable
      for (const order of ORDERS) for (const sep of [":", "none"] as const) for (const [fi, f] of formulas.entries()) {
        yield [`${render(items, order, sep, "per line")}\n${f}`, `${order} / sep ${sep} / formula ${fi + 1}`];
      }
    }
  } else if (kind === "asd") {
    const asd = oneDecimal(0.7 * family);
    const lines = [`GROUND SNOW LOAD = ${asd} PSF (ASD)`, `ASD GROUND SNOW LOAD: ${asd} PSF`, `SNOW: Pg = ${asd} PSF (ASD)`];
    let k = 0;
    for (const items of L) {
      if (k++ % 3) continue;
      for (const order of ORDERS) for (const [ai, a] of lines.entries()) {
        yield [`${render(items, order, "none", "per line")}\n${a}`, `${order} / sep none / ASD line ${ai + 1}`];
      }
    }
  } else if (kind === "metric") {
    const kpa = (family * 0.04788).toFixed(2);
    const metric = (i: Item, order: Order, sep: Sep): string =>
      i.ground ? `${i.label}${sepText(sep)}${kpa} KPA (${i.value} PSF)` : renderItem(i, order, sep);
    for (const items of lists(family, ["GROUND SNOW LOAD", "GROUND SNOW", "Pg"])) {
      for (const sep of [":", "="] as const) for (const form of ["one line", "per line"] as const) {
        yield [render(items, "label-first", sep, form, metric), `label-first / sep ${sep} / ${form} / metric first`];
      }
    }
  }
}

const FAMILIES = ["grid", "table", "formula", "asd", "metric"];
for (const kind of FAMILIES) {
  for (const family of [36, 16] as const) {
    const n = newCounts();
    const ambiguousShapes = new Map<string, number>();
    const failedShapes = new Map<string, number>();
    for (const [text, shape] of layouts(kind, family)) judge(family, text, shape, n, ambiguousShapes, failedShapes, kind === "metric");
    console.log(`${kind.padEnd(7)} TRUE Pg ${family}: layouts ${n.layouts} | read exactly ${n.readExactly} | not read ${n.notRead} | ambiguous ${n.ambiguous} | minimum warnings ${n.minWarnings} | conflicts ${n.conflicts} | minimum BLOCKERS ${n.blockers}${family === 36 ? ` (false: ${n.falseBlockers})` : ""}`);
    if (failedShapes.size) console.log(`  FAILED by layout: ${[...failedShapes].map(([k, v]) => `${k}: ${v}`).join("; ")}`);
    if (ambiguousShapes.size) console.log(`  ambiguous by layout: ${[...ambiguousShapes].map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} layout(s) FAILED:\n  FAIL - ${failures.slice(0, 40).join("\n  FAIL - ")}`);
  console.error(`\nground-snow layout corpus FAILED`);
  process.exit(1);
}
console.log("\nall ground-snow layout corpus checks passed");
process.exit(0);
