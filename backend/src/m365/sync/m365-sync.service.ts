/**
 * M365SyncService — the funnel seam.
 *
 * THE WHOLE POINT of the connector: turn the user's Microsoft 365 contacts into
 * well-formed `IngestLeadDto`s and push each through the EXISTING
 * `LeadIntakeService.ingestForUser`. We do NOT create a parallel ingestion path,
 * a second phonebook, or any direct Customer/Contact write — identity resolution
 * (explicit → Contact-Ops upsert → provisional), dedup, and the LEAD projection
 * are ALL handled downstream by lead-intake, for free.
 *
 * DEDUP KEY: `m365:` + sha256(graphContactId).slice(0,40). The raw Graph id
 * contains `=` and `/` (not slug-safe — the DTO rejects it), and email is NOT a
 * stable key (a contact can change email), so we hash the STABLE Graph id. The
 * lead-intake buffer is idempotent on (workspace, source, sourceDedupKey), so a
 * re-sync UPSERTS each contact, never duplicates it — which also makes a full
 * re-enumerate harmless.
 *
 * SYNC MODE: delta on a one-shot spine. The first sync (no stored delta link)
 * fully enumerates and returns a deltaLink; later syncs replay it (only changes).
 * v1 ignores delta deletes (a removed Graph contact does not retract a lead).
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { M365Connection, M365ConnectionStatus, User } from '@prisma/client';
import { LeadIntakeService } from '../../lead-intake/lead-intake.service';
import { IngestLeadDto } from '../../lead-intake/dto/lead-intake.dto';
import { WithWorkspaceClaim } from '../../common/workspace/workspace.util';
import { M365ConnectionStore } from '../store/m365-connection.store';
import { M365GraphClient, M365AuthRevokedError } from '../graph/m365-graph.client';
import { GraphContact, M365SyncResult } from '../m365.types';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

/** The source slug for everything this connector ingests. */
export const M365_SOURCE = 'm365';

@Injectable()
export class M365SyncService {
  private readonly logger = new Logger(M365SyncService.name);

  constructor(
    private readonly graph: M365GraphClient,
    private readonly store: M365ConnectionStore,
    private readonly leadIntake: LeadIntakeService,
  ) {}

  /**
   * Pull the connection's contacts and funnel each through lead-intake. Records
   * the run outcome (status + the new delta cursor) on the connection. Never
   * throws on a per-contact failure — one bad contact does not abort the batch.
   */
  async syncContacts(user: AuthedUser, connection: M365Connection): Promise<M365SyncResult> {
    let contacts: GraphContact[];
    let deltaLink: string | null;

    try {
      const page = await this.graph.listContacts(connection);
      contacts = page.contacts;
      deltaLink = page.deltaLink;
    } catch (err) {
      if (err instanceof M365AuthRevokedError) {
        // getAccessToken already marked the row REVOKED; report it cleanly.
        return this.failed(connection, 'revoked', err.message, M365ConnectionStatus.REVOKED);
      }
      const detail = (err as Error).message || 'sync failed';
      this.logger.warn(`M365 sync ${connection.id} errored: ${detail}`);
      return this.failed(connection, 'error', detail, M365ConnectionStatus.ERROR);
    }

    let ingested = 0;
    let failed = 0;
    for (const contact of contacts) {
      // v1 ignores delta deletes — a removed Graph contact doesn't retract a lead.
      if (contact['@removed']) continue;
      const dto = this.toIngestDto(contact);
      if (!dto) continue; // no usable identity at all (no id / no name+email+phone).
      try {
        await this.leadIntake.ingestForUser(user, dto, connection.workspaceId);
        ingested += 1;
      } catch (err) {
        failed += 1;
        // Don't abort the batch for one bad contact; surface the count in the result.
        this.logger.warn(
          `M365 contact ingest failed (${dto.sourceDedupKey}): ${(err as Error).message}`,
        );
      }
    }

    const status = M365ConnectionStatus.ACTIVE;
    const summary = `synced ${ingested}/${contacts.length} contact(s)${failed ? `, ${failed} failed` : ''}`;
    await this.store.recordSync(connection.userId, connection.id, {
      status,
      lastSyncStatus: summary,
      lastSyncError: null,
      // Persist the new delta cursor so the next sync is incremental. Keep the old
      // one if Graph didn't return a new one this run.
      deltaLinkContacts: deltaLink ?? undefined,
    });

    return {
      ok: true,
      status,
      contactsSeen: contacts.length,
      ingested,
      failed,
      detail: summary,
      lastSyncAt: new Date().toISOString(),
    };
  }

  /**
   * Map ONE Graph contact → IngestLeadDto, EXACTLY per the plan. Returns null
   * when the contact has no id (can't form a stable dedup key) or no identity key
   * at all (lead-intake would 400 it).
   */
  toIngestDto(contact: GraphContact): IngestLeadDto | null {
    if (!contact.id) return null;

    const displayName = this.cleanName(contact);
    const email = contact.emailAddresses?.find((e) => e.address)?.address?.trim() || undefined;
    const phone = (contact.mobilePhone || contact.businessPhones?.[0] || '').trim() || undefined;
    const orgName = contact.companyName?.trim() || undefined;

    // lead-intake requires at least one identity key (or an explicit contactId).
    if (!displayName && !email && !phone) return null;

    const dto = new IngestLeadDto();
    dto.source = M365_SOURCE;
    dto.sourceDedupKey = this.dedupKey(contact.id);
    if (displayName) dto.displayName = displayName.slice(0, 300);
    if (email) dto.email = email.slice(0, 320);
    if (phone) dto.phone = phone.slice(0, 40);
    if (orgName) dto.orgName = orgName.slice(0, 300);
    dto.tags = ['m365', 'contacts-import'];
    const notes = contact.personalNotes?.trim();
    if (notes) dto.notes = notes.slice(0, 4000);
    // The verbatim Graph contact JSON is the audit/replay envelope.
    dto.rawPayload = contact as unknown as Record<string, unknown>;
    return dto;
  }

  /** `m365:` + sha256(graphId).slice(0,40) — slug-safe (hex), stable, ≤300. */
  dedupKey(graphContactId: string): string {
    const hash = createHash('sha256').update(graphContactId).digest('hex').slice(0, 40);
    return `${M365_SOURCE}:${hash}`;
  }

  /** Best display name: Graph displayName, else "given surname", else either. */
  private cleanName(contact: GraphContact): string | undefined {
    const dn = contact.displayName?.trim();
    if (dn) return dn;
    const composed = [contact.givenName, contact.surname]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    return composed || undefined;
  }

  /** Record + return a failed-sync outcome. */
  private async failed(
    connection: M365Connection,
    statusLabel: string,
    detail: string,
    status: M365ConnectionStatus,
  ): Promise<M365SyncResult> {
    await this.store.recordSync(connection.userId, connection.id, {
      status,
      lastSyncStatus: statusLabel,
      lastSyncError: detail.slice(0, 1000),
    });
    return {
      ok: false,
      status,
      contactsSeen: 0,
      ingested: 0,
      failed: 0,
      detail,
      lastSyncAt: new Date().toISOString(),
    };
  }
}
