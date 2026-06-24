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

const ctx = (entitlements: string[] = []): FederationContext => ({
  workspaceId: 'ws-1',
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

  describe('reads are viewer-level (no SKU gate)', () => {
    it('listConversationsForContact does not consult entitlements when dormant', async () => {
      const c = client({});
      // Even with zero entitlements, a read degrades clean to [] (never throws).
      await expect(c.listConversationsForContact(ctx([]), ['a@b.com'])).resolves.toEqual([]);
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
