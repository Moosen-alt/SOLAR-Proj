// THE DESIGN-CRITERIA LOOKUP ANSWERS A CHECKLIST, NEVER ONE NUMBER (issue #13).
//
// Owner live run, City of Albuquerque: the lookup came back with ONE value — ground snow 20 psf —
// cited to a STORAGE-BUILDING handout, and nothing for wind, seismic, frost depth or fire setbacks.
// QC and the reviewer compare plan sets against this profile, so a missing criterion is a silent pass.
//   C1 a handout-cited value is kept (seeded) but FLAGGED weak; a design-criteria page is not flagged.
//   C2 the lookup parses seismic design category and frost depth, bound to their own labels.
//   C3 a partial answer (stub LLM) records EVERY other checklist item as "not found" on the row and in
//      the job result; the row stays seeded.
//   C4 a cut-off / ungrounded lookup records the gaps as "not researched", never "not found".
//   C5 a human-verified row is never written (hard rule 3).
//   C6 the KB card shows the weak source and every gap as "not found / not researched — verify".
//   C7 the lookup asks for the RISK CATEGORY too (issue #111), bound to its own label, never a list.
// Stub LLM throughout — no network.
//
//   npx tsx backend/test/designCriteriaChecklist.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "design-criteria-checklist-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.CODE_RESEARCH = "off";

const { openDatabase } = await import("../src/db");
const CP = await import("../src/codeProfiles");
const { parseDesignCriteriaLookup, weakDesignSourceReason } = await import("../src/llm");
type LLMProvider = import("../../shared/src/types").LLMProvider;
type DesignCriteriaResearchResult = import("../../shared/src/types").DesignCriteriaResearchResult;
type WebLookupResult = import("../../shared/src/types").WebLookupResult;

const db = await openDatabase();
let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve().then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

// Synthetic jurisdiction; the handout URL has the SHAPE of the live one (a .gov storage-building PDF).
const JUR = { ahj: "City of Testburg", state: "NM" };
const HANDOUT = "https://documents.testburg.gov/planning/BuildingSafety/Storage%20Building.pdf";
const TABLE = "https://www.testburg.gov/building-safety/design-criteria";
const snowFromHandout = { groundSnowLoadPsf: { value: 20, sourceUrl: HANDOUT, quote: "Ground snow load: 20 psf" } };

await check("C1 a storage-building handout is flagged weak; the design-criteria table is not", () => {
  const r = parseDesignCriteriaLookup(snowFromHandout, true, false, JUR);
  assert.equal(r.values.length, 1, JSON.stringify(r));
  assert.equal(r.values[0].value, 20);
  assert.match(String(r.values[0].weakSource), /handout/i);
  const t = parseDesignCriteriaLookup({ groundSnowLoadPsf: { value: 20, sourceUrl: TABLE, quote: "Ground snow load: 20 psf" } }, true, false, JUR);
  assert.equal(t.values[0].weakSource, undefined, "a design-criteria page was flagged");
  // The model's own sourceKind counts too, whatever the URL says.
  assert.ok(weakDesignSourceReason(TABLE, "project_handout"));
  assert.equal(weakDesignSourceReason("https://www.testburg.gov/codes/adoption-ordinance"), "");
  assert.ok(weakDesignSourceReason("https://www.testburg.gov/files/Deck_Permit_Guide.pdf"));
});

await check("C2 seismic design category and frost depth are parsed, each bound to its own label", () => {
  const r = parseDesignCriteriaLookup({
    seismicDesignCategory: { value: "b", sourceUrl: TABLE, quote: "Seismic Design Category: B" },
    frostDepthIn: { value: 18, sourceUrl: TABLE, quote: "Frost line depth 18 inches" },
  }, true, false, JUR);
  assert.deepEqual(r.values.map((v) => [v.criterion, v.value]), [["seismicDesignCategory", "B"], ["frostDepthIn", 18]], JSON.stringify(r));
  const bad = parseDesignCriteriaLookup({
    seismicDesignCategory: { value: "D0", sourceUrl: TABLE, quote: "Seismic Design Category D0 or D1 depending on site" },
    frostDepthIn: { value: 12, sourceUrl: TABLE, quote: "Footings 12 inches wide" },
  }, true, false, JUR);
  assert.equal(bad.values.length, 0, JSON.stringify(bad));
});

