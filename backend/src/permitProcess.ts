// PER-JOB PERMIT PROCESS — the one place the product answers, for ANY AHJ:
//   who issues the permits (the agency), how the work is permitted (one combo permit or a
//   separate structural + electrical pair), which portal and record type each permit files
//   under, which documents each permit needs, and what each permit costs.
//
// Operator steer (2026-09-25): "It needs to look up the right stuff per job." The answers come
// from three layers, strongest first, and every answer says which layer and which source:
//
//   1. the AHJ's OWN evidence (a hand-written profile, the seeded process profile, a person's
//      verified KB row) — read by the existing resolvers, which consult this module only when
//      they have no answer of their own;
//   2. THE PER-JOB LOOKUP (permitProcessLookup.ts): a web-grounded lookup run when a project names
//      an AHJ with no process of its own; each answer carries its source URL and the exact words
//      it rests on, or says NOT FOUND. Stored 'seeded' in permit_process_lookups; a person's
//      'verified' row is never auto-overwritten (hard rule 3);
//   3. CITED STATE RULES (below): a statute or state form that applies to every jurisdiction in
//      the state ("Electrical components of a PV system require an electrical permit" — OAR
//      918-050-0180(2)). Used only when layers 1-2 are silent, and overridable by them.
//
// The resolvers that CONSUME this (submittal tracks, the statewide portal fallback, the
// borrowable-recipe record-type check, documents per track, the fee quote) are pure functions of
// a ProjectRecord with no db handle, so the stored rows are mirrored into an in-process registry
// (loaded at openDatabase, updated by the write path) — the same shape as the process-profile
// cache in processProfiles.ts.
//
// NAME MATCHING IS EXACT (state + normalized AHJ name). A fuzzy bridge is how "City of Jefferson"
// (Marion County area) would inherit "Jefferson County (Madras)" answers — a different place.
import type {
  CitedFact,
  IssuerTrackKey,
  PermitProcessLookup,
  PermitProcessPermitAnswer,
  ProjectRecord,
  TrackIssuerAnswer,
} from "../../shared/src/types";
import type { AppDb } from "./db";
import { sameAgencyName } from "./agencyName";
import { trackIssuersFromSnapshot } from "./normalize";

// ── Keys ────────────────────────────────────────────────────────────────────────────────
/** "City of Jefferson, OR" / "city of  jefferson" → "city of jefferson". A trailing state code
 *  is spelling, not identity. Deliberately NOT a fuzzy alias: see the header. */
