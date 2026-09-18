# SOLAR-Proj continuation — September 18, 2026

## Latest follow-up: Other - Solar construction category

User directed Other with Solar in category of construction. Added explicit Other/category-description support to both exact-revision Tigard maps; Connie snapshot stores `constructionCategory: Other`, `constructionCategoryOther: Solar`, with user provenance. No default was applied to other projects. Refreshed sandbox maps, restarted server, rebuilt and downloaded both PDFs, and visually verified Other checked and Solar in the correct category row. Form completeness regression and typecheck passed. Electrical has no remaining mapped required-field gaps; building still needs declared job valuation. Test-only contact details still need replacement before filing. Checkpoint: `work/before-category-other.sqlite`.

## Latest follow-up: owner contact and signing dates

User confirmed Connie's owner mailing address equals the installation address and explicitly authorized temporary test phone/email for this legacy intake record. Sandbox snapshot now has `14535 SW Klipsan Ln`, `Tigard, OR 97223`, synthetic `503-555-0142`, and `connie.rhinesmith@example.com`. `homeownerContactIsTest: true` and basis notes record the distinction. Replace the test contact values before any real filing. The plans say PHONE/EMAIL N/A; the utility bill has Gary's account email, which was not silently attributed to Connie. No contact-parser change was needed: existing canonical fields already feed the forms.

User separately authorized using the saved applicant/electrician signatures and signing dates. The exact-revision Tigard maps now place each operator's own signature and date in the measured signature rows (electrical page 1 and building page 3). Dates are rendered only when that role's signature is applied. The owner-installation signature/date remains blank because this is a contractor installation. Electrical forms now report missing owner email along with other missing contact details.

Validation: `formFeeCompleteness`, `curatedAhjForms`, and `signaturePlacement` passed; typecheck passed. Regression fills cover address/phone/email and both Tigard signing date layouts; unsigned output has no signing dates. Downloaded both updated forms through the actual HTTP endpoints, reopened/rendered and visually reviewed them. Construction category and declared valuation remain unresolved. Outputs are `outputs/connie-electrical-review.pdf` and `outputs/connie-building-review.pdf`. Database checkpoint: `work/before-owner-contact-signing.sqlite`. Original repository and source documents remain untouched. This follow-up supersedes the earlier statements that owner mailing address was unconfirmed and that no signatures were applied.

## Latest: incomplete forms and automatic fees

This batch addresses the user's report that the downloaded forms were not fully filled and automatic lookup missed fees printed on the applications. It does not certify a complete live filing or completion of the entire original transcript backlog.

- Expanded the exact-revision Tigard and Coos electrical maps: correct renewable tier/quantity, unit amount, subtotal, supported surcharges and grand total. Added conditional construction-category, parcel, declared valuation, floor count, and Coos land-use approval fields. No invented owner address, phone, valuation, signature, or construction type. Known fields come from the project/client; new intake extraction recognizes explicit occupancy, stories and parcel labels. Existing comp-shingle/contractor/module-height BCD fixes remain intact.
- The Coos form stays interactive; canonical AcroForm values survive saving and reopening. Fee text is sized to fit the small cells. Tigard's flat PDFs use overlays. Re-rendered and inspected Tigard electrical pages 1/2, building page 3, and Coos electrical output. Fee values were also reopened from Coos canonical fields.
- Known maps now list required fields that resolved empty. The dashboard shows **Needs details** and merges those gaps into the packet verdict; it no longer says every field is present while the official form has known missing particulars.
- Automatic reading now recognizes Tigard's printed PV fee box ($180 + $21.60 = $201.60), isolates the renewable table from the adjacent $75 limited-energy table and inspection-count column, and stops treating a new solar heading as continuation of a wind fee.
- The canonical fee evaluator now includes separately evidenced mandatory surcharges, rounded per charge. Only retrieved evidence can attach surcharge metadata; incoming model/replay metadata is stripped. Inclusive amounts are not surcharged again. Conflict, formula, discipline, authority and permit-path refusals remain. An incremental “no additional charge” line cannot become a free permit. Known electrical plan-review triggers (explicit yes/true or over three stories) leave the total unresolved until review is priced.
- **Connie/Tigard:** refreshed two seeded schedules from the live official FY2026-2027 Fees & Charges PDF, revised June 9, 2026: electrical $133.56 + state $16.03 = **$149.59**; building $180 + state $21.60 = **$201.60**; combined **$351.19**. Source: `https://www.tigard-or.gov/home/showpublisheddocument/3571/639184885640230000`. The prior receipt component is not relabelled merely because its amount happens to match.
- **Coos County electrical:** separately fetched the published base schedule and current electrical application (Revised 2025). Application supplies 12% state and 5% Community Development charges; these apply only to the county electrical line, not Coos Bay structural fees. Ivy: $135 + $16.20 + $6.75 = **$157.95**. Ann/Wynema: $160 + $19.20 + $8 = **$187.20** each. Conditional plan review remains subject to actual trigger facts. Sources: `https://co.coos.or.us/files/f9b20f31d/community_development_fees_-_effective_1_1_26.pdf` and `https://co.coos.or.us/files/5bb0a81e5/electrical_permit.pdf`. The July 2026 county-fee download found on the general fee page covers planning; do not assume it replaces the electrical schedule without inspecting its scope.
- User's Portland screenshot: **$762.93 due**, not paid, for IVR 5269491 / June 25, 2026 / 3915 N Kiska. Includes fire, land-use and processing fees in addition to electrical/building base + state. No matching Kiska project in the sandbox, so no unrelated project was updated and no newer Portland schedule was overwritten. Breakdown saved in `outputs/PDX_FEE_REVIEW.md`.
- User requested `access_programs`: exact setting was not found in installed CLI feature list or official config reference. No setting was invented or changed. Browser controls were usable; native program controls were not enabled by this work.

