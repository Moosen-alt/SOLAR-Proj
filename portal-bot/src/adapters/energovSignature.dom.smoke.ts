// THE ENERGOV E-SIGNATURE STEP — "This is fine. Push it to the review page." (operator ruling
// 2026-09-26, on the finding "Tyler step 6 'Signature' isn't treated as a stop").
//
// A SYNTHETIC replica of Tyler EnerGov Customer Self Service's 7-step apply wizard, shaped from the
// Iowa City walkthrough (.probe/kin/ia/energov-flow.md) and the CSS bundle's TylerSignaturePad
// directive (consent name + "Enable Type Signature" + #signatureTypedNameId, drawn into a canvas
// pad; Next is refused until a signature is added and the consent name is typed). Fake data only.
// One URL for the whole wizard (the real SPA keeps its apply route across steps); a step bar that
// names "Review and Submit" on EVERY step, as a clickable list; Next posts a draft save; on step 7
// the Next has become "Submit", which posts the filing.
//
// The learner runs with a FAKE planner that fills every box it is offered — including the
// signature name, with "Planner Person" — ticks every checkbox and advances with Next.
//
// MUST-PASS  iowa (typed signature, client signer "Dana Signer"): steps 1-6 advance, the signature
//            is typed as Dana Signer in both boxes (never "Planner Person"), the run ends AT REVIEW
//            (reachedReview) with Submit NOT clicked and 0 filing requests; the recipe binds both
//            signature boxes to authorizedSignerName with NO literal anywhere.
// MUST-PASS  replay of that recipe with the client's signer reaches review the same way.
// MUST-EXCLUDE noSigner (same wizard, client has no authorized signer): PAUSED at step 6, named
//            (signature_no_signer); nothing typed into either signature box; the switch untouched.
// MUST-EXCLUDE replay of the recipe for a client with no signer: paused before typing, named.
// MUST-EXCLUDE carlsbad (typed consent + a pad to DRAW in, no type option): stopped at step 6 for a
//            person (signature_drawn); the pad never drawn on; nothing typed.
//
// Run: npx tsx portal-bot/src/adapters/energovSignature.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const STEPS = ["Locations", "Type", "Contacts", "More Info", "Attachments", "Signature", "Review and Submit"];

