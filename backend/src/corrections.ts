import type { CorrectionBucket, ProjectRecord } from "../../shared/src/types";

export interface CorrectionClassification {
  bucket: CorrectionBucket;
  rootCause: string;
  requiredAction: string;
  assignedTo: string;
  draftResponse: string;
  newRuleRecommended: boolean;
}

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
      assignedTo: "designer",
      draftResponse: "",
      newRuleRecommended: true,
    };
  }

  if (mentionsAutopilotFix) {
    return {
      bucket: "A_we_fix",
      rootCause: "Submission data, document, or portal packaging issue",
      requiredAction: "Verify project data and uploaded files, then prepare a corrected resubmittal for human approval.",
      assignedTo: "autopilot_operator",
      draftResponse: "",
      newRuleRecommended: /account|meter|missing document|file name/.test(text),
    };
  }

  return {
    bucket: mentionsReviewerQuestion ? "C_reviewer_clarification" : "C_reviewer_clarification",
    rootCause: mentionsReviewerQuestion ? "Reviewer clarification request" : "Unclassified correction",
    requiredAction: `Review the correction against ${project?.projectAddress || "the project"} and decide the response path.`,
    assignedTo: "human_reviewer",
    draftResponse: "",
    newRuleRecommended: false,
  };
}

