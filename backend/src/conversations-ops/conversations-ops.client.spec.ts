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

const ctx = (entitlements: string[] = [], workspaceId = 'ws-1'): FederationContext => ({
  workspaceId,
  ucUid: 'u-1',
  entitlements,
});

describe('ConversationsOpsClient', () => {
  describe('dormant (no CONVERSATIONS_OPS_BASE_URL) — degrade-clean', () => {
    const c = client({});

    it('isConfigured() is false', () => {
      expect(c.isConfigured()).toBe(false);
    });

    it('listConversationsForContact returns [] without any fetch', async () => {
      await expect(c.listConversationsForContact(ctx(), ['+15551234567'])).resolves.toEqual([]);
    });

    it('listMessagesInConversation returns [] without any fetch', async () => {
      await expect(c.listMessagesInConversation(ctx(), '+15551234567')).resolves.toEqual([]);
    });

    it('sendMessage returns null even when entitled', async () => {
      await expect(
        c.sendMessage(ctx(['customer-ops']), { to: '+15551234567', body: 'hi', externalRef: 'r1' }),
      ).resolves.toBeNull();
    });

    it('ping reports not-configured (not an error)', async () => {
      await expect(c.ping()).resolves.toMatchObject({
        seam: 'conversations-ops',
        configured: false,
        ok: false,
        detail: 'not-configured',
      });
    });

    it('activation() reports bridgeConfigured=false and blockers', () => {
      const a = c.activation();
      expect(a.bridgeConfigured).toBe(false);
      expect(a.liveSendEnabled).toBe(false);
      expect(a.enabledChannels).toEqual(['iMessage', 'SMS']);
      expect(a.blockers.some((b) => /BASE_URL/i.test(b))).toBe(true);
    });
  });

  describe('entitlement gate (send requires customer-ops)', () => {
    it('enforce: denies without customer-ops', () => {
      const c = client({ UC_ENTITLEMENT_MODE: 'enforce' });
      expect(c.checkEntitlement(ctx([])).allowed).toBe(false);
    });

    it('enforce: allows with customer-ops', () => {
      const c = client({ UC_ENTITLEMENT_MODE: 'enforce' });
      expect(c.checkEntitlement(ctx(['customer-ops'])).allowed).toBe(true);
    });

    it('open bootstrap: allows even without the SKU (with a WARN)', () => {
      const c = client({ UC_ENTITLEMENT_MODE: 'open' });
      const decision = c.checkEntitlement(ctx([]));
      expect(decision.allowed).toBe(true);
      expect(decision.mode).toBe('open');
    });

    it('normalizes SKU aliases (customer_ops)', () => {
      const c = client({ UC_ENTITLEMENT_MODE: 'enforce' });
      expect(c.checkEntitlement(ctx(['customer_ops'])).allowed).toBe(true);
    });
  });

  describe('channel + workspace enablement flags', () => {
    it('defaults to both iMessage and SMS when CHANNELS unset', () => {
      const c = client({ CONVERSATIONS_OPS_BASE_URL: 'https://gw.example' });
      expect(c.enabledChannels()).toEqual(['iMessage', 'SMS']);
      expect(c.isChannelEnabled('iMessage')).toBe(true);
      expect(c.isChannelEnabled('sms')).toBe(true);
    });

    it('honors CONVERSATIONS_OPS_CHANNELS=imessage only', () => {
      const c = client({
        CONVERSATIONS_OPS_BASE_URL: 'https://gw.example',
        CONVERSATIONS_OPS_CHANNELS: 'imessage',
      });
      expect(c.enabledChannels()).toEqual(['iMessage']);
      expect(c.isChannelEnabled('SMS')).toBe(false);
    });

    it('workspace allowlist: empty = all allowed', () => {
      const c = client({ CONVERSATIONS_OPS_BASE_URL: 'https://gw.example' });
      expect(c.isWorkspaceAllowed('ws-any')).toBe(true);
    });

    it('workspace allowlist: only listed workspaces', () => {
      const c = client({
        CONVERSATIONS_OPS_BASE_URL: 'https://gw.example',
        CONVERSATIONS_OPS_WORKSPACE_ALLOWLIST: 'ws-dogfood,ws-other',
      });
      expect(c.isWorkspaceAllowed('ws-dogfood')).toBe(true);
      expect(c.isWorkspaceAllowed('ws-prod')).toBe(false);
    });

    it('listConversations filters disabled channels and blocked workspaces', async () => {
      const c = client({
        CONVERSATIONS_OPS_BASE_URL: 'https://gw.example',
        CONVERSATIONS_OPS_CHANNELS: 'imessage',
        CONVERSATIONS_OPS_WORKSPACE_ALLOWLIST: 'ws-1',
        UC_ENTITLEMENT_MODE: 'open',
      });
      const call = jest.spyOn(c as any, 'callTool').mockResolvedValue({
        conversations: [
          {
            chatIdentifier: '+15551111111',
            service: 'iMessage',
            lastMessage: { text: 'hi', at: '2026-07-01T00:00:00Z', fromMe: false },
          },
          {
            chatIdentifier: '+15552222222',
            service: 'SMS',
            lastMessage: { text: 'sms', at: '2026-07-01T01:00:00Z', fromMe: true },
          },
        ],
      });

      const threads = await c.listConversationsForContact(ctx([], 'ws-1'), [
        '+15551111111',
        '+15552222222',
      ]);
      expect(call).toHaveBeenCalled();
      expect(threads).toHaveLength(1);
      expect(threads[0].channel).toBe('iMessage');

      // Blocked workspace → no call side effect needed; returns [] early.
      const blocked = await c.listConversationsForContact(ctx([], 'ws-blocked'), ['+15551111111']);
      expect(blocked).toEqual([]);
    });
  });

  describe('outbound safety gate', () => {
    it('keeps sends dry-run by default when the channel is activated', async () => {
      const c = client({
        CONVERSATIONS_OPS_BASE_URL: 'https://gw.example/mcp',
        UC_ENTITLEMENT_MODE: 'open',
      });
      const call = jest
        .spyOn(c as any, 'callTool')
        .mockResolvedValue({ changeSet: { applied: false }, serviceUsed: 'iMessage' });

      const result = await c.sendMessage(ctx(), {
        to: '+15551234567',
        body: 'safe test',
        externalRef: 'r1',
      });

      expect(call).toHaveBeenCalledWith(
        expect.anything(),
        'messages.send',
        expect.objectContaining({ dry_run: true }),
      );
      expect(result).toMatchObject({ dryRun: true, channel: 'iMessage', applied: false });
    });

    it('permits a live send only with an explicit true opt-in', async () => {
      const c = client({
        CONVERSATIONS_OPS_BASE_URL: 'https://gw.example/mcp',
        UC_ENTITLEMENT_MODE: 'open',
        CONVERSATIONS_OPS_LIVE_SEND_ENABLED: 'true',
      });
      const call = jest
        .spyOn(c as any, 'callTool')
        .mockResolvedValue({ changeSet: { applied: true }, serviceUsed: 'iMessage' });

      const result = await c.sendMessage(ctx(), {
        to: '+15551234567',
        body: 'live test',
        externalRef: 'r2',
      });

      expect(call).toHaveBeenCalledWith(
        expect.anything(),
        'messages.send',
        expect.objectContaining({ dry_run: false }),
      );
      expect(result).toMatchObject({ dryRun: false, applied: true });
    });

    it('LIVE_SEND_CHANNELS can restrict which channel leaves dry-run', async () => {
      const c = client({
        CONVERSATIONS_OPS_BASE_URL: 'https://gw.example/mcp',
        UC_ENTITLEMENT_MODE: 'open',
        CONVERSATIONS_OPS_LIVE_SEND_ENABLED: 'true',
        CONVERSATIONS_OPS_LIVE_SEND_CHANNELS: 'imessage',
      });
      const call = jest
        .spyOn(c as any, 'callTool')
        .mockResolvedValue({ changeSet: { applied: false }, serviceUsed: 'SMS' });

      await c.sendMessage(ctx(), {
        to: '+15551234567',
        body: 'sms',
        channel: 'SMS',
        externalRef: 'r3',
      });

      expect(call).toHaveBeenCalledWith(
        expect.anything(),
        'messages.send',
        expect.objectContaining({ dry_run: true, service: 'SMS' }),
      );
    });

    it('refuses send when channel is not enabled', async () => {
      const c = client({
        CONVERSATIONS_OPS_BASE_URL: 'https://gw.example/mcp',
        UC_ENTITLEMENT_MODE: 'open',
        CONVERSATIONS_OPS_CHANNELS: 'imessage',
      });
      const call = jest.spyOn(c as any, 'callTool');
      await expect(
        c.sendMessage(ctx(), {
          to: '+15551234567',
          body: 'nope',
          channel: 'SMS',
          externalRef: 'r4',
        }),
      ).resolves.toBeNull();
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe('mtls transport (direct-to-device) — degrade-clean without material', () => {
    const PEM_CERT = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';
    const PEM_KEY = '-----BEGIN PRIVATE KEY-----\nMIIBfake\n-----END PRIVATE KEY-----';

    it('is NOT configured when mtls is selected but cert/key are missing', () => {
      const c = client({
        CONVERSATIONS_OPS_BASE_URL: 'https://100.64.0.1:47000',
        CONVERSATIONS_OPS_TRANSPORT: 'mtls',
      });
      expect(c.isConfigured()).toBe(false);
    });

    it('reads degrade clean to [] when mtls material is missing (no connection attempt)', async () => {
      const c = client({
        CONVERSATIONS_OPS_BASE_URL: 'https://100.64.0.1:47000',
        CONVERSATIONS_OPS_TRANSPORT: 'mtls',
      });
      await expect(c.listConversationsForContact(ctx(), ['+15551234567'])).resolves.toEqual([]);
    });

    it('IS configured when mtls is selected with inline-PEM cert + key', () => {
      const c = client({
        CONVERSATIONS_OPS_BASE_URL: 'https://100.64.0.1:47000',
        CONVERSATIONS_OPS_TRANSPORT: 'mtls',
        CONVERSATIONS_OPS_CLIENT_CERT: PEM_CERT,
        CONVERSATIONS_OPS_CLIENT_KEY: PEM_KEY,
      });
      expect(c.isConfigured()).toBe(true);
    });

    it('treats an unreadable cert path as missing material (degrade-clean)', () => {
      const c = client({
        CONVERSATIONS_OPS_BASE_URL: 'https://100.64.0.1:47000',
        CONVERSATIONS_OPS_TRANSPORT: 'mtls',
        CONVERSATIONS_OPS_CLIENT_CERT: '/no/such/cert.pem',
        CONVERSATIONS_OPS_CLIENT_KEY: '/no/such/key.pem',
      });
      expect(c.isConfigured()).toBe(false);
    });

    it('default transport stays http (configured on base URL alone)', () => {
      const c = client({ CONVERSATIONS_OPS_BASE_URL: 'https://gw.example/mcp' });
      expect(c.isConfigured()).toBe(true);
    });
  });
});
