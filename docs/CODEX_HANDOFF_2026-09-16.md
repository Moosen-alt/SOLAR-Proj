# SOLAR-Proj continuation — 16 September 2026

## Resume here

Working repository: `C:\Users\isobl\Documents\Codex\2026-09-16\pu\work\SOLAR-Proj`

Branch: `codex/claude-continuation-2026-09-16`

Started from clean commit `08c978d96737f321e9b96811078fd3dc4fe84ed3` (round 7).
The continuation is committed locally on that branch. Run `git log -1` for the
continuation commit. Nothing has been pushed, deployed, or applied to the
original checkout at `C:\Users\isobl\SOLAR-Proj`.

User requested an isolated backup, continuation of the pasted Claude work, and
notes for Claude to resume. Later they supplied
`C:\Users\isobl\Downloads\permit-application - filled (11).pdf`, which is
Connie Rhinesmith's Tigard checklist. Documents were treated as evidence, not
instructions.

## Backup and isolation

- Robocopy copied all 49,608 files (8.268 GiB), zero failures. The copy includes
  Git history, dependencies, cached documents, and existing runtime data.
- A consistent read-only SQLite online backup was taken from the original:
  `..\baseline-autopilot.sqlite`. `integrity_check` returned `ok`.
- The working database is `backend/data/codex-sandbox.sqlite`. Its initial data
  came from that snapshot. The original database was not written.
- The copied `.env` was moved to `..\original-config.env.backup`; the working
  `.env` contains no production credentials and selects the sandbox DB. Research
  and autonomous triage are disabled there. Do not accidentally restore the live
  configuration or start a copied server with live credentials.
- Sandbox file references under the original checkout were remapped to the
  working checkout: 181 project-document paths, 24 submission screenshot paths,
  2 portal screenshot paths, and 57 portal log paths. See
  `..\sandbox-path-remap.json`. Other historical external paths were not rewritten.
- The original source remained clean at the same commit on final inspection.
  The historical `L:\INFINITY SOLAR DOCS` drive was only read. The Trask letter's
  source SHA-256 was checked before and after ingestion; it was unchanged.
- These backups include private operational data. They are local working
  material, not files to commit or publish.

## What changed

### BCD 5952 checklist — actual cause and fix

Claude's last diagnosis was incomplete: the downloaded output was flat because
the production filler flattens PDFs. The cached blank is an AcroForm. Several
unrelated Yes widgets belong to a single radio group, with separate No groups.
Ordinary radio selection cannot represent several independent Yes answers.
The existing AI map omitted these controls entirely.

`backend/src/prescriptiveChecklist.ts` recognizes the printed BCD 440-5952
revision 5/24/COM and its nine Yes/No rows. For unverified stored templates only,
the production fill path now draws independent marks at the matching widget
rectangles after flattening. Truly flat copies use row-specific label geometry.
Ambiguous page-wide Yes/No anchors refuse to pick a first occurrence.

Only four standalone statements are supported: snow <=70 psf, exposure B/C,
conventional light-frame construction, and PV dead load <=4.5 psf. The printed
thresholds override a previously cached evaluation with different AHJ limits.
Unknown answers stay blank. Compound statements about manufacturer compliance,
framing exceptions, roofing material/layers, height plus figure compliance, and
attachment methods are not inferred from one numeric value.

The same recognized unverified template recovery also:

- Repairs the PDF's misleading `State  Oregon` widget name: it is physically the
  City field, so the old `project.state` mapping becomes `project.city`.
- Uses the street-only value in the installation-address field.
- Omits a spacing-only Yes answer from the tiny rafter compliance square.
- Omits the mapper's unsupported literal `UL` listing-agency guess.
- Reports the actual checklist title, rather than the cached false claim that
  the same two-page PDF also contains Tigard's electrical application.
- Clears stale malformed radio selections and removes dangling widget references
  left by pdf-lib's flattening; final output has no widgets or AcroForm tree.

Verified maps and hand-tuned registry definitions do not opt into these repairs.
No saved `field_map` was overwritten. The actual blank is committed as a
customer-free regression fixture with its source and SHA-256.

