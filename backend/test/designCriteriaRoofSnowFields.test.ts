// ROOF SNOW, WEATHERING, TERMITE, SOIL BEARING ON THE CODE PROFILE (#211).
//
// An AHJ's published design-criteria table states a roof snow load and a weathering probability
// (and termite / soil bearing) next to its ground snow, wind and seismic values. Before #211 the
// profile had nowhere to put them: the verify schema stripped them (and pg(asd) with them), the
// lookup never asked, and neither card could show them. This pins each door:
//   1. the verify schema (PUT /api/code-profiles/verify) keeps them, and pg(asd);
//   2. saveVerifiedCodeProfile + listCodeProfiles (GET /api/code-profiles) round-trip them;
//   3. the design-criteria lookup's parser keeps a quote-bound value and drops an unbound one,
//      and mergeResearchedDesignCriteria lands them (seeded, cited);
//   4. the KB card (kbDesignCriteriaHtml) and the /review verify summary (profileSummaryHtml)
//      show them, every value esc()'d.
// Values are a synthetic fixture (a made-up jurisdiction); the fields are generic.
//
// Run: npx tsx backend/test/designCriteriaRoofSnowFields.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JurisdictionCodeProfile } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roof-snow-fields-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.CODE_RESEARCH = "off";

const { openDatabase } = await import("../src/db");
const CP = await import("../src/codeProfiles");
const { codeProfileVerifySchema } = await import("../src/validation");
const { parseDesignCriteriaLookup } = await import("../src/llm");
const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const NEW_FIELDS = { roofSnowLoadPsf: 30, weathering: "severe" as const, termite: "Slight to Moderate", soilBearingPsf: 1500 };
const row = (state: string, ahj: string, over: Partial<JurisdictionCodeProfile> = {}): JurisdictionCodeProfile => ({
  key: "", state, ahj, confidence: "seeded", adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {},
  fireSetbacks: [], citations: [], updatedAt: "", ...over,
});

console.log("1-2. verify schema and round trip");

await check("the verify schema keeps roof snow, weathering, termite, soil bearing and pg(asd)", () => {
  const body = codeProfileVerifySchema.parse({ state: "ZZ", ahj: "City of Testfield", designCriteria: { groundSnowLoadPsf: 43, groundSnowLoadAsdPsf: 30, ...NEW_FIELDS } });
  assert.deepEqual(body.designCriteria, { groundSnowLoadPsf: 43, groundSnowLoadAsdPsf: 30, ...NEW_FIELDS });
  assert.throws(() => codeProfileVerifySchema.parse({ state: "ZZ", designCriteria: { weathering: "extreme" } }), "weathering is one of three words");
});

await check("PUT verify -> GET /api/code-profiles: the fields round-trip on the verified row", () => {
  const body = codeProfileVerifySchema.parse({ state: "ZZ", ahj: "City of Testfield", designCriteria: { groundSnowLoadPsf: 43, groundSnowLoadAsdPsf: 30, ...NEW_FIELDS } });
  CP.saveVerifiedCodeProfile(db, row(body.state, body.ahj, { confidence: "verified", designCriteria: body.designCriteria }), "operator");
  const listed = CP.listCodeProfiles(db).find((p) => p.state === "ZZ" && p.ahj === "City of Testfield");
  assert.ok(listed, "listed");
  assert.equal(listed!.confidence, "verified");
  assert.deepEqual(listed!.designCriteria, { groundSnowLoadPsf: 43, groundSnowLoadAsdPsf: 30, ...NEW_FIELDS });
  // And the reviewer's context carries the roof snow for the below-ahj rule.
  assert.equal(CP.resolveEffectiveCodeContext(db, "ZZ", "City of Testfield").designCriteria?.roofSnowLoadPsf, 30);
});

console.log("3. the lookup parses and merges them");

const JUR = { ahj: "City of Testmere", state: "ZZ" };
const TABLE = "https://www.testmere.gov/building/design-criteria";
const lookup = {
  roofSnowLoadPsf: { value: 30, sourceUrl: TABLE, quote: "Ground snow load 43 psf; Roof snow load 30 psf" },
  weathering: { value: "Severe", sourceUrl: TABLE, quote: "Weathering: Severe" },
  termite: { value: "Slight to Moderate", sourceUrl: TABLE, quote: "Termite: Slight to Moderate" },
  soilBearingPsf: { value: 1500, sourceUrl: TABLE, quote: "Soil bearing capacity 1,500 psf" },
};

