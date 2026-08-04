import type { Response } from "express";

// Lightweight SSE broadcast bus — connects the background scheduler outputs
// (permit status changes, email corrections, MFA pauses, run failures) to the
// frontend without polling. Clients subscribe at GET /api/events.
//
// Design constraints:
//   - Single-process (no Redis); suitable for the embedded sqlite + tsx runtime.
//   - Events carry a typed payload; the frontend routes them to toasts and project
//     row badges without full re-fetches.
//   - No sensitive data in events: only status strings, project IDs, and short
//     human-readable messages.

export type SseEventType =
  | "correction_received"
  | "permit_issued"
  | "permit_ready_for_issue"
  | "nem_approved"
  | "run_paused"
  | "run_failed"
  | "run_complete"
  | "autopilot_started"
  | "staging_started"
  | "autolearn_progress"
  | "email_matched"
  | "intake_submitted"
  | "imap_poll_done"
  | "job_failed"
  | "ping";

export interface SseEvent {
  type: SseEventType;
  projectId?: string;
  message: string;
  data?: Record<string, unknown>;
}

const clients: Set<Response> = new Set();

export function sseSubscribe(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx/proxy buffering
  res.flushHeaders();
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

export function sseBroadcast(event: SseEvent): void {
  if (clients.size === 0) return;
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

// Heartbeat — keeps connections alive through proxies that close idle streams.
// Fires every 25 s; starts when first subscriber connects.
let heartbeatHandle: ReturnType<typeof setInterval> | null = null;

export function ensureHeartbeat(): void {
  if (heartbeatHandle) return;
  heartbeatHandle = setInterval(() => {
    if (clients.size === 0) return;
    sseBroadcast({ type: "ping", message: "heartbeat" });
  }, 25_000);
  heartbeatHandle.unref();
}
