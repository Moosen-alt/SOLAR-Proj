import type { AhjProcessProfile, CodeReference, ProjectRecord, ReviewerFinding, ReviewerFindingEvidence, ReviewerReport } from "../../shared/src/types";
import { looksLikeEmail } from "../../shared/src/emailAddress";
import { evaluateDesignCodeFindings, mountKindForProject, isMlpeDesignForProject } from "./codeReviewRules";
import { pvWorksheetFindings, serviceRatingConsistencyFindings, type PvWorksheetGateInput } from "./pvWorksheetGate";
import { extractRoofPlanDimensions, type DesignTextSource } from "./designCriteria";
import { findAhjProcessProfile } from "./processProfiles";
import { findApplicationProfile } from "./applicationDocs";
import { permitProcessFor } from "./permitProcess";
import { evidenceForTopic, evidenceLines, fieldValue, requirementsForTopic, type EvidenceTopic, type ProjectEvidence } from "./projectEvidence";
import { nowIso } from "./time";
import { hasMpuScope } from "./serviceScope";
import { resolveValuation } from "./valuation";
import { knownPowerClerkUtility } from "./utilityIdentity";
import { resolvePermitPath, resolveStampRequirement, hasStampedStructuralEvidence } from "./permitPath";
import { evaluatePermitPrecedentFindings } from "./permitPrecedents";
import type { EffectiveCodeContext } from "./codeProfiles";

function payload(project: ProjectRecord, key: string): string {
  return fieldValue(project, key);
}

function finding(
  id: string,
  severity: ReviewerFinding["severity"],
  category: ReviewerFinding["category"],
  title: string,
  message: string,
  installerCallout = false,
  options: {
    cityFeedback?: string;
    designTeamAction?: string;
    evidenceNeeded?: string[];
    codeReferences?: CodeReference[];
    evidenceFound?: ReviewerFindingEvidence[];
    evidenceStatus?: ReviewerFinding["evidenceStatus"];
  } = {},
): ReviewerFinding {
  return {
    id,
    severity,
    category,
    title,
    message,
    cityFeedback: options.cityFeedback || message,
    designTeamAction: options.designTeamAction || "Verify and correct this item before staging the submittal.",
    evidenceNeeded: options.evidenceNeeded || [],
    codeReferences: options.codeReferences || [],
    installerCallout,
    evidenceStatus: options.evidenceStatus,
    evidenceFound: options.evidenceFound,
  };
}

// Reader-facing names for the evidence topics. The topic KEY (siteRoofPlan, firePathway…) is
// an internal identifier; it used to be printed as the evidence card's heading on the project
// page ("siteRoofPlan absence check").
const TOPIC_LABEL: Record<EvidenceTopic, string> = {
  accountVerification: "Utility account",
  meterPhoto: "Meter photo",
  sld: "One-line / SLD",
  siteRoofPlan: "Site / roof plan",
  firePathway: "Fire access pathways",
  roofFraming: "Roof framing",
  rackingAttachment: "Racking / attachment",
  structuralLoads: "Structural load criteria",
  rapidShutdown: "Rapid shutdown",
  labels: "PV labels / placards",
  inverterSettings: "Inverter listing / settings",
  batteryMode: "Battery operating mode",
  utilityApproval: "Utility approval",
  ownerAuthorization: "Owner authorization",
};

function evidenceSummary(check: ProjectEvidence): string {
  if (!check.excerpts.length) return `No parsed ${TOPIC_LABEL[check.topic].toLowerCase()} evidence was found.`;
  return evidenceLines(check).join(" ");
}

function evidenceNeeded(check: ProjectEvidence): string[] {
  return [
    ...check.missingEvidence,
    ...check.excerpts.map((excerpt) => `Parsed evidence: ${excerpt}`),
  ].slice(0, 8);
}

function confidenceVerb(check: ProjectEvidence): string {
  if (!check.present) return "Missing";
  if (check.confidence === "high") return "Verified";
  if (check.confidence === "medium") return "Verify";
  return "Missing";
}

