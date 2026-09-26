import type { ProjectRecord } from "../../shared/src/types";
import { classifyRoofCovering, oregonRoofingRowQualifies } from "./roofCovering";
type Answer = "Yes" | "No" | "";
type Fact = boolean | null;
const all = (...v: Fact[]): Fact => v.includes(false) ? false : v.includes(null) ? null : true;
const any = (...v: Fact[]): Fact => v.includes(true) ? true : v.includes(null) ? null : false;

/** BCD 5952 compound statements. A numeric fact alone does not establish a
 * separate code-compliance clause. Unknown remains blank, never a false No. */
export function bcdChecklistAnswers(project: ProjectRecord): Record<string, Answer> {
  const s = project.parserSnapshot ?? {};
  const str = (k: string) => String(s[k] ?? "").trim().toLowerCase();
  const flag = (k: string): Fact => /^(yes|true)$/.test(str(k)) ? true : /^(no|false)$/.test(str(k)) ? false : null;
  const n = (k: string) => { const m = str(k).match(/^\s*(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
  const max = (k: string, limit: number): Fact => n(k) == null ? null : n(k)! <= limit;
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
  const method2 = flag("standingSeamMethod2Compliant");
  // The height row is ONE compound statement ("no more than 18 inches … per the figures"). The
  // operator's single answer to that statement (moduleHeightFiguresCompliant — an intake
  // question) settles it; otherwise both stated facts must.
  const heightAnswer = flag("moduleHeightFiguresCompliant");
  const facts: Record<string, Fact> = {
    designInstallation: all(flag("gravityWindDesign"), flag("manufacturerInstallation")),
    framing: any(truss, rafter), truss, rafter, roofing,
    heightFigures: heightAnswer !== null ? heightAnswer : all(max("moduleHeightAboveRoof", 18), flag("moduleFiguresCompliant")),
    attachments: any(method1, method2), method1, method2,
  };
  return Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v === true ? "Yes" : v === false ? "No" : ""]));
}

// ── WHAT IS STILL MISSING, NAMED EXACTLY ────────────────────────────────────────────────
// The fill note said "Still needs evidence: roof material and layer count" on a project whose
// roof material WAS parsed ("Composition Shingle"); the operator read the blank row beside the
// form's own metal/standing-seam wording as "it's filling in metal roofing". Name the one fact
// that is missing, and where it will come from.
export function bcd5952MissingFacts(project: ProjectRecord): Array<{ row: string; missing: string }> {
  const s = project.parserSnapshot ?? {};
  const has = (k: string) => String(s[k] ?? "").trim() !== "";
  const a = bcdChecklistAnswers(project);
  const out: Array<{ row: string; missing: string }> = [];
  if (!a.designInstallation) out.push({ row: "designInstallation", missing: "gravity/wind design and manufacturer-instructions statements" });
  if (!a.framing) out.push({ row: "framing", missing: has("framingType") ? "framing spacing / rafter exception" : "framing type (truss or rafter) and spacing" });
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
    if (!has("moduleHeightFiguresCompliant") && !(has("moduleHeightAboveRoof") && has("moduleFiguresCompliant"))) {
      out.push({ key: "moduleHeightFiguresCompliant", label: "Are the modules 18 inches or less above the roof surface, installed per the BCD 5952 figures?", options: ["Yes", "No"], kind: "form-fact" });
    }
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
