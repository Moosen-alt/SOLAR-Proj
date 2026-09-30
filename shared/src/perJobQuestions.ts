// A PER-JOB QUESTION IS NEVER ANSWERED FROM A RECIPE LITERAL OR A PLANNER GUESS — ONE PREDICATE.
//
// Portals ask questions whose answer belongs to THIS job and that no document states: who owns the
// system (customer-owned / third-party / lease / PPA), whether it is behind the meter or community
// solar, whether the disconnect sits within the required distance of the meter. The production dry
// run of 2026-09-28 (B2) watched the NEM learn answer PacifiCorp's "Will the System be Customer-Owned
// or Third-Party Owned?" with "Customer-Owned" — a planner GUESS (the project's ownership was never
// answered, the prompt says a required dropdown MUST be answered), frozen by the save-time binder as
// a "portal-specific literal" into a SHARED, trusted recipe that then replays it on every PacifiCorp
// job, lease and PPA included. The question bank (backend portalQuestionBank) already classified the
// question as per-job; nothing that FILES asked the bank.
//
// So the question is asked in ONE place, here, by every door:
//   - the question bank classifies with PER_JOB_QUESTION_RULES (its per-job half);
//   - the save-time binder (portalRecipes.convertLiteralsToBoundFields) binds such a control to its
//     per-job key and drops the literal;
//   - the replay binder (recipeReplayBinding R10) rebinds an EXISTING recipe's frozen literal;
//   - the learn / gap-fill planner (autoLearn.buildPortalPlanner) files the job's own answer, or
//     leaves the box blank for a person — never its pick;
//   - staging (repository.prepareSubmission) stops BEFORE a browser opens when the recipe asks one
//     the job has not answered, naming the question (intake / the portal-questions panel answers it).
//
// THE ACTION FIRES ONLY FOR A PERSON-ANSWERED KEY, AND ONLY IN THAT KEY'S VOCABULARY. The table below
// is every per-job rule the bank knows, but most of their keys are PLAN-SET facts the resolver fills
// in the project's own words (hasBattery, mountType, azimuth...). Binding a control to one of those
// by its label alone breaks the portal's vocabulary: measured on the live PacifiCorp recipe, "Will
// you be participating in the Wattsmart Battery Program?" = "No, I will not be participating" would
// become hasBattery ("No") and "System Mounting Method" = "Roof Mounting" would become mountType —
// both then match no option on replay, a blank and a new stop on a recipe that works. Those stay as
// the bank's findings (the fleet audit lists them). The keys ONLY A PERSON answers — the v17 answer
// columns — are the ones whose recorded answer is always one job's, and whose portal wording the
// resolver already renders ("Customer-Owned", "Behind the Meter", "Yes").
//
// Pure: no imports, so backend (bank, binders, planner, staging) and portal-bot can share it.

export interface PerJobQuestionRule {
  id: string;
  re: RegExp;
  /** The project field the answer binds to (null = no key yet: a human classifies it once). */
  binding: string | null;
  why: string;
}

/** THE disconnect-to-meter distance question ("Is your disconnect within 10 feet of the utility
 *  meter?", "Are the AC disconnect(s) … within the state's required distance of the meter?"). */
