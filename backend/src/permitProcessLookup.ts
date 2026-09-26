// THE PER-JOB PERMIT-PROCESS LOOKUP (B11; operator steer 2026-09-25: "It needs to look up the right
// stuff per job"). One lookup, run when a project names an AHJ with no process of its own — at
// project creation (the QC trigger), not at stage time — answering, for ANY AHJ in any state:
//   who issues the permits (the agency), how the work is permitted (combo vs separate), which portal
//   and which record type each permit files under, which documents/forms each permit needs, and
//   what each permit costs.
//
// It survives the failure modes seen on 2026-09-25:
//   - a 180 s abort: TWO calls (process; documents + fees), each with its own timeout, so an abort
//     loses one part, never both, and the part that returned is kept;
//   - max_tokens truncation: compact JSON with short quotes and a generous budget; a cut-off answer
//     whose JSON does not parse is NOT FOUND, never a partial guess;
//   - a help page taken for a portal: every portal answer goes through the same information-page
//     predicate the stage uses (portalChannel.isInformationalPageUrl) and is refused if it is one.
// And it says NOT FOUND instead of guessing: every answer needs a source URL the search returned
// and the words on that page that state it — the quote must itself carry the answer (the agency's
// name, the fee's amount, the structure's words). Nothing from model memory is ever kept.
//
// Output lands 'seeded' through permitProcess.savePermitProcessLookup (a person's verified row is
// never overwritten), and its fees land through feeSchedules.saveFeeSchedule — including the
// DELEGATION (City of Jefferson's fees are collected by Marion County) the fee researcher had read
// and then discarded.
import type { CitedFact, LLMProvider, PermitFeeAnswer, PermitProcessDiscipline, PermitProcessLookup, PermitProcessPermitAnswer } from "../../shared/src/types";
import type { AppDb } from "./db";
import { isInformationalPageUrl, portalHostOf } from "./portalChannel";
import { getPermitProcessLookup, normalizeAhjName, savePermitProcessLookup } from "./permitProcess";
import { logger } from "./logger";
import { feeScheduleProfileKey, saveFeeSchedule } from "./feeSchedules";

export const PROCESS_LOOKUP_SYSTEM = `You look up how RESIDENTIAL ROOFTOP SOLAR PV permits are issued for ONE jurisdiction in the United States.
Answer for the NAMED jurisdiction only (a same-named place in another county or state is a different place).

Find, with web search (and by opening the pages you found):
1. issuingAgency — the agency that issues this jurisdiction's residential building/structural and electrical permits. A city without its own building program is often served by its COUNTY's building-inspection division or by the state; say which, exactly as the source names it (e.g. "Marion County").
2. permitStructure — "separate" when a PV system needs a structural/building permit AND a separate electrical permit; "combo" when one permit covers both.
3. permits — one entry per permit the job needs (discipline "structural", "electrical", or "combo"), each with:
   - portalUrl: the ONLINE PORTAL where that permit is APPLIED FOR (a citizen-access / permitting-system entry page). NEVER an information, help, FAQ or guide page, and NEVER a PDF.
   - recordType: the permit/record type exactly as that portal or agency names it for residential solar (e.g. "Residential Structural").
   - issuingAgency: the agency that issues THIS permit, when it differs by permit.

Where answers may come from: the jurisdiction's own site; its county's building-inspection site; the state building agency; the permitting portal's public pages and public permit records.

EVERY value carries "sourceUrl" (a page your search returned or you opened) and "quote" (the exact words on that page that state it, under 250 characters, containing the answer itself). If you cannot find a page that states it, set "value": null and say what you searched in "notFound". Never answer from memory. Never guess.

Return ONLY JSON (no prose):
{"issuingAgency": {"value": "<agency>"|null, "sourceUrl": "", "quote": "", "notFound": ""},
 "permitStructure": {"value": "separate"|"combo"|null, "sourceUrl": "", "quote": "", "notFound": ""},
 "permits": [{"discipline": "structural"|"electrical"|"combo", "label": "<permit name>",
   "issuingAgency": {"value": ..., "sourceUrl": "", "quote": ""},
   "portalUrl": {"value": "<url>"|null, "sourceUrl": "", "quote": "", "notFound": ""},
   "recordType": {"value": "<type>"|null, "sourceUrl": "", "quote": "", "notFound": ""}}]}`;

