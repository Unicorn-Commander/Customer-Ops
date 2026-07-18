import { NotFoundException } from '@nestjs/common';
import { CustomerActivityKind, User } from '@prisma/client';
import { CollectionsNudgeAgent } from './collections-nudge.agent';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { entitlementsOf } from '../common/workspace/workspace.util';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { AgentInferencePort } from './inference/agent-inference.port';
import { CustomersService } from '../customers/customers.service';

/**
 * CollectionsNudgeAgent (Phase 5) — DRAFT-ONLY. These tests pin:
 *   - it COMPOSES the federated invoice panel (Accounting-Ops, via the Phase-3
 *     CustomersService.invoicesForUser path) and SELECTS the overdue invoices
 *     (sent/partial, past due, balance > 0 — paid/void/future excluded),
 *   - it returns a STRUCTURED draft (subject + body + overdue snapshot + total),
 *   - it LOGS a CustomerActivity(AGENT_RUN),
 *   - it NEVER sends / charges / posts a ledger entry (no port writes; draftOnly),
 *   - it DEGRADES CLEAN when Accounting-Ops or inference is unconfigured.
 *
 * Today is mocked to 2026-06-10 so the "past due" boundary is deterministic.
 */
const WS = '0190a000-7e57-7000-8000-00000000c007';
const UC_UID = 'kc-aaron-sub';
const aaron = { id: 'a', email: 'aaron@magicunicorn.tech', keycloakId: UC_UID, __entitlements: ['customer-ops'] } as unknown as User;

function makeRow(over: Partial<Record<string, any>> = {}) {
  return { id: 'cust-1', workspaceId: WS, contactId: 'contact-42', stage: 'CUSTOMER', priority: 'MEDIUM', isLost: false, lastStageChangeAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ...over };
}
function makeTx(customerRow: any) {
  const activities: any[] = [];
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ ws: WS }]),
    customer: { findUnique: jest.fn().mockResolvedValue(customerRow) },
    customerActivity: { create: jest.fn(async ({ data }: any) => { const r = { id: `act-${activities.length + 1}`, createdAt: new Date(), ...data }; activities.push(r); return r; }) },
  };
  return { tx, activities };
}

// An invoice panel item shape (as CustomersService.serializeInvoiceLink emits).
function inv(over: Partial<Record<string, any>>) {
  return { externalRef: 'cust:cust-1:k', invoiceNumber: 'INV-1', status: 'sent', balanceDue: '500.0000', currency: 'USD', dueDate: '2026-06-01', ...over };
}

function makeAgent(opts?: {
  contact?: Partial<ContactOpsPort>;
  inference?: Partial<AgentInferencePort>;
  panel?: any; // the CustomersService.invoicesForUser return
}) {
  const contact: ContactOpsPort = {
    getContact: jest.fn().mockResolvedValue({ contactId: 'contact-42', displayName: 'Jane Lead', primaryEmail: 'ap@acme.test', currentOrgId: null, currentOrgName: 'Acme', lastInteractionAt: null, communicationStrength: null, tags: [], etag: null, vcardUid: null, kind: 'individual', status: 'active', emails: [], phones: [], recentEvents: [] }),
    getContactSummaries: jest.fn(), listContacts: jest.fn(), getWorkspaceProjection: jest.fn(),
    ...(opts?.contact ?? {}),
  } as any;

  const inference: AgentInferencePort = {
    isConfigured: jest.fn().mockReturnValue(true),
    checkEntitlement: jest.fn().mockReturnValue({ allowed: true, tierAllowed: 'bundled', mode: 'enforce', reason: 'ok' }),
    complete: jest.fn().mockResolvedValue({
      text: '{"subject":"A quick note about your invoice","body":"Hi Jane, hope you are well — just a friendly reminder about invoice INV-1..."}',
      lane: 2, model: 'qwen3-27b', metered: false, promptTokens: 150, completionTokens: 60,
    }),
    ...(opts?.inference ?? {}),
  } as any;

  const defaultPanel = {
    federated: true, source: 'accounting-ops', configured: true, entitled: true, canCreate: true,
    items: [
      inv({ externalRef: 'r-overdue', invoiceNumber: 'INV-OVERDUE', status: 'sent', balanceDue: '500.0000', dueDate: '2026-06-01' }), // OVERDUE
      inv({ externalRef: 'r-partial', invoiceNumber: 'INV-PARTIAL', status: 'partial', balanceDue: '120.0000', dueDate: '2026-05-15' }), // OVERDUE
      inv({ externalRef: 'r-paid', invoiceNumber: 'INV-PAID', status: 'paid', balanceDue: '0.0000', dueDate: '2026-05-01' }), // not overdue (paid)
      inv({ externalRef: 'r-future', invoiceNumber: 'INV-FUTURE', status: 'sent', balanceDue: '999.0000', dueDate: '2026-12-01' }), // not overdue (future)
      inv({ externalRef: 'r-zero', invoiceNumber: 'INV-ZERO', status: 'sent', balanceDue: '0.0000', dueDate: '2026-06-01' }), // not overdue (zero balance)
    ],
  };
  const customers = {
    invoicesForUser: jest.fn().mockResolvedValue(opts?.panel ?? defaultPanel),
  } as unknown as CustomersService;

  const lastTx = { current: null as any };
  const workspaces = {
    resolveAuthorized: jest.fn().mockResolvedValue(WS),
    assertAgentsNotPaused: jest.fn().mockResolvedValue(undefined),
    // Workspace has no server-side cache in these unit specs → the (user,workspace)
    // bind is the identity: effective == the token/PAT claim on the user.
    effectiveEntitlements: jest.fn(async (u: any) => entitlementsOf(u)),
    runForUser: jest.fn(async (_u: User, fn: any) => fn(lastTx.current)),
  } as unknown as WorkspaceContextService;

  const agent = new CollectionsNudgeAgent(workspaces, contact, inference, customers);
  return { agent, contact, inference, customers, lastTx };
}

