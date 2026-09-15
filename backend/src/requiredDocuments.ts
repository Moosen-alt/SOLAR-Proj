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
import { filledFormsByDocType } from "./ahjForms";
import { resolvePermitPath, resolveStampRequirement, hasStampedStructuralEvidence } from "./permitPath";
import { resolveEffectiveCodeContext } from "./codeProfiles";
import { findAhjProcessProfile } from "./processProfiles";
import { findKnowledgeForLearn } from "./knowledgeBase";
import { findApplicationProfile, namedApplicationForm, permitStructureForProject } from "./applicationDocs";

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
  /**
   * The permit DISCIPLINE this document files under, in the SAME vocabulary
   * recipeDisciplineForTrack (portalChannel.ts) already defines for submittal
   * tracks and migration v22 for fee rows: "structural" | "electrical" |
   * "combo" | "". Deliberately not a parallel "building" word — the track
   * `building` maps to discipline `structural`, and the doc side must agree or
   * a staging filter keyed on one will silently miss the other.
   * Absent/"" on the universal plan-set family, which every discipline needs.
   */
  discipline?: string;
  /**
   * Other docTypes that satisfy this row. Needed because classifyFormType
   * (ahjFormAuto.ts) falls through to the generic `permit_application` for a
   * blank whose name carries neither "building" nor "structural" — Coos Bay's
   * "Prescriptive Solar Photovoltaic Installation Permit Application" is exactly
   * that. Without the alias the inventory demands a document that is sitting on
   * disk under another key: the one-letter-apart bug, rebuilt.
   */
  altDocTypes?: string[];
  /**
   * Which of the two MUTUALLY EXCLUSIVE building-side applications this row is,
   * in the vocabulary formAllowedForPath (ahjForms.ts) enforces at fill time.
   * Only ever set on the ONE building-side row — the AHJ takes exactly one
   * ("upload only the application that pertains — DO NOT upload both").
   */
  applicationKind?: "prescriptive" | "structural";
}

/** An application/checklist row, which always names its discipline. */
export interface RequiredApplicationDoc extends RequiredDocItem {
  discipline: string;
}

/**
 * The AHJ-dependent inputs the application set needs, resolved by the caller.
 *
 * requiredDocuments() is called DB-free with bare projects that carry no
 * ahj/state/city (backend/test/conditionalStampDocs.test.ts), and
 * permitStructureForProject -> findApplicationProfile does
 * `project.state.trim().toUpperCase()`, which throws on those. So the lookups
 * live in applicationDocContext() — guarded, called from documentInventory and
 * from form acquisition — and are THREADED IN, exactly the way
 * stampThresholdKwDc / processProfileRequiresStamp already are. The pure
 * function stays pure.
 */
export interface ApplicationDocContext {
  permitStructure?: "separate" | "combo" | "unknown";
  processFlags?: {
    requiresBuildingPermitApplication?: boolean;
    requiresElectricalPermitApplication?: boolean;
    requiresSolarChecklist?: boolean;
  };
  /** The AHJ's own name for the path-chosen building-side application. */
  buildingApplicationName?: string;
  /** How to refer to this jurisdiction in `why`. */
  ahjLabel?: string;
}

/** The application-family docTypes — the only keys a filled AHJ form may claim.
 *  Agrees with classifyFormType, filledFormsByDocType and UPLOAD_LABEL_PATTERNS
 *  (pinned in backend/test/filledFormUpload.test.ts). */
export const APPLICATION_DOC_TYPES = new Set([
  "permit_application",
  "building_application",
  "electrical_application",
  "solar_checklist",
]);

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