export function normalizeAhjName(ahj: string): string {
  return String(ahj ?? "")
    .toLowerCase()
    .replace(/,\s*[a-z]{2}\.?\s*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
export function permitProcessKey(state: string, ahj: string): string {
  return `${String(state ?? "").trim().toLowerCase()}|${normalizeAhjName(ahj)}`;
}

// ── Registry (mirror of permit_process_lookups) ─────────────────────────────────────────
const registry = new Map<string, PermitProcessLookup>();

function rowToLookup(row: Record<string, unknown>): PermitProcessLookup | null {
  try {
    const payload = JSON.parse(String(row.payload_json ?? "{}")) as PermitProcessLookup;
    if (!payload || typeof payload !== "object") return null;
    return {
      ...payload,
      profileKey: String(row.profile_key),
      state: String(row.state ?? payload.state ?? ""),
      ahj: String(row.ahj ?? payload.ahj ?? ""),
      confidence: row.verified_at ? "verified" : "seeded",
      verifiedAt: (row.verified_at as string | null) ?? null,
      verifiedBy: (row.verified_by as string | null) ?? null,
      permits: Array.isArray(payload.permits) ? payload.permits : [],
    };
  } catch {
    return null;
  }
}

export function loadPermitProcessRegistry(db: AppDb): number {
  registry.clear();
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = db.query<Record<string, unknown>>("SELECT * FROM permit_process_lookups");
  } catch {
    return 0;
  }
  for (const row of rows) {
    const rec = rowToLookup(row);
    if (rec) registry.set(rec.profileKey, rec);
  }
  return registry.size;
}

export function getPermitProcessLookup(db: AppDb | null, state: string, ahj: string): PermitProcessLookup | null {
  const key = permitProcessKey(state, ahj);
  if (db) {
    try {
      const row = db.get<Record<string, unknown>>("SELECT * FROM permit_process_lookups WHERE profile_key = ?", [key]);
      const rec = row ? rowToLookup(row) : null;
      if (rec) registry.set(key, rec);
      else registry.delete(key);
      return rec;
    } catch { /* table missing on an old schema — fall through to the registry */ }
  }
  return registry.get(key) ?? null;
}

/** The per-job answer for this project's AHJ, from the registry (no db). */
export function permitProcessFor(project: Pick<ProjectRecord, "state" | "ahj">): PermitProcessLookup | null {
  if (!String(project?.ahj ?? "").trim()) return null;
  return registry.get(permitProcessKey(project.state, project.ahj)) ?? null;
}

export type SavePermitProcessResult = { saved: boolean; reason: string; lookup: PermitProcessLookup | null };

/**
 * THE WRITE PATH. A lookup lands 'seeded'. A row a person VERIFIED is never overwritten by a
 * lookup (hard rule 3) — the lookup is refused with a named reason. `verify` is the person's
 * own act (a route, never a lookup) and stamps verified_at.
 */
export function savePermitProcessLookup(
  db: AppDb,
  input: Omit<PermitProcessLookup, "profileKey" | "confidence"> & { confidence?: "seeded" | "verified" },
  opts: { verifiedBy?: string } = {},
): SavePermitProcessResult {
  const key = permitProcessKey(input.state, input.ahj);
  if (!normalizeAhjName(input.ahj)) return { saved: false, reason: "no AHJ name", lookup: null };
  const existing = db.get<Record<string, unknown>>("SELECT * FROM permit_process_lookups WHERE profile_key = ?", [key]);
  const wantsVerified = input.confidence === "verified" && Boolean(opts.verifiedBy);
  if (existing?.verified_at && !wantsVerified) {
    return { saved: false, reason: "a person verified this AHJ's process; a lookup never overwrites it", lookup: rowToLookup(existing) };
  }
  const now = new Date().toISOString();
  const payload: PermitProcessLookup = {
    ...input,
    profileKey: key,
    confidence: wantsVerified ? "verified" : "seeded",
    lookedUpAt: input.lookedUpAt || now,
  };
  db.run(
    `INSERT INTO permit_process_lookups (profile_key, state, ahj, confidence, payload_json, looked_up_at, updated_at, verified_at, verified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_key) DO UPDATE SET state = excluded.state, ahj = excluded.ahj, confidence = excluded.confidence,
       payload_json = excluded.payload_json, looked_up_at = excluded.looked_up_at, updated_at = excluded.updated_at,
       verified_at = excluded.verified_at, verified_by = excluded.verified_by`,
    [key, input.state, input.ahj, payload.confidence, JSON.stringify(payload), payload.lookedUpAt, now,
      wantsVerified ? now : null, wantsVerified ? String(opts.verifiedBy) : null],
  );
  const saved = rowToLookup(db.get<Record<string, unknown>>("SELECT * FROM permit_process_lookups WHERE profile_key = ?", [key])!);
  if (saved) registry.set(key, saved);
  return { saved: true, reason: payload.confidence, lookup: saved };
}

// ── Cited state rules (layer 3) ──────────────────────────────────────────────────────────
// Each is a fact about EVERY jurisdiction in the state, with the rule/form it comes from and the
// words it says. Add a state by adding its facts here — never a jurisdiction.
export interface StatePermitRules {
  /** Separate structural + electrical permits for a PV system. */
  permitStructure?: CitedFact<"separate" | "combo">;
  /** The shared statewide permit portal many jurisdictions subscribe to. */
  statewidePortal?: CitedFact<string>;
  /** How a prescriptive-path PV structural permit is priced. */
  prescriptiveFeeBasis?: CitedFact<string>;
  /** The electrical renewable-energy fee tiers (kVA). */
  electricalRenewableTiers?: CitedFact<Array<{ maxKva: number; amountUsd: number; label: string }>>;
  /** State surcharge on permit fees (fraction), when the state sets a maximum. */
  surcharge?: CitedFact<number>;
  /** Portal application-info vocabulary guidance (Category of Construction / Type of Work). */
  applicationInfoGuidance?: CitedFact<{ categoryOfConstruction: "structure_type"; typeOfWorkExisting: string; solarIsNotOther: boolean }>;
  /** A state PV worksheet the electrical inspection asks for (Iowa: the SFM Electrical Bureau
   *  PHOTOVOLTAIC WORKSHEET). `requiredAt` = normalized AHJ names whose own application REQUIRES
   *  it as an attachment (observed); elsewhere in the state it is advisory. */
  pvWorksheet?: CitedFact<{ formName: string; requiredAt: string[] }>;
}

const IOWA_CITY_ENERGOV = "https://energovapp.civic.iowa-city.org/energovprod/";

const OAR_918_050_0180 = "https://secure.sos.state.or.us/oard/view.action?ruleNumber=918-050-0180";
const BCD_5952 = "https://www.oregon.gov/bcd/Formslibrary/5952.pdf";
const BCD_EPERMITTING_SOLAR = "https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx";
const OAR_918_309_0070 = "https://secure.sos.state.or.us/oard/view.action?ruleNumber=918-309-0070";

export const STATE_PERMIT_RULES: Record<string, StatePermitRules> = {
  OR: {
    permitStructure: {
      value: "separate",
      sourceUrl: OAR_918_050_0180,
      quote: "(2) Electrical components of a PV system require an electrical permit … OAR 918-309-0020 through 918-309-0070. (BCD 440-5952: \"Separate electrical permits are required\")",
      origin: "state_rule",
    },
    statewidePortal: {
      value: "https://aca-oregon.accela.com/oregon/",
      sourceUrl: "https://aca-oregon.accela.com/oregon/",
      quote: "Oregon ePermitting — one Accela Citizen Access instance for every subscribing Oregon jurisdiction (the jurisdiction is chosen from the work-location address).",
      origin: "state_rule",
    },
    prescriptiveFeeBasis: {
      value: "flat",
      sourceUrl: OAR_918_050_0180,
      quote: "(1)(a) Fees for installations that comply with the prescriptive installation path … shall be a flat fee and includes one inspection and permit review",
      origin: "state_rule",
    },
    electricalRenewableTiers: {
      value: [
        { maxKva: 5, amountUsd: 79, label: "5 KVA or less" },
        { maxKva: 15, amountUsd: 94, label: "5.01 KVA to 15 KVA" },
        { maxKva: 25, amountUsd: 156, label: "15.01 KVA to 25 KVA" },
      ],
      sourceUrl: OAR_918_309_0070,
      quote: "(11)(a) (A) 5 KVA or less: $79; (B) 5.01 KVA to 15 KVA: $94; (C) 15.01 KVA to 25 KVA: $156",
      origin: "state_rule",
    },
    surcharge: {
      value: 0.12,
      sourceUrl: "https://oregon.public.law/statutes/ors_455.210",
      quote: "ORS 455.210(4) + 455.220(1): state surcharge on permit fees, at most 12%",
      origin: "state_rule",
    },
    applicationInfoGuidance: {
      value: { categoryOfConstruction: "structure_type", typeOfWorkExisting: "Alteration", solarIsNotOther: true },
      sourceUrl: BCD_EPERMITTING_SOLAR,
      quote: "Category of Construction (CoC) would be the structure type the system is being installed to … if the structure already exists, Type of Work = Alteration … Solar is not considered 'Other' under CoC or under ToW.",
      origin: "state_rule",
    },
  },
};
// IOWA. The State Fire Marshal Electrical Bureau's PV worksheet: its page 1 says it "has been
// provided for the installer to complete and submit to their electrical inspector prior to the
// inspection date". Iowa City's EnerGov "Residential Electrical - Solar" application makes it a
// REQUIRED attachment card (operator walk-through of the portal, 2026-09-26 — the city's web page
// says it is not submitted; the portal wins). The SFM's own download URL was not retrieved, so the
// source is the portal that asks for it.
STATE_PERMIT_RULES.IA = {
  pvWorksheet: {
    value: { formName: "Iowa SFM Electrical Bureau Photovoltaic Worksheet (2020 NEC)", requiredAt: ["iowa city", "city of iowa city"] },
    sourceUrl: IOWA_CITY_ENERGOV,
    quote: "Attachments — REQUIRED: \"Standard or Micro-Inverter Array ...\" (.pdf,.docx) [Iowa City EnerGov, Residential Electrical - Solar]; worksheet p.1: \"provided for the installer to complete and submit to their electrical inspector prior to the inspection date\"",
    origin: "operator",
  },
};
export const BCD_5952_URL = BCD_5952;

export function stateRulesFor(state: string | null | undefined): StatePermitRules {
  return STATE_PERMIT_RULES[String(state ?? "").trim().toUpperCase()] ?? {};
}

// ── R5 vocabulary BY MEANING ─────────────────────────────────────────────────────────────
// The guidance says Category of Construction = the STRUCTURE TYPE (BCD: "the structure type the
// system is being installed to"). Each agency prints that type in its own words: Coos Bay's list
// says "1-1 or 2 Family Dwelling", Marion County's says "Single Family Dwelling" (with "Two Family
// Dwelling", "Manufactured Dwelling", "Townhouses", "Small Home", "Detached Accessory Structure"
// beside it). Live run 99baa5d0 (2026-09-27): the replay binding rewrote the borrowed step to Coos
// Bay's wording, Marion's select "landed nothing though 8 option(s) were showing", and an LLM
// gap-fill (14 s, 939 tokens) picked Single Family Dwelling. The MEANING is what the two lists
// share; this names it so the adapter can land the select without the LLM — and never on a
// neighbour that merely shares a word ("Two Family Dwelling", "Manufactured Dwelling").
export type StructureTypeMeaning =
  | "single_family"      // a one- or two-family dwelling: the roof a residential PV system goes on
  | "two_family"         // a duplex named on its own (not the one-or-two-family option)
  | "manufactured"       // manufactured / mobile / modular dwelling
  | "townhouse"
  | "accessory"          // detached accessory structure, garage, shed, ADU
  | "small_home"         // Oregon's small home / tiny home category
  | "multi_family"
  | "commercial"
  | "other";

/** The structure type an option's (or a recorded value's) wording means, or null when it names no
 *  structure type at all ("--Select--", "Other"). Exclusions are read first: "Manufactured
 *  Dwelling" and "Two Family Dwelling" both contain "dwelling", and "Townhouses" is residential —
 *  none of them is a single-family roof. */
export function structureTypeMeaning(text: string): StructureTypeMeaning | null {
  const t = String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!t || /^-*\s*select\s*-*$/.test(t) || /^please select/.test(t) || /^other$/.test(t)) return null;
  if (/manufactured|mobile home|modular|\bmfg\b/.test(t)) return "manufactured";
  if (/town ?house|town ?home|row ?house/.test(t)) return "townhouse";
  if (/accessory|detached (garage|shed|structure|building)|\badu\b|\bgarage\b|\bshed\b|carport/.test(t)) return "accessory";
  if (/small home|tiny (home|house)/.test(t)) return "small_home";
  if (/multi[- ]?family|apartment|condominium|\bcondo\b|three or more|3\+? (or more )?famil|\bmulti[- ]?unit/.test(t)) return "multi_family";
  if (/commercial|industrial|\bmixed[- ]use\b|non[- ]?residential/.test(t)) return "commercial";
  // The one-or-two-family option: "1-1 or 2 Family Dwelling", "One and Two Family", "1 & 2 Family",
  // "Residential - 1 & 2 Family", "Single Family Dwelling", "Single-Family Residence", "SFD", "SFR".
  if (/\bsingle[- ]?family\b|\bsingle[- ]dwelling\b|\bsfd\b|\bsfr\b|\bone[- ]family\b/.test(t)) return "single_family";
  if (/\b(1|one)\b[^a-z0-9]{0,6}(and|&|or|\/|-|,)[^a-z0-9]{0,4}\b(2|two)\b[^a-z]{0,4}family/.test(t)) return "single_family";
  if (/\b(2|two)[- ]family\b|\bduplex\b/.test(t)) return "two_family";
  if (/\bresidential\b|\bdwelling\b|\bhouse\b|\bhome\b/.test(t)) return "other";
  return null;
}

