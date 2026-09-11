// A SESSION IS PROVEN BY A POSITIVE SIGNED-IN SIGNAL, NOT BY THE ABSENCE OF A PASSWORD FIELD.
//
// performLogin's success poll used to read:
//     const formGone = !(await loginFormPresent(page));
//     if (formGone || urlMoved) return { ok: true, status: "logged_in", ... };
// and loginFormPresent asks exactly one question: is a password field visible. On an
// IDENTIFIER-FIRST login — Cloudpermit, Okta, Microsoft, essentially every SSO front door —
// step 1 has NO password field, so "the password field is gone" is the NORMAL state of a
// login that has not happened.
//
// Measured: us.cloudpermit.com/gov/login was stamped `last_login_ok_at` "login accepted" and
// counted in the fleet's "26 accessible" having never logged in. Both traced pages were
// titled "Cloudpermit - Log In". The walk was then handed that login form and spent its
// budget planning fills on it — which is how the recipe came to bind installerEmail to
// `#input-email-new`. Baltimore County is the same bug through the URL clause: it followed
// www.baltimorecountymd.gov -> cityworkspro.baltimorecountymd.gov, landed on a SECOND login,
// and the poll's bare `/login/i` did not recognise `/auth/signin` as a login URL.
//
// This pins the fixed rule, against local fixtures only (no live portal):
//   NEGATIVE (kill tests — these FLIP back to "logged in" if `formGone || urlMoved` returns):
//     /gov/login       a real form that RE-RENDERS as an identifier-first step 1 after submit
//     /idp-redirect    a login that hands off to a SECOND login at /auth/signin
//   NEGATIVE (guard):
//     /login-identifier-loop  an identifier-first page whose Next re-renders step 1 forever
//   POSITIVE (guard both ways — the fix must not break a real login):
//     /login-two-step  Next reveals the password, it is filled, the next page says Log Out
//     /app-redirect    a real login that lands on an application page with NO logout control
//
// AND THE THREE THINGS THE FIRST CUT OF THAT FIX GOT WRONG (reviewer findings 5 and 7):
//   POSITIVE (kill test — `register` must NOT be in the shared login-URL predicate):
//     /permits/apply                     the SAME account-less public form, 8 fields, an
//     /permits/register-a-solar-project  Email input, a "Submit Request" button, no password
//                                        — both must reach no_login_required and file nothing
//   NEGATIVE (guard — the hazard `register` was wrongly added for, closed properly):
//     /account/register  step 1 of a registration wizard: 5 fields, no password, and a
//                        "Create Account" control. URL + account signal, so it is refused
//   POSITIVE (kill tests — a login that used to work must not start failing):
//     /postback-login    __doPostBack login: same URL, sign-out is <a onclick>Log Off Account
//     /postback-hidden   same, with sign-out inside a CLOSED dropdown; the identifier we
//                        submitted is rendered as page text, which is the proof
//   NEGATIVE (guard against the signal above being read too eagerly):
//     /postback-reject   the identifier echoed back inside a REFUSAL, password field gone
//     /postback-otp      the identifier echoed back by an OTP step ("we sent a code to …")
//
// Run: npx tsx portal-bot/src/adapters/loginProof.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { performLogin, loginPageShape, looksLikeLoginUrl, isRegistrationUrl, accountAffordancePresent } from "./loginFlow";

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const cred = { username: "permit@example.com", password: "s3cret-never-typed-twice" };

/** Every value sitting in an input on the page right now — so a fixture can prove the
 *  password was not left typed into a field on a page we never logged into. */
async function inputValues(page: Page): Promise<string[]> {
  return await page.evaluate(() => Array.from(document.querySelectorAll("input")).map((i) => (i as HTMLInputElement).value))
    .catch(() => [] as string[]);
}

// (A) THE BRIEF'S IDENTIFIER-FIRST LOOP. No password anywhere, a /login URL, no logout
// control, and Next re-renders the same step. There is no session here and never was.
const IDENTIFIER_LOOP = `<!doctype html><html><head><title>Welcome</title></head><body>
  <h1>Welcome</h1>
  <div id="step"><input id="email"><button id="next">Next</button></div>
  <script>
    document.addEventListener("click", function (e) {
      if (!e.target || e.target.id !== "next") return;
      // Re-render the SAME step — the shape of an identifier-first login that never advances.
      document.getElementById("step").innerHTML = '<input id="email"><button id="next">Next</button>';
    });
  </script>
</body></html>`;

