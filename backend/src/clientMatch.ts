/**
 * AUTO-ASSIGN THE COMPANY FROM THE PLAN SET.
 *
 * The operator's ask, in their words: "Most plansets have the company name on the
 * top of them. Could we use that as a way to have them submitting. Then it auto
 * assigns them to the right company as they come in?" — and from the other side of
 * their notes: "Need to make company locked parse — don't have them select it
 * themselves."
 *
 * The parser prompt has read the title-block contractor since long before this
 * module existed (llm.ts, "CLIENT ONBOARDING" block) and dropped it on the floor.
 * This is the piece that turns that reading into a client binding.
 *
 * WHAT THE REAL PLAN SETS ACTUALLY CARRY (measured, not assumed — 10 plan sets
 * sampled from L:/INFINITY SOLAR DOCS/01 - CUSTOMERS, plus every one of the 23
 * pages of "Bren Trask - Portland, OR.pdf", plus one live extraction run through
 * this repo's own Claude provider):
 *
 *     contractorCompany = "Infinity Home Solutions"          (conf 0.92)
 *     contractorAddress = "6405 E Mill Plain, Vancouver, WA 98661"
 *     contractorPhone   = "1-800-818-0598"                   (conf 0.90)
 *     contractorCcb     = (ABSENT — no CCB anywhere in the set)
 *
 * So the premise that "Oregon plan sets print the CCB in the title block" is FALSE
 * for this operator's corpus: not one of the sampled sets prints a CCB. And the
 * printed company name, "INFINITY HOME SOLUTIONS", scores ZERO against both stored
 * names for the only client on file ("TML INTERNATIONAL LLC", dba "Infinity Solar
 * USA") — one shared token out of three-vs-three clears no band in
 * knowledgeNameMatchScore. A CCB-and-name-only resolver would therefore have been a
 * measured no-op on 100% of the real corpus.
 *
 * The phone number is the one exact identifier these plan sets do carry, and it
 * matches the client's business phone digit for digit. So:
 *
 *   · exact CCB on exactly one client  -> AUTO-ASSIGN, no prompt
 *   · exact phone, or a strong name    -> PRE-SELECT, evidence shown, human confirms
 *   · weak, or two plausible companies -> show candidates, assign NOTHING
 *   · nothing                          -> offer to onboard the extracted company
 *
 * A phone number is deliberately NOT allowed to bind on its own. A CCB identifies a
 * contractor in a state registry; a phone number identifies whoever answers it this
 * year. Auto-assigning on a guess files the job under the wrong contractor's
 * LICENCE — worse than asking.
 *
 * LICENCE NUMBERS ARE NOT INTERCHANGEABLE. `clients` carries three of them and this
 * module compares each only against its own kind: plan-set CCB <-> ccb_license_number,
 * and that is the ONLY licence comparison that exists here. The client on file has
 * CCB 223690, electrical licence C1556 and metro/city licence 14838; letting an
 * electrical or metro licence satisfy a CCB test would mean a company whose
 * electrical licence happens to read "223690" could be auto-assigned another
 * company's jobs. The supervising electrician's personal licence (5787S) is a
 * PERSON, not a company, and is never a matching key at all.
 */
import type {
  ClientMatchCandidate,
  ClientMatchEvidence,
  ClientRecord,
  ClientResolution,
  ParserExtractedField,
  PlanSetInstallerIdentity,
} from "../../shared/src/types";
import type { AppDb } from "./db";
import { listClients } from "./clients";
import { knowledgeNameMatchScore } from "./knowledgeBase";

/** A name hit at or above this is strong enough to pre-select (acronym/containment/exact). */
const NAME_STRONG = 78;
/** Below this a name hit is not worth showing at all. */
const NAME_CANDIDATE = 60;
/** Exact-identifier scores. Phone is exact but is not a licence — see the header. */
const SCORE_CCB = 100;
const SCORE_PHONE = 90;
/**
 * An extracted value below this confidence is not used for matching. The parser's
 * own default for a field that omits confidence is 0.5, so this admits defaults and
 * excludes only values the model flagged as shaky.
 */
const MIN_FIELD_CONFIDENCE = 0.5;

