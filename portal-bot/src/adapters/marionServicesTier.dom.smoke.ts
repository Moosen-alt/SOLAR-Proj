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
const pageHtml: Record<"tier" | "refused" | "nosfd" | "state", string> = {
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
  await ctx.close().catch(() => null);
  return { ms, result, boxes, coc, state, continueClicks, url };
}
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
      && /no AC \(or DC\) system size/i.test(e.result.message), say(e));
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
