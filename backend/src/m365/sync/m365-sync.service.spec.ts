import { M365Connection, M365ConnectionStatus, User } from '@prisma/client';
import { LeadIntakeService } from '../../lead-intake/lead-intake.service';
import { M365ConnectionStore } from '../store/m365-connection.store';
import { M365GraphClient, M365AuthRevokedError } from '../graph/m365-graph.client';
import { M365SyncService, M365_SOURCE } from './m365-sync.service';
import { GraphContact } from '../m365.types';
import { createHash } from 'crypto';

/**
 * M365SyncService — THE LOAD-BEARING TEST. The connector's only job is to turn a
 * Graph contact into a well-formed IngestLeadDto and push it through the EXISTING
 * lead-intake funnel. These pin:
 *   • the EXACT DTO mapping (source, the sanitized slug dedup key, every field),
 *   • that it calls LeadIntakeService.ingestForUser with the connection's workspace,
 *   • idempotency (the dedup key is a stable hash of the Graph id, not the email),
 *   • delta-cursor persistence + revoke/error handling,
 *   • that one bad contact doesn't abort the batch.
 * LeadIntakeService + the Graph client + the store are all MOCKED (no DB, no MSAL,
 * no network).
 */
const USER = { id: 'user-aaron', keycloakId: 'kc-aaron' } as User;
const WS = '0190a000-7e57-7000-8000-00000000c007';

