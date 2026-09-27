// LOOKUP ANSWERS REACH THE PAGE — the display half of new-AHJ e2e gap 4 (and gap 3's labels).
//
// Evidence (.probe/e2e-newahj, scorer result): found portals (Iowa City's EnerGov URL; Waltham's
// "no online portal, paper drop-off") never reached the tracks, which said "Unknown — verify";
// stored fee tiers (Eversource $0, FirstEnergy's Level 2 formula) resolved to a bare UNKNOWN on the
// fee sheet with the schedule one click away; every utility track was headed "Net Metering (NEM)",
// Oncor and SRP included.
//
// What the dashboard now draws (frontend/dashboard.js, the REAL functions lifted from the file):
//   fee card  — a number carries its schedule line + source link ON THE FACE; an UNKNOWN whose
//               schedule is on file says so, with the link and the reason, and is still UNKNOWN.
//   track card — every http(s) URL in the channel sentence is a link, the server's channelBasis is a
//               chip, a recorder pre-fill URL with no recipe is "a link on file, not verified",
//               prerequisite offices are a cited list, and the utility group is "interconnection".
//   MUST-PASS / MUST-EXCLUDE per case below; DASHBOARD_JS_PATH points a kill run at a mutated copy.
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = fs.readFileSync(process.env.DASHBOARD_JS_PATH || path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");

/** Lift a top-level `[async] function NAME(` or `const NAME = ` by bracket balance (boardGateTruth's lift). */
const lift = (name: string): string => {
  const re = new RegExp(`^(?:async )?function ${name}\\(|^const ${name} = `, "m");
  const m = re.exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${name}`);
  const isConst = m[0].startsWith("const");
  let i = isConst ? m.index + m[0].length : dashboard.indexOf("{", dashboard.indexOf(")", m.index));
  if (isConst && !"{[(".includes(dashboard[i])) { const semi = dashboard.indexOf(";\n", i); return dashboard.slice(m.index, semi + 1); }
  let depth = 0;
  for (; i < dashboard.length; i++) {
    const ch = dashboard[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  return dashboard.slice(m.index, i) + (isConst ? ";" : "");
};
const NAMES = [
  "esc", "humanize", "fmtDate", "statusBadge", "httpUrl", "portalHostname", "feeMoney",
  "FEE_SOURCE_TEXT", "FEE_CONFIDENCE", "FEE_PAYMENT_METHOD", "renderFeeCharges", "feeFaceSourceHtml", "renderFeeSheetLine",
  "TRACK_STATUS_CLASS", "TRACK_CHANNEL_BASIS", "linkifyText", "trackChannelHtml", "trackPrerequisitesHtml", "trackNextActionText",
  "trackCardHtml", "utilityGroupTitle", "renderSubmittalTracks",
];
const preamble = "const screenshotMisses = new Set(); const screenshotKey = (a, b, c) => `${a}:${b}:${c}`;";
const code = `${preamble}\n${NAMES.map(lift).join("\n\n")}`;
type Lib = Record<string, any>;
const load = (els: Record<string, any> = {}): Lib =>
  // eslint-disable-next-line no-new-func
  new Function("$", "state", "window", "markSubmittalTrack", "stageSubmittalTrack", "launchTrackRecorder", "api", "showMessage", "loadSubmittalTracks", "renderDetail",
    `${code}\nreturn { ${NAMES.join(", ")} };`)((id: string) => els[id] ?? null, { selectedProjectId: "p1" }, {}, () => {}, () => {}, () => {}, async () => ({}), () => {}, async () => {}, () => {});
const lib = load();
/** The part of a card an operator sees without opening anything: everything before the first <details>. */
const face = (html: string): string => html.split("<details")[0];
const words = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// ── FEE CARD ───────────────────────────────────────────────────────────────────────────────
const FE_URL = "https://www.firstenergycorp.com/content/dam/customer/get-help/files/interconnection-fees.pdf";
const unresolved = {
  track: "nem", jurisdiction: "Penelec (FirstEnergy)", feeUsd: null, source: "unknown", confidence: "unknown", paymentMethod: "unknown",
  basis: "No published interconnection fee schedule found for Penelec yet. A published schedule for FirstEnergy was found but did not resolve: Level 2 - $250.00 + $1.00 per kW needs the system size (kW), which the project does not carry yet.",
  bracketLabel: null, sourceUrl: FE_URL, charges: [],
};
{
  const html = lib.renderFeeSheetLine(unresolved);
  check("MUST-PASS: an unknown fee whose schedule is on file says so ON THE FACE, with the schedule linked",
    /Schedule on file — not resolved for this job/.test(face(html)) && face(html).includes(`<a href="${FE_URL}"`), words(face(html)).slice(0, 300));
  check("MUST-PASS: …and the reason (the tier it could not evaluate) is on the face too",
    /Why unknown:.*Level 2 - \$250\.00 \+ \$1\.00 per kW/.test(words(face(html))));
  check("MUST-EXCLUDE: …and it is still UNKNOWN — no amount is invented from the tier",
    /UNKNOWN/.test(words(face(html)).split("Why unknown")[0]) && !/\$250\.00<\/p>|>\$\d/.test(face(html).split("fee-face-source")[0]), words(face(html)).slice(0, 200));
  check("the track is named 'Utility interconnection', not 'NEM'", /Utility interconnection/.test(words(html)) && !/NEM \/ interconnection/.test(html));
}
{
  const html = lib.renderFeeSheetLine({ ...unresolved, sourceUrl: null, basis: "No published interconnection fee schedule found for Oncor yet." });
  check("MUST-EXCLUDE: an unknown with NO schedule on file makes no 'schedule on file' claim", !/Schedule on file/.test(html));
  check("…but its reason still reads on the face", /Why unknown: No published interconnection fee schedule found for Oncor/.test(words(face(html))));
}
{
  const html = lib.renderFeeSheetLine({ ...unresolved, sourceUrl: "javascript:alert(1)" });
  check("MUST-EXCLUDE: a javascript: source URL is never a link (and claims no schedule)", !/href="javascript/i.test(html) && !/Schedule on file/.test(html));
}
{
  const ONCOR = "https://www.oncor.com/content/dam/oncorwww/documents/doing-business/interconnection-fees.pdf";
  const html = lib.renderFeeSheetLine({
    track: "nem", jurisdiction: "Oncor", feeUsd: 0, source: "published_schedule", confidence: "seeded", paymentMethod: "none",
    basis: "Oncor's published fee schedule, line \"0 to 10 kW Pre-certified, not on network\" (researched, not yet human-verified).",
    bracketLabel: "0 to 10 kW Pre-certified, not on network", sourceUrl: ONCOR, charges: [],
  });
  check("MUST-PASS: a stored tier ($0) shows its line and its source link on the face, beside the number",
    /Source:.*0 to 10 kW Pre-certified, not on network.*the jurisdiction's published fee schedule/.test(words(face(html))) && face(html).includes(`<a href="${ONCOR}"`), words(face(html)).slice(0, 300));
  check("…the number is $0.00 and still marked provisional", /\$0\.00/.test(face(html)) && /provisional — not verified/.test(face(html)));
}
{
  const html = lib.renderFeeSheetLine({ track: "permit", jurisdiction: "City of Venus", feeUsd: 160, source: "actual", confidence: "actual", paymentMethod: "portal", basis: "Portal-calculated fee.", bracketLabel: null, sourceUrl: null, charges: [] });
  check("MUST-EXCLUDE: a fee with no URL draws no link, only its source in words", !/<a /.test(face(html)) && /Source: the portal's own fee screen/.test(words(face(html))));
}

for (const [source, confidence] of [["actual", "actual"], ["valuation_estimate", "estimated"], ["learned_history", "verified"]]) {
  const VENUS = "https://www.cityofvenus.org/fees.pdf";
  const html = lib.renderFeeSheetLine({ track: "permit", jurisdiction: "City of Venus", feeUsd: 160, source, confidence, paymentMethod: "portal", basis: "x", bracketLabel: "Solar Panel Permit (R)", sourceUrl: VENUS, charges: [] });
  const src = /Source:[^<]*/.exec(face(html))?.[0] ?? "";
  check(`MUST-EXCLUDE: a ${source} amount never names the schedule as its source (the link is drawn apart)`,
    !/Source:[^<]*·\s*<a /.test(face(html)) && !/Solar Panel Permit \(R\)/.test(src) && /Schedule on file: <a href="https:\/\/www\.cityofvenus\.org\/fees\.pdf"[^>]*>[^<]*<\/a> \(not the source of this number\)/.test(face(html)),
    face(html).slice(0, 400));
}

// ── TRACK CARD ─────────────────────────────────────────────────────────────────────────────
const IC = "https://egov.iowa-city.org/energovprod/selfservice";
const baseTrack = {
  type: "combo", label: "AHJ permit", category: "permit", status: "not_started", statusLabel: "Not started", nextAction: "Stage it.",
  captureFields: [], applicationNumber: "", permitNumber: "", confirmationNumber: "", trackingUrl: "", submittedAt: null, lastCheckedAt: null,
  outstanding: true, hasRecipe: false, recipeScopeType: "ahj",
};
{
  const html = lib.trackCardHtml({ ...baseTrack, channel: `Online portal: ${IC} — record type "Residential Electrical - Solar" (per-job lookup, cited: https://www.icgov.org/building).`, channelBasis: "cited", recipePortalUrl: IC });
  check("MUST-PASS: the found portal in the channel sentence is a clickable link", html.includes(`<a href="${IC}" target="_blank" rel="noopener noreferrer">egov.iowa-city.org/energovprod/selfservice</a>`), words(html).slice(0, 250));
  check("…the citation is a link too (trailing punctuation outside the href)", html.includes('<a href="https://www.icgov.org/building"'));
  check("…with the server's basis as a chip ('cited')", /<span class="badge badge-info">cited<\/span>/.test(html));
  check("MUST-EXCLUDE: the same URL is not repeated as a 'link on file'", !/Link on file/.test(html));
}
{
  const html = lib.trackCardHtml({ ...baseTrack, channel: "Unknown — verify on the AHJ site", channelBasis: "unknown", recipePortalUrl: "https://www.icgov.org/government/departments/neighborhood-and-development-services/building" });
  check("MUST-PASS: with no recipe, the KB/profile URL shows — as a link on file, NOT as the portal (rule 5)",
    /Link on file \(not verified as the application portal\)/.test(words(html)) && /href="https:\/\/www\.icgov\.org\/government/.test(html));
  check("…and an unknown channel says 'not found yet'", /not found yet/.test(html));
}
{
  const html = lib.trackCardHtml({ ...baseTrack, hasRecipe: true, recipeStatus: "complete", recipeId: "r1", channel: "EnerGov", recipePortalUrl: IC });
  check("MUST-EXCLUDE: a recorded recipe's own URL is not relabelled 'link on file'", !/Link on file/.test(html));
  check("MUST-EXCLUDE: an older server's track (no channelBasis) draws no basis chip", !/badge-(?:info|pass|warning)">(?:cited|verified by a person|profile — verify|researched — verify|not found yet)</.test(html));
}
{
  const html = lib.trackCardHtml({ ...baseTrack, channel: 'Portal <img src=x onerror=alert(1)> javascript:alert(1) "x"', channelBasis: "bogus" });
  check("MUST-EXCLUDE: channel text is escaped — no markup, no javascript: link", !/<img/.test(html) && !/href="javascript/i.test(html) && /&lt;img/.test(html));
}
{
  const html = lib.trackCardHtml({
    ...baseTrack,
    channel: "No online application portal found — applications are dropped off in person (per-job lookup; verify on the AHJ site)",
    channelBasis: "researched",
    prerequisites: [{ step: "Fire Prevention plan review before the building permit", sourceUrl: "https://www.city.waltham.ma.us/fire-prevention", quote: "ALL Plans need to go to Fire Prevention Prior to Building Department drop off" }],
    nextAction: "FIRST, at another office: (1) Fire Prevention plan review before the building permit [https://www.city.waltham.ma.us/fire-prevention]. THEN: Stage in the AHJ portal (not yet identified), submit manually, then record the number here.",
  });
  check("MUST-PASS: a prerequisite office is a cited list on the card",
    /Before this filing, at another office:.*Fire Prevention plan review before the building permit/.test(words(html)) && /href="https:\/\/www\.city\.waltham\.ma\.us\/fire-prevention"/.test(html));
  check("…and the next action is not a second copy of the same steps", /→ After those: Stage in the AHJ portal/.test(words(html)) && (words(html).match(/Fire Prevention plan review/g) || []).length === 1, words(html).slice(0, 400));
  check("…'no online portal, paper' reaches the card with its 'researched — verify' chip", /No online application portal found — applications are dropped off in person/.test(words(html)) && /researched — verify/.test(html));
}
{
  const led = lib.trackCardHtml({ ...baseTrack, channel: "x", structureBasis: "Permit structure: not confirmed — no cited agency page says one permit or two." });
  const bare = lib.trackCardHtml({ ...baseTrack, channel: "x", structureBasis: "one Residential Solar permit (cited: https://www.scottsdaleaz.gov/permits)." });
  check("the structure basis is shown once — never 'Permit structure: Permit structure:'",
    (words(led).match(/Permit structure:/g) || []).length === 1 && /Permit structure: one Residential Solar permit/.test(words(bare)) && /href="https:\/\/www\.scottsdaleaz\.gov\/permits"/.test(bare));
}
{
  const html = lib.trackCardHtml({ ...baseTrack, nextAction: "FIRST, at another office: (1) Zoning [https://x.gov]. THEN: Stage it." });
  check("MUST-EXCLUDE: without a prerequisites list the next action keeps its FIRST… wording", /FIRST, at another office/.test(words(html)));
}
{
  const els: Record<string, any> = { submittalTracks: { innerHTML: "", querySelectorAll: () => [] }, submittalTracksStatus: { textContent: "" } };
  const pageLib = load(els);
  pageLib.renderSubmittalTracks.call(null);
  check("SETUP: renderSubmittalTracks with no tracks draws the empty state", /No submittal tracks/.test(els.submittalTracks.innerHTML));
}
{
  const els: Record<string, any> = { submittalTracks: { innerHTML: "", querySelectorAll: () => [] }, submittalTracksStatus: { textContent: "" } };
  const fn = new Function("$", "state", "window", "markSubmittalTrack", "stageSubmittalTrack", "launchTrackRecorder", "api", "showMessage", "loadSubmittalTracks", "renderDetail",
    `${code}\nreturn renderSubmittalTracks;`)((id: string) => els[id] ?? null, { selectedProjectId: "p1", submittalTracks: [{ ...baseTrack, type: "nem", category: "utility", channel: "Oncor installer portal" }] }, {}, () => {}, () => {}, () => {}, async () => ({}), () => {}, async () => {}, () => {});
  fn();
  check("MUST-PASS: the utility group is headed 'Utility — interconnection'", /Utility — interconnection/.test(els.submittalTracks.innerHTML));
  check("MUST-EXCLUDE: …never 'Net Metering (NEM)' for every utility", !/Net Metering \(NEM\)/.test(els.submittalTracks.innerHTML));
}

if (failures) { console.error(`\nfeeTracksDisplay: ${failures} FAILED`); process.exit(1); }
console.log("\nfeeTracksDisplay: all checks passed");
process.exit(0);
