import type {
  ApplicationDocumentPackage,
  ApplicationRequirementProfile,
  ClientRecord,
  GeneratedApplicationDocument,
  ProjectRecord,
} from "../../shared/src/types";
import { nowIso } from "./time";
import { findAhjProcessProfile, ahjProcessKnowledgeStatus } from "./processProfiles";
import { resolvePermitPath, resolveStampRequirement, permitPathCallout, hasStampedStructuralEvidence, evaluatePrescriptiveCriteria, type PermitPathResolution } from "./permitPath";

// Derive combo-vs-separate from the AHJ process knowledge when the static application
// profile doesn't state it. Many Oregon AHJs (e.g. Beaverton) file SEPARATE building +
// electrical permits, and that truth lives only in the process profile's notes/flags —
// not in the generic portal-only application profile. Without this, those AHJs default
// to "combo" and the electrical permit worksheet is never generated.
function permitStructureFromAhjProcess(project: ProjectRecord): "separate" | "combo" | "unknown" {
  const ahj = findAhjProcessProfile(project);
  if (!ahj) return "unknown";
  if (ahj.requiresElectricalPermitApplication && ahj.requiresBuildingPermitApplication) return "separate";
  const notes = `${ahj.reviewerNotes} ${ahj.otherRequirements} ${ahj.submissionMethod}`.toLowerCase();
  // "Apply for solar and electrical separately" / "Electrical Trade permit" → separate.
  // Checked before combo so Beaverton's "…can go under one electric trade permit" (which
  // refers to folding the MPU into the electrical permit) doesn't mislabel it combo.
  if ((/\bseparate(ly)?\b/.test(notes) && /electric/.test(notes)) || /electrical trade permit/.test(notes)) return "separate";
  if (/\b(combined|combo)\b/.test(notes) || /one (single )?(combination|building) permit/.test(notes)) return "combo";
  return "unknown";
}

/** Resolve a project's permit structure across all signals: static profile → AHJ process
 *  notes/flags → derived flags. Used for both the submittal tracks and doc generation. */
export function permitStructureForProject(project: ProjectRecord): "separate" | "combo" | "unknown" {
  const profile = findApplicationProfile(project);
  if (profile.permitStructure && profile.permitStructure !== "unknown") return profile.permitStructure;
  const fromProcess = permitStructureFromAhjProcess(project);
  if (fromProcess !== "unknown") return fromProcess;
  if (profile.requiresStructuralApplication && profile.requiresElectricalApplication) return "separate";
  if (profile.requiresAhjApplication || profile.requiresStructuralApplication) return "combo";
  return "unknown";
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
  const isEpermitting = /e-?permitting|accela|aca/.test(method) || /e-?permitting|accela/.test(notes);
  const isProjectDox = /projectdox|avolve/.test(method) || /projectdox|avolve/.test(notes);
  const isEmail = /email/.test(method) || /email/.test(notes);
  const portalOnly = isEpermitting || isProjectDox || /portal|online/.test(method);

  const wantsElectricalApp = proc.requiresElectricalPermitApplication || proc.requiresElectricalStamp || /renewable energy app|electrical app/.test(notes);
  const wantsBuildingApp = proc.requiresBuildingPermitApplication;
  const wantsStructuralApp = proc.requiresStructuralStamp || /struct app|structural app/.test(notes) || wantsBuildingApp;
  const wantsChecklist = proc.requiresSolarChecklist || /checklist/.test(notes) || project.state.toUpperCase() === "OR";

  const requiredDocuments: string[] = [];
  if (wantsStructuralApp || wantsChecklist) {
    requiredDocuments.push("Solar application — PRESCRIPTIVE or STRUCTURAL (upload only the one that matches your path; never both)");
  }
  if (wantsElectricalApp) requiredDocuments.push("Renewable Energy (electrical) permit application");
  if (wantsChecklist) requiredDocuments.push("Solar prescriptive checklist");
  if (/mpu|panel upgrade|service upgrade/.test(notes)) requiredDocuments.push("Electrical permit application (when a main panel/service upgrade is in scope)");
  if (proc.requiresPlanSet) requiredDocuments.push("Plan set and specifications");
  // Single stamp authority: fires on the profile flag AND on this project's own
  // engineered path — previously a stamped-path project whose profile lacked the
  // flag got no stamped-plans line here.
  if (resolveStampRequirement(project, { processProfileRequiresStamp: proc.requiresStructuralStamp, jurisdictionLabel: proc.ahj }).required) {
    requiredDocuments.push("PE-stamped structural plans + engineering letter (non-prescriptive path)");
  }
  if (!requiredDocuments.length) requiredDocuments.push("Plan set and specifications");

  const submissionMethod = isEpermitting ? "Oregon ePermitting (Accela)"
    : isProjectDox ? "ProjectDox (online plan review)"
    : isEmail ? "Email"
    : (proc.submissionMethod || "Verify on the AHJ site");

  const notesOut = [`Synthesized from the seeded ${proc.ahj} process profile.`];
  if (proc.reviewerNotes) notesOut.push(proc.reviewerNotes);
  if (proc.timeline) notesOut.push(`Typical timeline: ${proc.timeline}.`);

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
    permitStructure: wantsBuildingApp && wantsElectricalApp ? "separate" : "unknown",
    submissionMethod,
    requiredDocuments,
    notes: notesOut,
  };
}

