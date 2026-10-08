// THE ONE MOUNT PREDICATE. codeReviewRules, the reviewer engine, the application forms, the recipe
// binding, permitPath's structural default and the required-document set all ask "is this array on a
// roof?" — and two of them used to answer with their own vocabulary (permitPath's regex never knew a
// bare "Ground" field or the design text; requiredDocuments never asked at all, so a ground array was
// told to attach roof framing, #247). It lives here, with no imports beyond the shared types, so
// permitPath can read it without a cycle (codeReviewRules imports permitPath). The two BLOCKING
// consumers (permitPath's ground default, requiredDocuments' ground rows) read the mounting field only
// — groundMountFromField, below; the text fallback serves the advisory reviewer rules.
import type { ProjectRecord } from "../../shared/src/types";

/** What the predicate reads: the parser snapshot, plus the project's interconnection method when the
 *  caller has the full record (permitPath's inputs do not). */
export type MountInputs = Pick<ProjectRecord, "parserSnapshot"> & Partial<Pick<ProjectRecord, "interconnectionMethod">>;

function str(project: MountInputs, key: string): string {
  const value = (project.parserSnapshot || {})[key];
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

export function designText(project: MountInputs): string {
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

export function mountKind(project: MountInputs, allText: string): MountKind {
  // The parser's own field is `mounting`; `mountType` is the older name a few fixtures and the
  // benchmark snapshots still carry (leak sweep 2026-09-28: the portal description read ONLY the
  // dead mountType key, so every job was "Roof-mounted"). Both answer here, mounting first.
  const mounting = str(project, "mounting") || str(project, "mountType");
  const probe = mounting || `${project.interconnectionMethod}\n${allText}`;
  if (/carport|canopy|awning|patio cover/i.test(probe)) return "carport";
  // The mounting FIELD answers through groundMountFromField, the same reading the blocking consumers
  // use (#269): it used to take any bare "ground" / "pole" in the field as a ground array, so "Roof mount
  // w/ ground lugs", "Pole barn roof" or "Roof mount - not a ground mount" dropped the advisory roof
  // rules while the required set kept the roof rows. A roof + ground combination stays "ground" here,
  // as it always has — the field cannot say which array a roof rule would be about.
  if (mounting) return groundMountFromField(project) ? "ground" : "roof";
  // Only the free text needs the longer phrase, where a bare "ground" is a grounding note.
  if (/ground[-\s]?mount|ground.?mounted|ground.?array|pole[-\s]?mount/i.test(probe)) return "ground";
  // Silence means roof, which is the conservative direction: the roof rules are the stricter
  // set, so an unknown mount is over-reviewed rather than under-reviewed.
  return "unknown";
}

// The one entry point other modules should use. It derives the design text itself, so a second
// caller cannot reach a different answer by feeding the predicate a different blob — which is
// precisely how the reviewer engine and this module came to disagree about the same array.
export function mountKindForProject(project: MountInputs): MountKind {
  return mountKind(project, designText(project));
}

// WHAT THE BLOCKING CONSUMERS READ (#247 review): the mounting FIELD, and only the field. The text
// fallback above is fine for advisory reviewer rules, but plan prose names ground-mounted EQUIPMENT on
// rooftop jobs ("(N) GROUND-MOUNTED AC DISCONNECT", "UTILITY POLE MOUNTED TRANSFORMER", "UNDERGROUND
// ARRAY FEEDER") and the parser's own review flag reads "confirm roof mount vs ground mount" exactly
// when the field is empty — so a text vote here dropped a rooftop's roof-framing row and flipped it to
// engineered. A rooftop or unknown-mount job therefore never reaches the ground rows or path.
//   "ground"      — a pure ground / pole array: its rows replace roof framing.
//   "combination" — roof AND ground arrays: roof framing stays, the ground rows are added.
//   null          — roof, carport, unknown, or anything else.
// "ground" counts only as a MOUNT NOUN ("ground mount", "ground-mounted", "ground array", "ground
// rack") or as a whole segment once the value is split on , ; + & / and "and" ("Ground", "Roof and
// Ground") — never "ground lugs", "ground-level inverter", "ground floor garage", "ground fault" or
// "non-ground". "pole" likewise: "pole mount", "top of pole", or a whole segment — "Pole barn roof"
// is a roof. "... not a ground mount" and "non-ground-mount" are not a ground vote (#269).
// GROUND-MOUNTED EQUIPMENT IS NOT AN ARRAY (#269): "Roof mount with ground-mounted inverter" names
// where the inverter / disconnect / meter / battery stands, not a second array — a ground or pole
// mount phrase whose noun (within two words) is equipment is cut out before the field is read. A
// word that joins an ARRAY to its equipment ("Ground mount w/ battery", "on concrete pedestals",
// "Pole mount with disconnect"; a preposition, conjunction, number or array noun) ends the phrase,
// so a real ground array is never cut (#272 review).
// A SEGMENT THAT STARTS WITH A BARE "ground" / "pole" is a ground vote too, whatever qualifies it
// ("Ground (ballasted)", "Ground - fixed tilt", "Ground based", "Ground mtd", "On ground") — unless the
// next word makes it a non-mount noun or equipment ("ground lugs", "ground floor", "Pole barn roof",
// "ground inverter"), which the advisory rules used to accept and the blocking ones never did.
export type MountFieldGround = "ground" | "combination";
const NEGATED_MOUNT = /\b(?:(?:not|no)\s+(?:an?\s+)?|non[-\s]?)(?:ground|pole)[-\s]?(?:mount\w*|array)/gi;
const EQUIPMENT = "inverters?|disconnects?|meters?|batter(?:y|ies)|ess|transformers?|pedestals?";
const MOUNTED_EQUIPMENT = new RegExp(String.raw`\b(?:ground|pole)[-\s]?mount\w*\s+(?:(?!(?:with|w\/|w|and|plus|on|in|at|from|for|arrays?|rack\w*|systems?|pv|solar|panels?|modules?|carport|canopy|\d[\w.]*)\s)[\w/]+\s+){0,2}?(?:${EQUIPMENT})\b`, "gi");
const GROUND_MOUNT_NOUN = /\bground[-\s]?(?:mount\w*|arrays?|rack\w*)|\bpole[-\s]?mount\w*|\btop[-\s]?of[-\s]?pole\b/i;
const GROUND_SEGMENT = new RegExp(String.raw`^(?:on\s+(?:the\s+)?)?(?:ground|poles?)\b(?![-\s(]*(?:lugs?|fault|floor|level|rods?|wires?|bars?|barn|building|shed|electrodes?|conductors?|bond\w*|snow|clearance|cover|${EQUIPMENT})\b)`, "i");
const mountSegments = (m: string) => m.split(/\s*(?:[,;+&/]|\band\b)\s*/i).map((x) => x.trim().toLowerCase());
const fieldOf = (project: MountInputs) => (str(project, "mounting") || str(project, "mountType")).replace(NEGATED_MOUNT, " ").replace(MOUNTED_EQUIPMENT, " ");
export function groundMountFromField(project: MountInputs): MountFieldGround | null {
  const m = fieldOf(project);
  if (!m.trim() || /carport|canopy|awning|patio cover/i.test(m)) return null;
  const ground = GROUND_MOUNT_NOUN.test(m) || mountSegments(m).some((x) => GROUND_SEGMENT.test(x));
  if (!ground) return null;
  return mountSegments(m).some((x) => /\broof/.test(x)) ? "combination" : "ground";
}

/** permitPath's ground default (#247 review): a ground array, a combination — or a carport / canopy the
 *  field still calls ground- or pole-MOUNTED ("Ground-mounted carport", "Pole-mounted canopy"), which
 *  main has always routed engineered. requiredDocuments keeps treating those as carports. */
export function engineeredGroundMount(project: MountInputs): boolean {
  return groundMountFromField(project) != null || GROUND_MOUNT_NOUN.test(fieldOf(project));
}

/** A PURE ground or pole array, by the mounting field (see groundMountFromField). */
export function isGroundMount(project: MountInputs): boolean {
  return groundMountFromField(project) === "ground";
}
