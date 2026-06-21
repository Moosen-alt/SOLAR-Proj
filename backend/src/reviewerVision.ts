import fs from "node:fs";
import crypto from "node:crypto";
import type { LLMProvider, ReviewerFinding, ReviewerReport, ReviewerVisionVerdict } from "../../shared/src/types";
import type { AppDb } from "./db";
import { topicForFinding } from "./reviewerEngine";
import { StubLLMProvider } from "./llm";
import { findPlanSetPdf, renderPdfPageToPng, selectPageForTopic } from "./pageImages";
import { extractPdfPages } from "./batchImport";
import type { EvidenceTopic } from "./projectEvidence";
import { nowIso } from "./time";

// ---------------------------------------------------------------------------
// AHJ Reviewer Gate — vision verification pass.
//
// The base reviewer report is built from PARSED TEXT only, so a clearly-drawn
// SLD whose text didn't OCR cleanly gets flagged "weak/missing" (false positive).
// This opt-in pass renders the actual plan-set sheet behind such a finding and
// asks Claude vision whether the required items are present, then upgrades the
// finding's evidence status (and downgrades a warning to a non-blocking callout)
// when vision confirms it. Verdicts are cached per plan-set version to control
// cost. The pass NEVER turns a non-issue into a blocker — it only ADDS evidence
// and can relax a text-only warning; a human still does the final review.
// ---------------------------------------------------------------------------

// Topics that live on the plan set (worth a vision look). Utility/account/owner
// topics are not on the plan sheets, so we skip them here.
const PLAN_TOPICS: Set<EvidenceTopic> = new Set<EvidenceTopic>([
  "sld",
  "siteRoofPlan",
  "firePathway",
  "roofFraming",
  "rackingAttachment",
  "structuralLoads",
  "rapidShutdown",
  "labels",
  "inverterSettings",
  "batteryMode",
]);

const MAX_VISION_CHECKS = 8; // hard cap per run to bound cost/latency

function sourceSig(pdfPath: string): string {
  try {
    const stat = fs.statSync(pdfPath);
    return crypto.createHash("sha1").update(`${pdfPath}:${Math.round(stat.mtimeMs)}:${stat.size}`).digest("hex").slice(0, 16);
  } catch {
    return "nofile";
  }
}

function readCache(db: AppDb, projectId: string, findingId: string, sig: string): ReviewerVisionVerdict | null {
  const row = db.get<{ verdict: string }>(
    "SELECT verdict FROM reviewer_vision_cache WHERE project_id = ? AND finding_id = ? AND source_sig = ?",
    [projectId, findingId, sig],
  );
  if (!row) return null;
  try {
    return JSON.parse(row.verdict) as ReviewerVisionVerdict;
  } catch {
    return null;
  }
}

function writeCache(db: AppDb, projectId: string, findingId: string, sig: string, verdict: ReviewerVisionVerdict): void {
  db.run(
    `INSERT INTO reviewer_vision_cache (project_id, finding_id, source_sig, verdict, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, finding_id, source_sig) DO UPDATE SET verdict = excluded.verdict, created_at = excluded.created_at`,
    [projectId, findingId, sig, JSON.stringify(verdict), nowIso()],
  );
}

// Findings worth a vision look: any warning/blocker on a plan-set topic. We run
// vision even when text evidence is already "verified" — a code rule (e.g. the
// 705.12 load-side calc) raises a warning regardless of whether the SLD was
// found, so "verified text" doesn't mean the SPECIFIC required items are on the
// sheet. Vision confirms the items and can relax the warning. (We never escalate.)
function needsVision(finding: ReviewerFinding): EvidenceTopic | null {
  if (finding.severity !== "warning" && finding.severity !== "blocker") return null;
  const topic = topicForFinding(finding);
  if (!topic || !PLAN_TOPICS.has(topic)) return null;
  return topic;
}

function visionPrompt(finding: ReviewerFinding): string {
  const items = (finding.evidenceNeeded || []).slice(0, 8).map((x) => `- ${x}`).join("\n");
  return `You are a solar plan reviewer inspecting a single sheet from a residential PV permit plan set (image attached).

The automated text parser could not confirm the following item on this project, so it raised:
"${finding.title}" — ${finding.cityFeedback || finding.message}

Look at the sheet image and determine whether it actually SHOWS the required information below:
${items || "- The information described in the finding above."}

Read tables, one-line/3-line diagrams, schedules, calc blocks, and notes carefully — the data is often in a small calc box or schedule (e.g. "BUS BAR RATING x 120% = 200 + 70A", "225A x 120%", "MAIN BREAKER 200A", "PV OCPD 70A").

Judge whether the SUBSTANTIVE required information is present:
- Set present=true if the sheet shows the core required values (e.g. the bus rating, main breaker, and PV/OCPD ratings and the interconnection math), EVEN IF one minor sub-item (like an explicit "opposite-end" note) is not separately labeled — list that minor gap in "missing".
- Set present=false only if the core required information is genuinely absent from this sheet.

Return ONLY JSON:
{
  "present": true|false,
  "confidence": "high"|"medium"|"low",
  "observed": "<exactly what you see that satisfies the item, citing the actual values/labels on the sheet>",
  "missing": "<any minor item not separately shown, or empty string if nothing>"
}`;
}

