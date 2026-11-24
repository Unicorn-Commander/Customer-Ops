import { Logger } from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';

/**
 * CuO-SW-2: a failed uc-registry registration during provisioning is never
 * retried (a replay adopts the existing mirror row), so the WARN must say so
 * and say how to re-run it, instead of promising a reconcile.
 */
describe('ProvisioningService registry registration WARN', () => {
  const input = {
    orgId: '0190a000-7e57-7000-8000-00000000c0de',
    slugs: ['example-org'],
    displayName: 'Example Org',
    ownerSubject: 'kc-owner',
  };
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const make = (mint: jest.Mock) =>
    new ProvisioningService({} as any, {} as any, { mintWorkspaceId: mint } as any, {} as any);

  it('a local-fallback registration WARNs that it is NOT retried and how to re-run', async () => {
    const svc = make(
      jest.fn().mockResolvedValue({ workspaceId: input.orgId, source: 'local-fallback' }),
    );
    await (svc as any).register(input);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain(input.orgId);
    expect(msg).toContain('NOT retried');
    expect(msg).toContain('POST /workspaces');
  });

  it('a thrown registration WARNs the same way', async () => {
    const svc = make(jest.fn().mockRejectedValue(new TypeError('boom')));
    await (svc as any).register(input);
    expect(String(warn.mock.calls[0]?.[0])).toContain('NOT retried');
  });

  it('a confirmed registration does not WARN', async () => {
    const svc = make(
      jest.fn().mockResolvedValue({ workspaceId: input.orgId, source: 'uc-registry' }),
    );
    await (svc as any).register(input);
    expect(warn).not.toHaveBeenCalled();
  });
});
