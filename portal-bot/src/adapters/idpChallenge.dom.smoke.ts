// A CHALLENGE IS NEVER A PASSWORD STEP — the Tyler Portico / Okta sign-in against fixtures BUILT
// FROM THE PRODUCTION CAPTURES (City of Tigard OR, 2026-09-27: three supervised learns ended in
// ~10 s as "challenge frame detected (okta.com)" at Okta's "Verify with your password" page, and
// the browser closed on the person). Fake hosts, a fake account, no live portal.
//
// Fixtures: fixtures/okta-password-step.html (run q3zu), okta-identifier-step.html (run sw6s),
// okta-authenticator-chooser.html (run eyg3). Each carries the production HIDDEN account-chooser
// frame at login.okta.com/discovery/iframe.html — the frame that was read as a challenge.
//
//   detectChallengeFrame (the one predicate every door asks)
//     MUST-PASS (not a challenge) — the Tigard password step; the identifier step; a page titled
//       "Verify" with a password box; an "… Authentication" identifier page; an authorize URL
//       whose redirect_uri carries /otp/ and /verify/.
//     MUST-EXCLUDE (still a challenge, never solved) — an Okta "Enter a code" page; an Okta Verify
//       push page; the second-factor chooser (no Password option); reCAPTCHA / hCaptcha /
//       Turnstile frames; a reCAPTCHA frame BESIDE a password box; an "I'm not a robot" box; a Duo
//       frame.
//   performLogin
//     MUST-PASS — the remembered-account password step types THIS credential's password and
//       clicks Verify; the chooser's "Password" is selected, then the password; identifier ->
//       password on the IdP; a Tyler home whose sign-out lives in a closed greeting menu is
//       already signed in; a login reached past a payments link.
//     MUST-EXCLUDE — a password step remembering ANOTHER account gets nothing typed; the
//       chooser's Email / Okta Verify / Phone are never clicked; the second-factor chooser pauses
//       (headless) with nothing clicked; the Guest menu ("to login or register") and a "How to log
//       out" link are not a session; the payments link is never followed; no secret in any log.
//   resolveParkMs — an unreadable page on a headed process still parks; a test double never does.
//
// Run: npx tsx portal-bot/src/adapters/idpChallenge.dom.smoke.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { detectChallengeFrame } from "../safeAction";
import { performLogin, resolveParkMs } from "./loginFlow";