/**
 * Licence numbers compare as bare alphanumerics, case-folded, with a leading "CCB"
 * label stripped: plan sets print "CCB# 223690", "CCB 223690" and "223690" for the
 * same registry id. Returns "" for anything with no alphanumerics left.
 */
export function normalizeLicence(value: string | undefined): string {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const unlabelled = compact.replace(/^CCB/, "");
  return unlabelled || compact;
}

// ── LICENCES IN ANY STATE ────────────────────────────────────────────────────────────────
// A licence number whose FORMAT names its issuer is an exact registry id, the same way a CCB is:
//   Iowa electrical contractor   "EL" + 6 digits + class suffix   (EL208008MA, EL089123REC; "IA-" prefix optional)
//   Florida (DBPR)               EC / ER / CVC / CCC / CGC / CBC / CRC / CPC / CAC / CFC / CMC + digits
//   Texas electrical contractor  TECL + digits
//   Utah DOPL                    8 digits "-" 4 digits (licence number + classification)
// Such a number is compared against EVERY licence the client carries (named columns and
// stateLicenses) whose own value has the SAME format — a distinctive format cannot collide across
// kinds, so the "licences are not interchangeable" rule above still holds. A bare number keeps the
// old rule (CCB <-> ccb_license_number only).
//
// NOT A LICENCE: an EIN-shaped "NN-NNNNNNN" (a real Iowa plan set prints "LICENSE #: 42-0845774"
// in its title block — that is the employer id format). It never matches and never binds.
export type LicenceFormat = "ein" | "ia_electrical" | "fl_dbpr" | "tx_electrical" | "ut_dopl" | "plain";
export function classifyLicence(raw: string | undefined): { format: LicenceFormat; normalized: string } {
  const text = String(raw || "").trim().replace(/^(?:LICEN[CS]E|LIC)\s*(?:NO\.?|NUMBER|#)?\s*[:#]?\s*/i, "");
  if (/^(?:EIN|FEIN|TAX\s*ID)\b/i.test(text) || /^\d{2}-\d{7}$/.test(text)) return { format: "ein", normalized: text.replace(/\D/g, "") };
  const compact = text.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  let m = /^(?:IA-?)?(EL\d{6}[A-Z]{1,4})$/.exec(compact);
  if (m) return { format: "ia_electrical", normalized: m[1] };
  m = /^(EC|ER|CVC|CCC|CGC|CBC|CRC|CPC|CAC|CFC|CMC)-?(\d{5,8})$/.exec(compact);
  if (m) return { format: "fl_dbpr", normalized: m[1] + m[2] };
  m = /^TECL-?(\d{4,6})$/.exec(compact);
  if (m) return { format: "tx_electrical", normalized: `TECL${m[1]}` };
  if (/^\d{6,9}-\d{4}$/.test(compact)) return { format: "ut_dopl", normalized: compact };
  return { format: "plain", normalized: normalizeLicence(text) };
}

/** Every licence the client carries, with the column it came from (for evidence). */
function clientLicences(client: ClientRecord): Array<{ field: ClientMatchEvidence["clientField"]; value: string; format: LicenceFormat; normalized: string }> {
  const raw: Array<{ field: ClientMatchEvidence["clientField"]; value: string }> = [
    { field: "ccb_license_number", value: client.ccbLicenseNumber || "" },
    { field: "electrical_license_number", value: client.electricalLicenseNumber || "" },
    ...(client.stateLicenses ?? []).map((l) => ({ field: "state_licenses" as const, value: l.number })),
  ];
  return raw.filter((r) => r.value.trim()).map((r) => ({ ...r, ...classifyLicence(r.value) }));
}

/**
 * NANP digits. "1-800-818-0598", "(800) 818-0598" and "800.818.0598" are the same
 * number. Anything that is not exactly 10 digits after dropping a leading country
 * code returns "" — a partial phone must never match anything.
 */
export function normalizePhone(value: string | undefined): string {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : "";
}

function fieldText(fields: Record<string, ParserExtractedField> | undefined, key: string): string | undefined {
  const entry = fields?.[key];
  if (!entry || entry.value == null) return undefined;
  if (typeof entry.value === "object") return undefined;
  if ((entry.confidence ?? 0) < MIN_FIELD_CONFIDENCE) return undefined;
  const text = String(entry.value).trim();
  return text || undefined;
}

/**
 * Lift the installer block out of a parser extraction. KEEPING WHAT COMES BACK —
 * this asks the model for nothing new, and nothing here widens what is SENT: the
 * plan set carries homeowner PII, and the only fields read are the ones the prompt
 * already labels as the INSTALLER's business identity.
 */
export function installerIdentityFromExtraction(
  fields: Record<string, ParserExtractedField> | undefined,
): PlanSetInstallerIdentity {
  const identity: PlanSetInstallerIdentity = {
    companyName: fieldText(fields, "contractorCompany"),
    ccbLicenseNumber: fieldText(fields, "contractorCcb"),
    electricalLicenseNumber: fieldText(fields, "contractorElectricalLicense"),
    metroCityLicenseNumber: fieldText(fields, "contractorMetroCityLicense"),
    address: fieldText(fields, "contractorAddress"),
    phone: fieldText(fields, "contractorPhone"),
    email: fieldText(fields, "contractorEmail"),
    supervisorName: fieldText(fields, "contractorSupervisor"),
    electricianLicenseNumber: fieldText(fields, "contractorElectricianLicense"),
  };
  for (const key of Object.keys(identity) as (keyof PlanSetInstallerIdentity)[]) {
    if (identity[key] === undefined) delete identity[key];
  }
  return identity;
}

/** True when the identity carries nothing worth matching on. */
export function installerIdentityIsEmpty(identity: PlanSetInstallerIdentity): boolean {
  return !identity.companyName && !identity.ccbLicenseNumber && !identity.phone;
}

interface NameHit {
  score: number;
  clientField: ClientMatchEvidence["clientField"];
  clientValue: string;
}

/** Best name score across the three names a client can legitimately trade under. */
function bestNameHit(planName: string, client: ClientRecord): NameHit | null {
  const candidates: { field: ClientMatchEvidence["clientField"]; value: string }[] = [
    { field: "company_name", value: client.companyName || "" },
    { field: "legal_business_name", value: client.legalBusinessName || "" },
    { field: "dba", value: client.dba || "" },
  ];
  let best: NameHit | null = null;
  for (const c of candidates) {
    if (!c.value.trim()) continue;
    const score = knowledgeNameMatchScore(planName, c.value);
    if (score >= NAME_CANDIDATE && (!best || score > best.score)) {
      best = { score, clientField: c.field, clientValue: c.value };
    }
  }
  return best;
}

function reasonFor(evidence: ClientMatchEvidence[]): string {
  return evidence
    .map((e) => {
      if (e.kind === "ccb") return `CCB ${e.planSetValue} on the plan set matches this client's CCB licence`;
      if (e.kind === "state_license") return `licence ${e.planSetValue} on the plan set matches this client's licence ${e.clientValue}`;
      if (e.kind === "phone") return `the plan set's phone ${e.planSetValue} matches this client's business phone ${e.clientValue}`;
      return `the plan set's company name "${e.planSetValue}" matches "${e.clientValue}" (${e.score}% name match)`;
    })
    .join("; ");
}

/**
 * Resolve which client a plan set belongs to.
 *
 * `orgId` follows the data-layer convention: a string scopes to that tenant, `null`
 * means read across every org (superadmin). It is REQUIRED, never an optional
 * trailing argument — forgetting it must not silently suggest another tenant's
 * company, which would be the cross-company data error this feature exists to avoid.
 *
 * Returns a decision AND the evidence for it, never a bare id: the picker has to be
 * able to tell an operator why a company was chosen, and a reviewer has to be able
 * to disagree with it.
 */
export function resolveClientFromPlanSet(
  db: AppDb,
  identity: PlanSetInstallerIdentity,
  orgId: string | null,
): ClientResolution {
  const base: Pick<ClientResolution, "clientId" | "requiresConfirmation" | "candidates" | "installer"> = {
    clientId: null,
    requiresConfirmation: true,
    candidates: [],
    installer: identity,
  };

  // Classify every printed licence first. An EIN-shaped number is not a licence: it is dropped
  // from matching and named in the explanation, never compared with anything.
  const rejected: string[] = [];
  const planStateLicences: Array<{ printed: string; format: LicenceFormat; normalized: string }> = [];
  let planCcb = "";
  for (const [printed, fromCcbField] of [[identity.ccbLicenseNumber, true], [identity.electricalLicenseNumber, false]] as const) {
    if (!printed) continue;
    const c = classifyLicence(printed);
    if (c.format === "ein") rejected.push(printed);
    else if (c.format !== "plain") planStateLicences.push({ printed, ...c });
    else if (fromCcbField) planCcb = c.normalized;
  }
  if (rejected.length) identity = { ...identity, rejectedLicenceNumbers: rejected };
  const rejectedNote = rejected.length
    ? ` ${rejected.map((r) => `"${r}"`).join(", ")} ${rejected.length > 1 ? "are" : "is"} shaped like a federal EIN (NN-NNNNNNN), not a contractor licence, and was not used.`
    : "";

  if (installerIdentityIsEmpty({ ...identity, ccbLicenseNumber: planCcb || undefined }) && !planStateLicences.length) {
    return {
      ...base,
      installer: identity,
      decision: "none",
      explanation: `The plan set did not name an installer, so no client could be suggested — pick the client this project is filed for.${rejectedNote}`,
    };
  }

  const planPhone = normalizePhone(identity.phone);
  const planName = (identity.companyName || "").trim();
  // A NAME ONLY IN A LOGO (not in the text layer) can propose candidates, never pre-select.
  const nameCanBeStrong = identity.companyNameInText !== false;

  const candidates: ClientMatchCandidate[] = [];
  /** client id -> the plan licence it carries as a PARTNER's (contractor of record), not its own. */
  const partnerLicenceOf = new Map<string, string>();
  for (const client of listClients(db, orgId)) {
    const clientCcb = normalizeLicence(client.ccbLicenseNumber);
    const own = clientLicences(client);
    const partners = (client.partnerContacts ?? []).map((p) => classifyLicence(p.licenseNumber)).filter((p) => p.normalized);

    // A CONTRADICTED LICENCE DISQUALIFIES THE CLIENT OUTRIGHT. When the plan set
    // prints a CCB and the client has a different one on file, they are two
    // different contractors in the state registry no matter how alike the names
    // read. This is the case the whole feature risks getting wrong — a second solar
    // company with a similar name — so it is settled here and not left to scores.
    if (planCcb && clientCcb && planCcb !== clientCcb) continue;

    const evidence: ClientMatchEvidence[] = [];
    let strong = false;
    let contradicted = false;
    for (const p of planStateLicences) {
      const sameFormat = own.filter((l) => l.format === p.format);
      const hit = sameFormat.find((l) => l.normalized === p.normalized);
      if (hit) {
        evidence.push({ kind: "state_license", clientField: hit.field, planSetValue: p.printed, clientValue: hit.value, score: SCORE_CCB });
        strong = true;
      } else if (partners.some((q) => q.format === p.format && q.normalized === p.normalized)) {
        partnerLicenceOf.set(client.id, p.printed); // the plan prints this client's PARTNER's licence
      } else if (sameFormat.length) {
        contradicted = true; // same issuer and format, a different number: a different contractor
      }
    }
    if (contradicted && !evidence.some((e) => e.kind === "state_license")) continue;

    if (planCcb && clientCcb && planCcb === clientCcb) {
      evidence.push({
        kind: "ccb",
        clientField: "ccb_license_number",
        planSetValue: identity.ccbLicenseNumber || planCcb,
        clientValue: client.ccbLicenseNumber,
        score: SCORE_CCB,
      });
      strong = true;
    }

    if (planPhone) {
      const businessPhone = normalizePhone(client.businessPhone);
      const contactPhone = normalizePhone(client.phone);
      if (businessPhone && businessPhone === planPhone) {
        evidence.push({ kind: "phone", clientField: "business_phone", planSetValue: identity.phone || planPhone, clientValue: client.businessPhone, score: SCORE_PHONE });
        strong = true;
      } else if (contactPhone && contactPhone === planPhone) {
        evidence.push({ kind: "phone", clientField: "phone", planSetValue: identity.phone || planPhone, clientValue: client.phone, score: SCORE_PHONE });
        strong = true;
      }
    }

    if (planName) {
      const hit = bestNameHit(planName, client);
      if (hit) {
        evidence.push({ kind: "name", clientField: hit.clientField, planSetValue: planName, clientValue: hit.clientValue, score: hit.score });
        if (hit.score >= NAME_STRONG && nameCanBeStrong) strong = true;
      }
    }

    if (!evidence.length) continue;
    candidates.push({
      clientId: client.id,
      companyName: client.companyName || client.legalBusinessName || client.id,
      score: Math.max(...evidence.map((e) => e.score)),
      strong,
      evidence,
      reason: reasonFor(evidence),
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.companyName.localeCompare(b.companyName));
  const nameStrong = (c: ClientMatchCandidate) => nameCanBeStrong && c.evidence.some((e) => e.kind === "name" && e.score >= NAME_STRONG);

  const licenceMatches = candidates.filter((c) => c.evidence.some((e) => e.kind === "ccb" || e.kind === "state_license"));

  // THE PLAN SET'S COMPANY IS THE CLIENT, EVEN WHEN THE LICENCE PRINTED IS ITS PARTNER'S. The
  // permit's contractor of record can be a local licensed EC (Iowa City: a national installer's
  // plan set, a local electrical contractor on the permit). When the licence belongs to a partner
  // the named client records, and the plan's company name is that client's (in the text layer),
  // the client is PRE-SELECTED — never the partner auto-assigned — and a human confirms.
  const principal = candidates.filter((c) => partnerLicenceOf.has(c.clientId) && nameStrong(c));
  if (principal.length === 1 && !licenceMatches.some((c) => nameStrong(c))) {
    const winner = principal[0];
    return {
      decision: "preselect",
      clientId: winner.clientId,
      requiresConfirmation: true,
      candidates,
      installer: identity,
      explanation: `${winner.companyName} is the company on this plan set (${winner.reason}); the licence printed, ${partnerLicenceOf.get(winner.clientId)}, is its recorded partner contractor's. Confirm before saving.${rejectedNote}`,
    };
  }

  // Exactly one exact licence match is the only thing allowed to bind without a human.
  if (licenceMatches.length === 1) {
    const winner = licenceMatches[0];
    return {
      decision: "auto_assign",
      clientId: winner.clientId,
      requiresConfirmation: false,
      candidates,
      installer: identity,
      explanation: `Assigned to ${winner.companyName}: ${winner.reason}.${rejectedNote}`,
    };
  }
  if (licenceMatches.length > 1) {
    return {
      ...base,
      installer: identity,
      decision: "candidates",
      candidates,
      explanation: `${licenceMatches.length} clients match the licence on this plan set (${licenceMatches.map((c) => c.companyName).join(", ")}), so nothing was assigned — pick the right company, then fix the duplicate licence under Clients.${rejectedNote}`,
    };
  }

  const strongs = candidates.filter((c) => c.strong);
  if (strongs.length === 1) {
    const winner = strongs[0];
    return {
      decision: "preselect",
      clientId: winner.clientId,
      requiresConfirmation: true,
      candidates,
      installer: identity,
      explanation: `${winner.companyName} looks like the installer on this plan set — ${winner.reason}. No CCB or state licence number was matched, so please confirm before saving.${rejectedNote}`,
    };
  }
  if (strongs.length > 1) {
    return {
      ...base,
      installer: identity,
      decision: "candidates",
      candidates,
      explanation: `More than one client matches "${planName || identity.phone}" — nothing was assigned. Pick the right company below.${rejectedNote}`,
    };
  }
  if (candidates.length) {
    const logoNote = !nameCanBeStrong && planName ? ` The name "${planName}" is not in the plan set's text (a logo), so it can only suggest.` : "";
    return {
      ...base,
      installer: identity,
      decision: "candidates",
      candidates,
      explanation: `"${planName}" is only a partial match for the client${candidates.length > 1 ? "s" : ""} below — nothing was assigned. Pick the right company, or onboard this one as new.${logoNote}${rejectedNote}`,
    };
  }

  return {
    ...base,
    installer: identity,
    decision: "none",
    explanation: `No client on file matches "${planName || identity.phone || "the plan set's installer"}". Onboard it as a new client, or pick the right company.${rejectedNote}`,
  };
}

// ── THE PLAN SET'S LICENCE, AFTER THE JOB IS ASSIGNED ─────────────────────────────────────
// The title block prints the installer's licence (contractorCcb — any state's, as printed; and the
// electrical contractor licence). The parser page keeps it on the project as an OBJECT
// (snapshot.planSetInstaller = { companyName, licences: [...] }) so no value map can ever offer it
// as a field value: it is a REFERENCE for the operator and a cross-check of the assignment, and it
// is never filled into a form or a portal (a plan set's number may be another company's).

/** The licence numbers the plan set's title block printed (never an EIN-shaped number). */
export function planSetPrintedLicences(snapshot: Record<string, unknown> | undefined | null): string[] {
  const block = (snapshot ?? {}).planSetInstaller;
  if (!block || typeof block !== "object") return [];
  const raw = (block as { licences?: unknown }).licences;
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const v of list) {
    const printed = String(v ?? "").trim();
    if (!printed || classifyLicence(printed).format === "ein") continue;
    if (!out.includes(printed)) out.push(printed);
  }
  return out;
}

/** Does this client carry the printed licence? The same comparison resolveClientFromPlanSet makes:
 *  a distinctive format against the client's licences of that format; a plain number against the
 *  client's plain licences (at least five characters — a short number is no identity). */
function clientCarries(client: ClientRecord, printed: string): boolean {
  const p = classifyLicence(printed);
  if (!p.normalized || p.format === "ein" || (p.format === "plain" && p.normalized.length < 5)) return false;
  return clientLicences(client).some((l) => l.format === p.format && l.normalized === p.normalized);
}

/**
 * "The plan set's licence belongs to <other company>; is this job assigned to the right company?" —
 * when the plan set prints a licence that ANOTHER client of this project's org carries and the
 * project's own client does not. null otherwise. Never switches the client: the assignment is the
 * operator's. Scoped to the project's org (hard rule 6: another tenant's company is never named).
 */
export function planSetLicenceWarning(db: AppDb, project: { id?: string; clientId?: string | null; parserSnapshot?: Record<string, unknown> | null; orgId?: string | null }): string | null {
  const printed = planSetPrintedLicences(project.parserSnapshot ?? undefined);
  if (!printed.length || !project.clientId) return null;
  const orgRow = project.id ? db.get<{ org_id?: string | null }>("SELECT org_id FROM projects WHERE id = ?", [project.id]) : null;
  const orgId = String(orgRow?.org_id || project.orgId || "").trim();
  if (!orgId) return null;
  const clients = listClients(db, orgId);
  const own = clients.find((c) => c.id === project.clientId);
  if (!own) return null;
  const foreign: string[] = [];
  let owned = false;
  for (const lic of printed) {
    if (clientCarries(own, lic)) { owned = true; continue; }
    for (const other of clients) {
      if (other.id === own.id || !clientCarries(other, lic)) continue;
      foreign.push(`${lic} (${other.companyName || other.legalBusinessName || "another client"})`);
    }
  }
  if (owned || !foreign.length) return null;
  const ownName = own.companyName || own.legalBusinessName || "the assigned client";
  return `The plan set's licence ${foreign.join(", ")} belongs to another company, not ${ownName} — is this job assigned to the right company?`;
}

/** Is the company name in the plan's text layer? Every significant word of it, order-free (a
 *  title block breaks lines anywhere). undefined when no text was supplied. */
export function companyNameInText(name: string | undefined, planText: string | undefined): boolean | undefined {
  if (!name || planText == null || !planText.trim()) return undefined;
  const words = name.toUpperCase().replace(/&/g, " AND ").split(/[^A-Z0-9]+/).filter((w) => w.length > 1 && !/^(LLC|INC|CO|CORP|THE|AND)$/.test(w));
  if (!words.length) return undefined;
  const text = ` ${planText.toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9]+/g, " ")} `;
  return words.every((w) => text.includes(` ${w} `));
}

/**
 * The production entry point: take a parser extraction, keep the installer block it
 * already returns, and say which client it points at. Never throws — a resolution
 * failure must not take down a parse that otherwise worked. `planText` (the text layer
 * the model read) tells a printed company name from a logo-only one.
 */
export function resolveClientForExtraction(
  db: AppDb,
  fields: Record<string, ParserExtractedField> | undefined,
  orgId: string | null,
  planText?: string,
): ClientResolution {
  const identity = installerIdentityFromExtraction(fields);
  const inText = companyNameInText(identity.companyName, planText);
  return resolveClientFromPlanSet(db, inText === undefined ? identity : { ...identity, companyNameInText: inText }, orgId);
}
