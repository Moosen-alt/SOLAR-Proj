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
  PermitProcessLookup,
  PermitProcessPermitAnswer,
  ProjectRecord,
} from "../../shared/src/types";
import type { AppDb } from "./db";

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
}

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
export const BCD_5952_URL = BCD_5952;

export function stateRulesFor(state: string | null | undefined): StatePermitRules {
  return STATE_PERMIT_RULES[String(state ?? "").trim().toUpperCase()] ?? {};
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

/** Which of the lookup's permits a submittal track files. */
export function permitAnswerForTrack(project: Pick<ProjectRecord, "state" | "ahj">, track: string | null | undefined): PermitProcessPermitAnswer | null {
  const lk = permitProcessFor(project);
  if (!lk?.permits?.length) return null;
  const want = track === "building" ? "structural" : track === "electrical" || track === "mpu" ? "electrical" : track === "combo" || track === "permit" ? "combo" : "";
  if (!want) return null;
  return lk.permits.find((p) => p.discipline === want) ?? null;
}

/** The agency that issues this track's permit: the permit's own answer, else the AHJ-wide one. */
export function issuingAgencyFor(project: Pick<ProjectRecord, "state" | "ahj">, track: string | null | undefined): CitedFact<string> | null {
  const p = permitAnswerForTrack(project, track);
  if (p && answered(p.issuingAgency)) return p.issuingAgency;
  const lk = permitProcessFor(project);
  if (lk && answered(lk.issuingAgency)) return lk.issuingAgency;
  return null;
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
