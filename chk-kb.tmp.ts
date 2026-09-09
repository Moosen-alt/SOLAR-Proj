// Does the benchmark project's KB lookup actually surface the seeded path?
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = "backend/data/autopilot.sqlite";
const { openDatabase } = await import("./backend/src/db");
const { buildLearnKbContext } = await import("./backend/src/autoLearn");
const db = await openDatabase();
const project = {
  state: "FL", ahj: "Benchmark apps.miami.gov", utility: "Duke Energy Florida",
  city: "Miami", zip: "33133",
} as never;
const ctx = buildLearnKbContext(db, project, { scopeType: "ahj" });
console.log(ctx.slice(0, 900) || "(EMPTY — the lookup found nothing)");