// opts.codeContext: the jurisdiction's adopted-codes context (resolveEffectiveCodeContext).
// When omitted the engine behaves exactly as before the data-driven refactor — legacy
// Oregon detection + hardcoded constants (pinned by backend/test/reviewerOregonGolden).
export function buildReviewerReport(
  project: ProjectRecord,
  opts: {
    codeContext?: EffectiveCodeContext;
    /** The AHJ's OWN jurisdiction_code_profiles row (exact key or fuzzy name match), null when it
     *  has none — the code-edition record reviewer.profile.missing names beside the process (#217). */
    codeProfileRow?: { ahj: string; confidence: "seeded" | "verified" } | null;
    /** doc_type values actually attached to the project. The plan-set requirement is about
     *  whether the package EXISTS, and the parser-text signals below are only a proxy for
     *  that — a proxy that reads "missing" for a project holding every split document. */
    uploadedDocTypes?: string[];
    /** Per-document text for the design-criteria rules (one source per document). */
    documentTexts?: DesignTextSource[];
    /** A filed state PV worksheet read by position + upload times (pvWorksheetGate). */
    pvWorksheet?: PvWorksheetGateInput;
    /** A named person's standing confirmation that a `structural` document is the engineer's
     *  sealed letter (structuralLetter.activeStructuralLetterConfirmation, #198). Text never sets it. */
    structuralCertification?: { confirmedBy: string; confirmedAt: string } | null;
  } = {},
): ReviewerReport {
  const profile = findAhjProcessProfile(project);
  const findings: ReviewerFinding[] = [];

  const standalone = isStandaloneReviewSubject(project);
  addCoreProjectFindings(project, findings);
  // Valuation, homeowner email/phone and company assignment feed the portal APPLICATION; the
  // standalone gate files nothing and its form has none of those fields.
  if (!standalone) addSubmittalDataFindings(project, findings);
  findings.push(...evaluateDesignCodeFindings(project, profile, opts.codeContext, opts.uploadedDocTypes ?? [], opts.documentTexts ?? [], opts.structuralCertification ?? null));
  // What issued permits in this AHJ already carried (#147): a callout on a reused product, a
  // warning — never a blocker — on a departure along a dimension the AHJ has corrected before.
  if (opts.codeContext) findings.push(...evaluatePermitPrecedentFindings(project, opts.codeContext));
  // Iowa City correction themes: the filed PV worksheet against the plan, and the one-line's
  // service ratings against the rest of the set (the package's own words, not parser notes).
  if (opts.pvWorksheet) findings.push(...pvWorksheetFindings(project, opts.pvWorksheet));
  findings.push(...serviceRatingConsistencyFindings(project, [String(project.parserSnapshot?.planSetExtractedText ?? ""), ...(opts.documentTexts ?? []).map((d) => d.text)].join("\n")));
  addPlanSetFindings(project, findings);
  addPlacementRuleFindings(project, opts.codeContext, findings, opts.documentTexts ?? []);
  addUtilityFindings(project, findings);
  addProfileFindings(project, profile, findings, opts.uploadedDocTypes ?? []);
  addPermitPathFindings(project, findings);
  addInstallerCallouts(project, profile, findings);

  // Deduplicate findings. Two subsystems independently check the same topics with
  // DIFFERENT ids — the code-rule engine (city.plan.*/city.fire.*) and the plan-set
  // pass (reviewer.plan.*), plus core vs utility for account/meter. Collapse those
  // known-overlapping families to one canonical key so the gate doesn't "double up".
  // Keep the FIRST occurrence: with the builder order above that's the code-anchored
  // / generic finding (richer code refs), not the redundant restatement.
  const DEDUPE_ALIASES: Record<string, string> = {
    "city.plan.sld-missing": "topic:sld",
    "reviewer.plan.sld": "topic:sld",
    "city.plan.site-roof-missing": "topic:site-roof",
    "reviewer.plan.site": "topic:site-roof",
    "city.fire.pathways-missing": "topic:fire",
    "reviewer.plan.fire-path": "topic:fire",
    "city.elec.rapid-shutdown-missing": "topic:rapid-shutdown",
    "reviewer.plan.rapid-shutdown": "topic:rapid-shutdown",
    "reviewer.core.account": "topic:account",
    "reviewer.utility.pge-account": "topic:account",
    "reviewer.core.meter": "topic:meter",
    "reviewer.utility.pacpower-meter-photo": "topic:meter",
  };
  const dedupeKey = (f: ReviewerFinding): string => DEDUPE_ALIASES[f.id] || f.id;
  // KEEP THE MOST ACTIONABLE of an aliased pair, not merely the first one added.
  // addCoreProjectFindings runs before addUtilityFindings, so first-wins always kept the
  // generic "Utility account number missing." and discarded the utility-specific finding
  // that names the utility, the evidence needed, and the design-team action — measured on
  // real projects, every account blocker surfaced as the generic one. A `reviewer.core.*`
  // finding is the fallback; anything else on the same topic is the specific one.
  const isGeneric = (f: ReviewerFinding): boolean => f.id.startsWith("reviewer.core.");
  // SEVERITY OUTRANKS SPECIFICITY. Preferring the specific finding was right for the account
  // case above, but applied unconditionally it lets a WARNING evict a BLOCKER on the same
  // topic — so a missing critical field surfaces as "verify this" and the package stages. The
  // specific finding is better WORDED; it is not automatically a better VERDICT. Rank by what
  // stops a filing first, and use specificity only to break a tie at equal severity.
  const bestByKey = new Map<string, ReviewerFinding>();
  for (const f of findings) {
    const key = dedupeKey(f);
    const held = bestByKey.get(key);
    if (!held || findingOutranks(f, held)) bestByKey.set(key, f);
  }
  const keep = new Set<ReviewerFinding>(bestByKey.values());
  for (let i = 0; i < findings.length; i++) {
    if (!keep.has(findings[i])) { findings.splice(i, 1); i--; continue; }
    keep.delete(findings[i]); // a duplicate object reference must not survive twice
  }
  // On the standalone gate a utility-specific account / meter finding (PGE account, Pacific
  // Power meter photo) asks for something the form cannot take — advisory there, never a blocker.
  if (standalone) {
    for (let i = 0; i < findings.length; i++) {
      const key = dedupeKey(findings[i]);
      if ((key === "topic:account" || key === "topic:meter") && findings[i].severity === "blocker") {
        findings[i] = { ...findings[i], severity: "callout" };
      }
    }
  }

  // THE GATE AND THE PACKET ANSWER "WHICH PROCESS APPLIES?" WITH THE SAME PREDICATE
  // (applicationDocs.findApplicationProfile + the per-job lookup). "No seeded AHJ process profile
  // matched" while the packet had used the Oregon statewide profile read as a contradiction.
  const appProfile = findApplicationProfile(project);
  const looked = permitProcessFor(project);
  const statewideApplied = appProfile.id === "oregon-generic-epermitting";
  if (!profile) {
    // THIS FINDING IS ABOUT THE PERMIT PROCESS RECORD, AND SAYS SO (#217). Its trigger is only that
    // the shipped reference file (reference-ahj-processes.json, seeded) has no row for this AHJ; it
    // never read the code profile, so "no hand-verified profile on file" right after an operator
    // verified the code-profile row read as "your verification didn't take". The title names the
    // process record and what the per-job lookup found (seeded or verified, from its own row); the
    // message prints the sources it cites and says adopted code editions are a SEPARATE record,
    // with that record's own status. Wording only — nothing here verifies anything (rule 3).
    const ahjName = project.ahj || "AHJ";
    const processRecord = `${ahjName} permit process (who issues, single or separate permits, portal, forms)`;
    const lookupStatus = looked?.confidence === "verified"
      // verified_by is often an email — print a name, never the address.
      ? `verified by ${looked.verifiedBy && !looksLikeEmail(looked.verifiedBy) ? looked.verifiedBy : "a person"}`
      : "seeded, not yet verified";
    const codeRecord = profileMissingCodeRecordNote(opts.codeContext, opts.codeProfileRow);
    const lookedMessage = (lk: NonNullable<typeof looked>): string => {
      const facts: Array<{ label: string; fact: { value: unknown; sourceUrl: string } }> = [
        { label: "Issuing agency", fact: lk.issuingAgency },
        { label: "Permit structure", fact: lk.permitStructure },
      ];
      for (const p of lk.permits ?? []) {
        facts.push({ label: `${p.label || p.discipline} portal`, fact: p.portalUrl });
        facts.push({ label: `${p.label || p.discipline} forms`, fact: p.documents });
      }
      const shown = (v: unknown): string | null =>
        v === null || v === undefined || (Array.isArray(v) && !v.length) ? null : Array.isArray(v) ? v.join(", ") : String(v);
      const lines = facts.map(({ label, fact }) => `${label}: ${shown(fact?.value) ?? "not found"}${shown(fact?.value) && fact?.sourceUrl ? ` (source: ${fact.sourceUrl})` : ""}.`);
      const missing = facts.filter(({ fact }) => !shown(fact?.value)).length;
      return `${lines.join(" ")} ${missing ? `Verify the ${missing} not-found item(s) before submittal.` : "Check each answer against its source before submittal."}`;
    };
    findings.push(finding(
      "reviewer.profile.missing",
      looked || statewideApplied ? "callout" : "warning",
      "ahj_profile",
    looked
      ? `${processRecord}: per-job lookup found it (${lookupStatus}); not in the shipped reference file`
      : statewideApplied
        ? `${processRecord}: Oregon statewide profile applied; no ${project.ahj || "City"}-specific process record (per-job lookup found none)`
        : `${processRecord}: not in the shipped reference file and the per-job lookup found none`,
    `${looked
      ? lookedMessage(looked)
      : statewideApplied
        ? "The packet used the Oregon ePermitting statewide profile (separate structural + electrical permits, OAR 918-050-0180(2)); verify any local application, stamp or signature requirement."
        : "Use generic AHJ docs and verify local application/stamp/signature requirements manually before submittal."} ${codeRecord}`,
    true,
    {
      cityFeedback: "The project jurisdiction/process requirements could not be matched to the seeded AHJ profile table. Provide confirmation of the AHJ, portal path, required applications, signature/stamp requirements, and utility sequencing before submission.",
      designTeamAction: "Confirm the AHJ/process profile and add any required local forms or stamped documents.",
      evidenceNeeded: ["Verified AHJ/jurisdiction", "Portal/process path", "Required local forms", "Stamp/signature requirements"],
    },
  ));
  }

  // B8(d): BOILERPLATE REMINDERS ARE NOT FINDINGS. "Final AHJ preview is required", "Installer
  // pre-submittal scope confirmation" and the prescriptive-path upload reminder are true of EVERY
  // filing; listed beside real defects they read as defects of THIS project ("looks like you're
  // calling them out for this project"). They live on the submit checklist (finalSubmitGate) —
  // the final-preview control is still enforced by staging (automation stops at review).
  const checklistOnly = new Set(["installer.scope-confirm", "reviewer.permit-path.prescriptive"]);
  const moved = findings.filter((f) => checklistOnly.has(f.id));
  for (let i = findings.length - 1; i >= 0; i--) if (checklistOnly.has(findings[i].id)) findings.splice(i, 1);

  const enrichedFindings = findings.map((item) => attachEvidence(project, profile, item));

  return {
    projectId: project.id,
    generatedAt: nowIso(),
    matchedProcessProfile: profile,
    findings: enrichedFindings,
    installerCallouts: enrichedFindings.filter((item) => item.installerCallout),
    finalSubmitGate: {
      mustShowAhjPreviewWindow: true,
      finalSubmitButtonAloneIsEnough: false,
      requirements: [
        "Show actual AHJ/utility portal final-review screen when a real adapter is running.",
        "Show internal final review packet when using mock/manual staging.",
        "Block final submit staging if blocker findings remain.",
        "Human must compare final portal fields, uploaded files, fees, and acknowledgements before clicking submit.",
        "Final AHJ preview: see the actual AHJ/utility final-review page (never only a submit button), compare every field and upload, then submit by hand.",
        ...moved.map((f) => `${f.title}: ${f.message}`),
      ],
    },
  };
}

function maskIdentifier(value: string): string {
  const cleaned = value.replace(/\s+/g, "");
  if (!cleaned) return "";
  if (cleaned.length <= 4) return "[captured]";
  return `${"*".repeat(Math.max(0, cleaned.length - 4))}${cleaned.slice(-4)}`;
}

function evidenceStatus(check: ProjectEvidence): ReviewerFinding["evidenceStatus"] {
  if (!check.present) return "missing";
  if (check.confidence === "high") return "verified";
  if (check.confidence === "medium") return "weak";
  return "missing";
}

// WHICH OF TWO FINDINGS ON THE SAME TOPIC SURVIVES THE COLLAPSE.
//
// Preferring the SPECIFIC finding was right for the case it was written for — the generic
// "Utility account number missing." was evicting the utility-specific one that names the
// utility and the evidence needed. But applied unconditionally it also lets a WARNING evict a
// BLOCKER, which would report a missing critical field as "verify this" and let the package
// stage. The specific finding is better WORDED; that does not make it a better VERDICT.
//
// So: severity first, specificity only as the tie-break at equal severity.
//
// HONEST SCOPE: with today's rules this is LATENT, not a live bug. Measured across the
// account and meter pairs, the generic and specific sides always agree on severity — the
// generic one fires only when the field is empty, and the specific one is a blocker then too.
// This pins the ordering so the next pair added cannot quietly drop a blocker.
const SEVERITY_RANK: Record<string, number> = { blocker: 3, warning: 2, callout: 1 };

