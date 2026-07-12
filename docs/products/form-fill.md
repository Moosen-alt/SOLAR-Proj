# Form-Fill Service — onboarding packet

**What it is:** the official permit-application PDFs for an AHJ (building,
electrical, solar checklist), auto-acquired from the AHJ's own site, field-
mapped once (AcroForm or vision overlay for scanned forms), then filled from
project data on demand — signatures stamped where placements are verified.

## Use (current internal endpoints; wrap with x-api-key to sell)

- Acquire/refresh an AHJ's form set: `POST /api/projects/:id/find-ahj-form`
  (no formType = the full needed set). Templates persist per AHJ — one-time.
- Build filled PDFs: `POST /api/projects/:id/filled-forms` → per-form status;
  download: `GET /api/projects/:id/filled-forms/:formId` (real PDF, friendly name).
- Upload a blank when research can't find one: `POST /api/ahj-templates/upload
  ?ahj=...&state=...` (PDF body). Re-map: `POST /api/ahj-templates/:id/remap`.
- Templates auto-refresh every AHJ_FORM_REFRESH_DAYS (60): changed forms are
  re-mapped; dead links re-researched to the form's new home.

## Trust model (tell customers this)

Fresh mappings are UNVERIFIED — the first filled output must be previewed and
verified (`PATCH /api/ahj-templates/:id/verify`) before it's used on a real
submission. Verified mappings are deterministic thereafter.

## Sellable shape

POST project fields + AHJ → ZIP of filled official PDFs. The template library
(blank + verified field map per AHJ) is the moat; it grows with every customer.
