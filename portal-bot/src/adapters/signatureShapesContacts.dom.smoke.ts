// The contacts group of signatureShapes.dom.smoke.ts (portal-run-close-2):
// contactUnderCertify / contactUnderAgree / contactsBelowAttest stay the planner's contact (no signer typed, no pause); signBlockWithDate still signs.
//   npx tsx portal-bot/src/adapters/signatureShapesContacts.dom.smoke.ts
import "../smokeArtifactDirs";
process.argv[2] = "contacts";
await import("./signatureShapes.dom.smoke");
