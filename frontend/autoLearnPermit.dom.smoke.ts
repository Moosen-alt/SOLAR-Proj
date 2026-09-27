// =================================================================================================
// AUTO-LEARN SAYS WHICH PERMIT IT IS LEARNING (agency-row item 4, production 2026-09-27).
//
// The dashboard's "Auto-learn this portal (AI)" POSTed /api/projects/:id/auto-learn with
// {scope, portalUrl} only. The route already accepts permitType ('structural' | 'electrical') and
// autoLearnPortal keys the recipe's discipline off it — so an AHJ learn from the dashboard saved a
// recipe with NO discipline, and the building track (recipeDisciplineForTrack('building') =
// 'structural') never found it. The operator's live learn for City of Jefferson (Michael Sheridan)
// would have been learned and then ignored. The learner is also handed THAT permit's issuing
// agency (item 2), which it cannot choose without knowing the permit.
//
// The control: "Permit to learn" — Building (structural) / Electrical — shown for an AHJ recording
// only, defaulting from the project's tracks; sent as permitType. Every existing id stays.
//
// NOT A COPY: defaultLearnPermitType, syncRecordPermitType and autoLearnPortalUI are lifted OUT
// of the shipped frontend/dashboard.js by brace-matching (the stageUiContract idiom) and run in a
// real browser against the shipped dashboard.html with every subresource blocked; the network
// (api) and the job poll are stubs that record what would have been sent.
//
// MUST-PASS  AHJ scope → the body carries permitType (structural by default, electrical when chosen);
//            the default follows the tracks (building → structural; electrical/mpu only → electrical);
//            the picker is hidden for a utility recording. The existing ids are all still there.
// MUST-EXCLUDE a utility (NEM) learn carries NO permitType; an operator's choice is not reset by a
//            re-sync for the same project.
//
// Discovered from disk by scripts/run-dom-smokes.ts. Alone: npx tsx frontend/autoLearnPermit.dom.smoke.ts
// =================================================================================================
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const read = (f: string): string => fs.readFileSync(path.join(FRONTEND, f), "utf8").replace(/\r\n/g, "\n");
const dashboardJs = read("dashboard.js");
const dashboardHtml = read("dashboard.html");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? `\n         ${detail}` : ""}`); }
};
function cut(name: string): string {
  const at = dashboardJs.search(new RegExp(`(?:async\\s+)?function ${name}\\(`));
  if (at < 0) throw new Error(`${name} is gone from dashboard.js — re-point this smoke`);
  const openAt = at + dashboardJs.slice(at).indexOf("{");
  let depth = 0;
  for (let j = openAt; j < dashboardJs.length; j++) {
    if (dashboardJs[j] === "{") depth++;
    else if (dashboardJs[j] === "}" && --depth === 0) return dashboardJs.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await ctx.newPage();
await page.route("**/*", (route: { abort(): Promise<void> }) => route.abort());
await page.setContent(dashboardHtml, { waitUntil: "domcontentloaded" });

try {
  const ids = await page.evaluate(() => ["recordScope", "recordPortalUrl", "autoLearnBtn", "autoLearnStatus", "launchRecordBtn", "recordPermitType", "recordPermitWrap"]
    .map((id) => [id, Boolean(document.getElementById(id))]));
  const missing = (ids as Array<[string, boolean]>).filter(([, ok]) => !ok).map(([id]) => id);
  check("the Record/Auto-learn section keeps every existing id and adds the permit picker", missing.length === 0, `missing: ${missing.join(", ")}`);
  const options = await page.evaluate(() => Array.from((document.getElementById("recordPermitType") as HTMLSelectElement | null)?.options ?? []).map((o) => [o.value, o.textContent?.trim()]));
  check("the picker offers Building (structural) and Electrical, valued as the route's permitType",
    JSON.stringify(options) === JSON.stringify([["structural", "Building (structural)"], ["electrical", "Electrical"], ["", "Whole permit (combined)"]]), JSON.stringify(options));

  const bundle = [cut("defaultLearnPermitType"), cut("syncRecordPermitType"), cut("autoLearnPortalUI")].join("\n\n");
  type Probe = { body: Record<string, unknown> | null; url: string; hidden: boolean; value: string; confirmText: string };
  const run = (o: { scope: "ahj" | "utility"; tracks: Array<{ type: string }>; choose?: string; projectId?: string; resync?: boolean }): Promise<Probe> =>
    page.evaluate(async ([src, opts]: [string, typeof o]) => {
      const w = window as unknown as Record<string, unknown>;
      const $ = (id: string) => document.getElementById(id);
      const sent: { url: string; body: Record<string, unknown> | null } = { url: "", body: null };
      let confirmText = "";
      const st = { detail: { project: { id: opts.projectId ?? "p1", ahj: "City of Jefferson", utility: "Pacific Power" } }, selectedProjectId: opts.projectId ?? "p1", submittalTracks: opts.tracks };
      const scope = $("recordScope") as HTMLSelectElement;
      scope.value = opts.scope;
      ($("recordPortalUrl") as HTMLInputElement).value = "https://aca-oregon.accela.com/oregon/";
      const fns = new Function("$", "state", "api", "waitForStagingJob", "confirm", "showMessage", "renderAutoLearnProgress", "stopAutoLearnProgress", "setAutoLearnBar", "appendDebugBundleLink", "loadKnowledgeBase", "selectProject",
        `${src}\nreturn { syncRecordPermitType, autoLearnPortalUI };`)(
        $, st,
        async (url: string, init: { body?: string }) => { sent.url = url; sent.body = init?.body ? JSON.parse(init.body) : null; return { jobId: "job-1" }; },
        async () => ({ status: "done", result: { status: "trusted", verification: { confidence: "high" }, pageCount: 3 } }),
        (text: string) => { confirmText = text; return true; },
        () => undefined, () => undefined, () => undefined, () => undefined, () => undefined,
        async () => undefined, async () => undefined,
      ) as { syncRecordPermitType: () => void; autoLearnPortalUI: () => Promise<void> };
      w.__agencyRowFns = fns;
      fns.syncRecordPermitType();
      const sel = $("recordPermitType") as HTMLSelectElement;
      // The operator's pick, through the listener syncRecordPermitType itself installs.
      if (opts.choose) { sel.value = opts.choose; sel.dispatchEvent(new Event("change")); }
      if (opts.resync) fns.syncRecordPermitType();
      await fns.autoLearnPortalUI();
      return { body: sent.body, url: sent.url, hidden: Boolean(($("recordPermitWrap") as HTMLElement).hidden), value: sel.value, confirmText };
    }, [bundle, o] as [string, typeof o]);

  const a = await run({ scope: "ahj", tracks: [{ type: "building" }, { type: "electrical" }, { type: "nem" }] });
  check("MUST-PASS: an AHJ learn POSTs permitType — structural by default when the project has a building track",
    a.url === "/api/projects/p1/auto-learn" && a.body?.permitType === "structural" && a.body?.scope === "ahj", JSON.stringify(a));
  check("MUST-PASS: the confirmation names the permit being learned", /building \(structural\) permit/i.test(a.confirmText), a.confirmText.slice(0, 160));
  const b = await run({ scope: "ahj", tracks: [{ type: "electrical" }, { type: "nem" }] });
  check("MUST-PASS: a project whose only permit track is electrical defaults to Electrical", b.body?.permitType === "electrical" && b.value === "electrical", JSON.stringify(b));
  const m = await run({ scope: "ahj", tracks: [{ type: "mpu" }] });
  check("MUST-PASS: a panel-upgrade-only project defaults to Electrical", m.body?.permitType === "electrical", JSON.stringify(m));
  const c = await run({ scope: "ahj", tracks: [{ type: "building" }, { type: "electrical" }], choose: "electrical", projectId: "p2" });
  check("MUST-PASS: the operator's choice is what is sent", c.body?.permitType === "electrical", JSON.stringify(c));
  const r = await run({ scope: "ahj", tracks: [{ type: "building" }], choose: "electrical", projectId: "p3", resync: true });
  check("MUST-EXCLUDE: a re-sync for the same project does not reset the operator's choice", r.body?.permitType === "electrical", JSON.stringify(r));
  const d = await run({ scope: "ahj", tracks: [], projectId: "p4" });
  check("MUST-PASS: no tracks loaded → the whole-permit learn sends NO permitType (every track finds the recipe)", Boolean(d.body) && !("permitType" in (d.body ?? {})) && d.value === "", JSON.stringify(d));
  // agency-row skeptic MF: a COMBO-track project defaulted to "structural" and saved a recipe the combo
  // track (discipline combo or "") never finds. It sends no permitType now.
  const cb = await run({ scope: "ahj", tracks: [{ type: "combo" }, { type: "nem" }], projectId: "p6" });
  check("MUST-EXCLUDE: a combo-track project never defaults to a split discipline — no permitType sent", Boolean(cb.body) && !("permitType" in (cb.body ?? {})) && cb.value === "", JSON.stringify(cb));
  check("MUST-PASS: the whole-permit confirmation does not name a split permit", !/building (structural) permit|electrical permit/i.test(cb.confirmText), cb.confirmText.slice(0, 160));
  const u = await run({ scope: "utility", tracks: [{ type: "building" }, { type: "nem" }], projectId: "p5" });
  check("MUST-EXCLUDE: a utility (NEM) learn sends NO permitType", Boolean(u.body) && !("permitType" in (u.body ?? {})) && u.body?.scope === "utility", JSON.stringify(u));
  check("MUST-PASS: the permit picker is hidden for a utility recording, shown for an AHJ one", u.hidden === true && a.hidden === false, `utility hidden=${u.hidden} ahj hidden=${a.hidden}`);
} finally {
  await browser.close();
}
if (failures) { console.error(`\n${failures} auto-learn permit check(s) FAILED.`); process.exit(1); }
console.log("\nAll auto-learn permit checks passed (real Chromium, shipped dashboard.html + dashboard.js functions).");
process.exit(0);
