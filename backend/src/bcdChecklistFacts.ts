import type { ProjectRecord } from "../../shared/src/types";
import { classifyRoofCovering, oregonRoofingRowQualifies } from "./roofCovering";
type Answer = "Yes" | "No" | "";
type Fact = boolean | null;
const all = (...v: Fact[]): Fact => v.includes(false) ? false : v.includes(null) ? null : true;
const any = (...v: Fact[]): Fact => v.includes(true) ? true : v.includes(null) ? null : false;

/** The snapshot readers every BCD 5952 row answers from (one set, so the answers and the named
 *  failing clauses cannot read a fact two ways). */
function snapshotReaders(project: Pick<ProjectRecord, "parserSnapshot">) {
  const s = (project.parserSnapshot ?? {}) as Record<string, unknown>;
  const str = (k: string) => String(s[k] ?? "").trim().toLowerCase();
  const flag = (k: string): Fact => /^(yes|true)$/.test(str(k)) ? true : /^(no|false)$/.test(str(k)) ? false : null;
  const n = (k: string) => { const m = str(k).match(/^\s*(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
  const max = (k: string, limit: number): Fact => n(k) == null ? null : n(k)! <= limit;
  return { s, str, flag, n, max };
}

/** METHOD 2 IS THE STANDING-SEAM METAL CLAMP METHOD — a roof the classifier (roofCovering.ts, the one
 *  predicate) recognises as any other covering answers it No, never "unknown" (dry-run 2026-09-28 B4:
 *  on a composition-shingle roof it stayed null, so a failed Method 1 printed the attachment row
 *  BLANK instead of No, and no question could ever fill it). Metal, or a covering the documents do not
 *  name, keeps the stated standing-seam answer (null when nobody stated one). */
function method2Fact(project: Pick<ProjectRecord, "parserSnapshot">): Fact {
  const { s, flag } = snapshotReaders(project);
  const family = classifyRoofCovering(s.roofMaterial, s.roofMaterialSubtype).family;
  return family === "metal" || family === "unknown" ? flag("standingSeamMethod2Compliant") : false;
}

/** BCD 5952 compound statements. A numeric fact alone does not establish a
 * separate code-compliance clause. Unknown remains blank, never a false No. */
export function bcdChecklistAnswers(project: Pick<ProjectRecord, "parserSnapshot">): Record<string, Answer> {
  const { s, str, flag, n, max } = snapshotReaders(project);
  const frame = str("framingType");
  const truss = all(frame ? /truss/.test(frame) : null, max("roofRafterSpacing", 24));
  const rafter = all(frame ? /rafter/.test(frame) : null, max("roofRafterSpacing", 24), flag("rafterExceptionCompliant"));
  const roof = str("roofMaterial");
  // A RECOGNIZED membrane covering (TPO/EPDM/PVC/built-up...) is a known "No", not an
  // unknown — the form's roofing row admits only metal / wood shingle-shake / <=2-layer
  // composition, and Oregon treats membrane-roof PV as non-prescriptive outright
  // (operator ruling 2026-09-21; Simmons's real permit 187-26-000328-STR went structural).
  // In practice such a project routes engineered and this form is never built for it —
  // this keeps the row honest for any copy that does get filled.
  // TILE is a known "No" for the same reason (concrete / clay / S-tile / flat tile are not in the
  // row's list), and it is classified FIRST so "concrete shake tile" never reads as wood shake and
  // "tile shingle" never as composition — roofCovering.ts is the one predicate for all of this.
  const roofing = !roof ? null : oregonRoofingRowQualifies(s.roofMaterial, s.roofMaterialSubtype, s.roofLayers);
  const exposure = str("wind").toUpperCase();
  const spaced = n("attachmentSpacingIn");
  const method1 = all(flag("attachmentToFraming"), spaced == null ? null : spaced <= 24 ? true :
    all(spaced <= 48, max("snow", 36),
      any(flag("attachmentsOutsideEdgeZone"), max("attachmentEdgeSpacingIn", 24)),
      exposure === "B" ? max("windSpeed", 120) : exposure === "C" ? max("windSpeed", 110) : null));
  const method2 = method2Fact(project);
  // The height row is ONE compound statement ("no more than 18 inches … per the figures"). The
  // operator's single answer to that statement (moduleHeightFiguresCompliant — an intake
  // question) settles it; otherwise both stated facts must.
  const heightAnswer = flag("moduleHeightFiguresCompliant");
  // ASSUMED YES WHEN NOTHING SAYS OTHERWISE (operator ruling 2026-09-27, "just assume yes"): a
  // blank height row shipped on Michael Sheridan's checklist because no document states the
  // standoff and nobody had answered the intake question. A stated height over 18 in, or an
  // explicit "No" to either fact or to the question, still answers No; only the UNKNOWN case
  // is assumed. The question is no longer asked as a blocker (formFactIntakeQuestions).
  const heightFacts = all(max("moduleHeightAboveRoof", 18), flag("moduleFiguresCompliant"));
  const facts: Record<string, Fact> = {
    designInstallation: all(flag("gravityWindDesign"), flag("manufacturerInstallation")),
    framing: any(truss, rafter), truss, rafter, roofing,
    heightFigures: heightAnswer !== null ? heightAnswer : heightFacts === false ? false : true,
    attachments: any(method1, method2), method1, method2,
  };
  return Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v === true ? "Yes" : v === false ? "No" : ""]));
}

