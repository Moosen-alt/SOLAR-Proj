// A URL IS NOT A PORTAL NAME — repair the rows written before the funnel guard existed.
//
// AI research fills portalName with the link (its prompt asks for a branded name and it
// answers with the URL), and the original funnel guard only fired when portalUrl was EMPTY,
// so rows carrying the URL in BOTH fields kept a link where a name belongs. Counted 2026-09-22
// while checking multi-state readiness: 29 real AHJ rows (OR 11, WA 10, FL 5, ID/TX/CA 1 each)
// plus 23 benchmark fixtures. A name holding TWO links stays ambiguous and is left for a human.
//
// This does not invent anything. The URL stays in portal_url; the NAME becomes the portal
// FAMILY inferred from the host (Cape Coral and Happy Valley are both Tyler EnerGov — the same
// platform as Tigard, so one adapter serves them), and an unrecognized host clears the name rather than
// keep showing a link. Human-verified rows are never touched (CLAUDE.md rule 3).
//
//   npx tsx scripts/normalize-portal-names.ts --dry-run
//   npx tsx scripts/normalize-portal-names.ts
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

const dryRun = process.argv.includes("--dry-run");
const { openDatabase } = await import("../backend/src/db");
const { inferPlatform, isRecognizedPlatform, looksLikeBareUrl } = await import("../backend/src/portalPlatformRules");
const { isVerifiedKnowledge } = await import("../backend/src/knowledgeBase");
const db = await openDatabase();

interface Row { profile_key: string; state: string; ahj: string; utility: string; portal_name: string; portal_url: string; portal_platform: string; confidence: string; verified_at: string | null }
const rows = db.query<Row>(
  "SELECT profile_key, state, ahj, utility, portal_name, portal_url, portal_platform, confidence, verified_at FROM permit_utility_knowledge WHERE portal_name LIKE 'http%'",
);

let named = 0, cleared = 0, skippedVerified = 0, platformFilled = 0;
const byPlatform = new Map<string, number>();

for (const row of rows) {
  if (!looksLikeBareUrl(row.portal_name)) continue;
  // Rule 3: a human-verified row is never rewritten by a bulk pass.
  if (isVerifiedKnowledge(row)) { skippedVerified++; continue; }

  const platform = inferPlatform(row.portal_url || row.portal_name);
  const recognized = isRecognizedPlatform(platform);
  const newName = recognized ? platform : "";
  const newPlatform = row.portal_platform || (recognized ? platform : "");
  // The URL must survive: if portal_url was empty, the name's URL moves into it.
  const newUrl = row.portal_url || row.portal_name;

  byPlatform.set(recognized ? platform : "(unrecognized)", (byPlatform.get(recognized ? platform : "(unrecognized)") ?? 0) + 1);
  if (recognized) named++; else cleared++;
  if (!row.portal_platform && newPlatform) platformFilled++;

  console.log(`  ${(row.ahj || row.utility).slice(0, 30).padEnd(32)} ${row.state}  name -> ${newName || "(cleared)"}`);
  if (!dryRun) {
    db.run(
      "UPDATE permit_utility_knowledge SET portal_name = ?, portal_url = ?, portal_platform = ?, updated_at = ? WHERE profile_key = ?",
      [newName, newUrl, newPlatform, new Date().toISOString(), row.profile_key],
    );
  }
}

console.log(`\n${dryRun ? "DRY RUN — nothing written. " : ""}rows seen: ${rows.length}, named from platform: ${named}, cleared: ${cleared}, platform filled: ${platformFilled}, skipped (human-verified): ${skippedVerified}`);
console.log("\nportal families found:");
for (const [platform, n] of [...byPlatform.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${platform}`);
db.close();
process.exit(0);
