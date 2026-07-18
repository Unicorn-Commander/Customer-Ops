import {
  retentionSweepEnabled,
  retentionSweepIntervalMs,
  selfServeSignupEnabled,
  signupMode,
  tenancyEnabled,
} from './feature-flags';

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

  describe('retentionSweepEnabled', () => {
    it('defaults OFF — the sweep purges nothing until explicitly enabled', () => {
      expect(retentionSweepEnabled(env({}))).toBe(false);
      expect(retentionSweepEnabled(env({ CUSTOMER_OPS_RETENTION_SWEEP_ENABLED: '' }))).toBe(false);
      expect(retentionSweepEnabled(env({ CUSTOMER_OPS_RETENTION_SWEEP_ENABLED: 'false' }))).toBe(
        false,
      );
    });

    it('is ON only for an explicit truthy value', () => {
      expect(retentionSweepEnabled(env({ CUSTOMER_OPS_RETENTION_SWEEP_ENABLED: 'true' }))).toBe(true);
      expect(retentionSweepEnabled(env({ CUSTOMER_OPS_RETENTION_SWEEP_ENABLED: '1' }))).toBe(true);
      expect(retentionSweepEnabled(env({ CUSTOMER_OPS_RETENTION_SWEEP_ENABLED: 'on' }))).toBe(true);
    });
  });

  describe('retentionSweepIntervalMs', () => {
    it('defaults to 24h and falls back on a bad value', () => {
      const DAY = 24 * 60 * 60 * 1000;
      expect(retentionSweepIntervalMs(env({}))).toBe(DAY);
      expect(retentionSweepIntervalMs(env({ CUSTOMER_OPS_RETENTION_SWEEP_INTERVAL_MS: 'nope' }))).toBe(
        DAY,
      );
      expect(retentionSweepIntervalMs(env({ CUSTOMER_OPS_RETENTION_SWEEP_INTERVAL_MS: '0' }))).toBe(
        DAY,
      );
      expect(retentionSweepIntervalMs(env({ CUSTOMER_OPS_RETENTION_SWEEP_INTERVAL_MS: '-5' }))).toBe(
        DAY,
      );
    });

    it('accepts a positive override', () => {
      expect(
        retentionSweepIntervalMs(env({ CUSTOMER_OPS_RETENTION_SWEEP_INTERVAL_MS: '60000' })),
      ).toBe(60000);
    });
  });
});