let failures = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const logLines: string[] = [];
for (const level of ["log", "warn", "error", "info"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logLines.push(args.map(String).join(" ")); orig(...args); };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(path.join(HERE, "fixtures", name), "utf8");
const PASSWORD_STEP = fixture("okta-password-step.html");
const IDENTIFIER_STEP = fixture("okta-identifier-step.html");
const CHOOSER = fixture("okta-authenticator-chooser.html");

const USER = "permit.tester@example.test";
const OTHER = "someone.else@example.test";
const GOOD_PW = "Tig4rd-Fake-Passw0rd";
const IDP = "https://identity.portico-example.test";
const TENANT = "https://tenant.energov-example.test";
const PAY = "https://payments.portico-example.test";
const AUTHZ = "/oauth2/default/v1/authorize?client_id=0oaFAKE&response_type=id_token%20token&scope=openid"
  + `&redirect_uri=${encodeURIComponent(`${TENANT}/apps/selfservice/callback`)}&state=abc`;

const optionBtn = (key: string, label: string, i: number) =>
  `<li><button type="button" data-se="authenticator-button" tabindex="0" aria-label="Select ${label}." aria-describedby=""><div class="hide"></div>`
  + `<div data-se="authenticator-button-content"><p id="${key}_${i}-label" data-se="authenticator-button-label" translate="no">${label}</p></div>`
  + `<div data-se="${key}"><div data-se="cta-button-icon"></div></div></button></li>`;

// Behaviour appended to a fixture (the fixtures are the captured markup only).
const CLICK_LOG = `<script>window.__clicks=[];document.addEventListener('click',function(e){var t=e.target&&e.target.closest?e.target.closest('button,a,input')||e.target:e.target;window.__clicks.push((t.getAttribute&&(t.getAttribute('aria-label')||t.getAttribute('data-se')||t.id))||'');},true);</script>`;
const withScript = (html: string, script: string) => html.replace("</body>", `${CLICK_LOG}<script>${script}</script></body>`);
const pwBehaviour = `document.querySelector('form').addEventListener('submit',function(e){e.preventDefault();
  var v=document.getElementById('credentials.passcode').value; window.__typed=v;
  if(v===${JSON.stringify(GOOD_PW)}){setTimeout(function(){location.href=${JSON.stringify(`${TENANT}/apps/selfservice#/home`)};},300);}
});`;
const idBehaviour = `document.querySelector('form').addEventListener('submit',function(e){e.preventDefault();
  if(document.getElementById('identifier').value){setTimeout(function(){location.href=${JSON.stringify(`${IDP}/pw${AUTHZ.slice(AUTHZ.indexOf("?"))}`)};},300);}
});`;
const chooserBehaviour = `document.querySelectorAll('[data-se=authenticator-button]').forEach(function(b){b.addEventListener('click',function(){
  var l=b.getAttribute('aria-label'); if(/Password/.test(l)){setTimeout(function(){location.href=${JSON.stringify(`${IDP}/pw`)};},300);} else {window.__factorPicked=l;}
});});`;

const pages: Record<string, () => string> = {
  "/pw": () => withScript(PASSWORD_STEP.replace(/\{\{IDENTIFIER\}\}/g, USER), pwBehaviour),
  "/pw-other": () => withScript(PASSWORD_STEP.replace(/\{\{IDENTIFIER\}\}/g, OTHER), pwBehaviour),
  "/id": () => withScript(IDENTIFIER_STEP, idBehaviour),
  "/chooser": () => withScript(CHOOSER.replace(/\{\{IDENTIFIER\}\}/g, USER).replace("{{OPTIONS}}", optionBtn("okta_email", "Email", 0) + optionBtn("okta_password", "Password", 1)), chooserBehaviour),
  "/chooser-2fa": () => withScript(CHOOSER.replace(/\{\{IDENTIFIER\}\}/g, USER).replace("{{OPTIONS}}", optionBtn("okta_email", "Email", 0) + optionBtn("okta_verify", "Okta Verify", 1) + optionBtn("phone_number", "Phone", 2)), chooserBehaviour),
  // Okta's email-code factor page: a CODE box, no password box.
  "/code": () => withScript(CHOOSER.replace(/\{\{IDENTIFIER\}\}/g, USER).replace(/Verify it's you with a security method/g, "Verify with your email")
    .replace("<ul data-se=\"authenticator-verify-list\">{{OPTIONS}}</ul>", "<p>Enter a verification code sent to your email.</p><label for=\"credentials.passcode\">Enter Code</label><input type=\"text\" id=\"credentials.passcode\" name=\"credentials.passcode\" autocomplete=\"one-time-code\"><button type=\"submit\" data-se=\"save\">Verify</button>"), ""),
  // Okta Verify push: no box at all.
  "/push": () => withScript(CHOOSER.replace(/\{\{IDENTIFIER\}\}/g, USER).replace(/Verify it's you with a security method/g, "Get a push notification")
    .replace("<ul data-se=\"authenticator-verify-list\">{{OPTIONS}}</ul>", "<p>Push notification sent. Open Okta Verify on your phone and approve the sign-in.</p>"), ""),
  // A page titled "Verify" with a password box — a login, whatever the title.
  "/verify-title": () => `<!doctype html><html><head><title>Verify</title></head><body><h1>Verify your account</h1>
    <label for="u">Username</label><input id="u" name="username" type="text"><label for="p">Password</label><input id="p" type="password"><button type="submit">Verify</button></body></html>`,
  // An identity host that titles its identifier page "… Authentication".
  "/auth-title": () => IDENTIFIER_STEP.replace(/<title>[^<]*<\/title>/, "<title>Community Access - Authentication</title>"),
  "/recaptcha-login": () => PASSWORD_STEP.replace(/\{\{IDENTIFIER\}\}/g, USER).replace("</form>", `</form><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?k=FAKE" width="304" height="78"></iframe>`),
  "/hcaptcha": () => `<!doctype html><html><head><title>Continue</title></head><body><iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox" width="300" height="80"></iframe></body></html>`,
  "/turnstile": () => `<!doctype html><html><head><title>Just a moment</title></head><body><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/light/normal" width="300" height="65"></iframe></body></html>`,
  "/robot": () => `<!doctype html><html><head><title>Sign in</title></head><body><label for="u">Email</label><input id="u" type="email"><label for="p">Password</label><input id="p" type="password">
    <div class="captcha-box"><input type="checkbox" id="robot"><label for="robot">I'm not a robot</label></div><button>Sign in</button></body></html>`,
  "/duo": () => `<!doctype html><html><head><title>Two-step</title></head><body><h1>Two-step verification</h1><iframe src="https://api-fake.duosecurity.com/frame/web/v1/auth?tx=x" width="600" height="330"></iframe></body></html>`,
};

