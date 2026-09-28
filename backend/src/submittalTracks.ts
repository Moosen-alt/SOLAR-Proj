// ---------------------------------------------------------------------------
// Submittal tracks — a project's independent permit/interconnection filings.
//
// A residential solar project usually needs MORE than one filing:
//   - the UTILITY net-metering (NEM) / interconnection application — this is the
//     utility submission (PowerClerk, etc.), NOT a permit.
//   - an AHJ permit, which is EITHER one combined building+electrical permit
//     (combo) OR two separate filings: building (BLD) and electrical (ELE).
//
// Each track is submitted to its own portal and tracked independently from
// "not started" → staged → submitted → in review → issued. This module derives
// the required tracks for a project and reads/writes their status, reusing the
// existing submissions + permit_check_targets tables (which already drive the
// status poller) rather than introducing a parallel store.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type {
  PermitCheckOutcome,
  ProjectRecord,
  StageDetail,
  SubmittalTrack,
  SubmittalTrackStatus,
  SubmittalTrackType,
} from "../../shared/src/types";
import { findApplicationProfile, describePermitType, permitStructureAnswer, permitStructureIsCitedOrVerified, type PermitPrerequisiteStep, type PermitStructureAnswer } from "./applicationDocs";
import { findAhjProcessProfile, jurisdictionKind, jurisdictionKindsCompatible } from "./processProfiles";
import { findAnyRecipeForProject, findCompleteRecipeForProject } from "./portalRecipes";
import { detectPlatform } from "./publicPermitStatus";
import { NEM_APPROVAL_OUTCOME, isNemApprovalOutcome, trackKind } from "./permitMonitor";
import { HttpError } from "./httpError";
import { isInformationalPageUrl, isUtilityPlatformUrl, portalHostOf, recipeDisciplineForTrack, trackSafeUrl } from "./portalChannel";
import { permitAnswerForTrack, permitProcessFor } from "./permitProcess";
import { utilityTrackPresentation } from "./utilityFilingLookup";
import { nowIso } from "./time";
import { randomUUID } from "node:crypto";

interface Row { [key: string]: unknown }
const s = (v: unknown): string => (v == null ? "" : String(v));

// The TYPE's name — used where a track is named in notes and stage details. What a card is TITLED
// comes from permitTrackLabel() / utilityTrackPresentation: a permit card says what the ONE structure answer settled, and the
// utility card says what the utility's program IS (utilityFilingLookup) — "net metering" only
// where that is known, never by default.
const TRACK_LABELS: Record<SubmittalTrackType, string> = {
  nem: "Utility interconnection",
  building: "Building permit (BLD)",
  electrical: "Electrical permit (ELE)",
  combo: "Building + electrical permit (combo)",
  permit: "AHJ permit",
  mpu: "Main panel / service upgrade permit (MPU)",
};

/** The card title. A single permit track whose structure is NOT settled is the one filing the
 *  operator must still confirm — "Building + electrical permit (combo)" on it was a template
 *  default dressed as a fact (Waltham files fire review + building + wires). */
function permitTrackLabel(type: SubmittalTrackType, answer: PermitStructureAnswer): string {
  if (type === "combo" || type === "permit") {
    if (answer.structure === "combo") return "Building + electrical permit (combo)";
    return "AHJ permit — one permit or separate building + electrical not yet confirmed";
  }
  if ((type === "building" || type === "electrical") && !permitStructureIsCitedOrVerified(answer)) {
    return `${TRACK_LABELS[type]} — per the operator's seeded note, not confirmed on an agency page`;
  }
  return TRACK_LABELS[type];
}

/** A track as the tracks panel receives it: the shared SubmittalTrack plus the evidence behind
 *  its title and channel (declared here — shared/src/types.ts is not this module's to change). */
export interface SubmittalTrackView extends SubmittalTrack {
  /** Permit tracks: the ONE permit-structure answer's basis line. */
  structureBasis?: string;
  /** Permit tracks: steps at another office BEFORE this filing (fire review, zoning), each cited. */
  prerequisites?: PermitPrerequisiteStep[];
  /** How the channel is known: "cited" (per-job lookup), "verified", "profile", "researched", "unknown". */
  channelBasis?: string;
}

/** Every submittal track, derived from the label Record so it cannot go stale: adding a
 *  member to SubmittalTrackType fails the compile until TRACK_LABELS names it, and this
 *  list picks it up for free. Callers holding a track as a loose string (a portal run's
 *  permit_type column) narrow through this. */
export const SUBMITTAL_TRACK_TYPES = Object.keys(TRACK_LABELS) as SubmittalTrackType[];

// Main-panel / service-upgrade scope detection — mirrors the reviewer's MPU callout.
// Keyed on upgrade language (not "derate", a 705.12 remedy that isn't itself an MPU).
function hasMpuScope(project: ProjectRecord): boolean {
  const snap = (project.parserSnapshot || {}) as Record<string, unknown>;
  const text = [
    snap.projectDescriptionText, snap.description, snap.scopeText, snap.electricalCalcText,
    snap.sitePlanNotesText, snap.mpu, snap.serviceUpgrade,
  ].map((v) => (v == null ? "" : String(v))).join(" ").toLowerCase();
  return /\bmpu\b|main panel upgrade|main service panel upgrade|service (panel )?upgrade|\bmsp upgrade\b|panel upgrade|meter.?main upgrade/.test(text);
}

// THE MPU RIDES ON THE ELECTRICAL PERMIT (operator ruling 2026-09-28, City of Corvallis: the main
// panel upgrade went on the electrical permit as its "Service 0-200 amps" line — "not a separate
// permit"). The upgrade is filed with the job's electrical (or combination) permit unless the AHJ's
// own process notes say it needs a permit of its own:
//   - a separate / second / additional / another electrical permit or application for it (Wasco Co
//     "mpu need to fill out separate epa", Hillsboro "two epas if you have an mpu");
//   - or an electrical permit "required for" / "pulled for" the MPU where this job files ONE
//     combination permit (Santa Fe "mpu requires electrical permit to be pulled", Wylie "if mpu pull
//     an electrical") — a job that already files its own electrical permit carries it there.
// A note that says it goes "under one electric trade permit" (Beaverton), or that negates the
// separate permit, keeps it on the electrical permit. Read per note segment, so a negation or an MPU
// mention in another sentence never borrows this one's words.
const MPU_WORDS = /\bmpu\b|panel upgrade|service upgrade|service change/;
function mpuNeedsOwnPermit(project: ProjectRecord, electricalFiledSeparately: boolean): boolean {
  const ahj = findAhjProcessProfile(project);
  const notes = `${ahj?.reviewerNotes || ""} | ${ahj?.otherRequirements || ""}`.toLowerCase();
  return notes.split(/[.;|\n]+/).some((segment) => {
    if (!MPU_WORDS.test(segment)) return false;
    if (/under one (electric|combination)|one electric trade permit/.test(segment)) return false;
    if (/\b(?:not|no|never|without|doesn'?t|don'?t)\b[^,]{0,30}\b(?:separate|second|additional|another|own)\b/.test(segment)) return false;
    if (/\b(?:separate|second|additional|another|two|its own)\s+(?:electric(?:al)?\s+)?(?:permits?|applications?|apps?|epas?)\b/.test(segment)) return true;
    return !electricalFiledSeparately && /\b(?:requires?|required|need(?:s|ed)?|pull(?:ed)?)\b[^,]{0,30}\belectric(?:al)?\b/.test(segment);
  });
}

