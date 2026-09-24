// ---------------------------------------------------------------------------
// Correction-handling agent — reads an AHJ/utility correction (rejection letter,
// portal comment, monitor-detected status), and produces: a refined bucket +
// root cause + required action, concrete data-update PROPOSALS (never applied
// directly), a draft reply, and an action checklist. Everything the agent
// produces is advisory: proposals land in the linked human-review item's notes
// and the correction's draft_response; the operator approves via the
// /corrections/:id/apply + /resolve endpoints (see repository.ts). Stub mode (no
// API key) is a no-op — the deterministic regex classifier in corrections.ts
// remains the baseline.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { AgentToolDef, CorrectionBucket, JurisdictionCriteriaProposal, ProjectDetail, ProjectRecord } from "../../shared/src/types";
import { createLLMProvider } from "./llm";
import { getProjectDetail, applyCorrectionProposals } from "./repository";
import { designNotesDigest } from "./autoLearn";
import { humanizeBucket } from "./corrections";
import { relearnCorrection, isLearningExcluded } from "./knowledgeBase";
import { extractAhjRequiredCriteria } from "./designCriteria";
import { ahjLooksLikeHostname, applyCorrectionCriterionToProfile, currentCriterionOnFile, sameCriterionValue } from "./codeProfiles";
import { listProjectDocuments } from "./projectDocuments";
import { addAuditLog } from "./audit";
import { logger } from "./logger";
import { nowIso } from "./time";

const BUCKETS: CorrectionBucket[] = ["A_we_fix", "B_designer_fix", "C_reviewer_clarification"];

export interface CorrectionDataProposal {
  field: string;
  currentValue: string;
  proposedValue: string;
  basis: string;
}

export interface CorrectionTriage {
  provider: "claude" | "stub";
  bucket?: CorrectionBucket;
  rootCause?: string;
  requiredAction?: string;
  draft?: string;
  actions: string[];
  proposals: CorrectionDataProposal[];
  message: string;
}

const CORRECTION_SYSTEM = `You are triaging a correction/rejection on a residential solar permit or interconnection application. You have the correction text and the project's data + documents. Determine what actually needs to change and produce a plan a human will approve.

Use the tools to gather what you need, then finalize:
- classify_correction: set the bucket, root cause, and required action.
  - "A_we_fix": a data/document/portal packaging issue the operator can fix (wrong account/meter/address, missing or mislabeled upload, wrong field on the app).
  - "B_designer_fix": needs the design/engineering team (structural, plan-set, SLD, load calc, layout).
  - "C_reviewer_clarification": the reviewer just needs an explanation/confirmation, no change to the package.
- propose_data_update: for each project field that is wrong or missing, propose the corrected value with your basis (cite the correction text or a document). Do NOT apply changes — these are proposals a human approves.
- propose_response_draft: a short, professional reply to the reviewer, ready to edit.
- propose_actions: an ordered checklist of what the operator/designer must do.

Ground every proposal in evidence (the correction text, the project data, the design notes, the document list). If you're unsure of a corrected value, say so in the basis rather than guessing. When done, stop.`;

/** Run the correction agent for one correction row. Returns the triage result
 *  (also written to the correction row + human-review notes by the caller). */
