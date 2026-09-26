// ---------------------------------------------------------------------------
// WHERE THE UTILITY APPLICATION IS FILED — and what the utility's program IS.
//
// New-AHJ e2e (2026-09-26): "utility filing location" was 0/6. Every utility track said
// "Utility NEM portal" and was labelled "Utility net metering (NEM)", including Oncor (a
// Texas wires-only distribution utility: no utility net metering — any export credit is the
// customer's retail provider's) and SRP (export-credit price plans, not net metering). The
// real answers were public: FirstEnergy's page names its own interconnection portal, SRP and
// Eversource say PowerClerk, Oncor names its installer portal.
//
// One web-grounded lookup per UTILITY (shared knowledge, like permit_process_lookups: a
// utility's filing location learned once helps every tenant), with the per-job permit
// lookup's discipline:
//   - every answer carries a source URL the search returned or a page the model opened, and the
//     page's own words, which must themselves state the answer — or it is NOT FOUND;
//   - a portal URL is kept only when its OWN host was attested by the search, it is somewhere an
//     application is filed (never a help page or a PDF), and it fits the NEM track (hard rule 5:
//     a city/county PERMIT portal is never a utility filing location — portalChannel's one
//     predicate, hostFitsTrackAndEntity);
//   - nothing from model memory is kept (an ungrounded answer is NOT FOUND);
//   - a person's VERIFIED row is never overwritten by a lookup (hard rule 3).
// The track is labelled by what the program IS — net metering only when a cited page says so.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { CitedFact, LLMProvider, ProjectRecord, WebLookupResult } from "../../shared/src/types";
import { hostFitsTrackAndEntity, isInformationalPageUrl, portalHostOf } from "./portalChannel";
import { logger } from "./logger";

export type UtilityProgramKind = "net_metering" | "net_billing" | "interconnection_only";
export interface UtilityFilingLocation {
  /** The portal or method as the utility names it ("PowerClerk", "Interconnection Portal", "email"). */
  name: string;
  /** The application portal's own entry URL — null when the utility names a method, not a URL. */
  url: string | null;
}
export interface UtilityFilingLookup {
  profileKey: string;
  state: string;
  utility: string;
  confidence: "seeded" | "verified";
  filing: CitedFact<UtilityFilingLocation>;
  program: CitedFact<UtilityProgramKind>;
  /** The program in the utility's own words ("Customer Generation", "Net Metering Rider"). */
  programName?: string;
  lookedUpAt: string;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** "PGE", "Portland General Electric Co." → normalized words. EXACT key, no fuzzy bridge. */
export function normalizeUtilityName(utility: string): string {
  return str(utility).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|co|corp|company|llc)\b/g, " ").replace(/\s+/g, " ").trim();
}
export function utilityFilingKey(state: string, utility: string): string {
  return `${str(state).toLowerCase()}|${normalizeUtilityName(utility)}`;
}