const provider = (research: DesignCriteriaResearchResult, placementGrounded = 3): LLMProvider => ({
  async researchDesignCriteria() { return research; },
  async webLookup(): Promise<WebLookupResult> {
    return { text: JSON.stringify({ rules: [] }), groundedSearches: placementGrounded, stopReason: "end_turn", resultUrls: [], pagesRead: 0, fetchedUrls: [] };
  },
} as unknown as LLMProvider);

const statusOf = (items: Array<{ item: string; status: string }> | undefined) => Object.fromEntries((items ?? []).map((i) => [i.item, i.status]));

await check("C3 a partial answer stores the one value and records every other item as not found", async () => {
  const research = parseDesignCriteriaLookup(snowFromHandout, true, false, JUR);
  const r = await CP.runDesignCriteriaResearch(db, JUR, provider(research));
  assert.equal(r.saved, true, JSON.stringify(r));
  const row = CP.resolveCriteriaWriteRow(db, JUR.state, JUR.ahj);
  assert.ok(row && row.kind !== "create" && row.kind !== "blocked_verified", JSON.stringify(row));
  const profile = row.profile!;
  assert.equal(profile.confidence, "seeded");
  assert.equal(profile.designCriteria.groundSnowLoadPsf, 20);
  const cite = profile.citations.find((c) => c.field === "designCriteria.groundSnowLoadPsf");
  assert.match(String(cite?.weakSource), /handout/i, "the handout citation is not flagged on the profile");
  const expected = {
    groundSnowLoad: "weak_source", windSpeed: "not_found", windExposure: "not_found", seismicDesignCategory: "not_found",
    frostDepth: "not_found", riskCategory: "not_found", fireSetbacks: "not_found", localPvAmendments: "not_found",
  };
  assert.deepEqual(statusOf(profile.designCriteriaLookup?.items), expected, JSON.stringify(profile.designCriteriaLookup));
  assert.deepEqual(statusOf(r.checklist as Array<{ item: string; status: string }>), expected, "the job result does not carry the checklist");
});

await check("C4 a cut-off or ungrounded lookup is 'not researched', never 'not found'", () => {
  const truncated = parseDesignCriteriaLookup(snowFromHandout, true, true, JUR);
  const rec = CP.buildDesignCriteriaChecklist({ designCriteria: { groundSnowLoadPsf: 20 }, fireSetbacks: [], amendments: [], citations: [] }, truncated, false);
  const s = statusOf(rec.items);
  assert.equal(s.groundSnowLoad, "found");
  for (const k of ["windSpeed", "windExposure", "seismicDesignCategory", "frostDepth", "riskCategory", "fireSetbacks", "localPvAmendments"]) assert.equal(s[k], "not_researched", `${k}: ${s[k]}`);
  const none = statusOf(CP.buildDesignCriteriaChecklist(null, null, false).items);
  assert.ok(Object.values(none).every((v) => v === "not_researched"), JSON.stringify(none));
  assert.equal(CP.DESIGN_CRITERIA_CHECKLIST.length, 8);
});

await check("C5 a human-verified row is never written by the lookup or its checklist (hard rule 3)", async () => {
  const V = { ahj: "Verifiedburg", state: "NM" };
  CP.saveVerifiedCodeProfile(db, { key: "", ...V, confidence: "verified", adoptedCodes: [], amendments: [], designCriteria: { windSpeedMph: 105 }, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "" }, "test");
  const before = db.get<{ payload_json: string; updated_at: string }>("SELECT payload_json, updated_at FROM jurisdiction_code_profiles WHERE ahj = ?", [V.ahj]);
  await CP.runDesignCriteriaResearch(db, V, provider(parseDesignCriteriaLookup({ groundSnowLoadPsf: { value: 20, sourceUrl: "https://www.verifiedburg.gov/design-criteria", quote: "Ground snow load: 20 psf" } }, true, false, V)));
  const saved = CP.saveDesignCriteriaLookupRecord(db, V, CP.buildDesignCriteriaChecklist(null, null, false));
  assert.equal(saved, false, "the checklist was written onto a verified row");
  const after = db.get<{ payload_json: string; updated_at: string; confidence: string }>("SELECT payload_json, updated_at, confidence FROM jurisdiction_code_profiles WHERE ahj = ?", [V.ahj]);
  assert.equal(after?.confidence, "verified");
  assert.equal(after?.payload_json, before?.payload_json, "the verified row's payload changed");
});

