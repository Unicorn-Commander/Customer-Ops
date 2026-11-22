import { BadRequestException } from '@nestjs/common';
import { RelationshipStage, User } from '@prisma/client';
import { CustomersService, NO_RECIPIENT_MESSAGE } from './customers.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { entitlementsOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { EmailOpsPort } from '../email-ops/email-ops.port';
import { LeadLabelResolver } from '../lead-intake/lead-label.port';

/**
 * AUD-CR-3: a lead with a provisional 'prov:' contact (no Contact-Ops record
 * yet) gets its recipient from the lead's intake email, on send and as the
 * compose pre-fill; with no address at all the error is in plain words, never
 * the old "Customer-Ops does not store the address" text.
 *
 * Fictional people and hosts (example.com) only.
 */
const WS = '0190a000-7e57-7000-8000-00000000c0a3';
const PROV = 'prov:3f1c0a';
const user = {
  id: 'local-rep',
  email: 'rep@example.com',
  keycloakId: 'kc-rep',
  __entitlements: ['customer-ops', 'email-ops'],
} as unknown as User & Partial<WithWorkspaceClaim>;

function makeService(opts: { intakeEmail?: string | null; withResolver?: boolean } = {}) {
  const row = {
    id: 'cust-1',
    workspaceId: WS,
    contactId: PROV,
    stage: RelationshipStage.LEAD,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-01T00:00:00Z'),
  };
  const emailLinks: any[] = [];
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ ws: WS }]),
    customer: { findUnique: jest.fn().mockResolvedValue(row) },
    customerActivity: { create: jest.fn(async ({ data }: any) => data) },
    customerEmailLink: {
      findMany: jest.fn(async () => emailLinks),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => {
        const r = { id: 'eml-1', createdAt: new Date(), updatedAt: new Date(), ...data };
        emailLinks.push(r);
        return r;
      }),
      update: jest.fn(async ({ data }: any) => ({ ...emailLinks[0], ...data })),
    },
  };
  const workspaces = {
    resolveAuthorized: jest.fn().mockResolvedValue(WS),
    assertAgentsNotPaused: jest.fn().mockResolvedValue(undefined),
    effectiveEntitlements: jest.fn(async (u: any) => entitlementsOf(u)),
    runForUser: jest.fn(async (_u: User, fn: any) => fn(tx)),
    runForUserReadOnly: jest.fn(async (_u: User, fn: any) => fn(tx)),
    runInWorkspace: jest.fn(async (_ws: string, _uc: any, fn: any) => fn(tx)),
  } as unknown as WorkspaceContextService;
  // Contact-Ops has no record for a provisional id.
  const contact = { getContact: jest.fn().mockResolvedValue(null) } as unknown as ContactOpsPort;
  const email = {
    isConfigured: jest.fn().mockReturnValue(true),
    checkEntitlement: jest.fn().mockReturnValue({ allowed: true, mode: 'enforce', reason: 'ok' }),
    listThreadsWithContact: jest.fn().mockResolvedValue([]),
    composeEmail: jest.fn(async (_ctx: any, req: any) => ({
      id: 'msg-1',
      threadId: 't-1',
      status: 'pending_approval',
      mode: req.mode,
      externalSource: req.externalSource,
      externalRef: req.externalRef,
      createdAt: '2026-11-21T00:00:00Z',
    })),
  } as unknown as EmailOpsPort;
  const labels = jest.fn(async (_u: any, _ws: any, ids: string[]) => {
    const out = new Map();
    if (opts.intakeEmail !== undefined && ids.includes(PROV)) {
      out.set(PROV, {
        displayName: 'Rosa Lead',
        primaryEmail: opts.intakeEmail,
        currentOrgName: null,
        tags: [],
      });
    }
    return out;
  });
  const leadLabels =
    opts.withResolver === false ? undefined : ({ labels } as unknown as LeadLabelResolver);
  const dormant = { isConfigured: jest.fn().mockReturnValue(false) } as any;
  const svc = new CustomersService(
    workspaces,
    contact,
    dormant,
    dormant,
    email,
    dormant,
    dormant,
    undefined,
    leadLabels,
  );
  return { svc, email, labels };
}

describe('provisional lead email recipient (AUD-CR-3)', () => {
  it('send with no To uses the lead intake email', async () => {
    const { svc, email, labels } = makeService({ intakeEmail: 'rosa@lead.example.com' });
    await svc.sendEmailForUser(user, 'cust-1', { subject: 'Hello', body: 'Following up' }, WS);
    expect(labels).toHaveBeenCalledWith(user, WS, [PROV]);
    const [, req] = (email.composeEmail as jest.Mock).mock.calls[0];
    expect(req.toAddress).toBe('rosa@lead.example.com');
    expect(req.contactId).toBe(PROV);
  });

  it('the email panel pre-fills To from the lead intake email', async () => {
    const { svc } = makeService({ intakeEmail: 'rosa@lead.example.com' });
    const panel = await svc.emailForUser(user, 'cust-1', WS);
    expect(panel.suggestedToAddress).toBe('rosa@lead.example.com');
  });

  it('an explicit To wins and the intake is not read', async () => {
    const { svc, email, labels } = makeService({ intakeEmail: 'rosa@lead.example.com' });
    await svc.sendEmailForUser(
      user,
      'cust-1',
      { toAddress: 'other@example.com', subject: 'Hi', body: 'b' },
      WS,
    );
    expect(labels).not.toHaveBeenCalled();
    expect((email.composeEmail as jest.Mock).mock.calls[0][1].toAddress).toBe('other@example.com');
  });

  it.each([
    ['the intake has no email', { intakeEmail: null }],
    ['there is no intake row', {}],
    ['lead intake is not wired', { withResolver: false }],
  ])('no address anywhere (%s): plain-words 400, no raw internal text', async (_l, opts) => {
    const { svc, email } = makeService(opts);
    const err = await svc
      .sendEmailForUser(user, 'cust-1', { subject: 'Hi', body: 'b' }, WS)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(NO_RECIPIENT_MESSAGE);
    expect(err.message).not.toMatch(/Customer-Ops|Contact-Ops|does not store/);
    expect(email.composeEmail).not.toHaveBeenCalled();
  });
});