/** Map a permit track to the permit_check_targets.target_type used by the poller. */
function targetTypeFor(track: SubmittalTrackType): "permit" | "nem" {
  return track === "nem" ? "nem" : "permit";
}

function hasUtility(project: ProjectRecord): boolean {
  return Boolean((project.utility || "").trim());
}

/**
 * The tracks a project must file. NEM whenever there's a utility, plus the AHJ
 * permit(s): one combo permit, or separate building + electrical when the AHJ
 * files them apart. "unknown" structure defaults to a single combo permit (the
 * common case) so the operator always has at least one actionable permit track.
 */
export function requiredTracks(project: ProjectRecord): SubmittalTrackType[] {
  const tracks: SubmittalTrackType[] = [];
  if (hasUtility(project)) tracks.push("nem");

  // Resolve combo vs separate across all signals (AHJ process notes/flags included),
  // so AHJs like Beaverton that file SEPARATE building + electrical permits split into
  // two permit tracks instead of one mislabelled "combo".
  // THE ONE ANSWER (permitStructureAnswer): "separate" only when a cited page, a person, a
  // hand-written profile, the operator's own unhedged note or a cited state rule says so.
  const separate = permitStructureAnswer(project).structure === "separate";
  if (separate) {
    tracks.push("building", "electrical");
  } else {
    tracks.push("combo");
  }

  // A main panel / service upgrade in scope is filed on the electrical/combination permit; it
  // gets its OWN tracked permit only when the AHJ says it needs one (mpuNeedsOwnPermit).
  if (hasMpuScope(project) && mpuNeedsOwnPermit(project, separate)) {
    tracks.push("mpu");
  }
  return tracks;
}

/** A permit track's portal as the per-job lookup found it (cited): this track's own permit, or —
 *  for the single combo/unknown filing — the one portal every looked-up permit agrees on. A URL
 *  that is a utility portal (rule 5) or an information page is never a permit channel. */
function lookedUpPermitPortal(project: ProjectRecord, track: SubmittalTrackType): { url: string; sourceUrl: string; recordType: string } | null {
  const lk = permitProcessFor(project);
  if (!lk?.permits?.length) return null;
  const own = permitAnswerForTrack(project, track);
  const pool = own ? [own] : track === "combo" || track === "permit" ? lk.permits : [];
  const found = pool
    .map((p) => ({ p, url: typeof p.portalUrl?.value === "string" ? p.portalUrl.value.trim() : "" }))
    .filter(({ p, url }) => url && /^https?:\/\//i.test(p.portalUrl.sourceUrl || "") && trackSafeUrl(track, url) && !isInformationalPageUrl(url));
  if (!found.length || new Set(found.map((f) => portalHostOf(f.url))).size !== 1) return null;
  const recordTypes = [...new Set(found.map(({ p }) => (typeof p.recordType?.value === "string" ? p.recordType.value.trim() : "")).filter(Boolean))];
  return { url: found[0].url, sourceUrl: found[0].p.portalUrl.sourceUrl, recordType: recordTypes.length === 1 ? recordTypes[0] : "" };
}

/** The AHJ's knowledge-base row, EXACT name (a fuzzy bridge is how a county inherits a city). */
function kbAhjRow(db: AppDb | null, project: ProjectRecord): Row | null {
  if (!db || !(project.ahj || "").trim()) return null;
  try {
    const row = db.get<Row>(
      `SELECT ahj, portal_url, portal_name, submission_method, verified_at FROM permit_utility_knowledge
        WHERE ahj = ? AND (utility IS NULL OR utility = '') AND (state = '' OR UPPER(state) = UPPER(?))
        ORDER BY (verified_at IS NOT NULL AND verified_at != '') DESC, updated_at DESC LIMIT 1`,
      [project.ahj, project.state || ""],
    );
    if (!row || !jurisdictionKindsCompatible(jurisdictionKind(project.ahj), jurisdictionKind(s(row.ahj)))) return null;
    return row;
  } catch {
    return null;
  }
}

/**
 * WHERE THIS TRACK IS FILED, and how that is known. A portal / "no portal, paper" / record type
 * the per-job lookup FOUND reaches the card (new-AHJ e2e: Iowa City's EnerGov URL and Waltham's
 * "paper drop-off" were found, and the tracks still said "Unknown — verify"). Order: the lookup
 * (cited) → the AHJ's hand-written / seeded profile → the AHJ's knowledge-base row (a person's
 * verified row, else research — said as such) → unknown.
 */
function channelResolution(db: AppDb | null, track: SubmittalTrackType, project: ProjectRecord): { channel: string; basis: string; portalUrl: string } {
  if (track === "nem") {
    const u = utilityTrackPresentation(db, project);
    return { channel: u.channel, basis: u.basis, portalUrl: u.portalUrl };
  }
  const found = lookedUpPermitPortal(project, track);
  if (found) {
    return {
      channel: `Online portal: ${found.url}${found.recordType ? ` — record type "${found.recordType}"` : ""} (per-job lookup, cited: ${found.sourceUrl})`,
      basis: "cited",
      portalUrl: found.url,
    };
  }
  // The lookup looked and found NO online portal (its words, e.g. "applications must be dropped
  // off in person"): that is a finding, shown as one — not a cited quote, so "verify".
  const noPortal = (permitProcessFor(project)?.permits ?? [])
    .map((p) => (p.portalUrl?.value ? "" : s(p.portalUrl?.notFound).trim()))
    // Negations of an online filing only — "only paper application PDFs found" is a search
    // report, not a statement that there is no portal.
    .find((nf) => /\bno online (?:application )?portal\b|\bno (?:application )?portal (?:exists|is available|available)\b|\bdoes not (?:have|offer|use) an? (?:online )?(?:application )?portal\b|\bnot (?:accepted|available|submitted) online\b|\bno online (?:application|submission|filing)\b|\b(?:must|are to) be (?:dropped off|submitted in[- ]person|mailed)\b|\bin[- ]person (?:only|drop[- ]?off|submittal)\b|\bdrop[- ]off only\b/i.test(nf));
  if (noPortal) {
    return { channel: `No online application portal found — ${noPortal.slice(0, 200)} (per-job lookup; verify on the AHJ site)`, basis: "researched", portalUrl: "" };
  }
  const profile = findApplicationProfile(project);
  const method = describePermitType(profile).submissionMethod || "";
  if (method && !/^\s*unknown/i.test(method)) {
    const seeded = profile.id.startsWith("process-");
    return { channel: seeded ? `${method} (seeded AHJ profile — verify)` : method, basis: "profile", portalUrl: "" };
  }
  const kb = kbAhjRow(db, project);
  if (kb) {
    const verified = s(kb.verified_at).trim() !== "";
    const url = s(kb.portal_url).trim();
    const safeUrl = url && trackSafeUrl(track, url) && !isInformationalPageUrl(url) ? url : "";
    const how = s(kb.submission_method).trim() || s(kb.portal_name).trim();
    if (safeUrl || how) {
      return {
        channel: `${how || "Online portal"}${safeUrl ? `: ${safeUrl}` : ""} (${verified ? "verified by a person" : "researched — verify on the AHJ site"})`,
        basis: verified ? "verified" : "researched",
        portalUrl: safeUrl,
      };
    }
  }
  return { channel: "Unknown — verify on the AHJ site", basis: "unknown", portalUrl: "" };
}

/** HOW THIS TRACK IS FILED, AS A KIND (operator 09-28: "City of Waltham only does in-person permit
 *  submission ... ensure they're bold enough to know, same with email submissions as it will require
 *  us to go outside of the submission tool"). ONE answer, read from the channel resolution: a portal
 *  URL on file is a portal; otherwise the channel's own words decide in-person / email / mail; else
 *  unknown. "offTool" = a person must deliver the packet outside this tool. */
export type TrackChannelKind = "portal" | "in_person" | "email" | "mail" | "unknown";
export function channelKindOf(res: { channel: string; portalUrl: string }): TrackChannelKind {
  if (res.portalUrl) return "portal";
  const t = String(res.channel || "");
  // A guess is not a finding: "unknown — likely in-person ..." / "not yet identified" stay unknown.
  if (/^\s*unknown\b/i.test(t) || /\bnot yet identified\b/i.test(t)) return "unknown";
  // A portal named or linked (a URL, a platform name, "portal", "online") and not negated is a portal —
  // "Oregon ePermitting (Accela)", "PowerClerk", a Tyler EnerGov self-service link, "Portland DevHub".
  const negated = /\bno online\b|\bno (?:application )?portal\b|\bnot (?:online|through a portal)\b/i.test(t);
  // AN IN-PERSON CLAUSE WINS (leak sweep, 2026-09-28): Bernalillo County's seeded method reads "BPA: In
  // person EPA: Bernalillo County accela" — the building permit is filed at the counter, and the
  // platform word further along made the whole track read "portal", so no in-person banner showed.
  // Tested before the platform words; a negated clause ("no in-person submittals") is not one.
  const inPerson = /\bin[\s-]?person\b|\bdrop(?:ped)?[\s-]?off\b|\bover[\s-]the[\s-]counter\b|\bat the counter\b|\bwalk[\s-]?in\b|\bpaper (?:application|submi\w*|drop)/i;
  // READ CLAUSE BY CLAUSE (forms skeptic note 1): an in-person clause that REFUSES in-person ("In-person
  // submittals are not accepted; apply online", "Paper applications are no longer accepted — apply
  // online", "the permit counter is closed") is not an in-person channel at all; one that ALLOWS it
  // beside another channel ("Apply online; in-person drop off also accepted") does not outrank the
  // portal — it is only the fallback when no portal is named.
  const clauses = t.split(/[;.\n|]+|\s[—–-]\s/).map((c) => c.trim()).filter(Boolean);
  const refusesInPerson = (c: string): boolean => /\bnot\s+(?:be\s+)?accepted\b|\bno\s+longer\b|\bclosed\b|\b(?:no|not)\s+(?:accepted\s+)?(?:in[\s-]?person|walk[\s-]?in|drop[\s-]?off)\b/i.test(c);
  const inPersonClauses = clauses.filter((c) => inPerson.test(c) && !refusesInPerson(c));
  if (inPersonClauses.some((c) => !/\balso\s+accepted\b/i.test(c))) return "in_person";
  // "online" only as FILING online — Waltham's "permit fees payable online" is paying, not filing.
  if (!negated && (/https?:\/\//i.test(t) || /\b(?:portal|accela|epermitting|energov|powerclerk|devhub|iworq|citizenserve|etrakit|opengov|self[\s-]?service)\b/i.test(t)
    || /\bonline (?:application|submi\w*|filing|permit(?:ting)? (?:system|application))\b|\b(?:apply|submit(?:ted)?|file[ds]?) online\b/i.test(t))) return "portal";
  if (inPersonClauses.length) return "in_person";
  if (/\be-?mail(?:ed|ing)?\b|\b[\w.+-]+@[\w-]+\.[\w.-]+\b/i.test(t)) return "email";
  if (/\b(?:by|via|through the) (?:us )?(?:postal )?mail\b|\bmail(?:ed)? to\b|\bpostal\b/i.test(t)) return "mail";
  return "unknown";
}

/** A tracking target's portal_name: the found portal's host, else the channel without its
 *  evidence parenthetical — a name, not the card's sentence. */
function targetPortalName(track: SubmittalTrackType, project: ProjectRecord, db: AppDb | null): string {
  const r = channelResolution(db, track, project);
  return r.portalUrl ? portalHostOf(r.portalUrl) : r.channel.replace(/s*([^)]*)s*$/, "");
}

