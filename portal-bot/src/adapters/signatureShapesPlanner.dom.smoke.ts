// The PLANNER group of signatureShapes.dom.smoke.ts (one harness, three runner-sized files):
// contactsFullName / applicantName (a plain name box stays the planner's, no pause),
// pcEsigEmailText / pcEsigEmailType ("Customer Email for e-Signature" is an email box).
//   npx tsx portal-bot/src/adapters/signatureShapesPlanner.dom.smoke.ts
import "../smokeArtifactDirs";
process.argv[2] = "planner";
await import("./signatureShapes.dom.smoke");
