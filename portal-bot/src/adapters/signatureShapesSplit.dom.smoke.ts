// The split group of signatureShapes.dom.smoke.ts (autosubmit-close MF-E d + MF-D): a First name /
// Last name signature under a signing statement takes the CLIENT's signer split first / last (a
// name that cannot be split, or no signer, pauses signature_no_signer — never the contact), at
// learn AND at replay of a css-only old recipe; and perjury wording about CONTACT data
// (contactsPerjuryAbove / contactsPerjuryOnlyName) leaves the contact's "Full name" the planner's.
//   npx tsx portal-bot/src/adapters/signatureShapesSplit.dom.smoke.ts
import "../smokeArtifactDirs";
process.argv[2] = "split";
await import("./signatureShapes.dom.smoke");