// ── WHAT IS STILL MISSING, NAMED EXACTLY ────────────────────────────────────────────────
// The fill note said "Still needs evidence: roof material and layer count" on a project whose
// roof material WAS parsed ("Composition Shingle"); the operator read the blank row beside the
// form's own metal/standing-seam wording as "it's filling in metal roofing". Name the one fact
// that is missing, and where it will come from.
export function bcd5952MissingFacts(project: Pick<ProjectRecord, "parserSnapshot">): Array<{ row: string; missing: string }> {
  const s = project.parserSnapshot ?? {};
  const has = (k: string) => String(s[k] ?? "").trim() !== "";
  const a = bcdChecklistAnswers(project);
  const out: Array<{ row: string; missing: string }> = [];
  if (!a.designInstallation) out.push({ row: "designInstallation", missing: "gravity/wind design and manufacturer-instructions statements" });
  if (!a.framing) {
    out.push({
      row: "framing",
      missing: rafterExceptionAsked(project) ? "rafter exception (ORSC R324.4.1 Exception 1.4-1.6) — operator question"
        : has("framingType") ? "framing spacing / rafter exception" : "framing type (truss or rafter) and spacing",
    });
  }
  if (!a.roofing) {
    const roof = String(s.roofMaterial ?? "").trim();
    out.push({
      row: "roofing",
      missing: !roof ? "roof material"
        : /compos|asphalt|wood|shake/i.test(roof) ? `roof layer count (the plan states a ${roof} roof but not how many layers — operator question)`
        : `a roof covering the row admits (plan states ${roof})`,
    });
  }
  if (!a.heightFigures) out.push({ row: "heightFigures", missing: "module height above the roof (18 in or less, per the figures) — operator question" });
  if (!a.attachments) out.push({ row: "attachments", missing: "attachment method compliance" });
  return out;
}

/** The rafter branch of the framing row is waiting on ONE fact no document states: rafters at 24 in
 *  or less whose R324.4.1 Exception 1.4-1.6 compliance nobody has answered (the parser is told to
 *  omit it when unknown). Asked as a form-fact question (formFactQuestions), named in the fill note. */
function rafterExceptionAsked(project: Pick<ProjectRecord, "parserSnapshot">): boolean {
  const { str, flag, max } = snapshotReaders(project);
  const frame = str("framingType");
  return /rafter/.test(frame) && !/truss/.test(frame) && max("roofRafterSpacing", 24) === true && flag("rafterExceptionCompliant") === null;
}

