// THE CORRECTION CARD LEADS WITH THE CORRECTION.
//
// Operator, 2026-09-27, on a Coos Bay record: "it does have corrections so we pulled that right.
// However it's a bit cluttered". The card titled itself with the bucket enum title-cased ("A We
// Fix") and printed the correction's text raw — the whole scraped Accela page, 3,712 characters.
//
// Run as the SHIPPED function lifted out of frontend/dashboard.js (the brace-balanced cut of
// jurisdictionProposalRender.test.ts — no Chromium): correctionCardHtml(correction, triage,
// projectStatus). Checks:
//   - the correction itself is shown, short, under a plain-words bucket label;
//   - required action, root cause, triage and the draft reply follow it;
//   - the page it was read from is inside a CLOSED <details> "Portal record text (as read)" and
//     nowhere else — long text never renders inline;
//   - a page nothing was extracted from says so;
//   - every value is esc()'d (an injected tag in every field reaches the HTML only escaped).
//
//   npx tsx backend/test/correctionCardRender.test.ts
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
  if (kind === "const" && !/^const \w+ = [{[]/.test(dashboard.slice(m.index, m.index + 200))) {
    return dashboard.slice(m.index, dashboard.indexOf(";", m.index) + 1);
  }
  let depth = 0, end = -1;
  for (let j = dashboard.indexOf("{", m.index); j < dashboard.length; j++) {
    if (dashboard[j] === "{") depth++;
    else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dashboard.slice(m.index, end) + (kind === "const" ? ";" : "");
};
const bundle = [
  cut("function", "esc"), cut("function", "humanize"), cut("function", "fmtDate"), cut("function", "correctionSlaBadge"),
  cut("const", "JURISDICTION_CRITERION_LABELS"), cut("const", "JURISDICTION_STATUS_LABELS"), cut("function", "jurisdictionProposalsHtml"),
  cut("function", "correctionTriageHtml"), cut("const", "CORRECTION_LEAD_CHARS"), cut("function", "correctionCardHtml"),
].join("\n\n");
type Card = (correction: Record<string, unknown>, triage: Record<string, unknown> | null, projectStatus: string) => string;
// eslint-disable-next-line no-new-func
const correctionCardHtml = (new Function(`${bundle}\nreturn correctionCardHtml;`)() as Card);

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const CONDITION = "PERMIT OUTSTANDING - Severity: Notice - Outstanding permit 187-M16-901 expired prior to final. Applied | Notice | 12/13/2019";
const PAGE = "Record 187-26-000901-STR: Residential Structural Record Status: In Review/Addl Info Needed "
  + "Condition: PERMIT OUTSTANDINGSeverity: Notice ... Documents Upload/View ... To upload files, you will need to install "
  + "Silverlight. Click the image below to start Silverlight download. Loading... Valuation Calculator ".repeat(20);
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "c-1", projectId: "p-1", source: "portal",
  correctionText: CONDITION, sourceText: PAGE, extraction: "items",
  correctionBucket: "A_we_fix", bucketLabel: "We fix - operator",
  rootCause: "Not a design or plan-set deficiency; a parcel-level condition from an older permit.",
  requiredAction: "Operator to contact the city to confirm whether the notice is a hard hold.",
  assignedTo: "autopilot_operator", draftResponse: "Thank you for the review. We understand the only open item is ...",
  humanApproved: false, resubmitted: false, newRuleRecommended: false,
  createdAt: "2026-09-27T19:20:16.345Z", closedAt: null, dueAt: "2026-10-04", slaDays: 7, daysOpen: 0, isOverdue: false,
  ...over,
});
const TRIAGE = {
  itemStatus: "pending", proposals: [], jurisdictionProposals: [], projectApplied: false,
  actions: ["Call the building division about the expired permit.", "Tell the homeowner what closes it."],
};

/** The HTML with every <details>…</details> block removed — what is visible without a click. */
const inline = (html: string): string => html.replace(/<details[\s\S]*?<\/details>/g, "");
const detailsBlocks = (html: string): string[] => html.match(/<details[\s\S]*?<\/details>/g) ?? [];

