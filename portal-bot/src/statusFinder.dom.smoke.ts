// REAL-CHROMIUM SMOKE: finding one filing's status on a signed-in portal (issue #161).
//
// Live, PacifiCorp PowerClerk 2026-10-04: the status read signed in to "Program Home", then reloaded
// the recipe's portalUrl (its LOGIN page) and read a login wall; the filing itself was on page N of a
// 13-per-page "Projects" list. These pages reproduce that shape on 127.0.0.1:
//   /home           signed in: "New Project", "My Account", "Projects"
//   /projects?page= a 3-page list with a numeric page <select> (1,2,3) and a page-SIZE <select>
//                   (10,15,25: not a pager); the filing is on page 3
//   /list?page=     a 2-page list paged by a "Next" link; the filing is on page 2
//   /list2          a list whose only "next"-like control is "Next: Submit application"
//   /list3          a "Next" whose words to a person are "Next" but whose aria-label submits
//   /searchlist2    a search box Enter does not run, beside an ICON-ONLY button labelled (aria-label)
//                   "Submit application" — its class says "search", its words say submit
//   /home6          a "Projects" link whose title says "Start a new project"
//   /home4, /home5  a "Projects" link to ANOTHER host (a second server, OTHER): plainly (href), and by
//                   script (href="#" + onclick). OTHER's list holds the very number looked for.
//   /login          a sign-in form
//   /new, /submit   must never be requested
//
//   MUST-PASS    found on page 3 via the Projects link + page select; found via "Next";
//                RecipeAdapter.checkStatus with portalUrl = /login still finds it and never loads /login
//   MUST-EXCLUDE "New Project" is never followed; the page-size select is not walked; a number that
//                is on no page -> null with how many pages were read; a login page -> named as such;
//                a control is refused by ANY of its names (text, aria-label, title), not only its text
//                (Helm, PR #169, rule 1); a list on another host is never read, whether the link says
//                so (never requested) or a script takes the browser there (read stops, unread) (rule 5)
//
// Run: npx tsx portal-bot/src/statusFinder.dom.smoke.ts
import http from "node:http";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { findFilingStatus } from "./statusFinder";
import { RecipeAdapter } from "./adapters/recipeAdapter";
import type { PortalRecipe } from "../../shared/src/types";

const hits: string[] = [];
const row = (id: string, status: string) => `<tr><td>${id}</td><td>${status}</td></tr>`;
const shell = (body: string) => `<!doctype html><html><head><title>Portal</title></head><body>${body}</body></html>`;
const HOME = shell(`<h1>Program Home</h1><a href="/new">New Project</a> <a href="/account">My Account</a> <a href="/projects?page=1">Projects</a>`);
const projectsPage = (p: number) => shell(`<h1>Projects</h1>
  <label>Rows <select id="size"><option>10</option><option selected>15</option><option>25</option></select></label>
  <label>Page <select id="pager" onchange="location.href='/projects?page='+this.value">${[1, 2, 3].map((n) => `<option${n === p ? " selected" : ""}>${n}</option>`).join("")}</select></label>
  <table><tbody>${p === 3 ? row("APP-123456", "Application Approved") + row("APP-200001", "Draft") : row(`APP-10000${p}`, "Application Submitted") + row(`APP-20000${p}`, "Draft")}</tbody></table>
  <a href="/new">New Project</a>`);
const listPage = (p: number) => shell(`<h1>My Applications</h1><table><tbody>${p === 2 ? row("APP-777001", "Interconnection Complete") : row("APP-300001", "In Review")}</tbody></table>
  ${p === 1 ? `<a href="/list?page=2">Next</a>` : `<a class="disabled" aria-disabled="true">Next</a>`}`);
const LOGIN = shell(`<h1>Login</h1><form><input name="username"><input type="password" name="password"><button>Sign in</button></form>`);

// A PowerClerk-shaped list: 5 pages, the filing on page 4, and a search box with no "search" words of
// its own: it sits between a "Search All Columns" selector and a magnifier button (owner's screenshot).
const ALL = Array.from({ length: 10 }, (_, k) => (k === 7 ? row("APP-110422", "PP - Engineering Review") : row(`APP-11${String(k).padStart(4, "0")}`, "PP - Application Submitted")));
const searchList = (page: number, q: string) => shell(`<h1>Projects</h1>
  <div class="toolbar"><select><option selected>Search All Columns</option><option>Project #</option></select>
  <input id="q" value="${q}" onkeydown="if(event.key==='Enter'){location.href='/searchlist?q='+encodeURIComponent(this.value)}">
  <button title="Search" onclick="location.href='/searchlist?q='+encodeURIComponent(document.getElementById('q').value)"><i class="fa fa-search"></i></button></div>
  <label>Page <select onchange="location.href='/searchlist?page='+this.value">${[1, 2, 3, 4, 5].map((n) => `<option${n === page ? " selected" : ""}>${n}</option>`).join("")}</select></label>
  <table><tbody>${q ? ALL.filter((r) => r.includes(q)).join("") : ALL.slice((page - 1) * 2, page * 2).join("")}</tbody></table>`);