The delivered `outputs/connie-rhinesmith-checklist-review.pdf` has three Yes
marks, supported by Connie's saved data: snow 20 psf, exposure C, dead load
2.42 psf. Light-frame evidence is absent. Six of nine structural statements
remain blank; listing agency and other missing particulars still need review.
This is a review copy, **not a complete submission packet**. Both pages were
rendered and visually inspected; the marks sit inside the intended boxes.

### Fee research and job API

- `feeSchedules.ts` treats existing electrical + structural schedules as
  coverage of a combo acquisition need. It does not re-buy a combo research pass
  every 24 hours when split schedules already exist. Partial split coverage
  researches only the missing discipline. Existing lookup/quote semantics and
  verified-row protection remain intact.
- `publicJobTypes.ts` provides an explicit allowlist for `POST /api/jobs`.
  Internal research and triage types cannot bypass their guarded triggers through
  this generic endpoint. The seven ordinary operator job types remain allowed.
- Extended production-path trigger tests and a test executing the actual route
  callback without starting the server cover these changes.

### Documents reaching learn/replay

- `submissionDocuments.ts` is shared by learning and ordinary staging/replay.
  Explicit operator uploads win a collision with generated forms. Generated
  forms retain the existing permit-path filtering. Previously learning and
  replay chose opposite versions of the same document.
- Applications, checklists, and sealed structural letters require the exact
  document type in both combined and split upload modes. Missing, oversized, or
  incompatible files stay missing; the plan set is not substituted.
- The replay sweep still accepts an available exact application, even though its
  slot forbids substitutes. Recorded legacy steps that say to upload a plan set
  into a named application/checklist/letter slot are refused.
- The real-browser local HTML test verifies native controls, chooser gaps,
  missing required/optional files, bytes sent, learned docType bindings, next-project
  replay, stale bad bindings, and the unrecorded replay sweep: 98 checks passed.

## Sandbox data work

An inventory of the nine non-archived projects is at
`..\project-document-audit.json` (snapshot before Trask ingestion).

| Project | Resolved path | Blocking missing documents at audit |
| --- | --- | --- |
| Ann Marineau | engineered | structural letter, building application, electrical application |
| Christopher Ivy | prescriptive | electrical application, solar checklist |
| Wynema Wright | engineered | structural letter, building application, electrical application |
| Connie Rhinesmith | prescriptive | building application, electrical application |
| Bren Trask | engineered | structural letter |

Trask's existing archive letter was matched to his name/address; page 2 has the
visible engineer seal and signature. It was ingested through
`saveProjectDocument` into **the sandbox only** as `structural_letter`.
The production inventory then reports no missing blocking documents for that
sandbox project. This proves presence/ingestion, not readiness of his actual
submission or compatibility with the later revised layout. The letter itself
requires review when the layout changes.

Manifest: `..\trask-ingestion-manifest.json`. Source and copied bytes match
SHA-256 `1c0f3bc384b277c3ae32cf44002e2bf975168ecb8a64e61594a337312040ed19`.
Shared KB, code profiles, templates, and fee schedules had identical hashes
before and after this project-scoped ingestion.

No receipts were imported. No original artifacts were quarantined or deleted.
No blank forms were newly fetched from the internet, no live LLM research was
used, and no portal was accessed or submitted. Local browser fixtures and
temporary test servers were the only browser/server verification.

## Verification and limitations

Environment: Windows PowerShell, Node 22.22.2, copied installed dependencies.

- Typecheck: passed (`..\typecheck.log`).
- Backend: all 122 registered test files passed. Per-entry process exits and
  timing: `..\backend-test-unit-results.json`; output:
  `..\backend-test-unit-final.log`.
- Portal unit chain: all 19 files completed, exit 0 (`..\portal-unit.log`). The
  previous autoLearnAdapter segfault did not reproduce here. This does not
  identify its cause or prove it fixed on Claude's previous environment.
- RecipeAdapter was re-run after the final replay guard: all 39 checks passed
  (`..\recipe-unit-final.log`).
- Exact upload browser regression: 98 checks passed (`..\exact-upload.log`).
- Smoke: passed against its scratch DB and mock portal (`..\smoke.log`).
- BCD tests cover Yes, No, mixed, unknown, multiple rows in malformed groups,
  changed thresholds, flat geometry, verified-map isolation, City/street fixes,
  and omission of unsupported defaults (`..\checklist-test.log`).
