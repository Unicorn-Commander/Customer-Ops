import { User } from '@prisma/client';
import { CustomerOpsTools } from './mcp.tools';
import { CustomersService } from '../customers/customers.service';
import { LeadIntakeService } from '../lead-intake/lead-intake.service';
import { MembershipService } from '../common/workspace/membership.service';
import { LeadTriageAgent } from '../agents/lead-triage.agent';
import { FollowUpDrafterAgent } from '../agents/follow-up-drafter.agent';
import { CollectionsNudgeAgent } from '../agents/collections-nudge.agent';

/**
 * CustomerOpsTools is the MCP delegation layer: it remaps snake_case MCP tool
 * arguments to the camelCase DTOs the services expose, applies the
 * `workspace_id ?? null` addressing default, and forwards to the SAME
 * CustomersService / LeadIntakeService / agents the REST surface uses (one
 * implementation, one funnel rule set, one RLS path).
 *
 * These tests pin the mapping contract — a key-name slip here (e.g.
 * `unit_price` not landing on `unitPrice`) silently breaks every agent
 * integration while the REST surface stays green. Every service/agent is a bare
 * jest mock; we assert ONLY what the tool forwards (DTO shape + positional args),
 * never the downstream behavior (proven in the service specs).
 */
const WS = '0190a000-7e57-7000-8000-00000000c007';
const aaron = {
  id: 'local-aaron',
  email: 'aaron@magicunicorn.tech',
  keycloakId: 'kc-aaron',
} as User;

/** A sentinel each delegate returns, so we can assert the tool returns it verbatim. */
const SENTINEL = { ok: true, sentinel: 'passthrough' };

function makeTools() {
  // Every service/agent method is a mock resolving the sentinel; the tool layer
  // forwards args and returns the result unchanged.
  const customers = {
    listForUser: jest.fn().mockResolvedValue(SENTINEL),
    customer360ForUser: jest.fn().mockResolvedValue(SENTINEL),
    pipelineForUser: jest.fn().mockResolvedValue(SENTINEL),
    updateForUser: jest.fn().mockResolvedValue(SENTINEL),
    transitionForUser: jest.fn().mockResolvedValue(SENTINEL),
    addNoteForUser: jest.fn().mockResolvedValue(SENTINEL),
    invoicesForUser: jest.fn().mockResolvedValue(SENTINEL),
    createInvoiceForUser: jest.fn().mockResolvedValue(SENTINEL),
    outreachForUser: jest.fn().mockResolvedValue(SENTINEL),
    startCampaignForUser: jest.fn().mockResolvedValue(SENTINEL),
    emailForUser: jest.fn().mockResolvedValue(SENTINEL),
    sendEmailForUser: jest.fn().mockResolvedValue(SENTINEL),
    recordEngagementForUser: jest.fn().mockResolvedValue(SENTINEL),
    meetingsForUser: jest.fn().mockResolvedValue(SENTINEL),
  } as unknown as jest.Mocked<CustomersService>;

  const leads = {
    ingestForUser: jest.fn().mockResolvedValue(SENTINEL),
    statsForUser: jest.fn().mockResolvedValue(SENTINEL),
    listForUser: jest.fn().mockResolvedValue(SENTINEL),
    resolvePendingForUser: jest.fn().mockResolvedValue(SENTINEL),
    discardForUser: jest.fn().mockResolvedValue(SENTINEL),
  } as unknown as jest.Mocked<LeadIntakeService>;

  const membership = {} as unknown as MembershipService;
  const leadTriage = {
    triage: jest.fn().mockResolvedValue(SENTINEL),
  } as unknown as jest.Mocked<LeadTriageAgent>;
  const followUp = {
    draftFollowUp: jest.fn().mockResolvedValue(SENTINEL),
  } as unknown as jest.Mocked<FollowUpDrafterAgent>;
  const collections = {
    draftNudge: jest.fn().mockResolvedValue(SENTINEL),
  } as unknown as jest.Mocked<CollectionsNudgeAgent>;

  const tools = new CustomerOpsTools(
    membership,
    customers,
    leadTriage,
    followUp,
    collections,
    leads,
  );
  return { tools, customers, leads, leadTriage, followUp, collections };
}