/** The code-edition record's own status, for reviewer.profile.missing (#217): adopted editions live
 *  in jurisdiction_code_profiles, a separate record from the permit process, verified or not on its
 *  own. The AHJ's OWN row decides; the merged context's confidence is the weaker of the AHJ and state
 *  layers, so a verified city row under a seeded state row would read "seeded" there. */
function profileMissingCodeRecordNote(
  ctx: EffectiveCodeContext | undefined,
  own: { ahj: string; confidence: "seeded" | "verified" } | null | undefined,
): string {
  const lead = "Adopted code editions are a separate record (jurisdiction code profile):";
  const tail = "verifying it does not clear this finding.";
  const status = (c: "seeded" | "verified") => (c === "verified" ? "verified" : "seeded, not verified");
  if (own) return `${lead} ${status(own.confidence)} (${own.ahj}'s code profile); ${tail}`;
  // Not read (no db, or the read failed): never guess "no AHJ row" from the merged context.
  if (own === undefined) return `${lead} not read by this check.`;
  if (ctx?.profile) return `${lead} no ${ctx.ahj || "AHJ"}-specific row; the ${ctx.profile.state || ctx.state} state default is ${status(ctx.profile.confidence)}; ${tail}`;
  return `${lead} not on file (model-code defaults); ${tail}`;
}

export function findingOutranks(candidate: ReviewerFinding, held: ReviewerFinding): boolean {
  const isGeneric = (f: ReviewerFinding): boolean => f.id.startsWith("reviewer.core.");
  const delta = (SEVERITY_RANK[candidate.severity] ?? 0) - (SEVERITY_RANK[held.severity] ?? 0);
  if (delta !== 0) return delta > 0;
  return isGeneric(held) && !isGeneric(candidate);
}

export function topicForFinding(finding: ReviewerFinding): EvidenceTopic | null {
  const idTitle = `${finding.id} ${finding.title}`.toLowerCase();
  if (/account/.test(idTitle)) return "accountVerification";
  if (/meter/.test(idTitle)) return "meterPhoto";
  if (/sld|one.line|single.line|3.line|three.line|load-side|supply-side|interconnection/.test(idTitle)) return "sld";
  if (/site|roof plan|layout/.test(idTitle)) return "siteRoofPlan";
  if (/fire|pathway|setback/.test(idTitle)) return "firePathway";
  if (/framing|rafter|truss|span/.test(idTitle)) return "roofFraming";
  if (/attachment|racking|flashing|mount/.test(idTitle)) return "rackingAttachment";
  if (/load criteria|snow|dead load|wind/.test(idTitle)) return "structuralLoads";
  if (/rapid|rsd|690\.12/.test(idTitle)) return "rapidShutdown";
  if (/label|placard|directory/.test(idTitle)) return "labels";
  if (/inverter settings|1741|smart inverter/.test(idTitle)) return "inverterSettings";
  if (/equipment schedule|spec package|equipment.*spec|spec.*sheet|dc.size|equipment field/.test(idTitle)) return "sld";
  // "ess" as a WORD: a bare /ess/ matched "process" / "access", routing the permit-process
  // finding to the battery topic (its evidence then read "Battery operating mode — not found").
  if (/battery|\bess\b|powerwall/.test(idTitle)) return "batteryMode";
  if (/utility approval|interconnection approval/.test(idTitle)) return "utilityApproval";
  if (/signature|owner authorization|customer authorization/.test(idTitle)) return "ownerAuthorization";
  return null;
}

function evidenceFromTopic(projectId: string, check: ProjectEvidence): ReviewerFindingEvidence[] {
  const found = check.hits.map<ReviewerFindingEvidence>((hit) => ({
    kind: "source_excerpt",
    label: `${TOPIC_LABEL[check.topic]} evidence`,
    source: hit.sourceLabel,
    excerpt: hit.excerpt,
    confidence: check.confidence,
    pageHint: hit.pageHint,
    screenshotPath: "",
    verifier: "parser",
    note: check.confidence === "high" ? "Parser found strong supporting source text." : "Parser found possible source text; human should verify on the source sheet.",
  }));

  if (found.length) {
    // Point the crop slot at the on-demand renderer. The endpoint locates the
    // plan-set PDF, picks the page backing this topic's evidence, and rasterizes
    // it. If no plan set is stored, the endpoint 404s and the report falls back
    // to the text hint via the <img onerror> handler in renderFinding.
    const cropUrl = `/api/projects/${encodeURIComponent(projectId)}/evidence-image?topic=${encodeURIComponent(check.topic)}`
      + `&hint=${encodeURIComponent(found[0].pageHint || "")}`
      + `&excerpt=${encodeURIComponent((found[0].excerpt || "").slice(0, 160))}`;
    found.push({
      kind: "screenshot_placeholder",
      label: "Screenshot crop slot",
      source: found[0].source,
      excerpt: "",
      confidence: check.confidence,
      pageHint: found[0].pageHint,
      screenshotPath: cropUrl,
      verifier: "parser",
      note: "Source page will render here. If no plan-set PDF is stored, upload it to Project Documents — then this slot shows the sheet. Use the source/page hint above meanwhile.",
    });
    return found;
  }

  return [{
    kind: "absence_check",
    label: `${TOPIC_LABEL[check.topic]} — not found in the package`,
    source: "Parsed project package",
    excerpt: `No matching evidence found. Checked for: ${requirementsForTopic(check.topic).join(", ")}.`,
    confidence: "low",
    pageHint: "",
    screenshotPath: "",
    verifier: "rule_engine",
    note: "This is a missing-proof callout, not proof of a design defect. Verify the source package before sending to client.",
  }];
}

function fieldEvidence(label: string, value: string | number | null | undefined, sensitive = false): ReviewerFindingEvidence {
  const present = value != null && value !== "";
  const display = present ? String(value) : "Missing from normalized project fields.";
  return {
    kind: "field_value",
    label,
    source: "Normalized project field",
    excerpt: present && sensitive ? maskIdentifier(String(value)) : display,
    confidence: present ? "high" : "low",
    pageHint: "Project summary",
    screenshotPath: "",
    verifier: "normalized_field",
    note: present ? "Value was captured into the normalized project record." : "No normalized value was captured; confirm against source documents.",
  };
}

function coreFieldEvidence(project: ProjectRecord, findingId: string): ReviewerFindingEvidence | null {
  const map: Record<string, ReviewerFindingEvidence> = {
    "reviewer.core.homeowner": fieldEvidence("Homeowner name", project.homeownerName),
    "reviewer.core.address": fieldEvidence("Service address", project.projectAddress),
    "reviewer.core.ahj": fieldEvidence("AHJ", project.ahj),
    "reviewer.core.utility": fieldEvidence("Utility", project.utility),
    "reviewer.core.account": fieldEvidence("Utility account", project.accountNumber, true),
    "reviewer.core.meter": fieldEvidence("Meter number", project.meterNumber, true),
    "reviewer.core.dc": fieldEvidence("DC system size", project.systemSizeDcKw),
    "reviewer.core.ac": fieldEvidence("AC system size", project.systemSizeAcKw),
    "reviewer.core.interconnection": fieldEvidence("Interconnection method", project.interconnectionMethod),
  };
  return map[findingId] || null;
}

function profileEvidence(profile: AhjProcessProfile | null, finding: ReviewerFinding): ReviewerFindingEvidence | null {
  if (!profile || finding.category !== "ahj_profile") return null;
  return {
    kind: "process_profile",
    label: "Seeded AHJ process profile",
    source: profile.sourceSheet || "AHJ process profile",
    excerpt: `${profile.state} / ${profile.ahj} / ${profile.submissionMethod}. ${profile.otherRequirements || profile.reviewerNotes || "Profile matched by AHJ/state."}`,
    confidence: "medium",
    pageHint: "AHJ profile table",
    screenshotPath: "",
    verifier: "ahj_profile",
    note: "Profile-based callout. Confirm local AHJ requirements if this is a live submittal.",
  };
}

function genericEvidence(project: ProjectRecord, profile: AhjProcessProfile | null, finding: ReviewerFinding): ReviewerFindingEvidence[] {
  const core = coreFieldEvidence(project, finding.id);
  if (core) return [core];
  const profileHit = profileEvidence(profile, finding);
  if (profileHit) return [profileHit];
  if (finding.category === "portal") {
    return [{
      kind: "process_profile",
      label: "Submission safeguard",
      source: "Portal automation policy",
      excerpt: "Automation must stop at final review. Human must verify fields/uploads/fees and manually submit.",
      confidence: "high",
      pageHint: "Final submit gate",
      screenshotPath: "",
      verifier: "rule_engine",
      note: "This is a required safety control, not a design deficiency.",
    }];
  }
  return [{
    kind: "absence_check",
    label: "General source check",
    source: "Parsed project package",
    excerpt: finding.message,
    confidence: finding.severity === "callout" ? "medium" : "low",
    pageHint: "",
    screenshotPath: "",
    verifier: "rule_engine",
    note: "Rule-generated callout. Human should verify the source package before forwarding.",
  }];
}

