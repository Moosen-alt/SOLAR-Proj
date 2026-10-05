// THE EDITION PROPOSALS PANEL (#172) — frontend/edition-proposals.js, loaded here through node:vm.
//
// GET /api/code-profiles attaches a human-verified row's pending proposals as `editionProposals`;
// this pins how the KB card shows them, on a synthetic profile: what changed per family (the row's
// edition → the proposed one, "(none on file)" for a family the row lacks), the cited source as a
// link only when it is http(s), the quoted sentence, the date the research found it and where it
// came from, Approve / Dismiss buttons carrying the fingerprint, what Approve means per kind, and
// every interpolated value escaped. A row with no proposals renders nothing.
//   npx tsx backend/test/editionProposalsPanel.test.ts
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { REPO } from "./_isolate";
import type { JurisdictionCodeProfile, JurisdictionEditionProposal } from "../../shared/src/types";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const src = fs.readFileSync(path.join(REPO, "frontend", "edition-proposals.js"), "utf8");
const sandbox: { window: Record<string, unknown> } = { window: {} };
vm.runInNewContext(src, sandbox, { filename: "edition-proposals.js" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EP = sandbox.window.EditionProposals as any;
assert.ok(EP, "edition-proposals.js did not register window.EditionProposals");

// Typed against the shared types, so a field renamed there breaks this fixture at typecheck.
const editions: JurisdictionEditionProposal = {
  profileKey: "zz|city of sample|unknown", state: "ZZ", ahj: "City of Sample", fingerprint: "zz|city of sample|unknown#1a2b3c",
  source: "research", createdAt: "2026-09-30T18:04:00.000Z",
  changes: [
    { family: "fire", current: "IFC 2018", proposed: "IFC 2024", sourceUrl: "https://codes.example.gov/fire", quote: "The 2024 IFC is adopted & in effect." },
    { family: "building", current: null, proposed: "IBC 2024", sourceUrl: "javascript:alert(1)" },
  ],
  proposedCodes: [{ code: "IFC", edition: "2024" }, { code: "IBC", edition: "2024" }],
};
const adoption: JurisdictionEditionProposal = {
  profileKey: "zz|unknown|unknown", state: "ZZ", ahj: "", kind: "adoption_model", fingerprint: "zz|unknown|unknown#9f9f",
  source: "reference", createdAt: "2026-08-01T00:00:00.000Z",
  changes: [{ family: "residential", current: "state_minimum", proposed: "uniform" }],
  proposedCodes: [],
};
const profile = (proposals: JurisdictionEditionProposal[] | undefined): JurisdictionCodeProfile => ({
  key: "zz|city of sample|unknown", state: "ZZ", ahj: "City of Sample", confidence: "verified", adoptedCodes: [], amendments: [],
  designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "", verifiedBy: "Pat Synthetic",
  ...(proposals ? { editionProposals: proposals } : {}),
});

const html: string = EP.renderEditionProposals(profile([editions]));

check("each change shows the row's edition → the proposed one", () => {
  assert.match(html, /<strong>fire<\/strong>: IFC 2018 → <strong>IFC 2024<\/strong>/);
});
check("a family the row lacks reads '(none on file)', never blank or 'null'", () => {
  assert.match(html, /<strong>building<\/strong>: \(none on file\) → <strong>IBC 2024<\/strong>/);
  assert.ok(!/null/.test(html), "a null current edition printed as 'null'");
});
check("the cited source is a link, opened safely", () => {
  assert.match(html, /<a href="https:\/\/codes\.example\.gov\/fire" target="_blank" rel="noopener noreferrer">cited source<\/a>/);
});
check("a non-http source is never a link (javascript: does not reach an href)", () => {
  assert.ok(!html.includes("javascript:"), "a javascript: URL reached the markup");
  assert.match(html, /<strong>building<\/strong>[^]*?\(no source cited\)/);
});
check("the quoted sentence prints (escaped)", () => {
  assert.ok(html.includes("The 2024 IFC is adopted &amp; in effect."), "quote missing or not escaped");
});
check("the researched date and where the finding came from", () => {
  assert.match(html, /researched 2026-09-30 from web research/);
  assert.match(EP.renderEditionProposals(profile([adoption])), /researched 2026-08-01 from shipped reference data/);
});
check("Approve and Dismiss carry the proposal's fingerprint", () => {
  assert.ok(html.includes(`data-edition-approve="${editions.fingerprint}"`), "no Approve button for the proposal");
  assert.ok(html.includes(`data-edition-dismiss="${editions.fingerprint}"`), "no Dismiss button for the proposal");
  assert.match(html, />Approve<\/button>/);
  assert.match(html, />Dismiss<\/button>/);
});
check("the card says what Approve does, per kind (re-verify vs adoption model only)", () => {
  assert.match(html, /Approve re-verifies this row with the proposed editions under your name\./);
  const a: string = EP.renderEditionProposals(profile([adoption]));
  assert.match(a, /Adoption model differs from research/);
  assert.match(a, /the row&#39;s editions are unchanged/);
  assert.match(a, /<strong>residential<\/strong>: state_minimum → <strong>uniform<\/strong>/);
});
check("several proposals each get their own block and the heading counts them", () => {
  const both: string = EP.renderEditionProposals(profile([editions, adoption]));
  assert.match(both, /Edition proposals awaiting a person \(2\)/);
  assert.equal((both.match(/data-edition-approve=/g) || []).length, 2);
});
check("every interpolated value is escaped", () => {
  const hostile: JurisdictionEditionProposal = {
    ...editions, fingerprint: 'x"><img src=x onerror=1>', createdAt: "<script>1</script>", source: "research",
    changes: [{ family: "fire", current: "<b>IFC</b>", proposed: '"><svg onload=1>', sourceUrl: 'https://e.example/"><img src=x>', quote: "</div><script>alert(1)</script>" }],
  };
  const h: string = EP.renderEditionProposals(profile([hostile]));
  assert.ok(!h.includes("<img"), "an <img> reached innerHTML raw");
  assert.ok(!h.includes("<svg"), "an <svg> reached innerHTML raw");
  assert.ok(!h.includes("<script>"), "a <script> reached innerHTML raw");
  assert.ok(!h.includes("<b>IFC</b>"), "the current edition reached innerHTML raw");
  assert.ok(h.includes("&lt;b&gt;IFC&lt;/b&gt;"));
  assert.ok(h.includes('data-edition-approve="x&quot;&gt;&lt;img src=x onerror=1&gt;"'), "the fingerprint attribute is not escaped");
});
check("no proposals (or no profile) renders nothing", () => {
  assert.equal(EP.renderEditionProposals(profile(undefined)), "");
  assert.equal(EP.renderEditionProposals(profile([])), "");
  assert.equal(EP.renderEditionProposals(null), "");
  assert.equal(EP.renderEditionProposals(profile([{ ...editions, fingerprint: "" }])), "", "a proposal with no id rendered buttons nothing can act on");
});

// ── #182: STATE-default rows (empty ahj) have no KB card — the "State code profiles" block ─────
const stateRow = (state: string, proposals: JurisdictionEditionProposal[] | undefined, ahj = ""): JurisdictionCodeProfile => ({
  ...profile(proposals), key: `${state.toLowerCase()}|${ahj.toLowerCase() || "unknown"}|unknown`, state, ahj,
});
const stateEditions: JurisdictionEditionProposal = { ...editions, profileKey: "zy|unknown|unknown", state: "ZY", ahj: "", fingerprint: "zy|unknown|unknown#5e5e" };
const stateBlock: string = EP.renderStateProposals([
  stateRow("ZZ", [adoption]),
  stateRow("ZY", [stateEditions]),
  stateRow("ZX", undefined),
  stateRow("ZZ", [editions], "City of Sample"),
]);

check("#182 a state row's edition proposal and every adoption_model proposal render, with Approve / Dismiss", () => {
  assert.match(stateBlock, /State code profiles \(2\)/);
  for (const fp of [stateEditions.fingerprint, adoption.fingerprint]) {
    assert.ok(stateBlock.includes(`data-edition-approve="${fp}"`), `no Approve for ${fp}`);
    assert.ok(stateBlock.includes(`data-edition-dismiss="${fp}"`), `no Dismiss for ${fp}`);
  }
  assert.match(stateBlock, /Adoption model differs from research/);
  assert.ok(stateBlock.indexOf(">ZY<") < stateBlock.indexOf(">ZZ<"), "state rows are not ordered by state");
});
check("#182 an AHJ row stays on its own KB card, never in the state block", () => {
  assert.ok(!stateBlock.includes(`data-edition-approve="${editions.fingerprint}"`), "an AHJ row's proposal landed in the state block");
});
check("#182 no state row with a proposal → the block renders nothing", () => {
  assert.equal(EP.renderStateProposals([stateRow("ZX", undefined), stateRow("ZZ", [editions], "City of Sample")]), "");
  assert.equal(EP.renderStateProposals([]), "");
  assert.equal(EP.renderStateProposals(undefined), "");
});
check("#182 the state block escapes the state and key it prints", () => {
  const h: string = EP.renderStateProposals([{ ...stateRow("ZY", [stateEditions]), state: "<img src=x>", key: '"><svg onload=1>' }]);
  assert.ok(!h.includes("<img") && !h.includes("<svg"), "a state or key reached innerHTML raw");
});

// The dashboard draws the block into #kbStateProposals and binds its buttons to the same
// decideEditionProposal the KB cards use — lifted from the shipped dashboard.js and run here.
const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (name: string): string => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find function ${name}`);
  let depth = 0, end = -1;
  for (let j = dashboard.indexOf("{", m.index); j < dashboard.length; j++) {
    if (dashboard[j] === "{") depth++;
    else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dashboard.slice(m.index, end);
};
check("#182 dashboard.js renders the state block into #kbStateProposals and wires Approve / Dismiss", () => {
  const decided: Array<[string, string]> = [];
  const buttons: Array<{ attr: string; value: string; click?: () => void }> = [];
  const el = {
    innerHTML: "",
    querySelectorAll(sel: string) {
      const attr = /\[([a-z-]+)\]/.exec(sel)![1];
      const re = new RegExp(`${attr}="([^"]*)"`, "g");
      return [...el.innerHTML.matchAll(re)].map((m) => {
        const b = { attr, value: m[1], getAttribute: (a: string) => (a === attr ? m[1] : null), addEventListener: (_e: string, fn: () => void) => { (b as { click?: () => void }).click = fn; } };
        buttons.push(b);
        return b;
      });
    },
  };
  const ctx: Record<string, unknown> = {
    window: sandbox.window,
    state: { codeProfiles: [stateRow("ZZ", [adoption]), stateRow("ZZ", [editions], "City of Sample")] },
    $: (id: string) => (id === "kbStateProposals" ? el : null),
    decideEditionProposal: (action: string, fp: string) => { decided.push([action, fp]); },
  };
  vm.createContext(ctx);
  vm.runInContext(["bindEditionProposalButtons", "renderStateCodeProposals"].map(cut).join("\n\n") + "\nrenderStateCodeProposals();", ctx);
  assert.match(el.innerHTML, /State code profiles \(1\)/);
  for (const b of buttons) b.click?.();
  assert.deepEqual(decided, [["approve", adoption.fingerprint], ["dismiss", adoption.fingerprint]]);
  assert.match(cut("renderKnowledgeBase"), /renderStateCodeProposals\(\);[^]*if \(!profiles\.length\)/, "the state block is not drawn before the no-profiles early return");
  const html = fs.readFileSync(path.join(REPO, "frontend", "dashboard.html"), "utf8");
  assert.match(html, /<div id="kbStateProposals"><\/div>/, "dashboard.html has no #kbStateProposals container");
});

console.log(failures === 0 ? "\neditionProposalsPanel: all checks passed." : `\neditionProposalsPanel: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
