// THE PAGE RUNS THE SAME SAFETY PREDICATES NODE DOES — AND THE RECORDERS USE THEM.
//
// The capture scripts (human patch capture, the portal:record recorder) run inside the portal
// page, where an import does not exist. They used to carry their own regex copies, and the
// copies drifted: neither knew Accela's "Continue Application" files the permit on the review
// page, and the recorder had no payment-card refusal at all. They now read window.__portalSafety,
// installed from PORTAL_SAFETY_IN_PAGE_SOURCE — the shared factory's own source text.
//
// This drives the real code in real Chromium, on local fixture pages only:
//   1. the in-page predicates answer exactly as Node does over a golden sample;
//   2. read-only-page detection: a review page with a header search box and a terms tick is
//      read-only; a form page is not;
//   3. humanCapture: "Continue Application" on a FORM page is captured as navigation; on the
//      REVIEW page it is the filing click (one submitObserved, capture disarmed); a contractor's
//      licence "Expiration Date" is captured while a card's is not;
//   4. the recorder (captureScript + createRecorderSink): same Continue Application split, the
//      card block is never reported, a secret field keeps its step but not its literal.
//
//   npx tsx portal-bot/src/portalSafetyInPage.dom.smoke.ts
import http from "node:http";
import { chromium, type Page } from "playwright";
import {
  classifyRecordedClick,
  isPayFee,
  isSecretField,
  isSubmitIntent,
  PORTAL_SAFETY_IN_PAGE_SOURCE,
} from "../../shared/src/portalSafety";
import type { RecipeStep } from "../../shared/src/types";
import { armHumanCaptureOnPage, HUMAN_SUBMIT_OBSERVED_NOTE } from "./humanCapture";
import { captureScript, createRecorderSink, type RecordedPayload } from "./recordRecipe";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const page = (body: string): string => `<!doctype html><html><body style="font:14px sans-serif;padding:16px">${body}</body></html>`;
const HEADER = `<header><form role="search"><input type="search" name="globalSearch" placeholder="Search..."></form></header>`;
const PAGES: Record<string, string> = {
  // Step 2 of an Accela-shaped wizard: real inputs, and the advance is "Continue Application »".
  "/form": page(`${HEADER}<h2>Step 2: Project Information</h2>
    <label for="job">Job Description</label><input id="job" type="text">
    <label for="lic">Contractor License Expiration Date</label><input id="lic" type="text">
    <label for="acct">Utility Account Number</label><input id="acct" name="account_number" type="text">
    <a href="#" id="cont" role="button" onclick="return false">Continue Application »</a>`),
  // The review page: read-only summary, a header search box, and a certification tick.
  "/review": page(`${HEADER}<h2>Step 3: Review</h2>
    <dl><dt>Job Description</dt><dd>Rooftop PV</dd></dl>
    <label><input type="checkbox" id="cert"> I certify that the information above is correct</label>
    <a href="#" id="cont" role="button" onclick="return false">Continue Application »</a>`),
  // Button shapes whose label is NOT their text (value / img alt / input-image alt / title), and
  // selects: two secret (by name, by label), two ordinary. Values are synthetic.
  "/controls": page(`<form onsubmit="return false">
    <label for="job">Job</label><input id="job" type="text">
    <select id="meterSel" name="meterNumber"><option value="">--</option><option>1009283745</option></select>
    <label for="mtr2">Meter Number</label><select id="mtr2"><option value="">--</option><option>5550001111</option></select>
    <label for="acctType">Account Type</label><select id="acctType" name="accountType"><option value="">--</option><option>Residential</option></select>
    <label for="util">Utility</label><select id="util"><option value="">--</option><option>Pacific Power</option></select>
    <input type="submit" id="btnSubmit" name="ctl00$btnSubmit" value="Submit">
    <button type="button" id="imgBtn" style="padding:4px"><img alt="Submit Application" src="data:," style="display:inline-block;width:20px;height:20px"></button>
    <input type="image" id="imgInput" alt="Submit" src="data:," style="width:24px;height:24px">
    <a href="#" id="titled" title="Submit" onclick="return false"><span style="display:inline-block;width:20px;height:20px;background:#ccc"></span></a>
    <input type="submit" id="nx" value="Next">
    </form>`),
  // A fee page: the card block, including a bare "Expiration Date" select.
  "/pay": page(`<form><h2>Fee Payment</h2>
    <label for="c1">Card Number:</label><input id="c1" type="text">
    <label for="c2">CVV:</label><input id="c2" type="text">
    <label for="c5">Expiration Date</label><select id="c5"><option>01</option><option>02</option></select>
    </form>`),
};

