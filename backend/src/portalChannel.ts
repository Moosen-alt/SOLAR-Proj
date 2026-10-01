// Portal channel resolution — the single, explicit decision of HOW a project's
// submission is staged.
//
// This is the capability registry: one place that ranks the available channels for
// a given (client, portal) and returns the winner, instead of the routing being an
// inline `if` ladder buried in prepareSubmission(). The universal-scrape channels
// (recipe → autolearn → handcoded) are the spine and carry every submission today.
// The `api` tier is RESERVED but never selected yet — there is no API adapter and no
// API credentials. It exists so that, when an installer eventually has working API
// access, enabling it is a localized change here (flip `apiAvailable`) rather than a
// rewrite of the dispatch.
//
// The pure precedence helpers (selectAdapterActor / selectStagingActor /
// seedOutcomeToStageResult) live here too — they used to live in repository.ts and
// are re-exported from there for backwards compatibility. Keeping them beside the
// resolver avoids a circular import (repository imports this module, not vice versa).
// (utilityIdentity is a leaf: it imports only permitPath's state parse.)
import { foreignKnownTenant } from "./utilityIdentity";

export type PortalChannel =
  | "api" // reserved — never selected in this build
  | "recipe" // replay a recorded complete recipe (primary)
  | "autolearn" // self-seed a recipe by learning the portal live
  | "handcoded" // platform-specific adapter (Accela / PowerClerk), legacy fallback
  | "mock" // dev / no real portal to drive
  | "manual"; // kill-switch tripped → operator handoff, no automation

export interface PortalChannelDecision {
  channel: PortalChannel;
  // The adapter label the prepareSubmission dispatch switches on. Kept identical to
  // what selectStagingActor() returned historically so threading this resolver in is
  // behaviour-preserving.
  adapterLabel: string;
  reason: string;
  blocked: boolean;
}

// The PLATFORM identity used for field validation (which required fields a portal
// expects). Distinct from the runtime staging actor below: this names the platform
// even when a recipe will actually do the driving.
export function selectAdapterActor(hasRecipe: boolean, isAccela: boolean, isPowerClerk: boolean): string {
  if (hasRecipe) return "RecipeAdapter";
  if (isAccela) return "OregonEPermittingAdapter";
  if (isPowerClerk) return "PowerClerkAdapter";
  return "MockPortalAdapter";
}

// Which actor actually RUNS a stage under the UNIVERSAL-FIRST + SELF-SEED policy. Distinct from
// selectAdapterActor() (which names the PLATFORM for field validation): once a portal has no
// recorded complete recipe, the universal learner SEEDS one on this very stage (AutoLearnAdapter)
// — it records a recipe AND stages this project to review in one pass, auto-promoting to
// "complete" only on a clean triple-verification so the NEXT stage replays it deterministically.
// On a learn failure we STOP AND SURFACE to the operator (no silent drop to the hand-coded path).
// The hand-coded Accela/PowerClerk adapters are reachable ONLY as the legacy fallback when
// auto-seed is disabled (PORTAL_AUTOSEED=0). Pure + exported so the precedence is unit-tested
// without a browser/DB.
/**
 * THE URL A STAGE MAY LEARN ON when it has no complete recipe (operator 2026-09-27: "it should
 * just start when I click Stage"). Candidates in trust order, each already FITTED by the caller
 * (hostFitsTrackAndEntity): a learned profile's portal, the recipe's, a draft recording's, the
 * track's own KB portal (utility for NEM, AHJ for permits), and — permit tracks only — the cited
 * STATEWIDE portal (Oregon ePermitting), which is a genuine portal entry, not an info page.
 * City of Jefferson (2026-09-27): no KB URL, no recipe, borrow refused -> the statewide URL was
 * left out here, so Stage said "no portal automation" and never opened the learner.
 * An AHJ info/landing page is never a candidate (the caller does not pass one).
 */
export function learnEntryUrl(c: {
  track: string | null | undefined;
  learnedProfileUrl?: string | null;
  recipeUrl?: string | null;
  draftUrl?: string | null;
  utilityUrl?: string | null;
  ahjUrl?: string | null;
  statewideUrl?: string | null;
}): string {
  const s = (v: string | null | undefined): string => String(v ?? "").trim();
  return s(c.learnedProfileUrl) || s(c.recipeUrl) || s(c.draftUrl)
    || (c.track === "nem" ? s(c.utilityUrl) : (s(c.ahjUrl) || s(c.statewideUrl)))
    || "";
}

export function selectStagingActor(opts: {
  hasRecipe: boolean;
  isRealPortal: boolean;
  isAccela: boolean;
  isPowerClerk: boolean;
  autoSeedEnabled: boolean;
  /** EXPLICIT simulation switch (MOCK_PORTAL=1) — set by the smoke test and the
   *  simulated rehearsal, never in a production .env. */
  simulationEnabled?: boolean;
}): string {
  if (opts.hasRecipe) return "RecipeAdapter";
  if (opts.isRealPortal && opts.autoSeedEnabled) return "AutoLearnAdapter";
  if (opts.isRealPortal && opts.isAccela) return "OregonEPermittingAdapter";
  if (opts.isRealPortal && opts.isPowerClerk) return "PowerClerkAdapter";
  // The mock is reachable ONLY by explicit opt-in. PORTAL_AUTOSEED=0 alone used to
  // fall through here for any real portal without a hand-coded adapter — the mock
  // reported a successful "staged to review" that never touched the portal, the
  // real filing moved to awaiting_human_submit, and the approve path fabricated
  // MOCK-/CONF- permit numbers staff would trust. Disabling auto-learn must mean
  // "surface a blocker", never "silently simulate". The same holds when NO portal is known at
  // all (#14): cold-start research that confirms nothing used to land here as a mock "staged"
  // run on a production box; it now surfaces "portal unconfirmed" like any other missing portal.
  if (opts.simulationEnabled) return "MockPortalAdapter";
  return "NoAdapter";
}

const ADAPTER_TO_CHANNEL: Record<string, PortalChannel> = {
  RecipeAdapter: "recipe",
  AutoLearnAdapter: "autolearn",
  OregonEPermittingAdapter: "handcoded",
  PowerClerkAdapter: "handcoded",
  MockPortalAdapter: "mock",
  NoAdapter: "manual",
};

export interface PortalChannelInputs {
  hasRecipe: boolean;
  isRealPortal: boolean;
  isAccela: boolean;
  isPowerClerk: boolean;
  autoSeedEnabled: boolean;
  /** EXPLICIT simulation opt-in (MOCK_PORTAL=1) — smoke/rehearsal only. */
  simulationEnabled?: boolean;
  // RESERVED: an installer with working API access for this portal. Always false in
  // this build (no API adapter); wired up the day API access lands.
  apiAvailable?: boolean;
  // Per-portal legal kill-switch (cease-and-desist, IP/bot block). When paused, we do
  // NOT drive any automation — the decision is `manual` and the operator submits by hand.
  portalPaused?: boolean;
}