export const DOCS_FEES_LOOKUP_SYSTEM = `You look up, for ONE issuing agency, what a RESIDENTIAL ROOFTOP SOLAR PV permit application must include and what each permit costs.

For each permit named in the request (structural and/or electrical, or one combo permit):
- documents: the documents and NAMED forms the agency requires for that permit (e.g. "plan set", "prescriptive solar checklist (BCD 440-5952)", a named application form). Only what a source says the agency requires.
- fee: the agency's fee for THIS job (the request gives the system's DC kW, AC kVA and permit path). Give the total for the permit when the schedule prices it ("amountUsd"), the "basis" in words (e.g. "flat fee for prescriptive-path PV", "tier 5.01-15 kVA"), and "lines" (each printed line with its amount, including any state surcharge the same source states). For a tiered electrical fee also give "tiers": [{"maxKva": <number>, "amountUsd": <number>, "label": "<printed tier>"}].

EVERY value carries "sourceUrl" (a page your search returned or you opened — the agency's own fee schedule or form is best) and "quote" (the exact printed words, under 250 characters; for a fee the quote must contain the amount). If a source does not state it, "value": null with "notFound". Never answer from memory. Never guess.

Return ONLY JSON:
{"permits": [{"discipline": "structural"|"electrical"|"combo",
  "documents": {"value": ["..."]|null, "sourceUrl": "", "quote": "", "notFound": ""},
  "fee": {"value": {"amountUsd": <number>|null, "basis": "", "lines": [{"label": "", "amountUsd": <number>}], "tiers": [{"maxKva": <number>, "amountUsd": <number>, "label": ""}]}|null, "sourceUrl": "", "quote": "", "notFound": ""}}]}`;

type RawFact = { value?: unknown; sourceUrl?: unknown; quote?: unknown; notFound?: unknown } | null | undefined;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const words = (s: string) => str(s).toLowerCase().replace(/[^a-z0-9.]+/g, " ").split(" ").filter((w) => w.length > 2 && !["the", "and", "for", "city", "county", "of"].includes(w));

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const t = str(text);
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
}

/** A cited answer is kept only when it has a real source, a quote, the source is one the search
 *  returned (when we know them), and the quote itself supports the value. */