export function findApplicationProfile(project: ProjectRecord): ApplicationRequirementProfile {
  const haystack = `${project.ahj} ${project.city} ${project.state}`.toLowerCase();
  // The hand-written registry is OREGON-specific, but its match terms are bare
  // jurisdiction names that collide across states ("Washington County", "Salem",
  // "Marion County", "Portland" all exist elsewhere). Without this state gate an
  // out-of-state project silently inherited an Oregon profile — including
  // requiresPortalEntryOnly:true flags that SKIP AHJ form acquisition entirely
  // (seen as "no documents pulled" on a WA county).
  const oregonProject = project.state.trim().toUpperCase() === "OR" || /\boregon\b/.test(haystack) || !project.state.trim();
  const specific = oregonProject
    ? applicationProfiles.find((profile) =>
        profile.id !== "oregon-generic-epermitting" && profile.matchJurisdictions.some((term) => haystack.includes(term)),
      )
    : undefined;
  if (specific) return specific;
  // No hand-written profile — synthesize from the AHJ's seeded process knowledge so
  // we still pull the right forms for jurisdictions we have real data on.
  const synthesized = applicationProfileFromProcess(project);
  if (synthesized) return synthesized;
  if (project.state.toUpperCase() === "OR" || /oregon/.test(haystack)) {
    return applicationProfiles.find((profile) => profile.id === "oregon-generic-epermitting")!;
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
  learned: { submissionMethod?: string; portalPlatform?: string; permitStructure?: "combo" | "separate" | "unknown" } = {},
): PermitTypeInfo {
  // Structure — prefer an explicit profile value, then what research learned, then derive from flags.
  let structure: PermitTypeInfo["structure"] = profile.permitStructure || "unknown";
  if (structure === "unknown" && learned.permitStructure && learned.permitStructure !== "unknown") structure = learned.permitStructure;
  if (structure === "unknown") {
    if (profile.requiresStructuralApplication && profile.requiresElectricalApplication) structure = "separate";
    else if (profile.requiresAhjApplication || profile.requiresStructuralApplication) structure = "combo";
  }

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
    else if (/epermitting|accela/.test(blob)) submissionMethod = "Oregon ePermitting (Accela)";
    else if (profile.requiresPortalEntryOnly) submissionMethod = "Online portal";
    else submissionMethod = "Unknown — verify on the AHJ site";
  }

  const structureLabel =
    structure === "separate" ? "Separate building (BLD) + electrical (ELE) permits — both must be filed"
    : structure === "combo" ? "Combined building + electrical permit (one permit)"
    : "Combo vs separate BLD/ELE permits not yet confirmed — verify on the AHJ site";
  const callout = `${structureLabel} — submitted via ${submissionMethod}.`;
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
  const permitType = describePermitType(profile, { submissionMethod: opts.learnedMethod, portalPlatform: opts.learnedPlatform });
  const company = (opts.companyName || "").trim() || "Our company";
  const customer = (project.homeownerName || "Customer").trim();
  const addr = [project.projectAddress, [project.city, project.state, project.zip].filter(Boolean).join(", ")].filter(Boolean).join(", ");
  // Subject reflects the permit structure: combo → "Permit submittal"; separate → "BLD, ELE Permit submittal".
  const permitTag = permitType.structure === "combo" ? "Permit submittal" : "BLD, ELE Permit submittal";
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
    : ["Building permit application", "Electrical permit application", "Plan set", "Equipment specifications"]
  ).map((d) => `  - ${d}`).join("\n");

  const intro = permitType.structure === "combo"
    ? "Please find attached the combined building + electrical permit submittal for the following residential rooftop solar PV project:"
    : "Please find attached the building (BLD) and electrical (ELE) permit submittal for the following residential rooftop solar PV project:";
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

