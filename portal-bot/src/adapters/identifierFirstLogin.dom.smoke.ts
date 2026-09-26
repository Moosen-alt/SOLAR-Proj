// TYLER PORTICO / OKTA IDENTIFIER-FIRST LOGIN, THE SECOND-FACTOR PARK, AND ACCELA'S IFRAME LOGIN
// — against SYNTHETIC real-shaped replicas (fake hosts, fake data; no live portal, nothing copied
// from a capture). The portal-test-prep blockers B2 / B3 / B6 and the Lee County frame login.
//
// The replica mirrors the structure the operator described for Tyler's sign-in (Okta Identity
// Engine on a CUSTOM identity domain — no okta.com anywhere):
//   page 1  "Sign in to community access services": Email + Next + "Keep me signed in" + social
//           "Sign in with Google/Microsoft/Apple" + Help + "Unlock account?" + "Create an account"
//           (+ an ordinary footer link whose href says "account" — what the reveal's href
//           catch-all would have clicked first under the old order)
//   page 2  "Verify with your password": Password + Verify + "Verify with something else" +
//           "Forgot password?" + "Back to sign in"; the page title says "Authentication" and the
//           authorize URL's redirect_uri ends in /verify-callback (both used to read as MFA)
//   factor  "Verify with your email" / "Send me an email" (Okta's email authenticator)
// Every never-click control leads to a TRAP: a fake third-party / chore page WITH A PASSWORD FORM,
// whose every request is counted — reaching one is the failure, typing into one is the leak.
//
//   MUST-PASS    the two-step login completes (logged_in) with no trap reached and no chore
//                clicked; a plain one-page login; the Accela login inside a cross-origin IFRAME;
//                a landing page whose real form hides behind "Log In" (the newsletter Email box
//                beside it is never typed into); a headed-style park that the person completes.
//   MUST-EXCLUDE no social/help/unlock/create/forgot/keep-signed-in/"verify with something else"
//                click; the factor screen is never typed into and its "Send me an email" never
//                pressed; a wrong password stays a FAILED login (still_on_login, not MFA); a
//                factor on a headless run returns mfa_captcha promptly and NOT the "likely
//                rejected" message that marks a credential stale; the credential is never typed
//                into a consumer identity provider's page; neither the username nor the password
//                appears in any log line or result message.
//
// Run: npx tsx portal-bot/src/adapters/identifierFirstLogin.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium, type BrowserContext, type Page } from "playwright";
import { performLogin } from "./loginFlow";

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---- the log net: every line this process or any page prints, checked for the secrets ----------
const logLines: string[] = [];
for (const level of ["log", "warn", "error", "info"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logLines.push(args.map(String).join(" ")); orig(...args); };
}

const USER = "okta.tester@example.test";
const GOOD_PW = "Corr3ct-Horse-Batt3ry";
const MFA_PW = "Needs-A-Second-F4ctor";
const BAD_PW = "Wr0ng-Pa55word";

const IDP = "https://identity.portico-example.test";
const TENANT = "https://tenant.energov-example.test";
const AUTHORIZE = `${IDP}/oauth2/default/v1/authorize?client_id=0oaFAKEFAKE&response_type=code&scope=openid&state=abc123`
  + `&redirect_uri=${encodeURIComponent(`${TENANT}/apps/selfservice/verify-callback`)}`;

// ---- trap accounting: any request here means a never-click control was followed ---------------
const trapHits: string[] = [];
const TRAP_PAGE = (who: string) => `<!doctype html><html><head><title>${who} - Sign in</title></head><body>
  <h1>${who}</h1><label for="u">Email</label><input id="u" type="email">
  <label for="p">Password</label><input id="p" type="password"><button id="b">Sign In</button>
</body></html>`;

