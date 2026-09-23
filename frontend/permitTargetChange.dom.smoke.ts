// =================================================================================================
// PICKING ANOTHER FILING RE-FILLS THE PERMIT FORM'S NUMBERS — a real `change` event, real Chromium.
//
// The permit monitor's "Filing this status is about" selector (#permitStatusTarget) decides which
// filing a pasted status is recorded against. The form's application / permit number fields must
// follow it: a leftover number is ANOTHER filing's, and recordPermitStatus posts it with the
// selected filing's check (the server keeps a posted number over the target's own). The refill is
// one top-level line in dashboard.js:
//
//     $("permitStatusTarget")?.addEventListener("change", syncPermitForm);
//
// Nothing failed when that line was deleted: submitSeam's 10l13 calls syncPermitForm() by hand,
// which proves the function and not the binding. This smoke proves the binding.
//
// HOW. dashboard.js is a type="module" script, so its `state` is unreachable from the page and a
// full boot needs a project-detail API surface eight loaders deep. Instead — the stageUiContract
// idiom — the SHIPPED dashboard.html is loaded with every subresource blocked, and the real
// functions (syncPermitForm, renderPermitStatusTargetPicker, permitStatusTargetId,
// permitTargetOptionLabel, esc) plus the REAL registration statement are lifted out of
// frontend/dashboard.js and run in the page. Then Playwright picks an option the way a person
// does, which fires a genuine `change` event.
//
//   MUST PASS    — picking the second filing puts ITS application + permit numbers in the form.
//   MUST PASS    — picking the first again replaces them (the first has no permit number: blank,
//                  never the second's left behind).
//   MUST EXCLUDE — control: the same page WITHOUT the registration line leaves the numbers
//                  unchanged on a pick (so the MUST PASS above is the binding, not the harness).
//
// Discovered from disk by scripts/run-dom-smokes.ts: `npm run portal:test:dom`.
// Alone: `npx tsx frontend/permitTargetChange.dom.smoke.ts`
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

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  PASS  ${label}`);
  else { failures.push(detail ? `${label} — ${detail}` : label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

function cut(name: string): string {
  const at = dashboardJs.indexOf(`\nfunction ${name}(`);
  if (at < 0) throw new Error(`${name} is gone from dashboard.js — re-point this smoke`);
  const open = dashboardJs.indexOf("{", dashboardJs.indexOf(")", at));
  let depth = 0;
  for (let j = open; j < dashboardJs.length; j++) {
    if (dashboardJs[j] === "{") depth++;
    else if (dashboardJs[j] === "}" && --depth === 0) return dashboardJs.slice(at + 1, j + 1);
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

// The binding itself, as shipped: a top-level statement that listens for `change` on
// #permitStatusTarget. Absent → the MUST PASS checks below run without it and fail.
const binding = /^\$\(["']permitStatusTarget["']\)\??\.addEventListener\(\s*["']change["'][^\n]*$/m.exec(dashboardJs)?.[0] ?? "";
check("dashboard.js binds a change listener on #permitStatusTarget at top level", Boolean(binding), "no such statement — picking a filing will not refill the form");

const lifted = ["esc", "permitTargetKindLabel", "permitTargetOptionLabel", "renderPermitStatusTargetPicker", "permitStatusTargetId", "syncPermitForm"].map(cut).join("\n\n");

const f1 = { id: "f1", active: true, targetType: "permit", permitType: "building", applicationNumber: "BLD-26-0001", permitNumber: "", portalName: "Salem ePermitting", jurisdiction: "Salem", checkFrequencyDays: 7 };
const f2 = { id: "f2", active: true, targetType: "permit", permitType: "electrical", applicationNumber: "ELE-26-0002", permitNumber: "ELE-PERMIT-99", portalName: "Salem ePermitting", jurisdiction: "Salem", checkFrequencyDays: 14 };
const detail = { project: { id: "p-smoke", ahj: "Salem" }, permitCheckTargets: [f1, f2], submissions: [] };

const browser = await chromium.launch({ headless: true });
const numbers = async (page: { evaluate: (fn: () => string) => Promise<string> }): Promise<string> =>
  page.evaluate(() => `${(document.getElementById("permitApplicationNumber") as HTMLInputElement).value}|${(document.getElementById("permitTrackingNumber") as HTMLInputElement).value}`);

async function run(withBinding: boolean): Promise<{ first: string; onSecond: string; backOnFirst: string }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await ctx.newPage();
  await page.route("**/*", (route: { abort(): Promise<void> }) => route.abort());
  await page.setContent(dashboardHtml, { waitUntil: "domcontentloaded" });
  // The permit form sits inside the (hidden) project view: open every ancestor so the select is
  // actionable the way it is for an operator on the project screen.
  await page.evaluate(() => {
    for (let el: HTMLElement | null = document.getElementById("permitStatusTarget"); el; el = el.parentElement) {
      el.removeAttribute("hidden");
      if (el.tagName === "DETAILS") (el as HTMLDetailsElement).open = true;
    }
  });
  await page.addScriptTag({
    content: `var state = ${JSON.stringify({ selectedProjectId: "p-smoke", recheckTargetId: null, detail })};
function $(id) { return document.getElementById(id); }
${lifted}
${withBinding ? binding : "/* binding withheld: control run */"}
syncPermitForm();`,
  });
  const first = await numbers(page);
  await page.selectOption("#permitStatusTarget", "f2");
  const onSecond = await numbers(page);
  await page.selectOption("#permitStatusTarget", "f1");
  const backOnFirst = await numbers(page);
  await ctx.close();
  return { first, onSecond, backOnFirst };
}

try {
  const real = await run(Boolean(binding));
  check("precondition: the form opens on the first filing's numbers", real.first === "BLD-26-0001|", real.first);
  check("MUST PASS: picking the second filing fills ITS application and permit numbers", real.onSecond === "ELE-26-0002|ELE-PERMIT-99", real.onSecond);
  check("MUST PASS: picking the first again replaces them — never the second filing's number left behind", real.backOnFirst === "BLD-26-0001|", real.backOnFirst);
  const control = await run(false);
  check("MUST EXCLUDE (control): without the binding a pick changes nothing — the checks above measure the listener",
    control.onSecond === control.first, `first=${control.first} afterPick=${control.onSecond}`);
} finally {
  await browser.close();
}

console.log(failures.length ? `\nPERMIT TARGET CHANGE: ${failures.length} FAILED\n  ${failures.join("\n  ")}` : "\nPERMIT TARGET CHANGE: all checks passed.");
if (failures.length) process.exitCode = 1;
