// WHICH OF THIS COMPANY'S JURISDICTIONS ARE READY NOW, WHICH NEED A SUPERVISED FIRST RUN,
// AND WHICH CANNOT BE FILED YET.
//
// That sentence is not a design goal — it is a CONTRACT. The onboarding guide we hand every
// new customer promises a coverage report on day 2-3 of their first week, in exactly those
// three words ("Which of your jurisdictions are ready now, which need a supervised first run,
// and which can't be filed yet"). Until this script existed the answer was assembled by hand
// from `onboarding-readiness.ts`, a recipe list and somebody's memory of which logins had
// actually been accepted — which is to say it was assembled differently every time, by
// whoever happened to do it.
//
// The distinction the three buckets carry is the one a customer actually cares about, and it
// is NOT "do we have a recipe":
//
//   READY NOW            a complete recipe production's own lookup resolves for this track,
//                        AND a stored login this portal has ACCEPTED for THIS customer.
//                        The first filing replays a recorded application.
//   SUPERVISED FIRST RUN everything is in place except proof. Either there is no complete
//                        recipe (the first filing is a learn run), or there is one but this
//                        customer's login has never been accepted on that portal — a recipe
//                        recorded against somebody else's account is not evidence about
//                        theirs. This is the guide's D3-6 "we verify each portal with your
//                        credentials on a real project, one at a time".
//   CANNOT FILE YET      no portal URL, no login, a login with no password, a login the
//                        portal has REFUSED, or a portal that emails a one-time code at
//                        login with nobody named to relay it. Software never clears an MFA
//                        code — that is a person, every session, forever.
//
//   npx tsx scripts/coverage-report.ts --client <id>
//   npx tsx scripts/coverage-report.ts --client <id> --jurisdictions "OR|City of Coos Bay|Pacific Power, IL||Ameren Illinois"
//   npx tsx scripts/coverage-report.ts --client <id> --json > coverage.json
//   npx tsx scripts/coverage-report.ts --client <id> --db backend/data/copy.sqlite
//
// --client         a client id, or a case-insensitive substring of the company / legal name.
//                  Omitted: used automatically only when the database holds exactly one
//                  client, otherwise the candidates are listed and nothing runs.
// --jurisdictions  comma-separated "STATE|AHJ|UTILITY" triples, optionally "STATE|AHJ|UTILITY|DISCIPLINE"
//                  where DISCIPLINE is electrical / structural / combo (default: the generic
//                  permit track, which is what track "permit" passes in production). Any part
//                  may be empty: "IL||Ameren Illinois" is a utility-only NEM jurisdiction.
//                  Omitted: the distinct (state, ahj|city, utility) triples of this client's
//                  own projects — the set the engine would actually resolve against.
//                  The intake file's own `jurisdictions` array is the customer's answer to
//                  S3.5; transcribe it here at kickoff.
// --json           print the machine-readable report and NOTHING else, for the operator to
//                  paste into the customer's report.
// --db <path>      run against a copy instead of AUTOPILOT_DB_PATH.
//
// EVERY JURISDICTION PRODUCES UP TO TWO ROWS, because coverage is per TRACK and a company is
// routinely ready on one and blocked on the other: the permit (AHJ) track and the NEM
// (utility) track resolve different recipes, different portal URLs and different logins.
// They are resolved by the same track-scoped calls production uses and are NEVER crossed —
// a permit track must never resolve a utility portal (safety rule 5), so every permit-side
// URL candidate here passes through the same `isUtilityPlatformUrl` filter
// `prepareSubmission` applies.
//
// READ-ONLY IN ITS OWN CODE: no INSERT, UPDATE or DELETE anywhere below, and it repairs
// nothing it finds. But "read-only" is NOT true of a RUN, and the difference matters before
// you quote it: `openDatabase()` calls `seedInitialKnowledgeBase()` UNVERSIONED on every open
// (backend/src/db.ts -> knowledgeBase.ts), which re-upserts the baseline knowledge rows and
// bumps `permit_utility_knowledge.updated_at` on a few hundred of them. Measured on a copy of
// the live database: 385 rows' timestamps moved, no content and no row count changed. The
// backend server does the same on every boot, so the live file's mtime proves nothing either
// way — but if those timestamps must not move, point --db at a copy.
//
// NEVER PRINTS A SECRET. No password, no encrypted blob, no security answer, no account or
// meter number. A login appears as its `username_reference` — the same non-secret reference
// the API itself returns — plus whether a secret is set. Nothing here decrypts anything.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDb } from "../backend/src/db";
import type { PortalRecipe, ProjectRecord, SubmittalTrackType } from "../shared/src/types";
import { findCompleteRecipeForProject, findAnyRecipeForProject } from "../backend/src/portalRecipes";
import { findKnowledgeForLearn } from "../backend/src/knowledgeBase";
import { listPortalCredentials, selectCredentialUrlsFor, mfaCodeDestinationFor } from "../backend/src/portalCredentials";
import type { PortalCredentialView } from "../backend/src/portalCredentials";
import { isUtilityPlatformUrl } from "../backend/src/portalChannel";
import { findAhjProcessProfile } from "../backend/src/processProfiles";

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const blank = (v: unknown): boolean => !s(v).trim();

export const COVERAGE_BUCKETS = ["ready_now", "supervised_first_run", "cannot_file_yet"] as const;
export type CoverageBucket = (typeof COVERAGE_BUCKETS)[number];
export type CoverageTrack = "permit" | "nem";

export const BUCKET_LABEL: Record<CoverageBucket, string> = {
  ready_now: "READY NOW",
  supervised_first_run: "SUPERVISED FIRST RUN",
  cannot_file_yet: "CANNOT FILE YET",
};

export interface JurisdictionSpec {
  state: string;
  ahj: string;
  utility: string;
  /** electrical / structural / combo. Empty = the generic permit track production's
   *  `permit` track passes (recipeDisciplineForTrack returns "" for it). */
  discipline: string;
  source: string;
}