// ── Consumers' questions ─────────────────────────────────────────────────────────────────
const answered = <T>(f: CitedFact<T> | null | undefined): f is CitedFact<T> & { value: T } =>
  Boolean(f) && f!.value !== null && f!.value !== undefined && !(typeof f!.value === "string" && !String(f!.value).trim());

/** Layer 2 then layer 3: the permit structure and the fact it rests on. null = nobody knows. */
export function lookedUpPermitStructure(project: Pick<ProjectRecord, "state" | "ahj">): CitedFact<"separate" | "combo"> | null {
  const lk = permitProcessFor(project);
  if (lk && answered(lk.permitStructure)) return lk.permitStructure;
  return null;
}
export function statePermitStructure(project: Pick<ProjectRecord, "state">): CitedFact<"separate" | "combo"> | null {
  const rule = stateRulesFor(project.state).permitStructure;
  return answered(rule) ? rule : null;
}

/** A project, or the track-scoped view of one (projectForTrack), as the issuer questions read it. */
export type IssuerProject = Pick<ProjectRecord, "state" | "ahj"> & Partial<Pick<ProjectRecord, "trackIssuers" | "parserSnapshot" | "trackView">>;

/** Which of the lookup's permits a submittal track files.
 *
 *  ON A TRACK VIEW (projectForTrack — ahj is the track's issuer) the project's OWN lookup still
 *  answers about this permit when its cited agency IS that issuer: City of Jefferson's lookup cites
 *  "Marion County" for both permits, with the record type and portal it found, and there is no
 *  lookup keyed on Marion County itself — without this the view would lose every cited answer the
 *  per-job lookup found for this job. Otherwise the issuer's own lookup answers. */
