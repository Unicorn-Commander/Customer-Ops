import { PrismaService } from './prisma.service';

/**
 * withWorkspace is the GUC chokepoint (SUITE-IDENTITY §6). These tests pin the
 * contract without a live DB: it opens an interactive $transaction, sets BOTH
 * tenancy GUCs with is_local=true (SET LOCAL) via parameterized $executeRaw,
 * runs the handler on the transaction client, and fails closed on an empty
 * workspace id. The parameterization (tagged-template $executeRaw) is what makes
 * the GUC injection-safe.
 */
describe('PrismaService.withWorkspace', () => {
  function makeService() {
    const svc = Object.create(PrismaService.prototype) as PrismaService;

    const executed: Array<{ strings: TemplateStringsArray; values: unknown[] }> = [];
    const tx = {
      $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        executed.push({ strings, values });
        return Promise.resolve(1);
      }),
      customer: { findMany: jest.fn().mockResolvedValue([{ id: 'c1' }]) },
    };

    // $transaction(fn, options) -> invoke fn with our tx (interactive form).
    (svc as any).$transaction = jest.fn((fn: any) => fn(tx));

    return { svc, tx, executed };
  }

  it('opens a transaction, sets both GUCs (SET LOCAL), and runs fn on the tx', async () => {
    const { svc, tx, executed } = makeService();

    const result = await svc.withWorkspace('W-123', 'uc-uid-abc', (t: any) =>
      t.customer.findMany(),
    );

    expect((svc as any).$transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: 'c1' }]);
    expect(tx.customer.findMany).toHaveBeenCalledTimes(1);

    // Two set_config calls: app.current_workspace then app.uc_uid.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);

    const sql0 = executed[0].strings.join('?');
    const sql1 = executed[1].strings.join('?');
    expect(sql0).toContain("set_config('app.current_workspace'");
    expect(sql0).toContain('true'); // is_local = true => SET LOCAL
    expect(executed[0].values).toEqual(['W-123']); // parameterized, not interpolated

    expect(sql1).toContain("set_config('app.uc_uid'");
    expect(executed[1].values).toEqual(['uc-uid-abc']);
  });

  it('passes an empty string for a null ucUid (attribution optional)', async () => {
    const { svc, executed } = makeService();
    await svc.withWorkspace('W-123', null, async () => 'ok');
    expect(executed[1].values).toEqual(['']);
  });

  it('fails closed on an empty workspaceId (never silently scopes to NULL)', async () => {
    const { svc } = makeService();
    await expect(svc.withWorkspace('', 'uid', async () => 'x')).rejects.toThrow(
      /non-empty workspaceId/,
    );
    await expect(svc.withWorkspace('   ', 'uid', async () => 'x')).rejects.toThrow(
      /non-empty workspaceId/,
    );
    // $transaction must not even be entered when the id is empty.
    expect((svc as any).$transaction).not.toHaveBeenCalled();
  });
});
