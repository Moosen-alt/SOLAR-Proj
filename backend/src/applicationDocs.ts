import type {
  ApplicationDocumentPackage,
  ApplicationRequirementProfile,
  ClientRecord,
  GeneratedApplicationDocument,
  ProjectRecord,
} from "../../shared/src/types";
import { nowIso } from "./time";
import { findAhjProcessProfile, ahjProcessKnowledgeStatus, jurisdictionCore, registryTermMatches } from "./processProfiles";
import { describeCited, permitProcessFor, statePermitStructure } from "./permitProcess";
import { resolvePermitPath, resolveStampRequirement, permitPathCallout, hasStampedStructuralEvidence, evaluatePrescriptiveCriteria, usStateCode, type PermitPathResolution } from "./permitPath";
// Functions only, called at run time: this module sits inside the permitProcessLookup ->
// feeSchedules -> knowledgeBase -> applicationDocs import cycle (see applicationDocsAgency's header).
import { agencyListReplacesLine, issuingAgencyDocumentList, type AgencyDocumentList, type AgencyLineStatusOf } from "./applicationDocsAgency";
import { knownPowerClerkUtility } from "./utilityIdentity";
// Functions only (same cycle): the licences a document lists are licenceFor's (clients.ts).
import { licenceJobState, stateLicenceLines } from "./clients";

/** The job's LICENCES are Oregon's (the named CCB / electrical columns): the one licence-state answer,
 *  clients.licenceJobState ("Oregon" is OR; a blank state is unknown — no state's licences). */
const isOregonJob = (project: Pick<ProjectRecord, "state">): boolean => licenceJobState(project.state) === "OR";

// ---------------------------------------------------------------------------
// ONE PERMIT-STRUCTURE ANSWER (new-AHJ e2e, 2026-09-26: permit structure 0/5 right).
//
// Four surfaces answered "one combined permit, or separate building + electrical?" on their
// own and contradicted each other on the same project: the tracks said "combo", the form
// finder said "Separate building (BLD) + electrical (ELE) permits — both must be filed" from
// its own uncited research, the email subject said "BLD, ELE Permit submittal" on all seven
// jobs (unknown fell through to it), and describePermitType re-derived "separate" from two
// spreadsheet flags. Truth on those jobs: Iowa City, Venus and Scottsdale file ONE permit;
// Waltham files a fire review FIRST, then building, then wires.
//
// permitStructureAnswer is the only function that answers it. Strongest first:
//   1. the per-job lookup's answer, cited (a source URL + the page's own words) — a person's
//      VERIFIED lookup row first of all;
//   2. a hand-written (human-curated) application profile — its explicit structure, or its
//      naming of both a structural and an electrical application;
//   3. the AHJ's seeded process profile, only where its note SAYS so in words, unhedged
//      ("Looks like combo permit (?)" settles nothing);
//   4. a CITED STATE RULE (Oregon: OAR 918-050-0180(2)) — for any jurisdiction of that state
//      with no local answer above, except a hand-written profile with its own portal;
//   5. UNKNOWN. Two spreadsheet flags, a synthesized profile naming both applications, the
//      form finder's uncited research — each is a LEAD, carried as `hint`, never the answer.
// "Separate — both must be filed" is said only at levels 1, 2 and 4. A prerequisite office
// (a fire review, a zoning sign-off, a plan examination that "is not a permit") is its own
// step, from the lookup's cited prerequisites, and is never the issuing agency.
// ---------------------------------------------------------------------------
export type PermitStructureLevel = "verified" | "cited" | "curated" | "reference" | "state_rule" | "unknown";
export interface PermitPrerequisiteStep {
  /** The step in the source's words ("Fire Prevention plan review before the building permit"). */
  step: string;
  sourceUrl: string;
  quote: string;
}
export interface PermitStructureAnswer {
  structure: "separate" | "combo" | "unknown";
  level: PermitStructureLevel;
  /** One line an operator reads: the answer and where it came from. */
  basis: string;
  sourceUrl: string;
  quote: string;
  /** An UNSETTLED lead ("the seeded profile flags both applications") — never shown as a fact. */
  hint: string;
  /** Steps at another office before (or beside) the filing, each cited. */
  prerequisites: PermitPrerequisiteStep[];
}

const HEDGED = /\?|\blooks like\b|\bmaybe\b|\bmight\b|\bpossibly\b|\bprobably\b|\bnot sure\b|\bunclear\b|\bi think\b|\bseems\b/i;

/** The seeded process profile's own WORDS about the structure — null when it says nothing, or
 *  says it hedged. Flags are not words: see level 5 above. */
function processNoteStructure(project: ProjectRecord): { structure: "separate" | "combo"; note: string } | { hedged: string } | null {
  const ahj = findAhjProcessProfile(project);
  if (!ahj) return null;
  const raw = `${ahj.reviewerNotes || ""} ${ahj.otherRequirements || ""} ${ahj.submissionMethod || ""}`;
  const notes = raw.toLowerCase();
  // "Apply for solar and electrical separately" / "Electrical Trade permit" → separate.
  // Checked before combo so Beaverton's "…can go under one electric trade permit" (which
  // refers to folding the MPU into the electrical permit) doesn't mislabel it combo.
  let structure: "separate" | "combo" | null = null;
  let sentence = "";
  const sentences = raw.split(/(?<=[.;!?])\s+|\s{2,}|\n+/);
  const find = (re: RegExp) => sentences.find((s) => re.test(s.toLowerCase())) || "";
  if ((/\bseparate(ly)?\b/.test(notes) && /electric/.test(notes)) || /electrical trade permit/.test(notes)) {
    structure = "separate";
    sentence = find(/\bseparate(ly)?\b|electrical trade permit/);
  } else if (/\b(combined|combo)\b/.test(notes) || /one (single )?(combination|building) permit/.test(notes)) {
    structure = "combo";
    sentence = find(/\b(combined|combo)\b|one (single )?(combination|building) permit/);
  }
  if (!structure) return null;
  if (HEDGED.test(sentence)) return { hedged: `the seeded ${ahj.ahj} process note says "${sentence.trim().slice(0, 120)}" — hedged, not settled` };
  return { structure, note: sentence.trim().slice(0, 200) };
}

