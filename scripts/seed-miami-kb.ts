// Seed the researched Miami solar-permit path into the shared KB — as `seeded`, never
// destroyed by a DB reset the way the rows themselves are. Run after re-provisioning:
//   npx tsx scripts/seed-miami-kb.ts
//
// overwriting human-verified knowledge (upsertKnowledge's confidenceFrom handles that).
//
// Source: the city's own permit catalog, "Get a Permit to Install Solar Panels"
// (miami.gov/Permits-Construction/Permit-Catalog/Get-a-Permit-to-Install-Solar-Panels):
//   "Select 'start application' and then 'building application'. You'll then need to
//    select standalone, electrical permit, then 'solar panel'."
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = "backend/data/autopilot.sqlite";
const { openDatabase } = await import("../backend/src/db");
const { saveResearchedAhjProfile } = await import("../backend/src/knowledgeBase");
const db = await openDatabase();

const research = {
  portalName: "City of Miami iBuild",
  portalUrl: "https://apps.miami.gov/iBuildPortal/",
  portalPlatform: "iBuild",
  submissionMethod: "portal",
  requiredDocuments: [],
  submissionSteps: [
    "Start Application",
    "Building Permit Application",
    "Job Category: STAND-ALONE (confirmed on-screen: 'a trade permit — electrical/mechanical/plumbing')",
    "Job Sub-Category: the electrical/solar sub-category (NEEDS HUMAN CONFIRMATION — see tip)",
    "Work item: SOLAR PANEL (on the later Job Description page)",
  ],
  tips: [
    "Residential rooftop solar PV files as a STAND-ALONE permit (city permit catalog: 'select standalone, electrical permit, then solar panel'). STAND-ALONE is confirmed correct as Job Category.",
    "OPEN QUESTION for a human: the live portal's Job Sub-Category cascade under STAND-ALONE returned only 'BUILDING ROOFING', which is NOT the solar/electrical path. The correct sub-category must be confirmed from a real Miami solar permit or the building dept — do not assume ELECTRICAL until verified.",
    "A residential solar project does NOT need a separate roofing permit — do not pick a roof work item on the Job Description page; the work item is SOLAR PANEL.",
  ],
  confidence: "seeded",
} as never;

for (const ahj of ["City of Miami", "Benchmark apps.miami.gov"]) {
  const profile = saveResearchedAhjProfile(db, { state: "FL", ahj }, research);
  console.log(`${ahj}: confidence=${profile.confidence}`);
  console.log(`  notes: ${String(profile.notes).slice(0, 260)}`);
}
