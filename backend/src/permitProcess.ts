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
import { namedKnownUtility, UTILITY_IDENTITY_LABEL } from "./utilityIdentity";
import { hostAliasesOf } from "./portalCredentials";
import { structureType } from "./codeReviewRules";

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
/** The DISTINCTIVE core of a jurisdiction's name, run together ("City of Corvallis" -> "corvallis",
 *  "Marion County" -> "marion"): what a shared instance's tenant ("aca-prod.accela.com/CORVALLIS")
 *  or a landing page's title carries when it is that jurisdiction's own. */
export function ahjNameCore(ahj: string): string {
  return normalizeAhjName(ahj).replace(/\b(?:city|town|village|county|borough|township|parish|of|the|unincorporated)\b/g, " ").replace(/\s+/g, "").trim();
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
  /** Its name, as a label reads it ("Oregon ePermitting"). */
  statewidePortalName?: string;
  /** Its channel label with the platform ("Oregon ePermitting (Accela)") — given ONLY to a resolved
   *  URL on the statewide host (permitChannelLabel). */
  statewidePortalLabel?: string;
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
  /** A STATE agency issues the building + electrical permits wherever the local jurisdiction has no
   *  building department of its own (New Mexico CID); the local office only reviews zoning / the
   *  site plan first. `served` = names (localAhjName) of the jurisdictions a source says the state
   *  serves — an AHJ not on it keeps its own answer (unknown stays unknown); `manufactured` = the agency for a manufactured home instead; `localStep` = the cited
   *  words for the local review. Seeded (a state rule), never verified. */
  stateTradeIssuer?: CitedFact<string> & {
    served: string[];
    manufactured: CitedFact<string>;
    localStep: { sourceUrl: string; quote: string };
    /** THE STATE ISSUER'S OWN APPLICATION (issue #53): ONE form for every track in `covers` (CID files
     *  the building and electrical permits on one application), looked for on the ISSUER's site
     *  (`searchUrl`), never the AHJ's. `url` is "" until a person confirms the PDF on the state site —
     *  never guessed; `notFound` says why. Seeded (a state rule), never verified. */
    issuerForm?: CitedFact<string> & { formName: string; covers: Array<"building" | "electrical">; searchUrl: string; url: string; notFound: string };
  };
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
    statewidePortalName: "Oregon ePermitting",
    statewidePortalLabel: "Oregon ePermitting (Accela)",
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
// NEW MEXICO (issue #32, owner's Los Lunas test 2026-10-02). The Construction Industries Division
// is the building official for every jurisdiction that has not taken on its own building program:
// there the Village / County does zoning-compliance / site-development review only, and the
// building + electrical permits are pulled from CID (a manufactured home's from the Manufactured
// Housing Division). Applied ONLY to the jurisdictions a source names as CID-served (the issue, and
// the operator's NM reference rows: "Apply electrical permits here for: Los Lunas, Valencia County…
// and Rio Communities", Bosque Farms "Email submissions through NM CID", Tyrone "Pull permits … through
// NM CID") — never guessed for an AHJ nothing names, which keeps its own (or the per-job lookup's)
// answer; full-service cities (Albuquerque, Rio Rancho, Las Cruces, Santa Fe, Bernalillo County…) are
// simply not on it. Mixed rows (Belen, Grant County, Santa Fe County: one permit at CID, the other
// local) are left to their own answers. SEEDED; a cited lookup, a person's verified row or the
// operator's per-track issuer outranks it.
STATE_PERMIT_RULES.NM = {
  stateTradeIssuer: {
    value: "New Mexico Construction Industries Division (CID)",
    sourceUrl: "https://www.rld.nm.gov/construction-industries/",
    quote: "Valencia County Multi-Purpose Permit Application: \"Prior to any construction, you are responsible for taking all plans and documents to Construction Industries Department (CID) in Albuquerque to obtain building inspection permit… CID will be responsible for all inspections and final occupancy certificate.\"",
    origin: "state_rule",
    served: ["los lunas", "valencia county", "rio communities", "bosque farms", "tyrone"],
    manufactured: {
      value: "New Mexico Manufactured Housing Division (MHD)",
      sourceUrl: "https://www.rld.nm.gov/manufactured-housing/",
      quote: "Roof-mount PV on a manufactured home is permitted by the Manufactured Housing Division (MHD), not CID (issue #32, owner's NM research)",
      origin: "state_rule",
    },
    localStep: {
      sourceUrl: "https://loslunasnm.gov/995/Building-Permits",
      quote: "Village of Los Lunas Planning Division / Valencia County Community Development: zoning compliance and site-development review on a site plan; the building and electrical permits come from CID",
    },
    // CID's permit application. Its public PDF could not be confirmed on rld.nm.gov (2026-10-03: the
    // "Apply for a Permit" page links only to CID's online permit system and its forms listing is
    // rendered by script), so NO URL is stored — the form finder says so instead of guessing one.
    issuerForm: {
      value: "New Mexico Construction Industries Division (CID) permit application",
      formName: "Permit Application (one application for the building and electrical permits)",
      covers: ["building", "electrical"],
      sourceUrl: "https://www.rld.nm.gov/construction-industries/apply-for-a-permit/",
      searchUrl: "https://www.rld.nm.gov/construction-industries/apply-for-a-permit/",
      quote: "Construction Industries: Apply for a Permit — the building and the electrical permit are CID's; one application covers both (issue #53, owner's NM research)",
      origin: "state_rule",
      url: "",
      notFound: "CID form URL not confirmed: rld.nm.gov names no downloadable permit application PDF (its permit page links to CID's online permit system)",
    },
  },
};
export const BCD_5952_URL = BCD_5952;

/** "City of Albuquerque" / "Albuquerque, NM" → "albuquerque"; a county keeps its "county". */
function localAhjName(ahj: string): string {
  return normalizeAhjName(ahj).replace(/^(?:the )?(?:city|town|village) of /, "").replace(/ (?:city|town|village)$/, "").trim();
}

/** THE STATE AGENCY that issues this project's building + electrical permits, when its state says
 *  one does (New Mexico: CID, or MHD for a manufactured home — codeReviewRules.structureType, the one
 *  manufactured-home predicate) and the AHJ is one a source names as state-served. `localReviewer`
 *  is the AHJ whose zoning / site review comes first. null = no source says so (or no rule). */
export function stateTradeIssuerFor(project: IssuerProject): (CitedFact<string> & { value: string; localReviewer: string; manufactured: boolean }) | null {
  const base = baseOfView(project);
  const rule = stateRulesFor(base.state).stateTradeIssuer;
  const ahj = String(base.ahj ?? "").trim();
  if (!rule || !ahj) return null;
  const local = localAhjName(ahj);
  // The project names the state office itself ("NM CID") — there is no local step to add.
  if (!local || /\bcid\b|\bmhd\b|construction industries|manufactured housing/.test(local)) return null;
  if (!rule.served.includes(local)) return null;
  const manufactured = structureType({ parserSnapshot: base.parserSnapshot ?? {} } as unknown as ProjectRecord).kind === "manufactured_home";
  const fact = manufactured ? rule.manufactured : rule;
  return { value: String(fact.value), sourceUrl: fact.sourceUrl, quote: fact.quote, origin: fact.origin, localReviewer: ahj, manufactured };
}

/** THE STATE ISSUER'S ONE APPLICATION for this project (issue #53): the state rule's issuerForm,
 *  for the tracks the state agency actually issues here (trackIssuer — an operator's own per-track
 *  issuer keeps that track off it). null = no state issuer, a manufactured home (MHD: no form on
 *  file), or no form declared. */
export function stateIssuerFormFor(project: IssuerProject): (NonNullable<NonNullable<StatePermitRules["stateTradeIssuer"]>["issuerForm"]> & { agency: string; localReviewer: string; tracks: Array<"building" | "electrical"> }) | null {
  const st = stateTradeIssuerFor(project);
  if (!st || st.manufactured) return null;
  const form = stateRulesFor(baseOfView(project).state).stateTradeIssuer?.issuerForm;
  if (!form) return null;
  const tracks = form.covers.filter((t) => sameAgencyName(trackIssuer(project, t).name, st.value));
  return tracks.length ? { ...form, agency: st.value, localReviewer: st.localReviewer, tracks } : null;
}

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
  return lookedUpIssuingAgency(project, track) ?? stateIssuerFact(project, track);
}

