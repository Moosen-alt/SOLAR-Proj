/**
 * WHICH FILING A DOCUMENT BELONGS TO — the ONE docType → { lane, discipline } table
 * (docs-audit PLAN D3). "Which documents belong to track X?" had several answers: the staging
 * gate was track-scoped (stagingMissingDocuments), while the files handed to the run were not —
 * packagedDocumentsByType returned every document the project holds. Michael Sheridan's
 * ELECTRICAL run (53266857) was handed 16 keys, among them the BCD 5952 building checklist, the
 * utility bill and the meter photo (V6, V18). And the gate's own rows disagreed with each other:
 * the PE-letter row (`structural_letter`) carried no discipline, so it blocked the ELECTRICAL track
 * of an engineered job (b0ab5169, ec5c36d3) over a document only the building permit files (V9).
 *
 * Both readers now ask this table:
 *   - the payload: submissionDocumentsByType(db, project, track) — the one selection policy the
 *     staging run, the learn run and the correction/resubmit run all use;
 *   - the gate: stagingMissingDocuments reads a row's own discipline, else this table's.
 *
 * Vocabulary: `discipline` is recipeDisciplineForTrack's (portalChannel.ts) — "structural" for
 * the building track, "electrical" for electrical/mpu — so the two sides cannot disagree.
 *
 *   lane "shared" — the plan-set family: every track (AHJ and utility) gets it.
 *   lane "permit" — an AHJ document. discipline "" = every AHJ track; otherwise only the tracks
 *                   of that discipline (a combination permit, and the discipline-less "permit"
 *                   track, file both trades and take both).
 *   lane "nem"    — a utility document. The NEM track takes it; an AHJ track takes it ONLY when
 *                   that AHJ's own required list names it (operator decision OD-4 — the bill
 *                   carries the account number, CLAUDE.md hard rule 2 in spirit).
 *
 * An UNKNOWN docType ("other", "cad_source", anything an operator typed) is treated as shared —
 * today's behaviour. Such a file reaches a portal only through a slot whose label names its
 * docType, so dropping it silently would cost more than it protects; the table grows when a new
 * docType is born (D6's owner_authorization is here already, from the plan).
 */
import type { SubmittalTrackType } from "../../shared/src/types";
import { recipeDisciplineForTrack } from "./portalChannel";

export type DocLane = "shared" | "permit" | "nem";
export interface DocDiscipline {
  lane: DocLane;
  /** "" | "structural" | "electrical" — recipeDisciplineForTrack's vocabulary. */
  discipline: string;
}

const SHARED: DocDiscipline = { lane: "shared", discipline: "" };
const BUILDING: DocDiscipline = { lane: "permit", discipline: "structural" };
const ELECTRICAL: DocDiscipline = { lane: "permit", discipline: "electrical" };
const ANY_AHJ: DocDiscipline = { lane: "permit", discipline: "" };
const UTILITY: DocDiscipline = { lane: "nem", discipline: "" };

export const DOC_DISCIPLINE: Readonly<Record<string, DocDiscipline>> = {
  // THE PLAN-SET FAMILY — every discipline and the utility need it. Aliases included, because
  // projectDocsByType keeps an alias key beside the canonical one.
  plan_set: SHARED, combined_plan_set: SHARED, full_plan_set: SHARED, plan: SHARED, plan_pdf: SHARED,
  sld: SHARED, site_plan: SHARED, structural: SHARED, labels: SHARED,
  module_spec: SHARED, inverter_spec: SHARED, racking_spec: SHARED, battery_spec: SHARED,

  // THE BUILDING (STRUCTURAL) PERMIT's own documents.
  building_application: BUILDING,
  permit_application: BUILDING,
  solar_checklist: BUILDING,
  structural_letter: BUILDING, stamped_plans: BUILDING, engineering_letter: BUILDING,
  generated_structural_worksheet: BUILDING,
  generated_prescriptive_worksheet: BUILDING,
  generated_engineered_doc_collection: BUILDING,
  generated_path_chooser: BUILDING,
  // Plan D3: permit lane; its discipline comes from the required row that owes it (the gate reads
  // the row first), defaulting to structural here.
  owner_authorization: BUILDING,

  // THE ELECTRICAL PERMIT's own documents.
  electrical_application: ELECTRICAL,
  pv_worksheet: ELECTRICAL,
  generated_electrical_worksheet: ELECTRICAL,

  // The generated package's AHJ-wide sheets — any AHJ track, never the utility's.
  application_transfer_sheet: ANY_AHJ,
  portal_entry_worksheet: ANY_AHJ,
  application_cover: ANY_AHJ,
  application_manifest: ANY_AHJ,
  application_worksheet: ANY_AHJ,
  bid_sheet: ANY_AHJ,

  // THE UTILITY's documents.
  utility_application: UTILITY,
  utility_bill: UTILITY,
  meter_photo: UTILITY,
  utility_package_zip: UTILITY,
};

export function docDisciplineFor(docType: string): DocDiscipline {
  return DOC_DISCIPLINE[String(docType || "")] ?? SHARED;
}

/** The permit discipline a docType files under ("" = none: plan-set family, AHJ-wide, utility). */
export function disciplineFor(docType: string): string {
  return docDisciplineFor(docType).discipline;
}

/**
 * Does THIS track's filing carry this document? `track` null = every track (a legacy trackless
 * stage) — explicit, never an omitted argument. `ahjNamed` is the set of utility docTypes the
 * AHJ's own required list names (only read for an AHJ track).
 */
export function docFitsTrack(docType: string, track: SubmittalTrackType | null, ahjNamed: ReadonlySet<string>): boolean {
  if (track === null) return true;
  const { lane, discipline } = docDisciplineFor(docType);
  if (lane === "shared") return true;
  if (track === "nem") return lane === "nem";
  if (lane === "nem") return ahjNamed.has(docType);
  if (!discipline) return true;
  const trackDiscipline = recipeDisciplineForTrack(track);
  // "permit" (no discipline named) and "combo" (one filing, both trades) take every AHJ document.
  if (!trackDiscipline || trackDiscipline === "combo") return true;
  return discipline === trackDiscipline;
}