describe('CustomerOpsTools — MCP arg → DTO delegation mapping', () => {
  describe('the workspace_id ?? null addressing default', () => {
    // Table-driven: every read/agent tool that takes a (customerId, workspace)
    // shape forwards `workspace_id ?? null` as the trailing addressing arg. When
    // workspace_id is omitted the tool must pass an EXPLICIT null (not undefined),
    // so the service's §D4 precedence resolves the caller's active workspace.
    const customerIdTools: Array<{
      name: string;
      method: keyof ReturnType<typeof makeTools>['customers'];
    }> = [
      { name: 'getCustomer360', method: 'customer360ForUser' },
      { name: 'listCustomerInvoices', method: 'invoicesForUser' },
      { name: 'listCustomerOutreach', method: 'outreachForUser' },
      { name: 'listCustomerEmail', method: 'emailForUser' },
      { name: 'listCustomerMeetings', method: 'meetingsForUser' },
    ];

    it.each(customerIdTools)(
      '$name forwards (user, customer_id, workspace_id) and defaults a MISSING workspace_id to null',
      async ({ name, method }) => {
        const { tools, customers } = makeTools();
        // workspace_id supplied → forwarded as-is.
        await (tools as any)[name](aaron, { customer_id: 'cust-1', workspace_id: WS });
        expect(customers[method]).toHaveBeenLastCalledWith(aaron, 'cust-1', WS);
        // workspace_id omitted → forwarded as an explicit null.
        await (tools as any)[name](aaron, { customer_id: 'cust-1' });
        expect(customers[method]).toHaveBeenLastCalledWith(aaron, 'cust-1', null);
      },
    );

    it.each([{ name: 'triageCustomer', agent: 'leadTriage', method: 'triage' }] as const)(
      '$name delegates to the $agent agent with (user, customer_id, workspace_id ?? null)',
      async ({ name, agent, method }) => {
        const ctx = makeTools();
        await (ctx.tools as any)[name](aaron, { customer_id: 'cust-1', workspace_id: WS });
        expect((ctx as any)[agent][method]).toHaveBeenLastCalledWith(aaron, 'cust-1', WS);
        await (ctx.tools as any)[name](aaron, { customer_id: 'cust-9' });
        expect((ctx as any)[agent][method]).toHaveBeenLastCalledWith(aaron, 'cust-9', null);
      },
    );

    // draftCollectionsNudge carries the staging contract (parity with
    // draft_followup), so it delegates with the tier + options tail rather than
    // the bare 3-arg shape the table above asserts.
    it('draftCollectionsNudge delegates with (user, customer_id, workspace_id ?? null, tier, opts)', async () => {
      const ctx = makeTools();

      await ctx.tools.draftCollectionsNudge(aaron, { customer_id: 'cust-1', workspace_id: WS });
      expect(ctx.collections.draftNudge).toHaveBeenLastCalledWith(aaron, 'cust-1', WS, 'bundled', {
        stageDraft: undefined,
        idempotencyKey: undefined,
      });

      await ctx.tools.draftCollectionsNudge(aaron, { customer_id: 'cust-9' });
      expect(ctx.collections.draftNudge).toHaveBeenLastCalledWith(
        aaron,
        'cust-9',
        null,
        'bundled',
        {
          stageDraft: undefined,
          idempotencyKey: undefined,
        },
      );
    });

    it('draftCollectionsNudge forwards stage_draft + idempotency_key to the agent', async () => {
      const ctx = makeTools();

      await ctx.tools.draftCollectionsNudge(aaron, {
        customer_id: 'cust-1',
        workspace_id: WS,
        stage_draft: true,
        idempotency_key: 'nudge-1',
      });

      expect(ctx.collections.draftNudge).toHaveBeenLastCalledWith(aaron, 'cust-1', WS, 'bundled', {
        stageDraft: true,
        idempotencyKey: 'nudge-1',
      });
    });

    it('every delegating tool returns the service/agent result verbatim', async () => {
      const { tools } = makeTools();
      await expect(tools.getCustomer360(aaron, { customer_id: 'c1' })).resolves.toBe(SENTINEL);
      await expect(tools.triageCustomer(aaron, { customer_id: 'c1' })).resolves.toBe(SENTINEL);
    });
  });

  describe('listCustomers — query remap + with_contacts default', () => {
    it('maps snake_case filters to the camelCase ListCustomersQueryDto', async () => {
      const { tools, customers } = makeTools();
      await tools.listCustomers(aaron, {
        workspace_id: WS,
        search: 'Contosochem',
        stage: 'PROSPECT' as any,
        owner_user_key: 'rep-7',
        include_lost: true,
        with_contacts: false,
        limit: 25,
      });
      expect(customers.listForUser).toHaveBeenCalledWith(
        aaron,
        {
          search: 'Contosochem',
          stage: 'PROSPECT',
          ownerUserKey: 'rep-7',
          includeLost: true,
          withContacts: false,
          limit: 25,
        },
        WS,
      );
    });

    it('defaults with_contacts to TRUE when omitted (federate contact labels by default)', async () => {
      const { tools, customers } = makeTools();
      await tools.listCustomers(aaron, {});
      const [, query, ws] = customers.listForUser.mock.calls[0];
      expect(query.withContacts).toBe(true);
      expect(ws).toBeNull(); // workspace addressing defaults to null
    });

    it('preserves an EXPLICIT with_contacts:false (the ?? default must not clobber it)', async () => {
      const { tools, customers } = makeTools();
      await tools.listCustomers(aaron, { with_contacts: false });
      expect(customers.listForUser.mock.calls[0][1].withContacts).toBe(false);
    });
  });

  describe('pipelineBoard — with_contacts default', () => {
    it('forwards (user, workspace_id ?? null, with_contacts) and defaults with_contacts to TRUE', async () => {
      const { tools, customers } = makeTools();
      await tools.pipelineBoard(aaron, {});
      expect(customers.pipelineForUser).toHaveBeenCalledWith(aaron, null, true);

      await tools.pipelineBoard(aaron, { workspace_id: WS, with_contacts: false });
      expect(customers.pipelineForUser).toHaveBeenLastCalledWith(aaron, WS, false);
    });
  });

  describe('transitionStage / addNote — small DTO remaps', () => {
    it('transitionStage maps to_stage→toStage + note into TransitionStageDto', async () => {
      const { tools, customers } = makeTools();
      await tools.transitionStage(aaron, {
        customer_id: 'cust-1',
        to_stage: 'CUSTOMER' as any,
        note: 'signed',
        workspace_id: WS,
      });
      expect(customers.transitionForUser).toHaveBeenCalledWith(
        aaron,
        'cust-1',
        { toStage: 'CUSTOMER', note: 'signed' },
        WS,
      );
    });

    it('addNote maps body into AddNoteDto and defaults the workspace to null', async () => {
      const { tools, customers } = makeTools();
      await tools.addNote(aaron, { customer_id: 'cust-1', body: 'called them' });
      expect(customers.addNoteForUser).toHaveBeenCalledWith(
        aaron,
        'cust-1',
        { body: 'called them' },
        null,
      );
    });
  });

  describe('updateCustomer — REST PATCH DTO remap', () => {
    it('maps the complete relationship PATCH payload and workspace address', async () => {
      const { tools, customers } = makeTools();
      await tools.updateCustomer(aaron, {
        customer_id: 'cust-1',
        workspace_id: WS,
        priority: 'HIGH' as any,
        source: 'northwind',
        notes: 'follow up tomorrow',
        owner_user_key: 'rep-7',
        expected_value: '1250.50',
        currency: 'USD',
        next_action_at: '2026-10-20T15:30:00.000Z',
      });

      expect(customers.updateForUser).toHaveBeenCalledWith(
        aaron,
        'cust-1',
        {
          priority: 'HIGH',
          source: 'northwind',
          notes: 'follow up tomorrow',
          ownerUserKey: 'rep-7',
          expectedValue: '1250.50',
          currency: 'USD',
          nextActionAt: '2026-10-20T15:30:00.000Z',
        },
        WS,
      );
    });
  });

  describe('createCustomerInvoice — the line-item money remap', () => {
    // A key-name slip on the money fields here silently corrupts every agent
    // invoice. Pin the FULL snake→camel remap of the DTO + each line item.
    const args = {
      customer_id: 'cust-1',
      workspace_id: WS,
      entity_id: 'entity-9',
      customer_name: 'Acme Co',
      customer_email: 'ap@acme.test',
      billing_address: '1 Market St',
      line_items: [
        {
          description: 'Consulting',
          quantity: '10',
          unit_price: '150.0000',
          amount: '1500.0000',
          tax_code: 'CA',
          tax_amount: '120.0000',
          revenue_account_id: 'rev-acct-1',
          source_ref: 'so-42',
        },
      ],
      currency: 'USD',
      issue_date: '2026-06-03',
      due_date: '2026-07-01',
      net_terms: 30,
      discount: '50.0000',
      notes: 'thanks',
      po_number: 'PO-7',
      auto_send: true,
      idempotency_key: 'fixed-key',
    };

    it('remaps the top-level invoice fields to CreateInvoiceDto', async () => {
      const { tools, customers } = makeTools();
      await tools.createCustomerInvoice(aaron, args);

      const [user, customerId, dto, ws] = customers.createInvoiceForUser.mock.calls[0];
      expect(user).toBe(aaron);
      expect(customerId).toBe('cust-1');
      expect(ws).toBe(WS);
      expect(dto).toMatchObject({
        entityId: 'entity-9',
        customerName: 'Acme Co',
        customerEmail: 'ap@acme.test',
        billingAddress: '1 Market St',
        currency: 'USD',
        issueDate: '2026-06-03',
        dueDate: '2026-07-01',
        netTerms: 30,
        discount: '50.0000',
        notes: 'thanks',
        poNumber: 'PO-7',
        autoSend: true,
        idempotencyKey: 'fixed-key',
      });
    });

    it('remaps EACH line item (unit_price→unitPrice, tax_code→taxCode, revenue_account_id→revenueAccountId, …)', async () => {
      const { tools, customers } = makeTools();
      await tools.createCustomerInvoice(aaron, args);

      const dto = customers.createInvoiceForUser.mock.calls[0][2];
      expect(dto.lineItems).toHaveLength(1);
      expect(dto.lineItems[0]).toEqual({
        description: 'Consulting',
        quantity: '10',
        unitPrice: '150.0000',
        amount: '1500.0000',
        taxCode: 'CA',
        taxAmount: '120.0000',
        revenueAccountId: 'rev-acct-1',
        sourceRef: 'so-42',
      });
      // The money strings travel verbatim (no float coercion at the seam).
      expect(typeof dto.lineItems[0].unitPrice).toBe('string');
    });

    it('tolerates an omitted line_items array (maps to []), defaulting workspace to null', async () => {
      const { tools, customers } = makeTools();
      await tools.createCustomerInvoice(aaron, {
        customer_id: 'cust-1',
        entity_id: 'e1',
        customer_name: 'Acme',
        line_items: undefined as any,
      });
      const [, , dto, ws] = customers.createInvoiceForUser.mock.calls[0];
      expect(dto.lineItems).toEqual([]);
      expect(ws).toBeNull();
    });
  });

  describe('startCustomerCampaign — DTO remap', () => {
    it('maps campaign_id/contact_email/merge_fields/idempotency_key into StartCampaignDto', async () => {
      const { tools, customers } = makeTools();
      await tools.startCustomerCampaign(aaron, {
        customer_id: 'cust-1',
        workspace_id: WS,
        campaign_id: 'camp-1',
        contact_email: 'jane@acme.test',
        merge_fields: { firstName: 'Jane' },
        idempotency_key: 'k1',
      });
      expect(customers.startCampaignForUser).toHaveBeenCalledWith(
        aaron,
        'cust-1',
        {
          campaignId: 'camp-1',
          contactEmail: 'jane@acme.test',
          mergeFields: { firstName: 'Jane' },
          idempotencyKey: 'k1',
        },
        WS,
      );
    });
  });

  describe('sendCustomerEmail — DTO remap + mode passthrough', () => {
    it('maps to_address→toAddress, in_reply_to_thread_id→inReplyToThreadId, mode, idempotency_key', async () => {
      const { tools, customers } = makeTools();
      await tools.sendCustomerEmail(aaron, {
        customer_id: 'cust-1',
        workspace_id: WS,
        to_address: 'jane@acme.test',
        subject: 'Following up',
        body: 'Hi Jane',
        in_reply_to_thread_id: 'thread-7',
        mode: 'draft',
        idempotency_key: 'k2',
      });
      expect(customers.sendEmailForUser).toHaveBeenCalledWith(
        aaron,
        'cust-1',
        {
          toAddress: 'jane@acme.test',
          subject: 'Following up',
          body: 'Hi Jane',
          inReplyToThreadId: 'thread-7',
          mode: 'draft',
          idempotencyKey: 'k2',
        },
        WS,
      );
    });

    it('forwards mode unset (undefined) — the service applies its own send default', async () => {
      const { tools, customers } = makeTools();
      await tools.sendCustomerEmail(aaron, { customer_id: 'cust-1', subject: 's', body: 'b' });
      const [, , dto, ws] = customers.sendEmailForUser.mock.calls[0];
      expect(dto.mode).toBeUndefined();
      expect(dto.toAddress).toBeUndefined();
      expect(ws).toBeNull();
    });
  });

  describe('recordCustomerEngagement — DTO remap', () => {
    it('maps kind/source/external_ref/detail into RecordEngagementDto', async () => {
      const { tools, customers } = makeTools();
      await tools.recordCustomerEngagement(aaron, {
        customer_id: 'cust-1',
        workspace_id: WS,
        kind: 'replied',
        source: 'email-ops',
        external_ref: 'msg-7',
        detail: 'replied to the proposal',
      });
      expect(customers.recordEngagementForUser).toHaveBeenCalledWith(
        aaron,
        'cust-1',
        {
          kind: 'replied',
          source: 'email-ops',
          externalRef: 'msg-7',
          detail: 'replied to the proposal',
        },
        WS,
      );
    });

    it('defaults the workspace to null when omitted', async () => {
      const { tools, customers } = makeTools();
      await tools.recordCustomerEngagement(aaron, { customer_id: 'cust-1', kind: 'opened' });
      expect(customers.recordEngagementForUser.mock.calls[0][3]).toBeNull();
    });
  });

  describe('ingestLead — the keystone DTO remap', () => {
    it('maps the full snake_case lead payload into IngestLeadDto', async () => {
      const { tools, leads } = makeTools();
      await tools.ingestLead(aaron, {
        workspace_id: WS,
        source: 'northwind',
        source_dedup_key: 'L-1',
        contact_id: 'co-7',
        display_name: 'Jane Lead',
        email: 'jane@acme.test',
        phone: '+15551234',
        org_name: 'Acme',
        tags: ['vip', 'inbound'],
        score: 88,
        expected_value: '5000',
        currency: 'USD',
        priority: 'HIGH' as any,
        owner_user_key: 'rep-7',
        notes: 'hot lead',
        raw_payload: { utm: 'spring' },
      });
      expect(leads.ingestForUser).toHaveBeenCalledWith(
        aaron,
        {
          source: 'northwind',
          sourceDedupKey: 'L-1',
          contactId: 'co-7',
          displayName: 'Jane Lead',
          email: 'jane@acme.test',
          phone: '+15551234',
          orgName: 'Acme',
          tags: ['vip', 'inbound'],
          score: 88,
          expectedValue: '5000',
          currency: 'USD',
          priority: 'HIGH',
          ownerUserKey: 'rep-7',
          notes: 'hot lead',
          rawPayload: { utm: 'spring' },
        },
        WS,
      );
    });

    it('defaults the workspace to null when omitted', async () => {
      const { tools, leads } = makeTools();
      await tools.ingestLead(aaron, { source: 'manual', source_dedup_key: 'M-1', email: 'x@y.z' });
      expect(leads.ingestForUser.mock.calls[0][2]).toBeNull();
    });
  });

  describe('the remaining lead-intake observability tools', () => {
    it('leadIntakeStats forwards just (user, workspace_id ?? null)', async () => {
      const { tools, leads } = makeTools();
      await tools.leadIntakeStats(aaron, { workspace_id: WS });
      expect(leads.statsForUser).toHaveBeenCalledWith(aaron, WS);
      await tools.leadIntakeStats(aaron, {});
      expect(leads.statsForUser).toHaveBeenLastCalledWith(aaron, null);
    });

    it('listLeadIntakes maps status/source/limit into ListIntakesQueryDto', async () => {
      const { tools, leads } = makeTools();
      await tools.listLeadIntakes(aaron, { status: 'PENDING' as any, source: 'northwind', limit: 10 });
      expect(leads.listForUser).toHaveBeenCalledWith(
        aaron,
        { status: 'PENDING', source: 'northwind', limit: 10 },
        null,
      );
    });

    it('resolvePendingLeads maps limit/scope into ResolvePendingDto', async () => {
      const { tools, leads } = makeTools();
      await tools.resolvePendingLeads(aaron, {
        workspace_id: WS,
        limit: 25,
        scope: 'pending_and_failed',
      });
      expect(leads.resolvePendingForUser).toHaveBeenCalledWith(
        aaron,
        { limit: 25, scope: 'pending_and_failed' },
        WS,
      );
    });

    it('discardLeadIntake forwards (user, intake_id, {reason}, workspace_id ?? null)', async () => {
      const { tools, leads } = makeTools();
      await tools.discardLeadIntake(aaron, { intake_id: 'li-1', reason: 'spam' });
      expect(leads.discardForUser).toHaveBeenCalledWith(aaron, 'li-1', { reason: 'spam' }, null);
    });
  });

  describe('draftFollowup — agent option remap', () => {
    it('maps goal/stage_draft→stageDraft/idempotency_key into the FollowUpOptions', async () => {
      const { tools, followUp } = makeTools();
      await tools.draftFollowup(aaron, {
        customer_id: 'cust-1',
        workspace_id: WS,
        goal: 'book a demo',
        stage_draft: true,
        idempotency_key: 'k3',
      });
      expect(followUp.draftFollowUp).toHaveBeenCalledWith(
        aaron,
        'cust-1',
        { goal: 'book a demo', stageDraft: true, idempotencyKey: 'k3' },
        WS,
      );
    });
  });
});
