// THE CODE-PROFILE VERIFY CONTROL (#209) — frontend/code-profile-verify.js, loaded here through node:vm.
//
// Verifying a seeded jurisdiction code profile used to be reachable only from /review; the owner
// could not find it from the dashboard's KB tab, where the editions are read. This pins, on synthetic
// profiles:
//   - a SEEDED AHJ row and a SEEDED state-default row each render a "Review / verify" control
//     carrying the row's key; a VERIFIED row renders none, only "Verified by <name> on <date>";
//     a lookup result with no stored row (no key) renders nothing;
//   - the panel the control opens is the /review flow: the readable summary, the raw JSON the PUT
//     sends, Mark verified / Cancel; the confirm text is the rule-3 one (locks it from automatic
//     overwrite … only after checking every value against its cited source);
//   - every interpolated value is escaped, and a source link is shown only for http(s);
//   - the wiring: both pages load the module, the KB card and the State code profiles block call it,
//     Mark verified PUTs /api/code-profiles/verify with the person's name. (No header link to /review:
//     the plan review gate is not a top-level destination — owner ruling 2026-09-15, pinned by
//     frontendDesignSystem.dom.smoke.ts; the inline control is the way in.)
//   npx tsx backend/test/codeProfileVerifyPanel.test.ts
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { REPO } from "./_isolate";
import type { JurisdictionCodeProfile } from "../../shared/src/types";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const read = (rel: string): string => {
  try { return fs.readFileSync(path.join(REPO, rel), "utf8"); } catch { return ""; }
};
const src = read("frontend/code-profile-verify.js");
const sandbox: { window: Record<string, unknown> } = { window: {} };
try { vm.runInNewContext(src, sandbox, { filename: "code-profile-verify.js" }); } catch { /* reported below */ }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CPV = sandbox.window.CodeProfileVerify as any;
check("code-profile-verify.js registers window.CodeProfileVerify", () => assert.ok(CPV, "not registered"));
if (!CPV) {
  console.log(`\ncodeProfileVerifyPanel: ${failures} check(s) FAILED.`);
  process.exit(1);
}

const HOSTILE = `<img src=x onerror="alert(1)">`;
// Typed against the shared types, so a field renamed there breaks this fixture at typecheck.
const row = (over: Partial<JurisdictionCodeProfile>): JurisdictionCodeProfile => ({
  key: "zz|city of sample", state: "ZZ", ahj: "City of Sample", confidence: "seeded",
  adoptedCodes: [{ family: "residential", code: "IRC", edition: "2021", sourceUrl: "https://codes.example.gov/irc" }],
  amendments: [{ code: "IRC", section: "R324", summary: "Rooftop PV pathways & setbacks", sourceUrl: "javascript:alert(1)" }],
  designCriteria: { groundSnowLoadPsf: 30 }, prescriptive: {}, fireSetbacks: [],
  citations: [{ label: "Synthetic adoption page", sourceUrl: "https://codes.example.gov/adoption" }], updatedAt: "",
  ...over,
});
const seededCity = row({});
const seededState = row({ key: "zy|", state: "ZY", ahj: "" });
const verifiedCity = row({ key: "zx|city of done", state: "ZX", ahj: "City of Done", confidence: "verified", verifiedBy: "Pat Synthetic", verifiedAt: "2026-10-01T12:00:00.000Z" });

check("a seeded AHJ row renders a Review / verify control carrying its key", () => {
  const html: string = CPV.renderVerifyControl(seededCity);
  assert.match(html, /<button[^>]*data-code-profile-verify="zz\|city of sample"[^>]*>Review \/ verify<\/button>/);
  assert.match(html, /data-code-profile-verify-slot="zz\|city of sample"/);
  assert.ok(!/Verified/.test(html), "a seeded row claims to be verified");
});

check("a verified row renders no control, only 'Verified by <name> on <date>'", () => {
  const html: string = CPV.renderVerifyControl(verifiedCity);
  assert.ok(!/data-code-profile-verify=/.test(html) && !/<button/.test(html), "a verified row offers a verify button");
  assert.match(html, /Verified by Pat Synthetic on 2026-10-01/);
});

check("a verified row with no name or date still says Verified, never 'by undefined'", () => {
  const html: string = CPV.renderVerifyControl(row({ confidence: "verified" }));
  assert.match(html, />Verified</);
  assert.ok(!/undefined|null/.test(html));
});