// (B) THE CLOUDPERMIT SHAPE — the kill test. A real login form; submitting it replaces the
// panel with an identifier-first STEP 1 (no password), same URL, same "Log In" title, no
// sign-out control. The password field is gone, so the old poll called this a session.
const RERENDER_LOGIN = `<!doctype html><html><head><title>Cloudpermit - Log In</title></head><body>
  <h1>Log In</h1>
  <div id="panel">
    <input type="email" id="input-email" placeholder="you@example.com">
    <input type="password" id="input-password">
    <button id="signin">Log in</button>
  </div>
  <script>
    document.addEventListener("click", function (e) {
      if (!e.target) return;
      if (e.target.id === "signin") {
        document.getElementById("panel").innerHTML =
          '<input type="email" id="input-email-new" placeholder="you@example.com"><button id="next">Next</button>';
      } else if (e.target.id === "next") {
        document.getElementById("panel").innerHTML =
          '<input type="email" id="input-email-new" placeholder="you@example.com"><button id="next">Next</button>';
      }
    });
  </script>
</body></html>`;

// (C) THE BALTIMORE SHAPE — the second kill test. A real login that hands off to ANOTHER
// login, at a URL containing "signin" rather than "login". The old poll's bare /login/i saw
// a URL that had moved and did not say "login", and reported the run signed in.
const IDP_HANDOFF = `<!doctype html><html><head><title>County Permits</title></head><body>
  <h1>Sign In</h1>
  <input type="text" id="u" name="username"><input type="password" id="p" name="password">
  <button id="go">Sign In</button>
  <script>
    document.getElementById("go").onclick = function () { location.href = "/auth/signin"; };
  </script>
</body></html>`;

const SECOND_LOGIN = `<!doctype html><html><head><title>Identity - Sign In</title></head><body>
  <h1>Sign in to continue</h1>
  <input type="text" id="u2" name="username"><input type="password" id="p2" name="password">
  <button id="go2">Sign In</button>
</body></html>`;

// (D) POSITIVE: the brief's identifier-first page, but Next actually reveals the password
// step, and signing in lands on a page with a Log Out control.
const TWO_STEP_REAL = `<!doctype html><html><head><title>Portal - Log In</title></head><body>
  <h1>Welcome</h1>
  <div id="step1"><input id="email"><button id="next">Next</button></div>
  <div id="step2" style="display:none"><input type="password" id="pw"><button id="go">Sign In</button></div>
  <script>
    document.getElementById("next").onclick = function () {
      if (!document.getElementById("email").value) return;
      document.getElementById("step1").style.display = "none";
      document.getElementById("step2").style.display = "block";
    };
    document.getElementById("go").onclick = function () {
      if (document.getElementById("pw").value) document.body.innerHTML = '<a href="/logout">Log Out</a><h1>Dashboard</h1>';
    };
  </script>
</body></html>`;

// (E) POSITIVE, AND THE ONE THAT GUARDS THE OTHER WAY: a working login whose destination has
// NO sign-out control the engine can see — plenty of portals put it behind an avatar menu.
// The move to a non-login application URL is the proof here, and it must still count.
const APP_REDIRECT = `<!doctype html><html><head><title>City Permits - Log In</title></head><body>
  <h1>Sign In</h1>
  <input type="text" id="u" name="username"><input type="password" id="p" name="password">
  <button id="go">Sign In</button>
  <script>
    document.getElementById("go").onclick = function () {
      if (document.getElementById("p").value) location.href = "/dashboard";
    };
  </script>
</body></html>`;

const DASHBOARD = `<!doctype html><html><head><title>City Permits - My Applications</title></head><body>
  <h1>My Applications</h1>
  <a href="/apply">Create Application</a> <a href="/permits">My Permits</a>
  <p>You have 3 permits in review.</p>
</body></html>`;