function present(
  item: RequiredDocItem,
  project: ProjectRecord,
  docsByType: Record<string, string>,
  uploads: Record<string, string> = docsByType,
  filledApplications: Record<string, string> = {},
): { present: boolean; via: string } {
  const docType = item.docType;
  // A row is satisfied by its own docType OR by any alias it accepts, and by an
  // UPLOAD or by a FILLED form. Uploads are checked first at each key so an
  // operator's own version wins, mirroring prepareSubmission's merge order.
  for (const key of [docType, ...(item.altDocTypes || [])]) {
    const under = key === docType ? "" : ` (stored as ${key.replace(/_/g, " ")})`;
    if (uploads[key]) return { present: true, via: `attached file${under}` };
    if (filledApplications[key]) return { present: true, via: `filled form${under}` };
  }
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
  opts: {
    stampThresholdKwDc?: number | null;
    jurisdictionLabel?: string;
    processProfileRequiresStamp?: boolean;
    /** Resolved by the caller (documentInventory / form acquisition), which has
     *  the DB and does the guarded profile lookups. Omitted → no permit
     *  APPLICATION is demanded at all, which is what keeps this function safe to
     *  call with a bare project that has no ahj/state. */
    application?: ApplicationDocContext;
  } = {},
): RequiredDocItem[] {
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

  // THE PERMIT APPLICATIONS THEMSELVES. The baseline above is the plan-set
  // family; until now nothing in this list was an APPLICATION, so a jurisdiction
  // that files a building AND an electrical permit could pass every check with
  // one of the two never acquired, never filled and never attached.
  items.push(...requiredApplicationDocs(project, opts.application ?? {}));
  return items;
}

/**
 * The permit APPLICATIONS this project must file, computed through BOTH axes at
 * once — because they are orthogonal and conflating them is the bug:
 *
 *   AXIS 1 — PERMIT STRUCTURE (permitStructureForProject): combo = one permit;
 *     separate = a building (BLD) permit AND an electrical (ELE) permit, two
 *     filings. This is the same signal that already splits requiredTracks() and
 *     prints "Separate building (BLD) + electrical (ELE) permits — both must be
 *     filed" on the operator's screen.
 *   AXIS 2 — PERMIT PATH (resolvePermitPath): prescriptive XOR engineered. This
 *     chooses WHICH building-side application, and the AHJ takes exactly one
 *     ("upload only the application that pertains — DO NOT upload both").
 *
 * So a prescriptive project at a separate-permit AHJ needs the PRESCRIPTIVE
 * application plus the ELECTRICAL application — never the structural one. The
 * electrical application does not depend on the path at all; that independence
 * is the whole point.
 *
 * BLOCKING SOURCE RULE (the safety boundary): a flag-derived row blocks ONLY
 * when the structure resolves to "separate" — the signal already visible to the
 * operator as two submittal tracks. "combo"/"unknown" stay advisory, and the
 * KB-prose rows (kbApplicationDocItems) stay advisory as they always were.
 * These are 380+ seeded, spreadsheet-imported flags; a wrong one must not be
 * able to stop a filing on its own.
 */
