// SETTLE ON WHAT THE PAGE IS DOING — PROVEN ON A SIMULATED UPDATEPANEL.
//
// A local page stands in for an ASP.NET WebForms portal: a fake Sys.WebForms.PageRequestManager
// with the real surface (getInstance, add_beginRequest, add_endRequest, get_isInAsyncPostBack),
// a __doPostBack that the controls call through setTimeout(…, 0) exactly as WebForms autopostback
// markup does, a server round-trip of POSTBACK_MS, and an UpdatePanel whose HTML is REPLACED from
// "server state" carried in a view-state snapshot taken when the request STARTED. A new postback
// aborts the one in flight (last-wins) — the documented PageRequestManager behaviour.
//
// What must hold:
//   1. fill -> commitField -> the dependent select already holds the cascaded options.
//      (fill() alone fires `input`, so without the commit's blur nothing posts back at all.)
//   2. Two autopostback selects changed back-to-back WITHOUT settling lose the first cascade
//      (the hazard is real in the fixture), and WITH waitForSettled between them keep both.
//   3. A page with no Sys at all (partial rendering off) settles by the quiet window, and a
//      fetch-driven cascade is waited out by the request counter.
//
// POSTBACK_MS (700) is longer than the quiet window (300) on purpose: a quiet window alone
// cannot pass check 1 — only the PageRequestManager hook can.
//
//   npx tsx portal-bot/src/settle.dom.smoke.ts
import http from "node:http";
import { chromium, type Page } from "playwright";
import { commitField, installSettleProbe, waitForSettled } from "./settle";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const POSTBACK_MS = 700;

const WEBFORMS_PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
<form id="aspnetForm" onsubmit="return false">
  <div id="panel"></div>
</form>
<script>
(function () {
  var CATALOG = {
    zip: { "97701": ["Pacific Power", "Central Electric Co-op"], "90210": ["SCE"] },
    mfr: { "Acme": ["Acme-100", "Acme-200"], "Borealis": ["B-1"] },
    inv: { "Enphase": ["IQ8M", "IQ8A"], "SMA": ["SB7.7"] }
  };
  // Server state carried between requests, like ViewState: the dependent lists live here.
  var viewState = { utility: [], model: [], invModel: [] };
  var posted = { zip: "", mfr: "", inv: "" };
  var begin = [], end = [], current = null;
  function opts(list, sel) {
    return '<option value="">--</option>' + list.map(function (o) {
      return '<option' + (o === sel ? ' selected' : '') + '>' + o + '</option>';
    }).join("");
  }
  function render(vs, v) {
    document.getElementById("panel").innerHTML =
      '<label for="zip">Service ZIP</label><input id="zip" value="' + v.zip + '" onchange="setTimeout(function(){__doPostBack(\\'zip\\',\\'\\')},0)">' +
      '<label for="utility">Utility</label><select id="utility">' + opts(vs.utility) + '</select>' +
      '<label for="mfr">Module Manufacturer</label><select id="mfr" onchange="setTimeout(function(){__doPostBack(\\'mfr\\',\\'\\')},0)">' + opts(Object.keys(CATALOG.mfr), v.mfr) + '</select>' +
      '<label for="model">Module Model</label><select id="model">' + opts(vs.model) + '</select>' +
      '<label for="inv">Inverter Manufacturer</label><select id="inv" onchange="setTimeout(function(){__doPostBack(\\'inv\\',\\'\\')},0)">' + opts(Object.keys(CATALOG.inv), v.inv) + '</select>' +
      '<label for="invModel">Inverter Model</label><select id="invModel">' + opts(vs.invModel) + '</select>';
  }
  var prm = {
    add_beginRequest: function (h) { begin.push(h); },
    add_endRequest: function (h) { end.push(h); },
    get_isInAsyncPostBack: function () { return !!current; }
  };
  window.Sys = { WebForms: { PageRequestManager: { getInstance: function () { return prm; } } } };
  window.__postbacks = { started: 0, aborted: 0, completed: 0 };
  window.__doPostBack = function (target) {
    // The request carries the form values NOW and the view state as of the LAST completed render.
    var req = {
      target: target,
      vs: JSON.parse(JSON.stringify(viewState)),
      v: { zip: document.getElementById("zip").value, mfr: document.getElementById("mfr").value, inv: document.getElementById("inv").value }
    };
    if (current) { clearTimeout(current.timer); window.__postbacks.aborted++; end.forEach(function (h) { h(); }); current = null; }
    window.__postbacks.started++;
    begin.forEach(function (h) { h(); });
    current = req;
    req.timer = setTimeout(function () {
      // The server runs ONLY the event target's handler; the other lists come from view state.
      if (target === "zip") req.vs.utility = CATALOG.zip[req.v.zip] || [];
      if (target === "mfr") req.vs.model = CATALOG.mfr[req.v.mfr] || [];
      if (target === "inv") req.vs.invModel = CATALOG.inv[req.v.inv] || [];
      viewState = req.vs; posted = req.v;
      render(viewState, posted);
      current = null;
      window.__postbacks.completed++;
      end.forEach(function (h) { h(); });
    }, ${POSTBACK_MS});
  };
  render(viewState, posted);
})();
</script></body></html>`;

// No Sys, no __doPostBack: a plain page whose change handler fetches the cascade.
const PLAIN_PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
<label for="state">State</label>
<select id="state" onchange="fetch('/counties?s=' + this.value).then(function (r) { return r.json(); }).then(function (list) {
  document.getElementById('county').innerHTML = list.map(function (c) { return '<option>' + c + '</option>'; }).join('');
})"><option value="">--</option><option>OR</option></select>
<label for="county">County</label><select id="county"></select>
<p id="static">Nothing else happens on this page.</p>
</body></html>`;