// (F) THE PUBLIC APPLICATION FORM — FINDING 5's kill test. An account-less jurisdiction
// form: 8 fields, an Email input, a "Submit Request" button (type=submit, which is a
// NEXT_STEP_CANDIDATE), and no password field anywhere. Served at TWO paths, byte for byte
// identical, because that is how the regression was demonstrated: with `register` in the
// shared login-URL predicate the /permits/apply copy proceeded as no_login_required and the
// /permits/register-a-solar-project copy came back no_credential, asking the operator for a
// username and password for a portal that has no accounts. WITH a credential it is worse —
// the two-step branch fills the Email field and clicks "Submit Request", filing a stranger's
// permit request — which is what #filed pins.
const PUBLIC_APPLICATION = `<!doctype html><html><head><title>Apply for a Solar Permit</title></head><body>
  <h1>Solar Permit Request</h1>
  <label for="pn">Permit Number</label><input id="pn" name="permit_number">
  <label for="la">Located at</label><input id="la" name="located_at">
  <label for="em">Email</label><input id="em" name="email" type="email">
  <label for="ph">Phone</label><input id="ph" name="phone">
  <label for="fn">First Name</label><input id="fn" name="first_name">
  <label for="ln">Last Name</label><input id="ln" name="last_name">
  <label for="ct">City</label><input id="ct" name="city">
  <label for="st">State</label><input id="st" name="state">
  <button type="submit" id="send" onclick="document.getElementById('filed').textContent='FILED';return false;">Submit Request</button>
  <div id="filed">not-filed</div>
</body></html>`;

// (G) STEP 1 OF A REGISTRATION WIZARD — the hazard `register` was added to the shared
// predicate FOR, and the one page in the login family that passes applicationShapedForm:
// five fillable fields, no password (that is step 2), and an account control saying so.
// Must be refused, without the URL alone being enough to refuse (F) above.
const REGISTER_WIZARD = `<!doctype html><html><head><title>Create an Account</title></head><body>
  <h1>Create an Account</h1>
  <p>Step 1 of 2 — tell us who you are. You will choose a password on the next step.</p>
  <label for="fn">First Name</label><input id="fn" name="first_name">
  <label for="ln">Last Name</label><input id="ln" name="last_name">
  <label for="em">Email</label><input id="em" name="email" type="email">
  <label for="ph">Phone</label><input id="ph" name="phone">
  <label for="co">Company</label><input id="co" name="company">
  <button type="button" id="createacct">Create Account</button>
</body></html>`;

// (H) THE ASP.NET POSTBACK LOGIN — FINDING 7's kill test. Authenticates to the SAME URL and
// renders sign-out as <a onclick="doLogout()">Log Off Account</a>: no logout token in href or
// id (the css candidates miss it) and one word longer than "Log Off" (the old ^exact$ text
// fallback rejected it). It used to work; the positive-proof rule made it burn the 15s
// timeout and report still_on_login.
const POSTBACK_LOGOFF = `<!doctype html><html><head><title>Permits - Login</title></head><body>
  <h1>Sign In</h1>
  <div id="panel">
    <input type="text" id="u" name="username">
    <input type="password" id="p" name="password">
    <button type="button" id="go">Log In</button>
  </div>
  <script>
    document.getElementById("go").onclick = function () {
      if (!document.getElementById("p").value) return;
      document.body.innerHTML =
        '<div id="hdr"><a href="#" onclick="doLogout()">Log Off Account</a></div>' +
        '<h1>My Permits</h1><p>You have 2 applications in progress.</p>';
    };
  </script>
</body></html>`;

// (I) THE SAME POSTBACK, WITH SIGN-OUT SHUT AWAY in a closed account dropdown — so there is
// no visible chrome signal at all and the URL never moves. The proof here is the second
// signal: the password field is gone AND the identifier we submitted is now page TEXT.
const POSTBACK_HIDDEN = `<!doctype html><html><head><title>City Permits - Sign In</title></head><body>
  <h1>Sign In</h1>
  <div id="panel">
    <input type="text" id="u" name="username">
    <input type="password" id="p" name="password">
    <button type="button" id="go">Log In</button>
  </div>
  <script>
    document.getElementById("go").onclick = function () {
      if (!document.getElementById("p").value) return;
      var who = document.getElementById("u").value;
      document.body.innerHTML =
        '<div class="dropdown"><button type="button" id="acct">Account</button>' +
        '<ul class="dropdown-menu" style="display:none"><li><a href="#" onclick="doLogout()">Log Off</a></li></ul></div>' +
        '<h1>My Permits</h1><p>Signed in as ' + who + '</p>';
    };
  </script>
</body></html>`;

