import { Module } from '@nestjs/common';
import { ContactOpsPort } from './contact-ops.port';
import { ContactOpsClient } from './contact-ops.client';

/**
 * The Contact-Ops federation seam.
 *
 * Binds the abstract `ContactOpsPort` (what the relationship layer depends on)
 * to the concrete `ContactOpsClient` (JSON-RPC MCP + signed workspace
 * projection). Consumers inject `ContactOpsPort`; tests override that provider
 * with a fake — Contact-Ops is never required to be running.
 *
 * This is the ONLY place a real Contact-Ops transport is constructed. Swapping
 * to a Brigade-brokered transport later is a provider change here, invisible to
 * every consumer.
 */
@Module({
  providers: [{ provide: ContactOpsPort, useClass: ContactOpsClient }],
  exports: [ContactOpsPort],
})
export class ContactOpsModule {}
