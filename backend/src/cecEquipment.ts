// ---------------------------------------------------------------------------
// CEC solar equipment list sync. The California Energy Commission publishes the
// authoritative listings (modules + inverters) that utility portals (PowerClerk
// et al.) load their equipment dropdowns from — certified names there rarely
// match plan-set names. A weekly sync into cec_equipment feeds:
//   (a) certified-name candidates for the learner's equipment pass,
//   (b) an offline inverter-spec fallback (output A / W),
//   (c) an ADVISORY QC note when a parsed model isn't CEC-listed.
// No LLM anywhere — stub mode is identical. Failure-safe: rows are replaced
// only inside a transaction after a full successful parse + sanity gate, so a
// moved URL / layout change leaves a stale table, never a broken one.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import { readXlsx, pick, type SheetData } from "./xlsxRead";
import { id } from "./ids";
import { logger } from "./logger";
import { startPersistentSchedule } from "./schedulerState";
import { nowIso } from "./time";

export type CecKind = "module" | "inverter";

export interface CecRow {
  manufacturer: string;
  model: string;
  powerW: number | null;
  outputCurrentA: number | null;
  listedAt: string;
}

export interface CecSyncSummary {
  modules: number;
  inverters: number;
  skipped: string[];
  syncedAt: string;
}

// Defaults are the CEC's published solar-equipment-list workbooks; the CEC moves
// these paths occasionally — env is the operational truth, and the sanity gate
// makes a stale default harmless (old rows kept).
const CEC_DEFAULT_MODULES_URL =
  "https://solarequipment.energy.ca.gov/Home/DownloadtoExcel?filename=PVModuleList";
const CEC_DEFAULT_INVERTERS_URL =
  "https://solarequipment.energy.ca.gov/Home/DownloadtoExcel?filename=InvertersList";

function cecUrl(kind: CecKind): string {
  return kind === "module"
    ? process.env.CEC_MODULES_URL || CEC_DEFAULT_MODULES_URL
    : process.env.CEC_INVERTERS_URL || CEC_DEFAULT_INVERTERS_URL;
}

// Minimum plausible list sizes — the real lists are tens of thousands of rows;
// a truncated download or an error page must never wipe good data.
const SANITY_MIN: Record<CecKind, number> = { module: 500, inverter: 200 };

