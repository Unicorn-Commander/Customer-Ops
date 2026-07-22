/**
 * Mock E2E: send / receive / threading in the unified conversation pane path.
 *
 * Proves the device messaging seam can list conversations, expand a thread
 * (messages.thread), and dry-run send — without a real UUDC device or Twilio.
 * Uses the concrete ConversationsOpsClient with callTool mocked as the device.
 */
import { ConfigService } from '@nestjs/config';
import { ConversationsOpsClient } from './conversations-ops.client';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import { FederationContext } from './conversations-ops.port';

function client(env: Record<string, string | undefined>): ConversationsOpsClient {
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  const brigade = {
    exchangedToken: jest.fn().mockResolvedValue(null),
  } as unknown as BrigadeTokenSource;
  return new ConversationsOpsClient(config, brigade);
}

const fed: FederationContext = {
  workspaceId: 'ws-dogfood',
  ucUid: 'aaron',
  entitlements: ['customer-ops'],
};

/** In-memory fake device state the mock callTool mutates. */
function mockDevice(c: ConversationsOpsClient) {
  const store: {
    conversations: Array<Record<string, unknown>>;
    messages: Record<string, Array<Record<string, unknown>>>;
  } = {
    conversations: [
      {
        chatIdentifier: '+18435550148',
        displayName: 'Dana',
        service: 'iMessage',
        lastMessage: {
          text: 'See you Monday',
          at: '2026-07-20T18:00:00Z',
          fromMe: false,
        },
      },
      {
        chatIdentifier: '+18435550199',
        displayName: 'Office',
        service: 'SMS',
        lastMessage: {
          text: 'On my way',
          at: '2026-07-19T12:00:00Z',
          fromMe: true,
        },
      },
    ],
    messages: {
      '+18435550148': [
        {
          id: '1',
          at: '2026-07-20T17:00:00Z',
          fromMe: true,
          text: 'Can we meet Monday?',
          service: 'iMessage',
        },
        {
          id: '2',
          at: '2026-07-20T18:00:00Z',
          fromMe: false,
          sender: '+18435550148',
          text: 'See you Monday',
          service: 'iMessage',
        },
      ],
      '+18435550199': [
        {
          id: '10',
          at: '2026-07-19T12:00:00Z',
          fromMe: true,
          text: 'On my way',
          service: 'SMS',
        },
      ],
    },
  };

  jest.spyOn(c as any, 'callTool').mockImplementation(
    async (_ctx: FederationContext, name: string, args: Record<string, unknown>) => {
      if (name === 'messages.list') {
        return { conversations: store.conversations };
      }
      if (name === 'messages.thread') {
        const id = String(args.chat_identifier ?? args.chatIdentifier ?? '');
        return { messages: store.messages[id] ?? [] };
      }
      if (name === 'messages.send') {
        const to = String(args.to);
        const body = String(args.body);
        const service = String(args.service || 'iMessage');
        const dry = args.dry_run === true;
        if (!dry) {
          const list = store.messages[to] ?? (store.messages[to] = []);
          list.push({
            id: `out-${list.length + 1}`,
            at: new Date().toISOString(),
            fromMe: true,
            text: body,
            service,
          });
          const conv = store.conversations.find((x) => x.chatIdentifier === to);
          if (conv) {
            conv.lastMessage = { text: body, at: new Date().toISOString(), fromMe: true };
            conv.service = service;
          }
        }
        return {
          changeSet: { applied: !dry },
          serviceUsed: service,
        };
      }
      return null;
    },
  );

  return store;
}

describe('ConversationsOpsClient — mock E2E send/receive/threading', () => {
  const baseEnv = {
    CONVERSATIONS_OPS_BASE_URL: 'https://gw.example/mcp',
    CONVERSATIONS_OPS_CHANNELS: 'imessage,sms',
    CONVERSATIONS_OPS_WORKSPACE_ALLOWLIST: 'ws-dogfood',
    UC_ENTITLEMENT_MODE: 'open',
    CONVERSATIONS_OPS_LIVE_SEND_ENABLED: 'false',
  };

  it('lists threads for contact handles (both channels)', async () => {
    const c = client(baseEnv);
    mockDevice(c);

    const threads = await c.listConversationsForContact(fed, [
      '+18435550148',
      '+18435550199',
      '+19999999999', // no conversation
    ]);

    expect(threads).toHaveLength(2);
    expect(threads.map((t) => t.channel).sort()).toEqual(['SMS', 'iMessage']);
    expect(threads[0].lastSnippet).toBeTruthy();
  });

  it('expands a conversation pane (messages.thread) in chronological order', async () => {
    const c = client(baseEnv);
    mockDevice(c);

    const messages = await c.listMessagesInConversation(fed, '+18435550148');
    expect(messages).toHaveLength(2);
    expect(messages[0].fromMe).toBe(true);
    expect(messages[1].fromMe).toBe(false);
    expect(messages[0].text).toMatch(/Monday/);
    expect(messages[1].channel).toBe('iMessage');
  });

  it('dry-run send does not mutate the device store; live send does', async () => {
    const dry = client(baseEnv);
    const store = mockDevice(dry);

    const dryResult = await dry.sendMessage(fed, {
      to: '+18435550148',
      body: 'rehearsal only',
      channel: 'iMessage',
      externalRef: 'e2e-dry-1',
    });
    expect(dryResult).toMatchObject({ dryRun: true, applied: false, channel: 'iMessage' });
    expect(store.messages['+18435550148']).toHaveLength(2); // unchanged

    const live = client({ ...baseEnv, CONVERSATIONS_OPS_LIVE_SEND_ENABLED: 'true' });
    const liveStore = mockDevice(live);
    const liveResult = await live.sendMessage(fed, {
      to: '+18435550148',
      body: 'real delivery',
      channel: 'iMessage',
      externalRef: 'e2e-live-1',
    });
    expect(liveResult).toMatchObject({ dryRun: false, applied: true });
    expect(liveStore.messages['+18435550148'].some((m) => m.text === 'real delivery')).toBe(true);
  });

  it('workspace allowlist blocks list/send for non-dogfood workspaces', async () => {
    const c = client(baseEnv);
    mockDevice(c);
    const other: FederationContext = { ...fed, workspaceId: 'ws-prod' };

    await expect(c.listConversationsForContact(other, ['+18435550148'])).resolves.toEqual([]);
    await expect(c.listMessagesInConversation(other, '+18435550148')).resolves.toEqual([]);
    await expect(
      c.sendMessage(other, { to: '+18435550148', body: 'x', externalRef: 'nope' }),
    ).resolves.toBeNull();
  });

  it('full pane path: list → expand → dry-run reply (unified conversation flow)', async () => {
    const c = client(baseEnv);
    mockDevice(c);

    const threads = await c.listConversationsForContact(fed, ['+18435550148']);
    expect(threads).toHaveLength(1);
    const chatId = threads[0].id;

    const before = await c.listMessagesInConversation(fed, chatId);
    expect(before.length).toBeGreaterThanOrEqual(2);

    const send = await c.sendMessage(fed, {
      to: chatId,
      body: 'Thanks — confirmed.',
      channel: threads[0].channel,
      externalRef: 'e2e-pane-1',
    });
    expect(send?.dryRun).toBe(true);

    // Dry-run does not append; pane still shows prior thread.
    const after = await c.listMessagesInConversation(fed, chatId);
    expect(after).toHaveLength(before.length);
  });
});
