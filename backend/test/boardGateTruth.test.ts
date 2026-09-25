// THE BOARD TELLS THE TRUTH: one answer to "is this ready", and it is the SUBMIT GATE's.
//
// Evidence: the 100-project load test's board showed 100 cards "Ready to stage" and a
// "Ready to stage (98)" pill while the gate passed 16 (.probe/volume/assess_load.result.md); the
// demo's refusal project (Gus) read "Ready to stage" on its card, and "Ready to stage / Qc Passed"
// in its Status box, beside BLOCKED (.probe/presentation/READINESS.md S1). S2b: a severity=error QC
// row was counted as WARN ("0 FAIL / 4 WARN" over a staging blocker).
//
// Mechanism: the project LIST runs nextStep's rule table WITHOUT the gate (gateChecked:false —
// ~50 ms a project), and the board rendered that list answer's ready_to_stage as "Ready to stage";
// the Status box printed the recorded status; renderQc counted qc_status only.
//
// The fix (frontend/dashboard.js), exercised here on the REAL functions lifted from the file and on
// the REAL rule table (decideNextStep) for the answers:
//   - a list-tier "ready" answer reads "Gate check pending" under its own pill, never "Ready to
//     stage", until the gate's own answer for that card (GET /api/projects/:id/next-step, fetched
//     three at a time) arrives; then the card, its pill and the Status box show THAT answer;
//   - the card says who acts next;
//   - a severity=error QC row counts as FAIL.
//   MUST-PASS    a gate-blocked project never renders "Ready to stage" (card, pill, Status box).
//   MUST-EXCLUDE a truly ready project (gate says ready) marked blocked or pending.
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
const dashboard = fs.readFileSync(path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const { decideNextStep, compactNextStep } = await import("../src/nextStep");

/** Lift a top-level `[async] function NAME(` or `const NAME = ` by bracket balance (submitSeam's lift). */
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
  "esc", "humanize", "fmtDate", "NEXT_STEP_CHIP", "WAITING_ON_LABEL", "NEXT_STEP_PROBLEM_KEYS", "nextStepChip",
  "GATE_ANSWER_TTL_MS", "gateStampFor", "boardStepFor", "compactGateAnswer", "rowNeedsGateAnswer", "rememberGateAnswer",
  "scheduleBoardRerender", "hydrateBoardGates",
  "boardAttention", "legacyBoardAttention", "nextStepFor", "NEXT_STEPS", "NEEDS_ME_PILLS", "needsMeCounts",
  "BOARD_WHO_SHORT", "boardWhoHtml", "boardReviewCountChip", "boardCardHtml",
  "STATUS_LABELS", "statusLabel", "PRE_STAGE_STATUSES", "statusBoxView", "currentNextStep", "NEXT_STEP_BUTTON_LABELS", "renderStatusBox",
  "qcVerdict", "qcCounts",
];
const code = `let gateHydrationRunning = false; let gateHydrationAgain = false; let gateRenderTimer = null;\n${NAMES.map(lift).join("\n\n")}`;
const EXPORTS = NAMES.join(", ");
type Lib = Record<string, any>;
const load = (state: Record<string, unknown>, stubs: Record<string, unknown> = {}, els: Record<string, any> = {}): Lib => {
  const all = { safeRender: (_n: string, fn: () => void) => fn(), renderBoard: () => {}, api: async () => ({}), ...stubs };
  // eslint-disable-next-line no-new-func
  return new Function("$", "state", ...Object.keys(all), `${code}\nreturn { ${EXPORTS} };`)((id: string) => els[id] ?? null, state, ...Object.values(all));
};

