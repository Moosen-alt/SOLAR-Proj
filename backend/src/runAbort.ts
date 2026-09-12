// ---------------------------------------------------------------------------
// DID THE RUN END BECAUSE OF THE PORTAL, OR BECAUSE OF US?
//
// One question, asked in two places that must answer it the same way, or a single
// interrupted run does lasting damage in two directions at once. Both happened on
// 2026-09-04 from the same killed benchmark:
//
//   1. learnBenchmark scored eight portals "unreachable / owner: portal" when the
//      message was "browserType.launchPersistentContext: Target page, context or
//      browser has been closed" — our browser going away, recorded as eight
//      jurisdictions failing to answer.
//
//   2. Worse, and only visible later: recordLoginOutcome wrote that same text as a
//      LOGIN FAILURE against six real, working credentials. The flag exists so the
//      benchmark declines to bang on doors it knows are locked — so those six were
//      then skipped by every subsequent run. A twelve-portal baseline silently
//      selected five, and the seven most interesting platforms (Accela, SmartGov,
//      Tyler EnerGov, eTRAKiT, Cloudpermit, PermitTrax) had been quietly retired by
//      a browser that died.
//
// A verdict about a portal or a password can only be drawn from a run that reached
// far enough to form one. When it did not, the honest record is no record.
//
// EVERY TOKEN HERE IS SOMETHING ONLY OUR OWN SIDE CAN DO. Nothing that a portal could
// plausibly cause belongs in this list — notably not ECONNRESET, which is far more
// often the far end dropping us, and which is a real finding worth keeping.
// ---------------------------------------------------------------------------

const HARNESS_ABORT =
  /target (page|browser)?,? ?(context|browser)? ?(has been|was) closed|browser has been closed|already running|launchpersistentcontext|browser ?type\.|session closed|target closed|worker exited|SIGINT|SIGTERM/i;

/**
 * True when a run ended for a reason that says nothing about the portal: our browser or
 * process went away, or our own concurrency lease refused to start it.
 *
 * Callers must treat a true here as "no information", never as a failure — do not score
 * it, do not mark a credential on it, do not let it into a comparison.
 */
export function isHarnessAbort(message: unknown): boolean {
  const m = String(message ?? "");
  return m.length > 0 && HARNESS_ABORT.test(m);
}

/**
 * ONE VOCABULARY FOR "THE PORTAL REFUSED THE ROBOT", because there were three and they drifted.
 *
 * Canton TX serves a page titled "Attention Required! | Cloudflare" — "Sorry, you have been
 * blocked". The login flow's detector named it; the headed retry would have acted on it; and
 * the BENCHMARK still scored it owner ENGINE, because its own WAF regex had never been given
 * the word "cloudflare". Detected by one, actionable by a second, mis-attributed by a third.
 *
 * That is the third time today a concept lived in more than one place and the copies
 * disagreed. A shared predicate is the only version of this that stays true.
 */
const BOT_BLOCK =
  // ERR_HTTP_RESPONSE_CODE_FAILURE is Chromium's navigation error for ANY 4xx/5xx, so on its
  // own it is weaker evidence than the rest of this list — it covers a genuine 404 or 500 too.
  // It is included deliberately, and the asymmetry is the reason: consulting this predicate
  // costs at most ONE extra headed browser launch on a run that has already failed, while
  // missing it costs a filing that silently does not happen. A WAF that refuses the navigation
  // outright is exactly the case where Playwright reports this and nothing else.
  /\b403\b|forbidden|access denied|request could not be satisfied|request blocked|you have been blocked|attention required|checking your browser|\brobot\b|verify you are (a )?human|unusual traffic|bot detection|security service to protect|cloudflare|perimeterx|akamai|incapsula|\bray id\b|ERR_HTTP_RESPONSE_CODE_FAILURE/i;

/** Refusals aimed at the CLIENT — a WAF or bot wall, not a rejected account. */
export function looksBotBlocked(message: string): boolean {
  const m = String(message ?? "");
  if (!m) return false;
  if (!BOT_BLOCK.test(m)) return false;
  // A refusal that names the ACCOUNT is an authorisation failure, and a real window will be
  // refused exactly the same way. Checked second so it always wins.
  //
  // "permission" USED TO BE IN THIS LIST AND SWALLOWED THE COMMONEST WAF PAGE THERE IS.
  // Akamai's stock 403 body reads "You don't have permission to access <url> on this server"
  // — the literal page coosbayor.gov serves to every programmatic client, and the case this
  // whole headed-retry path exists for. The exclusion was written for "you do not have
  // permission to view this record", which is about an ACCOUNT; the WAF sentence is about a
  // CLIENT. Requiring account-ish company for the word keeps the original intent and stops it
  // eating the case it was never meant to cover.
  if (/credential|username|password|sign ?in failed|login failed|not authorized to/i.test(m)) return false;
  if (/permission/i.test(m) && /\b(account|user|role|your (login|sign|profile)|this record|this page for your)\b/i.test(m)) return false;
  return true;
}