export async function triageCorrection(
  db: AppDb,
  input: { correctionId: string; projectId: string; correctionText: string },
): Promise<CorrectionTriage> {
  const project = safeProject(db, input.projectId);
  const proposals: CorrectionDataProposal[] = [];
  const actions: string[] = [];
  let bucket: CorrectionBucket | undefined;
  let rootCause: string | undefined;
  let requiredAction: string | undefined;
  let draft: string | undefined;

  const tools: AgentToolDef[] = [
    {
      name: "get_correction",
      description: "The raw correction/rejection text under review.",
      input_schema: { type: "object", properties: {} },
      handler: () => ({ kind: "text", text: input.correctionText.slice(0, 4000) }),
    },
    {
      name: "get_project_summary",
      description: "The project's captured data (equipment, sizes, AHJ, utility, interconnection) plus a digest of design notes from the plan set.",
      input_schema: { type: "object", properties: {} },
      handler: () => ({ kind: "json", value: projectSummary(project) }),
    },
    {
      name: "get_documents_list",
      description: "The documents attached to this project (type + filename), to check whether a required document is present or mislabeled.",
      input_schema: { type: "object", properties: {} },
      handler: () => ({ kind: "json", value: documentList(db, input.projectId) }),
    },
    {
      name: "classify_correction",
      description: "Set the correction's bucket, root cause, and required action.",
      input_schema: {
        type: "object",
        properties: {
          bucket: { type: "string", enum: [...BUCKETS] },
          rootCause: { type: "string" },
          requiredAction: { type: "string" },
        },
        required: ["bucket", "rootCause", "requiredAction"],
      },
      handler: (i) => {
        bucket = (BUCKETS as string[]).includes(String(i.bucket)) ? (String(i.bucket) as CorrectionBucket) : "A_we_fix";
        rootCause = String(i.rootCause || "").slice(0, 400);
        requiredAction = String(i.requiredAction || "").slice(0, 400);
        return { kind: "text", text: "classified" };
      },
    },
    {
      name: "propose_data_update",
      description: "Propose a corrected value for one project field. Advisory — never applied without human approval.",
      input_schema: {
        type: "object",
        properties: {
          field: { type: "string" },
          currentValue: { type: "string" },
          proposedValue: { type: "string" },
          basis: { type: "string" },
        },
        required: ["field", "proposedValue", "basis"],
      },
      handler: (i) => {
        proposals.push({
          field: String(i.field || "").slice(0, 60),
          currentValue: String(i.currentValue || "").slice(0, 120),
          proposedValue: String(i.proposedValue || "").slice(0, 120),
          basis: String(i.basis || "").slice(0, 300),
        });
        return { kind: "text", text: "proposed" };
      },
    },
    {
      name: "propose_response_draft",
      description: "A short reply to the reviewer, ready for a human to edit and send.",
      input_schema: { type: "object", properties: { draft: { type: "string" } }, required: ["draft"] },
      handler: (i) => { draft = String(i.draft || "").slice(0, 2000); return { kind: "text", text: "drafted" }; },
    },
    {
      name: "propose_actions",
      description: "An ordered checklist of what must be done to resolve this correction.",
      input_schema: { type: "object", properties: { checklist: { type: "array", items: { type: "string" } } }, required: ["checklist"] },
      handler: (i) => {
        const list = Array.isArray(i.checklist) ? (i.checklist as unknown[]).map((s) => String(s).slice(0, 200)) : [];
        actions.push(...list.slice(0, 12));
        return { kind: "text", text: "noted" };
      },
    },
  ];

  const llm = createLLMProvider();
  const run = await llm.runToolAgent({
    label: "correctionTriage",
    system: CORRECTION_SYSTEM,
    user: `A correction has been received for this project. Triage it.\n\nCORRECTION:\n${input.correctionText.slice(0, 4000)}`,
    tools,
    maxIterations: 8,
    effort: "medium",
  });

  if (run.provider === "stub") {
    return { provider: "stub", actions: [], proposals: [], message: "Correction triage skipped — no ANTHROPIC_API_KEY (stub mode)." };
  }

  persistTriage(db, input, { bucket, rootCause, requiredAction, draft, actions, proposals });
  logger.info("correction-agent", "triaged correction", { correctionId: input.correctionId, bucket, proposals: proposals.length });
  return {
    provider: "claude",
    bucket, rootCause, requiredAction, draft, actions, proposals,
    message: `Correction triaged (${bucket ? humanizeBucket(bucket) : "unclassified"}); ${proposals.length} data proposal(s).`,
  };
}

// ---- persistence ----------------------------------------------------------