export interface CredentialFacts {
  stored: boolean;
  hasSecret: boolean;
  usernameReference: string;
  /** The portal has accepted this login at least once, and has not refused it since. */
  loginAccepted: boolean;
  /** Refused more recently than accepted — the repo's own `stale` verdict. */
  stale: boolean;
  /** Never presented to the portal at all: an unknown, not a pass. */
  neverAttempted: boolean;
  lastLoginOkAt: string;
  lastLoginNote: string;
  /** How the row was found: the URL match production uses, or the single-credential
   *  last resort. "none" means no stored login can serve this portal. */
  matchedBy: "url" | "single-credential-fallback" | "none";
}

export interface MfaFacts {
  /** This portal challenges a code at login (or the account carries MFA). */
  expected: boolean;
  /** Somebody — an inbox we can reach, or a named person — is recorded to relay it. */
  relayNamed: boolean;
  /** What we found, verbatim-ish, so an operator can check it. Never a secret. */
  relay: string;
  /** Where the MFA signal came from, so a false positive is traceable. */
  evidence: string;
}

export interface CoverageSignals {
  /** The URL production would launch for this track. "" means there is nowhere to go. */
  portalUrl: string;
  portalHost: string;
  recipeStatus: "complete" | "draft" | "none";
  recipeDetail: string;
  credential: CredentialFacts;
  mfa: MfaFacts;
  /** Populated only for a permit row with no complete recipe on the asked-for discipline:
   *  the disciplines that DO hold one, so a coverage report never says "needs a learn"
   *  about a jurisdiction we have already driven. */
  otherDisciplinesWithRecipe: string[];
  /** Who pays THIS portal's fees, agreed per portal at kickoff (S3.7). '' means nobody has
   *  agreed yet. It never changes the bucket — automation never pays a fee under any value
   *  of it — but an unagreed portal is a kickoff item the customer has to close, and a
   *  coverage report is where they will actually see it. */
  feeResponsibility: string;
  /** A filing this client ACTUALLY put through this jurisdiction on this track. A login that
   *  produced an application number is the strongest evidence the login works — stronger than
   *  the flag, which only the LEARN path ever writes. */
  filedHere: { filed: boolean; at: string; reference: string };
}

export interface CoverageRow extends CoverageSignals {
  bucket: CoverageBucket;
  track: CoverageTrack;
  state: string;
  ahj: string;
  utility: string;
  discipline: string;
  /** Display label: "OR | City of Coos Bay | Pacific Power". */
  jurisdiction: string;
  /** The portal this row is about, in the customer's words. */
  portalLabel: string;
  reason: string;
  unblocks: string;
}

export interface CoverageReport {
  generatedAt: string;
  database: string;
  client: { id: string; name: string };
  jurisdictionCount: number;
  jurisdictionSource: string;
  counts: Record<CoverageBucket, number>;
  rows: CoverageRow[];
}

// ---------------------------------------------------------------------------------------
// Jurisdiction scope
// ---------------------------------------------------------------------------------------

export function parseJurisdictions(raw: string): JurisdictionSpec[] {
  return s(raw)
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [state = "", ahj = "", utility = "", discipline = ""] = chunk.split("|").map((p) => p.trim());
      return { state, ahj, utility, discipline: discipline.toLowerCase(), source: "--jurisdictions" };
    })
    .filter((j) => !blank(j.state) || !blank(j.ahj) || !blank(j.utility));
}

