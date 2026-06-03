import { Module } from '@nestjs/common';
import { EmailOpsPort } from './email-ops.port';
import { EmailOpsClient } from './email-ops.client';

/**
 * The Email-Ops federation seam (Phase 4 — the mailbox/thread surface).
 *
 * Binds the abstract `EmailOpsPort` (what the relationship layer depends on) to
 * the concrete `EmailOpsClient` (JSON-RPC MCP to the future Email-Ops app's
 * list_threads_with_contact / list_thread_messages / compose_email). Consumers
 * inject `EmailOpsPort`; tests override that provider with a fake — Email-Ops is
 * never required to be running (the Email-Ops app is the next track).
 *
 * This is the ONLY place a real Email-Ops transport is constructed. Swapping to a
 * Brigade-brokered transport later is a provider change here, invisible to every
 * consumer — exactly like ContactOpsModule / AccountingOpsModule /
 * OutreachOpsModule. Email-Ops (fronting Stalwart) remains the mailbox
 * system-of-record; this seam never stores a message body or copies a thread.
 */
@Module({
  providers: [{ provide: EmailOpsPort, useClass: EmailOpsClient }],
  exports: [EmailOpsPort],
})
export class EmailOpsModule {}