// Resolve the staging channel for a project. Behaviour-preserving wrapper around
// selectStagingActor: with apiAvailable=false and portalPaused=false (today's only
// callers) the returned adapterLabel is exactly what selectStagingActor produced.
export function resolvePortalChannel(input: PortalChannelInputs): PortalChannelDecision {
  // Kill-switch wins over everything: a paused portal means hands-off, full stop.
  if (input.portalPaused) {
    return {
      channel: "manual",
      adapterLabel: "ManualHandoff",
      reason: "Portal is paused (legal kill-switch) — operator must submit manually.",
      blocked: true,
    };
  }
  // RESERVED API tier — never taken in this build. Left here as the single seam to
  // enable an API channel later without touching the dispatch.
  if (input.apiAvailable) {
    return {
      channel: "api",
      adapterLabel: "ApiPortalAdapter",
      reason: "Installer has API access for this portal.",
      blocked: false,
    };
  }
  const adapterLabel = selectStagingActor({
    hasRecipe: input.hasRecipe,
    isRealPortal: input.isRealPortal,
    isAccela: input.isAccela,
    isPowerClerk: input.isPowerClerk,
    autoSeedEnabled: input.autoSeedEnabled,
    simulationEnabled: input.simulationEnabled,
  });
  const channel = ADAPTER_TO_CHANNEL[adapterLabel] ?? "mock";
  const reason =
    channel === "recipe"
      ? "Recorded complete recipe replays deterministically."
      : channel === "autolearn"
        ? "No recipe yet — universal learner self-seeds one on this stage."
        : channel === "handcoded"
          ? "Auto-seed disabled — hand-coded platform adapter (legacy fallback)."
          : channel === "manual"
            ? "No portal automation for this portal (or no portal known) — stop and surface."
            : "No real portal to drive (dev / mock).";
  return { channel, adapterLabel, reason, blocked: false };
}

// Map a universal self-seed (auto-learn) outcome onto the staging-result contract the
// prepareSubmission persistence block reads ({ ok, finalSubmitClicked, pauseReason, message,
// steps }). The learner NEVER clicks final submit, so finalSubmitClicked is ALWAYS false:
//   trusted | draft → reached the review screen and stopped there (→ awaiting_human_submit;
//                     trusted seeded a reusable recipe, draft will re-seed next stage);
//   paused          → an MFA/CAPTCHA challenge halted the learn (→ paused_for_human);
//   failed          → couldn't learn (→ failed: stop and surface; no hand-coded fallback).
// Exported pure so the mapping is unit-tested.
export function seedOutcomeToStageResult(seed: {
  status: "trusted" | "draft" | "paused" | "failed";
  pauseReason: string | null;
  message: string;
  // Path of the learn run's debug bundle — threaded into portal_runs.logs_path so a failed
  // stage links straight to its forensic artifacts (screenshots, trace, LLM call log).
  debugDir?: string | null;
}): Record<string, unknown> {
  const debugDir = seed.debugDir ?? null;
  if (seed.status === "paused") {
    return { ok: false, finalSubmitClicked: false, pauseReason: seed.pauseReason, message: seed.message, steps: [], debugDir };
  }
  if (seed.status === "failed") {
    return { ok: false, finalSubmitClicked: false, pauseReason: null, message: seed.message, steps: [{ ok: false, message: seed.message }], debugDir };
  }
  return { ok: true, finalSubmitClicked: false, pauseReason: null, message: seed.message, steps: [], debugDir };
}


// The permit DISCIPLINE a submittal track files under — the dimension portal_recipes is
// keyed on alongside the jurisdiction. Oregon solar files a city/structural permit AND a
// county/electrical one for the same project, and those drive different portal steps
// (different jurisdiction row, different record type), so they cannot share a recipe.
// "" = no permit discipline: the NEM/utility track, and legacy untracked stages.
export function recipeDisciplineForTrack(track: string | null | undefined): string {
  switch (track) {
    case "electrical":
      return "electrical";
    // A main-panel/service upgrade is filed as an electrical permit.
    case "mpu":
      return "electrical";
    case "building":
      return "structural";
    // A combination permit covers both trades in ONE filing — its own record type, so its
    // own recipe rather than being folded into either discipline.
    case "combo":
      return "combo";
    default:
      return "";
  }
}

// ── Recipe permit-discipline detection ──────────────────────────────────────────────────
// The ACA learner's deterministic passes record jurisdiction-row and record-type steps
// whose notes carry the LEARN project's permit discipline ("work location: select
// county/electrical address row", "record type: Residential - Electrical …"). AHJ
// recipes are keyed WITHOUT a discipline dimension (state|ahj|utility), so replaying an
// electrical-learned recipe for a structural stage would silently click the COUNTY row
// and the electrical record type — filing the permit down the wrong jurisdiction's
// path, invisibly (the clicks succeed, so no drift detection fires). Until recipes grow
// a per-discipline key (open design decision — see HANDOFF), detect the discipline from
// the recorded steps and refuse the clear mismatches at dispatch.
export function recipeDisciplineFromSteps(steps: Array<{ note?: string }> | null | undefined): "electrical" | "structural" | null {
  for (const s of steps ?? []) {
    const note = String(s?.note ?? "").toLowerCase();
    if (note.includes("county/electrical") || /record type: .*electrical/.test(note)) return "electrical";
    if (note.includes("city/structural") || /record type: .*structural/.test(note)) return "structural";
  }
  return null;
}

// Only the UNAMBIGUOUS mismatches conflict: an electrical track must not replay a
// structural-learned recipe and vice versa. combo/permit/mpu tracks (and recipes with
// no discernible discipline) keep today's behavior.
export function disciplineConflictsWithTrack(
  discipline: "electrical" | "structural" | null,
  track: string | null | undefined,
): boolean {
  if (!discipline) return false;
  if (track === "electrical") return discipline === "structural";
  if (track === "building") return discipline === "electrical";
  return false;
}