export function jurisdictionsFromProjects(db: AppDb, clientId: string): JurisdictionSpec[] {
  // `ahj || city` mirrors what the knowledge base itself keys on, so a project whose ahj was
  // never filled in resolves here the way it would in a run.
  const rows = db.query<{ state: string; ahj: string; city: string; utility: string }>(
    // ARCHIVED PROJECTS ARE NOT JURISDICTIONS WE SERVE. The archive (v27) hides superseded
    // staging passes and test fixtures from the client portal; counting them here inflates the
    // denominator of the one number this report exists to state. On the live database the two
    // Illinois fixtures added City of Springfield and City of Evanston to "CANNOT FILE YET",
    // so the readiness figure described work on jurisdictions nobody has a job in.
    "SELECT DISTINCT state, ahj, city, utility FROM projects WHERE client_id = ? AND archived_at = ''",
    [clientId],
  );
  const seen = new Set<string>();
  const out: JurisdictionSpec[] = [];
  for (const r of rows) {
    const j: JurisdictionSpec = {
      state: s(r.state).trim(),
      ahj: s(r.ahj).trim() || s(r.city).trim(),
      utility: s(r.utility).trim(),
      discipline: "",
      source: "existing projects",
    };
    const key = `${j.state}|${j.ahj}|${j.utility}`.toLowerCase();
    if (seen.has(key) || key === "||") continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Portal URL resolution — the same order prepareSubmission uses, minus two deliberate cuts.
//
// CUT 1: the cold-start LLM research pass. This script opens no network connection and
// writes no seeded profile, so a jurisdiction that production would research on first use
// reports "no portal URL" here. That is the safe direction for a document handed to a
// customer: it says "we have not confirmed a portal for this one" rather than promising a URL
// no human has checked.
// CUT 2: `findApplicationProfile().sourceUrl`, production's LAST-resort permit fallback.
// repository.ts's own comment distinguishes it from a real portal ENTRY — it is an AHJ
// INFORMATION page — and the readiness script's mock-trap check ignores it for the same
// reason. Counting an info page as "portal URL known" would move rows into READY NOW that
// cannot be filed at all, which is the expensive direction to be wrong in.
// ---------------------------------------------------------------------------------------

/** The KB's portal URL for a track, resolved exactly as prepareSubmission does: the exact
 *  name match first, then the fuzzy state-filtered resolver that bridges "PGE" to "Portland
 *  General Electric". */
function knowledgeBasePortalUrl(db: AppDb, j: JurisdictionSpec, track: CoverageTrack): { url: string; notes: string } {
  const column = track === "nem" ? "utility" : "ahj";
  const name = track === "nem" ? j.utility : j.ahj;
  let url = "";
  if (!blank(name)) {
    const row = db.get<{ portal_url?: string }>(
      `SELECT portal_url FROM permit_utility_knowledge WHERE ${column} = ? AND portal_url IS NOT NULL AND portal_url != '' LIMIT 1`,
      [name],
    );
    url = s(row?.portal_url);
  }
  const fuzzy = findKnowledgeForLearn(db, {
    state: j.state,
    ahj: track === "nem" ? undefined : j.ahj,
    utility: track === "nem" ? j.utility : undefined,
  });
  const profile = track === "nem" ? fuzzy.utility : fuzzy.ahj;
  if (!url) url = s(profile?.portalUrl);
  return { url, notes: s(profile?.notes) };
}

/** Oregon's statewide Accela instance: an OR AHJ with no portal URL of its own whose process
 *  profile files through e-permitting shares one portal with every other subscribed
 *  jurisdiction. Production falls back to it, so a coverage report that did not would report
 *  "cannot file" for jurisdictions that file fine. */
function statewideOregonPortalUrl(db: AppDb, j: JurisdictionSpec): string {
  if (s(j.state).trim().toUpperCase() !== "OR") return "";
  const profile = findAhjProcessProfile({ state: j.state, ahj: j.ahj, city: j.ahj } as ProjectRecord);
  if (!profile || !/e.?permitting|accela/i.test(s(profile.submissionMethod))) return "";
  const row = db.get<{ portal_url?: string }>(
    "SELECT portal_url FROM permit_utility_knowledge WHERE ahj = 'Generic Oregon ePermitting AHJ' AND portal_url IS NOT NULL AND portal_url != '' LIMIT 1",
  );
  return s(row?.portal_url) || "https://aca-oregon.accela.com/oregon/";
}

const PERMIT_DISCIPLINES = ["electrical", "structural", "combo"];

export interface TrackResolution {
  recipe: PortalRecipe | null;
  draft: PortalRecipe | null;
  portalUrl: string;
  kbNotes: string;
  otherDisciplinesWithRecipe: string[];
}

/** Resolve one track the way production stages it. NEVER crosses the tracks: the permit side
 *  asks an AHJ-scoped key and filters every candidate URL through `isUtilityPlatformUrl`;
 *  the NEM side asks a utility-scoped key and never looks at an AHJ row. */
export function resolveTrack(db: AppDb, j: JurisdictionSpec, track: CoverageTrack): TrackResolution {
  if (track === "nem") {
    const recipe = findCompleteRecipeForProject(db, { scopeType: "utility", state: j.state, utility: j.utility });
    const draft = recipe ? null : findAnyRecipeForProject(db, { scopeType: "utility", state: j.state, utility: j.utility });
    const kb = knowledgeBasePortalUrl(db, j, "nem");
    return {
      recipe,
      draft,
      portalUrl: s(recipe?.portalUrl) || s(draft?.portalUrl) || kb.url,
      kbNotes: kb.notes,
      otherDisciplinesWithRecipe: [],
    };
  }
  const input = { scopeType: "ahj" as const, state: j.state, ahj: j.ahj, utility: j.utility, discipline: j.discipline };
  const recipe = findCompleteRecipeForProject(db, input);
  const draft = recipe ? null : findAnyRecipeForProject(db, input);
  const kb = knowledgeBasePortalUrl(db, j, "permit");
  // Rule 5, applied to every permit-side candidate exactly as prepareSubmission's
  // `permitSafeUrl` does: a KB row or recipe matched through the project's UTILITY can carry
  // a PowerClerk URL, and a permit filing must never be pointed at one.
  const permitSafe = (u: unknown): string => (isUtilityPlatformUrl(s(u)) ? "" : s(u));
  const ahjUrl = permitSafe(kb.url);
  // Production computes the statewide fallback only when the AHJ's own URL is missing; `||`
  // short-circuits to exactly that.
  const portalUrl =
    permitSafe(recipe?.portalUrl) ||
    permitSafe(draft?.portalUrl) ||
    ahjUrl ||
    statewideOregonPortalUrl(db, j);
  // A jurisdiction we have already driven ELECTRICALLY must not be reported as "needs a
  // learn" merely because the row was asked about the generic permit track. An AHJ holds one
  // recipe per discipline; naming the ones that exist is the difference between an honest
  // report and a scary one. Asked through the production lookup so the name-alias fallback
  // is included.
  const otherDisciplinesWithRecipe = recipe
    ? []
    : PERMIT_DISCIPLINES.filter((d) => d !== j.discipline).filter((d) =>
        Boolean(findCompleteRecipeForProject(db, { ...input, discipline: d })),
      );
  return { recipe, draft, portalUrl, kbNotes: kb.notes, otherDisciplinesWithRecipe };
}

// ---------------------------------------------------------------------------------------
// Credential matching — production's own chain, as far as it can be walked without decrypting.
// ---------------------------------------------------------------------------------------

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Strip everything but scheme+host, so `selectCredentialUrlsFor` compares HOSTS only. This
 *  is how the single-credential fallback below reuses production's `hostsMatch` (which is not
 *  exported) INCLUDING its alias table — the one that knows pacificpower.net and
 *  pacificorpnetmetering.powerclerk.com are the same login target. */
function schemeAndHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return "";
  }
}

function hostsMatchLikeProduction(a: string, b: string): boolean {
  const ha = schemeAndHost(a);
  const hb = schemeAndHost(b);
  if (!ha || !hb) return false;
  return selectCredentialUrlsFor(ha, [hb]).length > 0;
}

/** WHICH STORED LOGIN WOULD SERVE THIS PORTAL.
 *
 *  Production tries three tiers: the canonical portal_type, then the URL match, then the
 *  client's single credential when unambiguous. The portal_type tier is not reproducible
 *  here — that string is derived per project at stage time — so this walks tiers 2 and 3,
 *  which is what actually decides the answer for a service-bureau client holding dozens of
 *  logins. A row found only by tier 3 is reported as such: it means the stored URL's
 *  jurisdiction path segment does not match the target, and Accela serves many cities from
 *  one host. */
