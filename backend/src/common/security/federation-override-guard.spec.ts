import {
  KNOWN_OVERRIDE_ENV_KEYS,
  OVERRIDE_ENV_SUFFIX,
  FederationOverrideGuardError,
  collectActiveOverrideEnvs,
  evaluateFederationOverrideGuard,
  assertFederationOverrideSafe,
} from './federation-override-guard';

describe('federation-override-guard', () => {
  describe('collectActiveOverrideEnvs', () => {
    it('returns [] when no *_WORKSPACE_OVERRIDE env is set', () => {
      expect(collectActiveOverrideEnvs({})).toEqual([]);
      expect(
        collectActiveOverrideEnvs({ OUTREACH_BASE_URL: 'https://x', NODE_ENV: 'production' }),
      ).toEqual([]);
    });

    it('ignores an override env that is present but empty / whitespace-only', () => {
      expect(
        collectActiveOverrideEnvs({ EMAIL_OPS_WORKSPACE_OVERRIDE: '' }),
      ).toEqual([]);
      expect(
        collectActiveOverrideEnvs({ EMAIL_OPS_WORKSPACE_OVERRIDE: '   ' }),
      ).toEqual([]);
    });

    it('collects only the set override keys, sorted', () => {
      const env = {
        PROJECT_OPS_WORKSPACE_OVERRIDE: 'canonical-ws',
        AO_WORKSPACE_OVERRIDE: 'canonical-ws',
        CONTACT_OPS_WORKSPACE_OVERRIDE: '',
        NODE_ENV: 'production',
      };
      expect(collectActiveOverrideEnvs(env)).toEqual([
        'AO_WORKSPACE_OVERRIDE',
        'PROJECT_OPS_WORKSPACE_OVERRIDE',
      ]);
    });

    it('catches a hypothetical future seam via the suffix (not a hard-coded list)', () => {
      expect(
        collectActiveOverrideEnvs({ FUTURE_OPS_WORKSPACE_OVERRIDE: 'ws-9' }),
      ).toEqual(['FUTURE_OPS_WORKSPACE_OVERRIDE']);
    });
  });

  // Per-seam coverage: every one of the six federation seams that carries an
  // override must (a) be caught by the collector and (b) trip the guard once a
  // second workspace exists. Table-driven so each seam is asserted individually.
  describe.each(KNOWN_OVERRIDE_ENV_KEYS)('per-seam override: %s', (key) => {
    it('ends with the override suffix', () => {
      expect(key.endsWith(OVERRIDE_ENV_SUFFIX)).toBe(true);
    });

    it('is collected when set', () => {
      expect(collectActiveOverrideEnvs({ [key]: 'canonical-ws' })).toEqual([key]);
    });

    it('with NO override set, the seam passes the request tenant through (guard is safe)', () => {
      // No override => each client resolves `this.workspaceOverride ?? ctx.workspaceId`
      // to ctx.workspaceId. The guard mirrors that: no override => always safe, even
      // across many workspaces with multi-tenancy on.
      const verdict = evaluateFederationOverrideGuard({
        activeOverrides: [],
        workspaceCount: 25,
        tenancyMulti: true,
      });
      expect(verdict.safe).toBe(true);
    });

    it('with the override set + more than one workspace, the guard throws and names the seam', () => {
      expect(() =>
        assertFederationOverrideSafe({
          activeOverrides: [key],
          workspaceCount: 2,
          tenancyMulti: false,
        }),
      ).toThrow(FederationOverrideGuardError);

      try {
        assertFederationOverrideSafe({
          activeOverrides: [key],
          workspaceCount: 2,
          tenancyMulti: false,
        });
        fail('expected the guard to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(FederationOverrideGuardError);
        expect((err as FederationOverrideGuardError).offendingEnvs).toEqual([key]);
        expect((err as Error).message).toContain(key);
      }
    });
  });

  describe('evaluateFederationOverrideGuard', () => {
    it('safe: no override, single workspace, tenancy off (vanilla dogfood boot)', () => {
      expect(
        evaluateFederationOverrideGuard({
          activeOverrides: [],
          workspaceCount: 1,
          tenancyMulti: false,
        }),
      ).toEqual({ safe: true, offendingEnvs: [] });
    });

    it('safe: override set but a single-workspace dogfood stack (count=1, tenancy off) still boots', () => {
      const verdict = evaluateFederationOverrideGuard({
        activeOverrides: ['EMAIL_OPS_WORKSPACE_OVERRIDE'],
        workspaceCount: 1,
        tenancyMulti: false,
      });
      expect(verdict.safe).toBe(true);
      expect(verdict.offendingEnvs).toEqual(['EMAIL_OPS_WORKSPACE_OVERRIDE']);
    });

    it('safe: override set with ZERO workspace rows (fresh stack, tenancy off) still boots', () => {
      // A count of 0 is not "> 1"; the fresh/empty stack is not yet multi-tenant.
      expect(
        evaluateFederationOverrideGuard({
          activeOverrides: ['AO_WORKSPACE_OVERRIDE'],
          workspaceCount: 0,
          tenancyMulti: false,
        }).safe,
      ).toBe(true);
    });

    it('UNSAFE: override set + more than one workspace row', () => {
      const verdict = evaluateFederationOverrideGuard({
        activeOverrides: ['EMAIL_OPS_WORKSPACE_OVERRIDE', 'AO_WORKSPACE_OVERRIDE'],
        workspaceCount: 3,
        tenancyMulti: false,
      });
      expect(verdict.safe).toBe(false);
      expect(verdict.offendingEnvs).toEqual([
        'EMAIL_OPS_WORKSPACE_OVERRIDE',
        'AO_WORKSPACE_OVERRIDE',
      ]);
      expect(verdict.reason).toContain('3 rows');
      expect(verdict.reason).toContain('EMAIL_OPS_WORKSPACE_OVERRIDE');
    });

    it('UNSAFE: override set + tenancy multi even with a single workspace row', () => {
      const verdict = evaluateFederationOverrideGuard({
        activeOverrides: ['CONTACT_OPS_WORKSPACE_OVERRIDE'],
        workspaceCount: 1,
        tenancyMulti: true,
      });
      expect(verdict.safe).toBe(false);
      expect(verdict.reason).toContain('multi-tenant mode');
    });
  });

  describe('assertFederationOverrideSafe', () => {
    it('does not throw on a safe verdict', () => {
      expect(() =>
        assertFederationOverrideSafe({
          activeOverrides: ['EMAIL_OPS_WORKSPACE_OVERRIDE'],
          workspaceCount: 1,
          tenancyMulti: false,
        }),
      ).not.toThrow();
    });

    it('throws FederationOverrideGuardError carrying every offending env on an unsafe verdict', () => {
      const offending = ['AO_WORKSPACE_OVERRIDE', 'PROJECT_OPS_WORKSPACE_OVERRIDE'];
      try {
        assertFederationOverrideSafe({
          activeOverrides: offending,
          workspaceCount: 2,
          tenancyMulti: true,
        });
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(FederationOverrideGuardError);
        expect((err as FederationOverrideGuardError).offendingEnvs).toEqual(offending);
      }
    });
  });
});
