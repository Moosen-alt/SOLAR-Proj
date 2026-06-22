import type {
  ApplicationDocumentPackage,
  ApplicationRequirementProfile,
  ClientRecord,
  GeneratedApplicationDocument,
  ProjectRecord,
} from "../../shared/src/types";
import { nowIso } from "./time";

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

export function findApplicationProfile(project: ProjectRecord): ApplicationRequirementProfile {
  const haystack = `${project.ahj} ${project.city} ${project.state}`.toLowerCase();
  const specific = applicationProfiles.find((profile) =>
    profile.id !== "oregon-generic-epermitting" && profile.matchJurisdictions.some((term) => haystack.includes(term)),
  );
  if (specific) return specific;
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

export function buildApplicationDocumentPackage(project: ProjectRecord, client: ClientRecord | null = null): ApplicationDocumentPackage {
  const profile = findApplicationProfile(project);
  const missingFields = requiredProjectFields(project);
  const docs: GeneratedApplicationDocument[] = [
    buildCover(project, profile, client),
    buildManifest(project, profile),
  ];

  if (profile.requiresAhjApplication || profile.requiresPortalEntryOnly) docs.push(buildAhjWorksheet(project, profile, client));
  if (profile.requiresStructuralApplication) docs.push(buildStructuralWorksheet(project, profile));
  if (profile.requiresElectricalApplication) docs.push(buildElectricalWorksheet(project, profile));
  if (profile.requiresPrescriptiveChecklist) docs.push(buildPrescriptiveChecklist(project, profile));
  if (profile.requiresBidSheet) docs.push(buildBidSheet(project, profile));
  if (/PGE|PORTLAND GENERAL|PACIFIC|PACIFICORP/i.test(project.utility)) docs.push(buildUtilityWorksheet(project));

  return {
    projectId: project.id,
    profile,
    generatedAt: nowIso(),
    docs,
    missingFields,
    html: packageHtml(project, profile, docs, missingFields, client),
    permitType: describePermitType(profile).callout,
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

function buildCover(project: ProjectRecord, profile: ApplicationRequirementProfile, client: ClientRecord | null): GeneratedApplicationDocument {
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

Submission profile: ${profile.name}
Portal/process: ${profile.portalName}
Official reference: ${profile.sourceUrl || "[verify AHJ source]"}

Operator notes:
- Verify all required fields before legal submission.
- Do not submit this package automatically.
- Transfer worksheet values into official AHJ forms or portal fields where required.
`,
  );
}

function buildManifest(project: ProjectRecord, profile: ApplicationRequirementProfile): GeneratedApplicationDocument {
  const generatedDocs = profile.requiredDocuments.map((item) => `- ${item}`).join("\n");
  return doc(
    "manifest",
    "Required Document Manifest",
    "manifest",
    true,
    "02-required-document-manifest.md",
    `# Required Document Manifest

Profile: ${profile.name}

Required by profile:
${generatedDocs || "- No AHJ-specific required documents seeded. Verify manually."}

Generated by Autopilot:
- Cover sheet
- Required document manifest
${profile.requiresAhjApplication || profile.requiresPortalEntryOnly ? "- AHJ / portal application worksheet" : ""}
${profile.requiresStructuralApplication ? "- Structural/building application worksheet" : ""}
${profile.requiresElectricalApplication ? "- Electrical application worksheet" : ""}
${profile.requiresPrescriptiveChecklist ? "- Prescriptive solar checklist worksheet" : ""}
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

Scope of work:
Install roof-mounted photovoltaic system. ${project.systemSizeDcKw ?? "[verify]"} kW DC / ${project.systemSizeAcKw ?? "[verify]"} kW AC. Interconnection method: ${project.interconnectionMethod || "[verify]"}.

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

function buildStructuralWorksheet(project: ProjectRecord, _profile: ApplicationRequirementProfile): GeneratedApplicationDocument {
  return doc(
    "structural",
    "Structural / Building Application Worksheet",
    "structural_application",
    true,
    "04-structural-building-worksheet.md",
    `# Structural / Building Application Worksheet

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

Prescriptive path shown by parser: ${yesNo(payload(project, "permitPath"))}
Stamp recommendation: ${yesNo(payload(project, "stampRecommendation"))}
`,
  );
}

function buildElectricalWorksheet(project: ProjectRecord, _profile: ApplicationRequirementProfile): GeneratedApplicationDocument {
  return doc(
    "electrical",
    "Electrical Permit Application Worksheet",
    "electrical_application",
    true,
    "05-electrical-application-worksheet.md",
    `# Electrical Permit Application Worksheet

${commonProjectBlock(project)}

Electrical scope:
- Interconnection: ${yesNo(project.interconnectionMethod)}
- Service: ${yesNo(payload(project, "phase"))}, ${yesNo(payload(project, "voltage"))}
- Bus/main: ${yesNo(payload(project, "busRating"))} A / ${yesNo(payload(project, "mainBreaker"))} A
- PV OCPD: ${yesNo(payload(project, "pvBreaker"))}
- AC disconnect: ${yesNo(payload(project, "acDiscReq"))}
- Locate callout: ${yesNo(payload(project, "locateCalloutText"))}
`,
  );
}

function buildPrescriptiveChecklist(project: ProjectRecord, _profile: ApplicationRequirementProfile): GeneratedApplicationDocument {
  return doc(
    "prescriptive-checklist",
    "Solar Prescriptive Checklist Worksheet",
    "checklist",
    true,
    "06-prescriptive-solar-checklist.md",
    `# Solar Prescriptive Checklist Worksheet

Answer each item before submittal.

- Roof-mounted PV: ${/roof/i.test(payload(project, "mounting")) ? "Yes" : "[verify]"}
- Conventional light-frame construction: [verify]
- Ground snow load <= 70 psf: ${Number(payload(project, "snow")) <= 70 ? "Yes" : "[verify]"}
- Wind exposure B or C: ${/^(B|C)$/i.test(payload(project, "wind")) ? "Yes" : "[verify]"}
- Rafter/truss spacing <= 24 in. o.c.: ${Number(payload(project, "roofRafterSpacing")) <= 24 ? "Yes" : "[verify]"}
- PV dead load <= 4.5 psf: ${Number(payload(project, "deadLoad")) <= 4.5 ? "Yes" : "[verify]"}
- Firefighter access/pathways shown: ${/pathway|fire|access/i.test(`${payload(project, "sitePlanNotesText")} ${payload(project, "splitPagesText")}`) ? "Yes" : "[verify]"}
- Attachment/racking details included: ${payload(project, "racking") ? "Yes" : "[verify]"}
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

