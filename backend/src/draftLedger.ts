// EVERY DRAFT WE LEAVE ON A REAL PORTAL, WRITTEN DOWN WHERE IT CANNOT BE EVICTED.
//
// A learn or a benchmark run logs into the operator's real portal account and starts a real
// application. It never submits — but the draft stays, under the customer's licence, and
// nothing in this system deletes it. Miami has carried drafts like BD26-021147-001 for days.
// The replay self-test can mint a SECOND draft per run, so `--repeat 3 --self-test` on one
// portal can leave six.
//
// The run bundles under data/learn-runs/ were the only record, and they are pruned: a batch
// of fixture runs evicted every live-portal bundle in this repo within an hour, taking the
// evidence of what had been created with them. So this ledger is:
//   - APPEND-ONLY JSONL, never pruned, never rewritten;
//   - written the moment a run touches a portal, not at the end (a run that dies mid-way has
//     still created the draft, and that is exactly the case you want recorded);
//   - free of secrets — the credential is identified by its username REFERENCE, never a
//     password, and no field value is copied in.
//
// Read it with: npx tsx scripts/draft-ledger.ts
import fs from "node:fs";
import path from "node:path";

export interface DraftTouch {
  /** ISO timestamp of the moment we opened the portal. */
  at: string;
  /** Portal host, e.g. "apps.miami.gov" — the thing an operator searches by. */
  host: string;
  /** The URL the run entered on. */
  portalUrl: string;
  /** Which stored login this ran under (username reference only — NEVER a secret). */
  account: string;
  /** Our throwaway project id, so a bundle can be tied back to a portal draft. */
  projectId: string;
  /** Why we were there. Free-form but conventional: "auto-learn" (every non-benchmark
   *  autoLearnPortal run), "auto-learn +selftest (up to 2 drafts)", "benchmark learn",
   *  "benchmark+selftest (up to 2 drafts)", "annotation", "BACKFILL: ...". */
  purpose: string;
  /** The run bundle directory, when one exists. Bundles are pruned; this ledger is not. */
  bundleDir?: string;
  /** Anything the portal assigned that identifies the draft (process/application number). */
  portalReference?: string;
  /** Free-text note — e.g. "stopped at review, not submitted". */
  note?: string;
}

const LEDGER_PATH = (): string =>
  process.env.PORTAL_DRAFT_LEDGER || path.resolve(process.cwd(), "data", "portal-drafts.jsonl");

/**
 * Record that a run touched a live portal and may have left a draft.
 * Best-effort and never throws: failing to write the ledger must not fail the run, but it
 * IS logged loudly, because a silent ledger is worse than none.
 */
export function recordDraftTouch(touch: DraftTouch): void {
  try {
    const file = LEDGER_PATH();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(touch)}\n`, "utf8");
  } catch (e) {
    console.warn(`[draft-ledger] COULD NOT RECORD a live portal touch on ${touch.host}: ${String((e as Error)?.message || e)}`);
  }
}

/**
 * THE ROW FOR ANY RUN ABOUT TO OPEN A LIVE PORTAL — a learn, a staging replay, its headed retry, a
 * hand-coded staging adapter (dryrun-0928 B11: only the learn and the benchmark wrote the ledger,
 * so the building and electrical replays of a clean project left two drafts on Oregon ePermitting
 * that the list handed to a company for cleanup did not show).
 *
 * Secrets-safe by construction: the account is the credential store's username REFERENCE (the
 * non-secret half kept in the clear), never a decrypted username or password, and no field value is
 * copied in. A host miss with exactly ONE stored login mirrors getDecryptedCredentialAny (that login
 * is unambiguously the account the draft sits under); more than one and no host match leaves the
 * account empty — an empty account beats a guessed one in a cleanup ledger.
 */
export function buildDraftTouch(input: {
  portalUrl: string;
  projectId: string;
  purpose: string;
  note?: string;
  /** The client's stored logins — the API view, which never carries a secret. */
  credentials: Array<{ portalUrl: string; usernameReference: string }>;
}): DraftTouch {
  let host = "";
  try { host = new URL(input.portalUrl).hostname.toLowerCase(); } catch { host = ""; }
  const hit = input.credentials.find((c) => {
    try { return new URL(c.portalUrl).hostname.toLowerCase() === host; } catch { return false; }
  });
  const account = hit?.usernameReference ?? (input.credentials.length === 1 ? input.credentials[0].usernameReference : "");
  return {
    at: new Date().toISOString(),
    host,
    portalUrl: input.portalUrl,
    account: String(account ?? ""),
    projectId: input.projectId,
    purpose: input.purpose,
    ...(input.note ? { note: input.note } : {}),
  };
}

/** Attach a portal-assigned reference to the most recent touch for a project, if we learn one later. */
export function annotateDraft(projectId: string, portalReference: string, note?: string): void {
  if (!projectId || !portalReference) return;
  recordDraftTouch({
    at: new Date().toISOString(), host: "", portalUrl: "", account: "",
    projectId, purpose: "annotation", portalReference, note: note || "reference observed after the fact",
  });
}

export function readDraftLedger(): DraftTouch[] {
  try {
    const file = LEDGER_PATH();
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n")
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as DraftTouch; } catch { return null; } })
      .filter((x): x is DraftTouch => !!x);
  } catch { return []; }
}

export function draftLedgerPath(): string { return LEDGER_PATH(); }