export function requiredApplicationDocs(
  project: ProjectRecord,
  ctx: ApplicationDocContext = {},
): RequiredApplicationDoc[] {
  const structure = ctx.permitStructure ?? "unknown";
  const flags = ctx.processFlags ?? {};
  const separate = structure === "separate";
  const combo = structure === "combo";
  const wantsBuilding = separate || combo || Boolean(flags.requiresBuildingPermitApplication);
  const wantsElectrical = separate || Boolean(flags.requiresElectricalPermitApplication);
  const wantsChecklist = Boolean(flags.requiresSolarChecklist);
  // NO SIGNAL, NO DEMAND. A project with no resolved structure and no process
  // flags (an AHJ we have no knowledge of, or a bare project in a unit test)
  // must not be told to attach applications nobody can name.
  if (!wantsBuilding && !wantsElectrical && !wantsChecklist) return [];

  const path = resolvePermitPath(project).path;
  const where = (ctx.ahjLabel || project.ahj || "").trim() || "This AHJ";
  const named = (ctx.buildingApplicationName || "").trim();
  const permitWord = combo ? "combined building + electrical permit" : "building permit";
  const out: RequiredApplicationDoc[] = [];

  if (wantsBuilding) {
    // ONE building-side row, chosen BY PATH — never both. A required set that
    // tells a prescriptive project to attach the structural application is
    // wrong in the same way filing both is wrong.
    const kind = path === "engineered" ? "structural" : path === "prescriptive" ? "prescriptive" : "";
    const label =
      kind === "structural" ? "Structural (non-prescriptive) permit application, filled"
      : kind === "prescriptive" ? "Prescriptive solar permit application, filled"
      : "Building-side permit application (prescriptive or structural), filled";
    const why =
      kind === "structural"
        ? `${where} files a ${permitWord}, and this project resolved to the ENGINEERED (non-prescriptive) path — file ${named || "the AHJ's structural (standard building) permit application"}. The prescriptive one must NOT also go up; the AHJ takes exactly one.`
        : kind === "prescriptive"
          ? `${where} files a ${permitWord}, and this project resolved to the PRESCRIPTIVE path — file ${named || "the AHJ's prescriptive solar application"}. The structural one must NOT also go up; the AHJ takes exactly one.`
          : `${where} files a ${permitWord}, but the permit path is not confirmed. The prescriptive and structural applications are mutually exclusive — set the path (Manual entry → Permit path) so the right one is built.`;
    out.push({
      docType: "building_application",
      // A blank whose name says neither "building" nor "structural" is stored
      // under the generic key by classifyFormType; accept it here so the row is
      // not demanding a file that already exists under another name.
      altDocTypes: ["permit_application"],
      label,
      why,
      lane: "permit",
      // An unconfirmed path is ALREADY a hard block at repository.ts (staging
      // refuses until the operator picks). Blocking here too would only replace
      // a precise message with a vaguer one.
      blocking: separate && path !== "unknown",
      discipline: combo ? "combo" : "structural",
      ...(kind ? { applicationKind: kind } : {}),
    });
  }

  if (wantsElectrical) {
    const statute = (project.state || "").trim().toUpperCase() === "OR" ? " (Oregon: OAR 918-050-0180.)" : "";
    out.push({
      docType: "electrical_application",
      // DELIBERATELY NO `permit_application` ALIAS. One generic blank must never
      // be able to satisfy both the building-side row and this one — that is the
      // exact shape of the failure this set exists to catch.
      label: "Electrical (renewable-energy) permit application, filled",
      why: separate
        ? `${where} files SEPARATE building and electrical permits, so the renewable-energy electrical application is required in addition to the building-side one — on either permit path, on every interconnection.${statute}`
        : `${where}'s process profile records that an electrical permit application is required. Confirm it before filing.`,
      lane: "permit",
      blocking: separate,
      discipline: "electrical",
    });
  }

  if (wantsChecklist) {
    out.push({
      docType: "solar_checklist",
      label: "Solar prescriptive checklist, filled",
      // Advisory: a checklist flag is not evidence of a second permit, so it is
      // not covered by the blocking-source rule above.
      why: `${where}'s process profile records a solar checklist / worksheet requirement alongside the application.`,
      lane: "permit",
      blocking: false,
      discipline: combo ? "combo" : "structural",
    });
  }

  return out;
}

/**
 * Resolve the AHJ-dependent inputs requiredApplicationDocs needs. Every lookup is
 * guarded: an incomplete project (no state/ahj/city, as qc.ts builds) yields a
 * thinner context, never a throw.
 */
export function applicationDocContext(project: ProjectRecord): ApplicationDocContext {
  const ctx: ApplicationDocContext = {};
  const ahj = (project.ahj || "").trim();
  if (ahj) ctx.ahjLabel = ahj;
  try {
    ctx.permitStructure = permitStructureForProject(project);
  } catch { /* profile data optional — an unresolved structure demands nothing as blocking */ }
  try {
    const proc = findAhjProcessProfile(project);
    if (proc) {
      ctx.processFlags = {
        requiresBuildingPermitApplication: Boolean(proc.requiresBuildingPermitApplication),
        requiresElectricalPermitApplication: Boolean(proc.requiresElectricalPermitApplication),
        requiresSolarChecklist: Boolean(proc.requiresSolarChecklist),
      };
    }
  } catch { /* process profile optional */ }
  try {
    ctx.buildingApplicationName = namedApplicationForm(findApplicationProfile(project), resolvePermitPath(project).path);
  } catch { /* the AHJ's own name for the form is a nicety, not a requirement */ }
  return ctx;
}