const server = http.createServer((q, r) => {
  const body = PAGES[String(q.url ?? "").split("?")[0]] ?? page("not found");
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
const newPage = async (): Promise<Page> => {
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  return ctx.newPage();
};

try {
  // ---- 1. Page answers == Node answers -------------------------------------------------------
  {
    const p = await newPage();
    await p.goto(`${base}/form`);
    await p.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE);
    const labels = ["Submit", "Continue Application", "Next", "Pay Now", "Place Order", "Payee Name", "Submit Documents", "Fee Schedule"];
    const fields = [{ label: "Account Number" }, { label: "Account Holder Name" }, { name: "parameterValue" }, { label: "Meter" }, { type: "password" }];
    const inPage = await p.evaluate(({ labels, fields }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ps = (globalThis as any).__portalSafety;
      return {
        submit: labels.map((l: string) => ps.isSubmitIntent(l)),
        pay: labels.map((l: string) => ps.isPayFee(l)),
        cls: labels.map((l: string) => ps.classifyRecordedClick(l)),
        secret: fields.map((f: unknown) => ps.isSecretField(f)),
      };
    }, { labels, fields });
    const node = {
      submit: labels.map((l) => isSubmitIntent(l)),
      pay: labels.map((l) => isPayFee(l)),
      cls: labels.map((l) => classifyRecordedClick(l)),
      secret: fields.map((f) => isSecretField(f)),
    };
    check("Chromium's __portalSafety answers exactly as Node's shared module", JSON.stringify(inPage) === JSON.stringify(node),
      `page ${JSON.stringify(inPage)}\n         node ${JSON.stringify(node)}`);

    // ---- 2. Read-only page detection ---------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formRO = await p.evaluate(() => (globalThis as any).__portalSafety.readOnlyPageInPage());
    await p.goto(`${base}/review`);
    await p.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reviewRO = await p.evaluate(() => (globalThis as any).__portalSafety.readOnlyPageInPage());
    check("a form page is NOT read-only", formRO === false, `got ${formRO}`);
    check("a review page with a header search box and a certification tick IS read-only", reviewRO === true, `got ${reviewRO}`);
    await p.context().close();
  }

  // ---- 3. humanCapture ------------------------------------------------------------------------
  {
    const p = await newPage();
    const got: RecipeStep[] = [];
    await p.goto(`${base}/form`);
    const armed = await armHumanCaptureOnPage(p, (s) => got.push(s));
    check("humanCapture arms", armed === true);
    await p.fill("#job", "Rooftop PV");
    await p.fill("#lic", "12/31/2027");
    await p.fill("#acct", "30917442861");
    await p.click("h2");
    await p.click("#cont");
    await p.waitForTimeout(300);
    const job = got.find((s) => s.value === "Rooftop PV");
    const lic = got.find((s) => s.value === "12/31/2027");
    const acct = got.find((s) => /account/i.test(String(s.note)));
    const nav = got.find((s) => s.action === "click" && /Continue Application/.test(String(s.note)));
    check("MUST-PASS: an ordinary fill is captured", !!job);
    check("MUST-PASS: a contractor's licence 'Expiration Date' is captured (not a card)", !!lic, JSON.stringify(got));
    check("MUST: a secret field is captured sensitive", acct?.sensitive === true, JSON.stringify(acct));
    check("MUST-PASS: 'Continue Application' on a FORM page is captured as navigation", !!nav && Object.keys(nav.selector ?? {}).length > 0, JSON.stringify(got));
    check("...and it did not signal a submit", !got.some((s) => s.note === HUMAN_SUBMIT_OBSERVED_NOTE));

    await p.goto(`${base}/review`);
    await p.waitForTimeout(200);
    const before = got.length;
    await p.click("#cont");
    await p.waitForTimeout(300);
    const after = got.slice(before);
    check("MUST: 'Continue Application' on the REVIEW page is the filing click — one submitObserved",
      after.length === 1 && after[0].note === HUMAN_SUBMIT_OBSERVED_NOTE, JSON.stringify(after));
    check("MUST-EXCLUDE: no replayable step targets the review page's Continue Application",
      !after.some((s) => s.action === "click" && Object.keys(s.selector ?? {}).length > 0));
    await p.goto(`${base}/form`);
    await p.fill("#job", "after filing");
    await p.click("h2");
    await p.waitForTimeout(300);
    check("capture is disarmed after the filing click, across the navigation", !got.some((s) => s.value === "after filing"));
    await p.context().close();
  }
  {
    // Card block with a FRESH (armed) capture.
    const p = await newPage();
    const got: RecipeStep[] = [];
    await p.goto(`${base}/pay`);
    await armHumanCaptureOnPage(p, (s) => got.push(s));
    await p.fill("#c1", "4111111111111111");
    await p.fill("#c2", "520");
    await p.selectOption("#c5", "02");
    await p.click("h2");
    await p.waitForTimeout(300);
    check("MUST-EXCLUDE: humanCapture records nothing from a card block, bare 'Expiration Date' included", got.length === 0, JSON.stringify(got));
    await p.context().close();
  }

  // ---- 4. The recorder (portal:record) --------------------------------------------------------
  {
    const p = await newPage();
    const steps: RecipeStep[] = [];
    const sink = createRecorderSink(steps, () => undefined);
    await p.exposeBinding("__recordStep", (_s: unknown, payload: RecordedPayload) => sink(payload));
    await p.addInitScript({ content: PORTAL_SAFETY_IN_PAGE_SOURCE });
    await p.addInitScript(captureScript);
    await p.goto(`${base}/form`);
    await p.fill("#job", "Rooftop PV");
    await p.fill("#acct", "30917442861");
    await p.click("h2");
    await p.click("#cont");
    await p.goto(`${base}/pay`);
    await p.fill("#c1", "4111111111111111");
    await p.fill("#c2", "520");
    await p.selectOption("#c5", "02");
    await p.click("h2");
    await p.goto(`${base}/review`);
    await p.click("#cont");
    await p.waitForTimeout(300);
    const all = JSON.stringify(steps);
    const nav = steps.find((s) => s.action === "click" && Object.keys(s.selector ?? {}).length > 0 && /Continue Application/.test(String(s.note)));
    const fin = steps.find((s) => s.isFinalSubmit === true);
    const acct = steps.find((s) => s.sensitive === true);
    check("recorder: form-page 'Continue Application' is a replayable navigation click", !!nav, all.slice(0, 400));
    check("recorder: review-page 'Continue Application' is a targetless, flagged placeholder",
      !!fin && Object.keys(fin.selector ?? {}).length === 0, all.slice(0, 400));
    check("recorder: a secret field keeps its step and loses its literal", !!acct && acct.value === undefined && !all.includes("30917442861"), all.slice(0, 400));
    check("recorder MUST-EXCLUDE: nothing from the card block, of any kind", !/4111|"520"|card|cvv|expir/i.test(all), all.slice(0, 400));
    await p.context().close();
  }

  // ---- 5. Button shapes and secret selects (foundation must-fix 4 and 5) ---------------------
  // describe() read neither `value`, an img's `alt`, nor `title`, so these submit controls had an
  // EMPTY label, and an empty label is "not submit" to every classifier: the recorder captured
  // <input type=submit value="Submit"> as a css-selector click. And a <select>'s label came from
  // its textContent — every option — so a meter-number select copied the meter number into the
  // selector and note.
  const SECRET_LITERALS = ["1009283745", "5550001111"];
  const SUBMIT_SHAPES = ["#btnSubmit", "#imgBtn", "#imgInput", "#titled"];
  {
    const p = await newPage();
    const steps: RecipeStep[] = [];
    const sink = createRecorderSink(steps, () => undefined);
    await p.exposeBinding("__recordStep", (_s: unknown, payload: RecordedPayload) => sink(payload));
    await p.addInitScript({ content: PORTAL_SAFETY_IN_PAGE_SOURCE });
    await p.addInitScript(captureScript);
    await p.goto(`${base}/controls`);
    await p.fill("#job", "Rooftop PV");
    await p.press("#job", "Tab");
    await p.selectOption("#meterSel", "1009283745");
    await p.selectOption("#mtr2", "5550001111");
    await p.selectOption("#acctType", "Residential");
    await p.selectOption("#util", "Pacific Power");
    await p.waitForTimeout(150);
    const clickAt: Record<string, RecipeStep[]> = {};
    for (const id of [...SUBMIT_SHAPES, "#nx"]) {
      const before = steps.length;
      await p.click(id);
      await p.waitForTimeout(150);
      clickAt[id] = steps.slice(before);
    }
    const all = JSON.stringify(steps);
    const nx = clickAt["#nx"][0];
    const nxResolves = nx && nx.selector?.role && nx.selector?.name
      ? await p.getByRole(nx.selector.role as "button", { name: String(nx.selector.name), exact: true }).count()
      : 0;
    check("recorder MUST-PASS: <input type=submit value='Next'> is a replayable click with a non-empty note, and its selector resolves to exactly that button",
      !!nx && nx.action === "click" && String(nx.note ?? "").trim() === "Next" && nxResolves === 1, `${JSON.stringify(nx)} resolves=${nxResolves}`);
    for (const id of SUBMIT_SHAPES) {
      const got = clickAt[id];
      check(`recorder MUST-EXCLUDE: ${id} (a submit whose label is value/alt/title) is a targetless placeholder, never a click with a selector`,
        got.length === 1 && got[0].action === "click" && Object.keys(got[0].selector ?? {}).length === 0 && /BLOCKED/.test(String(got[0].note)),
        JSON.stringify(got));
    }
    const sel = (id: string) => steps.find((s) => s.action === "select" && (s.selector?.css === id || (s.fingerprint as { id?: string } | undefined)?.id === id.slice(1)));
    const meterByName = sel("#meterSel");
    const meterByLabel = sel("#mtr2");
    check("recorder MUST-EXCLUDE: <select name='meterNumber'> is sensitive and keeps no value",
      meterByName?.sensitive === true && meterByName.value === undefined, JSON.stringify(meterByName));
    check("recorder MUST-EXCLUDE: a select labelled 'Meter Number' is sensitive and keeps no value",
      meterByLabel?.sensitive === true && meterByLabel.value === undefined, JSON.stringify(meterByLabel));
    check("recorder MUST-EXCLUDE: no option text of a secret select anywhere in the recording (selector, note, value)",
      !SECRET_LITERALS.some((v) => all.includes(v)), all.slice(0, 600));
    const acct = steps.find((s) => s.action === "select" && s.value === "Residential");
    const util = steps.find((s) => s.action === "select" && s.value === "Pacific Power");
    check("recorder MUST-PASS: an 'Account Type' select and a 'Utility' select keep their literal value and their label",
      !!acct && acct.sensitive !== true && /Account Type/.test(String(acct.note)) && !!util && util.sensitive !== true && /Utility/.test(String(util.note)),
      JSON.stringify([acct, util]));
    await p.context().close();
  }
  {
    // humanCapture: the selects, then each submit shape on its own freshly armed page (the
    // filing click disarms the capture, so one page per shape).
    const p = await newPage();
    const got: RecipeStep[] = [];
    await p.goto(`${base}/controls`);
    await armHumanCaptureOnPage(p, (s) => got.push(s));
    await p.selectOption("#meterSel", "1009283745");
    await p.selectOption("#mtr2", "5550001111");
    await p.selectOption("#util", "Pacific Power");
    await p.click("#nx");
    await p.waitForTimeout(300);
    const meters = got.filter((s) => s.action === "select" && s.sensitive === true);
    const visible = JSON.stringify(got.map((s) => ({ selector: s.selector, note: s.note, fingerprint: s.fingerprint })));
    check("humanCapture MUST-EXCLUDE: both meter-number selects are captured sensitive (the value rides in memory only, stripped at merge)",
      meters.length === 2, JSON.stringify(got.map((s) => ({ a: s.action, sensitive: s.sensitive, note: s.note }))));
    check("humanCapture MUST-EXCLUDE: no secret option text in any selector, note or fingerprint", !SECRET_LITERALS.some((v) => visible.includes(v)), visible.slice(0, 600));
    const util = got.find((s) => s.action === "select" && s.value === "Pacific Power");
    check("humanCapture MUST-PASS: the 'Utility' select keeps its value and label", !!util && util.sensitive !== true && /Utility/.test(String(util.note)), JSON.stringify(util));
    const nx = got.find((s) => s.action === "click");
    check("humanCapture MUST-PASS: <input type=submit value='Next'> is reported and captured as a replayable click",
      !!nx && nx.selector?.role === "button" && nx.selector?.name === "Next", JSON.stringify(got.filter((s) => s.action === "click")));
    await p.context().close();
    for (const id of SUBMIT_SHAPES) {
      const q = await newPage();
      const seen: RecipeStep[] = [];
      await q.goto(`${base}/controls`);
      await armHumanCaptureOnPage(q, (s) => seen.push(s));
      await q.click(id);
      await q.waitForTimeout(250);
      check(`humanCapture MUST-EXCLUDE: ${id} is observed as the filing click (one submitObserved), never a replayable click`,
        seen.length === 1 && seen[0].note === HUMAN_SUBMIT_OBSERVED_NOTE && Object.keys(seen[0].selector ?? {}).length === 0, JSON.stringify(seen));
      await q.context().close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

if (failures) { console.error(`\n${failures} in-page safety check(s) FAILED.`); process.exit(1); }
console.log("\nAll in-page safety checks passed.");
process.exit(0);
