// THE ONE SIGNER RULE AND THE ONE REVIEW PREDICATE, ON THE SHAPES THE SKEPTIC BROKE THEM WITH
// (portal-run-close, 2026-09-26). A synthetic EnerGov-shaped 3-step wizard (Description /
// <variant> / Review and Submit) with a clickable step bar naming "Review and Submit" on every
// step, driven by a REALISTIC fake planner: a box whose label says "name" or "signature" gets
// the installer contact ("Casey Contact", bound installerContactName) — which is what an LLM
// planner did on every one of these shapes. Fake data only; 0 filing requests may reach the
// server on any run (the network backstop is the hard line; the counts below are the evidence).
//
// MUST-EXCLUDE (MF1, a signature by the wrong person): certifyNoWord ("Type your full name" under
//   "I certify under penalty of perjury…"), bareSignature ("Applicant Signature" under "By typing
//   your name below you are signing…"), certifierName ("Full name of person certifying"):
//   with a signer the box holds the CLIENT's signer, bound to authorizedSignerName with no literal,
//   the planner is never offered the box, and the run reaches review; with no signer it PAUSES
//   signature_no_signer with nothing typed. "Casey Contact" is never typed.
// MUST-PASS  contactsFullName (a plain "Full name" on the contacts step) and applicantName ("Applicant
//   Name" on a non-attesting form) are still the planner's: Casey Contact typed, review reached,
//   with and without a signer (no pause).
// MUST-EXCLUDE (MF2, a filing during a learn): combinedReviewSign ("Please review and sign" + a
//   consent box + a Next that FILES to an unknown URL, planner says atReview): signed, 0 POSTs,
//   the run stops at review. reviewNextStepsClass (the review heading inside a container whose
//   class says "steps", Next files): 0 POSTs, stops at review.
// MUST-PASS  (false stops on the review page): reviewEchoCanvas / reviewEchoTyped (the review page
//   echoes the signature as a pad image / a locked typed box) reach review, never signature_*.
// MUST-PASS  pcEsigEmailText / pcEsigEmailType ("Customer Email for e-Signature", type=text / email):
//   an EMAIL box — the planner's email lands, the signer's name never does, the walk goes on.
// KILL R     replay of an OLDER recipe that bound the certifyNoWord box to installerContactName:
//   the signer with one, a signature_no_signer pause without, never the contact (live reading).
// KILL B     applyFill, called directly outside the signature pass on the bareSignature box (label
//   names a signature) and on the certifyNoWord box (only the in-page mark says so): refused, the
//   box stays empty. Switching the guard off makes this red.
//
// Run: npx tsx portal-bot/src/adapters/signatureShapes.dom.smoke.ts [mf1|review|planner|variant,...]
//      (signatureShapesReview / signatureShapesPlanner .dom.smoke.ts run the other two groups)
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import { AutoLearnAdapter, type ExtractedField, type LearnPlanner } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const STEPS = ["Description", "Sign", "Review and Submit"];
type V = { step2: string; review: string; lastBtn: string; lastUrl: string; planner?: "atReviewOnSign" | "naive"; sigLabel?: string; nameBox?: "contact" | "signer" | "email" };
const REVIEW = `<h2>Review and Submit</h2><p>Total fees $78.00</p>`;
const SUBMIT = "/api/energov/permit/submit";
const V: Record<string, V> = {
  // MF1 — the three shapes the skeptic typed the contact into.
  certifyNoWord: { step2: `<h2>Certification</h2><p>I certify under penalty of perjury that I am the applicant or the applicant's authorized agent and that the information in this application is true and correct.</p><div><label for="nm">Type your full name *</label> <input id="nm" data-name type="text"></div>`, review: REVIEW, lastBtn: "Submit", lastUrl: SUBMIT, sigLabel: "Type your full name", nameBox: "signer" },
  bareSignature: { step2: `<h2>Applicant Declaration</h2><p>By typing your name below you are signing this application electronically.</p><div><label for="nm">Applicant Signature *</label> <input id="nm" data-name type="text"></div>`, review: REVIEW, lastBtn: "Submit", lastUrl: SUBMIT, sigLabel: "Applicant Signature", nameBox: "signer" },
  certifierName: { step2: `<h2>Owner Authorization</h2><p>I hereby certify that I have read and examined this application and know the same to be true and correct.</p><div><label for="nm">Full name of person certifying *</label> <input id="nm" data-name type="text"></div>`, review: REVIEW, lastBtn: "Submit", lastUrl: SUBMIT, sigLabel: "Full name of person certifying", nameBox: "signer" },
  // MUST-PASS — ordinary name boxes stay the planner's.
  contactsFullName: { step2: `<h2>Contacts</h2><p>Company (account holder)</p><div><label for="nm">Full name *</label> <input id="nm" data-name type="text"></div><div><label for="co">Company</label> <input id="co" type="text"></div>`, review: REVIEW, lastBtn: "Submit", lastUrl: SUBMIT, nameBox: "contact" },
  applicantName: { step2: `<h2>Applicant</h2><p>Who is applying for this permit?</p><div><label for="nm">Applicant Name *</label> <input id="nm" data-name type="text"></div>`, review: REVIEW, lastBtn: "Submit", lastUrl: SUBMIT, nameBox: "contact" },
  // MF2 — a combined confirm+sign page whose Next FILES (unknown URL); the planner says atReview.
  combinedReviewSign: { step2: `<h2>Confirm and Sign</h2><p>Please review and sign. Permit type: Residential Solar. Valuation: $20,000.</p><div><label for="nm">Please type your name as consent to electronically sign this application *</label> <input id="nm" data-name type="text"></div>`, review: `<h2>Thank you</h2><p>Application received.</p>`, lastBtn: "Next", lastUrl: "/api/energov/permit/apply/12", planner: "atReviewOnSign", sigLabel: "consent to electronically sign", nameBox: "signer" },
  // Navigator cut — the review heading inside a "steps" container; Next files; naive planner advances.
  reviewNextStepsClass: { step2: `<h2>More Info</h2><div><label for="nm">Product Manufacturer Name *</label> <input id="nm" data-name type="text"></div>`, review: `<div class="wizard-steps-content"><h2>Review and Submit</h2><p>Estimated fees: Total $78.00</p></div>`, lastBtn: "Next", lastUrl: "/api/energov/permit/apply/12", planner: "naive" },
  // Angular Material: the whole stepper (header + content) under one [class*=stepper] element.
  reviewMatStepper: { step2: `<h2>More Info</h2><div><label for="nm">Product Manufacturer Name *</label> <input id="nm" data-name type="text"></div>`, review: `<div class="mat-stepper-horizontal"><div class="mat-horizontal-stepper-header-container" role="tablist"><div role="tab">1 Description</div><div role="tab">2 More Info</div><div role="tab">3 Review and Submit</div></div><div class="mat-horizontal-content-container"><h2>Review and Submit</h2><p>Estimated fees: Total $78.00</p></div></div>`, lastBtn: "Next", lastUrl: "/api/energov/permit/apply/12", planner: "naive" },
  // The review page echoes the signature (a rendered pad / a locked typed box).
  reviewEchoCanvas: { step2: `<h2>More Info</h2><div><label for="nm">Product Manufacturer Name *</label> <input id="nm" data-name type="text"></div>`, review: `<h2>Review and Submit</h2><p>Estimated fees: Total $78.00</p><p>Signature</p><div class="signature-pad"><canvas width="300" height="80"></canvas></div><p>Signed by Dana Signer on 09/26/2026</p>`, lastBtn: "Submit", lastUrl: SUBMIT },
  reviewEchoTyped: { step2: `<h2>More Info</h2><div><label for="nm">Product Manufacturer Name *</label> <input id="nm" data-name type="text"></div>`, review: `<h2>Review and Submit</h2><p>Estimated fees: Total $78.00</p><div><label for="signatureTypedNameId">Type Signature</label> <input id="signatureTypedNameId" type="text" disabled value="Dana Signer"></div>`, lastBtn: "Submit", lastUrl: SUBMIT },
  // PowerClerk-style: where the utility sends its DocuSign — an email box, never a name box.
  pcEsigEmailText: { step2: `<h2>Customer Information</h2><p>The utility will send the interconnection agreement for signature through DocuSign.</p><div><label for="nm">Customer Email for e-Signature *</label> <input id="nm" data-name type="text"></div>`, review: REVIEW, lastBtn: "Submit", lastUrl: SUBMIT, nameBox: "email" },
  pcEsigEmailType: { step2: `<h2>Customer Information</h2><div><label for="nm">Customer Email for e-Signature *</label> <input id="nm" data-name type="email"></div>`, review: REVIEW, lastBtn: "Submit", lastUrl: SUBMIT, nameBox: "email" },
};

