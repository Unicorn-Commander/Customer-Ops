import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * The subset of PrismaClient passed into a withWorkspace() callback: a
 * transaction-scoped client. It is the same surface as `prisma.$transaction`'s
 * interactive-transaction argument, so callers use it exactly like `this.prisma`.
 */
export type WorkspaceTxClient = Prisma.TransactionClient;

/** Default per-statement timeout (ms). Bounds a runaway query so one bad plan
 *  can't pin a pooled connection indefinitely. 0 disables it. Tunable via
 *  DB_STATEMENT_TIMEOUT_MS. */
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /** Per-statement timeout applied inside every workspace tx (ms; 0 = disabled). */
  private readonly statementTimeoutMs: number;

  /**
   * @param options optional explicit PrismaClient options (e.g. an integration
   *   test pointing the datasource at a throwaway DB). When omitted, the client
   *   is built from env: the datasource url is augmented with the pool-sizing
   *   query params (DB_POOL_SIZE / DB_POOL_TIMEOUT_SECONDS) when set.
   */
  constructor(options?: Prisma.PrismaClientOptions) {
    super(options ?? PrismaService.clientOptions());
    this.statementTimeoutMs = PrismaService.resolveStatementTimeoutMs();
  }

  /**
   * Build the PrismaClient options. Pool sizing is expressed via the DATABASE_URL
   * query params Prisma understands (`connection_limit`, `pool_timeout`); we
   * append them from env ONLY when set, so an unset deploy keeps Prisma's
   * defaults (num_cpus*2+1 connections). Overriding the datasource url lets an
   * operator right-size the pool for the box without editing the URL by hand.
   */
  private static clientOptions(): Prisma.PrismaClientOptions | undefined {
    const url = PrismaService.pooledDatabaseUrl();
    return url ? { datasources: { db: { url } } } : undefined;
  }

  /** Append `connection_limit` / `pool_timeout` to DATABASE_URL from env, or
   *  return undefined to leave the schema datasource (and Prisma defaults) as-is. */
  private static pooledDatabaseUrl(): string | undefined {
    const base = process.env.DATABASE_URL;
    if (!base) return undefined;
    const poolSize = PrismaService.positiveInt(process.env.DB_POOL_SIZE);
    const poolTimeout = PrismaService.positiveInt(process.env.DB_POOL_TIMEOUT_SECONDS);
    if (poolSize === undefined && poolTimeout === undefined) return undefined;
    try {
      const u = new URL(base);
      if (poolSize !== undefined) u.searchParams.set('connection_limit', String(poolSize));
      if (poolTimeout !== undefined) u.searchParams.set('pool_timeout', String(poolTimeout));
      return u.toString();
    } catch {
      // A non-URL DATABASE_URL (shouldn't happen) — don't rewrite; let Prisma read
      // the schema datasource unchanged.
      return undefined;
    }
  }

  private static resolveStatementTimeoutMs(): number {
    const raw = process.env.DB_STATEMENT_TIMEOUT_MS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_STATEMENT_TIMEOUT_MS;
    const n = Number(raw);
    // 0 is meaningful (disable); negatives / NaN fall back to the default.
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_STATEMENT_TIMEOUT_MS;
  }

  private static positiveInt(raw: string | undefined): number | undefined {
    if (raw === undefined || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected successfully');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }

  /**
   * Run `fn` inside a transaction with the per-request tenancy GUCs set, so
   * Postgres Row Level Security scopes every query to `workspaceId`.
   *
   * This is the GUC chokepoint of the suite tenancy model (SUITE-IDENTITY §6).
   * It opens an interactive `$transaction`, bounds every statement with a
   * `SET LOCAL statement_timeout` (best-effort reliability guard), sets the two
   * session GUCs with `is_local = true` (== `SET LOCAL`, so they reset
   * automatically at COMMIT/ROLLBACK and can never leak onto a pooled
   * connection's next checkout), then invokes `fn` with the transaction client.
   * All reads/writes inside `fn` MUST go through the passed `tx`, not `this`, or
   * they bypass the GUC.
   *
   *   await prisma.withWorkspace(workspaceId, ucUid, (tx) =>
   *     tx.customer.findMany());
   *
   * NOTE on read-only requests: RLS needs the tenancy GUC, and a GUC set with
   * `SET LOCAL` is only safe on a pooled connection inside a transaction (a
   * session-level SET would leak onto the next checkout). So a pure read still
   * needs a transaction to carry the GUC — it cannot be dropped without giving
   * up connection pooling. `withWorkspaceReadOnly` is the lighter path: same GUC,
   * but the transaction is marked `READ ONLY` (Postgres rejects an accidental
   * write and can skip write-side bookkeeping).
   *
   * ROLLOUT NOTE (Phase 1): RLS is created-but-inert because the running app
   * still connects as the table owner (which is BYPASSRLS). This method is the
   * forward-compatible write path — mandatory once the runtime DATABASE_URL is
   * flipped to the NOBYPASSRLS `customer_ops_app` role. Setting the GUCs now is
   * harmless and correct under the owner connection (the policy simply isn't
   * enforced yet), so callers can adopt it incrementally without a behavior
   * change.
   *
   * @param workspaceId resolved canonical workspace id (uc-registry uuidv7).
   * @param ucUid       acting user's uchub `sub` (for `app.uc_uid` attribution);
   *                    pass '' / null when unknown (e.g. system jobs).
   * @param fn          handler receiving the transaction-scoped Prisma client.
   * @param options     optional Prisma interactive-transaction options.
   */
  async withWorkspace<T>(
    workspaceId: string,
    ucUid: string | null | undefined,
    fn: (tx: WorkspaceTxClient) => Promise<T>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    },
  ): Promise<T> {
    return this.runWithWorkspace(workspaceId, ucUid, fn, false, options);
  }

  /**
   * Read-only variant of withWorkspace. Identical tenancy semantics (same RLS
   * GUC), but the transaction is marked `READ ONLY` so Postgres rejects any
   * accidental write from a read path. Use on pure-read request handlers (the
   * pipeline board, lists, the customer-360 reads).
   */
  async withWorkspaceReadOnly<T>(
    workspaceId: string,
    ucUid: string | null | undefined,
    fn: (tx: WorkspaceTxClient) => Promise<T>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    },
  ): Promise<T> {
    return this.runWithWorkspace(workspaceId, ucUid, fn, true, options);
  }

  private async runWithWorkspace<T>(
    workspaceId: string,
    ucUid: string | null | undefined,
    fn: (tx: WorkspaceTxClient) => Promise<T>,
    readOnly: boolean,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    },
  ): Promise<T> {
    if (!workspaceId || !workspaceId.trim()) {
      // Fail closed: an empty workspace id would set the GUC to '' (==NULL via
      // current_workspace_id()) and, under live RLS, expose zero rows while
      // silently succeeding. Surfacing it as an error here makes the
      // misconfiguration loud instead of a confusing empty result set.
      throw new Error('withWorkspace requires a non-empty workspaceId');
    }

    return this.$transaction(async (tx) => {
      // READ ONLY must precede the first snapshot-taking query, so issue it first.
      if (readOnly) {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      }
      // Bound every statement in this tx (best-effort; 0 => skip). set_config with
      // a text value is the parameterized, injection-safe form of SET LOCAL.
      if (this.statementTimeoutMs > 0) {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(this.statementTimeoutMs)}, true)`;
      }
      // set_config(setting, value, is_local) — is_local=true => SET LOCAL,
      // scoped to this transaction only. Parameterized to prevent injection.
      await tx.$executeRaw`SELECT set_config('app.current_workspace', ${workspaceId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.uc_uid', ${ucUid ?? ''}, true)`;
      return fn(tx);
    }, options);
  }
}
