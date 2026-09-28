// WHERE DOES THIS AHJ FILE? — the database's evidence for permitProcess.statewidePortalFor
// (portal-truth D1). ONE collector, read by the stage (repository.prepareSubmission) and the track
// card (submittalTracks.channelResolution), so the two can never disagree about whether the
// statewide portal applies.
//
// Every source is the AHJ's OWN (or, for a permit another agency issues, THAT agency's own):
//   - the hand-written registry profile (a person wrote it for this jurisdiction);
//   - the seeded process profile (the operator's reference sheet);
//   - knowledge-base rows for this exact AHJ — their URLs only: a learned row's portal NAME is
//     often the generic fallback's own words ("Oregon ePermitting") laundered into the row, and
//     must never vouch for the fallback that wrote it;
//   - recipes keyed to this AHJ (a recipe the statewide portal REFUSED — "not served here" —
//     says "elsewhere");
//   - the client's stored logins naming this AHJ's own tenant (aca-prod.accela.com/CORVALLIS);
//   - the agency the per-job lookup says issues this track's permit, by the same sources.
// Reads only; writes nothing.
import type { ProjectRecord } from "../../shared/src/types";
import type { AppDb } from "./db";
import { registryApplicationProfileFor } from "./applicationDocs";
import { findAhjProcessProfile } from "./processProfiles";
import { ahjNameCore, classifyChannelWords, isStatewidePortalUrl, issuingAgencyFor, normalizeAhjName, permitProcessFor, statewidePortalName, type StatewideEvidence } from "./permitProcess";
import { isInformationalPageUrl, isPathTenantedHost, portalHostOf, portalTenantOf, trackSafeUrl } from "./portalChannel";
import { NOT_SERVED_FLAG_PREFIX } from "../../shared/src/portalNotServed";

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();


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
  // 3. Knowledge-base rows for this exact jurisdiction name (same state) — URLs only.
  try {
    const mine = db.query<Row>(
      "SELECT ahj, portal_url, portal_name, confidence, verified_at FROM permit_utility_knowledge WHERE ahj IS NOT NULL AND ahj != '' AND lower(state) = lower(?)",
      [state],
    ).filter((x) => normalizeAhjName(s(x.ahj)) === key);
    for (const r of mine) {
      for (const u of [s(r.portal_url), s(r.portal_name)]) {
        if (!/^https?:\/\//i.test(u) || !portalHostOf(u) || isInformationalPageUrl(u) || !trackSafeUrl("building", u)) continue;
        const onState = isStatewidePortalUrl(state, u);
        const how = r.verified_at ? "verified" : s(r.confidence) || "stored";
        out.push({ kind: onState ? "statewide" : "elsewhere", source: `${label}knowledge-base row (${how})`, url: u, detail: `${label}a ${how} knowledge-base row names ${u}` });
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
