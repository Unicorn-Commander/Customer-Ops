import { Module } from '@nestjs/common';
import { MeetingOpsPort } from './meeting-ops.port';
import { MeetingOpsClient } from './meeting-ops.client';

/**
 * The Meeting-Ops federation seam (Phase 5).
 *
 * Binds the abstract `MeetingOpsPort` (what the relationship layer + the
 * relationship agents depend on) to the concrete `MeetingOpsClient` (JSON-RPC MCP
 * read surface). Consumers inject `MeetingOpsPort`; tests override that provider
 * with a fake — Meeting-Ops is never required to be running.
 *
 * This is the ONLY place a real Meeting-Ops transport is constructed. Swapping to
 * a Brigade-brokered transport later is a provider change here, invisible to every
 * consumer. Meeting-Ops reads are viewer-level conversation signal — there is no
 * write path and no local Meeting-Ops table (federate, don't fork).
 */
@Module({
  providers: [{ provide: MeetingOpsPort, useClass: MeetingOpsClient }],
  exports: [MeetingOpsPort],
})
export class MeetingOpsModule {}