export const DISCONNECT_DISTANCE_QUESTION = /disconnect[^?]{0,80}\bwithin\s*(?:10|ten)\b|disconnect[^?]{0,80}\bwithin\s+(?:the\s+)?(?:state'?s?\s+)?required\s+distance|\bwithin\s*(?:10|ten)\s*(?:feet|ft)\b[^?]{0,60}\bdisconnect/i;

/**
 * Every PER-JOB rule of the question bank, in the bank's order (first match wins, and per-job rules
 * run before every portal-constant rule — misreading a per-job question as a constant files a
 * silently wrong answer; the reverse only asks a needless question).
 */
export const PER_JOB_QUESTION_RULES: PerJobQuestionRule[] = [
  { id: "per-job:ownership", re: /customer.?owned|third.?party|owner\s?ship|financ|\bleas(e|ed|ing)\b|\bppa\b|power\s?purchase/i,
    binding: "ownershipModel", why: "ownership/financing is a per-job fact" },
  // Grown from the adversarial rewording sweep (2026-09-11): "System owner" / "Who owns the
  // system?" / "Owner of generating facility" fell to unknown. NARROW on purpose: the owner must be
  // OF THE SYSTEM/facility/generation — "Property Owner Name" is an identity field, not financing.
  { id: "per-job:system-owner", re: /\bsystem\s?owner\b|who\s+owns\s+the\s+(system|generat|facility)|owner\s+of\s+(the\s+)?(system|generat\w*|facility)/i,
    binding: "ownershipModel", why: "who owns the system is the same per-job financing fact" },
  { id: "per-job:configuration", re: /community\s?solar|behind.?the.?meter|collectively\s?owned/i,
    binding: "systemConfiguration", why: "program/configuration is a per-job fact" },
  { id: "per-job:storage", re: /batter|energy\s?storage|\bess\b|powerwall|backup\s?power/i,
    binding: "hasBattery", why: "storage presence varies by project" },
  { id: "per-job:export-limit", re: /export\s?limit|non.?export|limited\s?export/i,
    binding: "exportLimiting", why: "export mode varies by project" },
  { id: "per-job:mounting", re: /mount(ing)?\s?(method|type)|ground.?mount/i,
    binding: "mountType", why: "mounting varies by project" },
  { id: "per-job:tilt", re: /\btilt\b/i,
    binding: "tilt", why: "array tilt comes from the plan set" },
  { id: "per-job:azimuth", re: /azimuth|\borientation\b/i,
    binding: "azimuth", why: "array azimuth comes from the plan set" },
  { id: "per-job:meter-location", re: /meter\s(located|location|access)|located inside/i,
    binding: "meterLocation", why: "meter siting varies by site" },
  { id: "per-job:meter-device", re: /meter.?(mounted.?device|collar)|\bmmd\b/i,
    binding: null, why: "a meter collar / meter-mounted device is installed per job" },
  // Per-job in principle, but the operator has a STANDING answer for it ("Yes" — the standard
  // residential detail always places the lockable AC disconnect within the required distance).
  // That standing answer lives as data in OPERATOR_POLICY_ANSWERS (intakeRequests.ts); it stays
  // per-job HERE so a project that genuinely differs can still record its own answer and win.
  { id: "per-job:disconnect-10ft", re: DISCONNECT_DISTANCE_QUESTION,
    binding: "disconnectWithin10ft",
    why: "disconnect placement is a site fact — settled for this operator by a standing policy answer, overridable per project" },
  { id: "per-job:connection-side", re: /line\s(or|\/)\s?load.?side|(line|load).?side of the main/i,
    binding: null, why: "point of connection comes from the electrical design" },
];

/** The per-job keys ONLY A PERSON answers (intake / the portal-questions panel — never a document):
 *  the v17 answer columns. The binders and the stage gate act on these keys only. */
export const PER_JOB_ANSWER_KEYS = ["ownershipModel", "systemConfiguration", "disconnectWithin10ft"] as const;
export type PerJobAnswerKey = typeof PER_JOB_ANSWER_KEYS[number];
export function isPerJobAnswerKey(key: unknown): key is PerJobAnswerKey {
  return (PER_JOB_ANSWER_KEYS as readonly string[]).includes(String(key ?? ""));
}

/** How an answer to each person-answered key is worded (separators and case ignored). A recorded
 *  answer — or a dropdown whose options — outside it means the control asks something the key
 *  cannot answer ("Is the system leased?" = "No"), and the rule does not act on it. */
const ANSWER_VOCABULARY: Record<PerJobAnswerKey, RegExp> = {
  ownershipModel: /^(?:(?:customer|host|homeowner|home owner|owner|self|utility customer) owned|third party(?: owned)?|third party (?:lease|ppa)|(?:lease|leased|ppa|power purchase(?: agreement)?|purchase|purchased|cash|loan|financed))$/,
  systemConfiguration: /^(?:behind the meter|community solar|stand ?alone)$/,
  disconnectWithin10ft: /^(?:yes|no|y|n|true|false)$/,
};
const vocabNorm = (s: string): string => String(s ?? "").toLowerCase().replace(/[\s_\-–—/]+/g, " ").replace(/[.:]+$/, "").trim();
/** A dropdown's placeholder ("-- Select --", "Please choose…") is not an answer. */
const PLACEHOLDER_OPTION = /^(?:[-–—\s]*(?:please\s+)?(?:select|choose|pick)\b.*|[-–—\s]*|none selected|n\/?a)$/i;

/** The first per-job rule whose words the control's text carries, or null. */
export function perJobRuleFor(text: string): PerJobQuestionRule | null {
  const t = String(text ?? "");
  return PER_JOB_QUESTION_RULES.find((r) => r.re.test(t)) ?? null;
}

/** The text a recorded step's question is read from — the same string at every door. */
export function perJobQuestionText(step: { selector?: { label?: string } | null; note?: string | null }): string {
  return `${step.selector?.label ?? ""} ${step.note ?? ""}`.trim();
}

/**
 * WHAT KIND OF CONTROL ASKS THE QUESTION — a dropdown ("select"), a radio / choice group or a custom
 * picker that offers options ("choice"), or a free-text box ("text"). Every door says which; null
 * (a checkbox, a button, anything else) never binds.
 */
export type PerJobControl = "select" | "choice" | "text";

/** A recorded step's control: a `select` step is a dropdown, a `fill` step a text box. */
export function perJobControlOfStep(step: { action?: string | null }): PerJobControl | null {
  if (step.action === "select") return "select";
  if (step.action === "fill") return "text";
  return null;
}

/** A learn page's field (autoLearnAdapter's fieldType): a custom "other" control that offers
 *  options is a choice; one that offers none is typed into, like a text box. */
export function perJobControlOfField(field: { fieldType?: string | null; options?: unknown[] | null }): PerJobControl | null {
  const t = String(field.fieldType ?? "");
  if (t === "select") return "select";
  if (t === "radio") return "choice";
  if (t === "text") return "text";
  if (t === "other") return Array.isArray(field.options) && field.options.length ? "choice" : "text";
  return null;
}

/** The evidence a RECORDED step carries (its control, its frozen answer, and the option list a
 *  recorder stored beside it, when it did) — the save-time and replay binders read the same. */
export function perJobStepEvidence(step: { action?: string | null; value?: string | null }): PerJobEvidence {
  const raw = (step as { options?: unknown }).options;
  return {
    control: perJobControlOfStep(step),
    answer: String(step.value ?? ""),
    options: Array.isArray(raw) ? raw.map((o) => String(o ?? "")) : null,
  };
}

export interface PerJobEvidence {
  control: PerJobControl | null;
  answer?: string | null;
  options?: Array<string | null | undefined> | null;
}

/** THE OWNERSHIP MODEL IS ABOUT THE SYSTEM: its wording must speak of owning / financing / leasing
 *  it ("Will the System be Customer-Owned or Third-Party Owned?", "Who owns the system?", "Ownership
 *  type", "Is the system leased or owned?") — "Applicant is a third party?" asks about a PERSON. */
const OWNERSHIP_SUBJECT = /\bown(?:ed|er|ers|ership|s)?\b|financ|\bleas(?:e|ed|ing)\b|\bppa\b|power\s?purchase/i;
/** ...and never an identity / contact box for the owner, the financier or the applicant ("Third
 *  Party Owner Company Name", "Name of financing company", "Leasing company name", "Applicant ..."). */
const NOT_THE_OWNERSHIP_MODEL = /\bnames?\b|\baddress\b|\bphone\b|\be-?mail\b|\bcontact\b|\bapplicant\b|\bsubmitter\b|\brequest[eo]r\b|\bagent\b|\brepresentative\b/i;

/**
 * THE ONE PREDICATE: the person-answered per-job key this control asks for, or null.
 *
 * `text` is the control's own wording. The rule acts only when the WINNING per-job rule binds to a
 * person-answered key AND the evidence speaks that key's vocabulary:
 *   - the CONTROL must be named (a checkbox / button / unknown control never binds);
 *   - the ownership model binds only a dropdown or choice group — never a free-text box (a name box
 *     would be typed "PPA") — and only when the question is about the SYSTEM's ownership;
 *   - a recorded / planned answer that is not blank must be one of the key's words;
 *   - a BLANK answer is accepted only on a dropdown / choice group (a blank frozen into a per-job
 *     select still belongs to the job) — a blank text box is evidence of nothing;
 *   - a control's options (placeholders aside) must offer at least one of the key's words.
 */
export function perJobAnswerKeyFor(text: string, evidence: PerJobEvidence): PerJobAnswerKey | null {
  const rule = perJobRuleFor(text);
  if (!rule || !isPerJobAnswerKey(rule.binding)) return null;
  const key = rule.binding;
  const control = evidence?.control ?? null;
  if (!control) return null;
  if (key === "ownershipModel") {
    if (control === "text") return null;
    const t = String(text ?? "");
    if (!OWNERSHIP_SUBJECT.test(t) || NOT_THE_OWNERSHIP_MODEL.test(t)) return null;
  }
  const vocab = ANSWER_VOCABULARY[key];
  const answer = vocabNorm(String(evidence.answer ?? ""));
  if (answer && !vocab.test(answer)) return null;
  if (!answer && control === "text") return null;
  const options = (evidence.options ?? []).map((o) => String(o ?? "").trim()).filter((o) => o && !PLACEHOLDER_OPTION.test(o));
  if (options.length && !options.some((o) => vocab.test(vocabNorm(o)))) return null;
  return key;
}