// The wizard. `variant` = "iowa" (typed signature offered) | "carlsbad" (draw only).
const wizard = (variant: string): string => `<!doctype html><html><head><title>Apply - Residential Electrical - Solar</title>
<style>body{font-family:sans-serif} .steps li{display:inline-block;margin-right:8px} .signature-pad canvas{border:1px solid #999}
.switch input{width:16px;height:16px} .alert{color:#b00}</style></head><body>
<header><a href="#/home">Home</a> <a href="#/apply">Apply</a> <a href="#/search">Search</a></header>
<ol class="steps" aria-label="Application steps">${STEPS.map((s, i) => `<li><a href="#/permit/apply/12/0/step/${i + 1}" onclick="return false">${i + 1} ${s}</a></li>`).join("")}</ol>
<main id="main"></main>
<script>
var V = ${JSON.stringify(variant)};
var S = { step: 1, drawn: false, submitClicked: false, consentName: "", typedName: "", isType: false, saves: 0, vals: {} };
window.__S = S;
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]; }); }
function btns(last){ return '<div class="actions"><button type="button" id="back">Back</button> <button type="button" id="tmpl">Create Template</button> <button type="button" id="draft">Save Draft</button> <button type="button" id="next">' + (last ? 'Submit' : 'Next') + '</button></div><div class="alert" id="err"></div>'; }
function field(id, label, extra){ return '<div><label for="' + id + '">' + label + '</label> <input id="' + id + '" ' + (extra || '') + '></div>'; }
function render(){
  var m = document.getElementById("main"), h = "";
  if (S.step === 1) h = '<h2>Locations</h2><p>Search for the address number and street name only</p>' + field("addr", "Address Search", 'required') +
    '<table><tr><td><input type="checkbox" id="loc1" required><label for="loc1">Add location: 410 E Washington St</label></td><td>Parcel 1010101010</td></tr></table>';
  if (S.step === 2) h = '<h2>Type</h2><div><label for="ptype">Permit Type</label> <select id="ptype" disabled><option>Residential Electrical - Solar</option></select></div>' +
    '<div><label for="desc">Description *</label> <textarea id="desc" required></textarea></div>' + field("val", "Valuation *", 'type="number" required');
  if (S.step === 3) h = '<h2>Contacts</h2><p>Company (account holder)</p>' + field("ctr", "Contractor (Electrical) Company Name *", 'required');
  if (S.step === 4) h = '<h2>More Info</h2><fieldset><legend>Service Size *</legend><label><input type="checkbox" id="a100"> 100 AMP</label> <label><input type="checkbox" id="a200"> 200 AMP</label></fieldset>' +
    field("mfr", "Product Manufacturer Name *", 'required') + '<div><label for="stype">Solar Type *</label> <select id="stype" required><option value="">Select</option><option>Standard String Array</option><option>Micro-Inverter</option></select></div>' +
    field("units", "No. of Dwelling Units *", 'type="number" required');
  if (S.step === 5) h = '<h2>Attachments</h2><div class="card"><label for="up1">Manufacturer\\'s Product Data/Spec (REQUIRED)</label> <input type="file" id="up1"></div>' +
    '<div class="card"><label for="up2">Solar Roof Plan/Solar Site Plan (REQUIRED)</label> <input type="file" id="up2"></div>';
  if (S.step === 6) {
    h = '<h2>Signature</h2><p>I am authorized to apply for this permit on behalf of the owner, and the contractor license was obtained.</p>' +
      '<div><label for="consentName">' + (V === "carlsbad" ? 'Type in your full-name as consent to electronically sign, and draw your signature in the box below' : 'Please type your name as consent to electronically sign this application') + ' *</label> <input id="consentName" type="text"></div>';
    if (V === "iowa") h += '<div class="switch"><input type="checkbox" id="isType"><label for="isType">Enable Type Signature</label></div>' +
      '<div><label for="signatureTypedNameId">Type Signature</label> <input id="signatureTypedNameId" type="text" disabled></div>';
    h += '<div class="signature-pad" id="sigpad"><canvas id="canvas" width="400" height="120"></canvas></div>';
  }
  if (S.step === 7) h = '<h2>Review and Submit</h2><p>Estimated fees: Electronic Plan and Document Fee $28.00, Residential Solar Fee $50.00, Total $78.00</p>' +
    '<p>Signed by: <span id="signedBy">' + esc(S.consentName) + '</span></p>';
  m.innerHTML = h + btns(S.step === 7);
  wire();
}
function val(id){ var e = document.getElementById(id); return e ? (e.type === "checkbox" ? e.checked : e.value) : null; }
function wire(){
  var el = function(id){ return document.getElementById(id); };
  if (S.step === 6) {
    var c = el("consentName"); c.addEventListener("input", function(){ S.consentName = c.value; });
    var cv = el("canvas"); cv.addEventListener("pointerdown", function(){ if (!S.isType) S.drawn = true; }); cv.addEventListener("mousedown", function(){ if (!S.isType) S.drawn = true; });
    if (V === "iowa") {
      var t = el("isType"), ty = el("signatureTypedNameId");
      t.addEventListener("change", function(){ S.isType = t.checked; ty.disabled = !t.checked; if (!t.checked) { ty.value = ""; S.typedName = ""; } });
      ty.addEventListener("input", function(){ S.typedName = ty.value; var g = cv.getContext("2d"); g.clearRect(0,0,400,120); g.font = "30px cursive"; g.fillText(ty.value, 10, 70); });
    }
  }
  el("next").addEventListener("click", function(){
    var err = el("err"); err.textContent = "";
    if (S.step === 7) { S.submitClicked = true; fetch("/apps/selfservice/api/energov/permit/submit", { method: "POST", body: "x=1" }).catch(function(){}); return; }
    var need = { 1: ["addr", "loc1"], 2: ["desc", "val"], 3: ["ctr"], 4: ["mfr", "stype", "units"] }[S.step] || [];
    for (var i = 0; i < need.length; i++) { if (!val(need[i])) { err.textContent = "Field " + need[i] + " is required."; return; } }
    if (S.step === 6) {
      var added = V === "iowa" ? (S.isType && S.typedName.trim().length > 0) : S.drawn;
      if (!S.consentName.trim() || !added) { err.textContent = "Signature is required."; return; }
    }
    fetch("/apps/selfservice/api/energov/draft/save", { method: "POST", body: "step=" + S.step }).then(function(){ S.saves++; S.step++; render(); }).catch(function(){});
  });
  el("back").addEventListener("click", function(){ if (S.step > 1) { S.step--; render(); } });
}
render();
</script></body></html>`;

