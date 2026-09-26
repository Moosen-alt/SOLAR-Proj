import type { ParserLlmExtraction } from "../../shared/src/types";
import { classifyRoofCovering, tileAttachmentFromText, tileSubtype } from "./roofCovering";

/** Explicit plan facts only. This supplements the text intake, including sheets
 * beyond the model's text budget. It never turns a missing fact into compliance. */
export function supplementStructuralIntake(result: ParserLlmExtraction, planText: string): ParserLlmExtraction {
  const fields = { ...result.fields };
  const text = planText.replace(/\s+/g, " ");
  const add = (key: string, re: RegExp, value: (m: RegExpMatchArray) => string | number, explicitLabel = false) => {
    if (!explicitLabel && fields[key]?.value != null && fields[key]?.value !== "") return;
    const matches = [...text.matchAll(new RegExp(re.source, "gi"))];
    const values = [...new Set(matches.map(value))];
    if (values.length !== 1) return; // conflicting sheets require review
    const m = matches[0];
    fields[key] = { value: values[0], confidence: 0.95,
      evidence: { source: "plan_set", sheet: "Structural plan / notes", excerpt: m[0].slice(0, 200) } };
  };
  // A single explicit roof-material label outranks a model guess from metal
  // mounting hardware or generic installation notes elsewhere in the plans.
  add("constructionCategory", /(?:OCCUPANCY(?:\s*(?:TYPE|GROUP|CLASSIFICATION))?|BUILDING\s*(?:TYPE|USE))\s*[:=]\s*(R-?3\b|SINGLE[-\s]FAMILY(?:\s+DWELLING)?)/i,
    m => m[1].toUpperCase());
  add("buildingStories", /(?:NUMBER\s+OF\s+(?:STORIES|FLOORS)|TOTAL\s+(?:STORIES|FLOORS))\s*[:=]\s*(\d+)\b/i, m => Number(m[1]));
  add("parcelNumber", /(?:PARCEL\s*(?:NUMBER|NO\.?|#)|APN)\s*[:=]\s*([A-Z0-9]+(?:[-.]?[A-Z0-9]+)*)/i, m => m[1]);
  add("roofMaterial", /ROOF\s*MATERIAL\s*:\s*(COMPOSITE?\s+SHINGLES?|COMPOSITION\s+SHINGLES?|ASPHALT\s+SHINGLES?|STANDING\s+SEAM\s+METAL|METAL)/i,
    m => /compos|asphalt/i.test(m[1]) ? "Composition Shingle" : "Metal", true);
  // TILE IS NEVER SHINGLE. An explicit tile roof label ("ROOF MATERIAL: CONCRETE S-TILE",
  // "ROOF TYPE: CLAY TILE") outranks a model guess the same way — unless the set ALSO carries an
  // explicit composition/metal label, in which case the sheets conflict and the model's reading
  // stands for review. The subtype and the tile attachment method ride along (roofCovering.ts).
  const tileLabel = /ROOF(?:ING)?\s*(?:MATERIAL|TYPE|COVERING)\s*:\s*((?:CONCRETE|CLAY|TERRA[-\s]?COTTA)?\s*(?:S[-\s]?|FLAT\s+|BARREL\s+|SPANISH\s+|MISSION\s+|SHAKE\s+)?TILES?(?:\s+ROOF(?:ING)?)?)/i;
  const otherLabel = /ROOF\s*MATERIAL\s*:\s*(COMPOSITE?\s+SHINGLES?|COMPOSITION\s+SHINGLES?|ASPHALT\s+SHINGLES?|STANDING\s+SEAM\s+METAL|METAL)/i;
  const tileHit = tileLabel.exec(text);
  if (tileHit && !otherLabel.test(text)) {
    const words = tileHit[1].replace(/\s+ROOF(?:ING)?$/i, "").trim();
    const subtype = tileSubtype(words);
    const titled = words.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
    fields.roofMaterial = { value: titled, confidence: 0.95,
      evidence: { source: "plan_set", sheet: "Structural plan / notes", excerpt: tileHit[0].slice(0, 200) } };
    if (subtype) fields.roofMaterialSubtype = { value: subtype, confidence: 0.95, evidence: { source: "plan_set", sheet: "Structural plan / notes", excerpt: tileHit[0].slice(0, 200) } };
  }
  if (classifyRoofCovering(fields.roofMaterial?.value, fields.roofMaterialSubtype?.value).family === "tile" && !(fields.tileAttachmentMethod?.value)) {
    const methods = tileAttachmentFromText(text);
    // One method named -> that method. Two named (a hook detail AND a comp-out note) -> the
    // model's reading, or nothing: it is a question for the reviewer, not a pick.
    if (methods.length === 1) fields.tileAttachmentMethod = { value: methods[0].method, confidence: 0.9,
      evidence: { source: "plan_set", sheet: "Attachment detail", excerpt: methods[0].quote.slice(0, 200) } };
  }
  add("framingType", /\d+\s*"\s*[x×]\s*\d+\s*"\s*(TRUSS|RAFTER)\s*@\s*\d+/i, m => m[1].toLowerCase());
  add("roofRafterSpacing", /\d+\s*"\s*[x×]\s*\d+\s*"\s*(?:TRUSS|RAFTER)\s*@\s*(\d+)\s*"\s*O\.?\s*C/i, m => Number(m[1]));
  add("lightFrame", /\d+\s*"\s*[x×]\s*\d+\s*"\s*(?:TRUSS|RAFTER)\s*@\s*\d+/i, () => "yes");
  add("moduleHeightAboveRoof", /PANELS? WILL NOT MOUNT HIGHER\s*THAN\s*(\d+)\s*INCHES ABOVE THE SURFACE OF\s*THE ROOF/i, m => Number(m[1]));
  add("roofLayers", /(?:EXISTING\s+)?(?:ROOF(?:ING)?\s+LAYERS?\s*[:=]\s*)(\d+)/i, m => Number(m[1]));
  add("attachmentToFraming", /SOLAR PANELS ARE TO BE MOUNTED TO THE ROOF\s*FRAMING/i, () => "yes");
  add("attachmentSpacingIn", /(?:NEW\s+)?PV ATTACHMENTS AT\s*(\d+)'[-\s]*(\d+)"\s*O\.?C/i, m => Number(m[1]) * 12 + Number(m[2]));
  add("attachmentEdgeSpacingIn", /ROOF ATTACHMENTS SHALL BE SPACED NO\s*GREATER THAN\s*(\d+)\s*IN\.?\s*OC IN ANY DIRECTION\s*WHERE LOCATED WITHIN\s*3\s*FT\.?\s*OF A ROOF\s*EDGE, HIP, EAVE OR RIDGE/i, m => Number(m[1]));
  add("manufacturerInstallation", /RACKING SYSTEM\s*&\s*PV ARRAY WILL BE INSTALLED ACCORDING TO CODE[-\s]*COMPLIANT INSTALLATION MANUAL/i, () => "yes");
  return { ...result, fields };
}

/** Include later structural notes/datasheets instead of silently discarding
 * everything after the first 24k characters. Bound the request at 80k. */
export function planTextForExtraction(text: string): string {
  return text.length <= 80000 ? text : text.slice(0, 60000) + "\n[Middle text omitted]\n" + text.slice(-20000);
}