const OKTA_PAGE = `<!doctype html><html><head><title>Community Access Services - Authentication</title>
<style>body{font-family:sans-serif} .button{display:inline-block;padding:6px 12px;margin:4px;border:1px solid #888} .hide{display:none}</style>
</head><body>
<div id="okta-sign-in" class="auth-container main-container">
  <div class="okta-sign-in-header auth-header"><span>Community Access Services</span></div>
  <div class="auth-content"><div class="auth-content-inner" id="inner"></div></div>
</div>
<footer><a href="https://www.portico-example.test/account-services">About community access accounts</a></footer>
<script>
  window.__clicks = [];
  document.addEventListener('click', function (e) {
    var t = e.target; var el = t && t.closest ? (t.closest('a,button,input,label') || t) : t;
    window.__clicks.push((el.getAttribute && (el.getAttribute('data-se') || el.id)) || (el.textContent || el.value || '').trim().slice(0, 40));
  }, true);
  var inner = document.getElementById('inner');
  var who = '';
  function page1() {
    inner.innerHTML =
      '<form class="ion-form o-form" data-se="o-form" id="f1" novalidate>' +
      '<h2 class="okta-form-title o-form-head" data-se="o-form-head">Sign in to community access services</h2>' +
      '<div class="o-form-fieldset"><label for="input28">Email address</label>' +
      '<input type="text" name="identifier" id="input28" autocomplete="username"></div>' +
      '<div class="o-form-fieldset"><input type="checkbox" name="rememberMe" id="input36" data-se="remember">' +
      '<label for="input36">Keep me signed in</label></div>' +
      '<input class="button button-primary" type="submit" value="Next" data-type="save" data-se="next">' +
      '</form>' +
      '<div class="sign-in-with-idp"><div class="separation-line"><span>OR</span></div>' +
      '<a data-se="social-auth-google-button" class="button social-auth-button social-auth-google-button" href="https://accounts.google.com/o/oauth2/v2/auth?client_id=x">Sign in with Google</a>' +
      '<a data-se="social-auth-microsoft-button" class="button social-auth-button social-auth-microsoft-button" href="/sso/idps/0oaMSFAKE?stateToken=x">Sign in with Microsoft</a>' +
      '<a data-se="social-auth-apple-button" class="button social-auth-button social-auth-apple-button" href="https://appleid.apple.com/auth/authorize?client_id=x">Sign in with Apple</a>' +
      '</div>' +
      '<div class="auth-footer">' +
      '<a href="/signin/unlock" class="link js-unlock" data-se="unlock">Unlock account?</a> ' +
      '<a href="/help/login" class="link js-help" data-se="help">Help</a> ' +
      '<a href="/signin/register" class="link" data-se="enroll">Create an account</a>' +
      '</div>';
    document.getElementById('f1').onsubmit = function (e) {
      e.preventDefault();
      var v = document.getElementById('input28').value;
      if (!v) return;
      who = v; setTimeout(page2, 300);
    };
  }
  function page2(error) {
    inner.innerHTML =
      '<form class="ion-form o-form" data-se="o-form" id="f2" novalidate>' +
      '<h2 class="okta-form-title o-form-head">Verify with your password</h2>' +
      '<div class="identifier-container"><span class="identifier">' + who + '</span></div>' +
      (error ? '<div class="o-form-error-container" role="alert"><p>' + error + '</p></div>' : '') +
      '<div class="o-form-fieldset"><label for="input60">Password</label>' +
      '<input type="password" name="credentials.passcode" id="input60" autocomplete="current-password"></div>' +
      '<input class="button button-primary" type="submit" value="Verify" data-se="verify">' +
      '</form>' +
      '<div class="auth-footer">' +
      '<a href="#" class="link js-switchAuthenticator" data-se="switchAuthenticator">Verify with something else</a> ' +
      '<a href="/signin/forgot-password" class="link" data-se="forgot-password">Forgot password?</a> ' +
      '<a href="#" class="link js-cancel" data-se="cancel">Back to sign in</a>' +
      '</div>';
    document.querySelector('[data-se=switchAuthenticator]').onclick = function (e) { e.preventDefault(); window.__switched = true; };
    document.querySelector('[data-se=cancel]').onclick = function (e) { e.preventDefault(); page1(); };
    document.getElementById('f2').onsubmit = function (e) {
      e.preventDefault();
      var pw = document.getElementById('input60').value;
      if (pw === ${JSON.stringify(GOOD_PW)}) { setTimeout(function () { location.href = ${JSON.stringify(`${TENANT}/apps/selfservice#/home`)}; }, 400); return; }
      if (pw === ${JSON.stringify(MFA_PW)}) { setTimeout(factor, 400); return; }
      setTimeout(function () { page2('Password is incorrect'); }, 400);
    };
  }
  function factor() {
    inner.innerHTML =
      '<form class="ion-form o-form" data-se="o-form" id="f3" novalidate>' +
      '<h2 class="okta-form-title o-form-head">Verify with your email</h2>' +
      '<div class="identifier-container"><span class="identifier">' + who + '</span></div>' +
      '<p>Send a verification email by clicking on "Send me an email".</p>' +
      '<input class="button button-primary" type="submit" value="Send me an email" data-se="send-email">' +
      '</form>' +
      '<div class="auth-footer">' +
      '<a href="#" class="link js-switchAuthenticator" data-se="switchAuthenticator">Verify with something else</a> ' +
      '<a href="#" class="link js-cancel" data-se="cancel">Back to sign in</a>' +
      '</div>';
    document.getElementById('f3').onsubmit = function (e) {
      e.preventDefault(); window.__emailRequested = true;
      inner.innerHTML = '<h2>Verify with your email</h2><label for="code">Enter a code</label>' +
        '<input type="text" id="code" name="credentials.passcode" autocomplete="one-time-code"><input type="submit" value="Verify">';
    };
  }
  // What the PERSON at the window does (the test plays them): the factor is completed and Okta
  // redirects back to the tenant.
  window.__operatorCompletesFactor = function () { location.href = ${JSON.stringify(`${TENANT}/apps/selfservice#/home`)}; };
  setTimeout(page1, 250); // Okta's widget paints after load
