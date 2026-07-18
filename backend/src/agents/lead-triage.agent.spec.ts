import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CustomerActivityKind, User } from '@prisma/client';
import { LeadTriageAgent } from './lead-triage.agent';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { MeetingOpsPort } from '../meeting-ops/meeting-ops.port';
import { OutreachPort } from '../outreach-ops/outreach-ops.port';
import { AgentInferencePort } from './inference/agent-inference.port';

/**
 * LeadTriageAgent (Phase 5) — DRAFT-ONLY relationship agent. These tests pin the
 * brief's four guarantees with EVERY port (incl. the 4-lane inference) MOCKED:
 *   - it COMPOSES the right context (local relationship + FEDERATED Contact-Ops +
 *     Meeting-Ops signal + Outreach touches) and passes it to inference,
 *   - it returns STRUCTURED output (score / recommendedPriority / rationale),
 *   - it LOGS a CustomerActivity(AGENT_RUN),
 *   - it takes NO side effect (draftOnly:true; no stage move, no send, no invoice),
 *   - it DEGRADES CLEAN when inference is unconfigured / not entitled (returns the
 *     signal snapshot, null score, no throw) and never makes the inference call.
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
    stage: 'LEAD',
    priority: 'MEDIUM',
    isLost: false,
    expectedValue: { toString: () => '5000' },
    lastStageChangeAt: new Date('2026-05-20T00:00:00Z'),
    createdAt: new Date('2026-05-20T00:00:00Z'),
    updatedAt: new Date('2026-05-20T00:00:00Z'),
    ...over,
  };
}

/** Fake tx that records customerActivity.create rows + returns the customer row
 *  + a current_workspace_id() GUC. */
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

  // Default inference: configured + entitled, returns a parseable JSON assessment.
  const inference: AgentInferencePort = {
    isConfigured: jest.fn().mockReturnValue(true),
    checkEntitlement: jest.fn().mockReturnValue({ allowed: true, tierAllowed: 'bundled', mode: 'enforce', reason: 'ok' }),
    complete: jest.fn().mockResolvedValue({
      text: '{"score":82,"recommendedPriority":"high","rationale":"Recent click + 3 meetings.","suggestedNextAction":"Send the enterprise quote."}',
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

  const agent = new LeadTriageAgent(workspaces, contact, meeting, outreach, inference);
  return { agent, contact, meeting, outreach, inference, workspaces, lastTx };
}

describe('LeadTriageAgent (all ports + inference MOCKED)', () => {
  it('composes federated signal, returns a structured assessment, logs AGENT_RUN, takes NO action', async () => {
    const { agent, contact, meeting, outreach, inference, lastTx } = makeAgent();
    const { tx, activities } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.triage(aaron, 'cust-1', WS);

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
    expect(req.task).toBe('lead-triage');
    expect(req.tier).toBe('bundled'); // relationship agent → bundled lane
    expect(req.responseFormat).toBe('json');
    const promptText = req.messages.map((m: any) => m.content).join('\n');
    expect(promptText).toContain('Wants enterprise'); // meeting summary signal
    expect(promptText).toContain('clicked'); // outreach engagement
    expect(promptText).toContain('"meetingCount": 3');

    // Structured output.
    expect(result).toMatchObject({
      agent: 'lead-triage',
      score: 82,
      recommendedPriority: 'high',
      draftOnly: true,
      inferenceConfigured: true,
      entitled: true,
      tierUsed: 'bundled',
    });
    expect(result.rationale).toMatch(/click/i);
    expect(result.signals).toMatchObject({ meetingCount: 3, lastEngagementKind: 'clicked', communicationStrength: 0.8 });

    // Logged exactly one AGENT_RUN activity (the audit trail), no PII.
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ kind: CustomerActivityKind.AGENT_RUN, workspaceId: WS, actorUcUid: UC_UID });
    expect(activities[0].body).toMatch(/lead-triage/);

    // NO side effect: the agent never moved the stage or wrote the customer.
    expect(tx.customer.findUnique).toHaveBeenCalled();
    expect((tx.customer as any).update).toBeUndefined();
  });

  it('KILL SWITCH: workspace paused → the run is HALTED at dispatch (throws, no inference, no local read)', async () => {
    const { agent, inference, workspaces, lastTx } = makeAgent();
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;
    // Runtime kill switch engaged for this workspace: the dispatch guard rejects.
    (workspaces.assertAgentsNotPaused as jest.Mock).mockRejectedValue(
      new ForbiddenException('Agent and outbound activity is paused for this workspace.'),
    );

    await expect(agent.triage(aaron, 'cust-1', WS)).rejects.toThrow(/paused/i);

    // Halted BEFORE any work: no inference spend, no relationship read.
    expect(workspaces.assertAgentsNotPaused).toHaveBeenCalledWith(WS);
    expect(inference.complete).not.toHaveBeenCalled();
    expect(tx.customer.findUnique).not.toHaveBeenCalled();
  });

  it('KILL SWITCH: workspace NOT paused → the run proceeds normally', async () => {
    const { agent, inference, workspaces, lastTx } = makeAgent();
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;
    // Default guard resolves (unset) — the run is allowed.
    const result = await agent.triage(aaron, 'cust-1', WS);

    expect(workspaces.assertAgentsNotPaused).toHaveBeenCalledWith(WS);
    expect(inference.complete).toHaveBeenCalledTimes(1);
    expect(result.score).toBe(82);
  });

  it('DEGRADE-CLEAN: inference unconfigured → signal snapshot only, null score, NO inference call, still logs', async () => {
    const inference = {
      isConfigured: jest.fn().mockReturnValue(false),
      checkEntitlement: jest.fn().mockReturnValue({ allowed: false, tierAllowed: 'bundled', mode: 'enforce', reason: 'x' }),
      complete: jest.fn().mockResolvedValue(null),
    };
    const { agent, lastTx } = makeAgent({ inference });
    const { tx, activities } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.triage(aaron, 'cust-1', WS);

    expect(inference.complete).not.toHaveBeenCalled();
    expect(result.inferenceConfigured).toBe(false);
    expect(result.score).toBeNull();
    expect(result.recommendedPriority).toBeNull();
    expect(result.draftOnly).toBe(true);
    // The federated signal snapshot is still returned (cockpit shows context).
    expect(result.signals.meetingCount).toBe(3);
    expect(result.note).toMatch(/not configured/i);
    // The run is still logged.
    expect(activities[0].kind).toBe(CustomerActivityKind.AGENT_RUN);
  });

  it('NOT ENTITLED: gate denies → no inference call, null score, draftOnly still true', async () => {
    const inference = {
      isConfigured: jest.fn().mockReturnValue(true),
      checkEntitlement: jest.fn().mockReturnValue({ allowed: false, tierAllowed: 'bundled', mode: 'enforce', reason: 'not entitled: needs customer-ops' }),
      complete: jest.fn().mockResolvedValue(null),
    };
    const { agent, lastTx } = makeAgent({ inference });
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.triage(aaron, 'cust-1', WS);
    expect(inference.complete).not.toHaveBeenCalled();
    expect(result.entitled).toBe(false);
    expect(result.score).toBeNull();
    expect(result.note).toMatch(/not entitled/i);
  });

  it('tolerates an unparseable model response (null score + a note, never throws)', async () => {
    const inference = {
      isConfigured: jest.fn().mockReturnValue(true),
      checkEntitlement: jest.fn().mockReturnValue({ allowed: true, tierAllowed: 'bundled', mode: 'enforce', reason: 'ok' }),
      complete: jest.fn().mockResolvedValue({ text: 'sorry I cannot do that', lane: 2, model: 'm', metered: false, promptTokens: null, completionTokens: null }),
    };
    const { agent, lastTx } = makeAgent({ inference });
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.triage(aaron, 'cust-1', WS);
    expect(result.score).toBeNull();
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

    const result = await agent.triage(aaron, 'cust-1', WS);
    expect(result.signals).toMatchObject({ meetingCount: 0, contactDisplayName: null, lastEngagementKind: null, outreachTouchCount: 0 });
    // Inference still ran on the (thin) local signal — the agent never blocks.
    expect(result.score).toBe(82);
  });

  it('404s when the relationship does not exist in the workspace', async () => {
    const { agent, lastTx } = makeAgent();
    const { tx } = makeTx(null);
    tx.customer.findUnique.mockResolvedValue(null);
    lastTx.current = tx;
    await expect(agent.triage(aaron, 'missing', WS)).rejects.toThrow(NotFoundException);
  });
});
