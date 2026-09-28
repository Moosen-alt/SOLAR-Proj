// WHERE DOES THIS AHJ FILE? — the database's evidence for permitProcess.statewidePortalFor
// (portal-truth D1). ONE collector, read by the stage (repository.prepareSubmission) and the track
// card (submittalTracks.channelResolution), so the two can never disagree about whether the
// statewide portal applies.
//
// Every source is the AHJ's OWN (or, for a permit another agency issues, THAT agency's own):
//   - the hand-written registry profile (a person wrote it for this jurisdiction);
//   - the seeded process profile (the operator's reference sheet);
//   - knowledge-base rows for this exact AHJ — their URLs; a learned row's portal NAME is often the
//     generic fallback's own words ("Oregon ePermitting") laundered into the row, and must never
//     vouch for the fallback that wrote it. A PERSON-VERIFIED row's words are its person's answer
//     (Salem: "OR E-permitting", no URL) and are read through classifyChannelWords; every verified
//     row's evidence is marked `verified` and decides outright (statewidePortalFor, hard rule 3);
//   - recipes keyed to this AHJ (a recipe the statewide portal REFUSED — "not served here" —
//     says "elsewhere");
//   - the client's stored logins naming this AHJ's own tenant (aca-prod.accela.com/CORVALLIS);
//   - the agency the per-job lookup says issues this track's permit, by the same sources.
// Reads only; writes nothing.
import type { ProjectRecord } from "../../shared/src/types";
import type { AppDb } from "./db";
import { registryApplicationProfileFor } from "./applicationDocs";
import { findAhjProcessProfile } from "./processProfiles";
import { ahjNameCore, classifyChannelWords, isStatewidePortalUrl, issuingAgencyFor, normalizeAhjName, permitProcessFor, statewidePortalFor, statewidePortalName, type StatewideDecision, type StatewideEvidence } from "./permitProcess";
import { isInformationalPageUrl, isPathTenantedHost, portalHostOf, portalTenantOf, trackSafeUrl } from "./portalChannel";
import { isVerifiedKnowledge } from "./knowledgeBase";
import { NOT_SERVED_FLAG_PREFIX } from "../../shared/src/portalNotServed";

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();

/** A submission method that names only the generic online channel ("online portal", "Online", "web
 *  portal") says nothing about WHICH portal — classifyChannelWords would read its bare "portal" as
 *  another system's, flipping a verified "OR E-permitting" + "online portal" row to "elsewhere". */
const GENERIC_ONLINE_METHOD = /^\W*(?:on[\s-]?line|web|internet|electronic(?:ally)?)?\W*(?:portal|submittal|submission|application)?\W*$/i;

/** WHAT A PERSON-VERIFIED ROW'S WORDS SAY about the statewide portal: its portal name and its
 *  submission method, each through classifyChannelWords (a generic-online method is neutral).
 *  Either saying "elsewhere" is elsewhere; else either saying "statewide" is statewide. */
function verifiedRowWords(state: string, name: string, method: string, ownNames: string[]): { verdict: "statewide" | "elsewhere" | "neutral"; words: string } {
  const parts = [
    { words: name, verdict: name ? classifyChannelWords(state, name, ownNames) : "neutral" as const },
    { words: method, verdict: method && !GENERIC_ONLINE_METHOD.test(method) ? classifyChannelWords(state, method, ownNames) : "neutral" as const },
  ];
  const hit = parts.find((p) => p.verdict === "elsewhere") ?? parts.find((p) => p.verdict === "statewide");
  return hit ? { verdict: hit.verdict, words: hit.words } : { verdict: "neutral", words: "" };
}


