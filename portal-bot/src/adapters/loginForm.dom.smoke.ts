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

// (4) IDENTIFIER-FIRST ("two-step") login — OpenGov's portal and most SSO front doors ask
// for the email alone, then reveal the password after Continue. There is no password field
// on arrival, so the engine used to stop one click short of the actual login.
const TWO_STEP = `<!doctype html><html><body>
  <h1>Sign in</h1>
  <div id="step1"><input type="email" id="email" placeholder="Email"><button id="cont">Continue</button></div>
  <div id="step2" style="display:none"><input type="password" id="pw"><button id="go">Sign In</button></div>
  <script>
    document.getElementById('cont').onclick = function(){
      if(!document.getElementById('email').value) return;
      document.getElementById('step1').style.display='none';
      document.getElementById('step2').style.display='block';
    };
    document.getElementById('go').onclick = function(){
      if(document.getElementById('pw').value) document.body.innerHTML='<a href="/logout">Log Out</a><h1>Dashboard</h1>';
    };
  </script>
</body></html>`;

// (5) A login whose submit control is an <a href="javascript:…"> with the text "Submit" —
// Citizenserve's shape (verified live). No "login" token anywhere on the control, so the
// engine reported no_submit_control and stopped. The form still submits on Enter.
const JS_SUBMIT = `<!doctype html><html><body>
  <input type="text" id="u" name="username"><input type="password" id="p" name="password">
  <a href="javascript:void(0)" id="sub">Submit</a>
  <script>
    function done(){ if(document.getElementById('p').value) document.body.innerHTML='<a href="/logout">Log Out</a><h1>Home</h1>'; }
    document.getElementById('sub').onclick = done;
    document.getElementById('p').addEventListener('keydown', function(e){ if(e.key==='Enter') done(); });
  </script>
</body></html>`;

// (6) A login form painted LATE (Momentum's Liferay portlet renders after networkidle).
// The engine used to conclude "no form" on a non-login-looking URL and give up.
const LATE_FORM = `<!doctype html><html><body>
  <h1>City Portal Home</h1><div id="slot"></div>
  <script>
    setTimeout(function(){
      document.getElementById('slot').innerHTML =
        '<input type="text" id="lu" name="username"><input type="password" id="lp" name="password">' +
        '<button id="lb">LOG IN</button>';
      document.getElementById('lb').onclick = function(){
        if(document.getElementById('lp').value) document.body.innerHTML='<a href="/logout">Log Out</a><h1>My Dashboard</h1>';
      };
    }, 2500);
  </script>
</body></html>`;

// (7) RESPONSIVE DUPLICATE MARKUP — the same login shipped twice, mobile copy hidden and
// FIRST in the DOM. Testing only the first match of each selector found the hidden copy and
// declared the portal formless (measured live on Momentum: two password inputs, one
// visible, engine reported none).
const HIDDEN_DUPLICATE = `<!doctype html><html><body>
  <div id="mobile" style="display:none">
    <input type="text" id="mu" name="username"><input type="password" id="mp" name="password">
    <button id="mb">LOG IN</button>
  </div>
  <div id="desktop">
    <input type="text" id="du" name="username"><input type="password" id="dp" name="password">
    <button id="db" onclick="if(document.getElementById('dp').value) document.body.innerHTML='<a href=\\'/logout\\'>Log Out</a><h1>Home</h1>'">LOG IN</button>
  </div>
</body></html>`;

// (8) SSO HAND-OFF BEHIND A STALE LINK. The header "Login" link is still on the login page
// it navigates to, so a reveal that always picks the first trigger re-clicks it forever and
// never reaches the hand-off button below (measured live on OpenGov).
const SSO_HANDOFF = `<!doctype html><html><body>
  <a href="#" id="login-desktop">Login</a>
  <button id="sso">Login using Secure Portal</button>
  <div id="slot"></div>
  <script>
    document.getElementById('login-desktop').onclick = function(){ return false; }; // dead link
    document.getElementById('sso').onclick = function(){
      document.getElementById('slot').innerHTML =
        '<input type="text" id="su" name="username"><input type="password" id="sp" name="password">' +
        '<button id="sb">Sign In</button>';
      document.getElementById('sb').onclick = function(){
        if(document.getElementById('sp').value) document.body.innerHTML='<a href="/logout">Log Out</a><h1>Portal</h1>';
      };
    };
  </script>
</body></html>`;

// (9) NOTHING TO GO ON. ComEd's interconnection portal (verified live) renders both login
// inputs with no id, no name, no placeholder and no aria-label, and its labels carry
// for="username"/"password" pointing at ids that do not exist on the page — so every
// attribute- and label-based route finds nothing. Position is the only signal left: the
// identifier is the visible text input immediately before the password.
const BARE_INPUTS = `<!doctype html><html><body>
  <h1>Sign In</h1>
  <label for="username">Email Address</label><input type="text">
  <label for="password">Password</label><input type="password">
  <button id="go">Sign In</button>
  <script>
    document.getElementById('go').onclick = function(){
      var i = document.querySelectorAll('input');
      if (i[0].value && i[1].value) document.body.innerHTML='<a href="/logout">Log Out</a><h1>Dashboard</h1>';
    };
  </script>
</body></html>`;

const routes: Record<string, string> = {
  "/etrakit": ETRAKIT_LOGIN, "/public": PUBLIC_LANDING, "/signed-in": SIGNED_IN,
  "/two-step": TWO_STEP, "/js-submit": JS_SUBMIT, "/late-form": LATE_FORM,
  "/hidden-duplicate": HIDDEN_DUPLICATE, "/sso-handoff": SSO_HANDOFF, "/bare-inputs": BARE_INPUTS,
};
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

await check("identifier-first (two-step) login completes both steps", async () => {
  await page.goto(`http://127.0.0.1:${port}/two-step`);
  const res = await performLogin(page, cred);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
});

await check("two-step login with no credential → no_credential, and nothing is typed", async () => {
  await page.goto(`http://127.0.0.1:${port}/two-step`);
  const res = await performLogin(page, undefined);
  assert.equal(res.status, "no_credential", `got ${res.status}: ${res.message}`);
  assert.equal(await page.locator("#email").inputValue(), "", "must not type into a portal with no credential");
});

await check("a javascript: 'Submit' link is used (Citizenserve shape)", async () => {
  await page.goto(`http://127.0.0.1:${port}/js-submit`);
  const res = await performLogin(page, cred);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
});

await check("a LATE-rendered login form is waited for, not declared missing", async () => {
  await page.goto(`http://127.0.0.1:${port}/late-form`);
  const res = await performLogin(page, cred);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
});

await check("a HIDDEN duplicate login (responsive markup) does not mask the visible one", async () => {
  await page.goto(`http://127.0.0.1:${port}/hidden-duplicate`);
  assert.equal(await loginFormPresent(page), true, "the visible desktop form must be found past the hidden mobile copy");
  const res = await performLogin(page, cred);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
  // The VISIBLE field is the one that got filled — not the hidden copy.
  assert.equal(await page.locator("#mu").count(), 0, "page should have advanced past the login");
});

await check("inputs with NO id/name/placeholder are found by position (ComEd shape)", async () => {
  await page.goto(`http://127.0.0.1:${port}/bare-inputs`);
  const res = await performLogin(page, cred);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
});

await check("reveal walks to the NEXT trigger when the first one is a dead link (SSO hand-off)", async () => {
  await page.goto(`http://127.0.0.1:${port}/sso-handoff`);
  const res = await performLogin(page, cred);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
});

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} loginForm.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll loginForm.dom.smoke checks passed.");
process.exit(0);