export function permitAnswerForTrack(project: Pick<ProjectRecord, "state" | "ahj"> & Partial<Pick<ProjectRecord, "trackView">>, track: string | null | undefined): PermitProcessPermitAnswer | null {
  const want = track === "building" ? "structural" : track === "electrical" || track === "mpu" ? "electrical" : track === "combo" || track === "permit" ? "combo" : "";
  if (!want) return null;
  const view = project.trackView;
  if (view && String(view.projectAhj ?? "").trim()) {
    const base = permitProcessFor({ state: project.state, ahj: view.projectAhj });
    const fromBase = base?.permits?.find((p) => p.discipline === want) ?? null;
    if (fromBase && answered(fromBase.issuingAgency) && sameAgencyName(fromBase.issuingAgency.value, project.ahj)) return fromBase;
  }
  const lk = permitProcessFor(project);
  if (!lk?.permits?.length) return null;
  return lk.permits.find((p) => p.discipline === want) ?? null;
}

/** The agency that issues this track's permit: the OPERATOR's per-track issuer (trackIssuer's first
 *  layer — the same value, the same refusals), else the permit's own looked-up answer, else the
 *  AHJ-wide one. Forms (applicationDocsAgency.formAuthorityFor) and the replay's agency binding read
 *  this, so they follow the issuer staging files with. */
