import { EmailOpsClient } from '../email-ops/email-ops.client';

// Only transport fixtures; never uses an installed PAT or sends mail.
describe('Email-Ops observed approval read', () => {
  const original = global.fetch;
  let client: EmailOpsClient, fetchMock: jest.Mock;
  const ctx = {
    workspaceId: 'workspace-local',
    ucUid: null,
    entitlements: ['customer-ops', 'email-ops'],
  };
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    const env: any = {
      EMAIL_OPS_BASE_URL: 'https://email.example.invalid',
      EMAIL_OPS_SERVICE_TOKEN: 'fixture-only',
    };
    client = new EmailOpsClient(
      { get: (key: string) => env[key] } as any,
      { exchangedToken: async () => null } as any,
      { resolveSync: () => 'workspace-mapped' } as any,
    );
  });
  afterEach(() => {
    global.fetch = original;
  });
  const response = (item: any) => new Response(JSON.stringify({ item }), { status: 200 });
  it.each(['pending', 'approved', 'rejected'])(
    'reads %s from the UI item endpoint in the mapped workspace',
    async (state) => {
      fetchMock.mockResolvedValue(
        response({
          id: 'item-1',
          message_id: 'message-1',
          state,
          message: { status: 'draft', body: 'NEVER-RETURN-BODY' },
        }),
      );
      const result = await client.getAgentInboxItem(ctx, 'item-1');
      expect(result).toMatchObject({ id: 'item-1', messageId: 'message-1', status: state });
      expect(JSON.stringify(result)).not.toContain('NEVER-RETURN-BODY');
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://email.example.invalid/api/v1/workspaces/workspace-mapped/agent-inbox/item-1',
      );
    },
  );
  it('fails closed on unavailable/malformed reads and mismatched item identity', async () => {
    fetchMock.mockRejectedValueOnce(Error('offline'));
    expect(await client.getAgentInboxItem(ctx, 'item-1')).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    expect(await client.getAgentInboxItem(ctx, 'item-1')).toBeNull();
    fetchMock.mockResolvedValueOnce(
      response({ id: 'wrong', message_id: 'message-1', state: 'approved' }),
    );
    expect(await client.getAgentInboxItem(ctx, 'item-1')).toBeNull();
  });
  it('absence from pending is never interpreted as approval', async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    expect(await client.findAgentInboxItem(ctx, 'message-1')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