// ANOTHER HOST (a second origin): its "Projects" list holds the very number looked for, so a read that
// follows a link there would "find" it. A status read must never read it (rule 5).
const otherHits: string[] = [];
const other = http.createServer((q, r) => {
  const u = new URL(q.url ?? "/", "http://127.0.0.1");
  otherHits.push(u.pathname + u.search);
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(shell(`<h1>Projects</h1><table><tbody>${row("APP-555001", "Application Approved")}</tbody></table>`));
});
await new Promise<void>((ok) => other.listen(0, "127.0.0.1", () => ok()));
const otherBase = `http://127.0.0.1:${(other.address() as { port: number }).port}`;

const server = http.createServer((q, r) => {
  const u = new URL(q.url ?? "/", "http://127.0.0.1");
  hits.push(u.pathname + u.search);
  const page = Number(u.searchParams.get("page") || "1");
  const html = u.pathname === "/home" ? HOME
    : u.pathname === "/home2" ? shell(`<h1>Program Home</h1><a href="/searchlist">Projects</a>`)
    : u.pathname === "/home3" ? shell(`<h1>Program Home</h1><a href="/searchlist2">Projects</a>`)
    : u.pathname === "/searchlist2" ? shell(`<h1>Projects</h1>
        <div class="toolbar"><select><option selected>Search All Columns</option></select><input id="q">
        <button aria-label="Submit application" class="btn-search" onclick="location.href='/submit'"><i class="fa fa-search"></i></button></div>
        <table><tbody>${row("APP-600001", "Draft")}</tbody></table>`)
    : u.pathname === "/apps3" ? shell(`<h1>Home</h1><a href="/list3">Applications</a>`)
    : u.pathname === "/list3" ? shell(`<h1>Applications</h1><table><tbody>${row("APP-400002", "Draft")}</tbody></table><a href="/submit" aria-label="Next: submit this application">Next</a>`)
    : u.pathname === "/home6" ? shell(`<h1>Program Home</h1><a href="/new" title="Start a new project">Projects</a>`)
    : u.pathname === "/home4" ? shell(`<h1>Program Home</h1><a href="${otherBase}/projects">Projects</a>`)
    : u.pathname === "/home5" ? shell(`<h1>Program Home</h1><a href="#" onclick="location.href='${otherBase}/projects'; return false;">Projects</a>`)
    : u.pathname === "/searchlist" ? searchList(page, u.searchParams.get("q") ?? "")
    : u.pathname === "/projects" ? projectsPage(page)
    : u.pathname === "/list" ? listPage(page)
    : u.pathname === "/apps" ? shell(`<h1>Home</h1><a href="/list?page=1">My Applications</a>`)
    : u.pathname === "/apps2" ? shell(`<h1>Home</h1><a href="/list2">Applications</a>`)
    : u.pathname === "/list2" ? shell(`<h1>Applications</h1><table><tbody>${row("APP-400001", "Draft")}</tbody></table><button onclick="location.href='/submit'">Next: Submit application</button>`)
    : u.pathname === "/login" ? LOGIN
    : shell(`<h1>${u.pathname}</h1>`);
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(html);
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const check = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
console.log("status finder: one filing's status on a signed-in portal (#161)");

await check("MUST-PASS found on page 3 of the Projects list (link + numeric page select)", async () => {
  hits.length = 0;
  await page.goto(`${base}/home`);
  const r = await findFilingStatus(page, ["APP-123456"], { settleMs: 5000 });
  assert.ok(r.text && /Application Approved/.test(r.text), `status text: ${r.text} (${r.reason})`);
  assert.match(r.reason, /page 3 of 3/);
  assert.equal(r.pagesScanned, 4, "landing + list pages 1, 2, 3");
  assert.ok(!hits.includes("/new"), "MUST-EXCLUDE: 'New Project' was followed");
});

await check("MUST-EXCLUDE a number on no page -> null, and the reason says how many list pages were read", async () => {
  hits.length = 0;
  await page.goto(`${base}/home`);
  const r = await findFilingStatus(page, ["APP-999999"], { settleMs: 5000 });
  assert.equal(r.text, null);
  assert.match(r.reason, /not on "Projects" — read 3 list page\(s\)/);
  assert.ok(!hits.includes("/new"));
});

await check("MUST-PASS a list paged by a 'Next' link", async () => {
  await page.goto(`${base}/apps`);
  const r = await findFilingStatus(page, ["APP-777001"], { settleMs: 5000 });
  assert.ok(r.text && /Interconnection Complete/.test(r.text), `status text: ${r.text} (${r.reason})`);
  assert.match(r.reason, /page 2/);
});

await check("MUST-PASS a list with its own search box: found by searching the number, no page walked", async () => {
  hits.length = 0;
  await page.goto(`${base}/home2`);
  const r = await findFilingStatus(page, ["APP-110422"], { settleMs: 5000 });
  assert.ok(r.text && /Engineering Review/.test(r.text), `status text: ${r.text} (${r.reason})`);
  assert.match(r.reason, /found by searching "Projects"/);
  assert.ok(!hits.some((h) => /[?&]page=/.test(h)), `a page was walked although the list could be searched: ${JSON.stringify(hits)}`);
});

await check("MUST-EXCLUDE a search with no match says so, and does not walk the filtered list", async () => {
  hits.length = 0;
  await page.goto(`${base}/home2`);
  const r = await findFilingStatus(page, ["APP-999999"], { settleMs: 5000 });
  assert.equal(r.text, null);
  assert.match(r.reason, /no matching row/);
  assert.ok(!hits.some((h) => /[?&]page=/.test(h)), `pages were walked after a search: ${JSON.stringify(hits)}`);
});

await check("MUST-EXCLUDE a 'Next' control whose words submit is never clicked", async () => {
  hits.length = 0;
  await page.goto(`${base}/apps2`);
  const r = await findFilingStatus(page, ["APP-123456"], { settleMs: 5000 });
  assert.equal(r.text, null);
  assert.ok(!hits.includes("/submit"), "a 'Next: Submit application' control was clicked on a read-only pass");
});

await check("MUST-EXCLUDE an icon-only search button whose aria-label submits is never clicked", async () => {
  hits.length = 0;
  await page.goto(`${base}/home3`);
  const r = await findFilingStatus(page, ["APP-660001"], { settleMs: 5000 });
  assert.equal(r.text, null);
  assert.ok(!hits.includes("/submit"), `an icon-only "Submit application" button was clicked as the search button: ${JSON.stringify(hits)}`);
});

await check("MUST-EXCLUDE a 'Next' whose aria-label submits is never clicked, though its text is only 'Next'", async () => {
  hits.length = 0;
  await page.goto(`${base}/apps3`);
  const r = await findFilingStatus(page, ["APP-123456"], { settleMs: 5000 });
  assert.equal(r.text, null);
  assert.ok(!hits.includes("/submit"), `a "Next" labelled "submit this application" was clicked: ${JSON.stringify(hits)}`);
});

await check("MUST-EXCLUDE a 'Projects' link whose title starts a new project is never followed", async () => {
  hits.length = 0;
  await page.goto(`${base}/home6`);
  const r = await findFilingStatus(page, ["APP-123456"], { settleMs: 5000 });
  assert.equal(r.text, null);
  assert.match(r.reason, /no projects\/applications list link/);
  assert.ok(!hits.includes("/new"), "a link titled 'Start a new project' was followed");
});

await check("MUST-EXCLUDE a list link to another host is never followed, and the reason says so", async () => {
  otherHits.length = 0;
  await page.goto(`${base}/home4`);
  const r = await findFilingStatus(page, ["APP-555001"], { settleMs: 5000 });
  assert.equal(r.text, null, `read a list on another host: ${r.text}`);
  assert.match(r.reason, /goes to another host \(127\.0\.0\.1:\d+\); a status read never follows it/);
  assert.deepEqual(otherHits, [], "the other host was requested");
});

await check("MUST-EXCLUDE a list link a script sends to another host: the read stops there, unread", async () => {
  await page.goto(`${base}/home5`);
  const r = await findFilingStatus(page, ["APP-555001"], { settleMs: 5000 });
  assert.equal(r.text, null, `read a list on another host: ${r.text}`);
  assert.match(r.reason, /opening "Projects" left the signed-in portal \(127\.0\.0\.1:\d+\) for 127\.0\.0\.1:\d+/);
});

await check("MUST-EXCLUDE a sign-in page is named as such, nothing is read", async () => {
  await page.goto(`${base}/login`);
  const r = await findFilingStatus(page, ["APP-123456"], { settleMs: 5000 });
  assert.equal(r.text, null);
  assert.match(r.reason, /sign-in page/);
});

await check("MUST-PASS RecipeAdapter.checkStatus stays on the signed-in page: portalUrl = /login is never reloaded", async () => {
  hits.length = 0;
  await page.goto(`${base}/home`);
  const recipe = {
    id: "sf1", scopeType: "utility", profileKey: "or|unknown|test utility", state: "OR", ahj: "", utility: "Test Utility",
    portalPlatform: "powerclerk", portalUrl: `${base}/login`, status: "complete", version: 1, steps: [],
    createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
  } as unknown as PortalRecipe;
  const adapter = new RecipeAdapter(recipe, {}, {}, {});
  (adapter as unknown as { page: unknown }).page = page;
  const text = await adapter.checkStatus(["APP-123456"]);
  assert.ok(text && /Application Approved/.test(text), `status text: ${text}; reason: ${adapter.lastStatusReason}`);
  assert.ok(!hits.includes("/login"), "the recipe's login page was loaded after sign-in");
  assert.ok(!hits.includes("/new"));
});

await browser.close();
server.close();
other.close();
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall status-finder checks passed");
