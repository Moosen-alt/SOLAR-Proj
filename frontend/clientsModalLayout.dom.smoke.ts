// CLIENTS MODAL LAYOUT — real Chromium, the dashboard's own markup and stylesheet.
//
// The operator called Dashboard -> Clients "janky" (2026-09-26). Root cause: `.modal-body` is a
// two-column grid and the modal gave it THREE children, so #clientCredentials (Client links +
// Portal logins) auto-placed into row 2 of the 260px LIST column; `.modal-body` is
// overflow:hidden, so row 1 (list + form) was squashed to a sliver — clipped "Clients" heading,
// two scrollbars side by side — the login inputs spilled across the column edge, and each
// saved login's Delete button wrapped "Dele/te".
//
//   MUST PASS — at 1440 / 1280 / 1024: the portal logins sit in the RIGHT (editor) pane, not the
//               list column; the list column is not squashed; the "Clients" heading and the New
//               button do not overlap; no input/select/textarea overflows its pane; no button
//               wraps mid-word; the scroll regions are the list and the editor pane only (the
//               form does not scroll inside the pane).
//   MUST PASS — at 390: the columns stack (editor below the list), nothing overflows, nothing
//               wraps, no horizontal page scroll.
//   MUST PASS — dark theme at 1440: the same geometry holds.
//
// Hermetic: a throwaway static server over frontend/ (or CLIENTS_SMOKE_FRONTEND, to prove the
// smoke fails on an older checkout), stubbed /api/clients + one client's four FAKE logins,
// everything else 404. No backend, no database, no real credentials.
// Discovered from disk by scripts/run-dom-smokes.ts. Alone: `npx tsx frontend/clientsModalLayout.dom.smoke.ts`

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const FRONTEND = path.resolve(process.env.CLIENTS_SMOKE_FRONTEND || path.dirname(fileURLToPath(import.meta.url)));
const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
  if (ok) console.log(`  PASS  ${label}`);
  else { failures.push(detail ? `${label} — ${detail}` : label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

const CLIENT = {
  id: "client-fake-1", companyName: "Fake Solar Co (TEST)", legalBusinessName: "Fake Solar Co LLC", ccbLicenseNumber: "000000",
  contactName: "Test Contact", contactEmail: "contact@example.invalid", portalIdentities: [],
  // The State licences editor's rows must fit the pane too (FAKE numbers).
  stateLicenses: [
    { state: "MA", kind: "construction_supervisor", number: "CS-000000", expires: "2027-01-01", holder: "Fake Supervisor With A Long Name" },
    { state: "MA", kind: "home_improvement_contractor", number: "000000" },
    { state: "WA", kind: "electrical_contractor", number: "FAKEEC000000XX", expires: "2027-06-30" },
  ],
};
const CREDS = [
  { id: "cred-1", portalType: "accela_oregon", usernameReference: "fake.user.one@example.invalid", hasSecret: true },
  { id: "cred-2", portalType: "powerclerk_pge", usernameReference: "fake-installer-two", hasSecret: true },
  { id: "cred-3", portalType: "citizenserve_test", usernameReference: "fake_three_long_username_for_wrap_test@example.invalid", hasSecret: true },
  { id: "cred-4", portalType: "energov_demo", usernameReference: "fake4", hasSecret: true },
];
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2" };
const API_STUBS: Array<[RegExp, string]> = [
  [/^\/api\/projects$/, '{"projects":[],"total":0}'],
  [/^\/api\/clients\/[^/]+\/portal-credentials$/, JSON.stringify({ credentials: CREDS })],
  [/^\/api\/clients$/, JSON.stringify({ clients: [CLIENT] })],
  [/^\/api\/users/, '{"users":[]}'],
];

const startServer = async (): Promise<{ base: string; close: () => Promise<void> }> => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/health") { res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'); return; }
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

type Geometry = {
  overflow: string[]; wrapped: string[]; scrollers: string[]; overlap: boolean; hScroll: boolean;
  listH: number; listLeft: number; listBottom: number; credsLeft: number; credsTop: number; credRows: number;
};

async function main(): Promise<void> {
  const { base, close } = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const vp of [{ w: 1440, h: 900, dark: false }, { w: 1280, h: 800, dark: false }, { w: 1024, h: 768, dark: false }, { w: 390, h: 844, dark: false }, { w: 1440, h: 900, dark: true }]) {
      const tag = `${vp.w}px${vp.dark ? " dark" : ""}`;
      console.log(`\nVIEWPORT ${vp.w}x${vp.h}${vp.dark ? " (dark)" : ""}`);
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      // tsx wraps named inner functions in __name(); page.evaluate runs them where it is undefined.
      await ctx.addInitScript("globalThis.__name = (f) => f;");
      const page = await ctx.newPage();
      await page.route("**://*/**", (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) =>
        route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.goto(`${base}/#/dashboard`, { waitUntil: "load", timeout: 30000 });
      if (vp.dark) await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await page.waitForTimeout(400);
      await page.evaluate(() => (document.getElementById("openClientsBtn") as HTMLButtonElement).click());
      await page.waitForSelector("#credList [data-cred-del]", { timeout: 15000 });
      await page.waitForTimeout(300);
      const g: Geometry = await page.evaluate(() => {
        const modal = document.getElementById("clientsModal")!;
        const rect = (el: Element) => el.getBoundingClientRect();
        const overflow: string[] = [];
        modal.querySelectorAll("input:not([type=hidden]), select, textarea").forEach((el) => {
          const pane = el.closest("#clientCredentials, .clients-form-pane, .clients-list-pane") || modal.querySelector(".modal-card")!;
          const a = rect(el), b = rect(pane);
          if (a.width > 0 && (a.left < b.left - 1 || a.right > b.right + 1)) overflow.push(el.id || el.getAttribute("data-pi") || el.tagName);
        });
        const wrapped: string[] = [];
        modal.querySelectorAll("button").forEach((btn) => {
          if (rect(btn).width === 0) return;
          const label = btn.querySelector("span") || btn;
          const lh = parseFloat(getComputedStyle(btn).lineHeight) || 20;
          if (rect(label).height > lh * 1.6) wrapped.push((btn.id || btn.textContent || "").trim().slice(0, 40));
        });
        const scrollers: string[] = [];
        modal.querySelectorAll("*").forEach((el) => {
          if (el.tagName === "TEXTAREA") return;
          const cs = getComputedStyle(el);
          if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) scrollers.push(el.id || String((el as HTMLElement).className));
        });
        const h = rect(modal.querySelector(".clients-list-pane h3")!), nb = rect(document.getElementById("newClientBtn")!);
        const list = rect(modal.querySelector(".clients-list-pane")!);
        const creds = rect(document.getElementById("clientCredentials")!);
        return {
          overflow, wrapped, scrollers,
          overlap: !(h.right <= nb.left || nb.right <= h.left || h.bottom <= nb.top || nb.bottom <= h.top),
          hScroll: document.documentElement.scrollWidth > innerWidth,
          listH: Math.round(list.height), listLeft: Math.round(list.left), listBottom: Math.round(list.bottom),
          credsLeft: Math.round(creds.left), credsTop: Math.round(creds.top),
          credRows: modal.querySelectorAll("#credList [data-cred-del]").length,
        };
      });
      const d = JSON.stringify(g);
      check(g.credRows === 4, `${tag}: the four stubbed logins render`, d);
      check(g.overflow.length === 0, `${tag}: no input overflows its pane`, g.overflow.join(","));
      check(g.wrapped.length === 0, `${tag}: no button wraps mid-word`, g.wrapped.join(","));
      check(!g.overlap, `${tag}: the "Clients" heading and the New button do not overlap`);
      check(!g.hScroll, `${tag}: no horizontal page scroll`);
      check(!g.scrollers.includes("clientForm"), `${tag}: the form does not scroll inside the editor pane`, g.scrollers.join("|"));
      if (vp.w >= 1024) {
        check(g.credsLeft > g.listLeft + 200, `${tag}: portal logins sit in the editor pane, not the list column`, d);
        check(g.listH >= 300, `${tag}: the list column is full height, not squashed`, d);
      } else {
        check(g.credsTop >= g.listBottom - 1, `${tag}: the columns stack (editor below the list)`, d);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    await close();
  }
  console.log(failures.length ? `\nCLIENTS MODAL LAYOUT: ${failures.length} FAILED\n  ${failures.join("\n  ")}` : "\nCLIENTS MODAL LAYOUT: all checks passed.");
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