function channelFor(track: SubmittalTrackType, project: ProjectRecord, db: AppDb | null = null): string {
  return channelResolution(db, track, project).channel;
}

/**
 * The permit_type values (on submissions and permit_check_targets) that belong to one track.
 *
 *  - combo / permit are one filing: legacy rows created before per-track support carry
 *    permit_type 'permit', and the trackless stage still records its run that way.
 *  - building / structural are one trade. The fee layer, the discipline recipes and the
 *    operator's own target tags say "structural"; the track says "building" (clientPortal's
 *    trackLabel already names both "Building permit"). Unfolded, a project whose building
 *    permit was tagged 'structural' read "building: not started" forever and could never hand
 *    off — and handoff_ready cannot be set by hand.
 */
export function trackPermitTypes(track: SubmittalTrackType): string[] {
  if (track === "combo" || track === "permit") return ["combo", "permit"];
  if (track === "building") return ["building", "structural"];
  return [track];
}

/**
 * Does this ONE reading finish this track, on this kind of target? The outcome half of
 * isTrackDone below (which also reads the target's history and the project's other targets).
 *
 *  - an AHJ permit track is done at `issued` — NOT `ready_for_issue`, which is "approved, pay
 *    the issuance fee": a person still owes the jurisdiction money and there is no permit card.
 *  - the NEM track is done at `nem_approved`.
 *  - an outcome counts ONLY on a target of its own kind. A utility target whose text happened
 *    to classify as "issued", or a permit target reading "nem_approved", has not finished that
 *    track — the same rule updateProjectForPermitOutcome applies before it writes a status.
 *
 * `targetKind` is the target's KIND — trackKind(target_type, permit_type), the ONE answer — never
 * raw target_type: a legacy row typed '' or 'permit' beside permit_type 'nem' is the NEM filing
 * the writer classifies it as, and its approval must finish the NEM track (not stay "in review").
 */
export function outcomeFinishesTrack(track: SubmittalTrackType, outcome: PermitCheckOutcome | string | null, targetKind: string): boolean {
  // isNemApprovalOutcome: the ONE "is this NEM target approved" predicate (permitMonitor.ts).
  if (track === "nem") return targetKind === "nem" && isNemApprovalOutcome(outcome);
  return targetKind === "permit" && outcome === "issued";
}

/** The target row's kind — trackKind, the ONE answer (never raw target_type). */
function kindOf(target: Row): "permit" | "nem" {
  return trackKind(s(target.target_type), s(target.permit_type));
}

/**
 * Has this one tracking target FINISHED the track? Its newest reading is not the whole answer.
 *
 * The monitor polls a target forever, and after issuance the jurisdiction's text moves on:
 * "Record Status: Finaled", "Status: Closed", "Status: Complete" classify needs_human_review,
 * "Final Approved" reviewed_by_ahj, "Inspections in progress" waiting. Judged on latest_outcome
 * alone, a FINALED permit read "not done" and the project could never hand off. So: the target
 * is done when it has EVER read the track's done outcome and no correction was read AFTER that
 * (a correction after issuance re-opens the filing; the same target reading issued again after
 * the correction closes it). ready_for_issue is still not done — it never is.
 *
 * Only readings that changed something are rows in permit_status_checks (shouldRecordStatusCheck),
 * and an issued / correction transition always is one. created_at ties (same millisecond) break
 * on rowid, i.e. insertion order.
 */
