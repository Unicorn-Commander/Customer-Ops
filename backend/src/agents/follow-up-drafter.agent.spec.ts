import { NotFoundException } from '@nestjs/common';
import { CustomerActivityKind, User } from '@prisma/client';
import { FollowUpDrafterAgent } from './follow-up-drafter.agent';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { entitlementsOf } from '../common/workspace/workspace.util';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { MeetingOpsPort } from '../meeting-ops/meeting-ops.port';
import { OutreachPort } from '../outreach-ops/outreach-ops.port';
import { AgentInferencePort } from './inference/agent-inference.port';
import { CustomersService } from '../customers/customers.service';

/**
 * FollowUpDrafterAgent (Phase 5) — DRAFT-ONLY. These tests pin:
 *   - it COMPOSES the right context (relationship + FEDERATED contact + last
 *     touch/meeting) and prompts inference,
 *   - it returns a STRUCTURED draft (subject + body + the resolved recipient),
 *   - it LOGS a CustomerActivity(AGENT_RUN),
 *   - it NEVER auto-sends: when stageDraft is requested it hands to
 *     CustomersService.sendEmailForUser with mode='draft' EXACTLY (never 'send');
 *     by default it stages NOTHING (returns the draft to the caller),
 *   - it DEGRADES CLEAN when inference is unconfigured / not entitled.
 */
const WS = '0190a000-7e57-7000-8000-00000000c007';
const UC_UID = 'kc-aaron-sub';
const aaron = { id: 'a', email: 'aaron@magicunicorn.tech', keycloakId: UC_UID, __entitlements: ['customer-ops'] } as unknown as User;

