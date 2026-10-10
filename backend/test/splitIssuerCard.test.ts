// THE PERMIT CARD SAYS WHO ISSUES IT, AND THE OPERATOR CAN NAME ANOTHER AGENCY THERE (split issuer).
//
// Runs the SHIPPED card renderer (trackCardHtml, with trackIssuerHtml and every helper it calls)
// lifted out of frontend/dashboard.js by a brace-balanced cut, plus the shipped saveTrackIssuer with
// its network call captured — no Chromium. The agency name, the operator's value, the refusal text
// and the cited page are untrusted text: esc() everything.
//
// KILLS (verified by hand, see the commit):
//   K1 trackCardHtml: drop `${trackIssuerHtml(t)}`                    → (a) fails.
//   K2 trackIssuerHtml: interpolate i.name without esc()               → (b) fails.
//   K3 saveTrackIssuer: post anything but { [snapshot key]: value } to
//      the project update route                                        → (d) fails.
//   K4 trackCardHtml: drop `${trackIssuerEditHtml(t)}` (no control)    → (a) fails.
//
//   npx tsx backend/test/splitIssuerCard.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";
import { check, finish } from "./_stageFixture";

const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
/** A top-level `function NAME(` or `const NAME =` declaration, cut at its balanced closing brace
 *  (or the end of its line, for a one-line const). */