export function persistTriage(
  db: AppDb,
  input: { correctionId: string; projectId: string },
  t: { bucket?: CorrectionBucket; rootCause?: string; requiredAction?: string; draft?: string; actions: string[]; proposals: CorrectionDataProposal[] },
): void {
  const ts = nowIso();
  // Upgrade the correction row's classification + draft (only fields the agent set).
  const sets: string[] = [];
  const args: string[] = [];
  if (t.bucket) { sets.push("correction_bucket = ?"); args.push(t.bucket); }
  if (t.rootCause) { sets.push("root_cause = ?"); args.push(t.rootCause); }
  if (t.requiredAction) { sets.push("required_action = ?"); args.push(t.requiredAction); }
  if (t.draft) { sets.push("draft_response = ?"); args.push(t.draft); }
  if (sets.length) {
    db.run(`UPDATE corrections SET ${sets.join(", ")} WHERE id = ?`, [...args, input.correctionId]);
  }

  // Store proposals + checklist in the linked correction review item's notes (JSON
  // payload the endpoint reads back on apply). Match the correction identity;
  // another correction may have arrived while the model was running.
  const items = db.query<{ id: string; notes: string; source_excerpt: string }>(
    "SELECT id, notes, source_excerpt FROM human_review_items WHERE project_id = ? AND field_name = 'correction' AND status = 'pending'", [input.projectId]);
  let linked = items.filter(item => parseCorrectionProposals(item.notes)?.correctionId === input.correctionId);
  if (!linked.length) {
    // Legacy review items predate the identity field. A unique exact excerpt
    // match can migrate one; recency alone cannot associate two corrections.
    const correction = db.get<{ correction_text: string }>("SELECT correction_text FROM corrections WHERE id = ? AND project_id = ?", [input.correctionId, input.projectId]);
    if (correction?.correction_text) linked = items.filter(item => !parseCorrectionProposals(item.notes)?.correctionId
      && item.source_excerpt === correction.correction_text.slice(0, 800));
  }
  if (linked.length !== 1) throw new Error("Correction triage could not identify one pending review item; proposals were not attached to another correction.");
  // The deterministic JURISDICTION proposals ride along: this rewrite of the notes must not
  // drop what intake attached (or whatever a human already applied from them).
  const jurisdictionProposals = parseCorrectionProposals(linked[0].notes)?.jurisdictionProposals?.length
    ? parseCorrectionProposals(linked[0].notes)!.jurisdictionProposals
    : buildJurisdictionProposals(db, input.correctionId);
  const payload = JSON.stringify({
    correctionId: input.correctionId,
    bucket: t.bucket,
    proposals: t.proposals,
    actions: t.actions,
    ...(jurisdictionProposals.length ? { jurisdictionProposals } : {}),
    generatedAt: ts,
  });
  if (linked.length === 1) db.run(
    "UPDATE human_review_items SET llm_suggested_value = ?, notes = ?, updated_at = ? WHERE id = ?",
    [t.requiredAction || "", `agent-triage:${payload}`, ts, linked[0].id]);

  addAuditLog(db, input.projectId, "system", "correction agent", "correction.agent_triaged", {
    correctionId: input.correctionId,
    bucket: t.bucket,
    proposalCount: t.proposals.length,
  });

  // LEARN FROM THE TRIAGE, NOT THE REGEX (L4). Intake learned the regex classifier's guess; the
  // corrections row now holds the agent's bucket / root cause / action, so the learned failure
  // row is replaced from it — or removed, when the agent says the reviewer only asked a question.
  relearnCorrection(db, input.correctionId);
}

// ---- helpers --------------------------------------------------------------

function safeProject(db: AppDb, projectId: string): ProjectRecord | null {
  try { return getProjectDetail(db, projectId).project; } catch { return null; }
}

