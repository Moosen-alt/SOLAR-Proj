import type { AppDb } from "./db";
import type { LLMProvider } from "../../shared/src/types";
import { logger } from "./logger";
import { nowIso } from "./time";
import { buildFieldMapForPdf, sha256, storeAhjFormTemplate, type StoredFieldMap } from "./ahjFormAuto";

// ---------------------------------------------------------------------------
// Keep auto-acquired AHJ form templates current. AHJs revise their PDF forms
// periodically (new year, fee changes, new fields). On a long interval (default
// ~60 days) we re-fetch each stored template's source URL; if the blank PDF has
// changed, we re-download, re-map its fields, and update the stored copy. Broken
// links are flagged in notes (the stored copy is kept as a fallback).
// ---------------------------------------------------------------------------

interface TemplateRow {
  id: string;
  ahj_name: string;
  state: string;
  form_type: string;
  field_map: string;
}

async function fetchPdf(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const type = res.headers.get("content-type") || "";
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return buf;
    if (type.includes("pdf") && buf.length > 1000) return buf;
    return null;
  } catch {
    return null;
  }
}

export interface RefreshSummary {
  checked: number;
  updated: number;
  brokenLinks: number;
  unchanged: number;
}

export async function refreshAhjFormTemplates(db: AppDb, llm: LLMProvider): Promise<RefreshSummary> {
  const rows = db.query<TemplateRow>(
    "SELECT id, ahj_name, state, form_type, field_map FROM ahj_form_templates WHERE pdf_blob IS NOT NULL",
  );
  const summary: RefreshSummary = { checked: 0, updated: 0, brokenLinks: 0, unchanged: 0 };

  for (const row of rows) {
    let map: StoredFieldMap;
    try { map = JSON.parse(row.field_map || "{}"); } catch { continue; }
    if (!map.sourceUrl) continue; // operator-uploaded with no source link — nothing to re-check
    summary.checked += 1;

    const bytes = await fetchPdf(map.sourceUrl);
    if (!bytes) {
      summary.brokenLinks += 1;
      const note = `Source link last failed ${nowIso()} — kept the prior stored copy. ${map.notes || ""}`.trim();
      db.run("UPDATE ahj_form_templates SET field_map = ?, updated_at = ? WHERE id = ?", [
        JSON.stringify({ ...map, notes: note, lastCheckedAt: nowIso() }),
        nowIso(),
        row.id,
      ]);
      logger.warn("ahj-forms", `Form source link broken for ${row.ahj_name} (${row.state}): ${map.sourceUrl}`);
      continue;
    }

    if (map.sourceHash && sha256(bytes) === map.sourceHash) {
      summary.unchanged += 1;
      db.run("UPDATE ahj_form_templates SET field_map = ? WHERE id = ?", [
        JSON.stringify({ ...map, lastCheckedAt: nowIso() }),
        row.id,
      ]);
      continue;
    }

    // Changed (or never hashed): re-map fields and replace the stored copy.
    const formName = map.formName || `${row.ahj_name} form`;
    let newMap: { textFields: Record<string, string>; checkboxes: Record<string, { source: string; equals?: string }>; notes: string } | null = null;
    try {
      const built = await buildFieldMapForPdf(llm, { ahj: row.ahj_name, state: row.state, formName, bytes });
      if (built) newMap = built;
    } catch (err) {
      logger.warn("ahj-forms", `Re-map failed for ${row.ahj_name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    storeAhjFormTemplate(db, {
      ahjName: row.ahj_name,
      state: row.state,
      formType: row.form_type,
      filename: `${formName}.pdf`,
      bytes,
      map: {
        formName,
        sourceUrl: map.sourceUrl,
        fillMode: newMap ? "acroform" : "overlay",
        textFields: newMap?.textFields || map.textFields || {},
        checkboxes: newMap?.checkboxes || map.checkboxes || {},
        notes: newMap ? `Refreshed ${nowIso()} — AHJ revised the form; fields re-mapped.` : `Refreshed ${nowIso()} — form changed but has no fillable fields.`,
      },
    });
    summary.updated += 1;
    logger.info("ahj-forms", `Refreshed revised form for ${row.ahj_name} (${row.state}).`);
  }

  return summary;
}

// Long-interval scheduler. AHJ_FORM_REFRESH_DAYS (default 60); 0 disables.
export function startAhjFormRefreshScheduler(db: AppDb): void {
  const days = Number(process.env.AHJ_FORM_REFRESH_DAYS ?? 60);
  if (!Number.isFinite(days) || days <= 0) {
    logger.info("ahj-forms", "AHJ form refresh scheduler disabled (AHJ_FORM_REFRESH_DAYS <= 0).");
    return;
  }
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const { createLLMProvider } = await import("./llm");
      const summary = await refreshAhjFormTemplates(db, createLLMProvider());
      if (summary.checked > 0) {
        logger.info("ahj-forms", `Form freshness check: ${summary.checked} checked, ${summary.updated} updated, ${summary.brokenLinks} broken link(s), ${summary.unchanged} unchanged.`);
      }
    } catch (err) {
      logger.warn("ahj-forms", `refresh tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  logger.info("ahj-forms", `AHJ form refresh scheduler started — re-checking source links every ${days} day(s).`);
  // A days-long interval in ms overflows setInterval's 32-bit cap (~24.8 days),
  // which silently collapses the delay to 1ms — firing the refresh constantly.
  // Wake once a day (safely within the cap) and only run the tick once the full
  // interval has elapsed.
  const intervalMs = days * 24 * 60 * 60 * 1000;
  const stepMs = Math.min(intervalMs, 24 * 60 * 60 * 1000);
  let elapsedMs = 0;
  setInterval(() => {
    elapsedMs += stepMs;
    if (elapsedMs >= intervalMs) {
      elapsedMs = 0;
      void tick();
    }
  }, stepMs).unref();
}
