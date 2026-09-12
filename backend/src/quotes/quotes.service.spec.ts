import { QuotesService } from './quotes.service';
import { WorkspaceRole } from '@prisma/client';
describe('Quotes service entry gates', () => {
  const user = {} as any;
  afterEach(() => delete process.env.CUSTOMER_OPS_TENANCY_ENABLED);
  it('disabled by default before any membership or DB access', async () => {
    const resolveAuthorized = jest.fn(),
      withWorkspace = jest.fn();
    const s = new QuotesService(
      { withWorkspace } as any,
      { get: () => undefined } as any,
      { resolveAuthorized } as any,
      {} as any,
    );
    await expect(s.execute(user, null, 'list_quotes')).rejects.toThrow('not enabled');
    expect(resolveAuthorized).not.toHaveBeenCalled();
    expect(withWorkspace).not.toHaveBeenCalled();
  });
  it('membership denial never reaches the DB', async () => {
    const withWorkspace = jest.fn();
    const s = new QuotesService(
      { withWorkspace } as any,
      { get: () => '1' } as any,
      {
        resolveAuthorized: async () => {
          throw Error('nonmember');
        },
      } as any,
      {} as any,
    );
    await expect(s.execute(user, 'other', 'get_quote')).rejects.toThrow('nonmember');
    expect(withWorkspace).not.toHaveBeenCalled();
  });
  it('viewers cannot mutate through the service even outside controllers', async () => {
    process.env.CUSTOMER_OPS_TENANCY_ENABLED = 'true';
    const withWorkspace = jest.fn();
    const s = new QuotesService(
      { withWorkspace } as any,
      { get: () => '1' } as any,
      { resolveAuthorized: async () => 'ws' } as any,
      { roleInWorkspace: async () => WorkspaceRole.VIEWER } as any,
    );
    await expect(s.execute(user, 'ws', 'create_quote')).rejects.toThrow('member role');
    expect(withWorkspace).not.toHaveBeenCalled();
  });
});