/** The cited state rule's issuer for a permit track (stateTradeIssuerFor), as a plain CitedFact. */
function stateIssuerFact(project: IssuerProject, track: string | null | undefined): CitedFact<string> | null {
  if (!issuerTrackKey(track)) return null;
  const st = stateTradeIssuerFor(project);
  return st ? { value: st.value, sourceUrl: st.sourceUrl, quote: st.quote, origin: st.origin } : null;
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
 *  would only ever resolve that state's portal; and a UTILITY never issues a permit — its name
 *  fuzzy-resolves some city's portal ("Portland General Electric" → City of Portland's DevHub), so a
 *  known utility's name (utilityIdentity.namedKnownUtility, the shared identity) is refused too. */
export function refuseTrackIssuerValue(value: string | null | undefined, projectState: string | null | undefined): string | null {
  const v = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!v) return null;
  if (v.length > 120) return "it is longer than an agency name (120 characters at most)";
  if (/https?:\/\/|\bwww\./i.test(v)) return "it is a web address — name the agency (e.g. \"City of Newberg\"), not its portal";
  const utility = namedKnownUtility(projectState, v);
  if (utility) return `it names a utility (${UTILITY_IDENTITY_LABEL[utility]}) — a utility takes the interconnection application and never issues a permit; name the city or county that issues this permit (e.g. "Yamhill County")`;
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
 *      department suffix never re-keys a project) AND is not a known utility's name;
 *   c. a cited STATE rule naming a state issuer for this AHJ (stateTradeIssuerFor: New Mexico CID,
 *      or MHD for a manufactured home, where the AHJ has no building department);
 *   d. the project AHJ.
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
  // A looked-up "issuer" that is a known UTILITY is a misread, never an issuer: it would re-key the
  // track on the utility's name, which fuzzy-resolves some city's portal (the same refusal the
  // operator's value gets — namedKnownUtility, the one identity).
  if (ahj && looked && citedAgencyAnswer(looked, verified) && !sameAgencyName(looked.value, ahj) && !namedKnownUtility(base.state, looked.value)) {
    return {
      name: String(looked.value).trim(), source: "lookup", sourceUrl: looked.sourceUrl, quote: looked.quote,
      override, ...(refused ? { refused } : {}),
    };
  }
  const st = ahj ? stateTradeIssuerFor(base) : null;
  if (st) return { name: st.value, source: "state_rule", sourceUrl: st.sourceUrl, quote: st.quote, override, ...(refused ? { refused } : {}) };
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
    trackView: { track: key, projectAhj: ahj, source: issuer.source as "operator" | "lookup" | "state_rule" },
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