const page = (v: V): string => `<!doctype html><html><head><title>Apply - Residential Solar</title></head><body>
<ol class="steps" aria-label="Application steps">${STEPS.map((s, i) => `<li><a href="#" onclick="return false">${i + 1} ${s}</a></li>`).join("")}</ol>
<main id="main"></main>
<script>
var S = { step: 1, lastClicked: false }; window.__S = S;
var V = ${JSON.stringify(v)};
function render(){
  var h = "";
  if (S.step === 1) h = '<h2>Description</h2><div><label for="desc">Description *</label> <textarea id="desc"></textarea></div>';
  if (S.step === 2) h = V.step2;
  if (S.step === 3) h = V.review;
  document.getElementById("main").innerHTML = h + '<div class="actions"><button type="button" id="back">Back</button> <button type="button" id="draft">Save Draft</button> <button type="button" id="next">' + (S.step === 3 ? V.lastBtn : 'Next') + '</button></div><div id="err"></div>';
  document.getElementById("next").addEventListener("click", function(){
    if (S.step === 1 && !document.getElementById("desc").value) { document.getElementById("err").textContent = "Description is required."; return; }
    if (S.step === 2) {
      var n = document.getElementById("nm"); window.__typed = n ? n.value : null;
      if (n && !n.value.trim()) { document.getElementById("err").textContent = "Name is required."; return; }
      if (V.lastUrl && V.step2.indexOf("Confirm and Sign") >= 0) { S.lastClicked = true; fetch(V.lastUrl, { method: "POST", body: "x=1" }).then(function(){ S.step = 3; render(); }); return; }
    }
    if (S.step === 3) { S.lastClicked = true; fetch(V.lastUrl, { method: "POST", body: "x=1" }).catch(function(){}); return; }
    fetch("/api/energov/draft/save", { method: "POST", body: "s=" + S.step }).then(function(){ S.step++; render(); });
  });
}
window.__render = render;
render();
</script></body></html>`;

