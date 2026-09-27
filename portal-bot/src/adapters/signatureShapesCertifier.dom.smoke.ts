// The CERTIFIER shape of signatureShapes.dom.smoke.ts's MF1 group (one harness, runner-sized
// files): "Full name of person certifying" under "I hereby certify..." is a signature box,
// with a signer it holds the CLIENT's signer (bound, no literal), with none the run pauses
// signature_no_signer; "Casey Contact" is never typed and the planner never sees the box.
//   npx tsx portal-bot/src/adapters/signatureShapesCertifier.dom.smoke.ts
import "../smokeArtifactDirs";
process.argv[2] = "certifier";
await import("./signatureShapes.dom.smoke");