export function acceptCited<T>(
  raw: RawFact,
  opts: { seenUrls: string[]; supports: (value: T, quote: string) => boolean; coerce: (v: unknown) => T | null; what: string },
): CitedFact<T> {
  const notFound = (why: string): CitedFact<T> => ({ value: null, sourceUrl: str(raw?.sourceUrl), quote: str(raw?.quote).slice(0, 300), origin: "lookup", notFound: why });
  if (!raw || raw.value == null || raw.value === "") return notFound(str(raw?.notFound) || `no source stated the ${opts.what}`);
  const value = opts.coerce(raw.value);
  if (value == null) return notFound(`the ${opts.what} returned was not usable`);
  const sourceUrl = str(raw.sourceUrl);
  const quote = str(raw.quote).slice(0, 300);
  if (!/^https?:\/\//i.test(sourceUrl) || quote.length < 8) return notFound(`the ${opts.what} came without a source page and its words — not kept`);
  const host = portalHostOf(sourceUrl);
  if (opts.seenUrls.length && !opts.seenUrls.some((u) => portalHostOf(u) === host)) {
    return notFound(`the ${opts.what}'s source (${host}) is not a page the search returned — not kept`);
  }
  if (!opts.supports(value, quote)) return notFound(`the quoted words do not state the ${opts.what} ("${quote.slice(0, 80)}")`);
  return { value, sourceUrl, quote, origin: "lookup" };
}

const supportsName = (value: string, quote: string) => {
  const w = words(value);
  const q = quote.toLowerCase();
  return w.length > 0 && w.every((x) => q.includes(x));
};
const supportsStructure = (value: string, quote: string) =>
  value === "separate"
    ? /separate|electrical permit|also (?:need|require)|in addition|two permits|each (?:require|need)/i.test(quote)
    : /combin|combo|single permit|one permit|includes? (?:the )?electrical/i.test(quote);
const supportsAmount = (fee: PermitFeeAnswer, quote: string) => {
  const amounts = [fee.amountUsd, ...fee.lines.map((l) => l.amountUsd)].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (!amounts.length) return false;
  const q = quote.replace(/,/g, "");
  return amounts.some((n) => q.includes(n.toFixed(2)) || q.includes(String(n)));
};
const asDiscipline = (v: unknown): PermitProcessDiscipline | null => {
  const s = str(v).toLowerCase();
  if (/elec/.test(s)) return "electrical";
  if (/struct|build/.test(s)) return "structural";
  if (/combo|combin/.test(s)) return "combo";
  return s ? "other" : null;
};

export function parseProcessPart(text: string, seenUrls: string[], stopReason: string | null): {
  issuingAgency: CitedFact<string>; permitStructure: CitedFact<"separate" | "combo">; permits: PermitProcessPermitAnswer[]; problem: string;
} {
  const truncated = stopReason === "max_tokens" || stopReason === "pause_turn";
  const json = parseJsonLoose(text);
  const nf = (why: string) => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });
  if (!json) {
    const why = truncated ? "the lookup's answer was cut off before it finished — not kept" : "the lookup returned no readable answer";
    return { issuingAgency: nf(why), permitStructure: nf(why), permits: [], problem: why };
  }
  const issuingAgency = acceptCited<string>(json.issuingAgency as RawFact, { seenUrls, what: "issuing agency", coerce: (v) => str(v) || null, supports: supportsName });
  const permitStructure = acceptCited<"separate" | "combo">(json.permitStructure as RawFact, {
    seenUrls, what: "permit structure", coerce: (v) => (/separ/i.test(str(v)) ? "separate" : /combo|combin/i.test(str(v)) ? "combo" : null), supports: supportsStructure,
  });
  const permits: PermitProcessPermitAnswer[] = [];
  for (const p of (Array.isArray(json.permits) ? json.permits : []) as Array<Record<string, unknown>>) {
    const discipline = asDiscipline(p?.discipline);
    if (!discipline) continue;
    let portalUrl = acceptCited<string>(p.portalUrl as RawFact, {
      seenUrls, what: "portal", coerce: (v) => (/^https?:\/\//i.test(str(v)) ? str(v) : null),
      // A portal's own page, or a page that names the portal's host.
      supports: (v, q) => {
        const host = portalHostOf(v);
        return Boolean(host) && (q.toLowerCase().includes(host) || /portal|apply online|e-?permitting|citizen access|online permit|accela/i.test(q));
      },
    });
    if (portalUrl.value && isInformationalPageUrl(portalUrl.value)) {
      portalUrl = { ...portalUrl, value: null, notFound: `${portalUrl.value} is an information page, not an application portal — not kept` };
    }
    permits.push({
      discipline,
      label: str(p.label) || discipline,
      issuingAgency: acceptCited<string>(p.issuingAgency as RawFact, { seenUrls, what: "issuing agency", coerce: (v) => str(v) || null, supports: supportsName }),
      portalUrl,
      recordType: acceptCited<string>(p.recordType as RawFact, { seenUrls, what: "record type", coerce: (v) => str(v) || null, supports: supportsName }),
      documents: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not looked up yet" },
      fee: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not looked up yet" },
    });
  }
  return { issuingAgency, permitStructure, permits, problem: truncated ? "answer was cut off (kept only fully parsed, cited values)" : "" };
}

