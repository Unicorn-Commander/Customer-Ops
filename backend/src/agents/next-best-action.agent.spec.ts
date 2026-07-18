import { NotFoundException } from '@nestjs/common';
import { CustomerActivityKind, User } from '@prisma/client';
import { NextBestActionAgent } from './next-best-action.agent';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { MeetingOpsPort } from '../meeting-ops/meeting-ops.port';
import { OutreachPort } from '../outreach-ops/outreach-ops.port';
import { AgentInferencePort } from './inference/agent-inference.port';

/**
 * NextBestActionAgent (Phase 5+) — DRAFT-ONLY relationship agent. Mirrors the
 * lead-triage spec: every port (incl. the 4-lane inference) is MOCKED and the
 * brief's guarantees are pinned:
 *   - it COMPOSES the right context (local relationship + FEDERATED Contact-Ops +
 *     Meeting-Ops signal + Outreach touches) and passes it to inference,
 *   - it returns STRUCTURED output (nextAction / rationale / priority / confidence),
 *   - it LOGS a CustomerActivity(AGENT_RUN),
 *   - it takes NO side effect (draftOnly:true; no stage move, no send),
 *   - it DEGRADES CLEAN when inference is unconfigured / not entitled (returns the
 *     signal snapshot, null action, no throw) and never makes the inference call,
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
    stage: 'PROSPECT',
    priority: 'MEDIUM',
    isLost: false,
    expectedValue: { toString: () => '5000' },
    nextActionAt: null,
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

function makeAgent(opts?: {
  contact?: Partial<ContactOpsPort>;
  meeting?: Partial<MeetingOpsPort>;
  outreach?: Partial<OutreachPort>;
  inference?: Partial<AgentInferencePort>;
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
    listActionItemsForContact: jest.fn().mockResolvedValue([]),
    getMeetingSignal: jest.fn().mockResolvedValue({
      meetingCount: 3, lastMeetingAt: '2026-06-01T15:00:00Z', lastMeetingTitle: 'Discovery call',
      openActionItemCount: 2, latestSummaryHeadline: 'Wants enterprise',
    }),
    ...(opts?.meeting ?? {}),
  } as any;

  const outreach: OutreachPort = {
    isConfigured: jest.fn().mockReturnValue(true),
    checkEntitlement: jest.fn().mockReturnValue({ allowed: true, mode: 'enforce', reason: 'ok' }),
    listCampaigns: jest.fn().mockResolvedValue([]),
    listTouchesForContact: jest.fn().mockResolvedValue([
      { id: 't1', channel: 'email', campaignId: 'c1', campaignName: 'Nurture', status: 'clicked',
        subject: 'Hi', scheduledAt: null, sentAt: '2026-06-02T10:00:00Z',
        lastEngagementKind: 'clicked', lastEngagementAt: '2026-06-02T11:00:00Z' },
    ]),
    enrollContact: jest.fn().mockResolvedValue(null),
    scheduleSocialTouch: jest.fn().mockResolvedValue(null),
    ...(opts?.outreach ?? {}),
  } as any;

  // Default inference: configured + entitled, returns a parseable recommendation.
  const inference: AgentInferencePort = {
    isConfigured: jest.fn().mockReturnValue(true),
    checkEntitlement: jest.fn().mockReturnValue({ allowed: true, tierAllowed: 'bundled', mode: 'enforce', reason: 'ok' }),
    complete: jest.fn().mockResolvedValue({
      text: '{"nextAction":"Send the enterprise quote.","rationale":"Recent click + 3 meetings and an open action item show strong intent.","priority":"high","confidence":0.82}',
      lane: 2, model: 'qwen3-27b', metered: false, promptTokens: 100, completionTokens: 30,
    }),
    ...(opts?.inference ?? {}),
  } as any;

  const lastTx = { current: null as any };
  const workspaces = {
    resolveAuthorized: jest.fn().mockResolvedValue(WS),
    assertAgentsNotPaused: jest.fn().mockResolvedValue(undefined),
    runForUser: jest.fn(async (_u: User, fn: any) => fn(lastTx.current)),
  } as unknown as WorkspaceContextService;

  const agent = new NextBestActionAgent(workspaces, contact, meeting, outreach, inference);
  return { agent, contact, meeting, outreach, inference, workspaces, lastTx };
}

describe('NextBestActionAgent (all ports + inference MOCKED)', () => {
  it('composes federated signal, returns a structured recommendation, logs AGENT_RUN, takes NO action', async () => {
    const { agent, contact, meeting, outreach, inference, lastTx } = makeAgent();
    const { tx, activities } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.recommend(aaron, 'cust-1', WS);

    // Composed the right context from EACH federated port.
    expect(contact.getContact).toHaveBeenCalledWith({ workspaceId: WS, ucUid: UC_UID }, 'contact-42');
    expect(meeting.getMeetingSignal).toHaveBeenCalledWith({ workspaceId: WS, ucUid: UC_UID }, 'contact-42');
    expect(outreach.listTouchesForContact).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS }),
      'contact-42',
    );
    // The assembled signal carried the federated facts into the prompt.
    expect(inference.complete).toHaveBeenCalledTimes(1);
    const [, req] = (inference.complete as jest.Mock).mock.calls[0];
    expect(req.task).toBe('next-best-action');
    expect(req.tier).toBe('bundled'); // default tier
    expect(req.responseFormat).toBe('json');
    const promptText = req.messages.map((m: any) => m.content).join('\n');
    expect(promptText).toContain('Wants enterprise'); // meeting summary signal
    expect(promptText).toContain('clicked'); // outreach engagement
    expect(promptText).toContain('"meetingCount": 3');

    // Structured output.
    expect(result).toMatchObject({
      agent: 'next-best-action',
      nextAction: 'Send the enterprise quote.',
      priority: 'high',
      confidence: 0.82,
      draftOnly: true,
      inferenceConfigured: true,
      entitled: true,
      tierUsed: 'bundled',
    });
    expect(result.rationale).toMatch(/intent/i);
    expect(result.signals).toMatchObject({ meetingCount: 3, lastEngagementKind: 'clicked', communicationStrength: 0.8 });

    // Logged exactly one AGENT_RUN activity (the audit trail), no PII.
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ kind: CustomerActivityKind.AGENT_RUN, workspaceId: WS, actorUcUid: UC_UID });
    expect(activities[0].body).toMatch(/next-best-action/);

    // NO side effect: never wrote the customer.
    expect(tx.customer.findUnique).toHaveBeenCalled();
    expect((tx.customer as any).update).toBeUndefined();
  });

  it('passes the SELECTABLE tier through to checkEntitlement + complete', async () => {
    const { agent, inference, lastTx } = makeAgent();
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.recommend(aaron, 'cust-1', WS, 'metered');

    expect(inference.checkEntitlement).toHaveBeenCalledWith(expect.anything(), 'metered');
    const [, req] = (inference.complete as jest.Mock).mock.calls[0];
    expect(req.tier).toBe('metered');
    // The echo still reflects what the (mocked) gateway reported (here: bundled).
    expect(result.tierUsed).toBe('bundled');
  });

  it('DEGRADE-CLEAN: inference unconfigured → signal snapshot only, null action, NO inference call, still logs', async () => {
    const inference = {
      isConfigured: jest.fn().mockReturnValue(false),
      checkEntitlement: jest.fn().mockReturnValue({ allowed: false, tierAllowed: 'bundled', mode: 'enforce', reason: 'x' }),
      complete: jest.fn().mockResolvedValue(null),
    };
    const { agent, lastTx } = makeAgent({ inference });
    const { tx, activities } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.recommend(aaron, 'cust-1', WS);

    expect(inference.complete).not.toHaveBeenCalled();
    expect(result.inferenceConfigured).toBe(false);
    expect(result.nextAction).toBeNull();
    expect(result.priority).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.draftOnly).toBe(true);
    // The federated signal snapshot is still returned (cockpit shows context).
    expect(result.signals.meetingCount).toBe(3);
    expect(result.note).toMatch(/not configured/i);
    expect(activities[0].kind).toBe(CustomerActivityKind.AGENT_RUN);
  });

  it('NOT ENTITLED: gate denies → no inference call, null action, draftOnly still true', async () => {
    const inference = {
      isConfigured: jest.fn().mockReturnValue(true),
      checkEntitlement: jest.fn().mockReturnValue({ allowed: false, tierAllowed: 'bundled', mode: 'enforce', reason: 'not entitled: needs customer-ops' }),
      complete: jest.fn().mockResolvedValue(null),
    };
    const { agent, lastTx } = makeAgent({ inference });
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.recommend(aaron, 'cust-1', WS);
    expect(inference.complete).not.toHaveBeenCalled();
    expect(result.entitled).toBe(false);
    expect(result.nextAction).toBeNull();
    expect(result.note).toMatch(/not entitled/i);
  });

  it('tolerates an unparseable model response (null action + a note, never throws)', async () => {
    const inference = {
      isConfigured: jest.fn().mockReturnValue(true),
      checkEntitlement: jest.fn().mockReturnValue({ allowed: true, tierAllowed: 'bundled', mode: 'enforce', reason: 'ok' }),
      complete: jest.fn().mockResolvedValue({ text: 'sorry I cannot do that', lane: 2, model: 'm', metered: false, promptTokens: null, completionTokens: null }),
    };
    const { agent, lastTx } = makeAgent({ inference });
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.recommend(aaron, 'cust-1', WS);
    expect(result.nextAction).toBeNull();
    expect(result.note).toMatch(/unparseable/i);
    // But the inference provenance is still echoed (it DID run).
    expect(result.inference).toMatchObject({ lane: 2, model: 'm' });
  });

  it('degrades when Meeting-Ops + Contact-Ops are dormant (zeros/nulls in the signal, still runs)', async () => {
    const { agent, lastTx } = makeAgent({
      contact: { getContact: jest.fn().mockResolvedValue(null) },
      meeting: {
        isConfigured: jest.fn().mockReturnValue(false),
        getMeetingSignal: jest.fn().mockResolvedValue({ meetingCount: 0, lastMeetingAt: null, lastMeetingTitle: null, openActionItemCount: 0, latestSummaryHeadline: null }),
        listMeetingsForContact: jest.fn().mockResolvedValue({ items: [], count: 0, nextCursor: null }),
        listSummariesForContact: jest.fn().mockResolvedValue([]),
        listActionItemsForContact: jest.fn().mockResolvedValue([]),
      },
      outreach: { isConfigured: jest.fn().mockReturnValue(false), listTouchesForContact: jest.fn().mockResolvedValue([]) },
    });
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.recommend(aaron, 'cust-1', WS);
    expect(result.signals).toMatchObject({ meetingCount: 0, contactDisplayName: null, lastEngagementKind: null, outreachTouchCount: 0 });
    // Inference still ran on the (thin) local signal — the agent never blocks.
    expect(result.nextAction).toBe('Send the enterprise quote.');
  });

  it('404s when the relationship does not exist in the workspace', async () => {
    const { agent, lastTx } = makeAgent();
    const { tx } = makeTx(null);
    tx.customer.findUnique.mockResolvedValue(null);
    lastTx.current = tx;
    await expect(agent.recommend(aaron, 'missing', WS)).rejects.toThrow(NotFoundException);
  });
});
