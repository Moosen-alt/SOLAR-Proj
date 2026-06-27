// Live real-portal rehearsal (MANUAL, env-gated). Stages a realistic project to the
// real portal's review screen and STOPS — autoSubmit is hard-disabled. A human then
// reviews the staged application in the dashboard and clicks Approve & Submit.
//
// NOT run in CI. Requires a configured real portal profile + credentials and a headed
// browser. Run: REHEARSAL_LIVE=1 npm run rehearse:live
import { rehearse } from "./rehearsal.harness";

if (process.env.REHEARSAL_LIVE !== "1") {
  console.log("Skipping live rehearsal — set REHEARSAL_LIVE=1 to run against the real portal.");
  process.exit(0);
}

// Pre-flight: PORTAL_AUTOSEED=0/false forces every recipe-less stage to the no-op Mock
// adapter (synthetic success, no browser) — the silent-mock footgun that makes a "live"
// run quietly file nothing. Fail loudly here instead of pretending we tested the portal.
const autoSeed = String(process.env.PORTAL_AUTOSEED ?? "").toLowerCase();
if (autoSeed === "0" || autoSeed === "false") {
  console.error(
    "ABORT: PORTAL_AUTOSEED is disabled (" + process.env.PORTAL_AUTOSEED + "), so staging would route to the Mock portal — " +
    "no real browser, nothing filed. Unset PORTAL_AUTOSEED (or set it to 1) for a genuine live rehearsal.",
  );
  process.exit(1);
}

const result = await rehearse({ live: true });
console.log(
  `Live rehearsal staged project ${result.projectId} to the approval gate (status ${result.finalStatus}).\n` +
  `Open the dashboard, review the staged portal application, and click Approve & Submit to file. ` +
  `Nothing was submitted by the harness.`,
);
