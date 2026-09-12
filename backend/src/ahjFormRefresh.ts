import type { AppDb } from "./db";
import type { LLMProvider } from "../../shared/src/types";
import { logger } from "./logger";
import { nowIso } from "./time";
import { parseJson } from "./json";
import { buildFieldMapForPdf, documentDateForPdf, fetchPdf, sha256, storeAhjFormTemplate, type StoredFieldMap } from "./ahjFormAuto";
import { knowledgeResearchHint } from "./knowledgeBase";
import { startPersistentSchedule } from "./schedulerState";

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

export interface RefreshSummary {
  checked: number;
  updated: number;
  brokenLinks: number;
  /** Broken links where re-research found the form's NEW home and re-stored it. */
  recovered: number;
  unchanged: number;
}

export async function refreshAhjFormTemplates(db: AppDb, llm: LLMProvider): Promise<RefreshSummary> {
  // Apply a change to the row's CURRENT field map, not to the snapshot this sweep read
  // minutes ago. Between the read at the top of the loop and the write below sits a fetch,
  // sometimes an LLM re-map and a web search — a long window in which an operator can open
  // the same template and verify or correct its mapping. Writing the stale object back
  // silently discarded that work. Re-reading immediately before the write closes it: the
  // sweep's own change still lands, but on top of whatever the human just did.
  const patchFieldMap = (id: string, patch: (current: StoredFieldMap) => StoredFieldMap, touchUpdatedAt = false): void => {
    const fresh = db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE id = ?", [id]);
    const current = parseJson<StoredFieldMap>(fresh?.field_map ?? "", {} as StoredFieldMap);
    const next = patch(current);
    if (touchUpdatedAt) db.run("UPDATE ahj_form_templates SET field_map = ?, updated_at = ? WHERE id = ?", [JSON.stringify(next), nowIso(), id]);
    else db.run("UPDATE ahj_form_templates SET field_map = ? WHERE id = ?", [JSON.stringify(next), id]);
  };

  const rows = db.query<TemplateRow>(
    "SELECT id, ahj_name, state, form_type, field_map FROM ahj_form_templates WHERE pdf_blob IS NOT NULL",
  );
  const summary: RefreshSummary = { checked: 0, updated: 0, brokenLinks: 0, recovered: 0, unchanged: 0 };
  const recoverCapRaw = Number(process.env.AHJ_FORM_RECOVER_MAX ?? 5);
  const recoverCap = Number.isFinite(recoverCapRaw) && recoverCapRaw >= 0 ? recoverCapRaw : 5;
  let recoverAttempts = 0;

  for (const row of rows) {
    const map = parseJson<StoredFieldMap>(row.field_map, {} as StoredFieldMap);
    if (!map.sourceUrl) continue; // operator-uploaded with no source link — nothing to re-check
    summary.checked += 1;

    let bytes = await fetchPdf(map.sourceUrl);
    if (!bytes) {
      summary.brokenLinks += 1;
      logger.warn("ahj-forms", `Form source link broken for ${row.ahj_name} (${row.state}): ${map.sourceUrl}`);
      // The AHJ likely MOVED the form (site redesign, new year's forms page) —
      // re-research its new home instead of only flagging. Capped per run so a
      // mass link-rot event can't burn unbounded web-search cost.
      let recoveredUrl = "";
      if (recoverAttempts < recoverCap) {
        recoverAttempts += 1;
        try {
          let hint: ReturnType<typeof knowledgeResearchHint> = null;
          try { hint = knowledgeResearchHint(db, { state: row.state, ahj: row.ahj_name }, "ahj"); } catch { /* optional */ }
          const research = await llm.findAhjFormUrl({ ahj: row.ahj_name, state: row.state, formType: row.form_type, knownContext: hint?.text });
          for (const url of [...research.candidateUrls, ...(hint?.pdfUrls || [])]) {
            if (url === map.sourceUrl) continue;
            const fresh = await fetchPdf(url);
            if (fresh) { bytes = fresh; recoveredUrl = url; break; }
          }
        } catch (err) {
          logger.warn("ahj-forms", `Re-research failed for ${row.ahj_name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!bytes || !recoveredUrl) {
        patchFieldMap(row.id, (cur) => ({
          ...cur,
          notes: `Source link last failed ${nowIso()} — kept the prior stored copy. ${cur.notes || ""}`.trim(),
          lastCheckedAt: nowIso(),
        }), true);
        continue;
      }
      summary.recovered += 1;
      map.sourceUrl = recoveredUrl; // fall through: re-map + re-store under the new URL
      logger.info("ahj-forms", `Recovered moved form for ${row.ahj_name} (${row.state}) at ${recoveredUrl}.`);
    }

    if (map.sourceHash && sha256(bytes) === map.sourceHash) {
      summary.unchanged += 1;
      patchFieldMap(row.id, (cur) => ({ ...cur, lastCheckedAt: nowIso() }));
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
    // HARD RULE: human-verified knowledge is never auto-overwritten. This used to
    // build a fresh map that dropped overlayFields, signatureFields, and the
    // verified flag entirely — a background job silently destroying an operator's
    // verified placement work because the AHJ re-published the PDF. The new blank
    // must replace the old (the old revision is obsolete at the counter), but the
    // mapping work is CARRIED OVER as a starting point and demoted to unverified,
    // so the fill gate blocks real submits until a human re-checks it.
    // Carry over from the CURRENT stored map, not the snapshot read before the fetch and
    // the LLM re-map. An operator who verified or corrected this template while that work
    // was in flight would otherwise have it overwritten by a minutes-old copy of itself.
    const live = parseJson<StoredFieldMap>(
      db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE id = ?", [row.id])?.field_map ?? "",
      map,
    );
    const wasVerified = Boolean(map.verified || live.verified);
    if (live.verified && !map.verified) {
      logger.warn("ahj-forms", `${row.ahj_name} (${row.state}) was verified by an operator while this refresh was running — their mapping is being carried over, not the pre-refresh copy.`);
    }
    // These are NEW bytes off the AHJ's site, so they carry a new self-description
    // — often the only visible sign of what changed. Re-read it here or the
    // refreshed row would keep answering "is this current" with the old form's
    // revision line, or with nothing at all.
    const documentDate = await documentDateForPdf(bytes);
    storeAhjFormTemplate(db, {
      ahjName: row.ahj_name,
      state: row.state,
      formType: row.form_type,
      filename: `${formName}.pdf`,
      bytes,
      documentDate,
      map: {
        formName,
        sourceUrl: map.sourceUrl,
        fillMode: newMap ? "acroform" : (live.fillMode || "overlay"),
        textFields: newMap?.textFields || live.textFields || {},
        checkboxes: newMap?.checkboxes || live.checkboxes || {},
        overlayFields: live.overlayFields,
        signatureFields: live.signatureFields,
        verified: false,
        notes: `Refreshed ${nowIso()} — the AHJ revised this form.` +
          (wasVerified ? ` The PREVIOUS mapping was human-verified and has been carried over as a starting point, but the revision may have moved fields — RE-VERIFY before any real submit.` :
            (newMap ? " Fields re-mapped from the new revision." : " Form changed; previous overlay mapping carried over — re-verify.")),
      },
    });
    if (wasVerified) {
      logger.warn("ahj-forms", `${row.ahj_name} (${row.state}) "${formName}" was HUMAN-VERIFIED and the AHJ revised it — mapping carried over but demoted to unverified. Re-verify before submitting.`);
    }
    summary.updated += 1;
    logger.info("ahj-forms", `Refreshed revised form for ${row.ahj_name} (${row.state}).`);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// KB link freshness: the imported reference rows carry portal URLs (and the
// learners keep adding more). AHJs and utilities move/rebrand portals, so a
// rotating sweep GETs each stored portal_url: alive → 'ok'; auth/bot-blocked →
// 'unknown' (NOT stale — many portals 403 non-browser agents); 404/network →
// 'dead', and for a capped number of dead links a re-research finds the new
// URL and stores it for next time (never overwriting a human-verified row).
// ---------------------------------------------------------------------------

export interface KbLinkCheckSummary {
  checked: number;
  ok: number;
  unknown: number;
  dead: number;
  /** Dead links replaced with a freshly researched URL. */
  replaced: number;
}

type LinkState = "ok" | "unknown" | "dead";

// Replace (not stack) any previous link-check note segment, so a fortnightly
// sweep doesn't grow the notes field forever.
function withLinkNote(notes: string, addition: string): string {
  const kept = (notes || "").split(" | ").map((s) => s.trim()).filter((s) => s && !/^Portal (link check|URL auto-updated)/.test(s));
  return [...kept, addition].join(" | ");
}

async function probeUrl(url: string): Promise<LinkState> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { redirect: "follow", signal: controller.signal });
      if (res.ok) return "ok";
      // Login walls / bot blocks / rate limits are NOT evidence the link is stale.
      if ([401, 403, 405, 429, 503].includes(res.status)) return "unknown";
      return res.status === 404 || res.status === 410 ? "dead" : "unknown";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "dead";
  }
}

export async function checkKnowledgeLinks(
  db: AppDb,
  llm: LLMProvider,
  opts: { limit?: number; researchCap?: number } = {},
): Promise<KbLinkCheckSummary> {
  const limitRaw = Number(opts.limit ?? process.env.KB_LINK_CHECK_MAX ?? 40);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 40;
  const researchCapRaw = Number(opts.researchCap ?? process.env.KB_LINK_RESEARCH_MAX ?? 5);
  const researchCap = Number.isFinite(researchCapRaw) && researchCapRaw >= 0 ? researchCapRaw : 5;

  // Rotate: never-checked first, then oldest. Rows actually used by projects
  // come first within each group so live jurisdictions stay freshest.
  const rows = db.query<{ id: string; state: string; ahj: string; utility: string; portal_url: string; confidence: string; notes: string }>(
    `SELECT id, state, ahj, utility, portal_url, confidence, notes FROM permit_utility_knowledge
      WHERE portal_url IS NOT NULL AND portal_url != ''
      ORDER BY link_checked_at IS NOT NULL, link_checked_at ASC, project_count DESC
      LIMIT ?`,
    [limit],
  );
  const summary: KbLinkCheckSummary = { checked: 0, ok: 0, unknown: 0, dead: 0, replaced: 0 };
  let researched = 0;

  for (const row of rows) {
    summary.checked += 1;
    const state = await probeUrl(row.portal_url);
    const ts = nowIso();
    if (state === "ok") {
      summary.ok += 1;
      db.run("UPDATE permit_utility_knowledge SET portal_link_status = 'ok', link_checked_at = ? WHERE id = ?", [ts, row.id]);
      continue;
    }
    if (state === "unknown") {
      summary.unknown += 1;
      db.run("UPDATE permit_utility_knowledge SET portal_link_status = 'unknown', link_checked_at = ? WHERE id = ?", [ts, row.id]);
      continue;
    }
    summary.dead += 1;
    let newUrl = "";
    if (researched < researchCap) {
      researched += 1;
      try {
        if (row.ahj) {
          const research = await llm.findAhjFormUrl({ ahj: row.ahj, state: row.state, knownContext: `The previously known portal URL is DEAD: ${row.portal_url} — find the AHJ's CURRENT submittal portal.` });
          newUrl = research.submittalPortalUrl || research.formsPageUrl || "";
        } else if (row.utility) {
          const research = await llm.researchUtilityRequirements({ utility: row.utility, state: row.state, knownContext: `The previously known portal URL is DEAD: ${row.portal_url} — find the utility's CURRENT interconnection/NEM portal.` });
          newUrl = research.portalUrl || "";
        }
      } catch (err) {
        logger.warn("kb-links", `re-research failed for ${row.ahj || row.utility}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (newUrl && newUrl !== row.portal_url && (await probeUrl(newUrl)) !== "dead") {
        // Human-verified ('mixed') rows keep their URL — flag for the operator instead.
        if (row.confidence === "mixed") {
          const note = withLinkNote(row.notes, `Portal link check ${ts}: stored URL is dead (${row.portal_url}); research suggests ${newUrl} — VERIFY and update.`);
          db.run("UPDATE permit_utility_knowledge SET portal_link_status = 'dead', link_checked_at = ?, notes = ?, updated_at = ? WHERE id = ?", [ts, note, ts, row.id]);
        } else {
          summary.replaced += 1;
          const note = withLinkNote(row.notes, `Portal URL auto-updated ${ts}: ${row.portal_url} was dead; replaced with ${newUrl} from re-research (verify on first use).`);
          db.run(
            "UPDATE permit_utility_knowledge SET portal_url = ?, portal_link_status = 'replaced', link_checked_at = ?, notes = ?, updated_at = ? WHERE id = ?",
            [newUrl, ts, note, ts, row.id],
          );
          logger.info("kb-links", `Replaced dead portal URL for ${row.ahj || row.utility} (${row.state}) with ${newUrl}.`);
        }
        continue;
      }
    }
    const note = withLinkNote(row.notes, `Portal link check ${ts}: ${row.portal_url} appears DEAD — needs a new URL.`);
    db.run("UPDATE permit_utility_knowledge SET portal_link_status = 'dead', link_checked_at = ?, notes = ?, updated_at = ? WHERE id = ?", [ts, note, ts, row.id]);
  }
  return summary;
}

// KB link sweep scheduler. KB_LINK_CHECK_DAYS (default 14); 0 disables.
// Clock persisted in scheduler_state — a restart resumes it rather than resetting it.
export function startKbLinkCheckScheduler(db: AppDb): void {
  const days = Number(process.env.KB_LINK_CHECK_DAYS ?? 14);
  if (!Number.isFinite(days) || days <= 0) {
    logger.info("kb-links", "KB link check scheduler disabled (KB_LINK_CHECK_DAYS <= 0).");
    return;
  }
  logger.info("kb-links", `KB link check scheduler started — sweeping stored portal links every ${days} day(s).`);
  startPersistentSchedule(db, {
    task: "kb_link_check",
    days,
    scope: "kb-links",
    tick: async () => {
      const { createLLMProvider } = await import("./llm");
      const summary = await checkKnowledgeLinks(db, createLLMProvider());
      if (summary.checked > 0) {
        logger.info("kb-links", `KB link check: ${summary.checked} checked — ${summary.ok} ok, ${summary.unknown} unknown, ${summary.dead} dead, ${summary.replaced} replaced.`);
      }
    },
  });
}

// Long-interval scheduler. AHJ_FORM_REFRESH_DAYS (default 60); 0 disables.
// Clock persisted in scheduler_state — the 60-day interval used to require 60 days
// of CONTINUOUS uptime, because the elapsed counter reset on every restart.
export function startAhjFormRefreshScheduler(db: AppDb): void {
  const days = Number(process.env.AHJ_FORM_REFRESH_DAYS ?? 60);
  if (!Number.isFinite(days) || days <= 0) {
    logger.info("ahj-forms", "AHJ form refresh scheduler disabled (AHJ_FORM_REFRESH_DAYS <= 0).");
    return;
  }
  logger.info("ahj-forms", `AHJ form refresh scheduler started — re-checking source links every ${days} day(s).`);
  startPersistentSchedule(db, {
    task: "ahj_form_refresh",
    days,
    scope: "ahj-forms",
    tick: async () => {
      const { createLLMProvider } = await import("./llm");
      const summary = await refreshAhjFormTemplates(db, createLLMProvider());
      if (summary.checked > 0) {
        logger.info("ahj-forms", `Form freshness check: ${summary.checked} checked, ${summary.updated} updated, ${summary.brokenLinks} broken link(s), ${summary.unchanged} unchanged.`);
      }
    },
  });
}
