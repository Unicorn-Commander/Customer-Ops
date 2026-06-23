import { ConfigService } from '@nestjs/config';
import { M365Config } from './m365.config';
import { TokenCipher } from './crypto/token-cipher';
import { MsalClientFactory } from './oauth/msal-client.factory';
import { M365HealthIndicator } from './m365.health';

/**
 * DORMANCY CONTRACT — with M365_CLIENT_ID unset the entire connector constructs
 * inert and changes nothing about the app. This pins that every provider that
 * reads config can be built with an EMPTY environment without throwing, and that
 * the connector reports itself honestly as not-configured.
 *
 * (The route-level dormancy — 503 on start/sync, {configured:false} on status —
 * is covered in the oauth + sync specs; this is the construction-time guarantee.)
 */
function emptyConfig(): ConfigService {
  return { get: () => undefined } as unknown as ConfigService;
}

describe('M365 connector — dormant when M365_CLIENT_ID is unset', () => {
  const config = new M365Config(emptyConfig());

  it('M365Config reports not-configured', () => {
    expect(config.isConfigured).toBe(false);
    expect(config.clientId).toBeNull();
  });

  it('TokenCipher constructs inert (no fail-closed throw) when dormant', () => {
    expect(() => new TokenCipher(emptyConfig())).not.toThrow();
    expect(new TokenCipher(emptyConfig()).isReady).toBe(false);
  });

  it('MsalClientFactory constructs but is not ready (CCA never built)', () => {
    const factory = new MsalClientFactory(config);
    expect(factory.isReady).toBe(false);
  });

  it('the health seam reports not-configured (honest "Not connected" on the page)', async () => {
    const health = new M365HealthIndicator(config);
    const seam = await health.ping();
    expect(seam).toEqual({
      seam: 'm365',
      configured: false,
      ok: false,
      status: null,
      detail: 'not-configured',
      latencyMs: null,
    });
  });
});