export function matchCredential(
  creds: PortalCredentialView[],
  targetUrl: string,
): { row: PortalCredentialView | null; facts: CredentialFacts } {
  const none: CredentialFacts = {
    stored: false, hasSecret: false, usernameReference: "", loginAccepted: false,
    stale: false, neverAttempted: false, lastLoginOkAt: "", lastLoginNote: "", matchedBy: "none",
  };
  if (!targetUrl) return { row: null, facts: none };
  const usable = selectCredentialUrlsFor(targetUrl, creds.map((c) => c.portalUrl));
  let hit: PortalCredentialView | undefined;
  let matchedBy: CredentialFacts["matchedBy"] = "url";
  for (const url of usable) {
    // Most-specific first, and a row that actually holds a secret beats one that does not —
    // production skips an envelope it cannot open and tries the next.
    const candidates = creds.filter((c) => c.portalUrl === url);
    hit = candidates.find((c) => c.hasSecret) ?? candidates[0];
    if (hit) break;
  }
  if (!hit && creds.length === 1 && hostsMatchLikeProduction(targetUrl, creds[0].portalUrl)) {
    hit = creds[0];
    matchedBy = "single-credential-fallback";
  }
  if (!hit) return { row: null, facts: none };
  return {
    row: hit,
    facts: {
      stored: true,
      hasSecret: hit.hasSecret,
      usernameReference: hit.usernameReference,
      loginAccepted: Boolean(hit.lastLoginOkAt) && !hit.stale,
      stale: hit.stale,
      neverAttempted: !hit.lastLoginOkAt && !hit.lastLoginFailedAt,
      lastLoginOkAt: s(hit.lastLoginOkAt),
      lastLoginNote: s(hit.lastLoginNote),
      matchedBy,
    },
  };
}

// ---------------------------------------------------------------------------------------
// MFA — "Emailed code at login? Which inbox?" (intake S3.6)
//
// The guide's commitment is precise: "MFA and one-time codes need a person each session —
// software never clears them. Where possible, route codes to a shared inbox we can access;
// otherwise name someone who can relay a code." So the question a coverage report has to
// answer is not "does this portal have MFA" but "is there a PERSON OR AN INBOX for it".
//
// Four records are read, in that order of authority:
//   1. `portal_credentials.mfa_required` / `mfa_code_destination` — the intake packet's own
//      per-portal answers (migration v18). The destination is the only one of the four that
//      can make a row READY, so it is resolved through `mfaCodeDestinationFor`, which picks
//      the credential the same way the password is picked.
//   2. `portal_profiles.mfa_required` — a different, older table on a different grain, but
//      an operator's explicit answer where one was ever recorded.
//   3. the credential's `notes`, which is where this lived before the columns existed and
//      still carries most of the fleet: "Login emails a one-time code (human-capture at login)."
//   4. the pooled knowledge row's notes, for a portal nobody has stored a login for yet.
// A blank destination with an MFA marker in any of them is the case the guide names and this
// report refuses to call ready.
// ---------------------------------------------------------------------------------------

/** The email-code vocabulary, deliberately the same one the workbook importer classifies
 *  with, widened to the words an operator actually types. */
const MFA_TEXT =
  /one[- ]time (?:code|password)|\botp\b|\bmfa\b|2fa|two[- ]factor|multi[- ]?factor|authenticator|verification code|emails? .{0,16}code|code .{0,16}email|sends? (?:a |you )?(?:the )?code|code (?:is )?sent/i;

/** "No MFA on this one" must not read as MFA. Strip the explicit negations before testing —
 *  the remaining known limit is that a note explaining WHY there is no MFA can still trip the
 *  pattern, which lands the row in CANNOT FILE YET. That is the safe direction: it asks an
 *  operator a question rather than promising a customer a portal nobody has to staff. */
const MFA_NEGATION = /\b(?:no|without|not|never)\s+(?:an?\s+|any\s+)?(?:mfa|2fa|otp|one[- ]time code|multi[- ]?factor|verification code)\b/gi;

export function textSuggestsMfa(text: unknown): boolean {
  return MFA_TEXT.test(s(text).replace(MFA_NEGATION, " "));
}

const RELAY_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const RELAY_PHONE = /(?:\+?\d[\d ().-]{7,}\d)/;
const RELAY_INBOX_PHRASE = /shared inbox|shared mailbox|code inbox|codes? (?:go|goes|route[sd]?|forward(?:ed|s)?) to/i;

/** Is somebody named to relay the code? An inbox address, a phone number, or an explicit
 *  shared-inbox phrase all count; "Login emails a one-time code (human-capture at login)"
 *  on its own does NOT, because it names nobody. */
export function findRelay(text: unknown): string {
  const raw = s(text);
  const email = raw.match(RELAY_EMAIL);
  if (email) return email[0];
  const phrase = raw.match(RELAY_INBOX_PHRASE);
  if (phrase) {
    const phone = raw.match(RELAY_PHONE);
    return phone ? `${phrase[0]} ${phone[0]}`.trim() : phrase[0];
  }
  const phone = raw.match(RELAY_PHONE);
  return phone ? phone[0] : "";
}

