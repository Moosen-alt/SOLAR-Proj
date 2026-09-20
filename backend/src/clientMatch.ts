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

  if (installerIdentityIsEmpty(identity)) {
    return {
      ...base,
      decision: "none",
      explanation: "The plan set did not name an installer, so no client could be suggested — pick the client this project is filed for.",
    };
  }

  const planCcb = normalizeLicence(identity.ccbLicenseNumber);
  const planPhone = normalizePhone(identity.phone);
  const planName = (identity.companyName || "").trim();

  const candidates: ClientMatchCandidate[] = [];
  for (const client of listClients(db, orgId)) {
    const clientCcb = normalizeLicence(client.ccbLicenseNumber);

    // A CONTRADICTED LICENCE DISQUALIFIES THE CLIENT OUTRIGHT. When the plan set
    // prints a CCB and the client has a different one on file, they are two
    // different contractors in the state registry no matter how alike the names
    // read. This is the case the whole feature risks getting wrong — a second solar
    // company with a similar name — so it is settled here and not left to scores.
    if (planCcb && clientCcb && planCcb !== clientCcb) continue;

    const evidence: ClientMatchEvidence[] = [];
    let strong = false;

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
        if (hit.score >= NAME_STRONG) strong = true;
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

  const ccbMatches = candidates.filter((c) => c.evidence.some((e) => e.kind === "ccb"));
  // Exactly one exact licence match is the only thing allowed to bind without a human.
  if (ccbMatches.length === 1) {
    const winner = ccbMatches[0];
    return {
      decision: "auto_assign",
      clientId: winner.clientId,
      requiresConfirmation: false,
      candidates,
      installer: identity,
      explanation: `Assigned to ${winner.companyName}: ${winner.reason}.`,
    };
  }
  if (ccbMatches.length > 1) {
    return {
      ...base,
      decision: "candidates",
      candidates,
      explanation: `${ccbMatches.length} clients share CCB ${identity.ccbLicenseNumber} on file, so nothing was assigned — pick the right company, then fix the duplicate licence under Clients.`,
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
      explanation: `${winner.companyName} looks like the installer on this plan set — ${winner.reason}. No CCB licence number was matched, so please confirm before saving.`,
    };
  }
  if (strongs.length > 1) {
    return {
      ...base,
      decision: "candidates",
      candidates,
      explanation: `More than one client matches "${planName || identity.phone}" — nothing was assigned. Pick the right company below.`,
    };
  }
  if (candidates.length) {
    return {
      ...base,
      decision: "candidates",
      candidates,
      explanation: `"${planName}" is only a partial match for the client${candidates.length > 1 ? "s" : ""} below — nothing was assigned. Pick the right company, or onboard this one as new.`,
    };
  }

  return {
    ...base,
    decision: "none",
    explanation: `No client on file matches "${planName || identity.phone || "the plan set's installer"}". Onboard it as a new client, or pick the right company.`,
  };
}

/**
 * The production entry point: take a parser extraction, keep the installer block it
 * already returns, and say which client it points at. Never throws — a resolution
 * failure must not take down a parse that otherwise worked.
 */
export function resolveClientForExtraction(
  db: AppDb,
  fields: Record<string, ParserExtractedField> | undefined,
  orgId: string | null,
): ClientResolution {
  const identity = installerIdentityFromExtraction(fields);
  return resolveClientFromPlanSet(db, identity, orgId);
}