export function issuingAgencyFor(project: IssuerProject, track: string | null | undefined): CitedFact<string> | null {
  const op = operatorIssuerFact(project, track);
  if (op) return op;
  return lookedUpIssuingAgency(project, track);
}

/** issuingAgencyFor without the operator layer: the per-job lookup's answer only. */
function lookedUpIssuingAgency(project: IssuerProject, track: string | null | undefined): CitedFact<string> | null {
  const p = permitAnswerForTrack(project, track);
  if (p && answered(p.issuingAgency)) return p.issuingAgency;
  const lk = permitProcessFor(project);
  if (lk && answered(lk.issuingAgency)) return lk.issuingAgency;
  // ON A TRACK VIEW the project's own lookup's AHJ-wide agency still answers when it IS this issuer
  // ("Marion County issues permits for the City of Jefferson" — no lookup is keyed on the county).
  const view = project.trackView;
  if (view && String(view.projectAhj ?? "").trim()) {
    const base = permitProcessFor({ state: project.state, ahj: view.projectAhj });
    if (base && answered(base.issuingAgency) && sameAgencyName(base.issuingAgency.value, project.ahj)) return base.issuingAgency;
  }
  return null;
}

// ── WHO ISSUES THIS TRACK'S PERMIT (split issuer, operator fact 2026-09-28) ─────────────────
// "Electrical permit issued through Yamhill; Building permit issued through Newberg": an Oregon city
// can run its own building program on its own portal (OpenGov) while the county issues the
// electrical permit on Oregon ePermitting. Every permit-track door used to key on project.ahj, so
// whichever agency the project named, one of the two permits staged on the other agency's portal
// (and the right one was refused as a foreign entity). ONE answer per track, then ONE track-scoped
// view of the project that every door reads (projectForTrack). A GENERAL capability — many Oregon
// cities run a building program while the county or the state issues electrical — never a patch
// for one city.