// ── Store (lazy table — the same pattern as credentialRequests / portalQuestionBank) ──────────
function ensureTable(db: AppDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS utility_filing_lookups (
      profile_key TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT '',
      utility TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT 'seeded',
      payload_json TEXT NOT NULL DEFAULT '{}',
      looked_up_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      verified_at TEXT,
      verified_by TEXT
    )
  `);
}

function rowToLookup(row: Record<string, unknown> | undefined | null): UtilityFilingLookup | null {
  if (!row) return null;
  try {
    const payload = JSON.parse(str(row.payload_json) || "{}") as UtilityFilingLookup;
    return {
      ...payload,
      profileKey: str(row.profile_key),
      confidence: row.verified_at ? "verified" : "seeded",
      verifiedAt: row.verified_at ? str(row.verified_at) : null,
      verifiedBy: row.verified_by ? str(row.verified_by) : null,
    };
  } catch {
    return null;
  }
}

export function getUtilityFilingLookup(db: AppDb, state: string, utility: string): UtilityFilingLookup | null {
  if (!normalizeUtilityName(utility)) return null;
  try {
    ensureTable(db);
    return rowToLookup(db.get<Record<string, unknown>>("SELECT * FROM utility_filing_lookups WHERE profile_key = ?", [utilityFilingKey(state, utility)]));
  } catch {
    return null;
  }
}

/** THE WRITE PATH. A lookup lands 'seeded'; a person's verified row is never overwritten by one. */
export function saveUtilityFilingLookup(
  db: AppDb,
  input: Omit<UtilityFilingLookup, "profileKey" | "confidence"> & { confidence?: "seeded" | "verified" },
  opts: { verifiedBy?: string } = {},
): { saved: boolean; reason: string; lookup: UtilityFilingLookup | null } {
  if (!normalizeUtilityName(input.utility)) return { saved: false, reason: "no utility name", lookup: null };
  ensureTable(db);
  const key = utilityFilingKey(input.state, input.utility);
  const existing = db.get<Record<string, unknown>>("SELECT * FROM utility_filing_lookups WHERE profile_key = ?", [key]);
  const wantsVerified = input.confidence === "verified" && Boolean(opts.verifiedBy);
  if (existing?.verified_at && !wantsVerified) {
    return { saved: false, reason: "a person verified this utility's filing location; a lookup never overwrites it", lookup: rowToLookup(existing) };
  }
  const now = new Date().toISOString();
  const payload: UtilityFilingLookup = { ...input, profileKey: key, confidence: wantsVerified ? "verified" : "seeded", lookedUpAt: input.lookedUpAt || now };
  db.run(
    `INSERT INTO utility_filing_lookups (profile_key, state, utility, confidence, payload_json, looked_up_at, updated_at, verified_at, verified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_key) DO UPDATE SET state = excluded.state, utility = excluded.utility, confidence = excluded.confidence,
       payload_json = excluded.payload_json, looked_up_at = excluded.looked_up_at, updated_at = excluded.updated_at,
       verified_at = excluded.verified_at, verified_by = excluded.verified_by`,
    [key, input.state, input.utility, payload.confidence, JSON.stringify(payload), payload.lookedUpAt, now,
      wantsVerified ? now : null, wantsVerified ? String(opts.verifiedBy) : null],
  );
  return { saved: true, reason: payload.confidence, lookup: getUtilityFilingLookup(db, input.state, input.utility) };
}

// ── Acceptance (the cited discipline) ────────────────────────────────────────────────────────
type RawFact = { value?: unknown; sourceUrl?: unknown; quote?: unknown; notFound?: unknown; programName?: unknown } | null | undefined;

const GENERIC_WORDS = new Set(["the", "and", "for", "our", "portal", "online", "application", "applications", "interconnection", "system", "web", "site", "page", "utility", "customer", "generation", "net", "metering"]);
const distinctive = (s: string) => str(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2 && !GENERIC_WORDS.has(w));

/** Does the quote NAME this filing location? The URL's host, or every distinctive word of its
 *  name, must be in the quote ("You will use our PowerClerk portal" names "PowerClerk"). A name
 *  of only generic words ("Interconnection Portal") needs the host, or the name's own words. */
export function quoteNamesFiling(value: UtilityFilingLocation, quote: string): boolean {
  const q = str(quote).toLowerCase();
  const host = value.url ? portalHostOf(value.url) : "";
  if (host && (q.includes(host) || q.includes(host.split(".").slice(-2).join(".")))) return true;
  const words = distinctive(value.name);
  if (words.length) return words.every((w) => q.includes(w));
  const all = str(value.name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return Boolean(all) && q.replace(/[^a-z0-9]+/g, " ").includes(all);
}

const DENIES_NEM = /\b(?:no|not|does not|doesn't|do not|don't|without)\b[^.;]{0,40}\bnet[- ]?(?:energy )?meter/i;
/** Does the quote STATE this program kind? */
export function quoteStatesProgram(kind: UtilityProgramKind, quote: string): boolean {
  const q = str(quote);
  if (kind === "net_metering") return /\bnet[- ]?(?:energy )?meter(?:ing|ed)?\b|\bNEM\b/i.test(q) && !DENIES_NEM.test(q);
  if (kind === "net_billing") return /\bexport(?:ed|s)?\b[^.;]{0,80}\b(?:credit|price|rate|c(?:ents)?\/kwh|¢)|\bbuy[- ]?back\b|\bnet billing\b|\bavoided cost\b|\bcredited\b[^.;]{0,60}\b(?:price|rate)\b/i.test(q);
  return DENIES_NEM.test(q) || /\bretail electric provider\b|\bREPs?\b|\bwires[- ]only\b|\btransmission and distribution (?:service )?provider\b/i.test(q);
}

function cited<T>(raw: RawFact, seenUrls: string[], coerce: (v: unknown) => T | null, supports: (v: T, quote: string) => boolean, what: string): CitedFact<T> {
  const notFound = (why: string): CitedFact<T> => ({ value: null, sourceUrl: str(raw?.sourceUrl), quote: str(raw?.quote).slice(0, 300), origin: "lookup", notFound: why });
  if (!raw || raw.value == null || raw.value === "") return notFound(str(raw?.notFound) || `no source stated the ${what}`);
  const value = coerce(raw.value);
  if (value == null) return notFound(`the ${what} returned was not usable`);
  const sourceUrl = str(raw.sourceUrl);
  const quote = str(raw.quote).slice(0, 300);
  if (!/^https?:\/\//i.test(sourceUrl) || quote.length < 8) return notFound(`the ${what} came without a source page and its words — not kept`);
  const host = portalHostOf(sourceUrl);
  if (!seenUrls.some((u) => portalHostOf(u) === host)) return notFound(`the ${what}'s source (${host}) is not a page the search returned — not kept`);
  if (!supports(value, quote)) return notFound(`the quoted words do not state the ${what} ("${quote.slice(0, 80)}")`);
  return { value, sourceUrl, quote, origin: "lookup" };
}

