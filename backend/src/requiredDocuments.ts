// ---------------------------------------------------------------------------
// Required-document inventory — the gate that prevents "documents still missing"
// rejections.
//
// The old submit gate was DOCUMENT-BLIND: it checked that scalar project fields
// were non-empty and that the parser's TEXT mentioned the right keywords, but it
// never verified the actual files were attached. A plan set that was parsed at
// intake but never attached to the submittal would pass. A real AHJ (Marion
// County / Keizer on Oregon ePermitting) bounced exactly that.
//
// This module resolves the concrete set of documents a clean residential rooftop
// solar submittal must carry — path-driven (prescriptive vs engineered) and
// lane-aware (AHJ permit vs utility NEM) — and checks each against the actual
// uploaded/split file inventory (project_documents), with the parsed plan-set
// sheet map as a secondary signal for sheets that legitimately live INSIDE the
// combined plan-set PDF. Missing blocking documents become hard submit blockers.
//
// Authoritative basis (verified against state sources):
//   - Oregon requires a SEPARATE structural permit AND electrical permit for solar
//     (OAR 918-050-0180; Oregon BCD form 440-5952 header).
//   - Prescriptive path → prescriptive checklist (440-5952) + site plan with fire
//     access/escape pathways (R324.6). Non-prescriptive → PE-stamped structural
//     plans + sealed structural letter/calcs, plan review, full fees.
//   - Plan set must show: site/plot plan w/ dimensioned fire pathways, electrical
//     SLD/one-line w/ rapid shutdown + NEC 705.12 busbar result, structural roof
//     framing + attachment detail, module spec, inverter spec, label/placard set.
//   - PGE NEM requires inverter cut-sheets (UL 1741), one-line, and site plan.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { projectDocsByType } from "./projectDocuments";
import { resolvePermitPath, resolveStampRequirement, hasStampedStructuralEvidence } from "./permitPath";
import { resolveEffectiveCodeContext } from "./codeProfiles";
import { findAhjProcessProfile } from "./processProfiles";

export interface RequiredDocItem {
  /** project_documents.doc_type this maps to (or a synthetic key for path docs). */
  docType: string;
  label: string;
  /** Why a clean submittal needs it (shown to the operator). */
  why: string;
  /** "permit" (AHJ) or "nem" (utility) lane. */
  lane: "permit" | "nem";
  /** Missing a blocking doc stops submit; advisory docs only warn. */
  blocking: boolean;
}

export interface DocPresence extends RequiredDocItem {
  present: boolean;
  /** How presence was established: "attached file" | "in plan set" | "". */
  via: string;
}

export interface DocumentInventory {
  required: RequiredDocItem[];
  presence: DocPresence[];
  missingBlocking: DocPresence[];
  missingAdvisory: DocPresence[];
}

function snap(project: ProjectRecord, key: string): string {
  const v = (project.parserSnapshot || {})[key];
  return v == null ? "" : String(v);
}

// Plan-set sheet labels we look for in the parser's readiness / split text, used as a
// secondary signal that a sheet is present INSIDE the combined plan-set PDF (the plan
// set file itself must still physically exist — we never count prose alone).
const PLAN_SHEET_HINTS: Record<string, RegExp> = {
  sld: /\b(sld|one-?line|single-?line|3-?line|three-?line)\b/i,
  site_plan: /\b(site\s*plan|plot\s*plan|site\/?roof)\b/i,
  structural: /\b(structural|roof\s*fram|rafter|truss|attachment\s*detail|mount\s*detail)\b/i,
  module_spec: /\bmodule\s*spec/i,
  inverter_spec: /\b(inverter|microinverter)\s*spec|\bUL[\s-]*1741\b/i,
  labels: /\b(label|placard)/i,
};

function planSetPresent(docsByType: Record<string, string>): boolean {
  return Boolean(docsByType.plan_set || docsByType.plan || docsByType.plan_pdf);
}

// Is a sheet identified inside the uploaded plan set? Requires the plan-set FILE to
// exist AND the parse of that real file to map the sheet (READY in packetReadiness or a
// page range in the split map) — not a bare keyword anywhere in free text.
function sheetInPlanSet(project: ProjectRecord, docType: string, docsByType: Record<string, string>): boolean {
  if (!planSetPresent(docsByType)) return false;
  const hint = PLAN_SHEET_HINTS[docType];
  if (!hint) return false;
  const readiness = snap(project, "packetReadinessText");
  const split = snap(project, "splitPagesText");
  // packetReadiness lines look like "READY - SLD" / "MISSING - Module spec".
  const readyLine = readiness
    .split(/\n+/)
    .some((line) => hint.test(line) && /\bREADY\b/i.test(line) && !/\bMISSING\b/i.test(line));
  // split map lines look like "02 SLD 3-Line ...: page 3".
  const splitLine = split.split(/\n+/).some((line) => hint.test(line) && /\bpages?\b/i.test(line));
  return readyLine || splitLine;
}