// ── THE STATEWIDE PORTAL — ONLY WHERE THE EVIDENCE SAYS THIS AHJ FILES THERE (portal-truth D1) ──
// A real filing (City of Corvallis OR, 2026-09-28) went to Oregon ePermitting although the per-job
// lookup had NAMED the city's own portal ("Apply online at www.corvallispermits.com", which lands on
// the city's own Accela tenant) and dropped it for want of attestation. With no portal kept, the
// fallback answered "the cited state rule" — i.e. an UNKNOWN read as "files on the statewide
// portal" — and the statewide instance then said "No Building services were returned for this
// address". The rule is now the evidence's, both ways:
//   - ANY source saying the AHJ files ELSEWHERE — a portal the lookup named for this permit (kept
//     OR NOT), a knowledge-base row / recipe / stored login naming another portal or the AHJ's own
//     tenant, a seeded / hand-written process naming another system, the statewide portal itself
//     having said the address is not served there — withholds the fallback;
//   - otherwise it is taken ONLY when a source says the AHJ (or the agency issuing this permit)
//     files ON the statewide portal (Jefferson / Marion County: a seeded "OR E-permitting", a
//     knowledge-base row or recipe on the statewide host, a lookup portal there);
//   - NOTHING either way is "unknown, a person confirms" — never the statewide portal.
// Pure: the database-derived sources arrive as `evidence` (statewideEvidence.statewideEvidenceFor).

/** Is this URL the state's statewide portal instance — its own host or a known alias of it
 *  (portalCredentials.hostAliasesOf: aca.oregon.gov and epermitting.oregon.gov ARE
 *  aca-oregon.accela.com)? A city's own Accela tenant (aca-prod.accela.com/CORVALLIS) is not. */
