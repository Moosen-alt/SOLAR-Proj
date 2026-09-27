// THE kVA TIER IS DECIDED FROM THE PAGE, AND THE PORTAL'S OWN WORDS ARE READ — on the REAL captured
// Marion County services page (Oregon ePermitting, live run 99baa5d0, 2026-09-27, sanitized).
//
// What happened live: the City of Coos Bay electrical recipe was borrowed onto Marion County's
// "RESIDENTIAL - ELECTRICAL COMPREHENSIVE" services page for a 12.913 kVA job. No Marion fee
// schedule is on file, so no tier key was computed and R6 left the recorded "5.01kva through 15kva"
// box BLANK; the run clicked Continue into "An error has occurred. Please select at least 1
// electrical service for purchase" and reported "The portal gave no visible reason". Two
// failures: the tier was decidable from the page's own labels, and the banner was on the page.
//
// Fixtures: fixtures/marionServices/services.html (the page before the Continue, step042) and
// services-refused.html (the page after the refused Continue, step045, banner present). Scripts
// removed at capture, so a Continue click never moves the page — which is exactly the refused
// advance the live run met. Every off-box request is aborted (no walkme, no fonts, no portal).
//
// MUST-PASS (F1) 12.913 kVA → "5.01kva through 15kva" = 1, every other tier box empty; 4.55 → "5kva
//   or less"; 20 → "15.01kva through 25kva" (the RECORDED box stays empty); 30 → "solar generation
//   over 25 kva (enter total # of kva)" gets "30", the WIND boxes untouched.
// MUST-EXCLUDE (F1) no AC size on the project → no tier box typed, the Continue NEVER clicked, the
//   run pauses (pauseReason fee_tier_undecided) with a named reason; a stored schedule that
//   disagrees with the page → the same pause, nothing typed.
// MUST-PASS (F2) the refused page's banner reaches the failure: 'The portal says: Please select at
//   least 1 electrical service for purchase'. MUST-EXCLUDE (F2) the page without a banner still
//   reads "no visible reason".
// MUST-PASS (F5) "1-1 or 2 Family Dwelling" (R5's Coos vocabulary) lands on Marion's "Single Family
//   Dwelling" by meaning, no LLM. MUST-EXCLUDE (F5) with that option removed the select lands
//   NOTHING — never Two Family / Manufactured / Townhouses / Small Home / Detached Accessory.
// F4: the seconds each scenario spends are printed (the live select miss took 44 s).
//
// Run: npx tsx portal-bot/src/adapters/marionServicesTier.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { RecipeAdapter } from "./recipeAdapter";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { FEE_TIER_RATING_FIELD } from "../feeBracketQuantity";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures", "marionServices");
const tierHtml = fs.readFileSync(path.join(FIX, "services.html"), "utf8");
// SYNTHETIC SHAPES the captured page does not cover (the close skeptic's shapes.ts, live-run-jefferson-v):
// tier labels printed in kW, a single un-tiered "Renewable energy" box, the tier as a <select>.
const SP = "ctl00_PlaceHolderMain_AppSpecXEdit_OTHER_CO";
const synth = (body: string): string => `<!doctype html><html><head><title>BuildingPermits.Test.gov</title></head><body>
  <h2>Application Detail</h2>
  <label for="${SP}_ddl_0_0">Category of Construction:</label> <select id="${SP}_ddl_0_0"><option>--Select--</option><option>Single Family Dwelling</option><option>Other</option></select>
  ${body}
  <label for="${SP}_txt_1_2">Additional Comments:</label> <input id="${SP}_txt_1_2" type="text">
  <a id="ctl00_PlaceHolderMain_actionBarBottom_btnContinue" href="javascript:void(0)"><span>Continue Application »</span></a></body></html>`;