const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET" && req.method !== "HEAD") { posts.push(url.pathname); res.writeHead(200, { "content-type": "application/json" }); res.end("{\"Success\":true}"); return; }
  const v = url.searchParams.get("v") || "iowa";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(wizard(v));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const appUrl = (v: string) => `${base}/apps/selfservice?v=${v}#/permit/apply/12/0/1`;

// Fill everything it is offered, the signature name with a WRONG name; tick every box; Next.
// mode "atReviewOnSign": on the Signature step the planner claims atReview (a real planner
// does, seeing "sign ... application" and no more form) — the run must still walk to step 7.
// Labels the planner was offered, per page: the signature boxes must never be among them.
const offered: string[][] = [];
const mkPlanner = (mode: "" | "atReviewOnSign" = ""): LearnPlanner => async (req) => {
  offered.push(req.fields.map((f) => String(f.label ?? "")));
  const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
  req.fields.forEach((f, i) => {
    const l = String(f.label ?? "");
    if (f.fieldType === "text" || f.fieldType === "other") {
      // Bound like a real learn binds project data (replay supplies these keys); the signature
      // name gets a WRONG name bound to the contact, which is what a planner would pick.
      const [field, v] = /sign/i.test(l) ? ["installerContactName", "Planner Person"]
        : /address/i.test(l) ? ["street", "410 E Washington St"]
        : /valuation/i.test(l) ? ["valuation", "20000"] : /units/i.test(l) ? ["dwellingUnits", "1"]
        : /description/i.test(l) ? ["projectDescription", "Roof-mounted solar PV"]
        : /contractor/i.test(l) ? ["installerCompanyName", "Test Solar Co"] : ["moduleMake", "Test Modules"];
      fills.push({ selectorIndex: i, value: v, field });
    } else if (f.fieldType === "checkbox") fills.push({ selectorIndex: i, value: "true" });
    else if (f.fieldType === "select" && (f.options ?? []).length > 1) fills.push({ selectorIndex: i, value: String((f.options ?? [])[1]) });
  });
  const submit = req.fields.findIndex((f) => f.fieldType === "button" && /^submit$/i.test(String(f.label ?? "").trim()));
  if (submit >= 0) return { fills: [], atReview: true, finalSubmitSelectorIndex: submit };
  const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
  if (mode === "atReviewOnSign" && /electronically sign/i.test(req.bodyText)) return { fills, atReview: true, finalSubmitSelectorIndex: next >= 0 ? next : undefined };
  return { fills, atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
};
const planner = mkPlanner();

const state = async (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __S: Record<string, unknown> }).__S;
  const box = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? null;
  return { ...s, consentBox: box("consentName"), typedBox: box("signatureTypedNameId") } as Record<string, unknown>;
}).catch((e) => ({ error: String(e) }) as Record<string, unknown>);

const project = { projectAddress: "410 E Washington St, Iowa City, IA, 52240", city: "Iowa City", state: "IA", zip: "52240", homeownerName: "Test Owner" } as never;

