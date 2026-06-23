/**
 * M365ConnectionStore — the per-user Microsoft 365 connection credential store.
 *
 * Like PatService, the `m365_connections` table is USER-scoped + app-enforced and
 * deliberately NOT under RLS (the credential resolves at OAuth-callback time,
 * before any workspace GUC exists). So every method uses the plain `this.prisma`
 * client (no `withWorkspace`), and OWNERSHIP IS ENFORCED IN CODE via an explicit
 * `where: { userId }` on every read/update/delete — a user can only ever touch
 * their own connection rows. There is a test that asserts this fence.
 *
 * The stored tokens are AES-256-GCM ciphertext (TokenCipher); this store moves
 * the encrypted blobs around but NEVER logs them and never returns them on its
 * metadata view (`toView`).
 */

import { Injectable, Logger } from '@nestjs/common';
import { M365Connection, M365ConnectionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { M365ConnectionView } from '../m365.types';

/** Fields to write on connect / re-consent (all already encrypted where secret). */
export interface UpsertConnectionInput {
  userId: string;
  workspaceId: string;
  m365UserId: string;
  m365UserPrincipal: string | null;
  scopes: string[];
  refreshTokenEnc: string;
  accessTokenEnc: string | null;
  accessTokenExpires: Date | null;
}

@Injectable()
export class M365ConnectionStore {
  private readonly logger = new Logger(M365ConnectionStore.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create or refresh the user's connection for a workspace (one per
   * (userId, workspaceId)). A reconnect / re-consent UPSERTS the same row:
   * fresh tokens + scopes, status reset to ACTIVE, sync cursor preserved.
   */
  async upsert(input: UpsertConnectionInput): Promise<M365Connection> {
    return this.prisma.m365Connection.upsert({
      where: { userId_workspaceId: { userId: input.userId, workspaceId: input.workspaceId } },
      create: {
        userId: input.userId,
        workspaceId: input.workspaceId,
        m365UserId: input.m365UserId,
        m365UserPrincipal: input.m365UserPrincipal,
        scopes: input.scopes,
        refreshTokenEnc: input.refreshTokenEnc,
        accessTokenEnc: input.accessTokenEnc,
        accessTokenExpires: input.accessTokenExpires,
        status: M365ConnectionStatus.ACTIVE,
      },
      update: {
        m365UserId: input.m365UserId,
        m365UserPrincipal: input.m365UserPrincipal,
        scopes: input.scopes,
        refreshTokenEnc: input.refreshTokenEnc,
        accessTokenEnc: input.accessTokenEnc,
        accessTokenExpires: input.accessTokenExpires,
        status: M365ConnectionStatus.ACTIVE,
        lastSyncError: null,
      },
    });
  }

  /**
   * The user's connection for a workspace, or null. OWNERSHIP FENCE: the
   * `userId` predicate means a caller can never read another user's row even by
   * guessing a workspace id.
   */
  async findForUser(userId: string, workspaceId: string): Promise<M365Connection | null> {
    return this.prisma.m365Connection.findFirst({ where: { userId, workspaceId } });
  }

  /**
   * Persist the rotated refresh token + a fresh access token after a token
   * refresh. Fenced by `userId` (defence-in-depth on top of the row id).
   */
  async updateTokens(
    userId: string,
    id: string,
    data: {
      refreshTokenEnc?: string;
      accessTokenEnc?: string | null;
      accessTokenExpires?: Date | null;
    },
  ): Promise<void> {
    const patch: Prisma.M365ConnectionUpdateManyMutationInput = {};
    if (data.refreshTokenEnc !== undefined) patch.refreshTokenEnc = data.refreshTokenEnc;
    if (data.accessTokenEnc !== undefined) patch.accessTokenEnc = data.accessTokenEnc;
    if (data.accessTokenExpires !== undefined) patch.accessTokenExpires = data.accessTokenExpires;
    if (Object.keys(patch).length === 0) return;
    await this.prisma.m365Connection.updateMany({ where: { id, userId }, data: patch });
  }

  /** Mark a connection REVOKED (Microsoft invalid_grant). Fenced by `userId`. */
  async markRevoked(userId: string, id: string): Promise<void> {
    await this.prisma.m365Connection.updateMany({
      where: { id, userId },
      data: { status: M365ConnectionStatus.REVOKED },
    });
  }

  /** Record the outcome of a sync run (status + counts + the delta cursor). Fenced. */
  async recordSync(
    userId: string,
    id: string,
    data: {
      status: M365ConnectionStatus;
      lastSyncStatus: string;
      lastSyncError: string | null;
      deltaLinkContacts?: string | null;
    },
  ): Promise<void> {
    const patch: Prisma.M365ConnectionUpdateManyMutationInput = {
      status: data.status,
      lastSyncAt: new Date(),
      lastSyncStatus: data.lastSyncStatus,
      lastSyncError: data.lastSyncError,
    };
    if (data.deltaLinkContacts !== undefined) patch.deltaLinkContacts = data.deltaLinkContacts;
    await this.prisma.m365Connection.updateMany({ where: { id, userId }, data: patch });
  }

  /** Hard-delete the user's connection (disconnect). Fenced by `userId`; returns
   *  whether a row was actually removed (idempotent disconnect). */
  async deleteForUser(userId: string, workspaceId: string): Promise<boolean> {
    const res = await this.prisma.m365Connection.deleteMany({ where: { userId, workspaceId } });
    if (res.count > 0) {
      this.logger.log(`Disconnected M365 for user ${userId} (workspace ${workspaceId})`);
    }
    return res.count > 0;
  }

  /** The SAFE metadata projection — NEVER the encrypted token columns. */
  toView(row: M365Connection): M365ConnectionView {
    return {
      id: row.id,
      m365UserId: row.m365UserId,
      m365UserPrincipal: row.m365UserPrincipal,
      scopes: row.scopes ?? [],
      status: row.status,
      lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
      lastSyncStatus: row.lastSyncStatus,
      lastSyncError: row.lastSyncError,
      hasDeltaLink: !!row.deltaLinkContacts,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