export function mfaFacts(
  db: AppDb,
  input: { clientId: string; credential: PortalCredentialView | null; portalUrl: string; kbNotes: string },
): MfaFacts {
  const sources: Array<{ label: string; text: string }> = [];
  if (input.credential) sources.push({ label: "the credential's notes", text: input.credential.notes });
  if (input.kbNotes) sources.push({ label: "the shared knowledge-base row", text: input.kbNotes });

  // portal_profiles is a different table on a different grain (it predates portal_credentials
  // and carries session state), but mfa_required is an operator's explicit answer and the only
  // structured MFA flag in the schema today. Matched by host, the way a credential is.
  const targetHost = hostOf(input.portalUrl);
  let profileFlag = false;
  if (input.clientId && targetHost) {
    const rows = db.query<{ portal_url: string; portal_type: string; mfa_required: number; notes: string }>(
      "SELECT portal_url, portal_type, mfa_required, notes FROM portal_profiles WHERE client_id = ?",
      [input.clientId],
    );
    for (const row of rows) {
      const sameHost = hostOf(s(row.portal_url)) === targetHost;
      const sameType = input.credential && !blank(row.portal_type) && s(row.portal_type) === input.credential.portalType;
      if (!sameHost && !sameType) continue;
      if (Number(row.mfa_required) === 1) profileFlag = true;
      if (!blank(row.notes)) sources.push({ label: "the portal profile's notes", text: s(row.notes) });
    }
  }

  // The intake packet's own answers to S3.6, per portal, as of migration v18. The
  // DESTINATION is resolved through `mfaCodeDestinationFor` rather than read off the row
  // directly, because that helper picks the credential the same way the password is picked
  // (selectCredentialUrlsFor) and yields NOTHING rather than naming a neighbouring
  // jurisdiction's inbox on a shared Accela host. Naming the wrong inbox here would move a
  // row into READY NOW on the strength of a relay that does not exist.
  const declaredMfa = Boolean(input.credential?.mfaRequired);
  const declaredDestination = s(mfaCodeDestinationFor(db, input.clientId, input.portalUrl)).trim();

  const textHit = sources.find((src) => textSuggestsMfa(src.text));
  const expected = Boolean(declaredMfa || declaredDestination || profileFlag || textHit);

  // A RELAY MUST BE SOMEBODY ON THIS CUSTOMER'S SIDE, NOT AN ADDRESS FOUND IN POOLED NOTES.
  //
  // The relay decides whether a declared-MFA portal reads READY NOW or CANNOT FILE YET, and it
  // was being satisfied by ANY email-shaped string in the sources — including the shared
  // knowledge-base row, which every tenant reads and which routinely carries the UTILITY's own
  // support address or hotline. "Ameren's customer-service inbox" is not a person who can hand
  // us a one-time code, so that produced a false READY on a customer-facing deliverable.
  // Client-scoped sources only: the credential's own notes and this client's portal-profile
  // notes. The guide's own wording is the test — "otherwise name someone who can relay a code"
  // means somebody named BY THIS CUSTOMER.
  const clientScopedSources = sources.filter((src) => src.label !== "the shared knowledge-base row");
  const relay = declaredDestination || clientScopedSources.map((src) => findRelay(src.text)).find(Boolean) || "";
  const evidence = declaredMfa
    ? "portal_credentials.mfa_required"
    : declaredDestination
      ? "portal_credentials.mfa_code_destination"
      : profileFlag
        ? "portal_profiles.mfa_required"
        : textHit
          ? textHit.label
          : "";
  return { expected, relayNamed: Boolean(relay), relay, evidence };
}

// ---------------------------------------------------------------------------------------
// Classification — pure, so the buckets can be tested without a portal, a browser or a
// decryption key. The ORDER is the whole meaning: the first blocker wins, and a blocker
// always beats a recipe.
// ---------------------------------------------------------------------------------------

/**
 * WHICH SIDE EACH SUBMITTAL TRACK FILES ON — and the reason this is a Record and not a list.
 *
 * `submissions.permit_type` holds the TRACK, written verbatim by the staging path
 * (repository.ts, `permitTypeTag = track ?? "permit"`) and by markTrackSubmitted. The lookup
 * below used to enumerate the permit-side values by hand and the list stopped at "permit", so
 * a main panel upgrade — its own track since the panel work split out — matched nothing. A
 * customer whose only filing in a jurisdiction was an MPU read as never having filed there,
 * and the report booked them a supervised first run for a portal they had already filed
 * through: the exact failure this function exists to prevent.
 *
 * A Record over SubmittalTrackType is exhaustive, so the NEXT track added to the union fails
 * typecheck here until somebody says which side it files on. A list would have silently
 * dropped it the same way. "permit" is the column's own schema default and the legacy value
 * for rows written before per-track tagging.
 */
const COVERAGE_TRACK_OF: Record<SubmittalTrackType, CoverageTrack> = {
  nem: "nem",
  building: "permit",
  electrical: "permit",
  combo: "permit",
  permit: "permit",
  mpu: "permit",
};
const SUBMISSION_PERMIT_TYPES = Object.keys(COVERAGE_TRACK_OF) as SubmittalTrackType[];

/**
 * Has this client actually filed this track in this jurisdiction?
 *
 * WHY THIS EXISTS: READY NOW turns on portal_credentials.last_login_ok_at, and that flag is
 * written by exactly one caller — the auto-learn path. A REPLAY that stages a real filing logs
 * in, fills the form and captures an application number, and records nothing. So on the live
 * database every portal we have actually filed through read "we have never presented this
 * company's login", and the report told the operator to schedule a supervised first run for
 * portals already proven twice over.
 *
 * Reading the filing is the honest fix and it writes nothing: an application number issued to
 * this client by this jurisdiction could not exist unless the login worked.
 *
 * NOT used to override a REFUSAL — that check sits above this one in classifyCoverage. A portal
 * that rejected the password this week outranks a filing from last month, because the password
 * has since changed.
 */
export function filedInJurisdiction(
  db: AppDb,
  clientId: string,
  j: { state: string; ahj: string; utility: string },
  track: CoverageTrack,
): { filed: boolean; at: string; reference: string } {
  const none = { filed: false, at: "", reference: "" };
  const permitTypes = SUBMISSION_PERMIT_TYPES.filter((t) => COVERAGE_TRACK_OF[t] === track);
  const placeholders = permitTypes.map(() => "?").join(",");
  // Matched on the JURISDICTION the row is about, not on a portal URL: the URL a filing went
  // through is not stored on the submission, and the jurisdiction is what the row claims.
  const where = track === "nem"
    ? "lower(p.utility) = lower(?)"
    : "lower(COALESCE(NULLIF(p.ahj, ''), p.city)) = lower(?)";
  const match = track === "nem" ? j.utility : j.ahj;
  if (!s(match).trim()) return none;
  const row = db.get<{ submitted_at?: string; application_number?: string }>(
    `SELECT sub.submitted_at, sub.application_number
       FROM submissions sub JOIN projects p ON p.id = sub.project_id
      WHERE p.client_id = ? AND p.archived_at = '' AND lower(p.state) = lower(?) AND ${where}
        AND sub.permit_type IN (${placeholders})
        AND sub.status = 'submitted' AND sub.application_number != ''
      ORDER BY sub.submitted_at DESC LIMIT 1`,
    [clientId, j.state, match, ...permitTypes],
  );
  if (!row?.submitted_at) return none;
  return { filed: true, at: s(row.submitted_at), reference: s(row.application_number) };
}

