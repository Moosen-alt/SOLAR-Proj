# Plan-Set Parsing API — onboarding packet

**What it is:** plan-set PDF in → structured project out: system size, modules/
inverters/battery (make/model/qty), electrical (bus/breaker/interconnection),
addresses, plus sheet SPLITTING (SLD, site plan, structural, specs, labels —
docSplitter.ts) and vision extraction (extractProjectFieldsFromImages). The
intake layer of the autopilot, useful standalone to CRMs/design firms/QC teams.

**Use today (internal):** upload plan_set → parse → `parserSnapshot`;
`POST /api/projects/:id/build-utility-package?target=permit|nem|all` returns
split sheets + ZIP. **Sellable shape:** `POST /parse` (PDF) → JSON fields +
per-sheet PDFs, metered per plan set; pairs naturally with the Plan Review API
(parse → review in one call is a premium tier).
