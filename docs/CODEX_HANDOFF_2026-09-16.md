# SOLAR-Proj continuation — September 17, 2026

## Resume here

Working copy: `C:\Users\isobl\Documents\Codex\2026-09-16\pu\work\SOLAR-Proj`

Branch: `codex/claude-continuation-2026-09-16`. Baseline: `08c978d96737f321e9b96811078fd3dc4fe84ed3`. First batch: `4be44c7`; follow-up is the latest local commit (`git log -2`). Nothing has been pushed, deployed, or applied to the original checkout.

Latest user direction: **avoid scope creep; make the current work reliable, then move to the next task.** This closes the current reliability batch. The remaining queue below is not claimed complete.

## Backup and operating boundaries

- Original: `C:\Users\isobl\SOLAR-Proj`, still clean at baseline on final inspection.
- Isolated copy: 49,608 files / 8.268 GiB, zero copy failures, including Git history and installed dependencies.
- Consistent SQLite baseline: `work/baseline-autopilot.sqlite`. Working DB: `work/SOLAR-Proj/backend/data/codex-sandbox.sqlite`; final integrity check is `ok`.
- Copied live environment was moved outside the repository to `work/original-config.env.backup`. Do not print, commit, or restore it for testing. Working `.env` selects the sandbox and disables research/triage.
- Copied project-document/screenshot/log paths were remapped to this workspace; manifest: `work/sandbox-path-remap.json`.
- `L:\INFINITY SOLAR DOCS` was read only. Final hashes match for all 29 receipt files, Connie's plan set, and Trask's structural letter. The original database was never opened for writes by this task.
- All 12 fee schedules, all 21 code profiles, and the existing verified form map match the baseline. Unverified BCD templates were intentionally replaced with the exact official revision map. No verified data was automatically overwritten.
- No portal submission, payment, outbound message, or production credential use occurred. Scratch/test databases and local browser fixtures were used for automated checks.

## Completed behavior

### Checklist and intake

The actual BCD 440-5952 (5/24/COM) blank is an AcroForm with malformed radio groups spanning unrelated Yes answers. Independent, geometry-checked marks now survive flattening. Recovery applies only to recognized, unverified BCD templates; verified maps stay protected. The exact official PDF hash selects a deterministic checklist map without a model call and corrects misleading research titles claiming it is an electrical/building application.

All nine structural rows and four conditional subchoices are supported. Compound requirements use individual facts; unknowns remain blank. Intake includes later structural pages, extracts explicit framing, module-height and attachment notes, and preserves those fields. A unique explicit roof-material label overrides a model guess caused by metal hardware elsewhere in the document; conflicting roof labels require review.

Contractor/Owner now uses explicit project installer role, otherwise an assigned contractor company. Explicit Owner wins over the company fallback. Supplemental overlays also render on AcroForms, fixing the blank Building department field. Existing City/street-address fixes and the removal of an unsupported literal UL listing-agency guess remain.

**Connie's current review PDF:** Contractor selected; City of Tigard department filled; composition shingle saved (confirmed by user and PV0.0/PV1.1). Eight of nine structural Yes answers, truss and Method 1 are marked. Module height is checked after reviewing S1.1's continuous rail/roof-hook/truss arrangement and <=12-inch note against official ORSC Figure R324.4.1(2). Figure (3) is the unused blocking alternative. CSA listing is supported by the module datasheet mark.

**One unresolved structural fact:** the number of existing composition-shingle layers. The user was asked whether it is no more than two; no answer had arrived at closeout. Do not silently invent one or two layers. The roofing row remains blank until that is confirmed. Homeowner phone, structure description, and BCD license are also blank where no stored mapped fact was supplied. This is a review PDF, not a complete filing packet. Both regenerated pages were visually checked; reopening confirms two pages, zero fields/widgets, and no AcroForm tree.

