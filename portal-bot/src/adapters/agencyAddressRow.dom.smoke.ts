// THE ADDRESS VERSION IS THE LOOKED-UP ISSUING AGENCY'S ROW — at the learn AND at the replay.
//
// Production finding (operator, 2026-09-27): City of Jefferson OR's permits are issued by MARION
// COUNTY (the per-job lookup, both permits). The address-version ranking preferred CITY rows for
// structural and COUNTY rows for electrical — Coos Bay's convention (Coos Bay issues its own
// building permits) — so a structural learn or replay for Jefferson would take the city's row and
// file with the wrong agency, and the backend refused to borrow the Coos Bay structural recipe for
// exactly that. The preference is now the agency (addressVersion.rankAddressVersions, one
// predicate) and both doors that click a row pass it: the learner's chooseProjectAddressRow
// (siteIdentity.issuingAgency) and the replay's pickAddressVersionLive (fieldValues.issuingAgency,
// the key bindRecipeForReplay already writes).
//
// Grids are the live shape (Oregon ePermitting, run 99baa5d0 frame f004: "<street>, COUNTY
// APPLICATIONS, <CITY> <COUNTY> OR <ZIP>") with a synthetic street and owner. "two" is the
// City+County shape the finding describes; "live" is what Jefferson's grid actually offered (two
// versions, both County Applications); "cityOnly" offers no row of the agency's kind at all.
//
// MUST-PASS  replay: Jefferson structural + Marion County → the COUNTY row; electrical → COUNTY;
//            Coos Bay structural + City of Coos Bay → CITY; Coos Bay electrical + Coos County → COUNTY.
//            learner: Jefferson structural + Marion County → clicks the COUNTY row, records its note.
// MUST-EXCLUDE agency unknown → today's convention at both doors (Jefferson structural → CITY);
//            an agency whose row is not offered and whose convention pick is the OTHER kind
//            (Marion County, city-only grid) → NOTHING clicked at either door, a named refusal.
//
// Run: npx tsx portal-bot/src/adapters/agencyAddressRow.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { AutoLearnAdapter } from "./autoLearnAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const row = (id: string, address: string, desc: string, city: string, zip: string, owner = ""): string =>
  `<tr><td><a href="#" onclick="pick('${id}');return false;">Select</a></td><td>${address}</td><td>${desc}</td><td>${city}</td><td>OR</td><td>${zip}</td><td>103W01CB09999</td><td>${owner}</td></tr>`;