/** Fetch a URL and return the bytes only if it looks like a real xlsx (zip). */
export async function fetchXlsx(url: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(url, { redirect: "follow", signal: controller.signal });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      // xlsx = zip: PK\x03\x04 magic. Guard against HTML error pages.
      if (buf.length > 1000 && buf[0] === 0x50 && buf[1] === 0x4b) return buf;
      return null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

// CEC workbooks carry a deep preamble (title, contact info, footnote paragraphs
// — ~14 rows in the real lists) above the real header row, so readXlsx's
// first-non-empty-row-as-headers heuristic mis-keys them. The header row is the
// one whose cell is exactly "Manufacturer"/"Manufacturer Name" — footnote
// paragraphs merely CONTAIN the word, so an exact short-cell match is required.
function findHeaderedRows(sheet: SheetData): Record<string, string>[] {
  const isHeaderCell = (v: string) => /^manufacturer( name)?\s*$/i.test(v.trim());
  if (sheet.headers.some(isHeaderCell)) return sheet.rows;
  for (let i = 0; i < Math.min(sheet.rows.length, 30); i++) {
    const candidate = Object.values(sheet.rows[i]);
    if (!candidate.some(isHeaderCell)) continue;
    // Real headers embed newlines ("Grid Support\nListing Date") — collapse them.
    const headers = candidate.map((h, idx) => (h && h.trim() ? h.trim().replace(/\s+/g, " ") : `col${idx}`));
    return sheet.rows.slice(i + 1).map((r) => {
      const values = Object.values(r);
      const obj: Record<string, string> = {};
      headers.forEach((h, idx) => {
        const key = obj[h] !== undefined ? `${h}__${idx}` : h;
        obj[key] = values[idx] ?? "";
      });
      return obj;
    });
  }
  return [];
}

function num(v: string): number | null {
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse one CEC workbook into rows. Exported for tests (fetch-free). */
export function parseCecSheet(kind: CecKind, buf: Buffer): CecRow[] {
  const out: CecRow[] = [];
  const seen = new Set<string>();
  for (const sheet of readXlsx(buf)) {
    for (const row of findHeaderedRows(sheet)) {
      const manufacturer = pick(row, "Manufacturer Name", "Manufacturer");
      const model = pick(row, "Model Number", "Model");
      if (!manufacturer || !model) continue;
      const key = `${manufacturer.toLowerCase()}|${model.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let powerW: number | null;
      if (kind === "module") {
        powerW = num(pick(row, "Nameplate Pmax", "PTC", "Power Rating", "Nameplate"));
      } else {
        // The CEC grid-support list's power column ("Maximum Continuous Output
        // Power at Unity Power Factor") is in kW; values under 1000 are kW
        // (residential + commercial), values at/above are already watts.
        const raw = num(pick(row, "Rated Output Power", "Maximum Continuous Output Power", "Power Rating", "Rated Power"));
        powerW = raw === null ? null : raw < 1000 ? raw * 1000 : raw;
      }
      let outputCurrentA: number | null = null;
      if (kind === "inverter") {
        outputCurrentA = num(pick(row, "Maximum Continuous Output Current", "Output Current", "Rated Output Current"));
        if (outputCurrentA === null && powerW !== null) {
          // The CEC list has no current column — derive from nominal voltage.
          const volts = num(pick(row, "Nominal Voltage", "Voltage Nominal"));
          if (volts !== null && volts >= 100) outputCurrentA = Math.round((powerW / volts) * 100) / 100;
        }
      }
      out.push({
        manufacturer,
        model,
        powerW,
        outputCurrentA,
        listedAt: pick(row, "CEC Listing Date", "Grid Support Listing Date", "Listing Date", "Last Update"),
      });
    }
    // No break: the inverter workbook carries Solar_Inverters AND
    // Battery_Inverters sheets (hybrids appear on both; dedupe handles overlap).
  }
  return out;
}

/** Replace one kind's rows inside a transaction. Exported for tests. */
export function importCecRows(db: AppDb, kind: CecKind, rows: CecRow[]): number {
  const ts = nowIso();
  db.transaction(() => {
    db.run("DELETE FROM cec_equipment WHERE kind = ?", [kind]);
    for (const row of rows) {
      db.run(
        `INSERT OR IGNORE INTO cec_equipment (id, kind, manufacturer, model, power_w, output_current_a, listed_at, raw_json, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
        [id(), kind, row.manufacturer, row.model, row.powerW, row.outputCurrentA, row.listedAt || "", ts],
      );
    }
  });
  return rows.length;
}

export async function syncCecEquipment(db: AppDb): Promise<CecSyncSummary> {
  const summary: CecSyncSummary = { modules: 0, inverters: 0, skipped: [], syncedAt: nowIso() };
  for (const kind of ["module", "inverter"] as const) {
    const url = cecUrl(kind);
    const buf = await fetchXlsx(url);
    if (!buf) {
      summary.skipped.push(`${kind}: download failed or not an xlsx (${url}) — kept existing rows.`);
      logger.warn("cec-sync", `download failed for ${kind} list: ${url}`);
      continue;
    }
    let rows: CecRow[] = [];
    try {
      rows = parseCecSheet(kind, buf);
    } catch (err) {
      summary.skipped.push(`${kind}: parse failed (${err instanceof Error ? err.message : String(err)}) — kept existing rows.`);
      continue;
    }
    if (rows.length < SANITY_MIN[kind]) {
      summary.skipped.push(`${kind}: only ${rows.length} rows parsed (< ${SANITY_MIN[kind]} sanity floor) — layout likely changed; kept existing rows.`);
      logger.warn("cec-sync", `sanity gate: ${kind} parsed ${rows.length} rows — keeping old data`);
      continue;
    }
    const n = importCecRows(db, kind, rows);
    if (kind === "module") summary.modules = n;
    else summary.inverters = n;
  }
  primeCecCache(db);
  return summary;
}

const compact = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Words that appear in so many manufacturer names that matching on them would return
// noise rather than the certified name for THIS make.
const CEC_GENERIC_MAKE_WORDS = new Set([
  "solar", "energy", "power", "systems", "system", "technologies", "technology", "electric",
  "electronics", "america", "american", "international", "industries", "industry", "group",
  "company", "limited", "corporation", "holdings", "global", "green", "clean", "renewable",
  "manufacturing", "trading", "science", "sciences",
]);

/** Certified manufacturer names matching an operator/plan-set make ("apsystems"
 *  → "Altenergy Power System Inc."). Same compact normalization the static
 *  alias table uses; contains-match both ways, min 4 chars, capped at 5. */
export function certifiedNamesForMake(db: AppDb, kind: CecKind | "battery", make: string): string[] {
  const want = compact(make);
  if (want.length < 4 || kind === "battery") return []; // battery list not synced (column ready for later)
  try {
    const rows = db.query<{ manufacturer: string }>("SELECT DISTINCT manufacturer FROM cec_equipment WHERE kind = ?", [kind]);
    const out: string[] = [];
    // A DISTINCTIVE token from the plan-set make, for the very common case where the
    // certified name is a different phrase rather than a longer version of the same one.
    // Whole-string containment alone silently missed exactly the makes these projects use:
    //   "ZNShine Solar"  vs  "ZNSHINE PV-TECH Co., Ltd."   -> neither contains the other
    //   "Q CELLS"        vs  "Hanwha Qcells (Qidong) Co."
    // Generic words are excluded because "solar"/"energy"/"power" would match hundreds of
    // manufacturers and turn a precise lookup into noise; a token must also be >= 5 chars,
    // so "ap" from "AP Systems" cannot match half the list either. Makes whose certified
    // name shares NO distinctive token ("AP Systems" -> "Altenergy Power System Inc.")
    // remain the job of the curated alias table, which is why both sources are consulted.
    const tokens = String(make ?? "").toLowerCase().split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 5 && !CEC_GENERIC_MAKE_WORDS.has(t))
      .map((t) => t);
    for (const row of rows) {
      const c = compact(row.manufacturer);
      if (c.length < 4) continue;
      const whole = c.includes(want) || want.includes(c);
      const byToken = !whole && tokens.some((t) => c.includes(t));
      if (whole || byToken) {
        out.push(row.manufacturer);
        if (out.length >= 5) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

// In-memory inverter-spec cache so llm.ts stays DB-free (import direction:
// llm → cecEquipment only). Primed at startup and after each successful sync.
let inverterCache: Map<string, { manufacturer: string; model: string; powerW: number | null; outputCurrentA: number | null }> | null = null;

export function primeCecCache(db: AppDb): void {
  try {
    const rows = db.query<{ manufacturer: string; model: string; power_w: number | null; output_current_a: number | null }>(
      "SELECT manufacturer, model, power_w, output_current_a FROM cec_equipment WHERE kind = 'inverter'",
    );
    const map = new Map<string, { manufacturer: string; model: string; powerW: number | null; outputCurrentA: number | null }>();
    for (const r of rows) {
      map.set(compact(r.model), {
        manufacturer: r.manufacturer,
        model: r.model,
        powerW: r.power_w == null ? null : Number(r.power_w),
        outputCurrentA: r.output_current_a == null ? null : Number(r.output_current_a),
      });
    }
    inverterCache = map;
  } catch {
    inverterCache = null;
  }
}

/** Offline inverter lookup from the primed CEC cache. null when unprimed/empty/miss. */
export function lookupCecInverter(model: string): { manufacturer: string; model: string; powerW: number | null; outputCurrentA: number | null } | null {
  if (!inverterCache || !inverterCache.size) return null;
  const want = compact(model);
  if (want.length < 3) return null;
  const exact = inverterCache.get(want);
  if (exact) return exact;
  for (const [key, val] of inverterCache) {
    if (key.length >= 4 && (key.includes(want) || want.includes(key))) return val;
  }
  return null;
}

/**
 * The model string a PORTAL will actually list, for a plan-set model.
 *
 * Utility portals load their equipment dropdowns from the CEC list, whose model strings
 * carry suffixes a plan set does not. Measured against the synced list:
 *   plan set "Q.MI.349B-G1"            CEC "Q.MI.349B-G1 {240V}"
 *   plan set "ZXM7-SH108-410M"         CEC "ZXM7-SH108-410/M"
 *   plan set "DS3-L"                   CEC "DS3-L {240V}"  AND  "DS3-LV {120V}"
 *   plan set "Q.TRON BLK M-G2.C1+/AC"  CEC ...415 / 420 / 425 / 430 / 435 / 440
 *
 * Resolving this HERE rather than in the browser is what makes it work on every portal
 * shape: PowerClerk renders a native <select> on one page and a Vue combobox <input> on
 * another, and the combobox has no <option> elements to read, so a page-side matcher
 * silently gives up exactly where the equipment matters most.
 *
 * Rules, in order — the same ones a person would use:
 *   1. exact, including punctuation-insensitively ("410M" vs "410/M");
 *   2. otherwise the listing must START with the model at a TOKEN BOUNDARY, so "DS3-L"
 *      can never resolve to "DS3-LV";
 *   3. among several, the project's WATTAGE decides — it is the only thing separating the
 *      six Q.TRON options.
 * Returns "" when the choice stays ambiguous: filing the wrong module beats nothing.
 */
/**
 * True when `a` and `b` differ by exactly one INSERTED/DELETED LETTER.
 * Substitutions are deliberately excluded: at distance 1 they turn a trailing
 * revision letter into a different SKU ("…-440/M" vs "…-440/N").
 */
function oneLetterIndel(a: string, b: string): boolean {
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (long.length - short.length !== 1) return false;
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  if (!/[a-z]/.test(long[i] ?? "")) return false; // the extra character must be a letter
  return short.slice(i) === long.slice(i + 1);
}

export function certifiedModelFor(
  db: AppDb,
  kind: CecKind,
  make: string,
  model: string,
  watts?: string | number | null,
): string {
  const want = String(model ?? "").trim();
  if (!want) return "";
  const wantNorm = want.toLowerCase().replace(/\s+/g, " ").trim();
  const wantBare = wantNorm.replace(/[^a-z0-9]/g, "");
  if (wantBare.length < 3) return "";
  try {
    // Scope to the manufacturer when we can name it — two makes can ship models whose
    // strings collide, and the make is already resolved by the time this is asked.
    const makers = make ? certifiedNamesForMake(db, kind, make) : [];
    const rows = makers.length
      ? db.query<{ model: string; power_w: number | null }>(
        `SELECT model, power_w FROM cec_equipment WHERE kind = ? AND manufacturer IN (${makers.map(() => "?").join(",")})`,
        [kind, ...makers],
      )
      : db.query<{ model: string; power_w: number | null }>("SELECT model, power_w FROM cec_equipment WHERE kind = ?", [kind]);

    const boundary: string[] = [];
    const indel: string[] = [];
    const w = String(watts ?? "").replace(/[^0-9]/g, "");
    for (const row of rows) {
      const listed = String(row.model ?? "");
      const t = listed.toLowerCase().replace(/\s+/g, " ").trim();
      if (!t) continue;
      const tBare = t.replace(/[^a-z0-9]/g, "");
      if (t === wantNorm || tBare === wantBare) return listed; // exact
      if (t.startsWith(wantNorm)) {
        const next = t.charAt(wantNorm.length);
        if (!next || !/[a-z0-9]/.test(next)) boundary.push(listed);
      }
      // Plan sets drop or double a series letter ("ZXM7-UHLD108-440/N" for the
      // listed "ZXM7-UHLDD108-440/N"). Only a one-LETTER insert/delete counts,
      // and only when the listed wattage matches what the plan set states — a
      // digit edit would silently swap 440W for 445W, or 108 cells for 109.
      if (w && Number(row.power_w ?? 0) === Number(w) && oneLetterIndel(wantBare, tBare)) indel.push(listed);
    }
    if (boundary.length === 1) return boundary[0];
    if (boundary.length > 1 && w) {
      const byWatts = boundary.filter((b) => b.replace(/[^0-9]/g, "").includes(w));
      if (byWatts.length === 1) return byWatts[0];
    }
    // Fires only when nothing above matched and exactly one listing is a
    // one-letter edit away. Ambiguity means we say nothing, not "probably this".
    if (!boundary.length && wantBare.length >= 8 && indel.length === 1) return indel[0];
    return "";
  } catch {
    return "";
  }
}

/** Is a model on the CEC list? Used by the ADVISORY QC check. */
export function isCecListed(db: AppDb, kind: CecKind, model: string): boolean {
  const want = compact(model);
  if (want.length < 3) return false;
  try {
    const rows = db.query<{ model: string }>("SELECT model FROM cec_equipment WHERE kind = ?", [kind]);
    return rows.some((r) => {
      const c = compact(r.model);
      return c === want || (Math.min(c.length, want.length) >= 4 && (c.includes(want) || want.includes(c)));
    });
  } catch {
    return false;
  }
}

export function cecTableCount(db: AppDb, kind?: CecKind): number {
  try {
    const row = kind
      ? db.get<{ n: number }>("SELECT COUNT(*) n FROM cec_equipment WHERE kind = ?", [kind])
      : db.get<{ n: number }>("SELECT COUNT(*) n FROM cec_equipment");
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

// Weekly scheduler — clone of startAhjFormRefreshScheduler's shape (env-gated
// day-tick with the 32-bit setInterval-overflow guard). CEC_SYNC_DAYS default 7;
// <= 0 disables.
export function startCecSyncScheduler(db: AppDb): void {
  const days = Number(process.env.CEC_SYNC_DAYS ?? 7);
  if (!Number.isFinite(days) || days <= 0) {
    logger.info("cec-sync", "CEC equipment sync scheduler disabled (CEC_SYNC_DAYS <= 0).");
    return;
  }
  logger.info("cec-sync", `CEC equipment sync scheduler started — refreshing listings every ${days} day(s).`);
  // Clock persisted in scheduler_state — restarts resume it rather than resetting it.
  startPersistentSchedule(db, {
    task: "cec_sync",
    days,
    scope: "cec-sync",
    tick: async () => {
      const summary = await syncCecEquipment(db);
      logger.info("cec-sync", `CEC sync: ${summary.modules} module(s), ${summary.inverters} inverter(s)${summary.skipped.length ? `; skipped: ${summary.skipped.join(" | ")}` : ""}.`);
    },
  });
}