/** A filing URL is kept only when it is a real application portal on the NEM track whose OWN host
 *  the search attested. Otherwise the location keeps its name and loses the URL. */
export function acceptFilingUrl(url: string, seenUrls: string[]): { url: string | null; why: string } {
  const u = str(url);
  if (!/^https?:\/\//i.test(u)) return { url: null, why: "no URL" };
  const host = portalHostOf(u);
  if (!seenUrls.some((s) => portalHostOf(s) === host)) return { url: null, why: `${host} is not a host the search returned` };
  if (isInformationalPageUrl(u)) return { url: null, why: `${u} is an information page, not an application portal` };
  const fit = hostFitsTrackAndEntity("nem", null, u, "research");
  if (!fit.fits) return { url: null, why: fit.reason };
  return { url: u, why: "" };
}

export function parseUtilityFilingAnswer(text: string, seenUrls: string[]): { filing: CitedFact<UtilityFilingLocation>; program: CitedFact<UtilityProgramKind>; programName: string; dropped: string[] } {
  let json: Record<string, unknown> | null = null;
  const t = str(text);
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { json = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>; } catch { json = null; }
  }
  const dropped: string[] = [];
  const rawFiling = (json?.filing ?? null) as RawFact;
  const filing = cited<UtilityFilingLocation>(
    rawFiling, seenUrls,
    (v) => {
      const o = (v && typeof v === "object" ? v : { name: v }) as Record<string, unknown>;
      const name = str(o.name);
      const accepted = acceptFilingUrl(str(o.url), seenUrls);
      if (str(o.url) && !accepted.url) dropped.push(`filing URL ${str(o.url)} dropped: ${accepted.why}`);
      if (!name && !accepted.url) return null;
      return { name: name || portalHostOf(accepted.url!), url: accepted.url };
    },
    quoteNamesFiling, "filing location",
  );
  const rawProgram = (json?.program ?? null) as RawFact;
  const program = cited<UtilityProgramKind>(
    rawProgram, seenUrls,
    (v) => (["net_metering", "net_billing", "interconnection_only"].includes(str(v)) ? (str(v) as UtilityProgramKind) : null),
    quoteStatesProgram, "program",
  );
  return { filing, program, programName: program.value ? str(rawProgram?.programName).slice(0, 120) : "", dropped };
}