const pageHtml: Record<"tier" | "refused" | "nosfd" | "state" | "kw" | "single" | "tierselect" | "unlabelled", string> = {
  kw: synth(`<label for="${SP}_txt_0_26">Solar PV system 5 kW or less:</label> <input id="${SP}_txt_0_26" type="text">
    <label for="${SP}_txt_0_27">Solar PV system 5.01 kW through 15 kW:</label> <input id="${SP}_txt_0_27" type="text">
    <label for="${SP}_txt_0_28">Solar PV system 15.01 kW through 25 kW:</label> <input id="${SP}_txt_0_28" type="text">`),
  single: synth(`<label for="${SP}_txt_0_27">Renewable energy systems (solar):</label> <input id="${SP}_txt_0_27" type="text">`),
  // A box the page-reader cannot label (no unit in its text, no label[for]) — an OWN recipe whose
  // stored schedule keyed it still types through its recorded selector: no false stop.
  unlabelled: synth(`<span>Solar 5.01 to 15:</span> <input id="${SP}_txt_0_27" type="text">`),
  tierselect: synth(`<label for="${SP}_ddl_0_9">Renewable energy for electrical systems:</label> <select id="${SP}_ddl_0_9"><option>--Select--</option><option>5kva or less</option><option>5.01kva through 15kva</option><option>15.01kva through 25kva</option></select>`),
  tier: tierHtml,
  refused: fs.readFileSync(path.join(FIX, "services-refused.html"), "utf8"),
  // The SAME page with Marion's "Single Family Dwelling" option removed — the by-meaning match must
  // then land nothing, not a neighbour.
  nosfd: tierHtml.replace(/<option[^>]*>\s*Single Family Dwelling\s*<\/option>/i, ""),
  // A select whose recorded value is an option's VALUE attribute, not its text (Accela's contact
  // dialog state list: <option value="TX">Texas</option>, the step bound to the 2-letter code).
  // The native-select precheck must read values as well as texts, or "TX" is a "known negative".
  state: `<!doctype html><html><head><title>State select</title></head><body>
    <label for="st">State:</label> <select id="st"><option value="">--Select--</option><option value="OR">Oregon</option><option value="TX">Texas</option><option value="NM">New Mexico</option></select>
    <a id="ctl00_PlaceHolderMain_actionBarBottom_btnContinue" href="javascript:void(0)"><span>Continue Application »</span></a></body></html>`,
};
if (pageHtml.nosfd === pageHtml.tier) throw new Error("fixture: the Single Family Dwelling option was not found to remove");

const P = "ctl00_PlaceHolderMain_AppSpec1CAA1E64Edit_MARION_CO";
const BOX = { le5: `${P}_txt_0_26`, t5_15: `${P}_txt_0_27`, t15_25: `${P}_txt_0_28`, wind25_50: `${P}_txt_0_29`, wind50_100: `${P}_txt_0_30`, over25: `${P}_txt_0_31` } as const;
const COC = `${P}_ddl_0_0`;
const TIER_LABEL = "Renewable energy for electrical systems- 5.01kva through 15kva:";
const TIER_KEY = "feeBracketQuantity:5.01-15";

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const variant = ((req.headers.cookie || "").match(/v=(\w+)/)?.[1] || "tier") as keyof typeof pageHtml;
  if (/\/Cap\/CapEdit\.aspx$/i.test(url.pathname)) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(pageHtml[variant] ?? pageHtml.tier); return; }
  res.writeHead(404, { "content-type": "text/plain" }); res.end("not found");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const ENTRY = `${base}/oregon/Cap/CapEdit.aspx?stepNumber=3&pageNumber=1&currentStep=1&currentPage=0&Module=Building`;