/** Evidence about ONE jurisdiction name. `who` prefixes each detail ("issuing agency Marion County: "). */
function evidenceForName(db: AppDb | null, state: string, ahj: string, city: string, track: string | null | undefined, who: string, clientId: string | null): StatewideEvidence[] {
  const out: StatewideEvidence[] = [];
  const label = who ? `${who}: ` : "";
  const name = statewidePortalName(state) || "the statewide portal";
  // 1. The hand-written registry profile.
  const registry = registryApplicationProfileFor({ state, ahj, city } as never);
  if (registry) {
    const words = s(registry.submissionMethod) || s(registry.portalName);
    const verdict = classifyChannelWords(state, words, registry.matchJurisdictions);
    const onState = isStatewidePortalUrl(state, registry.sourceUrl);
    if (verdict === "elsewhere") out.push({ kind: "elsewhere", source: `${label}hand-written profile "${registry.name}"`, detail: `${label}the hand-written profile "${registry.name}" says "${words}"` });
    else if (verdict === "statewide" || onState) out.push({ kind: "statewide", source: `${label}hand-written profile "${registry.name}"`, detail: `${label}the hand-written profile "${registry.name}" files on ${name}`, url: onState ? registry.sourceUrl : undefined });
  }
  // 2. The seeded process profile (only when a DIFFERENT jurisdiction than the project's own — the
  //    caller passes the project's own through statewidePortalFor's processProfileMethod).
  if (who) {
    const proc = findAhjProcessProfile({ state, ahj, city } as never);
    const method = s(proc?.submissionMethod);
    const verdict = method ? classifyChannelWords(state, method, [ahj, s(proc?.ahj)]) : "neutral";
    if (verdict !== "neutral") out.push({ kind: verdict, source: `${label}seeded process profile`, detail: `${label}the seeded process profile says "${method.slice(0, 120)}"` });
    // The agency's own per-job lookup: a portal it found (or named) for its permits.
    const lk = permitProcessFor({ state, ahj });
    for (const p of lk?.permits ?? []) {
      const u = s(p.portalUrl?.value);
      if (!u || isInformationalPageUrl(u) || !trackSafeUrl("building", u)) continue;
      const onState = isStatewidePortalUrl(state, u);
      out.push({ kind: onState ? "statewide" : "elsewhere", source: `${label}per-job lookup`, url: u, detail: `${label}its per-job lookup found ${u}` });
    }
  }
  if (!db) return out;
  const key = normalizeAhjName(ahj);
  // 3. Knowledge-base rows for this exact jurisdiction name (same state) — URLs; and a PERSON-
  //    VERIFIED row's words too (its person's answer), every verified item marked `verified`.
  try {
    const mine = db.query<Row>(
      "SELECT ahj, portal_url, portal_name, submission_method, confidence, verified_at FROM permit_utility_knowledge WHERE ahj IS NOT NULL AND ahj != '' AND lower(state) = lower(?)",
      [state],
    ).filter((x) => normalizeAhjName(s(x.ahj)) === key);
    for (const r of mine) {
      const verified = isVerifiedKnowledge(r);
      const how = verified ? "verified" : s(r.confidence) || "stored";
      for (const u of [s(r.portal_url), s(r.portal_name)]) {
        if (!/^https?:\/\//i.test(u) || !portalHostOf(u) || isInformationalPageUrl(u) || !trackSafeUrl("building", u)) continue;
        const onState = isStatewidePortalUrl(state, u);
        out.push({ kind: onState ? "statewide" : "elsewhere", source: `${label}knowledge-base row (${how})`, url: u, detail: `${label}a ${how} knowledge-base row names ${u}`, ...(verified ? { verified: true } : {}) });
      }
      if (verified) {
        const said = verifiedRowWords(state, /^https?:\/\//i.test(s(r.portal_name)) ? "" : s(r.portal_name), s(r.submission_method), [ahj, s(r.ahj)]);
        if (said.verdict !== "neutral") {
          out.push({ kind: said.verdict, source: `${label}knowledge-base row (verified)`, detail: `${label}a person's verified knowledge-base row says "${said.words.slice(0, 120)}"`, verified: true });
        }
      }
    }
  } catch { /* table missing on an old schema */ }
  // 4. Recipes keyed to this jurisdiction (this track's discipline, a legacy row, or a combo).
  try {
    const recipes = db.query<Row>(
      "SELECT id, ahj, portal_url, status, discipline, flag_reason FROM portal_recipes WHERE scope_type = 'ahj' AND lower(state) = lower(?)",
      [state],
    ).filter((x) => normalizeAhjName(s(x.ahj)) === key);
    const want = track === "building" ? "structural" : track === "electrical" || track === "mpu" ? "electrical" : track === "combo" ? "combo" : "";
    for (const r of recipes) {
      const d = s(r.discipline);
      if (want && d && d !== want && d !== "combo") continue;
      const u = s(r.portal_url);
      if (!portalHostOf(u) || isInformationalPageUrl(u) || !trackSafeUrl("building", u)) continue;
      const onState = isStatewidePortalUrl(state, u);
      const flag = s(r.flag_reason);
      if (flag.startsWith(NOT_SERVED_FLAG_PREFIX)) {
        out.push({ kind: "elsewhere", source: `${label}recipe ${s(r.id).slice(0, 8)} (refused)`, url: u, detail: `${label}${portalHostOf(u)} itself said this address is not served there (${flag.slice(NOT_SERVED_FLAG_PREFIX.length).trim().slice(0, 140)})` });
        continue;
      }
      out.push({ kind: onState ? "statewide" : "elsewhere", source: `${label}recipe ${s(r.id).slice(0, 8)} (${s(r.status)})`, url: u, detail: `${label}a ${s(r.status)} recipe for ${ahj} runs on ${u}` });
    }
  } catch { /* table missing */ }
  // 5. The client's stored logins naming this jurisdiction's OWN tenant on a shared instance.
  const core = ahjNameCore(ahj);
  if (clientId && core.length >= 4) {
    try {
      const creds = db.query<Row>("SELECT portal_url FROM portal_credentials WHERE client_id = ?", [clientId]);
      for (const c of creds) {
        const u = s(c.portal_url);
        const host = portalHostOf(u);
        if (!host || !isPathTenantedHost(host) || isStatewidePortalUrl(state, u)) continue;
        const tenant = portalTenantOf(u).replace(/[^a-z0-9]/g, "");
        if (tenant && (tenant === core || tenant.startsWith(core))) {
          out.push({ kind: "elsewhere", source: `${label}stored login`, url: u, detail: `${label}a stored login names ${host}/${portalTenantOf(u).toUpperCase()}, ${ahj}'s own tenant` });
        }
      }
    } catch { /* table missing */ }
  }
  return out;
}

/** The database's evidence about where this project's AHJ files this track's permit — the AHJ's
 *  own, and the issuing agency's when the per-job lookup says another agency issues it. */
export function statewideEvidenceFor(
  db: AppDb | null,
  project: Pick<ProjectRecord, "state" | "ahj" | "city"> & { clientId?: string | null },
  track: string | null | undefined,
): StatewideEvidence[] {
  const state = s(project.state);
  const ahj = s(project.ahj);
  if (!state || !ahj) return [];
  const out = evidenceForName(db, state, ahj, s(project.city), track, "", project.clientId ?? null);
  const agency = s(issuingAgencyFor(project, track)?.value);
  if (agency && normalizeAhjName(agency) !== normalizeAhjName(ahj)) {
    out.push(...evidenceForName(db, state, agency, "", track, `issuing agency ${agency}`, null));
  }
  return out;
}

/** THE STATEWIDE DECISION for this project's track — the collector, the AHJ's own seeded process
 *  method and statewidePortalFor, in ONE place: the stage, the track card and the stored-URL gate
 *  below all ask this, so none can disagree. null = the state has no statewide portal. */
export function statewideDecisionFor(
  db: AppDb | null,
  project: Pick<ProjectRecord, "state" | "ahj" | "city"> & { clientId?: string | null },
  track: string | null | undefined,
): StatewideDecision | null {
  return statewidePortalFor(project, track, {
    processProfileMethod: findAhjProcessProfile(project as never)?.submissionMethod ?? null,
    evidence: statewideEvidenceFor(db, project, track),
  });
}

/**
 * A STORED / LEARNED / RESEARCHED URL ON THE STATEWIDE HOST FOR AN AHJ THAT FILES ELSEWHERE — the
 * one predicate (portal-truth D1, at every door). The reason it is refused, or "" when it is not.
 *
 * Corvallis again: with D1 withholding the fallback, cold-start research answered the statewide
 * portal, saved it into the city's knowledge-base row, and the NEXT stage served it from that row
 * (or the learned profile) before D1 was ever asked. So a statewide URL from any source but D1
 * itself (and a person) is judged by D1's evidence: refused when that evidence says this AHJ (or the
 * agency issuing its permit) files ELSEWHERE — never written into the AHJ's row, never served.
 * NOT refused when a person's verified row says the statewide portal (the evidence then decides
 * "statewide"), nor when NOTHING is on file ("unknown"): research is how such an AHJ recovers
 * (Josephine County). Gated on "elsewhere", never on "withheld". Reads only.
 */
export function statewideUrlRefusal(
  db: AppDb | null,
  project: Pick<ProjectRecord, "state" | "ahj" | "city"> & { clientId?: string | null },
  track: string | null | undefined,
  url: string | null | undefined,
  decision?: StatewideDecision | null,
): string {
  const u = s(url);
  if (!u || !isStatewidePortalUrl(project.state, u)) return "";
  const d = decision === undefined ? statewideDecisionFor(db, project, track) : decision;
  if (!d || d.url !== null || d.because !== "elsewhere") return "";
  const ahj = s(project.ahj) || "this AHJ";
  const name = statewidePortalName(project.state) || "the statewide portal";
  const why = d.evidence.filter((e) => e.kind === "elsewhere" && (e.verified || !d.evidence.some((x) => x.verified))).slice(0, 1).map((e) => e.detail).join("");
  return `${portalHostOf(u)} is ${name}, and what is on file says ${ahj} files elsewhere${why ? ` (${why.slice(0, 200)})` : ""} — a stored, learned or researched statewide URL is not taken over that; a person confirms ${ahj}'s portal`;
}