// (J) THE IDENTIFIER ECHOED BY A REFUSAL. Password field gone, identifier on the page, no
// sign-out control — every surface condition of (I) — and no session whatsoever.
const POSTBACK_REJECT = `<!doctype html><html><head><title>City Permits - Sign In</title></head><body>
  <h1>Sign In</h1>
  <div id="panel">
    <input type="text" id="u" name="username">
    <input type="password" id="p" name="password">
    <button type="button" id="go">Log In</button>
  </div>
  <script>
    document.getElementById("go").onclick = function () {
      var who = document.getElementById("u").value;
      document.body.innerHTML = '<h1>Sign In</h1><p>We could not find an account for ' + who + '. Please try again.</p>';
    };
  </script>
</body></html>`;

// (K) THE IDENTIFIER ECHOED BY AN OTP STEP. The subtler one: no error vocabulary anywhere,
// the password field is legitimately gone, and detectChallengeFrame sees nothing because a
// plain code box is not a CAPTCHA iframe. It is still not a session.
const POSTBACK_OTP = `<!doctype html><html><head><title>City Permits - Sign In</title></head><body>
  <h1>Sign In</h1>
  <div id="panel">
    <input type="text" id="u" name="username">
    <input type="password" id="p" name="password">
    <button type="button" id="go">Log In</button>
  </div>
  <script>
    document.getElementById("go").onclick = function () {
      var who = document.getElementById("u").value;
      document.body.innerHTML = '<h1>Check your email</h1><p>We sent a code to ' + who +
        '. Enter it below to continue.</p><input type="text" id="otp"><button type="button" id="verify">Verify</button>';
    };
  </script>
</body></html>`;