function targetFinishedTrack(db: AppDb, track: SubmittalTrackType, target: Row): boolean {
  const done = track === "nem" ? NEM_APPROVAL_OUTCOME : "issued";
  if (!outcomeFinishesTrack(track, done, kindOf(target))) return false; // wrong kind of target
  const latest = s(target.latest_outcome);
  if (latest === "correction_flagged") return false;
  if (latest === done) return true;
  const last = db.get<Row>(
    `SELECT outcome FROM permit_status_checks
      WHERE target_id = ? AND outcome IN (?, 'correction_flagged')
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [s(target.id), done],
  );
  return s(last?.outcome) === done;
}

/**
 * Which active tracking targets speak for one track.
 *
 *  - `own`: the newest-updated target TAGGED with this track's permit_type family.
 *  - otherwise the POOL: active targets of this track's kind (permit / nem) that are tagged to
 *    NO track in `required` — untagged ones (the dashboard's add-target form sends no
 *    permitType, so they carry ''), and ones tagged to a track this project does not require
 *    (a 'building' tag on a combo project). `poolDemand` is how many required tracks of this
 *    kind have no tagged target of their own and so draw on the pool.
 */
function trackTargets(db: AppDb, projectId: string, track: SubmittalTrackType, required: readonly SubmittalTrackType[]): { own: Row | null; pool: Row[]; poolDemand: number } {
  const active = db.query<Row>(
    "SELECT * FROM permit_check_targets WHERE project_id = ? AND active = 1 ORDER BY updated_at DESC, created_at DESC",
    [projectId],
  );
  const tagged = (t: SubmittalTrackType): Row | null => active.find((r) => trackPermitTypes(t).includes(s(r.permit_type))) ?? null;
  const own = tagged(track);
  const kind = targetTypeFor(track);
  const claimed = new Set([...required, track].flatMap(trackPermitTypes));
  const pool = active.filter((r) => kindOf(r) === kind && !claimed.has(s(r.permit_type)));
  const poolDemand = [...new Set([...required, track])].filter((t) => targetTypeFor(t) === kind && !tagged(t)).length;
  return { own, pool, poolDemand };
}

/**
 * IS THIS TRACK DONE? The ONE answer — read by the tracks panel (getSubmittalTracks) and by the
 * installer handoff (repository.handoffBlockers → triggerHandoffIfReady). Two readers that
 * answered it differently let the panel say "1/3 issued" while the project handed off.
 *
 *  - A track with its own tagged target is judged by that target (targetFinishedTrack: ever
 *    issued / approved on its own kind of target, no correction since).
 *  - A track with none draws on the pool (trackTargets). ONE UNATTRIBUTED TARGET NEVER FINISHES
 *    TWO TRACKS: the pool finishes the tracks that draw on it only when it holds at least one
 *    target per such track AND every target in it is finished. Before this, on a multi-permit
 *    project the '' fallback resolved building AND electrical to the same newest-polled target,
 *    so the electrical permit's "issued" handed off a project whose building permit was still in
 *    plan review. We cannot tell which unattributed filing is which, so none may be unfinished.
 *
 * `required` is the full list of tracks being judged together (it decides which tags are
 * claimed and how many tracks draw on the pool).
 */
export function isTrackDone(db: AppDb, projectId: string, track: SubmittalTrackType, required: readonly SubmittalTrackType[]): boolean {
  const { own, pool, poolDemand } = trackTargets(db, projectId, track, required);
  if (own) return targetFinishedTrack(db, track, own);
  if (pool.length === 0 || pool.length < poolDemand) return false;
  return pool.every((r) => targetFinishedTrack(db, track, r));
}

/** Does this track have a TRACKED filing — its own tagged target, or pool targets it draws on?
 *  (A required track with none is unknown, not "in review": nobody has told us it was filed.) */
export function trackHasFiling(db: AppDb, projectId: string, track: SubmittalTrackType, required: readonly SubmittalTrackType[]): boolean {
  const { own, pool } = trackTargets(db, projectId, track, required);
  return Boolean(own) || pool.length > 0;
}

// PermitCheckOutcome → track status. Issued-family wins; corrections surface next.
//
// ready_for_issue is NOT issued. It is the AHJ saying "approved, pay the issuance fee" — the
// project reads fees-due at the same moment, and folding it into "issued" made this track read
// "Permit issued / Done", count toward "N/M issued" and drop out of `outstanding` while the
// permit could not yet be downloaded and a person still had to pay.
//
// "issued" is decided by isTrackDone BEFORE this runs (deriveStatus); here an issued-family
// newest reading that isTrackDone did not accept — the wrong kind of target, or one pooled
// target that cannot finish two tracks — is a filing still under review, not a finished track.
function statusFromOutcome(outcome: PermitCheckOutcome | null): SubmittalTrackStatus | null {
  // The NEM approval (isNemApprovalOutcome) sits with "issued" here on purpose: done is decided
  // by isTrackDone above, so an approval that did not finish the track is a filing in review.
  if (isNemApprovalOutcome(outcome)) return "in_review";
  switch (outcome) {
    case "issued":
      return "in_review";
    case "ready_for_issue":
      return "ready_for_issue";
    case "correction_flagged":
      return "correction";
    case "reviewed_by_ahj":
    case "waiting":
      return "in_review";
    default:
      return null;
  }
}

interface TrackState {
  submissionStatus: string | null;
  submittedAt: string | null;
  applicationNumber: string;
  permitNumber: string;
  confirmationNumber: string;
  trackingUrl: string;
  outcome: PermitCheckOutcome | null;
  statusLabel: string;
  lastCheckedAt: string | null;
  /** isTrackDone's verdict for this track (the ONE "is this track done" rule). */
  done: boolean;
}

// Read the latest submission + tracking target for one track. Legacy rows created
// before per-track support carry permit_type='permit'; fold those into the combo/
// permit track so existing projects still show their submission status (trackPermitTypes).
function readTrackState(db: AppDb, projectId: string, track: SubmittalTrackType, required: readonly SubmittalTrackType[]): TrackState {
  const permitTypes = trackPermitTypes(track);
  const placeholders = permitTypes.map(() => "?").join(",");

  const submission = db.get<Row>(
    `SELECT * FROM submissions
      WHERE project_id = ? AND permit_type IN (${placeholders})
      ORDER BY created_at DESC LIMIT 1`,
    [projectId, ...permitTypes],
  );

  // Tracking target: the one tagged with this track, else the newest of the pool (untagged,
  // or tagged to a track this project does not require) — the same resolution isTrackDone
  // judges, so what the panel shows is the target the verdict came from.
  const { own, pool } = trackTargets(db, projectId, track, required);
  const target = own ?? pool[0] ?? null;

  return {
    submissionStatus: submission ? s(submission.status) : null,
    submittedAt: submission && submission.submitted_at != null ? s(submission.submitted_at) : null,
    applicationNumber: s(submission?.application_number) || s(target?.application_number),
    permitNumber: s(submission?.permit_number) || s(target?.permit_number),
    confirmationNumber: s(submission?.confirmation_number),
    trackingUrl: s(target?.tracking_url),
    outcome: target?.latest_outcome ? (s(target.latest_outcome) as PermitCheckOutcome) : null,
    statusLabel: s(target?.latest_status_label),
    lastCheckedAt: target?.last_checked_at != null ? s(target.last_checked_at) : null,
    done: isTrackDone(db, projectId, track, required),
  };
}

/**
 * The tracks among `tracks` that are NOT done, judged together (they are the `required` list
 * isTrackDone attributes targets against). Empty means every one is done.
 */
export function unfinishedTracks(db: AppDb, projectId: string, tracks: readonly SubmittalTrackType[]): SubmittalTrackType[] {
  return tracks.filter((t) => !isTrackDone(db, projectId, t, tracks));
}

/**
 * On a MULTI-PERMIT project (more than one permit track among `tracks`): active PERMIT targets
 * attributed to none of them (untagged, or tagged to a track the project does not require) that
 * have not finished — judged by the same targetFinishedTrack rule. isTrackDone consults that pool
 * only when a track has no target of its own; this catches the rest: every permit track tagged
 * and issued, plus an unattributed permit the monitor is still polling in review (an MPU filed
 * without an MPU track, a dashboard-added target). With several permits in play we cannot say
 * which filing that is, so the handoff waits for it too.
 *
 * Deliberately NOT applied to a single-permit project: there the pool rule already covers the
 * one permit track, and nothing in the app can deactivate or delete one tracking target, so a
 * stale stray target would strand the handoff with no remedy but SQL.
 */
export function unfinishedUnattributedTargets(db: AppDb, projectId: string, tracks: readonly SubmittalTrackType[]): number {
  if (tracks.filter((t) => targetTypeFor(t) === "permit").length < 2) return 0;
  const claimed = new Set(tracks.flatMap(trackPermitTypes));
  // Permit KIND by trackKind (kindOf), not a raw `target_type = 'permit'` filter.
  const active = db.query<Row>("SELECT * FROM permit_check_targets WHERE project_id = ? AND active = 1", [projectId]).filter((r) => kindOf(r) === "permit");
  return active.filter((r) => !claimed.has(s(r.permit_type)) && !targetFinishedTrack(db, "permit", r)).length;
}

function deriveStatus(state: TrackState): SubmittalTrackStatus {
  if (state.done) return "issued";
  const fromOutcome = statusFromOutcome(state.outcome);
  if (fromOutcome === "ready_for_issue") return "ready_for_issue";
  if (fromOutcome === "correction") return "correction";
  // Submitted to the portal already?
  if (state.submissionStatus === "submitted") {
    return fromOutcome === "in_review" || state.trackingUrl ? "in_review" : "submitted";
  }
  if (state.submissionStatus === "awaiting_human_submit" || state.submissionStatus === "staged") {
    return "staged";
  }
  // paused_for_human / failed runs staged NOTHING on the portal — the track genuinely
  // has not started; the portal-runs panel carries the pause/failure banner.
  if (fromOutcome) return fromOutcome; // a target exists even without a submission row
  return "not_started";
}

function categoryFor(type: SubmittalTrackType): "utility" | "permit" {
  return type === "nem" ? "utility" : "permit";
}

// Status wording differs by category — a utility NEM filing is "approved (PTO)",
// an AHJ permit is "issued". Keeps the operator's mental model correct.
function statusLabelFor(status: SubmittalTrackStatus, category: "utility" | "permit"): string {
  if (category === "utility") {
    const utilityLabels: Record<SubmittalTrackStatus, string> = {
      not_started: "Not started",
      staged: "Staged — awaiting manual submit",
      submitted: "Submitted to utility",
      in_review: "Under utility review",
      correction: "Utility correction requested",
      ready_for_issue: "Approved — fee due",
      issued: "Approved — PTO granted",
    };
    return utilityLabels[status];
  }
  const permitLabels: Record<SubmittalTrackStatus, string> = {
    not_started: "Not started",
    staged: "Staged — awaiting manual submit",
    submitted: "Submitted to AHJ",
    in_review: "Under AHJ review",
    correction: "Correction requested",
    ready_for_issue: "Ready for issue — fee due",
    issued: "Permit issued",
  };
  return permitLabels[status];
}

function nextActionFor(status: SubmittalTrackStatus, channel: string, type: SubmittalTrackType, prerequisites: PermitPrerequisiteStep[] = []): string {
  const base = nextActionCore(status, channel, type);
  // A PREREQUISITE OFFICE IS ITS OWN STEP, BEFORE this filing (Waltham: "ALL Plans need to go to
  // Fire Prevention Prior to Building Department drop off"). Said first, cited, until filed.
  if (!prerequisites.length || !(status === "not_started" || status === "staged")) return base;
  const steps = prerequisites.map((p, i) => `(${i + 1}) ${p.step} [${p.sourceUrl}]`).join(" ");
  return `FIRST, at another office: ${steps}. THEN: ${base}`;
}

function nextActionCore(status: SubmittalTrackStatus, channel: string, type: SubmittalTrackType): string {
  // Accela (Oregon ePermitting) instant-issues most ELECTRICAL/renewable-energy permits
  // right after the fee is paid and the final submit is clicked — the approval arrives by
  // email, which the email tracker already detects. Set that expectation on those tracks.
  const isAccela = /accela|epermitting/i.test(channel);
  const isElectricalLike = type === "electrical" || type === "combo" || type === "permit" || type === "mpu";
  const accelaInstantNote = isAccela && isElectricalLike
    ? " On Accela this electrical/renewable-energy permit is usually issued instantly once fees are paid and the final submit is clicked — watch for the approval email."
    : "";
  switch (status) {
    // An unresolved channel arrives as "Unknown — verify on the AHJ site"; "Stage in Unknown"
    // read as a broken template on the project page.
    case "not_started": return /^\s*(unknown|$)|not yet identified/i.test(channel)
      ? (type === "nem"
        ? "Find where this utility takes interconnection applications (its interconnection / contractor page), stage it there, submit manually, then record the number here."
        : "Stage in the AHJ portal (not yet identified — verify it on the AHJ's website), submit manually, then record the number here.")
      : `Stage in ${channel}, submit manually, then record the number here.${accelaInstantNote}`;
    case "staged": return `Review the staged portal, submit manually, then mark it submitted below.${accelaInstantNote}`;
    case "submitted": return `Add the public status URL so the poller can track it to approval.${accelaInstantNote}`;
    case "in_review": return "Tracking — the poller is checking the portal for status changes.";
    case "correction": return "A correction was requested — resolve it and resubmit.";
    case "ready_for_issue": return "Approved — a person pays the issuance fee in the portal (automation never pays fees); the poller then watches for the issued permit.";
    case "issued": return "Done — issued / approved.";
  }
}

// Capture fields differ by category: a utility NEM application has no AHJ "permit
// number" (its final artifact is the PTO/approval, captured as confirmation), while
// an AHJ permit issues a permit number.
function captureFieldsFor(type: SubmittalTrackType): SubmittalTrack["captureFields"] {
  if (categoryFor(type) === "utility") {
    return [
      { key: "applicationNumber", label: "Interconnection / case #", placeholder: "e.g. APP-2026-0042" },
      { key: "confirmationNumber", label: "Confirmation / PTO #", placeholder: "submission or PTO reference" },
      { key: "trackingUrl", label: "Public status URL", placeholder: "no-login status link, if any" },
    ];
  }
  return [
    { key: "applicationNumber", label: "Application / record #", placeholder: "e.g. 24-001234-STR" },
    { key: "permitNumber", label: "Permit # (once issued)", placeholder: "issued permit number" },
    { key: "confirmationNumber", label: "Confirmation #", placeholder: "submission confirmation" },
    { key: "trackingUrl", label: "Public status URL", placeholder: "no-login record link (e.g. Accela CapDetail)" },
  ];
}

/** Build the full submittal-track view for a project: every required track + status. */
export function getSubmittalTracks(db: AppDb, project: ProjectRecord): SubmittalTrackView[] {
  const required = requiredTracks(project);
  const answer = permitStructureAnswer(project);
  const utility = required.includes("nem") ? utilityTrackPresentation(db, project) : null;
  return required.map((type) => {
    const state = readTrackState(db, project.id, type, required);
    const status = deriveStatus(state);
    const category = categoryFor(type);
    const resolved = channelResolution(db, type, project);
    const channel = resolved.channel;
    // Prerequisites precede the building-side filing (the one that goes to the other office's
    // stamp first); on a single-permit project, that one permit.
    const prerequisites = category === "permit" && type !== "electrical" && type !== "mpu" ? answer.prerequisites : [];

    // WHICH RECIPE THIS TRACK USES — ONE QUESTION, ONE PREDICATE (dry run 2026-09-28, B9: "they just
    // look blank"). The card used to ask its own raw `profile_key = ?` query: no name-alias fallback
    // (a project spelling its utility "PacifiCorp" missed every "Pacific Power" AHJ recipe that
    // staging replayed) and no discipline (the electrical card showed the structural recipe). It now
    // answers what staging would replay NEXT, then what the last run used:
    //   1. a COMPLETE recipe from the resolver staging itself uses (findCompleteRecipeForProject —
    //      exact key, then the name/identity alias, discipline-scoped exactly as prepareSubmission
    //      asks): with one on file, that is what the next stage replays;
    //   2. else what THIS project's newest staging run of this track used — a BORROWED recipe
    //      (result_json.borrowedRecipe, portalRecipes.findBorrowableRecipe) or its recipe_id;
    //   3. else any draft the resolver finds (findAnyRecipeForProject — staging's own fallback).
    const scopeType = category === "utility" ? "utility" : "ahj";
    const family = trackPermitTypes(type);
    const resolverInput = {
      scopeType, state: project.state, ahj: project.ahj, utility: project.utility,
      ...(scopeType === "ahj" ? { discipline: recipeDisciplineForTrack(type) } : {}),
    } as const;
    type CardRecipe = { id: string; status: string; portal_url: string };
    const cardRecipe = (r: { id: string; status?: unknown; portalUrl?: unknown } | null): CardRecipe | null =>
      r ? { id: r.id, status: s(r.status), portal_url: s(r.portalUrl) } : null;
    let recipeRow: CardRecipe | null = cardRecipe(findCompleteRecipeForProject(db, resolverInput));
    // NO RECIPE OF ITS OWN IS NOT "NOTHING RAN" (operator 09-28: "if we're using the Coos Bay recipe can
    // we make it say that somewhere? They just look blank"). Stage borrows a recipe learned for another
    // entity on the same portal (portalRecipes.findBorrowableRecipe) and records it on the run
    // (result_json.borrowedRecipe). The card says which one THIS project's last run of this track used.
    let borrowedRecipe: SubmittalTrackView["borrowedRecipe"] = null;
    if (!recipeRow) for (const r of db.query<Row>(
      `SELECT recipe_id, result_json, started_at FROM portal_runs
        WHERE project_id = ? AND permit_type IN (${family.map(() => "?").join(",")}) AND run_type = 'prepare_submit'
        ORDER BY started_at DESC, rowid DESC LIMIT 5`,
      [project.id, ...family],
    )) {
      let b: Record<string, unknown> | undefined;
      try { b = (JSON.parse(s(r.result_json) || "{}") as { borrowedRecipe?: Record<string, unknown> }).borrowedRecipe; } catch { /* an unreadable result is simply not evidence */ }
      if (b && typeof b.recipeId === "string" && b.recipeId) {
        borrowedRecipe = {
          recipeId: String(b.recipeId), recipeVersion: Number(b.recipeVersion) || null, learnedFor: String(b.learnedFor ?? ""),
          recordType: String(b.recordType ?? ""), portalHost: String(b.portalHost ?? ""), lastUsedAt: s(r.started_at),
        };
        break;
      }
      const used = s(r.recipe_id) ? db.get<Row>("SELECT id, status, portal_url FROM portal_recipes WHERE id = ?", [s(r.recipe_id)]) : undefined;
      if (used) { recipeRow = { id: s(used.id), status: s(used.status), portal_url: s(used.portal_url) }; break; }
    }
    if (!recipeRow && !borrowedRecipe) recipeRow = cardRecipe(findAnyRecipeForProject(db, resolverInput));

    // Fallback portal URL when no recipe exists yet — used by the credential-matching
    // chip so the operator can store a login before recording. Try in order:
    // 1. KB profile (user-accumulated knowledge from previous projects)
    // 2. applicationDocs profile (built-in AHJ/utility definitions)
    //
    // A found portal (the per-job lookup's, or the utility lookup's, cited) comes first. Every
    // candidate must be SOMEWHERE AN APPLICATION IS FILED on THIS track: a profile's sourceUrl is
    // often an information page (portland.gov/ppd/solar-development/solar-permits), and a KB
    // row can hold the other track's portal (rule 5).
    const fitsHere = (u: string) => Boolean(u) && Boolean(trackSafeUrl(type, u)) && !isInformationalPageUrl(u);
    let kbPortalUrl: string | undefined;
    if (!recipeRow || !s(recipeRow.portal_url)) {
      if (fitsHere(resolved.portalUrl)) kbPortalUrl = resolved.portalUrl;
      const kbField = scopeType === "utility" ? "utility" : "ahj";
      const kbVal = scopeType === "utility" ? project.utility : project.ahj;
      const kbRow = !kbPortalUrl && kbVal
        ? db.get<Row>(`SELECT portal_url FROM permit_utility_knowledge WHERE ${kbField} = ? AND portal_url IS NOT NULL AND portal_url != '' LIMIT 1`, [kbVal])
        : null;
      if (kbRow && fitsHere(s(kbRow.portal_url))) {
        kbPortalUrl = s(kbRow.portal_url);
      } else if (!kbPortalUrl) {
        // Fall back to applicationDocs profile sourceUrl (built-in AHJ/utility definitions).
        const appProfile = findApplicationProfile(project);
        if (appProfile?.sourceUrl && fitsHere(appProfile.sourceUrl)) kbPortalUrl = appProfile.sourceUrl;
      }
    }

    return {
      type,
      label: type === "nem" ? (utility?.label ?? TRACK_LABELS.nem) : permitTrackLabel(type, answer),
      category,
      channel,
      channelBasis: resolved.basis,
      channelKind: channelKindOf(resolved),
      ...(category === "permit" ? { structureBasis: answer.basis, prerequisites } : {}),
      status,
      // The portal's own words — unless they say "issued" of a track isTrackDone did not accept
      // (one pooled target cannot finish two tracks), where they would contradict the status.
      statusLabel: (!state.done && (state.outcome === "issued" || state.outcome === "nem_approved") ? "" : state.statusLabel)
        || statusLabelFor(status, category),
      nextAction: nextActionFor(status, channel, type, prerequisites),
      captureFields: captureFieldsFor(type),
      applicationNumber: state.applicationNumber,
      permitNumber: state.permitNumber,
      confirmationNumber: state.confirmationNumber,
      trackingUrl: state.trackingUrl,
      submittedAt: state.submittedAt,
      lastCheckedAt: state.lastCheckedAt,
      outstanding: status !== "issued",
      hasRecipe: !!recipeRow,
      recipeStatus: recipeRow ? s(recipeRow.status) : undefined,
      recipePortalUrl: (recipeRow ? s(recipeRow.portal_url) : undefined) || kbPortalUrl,
      recipeId: recipeRow ? s(recipeRow.id) : undefined,
      recipeScopeType: scopeType,
      borrowedRecipe,
    };
  });
}

/**
 * Record that the operator manually submitted one track, capturing its numbers and
 * (optionally) the public tracking URL. Writes a `submitted` submission row tagged
 * with the track's permit_type and ensures a permit_check_target exists so the
 * poller follows it through to issuance. The system NEVER auto-submits — this is the
 * human confirming a submit they performed.
 */
export function markTrackSubmitted(
  db: AppDb,
  project: ProjectRecord,
  type: SubmittalTrackType,
  input: {
    applicationNumber?: string;
    permitNumber?: string;
    confirmationNumber?: string;
    trackingUrl?: string;
    submittedBy?: string;
    notes?: string;
    /** WHEN IT ACTUALLY WENT IN. Defaults to now, which is right when the operator files in the
     *  portal and records it in the same sitting. File on Monday and record on Wednesday and the
     *  default is wrong in the one field the client tracker exists to report — their review clock
     *  would appear to start two days late. ISO date or datetime. */
    submittedAt?: string;
  },
): void {
  if (!requiredTracks(project).includes(type)) {
    throw new HttpError(400, `This project does not require a "${type}" submittal track.`);
  }
  const ts = nowIso();
  // THE FILING DATE IS VALIDATED, NEVER COERCED. An unparseable string stored here reaches a
  // client's page as a confident wrong fact about the only date that matters to them, and a
  // future one says a jurisdiction received something it has not. Both refuse.
  //
  // The skew allowance exists because "now" from a browser whose clock runs a little fast is not
  // somebody claiming to have filed tomorrow, and refusing it is a support call for nothing.
  const FUTURE_SKEW_MS = 5 * 60_000;
  const submittedAt = ((): string => {
    const raw = (input.submittedAt || "").trim();
    if (!raw) return ts;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, `Could not read "${raw}" as a filing date. Use YYYY-MM-DD, or leave it blank for today.`);
    }
    if (parsed.getTime() > Date.now() + FUTURE_SKEW_MS) {
      throw new HttpError(400, `That filing date is in the future (${raw}). A permit cannot have been submitted tomorrow.`);
    }
    return parsed.toISOString();
  })();
  const applicationNumber = (input.applicationNumber || "").trim();
  const permitNumber = (input.permitNumber || "").trim();
  const confirmationNumber = (input.confirmationNumber || "").trim();
  const trackingUrl = (input.trackingUrl || "").trim();
  // Refused before anything is written — the same rule ensureCheckTarget enforces inside the
  // transaction below, checked here too so the refusal is the whole answer rather than a
  // rollback of a half-written submission.
  refuseUtilityUrlOnPermitTarget(targetTypeFor(type), trackingUrl);

  db.transaction(() => {
    // If a staged run left an awaiting_human_submit submission for this track, the
    // operator's manual submit RESOLVES it — update that row in place rather than
    // inserting a second one, so the track never counts as both staged and submitted.
    const awaiting = db.get<Row>(
      `SELECT id FROM submissions
        WHERE project_id = ? AND permit_type = ? AND status = 'awaiting_human_submit'
        ORDER BY created_at DESC LIMIT 1`,
      [project.id, type],
    );
    if (awaiting) {
      db.run(
        `UPDATE submissions
           SET status = 'submitted', application_number = ?, permit_number = ?,
               confirmation_number = ?, submitted_at = ?, submitted_by = ?, notes = ?
         WHERE id = ?`,
        [
          applicationNumber,
          permitNumber,
          confirmationNumber,
          submittedAt,
          (input.submittedBy || "").trim(),
          (input.notes || `${TRACK_LABELS[type]} submitted manually by operator.`),
          s(awaiting.id),
        ],
      );
    } else {
      db.run(
        `INSERT INTO submissions
          (id, project_id, portal_profile_id, submission_type, permit_type, status,
           application_number, permit_number, confirmation_number, submitted_at, submitted_by,
           screenshots_path, notes, created_at)
         VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, '', ?, ?)`,
        [
          randomUUID(),
          project.id,
          null,
          type === "nem" ? "interconnection" : "permit",
          type,
          applicationNumber,
          permitNumber,
          confirmationNumber,
          submittedAt,
          (input.submittedBy || "").trim(),
          (input.notes || `${TRACK_LABELS[type]} submitted manually by operator.`),
          ts,   // created_at is when the ROW was written; submitted_at is when it was FILED
        ],
      );
    }

    // Close out the staged portal run for this track too, so the autopilot approve
    // gate (which keys on an awaiting_human_submit run) can't re-submit a filing the
    // human already completed in the portal.
    db.run(
      `UPDATE portal_runs SET status = 'submitted', finished_at = ?
        WHERE project_id = ? AND permit_type = ? AND status = 'awaiting_human_submit'`,
      [ts, project.id, type],
    );

    // Advance the project once every staged track is resolved — mirrors
    // captureConfirmation. Only post-staging statuses advance: a manual submit recorded
    // on a project that never staged must not skip the pre-stage pipeline.
    // A second arm of this test used to also accept the submit-staging status. That status
    // was removed from ProjectStatus (2026-09-19) because it had zero writers anywhere, so
    // the arm was unreachable. `awaiting_human_submit` is the only post-staging status a
    // manual submit can be recorded against.
    if (project.status === "awaiting_human_submit") {
      const stillAwaiting = db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM submissions WHERE project_id = ? AND status = 'awaiting_human_submit'",
        [project.id],
      );
      const remaining = Number(stillAwaiting?.n ?? 0);
      db.run("UPDATE projects SET status = ?, current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
        remaining > 0 ? "awaiting_human_submit" : "submitted",
        remaining > 0
          ? `${TRACK_LABELS[type]} submitted; ${remaining} track(s) still awaiting human submit.`
          : `${TRACK_LABELS[type]} submitted manually. Tracking approval.`,
        // Same two states captureConfirmation records, from the manual-submit door — a project
        // half-filed here must not read any differently from one half-filed there.
        (remaining > 0 ? "submitted_partial" : "submitted_all") satisfies StageDetail,
        ts,
        project.id,
      ]);
    }

    // Ensure a tracking target so the poller follows this track. THE ONE CREATOR —
    // see ensureCheckTarget below; this door and captureConfirmation's and the
    // operator's "add target" all go through it so a re-run supersedes, never appends.
    ensureCheckTarget(db, project, {
      track: type,
      applicationNumber,
      permitNumber,
      portalUrl: trackingUrl,
      trackingUrl,
      notes: `${TRACK_LABELS[type]} tracking`,
      nextCheckAt: ts, // check on the next poll tick
    });
  });
}

// ---------------------------------------------------------------------------
// ensureCheckTarget — THE ONE PLACE A permit_check_targets ROW IS BORN.
//
// Three doors record that a filing went out, and until this function existed two
// of them wrote their own INSERT and the third wrote nothing at all:
//
//   1. markTrackSubmitted (above)          — the operator's "mark this track submitted".
//   2. createPermitCheckTarget (repository)— the operator's "add target" form.
//   3. captureConfirmation (repository)    — the human's confirmation after they clicked
//                                            the portal's final submit. CREATED NO TARGET,
//                                            so a filing confirmed through the normal panel
//                                            was never polled again. On the live database
//                                            every target was hand-added by the operator
//                                            60-90 seconds AFTER each confirmation
//                                            (audit: submission.confirmation_captured at
//                                            16:42:00 → permit_target.created at 16:43:05).
//
// DEDUPE, because re-running an action must SUPERSEDE, not append. The live database
// records the same portal run (b364128a, project ec5c36d3) captured TWICE, five minutes
// apart. A second confirmation must not mint a second target: two rows for one filing
// poll the same application twice, and the poller would report a filing as both "issued"
// and "waiting" depending on which row was read.
//
// MATCH ORDER (active rows only — a deactivated target is deliberately retired):
//   (a) FILING IDENTITY — same target_type, and any non-empty identifier we carry
//       (application OR permit number) equals any non-empty identifier the row carries.
//       The cross-match matters on real rows: Accela writes the same string into BOTH
//       columns (187-26-000309-STR) while PowerClerk leaves permit_number empty.
//   (b) TRACK IDENTITY — same non-empty permit_type. A project files ONE live building
//       permit at a time; a new number for that track is a correction or a refiling, and
//       the right answer is to update the row rather than leave a sibling polling a dead
//       application forever. (This is exactly what markTrackSubmitted did before the
//       extraction, preserved deliberately.)
//
// What a reuse NEVER touches: last_checked_at, latest_outcome, latest_status_label.
// Nothing was checked, and aging a reading that never happened is the lie
// markCorrectionResubmitted already refuses to tell.
// ---------------------------------------------------------------------------

export interface EnsureCheckTargetInput {
  /** The submittal track, when the caller knows it. Supplies permit_type, target_type
   *  and the portal_name default. Omit it and the caller must say targetType itself. */
  track?: SubmittalTrackType;
  /** Override when there is no track (the operator's add-target form). */
  targetType?: "permit" | "nem";
  /** Override when there is no track. '' is honest — it means "discipline unknown". */
  permitType?: string;
  applicationNumber?: string;
  permitNumber?: string;
  jurisdiction?: string;
  portalName?: string;
  portalUrl?: string;
  trackingUrl?: string;
  notes?: string;
  checkFrequencyDays?: number;
  /** When the poller should first look. Defaults to NOW — a filing just confirmed is due
   *  on the next sweep, not in check_frequency_days' time. The operator's add-target form
   *  passes its own value so that path stays byte-identical to what it did before. */
  nextCheckAt?: string;
}

export interface EnsureCheckTargetResult {
  targetId: string;
  /** False means an existing active target was reused — the caller must not audit a create. */
  created: boolean;
  /** WHICH rule matched, so an operator reading an audit row can tell a filing-number hit
   *  from a track-level one. "none" accompanies created:true. */
  matchedOn: "application_number" | "permit_type" | "none";
}

// RULE 5 AT THE ONE CREATOR. A permit target whose URL is a utility interconnection portal is
// the wrong-system filing bug in waiting: the permit monitor, the correction reopen and the
// knowledge learner all treat a permit target's URL as the AHJ's. Production row 99ea32c3 came
// in through the add-target form; the mark-submitted door (the track card's "Public status URL")
// wrote the same row from a building/electrical/combo track until this guard sat here, where
// every door passes. captureConfirmation passes no URL, so it is never refused.
//
// THE MESSAGE NAMES A CONTROL THAT EXISTS. It used to say "add it as a NEM target (target type:
// NEM)", and nothing on the page lets an operator pick a target type. The place a utility status
// link belongs is the NEM track card's "Public status URL" (captureFields below), saved with
// "Save & track".
export const UTILITY_URL_ON_PERMIT_TARGET_MESSAGE =
  "That URL is a utility interconnection portal, not a permit portal, so it was not saved on a permit. "
  + "Record it on the utility interconnection track card (the card under \"Utility\") instead: open \"I submitted it → capture #\" "
  + `(or "Update numbers / status link"), paste it into "Public status URL" and click "Save & track". `
  + "The permit's tracking target takes the AHJ's permit portal URL.";

export function refuseUtilityUrlOnPermitTarget(targetType: "permit" | "nem", ...urls: Array<string | null | undefined>): void {
  if (targetType === "nem") return;
  if (urls.some((u) => isUtilityPlatformUrl((u || "").trim()))) {
    throw new HttpError(400, UTILITY_URL_ON_PERMIT_TARGET_MESSAGE);
  }
}

export function ensureCheckTarget(
  db: AppDb,
  project: ProjectRecord,
  input: EnsureCheckTargetInput,
): EnsureCheckTargetResult {
  const ts = nowIso();
  const track = input.track;
  const permitType = (input.permitType ?? (track ?? ((input.targetType ?? (track ? targetTypeFor(track) : "permit")) === "nem" ? "nem" : ""))).trim();
  // THE ROW IS BORN WITH ITS KIND — trackKind of what the door said, so `permit_type: 'nem'` with
  // no (or a 'permit') target type is stored as the NEM filing it is. Every reader judges rows by
  // trackKind anyway (older rows and raw writes cannot be trusted); this stops the split shape
  // being written at all through any door (decisions-0926 skeptic MF3).
  const targetType: "permit" | "nem" = trackKind(input.targetType ?? (track ? targetTypeFor(track) : "permit"), permitType);
  const applicationNumber = (input.applicationNumber || "").trim();
  const permitNumber = (input.permitNumber || "").trim();
  const trackingUrl = (input.trackingUrl || "").trim();
  const portalUrl = (input.portalUrl || "").trim();
  refuseUtilityUrlOnPermitTarget(targetType, portalUrl, trackingUrl);

  const candidates = db.query<Row>(
    "SELECT * FROM permit_check_targets WHERE project_id = ? AND active = 1 ORDER BY created_at ASC",
    [project.id],
  );
  const mine = [applicationNumber, permitNumber].filter(Boolean);
  let matchedOn: EnsureCheckTargetResult["matchedOn"] = "none";
  let existing: Row | undefined;
  if (mine.length) {
    existing = candidates.find((row) => {
      if (kindOf(row) !== targetType) return false;
      const theirs = [s(row.application_number).trim(), s(row.permit_number).trim()].filter(Boolean);
      return theirs.some((t) => mine.includes(t));
    });
    if (existing) matchedOn = "application_number";
  }
  if (!existing && permitType) {
    existing = candidates.find((row) => s(row.permit_type).trim() === permitType);
    if (existing) matchedOn = "permit_type";
  }

  if (existing) {
    db.run(
      `UPDATE permit_check_targets
         SET application_number = COALESCE(NULLIF(?, ''), application_number),
             permit_number = COALESCE(NULLIF(?, ''), permit_number),
             tracking_url = COALESCE(NULLIF(?, ''), tracking_url),
             portal_url = COALESCE(NULLIF(?, ''), portal_url),
             updated_at = ?
       WHERE id = ?`,
      [applicationNumber, permitNumber, trackingUrl, portalUrl, ts, s(existing.id)],
    );
    return { targetId: s(existing.id), created: false, matchedOn };
  }

  const frequency = Math.max(1, Math.floor(Number(input.checkFrequencyDays || 7)));
  const targetId = randomUUID();
  db.run(
    `INSERT INTO permit_check_targets
      (id, project_id, jurisdiction, portal_name, portal_url, application_number, permit_number,
       check_frequency_days, active, last_checked_at, next_check_at, latest_outcome, latest_status_label,
       notes, target_type, permit_type, portal_platform, tracking_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, NULL, '', ?, ?, ?, ?, ?, ?, ?)`,
    [
      targetId,
      project.id,
      input.jurisdiction ?? (targetType === "nem" ? project.utility || "" : project.ahj || ""),
      input.portalName ?? (track ? targetPortalName(track, project, db) : ""),
      portalUrl,
      applicationNumber,
      permitNumber,
      frequency,
      input.nextCheckAt ?? ts,
      input.notes ?? "",
      targetType,
      permitType,
      // Auto-detected from the URL, the way the operator's add-target form has always done
      // it, so the status-check strategy is chosen without anyone picking a platform.
      portalUrl ? detectPlatform(portalUrl) : "unknown",
      trackingUrl,
      ts,
      ts,
    ],
  );
  return { targetId, created: true, matchedOn: "none" };
}