// ── The answers, from the REAL rule table ────────────────────────────────────────────────────
const nemTrack = { track: "nem", filed: false, filedAt: null, done: false, latestRun: null, onPortal: false, stagedRun: null, gapFillMissing: [], feeDue: false, paymentDue: false };
const facts = { projectId: "p", status: "ready_to_stage", stageDetail: "qc_passed", archived: false, ahj: "City of Tigard", utility: "PGE", operatorHold: null, openCorrections: [], jobInFlight: null, tracks: [nemTrack], reopenPause: null, qcRan: true, qcFails: [], qcReview: [], portalReadings: 0, approvedRunIds: [] };
const listReady = compactNextStep(decideNextStep(facts as any));                     // list tier: no gate
const fullBlocked = decideNextStep({ ...facts, gate: { decision: "blocked", blockers: [{ id: "permit-requirements", title: "PermitFlow reviewer and history check", nextAction: "Clear AHJ blocker callouts." }] }, reviewerBlockers: [] } as any);
const fullReady = decideNextStep({ ...facts, gate: { decision: "ready_to_stage", blockers: [] }, reviewerBlockers: [] } as any);
check("SETUP: the list tier's answer is ready_to_stage, unchecked, and the server says the gate can overrule it",
  listReady.key === "ready_to_stage" && listReady.gateChecked === false && listReady.gateCanOverrule === true, JSON.stringify(listReady));
check("SETUP: the gate's answer for the same facts is gate_blocked (designer) / ready_to_stage",
  fullBlocked.key === "gate_blocked" && fullBlocked.who === "designer" && fullReady.key === "ready_to_stage" && fullReady.gateChecked === true);

const UPDATED = "2026-09-24T10:00:00.000Z";
const row = (id: string, nextStep: unknown, over: Record<string, unknown> = {}) => ({ id, status: "ready_to_stage", stageDetail: "qc_passed", updatedAt: UPDATED, homeownerName: `Owner ${id}`, projectAddress: "1 Main St", nextStep, ...over });
const words = (html: string): string => html.replace(/<[^>]+>/g, " ");

// ── 1. Before the gate answers: never "Ready to stage" ─────────────────────────────────────
{
  const state: Record<string, unknown> = { gateAnswers: {}, users: [] };
  const lib = load(state);
  const gus = row("gus", listReady);
  const chip = lib.nextStepChip(listReady);
  check("MUST-PASS: an unchecked list answer does not say 'Ready to stage' on the chip", chip.label !== "Ready to stage" && /gate/i.test(chip.label), chip.label);
  check("…it is counted under 'Gate check pending', never under 'Ready to stage'", chip.key === "gate_pending");
  const card = lib.boardCardHtml(gus, {});
  check("MUST-PASS: the card itself never renders 'Ready to stage' before its gate answer", !/Ready to stage/.test(words(card)), words(card).replace(/\s+/g, " ").slice(0, 200));
  const counts = lib.needsMeCounts([gus]).counts;
  check("…and the 'Ready to stage (N)' pill does not count it", counts.ready === 0 && counts.gate_pending === 1, JSON.stringify(counts));
  check("every chip pill (incl. gate_pending) is a pill that exists", (lib.NEEDS_ME_PILLS as Array<{ key: string }>).some((p) => p.key === "gate_pending"));
  const box = lib.statusBoxView({ status: "ready_to_stage" }, { step: listReady, full: false });
  check("MUST-PASS: the Status box does not say 'Ready to stage' on an unchecked answer", !/Ready to stage/.test(box.text), box.text);
  check("…nor does the recorded status label ('Docs built' — the status is where the pipeline is)", !/Ready to stage/.test(lib.statusLabel("ready_to_stage")), lib.statusLabel("ready_to_stage"));
}