await check("the parser keeps quote-bound values; a ground snow number is never a roof snow load", () => {
  const r = parseDesignCriteriaLookup(lookup, true, false, JUR);
  const got = Object.fromEntries(r.values.map((v) => [v.criterion, v.value]));
  assert.deepEqual(got, { roofSnowLoadPsf: 30, weathering: "severe", termite: "Slight to Moderate", soilBearingPsf: 1500 }, "termite is kept as published");
  const bad = parseDesignCriteriaLookup({
    roofSnowLoadPsf: { value: 43, sourceUrl: TABLE, quote: "Ground snow load 43 psf; Roof snow load 30 psf" },
    weathering: { value: "severe", sourceUrl: TABLE, quote: "Seismic Design Category D1" },
    soilBearingPsf: { value: 30, sourceUrl: TABLE, quote: "Roof snow load 30 psf" },
  }, true, false, JUR);
  assert.deepEqual(bad.values, [], bad.notes);
  // #211 review: a bare "roof" (live / dead load), a sloped ps, and a weathering RANGE are never kept
  // — they would seed shared knowledge as the AHJ's value.
  for (const [key, value, quote] of [
    ["roofSnowLoadPsf", 20, "Roof live load 20 psf"],
    ["roofSnowLoadPsf", 15, "Roof dead load: 15 psf"],
    ["roofSnowLoadPsf", 40, "Ground snow 25; Roof 40 (live)"],
    ["roofSnowLoadPsf", 22, "Sloped roof snow load, ps = 22 psf"],
    ["roofSnowLoadPsf", 22, "Roof snow load, ps = 22 psf"],
    ["weathering", "Moderate", "Weathering: Moderate to Severe"],
  ] as const) {
    const r = parseDesignCriteriaLookup({ [key]: { value, sourceUrl: TABLE, quote } }, true, false, JUR);
    assert.deepEqual(r.values, [], `kept "${quote}" as ${key}`);
  }
  // pf / pm are roof snow symbols the AHJ's own table may print.
  assert.equal(parseDesignCriteriaLookup({ roofSnowLoadPsf: { value: 30, sourceUrl: TABLE, quote: "Flat roof snow load pf = 30 psf" } }, true, false, JUR).values[0]?.value, 30);
});

await check("mergeResearchedDesignCriteria lands them on a seeded row, each cited", () => {
  const r = CP.mergeResearchedDesignCriteria(db, JUR, parseDesignCriteriaLookup(lookup, true, false, JUR));
  assert.equal(r.saved, true, r.reason);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual([...r.filled].sort(), ["roofSnowLoadPsf", "soilBearingPsf", "termite", "weathering"]);
  const saved = CP.listCodeProfiles(db).find((p) => p.state === "ZZ" && p.ahj === "City of Testmere");
  assert.equal(saved?.confidence, "seeded");
  assert.deepEqual({ ...saved!.designCriteria, sourceUrl: undefined }, { ...NEW_FIELDS, sourceUrl: undefined });
  assert.ok(saved!.citations.some((c) => c.field === "designCriteria.roofSnowLoadPsf" && c.sourceUrl === TABLE));
});

await check("a VERIFIED row is never filled by the lookup, for the new fields too (rule 3)", () => {
  const r = CP.mergeResearchedDesignCriteria(db, { state: "ZZ", ahj: "City of Testfield" }, parseDesignCriteriaLookup({
    ...lookup, roofSnowLoadPsf: { value: 50, sourceUrl: TABLE, quote: "Roof snow load 50 psf" },
  }, true, false, JUR));
  assert.equal(r.saved, false);
  assert.match(String(r.reason), /human-verified/);
  const still = CP.listCodeProfiles(db).find((p) => p.state === "ZZ" && p.ahj === "City of Testfield");
  assert.equal(still?.designCriteria.roofSnowLoadPsf, 30);
});