// The borrowed recipe's segment for this page, as bindRecipeForReplay hands it to the adapter: the
// R5 vocabulary rewrite gives Category of Construction the Coos recipe's own structure wording, the
// tier box is bound to its numeric key with the recorded literal kept, the advance is the recorded
// Continue Application. (The Coos control-id fallbacks are what R4 strips; left off here.)
const steps: RecipeStep[] = [
  { action: "goto", value: ENTRY, note: "entry url" },
  { action: "select", selector: { label: "Category of Construction:" }, note: "Category of Construction:", value: "1-1 or 2 Family Dwelling" },
  { action: "select", selector: { label: "Type of Work:" }, note: "Type of Work:", value: "Alteration" },
  { action: "select", selector: { label: "Project includes any of the following:" }, note: "Project includes any of the following:", value: "01-Not Applicable" },
  { action: "fill", selector: { label: TIER_LABEL }, note: TIER_LABEL, field: TIER_KEY, value: "1" },
  { action: "click", selector: { role: "link", name: "Continue Application »", exact: true, fallbacks: [{ css: "#ctl00_PlaceHolderMain_actionBarBottom_btnContinue" }] }, note: "advance: Continue Application »" },
  { action: "stopForReview" } as RecipeStep,
];
const recipe = {
  id: "marion-smoke", scopeType: "ahj", profileKey: "or|city of coos bay|pacific power", state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
  portalPlatform: "accela", portalUrl: `${base}/oregon/`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "", discipline: "electrical", steps,
} as unknown as PortalRecipe;

interface Scenario {
  name: string;
  variant: keyof typeof pageHtml;
  fieldValues: Record<string, string>;
}
interface Outcome {
  ms: number;
  result: { ok: boolean; message: string; pauseReason?: string; data?: Record<string, unknown> };
  boxes: Record<string, string>;
  coc: string;
  state: string;
  continueClicks: number;
  url: string;
  /** Every text box and select on the page (synthetic shapes), by id: value / selected text. */
  all: Record<string, string>;
}

const browser = await chromium.launch();
async function run(s: Scenario, useRecipe: PortalRecipe = recipe): Promise<Outcome> {
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(8000);
  await ctx.route("**/*", (route) => (/^https?:\/\/127\.0\.0\.1:/.test(route.request().url()) ? route.continue() : route.abort()));
  await ctx.addCookies([{ name: "v", value: s.variant, url: base }]);
  await ctx.addInitScript({ content: `globalThis.__name = globalThis.__name || ((f) => f);
    document.addEventListener("click", (e) => { const a = e.target && e.target.closest ? e.target.closest("a") : null; if (a && /btnContinue/.test(a.id || "")) { const n = Number(sessionStorage.getItem("cc") || "0") + 1; sessionStorage.setItem("cc", String(n)); } }, true);` });
  const page: Page = await ctx.newPage();
  await page.goto(ENTRY);
  const adapter = new RecipeAdapter(useRecipe, { __replayBlank: "", ...s.fieldValues }, {}, {});
  (adapter as unknown as { page: unknown }).page = page;
  const t0 = Date.now();
  let result: Outcome["result"];
  try { result = await adapter.fillApplication({ systemSizeAcKw: 12.913 } as ProjectRecord) as Outcome["result"]; }
  catch (e) { result = { ok: false, message: `threw ${String(e).slice(0, 300)}` }; }
  const ms = Date.now() - t0;
  const boxes = await page.evaluate((ids: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const [k, id] of Object.entries(ids)) out[k] = (document.getElementById(id) as HTMLInputElement | null)?.value ?? "(missing)";
    return out;
  }, BOX as unknown as Record<string, string>).catch(() => ({} as Record<string, string>));
  const selText = (id: string) => page.evaluate((sid: string) => { const s = document.getElementById(sid) as HTMLSelectElement | null; return s ? (s.options[s.selectedIndex]?.textContent || "").trim() : "(missing)"; }, id).catch(() => "(unreadable)");
  const coc = await selText(COC);
  const state = await selText("st");
  const continueClicks = await page.evaluate(() => Number(sessionStorage.getItem("cc") || "0")).catch(() => -1);
  const url = page.url();
  const all = await page.evaluate((prefix: string) => {
    const out: Record<string, string> = {};
    for (const el of Array.from(document.querySelectorAll("input[type=text], select")) as Array<HTMLInputElement | HTMLSelectElement>) {
      if (!el.id || !el.id.startsWith(prefix) || /txt_1_2|ddl_0_0$/.test(el.id)) continue;
      out[el.id.slice(prefix.length + 1)] = el.tagName === "SELECT" ? ((el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex]?.textContent || "").trim() : (el as HTMLInputElement).value;
    }
    return out;
  }, SP).catch(() => ({} as Record<string, string>));
  await ctx.close().catch(() => null);
  return { ms, result, boxes, coc, state, continueClicks, url, all };
}
/** A recipe for a synthetic shape: the borrowed services segment with the given tier step. */
const shapeRecipe = (id: string, tierStep: RecipeStep): PortalRecipe => ({
  ...recipe, id,
  steps: [
    { action: "goto", value: ENTRY, note: "entry url" },
    { action: "select", selector: { label: "Category of Construction:" }, note: "Category of Construction:", value: "Single Family Dwelling" },
    tierStep,
    { action: "click", selector: { role: "link", name: "Continue Application »", exact: true, fallbacks: [{ css: "#ctl00_PlaceHolderMain_actionBarBottom_btnContinue" }] }, note: "advance: Continue Application »" },
    { action: "stopForReview" } as RecipeStep,
  ],
} as unknown as PortalRecipe);
const KW_LABEL = "Solar PV system 5.01 kW through 15 kW:";
const sayAll = (o: Outcome): string => `ms=${o.ms} ok=${String(o.result.ok)} pause=${String(o.result.pauseReason)} clicks=${o.continueClicks} all=${JSON.stringify(o.all)} msg=${o.result.message.slice(0, 300)} drift=${JSON.stringify((o.result.data?.driftWarnings as string[] | undefined)?.slice(0, 4))}`;
const emptyExcept = (boxes: Record<string, string>, keep: string[]): boolean => Object.entries(boxes).every(([k, v]) => keep.includes(k) ? true : v === "");
const say = (o: Outcome): string => `ms=${o.ms} ok=${String(o.result.ok)} pause=${String(o.result.pauseReason)} clicks=${o.continueClicks} boxes=${JSON.stringify(o.boxes)} coc=${JSON.stringify(o.coc)} msg=${o.result.message.slice(0, 260)} drift=${JSON.stringify((o.result.data?.driftWarnings as string[] | undefined)?.slice(0, 6))}`;

