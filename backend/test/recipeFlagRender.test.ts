// THE KEEP-AND-FLAG FLAG IS VISIBLE ON THE RECIPE ROW, AND A PERSON CLEARS IT THERE.
//
// Operator ruling 2026-09-24: a replay failure nobody can attribute keeps the recipe and FLAGS it
// for a human. The API returns flagReason/flaggedAt with every recipe and POST
// /api/portal-recipes/:id/clear-flag clears it (learnTrackGuard m4-route) — but a flag nobody can
// see is no flag (close M4-ui). This runs the SHIPPED list renderer, renderPortalRecipes, lifted
// out of frontend/dashboard.js (brace-balanced cut, as jurisdictionProposalRender.test.ts does)
// over a small fake DOM: $() hands back one element whose querySelectorAll reads the data-*
// attributes out of the innerHTML the renderer wrote. No Chromium.
//
// KILL: drop `${recipeFlagHtml(r)}` from renderPortalRecipes (or make recipeFlagHtml return "")
// → (a) and (d) fail; drop the [data-recipe-clear-flag] wiring → (d) fails.
//
//   npx tsx backend/test/recipeFlagRender.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";

const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (name: string): string => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find function ${name}`);
  let depth = 0, end = -1;
  for (let j = dashboard.indexOf("{", m.index); j < dashboard.length; j++) {
    if (dashboard[j] === "{") depth++;
    else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dashboard.slice(m.index, end);
};
const bundle = ["esc", "humanize", "recipeStepTarget", "recipeStepRowHtml", "recipeFlagHtml", "renderPortalRecipes", "loadPortalRecipes"].map(cut).join("\n\n");

type FakeButton = { attrs: Record<string, string>; disabled: boolean; handlers: Record<string, Array<() => unknown>>; getAttribute: (n: string) => string | null; addEventListener: (t: string, fn: () => unknown) => void };
type Harness = {
  el: { innerHTML: string; querySelectorAll: (sel: string) => FakeButton[] };
  apiCalls: Array<{ path: string; method: string }>;
  messages: string[];
  render: () => void;
  buttons: (attr: string) => FakeButton[];
};

function harness(recipes: unknown[], afterClear: unknown[] = [], expandedRecipeSteps: Record<string, boolean> = {}): Harness {
  const apiCalls: Array<{ path: string; method: string }> = [];
  const messages: string[] = [];
  const made = new Map<string, FakeButton[]>();
  const el = {
    innerHTML: "",
    // A fake DOM that reads what the renderer really wrote: every element carrying the attribute.
    querySelectorAll(sel: string): FakeButton[] {
      const attr = /^\[([a-z0-9-]+)\]$/.exec(sel)?.[1];
      if (!attr) return [];
      const list: FakeButton[] = [];
      for (const m of el.innerHTML.matchAll(new RegExp(`<[a-z]+\\b[^>]*\\b${attr}="([^"]*)"[^>]*>`, "g"))) {
        const attrs: Record<string, string> = { [attr]: m[1] };
        const b: FakeButton = {
          attrs, disabled: false, handlers: {},
          getAttribute: (n) => (n in attrs ? attrs[n].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null),
          addEventListener: (t, fn) => { (b.handlers[t] ||= []).push(fn); },
        };
        list.push(b);
      }
      made.set(attr, list);
      return list;
    },
  };
  let listed = recipes;
  const api = async (p: string, options: { method?: string } = {}) => {
    const method = options.method || "GET";
    apiCalls.push({ path: p, method });
    if (method === "POST" && /\/clear-flag$/.test(p)) { listed = afterClear; return { ok: true }; }
    if (p === "/api/portal-recipes") return { recipes: listed };
    return {};
  };
  const state: Record<string, unknown> = { portalRecipes: recipes, expandedRecipeSteps };
  // eslint-disable-next-line no-new-func
  const fns = new Function("state", "$", "api", "showMessage", "confirm",
    `${bundle}\nreturn { renderPortalRecipes };`,
  )(state, (id: string) => (id === "portalRecipes" ? el : null), api, (m: string) => { messages.push(m); }, () => true) as { renderPortalRecipes: () => void };
  return { el, apiCalls, messages, render: fns.renderPortalRecipes, buttons: (attr) => made.get(attr) ?? [] };
}

const recipe = (over: Record<string, unknown>) => ({
  id: "rcp-1", scopeType: "utility", utility: "Pacific Power", ahj: "", profileKey: "or|pacific power", portalPlatform: "powerclerk",
  steps: [], version: 3, status: "complete", autoSubmitEnabled: false, flagReason: "", flaggedAt: null, ...over,
});
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ");