export function buildApplicationDocumentPackage(project: ProjectRecord, client: ClientRecord | null = null): ApplicationDocumentPackage {
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
  const profile: ApplicationRequirementProfile = knowledge.status === "resolved" ? matched : {
    ...matched,
    notes: [
      `WARNING — the AHJ process reference (jurisdiction requirements for 381 AHJs) could not be read, so this package was built WITHOUT this jurisdiction's own process knowledge. The profile below is a generic fallback; treat its document list as unverified and check the AHJ's requirements by hand before submitting. Cause: ${knowledge.error || "unknown"}`,
      ...(matched.notes || []),
    ],
  };
  const structure = permitStructureForProject(project);
  const permitPath = resolvePermitPath(project);
  const hasMpu = applicationHasMpuScope(project);
  const missingFields = requiredProjectFields(project);
  const docs: GeneratedApplicationDocument[] = [
    buildCover(project, profile, client, permitPath),
    buildManifest(project, profile, structure, permitPath, hasMpu),
  ];

  if (profile.requiresAhjApplication || profile.requiresPortalEntryOnly) docs.push(buildAhjWorksheet(project, profile, client));

  // PRESCRIPTIVE vs STRUCTURAL application are MUTUALLY EXCLUSIVE — the AHJ publishes
  // both and you upload exactly one. Generate only the application that matches the
  // resolved path. Prescriptive → prescriptive application/checklist (no plan review,
  // reduced fee). Engineered → structural application + collect PE-stamped plans +
  // structural letter (plan review, full fees). When the path is still unknown we emit
  // a chooser doc so the operator picks before anything is uploaded.
  if (permitPath.path === "engineered") {
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
  if (/PGE|PORTLAND GENERAL|PACIFIC|PACIFICORP/i.test(project.utility)) docs.push(buildUtilityWorksheet(project));

  return {
    projectId: project.id,
    profile,
    generatedAt: nowIso(),
    docs,
    missingFields,
    html: packageHtml(project, profile, docs, missingFields, client),
    permitType: `${describePermitType(profile, { permitStructure: structure }).callout} ${permitPathCallout(permitPath)}`,
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
        client.ccbLicenseNumber ? `CCB: ${client.ccbLicenseNumber}` : "",
        client.electricalLicenseNumber ? `Electrical license: ${client.electricalLicenseNumber}` : "",
        client.authorizedSignerName ? `Authorized signer: ${client.authorizedSignerName}${client.authorizedSignerTitle ? `, ${client.authorizedSignerTitle}` : ""}` : "",
      ].filter(Boolean).join("\n")
    : "Contractor: [assign client to populate]";

  const pathLabel = permitPath.path === "prescriptive" ? "PRESCRIPTIVE (meets prescriptive code · no plan review · reduced fee)"
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
- Upload ONLY the application that matches the permit path above — never both.
`,
  );
}

function buildManifest(
  project: ProjectRecord,
  profile: ApplicationRequirementProfile,
  structure: "separate" | "combo" | "unknown",
  permitPath: PermitPathResolution,
  hasMpu: boolean,
): GeneratedApplicationDocument {
  const generatedDocs = profile.requiredDocuments.map((item) => `- ${item}`).join("\n");
  const separate = structure === "separate";
  const structureLine = separate
    ? "Permit structure: SEPARATE building (BLD) + electrical (ELE) permits — file BOTH."
    : structure === "combo"
      ? "Permit structure: Combined building + electrical permit (one filing)."
      : "Permit structure: verify combo vs separate on the AHJ site.";

  // The application line is path-driven — upload exactly one.
  const appLine = permitPath.path === "prescriptive"
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

## Application to upload (mutually exclusive)
${appLine}

> ${permitPathCallout(permitPath)}

Required by profile:
${generatedDocs || "- No AHJ-specific required documents seeded. Verify manually."}

Generated by Autopilot:
- Cover sheet
- Required document manifest
${profile.requiresAhjApplication || profile.requiresPortalEntryOnly ? "- AHJ / portal application worksheet" : ""}
${permitPath.path === "engineered" ? "- Structural (non-prescriptive) application worksheet\n- Engineered document collection checklist (stamped plans + structural letter)" : ""}
${permitPath.path === "prescriptive" ? "- Prescriptive solar application worksheet (with checklist)" : ""}
${permitPath.path === "unknown" ? "- Permit-path chooser\n- Prescriptive application (draft)\n- Structural application (draft)" : ""}
${profile.requiresElectricalApplication || separate || hasMpu ? "- Electrical / Renewable-Energy application worksheet" : ""}
${hasMpu ? "- Electrical permit application is required because a main panel/service upgrade (MPU) is in scope" : ""}
${profile.requiresBidSheet ? "- Bid sheet worksheet" : ""}
${/PGE|PORTLAND GENERAL|PACIFIC|PACIFICORP/i.test(project.utility) ? "- Utility/NEM application worksheet" : ""}

Profile notes:
${profile.notes.map((note) => `- ${note}`).join("\n")}
`,
  );
}