export function parseDocsFeesPart(text: string, seenUrls: string[], stopReason: string | null): {
  byDiscipline: Map<PermitProcessDiscipline, { documents: CitedFact<string[]>; fee: CitedFact<PermitFeeAnswer> }>; problem: string;
} {
  const out = new Map<PermitProcessDiscipline, { documents: CitedFact<string[]>; fee: CitedFact<PermitFeeAnswer> }>();
  const json = parseJsonLoose(text);
  if (!json) return { byDiscipline: out, problem: stopReason === "max_tokens" || stopReason === "pause_turn" ? "documents/fees answer was cut off — not kept" : "documents/fees lookup returned no readable answer" };
  for (const p of (Array.isArray(json.permits) ? json.permits : []) as Array<Record<string, unknown>>) {
    const discipline = asDiscipline(p?.discipline);
    if (!discipline) continue;
    const documents = acceptCited<string[]>(p.documents as RawFact, {
      seenUrls, what: "required documents",
      coerce: (v) => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, 20) : null),
      supports: (v, q) => v.some((d) => words(d).some((w) => q.toLowerCase().includes(w))),
    });
    const fee = acceptCited<PermitFeeAnswer>(p.fee as RawFact, {
      seenUrls, what: "fee",
      coerce: (v) => {
        const o = v as Record<string, unknown>;
        if (!o || typeof o !== "object") return null;
        const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : Number.isFinite(Number(x)) && str(x) !== "" ? Number(x) : null);
        const lines = (Array.isArray(o.lines) ? o.lines : []).map((l: Record<string, unknown>) => ({ label: str(l?.label), amountUsd: num(l?.amountUsd) as number })).filter((l) => l.label && l.amountUsd != null);
        const tiers = (Array.isArray(o.tiers) ? o.tiers : []).map((t: Record<string, unknown>) => ({ maxKva: num(t?.maxKva), amountUsd: num(t?.amountUsd), label: str(t?.label) }))
          .filter((t) => t.maxKva != null && t.amountUsd != null) as Array<{ maxKva: number; amountUsd: number; label: string }>;
        const answer: PermitFeeAnswer & { tiers?: typeof tiers } = { amountUsd: num(o.amountUsd), basis: str(o.basis), lines };
        if (tiers.length) answer.tiers = tiers;
        return answer.amountUsd == null && !lines.length && !tiers.length ? null : answer;
      },
      supports: supportsAmount,
    });
    out.set(discipline, { documents, fee });
  }
  return { byDiscipline: out, problem: "" };
}

export interface PermitProcessLookupRun {
  saved: boolean;
  reason: string;
  lookup: PermitProcessLookup | null;
  calls: Array<{ part: string; grounded: number; stopReason: string | null; error?: string; pagesRead: number }>;
}

/**
 * Run the lookup for one AHJ and land it. `force` re-runs over a seeded row (never over a verified
 * one — the write path refuses). System facts (DC kW / AC kVA / path) only shape the fee question.
 */
