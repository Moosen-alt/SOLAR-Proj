import type { AppDb } from "./db";
import { imapStatus, pollImap } from "./emailPoller";
import { logger } from "./logger";
import { runDuePermitChecks, runEmailTracker } from "./repository";

// Automated monitor scheduler — makes operation hands-off. On a fixed interval it runs
// the due permit/NEM status checks and the email tracker for every active source, so
// approvals, corrections, fees, and PTO updates are matched back to projects without a
// coordinator hitting endpoints. Mirrors startBackupScheduler/startJobWorker (setInterval
// + unref). Tunable via MONITOR_INTERVAL_MINUTES (default 15); 0 disables it.
export function startMonitorScheduler(db: AppDb): void {
  const minutes = Number(process.env.MONITOR_INTERVAL_MINUTES ?? 15);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    logger.info("monitor", "Monitor scheduler disabled (MONITOR_INTERVAL_MINUTES <= 0).");
    return;
  }

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // never overlap a slow run with the next interval
    running = true;
    try {
      const permit = await runDuePermitChecks(db, "all").catch((err) => {
        logger.warn("monitor", `permit/NEM checks failed: ${err instanceof Error ? err.message : String(err)}`);
        return { checked: 0, projects: [] };
      });

      let emailMatches = 0;
      const sources = db.query<{ id: string }>("SELECT id FROM email_tracking_sources WHERE active = 1");
      for (const source of sources) {
        try {
          const res = await runEmailTracker(db, { sourceId: source.id });
          emailMatches += res.matches?.length ?? 0;
        } catch (err) {
          logger.warn("monitor", `email tracker source ${source.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // IMAP live polling — runs when EMAIL_IMAP_HOST is configured. Fetches
      // new messages and runs them through the same email tracker pipeline as mbox.
      let imapMatches = 0;
      if (imapStatus().configured) {
        try {
          const imap = await pollImap(db);
          imapMatches = imap.matches;
          if (imap.fetched > 0) {
            logger.info("monitor", `IMAP: fetched ${imap.fetched} message(s), ${imap.matches} match(es).`);
          }
        } catch (err) {
          logger.warn("monitor", `IMAP poll failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (permit.checked > 0 || emailMatches > 0 || imapMatches > 0) {
        logger.info("monitor", `auto-run: ${permit.checked} permit/NEM check(s), ${emailMatches + imapMatches} email match(es) across ${sources.length} mbox source(s).`);
      }
    } catch (err) {
      logger.warn("monitor", `tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };

  logger.info("monitor", `Monitor scheduler started — permit/NEM checks + email tracker every ${minutes} min.`);
  // Defer the first run so it doesn't pile onto cold-start work.
  setInterval(() => void tick(), minutes * 60 * 1000).unref();
}
