// The reviewBar group of signatureShapes.dom.smoke.ts (portal-run-close-2):
// reviewStepperNoHeading / reviewStepperDivOnly / reviewStepsContentDivTitle: the stepper that WRAPS a review step whose title is a div is not a step bar — 0 POSTs, the run stops at review.
//   npx tsx portal-bot/src/adapters/reviewStepperBar.dom.smoke.ts
import "../smokeArtifactDirs";
process.argv[2] = "reviewBar";
await import("./signatureShapes.dom.smoke");
