import {
  clearOrgEntitlementCacheForTests,
  customerOpsEntitlementFeatureKey,
  customerOpsEntitlementsEnabled,
  resolveOrgEntitlement,
} from './org-entitlements.client';

describe('Customer-Ops organization entitlements client', () => {
  const orgId = '6e40af62-214d-4155-86f1-37dea8bcc53b';
  const env =
    (overrides: Record<string, string | undefined> = {}) =>
    (key: string) =>
      ({
        CUSTOMER_OPS_ENTITLEMENTS_ENABLED: 'true',
        UC_ENTITLEMENTS_URL: 'https://ops.example.test/api/v1/entitlements',
        ...overrides,
      })[key];

  afterEach(() => {
    clearOrgEntitlementCacheForTests();
    jest.restoreAllMocks();
  });

  it('arms only with the two new settings and uses the Customer-Ops feature key', () => {
    expect(customerOpsEntitlementsEnabled(env())).toBe(true);
    expect(
      customerOpsEntitlementsEnabled(env({ CUSTOMER_OPS_ENTITLEMENTS_ENABLED: 'false' })),
    ).toBe(false);
    expect(customerOpsEntitlementsEnabled(env({ UC_ENTITLEMENTS_URL: '' }))).toBe(false);
    expect(customerOpsEntitlementFeatureKey(env())).toBe('customer_ops_access');
    expect(
      customerOpsEntitlementFeatureKey(
        env({ CUSTOMER_OPS_ENTITLEMENT_FEATURE_KEY: 'custom_access' }),
      ),
    ).toBe('custom_access');
  });

  it('parses the measured response shape and allows the entitled org', async () => {
    const fetchImpl = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            org_id: orgId,
            tier: 'byok',
            role: 'owner',
            entitlements: ['customer_ops_access', 'ai-metered'],
            org_name: 'Lantern Harbor Advisory',
          }),
        }) as Response,
    );

    await expect(
      resolveOrgEntitlement('fixture-human-bearer', {
        subject: 'fixture-owner-sub',
        getEnv: env(),
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      outcome: 'allowed',
      allowed: true,
      entitled: true,
      orgId,
      tier: 'byok',
      role: 'owner',
      orgName: 'Lantern Harbor Advisory',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ops.example.test/api/v1/entitlements',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer fixture-human-bearer',
          Accept: 'application/json',
        },
      }),
    );
  });

  it('fails closed and logs endpoint errors without throwing', async () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const fetchImpl = jest.fn(async () => {
      throw new Error('fixture transport failure');
    });

    await expect(
      resolveOrgEntitlement('fixture-human-bearer', {
        subject: 'fixture-owner-sub',
        getEnv: env(),
        fetchImpl,
        logger,
      }),
    ).resolves.toMatchObject({ outcome: 'denied', allowed: false, entitled: false });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('caches bearer verdicts by subject and token hash for at most 60 seconds and token expiry', async () => {
    let now = 1_000_000;
    const fetchImpl = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ org_id: orgId, tier: 'byok', role: 'member', entitlements: [] }),
        }) as Response,
    );
    const options = {
      subject: 'fixture-member-sub',
      exp: 1_005,
      cache: true,
      getEnv: env(),
      fetchImpl,
      now: () => now,
    };

    await resolveOrgEntitlement('fixture-human-bearer', options);
    now += 4_000;
    await resolveOrgEntitlement('fixture-human-bearer', options);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 2_000;
    await resolveOrgEntitlement('fixture-human-bearer', options);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await resolveOrgEntitlement('fixture-human-bearer', { ...options, subject: 'other-sub' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not call the endpoint when unarmed', async () => {
    const fetchImpl = jest.fn();
    await expect(
      resolveOrgEntitlement('fixture-human-bearer', {
        subject: 'fixture-owner-sub',
        getEnv: env({ CUSTOMER_OPS_ENTITLEMENTS_ENABLED: 'false' }),
        fetchImpl,
      }),
    ).resolves.toMatchObject({ outcome: 'denied', allowed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
