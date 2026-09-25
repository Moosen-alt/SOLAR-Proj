// ---------------------------------------------------------------------------
// Run-triage agent — reads a finished learn/stage debug bundle the way a human
// would (this session did it by hand), finds what the run missed and why, and
// files structured findings. Two of the fix kinds are applied deterministically
// and safely (a self-taught digest topic, a human-review data-gap item); the
// rest are advisory — surfaced in the job result and a project note, never
// auto-applied, because mutating the learned KB or code is a human's call.
//
// The heavy lifting is a DETERMINISTIC pre-digest (no LLM): it parses the bundle
// into a compact summary so the agent reasons over ~2 KB of structured facts
// instead of re-reading every file. The agent then uses a few narrow tools
// (read a bundle file / screenshot, read the project summary, report a finding).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import type { AgentToolDef, ProjectRecord } from "../../shared/src/types";
import { createLLMProvider } from "./llm";
import { getProjectDetail, addProjectNote } from "./repository";
import { designNotesDigest } from "./autoLearn";
import { learnNoteTopicsFromMisses } from "./noteTopics";
import { logger } from "./logger";
import { id } from "./ids";
import { nowIso } from "./time";

const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;
const FIX_KINDS = ["equipment_alias", "kb_note", "learned_topic", "data_gap", "code_bug", "none"] as const;
type FixKind = (typeof FIX_KINDS)[number];

export interface TriageFinding {
  severity: "blocker" | "warning" | "note";
  title: string;
  rootCause: string;
  suggestedFix: string;
  fixKind: FixKind;
  /** For learned_topic / data_gap: the label/term to act on. */
  target?: string;
  applied?: boolean;
}

export interface TriageResult {
  runId: string;
  provider: "claude" | "stub";
  findings: TriageFinding[];
  appliedCount: number;
  digestSummary: string;
  message: string;
}

// ---- bundle location + safe reads ----------------------------------------

function runsBase(): string {
  return process.env.AUTOLEARN_RUN_DIR ? path.resolve(process.env.AUTOLEARN_RUN_DIR) : path.resolve(process.cwd(), "data", "learn-runs");
}

function runDir(runId: string): string | null {
  if (!runId || !SAFE_RUN_ID.test(runId)) return null;
  const dir = path.join(runsBase(), runId);
  return fs.existsSync(dir) ? dir : null;
}

function readJson<T>(dir: string, name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

function listBundleFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => SAFE_RUN_ID.test(n)).sort();
  } catch {
    return [];
  }
}

// ---- deterministic pre-digest --------------------------------------------

interface PageSummary {
  page: number;
  fillable: number;
  decided: number;
  unfilled: string[];
}

/** Parse the bundle into a compact, LLM-ready summary. Mirrors the by-hand
 *  analysis: per-page fillable-vs-decided counts + unfilled labels, the verify
 *  verdict's mismatches, required-field misses, and upload events. */