check("a lookup result with no stored row (no key) renders nothing", () => {
  assert.equal(CPV.renderVerifyControl({ ...seededCity, key: undefined }), "");
  assert.equal(CPV.renderVerifyControl(null), "");
  assert.equal(CPV.renderVerifyPanel(null), "");
});

check("the State code profiles block lists the SEEDED state-default rows, each with its control", () => {
  const html: string = CPV.renderStateVerifyRows([verifiedCity, seededCity, seededState, row({ key: "zw|", state: "ZW", ahj: "", confidence: "verified", verifiedBy: "Pat Synthetic" })]);
  assert.match(html, /State code profiles to verify \(1\)/);
  assert.match(html, /data-code-profile-verify="zy\|"/);
  assert.ok(!/data-code-profile-verify="zz\|city of sample"/.test(html), "an AHJ row (it has its own KB card) is listed in the state block");
  assert.ok(!/zw\|/.test(html), "a verified state row is offered for verification");
});

check("no seeded state row → the state block renders nothing", () => {
  assert.equal(CPV.renderStateVerifyRows([verifiedCity, seededCity]), "");
  assert.equal(CPV.renderStateVerifyRows(undefined), "");
});

const panel: string = CPV.renderVerifyPanel(seededCity);
check("the panel is the /review flow: summary, raw JSON, Mark verified, Cancel", () => {
  assert.match(panel, /Verify ZZ · City of Sample/);
  assert.match(panel, /<h4>Adopted codes<\/h4>/);
  assert.match(panel, /<b>IRC 2021<\/b>/);
  assert.match(panel, /<textarea data-code-profile-verify-json[^>]*>[^<]*&quot;state&quot;: &quot;ZZ&quot;/);
  assert.match(panel, /data-code-profile-verify-confirm="zz\|city of sample"[^>]*>Mark verified</);
  assert.match(panel, /data-code-profile-verify-cancel="zz\|city of sample"[^>]*>Cancel</);
  assert.match(panel, /Check every value against its cited source before verifying\./);
});

check("the panel's raw JSON is what the verify PUT takes (the row's values, nothing else)", () => {
  const payload = CPV.editablePayload({ ...seededCity, verifiedBy: "x", editionProposals: [] });
  assert.deepEqual(Object.keys(payload).sort(), ["adoptedCodes", "ahj", "amendments", "citations", "designCriteria", "fireSetbacks", "prescriptive", "state"]);
});

