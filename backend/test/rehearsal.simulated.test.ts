// Simulated-portal rehearsal (CI). Drives a realistic project intake → autopilot →
// approval → submit against the MockPortalAdapter, deterministically. Run: npm run rehearse:sim
import { rehearse } from "./rehearsal.harness";

const result = await rehearse({ live: false });
if (!result.submitted) {
  throw new Error(`Rehearsal did not reach submitted state (got ${result.finalStatus}).`);
}
console.log(`Rehearsal passed: project ${result.projectId} ran intake → autopilot → approval → submitted (${result.finalStatus}).`);