export function isStatewidePortalUrl(state: string | null | undefined, url: string | null | undefined): boolean {
  const rule = stateRulesFor(state).statewidePortal;
  const ruleHost = hostOf(String(rule?.value ?? ""));
  const h = hostOf(String(url ?? ""));
  if (!ruleHost || !h) return false;
  return h === ruleHost || hostAliasesOf(ruleHost).map((x) => x.replace(/^www\./, "")).includes(h);
}
/** The statewide portal's name ("Oregon ePermitting"), "" when the state has none. */
export function statewidePortalName(state: string | null | undefined): string {
  return stateRulesFor(state).statewidePortalName ?? "";
}

/**
 * THE CHANNEL LABEL OF A RESOLVED PORTAL URL — ONE predicate (portal-truth D4). Corvallis's track
 * card read "Oregon ePermitting (Accela)" because an Oregon profile's words mentioned Accela /
 * e-permitting; the city files on its OWN Accela tenant. The statewide label is given ONLY when the
 * URL's host IS the statewide instance (isStatewidePortalUrl — its host or a known alias); an
 * Accela Citizen Access tenant of the AHJ's own (aca-prod.accela.com/<TENANT>, a custom-domain
 * …/CitizenAccess/) is "Accela Citizen Access (<AHJ>'s own portal)". null = no platform label (the
 * caller keeps its own words). Never read from free text.
 */
export function permitChannelLabel(state: string | null | undefined, ahj: string | null | undefined, url: string | null | undefined): string | null {
  const u = String(url ?? "").trim();
  const host = hostOf(u);
  if (!host) return null;
  if (isStatewidePortalUrl(state, u)) return stateRulesFor(state).statewidePortalLabel || statewidePortalName(state) || null;
  let path = "";
  try { path = new URL(u).pathname; } catch { path = ""; }
  const acaTenant = (/(?:^|\.)accela\.com$/.test(host) && /^aca/.test(host) && /^\/[^/.]+/.test(path)) || /\/citizenaccess(?:\/|$)/i.test(path);
  if (acaTenant) return `Accela Citizen Access (${String(ahj ?? "").trim() || "the AHJ"}'s own portal)`;
  return null;
}

/** One piece of evidence about WHERE an AHJ files, read by statewidePortalFor. */
export interface StatewideEvidence {
  kind: "statewide" | "elsewhere";
  /** Where it came from, in an operator's words ("seeded process profile", "recipe 1a2b…"). */
  source: string;
  /** What it says. */
  detail: string;
  url?: string;
  /** The cited fact itself, when the evidence is one (a lookup's portal answer). */
  fact?: CitedFact<string>;
  /** A PERSON said it (a human-verified knowledge-base row — isVerifiedKnowledge). Verified
   *  evidence decides outright (hard rule 3, the precedence fitUrl gives a verified row). */
  verified?: boolean;
}
export type StatewideDecision =
  | { url: string; basis: CitedFact<string>; withheld?: undefined; because?: undefined; evidence: StatewideEvidence[] }
  /** `because`: "elsewhere" = something on file says this AHJ files ELSEWHERE; "unknown" = nothing on
   *  file either way. Only "elsewhere" refuses a stored / researched statewide URL
   *  (statewideEvidence.statewideUrlRefusal) — an unknown AHJ recovers through research. */
  | { url: null; withheld: string; because: "elsewhere" | "unknown"; basis?: undefined; evidence: StatewideEvidence[] };

/** The portal a refused lookup answer NAMED: the structured `claimed`, else (rows saved before it
 *  existed) the URL in the door's own "the portal <url> was never returned by the search…" words.
 *  Only an ATTESTATION refusal names a claim: a help page or a utility portal the model named is
 *  not the AHJ's portal (those notFound texts carry no "the portal <url>" phrase). */
export function claimedPortalOf(fact: Pick<CitedFact<string>, "value" | "notFound" | "claimed"> | null | undefined): string {
  if (!fact || fact.value) return "";
  if (typeof fact.claimed === "string" && /^https?:\/\//i.test(fact.claimed.trim())) return fact.claimed.trim();
  const m = /\bthe portal (https?:\/\/[^\s,;)]+) was never returned by the search/i.exec(String(fact.notFound ?? ""));
  return m ? m[1].replace(/[.,]+$/, "") : "";
}

