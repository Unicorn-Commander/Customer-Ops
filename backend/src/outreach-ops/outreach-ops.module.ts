import { Module } from '@nestjs/common';
import { OutreachPort } from './outreach-ops.port';
import { OutreachClient } from './outreach-ops.client';

/**
 * The Outreach federation seam (Phase 4 — the outreach/campaign surface).
 *
 * Binds the abstract `OutreachPort` (what the relationship layer depends on) to
 * the concrete `OutreachClient` (JSON-RPC MCP to the future Outreach app's
 * list_campaigns / list_touches_for_contact / enroll_contact /
 * schedule_social_touch). Consumers inject `OutreachPort`; tests override that
 * provider with a fake — Outreach is never required to be running (the Outreach
 * app is the next track).
 *
 * This is the ONLY place a real Outreach transport is constructed. Swapping to a
 * Brigade-brokered transport later is a provider change here, invisible to every
 * consumer — exactly like ContactOpsModule / AccountingOpsModule. Outreach
 * (fronting Listmonk + Postiz) remains the campaign system-of-record; this seam
 * never sends a campaign or stores a recipient list.
 */
@Module({
  providers: [{ provide: OutreachPort, useClass: OutreachClient }],
  exports: [OutreachPort],
})
export class OutreachOpsModule {}
