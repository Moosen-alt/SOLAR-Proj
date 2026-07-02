import type { AhjProcessProfile, CodeReference, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import type { EffectiveCodeContext } from "./codeProfiles";

const oregonElectrical2023: CodeReference = {
  code: "2023 OESC / 2023 NEC",
  section: "NEC Articles 690 and 705",
  title: "Solar PV and interconnected power production sources",
  adoptionScope: "Oregon electrical submittals; verify local adopted NEC cycle outside Oregon.",
  sourceUrl: "https://www.oregon.gov/bcd/codes-stand/pages/electrical.aspx",
  note: "Oregon BCD lists the 2023 Oregon Electrical Specialty Code as effective Oct. 1, 2023 and based on the 2023 NEC.",
};

const rapidShutdown: CodeReference = {
  code: "NEC",
  section: "690.12",
  title: "Rapid shutdown of PV systems on buildings",
  adoptionScope: "Rooftop/building-mounted PV where the AHJ has adopted NEC rapid shutdown provisions.",
  sourceUrl: "https://www.oregon.gov/bcd/codes-stand/pages/electrical.aspx",
  note: "Use the locally adopted NEC edition and amendments for exact label/control wording.",
};

const powerSourceDirectory: CodeReference = {
  code: "NEC",
  section: "705.10",
  title: "Identification of power sources",
  adoptionScope: "Interconnected PV systems.",
  sourceUrl: "https://www.oregon.gov/bcd/codes-stand/pages/electrical.aspx",
  note: "Plan sets should include a permanent directory/placard concept where required by the adopted NEC.",
};

const loadSideInterconnection: CodeReference = {
  code: "NEC",
  section: "705.12",
  title: "Load-side source connections",
  adoptionScope: "PV connected on the load side of service equipment.",
  sourceUrl: "https://codes.iccsafe.org/s/ISEP2021P1/national-electrical-code-nec-solar-provisions/ISEP2021P1-NEC-Sec705.12",
  note: "Verify against the adopted NEC edition; plan reviewers commonly expect bus/main/PV breaker math to be explicit.",
};

const supplySideInterconnection: CodeReference = {
  code: "NEC",
  section: "705.11",
  title: "Supply-side source connections",
  adoptionScope: "PV connected ahead of the service disconnect or by line-side tap.",
  sourceUrl: "https://www.oregon.gov/bcd/codes-stand/pages/electrical.aspx",
  note: "Show the tap point, disconnect/OCPD, conductor routing, utility coordination, and service equipment details.",
};

const roofLoads: CodeReference = {
  code: "IRC / ORSC",
  section: "R324.4.1",
  title: "Rooftop-mounted photovoltaic systems and roof loads",
  adoptionScope: "One- and two-family residential rooftop PV, subject to local amendments.",
  sourceUrl: "https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning",
  note: "Roof structure, dead load, live load, and attachment assumptions must be shown clearly enough for review.",
};

const roofAccess: CodeReference = {
  code: "IRC",
  section: "R324.6",
  title: "Roof access and pathways for PV systems",
  adoptionScope: "Residential rooftop PV where adopted by the AHJ.",
  sourceUrl: "https://codes.iccsafe.org/s/IRC2021P2/chapter-3-building-planning/IRC2021P2-Pt03-Ch03-SecR324.6.1",
  note: "Use the local code cycle and fire official amendments for pathway/setback dimensions and exceptions.",
};

const fireAccess: CodeReference = {
  code: "IFC",
  section: "1205.2",
  title: "Access and pathways for PV systems",
  adoptionScope: "Fire-code review for rooftop PV.",
  sourceUrl: "https://codes.iccsafe.org/s/IFC2021P1/chapter-12-energy-systems/IFC2021P1-Pt03-Ch12-Sec1205.2",
  note: "Pathways should be placed over structurally capable roof areas with minimal obstructions.",
};

const oregonPrescriptive: CodeReference = {
  code: "ORSC / OSSC",
  section: "Oregon Prescriptive Rooftop-Mounted Solar PV Checklist",
  title: "Oregon prescriptive rooftop PV installation screening",
  adoptionScope: "Oregon residential and commercial prescriptive rooftop PV path.",
  sourceUrl: "https://www.washingtoncountyor.gov/lut/building-services/documents/solar-checklist/download?inline=",
  note: "Common screens include PV dead load, ground snow load, wind exposure, roof slope, and framing spacing/span evidence.",
};

const portlandRafterSpan: CodeReference = {
  code: "OSSC",
  section: "Table 2308.7.2(1)",
  title: "Rafter span tables used by Portland solar worksheet",
  adoptionScope: "Portland-style prescriptive rafter span review; useful baseline for Oregon AHJ review.",
  sourceUrl: "https://www.portland.gov/ppd/documents/solar-worksheet/download",
  note: "Show rafter size, spacing, species/grade, span, roof slope, and support conditions when using a prescriptive path.",
};

const essReference: CodeReference = {
  code: "NEC / IRC / IFC",
  section: "NEC 706; IRC R328; IFC 1207",
  title: "Energy storage system installation and location",
  adoptionScope: "Battery/ESS projects; verify adopted editions and local fire amendments.",
  sourceUrl: "https://codes.iccsafe.org/content/IFC2021P1/chapter-12-energy-systems",
  note: "ESS comments are conservative because exact adopted section numbering varies by state and code cycle.",
};

function str(project: ProjectRecord, key: string): string {
  const value = project.parserSnapshot[key];
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function num(project: ProjectRecord, keys: string[]): number | null {
  for (const key of keys) {
    const cleaned = str(project, key).replace(/[^0-9.-]/g, "");
    if (!cleaned) continue;
    const value = Number.parseFloat(cleaned);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function designText(project: ProjectRecord): string {
  const keys = [
    "splitPagesText",
    "packetReadinessText",
    "utilityDownloadChecklistText",
    "utilityUploadNotesText",
    "projectDescriptionText",
    "sitePlanNotesText",
    "roofPlanNotesText",
    "structuralCalcText",
    "electricalCalcText",
    "labelsText",
    "reviewFlags",
    "stampRecommendation",
    "locateCalloutText",
  ];
  return keys.map((key) => str(project, key)).join("\n");
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function isOregon(project: ProjectRecord, profile: AhjProcessProfile | null): boolean {
  return project.state.toUpperCase() === "OR" || profile?.state.toUpperCase() === "OR" || /oregon|portland|clackamas|washington county|hillsboro|salem/i.test(project.ahj);
}

function isGroundMount(project: ProjectRecord, allText: string): boolean {
  return /ground.mount|ground mounted|ground array/i.test(`${project.interconnectionMethod}\n${allText}`);
}

function finding(input: {
  id: string;
  severity: ReviewerFinding["severity"];
  category: ReviewerFinding["category"];
  title: string;
  message: string;
  cityFeedback: string;
  designTeamAction: string;
  evidenceNeeded: string[];
  codeReferences: CodeReference[];
  installerCallout?: boolean;
}): ReviewerFinding {
  return {
    id: input.id,
    severity: input.severity,
    category: input.category,
    title: input.title,
    message: input.message,
    cityFeedback: input.cityFeedback,
    designTeamAction: input.designTeamAction,
    evidenceNeeded: input.evidenceNeeded,
    codeReferences: input.codeReferences,
    installerCallout: input.installerCallout ?? true,
  };
}

export function evaluateDesignCodeFindings(project: ProjectRecord, profile: AhjProcessProfile | null, ctx?: EffectiveCodeContext): ReviewerFinding[] {
  const out: ReviewerFinding[] = [];
  const all = designText(project);
  const roofMounted = !isGroundMount(project, all);
  const oregon = isOregon(project, profile);
  const prescriptive = /prescriptive/i.test(str(project, "permitPath"));

  // JURISDICTION CONTEXT (data-driven rules). With a context, prescriptive structural
  // screening applies wherever the jurisdiction records prescriptive limits — not just
  // Oregon — and citations render the jurisdiction's ADOPTED code editions. Without a
  // context the legacy behavior is preserved exactly (Oregon regex + the hardcoded
  // constants), which is what the Oregon golden test pins.
  const prescriptiveScreening = ctx
    ? Object.values(ctx.prescriptive).some((v) => v != null && (!Array.isArray(v) || v.length > 0))
    : oregon;
  // Threshold-style findings from a SEEDED (unverified) profile must not hard-block —
  // the data hasn't been human-confirmed against official sources yet.
  const screeningSeverity: ReviewerFinding["severity"] = prescriptive && (ctx ? ctx.verified : true) ? "blocker" : "warning";
  // Citation resolver: jurisdiction-adopted edition when a context is present, the
  // legacy constant otherwise (or when the family isn't in the adopted list).
  const cite = (code: string, fallback: CodeReference): CodeReference =>
    ctx ? ctx.citationFor(code, fallback.section, fallback.title, fallback) : fallback;
  const electricalRef = cite("NEC", oregonElectrical2023);
  const rapidShutdownRef = cite("NEC", rapidShutdown);
  const powerSourceDirectoryRef = cite("NEC", powerSourceDirectory);
  const loadSideRef = cite("NEC", loadSideInterconnection);
  const supplySideRef = cite("NEC", supplySideInterconnection);
  const roofLoadsRef = cite("IRC", roofLoads);
  const roofAccessRef = cite("IRC", roofAccess);
  const fireAccessRef = cite("IFC", fireAccess);
  const essRef = cite("NEC", essReference);
  // Oregon-specific prescriptive worksheet refs only make sense where the ORSC/OSSC
  // (or legacy Oregon detection) applies — never cite them at an Idaho county.
  const oregonWorksheetRefs: CodeReference[] = (ctx ? ctx.adoptedCodes.some((c) => /^(ORSC|OSSC|OESC)$/i.test(c.code)) : oregon)
    ? [oregonPrescriptive, portlandRafterSpan]
    : [];

  if (!hasAny(all, [/\bSLD\b/i, /single.line/i, /\b3.line\b/i, /three.line/i])) {
    out.push(finding({
      id: "city.plan.sld-missing",
      severity: "blocker",
      category: "electrical",
      title: "Electrical one-line not reviewable",
      message: "The package does not clearly map an SLD/one-line/three-line diagram.",
      cityFeedback: "Provide a complete electrical one-line diagram showing modules, inverter(s), rapid shutdown equipment, disconnects, point of interconnection, service equipment ratings, grounding/bonding path, and utility meter/service relationship.",
      designTeamAction: "Add or remap the SLD sheet and verify it matches the equipment schedule and interconnection method.",
      evidenceNeeded: ["SLD/one-line sheet number", "Point of interconnection detail", "Disconnect/OCPD schedule", "Grounding/bonding callouts"],
      codeReferences: [electricalRef, loadSideRef, supplySideRef],
    }));
  }

  if (roofMounted && !hasAny(all, [/site.plan/i, /plot.plan/i, /roof.plan/i, /\bPV layout\b/i])) {
    out.push(finding({
      id: "city.plan.site-roof-missing",
      severity: "blocker",
      category: "plan_set",
      title: "Site/roof plan not reviewable",
      message: "The package does not clearly map a site plan, plot plan, roof plan, or PV layout sheet.",
      cityFeedback: "Provide a site/roof plan showing array location, roof planes, ridge/eave/valley/hip locations, roof obstructions, access pathway dimensions, service equipment location, and equipment layout.",
      designTeamAction: "Add a roof/site plan sheet or correct the split-page mapping so the reviewer can verify layout and fire access.",
      evidenceNeeded: ["Roof/site plan sheet number", "Array dimensions and roof plane labels", "Service equipment and disconnect locations", "Obstructions and access path dimensions"],
      codeReferences: [roofAccessRef, fireAccessRef],
    }));
  }

  if (roofMounted && !hasAny(all, [/fire/i, /pathway/i, /setback/i, /ridge/i, /access path/i, /smoke ventilation/i])) {
    out.push(finding({
      id: "city.fire.pathways-missing",
      severity: "blocker",
      category: "plan_set",
      title: "Fire access pathway evidence missing",
      message: "No fire access pathway/setback evidence was detected in the mapped plan package.",
      cityFeedback: "Revise the roof plan to show firefighter access pathways, ridge/eave setbacks, smoke ventilation areas where required, and any applicable exception basis. Dimensions must be shown on the plan, not only stated in notes.",
      designTeamAction: "Add pathway dimensions and exception notes to the roof plan; confirm local fire-code amendments for the AHJ.",
      evidenceNeeded: ["Dimensioned pathway/setback callouts", "Ridge/eave/valley/hip labels", "Applicable fire-code exception, if used"],
      codeReferences: [roofAccessRef, fireAccessRef],
    }));
  }

  if (roofMounted && !hasAny(all, [/rafter/i, /truss/i, /framing/i, /structural/i, /engineer/i, /span table/i])) {
    out.push(finding({
      id: "city.struct.framing-missing",
      severity: "blocker",
      category: "structural",
      title: "Roof framing information missing",
      message: "The plan package does not show enough roof framing information for structural review.",
      cityFeedback: "Provide roof framing type and member information: rafter/truss type, member size, spacing, span, species/grade when applicable, roof slope, sheathing, array attachment locations, and whether the design uses a prescriptive or engineered path.",
      designTeamAction: "Add structural/framing notes or a stamped structural letter/calculation package.",
      evidenceNeeded: ["Rafter/truss size and spacing", "Clear span/support condition", "Roof slope", "Prescriptive worksheet or stamped structural calculation"],
      codeReferences: prescriptiveScreening ? [roofLoadsRef, ...oregonWorksheetRefs] : [roofLoadsRef],
    }));
  }

  const rafterSpacing = num(project, ["roofRafterSpacing", "rafterSpacing"]);
  const rafterSpan = num(project, ["roofRafterSpan", "rafterSpan"]);
  if (roofMounted && prescriptiveScreening && !hasAny(all, [/engineer/i, /stamped structural/i, /structural letter/i]) && (rafterSpacing == null || rafterSpan == null)) {
    out.push(finding({
      id: "city.struct.span-table-incomplete",
      severity: screeningSeverity,
      category: "structural",
      title: "Prescriptive rafter span evidence incomplete",
      message: ctx && !oregon
        ? `${ctx.ahj || ctx.state} prescriptive review needs rafter/truss spacing and span evidence or an engineered alternate path.`
        : "Oregon-style prescriptive review needs rafter/truss spacing and span evidence or an engineered alternate path.",
      cityFeedback: "Provide the prescriptive rooftop PV checklist/worksheet information, including framing member size, spacing, span, species/grade, roof slope, dead load, snow load, and wind exposure. If this cannot be documented, provide stamped engineering.",
      designTeamAction: "Complete the structural worksheet inputs or route the design to engineered review.",
      evidenceNeeded: ["Framing spacing", "Framing clear span", "Species/grade or engineered truss evidence", "Dead load, snow load, wind exposure"],
      codeReferences: [...oregonWorksheetRefs, roofLoadsRef],
    }));
  }

  if (roofMounted && !hasAny(all, [/attachment/i, /lag/i, /rafter attachment/i, /standoff/i, /flashing/i, /mount/i, /rail/i, /racking/i])) {
    out.push(finding({
      id: "city.struct.attachment-detail-missing",
      severity: "blocker",
      category: "structural",
      title: "Racking/attachment detail missing",
      message: "The package does not show enough racking attachment and waterproofing detail.",
      cityFeedback: "Provide racking manufacturer, attachment type, attachment spacing, fastener embedment, flashing/waterproofing method, uplift/downforce basis, and roof attachment detail tied to the framing members.",
      designTeamAction: "Add the racking attachment detail and manufacturer spec sheet or engineering table used for spacing.",
      evidenceNeeded: ["Racking/attachment detail", "Attachment spacing table", "Fastener/embedment callout", "Flashing/waterproofing note"],
      codeReferences: [roofLoadsRef],
    }));
  }

  const snow = num(project, ["snow", "groundSnowLoad"]);
  const deadLoad = num(project, ["deadLoad", "pvDeadLoad"]);
  const wind = str(project, "wind") || str(project, "windExposure");
  if (roofMounted && prescriptiveScreening && (snow == null || deadLoad == null || !wind)) {
    out.push(finding({
      id: "city.struct.loads-missing",
      severity: screeningSeverity,
      category: "structural",
      title: "Structural load criteria missing",
      message: "Ground snow load, PV dead load, and/or wind exposure were not captured for prescriptive structural screening.",
      cityFeedback: "Provide design load criteria on the plans: ground snow load, roof/PV dead load, wind exposure, roof slope, and whether the project remains within the prescriptive checklist limits.",
      designTeamAction: "Add load criteria to the structural notes or provide stamped engineering.",
      evidenceNeeded: ["Ground snow load", "PV dead load psf", "Wind exposure", "Roof slope"],
      codeReferences: [...oregonWorksheetRefs, roofLoadsRef],
    }));
  }

  if (roofMounted && !hasAny(all, [/rapid shutdown/i, /\bRSD\b/i, /690\.12/i])) {
    out.push(finding({
      id: "city.elec.rapid-shutdown-missing",
      severity: "blocker",
      category: "electrical",
      title: "Rapid shutdown not shown",
      message: "No rapid shutdown callout or equipment evidence was detected.",
      cityFeedback: "Revise the electrical plans to identify rapid shutdown equipment, initiation/control location, controlled conductors or array boundary basis, and required field marking for the adopted NEC cycle.",
      designTeamAction: "Add RSD equipment and label callouts to the SLD/site/equipment schedule.",
      evidenceNeeded: ["RSD device or inverter listing basis", "RSD initiation/control location", "RSD label/placard callout", "Code-cycle note"],
      codeReferences: [rapidShutdownRef, electricalRef],
    }));
  }

  if (!hasAny(all, [/label/i, /placard/i, /directory/i, /705\.10/i, /690\.12/i])) {
    out.push(finding({
      id: "city.elec.labels-missing",
      severity: "warning",
      category: "electrical",
      title: "PV label schedule not obvious",
      message: "The package does not clearly show required PV placards/labels.",
      cityFeedback: "Provide a PV label schedule showing service equipment directory, rapid shutdown label, disconnect labels, backfed breaker warning where applicable, and any AHJ/utility-specific placards.",
      designTeamAction: "Add label sheet or label callouts to the electrical plan.",
      evidenceNeeded: ["Label schedule", "Placard locations", "Backfed breaker warning where applicable", "Power source directory"],
      codeReferences: [rapidShutdownRef, powerSourceDirectoryRef],
    }));
  }

  const intercoText = `${project.interconnectionMethod}\n${str(project, "interco")}`;
  const bus = num(project, ["busRating"]);
  const mainBreaker = num(project, ["mainBreaker"]);
  const pvBreaker = num(project, ["pvBreaker"]);
  if (/load.side|breaker|back.?feed|bus/i.test(intercoText)) {
    if (bus != null && mainBreaker != null && pvBreaker != null && mainBreaker + pvBreaker > bus * 1.2) {
      out.push(finding({
        id: "city.elec.load-side-over-120",
        severity: "blocker",
        category: "electrical",
        title: "Load-side interconnection exceeds 120 percent bus screen",
        message: `Captured ratings produce ${mainBreaker}A main + ${pvBreaker}A PV on a ${bus}A bus, which exceeds 120 percent of bus rating.`,
        cityFeedback: "Revise the interconnection design. The load-side calculation shown by the captured data does not satisfy the common 120 percent busbar screen. Provide a compliant alternate calculation, breaker relocation, de-rated main, supply-side connection, service upgrade, or engineered basis as applicable.",
        designTeamAction: "Correct the interconnection method and update the one-line/load calculation.",
        evidenceNeeded: ["MSP bus rating", "Main breaker rating", "PV breaker/OCPD rating", "705.12 calculation or alternate basis"],
        codeReferences: [loadSideRef],
      }));
    } else if (!hasAny(all, [/705\.12/i, /120%|120 percent/i, /busbar/i, /bus bar/i]) || bus == null || mainBreaker == null || pvBreaker == null) {
      out.push(finding({
        id: "city.elec.load-side-calc-missing",
        severity: bus == null || mainBreaker == null || pvBreaker == null ? "blocker" : "warning",
        category: "electrical",
        title: "Load-side interconnection calculation incomplete",
        message: "The package does not clearly show the load-side interconnection ratings/calculation.",
        cityFeedback: "Provide the NEC load-side interconnection calculation on the SLD, including bus rating, main breaker rating, PV breaker/OCPD rating, inverter output current basis, breaker location, and any required warning label.",
        designTeamAction: "Add the 705.12 calculation and verify it matches the MSP schedule.",
        evidenceNeeded: ["MSP bus rating", "Main breaker rating", "PV breaker/OCPD rating", "Breaker location/opposite-end note", "Inverter output current basis"],
        codeReferences: [loadSideRef, powerSourceDirectoryRef],
      }));
    }
  }

  if (/line.side|supply.side|tap/i.test(intercoText) && !hasAny(all, [/705\.11/i, /supply.side/i, /line.side/i, /tap/i, /service conductor/i, /fused disconnect/i])) {
    out.push(finding({
      id: "city.elec.supply-side-detail-missing",
      severity: "blocker",
      category: "electrical",
      title: "Supply-side connection detail missing",
      message: "The project appears to use a supply-side/line-side connection but the service tap detail was not found.",
      cityFeedback: "Provide a supply-side connection detail showing exact tap location, service conductor sizes, disconnect/OCPD, conductor lengths/routing, service equipment listing implications, grounding/bonding, and utility approval requirements.",
      designTeamAction: "Add a supply-side connection detail and utility coordination note.",
      evidenceNeeded: ["Tap point detail", "Service conductor/OCPD sizing", "PV disconnect location", "Utility approval note"],
      codeReferences: [supplySideRef, electricalRef],
    }));
  }

  const moduleFields = [str(project, "moduleMake"), str(project, "moduleModel"), str(project, "moduleWattage"), str(project, "moduleQty")].filter(Boolean);
  const inverterFields = [str(project, "invModel"), str(project, "pvMicroModel"), str(project, "inverterModel"), str(project, "invQty"), str(project, "pvMicroQty")].filter(Boolean);
  const hasModuleSpec = hasAny(all, [/module spec/i, /module data/i, /\bUL\s*61730\b/i, /\bUL\s*1703\b/i]);
  const hasInverterSpec = hasAny(all, [/inverter spec/i, /microinverter spec/i, /\bUL\s*1741\b/i, /PCS/i]);
  // Core equipment data present = the schedule IS there (make/model/wattage/qty for
  // modules and at least model+qty for the inverter). When that's the case, only a
  // separate SPEC-SHEET is unverified, which is a non-blocking callout the human
  // confirms — not a warning that the equipment is "missing". The warning/blocker
  // is reserved for genuinely missing core fields.
  const coreEquipmentPresent = moduleFields.length >= 4 && inverterFields.length >= 2;
  if (moduleFields.length < 4 || inverterFields.length < 2 || !hasModuleSpec || !hasInverterSpec) {
    const severity = !coreEquipmentPresent ? "blocker" : "callout";
    out.push(finding({
      id: "city.elec.equipment-specs-incomplete",
      severity,
      category: "electrical",
      title: coreEquipmentPresent ? "Equipment spec sheets — confirm attached" : "Equipment schedule/spec package incomplete",
      message: coreEquipmentPresent
        ? "Module/inverter schedule is present; confirm the matching spec sheets are attached."
        : "Module/inverter schedule or spec-sheet evidence is incomplete.",
      cityFeedback: "Provide a complete equipment schedule and matching specification sheets for modules, inverter(s)/microinverters, racking, rapid shutdown devices, ESS equipment if applicable, and disconnect/OCPD equipment. Equipment names on specs must match the SLD and application.",
      designTeamAction: coreEquipmentPresent
        ? "Confirm module/inverter/racking/RSD spec sheets are included and model numbers match the schedule."
        : "Add missing equipment fields/spec sheets and reconcile model numbers across the plan set.",
      evidenceNeeded: ["Module make/model/wattage/quantity", "Inverter or microinverter make/model/quantity/output", "Module and inverter spec sheets", "Racking and RSD spec sheets"],
      codeReferences: [electricalRef, rapidShutdownRef],
    }));
  }

  const dcKw = project.systemSizeDcKw ?? num(project, ["dcKw"]);
  const moduleQty = num(project, ["moduleQty"]);
  const moduleWattage = num(project, ["moduleWattage"]);
  if (dcKw != null && moduleQty != null && moduleWattage != null) {
    const calculatedDc = (moduleQty * moduleWattage) / 1000;
    if (Math.abs(calculatedDc - dcKw) > 0.15) {
      out.push(finding({
        id: "city.elec.dc-size-mismatch",
        severity: "blocker",
        category: "electrical",
        title: "DC size mismatch",
        message: `Captured module count/wattage calculates ${calculatedDc.toFixed(2)} kW DC but project DC size is ${dcKw.toFixed(2)} kW.`,
        cityFeedback: "Revise the equipment schedule/application so module quantity, module wattage, and DC system size match across all sheets and portal fields.",
        designTeamAction: "Correct either module quantity, module wattage, or DC kW and regenerate affected application fields.",
        evidenceNeeded: ["Corrected equipment schedule", "Corrected application DC size", "Matching SLD/module sheet"],
        codeReferences: [electricalRef],
      }));
    }
  }

  const batteryText = `${str(project, "batteryModel")}\n${str(project, "batteryQty")}\n${all}`;
  if (hasAny(batteryText, [/battery/i, /\bESS\b/i, /powerwall/i, /encharge/i, /backup/i]) && !hasAny(batteryText, [/clearance/i, /working space/i, /ESS/i, /706/i, /R328/i, /1207/i, /fire/i])) {
    out.push(finding({
      id: "city.ess.details-missing",
      severity: "warning",
      category: "electrical",
      title: "Battery/ESS detail not reviewable",
      message: "Battery/ESS scope appears present but location, clearance, disconnect, and fire-code details are not obvious.",
      cityFeedback: "Provide ESS equipment schedule, location plan, working clearance, ventilation/listing basis, disconnect/emergency shutdown details, labels, and local fire-code notes.",
      designTeamAction: "Add ESS detail sheets and verify local fire/AHJ requirements.",
      evidenceNeeded: ["ESS model/quantity", "ESS location plan", "Clearance and working space notes", "Disconnect/shutdown/label callouts"],
      codeReferences: [essRef],
    }));
  }

  return out;
}
