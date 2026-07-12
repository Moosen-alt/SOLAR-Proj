# Permit Status Tracking API — onboarding packet

**What it is:** hands-off tracking of any permit/interconnection application:
`permitMonitor.ts` + `publicPermitStatus.ts` poll AHJ/utility portals on a
schedule (platform auto-detected from the URL: Accela, EnerGov, etc.), parse
status text, and classify transitions — approved, ready-to-issue (+fee due),
corrections (auto-bucketed with root cause), PTO. Email watch (IMAP/mbox
ingest) matches inbound AHJ/utility mail to the right record.

**Who buys:** installers without back-office staff, lenders waiting on PTO,
realtors/title (open-permit checks).

**Use today (internal):** create a target `POST /api/projects/:id/permit-targets`
{trackingUrl, permitNumber, targetType permit|nem}; scheduler polls
(MONITOR_INTERVAL_MINUTES); results in permit_status_checks + project timeline;
corrections spawn triage automatically. **Sellable shape:** POST a tracking
URL + permit number with an x-api-key, get webhooks on status change. Timeline
averages per AHJ (already learned) are a data upsell.