const server = http.createServer((q, r) => {
  const url = String(q.url ?? "");
  if (url.startsWith("/counties")) {
    setTimeout(() => { r.writeHead(200, { "Content-Type": "application/json" }); r.end(JSON.stringify(["Deschutes", "Crook"])); }, 600);
    return;
  }
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(url.startsWith("/plain") ? PLAIN_PAGE : WEBFORMS_PAGE);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
const optionsOf = (page: Page, sel: string): Promise<string[]> =>
  page.$$eval(`${sel} option`, (os) => os.map((o) => (o.textContent || "").trim()).filter((t) => t && t !== "--"));
const fresh = async (path: string): Promise<Page> => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await installSettleProbe(page);
  await page.goto(`${base}${path}`);
  return page;
};

try {
  // ---- 1. fill -> commit -> settle sees the cascade -------------------------------------------
  {
    const page = await fresh("/");
    await page.locator("#zip").fill("97701");
    const res = await commitField(page.locator("#zip"));
    const utilities = await optionsOf(page, "#utility");
    check("fill -> commitField -> settled, and the dependent select already holds the cascade",
      res.settled && utilities.join("|") === "Pacific Power|Central Electric Co-op",
      `settle=${JSON.stringify(res)} utilities=${JSON.stringify(utilities)}`);
    check("...it waited through the postback, not a fixed sleep", res.waitedMs >= POSTBACK_MS - 50 && /prm/.test(res.reason),
      JSON.stringify(res));
    await page.context().close();
  }
  {
    // The PageRequestManager hook on its own: with the "postback began" grace cut to 100ms, only
    // beginRequest/endRequest (and get_isInAsyncPostBack) can hold the wait through a 700ms trip.
    const page = await fresh("/");
    await page.locator("#mfr").selectOption("Borealis");
    const res = await waitForSettled(page, { postbackGraceMs: 100 });
    const model = await optionsOf(page, "#model");
    check("the PageRequestManager hook alone holds the wait through the whole postback",
      res.settled && model.join("|") === "B-1", `settle=${JSON.stringify(res)} model=${JSON.stringify(model)}`);
    await page.context().close();
  }
  {
    // The commit is what makes the portal hear the value at all.
    const page = await fresh("/");
    await page.locator("#zip").fill("97701");
    await page.waitForTimeout(POSTBACK_MS + 400);
    const utilities = await optionsOf(page, "#utility");
    const started = await page.evaluate(() => (window as unknown as { __postbacks: { started: number } }).__postbacks.started);
    check("control: fill() alone fires no change — no postback, no cascade", started === 0 && utilities.length === 0,
      `postbacks=${started} utilities=${JSON.stringify(utilities)}`);
    await page.context().close();
  }

  // ---- 2. Last-wins: back-to-back autopostbacks ---------------------------------------------
  {
    const page = await fresh("/");
    await page.selectOption("#mfr", "Acme");
    await page.selectOption("#inv", "Enphase");
    await page.waitForTimeout(POSTBACK_MS * 2 + 400);
    const model = await optionsOf(page, "#model");
    const invModel = await optionsOf(page, "#invModel");
    const pb = await page.evaluate(() => (window as unknown as { __postbacks: unknown }).__postbacks);
    check("HAZARD REPRODUCED: back-to-back autopostbacks WITHOUT settle lose the first cascade",
      model.length === 0 && invModel.join("|") === "IQ8M|IQ8A",
      `model=${JSON.stringify(model)} invModel=${JSON.stringify(invModel)} postbacks=${JSON.stringify(pb)}`);
    await page.context().close();
  }
  {
    const page = await fresh("/");
    await page.selectOption("#mfr", "Acme");
    const r1 = await waitForSettled(page);
    await page.selectOption("#inv", "Enphase");
    const r2 = await waitForSettled(page);
    const model = await optionsOf(page, "#model");
    const invModel = await optionsOf(page, "#invModel");
    const pb = await page.evaluate(() => (window as unknown as { __postbacks: { aborted: number } }).__postbacks);
    check("WITH waitForSettled between them, both cascades survive and nothing was aborted",
      r1.settled && r2.settled && model.join("|") === "Acme-100|Acme-200" && invModel.join("|") === "IQ8M|IQ8A" && pb.aborted === 0,
      `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} model=${JSON.stringify(model)} invModel=${JSON.stringify(invModel)} pb=${JSON.stringify(pb)}`);
    await page.context().close();
  }

  // ---- 3. No Sys at all: quiet window, and the request counter -------------------------------
  {
    const page = await fresh("/plain");
    const idle = await waitForSettled(page, { quietMs: 300, timeoutMs: 5000 });
    check("a page with no PageRequestManager settles by the quiet window (guarded, no throw)",
      idle.settled && idle.waitedMs < 2000 && /no PageRequestManager/.test(idle.reason), JSON.stringify(idle));
    await page.selectOption("#state", "OR");
    const res = await waitForSettled(page, { quietMs: 300, timeoutMs: 5000 });
    const counties = await optionsOf(page, "#county");
    check("a fetch-driven cascade is waited out by the in-flight request counter",
      res.settled && counties.join("|") === "Deschutes|Crook" && /net/.test(res.reason),
      `settle=${JSON.stringify(res)} counties=${JSON.stringify(counties)}`);
    await page.context().close();
  }

  // ---- 4. A page that never settles reports it, rather than pretending -----------------------
  {
    const page = await fresh("/plain");
    await page.evaluate(() => { setInterval(() => { const p = document.getElementById("static"); if (p) p.textContent = String(Math.random()); }, 50); });
    const res = await waitForSettled(page, { quietMs: 300, timeoutMs: 1200 });
    check("a page that keeps mutating returns settled:false with a reason, not a silent pass",
      !res.settled && /timeout/.test(res.reason), JSON.stringify(res));
    await page.context().close();
  }
} finally {
  await browser.close();
  server.close();
}

if (failures) { console.error(`\n${failures} settle check(s) FAILED.`); process.exit(1); }
console.log("\nAll settle checks passed.");
process.exit(0);
