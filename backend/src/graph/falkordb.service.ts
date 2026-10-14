/**
 * The FalkorDB connection lifecycle — the graph plane's transport.
 *
 * Holds the single shared `falkordb` client for the process and hands out
 * per-workspace graph handles. Mirrors PrismaService (OnModuleInit/OnModuleDestroy
 * connect/close) for the lifecycle, and the federation clients' DEGRADE-CLEAN
 * contract for the optionality:
 *
 *   DEGRADE-CLEAN (CRITICAL): when FALKORDB_URL is UNSET the service is DORMANT —
 *   it logs ONE warning at boot, never connects, and `isConfigured` is false. It
 *   does NOT throw at startup and MUST NOT crash the app, exactly like
 *   ContactOps/MeetingOps/AccountingOps when their *_BASE_URL is unset. Graph
 *   callers check `isConfigured` (or catch the ServiceUnavailableException from
 *   `graph()`) and fall back to the DB-only relationship view. This keeps
 *   Customer-Ops fully functional on any node where the graph isn't wired
 *   (Phase-0/1 dogfood, verification, an air-gapped overlay).
 *
 * SECURITY: FALKORDB_URL may carry a password (redis://:<pw>@host). It is NEVER
 * logged — only the redacted host:port is ever emitted.
 *
 * The `falkordb` client wraps node-redis, so connect() accepts a `url` string and
 * `socket.reconnectStrategy` (node-redis form: false | ms | (retries,cause)=>…).
 * API confirmed against FalkorDB/falkordb-ts + node-falkordb client-configuration
 * docs: FalkorDB.connect({ url, socket }) → db; db.selectGraph(key) → graph;
 * graph.query / graph.roQuery(cypher, { params }); db.close().
 */

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FalkorDB, Graph } from 'falkordb';
import type { FalkorDBOptions } from 'falkordb/dist/src/falkordb';

/**
 * node-redis' socket reconnect strategy. The `falkordb` v6.6.2 `SocketOptions`
 * type OMITS `reconnectStrategy` (the property is documented in its JSDoc but
 * dropped from the exported type), yet the value IS forwarded to the underlying
 * node-redis client at runtime. We type it ourselves and attach it via this
 * narrow shape so the strategy is real (per the brief) without an opaque cast.
 */
type ReconnectStrategy =
  | false
  | number
  | ((retries: number, cause: Error) => false | number | Error);
type ConnectOptionsWithReconnect = FalkorDBOptions & {
  socket?: FalkorDBOptions['socket'] & { reconnectStrategy?: ReconnectStrategy };
};

@Injectable()
export class FalkorDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FalkorDbService.name);

  /** The shared client. null === DORMANT (FALKORDB_URL unset) or not-yet-connected. */
  private db: FalkorDB | null = null;

  /** True once a FALKORDB_URL is present AND the initial connect resolved. */
  private connected = false;

  constructor(private readonly config: ConfigService) {}

  // ── lifecycle ───────────────────────────────────────────────────────────

  /**
   * Connect at module init when FALKORDB_URL is set. Unset → stay dormant (warn,
   * no connect, no throw). A connect FAILURE is logged but NOT re-thrown: the app
   * still boots and the graph degrades to DB-only — a graph outage must never take
   * Customer-Ops down. (`graph()` then throws ServiceUnavailableException per
   * call, which callers treat as "fall back to DB".)
   */
  async onModuleInit(): Promise<void> {
    const url = this.url;
    if (!url) {
      this.logger.warn(
        'FALKORDB_URL unset — the knowledge graph is DORMANT (DB-only fallback). ' +
          'Set FALKORDB_URL (e.g. redis://unicorn-falkordb:6379) to enable it.',
      );
      return;
    }

    try {
      const options: ConnectOptionsWithReconnect = {
        url,
        socket: {
          // node-redis reconnect strategy: exponential-ish backoff capped at 2s,
          // and GIVE UP after ~10 attempts so a permanently-down FalkorDB doesn't
          // wedge the process reconnecting forever. Returning an Error here stops
          // retrying; subsequent graph() calls surface ServiceUnavailable and the
          // caller falls back to DB-only.
          reconnectStrategy: (retries: number) => {
            if (retries > 10) {
              return new Error('FalkorDB unreachable after 10 reconnect attempts');
            }
            return Math.min(retries * 100, 2000);
          },
        },
      };
      this.db = await FalkorDB.connect(options);
      this.connected = true;
      this.logger.log(`FalkorDB connected (${this.redactedTarget(url)})`);
    } catch (err) {
      // Degrade-clean: do NOT re-throw. Boot continues; graph is dormant.
      this.db = null;
      this.connected = false;
      this.logger.error(
        `FalkorDB connect failed (${this.redactedTarget(url)}) — graph DORMANT, ` +
          `DB-only fallback: ${(err as Error).message}`,
      );
    }
  }

  /** Close the client on shutdown (best-effort; a close error is logged, not thrown). */
  async onModuleDestroy(): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.close();
      this.logger.log('FalkorDB connection closed');
    } catch (err) {
      this.logger.warn(`FalkorDB close error: ${(err as Error).message}`);
    } finally {
      this.db = null;
      this.connected = false;
    }
  }

  // ── public surface ────────────────────────────────────────────────────────

  /**
   * Whether the graph is wired (FALKORDB_URL set AND the initial connect
   * succeeded). The degrade-clean signal callers branch on — `false` means use the
   * DB-only relationship view, identical to the federation clients' isConfigured.
   */
  get isConfigured(): boolean {
    return this.connected && this.db !== null;
  }

  /**
   * Resolve a per-workspace graph handle by its key. The key MUST come from
   * `graphKeyFor(workspaceId)` (the tenancy chokepoint) — this method does not
   * build keys, it only selects.
   *
   * @throws ServiceUnavailableException when dormant (FALKORDB_URL unset or the
   *   connect failed). Callers either pre-check `isConfigured` or catch this and
   *   fall back to DB-only — graph being down is never a hard error for the app.
   */
  graph(key: string): Graph {
    if (!this.db || !this.connected) {
      throw new ServiceUnavailableException(
        'Knowledge graph is not available (FalkorDB dormant). The relationship ' +
          'cockpit falls back to the DB-only view.',
      );
    }
    return this.db.selectGraph(key);
  }

  // ── config seam ─────────────────────────────────────────────────────────

  /** The configured FalkorDB connection URL, or null when unset/blank (dormant). */
  private get url(): string | null {
    const raw = this.config.get<string>('FALKORDB_URL');
    return raw && raw.trim() ? raw.trim() : null;
  }

  /**
   * Redact any password from a redis URL for safe logging — emits only
   * `redis://host:port`. NEVER log the raw URL (it may carry credentials). On a
   * parse failure, emit a constant placeholder rather than risk leaking the value.
   */
  private redactedTarget(url: string): string {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
    } catch {
      return '<falkordb>';
    }
  }
}
