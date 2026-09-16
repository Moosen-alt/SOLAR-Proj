# Round 8 document pipeline audit — 2026-09-16

Scope: read-only source review of `C:\Users\isobl\SOLAR-Proj`, including `CLAUDE.md` and the pasted Claude handoff. No database reads, source edits, environment/secret reads, network, portal access, or historical-drive changes. This note records source-confirmed mechanisms; it does not claim runtime, per-project, or live-data verification.

## What is already wired

- `backend/src/server.ts:603` exposes `/api/projects/:id/find-ahj-form`. Without an explicit form type it calls `ensureAhjFormsForProject`, then fills acquired forms (`:626`). `ahjFormAuto.ts:618` derives application types/kinds from the required set; `:638` supplements checklist demand from KB prose. It acquires at most four distinct PDF downloads per research result (`:744` onward).
- `backend/src/ahjForms.ts:1036` fills built-in and stored forms. Both use `formAllowedForPath`; stored forms pass persisted application kind (`:1108`). Wrong-path generated PDFs are deleted on rebuild (`:1056`).
- Generated forms are already included in ordinary staging/replay via `repository.ts:5343` and in learning via `autoLearn.ts:647`. The handoff's suggestion that replay needs initial wiring is stale: the remaining problem is consistency and safety of that wiring.
- Learner records upload bindings with `docType`, not a literal source-project path (`portal-bot/src/adapters/autoLearnAdapter.ts:2801`). Recipe replay looks up the current document map by that binding (`recipeAdapter.ts:2914`). Replay also has an unrecorded-slot sweep (`:2071`).
- Generated forms are filtered for a contradicting permit path before collapsing to one file per docType (`ahjForms.ts:1287-1311`). The tests in `backend/test/requiredApplicationSet.test.ts:423` cover stale wrong-path generated forms and the no-explicit-path caller.

## Confirmed remaining gaps, ordered by recommended next work

### 1. Missing applications can be replaced with a plan set and learned as a successful upload (P1)

`autoLearnAdapter.ts:2416` handles combined mode. It tries specific application/checklist docTypes, but if the file is absent or cannot be accepted it falls through to the full plan set (`:2424`). This branch precedes and entirely bypasses the no-substitute guard. Split mode also substitutes the plan set (`:2456`), because `UPLOAD_NO_SUBSTITUTE` (`:548`) does not include application/checklist/structural-letter labels. The upload sweep then records `docType: resolved.docType` (`:2804`), so a wrong plan-set attachment becomes a durable, replayable `plan_set` binding for the application slot.

Recommended bounded fix: identify exact-document slots before combined/split fallback. When the slot names an application, checklist, or sealed letter, require its real document; return missing instead of substituting. Preserve legitimate plan-sheet-to-full-plan fallback. Do not make replay's exact-match sweep skip a real available application merely because its slot now forbids substitutes (its current `uploadForbidsSubstitute` early `continue` is at `recipeAdapter.ts:2083`). Test both combined and split modes, required and optional slots, plus successful exact application attachment and unchanged generic plan-set attachment. A small fake-page/DOM regression must assert the file bytes/binding sent, not only the classifier result.

### 2. Learning and replay disagree on uploaded-vs-generated precedence (P1/P2)

`autoLearn.ts:647` uses `{ ...uploads, ...filledForms }`, so generated wins. `repository.ts:5343` uses `{ ...filledForms, ...uploads }`, so uploaded wins. `requiredDocuments.ts:550` and `:225` agree with the latter. An operator upload and generated form under the same docType therefore give learning/self-test different bytes from normal replay, even when all three report the document present.

Recommended bounded fix: one document resolver shared by learning, ordinary staging, and inventory; uploads should win to preserve the existing explicit operator-override policy. Add a collision regression that proves all consumers resolve the same path. Avoid importing repository statically into a cyclic module just to reuse the current function; extract the resolver into a small appropriate module or use the established dynamic-import pattern.

### 3. The proposed attach-time permit-path gate is not implemented (P1)

Current path safety filters generated forms only. `projectDocsByType` (`projectDocuments.ts:274`) accepts existing uploaded paths without application-kind checks. `documentInventory` gives them unconditional presence (`requiredDocuments.ts:225`), and staging gives them override precedence. An uploaded explicitly wrong-path application can therefore satisfy the gate and replace an otherwise valid generated form. Neither the recorded upload branch (`recipeAdapter.ts:2914`) nor its unrecorded sweep (`:2088`), nor the learner's actual `setInputFiles` path (`autoLearnAdapter.ts:2774`), performs an attach-time permit-path recheck.

The generated-form filter also allows path `unknown` because it only rejects contradictions (`ahjForms.ts:71`). Ordinary permit staging blocks unknown at `repository.ts:5492`, but manual learning is not downstream of that gate: `autoLearn.ts:511-587` loads the record and starts learning without a permit-path guard.

Recommended next slice: retain application provenance/kind in a shared backend resolver; reject positive contradictions for generated AND uploaded application candidates, using the document's explicit metadata/text/title rather than inferring a generic building form is structural. Provide a callback/guard that refreshes path and candidate immediately before each actual upload path, including native input, chooser, and unrecorded sweep. A backend-only initial filter must not be advertised as attach-time checking. Test known wrong-path upload, generic compatible upload, path change after map assembly, unknown manual AHJ learn, and unaffected NEM.

### 4. A stored unusable blank can suppress reacquisition forever (P2)

`hasStoredTemplateOfType` (`ahjFormAuto.ts:548`) treats any matching row with `pdf_blob IS NOT NULL` as sufficient; it does not require usable fields or a complete mapping. `acquireFromBytes` deliberately stores unmapped blanks and returns `needs_manual` (`:864`). `loadStoredTemplates` excludes those with no fields/signatures (`ahjForms.ts:1183`). Subsequent Find official form calls return `exists` for an artifact the filler cannot use. Its comment says "usable stored form", but the predicate proves only stored bytes.

Recommended bounded fix: distinguish downloaded blank from usable template in the existence/result contract; surface needs-manual/re-map instead of claiming ready and avoid repeated paid research for the same source bytes. A regression should save a real unmapped blank and assert truthful response/fillability.

## Acquisition/selection boundaries still relevant to Claude

- Form research is deliberately opt-in behind the Find official form endpoint (`server.ts:598` comment); no production callers from learn/stage/autopilot invoke it. Learn only splits and collects already-built forms. The user request to pull and fill everything automatically is therefore not complete.
- `ensureAhjFormsForProject` re-adds `solar_checklist` from profile/KB even for an engineered project (`ahjFormAuto.ts:634/638`) after the path-aware required set omits it. Known prescriptive blanks are subsequently refused by the fill gate, but unnecessary research and generic checklist ambiguity remain. Align acquisition with the canonical required set before claiming end-to-end path consistency.
- `filledFormsByDocType` uses first file per type from an unsorted directory listing (`ahjForms.ts:1281`, `:1325`), without newest/verified preference or stale content hashes. Multiple compatible forms under one docType need a deliberate selection policy.
- `backend/test/filledFormUpload.test.ts` proves vocabulary alignment only; it does not exercise the complete acquire→fill→learn→replay byte path. Existing stale-form tests cover generated, not uploaded, forms.
- No per-project artifact quarantine, drive ingestion, receipt import, Trask-letter ingestion, or Ann/Ivy/Wynema real-data comparison was attempted in this audit. These remain separate Round 8 work and should not be implied complete by code fixes.

Root is handling BCD 5952 flat checkbox rendering; another agent owns the fee/job preflight. This audit does not duplicate either patch.