const URL_IN_TEXT = /https?:\/\/[^\s,;)"'<>]+/gi;
/** "OR E-permitting", "Oregon ePermitting (Accela)", "e-permitting portal" — the state's own
 *  e-permitting system, in a state that has one. The phrase (with a trailing platform / "portal"
 *  word) is read as ONE token so its "portal" is not read as another system's. */
const STATE_EPERMITTING = /\b(?:(?:or|oregon|state(?:wide)?)\s*)?e[\s-]?permitting(?:\s*\(?\s*(?:accela|aca)\s*\)?)?(?:\s+(?:portal|website|web\s*site|system|site))?/gi;
const OTHER_SYSTEM = /\bportal\b|projectdox|\bavolve\b|energov|\btyler\b|opengov|viewpoint|iworq|citizenserve|\bmygov\b|trakit|govoutreach|smartgov|devhub|development direct|\be-?mail\b|\bin[\s-]?person\b|over[\s-]the[\s-]counter|\bwalk[\s-]?in\b|\busps\b|\bmail(?:ed)?\b|\bpaper\b|\bcounter\b/i;

/**
 * WHAT A SEEDED / HAND-WRITTEN CHANNEL'S WORDS SAY about the statewide portal. A URL is judged by
 * its host; the state's e-permitting words say "statewide"; another system's words say
 * "elsewhere"; a bare platform word ("Accela") says NOTHING — Albany, Brownsville and Corvallis
 * run their own Accela tenants. Two channels in one line ("Tualatin Portal / OR E-Permitting",
 * "Clackamas (EP) / OR E-Permitting (BP)") are not a statewide answer: a person confirms which
 * one this permit takes.
 */
export function classifyChannelWords(state: string | null | undefined, text: string | null | undefined, ownNames: string[] = []): "statewide" | "elsewhere" | "neutral" {
  let raw = String(text ?? "").trim();
  if (!raw || !stateRulesFor(state).statewidePortal) return "neutral";
  // The AHJ's OWN name is not another office ("Oregon City / ePermitting" is one channel).
  for (const n of ownNames.map((x) => String(x ?? "").trim()).filter((x) => x.length >= 3).sort((a, b) => b.length - a.length)) {
    raw = raw.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), " ");
  }
  const urls = raw.match(URL_IN_TEXT) ?? [];
  const words = raw.replace(URL_IN_TEXT, " URL ");
  const clauses = words.split(/\s*[/;|]\s*/).map((c) => c.trim()).filter(Boolean);
  const verdicts = clauses.map((c): "statewide" | "elsewhere" | "neutral" | "other" => {
    if (/\bURL\b/.test(c)) return "neutral"; // judged by host below
    const sw = new RegExp(STATE_EPERMITTING.source, "i").test(c);
    const rest = c.replace(new RegExp(STATE_EPERMITTING.source, "gi"), " ");
    if (OTHER_SYSTEM.test(rest)) return "elsewhere";
    if (sw) return "statewide";
    // A clause naming only a platform ("Accela", "ACA") says nothing; anything else names another
    // office or channel ("Clackamas (EP)", "Josephine County") — it counts only beside another clause.
    return /^\W*(?:accela|aca|online)?\W*$/i.test(rest.replace(/\((?:[a-z]{1,3})\)/gi, " ")) ? "neutral" : "other";
  });
  const byUrl = urls.map((u) => (isStatewidePortalUrl(state, u) ? "statewide" : "elsewhere"));
  const all = [...verdicts, ...byUrl];
  if (all.includes("elsewhere")) return "elsewhere";
  const named = all.filter((v) => v !== "neutral");
  if (named.includes("statewide") && named.some((v) => v !== "statewide")) return "elsewhere";
  return named.includes("statewide") ? "statewide" : "neutral";
}

/**
 * THE STATEWIDE PORTAL for this AHJ's permit track, from the evidence (see the section header).
 * null = the state has no statewide portal at all. Otherwise a URL with the fact it rests on, or
 * `withheld` with the reason a person reads. The caller still judges a returned URL through
 * hostFitsTrackAndEntity (a person's verified portal for the AHJ outranks it).
 */
