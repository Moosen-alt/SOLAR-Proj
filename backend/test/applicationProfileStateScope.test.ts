// findApplicationProfile is STATE-SCOPED for the hand-written (Oregon) registry.
// Bare jurisdiction names collide across states — a WA "Washington County"-alike
// project must NOT inherit the Oregon BDAS profile (requiresPortalEntryOnly:true
// would silently skip AHJ form acquisition: the "no documents pulled" bug).
import assert from "node:assert";
import { findApplicationProfile } from "../src/applicationDocs";
import type { ProjectRecord } from "../../shared/src/types";

function proj(over: Partial<ProjectRecord>): ProjectRecord {
  return { id: "t", ahj: "", city: "", state: "", zip: "", utility: "", homeownerName: "", projectAddress: "", ...over } as unknown as ProjectRecord;
}

// Oregon projects still match their hand-written profiles.
const orWashCo = findApplicationProfile(proj({ ahj: "Washington County", state: "OR" }));
assert.equal(orWashCo.id, "washington-county-bdas", `OR Washington County keeps its profile (got ${orWashCo.id})`);

const orSalem = findApplicationProfile(proj({ ahj: "City of Salem", state: "OR" }));
assert.equal(orSalem.id, "salem-pac-solar-array", `OR Salem keeps its profile (got ${orSalem.id})`);

// A colliding name OUTSIDE Oregon must not inherit an Oregon profile — and
// specifically must not come back portal-entry-only (which blocks acquisition).
for (const [ahj, state] of [["Washington County", "WA"], ["Salem", "WA"], ["Marion County", "KS"], ["Clark County", "WA"]] as const) {
  const p = findApplicationProfile(proj({ ahj, state }));
  assert.ok(!p.id.startsWith("washington-county") && !p.id.startsWith("salem") && !p.id.startsWith("marion"),
    `${ahj}, ${state} must not match an Oregon profile (got ${p.id})`);
  assert.equal(p.requiresPortalEntryOnly, false, `${ahj}, ${state} must not be flagged portal-entry-only (got ${p.id})`);
}

console.log("applicationProfileStateScope: all checks passed");
