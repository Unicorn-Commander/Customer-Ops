import { AccountingOpsClient } from '../accounting-ops/accounting-ops.client';
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
      new AccountingOpsClient({
        get: (k: string) =>
          (
            ({
              AO_BASE_URL: 'https://accounting.example.invalid',
              AO_SERVICE_TOKEN: 'fixture-only',
              ...config,
            }) as any
          )[k],
      } as any,
      brigade,
      { resolveSync: () => 'ao-ws' } as any),
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
  it('uses the shared client with read-only STS and the mapped workspace', async () => {
    const exchangedToken = jest.fn().mockResolvedValue('fixture-only');
    global.fetch = jest.fn().mockResolvedValue(new Response('[]'));
    await service({ accountingEntityId: 'entity' }, { AO_AUTH_MODE: 'brigade-sts' }, { exchangedToken }).letterhead('ws');
    expect(exchangedToken).toHaveBeenCalledWith({ audience: 'accounting-ops', scope: 'invoices:read', workspaceId: 'ao-ws' });
    expect(global.fetch).toHaveBeenCalledWith('https://accounting.example.invalid/api/workspaces/ao-ws/entities', expect.objectContaining({ headers: expect.objectContaining({ 'X-Workspace-Id': 'ao-ws' }), redirect: 'error' }));
  });
  it('does not fetch when the shared client is unconfigured', async () => {
    global.fetch = jest.fn();
    await service({ accountingEntityId: 'entity' }, { AO_BASE_URL: '' }).letterhead('ws');
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('fails closed before fetching when the shared exchange fails', async () => {
    global.fetch = jest.fn();
    const result = await service({ accountingEntityId: 'entity' }, { AO_AUTH_MODE: 'brigade-sts' }, { exchangedToken: jest.fn().mockResolvedValue(null) }).letterhead('ws');
    expect(result.degradations).toContain('vendor_details_unavailable');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
