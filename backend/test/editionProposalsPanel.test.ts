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

console.log(failures === 0 ? "\neditionProposalsPanel: all checks passed." : `\neditionProposalsPanel: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
