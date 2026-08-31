// THE BOT MUST KNOW WHEN IT IS NOT LOGGED IN.
// The portal-agnostic login flow used to treat "no password field found" as proof of an
// authenticated session. On eTRAKiT-style portals that is doubly wrong: (1) the login form
// IS present but its password box is a Telerik RadTextBox rendered as type=text with no
// password-ish attribute, so the type=password heuristic misses it; (2) the portal shows a
// public landing page, so "no form" does not mean "signed in". The old code returned
// already_authenticated and the learner would then "learn" an application page it was never
// logged in to. This pins the fixed behaviour, all against local fixtures (no live portal):
//   - a type=text password field, labelled only by an adjacent "Password:" cell, is found;
//   - a public landing with NO form and NO logout control → login_form_unrecognized (honest
//     failure), NOT already_authenticated;
//   - a page with a visible "Log Out" control and no form → already_authenticated (correct).
//
// Run: npx tsx portal-bot/src/adapters/loginForm.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { performLogin, loginFormPresent } from "./loginFlow";

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// (1) eTRAKiT-shaped login: table layout, labels in sibling cells (NOT associated via
// for=/aria), and the password box is type=text with a non-obvious id (as Telerik renders
// it). Submitting swaps the panel for a signed-in view (a "Log Out" link).
const ETRAKIT_LOGIN = `<!doctype html><html><body>
  <table><tr><td>User Name:</td><td><input type="text" id="ucLogin_txtLoginId"></td></tr>
  <tr><td>Password:</td><td><input type="text" id="ucLogin_RadTextBox2"></td></tr></table>
  <input type="button" id="ucLogin_btnLogin" value="LOG IN" onclick="
    if(document.getElementById('ucLogin_txtLoginId').value && document.getElementById('ucLogin_RadTextBox2').value){
      document.body.innerHTML='<a href=\\'logout.aspx\\' id=\\'lnkLogout\\'>Log Out</a><h1>My Dashboard</h1>';
    }">
</body></html>`;

// (2) A public landing page: content, links, but no login form and no logout control.
const PUBLIC_LANDING = `<!doctype html><html><body>
  <h1>Welcome to the City Permit Portal</h1>
  <a href="/info">Permit Information</a><a href="/fees">Fee Schedule</a>
</body></html>`;

// (3) An already-signed-in page: no form, but a visible Log Out control.
const SIGNED_IN = `<!doctype html><html><body>
  <a href="/account/logout" id="lnkLogout">Log Out</a><h1>My Applications</h1>
</body></html>`;

const routes: Record<string, string> = { "/etrakit": ETRAKIT_LOGIN, "/public": PUBLIC_LANDING, "/signed-in": SIGNED_IN };
const server = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(routes[q.url || ""] ?? "<html><body>?</body></html>"); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
const cred = { username: "permit@example.com", password: "s3cret!" };

await check("eTRAKiT type=text password (adjacent-label) is detected as a login form", async () => {
  await page.goto(`http://127.0.0.1:${port}/etrakit`);
  assert.equal(await loginFormPresent(page), true, "should detect the RadTextBox login form");
});

await check("eTRAKiT form fills + submits → logged_in (form gone after submit)", async () => {
  await page.goto(`http://127.0.0.1:${port}/etrakit`);
  const res = await performLogin(page, cred);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
  assert.equal(res.ok, true);
});

await check("public landing with NO form and NO logout → login_form_unrecognized (NOT already_authenticated)", async () => {
  await page.goto(`http://127.0.0.1:${port}/public`);
  const res = await performLogin(page, cred);
  assert.equal(res.status, "login_form_unrecognized", `got ${res.status}: ${res.message}`);
  assert.equal(res.ok, false, "an unrecognized login must NOT be reported as success");
});

await check("no form but a visible Log Out control → already_authenticated", async () => {
  await page.goto(`http://127.0.0.1:${port}/signed-in`);
  const res = await performLogin(page, cred);
  assert.equal(res.status, "already_authenticated", `got ${res.status}: ${res.message}`);
  assert.equal(res.ok, true);
});

await check("missing credential on a real form → no_credential (never a false success)", async () => {
  await page.goto(`http://127.0.0.1:${port}/etrakit`);
  const res = await performLogin(page, undefined);
  assert.equal(res.status, "no_credential", `got ${res.status}: ${res.message}`);
});

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} loginForm.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll loginForm.dom.smoke checks passed.");
process.exit(0);