// ── Utility-platform host knowledge ─────────────────────────────────────────────────────
// The ONE place that knows which URL hosts are utility interconnection platforms — used by
// the staging track/host gates so a permit (AHJ) track never launches or replays against a
// utility NEM portal (the wrong-system filing bug). Add hosts here as new utility platforms
// enter the knowledge base; the runtime gates pick them up automatically. (Migration v8's
// SQL predicate is deliberately NOT derived from this: a shipped data-repair migration
// stays frozen.)
// Two kinds of host belong here, and only knowing the first kind left a hole:
//
//   PLATFORMS — the interconnection software a utility runs (PowerClerk and friends).
//
//   THE UTILITIES' OWN DOMAINS. A KB audit found five AHJ rows carrying a utility URL, and
//   the AHJ row for City of Beaverton resolves to
//   "portlandgeneral.com/resources-for-solar-installers" — PGE's installer page. That is
//   not a permit portal, but it is not powerclerk.com either, so the permit-track guard
//   waved it through and staging would have driven a building permit at a utility's
//   marketing site. The rows are auto-`learned`, so more will arrive; the guard has to know
//   the utility by its own domain, not only by the platform it happens to buy.
//
// Add hosts as new utilities/platforms enter the knowledge base; the runtime gates pick
// them up automatically. (Migration v8's SQL predicate is deliberately NOT derived from
// this: a shipped data-repair migration stays frozen.)
const UTILITY_PLATFORM_HOSTS = [
  // Interconnection platforms.
  "powerclerk.com",
  // ConnectTheGrid / Intellio Connect (West Monroe) — ComEd runs it at interconnect.comed.com
  // (covered by comed.com below) and PECO at peco.connectthegrid.com. It is a utility
  // interconnection platform, so it belongs here alongside powerclerk.com.
  "connectthegrid.com",
  // customerapplication.com is an interconnection-application SaaS; Duquesne Light's tenant
  // is dlc-customer-owned-generation.customerapplication.com. The whole vendor domain is
  // interconnection-only, so a permit track must never land on it.
  "customerapplication.com",
  // Utility-owned domains whose solar/net-metering pages keep landing on AHJ rows.
  "portlandgeneral.com",
  "pacificpower.net",
  "pacificorp.com",
  "idahopower.com",
  "pge.com",
  "sce.com",
  "sdge.com",
  "srpnet.com",
  "aps.com",
  "xcelenergy.com",
  "pse.com",
  "avistautilities.com",
  "eweb.org",
  // Illinois (seeded 2026-08-30): interconnect.comed.com is the Intellio Connect
  // tenant; ameren.com covers Ameren marketing pages (their PowerClerk tenant is
  // already caught by powerclerk.com above).
  "comed.com",
  "ameren.com",
  "exeloncorp.com",
  // Utah (next market): Rocky Mountain Power is PacifiCorp's brand there.
  "rockymountainpower.net",
  // From the operator's multi-state permit workbook (2026-08-31): PA + NY utility domains
  // whose interconnection/net-metering pages sit next to AHJ rows in the same sheet.
  "pplelectric.com",   // PPL Electric (PA)
  "peco.com",          // PECO (PA)
  "coned.com",         // Con Edison (NY)
  "psegliny.com",      // PSEG Long Island (NY)
  "pseg.com",          // PSE&G (NJ)
  // New Mexico (issue #8): cold-start research for City of Albuquerque / PNM returned
  // pnm.com/solarreferencelibrary, and the permit track launched it ("City of Albuquerque at
  // www.pnm.com is showing a login page"). PNM's own domain is never an AHJ permit portal.
  "pnm.com",           // PNM (Public Service Company of New Mexico)
];
// Salesforce Experience Cloud (<tenant>.my.site.com, <tenant>.force.com, <tenant>.my.salesforce-
// sites.com) is a PLATFORM, not a utility: several utilities run their interconnection intake as a
// Salesforce community, and so do STATE agencies (New Mexico's Regulation & Licensing Department
// takes electrical permits at nmrld.my.site.com). The whole domain used to be on the utility list,
// which refused the State's permit portal on the permit track (close-2 item 9); close-2 then
// admitted every tenant that named no LISTED utility (entergy / eversource / dte … fit the permit
// track, close-3 caveat C); close-3 scored the label's words — agency words minus utility words —
// which let tricountyemc / douglascountypud / newmexicogas / dpl through on "county" / a state's
// name / an abbreviation collision (close-3-v MF2).
// FAIL CLOSED, NO WORD SCORING (rule 5; lookup-close-4 D2). On the PERMIT track a Salesforce site
// fits ONLY when
//   (a) its tenant is on the GOVERNMENT ALLOWLIST below — an explicit label, a two-letter state
//       code run together with a state building / licensing agency's abbreviation, or a label
//       that ends in "permits" / "permitting" ("buildingpermits", "elmcountypermits") — and its
//       label names no utility word / brand and its path no interconnection application; or
//   (b) a human-VERIFIED KB row for the AHJ names that host and tenant (hostFitsTrackAndEntity,
//       rule 3 semantics: a person said so; a seeded row never opens it).
// Everything else — a city's own name ("cityofsantafe"), a building word ("buildingsafety"), a
// state's name ("stateofnm"), an abbreviation with the state's letters AFTER it ("bcdor") — is
// refused with a reason naming this rule: a not-found, never a launch. Utilities outnumber
// agencies on this platform and the repo cannot list every utility brand, so an unknown tenant
// is presumed a utility's. The NEM track is untouched (trackSafeUrl on the NEM track asks only
// isPermitPlatformUrl), so a utility's tenant still fits NEM through its own rules.
const SALESFORCE_SITE = /(?:^|\.)(?:my\.site\.com|force\.com|salesforce-sites\.com)$/i;
const UTILITY_WORD = /utilit|energy|electric|power|light|coop|edison|hydro/i;
const UTILITY_WORD_PART = /^(?:gas|pud|emc|nem|rec|elec|nrg|pwr|util|utility|utilities|solar|interconnect(?:ion)?)$/i;
/** A utility word run together at the END of the label ("tricountyemc", "douglascountypud") — the
 *  "county" / state name inside it names no agency. Not "gas": "cityoflasvegas" ends in it, and
 *  "newmexicogas" is refused by the allowlist anyway (as unknown, with the rule named). */
const UTILITY_WORD_SUFFIX = /(?:emc|remc|rec|pud|nrg|pwr|util)$/i;
const UTILITY_BRAND_LABELS = UTILITY_PLATFORM_HOSTS.map((h) => h.replace(/\.[a-z.]+$/, "")).filter((l) => l.length >= 3);
const INTERCONNECTION_PATH = /interconnect|net-?meter|\bnem\b|customer-?generation|distributed-?generation/i;
/**
 * THE GOVERNMENT ALLOWLIST (maintained here; add a tenant with the public URL that shows it):
 *   nmrld   — New Mexico Regulation & Licensing Department (Construction Industries Division
 *             electrical / building permits): https://nmrld.my.site.com/s/ (close-2 item 9's case).
 *   txtdlr  — Texas Department of Licensing and Regulation (state electrical / industrialized
 *             housing): pattern-derived label; no public Salesforce URL confirmed by this repo yet.
 * Pattern (STATE_AGENCY_TENANT): a US state's two letters RUN TOGETHER with one of rld (Regulation &
 * Licensing), dli (Labor & Industry), dlcd (Land Conservation & Development), bcd (Building Codes
 * Division), cid (Construction Industries Division), dbpr (Business & Professional Regulation),
 * dcbs (Consumer & Business Services) — "nmrld", "nmcid", "orbcd", "fldbpr", "ordcbs", "mndli":
 * pattern only, no confirmed public URL beyond nmrld's. The state's letters go FIRST ("bcdor" is
 * not matched — the pattern is one shape, stated once).
 */
