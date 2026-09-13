import { QuotePresentationService } from './quote-presentation.service';

describe('Federated letterhead (no legal cache)', () => {
  const original = global.fetch;
  afterEach(() => (global.fetch = original));
  function service(setting: any, config: Record<string, string> = {}, brigade: any = {}) {
    return new QuotePresentationService(
      {
        withWorkspace: async (_w: any, _u: any, fn: any) =>
          fn({ workspaceLetterhead: { findUnique: async () => setting } }),
      } as any,
      {
        get: (k: string) =>
          (
            ({
              ACCOUNTING_OPS_BASE_URL: 'https://accounting.example.invalid',
              ACCOUNTING_OPS_SERVICE_TOKEN: 'fixture-only',
              ...config,
            }) as any
          )[k],
      } as any,
      brigade,
      { resolveSync: () => null } as any,
      {
        getContact: async () => ({ displayName: 'Synthetic recipient', currentOrgName: null }),
      } as any,
    );
  }
  it('blocks send without an entity pointer before any remote read', async () => {
    global.fetch = jest.fn();
    await expect(service(null).forSend('ws', 'contact')).rejects.toThrow('Link an available');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('serves a fresh placeholder on a failed entity read, never prior legal data', async () => {
    global.fetch = jest.fn().mockRejectedValue(Error('offline'));
    expect(await service({ accountingEntityId: 'entity' }).letterhead('ws')).toMatchObject({
      letterhead: { legal_name: 'Vendor details unavailable' },
      degradations: ['vendor_details_unavailable'],
    });
  });
  it('reads only the selected active entity, and keeps legal data out of the snapshot input', async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify([
            { id: 'other', legal_name: 'Other entity', status: 'active' },
            { id: 'entity', legal_name: 'Synthetic legal entity', status: 'active' },
          ]),
          { status: 200 },
        ),
    );
    const s = service({ accountingEntityId: 'entity' });
    expect(await s.letterhead('ws')).toMatchObject({
      letterhead: { legal_name: 'Synthetic legal entity' },
      degradations: expect.arrayContaining(['registered_address_unavailable']),
    });
    expect((await s.forSend('ws', 'contact')).letterhead).toEqual({
      legal_name: '',
      address_lines: [],
    });
  });
  it.each([
    [undefined, 'invoices:read'],
    ['  invoices:read custom:read  ', 'invoices:read custom:read'],
    ['   ', 'invoices:read'],
  ])('uses the configured Accounting-Ops scope (%s)', async (scope, expected) => {
    const exchangedToken = jest.fn().mockResolvedValue('fixture-only');
    global.fetch = jest.fn().mockResolvedValue(new Response('[]'));
    await service(
      { accountingEntityId: 'entity' },
      { ACCOUNTING_OPS_AUTH_MODE: 'brigade-sts', ...(scope === undefined ? {} : { ACCOUNTING_OPS_SCOPE: scope }) },
      { exchangedToken },
    ).letterhead('ws');
    expect(exchangedToken).toHaveBeenCalledWith({
      audience: 'accounting-ops-app', scope: expected, workspaceId: 'ws',
    });
  });

});