Validation: **22 targeted test files passed**, including fee source trust, conflict/discipline/path/formula handling, printed tables, exact-revision maps, missing fields, double-surcharge refusal, plan-review refusal, and the existing Portland form. Type checking and dashboard JS syntax passed. Full smoke passed earlier in this batch; final rerun is logged in `work/form-fee-smoke.log`. Actual HTTP download audit again covered **78 successful downloads across five projects**. Browser UI confirmed $351.19 for Connie and five distinct missing application particulars after Build Docs. New test is registered in `backend:test:unit`.

Data protection: `work/before-form-completeness-fees.sqlite` is the checkpoint. Only three seeded fee schedules changed: Tigard electrical, Tigard structural, Coos County electrical. All 21 code profiles, the one human-verified form map, all other fee schedules, and all 25 fee-history rows stayed unchanged. Original checkout remained clean. No portal submit, payment, deployment, production DB change, or external message.

Reproduction evidence (private, not committed): `work/form-fee-regression-results.json`, `work/form-fee-protected-data-check.json`, `work/fee-state-before.json`, `work/form-fee-connie-results.json`, `work/coos-fields-final.log`, `work/download-audit.json`, and `work/official-forms/`. Sandbox refresh scripts are in ignored `work/SOLAR-Proj/data/refresh-curated-maps.ts`, `refresh-tigard-fees.ts`, `refresh-coos-fees.ts`. Existing cached maps/schedules need those guarded refreshes when transferring the code to another DB; the source-code patch alone does not migrate cached rows. Scripts operate on the sandbox path and must be reviewed before adapting to any other database.

Remaining particulars: Connie's plans explicitly print owner PHONE/EMAIL N/A. Construction category, separate owner mailing address/city, owner phone, and declared job value remain unsupported; forms list these instead of guessing. Coos land-use approval number/date and other missing particulars are also listed. Signatures remain human work. Owner-address fallback question was optional and unanswered; do not claim the mailing address was confirmed. Whole-filing Portland fees and conditional review/other authority charges still require filing-specific evidence; this batch does not make every jurisdiction's quote complete.

## Resume here

Working copy: `C:\Users\isobl\Documents\Codex\2026-09-16\pu\work\SOLAR-Proj`

Branch: `codex/claude-continuation-2026-09-16`. Baseline: `08c978d96737f321e9b96811078fd3dc4fe84ed3`. First batch: `4be44c7`; follow-up is the latest local commit (`git log -2`). Nothing has been pushed, deployed, or applied to the original checkout.

Latest user direction: **avoid scope creep; make the current work reliable, then move to the next task.** This closes the current reliability batch. The remaining queue below is not claimed complete.

## Latest download verification — September 17 local / September 18 UTC

The latest user request was to test every expected download and the original workflow functionality. This follow-up fixes three missing official form templates and the download filename/UI defects found by that test. It does not claim a completed live filing.