function buildAhjWorksheet(project: ProjectRecord, profile: ApplicationRequirementProfile, client: ClientRecord | null): GeneratedApplicationDocument {
  const contractorLine = client
    ? `${client.legalBusinessName || client.companyName} | CCB: ${client.ccbLicenseNumber || "[verify]"} | Elec: ${client.electricalLicenseNumber || "[verify]"} | Contact: ${client.contactName || client.authorizedSignerName || "[verify]"}`
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
- MSP bus/main: ${yesNo(payload(project, "busRating"))} A bus / ${yesNo(payload(project, "mainBreaker"))} A main
- PV breaker/OCPD: ${yesNo(payload(project, "pvBreaker"))}
- AC disconnect: ${yesNo(payload(project, "acDiscReq"))} ${payload(project, "acDiscAmp") ? `(${payload(project, "acDiscAmp")} A)` : ""}
`,
  );
}

// The STRUCTURAL (non-prescriptive / engineered) application worksheet. Generated only
// on the engineered path. Carries a banner that this is the application to upload and
// that a PE-stamped plan set + structural letter must accompany it (collected below).
function buildStructuralWorksheet(project: ProjectRecord, _profile: ApplicationRequirementProfile, permitPath: PermitPathResolution): GeneratedApplicationDocument {
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

function buildElectricalWorksheet(project: ProjectRecord, _profile: ApplicationRequirementProfile, hasMpu: boolean): GeneratedApplicationDocument {
  return doc(
    "electrical",
    "Electrical / Renewable-Energy Application Worksheet",
    "electrical_application",
    true,
    "05-electrical-application-worksheet.md",
    `# Electrical / Renewable-Energy Application Worksheet

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

Prescriptive code screen (all must be Yes to remain prescriptive):
${evaluatePrescriptiveCriteria(project).map((c) => `- ${c.label}: ${c.answer}${c.detail ? ` — ${c.detail}` : ""}`).join("\n")}
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

This project is on the NON-PRESCRIPTIVE (engineered) path, so the AHJ requires sealed
structural documentation in addition to the structural application.

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
  const ccb = client ? escapeHtml(client.ccbLicenseNumber) : "";

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