const cut = (name: string): string => {
  const m = new RegExp(`^(?:async )?function ${name}\\(|^const ${name} = `, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${name}`);
  const brace = dashboard.indexOf("{", m.index);
  const eol = dashboard.indexOf("\n", m.index);
  // A const whose value is not an object literal is one line ("new Set()", an arrow returning a template).
  if (dashboard.slice(m.index, m.index + 6) === "const " && dashboard[m.index + m[0].length] !== "{") return dashboard.slice(m.index, eol);
  let depth = 0, end = -1;
  for (let j = brace; j < dashboard.length; j++) {
    if (dashboard[j] === "{") depth++;
    else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dashboard.slice(m.index, end);
};
const names = [
  "esc", "httpUrl", "linkifyText", "fmtDate", "humanize", "statusBadge",
  "TRACK_STATUS_CLASS", "TRACK_CHANNEL_BASIS", "OFF_TOOL_CHANNEL", "offToolChannelHtml", "trackChannelHtml",
  "trackPrerequisitesHtml", "ESS_STEP_BASIS", "trackEssStepHtml", "trackNextActionText", "screenshotMisses", "screenshotKey",
  "TRACK_ISSUER_KEY", "TRACK_ISSUER_SOURCE", "trackIssuerHtml", "trackIssuerEditHtml", "saveTrackIssuer", "trackCardHtml",
];
const bundle = names.map(cut).join("\n;\n");

type Calls = { api: Array<{ path: string; opts: { method?: string; body?: string } }>; loaded: number; rendered: number; messages: string[] };
function load() {
  const calls: Calls = { api: [], loaded: 0, rendered: 0, messages: [] };
  const state = { selectedProjectId: "proj-1", detail: null as unknown };
  const api = async (p: string, opts: { method?: string; body?: string } = {}) => { calls.api.push({ path: p, opts }); return { project: { id: "proj-1" } }; };
  const loadSubmittalTracks = async () => { calls.loaded++; };
  const renderDetail = () => { calls.rendered++; };
  const showMessage = (m: string) => { calls.messages.push(m); };
  const fns = new Function("state", "api", "loadSubmittalTracks", "renderDetail", "showMessage",
    `${bundle}\nreturn { trackCardHtml, trackIssuerHtml, saveTrackIssuer };`)(state, api, loadSubmittalTracks, renderDetail, showMessage) as {
    trackCardHtml: (t: Record<string, unknown>) => string;
    trackIssuerHtml: (t: Record<string, unknown>) => string;
    saveTrackIssuer: (type: string, value: string, btn: { disabled: boolean } | null) => Promise<void>;
  };
  return { ...fns, calls, state };
}

const card = (over: Record<string, unknown> = {}) => ({
  type: "building", label: "Building permit", category: "permit", channel: "Online portal", status: "not_started",
  statusLabel: "Not started", nextAction: "Stage in the portal", captureFields: [], hasRecipe: false,
  issuer: { name: "City of Fernhollow", source: "operator", override: "City of Fernhollow" },
  ...over,
});

await check("(a) the permit card says who issues it and where that came from, with the operator's control", () => {
  const { trackCardHtml } = load();
  const html = trackCardHtml(card());
  assert.match(html, /Issued by:<\/strong> City of Fernhollow/);
  assert.match(html, /set by an operator/);
  // The answer is on the card's FACE (before its first <details>); the control is folded away.
  const face = html.split("<details")[0];
  assert.match(face, /Issued by:<\/strong> City of Fernhollow/, "the issuer is not on the card's face");
  assert.doesNotMatch(face, /data-track-issuer-input/, "the control pushed the channel off the card's face");
  assert.ok(face.indexOf("Issued by") < face.indexOf("Channel:"), "the issuer is not read before the channel");
  assert.match(html, /data-track-issuer-input="building"[^>]*value="City of Fernhollow"/);
  assert.match(html, /data-track-issuer-save="building"/);
  assert.match(html, /data-track-issuer-clear="building"/, "an override on file has no Clear");
  const lookup = trackCardHtml(card({ issuer: { name: "Alder County", source: "lookup", override: "", sourceUrl: "https://alder.example.gov/permits" } }));
  assert.match(lookup, /per-job lookup, cited/);
  assert.match(lookup, /href="https:\/\/alder\.example\.gov\/permits"/);
  assert.doesNotMatch(lookup, /data-track-issuer-clear/, "Clear offered with nothing to clear");
  // MUST-EXCLUDE: the utility card names no issuer and offers no control.
  const nem = trackCardHtml(card({ type: "nem", category: "utility", issuer: undefined }));
  assert.doesNotMatch(nem, /Issued by|data-track-issuer/);
});

await check("(b) MUST-EXCLUDE: every interpolated value is escaped (name, operator value, refusal, cited page)", () => {
  const { trackCardHtml, trackIssuerHtml } = load();
  const evil = "<img src=x onerror=alert(1)>";
  const html = trackCardHtml(card({ issuer: { name: evil, source: "operator", override: `"><script>x</script>`, refused: evil } }));
  assert.doesNotMatch(html, /<img|<script/i, html);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /value="&quot;&gt;&lt;script&gt;/, "the operator's value is not escaped in the input");
  const link = trackIssuerHtml(card({ issuer: { name: "X", source: "lookup", override: "", sourceUrl: "javascript:alert(1)" } }));
  assert.doesNotMatch(link, /href="javascript/i);
});

await check("(c) the refusal is shown (an issuer in another state is never silently used)", () => {
  const { trackIssuerHtml } = load();
  const html = trackIssuerHtml(card({ issuer: { name: "Birchwood County", source: "project", override: "City of Fernhollow, WA", refused: "\"City of Fernhollow, WA\" was not used: it names an agency in WA" } }));
  assert.match(html, /Issued by:<\/strong> Birchwood County/);
  assert.match(html, /was not used: it names an agency in WA/);
});

await check("(d) Save and Clear post the track's snapshot key to the project update route, then reload the tracks", async () => {
  const { saveTrackIssuer, calls } = load();
  await saveTrackIssuer("building", "City of Fernhollow", { disabled: false });
  assert.equal(calls.api.length, 1);
  assert.equal(calls.api[0].path, "/api/projects/proj-1");
  assert.equal(calls.api[0].opts.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls.api[0].opts.body)), { trackIssuerBuilding: "City of Fernhollow" });
  assert.equal(calls.loaded, 1);
  assert.equal(calls.rendered, 1);
  await saveTrackIssuer("mpu", "", null);
  assert.deepEqual(JSON.parse(String(calls.api[1].opts.body)), { trackIssuerMpu: "" });
  await saveTrackIssuer("combo", "Alder County", null);
  assert.deepEqual(JSON.parse(String(calls.api[2].opts.body)), { trackIssuerCombo: "Alder County" });
  // MUST-EXCLUDE: a track with no issuer key (NEM) posts nothing.
  await saveTrackIssuer("nem", "Anything", null);
  assert.equal(calls.api.length, 3, "the NEM track wrote an issuer");
});

finish("split-issuer-card");