let payHits = 0;
const tenantPages: Record<string, () => string> = {
  // Tyler EnerGov self-service after the callback, signed in: the page title still says "Log In",
  // the visible greeting toggle reads the person's name and is labelled as the menu that holds
  // logout; "Log Out" itself is inside the CLOSED dropdown (from run bmzc's header).
  "/apps/selfservice": () => `<!doctype html><html><head><title>Log In</title></head><body>
    <header><a id="link-Greetings" class="btn dropdown-toggle" role="button" aria-expanded="false" data-toggle="dropdown" href="" aria-label="User dropdown menu to update profile, view invoices, or logout" title="Pat Tester"> Pat Tester <span class="caret"></span></a>
    <ul class="dropdown-menu" style="display:none"><li><a id="link-MyAccountUnderGreetings" href="">My Account</a></li><li><a id="link-LogoutUnderGreetings" href="">Log Out</a></li></ul></header>
    <h1>Welcome to Citizen Self Service</h1><a href="#/apply">Apply Online</a></body></html>`,
  // The same header logged out: the Guest toggle ("to login or register"), and a help link.
  "/guest": () => `<!doctype html><html><head><title>Citizen Self Service</title></head><body>
    <header><a id="link-Greetings" class="btn dropdown-toggle" role="button" aria-expanded="false" href="" aria-label="Guest dropdown menu to login or register"> Guest <span class="caret"></span></a>
    <ul class="dropdown-menu" style="display:none"><li><a id="link-LoginUnderGreetings" href="">Log In</a></li></ul>
    <a href="/help/account-faq" title="How to log out of your account">How to log out</a></header><h1>Welcome</h1></body></html>`,
  // A PUBLIC application form (no accounts at all — Gilbert's shape) whose instructions mention a
  // verification code: no login action was taken, so it must never read as a second factor.
  "/public-form": () => `<!doctype html><html><head><title>Solar Permit Request</title></head><body>
    <h1>Solar Permit Request</h1><p>After you submit, a verification code will be emailed to you to confirm your request.</p>
    <label for="a">Permit Number</label><input id="a" name="permitNumber"><label for="b">Located at</label><input id="b" name="locatedAt">
    <label for="c">First Name</label><input id="c" name="firstName"><label for="d">Last Name</label><input id="d" name="lastName">
    <label for="e">Phone</label><input id="e" name="phone"><button type="submit">Submit Request</button></body></html>`,
  // A logged-out home whose real "Log In" renders LATE (Angular), with a Tyler Payments link whose
  // href says account/login sitting there first — what the reveal's href catch-all clicked in
  // production (run q3zu landed on the PAYMENTS app's sign-in).
  "/late-login": () => `<!doctype html><html><head><title>Citizen Self Service</title></head><body>
    <header><a class="pay" href="${PAY}/payments/checkout/account/login?workspace=fake">Pay Invoices</a> <span id="slot"></span></header><h1>Welcome</h1>
    <script>setTimeout(function(){document.getElementById('slot').innerHTML='<a id="login" href="#">Log In</a>';
      document.getElementById('login').onclick=function(e){e.preventDefault();location.href=${JSON.stringify(`${IDP}/id${AUTHZ.slice(AUTHZ.indexOf("?"))}`)};};},2000);</script></body></html>`,
};

