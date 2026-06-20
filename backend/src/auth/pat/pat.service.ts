import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PersonalAccessToken, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipService } from '../../common/workspace/membership.service';
import { PAT_AVAILABLE_SCOPES, PAT_PREFIX, PatScope } from './pat.constants';
import { generatePat, isPatToken, verifyPat } from './pat.util';

export interface CreatePatInput {
  name: string;
  scopes?: string[];
  expiresAt?: Date | null;
  /**
   * Workspace to bind the token to. When provided it MUST be one the caller is
   * an active member of (enforced via MembershipService); when omitted the
   * token binds to the caller's default-membership workspace.
   */
  workspaceId?: string | null;
}

export interface CreatePatResult {
  id: string;
  plaintext: string;
  prefix: string;
  name: string;
  scopes: string[];
  workspaceId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/** Metadata view of a PAT — safe to return. Never the plaintext or the hash. */
export interface PatMetadata {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  workspaceId: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface PatResolution {
  user: User;
  token: PersonalAccessToken;
  /** The workspace this PAT is bound to; the auth chokepoint fences on it. */
  workspaceId: string | null;
}

/**
 * Personal Access Token store + resolver.
 *
 * The PAT table is USER-scoped + app-enforced (NOT under RLS — see the
 * migration header), so every method uses the plain `this.prisma` client (no
 * `withWorkspace`): the resolver runs at auth time before any workspace GUC
 * exists. Ownership is enforced in code (`where: { userId }`).
 */
@Injectable()
export class PatService {
  private readonly logger = new Logger(PatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
  ) {}

  /**
   * Create a PAT for a user. Returns the plaintext token exactly once; callers
   * MUST surface it and never persist it again. Bound to a single workspace
   * (explicit `workspaceId` validated as an active membership, else the
   * caller's default membership) — a no-op echo while tenancy is off, a hard
   * 403 on a non-member workspace when it is on.
   */
  async create(user: User, input: CreatePatInput): Promise<CreatePatResult> {
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('Token name is required');
    if (name.length > 100) throw new BadRequestException('Token name must be 100 characters or less');

    const scopes = this.normalizeScopes(input.scopes);
    const expiresAt = this.normalizeExpiry(input.expiresAt);
    const workspaceId = await this.membership.resolveAndAuthorize(user, input.workspaceId ?? null);

    const { plaintext, hash: hashPromise } = generatePat();
    const tokenHash = await hashPromise;

    const row = await this.prisma.personalAccessToken.create({
      data: { userId: user.id, workspaceId, name, prefix: PAT_PREFIX, tokenHash, scopes, expiresAt },
    });

    this.logger.log(
      `Minted PAT ${row.id} for user ${user.id} (workspace=${workspaceId}, scopes=[${scopes.join(',')}], expiresAt=${expiresAt?.toISOString() ?? 'never'})`,
    );

    return {
      id: row.id,
      plaintext,
      prefix: row.prefix,
      name: row.name,
      scopes: row.scopes,
      workspaceId: row.workspaceId,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }

  /**
   * Resolve a plaintext PAT to its owning user. Returns null on any failure (no
   * match / revoked / expired / owner inactive) so the caller emits one generic
   * 401. Bumps `lastUsedAt` (fire-and-forget). O(n) bcrypt scan over active
   * tokens — fine at low volume (add a SHA-256 fast-lookup index later if it
   * ever isn't).
   */
  async findByPlaintext(plaintext: string): Promise<PatResolution | null> {
    if (!isPatToken(plaintext)) return null;

    const now = new Date();
    const candidates = await this.prisma.personalAccessToken.findMany({
      where: { revokedAt: null, AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }] },
      include: { user: true },
    });

    for (const token of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const match = await verifyPat(plaintext, token.tokenHash);
      if (!match) continue;
      if (!token.user || !token.user.isActive) return null;

      // Fire-and-forget the lastUsedAt bump — losing a timestamp is not a 500.
      this.prisma.personalAccessToken
        .update({ where: { id: token.id }, data: { lastUsedAt: now } })
        .catch((err) =>
          this.logger.warn(`Failed to bump lastUsedAt for PAT ${token.id}: ${(err as Error).message}`),
        );

      const { user, ...bare } = token;
      const bareToken = bare as PersonalAccessToken;
      return { user, token: bareToken, workspaceId: bareToken.workspaceId };
    }

    return null;
  }

  /** List the user's PATs (metadata only). Newest first; includes revoked. */
  async list(userId: string): Promise<PatMetadata[]> {
    const rows = await this.prisma.personalAccessToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toMetadata(r));
  }

  /** Soft-revoke. Idempotent (re-revoke is a no-op). 404 if not owned. */
  async revoke(userId: string, id: string): Promise<PatMetadata> {
    const existing = await this.prisma.personalAccessToken.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) throw new NotFoundException('Token not found');
    if (existing.revokedAt) return this.toMetadata(existing);

    const updated = await this.prisma.personalAccessToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    this.logger.log(`Revoked PAT ${id} for user ${userId}`);
    return this.toMetadata(updated);
  }

  private toMetadata(r: PersonalAccessToken): PatMetadata {
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes,
      workspaceId: r.workspaceId,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      revokedAt: r.revokedAt,
    };
  }

  private normalizeScopes(scopes?: string[]): PatScope[] {
    if (!scopes || scopes.length === 0) {
      // A brand-new token defaults to read-only across the cockpit so it works
      // for observation immediately but not for mutation.
      return ['read:customers', 'read:activity', 'read:leads', 'read:overview'];
    }
    const allowed = new Set<string>(PAT_AVAILABLE_SCOPES);
    const cleaned = Array.from(new Set(scopes.map((s) => s.trim()).filter(Boolean)));
    const invalid = cleaned.filter((s) => !allowed.has(s));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Unknown scope(s): ${invalid.join(', ')}. Allowed: ${PAT_AVAILABLE_SCOPES.join(', ')}`,
      );
    }
    return cleaned as PatScope[];
  }

  private normalizeExpiry(expiresAt?: Date | string | null): Date | null {
    if (expiresAt === null || expiresAt === undefined || (expiresAt as unknown) === '') return null;
    const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('expiresAt must be a valid date');
    if (d.getTime() <= Date.now()) throw new BadRequestException('expiresAt must be in the future');
    return d;
  }
}