// ── A ROW THAT ANSWERS "NO", WITH THE CLAUSE THAT FAILED ────────────────────────────────
// The form says: "If No is selected for any of the above, the installation may not be submitted
// using the prescriptive path." A No row used to go out SILENTLY (bcd5952MissingFacts names only
// blank rows) — and the attachment row, whose Method 1 failed on a 48-in spacing at 120 mph
// Exposure C, printed blank because Method 2 read "unknown" on a shingle roof (dry-run 2026-09-28
// B4). One list, read by the fill note and by the permit-path screen (permitPath.ts), so the form
// and the resolver give one answer to "is this prescriptive?".
export interface Bcd5952FailedRow { row: "designInstallation" | "framing" | "roofing" | "heightFigures" | "attachments"; clause: string }
export function bcd5952FailedRows(project: Pick<ProjectRecord, "parserSnapshot">): Bcd5952FailedRow[] {
  const a = bcdChecklistAnswers(project);
  const { s, str, flag, n } = snapshotReaders(project);
  const out: Bcd5952FailedRow[] = [];
  const num = (k: string) => { const v = n(k); return v == null ? "" : String(v); };
  if (a.designInstallation === "No") {
    const why = [
      flag("gravityWindDesign") === false ? "the array is not stated as designed for the gravity and wind loads" : "",
      flag("manufacturerInstallation") === false ? "the installation is not stated as following the manufacturer's instructions" : "",
    ].filter(Boolean);
    out.push({ row: "designInstallation", clause: `design/installation row: No — ${why.join("; ") || "a design or installation statement answers No"}` });
  }
  if (a.framing === "No") {
    const frame = str("framingType");
    const spacing = n("roofRafterSpacing");
    const why = [
      frame && !/truss|rafter/.test(frame) ? `framing "${String(s.framingType).trim()}" is neither trusses nor rafters` : "",
      spacing != null && spacing > 24 ? `framing spaced ${spacing} in o.c. (the row admits 24 in or less)` : "",
      /rafter/.test(frame) && flag("rafterExceptionCompliant") === false ? "the rafters do not meet ORSC R324.4.1 Exception 1.4-1.6" : "",
    ].filter(Boolean);
    out.push({ row: "framing", clause: `framing row: No — ${why.join("; ") || "the framing does not meet the row"}` });
  }
  if (a.roofing === "No") {
    const roof = String(s.roofMaterial ?? "").trim();
    const family = classifyRoofCovering(s.roofMaterial, s.roofMaterialSubtype).family;
    const layers = num("roofLayers");
    out.push({
      row: "roofing",
      clause: `roofing row: No — ${family === "composition" && layers ? `${layers} layers of composition (the row admits two)`
        : family === "wood" && layers ? `${layers} layers of wood shingles/shakes (the row admits one)`
        : `the roof covering ("${roof || family}") is not metal, wood shingles/shakes or composition`}`,
    });
  }
  if (a.heightFigures === "No") {
    const height = n("moduleHeightAboveRoof");
    out.push({
      row: "heightFigures",
      clause: `module height row: No — ${height != null && height > 18 ? `modules ${height} in above the roof (the row admits 18 in)` : "the installation is stated as not following the figures"}`,
    });
  }
  if (a.attachments === "No") {
    const spaced = n("attachmentSpacingIn");
    const exposure = str("wind").toUpperCase();
    const speed = n("windSpeed");
    const method1: string[] = [];
    if (flag("attachmentToFraming") === false) method1.push("the attachments are not to the roof framing");
    if (spaced != null && spaced > 48) method1.push(`attachments spaced ${spaced} in (the method admits 48 in)`);
    if (spaced != null && spaced > 24 && spaced <= 48) {
      const snow = n("snow");
      if (snow != null && snow > 36) method1.push(`attachments spaced ${spaced} in need ground snow of 36 psf or less (plan ${snow} psf)`);
      const edge = n("attachmentEdgeSpacingIn");
      if (flag("attachmentsOutsideEdgeZone") === false && edge != null && edge > 24) method1.push(`attachments within 3 ft of roof edges, hips, eaves and ridges spaced ${edge} in (the method admits 24 in)`);
      const cap = exposure === "B" ? 120 : exposure === "C" ? 110 : null;
      if (cap != null && speed != null && speed > cap) method1.push(`attachments spaced ${spaced} in need an ultimate wind speed of ${cap} mph or less at Exposure ${exposure} (plan ${speed} mph); re-space the attachments to 24 in or less, or take the engineered path`);
    }
    const family = classifyRoofCovering(s.roofMaterial, s.roofMaterialSubtype).family;
    const method2 = family !== "metal" && family !== "unknown"
      ? `Method 2 is for standing-seam metal panels only (the roof is ${String(s.roofMaterial ?? "").trim() || family})`
      : "the standing-seam attachment does not meet Method 2";
    // The literal "attachment method compliance" is the key the App Docs mirror reads to stay silent
    // on this row (dashboard.js bcd5952ClauseNotes).
    out.push({ row: "attachments", clause: `attachment method compliance: No — Method 1: ${method1.join("; ") || "a Method 1 condition answers No"}; ${method2}` });
  }
  return out;
}