const browser = await chromium.launch();
let learnedSteps: RecipeStep[] = [];
try {
  for (const run of [
    { name: "iowa", variant: "iowa", signer: "Dana Signer", mode: "" as const },
    { name: "noSigner", variant: "iowa", signer: "", mode: "" as const },
    { name: "carlsbad", variant: "carlsbad", signer: "Dana Signer", mode: "" as const },
    // KILL A (portal-run-close MF2): the planner claims atReview on the signed step 6. The
    // override (a signed step's Next is not the end) must still walk to step 7 — and it must
    // not fire on a page that itself reads as review (signatureShapes combinedReviewSign).
    { name: "iowaAtReviewOnSign", variant: "iowa", signer: "Dana Signer", mode: "atReviewOnSign" as const },
  ]) {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(appUrl(run.variant));
    posts.length = 0;
    offered.length = 0;
    const adapter = new AutoLearnAdapter("EnerGov Signature Smoke", mkPlanner(run.mode), { maxPages: 12, contactIdentity: { signerName: run.signer, lastName: "Contractor" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).page = page;
    let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
    let threw = "";
    try { r = await adapter.learn({ portalUrl: appUrl(run.variant) } as never, project); }
    catch (e) { threw = String(e).slice(0, 300); }
    const st = await state(page);
    await ctx.close().catch(() => null);
    const msg = String(r?.message ?? threw).slice(0, 500);
    const filings = posts.filter((p) => /permit\/submit/.test(p)).length;
    const saves = posts.filter((p) => /draft\/save/.test(p)).length;
    const stepsJson = JSON.stringify(r?.steps ?? []);
    check(`${run.name}: 0 filing requests reach the server, Submit never clicked`, filings === 0 && st.submitClicked === false, `filings=${filings} submitClicked=${String(st.submitClicked)} POSTs=[${posts.join(",")}]`);
    check(`${run.name}: "Planner Person" is never typed or recorded`, ![st.consentBox, st.typedBox, st.consentName, st.typedName].includes("Planner Person") && !stepsJson.includes("Planner Person"),
      `consent=${String(st.consentBox)} typed=${String(st.typedBox)}`);
    if (run.name === "iowa") {
      learnedSteps = r?.steps ?? [];
      if (process.env.DEBUG_SIG) console.log(JSON.stringify(learnedSteps, null, 1));
      const sigFills = learnedSteps.filter((s) => s.action === "fill" && /^e-signature:/.test(String(s.note ?? "")));
      check("MUST-PASS iowa: steps 1-6 advance (6 draft saves) and the run ends AT REVIEW (step 7, reachedReview)",
        st.step === 7 && saves === 6 && r?.reachedReview === true, `step=${String(st.step)} saves=${saves} reachedReview=${String(r?.reachedReview)} ok=${String(r?.ok)} stop=${String(r?.stopReason)} ${msg}`);
      check("MUST-PASS iowa: the signature is the client's signer in both boxes, the type switch on",
        st.consentName === "Dana Signer" && st.typedName === "Dana Signer" && st.isType === true && st.drawn === false,
        `consent=${String(st.consentName)} typed=${String(st.typedName)} isType=${String(st.isType)} drawn=${String(st.drawn)}`);
      check("MUST-PASS iowa: the recipe binds both signature boxes to authorizedSignerName with NO literal, and records the switch",
        sigFills.length === 2 && sigFills.every((s) => s.field === "authorizedSignerName" && s.value === undefined) && !stepsJson.includes("Dana Signer")
          && learnedSteps.some((s) => s.action === "check" && /^e-signature:/.test(String(s.note ?? ""))),
        `sigFills=${JSON.stringify(sigFills)}`);
      const sigOffered = offered.flat().filter((l) => /consent to electronically sign|type signature/i.test(l));
      check("MUST-PASS iowa: the planner is never offered a signature box (one signer rule)", sigOffered.length === 0, `offered=${JSON.stringify(sigOffered)}`);
    } else if (run.name === "iowaAtReviewOnSign") {
      check("MUST-PASS iowaAtReviewOnSign (kill A): a planner atReview on the signed step 6 still advances to step 7 (reachedReview), signed as the client's signer",
        st.step === 7 && saves === 6 && r?.reachedReview === true && st.consentName === "Dana Signer" && st.typedName === "Dana Signer",
        `step=${String(st.step)} saves=${saves} reachedReview=${String(r?.reachedReview)} stop=${String(r?.stopReason)} ${msg}`);
    } else if (run.name === "noSigner") {
      check("MUST-EXCLUDE noSigner: PAUSED at step 6, named (signature_no_signer)",
        st.step === 6 && r?.pauseReason === "signature_no_signer" && r?.stopReason === "signature_no_signer" && /no authorized signer/.test(msg), `step=${String(st.step)} pause=${String(r?.pauseReason)} ${msg}`);
      check("MUST-EXCLUDE noSigner: nothing typed into either signature box, the switch untouched",
        st.consentBox === "" && st.typedBox === "" && st.isType === false, `consent=${String(st.consentBox)} typed=${String(st.typedBox)} isType=${String(st.isType)}`);
    } else {
      check("MUST-EXCLUDE carlsbad: stopped at step 6 for a person (signature_drawn), named",
        st.step === 6 && r?.pauseReason === "signature_drawn" && /DRAWN signature/.test(msg), `step=${String(st.step)} pause=${String(r?.pauseReason)} ${msg}`);
      check("MUST-EXCLUDE carlsbad: the pad is never drawn on and no name is typed", st.drawn === false && st.consentBox === "", `drawn=${String(st.drawn)} consent=${String(st.consentBox)}`);
    }
  }

  // REPLAY the learned recipe (review stop appended), with and without a signer on the client.
  // KILL C: an OLDER recipe whose signature boxes a planner bound to installerContactName, with
  // no "e-signature:" note — replay's resolveValue must still type the client's signer there.
  const oldBinding = (steps: RecipeStep[]): RecipeStep[] => steps.map((s) => (s.action === "fill" && /^e-signature:/.test(String(s.note ?? ""))
    ? { ...s, field: "installerContactName", note: "signature name" } : s));
  const recipe = (steps: RecipeStep[] = learnedSteps): PortalRecipe => ({
    id: "energov-sig", scopeType: "ahj", profileKey: "ia|iowa city|", state: "IA", ahj: "City of Iowa City", utility: "",
    portalPlatform: "energov", portalUrl: appUrl("iowa"), status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
    steps: [...steps.filter((s) => !s.isFinalSubmit), { action: "stopForReview" } as RecipeStep],
  } as unknown as PortalRecipe);
  const values = { street: "410 E Washington St", valuation: "20000", dwellingUnits: "1", projectDescription: "Roof-mounted solar PV", installerCompanyName: "Test Solar Co", moduleMake: "Test Modules", installerContactName: "Casey Contact", authorizedSignerName: "Dana Signer" } as Record<string, string>;
  const { authorizedSignerName: _drop, ...valuesNoSigner } = values;
  for (const rp of [
    { name: "replay", values, steps: learnedSteps },
    { name: "replayNoSigner", values: valuesNoSigner, steps: learnedSteps },
    { name: "replayOldBinding", values, steps: oldBinding(learnedSteps) },
  ]) {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    posts.length = 0;
    const adapter = new RecipeAdapter(recipe(rp.steps), rp.values, {}, {});
    (adapter as unknown as { page: unknown }).page = page;
    let res: { ok: boolean; message: string; pauseReason?: string } | null = null;
    try { res = await adapter.fillApplication({} as ProjectRecord); } catch (e) { res = { ok: false, message: `threw ${String(e).slice(0, 200)}` }; }
    await page.waitForTimeout(300);
    const st = await state(page);
    await ctx.close().catch(() => null);
    const filings = posts.filter((p) => /permit\/submit/.test(p)).length;
    check(`${rp.name}: 0 filing requests, Submit never clicked`, filings === 0 && st.submitClicked === false, `filings=${filings} POSTs=[${posts.join(",")}]`);
    if (rp.name === "replay") {
      check("MUST-PASS replay: the recipe reaches review (step 7) signed as the client's signer",
        st.step === 7 && st.consentName === "Dana Signer" && st.typedName === "Dana Signer", `step=${String(st.step)} consent=${String(st.consentName)} typed=${String(st.typedName)} ok=${String(res?.ok)} ${String(res?.message).slice(0, 300)}`);
    } else if (rp.name === "replayOldBinding") {
      check("MUST-EXCLUDE replayOldBinding (kill C): a recipe that bound the signature to installerContactName still signs as the client's signer, never the contact",
        st.step === 7 && st.consentName === "Dana Signer" && st.typedName === "Dana Signer" && st.consentName !== "Casey Contact",
        `step=${String(st.step)} consent=${String(st.consentName)} typed=${String(st.typedName)} ok=${String(res?.ok)} ${String(res?.message).slice(0, 300)}`);
    } else {
      check("MUST-EXCLUDE replayNoSigner: paused at the signature step, named, nothing typed",
        !res?.ok && res?.pauseReason === "signature_no_signer" && /no authorized signer/.test(String(res?.message)) && st.step === 6 && st.consentBox === "" && (st.typedBox === "" || st.typedBox === null),
        `ok=${String(res?.ok)} pause=${String(res?.pauseReason)} step=${String(st.step)} consent=${String(st.consentBox)} typed=${String(st.typedBox)} ${String(res?.message).slice(0, 300)}`);
    }
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} energov-signature check(s) FAILED.`); process.exit(1); }
console.log("\nAll energov-signature checks passed (real Chromium).");
process.exit(0);