await check("the verify schema also keeps specialWindRegion", () => {
  assert.equal(codeProfileVerifySchema.parse({ state: "ZZ", designCriteria: { specialWindRegion: true } }).designCriteria.specialWindRegion, true);
});

console.log("4. the cards show them, escaped");

const here = path.dirname(fileURLToPath(import.meta.url));
const lift = (file: string) => {
  const src = fs.readFileSync(path.join(here, "..", "..", "frontend", file), "utf8").replace(/\r\n/g, "\n");
  return (kind: "function" | "const", name: string): string => {
    const re = kind === "function" ? new RegExp(`^function ${name}\\(`, "m") : new RegExp(`^const ${name} = `, "m");
    const m = re.exec(src);
    if (!m) throw new Error(`${file}: could not find ${kind} ${name}`);
    // A const ends at the first line that ends with ";" (one-line arrows, multi-line maps alike).
    if (kind === "const") {
      const end = /;[ \t]*$/m.exec(src.slice(m.index));
      if (!end) throw new Error(`${file}: const ${name} has no end`);
      return src.slice(m.index, m.index + end.index + 1);
    }
    const firstBrace = src.indexOf("{", m.index);
    let depth = 0, end = -1;
    for (let j = firstBrace; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    return src.slice(m.index, end) + (kind === "const" ? ";" : "");
  };
};
const dash = lift("dashboard.js");
// eslint-disable-next-line no-new-func
const kbDesignCriteriaHtml = new Function(`${dash("function", "esc")}\n${dash("const", "KB_CRITERIA_LABELS")}\n${dash("const", "KB_OBSERVED_LABELS")}\n${dash("function", "kbDesignCriteriaHtml")}\nreturn kbDesignCriteriaHtml;`)() as (p: unknown) => string;
const rev = lift("review.js");
const reviewBundle = ["esc", "httpUrl", "sourceLink", "KEY_WORDS", "humanKey", "plainValue"].map((n) => rev("const", n)).join("\n");
// eslint-disable-next-line no-new-func
const profileSummaryHtml = new Function(`${reviewBundle}\n${rev("function", "profileSummaryHtml")}\nreturn profileSummaryHtml;`)() as (p: unknown) => string;
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const XSS = "<img src=x onerror=alert(1)>";
const cardProfile = (dc: Record<string, unknown>) => ({ state: "ZZ", ahj: "City of Testfield", confidence: "verified", verifiedBy: "operator", designCriteria: dc, citations: [], fireSetbacks: [], amendments: [] });

await check("KB card shows roof snow, weathering, termite and soil bearing", () => {
  const t = text(kbDesignCriteriaHtml(cardProfile({ groundSnowLoadPsf: 43, ...NEW_FIELDS })));
  assert.match(t, /Roof snow load \(AHJ-stated minimum\): 30 psf/);
  assert.match(t, /Weathering \(informational\): severe/);
  assert.match(t, /Termite \(informational\): Slight to Moderate/);
  assert.match(t, /Soil bearing \(informational\): 1500 psf/);
});

await check("KB card and verify summary esc() every new value", () => {
  for (const html of [kbDesignCriteriaHtml(cardProfile({ termite: XSS, roofSnowLoadPsf: XSS })), profileSummaryHtml({ designCriteria: { termite: XSS, roofSnowLoadPsf: XSS } })]) {
    assert.ok(!html.includes("<img"), html);
    assert.ok(html.includes("&lt;img"), html);
  }
});

await check("/review verify summary shows them with units", () => {
  const t = text(profileSummaryHtml({ designCriteria: { groundSnowLoadPsf: 43, groundSnowLoadAsdPsf: 30, ...NEW_FIELDS }, adoptedCodes: [], amendments: [], citations: [] }));
  assert.match(t, /Roof snow load: 30 psf/);
  assert.match(t, /Ground snow load pg\(asd\): 30 psf/);
  assert.match(t, /Weathering \(informational\): severe/);
  assert.match(t, /Termite \(informational\): Slight to Moderate/);
  assert.match(t, /Soil bearing \(informational\): 1500 psf/);
});

if (failures) {
  console.error(`\n${failures} roof snow / weathering field check(s) FAILED`);
  process.exit(1);
}
console.log("\nall roof snow / weathering field checks passed");
process.exit(0);