export async function runPermitProcessLookup(
  db: AppDb,
  llm: Pick<LLMProvider, "webLookup">,
  input: { state: string; ahj: string; utility?: string; dcKw?: string | number; acKw?: string | number; permitPath?: string; force?: boolean },
): Promise<PermitProcessLookupRun> {
  const calls: PermitProcessLookupRun["calls"] = [];
  const existing = getPermitProcessLookup(db, input.state, input.ahj);
  if (existing?.confidence === "verified") return { saved: false, reason: "a person verified this AHJ's process", lookup: existing, calls };
  if (existing && !input.force) return { saved: false, reason: "already looked up (seeded)", lookup: existing, calls };
  if (!llm.webLookup) return { saved: false, reason: "no web lookup available (no model key)", lookup: existing, calls };

  const where = `Jurisdiction: ${input.ahj}\nState: ${input.state}`;
  const p1 = await llm.webLookup({ label: "permitProcessLookup.process", system: PROCESS_LOOKUP_SYSTEM, user: where, maxTokens: 6000, maxSearches: 6, readPages: true });
  calls.push({ part: "process", grounded: p1.groundedSearches, stopReason: p1.stopReason, error: p1.error, pagesRead: p1.pagesRead });
  const ungrounded = (why: string) => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });
  const part1 = p1.groundedSearches > 0
    ? parseProcessPart(p1.text, p1.resultUrls, p1.stopReason)
    : { issuingAgency: ungrounded(p1.error ? `lookup failed: ${p1.error.slice(0, 120)}` : "no web search returned results — nothing kept from memory"), permitStructure: ungrounded("no grounded search"), permits: [] as PermitProcessPermitAnswer[], problem: p1.error ?? "ungrounded" };

  // The documents/fees question is asked of the ISSUING AGENCY the first part found (the county,
  // for a city it serves); with no agency, of the AHJ itself.
  const agency = part1.issuingAgency.value || input.ahj;
  const disciplines = part1.permits.length ? part1.permits.map((p) => p.discipline) : (part1.permitStructure.value === "combo" ? ["combo"] : ["structural", "electrical"]);
  const p2 = await llm.webLookup({
    label: "permitProcessLookup.documentsFees", system: DOCS_FEES_LOOKUP_SYSTEM,
    user: `Issuing agency: ${agency}\nFor permits in: ${input.ahj}, ${input.state}\nPermits: ${disciplines.join(", ")}\nSystem: ${str(input.dcKw) || "?"} kW DC, ${str(input.acKw) || "?"} kVA AC, permit path: ${str(input.permitPath) || "unknown"}`,
    maxTokens: 6000, maxSearches: 5, readPages: true,
  });
  calls.push({ part: "documentsFees", grounded: p2.groundedSearches, stopReason: p2.stopReason, error: p2.error, pagesRead: p2.pagesRead });
  const part2 = p2.groundedSearches > 0 ? parseDocsFeesPart(p2.text, p2.resultUrls, p2.stopReason) : { byDiscipline: new Map(), problem: p2.error ?? "ungrounded" };

  const permits: PermitProcessPermitAnswer[] = (part1.permits.length ? part1.permits : disciplines.map((d) => ({
    discipline: d as PermitProcessDiscipline, label: d,
    issuingAgency: ungrounded("not found"), portalUrl: ungrounded("not found"), recordType: ungrounded("not found"),
    documents: ungrounded("not found"), fee: ungrounded("not found"),
  }))).map((p) => {
    const df = part2.byDiscipline.get(p.discipline);
    return df ? { ...p, documents: df.documents, fee: df.fee } : { ...p, documents: ungrounded(part2.problem || "not found"), fee: ungrounded(part2.problem || "not found") };
  });
  const notes = [part1.problem, part2.problem].filter(Boolean);
  const res = savePermitProcessLookup(db, {
    state: input.state, ahj: input.ahj, lookedUpAt: new Date().toISOString(),
    issuingAgency: part1.issuingAgency, permitStructure: part1.permitStructure, permits, notes,
  });
  if (res.saved && res.lookup) {
    try { applyLookupFees(db, res.lookup); } catch (err) { logger.warn("permit-process", `fee landing failed: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return { saved: res.saved, reason: res.reason, lookup: res.lookup, calls };
}

/**
 * THE LOOKUP'S FEES LAND THROUGH THE FEE WRITE PATH. When a DIFFERENT agency issues the permits
 * (a county for a city), the AHJ's rows DELEGATE to that agency (collectedByProfileKey, sourced
 * by the agency answer's citation); the agency's per-discipline fees are saved under ITS key.
 * saveFeeSchedule keeps every refusal it owns (verified rows, open conflicts, unsourced fees).
 */
export function applyLookupFees(db: AppDb, lookup: PermitProcessLookup): Array<{ discipline: string; saved: boolean; reason: string }> {
  const out: Array<{ discipline: string; saved: boolean; reason: string }> = [];
  for (const permit of lookup.permits) {
    if (permit.discipline === "other") continue;
    const agency = permit.issuingAgency.value ? permit.issuingAgency : lookup.issuingAgency;
    const agencyName = str(agency.value);
    const delegates = agencyName && normalizeAhjName(agencyName) !== normalizeAhjName(lookup.ahj);
    const owner = delegates ? agencyName : lookup.ahj;
    if (delegates) {
      const r = saveFeeSchedule(db, { state: lookup.state, ahj: lookup.ahj, track: "permit", discipline: permit.discipline }, {
        found: true, reason: "", basis: "other", brackets: [], sourceUrl: agency.sourceUrl, sourceQuote: agency.quote, sourceKind: "official",
        collectedByProfileKey: feeScheduleProfileKey({ state: lookup.state, ahj: agencyName }, "permit"),
        notes: `Per-job lookup: ${agencyName} issues ${lookup.ahj}'s ${permit.discipline} permits.`,
      });
      out.push({ discipline: `${permit.discipline} (delegation)`, saved: r.saved, reason: r.reason ?? "" });
    }
    const fee = permit.fee;
    if (!fee.value) continue;
    const tiers = (fee.value as PermitFeeAnswer & { tiers?: Array<{ maxKva: number; amountUsd: number; label: string }> }).tiers ?? [];
    const brackets = tiers.length
      ? tiers.map((t, i) => ({ minKw: i === 0 ? 0 : tiers[i - 1].maxKva, maxKw: t.maxKva, feeUsd: t.amountUsd, label: t.label || `up to ${t.maxKva} kVA` }))
      : [{ feeUsd: fee.value.amountUsd ?? fee.value.lines[0]?.amountUsd ?? NaN, label: fee.value.lines[0]?.label || fee.value.basis || `${permit.label} fee` }];
    const r = saveFeeSchedule(db, { state: lookup.state, ahj: owner, track: "permit", discipline: permit.discipline }, {
      found: true, reason: "", basis: tiers.length ? "system_kw" : "flat", brackets, sourceUrl: fee.sourceUrl, sourceQuote: fee.quote, sourceKind: "official",
      notes: `Per-job lookup (seeded): ${fee.value.basis}`.slice(0, 400),
    });
    out.push({ discipline: permit.discipline, saved: r.saved, reason: r.reason ?? "" });
  }
  return out;
}

