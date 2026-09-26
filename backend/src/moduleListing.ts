// THE MODULE'S LISTING AGENCY, READ FROM THE MODULE'S OWN DATASHEET — text layer first, then a
// vision read of the datasheet page when the text layer is empty (operator authorization
// 2026-09-25: "parse anything you can … read EVERY document … through the vision pass when the text
// layer is empty"). BCD 5952 Part IV asks for it; on City of Jefferson the module_spec upload
// extracted 799 characters of title block and the listing marks (UL 61730, CSA) were an image.
//
// Only the MODULE datasheet is read (never the plan set's other equipment sheets — "AC DISCONNECT
// UL CERTIFICATION" on a plan set is not the module's listing). The answer lands on the project
// through updateProject with its evidence, once; a vision read that finds nothing records that it
// looked, so it is not paid for again.
import type { LLMProvider, ProjectRecord } from "../../shared/src/types";
import type { AppDb } from "./db";
import { listingAgencyFromText } from "./bcdChecklistFacts";

export const LISTING_VISION_PROMPT = `This image is a page of a solar PV MODULE datasheet (it may also show other equipment).
Report ONLY the certification / listing marks and standards printed for the PV MODULE — not for an inverter, microinverter, racking or any other product.
Return ONLY JSON: {"listingAgency": "UL" | "ETL (Intertek)" | "CSA" | "TÜV" | "", "standards": ["<each standard printed, e.g. UL 61730-1>"], "quote": "<the exact printed words naming the mark/standard>"}
If the page shows no listing for the module, return {"listingAgency": "", "standards": [], "quote": ""}. Never guess.`;

export interface ListingReading { agency: string; quote: string; source: "snapshot" | "text" | "vision" | "none" }

export async function ensureModuleListingAgency(
  db: AppDb,
  project: ProjectRecord,
  llm: Pick<LLMProvider, "visionExtract"> | null,
): Promise<ListingReading> {
  const snap = (project.parserSnapshot ?? {}) as Record<string, unknown>;
  const existing = String(snap.moduleListingAgency ?? "").trim();
  if (existing) return { agency: existing, quote: String(snap.moduleListingAgencyEvidence ?? ""), source: "snapshot" };
  const row = db.get<{ extracted_text?: string; stored_path?: string; content_type?: string }>(
    "SELECT extracted_text, stored_path, content_type FROM project_documents WHERE project_id = ? AND doc_type = 'module_spec' ORDER BY uploaded_at DESC LIMIT 1",
    [project.id],
  );
  if (!row) return { agency: "", quote: "", source: "none" };
  const fromText = listingAgencyFromText(String(row.extracted_text ?? ""));
  const save = async (agency: string, quote: string, source: "text" | "vision") => {
    const { updateProject } = await import("./repository");
    updateProject(db, project.id, { moduleListingAgency: agency, moduleListingAgencyEvidence: `${source === "vision" ? "module datasheet (vision read)" : "module datasheet text"}: ${quote}`.slice(0, 300) } as never);
  };
  if (fromText.agency) {
    await save(fromText.agency, fromText.quote, "text");
    return { agency: fromText.agency, quote: fromText.quote, source: "text" };
  }
  if (!llm || String(snap.moduleListingAgencyLookedAt ?? "").trim()) return { agency: "", quote: "", source: "none" };
  const pdfPath = String(row.stored_path ?? "");
  if (!pdfPath || !/pdf/i.test(`${row.content_type ?? ""} ${pdfPath}`)) return { agency: "", quote: "", source: "none" };
  const { renderPdfPageToPng } = await import("./pageImages");
  let found: { agency: string; quote: string } = { agency: "", quote: "" };
  for (const page of [1, 2]) {
    let png: Buffer;
    try { png = await renderPdfPageToPng(pdfPath, page); } catch { break; }
    let raw: Record<string, unknown> = {};
    try { raw = await llm.visionExtract({ imageBase64: png.toString("base64"), mimeType: "image/png", prompt: LISTING_VISION_PROMPT }); } catch { break; }
    const agency = String(raw.listingAgency ?? "").trim();
    const quote = String(raw.quote ?? "").trim();
    // The quote must itself name the mark (the same predicate the text path uses) — an answer the
    // printed words do not support is not an answer.
    if (agency && quote && listingAgencyFromText(quote).agency === agency) { found = { agency, quote }; break; }
  }
  const { updateProject } = await import("./repository");
  if (found.agency) {
    await save(found.agency, found.quote, "vision");
    return { ...found, source: "vision" };
  }
  updateProject(db, project.id, { moduleListingAgencyLookedAt: new Date().toISOString() } as never);
  return { agency: "", quote: "", source: "none" };
}