const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET" && req.method !== "HEAD") { posts.push(url.pathname); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
  const v = V[url.searchParams.get("v") || ""] ?? V.certifyNoWord;
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page(v));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// Labels the planner was offered, per page (the signature box must never be among them).
const offered: string[][] = [];
// The certifyNoWord recipe as the learner records it (signer run) — replay starts from it.
let learnedCertify: RecipeStep[] = [];
const mkPlanner = (mode: V["planner"]): LearnPlanner => async (req) => {
  offered.push(req.fields.map((f) => String(f.label ?? "")));
  const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
  req.fields.forEach((f, i) => {
    const l = String(f.label ?? "");
    if (!["button", "checkbox", "select", "file", "radio", "link"].includes(String(f.fieldType)) && !f.disabled) {
      const [field, v] = /email/i.test(l) ? ["homeownerEmail", "owner@example.test"] : /name|signature/i.test(l) && !/manufacturer|company/i.test(l) ? ["installerContactName", "Casey Contact"]
        : /company/i.test(l) ? ["installerCompanyName", "Test Solar Co"]
        : /description/i.test(l) ? ["projectDescription", "Roof-mounted solar PV"] : /comment/i.test(l) ? ["", "n/a"] : ["moduleMake", "Test Modules"];
      fills.push({ selectorIndex: i, value: v, ...(field ? { field } : {}) });
    }
  });
  const submit = req.fields.findIndex((f) => f.fieldType === "button" && /^submit$/i.test(String(f.label ?? "").trim()));
  const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
  if (submit >= 0) return { fills: [], atReview: true, finalSubmitSelectorIndex: submit };
  if (mode === "atReviewOnSign" && /confirm and sign/i.test(req.bodyText)) return { fills, atReview: true, finalSubmitSelectorIndex: next >= 0 ? next : undefined };
  return { fills, atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
};

type St = { step?: number; lastClicked?: boolean; typed?: string | null; box?: string | null; err?: string };
const readState = (pg: Page): Promise<St> => pg.evaluate(() => ({
  ...(window as unknown as { __S: Record<string, unknown> }).__S,
  typed: (window as unknown as { __typed?: string }).__typed ?? null,
  box: (document.getElementById("nm") as HTMLInputElement | null)?.value ?? null,
})).catch((e) => ({ err: String(e) })) as Promise<St>;

// THREE RUNNER-SIZED FILES, ONE HARNESS. A learn on this wizard takes ~60 s; all 13 shapes with
// both signers ran 25 min and the DOM runner (600 s per smoke) reported it as a hang. So this
// file (no argument) runs the MF1 group; signatureShapesReview.dom.smoke.ts and
// signatureShapesPlanner.dom.smoke.ts import it with their own group — each under 400 s.
// Both signers run where the box IS a signature (the no-signer PAUSE is half the rule); the
// review-page and planner shapes run once, with no signer (a false signature reading there
// shows as a pause).
export const GROUPS: Record<string, string[]> = {
  mf1: ["certifyNoWord", "bareSignature", "certifierName"],
  review: ["combinedReviewSign", "reviewNextStepsClass", "reviewMatStepper", "reviewEchoCanvas", "reviewEchoTyped"],
  planner: ["contactsFullName", "applicantName", "pcEsigEmailText", "pcEsigEmailType"],
};
const BOTH_SIGNERS = new Set(["certifyNoWord", "bareSignature", "certifierName", "combinedReviewSign", "pcEsigEmailText", "pcEsigEmailType"]);
const which = (process.argv[2] ? (GROUPS[process.argv[2]] ?? process.argv[2].split(",")) : GROUPS.mf1);
const browser = await chromium.launch();
try {
  for (const name of which) {
    const v = V[name];
    if (!v) { console.log(`?? ${name}`); continue; }
    for (const signer of BOTH_SIGNERS.has(name) ? ["Dana Signer", ""] : [""]) {
      const ctx = await browser.newContext();
      ctx.setDefaultTimeout(8000);
      await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
      const pg = await ctx.newPage();
      const url = `${base}/apps/selfservice?v=${name}#/permit/apply/12`;
      await pg.goto(url);
      posts.length = 0;
      offered.length = 0;
      const adapter = new AutoLearnAdapter("Signature Shapes", mkPlanner(v.planner), { maxPages: 8, contactIdentity: { signerName: signer, firstName: "Casey", lastName: "Contact" } });
      (adapter as unknown as { page: unknown }).page = pg;
      let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
      let threw = "";
      try { r = await adapter.learn({ portalUrl: url } as never, { projectAddress: "1 Test St, Iowa City, IA 52240", city: "Iowa City", state: "IA", homeownerName: "Test Owner" } as never); }
      catch (e) { threw = String(e).slice(0, 200); }
      await pg.waitForTimeout(300);
      const st = await readState(pg);
      await ctx.close().catch(() => null);
      const filing = posts.filter((p) => !/draft\/save/.test(p));
      const tag = `${name} signer=${JSON.stringify(signer)}`;
      const msg = String(r?.message ?? threw).replace(/\s+/g, " ").slice(0, 240);
      const detail = `filingPOSTs=${filing.length} [${filing.join(",")}] state=${JSON.stringify(st)} ok=${String(r?.ok)} review=${String(r?.reachedReview)} stop=${String(r?.stopReason ?? r?.pauseReason)} msg=${msg}`;
      const stepsJson = JSON.stringify(r?.steps ?? []);
      if (name === "certifyNoWord" && signer && r?.steps) learnedCertify = r.steps as RecipeStep[];
      const sigFills = (r?.steps ?? []).filter((s) => s.action === "fill" && /^e-signature:/.test(String(s.note ?? "")));
      const sigOffered = v.sigLabel ? offered.flat().filter((l) => l.toLowerCase().includes(v.sigLabel!.toLowerCase())) : [];
      // Whatever the shape: nothing files, and the contact's name never signs.
      check(`${tag}: 0 filing requests reach the server`, filing.length === 0 && st.lastClicked !== true, detail);
      if (v.nameBox === "signer") {
        check(`${tag}: "Casey Contact" is never typed into the signature box nor recorded`, st.box !== "Casey Contact" && st.typed !== "Casey Contact" && !stepsJson.includes("Casey Contact"), detail);
        check(`${tag}: the planner is never offered the signature box`, sigOffered.length === 0, `offered=${JSON.stringify(sigOffered)} ${detail}`);
        if (signer) {
          const signedValue = name === "combinedReviewSign" ? st.box : st.typed;
          check(`MUST-EXCLUDE ${tag}: signed as the CLIENT's signer, bound to authorizedSignerName with no literal, run reaches review`,
            signedValue === "Dana Signer" && r?.reachedReview === true && sigFills.length >= 1 && sigFills.every((s) => s.field === "authorizedSignerName" && (s as { value?: string }).value === undefined) && !stepsJson.includes("Dana Signer"),
            `sigFills=${JSON.stringify(sigFills)} ${detail}`);
        } else {
          check(`MUST-EXCLUDE ${tag}: PAUSED signature_no_signer, nothing typed into the box`,
            r?.pauseReason === "signature_no_signer" && r?.stopReason === "signature_no_signer" && st.box === "" && st.step === 2, detail);
        }
        if (name === "combinedReviewSign") {
          check(`MUST-EXCLUDE ${tag}: the filing Next is never clicked — the run stops AT review on the combined page`, st.step === 2 && st.lastClicked !== true, detail);
        }
      } else if (v.nameBox === "contact") {
        check(`MUST-PASS ${tag}: a plain name box is still the planner's (Casey Contact typed) and the run reaches review, no pause`,
          st.typed === "Casey Contact" && r?.reachedReview === true && !/^signature_/.test(String(r?.pauseReason ?? "")), detail);
      } else if (v.nameBox === "email") {
        check(`MUST-PASS ${tag}: the e-signature EMAIL box takes the planner's email, never a name, and the walk goes on to review`,
          st.typed === "owner@example.test" && r?.reachedReview === true && !/^signature_/.test(String(r?.pauseReason ?? "")), detail);
      } else {
        // The review-page shapes: the run reaches review and never ends on a signature stop.
        check(`MUST-PASS ${tag}: reaches review (reachedReview), not a signature stop, the last button never clicked`,
          r?.reachedReview === true && !/^signature_/.test(String(r?.pauseReason ?? "")) && st.step === 3 && st.lastClicked !== true, detail);
      }
    }
  }

  // KILL B — the applyFill guard, reached directly (a rescan or a gap pass would reach it the
  // same way): outside the signature pass a signature box is refused by label, and a name box
  // under an attestation is refused by the in-page mark.
  if (which.includes("bareSignature") || which.includes("certifyNoWord")) {
    for (const [name, label] of [["bareSignature", "Applicant Signature *"], ["certifyNoWord", "Type your full name *"]] as const) {
      const ctx = await browser.newContext();
      ctx.setDefaultTimeout(8000);
      await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
      const pg = await ctx.newPage();
      await pg.goto(`${base}/apps/selfservice?v=${name}#/permit/apply/12`);
      await pg.evaluate(() => { const w = window as unknown as { __S: { step: number }; __render: () => void }; w.__S.step = 2; w.__render(); });
      const adapter = new AutoLearnAdapter("Signature Shapes", mkPlanner(undefined), { maxPages: 8, contactIdentity: { signerName: "Dana Signer" } });
      (adapter as unknown as { page: unknown }).page = pg;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = adapter as any;
      const sig = await a.signatureStepHere();
      const field: ExtractedField = { selector: { css: "#nm" }, label, fieldType: "text" };
      const step = await a.applyFill(field, { value: "Casey Contact", field: "installerContactName" }, false);
      const held = await pg.locator("#nm").inputValue().catch(() => "?");
      await ctx.close().catch(() => null);
      check(`KILL B ${name}: applyFill outside the signature pass is refused (no step, box empty); in-page reading=${String(sig?.kind)}`,
        step === null && held === "", `step=${JSON.stringify(step)} held=${JSON.stringify(held)} sig=${JSON.stringify(sig)}`);
    }
  }

  // REPLAY OF AN OLDER RECIPE (kill R): learned before the one signer rule, the certifyNoWord box
  // ("Type your full name" — an ordinary label; only the "I certify…" statement above makes it a
  // signature) was recorded as a planner fill bound to installerContactName, with no e-signature
  // note. Replay reads the control live with the learner's in-page reading: with a signer it
  // types the CLIENT's signer, without one it PAUSES signature_no_signer, nothing typed.
  // Never "Casey Contact". Switching replay's live check off makes this red.
  if (which.includes("certifyNoWord")) {
    const url = `${base}/apps/selfservice?v=certifyNoWord#/permit/apply/12`;
    // The learned recipe with its signature step turned into what a pre-rule learn recorded: the
    // planner's fill of an ordinary-looking box, bound to installerContactName, no e-signature note.
    const oldSteps: RecipeStep[] = learnedCertify.filter((st) => !st.isFinalSubmit).map((st) => (st.action === "fill" && /^e-signature:/.test(String(st.note ?? ""))
      ? { ...st, selector: { css: "#nm", label: "Type your full name *" } as RecipeStep["selector"], field: "installerContactName", note: "Type your full name" }
      : st));
    oldSteps.push({ action: "stopForReview" } as RecipeStep);
    check("replayOld: the learned certifyNoWord recipe carries one signature step to turn into an old binding",
      learnedCertify.filter((st) => /^e-signature:/.test(String(st.note ?? ""))).length === 1, JSON.stringify(learnedCertify).slice(0, 400));
    const recipe = { id: "sig-shapes-old", scopeType: "ahj", profileKey: "ia|iowa city|", state: "IA", ahj: "City of Iowa City", utility: "", portalPlatform: "energov", portalUrl: url, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "", steps: oldSteps } as unknown as PortalRecipe;
    const withSigner = { projectDescription: "Roof-mounted solar PV", installerContactName: "Casey Contact", authorizedSignerName: "Dana Signer" } as Record<string, string>;
    const { authorizedSignerName: _drop, ...noSigner } = withSigner;
    for (const [tag, values] of [["replayOld signer=\"Dana Signer\"", withSigner], ["replayOld signer=\"\"", noSigner]] as const) {
      const ctx = await browser.newContext();
      ctx.setDefaultTimeout(8000);
      await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
      const pg = await ctx.newPage();
      await pg.goto(url);
      posts.length = 0;
      const adapter = new RecipeAdapter(recipe, values, {}, {});
      (adapter as unknown as { page: unknown }).page = pg;
      let res: { ok: boolean; message: string; pauseReason?: string } | null = null;
      try { res = await adapter.fillApplication({} as ProjectRecord); } catch (e) { res = { ok: false, message: `threw ${String(e).slice(0, 200)}` }; }
      await pg.waitForTimeout(300);
      const st = await readState(pg);
      await ctx.close().catch(() => null);
      const filing = posts.filter((p) => !/draft\/save/.test(p));
      const detail = `filingPOSTs=${filing.length} state=${JSON.stringify(st)} ok=${String(res?.ok)} pause=${String(res?.pauseReason)} msg=${String(res?.message).replace(/\s+/g, " ").slice(0, 240)}`;
      check(`${tag}: 0 filing requests reach the server`, filing.length === 0 && st.lastClicked !== true, detail);
      if ((values as Record<string, string>).authorizedSignerName) {
        check(`MUST-EXCLUDE (kill R) ${tag}: an older recipe bound to installerContactName signs as the CLIENT's signer on replay, never the contact`,
          st.typed === "Dana Signer" && st.step === 3, detail);
      } else {
        check(`MUST-EXCLUDE (kill R) ${tag}: PAUSED signature_no_signer on replay, nothing typed`,
          res?.ok !== true && res?.pauseReason === "signature_no_signer" && st.box === "" && st.step === 2, detail);
      }
    }
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} signature-shapes check(s) FAILED.`); process.exit(1); }
console.log("\nAll signature-shapes checks passed (real Chromium).");
process.exit(0);