// EVIDENCE OF THE TOPIC IS NOT EVIDENCE OF THE FINDING.
//
// A finding that carries no evidence of its own borrows its TOPIC's — topicForFinding maps
// "city.elec.supply-side-tap" to "sld", and the sld evidence is proof that a one-line EXISTS.
// That status used to be copied straight onto the finding, so on f7d7af7e the supply-side-tap
// callout read "evidence: verified" while the tap detail it asks for (conductor sizing, OCPD
// ahead of the service disconnect) was never looked for. The operator read "verified" as
// "the tap detail is on the set".
//
// The one predicate: topic evidence can only ever say the topic was FOUND, so a finding that
// borrows it is at most "weak", and every borrowed excerpt says, in its label, what it does
// and does not show. This is safe to apply to every borrower because every finding whose ask
// IS the topic's presence (reviewer.plan.sld/site/rapid-shutdown, reviewer.plan.fire-path,
// reviewer.utility.*) only fires when that topic is NOT high — so a high borrowed topic always
// means the finding wanted something narrower. A finding that carries its own evidence (the
// design-criteria and listing rules, a vision verdict) keeps whatever status it earned.
const TOPIC_NOUN: Record<EvidenceTopic, string> = {
  accountVerification: "Utility account text",
  meterPhoto: "Meter text",
  sld: "SLD",
  siteRoofPlan: "Site/roof plan",
  firePathway: "Fire pathway callout",
  roofFraming: "Roof framing text",
  rackingAttachment: "Racking/attachment text",
  structuralLoads: "Load criteria text",
  rapidShutdown: "Rapid shutdown callout",
  labels: "Label callouts",
  inverterSettings: "Inverter listing/settings text",
  batteryMode: "Battery text",
  utilityApproval: "Utility approval text",
  ownerAuthorization: "Authorization text",
};

export function borrowedTopicEvidence(
  projectId: string,
  finding: ReviewerFinding,
  check: ProjectEvidence,
): { evidenceFound: ReviewerFindingEvidence[]; evidenceStatus: ReviewerFinding["evidenceStatus"] } {
  const topicStatus = evidenceStatus(check);
  const evidenceStatusOut: ReviewerFinding["evidenceStatus"] = topicStatus === "verified" ? "weak" : topicStatus;
  // Mid-sentence casing that leaves acronyms alone: "Supply-side tap" -> "supply-side tap",
  // but "SLD/one-line sheet" and "MSP bus rating" stay as written.
  const midSentence = (value: string): string => (/^[A-Z][a-z]/.test(value) ? value.charAt(0).toLowerCase() + value.slice(1) : value);
  const ask = midSentence((finding.evidenceNeeded[0] || finding.title).trim());
  const noun = TOPIC_NOUN[check.topic];
  const evidenceFound = evidenceFromTopic(projectId, check).map((item) =>
    item.kind === "source_excerpt"
      ? {
          ...item,
          label: `${noun} found — ${ask} not verified`,
          note: `This shows the ${midSentence(noun)} is on the set. It does not show ${ask}; check the source sheet for that.`,
        }
      : item,
  );
  return { evidenceFound, evidenceStatus: evidenceStatusOut };
}