export function digestBundle(dir: string): { summary: string; pages: PageSummary[]; misses: string[] } {
  const result = readJson<Record<string, unknown>>(dir, "result.json", {});
  const verdict = readJson<Record<string, unknown>>(dir, "verdict.json", {});
  const files = listBundleFiles(dir);

  const pages: PageSummary[] = [];
  for (const name of files) {
    const m = name.match(/^p(\d+)-plan\.json$/);
    if (!m) continue;
    const plan = readJson<Record<string, unknown>>(dir, name, {});
    const seen = Array.isArray(plan.fieldsSeen) ? (plan.fieldsSeen as Array<Record<string, unknown>>) : [];
    const decisions = Array.isArray(plan.decisions) ? (plan.decisions as Array<Record<string, unknown>>) : [];
    const decidedIdx = new Set(decisions.map((d) => d.index));
    const fillable = seen.filter((f) => ["text", "select", "radio", "checkbox", "other"].includes(String(f.type)));
    const unfilled = fillable
      .filter((f) => !decidedIdx.has(f.i))
      .map((f) => String(f.label || "").slice(0, 80))
      .filter((l) => l && !/program homepage|form will not be submitted/i.test(l));
    pages.push({ page: Number(m[1]), fillable: fillable.length, decided: decisions.length, unfilled });
  }

  // Verify signals.
  const det = (verdict.deterministicSignal ?? {}) as Record<string, unknown>;
  const gating = Array.isArray(det.mismatchesGating) ? (det.mismatchesGating as unknown[]).map(String) : [];
  const detMismatches = Array.isArray(det.allMismatches) ? (det.allMismatches as Array<Record<string, unknown>>) : [];
  const finalIssues = Array.isArray(verdict.finalIssues) ? (verdict.finalIssues as unknown[]).map(String) : [];

  // Required-field misses live in result.json's verification.issues too.
  const verification = (result.verification ?? {}) as Record<string, unknown>;
  const resultIssues = Array.isArray(verification.issues) ? (verification.issues as unknown[]).map(String) : [];
  const misses = extractRequiredMisses([...resultIssues, ...finalIssues]);

  // Upload events from the events timeline.
  const uploads = readUploadEvents(dir);

  const lines: string[] = [];
  lines.push(`RUN ${path.basename(dir)} — status=${String(result.status)} pages=${String(result.pageCount)} finalSubmitRecorded=${String(result.finalSubmitRecorded)}`);
  lines.push(`verify: accurate=${String(verification.accurate)} confidence=${String(verification.confidence)}`);
  if (gating.length) lines.push(`deterministic gating mismatches: ${gating.join(", ")}`);
  // A mismatch on a secret field (account / meter number, password, SSN) names the field only —
  // its values never reach the triage LLM (rule 2).
  for (const m of detMismatches.slice(0, 8)) {
    lines.push(/acc(oun)?t|meter|ssn|social|passw/i.test(String(m.field))
      ? `  mismatch ${m.field}: (value withheld — sensitive field)`
      : `  mismatch ${m.field}: expected "${String(m.expected).slice(0, 40)}" found "${String(m.found).slice(0, 40)}"`);
  }
  if (misses.length) lines.push(`REQUIRED fields left blank: ${misses.join(" | ")}`);
  for (const p of pages) {
    if (p.unfilled.length) lines.push(`page ${p.page}: ${p.decided}/${p.fillable} filled — unfilled: ${p.unfilled.slice(0, 8).join(", ")}`);
  }
  if (uploads.length) lines.push(`uploads: ${uploads.join(", ")}`);
  for (const iss of resultIssues.slice(0, 6)) lines.push(`issue: ${iss}`);

  return { summary: lines.join("\n").slice(0, 6000), pages, misses };
}

function extractRequiredMisses(issues: string[]): string[] {
  const out: string[] = [];
  for (const iss of issues) {
    const m = iss.match(/left blank\/unselected[^:]*:\s*(.+?)\.?$/i);
    if (m) out.push(...m[1].split(/;|,/).map((s) => s.trim()).filter(Boolean));
  }
  return [...new Set(out)];
}

function readUploadEvents(dir: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
    const out: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (typeof e.type === "string" && /upload/i.test(e.type)) out.push(`${e.type}:${String(e.docType || e.label || "").slice(0, 40)}`);
      } catch { /* skip */ }
    }
    return out.slice(0, 12);
  } catch {
    return [];
  }
}

// ---- the agent ------------------------------------------------------------

const TRIAGE_SYSTEM = `You are triaging a completed solar-permit portal automation run (a "learn" or "stage" run against a utility/AHJ web portal). A deterministic DIGEST of the run is provided. Your job: identify what the run got WRONG or LEFT BLANK, the likely root cause, and a concrete fix — then call report_finding once per issue.

You may read raw bundle files (page plans, the review screenshot) with read_bundle_file, and the project's data with get_project_summary, to confirm a root cause before reporting. Prefer the digest; only open files when you need to confirm something specific. Keep tool calls minimal.

For each real issue call report_finding with:
- severity: "blocker" (run can't succeed / wrong data submitted), "warning" (a field left blank that a human must fill), or "note" (minor).
- fixKind, chosen carefully:
  - "learned_topic": a REQUIRED question was left blank because the planner lacked the design context to answer it. target = the exact question label. (This is auto-applied: the system will start surfacing plan-set lines matching the question's words to the planner next run.)
  - "data_gap": the project record is genuinely missing a value the portal needs. target = the field name. (Auto-applied as a human-review item.)
  - "equipment_alias": a manufacturer/model dropdown didn't match because the portal lists the equipment under a different certified name. suggestedFix = the mapping "PlanName -> PortalName". (Report-only; a human adds the alias.)
  - "kb_note": a portal-specific quirk worth remembering for this AHJ/utility. (Report-only.)
  - "code_bug": the automation itself misbehaved (a loop, a wrong click, a crash). (Report-only.)
  - "none": informational only.

Do NOT invent problems. If the run looks clean, report nothing. Be concise. When done, stop — do not summarize.`;