/** The issuer key a track reads. building/structural → building; electrical; combo/permit → combo;
 *  mpu. null for the NEM track, a trackless (legacy combined) stage and anything else: a utility
 *  files NEM, and a trackless stage keeps the project AHJ. */
export function issuerTrackKey(track: string | null | undefined): IssuerTrackKey | null {
  const t = String(track ?? "").trim().toLowerCase();
  if (t === "building" || t === "structural") return "building";
  if (t === "electrical") return "electrical";
  if (t === "combo" || t === "permit") return "combo";
  if (t === "mpu") return "mpu";
  return null;
}

const STATE_NAME_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};
const STATE_CODES = new Set(Object.values(STATE_NAME_CODES));

/** The state an agency name SAYS it is in — only in a comma or parenthesis form ("Clark County, WA",
 *  "City of Vancouver, Washington", "Clark County (WA)"). A bare trailing word is never read: "Yamhill
 *  Co" is a county, not Colorado, and "Washington County" is an Oregon county. null = says none. */
export function agencyNameState(name: string | null | undefined): string | null {
  const s = String(name ?? "").trim();
  const m = /,\s*([A-Za-z][A-Za-z .]*?)\.?\s*$/.exec(s) ?? /\(\s*([A-Za-z][A-Za-z .]*?)\.?\s*\)\s*$/.exec(s);
  if (!m) return null;
  const token = m[1].replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (/^[A-Za-z]{2}$/.test(token) && STATE_CODES.has(token.toUpperCase())) return token.toUpperCase();
  return STATE_NAME_CODES[token.toLowerCase()] ?? null;
}

/** Why an operator's issuer value cannot be honoured on a project in `projectState`, or null when it
 *  can. The one refusal the write path (updateProject → 400) and the read path (trackIssuer →
 *  `refused`) share: a permit is never issued across a state line, so a value naming another state
 *  would only ever resolve that state's portal. */
export function refuseTrackIssuerValue(value: string | null | undefined, projectState: string | null | undefined): string | null {
  const v = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!v) return null;
  if (v.length > 120) return "it is longer than an agency name (120 characters at most)";
  if (/https?:\/\/|\bwww\./i.test(v)) return "it is a web address — name the agency (e.g. \"City of Newberg\"), not its portal";
  const named = agencyNameState(v);
  const own = String(projectState ?? "").trim().toUpperCase();
  if (named && own && named !== own) return `it names an agency in ${named}, and this project is in ${own} — a permit is never issued across a state line`;
  return null;
}

/** The operator's value on file for this track ("" when none). MPU follows electrical unless its own
 *  is set. Reads the mapped record field, else the raw snapshot keys (a Pick<> caller's record). */
export function operatorTrackIssuerValue(project: IssuerProject, track: string | null | undefined): string {
  const key = issuerTrackKey(track);
  if (!key) return "";
  const issuers = project.trackIssuers ?? trackIssuersFromSnapshot(project.parserSnapshot) ?? {};
  const own = String(issuers[key] ?? "").trim();
  if (own) return own;
  return key === "mpu" ? String(issuers.electrical ?? "").trim() : "";
}

/** The operator's per-track issuer as a CitedFact (origin "operator"), when it may be honoured. */
function operatorIssuerFact(project: IssuerProject, track: string | null | undefined): CitedFact<string> | null {
  const value = operatorTrackIssuerValue(project, track);
  if (!value || refuseTrackIssuerValue(value, project.state)) return null;
  return {
    value,
    sourceUrl: "",
    quote: `Set by an operator on this project for the ${issuerTrackKey(track)} permit`,
    origin: "operator",
  };
}

