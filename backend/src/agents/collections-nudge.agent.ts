/**
 * CollectionsNudgeAgent (Phase 5) — draft a polite payment nudge for overdue AR.
 *
 * The agent COMPOSES (it does not own any data):
 *   - the LOCAL relationship (RLS tx),
 *   - the FEDERATED Contact-Ops contact (display name + primary email — read-time),
 *   - the FEDERATED Accounting-Ops invoice panel (the customer's invoices + LIVE
 *     status, polled via the Phase-3 CustomersService.invoicesForUser path) — from
 *     which it selects the OVERDUE ones (sent/partial, past due, balance > 0),
 * then hands a prompt to the 4-lane inference seam and parses a STRUCTURED draft
 * (subject + body). It logs ONE CustomerActivity(AGENT_RUN) and returns the draft.
 *
 * DRAFT ONLY (binding): the agent NEVER sends the nudge, never charges, never posts
 * a ledger entry. Accounting-Ops remains the AR system-of-record; the agent only
 * READS invoice status and drafts a reminder a human approves + sends.
 * `draftOnly:true` is asserted on the result. (Optional Email-Ops staging is
 * intentionally NOT wired here — a payment reminder is sensitive; the cockpit hands
 * the draft to a human who decides the channel.)
 *
 * DEGRADE-CLEAN: when Accounting-Ops is unconfigured/not entitled there are no
 * invoices to read → the agent returns accountingConfigured:false + an empty
 * overdue list + a note (no draft), never throwing. When inference is unconfigured/
 * not entitled it returns the overdue snapshot with a null subject/body + a note.
 *
 * ENTITLEMENT: the inference call is gated through
 * AgentInferencePort.checkEntitlement (bundled tier). Reading the invoice panel is
 * viewer-level on Accounting-Ops (the Phase-3 path already enforces the AR
 * affordances).
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CustomerActivityKind, User } from '@prisma/client';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { WorkspaceTxClient } from '../prisma/prisma.service';
import { WithWorkspaceClaim, entitlementsOf, ucUidOf } from '../common/workspace/workspace.util';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { CustomersService } from '../customers/customers.service';
import { AgentInferencePort, InferenceContext } from './inference/agent-inference.port';
import { AgentInferenceEcho, CollectionsNudgeResult, OverdueInvoiceView } from './agents.types';
import { InferenceTier } from './inference/agent-inference.types';
import { safeJsonObject, strOrNull } from './agent-parse.util';

@Injectable()
export class CollectionsNudgeAgent {
  private readonly logger = new Logger(CollectionsNudgeAgent.name);

  constructor(
    private readonly workspaces: WorkspaceContextService,
    private readonly contactOps: ContactOpsPort,
    private readonly inference: AgentInferencePort,
    // Reused for the FEDERATED invoice panel (Phase-3 AO poll path). Read-only.
    private readonly customers: CustomersService,
  ) {}

  async draftNudge(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    requestedWorkspaceId?: string | null,
    tier: InferenceTier = 'bundled',
  ): Promise<CollectionsNudgeResult> {
    const ucUid = ucUidOf(user);
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);

    // 1) LOCAL relationship (RLS tx; 404 if absent).
    const rel = await this.workspaces.runForUser(
      user,
      (tx) => this.loadRelationship(tx, customerId),
      requestedWorkspaceId,
    );

    // 2) FEDERATE the contact + the invoice panel (live AO status, Phase-3 path).
    const fedCtx = { workspaceId, ucUid: ucUid || null };
    const [contact, panel] = await Promise.all([
      this.contactOps.getContact(fedCtx, rel.contactId).catch(() => null),
      this.customers.invoicesForUser(user, customerId, requestedWorkspaceId).catch(() => null),
    ]);

    const toAddress = contact?.primaryEmail ?? null;
    const accountingConfigured = !!panel?.configured;

    // Select the OVERDUE invoices: sent/partial, past the due date, balance > 0.
    const today = new Date();
    const overdueInvoices: OverdueInvoiceView[] = (panel?.items ?? [])
      .filter((it: Record<string, any>) => this.isOverdue(it, today))
      .map((it: Record<string, any>) => ({
        externalRef: it.externalRef,
        invoiceNumber: it.invoiceNumber ?? null,
        status: it.status ?? null,
        balanceDue: it.balanceDue ?? null,
        currency: it.currency ?? 'USD',
        dueDate: it.dueDate ?? null,
      }));

    const totalOverdue = overdueInvoices.length
      ? overdueInvoices.reduce((sum, inv) => sum + Number(inv.balanceDue ?? 0), 0).toFixed(2)
      : null;

    // 3) ENTITLEMENT + INFERENCE (bundled tier). Skip inference when there is
    //    nothing overdue to nudge about (degrade-clean, no wasted call).
    const infCtx: InferenceContext = {
      workspaceId,
      ucUid: ucUid || null,
      entitlements: entitlementsOf(user),
    };
    const gate = this.inference.checkEntitlement(infCtx, tier);
    const configured = this.inference.isConfigured();

    let subject: string | null = null;
    let body: string | null = null;
    let inferenceEcho: AgentInferenceEcho | null = null;
    let note: string;

    if (overdueInvoices.length === 0) {
      note = accountingConfigured
        ? 'No overdue invoices for this customer — nothing to nudge.'
        : 'Accounting-Ops is not connected — cannot read invoices, so no nudge was drafted.';
    } else if (!configured) {
      note = `Found ${overdueInvoices.length} overdue invoice(s) but inference is not configured — no draft produced (connect inference to draft).`;
    } else if (!gate.allowed) {
      note = `Not entitled to run the collections-nudge agent: ${gate.reason}`;
    } else {
      const result = await this.inference.complete(infCtx, {
        task: 'collections-nudge',
        tier,
        responseFormat: 'json',
        temperature: 0.3,
        maxOutputTokens: 800,
        messages: this.buildPrompt(contact?.displayName ?? null, overdueInvoices, totalOverdue),
      });
      if (!result) {
        note = 'Inference gateway did not return a result — no draft produced.';
      } else {
        inferenceEcho = {
          lane: result.lane,
          model: result.model,
          metered: result.metered,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
        };
        const parsed = safeJsonObject(result.text);
        subject = strOrNull(parsed?.['subject']);
        body = strOrNull(parsed?.['body']);
        note =
          subject && body
            ? `Polite payment-reminder draft ready for ${overdueInvoices.length} overdue invoice(s) (${totalOverdue ?? '?'} due).`
            : 'Inference returned an unparseable draft.';
      }
    }

    // 4) LOG the agent run (RLS tx).
    await this.logRun(user, customerId, requestedWorkspaceId, note, inferenceEcho);

    return {
      customerId,
      contactId: rel.contactId,
      agent: 'collections-nudge',
      inferenceConfigured: configured,
      entitled: gate.allowed,
      tierUsed: inferenceEcho ? (inferenceEcho.metered ? 'metered' : 'bundled') : null,
      inference: inferenceEcho,
      draftOnly: true,
      note,
      subject,
      body,
      toAddress,
      overdueInvoices,
      totalOverdue,
      accountingConfigured,
    };
  }

  // ---- helpers ------------------------------------------------------------

  private async loadRelationship(tx: WorkspaceTxClient, customerId: string) {
    const row = await tx.customer.findUnique({ where: { id: customerId } });
    if (!row) throw new NotFoundException(`Customer ${customerId} not found`);
    return row;
  }

  /** Overdue == AO status sent|partial, a due date strictly before today, and a
   *  positive balance. void/paid/draft are never overdue. */
  private isOverdue(it: Record<string, any>, today: Date): boolean {
    const status = String(it.status ?? '').toLowerCase();
    if (status !== 'sent' && status !== 'partial') return false;
    const balance = Number(it.balanceDue ?? 0);
    if (!(balance > 0)) return false;
    if (!it.dueDate) return false;
    const due = new Date(it.dueDate);
    if (Number.isNaN(due.getTime())) return false;
    return due.getTime() < today.getTime();
  }

  private buildPrompt(
    contactName: string | null,
    invoices: OverdueInvoiceView[],
    totalOverdue: string | null,
  ) {
    const system =
      'You are an accounts-receivable assistant drafting a POLITE, professional ' +
      'payment reminder for overdue invoices. Be courteous and non-aggressive: ' +
      'assume good faith, make it easy to pay, offer to help with any issue. ' +
      'Reference the specific invoice number(s) and amount(s) and the total due. ' +
      'You are drafting ONLY — a human reviews and sends; you never charge or send. ' +
      'Respond with STRICT JSON only matching exactly: {"subject": "<short ' +
      'subject>", "body": "<plain-text reminder body, no signature block>"}.';
    const user =
      'Recipient: ' +
      (contactName ?? 'the customer') +
      '\nTotal overdue: ' +
      (totalOverdue ?? 'unknown') +
      '\nOverdue invoices:\n' +
      JSON.stringify(invoices, null, 2) +
      '\nReturn the JSON draft.';
    return [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ];
  }

  private async logRun(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    requestedWorkspaceId: string | null | undefined,
    note: string,
    echo: AgentInferenceEcho | null,
  ) {
    const lane = echo?.lane != null ? ` · lane ${echo.lane}` : '';
    await this.workspaces.runForUser(
      user,
      async (tx) => {
        const wsRows = await tx.$queryRaw<
          Array<{ ws: string | null }>
        >`SELECT current_workspace_id() AS ws`;
        const workspaceId = wsRows?.[0]?.ws;
        if (!workspaceId) return;
        await tx.customerActivity.create({
          data: {
            workspaceId,
            customerId,
            kind: CustomerActivityKind.AGENT_RUN,
            body: `collections-nudge agent ran — ${note}${lane}`,
            actorUcUid: ucUidOf(user) || null,
          },
        });
      },
      requestedWorkspaceId,
    );
  }
}
