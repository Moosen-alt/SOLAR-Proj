const state = {
  projects: [],
  // The whole board (unfiltered) for the "Needs me" counts; null when it could not be loaded.
  boardAll: null,
  selectedProjectId: null,
  detail: null,
  // The server's full next-step answer for the open project (GET /api/projects/:id/next-step,
  // refreshed by every autopilot state), and which project it belongs to.
  nextStep: null,
  nextStepProjectId: null,
  // THE GATE'S ANSWER PER BOARD CARD. The project list carries the list-tier answer, which never
  // runs the submit gate (gateChecked:false); a card must not say "Ready to stage" on it. Each such
  // card's FULL answer (GET /api/projects/:id/next-step — the same rule table WITH the gate) is
  // fetched a few at a time and kept here: pid -> { step, stamp, at } or { failedAt, stamp }.
  // `stamp` ties it to the list row it was fetched for (updatedAt + list key), so a changed
  // project is re-asked. See hydrateBoardGates.
  gateAnswers: {},
  // The newest autopilot state (canStage / canApprove and their reasons).
  autopilot: null,
  workflow: null,
  applicationDocs: null,
  filledForms: null,
  reviewerReport: null,
  historicalReport: null,
  opsPlan: null,
  opsBrief: null,
  handoffPacket: null,
  communicationDrafts: null,
  runbook: null,
  opsActions: null,
  opsReport: null,
  liveReadiness: null,
  projectTimeline: null,
  processMap: null,
  installerPacket: null,
  submitGate: null,
  // GET /api/projects/:id/permit-checks/stale — which of this project's STORED permit readings
  // today's classifier rules would call something else, and the exact re-check that fixes each
  // one. Null while unloaded; `{ checked:false }` means the drift pass itself failed, which is
  // NOT the same as "nothing is stale" (see renderPermitMonitor).
  staleReadings: null,
  // Which filing the next pasted status belongs to, set when the operator clicks "Paste a fresh
  // status" on a stale row. Cleared on project switch and after every recorded check — a stale
  // target id would file the next paste against the wrong permit.
  recheckTargetId: null,
  // "<projectId>|<targetId>" the permit form's fields were last filled from (syncPermitForm);
  // recordPermitStatus posts the form's numbers only with THAT filing's check.
  permitFormFor: null,
  // Per-project manual stage open/close overrides so the operator can pin a stage
  // (e.g. Submit) open and have it persist across re-renders and navigation.
  stageOverrides: {},
  stageActiveSeen: {},
  // Which project the status-override panel is currently holding an unsent edit for.
  // Lets a background re-render keep a half-typed reason, and a project switch drop it.
  statusOverrideFor: null,
  knowledgeProfiles: [],
  ahjForms: [],
  signatures: [],
  emailTracker: null,
  projectView: (typeof localStorage !== "undefined" && localStorage.getItem("projectView")) || "board",
};

const $ = (id) => document.getElementById(id);

// Pipeline stages (display labels for the board columns + table pill). The
// canonical stage mapping lives in backend/src/projectStage.ts; rows arrive
// carrying stageKey/stageIndex/stageLabel/stageCount, so this is display-only.
//
// FIVE stages, not six. "Intake" was removed as a pipeline stage (operator
// ruling, 2026-09-19): upload and parse happen together in the parser, so a
// project is BORN `parsed` — an Intake column could only ever render as
// already-complete, which is a stage that says nothing. Parsing is how a
// project comes into existence; the pipeline starts at the first thing an
// operator actually does to it. The Project Documents panel that used to live
// in the Intake accordion now opens inside QC / Verify.
const PROJECT_STAGES = [
  { key: "qc", label: "1 · QC / Verify" },
  { key: "build", label: "2 · Build & Validate" },
  { key: "submit", label: "3 · Submit" },
  { key: "track", label: "4 · Track Approvals" },
  { key: "closeout", label: "5 · Closeout" },
];

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed: ${res.status}`);
    err.details = data.details || {};
    throw err;
  }
  return data;
}

function showMessage(message, kind = "info") {
  const el = $("message");
  el.hidden = false;
  el.textContent = message;
  el.style.borderLeftColor = kind === "error" ? "var(--danger)" : kind === "warning" ? "var(--warning)" : "var(--info)";
}

function clearMessage() {
  $("message").hidden = true;
  $("message").textContent = "";
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/* ===========================================================================
   PROJECT-DETAIL RHYTHM — the marketing site's own section signature.
   ---------------------------------------------------------------------------
   The detail screen read as one undifferentiated wall of cards. The site it is
   supposed to look like has a very specific rhythm: a tiny uppercase GREEN
   eyebrow label, a confident sentence-case heading ending in a period, hairline
   borders, generous whitespace — and, for the checks/blockers surface, an
   explicit mock it already draws ("AHJ PREFLIGHT / City of Example": a left
   column of green ticks, a right red POTENTIAL ISSUE panel, a green
   Recommended action box). These classes build exactly that.

   WHY THIS LIVES IN JS AND NOT styles.css:
   styles.css is owned by another stream this phase. Every rule below is wrapped
   in :where(), which makes its specificity ZERO — so the moment styles.css
   defines any of these class names (specificity 0,1,0) it wins the cascade
   outright and this block silently stops mattering. It is a fallback, not a
   competing palette: it declares no literal colours, only canonical tokens
   (--primary, --success, --destructive, --border, --card, --space-*, --text-*)
   that already invert correctly for the dark theme. The four --kx-tint- and
   --kx-edge- values are derived with color-mix from those same tokens because
   the existing --tint- / --edge- families are defined for DARK ONLY and would
   resolve to nothing in light mode.

   Elements carrying these classes are deliberately <div>/<span>: styles.css has
   bare-element rules for p/h1-h3 (0,0,1) which would out-weigh a :where() rule.
   =========================================================================== */
const KEELIX_DETAIL_STYLE_ID = "keelixDetailStyles";
const KEELIX_DETAIL_CSS = `
:where(:root) {
  /* Prefer the stylesheet's OWN semantic families (they are theme-aware and
     defined for both light and dark); derive an equivalent only if a rewrite
     ever leaves one undefined, so nothing here can resolve to nothing. */
  --kx-tint-pass: var(--tint-pass, color-mix(in oklab, var(--success) 11%, var(--card)));
  --kx-edge-pass: var(--edge-pass, color-mix(in oklab, var(--success) 38%, var(--border)));
  --kx-ink-pass:  var(--ink-pass,  var(--success));
  --kx-tint-fail: var(--tint-fail, color-mix(in oklab, var(--destructive) 8%, var(--card)));
  --kx-edge-fail: var(--edge-fail, color-mix(in oklab, var(--destructive) 34%, var(--border)));
  --kx-ink-fail:  var(--ink-fail,  var(--destructive));
  --kx-tint-warn: var(--tint-warn, color-mix(in oklab, var(--warning) 11%, var(--card)));
  --kx-edge-warn: var(--edge-warn, color-mix(in oklab, var(--warning) 38%, var(--border)));
  --kx-ink-warn:  var(--ink-warn,  var(--warning));
  --kx-band-fill: color-mix(in oklab, var(--secondary) 65%, var(--card));
  --kx-radius: 5.2px;
}

/* --- 1. Eyebrow label + section heading ---------------------------------- */
:where(.kx-band) { margin: 0 0 var(--space-5); }
:where(.kx-band:last-child) { margin-bottom: 0; }
:where(.kx-eyebrow) {
  display: block;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--primary);
  margin: 0 0 var(--space-2);
}
:where(.kx-eyebrow.is-muted) { color: var(--muted-foreground); }
:where(.kx-band-title) {
  display: block;
  font-size: var(--text-lg);
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -.01em;
  color: var(--foreground);
  margin: 0 0 var(--space-2);
}
:where(.kx-band-lede) {
  display: block;
  font-size: var(--text-sm);
  color: var(--muted-foreground);
  line-height: 1.6;
  margin: 0 0 var(--space-4);
  max-width: 68ch;
}
:where(.kx-band-head) { margin: 0 0 var(--space-4); }
:where(.kx-band-head .kx-band-lede) { margin-bottom: 0; }

/* --- 2. The AHJ PREFLIGHT card (the site draws this exact card) ----------- */
:where(.kx-preflight) {
  border: 1px solid var(--border);
  border-radius: var(--kx-radius);
  background: var(--card);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  margin: 0 0 var(--space-4);
}
:where(.kx-preflight-head) {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
}
:where(.kx-preflight-eyebrow) {
  display: block;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}
:where(.kx-preflight-subject) {
  display: block;
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--foreground);
  margin-top: 2px;
  overflow-wrap: anywhere;
}
:where(.kx-preflight-tag) {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--secondary);
  color: var(--muted-foreground);
  white-space: nowrap;
}
:where(.kx-preflight-body) { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); }
:where(.kx-preflight-col) { padding: var(--space-4); min-width: 0; }
:where(.kx-preflight-col + .kx-preflight-col) { border-left: 1px solid var(--border); }
@media (max-width: 900px) {
  :where(.kx-preflight-body) { grid-template-columns: minmax(0, 1fr); }
  :where(.kx-preflight-col + .kx-preflight-col) { border-left: 0; border-top: 1px solid var(--border); }
}
:where(.kx-preflight-coltitle) {
  display: block;
  font-size: var(--text-sm);
  font-weight: 700;
  color: var(--foreground);
  margin: 0 0 var(--space-3);
}
:where(.kx-preflight-foot) {
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border);
  background: var(--kx-band-fill);
  font-size: var(--text-xs);
  color: var(--muted-foreground);
  line-height: 1.55;
}

/* Left column: the green-tick "Project checks" list. */
:where(.kx-check) {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
  font-size: var(--text-sm);
  line-height: 1.55;
  color: var(--foreground);
  padding: 3px 0;
}
:where(.kx-check-mark) { flex: 0 0 14px; width: 14px; font-weight: 700; color: var(--kx-ink-pass); }
:where(.kx-check.is-warn .kx-check-mark) { color: var(--kx-ink-warn); }
:where(.kx-check.is-idle .kx-check-mark) { color: var(--muted-foreground); }
:where(.kx-check-text) { min-width: 0; overflow-wrap: anywhere; }
:where(.kx-check-note) { display: block; font-size: var(--text-xs); color: var(--muted-foreground); }
:where(.kx-check-empty) { font-size: var(--text-sm); color: var(--muted-foreground); line-height: 1.55; }

/* Right column: the red POTENTIAL ISSUE panel + green Recommended action box. */
:where(.kx-issue + .kx-issue) { margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--border); }
:where(.kx-issue-label) {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--kx-ink-fail);
  margin: 0 0 var(--space-2);
}
:where(.kx-issue.is-warn .kx-issue-label) { color: var(--kx-ink-warn); }
:where(.kx-issue-title) {
  display: block;
  font-size: var(--text-base);
  font-weight: 600;
  line-height: 1.3;
  color: var(--foreground);
  margin: 0 0 var(--space-3);
  overflow-wrap: anywhere;
}
:where(.kx-issue-field) { margin: 0 0 var(--space-3); }
:where(.kx-issue-field-label) { display: block; font-size: var(--text-xs); font-weight: 700; color: var(--foreground); margin-bottom: 2px; }
:where(.kx-issue-field-value) { display: block; font-size: var(--text-sm); color: var(--muted-foreground); line-height: 1.55; overflow-wrap: anywhere; }
:where(.kx-action) {
  background: var(--kx-tint-pass);
  border: 1px solid var(--kx-edge-pass);
  border-radius: var(--kx-radius);
  padding: var(--space-3);
}
:where(.kx-action-label) { display: block; font-size: var(--text-xs); font-weight: 700; color: var(--primary-strong); margin-bottom: 3px; }
:where(.kx-action-text) { display: block; font-size: var(--text-sm); color: var(--foreground); line-height: 1.55; overflow-wrap: anywhere; }
:where(.kx-issue-more) { margin-top: var(--space-3); font-size: var(--text-xs); color: var(--muted-foreground); }

/* The evidence trail + code anchors that live one fold down inside an issue.
   These three class names were emitted by dashboard.js and styled NOWHERE, so
   they rendered as unformatted run-on text. Same zero-specificity fallback. */
:where(.evidence-trail) { margin-top: var(--space-2); font-size: var(--text-sm); }
:where(.evidence-card) {
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--kx-radius);
  background: var(--kx-band-fill);
  line-height: 1.55;
}
:where(.evidence-card.pass) { border-color: var(--kx-edge-pass); background: var(--kx-tint-pass); border-left: 3px solid var(--kx-ink-pass); }
:where(.evidence-card.warning) { border-color: var(--kx-edge-warn); background: var(--kx-tint-warn); border-left: 3px solid var(--kx-ink-warn); }
:where(.evidence-card.screenshot-slot) { border-style: dashed; }
:where(.code-refs) { margin-top: var(--space-2); font-size: var(--text-xs); line-height: 1.6; }

/* --- 3. Three-state document-inventory verdict --------------------------- */
:where(.kx-docstate) {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: var(--kx-radius);
  padding: var(--space-3) var(--space-4);
  background: var(--card);
}
:where(.kx-docstate.is-clear) { background: var(--kx-tint-pass); border-color: var(--kx-edge-pass); border-left-color: var(--kx-ink-pass); }
:where(.kx-docstate.is-missing) { background: var(--kx-tint-fail); border-color: var(--kx-edge-fail); border-left-color: var(--kx-ink-fail); }
:where(.kx-docstate.is-unknown) { background: var(--kx-tint-warn); border-color: var(--kx-edge-warn); border-left-color: var(--kx-ink-warn); }
:where(.kx-docstate-icon) { flex: 0 0 auto; font-size: 14px; line-height: 1.5; }
:where(.kx-docstate-body) { min-width: 0; }
:where(.kx-docstate-title) { display: block; font-size: var(--text-sm); font-weight: 700; color: var(--foreground); margin-bottom: 3px; }
:where(.kx-docstate-text) { display: block; font-size: var(--text-sm); color: var(--foreground); line-height: 1.6; }
:where(.kx-docstate-list) { margin: var(--space-2) 0 0; padding-left: 18px; font-size: var(--text-sm); line-height: 1.7; color: var(--foreground); }
:where(.kx-docstate-why) { color: var(--muted-foreground); }
:where(.kx-docstate-reason) {
  display: block;
  margin-top: var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}

/* --- 4. Numbered steps ("01 / 02 / 03" + an uppercase label) ------------- */
:where(.kx-steps) { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); border-top: 1px solid var(--border); }
:where(.kx-step) { padding: var(--space-4) var(--space-4) var(--space-4) 0; border-right: 1px solid var(--border); }
:where(.kx-step:last-child) { border-right: 0; }
:where(.kx-step + .kx-step) { padding-left: var(--space-4); }
:where(.kx-step-num) { display: block; font-size: var(--text-xs); font-weight: 700; letter-spacing: .08em; color: var(--muted-foreground); }
:where(.kx-step-label) { display: block; font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--foreground); margin: var(--space-3) 0 var(--space-2); }
:where(.kx-step-body) { display: block; font-size: var(--text-sm); color: var(--muted-foreground); line-height: 1.6; }
:where(.kx-step-link) { color: inherit; font-weight: 700; text-decoration: underline; cursor: pointer; }

/* --- 5. Inline split widget (was literal #fef9ee / #f59e0b) -------------- */
:where(.kx-inline-tool) {
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--kx-tint-warn);
  border: 1px solid var(--kx-edge-warn);
  border-radius: var(--kx-radius);
}
:where(.kx-inline-tool-title) { display: block; font-size: var(--text-sm); font-weight: 700; color: var(--foreground); }
:where(.kx-inline-tool-row) { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; margin-top: var(--space-2); }
:where(.kx-inline-tool-row select) {
  font: inherit;
  font-size: var(--text-sm);
  padding: 5px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--foreground);
}
:where(.kx-inline-tool-status) { font-size: var(--text-xs); color: var(--muted-foreground); }

/* --- 6. Fee / payment callout panels (were literal #f59e0b borders) ------ */
:where(.kx-callout-panel) {
  margin: var(--space-3) 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--kx-radius);
}
/* These sections also carry .panel, whose own border rule is a real class
   selector — so the attention state keeps ONE class outside :where() to tie it
   and win on order. Anything the stylesheet writes for .kx-callout-panel.is-warn
   is two classes and still beats this. */
:where(.kx-callout-panel).is-warn { border-color: var(--kx-edge-warn); }
`;

// Idempotent: the rules are appended once, after the linked stylesheet, and only
// ever act as a zero-specificity fallback (see the block comment above).
function ensureKeelixDetailStyles() {
  if (typeof document === "undefined" || !document.head) return;
  if (document.getElementById(KEELIX_DETAIL_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = KEELIX_DETAIL_STYLE_ID;
  style.textContent = KEELIX_DETAIL_CSS;
  document.head.appendChild(style);
}

// "1 document", "2 documents" — the headings on this screen are written as real
// sentences, and "(s)" is the tell that nobody read them out loud.
function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : (pluralForm || `${singular}s`)}`;
}

// An eyebrow label + sentence-case heading ending in a period, which is the
// site's section signature. Both halves are escaped: AHJ and homeowner strings
// reach these headings straight off parsed PDFs and portal scrapes.
function bandHead(eyebrow, title, lede) {
  return `<div class="kx-band-head">
    <span class="kx-eyebrow">${esc(eyebrow)}</span>
    ${title ? `<span class="kx-band-title">${esc(title)}</span>` : ""}
    ${lede ? `<span class="kx-band-lede">${esc(lede)}</span>` : ""}
  </div>`;
}

// Null-safe "snake_case" → "snake case". Avoids the whole class of
// `someStatus.replaceAll(...)` throwing when a status field is null/undefined.
// Safe date formatting — a null/empty/malformed timestamp must never render the
// literal "Invalid Date" to the operator.
function fmtDate(value, dateOnly = false) {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return dateOnly ? d.toLocaleDateString() : d.toLocaleString();
}

function humanize(value) {
  if (value == null) return "";
  // Title-case each word, replacing underscores/hyphens with spaces.
  return String(value).replaceAll("_", " ").replaceAll("-", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusBadge(status) {
  // The classifier's stored approval labels (backend/src/permitMonitor.ts). "Reviewed by AHJ" is
  // deliberately NOT here: plan review done is not the permit — it stays the plain badge. Declared
  // INSIDE the function: four tests lift statusBadge by itself out of this file.
  const APPROVAL_LABELS = new Set([
    "Approved with conditions",
    "NEM / interconnection approved",
    "Interconnection approved with conditions",
    "NEM approved",
  ]);
  // Count badges: color by zero vs non-zero so callers can pass a plain number.
  if (typeof status === "number") {
    const cls = status > 0 ? "badge-warning" : "badge-pass";
    return `<span class="badge ${cls}">${status}</span>`;
  }
  const label = humanize(status ?? "unknown");
  if (status === "handoff_ready") return `<span class="badge badge-pass">${esc(label)}</span>`;
  // The monitor's own approval labels (permitMonitor.ts), as the lane cells and track rows pass
  // them: an approval — with or without conditions — is a pass, not a plain grey badge.
  if (APPROVAL_LABELS.has(String(status))) return `<span class="badge badge-pass">${esc(label)}</span>`;
  if (status === "approved" || status === "edited" || status === "nem_approved") return `<span class="badge badge-pass">${esc(label)}</span>`;
  if (status === "issued" || status === "ready_for_issue") return `<span class="badge badge-info">${esc(label)}</span>`;
  if (status === "correction_received" || status === "correction_triaged" || status === "pending") return `<span class="badge badge-warning">${esc(label)}</span>`;
  if (status === "blocked" || status === "rejected" || status === "failed") return `<span class="badge badge-fail">${esc(label)}</span>`;
  return `<span class="badge">${esc(label)}</span>`;
}

function projectLaneStatusCell(label, outcome, checkedAt, ready, readyLabel) {
  const display = ready ? readyLabel : label || (outcome ? outcome.replaceAll("_", " ") : "not checked");
  const dateText = checkedAt ? esc(new Date(checkedAt).toLocaleDateString()) : "";
  return `${statusBadge(display)}<br><span class="muted">${dateText}</span>`;
}

async function checkHealth() {
  const el = $("serviceStatus");
  try {
    const health = await api("/health");
    // Which code is answering (backend/src/buildInfo.ts): "2026.09.24 · 0c466bb · pinned".
    // Optional — an older server or a stub /health has no build block, and that must not
    // flip the status to "unreachable". Rendered INSIDE the status element so the existing
    // narrow-screen rule that hides the status hides the label with it.
    const buildLabel = health && health.build && typeof health.build.label === "string" ? health.build.label : "";
    el.innerHTML = buildLabel
      ? `Connected <span class="build-label" style="font-weight:400;color:var(--muted);white-space:nowrap">· ${esc(buildLabel)}</span>`
      : "Connected";
    el.title = buildLabel ? `Running build ${buildLabel}` : "";
    el.className = "conn-status conn-status--ok";
  } catch {
    el.title = "";
    el.textContent = "Backend unreachable";
    el.className = "conn-status conn-status--down";
  }
}

// The Daily Report and Action Queue panels are hidden for solo operation (dashboard.html keeps
// their DOM so renders never error), so their two endpoints are no longer fetched on every
// board load and refresh. loadOpsReport/loadOpsActions stay defined; restore the calls here
// when the panels are un-hidden.
async function loadProjects() {
  await fetchProjectPage(false);
  await loadKnowledgeBase();
  await loadPortalRecipes();
  await loadAhjForms();
  await loadSignatures();
  await loadEmailTracker();
  const selectedStillExists = state.projects.some((project) => project.id === state.selectedProjectId);
  // Don't auto-open a project on load — the landing page is the Dashboard board.
  // Only refresh the open project's detail when the operator is actually on its
  // workflow page (so a background list refresh doesn't yank them off Dashboard).
  if (state.selectedProjectId && selectedStillExists && state.page === "project") {
    await selectProject(state.selectedProjectId);
  } else if (!selectedStillExists) {
    state.selectedProjectId = null;
    state.detail = null;
    state.opsPlan = null;
    state.opsBrief = null;
    state.handoffPacket = null;
    state.communicationDrafts = null;
    state.runbook = null;
    state.liveReadiness = null;
    state.projectTimeline = null;
    state.processMap = null;
    state.installerPacket = null;
    state.submitGate = null;
    $("detailView").hidden = true;
    $("emptyState").hidden = false;
  }
}

async function refreshProjectListOnly() {
  await fetchProjectPage(false);
  await loadKnowledgeBase();
  await loadEmailTracker();
}

async function loadOpsReport() {
  try {
    state.opsReport = await api("/api/ops-report");
    renderOpsReport();
  } catch (err) {
    $("opsReportStatus").textContent = "error";
    $("opsReport").innerHTML = `<p class="muted">${esc(err.message || "Daily report unavailable.")}</p>`;
  }
}

async function loadOpsActions() {
  try {
    state.opsActions = await api("/api/ops-actions");
    renderOpsActions();
  } catch (err) {
    $("opsActionsStatus").textContent = "error";
    $("opsActions").innerHTML = `<p class="muted">${esc(err.message || "Action Queue unavailable.")}</p>`;
  }
}

async function loadKnowledgeBase() {
  // Guarded so a KB fetch error can't abort the rest of loadProjects() (portal
  // recipes, AHJ forms, signatures, email tracker, detail refresh).
  try {
    const data = await api("/api/knowledge-base");
    state.knowledgeProfiles = data.profiles || [];
    // The jurisdictions' code profiles, for the design criteria each KB card shows. Optional: a
    // failure (or no review entitlement) leaves the cards as they were.
    try { state.codeProfiles = (await api("/api/code-profiles")).profiles || []; } catch { state.codeProfiles = []; }
    $("knowledgeCount").textContent = state.knowledgeProfiles.length;
    renderKnowledgeBase();
  } catch (err) {
    const countEl = $("knowledgeCount");
    if (countEl) countEl.textContent = "—";
    const kbEl = $("knowledgeBase");
    if (kbEl) kbEl.innerHTML = `<p class="muted">${esc(err.message || "Knowledge base unavailable.")}</p>`;
  }
}

async function loadProjectDocuments() {
  const listEl = $("projectDocsList");
  if (!listEl || !state.selectedProjectId) return;
  try {
    const data = await api(`/api/projects/${state.selectedProjectId}/documents`);
    const docs = data.documents || [];
    const cnt = $("projectDocsCount"); if (cnt) cnt.textContent = `${docs.length} file${docs.length === 1 ? "" : "s"}`;
    listEl.innerHTML = docs.length
      ? docs.map((d) => `<div class="card" style="padding:6px 8px;display:flex;justify-content:space-between;align-items:center;gap:8px">
          <span style="font-size:13px"><strong>${esc(d.docType || "general")}</strong> · <a href="/api/projects/${esc(state.selectedProjectId)}/documents/${esc(d.id)}">${esc(d.originalFilename)}</a> <span class="muted">(${Math.max(1, Math.round(d.sizeBytes / 1024))} KB)</span></span>
          <button type="button" class="danger-button danger-button-sm" data-doc-del="${esc(d.id)}">Delete</button></div>`).join("")
      : '<p class="muted" style="font-size:12px">No documents uploaded yet.</p>';
    listEl.querySelectorAll("[data-doc-del]").forEach((b) => b.addEventListener("click", async () => {
      // Permanently removes the FILE from disk (only the append-only backup mirror
      // keeps a copy) — one accidental click on a plan set must not be silent.
      if (!window.confirm("Permanently delete this document file from the project?\n\nThe live file is removed from disk; only the backup mirror retains a copy.")) return;
      try {
        await api(`/api/projects/${state.selectedProjectId}/documents/${b.getAttribute("data-doc-del")}`, { method: "DELETE" });
        await loadProjectDocuments();
        // Removing a document can re-raise a submit blocker — refresh the banner.
        if (state.selectedProjectId) await selectProject(state.selectedProjectId);
      }
      catch (err) { $("docUploadStatus").textContent = err.message || "Delete failed."; }
    }));
  } catch (err) {
    listEl.innerHTML = `<p class="muted">${esc(err.message || "Could not load documents.")}</p>`;
  }
}

async function uploadProjectDocument() {
  const fileInput = $("docUploadFile");
  const files = Array.from(fileInput?.files || []);
  if (!state.selectedProjectId) { $("docUploadStatus").textContent = "Select a project first."; return; }
  if (!files.length) { $("docUploadStatus").textContent = "Choose one or more files."; return; }
  const docType = $("docUploadType").value;
  const status = $("docUploadStatus");
  let done = 0;
  const failed = [];
  // Upload each selected file in sequence so several checklist docs go up in one action.
  for (const file of files) {
    if (status) status.textContent = `Uploading ${file.name} (${done + 1}/${files.length})…`;
    try {
      const res = await fetch(`/api/projects/${state.selectedProjectId}/documents?filename=${encodeURIComponent(file.name)}&docType=${encodeURIComponent(docType)}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `${res.status}`); }
      done += 1;
    } catch (err) {
      failed.push(`${file.name}: ${err.message || "failed"}`);
    }
  }
  if (status) {
    status.textContent = failed.length
      ? `Uploaded ${done}/${files.length}. Failed: ${failed.join("; ")}`
      : `Uploaded ${done} file(s).`;
  }
  fileInput.value = "";
  await loadProjectDocuments();
  // A document upload can clear a submit blocker (e.g. the sealed structural
  // letter) — re-pull the full detail so the blocker banner updates NOW, not on
  // the next unrelated click.
  if (state.selectedProjectId) await selectProject(state.selectedProjectId);
}

async function loadPortalRecipes() {
  try {
    const data = await api("/api/portal-recipes");
    state.portalRecipes = data.recipes || [];
    renderPortalRecipes();
  } catch (err) {
    const el = $("portalRecipes");
    if (el) el.innerHTML = `<p class="muted">${esc(err.message || "Could not load recipes.")}</p>`;
  }
}

// Human-readable target of a recorded step: the richest selector handle available.
function recipeStepTarget(sel) {
  if (!sel) return "";
  return sel.name || sel.label || sel.placeholder || sel.text || sel.css || sel.testId || (sel.role ? `role=${sel.role}` : "");
}

// Read-back of one recorded step: what it does, where, and with which data — the
// verification surface an operator needs before trusting a recipe for replay.
function recipeStepRowHtml(r, step, i) {
  const isFinal = step.isFinalSubmit === true;
  const marker = step.action === "stopForReview"
    ? '<span style="font-size:11px;padding:1px 6px;border-radius:4px;background:var(--info);color:#fff">STOP — human reviews &amp; submits</span>'
    : isFinal
      ? '<span style="font-size:11px;padding:1px 6px;border-radius:4px;background:var(--danger);color:#fff" title="Clicked by a person, or by the bot only on a run a named person approved (Approve &amp; auto-submit) with PORTAL_ALLOW_FINAL_SUBMIT=1 on the server. Never pays fees.">FINAL SUBMIT — a person, or the bot on a run you approved</span>'
      : "";
  const data = step.sensitive
    ? `<em class="muted">sensitive — ${step.field ? `bound to project field <code>${esc(step.field)}</code>` : "no value stored"}</em>`
    : step.field
      ? `→ project field <code>${esc(step.field)}</code>`
      : step.value != null && step.value !== ""
        ? `= “${esc(String(step.value))}”`
        : "";
  const upload = step.action === "upload"
    ? `<label style="font-size:11px;display:inline-flex;gap:4px;align-items:center">doc type:
        <input data-recipe-doctype data-recipe-id="${esc(r.id)}" data-step-index="${i}" value="${esc(step.docType || "")}" placeholder="e.g. sld, site_plan" style="width:110px;padding:2px 5px;font-size:11px" />
      </label>${step.docType ? "" : ' <span style="color:var(--danger);font-size:11px">required — upload is skipped at replay until set</span>'}`
    : "";
  return `<li style="margin:2px 0;font-size:12px">
    <code>${esc(step.action)}</code>
    ${recipeStepTarget(step.selector) ? `<span class="muted">on</span> ${esc(recipeStepTarget(step.selector))}` : ""}
    ${data} ${upload} ${marker}
    ${step.note ? `<div class="muted" style="font-size:11px;margin-left:12px">${esc(step.note)}</div>` : ""}
  </li>`;
}

// KEEP-AND-FLAG, VISIBLE (operator ruling 2026-09-24, trust skeptic M4): a replay failure nobody
// could attribute keeps the recipe replayable and raises flagReason for a human. A flag nobody
// can see is no flag — so the recipe row says why, and a person clears it once they have looked
// at the run (POST /api/portal-recipes/:id/clear-flag, audited with who cleared it).
function recipeFlagHtml(r) {
  const reason = String(r.flagReason || "").trim();
  if (!reason) return "";
  return `<div class="recipe-flag" data-recipe-flag="${esc(r.id)}" style="margin-top:6px;padding:6px 8px;border-left:3px solid var(--warning);background:var(--surface-2);font-size:12px;display:flex;gap:8px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap">
      <div><strong>Flagged for review</strong>${r.flaggedAt ? ` <span class="muted">(${esc(String(r.flaggedAt).slice(0, 10))})</span>` : ""}: ${esc(reason)}</div>
      <button class="secondary" data-recipe-clear-flag="${esc(r.id)}" style="font-size:11px">Clear flag</button>
    </div>`;
}

function renderPortalRecipes() {
  const el = $("portalRecipes");
  if (!el) return;
  const recipes = state.portalRecipes || [];
  const countEl = $("recipesSummaryCount");
  if (countEl) countEl.textContent = recipes.length ? `${recipes.length} recorded` : "none yet";
  if (!recipes.length) { el.innerHTML = '<p class="muted">No portal recipes yet. Record one from a project&rsquo;s Submit stage.</p>'; return; }
  const badge = (status) => {
    const map = { complete: "var(--success)", recording: "var(--warning)", needs_rerecord: "var(--danger)" };
    return `<span style="font-size:11px;padding:1px 6px;border-radius:4px;background:${map[status] || "var(--info)"};color:#fff">${esc(humanize(status))}</span>`;
  };
  state.expandedRecipeSteps = state.expandedRecipeSteps || {};
  const stepsBlock = (r) => {
    if (!state.expandedRecipeSteps[r.id]) return "";
    if (!r.steps.length) return '<p class="muted" style="font-size:12px;margin:6px 0 0">No steps captured yet.</p>';
    const hasUploads = r.steps.some((s) => s.action === "upload");
    return `<div data-recipe-steps="${esc(r.id)}" style="margin-top:6px;border-top:1px solid var(--line);padding-top:6px">
      <ol style="margin:0;padding-left:18px">${r.steps.map((s, i) => recipeStepRowHtml(r, s, i)).join("")}</ol>
      ${hasUploads ? `<button class="secondary" data-recipe-save-doctypes="${esc(r.id)}" style="font-size:11px;margin-top:6px">Save doc types</button>` : ""}
    </div>`;
  };
  el.innerHTML = recipes.map((r) => `
    <div class="card" id="recipeCard-${esc(r.id)}" style="padding:8px 10px;margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <div>
          <strong>${esc(r.scopeType === "utility" ? (r.utility || r.ahj || r.profileKey) : (r.ahj || r.utility || r.profileKey))}</strong>
          <span class="muted" style="font-size:12px">· ${esc(r.scopeType)} · ${esc(r.portalPlatform || "portal")} · ${r.steps.length} step(s) · v${r.version}</span>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${badge(r.status)}
          <button class="secondary" data-recipe-toggle-steps="${esc(r.id)}" style="font-size:11px">${state.expandedRecipeSteps[r.id] ? "Hide steps" : "View steps"}</button>
          <button class="secondary" data-recipe-rerecord="${esc(r.id)}" style="font-size:11px">Flag re-record</button>
          <button type="button" class="danger-button danger-button-sm" data-recipe-delete="${esc(r.id)}">Delete</button>
        </div>
      </div>
      ${r.status === "complete"
        // NO PER-RECIPE ARM (operator rulings 2026-09-24 / 2026-09-26): portal_recipes.auto_submit_enabled
        // is never consulted and PUT .../auto-submit refuses to arm (409), so a "trust this portal"
        // checkbox here could only fail. The row names the gate that exists instead.
        ? `<div class="recipe-trust" data-recipe-submit-gate="${esc(r.id)}" style="cursor:default">Final submit: only on a run a named person approves (Approve &amp; auto-submit on the filing), with PORTAL_ALLOW_FINAL_SUBMIT=1 on the server and this recipe recorded through the submit — otherwise it stages to review. Never pays fees; stops for CAPTCHA/MFA.</div>`
        : '<div class="muted" style="font-size:11px;margin-top:4px">Not replayable until a complete recording is saved.</div>'}
      ${recipeFlagHtml(r)}
      ${stepsBlock(r)}
    </div>`).join("");
  el.querySelectorAll("[data-recipe-toggle-steps]").forEach((b) => b.addEventListener("click", () => {
    const id = b.getAttribute("data-recipe-toggle-steps");
    state.expandedRecipeSteps[id] = !state.expandedRecipeSteps[id];
    renderPortalRecipes();
  }));
  el.querySelectorAll("[data-recipe-save-doctypes]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.getAttribute("data-recipe-save-doctypes");
    b.disabled = true;
    try {
      // Fetch fresh, patch ONLY upload docTypes by index, save with status unchanged —
      // never promote/demote a recording from this editor.
      const fresh = await api(`/api/portal-recipes/${id}`);
      el.querySelectorAll(`[data-recipe-doctype][data-recipe-id="${id}"]`).forEach((input) => {
        const idx = Number(input.getAttribute("data-step-index"));
        if (fresh.steps[idx] && fresh.steps[idx].action === "upload") fresh.steps[idx].docType = input.value.trim();
      });
      await api(`/api/portal-recipes/${id}/steps`, { method: "PUT", body: JSON.stringify({ steps: fresh.steps, status: fresh.status }) });
      showMessage("Doc types saved — uploads will replay with the matching project documents.", "info");
      await loadPortalRecipes();
    } catch (err) {
      showMessage(err.message || "Could not save doc types.", "error");
      b.disabled = false;
    }
  }));
  el.querySelectorAll("[data-recipe-delete]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this portal recipe? The bot will fall back to manual until it is re-recorded.")) return;
    try { await api(`/api/portal-recipes/${b.getAttribute("data-recipe-delete")}`, { method: "DELETE" }); await loadPortalRecipes(); }
    catch (err) { showMessage(err.message || "Delete failed.", "error"); }
  }));
  el.querySelectorAll("[data-recipe-rerecord]").forEach((b) => b.addEventListener("click", async () => {
    try { await api(`/api/portal-recipes/${b.getAttribute("data-recipe-rerecord")}/rerecord`, { method: "POST" }); await loadPortalRecipes(); }
    catch (err) { showMessage(err.message || "Failed.", "error"); }
  }));
  el.querySelectorAll("[data-recipe-clear-flag]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.getAttribute("data-recipe-clear-flag");
    if (!confirm("Clear this flag?\n\nOnly after you have looked at the run it names. The recipe stays replayable; if it is broken, use \"Flag re-record\" instead.")) return;
    b.disabled = true;
    try {
      await api(`/api/portal-recipes/${encodeURIComponent(id)}/clear-flag`, { method: "POST", body: JSON.stringify({}) });
      showMessage("Flag cleared.", "info");
      await loadPortalRecipes();
    } catch (err) {
      showMessage(err.message || "Could not clear the flag.", "error");
      b.disabled = false;
    }
  }));
}

async function loadAhjForms() {
  const el = $("ahjFormsList");
  if (!el) return;
  try {
    const rows = await api("/api/ahj-templates");
    state.ahjForms = Array.isArray(rows) ? rows : [];
    renderAhjForms();
  } catch (err) {
    el.innerHTML = `<p class="muted">${esc(err.message || "Could not load AHJ forms.")}</p>`;
  }
}

function renderAhjForms() {
  const el = $("ahjFormsList");
  if (!el) return;
  const rows = state.ahjForms || [];
  const countEl = $("ahjFormsSummaryCount");
  if (countEl) countEl.textContent = rows.length ? `${rows.length} stored` : "none yet";
  if (!rows.length) { el.innerHTML = '<p class="muted">No AHJ forms stored yet. Use a project\'s "Find official form (AI)" button, or upload one above.</p>'; return; }
  el.innerHTML = rows.map((r) => {
    const map = r.fieldMap || {};
    const fillMode = map.fillMode || "acroform";
    const acroCount = Object.keys(map.textFields || {}).length + Object.keys(map.checkboxes || {}).length;
    const overlayCount = (map.overlayFields || []).length;
    const mapped = fillMode === "overlay" ? overlayCount : acroCount;
    const fillable = mapped > 0;
    // Where this blank came from and what it says about itself. A stored form is
    // a DATED artifact: Coos County's electrical application says "Revised
    // 12/23/2022" and prints a fee table 1.70x below the county's adopted
    // schedule. The staleness verdict is the server's (provenance.stale) — no
    // date parsing happens here, so the API and the page cannot disagree.
    const prov = r.provenance || {};
    const provBits = [];
    if (prov.documentDate) {
      provBits.push(`<span class="muted" style="font-size:11px">Document says: <strong>${esc(prov.documentDate)}</strong></span>`);
    } else {
      provBits.push('<span class="muted" style="font-size:11px">Document states no revision date</span>');
    }
    if (prov.stale) {
      provBits.push(`<span style="font-size:11px;padding:1px 6px;border-radius:4px;background:var(--warning);color:#fff">re-check — over 2 years old${prov.feeTableFound ? " and carries a fee table" : ""}</span>`);
    }
    if (prov.sourceUrl) {
      provBits.push(`<a href="${esc(prov.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="muted" style="font-size:11px">source</a>`);
    } else {
      provBits.push('<span class="muted" style="font-size:11px">no source link (uploaded)</span>');
    }
    if (prov.retrievedAt) provBits.push(`<span class="muted" style="font-size:11px">pulled ${esc(String(prov.retrievedAt).slice(0, 10))}</span>`);
    return `
    <div class="card" style="padding:8px 10px;margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <div>
          <strong>${esc(r.ahj_name)}</strong>
          <span class="muted" style="font-size:12px">· ${esc(r.state || "—")} · ${esc(r.form_type || "permit_application")} · ${esc(fillMode)} · ${mapped} field(s) mapped</span>
          ${fillable ? "" : '<span style="font-size:11px;padding:1px 6px;border-radius:4px;background:var(--warning);color:#fff;margin-left:6px">manual</span>'}
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <a class="secondary" href="/api/ahj-templates/${esc(r.id)}/pdf" target="_blank" rel="noopener" style="font-size:11px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;text-decoration:none">Blank PDF</a>
          <button class="secondary" data-form-remap="${esc(r.id)}" style="font-size:11px">Re-map</button>
          <button type="button" class="danger-button danger-button-sm" data-form-delete="${esc(r.id)}">Delete</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px">${provBits.join('<span class="muted" style="font-size:11px">·</span>')}</div>
      ${map.notes ? `<div class="muted" style="font-size:11px;margin-top:4px">${esc(map.notes)}</div>` : ""}
    </div>`;
  }).join("");
  el.querySelectorAll("[data-form-delete]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this stored AHJ form? Projects under this AHJ will fall back to manual until it's re-added.")) return;
    try { await api(`/api/ahj-templates/${b.getAttribute("data-form-delete")}`, { method: "DELETE" }); await loadAhjForms(); }
    catch (err) { showMessage(err.message || "Delete failed.", "error"); }
  }));
  el.querySelectorAll("[data-form-remap]").forEach((b) => b.addEventListener("click", async () => {
    const priorLabel = b.textContent;
    b.disabled = true; b.textContent = "Re-mapping…";
    const status = $("ahjFormsStatus");
    if (status) status.textContent = "Re-mapping from the stored blank…";
    try {
      const out = await api(`/api/ahj-templates/${b.getAttribute("data-form-remap")}/remap`, { method: "POST", body: "{}" });
      if (status) status.textContent = out.message || "Re-mapped.";
      await loadAhjForms();
    } catch (err) { if (status) status.textContent = ""; showMessage(err.message || "Re-map failed.", "error"); }
    finally { b.disabled = false; b.textContent = priorLabel; }
  }));
  if (window.lucide) window.lucide.createIcons();
}

async function uploadAhjFormFromManager(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const ahj = ($("addFormAhj")?.value || "").trim();
  const statev = ($("addFormState")?.value || "").trim();
  const status = $("ahjFormsStatus");
  if (!ahj) { showMessage("Enter the AHJ name before uploading.", "warning"); ev.target.value = ""; return; }
  if (status) status.textContent = `Uploading ${file.name} and mapping its fields…`;
  try {
    const buf = await file.arrayBuffer();
    const qs = new URLSearchParams({ ahj, state: statev, filename: file.name });
    const res = await fetch(`/api/ahj-templates/upload?${qs.toString()}`, {
      method: "POST", headers: { "Content-Type": "application/pdf" }, body: buf,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
    const out = await res.json();
    if (status) status.textContent = out.message || "Stored.";
    await loadAhjForms();
  } catch (err) { if (status) status.textContent = ""; showMessage(err.message || "Upload failed.", "error"); }
  finally { ev.target.value = ""; }
}

async function refreshAhjFormLinks() {
  const status = $("ahjFormsStatus");
  if (status) status.textContent = "Re-checking every form's source link…";
  try {
    const out = await api("/api/ahj-templates/refresh", { method: "POST", body: "{}" });
    if (status) status.textContent = `Checked ${out.checked}, updated ${out.updated}, broken ${out.brokenLinks}, unchanged ${out.unchanged}.`;
    await loadAhjForms();
  } catch (err) { if (status) status.textContent = ""; showMessage(err.message || "Refresh failed.", "error"); }
}

async function loadSignatures() {
  const el = $("signaturesList");
  if (!el) return;
  try {
    const data = await api("/api/signatures");
    state.signatures = data.signatures || [];
    renderSignatures();
  } catch (err) {
    el.innerHTML = `<p class="muted">${esc(err.message || "Could not load signatures.")}</p>`;
  }
}

function renderSignatures() {
  const el = $("signaturesList");
  if (!el) return;
  const rows = state.signatures || [];
  const countEl = $("signaturesSummaryCount");
  if (countEl) countEl.textContent = rows.length ? `${rows.length} stored` : "none yet";
  if (!rows.length) { el.innerHTML = '<p class="muted">No signatures stored. Add one above — it\'s placed on the applicant line by default.</p>'; return; }
  el.innerHTML = rows.map((r) => `
    <div class="card" style="padding:8px 10px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:10px">
        <img src="/api/signatures/${esc(r.id)}/image" alt="${esc(r.name)}" style="height:34px;max-width:160px;background:#fff;border:1px solid var(--line);border-radius:4px;padding:2px" />
        <div>
          <strong>${esc(r.name || r.role)}</strong>
          <span class="muted" style="font-size:12px">· ${esc(r.role)}${r.isDefault ? " · default" : ""}${esc(signatureCompanyNote(r))}</span>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        ${r.isDefault ? "" : `<button class="secondary" data-sig-default="${esc(r.id)}" style="font-size:11px">Make default</button>`}
        <button type="button" class="danger-button danger-button-sm" data-sig-delete="${esc(r.id)}">Delete</button>
      </div>
    </div>`).join("");
  el.querySelectorAll("[data-sig-default]").forEach((b) => b.addEventListener("click", async () => {
    try { await api(`/api/signatures/${b.getAttribute("data-sig-default")}/default`, { method: "PATCH", body: "{}" }); await loadSignatures(); }
    catch (err) { showMessage(err.message || "Failed.", "error"); }
  }));
  el.querySelectorAll("[data-sig-delete]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this signature?")) return;
    try { await api(`/api/signatures/${b.getAttribute("data-sig-delete")}`, { method: "DELETE" }); await loadSignatures(); }
    catch (err) { showMessage(err.message || "Delete failed.", "error"); }
  }));
}

// A LICENCE HOLDER SIGNS FOR ONE COMPANY (signatures.ts LICENCE_HOLDER_ROLES — keep the two lists
// equal). The applicant is whoever submits, the same on every company's job.
const SIGNATURE_LICENCE_ROLES = ["electrician", "contractor"];

function signatureCompanyNote(r) {
  if (!SIGNATURE_LICENCE_ROLES.includes(r.role)) return "";
  if (!r.clientId) return " · no company — never stamped";
  const c = (state.clients || []).find((x) => x.id === r.clientId);
  return ` · for ${c ? (c.companyName || c.legalBusinessName || "a company") : "a company"}`;
}

async function syncSignatureCompanyPicker() {
  const role = $("addSigRole")?.value || "applicant";
  const sel = $("addSigClient");
  if (!sel) return;
  const needsCompany = SIGNATURE_LICENCE_ROLES.includes(role);
  sel.hidden = !needsCompany;
  if (!needsCompany) return;
  if (!(state.clients || []).length) { try { await loadClients(); } catch { /* the upload names the gap */ } }
  const keep = sel.value;
  sel.innerHTML = `<option value="">Company (required)…</option>` + (state.clients || [])
    .map((c) => `<option value="${esc(c.id)}">${esc(c.companyName || c.legalBusinessName || "Unnamed")}</option>`).join("");
  if (keep) sel.value = keep;
}

async function uploadSignature(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const role = $("addSigRole")?.value || "applicant";
  const name = ($("addSigName")?.value || "").trim();
  const isDefault = $("addSigDefault")?.checked ? "1" : "0";
  const status = $("signaturesStatus");
  const clientId = SIGNATURE_LICENCE_ROLES.includes(role) ? ($("addSigClient")?.value || "") : "";
  if (SIGNATURE_LICENCE_ROLES.includes(role) && !clientId) {
    showMessage(`Choose the company this ${role} signs for — a licence holder's signature is stamped only on that company's jobs.`, "error");
    ev.target.value = "";
    return;
  }
  if (status) status.textContent = `Uploading ${file.name}…`;
  try {
    const buf = await file.arrayBuffer();
    const qs = new URLSearchParams({ role, name, default: isDefault });
    if (clientId) qs.set("clientId", clientId);
    const res = await fetch(`/api/signatures?${qs.toString()}`, {
      method: "POST", headers: { "Content-Type": file.type || "image/png" }, body: buf,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
    if (status) status.textContent = "Saved.";
    await loadSignatures();
  } catch (err) { if (status) status.textContent = ""; showMessage(err.message || "Upload failed.", "error"); }
  finally { ev.target.value = ""; }
}

async function loadEmailTracker() {
  try {
    state.emailTracker = await api("/api/email-tracker");
    renderEmailTracker();
  } catch (err) {
    $("emailTrackerStatus").textContent = err.message || "Email tracker status unavailable.";
  }
}

async function loadOpsPlan() {
  if (!state.selectedProjectId) {
    state.opsPlan = null;
    state.opsBrief = null;
    return;
  }
  const [plan, brief] = await Promise.all([
    api(`/api/projects/${state.selectedProjectId}/ops-plan`),
    api(`/api/projects/${state.selectedProjectId}/ops-brief`),
  ]);
  state.opsPlan = plan;
  state.opsBrief = brief;
}

async function loadProjectResource(key, endpoint) {
  if (!state.selectedProjectId) {
    state[key] = null;
    return;
  }
  state[key] = await api(`/api/projects/${state.selectedProjectId}/${endpoint}`);
}

async function loadLiveReadiness() {
  await loadProjectResource("liveReadiness", "live-readiness");
}

async function loadRunbook() {
  await loadProjectResource("runbook", "runbook");
}

async function loadHandoffPacket() {
  await loadProjectResource("handoffPacket", "handoff-packet");
}

async function loadCommunicationDrafts() {
  await loadProjectResource("communicationDrafts", "communication-drafts");
}

async function loadPmPackets() {
  await loadSubmitGate();
  await loadRunbook();
  await loadHandoffPacket();
  await loadCommunicationDrafts();
}

// WHICH STORED READINGS THIS PROJECT IS STILL PUBLISHING THAT THE RULES NOW DISAGREE WITH.
//
// The customer's status page already marks a stale reading "needs confirming" — but only the
// OPERATOR can clear it, and clearing it means recording a real new check. This is the operator's
// half of that: the same drift report, on the page where the re-check button lives. Without it the
// classifier fix reaches the person who cannot act on it and not the person who can.
async function loadStaleReadings() {
  await loadProjectResource("staleReadings", "permit-checks/stale");
}

async function loadProjectTimeline() {
  await loadProjectResource("projectTimeline", "timeline");
}

async function loadProcessMap() {
  await loadProjectResource("processMap", "process-map");
}

async function loadInstallerPacket() {
  await loadProjectResource("installerPacket", "installer-actions");
}

async function loadSubmitGate() {
  await loadProjectResource("submitGate", "submit-gate");
}

// Portal per-job questions the project record can't answer yet (financing/
// ownership, community solar, …). Unanswered ones surface as a blocker chip so
// the operator sees "N portal questions unanswered" BEFORE staging files a
// frozen wrong answer silently.
async function loadPortalQuestions() {
  await loadProjectResource("portalQuestions", "portal-questions");
}

function renderPortalQuestionChip() {
  const row = document.querySelector(".intake-link-row");
  if (!row) return;
  let chip = document.getElementById("portalQuestionsChip");
  const pq = state.portalQuestions;
  if (!pq || !pq.unansweredCount) { if (chip) chip.remove(); return; }
  if (!chip) {
    chip = document.createElement("span");
    chip.id = "portalQuestionsChip";
    row.appendChild(chip);
  }
  chip.className = "chip danger";
  chip.style.fontSize = "12px";
  const unsure = pq.unsureCount ? ` · installer unsure about ${pq.unsureCount}` : "";
  // textContent/title assignments only — nothing interpolated into innerHTML.
  chip.textContent = `⚠ ${pq.unansweredCount} portal question${pq.unansweredCount === 1 ? "" : "s"} unanswered${unsure}`;
  chip.title = "The portal will ask these about this job and the documents don't answer them. "
    + "Send the client intake link (button to the left) or answer in the portal at staging:\n"
    + (pq.questions || []).map((q) => `• ${q.label}${q.unsure ? " (installer wasn't sure)" : ""}`).join("\n");
}

function renderEmailTracker() {
  const sources = state.emailTracker?.sources || [];
  const active = sources.find((source) => source.active) || sources[0];
  if (active && !$("emailWatchPath").value) $("emailWatchPath").value = active.filePath || "";
  if (!sources.length) {
    $("emailTrackerStatus").textContent = "No email watch source configured.";
    return;
  }
  const totalMatches = (state.emailTracker?.recentMatches || []).length;
  $("emailTrackerStatus").textContent = `${sources.filter((source) => source.active).length} active email watch source(s). Last scan: ${active?.lastCheckedAt ? new Date(active.lastCheckedAt).toLocaleString() : "not run"}; last matched ${active?.lastMatchedCount || 0}/${active?.lastMessageCount || 0}; recent matches ${totalMatches}.${active?.lastError ? ` Error: ${active.lastError}` : ""}`;
}

// The sub-stage chip: WHERE INSIDE a stage this project actually sits.
//
// `stageDetail` is the enum the backend writes alongside the free-text
// `current_stage` prose (it never rewrites that prose — a recorded label is a
// matching key). It is the ONLY structured answer to "the stage says Submit,
// but submitted to whom, and waiting on what?", which is the jank the operator
// named.
//
// AN UNKNOWN MUST NEVER READ AS REASSURANCE. A project whose backend has not
// written a stage_detail yet — every row in the live DB today — knows nothing
// extra about itself, and this returns the EMPTY STRING for it: no chip, no
// "—", no shell, nothing on screen. A placeholder here would invent progress
// out of a NULL column. The three empty shapes are all one branch: absent
// field, null, and a string that is only whitespace.
//
// Label: bare humanize() of the slug, deliberately not a hand-written display
// map. The StageDetail union is defined backend-side; a local map would go
// stale silently and mislabel a value it had never heard of, which is worse
// than "approved_awaiting_filing" reading as "Approved awaiting filing".
function stageDetailChipHtml(project) {
  const raw = project && project.stageDetail;
  if (typeof raw !== "string" || !raw.trim()) return "";
  const detail = raw.trim();
  // "operator_override" only records that a person set the status by hand — it is not a stage
  // anyone acts on, so it prints nothing (a BLOCKED row says Blocked instead, below).
  // (isBlocked alone also covers an open correction, whose own sub-stage says more — so only
  // the bare operator_override row is relabelled.)
  const operatorBlock = detail === "operator_override" && !!project.isBlocked;
  if (detail === "operator_override" && !operatorBlock) return "";
  const label = operatorBlock
    ? "Blocked"
    : humanize(detail).replace(/\b(Qc|Nem|Ahj|Mfa)\b/g, (w) => w.toUpperCase());
  return ` <span class="chip stage-detail-chip${operatorBlock ? " is-blocked" : ""}" title="Sub-stage recorded by the system: ${esc(detail)}">${esc(label)}</span>`;
}

// Stage pill + "Stage N of 5" progress for the table view.
function stagePillHtml(project) {
  const idx = Number.isInteger(project.stageIndex) ? project.stageIndex : 0;
  const count = project.stageCount || PROJECT_STAGES.length;
  const pct = Math.round(((idx + 1) / count) * 100);
  const blocked = project.isBlocked ? " is-blocked" : "";
  return `<span class="stage-tag stage-${esc(project.stageKey || "qc")}${blocked}" title="${esc(project.status || "")}">${esc(project.stageLabel || "—")}</span>`
    + stageDetailChipHtml(project)
    + `<br><span class="muted">Stage ${idx + 1} of ${count}</span>`
    + `<div class="stage-progress"><span style="width:${pct}%"></span></div>`;
}

function renderProjects() {
  const projects = state.projects;
  const total = state.projectsTotal ?? projects.length;
  $("projectCount").textContent = `${projects.length}${total > projects.length ? `/${total}` : ""} projects`;
  // Both views read the same (server-filtered) state.projects; the page router
  // decides which container is visible. Render both so a page switch is instant.
  renderBoard();
  renderProjectTable();
  // Ask the submit gate for every card whose list answer it could still overrule.
  if (typeof fetch === "function") void hydrateBoardGates();
}

function renderProjectTable() {
  const body = $("projectsBody");
  const projects = state.projects;
  const total = state.projectsTotal ?? projects.length;
  if (!projects.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted">No projects saved yet.</td></tr>`;
    return;
  }
  const userMap = Object.fromEntries((state.users || []).map((u) => [u.id, u]));
  body.innerHTML = projects.map((project) => {
    const assignee = project.assignedUserId ? userMap[project.assignedUserId] : null;
    const assigneeHtml = assignee
      ? `<span style="display:inline-flex;align-items:center;gap:4px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${esc(assignee.color)}"></span>${esc(assignee.name)}</span>`
      : `<span class="muted">—</span>`;
    return `
    <tr data-project-id="${project.id}" class="${project.id === state.selectedProjectId ? "active" : ""}">
      <td class="project-cell"><strong>${esc(project.homeownerName || "Unnamed")}</strong><br><span class="muted">${esc(project.projectAddress || "No address")}</span>${project.clientName ? `<br><span class="muted" style="font-size:11px">🏢 ${esc(project.clientName)}</span>` : ""}</td>
      <td data-label="Assignee">${assigneeHtml}</td>
      <td data-label="Stage">${stagePillHtml(project)}</td>
      <td data-label="Permit" class="lane-cell">${projectLaneStatusCell(project.latestPermitLabel, project.latestPermitOutcome, project.latestPermitCheckedAt, project.readyForIssue, "ready for issue")}</td>
      <td data-label="NEM" class="lane-cell">${projectLaneStatusCell(project.latestNemLabel, project.latestNemOutcome, project.latestNemCheckedAt, project.nemApproved, "NEM approved")}</td>
      <td data-label="QC" class="qc-cell">${project.qcFailCount ? `<strong class="danger">${project.qcFailCount} fail</strong>` : "0 fail"}<br><span class="muted">${project.qcWarningCount ?? 0} warn</span></td>
      <td data-label="Review">${project.pendingReviewCount ?? 0}</td>
    </tr>`;
  }).join("");
  if (total > projects.length) {
    const loadMoreRow = document.createElement("tr");
    loadMoreRow.innerHTML = `<td colspan="7" style="text-align:center;padding:12px"><button id="loadMoreBtn" class="secondary">Load more (${total - projects.length} remaining)</button></td>`;
    body.appendChild(loadMoreRow);
    loadMoreRow.querySelector("#loadMoreBtn").addEventListener("click", loadMoreProjects);
  }
  body.querySelectorAll("tr[data-project-id]").forEach((row) => {
    row.addEventListener("click", () => selectProject(row.dataset.projectId));
  });
}

// WHAT EACH BOARD CARD NEEDS — the SERVER's answer, rendered. Every list row carries
// `nextStep` (backend/src/nextStep.ts, the same rule table as the project page's banner and
// GET /api/projects/:id/next-step), so the card chip, the "Needs me" pills and the banner
// are one predicate. This table only says how each answer LOOKS: its chip label and tone,
// and which pill it is counted under. The pills are a PARTITION of the keys — every project
// is counted under exactly one pill, the same one its chip names — so nothing can vanish
// from the pills or be counted twice. backend/test/submitSeam.test.ts checks every
// NextStepKey in shared/src/types.ts has a row here.
//
// `count` pulls the number out of the server's own headline ("Confirm 4 portal status
// reading(s)…"), so the chip's count is the server's count, never a second client tally.
const NEXT_STEP_CHIP = {
  operator_blocked: { pill: "to_fix", tone: "danger", label: "Blocked" },
  correction_overdue: { pill: "corrections", tone: "danger", label: "Correction overdue" },
  portal_paused: { pill: "to_fix", tone: "warning", label: "Portal paused" },
  automation_running: { pill: "waiting", tone: "neutral", label: "Staging running" },
  staging_failed: { pill: "staging_failed", tone: "danger", label: "Staging failed" },
  qc_not_run: { pill: "to_fix", tone: "warning", label: "Run QC" },
  qc_failed: { pill: "to_fix", tone: "danger", label: "QC failed", count: (n) => `${n} QC fail` },
  qc_review_pending: { pill: "to_fix", tone: "warning", label: "QC to review", count: (n) => `${n} to review` },
  gate_blocked: { pill: "to_fix", tone: "danger", label: "Gate blocked" },
  gap_fill_missing: { pill: "to_fix", tone: "warning", label: "Fields missing", count: (n) => `${n} field(s) missing` },
  resubmit_awaiting_me: { pill: "your_submit", tone: "warning", label: "Your resubmit" },
  staged_awaiting_submit: { pill: "your_submit", tone: "warning", label: "Your submit" },
  approved_awaiting_filing: { pill: "your_submit", tone: "warning", label: "Approved — file it" },
  fee_due: { pill: "to_fix", tone: "warning", label: "Fee due" },
  correction_open: { pill: "corrections", tone: "neutral", label: "Correction open" },
  payment_due: { pill: "ready", tone: "warning", label: "Payment due" },
  ready_to_stage: { pill: "ready", tone: "neutral", label: "Ready to stage" },
  filing_untracked: { pill: "to_fix", tone: "warning", label: "Not tracked" },
  portal_readings: { pill: "to_fix", tone: "warning", label: "Readings to confirm", count: (n) => `${n} reading(s) to confirm` },
  waiting_on_agency: { pill: "waiting", tone: "neutral", label: "Waiting on agency" },
  handoff_ready: { pill: "to_fix", tone: "neutral", label: "Hand off" },
  done: { pill: "done", tone: "neutral", label: "Done" },
  archived: { pill: "done", tone: "neutral", label: "Archived" },
  unknown: { pill: "to_fix", tone: "warning", label: "Check it" },
};
// Does the red "N things must clear before this can be submitted" note tell the truth? Pure;
// lifted by backend/test/submitSeam.test.ts.
//  - Only when the gate is actually blocking (not canPrepareSubmission, with blockers).
//  - Not once the gate itself says submitted/tracking AND the project is in Track/Closeout (the
//    gate reports submitted_tracking as soon as ANY submission is filed, so a pre-Track project
//    with one track filed would otherwise lose real blockers for the tracks it has not filed).
//  - Not when the server's FULL next-step answer (gateChecked) says every required filing is
//    made (its `allFiled` flag, derived in nextStep.ts): the gate has nothing left to hold back.
//    (ec5c36d3: NEM and both permits on file, status still ready_to_stage, so the stage index
//    alone could not tell.) The flag is the server's, never re-derived here from `key`.
function showSubmitBlockerNote(gate, stageIdx, nextStep) {
  const blockers = ((gate && gate.checks) || []).filter((check) => check.status === "blocker");
  if (!gate || gate.canPrepareSubmission || !blockers.length) return false;
  if (gate.decision === "submitted_tracking" && stageIdx >= 3) return false;
  if (nextStep && nextStep.gateChecked && nextStep.allFiled === true) return false;
  // Not while automation is doing it (next step automation_running): the automatic chain splits the
  // plan set and finds/fills the forms these blockers name (operator 2026-09-28: "can we just not
  // have it do this automatically?" — it was, mid-run). The note returns if the chain leaves any.
  if (nextStep && nextStep.key === "automation_running") return false;
  return true;
}
const WAITING_ON_LABEL = { designer: "Waiting on designer", customer: "Waiting on customer", ahj: "Waiting on AHJ", utility: "Waiting on utility" };

// The chip for one server answer (compact or full). Pure: backend/test/submitSeam.test.ts
// lifts it with NEXT_STEP_CHIP / WAITING_ON_LABEL in scope.
function nextStepChip(step) {
  if (!step || !step.key) return null;
  const row = NEXT_STEP_CHIP[step.key] || NEXT_STEP_CHIP.unknown;
  const first = /\b(\d+)\b/.exec(String(step.headline || ""));
  let label = row.count && first ? row.count(Number(first[1])) : row.label;
  // Someone else has the ball: say who, never a bare "Correction open".
  if (step.who && WAITING_ON_LABEL[step.who] && step.urgency === "waiting") label = WAITING_ON_LABEL[step.who];
  const tone = step.urgency === "overdue" ? "danger" : row.tone;
  // Provisional = a list-tier answer the submit gate could still pre-empt. The server says so
  // itself (`gateCanOverrule`, from where its rule table actually stopped); no key list here.
  const provisional = step.gateCanOverrule === true;
  // "READY" IS THE GATE'S WORD, NOT THE LIST'S. The list tier never runs the submit gate, so its
  // ready_to_stage only means "nothing before the gate stopped it" — the 100-project load test
  // showed 100 cards reading "Ready to stage" while the gate passed 16, and the demo's refusal
  // project read "Ready to stage" beside BLOCKED. Until the gate's own answer for the card
  // arrives (hydrateBoardGates), a ready-pill answer the gate could overrule says so, and is
  // counted under its own pill, never under "Ready to stage".
  if (row.pill === "ready" && step.gateChecked !== true && step.gateCanOverrule !== false) {
    return {
      key: "gate_pending", stepKey: step.key, tone: "neutral",
      label: step.key === "ready_to_stage" ? "Gate check pending" : label,
      title: `${String(step.headline || "")} — the submit gate has not been checked for this card yet; it can still block.`,
      provisional: true,
    };
  }
  const title = `${String(step.headline || "")}${provisional ? " — board check: the project page also runs the submit gate, which can come first." : ""}`;
  return { key: row.pill, stepKey: step.key, tone, label, title, provisional };
}

// WHICH ANSWER A BOARD CARD SHOWS: the gate's own (full) answer for this row when one has been
// fetched for it (state.gateAnswers — hydrateBoardGates), else the list row's answer. The cached
// answer is used only for the row it was fetched for (same updatedAt + list key) and only while
// fresh, so a project that changed is shown as unchecked until it is asked again. Pure apart from
// reading state.gateAnswers; lifted by backend/test/boardGateTruth.test.ts.
const GATE_ANSWER_TTL_MS = 5 * 60 * 1000;
function gateStampFor(p) {
  return `${(p && p.updatedAt) || ""}|${(p && p.nextStep && p.nextStep.key) || ""}`;
}
function boardStepFor(p, now) {
  const listStep = p && p.nextStep && p.nextStep.key ? p.nextStep : null;
  if (!listStep || listStep.gateChecked === true) return listStep;
  const answers = (typeof state !== "undefined" && state && state.gateAnswers) || {};
  const cached = answers[p.id];
  const at = typeof now === "number" ? now : Date.now();
  if (cached && cached.step && cached.stamp === gateStampFor(p) && at - cached.at < GATE_ANSWER_TTL_MS) return cached.step;
  return listStep;
}
// The full answer, reduced to what a card reads (the list row's compact shape, gate included).
function compactGateAnswer(step) {
  return {
    key: step.key, who: step.who, urgency: step.urgency, headline: step.headline,
    buttonId: step.button && step.button.id ? step.button.id : (step.buttonId || null),
    gateChecked: step.gateChecked === true, allFiled: step.allFiled === true,
    gateCanOverrule: step.gateCanOverrule === true, hasStagedDraft: step.hasStagedDraft === true,
  };
}
// Does this row still need the gate's answer? Any list answer the gate could pre-empt (the
// server's gateCanOverrule), or — from a server too old to say — a ready-pill answer.
function rowNeedsGateAnswer(p, now) {
  const s = p && p.nextStep;
  if (!s || !s.key || s.gateChecked === true) return false;
  const pill = (NEXT_STEP_CHIP[s.key] || {}).pill;
  if (!(s.gateCanOverrule === true || (s.gateCanOverrule === undefined && pill === "ready"))) return false;
  const answers = (typeof state !== "undefined" && state && state.gateAnswers) || {};
  const c = answers[p.id];
  if (!c || c.stamp !== gateStampFor(p)) return true;
  if (c.inFlight) return false;
  if (c.step) return now - c.at >= GATE_ANSWER_TTL_MS;
  return !c.failedAt || now - c.failedAt >= 60 * 1000;
}
// Record a full answer for a row (the board's fetch, or the project page's own next-step load).
function rememberGateAnswer(projectId, step) {
  if (!projectId || !step || !step.key || step.gateChecked !== true || !state.gateAnswers) return;
  const row = [].concat(state.projects || [], state.boardAll || []).find((p) => p && p.id === projectId);
  if (!row) return;
  state.gateAnswers[projectId] = { stamp: gateStampFor(row), at: Date.now(), step: compactGateAnswer(step) };
}
// Fetch the gate's answer for every card that needs one, THREE AT A TIME: the load test froze the
// server for 11 s when 300 detail reads fired together. Ready-pill cards first (they are the ones
// that would otherwise claim readiness). Each answer re-renders the board (debounced).
let gateHydrationRunning = false;
let gateHydrationAgain = false;
let gateRenderTimer = null;
function scheduleBoardRerender() {
  if (gateRenderTimer) return;
  gateRenderTimer = setTimeout(() => { gateRenderTimer = null; safeRender("board", renderBoard); }, 200);
}
async function hydrateBoardGates() {
  if (!state.gateAnswers) state.gateAnswers = {};
  if (gateHydrationRunning) { gateHydrationAgain = true; return; }
  gateHydrationRunning = true;
  try {
    do {
      gateHydrationAgain = false;
      const now = Date.now();
      const seen = new Set();
      const queue = [].concat(state.boardAll || [], state.projects || [])
        .filter((p) => p && p.id && !seen.has(p.id) && seen.add(p.id) && rowNeedsGateAnswer(p, now))
        .sort((a, b) => Number((NEXT_STEP_CHIP[b.nextStep.key] || {}).pill === "ready") - Number((NEXT_STEP_CHIP[a.nextStep.key] || {}).pill === "ready"));
      const worker = async () => {
        while (queue.length) {
          const p = queue.shift();
          const stamp = gateStampFor(p);
          state.gateAnswers[p.id] = { stamp, inFlight: true };
          try {
            const { nextStep } = await api(`/api/projects/${encodeURIComponent(p.id)}/next-step`);
            state.gateAnswers[p.id] = nextStep && nextStep.key && nextStep.gateChecked === true
              ? { stamp, at: Date.now(), step: compactGateAnswer(nextStep) }
              : { stamp, failedAt: Date.now() };
          } catch {
            state.gateAnswers[p.id] = { stamp, failedAt: Date.now() };
          }
          scheduleBoardRerender();
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
    } while (gateHydrationAgain);
  } finally {
    gateHydrationRunning = false;
  }
}

// Returns null when nothing is shown. Server answer first; the old client guess below is only
// the fallback for a row that arrived without one (an older server, or the list tier erroring
// for that row) — never blank, never a second opinion beside the server's.
function boardAttention(p) {
  if (!p) return null;
  const step = boardStepFor(p);
  const a = step ? nextStepChip(step) : legacyBoardAttention(p);
  // WHO ACTS NEXT, on the card (the server's `who`). A card still waiting on its gate check has
  // no owner yet — the gate may name the designer.
  if (a && step && step.who && a.key !== "gate_pending") a.who = step.who;
  // A DRAFT STAGED ON A PORTAL IS ALSO "YOUR SUBMIT", whatever comes first. The server's one
  // answer names the most urgent thing (a failed sibling track, fields to add…), but a project
  // with a staged application waiting on a person must not vanish from the "Your submit" count
  // — that is where the operator looks for drafts to file. It counts there too, and the card
  // says so ("Draft staged"). WHETHER a draft is staged is the server's `hasStagedDraft` (an
  // unfiled track's awaiting run, or a reopened form) — not the project status, which stays
  // awaiting_human_submit after the staged track is filed. A row with no server answer takes
  // the legacy guess below, which files awaiting_human_submit under Your submit directly.
  if (a && a.key !== "your_submit" && step && step.hasStagedDraft === true) a.alsoSubmit = true;
  return a;
}
function legacyBoardAttention(p) {
  const overdue = Number(p.overdueCorrections) || 0;
  const pending = Number(p.pendingReviewCount) || 0;
  const corrections = Number(p.correctionCount) || 0;
  if (overdue > 0) return { key: "corrections", stepKey: "correction_overdue", tone: "danger", label: "Correction overdue" };
  if (p.isBlocked) return { key: "to_fix", stepKey: "operator_blocked", tone: "danger", label: "Blocked" };
  if (nextStepFor(p.status, { stageDetail: p.stageDetail, latestRunStatus: p.latestPortalStatus }).key === "staging_failed") {
    return { key: "staging_failed", stepKey: "staging_failed", tone: "danger", label: "Staging failed" };
  }
  if (Number(p.qcFailCount) > 0) return { key: "to_fix", stepKey: "qc_failed", tone: "danger", label: `${Number(p.qcFailCount)} QC fail` };
  if (p.status === "awaiting_human_submit") return { key: "your_submit", stepKey: "staged_awaiting_submit", tone: "warning", label: "Your submit" };
  if (p.status === "awaiting_human_resubmit") return { key: "your_submit", stepKey: "resubmit_awaiting_me", tone: "warning", label: "Your resubmit" };
  if (pending > 0) return { key: "to_fix", stepKey: "qc_review_pending", tone: "warning", label: `${pending} to review` };
  if (corrections > 0) return { key: "corrections", stepKey: "correction_open", tone: "neutral", label: "Correction open" };
  // The old guess had nothing to ask of the operator: no chip, counted under Waiting.
  return { key: "waiting", stepKey: null, tone: null, label: "" };
}

// Pending human-review items the card's chip does not already count. The list payload's
// pendingReviewCount is EVERY pending item (QC checks, portal readings, advisory notices); the
// project page splits the same total across its stage pills (reviewItemBuckets), so the two
// always add up. Shown only when the chip's own number does not already say it.
function boardReviewCountChip(p, attn) {
  const n = Number(p && p.pendingReviewCount) || 0;
  if (!n) return "";
  const chipN = attn && /^(\d+) /.exec(attn.label || "");
  if (chipN && Number(chipN[1]) === n && (attn.stepKey === "qc_review_pending" || attn.stepKey === "portal_readings")) return "";
  return `<span class="chip" title="${esc(`${n} pending review item(s) in total — QC checks, portal readings and advisory notices; the project page shows where each one is`)}">${esc(`${n} review item${n === 1 ? "" : "s"}`)}</span>`;
}

// WHO ACTS NEXT on a card, in one word, from the server's answer. Silent when the chip already
// says it ("Waiting on designer"), when nobody is asked, and on a card still waiting on its gate.
const BOARD_WHO_SHORT = { me: "You", designer: "Designer", customer: "Customer", ahj: "AHJ", utility: "Utility" };
function boardWhoHtml(attn) {
  const who = attn && attn.who ? BOARD_WHO_SHORT[attn.who] : "";
  if (!who || /^Waiting on /.test(attn.label || "")) return "";
  return ` <span class="board-card-who muted" style="margin-left:6px;font-size:12px" title="Who acts next">Next: ${esc(who)}</span>`;
}

// Stage board: five columns; each project as a compact card in its current stage.
function boardCardHtml(p, userMap) {
  const assignee = p.assignedUserId ? userMap[p.assignedUserId] : null;
  const permit = p.readyForIssue ? "ready for issue" : (p.latestPermitLabel || (p.latestPermitOutcome ? p.latestPermitOutcome.replaceAll("_", " ") : ""));
  const nem = p.nemApproved ? "NEM approved" : (p.latestNemLabel || (p.latestNemOutcome ? p.latestNemOutcome.replaceAll("_", " ") : ""));
  const active = p.id === state.selectedProjectId ? " active" : "";
  const attn = boardAttention(p);
  const attnClass = attn && attn.label && (attn.tone === "danger" || attn.tone === "warning") ? ` is-attention is-attention-${attn.tone}` : "";
  // The lane chips are unchanged until the server's lane summary uses the latest check
  // (server change S4); the date they are "as of" rides on the title so an old reading
  // cannot pass for a current one.
  const permitAsOf = p.latestPermitCheckedAt ? ` title="as of ${esc(fmtDate(p.latestPermitCheckedAt, true))}"` : "";
  const nemAsOf = p.latestNemCheckedAt ? ` title="as of ${esc(fmtDate(p.latestNemCheckedAt, true))}"` : "";
  return `<button type="button" class="board-card${active}${p.isBlocked ? " is-blocked" : ""}${attnClass}" data-board-pid="${esc(p.id)}" data-attn="${esc(attn ? attn.key : "")}" data-attn-also="${esc(attn && attn.alsoSubmit ? "your_submit" : "")}">
    <span class="board-card-name">${esc(p.homeownerName || "Unnamed")}</span>
    ${attn && attn.label ? `<span class="board-card-action"><span class="chip ${esc(attn.tone)}${attn.provisional ? " is-provisional" : ""}" title="${esc(attn.title || "")}">${esc(attn.label)}</span>${boardWhoHtml(attn)}</span>` : ""}
    <span class="board-card-addr muted" title="${esc(p.projectAddress || "No address")}">${esc(p.projectAddress || "No address")}</span>
    <span class="board-card-meta">
      ${permit ? `<span class="chip"${permitAsOf}>Permit: ${esc(permit)}</span>` : ""}
      ${nem ? `<span class="chip"${nemAsOf}>Interconnection: ${esc(nem)}</span>` : ""}
      ${attn && attn.alsoSubmit ? `<span class="chip" title="A staged application waits on a person's review and submit; the chip above comes first.">Draft staged</span>` : ""}
      ${boardReviewCountChip(p, attn)}
    </span>
    ${assignee ? `<span class="board-card-assignee" title="${esc(`Assigned to ${assignee.name || "a team member"}`)}"><span class="dot" style="background:${esc(assignee.color)}"></span><span class="board-card-assignee-label">Assigned:</span> ${esc(assignee.name || "—")}</span>` : ""}
  </button>`;
}

const STAGE_HELP = {
  qc: "Check the parsed data and resolve flagged items",
  build: "Prepare documents and review the plans", submit: "Review the application, then file",
  track: "Monitor permits and interconnection", closeout: "Deliver the approved project packet",
};
function renderBoard() {
  const el = $("projectBoard");
  if (!el) return;
  el.classList.remove("board-skeleton");
  const userMap = Object.fromEntries((state.users || []).map((u) => [u.id, u]));
  const groups = new Map(PROJECT_STAGES.map((s) => [s.key, []]));
  for (const p of state.projects) {
    // Unknown/absent stageKey falls to the FIRST stage of the five (QC / Verify),
    // which is also where a legacy row that still says "intake" belongs.
    const key = groups.has(p.stageKey) ? p.stageKey : "qc";
    groups.get(key).push(p);
  }
  // A SEARCH THAT MATCHES NOTHING says so once, across the board, with a way out — not five
  // columns each saying "No projects here", which reads as "the pipeline is empty".
  const query = (projectFilterState.search || "").trim();
  if (!state.projects.length && query) {
    if (el.style && el.style.removeProperty) el.style.removeProperty("--board-cols");
    el.innerHTML = `<div class="board-nomatch"><span>No projects match “${esc(query)}”</span>
      <button type="button" class="secondary" data-clear-search="1">Clear search</button></div>`;
    el.querySelector("[data-clear-search]")?.addEventListener("click", () => {
      const s = $("projectSearch");
      if (s) s.value = "";
      projectFilterState.search = "";
      projectFilterState.offset = 0;
      reloadProjects();
    });
    renderNeedsMePills();
    return;
  }
  // EMPTY COLUMNS SHRINK to narrow rails; occupied ones share the width. Column order and
  // data-stage are unchanged (keyboard j/k walks .board-card). Set as a custom property so
  // the phone layout's own column rule (styles.css, max-width:700px) still wins there.
  const template = PROJECT_STAGES.map((s) => ((groups.get(s.key) || []).length ? "minmax(240px, 1fr)" : "minmax(110px, .3fr)")).join(" ");
  if (el.style && el.style.setProperty) el.style.setProperty("--board-cols", template);
  el.innerHTML = PROJECT_STAGES.map((stage) => {
    const items = groups.get(stage.key) || [];
    // The per-column help sentence is the head's title now (it cost a line per column).
    return `<div class="stage-col${items.length ? "" : " is-empty"}" data-stage="${stage.key}">
      <div class="stage-col-head" title="${esc(STAGE_HELP[stage.key] || "")}"><span>${esc(stage.label)}</span><span class="badge">${items.length}</span></div>
      <div class="stage-col-body">
        ${items.length ? items.map((p) => boardCardHtml(p, userMap)).join("") : `<p class="muted board-empty">None here</p>`}
      </div>
    </div>`;
  }).join("");
  el.querySelectorAll("[data-board-pid]").forEach((card) => {
    card.addEventListener("click", () => selectProject(card.dataset.boardPid));
  });
  renderNeedsMePills();
  if (window.lucide) window.lucide.createIcons();
}

// "NEEDS ME" PILLS — counts of what the cards say, from the same boardAttention() that picks
// each card's chip (one predicate: the server's nextStep). The pills PARTITION the board —
// every project is counted under exactly one, the pill its chip belongs to — and they count
// the WHOLE board (state.boardAll: every project, not only the search/filter page on screen).
// Clicking one dims every card that does not carry that need; "All" (or clicking it again)
// clears. A view filter only: no request, no state saved.
const NEEDS_ME_PILLS = [
  { key: "your_submit", label: "Your submit" },
  { key: "staging_failed", label: "Staging failed" },
  { key: "to_fix", label: "To fix" },
  { key: "corrections", label: "Corrections" },
  { key: "ready", label: "Ready to stage" },
  // Cards whose list answer would read "ready" but whose submit gate has not answered yet
  // (nextStepChip). They move to their real pill as each gate answer arrives.
  { key: "gate_pending", label: "Gate check pending", hideWhenZero: true },
  { key: "waiting", label: "Waiting" },
  { key: "done", label: "Done", hideWhenZero: true },
];
// Pure: the pill counts for a list of rows. Lifted by backend/test/submitSeam.test.ts.
function needsMeCounts(rows) {
  const counts = Object.fromEntries(NEEDS_ME_PILLS.map((p) => [p.key, 0]));
  let overdue = 0;
  for (const p of rows || []) {
    const a = boardAttention(p);
    const key = a && Object.prototype.hasOwnProperty.call(counts, a.key) ? a.key : "to_fix";
    counts[key] += 1;
    if (a && a.alsoSubmit) counts.your_submit += 1;
    if (a && a.stepKey === "correction_overdue") overdue += 1;
  }
  return { counts, overdue, total: (rows || []).length };
}
function renderNeedsMePills() {
  const wrap = $("needsMePills");
  if (!wrap) return;
  const whole = Array.isArray(state.boardAll);
  const { counts, overdue, total } = needsMeCounts(whole ? state.boardAll : state.projects);
  const active = state.boardAttnFilter || "";
  const pills = NEEDS_ME_PILLS.filter((pill) => !(pill.hideWhenZero && !counts[pill.key])).map((pill) => {
    const n = counts[pill.key];
    const od = pill.key === "corrections" ? overdue : 0;
    const text = `${pill.label} (${n}${od ? `, ${od} overdue` : ""})`;
    return `<button type="button" class="needs-pill${n ? "" : " is-zero"}${active === pill.key ? " is-active" : ""}" data-attn-pill="${esc(pill.key)}" data-attn="${esc(pill.key)}" aria-pressed="${active === pill.key}">${esc(text)}</button>`;
  });
  // Say what the counts cover: the whole board, or (if that fetch failed) only this page.
  const scope = `${whole ? `Counts cover the whole board (${total} project${total === 1 ? "" : "s"}), whatever the filters show.` : "Counts cover only the projects on this page."} Each project counts under the pill its chip names; one with a staged draft also counts under Your submit.`;
  wrap.title = scope;
  wrap.innerHTML = `<button type="button" class="needs-pill${active ? "" : " is-active"}" data-attn-pill="" aria-pressed="${!active}">All</button>${pills.join("")}`;
  wrap.querySelectorAll("[data-attn-pill]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.attnPill || "";
      state.boardAttnFilter = key && state.boardAttnFilter !== key ? key : "";
      renderNeedsMePills();
    });
  });
  applyBoardAttnFilter();
}
function applyBoardAttnFilter() {
  const board = $("projectBoard");
  if (!board || !board.querySelectorAll) return;
  const pill = NEEDS_ME_PILLS.find((p) => p.key === state.boardAttnFilter);
  board.classList.toggle("is-attn-filtered", !!pill);
  board.querySelectorAll(".board-card").forEach((card) => {
    card.classList.toggle("is-dimmed", !!pill && pill.key !== card.dataset.attn && pill.key !== card.dataset.attnAlso);
  });
}

// ----- Page router -----
// Four pages share two top-level sections: #pageList (Dashboard board / Projects
// table / Team Workload) and #pageProject (the per-project workflow). Driven by
// the URL hash so back/forward and deep links work: #/dashboard, #/projects,
// #/team, #/project/<id>.
const VALID_PAGES = ["dashboard", "projects", "team", "project"];

function showPage(page, opts = {}) {
  if (!VALID_PAGES.includes(page)) page = "dashboard";
  state.page = page;
  const isProject = page === "project";
  const listPages = page === "dashboard" || page === "projects" || page === "team";
  $("pageList").hidden = !listPages;
  $("pageProject").hidden = !isProject;
  // Sub-pages inside the list section.
  $("projectBoard").hidden = page !== "dashboard";
  $("projectTableWrap").hidden = page !== "projects";
  $("pageTeam").hidden = page !== "team";
  // The search/status/assignee/company filter bar applies to board + table only.
  const showFilters = page === "dashboard" || page === "projects";
  if ($("listFilters")) $("listFilters").hidden = !showFilters;
  // The "How a project flows" legend is a BOARD legend. On the project page it
  // was a third competing navigation under a stage banner and a stage accordion
  // that already narrate the same pipeline — and its safety sentence is not
  // lost here: renderNextStep puts it in the stage banner and the Submit Gate
  // repeats it on this same screen.
  if ($("startHereGuide")) $("startHereGuide").hidden = isProject;
  if ($("listPageTitle")) $("listPageTitle").textContent = page === "projects" ? "Projects" : page === "team" ? "Team Workload" : "Dashboard";
  $("projectCount").parentElement.hidden = page === "team";
  // Nav tab active state.
  document.querySelectorAll(".page-tab").forEach((t) => {
    t.setAttribute("aria-selected", String(t.dataset.page === (isProject ? "" : page)));
  });
  if (page === "team" && !opts.skipLoad) loadTeamWorkload();
  if (window.lucide) window.lucide.createIcons();
}

// Translate the URL hash into a page (and load a project when deep-linked).
function routeFromHash() {
  const hash = (window.location.hash || "").replace(/^#\/?/, "");
  const [page, id] = hash.split("/");
  if (page === "project" && id) {
    if (state.selectedProjectId !== id || !state.detail) {
      // A stale or foreign link (deleted project, another workspace's id) used to leave an
      // uncaught "Project not found." and a blank page. Say so, and land on the dashboard.
      selectProject(id).catch((err) => {
        if (state.selectedProjectId === id) { state.selectedProjectId = null; state.detail = null; }
        const gone = /not found|404/i.test(String(err && err.message || ""));
        navigate("#/dashboard");
        // A toast, not showMessage: #message lives inside the project view, hidden on the dashboard.
        showToast(gone
          ? "That project no longer exists or is not in your workspace."
          : `Could not open that project: ${(err && err.message) || "unknown error"}`, gone ? "warning" : "error", 9000);
      });
    } else {
      showPage("project");
    }
    return;
  }
  showPage(VALID_PAGES.includes(page) ? page : "dashboard");
}

function navigate(hash) {
  if (window.location.hash === hash) routeFromHash();
  else window.location.hash = hash;
}

function renderOpsReport() {
  const report = state.opsReport;
  if (!report) {
    $("opsReportStatus").textContent = "not synced";
    $("opsReport").innerHTML = `<p class="muted">Daily report has not loaded yet.</p>`;
    $("copyOpsReportBtn").disabled = true;
    return;
  }
  $("copyOpsReportBtn").disabled = !report.reportText;
  $("opsReportStatus").textContent = `${report.board?.blockedProjects || 0} blocked`;
  const owners = report.ownerWorkload || [];
  const dueNow = report.dueNow || [];
  const topActions = report.topActions || [];
  $("opsReport").innerHTML = `
    <article class="item ${report.board?.blockedProjects ? "blocker" : report.actionQueue?.totalActions ? "warning" : "pass"}">
      <div class="item-title"><span>${esc(report.headline)}</span>${statusBadge(report.actionQueue?.totalActions || 0)}</div>
      ${(report.summary || []).map((line) => `<p>${esc(line)}</p>`).join("")}
    </article>
    <div class="ops-report-grid">
      <article class="ops-report-section">
        <div class="item-title"><span>Owners</span>${statusBadge(owners.length)}</div>
        ${owners.length ? owners.slice(0, 5).map((owner) => `
          <p><strong>${esc(owner.ownerRole)}</strong>: ${owner.totalActions} action(s), ${owner.blockedActions} blocked, ${owner.overdueActions} overdue</p>
        `).join("") : `<p class="muted">No active owner workload.</p>`}
      </article>
      <article class="ops-report-section">
        <div class="item-title"><span>Due Now</span>${statusBadge(dueNow.length)}</div>
        ${dueNow.length ? dueNow.slice(0, 4).map((action) => `
          <p><strong>${esc(action.ownerRole)}</strong>: ${esc(action.phaseName)} | ${esc(action.homeownerName || "Unnamed")}</p>
        `).join("") : `<p class="muted">No actions due today or overdue.</p>`}
      </article>
      <article class="ops-report-section wide">
        <div class="item-title"><span>Top Actions</span>${statusBadge(topActions.length)}</div>
        ${topActions.length ? topActions.slice(0, 5).map((action) => `
          <p><strong>${esc(action.ownerRole)}</strong>: ${esc(action.homeownerName || "Unnamed")} | ${esc(action.phaseName)}<br><span class="muted">${esc(action.action)}</span></p>
        `).join("") : `<p class="muted">No active actions.</p>`}
      </article>
    </div>
  `;
}

function dueLabel(action) {
  if (action.dueBucket === "overdue") return `overdue${action.dueAt ? ` ${action.dueAt}` : ""}`;
  if (action.dueBucket === "today") return "due today";
  if (action.dueBucket === "upcoming") return `due ${action.dueAt}`;
  return "no due date";
}

function renderOpsActions() {
  const queue = state.opsActions;
  if (!queue) {
    $("opsActionsStatus").textContent = "not synced";
    $("opsActions").innerHTML = `<p class="muted">Active action queue has not loaded yet.</p>`;
    return;
  }
  $("opsActionsStatus").textContent = `${queue.totalActions || 0} actions`;
  const actions = queue.actions || [];
  $("opsActions").innerHTML = `
    <div class="ops-action-metrics">
      <span>${queue.blockedActions || 0} blocked</span>
      <span>${queue.waitingActions || 0} waiting</span>
      <span>${queue.inProgressActions || 0} active</span>
      <span>${queue.overdueActions || 0} overdue</span>
    </div>
    <div class="ops-action-list">
      ${actions.length ? actions.slice(0, 12).map((action) => `
        <article class="ops-action-card ${opsClass(action.status)} ${action.projectId === state.selectedProjectId ? "active" : ""}" data-action-project-id="${action.projectId}" data-action-step-id="${action.stepId}">
          <div class="ops-action-card-head" style="cursor:pointer" data-action-toggle="${action.stepId}">
            <strong>${esc(action.ownerRole || "Operations")}</strong>
            ${statusBadge(action.status)}
          </div>
          <span>${esc(action.phaseName)} | ${esc(action.homeownerName || "Unnamed")}</span>
          <span>${esc(action.action)}</span>
          <span class="muted">${esc(dueLabel(action))} | ${esc(action.source)} | ${action.blockerCount} project blocker(s)</span>
          <form class="ops-action-form" data-action-form="${action.projectId}:${action.stepId}" method="post" action="/api/projects/${action.projectId}/ops-steps/${action.stepId}" target="opsActionFrame" hidden>
            <div class="ops-action-controls">
              <label>Status<select id="action-status-${action.stepId}" name="status">${opsStatusOptions(action.status)}</select></label>
              <label>Owner<input id="action-owner-${action.stepId}" name="ownerRole" value="${esc(action.ownerRole || "")}" /></label>
              <label>Due<input id="action-due-${action.stepId}" name="dueAt" type="date" value="${esc(action.dueAt || "")}" /></label>
              <button type="button" class="secondary" data-action-open="${action.projectId}"><i data-lucide="folder-open"></i><span>Open</span></button>
              <button type="submit" class="primary"><i data-lucide="save"></i><span>Save</span></button>
            </div>
            <textarea id="action-notes-${action.stepId}" name="notes" placeholder="PM note for this action">${esc(action.notes || "")}</textarea>
          </form>
        </article>
      `).join("") : `<p class="muted">No active actions. Keep monitoring email and approvals.</p>`}
    </div>
  `;
}

function handleOpsActionClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const openButton = target.closest("button[data-action-open]");
  if (openButton) {
    selectProject(openButton.dataset.actionOpen);
    return;
  }
  const toggleHead = target.closest("[data-action-toggle]");
  if (toggleHead) {
    const stepId = toggleHead.dataset.actionToggle;
    const card = toggleHead.closest(".ops-action-card");
    const form = card?.querySelector(`.ops-action-form[data-action-form*="${stepId}"]`);
    if (form) form.hidden = !form.hidden;
    return;
  }
}

async function handleOpsActionFrameLoad() {
  if (!state.opsActions) return;
  showMessage("Action saved.");
  await refreshProjectListOnly();
}

// WHO STANDS BEHIND A KNOWLEDGE ROW. "mixed" is a provenance LABEL (seeded + learned merged) —
// it was once also written by a human verification, and the lock now reads verified_at alone
// (hard rule 3, isVerifiedKnowledge). The badge follows the lock: "Verified" only when a person
// verified the row (verifiedAt); "mixed" is shown as the plain merge it is, never as verified.
function kbConfidenceBadge(profile) {
  if (profile && profile.verifiedAt) {
    const when = new Date(profile.verifiedAt);
    const title = `Verified by a person${Number.isNaN(when.getTime()) ? "" : ` on ${when.toLocaleDateString()}`}${profile.verifiedBy ? ` (${profile.verifiedBy})` : ""} — automation never overwrites it.`;
    return `<span class="badge badge-pass" title="${esc(title)}">Verified</span>`;
  }
  if (profile && profile.confidence === "mixed") {
    return `<span class="badge" title="Seeded reference data merged with what projects taught — not verified by a person.">Learned + seeded</span>`;
  }
  return statusBadge(profile ? profile.confidence : "unknown");
}

function renderKnowledgeProfile(profile) {
  const title = [profile.state, profile.ahj || "Any AHJ", profile.utility || "Any utility"].filter(Boolean).join(" / ");
  const timeline = profile.averageTimelineDays == null
    ? null
    : `${profile.averageTimelineDays.toFixed(1)} days avg (${profile.timelineSampleCount} sample${profile.timelineSampleCount === 1 ? "" : "s"})`;
  const docs = profile.requiredDocuments || [];
  const corrections = (profile.commonCorrections || []).slice(0, 4);
  const sourceSummary = (() => {
    const types = [...new Set((profile.sources || []).map((s) => s.sourceType))];
    const labels = types.map((t) => ({
      official: "official", sanitized_reference: "reference", learned_project: "projects",
      learned_correction: "corrections", learned_permit_status: "permit status", learned_batch_import: "batch scan",
    }[t] || t));
    return labels.join(", ");
  })();
  const lastLearned = profile.lastLearnedAt ? new Date(profile.lastLearnedAt).toLocaleDateString() : null;
  const colorClass = profile.correctionCount > 0 ? "warning" : profile.projectCount > 0 ? "info" : "pass";
  return `
    <article class="item ${colorClass}" style="margin-bottom:8px">
      <div class="item-title">
        <span>${esc(title)}</span>
        ${kbConfidenceBadge(profile)}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:12px;margin:4px 0 6px">
        <span>📁 ${esc(String(Number(profile.projectCount) || 0))} project${Number(profile.projectCount) === 1 ? "" : "s"}</span>
        <span>⚠️ ${esc(String(Number(profile.correctionCount) || 0))} correction${Number(profile.correctionCount) === 1 ? "" : "s"}</span>
        ${timeline ? `<span>📅 ${esc(timeline)}</span>` : ""}
        ${lastLearned ? `<span>🔄 Last learned ${esc(lastLearned)}</span>` : ""}
        ${sourceSummary ? `<span class="muted">Sources: ${esc(sourceSummary)}</span>` : ""}
      </div>
      ${profile.portalName ? `<p style="margin:2px 0;font-size:12px"><strong>Portal:</strong> ${esc(profile.portalName)}${profile.portalUrl ? ` — <a href="${esc(profile.portalUrl)}" target="_blank" rel="noopener">${esc((() => { try { return new URL(profile.portalUrl).hostname.replace(/^www[.]/i, ""); } catch { return profile.portalUrl; } })())}</a>` : ""}</p>` : ""}
      ${docs.length ? `<p style="margin:4px 0;font-size:12px"><strong>Required docs (${docs.length}):</strong> ${esc(docs.join(" · "))}</p>` : `<p style="margin:4px 0;font-size:12px;color:var(--muted)">No required documents learned yet.</p>`}
      ${corrections.length ? `<div style="margin-top:4px;font-size:12px"><strong>Common corrections:</strong> <ul style="margin:2px 0 0 16px;padding:0">${corrections.map((c) => `<li>${esc(c.rootCause)}${c.count > 1 ? ` (×${c.count})` : ""}</li>`).join("")}</ul></div>` : ""}
      ${profile.notes ? kbNotesHtml(profile.notes) : ""}
      ${kbDesignCriteriaHtml(codeProfileForKb(profile, state.codeProfiles || []))}
    </article>
  `;
}

// THE JURISDICTION'S CODE PROFILE ON ITS KB CARD. Knowledge rows are keyed state|ahj|utility and
// code profiles state|ahj, so the card finds its AHJ's own code-profile row by state + AHJ name
// (exact, case-insensitive — a name match would put one city's criteria on another's card).
function codeProfileForKb(kbProfile, codeProfiles) {
  const st = String(kbProfile?.state || "").trim().toUpperCase();
  const ahj = String(kbProfile?.ahj || "").trim().toLowerCase();
  if (!st || !ahj) return null;
  return (codeProfiles || []).find((c) => String(c.state || "").trim().toUpperCase() === st && String(c.ahj || "").trim().toLowerCase() === ahj) || null;
}

const KB_CRITERIA_LABELS = {
  "designCriteria.groundSnowLoadPsf": ["Ground snow load", " psf"],
  "designCriteria.groundSnowLoadAsdPsf": ["Ground snow load pg(asd) (allowable-stress, not Pg)", " psf"],
  "designCriteria.windSpeedMph": ["Design wind speed (ultimate)", " mph"],
  "designCriteria.windExposure": ["Wind exposure", ""],
  "designCriteria.specialWindRegion": ["Special wind region", ""],
  "designCriteria.seismicDesignCategory": ["Seismic design category", ""],
  "designCriteria.frostDepthIn": ["Frost depth", " in"],
  "prescriptive.maxAttachmentSpacingIn": ["Max attachment spacing", " in o.c."],
  "prescriptive.listingEvidenceRequired": ["Module / racking UL listing evidence required", ""],
};
const KB_OBSERVED_LABELS = { groundSnowPsf: ["ground snow", " psf"], windSpeedMph: ["wind", " mph"], windExposure: ["Exposure", ""], riskCategory: ["Risk Category", ""] };

// Pure (lifted by jurisdictionProposalRender.test.ts): the learned design criteria WITH WHERE EACH
// CAME FROM — an AHJ correction (its id and record), a cited lookup, or seeded research/import —
// and whether a person verified the row; then the approved designs issued there (aggregate only).
// The AHJ's quoted sentence is NOT shown: this list is shared across tenants.
function kbDesignCriteriaHtml(codeProfile) {
  if (!codeProfile) return "";
  const verified = codeProfile.confidence === "verified";
  const cites = Array.isArray(codeProfile.citations) ? codeProfile.citations : [];
  const show = (v, unit) => (typeof v === "boolean" ? (v ? "Yes" : "No") : `${v}${unit}`);
  const rows = [];
  for (const [field, [label, unit]] of Object.entries(KB_CRITERIA_LABELS)) {
    const [block, key] = field.split(".");
    const v = (codeProfile[block] || {})[key];
    if (v === undefined || v === null || v === "") continue;
    const c = cites.filter((x) => x && x.field === field).pop();
    const day = (s) => String(s || "").slice(0, 10);
    // The shared row names no correction or record (they are one org's project data): the source
    // is "an AHJ plan-review correction" and its date.
    const from = c && c.kind === "ahj_correction"
      ? `AHJ plan-review correction${c.at ? `, ${day(c.at)}` : ""}`
      : c && c.kind === "design_criteria_research"
        ? `design-criteria lookup${c.at ? `, ${day(c.at)}` : ""}${c.sourceUrl ? ` (${c.sourceUrl})` : ""}`
        : verified ? "entered at verification" : "seeded research / import";
    rows.push(`<li>${esc(label)}: <strong>${esc(show(v, unit))}</strong> <span class="muted">— ${esc(from)}</span></li>`);
  }
  const obs = Array.isArray(codeProfile.approvedDesignSummary) ? codeProfile.approvedDesignSummary : [];
  const obsText = obs.map((o) => {
    const [label, unit] = KB_OBSERVED_LABELS[o.criterion] || [o.criterion, ""];
    return `${label} ${o.value}${unit} (${o.count} issued permit${o.count === 1 ? "" : "s"}${o.lastIssuedAt ? `, latest ${String(o.lastIssuedAt).slice(0, 10)}` : ""})`;
  });
  if (!rows.length && !obsText.length) return "";
  const badge = verified
    ? `<span class="badge badge-pass">Verified${codeProfile.verifiedBy ? ` by ${esc(codeProfile.verifiedBy)}` : ""}</span>`
    : `<span class="badge">Seeded — verify locally</span>`;
  return `<div style="margin-top:4px;font-size:12px"><strong>Code profile design criteria</strong> ${badge}
      ${rows.length ? `<ul style="margin:2px 0 0 16px;padding:0">${rows.join("")}</ul>` : `<p class="muted" style="margin:2px 0">No design criteria on file.</p>`}
      ${obsText.length ? `<p style="margin:2px 0" class="muted">Approved designs used: ${esc(obsText.join("; "))} — corroboration, not the jurisdiction's rule.</p>` : ""}
    </div>`;
}

// Notes are " | "-joined segments. Dedupe (older DBs may still carry repeats)
// and render one bullet per segment instead of a wall of text.
// SHARED KNOWLEDGE IS SHOWN TO EVERY TENANT, and the imported reference rows still carry the
// importer's "[REDACTED_PHONE]" placeholders ("Combo Permit Call [REDACTED_PHONE] for fees").
// Stripped HERE, at render — the stored rows are shared data and are not rewritten from the UI.
// A segment that was only a placeholder disappears; the punctuation around one is tidied.
// ONE place strips them (lifted by name into tests, so the scrub lives inside): pass
// { segmentsOnly: true } to get the cleaned, de-duplicated segments instead of HTML.
function kbNotesHtml(notes, opts) {
  const scrubRedacted = (text) => {
    const M = '@@R@@';
    // Only a segment that carries a placeholder is tidied: the punctuation cleanup below cut the
    // trailing "-" off a checklist URL and a leading "- " off a list in token-free notes.
    if (!/\[REDACTED_[A-Z]+\]/.test(String(text ?? ''))) return String(text ?? '').trim();
    return String(text ?? '')
      .replace(/(?:1-)?\[REDACTED_[A-Z]+\](?:[-.]\[REDACTED_[A-Z]+\])*/g, M)
      .replace(/\(\s*@@R@@\s*\)/g, '')
      .replace(/\(\s*@@R@@\s*,?\s*(?=\()/g, '')
      .replace(/\(\s*@@R@@\s*,?\s*/g, '(')
      .replace(/\s*[-–:]?\s*@@R@@/g, ' ')
      .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\(\)/g, '')
      .replace(/\s+([,.;])/g, '$1')
      .replace(/([,;])(?=[,;.])/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s\-–,;:.]+|[\s\-–,;:(]+$/g, '');
  };
  const seen = new Set();
  const segs = String(notes ?? "").split(" | ").map((s) => scrubRedacted(s)).filter((s) => {
    if (!s || seen.has(s.toLowerCase())) return false;
    seen.add(s.toLowerCase());
    return true;
  });
  if (opts && opts.segmentsOnly) return segs;
  if (!segs.length) return "";
  if (segs.length === 1) return `<p style="margin:4px 0;font-size:12px;color:var(--muted)">${esc(segs[0])}</p>`;
  return `<div style="margin-top:4px;font-size:12px;color:var(--muted)"><strong>Notes:</strong><ul style="margin:2px 0 0 16px;padding:0">${segs.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`;
}

const KB_PAGE_SIZE = 20;

// A profile is "meaningful" if it carries real signal. The mbox importer produces
// many junk AHJ names (sentence fragments), so by default we only surface profiles
// with projects, multiple corrections, or an official/reference source. Search
// looks across everything.
function kbIsMeaningful(p) {
  if (p.projectCount > 0) return true;
  if (p.correctionCount >= 2) return true;
  if ((p.sources || []).some((s) => ["official", "sanitized_reference"].includes(s.sourceType))) return true;
  // Drop obvious junk AHJ names (long sentence fragments from email subjects).
  const ahj = p.ahj || "";
  if (ahj.length > 34 || /\b(your|this|the sender|originated|notification|will be|has been)\b/i.test(ahj)) return false;
  return p.correctionCount >= 1;
}

function renderKnowledgeBase() {
  const container = $("knowledgeBase");
  if (!container) return;
  const profiles = state.knowledgeProfiles || [];
  const summaryEl = $("kbSummaryCount");

  if (!profiles.length) {
    if (summaryEl) summaryEl.textContent = "";
    container.innerHTML = `<p class="muted">No knowledge profiles yet. Import mbox data or run a batch PDF scan to start learning.</p>`;
    return;
  }

  const totalCorrections = profiles.reduce((n, p) => n + p.correctionCount, 0);
  if (summaryEl) summaryEl.textContent = `${profiles.length} profiles · ${totalCorrections} corrections`;

  const query = (state.kbSearch || "").trim().toLowerCase();
  const sorted = [...profiles].sort((a, b) =>
    (b.projectCount - a.projectCount) || (b.correctionCount - a.correctionCount) || a.state.localeCompare(b.state),
  );

  let matches;
  if (query) {
    matches = sorted.filter((p) =>
      [p.state, p.ahj, p.utility, p.portalName].filter(Boolean).join(" ").toLowerCase().includes(query),
    );
  } else {
    matches = sorted.filter(kbIsMeaningful);
  }

  const limit = state.kbRenderLimit || KB_PAGE_SIZE;
  const shown = matches.slice(0, limit);

  let html = "";
  if (!matches.length) {
    html = `<p class="muted">No profiles match "${esc(query)}".</p>`;
  } else {
    if (!query) {
      html += `<p class="muted" style="font-size:12px;margin:0 0 6px">Showing ${shown.length} of ${matches.length} key profile(s). Search to find any of the ${profiles.length} total.</p>`;
    }
    html += shown.map(renderKnowledgeProfile).join("");
    if (matches.length > shown.length) {
      html += `<button type="button" id="kbShowMore" class="secondary" style="font-size:12px;margin-top:6px">Show ${Math.min(KB_PAGE_SIZE, matches.length - shown.length)} more (${matches.length - shown.length} left)</button>`;
    }
  }
  container.innerHTML = html;

  const moreBtn = $("kbShowMore");
  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      state.kbRenderLimit = (state.kbRenderLimit || KB_PAGE_SIZE) + KB_PAGE_SIZE;
      renderKnowledgeBase();
    });
  }
}

async function selectProject(projectId) {
  // A DIFFERENT project must never inherit the last one's answers: a failed next-step fetch on
  // project B would otherwise leave project A's banner (and its Stage/Approve verdicts) up.
  if (state.nextStepProjectId !== projectId) { state.nextStep = null; state.nextStepProjectId = null; }
  // Same for the autopilot rail: its buttons, badge, reasons and banners are PAINTED state, so
  // nulling state.autopilot alone left project A's enabled Stage / reasons on screen for B
  // until (and, if B's fetch failed, after) B's own answer arrived.
  if (state.selectedProjectId !== projectId || (state.autopilot && state.autopilot.projectId !== projectId)) resetAutopilotRail();
  state.selectedProjectId = projectId;
  state.detail = await api(`/api/projects/${projectId}`);
  state.workflow = null;
  state.applicationDocs = null;
  state.filledForms = null;
  state.reviewerReport = null;
  state.historicalReport = null;
  state.opsPlan = null;
  state.opsBrief = null;
  state.handoffPacket = null;
  state.communicationDrafts = null;
  state.runbook = null;
  state.liveReadiness = null;
  state.projectTimeline = null;
  state.processMap = null;
  state.installerPacket = null;
  state.submitGate = null;
  state.staleReadings = null;
  state.recheckTargetId = null;
  state.submittalTracks = null;
  state.paymentQuotes = null;
  state.feeReceipts = [];
  state.feeSheet = null;
  state.portalQuestions = null;
  $("emptyState").hidden = true;
  $("detailView").hidden = false;
  clearMessage();
  // Navigate to the per-project workflow page (deep-linkable). showPage runs via
  // the hashchange handler; call it directly too in case the hash is unchanged.
  if (window.location.hash !== `#/project/${projectId}`) {
    window.location.hash = `#/project/${projectId}`;
  }
  showPage("project");
  renderProjects();
  safeRender("opsActions", renderOpsActions);
  // allSettled (not all): one failing/​flaky panel loader must NOT abort the others
  // or prevent renderDetail from running — otherwise the whole detail view breaks.
  await Promise.allSettled([
    loadKnowledgeBase(),
    loadOpsPlan(), loadSubmitGate(), loadRunbook(), loadHandoffPacket(),
    loadCommunicationDrafts(), loadLiveReadiness(), loadProjectTimeline(),
    loadProcessMap(), loadInstallerPacket(), loadProjectDocuments(),
    loadSubmittalTracks(), loadPaymentQuotes(), loadFeeSheet(), loadPortalQuestions(),
    loadStageResults(),
    loadStaleReadings(),
    loadNextStep(projectId),
  ]);
  renderDetail();
  // THE FORMS FOUND BEFORE STAY ON SCREEN (operator 09-27: "the files that it finds don't stay if you
  // leave the project and come back"). Opening a project reset the packet + filled-forms card to empty
  // until Build / Find was clicked again, though the forms were stored all along. Load them in the
  // background — the same call Build makes — and repaint only if this project is still the one open.
  void (async () => {
    try {
      const docs = await api(`/api/projects/${projectId}/application-docs`);
      if (state.selectedProjectId !== projectId || state.applicationDocs) return;
      state.applicationDocs = docs;
      const filled = await api(`/api/projects/${projectId}/filled-forms`, { method: "POST", body: "{}" });
      if (state.selectedProjectId !== projectId || state.filledForms) return;
      state.filledForms = filled;
      renderDetail();
    } catch { /* the Build / Find buttons still work; nothing to show yet */ }
  })();
}

// THE ONE ANSWER to "what does this project need next, and from whom" — computed on the
// server (backend/src/nextStep.ts, full tier: includes the submit gate). The banner renders
// it; if this fetch fails the banner falls back to the board's compact answer, then to the
// old status table (renderNextStep) — never blank, never another project's answer.
async function loadNextStep(projectId) {
  try {
    const { nextStep } = await api(`/api/projects/${projectId}/next-step`);
    if (nextStep && nextStep.key && state.selectedProjectId === projectId) {
      state.nextStep = nextStep;
      state.nextStepProjectId = projectId;
    }
    // The board card for this project shows the same full answer.
    rememberGateAnswer(projectId, nextStep);
  } catch { /* the banner falls back — see renderNextStep */ }
}

function renderHandoffBanner() {
  const { project, projectNotes } = state.detail;
  let banner = $("handoffBanner");
  if (!banner) return;
  if (project.status !== "handoff_ready") { banner.hidden = true; return; }
  const handoffNote = (projectNotes || []).find((n) => n.noteType === "handoff");
  banner.hidden = false;
  banner.innerHTML = `
    <div class="handoff-banner-head">
      <span>✓ Permit Issued + NEM Approved — Ready for installer handoff</span>
    </div>
    ${handoffNote ? `<pre class="handoff-checklist">${esc(handoffNote.body)}</pre>` : ""}
  `;
}

// --- Per-submission payment screen (start of the flow) ----------------------
// Quote = real permit fees (portal-calculated actual > learned per-AHJ history >
// valuation estimate) + the client's service fee. Staging is blocked for
// per-submission clients until each track's payment is marked paid or waived.
async function loadPaymentQuotes() {
  const id = state.selectedProjectId;
  const [permit, nem] = await Promise.all([
    api(`/api/projects/${id}/payment-quote?track=permit`),
    api(`/api/projects/${id}/payment-quote?track=nem`),
  ]);
  state.paymentQuotes = { permit: permit.quote, nem: nem.quote };
  state.feeReceipts = permit.receipts || [];
}

function money(v) {
  return v == null ? "—" : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const FEE_SOURCE_LABELS = {
  actual: "portal-calculated (real fee)",
  portal_record: "read from the portal record (automatic, not person-checked)",
  published_schedule: "published fee schedule",
  learned_history: "learned from past submissions here",
  valuation_estimate: "estimate from valuation",
  unknown: "unknown — enter the portal fee",
};

function renderPaymentQuoteCard(quote) {
  const p = quote.payment;
  const status = p?.status === "paid" ? "paid" : p?.status === "waived" ? "waived" : "unpaid";
  const tone = status === "paid" ? "pass" : status === "waived" ? "info" : "warning";
  const trackLabel = quote.track === "nem" ? "NEM / interconnection" : "Permit (AHJ)";
  return `
    <article class="item ${tone}" style="margin-bottom:8px">
      <div class="item-title"><span>${esc(trackLabel)} submission</span>${statusBadge(status)}</div>
      <table style="font-size:12px;margin:4px 0;border-collapse:collapse">
        <tr><td style="padding:1px 14px 1px 0">Permit fees</td><td style="text-align:right"><strong>${money(quote.permitFeeUsd)}</strong></td>
            <td style="padding-left:10px" class="muted">${esc(FEE_SOURCE_LABELS[quote.permitFeeSource] || "")}</td></tr>
        <tr><td style="padding:1px 14px 1px 0">Our service fee</td><td style="text-align:right"><strong>${money(quote.serviceFeeUsd)}</strong></td><td></td></tr>
        <tr style="border-top:1px solid var(--border)"><td style="padding:3px 14px 1px 0"><strong>Client total</strong></td><td style="text-align:right"><strong>${money(quote.totalUsd)}</strong></td><td></td></tr>
      </table>
      <p class="muted" style="margin:2px 0;font-size:11px">${esc(quote.permitFeeBasis || "")}</p>
      ${status === "paid" ? `<p style="margin:2px 0;font-size:12px">Paid ${p.paidAt ? new Date(p.paidAt).toLocaleString() : ""}${p.paymentReference ? ` — ref: ${esc(p.paymentReference)}` : ""}</p>` : ""}
      ${status !== "paid" ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px">
          <input id="payFee-${quote.track}" type="number" min="0" step="0.01" placeholder="Actual portal fee $" style="width:150px;font-size:12px;padding:4px 8px" title="The real fee the portal calculated on its fee/review screen — replaces the estimate and teaches future quotes for this AHJ.">
          <button class="secondary" style="font-size:12px" data-pay-action="record-fee" data-pay-track="${quote.track}">Record real fee</button>
          <input id="payRef-${quote.track}" placeholder="Payment reference (invoice #, Stripe id…)" style="width:220px;font-size:12px;padding:4px 8px">
          <button style="font-size:12px" data-pay-action="mark-paid" data-pay-track="${quote.track}">✓ Mark paid</button>
          <button class="secondary" style="font-size:12px" data-pay-action="waive" data-pay-track="${quote.track}" title="Skip the gate for this submission (comped / billed elsewhere).">Waive</button>
        </div>` : ""}
    </article>`;
}

function renderPaymentPanel() {
  const panel = $("paymentPanel");
  if (!panel) return;
  const quotes = state.paymentQuotes;
  const list = quotes ? [quotes.permit, quotes.nem].filter(Boolean) : [];
  // Only per-submission clients see the payment screen (plus anyone with an
  // existing paid/waived row, so history stays visible if the mode changes).
  const visible = list.filter((q) => q.required || (q.payment && q.payment.status !== "quoted"));
  // Recorded receipts render inside the fee panel now (renderFeeSheetPanel) —
  // they were a second table restating the same money 36px above it.
  if (!visible.length) { panel.hidden = true; panel.innerHTML = ""; return; }
  const unpaid = visible.filter((q) => q.required && q.payment?.status !== "paid" && q.payment?.status !== "waived");
  panel.hidden = false;
  panel.innerHTML = `
    ${visible.length ? `<section class="panel kx-callout-panel ${unpaid.length ? "is-warn" : ""}">
      <div class="item-title" style="margin-bottom:6px">
        <span>💳 Payment — per-submission billing</span>
        ${statusBadge(unpaid.length ? "payment required before staging" : "cleared")}
      </div>
      ${unpaid.length ? `<p style="margin:0 0 8px;font-size:12px">This client pays per submission: collect the total below, then <strong>Mark paid</strong> to unlock <em>3 · Prepare Submittal</em>. Enter the portal's real fee when you see it on the fee/review screen — it replaces the estimate and is remembered for this AHJ. <span class="muted">The portal's own fee checkout is always completed by a human, never automated.</span></p>` : ""}
      ${visible.map(renderPaymentQuoteCard).join("")}
    </section>` : ""}`;
  panel.querySelectorAll("[data-pay-action]").forEach((btn) => {
    btn.addEventListener("click", () => handlePaymentAction(btn.dataset.payAction, btn.dataset.payTrack, btn));
  });
}

async function handlePaymentAction(action, track, btn) {
  const id = state.selectedProjectId;
  if (!id) return;
  const body = { track };
  if (action === "record-fee" || action === "mark-paid") {
    const feeEl = $(`payFee-${track}`);
    if (feeEl && feeEl.value) body.actualPermitFeeUsd = feeEl.value;
    if (action === "record-fee" && (!feeEl || !feeEl.value)) { showMessage("Enter the portal-calculated fee first.", "warning"); return; }
  }
  if (action === "mark-paid") {
    const refEl = $(`payRef-${track}`);
    if (refEl) body.paymentReference = refEl.value;
  }
  btn.disabled = true;
  try {
    const path = action === "record-fee" ? "record-fee" : action === "waive" ? "waive" : "mark-paid";
    const res = await api(`/api/projects/${id}/payment/${path}`, { method: "POST", body: JSON.stringify(body) });
    state.paymentQuotes = { ...(state.paymentQuotes || {}), [res.quote.track]: res.quote };
    renderPaymentPanel();
    if (action === "mark-paid") showMessage(`Payment recorded — ${res.quote.track} staging unlocked.`);
  } catch (err) {
    showMessage(`Payment update failed: ${err.message}`, "error");
    btn.disabled = false;
  }
}

// What the automatic build/verify chain already produced. These three panels used to be
// filled only by clicking their buttons, so a project the chain had carried to
// ready_to_stage opened with every one of them reading "not run". A step that never ran
// comes back null and still reads "not run". A button result from this session wins.
async function loadStageResults() {
  const id = state.selectedProjectId;
  const res = await api(`/api/projects/${id}/stage-results`);
  if (state.selectedProjectId !== id) return;
  if (!state.applicationDocs && res.applicationDocs) state.applicationDocs = res.applicationDocs;
  if (!state.reviewerReport && res.reviewerReport) state.reviewerReport = res.reviewerReport;
  if (!state.historicalReport && res.historicalReport) state.historicalReport = res.historicalReport;
}

// --- Fee sheet: what this job costs, and where each number came from ---------
//
// Distinct from the payment panel above. That one is the per-submission BILLING gate and
// appears only for clients invoiced per submission; this one is the money FACTS, and every
// project has them. The live database's only client bills monthly, so without this panel the
// dashboard shows an operator no fee at all.
//
// THE RULE THIS PANEL EXISTS TO ENFORCE: somebody will quote a customer off this screen. So a
// number never appears without its provenance, a SEEDED fee (researched, unchecked) is drawn
// as provisional rather than merely annotated, and an unknown fee prints UNKNOWN — never
// $0.00, because zero is an answer and unknown is the absence of one.
async function loadFeeSheet() {
  const id = state.selectedProjectId;
  const res = await api(`/api/projects/${id}/fee-sheet`);
  state.feeSheet = res.feeSheet;
}

function feeMoney(v) {
  return v == null
    ? `<span class="badge badge-warning">UNKNOWN</span>`
    : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Fee-schedule URLs arrive from web research, so they are untrusted input: esc() stops markup
// but not a `javascript:` href. Only http(s) is ever turned into a link.
function httpUrl(value) {
  const raw = String(value ?? "").trim();
  return /^https?:\/\//i.test(raw) ? raw : "";
}

const FEE_SOURCE_TEXT = {
  actual: "the portal's own fee screen, entered by the operator",
  portal_record: "the portal's own record, read automatically",
  published_schedule: "the jurisdiction's published fee schedule",
  learned_history: "the median of real fees seen here before",
  valuation_estimate: "a percentage of the project valuation",
  unknown: "nowhere yet",
};

const FEE_CONFIDENCE = {
  actual: { badge: "badge-pass", label: "actual", note: "" },
  verified: { badge: "badge-pass", label: "verified", note: "" },
  seeded: {
    badge: "badge-warning",
    label: "provisional — not verified",
    note: "Research found this and nobody has checked it. Check it against the jurisdiction's own published schedule, then press Confirm fee, before quoting a customer.",
  },
  estimated: {
    badge: "badge-warning",
    label: "estimate",
    note: "A method, not a fact. Replace it with the portal-calculated fee from the fee/review screen.",
  },
  unknown: { badge: "badge-fail", label: "unknown", note: "" },
  // A SEEDED amount a machine re-read the cited schedule for and found printed there (the
  // server's `corroborated`). Not a confidence of its own — the rank, and the total's weakest-
  // line grade, stay "seeded" — and NEVER the word "verified": that is a person (hard rule 3).
  schedule_match: {
    badge: "badge-info",
    label: "matches the published schedule",
    note: "A machine re-read the cited schedule and found this line printed in it. No person has confirmed it yet — Confirm it once you have looked.",
  },
  // The portal's own number, READ AUTOMATICALLY off the filed record by the permit monitor. It
  // is the portal's figure ("actual") and a machine read it — so never "verified".
  portal_read: {
    badge: "badge-pass",
    label: "actual — read from the portal",
    note: "The permit monitor read this off the portal's own record. A machine read it; no person has checked it.",
  },
};

// WHICH FEE_CONFIDENCE ENTRY A LINE WEARS — the one predicate the card and the folded
// summary both ask, so "matches the published schedule" cannot appear in one and not the other.
function feeConfidenceKey(line) {
  if (line && line.confidence === "actual" && line.source === "portal_record") return "portal_read";
  if (line && line.confidence === "seeded" && line.corroborated === true) return "schedule_match";
  return line && FEE_CONFIDENCE[line.confidence] ? line.confidence : "unknown";
}

// `portal` deliberately does NOT restate the human-checkout safety rule — the
// panel lede directly above every line already carries it, and stating it twice
// 40px apart was measured noise. `mailed_check` and `unknown` are honesty
// content and stay verbatim: "not recorded" must never collapse into silence.
const FEE_PAYMENT_METHOD = {
  portal: "Paid in the portal.",
  mailed_check: "Paid by MAILED PAPER CHECK. No portal can take it; somebody posts it.",
  none: "No fee is charged, so there is nothing to pay.",
  unknown: "How this is paid is not recorded.",
};

// ONE FILING IS NOT ONE CHARGE.
//
// The operator's own paid City of Portland receipt for a 3.5 kW rooftop system is
// FOUR BILLS FROM THREE BUREAUS totalling $762.93: a $50 fire plan review, a $217
// land use review, a $99.45 building plan review/processing charge, and two permits
// at $201 and $153 each carrying a 12% state surcharge. Two of those seven charges are
// permits — so a card that draws only the permit is hiding more than half the bill,
// and it hides it behind a number that looks finished.
//
// Drawn ONLY where a jurisdiction charges more than its permits. Every row in the
// table today publishes a permit line and nothing else, and those cards are
// unchanged: a breakdown that appeared on every fee would be noise on the ones it
// cannot help, which is how the case that needs it stops being read.
//
// AN UNPRICED CHARGE KEEPS ITS ROW AND SAYS SO. It is the reason the total above it
// is UNKNOWN; dropping it would leave a blank total with nothing explaining it, and
// listing it with a plausible number beside its neighbours would be worse still.
// esc() on every field — labels, quotes and reasons are all research output.
//
// AND WHICH TIER PUT THE NUMBER ABOVE DECIDES WHAT THIS LIST MAY CLAIM.
//
// The charges are resolved from the published schedule for EVERY quote, on purpose
// — what a Portland filing is made of is a fact about the jurisdiction, not about
// where the amount came from. But the quote ladder prefers an operator-entered
// portal actual first, then a learned median, and only then the schedule. So on a
// filing where the operator typed the portal's $812.40 and the schedule's charges
// sum to $762.93, this card printed "Sum of every charge — $762.93" directly under
// $812.40: a false claim, and a $49.47 gap that reads as an arithmetic slip in the
// itemisation rather than as two measurements of the same filing.
//
// The list stays. The CLAIM is withdrawn, keyed on `line.source` — the field the
// engine already sets beside the amount. The withdrawn wording points at the
// provenance block below rather than naming the source itself, because this
// function may reference NOTHING beyond esc(), feeMoney() and its own argument:
// backend/test/feeFilingCharges.test.ts lifts this exact source out of the shipped
// file and runs it with only those two in scope, which is what makes that a test of
// the renderer instead of a copy of it. A module-level lookup here would throw.
function renderFeeCharges(line) {
  const charges = Array.isArray(line.charges) ? line.charges : [];
  if (!charges.some((c) => c && !c.partOfLineFee)) return "";
  const priced = charges.filter((c) => c.amountUsd != null);
  const complete = priced.length === charges.length;
  const feeIsTheSchedule = line.source === "published_schedule";
  // An overage charge (futureContingent) is NOT an unresolved one — the CLI
  // (scripts/fee-sheet.ts) already splits them: UNRESOLVED means "we could not
  // price a charge this filing WILL incur"; IF IT HAPPENS means "charged only
  // if it happens, not in this quote". Blurring them let a reinspection fee
  // read as a hole in the quote.
  const rows = charges.map((c) => `
    <tr${c.amountUsd == null ? ` class="is-warn"` : ""}>
      <td style="padding:1px 12px 1px 0">${esc(c.label || "(unlabelled charge)")}${c.futureContingent ? ` <span class="badge badge-warning">IF IT HAPPENS</span> <span style="font-size:11px">(not in this quote)</span>` : c.conditional ? ` <span class="badge badge-warning">conditional</span>` : ""}</td>
      <td style="text-align:right;white-space:nowrap">${c.amountUsd == null ? (c.futureContingent ? `<span class="badge badge-warning">IF IT HAPPENS</span>` : `<span class="badge badge-warning">UNRESOLVED</span>`) : feeMoney(c.amountUsd)}</td>
    </tr>
    ${c.amountUsd == null && c.reason ? `<tr><td colspan="2" style="padding:0 0 4px;font-size:11px">${esc(c.reason)}</td></tr>` : ""}`).join("");
  // Incomplete is decided FIRST and outranks the tier question: an unpriced charge
  // claims no sum under any source, and nothing below may turn it into a confident one.
  const totalLabel = !complete
    ? "No total — a charge above is unpriced"
    : feeIsTheSchedule ? "Sum of every charge" : "What the published schedule holds";
  // The breakdown now ships CLOSED (it was 679px / 406 words on a permit card).
  // What ships closed may not take an unknown down with it, so the counts of
  // UNRESOLVED and IF-IT-HAPPENS charges are lifted into the summary, which is
  // on screen either way: the operator sees "6 charges — 2 UNRESOLVED — 1 IF IT
  // HAPPENS (not in this quote) — incomplete" without opening anything, and the
  // claim-withdrawal about WHOSE breakdown this is stays put.
  const contingent = charges.filter((c) => c && c.futureContingent).length;
  const unresolved = charges.filter((c) => c && c.amountUsd == null && !c.futureContingent).length;
  return `
    <details class="provenance">
      <summary>${esc(String(charges.length))} charges on this filing${unresolved
        ? ` — ${esc(String(unresolved))} UNRESOLVED`
        : ""}${contingent
        ? ` — ${esc(String(contingent))} IF IT HAPPENS (not in this quote)`
        : ""}${complete
        ? (feeIsTheSchedule ? "" : " — the published schedule's, not the fee above")
        : " — incomplete"}</summary>
      <div class="provenance-body">
        <table style="font-size:12px;border-collapse:collapse;width:100%">
          ${rows}
          <tr style="border-top:1px solid var(--border)">
            <td style="padding:3px 12px 1px 0"><strong>${esc(totalLabel)}</strong></td>
            <td style="text-align:right"><strong>${complete
              ? feeMoney(priced.reduce((sum, c) => sum + Number(c.amountUsd), 0))
              : `<span class="badge badge-warning">INCOMPLETE</span>`}</strong></td>
          </tr>
          ${complete && !feeIsTheSchedule ? `<tr><td colspan="2" style="padding:4px 0 0;font-size:11px">The fee above did NOT come from the published schedule — see “Where this number came from”. This list is the schedule's own breakdown of the filing, so a difference between the two is expected and is not an error in either.</td></tr>` : ""}
        </table>
      </div>
    </details>`;
}

// WHERE THE NUMBER CAME FROM, ON THE CARD'S FACE (new-AHJ e2e, gap 4).
//
// A fee with a number now shows its schedule line and source beside the number, not only one
// click away — the number is what gets quoted, so its source travels with it. And an UNKNOWN fee
// whose schedule IS on file (a tier or formula the job's own facts did not resolve — FirstEnergy
// "Level 2 - $250.00 + $1.00 per kW" with no system size yet) printed a bare UNKNOWN, with the
// reason and the schedule inside the closed provenance block: a stored answer read as "nothing
// found". The reason and the link are on the face now. Never a number: an unresolved schedule is
// still an unknown, and feeMoney() still prints UNKNOWN above this line.
function feeFaceSourceHtml(line) {
  const url = httpUrl(line.sourceUrl);
  const link = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(portalHostname(url) || url)}</a>` : "";
  if (line.feeUsd != null) {
    // The server sends the schedule's URL whichever tier won the amount (it is a fact about the
    // jurisdiction). So the link joins "Source:" ONLY when the schedule IS the source; beside an
    // operator-entered actual, a learned median or an estimate it is drawn apart and says so —
    // "Source: the portal's own fee screen · venus.gov" would be a false provenance claim.
    const fromSchedule = line.source === "published_schedule";
    const parts = [
      fromSchedule && line.bracketLabel ? `line “${esc(line.bracketLabel)}”` : "",
      esc(FEE_SOURCE_TEXT[line.source] || line.source || ""),
      fromSchedule ? link : "",
    ].filter(Boolean);
    const aside = !fromSchedule && link ? ` <span class="muted">· Schedule on file: ${link} (not the source of this number)</span>` : "";
    return parts.length || aside ? `<p class="fee-face-source" style="margin:2px 0;font-size:12px">${parts.length ? `Source: ${parts.join(" · ")}` : ""}${aside}</p>` : "";
  }
  const basis = String(line.basis || "").trim();
  if (!url && !basis) return "";
  return `<p class="fee-face-source" style="margin:2px 0;font-size:12px">${url
    ? `<strong>Schedule on file — not resolved for this job:</strong> ${link}. `
    : ""}${basis ? `Why unknown: ${esc(basis)}` : ""}</p>`;
}

// THE PORTAL'S FIGURE BESIDE THE RESEARCHED ONE — both numbers and the gap, never a silent
// swap. `shown` says which of the two the card's amount is: a portal read that is partial (not
// every filed record read) or a lower bound (a record still in review, below research) is drawn
// here and the amount above stays the researched figure. Every value escaped.
function feeComparisonHtml(line) {
  const c = line && line.comparison;
  if (!c || c.portalUsd == null) return "";
  const fmt = (v) => `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const portalWhat = c.portalSource === "portal_record" ? "Portal record, read automatically" : "Portal fee, entered by the operator";
  const gap = c.differenceUsd == null
    ? ""
    : Math.abs(Number(c.differenceUsd)) < 0.005
      ? " — the same as researched"
      : ` — ${fmt(Math.abs(Number(c.differenceUsd)))} ${Number(c.differenceUsd) > 0 ? "more" : "less"} than researched`;
  const researchedWhat = FEE_SOURCE_TEXT[c.researchedSource] || c.researchedSource || "research";
  return `<div class="fee-compare" style="margin:4px 0;font-size:12px">
      <div>${esc(portalWhat)}: <strong>${esc(fmt(c.portalUsd))}</strong>${esc(gap)}${c.shown === "researched" ? ` <span class="badge badge-warning">not the amount above</span>` : ""}</div>
      <div>Researched: ${c.researchedUsd == null ? "unknown" : esc(fmt(c.researchedUsd))} <span class="muted">(${esc(researchedWhat)})</span></div>
      ${c.note ? `<div>${esc(c.note)}</div>` : ""}
    </div>`;
}

// WHAT THE PERMIT MONITOR READ OFF EACH FILED RECORD, one click away: the invoices it saw, when,
// and — for a record it could not read — why (never a $0).
function feePortalRecordsHtml(line) {
  const s = line && line.portalRecords;
  if (!s || !Array.isArray(s.records) || (!s.records.length && !(s.unread || []).length)) return "";
  const fmt = (v) => `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const readRows = s.records.filter((r) => r && r.status === "read").map((r) => `<li>${esc(r.recordNumber || "(no number)")}${r.jurisdiction ? ` — ${esc(r.jurisdiction)}` : ""}: ${esc(fmt(r.totalUsd))} invoiced`
    + `${r.paidUsd != null ? `, ${esc(fmt(r.paidUsd))} paid` : ""}${r.outstandingUsd ? `, ${esc(fmt(r.outstandingUsd))} outstanding` : ""}`
    + ` · read ${esc(String(r.readAt || "").slice(0, 10))}${r.final ? "" : " · the record is not issued yet, so more may be invoiced"}`
    + `${Array.isArray(r.lines) && r.lines.length ? `<ul>${r.lines.map((l) => `<li>${esc(l.label)} ${esc(l.date || "")}: ${esc(fmt(l.amountUsd))} (${esc(l.status)})</li>`).join("")}</ul>` : ""}</li>`);
  const unreadRows = (s.unread || []).map((u) => `<li>${esc(u.recordNumber || u.jurisdiction || "a filed record")}: not read — ${esc(u.reason || "not read yet")}</li>`);
  const readCount = readRows.length;
  return `<details class="provenance fee-portal-records">
      <summary>Read from the portal: ${esc(String(readCount))} of ${esc(String(readCount + unreadRows.length))} filed record${readCount + unreadRows.length === 1 ? "" : "s"}</summary>
      <div class="provenance-body"><ul style="margin:2px 0;padding-left:18px">${[...readRows, ...unreadRows].join("")}</ul></div>
    </details>`;
}

function renderFeeSheetLine(line) {
  const confKey = feeConfidenceKey(line);
  const conf = FEE_CONFIDENCE[confKey];
  // The printed schedule line behind a matched amount, on the card's face beside the number.
  const matchEvidence = confKey === "schedule_match" && line.evidenceQuote
    ? `<p class="fee-face-evidence" style="margin:2px 0;font-size:12px">Printed in the schedule as: “${esc(line.evidenceQuote)}”</p>`
    : "";
  // WHERE A PORTAL-READ AMOUNT CAME FROM, on the face: which record(s), and when.
  const portalProvenance = confKey === "portal_read" && line.portalRecords && line.portalRecords.provenance
    ? `<p class="fee-face-provenance" style="margin:2px 0;font-size:12px">The portal's own fee, ${esc(line.portalRecords.provenance)}${line.portalRecords.final ? "" : " — invoiced so far; more may be invoiced before the permit is issued"}.</p>`
    : "";
  // WHO VOUCHED — beside a person-verified schedule amount only. The server sends the NAME only
  // to the org whose person confirmed it (a person's identity is not shared knowledge); every
  // other org reads "Human-verified" and the date.
  const verifiedNote = line.confidence === "verified" && line.source === "published_schedule"
    ? `<p class="fee-face-verified" style="margin:2px 0;font-size:12px">${line.verifiedBy ? `Verified by ${esc(line.verifiedBy)}` : "Human-verified"}${line.verifiedAt ? ` on ${esc(String(line.verifiedAt).slice(0, 10))}` : ""} against the published schedule.</p>`
    : "";
  // THE ONE-CLICK CONFIRM, only where the server says a person may (a researched published-
  // schedule amount). The click asks who is confirming before anything is written.
  const confirmControl = line.confirmable === true
    ? `<p class="fee-confirm" style="margin:4px 0"><button class="secondary" style="font-size:12px" data-fee-confirm="${esc(line.track)}" title="Mark the brackets and amounts on this card as verified by you — only those. Automation never changes a schedule a person has verified.">Confirm fee — I checked it against the published schedule</button></p>`
    : "";
  // Provisional and unknown fees carry the warning tone, so the card LOOKS unfinished.
  // Keyed on "is there a number" rather than `known`: an ESTIMATE is known:false now
  // (an estimate is not knowledge) but it still has a figure to act on — it warns, it
  // does not block. Blocker stays for the line with no number at all.
  const tone = line.confidence === "actual" || line.confidence === "verified" ? "pass" : line.feeUsd != null ? "warning" : "blocker";
  // "Utility interconnection", not "NEM": Oncor and SRP jobs have no utility net metering, and the
  // fee is the interconnection application's either way (new-AHJ e2e gap 3).
  const trackLabel = line.track === "nem" ? "Utility interconnection" : "Permit (AHJ)";
  const url = httpUrl(line.sourceUrl);
  return `
    <article class="item ${tone}" style="margin-bottom:8px">
      <div class="item-title">
        <span>${esc(trackLabel)} — ${esc(line.jurisdiction || "jurisdiction not set")}</span>
        <span class="badge ${conf.badge}">${esc(conf.label)}</span>
      </div>
      <p style="margin:2px 0;font-size:19px;font-weight:700">${feeMoney(line.feeUsd)}${line.paymentMethod === "none" && line.feeUsd != null
        ? `<span style="font-size:12px;font-weight:400"> — no fee charged</span>`
        : ""}</p>
      ${line.paymentMethod === "none" && line.feeUsd != null
        // A zero line folds "nothing to pay" into the amount row above. The other
        // three methods keep their own sentence INLINE — mailed_check and unknown
        // are how-this-gets-paid facts an operator must see without a click.
        ? ""
        : `<p style="margin:2px 0;font-size:12px">${esc(FEE_PAYMENT_METHOD[line.paymentMethod] || line.paymentMethod || "")}</p>`}
      ${feeFaceSourceHtml(line)}
      ${matchEvidence}
      ${portalProvenance}
      ${verifiedNote}
      ${feeComparisonHtml(line)}
      ${confirmControl}
      ${renderFeeCharges(line)}
      ${feePortalRecordsHtml(line)}
      <!-- The amount and how it is paid drive action, so they stay loud. Where
           the number came from is the product's core claim and is kept in full —
           one click away, not competing with the number itself. The confidence
           SENTENCE moved in here too: the chip beside the amount already says
           PROVISIONAL — NOT VERIFIED / ESTIMATE inline, and stays. -->
      <details class="provenance">
        <summary>Where this number came from</summary>
        <div class="provenance-body">
          <p>From ${esc(FEE_SOURCE_TEXT[line.source] || line.source)} — ${esc(line.basis || "")}</p>
          ${conf.note ? `<p><strong>⚠ ${esc(conf.note)}</strong></p>` : ""}
          <p><strong>Bracket:</strong> ${line.bracketLabel
            ? esc(line.bracketLabel)
            : `no schedule bracket resolved — the application's fee-quantity field cannot be computed from a schedule we do not have`}</p>
          <p><strong>Schedule:</strong> ${url
            ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`
            : `no source URL on file`}</p>
        </div>
      </details>
    </article>`;
}

function renderFeeSheetPanel() {
  // The container is created here rather than in dashboard.html so the panel ships with the
  // code that draws it. It sits directly under the payment panel, which is the other place
  // fees are discussed.
  let panel = $("feeSheetPanel");
  if (!panel) {
    const anchor = $("paymentPanel");
    if (!anchor) return;
    panel = document.createElement("div");
    panel.id = "feeSheetPanel";
    anchor.insertAdjacentElement("afterend", panel);
  }
  const sheet = state.feeSheet;
  const receipts = state.feeReceipts || [];
  // "Recorded receipt payments" used to be its own table directly ABOVE this
  // panel, restating the same money in a different frame. It is one row of THIS
  // panel now. Its caveat is a claim-limiting statement and survives the merge
  // verbatim and inline; only the per-receipt component table is one click away.
  // The total is only summed when every component has a recorded total — a sum
  // over holes would understate while looking finished.
  const receiptsSummable = receipts.length && receipts.every((r) => r.totalPaidUsd != null);
  const receiptsBlock = !receipts.length ? "" : `
      <p style="margin:6px 0 0;font-size:12px"><strong>Paid so far:</strong> ${receiptsSummable
        ? feeMoney(receipts.reduce((s, r) => s + Number(r.totalPaidUsd), 0))
        : `no total — a receipt component has no recorded amount`} across ${esc(String(receipts.length))} recorded receipt component${receipts.length === 1 ? "" : "s"}.
        <span class="muted">These are paid components. They do not establish the full permit cost or mark the current submission as paid.</span></p>
      <details class="provenance">
        <summary>Receipt components</summary>
        <div class="provenance-body">
          <table style="font-size:12px;border-collapse:collapse"><thead><tr><th style="text-align:left;padding-right:12px">Authority / permit</th><th style="text-align:right;padding-right:12px">Paid to authority</th><th style="text-align:right;padding-right:12px">Processing fee</th><th style="text-align:right">Total paid</th></tr></thead><tbody>
          ${receipts.map(r => `<tr><td style="padding-right:12px">${esc(r.jurisdiction)}<br>${esc(r.permitNumber || "Permit not matched")} · ${esc(r.discipline)}</td><td style="text-align:right;padding-right:12px">${money(r.authorityAmountUsd)}</td><td style="text-align:right;padding-right:12px">${money(r.processingFeeUsd)}</td><td style="text-align:right">${money(r.totalPaidUsd)}</td></tr>`).join("")}
          </tbody></table>
        </div>
      </details>`;
  if (!sheet || !Array.isArray(sheet.lines)) {
    // No fee sheet, but recorded receipts still render — money paid must not
    // disappear because the sheet could not be computed.
    if (!receipts.length) { panel.hidden = true; panel.innerHTML = ""; return; }
    panel.hidden = false;
    panel.innerHTML = `<section class="panel kx-callout-panel">
      <div class="item-title" style="margin-bottom:6px"><span>💵 Fees — permit and utility interconnection</span>${statusBadge("receipts only")}</div>
      ${receiptsBlock}
    </section>`;
    return;
  }
  const provisional = sheet.lines.filter((l) => l.confidence === "seeded" || l.confidence === "estimated");
  const anyUnknown = sheet.totalUsd == null;
  // Keyed on totalConfidence — computed by the backend BESIDE the sum — so the
  // marker cannot drift from the arithmetic it qualifies.
  const totalEstimated = !anyUnknown && sheet.totalConfidence === "estimated";
  // FOLDED TO ONE LINE, AND THE LINE CARRIES EVERY QUALIFIER. The panel was 486-537px on every
  // project and sat above the Next step. Closed, the summary still says, per track, the amount
  // AND its confidence ("provisional", "estimate", "UNKNOWN"), how many fees are still unknown,
  // and the human-checkout rule — an unknown must never read as a final number because the
  // detail is one click away. Plain text built from sheet fields, escaped.
  const foldMoney = (v) => (v == null ? "UNKNOWN" : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const FOLD_QUALIFIER = { actual: "actual", verified: "verified", seeded: "provisional", estimated: "estimate", unknown: "unknown", schedule_match: "matches published schedule", portal_read: "actual, read from portal" };
  const trackParts = sheet.lines.map((line) => {
    const name = line.track === "nem" ? "Utility" : "Permit";
    const q = FOLD_QUALIFIER[feeConfidenceKey(line)] || "unknown";
    // A schedule on file that did not resolve is still UNKNOWN — but it is not "nothing found".
    if (line.feeUsd == null) return `${name} UNKNOWN${httpUrl(line.sourceUrl) ? " (schedule on file, not resolved)" : ""}`;
    if (line.paymentMethod === "none") return `${name}: no fee expected (${q})`;
    return `${name} ${line.confidence === "estimated" ? "≈ " : ""}${foldMoney(line.feeUsd)} (${q})`;
  });
  const unknownCount = (sheet.unknowns || []).length;
  const totalPart = anyUnknown
    ? "total UNKNOWN — not final"
    : `total ${totalEstimated ? "≈ " : ""}${foldMoney(sheet.totalUsd)}${totalEstimated ? " (estimate)" : provisional.length ? " (provisional)" : ""}`;
  const foldParts = [...trackParts, totalPart];
  if (unknownCount) foldParts.push(`${unknownCount} still unknown`);
  if ((sheet.outOfPortalPayments || []).length) foldParts.push(`${sheet.outOfPortalPayments.length} not payable in a portal`);
  // Recorded receipts larger than the total is a contradiction the operator must see without
  // opening anything (7ec74634 showed "Paid so far" above the "Project total" with no word).
  const paidSum = receiptsSummable ? receipts.reduce((s, r) => s + Number(r.totalPaidUsd), 0) : null;
  const paidExceeds = paidSum != null && sheet.totalUsd != null && paidSum > Number(sheet.totalUsd) + 0.005;
  // Open by default only where money is actually the next thing: Submit/Track stage AND a
  // per-submission charge still unpaid. An operator's own open/close survives re-renders.
  const quotes = state.paymentQuotes ? [state.paymentQuotes.permit, state.paymentQuotes.nem].filter(Boolean) : [];
  const unpaidDue = quotes.some((q) => q.required && q.payment?.status !== "paid" && q.payment?.status !== "waived");
  const stageIdx = state.detail && Number.isInteger(state.detail.stageIndex) ? state.detail.stageIndex : 0;
  const prevFold = panel.querySelector("details.fee-fold");
  const pid = state.selectedProjectId || "";
  const openFold = prevFold && panel.dataset.projectId === pid ? prevFold.open : (stageIdx >= 2 && unpaidDue);
  panel.dataset.projectId = pid;
  panel.hidden = false;
  panel.innerHTML = `
    <section class="panel kx-callout-panel fee-panel ${anyUnknown || provisional.length ? "is-warn" : ""}">
      <details class="fee-fold"${openFold ? " open" : ""}>
      <summary class="fee-fold-summary">
        <span class="fee-fold-title">Fees</span>
        <span class="fee-fold-line">${esc(foldParts.join(" · "))}</span>
        <span class="fee-fold-rule">Checkout is always done by a person.</span>
        ${paidExceeds ? `<span class="fee-fold-alert">Recorded payments ${esc(foldMoney(paidSum))} exceed the ${esc(foldMoney(sheet.totalUsd))} total: re-check the portal fee screen.</span>` : ""}
      </summary>
      <div class="fee-fold-body">
      <div class="item-title" style="margin-bottom:6px">
        <span>💵 Fees — permit and utility interconnection</span>
        ${statusBadge(anyUnknown ? "incomplete" : provisional.length ? "provisional" : "known")}
      </div>
      <!-- Sentence one restated the heading directly above it ("Fees — permit and
           NEM") and was cut. Sentence two is NOT teaching copy: it is the fee half
           of hard rule 1, and it stays. -->
      <p class="muted" style="margin:0 0 8px;font-size:12px">
        The portal's own fee checkout is always completed by a person — never by automation.
      </p>
      ${sheet.lines.map(renderFeeSheetLine).join("")}
      ${feeReadPortalControlHtml()}
      <table class="fee-totals" style="font-size:12px;margin:4px 0;border-collapse:collapse;max-width:360px;width:100%">
        <tr><td style="padding:1px 14px 1px 0">Jurisdiction fees (permit + utility)</td><td style="text-align:right"><strong>${feeMoney(sheet.jurisdictionFeesUsd)}</strong></td></tr>
        <tr><td style="padding:1px 14px 1px 0">Our service fees${sheet.billingRequired ? " (per submission)" : ""}</td>
            <td style="text-align:right"><strong>${feeMoney(sheet.serviceFeesUsd)}</strong></td></tr>
        <tr style="border-top:1px solid var(--border)"><td style="padding:3px 14px 1px 0"><strong>Project total${totalEstimated ? " (estimate)" : ""}</strong></td>
            <td style="text-align:right"><strong>${totalEstimated ? "≈ " : ""}${feeMoney(sheet.totalUsd)}</strong></td></tr>
      </table>
      ${receiptsBlock}
      ${sheet.billingRequired ? "" : `
      <!-- The qualifying FACT ("not collected here") stays visible on the
           summary — without it the service-fee row reads as a quote — and the
           billing-mode explanation is the one click away. -->
      <details class="provenance">
        <summary>Service fees shown for reference — not collected here</summary>
        <div class="provenance-body"><p>This client is not billed per submission (billing mode ${esc(sheet.billingMode || "monthly / none")}), so the service fees above are shown for reference and are not collected here.</p></div>
      </details>`}
      ${anyUnknown ? `<p style="margin:6px 0 2px;font-size:12px"><strong>The total is UNKNOWN because at least one fee is.</strong> It is not a zero and it is not a partial sum — do not put a number in front of this customer yet.</p>` : ""}
      ${totalEstimated ? `<p style="margin:6px 0 2px;font-size:12px"><strong>⚠ This total INCLUDES AN ESTIMATE.</strong> At least one fee is a valuation heuristic, not a published or recorded number — true it up from the portal's fee screen before quoting a customer.</p>` : ""}
      <!-- These two lists were the largest block of honesty prose on the screen
           (499 words on one project) and they are the REASON the total above says
           ESTIMATE / UNKNOWN. So they collapse behind a summary that states the
           STAKE and the COUNT — never a neutral "Details". Closed, the operator
           still reads "5 unresolved charges — the total above is not final". -->
      ${(sheet.unknowns || []).length ? `
        <details class="provenance fee-unknowns">
          <summary><strong>${esc(String(sheet.unknowns.length))} still unknown — the total above is not final</strong></summary>
          <div class="provenance-body"><ul style="margin:2px 0;padding-left:18px">${sheet.unknowns.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></div>
        </details>` : ""}
      ${(sheet.outOfPortalPayments || []).length ? `
        <details class="provenance fee-unknowns">
          <summary><strong>${esc(String(sheet.outOfPortalPayments.length))} charge${sheet.outOfPortalPayments.length === 1 ? "" : "s"} NOT PAYABLE in any portal — a person must pay ${sheet.outOfPortalPayments.length === 1 ? "it" : "them"} another way</strong></summary>
          <div class="provenance-body"><ul style="margin:2px 0;padding-left:18px">${sheet.outOfPortalPayments.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>
        </details>` : ""}
      </div>
      </details>
    </section>`;
  panel.querySelectorAll("button[data-fee-confirm]").forEach((btn) => {
    btn.addEventListener("click", () => confirmFeeLine(btn.dataset.feeConfirm, btn));
  });
  panel.querySelectorAll("button[data-fee-read-portal]").forEach((btn) => {
    btn.addEventListener("click", () => readPortalFees(btn));
  });
}

// "READ THE FEE FROM THE PORTAL" — offered only where there is a filed permit record whose own
// page we can read (an Accela record-detail link on an active permit target). The permit monitor
// does this on its weekly sweep; this is the same read, now.
function feeReadPortalControlHtml() {
  const targets = (state.detail && Array.isArray(state.detail.permitCheckTargets)) ? state.detail.permitCheckTargets : [];
  const readable = targets.filter((t) => t && t.active !== false && t.targetType === "permit"
    && /\/cap\/capdetail\.aspx/i.test(`${t.trackingUrl || ""} ${t.portalUrl || ""}`));
  if (!readable.length) return "";
  return `<p class="fee-read-portal" style="margin:6px 0;font-size:12px">
      <button class="secondary" style="font-size:12px" data-fee-read-portal="1">Read the fee from the portal record${readable.length === 1 ? "" : "s"}</button>
      <span class="muted">Opens ${esc(String(readable.length))} filed record page${readable.length === 1 ? "" : "s"} and reads the Fees section — read-only; nothing is clicked or paid.</span>
    </p>`;
}

async function readPortalFees(btn) {
  const id = state.selectedProjectId;
  if (!id) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Reading the portal…";
  try {
    const res = await api(`/api/projects/${id}/fee-sheet/read-portal`, { method: "POST", body: "{}" });
    if (state.selectedProjectId !== id) return;
    state.feeSheet = res.feeSheet;
    renderFeeSheetPanel();
    const results = Array.isArray(res.results) ? res.results : [];
    const read = results.filter((r) => r.status === "read").length;
    showMessage(`Portal fee read: ${read} of ${results.length} record(s) read${read < results.length ? " — the rest say why on the fee card" : ""}.`, read === results.length ? "info" : "warning");
  } catch (err) {
    showMessage(`Portal fee read failed: ${err.message}`, "error");
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ONE-CLICK CONFIRM (operator 2026-09-27: "there is no place to verify them"). A person
// vouches for a researched fee; the server records exactly the brackets and amounts on this card
// (never a whole schedule) as verified under that person's name, and nothing automated changes
// those schedules afterwards. With sign-in on, the
// name is the signed-in user (the server ignores anything sent); with it off, the person types
// their name — "verified" on a fee means a named person checked it.
async function confirmFeeLine(track, btn) {
  const id = state.selectedProjectId;
  if (!id) return;
  const line = ((state.feeSheet && state.feeSheet.lines) || []).find((l) => l.track === track);
  let auth = state.authMe;
  if (!auth) {
    try { auth = await api("/api/auth/me"); state.authMe = auth; } catch { auth = { enabled: false, user: null }; }
  }
  const what = `${(line && line.jurisdiction) || "this jurisdiction"}, ${money(line ? line.feeUsd : null)}`;
  // NAME EXACTLY WHAT GETS VERIFIED (fees-close2, hard rule 3): each bracket at its amount and each
  // "collected by" hop on this card — and nothing else. A bracket of the same schedule that is not
  // on this card (another size, another amount) stays unverified. Plain text in a native dialog.
  const items = (line && Array.isArray(line.confirmRows)) ? line.confirmRows : [];
  const itemText = (r) => (r.kind === "delegation"
    ? `${r.authority || "this jurisdiction"} — its ${r.discipline ? `${r.discipline} ` : ""}permit is collected by ${r.collectedByAuthority || "another authority"}`
    : `${r.authority || "this jurisdiction"} — ${r.bracketLabel || "(unlabelled line)"} — ${money(r.feeUsd)}`);
  const toVerify = items.filter((r) => !r.verified).map((r) => `  • ${itemText(r)}`);
  const already = items.filter((r) => r.verified).map((r) => `  • ${itemText(r)}`);
  const lede = `Confirm the ${track === "nem" ? "interconnection" : "permit"} fee (${what})?\n\n`
    + `You are saying you checked it against the jurisdiction's own published schedule`
    + `${line && httpUrl(line.sourceUrl) ? ` (${httpUrl(line.sourceUrl)})` : ""}. Recorded as VERIFIED under your name — only these:\n`
    + `${toVerify.join("\n") || "  • (nothing new)"}\n`
    + `${already.length ? `Already verified (left as they are):\n${already.join("\n")}\n` : ""}`
    + `\nOther brackets and amounts of these schedules are NOT verified by this. Automation never changes a schedule a person has verified.`;
  let confirmedBy = "";
  if (auth && auth.enabled) {
    if (!confirm(`${lede}\n\nRecorded as: ${(auth.user && (auth.user.name || auth.user.email)) || "you"}`)) return;
  } else {
    let last = "";
    try { last = localStorage.getItem("feeConfirmName") || ""; } catch { last = ""; }
    const typed = window.prompt(`${lede}\n\nYour name (recorded as the person who verified it):`, last);
    if (typed == null) return;
    confirmedBy = String(typed).trim();
    if (!confirmedBy) { showMessage("Enter your name to confirm a fee — a confirmation is a person vouching for it.", "warning"); return; }
    try { localStorage.setItem("feeConfirmName", confirmedBy); } catch { /* per-viewer convenience only */ }
  }
  btn.disabled = true;
  try {
    // WHAT THIS PERSON SAW — the amount in the dialog above and the items (rows with their
    // versions, brackets, amounts) behind it. The server records only those, and only if they are
    // still what stands, so a research pass that moved the fee between the look and the click
    // cannot put this name on it.
    const res = await api(`/api/projects/${id}/fee-sheet/confirm`, {
      method: "POST",
      body: JSON.stringify({ track, confirmedBy, feeUsd: line ? line.feeUsd : null, scheduleRows: (line && Array.isArray(line.confirmRows)) ? line.confirmRows : [] }),
    });
    if (state.selectedProjectId !== id) return;
    state.feeSheet = res.feeSheet;
    renderFeeSheetPanel();
    showMessage(`Fee confirmed — recorded as verified by ${res.outcome.confirmedBy}.`);
  } catch (err) {
    if (err && err.details && err.details.changed) {
      // The fee moved since the card was drawn: show what stands now, and let the person look again.
      try {
        const fresh = await api(`/api/projects/${id}/fee-sheet`);
        if (state.selectedProjectId === id) { state.feeSheet = fresh.feeSheet; renderFeeSheetPanel(); }
      } catch { /* the message below still says what happened */ }
      showMessage(`Not confirmed: ${err.message} The fee card now shows what stands — check it and confirm again.`, "warning");
      return;
    }
    showMessage(`Confirm failed: ${err.message}`, "error");
    btn.disabled = false;
  }
}

// Friendly display labels for every canonical ProjectStatus (shared/src/types.ts).
//
// `intake_uploaded`, `submit_staging` and `resubmit_staging` are GONE from
// ProjectStatus (2026-09-19): nothing in the system ever wrote them, yet they
// were labelled here, bannered with operator instructions, and offered as
// filters — a vocabulary the product spoke but never used. The other
// zero-writer statuses stay: each is getting a real writer in a later round.
//
// This object is also the single source of the operator status-override menu
// (renderStatusOverride), so a status removed here disappears from the menu in
// the same edit — one vocabulary, not two lists to keep in step.
const STATUS_LABELS = {
  parsed: "Parsed",
  qc_failed: "QC failed",
  qc_passed: "QC passed",
  // The STATUS is where the pipeline is (QC passed, documents built); whether the project is
  // READY to stage is the submit gate's answer, shown from the next-step answer (statusBoxView,
  // the board chip). Labelled "Ready to stage", this status sat beside BLOCKED on every
  // gate-blocked project (demo S1; load test: 100 "ready", gate 16).
  ready_to_stage: "Docs built",
  awaiting_human_submit: "Awaiting human submit",
  submitted: "Submitted",
  correction_received: "Correction received",
  correction_triaged: "Correction triaged",
  waiting_on_designer: "Waiting on designer",
  ready_to_resubmit: "Ready to resubmit",
  awaiting_human_resubmit: "Awaiting human resubmit",
  ready_for_issue: "Ready for issue",
  issued: "Permit issued",
  approved: "Approved",
  nem_approved: "NEM approved",
  handoff_ready: "Ready for handoff",
  blocked: "Blocked",
};

function statusLabel(status) {
  return STATUS_LABELS[status] || humanize(status || "unknown");
}

// THE PROJECT PAGE'S STATUS BOX. Before staging, the recorded status only says where the pipeline
// got to (QC passed / docs built); whether the project is READY is the submit gate's answer. So
// for those statuses the box shows the next-step answer — "Ready to stage" only when the GATE
// said so, the blocker ("Gate blocked") when it did not — with the recorded status in the
// tooltip. Every other status reads as recorded. `current` is currentNextStep(): { step, full }.
// Pure; lifted by backend/test/boardGateTruth.test.ts.
const PRE_STAGE_STATUSES = ["parsed", "qc_passed", "ready_to_stage"];
function statusBoxView(project, current) {
  const recorded = statusLabel(project && project.status);
  if (!project || !PRE_STAGE_STATUSES.includes(project.status)) return { text: recorded, title: "", hideStageDetail: false };
  const step = current && current.step && current.step.key ? current.step : null;
  if (!step || step.gateChecked !== true) {
    return {
      text: project.status === "parsed" ? recorded : `${recorded} — gate not checked`,
      title: `Recorded status: ${recorded}. The submit gate's answer has not loaded, so this does not say the project is ready.`,
      hideStageDetail: false,
    };
  }
  const chip = nextStepChip(step);
  const text = step.key === "ready_to_stage" ? "Ready to stage" : (chip && chip.label) || recorded;
  return {
    text,
    title: `Recorded status: ${recorded}. ${String(step.headline || "")}`.trim(),
    // "QC passed" beside a blocker reads as reassurance; the blocker is the answer.
    hideStageDetail: NEXT_STEP_PROBLEM_KEYS.includes(step.key),
  };
}

// WHERE EACH FILING STANDS, in words — from the submittal tracks (the server's per-track state:
// isTrackDone + the latest reading per target), never the process map's lane rollup, which reads
// "waiting" whenever any step waits and so said "Permit Waiting" beside a ready_for_issue permit
// (demo: Walt Brennan). Same words as the server's trackStateSummary (repository.ts), which
// writes the process map headline. null when the tracks are not loaded — the caller falls back.
const TRACK_STATE_WORDS = {
  not_started: "not started", staged: "staged", submitted: "submitted", in_review: "in review",
  correction: "correction", ready_for_issue: "fee due", issued: "issued",
};
function trackStateWords(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const word = (t) => (t.category === "utility" && t.status === "issued" ? "approved" : TRACK_STATE_WORDS[t.status] || humanize(t.status).toLowerCase());
  const permits = tracks.filter((t) => t.category === "permit");
  const nem = tracks.find((t) => t.category === "utility");
  return {
    permit: permits.length === 0 ? "not required"
      : permits.length === 1 ? word(permits[0])
      : permits.map((t) => `${t.type} ${word(t)}`).join(", "),
    nem: nem ? word(nem) : "not required",
  };
}

// Plain-language "what do I do next" guidance for every canonical status.
// tone: "info" (blue, normal), "warn" (amber, needs attention), "done" (green).
//
// Stage numbers and button numbers are the SAME five-stage scale as
// PROJECT_STAGES and the action bar in dashboard.html. If a banner says
// "Stage 3" while the accordion above it says "2 · Build & Validate", the
// operator is reading two pipelines — which is what "jank" meant.
//
// The three removed statuses (`intake_uploaded`, `submit_staging`,
// `resubmit_staging`) had banners here instructing the operator on states
// nothing could ever put a project into. Gone with them.
const NEXT_STEPS = {
  parsed: { tone: "info", step: "Stage 1", text: "Parsed. <strong>QC runs automatically</strong> — results land here in a moment (re-run any step from Advanced if needed)." },
  qc_failed: { tone: "warn", step: "Stage 1", text: "QC found problems. Open <strong>QC Results</strong> below, fix the flagged fields in the parser and re-save — QC re-runs automatically." },
  qc_passed: { tone: "info", step: "Stage 2", text: "QC passed. <strong>The AHJ/NEM docs are building automatically</strong>, then the reviewer gate runs." },
  ready_to_stage: { tone: "info", step: "Stage 2", text: "Docs built; the reviewer gate runs automatically. When it clears, <strong>Stage portals</strong> is your action — automation never files." },
  awaiting_human_submit: { tone: "warn", step: "Stage 3", text: "Staged and ready. <strong>A person must do the final submit</strong> in the portal now — automation stops here." },
  submitted: { tone: "info", step: "Stage 4", text: "Submitted. Track it with <strong>Permit Checks</strong> / <strong>NEM Checks</strong>. Paste any correction letter into <strong>Corrections</strong>." },
  correction_received: { tone: "warn", step: "Stage 3", text: "A correction came in. Open <strong>Corrections</strong> to triage it — the AI drafts a reply you review before sending." },
  correction_triaged: { tone: "warn", step: "Stage 3", text: "Correction triaged. Fix the docs per the reply, then move the project to <strong>Ready to resubmit</strong>." },
  waiting_on_designer: { tone: "warn", step: "Stage 3", text: "Waiting on the designer to revise stamped plans. Follow up if it has been a while." },
  ready_to_resubmit: { tone: "info", step: "Stage 3", text: "Revisions done. Click <strong>3 · Prepare Submittal</strong> to re-stage for resubmission." },
  awaiting_human_resubmit: { tone: "warn", step: "Stage 3", text: "Resubmission staged. <strong>A person must do the final resubmit</strong> in the portal — automation stops here." },
  ready_for_issue: { tone: "info", step: "Stage 4", text: "Approved — issuance/fees pending. Confirm the permit is issued, then keep tracking NEM." },
  issued: { tone: "info", step: "Stage 4", text: "Permit issued. Waiting on <strong>NEM approval</strong> to finish — keep running NEM Checks." },
  approved: { tone: "info", step: "Stage 4", text: "Approved. Confirm both permit issued and NEM approved to reach handoff." },
  nem_approved: { tone: "info", step: "Stage 4", text: "NEM approved. Once the permit is also issued, you will reach handoff." },
  handoff_ready: { tone: "done", step: "Done", text: "Permit issued + NEM approved. Copy the <strong>Project Handoff Packet</strong> to the installer. PTO is the installer's job — our scope ends here." },
  blocked: { tone: "warn", step: "Blocked", text: "This project is blocked — see the red items below. Clear the blocker, then continue the steps." },
};

// ONE QUESTION, ONE PREDICATE: "did staging fail?" is answered HERE and nowhere else. The
// Next-step banner (renderNextStep) and the board card chip (boardAttention) both call this,
// so the board can never say "Staging failed" while the project page says "Staged and ready".
// `ctx.latestRunStatus` is the newest portal run's status (the list payload's
// latestPortalStatus, or the detail's newest portalRuns row). A failed run only counts while
// the project is still in the staging part of the pipeline — a failed re-check on an issued
// permit is not a staging failure. The recorded sub-stage `staging_failed` always counts.
// Self-contained on purpose: backend/test/submitSeam.test.ts lifts this function out of the
// file and runs it with only esc/humanize/NEXT_STEPS in scope.
function nextStepFor(status, ctx) {
  const c = ctx || {};
  const stagingStatuses = ["ready_to_stage", "awaiting_human_submit", "ready_to_resubmit", "awaiting_human_resubmit"];
  if (c.stageDetail === "staging_failed" || (c.latestRunStatus === "failed" && stagingStatuses.includes(status))) {
    return { key: "staging_failed", tone: "warn", step: "Stage 3 · Staging failed", text: "<strong>The last staging run did not finish — nothing is staged.</strong> Check the portal run below before approving." };
  }
  return NEXT_STEPS[status] || { tone: "info", step: "Stage 1", text: "Click <strong>1 · Run QC</strong> to check the parsed data for missing or wrong info." };
}

// WHICH PORTAL THE OPERATOR HAS TO GO AND FILE IN.
//
// Named from the run's own track, not from its result_json: only the RecipeAdapter writes a
// portalName in there (59 of the live database's runs are AutoLearnAdapter rows that carry
// none), so reading it would name the portal on some filings and go silent on others. A `nem`
// run is the UTILITY's application; every other track is the AHJ's permit.
function filingPortalLabel(project, run) {
  const isNem = run && run.permitType === "nem";
  const name = isNem ? project.utility : project.ahj;
  if (name && String(name).trim()) return String(name).trim();
  return isNem ? "the utility's portal" : "the AHJ's portal";
}

// THE HALF-DONE FILING HAS TO BE UNMISSABLE.
//
// Approve & Submit on a real portal records the operator's authorization and STOPS — hard rule
// 1: automation never clicks a final submit. Until now that left no visible state at all: the
// project stayed `awaiting_human_submit`, the banner went on saying "Staged and ready", and the
// operator's actual filing click and Capture Confirmation were two disconnected manual steps
// with nothing between them. Nobody could tell an approved-but-unfiled job from one that had
// never been touched, and nothing anywhere noticed a filing was half-done.
//
// `approved_awaiting_filing` (written at the approve seam, status deliberately unchanged) is
// what makes it visible. This banner is deliberately loud, says WHICH portal, and spells out
// the three physical steps in order — and its button only scrolls to the Capture Confirmation
// form. It cannot submit anything; there is nothing in this file that can.
function approvedAwaitingFilingGuide(project) {
  const runs = state.detail.portalRuns || [];
  const awaiting = runs.find((run) => run.status === "awaiting_human_submit");
  const portal = filingPortalLabel(project, awaiting);
  return {
    tone: "warn",
    step: "Stage 3 · Your move",
    text: `<strong>Approval recorded — this filing is NOT submitted yet.</strong> Automation stops here.
      Go to <strong>${esc(portal)}</strong>, check the staged application, and <strong>click its submit yourself</strong>.
      Then come back and record the number with <strong>Capture Confirmation</strong> — until you do, nothing is tracking this filing.
      <button type="button" class="secondary" data-go-capture="1" style="margin-left:8px;font-size:12px">Go to Capture Confirmation</button>`,
  };
}

// THE STAGE LABEL IS THE PROJECT'S REAL STAGE. The old table hard-coded "Stage 3" into
// statuses, so a Build project whose last staging run failed read "Stage 3 · Staging failed"
// above an open "2 · Build & Validate" accordion. The label now comes from the stage index
// the server computed for the project (the same one the accordions use), never from a table.
function stageLabelFor(idx) {
  const stage = Number.isInteger(idx) ? PROJECT_STAGES[idx] : null;
  return stage ? stage.label : "";
}

const NEXT_STEP_WHO = {
  me: "You",
  designer: "The designer",
  customer: "The customer",
  ahj: "The AHJ",
  utility: "The utility",
  nobody: "Nobody — nothing is asked",
};
// Answers that describe something wrong (amber), as opposed to routine next work (neutral).
const NEXT_STEP_PROBLEM_KEYS = ["operator_blocked", "portal_paused", "staging_failed", "qc_failed", "gate_blocked", "gap_fill_missing", "unknown"];

// The banner for ONE server answer. Pure: returns { className, html }. Every server string
// (headline, why, labels) is esc()'d — they are prose, never markup. `exists(id)` says whether
// a fix target / button is on this page; a missing one is simply not linked.
function nextStepBannerHtml(step, ctx) {
  const c = ctx || {};
  const stageIdx = Number.isInteger(c.stageIndex) ? c.stageIndex : step.stageIndex;
  const stageLabel = stageLabelFor(stageIdx) || "Next step";
  const exists = typeof c.exists === "function" ? c.exists : () => false;
  const tone = step.urgency === "overdue" ? " is-danger"
    : step.urgency === "done" ? " is-done"
      : NEXT_STEP_PROBLEM_KEYS.includes(step.key) || (step.urgency === "today" && step.who === "me" && step.key !== "ready_to_stage") ? " is-warn" : "";
  const who = NEXT_STEP_WHO[step.who] || "You";
  const since = step.since ? String(step.since).slice(0, 10) : "";
  const whys = Array.isArray(step.why) ? step.why.slice(0, 3) : [];
  const button = step.button && step.button.id && exists(step.button.id) ? step.button : null;
  const provisional = !step.gateChecked
    ? `<span class="next-step-provisional">${esc(c.full === false
      ? "Quick answer from the board — the full check did not load, so the submit gate is not included."
      : "The submit gate is not included in this answer.")}</span>`
    : "";
  const html = `<span class="next-step-step">${esc(stageLabel)}</span>`
    + `<span class="next-step-text">`
    + `<span class="next-step-who">Who acts: <strong>${esc(who)}</strong>${since ? ` · since ${esc(since)}` : ""}</span>`
    + `<strong class="next-step-headline">${esc(step.headline || "")}</strong>`
    + (whys.length
      ? `<ul class="next-step-whys">${whys.map((w) => `<li>${esc(w.text || "")}${w.fixTarget && exists(w.fixTarget)
        ? ` <button type="button" class="linklike next-step-fix" data-fix-target="${esc(w.fixTarget)}">Show</button>` : ""}</li>`).join("")}</ul>`
      : "")
    + (button ? `<button type="button" class="secondary next-step-go" data-next-button="${esc(button.id)}">${esc(button.label)} ↓</button>` : "")
    + provisional
    + `</span>`;
  return { className: `next-step-banner is-server${tone}`, html };
}

// Which answer the banner shows, best first: the server's FULL answer for this project; the
// board's compact answer for it (same rule table, submit gate not included); else null, and
// the caller falls back to the old status table. Never another project's answer.
function currentNextStep() {
  const pid = state.selectedProjectId || (state.detail && state.detail.project && state.detail.project.id);
  if (state.nextStep && state.nextStepProjectId === pid) return { step: state.nextStep, full: true };
  const rows = [].concat(state.projects || [], state.boardAll || []);
  const row = rows.find((p) => p && p.id === pid && p.nextStep && p.nextStep.key);
  if (row) {
    const n = row.nextStep;
    return {
      step: {
        key: n.key, who: n.who, urgency: n.urgency, headline: n.headline, why: [],
        button: n.buttonId ? { id: n.buttonId, label: (NEXT_STEP_BUTTON_LABELS[n.buttonId] || "Go") } : null,
        gateChecked: false, allFiled: n.allFiled === true, gateCanOverrule: n.gateCanOverrule === true, hasStagedDraft: n.hasStagedDraft === true,
      },
      full: false,
    };
  }
  return null;
}
const NEXT_STEP_BUTTON_LABELS = {
  applyStatusOverrideBtn: "Change status",
  runQcBtn: "Run QC",
  openReviewerPacketBtn: "Open Correction Packet",
  approveSubmitBtn: "Approve & Submit",
  startAutopilotBtn: "Stage portals · Autopilot",
  addPermitTargetBtn: "Add tracking target",
  copyHandoffPacketBtn: "Copy handoff packet",
};

// Take the operator TO a control or panel: open every <details> it sits in (stage accordion,
// Advanced fold, status override), scroll it into view, focus it and flash it. It NEVER
// clicks anything — the banner is navigation; the real button still asks for itself.
function revealElement(el) {
  if (!el) return;
  let p = el.parentElement;
  while (p) {
    if (p.tagName === "DETAILS" && !p.open) {
      p.open = true;
      const idx = p.dataset && p.dataset.stageIndex;
      if (idx !== undefined && state.stageOverrides) {
        const pid = state.selectedProjectId || "";
        (state.stageOverrides[pid] ||= {})[Number(idx)] = true;
      }
    }
    p = p.parentElement;
  }
  if (el.tagName === "DETAILS") el.open = true;
  // A TARGET WHOSE CONTENT IS FOLDED: the portal-runs list keeps its history behind a closed
  // "Earlier runs (N · M failed)" fold, so "Check the portal run" landed on that one closed line.
  // Open the fold and land on the failed run inside it (the card the why is about), else on
  // the list itself. renderPortalRuns keeps the fold open across re-renders of this project.
  let land = el;
  const fold = typeof el.querySelector === "function" ? el.querySelector("details.runs-fold") : null;
  if (fold) {
    if (!fold.open) fold.open = true;
    land = (typeof fold.querySelector === "function" && fold.querySelector(".item.fail")) || el;
  }
  if (typeof land.scrollIntoView === "function") land.scrollIntoView({ behavior: "smooth", block: "center" });
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
  land.classList.add("is-flash");
  setTimeout(() => land.classList.remove("is-flash"), 1600);
}

function renderNextStep() {
  const banner = $("nextStepBanner");
  if (!banner) return;
  const { project } = state.detail;
  if (!project) { banner.hidden = true; return; }
  const stageIdx = state.detail.stageIndex;

  // THE SERVER'S ANSWER (backend/src/nextStep.ts) — the same rule table as the board chip.
  const current = typeof currentNextStep === "function" ? currentNextStep() : null;
  if (current) {
    const exists = (id) => Boolean($(id));
    const { className, html } = nextStepBannerHtml(current.step, { stageIndex: stageIdx, exists, full: current.full });
    banner.hidden = false;
    banner.className = className;
    if (banner.dataset) { banner.dataset.nextKey = current.step.key; banner.dataset.nextSource = current.full ? "server" : "board"; }
    banner.innerHTML = html;
    // Mark the ONE button the answer names, everywhere else unmarked; reflect its enabled
    // state on the banner's shortcut so the banner never offers what the page refuses.
    if (typeof document !== "undefined" && document.querySelectorAll) {
      document.querySelectorAll(".is-next-step").forEach((b) => b.classList.remove("is-next-step"));
    }
    const go = banner.querySelector("button[data-next-button]");
    if (go) {
      const target = $(go.dataset.nextButton);
      if (target) {
        target.classList.add("is-next-step");
        if (target.disabled) {
          // The answer names a button the page has switched off: say so IN the banner, in the
          // page's own words, instead of pointing at a control that will not respond.
          const why = (target.dataset && target.dataset.disabledReason) || target.title || "This action is not available right now.";
          go.disabled = true;
          go.title = why;
          const note = document.createElement("span");
          note.className = "next-step-provisional next-step-off";
          note.textContent = `${go.textContent.replace(/\s*↓$/, "")} is switched off: ${why}`;
          go.insertAdjacentElement("afterend", note);
        }
        go.addEventListener("click", () => revealElement(target));
      }
    }
    banner.querySelectorAll("button[data-fix-target]").forEach((b) => {
      b.addEventListener("click", () => revealElement($(b.dataset.fixTarget)));
    });
    return;
  }

  // FALLBACK — the server answer did not load. The old status table, so the banner is never
  // blank; its stage label is still the project's REAL stage.
  // The status alone cannot answer this one: an approved-but-unfiled project and a freshly
  // staged one are BOTH `awaiting_human_submit` (correctly — nothing is filed in either case).
  // stage_detail is what separates them.
  //
  // Newest run first by startedAt — the payload happens to arrive newest-first, but the banner
  // must not depend on that.
  const runs = (state.detail.portalRuns || []).slice().sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  let guide = project.status === "awaiting_human_submit" && project.stageDetail === "approved_awaiting_filing"
    ? approvedAwaitingFilingGuide(project)
    : nextStepFor(project.status, { stageDetail: project.stageDetail, latestRunStatus: runs[0] ? runs[0].status : null });
  if (guide.key === "staging_failed") {
    // "Staged and ready" beside a "Staging Failed" chip was the contradiction. Say WHICH
    // filings failed, and — because "nothing is staged" would be false on a project where one
    // track did stage — which filing is still waiting on a person's submit.
    const latestPerTrack = new Map();
    for (const run of runs) {
      const k = run.permitType || "portal";
      if (!latestPerTrack.has(k)) latestPerTrack.set(k, run);
    }
    const trackName = (k) => (k === "nem" ? "NEM" : `${humanize(k)} permit`);
    const failed = [...latestPerTrack].filter(([, r]) => r.status === "failed").map(([k]) => trackName(k));
    const staged = [...latestPerTrack].filter(([, r]) => r.status === "awaiting_human_submit").map(([k]) => trackName(k));
    if (failed.length) {
      guide = {
        ...guide,
        text: `<strong>The last staging run did not finish — nothing is staged for ${esc(failed.join(", "))}.</strong>`
          + (staged.length ? ` ${esc(staged.join(", "))} ${staged.length === 1 ? "is" : "are"} staged and waiting for a person's final submit.` : "")
          + " Check <strong>Portal Runs</strong> below before approving.",
      };
    }
  }
  // The table's "Stage N" is a guess from the status; the project's own stage wins. Only the
  // qualifier after it ("Staging failed", "Your move") is kept.
  const qualifier = String(guide.step || "").replace(/^Stage \d+(?: · )?/, "");
  const realStage = stageLabelFor(stageIdx);
  const stepLabel = realStage ? (qualifier ? `${realStage} · ${qualifier}` : realStage) : (guide.step || "Next step");
  // The server's own sentence (current_stage) is free prose with many writers and goes stale,
  // so it is shown ONLY where the status alone cannot explain the state: a failed staging run,
  // or a project already in Track/Closeout. Escaped — it is plain text, never markup.
  const showWhy = typeof project.currentStage === "string" && project.currentStage.trim()
    && (guide.key === "staging_failed" || (Number.isInteger(stageIdx) && stageIdx >= 3));
  banner.hidden = false;
  banner.className = `next-step-banner${guide.tone === "done" ? " is-done" : guide.tone === "warn" ? " is-warn" : ""}`;
  if (banner.dataset) { banner.dataset.nextKey = guide.key || project.status || ""; banner.dataset.nextSource = "fallback"; }
  banner.innerHTML = `<span class="next-step-step">${esc(stepLabel)}</span><span class="next-step-text">${guide.text}${showWhy
    ? `<span class="next-step-why" title="${esc(project.currentStage.trim())}">${esc(project.currentStage.trim())}</span>`
    : ""}</span>`;
  const goCapture = banner.querySelector("button[data-go-capture]");
  if (goCapture) {
    goCapture.addEventListener("click", () => {
      // Open the Submit accordion (data-stage-index 2) and scroll the capture form into view.
      // renderPortalRuns un-hides #confirmationForm whenever a staged run is awaiting a human
      // submit, which is true by construction for any project in this state.
      document.querySelector(".stage-accordion[data-stage-index='2']")?.setAttribute("open", "");
      const form = $("confirmationForm");
      if (form) form.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
}

// ----- Operator status override -----
//
// Until now a project whose status had drifted (or that needed to be marked
// `blocked`) could only be corrected with SQL against the live database. This
// is the operator gesture that replaces that: pick the true status, say why,
// and the backend records the change with the reason on the audit trail.
//
// It is an OPERATOR action, not an automation one — nothing here ever submits a
// filing, and moving a project to `submitted` by hand does not file anything.
// The reason is REQUIRED: a status that changed with no stated cause is the
// same unexplained drift this control exists to fix.
//
// `handoff_ready` is deliberately NOT offered. It is computed — the backend
// reaches it only when the permit is issued AND NEM is approved — and A2's
// route refuses it, so offering it would be a button whose only outcome is an
// error. Every other label in STATUS_LABELS is offered, which is why that
// object is the single vocabulary: the three statuses deleted from it this
// round cannot reappear here, and `blocked` (whose only writer is this control)
// cannot fall out of it by omission.
const STATUS_OVERRIDE_EXCLUDED = ["handoff_ready"];

function renderStatusOverride() {
  const select = $("statusOverrideSelect");
  if (!select) return;
  const { project } = state.detail;
  const wrap = $("statusOverrideWrap");
  if (!project) { if (wrap) wrap.hidden = true; state.statusOverrideFor = null; return; }
  if (wrap) wrap.hidden = false;
  const reason = $("statusOverrideReason");
  // AN IN-PROGRESS EDIT SURVIVES A RE-RENDER. renderDetail runs on every background
  // refresh and after every autopilot poll, so a plain rebuild would erase a half-typed
  // reason out from under the operator mid-sentence — the same "it wiped what I did"
  // complaint the pinned-open stage accordions already exist to answer, reappearing
  // inside the control built to fix drifted statuses. Same idiom as
  // syncProjectAssignSelect: capture, rebuild, restore. Keyed by project id and kept on
  // `state`, so opening a DIFFERENT project starts clean rather than inheriting the last
  // project's half-written reason onto a record it was never about.
  const sameProject = state.statusOverrideFor === project.id;
  const pendingStatus = sameProject ? select.value : "";
  const pendingReason = sameProject && reason ? reason.value : "";
  state.statusOverrideFor = project.id;
  const options = Object.keys(STATUS_LABELS).filter((s) => !STATUS_OVERRIDE_EXCLUDED.includes(s));
  select.innerHTML = options
    .map((s) => `<option value="${esc(s)}">${esc(STATUS_LABELS[s])}</option>`)
    .join("");
  // A status the menu cannot offer (e.g. a project already at handoff_ready)
  // must not silently preselect a DIFFERENT status the operator did not choose.
  if (options.includes(project.status)) {
    select.value = project.status;
  } else {
    select.insertAdjacentHTML("afterbegin",
      `<option value="" selected>— current: ${esc(statusLabel(project.status))} —</option>`);
    select.value = "";
  }
  // Restore only a choice the rebuilt menu can still honour — never leave the select
  // showing a status it cannot post.
  if (pendingStatus && Array.from(select.options).some((o) => o.value === pendingStatus)) {
    select.value = pendingStatus;
  }
  if (reason) reason.value = pendingReason;
}

async function applyStatusOverride() {
  const projectId = state.selectedProjectId;
  if (!projectId) return;
  const status = ($("statusOverrideSelect")?.value || "").trim();
  const reason = ($("statusOverrideReason")?.value || "").trim();
  if (!status) { showMessage("Pick the status this project should be in.", "error"); return; }
  if (!reason) {
    showMessage("A reason is required — it is what the audit trail records alongside the change.", "error");
    $("statusOverrideReason")?.focus();
    return;
  }
  const current = state.detail?.project?.status;
  if (status === current) { showMessage(`This project is already ${statusLabel(status)}.`, "info"); return; }
  if (!confirm(`Change this project's status to "${statusLabel(status)}"?\n\nYour reason is recorded on the audit trail. This does not file, submit or pay anything — it only corrects what the board says.`)) return;
  const btn = $("applyStatusOverrideBtn");
  if (btn) btn.disabled = true;
  try {
    await api(`/api/projects/${projectId}/status`, { method: "POST", body: JSON.stringify({ status, reason }) });
    // The edit is spent: drop the preserved draft so the re-render opens the panel clean
    // on the NEW status instead of re-offering the change that was just made.
    state.statusOverrideFor = null;
    await loadProjects();
    await selectProject(projectId);
    showMessage(`Status set to ${statusLabel(status)} — recorded with your reason.`, "info");
  } catch (err) {
    showMessage(err.message || "Could not change the status.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// WHERE A PENDING HUMAN-REVIEW ITEM BELONGS. The same partition the server makes
// (repository.ts isCriticalReviewItem, which the submit gate and nextStep read): QC work is a
// pending item that is neither a Track/ops field nor an advisory issue type. The two lists
// are MIRRORED here because this file cannot import them — backend/test/submitSeam.test.ts
// fails the moment they drift from repository.ts.
const NON_QC_REVIEW_FIELDS = ["correction", "permit_status", "prepare_submission", "autopilot"];
const ADVISORY_REVIEW_ISSUE_TYPES = ["Run triage", "Background job failed", "Fee schedule disagrees with paid receipts"];
function reviewItemBuckets(items) {
  const out = { qc: [], reading: [], notice: [] };
  for (const it of items || []) {
    if (!it || it.status !== "pending") continue;
    if (it.fieldName === "permit_status") out.reading.push(it);
    else if (NON_QC_REVIEW_FIELDS.includes(it.fieldName) || ADVISORY_REVIEW_ISSUE_TYPES.includes(it.issueType || "")) out.notice.push(it);
    else out.qc.push(it);
  }
  return out;
}

// Apply the pipeline-stepper state to the five stage accordions: completed stages
// collapse with a check, the current stage opens, future stages lock. Driven by
// state.detail.stageIndex (computed server-side). A blocked project paints a red
// overlay on its active stage rather than getting its own stage.
function applyStageState() {
  const d = state.detail;
  if (!d) return;
  const active = Number.isInteger(d.stageIndex) ? d.stageIndex : 0;
  // Default expand/collapse: current stage open, others closed. But a stage the
  // operator manually opened (tracked in state.stageOverrides via summary clicks)
  // must STAY open across re-renders and navigation — otherwise the Submit gate
  // felt "locked out and I can't get back to it". Overrides reset when the project
  // actually advances to a new stage (so fresh defaults apply for the new step).
  const pid = state.selectedProjectId || "";
  // Reset a project's manual overrides ONLY when its active stage genuinely changes
  // (the project advanced), never on first observation — otherwise a re-render or a
  // background refresh would wipe the operator's pinned-open stage. Comparing the
  // per-project active value (not a global key) avoids stale-key resets.
  const prevActive = state.stageActiveSeen[pid];
  if (prevActive !== undefined && prevActive !== active) {
    state.stageOverrides[pid] = {};
  }
  state.stageActiveSeen[pid] = active;
  const overrides = state.stageOverrides[pid] || {};
  document.querySelectorAll(".stage-accordion[data-stage-index]").forEach((el) => {
    const idx = Number(el.dataset.stageIndex);
    el.classList.remove("is-done", "is-current", "is-locked", "is-blocked");
    const pill = el.querySelector(".stage-pill");
    const marker = el.querySelector(".stage-marker");
    let defaultOpen = false;
    if (idx < active) {
      el.classList.add("is-done"); defaultOpen = false;
      if (marker) marker.textContent = "✓";
      if (pill) pill.textContent = "Done";
    } else if (idx === active) {
      el.classList.add("is-current"); defaultOpen = true;
      if (marker) marker.textContent = "●";
      if (pill) pill.textContent = d.isBlocked ? "Blocked" : "Current";
      if (d.isBlocked) el.classList.add("is-blocked");
    } else {
      // Future stage: collapsed by default and marked "not reached", but the user can
      // still click to open it and work out of order (non-linear stepper).
      el.classList.add("is-locked"); defaultOpen = false;
      if (marker) marker.textContent = "\u{1F512}";
      if (pill) pill.textContent = "Not reached";
    }
    el.open = overrides[idx] !== undefined ? overrides[idx] : defaultOpen;
  });

  // Pending human-review items block the submit gate but live in Stage 1, which is
  // usually collapsed "Done" by the time the operator is staging — so it's easy to
  // miss WHY "Prepare Submittal" is greyed out. Surface the count on the QC/Verify
  // stage (even when done) and flag it red so the blocker is discoverable.
  //
  // NOT EVERY PENDING ITEM IS QC WORK. `permit_status` items are unclassified portal-status
  // readings (Track work — shown on the Track accordion below), and `prepare_submission` /
  // `autopilot` items belong to staging. Counting them here turned QC red with "10 to review"
  // on projects whose permit is already issued. Display only: the server's submit gate still
  // counts them (server change S6), so the Submit Gate panel may disagree until that lands.
  // EVERY PENDING ITEM IS COUNTED SOMEWHERE VISIBLE, and the three counts add up to the board
  // card's total (pendingReviewCount): QC checks on the QC accordion, portal readings on
  // Track, and advisory notices (triage tips, background-job notices) on the QC accordion
  // beside the list that shows them — they do not gate, so they are not "to review" red.
  const buckets = reviewItemBuckets(d.humanReviewItems || []);
  const pendingReview = buckets.qc;
  const portalReadings = buckets.reading;
  const trackStage = document.querySelector('.stage-accordion[data-stage-index="3"]');
  setStageExtraPill(trackStage, "readings", portalReadings.length
    ? `${portalReadings.length} portal reading${portalReadings.length === 1 ? "" : "s"} to confirm` : "", "warning");
  const qcStageForNotices = document.querySelector('.stage-accordion[data-stage-index="0"]');
  setStageExtraPill(qcStageForNotices, "notices", buckets.notice.length
    ? `${buckets.notice.length} notice${buckets.notice.length === 1 ? "" : "s"}` : "", "neutral");

  // CORRECTIONS LIVE WHERE THE PROJECT IS. The Corrections panel sits in 3 · Submit, but a
  // correction arrives while the project is in 4 · Track — so on a Track project with an open
  // correction the panel is MOVED (not re-rendered: ids and listeners survive) to the top of
  // the Track stage, and back to its marker in Submit otherwise.
  const corrPanel = $("correctionsPanel");
  const corrHome = $("correctionsPanelHome");
  const openCorrections = (d.corrections || []).filter((c) => !c.closedAt);
  const overdueCorrections = openCorrections.filter((c) => c.isOverdue);
  const trackBody = trackStage ? trackStage.querySelector(".stage-body") : null;
  if (corrPanel && corrHome && trackBody && typeof corrPanel.insertAdjacentElement === "function") {
    const wantTrack = active === 3 && openCorrections.length > 0;
    if (wantTrack && corrPanel.parentElement !== trackBody) {
      trackBody.insertAdjacentElement("afterbegin", corrPanel);
    } else if (!wantTrack && corrPanel.previousElementSibling !== corrHome) {
      corrHome.insertAdjacentElement("afterend", corrPanel);
    }
    if (wantTrack && overrides[3] === undefined) trackStage.open = true;
  }
  setStageExtraPill(trackStage, "overdue", active >= 3 && overdueCorrections.length
    ? `Correction overdue${overdueCorrections.length > 1 ? ` (${overdueCorrections.length})` : ""}` : "", "danger");

  const qcStage = document.querySelector('.stage-accordion[data-stage-index="0"]');
  if (qcStage) {
    const pill = qcStage.querySelector(".stage-pill");
    const marker = qcStage.querySelector(".stage-marker");
    if (pendingReview.length) {
      qcStage.classList.add("is-blocked");
      if (pill) pill.textContent = `${pendingReview.length} to review`;
      if (marker) marker.textContent = "!";
      qcStage.title = "Resolve these Human Review items, then Run QC, to unblock Prepare Submittal.";
    } else {
      qcStage.title = "";
    }
  }
}

// An extra count pill on a stage accordion's summary (beside its Done/Current pill, which
// stays untouched). Created on demand, removed when `text` is empty; textContent only.
function setStageExtraPill(acc, key, text, tone) {
  if (!acc || typeof acc.querySelector !== "function") return;
  const summary = acc.querySelector(".stage-summary");
  if (!summary || typeof summary.querySelector !== "function") return;
  let pill = summary.querySelector(`.stage-extra-pill[data-extra="${key}"]`);
  if (!text) { if (pill && pill.remove) pill.remove(); return; }
  if (!pill) {
    pill = document.createElement("span");
    pill.className = `stage-extra-pill is-${tone || "warning"}`;
    pill.dataset.extra = key;
    const main = summary.querySelector(".stage-pill");
    if (main && main.insertAdjacentElement) main.insertAdjacentElement("beforebegin", pill);
    else summary.appendChild(pill);
  }
  pill.textContent = text;
}

// ----- Record this portal (teach the bot a new AHJ/utility portal) -----
// The recorder's browser must run where the human is, so this hands the worker a
// ready-to-run, pre-filled command + a launcher that records on their machine and
// saves the recipe to THIS server (central) — reused next time, admins can revise.
function recordSlug(s) {
  return String(s || "portal").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "portal";
}

function buildRecordCommand() {
  const p = state.detail?.project;
  if (!p) return "";
  const scope = $("recordScope")?.value === "utility" ? "utility" : "ahj";
  const url = ($("recordPortalUrl")?.value || "").trim();
  const api = window.location.origin;
  const name = scope === "utility" ? (p.utility || "") : (p.ahj || "");
  const parts = ["npm run portal:record --", `--scope ${scope}`];
  if (scope === "ahj") parts.push(`--ahj "${p.ahj || ""}"`);
  else parts.push(`--utility "${p.utility || ""}"`);
  if (p.state) parts.push(`--state ${p.state}`);
  if (url) parts.push(`--url "${url}"`);
  parts.push(`--project ${p.id}`, `--api ${api}`, `--profile ./.portal-profiles/${recordSlug(name || scope)}`);
  return parts.join(" ");
}

// THE PRESCRIPTIVE-VS-ENGINEERED CHOICE IS OREGON'S SPLIT (ORSC / BCD 440-5952). Everywhere else a
// plan set is a standard structural review (a stamped design carries its stamp), so the Manual-entry
// control offers no such choice there — the e2e-gap close verifier (2026-09-26) found the static
// "mutually exclusive" hint and the "(prescriptive vs engineered)" label rendered on every project,
// and an override picked there produced the Oregon split until permitPath.ts set it aside. One
// function decides the label, the hint and whether the two options are live; the backend's own
// flag (prescriptiveSplitApplies) can widen it to a jurisdiction whose cited process names a split.
function permitPathChoice(project) {
  const st = String(project?.state || "").trim().toUpperCase();
  const snap = project?.parserSnapshot || {};
  const split = st === "OR" || snap.prescriptiveSplitApplies === true || project?.prescriptiveSplitApplies === true;
  return split
    ? { enabled: true, label: "Permit path (prescriptive vs engineered)", hint: "Prescriptive and structural applications are mutually exclusive — only the matching one is generated and uploaded." }
    : { enabled: false, label: "Permit path", hint: `${st || "This jurisdiction"} has no prescriptive-vs-engineered choice: the plan set is reviewed as a standard structural review (a stamped design carries its stamp). Auto-detect stays selected.` };
}

function renderRecordPortal() {
  if (!$("recordCmdPreview")) return;
  const p = state.detail?.project;
  if (!p) return;
  const urlInput = $("recordPortalUrl");
  // Pre-fill the portal URL from a learned KB profile when we have one and the box is empty.
  if (urlInput && !urlInput.value) {
    const scope = $("recordScope")?.value === "utility" ? "utility" : "ahj";
    const norm = (s) => String(s || "").trim().toLowerCase();
    const wanted = norm(scope === "utility" ? p.utility : p.ahj);
    if (wanted.length >= 4) {
      const prof = (state.knowledgeProfiles || []).find((k) => {
        // Match ONLY on the same-scope field — an AHJ recording must never inherit
        // a utility's interconnection URL (that bug pulled PGE's URL into a City of
        // Portland AHJ record). And skip combined AHJ+utility profiles, whose single
        // portalUrl is ambiguous (it may be the other scope's URL).
        const field = scope === "utility" ? norm(k.utility) : norm(k.ahj);
        const other = scope === "utility" ? norm(k.ahj) : norm(k.utility);
        const nameMatches = field && (field === wanted || field.includes(wanted) || wanted.includes(field));
        return nameMatches && !other;
      });
      if (prof && prof.portalUrl) urlInput.value = prof.portalUrl;
    }
  }
  $("recordCmdPreview").textContent = buildRecordCommand();

  const snap = p.parserSnapshot || {};
  const dcKw = p.systemSizeDcKw;
  const acKw = p.systemSizeAcKw;
  const dcAcRatio = dcKw && acKw ? (dcKw / acKw).toFixed(2) : null;
  const sections = [
    { heading: "Project", rows: [
      ["Homeowner", p.homeownerName],
      ["Address", p.projectAddress],
      ["City / State / Zip", [p.city, p.state, p.zip].filter(Boolean).join(", ")],
      ["AHJ", p.ahj],
      ["Utility", p.utility],
      ["Account #", p.accountNumber],
      ["Meter #", p.meterNumber],
    ]},
    { heading: "System", rows: [
      ["System DC / AC kW", dcKw || acKw ? `${dcKw ?? "?"} kW DC / ${acKw ?? "?"} kW AC` : null],
      ["DC/AC ratio", dcAcRatio],
      ["Interconnection", p.interconnectionMethod],
      ["Phase", snap.servicePhase],
      ["Job value", snap.jobValue ? `$${snap.jobValue}` : null],
    ]},
    { heading: "Array / Roof", rows: [
      ["Module", [snap.moduleMake, snap.moduleModel, snap.moduleWattage && `${snap.moduleWattage}W`, snap.moduleQty && `x${snap.moduleQty}`].filter(Boolean).join(" ")],
      ["Tilt / Azimuth", [snap.tilt && `${snap.tilt}°`, snap.azimuth && `${snap.azimuth}°`].filter(Boolean).join(" / ")],
      ["Roof material", snap.roofMaterial],
      ["Roof slope", snap.roofSlope],
      ["Mount type", snap.mounting],
    ]},
    { heading: "Electrical", rows: [
      ["Inverter", [snap.invModel || snap.pvMicroModel, (snap.invQty || snap.pvMicroQty) && `x${snap.invQty || snap.pvMicroQty}`].filter(Boolean).join(" ")],
      ["Inverter output (A)", snap.invOutputW || snap.pvMicroOutputW],
      ["Bus / Main / PV breaker (A)", [snap.busRating, snap.mainBreaker, snap.pvBreaker].filter(Boolean).join(" / ")],
    ]},
    { heading: "Battery (if any)", rows: [
      ["Battery", [snap.batteryMake, snap.batteryModel, snap.batteryQty && `x${snap.batteryQty}`].filter(Boolean).join(" ")],
      ["ESS capacity", snap.essKwh ? `${snap.essKwh} kWh` : null],
      ["Gateway", snap.gatewayModel],
    ]},
    { heading: "Notes", rows: [
      ["Locates / 811", snap.locateCalloutText],
    ]},
  ];
  const sectionHtml = sections.map(({ heading, rows }) => {
    const visibleRows = rows.filter(([, v]) => v != null && v !== "" && v !== "? / ?");
    if (!visibleRows.length) return "";
    return `<div class="record-data-section"><div class="record-data-heading">${esc(heading)}</div>${visibleRows.map(([k, v]) => `<div class="record-data-row"><span class="muted">${esc(k)}</span><strong>${esc(String(v))}</strong></div>`).join("")}</div>`;
  }).join("");
  $("recordManualData").innerHTML = sectionHtml || `<p class="muted">No parsed data yet.</p>`;

  // Roof planes summary (per-plane modules / tilt / azimuth). Prefer the
  // structured roofPlanes array the parser builds; when it's empty, synthesize a
  // single plane from the snapshot's tilt/azimuth/module-qty so the summary still
  // shows. Rendered in the same one-line format as the parser sheet.
  let planes = Array.isArray(snap.roofPlanes) ? snap.roofPlanes.filter(Boolean) : [];
  if (!planes.length) {
    const hasAny = [snap.tilt, snap.azimuth, snap.moduleQty, snap.roofSlope].some((v) => v != null && v !== "");
    if (hasAny) {
      planes = [{ roof: 1, modules: snap.moduleQty || "", tilt: snap.tilt ?? snap.roofSlope ?? "", azimuth: snap.azimuth ?? "" }];
    }
  }
  const planesWrap = $("recordRoofPlanesWrap");
  if (planesWrap) {
    if (planes.length) {
      const totalModules = planes.reduce((s, p) => s + (Number(p.modules) || 0), 0);
      const planeLine = (p, i) => {
        const parts = [
          (p.modules != null && p.modules !== "") ? `${p.modules} module(s)` : "",
          (p.tilt != null && p.tilt !== "") ? `tilt ${p.tilt}°` : "",
          (p.azimuth != null && p.azimuth !== "") ? `azimuth ${p.azimuth}°` : "",
        ].filter(Boolean).join(", ");
        return `<div class="record-data-row"><strong>Roof #${esc(p.roof ?? i + 1)}:</strong>&nbsp;<span>${esc(parts || "—")}</span></div>`;
      };
      $("recordRoofPlanes").innerHTML =
        planes.map(planeLine).join("") +
        `<div class="record-data-row" style="border-top:1px solid var(--line);margin-top:4px;padding-top:4px"><span class="muted">Total parsed roof-plane modules</span><strong>${totalModules}</strong></div>`;
      planesWrap.style.display = "";
    } else {
      planesWrap.style.display = "none";
    }
  }

  // Description of Work (AHJ permit narrative) from the parsed snapshot.
  const desc = String(snap.projectDescriptionText || snap.description || "").trim();
  const descWrap = $("recordDescriptionWrap");
  if (descWrap) {
    if (desc) {
      $("recordDescription").textContent = desc;
      descWrap.style.display = "";
    } else {
      descWrap.style.display = "none";
    }
  }

  // Manual-entry inputs — prefill from the snapshot, but never clobber what the
  // operator is actively typing (a background re-render must not wipe the field).
  const setIfIdle = (id, value) => {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = value ?? "";
  };
  setIfIdle("manualJobValue", snap.jobValue != null ? String(snap.jobValue) : "");
  setIfIdle("manualProjectType", snap.projectType != null ? String(snap.projectType) : "");
  setIfIdle("manualPermitPath", snap.permitPathOverride != null ? String(snap.permitPathOverride) : "");
  {
    const choice = permitPathChoice(p);
    const pathSel = $("manualPermitPath");
    if (pathSel) {
      for (const opt of Array.from(pathSel.options || [])) if (opt.value) opt.disabled = !choice.enabled;
      if (!choice.enabled && pathSel.value) pathSel.value = "";
    }
    if ($("manualPermitPathLabel")) $("manualPermitPathLabel").textContent = choice.label;
    if ($("manualPermitPathHint")) $("manualPermitPathHint").textContent = choice.hint;
  }
  setIfIdle("manualStructureType", snap.structureTypeOverride ? String(snap.structureTypeOverride) : "unknown");
  setIfIdle("manualHomeownerEmail", snap.homeownerEmail != null ? String(snap.homeownerEmail) : "");
  setIfIdle("manualHomeownerPhone", snap.homeownerPhone != null ? String(snap.homeownerPhone) : "");
  setIfIdle("manualDescription", desc);
}

async function saveManualEntry() {
  if (!state.selectedProjectId) return;
  const btn = $("saveManualEntryBtn");
  const status = $("manualEntryStatus");
  // Only send fields the operator actually filled, so a blank input never wipes a
  // parsed value. The keys match what valuation.ts / the reviewer gate read.
  const payload = {};
  const jobValue = ($("manualJobValue")?.value || "").trim();
  const projectType = ($("manualProjectType")?.value || "").trim();
  const permitPath = ($("manualPermitPath")?.value || "").trim();
  const email = ($("manualHomeownerEmail")?.value || "").trim();
  const phone = ($("manualHomeownerPhone")?.value || "").trim();
  const desc = ($("manualDescription")?.value || "").trim();
  if (jobValue) payload.jobValue = jobValue;
  if (projectType) payload.projectType = projectType;
  // Permit-path override drives which AHJ application is generated (prescriptive vs
  // structural). An empty selection leaves it on auto-detect — send "" explicitly so
  // clearing a prior override sticks.
  if (permitPath) payload.permitPathOverride = permitPath;
  // STRUCTURE TYPE (site_built / manufactured / unknown) — the operator's answer, which the
  // reviewer reads ahead of anything the parser or the plan-set text says. Sent only when it
  // differs from what is on file, so saving another field never re-writes it.
  const structureTypeChoice = ($("manualStructureType")?.value || "").trim();
  const structureTypeOnFile = String(state.detail?.project?.parserSnapshot?.structureTypeOverride || "unknown");
  if (structureTypeChoice && structureTypeChoice !== structureTypeOnFile) payload.structureTypeOverride = structureTypeChoice;
  if (email) payload.homeownerEmail = email;
  if (phone) payload.homeownerPhone = phone;
  if (desc) payload.projectDescriptionText = desc;
  if (!Object.keys(payload).length) {
    if (status) { status.textContent = "Nothing to save — fill at least one field."; status.className = "muted"; }
    return;
  }
  if (btn) btn.disabled = true;
  if (status) { status.textContent = "Saving…"; status.className = "muted"; }
  try {
    const detail = await api(`/api/projects/${state.selectedProjectId}`, { method: "PUT", body: JSON.stringify(payload) });
    if (detail && detail.project) state.detail = detail;
    if (status) { status.textContent = "Saved."; status.className = "muted"; }
    renderDetail();
    showMessage("Project data saved.", "info");
  } catch (err) {
    if (status) { status.textContent = "Save failed: " + (err.message || err); status.className = "muted"; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function copyDescriptionOfWork() {
  const desc = ($("recordDescription")?.textContent || "").trim();
  if (!desc) { showMessage("No description of work parsed yet.", "warning"); return; }
  try {
    await navigator.clipboard.writeText(desc);
    showMessage("Description of work copied.", "info");
  } catch {
    showMessage(desc, "info");
  }
}

async function buildDocumentSplit() {
  const p = state.detail?.project;
  if (!p) { showMessage("Open a project first.", "warning"); return; }
  const target = $("splitTarget")?.value || "nem";
  const statusEl = $("splitStatus");
  const resultsEl = $("splitResults");
  if (statusEl) { statusEl.style.display = ""; statusEl.textContent = "Splitting plan set…"; statusEl.className = "muted"; }
  if (resultsEl) resultsEl.innerHTML = "";
  try {
    const res = await api(`/api/projects/${p.id}/build-utility-package?target=${encodeURIComponent(target)}`, { method: "POST" });
    const base = `/api/projects/${p.id}/documents`;
    const rows = [];
    if (res.zipDocumentId) {
      rows.push(`<div class="record-data-row"><span><strong>Full package ZIP</strong></span><a class="badge" href="${base}/${res.zipDocumentId}" download>Download ZIP</a></div>`);
    }
    for (const part of res.parts || []) {
      rows.push(`<div class="record-data-row"><span class="muted">${esc(part.label)}${part.pages ? ` <span style="opacity:.6">(p. ${esc((part.pages || []).join(", "))})</span>` : ""}</span><a class="badge" href="${base}/${part.documentId}" download>Download</a></div>`);
    }
    if (res.missingDocTypes && res.missingDocTypes.length) {
      rows.push(`<div class="record-data-row"><span class="muted">Not found in plan set</span><strong style="color:var(--warning,#b45309)">${esc(res.missingDocTypes.join(", "))}</strong></div>`);
    }
    if (resultsEl) resultsEl.innerHTML = rows.join("") || `<p class="muted">No documents produced.</p>`;
    if (statusEl) { statusEl.textContent = `Built ${(res.parts || []).length} split doc(s); ${(res.packagedDocTypes || []).length} packaged into the ZIP.`; statusEl.className = ""; }
  } catch (err) {
    if (statusEl) { statusEl.textContent = `Split failed: ${err.message}`; statusEl.className = "muted"; }
  }
}

async function copyRecordCommand() {
  const cmd = buildRecordCommand();
  if (!cmd) { showMessage("Open a project first.", "warning"); return; }
  try {
    await navigator.clipboard.writeText(cmd);
    showMessage("Record command copied. Run it in your SOLAR-Proj folder.", "info");
  } catch {
    showMessage(cmd, "info");
  }
}

// Launch a record session scoped to a specific track card's portal type.
// Called from the "Open recorder" button on each track card (no separate scroll needed).
async function launchTrackRecorder(trackType, scope, btn) {
  const p = state.detail?.project;
  if (!p || !trackType) { showMessage("Open a project first.", "warning"); return; }
  const resolvedScope = scope === "utility" ? "utility" : "ahj";
  const track = (state.submittalTracks || []).find((t) => t.type === trackType);
  const portalUrl = track?.recipePortalUrl || "";
  if (btn) { btn.disabled = true; btn.textContent = "Launching…"; }
  try {
    const res = await api(`/api/projects/${p.id}/launch-record`, {
      method: "POST",
      body: JSON.stringify({ scope: resolvedScope, portalUrl: portalUrl || undefined }),
    });
    // Update the card inline so the operator sees the status without scrolling.
    const card = btn?.closest(".track-card");
    if (card) {
      const hint = card.querySelector(".track-record-hint");
      if (hint) hint.textContent = res.message || "Browser open — complete the form, type save when done.";
    }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="refresh-cw"></i><span>Re-open recorder</span>'; if (window.lucide) window.lucide.createIcons(); }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="play"></i><span>Open recorder</span>'; if (window.lucide) window.lucide.createIcons(); }
    showMessage(`Launch failed: ${err.message}. Use the "Record this portal" section below to download/copy the command.`, "warning");
  }
}

// Auto-learn progress bar. The bar is driven by TWO sources so it works even if the
// live SSE stream is blocked/buffered (proxies, etc.):
//   1. an optimistic client-side "creep" that always advances toward 85% while the
//      request is in flight — so the bar is never frozen even with zero events;
//   2. `autolearn_progress` SSE events that snap it forward to the real percent and
//      update the step label when they do arrive (see connectSse).
// Progress is monotonic (never goes backward).
let autoLearnTimer = null;
let autoLearnPct = 0;

// Set the bar to at least `percent` (monotonic) and optionally update the label.
// No-op once the bar is unmounted (the verdict text replaced it).
function setAutoLearnBar(percent, message) {
  const fill = $("autoLearnProgressFill");
  if (!fill) return;
  if (typeof percent === "number" && !Number.isNaN(percent)) {
    autoLearnPct = Math.max(autoLearnPct, Math.min(100, percent));
    fill.style.width = autoLearnPct + "%";
    const pct = $("autoLearnProgressPct");
    if (pct) pct.textContent = Math.round(autoLearnPct) + "%";
  }
  const label = $("autoLearnProgressLabel");
  if (label && message) label.textContent = message;
}

function renderAutoLearnProgress(statusEl, initialMsg) {
  statusEl.style.display = "";
  statusEl.className = "";
  statusEl.innerHTML =
    '<div style="margin-top:4px">' +
      '<div id="autoLearnProgressLabel" style="font-size:12px"></div>' +
      '<div style="height:8px;background:var(--border,#e5e7eb);border-radius:999px;overflow:hidden;margin-top:6px">' +
        '<div id="autoLearnProgressFill" style="height:100%;width:6%;background:var(--info,#3b82f6);border-radius:999px;transition:width .4s ease"></div>' +
      '</div>' +
      '<div id="autoLearnProgressPct" style="font-size:11px;color:var(--muted,#6b7280);margin-top:3px">6%</div>' +
    '</div>';
  autoLearnPct = 6;
  setAutoLearnBar(6, initialMsg);
  // Optimistic creep: ease toward 85% and stop there, so the bar visibly moves the
  // whole time even if not a single SSE event arrives. Real events overtake it.
  if (autoLearnTimer) clearInterval(autoLearnTimer);
  autoLearnTimer = setInterval(() => {
    if (!$("autoLearnProgressFill")) { stopAutoLearnProgress(); return; }
    if (autoLearnPct < 85) setAutoLearnBar(autoLearnPct + (85 - autoLearnPct) * 0.07);
  }, 700);
}

// Refinement from an SSE progress event (snaps the bar to the real percent + label).
function updateAutoLearnProgress(percent, message) {
  setAutoLearnBar(percent, message);
}

// Stop the creep timer (call when the run resolves or the bar is gone).
function stopAutoLearnProgress() {
  if (autoLearnTimer) { clearInterval(autoLearnTimer); autoLearnTimer = null; }
}

// Every learn run writes a debug bundle (per-page screenshots, planner decisions,
// Playwright trace, LLM call log) under data/learn-runs/. Link it under the verdict so
// a bad run can be downloaded as ONE zip and sent for troubleshooting without a re-run.
// Pass the result's debugDir, or "latest" when the run failed before returning one.
function appendDebugBundleLink(el, debugDirOrLatest) {
  if (!el || !debugDirOrLatest) return;
  const runId = String(debugDirOrLatest).split(/[\\/]/).pop();
  if (!runId) return;
  const a = document.createElement("a");
  a.href = `/api/learn-runs/${encodeURIComponent(runId)}/bundle.zip`;
  a.textContent = "⬇ Download this run's debug bundle (send it when reporting a problem)";
  a.style.cssText = "display:block;margin-top:4px;font-size:11px";
  el.appendChild(a);
}

// WHICH PERMIT AN AHJ AUTO-LEARN FILES. The route takes permitType ('structural' | 'electrical')
// and keys the learned recipe's discipline off it; without it the recipe carried NO discipline and
// the building track (recipeDisciplineForTrack('building') = 'structural') never found it. The
// learner is also handed THAT permit's issuing agency (City of Jefferson: Marion County, both
// permits) to pick the address row by. Default from the project's tracks: the building track when
// there is one, else Electrical when the only permit track is electrical / a panel upgrade.
function defaultLearnPermitType(tracks) {
  const types = (Array.isArray(tracks) ? tracks : []).map((t) => String((t && t.type) || "")).filter((t) => t && t !== "nem");
  if (types.includes("building")) return "structural";
  if (types.some((t) => t === "electrical" || t === "mpu")) return "electrical";
  // No building / electrical / mpu track (a COMBO or single "permit" filing, or tracks not loaded):
  // the whole-permit learn sends NO permitType, so the recipe keeps discipline "" and every track
  // finds it through the legacy fallback. "structural" here saved a recipe the combo track never
  // looks up (agency-row skeptic MF, measured on City of Waltham).
  return "";
}
// Show the permit picker for an AHJ recording only, defaulted from this project's tracks — unless
// the operator already chose one for this project (the choice holds until another project opens).
function syncRecordPermitType() {
  const wrap = $("recordPermitWrap");
  const sel = $("recordPermitType");
  if (!wrap || !sel) return;
  wrap.hidden = $("recordScope")?.value === "utility";
  const pid = String(state.selectedProjectId || "");
  if (sel.dataset.chosenFor !== pid) sel.value = defaultLearnPermitType(state.submittalTracks);
  sel.dataset.syncedFor = pid;
  if (!sel.dataset.bound) {
    sel.dataset.bound = "1";
    sel.addEventListener("change", () => { sel.dataset.chosenFor = sel.dataset.syncedFor || ""; });
  }
}

// Auto-learn: the bot fills the portal to the review screen, records a recipe, and
// verifies the fill — no human recording needed. Never submits (operator approves that).
async function autoLearnPortalUI() {
  const p = state.detail?.project;
  if (!p) { showMessage("Open a project first.", "warning"); return; }
  const scope = $("recordScope")?.value === "utility" ? "utility" : "ahj";
  const url = ($("recordPortalUrl")?.value || "").trim();
  if (!url) { showMessage("Paste the portal login/landing URL first (the field above).", "warning"); return; }
  const name = scope === "utility" ? (p.utility || "the utility") : (p.ahj || "the AHJ");
  // An AHJ learn names its permit (see defaultLearnPermitType); a utility (NEM) learn has none.
  const pick = $("recordPermitType")?.value;
  const permitType = scope === "ahj" && (pick === "electrical" || pick === "structural") ? pick : undefined;
  const permitWords = permitType === "electrical" ? "electrical" : "building (structural)";
  if (!confirm(`Auto-learn ${name}'s portal${permitType ? ` for the ${permitWords} permit` : ""}?\n\nThe bot will log in (using this client's stored credential), fill the application from the project data up to the review screen, and verify the fill. It will NOT submit — you approve the final submit with one click afterward. This opens a browser and may take a minute.`)) return;
  const btn = $("autoLearnBtn");
  const statusEl = $("autoLearnStatus");
  if (btn) btn.disabled = true;
  if (statusEl) renderAutoLearnProgress(statusEl, "Starting — opening a browser and logging in…");
  try {
    // Learning runs as a background job (202 + jobId) so a minutes-long browser pass can't
    // hit an HTTP/proxy timeout. SSE autolearn_progress events keep driving the bar;
    // poll the job for the terminal verdict (job.result carries the learn outcome).
    const { jobId } = await api(`/api/projects/${p.id}/auto-learn`, { method: "POST", body: JSON.stringify(permitType ? { scope, portalUrl: url, permitType } : { scope, portalUrl: url }) });
    const learnJob = await waitForStagingJob(jobId);
    if (learnJob.status === "failed") {
      throw new Error(learnJob.error || "Auto-learn failed — download the debug bundle for details.");
    }
    const res = learnJob.result || {};
    const v = res.verification || {};
    const verdict = res.status === "trusted"
      ? `✓ Learned & verified (${v.confidence} confidence) over ${res.pageCount} page(s). The recipe is now trusted and will replay on future ${scope === "utility" ? "utility" : "AHJ"} projects. Final submit stays your one-click approval.`
      : res.status === "draft"
        ? `Learned, but needs your verification before it's trusted. ${(v.issues || []).slice(0, 3).join("; ")}`
        : res.status === "paused"
          ? `Paused on an MFA/CAPTCHA — complete it in the browser, then retry. A draft recipe was saved.`
          : `Could not learn it automatically: ${res.message || ""} — record it manually instead.`;
    stopAutoLearnProgress();
    setAutoLearnBar(100);
    if (statusEl) {
      statusEl.textContent = verdict;
      statusEl.className = res.status === "trusted" ? "" : "muted";
      appendDebugBundleLink(statusEl, res.debugDir);
    }
    showMessage(res.message || verdict, res.status === "trusted" ? "info" : "warning");
    await loadKnowledgeBase();
    await selectProject(p.id);
  } catch (err) {
    stopAutoLearnProgress();
    if (statusEl) {
      statusEl.textContent = `Auto-learn failed: ${err.message || err}. You can still record it manually.`;
      statusEl.className = "muted";
      // The run still wrote a bundle before it threw — link the newest one.
      appendDebugBundleLink(statusEl, "latest");
    }
    showMessage(err.message || "Auto-learn failed.", "error");
  } finally {
    stopAutoLearnProgress();
    if (btn) btn.disabled = false;
  }
}

async function launchRecordSession() {
  const p = state.detail?.project;
  if (!p) { showMessage("Open a project first.", "warning"); return; }
  const scope = $("recordScope")?.value === "utility" ? "utility" : "ahj";
  const url = ($("recordPortalUrl")?.value || "").trim();
  const statusEl = $("launchRecordStatus");
  if (statusEl) { statusEl.style.display = ""; statusEl.textContent = "Launching browser…"; statusEl.className = "muted"; }
  try {
    const res = await api(`/api/projects/${p.id}/launch-record`, {
      method: "POST",
      body: JSON.stringify({ scope, portalUrl: url || undefined }),
    });
    if (statusEl) { statusEl.textContent = res.message || "Browser session started — complete the form in the opened browser window, then type save."; statusEl.className = ""; }
  } catch (err) {
    if (statusEl) { statusEl.textContent = `Launch failed: ${err.message}. Use Download record.bat instead.`; statusEl.className = "muted"; }
  }
}

function downloadRecordBat() {
  const cmd = buildRecordCommand();
  if (!cmd) { showMessage("Open a project first.", "warning"); return; }
  const bat = `@echo off\r\nREM Record this portal and save the recipe to the central server.\r\nREM Save this file in your SOLAR-Proj folder, then double-click it.\r\ncd /d "%~dp0"\r\n${cmd}\r\npause\r\n`;
  const blob = new Blob([bat], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "record-portal.bat";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

// Run a render step in isolation: a failure in one panel (e.g. unexpected project
// data) must never abort the rest of the detail view, the stepper, or the action
// buttons. Logs the failure for debugging instead of throwing.
function safeRender(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[render] ${label} failed:`, err);
  }
}

// The Status box + its sub-stage chip. Re-run whenever the next-step answer changes (the
// project page's own load, every autopilot poll) — the answer lands after the first render.
function renderStatusBox() {
  const project = state.detail && state.detail.project;
  if (!project || !$("metricStatus")) return;
  // The Status box says what the NEXT-STEP ANSWER says (statusBoxView), not the bare recorded
  // status: "Ready to stage / QC passed" beside BLOCKED was the demo's refusal project.
  const box = statusBoxView(project, typeof currentNextStep === "function" ? currentNextStep() : null);
  $("metricStatus").textContent = box.text;
  $("metricStatus").title = box.title;
  // Sub-stage chip on the Status metric. textContent + hidden, so nothing is
  // interpolated into innerHTML here at all. No stage_detail → the element
  // stays hidden AND empty: the header shows the status and says nothing more,
  // which is the truth about a project the system has recorded no sub-stage for.
  const stageDetailEl = $("metricStageDetail");
  if (stageDetailEl) {
    const detail = typeof project.stageDetail === "string" ? project.stageDetail.trim() : "";
    stageDetailEl.textContent = detail ? humanize(detail) : "";
    stageDetailEl.title = detail ? `Sub-stage recorded by the system: ${detail}` : "";
    stageDetailEl.hidden = !detail || box.hideStageDetail;
  }
}

function renderDetail() {
  ensureKeelixDetailStyles();
  const { project } = state.detail;
  safeRender("header", () => {
    $("detailTitle").textContent = project.homeownerName || "Unnamed project";
    $("detailSubtitle").textContent = project.projectAddress || "No address captured";
    renderStatusBox();
    $("metricUtility").textContent = project.utility || "Missing";
    $("metricAhj").textContent = project.ahj || "Missing";
    $("metricSystem").textContent = (project.systemSizeDcKw == null && project.systemSizeAcKw == null)
      ? "Not parsed yet"
      : `${project.systemSizeDcKw ?? "—"} DC / ${project.systemSizeAcKw ?? "—"} AC`;
    const words = trackStateWords(state.submittalTracks);
    $("metricPermit").textContent = words ? `Permit ${words.permit} / NEM ${words.nem}` : "Not checked";
  });
  safeRender("autopilot", () => { refreshAutopilot(); });
  // Each panel is isolated so a single bad value can't break the flow or the stepper.
  safeRender("clientSelect", syncProjectClientSelect);
  safeRender("assignSelect", syncProjectAssignSelect);
  safeRender("nextStep", renderNextStep);
  safeRender("statusOverride", renderStatusOverride);
  safeRender("handoffBanner", renderHandoffBanner);
  safeRender("permitForm", syncPermitForm);
  safeRender("workflow", renderWorkflow);
  safeRender("submitGate", renderSubmitGate);
  safeRender("portalQuestions", renderPortalQuestionChip);
  safeRender("paymentPanel", renderPaymentPanel);
  safeRender("feeSheetPanel", renderFeeSheetPanel);
  safeRender("submittalTracks", renderSubmittalTracks);
  safeRender("processMap", renderProcessMap);
  safeRender("liveReadiness", renderLiveTestReadiness);
  safeRender("historical", renderHistoricalFailures);
  safeRender("reviewerGate", renderReviewerGate);
  safeRender("qc", renderQc);
  safeRender("review", renderReview);
  safeRender("appDocs", renderApplicationDocs);
  safeRender("permitMonitor", renderPermitMonitor);
  safeRender("corrections", renderCorrections);
  safeRender("portalRuns", renderPortalRuns);
  safeRender("timeline", renderProjectTimeline);
  safeRender("audit", renderAudit);
  safeRender("recordPortal", renderRecordPortal);
  // The stepper state runs LAST and isolated, so completed-stage collapse / current-
  // stage open / button availability is always applied even if a panel above failed.
  safeRender("stageState", applyStageState);
  if (window.lucide) {
    try { window.lucide.createIcons(); } catch { /* lucide is cosmetic */ }
  }
}

function opsClass(status) {
  if (status === "blocked") return "blocker";
  if (status === "waiting") return "warning";
  if (status === "done") return "pass";
  return "info";
}

function briefClass(value) {
  if (value === "blocked" || value === "blocker") return "blocker";
  if (value === "watch" || value === "warning") return "warning";
  if (value === "ready" || value === "pass") return "pass";
  return "info";
}

function submitGateClass(value) {
  if (value === "blocked" || value === "blocker") return "blocker";
  if (value === "staged_awaiting_human" || value === "warning") return "warning";
  if (value === "ready_to_stage" || value === "submitted_tracking" || value === "pass") return "pass";
  return "info";
}

// Maps each submit-gate blocker to the on-page panel that fixes it: which stage
// accordion to open and which element to scroll to. Clicking a blocker link in
// the "can't submit" note jumps the operator straight there.
const SUBMIT_FIX_TARGETS = {
  // Indices are the FIVE-stage accordion scale: 0 QC / 1 Build / 2 Submit /
  // 3 Track / 4 Closeout.
  "submitting-client": { el: "projectClientSelect" },
  "qc-human-review": { stage: 0, el: "reviewItems" },
  "ahj-form-mapping-verified": { stage: 1, el: "applicationDocs" },
  "ahj-nem-docs": { stage: 1, el: "applicationDocs" },
  "permit-requirements": { stage: 1, el: "reviewerGate" },
  "installer-design-actions": { stage: 1, el: "reviewerGate" },
  "nem-preflight": { stage: 2, el: "submitGate" },
  "document-inventory": { stage: 2, el: "inlineDocSplitWidget" },
};

function gotoSubmitFix(checkId) {
  const t = SUBMIT_FIX_TARGETS[checkId] || { stage: 2, el: "submitGate" };
  if (t.stage != null) {
    const acc = document.querySelector(`.stage-accordion[data-stage-index="${t.stage}"]`);
    if (acc) acc.open = true;
  }
  // Let the accordion expand before scrolling to the (now visible) target.
  requestAnimationFrame(() => {
    const el = $(t.el);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Brief highlight so the operator sees what to act on.
      el.classList.add("fix-flash");
      setTimeout(() => el.classList.remove("fix-flash"), 1600);
    }
  });
}

// A GATE CHECK'S EVIDENCE, SPLIT BY WHAT THE OPERATOR MUST SEE. The panel used to print
// evidence.slice(0, 4) inside the closed provenance fold. The document check writes a count line
// and up to four "✓ present" lines FIRST, so its "Filled at staging: …" and "MISSING (required): …"
// lines — the ones that NAME a document and say what happens to it — sat at index 5+ and were
// never shown (e6b3afde, 8f4ca8dd: the held-out checklist named nowhere visible).
//   named — every line that names a document's state (the prefixes getSubmitGateReport writes):
//           shown under "Next", never capped.
//   rest  — everything else, in the fold, uncapped: the server already caps it (submitGateCheck:
//           6 lines, the named lines exempt — same prefixes, GATE_EVIDENCE_NAMES_A_DOCUMENT), so a
//           second cap here only ever hid lines.
function gateEvidenceSplit(evidence) {
  const lines = Array.isArray(evidence) ? evidence.map((line) => String(line)) : [];
  const names = (line) => /^(Filled at staging|MISSING \(required\)|Missing \(advisory\)):/.test(line);
  return { named: lines.filter(names), rest: lines.filter((line) => !names(line)) };
}

function renderSubmitGate() {
  ensureKeelixDetailStyles();
  const gate = state.submitGate;
  if (!gate) {
    $("submitGateStatus").textContent = "not synced";
    $("submitGate").innerHTML = `<p class="muted">Open a project to generate the PermitFlow + NEMflow submit gate.</p>`;
    $("copySubmitGateBtn").disabled = true;
    // FAIL CLOSED: an un-loaded gate (e.g. the submit-gate fetch rejected and was swallowed by the
    // Promise.allSettled in selectProject) must NOT enable staging. Leaving the button enabled here
    // let a project be staged with none of the gate's blockers evaluated. Default to disabled until
    // the gate is known; the operator can refresh the project to re-run it.
    $("prepareBtn").disabled = true;
    $("prepareBtn").title = "Submit gate not loaded yet — refresh the project to evaluate it before staging.";
    return;
  }
  $("copySubmitGateBtn").disabled = !gate.reportText;
  $("submitGateStatus").textContent = humanize(gate.decision);
  $("prepareBtn").disabled = !gate.canPrepareSubmission;
  $("prepareBtn").title = gate.canPrepareSubmission ? "Stage to final review. Human submit remains manual." : gate.nextAction || "Submit gate is not ready.";
  const checks = gate.checks || [];
  const manualItems = gate.manualSubmitChecklist || [];
  const blockers = checks.filter((check) => check.status === "blocker");
  // Surface WHY "Prepare Submittal" is greyed out, right at the top of the
  // project (where the operator is), instead of only as a button tooltip and a
  // collapsed Stage-4 panel they have to hunt for.
  const note = $("submitBlockerNote");
  if (note) {
    // Withheld where it would be false (showSubmitBlockerNote); the same checks stay listed in
    // the Submit Gate panel below — only the top-of-page alarm is withheld.
    const stageIdxForNote = state.detail && Number.isInteger(state.detail.stageIndex) ? state.detail.stageIndex : 0;
    const ns = state.nextStep && state.nextStepProjectId === state.selectedProjectId ? state.nextStep : null;
    if (showSubmitBlockerNote(gate, stageIdxForNote, ns)) {
      note.hidden = false;
      const hasDocBlocker = blockers.some((b) => b.id === "document-inventory");
      // The site's numbered-step rhythm ("01 / 02 / 03" + an uppercase label)
      // applied to the thing the operator most needs enumerated: what is in the
      // way. The ids (#inlineDocSplitWidget, #inlineSplitTarget, #inlineSplitBtn,
      // #inlineSplitStatus) and the .fix-link class are MATCHING KEYS — the
      // SUBMIT_FIX_TARGETS scroll map and the handlers below query them — so they
      // are unchanged; only the presentation moved off literal hex onto tokens.
      note.innerHTML = `
        <span class="kx-eyebrow is-muted">Blocked</span>
        <span class="kx-band-title">${plural(blockers.length, "thing")} must clear before this can be submitted.</span>
        <div class="kx-steps">
          ${blockers.map((b, i) => `
            <div class="kx-step">
              <span class="kx-step-num">${esc(String(i + 1).padStart(2, "0"))}</span>
              <span class="kx-step-label"><a href="#" class="kx-step-link fix-link" data-fix="${esc(b.id)}">${esc(b.title)} →</a></span>
              <span class="kx-step-body">${esc(b.nextAction || "resolve this")}</span>
            </div>`).join("")}
        </div>
        ${hasDocBlocker ? `
          <div id="inlineDocSplitWidget" class="kx-inline-tool">
            <span class="kx-inline-tool-title">Plan set uploaded? Split it into individual sheets now:</span>
            <div class="kx-inline-tool-row">
              <select id="inlineSplitTarget">
                <option value="all">All sheets (permit + NEM)</option>
                <option value="permit">Permit only (SLD + site plan + structural + specs)</option>
                <option value="nem">NEM only (meter photo + SLD + site plan + inverter spec)</option>
              </select>
              <button id="inlineSplitBtn" class="secondary">✂ Split plan set now</button>
              <span id="inlineSplitStatus" class="kx-inline-tool-status"></span>
            </div>
          </div>` : ""}`;
      note.querySelectorAll(".fix-link").forEach((a) => {
        a.addEventListener("click", (e) => { e.preventDefault(); gotoSubmitFix(a.dataset.fix); });
      });
      const inlineBtn = $("inlineSplitBtn");
      if (inlineBtn) {
        inlineBtn.addEventListener("click", async () => {
          const p = state.detail?.project;
          if (!p) return;
          const target = $("inlineSplitTarget")?.value || "all";
          const statusEl = $("inlineSplitStatus");
          inlineBtn.disabled = true;
          if (statusEl) statusEl.textContent = "Splitting…";
          try {
            const res = await api(`/api/projects/${p.id}/build-utility-package?target=${encodeURIComponent(target)}`, { method: "POST" });
            const count = (res.parts || []).length;
            if (statusEl) statusEl.textContent = `✓ Split into ${count} document(s). Refreshing gate…`;
            setTimeout(() => selectProject(p.id), 1200);
          } catch (err) {
            if (statusEl) statusEl.textContent = `Failed: ${err.message}`;
            inlineBtn.disabled = false;
          }
        });
      }
    } else {
      note.hidden = true;
    }
  }
  const warnings = checks.filter((check) => check.status === "warning");
  const passes = checks.filter((check) => check.status === "pass");
  // Blockers and warnings are the act-on-it rows and stay at full height. The
  // PASS rows fold behind their count: a pass is a settled claim, not an open
  // question, so hiding its prose cannot make an unknown read as certainty —
  // and the count keeps the denominator ("6 passed") on screen. Each folded
  // row keeps its evidence disclosure, one interaction deeper.
  const actionChecks = [...blockers, ...warnings];
  const checkRow = (check) => { const ev = gateEvidenceSplit(check.evidence); return `
            <article class="submit-gate-check ${briefClass(check.status)}">
              <div class="item-title">
                <span>${esc(check.title)}</span>
                ${statusBadge(`${check.lane} | ${check.status}`)}
              </div>
              <!-- "Next" is the act-on-it half and stays at full weight. Owner,
                   requirement, evidence and source are provenance. -->
              <p><strong>Next:</strong> ${esc(check.nextAction)}</p>
              ${ev.named.length ? `<ul class="evidence-list">${ev.named.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
              ${check.id === "ahj-form-mapping-verified" && (check.status === "blocker" || check.status === "warning") ? `<button type="button" class="secondary" style="font-size:12px;margin-top:4px" onclick="document.querySelector('.stage-accordion[data-stage-index=\\'1\\']')?.setAttribute('open','');document.getElementById('applicationDocs')?.scrollIntoView({behavior:'smooth'})">Go to App Docs → verify forms</button>` : ""}
              <details class="provenance">
                <summary>Owner: ${esc(check.ownerRole)}</summary>
                <div class="provenance-body">
                  <p><strong>Owner:</strong> ${esc(check.ownerRole)}</p>
                  <p>${esc(check.requirement)}</p>
                  ${ev.rest.length ? `<ul class="evidence-list">${ev.rest.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
                  <p class="muted">Source record: <span class="mono">${esc(check.source)}</span></p>
                </div>
              </details>
            </article>`; };
  $("submitGate").innerHTML = `
    ${bandHead("SUBMIT GATE", "Nothing goes out until a human says so.", "Automation stages the application and stops. The final submit, the fee, and any CAPTCHA or MFA are executed by a person.")}
    <article class="item ${submitGateClass(gate.decision)}">
      <div class="item-title"><span>${esc(gate.headline)}</span>${statusBadge(gate.decision.replaceAll("_", " "))}</div>
      <p><strong>Next action:</strong> ${esc(gate.nextAction)}</p>
      <div class="ops-status-strip">
        <span>${gate.blockerCount || 0} blockers</span>
        <span>${gate.warningCount || 0} warnings</span>
        <span>${gate.passCount || 0} pass</span>
        <span>${gate.canPrepareSubmission ? "can stage" : "do not stage"}</span>
        <span>${gate.canHumanSubmit ? "human submit ready" : "no human submit"}</span>
      </div>
    </article>
    <div class="submit-gate-grid">
      <article class="submit-gate-manual">
        <div class="item-title"><span>Manual Submit Guardrail</span>${statusBadge("human only")}</div>
        <ul class="manual-submit-list">
          ${manualItems.slice(0, 7).map((item) => `<li>${esc(item)}</li>`).join("")}
        </ul>
      </article>
      <article class="submit-gate-focus">
        <div class="item-title"><span>Focus Checks</span>${statusBadge(`${actionChecks.length} open · ${passes.length} passed`)}</div>
        <div class="submit-gate-checks">
          ${actionChecks.length || passes.length ? `
            ${actionChecks.map(checkRow).join("")}
            ${passes.length ? `
            <details class="fold pass pass-fold">
              <summary><strong>${esc(String(passes.length))} passed</strong> — each with its evidence</summary>
              <div class="fold-body">${passes.map(checkRow).join("")}</div>
            </details>` : ""}`
          : `<p class="muted">No submit gate checks generated yet.</p>`}
        </div>
      </article>
    </div>
  `;
}

// ----- Per-permit submittal tracks (NEM + building/electrical, tracked apart) -----
async function loadSubmittalTracks() {
  if (!state.selectedProjectId) { state.submittalTracks = null; return; }
  try {
    const res = await api(`/api/projects/${state.selectedProjectId}/submittal-tracks`);
    state.submittalTracks = res.tracks || [];
  } catch {
    state.submittalTracks = null;
  }
  updatePortalLoginsSummary();
  syncRecordPermitType();
}

// Header chip: how many of this project's portals have a saved login. Best-effort.
async function updatePortalLoginsSummary() {
  const summary = $("portalLoginsSummary");
  if (!summary) return;
  const client = plClient();
  const tracks = state.submittalTracks || [];
  if (!client || !tracks.length) { summary.textContent = ""; return; }
  let creds = [];
  try { creds = (await api(`/api/clients/${client.id}/portal-credentials`)).credentials || []; }
  catch { summary.textContent = ""; return; }
  let total = 0, ready = 0; const seen = new Set();
  for (const t of tracks) {
    const url = t.recipePortalUrl || ""; let host = "";
    try { host = url ? new URL(url).hostname.toLowerCase() : ""; } catch { /* ignore */ }
    const slug = plPortalSlug(t.channel || t.label || t.type);
    const key = host || slug;
    if (seen.has(key)) continue; seen.add(key);
    total++;
    const matched = creds.some((c) => {
      if (host && c.portalUrl) { try { if (new URL(c.portalUrl).hostname.toLowerCase() === host) return true; } catch { /* continue */ } }
      const ct = (c.portalType || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      if (ct && ct === slug) return true;
      if (ct && slug && (ct.includes(slug.slice(0, 10)) || slug.includes(ct.slice(0, 10)))) return true;
      return false;
    });
    if (matched) ready++;
  }
  summary.textContent = total ? `${ready}/${total} portal logins saved` : (creds.length ? `${creds.length} saved` : "");
  if (ready < total) summary.style.color = "var(--warn, #b45309)";
  else summary.style.color = "var(--ok, #16a34a)";
}

// A RUN THAT CAPTURED NO SCREENSHOT MUST BE ASKED ONCE, NOT FOREVER.
//
// The review-screenshot <img> is rebuilt on every render of the tracking panel —
// and the panel re-renders on each SSE event, autopilot poll and detail refetch.
// A run with no capture on disk therefore 404s again on every one of those, which
// is the "repeating timer" in the network log (371ms, 912ms, 2698ms, 6354ms,
// 10649ms — backing off, never stopping). Nothing was retrying: the page was
// re-asking a question it had already been told the answer to.
//
// The <img>'s own onerror is the terminal state. It records the miss here and the
// next render simply does not emit the tag. Keyed WITH recipeStatus so the one
// case where the answer legitimately changes — a recording that later completes
// and writes its capture — gets exactly one fresh ask, not zero.
const screenshotMisses = new Set();
const screenshotKey = (projectId, recipeId, recipeStatus) => `${projectId}:${recipeId}:${recipeStatus}`;
//
// The key rides in a data- attribute and is read back off the element, NOT
// interpolated into the handler: esc() escapes & < > " and deliberately not ',
// so a key pasted into onerror="…('HERE')" would be a way out of the JS string.
// A double-quoted attribute esc() already covers is the safe carrier.
window.__noteMissingReviewShot = (img) => {
  if (img.dataset.shotKey) screenshotMisses.add(img.dataset.shotKey);
  const wrap = img.closest("[data-shot-wrap]");
  if (wrap) wrap.style.display = "none";
  else img.style.display = "none";
};

const TRACK_STATUS_CLASS = {
  not_started: "warning", staged: "info", submitted: "info",
  in_review: "info", correction: "blocker", issued: "pass",
};

// WHERE A TRACK IS FILED, AS FOUND — ON THE CARD (new-AHJ e2e, gap 4).
//
// The per-job lookup found Iowa City's EnerGov URL and Waltham's "no online portal, paper
// drop-off", and the tracks still said "Unknown — verify". The server now resolves the channel
// from the lookup (cited) / profile / knowledge base and says how it knows (`channelBasis`); this
// draws it: every http(s) URL in the channel sentence is a link (untrusted text: esc() everything,
// httpUrl() gates the href), the basis is a chip beside it, and an older server that sends no
// basis draws no chip — the sentence already carries its own "verify" wording.
const TRACK_CHANNEL_BASIS = {
  cited: { badge: "badge-info", label: "cited" },
  verified: { badge: "badge-pass", label: "verified by a person" },
  known: { badge: "badge-info", label: "on record" },
  profile: { badge: "badge-warning", label: "profile — verify" },
  researched: { badge: "badge-warning", label: "researched — verify" },
  unknown: { badge: "badge-warning", label: "not found yet" },
};

function linkifyText(text) {
  const s = String(text ?? "");
  const re = /https?:\/\/[^\s<>"'`]+/g;
  // Trailing sentence punctuation and a closing paren or square bracket belong to the prose, not
  // the URL. Those two are written as unicode escapes in the pattern string so the brackets in
  // this function stay balanced for the tests, which lift it out of this file by bracket counting.
  const trailing = new RegExp("[.,;:!?\\u0029\\u005d]+$");
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    const url = m[0].replace(trailing, "");
    out += esc(s.slice(last, m.index));
    const safe = httpUrl(url);
    const shown = safe.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/$/, "");
    out += safe
      ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(shown.length > 60 ? `${shown.slice(0, 59)}…` : shown)}</a>`
      : esc(url);
    last = m.index + url.length;
    re.lastIndex = last;
  }
  return out + esc(s.slice(last));
}

// FILED OUTSIDE THIS TOOL (operator 09-28: "City of Waltham only does in-person permit submission ...
// ensure they're bold enough to know, same with email submissions as it will require us to go outside
// of the submission tool"). A bold, coloured banner on the card — never the grey "Channel:" line alone.
const OFF_TOOL_CHANNEL = {
  in_person: { title: "IN-PERSON SUBMISSION", what: "This jurisdiction does not take this filing online. The bot prepares and fills the packet; a person must deliver it at the counter — outside this tool." },
  email: { title: "EMAIL SUBMISSION", what: "This filing is sent by email, not through a portal. The bot prepares and fills the packet; a person must email it — outside this tool — then record the confirmation here." },
  mail: { title: "SUBMISSION BY MAIL", what: "This filing is mailed. The bot prepares and fills the packet; a person must print and mail it — outside this tool." },
};
function offToolChannelHtml(t) {
  const k = OFF_TOOL_CHANNEL[t.channelKind];
  if (!k) return "";
  return `<div role="note" style="margin:0 0 8px;padding:8px 10px;border:2px solid var(--warning);border-left-width:6px;border-radius:6px;background:rgba(245,158,11,0.10)">
    <strong style="font-size:14px;letter-spacing:.02em">⚠ ${esc(k.title)}</strong>
    <div style="font-size:12px;margin-top:2px">${esc(k.what)}</div></div>`;
}

function trackChannelHtml(t) {
  const channel = String(t.channel || "");
  const basis = TRACK_CHANNEL_BASIS[t.channelBasis];
  const lines = [
    `<p class="muted track-channel" style="margin:0 0 4px">Channel: ${linkifyText(channel)}${basis ? ` <span class="badge ${basis.badge}">${esc(basis.label)}</span>` : ""}${t.lastCheckedAt ? ` · last checked ${esc(fmtDate(t.lastCheckedAt))}` : ""}</p>`,
  ];
  // A portal URL the server resolved but did not write into the sentence.
  const portal = httpUrl(t.portalUrl);
  if (portal && !channel.includes(portal)) {
    lines.push(`<p class="muted track-channel-link" style="margin:0 0 4px">Portal: ${linkifyText(portal)}</p>`);
  }
  // The recorder's pre-fill URL, when no recipe exists yet, comes from the knowledge base or a
  // profile's source page — which may be an information page, not the application portal (rule 5:
  // an information page is never a portal). Shown as what it is: a link on file, unverified.
  const onFile = t.hasRecipe ? "" : httpUrl(t.recipePortalUrl);
  if (onFile && !channel.includes(onFile) && onFile !== portal) {
    lines.push(`<p class="muted track-channel-link" style="margin:0 0 4px">Link on file (not verified as the application portal): ${linkifyText(onFile)}</p>`);
  }
  // The server's basis line may already lead with its own "Permit structure:"; never say it twice.
  const structure = String(t.structureBasis || "").trim();
  if (structure) lines.push(`<p class="muted" style="margin:0 0 4px;font-size:12px">${/^permit structure\b/i.test(structure) ? "" : "Permit structure: "}${linkifyText(structure)}</p>`);
  return lines.join("");
}

// Offices that must see the plans BEFORE this filing (Waltham: fire review, then building) — each
// step cited. When drawn as a list, the next-action sentence drops its own copy of the same steps.
function trackPrerequisitesHtml(t) {
  const steps = Array.isArray(t.prerequisites) ? t.prerequisites.filter((p) => p && p.step) : [];
  if (!steps.length) return "";
  return `<div class="track-prereqs" style="margin:0 0 6px;font-size:12px"><strong>Before this filing, at another office:</strong>
    <ol style="margin:2px 0 0 18px;padding:0">${steps.map((p) => `<li>${esc(p.step)}${httpUrl(p.sourceUrl) ? ` — ${linkifyText(httpUrl(p.sourceUrl))}` : ""}</li>`).join("")}</ol></div>`;
}

function trackNextActionText(t) {
  const next = String(t.nextAction || "");
  const listed = Array.isArray(t.prerequisites) && t.prerequisites.some((p) => p && p.step);
  const m = listed ? /^FIRST, at another office:[\s\S]*?\bTHEN:\s*([\s\S]+)$/.exec(next) : null;
  return m ? `After those: ${m[1]}` : next;
}

function trackCardHtml(t) {
  const cls = TRACK_STATUS_CLASS[t.status] || "info";
  // Captured numbers — only the fields this track actually uses (NEM has no permit #).
  const captured = (t.captureFields || [])
    .filter((f) => f.key !== "trackingUrl" && t[f.key])
    .map((f) => `${esc(f.label.replace(/ \(once issued\)/, ""))}: <strong>${esc(t[f.key])}</strong>`)
    .join(" &nbsp;·&nbsp; ");
  const trackLink = t.trackingUrl
    ? `<a href="${esc(t.trackingUrl)}" target="_blank" rel="noopener">status page ↗</a>`
    : "";
  const submitted = t.status !== "not_started" && t.status !== "staged";
  const fieldsHtml = (t.captureFields || []).map((f) =>
    `<label class="track-field"><span>${esc(f.label)}</span><input data-track-field="${esc(f.key)}" data-track="${esc(t.type)}" placeholder="${esc(f.placeholder)}" value="${esc(t[f.key] || "")}" /></label>`,
  ).join("");

  // Linear record flow — shown when the bot has no recipe for this track's portal,
  // so the operator can teach it right from the card (no need to scroll to the
  // general "Record this portal" section at the bottom of the stage).
  const recipeStatusLabel = t.recipeStatus === "complete" ? "recorded ✓"
    : t.recipeStatus === "needs_rerecord" ? "needs re-record"
    : t.recipeStatus === "recording" ? "recording in progress"
    : null;
  const recipeBlock = t.hasRecipe
    ? `<div class="track-recipe track-recipe--has" data-track-type="${esc(t.type)}">
        <span class="track-recipe-badge ${t.recipeStatus === "complete" ? "badge-ok" : "badge-warn"}">
          <i data-lucide="${t.recipeStatus === "complete" ? "check-circle-2" : "alert-circle"}"></i>
          Bot recipe: ${esc(recipeStatusLabel)}
        </span>
        <button type="button" class="ghost" data-track-review-recipe="${esc(t.type)}" title="Open the recipe detail to review or revise the recorded steps"><i data-lucide="eye"></i><span>Review recording</span></button>
        ${t.recipeStatus === "recording" && t.recipeId ? `<button type="button" class="secondary" data-track-finish-recipe="${esc(t.recipeId)}" title="You've verified (and fixed) the captured fill in the review browser — save it as the replayable recipe and close the review browser"><i data-lucide="check-circle-2"></i><span>Recording looks right — save recipe</span></button>` : ""}
      </div>`
    : `<div class="track-recipe track-recipe--none" data-track-type="${esc(t.type)}">
        ${t.borrowedRecipe
          // NO RECIPE OF ITS OWN, BUT THE LAST RUN BORROWED ONE (operator 09-28: "if we're using the Coos
          // Bay recipe can we make it say that somewhere?"). Say whose, for which record type.
          ? `<span class="track-recipe-badge badge-ok" title="This jurisdiction has no recording of its own. Stage replayed a recording learned for ${esc(t.borrowedRecipe.learnedFor)} on the same portal (${esc(t.borrowedRecipe.portalHost)}), bound to this project's data. Check every jurisdiction-specific answer before submitting.">
              <i data-lucide="copy-check"></i> Bot recipe: borrowed from ${esc(t.borrowedRecipe.learnedFor)}${t.borrowedRecipe.recordType ? ` (${esc(t.borrowedRecipe.recordType)}${t.borrowedRecipe.recipeVersion ? `, v${esc(t.borrowedRecipe.recipeVersion)}` : ""})` : ""}
            </span>
            <span class="muted" style="font-size:11px">Same portal, used on this project's last run. Record one for ${esc(t.label.replace(/\s*\x28.*$/, ""))} below if its steps differ.</span>`
          : `<span class="track-recipe-badge badge-none"><i data-lucide="circle-dashed"></i> No bot recipe yet</span>`}
        <div class="track-record-steps">
          <button type="button" class="secondary" data-track-open-recorder="${esc(t.type)}" data-scope="${esc(t.recipeScopeType || "ahj")}" title="Launch a browser session to record this portal — the bot will replay it on future projects"><i data-lucide="play"></i><span>Open recorder</span></button>
          <span class="track-record-arrow muted">→</span>
          <span class="track-record-hint muted">complete the form in the browser, type <code>save</code></span>
          <span class="track-record-arrow muted">→</span>
          <span class="track-record-hint muted">saved &amp; replayed for future projects in this AHJ/utility</span>
        </div>
      </div>`;

  return `
  <article class="item ${cls} track-card">
    <div class="item-title">
      <span>${esc(t.label)}</span>
      ${statusBadge(t.statusLabel)}
    </div>
    ${offToolChannelHtml(t)}
    ${trackChannelHtml(t)}
    ${trackPrerequisitesHtml(t)}
    <p style="margin:0 0 6px;font-size:12px">→ ${linkifyText(trackNextActionText(t))}</p>
    ${captured ? `<p style="margin:0 0 4px">${captured} ${trackLink ? "&nbsp;·&nbsp; " + trackLink : ""}</p>` : (trackLink ? `<p style="margin:0 0 4px">${trackLink}</p>` : "")}
    ${t.recipeId && (t.recipeStatus === "complete" || t.recipeStatus === "recording")
      && !screenshotMisses.has(screenshotKey(state.selectedProjectId, t.recipeId, t.recipeStatus))
      ? `<div style="margin:6px 0 4px" data-shot-wrap><a href="/api/projects/${esc(state.selectedProjectId)}/portal-runs/${esc(t.recipeId)}/review-screenshot" target="_blank" rel="noopener" title="Open the full-size capture"><img src="/api/projects/${esc(state.selectedProjectId)}/portal-runs/${esc(t.recipeId)}/review-screenshot" alt="Auto-captured portal page" class="review-shot" style="max-width:100%;border:1px solid var(--border);border-radius:var(--radius-sm)" data-shot-key="${esc(screenshotKey(state.selectedProjectId, t.recipeId, t.recipeStatus))}" onerror="window.__noteMissingReviewShot(this)" /></a><p class="muted" style="font-size:11px;margin:2px 0 0">${t.recipeStatus === "complete" ? "Portal review screen (auto-captured) — click for full size" : "Last captured page — recording not complete. If this is a login page, add this portal's login under “Manage logins” and re-stage."}</p></div>` : ""}
    <div class="track-actions">
      <button type="button" class="secondary" data-track-stage="${esc(t.type)}" title="Auto-fill this filing's portal up to the final review screen — you submit manually"><i data-lucide="bot"></i><span>Stage in portal</span></button>
      <button type="button" class="secondary" data-track-approve="${esc(t.type)}" title="Your approval of THIS run lets the bot click the portal's application submit (needs the server switch PORTAL_ALLOW_FINAL_SUBMIT=1 and a recipe recorded through submit; otherwise it stages to review for you). Never pays fees; stops for CAPTCHA/MFA."><i data-lucide="check-check"></i><span>Approve &amp; auto-submit</span></button>
    </div>
    ${recipeBlock}
    <details class="track-submit"${t.status === "staged" ? " open" : ""}>
      <summary>${submitted ? "Update numbers / status link" : "I submitted it → capture #"}</summary>
      <div class="track-submit-form">
        ${fieldsHtml}
        <button type="button" class="primary" data-track-submit="${esc(t.type)}"><i data-lucide="check"></i><span>Save &amp; track</span></button>
      </div>
    </details>
  </article>`;
}

/** "Utility — <program>" from the utility track's own label; "interconnection" when the label
 *  does not say (an older server, or a track that is not the utility's). Never "NEM" by default. */
function utilityGroupTitle(utilityTracks) {
  const label = String((utilityTracks && utilityTracks[0] && utilityTracks[0].label) || "");
  const m = /^utility\s+(.+)$/i.exec(label.trim());
  // The program name after " — " (e.g. "— Small PV Program") belongs to the card, not the group.
  const phrase = m ? m[1].split(" — ")[0].trim() : "";
  return `Utility — ${phrase || "interconnection"}`;
}

function renderSubmittalTracks() {
  const tracks = state.submittalTracks;
  const wrap = $("submittalTracks");
  const statusBadgeEl = $("submittalTracksStatus");
  if (!wrap) return;
  if (!tracks || !tracks.length) {
    if (statusBadgeEl) statusBadgeEl.textContent = "—";
    wrap.innerHTML = `<p class="muted">No submittal tracks resolved yet.</p>`;
    return;
  }
  const issued = tracks.filter((t) => t.status === "issued").length;
  if (statusBadgeEl) statusBadgeEl.textContent = `${issued}/${tracks.length} issued`;

  // Group utility (NEM) and AHJ permit tracks so the two are easy to tell apart and
  // can be worked in either order (do NEM first, then permits, or vice-versa).
  const utility = tracks.filter((t) => t.category === "utility");
  const permits = tracks.filter((t) => t.category === "permit");
  const group = (title, list) => list.length
    ? `<div class="track-group"><div class="track-group-head">${esc(title)}</div>${list.map(trackCardHtml).join("")}</div>`
    : "";
  // THE UTILITY GROUP IS HEADED BY THE TRACK'S OWN PROGRAM (e2e-gap close, 2026-09-26): "Net
  // Metering (NEM)" was hard-coded for every utility — Texas (Oncor) and SRP jobs have no utility
  // net metering. The server's card label says what the program IS (utilityFilingLookup:
  // "Utility net metering (NEM) / interconnection", "… interconnection + export credit (net
  // billing …)", "… interconnection only …", or "… (net-metering program not yet confirmed)");
  // the header repeats that phrase and falls back to the neutral "interconnection".
  wrap.innerHTML = group(utilityGroupTitle(utility), utility) + group("AHJ — Permit(s)", permits);

  wrap.querySelectorAll("button[data-track-submit]").forEach((btn) => {
    btn.addEventListener("click", () => markSubmittalTrack(btn.dataset.trackSubmit));
  });
  wrap.querySelectorAll("button[data-track-approve]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!confirm("Approve & auto-submit this filing?\n\nThis is your approval of THIS run, recorded under your name: with the server's PORTAL_ALLOW_FINAL_SUBMIT switch on and a recipe recorded through submit, the bot clicks the portal's application submit (never fee payment) and stops for any CAPTCHA/MFA. If the switch is off or the recipe stops short, it stages to the review screen for you to submit.")) return;
      stageSubmittalTrack(btn.dataset.trackApprove, btn, true);
    });
  });
  wrap.querySelectorAll("button[data-track-stage]").forEach((btn) => {
    btn.addEventListener("click", () => stageSubmittalTrack(btn.dataset.trackStage, btn));
  });
  wrap.querySelectorAll("button[data-track-open-recorder]").forEach((btn) => {
    btn.addEventListener("click", () => launchTrackRecorder(btn.dataset.trackOpenRecorder, btn.dataset.scope, btn));
  });
  wrap.querySelectorAll("button[data-track-finish-recipe]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api(`/api/portal-recipes/${btn.dataset.trackFinishRecipe}/finish`, {
          method: "POST",
          body: JSON.stringify({ clientId: state.detail?.project?.clientId || "" }),
        });
        showMessage("Recipe saved — the bot will replay this portal automatically for future projects. Review browser closed.", "info");
        await loadSubmittalTracks();
        renderDetail();
      } catch (err) {
        showMessage(err.message || "Could not save the recipe.", "error");
        btn.disabled = false;
      }
    });
  });
  wrap.querySelectorAll("button[data-track-review-recipe]").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Navigate to the Recipes section so the operator can review recorded steps.
      const track = (state.submittalTracks || []).find((t) => t.type === btn.dataset.trackReviewRecipe);
      if (track?.recipeId) {
        window.open(`${window.location.origin}/#recipes`, "_blank");
      } else {
        showMessage("No saved recipe found for this track.", "warning");
      }
    });
  });
  if (window.lucide) window.lucide.createIcons();
}

async function stageSubmittalTrack(type, btn, autoSubmit = false) {
  if (!state.selectedProjectId || !type) return;
  if (btn) { btn.disabled = true; }
  showMessage(autoSubmit
    ? `Approving ${humanize(type)} — replaying the portal; it will submit only if this portal is trusted, and never pays fees…`
    : `Staging ${humanize(type)} in its portal — automation stops at the final review screen for your manual submit…`, "info");
  try {
    // Staging runs as a background job (202 + jobId); poll to completion, then refetch detail.
    const { jobId } = await api(`/api/projects/${state.selectedProjectId}/prepare-submission`, {
      method: "POST", body: JSON.stringify({ track: type, autoSubmit }),
    });
    const job = await waitForStagingJob(jobId);
    if (job.status === "failed") {
      showMessage(job.error || `Could not stage ${type}.`, "error");
      return;
    }
    // The job can COMPLETE while the recorded portal run itself failed (login error,
    // wrong-portal gate, learn failure) — surface the run's reason instead of a
    // false "staged to final review" success message.
    if (job.result && job.result.status === "failed") {
      showMessage(`Could not stage ${humanize(type)}: ${job.result.message || "see the run log on the project for details."}`, "error");
      await loadSubmittalTracks();
      renderDetail();
      return;
    }
    // An MFA/CAPTCHA pause staged NOTHING — the "staged to final review" success toast
    // would send the operator hunting for an application that doesn't exist.
    if (job.result && job.result.status === "paused_for_human") {
      showMessage(job.result.message
        ? `${humanize(type)} run paused for you: ${job.result.message}`
        : `${humanize(type)} run paused at a ${job.result.pauseReason || "verification"} challenge — nothing was staged. Complete the challenge in the open browser, then re-stage.`, "warning");
      await loadSubmittalTracks();
      renderDetail();
      return;
    }
    const detail = await api(`/api/projects/${state.selectedProjectId}`);
    if (detail && detail.project) state.detail = detail;
    await loadSubmittalTracks();
    renderDetail();
    showMessage(job.result && job.result.status === "submitted"
      ? `${humanize(type)} submitted by the bot under your approval of this run (application submit only — no fees paid). Capture/verify the record number below.`
      : `${humanize(type)} staged to final review. Verify every field, then submit manually in the portal and capture the number here.`, "info");
  } catch (err) {
    showMessage(err.message || `Could not stage ${type}.`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ----- Autopilot: autonomous run to the single human-approval gate -----
function applyAutopilotState(s) {
  if (!s) return;
  // Server blocker details are whole sentences ending in a period; joining them with "; "
  // printed ".;". One list, one final period. Local, because test harnesses lift this function.
  const reasonList = (details) => {
    const parts = (details || []).map((d) => String(d || "").trim().replace(/[.;\s]+$/, "")).filter(Boolean);
    return parts.length ? `${parts.join("; ")}.` : "";
  };
  // A late answer for a project the operator has already left must not paint this one.
  if (s.projectId && state.selectedProjectId && s.projectId !== state.selectedProjectId) return;
  state.autopilot = s;
  // An answer arrived for THIS project: the "did not load" line is no longer true.
  const loadFailedEl = $("autopilotLoadFailed");
  if (loadFailedEl) { loadFailedEl.textContent = ""; loadFailedEl.hidden = true; }
  const badge = $("autopilotStatus");
  if (badge) {
    badge.textContent = s.stage || s.phase || "idle";
    badge.title = s.message || "";
  }
  const approveBtn = $("approveSubmitBtn");
  if (approveBtn) {
    approveBtn.disabled = !s.canApprove;
    const approveOff = s.canApprove ? "" : (s.approveDisabledReason
      || (s.blockers && s.blockers.length
        ? `Blocked: ${reasonList(s.blockers.map((b) => b.detail))}`
        : "Available once the project is staged to the portal review screen."));
    approveBtn.title = s.canApprove
      ? "Authorize and file. The system completes the portal submit (or you finish it in the portal)."
      : approveOff;
    if (approveBtn.dataset) approveBtn.dataset.disabledReason = approveOff;
  }
  // S8 — "Stage portals" is switched off when the server says a run would do nothing useful
  // (operator block, a run in flight, past Submit, every track already staged or filed), and
  // the reason is shown as text below. An older server that does not send canStage leaves the
  // button as it was.
  const stageBtnGate = $("startAutopilotBtn");
  if (stageBtnGate && typeof s.canStage === "boolean") {
    stageBtnGate.disabled = !s.canStage;
    const stageOff = s.canStage ? "" : (s.stageDisabledReason || "Staging is not available right now.");
    stageBtnGate.title = s.canStage ? "Stage every required filing to its portal review screen. Automation never clicks the final submit." : stageOff;
    if (stageBtnGate.dataset) stageBtnGate.dataset.disabledReason = stageOff;
  }
  const offEl = $("autopilotOffReasons");
  if (offEl && typeof offEl.replaceChildren === "function") {
    const lines = [];
    if (typeof s.canStage === "boolean" && !s.canStage) lines.push(`Stage portals is off: ${s.stageDisabledReason || "staging is not available right now."}`);
    if (!s.canApprove && s.approveDisabledReason) lines.push(`Approve & Submit is off: ${s.approveDisabledReason}`);
    offEl.replaceChildren(...lines.map((line) => { const li = document.createElement("li"); li.textContent = line; return li; }));
    offEl.hidden = lines.length === 0;
  }
  // The autopilot state carries the FULL next-step answer too; keep the banner current on
  // every poll (same project only — checked above).
  if (s.nextStep && s.nextStep.key && (!s.projectId || s.projectId === state.selectedProjectId)) {
    state.nextStep = s.nextStep;
    state.nextStepProjectId = s.projectId || state.selectedProjectId;
    rememberGateAnswer(state.nextStepProjectId, s.nextStep);
  }
  if (state.detail && state.detail.project) safeRender("nextStep", renderNextStep);
  if (state.detail && state.detail.project) safeRender("statusBox", renderStatusBox);
  // THE BADGE'S REASON, AS VISIBLE TEXT. "Blocked" with its cause only in a tooltip read as a
  // bare verdict — and the banner beside it said the gate "runs automatically". The reason is
  // written with textContent (blocker details and messages are server prose, never markup).
  // Display only: which buttons are enabled is decided above, unchanged.
  const reasonEl = $("autopilotReason");
  if (reasonEl) {
    const blockers = Array.isArray(s.blockers) ? s.blockers : [];
    let reason = "";
    if (!s.canApprove && blockers.length) {
      reason = `Why ${String(s.stage || s.phase || "blocked").toLowerCase()}: ${reasonList(blockers.map((b) => b.detail))}`;
    } else if (s.phase === "failed") {
      reason = `Autopilot failed: ${s.message || "no reason was recorded"}`;
    }
    reasonEl.textContent = reason;
    reasonEl.title = reason; // the rail clamps it to two lines; the full list is also the red blocker card
    reasonEl.hidden = !reason;
  }
  // ONE PRIMARY ACTION. Once a project is in Track/Closeout, re-staging is not the next step,
  // so "Stage portals" drops to a secondary button. Class only — whether it can be clicked is
  // unchanged (that is server change S8).
  const stageBtn = $("startAutopilotBtn");
  if (stageBtn && state.detail && Number.isInteger(state.detail.stageIndex)) {
    const demote = state.detail.stageIndex >= 3;
    stageBtn.classList.toggle("secondary", demote);
    stageBtn.classList.toggle("primary", !demote);
  }
  // Show review-screen mismatch warning when the portal form doesn't match the project.
  const banner = $("reviewMismatchBanner");
  const mismatchList = $("reviewMismatchList");
  if (banner && mismatchList) {
    const mismatches = Array.isArray(s.reviewMismatches) ? s.reviewMismatches : [];
    if (mismatches.length > 0 && s.phase === "awaiting_approval") {
      mismatchList.textContent = mismatches
        .map((m) => `${m.field}: expected "${m.expected}" — portal shows "${m.found}"`)
        .join(" | ");
      banner.style.display = "";
    } else {
      banner.style.display = "none";
    }
  }
  // WHAT THE PERSON TAKING THE REVIEW PAGE MUST KNOW (dryrun-0928 B3 / B14): answers the portal may
  // not have saved when automation handed over, and the portal's own background calls the review
  // lockdown held back (a section may render incomplete). Its own banner — never folded into the
  // mismatch list. textContent only: the notes carry portal paths, never markup.
  const handoffBanner = $("reviewHandoffBanner");
  const handoffList = $("reviewHandoffList");
  if (handoffBanner && handoffList) {
    const notes = Array.isArray(s.reviewHandoffNotes) ? s.reviewHandoffNotes.filter((n) => typeof n === "string" && n.trim()) : [];
    if (notes.length > 0 && s.phase === "awaiting_approval") {
      handoffList.textContent = notes.join(" | ");
      handoffBanner.style.display = "";
    } else {
      handoffBanner.style.display = "none";
    }
  }
  // Advise the operator about required fields the gap-fill left blank (no project data).
  const gapBanner = $("gapFillBanner");
  const gapList = $("gapFillList");
  if (gapBanner && gapList) {
    // TWO LISTS, TWO DIFFERENT JOBS. `gapFillMissing` is data the project genuinely lacks
    // — the operator adds it and re-stages. `gapEngineUnfilled` is data the project ALREADY
    // HAS that the engine failed to place; sending someone to "add it to the project" is
    // sending them to redo finished work, which is what the single list was doing.
    const missing = Array.isArray(s.gapFillMissing) ? s.gapFillMissing : [];
    const engineGaps = Array.isArray(s.gapEngineUnfilled) ? s.gapEngineUnfilled : [];
    if ((missing.length > 0 || engineGaps.length > 0) && s.phase === "awaiting_approval") {
      const parts = [];
      if (missing.length) parts.push(`Add to the project, then re-stage: ${missing.join(" | ")}`);
      if (engineGaps.length) parts.push(`Already on the project — fill these on the review screen, no project edit needed: ${engineGaps.join(" | ")}`);
      gapList.textContent = parts.join(" — ");
      gapBanner.style.display = "";
    } else {
      gapBanner.style.display = "none";
    }
  }
}

// THE RAIL WITH NO ANSWER. Every element applyAutopilotState paints, put back to neutral:
// both buttons OFF with no reason, the badge "idle", the reason lines and the two banners
// hidden and empty. Used when the rail's answer is not this project's — on switching project
// (the last project's canStage/canApprove must not carry over) and when this project's state
// fails to load. OFF, not the HTML default: an unknown must not read as "Stage is available".
function resetAutopilotRail() {
  state.autopilot = null;
  for (const id of ["startAutopilotBtn", "approveSubmitBtn"]) {
    const btn = $(id);
    if (!btn) continue;
    btn.disabled = true;
    btn.title = "";
    if (btn.dataset) btn.dataset.disabledReason = "";
  }
  const badge = $("autopilotStatus");
  if (badge) { badge.textContent = "idle"; badge.title = ""; }
  const offEl = $("autopilotOffReasons");
  if (offEl) {
    if (typeof offEl.replaceChildren === "function") offEl.replaceChildren();
    offEl.hidden = true;
  }
  const reasonEl = $("autopilotReason");
  if (reasonEl) { reasonEl.textContent = ""; reasonEl.hidden = true; }
  for (const id of ["reviewMismatchBanner", "reviewHandoffBanner", "gapFillBanner"]) {
    const el = $(id);
    if (el && el.style) el.style.display = "none";
  }
  for (const id of ["reviewMismatchList", "reviewHandoffList", "gapFillList"]) {
    const el = $(id);
    if (el) el.textContent = "";
  }
  // Also neutral: a "did not load" line is about the project it was written for, never the next.
  const loadFailedEl = $("autopilotLoadFailed");
  if (loadFailedEl) { loadFailedEl.textContent = ""; loadFailedEl.hidden = true; }
}

// The rail went neutral because THIS project's state did not arrive. Off-with-no-reason read as a
// verdict ("nothing to stage"); this line says it is an unknown. There is no retry loop — the next
// refresh (or a project re-open) asks again, and a state that arrives clears the line.
const AUTOPILOT_LOAD_FAILED_TEXT = "Autopilot state did not load — refresh the page";

async function refreshAutopilot() {
  const pid = state.selectedProjectId;
  if (!pid) return;
  try {
    const { state: s } = await api(`/api/projects/${pid}/autopilot`);
    applyAutopilotState(s);
  } catch {
    // No answer for this project: never leave another project's (or a stale) verdict up. A
    // late failure must not wipe a state that arrived after it, nor a project since left.
    if (state.selectedProjectId === pid && !(state.autopilot && state.autopilot.projectId === pid)) {
      resetAutopilotRail();
      const loadFailedEl = $("autopilotLoadFailed");
      if (loadFailedEl) { loadFailedEl.textContent = AUTOPILOT_LOAD_FAILED_TEXT; loadFailedEl.hidden = false; }
    }
  }
}

async function pollAutopilot(tries = 12) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const { state: s } = await api(`/api/projects/${state.selectedProjectId}/autopilot`);
      applyAutopilotState(s);
      if (s.phase !== "running") {
        if (state.detail) state.detail = await api(`/api/projects/${state.selectedProjectId}`);
        renderDetail();
        return s;
      }
    } catch { /* keep polling */ }
  }
  return null;
}

async function startAutopilot() {
  if (!state.selectedProjectId) return;
  const btn = $("startAutopilotBtn");
  btn.disabled = true;
  showMessage("Autopilot started — running QC, build, reviewer gate, and staging to the portal review screen…", "info");
  try {
    await api(`/api/projects/${state.selectedProjectId}/autopilot/start`, { method: "POST", body: "{}" });
    const s = await pollAutopilot();
    if (s && s.phase === "awaiting_approval") showMessage("Staged to portal review. Verify, then click Approve & Submit to file.", "info");
    else if (s && s.phase === "blocked") showMessage(`Autopilot blocked: ${(s.blockers || []).map((b) => String(b.detail || "").trim().replace(/[.;\s]+$/, "")).filter(Boolean).join("; ")}.`, "error");
    else if (s && s.phase === "failed") showMessage(s.message || "Staging failed — see the portal run.", "error");
  } catch (err) {
    showMessage(err.message || "Could not start autopilot.", "error");
  } finally {
    // Re-enable only what the server allows: canStage is re-applied from the newest state
    // (applyAutopilotState ran during the poll), not blindly switched back on.
    btn.disabled = Boolean(state.autopilot && state.autopilot.canStage === false);
  }
}

async function approveAndSubmit() {
  if (!state.selectedProjectId) return;
  if (!confirm("Authorize this regulatory submission? This records your approval and files (or stages for your final click in) the portal.")) return;
  const btn = $("approveSubmitBtn");
  btn.disabled = true;
  showMessage("Approval recorded — completing the portal submission…", "info");
  try {
    const { state: s } = await api(`/api/projects/${state.selectedProjectId}/autopilot/approve`, { method: "POST", body: "{}" });
    applyAutopilotState(s);
    if (state.detail) state.detail = await api(`/api/projects/${state.selectedProjectId}`);
    renderDetail();
    // A toast disappears; the banner renderDetail just drew does not. Say the same thing both
    // places and point at the banner, so an operator who blinks still has the instruction.
    showMessage(s.phase === "submitted"
      ? "Approved & submitted — confirmation captured."
      : "Approval recorded — NOT submitted. Open the portal, click its submit yourself, then use Capture Confirmation. The banner at the top of this project keeps the instruction.", "warning");
  } catch (err) {
    showMessage(err.message || "Could not approve.", "error");
    btn.disabled = !(state.autopilot && state.autopilot.canApprove);
  }
}

async function markSubmittalTrack(type) {
  if (!state.selectedProjectId || !type) return;
  const field = (name) => {
    const el = document.querySelector(`[data-track-field="${name}"][data-track="${type}"]`);
    return (el?.value || "").trim();
  };
  const body = {
    applicationNumber: field("applicationNumber"),
    permitNumber: field("permitNumber"),
    confirmationNumber: field("confirmationNumber"),
    trackingUrl: field("trackingUrl"),
  };
  try {
    const res = await api(`/api/projects/${state.selectedProjectId}/submittal-tracks/${type}/mark-submitted`, {
      method: "POST", body: JSON.stringify(body),
    });
    state.submittalTracks = res.tracks || state.submittalTracks;
    // Reload the full project so the status strip, submissions, permit/NEM trackers, and
    // process map reflect the save — not just the tracks panel. (Previously the save
    // persisted but the rest of the page stayed stale.)
    state.detail = await api(`/api/projects/${state.selectedProjectId}`);
    await loadProcessMap();
    renderDetail();
    showMessage(`${humanize(type)} marked submitted — now tracking through to issuance.`, "info");
  } catch (err) {
    showMessage(err.message || "Could not save submittal track.", "error");
  }
}

async function generateIntakeLink() {
  if (!state.selectedProjectId) return;
  const out = $("intakeLinkOut");
  const btn = $("genIntakeLinkBtn");
  if (btn) btn.disabled = true;
  try {
    const res = await api(`/api/projects/${state.selectedProjectId}/intake-request`, { method: "POST", body: "{}" });
    const url = res.url || (location.origin + res.path);
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch (_) { /* clipboard may be blocked */ }
    if (out) out.innerHTML = `${copied ? "✅ Copied to clipboard. " : ""}<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
    const qCount = (res.questions || []).length;
    const qNote = qCount ? ` It also asks the ${qCount} portal question${qCount === 1 ? "" : "s"} this project can't answer yet.` : "";
    showMessage((copied ? "Intake link copied — paste it into an email to the installer." : "Intake link generated.") + qNote);
  } catch (e) {
    if (out) out.textContent = "Failed to generate link: " + (e.message || e);
  } finally {
    if (btn) btn.disabled = false;
    if (window.lucide) window.lucide.createIcons();
  }
}

function renderOpsBrief() {
  const brief = state.opsBrief;
  if (!brief) {
    $("opsBriefStatus").textContent = "not synced";
    $("opsBrief").innerHTML = `<p class="muted">Open or sync a project to generate the PM brief.</p>`;
    $("copyHandoffBtn").disabled = true;
    return;
  }
  $("copyHandoffBtn").disabled = !brief.handoffNote;
  $("opsBriefStatus").textContent = humanize(brief.health);
  const counts = brief.counts || {};
  const actions = brief.immediateActions || [];
  const blockers = brief.blockers || [];
  const ready = brief.readySignals || [];
  const activity = brief.recentActivity || [];
  $("opsBrief").innerHTML = `
    <article class="item ${briefClass(brief.health)}">
      <div class="item-title"><span>${esc(brief.headline)}</span>${statusBadge(brief.currentPhase)}</div>
      <p><strong>Next action:</strong> ${esc(brief.nextAction)}</p>
      <div class="ops-status-strip">
        <span>${counts.blocked || 0} blocked</span>
        <span>${counts.waiting || 0} waiting</span>
        <span>${counts.in_progress || 0} active</span>
        <span>${counts.not_started || 0} not started</span>
        <span>${counts.done || 0} done</span>
      </div>
    </article>
    <div class="brief-grid">
      <article class="brief-section">
        <div class="item-title"><span>Action Queue</span>${statusBadge(actions.length)}</div>
        ${actions.length ? actions.map((item) => `
          <div class="brief-row ${opsClass(item.status)}">
            <strong>${esc(item.phaseName)}</strong>
            <p>${esc(item.action)}</p>
            <span>${esc(item.ownerRole || "Unassigned")}${item.dueAt ? ` | Due ${esc(item.dueAt)}` : ""}</span>
          </div>
        `).join("") : `<p class="muted">No active actions. Keep monitoring approvals and email.</p>`}
      </article>
      <article class="brief-section">
        <div class="item-title"><span>Blockers</span>${statusBadge(blockers.length)}</div>
        ${blockers.length ? blockers.map((item) => `
          <div class="brief-row ${briefClass(item.severity)}">
            <strong>${esc(item.title)}</strong>
            <p>${esc(item.detail)}</p>
            <span>${esc(item.source)}</span>
          </div>
        `).join("") : `<p class="muted">No blockers currently flagged.</p>`}
      </article>
      <article class="brief-section">
        <div class="item-title"><span>Ready Signals</span>${statusBadge(ready.length)}</div>
        ${ready.length ? ready.slice(0, 6).map((item) => `
          <div class="brief-row ${briefClass(item.severity)}">
            <strong>${esc(item.title)}</strong>
            <p>${esc(item.detail)}</p>
            <span>${esc(item.source)}</span>
          </div>
        `).join("") : `<p class="muted">Run workflow/QC/reviewer/docs to build ready signals.</p>`}
      </article>
      <article class="brief-section">
        <div class="item-title"><span>Recent Activity</span>${statusBadge(activity.length)}</div>
        ${activity.length ? activity.slice(0, 6).map((item) => `
          <div class="brief-row ${briefClass(item.severity)}">
            <strong>${esc(item.title)}</strong>
            <p>${esc(item.detail)}</p>
            <span>${esc(fmtDate(item.occurredAt))} | ${esc(item.source)}</span>
          </div>
        `).join("") : `<p class="muted">No recent activity yet.</p>`}
      </article>
    </div>
  `;
}

function renderRunbook() {
  const runbook = state.runbook;
  if (!runbook) {
    $("runbookStatus").textContent = "not synced";
    $("runbook").innerHTML = `<p class="muted">Open a project to generate the PM runbook.</p>`;
    $("copyRunbookBtn").disabled = true;
    return;
  }
  $("copyRunbookBtn").disabled = !runbook.reportText;
  $("runbookStatus").textContent = humanize(runbook.status);
  const steps = runbook.steps || [];
  const notes = runbook.recentNotes || [];
  const currentStep = steps.find((step) => step.isCurrent) || steps.find((step) => ["blocked", "waiting", "in_progress", "not_started"].includes(step.status));
  $("runbook").innerHTML = `
    <article class="item ${opsClass(runbook.status)}">
      <div class="item-title"><span>${esc(runbook.headline)}</span>${statusBadge(`${runbook.doneCount || 0}/${runbook.totalSteps || 0} done`)}</div>
      <p><strong>Next action:</strong> ${esc(runbook.nextAction)}</p>
      <div class="ops-status-strip">
        <span>${runbook.blockedCount || 0} blocked</span>
        <span>${runbook.waitingCount || 0} waiting</span>
        <span>${runbook.inProgressCount || 0} active</span>
        <span>${runbook.noteCount || 0} notes</span>
      </div>
      ${currentStep ? `
        <div class="runbook-current-update">
          <div class="item-title"><span>Current Step Update</span>${statusBadge(currentStep.phaseName)}</div>
          <div class="runbook-update-controls">
            <label>Status<select id="runbookQuickStatus">${opsStatusOptions(currentStep.status)}</select></label>
            <label>Owner<input id="runbookQuickOwner" value="${esc(currentStep.ownerRole || "Operations")}" /></label>
            <label>Due<input id="runbookQuickDue" type="date" value="${esc(currentStep.dueAt || "")}" /></label>
            <button id="runbookQuickSaveBtn" class="primary" type="button"><i data-lucide="save"></i><span>Save Current</span></button>
          </div>
          <textarea id="runbookQuickNotes" placeholder="PM note for the current step">${esc(currentStep.notes || "")}</textarea>
        </div>
      ` : ""}
    </article>
    <div class="runbook-steps">
      ${steps.map((step, index) => `
        <article class="runbook-step ${opsClass(step.status)} ${step.isCurrent ? "current" : ""}">
          <div class="item-title">
            <span>${index + 1}. ${esc(step.phaseName)}</span>
            ${statusBadge(step.isCurrent ? `${step.status.replaceAll("_", " ")} current` : step.status.replaceAll("_", " "))}
          </div>
          <p><strong>Do:</strong> ${esc(step.whatToDo)}</p>
          <p><strong>Why:</strong> ${esc(step.why)}</p>
          <p class="muted">${esc(step.ownerRole || "Operations")}${step.dueAt ? ` | Due ${esc(step.dueAt)}` : ""} | ${esc(step.source)}</p>
          ${(step.doneCriteria || []).length ? `<div class="done-criteria"><strong>Done when</strong><ul>${step.doneCriteria.map((line) => `<li>${esc(line)}</li>`).join("")}</ul></div>` : ""}
          ${(step.evidence || []).length ? `<ul class="evidence-list">${step.evidence.slice(0, 4).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
          ${step.notes ? `<p><strong>PM note:</strong> ${esc(step.notes)}</p>` : ""}
        </article>
      `).join("")}
    </div>
    <div class="runbook-notes">
      <div class="item-title"><span>Recent PM Notes</span>${statusBadge(notes.length)}</div>
      ${notes.length ? notes.slice(0, 5).map((note) => `
        <article class="brief-row ${note.noteType === "blocker" ? "blocker" : "info"}">
          <strong>${esc(humanize(note.noteType))}</strong>
          <p>${esc(note.body)}</p>
          <span>${esc(note.createdBy || "Operations")} | ${esc(fmtDate(note.createdAt))}</span>
        </article>
      `).join("") : `<p class="muted">No PM notes yet.</p>`}
    </div>
  `;
  const quickSave = $("runbookQuickSaveBtn");
  if (quickSave) quickSave.addEventListener("click", saveRunbookCurrentStep);
}

function renderHandoffPacket() {
  const packet = state.handoffPacket;
  if (!packet) {
    $("handoffPacketStatus").textContent = "not synced";
    $("handoffPacket").innerHTML = `<p class="muted">Open a project to generate the project handoff packet.</p>`;
    $("copyHandoffPacketBtn").disabled = true;
    return;
  }
  $("copyHandoffPacketBtn").disabled = !packet.reportText;
  $("handoffPacketStatus").textContent = humanize(packet.health);
  const sections = packet.sections || [];
  $("handoffPacket").innerHTML = `
    <article class="item ${briefClass(packet.health)}">
      <div class="item-title"><span>${esc(packet.headline)}</span>${statusBadge(packet.readinessStatus.replaceAll("_", " "))}</div>
      <p><strong>Current:</strong> ${esc(packet.currentPhase)}<br><strong>Next:</strong> ${esc(packet.nextAction)}</p>
      <div class="ops-status-strip">
        <span>${packet.blockerCount || 0} blockers</span>
        <span>${packet.actionCount || 0} actions</span>
        <span>${packet.timelineEventCount || 0} events</span>
        <span>${(packet.ownerRoles || []).length} owners</span>
      </div>
      ${(packet.ownerRoles || []).length ? `<p class="muted">Owners: ${esc(packet.ownerRoles.join(", "))}</p>` : ""}
    </article>
    <div class="handoff-sections">
      ${sections.map((section) => `
        <article class="handoff-section ${briefClass(section.severity)}">
          <div class="item-title">
            <span>${esc(section.title)}</span>
            ${statusBadge(section.severity)}
          </div>
          ${(section.lines || []).length ? `<ul class="evidence-list">${section.lines.slice(0, 8).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : `<p class="muted">No items.</p>`}
          <p class="muted">${esc(section.source)}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function renderCommunicationDrafts() {
  const packet = state.communicationDrafts;
  if (!packet) {
    $("communicationDraftsStatus").textContent = "not synced";
    $("communicationDrafts").innerHTML = `<p class="muted">Open a project to generate communication drafts.</p>`;
    $("copyCommunicationDraftsBtn").disabled = true;
    return;
  }
  $("copyCommunicationDraftsBtn").disabled = !packet.reportText;
  $("communicationDraftsStatus").textContent = humanize(packet.status);
  const drafts = packet.drafts || [];
  $("communicationDrafts").innerHTML = `
    <article class="item ${briefClass(packet.status)}">
      <div class="item-title"><span>${esc(packet.headline)}</span>${statusBadge("draft only")}</div>
      <p><strong>Next action:</strong> ${esc(packet.nextAction)}</p>
      <p class="muted">Human review required before sending. The app does not send email or portal responses.</p>
    </article>
    <div class="communication-draft-list">
      ${drafts.map((draft, index) => `
        <article class="communication-draft ${briefClass(draft.severity)}">
          <div class="item-title">
            <span>${esc(draft.title)}</span>
            <button class="secondary compact-button" type="button" data-copy-draft="${index}"><i data-lucide="clipboard-copy"></i><span>Copy</span></button>
          </div>
          <p><strong>Subject:</strong> ${esc(draft.subject)}</p>
          <pre class="draft-body">${esc(draft.body)}</pre>
          <p class="muted">${esc(draft.audience.replaceAll("_", " "))} | ${esc(draft.source)}</p>
        </article>
      `).join("")}
    </div>
  `;
  $("communicationDrafts").querySelectorAll("button[data-copy-draft]").forEach((button) => {
    button.addEventListener("click", () => copyCommunicationDraft(Number(button.dataset.copyDraft)));
  });
}

function opsStatusOptions(selected) {
  return ["not_started", "in_progress", "waiting", "blocked", "done"]
    .map((status) => `<option value="${status}" ${status === selected ? "selected" : ""}>${status.replaceAll("_", " ")}</option>`)
    .join("");
}

function renderOpsPlan() {
  const plan = state.opsPlan;
  if (!plan) {
    $("opsPlanStatus").textContent = "not synced";
    $("opsPlan").innerHTML = `<p class="muted">Sync the operations plan to generate PM phases, owners, and next actions.</p>`;
    $("opsNotes").innerHTML = `<p class="muted">No PM notes yet.</p>`;
    return;
  }
  $("opsPlanStatus").textContent = humanize(plan.status);
  const counts = plan.counts || {};
  $("opsPlan").innerHTML = `
    <article class="item ${opsClass(plan.status)}">
      <div class="item-title"><span>Current phase: ${esc(plan.currentPhase)}</span>${statusBadge(plan.status)}</div>
      <p><strong>Next action:</strong> ${esc(plan.nextAction)}</p>
      <div class="ops-status-strip">
        <span>${counts.blocked || 0} blocked</span>
        <span>${counts.waiting || 0} waiting</span>
        <span>${counts.in_progress || 0} active</span>
        <span>${counts.not_started || 0} not started</span>
        <span>${counts.done || 0} done</span>
      </div>
    </article>
    <div class="ops-grid">
      ${(plan.steps || []).map((step) => `
        <article class="item ops-step ${opsClass(step.status)}">
          <div class="item-title"><span>${esc(step.phaseName)}</span>${statusBadge(step.statusSource === "manual" ? `${step.status} manual` : step.status)}</div>
          <p>${esc(step.summary)}</p>
          <p><strong>Next:</strong> ${esc(step.nextAction)}</p>
          <p class="muted">Owner: ${esc(step.ownerRole || "Unassigned")} ${step.dueAt ? `| Due ${esc(step.dueAt)}` : ""} | Source: ${esc(step.source)}</p>
          ${step.notes ? `<p><strong>PM note:</strong> ${esc(step.notes)}</p>` : ""}
          <div class="ops-controls">
            <label>Status<select id="ops-status-${step.id}">${opsStatusOptions(step.status)}</select></label>
            <label>Owner<input id="ops-owner-${step.id}" value="${esc(step.ownerRole || "")}" /></label>
            <label>Due<input id="ops-due-${step.id}" type="date" value="${esc(step.dueAt || "")}" /></label>
            <button class="secondary" data-ops-save="${step.id}"><i data-lucide="save"></i><span>Save</span></button>
          </div>
          <textarea id="ops-notes-${step.id}" placeholder="PM notes for this phase">${esc(step.notes || "")}</textarea>
        </article>
      `).join("")}
    </div>
  `;
  $("opsNotes").innerHTML = (plan.notes || []).length ? plan.notes.map((note) => `
    <article class="item ${note.noteType === "blocker" ? "blocker" : note.noteType === "client_update" ? "info" : "pass"}">
      <div class="item-title"><span>${esc(humanize(note.noteType))}</span><span class="muted" style="font-size:12px">${esc(fmtDate(note.createdAt))}</span></div>
      <p>${esc(note.body)}</p>
      <p class="muted">${esc(note.createdBy || "Operations")}</p>
    </article>
  `).join("") : `<p class="muted">No PM notes yet.</p>`;

  $("opsPlan").querySelectorAll("button[data-ops-save]").forEach((button) => {
    button.addEventListener("click", () => saveOpsStep(button.dataset.opsSave));
  });
}

function renderLiveTestReadiness() {
  const report = state.liveReadiness;
  if (!report) {
    $("liveReadinessCounts").textContent = "not synced";
    $("liveReadiness").innerHTML = `<p class="muted">Open a project to generate the live-test readiness report.</p>`;
    const copy = $("copyLiveReadinessBtn");
    if (copy) copy.disabled = true;
    return;
  }
  const copy = $("copyLiveReadinessBtn");
  if (copy) copy.disabled = !report.reportText;
  const items = report.items || [];
  const blocked = items.filter((i) => i.status === "blocked").length;
  const review = items.filter((i) => i.status !== "done" && i.status !== "blocked").length;
  // The counts are the whole panel while it is closed, so they must state the STAKE,
  // not a neutral "Details". A row that is neither done nor blocked is an open
  // question about this filing, and the summary says how many there are.
  const stake = [blocked ? `${blocked} blocked` : "", review ? `${review} need review` : ""].filter(Boolean).join(" · ");
  $("liveReadinessCounts").textContent = `${report.doneCount}/${report.totalCount} ready`;
  $("liveReadiness").innerHTML = `
    <details class="fold readiness-fold ${report.status === "blocked" ? "blocker" : report.status === "needs_review" ? "warning" : "pass"}">
      <summary>
        <strong>${esc(`${report.doneCount}/${report.totalCount} ready`)}</strong>${stake ? ` · ${esc(stake)}` : ""}
        ${statusBadge(report.status.replaceAll("_", " "))}
        <span class="fold-next">Next: ${esc(report.nextAction)}</span>
      </summary>
      <div class="fold-body">
        ${items.map((item) => {
          const done = item.status === "done";
          const evidence = (item.evidence || []).slice(0, 3);
          return `
        <div class="check-row ${done ? "present" : item.status === "blocked" ? "missing" : "needs_review"}">
          <strong>${esc(humanize(item.status).toUpperCase())}: ${esc(item.title)}</strong>
          <p>${esc(item.detail)}</p>
          ${done ? "" : `<p class="fold-next-row"><strong>Next:</strong> ${esc(item.nextAction)}</p>`}
          ${evidence.length
            // Evidence makes a claim checkable, so it is kept in full — but its
            // COUNT rides in the always-visible summary, and the absence of any
            // evidence is never hidden (see the else branch): a DONE row whose
            // backing is missing must not read as a verified one.
            ? `<details class="provenance"><summary>${esc(String(evidence.length))} evidence line${evidence.length === 1 ? "" : "s"}</summary>
                 <div class="provenance-body"><ul class="evidence-list">${evidence.map((line) => `<li>${esc(line)}</li>`).join("")}</ul><p class="muted">Source record: <span class="mono">${esc(item.source)}</span></p></div>
               </details>`
            : `<p class="muted readiness-noevidence">No evidence captured yet — nothing on file backs this row.</p>`}
        </div>`;
        }).join("")}
      </div>
    </details>
  `;
}

function renderProcessMap() {
  const map = state.processMap;
  if (!map) {
    $("processMapStatus").textContent = "not synced";
    $("processMap").innerHTML = `<p class="muted">Open a project to generate the PermitFlow + NEMflow map.</p>`;
    $("copyProcessMapBtn").disabled = true;
    return;
  }
  $("copyProcessMapBtn").disabled = !map.reportText;
  $("processMapStatus").textContent = humanize(map.status);
  $("processMap").innerHTML = `
    <article class="item ${opsClass(map.status)}">
      <div class="item-title"><span>${esc(map.headline)}</span>${(() => { const words = trackStateWords(state.submittalTracks); return words ? statusBadge(`Permit ${words.permit} / NEM ${words.nem}`) : ""; })()}</div>
      <p><strong>Next action:</strong> ${esc(map.nextAction)}</p>
    </article>
    <!-- The article above keeps BOTH track verdicts and the next action on
         screen. What collapses is the step-by-step expansion of them — two
         lanes of ~8 steps, each with its own summary, next action and
         provenance block, restating a pipeline the stage accordions already
         draw. The lane count and each lane's status ride in the summary, so a
         blocked lane is still visible while this is closed. -->
    <details class="fold process-fold">
      <summary><span>Step-by-step: ${(map.lanes || []).map((lane) => `${esc(lane.title)} — ${esc(humanize(lane.status))}`).join(" · ")}</span></summary>
    <div class="process-lanes fold-body">
      ${(map.lanes || []).map((lane) => `
        <article class="process-lane ${opsClass(lane.status)}">
          <div class="process-lane-head">
            <div>
              <strong>${esc(lane.title)}</strong>
              <span>${esc(lane.summary)}</span>
            </div>
            ${statusBadge(humanize(lane.status))}
          </div>
          <p><strong>Current:</strong> ${esc(lane.currentStep)}<br><strong>Next:</strong> ${esc(lane.nextAction)}</p>
          <div class="process-steps">
            ${(lane.steps || []).map((step) => `
              <div class="process-step ${opsClass(step.status)}">
                <div class="item-title"><span>${esc(step.label)}</span>${statusBadge(humanize(step.status))}</div>
                <p>${esc(step.summary)}</p>
                <p><strong>Next:</strong> ${esc(step.nextAction)}</p>
                <!-- ownerRole|source are internal routing keys ("Data QA |
                     qc.human_review"). They printed at the same size as the
                     next action, seventeen times on one page. -->
                <details class="provenance">
                  <summary>${esc(step.ownerRole)}</summary>
                  <div class="provenance-body">
                    <p>${esc(step.ownerRole)} | ${esc(step.source)}</p>
                    ${(step.evidence || []).length ? `<ul class="evidence-list">${step.evidence.slice(0, 2).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
                  </div>
                </details>
              </div>
            `).join("")}
          </div>
        </article>
      `).join("")}
    </div>
    </details>
  `;
}

function renderInstallerPacket() {
  const packet = state.installerPacket;
  if (!packet) {
    $("installerPacketStatus").textContent = "not synced";
    $("installerPacket").innerHTML = `<p class="muted">Open a project to generate installer/design action requests.</p>`;
    $("copyInstallerPacketBtn").disabled = true;
    return;
  }
  $("copyInstallerPacketBtn").disabled = !packet.reportText;
  $("installerPacketStatus").textContent = humanize(packet.status);
  const items = packet.items || [];
  $("installerPacket").innerHTML = `
    <article class="item ${packet.status === "blocked" ? "blocker" : packet.status === "needs_action" ? "warning" : "pass"}">
      <div class="item-title"><span>${esc(packet.headline)}</span>${statusBadge(`${packet.nemActionCount || 0} NEM`)}</div>
      <p><strong>Next action:</strong> ${esc(packet.nextAction)}</p>
      <div class="ops-status-strip">
        <span>${packet.blockerCount || 0} blockers</span>
        <span>${packet.warningCount || 0} warnings</span>
        <span>${packet.installerActionCount || 0} installer</span>
        <span>${packet.designActionCount || 0} design</span>
      </div>
    </article>
    <div class="installer-action-list">
      ${items.length ? items.slice(0, 18).map((item) => `
        <article class="installer-action ${briefClass(item.severity)}">
          <div class="item-title">
            <span>${esc(item.title)}</span>
            ${statusBadge(item.category.replaceAll("_", " "))}
          </div>
          <p><strong>Ask:</strong> ${esc(item.ask)}</p>
          <p><strong>Why:</strong> ${esc(item.why)}</p>
          <details class="provenance">
            <summary>${esc(item.ownerRole)} · due ${esc(item.dueBefore)}</summary>
            <div class="provenance-body">
              <p>${esc(item.ownerRole)} | ${esc(item.dueBefore)} | ${esc(item.source)}</p>
              ${(item.evidence || []).length ? `<ul class="evidence-list">${item.evidence.slice(0, 3).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
            </div>
          </details>
        </article>
      `).join("") : `<p class="muted">No installer/design actions are currently blocking the package.</p>`}
    </div>
  `;
}

// One timeline event. The DATE stays visible — a timeline without dates isn't
// one — but actor|source are internal provenance, and `evidence` is where the
// raw checkId/targetId UUIDs and raw Playwright failures ("locator.click:
// Timeout 30000ms exceeded") live. Those belong behind the disclosure: still
// there, still complete, no longer competing with the operator's next action.
function timelineEventCard(event) {
  const owner = event.ownerRole || "Operations";
  return `
      <article class="timeline-item ${briefClass(event.severity)}">
        <div class="item-title">
          <span>${esc(event.title)}</span>
          ${statusBadge(event.category.replaceAll("_", " "))}
        </div>
        <p>${esc(event.detail)}</p>
        <p class="timeline-meta">${esc(fmtDate(event.occurredAt))}</p>
        ${event.nextAction ? `<p><strong>Next:</strong> ${esc(event.nextAction)}</p>` : ""}
        <details class="provenance">
          <summary>Owner: ${esc(owner)}</summary>
          <div class="provenance-body">
            <p>${esc(fmtDate(event.occurredAt))} | ${esc(event.actor || "system")} | ${esc(event.source || "source")}</p>
            <p><strong>Owner:</strong> ${esc(owner)}</p>
            ${(event.evidence || []).length ? `<ul class="evidence-list">${event.evidence.slice(0, 3).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
          </div>
        </details>
      </article>`;
}

// Eight events at READ weight, the rest collapsed into one row. Twenty-four
// full-weight events — each with a meta line, an Owner/Next line and three
// evidence lines — was most of the page's length on its own.
function timelineEventCards(events) {
  const visible = events.slice(0, 8);
  const rest = events.slice(8);
  return visible.map(timelineEventCard).join("")
    + (rest.length
      ? `<details class="provenance"><summary>${rest.length} earlier event${rest.length === 1 ? "" : "s"}</summary><div class="provenance-body">${rest.map(timelineEventCard).join("")}</div></details>`
      : "");
}

function renderProjectTimeline() {
  const report = state.projectTimeline;
  if (!report) {
    $("timelineCounts").textContent = "not synced";
    $("projectTimeline").innerHTML = `<p class="muted">Project timeline has not loaded yet.</p>`;
    $("copyTimelineBtn").disabled = true;
    return;
  }
  $("copyTimelineBtn").disabled = !report.reportText;
  $("timelineCounts").textContent = `${report.totalEvents || 0} events`;
  const events = report.events || [];
  $("projectTimeline").innerHTML = `
    <article class="item ${report.blockerCount ? "blocker" : report.warningCount ? "warning" : "pass"}">
      <div class="item-title"><span>${esc(report.headline)}</span>${statusBadge(`${report.blockerCount || 0} blockers`)}</div>
      <p>${report.latestActivityAt ? `Latest activity: ${esc(new Date(report.latestActivityAt).toLocaleString())}` : "No activity recorded yet."}</p>
      <div class="ops-status-strip">
        <span>${report.totalEvents || 0} events</span>
        <span>${report.warningCount || 0} warnings</span>
        <span>${report.emailCount || 0} emails</span>
        <span>${report.correctionCount || 0} corrections</span>
      </div>
    </article>
    ${events.length ? timelineEventCards(events) : `<p class="muted">No timeline events yet.</p>`}
  `;
}

function renderWorkflow() {
  const workflow = state.workflow;
  const prepareBtn = $("prepareBtn");
  if (!workflow) {
    $("workflowStatus").textContent = "not run";
    $("workflowSteps").innerHTML = `
      <article class="item info">
        <div class="item-title"><span>Start here</span>${statusBadge("simple flow")}</div>
        <p>Run the workflow before submission. It checks historical failures, QC, city-reviewer blockers, AHJ/NEM docs, and staging readiness in order.</p>
      </article>
    `;
    prepareBtn.disabled = false;
    return;
  }

  $("workflowStatus").textContent = humanize(workflow.status);
  prepareBtn.disabled = workflow.status === "blocked";
  $("workflowSteps").innerHTML = `
    <article class="item ${workflow.status === "blocked" ? "blocker" : workflow.status === "needs_review" ? "warning" : "pass"}">
      <div class="item-title"><span>Next action</span>${statusBadge(workflow.canPrepareSubmission ? "ready" : workflow.status)}</div>
      <p>${esc(workflow.nextAction)}</p>
    </article>
    ${(workflow.steps || []).map((step) => `
      <article class="item ${step.status === "blocked" ? "blocker" : step.status === "needs_review" ? "warning" : step.status === "ready" ? "info" : "pass"}">
        <div class="item-title"><span>${esc(step.label)}</span>${statusBadge(step.status)}</div>
        <p>${esc(step.summary)}</p>
        <p class="muted">${esc(step.action)}</p>
      </article>
    `).join("")}
  `;
}

function renderHistoricalFailures() {
  const report = state.historicalReport;
  if (!report) {
    $("historicalCounts").textContent = "not run";
    $("historicalFailures").innerHTML = `<p class="muted">Runs automatically when docs are built — compares this project against prior approved, delayed, and rejected patterns.</p>`;
    return;
  }
  const checklist = report.checklist || [];
  const rejectionCauses = report.topRejectionCauses || [];
  const missing = checklist.filter((item) => item.status === "missing").length;
  const review = checklist.filter((item) => item.status === "needs_review").length;
  $("historicalCounts").textContent = `${report.matchedProjectCount ?? 0} match / ${missing} missing`;
  // HISTORY IS ABOUT OTHER PROJECTS (operator 2026-09-25: the panel "is confusing, looks like you're
  // calling them out for this project not past ones"). Causes read as what went wrong ELSEWHERE,
  // carry no severity badge, and each says whether THIS project has the evidence that prevents it —
  // from the checklist row the API already links by sourceCauseSignature (older API: no link, no
  // line — degrades to the cause alone).
  const thisProjectLine = (cause) => {
    const item = checklist.find((it) => it.sourceCauseSignature && it.sourceCauseSignature === cause.signature);
    if (!item) return "";
    const said = item.status === "present" ? "has the evidence for this"
      : item.status === "missing" ? "is MISSING the evidence for this"
      : item.status === "external" ? "gets this from the installer/homeowner"
      : "needs a person to check this";
    return `<p class="${item.status === "missing" ? "" : "muted"}"><strong>This project ${esc(said)}.</strong>${(item.evidence || []).length ? ` ${esc(item.evidence.join(", "))}` : ""}</p>`;
  };
  $("historicalFailures").innerHTML = `
    <article class="item ${missing ? "warning" : "pass"}">
      <div class="item-title"><span>Similar past projects</span>${statusBadge(report.dataConfidence)}</div>
      <p title="${esc((report.matchTags || []).length ? `Matched on: ${(report.matchTags || []).slice(0, 12).join(", ")}` : "")}">${esc(report.summaryLabel)}</p>
    </article>
    <article class="item info">
      <div class="item-title"><span>Rejections seen on similar past projects</span><span class="muted">${esc(String(rejectionCauses.length))}</span></div>
      <p class="muted">What reviewers sent back on OTHER jobs like this one — not findings against this project. Each line says whether this project already has what prevents it.</p>
      ${rejectionCauses.length ? rejectionCauses.map((cause) => `
        <details class="check-row cause-row callout">
          <summary><strong>${esc(cause.title)}</strong>
            <span class="muted cause-count">${cause.count ? `seen on ${esc(String(cause.count))} past record(s)` : "baseline rule"}</span></summary>
          ${thisProjectLine(cause)}
          <p>${cause.count ? `<strong>${cause.count} prior record(s)</strong>` : "Baseline rule (no learned records yet)"}${cause.rootCause ? ` · ${esc(cause.rootCause)}` : ""}. ${esc(cause.requiredAction)}</p>
          ${cause.sample ? `<p class="muted evidence-sample"><strong>From a past project's review:</strong> "${esc(String(cause.sample).slice(0, 280))}${String(cause.sample).length > 280 ? "…" : ""}"</p>` : `<p class="muted">No source excerpt — derived from a deterministic baseline rule.</p>`}
        </details>
      `).join("") : `<p class="muted">No rejection causes on record for this AHJ/utility yet.</p>`}
    </article>
    <article class="item ${missing ? "blocker" : review ? "warning" : "pass"}">
      <div class="item-title"><span>This project against those rejections</span>${statusBadge(`${missing} missing / ${review} review`)}</div>
      ${(() => {
        // Missing and needs-review rows are the act-on-it rows and stay open. Every other row
        // (present / external / …) is a settled claim and folds behind its COUNT.
        if (!checklist.length) return `<p class="muted">No checklist items generated.</p>`;
        const row = (item) => {
          // Worded about THIS project: "PRESENT: Missing roof framing evidence" read as a defect.
          const label = item.status === "present" ? "This project has it"
            : item.status === "missing" ? "This project is missing"
            : item.status === "external" ? "Provided by installer/homeowner"
            : "Check on this project";
          return `
        <div class="check-row ${esc(item.status)}">
          <strong>${esc(label)}: ${esc(String(item.title || "").replace(/^missing\s+/i, ""))}</strong>
          <p>${esc(item.why)} ${esc(item.action)}</p>
          <p class="muted">${esc((item.evidence || []).join(", "))}</p>
        </div>`;
        };
        const open = checklist.filter((item) => item.status === "missing" || item.status === "needs_review");
        const settled = checklist.filter((item) => item.status !== "missing" && item.status !== "needs_review");
        return open.map(row).join("") + (settled.length ? `
        <details class="checklist-fold">
          <summary>${esc(String(settled.length))} other item${settled.length === 1 ? "" : "s"} (${esc(Object.entries(settled.reduce((acc, it) => { const k = it.status === "external" ? "external" : String(it.status || "unknown"); acc[k] = (acc[k] || 0) + 1; return acc; }, {})).map(([k, n]) => `${n} ${humanize(k).toLowerCase()}`).join(", "))})</summary>
          ${settled.map(row).join("")}
        </details>` : "");
      })()}
    </article>
  `;
}

// (severityClass lived here. Its only caller was the eighteen-identical-cards
// findings list that the AHJ preflight card replaced; severity now selects a
// preflight column and an is-warn modifier instead of an .item tint. Removed
// rather than left behind as a helper with no callers.)

function renderCodeRefs(refs = []) {
  if (!refs.length) return "";
  return `
    <div class="code-refs">
      ${refs.map((ref) => `
        <p><strong>${esc(ref.code)} ${esc(ref.section)}</strong> | ${esc(ref.title)}<br><span class="muted">${esc(ref.adoptionScope || "")}</span></p>
      `).join("")}
    </div>
  `;
}

function renderVisionVerdict(finding) {
  const v = finding.visionVerification;
  if (!v || !v.checked) return "";
  const cls = v.present ? "pass" : "warning";
  const icon = v.present ? "✓ Vision-verified on the sheet" : "⚠ Vision could not confirm on the sheet";
  // The left rule used to be an inline `border-left:3px solid var(--ok,#1a7f37)`.
  // It is a token-driven class now (.evidence-card.pass / .warning) so the theme
  // owns the colour — the hardcoded hex fallbacks were from an abandoned palette.
  return `<div class="evidence-card ${cls}">
      <strong>${icon} (page ${esc(v.page)}, ${esc(v.confidence)} confidence)</strong>
      <p>${esc(v.observed || v.note || "")}</p>
    </div>`;
}

function renderFindingEvidence(finding) {
  const evidence = finding.evidenceFound || [];
  const visionHtml = renderVisionVerdict(finding);
  if (!evidence.length && !visionHtml) return "";
  const visible = evidence.slice(0, 4);
  return `
    <div class="evidence-trail">
      <p><strong>Evidence check:</strong> ${esc(finding.evidenceStatus || "unknown")}</p>
      ${visionHtml}
      ${visible.map((item) => {
        if (item.kind === "screenshot_placeholder") {
          return `<div class="evidence-card screenshot-slot"><strong>${esc(item.label)}</strong><br><span>${esc(item.note || "Screenshot/crop pending.")}</span></div>`;
        }
        return `
          <div class="evidence-card">
            <strong>${esc(item.label)}</strong>
            <p>${esc(item.excerpt || item.note || "")}</p>
            <span class="muted">${esc(item.source || "")}${item.pageHint ? ` | ${esc(item.pageHint)}` : ""} | ${esc(item.confidence || "unknown")} confidence</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

// The "Plan set" line of the preflight card: what the SUBMITTED drawing actually
// shows, as opposed to what the AHJ requires. Prefer a real excerpt off the sheet;
// fall back to the evidence verdict, then to what evidence is still owed.
function findingPlanSetLine(finding) {
  const vision = finding.visionVerification;
  if (vision && vision.checked && vision.observed) {
    return `${vision.observed} (vision, page ${vision.page}, ${vision.confidence} confidence)`;
  }
  const excerpt = (finding.evidenceFound || []).find((item) => item.excerpt);
  if (excerpt) return `${excerpt.label}: ${String(excerpt.excerpt).slice(0, 220)}`;
  if (finding.evidenceStatus) return `Evidence check: ${humanize(finding.evidenceStatus)}.`;
  if ((finding.evidenceNeeded || []).length) return `Not evidenced on the submitted set — still owed: ${finding.evidenceNeeded.join(", ")}.`;
  return "Nothing on the submitted set answers this yet.";
}

/**
 * THE AHJ PREFLIGHT CARD.
 *
 * The marketing site already draws the product UI it wants for exactly this
 * surface: a card headed "AHJ PREFLIGHT / City of Example" with a left "Project
 * checks" column of green ticks and a right "POTENTIAL ISSUE" panel — a red
 * uppercase label, the issue title, an "AHJ requirement" line, a "Plan set" line,
 * and a green-tinted "Recommended action" box. This builds that out of the real
 * reviewer report instead of the eighteen identical stacked cards it replaced.
 *
 * Mapping: severity "pass"/"callout" findings become the tick column; "blocker"
 * and "warning" findings become the issue panels (cityFeedback = the AHJ
 * requirement, findingPlanSetLine = what the sheet shows, designTeamAction = the
 * recommended action). Full evidence + code anchors stay, one fold down, so the
 * card stays readable without losing provenance.
 */
function renderReviewerGate() {
  ensureKeelixDetailStyles();
  const report = state.reviewerReport;
  if (!report) {
    $("reviewerCounts").textContent = "not run";
    $("reviewerGate").innerHTML = `<p class="muted">Runs automatically when docs are built — city-style correction comments, code anchors, and installer callouts, before staging.</p>`;
    return;
  }
  const findings = report.findings || [];
  const blockers = findings.filter((item) => item.severity === "blocker");
  const warnings = findings.filter((item) => item.severity === "warning");
  const clears = findings.filter((item) => item.severity === "pass" || item.severity === "callout");
  $("reviewerCounts").textContent = `${blockers.length} blocker / ${warnings.length} warn`;

  const issues = [...blockers, ...warnings].slice(0, 18);
  const hiddenIssueCount = blockers.length + warnings.length - issues.length;
  const profile = report.matchedProcessProfile;
  const subject = (profile && profile.ahj) || state.detail?.project?.ahj || "This jurisdiction";
  const submitButtonEnough = report.finalSubmitGate?.finalSubmitButtonAloneIsEnough;

  const checksColumn = clears.length
    ? clears.slice(0, 14).map((item) => `
        <div class="kx-check ${item.severity === "callout" ? "is-warn" : ""}">
          <span class="kx-check-mark" aria-hidden="true">${item.severity === "callout" ? "!" : "✓"}</span>
          <span class="kx-check-text">${esc(item.title)}${item.message || item.designTeamAction ? `<span class="kx-check-note">${esc([item.message, item.severity === "callout" ? item.designTeamAction : ""].filter(Boolean).join(" "))}</span>` : ""}</span>
        </div>`).join("")
    : `<span class="kx-check-empty">The gate produced no cleared checks for this project yet — everything it looked at is on the right.</span>`;

  const issuesColumn = issues.length
    ? issues.map((finding) => `
        <div class="kx-issue ${finding.severity === "warning" ? "is-warn" : ""}">
          <span class="kx-issue-label"><span aria-hidden="true">⚠</span>${finding.severity === "warning" ? "Potential issue" : "Blocker"}</span>
          <span class="kx-issue-title">${esc(finding.title)}</span>
          <div class="kx-issue-field">
            <span class="kx-issue-field-label">AHJ requirement</span>
            <span class="kx-issue-field-value">${esc(finding.cityFeedback || finding.message)}</span>
          </div>
          <div class="kx-issue-field">
            <span class="kx-issue-field-label">Plan set</span>
            <span class="kx-issue-field-value">${esc(findingPlanSetLine(finding))}</span>
          </div>
          <div class="kx-action">
            <span class="kx-action-label">Recommended action</span>
            <span class="kx-action-text">${esc(finding.designTeamAction || "Resolve before submittal.")}</span>
          </div>
          <details class="provenance">
            <summary>${esc(humanize(finding.category))} · evidence and code anchors</summary>
            <div class="provenance-body">
              ${finding.evidenceNeeded?.length ? `<p><strong>Evidence needed:</strong> ${esc(finding.evidenceNeeded.join(", "))}</p>` : ""}
              ${renderFindingEvidence(finding)}
              ${renderCodeRefs(finding.codeReferences)}
            </div>
          </details>
        </div>`).join("") + (hiddenIssueCount > 0 ? `<div class="kx-issue-more">${plural(hiddenIssueCount, "further finding")} not shown — copy the reviewer packet for the full list.</div>` : "")
    : `<span class="kx-check-empty">No blockers or warnings. The gate found nothing an AHJ reviewer would correct on this set.</span>`;

  $("reviewerGate").innerHTML = `
    <div class="kx-band">
      ${bandHead("AHJ INTELLIGENCE", "Catch potential corrections before the AHJ does.")}
      <div class="kx-preflight">
        <div class="kx-preflight-head">
          <div>
            <span class="kx-preflight-eyebrow">AHJ preflight</span>
            <span class="kx-preflight-subject">${esc(subject)}</span>
          </div>
          <span class="kx-preflight-tag">${profile ? esc(humanize(profile.submissionMethod) || "Plan review") : "Plan review"}</span>
        </div>
        <div class="kx-preflight-body">
          <div class="kx-preflight-col">
            <span class="kx-preflight-coltitle">Project checks</span>
            ${checksColumn}
          </div>
          <div class="kx-preflight-col">
            <span class="kx-preflight-coltitle">Potential issues</span>
            ${issuesColumn}
          </div>
        </div>
        <div class="kx-preflight-foot">
          Keelix identifies potential issues for review. Final code interpretation and project approval remain with the applicable authority and responsible project professionals.
          ${profile ? ` Matched profile: ${esc(profile.state)} / ${esc(profile.ahj)} / ${esc(profile.submissionMethod)}.` : " No seeded AHJ process profile matched."}
        </div>
      </div>
      <article class="item ${submitButtonEnough ? "info" : "warning"}">
        <div class="item-title"><span>Final submit gate</span>${statusBadge(submitButtonEnough ? "button enough" : "preview required")}</div>
        <p>Submit button alone is ${submitButtonEnough ? "enough" : "not enough"}. The real AHJ/utility preview window or this internal correction packet must be visible before a human submits.</p>
      </article>
    </div>
  `;
  // Note: installer callouts are a subset of the findings rendered above (each
  // carries installerCallout=true), so they're intentionally NOT shown again as a
  // separate block — that was duplicating the city-style correction comments.
}

// The permit form describes ONE filing: the one the "Filing this status is about" selector names
// (permitStatusTargetId — the same answer recordPermitStatus posts against). Its application and
// permit numbers come from THAT filing only, blank when it has none: the old fallback to "the
// first submission carrying a number" put another filing's permit number in the form, and
// recordPermitStatus posted it with the first filing's check (the server keeps a posted number
// over the target's own). `state.permitFormFor` records which project + filing the fields were
// filled from, so recordPermitStatus knows whether they belong to the filing it posts against.
function syncPermitForm() {
  renderPermitStatusTargetPicker(); // the selector's answer must exist before it is read
  const project = state.detail.project;
  const targets = state.detail.permitCheckTargets || [];
  const targetId = permitStatusTargetId();
  const target = targets.find((t) => t.id === targetId) || null;
  // A re-render for the SAME project + filing only fills empty fields — a background refresh
  // (review save, email scan) must not overwrite a number the operator is typing. A different
  // project or filing replaces them: what is left in the fields is about something else.
  const formFor = `${project?.id || ""}|${target?.id || ""}`;
  const fresh = state.permitFormFor !== formFor;
  state.permitFormFor = formFor;
  const fill = (elId, value) => {
    const el = $(elId);
    if (el && (fresh || !el.value)) el.value = value || "";
  };
  fill("permitJurisdiction", target?.jurisdiction || project?.ahj);
  fill("permitPortalName", target?.portalName);
  fill("permitPortalUrl", target?.portalUrl);
  fill("permitApplicationNumber", target?.applicationNumber);
  fill("permitTrackingNumber", target?.permitNumber);
  const freq = $("permitCheckFrequencyDays");
  if (freq && (fresh || !freq.value)) freq.value = target?.checkFrequencyDays || 7;
}

// A QC ROW'S DISPLAYED VERDICT. A row the rule wrote at severity error/blocker is a FAIL on this
// panel whatever its qc_status says: the demo's "PE-stamped structural plans … not attached …
// Staging will refuse without it" row is qc_status=warning, severity=error, and the panel read
// "0 fail / 4 warn" over a staging blocker (demo S2b). Pure; lifted by boardGateTruth.test.ts.
function qcVerdict(result) {
  // A rule that PASSED is a pass whatever its severity — severity says how bad a failure of that
  // rule would be ("blocker"), not that it failed. Escalating on severity alone printed every
  // passing blocker rule as FAIL ("Homeowner name FAIL — Homeowner name present.").
  if ((result && result.qcStatus) === "pass") return "pass";
  const severity = String((result && result.severity) || "").toLowerCase();
  if ((result && result.qcStatus) === "fail" || severity === "error" || severity === "blocker") return "fail";
  return (result && result.qcStatus) || "info";
}
function qcCounts(results) {
  const verdicts = (results || []).map(qcVerdict);
  return { fails: verdicts.filter((v) => v === "fail").length, warnings: verdicts.filter((v) => v === "warning").length };
}

function renderQc() {
  const results = state.detail.qcResults || [];
  const { fails, warnings } = qcCounts(results);
  $("qcCounts").textContent = `${fails} fail / ${warnings} warn`;
  $("qcResults").innerHTML = results.length ? results.map((result) => `
    <article class="item ${esc(qcVerdict(result))}">
      <div class="item-title"><span>${esc(result.ruleName)}</span>${statusBadge(qcVerdict(result))}</div>
      <p>${esc(result.message)}</p>
    </article>
  `).join("") : `<p class="muted">No QC results yet.</p>`;
}

// Human-readable labels + a short "what to enter" hint for the QC review fields,
// so the operator never sees a raw key like "inverterOutput". Falls back to a
// camelCase→Title Case conversion for anything not listed.
const REVIEW_FIELD_LABELS = {
  homeownerName: ["Homeowner name", "the homeowner's full name"],
  projectAddress: ["Service address", "the install service address"],
  utility: ["Utility", "the electric utility company"],
  ahj: ["AHJ (city / county)", "the permitting authority"],
  accountNumber: ["Utility account number", "the utility account number from the bill"],
  meterNumber: ["Meter number", "the meter number from the plan set / bill / meter photo"],
  systemSizeDcKw: ["System size — DC (kW)", "the DC system size in kW"],
  systemSizeAcKw: ["System size — AC (kW)", "the AC system size in kW"],
  moduleMake: ["Module make", "the PV module manufacturer"],
  moduleModel: ["Module model", "the PV module model number"],
  moduleWattage: ["Module wattage (W)", "the per-module wattage"],
  moduleQty: ["Module quantity", "the number of modules"],
  inverterModel: ["Inverter / microinverter model", "the inverter or microinverter model number"],
  inverterQty: ["Inverter quantity", "the number of inverters/microinverters"],
  inverterOutput: ["Inverter output (A)", "the inverter's rated continuous output current in amps"],
  interconnectionMethod: ["Interconnection method", "e.g. load-side breaker, line-side tap, supply-side"],
  busRating: ["MSP bus rating (A)", "the main service panel busbar rating in amps"],
  mainBreaker: ["Main breaker rating (A)", "the main breaker rating in amps"],
  pvBreaker: ["PV breaker / OCPD (A)", "the backfed PV breaker / OCPD size in amps"],
  permitPath: ["Permit path", "the permit path (prescriptive vs engineered)"],
  locates: ["Required locates", "type 'N/A - roof mount, no excavation' or note the 811/locate callout"],
  splitPages: ["Required files / page mapping", "confirm the plan-set sheet split mapping"],
  // Additional fields that can surface from baseline / utility / structural rules.
  dcKw: ["System size — DC (kW)", "the DC system size in kW"],
  acKw: ["System size — AC (kW)", "the AC system size in kW"],
  exportKw: ["Export capacity (kW)", "the AC export capacity in kW (for NEM tier screens)"],
  acDiscReq: ["AC disconnect required?", "type 'Yes - lockable AC disconnect within 10 ft of meter' or 'No - not required'"],
  snow: ["Snow load (psf)", "the design ground snow load in psf"],
  deadLoad: ["Roof dead load (psf)", "the distributed dead load the array adds, in psf"],
  wind: ["Wind speed / exposure", "the design wind speed (mph) and exposure category"],
  roofRafterSpacing: ["Rafter / truss spacing", "the rafter or truss spacing, e.g. '24 in O.C.'"],
  account: ["Utility account number", "the utility account number from the bill"],
  meter: ["Meter number", "the meter number from the plan set / bill / meter photo"],
  ubAccountNumber: ["Utility-bill account number", "the account number printed on the utility bill"],
  ubMeterNumber: ["Utility-bill meter number", "the meter number printed on the utility bill / meter photo"],
};
function camelToTitle(key) {
  return String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
function reviewLabel(item) {
  const mapped = REVIEW_FIELD_LABELS[item.fieldName];
  if (mapped) return mapped[0];
  // issueType is usually already a friendly rule name (e.g. "Inverter output").
  // Use it when it reads as a label; otherwise humanize the raw field key.
  if (item.issueType && item.issueType !== item.fieldName && /[ A-Z]/.test(item.issueType)) {
    return item.issueType;
  }
  return camelToTitle(item.fieldName) || "Review item";
}
function reviewHint(item) {
  const mapped = REVIEW_FIELD_LABELS[item.fieldName];
  return mapped ? mapped[1] : "";
}

// Optional/warning-level review fields where "Reject" is a valid skip (they
// don't block submittal). Every other field is a required blocker — there,
// Reject would only wedge the project (no value = QC keeps failing), so we
// hide it and require Save Edit.
const REVIEW_WARNING_FIELDS = new Set(["permitPath", "locates", "splitPages"]);

// A CORRECTION ITEM'S notes ARE NOT PROSE. correctionAgent stores its triage
// payload there as `agent-triage:{…}` and parseCorrectionProposals matches that
// exact shape, so the stored value is a MATCHING KEY and must never be rewritten
// — which is why updateReview stopped sending a note at all. That leaves the raw
// JSON as the card's description, so it is translated HERE, at display time
// only. The stored notes are untouched.
function reviewNotesDisplay(item) {
  const notes = String(item.notes || "");
  if (notes.startsWith("agent-triage:")) {
    return "Review the proposed changes and required actions below. Applying data updates does not submit or close the correction.";
  }
  return notes || "Review required.";
}

function renderReview() {
  const items = state.detail.humanReviewItems || [];
  const pending = items.filter((x) => x.status === "pending");
  const resolved = items.filter((x) => x.status !== "pending");
  $("reviewCounts").textContent = `${pending.length} pending`;

  function reviewCard(item) {
    const label = reviewLabel(item);
    const hint = reviewHint(item);
    const isWarning = REVIEW_WARNING_FIELDS.has(item.fieldName);
    const known = item.llmSuggestedValue || item.parserValue || "";
    let triage = null;
    try { if (String(item.notes).startsWith("agent-triage:")) triage = JSON.parse(item.notes.slice(13)); } catch {}
    const proposals = Array.isArray(triage?.proposals) ? triage.proposals : [];
    const jurisdictionProposals = jurisdictionProposalList(triage);
    const correctionBody = item.fieldName === "correction" ? `
      ${proposals.length ? `<table><thead><tr><th>Field</th><th>Current</th><th>Proposed</th><th>Evidence</th></tr></thead><tbody>${proposals.map(p => `<tr><td>${esc(p.field)}</td><td>${esc(p.currentValue || "Missing")}</td><td>${esc(p.proposedValue)}</td><td>${esc(p.basis)}</td></tr>`).join("")}</tbody></table>` : ""}
      ${jurisdictionProposalsHtml(jurisdictionProposals)}
      ${Array.isArray(triage?.actions) && triage.actions.length ? `<ol>${triage.actions.map(a => `<li>${esc(a)}</li>`).join("")}</ol>` : ""}
      ${item.status === "pending" && triage?.correctionId && (proposals.length || jurisdictionProposals.some((p) => p.status === "proposed")) ? `<button class="primary" data-apply-correction="${esc(triage.correctionId)}">Apply these data updates</button>` : `<p class="muted">Use Corrections in the Submit stage to review the response and record resolution.</p>`}` : "";
    const context = [];
    if (item.llmSuggestedValue) context.push(`<strong>AI suggestion:</strong> ${esc(item.llmSuggestedValue)}`);
    if (item.parserValue && item.parserValue !== item.llmSuggestedValue) context.push(`<strong>Parser read:</strong> ${esc(item.parserValue)}`);
    // The hint is often already the tail of the notes sentence; printing it again read as a stutter.
    const squash = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (hint && !squash(reviewNotesDisplay(item)).includes(squash(hint).slice(0, 24))) context.push(`<span class="muted">${esc(hint)}</span>`);
    return `
    <article class="item ${item.status === "pending" ? (isWarning ? "info" : "warning") : "pass"}">
      <div class="item-title"><strong>${esc(label)}</strong>${statusBadge(item.status)}</div>
      <p style="margin:0 0 4px">${esc(reviewNotesDisplay(item))}</p>
      ${context.length ? `<p style="margin:0 0 4px">${context.join("<br>")}</p>` : ""}
      ${item.sourceExcerpt ? `<p style="margin:0 0 4px"><strong>Source:</strong> ${esc(item.sourceExcerpt)}</p>` : ""}
      ${correctionBody}
      ${item.status === "pending" && item.fieldName !== "correction" ? `
        <div class="review-actions">
          <input id="review-${item.id}" value="${esc(known)}" placeholder="${esc(hint ? `Enter ${hint}, then Save Edit` : `Enter the ${label} (read it off the plan set / bill), then Save Edit`)}" />
          <div class="actions">
            ${isWarning ? `<button class="secondary" data-review-action="reject" data-review-id="${item.id}"><i data-lucide="x"></i><span>Skip (N/A)</span></button>` : ""}
            <button class="primary" data-review-action="edit" data-review-id="${item.id}"><i data-lucide="pencil"></i><span>Save Edit</span></button>
          </div>
        </div>
      ` : ""}
    </article>`;
  }

  const pendingHtml = pending.map(reviewCard).join("");
  const resolvedHtml = resolved.length
    ? `<details style="margin-top:.5rem"><summary style="cursor:pointer;color:var(--muted);font-size:13px">${plural(resolved.length, "resolved item")}</summary><div class="stack" style="margin-top:.5rem">${resolved.map(reviewCard).join("")}</div></details>`
    : "";

  $("reviewItems").innerHTML = (pending.length || resolved.length)
    ? `<div class="stack">${pendingHtml}</div>${resolvedHtml}`
    : `<p class="muted">No human review items.</p>`;

  $("reviewItems").querySelectorAll("button[data-review-action]").forEach((button) => {
    button.addEventListener("click", () => updateReview(button.dataset.reviewId, button.dataset.reviewAction));
  });
  $("reviewItems").querySelectorAll("button[data-apply-correction]").forEach(button => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(`/api/corrections/${encodeURIComponent(button.dataset.applyCorrection)}/apply`, { method: "POST", body: "{}" });
        await selectProject(state.selectedProjectId);
        showMessage("Proposed data updates applied. Review the revised documents and correction response before resubmitting.");
      } catch (err) { showMessage(err.message, "error"); button.disabled = false; }
    });
  });

  // The auto-fill helper only fills inverter-output / PV-breaker fields, so show it
  // exclusively when one of those is pending. Otherwise it's an orphaned input box.
  const autofillRelevant = pending.some((x) => x.fieldName === "inverterOutput" || x.fieldName === "pvBreaker");
  const autofillPanel = $("autofillSpecsPanel");
  if (autofillPanel) autofillPanel.style.display = autofillRelevant ? "" : "none";
  if (!autofillRelevant) {
    const status = $("autofillSpecsStatus");
    if (status) status.textContent = "";
  }
}

// The AHJ's REAL permit PDF(s), filled with project data. This is the "legit"
// form the operator submits — distinct from the markdown transfer worksheets.
// WHICH CLAUSE SATISFIED A COMPOUND ROW — Oregon BCD 5952 only.
//
// The checklist's compound rows read as a list of alternatives ("roof is metal,
// OR ≤2 layers composition shingle, OR ≤1 layer wood shake"), and a bare Yes
// beside one was read as the FIRST alternative — a metal-roof claim on a
// comp-shingle house. This names the clause that actually fired.
//
// Mirrors backend/src/bcdChecklistFacts.ts, which is the authority that fills
// the PDF. CANNED LABELS ONLY — nothing parser-read is interpolated, so nothing
// model-read can reach innerHTML here. And it is double-gated against drift: a
// note renders only when this mirror derives Yes AND the backend's own message
// does not list that row under "Still needs evidence" — if the two ever
// disagree, the row gets NO note rather than a wrong one.
function bcd5952ClauseNotes(form) {
  if (!/5952/.test(`${form.formId || ""} ${form.formName || ""}`)) return "";
  const snap = state.detail?.project?.parserSnapshot || {};
  const str = (k) => String(snap[k] ?? "").trim().toLowerCase();
  const flag = (k) => /^(yes|true)$/.test(str(k)) ? true : /^(no|false)$/.test(str(k)) ? false : null;
  const num = (k) => { const m = str(k).match(/^\s*(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
  const max = (k, limit) => num(k) == null ? null : num(k) <= limit;
  const all = (...v) => v.includes(false) ? false : v.includes(null) ? null : true;
  const any = (...v) => v.includes(true) ? true : v.includes(null) ? null : false;
  const backendUnsure = String(form.message || "");
  const notes = [];
  const note = (needle, text) => { if (!backendUnsure.includes(needle)) notes.push(text); };

  const frame = str("framingType");
  if (all(frame ? /truss/.test(frame) : null, max("roofRafterSpacing", 24)) === true) {
    note("framing compliance", "Framing: Yes — via trusses at ≤24″ spacing");
  } else if (all(frame ? /rafter/.test(frame) : null, max("roofRafterSpacing", 24), flag("rafterExceptionCompliant")) === true) {
    note("framing compliance", "Framing: Yes — via rafters at ≤24″ spacing meeting the exception");
  }

  const roof = str("roofMaterial");
  if (roof) {
    if (/metal/.test(roof)) note("roof material and layer count", "Roofing: Yes — via the metal-roof clause");
    else if (/compos|asphalt/.test(roof) && max("roofLayers", 2) === true) note("roof material and layer count", "Roofing: Yes — via ≤2 layers composition shingle (not the metal-roof clause)");
    else if (/wood|shake/.test(roof) && max("roofLayers", 1) === true) note("roof material and layer count", "Roofing: Yes — via ≤1 layer wood shake (not the metal-roof clause)");
  }

  const exposure = str("wind").toUpperCase();
  const spaced = num("attachmentSpacingIn");
  const method1 = all(flag("attachmentToFraming"), spaced == null ? null : spaced <= 24 ? true :
    all(spaced <= 48, max("snow", 36),
      any(flag("attachmentsOutsideEdgeZone"), max("attachmentEdgeSpacingIn", 24)),
      exposure === "B" ? max("windSpeed", 120) : exposure === "C" ? max("windSpeed", 110) : null));
  if (method1 === true) note("attachment method compliance", "Attachments: Yes — via Method 1 (lagged to roof framing)");
  else if (flag("standingSeamMethod2Compliant") === true) note("attachment method compliance", "Attachments: Yes — via Method 2 (standing-seam clamps)");

  return notes.length ? `<p class="muted bcd-clauses">${esc(`Compound rows — the clause each Yes came from: ${notes.join("; ")}.`)}</p>` : "";
}

function renderFilledForms(projectId) {
  const ff = state.filledForms;
  if (!ff) return "";
  if (ff.error) {
    return `<article class="item warning"><div class="item-title"><span>Official AHJ PDF form</span>${statusBadge("error")}</div><p>${esc(ff.error)}</p></article>`;
  }
  const forms = ff.forms || [];
  if (ff.unmatched || !forms.length) {
    // Online-only (e-permitting) AHJs don't publish a standalone PDF — the
    // application is entered directly in their portal. Show that plainly instead
    // of a search button that can't succeed.
    const portalOnly = state.applicationDocs?.profile?.requiresPortalEntryOnly;
    if (portalOnly) {
      return `<article class="item info">
        <div class="item-title"><span>Official AHJ form</span>${statusBadge("online-only")}</div>
        <p><strong>${esc(ff.ahj || "This AHJ")}</strong> takes applications online through its permit portal — there is no standalone PDF to download or fill. Enter the application directly in the portal; the plan set and required documents below are what you'll upload there.</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px">
          <label class="secondary" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--line);border-radius:6px">
            <i data-lucide="upload"></i><span>Upload a blank PDF anyway</span>
            <input id="uploadAhjFormInput" type="file" accept="application/pdf" style="display:none">
          </label>
          <span id="findAhjFormStatus" class="muted" style="font-size:12px"></span>
        </div>
      </article>`;
    }
    return `<article class="item warning">
      <div class="item-title"><span>Official AHJ PDF form</span>${statusBadge("none on file")}</div>
      <p>No filled PDF form for <strong>${esc(ff.ahj || "this AHJ")}</strong> yet. Find the AHJ's official permit PDF, map its fields, and fill it — or upload the blank PDF yourself if it can't be found (e.g. the AHJ is online-only).</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px">
        <button type="button" id="findAhjFormBtn" class="secondary"><i data-lucide="search"></i><span>Find official form</span></button>
        <label class="secondary" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--line);border-radius:6px">
          <i data-lucide="upload"></i><span>Upload blank PDF</span>
          <input id="uploadAhjFormInput" type="file" accept="application/pdf" style="display:none">
        </label>
        <span id="findAhjFormStatus" class="muted" style="font-size:12px"></span>
      </div>
    </article>`;
  }
  const acquisitionControls = `<article class="item info"><button type="button" id="findAhjFormBtn" class="secondary">Find missing official forms</button>
    <label class="secondary" style="margin-left:8px">Upload blank PDF<input id="uploadAhjFormInput" type="file" accept="application/pdf" style="display:none"></label>
    <span id="findAhjFormStatus" class="muted"></span></article>`;
  return acquisitionControls + forms.map((f) => {
    const ok = f.status === "filled";
    // "skipped" = the OTHER application for this permit path (prescriptive vs structural).
    // It's intentional, not a problem — render it neutral and never block on it.
    const skipped = f.status === "skipped";
    const isStored = Boolean(f.templateId);
    const unverified = isStored && f.verified === false;
    // A value the AGENCY computes (a fee / surcharge / total — requestedFieldOwners, gates-proper C4)
    // is not a detail the operator owes: it never turns the form's badge to "needs details". A named
    // operator item (forms-fill: a refused shape, a licence not on file, a signer to confirm) is.
    const ownersOf = f.requestedFieldOwners || {};
    const operatorBlanks = (f.unmappedRequested || []).filter((l) => ownersOf[l] !== "agency");
    const operatorItems = f.operatorItems || [];
    const missingDetails = operatorBlanks.length > 0 || operatorItems.length > 0;
    const extra = [
      f.filledFieldCount != null ? `${f.filledFieldCount} field(s) filled` : "",
      operatorBlanks.length && !f.message?.includes("Still needs:") ? `Needs details: ${operatorBlanks.join(", ")}` : "",
      f.message || "",
    ].filter(Boolean).join(" · ");
    // Cls: unverified auto-maps are a warning (block submit) until confirmed.
    const cls = skipped ? "info" : !ok || missingDetails || unverified ? "warning" : "pass";
    const badge = skipped ? "not this path" : !ok ? (f.status || "not filled") : missingDetails ? "needs details" : unverified ? "needs verify" : (isStored ? "verified" : "filled PDF");
    return `<article class="item ${cls}">
      <div class="item-title"><span>${esc(f.formName || f.formId)}</span>${statusBadge(badge)}</div>
      ${ok ? `<p><a href="/api/projects/${encodeURIComponent(projectId)}/filled-forms/${encodeURIComponent(f.formId)}" target="_blank" rel="noopener"><strong>⬇ Download filled ${esc(f.formName || "AHJ form")} (PDF)</strong></a></p>` : ""}
      ${unverified ? `<p class="muted">AI-mapped — open the PDF, confirm the fields and signature are placed correctly, then verify. A real submit is blocked until you do.</p>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
          <button type="button" class="secondary" data-verify-form="${esc(f.templateId)}" style="font-size:12px">✓ Looks right — mark verified</button>
          <button type="button" class="secondary" data-remap-form="${esc(f.templateId)}" style="font-size:12px">Re-map</button>
        </div>` : ""}
      ${ok && !isStored && !f.signaturesLocked ? `<p class="muted"><button type="button" class="secondary" data-detect-sign="${esc(f.formId)}" style="font-size:12px">Detect signature lines (AI)</button> — stamp your stored signature on this form.</p>` : ""}
      ${ok && !isStored && f.signaturesLocked ? `<p class="muted">✓ Built-in form — signature + date auto-placed on the authorized-signature line. No verification needed.</p>` : ""}
      ${f.documentStale ? `<p class="muted"><strong>This blank dates itself “${esc(f.documentDate)}”</strong> — over two years old. Re-check the AHJ's current forms page before filing${f.sourceUrl ? ` (<a href="${esc(f.sourceUrl)}" target="_blank" rel="noopener noreferrer">source</a>)` : ""}. Check any printed fee rates against the current schedule.</p>` : ""}
      ${extra ? `<p class="muted">${esc(extra)}</p>` : ""}
      ${ok && operatorItems.length ? `<p><strong>Fill by hand before filing (${operatorItems.length}):</strong></p><ul class="muted" style="margin:2px 0 6px 18px">${operatorItems.map((it) => `<li>${esc(it)}</li>`).join("")}</ul>` : ""}
      ${ok ? bcd5952ClauseNotes(f) : ""}
    </article>`;
  }).join("");
}

/**
 * THE REQUIRED-DOCUMENT VERDICT, IN THREE STATES THAT ARE ACTUALLY DIFFERENT.
 *
 * A MISSING DOCUMENT IS NOT A MISSING FIELD — and A FAILURE TO ANSWER IS NOT AN
 * ANSWER OF "NOTHING". This card twice told an operator the packet was complete
 * when it had no idea:
 *
 *   1. It printed "No critical document fields missing from the generated packet"
 *      out of pkg.missingFields alone — fifteen SCALAR project-field checks that
 *      never look at a document. True sentence, false impression; two permits went
 *      out with an application never attached.
 *   2. The replacement still read `pkg.missingDocuments || []`, so when the backend
 *      inventory THREW and left the list absent, the `|| []` manufactured an empty
 *      list and the pass-green document all-clear printed over a computation that
 *      never ran — the same lie, reproduced by the error path.
 *   3. The all-clear itself said the documents were ATTACHED, when all it had checked
 *      was the files on disk; what the portal received was never reported (docs-audit
 *      PLAN D1). It now says "on file", and says the run does not yet report attachments.
 *
 * So the state we render comes from pkg.missingDocumentsStatus, NOT from the length
 * of the array (shared/src/types.ts: ApplicationDocumentPackage):
 *
 *   "resolved" + empty      → the all-clear. THE ONLY VALUE THAT MAY RENDER ONE.
 *   "resolved" + non-empty  → name the documents.
 *   "unavailable" / absent  → "we could not determine", with the reason. An absent
 *                             status is the DB-free builder, which never resolves an
 *                             inventory — so the test is `!== "resolved"`, never
 *                             `=== "unavailable"`, and null fails it too.
 *
 * The CSS class is part of the claim: a pass-green card carrying "could not
 * determine" would tell the operator the same lie in colour. Each state carries its
 * own. Fields and documents get SEPARATE verdict rows — one sentence covering both
 * is how the first version went wrong.
 */
/**
 * THE FILLED FORMS' BLANKS, SPLIT BY WHOSE THEY ARE (gates-proper C4) — the backend's one answer
 * (ahjForms.requiredFieldOwner, carried on each form as requestedFieldOwners). A fee / surcharge /
 * total the agency computes is not the operator's to supply, and a land-use approval comes from the
 * planning office; the old card listed Marion County's "electrical permit fee (the county schedule,
 * when not on file)" under "Resolve them in QC / Human Review before staging", and the operator
 * bypassed the gate over it. Pure: [operator's blanks (planning-office ones labelled), agency's].
 */
function filledFormBlanks(forms) {
  const mine = [];
  const agency = [];
  for (const f of (forms || []).filter((x) => x && x.status === "filled")) {
    const owners = f.requestedFieldOwners || {};
    for (const label of f.unmappedRequested || []) {
      if (owners[label] === "agency") agency.push(label);
      else mine.push(owners[label] === "planning_office" ? `${label} (from the planning / land-use office, when the project needs one)` : label);
    }
    // The fill's named operator items (forms-fill) are the operator's too.
    for (const item of f.operatorItems || []) mine.push(item);
  }
  return [mine, agency];
}

function documentVerdictHtml(pkg, formMissingFields = [], agencyComputedFields = []) {
  const missingFields = [...new Set([...(pkg.missingFields || []), ...formMissingFields])];
  const agencyFields = [...new Set(agencyComputedFields)];
  const inventoryResolved = pkg.missingDocumentsStatus === "resolved";
  const missingDocs = inventoryResolved ? (pkg.missingDocuments || []) : [];
  const filledAtStaging = inventoryResolved ? (pkg.filledAtStagingDocuments || []) : [];
  const acquiredAtStaging = inventoryResolved ? (pkg.acquiredAtStagingDocuments || []) : [];
  // WHICH APPLICATION(S) THIS AHJ REQUIRES IS NOT KNOWN (pkg.applicationSetUnknown, the inventory's
  // own sentence): an advisory row in the "could not determine" style — never pass-green.
  const unknownApps = inventoryResolved && pkg.applicationSetUnknown ? String(pkg.applicationSetUnknown) : "";
  const unknownAppsRow = unknownApps
    ? `<div class="kx-docstate is-unknown">
        <span class="kx-docstate-icon" aria-hidden="true">?</span>
        <div class="kx-docstate-body">
          <span class="kx-docstate-title">Which permit application(s) this AHJ requires is not known</span>
          <span class="kx-docstate-text">${esc(unknownApps)}</span>
        </div>
      </div>`
    : "";

  // What the operator can do about a blank, said truthfully: nothing waits on it (no gate reads these
  // fields), and QC / Human Review cannot fill a form field — the project record or the form can.
  const fieldRow = missingFields.length
    ? `<div class="kx-docstate is-missing">
        <span class="kx-docstate-icon" aria-hidden="true">⚠</span>
        <div class="kx-docstate-body">
          <span class="kx-docstate-title">${plural(missingFields.length, "application field")} still blank</span>
          <span class="kx-docstate-text">Fields, not files. A blank on a generated form does not hold staging: add the data to the project and rebuild, or complete it on the filled form before the final submit. (The portal's own required fields are checked when it is staged.)</span>
          <ul class="kx-docstate-list">${missingFields.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
        </div>
      </div>`
    : agencyFields.length
      ? `<div class="kx-docstate is-clear">
        <span class="kx-docstate-icon" aria-hidden="true">✓</span>
        <div class="kx-docstate-body">
          <span class="kx-docstate-title">No application field is waiting on you</span>
          <span class="kx-docstate-text">Every field this packet needs from the project is filled. The values below are the agency's to compute.</span>
        </div>
      </div>`
      : `<div class="kx-docstate is-clear">
        <span class="kx-docstate-icon" aria-hidden="true">✓</span>
        <div class="kx-docstate-body">
          <span class="kx-docstate-title">No critical application field is blank</span>
          <span class="kx-docstate-text">Every scalar field this packet needs was read off the project. This says nothing about the FILES — see below.</span>
        </div>
      </div>`;
  // THE AGENCY'S OWN VALUES — a fee, surcharge or total the form could not price. Neutral: the agency
  // computes it from its own schedule (in its portal, or at intake); nothing here waits on it.
  const agencyRow = agencyFields.length
    ? `<div class="kx-docstate is-clear">
        <span class="kx-docstate-icon" aria-hidden="true">ⓘ</span>
        <div class="kx-docstate-body">
          <span class="kx-docstate-title">${plural(agencyFields.length, "value")} left for the agency to compute</span>
          <span class="kx-docstate-text">Fees, surcharges and totals the form could not price from a saved schedule. The agency computes them from its own schedule in its portal or at intake — nothing waits on them, and automation never pays a fee.</span>
          <ul class="kx-docstate-list">${agencyFields.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
        </div>
      </div>`
    : "";

  let docRow;
  if (!inventoryResolved) {
    // NEVER an all-clear here, and never pass-green. The two ways of not knowing
    // are one state but not one sentence, and the difference is what the operator
    // should do next:
    //
    //  "unavailable" — documentInventory RAN AND THREW. Something is broken; the
    //                  reason is worth showing and re-running may not help.
    //   status absent — this package came off buildApplicationDocumentPackage,
    //                  which is DB-free and never resolves an inventory at all.
    //                  That is every package returned by POST /workflow. Nothing
    //                  is broken — the question simply was not asked, and
    //                  "Build AHJ docs" asks it. Printing a failure here would
    //                  cry wolf after every workflow run and teach the operator
    //                  to scroll past the warning that matters.
    const failed = pkg.missingDocumentsStatus === "unavailable";
    docRow = `<div class="kx-docstate is-unknown">
        <span class="kx-docstate-icon" aria-hidden="true">?</span>
        <div class="kx-docstate-body">
          <span class="kx-docstate-title">We could not determine which documents this AHJ requires</span>
          <span class="kx-docstate-text">${failed
            ? "The required-document inventory ran and failed, so this packet cannot say whether anything is missing. Treat it as unchecked — not as clear. Rebuild the AHJ docs, and if it keeps failing, verify the required document set against the jurisdiction by hand before submitting."
            : "This view came from the workflow run, which does not resolve the document inventory — it was never asked, so an empty list here would mean nothing. Build the AHJ docs to get the real answer. Until then treat it as unchecked, not as clear."}</span>
          ${failed && pkg.missingDocumentsError ? `<span class="kx-docstate-reason">Reason: ${esc(pkg.missingDocumentsError)}</span>` : ""}
        </div>
      </div>`;
  } else if (missingDocs.length) {
    docRow = `<div class="kx-docstate is-missing">
        <span class="kx-docstate-icon" aria-hidden="true">⚠</span>
        <div class="kx-docstate-body">
          <span class="kx-docstate-title">${plural(missingDocs.length, "required document")} NOT in the packet</span>
          <span class="kx-docstate-text">These are files, not fields. The submittal is incomplete until each one is attached.</span>
          <ul class="kx-docstate-list">${missingDocs.map((d) => `<li>${esc(d.label)}<span class="kx-docstate-why"> — ${esc(d.why)}</span></li>`).join("")}</ul>
        </div>
      </div>${unknownAppsRow}`;
  } else if (unknownAppsRow) {
    // NOTHING KNOWN IS NOT NOTHING OWED: an application set that is empty because nobody knows this
    // AHJ is never rendered as the all-clear (leak sweep, 2026-09-28).
    docRow = unknownAppsRow;
  } else {
    docRow = `<div class="kx-docstate is-clear">
        <span class="kx-docstate-icon" aria-hidden="true">✓</span>
        <div class="kx-docstate-body">
          <span class="kx-docstate-title">Every required document is on file${acquiredAtStaging.length ? " or made by Stage itself" : filledAtStaging.length ? " or filled at staging" : ""}</span>
          <span class="kx-docstate-text">The required-document inventory ran against the real uploads and filled forms on disk and found nothing blocking missing${filledAtStaging.length ? " that you need to supply" : ""}. On file is not the same as attached: staging attaches what the portal's upload slots ask for, and the run does not yet report what went up — check the portal's attachment list before you submit.</span>
        </div>
      </div>`;
  }
  // FILLED AT STAGING — a required form whose template is on file: staging fills it, so it is not
  // the operator's to supply (the gate's own "Filled at staging" line, the same
  // owedMissingDocuments answer). Named here so it neither reads as missing nor vanishes.
  // ON FILE IS NOT ATTACHED (docs-audit PLAN D1): the fill puts a file on disk; whether it went
  // up depends on the portal offering a slot that asks for it, and no run reports that yet.
  const filledRow = filledAtStaging.length
    ? `<div class="kx-docstate is-clear">
        <span class="kx-docstate-icon" aria-hidden="true">↻</span>
        <div class="kx-docstate-body">
          <span class="kx-docstate-title">${plural(filledAtStaging.length, "required form")} filled at staging</span>
          <span class="kx-docstate-text">Not on disk yet, and nothing for you to supply: the form's template is on file, and staging fills it and offers it to any portal upload slot that asks for it. The run does not yet report what went up — check the portal's attachment list before you submit.</span>
          <ul class="kx-docstate-list">${filledAtStaging.map((d) => `<li>${esc(d.label)}</li>`).join("")}</ul>
        </div>
      </div>`
    : "";
  // DOWNLOADED AT STAGING (gates-proper C1) — a required form nobody has fetched yet that Stage
  // downloads (the issuing agency's published form, a cited PDF) or researches, and fills, before it
  // counts. Not the operator's to attach; if the download fails, Stage says so and stops.
  // (acquiredAtStaging is read above, beside filledAtStaging.)
  const acquiredRow = acquiredAtStaging.length
    ? `<div class="kx-docstate is-clear">
        <span class="kx-docstate-icon" aria-hidden="true">⤓</span>
        <div class="kx-docstate-body">
          <span class="kx-docstate-title">${plural(acquiredAtStaging.length, "required form")} downloaded and filled by Stage</span>
          <span class="kx-docstate-text">Nothing for you to attach: Stage fetches the official blank and fills it before it counts the documents. If a download fails, Stage stops and names the form — then use Find missing official forms or upload the blank.</span>
          <ul class="kx-docstate-list">${acquiredAtStaging.map((d) => `<li>${esc(d.label)}<span class="kx-docstate-why"> — ${esc(d.why)}</span></li>`).join("")}</ul>
        </div>
      </div>`
    : "";

  return `<div class="stack">${fieldRow}${agencyRow}${docRow}${filledRow}${acquiredRow}</div>`;
}

// THE PERMIT PATH, ITS EVIDENCE, AND THE OVERRIDE — on the project screen.
//
// Prescriptive and engineered are mutually exclusive: the AHJ takes exactly one
// application, and this one call decides which one is built, which fee schedule applies
// and whether a PE stamp is required. It used to be visible only as a sentence inside the
// generated cover document, so an operator could read the conclusion but never the
// evidence — and a wrong read (a coastal wind speed misparsed, a stamp recommendation
// misread) travelled all the way into the filing before anyone could see it.
//
// This panel shows WHAT was decided, WHO decided it (source), and the evidence sentences
// verbatim, and it points at the override that already exists. It changes NO path logic:
// the strict split stays exactly as resolvePermitPath computes it.
function renderPermitPathPanel(pkg) {
  const res = pkg && pkg.permitPath;
  if (!res) {
    // An older/cached package that predates this field. Say so — never draw a blank that
    // reads as "no path concerns".
    return `
      <div class="kx-band">
        ${bandHead("PERMIT PATH", "Which application this AHJ receives.")}
        <p class="muted">This packet was built before the path was reported here — rebuild the AHJ docs to see the resolved path and its evidence.</p>
      </div>`;
  }
  const PATH_COPY = {
    prescriptive: { label: "Prescriptive", tag: "Prescriptive", detail: "Meets prescriptive code — no plan review, reduced permit fee, no PE stamp. Only the prescriptive application is filed." },
    engineered: { label: "Engineered (non-prescriptive)", tag: "Engineered", detail: "Plan review, full structural fees, and a PE-stamped plan set + sealed structural letter. Only the structural application is filed." },
    unknown: { label: "Not yet confirmed", tag: "Undecided", detail: "The two applications are mutually exclusive and we cannot tell which one this AHJ should receive. Staging the permit is blocked until this is set." },
  };
  const SOURCE_COPY = {
    operator: "An operator chose this explicitly — it overrides every automatic signal.",
    parser: "Read from the plan set (the parser stated the path, or the stamp recommendation called for engineering).",
    "structural-screen": "Decided by the structural prescriptive screen (snow, dead load, rafter spacing, wind exposure and speed).",
    default: "No signal forced a path — this is the default for the shape of system that was parsed.",
  };
  const copy = PATH_COPY[res.path] || PATH_COPY.unknown;
  const basis = (res.basis || []).filter(Boolean);
  return `
    <div class="kx-band">
      ${bandHead("PERMIT PATH", "Which application this AHJ receives — and why.")}
      <div class="kx-preflight">
        <div class="kx-preflight-head">
          <div>
            <span class="kx-preflight-eyebrow">Resolved path</span>
            <span class="kx-preflight-subject">${esc(copy.label)}</span>
          </div>
          <span class="kx-preflight-tag">${esc(copy.tag)}</span>
        </div>
        <div class="kx-preflight-col">
          <div class="kx-issue-field"><span class="kx-issue-field-label">What this means</span><span class="kx-issue-field-value">${esc(copy.detail)}</span></div>
          <div class="kx-issue-field"><span class="kx-issue-field-label">Decided by</span><span class="kx-issue-field-value">${esc(res.source)} &mdash; ${esc(SOURCE_COPY[res.source] || "")}</span></div>
          <div class="kx-issue-field">
            <span class="kx-issue-field-label">Evidence</span>
            <span class="kx-issue-field-value">${basis.length ? basis.map((line) => esc(line)).join("<br>") : "No evidence sentence was recorded for this decision &mdash; treat the path as unconfirmed and set it explicitly."}</span>
          </div>
          <div class="kx-issue-field">
            <span class="kx-issue-field-label">Wrong?</span>
            <span class="kx-issue-field-value">
              ${res.source === "operator" ? "This is an operator override. Clearing it in Manual entry hands the decision back to the plan set." : "If this reads the plan set wrong, set the path yourself &mdash; an operator choice wins over every automatic signal."}
              <button type="button" class="secondary" style="font-size:12px;margin-top:6px" data-goto-permit-path="1">Set the permit path &rarr;</button>
            </span>
          </div>
        </div>
      </div>
      <p class="muted" style="margin-top:6px">Changing the path rebuilds the application set &mdash; the other application is never filed.</p>
    </div>`;
}

// Open the Manual entry accordion and focus the existing permit-path override. Same
// jump pattern the form-mapping check uses; no second override control is introduced.
function gotoPermitPathOverride() {
  document.querySelector(".stage-accordion[data-stage-index='2']")?.setAttribute("open", "");
  const sel = $("manualPermitPath");
  if (sel) {
    sel.scrollIntoView({ behavior: "smooth", block: "center" });
    sel.focus();
  }
}

function renderApplicationDocs() {
  ensureKeelixDetailStyles();
  const pkg = state.applicationDocs;
  if (!pkg) {
    $("applicationDocs").innerHTML = `<p class="muted">Builds automatically after QC passes — the required forms for this jurisdiction land here.</p>`;
    return;
  }
  const learned = pkg.learnedRequirements;
  const profile = pkg.profile || {};
  const learnedDocs = (learned && learned.requiredDocuments) || [];
  const pid = state.selectedProjectId;
  const docsRequired = profile.requiresAhjApplication || profile.requiresPortalEntryOnly;
  const profileNotes = (profile.notes || []).flatMap((n) => kbNotesHtml(n, { segmentsOnly: true }));
  $("applicationDocs").innerHTML = `
    ${renderPermitPathPanel(pkg)}
    ${renderFilledForms(pid)}
    <div id="submittalEmailCard"></div>
    <div class="kx-band">
      ${bandHead("AHJ PACKET", "Everything this jurisdiction asks for, in one set.")}
      <div class="kx-preflight">
        <div class="kx-preflight-head">
          <div>
            <span class="kx-preflight-eyebrow">Required document set</span>
            <span class="kx-preflight-subject">${esc(profile.name)}</span>
          </div>
          <span class="kx-preflight-tag">${docsRequired ? "Docs required" : "Manifest only"}</span>
        </div>
        <div class="kx-preflight-col">
          ${pkg.permitType ? `<div class="kx-issue-field"><span class="kx-issue-field-label">Permitting type</span><span class="kx-issue-field-value">${esc(pkg.permitType)}</span></div>` : ""}
          ${profileNotes.length ? `<div class="kx-issue-field"><span class="kx-issue-field-label">Jurisdiction notes</span><span class="kx-issue-field-value">${profileNotes.map(esc).join("<br>")}</span></div>` : ""}
          ${documentVerdictHtml(pkg, ...filledFormBlanks(state.filledForms?.projectId === pid ? (state.filledForms.forms || []) : []))}
        </div>
      </div>
    </div>
    ${learned ? `
    <article class="item info">
      <div class="item-title"><span>Learned ${esc(learned.ahj)}${learned.utility ? " / " + esc(learned.utility) : ""} requirements</span>${kbConfidenceBadge(learned)}</div>
      <p class="muted">From the knowledge base${learned.portalName ? ` · Portal: ${esc(learned.portalName)}` : ""}${learned.correctionCount ? ` · ${learned.correctionCount} correction(s) learned` : ""}.</p>
      <p><strong>Required docs (${learnedDocs.length}):</strong> ${esc(learnedDocs.join(" · "))}</p>
    </article>` : ""}
    <div class="app-doc-grid">${(pkg.docs || []).map((doc) => `
      <article class="item ${doc.required ? "info" : "pass"}">
        <div class="item-title"><span title="${esc(doc.fileName)}">${esc(doc.title)}</span>${statusBadge(doc.required ? "required" : "optional")}</div>
      </article>
    `).join("")}</div>
  `;
  bindFilledFormControls();
  document.querySelectorAll("[data-goto-permit-path]").forEach((b) => b.addEventListener("click", gotoPermitPathOverride));
  renderSubmittalEmail();
  if (window.lucide) window.lucide.createIcons();
}

// For email-submittal AHJs (e.g. Hillsboro), fetch + show a ready-to-send permit
// submittal email draft with copy buttons. Hidden for portal-submittal AHJs.
async function renderSubmittalEmail() {
  const card = $("submittalEmailCard");
  if (!card || !state.selectedProjectId) return;
  let draft;
  try {
    draft = await api(`/api/projects/${state.selectedProjectId}/submittal-email`);
  } catch { return; }
  if (!draft || !draft.isEmailSubmittal) { card.innerHTML = ""; return; }
  state._submittalEmail = draft;
  const mailto = `mailto:${encodeURIComponent(draft.to || "")}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
  card.innerHTML = `
    <article class="item info">
      <div class="item-title"><span>Email submittal draft</span>${statusBadge("email AHJ")}</div>
      <p class="muted" style="font-size:12px">This AHJ takes the completed application by email. Attach the building + electrical apps and plan set, then send.</p>
      <p><strong>Subject:</strong> ${esc(draft.subject)}</p>
      <pre class="record-cmd" style="white-space:pre-wrap;word-break:normal">${esc(draft.body)}</pre>
      <div class="actions">
        <a class="badge" href="${mailto}">Open in email app</a>
        <button id="copyEmailSubjectBtn" class="secondary ghost"><i data-lucide="clipboard-copy"></i><span>Copy subject</span></button>
        <button id="copyEmailBodyBtn" class="secondary ghost"><i data-lucide="clipboard-copy"></i><span>Copy body</span></button>
      </div>
    </article>`;
  const cs = $("copyEmailSubjectBtn");
  if (cs) cs.addEventListener("click", async () => { try { await navigator.clipboard.writeText(draft.subject); showMessage("Subject copied.", "info"); } catch { showMessage(draft.subject, "info"); } });
  const cb = $("copyEmailBodyBtn");
  if (cb) cb.addEventListener("click", async () => { try { await navigator.clipboard.writeText(draft.body); showMessage("Email body copied.", "info"); } catch { showMessage(draft.body, "info"); } });
  if (window.lucide) window.lucide.createIcons();
}

// Wire the dynamically-rendered "Find official form (AI)" + upload controls.
function bindFilledFormControls() {
  const findBtn = $("findAhjFormBtn");
  if (findBtn) findBtn.addEventListener("click", findAhjForm);
  const upload = $("uploadAhjFormInput");
  if (upload) upload.addEventListener("change", uploadAhjForm);
  document.querySelectorAll("[data-verify-form]").forEach((b) => b.addEventListener("click", () => verifyFilledForm(b.getAttribute("data-verify-form"))));
  document.querySelectorAll("[data-remap-form]").forEach((b) => b.addEventListener("click", () => remapFilledForm(b.getAttribute("data-remap-form"), b)));
  document.querySelectorAll("[data-detect-sign]").forEach((b) => b.addEventListener("click", () => detectRegistrySignatures(b.getAttribute("data-detect-sign"))));
}

// Rebuild the filled forms after a change (verify/remap/detect) and refresh the
// submit gate so the verification blocker clears.
async function rebuildFilledForms() {
  try {
    state.filledForms = await api(`/api/projects/${state.selectedProjectId}/filled-forms`, { method: "POST", body: "{}" });
  } catch (err) { showMessage(err.message || "Rebuild failed.", "error"); }
  await loadSubmitGate();
  renderApplicationDocs();
  renderSubmitGate();
  loadAhjForms();
}

async function verifyFilledForm(templateId) {
  if (!templateId) return;
  try {
    await api(`/api/ahj-templates/${templateId}/verify`, { method: "PATCH", body: JSON.stringify({ verified: true }) });
    showMessage("Form mapping marked verified.", "success");
    await rebuildFilledForms();
  } catch (err) { showMessage(err.message || "Verify failed.", "error"); }
}

async function remapFilledForm(templateId, btn) {
  if (!templateId) return;
  // Re-mapping calls the vision mapper and can take a minute — without visible
  // busy state the operator can't tell whether the click took, and clicks again.
  const prior = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Re-mapping… (can take ~1 min)"; }
  showMessage("Re-mapping the form from the stored blank…", "info");
  try {
    const out = await api(`/api/ahj-templates/${templateId}/remap`, { method: "POST", body: "{}" });
    showMessage(out.message || "Re-mapped. Open the PDF again to check placement, then verify.", "success");
    await rebuildFilledForms();
  } catch (err) { showMessage(err.message || "Re-map failed.", "error"); }
  finally { if (btn) { btn.disabled = false; btn.textContent = prior || "Re-map"; } }
}

async function detectRegistrySignatures(formId) {
  if (!formId) return;
  showMessage("Detecting signature lines on the form…", "info");
  try {
    const out = await api(`/api/ahj-forms/${encodeURIComponent(formId)}/detect-signatures`, { method: "POST", body: "{}" });
    showMessage(out.signatureCount ? `Found ${out.signatureCount} signature line(s). Your stored signature will be stamped.` : "No signature lines detected.", out.signatureCount ? "success" : "warning");
    await rebuildFilledForms();
  } catch (err) { showMessage(err.message || "Detection failed.", "error"); }
}

async function findAhjForm() {
  if (!state.selectedProjectId) return;
  const btn = $("findAhjFormBtn");
  const status = $("findAhjFormStatus");
  if (btn) btn.disabled = true;
  if (status) status.textContent = "Checking the AHJ's required official forms…";
  try {
    const result = await api(`/api/projects/${state.selectedProjectId}/find-ahj-form`, { method: "POST", body: "{}" });
    state.filledForms = result.filled || state.filledForms;
    state.applicationDocs = await api(`/api/projects/${state.selectedProjectId}/application-docs`);
    const e = result.ensure || {};
    const results = [e, ...(result.additional || [])];
    const missing = results.filter(r => !["acquired", "exists"].includes(r.status));
    const acquired = results.filter(r => r.status === "acquired").length;
    renderApplicationDocs();
    if (missing.length) showMessage(missing.map(r => r.message).join(" ") || "Some required forms still need attention.", "warning");
    else showMessage(acquired ? `${acquired} official form(s) acquired. Review the filled PDFs and remaining project requirements.` : "Available official forms are up to date with the stored templates. Review remaining project requirements.", "success");
  } catch (err) {
    if (status) status.textContent = "";
    showMessage(err.message || "Form lookup failed.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function uploadAhjForm(ev) {
  if (!state.selectedProjectId) return;
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const p = state.detail?.project || {};
  const status = $("findAhjFormStatus");
  if (status) status.textContent = `Uploading ${file.name} and mapping its fields…`;
  try {
    const buf = await file.arrayBuffer();
    const qs = new URLSearchParams({ ahj: p.ahj || "", state: p.state || "", filename: file.name });
    const res = await fetch(`/api/ahj-templates/upload?${qs.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: buf,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
    const out = await res.json();
    // Re-fill now that the template is stored.
    state.filledForms = await api(`/api/projects/${state.selectedProjectId}/filled-forms`, { method: "POST", body: "{}" });
    renderApplicationDocs();
    // NOT FILLABLE HAS MORE THAN ONE CAUSE. "This PDF has no fillable fields" was right for a flat
    // scan and wrong for an AcroForm whose fields mapped to nothing, a form for another
    // jurisdiction, or a revision that needs re-mapping — so say what the SERVER found (its
    // message is written per cause). showMessage assigns textContent, so the message is shown as
    // text, never parsed as markup; esc() here would print "&amp;" literally.
    showMessage(out.fillable
      ? `Uploaded and mapped ${out.fieldCount} field(s). The form is now auto-filled.`
      : `Uploaded — ${String(out.message || "the form could not be mapped, so it's stored as the blank for manual completion.")}`,
      out.fillable ? "success" : "warning");
  } catch (err) {
    if (status) status.textContent = "";
    showMessage(err.message || "Upload failed.", "error");
  }
}

// THE READINGS WE ARE STILL PUBLISHING THAT TODAY'S RULES WOULD CHANGE.
//
// Coos Bay's structural permits have said "Intake Requirements Needed" since Sep 3. The rule that
// reads that as "the city is waiting on US" landed an hour after the last check ran, so the stored
// rows — the ones the client page publishes — still say "In review by the jurisdiction" about a
// permit nobody is reviewing. Nothing is rewritten to fix that (permit_status_checks is an audit
// trail); the cure is a NEW check, and this is where an operator triggers one.
//
// THREE STATES, and the third is the one that gets lost:
//   · a list of rows        — these readings are stale, here is the re-check for each.
//   · checked, nothing      — the pass ran and every reading is current. Render nothing.
//   · checked === false     — the pass FAILED. We do not know. That must never look like the
//                             line above. The customer pages can only render a boolean, so this
//                             is the one surface that can say "unverified", and it says it.
function staleReadingPanel() {
  const report = state.staleReadings;
  if (!report) return "";
  if (report.checked === false) {
    return `
    <article class="item warning">
      <div class="item-title"><span>Staleness could not be checked</span><span class="badge badge-warning">Unverified</span></div>
      <p>The drift pass over this project's stored readings failed, so the badges below are
         <strong>unverified — not confirmed current</strong>. The client's status page is showing them
         without a caveat. Check the server log for <code>permit-monitor</code>, then re-check any
         filing you need to trust.</p>
    </article>`;
  }
  const rows = report.staleReadings || [];
  if (!rows.length) return "";
  return `
    <article class="item warning">
      <div class="item-title"><span>${rows.length} reading${rows.length === 1 ? "" : "s"} today's rules would classify differently</span><span class="badge badge-warning">Re-check</span></div>
      <p>These are the verdicts the client's status page is publishing right now. They were
         classified by rules we have since changed. Nothing is rewritten — a re-check writes a new
         row and leaves the old one in the audit trail.</p>
      ${rows.map((row) => {
        const manual = row.recheck?.body?.source !== "public_url";
        return `
        <p>
          <strong>${esc(row.label || "Filing")}</strong>${row.applicationNumber ? ` · ${esc(row.applicationNumber)}` : ""} —
          stored as “${esc(row.storedStatusLabel)}”, today’s rules read it as
          “${esc(row.currentStatusLabel)}”. Last checked ${esc(fmtDate(row.checkedAt))}.
          <button type="button" class="secondary" style="font-size:12px;margin-left:6px"
                  data-recheck-target="${esc(row.targetId)}"
                  data-recheck-source="${esc(row.recheck?.body?.source || "manual")}">
            ${manual ? "Paste a fresh status" : "Re-check now"}
          </button>
          ${manual ? `<span class="muted"> No portal URL on this filing — a fetch would only record “no status text”, so paste what the portal says.</span>` : ""}
        </p>`;
      }).join("")}
    </article>`;
}

// Delegated because the buttons above are re-rendered on every refresh. Registered once, on the
// container that already exists in dashboard.html.
function handleStaleRecheckClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest("button[data-recheck-target]");
  if (!button) return;
  const targetId = button.dataset.recheckTarget;
  if (button.dataset.recheckSource === "public_url") {
    // .catch, not a floating promise: a failed fetch here would otherwise vanish, and the panel
    // would go on showing the stale row with no explanation of why nothing happened.
    recordPermitStatus("public_url", targetId).catch((err) => showMessage(err.message || "Re-check failed.", "error"));
    return;
  }
  // No portal URL: firing a blind fetch here would replace a stale reading with a blanker one.
  // Send the operator to the paste box instead, with the filing already selected.
  const box = $("permitStatusText");
  if (box) { box.focus(); box.scrollIntoView({ behavior: "smooth", block: "center" }); }
  state.recheckTargetId = targetId;
  // The filing selector shows the same answer the POST will use.
  const picker = $("permitStatusTarget");
  if (picker) picker.value = targetId;
  syncPermitForm(); // the number fields follow the filing now selected
  showMessage("Paste what the portal says for this filing, then click Classify status — it will be recorded against that filing.", "info");
}

// WHICH KIND OF FILING a tracking target is — the ONE naming the filing selector and the tracking
// list both read. The list used to label every non-NEM target "(building permit)", so an
// electrical filing read "Online portal (building permit)" beside a selector that called it
// Electrical. structural is the building track's family (trackPermitTypes), so it reads Building.
function permitTargetKindLabel(target) {
  return target.targetType === "nem" || target.permitType === "nem" ? "Interconnection (NEM)"
    : target.permitType === "building" || target.permitType === "structural" ? "Building"
    : target.permitType === "electrical" ? "Electrical"
    : target.permitType === "combo" ? "Building + electrical (combo)"
    : "Permit";
}

// One filing, named the way the operator knows it: which permit + its application number.
function permitTargetOptionLabel(target) {
  const type = permitTargetKindLabel(target);
  const number = target.applicationNumber || target.permitNumber;
  const where = target.portalName || target.jurisdiction;
  return number ? `${type} · ${number}` : `${type} · ${where ? `${where}, ` : ""}no application number yet`;
}

// WHICH FILING the pasted status text is about. Without it, a paste on a project with a building
// AND an electrical (or a permit AND a NEM) filing was recorded against whichever target happened
// to be first. Hidden with 0 or 1 active filing — there is nothing to choose.
function renderPermitStatusTargetPicker() {
  const picker = $("permitStatusTarget");
  const label = $("permitStatusTargetLabel");
  if (!picker) return;
  const active = (state.detail?.permitCheckTargets || []).filter((t) => t && t.active !== false);
  const ids = active.map((t) => t.id);
  const previous = picker.value;
  picker.innerHTML = active.map((t) => `<option value="${esc(t.id)}">${esc(permitTargetOptionLabel(t))}</option>`).join("");
  // The operator's current pick first (a background re-render must not undo it; the stale panel
  // writes its target straight into the picker), then the stale panel's target, then the first.
  picker.value = ids.includes(previous) ? previous
    : ids.includes(state.recheckTargetId) ? state.recheckTargetId
    : (ids[0] || "");
  if (label) label.hidden = active.length <= 1;
}

// The target a pasted status is recorded against. An explicit id (the stale panel's fetch) wins;
// then the selector (only when it names a filing this project still has), then the stale panel's
// manual pick, then the first filing.
function permitStatusTargetId(explicitId) {
  const targets = state.detail?.permitCheckTargets || [];
  const picker = $("permitStatusTarget");
  const picked = picker && picker.value && targets.some((t) => t.id === picker.value) ? picker.value : null;
  return explicitId || picked || state.recheckTargetId || targets[0]?.id || null;
}

// WHAT THE PORTAL ITSELF SAYS for this filing (operator 2026-09-28: "pull exactly what the AHJ says …
// then we can just see what is needed directly without confusion"). Only the filing's NEWEST reading
// counts — an older reading's words beside a newer badge would be the stale answer in another form;
// when the newest reading states no status field, nothing is shown. Pure; lifted by
// backend/test/portalSays.test.ts.
function portalSaysFor(target, checks) {
  const mine = (checks || []).filter((c) => c && c.targetId === target.id);
  if (!mine.length) return null;
  const newest = mine.reduce((a, b) => (String(b.createdAt) > String(a.createdAt) ? b : a));
  const text = String(newest.portalStatedStatus || "").trim();
  return text ? { text, at: newest.createdAt } : null;
}

function renderPermitMonitor() {
  const targets = state.detail.permitCheckTargets || [];
  const checks = state.detail.permitStatusChecks || [];
  const emailMatches = state.detail.emailProjectMatches || [];
  renderPermitStatusTargetPicker();

  $("permitTargets").innerHTML = targets.length ? targets.map((target) => {
    const platformLabel = target.portalPlatform && target.portalPlatform !== "unknown" && target.portalPlatform !== "public_url"
      ? `<span style="font-size:11px;padding:1px 6px;border-radius:4px;background:var(--info);color:#fff;margin-left:6px">${esc(target.portalPlatform)}</span>`
      : "";
    const sourceLabel = ` · ${esc(permitTargetKindLabel(target))}`;
    const said = portalSaysFor(target, checks);
    return `
    <article class="item info">
      <div class="item-title"><span>${esc(target.portalName || target.jurisdiction || "Permit target")}${sourceLabel}</span>${statusBadge(target.latestOutcome || "active")}${platformLabel}</div>
      ${said ? `<p><strong>Portal says:</strong> “${esc(said.text)}” <span class="muted">· read ${esc(new Date(said.at).toLocaleString())}</span></p>` : ""}
      <p>${esc([target.applicationNumber && `Application ${target.applicationNumber}`, target.permitNumber && `Permit ${target.permitNumber}`].filter(Boolean).join(" | ") || "No application/permit number recorded yet.")}</p>
      ${target.portalUrl ? `<p class="muted" style="word-break:break-all">${esc(target.portalUrl)}</p>` : ""}
      <p class="muted">Checks every ${target.checkFrequencyDays} day(s) · Next: ${target.nextCheckAt ? esc(new Date(target.nextCheckAt).toLocaleString()) : "not scheduled"} · Source strategy: ${esc(target.portalPlatform || "auto")}</p>
    </article>`;
  }).join("") : `<p class="muted">No permit check targets yet.</p>`;

  // The API returns up to 50 status checks and most are literal duplicates — a
  // monitor that runs every few days re-records "In review" until something
  // changes. Rendering all of them at full weight buried the two or three that
  // actually carry news. Four at READ weight; the rest are one click away, and
  // each card's confidence/source/raw-text now sits behind its own disclosure
  // instead of printing at the same size as the operator's next action.
  const permitCheckCard = (check) => {
    const pct = Math.round((check.confidence || 0) * 100);
    const source = check.source || "manual";
    return `
    <article class="item ${check.outcome === "correction_flagged" ? "fail" : check.readyForIssue ? "pass" : check.outcome === "needs_human_review" ? "warning" : "info"}">
      <div class="item-title"><span>${esc(check.statusLabel)}</span>${statusBadge(statusLabel(check.outcome))}</div>
      <p>${esc(check.message)}</p>
      <details class="provenance">
        <summary>Evidence · ${pct}% · ${esc(source)}</summary>
        <div class="provenance-body">
          <p>${esc(fmtDate(check.createdAt))} · confidence ${pct}% · source: ${esc(source)}</p>
          ${check.rawStatusText
            ? `<p style="white-space:pre-wrap">${esc(check.rawStatusText.slice(0, 1200))}</p>`
            : `<p>No raw status text was captured for this check.</p>`}
        </div>
      </details>
    </article>`;
  };
  const recentChecks = checks.slice(0, 4);
  const earlierChecks = checks.slice(4);
  // The drift panel sits ABOVE the checks it is about: an operator reading the list has to know
  // which of these verdicts we can no longer stand behind before they read the verdicts.
  $("permitChecks").innerHTML = staleReadingPanel()
    + (checks.length
      ? recentChecks.map(permitCheckCard).join("")
        + (earlierChecks.length
          ? `<details class="provenance"><summary>${earlierChecks.length} earlier check${earlierChecks.length === 1 ? "" : "s"}</summary><div class="provenance-body">${earlierChecks.map(permitCheckCard).join("")}</div></details>`
          : "")
      : `<p class="muted">No permit status checks yet.</p>`);

  if (emailMatches.length) {
    $("permitChecks").innerHTML += `
      <article class="item info">
        <div class="item-title"><span>Matched email updates</span>${statusBadge(emailMatches.length)}</div>
        ${emailMatches.slice(0, 6).map((match) => `
          <p><strong>${esc(humanize(match.emailBucket))}</strong> ${esc(match.subject || "No subject")}</p>
          <p class="muted">${esc(match.matchReason)} | confidence ${Math.round((match.confidence || 0) * 100)}% | ${esc(fmtDate(match.createdAt))}</p>
        `).join("")}
      </article>
    `;
  }
}

function correctionSlaBadge(correction) {
  if (correction.closedAt) return `<span class="badge badge-pass">Closed</span>`;
  if (correction.isOverdue) return `<span class="badge badge-fail">Overdue (${correction.daysOpen}d)</span>`;
  const daysLeft = correction.slaDays - correction.daysOpen;
  if (daysLeft <= 1) return `<span class="badge badge-warning">Due tomorrow</span>`;
  return `<span class="badge badge-info">Due ${esc(correction.dueAt)} (${daysLeft}d left)</span>`;
}

// THE TRIAGE OUTPUT FOR ONE CORRECTION, found where the agent actually stores it.
//
// correctionAgent writes its proposals + checklist into the LINKED human-review item's notes as
// `agent-triage:{…}` (repository.applyCorrectionProposals reads them back the same way), so the
// correction row itself carries none of it. That is why the operator's only view of what the
// agent proposed lived in the human-review panel, two stages away from the corrections panel
// where they are actually working the correction. Same stored payload, read-only, rendered on
// the card the work happens on — no second copy and no second apply path.
//
// Returns null when nothing is linked: an ordinary state (triage runs as a background job and
// stub mode never writes proposals), and it renders as NOTHING rather than as an empty table
// implying the agent looked and found no changes.
function correctionTriage(correctionId) {
  for (const item of state.detail.humanReviewItems || []) {
    const notes = String(item.notes || "");
    if (!notes.startsWith("agent-triage:")) continue;
    let parsed = null;
    try { parsed = JSON.parse(notes.slice(13)); } catch { continue; }
    if (!parsed || parsed.correctionId !== correctionId) continue;
    return {
      itemStatus: item.status,
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals.filter((p) => p && typeof p.field === "string") : [],
      jurisdictionProposals: jurisdictionProposalList(parsed),
      // The project half of this approval already ran (only jurisdiction proposals are left).
      projectApplied: Boolean(parsed.projectAppliedAt),
      actions: Array.isArray(parsed.actions) ? parsed.actions.filter((a) => typeof a === "string") : [],
    };
  }
  return null;
}

// JURISDICTION PROPOSALS — a design requirement the AHJ stated in this correction ("Ground snow
// load 36 psf"), proposed for THAT AHJ's shared code profile, not for this project. Kept in its
// own list in the same stored payload (correctionAgent.attachJurisdictionProposals) and applied
// by the same Apply button (the route applies them as seeded, citing the comment; a verified
// profile is never touched). Every value is esc()'d: the basis is the AHJ's own sentence.
function jurisdictionProposalList(parsed) {
  return Array.isArray(parsed?.jurisdictionProposals)
    ? parsed.jurisdictionProposals.filter((p) => p && p.kind === "jurisdiction_design_criteria" && typeof p.criterion === "string")
    : [];
}

const JURISDICTION_CRITERION_LABELS = {
  groundSnowLoadPsf: ["Ground snow load", " psf"],
  windSpeedMph: ["Design wind speed (ultimate)", " mph"],
  windExposure: ["Wind exposure", ""],
  specialWindRegion: ["Special wind region", ""],
  maxAttachmentSpacingIn: ["Max attachment spacing", " in o.c."],
  listingEvidenceRequired: ["Module / racking UL listing evidence required", ""],
};
const JURISDICTION_STATUS_LABELS = {
  proposed: "Will apply",
  same_as_current: "Already on file",
  blocked_verified: "Profile verified — not changed",
  applied: "Applied (seeded)",
  refused: "Not applied",
};

// Pure (lifted by jurisdictionProposalRender.test.ts).
function jurisdictionProposalsHtml(list) {
  if (!list.length) return "";
  const show = (p, v) => {
    if (v === null || v === undefined || v === "") return "Blank";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    const unit = (JURISDICTION_CRITERION_LABELS[p.criterion] || ["", ""])[1];
    return `${v}${unit}`;
  };
  const rows = list.map((p) => `<tr>
      <td>${esc((JURISDICTION_CRITERION_LABELS[p.criterion] || [p.criterion])[0])}</td>
      <td>${esc(show(p, p.currentValue))}${p.currentConfidence ? ` <span class="muted">(${esc(p.currentConfidence)})</span>` : ""} &rarr; <strong>${esc(show(p, p.value))}</strong></td>
      <td>&ldquo;${esc(p.basis)}&rdquo;${p.source?.recordNumber ? ` <span class="muted">— ${esc(p.source.recordNumber)}</span>` : ""}</td>
      <td>${esc(JURISDICTION_STATUS_LABELS[p.status] || p.status)}${p.statusNote ? `<br><span class="muted" style="font-size:11px">${esc(p.statusNote)}</span>` : ""}</td>
    </tr>`).join("");
  // WHICH ROW IT WRITES — by exact key, named on the card. A row that does not exist yet is created
  // for this AHJ; a different row a name match would have picked is shown and never written.
  const first = list[0];
  const key = first.profileKey || first.targetProfileKey || "";
  // A verified row the reviews read (possibly under another label: "Portland" for "City of
  // Portland") is never written and never shadowed by a new one — say so instead of "Writes".
  const allBlocked = list.every((p) => p.status === "blocked_verified");
  const rowLine = allBlocked
    ? `Nothing is written: ${first.profileKey ? `profile row <code>${esc(first.profileKey)}</code> is human-verified` : "a human-verified profile governs these values"} — a person verifies them there.`
    : first.profileKey
    ? `Writes profile row <code>${esc(first.profileKey)}</code>.`
    : `No profile row for ${esc(first.ahj)} yet — applying creates <code>${esc(key)}</code>.`;
  const nearestLine = first.nearestOtherRow
    ? ` <span class="muted">Not ${esc(first.nearestOtherRow.ahj)} (<code>${esc(first.nearestOtherRow.key)}</code>), which a name match would pick — that row is not changed.</span>`
    : "";
  return `<p style="font-size:12px;margin:8px 0 2px"><strong>Jurisdiction requirements stated in this comment</strong> — for ${esc(first.ahj)} (${esc(first.state)})'s code profile, shared with every project there. ${rowLine}${nearestLine}</p>
      <table style="font-size:12px;margin-top:2px">
        <thead><tr><th>Criterion</th><th>On file &rarr; AHJ says</th><th>AHJ comment</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
}

// EVERY VALUE BELOW CAME OUT OF AN LLM and goes into innerHTML — field, currentValue,
// proposedValue, basis and each checklist line are esc()'d individually.
function correctionTriageHtml(correction, triage) {
  if (!triage) return "";
  const isDesign = correction.correctionBucket === "B_designer_fix";
  const rows = triage.proposals.map((p) => `<tr>
      <td>${esc(p.field)}</td>
      <td>${esc(p.currentValue || "Missing")}</td>
      <td>${esc(p.proposedValue)}</td>
      <td>${esc(p.basis)}</td>
    </tr>`).join("");
  // A design correction usually proposes no field change at all — its fix is a revised plan
  // set. Applying it there is not a data edit: it records the triage and parks the project on
  // the designer, which is the one thing this card could never say before.
  const jurisdictionPending = (triage.jurisdictionProposals || []).some((p) => p.status === "proposed");
  const designOwed = isDesign && !triage.projectApplied;
  const canApply = triage.itemStatus === "pending" && (triage.proposals.length > 0 || designOwed || jurisdictionPending);
  const applyLabel = triage.proposals.length ? "Apply these data updates" : jurisdictionPending && !designOwed ? "Apply the jurisdiction requirements" : "Record triage and wait on the designer";
  return `
      ${triage.proposals.length ? `<table style="font-size:12px;margin-top:6px">
        <thead><tr><th>Field</th><th>Current</th><th>Proposed</th><th>Evidence</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : ""}
      ${jurisdictionProposalsHtml(triage.jurisdictionProposals || [])}
      ${triage.actions.length ? `<ol style="font-size:12px;margin:6px 0 0 18px">${triage.actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>` : ""}
      ${canApply ? `<div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="primary" style="font-size:12px" data-apply-correction="${esc(correction.id)}">${esc(applyLabel)}</button>
        <span class="muted" style="font-size:11px">Applies the proposed project data${jurisdictionPending ? ", and records the jurisdiction requirements above on that AHJ's code profile as seeded (citing this comment)" : " only"}. It does not submit anything and does not close this correction — the correction closes when the resubmission actually goes out.</span>
      </div>` : ""}
      ${triage.itemStatus && triage.itemStatus !== "pending" ? `<p class="muted" style="font-size:11px;margin-top:6px">Triage already ${esc(triage.itemStatus)} — re-triage the correction to propose new changes.</p>` : ""}`;
}

// WHAT A CORRECTION REOPEN ACTUALLY DID, in the server's own words. The success toast used to
// be a bare "<n> document(s) staged" — a reopen that attached 0 of 3 revised documents read
// as a success, because the runner's reasons (driftWarnings) and its message were dropped.
// Pure: { text, kind } for showMessage (which writes textContent). Lifted by submitSeam.test.ts.
function reopenResultMessage(result) {
  const r = result || {};
  const drift = Array.isArray(r.driftWarnings) ? r.driftWarnings.map((w) => String(w)).filter(Boolean) : [];
  const driftText = drift.length
    ? ` ${drift.length} problem(s) while attaching — check these on the portal before resubmitting: ${drift.slice(0, 5).join(" | ")}${drift.length > 5 ? ` (+${drift.length - 5} more)` : ""}.`
    : "";
  if (r.ok) {
    const head = String(r.message || "").trim() || `Reopened "${r.reopenedForm || "the correction form"}".`;
    const docs = ` ${Number(r.attachedDocs) || 0} document(s) attached through the attach gate.`;
    const next = r.browserLeftOpen
      ? " The portal browser is open at the reopened application: verify everything, then click the portal's resubmit yourself."
      : " Open the portal, verify the reopened application, and resubmit it yourself.";
    return { text: `${head}${docs}${driftText}${next}`, kind: drift.length ? "warning" : "info" };
  }
  if (r.needsHuman) {
    const offered = (r.offeredForms || [])
      .concat((r.candidates || []).map((c) => `${c.applicationNumber} (${c.targetType}${c.portalName ? `, ${c.portalName}` : ""})`));
    return { text: `${r.message || "The correction reopen needs a person."}${offered.length ? ` — on offer: ${offered.join(" | ")}` : ""}${driftText}`, kind: "warning" };
  }
  return { text: `${r.message || "Correction reopen did not complete."}${driftText}`, kind: "error" };
}

// THE CORRECTION CARD LEADS WITH THE CORRECTION (operator 2026-09-27, "a bit cluttered"). It used
// to title itself with the bucket enum title-cased ("A We Fix") and print the correction's text
// raw — for a portal reading, the whole scraped record page. Now, in order: the correction itself
// (what the backend's correctionExtract read off the page — conditions / review comments — kept
// short), the required action, the root cause, the triage (proposals, checklist, apply), the
// draft reply, and the page it was read from in a COLLAPSED <details>. Long text never renders
// inline. The label is the backend's one map (CorrectionRecord.bucketLabel); humanize is only the
// fallback for a backend started before that field existed (the live server runs a mixed version).
// Pure — lifted by backend/test/correctionCardRender.test.ts. Every value is esc()'d.
const CORRECTION_LEAD_CHARS = 280;

function correctionCardHtml(correction, triage, projectStatus) {
  const text = String(correction.correctionText || "");
  const sourceText = String(correction.sourceText || "");
  const extraction = correction.extraction || "not_extracted";
  const clip = (s) => (s.length > CORRECTION_LEAD_CHARS ? `${s.slice(0, CORRECTION_LEAD_CHARS).trimEnd()}…` : s);
  const items = extraction === "items" ? text.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const lead = items.length > 1
    ? `<ul style="margin:2px 0 0 18px;padding:0">${items.slice(0, 5).map((l) => `<li>${esc(clip(l))}</li>`).join("")}</ul>${items.length > 5 ? `<p class="muted" style="font-size:11px;margin:2px 0">+${items.length - 5} more in the record text below.</p>` : ""}`
    : `<p style="margin:2px 0">${esc(clip(items[0] || text))}</p>`;
  const clipped = text.length > CORRECTION_LEAD_CHARS;
  const fellBack = extraction === "whole_text"
    ? `<p class="muted" style="font-size:11px;margin:2px 0">No condition or review-comment block was found on the portal page, so the whole page text stands as the correction${clipped ? " — its start is shown; the full text is below" : ""}.</p>`
    : "";
  // THE EVIDENCE, collapsed: the page it was read from — or, for a row stored before extraction
  // existed, its own long text (never printed inline in full). Not repeated when the lead above
  // already shows all of it.
  const evidence = sourceText || text;
  const record = evidence.trim() !== text.trim() || clipped ? evidence : "";
  const recordLabel = sourceText || correction.source === "portal" ? "Portal record text (as read)" : "Full correction text";
  // THE DESIGNER WAIT ENDS BY A PERSON SAYING SO. Offered only while the PROJECT is actually
  // parked at waiting_on_designer (not merely because the bucket is a design one), and never
  // driven by a document upload — an attached file is not evidence the revisions are done.
  // Deliberately not gated on closedAt: an operator who closed the correction by hand while
  // the project still waits would otherwise have no exit but the audited status override.
  const awaitingDesigner = projectStatus === "waiting_on_designer" && correction.correctionBucket === "B_designer_fix";
  return `
    <article class="item ${correction.isOverdue ? "fail" : correction.closedAt ? "pass" : "info"}">
      <div class="item-title">
        <span>${esc(correction.bucketLabel || humanize(correction.correctionBucket))}</span>
        <span>${correctionSlaBadge(correction)}</span>
        <span class="muted">${esc(fmtDate(correction.createdAt, true))}</span>
      </div>
      <div class="correction-lead" style="margin:4px 0 6px"><strong>Correction</strong>${lead}${fellBack}</div>
      ${correction.requiredAction ? `<p style="margin:0 0 4px"><strong>Required action:</strong> ${esc(correction.requiredAction)}</p>` : ""}
      ${correction.rootCause ? `<p class="muted" style="margin:0 0 4px"><strong>Root cause:</strong> ${esc(correction.rootCause)}</p>` : ""}
      ${correctionTriageHtml(correction, triage)}
      ${correction.draftResponse ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:12px">Draft reply to the reviewer (review before sending)</summary><div style="white-space:pre-wrap;font-size:12px;margin-top:4px">${esc(correction.draftResponse)}</div></details>` : ""}
      ${record ? `<details class="correction-record" style="margin-top:6px"><summary style="cursor:pointer;font-size:12px;color:var(--muted)">${esc(recordLabel)}</summary><div class="muted" style="white-space:pre-wrap;font-size:11px;max-height:240px;overflow:auto;margin-top:4px">${esc(record)}</div></details>` : ""}
      ${awaitingDesigner ? `
      <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="primary" data-revisions-received="${esc(correction.id)}" style="font-size:12px">Revisions received</button>
        <span class="muted" style="font-size:11px">Click this only when the revised plan set / calcs are actually in hand — uploading a file does not move the project. It goes to <strong>Ready to resubmit</strong>, where QC and every staging gate run again.</span>
      </div>` : ""}
      ${!correction.closedAt ? `
      <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="secondary" data-reopen-correction="${esc(correction.id)}" style="font-size:12px">Reopen correction form in portal</button>
        <span class="muted" style="font-size:11px">Opens the SUSPENDED filing's own correction form (never a new application, never a cancel/withdraw) and stages revised docs — you review and click the portal's resubmit yourself.</span>
      </div>` : ""}
    </article>`;
}

function renderCorrections() {
  const corrections = state.detail.corrections || [];
  const projectStatus = (state.detail.project || {}).status || "";
  $("corrections").innerHTML = corrections.length
    ? corrections.map((correction) => correctionCardHtml(correction, correctionTriage(correction.id), projectStatus)).join("")
    : `<p class="muted">No corrections recorded.</p>`;

  // Same endpoint the human-review panel posts to — one apply path, two places it can be
  // reached from. Handlers are bound per container, so neither double-fires.
  $("corrections").querySelectorAll("button[data-apply-correction]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        // The message reports WHAT THE SERVER DID, read off the returned detail — not what the
        // bucket predicts. A design apply only parks the project on the designer when it was
        // still in the correction flow; announcing a designer wait that did not happen (a job
        // already moved on to `submitted`, say) would be a reassuring lie on the one screen the
        // operator uses to decide their next move.
        const applied = await api(`/api/corrections/${encodeURIComponent(button.dataset.applyCorrection)}/apply`, { method: "POST", body: "{}" });
        await selectProject(state.selectedProjectId);
        showMessage(applied?.project?.status === "waiting_on_designer"
          ? "Triage applied. The project is now WAITING ON THE DESIGNER — click “Revisions received” once the revised design is actually in hand. Nothing was submitted and the correction is still open."
          : "Proposed data updates applied. Nothing was submitted and the correction is still open — review the revised documents and the correction response before resubmitting.");
      } catch (err) { showMessage(err.message, "error"); button.disabled = false; }
    });
  });

  $("corrections").querySelectorAll("button[data-revisions-received]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      const originalLabel = button.textContent;
      button.textContent = "Recording…";
      try {
        await api(`/api/corrections/${encodeURIComponent(button.dataset.revisionsReceived)}/revisions-received`, { method: "POST", body: "{}" });
        await selectProject(state.selectedProjectId);
        showMessage("Revised design recorded. The project is READY TO RESUBMIT — click 3 · Prepare Submittal to re-stage it; QC and every staging gate run again. The correction stays open until the resubmission goes out.");
      } catch (err) {
        showMessage(err.message, "error");
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });
  });

  $("corrections").querySelectorAll("button[data-reopen-correction]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      const originalLabel = button.textContent;
      button.textContent = "Reopening in portal…";
      try {
        const result = await api(`/api/corrections/${encodeURIComponent(button.dataset.reopenCorrection)}/reopen-portal`, { method: "POST", body: "{}" });
        await selectProject(state.selectedProjectId);
        const reopenMsg = reopenResultMessage(result);
        showMessage(reopenMsg.text, reopenMsg.kind);
      } catch (err) {
        showMessage(err.message, "error");
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });
  });
}

function renderPortalRuns() {
  const runs = state.detail.portalRuns || [];
  const awaiting = runs.find((run) => run.status === "awaiting_human_submit");
  // A CORRECTION REOPEN IS NOT A FIRST FILING. The paused finder used to match ANY paused run,
  // reopen runs included, and offered them the Capture Confirmation form — which stamps a
  // submissions row and would have picked the newest FAILED staging row for a filing that is
  // already on file. The backend now refuses that run type with a 409; this stops offering it.
  const paused = runs.find((run) => run.status === "paused_for_human" && run.runType !== "correction_reopen");
  const runCard = (run) => {
    const isMfa = run.pauseReason === "mfa_captcha";
    const cardClass = run.status === "failed" ? "fail" : isMfa ? "warning" : "info";
    const confirmLine = run.confirmationNumber ? `<p class="muted">Confirmation: <strong>${esc(run.confirmationNumber)}</strong></p>` : "";
    const mfaBanner = isMfa
      ? `<p class="submit-gate-check warning" style="margin-top:6px">Portal requires your attention — MFA or CAPTCHA detected. Complete it in the browser window, then click Retry to continue.</p>`
      : "";
    // THE REOPEN RUN'S OWN ACTION. Automation reopened the suspended filing's correction form,
    // staged the revised documents and STOPPED (hard rule 1 — the portal's resubmit is the
    // operator's click). This button is how that click gets recorded: it closes the
    // corrections the resubmission answers, returns the project to `submitted`, and pulls the
    // filing's tracking check forward. It is deliberately NOT a submit button — pressing it
    // before resubmitting in the portal records something that did not happen, which is why
    // the line beside it says so plainly.
    const resubmitAction = run.runType === "correction_reopen" && run.status === "awaiting_human_resubmit"
      ? `<div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="secondary" data-mark-resubmitted="${esc(run.id)}" style="font-size:12px">Mark resubmitted</button>
          <span class="muted" style="font-size:11px">Press this only AFTER you have clicked the portal's own resubmit. It records your click — it never submits anything — and closes the corrections this resubmission answers.</span>
        </div>`
      : "";
    return `
    <article class="item ${cardClass}">
      <div class="item-title"><span>${esc(humanize(run.runType))}</span>${statusBadge(run.status)}</div>
      <p>${run.humanActionRequired ? "Human action required before legal submission is complete." : "No human action currently flagged."}</p>
      ${mfaBanner}
      ${confirmLine}
      <p class="muted">${esc(run.errorMessage || run.startedAt)}</p>
      ${resubmitAction}
    </article>`;
  };
  // PIN WHAT A PERSON MUST ACT ON; FOLD THE HISTORY WITH ITS COUNTS. On 7ec74634 the one
  // actionable run was third of seven cards (five old FAILED runs), with Capture Confirmation
  // ~1,250px below the panel title. The pinned runs are: every run awaiting a human submit or
  // resubmit, and every paused run — the same states the capture form and the reopen action
  // are offered for. Everything else goes behind "Earlier runs (N · M failed)", so the failure
  // count is never hidden with the cards.
  const pinnedStatuses = ["awaiting_human_submit", "awaiting_human_resubmit", "paused_for_human"];
  const pinned = runs.filter((run) => pinnedStatuses.includes(run.status));
  const earlier = runs.filter((run) => !pinnedStatuses.includes(run.status));
  const earlierFailed = earlier.filter((run) => run.status === "failed").length;
  const pinnedWrap = $("portalRunsPinned");
  const prevFold = $("portalRuns").querySelector("details.runs-fold");
  const foldWasOpen = !!(prevFold && prevFold.open && $("portalRuns").dataset.projectId === (state.selectedProjectId || ""));
  if (pinnedWrap) {
    pinnedWrap.innerHTML = pinned.map(runCard).join("");
    $("portalRuns").innerHTML = !runs.length
      ? `<p class="muted">No portal runs yet.</p>`
      : earlier.length
        ? `<details class="runs-fold"${foldWasOpen || !pinned.length && earlier.length <= 2 ? " open" : ""}>
            <summary>${esc(pinned.length ? "Earlier runs" : "Runs")} (${esc(String(earlier.length))}${earlierFailed ? ` · ${esc(String(earlierFailed))} failed` : ""})</summary>
            <div class="stack">${earlier.map(runCard).join("")}</div>
          </details>`
        : "";
  } else {
    $("portalRuns").innerHTML = runs.length ? runs.map(runCard).join("") : `<p class="muted">No portal runs yet.</p>`;
  }
  $("portalRuns").dataset.projectId = state.selectedProjectId || "";

  document.querySelectorAll("#portalRunsPinned button[data-mark-resubmitted], #portalRuns button[data-mark-resubmitted]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Record that YOU clicked the portal's resubmit on this reopened application?\n\nThis closes the open corrections it answers. It does not submit anything.")) return;
      button.disabled = true;
      const originalLabel = button.textContent;
      button.textContent = "Recording…";
      try {
        const result = await api(`/api/portal-runs/${encodeURIComponent(button.dataset.markResubmitted)}/mark-resubmitted`, { method: "POST", body: "{}" });
        await selectProject(state.selectedProjectId);
        // An unknown must never read as reassurance: a resubmission the monitor cannot poll,
        // or corrections that did not close, is a WARNING even though the record was written.
        showMessage(result.message, result.checkTargetRefreshed && !result.correctionsStillOpen ? "info" : "warning");
      } catch (err) {
        showMessage(err.message, "error");
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });
  });

  const form = $("confirmationForm");
  form.hidden = !awaiting && !paused;
  form.dataset.portalRunId = (awaiting || paused)?.id || "";
}

function renderAudit() {
  const logs = state.detail.auditLogs || [];
  // Already inside a collapsed accordion, so this is about the length of the
  // list once opened. A cap without a denominator reads as "that's all of it" —
  // always say how many there really are.
  const shown = logs.slice(0, 20);
  $("auditLog").innerHTML = logs.length ? shown.map((log) => `
    <article class="item info">
      <div class="item-title"><span>${esc(log.action)}</span><span>${esc(fmtDate(log.createdAt))}</span></div>
      <p>${esc(log.actorType)}: ${esc(log.actorName)}</p>
    </article>
  `).join("") + (logs.length > shown.length
      ? `<p class="disclosure-count">Showing the ${shown.length} most recent of ${logs.length} audit entries.</p>`
      : "") : `<p class="muted">No audit entries yet.</p>`;
}

async function autofillSpecs() {
  if (!state.selectedProjectId) return;
  const btn = $("autofillSpecsBtn");
  const status = $("autofillSpecsStatus");
  if (btn) btn.disabled = true;
  if (status) status.textContent = "Looking up the inverter datasheet (knowledge first, web if needed)…";
  try {
    const modelOverride = ($("autofillModelInput")?.value || "").trim();
    const qtyOverride = parseInt($("autofillQtyInput")?.value || "0", 10) || 0;
    const body = JSON.stringify({ modelOverride: modelOverride || undefined, qtyOverride: qtyOverride || undefined });
    const result = await api(`/api/projects/${state.selectedProjectId}/autofill-specs`, { method: "POST", body });
    if (result.detail) state.detail = result.detail;
    const s = result.spec || {};
    // System total is what gets filled into "Inverter output (A)" (per-unit × qty for
    // microinverters); show that, noting the per-unit basis for clarity.
    const totalA = s.totalContinuousCurrentA ?? s.outputCurrentA;
    const perUnitNote = (s.inverterQty > 1 && s.outputCurrentA != null) ? ` (${s.outputCurrentA} A × ${s.inverterQty})` : "";
    if (result.applied > 0) {
      if (status) status.textContent = `Filled ${result.applied} field(s) from ${esc(s.source || "lookup")} (${esc(s.confidence || "?")} confidence): inverter output ${totalA ?? "?"} A${perUnitNote}, suggested PV breaker ${s.derivedPvBreakerA ?? "?"} A. Review and Save Edit each. ${esc(s.notes || "")}`;
      renderDetail();
    } else if (totalA != null) {
      if (status) status.textContent = `Found inverter output ${totalA} A${perUnitNote} / suggested breaker ${s.derivedPvBreakerA ?? "?"} A, but there were no pending inverter-output/PV-breaker items to fill (run QC first if needed).`;
    } else {
      if (status) status.textContent = s.notes || "Could not determine the inverter spec — enter it manually from the datasheet/SLD.";
    }
  } catch (err) {
    if (status) status.textContent = "";
    showMessage(err.message || "Auto-fill specs failed.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function updateReview(reviewItemId, action) {
  const input = $(`review-${reviewItemId}`);
  const value = (input?.value || "").trim();
  // Guard the trap: approving/saving a BLANK value writes nothing, so the QC
  // blocker never clears and the project looks stuck. Require a real value.
  if (action !== "reject" && !value) {
    showMessage("Type the value first (read it off the plan set / SLD), then click Save Edit. Approving a blank field won't clear the QC blocker. If a value truly doesn't apply, use Reject.", "warning");
    if (input) input.focus();
    return;
  }
  // Capture every typed value NOW — before any await below re-renders and wipes
  // the inputs — so saving/rejecting one item never discards what was typed into
  // the others. Exclude the item being saved (it leaves the pending list).
  const savedInputs = {};
  document.querySelectorAll("[id^='review-']").forEach((el) => { if (el.value) savedInputs[el.id] = el.value; });
  delete savedInputs[`review-${reviewItemId}`];

  // DO NOT SEND `notes`. The only visible button on a correction card used to
  // post notes:"Verified from dashboard." (or "Rejected from dashboard."), and
  // humanVerify writes `input.notes || item.notes` — so the generic string
  // OVERWROTE the item's notes. For a correction review item those notes are not
  // prose: correctionAgent stores its triage payload there as `agent-triage:{…}`,
  // and parseCorrectionProposals only matches /^agent-triage:(\{…\})$/. Once the
  // blob was clobbered it returned null forever, applyCorrectionProposals applied
  // ZERO updates, and the approval endpoint still set corrections.human_approved
  // = 1 — an approval that silently changed nothing.
  //
  // Omitting the field is the whole fix: `input.notes || item.notes` then keeps
  // whatever the item already carried (the triage blob, or the QC reason the
  // field was flagged), and the normalized-field row still gets its own
  // "Human verified from review queue." default server-side. The ACTION is what
  // records the human decision — the note was never load-bearing for that.
  const body = {
    reviewItemId,
    action,
    fieldValue: value,
  };
  state.detail = await api(`/api/projects/${state.selectedProjectId}/human-verify`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  state.reviewerReport = null;
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("Human review item updated. QC was rerun automatically.");
  renderDetail();
  // Restore the captured values, OVERWRITING the re-rendered defaults, so the
  // operator's in-progress entries in the other rows survive the save.
  Object.entries(savedInputs).forEach(([id, val]) => { const el = $(id); if (el) el.value = val; });
  await loadProjects();
}

async function syncOpsPlan() {
  if (!state.selectedProjectId) return;
  state.opsPlan = await api(`/api/projects/${state.selectedProjectId}/ops-plan/sync`, { method: "POST", body: "{}" });
  state.opsBrief = await api(`/api/projects/${state.selectedProjectId}/ops-brief`);
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage(`Operations plan synced. Next: ${state.opsPlan.nextAction}`);
  renderSubmitGate();
  renderOpsBrief();
  renderHandoffPacket();
  renderCommunicationDrafts();
  renderRunbook();
  renderOpsPlan();
  renderLiveTestReadiness();
  if (window.lucide) window.lucide.createIcons();
}

async function saveRunbookCurrentStep() {
  if (!state.selectedProjectId || !state.runbook) return;
  const step = (state.runbook.steps || []).find((item) => item.isCurrent)
    || (state.runbook.steps || []).find((item) => ["blocked", "waiting", "in_progress", "not_started"].includes(item.status));
  if (!step) {
    showMessage("No current runbook step to update.", "warning");
    return;
  }
  state.opsPlan = await api(`/api/projects/${state.selectedProjectId}/ops-steps/${step.id}`, {
    method: "POST",
    body: JSON.stringify({
      status: $("runbookQuickStatus").value,
      ownerRole: $("runbookQuickOwner").value,
      dueAt: $("runbookQuickDue").value || null,
      notes: $("runbookQuickNotes").value,
    }),
  });
  state.opsBrief = await api(`/api/projects/${state.selectedProjectId}/ops-brief`);
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("Current runbook step updated.");
  renderSubmitGate();
  renderOpsBrief();
  renderHandoffPacket();
  renderCommunicationDrafts();
  renderRunbook();
  renderOpsPlan();
  renderLiveTestReadiness();
  renderProjectTimeline();
  await refreshProjectListOnly();
  if (window.lucide) window.lucide.createIcons();
}

async function saveOpsStep(stepId) {
  if (!state.selectedProjectId || !stepId) return;
  state.opsPlan = await api(`/api/projects/${state.selectedProjectId}/ops-steps/${stepId}`, {
    method: "POST",
    body: JSON.stringify({
      status: $(`ops-status-${stepId}`).value,
      ownerRole: $(`ops-owner-${stepId}`).value,
      dueAt: $(`ops-due-${stepId}`).value || null,
      notes: $(`ops-notes-${stepId}`).value,
    }),
  });
  state.opsBrief = await api(`/api/projects/${state.selectedProjectId}/ops-brief`);
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("Operations phase updated.");
  renderSubmitGate();
  renderOpsBrief();
  renderHandoffPacket();
  renderCommunicationDrafts();
  renderRunbook();
  renderOpsPlan();
  renderLiveTestReadiness();
  await refreshProjectListOnly();
  if (window.lucide) window.lucide.createIcons();
}

async function saveActionStep(projectId, stepId) {
  if (!projectId || !stepId) return;
  const updatedPlan = await api(`/api/projects/${projectId}/ops-steps/${stepId}`, {
    method: "POST",
    body: JSON.stringify({
      status: $(`action-status-${stepId}`).value,
      ownerRole: $(`action-owner-${stepId}`).value,
      dueAt: $(`action-due-${stepId}`).value || null,
      notes: $(`action-notes-${stepId}`).value,
    }),
  });
  if (projectId === state.selectedProjectId) {
    state.opsPlan = updatedPlan;
    state.opsBrief = await api(`/api/projects/${projectId}/ops-brief`);
    state.detail = await api(`/api/projects/${projectId}`);
    await loadPmPackets();
    await loadLiveReadiness();
    await loadProjectTimeline();
    await loadProcessMap();
    await loadInstallerPacket();
    renderDetail();
  }
  showMessage("Action updated.");
  await refreshProjectListOnly();
  if (window.lucide) window.lucide.createIcons();
}

async function addOpsNote() {
  if (!state.selectedProjectId) return;
  const body = $("opsNoteBody").value.trim();
  if (!body) {
    showMessage("Add a note before saving.", "warning");
    return;
  }
  state.opsPlan = await api(`/api/projects/${state.selectedProjectId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      noteType: $("opsNoteType").value,
      body,
      createdBy: $("opsNoteAuthor").value || "Operations",
    }),
  });
  state.opsBrief = await api(`/api/projects/${state.selectedProjectId}/ops-brief`);
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  $("opsNoteBody").value = "";
  showMessage("PM note added.");
  renderSubmitGate();
  renderOpsBrief();
  renderHandoffPacket();
  renderCommunicationDrafts();
  renderRunbook();
  renderOpsPlan();
  renderLiveTestReadiness();
  if (window.lucide) window.lucide.createIcons();
}

async function copyHandoff() {
  const note = state.opsBrief?.handoffNote || "";
  if (!note) {
    showMessage("No handoff note generated yet.", "warning");
    return;
  }
  await writeClipboardText(note, "PM handoff copied.");
}

async function copyRunbook() {
  const text = state.runbook?.reportText || "";
  if (!text) {
    showMessage("No PM runbook generated yet.", "warning");
    return;
  }
  await writeClipboardText(text, "PM runbook copied.");
}

async function copyHandoffPacket() {
  const text = state.handoffPacket?.reportText || "";
  if (!text) {
    showMessage("No project handoff packet generated yet.", "warning");
    return;
  }
  await writeClipboardText(text, "Project handoff packet copied.");
}

function communicationDraftText(draft) {
  return [`Subject: ${draft.subject}`, "", draft.body].join("\n");
}

async function writeClipboardText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  showMessage(successMessage);
}

async function copyCommunicationDraft(index) {
  const draft = state.communicationDrafts?.drafts?.[index];
  if (!draft) {
    showMessage("Communication draft not found.", "warning");
    return;
  }
  await writeClipboardText(communicationDraftText(draft), `${draft.title} copied.`);
}

async function copyCommunicationDrafts() {
  const text = state.communicationDrafts?.reportText || "";
  if (!text) {
    showMessage("No communication drafts generated yet.", "warning");
    return;
  }
  await writeClipboardText(text, "Communication drafts copied.");
}

async function copySubmitGate() {
  const text = state.submitGate?.reportText || "";
  if (!text) {
    showMessage("No submit gate generated yet.", "warning");
    return;
  }
  await writeClipboardText(text, "PermitFlow + NEMflow submit gate copied.");
}

async function copyOpsReport() {
  const text = state.opsReport?.reportText || "";
  if (!text) {
    showMessage("No Daily Ops Report generated yet.", "warning");
    return;
  }
  await writeClipboardText(text, "Daily Ops Report copied.");
}

async function copyLiveReadiness() {
  const text = state.liveReadiness?.reportText || "";
  if (!text) {
    showMessage("No live readiness report generated yet.", "warning");
    return;
  }
  await writeClipboardText(text, "Live readiness report copied.");
}

async function copyProcessMap() {
  const text = state.processMap?.reportText || "";
  if (!text) {
    showMessage("No PermitFlow + NEMflow map generated yet.", "warning");
    return;
  }
  await writeClipboardText(text, "PermitFlow + NEMflow map copied.");
}

async function copyInstallerPacket() {
  const text = state.installerPacket?.reportText || "";
  if (!text) {
    showMessage("No installer action packet generated yet.", "warning");
    return;
  }
  await writeClipboardText(text, "Installer action packet copied.");
}

async function copyProjectTimeline() {
  const text = state.projectTimeline?.reportText || "";
  if (!text) {
    showMessage("No project timeline generated yet.", "warning");
    return;
  }
  await writeClipboardText(text, "Project timeline copied.");
}

async function runQc() {
  state.detail = await api(`/api/projects/${state.selectedProjectId}/qc`, { method: "POST", body: "{}" });
  state.workflow = null;
  state.reviewerReport = null;
  state.historicalReport = null;

  // Auto-advance: when QC passes, automatically build the AHJ/NEM docs and run
  // the reviewer gate so the coordinator doesn't have to click each step. Both
  // are advisory generators (no legal submit happens here).
  let advanced = "";
  if (state.detail?.project?.status === "qc_passed") {
    try {
      const [docs, reviewer] = await Promise.all([
        api(`/api/projects/${state.selectedProjectId}/application-docs`),
        api(`/api/projects/${state.selectedProjectId}/reviewer-report`),
      ]);
      state.applicationDocs = docs;
      state.reviewerReport = reviewer;
      // Unknown AHJ? Auto-onboard it with the LLM (research requirements + docs,
      // save to the KB) so it's ready for this and future projects.
      if (!docs.learnedRequirements && /generic/i.test(docs.profile?.name || "") && state.detail?.project?.ahj) {
        try {
          const r = await api(`/api/projects/${state.selectedProjectId}/research-ahj`, { method: "POST", body: "{}" });
          if (r.saved && r.applicationDocs) {
            state.applicationDocs = r.applicationDocs;
            advanced = ` Unknown AHJ — AI-researched ${state.detail.project.ahj} and saved ${r.research.requiredDocuments.length} required doc(s) to the knowledge base (verify before relying on it).`;
          } else if (r.research?.provider === "stub") {
            advanced = ` Unknown AHJ — set ANTHROPIC_API_KEY to auto-research it.`;
          } else {
            // RESEARCH THAT LEARNED NOTHING MUST NOT READ AS "HANDLED". A real provider can
            // come back with zero required documents (live: Des Moines, IA — the save is
            // correctly refused so nothing false enters the KB), and with no branch here the
            // message fell through to "Auto-built AHJ/NEM docs … ran the reviewer gate",
            // which tells the operator the AHJ was dealt with when nothing was learned. The
            // knowledge-base panel has always said this plainly; the project path did not.
            advanced = ` Unknown AHJ — auto-research returned NO requirements for ${esc(state.detail.project.ahj || "this AHJ")}.`
              + ` Nothing was saved to the knowledge base. Research it by name in Knowledge Base, or add the requirements by hand before filing.`;
          }
        } catch (err) { advanced = ` (AHJ auto-research snag: ${err.message || ""})`; }
      }
      const blk = (reviewer.findings || []).filter((f) => f.severity === "blocker").length;
      if (!advanced) advanced = ` Auto-built AHJ/NEM docs (${docs.profile.name}) and ran the reviewer gate — ${blk} blocker(s).`;
      else advanced += ` Reviewer gate: ${blk} blocker(s).`;
    } catch (err) {
      advanced = ` (auto-advance hit a snag: ${err.message || "could not build docs/reviewer"})`;
    }
  }

  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("QC complete." + advanced);
  renderDetail();
  await loadProjects();
}

async function runWorkflow() {
  if (!state.selectedProjectId) return;
  const workflow = await api(`/api/projects/${state.selectedProjectId}/workflow`, { method: "POST", body: "{}" });
  state.workflow = workflow;
  state.historicalReport = workflow.historicalReport;
  state.reviewerReport = workflow.reviewerReport;
  state.applicationDocs = workflow.applicationDocs;
  state.detail = await api(`/api/projects/${state.selectedProjectId}`);
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage(`Workflow complete. Next: ${workflow.nextAction}`, workflow.status === "blocked" ? "warning" : "info");
  renderDetail();
  await refreshProjectListOnly();
}

async function runHistoricalCheck() {
  if (!state.selectedProjectId) return;
  state.historicalReport = await api(`/api/projects/${state.selectedProjectId}/historical-failures`);
  state.workflow = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  const missing = (state.historicalReport.checklist || []).filter((item) => item.status === "missing").length;
  showMessage(`Historical check complete: ${state.historicalReport.matchedProjectCount ?? 0} similar project(s), ${state.historicalReport.matchedFailureRecordCount ?? 0} failure/delay record(s), ${missing} missing checklist item(s).`);
  renderSubmitGate();
  renderHistoricalFailures();
  renderLiveTestReadiness();
  if (window.lucide) window.lucide.createIcons();
}

// Staging now runs as a background job (POST returns 202 + jobId). Poll the job until it
// finishes, then resolve with the terminal job record (status "done" | "failed"). The
// project detail is refetched by the caller on success; on failure job.error carries the
// reason (e.g. the missing-portal-field message).
function waitForStagingJob(jobId) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const job = await api(`/api/jobs/${jobId}`);
        if (job.status === "running" || job.status === "pending") {
          setTimeout(tick, 1500);
        } else {
          resolve(job); // done | failed
        }
      } catch (err) {
        reject(err);
      }
    };
    setTimeout(tick, 800);
  });
}

async function prepareSubmission() {
  try {
    showMessage("Staging in the portal — this runs in the background and may take a moment…", "info");
    const { jobId } = await api(`/api/projects/${state.selectedProjectId}/prepare-submission`, { method: "POST", body: "{}" });
    const job = await waitForStagingJob(jobId);
    if (job.status === "failed") {
      showMessage(job.error || "Staging failed — see the run log for details.", "warning");
      return;
    }
    if (job.result && job.result.status === "failed") {
      showMessage(`Staging failed: ${job.result.message || "see the run log on the project for details."}`, "error");
      return;
    }
    if (job.result && job.result.status === "paused_for_human") {
      showMessage(job.result.message
        ? `Portal run paused for you: ${job.result.message}`
        : `Portal run paused at a ${job.result.pauseReason || "verification"} challenge — nothing was staged. Complete the challenge in the open browser, then re-stage.`, "warning");
      return;
    }
    state.detail = await api(`/api/projects/${state.selectedProjectId}`);
    await loadOpsPlan();
    await loadPmPackets();
    await loadLiveReadiness();
    await loadProjectTimeline();
    await loadProcessMap();
    await loadInstallerPacket();
    showMessage("Staged to final review. Verify every field, then submit manually in the portal — automation never clicks final submit. Check the submit gate / run log for any per-track failures.");
    renderDetail();
    await loadProjects();
  } catch (err) {
    const details = err.details ? Object.entries(err.details).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : (value && typeof value === "object" ? JSON.stringify(value) : value)}`).join(" | ") : "";
    showMessage([err.message, details].filter(Boolean).join("\n"), "warning");
  }
}

async function addCorrection() {
  const correctionText = $("correctionText").value.trim();
  if (!correctionText) {
    showMessage("Paste correction text before adding.", "warning");
    return;
  }
  state.detail = await api(`/api/projects/${state.selectedProjectId}/corrections`, {
    method: "POST",
    body: JSON.stringify({ correctionText, source: "manual" }),
  });
  $("correctionText").value = "";
  state.workflow = null;
  state.reviewerReport = null;
  state.historicalReport = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("Correction added and classified.");
  renderDetail();
  await loadProjects();
}

// A REFUSAL MUST BE SEEN. The server refuses a utility interconnection URL on a permit target
// (rule 5) with a 400 that says where the link belongs; without this catch the rejection was
// unhandled and clicking Track did nothing visible — an operator read "nothing happened".
async function addPermitTarget() {
  if (!state.selectedProjectId) return;
  try {
    state.detail = await api(`/api/projects/${state.selectedProjectId}/permit-targets`, {
      method: "POST",
      body: JSON.stringify({
        jurisdiction: $("permitJurisdiction").value,
        portalName: $("permitPortalName").value,
        portalUrl: $("permitPortalUrl").value,
        applicationNumber: $("permitApplicationNumber").value,
        permitNumber: $("permitTrackingNumber").value,
        checkFrequencyDays: Number($("permitCheckFrequencyDays").value || 7),
      }),
    });
  } catch (err) {
    showMessage(err.message || "Could not save the tracking target.", "error");
    return;
  }
  state.workflow = null;
  state.historicalReport = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("Permit check target saved.");
  renderDetail();
  await loadProjects();
}

// `targetId` is EXPLICIT when the caller knows which filing it means. The default — the project's
// FIRST target — was the only behaviour, and on a project with a structural and an electrical
// permit (Coos Bay: both, one stalled) it silently recorded every re-check against whichever
// happened to be first. The stale panel always passes the target its row is about.
async function recordPermitStatus(source = "manual", targetId = null) {
  if (!state.selectedProjectId) return;
  const rawStatusText = source === "mock" ? "" : $("permitStatusText").value.trim();
  if (source === "manual" && !rawStatusText) {
    showMessage("Paste AHJ/portal status text before classifying.", "warning");
    return;
  }
  const chosenId = permitStatusTargetId(targetId);
  // The number fields above were filled from ONE filing (syncPermitForm, recorded in
  // state.permitFormFor). Sent with another filing's check they would stamp that filing's number
  // on this one's row; sent empty, the server records the chosen filing's own numbers.
  const formIsChosen = !chosenId || state.permitFormFor === `${state.detail.project?.id || ""}|${chosenId}`;
  state.detail = await api(`/api/projects/${state.selectedProjectId}/permit-checks`, {
    method: "POST",
    body: JSON.stringify({
      targetId: chosenId,
      source,
      rawStatusText,
      applicationNumber: formIsChosen ? $("permitApplicationNumber").value : "",
      permitNumber: formIsChosen ? $("permitTrackingNumber").value : "",
    }),
  });
  $("permitStatusText").value = "";
  state.recheckTargetId = null;
  state.workflow = null;
  state.historicalReport = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  // The new row is the CURE for a stale reading, so re-run the drift report: a mark that survives
  // a fresh check is noise, and one that vanishes without a check would be a lie.
  await loadStaleReadings();
  const latest = state.detail.permitStatusChecks?.[0];
  showMessage(latest ? `Permit check classified: ${latest.statusLabel}` : "Permit check recorded.");
  renderDetail();
  await loadProjects();
}

async function buildApplicationDocs() {
  if (!state.selectedProjectId) return;
  state.applicationDocs = await api(`/api/projects/${state.selectedProjectId}/application-docs`);
  state.workflow = null;
  // Also fill the AHJ's REAL permit PDF(s) — the official blank form filled with
  // this project's data (not a worksheet). Surfaced as download links below.
  try {
    state.filledForms = await api(`/api/projects/${state.selectedProjectId}/filled-forms`, { method: "POST", body: "{}" });
  } catch (err) {
    state.filledForms = { error: err.message || "Could not fill the AHJ PDF form." };
  }
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage(`Built AHJ docs for ${state.applicationDocs.profile?.name || "this jurisdiction"}.`);
  renderSubmitGate();
  renderApplicationDocs();
  renderLiveTestReadiness();
  if (window.lucide) window.lucide.createIcons();
}

function openApplicationDocs() {
  if (!state.selectedProjectId) return;
  window.open(`/api/projects/${state.selectedProjectId}/application-docs?format=html`, "_blank");
}

async function runReviewerGate(refresh = false) {
  if (!state.selectedProjectId) return;
  showMessage(refresh ? "Re-running vision (clearing cache — will re-check all plan sheets)…" : "Running reviewer gate with vision verification…", "info");
  const qs = refresh ? "vision=1&refresh=1" : "vision=1";
  state.reviewerReport = await api(`/api/projects/${state.selectedProjectId}/reviewer-report?${qs}`);
  state.workflow = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  const reviewerFindings = state.reviewerReport.findings || [];
  const blockers = reviewerFindings.filter((item) => item.severity === "blocker").length;
  const warnings = reviewerFindings.filter((item) => item.severity === "warning").length;
  showMessage(`Reviewer gate complete: ${blockers} blocker(s), ${warnings} warning(s).`);
  renderSubmitGate();
  renderReviewerGate();
  renderLiveTestReadiness();
  if (window.lucide) window.lucide.createIcons();
}

function setMboxProgress(percent, text, visible = true) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  $("mboxProgressWrap").hidden = !visible;
  $("mboxProgressBar").style.width = `${clamped}%`;
  $("mboxProgressPercent").textContent = `${clamped}%`;
  $("mboxProgressText").textContent = text;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function mboxResultMessage(result) {
  const counts = result.bucketCounts || {};
  const bucketSummary = Object.entries(counts)
    .filter(([, count]) => Number(count) > 0)
    .map(([bucket, count]) => `${bucket.replaceAll("_", " ")}: ${count}`)
    .join(" | ");
  return [
    `MBOX import learned ${result.learningEvents} event(s), imported ${result.failureExamplesImported} failure example(s), touched ${result.profilesTouched} profile(s).`,
    bucketSummary ? `Buckets: ${bucketSummary}.` : "",
    result.duplicateMessages ? `Duplicates skipped: ${result.duplicateMessages}.` : "",
    result.llmReviewRecommended ? `LLM review recommended for ${result.llmReviewRecommended} uncertain message(s).` : "",
  ].filter(Boolean).join("\n");
}

function uploadMboxFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const sourceLabel = encodeURIComponent(file.name || "Imported MBOX file");
    xhr.open("POST", `/api/knowledge-base/import-mbox-file?sourceLabel=${sourceLabel}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      setMboxProgress((event.loaded / event.total) * 92, `Uploading ${file.name} (${formatBytes(event.loaded)} / ${formatBytes(event.total)})...`);
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        data = {};
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.error || `MBOX upload failed with status ${xhr.status}.`));
        return;
      }
      resolve(data);
    };
    xhr.onerror = () => reject(new Error("Browser could not upload the selected MBOX file. Paste the local file path below and use Import Path."));
    xhr.onabort = () => reject(new Error("MBOX import was canceled."));
    setMboxProgress(1, `Starting upload for ${file.name} (${formatBytes(file.size)})...`);
    xhr.send(file);
  });
}

async function importMbox(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  setMboxProgress(1, `Reading ${file.name} (${formatBytes(file.size)})…`);
  try {
    const result = await uploadMboxFile(file);
    setMboxProgress(100, "Import complete.");
    event.target.value = "";
    showMessage(mboxResultMessage(result));
    await loadKnowledgeBase();
    if (state.selectedProjectId) {
      await loadPmPackets();
      await loadLiveReadiness();
      await loadProcessMap();
      await loadInstallerPacket();
      renderSubmitGate();
      renderHandoffPacket();
      renderCommunicationDrafts();
      renderRunbook();
      renderLiveTestReadiness();
      renderProcessMap();
      renderInstallerPacket();
    }
    window.setTimeout(() => setMboxProgress(0, "", false), 1800);
  } catch (err) {
    event.target.value = "";
    setMboxProgress(0, "Import failed.", true);
    showMessage(`${err.message || "MBOX import failed."}\nIf the file is cloud-only, locked by Outlook, or too large for browser upload, paste its full local path and click Import Path.`, "error");
  }
}

async function importMboxPath() {
  const filePath = $("mboxPath").value.trim();
  if (!filePath) {
    $("mboxPath").value = "";
    showMessage("Paste the full local MBOX file path before using Import Path.", "warning");
    return;
  }
  try {
    setMboxProgress(15, "Reading local file path on backend...");
    const result = await api("/api/knowledge-base/import-mbox-path", {
      method: "POST",
      body: JSON.stringify({ filePath }),
    });
    setMboxProgress(100, "Import complete.");
    showMessage(mboxResultMessage(result));
    await loadKnowledgeBase();
    if (state.selectedProjectId) {
      await loadPmPackets();
      await loadLiveReadiness();
      await loadProcessMap();
      await loadInstallerPacket();
      renderSubmitGate();
      renderHandoffPacket();
      renderCommunicationDrafts();
      renderRunbook();
      renderLiveTestReadiness();
      renderProcessMap();
      renderInstallerPacket();
    }
    window.setTimeout(() => setMboxProgress(0, "", false), 1800);
  } catch (err) {
    setMboxProgress(0, "Import failed.", true);
    showMessage(err.message || "MBOX path import failed.", "error");
  }
}

async function saveEmailWatch() {
  const filePath = $("emailWatchPath").value.trim();
  if (!filePath) {
    showMessage("Paste the full local MBOX path to watch before saving an email tracker source.", "warning");
    return;
  }
  state.emailTracker = await api("/api/email-tracker/sources", {
    method: "POST",
    body: JSON.stringify({ filePath, label: "Live permitting/NEM mailbox" }),
  });
  renderEmailTracker();
  if (state.selectedProjectId) {
    await loadPmPackets();
    await loadLiveReadiness();
    await loadProcessMap();
    await loadInstallerPacket();
    renderSubmitGate();
    renderHandoffPacket();
    renderCommunicationDrafts();
    renderRunbook();
    renderLiveTestReadiness();
    renderProcessMap();
    renderInstallerPacket();
  }
  showMessage("Email watch source saved. Use Scan Email to match corrections, NEM approvals, fees, and status updates to projects.");
}

async function runEmailTracker() {
  const filePath = $("emailWatchPath").value.trim();
  const body = filePath && !(state.emailTracker?.sources || []).some((source) => source.filePath === filePath)
    ? { filePath }
    : {};
  try {
    const result = await api("/api/email-tracker/run", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.emailTracker = await api("/api/email-tracker");
    renderEmailTracker();
    if (state.selectedProjectId) state.detail = await api(`/api/projects/${state.selectedProjectId}`);
    if (state.selectedProjectId) await loadOpsPlan();
    if (state.selectedProjectId) await loadPmPackets();
    if (state.selectedProjectId) await loadLiveReadiness();
    if (state.selectedProjectId) await loadProjectTimeline();
    if (state.selectedProjectId) await loadProcessMap();
    if (state.selectedProjectId) await loadInstallerPacket();
    renderDetail();
    await refreshProjectListOnly();
    const errorText = result.sourceErrors?.length ? ` Errors: ${result.sourceErrors.join("; ")}` : "";
    showMessage(`Email scan complete: ${result.messagesScanned} message(s), ${result.projectMatches} project match(es), ${result.statusChecksCreated} status update(s), ${result.correctionsCreated} correction(s).${errorText}`, result.sourceErrors?.length ? "warning" : "info");
  } catch (err) {
    showMessage(err.message || "Email scan failed.", "error");
  }
}

async function deleteSelectedProject() {
  if (!state.selectedProjectId || !state.detail?.project) return;
  const project = state.detail.project;
  const label = project.homeownerName || project.projectAddress || project.id;
  // Deleting a project cascades: documents, QC results, corrections, notes,
  // submissions history, review items — permanently. Proportional friction: the
  // operator types DELETE rather than clicking through a reflex confirm.
  const typed = window.prompt(
    `PERMANENTLY delete this project and everything attached to it?\n\n` +
    `  ${label}\n\n` +
    `This removes its documents, QC results, corrections, notes, and submission history. ` +
    `It cannot be undone from the app (backups keep mirrored document files only).\n\n` +
    `Type DELETE to confirm:`,
  );
  if (typed !== "DELETE") return;
  const deletedId = state.selectedProjectId;
  await api(`/api/projects/${deletedId}`, { method: "DELETE" });
  state.selectedProjectId = null;
  state.detail = null;
  state.workflow = null;
  state.applicationDocs = null;
  state.filledForms = null;
  state.reviewerReport = null;
  state.historicalReport = null;
  state.opsPlan = null;
  state.opsBrief = null;
  state.handoffPacket = null;
  state.communicationDrafts = null;
  state.runbook = null;
  state.liveReadiness = null;
  state.projectTimeline = null;
  state.processMap = null;
  state.installerPacket = null;
  state.submitGate = null;
  await loadProjects();
  if (state.detail) showMessage(`Deleted project ${deletedId}.`);
}

function openReviewerPacket() {
  if (!state.selectedProjectId) return;
  window.open(`/api/projects/${state.selectedProjectId}/reviewer-report?format=html`, "_blank");
}

async function runPermitMonitor() {
  const result = await api("/api/permit-monitor/run", { method: "POST", body: "{}" });
  showMessage(`Permit monitor ran ${result.checked || 0} due check(s).`);
  await loadProjects();
}

async function captureConfirmation(event) {
  event.preventDefault();
  const portalRunId = $("confirmationForm").dataset.portalRunId;
  if (!portalRunId) return;
  state.detail = await api(`/api/portal-runs/${portalRunId}/capture-confirmation`, {
    method: "POST",
    body: JSON.stringify({
      applicationNumber: $("applicationNumber").value,
      permitNumber: $("permitNumber").value,
      confirmationNumber: $("confirmationNumber").value,
      submittedBy: $("submittedBy").value,
      notes: $("confirmationNotes").value,
    }),
  });
  state.workflow = null;
  state.historicalReport = null;
  await loadOpsPlan();
  await loadPmPackets();
  await loadLiveReadiness();
  await loadProjectTimeline();
  await loadProcessMap();
  await loadInstallerPacket();
  showMessage("Confirmation captured after human submit.");
  renderDetail();
  await loadProjects();
}

$("refreshBtn").addEventListener("click", loadProjects);
$("runPermitMonitorBtn").addEventListener("click", runPermitMonitor);
$("opsActions").addEventListener("click", handleOpsActionClick);
$("opsActionFrame").addEventListener("load", handleOpsActionFrameLoad);
$("syncOpsPlanBtn").addEventListener("click", syncOpsPlan);
$("addOpsNoteBtn").addEventListener("click", addOpsNote);
$("copyHandoffBtn").addEventListener("click", copyHandoff);
$("copyRunbookBtn").addEventListener("click", copyRunbook);
$("copyHandoffPacketBtn").addEventListener("click", copyHandoffPacket);
$("copyCommunicationDraftsBtn").addEventListener("click", copyCommunicationDrafts);
// Tokenized read-only status page for the client — created on demand, then copied.
// The same link is auto-included in automated client update emails.
$("shareStatusLinkBtn")?.addEventListener("click", async () => {
  const p = state.detail?.project;
  if (!p) { showMessage("Open a project first.", "warning"); return; }
  try {
    const res = await api(`/api/projects/${p.id}/share-status`, { method: "POST", body: "{}" });
    await writeClipboardText(res.url, "Client status link copied — anyone with it sees address + status only (no login).");
  } catch (err) {
    showMessage(err.message || "Could not create the status link.", "error");
  }
});
$("copySubmitGateBtn").addEventListener("click", copySubmitGate);
$("copyOpsReportBtn").addEventListener("click", copyOpsReport);
$("copyLiveReadinessBtn").addEventListener("click", copyLiveReadiness);
$("copyProcessMapBtn").addEventListener("click", copyProcessMap);
$("copyInstallerPacketBtn").addEventListener("click", copyInstallerPacket);
$("copyTimelineBtn").addEventListener("click", copyProjectTimeline);
$("runWorkflowBtn").addEventListener("click", runWorkflow);
$("runQcBtn").addEventListener("click", runQc);
$("runHistoricalBtn").addEventListener("click", runHistoricalCheck);
$("runReviewerGateBtn").addEventListener("click", () => runReviewerGate(false));
$("refreshReviewerGateBtn").addEventListener("click", () => runReviewerGate(true));
$("buildAppDocsBtn").addEventListener("click", buildApplicationDocs);
$("openAppDocsBtn").addEventListener("click", openApplicationDocs);
$("openReviewerPacketBtn").addEventListener("click", openReviewerPacket);
$("prepareBtn").addEventListener("click", prepareSubmission);
$("startAutopilotBtn").addEventListener("click", startAutopilot);
$("approveSubmitBtn").addEventListener("click", approveAndSubmit);
$("deleteProjectBtn").addEventListener("click", deleteSelectedProject);
$("applyStatusOverrideBtn")?.addEventListener("click", applyStatusOverride);
$("addCorrectionBtn").addEventListener("click", addCorrection);
$("addPermitTargetBtn").addEventListener("click", addPermitTarget);
$("recordPermitStatusBtn").addEventListener("click", () => recordPermitStatus("manual"));
// Picking another filing re-fills the form's numbers from THAT filing (never the one before it).
$("permitStatusTarget")?.addEventListener("change", syncPermitForm);
// The stale-reading panel renders inside #permitChecks and is rebuilt on every refresh, so its
// re-check buttons are bound by delegation on the container, once.
$("permitChecks").addEventListener("click", handleStaleRecheckClick);
// Mock Check removed for production: it recorded a FABRICATED status check on a
// real project's permit history. Simulated checks live in tests, not the UI.
$("mockPermitCheckBtn")?.addEventListener("click", () => recordPermitStatus("mock"));
$("confirmationForm").addEventListener("submit", captureConfirmation);
$("mboxFile").addEventListener("change", importMbox);
$("importMboxPathBtn").addEventListener("click", importMboxPath);
$("saveEmailWatchBtn").addEventListener("click", saveEmailWatch);
$("runEmailTrackerBtn").addEventListener("click", runEmailTracker);

// ----- MBOX drag-and-drop -----
(function () {
  const zone = $("mboxDropZone");
  function highlight(e) { e.preventDefault(); e.stopPropagation(); zone.classList.add("drag-over"); }
  function unhighlight(e) { e.preventDefault(); e.stopPropagation(); zone.classList.remove("drag-over"); }
  zone.addEventListener("dragenter", highlight);
  zone.addEventListener("dragover", highlight);
  zone.addEventListener("dragleave", unhighlight);
  zone.addEventListener("drop", async (e) => {
    unhighlight(e);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    try {
      setMboxProgress(1, `Reading ${file.name}…`);
      const result = await uploadMboxFile(file);
      setMboxProgress(100, "Import complete.");
      showMessage(mboxResultMessage(result));
      await loadKnowledgeBase();
      window.setTimeout(() => setMboxProgress(0, "", false), 1800);
    } catch (err) {
      setMboxProgress(0, "Import failed.", true);
      showMessage(err.message || "MBOX import failed.", "error");
    }
  });
})();

// ----- Batch import drag-and-drop: a .zip uploads + extracts + scans -----
function uploadBatchZip(file) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ label: file.name || "batch" });
    const ahj = $("batchDefaultAhj").value.trim();
    const utility = $("batchDefaultUtility").value.trim();
    const stateVal = $("batchDefaultState").value.trim();
    if (ahj) params.set("defaultAhj", ahj);
    if (utility) params.set("defaultUtility", utility);
    if (stateVal) params.set("defaultState", stateVal);
    if ($("batchUseLlm").checked) params.set("useLlm", "true");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/batch-import/upload-zip?${params.toString()}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const pct = Math.round((event.loaded / event.total) * 100);
      $("batchScanStatus").textContent = `Uploading ${file.name}… ${pct}% (${formatBytes(event.loaded)} / ${formatBytes(event.total)})`;
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch { data = {}; }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.error || `Zip upload failed (status ${xhr.status}).`));
        return;
      }
      resolve(data);
    };
    xhr.onerror = () => reject(new Error("Browser could not upload the zip. If it's very large, unzip it to a folder and use the Scan Folder path instead."));
    $("batchScanStatus").textContent = `Reading ${file.name} (${formatBytes(file.size)})…`;
    xhr.send(file);
  });
}

async function handleBatchDrop(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".7z") || name.endsWith(".rar") || name.endsWith(".tar") || name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
    showMessage(`"${file.name}" is a ${name.split(".").pop().toUpperCase()} archive — only .zip is supported for browser upload. Extract it to a folder on your machine first, then paste that folder path into the "Scan Folder" field below and click Scan Folder.`, "error");
    $("batchScanStatus").textContent = `Unsupported archive format. Extract to a folder and use Scan Folder path instead.`;
    return;
  }
  if (name.endsWith(".zip")) {
    try {
      const job = await uploadBatchZip(file);
      $("batchScanStatus").textContent = `Extracted ${job.extractedPdfCount} PDF${job.extractedPdfCount === 1 ? "" : "s"} — scanning now…`;
      if (typeof pollBatchJob === "function") pollBatchJob(job.id);
    } catch (err) {
      $("batchScanStatus").textContent = err.message || "Zip import failed.";
      showMessage(err.message || "Zip import failed.", "error");
    }
  } else if (name.endsWith(".pdf")) {
    showMessage("For loose PDFs, zip them into one .zip and drop that — or put them in a folder and use Scan Folder. Single-file upload isn't wired to the disk scanner.", "info");
  } else {
    showMessage("Drop a .zip of your project PDFs here.", "error");
  }
}

(function () {
  const zone = $("batchDropZone");
  const input = $("batchDropInput");
  function highlight(e) { e.preventDefault(); e.stopPropagation(); zone.classList.add("drag-over"); }
  function unhighlight(e) { e.preventDefault(); e.stopPropagation(); zone.classList.remove("drag-over"); }
  zone.addEventListener("dragenter", highlight);
  zone.addEventListener("dragover", highlight);
  zone.addEventListener("dragleave", unhighlight);
  zone.addEventListener("drop", (e) => {
    unhighlight(e);
    const file = e.dataTransfer.files?.[0];
    if (file) handleBatchDrop(file);
  });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) handleBatchDrop(file);
    input.value = "";
  });
})();

// ----- Clients & contractor licensing -----
const CLIENT_TEXT_FIELDS = [
  "companyName", "legalBusinessName", "dba", "contactName", "contactEmail", "phone", "billingStatus", "billingMode", "serviceFeeUsd",
  "ccbLicenseNumber", "ccbExpiration", "electricalLicenseNumber", "metroCityLicenseNumber",
  "electricalSupervisorName", "electricianLicenseNumber",
  "ein", "bondCarrier", "insuranceCarrier", "businessAddress", "businessCity", "businessState",
  "businessZip", "businessPhone", "businessEmail", "authorizedSignerName", "authorizedSignerTitle", "notes",
];

// ----- State licences (Clients editor) -----
// THE ONE KIND LIST (shared/src/licenceKinds.ts LICENCE_KINDS): kind, label, and whether it is a
// PERSON's licence (carries a holder's name). backend/test/licencesByType.test.ts fails on drift.
const LICENCE_KIND_OPTIONS = [
  { kind: "contractor", label: "Contractor (general / building / residential)", person: false },
  { kind: "electrical_contractor", label: "Electrical contractor", person: false },
  { kind: "construction_supervisor", label: "Construction supervisor", person: true },
  { kind: "home_improvement_contractor", label: "Home improvement contractor", person: false },
  { kind: "solar_contractor", label: "Solar contractor", person: false },
  { kind: "master_electrician", label: "Master / supervising electrician", person: true },
  { kind: "business_registration", label: "Business registration (not a contractor licence)", person: false },
];

/** The editor's rows for one client, straight from what the server stored. */
function stateLicencesFromClient(client) {
  const list = client && Array.isArray(client.stateLicenses) ? client.stateLicenses : [];
  return list.map((l) => ({
    state: String(l.state || ""), kind: String(l.kind || ""), number: String(l.number || ""),
    expires: String(l.expires || ""), holder: String(l.holder || ""),
  }));
}

function licenceKindIsPerson(kind) {
  return LICENCE_KIND_OPTIONS.some((k) => k.kind === kind && k.person);
}

/** One licence row. Every stored value goes through esc(); a kind the list does not know is kept
 *  and shown so it is never silently changed. */
function stateLicenceRowHtml(lic, idx) {
  const known = LICENCE_KIND_OPTIONS.some((k) => k.kind === lic.kind);
  const options = LICENCE_KIND_OPTIONS.map((k) => `<option value="${esc(k.kind)}"${k.kind === lic.kind ? " selected" : ""}>${esc(k.label)}</option>`).join("");
  const unknownOption = !known && lic.kind ? `<option value="${esc(lic.kind)}" selected>${esc(lic.kind)} - pick a type</option>` : "";
  const blankOption = !lic.kind ? `<option value="" selected>Type...</option>` : "";
  const person = licenceKindIsPerson(lic.kind);
  return `<div class="state-licence-row" data-sl-row="${idx}">
      <input data-sl="state" data-idx="${idx}" maxlength="2" placeholder="ST" aria-label="State" value="${esc(lic.state)}" />
      <select data-sl="kind" data-idx="${idx}" aria-label="Licence type">${blankOption}${unknownOption}${options}</select>
      <input data-sl="number" data-idx="${idx}" placeholder="Licence number" aria-label="Licence number" value="${esc(lic.number)}" />
      <input data-sl="expires" data-idx="${idx}" type="date" aria-label="Expires" value="${esc(lic.expires)}" />
      <input data-sl="holder" data-idx="${idx}" placeholder="${person ? "Holder name" : "Holder: person licences"}" aria-label="Holder" value="${esc(lic.holder)}"${person ? "" : " disabled"} />
      <button type="button" class="danger-button" data-remove-sl="${idx}" aria-label="Remove licence"><i data-lucide="x"></i><span>Remove</span></button>
    </div>`;
}

/** The rows as the API takes them, and what is wrong with any half-filled row. An untouched new
 *  row is dropped; a row with a number but no state or type is an error, never silently dropped. */
function stateLicencesPayload(drafts) {
  const list = [];
  const errors = [];
  (drafts || []).forEach((d, i) => {
    const st = String(d.state || "").trim().toUpperCase();
    const number = String(d.number || "").trim();
    const kind = String(d.kind || "").trim();
    const expires = String(d.expires || "").trim();
    const holder = String(d.holder || "").trim();
    if (!st && !number && !kind && !expires && !holder) return;
    const isState = st.length === 2 && st.split("").every((c) => c >= "A" && c <= "Z");
    if (!isState) errors.push(`State licence row ${i + 1}: the state must be two letters, e.g. MA.`);
    else if (!number) errors.push(`State licence row ${i + 1}: the licence number is missing.`);
    else if (!kind) errors.push(`State licence row ${i + 1}: pick the licence type.`);
    else list.push({ state: st, kind, number, ...(expires ? { expires } : {}), ...(holder ? { holder } : {}) });
  });
  return { list, errors };
}

/** THE SAVE NEVER WIPES LICENCES: stateLicenses goes out only as the editor's FULL list, and only
 *  when that list was loaded from THIS client (updateClient is a partial update — no key, no write). */
function withStateLicences(payload, drafts, loadedFor, clientId) {
  if (loadedFor !== clientId) return payload;
  return { ...payload, stateLicenses: stateLicencesPayload(drafts).list };
}

function renderStateLicences() {
  const wrap = $("stateLicencesList");
  if (!wrap) return;
  const drafts = state.stateLicencesDraft || [];
  wrap.innerHTML = drafts.length
    ? drafts.map(stateLicenceRowHtml).join("")
    : `<p class="muted">No state licences yet. Add one row per licence: state, type, number.</p>`;
  wrap.querySelectorAll("[data-sl]").forEach((el) => {
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      const row = state.stateLicencesDraft[Number(el.dataset.idx)];
      if (!row) return;
      row[el.dataset.sl] = el.value;
      if (el.dataset.sl === "kind") renderStateLicences();
    });
  });
  wrap.querySelectorAll("[data-remove-sl]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.stateLicencesDraft.splice(Number(btn.dataset.removeSl), 1);
      renderStateLicences();
    });
  });
  if (window.lucide) window.lucide.createIcons();
}

function clientFormStatus(message, kind) {
  const el = $("clientFormStatus");
  if (!message) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.textContent = message;
  el.style.borderLeftColor = kind === "error" ? "var(--danger)" : "var(--info)";
}

async function loadClients() {
  const data = await api("/api/clients");
  state.clients = data.clients || [];
  renderClientsList();
  // Sync, not just re-render: a project opened before this list arrived had its client id
  // set on a select with no matching option, so the header read "Client: — none —".
  if (state.detail) syncProjectClientSelect(); else renderProjectClientOptions();
  renderProjectClientFilterOptions();
}

function renderClientsList() {
  const list = $("clientsList");
  if (!state.clients || state.clients.length === 0) {
    list.innerHTML = `<p class="muted">No clients yet. Click New to add one.</p>`;
    return;
  }
  list.innerHTML = state.clients.map((client) => `
    <button type="button" class="client-row${client.id === state.editingClientId ? " active" : ""}" data-client-id="${esc(client.id)}">
      <strong>${esc(client.companyName || client.legalBusinessName || "Unnamed")}</strong>
      <span class="muted">${esc(client.ccbLicenseNumber ? "CCB " + client.ccbLicenseNumber : "No CCB on file")}${esc((client.stateLicenses || []).length ? ` · ${client.stateLicenses.length} state licence${client.stateLicenses.length === 1 ? "" : "s"}` : "")}</span>
    </button>
  `).join("");
  list.querySelectorAll("[data-client-id]").forEach((btn) => {
    btn.addEventListener("click", () => editClient(btn.dataset.clientId));
  });
}

function renderProjectClientOptions() {
  const select = $("projectClientSelect");
  if (!select) return;
  const current = select.value;
  const options = ['<option value="">— none —</option>'].concat(
    (state.clients || []).map((c) => `<option value="${esc(c.id)}">${esc(c.companyName || c.legalBusinessName || "Unnamed")}</option>`),
  );
  select.innerHTML = options.join("");
  select.value = current;
}

function syncProjectClientSelect() {
  const select = $("projectClientSelect");
  if (!select) return;
  renderProjectClientOptions();
  select.value = state.detail?.project?.clientId || "";
  updateHeadMetaSummary();
}

// The two head <select>s live behind one closed fold now, so the values they
// hold are written onto the fold's always-visible summary line. textContent on
// purpose: client and user names are tenant data and never reach innerHTML.
function updateHeadMetaSummary() {
  const out = $("headMetaSummary");
  if (!out) return;
  const read = (id) => {
    const sel = $(id);
    return sel && sel.value && sel.selectedIndex >= 0 && sel.options
      ? String(sel.options[sel.selectedIndex]?.textContent || "").trim()
      : "";
  };
  const client = read("projectClientSelect");
  const assignee = read("projectAssignSelect");
  out.textContent = `Client: ${client || "— none —"} · Assigned: ${assignee || "unassigned"}`;
}

// Reflect the project's SAVED assignee in the dropdown on every detail render.
// Without this the select reset to blank each load, so the operator thought the
// assignment hadn't saved and re-picked it every time.
function syncProjectAssignSelect() {
  const select = $("projectAssignSelect");
  if (!select) return;
  renderProjectUserOptions();
  select.value = state.detail?.project?.assignedUserId || "";
  updateHeadMetaSummary();
}

function blankClientForm() {
  state.editingClientId = null;
  $("clientId").value = "";
  CLIENT_TEXT_FIELDS.forEach((field) => { const el = $("c_" + field); if (el) el.value = ""; });
  state.portalIdentitiesDraft = [];
  renderPortalIdentities();
  // A new client: its licence list starts empty and IS the list saved with it.
  state.stateLicencesDraft = [];
  state.stateLicencesLoadedFor = "";
  renderStateLicences();
  clientFormStatus("");
  if ($("clientCredentials")) $("clientCredentials").hidden = true;
  renderClientsList();
}

async function loadClientCredentials(clientId) {
  const wrap = $("clientCredentials");
  if (!wrap) return;
  wrap.hidden = false;
  try {
    const data = await api(`/api/clients/${clientId}/portal-credentials`);
    const list = $("credList");
    const creds = data.credentials || [];
    list.innerHTML = creds.length
      ? creds.map((c) => `<div class="cred-row">
          <div class="cred-row-text"><strong>${esc(portalDisplayName(c.portalType, c.portalUrl))}</strong><span class="cred-row-user">${esc(c.usernameReference)}${c.hasSecret ? ' <span class="cred-row-lock" title="Password stored encrypted">🔒</span>' : ""}</span></div>
          <button type="button" class="danger-button cred-row-del" data-cred-del="${esc(c.id)}"><i data-lucide="trash-2"></i><span>Delete</span></button></div>`).join("")
      : '<p class="muted clients-creds-hint">No saved logins yet.</p>';
    if (window.lucide) window.lucide.createIcons();
    list.querySelectorAll("[data-cred-del]").forEach((b) => b.addEventListener("click", async () => {
      try {
        // A stored portal login is unrecoverable once deleted (encrypted at rest,
        // shown once) — never a silent one-click.
        if (!window.confirm("Permanently delete this stored portal login?\n\nIt cannot be recovered — you would re-enter the credentials to restore it.")) return;
        await api(`/api/clients/${clientId}/portal-credentials/${b.getAttribute("data-cred-del")}`, { method: "DELETE" }); await loadClientCredentials(clientId); }
      catch (err) { $("credStatus").textContent = err.message || "Delete failed."; }
    }));
  } catch (err) {
    $("credList").innerHTML = `<p class="muted">${esc(err.message || "Could not load logins.")}</p>`;
  }
}

function editClient(clientId) {
  const client = (state.clients || []).find((c) => c.id === clientId);
  if (!client) return;
  state.editingClientId = clientId;
  if ($("clientLinkResultWrap")) $("clientLinkResultWrap").hidden = true;
  if ($("clientLinkStatus")) $("clientLinkStatus").textContent = "";
  $("clientId").value = clientId;
  CLIENT_TEXT_FIELDS.forEach((field) => { const el = $("c_" + field); if (el) el.value = client[field] || ""; });
  state.portalIdentitiesDraft = (client.portalIdentities || []).map((i) => ({
    portalType: i.portalType, installerCompanyLabel: i.installerCompanyLabel, installerContactCode: i.installerContactCode, notes: i.notes,
  }));
  renderPortalIdentities();
  // The editor holds THIS client's full stored list; only a list loaded here is ever saved back.
  state.stateLicencesDraft = stateLicencesFromClient(client);
  state.stateLicencesLoadedFor = clientId;
  renderStateLicences();
  clientFormStatus("");
  loadClientCredentials(clientId);
  renderClientsList();
}

function renderPortalIdentities() {
  const wrap = $("portalIdentitiesList");
  const drafts = state.portalIdentitiesDraft || [];
  if (drafts.length === 0) {
    wrap.innerHTML = `<p class="muted">No portal identities. Add one if this client submits through PowerClerk or Accela.</p>`;
    return;
  }
  wrap.innerHTML = drafts.map((identity, idx) => `
    <div class="portal-identity-row">
      <select data-pi="portalType" data-idx="${idx}">
        <option value="powerclerk_pge"${identity.portalType === "powerclerk_pge" ? " selected" : ""}>PowerClerk (PGE)</option>
        <option value="accela_oregon"${identity.portalType === "accela_oregon" ? " selected" : ""}>Oregon ePermitting (Accela)</option>
      </select>
      <input data-pi="installerCompanyLabel" data-idx="${idx}" placeholder="Installer company label" value="${esc(identity.installerCompanyLabel || "")}" />
      <input data-pi="installerContactCode" data-idx="${idx}" placeholder="Contact / account code" value="${esc(identity.installerContactCode || "")}" />
      <button type="button" class="danger-button" data-remove-pi="${idx}"><i data-lucide="x"></i></button>
    </div>
  `).join("");
  wrap.querySelectorAll("[data-pi]").forEach((el) => {
    el.addEventListener("input", () => {
      const idx = Number(el.dataset.idx);
      state.portalIdentitiesDraft[idx][el.dataset.pi] = el.value;
    });
  });
  wrap.querySelectorAll("[data-remove-pi]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.portalIdentitiesDraft.splice(Number(btn.dataset.removePi), 1);
      renderPortalIdentities();
      if (window.lucide) window.lucide.createIcons();
    });
  });
  if (window.lucide) window.lucide.createIcons();
}

function collectClientPayload() {
  const payload = { portalIdentities: state.portalIdentitiesDraft || [] };
  CLIENT_TEXT_FIELDS.forEach((field) => { payload[field] = $("c_" + field)?.value ?? ""; });
  return withStateLicences(payload, state.stateLicencesDraft, state.stateLicencesLoadedFor, $("clientId").value || "");
}

async function saveClient(event) {
  event.preventDefault();
  const payload = collectClientPayload();
  if (!payload.companyName && !payload.legalBusinessName) {
    clientFormStatus("Company name (or legal business name) is required.", "error");
    return;
  }
  const licenceProblems = "stateLicenses" in payload ? stateLicencesPayload(state.stateLicencesDraft).errors : [];
  if (licenceProblems.length) {
    clientFormStatus(licenceProblems[0], "error");
    return;
  }
  try {
    const clientId = $("clientId").value;
    const saved = clientId
      ? await api(`/api/clients/${clientId}`, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/api/clients", { method: "POST", body: JSON.stringify(payload) });
    await loadClients();
    editClient(saved.id);
    clientFormStatus("Saved.", "info");
  } catch (err) {
    clientFormStatus(err.message || "Save failed.", "error");
  }
}

async function removeClient() {
  const clientId = $("clientId").value;
  if (!clientId) { blankClientForm(); return; }
  if (!confirm("Delete this client? This cannot be undone.")) return;
  try {
    await api(`/api/clients/${clientId}`, { method: "DELETE" });
    await loadClients();
    blankClientForm();
    clientFormStatus("Client deleted.", "info");
  } catch (err) {
    clientFormStatus(err.message || "Delete failed.", "error");
  }
}

async function openClientsModal() {
  $("clientsModal").hidden = false;
  await loadClients();
  if ((state.clients || []).length > 0) editClient(state.clients[0].id);
  else blankClientForm();
  if (window.lucide) window.lucide.createIcons();
}

function closeClientsModal() {
  $("clientsModal").hidden = true;
}

async function assignProjectClient() {
  if (!state.selectedProjectId) return;
  const clientId = $("projectClientSelect").value || null;
  try {
    state.detail = await api(`/api/projects/${state.selectedProjectId}/client`, {
      method: "POST",
      body: JSON.stringify({ clientId }),
    });
    renderDetail();
    showMessage(clientId ? "Client assigned to project." : "Client cleared.", "info");
  } catch (err) {
    showMessage(err.message || "Could not assign client.", "error");
  }
}

$("openClientsBtn").addEventListener("click", openClientsModal);
$("closeClientsBtn").addEventListener("click", closeClientsModal);

// Knowledge & Learning modal (KB, learning imports, portal recipes). The blocks
// kept their element IDs when moved, so the existing load/render handlers work as-is.
function openKnowledgeModal() {
  $("knowledgeModal").hidden = false;
  loadKnowledgeBase();
  loadPortalRecipes();
  if (window.lucide) window.lucide.createIcons();
}
function closeKnowledgeModal() { $("knowledgeModal").hidden = true; }
if ($("openKnowledgeBtn")) $("openKnowledgeBtn").addEventListener("click", openKnowledgeModal);
if ($("closeKnowledgeBtn")) $("closeKnowledgeBtn").addEventListener("click", closeKnowledgeModal);
if ($("knowledgeModal")) $("knowledgeModal").addEventListener("click", (e) => { if (e.target.id === "knowledgeModal") closeKnowledgeModal(); });

// Topbar "Workspace ▾" menu. The five destinations live inside a <details>, so
// the only behaviour it needs is dismissal: a bare <details> would stay hanging
// open over the board after you picked something. No ids or handlers involved —
// each button still binds itself by getElementById above.
(() => {
  const menu = document.querySelector(".topbar-more");
  if (!menu) return;
  menu.addEventListener("click", (e) => { if (e.target.closest(".topbar-more-menu")) menu.open = false; });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.open = false; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.open = false; });
})();

// Record-this-portal helper (Submit stage): rebuild the command live, copy, download .bat.
if ($("recordScope")) $("recordScope").addEventListener("change", renderRecordPortal);
if ($("recordScope")) $("recordScope").addEventListener("change", syncRecordPermitType);
if ($("recordPortalUrl")) $("recordPortalUrl").addEventListener("input", () => { const el = $("recordCmdPreview"); if (el) el.textContent = buildRecordCommand(); });
if ($("copyRecordCmdBtn")) $("copyRecordCmdBtn").addEventListener("click", copyRecordCommand);
if ($("downloadRecordBatBtn")) $("downloadRecordBatBtn").addEventListener("click", downloadRecordBat);
if ($("launchRecordBtn")) $("launchRecordBtn").addEventListener("click", launchRecordSession);
if ($("autoLearnBtn")) $("autoLearnBtn").addEventListener("click", autoLearnPortalUI);
if ($("copyDescriptionBtn")) $("copyDescriptionBtn").addEventListener("click", copyDescriptionOfWork);
if ($("buildSplitBtn")) $("buildSplitBtn").addEventListener("click", buildDocumentSplit);
if ($("autofillSpecsBtn")) $("autofillSpecsBtn").addEventListener("click", autofillSpecs);
if ($("genIntakeLinkBtn")) $("genIntakeLinkBtn").addEventListener("click", generateIntakeLink);
if ($("saveManualEntryBtn")) $("saveManualEntryBtn").addEventListener("click", saveManualEntry);
// Record manual stage open/close so a pinned-open stage (e.g. Submit) survives
// re-renders. A summary click is user-only (programmatic el.open never fires it),
// and the open state flips AFTER this handler, so the upcoming value is !el.open.
document.querySelectorAll(".stage-accordion[data-stage-index]").forEach((el) => {
  const summary = el.querySelector(".stage-summary");
  if (!summary) return;
  summary.addEventListener("click", () => {
    const pid = state.selectedProjectId || "";
    if (!state.stageOverrides[pid]) state.stageOverrides[pid] = {};
    state.stageOverrides[pid][Number(el.dataset.stageIndex)] = !el.open;
  });
});
if ($("docUploadBtn")) $("docUploadBtn").addEventListener("click", uploadProjectDocument);
$("newClientBtn").addEventListener("click", blankClientForm);
$("clientForm").addEventListener("submit", saveClient);
$("deleteClientBtn").addEventListener("click", removeClient);
if ($("addCredentialBtn")) {
  $("addCredentialBtn").addEventListener("click", async () => {
    const clientId = state.editingClientId;
    if (!clientId) { $("credStatus").textContent = "Save the client first."; return; }
    const body = {
      portalType: $("cred_portalType").value.trim(),
      portalUrl: $("cred_portalUrl").value.trim(),
      username: $("cred_username").value.trim(),
      password: $("cred_password").value,
    };
    if (!body.username || !body.password) { $("credStatus").textContent = "Username and password are required."; return; }
    try {
      await api(`/api/clients/${clientId}/portal-credentials`, { method: "POST", body: JSON.stringify(body) });
      $("cred_username").value = ""; $("cred_password").value = ""; $("cred_portalType").value = ""; $("cred_portalUrl").value = "";
      $("credStatus").textContent = "Saved (encrypted).";
      await loadClientCredentials(clientId);
    } catch (err) { $("credStatus").textContent = err.message || "Save failed."; }
  });
}
// ----- Portal logins modal (scoped to the open project's submitting client) -----
function plClient() {
  const p = state.detail?.project;
  if (!p || !p.clientId) return null;
  const client = (state.clients || []).find((c) => c.id === p.clientId);
  return { id: p.clientId, name: client?.companyName || client?.name || "this client" };
}

// Slug a portal channel/utility/ahj into a stable portal_type token for matching.
function plPortalSlug(label) {
  return String(label || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "portal";
}

// A saved login's HUMAN name. The stored portalType ("accela_oregon") is a matching key the bot
// and the chips compare on — it stays exactly as stored; only what the operator READS changes.
// Order: a known portal's name -> vendor + place from the key -> the URL's hostname -> the key
// in words. Never the raw key, never a full (often %2F-encoded) URL.
const PORTAL_TYPE_NAMES = { accela_oregon: "Oregon ePermitting (Accela)", powerclerk_pge: "PowerClerk (PGE)" };
const PORTAL_VENDOR_NAMES = { accela: "Accela", powerclerk: "PowerClerk", citizenserve: "CitizenServe", energov: "EnerGov", projectdox: "ProjectDox", opengov: "OpenGov", etrakit: "eTRAKiT", tyler: "Tyler" };
function portalHostname(url) {
  try { return url ? new URL(String(url)).hostname.replace(/^www\./i, "") : ""; } catch { return ""; }
}
function portalDisplayName(portalType, portalUrl) {
  const key = String(portalType || "").trim().toLowerCase();
  if (PORTAL_TYPE_NAMES[key]) return PORTAL_TYPE_NAMES[key];
  const [vendor, ...rest] = key.split(/[_\-\s]+/).filter(Boolean);
  if (vendor && PORTAL_VENDOR_NAMES[vendor]) {
    const place = rest.length && rest.join(" ") !== "portal" ? ` (${humanize(rest.join(" "))})` : "";
    return `${PORTAL_VENDOR_NAMES[vendor]}${place}`;
  }
  return portalHostname(portalUrl) || (key ? humanize(key) : "Portal");
}

async function openPortalLogins() {
  const client = plClient();
  const status = $("plStatus");
  if (!client) {
    showMessage("Assign a submitting client to this project first, then add its portal logins.", "warn");
    return;
  }
  $("plClientName").textContent = client.name;
  if (status) status.textContent = "";
  $("pl_portalType").value = ""; $("pl_portalUrl").value = "";
  $("pl_username").value = ""; $("pl_password").value = "";
  $("portalLoginsModal").hidden = false;
  if (window.lucide) window.lucide.createIcons();
  await renderPortalLogins();
}

async function renderPortalLogins() {
  const client = plClient();
  if (!client) return;
  let creds = [];
  try { creds = (await api(`/api/clients/${client.id}/portal-credentials`)).credentials || []; }
  catch (err) { $("plStatus").textContent = err.message || "Could not load logins."; }

  // Quick-fill chips: one per portal this project actually files to (from its tracks).
  const tracks = state.submittalTracks || [];
  const chips = [];
  const seen = new Set();
  for (const t of tracks) {
    const url = t.recipePortalUrl || "";
    const label = t.label || t.channel || t.type;
    const slug = plPortalSlug(t.channel || t.label || t.type);
    const key = (url || slug).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let host = ""; try { host = url ? new URL(url).hostname.toLowerCase() : ""; } catch { /* ignore */ }
    const matched = creds.some((c) => {
      // 1. URL hostname match (most precise).
      if (host && c.portalUrl) {
        try { if (new URL(c.portalUrl).hostname.toLowerCase() === host) return true; } catch { /* continue */ }
      }
      // 2. portalType slug match: the chip pre-fills pl_portalType with the slug, so a
      //    credential saved via this modal will have portalType === slug.
      const ct = (c.portalType || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      if (ct && ct === slug) return true;
      // 3. Loose substring: handles minor slug variants (e.g. "accela" inside "accela_oregon").
      if (ct && slug && (ct.includes(slug.slice(0, 10)) || slug.includes(ct.slice(0, 10)))) return true;
      return false;
    });
    chips.push(`<button type="button" class="pl-chip" data-pl-slug="${esc(slug)}" data-pl-url="${esc(url)}" data-has-secret="${matched ? 1 : 0}">
      <i data-lucide="${matched ? "shield-check" : "key-round"}"></i>
      <span>${esc(label)}</span>
      <span class="pl-chip-state">${matched ? "login saved" : "needs login"}</span>
    </button>`);
  }
  $("plPortalChips").innerHTML = chips.join("");
  $("plPortalChips").querySelectorAll("[data-pl-slug]").forEach((chip) => chip.addEventListener("click", () => {
    $("pl_portalType").value = chip.getAttribute("data-pl-slug");
    $("pl_portalUrl").value = chip.getAttribute("data-pl-url") || "";
    $("pl_username").focus();
  }));

  $("plList").innerHTML = creds.length
    ? creds.map((c) => `<div class="pl-cred-row">
        <div>
          <div class="pl-cred-meta"><strong>${esc(portalDisplayName(c.portalType, c.portalUrl))}</strong> · ${esc(c.usernameReference)} ${c.hasSecret ? "🔒" : ""}</div>
          ${portalHostname(c.portalUrl) && portalHostname(c.portalUrl) !== portalDisplayName(c.portalType, c.portalUrl) ? `<div class="pl-cred-url">${esc(portalHostname(c.portalUrl))}</div>` : ""}
        </div>
        <button type="button" class="danger-button danger-button-sm" data-pl-del="${esc(c.id)}">Delete</button>
      </div>`).join("")
    : '<p class="muted" style="font-size:12px">No saved logins yet. Pick a portal above to pre-fill, then enter the username and password.</p>';
  $("plList").querySelectorAll("[data-pl-del]").forEach((b) => b.addEventListener("click", async () => {
    try {
      if (!window.confirm("Permanently delete this stored portal login?\n\nIt cannot be recovered — you would re-enter the credentials to restore it.")) return;
      await api(`/api/clients/${client.id}/portal-credentials/${b.getAttribute("data-pl-del")}`, { method: "DELETE" }); await renderPortalLogins(); }
    catch (err) { $("plStatus").textContent = err.message || "Delete failed."; }
  }));

  // Header summary: X of Y portals have a saved login.
  const summary = $("portalLoginsSummary");
  if (summary) {
    const total = chips.length;
    const ready = $("plPortalChips").querySelectorAll('[data-has-secret="1"]').length;
    summary.textContent = total ? `${ready}/${total} portal logins saved` : (creds.length ? `${creds.length} saved` : "");
  }
  if (window.lucide) window.lucide.createIcons();
}

if ($("managePortalLoginsBtn")) $("managePortalLoginsBtn").addEventListener("click", openPortalLogins);
if ($("closePortalLoginsBtn")) $("closePortalLoginsBtn").addEventListener("click", () => { $("portalLoginsModal").hidden = true; });
// Backdrop click closes it, like every other modal (Esc is wired in installKeyboardShortcuts).
if ($("portalLoginsModal")) $("portalLoginsModal").addEventListener("click", (e) => { if (e.target.id === "portalLoginsModal") $("portalLoginsModal").hidden = true; });
if ($("plSaveBtn")) $("plSaveBtn").addEventListener("click", async () => {
  const client = plClient();
  if (!client) { $("plStatus").textContent = "No submitting client assigned."; return; }
  const body = {
    portalType: $("pl_portalType").value.trim(),
    portalUrl: $("pl_portalUrl").value.trim(),
    username: $("pl_username").value.trim(),
    password: $("pl_password").value,
  };
  if (!body.username || !body.password) { $("plStatus").textContent = "Username and password are required."; return; }
  if (!body.portalUrl) { $("plStatus").textContent = "Portal URL is required so the bot matches this login to the right portal."; return; }
  try {
    await api(`/api/clients/${client.id}/portal-credentials`, { method: "POST", body: JSON.stringify(body) });
    $("pl_username").value = ""; $("pl_password").value = "";
    $("plStatus").textContent = "Saved (encrypted).";
    await renderPortalLogins();
  } catch (err) { $("plStatus").textContent = err.message || "Save failed."; }
});

$("addStateLicenceBtn")?.addEventListener("click", () => {
  state.stateLicencesDraft = state.stateLicencesDraft || [];
  state.stateLicencesDraft.push({ state: "", kind: "", number: "", expires: "", holder: "" });
  renderStateLicences();
});
$("addPortalIdentityBtn").addEventListener("click", () => {
  state.portalIdentitiesDraft = state.portalIdentitiesDraft || [];
  state.portalIdentitiesDraft.push({ portalType: "powerclerk_pge", installerCompanyLabel: "", installerContactCode: "", notes: "" });
  renderPortalIdentities();
});
$("projectClientSelect").addEventListener("change", assignProjectClient);
$("clientsModal").addEventListener("click", (e) => { if (e.target.id === "clientsModal") closeClientsModal(); });

// ----- Leads / Customers + communication log -----
const CUSTOMER_TEXT_FIELDS = ["name", "email", "phone", "leadSource", "address", "city", "state", "zip", "notes"];
const COMM_CHANNEL_LABELS = { note: "Note", call: "Call", email: "Email", sms: "Text", meeting: "Meeting" };

async function loadCustomers() {
  const params = new URLSearchParams();
  const search = $("customerSearch").value.trim();
  const stage = $("customerStageFilter").value;
  if (search) params.set("search", search);
  if (stage) params.set("stage", stage);
  const qs = params.toString();
  state.customers = await api(`/api/customers${qs ? "?" + qs : ""}`);
  renderCustomersList();
}

function renderCustomersList() {
  const list = $("customersList");
  if (!state.customers || state.customers.length === 0) {
    list.innerHTML = `<p class="muted">No contacts. Click New to add a lead.</p>`;
    return;
  }
  list.innerHTML = state.customers.map((c) => `
    <button type="button" class="client-row${c.id === state.editingCustomerId ? " active" : ""}" data-customer-id="${esc(c.id)}">
      <strong>${esc(c.name || "Unnamed")}</strong>
      <span class="muted">${esc(STAGE_LABELS[c.leadStage] || c.leadStage)}${c.phone ? " · " + esc(c.phone) : ""}</span>
    </button>
  `).join("");
  list.querySelectorAll("[data-customer-id]").forEach((btn) => {
    btn.addEventListener("click", () => editCustomer(btn.dataset.customerId));
  });
}

const STAGE_LABELS = { new_lead: "New lead", contacted: "Contacted", quoted: "Quoted", won: "Won", customer: "Customer", lost: "Lost" };

function customerFormStatus(text, kind) {
  const el = $("customerFormStatus");
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "message" + (kind ? " " + kind : "");
}

function blankCustomerForm() {
  state.editingCustomerId = null;
  $("cu_id").value = "";
  CUSTOMER_TEXT_FIELDS.forEach((f) => { const el = $("cu_" + f); if (el) el.value = ""; });
  $("cu_leadStage").value = "new_lead";
  $("commLogAddRow").hidden = true;
  if ($("deleteCustomerBtn")) $("deleteCustomerBtn").hidden = true; // nothing saved to delete yet
  $("commLogList").innerHTML = `<p class="muted">Save the contact first to start logging communication.</p>`;
  customerFormStatus("");
  renderCustomersList();
}

async function editCustomer(id) {
  const c = (state.customers || []).find((x) => x.id === id);
  if (!c) return;
  state.editingCustomerId = id;
  $("cu_id").value = id;
  CUSTOMER_TEXT_FIELDS.forEach((f) => { const el = $("cu_" + f); if (el) el.value = c[f] || ""; });
  $("cu_leadStage").value = c.leadStage || "new_lead";
  $("commLogAddRow").hidden = false;
  if ($("deleteCustomerBtn")) $("deleteCustomerBtn").hidden = false;
  customerFormStatus("");
  renderCustomersList();
  await loadCommunications(id);
}

function collectCustomerPayload() {
  const payload = { leadStage: $("cu_leadStage").value };
  CUSTOMER_TEXT_FIELDS.forEach((f) => { payload[f] = $("cu_" + f)?.value ?? ""; });
  return payload;
}

async function saveCustomer(event) {
  event.preventDefault();
  const payload = collectCustomerPayload();
  if (!payload.name.trim()) { customerFormStatus("Name is required.", "error"); return; }
  try {
    const id = $("cu_id").value;
    const saved = id
      ? await api(`/api/customers/${id}`, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/api/customers", { method: "POST", body: JSON.stringify(payload) });
    await loadCustomers();
    editCustomer(saved.id);
    customerFormStatus("Saved.", "info");
  } catch (err) {
    customerFormStatus(err.message || "Save failed.", "error");
  }
}

async function removeCustomer() {
  const id = $("cu_id").value;
  if (!id) { blankCustomerForm(); return; }
  if (!confirm("Delete this contact? Communication history will be unlinked.")) return;
  try {
    await api(`/api/customers/${id}`, { method: "DELETE" });
    await loadCustomers();
    blankCustomerForm();
    customerFormStatus("Contact deleted.", "info");
  } catch (err) {
    customerFormStatus(err.message || "Delete failed.", "error");
  }
}

async function loadCommunications(customerId) {
  const comms = await api(`/api/customers/${customerId}/communications`);
  const list = $("commLogList");
  if (!comms || comms.length === 0) {
    list.innerHTML = `<p class="muted">No communication logged yet.</p>`;
    return;
  }
  list.innerHTML = comms.map((m) => `
    <div class="comm-entry">
      <div class="comm-meta">
        <strong>${esc(COMM_CHANNEL_LABELS[m.channel] || m.channel)}</strong>
        <span class="muted">${esc(m.direction)} · ${esc(fmtDate(m.occurredAt))}</span>
      </div>
      ${m.subject ? `<div class="comm-subject">${esc(m.subject)}</div>` : ""}
      ${m.body ? `<div class="comm-body">${esc(m.body)}</div>` : ""}
    </div>
  `).join("");
}

async function addCommunication() {
  const customerId = $("cu_id").value;
  if (!customerId) { customerFormStatus("Save the contact first.", "error"); return; }
  const body = $("comm_body").value.trim();
  const subject = $("comm_subject").value.trim();
  if (!subject && !body) { customerFormStatus("Add a subject or details to log.", "error"); return; }
  try {
    await api("/api/communications", {
      method: "POST",
      body: JSON.stringify({
        customerId,
        channel: $("comm_channel").value,
        direction: $("comm_direction").value,
        subject,
        body,
      }),
    });
    $("comm_subject").value = "";
    $("comm_body").value = "";
    await loadCommunications(customerId);
    customerFormStatus("Logged.", "info");
  } catch (err) {
    customerFormStatus(err.message || "Could not log entry.", "error");
  }
}

async function openCustomersModal() {
  $("customersModal").hidden = false;
  await loadCustomers();
  if ((state.customers || []).length > 0) editCustomer(state.customers[0].id);
  else blankCustomerForm();
  if (window.lucide) window.lucide.createIcons();
}

function closeCustomersModal() { $("customersModal").hidden = true; }

let _customerSearchTimer = null;
$("openCustomersBtn").addEventListener("click", openCustomersModal);
$("closeCustomersBtn").addEventListener("click", closeCustomersModal);
$("newCustomerBtn").addEventListener("click", blankCustomerForm);
$("customerForm").addEventListener("submit", saveCustomer);
$("deleteCustomerBtn").addEventListener("click", removeCustomer);
$("addCommBtn").addEventListener("click", addCommunication);
$("customerStageFilter").addEventListener("change", loadCustomers);
$("customerSearch").addEventListener("input", () => {
  clearTimeout(_customerSearchTimer);
  _customerSearchTimer = setTimeout(loadCustomers, 250);
});
$("customersModal").addEventListener("click", (e) => { if (e.target.id === "customersModal") closeCustomersModal(); });

// ----- Project search / sort / filter (server-side, paginated) -----
const PROJECT_PAGE_SIZE = 200;
const projectFilterState = { search: "", status: "", userId: "", clientId: "", sort: "updated_desc", offset: 0 };

// applyProjectFilters kept as a no-op alias — filtering now happens on the server
function applyProjectFilters(projects) { return projects; }

let _searchDebounceTimer = null;

async function reloadProjects() {
  projectFilterState.offset = 0;
  await fetchProjectPage(false);
}

async function loadMoreProjects() {
  projectFilterState.offset = state.projects.length;
  await fetchProjectPage(true);
}

// Paint a board skeleton so a (re)fetch doesn't flash an empty column grid.
function showBoardSkeleton() {
  const el = $("projectBoard");
  if (!el || el.hidden) return;
  const cols = Array.from({ length: PROJECT_STAGES.length }, () =>
    `<div class="board-skeleton-col">${Array.from({ length: 3 }, () => `<div class="skeleton board-skeleton-card"></div>`).join("")}</div>`
  ).join("");
  el.classList.add("board-skeleton");
  // The skeleton keeps its own equal columns; the per-stage widths are set by renderBoard.
  if (el.style && el.style.removeProperty) el.style.removeProperty("--board-cols");
  el.innerHTML = cols;
}

async function fetchProjectPage(append) {
  if (!append) showBoardSkeleton();
  const params = new URLSearchParams({ limit: String(PROJECT_PAGE_SIZE), offset: String(projectFilterState.offset) });
  if ($("showArchivedProjects")?.checked) params.set("includeArchived", "true");
  if (projectFilterState.search) params.set("search", projectFilterState.search);
  if (projectFilterState.status) params.set("status", projectFilterState.status);
  if (projectFilterState.userId) params.set("userId", projectFilterState.userId);
  if (projectFilterState.clientId) params.set("clientId", projectFilterState.clientId);
  if (projectFilterState.sort && projectFilterState.sort !== "overdue") params.set("sort", projectFilterState.sort);
  // THE "NEEDS ME" PILLS COUNT THE WHOLE BOARD. The page above is filtered (search / status /
  // assignee / company) and paged, so when either applies the board is fetched once more,
  // unfiltered, for the counts. Unfiltered and complete, the page IS the whole board. If the
  // extra fetch fails the pills fall back to the page and say so (renderNeedsMePills).
  const filtered = Boolean(projectFilterState.search || projectFilterState.status || projectFilterState.userId || projectFilterState.clientId);
  const data = await api(`/api/projects?${params}`);
  const page = data.projects || [];
  state.projectsTotal = data.total ?? page.length;
  if (append) {
    state.projects = [...state.projects, ...page];
  } else {
    state.projects = page;
  }
  if (!filtered && state.projects.length >= (state.projectsTotal ?? 0)) {
    state.boardAll = state.projects;
  } else {
    const wholeParams = new URLSearchParams({ limit: "500", offset: "0" });
    if ($("showArchivedProjects")?.checked) wholeParams.set("includeArchived", "true");
    const whole = await api(`/api/projects?${wholeParams}`).catch(() => null);
    // Only a COMPLETE board counts as the whole board (the list route caps at 500 rows).
    state.boardAll = whole && Array.isArray(whole.projects) && (whole.total ?? whole.projects.length) <= whole.projects.length ? whole.projects : null;
  }
  renderProjects();
}

// Populate the company filter (project list) from the loaded clients, used by the
// team dashboard to scope the board/table to one contractor/company.
function renderProjectClientFilterOptions() {
  const sel = $("projectClientFilter");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">All companies</option>` +
    (state.clients || []).map((c) => `<option value="${esc(c.id)}">${esc(c.companyName || c.legalBusinessName || "Unnamed")}</option>`).join("");
  sel.value = current;
}

function renderProjectUserOptions() {
  const filterSel = $("projectUserFilter");
  const current = filterSel.value;
  filterSel.innerHTML = `<option value="">All assignees</option>` +
    (state.users || []).map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join("");
  filterSel.value = current;

  const assignSel = $("projectAssignSelect");
  if (assignSel) {
    const cur2 = assignSel.value;
    assignSel.innerHTML = `<option value="">— unassigned —</option>` +
      (state.users || []).map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join("");
    assignSel.value = cur2;
  }
}

async function assignProjectUser() {
  if (!state.selectedProjectId) return;
  const userId = $("projectAssignSelect").value || null;
  try {
    await api(`/api/projects/${state.selectedProjectId}/assign`, { method: "POST", body: JSON.stringify({ userId }) });
    await loadProjects();
    await loadTeamWorkload();
    updateHeadMetaSummary();
    showMessage(userId ? "Project assigned." : "Assignment cleared.", "info");
  } catch (err) {
    showMessage(err.message || "Could not assign project.", "error");
  }
}

if ($("projectAssignSelect")) $("projectAssignSelect").addEventListener("change", assignProjectUser);

$("projectSearch").addEventListener("input", (e) => {
  projectFilterState.search = e.target.value;
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(reloadProjects, 300);
});
let _kbSearchTimer = null;
if ($("kbSearch")) {
  $("kbSearch").addEventListener("input", (e) => {
    state.kbSearch = e.target.value;
    state.kbRenderLimit = KB_PAGE_SIZE;
    clearTimeout(_kbSearchTimer);
    _kbSearchTimer = setTimeout(renderKnowledgeBase, 200);
  });
}

// Easy "add a new AHJ" workflow — research it with the LLM and save to the KB.
if ($("addAhjBtn")) {
  $("addAhjBtn").addEventListener("click", async () => {
    const ahj = $("addAhjName").value.trim();
    const stateVal = $("addAhjState").value.trim();
    const utility = $("addAhjUtility").value.trim();
    const statusEl = $("addAhjStatus");
    if (!ahj) { statusEl.textContent = "Enter an AHJ name."; return; }
    $("addAhjBtn").disabled = true;
    statusEl.textContent = `Researching ${ahj}…`;
    try {
      const r = await api("/api/knowledge-base/research-ahj", { method: "POST", body: JSON.stringify({ ahj, state: stateVal, utility }) });
      if (r.saved) {
        const plat = r.research.portalPlatform ? ` — runs on ${r.research.portalPlatform} (reuse existing ${r.research.portalPlatform} automation)` : "";
        statusEl.textContent = `✓ Added ${ahj}: ${r.research.requiredDocuments.length} required doc(s), portal "${r.research.portalName}"${plat}. Confidence ${r.research.confidence} — verify before relying on it.`;
        $("addAhjName").value = ""; $("addAhjUtility").value = "";
        await loadKnowledgeBase();
      } else if (r.research?.provider === "stub") {
        statusEl.textContent = "AI is off — set ANTHROPIC_API_KEY on the server to research AHJs.";
      } else {
        statusEl.textContent = "No requirements returned — try a more specific AHJ name/state.";
      }
    } catch (err) {
      statusEl.textContent = err.message || "Research failed.";
    } finally {
      $("addAhjBtn").disabled = false;
    }
  });
}

if ($("addUtilityBtn")) {
  $("addUtilityBtn").addEventListener("click", async () => {
    const utility = $("addUtilityName").value.trim();
    const stateVal = $("addUtilityState").value.trim();
    const statusEl = $("addUtilityStatus");
    if (!utility) { statusEl.textContent = "Enter a utility name."; return; }
    $("addUtilityBtn").disabled = true;
    statusEl.textContent = `Researching ${utility}…`;
    try {
      const r = await api("/api/knowledge-base/research-utility", { method: "POST", body: JSON.stringify({ utility, state: stateVal }) });
      if (r.saved) {
        const plat = r.research.portalPlatform ? ` — NEM portal "${r.research.portalName}" on ${r.research.portalPlatform} (reuse existing ${r.research.portalPlatform} automation)` : (r.research.portalName ? ` — NEM portal "${r.research.portalName}"` : "");
        const sis = r.research.smartInverterSettings ? ` Smart inverter settings: ${r.research.smartInverterSettings}` : "";
        statusEl.textContent = `✓ Added ${utility}: ${r.research.requiredDocuments.length} required doc(s)${plat}. Confidence ${r.research.confidence} — verify before relying on it.${sis}`;
        $("addUtilityName").value = "";
        await loadKnowledgeBase();
      } else if (r.research?.provider === "stub") {
        statusEl.textContent = "AI is off — set ANTHROPIC_API_KEY on the server to research utilities.";
      } else {
        statusEl.textContent = "No requirements returned — try a more specific utility name/state.";
      }
    } catch (err) {
      statusEl.textContent = err.message || "Research failed.";
    } finally {
      $("addUtilityBtn").disabled = false;
    }
  });
}
if ($("addFormFile")) $("addFormFile").addEventListener("change", uploadAhjFormFromManager);
if ($("refreshFormsBtn")) $("refreshFormsBtn").addEventListener("click", refreshAhjFormLinks);
if ($("addSigFile")) $("addSigFile").addEventListener("change", uploadSignature);
if ($("addSigRole")) $("addSigRole").addEventListener("change", () => { syncSignatureCompanyPicker(); });
$("projectStatusFilter").addEventListener("change", (e) => {
  projectFilterState.status = e.target.value;
  reloadProjects();
});
$("projectClientFilter").addEventListener("change", (e) => {
  projectFilterState.clientId = e.target.value;
  reloadProjects();
});
$("projectUserFilter").addEventListener("change", (e) => {
  projectFilterState.userId = e.target.value;
  reloadProjects();
});
$("projectSort").addEventListener("change", (e) => {
  projectFilterState.sort = e.target.value;
  reloadProjects();
});
document.querySelectorAll(".page-tab").forEach((tab) => {
  tab.addEventListener("click", () => navigate(`#/${tab.dataset.page}`));
});
$("backToListBtn")?.addEventListener("click", () => navigate("#/dashboard"));
window.addEventListener("hashchange", routeFromHash);

// ----- Batch folder import -----
async function startBatchScan() {
  const folderPath = $("batchFolderPath").value.trim();
  if (!folderPath) { showMessage("Enter a folder path first.", "error"); return; }
  const btn = $("startBatchScanBtn");
  btn.disabled = true;
  $("batchScanStatus").textContent = "Queuing scan job…";
  $("batchScanResults").hidden = true;
  try {
    const job = await api("/api/batch-import/scan", {
      method: "POST",
      body: JSON.stringify({
        folderPath,
        defaultAhj: $("batchDefaultAhj").value.trim() || undefined,
        defaultUtility: $("batchDefaultUtility").value.trim() || undefined,
        defaultState: $("batchDefaultState").value.trim() || undefined,
        useLlm: $("batchUseLlm").checked,
      }),
    });
    $("batchScanStatus").textContent = `Job ${job.id.slice(0, 8)} queued (status: ${job.status}). Polling for result…`;
    pollBatchJob(job.id);
  } catch (err) {
    $("batchScanStatus").textContent = `Error: ${err.message}`;
    btn.disabled = false;
  }
}

async function pollBatchJob(jobId) {
  const btn = $("startBatchScanBtn");
  const tick = async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      const pct = job.progressTotal > 0 ? Math.round((job.progress / job.progressTotal) * 100) : 0;
      if (job.status === "running" || job.status === "pending") {
        $("batchScanStatus").textContent = `Scanning… ${job.progress}/${job.progressTotal} files (${pct}%)`;
        setTimeout(tick, 2000);
      } else if (job.status === "done") {
        const r = job.result || {};
        $("batchScanStatus").textContent =
          `Done — ${r.scanned} PDFs scanned, ${r.learned} trained the parser, ${r.lowSignal} low-signal, ${r.errors} errors. ` +
          `${r.profilesTouched || 0} AHJ/utility profile(s) updated, ${r.correctionsLearned || 0} correction pattern(s) added.` +
          (r.reportPath ? ` Full report: ${r.reportPath}` : "");
        renderBatchResults(job);
        await loadKnowledgeBase();
        btn.disabled = false;
      } else {
        $("batchScanStatus").textContent = `Job ${job.status}: ${job.error || "unknown error"}`;
        btn.disabled = false;
      }
    } catch (err) {
      $("batchScanStatus").textContent = `Poll error: ${err.message}`;
      btn.disabled = false;
    }
  };
  setTimeout(tick, 1500);
}

function renderBatchResults(job) {
  const wrap = $("batchScanResults");
  const results = (job.result?.results || []);
  if (!results.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  wrap.innerHTML = `<div class="table-wrap"><table class="batch-results-table">
    <thead><tr><th>File</th><th>Type</th><th>Status</th><th>Details</th></tr></thead>
    <tbody>${results.map((r) => `
      <tr class="${r.status}">
        <td>${esc(r.filePath.split(/[\\/]/).pop())}</td>
        <td>${esc(r.docType.replace("_", " "))}</td>
        <td>${r.status === "learned" ? "✓ learned" : r.status === "error" ? "✗ error" : "— low signal"}</td>
        <td>${esc(r.message)}${r.docLabel ? ` · <strong>${esc(String(r.docLabel))}</strong>` : ""}</td>
      </tr>`).join("")}
    </tbody></table></div>`;
}

if ($("startBatchScanBtn")) $("startBatchScanBtn").addEventListener("click", startBatchScan);

// ----- NEM monitor button -----
async function runNemMonitor() {
  $("runNemMonitorBtn").disabled = true;
  try {
    const result = await api("/api/nem-monitor/run", { method: "POST" });
    showMessage(`NEM check: ${result.checked} target(s) checked.`, "info");
    await loadProjects();
  } catch (err) {
    showMessage(err.message || "NEM check failed.", "error");
  } finally {
    $("runNemMonitorBtn").disabled = false;
  }
}
$("runNemMonitorBtn").addEventListener("click", runNemMonitor);

// ----- Team workload -----
async function loadTeamWorkload() {
  $("workloadStatus").textContent = "syncing";
  try {
    const workload = await api("/api/users/workload");
    renderTeamWorkload(workload);
    $("workloadStatus").textContent = "live";
  } catch {
    $("workloadStatus").textContent = "error";
  }
}

function renderTeamWorkload(workload) {
  if (!workload || workload.length === 0) {
    $("teamWorkload").innerHTML = `<div class="team-empty"><p class="muted">No team members yet. Add the people who work these projects to see their open work here.</p>
      <button type="button" class="secondary" id="teamEmptyAddBtn"><i data-lucide="user-plus"></i><span>Add a team member</span></button></div>`;
    $("teamEmptyAddBtn").addEventListener("click", () => { openUsersModal().then(() => blankUserForm()); });
    if (window.lucide) window.lucide.createIcons();
    return;
  }
  $("teamWorkload").innerHTML = workload.map((w) => {
    const color = (state.users || []).find((u) => u.id === w.user.id)?.color || "#6366f1";
    return `
      <article class="item ${w.overdueCorrections > 0 ? "fail" : "info"}" style="border-left-color:${esc(color)}">
        <div class="item-title">
          <span>${esc(w.user.name)}</span>
          <span class="muted">${esc(w.user.role)}</span>
        </div>
        <div class="workload-stats">
          <span><strong>${w.openProjects}</strong> open</span>
          <span><strong>${w.openCorrections}</strong> corrections</span>
          ${w.overdueCorrections > 0 ? `<span class="badge badge-fail">${w.overdueCorrections} overdue</span>` : ""}
          <span><strong>${w.pendingReviews}</strong> pending review</span>
        </div>
      </article>`;
  }).join("");
}

// ----- Users modal -----
async function loadUsers() {
  const users = await api("/api/users");
  state.users = Array.isArray(users) ? users : [];
  renderUsersList();
  renderProjectUserOptions();
}

function renderUsersList() {
  const list = $("usersList");
  if (!list) return;
  if (!state.users || state.users.length === 0) {
    list.innerHTML = `<p class="muted">No team members yet.</p>`;
    return;
  }
  list.innerHTML = state.users.map((u) => `
    <div class="client-list-item ${state.selectedUserId === u.id ? "active" : ""}" data-user-id="${esc(u.id)}">
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${esc(u.color)};margin-right:6px"></span>
      ${esc(u.name)}
      <span class="muted" style="font-size:12px">${esc(u.role)}</span>
    </div>`).join("");
  list.querySelectorAll("[data-user-id]").forEach((el) => {
    el.addEventListener("click", () => editUser(el.dataset.userId));
  });
}

function editUser(userId) {
  state.selectedUserId = userId;
  userFormStatus("");
  const user = (state.users || []).find((u) => u.id === userId);
  if (!user) return;
  $("userId").value = user.id;
  $("u_name").value = user.name;
  $("u_email").value = user.email;
  syncUserRoleChoice(false);
  $("u_role").value = user.role;
  $("u_color").value = user.color;
  renderUsersList();
}

// A NEW member is always created as an Operator (users.ts createUser — creation is not an
// elevation path). Offering "Admin" on the Add form saved an Operator and still said "Saved.",
// so the choice is shut on a new member and opens once they exist (promotion is an edit).
function syncUserRoleChoice(isNew) {
  const admin = $("u_role")?.querySelector('option[value="admin"]');
  if (admin) admin.disabled = !!isNew;
  if (isNew && $("u_role")) $("u_role").value = "operator";
  if ($("u_roleHint")) $("u_roleHint").hidden = !isNew;
}

function blankUserForm() {
  state.selectedUserId = null;
  userFormStatus("");
  $("userId").value = "";
  $("u_name").value = "";
  $("u_email").value = "";
  syncUserRoleChoice(true);
  $("u_color").value = "#6366f1";
  renderUsersList();
}

// The Team modal is opened from the dashboard, where #message (inside the project view) is
// hidden — so its outcome is written into the form's own status line.
function userFormStatus(text, kind) {
  const el = $("userFormStatus");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "message" + (kind ? " " + kind : "");
}

async function saveUser(event) {
  event.preventDefault();
  const payload = {
    name: $("u_name").value.trim(),
    email: $("u_email").value.trim(),
    role: $("u_role").value,
    color: $("u_color").value,
  };
  if (!payload.name || !payload.email) { userFormStatus("Name and email are required.", "warning"); return; }
  try {
    const userId = $("userId").value;
    if (userId) {
      await api(`/api/users/${userId}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      const created = await api("/api/users", { method: "POST", body: JSON.stringify(payload) });
      await loadUsers();
      // Keep the new member selected so a second Save edits them instead of adding a duplicate.
      if (created?.id) editUser(created.id);
      userFormStatus("Added as an Operator. Change the role here to promote them.", "info");
      return;
    }
    await loadUsers();
    userFormStatus("Saved.", "info");
  } catch (err) {
    userFormStatus(err.message || "Save failed.", "error");
  }
}

async function openUsersModal() {
  $("usersModal").hidden = false;
  await loadUsers();
  if ((state.users || []).length > 0) editUser(state.users[0].id);
  else blankUserForm();
  if (window.lucide) window.lucide.createIcons();
}

function closeUsersModal() { $("usersModal").hidden = true; }

$("openUsersBtn").addEventListener("click", openUsersModal);
$("closeUsersBtn").addEventListener("click", closeUsersModal);
$("newUserBtn").addEventListener("click", blankUserForm);
$("userForm").addEventListener("submit", saveUser);
$("usersModal").addEventListener("click", (e) => { if (e.target.id === "usersModal") closeUsersModal(); });

// ----- KPI Dashboard -----
function formatDays(days) {
  if (days == null) return "—";
  return `${days}d`;
}

async function loadKpi() {
  const start = $("kpiStart").value || "";
  const end = $("kpiEnd").value || "";
  const params = new URLSearchParams();
  if (start) params.set("startDate", start);
  if (end) params.set("endDate", end);
  try {
    const kpi = await api(`/api/kpi?${params}`);
    renderKpi(kpi);
  } catch (err) {
    $("kpiBody").innerHTML = `<p class="muted">Failed to load KPIs: ${esc(err.message)}</p>`;
  }
}


// HOW WELL THE ROBOT FILLED, not just how fast the business moved.
//
// Every other KPI on this page is a business outcome: cycle days, corrections, SLA. None of
// them notice a filing staged with three required boxes empty, because a person quietly
// filled them in and the permit still landed on time. That cost is real and it was invisible
// — the operator found PacifiCorp's missing meter photo by looking at the live portal, not
// from anything the run reported.
//
// Computed from portal_runs.result_json, which has always carried the whole run report, so
// these numbers cover runs that already happened rather than starting from today.
function renderStagingQuality(q) {
  if (!q || !q.runs) return "";
  const unmeasured = q.runs - q.measured;
  const gaps = (q.topGaps || []).slice(0, 6);
  const drift = (q.driftingPortals || []).slice(0, 4);
  return `
    <h3 style="margin-top:24px">Automation quality <span class="muted" style="font-weight:400">— how the filings were staged</span></h3>
    <div class="kpi-grid">
      <div class="kpi-card ${q.cleanRate < 60 ? "kpi-warn" : ""}">
        <div class="kpi-value">${q.cleanRate}%</div>
        <div class="kpi-label">Staged clean</div>
      </div>
      <div class="kpi-card ${q.verifiedRate < 50 ? "kpi-warn" : ""}">
        <div class="kpi-value">${q.verifiedRate}%</div>
        <div class="kpi-label">Verified against the portal's review screen</div>
      </div>
      <div class="kpi-card ${q.neededHuman > 0 ? "kpi-warn" : ""}">
        <div class="kpi-value">${q.neededHuman}</div>
        <div class="kpi-label">Runs that left work for a person</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">${q.avgBlanksPerRun} <span class="muted" style="font-size:0.6em">of ${q.avgRequiredPerRun ?? 0}</span></div>
        <div class="kpi-label">Avg required fields left blank, out of what the portal asked for</div>
      </div>
    </div>
    <p class="muted" style="margin-top:6px">
      ${q.measured} of ${q.runs} staging run(s) carried a report this can read${unmeasured > 0
        ? ` — ${unmeasured} did not and are excluded rather than counted as clean`
        : ""}.
    </p>
    ${q.blindClean > 0 ? `
      <p class="kpi-warn" style="margin-top:6px;padding:8px;border-radius:4px">
        ${q.blindClean} clean run(s) never saw a single required field. That is not a failure and
        not a success — it is a score nothing can falsify, and it reads the same whether the
        filing was complete or the check never reached the page. Treat the clean rate above as
        covering ${q.clean - q.blindClean} run(s) until these are looked at.
      </p>` : ""}
    ${gaps.length ? `
      <h4 style="margin-top:16px">Most frequently left blank</h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Field</th><th>Runs</th></tr></thead>
          <tbody>
            ${gaps.map((g) => `<tr><td>${esc(g.field)}</td><td>${g.runs}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>` : ""}
    ${drift.length ? `
      <h4 style="margin-top:16px">Portals whose recipes are drifting</h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Portal</th><th>Runs with drift</th></tr></thead>
          <tbody>
            ${drift.map((d) => `<tr><td>${esc(d.portal)}</td><td>${d.runs}</td></tr>`).join("")}
          </tbody>
        </table>
      </div>` : ""}
  `;
}

function renderKpi(kpi) {
  const body = $("kpiBody");
  body.innerHTML = `
    <div class="kpi-period">Period: ${esc(kpi.period.start)} → ${esc(kpi.period.end)}</div>
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-value">${kpi.projectsSubmitted}</div>
        <div class="kpi-label">Submitted</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">${kpi.projectsHandedOff}</div>
        <div class="kpi-label">Handed Off ✓</div>
      </div>
      <div class="kpi-card ${kpi.avgTotalCycleDays != null && kpi.avgTotalCycleDays > 60 ? "kpi-warn" : ""}">
        <div class="kpi-value">${formatDays(kpi.avgTotalCycleDays)}</div>
        <div class="kpi-label">Avg Cycle (Submit→Handoff)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">${formatDays(kpi.avgPermitCycleDays)}</div>
        <div class="kpi-label">Avg Permit Cycle</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">${formatDays(kpi.avgNemCycleDays)}</div>
        <div class="kpi-label">Avg NEM Cycle</div>
      </div>
      <div class="kpi-card ${kpi.throughputPerWeek < 1 ? "kpi-warn" : ""}">
        <div class="kpi-value">${kpi.throughputPerWeek ?? "—"}</div>
        <div class="kpi-label">Handoffs/Week</div>
      </div>
      <div class="kpi-card ${kpi.correctionRate > 50 ? "kpi-warn" : ""}">
        <div class="kpi-value">${kpi.correctionRate == null ? "—" : `${kpi.correctionRate}%`}</div>
        <div class="kpi-label">Correction Rate</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">${kpi.avgCorrectionsPerProject ?? "—"}</div>
        <div class="kpi-label">Avg Corrections/Project</div>
      </div>
      <div class="kpi-card ${kpi.overdueCorrections > 0 ? "kpi-fail" : ""}">
        <div class="kpi-value">${kpi.overdueCorrections}</div>
        <div class="kpi-label">Overdue Corrections</div>
      </div>
      <div class="kpi-card ${kpi.slaBreachRate > 20 ? "kpi-warn" : ""}">
        <div class="kpi-value">${kpi.slaBreachRate}%</div>
        <div class="kpi-label">SLA Breach Rate</div>
      </div>
    </div>

    ${renderStagingQuality(kpi.stagingQuality)}

    ${kpi.byUser.length > 0 ? `
    <h3 style="margin-top:24px">Per Operator</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Submitted</th><th>Handed Off</th><th>Open</th><th>Overdue</th><th>Avg Cycle</th></tr></thead>
        <tbody>
          ${kpi.byUser.map((u) => `
            <tr>
              <td>${esc(u.userName)}</td>
              <td>${u.submitted}</td>
              <td>${u.handedOff}</td>
              <td>${u.openProjects}</td>
              <td class="${u.overdueCorrections > 0 ? "text-danger" : ""}">${u.overdueCorrections}</td>
              <td>${formatDays(u.avgCycleDays)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>` : ""}
  `;
}

async function openKpiModal() {
  $("kpiModal").hidden = false;
  // Default: last 90 days
  if (!$("kpiEnd").value) $("kpiEnd").value = new Date().toISOString().slice(0, 10);
  if (!$("kpiStart").value) {
    const d = new Date(); d.setDate(d.getDate() - 90);
    $("kpiStart").value = d.toISOString().slice(0, 10);
  }
  await loadKpi();
}

function closeKpiModal() { $("kpiModal").hidden = true; }

$("openKpiBtn").addEventListener("click", openKpiModal);
$("closeKpiBtn").addEventListener("click", closeKpiModal);
$("refreshKpiBtn").addEventListener("click", loadKpi);
$("kpiModal").addEventListener("click", (e) => { if (e.target.id === "kpiModal") closeKpiModal(); });

// Show the right LIST page before anything loads, so the first paint is already the page the
// hash names (the board used to paint over a still-visible Projects table for ~2s). A
// #/project/<id> deep link waits for routeFromHash below, which loads that project.
{
  const bootPage = (window.location.hash || "").replace(/^#\/?/, "").split("/")[0];
  if (bootPage !== "project") showPage(VALID_PAGES.includes(bootPage) ? bootPage : "dashboard", { skipLoad: true });
}
await checkHealth();
// Independent loads, in parallel: the board no longer waits on clients and users in series.
await Promise.all([loadProjects(), loadClients(), loadUsers()]);
// Users arrive in parallel with the board, so repaint once for the assignee dots.
renderProjects();
// Render the page indicated by the URL hash (defaults to Dashboard). Deep links
// like #/project/<id> load that project's workflow page directly.
routeFromHash();
// Team workload feeds only the Team page; it no longer holds up the first render.
loadTeamWorkload().catch(() => { /* loadTeamWorkload reports its own error state */ });

// The "How it flows" legend is a topbar popover now: close it on an outside click or Escape.
{
  const guide = $("startHereGuide");
  if (guide && typeof guide.contains === "function") {
    document.addEventListener("click", (e) => { if (guide.open && !guide.contains(e.target)) guide.open = false; });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && guide.open) guide.open = false; });
  }
}
if (window.lucide) window.lucide.createIcons();

// --- SSE notifications -------------------------------------------------------
// Subscribes to /api/events and routes typed events to toasts + the nav badge.
// Reconnects automatically if the connection drops (e.g. server restart).

let notifCount = 0;
// Recent notifications (newest first, capped). The bell OPENS this list — it must never
// just vanish on click (toasts are ephemeral; this is where the operator re-reads what
// they missed, e.g. "Portal run failed" details).
const notifItems = [];

function showToast(message, kind = "info", durationMs = 6000) {
  const container = $("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  const bg = kind === "error" ? "var(--danger)" : kind === "warning" ? "var(--warning)" : kind === "success" ? "var(--success)" : "var(--info)";
  toast.style.cssText = `background:${bg};color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;max-width:340px;box-shadow:0 2px 12px rgba(0,0,0,.18);pointer-events:auto;cursor:pointer;opacity:1;transition:opacity .3s`;
  toast.textContent = message;
  toast.addEventListener("click", () => toast.remove());
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 350); }, durationMs);
}

function bumpNotifBadge(message, kind = "info") {
  notifCount++;
  notifItems.unshift({ message: String(message || "Notification"), kind, at: new Date() });
  if (notifItems.length > 50) notifItems.length = 50;
  const btn = $("notifBadgeBtn");
  const badge = $("notifBadge");
  if (!btn || !badge) return;
  btn.style.display = "";
  badge.style.display = "";
  badge.textContent = String(notifCount);
}

// Bell click = OPEN the notification history panel (and mark them read). The button
// stays visible; only the unread-count bubble clears. It used to hide the whole button,
// which read as "my notifications disappeared".
function toggleNotifPanel() {
  const existing = document.getElementById("notifPanel");
  if (existing) { existing.remove(); return; }
  notifCount = 0;
  const badge = $("notifBadge");
  if (badge) { badge.textContent = "0"; badge.style.display = "none"; }
  const btn = $("notifBadgeBtn");
  const panel = document.createElement("div");
  panel.id = "notifPanel";
  panel.style.cssText = "position:fixed;top:56px;right:16px;z-index:9998;width:360px;max-height:60vh;overflow:auto;background:var(--panel,#fff);border:1px solid var(--border,#ddd);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:8px";
  const fmt = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  panel.innerHTML = notifItems.length
    ? notifItems.map((n) =>
        `<div style="padding:8px 10px;border-bottom:1px solid var(--border,#eee);font-size:12.5px;display:flex;gap:8px;align-items:baseline">
           <span style="flex:0 0 auto;font-size:11px;color:var(--muted,#777)">${esc(fmt(n.at))}</span>
           <span style="${n.kind === "error" ? "color:var(--danger,#c00);font-weight:600" : n.kind === "warning" ? "color:var(--warning,#a60)" : ""}">${esc(n.message)}</span>
         </div>`).join("")
    : `<div style="padding:14px;font-size:13px;color:var(--muted,#777)">No notifications yet this session.</div>`;
  const clear = document.createElement("button");
  clear.className = "ghost";
  clear.textContent = "Clear history";
  clear.style.cssText = "margin:8px 10px";
  clear.addEventListener("click", () => { notifItems.length = 0; panel.remove(); });
  panel.appendChild(clear);
  document.body.appendChild(panel);
  // Close when clicking anywhere outside the panel/bell.
  const dismiss = (e) => {
    if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
    panel.remove();
    document.removeEventListener("click", dismiss, true);
  };
  setTimeout(() => document.addEventListener("click", dismiss, true), 0);
}

if ($("notifBadgeBtn")) {
  $("notifBadgeBtn").addEventListener("click", toggleNotifPanel);
}

const SSE_EVENT_KINDS = {
  correction_received: "warning",
  permit_issued: "success",
  permit_ready_for_issue: "success",
  nem_approved: "success",
  run_paused: "warning",
  run_failed: "error",
  job_failed: "error",
  run_complete: "info",
  // Kickoff signals — previously emitted by the backend but never subscribed, so the
  // "staging started / autopilot started" toasts silently never appeared.
  staging_started: "info",
  autopilot_started: "info",
  email_matched: "info",
  intake_submitted: "info",
  imap_poll_done: "info",
  // The automatic build/verify chain finished a pass — refetches the open project.
  stage_steps_done: "info",
};

function connectSse() {
  const es = new EventSource("/api/events");
  es.addEventListener("ping", () => { /* heartbeat — no action needed */ });
  for (const [type, kind] of Object.entries(SSE_EVENT_KINDS)) {
    es.addEventListener(type, (ev) => {
      try {
        const data = JSON.parse(ev.data);
        showToast(data.message || type, kind);
        bumpNotifBadge(data.message || type, kind);
        // Refresh the affected project row if it's currently open.
        if (data.projectId && state.selectedProjectId === data.projectId) {
          selectProject(data.projectId).catch(() => null);
        }
        // Refresh the project list so board status badges update.
        loadProjects().catch(() => null);
      } catch { /* malformed event — ignore */ }
    });
  }
  // Auto-learn progress drives the inline bar only — no toast, no badge, no refetch
  // (it fires several times per run). Applied only when the run's project is open and
  // the bar is currently mounted.
  es.addEventListener("autolearn_progress", (ev) => {
    try {
      const evt = JSON.parse(ev.data);
      if (evt.projectId && state.selectedProjectId === evt.projectId) {
        updateAutoLearnProgress(evt.data && evt.data.percent, evt.message);
      }
    } catch { /* malformed event — ignore */ }
  });
  es.onerror = () => {
    es.close();
    // Reconnect after a short delay so a server restart doesn't leave the tab deaf.
    setTimeout(connectSse, 5000);
  };
}

connectSse();



// ---------------------------------------------------------------------------
// Keyboard-first operator shortcuts. Wired only to elements/actions that
// already exist — no new backend calls. Typing in a field disables single-key
// shortcuts (Esc and Ctrl/Cmd+K still work) so normal data entry is unaffected.
// ---------------------------------------------------------------------------
(function installKeyboardShortcuts() {
  const MODAL_IDS = ["portalLoginsModal", "knowledgeModal", "customersModal", "clientsModal", "usersModal", "kpiModal"];
  const MODAL_CLOSERS = {
    knowledgeModal: () => $("closeKnowledgeBtn")?.click(),
    customersModal: () => $("closeCustomersBtn")?.click(),
    clientsModal: () => $("closeClientsBtn")?.click(),
    usersModal: () => $("closeUsersBtn")?.click(),
    kpiModal: () => $("closeKpiBtn")?.click(),
    portalLoginsModal: () => $("closePortalLoginsBtn")?.click(),
  };

  const isTyping = (el) => {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  };
  const openModalId = () => MODAL_IDS.find((id) => $(id) && !$(id).hidden);
  const shortcutsOpen = () => $("shortcutsOverlay") && !$("shortcutsOverlay").hidden;

  function toggleShortcuts(show) {
    const ov = $("shortcutsOverlay");
    if (!ov) return;
    ov.hidden = show === undefined ? !ov.hidden : !show;
  }

  // Which list of project cards/rows is currently visible (board vs table).
  function visibleProjectNodes() {
    if (state.page === "dashboard") return Array.from(document.querySelectorAll("#projectBoard [data-board-pid]"));
    if (state.page === "projects") return Array.from(document.querySelectorAll("#projectsBody tr[data-project-id]"));
    return [];
  }
  function nodePid(node) { return node.dataset.boardPid || node.dataset.projectId; }

  let cursorIndex = -1;
  function clearCursor() {
    document.querySelectorAll(".board-card.kbd-cursor, tr.kbd-cursor").forEach((n) => n.classList.remove("kbd-cursor"));
  }
  function moveCursor(delta) {
    const nodes = visibleProjectNodes();
    if (!nodes.length) return;
    clearCursor();
    cursorIndex = Math.max(0, Math.min(nodes.length - 1, (cursorIndex < 0 ? (delta > 0 ? -1 : 0) : cursorIndex) + delta));
    const node = nodes[cursorIndex];
    node.classList.add("kbd-cursor");
    node.scrollIntoView({ block: "nearest" });
  }
  function openCursor() {
    const nodes = visibleProjectNodes();
    const node = nodes[cursorIndex];
    if (node) selectProject(nodePid(node));
  }

  let gPending = false;
  let gTimer = null;

  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.metaKey && e.key.toLowerCase() !== "k" || e.ctrlKey && e.key.toLowerCase() !== "k") {
      // Allow only Cmd/Ctrl+K through the modifier gate below.
    }

    // Esc: close the top-most overlay, or blur the focused field.
    if (e.key === "Escape") {
      if (shortcutsOpen()) { toggleShortcuts(false); e.preventDefault(); return; }
      const m = openModalId();
      if (m) { MODAL_CLOSERS[m](); e.preventDefault(); return; }
      if (isTyping(document.activeElement)) { document.activeElement.blur(); e.preventDefault(); return; }
      if ($("shortcutsOverlay")) { /* nothing else open */ }
      return;
    }

    // Cmd/Ctrl+K: focus project search regardless of focus context.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      const search = $("projectSearch");
      if (search && !search.closest("[hidden]")) { e.preventDefault(); search.focus(); search.select(); }
      return;
    }

    // Remaining shortcuts are single-key and must not fire while typing.
    if (isTyping(document.activeElement)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (openModalId()) return; // don't hijack keys inside an open modal

    // `g` prefix for navigation (g d / g p / g t).
    if (gPending) {
      gPending = false;
      clearTimeout(gTimer);
      const map = { d: "#/dashboard", p: "#/projects", t: "#/team" };
      const dest = map[e.key.toLowerCase()];
      if (dest) { e.preventDefault(); navigate(dest); cursorIndex = -1; clearCursor(); }
      return;
    }

    switch (e.key) {
      case "/":
        if (shortcutsOpen()) return;
        { const s = $("projectSearch"); if (s && !s.closest("[hidden]")) { e.preventDefault(); s.focus(); s.select(); } }
        break;
      case "?":
        e.preventDefault(); toggleShortcuts();
        break;
      case "j": e.preventDefault(); moveCursor(1); break;
      case "k": e.preventDefault(); moveCursor(-1); break;
      case "Enter": if (cursorIndex >= 0) { e.preventDefault(); openCursor(); } break;
      case "r": e.preventDefault(); $("refreshBtn")?.click(); break;
      case "g": gPending = true; gTimer = setTimeout(() => { gPending = false; }, 800); break;
      default: break;
    }
  });

  // Clicking the shortcuts backdrop closes it.
  $("shortcutsOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "shortcutsOverlay") toggleShortcuts(false);
  });
})();

// Creating a client link does not send it.
$("showArchivedProjects")?.addEventListener("change", () => { projectFilterState.offset = 0; fetchProjectPage(false); });
async function createClientLink(kind) {
  const clientId = state.editingClientId;
  if (!clientId) return;
  const status = $("clientLinkStatus");
  $("clientLinkResultWrap").hidden = true;
  status.textContent = "Creating link…";
  try {
    let result;
    if (kind === "tracking") {
      result = await api(`/api/clients/${clientId}/portal-link`, { method: "POST" });
    } else {
      const portalType = $("cred_portalType").value.trim();
      const portalUrl = $("cred_portalUrl").value.trim();
      if (!portalType || !portalUrl) throw new Error("Enter the portal name and URL below, then create the secure request. No password is needed here.");
      result = await api(`/api/clients/${clientId}/credential-requests`, { method: "POST", body: JSON.stringify({ portals: [{ portalType, portalUrl }] }) });
    }
    if (state.editingClientId !== clientId) return;
    $("clientLinkResult").value = new URL(result.url, location.origin).href;
    $("clientLinkResultWrap").hidden = false;
    $("clientLinkResult").select();
    status.textContent = kind === "tracking" ? "Read-only company tracking link. Copy and share it with this client." : "One-time login request, valid for 72 hours. Copy and share it with this client.";
  } catch (err) { status.textContent = err.message || "Could not create link."; }
}
$("clientTrackingLinkBtn")?.addEventListener("click", () => createClientLink("tracking"));
$("clientCredentialLinkBtn")?.addEventListener("click", () => createClientLink("credentials"));

// ---------------------------------------------------------------------------
// MODAL FOCUS AND BACKGROUND. Opening a modal left focus on <body>, and Tab walked into the
// page behind the overlay. Seven openers and closers each flip `hidden` their own way (buttons,
// Esc, backdrop, after an await), so this does NOT hook any of them: one observer watches every
// .modal's `hidden` attribute and derives the rest from what is actually on screen —
//   - a modal appears: remember what had focus, move focus to its title (tabindex -1; no
//     on-screen keyboard popping on a phone), and make the header + main `inert`;
//   - the last modal disappears: drop `inert` and give focus back.
// Because `inert` is recomputed from the modals' real state on every change, no missed closer
// path can leave the page unclickable.
// ---------------------------------------------------------------------------
(function installModalFocus() {
  if (typeof MutationObserver !== "function" || typeof document === "undefined") return;
  const modals = Array.from(document.querySelectorAll(".modal"));
  if (!modals.length) return;
  const background = [document.querySelector("header.topbar"), document.querySelector("main.layout")].filter(Boolean);
  let returnTo = null;
  const openModals = () => modals.filter((m) => !m.hidden);
  const sync = (changed) => {
    const open = openModals();
    for (const el of background) el.inert = open.length > 0;
    if (changed && !changed.hidden) {
      if (!returnTo || !document.contains(returnTo)) returnTo = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      if (!changed.contains(document.activeElement)) {
        const title = changed.querySelector(".modal-head h2");
        if (title) { title.setAttribute("tabindex", "-1"); title.focus({ preventScroll: true }); }
      }
    } else if (!open.length) {
      const back = returnTo;
      returnTo = null;
      if (back && document.contains(back) && typeof back.focus === "function") back.focus({ preventScroll: true });
    }
  };
  const observer = new MutationObserver((records) => { for (const r of records) sync(r.target); });
  for (const m of modals) observer.observe(m, { attributes: true, attributeFilter: ["hidden"] });
  sync(null);
})();