/** THE CITED BAR a LOOKED-UP issuing agency must clear before anything follows it (forms —
 *  applicationDocsAgency.formAuthorityFor — and staging — trackIssuer): a person verified the lookup,
 *  or the answer carries the http page it was read from. An uncited lookup value is a guess and
 *  changes nothing. (The operator's own issuer is a person's statement, read first by both callers.) */
export function citedAgencyAnswer(f: CitedFact<string> | null | undefined, lookupVerified: boolean): f is CitedFact<string> {
  if (!f || typeof f.value !== "string" || !f.value.trim()) return false;
  return lookupVerified || /^https?:\/\//i.test(String(f.sourceUrl ?? ""));
}

/** A project with its view marker removed (the project AHJ put back). */
function baseOfView<T extends IssuerProject>(project: T): T {
  const view = project.trackView;
  if (!view) return project;
  const { trackView: _view, ...rest } = project;
  const ahj = String(view.projectAhj ?? "");
  const snap = rest.parserSnapshot && typeof rest.parserSnapshot === "object" && "ahj" in rest.parserSnapshot
    ? { ...rest.parserSnapshot, ahj }
    : rest.parserSnapshot;
  return { ...rest, ahj, ...(snap !== undefined ? { parserSnapshot: snap } : {}) } as T;
}

/**
 * THE ONE ANSWER to "which agency issues THIS track's permit", strongest first:
 *   a. the OPERATOR's per-track issuer on the project (ProjectRecord.trackIssuers; MPU follows
 *      electrical) — unless it names another state (refused, and said so);
 *   b. the per-job lookup's issuing agency for this permit (issuingAgencyFor's lookup chain: the
 *      permit's own answer, else the AHJ-wide one) when it clears the cited bar AND names another
 *      agency than the project AHJ (sameAgencyName — "City of Salem Permit Center" is Salem, a
 *      department suffix never re-keys a project);
 *   c. the project AHJ.
 * NEM, a trackless stage and an unknown track are always (c): the NEM track never reads it.
 */
export function trackIssuer(project: IssuerProject, track: string | null | undefined): TrackIssuerAnswer {
  const key = issuerTrackKey(track);
  const view = project.trackView;
  // A view already names its issuer (for its own track).
  if (view && key && issuerTrackKey(view.track) === key) {
    return { name: String(project.ahj ?? "").trim(), source: view.source, override: operatorTrackIssuerValue(project, track) };
  }
  const base = baseOfView(project);
  const ahj = String(base.ahj ?? "").trim();
  if (!key) return { name: ahj, source: "project", override: "" };
  const override = operatorTrackIssuerValue(base, key);
  let refused: string | undefined;
  if (override) {
    const why = refuseTrackIssuerValue(override, base.state);
    if (!why) return { name: override, source: "operator", override };
    refused = `"${override}" was not used: ${why}`;
  }
  const looked = lookedUpIssuingAgency(base, key);
  const verified = permitProcessFor(base)?.confidence === "verified";
  if (ahj && looked && citedAgencyAnswer(looked, verified) && !sameAgencyName(looked.value, ahj)) {
    return {
      name: String(looked.value).trim(), source: "lookup", sourceUrl: looked.sourceUrl, quote: looked.quote,
      override, ...(refused ? { refused } : {}),
    };
  }
  return { name: ahj, source: "project", override, ...(refused ? { refused } : {}) };
}

/**
 * THE TRACK-SCOPED VIEW every permit-track door reads: the project itself — the SAME object — when
 * this track's issuer is the project AHJ (the overwhelming case: nothing changes), else a copy whose
 * `ahj` (and snapshot `ahj`) is the issuer, marked with `trackView` so the lookup's cited answer
 * still reaches it and a view of a view is itself. Recipe keys, KB rows, the learned profile, the
 * entity the host predicate judges (portalChannel.hostFitsTrackAndEntity — still the one door; the
 * entity it judges is the track's issuer), the borrow, the field values, the learn's recipe key and
 * the tracking target all read this. NEVER persisted. NEM / trackless → the project.
 */