export function classifyCoverage(
  sig: CoverageSignals,
  context: { track: CoverageTrack; portalLabel: string },
): { bucket: CoverageBucket; reason: string; unblocks: string } {
  const what = context.track === "nem" ? "interconnection" : "permit";
  const host = sig.portalHost || context.portalLabel;

  if (!sig.portalUrl) {
    return {
      bucket: "cannot_file_yet",
      reason:
        `no portal URL is known for the ${what} side of ${context.portalLabel}. A stage here falls through to the ` +
        `mock adapter, which reports success without ever opening a browser — "staged" would not mean anything.`,
      unblocks:
        `Confirm the real portal entry URL (including any city or county path segment) and record it — a recorded ` +
        `recipe carries one, or set permit_utility_knowledge.portal_url from the authority's own site. Nothing here ` +
        `should be promised to the customer until a human has opened that URL.`,
    };
  }
  if (!sig.credential.stored) {
    return {
      bucket: "cannot_file_yet",
      reason: `we hold no login that resolves to ${host}. Credential selection matches on hostname and first path segment and refuses rather than using a neighbour's login.`,
      unblocks:
        `The company registers the portal account on the portal's own site — we do not create portal accounts — and ` +
        `then sends us the login through the channel agreed at kickoff (phone, or their password manager's own share). ` +
        `Never email, text or chat. Store it against the real entry URL, not just the host.`,
    };
  }
  if (!sig.credential.hasSecret) {
    return {
      bucket: "cannot_file_yet",
      reason: `a credential row exists for ${host} (${sig.credential.usernameReference || "no username reference"}) but holds no encrypted password, so nothing can log in.`,
      unblocks:
        `Re-save that login with its password through scripts/onboard-company.ts. Security-question answers must go ` +
        `the same way — the REST route silently drops a securityAnswers field.`,
    };
  }
  if (sig.credential.stale) {
    const said = sig.credential.lastLoginNote ? ` The portal said: "${sig.credential.lastLoginNote.replace(/\s+/g, " ").slice(0, 120)}".` : "";
    return {
      bucket: "cannot_file_yet",
      reason: `${host} REFUSED this login more recently than it accepted it.${said} We stop trying that portal until we have a working login, so the account does not get locked.`,
      unblocks:
        `Ask the company for a working login (a rotated password is the usual cause — we cannot detect a change, so ` +
        `they have to tell us the day they make one). Storing the new password does NOT clear the flag: re-run ` +
        `\`npm run learn:benchmark -- --host ${host} --include-stale\` — without --include-stale the host is skipped ` +
        `silently — and only a SUCCESSFUL login clears it.`,
    };
  }
  if (sig.mfa.expected && !sig.mfa.relayNamed) {
    return {
      bucket: "cannot_file_yet",
      reason:
        `${host} challenges a one-time code at login${sig.mfa.evidence ? ` (recorded in ${sig.mfa.evidence})` : ""} and nobody is named to relay it. ` +
        `Software never clears an MFA code — a person does, every session.`,
      unblocks:
        `Answer intake 3.6 for this portal: which inbox the code goes to (a shared inbox we can reach is best), or the ` +
        `person who will relay it. Record it as that credential's mfaCodeDestination — an inbox is who to ask, never ` +
        `the code itself, so it is a field rather than somebody's memory.`,
    };
  }

  const mfaNote = sig.mfa.expected
    ? ` This portal emails a code at login, so a person (${sig.mfa.relay}) has to relay one every session — it is never unattended.`
    : "";

  // A FILING IS A LOGIN THAT WORKED. Reached only after the refusal and MFA branches above, so
  // a portal that rejected the password this week still outranks a filing from last month.
  const provenByFiling = sig.credential.stored && !sig.credential.loginAccepted && sig.filedHere.filed;
  if (sig.recipeStatus === "complete" && (sig.credential.loginAccepted || provenByFiling)) {
    return {
      bucket: "ready_now",
      reason: provenByFiling
        ? `${sig.recipeDetail}, and this company has already filed through ${host} — ${sig.filedHere.reference} on `
          + `${sig.filedHere.at.slice(0, 10)}. That application number could not exist unless the login worked, which is `
          + `stronger evidence than the login flag (only the learn path ever sets it).${mfaNote}`
        : `${sig.recipeDetail}, and ${host} accepted this company's login${sig.credential.lastLoginOkAt ? ` on ${sig.credential.lastLoginOkAt.slice(0, 10)}` : ""}.${mfaNote}`,
      unblocks:
        `Nothing. File it through the normal queue — and remember the filing still stops at the portal's own review ` +
        `screen for a person to check and submit.`,
    };
  }
  if (sig.recipeStatus === "complete") {
    const why = sig.credential.neverAttempted
      ? `we have never presented this company's login to ${host}`
      : `${host} has not accepted this company's login yet`;
    return {
      bucket: "supervised_first_run",
      reason:
        `${sig.recipeDetail}, but ${why}. A recipe recorded against another account is evidence about the PORTAL, ` +
        `not about this company's access to it.${mfaNote}`,
      unblocks:
        `Book the D3-6 portal verification: one real project on this portal with somebody watching, then this row ` +
        `moves to READY NOW by itself — a successful login is what records it.`,
    };
  }

  const recipeWord =
    sig.recipeStatus === "draft"
      ? `the only recipe for this portal is a draft (${sig.recipeDetail}), which does not replay — the next filing re-learns the portal from scratch`
      : `we hold no recorded recipe for this portal, so the first filing here is a learn run`;
  const disciplineNote = sig.otherDisciplinesWithRecipe.length
    ? ` We DO hold a complete recipe here for: ${sig.otherDisciplinesWithRecipe.join(", ")} — this row is a different discipline.`
    : "";
  return {
    bucket: "supervised_first_run",
    reason: `the login is in place and healthy, but ${recipeWord}.${disciplineNote}${mfaNote}`,
    unblocks:
      `Schedule the supervised first run for this portal (D3-6): a learn pass against ${sig.portalUrl} on a real ` +
      `project, watched, before anything is filed unattended. It leaves a draft application in the account — agree ` +
      `at kickoff who cancels it (npx tsx scripts/draft-ledger.ts lists every one we have left).`,
  };
}