const RATING = { [FEE_TIER_RATING_FIELD]: "12.913" };
try {
  // ── F1 MUST-PASS: the live job ────────────────────────────────────────────────────────────
  const a = await run({ name: "12.913 kVA", variant: "tier", fieldValues: { ...RATING, [TIER_KEY]: "" } });
  console.log(`  [timing] 12.913 kVA scenario: ${a.ms} ms; slowSteps=${JSON.stringify(a.result.data?.slowSteps ?? [])}`);
  check("MUST-PASS F1: 12.913 kVA → \"5.01kva through 15kva\" reads 1 and every other tier box is empty (wind untouched)",
    a.boxes.t5_15 === "1" && emptyExcept(a.boxes, ["t5_15"]), say(a));
  check("MUST-PASS F1: the run went on to the Continue (the tier was decided, not paused)", a.continueClicks >= 1 && !a.result.pauseReason, say(a));
  check("MUST-PASS F5: \"1-1 or 2 Family Dwelling\" landed Marion's \"Single Family Dwelling\" by meaning", a.coc === "Single Family Dwelling", say(a));
  check("MUST-EXCLUDE F2: the page without a banner still reads \"no visible reason\"",
    /no visible reason/i.test(a.result.message) && !/The portal says/i.test(a.result.message), say(a));
  check("F1: the report says the tier was read from the page", JSON.stringify(a.result.data ?? {}).includes("tier") && /5\.01kva through 15kva/i.test(JSON.stringify(a.result.data ?? {})), say(a));

  // ── F1 MUST-PASS: other sizes on the same page ───────────────────────────────────────────
  const b = await run({ name: "4.55 kVA", variant: "tier", fieldValues: { [FEE_TIER_RATING_FIELD]: "4.55", [TIER_KEY]: "" } });
  check("MUST-PASS F1: 4.55 kVA → \"5kva or less\" = 1, the recorded 5.01–15 box empty", b.boxes.le5 === "1" && emptyExcept(b.boxes, ["le5"]) && b.continueClicks >= 1, say(b));
  const c = await run({ name: "20 kVA", variant: "tier", fieldValues: { [FEE_TIER_RATING_FIELD]: "20", [TIER_KEY]: "" } });
  check("MUST-PASS F1: 20 kVA → \"15.01kva through 25kva\" = 1, the recorded 5.01–15 box empty", c.boxes.t15_25 === "1" && emptyExcept(c.boxes, ["t15_25"]) && c.continueClicks >= 1, say(c));
  const d = await run({ name: "30 kVA", variant: "tier", fieldValues: { [FEE_TIER_RATING_FIELD]: "30", [TIER_KEY]: "" } });
  check("MUST-PASS F1: 30 kVA → \"solar generation over 25 kva (enter total # of kva)\" gets 30; the WIND 25.01–50 box stays empty",
    d.boxes.over25 === "30" && d.boxes.wind25_50 === "" && emptyExcept(d.boxes, ["over25"]) && d.continueClicks >= 1, say(d));

  // ── F1 MUST-EXCLUDE: no rating, and a disagreeing schedule ───────────────────────────────
  const e = await run({ name: "no rating", variant: "tier", fieldValues: { [FEE_TIER_RATING_FIELD]: "", [TIER_KEY]: "" } });
  console.log(`  [timing] no-rating scenario: ${e.ms} ms`);
  check("MUST-EXCLUDE F1: no AC size → NO tier box typed", emptyExcept(e.boxes, []), say(e));
  check("MUST-EXCLUDE F1: the Continue was NEVER clicked (0 clicks, URL unchanged)", e.continueClicks === 0 && e.url.startsWith(ENTRY.slice(0, 40)), say(e));
  check("MUST-EXCLUDE F1: the run PAUSES for a person (pauseReason fee_tier_undecided) with the named reason",
    e.result.pauseReason === "fee_tier_undecided" && e.result.ok === false
      && /electrical services page needs one service line ticked and the kVA tier could not be decided/i.test(e.result.message)
      && /no AC \(inverter\) rating/i.test(e.result.message), say(e));

  // ── MF1 (close) MUST-EXCLUDE: AC absent, DC present → the tier is NOT decided on DC ──────
  // The backend emits the AC rating only (feeTierRatingKw "") and the DC size beside it
  // (feeTierDcKw) for the wording. On THIS project (12.913 AC / 15.91 DC) a DC-decided tier is
  // "15.01kva through 25kva" — an over-billed permit, no pause.
  const dc = await run({ name: "AC absent, DC 15.91", variant: "tier", fieldValues: { [FEE_TIER_RATING_FIELD]: "", feeTierDcKw: "15.91", [TIER_KEY]: "" } });
  check("MUST-EXCLUDE MF1: AC absent / DC 15.91 → NO tier box typed (never '15.01kva through 25kva' by DC)", emptyExcept(dc.boxes, []), say(dc));
  check("MUST-EXCLUDE MF1: ...the Continue was NEVER clicked", dc.continueClicks === 0, say(dc));
  check("MUST-EXCLUDE MF1: ...paused fee_tier_undecided, and the reason names the missing AC and the DC size",
    dc.result.pauseReason === "fee_tier_undecided"
      && /the kVA tier could not be decided: the project has no AC \(inverter\) rating; DC is 15\.91 kW — confirm the AC size/.test(dc.result.message), say(dc));

  // ── MF3 (close) MUST-PASS: tier labels printed in kW are read like kVA ─────────────────────
  const kwPost = await run({ name: "kW labels, literal", variant: "kw", fieldValues: { [FEE_TIER_RATING_FIELD]: "20" } },
    shapeRecipe("kw-post", { action: "fill", selector: { label: KW_LABEL }, note: KW_LABEL, value: "1" }));
  check("MUST-PASS MF3: kW-labelled tiers, 20 kVA (recipe with the literal '1', no key) → '15.01 kW through 25 kW' = 1, the others empty, Continue reached",
    kwPost.all.txt_0_28 === "1" && kwPost.all.txt_0_26 === "" && kwPost.all.txt_0_27 === "" && kwPost.continueClicks >= 1 && !kwPost.result.pauseReason, sayAll(kwPost));
  const kwKeyed = await run({ name: "kW labels, keyed", variant: "kw", fieldValues: { [FEE_TIER_RATING_FIELD]: "20", [TIER_KEY]: "" } },
    shapeRecipe("kw-keyed", { action: "fill", selector: { label: KW_LABEL }, note: KW_LABEL, field: TIER_KEY, value: "1" }));
  check("MUST-PASS MF3: kW-labelled tiers, 20 kVA (recipe keyed 5.01-15, R6 blank) → '15.01 kW through 25 kW' = 1",
    kwKeyed.all.txt_0_28 === "1" && kwKeyed.all.txt_0_27 === "" && kwKeyed.continueClicks >= 1 && !kwKeyed.result.pauseReason, sayAll(kwKeyed));

  // ── MF2 (close) MUST-EXCLUDE: a recorded tier step that finds no tier box never clicks on ───
  const tierStep: RecipeStep = { action: "fill", selector: { label: TIER_LABEL }, note: TIER_LABEL, field: TIER_KEY, value: "1" };
  for (const [variant, what] of [["single", "a single un-tiered 'Renewable energy systems (solar)' box"], ["tierselect", "the tier as a <select>"]] as const) {
    const o = await run({ name: variant, variant, fieldValues: { ...RATING, [TIER_KEY]: "" } }, shapeRecipe(`shape-${variant}`, tierStep));
    check(`MUST-EXCLUDE MF2: ${what} → nothing typed or selected (never a guessed "1")`,
      Object.values(o.all).every((v) => v === "" || v === "--Select--"), sayAll(o));
    check(`MUST-EXCLUDE MF2: ${what} → the Continue was NEVER clicked, paused fee_tier_undecided with the no-box reason`,
      o.continueClicks === 0 && o.result.pauseReason === "fee_tier_undecided"
        && /the recorded kVA tier box was not found on this page and no kVA-labelled box could be read/.test(o.result.message), sayAll(o));
  }
  // MUST-PASS (no false stop): the provisional stop is withdrawn when the recorded box types the
  // stored schedule's real quantity.
  const own = await run({ name: "own recipe, unlabelled box, schedule 1", variant: "unlabelled", fieldValues: { ...RATING, [TIER_KEY]: "1" } },
    shapeRecipe("own-unlabelled", { action: "fill", selector: { label: TIER_LABEL, fallbacks: [{ css: `#${SP}_txt_0_27` }] }, note: TIER_LABEL, field: TIER_KEY, value: "1" }));
  check("MUST-PASS MF2: an own recipe whose schedule keyed the recorded box types it through its selector and goes on — no false stop",
    own.all.txt_0_27 === "1" && own.continueClicks >= 1 && own.result.pauseReason !== "fee_tier_undecided", sayAll(own));
  // MUST-EXCLUDE (live-run-jefferson-close skeptic MF1, shape A): the SAME own recipe on a project
  // with NO AC rating — the stored schedule's evaluator fell back to DC and put its "1" on this
  // key. The recorded box must not be typed on DC: nothing typed, Continue never clicked, the AC pause.
  const ownDc = await run({ name: "own recipe, unlabelled box, AC absent, schedule on DC", variant: "unlabelled", fieldValues: { [FEE_TIER_RATING_FIELD]: "", feeTierDcKw: "15.91", [TIER_KEY]: "1" } },
    shapeRecipe("own-unlabelled-dc", { action: "fill", selector: { label: TIER_LABEL, fallbacks: [{ css: `#${SP}_txt_0_27` }] }, note: TIER_LABEL, field: TIER_KEY, value: "1" }));
  check("MUST-EXCLUDE MF1 (no-box path): AC absent, a DC-evaluated schedule '1' on the recorded box → nothing typed, the Continue NEVER clicked, paused with the AC wording",
    ownDc.all.txt_0_27 === "" && ownDc.continueClicks === 0 && ownDc.result.pauseReason === "fee_tier_undecided"
      && /the project has no AC \(inverter\) rating; DC is 15\.91 kW — confirm the AC size/.test(ownDc.result.message), sayAll(ownDc));
  const f = await run({ name: "schedule disagrees", variant: "tier", fieldValues: { ...RATING, "feeBracketQuantity:15.01-25": "1", [TIER_KEY]: "0", "feeBracketQuantity:-5": "0" } });
  check("MUST-EXCLUDE F1: a stored schedule that puts 12.913 kVA in another tier → nothing typed, Continue never clicked, paused",
    emptyExcept(f.boxes, []) && f.continueClicks === 0 && f.result.pauseReason === "fee_tier_undecided" && /stored fee schedule/i.test(f.result.message), say(f));
  const g = await run({ name: "schedule agrees", variant: "tier", fieldValues: { ...RATING, [TIER_KEY]: "1", "feeBracketQuantity:15.01-25": "0", "feeBracketQuantity:-5": "0" } });
  check("F1: a stored schedule that AGREES with the page ticks the same box", g.boxes.t5_15 === "1" && g.continueClicks >= 1 && !g.result.pauseReason, say(g));

  // ── F2 MUST-PASS: the refused page's banner is read ──────────────────────────────────────
  const h = await run({ name: "refused page", variant: "refused", fieldValues: { ...RATING, [TIER_KEY]: "" } });
  console.log(`  [timing] refused-page scenario: ${h.ms} ms`);
  check("MUST-PASS F2: the failure carries the portal's own words — 'Please select at least 1 electrical service for purchase'",
    /The portal says:.*Please select at least 1 electrical service for purchase/i.test(h.result.message) && !/no visible reason/i.test(h.result.message), say(h));
  check("  ...without the generic 'An error has occurred.' heading standing in for the message", !/The portal says: An error has occurred\.\s*\|/.test(h.result.message), say(h));

  // ── F5 MUST-EXCLUDE: no single-family option on the list ────────────────────────────────
  const i = await run({ name: "no SFD option", variant: "nosfd", fieldValues: { ...RATING, [TIER_KEY]: "" } });
  console.log(`  [timing] no-SFD-option scenario (the select miss): ${i.ms} ms; slowSteps=${JSON.stringify(i.result.data?.slowSteps ?? [])}`);
  check("MUST-EXCLUDE F5: with \"Single Family Dwelling\" gone the select lands NOTHING — never Two Family / Manufactured / Townhouses / Small Home / Detached Accessory",
    i.coc === "--Select--" || i.coc === "", say(i));
  check("  ...and the miss is reported, not silent", ((i.result.data?.driftWarnings as string[] | undefined) ?? []).some((w) => /Category of Construction/.test(w) && /landed nothing/.test(w)), say(i));
  check("F4: the select miss no longer costs the live 44 s (under 15 s on the captured page)", i.ms < 15000, `ms=${i.ms}`);

  // ── F4/F5 MUST-PASS: a value-attribute match is not a "known negative" ───────────────────
  const stateRecipe = {
    ...recipe, id: "marion-smoke-state",
    steps: [
      { action: "goto", value: ENTRY, note: "entry url" },
      { action: "select", selector: { label: "State:" }, note: "contact: state [applicant]", value: "TX" },
      { action: "click", selector: { role: "link", name: "Continue Application »", exact: true }, note: "advance: Continue Application »" },
      { action: "stopForReview" } as RecipeStep,
    ],
  } as unknown as PortalRecipe;
  const j = await run({ name: "state by value", variant: "state", fieldValues: {} }, stateRecipe);
  check("MUST-PASS F4/F5: a select bound to an option's VALUE attribute (\"TX\" → <option value=\"TX\">Texas</option>) still lands — never a known negative",
    j.state === "Texas", say(j));
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} marion-services-tier check(s) FAILED.`); process.exit(1); }
console.log("\nAll marion-services-tier checks passed (real Chromium, captured Marion County page).");
process.exit(0);
