// AN INFRASTRUCTURE FAILURE IS NOT A BOT RESULT.
//
// The replay builder's "after2" run (.probe/brar2-replay-engine/after2.log) was not a
// measurement: from the SPA learn onward every browser launch failed ("browserType.launch: Target
// page, context or browser has been closed"), all 24 replay cells took 0.5 s, and the harness still
// printed a headline, "budget MET", "learn 2/3" and "VALIDITY TRIPWIRE ... no filing POST" for a
// probe whose browser never started. Those cells were scored as the bot failing, and the tripwire
// as the bot being safe — an unknown read as a result both ways.
//
// This module is the one place a scoreboard cell is classified as infrastructure. Pure: messages
// and durations in, a reason (or null) out. The bench marks such a cell SKIPPED (infrastructure),
// prints every headline and the tripwire as NOT MEASURED, and exits non-zero.

/** A browser that never started. Whatever the duration: nothing the bot did is in this cell. */
const LAUNCH_FAILED = /browserType\.launch|Failed to launch (the )?browser|Executable doesn't exist|spawn \S*(chrome|chromium)\S* (ENOENT|EACCES|UNKNOWN)|Browser closed\.\s*==+ logs|launchPersistentContext:/i;
/** The browser/context went away. Only infrastructure when the cell did no work at all (< 1 s):
 *  a browser that closes minutes into a run can be the bot's own doing (a closed page it caused). */
const CLOSED = /Target page, context or browser has been closed|Browser has been closed|browser has disconnected|Target closed/i;

/** Seconds under which a "closed" cell cannot have run a single step. */
export const INFRA_MAX_SECONDS = 1;

export interface CellForInfra {
  cell: string;
  seconds: number;
  /** Everything the cell reported: the bot's message, the harness skip reason. */
  messages: Array<string | null | undefined>;
}

/** Why this cell is an infrastructure failure, or null when it is a real (scorable) result. */
export function infrastructureFailure(c: CellForInfra): string | null {
  const text = c.messages.filter(Boolean).join(" | ");
  if (!text) return null;
  const launch = LAUNCH_FAILED.exec(text);
  if (launch) return `infrastructure: the browser did not launch (${launch[0]})`;
  const closed = CLOSED.exec(text);
  if (closed && Number.isFinite(c.seconds) && c.seconds < INFRA_MAX_SECONDS) {
    return `infrastructure: the browser was closed before the cell did any work (${closed[0]}, ${c.seconds}s)`;
  }
  return null;
}

export interface RunValidity {
  measured: boolean;
  /** Cells classified infrastructure, with the reason. */
  infrastructureCells: Array<{ cell: string; reason: string }>;
  /** One line for the headline block. */
  summary: string;
}

/** A run with ANY infrastructure cell has no headline: its denominators are not the bot's. */
export function runValidity(cells: CellForInfra[]): RunValidity {
  const infra = cells.map((c) => ({ cell: c.cell, reason: infrastructureFailure(c) })).filter((x): x is { cell: string; reason: string } => !!x.reason);
  if (!infra.length) return { measured: true, infrastructureCells: [], summary: `all ${cells.length} cell(s) ran on a working browser` };
  return {
    measured: false,
    infrastructureCells: infra,
    summary: `NOT MEASURED — ${infra.length} of ${cells.length} cell(s) failed on infrastructure, not on the bot (first: ${infra[0].cell}: ${infra[0].reason.slice(0, 140)})`,
  };
}
