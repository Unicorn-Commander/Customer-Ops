import { selfServeSignupEnabled, signupMode, tenancyEnabled } from './feature-flags';

/**
 * Every flag defaults to TODAY's behavior (the suite quality bar). signupMode in
 * particular must fail safe to 'invite' on anything that isn't an explicit,
 * case-insensitive 'open' — a typo or empty value must NOT silently open signup.
 */
describe('feature-flags', () => {
  const env = (v: Record<string, string | undefined>) => (k: string) => v[k];

  describe('signupMode', () => {
    it("defaults to 'invite' when unset (today's invite-only posture)", () => {
      expect(signupMode(env({}))).toBe('invite');
      expect(selfServeSignupEnabled(env({}))).toBe(false);
    });

    it("returns 'open' only for an explicit case-insensitive 'open'", () => {
      expect(signupMode(env({ CUSTOMER_OPS_SIGNUP_MODE: 'open' }))).toBe('open');
      expect(signupMode(env({ CUSTOMER_OPS_SIGNUP_MODE: 'OPEN' }))).toBe('open');
      expect(signupMode(env({ CUSTOMER_OPS_SIGNUP_MODE: '  Open  ' }))).toBe('open');
      expect(selfServeSignupEnabled(env({ CUSTOMER_OPS_SIGNUP_MODE: 'open' }))).toBe(true);
    });

    it("fails safe to 'invite' on a typo / empty / unrelated value", () => {
      expect(signupMode(env({ CUSTOMER_OPS_SIGNUP_MODE: 'opn' }))).toBe('invite');
      expect(signupMode(env({ CUSTOMER_OPS_SIGNUP_MODE: '' }))).toBe('invite');
      expect(signupMode(env({ CUSTOMER_OPS_SIGNUP_MODE: 'invite' }))).toBe('invite');
      expect(signupMode(env({ CUSTOMER_OPS_SIGNUP_MODE: 'true' }))).toBe('invite');
    });
  });

  describe('tenancyEnabled (unchanged default)', () => {
    it('defaults OFF', () => {
      expect(tenancyEnabled(env({}))).toBe(false);
    });
  });
});