/** A bundle screenshot that shows filled values: the review screen, and every after-fill shot. */
export function isUnmaskedFilledShot(fname: string): boolean {
  const f = String(fname || "").toLowerCase();
  return /(^|[-_])review([-_.]|$)/.test(f) || /(^|[-_])after([-_.]|$)/.test(f);
}

/** Run the triage agent on a finished bundle and apply the safe fixes. */
export async function triageLearnRun(db: AppDb, runId: string, projectId: string): Promise<TriageResult> {
  const dir = runDir(runId);
  if (!dir) {
    return { runId, provider: "stub", findings: [], appliedCount: 0, digestSummary: "", message: `No bundle found for run ${runId}.` };
  }
  const { summary } = digestBundle(dir);
  const project = safeProject(db, projectId);
  const findings: TriageFinding[] = [];

  const tools: AgentToolDef[] = [
    {
      name: "read_bundle_file",
      description: "Read one file from this run's debug bundle by name (e.g. 'p007-plan.json', 'verdict.json', 'p007-before-page.png'). PNG files are returned as an image you can see; the review and after-fill shots are withheld (they show the filled values).",
      input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      handler: ({ name }) => {
        const fname = String(name || "");
        if (!SAFE_RUN_ID.test(fname)) return { kind: "text", text: "Invalid file name." };
        const full = path.join(dir, fname);
        if (!fs.existsSync(full)) return { kind: "text", text: `No such file: ${fname}` };
        if (/\.png$/i.test(fname)) {
          // RULE 2 FOR PICTURES. The review screen and every after-fill shot render the values
          // the run TYPED — account and meter numbers included — as raw pixels, and this tool
          // hands the image to the LLM. Those shots are withheld until captures are masked (L2);
          // the before-fill and login shots show the page, not our data.
          if (isUnmaskedFilledShot(fname)) {
            return { kind: "text", text: `${fname} is withheld: it shows the values this run filled (possibly account or meter numbers) as unmasked pixels. Use the page's JSON/text files instead.` };
          }
          try { return { kind: "image", base64: fs.readFileSync(full).toString("base64"), mimeType: "image/png", caption: fname }; }
          catch { return { kind: "text", text: `Could not read ${fname}` }; }
        }
        try { return { kind: "text", text: fs.readFileSync(full, "utf8").slice(0, 12000) }; }
        catch { return { kind: "text", text: `Could not read ${fname}` }; }
      },
    },
    {
      name: "get_project_summary",
      description: "The project's captured data (equipment, sizes, interconnection) plus a digest of design notes from the plan set.",
      input_schema: { type: "object", properties: {} },
      handler: () => ({ kind: "json", value: projectSummary(project) }),
    },
    {
      name: "report_finding",
      description: "Record one triage finding. Call once per issue.",
      input_schema: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocker", "warning", "note"] },
          title: { type: "string" },
          rootCause: { type: "string" },
          suggestedFix: { type: "string" },
          fixKind: { type: "string", enum: [...FIX_KINDS] },
          target: { type: "string" },
        },
        required: ["severity", "title", "rootCause", "suggestedFix", "fixKind"],
      },
      handler: (input) => {
        const fixKind = (FIX_KINDS as readonly string[]).includes(String(input.fixKind)) ? (String(input.fixKind) as FixKind) : "none";
        findings.push({
          severity: (["blocker", "warning", "note"].includes(String(input.severity)) ? String(input.severity) : "note") as TriageFinding["severity"],
          title: String(input.title || "").slice(0, 160),
          rootCause: String(input.rootCause || "").slice(0, 400),
          suggestedFix: String(input.suggestedFix || "").slice(0, 400),
          fixKind,
          target: input.target != null ? String(input.target).slice(0, 160) : undefined,
        });
        return { kind: "text", text: "recorded" };
      },
    },
  ];

  const llm = createLLMProvider();
  const run = await llm.runToolAgent({
    label: "runTriage",
    system: TRIAGE_SYSTEM,
    user: `DIGEST OF THE RUN:\n${summary}`,
    tools,
    maxIterations: 8,
    effort: "medium",
  });

  const appliedCount = applySafeFixes(db, projectId, findings);
  recordTriageNote(db, projectId, runId, findings, appliedCount);

  const message = run.provider === "stub"
    ? "Run triage skipped — no ANTHROPIC_API_KEY (stub mode)."
    : `Run triage found ${findings.length} finding(s); ${appliedCount} auto-applied.`;
  logger.info("triage", message, { runId, projectId });
  return { runId, provider: run.provider, findings, appliedCount, digestSummary: summary, message };
}