// ---------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------

export function buildCoverageReport(
  db: AppDb,
  client: { id: string; name: string },
  jurisdictions: JurisdictionSpec[],
): CoverageReport {
  const creds = listPortalCredentials(db, client.id);
  const rows: CoverageRow[] = [];

  for (const j of jurisdictions) {
    const label = [j.state || "(no state)", j.ahj || "(no ahj)", j.utility || "(no utility)"].join(" | ");
    const tracks: CoverageTrack[] = [];
    if (!blank(j.ahj)) tracks.push("permit");
    if (!blank(j.utility)) tracks.push("nem");
    for (const track of tracks) {
      const resolved = resolveTrack(db, j, track);
      const { row: credentialRow, facts: credential } = matchCredential(creds, resolved.portalUrl);
      const mfa = mfaFacts(db, { clientId: client.id, credential: credentialRow, portalUrl: resolved.portalUrl, kbNotes: resolved.kbNotes });
      const recipeStatus: CoverageSignals["recipeStatus"] = resolved.recipe ? "complete" : resolved.draft ? "draft" : "none";
      const recipeDetail = resolved.recipe
        ? `a complete recipe (v${resolved.recipe.version}, ${resolved.recipe.steps.length} steps) replays here`
        : resolved.draft
          ? `status "${resolved.draft.status}", ${resolved.draft.steps.length} steps`
          : "none recorded";
      const portalLabel = track === "nem" ? j.utility : j.ahj;
      const signals: CoverageSignals = {
        portalUrl: resolved.portalUrl,
        portalHost: hostOf(resolved.portalUrl),
        recipeStatus,
        recipeDetail,
        credential,
        mfa,
        otherDisciplinesWithRecipe: resolved.otherDisciplinesWithRecipe,
        feeResponsibility: s(credentialRow?.feeResponsibility),
        filedHere: filedInJurisdiction(db, client.id, j, track),
      };
      const verdict = classifyCoverage(signals, { track, portalLabel });
      rows.push({
        ...signals,
        bucket: verdict.bucket,
        track,
        state: j.state,
        ahj: j.ahj,
        utility: j.utility,
        discipline: j.discipline,
        jurisdiction: label,
        portalLabel,
        reason: verdict.reason,
        unblocks: verdict.unblocks,
      });
    }
  }

  const counts: Record<CoverageBucket, number> = { ready_now: 0, supervised_first_run: 0, cannot_file_yet: 0 };
  for (const row of rows) counts[row.bucket] += 1;

  return {
    generatedAt: new Date().toISOString(),
    database: s(process.env.AUTOPILOT_DB_PATH) || "backend/data/autopilot.sqlite",
    client,
    jurisdictionCount: jurisdictions.length,
    jurisdictionSource: jurisdictions[0]?.source ?? "none",
    counts,
    rows,
  };
}

const BUCKET_BLURB: Record<CoverageBucket, string> = {
  ready_now:
    "A recorded application replays here and this portal has accepted your login. A person still\n  verifies and submits every filing — that never changes.",
  supervised_first_run:
    "Everything is in place except proof. We drive one real project on each of these with somebody\n  watching (your first week, days 3-6), one portal at a time, before it joins the normal queue.",
  cannot_file_yet:
    "Blocked on something a person has to supply or decide. Each row names it and who it belongs to.",
};

export function renderCoverageReport(report: CoverageReport): string {
  const out: string[] = [];
  const line = (t = ""): void => void out.push(t);
  line();
  line(`COVERAGE REPORT — ${report.client.name}`);
  line(`  database   ${report.database}`);
  line(`  client id  ${report.client.id}`);
  line(`  generated  ${report.generatedAt}`);
  line(
    `  scope      ${report.jurisdictionCount} jurisdiction(s) from ${report.jurisdictionSource}` +
      ` → ${report.rows.length} portal track(s)`,
  );
  if (!report.rows.length) {
    line();
    line("  No jurisdictions in scope. Name where this company files with");
    line('  --jurisdictions "STATE|AHJ|UTILITY, ..." (their intake answer to 3.5, "name the AHJ as its');
    line("  portal does\"), or create their projects first. Until then coverage is UNKNOWN, not proven.");
    line();
    return out.join("\n");
  }

  for (const bucket of COVERAGE_BUCKETS) {
    const rows = report.rows.filter((r) => r.bucket === bucket);
    line();
    line(`── ${BUCKET_LABEL[bucket]} — ${rows.length} of ${report.rows.length} ${"─".repeat(Math.max(0, 40 - BUCKET_LABEL[bucket].length))}`);
    line(`  ${BUCKET_BLURB[bucket]}`);
    if (!rows.length) {
      line();
      line("  (none)");
      continue;
    }
    for (const row of rows) {
      line();
      line(`  ${row.jurisdiction}`);
      line(
        `    track     ${row.track === "nem" ? "NEM / interconnection" : `permit${row.discipline ? ` (${row.discipline})` : ""}`}` +
          `   portal ${row.portalHost || "(no portal URL known)"}`,
      );
      // 14 = the 4-space row indent plus the 10-column label, so a wrapped continuation lines
      // up under the sentence it belongs to rather than under the label.
      line(`    login     ${wrap(describeCredential(row), 14)}`);
      if (row.credential.stored) line(`    fees      ${wrap(describeFees(row), 14)}`);
      line(`    why       ${wrap(row.reason, 14)}`);
      line(`    unblocks  ${wrap(row.unblocks, 14)}`);
    }
  }

  line();
  line(`── SUMMARY ${"─".repeat(56)}`);
  for (const bucket of COVERAGE_BUCKETS) {
    line(`  ${BUCKET_LABEL[bucket].padEnd(22)} ${String(report.counts[bucket]).padStart(3)} of ${report.rows.length}`);
  }
  line();
  line("  What this report is NOT: a claim that any filing will succeed. READY NOW means a recorded");
  line("  application replays and the portal has accepted the login — it is evidence, not proof, and");
  line("  the first filing in a jurisdiction should still be watched. Final submit, portal fees and");
  line("  any CAPTCHA or MFA challenge are a person's job, always, by design.");
  line();
  return out.join("\n");
}

