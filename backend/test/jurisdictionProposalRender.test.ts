// WHAT THE OPERATOR SEES OF WHAT A CORRECTION TAUGHT.
//
// Two dashboard renders, run as the SHIPPED functions lifted out of frontend/dashboard.js (same
// brace-balanced cut as submitSeam.test.ts — no Chromium):
//   1. The correction card's jurisdiction proposals (jurisdictionProposalsHtml): which AHJ, WHICH
//      PROFILE ROW the apply writes (exact key — or "applying creates <key>"), the different row a
//      name match would have picked (shown, never written), old -> new, the listing flag legibly.
//   2. The KB card (renderKnowledgeProfile): the AHJ's learned design criteria WITH PROVENANCE —
//      "AHJ plan-review correction" + date (never its id, record or sentence: the row is shared
//      across tenants) or the cited lookup it came from, seeded vs verified —
//      and "Approved designs used ..." from the aggregate. The AHJ's quoted sentence is NOT on the
//      shared card (it can carry a homeowner's address); every value is esc()'d.
//
//   npx tsx backend/test/jurisdictionProposalRender.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = fs.readFileSync(path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (kind: "function" | "const", name: string): string => {
  const re = kind === "function" ? new RegExp(`^function ${name}\\(`, "m") : new RegExp(`^const ${name} = `, "m");
  const m = re.exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${kind} ${name}`);
  let depth = 0, end = -1;
  for (let j = dashboard.indexOf("{", m.index); j < dashboard.length; j++) {
    if (dashboard[j] === "{") depth++;
    else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dashboard.slice(m.index, end) + (kind === "const" ? ";" : "");
};
const bundle = [
  cut("function", "esc"), cut("function", "humanize"), cut("function", "statusBadge"), cut("function", "kbConfidenceBadge"), cut("function", "kbNotesHtml"),
  cut("const", "JURISDICTION_CRITERION_LABELS"), cut("const", "JURISDICTION_STATUS_LABELS"), cut("function", "jurisdictionProposalsHtml"),
  cut("function", "codeProfileForKb"), cut("const", "KB_CRITERIA_LABELS"), cut("const", "KB_OBSERVED_LABELS"), cut("function", "kbDesignCriteriaHtml"),
  cut("function", "renderKnowledgeProfile"),
].join("\n\n");
type Fns = {
  jurisdictionProposalsHtml: (list: unknown[]) => string;
  renderKnowledgeProfile: (profile: Record<string, unknown>) => string;
};
const load = (state: Record<string, unknown>): Fns =>
  // eslint-disable-next-line no-new-func
  (new Function("state", `${bundle}\nreturn { jurisdictionProposalsHtml, renderKnowledgeProfile };`)(state) as Fns);

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ");

// ─── 1. the correction card ──────────────────────────────────────────────────────────────
const proposal = (over: Record<string, unknown>) => ({
  kind: "jurisdiction_design_criteria", id: "jurisdiction:windSpeedMph", ahj: "City of Lincoln City", state: "OR",
  profileKey: "", targetProfileKey: "or|city of lincoln city|unknown", block: "designCriteria", criterion: "windSpeedMph",
  value: 120, currentValue: null, currentConfidence: null, basis: "The minimum wind speed design is 120 MPH Ultimate Exposure D.",
  source: { correctionId: "c0ffee12-aaaa", recordNumber: "APP-1", receivedAt: "2026-09-20T00:00:00Z" }, status: "proposed", ...over,
});

check("the card names the AHJ and the row the apply will CREATE (exact key), and the fuzzy row it will NOT touch", () => {
  const html = load({}).jurisdictionProposalsHtml([proposal({ nearestOtherRow: { key: "or|lincoln county|unknown", ahj: "Lincoln County" } })]);
  const t = text(html);
  assert.match(t, /for City of Lincoln City \(OR\)'s code profile/);
  assert.match(t, /applying creates or\|city of lincoln city\|unknown/);
  assert.match(t, /Not Lincoln County \( ?or\|lincoln county\|unknown ?\), which a name match would pick — that row is not changed/);
  assert.match(t, /Design wind speed \(ultimate\)/);
  assert.match(t, /Blank → 120 mph|Blank\s+120 mph/);
});

check("an existing row is named by its key; the listing flag reads as words, not 'true'", () => {
  const html = load({}).jurisdictionProposalsHtml([proposal({
    profileKey: "or|city of coos bay|unknown", targetProfileKey: "or|city of coos bay|unknown", ahj: "City of Coos Bay",
    id: "jurisdiction:listingEvidenceRequired", block: "prescriptive", criterion: "listingEvidenceRequired", value: true,
  })]);
  const t = text(html);
  assert.match(t, /Writes profile row or\|city of coos bay\|unknown/);
  assert.match(t, /Module \/ racking UL listing evidence required/);
  assert.match(t, /Yes/);
  assert.doesNotMatch(t, /\btrue\b/);
});

check("MUST EXCLUDE: a proposal blocked by a VERIFIED row never reads 'Writes profile row' (nothing is written)", () => {
  const t = text(load({}).jurisdictionProposalsHtml([proposal({
    ahj: "City of Portland", profileKey: "or|portland|unknown", targetProfileKey: "or|portland|unknown", currentConfidence: "verified",
    status: "blocked_verified", statusNote: "Reviews for City of Portland read the human-verified profile \"Portland\" (or|portland|unknown).",
  })]));
  assert.doesNotMatch(t, /Writes profile row|applying creates/);
  assert.match(t, /Nothing is written: profile row or|portland|unknown is human-verified/);
  assert.match(t, /Profile verified — not changed/);
  // Control: the same row, proposable, still reads "Writes".
  assert.match(text(load({}).jurisdictionProposalsHtml([proposal({ profileKey: "tx|plano|unknown", targetProfileKey: "tx|plano|unknown", state: "TX", ahj: "City of Plano" })])), /Writes profile row tx|plano|unknown/);
});

check("every proposal value is esc()'d (the basis is the AHJ's own sentence)", () => {
  const html = load({}).jurisdictionProposalsHtml([proposal({ ahj: "<img src=x onerror=alert(1)>", basis: "<script>x</script>", nearestOtherRow: { key: "<b>", ahj: "<i>" } })]);
  assert.doesNotMatch(html, /<img|<script|<b>|<i>/);
});

// ─── 2. the KB card ──────────────────────────────────────────────────────────────────────
const kb = { state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", confidence: "seeded", projectCount: 5, correctionCount: 1, requiredDocuments: [], commonCorrections: [], sources: [] };
const codeProfile = {
  key: "or|city of coos bay|unknown", state: "OR", ahj: "City of Coos Bay", confidence: "seeded",
  adoptedCodes: [], amendments: [], fireSetbacks: [], updatedAt: "",
  designCriteria: { groundSnowLoadPsf: 36, windSpeedMph: 120 },
  prescriptive: { maxAttachmentSpacingIn: 24, listingEvidenceRequired: true },
  citations: [
    // A row written before the shared citation was narrowed can still carry these: the card must not show them.
    { label: "AHJ correction", sourceUrl: "", kind: "ahj_correction", field: "designCriteria.groundSnowLoadPsf", quote: "Ground snow load 36 psf at 12 Homeowner Lane", correctionId: "c0ffee12-1234-5678", recordNumber: "187-26-000309-STR", at: "2026-09-20T10:00:00Z" } as Record<string, unknown>,
    { label: "lookup", sourceUrl: "https://coosbay.example.gov/design", kind: "design_criteria_research", field: "designCriteria.windSpeedMph", at: "2026-09-21T10:00:00Z" },
  ],
  approvedDesignSummary: [{ criterion: "groundSnowPsf", value: 25, count: 2, lastIssuedAt: "2026-08-30" }],
};

check("the KB card shows each learned criterion WITH its provenance, seeded vs verified, and approved designs", () => {
  const html = load({ codeProfiles: [codeProfile] }).renderKnowledgeProfile(kb);
  const t = text(html);
  assert.match(t, /Code profile design criteria/);
  assert.match(t, /Seeded — verify locally/);
  assert.match(t, /Ground snow load: 36 psf — AHJ plan-review correction, 2026-09-20/);
  assert.doesNotMatch(t, /c0ffee12|187-26-000309-STR/, "a correction id / record number reached the shared KB card");
  assert.match(t, /Design wind speed \(ultimate\): 120 mph — design-criteria lookup, 2026-09-21 \(https:\/\/coosbay\.example\.gov\/design\)/);
  assert.match(t, /Max attachment spacing: 24 in o\.c\. — seeded research \/ import/);
  assert.match(t, /Module \/ racking UL listing evidence required: Yes/);
  assert.match(t, /Approved designs used: ground snow 25 psf \(2 issued permits, latest 2026-08-30\) — corroboration, not the jurisdiction's rule/);
});

check("the AHJ's quoted sentence (which can carry an address) is NOT on the shared KB card", () => {
  const html = load({ codeProfiles: [codeProfile] }).renderKnowledgeProfile(kb);
  assert.doesNotMatch(html, /Homeowner Lane/);
});

check("a VERIFIED row reads verified; a different city's profile is never shown on this card", () => {
  const verified = { ...codeProfile, confidence: "verified", verifiedBy: "ops@example.test", citations: [] };
  const t = text(load({ codeProfiles: [verified] }).renderKnowledgeProfile(kb));
  assert.match(t, /Verified by ops@example\.test/);
  assert.match(t, /Ground snow load: 36 psf — entered at verification/);
  const other = { ...codeProfile, ahj: "Coos County" };
  assert.doesNotMatch(load({ codeProfiles: [other] }).renderKnowledgeProfile(kb), /Code profile design criteria/);
  assert.doesNotMatch(load({ codeProfiles: [] }).renderKnowledgeProfile(kb), /Code profile design criteria/);
});

check("KB card values are esc()'d", () => {
  const evil = { ...codeProfile, verifiedBy: "<script>", confidence: "verified", designCriteria: { windExposure: "<img src=x>" }, prescriptive: {}, citations: [], approvedDesignSummary: [{ criterion: "windExposure", value: "<b>", count: 1, lastIssuedAt: "" }] };
  const html = load({ codeProfiles: [evil] }).renderKnowledgeProfile(kb);
  assert.doesNotMatch(html, /<script>|<img src=x>|<b>/);
});

console.log(failures === 0 ? "\njurisdictionProposalRender: all checks passed" : `\njurisdictionProposalRender: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
