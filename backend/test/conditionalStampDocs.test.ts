// Conditional structural-stamp requirement: a sealed structural letter ("SS
// stamp") is required only when THIS project needs one — the engineered path, or
// the jurisdiction's own stamp threshold from its code profile. A prescriptive
// project in a jurisdiction with no threshold must never be nagged for one.
// Browser/DB-free. Run: tsx backend/test/conditionalStampDocs.test.ts
import assert from "node:assert/strict";
import { requiredDocuments } from "../src/requiredDocuments";
import { resolveStampRequirement } from "../src/permitPath";
import type { ProjectRecord } from "../../shared/src/types";

let passed = 0;
const ok = (n: string) => { passed++; console.log(`ok   ${n}`); };

const proj = (over: Partial<ProjectRecord> = {}, snapshot: Record<string, unknown> = {}): ProjectRecord =>
  ({ utility: "PGE", systemSizeDcKw: 8, parserSnapshot: snapshot, ...over } as unknown as ProjectRecord);

const wantsStamp = (p: ProjectRecord, opts?: { stampThresholdKwDc?: number | null; jurisdictionLabel?: string }) =>
  requiredDocuments(p, opts).some((d) => d.docType === "structural_letter");

// A clean prescriptive project in a jurisdiction with no recorded threshold.
const prescriptive = proj({}, { mounting: "Roof Mount", snow: 25, deadLoad: 3, roofRafterSpacing: 16, wind: "C" });

// 1) No threshold + prescriptive path => NOT required (the common case).
assert.equal(wantsStamp(prescriptive), false);
assert.equal(wantsStamp(prescriptive, { stampThresholdKwDc: null }), false);
ok("prescriptive project with no jurisdiction threshold is never asked for a stamp");

// 2) Engineered path => always required, regardless of threshold.
const engineered = proj({}, { permitPathOverride: "engineered" });
assert.equal(wantsStamp(engineered), true);
assert.equal(wantsStamp(engineered, { stampThresholdKwDc: null }), true);
ok("engineered path always requires the sealed structural letter");

// 3) Jurisdiction threshold: required only ABOVE the limit (CA/MA 10 kW).
assert.equal(wantsStamp(proj({ systemSizeDcKw: 8 }, { mounting: "Roof Mount" }), { stampThresholdKwDc: 10 }), false);
assert.equal(wantsStamp(proj({ systemSizeDcKw: 12 }, { mounting: "Roof Mount" }), { stampThresholdKwDc: 10 }), true);
ok("per-jurisdiction kW threshold gates the stamp (8 kW no, 12 kW yes at a 10 kW limit)");

// 4) Threshold 0 = required at ANY size (Chicago: IL-licensed SE/architect on every job).
assert.equal(wantsStamp(proj({ systemSizeDcKw: 4 }, { mounting: "Roof Mount" }), { stampThresholdKwDc: 0 }), true);
ok("threshold 0 requires a stamp at any system size");

// 5) Unknown system size must not fabricate a requirement from a positive threshold.
assert.equal(wantsStamp(proj({ systemSizeDcKw: null }, { mounting: "Roof Mount" }), { stampThresholdKwDc: 10 }), false);
ok("unknown DC size never invents a stamp requirement from a kW threshold");

// 6) The reason names WHY, so the operator can act on it.
const why = requiredDocuments(proj({ systemSizeDcKw: 12 }), { stampThresholdKwDc: 10, stampThresholdConfirmed: true, jurisdictionLabel: "California" })
  .find((d) => d.docType === "structural_letter")?.why || "";
assert.ok(/California/.test(why) && /10/.test(why), `reason should name the jurisdiction + threshold: ${why}`);
const alwaysWhy = requiredDocuments(proj({ systemSizeDcKw: 4 }), { stampThresholdKwDc: 0, stampThresholdConfirmed: true, jurisdictionLabel: "Chicago" })
  .find((d) => d.docType === "structural_letter")?.why || "";
