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
import type { AgentToolDef, CorrectionBucket, ProjectRecord } from "../../shared/src/types";
import { createLLMProvider } from "./llm";
import { getProjectDetail } from "./repository";
import { designNotesDigest } from "./autoLearn";
import { humanizeBucket } from "./corrections";
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

function persistTriage(
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
  const payload = JSON.stringify({
    correctionId: input.correctionId,
    bucket: t.bucket,
    proposals: t.proposals,
    actions: t.actions,
    generatedAt: ts,
  });
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
  if (linked.length === 1) db.run(
    "UPDATE human_review_items SET llm_suggested_value = ?, notes = ?, updated_at = ? WHERE id = ?",
    [t.requiredAction || "", `agent-triage:${payload}`, ts, linked[0].id]);

  addAuditLog(db, input.projectId, "system", "correction agent", "correction.agent_triaged", {
    correctionId: input.correctionId,
    bucket: t.bucket,
    proposalCount: t.proposals.length,
  });
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
export function parseCorrectionProposals(notes: string): { correctionId?: string; proposals: CorrectionDataProposal[]; actions: string[]; bucket?: string } | null {
  const m = notes.match(/^agent-triage:(\{[\s\S]*\})$/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.proposals) || !Array.isArray(parsed.actions)) return null;
    return { correctionId: typeof parsed.correctionId === "string" ? parsed.correctionId : undefined,
      proposals: parsed.proposals.filter((p: CorrectionDataProposal) => p && typeof p.field === "string" && typeof p.proposedValue === "string"),
      actions: parsed.actions.filter((a: unknown) => typeof a === "string"), bucket: parsed.bucket };
  } catch {
    return null;
  }
}
