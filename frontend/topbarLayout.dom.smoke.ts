// TOP BAR LAYOUT — real Chromium, the dashboard's own markup and stylesheet.
//
// Two defects the operator saw once the "How it flows" legend moved into the top bar:
//   1. At 1024px the popover's left edge ran off-screen — it was anchored under its button
//      (right:0) at a fixed 900px width, so everything left of the button's right edge minus
//      900px was cut off. At 800px it was worse.
//   2. The new button (label + icon) made the primary nav WRAP to two rows at 1024px.
//
//   MUST PASS — at 1024 and 800, the opened popover lies entirely inside the viewport.
//   MUST PASS — at 1024 and 1280, every primary-nav entry sits on ONE row.
//   MUST PASS — at 1440 the button still carries its words ("How it flows"); it only goes
//               icon-only below 1280, and keeps its aria-label there.
//   MUST PASS — the status-correction form inside "Advanced / override & tools" renders as a
//               form (full-size select + reason box, side by side), not browser-default controls.
//
// Hermetic: a throwaway static server over frontend/, empty envelopes for the /api calls the
// dashboard makes at boot, everything else 404. No backend, no database.
// Discovered from disk by scripts/run-dom-smokes.ts. Alone: `npx tsx frontend/topbarLayout.dom.smoke.ts`

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