/** Resolve the required docs against the actual uploaded/split file inventory. */
export function documentInventory(db: AppDb, project: ProjectRecord): DocumentInventory {
  const uploads = projectDocsByType(db, project.id);
  // A FILLED APPLICATION IS A DOCUMENT. Filled AHJ forms are written to
  // backend/data/filled/<projectId>/ and have NO project_documents row, so
  // projectDocsByType cannot see them — which is why prepareSubmission already
  // merges filledFormsByDocType before packaging (repository.ts). The inventory
  // read only the uploads, so it would have called a built-and-filled
  // application "missing" forever. Same merge, same precedence: an operator who
  // uploaded their own version meant to use it.
  //
  // Narrowed to the APPLICATION family on purpose: nothing here may touch the
  // plan-set presence logic, and a stray template form_type must not be able to.
  const filledApplications: Record<string, string> = {};
  try {
    for (const [type, file] of Object.entries(filledFormsByDocType(db, project.id))) {
      if (APPLICATION_DOC_TYPES.has(type)) filledApplications[type] = file;
    }
  } catch { /* no filled dir yet — simply nothing built */ }
  const docsByType = { ...filledApplications, ...uploads };
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
  // What THIS jurisdiction asks for beyond the universal set — the filled application
  // and/or checklist some AHJs want attached alongside the plan set. Learned data, so
  // advisory and never fatal to the inventory.
  let kbItems: RequiredDocItem[] = [];
  // Structure + process flags + the AHJ's own name for the path-chosen
  // application. Resolved HERE, where the guarded lookups belong, and threaded
  // into the pure function.
  const application = applicationDocContext(project);
  const docOpts = { stampThresholdKwDc, jurisdictionLabel, processProfileRequiresStamp, application };
  const baselineItems = requiredDocuments(project, docOpts);
  try {
    const kb = findKnowledgeForLearn(db, { state: project.state, ahj: project.ahj, utility: project.utility });
    const reqs = kb.ahj?.requiredDocuments ?? [];
    if (reqs.length) {
      const baseline = new Set(baselineItems.flatMap((i) => [i.docType, ...(i.altDocTypes || [])]));
      kbItems = kbApplicationDocItems(reqs, baseline);
    }
  } catch { /* KB optional */ }
  const required = [...baselineItems, ...kbItems];
  const presence: DocPresence[] = required.map((item) => {
    const p = present(item, project, docsByType, uploads, filledApplications);
    // HONESTY CHECK on the sealed letter: presence only proves a FILE is in the
    // slot — a placeholder PDF satisfies the gate identically (live-tested with a
    // file literally named "FAKE STAMPS.pdf"). We can't verify a real PE seal
    // automatically, but when the attached letter HAS a text layer and that text
    // carries no seal/engineer language at all, say so on the row instead of
    // presenting it as settled. Advisory only — scanned letters with no text
    // layer stay untouched, and the human reviewer remains the authority.
    if (item.docType === "structural_letter" && p.present && p.via === "attached file") {
      try {
        const row = db.get<{ extracted_text?: string }>(
          `SELECT extracted_text FROM project_documents
           WHERE project_id = ? AND doc_type IN ('structural_letter','stamped_plans','engineering_letter')
           ORDER BY uploaded_at DESC LIMIT 1`,
          [project.id],
        );
        const text = String(row?.extracted_text || "");
        const hasSealLanguage = /seal|stamp|p\.?\s?e\.?\b|professional engineer|structural engineer|licensed engineer|expires/i.test(text);
        if (text && text !== "[no text layer]" && text.length > 40 && !hasSealLanguage) {
          return { ...item, present: true, via: "attached file — no PE seal language found in its text; confirm it is the real sealed letter before submitting" };
        }
      } catch { /* advisory only — never block on this check */ }
    }
    return { ...item, present: p.present, via: p.via };
  });
  return {
    required,
    presence,
    missingBlocking: presence.filter((p) => !p.present && p.blocking),
    missingAdvisory: presence.filter((p) => !p.present && !p.blocking),
  };
}