await check("C6 the KB card shows the weak source and every gap as 'verify'", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dashboard = fs.readFileSync(path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
  const cut = (kind: "function" | "const", name: string): string => {
    const m = (kind === "function" ? new RegExp(`^function ${name}\\(`, "m") : new RegExp(`^const ${name} = `, "m")).exec(dashboard);
    if (!m) throw new Error(`dashboard.js: could not find ${kind} ${name}`);
    let depth = 0, end = -1;
    for (let j = dashboard.indexOf("{", m.index); j < dashboard.length; j++) {
      if (dashboard[j] === "{") depth++;
      else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    return dashboard.slice(m.index, end) + (kind === "const" ? ";" : "");
  };
  const bundle = [cut("function", "esc"), cut("const", "KB_CRITERIA_LABELS"), cut("const", "KB_OBSERVED_LABELS"), cut("function", "kbDesignCriteriaHtml")].join("\n\n");
  // eslint-disable-next-line no-new-func
  const render = new Function(`${bundle}\nreturn kbDesignCriteriaHtml;`)() as (p: unknown) => string;
  const row = CP.resolveCriteriaWriteRow(db, JUR.state, JUR.ahj);
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ");
  const t = text(render(row && row.kind !== "create" ? row.profile : null));
  assert.match(t, /Ground snow load: 20 psf .*Weak source — verify/, t);
  for (const label of ["Design wind speed", "Wind exposure", "Seismic design category", "Frost depth", "Risk category", "Fire setbacks / roof pathways", "Local PV amendments"]) {
    assert.ok(new RegExp(`${label}[^:]*: not found \\(lookup \\d{4}-\\d{2}-\\d{2}\\) — verify`).test(t), `${label} gap not shown: ${t}`);
  }
  // No lookup on record: the gap still shows, as not researched.
  const bare = text(render({ state: "NM", ahj: "Elsewhere", confidence: "seeded", designCriteria: {}, prescriptive: {}, fireSetbacks: [], amendments: [], citations: [] }));
  assert.match(bare, /Seismic design category: not researched — verify/, bare);
});

await check("C7 the lookup's prompt asks for the risk category; the answer is parsed bound to its label", async () => {
  const { DESIGN_CRITERIA_LOOKUP_SYSTEM } = await import("../src/llm");
  assert.match(DESIGN_CRITERIA_LOOKUP_SYSTEM, /risk category/i);
  assert.match(DESIGN_CRITERIA_LOOKUP_SYSTEM, /"riskCategory"/);
  const ok = parseDesignCriteriaLookup({ riskCategory: { value: "2", sourceUrl: TABLE, quote: "Risk Category: II" } }, true, false, JUR);
  assert.deepEqual(ok.values.map((v) => [v.criterion, v.value]), [["riskCategory", "II"]], JSON.stringify(ok));
  const bad = parseDesignCriteriaLookup({ riskCategory: { value: "II", sourceUrl: TABLE, quote: "Risk Category I or II structures" } }, true, false, JUR);
  assert.equal(bad.values.length, 0, JSON.stringify(bad));
  const unbound = parseDesignCriteriaLookup({ riskCategory: { value: "II", sourceUrl: TABLE, quote: "Exposure II applies" } }, true, false, JUR);
  assert.equal(unbound.values.length, 0, JSON.stringify(unbound));
  // A model answer that is not a category never reaches a pattern (no throw, dropped).
  const junk = parseDesignCriteriaLookup({ riskCategory: { value: "II)(", sourceUrl: TABLE, quote: "Risk Category II)(" } }, true, false, JUR);
  assert.equal(junk.values.length, 0, JSON.stringify(junk));
  // Stored on the row (seeded) and found on the checklist.
  const R = { ahj: "City of Riskton", state: "NM" };
  const research = parseDesignCriteriaLookup({ riskCategory: { value: "II", sourceUrl: "https://www.riskton.gov/building/design-criteria", quote: "Risk Category II" } }, true, false, R);
  const r = await CP.runDesignCriteriaResearch(db, R, provider(research));
  assert.equal(r.saved, true, JSON.stringify(r));
  const row = CP.resolveCriteriaWriteRow(db, R.state, R.ahj);
  assert.ok(row && row.kind !== "create" && row.kind !== "blocked_verified");
  assert.equal(row.profile!.designCriteria.riskCategory, "II");
  assert.equal(row.profile!.confidence, "seeded");
  assert.equal(statusOf(row.profile!.designCriteriaLookup?.items).riskCategory, "found");
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\ndesignCriteriaChecklist: all checks passed");
