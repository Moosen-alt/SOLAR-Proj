// THE LEARNER THROUGH AN OKTA-HOSTED LOGIN, AND THE PARK THAT HOLDS THE WINDOW (production
// 2026-09-27, City of Tigard OR: three supervised learns ended in ~10 s at Okta's password step as
// "challenge frame detected (okta.com)" and the browser closed on the person — "the screen just
// closes on me").
//
// The whole learner (learnPortal: login() then learn()) against two LOCAL origins — a Tyler-like
// self-service app on 127.0.0.1 and a fake identity provider on localhost serving the pages built
// from the Tigard captures (fixtures/okta-*.html), each with the hidden account-chooser frame whose
// URL carries "okta.com". Synthetic data, fake account, no live portal.
//
//   clean         MUST-PASS identifier -> password -> the app -> the application form is filled
//                 and the run reaches review; the password is in no step, message or trace.
//   pushHeld      MUST-PASS a second factor (an Okta Verify push) after the password, on a run
//                 that may hold (parkMs — how a headed run behaves): the run PAUSES in place,
//                 announces "Complete the MFA/CAPTCHA in the open browser window", the smoke plays
//                 the person (approves the push on the fake IdP three seconds later), and the
//                 learner RESUMES and reaches review. MUST-EXCLUDE: the bot never approves it.
//   pushHeadless  MUST-EXCLUDE the same push on a headless run (no hold): paused at once
//                 (mfa_captcha), nothing filled, never approved.
//   captchaHeld   MUST-PASS a CAPTCHA frame on the application page mid-walk: the walk holds,
//                 the person solves it (the frame goes), and the walk continues to review.
//
// Run: npx tsx portal-bot/src/replica/learnIdpPark.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { learnPortal } from "../index";
import { standInPlanner } from "./standInPlanner";
import type { ProjectRecord } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.ANTHROPIC_API_KEY = "";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};
const ONLY = process.env.SMOKE_ONLY || "";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(path.join(HERE, "..", "adapters", "fixtures", name), "utf8");
const USER = "permit.tester@example.test";
const PASSWORD = "Tig4rd-Fake-Passw0rd";

// ---- state the "person" and the checks read ---------------------------------------------------
type Mode = "clean" | "push" | "captcha";
const st = {
  mode: "clean" as Mode,
  approved: false,
  captchaSolved: false,
  applyPosts: [] as Array<Record<string, string>>,
  applyPostAt: [] as number[],
  submitPosts: 0,
  pwPosts: 0,
};
const reset = (mode: Mode) => { st.mode = mode; st.approved = false; st.captchaSolved = false; st.applyPosts = []; st.applyPostAt = []; st.submitPosts = 0; st.pwPosts = 0; };

let appPort = 0;
let idpPort = 0;
const APP = () => `http://127.0.0.1:${appPort}`;
const IDP = () => `http://localhost:${idpPort}`;
// The hidden frame's URL carries "okta.com" (as login.okta.com/discovery/iframe.html does) — the
// substring the old host list read as a challenge in any child frame.
const withOktaFrame = (html: string) => html.replace(/<iframe id="account-chooser-iframe"[^>]*><\/iframe>/,
  `<iframe id="account-chooser-iframe" data-se="account-chooser" class="hide" src="${IDP()}/login.okta.com/discovery/iframe.html"></iframe>`);
const behaviour = (html: string, js: string) => html.replace("</body>", `<script>${js}</script></body>`);

const readBody = (q: http.IncomingMessage): Promise<string> => new Promise((r) => { let b = ""; q.on("data", (c) => { b += c; }); q.on("end", () => r(b)); });

