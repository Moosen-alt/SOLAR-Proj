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

const result = await rehearse({ live: true });
console.log(
  `Live rehearsal staged project ${result.projectId} to the approval gate (status ${result.finalStatus}).\n` +
  `Open the dashboard, review the staged portal application, and click Approve & Submit to file. ` +
  `Nothing was submitted by the harness.`,
);
