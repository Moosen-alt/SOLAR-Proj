import type { AhjProcessProfile, CodeReference, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import type { EffectiveCodeContext } from "./codeProfiles";
import { FIRE_PATHWAY_PATTERNS } from "./projectEvidence";
import { pathWordingScope } from "./permitPath";

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

// A FIELD WITH TWO NUMBERS IN IT IS NOT A NUMBER.
//
// This used to delete every non-digit and parseFloat whatever was left, so a rating that
// carried a note became the CONCATENATION of its numbers. The live book holds a real example:
// pvBreaker "50A (fuses in 60A AC disconnect at line-side tap)" read as 5060 amps. It fails in
// both directions, which is what makes it dangerous rather than merely wrong:
//   - busRating "200A (Note 3)" -> 2003, so a genuine 200A/200A/60A violation (260A against a
//     240A allowance) sits far below 120% of 2003 and the blocker goes SILENT;
//   - mainBreaker "175A (2 of 2)" -> 17522, so a COMPLIANT design is blocked, with the report
//     printing "17522A main" to the operator.
//
// So: one number means one number. Several numbers with exactly one carrying an amp unit means
// that one — "50A (fuses in 60A AC disconnect)" is unambiguous to a human and should be to us.
// Anything still ambiguous returns null, which routes to city.elec.load-side-calc-missing
// ("ratings not readable") instead of a confident calculation on a fabricated figure. An
// unknown must not read as a number.
function parseRating(raw: string): number | null {
  const numbers = raw.match(/-?\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0) return null;
  if (numbers.length === 1) {
    const only = Number.parseFloat(numbers[0]);
    return Number.isFinite(only) ? only : null;
  }
  // Several numbers: let the UNITS disambiguate, but only when they point at exactly one.
  // "50A (fuses in 60A AC disconnect)" names two currents and stays ambiguous; "200A, 120/240V"
  // names one current and a voltage, so the current wins. Volts are deliberately absent from
  // this list — a service voltage is never the rating any of these rules is asking for, and
  // admitting it would re-ambiguate every field that states one.
  const united = [...raw.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:A\b|AMPS?\b|PSF\b|PCF\b|MPH\b|FT\b|FEET\b|IN\b|INCH(?:ES)?\b)/gi)].map((m) => m[1]);
  const distinct = [...new Set(united)];
  if (distinct.length === 1) {
    const value = Number.parseFloat(distinct[0]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function num(project: ProjectRecord, keys: string[]): number | null {
  for (const key of keys) {
    const raw = str(project, key);
    if (!raw) continue;
    const value = parseRating(raw);
    if (value != null) return value;
  }
  return null;
}

function designText(project: ProjectRecord): string {
  const keys = [
    // Text extracted from the uploaded plan-set-family PDFs (overlaid on the snapshot
    // by getProjectDetail) — so rules check the ACTUAL sheets, not only parser output.
    "planSetExtractedText",
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

// IS THIS ON A ROOF? Everything downstream hangs on the answer: fire access pathways, roof
// framing, and racking attachment/flashing are all ROOF rules, and a ground array has none of
// those things — it has piers, a foundation and a trench.
//
// This used to read `project.interconnectionMethod` and the plan-text blob, and never the
// parser's own `mounting` field — the one place the answer is actually recorded. A ground-mount
// project therefore collected three roof blockers (fire pathways, roof framing, roof
// attachment) unless the words "ground mount" happened to appear in its extracted text, which
// on a freshly uploaded set has not been extracted yet. Found 2026-09-22 while stress-testing
// the gate. It also did not know "pole mount", which permitPath.ts has always recognised — two
// modules answering the same question with different vocabularies.
//
// The mounting FIELD is authoritative when present; the text stays as the fallback for a parse
// that did not capture it. Silence still means roof, which is the conservative direction: roof
// rules are the stricter set, so an unknown mount is over-reviewed rather than under-reviewed.
// CARPORT IS NOT GROUND, for one rule. A carport/canopy has no dwelling roof, so the fire
// access pathway, roof framing and flashing rules do not apply to it — but NEC 690.12 rapid
// shutdown governs PV "on buildings", and whether a carport counts is an AHJ call, not ours.
// So the predicate answers THREE ways and the RSD rule reads the distinction: ground and pole
// are exempt, a carport keeps its rapid-shutdown requirement. Decided deliberately 2026-09-22;
// the reasoning is pinned in groundMountScope.test.ts so a later reader can overturn it on
// purpose rather than by accident.
export type MountKind = "roof" | "ground" | "carport" | "unknown";

export function mountKind(project: ProjectRecord, allText: string): MountKind {
  const mounting = str(project, "mounting");
  const probe = mounting || `${project.interconnectionMethod}\n${allText}`;
  if (/carport|canopy|awning|patio cover/i.test(probe)) return "carport";
  if (/ground[-\s]?mount|ground.?mounted|ground.?array|pole[-\s]?mount/i.test(probe)) return "ground";
  if (mounting) return "roof";
  // Silence means roof, which is the conservative direction: the roof rules are the stricter
  // set, so an unknown mount is over-reviewed rather than under-reviewed.
  return "unknown";
}

/** True when the array sits on a roof and the roof rule family applies. */
export function isRoofMounted(project: ProjectRecord, allText: string): boolean {
  const kind = mountKind(project, allText);
  return kind === "roof" || kind === "unknown";
}

/** NEC 690.12 governs PV on BUILDINGS — a ground/pole array is not on one; a carport may be. */
export function rapidShutdownApplies(project: ProjectRecord, allText: string): boolean {
  return mountKind(project, allText) !== "ground";
}

// The one entry point other modules should use. It derives the design text itself, so a second
// caller cannot reach a different answer by feeding the predicate a different blob — which is
// precisely how the reviewer engine and this module came to disagree about the same array.
export function mountKindForProject(project: ProjectRecord): MountKind {
  return mountKind(project, designText(project));
}

// Module-level power electronics (microinverters / RSD-integrated optimizers) provide
// inherent module-level rapid shutdown under NEC 690.12. When the design is MLPE-based,
// a missing RSD plan callout is a labeling/documentation gap — not a missing-equipment
// blocker that should stop staging.
// A BRAND NAME IS NOT AN INVERTER TOPOLOGY. MLPE satisfies NEC 690.12 inherently, so an MLPE
// design has its rapid-shutdown finding softened from blocker to warning — which means getting
// this wrong DOWNGRADES a safety blocker. The old test scanned the whole plan text for brands,
// and Enphase makes batteries: measured, a SolarEdge string-inverter system carrying an Enphase
// IQ Battery was reclassified as MLPE and had its blocker softened.
//
// So the INVERTER FIELDS decide when they exist — brand names are meaningful there, because
// that field names the inverter. The plan text is only a fallback for a parse that captured no
// inverter at all, and the fallback asks for topology words rather than brands, since every one
// of those brands also sells storage.
const MLPE_TOPOLOGY = [
  /micro.?inverter/i,
  /\bmlpe\b/i,
  /module.level (power electronics|shutdown|rapid shutdown)/i,
];
const MLPE_INVERTER_BRANDS = [
  /enphase|\biq\s?[678]\b/i,
  /ap\s?systems|apsystems|\bds3\b|\bqs1\b|\byc600\b/i,
  /hoymiles/i,
  /tigo\s?(ts4|rsd)/i,
];

function isMlpeDesign(project: ProjectRecord, allText: string): boolean {
  const microModel = str(project, "pvMicroModel");
  const inverterText = [
    microModel,
    str(project, "pvMicroQty") ? "microinverter" : "",
    str(project, "invModel"),
    str(project, "inverterModel"),
  ].filter(Boolean).join("\n");

  // An inverter is on file: it answers the question, brands included.
  if (inverterText.trim()) return hasAny(inverterText, [...MLPE_TOPOLOGY, ...MLPE_INVERTER_BRANDS]);

  // Nothing recorded — fall back to the sheets, but only on topology language.
  return hasAny(allText, MLPE_TOPOLOGY);
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

/**
 * Documents that ARE the stamped engineering. `structural` is deliberately absent: that is
 * the framing sheet out of the plan set, which is what a design HAS while still owing the
 * jurisdiction a sealed calculation. Bren Trask's Portland package carried `structural` and
 * a plan set naming a Vector Structural Engineering review block, and Portland still
 * demanded calculations — because none had been attached.
 */
const STAMPED_ENGINEERING_DOC_TYPES = ["structural_letter", "stamped_plans", "engineering_letter"];

export function evaluateDesignCodeFindings(
  project: ProjectRecord,
  profile: AhjProcessProfile | null,
  ctx?: EffectiveCodeContext,
  uploadedDocTypes: string[] = [],
): ReviewerFinding[] {
  const out: ReviewerFinding[] = [];
  const all = designText(project);
  // A STAMP IS A DOCUMENT, NOT A SENTENCE ABOUT ONE.
  const hasStampedEngineering = uploadedDocTypes.some((t) => STAMPED_ENGINEERING_DOC_TYPES.includes(String(t)));
  const roofMounted = isRoofMounted(project, all);
  const rsdApplies = rapidShutdownApplies(project, all);
  const oregon = isOregon(project, profile);
  // "NON-PRESCRIPTIVE" CONTAINS "PRESCRIPTIVE". A bare substring test therefore read an
  // explicitly engineered project as a prescriptive one and inverted the structural gate:
  // measured, permitPath "Non-prescriptive" produced the prescriptive blockers (span table,
  // loads) and — the dangerous half — did NOT raise city.struct.stamped-engineering-missing,
  // while "Engineered" correctly did. So a project flagged non-prescriptive was never asked
  // for the stamped engineering it needs.
  //
  // That is not a hypothetical wording: the operator's standing ruling is that a PV install on
  // a TPO roof in Oregon is automatically non-prescriptive, and those are exactly the jobs that
  // had to get stamps. permitPath.ts already classifies this correctly — it tests the
  // non-/engineered wording BEFORE the prescriptive substring — so use it rather than keeping a
  // second, wrong opinion here.
  const prescriptive = pathWordingScope(str(project, "permitPath")) === "prescriptive";

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

  // Same vocabulary as projectEvidence's firePathway topic, imported rather than restated.
  // The old list here accepted a bare "setback" or "ridge" — ordinary zoning and roof-geometry
  // words — so this rule cleared on any plan set too, in step with the evidence topic. Letting
  // the two drift apart is how the gate ends up contradicting itself about the same project.
  if (roofMounted && !hasAny(all, FIRE_PATHWAY_PATTERNS)) {
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

  // /structural/i and /engineer/i cleared this, and title blocks carry both — so "STRUCTURAL
  // ENGINEER OF RECORD: SMITH PE" was accepted as framing evidence. Worse, the sentence "NO
  // STRUCTURAL FRAMING INFORMATION WAS AVAILABLE" also contains "structural", so the report
  // cleared itself on a statement of its own ignorance. Ask for MEMBERS.
  if (roofMounted && !hasAny(all, [
    /\brafter/i, /\btruss/i, /\bjoist/i,
    /span\s*table/i,
    /\d+\s*x\s*\d+\s*(?:@|at\b|o\.?c\.?)/i,
    /o\.?c\.?\s*spacing/i,
    /framing\s*(?:member|type|plan|detail|size)/i,
  ])) {
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

  // THE DESIGN LEANS ON ENGINEERING IT HAS NOT ATTACHED.
  //
  // Portland bounced Bren Trask (26-033226-000-00-RS) on the roof: "Roof is overspanned. In
  // the prescriptive span tables, 2x4 rafters can span roughly half the distance that is
  // shown in the drawings... Unsupported intermediate brace or collar tie do not alter span
  // length of rafter. Please provide engineering calculations to show that roof structure is
  // adequate to support proposed system."
  //
  // Everything needed to see that coming was on file. permitPath was "engineered", the plan
  // set named a Vector Structural Engineering review block, the framing sheets showed 2x4
  // rafters at 24" o.c. — and no sealed calculation was ever attached. A design that
  // declares itself engineered owes the jurisdiction the stamp; strict AHJs (Portland
  // emphatically, and it is not alone) will not approve on the reference alone.
  //
  // Worse, that same reference used to SILENCE the span warning below, because the old
  // suppression matched the word "engineer" anywhere in the design text. A plan set that
  // merely mentioned engineering muted the one check that would have caught the overspan.
  // Same classifier as the prescriptive flag above, so the two cannot disagree about one
  // project. /engineer/i alone missed "Non-prescriptive" — the operator's own wording for a
  // TPO-roof job — which is exactly the case that needs a stamp. pathWordingScope reads that
  // as engineered; the plan-text signals below stay as the independent second route in.
  const claimsEngineered = pathWordingScope(str(project, "permitPath")) === "engineered"
    || hasAny(all, [/stamped structural/i, /structural letter/i, /sealed by/i, /\bP\.?E\.?\b/, /engineering (calc|letter|review|analysis)/i]);
  if (roofMounted && claimsEngineered && !hasStampedEngineering) {
    out.push(finding({
      id: "city.struct.stamped-engineering-missing",
      // The design DEPENDS on it when it declares the engineered path — that is a blocker,
      // not a note. A passing reference in an otherwise prescriptive package is a warning.
      // Read the PATH through the shared classifier: /engineer/i was a third independent
      // opinion about the same question and it did not recognise "Non-prescriptive", so the
      // operator's own wording for a TPO job produced a warning where it owed a blocker.
      severity: pathWordingScope(str(project, "permitPath")) === "engineered" ? "blocker" : "warning",
      category: "structural",
      title: "Engineered design with no stamped calculation attached",
      message: "The design relies on structural engineering, but no stamped/sealed engineering document is in the package.",
      cityFeedback: "Provide the wet- or digitally-stamped structural calculations or engineer's letter covering rafter size, spacing, clear span, and the PV attachment/point loads for this roof.",
      designTeamAction: "Obtain the sealed calculation package from the engineer of record before submittal — a review-block reference on the plan set is not the stamp, and strict jurisdictions (Portland among them) will issue a correction for it.",
      evidenceNeeded: ["Stamped/sealed structural calculation or engineer's letter", "Rafter size, spacing and clear span used in the calculation", "PV dead load and attachment point loads"],
      codeReferences: [...oregonWorksheetRefs, roofLoadsRef],
    }));
  }

  // TRUSSES HAVE NO SPAN-TABLE DEMAND. The state's own prescriptive screen (BCD 5952,
  // encoded in bcdChecklistFacts) splits framing into two arms: the TRUSS arm asks for
  // framing type + spacing <= 24" — trusses are pre-engineered components — while clear
  // span (+ the rafter exception) belongs only to the RAFTER arm. This rule used to
  // demand span for both, which blocked Brittany Reavis's 2x4 truss @ 24" o.c. roof —
  // the exact roof Salem issued 26-108868-DW for, prescriptive, no span table anywhere.
  // Rafters keep the full demand: Portland bounced Trask for precisely that overspan.
  // ONLY AN UNAMBIGUOUS TRUSS EARNS THE EXEMPTION. A bare /truss/i opened it for
  // "rafter/truss", "truss or rafter (unverified)" and even "not truss" — dropping the very
  // clear-span demand that caught the overspan Portland bounced Trask for. Ambiguity keeps the
  // full demand, because the stricter arm is the safe one to land on when the framing is
  // genuinely unclear.
  const framingTypeText = str(project, "framingType");
  const trussFraming = /\btruss(?:es)?\b/i.test(framingTypeText)
    && !/\brafter/i.test(framingTypeText)
    && !/\bno[nt]?[-\s]?truss|not\s+a?\s*truss/i.test(framingTypeText);
  const spanEvidenceIncomplete = trussFraming
    ? rafterSpacing == null
    : rafterSpacing == null || rafterSpan == null;

  // Suppression now requires the DOCUMENT, not a mention of one — see above.
  if (roofMounted && prescriptiveScreening && !hasStampedEngineering && spanEvidenceIncomplete) {
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

  // /mount/i CLEARED THIS, and every plan set says "roof mount". Measured on the live book:
  // projects carrying no extracted plan text at all passed this screen, because their
  // `mounting` FIELD reads "Roof mount". /rail/i was satisfied by a guardrail and /lag/i by
  // any word containing those three letters. Ask instead for what an attachment detail
  // actually contains.
  if (roofMounted && !hasAny(all, [
    /attachment\s*(?:detail|schedule|spacing|point)/i,
    /standoff/i, /flashing/i, /flashfoot/i, /l.?foot/i,
    /lag\s*(?:screw|bolt)/i, /fastener/i, /embedment/i, /pull.?out/i,
    /racking\s*(?:detail|spec|schedule|plan)/i,
    /mount(?:ing)?\s*(?:detail|hardware|spacing|schedule)/i,
  ])) {
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

  if (rsdApplies && !hasAny(all, [/rapid shutdown/i, /\bRSD\b/i, /690\.12/i])) {
    const mlpe = isMlpeDesign(project, all);
    out.push(finding({
      id: "city.elec.rapid-shutdown-missing",
      // MLPE designs (microinverters / RSD optimizers) satisfy module-level rapid
      // shutdown inherently — the remaining gap is the plan callout/label, which is
      // a warning, not a staging blocker.
      severity: mlpe ? "warning" : "blocker",
      category: "electrical",
      title: mlpe ? "Rapid shutdown callout missing (MLPE design)" : "Rapid shutdown not shown",
      message: mlpe
        ? "The design uses microinverters/module-level power electronics, which provide inherent module-level rapid shutdown, but the plans do not call out NEC 690.12 compliance or the RSD label."
        : "No rapid shutdown callout or equipment evidence was detected.",
      cityFeedback: mlpe
        ? "Add a rapid shutdown note to the electrical plans stating the module-level shutdown basis (microinverter/MLPE listing) and show the required rapid shutdown label/placard for the adopted NEC cycle."
        : "Revise the electrical plans to identify rapid shutdown equipment, initiation/control location, controlled conductors or array boundary basis, and required field marking for the adopted NEC cycle.",
      designTeamAction: mlpe
        ? "Add a 690.12 module-level shutdown note and RSD label callout to the SLD/label schedule (equipment already complies)."
        : "Add RSD equipment and label callouts to the SLD/site/equipment schedule.",
      evidenceNeeded: mlpe
        ? ["690.12 module-level shutdown note", "RSD label/placard callout", "Microinverter/MLPE listing reference"]
        : ["RSD device or inverter listing basis", "RSD initiation/control location", "RSD label/placard callout", "Code-cycle note"],
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

  // WHICH SIDE OF THE SERVICE IS THIS? The 120% busbar screen is NEC 705.12(B)(3)(2) — a
  // LOAD-SIDE rule. A SUPPLY-SIDE (line-side) tap is 705.11 and is not governed by it at all:
  // the question there is whether the tap conductors and their OCPD are sized to the service.
  //
  // The old gate matched the bare word "breaker", so Edgar Miner's parsed interconnection
  // "Supply Breaker" — corroborated by his own plan set, "POINT OF INTERCONNECT, SUPPLY
  // BREAKER FEED THRU LUG" — was measured against the load-side rule and produced a BLOCKER
  // that the code it cites does not support. 200A main + 50A PV on a 200A bus exceeds 240A
  // and would be a real finding on a load-side design; on a supply-side tap it is not the
  // test. Found 2026-09-22 while stress-testing the gate.
  //
  // THREE ANSWERS, NOT TWO, and the third is the honest one. Silence would be worse than the
  // false blocker: a supply-side design still has to be checked, just against a different
  // rule. So supply side gets its own callout naming 705.11, an interconnection naming BOTH
  // is reported as ambiguous rather than guessed, and only a genuine load-side design is
  // measured against 120%.
  const saysSupplySide = /supply.?side|supply breaker|line.?side|705\.11|ahead of (?:the )?main|feed.?thr(?:u|ough) lug|service.entrance tap/i.test(intercoText);
  const saysLoadSide = /load.?side|back.?fed|back.?feed|705\.12/i.test(intercoText);

  if (saysSupplySide && !saysLoadSide) {
    out.push(finding({
      id: "city.elec.supply-side-tap",
      severity: "callout",
      category: "electrical",
      title: "Supply-side tap — the 120% busbar screen does not apply",
      message: `The interconnection is recorded as "${str(project, "interco") || project.interconnectionMethod}", a supply-side (line-side) connection. NEC 705.12(B)(3)(2)'s 120% busbar calculation governs LOAD-side connections and is not the applicable test here.`,
      cityFeedback: "Show the supply-side tap detail: tap conductor size and ampacity relative to the service, the PV disconnect/OCPD ahead of the service disconnect, and the labelling required at the service equipment.",
      designTeamAction: "Confirm the tap conductors and overcurrent protection are sized to the service per NEC 705.11, and that the busbar calculation is correctly omitted rather than missing.",
      evidenceNeeded: ["Supply-side tap detail on the one-line", "Tap conductor size/ampacity vs service rating", "PV disconnect and OCPD location", "Service-equipment labelling"],
      // 705.11, not 705.12. This finding EXISTS to say the load-side busbar screen does not
      // govern here, so citing the load-side section as its basis contradicted its own text.
      codeReferences: [supplySideRef],
    }));
  } else if (saysSupplySide && saysLoadSide) {
    out.push(finding({
      id: "city.elec.interconnection-ambiguous",
      severity: "warning",
      category: "electrical",
      title: "Interconnection method names both supply side and load side",
      message: `The recorded interconnection ("${str(project, "interco") || project.interconnectionMethod}") carries both supply-side and load-side language, and the two answer to different code sections — 705.11 versus the 705.12(B)(3)(2) busbar screen.`,
      cityFeedback: "State the interconnection method unambiguously on the one-line, with the calculation that matches it.",
      designTeamAction: "Settle which connection the design actually makes before filing; the reviewer cannot apply the right screen until it is stated once.",
      evidenceNeeded: ["Interconnection method stated once on the one-line", "The matching calculation (705.11 tap sizing OR the 705.12 busbar screen)"],
      // The whole content of this finding is that the design has not said WHICH of the two
      // governs, so both are cited — matching the message's own "705.11 versus 705.12".
      codeReferences: [supplySideRef, loadSideRef],
    }));
  } else if (/load.side|breaker|back.?feed|bus/i.test(intercoText)) {
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
  } else {
    // THE MISSING DOOR. This chain had no final else, so an interconnection matching none of
    // the three vocabularies above fell off the end and produced NOTHING — not a blocker, not
    // a warning, not a callout. The 120% busbar arithmetic exists in exactly one place (the
    // branch above) and nothing downstream repeats it: QC checks that the rating FIELDS ARE
    // PRESENT, never that the math passes. So an unrecognised wording did not merely skip a
    // label, it skipped the only NEC 705.12 calculation in the product.
    //
    // The trigger is not exotic. "Net Metering" is the FIRST example value in the parser's own
    // prompt (llm.ts), and Daniel Daly's live row carries exactly that string — measured, his
    // filing has never had its busbar screen run. Six of eight realistic wordings were silent.
    //
    // An unknown method is NOT routed into the load-side branch: demanding a 705.12 busbar calc
    // from what may be a supply-side tap would just trade a silent hole for a false demand.
    // It gets its own finding that asks the one question that resolves it.
    out.push(finding({
      id: "city.elec.interconnection-unclassified",
      severity: "warning",
      category: "electrical",
      title: "Interconnection method not classifiable — the busbar screen did not run",
      message: `The recorded interconnection ("${str(project, "interco") || project.interconnectionMethod}") does not say whether the connection is supply side or load side, and the two answer to different code sections. No interconnection calculation has been checked for this project.`,
      cityFeedback: "State the interconnection method explicitly on the one-line — supply-side/line-side tap, or load-side breaker connection — with the calculation that matches it.",
      designTeamAction: "Record the method as supply side or load side. A load-side connection needs the 705.12 busbar screen (bus rating, main breaker, PV breaker); a supply-side tap needs the 705.11 tap detail and conductor sizing.",
      evidenceNeeded: ["Interconnection method stated as supply side or load side", "MSP bus rating", "Main breaker rating", "PV breaker/OCPD rating"],
      codeReferences: [supplySideRef, loadSideRef],
    }));
  }

  // GATED ON THE CLASSIFIER, not on a second, narrower vocabulary of its own. This rule used
  // to test /line.side|supply.side|tap/ — so the phrasings the supply-side classifier learned
  // ("Supply Breaker", "ahead of the main", "feed-thru lug") were called supply-side by one
  // rule and not by this one, and never had to show a tap detail at all.
  //
  // The suppression list is tightened at the same time. /tap/i was satisfied by the word
  // "tape", and /supply.side/i was very nearly circular: a plan set that says "supply side"
  // once counted as having SHOWN the detail. What a tap detail actually contains is the tap
  // point, the service conductor sizing, and the disconnect — so ask for those.
  if (saysSupplySide && !hasAny(all, [
    /705\.11/i,
    /tap\s*(?:point|detail|conductor)/i,
    /service\s*(?:entrance\s*)?conductor/i,
    /fused\s*disconnect/i,
    /line.?side\s*(?:tap|connection)\s*detail/i,
    /supply.?side\s*(?:tap|connection)\s*detail/i,
  ])) {
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
  // The suppression list held a bare /fire/i — and since the fire-pathway work every plan set
  // reliably carries "FIRE ACCESS PATHWAY", so that fix would itself have switched off every
  // battery review. It also held an unbounded /ESS/i, which matches "addrESS" and "procESS".
  // Word-boundary the acronym, and take fire SEPARATION/rating rather than the bare word.
  if (hasAny(batteryText, [/battery/i, /\bESS\b/i, /powerwall/i, /encharge/i, /backup/i])
    && !hasAny(batteryText, [
      /clearance/i, /working\s*space/i,
      /\bESS\b/i, /\b706\b/i, /R\s*328/i, /\b1207\b/i,
      /fire\s*(?:separation|barrier|rating)|fire.?rated/i,
    ])) {
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