function documentList(db: AppDb, projectId: string): Array<{ docType: string; filename: string }> {
  try {
    return listProjectDocuments(db, projectId).map((d) => ({ docType: d.docType, filename: d.originalFilename }));
  } catch {
    return [];
  }
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
    accountNumberPresent: Boolean(project.accountNumber),
    meterNumberPresent: Boolean(project.meterNumber),
    systemSizeDcKw: project.systemSizeDcKw,
    systemSizeAcKw: project.systemSizeAcKw,
    interconnectionMethod: project.interconnectionMethod,
    inverterMake: pick("inverterManufacturer") || pick("inverterMake"),
    inverterModel: pick("invModel") || pick("inverterModel") || pick("pvMicroModel"),
    moduleMake: pick("moduleManufacturer") || pick("moduleMake"),
    moduleModel: pick("moduleModel"),
    designNotes: designNotesDigest(project, 2000),
  };
}

/** Parse the agent-triage payload stored in a correction review item's notes. */
export function parseCorrectionProposals(notes: string): {
  correctionId?: string; proposals: CorrectionDataProposal[]; actions: string[]; bucket?: string;
  jurisdictionProposals: JurisdictionCriteriaProposal[];
} | null {
  const m = notes.match(/^agent-triage:(\{[\s\S]*\})$/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.proposals) || !Array.isArray(parsed.actions)) return null;
    return { correctionId: typeof parsed.correctionId === "string" ? parsed.correctionId : undefined,
      proposals: parsed.proposals.filter((p: CorrectionDataProposal) => p && typeof p.field === "string" && typeof p.proposedValue === "string"),
      actions: parsed.actions.filter((a: unknown) => typeof a === "string"), bucket: parsed.bucket,
      // A SEPARATE list, never mixed into `proposals`: applyCorrectionProposals writes every
      // entry of that one into the project's snapshot, and a jurisdiction value is not a
      // project field.
      jurisdictionProposals: Array.isArray(parsed.jurisdictionProposals)
        ? parsed.jurisdictionProposals.filter((p: JurisdictionCriteriaProposal) => p && p.kind === "jurisdiction_design_criteria"
          && typeof p.id === "string" && typeof p.criterion === "string" && typeof p.state === "string" && typeof p.ahj === "string")
        : [] };
  } catch {
    return null;
  }
}

// ---- jurisdiction proposals (AHJ comment -> the AHJ's code profile) -------------
//
// EVERY PROJECT TEACHES THE JURISDICTION — SAFELY. When an AHJ's correction states a design
// requirement ("Ground snow load 36 psf", "minimum wind speed design is 120 MPH Ultimate
// Exposure D", "mounting spacing should be 2' oc"), that is the jurisdiction telling us its
// rule. It is extracted deterministically (no LLM) and attached to the correction's review
// item as a PROPOSAL against the AHJ's code profile, beside the project-field proposals. It
// is applied only by a human (POST /api/corrections/:id/apply, hard rule 4), lands as
// "seeded" with a citation to the comment, and never touches a verified row (hard rule 3).

type Row = Record<string, unknown>;
const txt = (v: unknown): string => (v == null ? "" : String(v));

/** Which jurisdiction a correction speaks for, and its record number. A monitor correction is
 *  tied to the target it was read on (its jurisdiction, its application/permit number); a
 *  utility (NEM) target's correction never teaches a building jurisdiction (hard rule 5). */
