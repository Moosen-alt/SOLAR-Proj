// The REVIEW group of signatureShapes.dom.smoke.ts (one harness, three runner-sized files):
// combinedReviewSign (MF2 — "Please review and sign" + a filing Next: signed, 0 POSTs, stops at
// review), reviewNextStepsClass / reviewMatStepper (the navigator cut: 0 POSTs, stops at review),
// reviewEchoCanvas / reviewEchoTyped (an echoed signature on the review page is not a step).
//   npx tsx portal-bot/src/adapters/signatureShapesReview.dom.smoke.ts
import "../smokeArtifactDirs";
process.argv[2] = "review";
await import("./signatureShapes.dom.smoke");
