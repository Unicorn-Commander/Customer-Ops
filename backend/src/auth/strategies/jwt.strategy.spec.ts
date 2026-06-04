import { JwtStrategy } from './jwt.strategy';

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
    expect(JwtStrategy.readEntitlements({ entitlements: ['customer-ops', 'accounting-ops'] })).toEqual([
      'customer-ops',
      'accounting-ops',
    ]);
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

  it('falls back to products, then nested subscription.products', () => {
    expect(JwtStrategy.readEntitlements({ products: ['accounting-ops'] })).toEqual(['accounting-ops']);
    expect(
      JwtStrategy.readEntitlements({ subscription: { products: ['customer-ops', 'accounting-ops'] } }),
    ).toEqual(['customer-ops', 'accounting-ops']);
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
