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