const JEFF_CITY = row("city", "100 EXAMPLE RD SE, City Applications, JEFFERSON MARION OR 97352", "City Applications", "JEFFERSON", "97352", "PARCEL HOLDER");
const JEFF_COUNTY = row("county", "100 EXAMPLE RD SE, COUNTY APPLICATIONS, JEFFERSON MARION OR 97352", "COUNTY APPLICATIONS", "JEFFERSON", "97352", "PARCEL HOLDER");
const JEFF_DEQ = row("deq", "100 EXAMPLE RD SE, DEQ Applications, JEFFERSON Marion OR 97352", "DEQ Applications", "JEFFERSON", "97352");
const GRIDS: Record<string, string> = {
  two: JEFF_CITY + JEFF_COUNTY,
  live: row("county-owner", "100 EXAMPLE RD SE, 1701000, COUNTY APPLICATIONS, SOUTH, JEFFERSON MARION OR 97352, 100 EXAMPLE RD SE, JEFFERSON, OR 97352", "COUNTY APPLICATIONS", "JEFFERSON", "97352", "CUSTOMER, SAMPLE")
    + row("county-other", "100 EXAMPLE RD SE, 1701000, COUNTY APPLICATIONS, SOUTH, JEFFERSON MARION OR 97352, 100 EXAMPLE RD SE, JEFFERSON, OR 97352", "COUNTY APPLICATIONS", "JEFFERSON", "97352"),
  cityOnly: JEFF_CITY + JEFF_DEQ,
  coos: row("deq", "773 KENTUCKY AV, DEQ Applications, COOS BAY Coos OR 97420", "DEQ Applications", "COOS BAY", "97420", "GILPIN, BILLY")
    + row("city", "773 KENTUCKY AVE, City Applications, EMPIRE, COOS BAY COOS OR 97420", "City Applications", "COOS BAY", "97420", "SAKSCHEWSKI, GERHARD")
    + row("county", "773 KENTUCKY AVE, COUNTY APPLICATIONS, COOS BAY COOS OR 97420", "COUNTY APPLICATIONS", "COOS BAY", "97420", "HUISMAN, VINCENT"),
};
const page = (grid: string): string => `<!doctype html><html><head><title>BuildingPermits.Test.gov</title></head><body>
  <h2>Enter Work Site Location</h2>
  <table><tr><th>Action</th><th>Address</th><th>Description</th><th>City</th><th>State</th><th>Zip</th><th>Parcel</th><th>Owner</th></tr>${grid}</table>
  <div id="picked"></div>
  <script>function pick(w){document.getElementById('picked').textContent=w;}</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const name = new URL(req.url || "/", "http://127.0.0.1").pathname.replace(/^\//, "");
  if (GRIDS[name] === undefined) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(GRIDS[name]));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
async function newPage(grid: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(8000);
  await ctx.route("**/*", (route) => (/^https?:\/\/127\.0\.0\.1:/.test(route.request().url()) ? route.continue() : route.abort()));
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const p = await ctx.newPage();
  await p.goto(`${base}/${grid}`);
  return { page: p, close: () => ctx.close().catch(() => undefined) };
}
const picked = (p: Page) => p.evaluate(() => document.getElementById("picked")?.textContent || "").catch(() => "(unreadable)");

// ── THE REPLAY DOOR (RecipeAdapter.pickAddressVersionLive) ─────────────────────────────────────
interface ReplayOut { picked: string; ok: boolean; message: string; aging: string[]; drift: string[] }
async function replay(grid: string, discipline: string, recordedNote: string, values: Record<string, string>): Promise<ReplayOut> {
  const { page: p, close } = await newPage(grid);
  const steps: RecipeStep[] = [
    { action: "goto", value: `${base}/${grid}`, note: "entry url" },
    { action: "click", selector: { css: "[data-al-row=\"ar1\"]", fallbacks: [{ role: "link", name: "Select" }] }, note: recordedNote },
    { action: "stopForReview" } as RecipeStep,
  ];
  const recipe = {
    id: `agency-${grid}`, scopeType: "ahj", profileKey: "or|city of coos bay|pacific power", state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
    portalPlatform: "accela", portalUrl: `${base}/`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "", discipline, steps,
  } as unknown as PortalRecipe;
  const adapter = new RecipeAdapter(recipe, { __replayBlank: "", ...values }, {}, {});
  (adapter as unknown as { page: unknown }).page = p;
  let result: { ok: boolean; message: string; data?: Record<string, unknown> };
  try { result = await adapter.fillApplication({} as ProjectRecord) as typeof result; }
  catch (e) { result = { ok: false, message: `threw ${String(e).slice(0, 300)}` }; }
  const out: ReplayOut = {
    picked: await picked(p), ok: result.ok, message: String(result.message ?? ""),
    aging: (result.data?.agingNotes as string[] | undefined) ?? [], drift: (result.data?.driftWarnings as string[] | undefined) ?? [],
  };
  await close();
  return out;
}
const sayR = (o: ReplayOut) => `picked=${JSON.stringify(o.picked)} ok=${o.ok} msg=${o.message.slice(0, 260)} aging=${JSON.stringify(o.aging.filter((a) => /address/.test(a)))} drift=${JSON.stringify(o.drift.slice(0, 3))}`;
const JEFF_VALUES = { city: "Jefferson", zip: "97352", homeownerName: "Sample Customer" };
const COOS_VALUES = { city: "Coos Bay", zip: "97420", homeownerName: "Christopher Ivy" };
// The notes as the Coos Bay recipes recorded them, with the agency appended the way
// bindRecipeForReplay appends it.
const STRUCT_NOTE = (agency: string) => `address version: City Applications${agency ? ` — issuing agency: ${agency} (per-job lookup)` : ""}`;
const ELEC_NOTE = (agency: string) => `address version: COUNTY APPLICATIONS${agency ? ` — issuing agency: ${agency} (per-job lookup)` : ""}`;

try {
  const r1 = await replay("two", "structural", STRUCT_NOTE("Marion County"), { ...JEFF_VALUES, issuingAgency: "Marion County" });
  check("MUST-PASS replay: Jefferson STRUCTURAL, agency Marion County → the COUNTY row", r1.picked === "county", sayR(r1));
  check("MUST-PASS replay: the run log names the agency the row was ranked by", r1.aging.some((a) => /Marion County/.test(a)), sayR(r1));
  const r2 = await replay("two", "electrical", ELEC_NOTE("Marion County"), { ...JEFF_VALUES, issuingAgency: "Marion County" });
  check("MUST-PASS replay: Jefferson ELECTRICAL, agency Marion County → the COUNTY row", r2.picked === "county", sayR(r2));
  const r3 = await replay("live", "structural", STRUCT_NOTE("Marion County"), { ...JEFF_VALUES, issuingAgency: "Marion County" });
  check("MUST-PASS replay: the live Jefferson grid (both County) → the owner's County row", r3.picked === "county-owner", sayR(r3));
  const r4 = await replay("coos", "structural", STRUCT_NOTE("City of Coos Bay"), { ...COOS_VALUES, issuingAgency: "City of Coos Bay" });
  check("MUST-PASS replay: Coos Bay STRUCTURAL, agency City of Coos Bay → the CITY row", r4.picked === "city", sayR(r4));
  const r5 = await replay("coos", "electrical", ELEC_NOTE("Coos County"), { ...COOS_VALUES, issuingAgency: "Coos County" });
  check("MUST-PASS replay: Coos Bay ELECTRICAL, agency Coos County → the COUNTY row", r5.picked === "county", sayR(r5));
  const r6 = await replay("coos", "electrical", ELEC_NOTE(""), { ...COOS_VALUES });
  check("MUST-PASS replay: Coos Bay ELECTRICAL, agency unknown → the COUNTY row (the convention)", r6.picked === "county", sayR(r6));

  const x1 = await replay("two", "structural", STRUCT_NOTE(""), { ...JEFF_VALUES });
  check("MUST-EXCLUDE replay: agency unknown → today's convention (Jefferson structural → the CITY row)", x1.picked === "city", sayR(x1));
  const x2 = await replay("cityOnly", "structural", STRUCT_NOTE("Marion County"), { ...JEFF_VALUES, issuingAgency: "Marion County" });
  check("MUST-EXCLUDE replay: Marion County with only the city's version offered → NOTHING clicked", x2.picked === "", sayR(x2));
  check("MUST-EXCLUDE replay: ...and the run stops with the agency and the refused row named", !x2.ok && /Marion County/.test(`${x2.message} ${x2.drift.join(" ")}`) && /CITY/i.test(`${x2.message} ${x2.drift.join(" ")}`), sayR(x2));
  // The stop is THIS project's jurisdiction, not recipe drift: worded in the family the replay
  // classifier keeps the recipe on (portalRecipes.replayFailureBlamesRecipe; replayDemotion.test).
  check("MUST-EXCLUDE replay: ...worded \"is not offered here\" so the stop never demotes the recipe", /is not offered here/.test(x2.message), sayR(x2));

  // ── THE LEARN DOOR (AutoLearnAdapter.chooseProjectAddressRow) ──────────────────────────────
  type Chooser = { page: unknown; chooseProjectAddressRow(steps: RecipeStep[]): Promise<boolean>; addressRowRefusal?: string | null };
  const learn = async (grid: string, isElectrical: boolean, issuingAgency?: string) => {
    const { page: p, close } = await newPage(grid);
    const adapter = new AutoLearnAdapter("Agency Row Smoke", {} as never, { maxPages: 1, siteIdentity: { ...JEFF_VALUES, isElectrical, issuingAgency } });
    const a = adapter as unknown as Chooser;
    a.page = p;
    const steps: RecipeStep[] = [];
    const chose = await a.chooseProjectAddressRow(steps).catch((e: unknown) => { console.error(e); return false; });
    const out = { chose, picked: await picked(p), note: String(steps[steps.length - 1]?.note ?? ""), refusal: a.addressRowRefusal ?? null };
    await close();
    return out;
  };
  const l1 = await learn("two", false, "Marion County");
  check("MUST-PASS learn: Jefferson STRUCTURAL, agency Marion County → clicks the COUNTY row and records it",
    l1.chose === true && l1.picked === "county" && /COUNTY APPLICATIONS/.test(l1.note), JSON.stringify(l1));
  const l2 = await learn("two", false);
  check("MUST-EXCLUDE learn: agency unknown → today's convention (the CITY row)", l2.chose === true && l2.picked === "city", JSON.stringify(l2));
  const l3 = await learn("cityOnly", false, "Marion County");
  check("MUST-EXCLUDE learn: Marion County with only the city's version offered → NOTHING clicked, a named refusal held for the pass",
    l3.chose === false && l3.picked === "" && /Marion County/.test(String(l3.refusal)), JSON.stringify(l3));
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
if (failures) { console.error(`\n${failures} agency-address-row check(s) FAILED.`); process.exit(1); }
console.log("\nAll agency-address-row checks passed (real Chromium).");
process.exit(0);
