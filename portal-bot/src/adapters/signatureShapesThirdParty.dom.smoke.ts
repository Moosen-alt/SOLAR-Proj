// The third-party group of signatureShapes.dom.smoke.ts (autosubmit-2 MF-S1; auto-submit ON means no
// person at review, so the client's signer typed as the homeowner is FILED): a statement about a THIRD
// PARTY's later / offline signing ("The homeowner will sign below once the utility approves."; "The
// customer must consent to sign the interconnection agreement electronically; the utility will email
// it after approval."; "the owner must sign here on the printed authorization form") never makes that
// party's First / Last / Owner Name boxes the client's signature — the planner's homeowner names are
// typed, at learn AND at replay of a css-only old recipe, with a signer on the client record.
//   npx tsx portal-bot/src/adapters/signatureShapesThirdParty.dom.smoke.ts
import "../smokeArtifactDirs";
process.argv[2] = "thirdParty";
await import("./signatureShapes.dom.smoke");