export function projectForTrack<T extends IssuerProject>(project: T, track: string | null | undefined): T {
  const key = issuerTrackKey(track);
  if (!key) return project;
  if (project.trackView && issuerTrackKey(project.trackView.track) === key) return project;
  const base = baseOfView(project);
  const issuer = trackIssuer(base, key);
  const ahj = String(base.ahj ?? "");
  if (issuer.source === "project" || !issuer.name || sameAgencyName(issuer.name, ahj) || normalizeAhjName(issuer.name) === normalizeAhjName(ahj)) return base;
  const snap = base.parserSnapshot && typeof base.parserSnapshot === "object" && "ahj" in base.parserSnapshot
    ? { ...base.parserSnapshot, ahj: issuer.name }
    : base.parserSnapshot;
  return {
    ...base,
    ahj: issuer.name,
    ...(snap !== undefined ? { parserSnapshot: snap } : {}),
    trackView: { track: key, projectAhj: ahj, source: issuer.source },
  } as T;
}

/** The record type the lookup found for this track's permit. */
export function lookedUpRecordType(project: Pick<ProjectRecord, "state" | "ahj">, track: string | null | undefined): CitedFact<string> | null {
  const p = permitAnswerForTrack(project, track);
  return p && answered(p.recordType) ? p.recordType : null;
}

/** "Residential - Structural" ≈ "Residential Structural" ≈ "residential structural permit". */
export function sameRecordType(a: string, b: string): boolean {
  const norm = (s: string) => String(s ?? "").toLowerCase().replace(/\bpermits?\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  return Boolean(x) && x === y;
}

/**
 * THE STATEWIDE PORTAL, when it applies to this AHJ's permit track — and on what basis:
 *   - the lookup found this AHJ's permits filed on it → "lookup";
 *   - the lookup found a DIFFERENT portal for this AHJ → null (the AHJ's own evidence wins);
 *   - no portal answer at all → the cited state rule ("state_rule"), the acceptable degraded path.
 * The caller still judges the URL through hostFitsTrackAndEntity (a person's verified portal for
 * the AHJ outranks both).
 */
export function statewidePortalFor(
  project: Pick<ProjectRecord, "state" | "ahj">,
  track: string | null | undefined,
  opts: { processProfileMethod?: string | null } = {},
): { url: string; basis: CitedFact<string> } | null {
  const rule = stateRulesFor(project.state).statewidePortal;
  if (!answered(rule)) return null;
  const ruleHost = hostOf(rule.value);
  const permit = permitAnswerForTrack(project, track);
  const lk = permitProcessFor(project);
  const found = [permit?.portalUrl, ...(lk?.permits ?? []).map((p) => p.portalUrl)].find((f) => answered(f));
  if (found) {
    return hostOf(found.value!) === ruleHost ? { url: rule.value, basis: found } : null;
  }
  // A seeded process profile that names a different submission method is the AHJ's own evidence.
  const method = String(opts.processProfileMethod ?? "").toLowerCase();
  if (method && !/e.?permitting|accela/.test(method) && /portal|projectdox|energov|opengov|email|in.?person|mygov|citizenserve|iworq/.test(method)) {
    return null;
  }
  return { url: rule.value, basis: rule };
}

function hostOf(url: string): string {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** One line an operator reads: the answer and where it came from. */
export function describeCited(label: string, fact: CitedFact<unknown> | null | undefined): string {
  if (!fact) return `${label}: not looked up`;
  if (fact.value === null || fact.value === undefined) return `${label}: NOT FOUND${fact.notFound ? ` (${fact.notFound})` : ""}`;
  const v = Array.isArray(fact.value) ? (fact.value as unknown[]).join(", ") : typeof fact.value === "object" ? JSON.stringify(fact.value) : String(fact.value);
  const origin = fact.origin === "state_rule" ? "state rule" : fact.origin === "lookup" ? "per-job lookup (seeded)" : fact.origin;
  return `${label}: ${v} — ${origin}${fact.sourceUrl ? `, ${fact.sourceUrl}` : ""}${fact.quote ? ` ("${fact.quote.slice(0, 160)}")` : ""}`;
}
