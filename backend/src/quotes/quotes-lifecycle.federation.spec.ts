import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FEDERATION_MAX_RETRIES, QuotesLifecycleService } from './quotes-lifecycle.service';

/**
 * CuO-SW-1: an accepted quote whose Accounting-Ops fan-out (the invoice) fails
 * is recorded 'failed' AND re-run by reconcile(); once confirmed 'ok' it is never
 * called again, so the invoice is requested to completion exactly once.
 */

const WS = 'ws-1';
const QUOTE_ID = 'quote-1';

function build(opts: { aoResults: Array<'ok' | 'failed' | Error>; poConfigured?: boolean }) {
  const row: { id: string; status: string; federated: Record<string, unknown> } = {
    id: QUOTE_ID,
    status: 'accepted',
    federated: { status: 'pending' },
  };
  let failUpdate = false;
  const tx = {
    quoteVersion: { findMany: jest.fn().mockResolvedValue([]) },
    quote: {
      findFirst: jest.fn().mockResolvedValue({
        id: QUOTE_ID,
        number: 'Q-2026-0001',
        title: 'Website build',
        currency: 'USD',
        customerId: 'cust-1',
        versions: [
          {
            versionNo: 1,
            snapshot: null,
            acceptedSnapshot: {
              customer: { display_name: 'Example Co' },
              lines: [{ id: 'l1', kind: 'one_time', label: 'Build', amount_cents: 100000 }],
              totals: { one_time_cents: 100000 },
            },
          },
        ],
      }),
      findMany: jest
        .fn()
        .mockImplementation(async () =>
          row.status === 'accepted' &&
          (row.federated.accounting_ops === 'failed' || row.federated.project_ops === 'failed')
            ? [{ id: row.id, federated: row.federated }]
            : [],
        ),
      update: jest.fn().mockImplementation(async ({ data }: any) => {
        if (failUpdate) throw new Error('db down');
        row.federated = JSON.parse(JSON.stringify(data.federated));
        return row;
      }),
    },
  };
  const db = {
    workspace: { findMany: jest.fn().mockResolvedValue([{ id: WS }]) },
    withWorkspace: jest.fn((_ws: string, _uid: unknown, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const config = new ConfigService({
    QUOTES_ENABLED: 'true',
    ACCOUNTING_OPS_ENTITY_ID: 'entity-1',
    QUOTES_PUBLIC_BASE_URL: 'https://quotes.example.com',
  });
  const workspaces = {
    effectiveEntitlements: jest.fn().mockResolvedValue([]),
    workspaceEntitlements: jest.fn().mockResolvedValue([]),
  };
  const results = [...opts.aoResults];
  const accounting = {
    isConfigured: () => true,
    checkEntitlement: jest.fn((_ctx: { entitlements: string[] }) => ({ allowed: true })),
    acceptQuote: jest.fn().mockImplementation(async () => {
      const next = results.shift() ?? 'ok';
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  const projects = {
    isConfigured: () => opts.poConfigured ?? false,
    acceptQuote: jest.fn().mockResolvedValue('ok'),
  };
  const service = new QuotesLifecycleService(
    db as any,
    config,
    workspaces as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    accounting as any,
    projects as any,
  );
  const fanOut = () =>
    (service as any).federateAcceptedQuote({ id: 'user-1' }, WS, QUOTE_ID) as Promise<any>;
  return {
    service,
    row,
    accounting,
    workspaces,
    projects,
    fanOut,
    failUpdates: (v: boolean) => (failUpdate = v),
  };
}

/** Move the clock past the stored backoff so reconcile() treats the row as due. */
function pastBackoff(row: { federated: Record<string, unknown> }) {
  const due = Date.parse(String(row.federated.next_retry_at));
  jest.spyOn(Date, 'now').mockReturnValue(due + 1000);
}

describe('QuotesLifecycleService accepted-quote fan-out retry (CuO-SW-1)', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('a failed AO call is retried by reconcile and the invoice is created once', async () => {
    const { service, row, accounting, fanOut } = build({ aoResults: ['failed', 'ok'] });
    const first = await fanOut();
    expect(first.accounting_ops).toBe('failed');
    expect(row.federated.accounting_ops).toBe('failed');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('accounting_ops fan-out failed'));

    // Not due yet: the backoff holds the retry back.
    await service.reconcile();
    expect(accounting.acceptQuote).toHaveBeenCalledTimes(1);

    pastBackoff(row);
    await service.reconcile();
    expect(accounting.acceptQuote).toHaveBeenCalledTimes(2);
    expect(row.federated.accounting_ops).toBe('ok');
    expect(row.federated.retries).toBe(1);
    expect(row.federated.next_retry_at).toBeUndefined();

    // Confirmed 'ok': later reconciles never call AO again (no second invoice).
    await service.reconcile();
    await service.reconcile();
    expect(accounting.acceptQuote).toHaveBeenCalledTimes(2);
    const okCalls = await Promise.all(
      accounting.acceptQuote.mock.results.map((r: jest.MockResult<Promise<string>>) => r.value),
    );
    expect(okCalls.filter((v) => v === 'ok')).toHaveLength(1);
    // Same quote_ref (and line positions) on both calls: AO dedupes schedules on
    // (workspace_id, quote_ref, line_position).
    const keys = accounting.acceptQuote.mock.calls.map((c: any[]) => [c[1].quoteRef, c[1].version]);
    expect(keys).toEqual([
      ['Q-2026-0001', 1],
      ['Q-2026-0001', 1],
    ]);
  });

  it('a thrown AO call is recorded failed, and a PO side already ok is not re-run', async () => {
    const { service, row, accounting, projects, fanOut } = build({
      aoResults: [new Error('timeout'), 'ok'],
      poConfigured: true,
    });
    const first = await fanOut();
    expect(first).toMatchObject({ accounting_ops: 'failed', project_ops: 'ok' });
    expect(projects.acceptQuote).toHaveBeenCalledTimes(1);

    pastBackoff(row);
    await service.reconcile();
    expect(accounting.acceptQuote).toHaveBeenCalledTimes(2);
    expect(projects.acceptQuote).toHaveBeenCalledTimes(1);
    expect(row.federated).toMatchObject({ accounting_ops: 'ok', project_ops: 'ok' });
  });

  it('a failed status write is logged, not swallowed', async () => {
    const { fanOut, failUpdates } = build({ aoResults: ['ok'] });
    failUpdates(true);
    const result = await fanOut();
    expect(result.accounting_ops).toBe('ok');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('federated status write failed'));
  });

  it('stops retrying after FEDERATION_MAX_RETRIES and says so once', async () => {
    const { service, row, accounting, fanOut } = build({
      aoResults: Array(FEDERATION_MAX_RETRIES + 5).fill('failed'),
    });
    await fanOut();
    for (let i = 0; i < FEDERATION_MAX_RETRIES + 3; i++) {
      pastBackoff(row);
      await service.reconcile();
    }
    expect(accounting.acceptQuote).toHaveBeenCalledTimes(FEDERATION_MAX_RETRIES + 1);
    expect(row.federated.retries).toBe(FEDERATION_MAX_RETRIES);
    const capLogs = error.mock.calls.filter((c) => String(c[0]).includes('will not retry'));
    expect(capLogs).toHaveLength(1);
  });

  describe('retry entitlements (CUO76-R2-2)', () => {
    /** First call (with a user) fails; the retry gate then sees only the cache. */
    async function failThenRetry(cache: string[] | null) {
      const t = build({ aoResults: ['failed', 'ok'] });
      await t.fanOut();
      expect(t.row.federated.accounting_ops).toBe('failed');
      t.workspaces.workspaceEntitlements.mockResolvedValue(cache);
      t.accounting.checkEntitlement.mockImplementation((ctx) => ({
        allowed: ctx.entitlements.includes('accounting-ops'),
      }));
      pastBackoff(t.row);
      await t.service.reconcile();
      return t;
    }

    it.each([
      ['a null cache', null],
      ['an empty cache', []],
    ])(
      '%s leaves the side failed, logged at error, and a later retry still runs',
      async (_l, cache) => {
        const t = await failThenRetry(cache);
        expect(t.accounting.acceptQuote).toHaveBeenCalledTimes(1);
        expect(t.row.federated.accounting_ops).toBe('failed');
        expect(t.row.federated.next_retry_at).toBeDefined();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('entitlements are unknown'));

        // The cache is back: the next due reconcile creates the invoice once.
        t.workspaces.workspaceEntitlements.mockResolvedValue(['customer-ops', 'accounting-ops']);
        pastBackoff(t.row);
        await t.service.reconcile();
        expect(t.accounting.acceptQuote).toHaveBeenCalledTimes(2);
        expect(t.row.federated.accounting_ops).toBe('ok');
      },
    );

    it('a known entitlement list without Accounting-Ops stamps skipped, logged', async () => {
      const t = await failThenRetry(['customer-ops']);
      expect(t.accounting.acceptQuote).toHaveBeenCalledTimes(1);
      expect(t.row.federated.accounting_ops).toBe('skipped');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not entitled to Accounting-Ops'));
    });
  });
});
