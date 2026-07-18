import { NotFoundException } from '@nestjs/common';
import { CustomerActivityKind, User } from '@prisma/client';
import { MeetingPrepAgent } from './meeting-prep.agent';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { MeetingOpsPort } from '../meeting-ops/meeting-ops.port';
import { OutreachPort } from '../outreach-ops/outreach-ops.port';
import { AgentInferencePort } from './inference/agent-inference.port';
import { CustomersService } from '../customers/customers.service';

/**
 * MeetingPrepAgent (Phase 5+) — DRAFT-ONLY relationship agent. Mirrors the
 * lead-triage / collections-nudge specs with every port (incl. the 4-lane
 * inference + the AO invoice panel) MOCKED:
 *   - it COMPOSES the right context (local relationship + FEDERATED Meeting-Ops
 *     signal + open action items + Outreach last touch + the AO invoice panel),
 *   - it returns STRUCTURED output (talkingPoints / openItems / suggestedAgenda /
 *     summary),
 *   - it LOGS a CustomerActivity(AGENT_RUN),
 *   - it takes NO side effect (draftOnly:true; no booking, no send),
 *   - it DEGRADES CLEAN when inference is unconfigured / not entitled (returns the
 *     signal snapshot, empty arrays, no throw) and never makes the inference call,
 *   - the SELECTABLE tier flows through to checkEntitlement + complete.
 */
const WS = '0190a000-7e57-7000-8000-00000000c007';
const UC_UID = 'kc-aaron-sub';
const aaron = {
  id: 'local-aaron',
  email: 'aaron@magicunicorn.tech',
  keycloakId: UC_UID,
  __entitlements: ['customer-ops'],
} as unknown as User;

function makeRow(over: Partial<Record<string, any>> = {}) {
  return {
    id: 'cust-1',
    workspaceId: WS,
    contactId: 'contact-42',
    stage: 'CUSTOMER',
    priority: 'HIGH',
    isLost: false,
    notes: 'Champion is the VP of Eng; cares about SOC2.',
    lastStageChangeAt: new Date('2026-05-20T00:00:00Z'),
    createdAt: new Date('2026-05-20T00:00:00Z'),
    updatedAt: new Date('2026-05-20T00:00:00Z'),
    ...over,
  };
}

function makeTx(customerRow: any) {
  const activities: any[] = [];
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ ws: WS }]),
    customer: { findUnique: jest.fn().mockResolvedValue(customerRow) },
    customerActivity: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `act-${activities.length + 1}`, createdAt: new Date(), ...data };
        activities.push(row);
        return row;
      }),
    },
  };
  return { tx, activities };
}

// An action item shape (as MeetingOps.listActionItemsForContact emits).
function ai(over: Partial<Record<string, any>>) {
  return {
    id: 'ai-1', meetingId: 'm-1', text: 'Send SOC2 report', status: 'open',
    assigneeContactId: null, assigneeLabel: 'Rep', dueAt: null, projectOpsTaskId: null,
    createdAt: '2026-06-01T15:30:00Z', ...over,
  };
}

// An invoice panel item shape (as CustomersService.serializeInvoiceLink emits).
function inv(over: Partial<Record<string, any>>) {
  return { externalRef: 'cust:cust-1:k', invoiceNumber: 'INV-1', status: 'sent', balanceDue: '500.0000', currency: 'USD', dueDate: '2026-07-01', ...over };
}