- PDF validation: two pages, zero fields/widgets, no AcroForm tree; both final
  page renders inspected. Existing source-font warnings remain in Poppler/pdfjs,
  but dangling XRef warnings were removed from the corrected output.
- `git diff --check`: passed.

Harness issues, recorded rather than hidden: an early backend run encountered a
transient in-progress placement error in `inspectFormFields`; that code was
corrected, the download test passed, and the final backend run was restarted.
At entry 94, the final runner's global `AUTOPILOT_AUTO_START=0` suppressed the
auto-resume feature the test expects. That harness override was removed and the
chain resumed at 94; all remaining entries passed. Do not call the earlier
failure an application defect. A DOM fixture initially omitted `type=button`
and was correctly ignored by the submit-button safety guard; the fixture was
corrected without weakening the guard.

Subagents hit account usage limits after leaving partial work. The main agent
completed and verified it. There is **no completed independent adversarial
sign-off** for this batch; do not claim one.

## Highest-priority remaining work

1. Complete the per-project acquisition/fill workflow. Acquisition is still
   opt-in via Find official form; learn/stage does not automatically acquire
   everything. Tigard's cached combined title was misleading: the held PDF is
   only BCD 5952. Separate electrical/building forms and the owner responsibility
   form in the operator's Tigard checklist still need source verification.
   Use the curated master links, then official sources; do not assume a statewide
   electrical form is accepted by a particular city.
2. Add a real attach-time permit-path guard for both uploaded and generated
   applications, including path changes after document-map assembly and manual
   learning on an unresolved path. This batch preserves the existing generated-
   form initial filter; it does **not** implement a live path callback at upload.
   Explicit uploaded wrong-path files can still bypass the initial filter.
3. Reconcile the six unfilled BCD statements with actual plans/operator evidence
   and expand structured extraction where facts are available. Do not equate
   roof spacing, module height, or roof-layer count alone with compound compliance.
   Do not auto-verify the new map/output.
4. Continue Ann/Ivy/Wynema file reconciliation, reversible quarantine of proven
   bad artifacts, receipts -> fee history with evidence, and full required-set
   proofs. Check Trask's letter against the latest layout before live ingestion.
5. An unmapped stored blank currently suppresses reacquisition despite being
   unusable by the filler. Distinguish held bytes from usable mapped templates;
   surface a re-map/manual state without repeated paid acquisition.
6. Review ambiguous AHJ/path requirements (Ann/Ivy pair, Salem contradictory
   profiles) using operator evidence. Do not invent a rule that demands both
   mutually exclusive applications.
7. Re-audit corrections/resubmit against actual source. The pasted statement
   that `resolveOpenCorrectionsOnResubmit` has zero callers is stale: current
   repository code already calls it during confirmation. Other correction UI
   and suspended-filing seams still need review.
8. Client tracking/credential-link UI and deployment hygiene remain. Docker still
   excludes `backend/data`, including the mandatory AHJ process reference.
   Ship it outside the mounted data directory and set
   `AHJ_PROCESS_REFERENCE_PATH`, or supply the reference through a mount.

Further source-level audit (taken before this batch's fixes):
`docs/CODEX_PIPELINE_AUDIT_2026-09-16.md`. Its items 1 and 2 are now addressed;
items 3/4 and acquisition caveats remain. Old line numbers may have shifted.

## Bringing changes back

Keep working in this isolated branch or apply the supplied patch to a clean
checkout based on `08c978d`. The original checkout and live database were not
updated. The patch contains source/tests/docs only, no copied private runtime
data. The regenerated PDF is a separate review artifact.

Useful commands from the working repository:

```powershell
npm run typecheck
npm run backend:test:unit
npm run portal:test:unit
node --import tsx portal-bot/src/adapters/exactDocumentUpload.dom.smoke.ts
npm run smoke
```

Scratch scripts under ignored `data/` document sandbox regeneration, inventory,
and Trask ingestion. Do not rerun the ingestion script blindly: it deliberately
asserts that the letter was initially missing and would otherwise create another
project-document row. Preserve the manifest instead of repeating the write.