// ── The lookup ───────────────────────────────────────────────────────────────────────────────
export const UTILITY_FILING_SYSTEM = `You find, for ONE electric utility in the United States, WHERE a residential rooftop solar installer files that utility's interconnection application, and WHAT the utility's customer-generation program is.

1. filing — where the interconnection / net-metering application is SUBMITTED: the online application portal (a PowerClerk tenant, the utility's own interconnection portal, an installer portal) or, when the utility takes it another way, that way (e.g. email to an address, a paper form). value: {"name": "<the portal or method, as the utility names it>", "url": "<the portal's own entry URL, or null>"}. NEVER a city or county PERMIT portal, never a help page or a PDF. Prefer the utility's own interconnection / "for contractors" / "for installers" page.
2. program — "net_metering" when the utility credits exported energy under a net-metering tariff or rider; "net_billing" when exports are credited at a set export / buyback rate or price plan that is not net metering; "interconnection_only" when the utility only interconnects and does not itself credit exports (e.g. a wires-only distribution utility whose customers' retail electric provider sets any buyback). Also give "programName" in the utility's own words.

EVERY value carries "sourceUrl" (a page your search returned or you opened) and "quote" (the exact words on that page that state it, under 250 characters, containing the answer itself: the portal's name or link for the filing; the words net metering / export credit / retail provider for the program). If no page states it, "value": null and say what you searched in "notFound". Never answer from memory. Never guess.

Return ONLY JSON:
{"filing": {"value": {"name": "", "url": null}|null, "sourceUrl": "", "quote": "", "notFound": ""},
 "program": {"value": "net_metering"|"net_billing"|"interconnection_only"|null, "programName": "", "sourceUrl": "", "quote": "", "notFound": ""}}`;

const lookupTimeoutMs = () => Math.max(120000, Number(process.env.UTILITY_FILING_LOOKUP_TIMEOUT_MS) || 240000);

export interface UtilityFilingLookupRun {
  saved: boolean;
  reason: string;
  lookup: UtilityFilingLookup | null;
  grounded: number;
  dropped: string[];
  error?: string;
}

export async function runUtilityFilingLookup(
  db: AppDb,
  llm: Pick<LLMProvider, "webLookup">,
  input: { state: string; utility: string; city?: string; force?: boolean },
): Promise<UtilityFilingLookupRun> {
  const existing = getUtilityFilingLookup(db, input.state, input.utility);
  if (existing?.confidence === "verified") return { saved: false, reason: "a person verified this utility's filing location", lookup: existing, grounded: 0, dropped: [] };
  if (existing && !input.force) return { saved: false, reason: "already looked up (seeded)", lookup: existing, grounded: 0, dropped: [] };
  if (!llm.webLookup) return { saved: false, reason: "no web lookup available (no model key)", lookup: existing, grounded: 0, dropped: [] };
  let r: WebLookupResult;
  try {
    r = await llm.webLookup({
      label: "utilityFilingLookup", system: UTILITY_FILING_SYSTEM,
      user: `Utility: ${input.utility}\nState: ${input.state}${input.city ? `\nService address city: ${input.city}` : ""}`,
      maxTokens: 4000, maxSearches: 6, readPages: true, maxFetches: 3, timeoutMs: lookupTimeoutMs(),
    });
  } catch (err) {
    return { saved: false, reason: "lookup failed", lookup: existing, grounded: 0, dropped: [], error: err instanceof Error ? err.message : String(err) };
  }
  const seen = [...r.resultUrls, ...(r.fetchedUrls ?? [])];
  const ungrounded = r.groundedSearches <= 0;
  const parsed = ungrounded
    ? {
      filing: { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: r.error ? `lookup failed: ${r.error.slice(0, 120)}` : "no web search returned results — nothing kept from memory" },
      program: { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "no grounded search" },
      programName: "", dropped: [] as string[],
    }
    : parseUtilityFilingAnswer(r.text, seen);
  // An aborted call that found nothing is not stored — a retry later may succeed. A grounded
  // "not found" IS stored, so the same utility is not searched on every project.
  if (ungrounded && r.error) return { saved: false, reason: `lookup failed: ${r.error.slice(0, 160)}`, lookup: existing, grounded: 0, dropped: [], error: r.error };
  const save = saveUtilityFilingLookup(db, {
    state: input.state, utility: input.utility,
    filing: parsed.filing as CitedFact<UtilityFilingLocation>, program: parsed.program as CitedFact<UtilityProgramKind>,
    ...(parsed.programName ? { programName: parsed.programName } : {}),
    lookedUpAt: new Date().toISOString(),
  });
  return { saved: save.saved, reason: save.reason, lookup: save.lookup, grounded: r.groundedSearches, dropped: parsed.dropped };
}

const inFlight = new Map<string, number>();
const RETRY_MS = 24 * 3600 * 1000;
/**
 * THE TRIGGER, fire-and-forget: look up a project's utility once (per utility, shared), when a
 * model key is configured and nothing is on file. Returns true when a lookup was started. Callers
 * never await the lookup's result; the tracks read the stored row on their next render.
 */