function makeAgent(opts?: {
  contact?: Partial<ContactOpsPort>;
  meeting?: Partial<MeetingOpsPort>;
  outreach?: Partial<OutreachPort>;
  inference?: Partial<AgentInferencePort>;
  panel?: any; // the CustomersService.invoicesForUser return
}) {
  const contact: ContactOpsPort = {
    getContact: jest.fn().mockResolvedValue({
      contactId: 'contact-42', displayName: 'Jane Lead', primaryEmail: 'jane@x.com',
      currentOrgId: null, currentOrgName: 'Acme', lastInteractionAt: '2026-06-01T00:00:00Z',
      communicationStrength: 0.8, tags: [], etag: null, vcardUid: null, kind: 'individual',
      status: 'active', emails: [], phones: [], recentEvents: [],
    }),
    getContactSummaries: jest.fn().mockResolvedValue(new Map()),
    listContacts: jest.fn().mockResolvedValue({ items: [], count: 0, nextCursor: null }),
    getWorkspaceProjection: jest.fn().mockResolvedValue(null),
    ...(opts?.contact ?? {}),
  } as any;

  const meeting: MeetingOpsPort = {
    isConfigured: jest.fn().mockReturnValue(true),
    listMeetingsForContact: jest.fn().mockResolvedValue({ items: [], count: 0, nextCursor: null }),
    listSummariesForContact: jest.fn().mockResolvedValue([]),
    listActionItemsForContact: jest.fn().mockResolvedValue([
      ai({ id: 'ai-1', text: 'Send SOC2 report', status: 'open' }),
      ai({ id: 'ai-2', text: 'Schedule security review', status: 'in_progress' }),
      ai({ id: 'ai-3', text: 'Closed already', status: 'done' }), // excluded (done)
    ]),
    getMeetingSignal: jest.fn().mockResolvedValue({
      meetingCount: 4, lastMeetingAt: '2026-06-01T15:00:00Z', lastMeetingTitle: 'Security deep-dive',
      openActionItemCount: 2, latestSummaryHeadline: 'Pushing on SOC2 + pricing',
    }),
    ...(opts?.meeting ?? {}),
  } as any;

  const outreach: OutreachPort = {
    isConfigured: jest.fn().mockReturnValue(true),
    checkEntitlement: jest.fn().mockReturnValue({ allowed: true, mode: 'enforce', reason: 'ok' }),
    listCampaigns: jest.fn().mockResolvedValue([]),
    listTouchesForContact: jest.fn().mockResolvedValue([
      { id: 't1', channel: 'email', campaignId: 'c1', campaignName: 'Nurture', status: 'opened',
        subject: 'Following up on SOC2', scheduledAt: null, sentAt: '2026-06-02T10:00:00Z',
        lastEngagementKind: 'opened', lastEngagementAt: '2026-06-02T11:00:00Z' },
    ]),
    enrollContact: jest.fn().mockResolvedValue(null),
    scheduleSocialTouch: jest.fn().mockResolvedValue(null),
    ...(opts?.outreach ?? {}),
  } as any;

  // Default inference: configured + entitled, returns a parseable prep brief.
  const inference: AgentInferencePort = {
    isConfigured: jest.fn().mockReturnValue(true),
    checkEntitlement: jest.fn().mockReturnValue({ allowed: true, tierAllowed: 'bundled', mode: 'enforce', reason: 'ok' }),
    complete: jest.fn().mockResolvedValue({
      text: '{"talkingPoints":["Recap the security deep-dive","Confirm SOC2 timeline"],"openItems":["Send SOC2 report","Outstanding invoice INV-1"],"suggestedAgenda":["Intros","Security review","Next steps"],"summary":"Customer is pushing on SOC2 and pricing after 4 meetings. Close the open action items and confirm timeline."}',
      lane: 2, model: 'qwen3-27b', metered: false, promptTokens: 200, completionTokens: 90,
    }),
    ...(opts?.inference ?? {}),
  } as any;

  const defaultPanel = {
    federated: true, source: 'accounting-ops', configured: true, entitled: true, canCreate: true,
    items: [
      inv({ externalRef: 'r-open', invoiceNumber: 'INV-1', status: 'sent', balanceDue: '500.0000' }), // open
      inv({ externalRef: 'r-paid', invoiceNumber: 'INV-PAID', status: 'paid', balanceDue: '0.0000' }), // excluded (paid)
    ],
  };
  const customers = {
    invoicesForUser: jest.fn().mockResolvedValue(opts?.panel ?? defaultPanel),
  } as unknown as CustomersService;

  const lastTx = { current: null as any };
  const workspaces = {
    resolveAuthorized: jest.fn().mockResolvedValue(WS),
    assertAgentsNotPaused: jest.fn().mockResolvedValue(undefined),
    runForUser: jest.fn(async (_u: User, fn: any) => fn(lastTx.current)),
  } as unknown as WorkspaceContextService;

  const agent = new MeetingPrepAgent(workspaces, contact, meeting, outreach, inference, customers);
  return { agent, contact, meeting, outreach, inference, customers, lastTx };
}