Connie sandbox project: `7ec74634-67eb-4288-b942-596c6e1e0098`. Template: `dd72483b-50e5-4e9d-b11d-08b50db934b1`. Private scripts/manifests: `data/correct-connie-checklist.ts`, `data/regenerate-connie.ts`, `work/pdf-review/connie-correction-manifest.json`. Do not rerun the correction script after new operator evidence without reviewing its payload. It deliberately records roof layers as unknown in its evidence note.

Official source: https://www.oregon.gov/bcd/Formslibrary/5952.pdf, SHA-256 `2490f9a571c1048e0338688fb0536c69b0dcd7aed34f623bb5b735b059e032cd`. Figure reference: https://www.oregon.gov/bcd/codes-stand/Documents/23orsc-summaryofamendments.pdf, printed page 75. Evidence copies/renderings are under `work/pdf-review/`.

### Correct documents, preparation, and downloads

Learning and replay share the same document resolver; explicit operator uploads win collisions with generated forms. Exact applications/checklists/structural letters cannot be replaced with a plan set. Wrong-path uploaded and generated applications are filtered; an attach-time callback reloads the project's current path and selected file immediately before native input, chooser, or replay sweep attachment. Unresolved manual AHJ learning is refused.

Learn/stage now prepares official documents before collecting inventory. Automatic research remains gated by configuration, with a persisted shared AHJ/state/path 24-hour cooldown. Cached forms can be filled without research; an unmapped or signature-only blank is reported as needing manual work rather than as a usable mapped form. Prescriptive checklists are not re-added to engineered projects. Acquisition/download tests exercise these paths.

Official BCD templates were acquired and filled in the sandbox for Ivy and Connie. Trask's archived structural letter was matched and copied into his sandbox project. Its seal/signature was visually checked; compatibility with a later revised layout was not established. `work/trask-ingestion-manifest.json` preserves provenance. Do not rerun its non-idempotent ingestion script blindly.

### Fees and receipts

Earlier fixes stop combined-fee research from entering a repeated retry loop and restrict the public jobs endpoint to the ordinary operator job allowlist.

Historical receipt components are now distinguished from complete filing costs. Narrow parsers validate identifiers, payment proof, amount arithmetic, duplicates, and supported formats; ambiguous/unpaid/processor-only documents refuse automatic import. Records retain normalized receipt metadata, not payer/email/card details. Component rows are excluded from whole-filing quote medians and never mark the current submission or customer invoice paid. Receipt extraction is connected to document intake; the project quote response and dashboard show linked components separately.

29 source PDFs reviewed, **25 unique paid components recorded in the sandbox**. Three duplicate files merged; one receipt covering two permits split; one unpaid bill and one processor-only confirmation excluded. Only Connie's identified historical permit receipt is linked to an active project: $351.19 authority + $10.36 processor = $361.55. Other records remain unlinked. Sheridan's ambiguous $2.50 service fee is retained as Other. Five manually reviewed receipt cases remain evidence-backed manual imports, not claims of generic OCR coverage.

See `outputs/RECEIPT_AUDIT.md`. Private source/hash manifests: `work/receipt-audit.json`, `work/receipt-import-manifest.json`. These contain private customer material and must not be committed. No historical full-fee schedule reconciliation is claimed.

### Corrections, UI, and local operation

Correction reviews now retain correction IDs. Proposal application targets exactly one pending correction review, refuses empty/repeated updates, and leaves other correction reviews intact. Legacy matching uses a unique exact excerpt and refuses ambiguity. The dashboard exposes current/proposed values and the existing apply-data endpoint. Applying data does not submit or automatically close the correction.

The Keelix reference (`https://keelixautomation.com`) informed darker teal surfaces, stronger text/borders, and clearer primary actions. Dashboard stages, help text, filters and action labels now consistently describe six stages. Mobile navigation/filter wrapping was checked. Archive visibility is opt-in. Client tracking and credential-request link buttons reuse existing endpoints; links are not automatically sent.