// ── FACTS NO DOCUMENT STATES BECOME OPERATOR QUESTIONS ──────────────────────────────────
// Operator rule (2026-09-26): a fact no document states (roof layer count, module height per the
// figures, the structure description, a city's zoning sign-off) is ASKED on the project through
// the existing intake / portal-question mechanism, stored on the project, and used by every form
// — never a silent blank and never a guess. The BCD 5952 questions only where that checklist
// applies; the zoning question whenever a COUNTY issues the permits for a CITY.
export interface FormFactQuestion { key: string; label: string; options: string[]; kind: "form-fact" }
export const STRUCTURE_DESCRIPTION_OPTIONS = [
  "Single-family dwelling", "Two-family dwelling (duplex)", "Townhouse", "Manufactured home", "Accessory building (garage/shed)",
];
export function formFactQuestions(
  project: ProjectRecord,
  opts: { checklistApplies: boolean; issuingAgency?: string | null },
): FormFactQuestion[] {
  const s = project.parserSnapshot ?? {};
  const has = (k: string) => String(s[k] ?? "").trim() !== "";
  const out: FormFactQuestion[] = [];
  // "No document states it" presupposes the documents were READ: a project whose plan set has not
  // been parsed (no roof, no framing) is not asked yet — the parse may still answer.
  const planRead = has("roofMaterial") || has("framingType");
  if (opts.checklistApplies && planRead) {
    const roof = String(s.roofMaterial ?? "").trim();
    const family = classifyRoofCovering(s.roofMaterial, s.roofMaterialSubtype).family;
    if ((family === "composition" || family === "wood") && !has("roofLayers")) {
      out.push({ key: "roofLayers", label: `How many layers of roofing are on the ${roof} roof?`, options: ["1", "2", "3 or more"], kind: "form-fact" });
    }
    // THE RAFTER EXCEPTION (dry-run 2026-09-28 B4): rafters at 24 in or less answer the framing row
    // only with R324.4.1 Exception 1.4-1.6, which no plan set states — the row sat blank and nothing
    // asked. Asked here, answered into rafterExceptionCompliant (bcdChecklistAnswers reads it).
    if (rafterExceptionAsked(project)) {
      out.push({ key: "rafterExceptionCompliant", label: `The plan set shows roof rafters at ${snapshotReaders(project).n("roofRafterSpacing")} in o.c. Does the rafter framing meet ORSC R324.4.1 Exception 1.4-1.6 (the BCD 5952 framing row)?`, options: ["Yes", "No"], kind: "form-fact" });
    }
    // The module-height row is assumed Yes when unknown (operator ruling 2026-09-27) — not asked.
    // An explicit answer stored under moduleHeightFiguresCompliant (from an earlier intake) still wins.
    if (!has("structureDescription")) {
      out.push({ key: "structureDescription", label: "What structure is the array installed on?", options: STRUCTURE_DESCRIPTION_OPTIONS, kind: "form-fact" });
    }
  }
  const agency = String(opts.issuingAgency ?? "").trim();
  if (/\bcounty\b/i.test(agency) && /^(city|town|village) of\b/i.test(String(project.ahj ?? "").trim()) && !has("zoningApproval")) {
    out.push({
      key: "zoningApproval",
      label: `${agency} issues the permits for ${project.ahj}. Did ${project.ahj} require a zoning sign-off for this job?`,
      options: ["Not required", "Required — approval attached", "Required — not yet obtained"],
      kind: "form-fact",
    });
  }
  return out;
}

// ── FORM FACTS ANOTHER RECORD ALREADY HOLDS ─────────────────────────────────────────────
/** A module's listing agency from its datasheet text ("UL 61730", "cULus", "ETL", "CSA C22.2",
 *  "TÜV"). "" when the text names none. */
export function listingAgencyFromText(text: string): { agency: string; quote: string } {
  const t = String(text ?? "");
  const hit = (re: RegExp) => {
    const m = re.exec(t);
    return m ? t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, " ").trim() : "";
  };
  let q = hit(/\bc?UL\s*(?:us\s*)?(?:61730|1703|Listed|Certified)\b|\bcULus\b|\bUL\s+E\d{5,6}\b/i);
  if (q) return { agency: "UL", quote: q };
  q = hit(/\bETL\b|\bIntertek\b/i);
  if (q) return { agency: "ETL (Intertek)", quote: q };
  q = hit(/\bCSA\s*(?:C22\.2|Group|certified|listed|\d{5,6})\b/i);
  if (q) return { agency: "CSA", quote: q };
  q = hit(/\bT[ÜU]V\b/i);
  if (q) return { agency: "TÜV", quote: q };
  return { agency: "", quote: "" };
}

/** Snapshot keys the BCD 5952 map reads that another record already answers (Oregon only — the
 *  form is Oregon's). The caller spreads the parsed snapshot OVER these, so a parsed or operator
 *  value always wins. BCD license # comes ONLY from the client record's electrical contractor
 *  licence (operator 2026-09-26: the Oregon BCD electrical contractor licence is that number). */
export function bcd5952SnapshotAdditions(
  project: ProjectRecord,
  client: Record<string, unknown>,
  documentTexts: { moduleSpec?: string } = {},
): Record<string, string> {
  if (String(project.state ?? "").trim().toUpperCase() !== "OR") return {};
  const out: Record<string, string> = {};
  const lic = String(client.electricalLicenseNumber ?? "").trim();
  if (lic) out.bcdLicenseNumber = lic;
  const listing = listingAgencyFromText(documentTexts.moduleSpec ?? "");
  if (listing.agency) out.moduleListingAgency = listing.agency;
  return out;
}