function makeRow(over: Partial<Record<string, any>> = {}) {
  return { id: 'cust-1', workspaceId: WS, contactId: 'contact-42', stage: 'PROSPECT', priority: 'HIGH', isLost: false, notes: 'warm', lastStageChangeAt: new Date('2026-05-25T00:00:00Z'), createdAt: new Date(), updatedAt: new Date(), ...over };
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

function makeAgent(opts?: {
  contact?: Partial<ContactOpsPort>;
  inference?: Partial<AgentInferencePort>;
  customers?: Partial<CustomersService>;
}) {
  const contact: ContactOpsPort = {
    getContact: jest.fn().mockResolvedValue({
      contactId: 'contact-42', displayName: 'Jane Lead', primaryEmail: 'jane@x.com',
      currentOrgId: null, currentOrgName: 'Acme', lastInteractionAt: null, communicationStrength: 0.7,
      tags: [], etag: null, vcardUid: null, kind: 'individual', status: 'active', emails: [], phones: [], recentEvents: [],
    }),
    getContactSummaries: jest.fn().mockResolvedValue(new Map()),
    listContacts: jest.fn(), getWorkspaceProjection: jest.fn(),
    ...(opts?.contact ?? {}),
  } as any;

  const meeting: MeetingOpsPort = {
    isConfigured: jest.fn().mockReturnValue(true),
    listMeetingsForContact: jest.fn().mockResolvedValue({ items: [], count: 0, nextCursor: null }),
    listSummariesForContact: jest.fn().mockResolvedValue([{ id: 's1', meetingId: 'm1', headline: 'Wants enterprise', body: 'Discussed Q3 rollout', keyPoints: [], createdAt: '2026-06-01T00:00:00Z' }]),
    listActionItemsForContact: jest.fn().mockResolvedValue([]),
    getMeetingSignal: jest.fn().mockResolvedValue({ meetingCount: 2, lastMeetingAt: '2026-06-01T15:00:00Z', lastMeetingTitle: 'Pricing sync', openActionItemCount: 1, latestSummaryHeadline: 'Wants enterprise' }),
  } as any;

  const outreach: OutreachPort = {
    isConfigured: jest.fn().mockReturnValue(true),
    checkEntitlement: jest.fn().mockReturnValue({ allowed: true, mode: 'enforce', reason: 'ok' }),
    listCampaigns: jest.fn().mockResolvedValue([]),
    listTouchesForContact: jest.fn().mockResolvedValue([{ id: 't1', channel: 'email', campaignId: 'c1', campaignName: 'N', status: 'opened', subject: 'Earlier note', scheduledAt: null, sentAt: '2026-05-30T00:00:00Z', lastEngagementKind: 'opened', lastEngagementAt: '2026-05-30T00:00:00Z' }]),
    enrollContact: jest.fn(), scheduleSocialTouch: jest.fn(),
  } as any;

  const inference: AgentInferencePort = {
    isConfigured: jest.fn().mockReturnValue(true),
    checkEntitlement: jest.fn().mockReturnValue({ allowed: true, tierAllowed: 'bundled', mode: 'enforce', reason: 'ok' }),
    complete: jest.fn().mockResolvedValue({
      text: '{"subject":"Following up on the enterprise rollout","body":"Hi Jane, great chatting on our pricing sync..."}',
      lane: 2, model: 'qwen3-27b', metered: false, promptTokens: 200, completionTokens: 80,
    }),
    ...(opts?.inference ?? {}),
  } as any;

  // CustomersService is mocked: only sendEmailForUser is exercised (the OPTIONAL
  // mode='draft' staging path). It is NEVER used to send.
  const customers = {
    sendEmailForUser: jest.fn().mockResolvedValue({
      link: { id: 'eml-1' },
      message: { id: 'msg-1', threadId: 'thread-1', status: 'pending_approval', mode: 'draft' },
    }),
    ...(opts?.customers ?? {}),
  } as unknown as CustomersService;

  const lastTx = { current: null as any };
  const workspaces = {
    resolveAuthorized: jest.fn().mockResolvedValue(WS),
    // Workspace has no server-side cache in these unit specs → the (user,workspace)
    // bind is the identity: effective == the token/PAT claim on the user.
    effectiveEntitlements: jest.fn(async (u: any) => entitlementsOf(u)),
    runForUser: jest.fn(async (_u: User, fn: any) => fn(lastTx.current)),
  } as unknown as WorkspaceContextService;

  const agent = new FollowUpDrafterAgent(workspaces, contact, meeting, outreach, inference, customers);
  return { agent, contact, meeting, outreach, inference, customers, lastTx };
}

describe('FollowUpDrafterAgent (all ports + inference + CustomersService MOCKED)', () => {
  it('composes context, returns a structured draft, logs AGENT_RUN, stages NOTHING by default', async () => {
    const { agent, contact, inference, customers, lastTx } = makeAgent();
    const { tx, activities } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.draftFollowUp(aaron, 'cust-1', { goal: 'nudge for the signed SOW' }, WS);

    // Composed context: federated contact + the prompt carries meeting/outreach signal.
    expect(contact.getContact).toHaveBeenCalled();
    const [, req] = (inference.complete as jest.Mock).mock.calls[0];
    expect(req.task).toBe('follow-up-draft');
    expect(req.tier).toBe('bundled');
    const promptText = req.messages.map((m: any) => m.content).join('\n');
    expect(promptText).toContain('nudge for the signed SOW');
    expect(promptText).toContain('Pricing sync'); // last meeting title
    expect(promptText).toContain('Wants enterprise'); // summary headline

    // Structured draft + resolved (federated) recipient.
    expect(result).toMatchObject({
      agent: 'follow-up-draft',
      subject: 'Following up on the enterprise rollout',
      toAddress: 'jane@x.com',
      draftOnly: true,
      stagedDraft: null, // default: NOT staged
    });
    expect(result.body).toMatch(/Hi Jane/);

    // NEVER auto-sends: default does not touch Email-Ops at all.
    expect(customers.sendEmailForUser).not.toHaveBeenCalled();

    // Logged AGENT_RUN.
    expect(activities[0]).toMatchObject({ kind: CustomerActivityKind.AGENT_RUN });
    expect(activities[0].body).toMatch(/follow-up drafter/);
  });

  it('stageDraft=true hands the draft to Email-Ops with mode=DRAFT exactly (never send)', async () => {
    const { agent, customers, lastTx } = makeAgent();
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.draftFollowUp(aaron, 'cust-1', { stageDraft: true, idempotencyKey: 'fu-1' }, WS);

    expect(customers.sendEmailForUser).toHaveBeenCalledTimes(1);
    const [, customerId, dto] = (customers.sendEmailForUser as jest.Mock).mock.calls[0];
    expect(customerId).toBe('cust-1');
    // THE INVARIANT: the agent passes mode='draft' — NEVER 'send'.
    expect(dto.mode).toBe('draft');
    expect(dto.subject).toBe('Following up on the enterprise rollout');
    expect(dto.idempotencyKey).toBe('fu-1');
    // The staged draft is echoed back; status reflects the agent-inbox approval state.
    expect(result.stagedDraft).toMatchObject({ messageId: 'msg-1', status: 'pending_approval' });
    expect(result.draftOnly).toBe(true);
  });

  it('never passes mode=send under ANY option combination', async () => {
    const { agent, customers, lastTx } = makeAgent();
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;
    await agent.draftFollowUp(aaron, 'cust-1', { stageDraft: true }, WS);
    const calls = (customers.sendEmailForUser as jest.Mock).mock.calls;
    for (const call of calls) {
      expect(call[2].mode).toBe('draft');
      expect(call[2].mode).not.toBe('send');
    }
  });

  it('staging failure leaves the draft returned to the caller (best-effort, no throw)', async () => {
    const customers = { sendEmailForUser: jest.fn().mockRejectedValue(new Error('not entitled')) };
    const { agent, lastTx } = makeAgent({ customers });
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.draftFollowUp(aaron, 'cust-1', { stageDraft: true }, WS);
    expect(result.subject).toBe('Following up on the enterprise rollout'); // draft still returned
    expect(result.stagedDraft).toBeNull();
    expect(result.note).toMatch(/could not stage/i);
  });

  it('DEGRADE-CLEAN: inference unconfigured → recipient + context, null subject/body, NO inference call', async () => {
    const inference = { isConfigured: jest.fn().mockReturnValue(false), checkEntitlement: jest.fn().mockReturnValue({ allowed: false, tierAllowed: 'bundled', mode: 'enforce', reason: 'x' }), complete: jest.fn().mockResolvedValue(null) };
    const { agent, customers, lastTx } = makeAgent({ inference });
    const { tx, activities } = makeTx(makeRow());
    lastTx.current = tx;

    const result = await agent.draftFollowUp(aaron, 'cust-1', { stageDraft: true }, WS);
    expect(inference.complete).not.toHaveBeenCalled();
    expect(result.subject).toBeNull();
    expect(result.body).toBeNull();
    expect(result.toAddress).toBe('jane@x.com'); // recipient still resolved
    // No draft → nothing staged even though stageDraft was requested.
    expect(customers.sendEmailForUser).not.toHaveBeenCalled();
    expect(result.note).toMatch(/not configured/i);
    expect(activities[0].kind).toBe(CustomerActivityKind.AGENT_RUN);
  });

  it('404s when the relationship does not exist', async () => {
    const { agent, lastTx } = makeAgent();
    const { tx } = makeTx(null);
    tx.customer.findUnique.mockResolvedValue(null);
    lastTx.current = tx;
    await expect(agent.draftFollowUp(aaron, 'missing', {}, WS)).rejects.toThrow(NotFoundException);
  });
});