function correctionOrigin(db: AppDb, correctionId: string, projectId: string, projectAhj: string, correctionText: string): { ahj: string; recordNumber: string; utility: boolean } {
  const fromText = correctionText.match(/\b(?:record|permit|application|case)\s*(?:#|no\.?|number)?\s*:?\s*([A-Z0-9]{2,}(?:-[A-Z0-9]+){1,5})\b/i)?.[1] ?? "";
  // The monitor inserts its correction BEFORE the status-check row that links it, so at intake
  // the target is found by the record number the page printed, matched against the project's
  // own targets; a later re-attach finds it through the check row.
  const target = db.get<Row>(
    `SELECT c.application_number, c.permit_number, t.target_type, t.jurisdiction
       FROM permit_status_checks c LEFT JOIN permit_check_targets t ON t.id = c.target_id
      WHERE c.correction_id = ? ORDER BY c.rowid DESC LIMIT 1`, [correctionId])
    ?? (fromText
      ? db.get<Row>(
        `SELECT application_number, permit_number, target_type, jurisdiction FROM permit_check_targets
          WHERE project_id = ? AND (UPPER(application_number) = UPPER(?) OR UPPER(permit_number) = UPPER(?)) LIMIT 1`,
        [projectId, fromText, fromText])
      : undefined);
  const recordNumber = txt(target?.permit_number) || txt(target?.application_number) || fromText;
  const utility = txt(target?.target_type) === "nem";
  return { ahj: txt(target?.jurisdiction).trim() || projectAhj, recordNumber: recordNumber.slice(0, 60), utility };
}

/** The jurisdiction proposals a correction's text supports, each with the AHJ's current value. */
export function buildJurisdictionProposals(db: AppDb, correctionId: string): JurisdictionCriteriaProposal[] {
  const c = db.get<Row>("SELECT project_id, source, correction_text, created_at FROM corrections WHERE id = ?", [correctionId]);
  if (!c) return [];
  const projectId = txt(c.project_id);
  const project = db.get<Row>("SELECT state, ahj FROM projects WHERE id = ?", [projectId]);
  const state = txt(project?.state).trim();
  if (!state || /utility/i.test(txt(c.source)) || isLearningExcluded(db, projectId)) return [];
  const required = extractAhjRequiredCriteria(txt(c.correction_text));
  if (!required.length) return [];
  const origin = correctionOrigin(db, correctionId, projectId, txt(project?.ahj).trim(), txt(c.correction_text));
  if (origin.utility || !origin.ahj || ahjLooksLikeHostname(origin.ahj)) return [];
  return required.map((r) => {
    const onFile = currentCriterionOnFile(db, state, origin.ahj, r.block, r.criterion);
    const status: JurisdictionCriteriaProposal["status"] = onFile.confidence === "verified"
      ? "blocked_verified"
      : sameCriterionValue(onFile.value, r.value) ? "same_as_current" : "proposed";
    return {
      kind: "jurisdiction_design_criteria",
      id: `jurisdiction:${r.criterion}`,
      ahj: origin.ahj,
      state,
      profileKey: onFile.profileKey,
      block: r.block,
      criterion: r.criterion,
      value: r.value,
      currentValue: onFile.value,
      currentConfidence: onFile.confidence,
      basis: r.basis,
      source: { correctionId, recordNumber: origin.recordNumber, receivedAt: txt(c.created_at) },
      status,
      ...(status === "blocked_verified" ? { statusNote: "The jurisdiction's profile is human-verified; it will not be changed from a correction." } : {}),
    };
  });
}

/** The ONE linked review item for a correction (any status), with its raw payload. */
function linkedTriageItem(db: AppDb, correctionId: string, statuses: string[]): { id: string; status: string; payload: Record<string, unknown> } | null {
  const c = db.get<Row>("SELECT project_id FROM corrections WHERE id = ?", [correctionId]);
  if (!c) return null;
  const rows = db.query<Row>(
    `SELECT id, status, notes FROM human_review_items WHERE project_id = ? AND field_name = 'correction' AND status IN (${statuses.map(() => "?").join(",")})`,
    [txt(c.project_id), ...statuses],
  ).filter((r) => parseCorrectionProposals(txt(r.notes))?.correctionId === correctionId);
  if (rows.length !== 1) return null;
  try {
    return { id: txt(rows[0].id), status: txt(rows[0].status), payload: JSON.parse(txt(rows[0].notes).slice("agent-triage:".length)) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Intake hook: attach the correction's jurisdiction proposals to its review item. Idempotent;
 *  best-effort (a failure here must never lose the correction). Returns how many attached. */
export function attachJurisdictionProposals(db: AppDb, correctionId: string): number {
  try {
    const proposals = buildJurisdictionProposals(db, correctionId);
    if (!proposals.length) return 0;
    const item = linkedTriageItem(db, correctionId, ["pending"]);
    if (!item) return 0;
    db.run("UPDATE human_review_items SET notes = ? WHERE id = ?",
      [`agent-triage:${JSON.stringify({ ...item.payload, jurisdictionProposals: proposals })}`, item.id]);
    return proposals.length;
  } catch (err) {
    logger.warn("correction-agent", `jurisdiction proposals not attached: ${err instanceof Error ? err.message : String(err)}`, { correctionId });
    return 0;
  }
}

export interface JurisdictionApplyResult {
  projectId: string;
  /** Jurisdiction proposals the request selected that were still "proposed". */
  attempted: number;
  applied: Array<{ id: string; note: string }>;
  refused: Array<{ id: string; note: string }>;
  /** Does the same apply also have PROJECT work (selected field proposals / a designer wait)? */
  hasProjectWork: boolean;
}

/**
 * Apply the human-approved jurisdiction proposals of one correction. `fields` selects by id
 * ("jurisdiction:groundSnowLoadPsf"); undefined = every proposal still "proposed". Each result
 * is written back onto the proposal (status + note), so the card shows what happened and a
 * second click cannot re-apply.
 */
export function applyJurisdictionProposals(db: AppDb, correctionId: string, fields: string[] | undefined, actor: string): JurisdictionApplyResult {
  const c = db.get<Row>("SELECT project_id, closed_at, correction_bucket FROM corrections WHERE id = ?", [correctionId]);
  const projectId = txt(c?.project_id);
  const empty: JurisdictionApplyResult = { projectId, attempted: 0, applied: [], refused: [], hasProjectWork: true };
  if (!c || c.closed_at) return empty;
  const item = linkedTriageItem(db, correctionId, ["pending"]);
  if (!item) return empty;
  const parsed = parseCorrectionProposals(`agent-triage:${JSON.stringify(item.payload)}`);
  const proposals = parsed?.jurisdictionProposals ?? [];
  const selectedProject = (parsed?.proposals ?? []).filter((p) => !fields || fields.includes(p.field));
  const hasProjectWork = (!fields || fields.some((f) => !f.startsWith("jurisdiction:")))
    && (selectedProject.some((p) => p.proposedValue.trim()) || txt(c.correction_bucket) === "B_designer_fix");
  const result: JurisdictionApplyResult = { projectId, attempted: 0, applied: [], refused: [], hasProjectWork };
  for (const p of proposals) {
    if (p.status !== "proposed" || (fields && !fields.includes(p.id))) continue;
    result.attempted++;
    const r = applyCorrectionCriterionToProfile(db, p, { actor, projectId });
    p.status = r.status;
    p.statusNote = r.note;
    (r.status === "applied" ? result.applied : result.refused).push({ id: p.id, note: r.note });
  }
  if (result.attempted) {
    db.run("UPDATE human_review_items SET notes = ?, updated_at = ? WHERE id = ?",
      [`agent-triage:${JSON.stringify({ ...item.payload, jurisdictionProposals: proposals })}`, nowIso(), item.id]);
  }
  return result;
}

/**
 * THE ONE APPROVAL (POST /api/corrections/:id/apply): the correction's jurisdiction proposals,
 * then its project-field proposals / designer wait (repository.applyCorrectionProposals). When
 * the approval selected ONLY jurisdiction values and there is no project work, the project half
 * is skipped — it would refuse with 409 "no selected data updates" AFTER the jurisdiction write
 * had already happened, and report a success as a failure.
 */
export function applyCorrectionApproval(db: AppDb, correctionId: string, fields: string[] | undefined, actor: string): ProjectDetail & { jurisdictionCriteria?: JurisdictionApplyResult } {
  const jurisdiction = applyJurisdictionProposals(db, correctionId, fields, actor);
  if (jurisdiction.attempted > 0 && !jurisdiction.hasProjectWork) {
    return { ...getProjectDetail(db, jurisdiction.projectId), jurisdictionCriteria: jurisdiction };
  }
  return { ...applyCorrectionProposals(db, correctionId, fields), ...(jurisdiction.attempted ? { jurisdictionCriteria: jurisdiction } : {}) };
}