check("a source link is shown only for an http(s) URL", () => {
  assert.match(panel, /href="https:\/\/codes\.example\.gov\/irc"/);
  assert.ok(!/href="javascript:/i.test(panel), "a javascript: URL became a link");
});

check("the confirm text is the rule-3 one", () => {
  const text: string = CPV.confirmMessage("ZZ · City of Sample");
  assert.match(text, /^Mark ZZ · City of Sample verified\?/);
  assert.match(text, /locks it from automatic overwrite/);
  assert.match(text, /Only confirm after checking every value against its cited source/);
});

check("every interpolated value is escaped (control, stamp, panel, state block)", () => {
  const evil = row({ key: `k"${HOSTILE}`, state: `Z${HOSTILE}`, ahj: "", adoptedCodes: [{ family: "fire", code: HOSTILE, edition: HOSTILE }], citations: [{ label: HOSTILE, sourceUrl: "https://e.example/" }] });
  const out = [
    CPV.renderVerifyControl(evil), CPV.renderVerifyPanel(evil), CPV.renderStateVerifyRows([evil]),
    CPV.renderVerifyControl({ ...evil, confidence: "verified", verifiedBy: HOSTILE }),
  ].join("\n");
  assert.ok(!out.includes("<img"), "a raw <img> tag reached the HTML");
  assert.ok(!/="k"/.test(out), "a quote broke out of an attribute");
  assert.match(out, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

// ── wiring ──────────────────────────────────────────────────────────────────────────────────
const dash = read("frontend/dashboard.js");
const dashHtml = read("frontend/dashboard.html");
const review = read("frontend/review.js");
const reviewHtml = read("frontend/review.html");
// Lift one top-level function out of dashboard.js by name (as editionProposalsPanel.test.ts does).
const cut = (name: string): string => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(dash);
  if (!m) throw new Error(`dashboard.js: could not find function ${name}`);
  let depth = 0, end = -1;
  for (let j = dash.indexOf("{", m.index); j < dash.length; j++) {
    if (dash[j] === "{") depth++;
    else if (dash[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dash.slice(m.index, end);
};

check("both pages load the shared module before their page script", () => {
  assert.ok(/<script src="\/code-profile-verify\.js"><\/script>\s*\n\s*<script src="\/review\.js">/.test(reviewHtml), "review.html");
  const at = dashHtml.indexOf('<script src="/code-profile-verify.js">');
  assert.ok(at > 0 && at < dashHtml.indexOf('src="/dashboard.js"'), "dashboard.html");
});


check("no header link to /review (owner ruling 2026-09-15: the plan review gate is not a top-level destination)", () => {
  const header = dashHtml.slice(dashHtml.indexOf("<header"), dashHtml.indexOf("</header>"));
  assert.ok(header.length > 0, "dashboard.html has no <header>");
  assert.ok(!/href="\/review"/.test(header), "the dashboard header links /review");
});

check("the KB card and the State code profiles block render the control and bind it", () => {
  const card = dash.slice(dash.indexOf("function renderKnowledgeProfile"), dash.indexOf("function kbDeleteButtonHtml"));
  assert.match(card, /CodeProfileVerify\.renderVerifyControl\(codeProfileForKb\(/);
  const stateBlock = dash.slice(dash.indexOf("function renderStateCodeProposals"), dash.indexOf("function renderKnowledgeBase"));
  assert.match(stateBlock, /CodeProfileVerify\.renderStateVerifyRows\(/);
  assert.match(stateBlock, /bindCodeProfileVerifyButtons\(el\)/);
  const kb = dash.slice(dash.indexOf("function renderKnowledgeBase"));
  assert.match(kb, /bindCodeProfileVerifyButtons\(container\)/);
});

check("Mark verified (KB tab) asks the rule-3 confirm with a named person, then PUTs the existing route", () => {
  const fn = dash.slice(dash.indexOf("async function verifyCodeProfileFromKb"), dash.indexOf("// EDITION PROPOSALS (#172): a person approves"));
  assert.ok(fn.length > 0, "verifyCodeProfileFromKb not found");
  const consent = fn.indexOf("namedPersonConsent(auth, CPV.confirmMessage(name)");
  const put = fn.indexOf('api("/api/code-profiles/verify", { method: "PUT"');
  assert.ok(consent > 0, "no rule-3 confirm before the PUT");
  assert.ok(put > consent, "the PUT is not after the confirm");
  assert.match(fn, /if \(verifiedBy == null\) return;/);
  assert.match(fn.slice(put, put + 200), /verifiedBy/);
});

check("/review uses the shared confirm and sends the verifier's name", () => {
  assert.match(review, /window\.confirm\(CPV\.confirmMessage\(name\)\)/);
  assert.match(review, /JSON\.stringify\(\{ \.\.\.payload, verifiedBy \}\)/);
  assert.match(review, /#profile=<key>|get\("profile"\)/);
});

check("an open verify panel and its unsaved raw-JSON edits survive a KB re-render (any server-sent event)", () => {
  const kb = cut("renderKnowledgeBase");
  const cap = kb.indexOf("captureVerifyDrafts(container)");
  const swap = kb.indexOf("container.innerHTML = html");
  const restoreAt = kb.indexOf("restoreVerifyDrafts(container, drafts, bindCodeProfileVerifyButtons(container))");
  assert.ok(cap > 0 && cap < swap && restoreAt > swap, "renderKnowledgeBase does not capture before the swap and restore after binding");
  const sb = cut("renderStateCodeProposals");
  assert.ok(sb.indexOf("captureVerifyDrafts(el)") < sb.indexOf("el.innerHTML ="), "the state block does not capture before its swap");
  assert.match(sb, /restoreVerifyDrafts\(el, drafts, bindCodeProfileVerifyButtons\(el\)\)/);

  // The two helpers themselves, lifted and run against a minimal fake DOM.
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext([cut("captureVerifyDrafts"), cut("restoreVerifyDrafts")].join("\n\n") + "\nthis.capture = captureVerifyDrafts; this.restore = restoreVerifyDrafts;", ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { capture, restore } = ctx as any;
  const textarea = (value: string) => ({ value });
  const details = (open: boolean) => ({ open });
  const panel = (key: string, json: string, rawOpen: boolean) => ({
    getAttribute: (a: string) => (a === "data-code-profile-verify-panel" ? key : null),
    querySelector: (sel: string) => (sel.includes("json") ? textarea(json) : sel === "details" ? details(rawOpen) : null),
  });
  const before = { querySelectorAll: (sel: string) => (sel === "[data-code-profile-verify-panel]" ? [panel("zz|city of sample", '{"edited":true}', true)] : []) };
  const drafts = capture(before);
  assert.deepEqual(JSON.parse(JSON.stringify(drafts)), [{ key: "zz|city of sample", json: '{"edited":true}', rawOpen: true }]);

  // After the swap: two seeded buttons and one verified-meanwhile row (no button). Only the drafted
  // row reopens, with the person's edits and the raw section as they left it.
  const reopened: string[] = [];
  const slots: Record<string, { ta: { value: string }; raw: { open: boolean } }> = {};
  const button = (key: string) => ({ getAttribute: () => key });
  const after = { querySelectorAll: (sel: string) => (sel === "[data-code-profile-verify]" ? [button("zy|"), button("zz|city of sample")] : []) };
  const open = (btn: { getAttribute: () => string }) => {
    const key = btn.getAttribute();
    reopened.push(key);
    slots[key] = { ta: { value: "{\"fresh\":true}" }, raw: { open: false } };
    return { querySelector: (sel: string) => (sel.includes("json") ? slots[key].ta : sel === "details" ? slots[key].raw : null) };
  };
  restore(after, drafts, open);
  assert.deepEqual(reopened, ["zz|city of sample"]);
  assert.equal(slots["zz|city of sample"].ta.value, '{"edited":true}', "the unsaved raw-JSON edit was lost");
  assert.equal(slots["zz|city of sample"].raw.open, true);

  const gone: string[] = [];
  restore({ querySelectorAll: () => [] }, drafts, (b: { getAttribute: () => string }) => { gone.push(b.getAttribute()); return null; });
  assert.deepEqual(gone, [], "a row with no verify button (verified meanwhile) was reopened");
  assert.doesNotThrow(() => restore(after, drafts, undefined), "no binder (module missing) must be a no-op");
});

check("after a successful Mark verified the panel is cleared before the re-render (not restored as a draft)", () => {
  const fn = cut("verifyCodeProfileFromKb");
  const put = fn.indexOf('api("/api/code-profiles/verify"');
  const clear = fn.indexOf('slot.innerHTML = ""');
  assert.ok(put > 0 && clear > put && clear < fn.indexOf("renderKnowledgeBase()"), "the verified panel is not cleared between the PUT and the re-render");
});

check("/review survives a missing code-profile-verify.js (guarded, not a module-scope crash)", () => {
  const sandboxReview: Record<string, unknown> = {
    window: {}, location: { hash: "", pathname: "/review", search: "" }, history: { replaceState: () => {} },
    localStorage: { getItem: () => "", setItem: () => {} },
    document: { getElementById: () => el(), querySelectorAll: () => [], querySelector: () => null },
    fetch: async () => ({ ok: true, json: async () => ({ workTypes: [], submissions: [], profiles: [] }) }),
  };
  function el(): Record<string, unknown> {
    return { addEventListener: () => {}, contains: () => false, after: () => {}, style: {}, value: "", textContent: "", innerHTML: "", disabled: false };
  }
  vm.createContext(sandboxReview);
  assert.doesNotThrow(() => vm.runInContext(review, sandboxReview), "review.js threw at load with window.CodeProfileVerify missing");
  assert.match(review, /const CPV = window\.CodeProfileVerify \|\| null;/);
  assert.match(review, /if \(!CPV\) \{ \$\("profiles"\)\.textContent = CPV_MISSING; return; \}/);
});

check("the /review#profile=<key> deep link is consumed once (a later loadProfiles does not reopen it)", () => {
  const lp = review.slice(review.indexOf("async function loadProfiles"), review.indexOf("// The summary, payload, name"));
  const consume = lp.indexOf("history.replaceState(null, \"\", location.pathname + location.search)");
  const click = lp.indexOf("?.click()");
  assert.ok(consume > 0 && consume < click, "the hash is not cleared before the panel opens");
});

console.log(failures === 0 ? "\ncodeProfileVerifyPanel: all checks passed." : `\ncodeProfileVerifyPanel: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