const card = correctionCardHtml(base(), TRIAGE, "correction_triaged");

check("THE LEAD IS THE CORRECTION: the condition is shown, before the required action", () => {
  const visible = inline(card);
  assert.ok(visible.includes(CONDITION), "the extracted condition is not on the card");
  assert.ok(visible.indexOf(CONDITION) < visible.indexOf("Operator to contact the city"), "the correction does not lead");
});

check("THEN required action, root cause, the checklist and the draft reply", () => {
  const order = ["Operator to contact the city", "Not a design or plan-set deficiency", "Call the building division", "Thank you for the review"]
    .map((s) => card.indexOf(s));
  assert.ok(order.every((i) => i >= 0), `missing: ${JSON.stringify(order)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, `out of order: ${JSON.stringify(order)}`);
});

check("THE PAGE IS EVIDENCE: inside a CLOSED <details> 'Portal record text (as read)', never inline", () => {
  const record = detailsBlocks(card).find((d) => d.includes("Portal record text (as read)"));
  assert.ok(record, "no 'Portal record text (as read)' details element");
  assert.ok(!/<details[^>]*\bopen\b/.test(record!), "the record text renders expanded");
  assert.ok(record!.includes("Silverlight"), "the page text is not inside the details element");
  assert.ok(!inline(card).includes("Silverlight"), "page chrome renders inline on the card");
  assert.ok(inline(card).length < 4000, `the visible card is ${inline(card).length} characters`);
});

check("PLAIN LABEL: the header reads the bucket in words", () => {
  assert.ok(card.includes("We fix - operator"));
  assert.ok(!card.includes("A We Fix"), "the enum is still title-cased onto the card");
});

check("NOTHING EXTRACTED: the card says the whole page stands, shows its start, and keeps the rest collapsed", () => {
  const fell = correctionCardHtml(base({ correctionText: PAGE, extraction: "whole_text" }), null, "correction_triaged");
  assert.match(inline(fell), /No condition or review-comment block was found/);
  assert.ok(inline(fell).length < 2500, `the fallback card shows ${inline(fell).length} characters inline`);
  assert.ok(detailsBlocks(fell).some((d) => d.includes("Portal record text (as read)") && d.includes("Silverlight")));
});

check("AN OLD ROW (stored before extraction, long text, no source): clipped inline, whole text collapsed", () => {
  const old = correctionCardHtml(base({ correctionText: PAGE, sourceText: "", extraction: "not_extracted" }), null, "submitted");
  assert.ok(!inline(old).includes(PAGE), "the long stored text renders inline in full");
  assert.ok(detailsBlocks(old).some((d) => d.includes(PAGE.slice(0, 60))), "the stored text is not kept behind a details element");
});

check("A TYPED CORRECTION shows as written, with no record-text element", () => {
  const typed = correctionCardHtml(base({ source: "manual", correctionText: "Provide stamped calcs.", sourceText: "", extraction: "not_extracted" }), null, "correction_triaged");
  assert.ok(inline(typed).includes("Provide stamped calcs."));
  assert.ok(!typed.includes("Portal record text"), "a typed correction offers a portal record it never had");
});

check("ESCAPED: an injected tag in every field reaches the HTML only as text", () => {
  const evil = "<x-evil onerror=1>";
  const html = correctionCardHtml(base({
    id: evil, correctionText: `${CONDITION}\n${evil}`, sourceText: `${PAGE}${evil}`, bucketLabel: evil, rootCause: evil,
    requiredAction: evil, draftResponse: evil, dueAt: evil,
  }), { ...TRIAGE, actions: [evil] }, "waiting_on_designer");
  assert.ok(!html.includes("<x-evil"), "a raw tag reached innerHTML");
  assert.ok(html.includes("&lt;x-evil"), "the injected value vanished instead of being escaped");
});

if (failures) { console.error(`\n${failures} correction card render check(s) FAILED.`); process.exit(1); }
console.log("\nAll correction card render checks passed.");
