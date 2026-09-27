import type { CorrectionBucket, ProjectRecord } from "../../shared/src/types";

export interface CorrectionClassification {
  bucket: CorrectionBucket;
  rootCause: string;
  requiredAction: string;
  assignedTo: string;
  draftResponse: string;
  newRuleRecommended: boolean;
}

// THE ONE LABEL MAP for a correction bucket — every place the bucket shows reads it: the
// backend-built timeline/notes/stage strings through humanizeBucket, and the dashboard's
// correction card through CorrectionRecord.bucketLabel (mapCorrection). Plain words: the card
// used to title-case the enum ("A We Fix").
const BUCKET_LABELS: Record<CorrectionBucket, string> = {
  A_we_fix: "We fix - operator",
  B_designer_fix: "Designer fix",
  C_reviewer_clarification: "Reviewer clarification",
};

export function humanizeBucket(bucket: string): string {
  return BUCKET_LABELS[bucket as CorrectionBucket] || String(bucket || "").replace(/_/g, " ");
}

// WHO OWNS A CORRECTION IS A FUNCTION OF ITS BUCKET — one decision, never two. The keyword
// classifier below and the correction agent's refinement (correctionAgent.persistTriage) both
// read this map, so a refined bucket carries its owner with it. Production 1fb3dc39: the agent
// moved the bucket to A_we_fix ("Not a design or plan-set deficiency") and the row still said
// `designer`, a stale keyword pick off the page chrome.
const BUCKET_ASSIGNEE: Record<CorrectionBucket, string> = {
  A_we_fix: "autopilot_operator",
  B_designer_fix: "designer",
  C_reviewer_clarification: "human_reviewer",
};

export function assigneeForBucket(bucket: CorrectionBucket): string {
  return BUCKET_ASSIGNEE[bucket] ?? "human_reviewer";
}

// Human-readable label for a snake_case enum (permit outcome, email bucket, etc.).
export function humanizeEnum(value: string | null | undefined): string {
  return String(value || "").replace(/_/g, " ");
}

// Reads THE CORRECTION — for a portal reading, what correctionExtract pulled off the page (its
// conditions / review comments), never the page chrome around it ("Residential Structural
// Record" in an Accela header made every Coos Bay correction a designer fix).
export function classifyCorrection(correctionText: string, project?: ProjectRecord): CorrectionClassification {
  const text = correctionText.toLowerCase();
  const mentionsDesign =
    /structural|engineering|stamp|rafter|truss|setback|fire|layout|module|array|plan set|single line|sld|three-line|3-line|load calc/.test(text);
  const mentionsReviewerQuestion =
    /clarify|please confirm|provide explanation|explain|question|reviewer comment|need clarification/.test(text);
  const mentionsAutopilotFix =
    /account|meter|address|homeowner|owner|utility bill|nem|interconnection|file name|upload|missing document|signature|application/.test(text);

  if (mentionsDesign) {
    return {
      bucket: "B_designer_fix",
      rootCause: "Design or plan-set issue",
      requiredAction: "Send to design/engineering, then stage corrected documents for human approval.",
      assignedTo: assigneeForBucket("B_designer_fix"),
      draftResponse: "",
      newRuleRecommended: true,
    };
  }

  if (mentionsAutopilotFix) {
    return {
      bucket: "A_we_fix",
      rootCause: "Submission data, document, or portal packaging issue",
      requiredAction: "Verify project data and uploaded files, then prepare a corrected resubmittal for human approval.",
      assignedTo: assigneeForBucket("A_we_fix"),
      draftResponse: "",
      newRuleRecommended: /account|meter|missing document|file name/.test(text),
    };
  }

  return {
    bucket: mentionsReviewerQuestion ? "C_reviewer_clarification" : "C_reviewer_clarification",
    rootCause: mentionsReviewerQuestion ? "Reviewer clarification request" : "Unclassified correction",
    requiredAction: `Review the correction against ${project?.projectAddress || "the project"} and decide the response path.`,
    assignedTo: assigneeForBucket("C_reviewer_clarification"),
    draftResponse: "",
    newRuleRecommended: false,
  };
}