function present(docType: string, project: ProjectRecord, docsByType: Record<string, string>): { present: boolean; via: string } {
  if (docsByType[docType]) return { present: true, via: "attached file" };
  // The engineered PE stamp + structural letter usually live ON the structural sheets
  // inside the uploaded plan set. Count it present when a stamped-structural file exists
  // OR the parse of the real uploaded plan set shows a current stamp/seal/letter.
  if (docType === "structural_letter") {
    if (docsByType.stamped_plans || docsByType.engineering_letter) return { present: true, via: "attached file" };
    if (planSetPresent(docsByType) && hasStampedStructuralEvidence(project)) return { present: true, via: "stamp in plan set" };
    return { present: false, via: "" };
  }
  if (PLAN_SHEET_HINTS[docType] && sheetInPlanSet(project, docType, docsByType)) {
    return { present: true, via: "in plan set" };
  }
  return { present: false, via: "" };
}

/**
 * The documents a clean submittal for THIS project must carry, resolved from the
 * permit path (prescriptive vs engineered) and whether the project has a utility/NEM
 * filing. Doc types align with docSplitter / project_documents so presence can be
 * verified against real files.
 */
export function requiredDocuments(
  project: ProjectRecord,
  opts: { stampThresholdKwDc?: number | null; jurisdictionLabel?: string; processProfileRequiresStamp?: boolean } = {},
): RequiredDocItem[] {
  const path = resolvePermitPath(project).path;
  const hasUtility = Boolean((project.utility || "").trim());
  const items: RequiredDocItem[] = [
    { docType: "plan_set", label: "Plan set (stamped/complete PDF)", why: "The full plan set is the core of every AHJ + NEM submittal.", lane: "permit", blocking: true },
    { docType: "site_plan", label: "Site / plot plan with fire access + escape pathways", why: "AHJ requires the array location and dimensioned firefighter pathways/setbacks (R324.6).", lane: "permit", blocking: true },
    { docType: "sld", label: "Electrical one-line / SLD (rapid shutdown + NEC 705.12)", why: "Required for both the electrical permit and the utility NEM application.", lane: "permit", blocking: true },
    { docType: "structural", label: "Structural roof framing + attachment detail", why: "Required for the structural permit (framing, spacing, attachment).", lane: "permit", blocking: true },
    { docType: "module_spec", label: "PV module spec sheet", why: "AHJ + utility require the module cut sheet (listing/ratings).", lane: "permit", blocking: true },
    { docType: "inverter_spec", label: "Inverter / microinverter spec sheet (UL 1741)", why: "Required by the AHJ and by PGE NEM (UL 1741-SB listing).", lane: "nem", blocking: true },
    { docType: "labels", label: "Label / placard schedule", why: "Placard/label schedule (705.10 directory, RSD, disconnects) — usually a plan-set sheet.", lane: "permit", blocking: false },
  ];

  // CONDITIONAL — the sealed structural letter ("SS stamp"). One authority decides
  // (resolveStampRequirement in permitPath.ts): the engineered path or the
  // jurisdiction's own threshold is a hard requirement; a learned process-profile
  // flag is hearsay and surfaces as an advisory the operator confirms rather than
  // a block. A prescriptive project in a jurisdiction with no rule is never nagged.
  const stamp = resolveStampRequirement(project, {
    stampThresholdKwDc: opts.stampThresholdKwDc,
    jurisdictionLabel: opts.jurisdictionLabel,
    processProfileRequiresStamp: opts.processProfileRequiresStamp,
  });
  if (stamp.required) {
    items.push({
      docType: "structural_letter",
      label: "PE-stamped structural plans + sealed structural letter/calcs",
      why: stamp.reason,
      lane: "permit",
      blocking: !stamp.waivable,
    });
  }

  // If there is no utility, the NEM-only doc (inverter spec is dual-purpose) stays
  // permit-side; drop the pure-NEM framing. inverter_spec is required either way, so
  // re-lane it to permit when there's no utility so it still blocks.
  if (!hasUtility) {
    for (const it of items) if (it.docType === "inverter_spec") it.lane = "permit";
  }
  return items;
}

/** Resolve the required docs against the actual uploaded/split file inventory. */
export function documentInventory(db: AppDb, project: ProjectRecord): DocumentInventory {
  const docsByType = projectDocsByType(db, project.id);
  // Per-jurisdiction stamp threshold, so "does this project need a sealed
  // structural letter?" is answered by the AHJ's own adopted rules rather than a
  // single global assumption. Never fatal — an unknown jurisdiction simply falls
  // back to the permit-path trigger.
  let stampThresholdKwDc: number | null = null;
  let jurisdictionLabel = "";
  try {
    const ctx = resolveEffectiveCodeContext(db, project.state || "", project.ahj || "");
    const t = ctx.prescriptive?.engineerStampOverKwDc;
    if (typeof t === "number" && Number.isFinite(t)) stampThresholdKwDc = t;
    jurisdictionLabel = ctx.ahj || ctx.state || "";
  } catch { /* profile data optional */ }
  // The learned AHJ process profile can also flag a stamp (hearsay → advisory).
  let processProfileRequiresStamp = false;
  try {
    processProfileRequiresStamp = Boolean(findAhjProcessProfile(project)?.requiresStructuralStamp);
  } catch { /* profile optional */ }
  const required = requiredDocuments(project, { stampThresholdKwDc, jurisdictionLabel, processProfileRequiresStamp });
  const presence: DocPresence[] = required.map((item) => {
    const p = present(item.docType, project, docsByType);
    return { ...item, present: p.present, via: p.via };
  });
  return {
    required,
    presence,
    missingBlocking: presence.filter((p) => !p.present && p.blocking),
    missingAdvisory: presence.filter((p) => !p.present && !p.blocking),
  };
}