function makeConnection(over: Partial<M365Connection> = {}): M365Connection {
  return {
    id: 'm365-1',
    userId: USER.id,
    workspaceId: WS,
    m365UserId: 'graph-user-1',
    m365UserPrincipal: 'aaron@contoso.com',
    scopes: ['offline_access', 'Contacts.Read'],
    refreshTokenEnc: 'iv:tag:ct',
    accessTokenEnc: null,
    accessTokenExpires: null,
    status: M365ConnectionStatus.ACTIVE,
    deltaLinkContacts: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function fullContact(): GraphContact {
  return {
    id: 'AAMkAGI2THE=RAW=graph/id==',
    displayName: 'Jane Lead',
    givenName: 'Jane',
    surname: 'Lead',
    companyName: 'Acme Corp',
    emailAddresses: [{ name: 'Jane', address: 'jane@acme.test' }],
    mobilePhone: '+15551234567',
    businessPhones: ['+15559999999'],
    personalNotes: 'met at the conference',
  };
}

describe('M365SyncService', () => {
  let service: M365SyncService;
  let graph: jest.Mocked<Pick<M365GraphClient, 'listContacts'>>;
  let store: jest.Mocked<Pick<M365ConnectionStore, 'recordSync'>>;
  let leadIntake: jest.Mocked<Pick<LeadIntakeService, 'ingestForUser'>>;

  beforeEach(() => {
    graph = { listContacts: jest.fn() } as any;
    store = { recordSync: jest.fn().mockResolvedValue(undefined) } as any;
    leadIntake = { ingestForUser: jest.fn().mockResolvedValue({ resolved: true }) } as any;
    service = new M365SyncService(
      graph as unknown as M365GraphClient,
      store as unknown as M365ConnectionStore,
      leadIntake as unknown as LeadIntakeService,
    );
  });

  describe('toIngestDto — the exact mapping', () => {
    it('maps every field per the plan', () => {
      const dto = service.toIngestDto(fullContact())!;
      expect(dto.source).toBe('m365');
      expect(dto.displayName).toBe('Jane Lead');
      expect(dto.email).toBe('jane@acme.test');
      expect(dto.phone).toBe('+15551234567'); // mobile preferred over business
      expect(dto.orgName).toBe('Acme Corp');
      expect(dto.tags).toEqual(['m365', 'contacts-import']);
      expect(dto.notes).toBe('met at the conference');
      expect(dto.rawPayload).toMatchObject({ id: 'AAMkAGI2THE=RAW=graph/id==' });
    });

    it('dedupKey is `m365:` + sha256(graphId).slice(0,40) — SLUG-SAFE + stable, NOT the email', () => {
      const c = fullContact();
      const expected = `m365:${createHash('sha256').update(c.id).digest('hex').slice(0, 40)}`;
      const dto = service.toIngestDto(c)!;
      expect(dto.sourceDedupKey).toBe(expected);
      // Slug-safe: only [A-Za-z0-9._:-] (the DTO's SLUG_RE), even though the raw
      // Graph id had `=` and `/`.
      expect(dto.sourceDedupKey).toMatch(/^[A-Za-z0-9._:-]+$/);
      expect(dto.sourceDedupKey).not.toContain('=');
      expect(dto.sourceDedupKey).not.toContain('/');
      // Length within the DTO cap (≤300).
      expect(dto.sourceDedupKey.length).toBeLessThanOrEqual(300);
      // Stable: same id → same key; different id → different key.
      expect(service.dedupKey(c.id)).toBe(expected);
      expect(service.dedupKey('other-id')).not.toBe(expected);
    });

    it('the dedup key does NOT change when only the email changes (keyed on Graph id)', () => {
      const a = service.toIngestDto({ ...fullContact(), emailAddresses: [{ address: 'a@x.test' }] })!;
      const b = service.toIngestDto({ ...fullContact(), emailAddresses: [{ address: 'b@x.test' }] })!;
      expect(a.sourceDedupKey).toBe(b.sourceDedupKey); // same Graph id → same key
    });

    it('falls back to business phone when no mobile, and composes a name from given+surname', () => {
      const dto = service.toIngestDto({
        id: 'id-1',
        givenName: 'Bob',
        surname: 'Stone',
        businessPhones: ['+15550001111'],
      })!;
      expect(dto.phone).toBe('+15550001111');
      expect(dto.displayName).toBe('Bob Stone');
    });

    it('returns null when there is no id (no stable dedup key possible)', () => {
      expect(service.toIngestDto({ id: '' } as GraphContact)).toBeNull();
    });

    it('returns null when there is no usable identity (no name / email / phone)', () => {
      expect(service.toIngestDto({ id: 'id-1', companyName: 'OrphanCo' })).toBeNull();
    });
  });

  describe('syncContacts — the funnel', () => {
    it('funnels each contact through LeadIntakeService.ingestForUser with the connection workspace', async () => {
      graph.listContacts.mockResolvedValue({
        contacts: [fullContact(), { id: 'id-2', displayName: 'Second', emailAddresses: [{ address: 's@x.test' }] }],
        nextLink: null,
        deltaLink: 'https://graph/delta?$deltatoken=NEW',
      });

      const result = await service.syncContacts(USER, makeConnection());

      expect(leadIntake.ingestForUser).toHaveBeenCalledTimes(2);
      // Called with (user, dto, connection.workspaceId).
      const [u, dto, ws] = leadIntake.ingestForUser.mock.calls[0];
      expect(u).toBe(USER);
      expect(ws).toBe(WS);
      expect(dto.source).toBe(M365_SOURCE);
      expect(result.ok).toBe(true);
      expect(result.contactsSeen).toBe(2);
      expect(result.ingested).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('persists the new delta cursor + ACTIVE status on success', async () => {
      graph.listContacts.mockResolvedValue({
        contacts: [fullContact()],
        nextLink: null,
        deltaLink: 'https://graph/delta?$deltatoken=NEW',
      });
      await service.syncContacts(USER, makeConnection());
      expect(store.recordSync).toHaveBeenCalledWith(
        USER.id,
        'm365-1',
        expect.objectContaining({
          status: M365ConnectionStatus.ACTIVE,
          lastSyncError: null,
          deltaLinkContacts: 'https://graph/delta?$deltatoken=NEW',
        }),
      );
    });

    it('skips delta-deleted contacts (v1 ignores removals)', async () => {
      graph.listContacts.mockResolvedValue({
        contacts: [
          fullContact(),
          { id: 'gone', '@removed': { reason: 'deleted' } } as GraphContact,
        ],
        nextLink: null,
        deltaLink: null,
      });
      const result = await service.syncContacts(USER, makeConnection());
      expect(leadIntake.ingestForUser).toHaveBeenCalledTimes(1); // only the live one
      expect(result.ingested).toBe(1);
    });

    it('does NOT abort the batch when one contact fails to ingest', async () => {
      graph.listContacts.mockResolvedValue({
        contacts: [
          fullContact(),
          { id: 'id-2', displayName: 'Second', emailAddresses: [{ address: 's@x.test' }] },
        ],
        nextLink: null,
        deltaLink: null,
      });
      leadIntake.ingestForUser
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ resolved: true } as any);

      const result = await service.syncContacts(USER, makeConnection());
      expect(result.ok).toBe(true);
      expect(result.ingested).toBe(1);
      expect(result.failed).toBe(1);
    });

    it('reports REVOKED cleanly when the Graph client throws M365AuthRevokedError', async () => {
      graph.listContacts.mockRejectedValue(new M365AuthRevokedError());
      const result = await service.syncContacts(USER, makeConnection());
      expect(result.ok).toBe(false);
      expect(result.status).toBe(M365ConnectionStatus.REVOKED);
      expect(leadIntake.ingestForUser).not.toHaveBeenCalled();
      expect(store.recordSync).toHaveBeenCalledWith(
        USER.id,
        'm365-1',
        expect.objectContaining({ status: M365ConnectionStatus.REVOKED }),
      );
    });

    it('records ERROR (retryable) on a transient Graph failure', async () => {
      graph.listContacts.mockRejectedValue(new Error('Graph request failed: HTTP 500'));
      const result = await service.syncContacts(USER, makeConnection());
      expect(result.ok).toBe(false);
      expect(result.status).toBe(M365ConnectionStatus.ERROR);
      expect(store.recordSync).toHaveBeenCalledWith(
        USER.id,
        'm365-1',
        expect.objectContaining({ status: M365ConnectionStatus.ERROR }),
      );
    });
  });
});