function describeCredential(row: CoverageRow): string {
  const c = row.credential;
  if (!c.stored) return "none stored for this portal";
  const health = c.stale
    ? "REFUSED by the portal"
    : c.loginAccepted
      ? `accepted${c.lastLoginOkAt ? ` ${c.lastLoginOkAt.slice(0, 10)}` : ""}`
      : c.neverAttempted
        ? "never tried against this portal"
        : "not accepted yet";
  const via = c.matchedBy === "single-credential-fallback" ? "; matched only as this client's single login — the stored URL's path segment differs" : "";
  const mfa = row.mfa.expected ? `; emailed code at login (${row.mfa.relayNamed ? `relay: ${row.mfa.relay}` : "NOBODY NAMED TO RELAY IT"})` : "";
  return `${c.usernameReference || "(no username reference)"} — password ${c.hasSecret ? "set" : "MISSING"}, ${health}${via}${mfa}`;
}

const FEE_WORDS: Record<string, string> = {
  "card-on-file": "a payment method on file in their portal account",
  "customer-pays": "a person on their side completes the payment",
  "mailed-check": "a cheque they post (Ameren Illinois' $50 Level 1 fee is one of these)",
  "keelix-pays": "we pay it and invoice it back",
};

/** S3.7 is agreed PER PORTAL at kickoff, so it belongs on a per-portal row. It never moves a
 *  row between buckets: automation never pays a portal fee under any value of this column.
 *  What it does is stop the question being discovered by whoever is holding the mouse at the
 *  portal's payment screen. */
function describeFees(row: CoverageRow): string {
  const value = s(row.feeResponsibility);
  if (!value) return "NOT AGREED — close it at kickoff (S3.7): a payment method on their portal account, or a person on their side who pays.";
  return `${value} — ${FEE_WORDS[value] ?? "as agreed"}. Automation never pays a portal fee under any value of this.`;
}

/** Wrap a long sentence under a fixed indent so the table stays readable in a terminal and
 *  in a pasted email. */
function wrap(text: string, indent: number, width = 88): string {
  const pad = " ".repeat(indent);
  const words = s(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && `${current} ${word}`.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.join(`\n${pad}`);
}

// ---------------------------------------------------------------------------------------
// CLI — runs only when invoked directly, so the test imports the classifier without a run
// happening. Windows-safe: compare resolved paths case-insensitively.
// ---------------------------------------------------------------------------------------
const invokedDirectly = ((): boolean => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  await import("dotenv/config");
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const eq = args.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3).trim();
    const at = args.indexOf(`--${name}`);
    if (at >= 0) {
      const next = args[at + 1];
      if (next && !next.startsWith("--")) return next.trim();
    }
    return "";
  };
  const asJson = args.includes("--json");
  const dbFlag = flag("db");
  // openDatabase() reads AUTOPILOT_DB_PATH when it is CALLED, so setting it here — after the
  // static imports above — still decides which file is opened. An explicit --db beats the
  // environment so a copy can be checked without touching the live one.
  process.env.AUTOPILOT_DB_PATH = dbFlag || process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

  const { openDatabase } = await import("../backend/src/db");
  const { listClients } = await import("../backend/src/clients");
  const db = await openDatabase();

  // An explicit null org filter: null means "across every org", which is what an operator
  // producing a customer's coverage report needs. CLAUDE.md forbids an OMITTED trailing
  // orgId because omission fails open silently; here the cross-org read is the deliberate
  // choice, so it is spelled out.
  const allClients = listClients(db, null);
  const clientArg = flag("client");
  const fail = (message: string): never => {
    console.error(message);
    db.close();
    process.exit(1);
  };
  if (!allClients.length) fail("No clients in this database. Onboard the company first, then re-run.");
  const listCandidates = (rows: typeof allClients): string =>
    rows.map((c) => `  ${c.id.padEnd(28)} ${c.companyName || c.legalBusinessName}`).join("\n");

  let picked = allClients[0];
  if (clientArg) {
    const byId = allClients.find((c) => c.id === clientArg);
    if (byId) picked = byId;
    else {
      const needle = clientArg.toLowerCase();
      const byName = allClients.filter(
        (c) => c.companyName.toLowerCase().includes(needle) || c.legalBusinessName.toLowerCase().includes(needle),
      );
      if (byName.length === 1) picked = byName[0];
      else if (!byName.length) fail(`No client matches "${clientArg}". Known clients:\n${listCandidates(allClients)}`);
      else fail(`"${clientArg}" matches ${byName.length} clients — be more specific:\n${listCandidates(byName)}`);
    }
  } else if (allClients.length > 1) {
    fail(`More than one client in this database — name which one with --client <id-or-name>:\n${listCandidates(allClients)}`);
  }

  const jurisdictionsArg = flag("jurisdictions");
  const jurisdictions = jurisdictionsArg ? parseJurisdictions(jurisdictionsArg) : jurisdictionsFromProjects(db, picked.id);
  const report = buildCoverageReport(
    db,
    { id: picked.id, name: picked.companyName || picked.legalBusinessName },
    jurisdictions,
  );
  // --json prints the report and NOTHING else, so the output pipes straight into a file.
  console.log(asJson ? JSON.stringify(report, null, 2) : renderCoverageReport(report));
  db.close();
  // Exit 0 even when rows are blocked. A coverage report is a deliverable, not a test: the
  // blocked rows ARE the product of the run. Only a usage error exits 1.
  process.exitCode = 0;
}
