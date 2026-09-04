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