function citedPrerequisites(project: ProjectRecord): PermitPrerequisiteStep[] {
  const lk = permitProcessFor(project);
  const out: PermitPrerequisiteStep[] = [];
  for (const p of lk?.prerequisites ?? []) {
    const step = typeof p?.value === "string" ? p.value.trim() : "";
    if (!step || !/^https?:\/\//i.test(String(p.sourceUrl || "")) || String(p.quote || "").trim().length < 8) continue;
    if (!out.some((o) => o.step.toLowerCase() === step.toLowerCase())) out.push({ step, sourceUrl: String(p.sourceUrl), quote: String(p.quote).trim() });
  }
  return out;
}

/** THE ONE ANSWER. `researched`: an uncited research pass's reading (the form finder's), which can
 *  only ever become a hint. */
export function permitStructureAnswer(
  project: ProjectRecord,
  opts: { researched?: "separate" | "combo" | "unknown" | null; researchedFrom?: string } = {},
): PermitStructureAnswer {
  const prerequisites = citedPrerequisites(project);
  const settle = (structure: "separate" | "combo", level: PermitStructureLevel, basis: string, sourceUrl = "", quote = ""): PermitStructureAnswer =>
    ({ structure, level, basis, sourceUrl, quote, hint: "", prerequisites });
  const hints: string[] = [];

  // 1. The per-job lookup, cited (or a person's verified row).
  const lk = permitProcessFor(project);
  const ps = lk?.permitStructure;
  if (ps && (ps.value === "separate" || ps.value === "combo")) {
    const verified = lk?.confidence === "verified";
    if (verified || (/^https?:\/\//i.test(ps.sourceUrl || "") && (ps.quote || "").trim().length >= 8)) {
      return settle(ps.value, verified ? "verified" : "cited",
        verified ? `Permit structure: ${ps.value} — verified by a person${ps.sourceUrl ? `, ${ps.sourceUrl}` : ""}` : describeCited("Permit structure", ps),
        ps.sourceUrl || "", ps.quote || "");
    }
    hints.push(`the per-job lookup said "${ps.value}" without a page and its words`);
  }

  // 2. A hand-written (human-curated) application profile.
  const profile = findApplicationProfile(project);
  const handWritten = applicationProfiles.includes(profile) && profile.id !== "oregon-generic-epermitting";
  if (handWritten && profile.permitStructure && profile.permitStructure !== "unknown") {
    return settle(profile.permitStructure, "curated", `Permit structure: ${profile.permitStructure} — the hand-written ${profile.name} profile${profile.sourceUrl ? `, ${profile.sourceUrl}` : ""}`, profile.sourceUrl);
  }
  if (handWritten && profile.requiresStructuralApplication && profile.requiresElectricalApplication) {
    return settle("separate", "curated", `Permit structure: separate — the hand-written ${profile.name} profile names both a structural and an electrical application${profile.sourceUrl ? `, ${profile.sourceUrl}` : ""}`, profile.sourceUrl);
  }

  // 3. The seeded process profile's own words, unhedged.
  const note = processNoteStructure(project);
  if (note && "structure" in note) {
    return settle(note.structure, "reference", `Permit structure: ${note.structure} — the operator's seeded process note for this AHJ ("${note.note}"), not confirmed on an agency page`, "", note.note);
  }
  if (note && "hedged" in note) hints.push(note.hedged);

  // 4. A cited state rule — for any jurisdiction of the state with no local answer, except a
  //    hand-written profile for a jurisdiction with its OWN portal (Portland DevHub, Salem PAC):
  //    that profile is the AHJ's evidence and changing it is a per-AHJ decision.
  //    Such a profile's AHJ still takes the state rule when its own seeded record flags an
  //    electrical permit application (Salem: PAC portal, and the operator's filings there are a
  //    building AND an electrical permit) — the cited rule settles what the flag only suggests.
  const proc = findAhjProcessProfile(project);
  const ownPortalProfile = handWritten && !/e-?permitting|accela/i.test(`${profile.submissionMethod ?? ""} ${profile.portalName ?? ""}`)
    && !proc?.requiresElectricalPermitApplication;
  const stateRule = ownPortalProfile ? null : statePermitStructure(project);
  if (stateRule?.value) return settle(stateRule.value, "state_rule", describeCited("Permit structure", stateRule), stateRule.sourceUrl, stateRule.quote);

  // 5. Unknown — with every lead named as a lead.
  if (proc?.requiresBuildingPermitApplication && proc?.requiresElectricalPermitApplication) {
    hints.push(`the seeded ${proc.ahj} process profile flags both a building and an electrical application (flags, not a statement that two permits are filed)`);
  }
  if (handWritten && (profile.requiresAhjApplication || profile.requiresStructuralApplication)) {
    hints.push(`the ${profile.name} profile names one building application`);
  }
  if (opts.researched === "separate" || opts.researched === "combo") {
    hints.push(`${opts.researchedFrom || "uncited research"} read it as ${opts.researched === "separate" ? "separate building + electrical permits" : "one combined permit"}`);
  }
  return {
    structure: "unknown", level: "unknown",
    basis: `Permit structure: not confirmed — no cited agency page, verified record or state rule says one permit or two${hints.length ? ` (unconfirmed leads: ${hints.join("; ")})` : ""}`,
    sourceUrl: "", quote: "", hint: hints.join("; "), prerequisites,
  };
}

/** Resolve a project's permit structure: permitStructureAnswer's structure. */
export function permitStructureForProject(project: ProjectRecord): "separate" | "combo" | "unknown" {
  return permitStructureAnswer(project).structure;
}

/** The permit structure AND the evidence it rests on (permitStructureAnswer, flattened). */
export function permitStructureWithBasis(project: ProjectRecord): { structure: "separate" | "combo" | "unknown"; basis: string } {
  const a = permitStructureAnswer(project);
  return { structure: a.structure, basis: a.basis };
}

/** May this answer be printed as "both must be filed" / "one permit"? Levels 1, 2 and 4 only —
 *  a seeded note is the operator's reference, stated as such. */
export function permitStructureIsCitedOrVerified(a: Pick<PermitStructureAnswer, "level">): boolean {
  return a.level === "verified" || a.level === "cited" || a.level === "curated" || a.level === "state_rule";
}

/** The one sentence every surface prints for the structure (tracks, form finder, package, email). */
export function permitStructureSentence(a: PermitStructureAnswer): string {
  const { core, pre } = permitStructureParts(a);
  return `${core}.${pre}`;
}
function permitStructureParts(a: PermitStructureAnswer): { core: string; pre: string } {
  const firm = permitStructureIsCitedOrVerified(a);
  const where = a.level === "state_rule" ? "state rule" : a.level === "cited" ? "cited agency page" : a.level === "verified" ? "verified by a person"
    : a.level === "curated" ? "hand-written AHJ profile" : "operator's seeded note — not confirmed on an agency page";
  const core = a.structure === "separate"
    ? (firm ? `Separate building (BLD) + electrical (ELE) permits — both must be filed (${where})` : `Separate building + electrical permits per the ${where}`)
    : a.structure === "combo"
      ? `One combined building + electrical permit (${where})`
      : `One permit or separate building + electrical permits: not yet confirmed — verify on the AHJ site${a.hint ? ` (unconfirmed lead: ${a.hint})` : ""}`;
  const pre = a.prerequisites.length ? ` FIRST, at another office: ${a.prerequisites.map((p) => p.step).join("; then ")}.` : "";
  return { core, pre };
}

/**
 * FOR THE LOOKUP TRIGGER (permitProcessLookup.ensurePermitProcessLookedUp — not this module's file,
 * which today skips the per-job lookup for ANY AHJ with a seeded process profile): does a shipped
 * profile leave this AHJ's permit process unanswered? True when no hand-written profile matches and
 * the one answer is UNKNOWN — the seeded row has flags but no words, and no cited state rule covers
 * it (Scottsdale's "Looks like combo permit (?)", Santa Fe County's bare "In-person: appointment
 * only"). Per-job research should run for such an AHJ, and — cited — it outranks the shipped row.
 */
export function shippedProfileNeedsPerJobLookup(project: ProjectRecord): boolean {
  const profile = findApplicationProfile(project);
  if (applicationProfiles.includes(profile) && profile.id !== "oregon-generic-epermitting") return false;
  return permitStructureAnswer(project).level === "unknown";
}

/**
 * THE ONE PREDICATE FOR THE LOOKUP TRIGGER (e2e-gap close, 2026-09-26): is a shipped process
 * profile AUTHORITATIVE for this AHJ — i.e. may the per-job lookup be skipped on its account?
 * ensurePermitProcessLookedUp (permitProcessLookup.ts) today skips the lookup for ANY AHJ that has
 * a seeded profile, so Santa Fe County's bare "In-person: appointment only" row kept the lookup
 * from ever running. Authoritative = a shipped profile exists AND it answers the process (a
 * hand-written profile, or a seeded row whose words settle the structure). The trigger's line
 * becomes: `if (shippedProfileIsAuthoritative(project as never)) return false;`
 */
export function shippedProfileIsAuthoritative(project: ProjectRecord): boolean {
  let hasProfile = false;
  try { hasProfile = Boolean(findAhjProcessProfile(project)); } catch { hasProfile = false; }
  if (!hasProfile) {
    // A hand-written application profile (Portland, Marion County…) is authoritative on its own.
    try {
      const profile = findApplicationProfile(project);
      return applicationProfiles.includes(profile) && profile.id !== "oregon-generic-epermitting";
    } catch { return false; }
  }
  try { return !shippedProfileNeedsPerJobLookup(project); } catch { return false; }
}

/** THE CODE-PROFILE AMENDMENT SURFACE (codeProfiles.ts — not this module's file): a state
 *  amendment whose summary claims the permit structure ("Separate building (structural) and
 *  electrical permits required") is a second answer to this question. The code panel should
 *  replace such an amendment's claim with permitStructureSentence(permitStructureAnswer(project)). */
export function amendmentClaimsPermitStructure(summary: string): boolean {
  const s = String(summary || "").toLowerCase();
  return /\bpermit/.test(s) && (/\bseparate\b[^.]{0,60}\belectrical\b|\bboth\b[^.]{0,40}\bbuilding\b[^.]{0,40}\belectrical\b|\bcombo\b|\bcombined\b[^.]{0,40}\bpermit\b/.test(s));
}

export const applicationProfiles: ApplicationRequirementProfile[] = [
  {
    id: "portland-devhub-solar",
    name: "City of Portland DevHub Solar",
    matchJurisdictions: ["portland", "city of portland"],
    portalName: "DevHub",
    sourceUrl: "https://www.portland.gov/ppd/solar-development/solar-permits",
    requiresAhjApplication: false,
    requiresStructuralApplication: false,
    requiresElectricalApplication: false,
    requiresPrescriptiveChecklist: true,
    requiresBidSheet: false,
    requiresPortalEntryOnly: true,
    requiredDocuments: [
      "DevHub solar application/worksheet answers",
      "Site/plot plan with array location",
      "Fire access/pathway plan",
      "Roof framing or structural documentation",
      "Roof cross-section or attachment detail",
      "Electrical one-line/3-line",
      "Module/inverter/racking specs",
    ],
    notes: [
      "Portland solar applications are submitted online through DevHub.",
      "Generate the worksheet for transfer into DevHub; do not upload this worksheet unless the reviewer asks for it.",
    ],
  },
  {
    id: "hillsboro-building-application",
    name: "City of Hillsboro Building Permit",
    matchJurisdictions: ["hillsboro", "city of hillsboro"],
    portalName: "Email / ProjectDox when required",
    sourceUrl: "https://www.hillsboro-oregon.gov/services/permitting-center/developers-contractors/building-permits",
    requiresAhjApplication: true,
    requiresStructuralApplication: true,
    requiresElectricalApplication: true,
    requiresPrescriptiveChecklist: true,
    requiresBidSheet: false,
    requiresPortalEntryOnly: false,
    requiredDocuments: [
      "Building permit application transfer sheet",
      "Electrical permit application transfer sheet",
      "Prescriptive solar checklist",
      "Residential site plan",
      "Plan set and specifications",
    ],
    notes: ["Hillsboro states applicants should download/fill the appropriate application and email it unless directed into review."],
  },
  {
    id: "clackamas-solar",
    name: "Clackamas County Solar",
    matchJurisdictions: ["clackamas", "clackamas county"],
    portalName: "Clackamas Accela / Online Permits",
    sourceUrl: "https://www.clackamas.us/building/solar.html",
    requiresAhjApplication: true,
    requiresStructuralApplication: true,
    requiresElectricalApplication: true,
    requiresPrescriptiveChecklist: true,
    requiresBidSheet: false,
    requiresPortalEntryOnly: false,
    requiredDocuments: [
      "Building Permit Application",
      "Renewable Electrical Energy Application",
      "Solar Prescriptive Checklist",
      "Plot plan",
      "Construction documents",
    ],
    notes: ["Clackamas identifies both building and electrical permits for PV systems."],
  },
  {
    id: "crook-county-solar",
    name: "Crook County Residential Solar",
    matchJurisdictions: ["crook", "crook county"],
    portalName: "Oregon ePermitting",
    sourceUrl: "https://crookcountyor.gov/1319/Solar",
    requiresAhjApplication: true,
    requiresStructuralApplication: true,
    requiresElectricalApplication: false,
    requiresPrescriptiveChecklist: true,
    requiresBidSheet: true,
    requiresPortalEntryOnly: false,
    requiredDocuments: [
      "Solar Structural Permit Application",
      "Bid Sheet",
      "Site plan with firefighter access and escape pathways",
      "Plan set and specifications",
    ],
    notes: ["Crook County says their solar application must be filled out and uploaded to Oregon ePermitting."],
  },
  {
    id: "oregon-city-solar",
    name: "Oregon City Solar PV",
    matchJurisdictions: ["oregon city"],
    portalName: "Oregon City / ePermitting",
    sourceUrl: "https://www.orcity.org/3224/Solar-PV-installation",
    requiresAhjApplication: false,
    requiresStructuralApplication: false,
    requiresElectricalApplication: false,
    requiresPrescriptiveChecklist: true,
    requiresBidSheet: false,
    requiresPortalEntryOnly: true,
    requiredDocuments: ["Prescriptive solar installation checklist", "Site/fire pathway plan", "Plan set and specifications"],
    notes: ["Oregon City publishes prescriptive/non-prescriptive PV paths and links to apply online."],
  },
  {
    id: "washington-county-bdas",
    name: "Washington County BDAS Prescriptive Solar",
    matchJurisdictions: ["washington county"],
    portalName: "BDAS / ProjectDox",
    sourceUrl: "https://www.washingtoncountyor.gov/lut/building-services/building-and-development-application-services",
    requiresAhjApplication: false,
    requiresStructuralApplication: false,
    requiresElectricalApplication: false,
    requiresPrescriptiveChecklist: true,
    requiresBidSheet: false,
    requiresPortalEntryOnly: true,
    requiredDocuments: ["BDAS prescriptive solar portal entry", "Plan set", "ProjectDox upload package"],
    notes: ["Washington County lists Prescriptive Solar Permit as available through BDAS."],
  },
  {
    id: "salem-pac-solar-array",
    name: "City of Salem PAC Solar Array",
    matchJurisdictions: ["salem", "city of salem"],
    portalName: "PAC Portal",
    sourceUrl: "https://www.cityofsalem.net/business/building-in-salem/fees-and-forms/building-permit-applications-and-forms",
    requiresAhjApplication: false,
    requiresStructuralApplication: false,
    requiresElectricalApplication: false,
    requiresPrescriptiveChecklist: false,
    requiresBidSheet: false,
    requiresPortalEntryOnly: true,
    requiredDocuments: ["PAC Portal Solar Array application fields", "Plan set", "Specifications"],
    notes: ["Salem lists Solar Array as an online permit application through the PAC Portal."],
  },
  {
    id: "marion-county-keizer-solar",
    name: "Marion County / Keizer Solar (Oregon ePermitting)",
    // Marion County processes solar permits for Keizer, Hubbard, Mount Angel, Gervais,
    // Scotts Mills and unincorporated Marion County. Match all of them.
    matchJurisdictions: ["keizer", "marion county", "marion co", "hubbard", "mount angel", "gervais", "scotts mills"],
    portalName: "Oregon ePermitting (Accela)",
    sourceUrl: "https://aca.oregon.gov/CitizenAccess/",
    requiresAhjApplication: false,
    // Structural application is required for the NON-prescriptive (engineered) path only;
    // the prescriptive path uses the prescriptive application instead. The doc builder
    // resolves which one from the project's permit path — never both.
    requiresStructuralApplication: true,
    // The "renewable energy" (electrical) application is required for the PV interconnection.
    requiresElectricalApplication: true,
    requiresPrescriptiveChecklist: true,
    requiresBidSheet: false,
    requiresPortalEntryOnly: true,
    // Oregon requires a SEPARATE structural permit AND electrical permit for solar
    // (OAR 918-050-0180; Oregon BCD form 440-5952 header: "Separate electrical permits
    // are required for these installations"). Filing only the structural permit leaves
    // the electrical (renewable-energy) permit unfiled — the exact "docs still missing"
    // bounce. So this is "separate", not "combo".
    permitStructure: "separate",
    submissionMethod: "Oregon ePermitting (Accela)",
    requiredDocuments: [
      "PRESCRIPTIVE PATH → 'Prescriptive Solar Photovoltaic Installation Permit Application' (Marion County B-01S) — flat fee, no plan review",
      "NON-PRESCRIPTIVE PATH → 'Structural Permit Application' (Marion County B-01, the standard building permit) — valuation-based fee + 65% plan-review fee; upload only the one that matches your path, never both",
      "Renewable Energy (electrical) permit application — REQUIRED on every PV interconnection (separate electrical permit, OAR 918-050-0180)",
      "Oregon prescriptive rooftop PV checklist (BCD 440-5952) on the prescriptive path",
      "PE-stamped structural plans + sealed structural letter/calcs on the non-prescriptive path",
      "Plan set: site/plot plan w/ fire pathways, electrical SLD (RSD + 705.12), structural roof framing + attachment detail, module spec, inverter spec, label/placard schedule",
      "Electrical permit covers the main panel/service upgrade (MPU) when in scope",
    ],
    notes: [
      "Marion County processes Keizer/Hubbard/Mount Angel/Gervais roof-mount solar on Oregon ePermitting (Accela).",
      "TWO permits: a structural permit AND a SEPARATE electrical (renewable-energy) permit are required (OAR 918-050-0180). File BOTH.",
      "PRESCRIPTIVE = 'Prescriptive Solar Photovoltaic Installation Permit Application' (B-01S): meets OSSC 3111.4.8 + 3111.5 prescriptive path, NO plan review, flat reduced fee (~$67.25 + 12% surcharge).",
      "NON-PRESCRIPTIVE = 'Structural Permit Application' (B-01, standard building permit): does NOT meet prescriptive code, WILL require plan review (65% of permit fee), valuation-based fees, and a PE-stamped plan set + structural engineering letter must be attached.",
      "The Prescriptive Solar form states: 'For permits that do not comply with this section use the standard building permit application.' Upload ONLY the one that pertains — do NOT upload both.",
      "The renewable-energy (electrical) permit application is required for EVERY interconnection, not just MPU jobs.",
    ],
  },
  {
    id: "junction-city-solar",
    name: "Junction City Solar (Oregon ePermitting / Accela)",
    matchJurisdictions: ["junction city", "city of junction city"],
    portalName: "Oregon ePermitting (Accela)",
    sourceUrl: "https://aca.oregon.gov/CitizenAccess/",
    requiresAhjApplication: false,
    requiresStructuralApplication: true,
    requiresElectricalApplication: true,
    requiresPrescriptiveChecklist: true,
    requiresBidSheet: false,
    requiresPortalEntryOnly: true,
    permitStructure: "separate",
    submissionMethod: "Oregon ePermitting (Accela)",
    requiredDocuments: [
      "Plan set (stamped for non-prescriptive, standard for prescriptive)",
      "Oregon Prescriptive Solar PV Checklist (BCD 440-5952) — prescriptive path only",
      "PE-stamped structural plans + sealed engineering letter — non-prescriptive path only",
      "Electrical permit application (City of Junction City Building Division)",
      "Site plan",
      "Single-line diagram",
      "Module spec sheet",
      "Inverter spec sheet",
    ],
    notes: [
      "Junction City processes solar permits through Oregon ePermitting (Accela ACA) at ePermitting.oregon.gov.",
      "Oregon OAR 918-050-0180 requires SEPARATE structural and electrical permits statewide — no combo permits.",
      "PRESCRIPTIVE PATH (B-01S equivalent): snow ≤70 PSF, dead load ≤4.5 PSF, rafter/truss spacing ≤24\" OC, wind exposure B/C. Reduced flat fee, no plan review.",
      "NON-PRESCRIPTIVE PATH: requires PE-stamped plans, structural calcs, and sealed engineering letter. Full plan review fee.",
      "Oregon prescriptive PV checklist (BCD 440-5952) required on prescriptive path.",
      "A separate electrical permit from the City of Junction City's Building Division is required.",
      "Utility interconnection (NEM): Pacific Power / PacifiCorp customer generation is filed on a PowerClerk tenant (pacificorpnetmetering.powerclerk.com); pacificpower.net is the marketing/resource site, not the application portal.",
    ],
  },
  {
    id: "oregon-generic-epermitting",
    name: "Generic Oregon ePermitting Solar",
    matchJurisdictions: ["oregon", "generic"],
    portalName: "Oregon ePermitting",
    sourceUrl: "https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx",
    requiresAhjApplication: false,
    requiresStructuralApplication: false,
    requiresElectricalApplication: false,
    requiresPrescriptiveChecklist: true,
    requiresBidSheet: false,
    requiresPortalEntryOnly: true,
    requiredDocuments: ["Residential/Commercial Structural Solar PV portal entry", "Prescriptive/non-prescriptive checklist", "Plan set and specs"],
    notes: ["Use this fallback when the AHJ is in Oregon but no specific local profile is seeded yet."],
  },
];

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function payload(project: ProjectRecord, key: string): string {
  return clean(project.parserSnapshot[key]);
}

/** A rating that already carries its unit ("225A", "200 amps") without it — the template adds " A". */
function ampsOnly(value: string): string {
  return String(value ?? "").replace(/\s*(?:a|amps?|amperes?)\.?\s*$/i, "");
}

function yesNo(value: string): string {
  return value ? value : "[verify]";
}

// Synthesize an application profile from the AHJ PROCESS profile (the 380+ seeded
// jurisdiction records). This is the generalized accuracy fix: any AHJ we have real
// process knowledge for gets its true required-document set + submission method, even
// without a hand-written static profile — so the doc builder pulls the right forms
// for "the AHJs we give it" instead of falling back to a generic package.
function applicationProfileFromProcess(project: ProjectRecord): ApplicationRequirementProfile | null {
  const proc = findAhjProcessProfile(project);
  if (!proc) return null;
  const notes = `${proc.reviewerNotes || ""} ${proc.otherRequirements || ""} ${proc.submissionMethod || ""}`.toLowerCase();
  // Treat the profile as "informative" only when it actually carries some signal —
  // a bare stub (all flags false, no method, no notes) shouldn't override the OR generic.
  const hasSignal =
    proc.requiresPlanSet || proc.requiresStructuralStamp || proc.requiresElectricalStamp ||
    proc.requiresElectricalPermitApplication || proc.requiresBuildingPermitApplication ||
    proc.requiresSolarChecklist || proc.requiresCustomerSignature ||
    Boolean((proc.submissionMethod || "").trim()) || notes.replace(/\s+/g, "").length > 12;
  if (!hasSignal) return null;

  const method = (proc.submissionMethod || "").toLowerCase();
  // WHOLE WORDS: a bare "aca" substring matched "placa", "vacaville"; "accela" and "e-permitting"
  // name a platform, not a state.
  const accela = /\baccela\b|\baca\b/.test(method) || /\baccela\b/.test(notes);
  const isEpermitting = accela || /\be-?permitting\b/.test(method) || /\be-?permitting\b/.test(notes);
  const isProjectDox = /projectdox|avolve/.test(method) || /projectdox|avolve/.test(notes);
  const isEmail = /email/.test(method) || /email/.test(notes);
  const portalOnly = isEpermitting || isProjectDox || /portal|online/.test(method);
  // AN IN-PERSON CLAUSE IN THE SEEDED METHOD IS THE CHANNEL. Bernalillo County's reads "BPA: In person
  // EPA: Bernalillo County accela" — the building permit is filed at the counter; labelling the whole
  // AHJ a portal hid the in-person banner. The seeded words go through verbatim, and channelKindOf
  // reads an in-person clause before a platform word.
  const inPerson = /\bin[\s-]?person\b|\bover[\s-]the[\s-]counter\b|\bwalk[\s-]?in\b|\bdrop[\s-]?off\b/.test(method);

  const wantsElectricalApp = proc.requiresElectricalPermitApplication || proc.requiresElectricalStamp || /renewable energy app|electrical app/.test(notes);
  const wantsBuildingApp = proc.requiresBuildingPermitApplication;
  const wantsStructuralApp = proc.requiresStructuralStamp || /struct app|structural app/.test(notes) || wantsBuildingApp;
  // "Is this Oregon" is the project's STATE and nothing else (usStateCode — one predicate).
  const oregon = usStateCode(project.state) === "OR";
  const wantsChecklist = proc.requiresSolarChecklist || /checklist/.test(notes) || oregon;

  // THE OREGON TEMPLATE IS OREGON'S. "Solar application — PRESCRIPTIVE or STRUCTURAL", the
  // "Renewable Energy (electrical)" application and the prescriptive checklist are Oregon's
  // statewide vocabulary (OAR 918-050-0180, BCD 440-5952). Printed for Scottsdale and Santa Fe
  // they stated an Oregon filing as that AHJ's requirement (new-AHJ e2e, 2026-09-26). Outside
  // Oregon the lines are the AHJ's own, in neutral words, and say they come from the seeded
  // flags — unless the per-job lookup found this AHJ's documents, which replace them.
  const requiredDocuments: string[] = [];
  if (oregon) {
    if (wantsStructuralApp || wantsChecklist) {
      requiredDocuments.push("Solar application — PRESCRIPTIVE or STRUCTURAL (upload only the one that matches your path; never both)");
    }
    if (wantsElectricalApp) requiredDocuments.push("Renewable Energy (electrical) permit application");
    if (wantsChecklist) requiredDocuments.push("Solar prescriptive checklist");
  } else {
    if (wantsStructuralApp) requiredDocuments.push("The AHJ's building permit application (seeded flag — confirm its name on the AHJ site)");
    if (wantsElectricalApp) requiredDocuments.push("The AHJ's electrical permit application (seeded flag — confirm whether the AHJ files it separately)");
    if (proc.requiresSolarChecklist) requiredDocuments.push("The AHJ's solar checklist (seeded flag — confirm it on the AHJ site)");
  }
  if (/mpu|panel upgrade|service upgrade/.test(notes)) requiredDocuments.push("Electrical permit application (when a main panel/service upgrade is in scope)");
  if (proc.requiresPlanSet) requiredDocuments.push("Plan set and specifications");
  // Single stamp authority: fires on the profile flag AND on this project's own
  // engineered path — previously a stamped-path project whose profile lacked the
  // flag got no stamped-plans line here.
  if (resolveStampRequirement(project, { processProfileRequiresStamp: proc.requiresStructuralStamp, jurisdictionLabel: proc.ahj }).required) {
    requiredDocuments.push(oregon ? "PE-stamped structural plans + engineering letter (non-prescriptive path)" : "PE-stamped structural plans + engineering letter");
  }
  if (!requiredDocuments.length) requiredDocuments.push("Plan set and specifications");

  // OREGON ePERMITTING IS OREGON'S. Tampa, Coral Springs, Sacramento and Bernalillo run their OWN
  // Accela; outside Oregon the platform is named neutrally, and a non-Accela "e-permitting" portal
  // keeps the AHJ's own words.
  const submissionMethod = inPerson ? (proc.submissionMethod || "In person")
    : isEpermitting && oregon ? "Oregon ePermitting (Accela)"
    : accela ? "Accela Citizen Access (online portal)"
    : isEpermitting ? (proc.submissionMethod || "Online e-permitting portal")
    : isProjectDox ? "ProjectDox (online plan review)"
    : isEmail ? "Email"
    : (proc.submissionMethod || "Verify on the AHJ site");

  // A SEEDED NOTE IS A NOTE, NOT AN INSTRUCTION. Scottsdale's reads 'Select "Solar Systems/Green
  // Including Commercial Solar Projects"' — the portal's real type is "Residential Solar" — and the
  // manifest printed it as an imperative. It is labelled as the operator's unverified reference.
  const notesOut = [`Synthesized from the seeded ${proc.ahj} process profile (operator reference sheet${proc.sourceSheet ? ` "${proc.sourceSheet}"` : ""}; not confirmed on an agency page).`];
  if (proc.reviewerNotes) notesOut.push(`Seeded reference note (unverified): ${proc.reviewerNotes}`);
  if (proc.timeline) notesOut.push(`Typical timeline (seeded): ${proc.timeline}.`);

  return {
    id: `process-${proc.ahj.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
    name: `${proc.ahj} (from process knowledge)`,
    matchJurisdictions: [],
    portalName: submissionMethod,
    sourceUrl: "",
    requiresAhjApplication: wantsBuildingApp,
    requiresStructuralApplication: wantsStructuralApp,
    requiresElectricalApplication: wantsElectricalApp,
    requiresPrescriptiveChecklist: wantsChecklist,
    requiresBidSheet: false,
    // A portal in the process data means completed docs are SUBMITTED online —
    // not that no PDF forms exist. ProjectDox/Avolve and most Accela AHJs still
    // take filled PDF applications as uploads, and this flag short-circuits AHJ
    // form acquisition before any research runs (the Clark Co WA "no documents
    // pulled" bug). Only hand-written registry profiles may claim
    // portal-entry-only; the acquisition research itself reports genuinely
    // PDF-less portals.
    requiresPortalEntryOnly: false,
    // Flags are not a structure (permitStructureAnswer, level 5): two spreadsheet flags filed
    // "separate — both must be filed" for Scottsdale, which files ONE Residential Solar permit.
    permitStructure: "unknown",
    submissionMethod,
    requiredDocuments,
    notes: notesOut,
  };
}

/** THE PER-JOB LOOKUP'S DOCUMENTS, cited, when it found any — they replace a seeded or generic
 *  document list (per-job research over a stale shipped profile). null when nothing was found. */
function lookedUpDocuments(project: ProjectRecord): { documents: string[]; note: string } | null {
  const lk = permitProcessFor(project);
  const docs: string[] = [];
  const sources: string[] = [];
  for (const permit of lk?.permits ?? []) {
    const d = permit.documents;
    if (!d || !Array.isArray(d.value) || !d.value.length || !/^https?:\/\//i.test(d.sourceUrl || "")) continue;
    const prefix = (lk?.permits?.length ?? 0) > 1 ? `${permit.label || permit.discipline}: ` : "";
    for (const item of d.value) {
      const line = `${prefix}${String(item).trim()}`;
      if (String(item).trim() && !docs.includes(line)) docs.push(line);
    }
    if (!sources.includes(d.sourceUrl)) sources.push(d.sourceUrl);
  }
  if (!docs.length) return null;
  return { documents: docs, note: `Required documents from the per-job lookup (seeded, cited): ${sources.join(", ")}.` };
}

// registryTermMatches (whole words, same kind) lives in processProfiles, beside the kind helpers it
// uses — ahjForms' built-in registry asks the same question and cannot import this module (cycle).

export function findApplicationProfile(project: ProjectRecord): ApplicationRequirementProfile {
  // The hand-written registry is OREGON-specific, but its match terms are bare
  // jurisdiction names that collide across states ("Washington County", "Salem",
  // "Marion County", "Portland" all exist elsewhere). Without this state gate an
  // out-of-state project silently inherited an Oregon profile — including
  // requiresPortalEntryOnly:true flags that SKIP AHJ form acquisition entirely
  // (seen as "no documents pulled" on a WA county).
  // "IS THIS OREGON" IS THE PROJECT'S STATE — usStateCode, the one predicate. A town named Oregon
  // (WI, IL, OH, MO) is not Oregon, and a BLANK state is unknown, never Oregon: both used to pick up
  // Oregon's portal-only profiles, which skip form acquisition and un-block the application rows.
  const oregonProject = usStateCode(project.state) === "OR";
  // THE PROJECT'S AHJ decides which jurisdiction this is; its mailing city is consulted only when
  // the AHJ field names no place (empty, or only department words). A substring test over
  // "ahj + city" handed a Marion County project with a Salem address the CITY of Salem's PAC
  // profile (array order) — the same county-vs-city confusion as Santa Fe (processProfiles).
  const ahjName = String(project.ahj ?? "").trim();
  const jurisdictionName = jurisdictionCore(ahjName) ? ahjName : String(project.city ?? "").trim();
  const specific = oregonProject && jurisdictionName
    ? applicationProfiles.find((profile) =>
        profile.id !== "oregon-generic-epermitting" && profile.matchJurisdictions.some((term) => registryTermMatches(jurisdictionName, term)),
      )
    : undefined;
  if (specific) return specific;
  // No hand-written profile — synthesize from the AHJ's seeded process knowledge so
  // we still pull the right forms for jurisdictions we have real data on.
  const found = lookedUpDocuments(project);
  const synthesized = applicationProfileFromProcess(project);
  if (synthesized) return found ? { ...synthesized, requiredDocuments: found.documents, notes: [found.note, ...synthesized.notes] } : synthesized;
  if (oregonProject) {
    const generic = applicationProfiles.find((profile) => profile.id === "oregon-generic-epermitting")!;
    return found ? { ...generic, requiredDocuments: found.documents, notes: [found.note, ...generic.notes] } : generic;
  }
  if (found) {
    return {
      id: "lookup-per-job",
      name: `${project.ahj || "This AHJ"} (per-job lookup)`,
      matchJurisdictions: [],
      portalName: "Unknown",
      sourceUrl: "",
      requiresAhjApplication: false,
      requiresStructuralApplication: false,
      requiresElectricalApplication: false,
      requiresPrescriptiveChecklist: false,
      requiresBidSheet: false,
      requiresPortalEntryOnly: false,
      requiredDocuments: found.documents,
      notes: [found.note],
    };
  }
  return {
    id: "generic-unknown-ahj",
    name: "Generic AHJ Package",
    matchJurisdictions: [],
    portalName: "Unknown",
    sourceUrl: "",
    requiresAhjApplication: false,
    requiresStructuralApplication: false,
    requiresElectricalApplication: false,
    requiresPrescriptiveChecklist: false,
    requiresBidSheet: false,
    requiresPortalEntryOnly: false,
    requiredDocuments: ["Cover sheet", "Submittal manifest", "Plan set", "Equipment specifications"],
    notes: ["No seeded AHJ application profile matched. Generate cover/manifest only and verify AHJ requirements manually."],
  };
}

export interface PermitTypeInfo {
  /** "combo" = one combined building+electrical permit; "separate" = distinct BLD + ELE permits. */
  structure: "combo" | "separate" | "unknown";
  /** Normalized submission method/platform, e.g. "Oregon ePermitting (Accela)", "ProjectDox", "Email". */
  submissionMethod: string;
  /** One-line human callout, e.g. "Separate building (BLD) + electrical (ELE) permits — submitted via Oregon ePermitting." */
  callout: string;
}

// Derive the permit TYPE (combo vs separate building/electrical) and how it's
// submitted, from the profile's flags + portal name (honoring explicit overrides
// and any learned method/platform). This is what the UI and the form-search
// callout surface so the operator always knows what kind of permitting an AHJ uses.
export function describePermitType(
  profile: ApplicationRequirementProfile,
  learned: { submissionMethod?: string; portalPlatform?: string; answer?: PermitStructureAnswer } = {},
): PermitTypeInfo {
  // Structure — permitStructureAnswer's, and nothing else. This function used to re-derive it
  // from the profile's flags and from whatever an uncited research pass said, which is how the
  // form finder printed "both must be filed" beside tracks that said "combo". No answer passed
  // = not confirmed.
  const answer: PermitStructureAnswer = learned.answer ?? {
    structure: "unknown", level: "unknown", basis: "Permit structure: not resolved", sourceUrl: "", quote: "", hint: "", prerequisites: [],
  };
  const structure: PermitTypeInfo["structure"] = answer.structure;

  // Submission method/platform.
  const blob = `${profile.portalName} ${(profile.notes || []).join(" ")} ${learned.submissionMethod || ""} ${learned.portalPlatform || ""}`.toLowerCase();
  let submissionMethod = profile.submissionMethod || "";
  if (!submissionMethod) {
    // Email first: when an AHJ's portal name lists email as the channel (e.g.
    // "Email / ProjectDox when required"), email is the primary submittal and
    // ProjectDox is the conditional plan-review step — keep this consistent with
    // the email-draft card. Pure-portal AHJs don't mention email and fall through.
    if (/email/.test(`${profile.portalName} ${learned.submissionMethod || ""}`.toLowerCase())) {
      submissionMethod = /projectdox|avolve/.test(blob) ? "Email (ProjectDox when directed into review)" : "Email";
    } else if (/projectdox|avolve/.test(blob)) submissionMethod = "ProjectDox (online plan review)";
    else if (/portland.*(devhub|hub|portal)/.test(blob)) submissionMethod = "Portland DevHub portal";
    // Oregon ePermitting only for an Oregon profile (the hand-written registry is Oregon's and
    // state-gated in findApplicationProfile) or text that names it; any other Accela / e-permitting
    // platform is named neutrally — a learned "Accela" in Florida is Florida's own portal.
    else if (/\boregon\s*e-?permitting\b/.test(blob) || (applicationProfiles.some((p) => p.id === profile.id) && /\be-?permitting\b|\baccela\b/.test(blob))) submissionMethod = "Oregon ePermitting (Accela)";
    else if (/\baccela\b/.test(blob)) submissionMethod = "Accela Citizen Access (online portal)";
    else if (/\be-?permitting\b/.test(blob)) submissionMethod = "Online e-permitting portal";
    else if (profile.requiresPortalEntryOnly) submissionMethod = "Online portal";
    else submissionMethod = "Unknown — verify on the AHJ site";
  }

  const { core, pre } = permitStructureParts(answer);
  const callout = `${core} — submitted via ${submissionMethod}.${pre}`;
  return { structure, submissionMethod, callout };
}

export interface SubmittalEmailDraft {
  isEmailSubmittal: boolean;
  to: string;
  subject: string;
  body: string;
}

// Detect whether this AHJ takes the completed application by EMAIL (vs a portal),
// using the seeded profile + any learned KB hints passed in.
function isEmailSubmittalProfile(profile: ApplicationRequirementProfile, learnedMethod = "", learnedPlatform = ""): boolean {
  const blob = `${profile.portalName} ${(profile.notes || []).join(" ")} ${learnedMethod} ${learnedPlatform}`.toLowerCase();
  if (/email/.test(blob)) return true;
  // Portal-only / known portal platforms are NOT email.
  if (profile.requiresPortalEntryOnly) return false;
  return false;
}

// Draft a permit submittal email for email-submittal AHJs. Deterministic (no LLM) —
// subject pattern: "<company> - BLD, ELE Permit submittal - <customer> - <address>".
export function buildSubmittalEmailDraft(
  project: ProjectRecord,
  opts: { companyName?: string; toEmail?: string; learnedMethod?: string; learnedPlatform?: string } = {},
): SubmittalEmailDraft {
  const profile = findApplicationProfile(project);
  const isEmail = isEmailSubmittalProfile(profile, opts.learnedMethod, opts.learnedPlatform);
  const answer = permitStructureAnswer(project);
  const permitType = describePermitType(profile, { submissionMethod: opts.learnedMethod, portalPlatform: opts.learnedPlatform, answer });
  const company = (opts.companyName || "").trim() || "Our company";
  const customer = (project.homeownerName || "Customer").trim();
  const addr = [project.projectAddress, [project.city, project.state, project.zip].filter(Boolean).join(", ")].filter(Boolean).join(", ");
  // Subject reflects the ONE permit-structure answer: "BLD, ELE Permit submittal" only when two
  // permits are settled; combo AND unknown → "Permit submittal". Unknown used to fall through to
  // "BLD, ELE", which is how all seven new-AHJ jobs got it (three of them file one permit).
  const permitTag = permitType.structure === "separate" ? "BLD, ELE Permit submittal" : "Permit submittal";
  const subject = `${company} - ${permitTag} - ${customer} - ${project.projectAddress || addr}`;

  const snap = (project.parserSnapshot || {}) as Record<string, unknown>;
  const s = (k: string): string => (snap[k] == null ? "" : String(snap[k]));
  const moduleLine = [s("moduleQty") && `${s("moduleQty")}×`, s("moduleMake"), s("moduleModel"), s("moduleWattage") && `${s("moduleWattage")}W`].filter(Boolean).join(" ");
  const inverterLine = [s("invModel") || s("pvMicroModel"), (s("invQty") || s("pvMicroQty")) && `×${s("invQty") || s("pvMicroQty")}`].filter(Boolean).join(" ");
  const sysLine = [project.systemSizeDcKw && `${project.systemSizeDcKw} kW DC`, project.systemSizeAcKw && `${project.systemSizeAcKw} kW AC`].filter(Boolean).join(" / ");
  // System addition: tell the AHJ up front that an existing PV system remains in
  // service, with the existing + combined sizes when the parser captured them.
  // Explicit "yes" only — existingSystem:"no" must not read as an addition.
  const isAddition = /^yes$/i.test(s("hasExistingSystem")) || /^yes$/i.test(s("existingSystem"));
  const existingLine = isAddition
    ? ["Addition to existing PV system", s("existingDcKw") && `existing ${s("existingDcKw")} kW DC`, s("combinedDcKw") && `combined ${s("combinedDcKw")} kW DC`].filter(Boolean).join(" — ")
    : "";

  const docs = (profile.requiredDocuments && profile.requiredDocuments.length
    ? profile.requiredDocuments
    : [permitType.structure === "separate" ? "Building permit application" : "Permit application", ...(permitType.structure === "separate" ? ["Electrical permit application"] : []), "Plan set", "Equipment specifications"]
  ).map((d) => `  - ${d}`).join("\n");

  const intro = permitType.structure === "combo"
    ? "Please find attached the combined building + electrical permit submittal for the following residential rooftop solar PV project:"
    : permitType.structure === "separate"
      ? "Please find attached the building (BLD) and electrical (ELE) permit submittal for the following residential rooftop solar PV project:"
      : "Please find attached the permit submittal for the following residential rooftop solar PV project:";
  const body = [
    "Hello,",
    "",
    intro,
    "",
    `Customer: ${customer}`,
    `Site address: ${addr || "[address]"}`,
    `AHJ: ${project.ahj || "[AHJ]"}`,
    sysLine ? `System: ${sysLine}` : "",
    existingLine ? `Scope: ${existingLine}` : "",
    moduleLine ? `Modules: ${moduleLine}` : "",
    inverterLine ? `Inverter: ${inverterLine}` : "",
    "",
    "Attached documents:",
    docs,
    "",
    "Please let us know if anything further is needed to complete intake. Thank you.",
    "",
    company,
  ].filter((l) => l !== "").join("\n");

  return { isEmailSubmittal: isEmail, to: (opts.toEmail || "").trim(), subject, body };
}

// The EXACT named application form an AHJ uses for each path, so the operator/bot pulls
// the right blank form. Falls back to a generic label for AHJs we haven't named yet.
export function namedApplicationForm(profile: ApplicationRequirementProfile, path: "prescriptive" | "engineered" | "unknown"): string {
  if (profile.id === "marion-county-keizer-solar") {
    if (path === "prescriptive") return "Prescriptive Solar Photovoltaic Installation Permit Application (Marion County B-01S)";
    if (path === "engineered") return "Structural Permit Application (Marion County B-01 — the standard building permit)";
    return "Marion County: Prescriptive Solar PV form (B-01S) OR Structural Permit Application (B-01) — pick one by path";
  }
  if (path === "prescriptive") return "the AHJ's prescriptive solar application / checklist";
  if (path === "engineered") return "the AHJ's structural (standard building) permit application";
  return "the AHJ's prescriptive OR structural application (pick one by path)";
}

// Local MPU-scope detection (kept here to avoid a circular import with submittalTracks).
function applicationHasMpuScope(project: ProjectRecord): boolean {
  const text = [
    payload(project, "projectDescriptionText"), payload(project, "description"),
    payload(project, "scopeText"), payload(project, "electricalCalcText"),
    payload(project, "sitePlanNotesText"), payload(project, "mpu"), payload(project, "serviceUpgrade"),
  ].join(" ").toLowerCase();
  return /\bmpu\b|main panel upgrade|main service panel upgrade|service (panel )?upgrade|\bmsp upgrade\b|panel upgrade|meter.?main upgrade/.test(text);
}

export function buildApplicationDocumentPackage(
  project: ProjectRecord,
  client: ClientRecord | null = null,
  /** agencyStatus: each issuing-agency line's status from the inventory
   *  (requiredDocuments.agencyListStatusResolver — the packet door passes it). Without it a line
   *  names its document and claims nothing about it (agency-apps-close MF3). */
  opts: { agencyStatus?: AgencyLineStatusOf | null } = {},
): ApplicationDocumentPackage {
  const matched = findApplicationProfile(project);
  // SAY IT ON THE PACKET WHEN THE JURISDICTION KNOWLEDGE WAS NEVER READ.
  //
  // findApplicationProfile degrades QUIETLY when the 381-profile AHJ process reference
  // is unreadable: applicationProfileFromProcess returns null for every jurisdiction,
  // so an Oregon project silently drops to the generic "oregon-generic-epermitting"
  // fallback and an out-of-state one to "Generic AHJ Package" — each of which renders
  // as a confident, named profile with its own notes. The operator reads a profile
  // name and a document list that were produced with none of this AHJ's real process
  // knowledge, and nothing on the screen says so.
  //
  // profile.notes is already rendered as "Jurisdiction notes" on the AHJ packet card
  // (frontend/dashboard.js) and is reproduced in the generated packet HTML below, so
  // this reaches the operator on the same screen the wrong list appears on. Copied,
  // never mutated: the registry profiles are module-level shared objects.
  const knowledge = ahjProcessKnowledgeStatus();
  const withKnowledge: ApplicationRequirementProfile = knowledge.status === "resolved" ? matched : {
    ...matched,
    notes: [
      `WARNING — the AHJ process reference (jurisdiction requirements for 381 AHJs) could not be read, so this package was built WITHOUT this jurisdiction's own process knowledge. The profile below is a generic fallback; treat its document list as unverified and check the AHJ's requirements by hand before submitting. Cause: ${knowledge.error || "unknown"}`,
      ...(matched.notes || []),
    ],
  };
  // THE ISSUING AGENCY'S FORMS ARE THE PACKET'S FORMS (operator finding 2026-09-27, City of
  // Jefferson / Marion County: "still only just pulling that one doc"). Where the per-job lookup
  // cites another agency as a permit's issuer, the packet's required list names that agency's own
  // applications, the state checklist on the prescriptive path and the city's prerequisite step —
  // never the generic fallback's "portal entry" line. Copied, never mutated.
  let agencyList: ReturnType<typeof issuingAgencyDocumentList> = null;
  try { agencyList = issuingAgencyDocumentList(project, opts.agencyStatus ?? null); } catch { agencyList = null; }
  const profile: ApplicationRequirementProfile = agencyList ? withIssuingAgencyList(withKnowledge, agencyList, project) : withKnowledge;
  const answer = permitStructureAnswer(project);
  const structure = answer.structure;
  const permitPath = resolvePermitPath(project);
  const hasMpu = applicationHasMpuScope(project);
  const missingFields = requiredProjectFields(project);
  // The prescriptive-vs-structural pair exists where a prescriptive rooftop-PV path is on file:
  // Oregon's statewide one, or a jurisdiction whose own limits were researched. Everywhere else
  // resolvePermitPath says STANDARD REVIEW — one building application, no choice.
  const oregonSplit = !permitPath.standardReview;
  const docs: GeneratedApplicationDocument[] = [
    buildCover(project, profile, client, permitPath),
    buildManifest(project, profile, answer, permitPath, hasMpu),
  ];

  if (profile.requiresAhjApplication || profile.requiresPortalEntryOnly) docs.push(buildAhjWorksheet(project, profile, client));

  // PRESCRIPTIVE vs STRUCTURAL application are MUTUALLY EXCLUSIVE — the AHJ publishes
  // both and you upload exactly one. Generate only the application that matches the
  // resolved path. Prescriptive → prescriptive application/checklist (no plan review,
  // reduced fee). Engineered → structural application + collect PE-stamped plans +
  // structural letter (plan review, full fees). When the path is still unknown we emit
  // a chooser doc so the operator picks before anything is uploaded.
  //
  // THAT SPLIT IS OREGON'S (BCD 440-5952 / the B-01S vs B-01 pair). Outside Oregon the AHJ
  // publishes its own building application; the package carries ONE building-side worksheet
  // (plus the stamped-document collection when the plan set needs a PE stamp), never a
  // prescriptive application or a "choose one of two" sheet the AHJ never published.
  if (!oregonSplit) {
    docs.push(buildStructuralWorksheet(project, profile, permitPath));
    if (permitPath.path === "engineered" && permitPath.needsEngineeredDocs) docs.push(buildEngineeredDocCollection(project, permitPath));
  } else if (permitPath.path === "engineered") {
    docs.push(buildStructuralWorksheet(project, profile, permitPath));
    docs.push(buildEngineeredDocCollection(project, permitPath));
  } else if (permitPath.path === "prescriptive") {
    docs.push(buildPrescriptiveApplication(project, profile, permitPath));
  } else {
    docs.push(buildPathChooser(project, permitPath));
    docs.push(buildPrescriptiveApplication(project, profile, permitPath));
    docs.push(buildStructuralWorksheet(project, profile, permitPath));
  }

  // Electrical / Renewable-Energy permit application — needed for separate-permit AHJs,
  // when the profile calls for it, or when an MPU is in scope (the MPU rides the
  // electrical/renewable-energy permit unless the AHJ folds it elsewhere).
  if (profile.requiresElectricalApplication || structure === "separate" || hasMpu) {
    docs.push(buildElectricalWorksheet(project, profile, hasMpu));
  }
  if (profile.requiresBidSheet) docs.push(buildBidSheet(project, profile));
  // The one state-gated utility identity (utilityIdentity): a CA "Pacific Gas and Electric" / "PGE" job is not
  // Portland General or PacifiCorp, and gets no worksheet written for their PowerClerk filings.
  if (knownPowerClerkUtility(project)) docs.push(buildUtilityWorksheet(project));

  return {
    projectId: project.id,
    profile,
    generatedAt: nowIso(),
    docs,
    missingFields,
    html: packageHtml(project, profile, docs, missingFields, client),
    permitType: `${describePermitType(profile, { answer }).callout}${oregonSplit ? ` ${permitPathCallout(permitPath)}` : ""}`,
    // THE RESOLVED PATH, STRUCTURALLY — not only folded into permitType's prose.
    // The prescriptive and structural applications are mutually exclusive, so this one
    // decision picks which application the AHJ receives; until now it was only legible
    // inside the generated cover/manifest markdown, which meant an operator could not
    // see WHY it was decided or correct a wrong read without opening a document. The
    // screen renders path + source + basis and points at the existing override.
    permitPath: { path: permitPath.path, source: permitPath.source, basis: [...permitPath.basis] },
  };
}

/** The packet profile with the issuing agency's list in front: the agency items, then the base
 *  profile's lines the list does not replace (agency-apps-close MF2 — applicationDocsAgency.
 *  agencyListReplacesLine): a line for a TRACK another agency issues gives way to that agency's own
 *  application, the AHJ's checklist line to the state checklist the list carries; the AHJ's own
 *  lines for the tracks it issues itself stay (Coos Bay's building application where Coos County
 *  issues only the electrical permit), and so do the plan set, specs and stamps. The profile's other
 *  flags are left as they are — whether a track's application is a filled PDF or a portal entry is
 *  decided per row (requiredDocuments.requiredApplicationDocs, from the agency's known forms), and
 *  the packet keeps whatever transfer sheet the profile builds. */
function withIssuingAgencyList(profile: ApplicationRequirementProfile, list: AgencyDocumentList, project: ProjectRecord): ApplicationRequirementProfile {
  const kept = profile.requiredDocuments.filter((line) => !agencyListReplacesLine(list, line));
  const tracks = (agency: string): string => {
    const t = [...new Set(list.items.filter((i) => i.role === "application" && i.agency === agency).map((i) => i.track === "electrical" ? "electrical" : "structural (building)"))];
    return t.length ? `the ${t.join(" and ")} permit${t.length > 1 ? "s" : ""}` : "a permit";
  };
  return {
    ...profile,
    requiredDocuments: [...list.items.map((i) => i.text), ...kept],
    notes: [
      `The per-job lookup cites ${list.agencies.map((a) => `${a} as the agency that issues ${tracks(a)}`).join(", and ")}${list.sourceUrl ? ` (${list.sourceUrl})` : ""} — those applications are listed as that agency's own; ${project.ahj || "the AHJ"}'s own lines stay for any permit it issues itself.`,
      ...(profile.notes || []),
    ],
  };
}

function requiredProjectFields(project: ProjectRecord): string[] {
  const checks: Array<[string, string | number | null]> = [
    ["homeowner name", project.homeownerName],
    ["project address", project.projectAddress],
    ["city", project.city],
    ["state", project.state],
    ["AHJ", project.ahj],
    ["utility", project.utility],
    ["DC kW", project.systemSizeDcKw],
    ["AC kW", project.systemSizeAcKw],
    ["interconnection method", project.interconnectionMethod],
    ["module make/model", `${payload(project, "moduleMake")} ${payload(project, "moduleModel")}`.trim()],
    ["module quantity", payload(project, "moduleQty")],
    ["inverter model", payload(project, "invModel") || payload(project, "pvMicroModel")],
    ["bus rating", payload(project, "busRating")],
    ["main breaker", payload(project, "mainBreaker")],
    ["PV breaker/OCPD", payload(project, "pvBreaker")],
  ];
  return checks.filter(([, value]) => value == null || value === "").map(([name]) => name);
}

function doc(
  id: string,
  title: string,
  documentType: GeneratedApplicationDocument["documentType"],
  required: boolean,
  fileName: string,
  markdown: string,
): GeneratedApplicationDocument {
  return { id, title, documentType, required, fileName, markdown };
}

function commonProjectBlock(project: ProjectRecord): string {
  return [
    `Homeowner: ${project.homeownerName || "[verify]"}`,
    `Project address: ${project.projectAddress || "[verify]"}`,
    `AHJ: ${project.ahj || "[verify]"}`,
    `Utility: ${project.utility || "[verify]"}`,
    `Account number: ${project.accountNumber || "[verify]"}`,
    `Meter number: ${project.meterNumber || "[verify]"}`,
    `System size: ${project.systemSizeDcKw ?? "[verify]"} kW DC / ${project.systemSizeAcKw ?? "[verify]"} kW AC`,
    `Export: ${project.totalExportKw ?? "[verify]"} kW`,
    `Interconnection: ${project.interconnectionMethod || "[verify]"}`,
  ].join("\n");
}

function buildCover(project: ProjectRecord, profile: ApplicationRequirementProfile, client: ClientRecord | null, permitPath: PermitPathResolution): GeneratedApplicationDocument {
  const contractorBlock = client
    ? [
        `Contractor: ${client.legalBusinessName || client.companyName}`,
        client.businessAddress ? `Address: ${client.businessAddress}, ${client.businessCity}, ${client.businessState} ${client.businessZip}` : "",
        client.businessPhone ? `Phone: ${client.businessPhone}` : "",
        client.businessEmail ? `Email: ${client.businessEmail}` : "",
        // A LICENCE IS A STATE'S (clients.licenceFor): Oregon's CCB / electrical licence on an Oregon
        // job, exactly as before; elsewhere the licences the client holds in THAT state, by type.
        ...(isOregonJob(project)
          ? [client.ccbLicenseNumber ? `CCB: ${client.ccbLicenseNumber}` : "", client.electricalLicenseNumber ? `Electrical license: ${client.electricalLicenseNumber}` : ""]
          : stateLicenceLines(client, project.state)),
        client.authorizedSignerName ? `Authorized signer: ${client.authorizedSignerName}${client.authorizedSignerTitle ? `, ${client.authorizedSignerTitle}` : ""}` : "",
      ].filter(Boolean).join("\n")
    : "Contractor: [assign client to populate]";

  const pathLabel = permitPath.standardReview
    ? (permitPath.needsEngineeredDocs
      ? "STAMPED STRUCTURAL REVIEW (engineered design · PE-stamped plan set + sealed structural letter filed with the AHJ's building application)"
      : "STANDARD STRUCTURAL REVIEW (one building application on file for this jurisdiction — nothing to choose between)")
    : permitPath.path === "prescriptive" ? "PRESCRIPTIVE (meets prescriptive code · no plan review · reduced fee)"
    : permitPath.path === "engineered" ? "STRUCTURAL / ENGINEERED (non-prescriptive · plan review · full fees · PE stamp required)"
    : "NOT YET CONFIRMED — choose prescriptive vs engineered before uploading";

  return doc(
    "cover",
    "Submittal Cover Sheet",
    "cover",
    true,
    "01-submittal-cover-sheet.md",
    `# Solar Permit Submittal Cover Sheet

## Submitting Contractor

${contractorBlock}

## Project

${commonProjectBlock(project)}

## Permit Path: ${pathLabel}

${permitPathCallout(permitPath)}
${permitPath.basis.map((b) => `- ${b}`).join("\n")}

Submission profile: ${profile.name}
Portal/process: ${profile.portalName}
Official reference: ${profile.sourceUrl || "[verify AHJ source]"}

Operator notes:
- Verify all required fields before legal submission.
- Do not submit this package automatically.
- Transfer worksheet values into official AHJ forms or portal fields where required.
${permitPath.standardReview ? "- File the AHJ's own building application; its name and document list come from the AHJ, not from this sheet." : "- Upload ONLY the application that matches the permit path above — never both."}
`,
  );
}

function buildManifest(
  project: ProjectRecord,
  profile: ApplicationRequirementProfile,
  answer: PermitStructureAnswer,
  permitPath: PermitPathResolution,
  hasMpu: boolean,
): GeneratedApplicationDocument {
  const generatedDocs = profile.requiredDocuments.map((item) => `- ${item}`).join("\n");
  const separate = answer.structure === "separate";
  // The ONE answer's sentence and its basis — the same words the tracks and the form finder print.
  const structureLine = `Permit structure: ${permitStructureSentence(answer)}\nBasis: ${answer.basis}`;

  // The application line is path-driven — upload exactly one.
  const appLine = permitPath.standardReview
    ? (permitPath.needsEngineeredDocs
      ? "- The AHJ's building permit application, with the PE-stamped plan set + sealed structural letter attached (stamped structural review — one application)"
      : "- The AHJ's building permit application (standard structural review — one application, no choice between two)")
    : permitPath.path === "prescriptive"
    ? "- Prescriptive solar application + checklist  ← UPLOAD THIS ONE (do NOT upload the structural application)"
    : permitPath.path === "engineered"
      ? "- Structural (non-prescriptive) application + PE-stamped plans + structural letter  ← UPLOAD THIS ONE (do NOT upload the prescriptive application)"
      : "- Permit path NOT confirmed — choose prescriptive vs structural, then upload only that one application";

  return doc(
    "manifest",
    "Required Document Manifest",
    "manifest",
    true,
    "02-required-document-manifest.md",
    `# Required Document Manifest

Profile: ${profile.name}
${structureLine}

## ${permitPath.standardReview ? "Application to upload" : "Application to upload (mutually exclusive)"}
${appLine}

> ${permitPathCallout(permitPath)}

Required by profile:
${generatedDocs || "- No AHJ-specific required documents seeded. Verify manually."}

Generated by Autopilot:
- Cover sheet
- Required document manifest
${profile.requiresAhjApplication || profile.requiresPortalEntryOnly ? "- AHJ / portal application worksheet" : ""}
${permitPath.standardReview ? `- Building permit application worksheet${permitPath.needsEngineeredDocs ? "\n- Engineered document collection checklist (stamped plans + structural letter)" : ""}` : ""}
${!permitPath.standardReview && permitPath.path === "engineered" ? "- Structural (non-prescriptive) application worksheet\n- Engineered document collection checklist (stamped plans + structural letter)" : ""}
${!permitPath.standardReview && permitPath.path === "prescriptive" ? "- Prescriptive solar application worksheet (with checklist)" : ""}
${!permitPath.standardReview && permitPath.path === "unknown" ? "- Permit-path chooser\n- Prescriptive application (draft)\n- Structural application (draft)" : ""}
${profile.requiresElectricalApplication || separate || hasMpu ? `- ${electricalWorksheetTitle(project)}` : ""}
${hasMpu ? "- Electrical permit application is required because a main panel/service upgrade (MPU) is in scope" : ""}
${profile.requiresBidSheet ? "- Bid sheet worksheet" : ""}
${knownPowerClerkUtility(project) ? "- Utility/NEM application worksheet" : ""}

Profile notes:
${profile.notes.map((note) => `- ${note}`).join("\n")}
`,
  );
}

function buildAhjWorksheet(project: ProjectRecord, profile: ApplicationRequirementProfile, client: ClientRecord | null): GeneratedApplicationDocument {
  const contractorLine = client
    ? (isOregonJob(project)
      ? `${client.legalBusinessName || client.companyName} | CCB: ${client.ccbLicenseNumber || "[verify]"} | Elec: ${client.electricalLicenseNumber || "[verify]"} | Contact: ${client.contactName || client.authorizedSignerName || "[verify]"}`
      : `${client.legalBusinessName || client.companyName} | ${stateLicenceLines(client, project.state).join(" | ") || `${String(project.state || "").toUpperCase()} licence: [verify — none on file]`} | Contact: ${client.contactName || client.authorizedSignerName || "[verify]"}`)
    : "[assign client]";

  return doc(
    "ahj-worksheet",
    profile.requiresPortalEntryOnly ? "AHJ Portal Entry Worksheet" : "AHJ Application Transfer Sheet",
    "ahj_application",
    true,
    "03-ahj-application-worksheet.md",
    `# ${profile.requiresPortalEntryOnly ? "AHJ Portal Entry Worksheet" : "AHJ Application Transfer Sheet"}

Use this to fill ${profile.portalName}. If the AHJ requires an official PDF form, transfer these values into that form.

Contractor: ${contractorLine}

${commonProjectBlock(project)}

Project type: ${payload(project, "projectType") || "Roof-mounted solar PV"}
Scope of work:
Install ${(payload(project, "projectType") || "roof-mounted photovoltaic system").toLowerCase()}. ${project.systemSizeDcKw ?? "[verify]"} kW DC / ${project.systemSizeAcKw ?? "[verify]"} kW AC. Interconnection method: ${project.interconnectionMethod || "[verify]"}.${/^yes$/i.test(payload(project, "hasExistingSystem")) || /^yes$/i.test(payload(project, "existingSystem")) ? ` ADDITION to an existing PV system${payload(project, "existingDcKw") ? ` (existing ${payload(project, "existingDcKw")} kW DC${payload(project, "combinedDcKw") ? `, combined ${payload(project, "combinedDcKw")} kW DC` : ""})` : ""} — existing system remains in service.` : ""}

Equipment:
- Modules: ${yesNo(payload(project, "moduleQty"))} x ${yesNo(payload(project, "moduleMake"))} ${yesNo(payload(project, "moduleModel"))}, ${yesNo(payload(project, "moduleWattage"))} W
- Inverters/microinverters: ${yesNo(payload(project, "invQty") || payload(project, "pvMicroQty"))} x ${yesNo(payload(project, "invMake") || payload(project, "pvMicroMake"))} ${yesNo(payload(project, "invModel") || payload(project, "pvMicroModel"))}
- Battery/ESS: ${payload(project, "batteryModel") ? `${payload(project, "batteryQty")} x ${payload(project, "batteryMake")} ${payload(project, "batteryModel")}` : "None parsed / verify"}
- Racking: ${yesNo(payload(project, "racking"))}

Electrical:
- Service phase/voltage: ${yesNo(payload(project, "phase"))} / ${yesNo(payload(project, "voltage"))}
- MSP bus/main: ${yesNo(ampsOnly(payload(project, "busRating")))} A bus / ${yesNo(ampsOnly(payload(project, "mainBreaker")))} A main
- PV breaker/OCPD: ${yesNo(payload(project, "pvBreaker"))}
- AC disconnect: ${yesNo(payload(project, "acDiscReq"))} ${payload(project, "acDiscAmp") ? `(${payload(project, "acDiscAmp")} A)` : ""}
`,
  );
}

// The STRUCTURAL (non-prescriptive / engineered) application worksheet. Generated only
// on the engineered path. Carries a banner that this is the application to upload and
// that a PE-stamped plan set + structural letter must accompany it (collected below).
function buildStructuralWorksheet(project: ProjectRecord, _profile: ApplicationRequirementProfile, permitPath: PermitPathResolution): GeneratedApplicationDocument {
  if (permitPath.standardReview) {
    // Outside a prescriptive-path jurisdiction there is ONE building application — no
    // "non-prescriptive" framing, no "do NOT upload the prescriptive one".
    const standard = buildStructuralWorksheet(project, _profile, { ...permitPath, standardReview: false, path: "engineered" });
    return {
      ...standard,
      title: "Building Permit Application Worksheet",
      markdown: standard.markdown
        .replace(/^# .*$/m, "# Building Permit Application Worksheet")
        .replace(/^> .*$/m, `> File the AHJ's own building permit application (${permitPath.needsEngineeredDocs ? "stamped" : "standard"} structural review). ${permitPathCallout(permitPath)}`)
        // The recursive build prints the raw path token; here it is the review, not one of two.
        .replace(/^Permit path: .*$/m, `Permit path: ${permitPath.needsEngineeredDocs ? "stamped structural review (engineered design)" : "standard structural review"}`),
    };
  }
  const formName = namedApplicationForm(_profile, "engineered");
  const banner = permitPath.path === "engineered"
    ? `UPLOAD THIS APPLICATION (non-prescriptive): ${formName}. Do NOT upload the prescriptive application. This triggers plan review and full structural fees and requires a PE-stamped plan set + structural engineering letter.`
    : `Draft — only upload the structural application (${formName}) if the project is NON-prescriptive. Otherwise upload the prescriptive application instead.`;
  return doc(
    "structural",
    `Structural (Non-Prescriptive) Application — ${formName}`,
    "structural_application",
    true,
    "04-structural-building-worksheet.md",
    `# Structural (Non-Prescriptive) Application Worksheet — ${formName}

> ${banner}

${commonProjectBlock(project)}

Mounting: ${yesNo(payload(project, "mounting"))}
Roof material: ${yesNo(payload(project, "roofMaterial"))}
Racking/attachment: ${yesNo(payload(project, "racking"))}
Wind exposure: ${yesNo(payload(project, "wind"))}
Ground snow load: ${yesNo(payload(project, "snow"))} psf
PV dead load: ${yesNo(payload(project, "deadLoad"))} psf
Roof framing: ${yesNo(payload(project, "roofRafterSize"))} @ ${yesNo(payload(project, "roofRafterSpacing"))} in. o.c.
Wood grade/species: ${yesNo(payload(project, "woodGrade"))}
Rafter span: ${yesNo(payload(project, "roofRafterSpanFeet"))} ft

Permit path: ${permitPath.path}
Path basis:
${permitPath.basis.map((b) => `- ${b}`).join("\n")}
Stamp recommendation: ${yesNo(payload(project, "stampRecommendation"))}
`,
  );
}

/** "Renewable-Energy" is Oregon's name for its electrical solar permit (OAR 918-050-0180). Outside
 *  Oregon the worksheet is the AHJ's electrical permit application, in neutral words. */
function electricalWorksheetTitle(project: Pick<ProjectRecord, "state">): string {
  return String(project.state || "").trim().toUpperCase() === "OR"
    ? "Electrical / Renewable-Energy Application Worksheet"
    : "Electrical Permit Application Worksheet";
}

function buildElectricalWorksheet(project: ProjectRecord, _profile: ApplicationRequirementProfile, hasMpu: boolean): GeneratedApplicationDocument {
  const title = electricalWorksheetTitle(project);
  return doc(
    "electrical",
    title,
    "electrical_application",
    true,
    "05-electrical-application-worksheet.md",
    `# ${title}

${commonProjectBlock(project)}

Electrical scope:
- Interconnection: ${yesNo(project.interconnectionMethod)}
- Service: ${yesNo(payload(project, "phase"))}, ${yesNo(payload(project, "voltage"))}
- Bus/main: ${yesNo(payload(project, "busRating"))} A / ${yesNo(payload(project, "mainBreaker"))} A
- PV OCPD: ${yesNo(payload(project, "pvBreaker"))}
- AC disconnect: ${yesNo(payload(project, "acDiscReq"))}
- Locate callout: ${yesNo(payload(project, "locateCalloutText"))}
${hasMpu ? "\nMain panel / service upgrade (MPU) IS in scope — the electrical permit application is REQUIRED. Capture the new service/bus/main rating and any meter-main change on this application." : ""}
`,
  );
}

// The PRESCRIPTIVE solar application (with embedded prescriptive checklist). Generated
// only on the prescriptive path. This is the application to upload when the project
// meets prescriptive code — reduced fee, no plan review.
function buildPrescriptiveApplication(project: ProjectRecord, _profile: ApplicationRequirementProfile, permitPath: PermitPathResolution): GeneratedApplicationDocument {
  const formName = namedApplicationForm(_profile, "prescriptive");
  const banner = permitPath.path === "prescriptive"
    ? `UPLOAD THIS APPLICATION (prescriptive): ${formName}. Do NOT upload the structural application. Indicates the project meets prescriptive code — no plan review, reduced permit fee.`
    : `Draft — only upload the prescriptive application (${formName}) if the project meets prescriptive code. Otherwise upload the structural application instead.`;
  return doc(
    "prescriptive-application",
    `Prescriptive Solar Application + Checklist — ${formName}`,
    "checklist",
    true,
    "06-prescriptive-solar-application.md",
    `# Prescriptive Solar Application + Checklist

> ${banner}

${commonProjectBlock(project)}

${(project.state || "").trim().toUpperCase() === "OR"
  ? `Prescriptive code screen (all must be Yes to remain prescriptive):
${evaluatePrescriptiveCriteria(project).map((c) => `- ${c.label}: ${c.answer}${c.detail ? ` — ${c.detail}` : ""}`).join("\n")}`
  // WHOSE LIMITS ARE PRINTED HERE? evaluatePrescriptiveCriteria's rows carry Oregon's
  // ORSC / BCD 440-5952 thresholds unless a jurisdiction's own limits were researched
  // into its code profile. Printing them under another state's application header states
  // Oregon's numbers as that AHJ's requirement, to a plans examiner who has never heard
  // of them (audited 2026-09-22). Outside Oregon the rows are withheld and the document
  // says plainly that the screen has not been established for this jurisdiction.
  : `Prescriptive code screen — NOT ESTABLISHED FOR THIS JURISDICTION:
- The itemized screen this tool carries is Oregon's (ORSC / BCD 440-5952). ${project.ahj || project.state || "This jurisdiction"} has its own rules, and printing Oregon's numbers here would state them as this AHJ's requirement.
- Confirm ${project.ahj || "the AHJ"}'s prescriptive criteria against its own published checklist before filing, or record them on the jurisdiction's code profile so this screen fills in automatically next time.`}
- Firefighter access/pathways shown: ${/pathway|fire|access/i.test(`${payload(project, "sitePlanNotesText")} ${payload(project, "splitPagesText")}`) ? "Yes" : "[verify]"}
- Attachment/racking details included: ${payload(project, "racking") ? "Yes" : "[verify]"}

If ANY item above is No, the project is NON-prescriptive — switch to the structural
application, attach PE-stamped plans + a structural letter, and expect plan review + full fees.
`,
  );
}

// Engineered-path document collection. When a project is non-prescriptive, the submittal
// MUST carry a PE-stamped plan set + structural engineering letter/calcs. The autopilot
// does not produce a wet stamp — these come from the installer/engineer. We check whether
// they already appear in the parsed evidence and flag what still needs to be collected.
function buildEngineeredDocCollection(project: ProjectRecord, permitPath: PermitPathResolution): GeneratedApplicationDocument {
  const haveStamp = hasStampedStructuralEvidence(project);
  const status = haveStamp
    ? "DETECTED in the uploaded plan set/evidence — confirm the stamp is current and on the structural sheets."
    : "NOT detected in the uploaded files — REQUEST the stamped plans + structural letter from the installer/engineer of record before submitting.";
  const items = permitPath.requiredEngineeredDocs.map((d) => `- [${haveStamp ? "x" : " "}] ${d}`).join("\n");
  return doc(
    "engineered-docs",
    "Engineered Submittal — Stamped Plans & Structural Letter",
    "worksheet",
    true,
    "04b-engineered-documents.md",
    `# Engineered Submittal — Stamped Plans & Structural Letter

${permitPath.standardReview
    ? "This project's structural design is engineered (stamped), so the sealed structural documentation is filed with the AHJ's building permit application."
    : "This project is on the NON-PRESCRIPTIVE (engineered) path, so the AHJ requires sealed\nstructural documentation in addition to the structural application."}

Status: ${status}

Collect / attach:
${items}

Notes:
- The PE stamp must appear on the structural sheets (wet or digital seal) and the
  engineering letter/calcs must be signed/sealed by the engineer of record.
- If the client/installer already provided these, attach them to the submittal package.
- Path basis:
${permitPath.basis.map((b) => `  - ${b}`).join("\n")}
`,
  );
}

// Path chooser — emitted only when the path is still ambiguous, so the operator picks
// before any application is uploaded (the two applications are mutually exclusive).
function buildPathChooser(project: ProjectRecord, permitPath: PermitPathResolution): GeneratedApplicationDocument {
  return doc(
    "path-chooser",
    "CHOOSE: Prescriptive vs Structural Application",
    "worksheet",
    true,
    "00-choose-permit-path.md",
    `# CHOOSE: Prescriptive vs Structural Application

The permit path is not yet confirmed for this project. The AHJ publishes TWO solar
applications and you upload EXACTLY ONE:

- PRESCRIPTIVE application → meets prescriptive code, NO plan review, REDUCED fee.
- STRUCTURAL application → does NOT meet prescriptive code, plan review, FULL fees, and a
  PE-stamped plan set + structural letter must be attached.

Set the permit path on the project (Manual entry → Permit path) to lock this in. Both
draft applications below are provided ONLY so you can review them — do NOT upload both.

Why it's still unconfirmed:
${permitPath.basis.map((b) => `- ${b}`).join("\n")}
`,
  );
}

function buildBidSheet(project: ProjectRecord, _profile: ApplicationRequirementProfile): GeneratedApplicationDocument {
  return doc(
    "bid-sheet",
    "Bid Sheet Worksheet",
    "worksheet",
    true,
    "07-bid-sheet-worksheet.md",
    `# Bid Sheet Worksheet

Project: ${project.homeownerName || "[verify]"} - ${project.projectAddress || "[verify]"}

Contractor/installer:
${payload(project, "contractorLicenseNotes") || "[verify contractor/license details]"}

Solar PV system:
- DC size: ${project.systemSizeDcKw ?? "[verify]"} kW
- AC size: ${project.systemSizeAcKw ?? "[verify]"} kW
- Modules: ${payload(project, "moduleQty") || "[verify]"} x ${payload(project, "moduleMake")} ${payload(project, "moduleModel")}
- Inverters: ${payload(project, "invQty") || payload(project, "pvMicroQty") || "[verify]"} x ${payload(project, "invMake") || payload(project, "pvMicroMake")} ${payload(project, "invModel") || payload(project, "pvMicroModel")}

Contract value / bid amount: [enter from signed contract]
`,
  );
}

function buildUtilityWorksheet(project: ProjectRecord): GeneratedApplicationDocument {
  return doc(
    "utility-nem",
    "Utility / NEM Application Worksheet",
    "utility_application",
    true,
    "08-utility-nem-worksheet.md",
    `# Utility / NEM Application Worksheet

Utility: ${project.utility || "[verify]"}
Customer/account holder: ${payload(project, "ubAccountHolder") || project.homeownerName || "[verify]"}
Service address: ${payload(project, "ubServiceAddress") || project.projectAddress || "[verify]"}
Account number: ${project.accountNumber || "[verify]"}
Meter number: ${project.meterNumber || "[verify]"}

System:
- DC kW: ${project.systemSizeDcKw ?? "[verify]"}
- AC kW: ${project.systemSizeAcKw ?? "[verify]"}
- Export kW: ${project.totalExportKw ?? "[verify]"}
- Interconnection: ${project.interconnectionMethod || "[verify]"}
- Battery/ESS: ${payload(project, "batteryModel") || "None parsed / verify"}

Upload package:
${payload(project, "utilityDownloadChecklistText") || "[build utility ZIP/checklist first]"}
`,
  );
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.split(/\n/);
  return lines
    .map((line) => {
      if (line.startsWith("# ")) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      if (line.startsWith("## ")) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith("- ")) return `<li>${escapeHtml(line.slice(2))}</li>`;
      if (!line.trim()) return "";
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join("\n")
    .replace(/(<li>[\s\S]*?<\/li>)(?!\n<li>)/g, "<ul>$1</ul>")
    .replace(/<\/ul>\n<ul>/g, "\n");
}

function packageHtml(
  project: ProjectRecord,
  profile: ApplicationRequirementProfile,
  docs: GeneratedApplicationDocument[],
  missingFields: string[],
  client: ClientRecord | null,
): string {
  const companyName = client ? escapeHtml(client.legalBusinessName || client.companyName) : "";
  const companyAddress = client && client.businessAddress
    ? escapeHtml([client.businessAddress, client.businessCity, client.businessState, client.businessZip].filter(Boolean).join(", "))
    : "";
  const companyPhone = client ? escapeHtml(client.businessPhone || client.phone) : "";
  const companyEmail = client ? escapeHtml(client.businessEmail || client.contactEmail) : "";
  const ccb = client && isOregonJob(project) ? escapeHtml(client.ccbLicenseNumber) : "";
  const stateLicences = client && !isOregonJob(project) ? stateLicenceLines(client, project.state) : [];

  const logoHtml = client?.logoBase64
    ? `<img src="data:${escapeHtml(client.logoMime)};base64,${client.logoBase64}" alt="${companyName} logo" style="max-height:64px;max-width:200px;object-fit:contain" />`
    : "";

  const brandHeader = client
    ? `<div class="brand-header">
        ${logoHtml ? `<div class="brand-logo">${logoHtml}</div>` : ""}
        <div class="brand-info">
          <div class="brand-name">${companyName}</div>
          ${companyAddress ? `<div>${companyAddress}</div>` : ""}
          ${companyPhone || companyEmail ? `<div>${[companyPhone, companyEmail].filter(Boolean).join(" &nbsp;·&nbsp; ")}</div>` : ""}
          ${ccb ? `<div>CCB #${ccb}</div>` : ""}
          ${stateLicences.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
        </div>
      </div>`
    : "";

  const pageTitle = client
    ? `${companyName} — Permit Package: ${escapeHtml(project.homeownerName || project.projectAddress || project.id)}`
    : `Application Docs — ${escapeHtml(project.homeownerName || project.projectAddress || project.id)}`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${pageTitle}</title>
  <style>
    body{font-family:Arial,sans-serif;line-height:1.4;color:#17202a;margin:32px;max-width:980px}
    section{break-after:page;border-bottom:1px solid #ddd;padding-bottom:24px;margin-bottom:28px}
    h1{font-size:24px} h2{font-size:18px} p{margin:7px 0} li{margin:4px 0}
    .warn{border:1px solid #d97706;background:#fff7ed;padding:12px;border-radius:6px}
    .meta{color:#596579;font-size:13px}
    .brand-header{display:flex;align-items:center;gap:18px;border-bottom:2px solid #1a56db;padding-bottom:14px;margin-bottom:20px}
    .brand-logo{flex-shrink:0}
    .brand-name{font-size:18px;font-weight:700;color:#1a56db}
    .brand-info{font-size:13px;color:#374151;line-height:1.6}
    @media print{
      button{display:none}
      body{margin:18mm}
      section{page-break-after:always}
      .brand-header{border-bottom:2px solid #1a56db;margin-bottom:14px}
    }
  </style>
</head>
<body>
  <button onclick="window.print()">Print / Save PDF</button>
  ${brandHeader}
  <h1>AHJ Application Document Package</h1>
  <p class="meta">Profile: ${escapeHtml(profile.name)} | Generated: ${escapeHtml(nowIso())}</p>
  ${missingFields.length ? `<div class="warn"><strong>Missing fields:</strong> ${escapeHtml(missingFields.join(", "))}</div>` : ""}
  ${docs.map((item) => `<section>${markdownToHtml(item.markdown)}</section>`).join("\n")}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