// TOPBAR_SMOKE_FRONTEND points a kill run at a mutated copy of frontend/ (never edit the live one to test).
const FRONTEND = path.resolve(process.env.TOPBAR_SMOKE_FRONTEND || path.dirname(fileURLToPath(import.meta.url)));
// What a real /health says about the running code (backend/src/buildInfo.ts). The label is the
// widest thing the status element can hold, so the one-row nav checks run WITH it (F20).
const BUILD_LABEL = "2026.09.26 · 0c466bb · pinned";
const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  if (ok) console.log(`  PASS  ${label}`);
  else { failures.push(detail ? `${label} — ${detail}` : label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2" };
const API_STUBS: Array<[RegExp, string]> = [
  [/^\/api\/projects$/, '{"projects":[],"total":0}'],
  [/^\/api\/clients/, '{"clients":[]}'],
  [/^\/api\/users/, '{"users":[]}'],
];

const startServer = async (): Promise<{ base: string; close: () => Promise<void> }> => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/health") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, build: { label: BUILD_LABEL } })); return; }
    if (url.pathname.startsWith("/api/")) {
      const hit = API_STUBS.find(([re]) => re.test(url.pathname));
      if (!hit) { res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not stubbed"}'); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(hit[1]);
      return;
    }
    const name = url.pathname === "/" ? "dashboard.html" : url.pathname.replace(/^\/+/, "");
    const file = path.join(FRONTEND, name);
    if (file.startsWith(FRONTEND) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" }).end(fs.readFileSync(file));
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

async function main(): Promise<void> {
  const { base, close } = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const vp of [{ w: 800, h: 700 }, { w: 1024, h: 768 }, { w: 1280, h: 800 }, { w: 1440, h: 900 }]) {
      console.log(`\nVIEWPORT ${vp.w}x${vp.h}`);
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      // tsx wraps named inner functions in __name(); page.evaluate runs them where it is undefined.
      await ctx.addInitScript("globalThis.__name = (f) => f;");
      const page = await ctx.newPage();
      await page.route("**://*/**", (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) =>
        route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.goto(`${base}/#/dashboard`, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(500);
      // The /health answer has landed before the bar is measured, so the nav checks below are
      // measured WITH the build label in the top bar wherever it shows (F20).
      await page.waitForFunction(() => document.getElementById("serviceStatus")?.classList.contains("conn-status--ok"), null, { timeout: 5000 }).catch(() => {});
      const build = await page.evaluate(() => {
        const el = document.getElementById("serviceStatus") as HTMLElement;
        const lab = el.querySelector(".build-label") as HTMLElement | null;
        return { ok: el.classList.contains("conn-status--ok"), title: el.title, text: lab?.textContent || "", shown: Boolean(lab && lab.getClientRects().length && getComputedStyle(lab).display !== "none") };
      });
      check(build.ok && build.title.includes(BUILD_LABEL), `/health's build label reaches the status element (title) at ${vp.w}px`, JSON.stringify(build));
      if (vp.w >= 1440) check(build.shown && build.text.includes(BUILD_LABEL), `the build label is shown in the top bar at ${vp.w}px`, JSON.stringify(build));
      else check(!build.shown, `the build label folds away below 1440px (${vp.w}px) — the nav gets the room`, JSON.stringify(build));
      const bar = await page.evaluate(() => {
        const tops = [...document.querySelectorAll(".primary-nav > *")].map((e) => Math.round(e.getBoundingClientRect().top));
        const sum = document.querySelector("#startHereGuide > summary") as HTMLElement;
        return { rows: new Set(tops).size, words: (document.querySelector("#startHereGuide .start-here-title") as HTMLElement).getBoundingClientRect().width > 60, aria: sum.getAttribute("aria-label") };
      });
      if (vp.w >= 1024) check(bar.rows === 1, `the primary nav sits on one row at ${vp.w}px`, `${bar.rows} rows`);
      if (vp.w >= 1280) check(bar.words, `"How it flows" keeps its words at ${vp.w}px`);
      else check(!bar.words && Boolean(bar.aria), `"How it flows" is icon-only (with an aria-label) at ${vp.w}px`, `words=${bar.words} aria=${bar.aria}`);
      await page.click("#startHereGuide > summary");
      await page.waitForTimeout(200);
      const pop = await page.evaluate(() => {
        const b = document.querySelector("#startHereGuide .start-here-body")!.getBoundingClientRect();
        return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), w: innerWidth, h: innerHeight };
      });
      check(pop.left >= 0 && pop.right <= pop.w && pop.top >= 0 && pop.bottom <= pop.h,
        `the opened "How it flows" popover is inside the ${vp.w}px viewport`, JSON.stringify(pop));
      if (vp.w === 1440) {
        // .item.fail — a failed QC rule, a flagged/overdue correction, a failed portal run, a
        // teammate with overdue corrections — rendered with NO colour at all (no rule matched the
        // class). It now wears the failing colour, identical to .item.blocker, in light and dark,
        // and stays distinct from .item.info / .item.warning (whose meaning is unchanged).
        const tints = await page.evaluate(() => {
          const host = document.createElement("div");
          document.body.appendChild(host);
          host.innerHTML = ["fail", "blocker", "info", "warning", "pass"].map((c) => `<article class="item ${c}" data-t="${c}"><div class="item-title"><span>x</span></div></article>`).join("");
          const read = () => Object.fromEntries([...host.querySelectorAll("article")].map((a) => {
            const s = getComputedStyle(a);
            return [(a as HTMLElement).dataset.t, `${s.backgroundColor}|${s.borderTopColor}|${getComputedStyle(a.querySelector(".item-title")!).color}`];
          }));
          const root = document.documentElement;
          const prev = root.getAttribute("data-theme");
          root.setAttribute("data-theme", "light");
          const light = read();
          root.setAttribute("data-theme", "dark");
          const dark = read();
          if (prev == null) root.removeAttribute("data-theme"); else root.setAttribute("data-theme", prev);
          host.remove();
          return { light, dark };
        });
        for (const mode of ["light", "dark"] as const) {
          const t = tints[mode] as Record<string, string>;
          check(t.fail === t.blocker, `.item.fail wears the failing colour (${mode})`, JSON.stringify({ fail: t.fail, blocker: t.blocker }));
          check(t.fail !== t.info && t.fail !== t.warning && t.fail !== t.pass, `.item.fail is distinct from info / warning / pass (${mode})`, JSON.stringify(t));
        }
        // THE STATUS CORRECTION FORM inside "Advanced / override & tools" had no form styling: a
        // browser-default ~19px select, labels running inline. The real #statusOverrideWrap,
        // opened in place (no request is made — these are <details> toggles).
        const form = await page.evaluate(() => {
          document.getElementById("detailView")?.removeAttribute("hidden");
          document.getElementById("pageProject")?.removeAttribute("hidden");
          (document.querySelector(".detail-more") as HTMLDetailsElement).open = true;
          (document.getElementById("statusOverrideWrap") as HTMLDetailsElement).open = true;
          const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
          const labels = [...document.querySelectorAll(".status-override-body .form-row > label")].map((l) => Math.round(l.getBoundingClientRect().top));
          return { bodyW: Math.round(r(".status-override-body").width), labelTops: labels, selectH: Math.round(r("#statusOverrideSelect").height), inputH: Math.round(r("#statusOverrideReason").height), inputW: Math.round(r("#statusOverrideReason").width), labelSpread: Math.max(...labels) - Math.min(...labels) };
        });
        check(form.selectH >= 30 && form.inputH >= 30, "the status-correction select and reason input are full-size controls", JSON.stringify(form));
        check(form.labelSpread <= 3 && form.inputW >= 200, "the status and reason fields sit side by side, the reason box wide enough to type in", JSON.stringify(form));
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    await close();
  }
  console.log(failures.length ? `\nTOP BAR LAYOUT: ${failures.length} FAILED\n  ${failures.join("\n  ")}` : "\nTOP BAR LAYOUT: all checks passed.");
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