async function route(context: BrowserContext): Promise<void> {
  await context.route(`${IDP}/**`, (r) => {
    const u = new URL(r.request().url());
    const body = (pages[u.pathname] ?? (() => "<html><body>not here</body></html>"))();
    return r.fulfill({ contentType: "text/html", body });
  });
  await context.route(`${TENANT}/**`, (r) => {
    const u = new URL(r.request().url());
    const body = (tenantPages[u.pathname] ?? tenantPages["/apps/selfservice"])();
    return r.fulfill({ contentType: "text/html", body });
  });
  await context.route(`${PAY}/**`, (r) => {
    if (r.request().resourceType() === "document") payHits++;
    return r.fulfill({ contentType: "text/html", body: `<html><head><title>Payments - Sign In</title></head><body><label for="e">Email</label><input id="e" type="email"><label for="p">Password</label><input id="p" type="password"><button>Sign In</button></body></html>` });
  });
  for (const host of ["https://login.okta.com", "https://www.google.com", "https://newassets.hcaptcha.com", "https://challenges.cloudflare.com", "https://api-fake.duosecurity.com", "https://help.portico-example.test"]) {
    await context.route(`${host}/**`, (r) => r.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
  }
}

const browser = await chromium.launch();
async function fresh(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  await route(context);
  const page = await context.newPage();
  return { context, page };
}
async function at(pathName: string, host = IDP): Promise<{ context: BrowserContext; page: Page }> {
  const f = await fresh();
  await f.page.goto(`${host}${pathName}${host === IDP && !pathName.includes("?") ? AUTHZ.slice(AUTHZ.indexOf("?")) : ""}`);
  await f.page.waitForTimeout(300);
  return f;
}
const results: string[] = [];

// ---- detectChallengeFrame -------------------------------------------------------------------
for (const [name, p] of [
  ["the Tigard password step (hidden okta.com frame, title \"… | Verify with your password\")", "/pw"],
  ["the Tigard identifier step (hidden okta.com frame)", "/id"],
  ["a page titled \"Verify\" with a password box", "/verify-title"],
  ["an identifier page titled \"… Authentication\"", "/auth-title"],
  // Unencoded, as some OAuth clients send it: the old whole-URL substring read "/otp" here.
  ["an authorize URL whose redirect_uri carries /otp/ and /verify/", "/id?client_id=0oaFAKE&redirect_uri=https://tenant.energov-example.test/otp/verify/callback&state=abc"],
] as const) {
  await check(`MUST-PASS detectChallengeFrame: ${name} is a LOGIN, not a challenge`, async () => {
    const { context, page } = await at(p);
    const hit = await detectChallengeFrame(page);
    await context.close();
    assert.equal(hit, null, `read as a challenge: ${hit}`);
  });
}
for (const [name, p, re] of [
  ["an Okta \"Enter a code\" page (a code box, no password box)", "/code", /title|text/],
  ["an Okta Verify push page", "/push", /title|text/],
  ["a reCAPTCHA frame BESIDE a password box", "/recaptcha-login", /recaptcha/],
  ["an hCaptcha frame", "/hcaptcha", /hcaptcha/],
  ["a Cloudflare Turnstile frame", "/turnstile", /challenges\.cloudflare|turnstile/],
  ["an \"I'm not a robot\" box beside a password box", "/robot", /captcha/],
  ["a Duo frame", "/duo", /duo|title/],
] as const) {
  await check(`MUST-EXCLUDE detectChallengeFrame: ${name} is still a challenge`, async () => {
    const { context, page } = await at(p);
    const hit = await detectChallengeFrame(page);
    await context.close();
    assert.ok(hit, "not read as a challenge");
    assert.match(hit!, re);
  });
}

// ---- performLogin ---------------------------------------------------------------------------
await check("MUST-PASS the remembered-account password step: THIS credential's password is typed and Verify clicked → logged_in", async () => {
  const { context, page } = await at("/pw");
  const res = await performLogin(page, { username: USER, password: GOOD_PW });
  results.push(res.message);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
  assert.ok(page.url().startsWith(TENANT), `should land on the tenant, is on ${page.url()}`);
  await context.close();
});

await check("MUST-EXCLUDE a password step remembering ANOTHER account gets nothing typed", async () => {
  const { context, page } = await at("/pw-other");
  const res = await performLogin(page, { username: USER, password: GOOD_PW });
  results.push(res.message);
  assert.notEqual(res.ok, true, `got ${res.status}: ${res.message}`);
  assert.equal(await page.locator("[id='credentials.passcode']").inputValue(), "", "the password was typed under another account");
  await context.close();
});

await check("MUST-PASS the chooser's \"Password\" is selected, then the password → logged_in; Email is never clicked", async () => {
  const { context, page } = await at("/chooser");
  const res = await performLogin(page, { username: USER, password: GOOD_PW });
  results.push(res.message);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
  await context.close();
});

await check("MUST-EXCLUDE the chooser: only \"Select Password.\" is ever clicked (never Email)", async () => {
  // A wrong password keeps the run on the Okta pages; read the chooser's click log before it leaves.
  const { context, page } = await at("/chooser");
  const seen: string[] = [];
  await page.exposeFunction("__noteClick", (s: string) => { seen.push(s); });
  await page.evaluate(() => document.addEventListener("click", (e) => {
    const t = (e.target as Element).closest("button,a") as Element | null;
    (window as unknown as { __noteClick: (s: string) => void }).__noteClick(t?.getAttribute("aria-label") || t?.getAttribute("data-se") || "");
  }, true));
  const res = await performLogin(page, { username: USER, password: "Wr0ng-Fake" });
  results.push(res.message);
  assert.deepEqual(seen.filter((s) => /^Select /.test(s)), ["Select Password."], `chooser clicks: ${JSON.stringify(seen)}`);
  await context.close();
});

await check("MUST-EXCLUDE the SECOND-factor chooser (Email / Okta Verify / Phone, no Password) pauses headless with nothing clicked", async () => {
  const { context, page } = await at("/chooser-2fa");
  const t0 = Date.now();
  const res = await performLogin(page, { username: USER, password: GOOD_PW });
  results.push(res.message);
  assert.equal(res.status, "mfa_captcha", `got ${res.status}: ${res.message}`);
  assert.ok(Date.now() - t0 < 30_000, `a headless run must not hold (${Date.now() - t0} ms)`);
  const picked = await page.evaluate(() => (window as unknown as { __factorPicked?: string }).__factorPicked ?? "");
  assert.equal(picked, "", `a second factor was picked: ${picked}`);
  await context.close();
});

await check("MUST-PASS identifier → password on the IdP (hidden okta.com frame on both) → logged_in", async () => {
  const { context, page } = await at("/id");
  const res = await performLogin(page, { username: USER, password: GOOD_PW });
  results.push(res.message);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
  await context.close();
});

await check("MUST-PASS a Tyler home whose sign-out lives in the closed greeting menu is already signed in", async () => {
  const { context, page } = await at("/apps/selfservice#/home", TENANT);
  const res = await performLogin(page, { username: USER, password: GOOD_PW });
  results.push(res.message);
  assert.equal(res.status, "already_authenticated", `got ${res.status}: ${res.message}`);
  await context.close();
});

await check("MUST-EXCLUDE the Guest menu (\"to login or register\") and a \"How to log out\" link are not a session", async () => {
  const { context, page } = await at("/guest", TENANT);
  const res = await performLogin(page, { username: USER, password: GOOD_PW });
  results.push(res.message);
  assert.notEqual(res.status, "already_authenticated", `got ${res.status}: ${res.message}`);
  await context.close();
});

await check("MUST-EXCLUDE a public application form that MENTIONS a verification code is not a second factor → no_login_required", async () => {
  const { context, page } = await at("/public-form", TENANT);
  const res = await performLogin(page, { username: USER, password: GOOD_PW });
  results.push(res.message);
  assert.equal(res.status, "no_login_required", `got ${res.status}: ${res.message}`);
  await context.close();
});

await check("MUST-PASS / MUST-EXCLUDE a login reached past a payments link: the payments sign-in is never opened", async () => {
  payHits = 0;
  const { context, page } = await at("/late-login", TENANT);
  const res = await performLogin(page, { username: USER, password: GOOD_PW });
  results.push(res.message);
  assert.equal(payHits, 0, `the payments app was opened ${payHits} time(s)`);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
  await context.close();
});

await check("MUST-PASS / MUST-EXCLUDE a CAPTCHA on the login form HOLDS (a run that may hold): nothing typed under it; the person solves it and signs in; the run resumes logged_in", async () => {
  const { context, page } = await at("/recaptcha-login");
  let typedWhenParked = "(not parked)";
  let parkReason = "";
  const res = await performLogin(page, { username: USER, password: GOOD_PW }, {
    parkMs: 30_000,
    onPark: (info) => {
      parkReason = info.reason;
      // THE PERSON, two seconds later: what the bot left in the password box is read first; then
      // they solve the CAPTCHA and sign in, and the portal moves on to the signed-in home.
      setTimeout(() => {
        void page.locator("[id='credentials.passcode']").inputValue().then((v) => { typedWhenParked = v; })
          .catch(() => { typedWhenParked = "(unreadable)"; })
          .then(() => page.goto(`${TENANT}/apps/selfservice#/home`)).catch(() => undefined);
      }, 2000);
    },
  });
  results.push(res.message);
  assert.match(parkReason, /complete the MFA\/CAPTCHA in the open browser window/i);
  assert.match(parkReason, /recaptcha/i);
  assert.equal(typedWhenParked, "", `the bot typed under the CAPTCHA: "${typedWhenParked === "" ? "" : "(something)"}"`);
  assert.equal(res.status, "logged_in", `got ${res.status}: ${res.message}`);
  assert.match(res.message, /person completed/);
  await context.close();
});

// ---- resolveParkMs ----------------------------------------------------------------------------
await check("MUST-PASS resolveParkMs: an UNREADABLE page on a headed process still parks; a test double never does", async () => {
  const prev = process.env.PORTAL_HEADLESS;
  try {
    const unreadable = { context: () => ({}), evaluate: async () => { throw new Error("Execution context was destroyed"); } } as unknown as Page;
    process.env.PORTAL_HEADLESS = "false";
    assert.ok(await resolveParkMs(unreadable, {}) > 0, "a headed run whose page could not be read did not park");
    delete process.env.PORTAL_HEADLESS;
    assert.equal(await resolveParkMs(unreadable, {}), 0, "a headless process parked");
    process.env.PORTAL_HEADLESS = "false";
    const double = { evaluate: async () => [] } as unknown as Page;
    assert.equal(await resolveParkMs(double, {}), 0, "a test double parked");
    const { context, page } = await fresh();
    assert.equal(await resolveParkMs(page, {}), 0, "a real HEADLESS browser parked");
    await context.close();
  } finally {
    if (prev === undefined) delete process.env.PORTAL_HEADLESS; else process.env.PORTAL_HEADLESS = prev;
  }
});

await check("MUST-EXCLUDE no secret appears in a log line or a result message", async () => {
  for (const s of [GOOD_PW, USER, OTHER]) {
    const inLog = logLines.find((l) => l.includes(s));
    assert.equal(inLog, undefined, `a secret reached a log line: ${String(inLog).slice(0, 120)}`);
    const inResult = results.find((m) => m.includes(s));
    assert.equal(inResult, undefined, `a secret reached a result message: ${String(inResult).slice(0, 120)}`);
  }
  assert.ok(results.length >= 8, `the net must have seen the runs (${results.length})`);
});

await browser.close();
if (failures) { console.error(`\n${failures} idpChallenge.dom.smoke check(s) FAILED.`); process.exit(1); }
console.log("\nAll idpChallenge.dom.smoke checks passed.");
process.exit(0);