export function ensureUtilityFilingLookedUp(
  db: AppDb,
  project: Pick<ProjectRecord, "state" | "utility" | "city">,
  llm: Pick<LLMProvider, "webLookup"> | null,
): boolean {
  if (/^(off|0|false)$/i.test(str(process.env.UTILITY_FILING_LOOKUP)) || !process.env.ANTHROPIC_API_KEY) return false;
  if (!llm?.webLookup || !str(project.utility) || !str(project.state)) return false;
  const key = utilityFilingKey(project.state, project.utility);
  if (getUtilityFilingLookup(db, project.state, project.utility)) return false;
  const last = inFlight.get(key);
  if (last && Date.now() - last < RETRY_MS) return false;
  inFlight.set(key, Date.now());
  void runUtilityFilingLookup(db, llm, { state: project.state, utility: project.utility, city: project.city })
    .then((run) => logger.info("utility-filing", `utility filing lookup for ${project.utility} (${project.state}): ${run.reason}`, { grounded: run.grounded, dropped: run.dropped.length }))
    .catch((err) => logger.warn("utility-filing", `utility filing lookup failed for ${project.utility}: ${err instanceof Error ? err.message : String(err)}`));
  return true;
}

// ── What the utility track shows ─────────────────────────────────────────────────────────────
/** Utilities whose program and portal this codebase already knew as fact before this module
 *  (Oregon net metering, ORS 757.300; their PowerClerk tenants are the recorded channels). */
function knownOregonNemUtility(project: Pick<ProjectRecord, "state" | "utility">): { channel: string; url: string } | null {
  const u = str(project.utility).toLowerCase();
  if (str(project.state).toUpperCase() !== "OR") return null;
  if (/pge|portland general(?!\s*electric\s*pac)/.test(u)) return { channel: "PowerClerk (PGE NEM portal)", url: "" };
  if (/pacificorp|pacific power/.test(u)) return { channel: "Pacific Power NEM portal (PowerClerk: pacificorpnetmetering.powerclerk.com)", url: "https://pacificorpnetmetering.powerclerk.com/" };
  return null;
}

export interface UtilityTrackPresentation {
  /** The track card's title — what the filing IS. */
  label: string;
  /** Where it is filed, with the basis. */
  channel: string;
  /** The filing portal URL (cited) when one is known — for the credential chip / recorder. */
  portalUrl: string;
  program: UtilityProgramKind | "unknown";
  /** "cited" | "verified" | "known" | "unknown" — how the label/channel are known. */
  basis: "cited" | "verified" | "known" | "unknown";
}

export const UTILITY_TRACK_LABELS: Record<UtilityProgramKind | "unknown", string> = {
  net_metering: "Utility net metering (NEM) / interconnection",
  net_billing: "Utility interconnection + export credit (net billing — not net metering)",
  interconnection_only: "Utility interconnection only (no utility net metering)",
  unknown: "Utility interconnection application (net-metering program not yet confirmed)",
};

export function utilityTrackPresentation(db: AppDb | null, project: Pick<ProjectRecord, "state" | "utility">): UtilityTrackPresentation {
  const lookup = db ? getUtilityFilingLookup(db, project.state, project.utility) : null;
  const verified = lookup?.confidence === "verified";
  const known = knownOregonNemUtility(project);
  const program: UtilityProgramKind | "unknown" = lookup?.program?.value ?? (known ? "net_metering" : "unknown");
  const filing = lookup?.filing?.value ?? null;
  const tag = verified ? "verified by a person" : "cited";
  const channel = filing
    ? `${filing.name}${filing.url ? ` — ${filing.url}` : ""} (${tag}: ${lookup!.filing.sourceUrl})`
    : known
      ? known.channel
      : "Utility interconnection portal — not yet identified (verify on the utility's interconnection page)";
  const programLabel = UTILITY_TRACK_LABELS[program];
  return {
    label: lookup?.program?.value && lookup.programName ? `${programLabel} — ${lookup.programName}` : programLabel,
    channel,
    portalUrl: filing?.url || known?.url || "",
    program,
    basis: lookup?.program?.value || filing ? (verified ? "verified" : "cited") : known ? "known" : "unknown",
  };
}