// ---------------------------------------------------------------------------
// JURISDICTION-SPECIFIC APPLICATION DOCUMENTS, FROM THE KB
//
// The baseline above is the universal set — plan set, site plan, SLD, specs. What it
// cannot know is that Coos Bay's Accela config also wants a building permit application
// and a solar prescriptive checklist attached, while Portland wants its worksheet
// transcribed into DevHub and explicitly not uploaded.
//
// The KB already records exactly that, per profile, in required_documents: for
// or|city of coos bay|pacific power it lists "Building/structural permit application",
// "Solar prescriptive checklist" and "Renewable Energy (electrical) permit application".
// Nothing read it — the only consumer matched /checklist|worksheet/ to decide which BLANK
// form to go find. So the system knew what the jurisdiction wanted, filled the form, and
// never told anyone it was supposed to go up with the submittal. docSplitter's own comment
// anticipated this: "eventually this can be driven by the learned KB requiredDocuments".
//
// Scope is deliberately narrow: only the APPLICATION/CHECKLIST family, which is the part
// the baseline lacks and the part the portal upload sweep can actually attach. Everything
// else a KB list mentions (plan set, site plan, meter photo, post-install sign-off) is
// either already baseline or belongs to another lane, and surfacing it here would be noise.
//
// Advisory, never blocking: KB rows are learned, they vary in quality, and a wrong blocker
// would stop a filing that is genuinely complete. The operator decides.
// ---------------------------------------------------------------------------

/** KB requirement prose -> the docType that holds it. Ordered: specific before generic.
 *  This vocabulary must agree with the portal-side UPLOAD_LABEL_PATTERNS, or a document is
 *  demanded here under a name no upload slot will ever match — asserted in
 *  backend/test/filledFormUpload.test.ts. */
export const KB_APPLICATION_DOC_PATTERNS: Array<{ re: RegExp; docType: string; label: string }> = [
  // "Electrical" and "application" are often several words apart — Portland's form is the
  // "Electrical Renewable Energy Permit Application", which an adjacency-only pattern reads
  // as a generic application.
  { re: /electrical[\w\s/&()-]{0,40}application|renewable\s*energy[\w\s/&()-]{0,20}electrical/i, docType: "electrical_application", label: "Electrical permit application (filled)" },
  { re: /(building|structural)\s*(permit\s*)?application/i, docType: "building_application", label: "Building / structural permit application (filled)" },
  { re: /checklist|worksheet|eligibilit/i, docType: "solar_checklist", label: "Solar prescriptive checklist (filled)" },
  { re: /(solar|permit|completed|signed)\s*application|application\s*(form|packet)/i, docType: "permit_application", label: "Permit application (filled)" },
];

/**
 * Map a KB profile's required-documents prose to the application/checklist documents this
 * jurisdiction expects attached. `alreadyRequired` suppresses anything the baseline covers.
 */
export function kbApplicationDocItems(requirements: string[], alreadyRequired: Set<string> = new Set()): RequiredDocItem[] {
  const seen = new Set<string>();
  const out: RequiredDocItem[] = [];
  for (const raw of requirements || []) {
    const text = String(raw || "").trim();
    if (!text) continue;
    // A REBATE APPLICATION IS NOT THE FILING. Sweeping the mapper across all 461 KB
    // profiles turned up "Illinois Distributed Generation Rebate Application (Rider CGR)",
    // which happens not to match the patterns below only because "Rebate" sits between the
    // words they look for. That is luck, not a rule — and treating an incentive application
    // as the permit application is the same mistake as picking the rebate programme in
    // ComEd's drawer, where it is guarded explicitly. Guard it here too.
    if (/rebate|incentive|enroll|enrolment|enrollment/i.test(text)) continue;
    const hit = KB_APPLICATION_DOC_PATTERNS.find((p) => p.re.test(text));
    if (!hit || seen.has(hit.docType) || alreadyRequired.has(hit.docType)) continue;
    seen.add(hit.docType);
    out.push({
      docType: hit.docType,
      label: hit.label,
      // The jurisdiction's own words, so the operator can judge the claim rather than
      // trusting a classification.
      why: `This jurisdiction's requirements list names it: "${text.slice(0, 140)}".`,
      lane: "permit",
      blocking: false,
    });
  }
  return out;
}