assert.ok(/Chicago/.test(alwaysWhy) && /any size|regardless/i.test(alwaysWhy), `reason should say any-size: ${alwaysWhy}`);
ok("the requirement explains which rule triggered it");

// 7) The single authority itself: source + waivability contract that all four
//    consumers (required-docs, reviewer, application-docs, dashboard) rely on.
const eng = resolveStampRequirement(proj({}, { permitPathOverride: "engineered" }));
assert.equal(eng.source, "engineered_path");
assert.equal(eng.waivable, false);
const jur = resolveStampRequirement(proj({ systemSizeDcKw: 12 }, { mounting: "Roof Mount" }), { stampThresholdKwDc: 10, stampThresholdConfirmed: true, jurisdictionLabel: "California" });
assert.equal(jur.source, "jurisdiction_threshold");
assert.equal(jur.waivable, false);
const hearsay = resolveStampRequirement(prescriptive, { processProfileRequiresStamp: true, jurisdictionLabel: "Marion County" });
assert.equal(hearsay.required, true);
assert.equal(hearsay.source, "process_profile");
assert.equal(hearsay.waivable, true, "profile hearsay must be waivable — advisory, never a hard block");
assert.ok(/[Cc]onfirm/.test(hearsay.reason), `hearsay reason should say confirm: ${hearsay.reason}`);
const none = resolveStampRequirement(prescriptive);
assert.equal(none.required, false);
assert.equal(none.source, "none");
ok("resolveStampRequirement: source + waivability contract (engineered/threshold hard, profile advisory)");

// 8) Hearsay-only trigger reaches the document list as ADVISORY, never blocking.
const advisory = requiredDocuments(prescriptive, { processProfileRequiresStamp: true, jurisdictionLabel: "Marion County" })
  .find((d) => d.docType === "structural_letter");
assert.ok(advisory, "profile hearsay adds the letter to the list");
assert.equal(advisory?.blocking, false, "…as an advisory, not a submit blocker");
// The hard triggers still block.
const hard = requiredDocuments(proj({ systemSizeDcKw: 12 }), { stampThresholdKwDc: 10, stampThresholdConfirmed: true })
  .find((d) => d.docType === "structural_letter");
assert.equal(hard?.blocking, true);
ok("profile-flagged letter is advisory in the doc list; path/threshold letters still block");

// 9) AN UNCONFIRMED THRESHOLD IS A NOTE (leak sweep, 2026-09-28): a number with no provenance — the
//    shipped state-level "stamp commonly required over ~10 kW" hedges — is the same trigger, stated
//    as an advisory the operator confirms: listed, never blocking, never "<AHJ> requires".
const note = resolveStampRequirement(proj({ systemSizeDcKw: 12 }, { mounting: "Roof Mount" }), { stampThresholdKwDc: 10, jurisdictionLabel: "City of Newton", stampThresholdBasis: "the seeded MA state-level reference note" });
assert.equal(note.required, true, "still named — a note is not nothing");
assert.equal(note.waivable, true, "an unconfirmed threshold never hard-blocks");
assert.ok(!/City of Newton requires/.test(note.reason) && /[Cc]onfirm/.test(note.reason) && /MA state-level reference note/.test(note.reason), note.reason);
const noteRow = requiredDocuments(proj({ systemSizeDcKw: 12 }), { stampThresholdKwDc: 10, jurisdictionLabel: "City of Newton" })
  .find((d) => d.docType === "structural_letter");
assert.equal(noteRow?.blocking, false);
const anySizeNote = resolveStampRequirement(proj({ systemSizeDcKw: 4 }, { mounting: "Roof Mount" }), { stampThresholdKwDc: 0, jurisdictionLabel: "Chicago" });
assert.equal(anySizeNote.waivable, true);
ok("an unconfirmed jurisdiction threshold is a waivable advisory, never '<AHJ> requires'");

console.log(`\nconditionalStampDocs: all ${passed} checks passed`);