async function verifyOne(
  llm: LLMProvider,
  pdfPath: string,
  pages: string[],
  finding: ReviewerFinding,
  topic: EvidenceTopic,
): Promise<ReviewerVisionVerdict> {
  const ev = finding.evidenceFound?.[0];
  const hint = ev?.pageHint || "";
  const excerpt = ev?.excerpt || "";
  const page = selectPageForTopic(pages, topic, hint, excerpt) || 1;
  let base64: string;
  try {
    const png = await renderPdfPageToPng(pdfPath, page);
    base64 = png.toString("base64");
  } catch {
    return { checked: false, present: false, confidence: "low", page, observed: "", note: "Could not render the plan-set page for vision." };
  }
  let raw: Record<string, unknown>;
  try {
    raw = await llm.visionExtract({ imageBase64: base64, mimeType: "image/png", prompt: visionPrompt(finding) });
  } catch (err) {
    return { checked: false, present: false, confidence: "low", page, observed: "", note: `Vision call failed: ${(err as Error).message || String(err)}` };
  }
  const present = raw.present === true;
  const confidence = raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low" ? raw.confidence : "low";
  const observed = typeof raw.observed === "string" ? raw.observed : "";
  const missing = typeof raw.missing === "string" ? raw.missing : "";
  const note = present
    ? `Vision confirmed on sheet page ${page}: ${observed}`.trim()
    : `Vision could not confirm on sheet page ${page}.${missing ? ` Missing: ${missing}` : ""}${observed ? ` Saw: ${observed}` : ""}`.trim();
  return { checked: true, present, confidence, page, observed, note };
}

// Apply a verdict to a finding: vision confirmation upgrades the evidence status
// and relaxes a text-only WARNING to a non-blocking callout (never the reverse).
function applyVerdict(finding: ReviewerFinding, verdict: ReviewerVisionVerdict): ReviewerFinding {
  // The verdict is rendered once as the finding's "Vision-verified" banner
  // (visionVerification). Do NOT also push it into evidenceFound — that printed
  // the same observation twice in each finding.
  const out: ReviewerFinding = { ...finding, visionVerification: verdict };
  if (verdict.checked && verdict.present && (verdict.confidence === "high" || verdict.confidence === "medium")) {
    out.evidenceStatus = "verified";
    // Relax a purely text-derived warning — the data IS on the sheet. Keep it as
    // a visible callout so the human still sees it, but it no longer blocks.
    if (finding.severity === "warning") out.severity = "callout";
    out.designTeamAction = `Vision-verified on the plan set (page ${verdict.page}). ${finding.designTeamAction}`;
  }
  return out;
}

// Opt-in vision pass over an already-built reviewer report. Returns a new report
// with vision-annotated findings (and recomputed installerCallouts). Safe no-op
// when there is no plan set or no LLM configured.
export async function applyVisionToReviewerReport(
  db: AppDb,
  llm: LLMProvider,
  report: ReviewerReport,
  opts: { cacheOnly?: boolean } = {},
): Promise<ReviewerReport> {
  const pdfPath = findPlanSetPdf(db, report.projectId);
  if (!pdfPath) return report;
  // Without a real LLM, the stub returns present:false for everything — that would
  // add misleading "could not confirm" cards. Only apply previously-cached verdicts.
  const stub = llm instanceof StubLLMProvider;
  if (stub && !opts.cacheOnly) opts = { ...opts, cacheOnly: true };
  let pages: string[];
  try {
    pages = await extractPdfPages(pdfPath, 60);
  } catch {
    return report;
  }
  const sig = sourceSig(pdfPath);

  let budget = opts.cacheOnly ? 0 : MAX_VISION_CHECKS;
  const findings: ReviewerFinding[] = [];
  for (const finding of report.findings) {
    const topic = needsVision(finding);
    if (!topic) {
      findings.push(finding);
      continue;
    }
    const cached = readCache(db, report.projectId, finding.id, sig);
    let verdict = cached;
    if (!verdict && budget > 0) {
      budget -= 1;
      verdict = await verifyOne(llm, pdfPath, pages, finding, topic);
      if (verdict.checked) writeCache(db, report.projectId, finding.id, sig, verdict);
    }
    findings.push(verdict ? applyVerdict(finding, verdict) : finding);
  }

  return {
    ...report,
    findings,
    installerCallouts: findings.filter((item) => item.installerCallout),
  };
}