describe('MeetingPrepAgent (all ports + AO panel + inference MOCKED)', () => {
  it('composes federated signal, returns a structured prep brief, logs AGENT_RUN, takes NO action', async () => {
    const { agent, meeting, outreach, customers, inference, lastTx } = makeAgent();
    const { tx, activities } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.prep(aaron, 'cust-1', WS);

    // Composed the right context from the federated ports + the AO panel.
    expect(meeting.getMeetingSignal).toHaveBeenCalledWith({ workspaceId: WS, ucUid: UC_UID }, 'contact-42');
    expect(meeting.listActionItemsForContact).toHaveBeenCalledWith({ workspaceId: WS, ucUid: UC_UID }, 'contact-42', { limit: 25 });
    expect(outreach.listTouchesForContact).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS }), 'contact-42');
    expect(customers.invoicesForUser).toHaveBeenCalledWith(aaron, 'cust-1', WS);

    // The assembled signal carried the federated facts into the prompt.
    expect(inference.complete).toHaveBeenCalledTimes(1);
    const [, req] = (inference.complete as jest.Mock).mock.calls[0];
    expect(req.task).toBe('meeting-prep');
    expect(req.tier).toBe('bundled'); // default tier
    expect(req.responseFormat).toBe('json');
    const promptText = req.messages.map((m: any) => m.content).join('\n');
    expect(promptText).toContain('Pushing on SOC2'); // meeting summary headline
    expect(promptText).toContain('Send SOC2 report'); // open action item
    expect(promptText).toContain('"meetingCount": 4');

    // ONLY the two OPEN/in_progress action items folded in (done excluded).
    expect(result.signals.openActionItems).toEqual(['Send SOC2 report', 'Schedule security review']);
    // ONLY the open invoice folded in (paid excluded), with a summed balance.
    expect(result.signals.openInvoiceCount).toBe(1);
    expect(result.signals.totalOpenBalance).toBe('500.00');
    expect(result.signals).toMatchObject({ lastOutreachSubject: 'Following up on SOC2', lastEngagementKind: 'opened', relationshipNotes: 'Champion is the VP of Eng; cares about SOC2.' });

    // Structured output.
    expect(result).toMatchObject({
      agent: 'meeting-prep',
      draftOnly: true,
      inferenceConfigured: true,
      entitled: true,
      tierUsed: 'bundled',
    });
    expect(result.talkingPoints).toEqual(['Recap the security deep-dive', 'Confirm SOC2 timeline']);
    expect(result.openItems).toEqual(['Send SOC2 report', 'Outstanding invoice INV-1']);
    expect(result.suggestedAgenda).toEqual(['Intros', 'Security review', 'Next steps']);
    expect(result.summary).toMatch(/SOC2/i);

    // Logged exactly one AGENT_RUN activity, no PII.
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ kind: CustomerActivityKind.AGENT_RUN, workspaceId: WS, actorUcUid: UC_UID });
    expect(activities[0].body).toMatch(/meeting-prep/);

    // NO side effect.
    expect((tx.customer as any).update).toBeUndefined();
  });

  it('passes the SELECTABLE tier through to checkEntitlement + complete', async () => {
    const { agent, inference, lastTx } = makeAgent();
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    await agent.prep(aaron, 'cust-1', WS, 'metered');

    expect(inference.checkEntitlement).toHaveBeenCalledWith(expect.anything(), 'metered');
    const [, req] = (inference.complete as jest.Mock).mock.calls[0];
    expect(req.tier).toBe('metered');
  });

  it('DEGRADE-CLEAN: inference unconfigured → signal snapshot only, empty arrays, NO inference call, still logs', async () => {
    const inference = {
      isConfigured: jest.fn().mockReturnValue(false),
      checkEntitlement: jest.fn().mockReturnValue({ allowed: false, tierAllowed: 'bundled', mode: 'enforce', reason: 'x' }),
      complete: jest.fn().mockResolvedValue(null),
    };
    const { agent, lastTx } = makeAgent({ inference });
    const { tx, activities } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.prep(aaron, 'cust-1', WS);

    expect(inference.complete).not.toHaveBeenCalled();
    expect(result.inferenceConfigured).toBe(false);
    expect(result.talkingPoints).toEqual([]);
    expect(result.openItems).toEqual([]);
    expect(result.suggestedAgenda).toEqual([]);
    expect(result.summary).toBeNull();
    expect(result.draftOnly).toBe(true);
    // The federated signal snapshot is still returned (cockpit shows context).
    expect(result.signals.meetingCount).toBe(4);
    expect(result.signals.openActionItems).toEqual(['Send SOC2 report', 'Schedule security review']);
    expect(result.note).toMatch(/not configured/i);
    expect(activities[0].kind).toBe(CustomerActivityKind.AGENT_RUN);
  });

  it('NOT ENTITLED: gate denies → no inference call, empty brief, draftOnly still true', async () => {
    const inference = {
      isConfigured: jest.fn().mockReturnValue(true),
      checkEntitlement: jest.fn().mockReturnValue({ allowed: false, tierAllowed: 'bundled', mode: 'enforce', reason: 'not entitled: needs customer-ops' }),
      complete: jest.fn().mockResolvedValue(null),
    };
    const { agent, lastTx } = makeAgent({ inference });
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.prep(aaron, 'cust-1', WS);
    expect(inference.complete).not.toHaveBeenCalled();
    expect(result.entitled).toBe(false);
    expect(result.summary).toBeNull();
    expect(result.note).toMatch(/not entitled/i);
  });

  it('tolerates an unparseable model response (empty brief + a note, never throws)', async () => {
    const inference = {
      isConfigured: jest.fn().mockReturnValue(true),
      checkEntitlement: jest.fn().mockReturnValue({ allowed: true, tierAllowed: 'bundled', mode: 'enforce', reason: 'ok' }),
      complete: jest.fn().mockResolvedValue({ text: 'sorry I cannot do that', lane: 2, model: 'm', metered: false, promptTokens: null, completionTokens: null }),
    };
    const { agent, lastTx } = makeAgent({ inference });
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.prep(aaron, 'cust-1', WS);
    expect(result.talkingPoints).toEqual([]);
    expect(result.summary).toBeNull();
    expect(result.note).toMatch(/unparseable/i);
    // But the inference provenance is still echoed (it DID run).
    expect(result.inference).toMatchObject({ lane: 2, model: 'm' });
  });

  it('degrades when Meeting-Ops + Accounting-Ops are dormant (zeros/empties in the signal, still runs)', async () => {
    const { agent, meeting, lastTx } = makeAgent({
      meeting: {
        isConfigured: jest.fn().mockReturnValue(false),
        getMeetingSignal: jest.fn().mockResolvedValue({ meetingCount: 0, lastMeetingAt: null, lastMeetingTitle: null, openActionItemCount: 0, latestSummaryHeadline: null }),
        listMeetingsForContact: jest.fn().mockResolvedValue({ items: [], count: 0, nextCursor: null }),
        listSummariesForContact: jest.fn().mockResolvedValue([]),
        listActionItemsForContact: jest.fn().mockResolvedValue([]),
      },
      panel: { federated: false, source: 'accounting-ops', configured: false, entitled: false, canCreate: false, items: [] },
    });
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.prep(aaron, 'cust-1', WS);
    expect(result.signals).toMatchObject({ meetingCount: 0, openActionItems: [], openInvoiceCount: 0, totalOpenBalance: null });
    // Inference still ran on the (thin) local signal — the agent never blocks.
    expect(result.summary).toMatch(/SOC2/i);
    // Meeting-Ops dormant → its action-item read is skipped entirely (no call).
    expect(meeting.listActionItemsForContact).not.toHaveBeenCalled();
  });

  it('404s when the relationship does not exist in the workspace', async () => {
    const { agent, lastTx } = makeAgent();
    const { tx } = makeTx(null);
    tx.customer.findUnique.mockResolvedValue(null);
    lastTx.current = tx;
    await expect(agent.prep(aaron, 'missing', WS)).rejects.toThrow(NotFoundException);
  });
});
