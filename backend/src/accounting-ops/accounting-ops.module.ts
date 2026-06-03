import { Module } from '@nestjs/common';
import { AccountingOpsPort } from './accounting-ops.port';
import { AccountingOpsClient } from './accounting-ops.client';

/**
 * The Accounting-Ops federation seam (Phase 3 — the invoicing surface).
 *
 * Binds the abstract `AccountingOpsPort` (what the relationship layer depends
 * on) to the concrete `AccountingOpsClient` (JSON-RPC MCP to AO's native
 * create_invoice_from_draft / get_invoice). Consumers inject `AccountingOpsPort`;
 * tests override that provider with a fake — Accounting-Ops is never required to
 * be running.
 *
 * This is the ONLY place a real Accounting-Ops transport is constructed.
 * Swapping to a Brigade-brokered transport later is a provider change here,
 * invisible to every consumer — exactly like ContactOpsModule. AO remains the
 * ledger system-of-record; this seam never posts a journal entry.
 */
@Module({
  providers: [{ provide: AccountingOpsPort, useClass: AccountingOpsClient }],
  exports: [AccountingOpsPort],
})
export class AccountingOpsModule {}