const routes: Record<string, string> = {
  "/login-identifier-loop": IDENTIFIER_LOOP,
  "/gov/login": RERENDER_LOGIN,
  "/idp-redirect": IDP_HANDOFF,
  "/auth/signin": SECOND_LOGIN,
  "/login-two-step": TWO_STEP_REAL,
  "/app-redirect": APP_REDIRECT,
  "/dashboard": DASHBOARD,
  // The SAME public form at two paths — the whole point of the pair.
  "/permits/apply": PUBLIC_APPLICATION,
  "/permits/register-a-solar-project": PUBLIC_APPLICATION,
  "/account/register": REGISTER_WIZARD,
  "/postback-login": POSTBACK_LOGOFF,
  "/postback-hidden": POSTBACK_HIDDEN,
  "/postback-reject": POSTBACK_REJECT,
  "/postback-otp": POSTBACK_OTP,
};
const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(routes[(q.url || "").split("?")[0]] ?? "<html><body>?</body></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
// Playwright's bundler rewrites function declarations inside page.evaluate through a __name
// helper that does not exist in the page — without this shim the login flow's DOM scans throw
// and every detector silently "finds nothing".
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();

// --- the URL predicate the poll and the fill guard now share ------------------------------
await check("looksLikeLoginUrl covers signin/logon, not just the word 'login'", async () => {
  for (const u of ["https://h/gov/login", "https://h/auth/signin", "https://h/Sign-In", "https://h/Logon.aspx"]) {
    assert.equal(looksLikeLoginUrl(u), true, `${u} should read as a login URL`);
  }
  // FINDING 5. `register` lived in this predicate for one commit, and this predicate gates
  // far more than the success poll — loginWordingPresent returns true on the URL alone
  // (satisfying the two-step-login branch) and the same call sets `onLoginUrl` (suppressing
  // no_login_required). Every post-login landing carrying the substring came with it.
  for (const u of [
    "https://h/dashboard", "https://h/permits/apply", "https://h/authenticated/home",
    "https://h/account/register", "https://h/permits/register-a-solar-project",
    "https://h/registered/home", "https://h/RegisteredUser/Dashboard", "https://h/Account/Home?registered=true",
  ]) {
    assert.equal(looksLikeLoginUrl(u), false, `${u} must NOT read as a login URL`);
  }
});

await check("isRegistrationUrl is word-bounded, so a 'registered' landing is not a registration", async () => {
  for (const u of ["https://h/account/register", "https://h/permits/register-a-solar-project", "https://h/Registration.aspx"]) {
    assert.equal(isRegistrationUrl(u), true, `${u} should read as a registration URL`);
  }
  for (const u of ["https://h/registered/home", "https://h/RegisteredUser/Dashboard", "https://h/Account/Home?registered=true", "https://h/gov/login", "https://h/dashboard"]) {
    assert.equal(isRegistrationUrl(u), false, `${u} must NOT read as a registration URL`);
  }
});

// --- NEGATIVE (guard): the brief's identifier-first loop -----------------------------------
await check("identifier-first page that never advances → ok:false, still_on_login (never logged_in)", async () => {
  await page.goto(`http://127.0.0.1:${port}/login-identifier-loop`);
  const res = await performLogin(page, cred);
  assert.notEqual(res.status, "logged_in", `a page with no password field and no sign-out control must never be "logged in" (got: ${res.message})`);
  assert.equal(res.status, "still_on_login", `got ${res.status}: ${res.message}`);
  assert.equal(res.ok, false, "an unfinished login must be an ACCESS failure, so the walk never starts");
  // The credential's PASSWORD must never be sitting in a field on a page we never got past.
  const vals = await inputValues(page);
  assert.equal(vals.includes(cred.password), false, "the password must not be typed into an identifier-first step 1");
});

await check("loginPageShape names an identifier-first login as a login page", async () => {
  await page.goto(`http://127.0.0.1:${port}/login-identifier-loop`);
  const shape = await loginPageShape(page);
  assert.notEqual(shape, "", "an identifier field + Next + a /login URL is a login page, not an application form");
});

// --- NEGATIVE (KILL TEST 1): the Cloudpermit re-render ------------------------------------
await check("KILL TEST — login re-renders as identifier-first step 1 → still_on_login, NOT logged_in", async () => {
  await page.goto(`http://127.0.0.1:${port}/gov/login`);
  const res = await performLogin(page, cred);
  assert.notEqual(res.status, "logged_in", `the password field being gone is not a session (got: ${res.message})`);
  assert.equal(res.status, "still_on_login", `got ${res.status}: ${res.message}`);
  assert.equal(res.ok, false);
  assert.match(res.message, /identifier-first|two-step|still showing a login/i, "the message must say WHY, so the next reader does not re-diagnose it");
  const vals = await inputValues(page);
  assert.equal(vals.includes(cred.password), false, "no password left typed on the re-rendered login step");
});

await check("loginPageShape still calls the re-rendered page a login page", async () => {
  const shape = await loginPageShape(page);
  assert.notEqual(shape, "", "an identifier field + Next on /gov/login is a login page — the field planner must not be handed it");
});

// --- NEGATIVE (KILL TEST 2): the Baltimore hand-off to a second login ----------------------
await check("KILL TEST — login hands off to a SECOND login at /auth/signin → ok:false", async () => {
  await page.goto(`http://127.0.0.1:${port}/idp-redirect`);
  const res = await performLogin(page, cred);
  assert.notEqual(res.status, "logged_in", `a URL that moved to another sign-in page is not a session (got: ${res.message})`);
  assert.equal(res.ok, false, "a second login page must be an ACCESS failure, not a green run");
  assert.match(page.url(), /\/auth\/signin/, "fixture sanity: the hand-off should have happened");
});

// --- POSITIVE (guard both ways): a real two-step login still succeeds ----------------------
await check("a REAL identifier-first login (Next reveals the password) → logged_in", async () => {
  await page.goto(`http://127.0.0.1:${port}/login-two-step`);
  const res = await performLogin(page, cred);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
  assert.equal(res.ok, true);
});

// --- POSITIVE (guard both ways): a real login with NO logout control still succeeds --------
await check("a real login landing on an application page with NO logout control → logged_in", async () => {
  await page.goto(`http://127.0.0.1:${port}/app-redirect`);
  const res = await performLogin(page, cred);
  assert.equal(res.status, "logged_in", `moving off the login page to an application page is proof too — got ${res.status}: ${res.message}`);
  assert.equal(res.ok, true);
  assert.match(page.url(), /\/dashboard/);
});

await check("loginPageShape does NOT call an application page a login page", async () => {
  await page.goto(`http://127.0.0.1:${port}/dashboard`);
  assert.equal(await loginPageShape(page), "", "a dashboard with no identifier field and no login URL must stay open for business");
});

// --- FINDING 5 (KILL TEST): the same public form, at two paths, must behave identically ----
// Put `register` back into looksLikeLoginUrl and BOTH of these fail: the /permits/apply copy
// keeps working and the register-shaped copy comes back no_credential — an operator sent to
// find a password for a portal that has no accounts.
for (const path of ["/permits/apply", "/permits/register-a-solar-project"]) {
  await check(`an account-less public form at ${path} → no_login_required, and NOTHING is filed`, async () => {
    await page.goto(`http://127.0.0.1:${port}${path}`);
    const res = await performLogin(page, cred);
    // ASSERTED BEFORE THE STATUS, because it is the worse failure and an assertion that runs
    // second never runs at all. Measured with `register` put back into looksLikeLoginUrl: the
    // two-step-login branch treated this page as step 1 of an identifier-first login, typed
    // the username into the Email field and clicked "Submit Request" — filing a stranger's
    // permit request — and only THEN gave up with "on a login page but the login form could
    // not be located".
    const filed = await page.locator("#filed").textContent().catch(() => "");
    assert.equal((filed ?? "").trim(), "not-filed", "a public application form must never be submitted while looking for a login");
    const vals = await inputValues(page);
    assert.equal(vals.includes(cred.username), false, "the username must not be typed into a public application form");
    assert.equal(vals.includes(cred.password), false, "the password must not be typed into a public application form");
    assert.equal(res.status, "no_login_required", `got ${res.status}: ${res.message}`);
    assert.equal(res.ok, true, "a portal with no accounts is not an access failure");
  });
}

// --- FINDING 5 (guard the other way): the hazard `register` was added for is still closed --
await check("step 1 of a REGISTRATION wizard is refused, not waved through as a public form", async () => {
  await page.goto(`http://127.0.0.1:${port}/account/register`);
  const res = await performLogin(page, cred);
  assert.notEqual(res.status, "no_login_required", `a signup form is not a public application (got: ${res.message})`);
  assert.equal(res.ok, false, "the walk must not start on a registration wizard");
  assert.match(res.message, /REGISTRATION wizard/i, "the message must name what it saw, so nobody re-diagnoses it");
  const vals = await inputValues(page);
  assert.equal(vals.includes(cred.username), false, "nothing is typed into a signup form");
  assert.equal(vals.includes(cred.password), false, "nothing is typed into a signup form");
});

await check("accountAffordancePresent separates the two: signup control on one, nothing on the other", async () => {
  await page.goto(`http://127.0.0.1:${port}/account/register`);
  assert.match(await accountAffordancePresent(page), /create account/i, "the wizard's own Create Account button is the account signal");
  await page.goto(`http://127.0.0.1:${port}/permits/register-a-solar-project`);
  assert.equal(await accountAffordancePresent(page), "", "'Submit Request' is not an account signal — the register-shaped URL is only half the evidence");
});

// --- FINDING 7 (KILL TEST): an ASP.NET postback login must still succeed ------------------
await check("KILL TEST — postback login, sign-out is 'Log Off Account' with no href/id token → logged_in", async () => {
  await page.goto(`http://127.0.0.1:${port}/postback-login`);
  const res = await performLogin(page, cred);
  assert.equal(res.status, "logged_in", `a ^exact$ sign-out text match rejects "Log Off Account" and burns the timeout — got ${res.status}: ${res.message}`);
  assert.equal(res.ok, true);
});

await check("KILL TEST — postback login whose sign-out is in a CLOSED dropdown → logged_in by identity echo", async () => {
  await page.goto(`http://127.0.0.1:${port}/postback-hidden`);
  const res = await performLogin(page, cred);
  assert.equal(res.status, "logged_in", `no URL move and no visible chrome: the proof is the password field being gone and the identifier rendered as text — got ${res.status}: ${res.message}`);
  assert.equal(res.ok, true);
  assert.match(res.message, /identifier as page text/i, "say which signal proved it");
});

// --- FINDING 7 (guard): the echo signal must not be read too eagerly ----------------------
await check("the identifier echoed inside a REFUSAL is not a session", async () => {
  await page.goto(`http://127.0.0.1:${port}/postback-reject`);
  const res = await performLogin(page, cred);
  assert.notEqual(res.status, "logged_in", `"We could not find an account for <you>" echoes the identifier and proves nothing (got: ${res.message})`);
  assert.equal(res.ok, false);
});

await check("the identifier echoed by an OTP step is not a session", async () => {
  await page.goto(`http://127.0.0.1:${port}/postback-otp`);
  const res = await performLogin(page, cred);
  assert.notEqual(res.status, "logged_in", `"We sent a code to <you>" has no error wording, no password field and no session (got: ${res.message})`);
  assert.equal(res.ok, false);
});

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} loginProof.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll loginProof.dom.smoke checks passed.");
process.exit(0);