/**
 * THE TRIGGER (project creation / first QC): enqueue the lookup for an AHJ that has no process of its
 * own — no lookup row, no hand-written profile, no seeded process profile — when a model key and the
 * job worker are available. Returns true when a lookup was queued (the caller then leaves fee
 * research to the lookup job, which knows WHICH agency to research).
 */
export async function ensurePermitProcessLookedUp(
  db: AppDb,
  project: { id: string; state: string; ahj: string; utility?: string; parserSnapshot?: Record<string, unknown> },
): Promise<boolean> {
  if (process.env.PERMIT_PROCESS_LOOKUP === "off" || !process.env.ANTHROPIC_API_KEY) return false;
  const ahj = str(project.ahj);
  if (!ahj || !str(project.state)) return false;
  if (getPermitProcessLookup(db, project.state, ahj)) return false;
  try {
    const { findAhjProcessProfile } = await import("./processProfiles");
    if (findAhjProcessProfile(project as never)) return false;
    const jobQueue = await import("./jobQueue");
    if (!jobQueue.jobWorkerRunning()) return false;
    const key = `${str(project.state).toLowerCase()}|${normalizeAhjName(ahj)}`;
    const recent = db.get<{ id: string }>(
      "SELECT id FROM job_queue WHERE job_type = 'permit_process_lookup' AND payload LIKE ? AND (status IN ('pending','running') OR created_at > ?) LIMIT 1",
      [`%"lookupKey":${JSON.stringify(key)}%`, new Date(Date.now() - 24 * 3600 * 1000).toISOString()],
    );
    if (recent) return true;
    const snap = project.parserSnapshot ?? {};
    jobQueue.enqueueJob(db, "permit_process_lookup", {
      state: str(project.state), ahj, utility: str(project.utility), lookupKey: key,
      dcKw: str(snap.dcKw ?? snap.systemSizeDcKw), acKw: str(snap.acKw ?? snap.systemSizeAcKw), permitPath: str(snap.permitPath),
    }, { priority: 3, maxRetries: 2, projectId: project.id });
    logger.info("permit-process", `per-job permit-process lookup queued for ${ahj} (${project.state})`);
    return true;
  } catch {
    return false;
  }
}
