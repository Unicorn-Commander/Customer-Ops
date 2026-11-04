import { JwtStrategy } from './jwt.strategy';
import { ConfigService } from '@nestjs/config';

/**
 * Audience-binding is the cross-app fence (SUITE-IDENTITY §9.4): a federation
 * token minted FOR another app must be rejected by Customer-Ops even when its
 * signature + issuer verify. This pins the pure matcher used in validate().
 */
describe('JwtStrategy.audienceMatches', () => {
  it('accepts a string aud equal to the expected app audience', () => {
    expect(JwtStrategy.audienceMatches('customer-ops', 'customer-ops')).toBe(true);
  });

  it('accepts an array aud that contains the expected audience', () => {
    expect(JwtStrategy.audienceMatches(['x', 'customer-ops'], 'customer-ops')).toBe(true);
  });

  it('rejects an aud minted for another app (accounting-ops)', () => {
    expect(JwtStrategy.audienceMatches('accounting-ops', 'customer-ops')).toBe(false);
    expect(JwtStrategy.audienceMatches(['accounting-ops', 'project-ops'], 'customer-ops')).toBe(
      false,
    );
  });

  it('rejects a missing / malformed aud', () => {
    expect(JwtStrategy.audienceMatches(undefined, 'customer-ops')).toBe(false);
    expect(JwtStrategy.audienceMatches(null, 'customer-ops')).toBe(false);
    expect(JwtStrategy.audienceMatches({}, 'customer-ops')).toBe(false);
  });
});

/**
 * The entitlement SKUs surfaced off the verified token (`__entitlements`) feed
 * the Phase-3 Accounting-Ops dual-SKU gate. This pins the tolerant extractor
 * (mirrors AO's claim shapes) so the gate sees a stable string[].
 */
describe('JwtStrategy.readEntitlements', () => {
  it('reads a flat entitlements array', () => {
    expect(
      JwtStrategy.readEntitlements({ entitlements: ['customer-ops', 'accounting-ops'] }),
    ).toEqual(['customer-ops', 'accounting-ops']);
  });

  it('reads a space- or comma-separated entitlements string', () => {
    expect(JwtStrategy.readEntitlements({ entitlements: 'customer-ops accounting-ops' })).toEqual([
      'customer-ops',
      'accounting-ops',
    ]);
    expect(JwtStrategy.readEntitlements({ entitlements: 'customer-ops, accounting-ops' })).toEqual([
      'customer-ops',
      'accounting-ops',
    ]);
  });

  it('reads the suite-namespaced uc_skus claim (array OR string)', () => {
    expect(JwtStrategy.readEntitlements({ uc_skus: ['customer-ops', 'ai-metered'] })).toEqual([
      'customer-ops',
      'ai-metered',
    ]);
    expect(JwtStrategy.readEntitlements({ uc_skus: 'customer-ops ai-metered' })).toEqual([
      'customer-ops',
      'ai-metered',
    ]);
  });

  it('reads the singular entitlement claim as a fallback', () => {
    expect(JwtStrategy.readEntitlements({ entitlement: 'customer-ops' })).toEqual(['customer-ops']);
    expect(JwtStrategy.readEntitlements({ entitlement: ['customer-ops'] })).toEqual([
      'customer-ops',
    ]);
  });

  it('falls back to products, then nested subscription.products', () => {
    expect(JwtStrategy.readEntitlements({ products: ['accounting-ops'] })).toEqual([
      'accounting-ops',
    ]);
    expect(
      JwtStrategy.readEntitlements({
        subscription: { products: ['customer-ops', 'accounting-ops'] },
      }),
    ).toEqual(['customer-ops', 'accounting-ops']);
  });

  it('honors claim precedence: entitlements wins over uc_skus/products/entitlement', () => {
    // First non-empty wins — a token that (transitionally) carries more than one
    // shape must resolve deterministically to the canonical `entitlements` claim.
    expect(
      JwtStrategy.readEntitlements({
        entitlements: ['customer-ops'],
        uc_skus: ['ai-metered'],
        products: ['email-ops'],
        entitlement: 'accounting-ops',
      }),
    ).toEqual(['customer-ops']);
    // ...and uc_skus wins over the later fallbacks when `entitlements` is absent.
    expect(
      JwtStrategy.readEntitlements({ uc_skus: ['customer-ops'], products: ['email-ops'] }),
    ).toEqual(['customer-ops']);
  });

  it('handles object items {code, active} and drops inactive', () => {
    expect(
      JwtStrategy.readEntitlements({
        entitlements: [
          { code: 'customer-ops', active: true },
          { product: 'accounting-ops', active: false },
        ],
      }),
    ).toEqual(['customer-ops']);
  });

  it('returns [] when no entitlement claim is present', () => {
    expect(JwtStrategy.readEntitlements({})).toEqual([]);
    expect(JwtStrategy.readEntitlements({ entitlements: null })).toEqual([]);
  });

  it('de-duplicates', () => {
    expect(
      JwtStrategy.readEntitlements({ entitlements: ['customer-ops', 'customer-ops'] }),
    ).toEqual(['customer-ops']);
  });
});

describe('JwtStrategy human realm bearer forwarding', () => {
  const user = {
    id: 'local-human',
    email: 'human@lantern-harbor.example',
    isActive: true,
  } as any;

  function makeStrategy() {
    const auth = {
      validateJwtPayload: jest.fn(async () => user),
    };
    const strategy = new JwtStrategy(
      new ConfigService({
        JWT_SECRET: 'fixture-secret',
        KEYCLOAK_URL: 'https://auth.example.test',
        KEYCLOAK_PUBLIC_URL: 'https://auth.example.test',
        KEYCLOAK_REALM: 'uchub',
        KEYCLOAK_CLIENT_ID: 'customer-ops',
        BRIGADE_TRUSTED_ISSUERS: 'https://brigade.unicorncommander.ai',
      }),
      auth as any,
    );
    return { strategy, auth };
  }

  it('forwards only a human Keycloak realm bearer', async () => {
    const { strategy, auth } = makeStrategy();
    const payload = {
      sub: 'kc-human',
      iss: 'https://auth.example.test/realms/uchub',
      aud: 'customer-ops',
      email: 'human@lantern-harbor.example',
      email_verified: true,
    };

    await strategy.validate(
      { headers: { authorization: 'Bearer fixture-human-bearer' } } as any,
      payload,
    );

    expect(auth.validateJwtPayload).toHaveBeenCalledWith(payload, 'fixture-human-bearer');
  });

  it('does not forward PAT-shaped or federation bearers', async () => {
    const { strategy, auth } = makeStrategy();
    const human = {
      sub: 'kc-human',
      iss: 'https://auth.example.test/realms/uchub',
      aud: 'customer-ops',
      email: 'human@lantern-harbor.example',
      email_verified: true,
    };
    const federation = {
      ...human,
      sub: 'brigade-human',
      iss: 'https://brigade.unicorncommander.ai',
    };

    await strategy.validate({ headers: { authorization: 'Bearer co_pat_fixture' } } as any, human);
    await strategy.validate(
      { headers: { authorization: 'Bearer fixture-federation-bearer' } } as any,
      federation,
    );

    expect(auth.validateJwtPayload).toHaveBeenNthCalledWith(1, human);
    expect(auth.validateJwtPayload).toHaveBeenNthCalledWith(2, federation);
  });
});
