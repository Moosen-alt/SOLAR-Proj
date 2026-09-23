import type { Response } from "express";

// Lightweight SSE broadcast bus — connects the background scheduler outputs
// (permit status changes, email corrections, MFA pauses, run failures) to the
// frontend without polling. Clients subscribe at GET /api/events.
//
// Design constraints:
//   - Single-process (no Redis); suitable for the embedded sqlite + tsx runtime.
//   - Events carry a typed payload; the frontend routes them to toasts and project
//     row badges without full re-fetches.
//   - Events are PER-TENANT. Every subscriber is registered with the org it belongs
//     to, and an event is delivered only to that org's sockets (plus superadmins).
//
// The per-tenant rule exists because this bus previously fanned every event out to
// every connected socket. The comment here used to claim "no sensitive data in
// events: only status strings, project IDs, and short human-readable messages" —
// but the scheduler broadcasts `Permit issued for ${homeownerName}`, so the
// invariant was already false and one company's dashboard showed another's
// homeowner names in real time. SQL scoping cannot fix that; it has to be fixed
// here.

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
  | "stage_steps_done"
  | "ping";

export interface SseEvent {
  type: SseEventType;
  projectId?: string;
  message: string;
  data?: Record<string, unknown>;
}

interface Subscriber {
  res: Response;
  orgId: string;
  /** Superadmin sockets receive every org's events — the operator watches everything. */
  crossOrg: boolean;
}

const clients: Set<Subscriber> = new Set();

/**
 * Resolve the owning org of a project id. Injected by the server at startup so this
 * module stays free of a database import (it is imported by nearly everything).
 */
type OrgResolver = (projectId: string) => string | null;
let resolveProjectOrg: OrgResolver = () => null;
export function setSseOrgResolver(fn: OrgResolver): void {
  resolveProjectOrg = fn;
}

export function sseSubscribe(res: Response, scope: { orgId: string; crossOrg: boolean }): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx/proxy buffering
  res.flushHeaders();
  const sub: Subscriber = { res, orgId: scope.orgId, crossOrg: scope.crossOrg };
  clients.add(sub);
  res.on("close", () => clients.delete(sub));
}

/**
 * Deliver an event to the tenant it belongs to.
 *
 * Routing, in order:
 *   • `ping` is contentless plumbing — everyone gets it.
 *   • An event naming a project goes to that project's org (and to superadmins).
 *   • An event naming NO project can't be attributed, so it goes ONLY to
 *     superadmins. That is the fail-closed direction: an unattributable event is
 *     never shown to a tenant who might not own it.
 */
export function sseBroadcast(event: SseEvent): void {
  if (clients.size === 0) return;
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const targetOrg = event.type === "ping" ? null : (event.projectId ? resolveProjectOrg(event.projectId) : undefined);

  for (const client of clients) {
    // targetOrg === null  → broadcast to all (ping only)
    // targetOrg === undefined or unresolvable → superadmins only
    const deliver = targetOrg === null
      ? true
      : client.crossOrg || (typeof targetOrg === "string" && targetOrg === client.orgId);
    if (!deliver) continue;
    try {
      client.res.write(payload);
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
