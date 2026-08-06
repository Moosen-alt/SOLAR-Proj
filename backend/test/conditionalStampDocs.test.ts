// Conditional structural-stamp requirement: a sealed structural letter ("SS
// stamp") is required only when THIS project needs one — the engineered path, or
// the jurisdiction's own stamp threshold from its code profile. A prescriptive
// project in a jurisdiction with no threshold must never be nagged for one.
// Browser/DB-free. Run: tsx backend/test/conditionalStampDocs.test.ts
import assert from "node:assert/strict";
import { requiredDocuments } from "../src/requiredDocuments";
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
const why = requiredDocuments(proj({ systemSizeDcKw: 12 }), { stampThresholdKwDc: 10, jurisdictionLabel: "California" })
  .find((d) => d.docType === "structural_letter")?.why || "";
assert.ok(/California/.test(why) && /10/.test(why), `reason should name the jurisdiction + threshold: ${why}`);
const alwaysWhy = requiredDocuments(proj({ systemSizeDcKw: 4 }), { stampThresholdKwDc: 0, jurisdictionLabel: "Chicago" })
  .find((d) => d.docType === "structural_letter")?.why || "";
assert.ok(/Chicago/.test(alwaysWhy) && /any size|regardless/i.test(alwaysWhy), `reason should say any-size: ${alwaysWhy}`);
ok("the requirement explains which rule triggered it");

console.log(`\nconditionalStampDocs: all ${passed} checks passed`);