- **78 actual HTTP downloads across Trask (11), Wynema (15), Ivy (17), Ann (16), and Connie (19): all 200; 65 PDFs parsed, 8 ZIP archives passed integrity checks, and 5 images decoded.** The count includes existing uploaded documents plus filled applications, not 78 distinct official form templates. Detailed local evidence: `work/download-audit.json`, `work/download-audit.log`, and `work/download-extra-validation.json`.
- Connie now has the Tigard building application, Tigard electrical application, and BCD checklist. Coos Bay's separate electrical application now downloads from Coos County and fills for Ann, Ivy, and Wynema. Ann and Wynema still correctly report a missing structural letter. Ivy's checklist still reports unsupported structural details; a present PDF does not certify those answers or make it ready to file.
- `curatedAhjForms.ts` supplies three exact-hash public PDF maps. Known-source acquisition runs before paid search and can operate without a model/API key. An unexpected revision or wrong jurisdiction is refused; existing verified maps are retained. Automatic preparation uses the existing 24-hour cooldown. `AHJ_FORM_DOWNLOADS=off` disables automatic free downloads as well. The broader master-link catalog has not all been individually mapped.
- Fixed stored-template downloads looking up the `tmpl-` prefix as part of the database ID, which produced a generic filename. Added an actual HTTP filename regression assertion.
- The dashboard keeps **Find missing official forms** and blank upload available after forms exist, refreshes the document inventory after lookup, and reports failures from additional forms rather than only the primary result. Confirmed Build Docs and Find through the real local dashboard.
- New maps fill known owner/project/contractor data using the existing electrical and supervisor license keys. They remain unverified. Unknown owner mailing addresses, construction categories, parcel/valuation particulars, signatures and fee totals remain blank. Tigard's published blanks carry historical printed fee tables; they are preserved as source content, never learned as current charges. The electrical revision displays its age warning. Coos County prints only "Revised 2025"; no month/day was invented.
- Rendered and visually inspected all five newly filled project PDFs (Connie x2, Coos Bay x3); reopened with pypdf, checked names/page counts, zero residual widgets, and unchanged instruction pages. Evidence: `work/official-forms/pdf-validation.json` plus rendered PNGs. Public blank fixtures and source provenance are committed; customer PDFs are not.
- **19 targeted test files passed**: the 18 in `work/download-functionality-final-results.json` plus `curatedAhjForms.test.ts`. Includes downloads, upload selection, required applications, provenance/freshness, BCD/roof evidence, fee research dedupe/estimates/path scope, correction state/application, client portal, credential requests, tenancy route scope, and simulated rehearsal. Typecheck, dashboard syntax check, diff check and smoke passed. This supplements, rather than repeats, the prior full-suite runs below.
- Final data audit: sandbox integrity OK; all 12 fee schedules, 21 code profiles and the existing verified form map unchanged; all 29 receipt source hashes, Connie's source plan and Trask's source letter unchanged. Connie still stores **Composition Shingle**, Contractor and 12-inch height, with the authorized two-layer upper bound explicitly marked as an assumption.

Latest server uses current code on `http://127.0.0.1:4273`, workers off and stub LLM. Private checkpoint before acquisition: `work/before-official-downloads.sqlite`. Repro scripts: `data/audit-downloads.ts`, `data/verify-official-acquisition.ts`, `data/refresh-curated-maps.ts`, and `work/verify-official-pdfs.py`. The acquisition script creates a backup before its run; don't overwrite the checkpoint casually. The refresh script updates only the three matching unverified known maps.

**Still open:** live correction-form reopening is not wired into production, despite passing correction bookkeeping tests. Real portal login/replay/resubmission and Docker build were not exercised here. Keep the current missing-document/verification gates; do not treat "filled" as signed or filing-ready. The scope remains reliability first, then the next task.

## Backup and operating boundaries (original record)

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

**Connie's current review PDF:** Contractor selected; City of Tigard department filled; composition shingle saved (confirmed by user and PV0.0/PV1.1). All nine structural Yes answers, truss and Method 1 are marked. Module height is checked after reviewing S1.1's continuous rail/roof-hook/truss arrangement and <=12-inch note against official ORSC Figure R324.4.1(2). Figure (3) is the unused blocking alternative. CSA listing is supported by the module datasheet mark.

**Roof-layer assumption authorized by the user:** after being told the material is composition shingle but the layer count was not established, the user instructed "just assume it is" (no more than two layers). The sandbox stores `roofLayers: 2` as an assumed upper bound, `roofLayersAssumed: true`, and an explicit `roofLayersBasis` plus evidence note. It is not a plan-extracted or independently verified exact layer count. The roofing Yes box is now marked. Private provenance: `work/pdf-review/connie-roof-assumption.json`. Homeowner phone, structure description, and BCD license remain blank where no stored mapped fact was supplied. This is a review PDF, not a complete filing packet. Both regenerated pages were visually checked; reopening confirms two pages, zero fields/widgets, and no AcroForm tree.

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
- Final PDF: both pages visually inspected; independent Yes/subchoice marks, Contractor and department verified. Roofing-layer Yes uses the explicitly authorized operator assumption described above.
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

1. Connie's roof-layer checkbox is complete using the operator-authorized assumption. Preserve its assumption provenance; update it if actual layer evidence becomes available.
2. The five-project download pass and three missing form maps are complete as detailed above. Remaining work is jurisdiction-specific owner/other requirements where evidence is ambiguous, unsupported checklist particulars, and broader master-link coverage. Generic research can still have classification/title limitations.
3. Resolve ambiguous jurisdiction/path profiles from operator evidence; check Trask's letter against the latest layout before live ingestion. Reconcile historical receipts with matching complete filing/project/date facts before making fee predictions.
4. Wire the tested safe correction-form chooser into actual live reopening. The helper exists, but that production continuation is not complete.
5. Build the Docker image in an environment with Docker and perform a separately authorized live workflow check. Broader UI reorganization is deferred under the user's scope limit.

The earlier `docs/CODEX_PIPELINE_AUDIT_2026-09-16.md` is historical. This handoff supersedes its now-fixed gap list. Continue from the isolated branch or apply `outputs/solar-continuation.patch` to a clean baseline checkout. The patch contains source/tests/configuration/docs, not the sandbox DB, customer PDFs, receipts, or environment backup. Data work is intentionally local and must not be mistaken for a production migration.
