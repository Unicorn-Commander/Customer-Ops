/**
 * M365GraphClient — the Microsoft Graph transport for the connector.
 *
 * Mirrors ContactOpsClient's transport discipline (a `fetchWithTimeout`, bounded
 * retries, structured logging that NEVER prints a token), specialized for Graph:
 *
 *   • TOKEN: decrypt the stored refresh token → MSAL `acquireTokenByRefreshToken`
 *     → use the fresh access token. The (possibly rotated) refresh token is
 *     persisted back via the store. An `invalid_grant` from Microsoft means the
 *     user revoked / the token aged out → the connection is marked REVOKED and a
 *     typed M365AuthRevokedError is thrown (the sync service surfaces it cleanly).
 *
 *   • PAGING: follow `@odata.nextLink` until exhausted; persist `@odata.deltaLink`
 *     for the next incremental sync. `$top` caps the page size.
 *
 *   • THROTTLING: on 429 / 503 read `Retry-After`, sleep, exponential backoff,
 *     capped at ~5 retries; the page walk is SEQUENTIAL (no fan-out) so we never
 *     amplify load against a throttling tenant.
 *
 * v1 reads CONTACTS only; listMessages/listEvents are the same shape later.
 */

import { Injectable, Logger } from '@nestjs/common';
import { M365Connection } from '@prisma/client';
import { M365Config } from '../m365.config';
import { TokenCipher } from '../crypto/token-cipher';
import { MsalClientFactory } from '../oauth/msal-client.factory';
import { M365ConnectionStore } from '../store/m365-connection.store';
import { GraphContact, GraphContactPage } from '../m365.types';

/** Thrown when Microsoft reports the refresh token no longer grants. The caller
 *  marks the connection REVOKED and stops — re-consent is the only recovery. */
export class M365AuthRevokedError extends Error {
  constructor(message = 'Microsoft 365 refresh token no longer grants (re-consent required)') {
    super(message);
    this.name = 'M365AuthRevokedError';
  }
}

const MAX_RETRIES = 5;
const MAX_PAGES = 1000; // hard stop so a pathological nextLink loop can't run forever.

@Injectable()
export class M365GraphClient {
  private readonly logger = new Logger(M365GraphClient.name);

  constructor(
    private readonly config: M365Config,
    private readonly cipher: TokenCipher,
    private readonly msal: MsalClientFactory,
    private readonly store: M365ConnectionStore,
  ) {}

  /**
   * A valid access token for the connection: decrypt the refresh token, exchange
   * it via MSAL, and persist the rotated refresh token + the fresh access token.
   * Throws M365AuthRevokedError on invalid_grant (after marking the row REVOKED).
   */
  async getAccessToken(connection: M365Connection): Promise<string> {
    let refreshToken: string;
    try {
      refreshToken = this.cipher.decrypt(connection.refreshTokenEnc);
    } catch (err) {
      // A blob we can't decrypt is unusable — treat it as a revoked link, not a
      // 500. (Never log the blob.)
      this.logger.warn(`M365 refresh token for connection ${connection.id} failed to decrypt`);
      await this.store.markRevoked(connection.userId, connection.id);
      throw new M365AuthRevokedError(
        'Stored Microsoft 365 token is unreadable; reconnect required',
      );
    }

    let result;
    try {
      result = await this.msal.acquireTokenByRefreshToken(refreshToken);
    } catch (err) {
      const msg = (err as Error).message || '';
      if (/invalid_grant|AADSTS70000|AADSTS50173|AADSTS700082/i.test(msg)) {
        this.logger.warn(`M365 connection ${connection.id} revoked by Microsoft (invalid_grant)`);
        await this.store.markRevoked(connection.userId, connection.id);
        throw new M365AuthRevokedError();
      }
      throw err; // transient/other → bubble so the sync records ERROR (retryable).
    }

    if (!result.accessToken) {
      throw new Error('MSAL refresh returned no access token');
    }

    // Persist the rotated refresh token + fresh access token (never logged).
    await this.store.updateTokens(connection.userId, connection.id, {
      refreshTokenEnc: result.refreshToken ? this.cipher.encrypt(result.refreshToken) : undefined,
      accessTokenEnc: this.cipher.encrypt(result.accessToken),
      accessTokenExpires: result.expiresOn ?? null,
    });

    return result.accessToken;
  }

  /**
   * Enumerate the user's contacts. Delta-aware: when the connection has a stored
   * `deltaLinkContacts` we replay it (only changes come back); otherwise we do a
   * full enumerate from `/me/contacts/delta`, which returns a deltaLink to persist.
   * Walks every `@odata.nextLink` page sequentially. Returns all contacts seen +
   * the new deltaLink (to store for next time).
   */
  async listContacts(connection: M365Connection): Promise<GraphContactPage> {
    const accessToken = await this.getAccessToken(connection);
    const select =
      'id,displayName,givenName,surname,companyName,emailAddresses,mobilePhone,businessPhones,personalNotes';

    // Replay the stored delta link, else start a fresh delta enumeration.
    let url =
      connection.deltaLinkContacts ??
      `${this.config.graphBaseUrl}/me/contacts/delta?$select=${encodeURIComponent(select)}&$top=${this.config.pageSize}`;

    const contacts: GraphContact[] = [];
    let deltaLink: string | null = null;
    let pages = 0;

    while (url && pages < MAX_PAGES) {
      const body = await this.getJson(url, accessToken);
      const items = Array.isArray(body['value']) ? (body['value'] as GraphContact[]) : [];
      for (const c of items) contacts.push(c);

      const next = body['@odata.nextLink'];
      const delta = body['@odata.deltaLink'];
      if (typeof delta === 'string' && delta) deltaLink = delta;
      url = typeof next === 'string' && next ? next : '';
      pages += 1;
    }

    return { contacts, nextLink: null, deltaLink };
  }

  // ── transport ──────────────────────────────────────────────────────────────

  /**
   * GET a Graph URL with the bearer, honoring 429/503 Retry-After with capped
   * exponential backoff. Returns the parsed JSON body. Throws on a non-retryable
   * non-2xx (the sync records ERROR) — but a 401 mid-walk is surfaced as a
   * revoke (the access token shouldn't expire mid-page, but be defensive).
   */
  private async getJson(url: string, accessToken: string): Promise<Record<string, unknown>> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });

      if (res.ok) {
        return (await res.json()) as Record<string, unknown>;
      }

      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
        const wait = this.retryDelayMs(res, attempt);
        this.logger.warn(
          `Graph ${res.status} — backing off ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await this.sleep(wait);
        attempt += 1;
        continue;
      }

      if (res.status === 401) {
        throw new M365AuthRevokedError('Microsoft 365 access token was rejected mid-sync');
      }

      // Drain a short body for the log, never assume it's a token.
      const detail = await this.shortBody(res);
      throw new Error(`Graph request failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
    }
  }

  /** Retry delay: prefer the server's Retry-After (seconds), else exponential
   *  backoff (1s, 2s, 4s, …) capped at 30s. */
  private retryDelayMs(res: Response, attempt: number): number {
    const header = res.headers?.get?.('retry-after');
    if (header) {
      const secs = Number(header);
      if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
    }
    return Math.min(1000 * 2 ** attempt, 30_000);
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** A short, safe snippet of an error body for logs (never a token; Graph error
   *  bodies are `{error:{code,message}}`, which carry no credential). */
  private async shortBody(res: Response): Promise<string> {
    try {
      const text = await res.text();
      return text.slice(0, 200).replace(/\s+/g, ' ').trim();
    } catch {
      return '';
    }
  }
}