// ── 2. The gate says BLOCKED: every surface says so, and who acts ─────────────────────────
{
  const state: Record<string, unknown> = { gateAnswers: {}, users: [] };
  const lib = load(state);
  const gus = row("gus", listReady);
  (state.gateAnswers as Record<string, unknown>).gus = { stamp: lib.gateStampFor(gus), at: Date.now(), step: lib.compactGateAnswer(fullBlocked) };
  const card = lib.boardCardHtml(gus, {});
  check("MUST-PASS: with the gate's answer in hand, a gate-blocked card reads 'Gate blocked' — never 'Ready to stage'",
    /Gate blocked/.test(words(card)) && !/Ready to stage/.test(words(card)), words(card).replace(/\s+/g, " ").slice(0, 200));
  check("…and says who acts next (the designer)", /Next: Designer/.test(words(card)), words(card).replace(/\s+/g, " ").slice(0, 200));
  const counts = lib.needsMeCounts([gus]).counts;
  check("MUST-PASS: it counts under 'To fix', not 'Ready to stage'", counts.to_fix === 1 && counts.ready === 0 && counts.gate_pending === 0, JSON.stringify(counts));
  const box = lib.statusBoxView({ status: "ready_to_stage", stageDetail: "qc_passed" }, { step: fullBlocked, full: true });
  check("MUST-PASS: the Status box says the gate's answer ('Gate blocked'), not 'Ready to stage'", box.text === "Gate blocked" && !/Ready/.test(box.text), box.text);
  check("…hides the 'QC passed' sub-stage beside the blocker, and keeps the recorded status in the tooltip",
    box.hideStageDetail === true && /Recorded status: Docs built/.test(box.title), JSON.stringify(box));
  // The Status box element itself, through renderStatusBox (the path renderDetail and every
  // autopilot poll take).
  const els: Record<string, any> = { metricStatus: { textContent: "", title: "" }, metricStageDetail: { textContent: "", title: "", hidden: false } };
  const pageState: Record<string, unknown> = { gateAnswers: {}, selectedProjectId: "gus", nextStep: fullBlocked, nextStepProjectId: "gus", detail: { project: { id: "gus", status: "ready_to_stage", stageDetail: "qc_passed" } }, projects: [] };
  load(pageState, {}, els).renderStatusBox();
  check("MUST-PASS: the rendered Status box element reads 'Gate blocked' with the sub-stage hidden",
    els.metricStatus.textContent === "Gate blocked" && els.metricStageDetail.hidden === true, JSON.stringify(els));
}

// ── 3. MUST-EXCLUDE: a truly ready project reads ready ────────────────────────────────────
{
  const state: Record<string, unknown> = { gateAnswers: {}, users: [] };
  const lib = load(state);
  const ready = row("ready", listReady);
  (state.gateAnswers as Record<string, unknown>).ready = { stamp: lib.gateStampFor(ready), at: Date.now(), step: lib.compactGateAnswer(fullReady) };
  const card = lib.boardCardHtml(ready, {});
  check("MUST-EXCLUDE: a project the GATE passed reads 'Ready to stage' (not blocked, not pending)",
    /Ready to stage/.test(words(card)) && !/Gate blocked|Gate check pending/.test(words(card)), words(card).replace(/\s+/g, " ").slice(0, 200));
  const counts = lib.needsMeCounts([ready]).counts;
  check("MUST-EXCLUDE: …and is counted under 'Ready to stage'", counts.ready === 1 && counts.gate_pending === 0 && counts.to_fix === 0, JSON.stringify(counts));
  const box = lib.statusBoxView({ status: "ready_to_stage", stageDetail: "qc_passed" }, { step: fullReady, full: true });
  check("MUST-EXCLUDE: its Status box reads 'Ready to stage' and keeps the QC-passed sub-stage", box.text === "Ready to stage" && box.hideStageDetail === false, JSON.stringify(box));
  const serverReadyList = { ...listReady, gateChecked: true, gateCanOverrule: false };
  check("MUST-EXCLUDE: a list answer the server already gate-checked is shown as-is ('Ready to stage')",
    lib.nextStepChip(serverReadyList).label === "Ready to stage" && lib.nextStepChip(serverReadyList).key === "ready");
  check("MUST-EXCLUDE: other statuses keep their recorded label in the Status box",
    lib.statusBoxView({ status: "submitted" }, { step: fullBlocked, full: true }).text === "Submitted");
}

// ── 4. A cached answer is for ITS row only ─────────────────────────────────────────────────
{
  const state: Record<string, unknown> = { gateAnswers: {}, users: [] };
  const lib = load(state);
  const before = row("p1", listReady);
  (state.gateAnswers as Record<string, unknown>).p1 = { stamp: lib.gateStampFor(before), at: Date.now(), step: lib.compactGateAnswer(fullReady) };
  const changed = row("p1", listReady, { updatedAt: "2026-09-24T11:00:00.000Z" });
  check("MUST-EXCLUDE: an answer fetched before the project changed is not shown for it (back to pending)",
    lib.boardAttention(changed).key === "gate_pending", JSON.stringify(lib.boardAttention(changed)));
  check("…and the changed row is asked again", lib.rowNeedsGateAnswer(changed, Date.now()) === true);
  check("…while the unchanged row is not re-asked", lib.rowNeedsGateAnswer(before, Date.now()) === false);
  const later = Date.now() + lib.GATE_ANSWER_TTL_MS + 1000;
  check("MUST-EXCLUDE: a stale answer (past its TTL) is not shown as current", lib.boardStepFor(before, later).gateChecked === false);
  check("a row the gate cannot overrule is never fetched", lib.rowNeedsGateAnswer(row("x", { ...listReady, gateCanOverrule: false }), Date.now()) === false);
  const oldServerRow = row("old", { key: "ready_to_stage", who: "me", urgency: "today", headline: "Next: stage", gateChecked: false });
  check("an older server's ready row (no gateCanOverrule field) still gets its gate answer, and reads pending meanwhile",
    lib.rowNeedsGateAnswer(oldServerRow, Date.now()) === true && lib.boardAttention(oldServerRow).key === "gate_pending");
}