export function statewidePortalFor(
  project: Pick<ProjectRecord, "state" | "ahj">,
  track: string | null | undefined,
  opts: { processProfileMethod?: string | null; evidence?: StatewideEvidence[] } = {},
): StatewideDecision | null {
  const rule = stateRulesFor(project.state).statewidePortal;
  if (!answered(rule)) return null;
  const name = statewidePortalName(project.state) || "the statewide portal";
  const ahj = String(project.ahj ?? "").trim() || "this AHJ";
  const items: StatewideEvidence[] = [];
  // 1. THE PER-JOB LOOKUP: this track's own permit, else (a combo / unknown filing) every permit.
  const own = permitAnswerForTrack(project, track);
  const pool = own ? [own] : (permitProcessFor(project)?.permits ?? []);
  for (const p of pool) {
    const f = p.portalUrl;
    if (answered(f)) {
      const onState = isStatewidePortalUrl(project.state, f.value);
      items.push({
        kind: onState ? "statewide" : "elsewhere", source: `per-job lookup (${p.discipline})`, url: f.value!, fact: f,
        detail: onState ? `the per-job lookup found ${ahj}'s ${p.discipline} permit filed on ${f.value}` : `the per-job lookup found ${ahj}'s own portal ${f.value}`,
      });
      continue;
    }
    const claimed = claimedPortalOf(f);
    if (!claimed || !hostOf(claimed)) continue;
    const onState = isStatewidePortalUrl(project.state, claimed);
    items.push({
      kind: onState ? "statewide" : "elsewhere", source: `per-job lookup (${p.discipline}), named but not kept`, url: claimed,
      detail: onState
        ? `the per-job lookup's source named ${claimed} for ${ahj}'s ${p.discipline} permit`
        : `the per-job lookup's source named ${claimed} as where ${ahj} applies (${f.sourceUrl || "cited page"}: "${String(f.quote ?? "").slice(0, 120)}") — not kept by the lookup's door, but it is not ${name}`,
      fact: { value: onState ? claimed : null, sourceUrl: f.sourceUrl, quote: f.quote, origin: f.origin },
    });
  }
  // 2. THE SEEDED PROCESS PROFILE's own words.
  const method = String(opts.processProfileMethod ?? "").trim();
  if (method) {
    const verdict = classifyChannelWords(project.state, method);
    if (verdict !== "neutral") items.push({ kind: verdict, source: "seeded process profile", detail: `the seeded process profile says "${method.slice(0, 120)}"` });
  }
  // 3. Everything the database knows (knowledge-base rows, recipes, stored logins, the hand-written
  //    profile, the agency that issues this permit) — gathered by the caller.
  items.push(...(opts.evidence ?? []));
  // A PERSON'S ANSWER DECIDES OUTRIGHT (hard rule 3 — the precedence fitUrl gives a verified row):
  // when any evidence is human-verified, only the verified evidence decides. Salem's verified row
  // says "OR E-permitting"; a hand-written profile's "PAC Portal" words never outrank it.
  const verifiedItems = items.filter((e) => e.verified);
  const deciding = verifiedItems.length ? verifiedItems : items;
  const elsewhere = deciding.filter((e) => e.kind === "elsewhere");
  if (elsewhere.length) {
    return {
      url: null, evidence: items, because: "elsewhere",
      withheld: `${name} is not assumed for ${ahj}: ${elsewhere.slice(0, 2).map((e) => e.detail).join("; ")}. A person confirms ${ahj}'s portal (save it on the AHJ's knowledge-base profile) and re-stages.`,
    };
  }
  const onState = deciding.find((e) => e.kind === "statewide");
  if (onState) {
    const basis: CitedFact<string> = onState.fact && answered(onState.fact)
      ? { ...onState.fact, value: rule.value }
      : { value: rule.value, sourceUrl: rule.sourceUrl, quote: `${onState.source}: ${onState.detail}`.slice(0, 300), origin: "kb" };
    return { url: rule.value, basis, evidence: items };
  }
  return {
    url: null, evidence: items, because: "unknown",
    withheld: `Unknown: nothing on file says ${ahj} files on ${name} (no per-job lookup portal, seeded or hand-written process, knowledge-base row, recipe or issuing agency names it). A person confirms ${ahj}'s portal (save it on the AHJ's knowledge-base profile) and re-stages.`,
  };
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