Docker reference JSON files are copied outside the data volume, with configurable reference paths. Loopback host and background-worker switches support isolated testing. Docker CLI is absent, so no image-build/deployment claim is made.

## Verification

- TypeScript typecheck, dashboard JS syntax, and `git diff --check`: passed after the latest fixes.
- 124 registered backend test files have passing results across the full run and added/affected targeted reruns. Original 122-file run preceded the last receipt/checklist refinements; affected receipt, fee, correction, required-application, BCD, shared filler, download and signature tests were rerun after their changes.
- All 19 registered portal test files passed. `autoLearnAdapter` first exceeded the harness's 600-second cap, then completed standalone with **33/33 checks and exit 0**. The timeout remains recorded as `previousAttempt`; no application timing/guard was weakened. A misleading harness resume footer was corrected explicitly.
- Exact-document local Chromium regression: **99 checks passed**, including learned/replayed bytes, wrong bindings, and current-path changes.
- Smoke test: passed with scratch DB/mock portal; SMTP unset. No live portal end-to-end or independent adversarial sign-off is claimed.
- Final PDF: both pages visually inspected; independent Yes/subchoice marks, Contractor and department verified. Roofing-layer answer remains intentionally unresolved.
- Sandbox integrity, protected-table equality, source hashes, and normalized receipt metadata checks passed: `work/closeout-verification.json`.

Logs: `work/backend-test-unit-results.json`, `work/portal-test-unit-results.json`, `work/auto-learn-followup.log`, `work/exact-upload-followup.log`, `work/smoke-followup.log`, `work/typecheck-followup.log`, `work/checklist-followup-final.log`, `work/bcd-acquisition-final.log`, `work/fee-receipts-test.log`, `work/correction-followup.log`, `work/required-app-followup.log`, `work/ahj-form-fill-final.log`, `work/filled-form-download-final.log`, `work/signature-placement-final.log`.

## Run the sandbox

Latest server was restarted with current code at `http://127.0.0.1:4273`, loopback only; background workers, research and auto-start disabled, stub LLM. Log: `work/sandbox-server-final.log`. The app may show historical copied failures/unsent messages; they were not sent by this task.

From the working repository (stop the existing listener before restarting):

```powershell
$env:PORT='4273'
$env:SERVER_HOST='127.0.0.1'
$env:BACKGROUND_WORKERS='off'
$env:AHJ_FORM_RESEARCH='off'
$env:AUTOPILOT_AUTO_START='0'
$env:SESSION_ENCRYPTION_KEY=([guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N'))
node --import tsx backend/src/server.ts
```

Working `.env` also disables fee/portal research and correction/triage workers. Never substitute the backed-up live environment for this preview. A new session encryption key is deliberately generated for the sandbox; existing production-encrypted credentials are not usable here.

## Separate queue — do not expand the current batch

1. Resolve Connie's remaining roof-layer confirmation, then regenerate/review. Retain unknowns if evidence is absent.
2. Verify the complete per-AHJ form set for Ann/Ivy/Wynema/Connie, including separate electrical/building/owner forms as applicable. General curated-master-link-first acquisition remains incomplete; generic research can still have classification/title limitations.
3. Resolve ambiguous jurisdiction/path profiles from operator evidence; check Trask's letter against the latest layout before live ingestion. Reconcile historical receipts with matching complete filing/project/date facts before making fee predictions.
4. Wire the tested safe correction-form chooser into actual live reopening. The helper exists, but that production continuation is not complete.
5. Build the Docker image in an environment with Docker and perform a separately authorized live workflow check. Broader UI reorganization is deferred under the user's scope limit.

The earlier `docs/CODEX_PIPELINE_AUDIT_2026-09-16.md` is historical. This handoff supersedes its now-fixed gap list. Continue from the isolated branch or apply `outputs/solar-continuation.patch` to a clean baseline checkout. The patch contains source/tests/configuration/docs, not the sandbox DB, customer PDFs, receipts, or environment backup. Data work is intentionally local and must not be mistaken for a production migration.