// ── 5. Hydration: the gate's answers arrive, three at a time, and move the cards ───────────
{
  const rows = Array.from({ length: 10 }, (_, i) => row(`h${i}`, listReady));
  const state: Record<string, unknown> = { gateAnswers: {}, users: [], projects: rows, boardAll: rows };
  let inFlight = 0;
  let maxInFlight = 0;
  const asked: string[] = [];
  const api = async (url: string) => {
    const id = /\/api\/projects\/([^/]+)\/next-step/.exec(url)?.[1] ?? "";
    asked.push(id);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (id === "h9") throw new Error("Request failed: 500");
    return { nextStep: id === "h0" ? fullReady : fullBlocked };
  };
  const lib = load(state, { api });
  await lib.hydrateBoardGates();
  check("every card that needed the gate was asked exactly once", asked.length === 10 && new Set(asked).size === 10, asked.join(","));
  check("…never more than THREE at a time (300 at once froze the server for 11 s)", maxInFlight <= 3 && maxInFlight >= 2, String(maxInFlight));
  const counts = lib.needsMeCounts(rows).counts;
  check("MUST-PASS: after hydration the pills are the gate's: 1 ready, 8 to fix, and the failed fetch stays pending (never 'ready')",
    counts.ready === 1 && counts.to_fix === 8 && counts.gate_pending === 1, JSON.stringify(counts));
  asked.length = 0;
  await lib.hydrateBoardGates();
  check("a second pass does not re-ask answered rows, nor retry a failure within a minute", asked.length === 0, asked.join(","));
  // The project page's own full answer lands on the card too.
  const pageState: Record<string, unknown> = { gateAnswers: {}, projects: [row("pg", listReady)] };
  const pageLib = load(pageState);
  pageLib.rememberGateAnswer("pg", fullBlocked);
  check("the project page's next-step answer is remembered for its board card", pageLib.boardAttention(row("pg", listReady)).stepKey === "gate_blocked");
  pageLib.rememberGateAnswer("pg", { ...listReady });
  check("MUST-EXCLUDE: a list-tier (unchecked) answer is never remembered as the gate's", (pageState.gateAnswers as Record<string, { step: { key: string } }>).pg.step.key === "gate_blocked");
}

// ── 6. S2b: severity=error counts as FAIL ──────────────────────────────────────────────────
{
  const lib = load({});
  const rows = [
    { qcStatus: "warning", severity: "error", ruleName: "Required document", message: "PE-stamped structural plans … not attached. Staging will refuse without it." },
    { qcStatus: "warning", severity: "warning", ruleName: "Module listing", message: "check" },
    { qcStatus: "pass", severity: "info", ruleName: "Owner", message: "ok" },
    { qcStatus: "fail", severity: "warning", ruleName: "Account", message: "missing" },
  ];
  const c = lib.qcCounts(rows);
  check("MUST-PASS: a severity=error row counts as FAIL, never WARN (was '0 fail / 4 warn')", c.fails === 2 && c.warnings === 1, JSON.stringify(c));
  check("…and its badge is FAIL", lib.qcVerdict(rows[0]) === "fail");
  check("MUST-EXCLUDE: a severity=warning warning row stays a WARN; a pass stays a pass", lib.qcVerdict(rows[1]) === "warning" && lib.qcVerdict(rows[2]) === "pass");
}

if (failures) { console.error(`\nboardGateTruth: ${failures} FAILED`); process.exit(1); }
console.log("\nboardGateTruth: all checks passed");
process.exit(0);