const GOVERNMENT_SALESFORCE_TENANTS = new Set(["nmrld", "txtdlr"]);
const US_STATE_CODES = new Set("al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc".split(" "));
const STATE_AGENCY_TENANT = /^([a-z]{2})(rld|dli|dlcd|bcd|cid|dbpr|dcbs)$/;
const PERMIT_LABEL_SUFFIX = /(?:permits|permitting)$/;
/** The Salesforce tenant's label, run together ("nm-cid" -> "nmcid"), and its parts. */
function salesforceTenantLabel(host: string): { run: string; parts: string[] } {
  const tenant = host.replace(SALESFORCE_SITE, "").split(".").filter((l) => l && !/^(?:www|my|portal|portals|site|sites|community|secure|public)$/i.test(l)).join("-");
  const parts = tenant.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return { run: parts.join(""), parts };
}
/** What a Salesforce Experience site's tenant names: a utility (word, brand, or an interconnection
 *  path), a government agency ON THE ALLOWLIST, or nothing we can read (unknown — presumed a
 *  utility's on the permit track). null for any other host. */
export function salesforceTenantKind(url: string | null | undefined): "utility" | "agency" | "unknown" | null {
  const raw = String(url ?? "");
  const host = portalHostOf(raw) || raw.toLowerCase();
  if (!SALESFORCE_SITE.test(host)) return null;
  const { run, parts } = salesforceTenantLabel(host);
  // A brand names the tenant when it IS one of its labels ("pge", "sce") or, for a brand of four
  // letters or more, when the run-together tenant contains it ("rockymountainpower-nem").
  if (UTILITY_WORD.test(run) || parts.some((p) => UTILITY_WORD_PART.test(p)) || UTILITY_WORD_SUFFIX.test(run)
    || UTILITY_BRAND_LABELS.some((b) => parts.includes(b) || (b.length >= 4 && run.includes(b)))) return "utility";
  let path = "";
  try { path = new URL(raw).pathname; } catch { path = ""; }
  if (INTERCONNECTION_PATH.test(path)) return "utility";
  const st = STATE_AGENCY_TENANT.exec(run);
  if (GOVERNMENT_SALESFORCE_TENANTS.has(run) || (st && US_STATE_CODES.has(st[1])) || PERMIT_LABEL_SUFFIX.test(run)) return "agency";
  return "unknown";
}
/** The rule a refused Salesforce tenant is named against (one sentence, quoted in every reason). */
export const SALESFORCE_FAIL_CLOSED_RULE = "a Salesforce site fits the permit track only when its tenant is on the government allowlist (nmrld, txtdlr, a state code + rld/dli/dlcd/bcd/cid/dbpr/dcbs, or a label ending in permits/permitting) or a human-verified KB row names it (rule 5 fails closed)";
function salesforceSiteIsUtility(url: string, host: string): boolean {
  if (!SALESFORCE_SITE.test(host)) return false;
  // Fails closed: only an allowlisted government tenant is not treated as a utility
  // interconnection host on the permit track (a verified KB row is judged in hostFitsTrackAndEntity).
  return salesforceTenantKind(url) !== "agency";
}
export function isUtilityPlatformUrl(url: string | null | undefined): boolean {
  // Match on the HOST only. A substring test over the whole URL would flag an AHJ portal
  // whose path merely mentions a utility (".../permits?utility=pge.com/..."), and would
  // also let a lookalike domain ("notpge.com.evil.test") slip past a naive check.
  const host = portalHostOf(url) || String(url || "").toLowerCase();
  if (UTILITY_PLATFORM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  return salesforceSiteIsUtility(String(url ?? ""), host);
}

// ── Permit-platform host knowledge (the OTHER direction of rule 5) ──────────────────────
// Rule 5 is two-way: a permit track never launches a utility portal, AND a NEM track never
// launches an AHJ permit portal. The second half had no predicate at all — the NEM chain took
// the first URL any AHJ-keyed KB row offered, so a Coos Bay project's NEM stage could resolve
// aca-oregon.accela.com. These are the permit-software VENDORS' own domains (a city's own .gov
// domain is deliberately NOT here: municipal utilities file interconnections on .gov hosts too).
const PERMIT_PLATFORM_HOSTS = [
  "accela.com",            // Accela Citizen Access (aca-oregon, aca-prod/<agency>, …)
  "tylerhost.net",         // Tyler EnerGov CSS (<city>-energovweb.tylerhost.net)
  "iworq.net",             // iWorQ (<city>.portal.iworq.net)
  "opengov.com",           // OpenGov / ViewPoint (<city>.portal.opengov.com)
  "viewpointcloud.com",
  "smartgovcommunity.com", // SmartGov
  "citizenserve.com",
  "mygovernmentonline.org", // MyGovernmentOnline (TX/LA/…) — one host, many jurisdictions
  "avolvecloud.com",       // ProjectDox
  "communitycore.com",
  "bsaonline.com",
  "permittrax.com",
  "cloudpermit.com",
  "permiteyes.us",
  "civicgov4.com",
  "govoutreach.com",
  "mapsonline.net",        // PeopleGIS Simplicity
  "aspgov.com",
  "gosolarapp.org",        // SolarAPP+ — an AHJ permit, never an interconnection
  "etrakit.net",
  "mygov.us",              // MyGov (public.mygov.us/<city_st>/) — TX / OK small cities
  "geocivix.com",          // Geocivix (<county>.geocivix.com) — Santa Fe County NM and others
  // Vendors' marketing / hosting domains the lookup's portal door listed on its own (lookup-close-5
  // MF2: two lists for one question — a page on a vendor's domain never vouches for a tenant).
  "tylertech.com",         // Tyler Technologies (EnerGov's vendor)
  "tylerportico.com",      // Tyler Portico (Tyler's hosted citizen services)
  "govwelltech.com",       // GovWell
  "cityview.com",          // CityView (Harris)
  "clariti.com",           // Clariti
  // The listed platforms' MARKETING domains (lookup-close-7 R3) — on the one list so the door asks
  // isVendorRootOrMarketing of them; see VENDOR_MARKETING_DOMAINS.
  "iworq.com", "bsasoftware.com", "centralsquare.com", "peoplegis.com", "avolvesoftware.com", "fullcircletech.com",
];
export function isPermitPlatformUrl(url: string | null | undefined): boolean {
  const host = portalHostOf(url);
  if (!host) return false;
  return PERMIT_PLATFORM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
/** ONE definition of "a host where ONE instance serves many agencies and the tenant is in the path
 *  or a query parameter": a page on such a host attests only its OWN tenant (portalTenantKey), never
 *  a sibling's. The catalog's tenant token and the lookup's portal door both ask this (lookup-close-5
 *  MF2: they had two lists). The entries are the INSTANCE hosts (lookup-close-6 MF3: a domain-wide
 *  entry would read a subdomain-tenanted instance's own pages as different tenants — iWorQ serves
 *  both portal.iworq.net/<TENANT>/permits/600 and <tenant>.portal.iworq.net/…, and only the bare
 *  shared host is path-tenanted), each with the public URL shape that shows it:
 *    aca-prod / aca-oregon / aca3 … .accela.com/<TENANT>/      (never www.accela.com, the vendor's site)
 *    www.citizenserve.com/Portal/PortalController?…&installationID=<n>
 *    www.mygovernmentonline.org/?agency=<x> / ?JID=<n>
 *    public.mygov.us/<city_st>/
 *    bsaonline.com/?uid=413 (Otsego County, MI) / ?uid=2695 (Cape Canaveral)
 *    permiteyes.us/<town>/loginuser.php (concord, bridgewater, easton …)
 *    www.mapsonline.net/<town>/online_permits/ (westonma, orleansma …) and /simplicity/…?client=<town>
 *    portal.iworq.net/<TENANT>/permits/600 (PLAINFIELD, EAGLE, DADE, HOKECOUNTY …) */
// HOW each instance names its tenant (lookup-close-7 R2): "path" — the first path segment;
// "query" — a tenant parameter ONLY (bsaonline uid, citizenserve installationID, mygovernmentonline
// agency / JID): a URL with none has NO tenant, it is the vendor's shared site
// (bsaonline.com/MunicipalDirectory/ lists every municipality); "path-or-query" — MapsOnline's
// /<town>/ pages, and its shared apps (/simplicity/…?client=melrosema, /peopleforms/…?site_id=587)
// whose path segment names no one.
// ACA instances are the hosts with an 'aca' first label (aca-prod, aca-oregon, aca.oregon, aca3,
// aca): any other accela.com host (success., developer.) is Accela's own site (lookup-close-7 R3).
const SHARED_INSTANCES: Array<{ host: RegExp; tenant: "path" | "query" | "path-or-query"; sharedSegments?: string[] }> = [
  { host: /^aca(?:\d+|-[a-z0-9-]+)?(?:\.[a-z0-9-]+)*\.accela\.com$/, tenant: "path" },
  { host: /^(?:www\d*\.)?citizenserve\.com$/, tenant: "query" },
  { host: /^(?:www\.)?mygovernmentonline\.org$/, tenant: "query" },
  { host: /^public\.mygov\.us$/, tenant: "path" },
  { host: /^(?:www\.)?bsaonline\.com$/, tenant: "query" },
  { host: /^(?:www\.)?permiteyes\.us$/, tenant: "path" },
  { host: /^(?:www\.)?mapsonline\.net$/, tenant: "path-or-query", sharedSegments: ["simplicity", "peopleforms"] },
  { host: /^portal\.iworq\.net$/, tenant: "path" },
];
function sharedInstanceOf(host: string | null | undefined) {
  const h = String(host ?? "").toLowerCase().replace(/^www\./, "");
  return h ? SHARED_INSTANCES.find((i) => i.host.test(h)) ?? null : null;
}
export function isPathTenantedHost(host: string | null | undefined): boolean {
  return Boolean(sharedInstanceOf(host));
}
/** Vendor domains whose tenants live ONLY on the named instance hosts above: every other host on
 *  them is the vendor's own site (success.accela.com/s/article/…, developer.accela.com). */
const INSTANCE_ONLY_DOMAINS = ["accela.com"];
/** The vendors' MARKETING domains — no tenant is ever hosted on them, every page is the vendor's
 *  own site (lookup-close-7 R3: the list carried the hosting domains only, so the door never asked
 *  isVendorRootOrMarketing of iworq.com/permit-software/ or www.bsasoftware.com/solutions/…). Each
 *  beside the listed platform it markets (confirmed by search / fetch, 2026-09-27). */
const VENDOR_MARKETING_DOMAINS = [
  "iworq.com",          // iWorQ (hosts on iworq.net)
  "bsasoftware.com",    // BS&A Software (hosts on bsaonline.com)
  "centralsquare.com",  // CentralSquare (eTRAKiT on etrakit.net / aspgov.com, Click2Gov on aspgov.com)
  "peoplegis.com",      // PeopleGIS (MapsOnline / Simplicity on mapsonline.net)
  "avolvesoftware.com", // Avolve (ProjectDox on avolvecloud.com)
  "fullcircletech.com", // Full Circle Technologies (PermitEyes on permiteyes.us)
];
/** The vendor's OWN site, never an agency's portal (lookup-close-6 MF4 — the page-read resolver
 *  asked this and the lookup's door did not, so www.tylertech.com/products/… and
 *  www.cityview.com/solutions/permitting were saved as a city's portal): the bare / www host of a
 *  vendor's domain (www.accela.com, opengov.com, cityview.com), a marketing subdomain (info. / go. /
 *  blog. …), or a shared instance that names no tenant in its path or query (aca-prod.accela.com/,
 *  bsaonline.com/ — while bsaonline.com/?uid=413 and www.mapsonline.net/westonma/ name theirs). An
 *  instance on its own subdomain (<city>-energovweb.tylerhost.net, salemma.portal.opengov.com) is
 *  not. Asked of any URL; the callers ask it of vendor hosts (isVendorDomain). */
export function isVendorRootOrMarketing(href: string | null | undefined): boolean {
  const host = portalHostOf(href);
  if (!host) return true;
  if (/^(?:info|go|learn|blog|support|help|community|developers?|docs|marketing|resources|investors?|status|news)\./i.test(host)) return true;
  if (isPathTenantedHost(host)) return portalTenantKey(href) === portalTenantKey(`https://${host}/`);
  if (isVendorOwnSiteHost(host)) return true;
  return host === registrableDomain(host);
}
/** A host on which NO tenant is ever hosted: every host on a vendor's MARKETING domain, and every
 *  host on an instance-only domain that is not one of its named instances (success.accela.com).
 *  ONE answer for isVendorRootOrMarketing AND isInformationalPageUrl's platform exemption — the
 *  exemption ("a platform's help pages are still on the platform that files") must never reach a
 *  domain where nothing is filed (lookup-close-7-v MF1: putting the marketing domains on the platform
 *  list made www.iworq.com/help/permits.pdf fit a permit track — rule 5's information-page clause). */
function isVendorOwnSiteHost(host: string): boolean {
  const dom = registrableDomain(host);
  if (VENDOR_MARKETING_DOMAINS.includes(dom)) return true;
  return INSTANCE_ONLY_DOMAINS.includes(dom) && !isPathTenantedHost(host);
}
/** The organisation's domain of a host (co.marion.or.us keeps four labels, x.co.uk three). */
export function registrableDomain(host: string): string {
  const labels = String(host ?? "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  if (tld === "us" && labels.length >= 4 && /^[a-z]{2}$/.test(labels[labels.length - 2])) return labels.slice(-4).join(".");
  // A three-label US locality (<town>.<st>.us: neighbortown.ma.us) is its own organisation — "<st>.us"
  // is a public suffix, and reading it as the domain made every town in the state one site (a town's
  // forms page "linked its own form" on another town's host; forms-find 2026-09-28).
  if (tld === "us" && labels.length === 3 && /^[a-z]{2}$/.test(labels[1])) return labels.join(".");
  if (/^[a-z]{2}$/.test(tld) && /^(?:co|com|gov|org|net|ac|govt)$/.test(labels[labels.length - 2])) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}
/** ONE definition of "a VENDOR's domain" — a permit-software platform's or a utility
 *  interconnection platform's — for the question "could this domain be the agency's own?": a link
 *  on a vendor's domain is never the organisation's own-domain link (lookup-close-5 MF2: the door
 *  kept a 17-host list beside the 22-host platform list, and geocivix / bsaonline fell between). */
export function isVendorDomain(host: string | null | undefined): boolean {
  const h = String(host ?? "").toLowerCase().replace(/^www\./, "");
  if (!h) return false;
  const asUrl = `https://${h}/`;
  return isPermitPlatformUrl(asUrl) || isUtilityPlatformUrl(asUrl);
}

// ── Is this URL an APPLICATION PORTAL at all? ────────────────────────────────────────────
// A stage launched https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx
// — BCD's staff guidance on how to fill a record — found nothing fillable, and SAVED a recipe
// whose entry URL was that help page. The recipe then vouched for its own URL ("oregon.gov is City
// of Jefferson's own portal"), the application profile's sourceUrl (the same page) passed too, and
// cold-start research never ran because "a URL" was on file. No predicate asked whether a URL is
// somewhere an application can be FILED.
//
// Judged from the URL alone (no fetch — this runs inside every resolver). An information page is:
//   - a document (.pdf/.doc/.docx/.xls/.xlsx/.rtf/.txt);
//   - a page under a help/FAQ/guide/brochure/handout/forms-library/news path segment, or a
//     library / reference / resources segment — whole ("/resources/") or compound
//     ("/solarreferencelibrary", "/solar-resources": issue #8, PNM's document library was
//     researched and saved as Albuquerque's portal);
//   - a SharePoint content page ("/Pages/<name>.aspx") on a government site — the CMS every
//     Oregon state agency and many counties publish on; application portals are not built on it.
// A known permit/interconnection PLATFORM host is never an information page (its help pages are
// still on the platform that files), and a bare host is never one.
const INFO_PATH_SEGMENT = /^(?:help|faqs?|guides?|guidance|brochures?|handouts?|formslibrary|forms-library|news|newsroom|blog|press-releases?|how-to|library|libraries|references?|resources)$/i;
// Compound segments: anything ending in "library" ("solarreferencelibrary", "documentlibrary"), or a
// hyphen/underscore-joined "…-resources" / "…-reference". Not a bare "…reference" suffix: that would
// read "/preferences" or "/user-preference" pages as libraries.
const INFO_PATH_COMPOUND = /(?:library|libraries|[-_](?:resources|references?))$/i;
const DOCUMENT_EXT = /\.(?:pdf|docx?|xlsx?|rtf|txt|pptx?)$/i;
export function isInformationalPageUrl(url: string | null | undefined): boolean {
  const raw = String(url ?? "").trim();
  const host = portalHostOf(raw);
  if (!host) return false;
  // The platform exemption stops at a vendor's own-site domain: nothing is filed there.
  if ((isPermitPlatformUrl(raw) && !isVendorOwnSiteHost(host)) || UTILITY_INTERCONNECTION_PLATFORM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false;
  let pathname = "";
  try {
    pathname = decodeURIComponent(new URL(raw).pathname);
  } catch {
    return false;
  }
  const segs = pathname.split("/").filter(Boolean);
  if (!segs.length) return false;
  if (DOCUMENT_EXT.test(segs[segs.length - 1])) return true;
  if (segs.some((seg) => INFO_PATH_SEGMENT.test(seg) || INFO_PATH_COMPOUND.test(seg.replace(/\.[a-z0-9]+$/i, "")))) return true;
  const gov = /\.(?:gov|us)$/.test(host) || /\.(?:gov|state)\.[a-z]{2}\.us$/.test(host);
  if (gov && segs.length >= 2 && /^pages$/i.test(segs[segs.length - 2]) && /\.aspx$/i.test(segs[segs.length - 1])) return true;
  return false;
}
/** The interconnection SOFTWARE hosts (not the utilities' marketing domains) — the part of the
 *  utility list that files applications, so never an information page. */
const UTILITY_INTERCONNECTION_PLATFORM_HOSTS = ["powerclerk.com", "connectthegrid.com", "customerapplication.com"];

/** Tenant identity of a portal URL: the first path segment, or — when a tenant-naming query parameter
 *  is present (citizenserve's installationID, BS&A's uid, an ACA agency code) — those parameters
 *  alone, since the path is then a page of that tenant (bsaonline.com/?uid=413 and
 *  bsaonline.com/SiteSearch/…?uid=413 are one tenant). Two URLs are the SAME TENANT only when host
 *  and these agree — the strict form used where a portal is UNLOCKED for a track. */
// uid (BS&A Online: bsaonline.com/?uid=413) and client (PeopleGIS: mapsonline.net/simplicity/…?client=
// melrosema) name the tenant on those shared hosts (lookup-close-6 MF3); site_id too (PeopleGIS forms:
// mapsonline.net/peopleforms/mo4/index.php?site_id=587, lookup-close-7).
const TENANT_QUERY_PARAMS = ["installationid", "agency", "agencycode", "tenant", "jurisdiction", "juris", "orgid", "cityid", "jid", "uid", "client", "site_id"];
export function portalTenantKey(url: string | null | undefined): string {
  const raw = String(url ?? "").trim();
  const host = portalHostOf(raw);
  if (!host) return "";
  try {
    const u = new URL(raw);
    const q: string[] = [];
    u.searchParams.forEach((v, k) => { if (TENANT_QUERY_PARAMS.includes(k.toLowerCase())) q.push(`${k.toLowerCase()}=${v.toLowerCase()}`); });
    // On a query-tenanted instance a path segment names no one: no tenant parameter = no tenant
    // (lookup-close-7 R2) — the key is the instance root's, the vendor's shared site.
    const inst = sharedInstanceOf(host);
    const seg = portalTenantOf(raw);
    const pathTenant = !inst ? seg : inst.tenant === "query" || (inst.sharedSegments ?? []).includes(seg) ? "" : seg;
    return `${host}/${q.length ? "" : pathTenant}?${q.sort().join("&")}`;
  } catch {
    return host;
  }
}

/** The lower-cased hostname of a portal URL ("" when it is not an http(s) URL). "www." is
 *  dropped so www.x.gov and x.gov are one portal. */
export function portalHostOf(url: string | null | undefined): string {
  const raw = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(raw)) return "";
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The first path segment of a portal URL, lower-cased — on a path-tenanted host (one Accela
 *  instance serving many agencies as aca-prod.accela.com/CHINO, …/SANDIEGO) it names the tenant.
 *  "" when the URL has no path segment or the first one is a page (it carries a dot). */
export function portalTenantOf(url: string | null | undefined): string {
  const raw = String(url ?? "").trim();
  if (!portalHostOf(raw)) return "";
  try {
    const seg = new URL(raw).pathname.split("/").filter(Boolean)[0] ?? "";
    return seg.includes(".") ? "" : seg.toLowerCase();
  } catch {
    return "";
  }
}

/** Same host (both http(s) URLs). */
export function sameHost(a: string | null | undefined, b: string | null | undefined): boolean {
  const ha = portalHostOf(a);
  return Boolean(ha) && ha === portalHostOf(b);
}

/** Are two URLs the same PORTAL? Same host, and — when both name a first path segment — the
 *  same one (a path-tenanted host is a different portal per tenant). A URL with no segment
 *  (the host root) is compatible with any tenant of its host. */
export function samePortal(a: string | null | undefined, b: string | null | undefined): boolean {
  const ha = portalHostOf(a);
  if (!ha || ha !== portalHostOf(b)) return false;
  const ta = portalTenantOf(a);
  const tb = portalTenantOf(b);
  return !ta || !tb || ta === tb;
}

/** The recipe scope a track files under: NEM → the utility; every permit track (and a
 *  trackless legacy stage) → the AHJ. */
export function scopeForTrack(track: string | null | undefined): "ahj" | "utility" {
  return track === "nem" ? "utility" : "ahj";
}

/** THE TRACK HALF of rule 5, both directions: "" when the URL belongs to the other track's
 *  kind of portal, the URL otherwise. The successor of the one-way permitSafeUrl closure. */
export function trackSafeUrl(track: string | null | undefined, url: string | null | undefined): string {
  const value = String(url ?? "").trim();
  if (!value) return "";
  if (scopeForTrack(track) === "ahj") return isUtilityPlatformUrl(value) ? "" : value;
  return isPermitPlatformUrl(value) ? "" : value;
}

// ── Does this URL belong to THIS track and THIS entity? ─────────────────────────────────
//
// ONE TWO-WAY PREDICATE for every place a portal URL is chosen: recipe resolution, the learn
// entry, KB portal writes, operator-supplied URLs, and research. Three incidents, one shape:
//   - a ComEd (IL) test project was staged with the PGE (OR) recipe (fe12ed81);
//   - research resolved Tigard to Accela although Tigard's human-verified row says EnerGov;
//   - a Tigard KB row points at pgenm.powerclerk.com (PGE's NEM portal).
// Rule 5 caught only the permit→utility direction, and nothing asked whether the host belongs
// to the project's OWN utility or AHJ.
//
// The entity carries its evidence (built from the DB by portalRecipes.portalEntityEvidence):
//   ownPortals      — portals this entity's own recipes / KB rows point at (track-safe only);
//   verifiedPortals — the subset from HUMAN-VERIFIED KB rows (rule 3: a person said so);
//   otherClaims     — portals OTHER entities of the same scope point at, each tagged with its
//                     owner (aliases already merged: "PGE" and "Portland General Electric" are
//                     one owner). A portal only ONE other owner claims, and this entity never
//                     does, is that entity's portal. A portal two or more owners claim
//                     (aca-oregon.accela.com serves every subscribing Oregon city) is shared and
//                     fits anyone on the track.
// Pure: no DB, so every caller and every test asks the same question the same way.
export interface PortalEntity {
  scope: "ahj" | "utility";
  state: string;
  name: string;
  ownPortals: string[];
  verifiedPortals: string[];
  otherClaims: Array<{ url: string; owner: string }>;
  /** Portals the KB DECLARES shared ("Generic Oregon ePermitting AHJ" names the statewide
   *  portal, not a jurisdiction): never another entity's portal, whoever else claims it. */
  sharedPortals?: string[];
  /** UTILITY scope only: permit-platform portals this utility's OWN human-VERIFIED KB record names
   *  (a municipal utility whose NEM application lives inside the city's permit portal — Utah munis,
   *  Austin Energy, BTU, Denton). The ONLY way a permit-platform host opens on the NEM track. */
  verifiedPermitPlatformPortals?: string[];
}

/** Where a candidate URL came from. `operator` = typed by a person on a route; `statewide` =
 *  the deliberate statewide-portal fallback; `research` = LLM/web research; everything else is
 *  something stored (a recipe, a KB row). */
export type PortalUrlSource = "recipe" | "kb" | "research" | "operator" | "statewide" | "learn";

export type HostFitCode = "ok" | "no_url" | "not_a_portal" | "track_conflict" | "platform_conflict" | "foreign_entity";
export interface HostFit {
  fits: boolean;
  code: HostFitCode;
  reason: string;
}

export function hostFitsTrackAndEntity(
  track: string | null | undefined,
  entity: PortalEntity | null,
  url: string | null | undefined,
  source: PortalUrlSource = "kb",
): HostFit {
  const value = String(url ?? "").trim();
  const host = portalHostOf(value);
  if (!host) return { fits: false, code: "no_url", reason: "no portal URL" };
  const scope = scopeForTrack(track);
  const trackName = scope === "utility" ? "NEM (utility interconnection)" : "permit (AHJ)";
  // 0. SOMEWHERE AN APPLICATION CAN BE FILED. A help page, a guide, a PDF is never a portal entry,
  //    whoever stored it (isInformationalPageUrl).
  if (isInformationalPageUrl(value)) {
    return {
      fits: false,
      code: "not_a_portal",
      reason: `${value} is an information page (help/guide/document), not an application portal`,
    };
  }
  // 1. THE TRACK, both directions — no source, not even an operator, overrides rule 5.
  //    ONE carve-out (operator ruling 2026-09-25): a utility whose NEM application lives inside
  //    the CITY's permit portal may use that permit-platform portal on the NEM track ONLY when
  //    that utility's OWN human-VERIFIED KB record names it — same host AND same tenant, never
  //    host-wide, never from a seeded/researched row, never from the AHJ's row
  //    (portalEntityEvidence builds verifiedPermitPlatformPortals from utility-keyed verified rows
  //    only). A permit track never gains the mirror carve-out: it never launches a utility portal.
  if (
    scope === "utility" && entity?.scope === "utility" && isPermitPlatformUrl(value)
    && (entity.verifiedPermitPlatformPortals ?? []).some((p) => portalTenantKey(p) === portalTenantKey(value))
  ) {
    return { fits: true, code: "ok", reason: `${host} is the portal ${entity.name || "this utility"}'s own human-verified record names for its interconnection application` };
  }
  //    THE PERMIT-TRACK MIRROR (lookup-close-4 D2b): a Salesforce site whose tenant is NOT on the
  //    government allowlist fits the permit track ONLY when THIS AHJ's own human-VERIFIED KB record
  //    names that host and tenant (samePortal) — never a seeded / researched row, never another
  //    AHJ's. Judged here, ahead of the track refusal below, so every door asks the one predicate.
  const sf = scope === "ahj" ? salesforceTenantKind(value) : null;
  if (sf && sf !== "agency" && entity?.scope === "ahj" && entity.verifiedPortals.some((p) => samePortal(p, value))) {
    return { fits: true, code: "ok", reason: `${host} is the Salesforce site ${entity.name || "this AHJ"}'s own human-verified record names for its permit applications` };
  }
  if (!trackSafeUrl(track, value)) {
    if (scope === "utility" && entity?.scope === "utility" && isPermitPlatformUrl(value)) {
      return {
        fits: false,
        code: "track_conflict",
        reason: `${host} is an AHJ permit portal, and this is a ${trackName} filing — a permit-platform portal opens on the NEM track only when ${entity.name || "the utility"}'s own human-VERIFIED record names that exact portal (host and tenant)`,
      };
    }
    return {
      fits: false,
      code: "track_conflict",
      reason: scope === "ahj"
        ? sf === "unknown"
          ? `${host} is a Salesforce site whose tenant names no government agency on the allowlist and no human-verified record names it — not a permit portal (${SALESFORCE_FAIL_CLOSED_RULE}), and this is a ${trackName} filing`
          : sf === "utility"
            ? `${host} is a Salesforce site whose tenant names a utility — a utility interconnection portal (${SALESFORCE_FAIL_CLOSED_RULE}), and this is a ${trackName} filing`
            : `${host} is a utility interconnection portal, and this is a ${trackName} filing`
        : `${host} is an AHJ permit portal, and this is a ${trackName} filing`,
    };
  }
  if (!entity) return { fits: true, code: "ok", reason: "track fits; no entity evidence" };
  const who = entity.name || (scope === "utility" ? "this utility" : "this AHJ");
  // Judged by HOST here: an entity's rows point at many pages of one portal (a login page, a
  // record's detail page, the dashboard), and a first-path-segment test would read those as
  // different portals. The tenant-strict samePortal is for recipe REUSE (findBorrowableRecipe).
  const matches = (list: string[]) => list.some((p) => sameHost(p, value));
  // 2. A PERSON SAID WHERE THIS ENTITY FILES. Anything stored or researched that disagrees is
  //    not launched unconfirmed (the statewide fallback included — a verified row outranks a
  //    derived rule). An operator's own URL is judged at the route, which can confirm it.
  if (entity.verifiedPortals.length && !matches(entity.verifiedPortals)) {
    return {
      fits: false,
      code: "platform_conflict",
      reason: `${host} is not the portal a person verified for ${who} (${entity.verifiedPortals.map(portalHostOf).filter(Boolean).join(", ")})`,
    };
  }
  // 2b. A KNOWN UTILITY'S OWN TENANT (leak sweep 2026-09-28). PacifiCorp's and Portland General's
  //     PowerClerk tenants belong to those utilities and nobody else — whatever a learned or seeded
  //     row claims. A bare-name regex once wrote PacifiCorp's tenant as Pacific Gas & Electric's
  //     "own portal" and this step then accepted it. Refused unless a PERSON verified it for this
  //     utility (rule 3: step 2 above already let a verified record through).
  if (entity.scope === "utility" && !matches(entity.verifiedPortals)) {
    const owner = foreignKnownTenant(host, { state: entity.state, utility: entity.name });
    if (owner) {
      return {
        fits: false,
        code: "foreign_entity",
        reason: `${host} is ${owner}'s interconnection portal — ${who}${entity.state ? ` (${entity.state})` : ""} is not ${owner}`,
      };
    }
  }
  // 3. ANOTHER ENTITY'S PORTAL. Only when this entity has no claim on it at all.
  if (source !== "statewide" && !matches(entity.ownPortals) && !matches(entity.sharedPortals ?? [])) {
    const owners = [...new Set(entity.otherClaims.filter((c) => sameHost(c.url, value)).map((c) => c.owner))];
    if (owners.length === 1) {
      return {
        fits: false,
        code: "foreign_entity",
        reason: `${host} is ${owners[0]}'s portal — nothing on file says ${who} files there`,
      };
    }
  }
  return { fits: true, code: "ok", reason: matches(entity.ownPortals) ? `${host} is ${who}'s own portal` : `${host} fits the ${trackName} track` };
}

// ── What a recipe files: its record type / application program ────────────────────────
/** The record type (or application program) a recipe selects, from the learner's own step
 *  notes ("record type: Residential - Structural", "application program: Distributed
 *  Generation"). "" when the recipe never recorded one. */
export function recipeRecordTypeFromSteps(steps: Array<{ note?: string }> | null | undefined): string {
  let found = "";
  for (const s of steps ?? []) {
    const note = String(s?.note ?? "").trim();
    const m = /^(?:record type|application program):\s*(.+)$/i.exec(note);
    if (!m) continue;
    const label = m[1].trim();
    // "record type: continue" is the advance click after the choice, not a choice.
    if (/^continue\b/i.test(label)) continue;
    found = label;
  }
  return found;
}

// Single parse of the PORTAL_AUTOSEED mode switch — hand-rolled copies of this predicate
// had already started to drift across the staging dispatch, the autopilot mock gate, and
// the monitor's fabricated-status gate.
export function isAutoSeedDisabled(): boolean {
  return process.env.PORTAL_AUTOSEED === "0" || process.env.PORTAL_AUTOSEED === "false";
}
