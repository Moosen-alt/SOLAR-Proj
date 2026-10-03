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
import { hostFitsTrackAndEntity, isInformationalPageUrl, namedInterconnectionPlatforms, portalHostOf } from "./portalChannel";
import { logger } from "./logger";
import { knownPowerClerkUtility } from "./utilityIdentity";
import { isVerifiedKnowledge, knowledgeProfileKey } from "./knowledgeBase";
import { portalEntityEvidence } from "./portalRecipes";

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

// ── Store: the utility_filing_lookups table is created by db.ts migration v37 (never lazily
// here — a CREATE TABLE inside a read path broke the "reads write nothing" invariant). ──────────

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
 *  the search attested — and, when the answer names an interconnection platform (its name or its
 *  quote says PowerClerk…), on that platform's domain (issue #31). Otherwise the location keeps its
 *  name and loses the URL. */
export function acceptFilingUrl(url: string, seenUrls: string[], namedPlatform: string[] = []): { url: string | null; why: string } {
  const u = str(url);
  if (!/^https?:\/\//i.test(u)) return { url: null, why: "no URL" };
  const host = portalHostOf(u);
  if (!seenUrls.some((s) => portalHostOf(s) === host)) return { url: null, why: `${host} is not a host the search returned` };
  if (isInformationalPageUrl(u)) return { url: null, why: `${u} is an information page, not an application portal` };
  const fit = hostFitsTrackAndEntity("nem", null, u, "research", { namedPlatform });
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
      const named = [str(o.name), str(rawFiling?.quote)];
      // A nameless answer whose quote names the platform is filed under that platform's name, so a
      // dropped off-platform URL still leaves "PowerClerk — tenant URL unconfirmed" on the card.
      const name = str(o.name) || namedInterconnectionPlatforms(named)[0] || "";
      const accepted = acceptFilingUrl(str(o.url), seenUrls, named);
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

1. filing — where the interconnection / net-metering application is SUBMITTED: the online application portal (a PowerClerk tenant, the utility's own interconnection portal, an installer portal) or, when the utility takes it another way, that way (e.g. email to an address, a paper form). value: {"name": "<the portal or method, as the utility names it>", "url": "<the portal's own entry URL, or null>"}. NEVER a city or county PERMIT portal, never a help page or a PDF. Prefer the utility's own interconnection / "for contractors" / "for installers" page. When the utility files on PowerClerk (or another platform), the url is the utility's OWN tenant login on that platform's domain (e.g. <tenant>.powerclerk.com/MvcAccount/Login) — search for it and give it only when a search result or a page you opened shows that host; a program, resource or info page on the utility's own website is never the url. If you cannot find the tenant's host, give the name (e.g. "PowerClerk") with "url": null.
2. program — "net_metering" when the utility credits exported energy under a net-metering tariff or rider; "net_billing" when exports are credited at a set export / buyback rate or price plan that is not net metering; "interconnection_only" when the utility only interconnects and does not itself credit exports (e.g. a wires-only distribution utility whose customers' retail electric provider sets any buyback). Also give "programName" in the utility's own words.

EVERY value carries "sourceUrl" (a page your search returned or you opened) and "quote" (the exact words on that page that state it, under 250 characters, containing the answer itself: the portal's name or link for the filing; the words net metering / export credit / retail provider for the program). If no page states it, "value": null and say what you searched in "notFound". Never answer from memory. Never guess.

Return ONLY JSON:
{"filing": {"value": {"name": "", "url": null}|null, "sourceUrl": "", "quote": "", "notFound": ""},
 "program": {"value": "net_metering"|"net_billing"|"interconnection_only"|null, "programName": "", "sourceUrl": "", "quote": "", "notFound": ""}}`;

const lookupTimeoutMs = () => Math.max(120000, Number(process.env.UTILITY_FILING_LOOKUP_TIMEOUT_MS) || 240000);

/** THE BUDGETS. "full" is the first try. "tight" is the one background retry after a timeout
 *  (issue #9: PNM's lookup ran 6 searches + 3 page reads for 240s and was aborted with nothing):
 *  half the searches, one page read, a smaller answer — the same time budget, so it finishes. */
export const UTILITY_FILING_BUDGETS = {
  full: { maxSearches: 6, maxFetches: 3, maxTokens: 4000 },
  tight: { maxSearches: 3, maxFetches: 1, maxTokens: 3000 },
} as const;
export type UtilityFilingBudget = keyof typeof UTILITY_FILING_BUDGETS;

export interface UtilityFilingLookupRun {
  saved: boolean;
  reason: string;
  lookup: UtilityFilingLookup | null;
  grounded: number;
  dropped: string[];
  error?: string;
  /** The call hit its time budget (the trigger retries it once, tighter). */
  timedOut?: boolean;
}

const isTimeout = (r: Pick<WebLookupResult, "timedOut" | "error">) => Boolean(r.timedOut) || /\b(?:abort(?:ed)?|timed? ?out)\b/i.test(str(r.error));

export async function runUtilityFilingLookup(
  db: AppDb,
  llm: Pick<LLMProvider, "webLookup">,
  input: { state: string; utility: string; city?: string; force?: boolean; budget?: UtilityFilingBudget },
): Promise<UtilityFilingLookupRun> {
  const existing = getUtilityFilingLookup(db, input.state, input.utility);
  if (existing?.confidence === "verified") return { saved: false, reason: "a person verified this utility's filing location", lookup: existing, grounded: 0, dropped: [] };
  if (existing && !input.force) return { saved: false, reason: "already looked up (seeded)", lookup: existing, grounded: 0, dropped: [] };
  if (!llm.webLookup) return { saved: false, reason: "no web lookup available (no model key)", lookup: existing, grounded: 0, dropped: [] };
  const budget = UTILITY_FILING_BUDGETS[input.budget ?? "full"];
  let r: WebLookupResult;
  try {
    r = await llm.webLookup({
      label: "utilityFilingLookup", system: UTILITY_FILING_SYSTEM,
      user: `Utility: ${input.utility}\nState: ${input.state}${input.city ? `\nService address city: ${input.city}` : ""}`,
      maxTokens: budget.maxTokens, maxSearches: budget.maxSearches, readPages: true, maxFetches: budget.maxFetches, timeoutMs: lookupTimeoutMs(),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { saved: false, reason: "lookup failed", lookup: existing, grounded: 0, dropped: [], error, timedOut: isTimeout({ error }) };
  }
  const timedOut = isTimeout(r);
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
  if (ungrounded && r.error) return { saved: false, reason: `lookup failed: ${r.error.slice(0, 160)}`, lookup: existing, grounded: 0, dropped: [], error: r.error, timedOut };
  // A FAILED call that DID ground (a timeout's partial evidence): whatever passes the same cited
  // discipline is kept — but a partial that kept nothing is NOT a grounded "not found". Storing it
  // would pin the utility to "not yet identified" for a week on the strength of an unfinished search.
  if (r.error && !parsed.filing.value && !parsed.program.value) {
    return { saved: false, reason: `lookup failed: ${r.error.slice(0, 160)} (nothing usable in its partial results)`, lookup: existing, grounded: r.groundedSearches, dropped: parsed.dropped, error: r.error, timedOut };
  }
  // A RE-RUN NEVER LOSES A CITED ANSWER IT ALREADY HAD (issue #54: an incomplete row is looked up
  // again; a second search that finds less keeps the first one's filing / program).
  const keepFiling = !parsed.filing.value && existing?.filing?.value;
  const keepProgram = !parsed.program.value && existing?.program?.value;
  const programName = keepProgram ? existing?.programName ?? "" : parsed.programName;
  const save = saveUtilityFilingLookup(db, {
    state: input.state, utility: input.utility,
    filing: (keepFiling ? existing!.filing : parsed.filing) as CitedFact<UtilityFilingLocation>,
    program: (keepProgram ? existing!.program : parsed.program) as CitedFact<UtilityProgramKind>,
    ...(programName ? { programName } : {}),
    lookedUpAt: new Date().toISOString(),
  });
  return { saved: save.saved, reason: r.error ? `${save.reason} (partial results kept after: ${r.error.slice(0, 120)})` : save.reason, lookup: save.lookup, grounded: r.groundedSearches, dropped: parsed.dropped,
    ...(r.error ? { error: r.error, timedOut } : {}) };
}

/** INCOMPLETE for the retry rule: nothing found at all, OR a named interconnection platform with
 *  no tenant URL (issue #54: PNM's "PowerClerk — tenant URL unconfirmed" was otherwise permanent).
 *  A method answer with no URL ("email to …") is complete. A verified row is never re-looked-up —
 *  the caller checks that first. */
export function isIncompleteFilingLookup(lookup: Pick<UtilityFilingLookup, "filing" | "program"> | null | undefined): boolean {
  if (!lookup) return true;
  const filing = lookup.filing?.value ?? null;
  if (!filing && !lookup.program?.value) return true;
  return Boolean(filing && !filing.url && namedInterconnectionPlatforms(filing.name).length);
}

const inFlight = new Map<string, number>();
const RETRY_MS = 24 * 3600 * 1000;
const EMPTY_RETRY_MS = 7 * 24 * 3600 * 1000;
/** After the background retry ALSO timed out, the next form-research pass (pipeline or the
 *  operator's "Find official form") may start a fresh attempt this soon — not a day later. */
const TIMED_OUT_RETRY_MS = 3600 * 1000;

/** What the trigger is doing for a utility, IN MEMORY (a read path writes nothing): the track card
 *  says "timed out, retrying" instead of a silent "not yet identified". */
export interface UtilityFilingLookupStatus { state: "running" | "retrying" | "timed_out" | "failed"; at: string; error?: string; retryAfter?: string }
const statusByKey = new Map<string, UtilityFilingLookupStatus>();
export function utilityFilingLookupStatus(state: string, utility: string): UtilityFilingLookupStatus | null {
  return statusByKey.get(utilityFilingKey(state, utility)) ?? null;
}
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
  const stored = getUtilityFilingLookup(db, project.state, project.utility);
  // A grounded search that found NOTHING is stored (the same utility is not searched on every
  // project) — but not forever: with no route to re-run a row, one bad search day would pin a
  // utility to "not yet confirmed" for good. An INCOMPLETE seeded row older than EMPTY_RETRY_MS is
  // looked up again; a complete or verified row never is (rule 3).
  const emptyAndStale = stored && stored.confidence !== "verified" && isIncompleteFilingLookup(stored)
    && Date.now() - Date.parse(stored.lookedUpAt || "") > EMPTY_RETRY_MS;
  if (stored && !emptyAndStale) return false;
  const last = inFlight.get(key);
  if (last && Date.now() - last < RETRY_MS) return false;
  inFlight.set(key, Date.now());
  statusByKey.set(key, { state: "running", at: new Date().toISOString() });
  const base = { state: project.state, utility: project.utility, city: project.city, force: Boolean(emptyAndStale) };
  const log = (run: UtilityFilingLookupRun, attempt: string) =>
    logger.info("utility-filing", `utility filing lookup for ${project.utility} (${project.state})${attempt}: ${run.reason}`, { grounded: run.grounded, dropped: run.dropped.length, timedOut: Boolean(run.timedOut) });
  void (async () => {
    let run = await runUtilityFilingLookup(db, llm, base);
    log(run, "");
    // A TIMEOUT IS NOT A VERDICT (issue #9). One background retry on the tight budget; a partial
    // that was kept (run.saved) needs none.
    if (run.timedOut && !run.saved) {
      statusByKey.set(key, { state: "retrying", at: new Date().toISOString(), error: run.error });
      run = await runUtilityFilingLookup(db, llm, { ...base, budget: "tight" });
      log(run, " (retry, tight budget)");
    }
    if (run.saved || !run.error) {
      statusByKey.delete(key);
    } else {
      // A double timeout: the next form-research pass may try again within the hour, not tomorrow.
      if (run.timedOut) inFlight.set(key, Date.now() - RETRY_MS + TIMED_OUT_RETRY_MS);
      const retryAfter = new Date((inFlight.get(key) ?? Date.now()) + RETRY_MS).toISOString();
      statusByKey.set(key, { state: run.timedOut ? "timed_out" : "failed", at: new Date().toISOString(), error: run.error, retryAfter });
    }
  })().catch((err) => {
    statusByKey.set(key, { state: "failed", at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) });
    logger.warn("utility-filing", `utility filing lookup failed for ${project.utility}: ${err instanceof Error ? err.message : String(err)}`);
  });
  return true;
}

// ── What the utility track shows ─────────────────────────────────────────────────────────────
/** Utilities whose program and portal this codebase already knew as fact before this module
 *  (Oregon net metering, ORS 757.300; their PowerClerk tenants are the recorded channels). */
function knownOregonNemUtility(project: Pick<ProjectRecord, "state" | "utility">): { channel: string; url: string } | null {
  // Oregon net metering only (the PROGRAM fact is Oregon's); WHICH utility is the one state-gated
  // identity (utilityIdentity) every other door asks.
  if (str(project.state).toUpperCase() !== "OR") return null;
  const known = knownPowerClerkUtility(project);
  if (known === "portland_general") return { channel: "PowerClerk (PGE NEM portal)", url: "" };
  if (known === "pacificorp") return { channel: "Pacific Power NEM portal (PowerClerk: pacificorpnetmetering.powerclerk.com)", url: "https://pacificorpnetmetering.powerclerk.com/" };
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
  /** "cited" | "verified" | "known" | "profile" (a seeded KB row) | "unknown" — how the label/channel are known. */
  basis: "cited" | "verified" | "known" | "profile" | "unknown";
}

export const UTILITY_TRACK_LABELS: Record<UtilityProgramKind | "unknown", string> = {
  net_metering: "Utility net metering (NEM) / interconnection",
  net_billing: "Utility interconnection + export credit (net billing — not net metering)",
  interconnection_only: "Utility interconnection only (no utility net metering)",
  unknown: "Utility interconnection application (net-metering program not yet confirmed)",
};

/** What the card says while the lookup is not settled — never a silent "not yet identified". */
export const UTILITY_LOOKUP_STATUS_TEXT: Record<UtilityFilingLookupStatus["state"], string> = {
  running: "lookup in progress",
  retrying: "lookup timed out, retrying with a smaller search",
  timed_out: "lookup timed out twice — retry: \"Find official form\" (or the next research pass) looks it up again",
  failed: "lookup failed — retry: \"Find official form\" (or the next research pass) looks it up again",
};

/**
 * THE UTILITY'S OWN KB ROW (permit_utility_knowledge, utility-wide: no AHJ, exact profile key) as a
 * filing channel — only its portal URL that FITS the NEM track and this utility by the one rule-5
 * predicate, hostFitsTrackAndEntity, with every platform the row AND the lookup name (issue #31's
 * `namedPlatform`: a lookup that says PowerClerk never takes the utility's info page). Read-only.
 */
function utilityKbChannel(db: AppDb, project: Pick<ProjectRecord, "state" | "utility">, lookupNames: string[]): { url: string; name: string; verified: boolean; source: string } | null {
  if (!str(project.utility)) return null;
  let row: Record<string, unknown> | null | undefined;
  try {
    row = db.get<Record<string, unknown>>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [knowledgeProfileKey({ state: project.state, utility: project.utility })]);
  } catch {
    return null;
  }
  if (!row || str(row.ahj)) return null;
  const named = [str(row.portal_name), str(row.portal_platform), ...lookupNames];
  const entity = portalEntityEvidence(db, { scope: "utility", state: project.state, name: project.utility });
  // Both columns: reference imports file the link in portal_name (as the stage's KB read does).
  const url = [str(row.portal_url), str(row.portal_name)]
    .filter((u) => /^https?:\/\/\S+$/i.test(u))
    .find((u) => hostFitsTrackAndEntity("nem", entity, u, "kb", { namedPlatform: named }).fits);
  if (!url) return null;
  let source = "";
  try {
    const sources = JSON.parse(str(row.sources_json) || "[]") as unknown;
    if (Array.isArray(sources)) source = sources.map((x) => (typeof x === "string" ? x : str((x as { url?: unknown })?.url))).find((x) => /^https?:\/\//i.test(x)) ?? "";
  } catch { /* no citation — the tag still says seeded / verified */ }
  const platform = str(row.portal_platform) || namedInterconnectionPlatforms(named)[0] || "";
  const name = str(row.portal_name) && !/^https?:/i.test(str(row.portal_name)) ? str(row.portal_name) : platform || "Utility interconnection portal";
  return { url, name, verified: isVerifiedKnowledge(row), source };
}

export function utilityTrackPresentation(db: AppDb | null, project: Pick<ProjectRecord, "state" | "utility">): UtilityTrackPresentation {
  const lookup = db ? getUtilityFilingLookup(db, project.state, project.utility) : null;
  const verified = lookup?.confidence === "verified";
  const known = knownOregonNemUtility(project);
  const program: UtilityProgramKind | "unknown" = lookup?.program?.value ?? (known ? "net_metering" : "unknown");
  const lookupFiling = lookup?.filing?.value ?? null;
  // WHICH SOURCE NAMES THE PORTAL (issue #54): verified KB beats seeded lookup beats unconfirmed
  // research. The utility's KB row is consulted when the lookup has no URL ("PowerClerk — tenant URL
  // unconfirmed" from research, while #36's seeded row holds the tenant login), or when a PERSON
  // verified the KB row. A person's verified lookup gives way only to a person's verified KB URL,
  // and only when it has none of its own; nothing here writes (rule 3).
  const kb = db && !(verified && lookupFiling?.url)
    ? utilityKbChannel(db, project, lookupFiling ? [lookupFiling.name, str(lookup?.filing?.quote)] : [])
    : null;
  if (kb && (verified ? kb.verified && !lookupFiling?.url : kb.verified || !lookupFiling?.url)) {
    const tag = kb.verified ? "verified by a person" : "seeded knowledge base — verify";
    const programLabel = UTILITY_TRACK_LABELS[program];
    return {
      label: lookup?.program?.value && lookup.programName ? `${programLabel} — ${lookup.programName}` : programLabel,
      channel: `${kb.name} — ${kb.url} (${tag}${kb.source ? `: ${kb.source}` : ""})`,
      portalUrl: kb.url,
      program,
      basis: kb.verified ? "verified" : "profile",
    };
  }
  const filing = lookupFiling;
  const tag = verified ? "verified by a person" : "cited";
  const status = filing || known ? null : utilityFilingLookupStatus(project.state, project.utility);
  // A named platform with no tenant URL (issue #31: the answer said PowerClerk but gave the utility's
  // own page, which acceptFilingUrl dropped) says so — never a silent bare "PowerClerk".
  const tenantUnconfirmed = filing && !filing.url && namedInterconnectionPlatforms(filing.name).length ? " — tenant URL unconfirmed, verify" : "";
  const channel = filing
    ? `${filing.name}${filing.url ? ` — ${filing.url}` : tenantUnconfirmed} (${tag}: ${lookup!.filing.sourceUrl})`
    : known
      ? known.channel
      : status
        // "not yet identified" stays in the sentence: channelKindOf / the next action read it as unknown.
        ? `Utility interconnection portal — not yet identified: ${UTILITY_LOOKUP_STATUS_TEXT[status.state]}${status.retryAfter ? ` after ${status.retryAfter.slice(0, 16).replace("T", " ")} UTC` : ""} (verify on the utility's interconnection page meanwhile)`
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