</script>
</body></html>`;

const TENANT_HOME = `<!doctype html><html><head><title>Community Development Hub</title></head><body>
  <nav><a href="#/home">Home</a> <a href="#/logout" id="logout">Logout</a></nav>
  <h1>Community Development Hub</h1><a href="#/apply">Apply</a>
</body></html>`;

async function routeReplicas(context: BrowserContext): Promise<void> {
  await context.route(`${IDP}/**`, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/oauth2/")) return route.fulfill({ contentType: "text/html", body: OKTA_PAGE });
    trapHits.push(`${u.host}${u.pathname}`);
    return route.fulfill({ contentType: "text/html", body: TRAP_PAGE(`trap ${u.pathname}`) });
  });
  await context.route(`${TENANT}/**`, (route) => route.fulfill({ contentType: "text/html", body: TENANT_HOME }));
  for (const trapHost of ["https://accounts.google.com", "https://appleid.apple.com", "https://www.portico-example.test"]) {
    await context.route(`${trapHost}/**`, (route) => {
      const u = new URL(route.request().url());
      if (route.request().resourceType() === "document") trapHits.push(`${u.host}${u.pathname}`);
      return route.fulfill({ contentType: "text/html", body: TRAP_PAGE(`trap ${u.host}`) });
    });
  }
}

// ---- Accela ACA login inside a CROSS-ORIGIN IFRAME (Lee County's shape) + two local pages ------
const localHits: string[] = [];
let port = 0;
const LEE_MAIN = () => `<!doctype html><html><head><title>Accela Citizen Access</title></head><body>
  <h1>eConnect</h1><p>Sign in to apply for permits.</p>
  <iframe id="loginFrame" name="LoginFrame" src="http://localhost:${port}/LEECO/login-frame" style="width:640px;height:420px;border:0"></iframe>
</body></html>`;
const LEE_FRAME = () => `<!doctype html><html><body>
  <form onsubmit="return false">
    <label for="username">USERNAME OR EMAIL</label><input id="username" type="text">
    <label for="passwordRequired">PASSWORD</label><input id="passwordRequired" type="password">
    <label><input type="checkbox" id="rememberMe"> Remember me on this device</label>
    <button type="button" id="signin">SIGN IN</button>
    <a href="/LEECO/forgot-password">Forgot Password?</a> <a href="/LEECO/register">Register for an Account</a>
  </form>
  <script>
    document.getElementById('signin').onclick = function () {
      if (document.getElementById('username').value && document.getElementById('passwordRequired').value)
        window.top.location.href = 'http://127.0.0.1:${port}/LEECO/Dashboard.aspx?remember=' + document.getElementById('rememberMe').checked;
    };
  </script>
</body></html>`;
const LEE_DASH = `<!doctype html><html><head><title>Accela Citizen Access - Dashboard</title></head><body>
  <a href="/LEECO/Logout.aspx" id="logout">Logout</a><h1>My Records</h1></body></html>`;
// A plain one-page login.
const PLAIN = `<!doctype html><html><head><title>Permit Portal - Log In</title></head><body>
  <h1>Log In</h1><label for="u">Username</label><input id="u" name="username" type="text">
  <label for="p">Password</label><input id="p" name="password" type="password">
  <button id="go" type="button">Log In</button>
  <script>document.getElementById('go').onclick=function(){ if(document.getElementById('p').value) location.href='/home'; };</script>
</body></html>`;
const PLAIN_HOME = `<!doctype html><html><head><title>Portal Home</title></head><body><a href="/logout">Log Out</a><h1>My Permits</h1></body></html>`;
// A LANDING page: the real login hides behind a header "Log In" link, and a newsletter Email +
// Subscribe box sits beside it. Identifier-first must NOT fire here (the preReveal condition).
const LANDING = `<!doctype html><html><head><title>City Permit Center</title></head><body>
  <header><a href="#" id="hdrLogin">Log In</a></header>
  <h1>Permit Center</h1>
  <div id="news"><label for="nl">Email</label><input id="nl" type="email" name="newsletterEmail">
  <button type="submit" id="sub" onclick="window.__subscribed=true">Subscribe</button></div>
  <div id="slot"></div>
  <script>
    document.getElementById('hdrLogin').onclick = function (e) {
      e.preventDefault();
      document.getElementById('slot').innerHTML = '<label for="lu">Username</label><input id="lu" name="username" type="text">' +
        '<input id="lp" name="password" type="password"><button id="lb" type="button">Sign In</button>';
      // Signs in IN PLACE, so the newsletter box can still be read afterwards.
      document.getElementById('lb').onclick = function () {
        if (document.getElementById('lp').value) document.getElementById('slot').innerHTML = '<a href="/logout">Log Out</a> Signed in';
      };
    };
  </script>
</body></html>`;

const server = http.createServer((q, r) => {
  const url = q.url || "";
  const send = (body: string) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(body); };
  if (url.startsWith("/LEECO/Login.aspx")) return send(LEE_MAIN());
  if (url.startsWith("/LEECO/login-frame")) return send(LEE_FRAME());
  if (url.startsWith("/LEECO/Dashboard.aspx")) return send(LEE_DASH);
  if (url.startsWith("/plain-login")) return send(PLAIN);
  if (url.startsWith("/permit-center")) return send(LANDING);
  if (url.startsWith("/home")) return send(PLAIN_HOME);
  localHits.push(url);
  return send("<html><body>not here</body></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
port = (server.address() as { port: number }).port;
// The iframe is served from `localhost` while the page is `127.0.0.1` — a different origin.
const localhostServer = http.createServer((q, r) => server.emit("request", q, r));
await new Promise<void>((r) => localhostServer.listen(port, "localhost", () => r()).on("error", () => r()));

const browser = await chromium.launch();
async function freshPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  await routeReplicas(context);
  const page = await context.newPage();
  page.on("console", (m) => logLines.push(`[page] ${m.text()}`));
  return { context, page };
}
const clicksOn = async (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __clicks?: string[] }).__clicks ?? []).catch(() => []);
const NEVER = /social-auth|unlock|help|enroll|forgot|remember|switchAuthenticator|cancel|send-email/;
const REJECTED_MARKS_STALE = /still on the login form|username\/password was likely rejected|login failed/i; // backend/src/autoLearn.ts
const results: string[] = [];

await check("MUST-PASS: Tyler/Okta two-step — email + Next, then password + Verify → logged_in on the tenant", async () => {
  trapHits.length = 0;
  const { context, page } = await freshPage();
  await page.goto(AUTHORIZE);
  const res = await performLogin(page, { username: USER, password: GOOD_PW });
  results.push(res.message);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
  assert.ok(page.url().startsWith(TENANT), `should land on the tenant, is on ${page.url()}`);
  // The Okta document (and its click log) is gone once the tenant loads — trapHits carries the
  // proof here; the next check reads the click log on a run that stays on the Okta document.
  assert.deepEqual(trapHits, [], `a never-click control was followed: ${trapHits.join(", ")}`);
  await context.close();
});

await check("MUST-EXCLUDE: on page 1 and page 2 nothing but Email/Next/Password/Verify is touched", async () => {
  trapHits.length = 0;
  const { context, page } = await freshPage();
  await page.goto(AUTHORIZE);
  // A wrong password keeps us on the Okta document, so its click log survives to be read.
  const res = await performLogin(page, { username: USER, password: BAD_PW });
  results.push(res.message);
  const clicks = await clicksOn(page);
  assert.deepEqual(clicks.filter((c) => NEVER.test(c)), [], `never-click controls were clicked: ${clicks.join(", ")}`);
  assert.deepEqual(trapHits, [], `a trap was reached: ${trapHits.join(", ")}`);
  assert.equal(await page.evaluate(() => (window as unknown as { __switched?: boolean }).__switched === true), false, "'Verify with something else' must never be pressed");
  await context.close();
});

await check("MUST-EXCLUDE: a WRONG password stays a failed login (still_on_login) — not MFA, not a park", async () => {
  const { context, page } = await freshPage();
  await page.goto(AUTHORIZE);
  const res = await performLogin(page, { username: USER, password: BAD_PW }, { parkMs: 60_000 });
  results.push(res.message);
  assert.equal(res.status, "still_on_login", `got ${res.status}: ${res.message}`);
  await context.close();
});

await check("MUST-EXCLUDE: a second factor on a HEADLESS run → mfa_captcha promptly, never the 'likely rejected' stale mark", async () => {
  const { context, page } = await freshPage();
  await page.goto(AUTHORIZE);
  const t0 = Date.now();
  const res = await performLogin(page, { username: USER, password: MFA_PW }); // defaults: headless → no park
  results.push(res.message);
  assert.equal(res.status, "mfa_captcha", `got ${res.status}: ${res.message}`);
  assert.doesNotMatch(res.message, REJECTED_MARKS_STALE, "an MFA screen must not read as a refused credential");
  assert.ok(Date.now() - t0 < 25_000, `a headless run must not park (took ${Date.now() - t0} ms)`);
  assert.equal(await page.evaluate(() => (window as unknown as { __emailRequested?: boolean }).__emailRequested === true), false, "'Send me an email' must never be pressed by the bot");
  await context.close();
});

await check("MUST-PASS (B3 park): the run waits at the factor with the window open, then continues when the PERSON completes it", async () => {
  trapHits.length = 0;
  const { context, page } = await freshPage();
  await page.goto(AUTHORIZE);
  let parked = null as null | { reason: string; waitMs: number };
  let typedIntoFactor = "";
  const res = await performLogin(page, { username: USER, password: MFA_PW }, {
    parkMs: 60_000,
    onPark: (info) => {
      parked = info;
      // The person at the window, a few seconds later. Before completing, prove the bot left the
      // factor screen alone: no code typed, no "Send me an email" pressed.
      setTimeout(() => {
        void page.evaluate(() => {
          const w = window as unknown as { __emailRequested?: boolean; __operatorCompletesFactor: () => void };
          const code = document.querySelector("#code") as HTMLInputElement | null;
          const seen = `${w.__emailRequested ? "email-requested " : ""}${code ? code.value : ""}`;
          w.__operatorCompletesFactor();
          return seen;
        }).then((s) => { typedIntoFactor = s; }).catch(() => undefined);
      }, 3000);
    },
  });
  results.push(res.message);
  assert.ok(parked, "the run must announce the park (onPark)");
  assert.match(String(parked!.reason), /second-factor/i);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
  assert.match(res.message, /person completed the second factor/);
  assert.equal(typedIntoFactor, "", `the bot touched the factor screen: ${typedIntoFactor}`);
  assert.deepEqual(trapHits, []);
  assert.ok(logLines.some((l) => /PAUSED — needs-human \(mfa\)/.test(l)), "the pause must be announced with a named reason");
  await context.close();
});

await check("MUST-EXCLUDE (B3 bound): a factor nobody completes ends as mfa_captcha after the bound — not a hang, not 'rejected'", async () => {
  const { context, page } = await freshPage();
  await page.goto(AUTHORIZE);
  const t0 = Date.now();
  const res = await performLogin(page, { username: USER, password: MFA_PW }, { parkMs: 4000 });
  results.push(res.message);
  assert.equal(res.status, "mfa_captcha", `got ${res.status}: ${res.message}`);
  assert.match(res.message, /held open/);
  assert.doesNotMatch(res.message, REJECTED_MARKS_STALE);
  assert.ok(Date.now() - t0 < 30_000, `the park must be bounded (took ${Date.now() - t0} ms)`);
  await context.close();
});

await check("MUST-EXCLUDE: the credential is never typed into a consumer identity provider's sign-in", async () => {
  const { context, page } = await freshPage();
  await page.goto("https://accounts.google.com/v3/signin/identifier?flowName=x");
  trapHits.length = 0;
  const res = await performLogin(page, { username: USER, password: GOOD_PW });
  results.push(res.message);
  assert.notEqual(res.ok, true, `got ${res.status}: ${res.message}`);
  assert.equal(await page.locator("#u").inputValue(), "", "the username was typed into a third party's form");
  assert.equal(await page.locator("#p").inputValue(), "", "the PASSWORD was typed into a third party's form");
  await context.close();
});

await check("MUST-PASS: a plain one-page login", async () => {
  const { context, page } = await freshPage();
  await page.goto(`http://127.0.0.1:${port}/plain-login`);
  const res = await performLogin(page, { username: "plain-user", password: "plain-pass-123" });
  results.push(res.message);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
  await context.close();
});

await check("MUST-PASS (Lee County shape): the ACA login inside a cross-origin IFRAME is found, filled and signed in", async () => {
  localHits.length = 0;
  const { context, page } = await freshPage();
  await page.goto(`http://127.0.0.1:${port}/LEECO/Login.aspx`);
  const frame = page.frames().find((f) => f.url().includes("/LEECO/login-frame"));
  assert.ok(frame && new URL(frame.url()).hostname === "localhost", "fixture: the login must be a cross-origin frame");
  const res = await performLogin(page, { username: "lee-user@example.test", password: "Lee-Pa55-word" });
  results.push(res.message);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
  assert.match(page.url(), /Dashboard\.aspx/);
  // MUST-EXCLUDE: the frame reports the checkbox's state at the moment SIGN IN was pressed.
  assert.match(page.url(), /remember=false/, "'Remember me on this device' was ticked");
  assert.deepEqual(localHits.filter((h) => /forgot|register/i.test(h)), [], `a chore link was followed: ${localHits.join(", ")}`);
  await context.close();
});

await check("MUST-PASS / MUST-EXCLUDE: a landing page reveals its real login; the newsletter Email box beside it is never used", async () => {
  const { context, page } = await freshPage();
  await page.goto(`http://127.0.0.1:${port}/permit-center`);
  const res = await performLogin(page, { username: "landing-user", password: "landing-pass-1" });
  results.push(res.message);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
  assert.equal(await page.locator("#nl").inputValue(), "", "the username was typed into the newsletter box");
  assert.equal(await page.evaluate(() => (window as unknown as { __subscribed?: boolean }).__subscribed === true), false, "Subscribe was pressed");
  await context.close();
});

await check("MUST-EXCLUDE: neither the username nor any password appears in a log line or a result message", async () => {
  const secrets = [GOOD_PW, MFA_PW, BAD_PW, "plain-pass-123", "Lee-Pa55-word", "landing-pass-1", USER];
  for (const s of secrets) {
    const inLog = logLines.find((l) => l.includes(s));
    assert.equal(inLog, undefined, `a secret reached a log line: ${String(inLog).slice(0, 120)}`);
    const inResult = results.find((m) => m.includes(s));
    assert.equal(inResult, undefined, `a secret reached a result message: ${String(inResult).slice(0, 120)}`);
  }
  assert.ok(results.length >= 8, `the net must have seen the runs (${results.length})`);
});

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
await new Promise<void>((r) => localhostServer.close(() => r()));
if (failures) { console.error(`\n${failures} identifierFirstLogin.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll identifierFirstLogin.dom.smoke checks passed.");
process.exit(0);