// ---- the fake identity provider -----------------------------------------------------------------
const idp = http.createServer(async (q, r) => {
  const u = new URL(q.url || "/", "http://x");
  const send = (body: string, code = 200) => { r.writeHead(code, { "Content-Type": "text/html" }); r.end(body); };
  const back = u.searchParams.get("redirect_uri") || `${APP()}/apps/selfservice/callback`;
  const carry = `redirect_uri=${encodeURIComponent(back)}`;
  if (u.pathname === "/oauth2/default/v1/authorize") {
    return send(behaviour(withOktaFrame(fixture("okta-identifier-step.html")), `document.querySelector('form').addEventListener('submit',function(e){e.preventDefault();
      if(document.getElementById('identifier').value){location.href='/pw?${carry}';}});`));
  }
  if (u.pathname === "/pw") {
    return send(behaviour(withOktaFrame(fixture("okta-password-step.html").replace(/\{\{IDENTIFIER\}\}/g, USER)), `document.querySelector('form').addEventListener('submit',function(e){e.preventDefault();
      fetch('/pw-check',{method:'POST',body:document.getElementById('credentials.passcode').value}).then(function(x){return x.text();}).then(function(t){
        if(t==='push'){location.href='/push?${carry}';} else if(t==='ok'){location.href=${JSON.stringify(back)}+'?code=fake-code';}
      });});`));
  }
  if (u.pathname === "/pw-check" && q.method === "POST") {
    st.pwPosts++;
    const pw = await readBody(q);
    r.writeHead(200, { "Content-Type": "text/plain" });
    return r.end(pw !== PASSWORD ? "bad" : st.mode === "push" ? "push" : "ok");
  }
  if (u.pathname === "/push") {
    const page = fixture("okta-authenticator-chooser.html").replace(/\{\{IDENTIFIER\}\}/g, USER)
      .replace(/Verify it's you with a security method/g, "Get a push notification")
      .replace("<ul data-se=\"authenticator-verify-list\">{{OPTIONS}}</ul>", "<p>Push notification sent. Open Okta Verify on your phone and approve the sign-in.</p>");
    return send(behaviour(withOktaFrame(page), `setInterval(function(){fetch('/push-status').then(function(x){return x.text();}).then(function(t){
      if(t==='approved'){location.href=${JSON.stringify(back)}+'?code=fake-code';}});},1000);`));
  }
  if (u.pathname === "/push-status") { r.writeHead(200, { "Content-Type": "text/plain" }); return r.end(st.approved ? "approved" : "waiting"); }
  // The person's phone — never a page the browser is sent to.
  if (u.pathname === "/approve" && q.method === "POST") { st.approved = true; r.writeHead(204); return r.end(); }
  if (u.pathname.startsWith("/login.okta.com/")) return send("<html><body></body></html>");
  return send("<html><body>not here</body></html>", 404);
});

// ---- the Tyler-like self-service app ------------------------------------------------------------
const signedIn = (q: http.IncomingMessage) => /(^|;\s*)sid=ok/.test(String(q.headers.cookie || ""));
const HOME_IN = `<!doctype html><html><head><title>Log In</title></head><body>
  <header><a id="link-Greetings" class="btn dropdown-toggle" role="button" aria-expanded="false" href="#" aria-label="User dropdown menu to update profile, view invoices, or logout" title="Pat Tester"> Pat Tester </a>
  <ul style="display:none"><li><a id="link-LogoutUnderGreetings" href="/apps/selfservice/logout">Log Out</a></li></ul></header>
  <h1>Welcome to Citizen Self Service</h1><p>Apply for a residential solar permit.</p>
  <a href="/apps/selfservice/apply">Apply Online</a></body></html>`;
const HOME_OUT = () => `<!doctype html><html><head><title>Citizen Self Service</title></head><body>
  <header><a id="login" href="${IDP()}/oauth2/default/v1/authorize?client_id=0oaFAKE&response_type=code&scope=openid&state=s1&redirect_uri=${encodeURIComponent(`${APP()}/apps/selfservice/callback`)}">Log In</a></header>
  <h1>Welcome to Citizen Self Service</h1></body></html>`;
const APPLY = (withCaptcha: boolean) => `<!doctype html><html><head><title>Solar Permit Application</title></head><body>
  <header><a id="link-Greetings" role="button" href="#" aria-label="User dropdown menu to update profile, view invoices, or logout"> Pat Tester </a></header>
  <h1>Residential Solar Permit — Property Owner</h1>
  ${withCaptcha ? `<div id="cap"><iframe title="hCaptcha" src="${APP()}/hcaptcha/checkbox.html" width="300" height="80"></iframe></div>` : ""}
  <form method="post" action="/apps/selfservice/apply">
    <fieldset><legend>Property Owner</legend>
    <label for="fn">First Name</label><input id="fn" name="fn" type="text">
    <label for="ln">Last Name</label><input id="ln" name="ln" type="text">
    <label for="st">Street Address</label><input id="st" name="st" type="text">
    <label for="ci">City</label><input id="ci" name="ci" type="text">
    <label for="zp">Zip</label><input id="zp" name="zp" type="text"></fieldset>
    <button type="submit" id="next">Next</button>
  </form>
  ${withCaptcha ? `<script>setInterval(function(){fetch('/captcha-status').then(function(x){return x.text();}).then(function(t){
    if(t==='solved'){var c=document.getElementById('cap'); if(c) c.remove();}});},1000);</script>` : ""}
</body></html>`;
const REVIEW = (v: Record<string, string>) => `<!doctype html><html><head><title>Review</title></head><body>
  <h1>Review your application</h1><p>Please confirm the details below.</p>
  <dl><dt>Owner</dt><dd>${v.fn ?? ""} ${v.ln ?? ""}</dd><dt>Address</dt><dd>${v.st ?? ""}, ${v.ci ?? ""} ${v.zp ?? ""}</dd></dl>
  <form method="post" action="/apps/selfservice/submit"><button type="submit">Submit Application</button></form></body></html>`;

const app = http.createServer(async (q, r) => {
  const u = new URL(q.url || "/", "http://x");
  const send = (body: string, headers: Record<string, string> = {}) => { r.writeHead(200, { "Content-Type": "text/html", ...headers }); r.end(body); };
  if (u.pathname === "/apps/selfservice/callback") {
    r.writeHead(302, { Location: "/apps/selfservice", "Set-Cookie": "sid=ok; Path=/" });
    return r.end();
  }
  if (u.pathname === "/apps/selfservice" || u.pathname === "/apps/selfservice/") return send(signedIn(q) ? HOME_IN : HOME_OUT());
  if (!signedIn(q)) { r.writeHead(302, { Location: "/apps/selfservice" }); return r.end(); }
  if (u.pathname === "/apps/selfservice/apply" && q.method === "POST") {
    st.applyPosts.push(Object.fromEntries(new URLSearchParams(await readBody(q))));
    st.applyPostAt.push(Date.now());
    r.writeHead(302, { Location: "/apps/selfservice/review" });
    return r.end();
  }
  if (u.pathname === "/apps/selfservice/apply") return send(APPLY(st.mode === "captcha" && !st.captchaSolved));
  if (u.pathname === "/apps/selfservice/review") return send(REVIEW(st.applyPosts[st.applyPosts.length - 1] ?? {}));
  if (u.pathname === "/apps/selfservice/submit") { st.submitPosts++; return send("<html><body>Submitted</body></html>"); }
  if (u.pathname === "/captcha-status") { r.writeHead(200, { "Content-Type": "text/plain" }); return r.end(st.captchaSolved ? "solved" : "waiting"); }
  if (u.pathname.startsWith("/hcaptcha/")) return send("<html><body><input type=checkbox> I am human</body></html>");
  return send("<html><body>not here</body></html>");
});

await new Promise<void>((res) => app.listen(0, "127.0.0.1", () => res()));
appPort = (app.address() as { port: number }).port;
await new Promise<void>((res) => idp.listen(0, "localhost", () => res()));
idpPort = (idp.address() as { port: number }).port;

const fields: Record<string, string> = {
  homeownerFirstName: "Harriet", homeownerLastName: "Quillfeather", homeownerName: "Harriet Quillfeather",
  street: "4127 Larkspur Ln", city: "Fernhollow", state: "OR", zip: "97499",
};
const project = { id: "smoke-idp", ahj: "City of Fernhollow", state: "OR", city: "Fernhollow", zip: "97499", address: "4127 Larkspur Ln, Fernhollow, OR 97499", projectAddress: "4127 Larkspur Ln, Fernhollow, OR 97499", homeownerName: "Harriet Quillfeather" } as unknown as ProjectRecord;

interface Case { name: string; mode: Mode; parkMs?: number; person?: "approvePush" | "solveCaptcha" }
async function run(c: Case) {
  if (ONLY && !c.name.includes(ONLY)) return null;
  reset(c.mode);
  const progress: string[] = [];
  let parkedAt = 0;
  let personActedAt = 0;
  const t0 = Date.now();
  const r = await learnPortal({
    portalName: `smoke ${c.name}`,
    portalUrl: `${APP()}/apps/selfservice`,
    project,
    planner: standInPlanner(fields, { utility: false }),
    credential: { username: USER, password: PASSWORD },
    headless: true,
    budgetMs: 180_000,
    uploadMode: "combined",
    policyProfile: "none",
    ...(typeof c.parkMs === "number" ? { parkMs: c.parkMs } : {}),
    onProgress: (p) => {
      const m = String(p.message ?? "");
      progress.push(m);
      if (/Paused for a person/.test(m) && !parkedAt) {
        parkedAt = Date.now();
        // THE PERSON, three seconds later: approves the push on their phone / solves the CAPTCHA.
        if (c.person) setTimeout(() => {
          personActedAt = Date.now();
          if (c.person === "approvePush") void fetch(`${IDP()}/approve`, { method: "POST" }).catch(() => undefined);
          if (c.person === "solveCaptcha") st.captchaSolved = true;
        }, 3000);
      }
    },
  });
  const secs = (Date.now() - t0) / 1000;
  const everywhere = JSON.stringify({ steps: r.steps, message: r.message, trace: r.pageTrace, progress });
  console.log(`   [${c.name}] ${secs.toFixed(1)}s ok=${r.ok} review=${!!r.reachedReview} pause=${r.pauseReason ?? "-"} stop=${r.stopReason ?? "-"} applyPosts=${st.applyPosts.length} pwPosts=${st.pwPosts} approved=${st.approved}\n      msg: ${String(r.message).slice(0, 300)}\n      parked: ${progress.filter((m) => /Paused/.test(m)).join(" | ").slice(0, 300)}`);
  return { r, secs, progress, parkedAt, personActedAt, leaked: everywhere.includes(PASSWORD), posted: st.applyPosts[st.applyPosts.length - 1] ?? {} };
}

try {
  {
    const x = await run({ name: "clean", mode: "clean" });
    if (x) {
      check("clean MUST-PASS: identifier -> password on the Okta-hosted IdP (hidden okta.com frame) -> the app -> the form is filled and the run reaches review",
        x.r.reachedReview === true && x.posted.fn === "Harriet" && x.posted.zp === "97499" && st.pwPosts === 1,
        `review=${x.r.reachedReview} posted=${JSON.stringify(x.posted)} pwPosts=${st.pwPosts} ${x.r.message.slice(0, 200)}`);
      check("clean: never filed (0 submit POSTs), and the password is in no step, message, trace or progress line", st.submitPosts === 0 && !x.leaked, `submits=${st.submitPosts} leaked=${x.leaked}`);
    }
  }
  {
    const x = await run({ name: "pushHeld", mode: "push", parkMs: 60_000, person: "approvePush" });
    if (x) {
      check("pushHeld MUST-PASS: the run PAUSED in place and told the dashboard to complete the MFA/CAPTCHA in the open browser window",
        x.parkedAt > 0 && x.progress.some((m) => /Complete the MFA\/CAPTCHA in the open browser window/i.test(m)), `progress=${JSON.stringify(x.progress.filter((m) => /Paus/.test(m)))}`);
      check("pushHeld MUST-PASS: after the PERSON approved, the learner RESUMED and reached review with the form filled",
        x.r.reachedReview === true && x.posted.fn === "Harriet" && x.personActedAt > 0 && st.approved === true,
        `review=${x.r.reachedReview} posted=${JSON.stringify(x.posted)} personActed=${x.personActedAt > 0} ${x.r.message.slice(0, 200)}`);
      check("pushHeld MUST-EXCLUDE: nothing past the login happened before the person acted (the bot never approves)",
        x.personActedAt > 0 && x.parkedAt < x.personActedAt && st.applyPostAt.length > 0 && st.applyPostAt[0] > x.personActedAt, `parkedAt=${x.parkedAt} personActedAt=${x.personActedAt} applyAt=${st.applyPostAt[0] ?? 0}`);
      check("pushHeld: never filed, no password anywhere", st.submitPosts === 0 && !x.leaked, `submits=${st.submitPosts} leaked=${x.leaked}`);
    }
  }
  {
    const x = await run({ name: "pushHeadless", mode: "push" });
    if (x) {
      check("pushHeadless MUST-EXCLUDE: a headless run does not hold — paused at once (mfa_captcha), nothing filled, never approved",
        x.r.pauseReason === "mfa_captcha" && x.r.ok === false && st.applyPosts.length === 0 && st.approved === false && x.secs < 60,
        `pause=${x.r.pauseReason} ok=${x.r.ok} applyPosts=${st.applyPosts.length} approved=${st.approved} ${x.secs.toFixed(1)}s ${x.r.message.slice(0, 200)}`);
    }
  }
  {
    const x = await run({ name: "captchaHeld", mode: "captcha", parkMs: 60_000, person: "solveCaptcha" });
    if (x) {
      check("captchaHeld MUST-PASS: a CAPTCHA mid-walk HOLDS the walk; once the person solves it the walk continues and reaches review",
        x.parkedAt > 0 && x.r.reachedReview === true && x.posted.fn === "Harriet" && x.personActedAt > 0,
        `parked=${x.parkedAt > 0} review=${x.r.reachedReview} posted=${JSON.stringify(x.posted)} ${x.r.message.slice(0, 200)}`);
      check("captchaHeld MUST-EXCLUDE: the CAPTCHA page was not advanced before the person solved it (one apply POST, after the solve)",
        x.personActedAt > 0 && st.applyPosts.length === 1 && st.applyPostAt[0] > x.personActedAt, `applyPosts=${st.applyPosts.length} at=${st.applyPostAt[0] ?? 0} personActedAt=${x.personActedAt}`);
    }
  }
} finally {
  await new Promise<void>((res) => app.close(() => res()));
  await new Promise<void>((res) => idp.close(() => res()));
}

if (failures) { console.error(`\n${failures} learnIdpPark check(s) FAILED.`); process.exit(1); }
console.log("\nAll learnIdpPark checks passed (real Chromium, fake Okta-hosted IdP).");
process.exit(0);
