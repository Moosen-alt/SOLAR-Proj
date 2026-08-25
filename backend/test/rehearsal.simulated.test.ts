// Simulated-portal rehearsal (CI). Drives a realistic project intake → autopilot →
// approval → submit against the MockPortalAdapter, deterministically. Run: npm run rehearse:sim
// The mock IS the simulated portal here, so pin auto-seed OFF: in normal (auto-seed ON) operation a
// stage with no registered portal surfaces a blocker rather than silently mocking.
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1"; // explicit simulation opt-in — the mock is no longer implied by seed-off
import { rehearse } from "./rehearsal.harness";

const result = await rehearse({ live: false });
if (!result.submitted) {
  throw new Error(`Rehearsal did not reach submitted state (got ${result.finalStatus}).`);
}
console.log(`Rehearsal passed: project ${result.projectId} ran intake → autopilot → approval → submitted (${result.finalStatus}).`);