function attachEvidence(project: ProjectRecord, profile: AhjProcessProfile | null, finding: ReviewerFinding): ReviewerFinding {
  if (finding.evidenceFound?.length) return finding;
  const topic = topicForFinding(finding);
  if (topic) return { ...finding, ...borrowedTopicEvidence(project.id, finding, evidenceForTopic(project, topic)) };
  const evidenceFound = genericEvidence(project, profile, finding);
  const status = evidenceFound.some((item) => item.kind === "process_profile") ? "profile" : evidenceFound.some((item) => item.confidence === "high") ? "verified" : "weak";
  return { ...finding, evidenceFound, evidenceStatus: status };
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function findingClass(severity: ReviewerFinding["severity"]): string {
  if (severity === "blocker") return "blocker";
  if (severity === "warning") return "warning";
  if (severity === "pass") return "pass";
  return "callout";
}

function renderFinding(finding: ReviewerFinding): string {
  const refs = finding.codeReferences.length
    ? finding.codeReferences.map((ref) => `<li><strong>${esc(ref.code)} ${esc(ref.section)}</strong> - ${esc(ref.title)}<br><span>${esc(ref.note)}</span>${ref.sourceUrl ? `<br><a href="${esc(ref.sourceUrl)}">${esc(ref.sourceUrl)}</a>` : ""}</li>`).join("")
    : "<li>No exact code citation attached. Verify local AHJ policy.</li>";
  const evidence = finding.evidenceNeeded.length ? finding.evidenceNeeded.map((item) => `<li>${esc(item)}</li>`).join("") : "<li>Corrected plan/application evidence.</li>";
  const found = finding.evidenceFound?.length
    ? finding.evidenceFound.map((item) => {
        if (item.kind === "screenshot_placeholder") {
          // Try to render the source page; if the endpoint 404s (no plan-set PDF
          // stored), hide the broken image and reveal the text-hint fallback.
          return item.screenshotPath
            ? `<li><strong>${esc(item.label)}:</strong> <img class="crop" src="${esc(item.screenshotPath)}" alt="${esc(item.label)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'" /><span class="shot-slot" style="display:none">${esc(item.note)}</span></li>`
            : `<li><strong>${esc(item.label)}:</strong> <span class="shot-slot">${esc(item.note)}</span></li>`;
        }
        return `<li><strong>${esc(item.label)}:</strong> ${esc(item.excerpt)}<br><span>${esc(item.source)}${item.pageHint ? ` | ${esc(item.pageHint)}` : ""} | ${esc(item.confidence)} confidence | ${esc(item.verifier)}</span>${item.note ? `<br><span>${esc(item.note)}</span>` : ""}</li>`;
      }).join("")
    : "<li>No evidence trail attached yet.</li>";
  // THE BANNER MUST SAY WHAT THE ENGINE ACTUALLY DID. A "present" verdict at LOW confidence is
  // one the engine refuses to act on — applyVerdict only relaxes at high or medium — yet this
  // rendered the green "✓ Vision-verified on the plan sheet" for it. The confidence word was
  // printed, but a green tick reads as a conclusion and the qualifier beside it does not undo
  // that. Say "saw, not confirmed", and keep the warn styling, when the verdict did not count.
  const v = finding.visionVerification;
  const visionTrusted = Boolean(v && v.present && (v.confidence === "high" || v.confidence === "medium"));
  const visionHtml = v && v.checked
    ? `<div class="vision-verdict ${visionTrusted ? "ok" : "warn"}"><strong>${
        visionTrusted
          ? "✓ Vision-verified on the plan sheet"
          : v.present
            ? "⚠ Vision saw something but could not confirm it — not treated as verified"
            : "⚠ Vision could not confirm on the plan sheet"
      } (page ${esc(String(v.page))}, ${esc(v.confidence)} confidence)</strong><br><span>${esc(v.observed || v.note)}</span></div>`
    : "";
  return `
    <article class="finding ${findingClass(finding.severity)}">
      <div class="finding-head">
        <h3>${esc(finding.title)}</h3>
        <span>${esc(finding.severity)} | ${esc(finding.category)} | evidence: ${esc(finding.evidenceStatus || "unknown")}</span>
      </div>
      ${visionHtml}
      <p><strong>Reviewer comment:</strong> ${esc(finding.cityFeedback)}</p>
      <p><strong>Required correction:</strong> ${esc(finding.designTeamAction)}</p>
      <div class="grid">
        <div><strong>Evidence required</strong><ul>${evidence}</ul></div>
        <div><strong>Code / basis</strong><ul>${refs}</ul></div>
      </div>
      <div class="evidence-found"><strong>Evidence found / checked</strong><ul>${found}</ul></div>
    </article>`;
}

export function renderReviewerReportHtml(project: ProjectRecord, report: ReviewerReport): string {
  const blockers = report.findings.filter((item) => item.severity === "blocker");
  const warnings = report.findings.filter((item) => item.severity === "warning");
  const callouts = report.findings.filter((item) => item.severity === "callout");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AHJ Reviewer Gate - ${esc(project.homeownerName || project.projectAddress || project.id)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; color: #17202a; background: #f6f7f9; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px; }
    header, .finding, .summary { background: #fff; border: 1px solid #d9e0e7; border-radius: 8px; padding: 18px; margin-bottom: 14px; }
    h1, h2, h3, p { margin: 0; } h1 { font-size: 24px; } h2 { font-size: 17px; margin-bottom: 8px; } h3 { font-size: 16px; }
    p { line-height: 1.45; margin-top: 8px; } a { color: #115e59; overflow-wrap: anywhere; }
    .meta, span { color: #687281; font-size: 13px; } .counts { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    .pill { border-radius: 999px; padding: 6px 10px; background: #eef2f5; font-weight: 700; font-size: 12px; text-transform: uppercase; }
    .blocker { border-left: 5px solid #b91c1c; } .warning { border-left: 5px solid #a16207; } .callout { border-left: 5px solid #1d4ed8; } .pass { border-left: 5px solid #0f766e; }
    .finding-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 12px; }
    .evidence-found { border-top: 1px solid #d9e0e7; margin-top: 12px; padding-top: 10px; }
    .shot-slot { display: block; border: 1px dashed #94a3b8; border-radius: 6px; padding: 10px; color: #475569; background: #f8fafc; }
    img { max-width: 100%; border: 1px solid #d9e0e7; border-radius: 6px; margin-top: 6px; }
    img.crop { display: block; max-width: 520px; box-shadow: 0 1px 4px rgba(15,23,42,.12); }
    .vision-verdict { margin: 8px 0; padding: 8px 10px; border-radius: 6px; font-size: 13px; }
    .vision-verdict.ok { background: #ecfdf5; border: 1px solid #0f766e; }
    .vision-verdict.warn { background: #fffbeb; border: 1px solid #a16207; }
    li { margin-bottom: 6px; } ul { padding-left: 20px; }
    @media print { body { background: #fff; } main { max-width: none; padding: 0; } .finding { break-inside: avoid; } }
    @media (max-width: 760px) { main { padding: 14px; } .grid, .finding-head { grid-template-columns: 1fr; display: grid; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>AHJ Reviewer Gate</h1>
      <p class="meta">${esc(project.homeownerName || "Unnamed")} | ${esc(project.projectAddress || "No address")} | AHJ: ${esc(project.ahj || "Missing")} | Utility: ${esc(project.utility || "Missing")}</p>
      <div class="counts">
        <span class="pill">${blockers.length} blocker(s)</span>
        <span class="pill">${warnings.length} warning(s)</span>
        <span class="pill">${report.installerCallouts.length} installer callout(s)</span>
        <span class="pill">Generated ${esc(new Date(report.generatedAt).toLocaleString())}</span>
      </div>
    </header>
    <section class="summary">
      <h2>Final Submit Gate</h2>
      <p>Submit button alone is not enough: <strong>${report.finalSubmitGate.finalSubmitButtonAloneIsEnough ? "Yes" : "No"}</strong>. Actual AHJ/utility preview required: <strong>${report.finalSubmitGate.mustShowAhjPreviewWindow ? "Yes" : "No"}</strong>.</p>
      <ul>${report.finalSubmitGate.requirements.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
      <p class="meta">Matched process profile: ${report.matchedProcessProfile ? `${esc(report.matchedProcessProfile.state)} / ${esc(report.matchedProcessProfile.ahj)} / ${esc(report.matchedProcessProfile.submissionMethod)}` : "none"}</p>
    </section>
    <section>
      <h2>City-Style Correction Comments</h2>
      ${report.findings.map(renderFinding).join("")}
    </section>
    ${report.installerCallouts.length ? `
    <section class="summary">
      <h2>Installer Callouts — Quick Checklist</h2>
      <p class="meta">A one-line summary of the installer-facing items above (full detail is in the correction comments).</p>
      <ul>${report.installerCallouts.map((item) => `<li><strong>${esc(item.title)}:</strong> ${esc(item.designTeamAction || item.message)}</li>`).join("")}</ul>
    </section>` : ""}
  </main>
</body>
</html>`;
}

// THE STANDALONE PLAN REVIEW GATE (review.html) builds its project from a short form
// (reviewSubjectToProject marks it status "review_only"). That form has no account / meter
// fields and an OPTIONAL utility, so the pipeline's per-field blockers read there as 15
// blockers the operator could not clear, one identical "Critical project field missing" card
// per field. On the gate: the fields the form DOES ask for fold into one blocker that names
// them; utility / account / meter are advisory (they belong to the interconnection filing, not
// the plan review). The pipeline project is untouched — it never carries this status.
export function isStandaloneReviewSubject(project: ProjectRecord): boolean {
  return String((project as { status?: unknown }).status ?? "") === "review_only";
}

function addStandaloneCoreFindings(project: ProjectRecord, findings: ReviewerFinding[]): void {
  const asked: Array<[string, string | number | null]> = [
    ["applicant name", project.homeownerName],
    ["site address", project.projectAddress],
    ["jurisdiction (AHJ)", project.ahj],
    ["DC size (kW)", project.systemSizeDcKw],
    ["AC size (kW)", project.systemSizeAcKw],
    ["interconnection", project.interconnectionMethod],
  ];
  const missing = asked.filter(([, v]) => v == null || v === "").map(([label]) => label);
  if (missing.length) {
    const list = missing.join(", ");
    findings.push(finding("reviewer.core.fields", "blocker", "project_data",
      missing.length === 1 ? "Project detail missing" : `${missing.length} project details missing`,
      `Not filled in: ${list}.`, true,
      { cityFeedback: `Fill in ${list} above and run the review again.`, evidenceNeeded: missing }));
  }
  if (!project.utility) {
    findings.push(finding("reviewer.core.utility", "callout", "utility_nem", "Utility not given",
      "Utility-specific interconnection checks were skipped.", true,
      { cityFeedback: "Add the utility above to include its interconnection checks." }));
  }
}

function addCoreProjectFindings(project: ProjectRecord, findings: ReviewerFinding[]): void {
  if (isStandaloneReviewSubject(project)) { addStandaloneCoreFindings(project, findings); return; }
  const required: Array<[string, string | number | null, string]> = [
    ["homeowner", project.homeownerName, "Homeowner name missing."],
    ["address", project.projectAddress, "Service/project address missing."],
    ["ahj", project.ahj, "AHJ missing."],
    ["utility", project.utility, "Utility missing."],
    ["account", project.accountNumber, "Utility account number missing."],
    ["meter", project.meterNumber, "Meter number missing."],
    ["dc", project.systemSizeDcKw, "DC system size missing."],
    ["ac", project.systemSizeAcKw, "AC system size missing."],
    ["interconnection", project.interconnectionMethod, "Interconnection method missing."],
  ];
  for (const [id, value, message] of required) {
    if (value == null || value === "") findings.push(finding(`reviewer.core.${id}`, "blocker", "project_data", "Critical project field missing", message, true));
  }
}

// Submittal data that usually isn't on the plan set / utility bill and must come
// from the client (installer): project valuation, homeowner email, homeowner phone.
// These are CALLOUTS, never blockers — a missing contact won't deadlock staging,
// and valuation falls back to a per-watt estimate. The "Send client intake link"
// action collects them. (See valuation.ts for the contract-vs-estimate logic.)
function addSubmittalDataFindings(project: ProjectRecord, findings: ReviewerFinding[]): void {
  const snap = project.parserSnapshot || {};
  const valuation = resolveValuation(snap, project.systemSizeDcKw);

  if (valuation.method === "per_watt_estimate") {
    findings.push(finding(
      "reviewer.submit.valuation-estimate",
      "callout",
      "project_data",
      "Project valuation is an estimate",
      `No contract value on file; using a per-watt estimate of $${valuation.value?.toLocaleString()}. ${valuation.basis}`,
      true,
      { designTeamAction: "Request the actual contract / installed cost from the client via the intake link, or confirm the estimate is acceptable for this AHJ's fee schedule." },
    ));
  } else if (valuation.method === "unavailable") {
    findings.push(finding(
      "reviewer.submit.valuation-missing",
      "callout",
      "project_data",
      "Project valuation could not be determined",
      "No contract value provided and system size is unknown, so permit fees can't be valued.",
      true,
      { designTeamAction: "Send the client intake link to collect the contract value." },
    ));
  }

  // ON FILE MEANS AN EMAIL ADDRESS (looksLikeEmail, #71): a name typed into the email box is not
  // one, and the recipe values blank it rather than type it into a portal's Email box. Same id,
  // same callout severity; the detail describes the stored value and never repeats it.
  const email = typeof snap.homeownerEmail === "string" ? snap.homeownerEmail.trim() : "";
  if (!looksLikeEmail(email)) {
    findings.push(finding(
      "reviewer.submit.homeowner-email",
      "callout",
      "project_data",
      email ? "Homeowner email on file is not an email address — verify" : "Homeowner email missing",
      email
        ? "The homeowner email field holds a value that is not an email address, so it will not be filled into any portal. Many AHJ portals require a property-owner email on the application."
        : "Many AHJ portals require a property-owner email on the application.",
      true,
      { designTeamAction: "Collect the homeowner email via the client intake link." },
    ));
  }

  const phone = typeof snap.homeownerPhone === "string" ? snap.homeownerPhone.trim() : "";
  if (!phone) {
    findings.push(finding(
      "reviewer.submit.homeowner-phone",
      "callout",
      "project_data",
      "Homeowner phone missing",
      "Many AHJ portals require a property-owner phone number on the application.",
      true,
      { designTeamAction: "Collect the homeowner phone via the client intake link." },
    ));
  }

  if (!project.clientId) {
    findings.push(finding(
      "reviewer.submit.no-client",
      "callout",
      "project_data",
      "No company assigned",
      "This project has not been assigned to an installer company. Assign a client before staging the submittal so the correct portal credentials and browser profile are used.",
      false,
      { designTeamAction: "Open the project detail and assign a client company from the Client dropdown." },
    ));
  }
}

function addPlanSetFindings(project: ProjectRecord, findings: ReviewerFinding[]): void {
  // THE SAME MOUNT QUESTION, ANSWERED IN ONE PLACE. These rules are paired with the
  // code-rule engine's via DEDUPE_ALIASES (topic:fire, topic:rapid-shutdown), and the
  // code-rule side wins. So while codeReviewRules was the only mount-aware layer, a ground
  // array's roof blockers came from THERE and these duplicates stayed masked — teaching
  // nobody that this layer was mount-blind. Fixing that layer removed the mask and these
  // surfaced, demanding roof fire pathways and 690.12 of an array standing in a field.
  // Import the predicate rather than re-deriving it: two vocabularies is what caused this.
  const kind = mountKindForProject(project);
  const onARoof = kind === "roof" || kind === "unknown";
  const rsdApplies = kind !== "ground";

  const requiredDocs: Array<[string, ReturnType<typeof evidenceForTopic>, string, string]> = [
    ["sld", evidenceForTopic(project, "sld"), "SLD/one-line sheet not clearly mapped", "Provide or remap the one-line/SLD sheet so interconnection and equipment can be reviewed."],
    // NOT mount-gated on purpose: a ground array needs a site plan MORE than a roof job —
    // setbacks, pier layout, trench route and equipment pad all live on it. The code-rule
    // layer exempts site plans for ground mounts, so this is a ground array's ONLY site-plan
    // coverage; exempting it here too would replace a false blocker with real silence.
    ["site", evidenceForTopic(project, "siteRoofPlan"), "Site/roof plan not clearly mapped", "Provide or remap the site/roof plan showing array layout and service equipment."],
    ...(rsdApplies
      ? [["rapid-shutdown", evidenceForTopic(project, "rapidShutdown"), "Rapid shutdown evidence not clear", "Show rapid shutdown equipment, initiation/control location, and required labels."] as [string, ReturnType<typeof evidenceForTopic>, string, string]]
      : []),
  ];
  // MLPE (microinverters / RSD-integrated optimizers) satisfies NEC 690.12 inherently, so a
  // missing rapid-shutdown callout is a LABELLING gap, not missing equipment. codeReviewRules
  // has always known that and softened its own finding; this pass did not, so the pair on
  // topic:rapid-shutdown disagreed — and once dedupe began ranking by severity, the blind
  // blocker started winning and hard-blocked designs that comply by construction. Import the
  // predicate rather than restating it.
  const mlpe = isMlpeDesignForProject(project);
  const planSeverity = (id: string, present: boolean): ReviewerFinding["severity"] => {
    if (present) return "warning";
    if (id === "rapid-shutdown" && mlpe) return "warning";
    return "blocker";
  };

  for (const [id, check, title, action] of requiredDocs) {
    if (check.confidence === "high") continue;
    findings.push(finding(
      `reviewer.plan.${id}`,
      planSeverity(id, check.present),
      "plan_set",
      check.present ? `${confidenceVerb(check)} ${title.toLowerCase()}` : title,
      check.present ? `${title}. ${evidenceSummary(check)}` : action,
      true,
      {
        cityFeedback: check.present
          ? `${title}. The parser found only ${check.confidence}-confidence evidence. ${evidenceSummary(check)}`
          : `${title}. ${action}`,
        designTeamAction: check.present ? `Confirm the parsed evidence is on the current plan set. ${action}` : action,
        evidenceNeeded: evidenceNeeded(check),
      },
    ));
  }

  // A GROUND ARRAY HAS NO ROOF PATHWAYS — but it is not therefore unreviewed. The roof
  // access/setback question is replaced by the questions a ground array actually raises, so
  // the operator gets a prompt instead of silence. Six of the eight supply-side projects on
  // the live book taught that lesson: the finding that never fires reads as approval.
  if (!onARoof) {
    findings.push(finding(
      "reviewer.plan.ground-array-site",
      "callout",
      "plan_set",
      `Ground/${kind === "carport" ? "carport" : "pole"}-mounted array — roof access rules do not apply`,
      "Roof fire pathway and roof framing review is not applicable to this array. Confirm the checks that ARE: property-line and structure setbacks, foundation/pier or footing detail, underground feeder route and burial depth, equipment pad, and any fencing or signage the AHJ requires.",
      true,
      {
        cityFeedback: "Show setbacks to property lines and structures, the foundation/pier detail, the underground conductor route with burial depth, and array grounding.",
        designTeamAction: "Confirm the site plan carries setbacks, footing/pier detail, trench section with cover depth, and equipment locations for a non-roof array.",
        evidenceNeeded: ["Site plan with setbacks", "Foundation/pier detail", "Trench/underground feeder detail"],
      },
    ));
  }

  const firePathway = evidenceForTopic(project, "firePathway");
  if (onARoof && firePathway.confidence !== "high") {
    findings.push(finding(
      "reviewer.plan.fire-path",
      firePathway.present ? "warning" : "blocker",
      "plan_set",
      firePathway.present ? "Verify fire pathway evidence" : "Fire pathway evidence missing",
      firePathway.present
        ? `Fire pathway evidence is only ${firePathway.confidence}-confidence. ${evidenceSummary(firePathway)}`
        : "Confirm the site/roof plan clearly shows AHJ-required access and escape pathways.",
      true,
      {
        cityFeedback: firePathway.present
          ? `The plan set may include fire/access pathway evidence, but it needs human verification before submittal. ${evidenceSummary(firePathway)}`
          : "Fire pathway/setback dimensions were not found in parsed plan text.",
        designTeamAction: "Confirm dimensioned fire access pathways, setbacks, ridge/eave notes, and any local exception basis on the roof/site plan.",
        evidenceNeeded: evidenceNeeded(firePathway),
      },
    ));
  }
}

/**
 * THE AHJ'S OWN PLACEMENT RULES, SHOWN — NEVER CHECKED. Rules the placement lookup stored on the
 * AHJ's profile (pvPlacementRules.ts; id prefix "placement-research:") are listed as a callout on a
 * roof array: "AHJ rule on file: … confirm on the roof plan". Waltham's rejection (new-AHJ e2e,
 * 2026-09-26) was its checklist item 11 — an access path clear of the incoming electrical service —
 * and the gate had shown a green check for "fire access + escape pathways" because a FILE was
 * attached. Nothing here reads the drawing, so the evidence is "weak" and the words say "confirm".
 *
 * Pathway widths and ridge setbacks the rules state ARE now measured against the plan, by
 * city.fire.pathway-below-required (designCriteria.ts, issue #142). The rules' other conditions
 * (clear of the service, a skylight, a parapet) are not, so this stays a callout, and it quotes
 * what the plan states next to the rules for the person who checks the rest.
 */
function addPlacementRuleFindings(project: ProjectRecord, ctx: EffectiveCodeContext | undefined, findings: ReviewerFinding[], documentTexts: DesignTextSource[]): void {
  const rules = (ctx?.fireSetbacks ?? []).filter((r) => String(r.id || "").startsWith("placement-research:"));
  if (!rules.length) return;
  const kind = mountKindForProject(project);
  if (kind !== "roof" && kind !== "unknown") return;
  const who = project.ahj || ctx?.ahj || "The AHJ";
  const lines = rules.slice(0, 6).map((r) => `"${r.description}"${r.codeReference?.section ? ` (${r.codeReference.section})` : ""}`);
  const stated = extractRoofPlanDimensions(project, documentTexts);
  const planSays = stated.length
    ? ` The plan states: ${stated.slice(0, 4).map((d) => `"${d.excerpt}" (${d.source})`).join("; ")}. The pathway widths and ridge setbacks these rules state are measured separately (fire pathway check); nothing else in them is.`
    : " No fire access pathway width or ridge setback could be read from the plan text.";
  findings.push(finding(
    "reviewer.plan.ahj-placement-rules",
    "callout",
    "plan_set",
    `${who}'s own PV placement / fire access rules — confirm the roof plan meets them`,
    `AHJ rule${rules.length > 1 ? "s" : ""} on file (from ${who}'s own page; not checked against the drawing): ${lines.join("; ")}.${planSays}`,
    true,
    {
      cityFeedback: `Show on the roof/site plan that the array meets ${who}'s published placement and fire access rules: ${lines.join("; ")}.`,
      designTeamAction: "Check each quoted rule against the roof plan (pathway widths and locations, ridge/eave setbacks, clearance from the electrical service) before submittal; these were read from the AHJ's page, not measured on the plan.",
      evidenceNeeded: ["Roof plan with dimensioned pathways and setbacks", ...rules.slice(0, 3).map((r) => r.description.slice(0, 120))],
      codeReferences: rules.slice(0, 4).map((r) => r.codeReference).filter((c): c is CodeReference => !!c),
      evidenceStatus: "weak",
      // The evidence is the AHJ's page, said as such — so the topic's plan-text evidence is not
      // borrowed (attachEvidence) and nothing reads as "verified on the plan".
      evidenceFound: rules.slice(0, 4).map((r) => ({
        kind: "source_excerpt" as const,
        label: `${who}'s rule (its own page) — not checked against the plan`,
        source: r.codeReference?.sourceUrl || "",
        excerpt: r.description.slice(0, 300),
        confidence: "medium" as const,
        pageHint: r.codeReference?.section || "",
        screenshotPath: "",
        verifier: "rule_engine" as const,
        note: "Read from the AHJ's published page by the placement lookup; confirm the roof plan meets it.",
      })),
    },
  ));
}

function addUtilityFindings(project: ProjectRecord, findings: ReviewerFinding[]): void {
  const account = evidenceForTopic(project, "accountVerification");
  // WHICH UTILITY, by the one state-gated identity (utilityIdentity): a CA PG&E job ("Pacific Gas and
  // Electric", or typed "PGE") is neither Portland General nor PacifiCorp, and was blocked on both.
  const knownUtility = knownPowerClerkUtility(project);
  if (knownUtility === "portland_general" && account.confidence !== "high") {
    findings.push(finding(
      "reviewer.utility.pge-account",
      account.present ? "warning" : "blocker",
      "utility_nem",
      account.present ? "Verify PGE account evidence" : "PGE account verification unresolved",
      account.present
        ? `PGE/NEM submission has an account value, but parsed utility bill/account match evidence is not strong enough. ${evidenceSummary(account)}`
        : "PGE/NEM submission should not be staged without a verified utility account number.",
      true,
      {
        cityFeedback: account.present
          ? "Utility account evidence is incomplete: account number alone is not enough for a clean intake pass."
          : "Utility account number and account verification were not found.",
        designTeamAction: "Verify utility bill/account holder/service address match before staging the NEM application.",
        evidenceNeeded: evidenceNeeded(account),
      },
    ));
  }
  if (knownUtility === "pacificorp") {
    const meterPhoto = evidenceForTopic(project, "meterPhoto");
    if (meterPhoto.confidence !== "high") {
      findings.push(finding(
        "reviewer.utility.pacpower-meter-photo",
        meterPhoto.present ? "warning" : "blocker",
        "utility_nem",
        meterPhoto.present ? "Verify Pacific Power meter photo" : "Pacific Power meter photo missing",
        meterPhoto.present
          ? `Meter evidence needs review before customer generation staging. ${evidenceSummary(meterPhoto)}`
          : "Pacific Power customer generation packages should not be staged without meter photo/evidence.",
        true,
        {
          cityFeedback: meterPhoto.present
            ? "A meter number or weak meter evidence was captured, but a meter photo/evidence match was not proven."
            : "Meter photo/evidence was not found in the parsed project package.",
          designTeamAction: "Confirm the meter photo is present, legible, and matches the parsed meter number before staging.",
          evidenceNeeded: evidenceNeeded(meterPhoto),
        },
      ));
    }

    const inverterSettings = evidenceForTopic(project, "inverterSettings");
    if (inverterSettings.confidence !== "high") {
      findings.push(finding(
        "reviewer.utility.pacpower-settings",
        "warning",
        "utility_nem",
        inverterSettings.present ? "Verify Pacific Power inverter settings" : "Pacific Power inverter settings evidence missing",
        inverterSettings.present
          ? `UL 1741/inverter spec evidence was captured, but utility-specific settings are not fully proven. ${evidenceSummary(inverterSettings)}`
          : "Confirm UL 1741 SB / smart inverter settings evidence is included before NEM submission.",
        true,
        {
          cityFeedback: inverterSettings.present
            ? "Utility-required inverter settings need human verification, not just a generic inverter spec."
            : "Utility-required inverter settings/UL 1741 SB evidence was not found.",
          designTeamAction: "Add or verify Pacific Power inverter settings/UL 1741 SB evidence in the utility upload package.",
          evidenceNeeded: evidenceNeeded(inverterSettings),
        },
      ));
    }
  }
  if (payload(project, "ubMeterVerification") && /mismatch/i.test(payload(project, "ubMeterVerification"))) {
    findings.push(finding("reviewer.utility.meter-mismatch", "blocker", "utility_nem", "Meter mismatch", payload(project, "ubMeterVerification"), true));
  }
}

function addProfileFindings(project: ProjectRecord, profile: AhjProcessProfile | null, findings: ReviewerFinding[], uploadedDocTypes: string[] = []): void {
  if (!profile) return;
  const docs = `${payload(project, "splitPagesText")}\n${payload(project, "utilityDownloadChecklistText")}\n${payload(project, "projectDescriptionText")}`;
  const stampText = `${payload(project, "stampRecommendation")}\n${payload(project, "reviewFlags")}`;
  // THE DOCUMENTS THEMSELVES SETTLE THIS, NOT THE PARSER'S NOTES ABOUT THEM.
  //
  // The three payload fields above are parser text — a proxy for "a package was produced".
  // A project can hold plan_set, sld, site_plan, module_spec and inverter_spec on disk and
  // still have those fields empty, and this fired as a BLOCKER on exactly that: a complete
  // package, hard-blocked from staging, with the operator told "No split mapping found"
  // while the dashboard listed ten documents. There is no way out of that from the UI,
  // because nothing the operator can type creates parser text.
  const PACKAGE_DOC_TYPES = ["plan_set", "combined_plan_set", "full_plan_set", "utility_package_zip", "sld", "site_plan"];
  const hasPackageOnDisk = uploadedDocTypes.some((t) => PACKAGE_DOC_TYPES.includes(String(t)));
  if (profile.requiresPlanSet && !docs.trim() && !hasPackageOnDisk) {
    findings.push(finding("reviewer.profile.plan-set", "blocker", "ahj_profile", "AHJ profile requires plan set", `${profile.ahj} profile requires a plan set/upload package. No plan set or split package is attached to this project.`, true));
  }
  // Stamp decision comes from the single authority (permitPath.resolveStampRequirement)
  // so the reviewer can never disagree with the dashboard's required-documents list.
  // Advisory here: only the process-profile trigger is in play (the path/threshold
  // triggers produce their own blocking findings elsewhere), and it stays a warning.
  const stampReq = resolveStampRequirement(project, {
    processProfileRequiresStamp: profile.requiresStructuralStamp,
    jurisdictionLabel: profile.ahj,
  });
  if (stampReq.required && stampReq.source === "process_profile" && !stampReq.satisfiedByEvidence
      && !/stamp|engineer|structural letter|calc/i.test(stampText + docs)) {
    findings.push(finding("reviewer.profile.structural-stamp", "warning", "structural", "Structural stamp/letter may be required", stampReq.reason, true));
  }
  if (profile.requiresElectricalStamp && !/electrical stamp|engineer|sealed/i.test(docs)) {
    findings.push(finding("reviewer.profile.electrical-stamp", "warning", "electrical", "Electrical stamp may be required", `${profile.ahj} process profile indicates electrical stamp may be required.`, true));
  }
  const ownerAuthorization = evidenceForTopic(project, "ownerAuthorization");
  if (profile.requiresCustomerSignature && ownerAuthorization.confidence !== "high") {
    // Homeowner-provided document — the autopilot doesn't generate it. Advisory callout
    // (never a service-side gap): just remind the operator the installer includes it.
    findings.push(finding(
      "reviewer.profile.customer-signature",
      "callout",
      "ahj_profile",
      "Customer/owner authorization (installer-provided)",
      `${profile.ahj} may require a signed owner authorization. This is provided by the installer/homeowner with the package, not produced here.`,
      true,
      {
        cityFeedback: `${profile.ahj} appears to require customer/owner authorization.`,
        designTeamAction: "Confirm the installer/homeowner includes the signed owner authorization in the submittal package.",
        evidenceNeeded: evidenceNeeded(ownerAuthorization),
      },
    ));
  }
  const utilityApproval = evidenceForTopic(project, "utilityApproval");
  if (profile.requiresUtilityApproval && utilityApproval.confidence !== "high") {
    // Utility-issued (PTO / interconnection approval) — not an autopilot deliverable.
    findings.push(finding(
      "reviewer.profile.utility-approval",
      "callout",
      "utility_nem",
      "Utility approval sequencing (utility-issued)",
      `${profile.ahj} may need utility approval/interconnection evidence before permit submission. This is issued by the utility, not produced here.`,
      true,
      {
        cityFeedback: `${profile.ahj} profile references utility approval/interconnection sequencing.`,
        designTeamAction: "Confirm whether the utility/NEM approval must be attached or completed before permit submission.",
        evidenceNeeded: evidenceNeeded(utilityApproval),
      },
    ));
  }
  if (profile.requiresFloodplainCheck && !/flood|FEMA/i.test(docs)) {
    // Jurisdiction/FEMA determination — external to the autopilot. Advisory only.
    findings.push(finding("reviewer.profile.flood", "callout", "ahj_profile", "Floodplain/FEMA check (jurisdiction-determined)", `${profile.ahj} references flood/FEMA review. Confirm the jurisdiction/design team has addressed it before submittal.`, true));
  }
  if (profile.requiresJurisdictionCheck) {
    findings.push(finding("reviewer.profile.jurisdiction", "callout", "ahj_profile", "Jurisdiction/address verification recommended", `${profile.ahj} process profile calls out jurisdiction or address verification. Confirm before submittal.`, true));
  }
}

// Permit-path findings — prescriptive vs engineered (non-prescriptive). On the
// engineered path the AHJ requires sealed structural documentation, so we make sure
// the PE-stamped plans + structural letter are collected (a real gap, surfaced as a
// warning when they're not already in hand). The path itself is always a callout so
// the operator can see and confirm the routing that drives which application uploads.
function addPermitPathFindings(project: ProjectRecord, findings: ReviewerFinding[]): void {
  const path = resolvePermitPath(project);

  // OUTSIDE OREGON with no prescriptive path on file there is no path CHOICE (permitPath.ts,
  // standardReview): the one application is the standard structural review. Say that,
  // and never the Oregon engineered-path demand for a PE package — the stamp, where the
  // jurisdiction's own rule wants one, is on the required-documents list already.
  if (path.standardReview) {
    // A STAMPED structural review (the plan set / operator says engineered, outside a split
    // jurisdiction): the stamped documents are owed, and the words stay the jurisdiction's — one
    // building application, never "the structural one, not the prescriptive one".
    if (path.needsEngineeredDocs) {
      const haveStamp = hasStampedStructuralEvidence(project);
      findings.push(finding(
        "reviewer.permit-path.stamped-review",
        haveStamp ? "callout" : "warning",
        "structural",
        haveStamp ? "Stamped structural review — stamped structural docs detected" : "Stamped structural review — collect stamped structural docs",
        haveStamp
          ? `${path.basis.join(" ")} A PE-stamped plan set / structural letter was detected in the uploads. Confirm the seal is current and on the structural sheets, then file them with the AHJ's building application.`
          : `${path.basis.join(" ")} This submittal needs a PE-stamped plan set + structural engineering letter/calcs, which are NOT yet in the uploaded files. Collect them from the installer/engineer of record before submitting, and file them with the AHJ's building application.`,
        true,
        {
          cityFeedback: "An engineered (stamped) structural design requires the PE-stamped structural plan set and the engineer's sealed letter/calcs with the building permit application.",
          designTeamAction: haveStamp
            ? "Verify the PE stamp is on the structural sheets and the engineering letter is sealed; attach both to the submittal."
            : "Request the PE-stamped structural plans + structural engineering letter from the installer/engineer of record and attach them before staging.",
          evidenceNeeded: path.requiredEngineeredDocs,
        },
      ));
      return;
    }
    findings.push(finding(
      "reviewer.permit-path.standard-review",
      "callout",
      "structural",
      "Standard structural review (no prescriptive rooftop-PV path on file)",
      `${path.basis.join(" ")}`,
      true,
      {
        cityFeedback: "Rooftop PV is reviewed through the jurisdiction's standard structural (building) permit review.",
        designTeamAction: "Make sure the plan set shows the roof framing (member, size, spacing, span) and the attachment detail; attach a PE-sealed letter only where the jurisdiction's rule requires one.",
      },
    ));
    return;
  }

  if (path.path === "engineered") {
    const haveStamp = hasStampedStructuralEvidence(project);
    findings.push(finding(
      "reviewer.permit-path.engineered",
      haveStamp ? "callout" : "warning",
      "structural",
      haveStamp ? "Engineered path — stamped structural docs detected" : "Engineered path — collect stamped structural docs",
      haveStamp
        ? `Non-prescriptive (engineered) path: a PE-stamped plan set / structural letter was detected in the uploads. Confirm the seal is current and on the structural sheets, then upload ONLY the structural application (not the prescriptive one).`
        : `Non-prescriptive (engineered) path: this submittal needs a PE-stamped plan set + structural engineering letter/calcs, which are NOT yet in the uploaded files. Collect them from the installer/engineer of record before submitting. Upload ONLY the structural application (not the prescriptive one).`,
      true,
      {
        cityFeedback: "Non-prescriptive solar requires a stamped structural plan set and engineer's letter/calcs, plus the structural (not prescriptive) application; it triggers plan review and full structural fees.",
        designTeamAction: haveStamp
          ? "Verify the PE stamp is on the structural sheets and the engineering letter is sealed; attach both to the submittal."
          : "Request the PE-stamped structural plans + structural engineering letter from the installer/engineer of record and attach them before staging.",
        evidenceNeeded: path.requiredEngineeredDocs,
      },
    ));
  } else if (path.path === "unknown") {
    findings.push(finding(
      "reviewer.permit-path.unconfirmed",
      "callout",
      "structural",
      "Confirm prescriptive vs engineered path",
      `The permit path isn't confirmed yet (${path.basis.join(" ")}). Set it on the project (Manual entry → Permit path). It decides which application uploads — prescriptive (no plan review, reduced fee) or structural (plan review, full fees, PE stamp). Upload only the one that matches; never both.`,
      true,
    ));
  } else {
    findings.push(finding(
      "reviewer.permit-path.prescriptive",
      "callout",
      "structural",
      "Prescriptive path",
      `Prescriptive path: ${path.basis.join(" ")} Upload ONLY the prescriptive application — meets prescriptive code, no plan review, reduced fee. Do NOT also upload the structural application.`,
      true,
    ));
  }
}

function addInstallerCallouts(project: ProjectRecord, profile: AhjProcessProfile | null, findings: ReviewerFinding[]): void {
  findings.push(finding(
    "installer.scope-confirm",
    "callout",
    "installer",
    "Installer pre-submittal scope confirmation",
    `Confirm with installer: roof planes, array layout, interconnection method (${project.interconnectionMethod || "missing"}), MSP/main/PV breaker, battery backup mode, and any MPU/LST/locate-triggering work.`,
    true,
  ));
  if (profile?.reviewerNotes) {
    findings.push(finding(
      "installer.profile-notes",
      "callout",
      "installer",
      "AHJ process note to verify",
      `${profile.ahj}: ${profile.reviewerNotes}`,
      true,
    ));
  }
  // A LOCATES CALLOUT ONLY WHEN THERE IS DIGGING. "No excavation — roof mount only" is the absence of
  // the thing this warns about, and it was being listed as a finding.
  if (payload(project, "locateCalloutText") && !/no locate|not needed|not found|no excavation|no trench|no digging|roof[- ]mount(?:ed)? only/i.test(payload(project, "locateCalloutText"))) {
    findings.push(finding("installer.locates", "callout", "installer", "Locates/utility coordination", payload(project, "locateCalloutText"), true));
  }

  // Main panel / service upgrade (MPU) — some AHJs fold it into the electrical permit,
  // others require a separate electrical/service-upgrade permit. Surface it and point at
  // the AHJ's own process note when it speaks to MPU/electrical-trade handling.
  if (hasMpuScope(project)) {
    const note = profile?.reviewerNotes && /mpu|panel upgrade|service upgrade|electric(al)? trade/i.test(profile.reviewerNotes)
      ? ` ${profile.ahj} note: "${profile.reviewerNotes}"`
      : "";
    findings.push(finding(
      "installer.mpu-permit",
      "callout",
      "installer",
      "Main panel / service upgrade (MPU) — confirm permit handling",
      `This project includes a main panel / service upgrade. Some AHJs require the MPU on the electrical permit; others require a separate electrical/service-upgrade permit. Verify how ${project.ahj || "this AHJ"} files the MPU before staging.${note}`,
      true,
    ));
  }
}

// Main-panel / service-upgrade detection is the ONE predicate (serviceScope.hasMpuScope) —
// the MPU permit track and the electrical fee lines read the same answer.
