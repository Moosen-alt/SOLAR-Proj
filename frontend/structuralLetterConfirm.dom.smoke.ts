// =================================================================================================
// THE ENGINEER'S-LETTER CARD, CLICKED IN A REAL BROWSER (#198; Helm's review of #218 at fb160321).
//
// structuralLetterCardRender.test.ts pins the card's markup as a string. This clicks it: the
// SHIPPED structuralLetterCardHtml and structuralLetterAction, lifted out of frontend/dashboard.js
// by brace-matching (the stageUiContract.dom.smoke.ts idiom), rendered into a real Chromium page,
// with `api` / `confirm` / `prompt` stubbed so nothing leaves the page.
//
//   [1] auth OFF: Confirm asks for a name, then POSTs exactly the candidate's document and page with
//       that name to /api/projects/:id/structural-letter/confirm — and cancelling the prompt posts
//       nothing;
//   [2] auth ON: Confirm posts no typed name (the server records the session's person);
//   [3] the confirmed card's Withdraw posts to /withdraw;
//   [4] the "Open its pages" link asks for ?inline=1 at the candidate's page.
//
// Discovered from disk by scripts/run-dom-smokes.ts. Alone: `npx tsx frontend/structuralLetterConfirm.dom.smoke.ts`
// =================================================================================================

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const dashboardJs = fs.readFileSync(path.join(FRONTEND, "dashboard.js"), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failures.push(detail ? `${label} — ${detail}` : label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

function cut(name: string): string {
  const at = dashboardJs.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (at < 0) throw new Error(`${name} is gone from dashboard.js — re-point this smoke`);
  const openAt = at + dashboardJs.slice(at).indexOf("{");
  let depth = 0;
  for (let j = openAt; j < dashboardJs.length; j++) {
    if (dashboardJs[j] === "{") depth++;
    else if (dashboardJs[j] === "}" && --depth === 0) return dashboardJs.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces reading ${name}`);
}
const bundle = ["esc", "structuralLetterCardHtml", "structuralLetterAction"].map(cut).join("\n\n");

const CANDIDATE = { candidate: { documentId: "doc-cut-2", filename: "plan-set - Structural.pdf", source: "split", page: 3, pageCount: 4, score: 4 }, confirmation: null, voided: null };
const CONFIRMED = { candidate: CANDIDATE.candidate, confirmation: { id: "c1", documentId: "doc-cut-2", filename: "plan-set - Structural.pdf", page: 3, confirmedBy: "Jane Example", confirmedAt: "2026-10-08T12:00:00.000Z" }, voided: null };

type Probe = { calls: Array<{ url: string; body: unknown }>; href: string };
const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await ctx.newPage();
  await page.route("**/*", (route: { abort(): Promise<void> }) => route.abort());
  await page.setContent("<!doctype html><html><body><div id='submitGate'></div></body></html>");

  const click = (sl: unknown, auth: unknown, typed: string | null): Promise<Probe> => page.evaluate(
    async ([src, slIn, authIn, typedIn]: [string, unknown, unknown, string | null]) => {
      const calls: Array<{ url: string; body: unknown }> = [];
      const w = window as unknown as Record<string, unknown>;
      w.state = { selectedProjectId: "proj-1", authMe: authIn };
      w.api = async (url: string, opts?: { body?: string }) => { calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null }); return {}; };
      w.showMessage = () => undefined;
      w.selectProject = async () => undefined;
      w.confirm = () => true;
      w.prompt = () => typedIn;
      const { card, act } = new Function(`${src}\nreturn { card: structuralLetterCardHtml, act: structuralLetterAction };`)() as {
        card: (sl: unknown, id: string) => string; act: (a: string, b: Element) => Promise<void>;
      };
      const host = document.getElementById("submitGate")!;
      host.innerHTML = card(slIn, "proj-1");
      const btn = host.querySelector("[data-structural-letter-action]")!;
      await act(btn.getAttribute("data-structural-letter-action")!, btn);
      return { calls, href: host.querySelector("a")?.getAttribute("href") ?? "" };
    },
    [bundle, sl, auth, typed] as [string, unknown, unknown, string | null],
  );

  console.log("\n[1] auth off: a typed name, the candidate's document and page");
  const off = await click(CANDIDATE, { enabled: false, user: null }, "Jane Example");
  check("Confirm posts once, to the project's /structural-letter/confirm", off.calls.length === 1 && off.calls[0].url === "/api/projects/proj-1/structural-letter/confirm", JSON.stringify(off.calls));
  check("…with the candidate's document id, its page and the typed name",
    JSON.stringify(off.calls[0]?.body) === JSON.stringify({ documentId: "doc-cut-2", page: 3, confirmedBy: "Jane Example" }), JSON.stringify(off.calls[0]?.body));
  const cancelled = await click(CANDIDATE, { enabled: false, user: null }, null);
  check("cancelling the name prompt posts nothing", cancelled.calls.length === 0, JSON.stringify(cancelled.calls));

  console.log("\n[2] auth on: no typed name is sent");
  const on = await click(CANDIDATE, { enabled: true, user: { name: "Jane Example", email: "jane@example.test" } }, "Mallory Forger");
  check("Confirm posts an empty confirmedBy (the server records the session's person)",
    on.calls.length === 1 && (on.calls[0].body as { confirmedBy?: string }).confirmedBy === "", JSON.stringify(on.calls));

  console.log("\n[3] the confirmed card withdraws");
  const wd = await click(CONFIRMED, { enabled: false, user: null }, "Jane Example");
  check("Withdraw posts to /withdraw with the typed name",
    wd.calls.length === 1 && wd.calls[0].url === "/api/projects/proj-1/structural-letter/withdraw"
    && (wd.calls[0].body as { withdrawnBy?: string }).withdrawnBy === "Jane Example", JSON.stringify(wd.calls));

  console.log("\n[4] the pages link");
  check("Open its pages asks for ?inline=1 at the candidate's page", off.href === "/api/projects/proj-1/documents/doc-cut-2?inline=1#page=3", off.href);
} finally {
  await browser.close();
}

console.log(`\nstructuralLetterConfirm.dom.smoke: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
process.exit(0);
