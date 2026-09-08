// A RECORDED RECORD NUMBER NAMES SOMEBODY ELSE'S APPLICATION.
//
// Coos Bay's structural recipe carries `click - human-patch: 187-26-000309-STR`: a link named
// after the record the LEARN session created. That record is real, it belongs to a filing made
// months ago, and it can never appear in a new run - so the step spends its full 30s timeout
// and takes the recipe down with it, on all three attempts of the reliability sweep.
//
// The second half of this file is the one that matters. Re-anchoring to the WRONG record
// opens a stranger's filing, which is far worse than stopping - so several candidates must
// refuse, not guess.
//   npx tsx portal-bot/src/adapters/recordNumberReanchor.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const shell = (body: string): string =>
  `<!doctype html><html><head><style>body{font:14px sans-serif;padding:16px}</style></head>
   <body>${body}<div id="landed"></div></body></html>`;

// The page as it is at replay: THIS run's record, under a different number.
const ONE = shell(`<h3>Record issued</h3>
  <a href="javascript:void(0)" id="mine" onclick="document.getElementById('landed').textContent='191-26-000884-STR'">191-26-000884-STR</a>`);

// A records LIST - the operator's real, already-filed applications.
const MANY = shell(`<h3>My Records</h3>
  <a href="javascript:void(0)" onclick="document.getElementById('landed').textContent='191-26-000884-STR'">191-26-000884-STR</a><br/>
  <a href="javascript:void(0)" onclick="document.getElementById('landed').textContent='188-26-000112-STR'">188-26-000112-STR</a><br/>
  <a href="javascript:void(0)" onclick="document.getElementById('landed').textContent='205-25-000733-ELE'">205-25-000733-ELE</a>`);

const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  return r.end(q.url === "/many" ? MANY : ONE);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const recipeFor = (url: string): PortalRecipe => ({
  id: "rn1", scopeType: "ahj", profileKey: "or|city of coos bay|pacific power", state: "OR",
  ahj: "City of Coos Bay", utility: "Pacific Power", portalPlatform: "accela", portalUrl: url,
  status: "complete", version: 1,
  steps: [
    { action: "click", phase: "fill", field: "", note: "human-patch: 187-26-000309-STR",
      selector: { role: "link", name: "187-26-000309-STR" } },
  ] as unknown as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

const run = async (path: string): Promise<{ landed: string; drift: string[]; aging: string[] }> => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await context.newPage();
  const url = `http://127.0.0.1:${port}${path}`;
  await page.goto(url);
  const a2 = new RecipeAdapter(recipeFor(url), {}, {}, { autoSubmit: false });
  (a2 as unknown as { page: unknown }).page = page;
  const res = await a2.fillApplication({} as never);
  const d = (res as unknown as { data?: { driftWarnings?: string[]; agingNotes?: string[] } }).data ?? {};
  const landed = ((await page.locator("#landed").innerText().catch(() => "")) || "").trim();
  await browser.close();
  return { landed, drift: d.driftWarnings ?? [], aging: d.agingNotes ?? [] };
};

const one = await run("/");
console.log(`   one record on the page -> landed on ${JSON.stringify(one.landed)}`);

check("THE LIVE STOP: a learn-session record number re-anchors to THIS run's record",
  one.landed === "191-26-000884-STR",
  `landed on ${JSON.stringify(one.landed)} - the step timed out on a record that cannot exist`);

check("...and it says what it did, so the recipe can be re-recorded",
  one.aging.some((w) => /re-anchored/i.test(w)), JSON.stringify(one.aging));

const many = await run("/many");
console.log(`   a records LIST -> landed on ${JSON.stringify(many.landed)}`);

check("THE HALF THAT MATTERS: several records means REFUSE, never guess",
  many.landed === "",
  `it clicked into ${JSON.stringify(many.landed)} - a filing that may belong to somebody else`);

check("...and the refusal is reported, not silent",
  many.drift.some((w) => /REFUSING to guess/i.test(w)), JSON.stringify(many.drift));

server.close();
if (failures) { console.error(`\n${failures} record-number check(s) FAILED.`); process.exit(1); }
console.log("\nAll record-number re-anchor checks passed (real Chromium).");
process.exit(0);
