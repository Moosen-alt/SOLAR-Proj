// The signer group of signatureShapes.dom.smoke.ts (autosubmit-close MF-E a-c; auto-submit ON means
// no person at review, so a wrong name in a signature box is FILED): the statement inside the
// <label> that wraps the box (sigLabelWrapSpan), "Signer Name" and "Applicant Name" under a signing
// statement — each signed as the CLIENT's signer (or paused signature_no_signer), never the
// planner's installer contact, at learn AND at replay of a css-only old recipe.
//   npx tsx portal-bot/src/adapters/signatureShapesSigner.dom.smoke.ts
import "../smokeArtifactDirs";
process.argv[2] = "signer";
await import("./signatureShapes.dom.smoke");
