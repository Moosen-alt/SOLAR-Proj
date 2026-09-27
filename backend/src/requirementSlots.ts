// ---------------------------------------------------------------------------
// WHICH DOCUMENT SLOT A REQUIREMENT'S PROSE NAMES — and which permit filing it belongs to.
//
// ONE vocabulary for "a line of a required-documents list -> the slot that would hold it": the
// job's own required list (requiredDocuments.requiredListCheck, docs.complete) maps each item with
// it, and the packet's issuing-agency list (applicationDocsAgency.agencyListReplacesLine) asks it
// which base lines an agency's own applications replace. A LEAF module (no imports) so both
// applicationDocs and requiredDocuments can read it without an import cycle (requiredDocuments
// imports applicationDocs). Moved here from requiredDocuments, which re-exports requirementSlots.
// ---------------------------------------------------------------------------

/** A requirement's prose -> the slot(s) that would hold it. Ordered specific-first; "" = none. */
const REQUIREMENT_SLOT_PATTERNS: Array<{ re: RegExp; docTypes: string[] }> = [
  { re: /electrical[\w\s/&()-]{0,40}application|renewable\s*energy[\w\s/&()-]{0,20}electrical|wires\s+(department\s+)?(permit\s+)?application/i, docTypes: ["electrical_application"] },
  { re: /(building|structural)\s*(permit\s*)?application|solar application|building permit application/i, docTypes: ["building_application", "permit_application"] },
  { re: /checklist|worksheet|eligibilit/i, docTypes: ["solar_checklist", "pv_worksheet"] },
  { re: /(permit|completed|signed)\s*application|application\s*(form|packet)|^application\b/i, docTypes: ["permit_application", "building_application"] },
  { re: /stamp|sealed|seal\b|engineer(ing|'s|ed)?\s+letter|structural\s+(letter|calc|analysis|certification|engineering)|pe\s+letter|letter\s+(stamped|from)\s+(by\s+)?an?\s+engineer/i, docTypes: ["structural_letter", "stamped_plans", "engineering_letter"] },
  { re: /site\s*plan|plot\s*plan|roof\s*plan|site\/roof|fire\s*(access\s*)?pathway\s*plan|roof\s*layout/i, docTypes: ["site_plan"] },
  { re: /single[-\s]?line|one[-\s]?line|three[-\s]?line|3[-\s]?line|\bsld\b|electrical\s+diagram|wiring\s+diagram/i, docTypes: ["sld"] },
  { re: /inverter\s*(spec|data|cut|sheet)|micro-?inverter\s*(spec|data|sheet)/i, docTypes: ["inverter_spec"] },
  { re: /module\s*(spec|data|cut|sheet)|panel\s*(spec|data|cut)\s*sheet|spec(ification)?\s*sheets?|data\s*sheets?|cut\s*sheets?|equipment\s+spec/i, docTypes: ["module_spec"] },
  { re: /label|placard/i, docTypes: ["labels"] },
  { re: /utility\s+bill|electric\s+bill|power\s+bill/i, docTypes: ["utility_bill"] },
  { re: /meter\s+photo|photo\s+of\s+(the\s+)?meter/i, docTypes: ["meter_photo"] },
  { re: /plan\s*set|construction\s+(documents|drawings|plans)|\bplans\b|drawings|full\s+set|set\s+of\s+plans|structural\s+plans/i, docTypes: ["plan_set", "combined_plan_set", "full_plan_set"] },
];

/** The slot(s) a requirement's prose would be held in — [] when this product holds no such slot. */
export function requirementSlots(text: string): string[] {
  const t = String(text || "").trim();
  if (!t) return [];
  const hit = REQUIREMENT_SLOT_PATTERNS.find((p) => p.re.test(t));
  return hit ? hit.docTypes : [];
}

export type RequirementTrack = "building" | "electrical" | "checklist";

/** A line that IS a permit's application, entered in the portal instead of attached ("Residential/
 *  Commercial Structural Solar PV portal entry", "PAC Portal Solar Array application fields"). */
const PORTAL_ENTRY_LINE = /portal\s+entry|application\s+fields|entered\s+in\s+the\s+portal/i;

/**
 * Which filing a requirement line belongs to: a permit TRACK's application (building / electrical),
 * the solar checklist / worksheet, or none (the plan set, specs, stamps, a fee receipt). Read off
 * requirementSlots; a portal-entry line is its track's application (electrical when it says so,
 * else the building-side one).
 */
export function requirementTrack(text: string): RequirementTrack | null {
  const slots = requirementSlots(text);
  if (slots.includes("electrical_application")) return "electrical";
  if (slots.includes("building_application") || slots.includes("permit_application")) return "building";
  if (slots.includes("solar_checklist")) return "checklist";
  if (PORTAL_ENTRY_LINE.test(String(text || ""))) return /electric|renewable\s*energy/i.test(String(text)) ? "electrical" : "building";
  return null;
}