// ---- safe-fix application (deterministic) ---------------------------------

function applySafeFixes(db: AppDb, projectId: string, findings: TriageFinding[]): number {
  let applied = 0;
  for (const f of findings) {
    if (f.fixKind === "learned_topic" && f.target) {
      try { learnNoteTopicsFromMisses(db, [f.target]); f.applied = true; applied++; } catch { /* best-effort */ }
    } else if (f.fixKind === "data_gap") {
      try { insertTriageReviewItem(db, projectId, f); f.applied = true; applied++; } catch { /* best-effort */ }
    }
  }
  return applied;
}

function insertTriageReviewItem(db: AppDb, projectId: string, f: TriageFinding): void {
  const ts = nowIso();
  db.run(
    `INSERT INTO human_review_items
      (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id(), projectId, "Run triage", f.target || "portal_field", "", f.suggestedFix, f.title.slice(0, 800), "pending", f.rootCause.slice(0, 400), ts, ts],
  );
}

function recordTriageNote(db: AppDb, projectId: string, runId: string, findings: TriageFinding[], applied: number): void {
  if (!findings.length) return;
  const lines = findings.map((f) => `• [${f.severity}] ${f.title}${f.applied ? " (auto-applied)" : ""} — ${f.suggestedFix}`);
  try {
    addProjectNote(db, projectId, {
      noteType: "system_note",
      body: `Run triage (${runId}): ${findings.length} finding(s), ${applied} auto-applied.\n${lines.join("\n")}`,
      createdBy: "run-triage agent",
    });
  } catch { /* project may not exist in a bare test */ }
}

// ---- project summary helpers ----------------------------------------------

function safeProject(db: AppDb, projectId: string): ProjectRecord | null {
  try { return getProjectDetail(db, projectId).project; } catch { return null; }
}

function projectSummary(project: ProjectRecord | null): Record<string, unknown> {
  if (!project) return { note: "project not found" };
  const snap = (project.parserSnapshot || {}) as Record<string, unknown>;
  const pick = (k: string) => (snap[k] == null ? undefined : String(snap[k]).slice(0, 80));
  return {
    homeowner: project.homeownerName,
    address: project.projectAddress,
    ahj: project.ahj,
    utility: project.utility,
    systemSizeDcKw: project.systemSizeDcKw,
    systemSizeAcKw: project.systemSizeAcKw,
    interconnectionMethod: project.interconnectionMethod,
    inverterMake: pick("inverterManufacturer") || pick("inverterMake"),
    inverterModel: pick("invModel") || pick("inverterModel") || pick("pvMicroModel"),
    moduleMake: pick("moduleManufacturer") || pick("moduleMake"),
    moduleModel: pick("moduleModel"),
    designNotes: designNotesDigest(project, 1500),
  };
}