describe('CollectionsNudgeAgent (Accounting-Ops panel + inference MOCKED)', () => {
  const realNow = Date.now;
  beforeAll(() => {
    // Pin "today" to 2026-06-10 so the past-due boundary is deterministic.
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-10T00:00:00Z').getTime());
  });
  afterAll(() => {
    (Date.now as any) = realNow;
  });

  it('selects ONLY overdue invoices, drafts a polite nudge, logs AGENT_RUN, never sends/charges', async () => {
    const { agent, customers, inference, lastTx } = makeAgent();
    const { tx, activities } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.draftNudge(aaron, 'cust-1', WS);

    // Read the federated invoice panel (Phase-3 AO poll path).
    expect(customers.invoicesForUser).toHaveBeenCalledWith(aaron, 'cust-1', WS);

    // ONLY the two genuinely-overdue invoices selected (paid/future/zero excluded).
    const refs = result.overdueInvoices.map((i) => i.externalRef).sort();
    expect(refs).toEqual(['r-overdue', 'r-partial']);
    // Summed overdue balance.
    expect(result.totalOverdue).toBe('620.00');

    // The prompt carried the overdue invoices + total.
    const [, req] = (inference.complete as jest.Mock).mock.calls[0];
    expect(req.task).toBe('collections-nudge');
    const promptText = req.messages.map((m: any) => m.content).join('\n');
    expect(promptText).toContain('INV-OVERDUE');
    expect(promptText).toContain('620.00');

    // Structured draft.
    expect(result).toMatchObject({
      agent: 'collections-nudge',
      subject: 'A quick note about your invoice',
      toAddress: 'ap@acme.test',
      accountingConfigured: true,
      draftOnly: true,
    });
    expect(result.body).toMatch(/friendly reminder/i);

    // Logged AGENT_RUN. No send/charge/ledger write anywhere (the agent has no
    // such ports; invoicesForUser is read-only).
    expect(activities[0]).toMatchObject({ kind: CustomerActivityKind.AGENT_RUN });
    expect(activities[0].body).toMatch(/collections-nudge/);
  });

  it('NO overdue invoices → no inference call, a clear note, still logs (draft-only)', async () => {
    const panel = { configured: true, entitled: true, items: [inv({ status: 'paid', balanceDue: '0.0000' })] };
    const { agent, inference, lastTx } = makeAgent({ panel });
    const { tx, activities } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.draftNudge(aaron, 'cust-1', WS);
    expect(result.overdueInvoices).toHaveLength(0);
    expect(inference.complete).not.toHaveBeenCalled();
    expect(result.subject).toBeNull();
    expect(result.note).toMatch(/no overdue/i);
    expect(activities[0].kind).toBe(CustomerActivityKind.AGENT_RUN);
  });

  it('DEGRADE-CLEAN: Accounting-Ops unconfigured → no invoices, no draft, explanatory note', async () => {
    const panel = { configured: false, entitled: false, items: [] };
    const { agent, inference, lastTx } = makeAgent({ panel });
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.draftNudge(aaron, 'cust-1', WS);
    expect(result.accountingConfigured).toBe(false);
    expect(result.overdueInvoices).toHaveLength(0);
    expect(inference.complete).not.toHaveBeenCalled();
    expect(result.note).toMatch(/not connected/i);
    expect(result.draftOnly).toBe(true);
  });

  it('DEGRADE-CLEAN: inference unconfigured but invoices overdue → overdue snapshot, null draft, no inference call', async () => {
    const inference = { isConfigured: jest.fn().mockReturnValue(false), checkEntitlement: jest.fn().mockReturnValue({ allowed: false, tierAllowed: 'bundled', mode: 'enforce', reason: 'x' }), complete: jest.fn().mockResolvedValue(null) };
    const { agent, lastTx } = makeAgent({ inference });
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.draftNudge(aaron, 'cust-1', WS);
    expect(result.overdueInvoices.length).toBeGreaterThan(0); // snapshot still assembled
    expect(inference.complete).not.toHaveBeenCalled();
    expect(result.subject).toBeNull();
    expect(result.note).toMatch(/inference is not configured/i);
  });

  it('404s when the relationship does not exist', async () => {
    const { agent, lastTx } = makeAgent();
    const { tx } = makeTx(null);
    tx.customer.findUnique.mockResolvedValue(null);
    lastTx.current = tx;
    await expect(agent.draftNudge(aaron, 'missing', WS)).rejects.toThrow(NotFoundException);
  });
});