let failures = 0;
const check = async (label: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const REASON = "A replay failed and the failure could not be attributed (Portal run errored: Cannot read properties of undefined) — kept replayable; check the run and clear this flag, or mark the recipe for re-record.";

await check("(a) MUST-PASS: a recipe with a flagReason renders the reason and a Clear flag button on its row", () => {
  const h = harness([recipe({ flagReason: REASON, flaggedAt: "2026-09-25T10:00:00Z" })]);
  h.render();
  const t = text(h.el.innerHTML);
  assert.match(t, /Flagged for review/, "the row does not say it is flagged");
  assert.ok(t.includes("could not be attributed (Portal run errored: Cannot read properties of undefined)"), `the flag's reason is not on the row: ${t.slice(0, 400)}`);
  assert.match(t, /2026-09-25/, "the row does not say when it was flagged");
  assert.equal(h.el.querySelectorAll("[data-recipe-clear-flag]").length, 1, "no Clear flag button on the flagged row");
  assert.equal(h.el.querySelectorAll("[data-recipe-clear-flag]")[0].getAttribute("data-recipe-clear-flag"), "rcp-1");
});

await check("(b) MUST-EXCLUDE: a recipe with an empty (or blank) flagReason renders neither the flag nor the button", () => {
  const h = harness([recipe({ flagReason: "" }), recipe({ id: "rcp-2", flagReason: "   " })]);
  h.render();
  assert.doesNotMatch(text(h.el.innerHTML), /Flagged for review/);
  assert.equal(h.el.querySelectorAll("[data-recipe-clear-flag]").length, 0, "an unflagged recipe got a Clear flag button");
});

await check("(c) MUST-EXCLUDE: a reason carrying markup renders as TEXT (esc), never as an element", () => {
  const h = harness([recipe({ flagReason: `<img src=x onerror="alert(1)"> "quoted" & <script>x</script>`, id: `rcp"><img src=y onerror=alert(2)>` })]);
  h.render();
  assert.doesNotMatch(h.el.innerHTML, /<img|<script/i, "the flag reason (or id) was interpolated as markup");
  assert.match(h.el.innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/, "the reason is not shown as escaped text");
});

await check("(d) the Clear flag button POSTs /api/portal-recipes/:id/clear-flag, then refetches the list — and the refetched row carries no flag", async () => {
  const h = harness([recipe({ flagReason: REASON })], [recipe({ flagReason: "", flaggedAt: null })]);
  h.render();
  const [button] = h.buttons("data-recipe-clear-flag");
  assert.ok(button, "no Clear flag button was wired");
  assert.equal((button.handlers.click || []).length, 1, "the Clear flag button has no click handler");
  await button.handlers.click[0]();
  assert.deepEqual(h.apiCalls, [
    { path: "/api/portal-recipes/rcp-1/clear-flag", method: "POST" },
    { path: "/api/portal-recipes", method: "GET" },
  ], `unexpected calls: ${JSON.stringify(h.apiCalls)}`);
  assert.doesNotMatch(text(h.el.innerHTML), /Flagged for review/, "the list was not re-rendered from the refetch");
  assert.equal(h.el.querySelectorAll("[data-recipe-clear-flag]").length, 0);
});

// (e) D3 (operator ruling 2026-09-26, "click submit when submit is clicked"): the recipe row names
// the ONE gate — a named person's approval of this run + PORTAL_ALLOW_FINAL_SUBMIT=1 + a recipe
// recorded through submit. portal_recipes.auto_submit_enabled is never consulted and the arm route
// answers 409, so a "trust this portal" checkbox could only fail: MUST-EXCLUDE it, even for a
// legacy row whose autoSubmitEnabled is still true.
// KILL: restore the <input data-recipe-trust> label, or the "trusted auto-submit only" step badge.
await check("(e) D3: a complete recipe names the per-run approval gate and offers no per-recipe trust arm (legacy arm set or not)", () => {
  const steps = [
    { action: "fill", selector: { label: "Applicant name" }, field: "applicantName" },
    { action: "stopForReview" },
    { action: "click", selector: { text: "Submit application" }, isFinalSubmit: true },
  ];
  const h = harness(
    [recipe({ steps }), recipe({ id: "rcp-legacy", autoSubmitEnabled: true, steps })],
    [],
    { "rcp-1": true, "rcp-legacy": true },
  );
  h.render();
  const html = h.el.innerHTML;
  const t = text(html);
  assert.equal(h.el.querySelectorAll("[data-recipe-trust]").length, 0, "a per-recipe trust checkbox is still rendered");
  assert.doesNotMatch(html, /type="checkbox"/, "a checkbox is still on the recipe row");
  assert.doesNotMatch(t, /Trust for one-click|trusted auto-submit|trusted this portal/i, `the row still describes a per-recipe arm: ${t.slice(0, 500)}`);
  assert.equal(h.el.querySelectorAll("[data-recipe-submit-gate]").length, 2, "each complete recipe names the submit gate");
  assert.match(t, /Approve auto-submit/, "the gate line does not name the per-run approval (Approve & auto-submit)");
  assert.match(t, /PORTAL_ALLOW_FINAL_SUBMIT=1/, "the gate line does not name the server switch");
  assert.match(t, /FINAL SUBMIT — a person, or the bot on a run you approved/, "the final-submit step badge does not name the per-run gate");
  assert.ok(!h.apiCalls.some((c) => /auto-submit/.test(c.path)), "rendering called the auto-submit arm route");
});

await check("(e) MUST-KEEP: a recipe that is not complete still says it is not replayable, with no gate line", () => {
  const h = harness([recipe({ status: "recording" })]);
  h.render();
  assert.match(text(h.el.innerHTML), /Not replayable until a complete recording is saved/);
  assert.equal(h.el.querySelectorAll("[data-recipe-submit-gate]").length, 0);
});

if (failures) {
  console.error(`\nrecipe-flag-render: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nAll recipe-flag-render tests passed.");
